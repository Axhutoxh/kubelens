//! OpenAI Chat Completions with function calling. The same wire format serves OpenAI (and
//! compatible gateways), Azure OpenAI deployments and Ollama's local OpenAI-compatible API.

use super::{client, send_json, Conn, ModelInfo, Msg, ToolCall, Turn};
use crate::ai::tools::ToolSpec;
use serde_json::{json, Value};

/// Azure OpenAI data-plane API version (GA)
const AZURE_API_VERSION: &str = "2024-10-21";

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Flavor {
    /// `{base}/chat/completions`, bearer key (none for Ollama), model in the body
    OpenAi,
    /// `{endpoint}/openai/deployments/{deployment}/chat/completions`, `api-key` header
    Azure,
}

fn request(flavor: Flavor, conn: &Conn, model: &str) -> reqwest::RequestBuilder {
    match flavor {
        Flavor::OpenAi => {
            let req = client().post(format!("{}/chat/completions", conn.base));
            if conn.key.is_empty() { req } else { req.bearer_auth(&conn.key) }
        }
        Flavor::Azure => client()
            .post(format!("{}/openai/deployments/{model}/chat/completions?api-version={AZURE_API_VERSION}", conn.base))
            .header("api-key", &conn.key),
    }
}

fn to_api(msg: &Msg) -> Vec<Value> {
    match msg {
        Msg::User { text } => vec![json!({ "role": "user", "content": text })],
        // No provider-specific state to echo back, so every assistant turn is rebuilt from
        // the neutral form (this also covers turns that came from Claude or Gemini)
        Msg::Assistant { text, tool_calls, .. } => {
            let mut m = json!({ "role": "assistant", "content": if text.is_empty() { Value::Null } else { json!(text) } });
            if !tool_calls.is_empty() {
                m["tool_calls"] = tool_calls
                    .iter()
                    .map(|c| json!({
                        "id": c.id,
                        "type": "function",
                        "function": { "name": c.name, "arguments": c.args.to_string() },
                    }))
                    .collect();
            } else if text.is_empty() {
                m["content"] = json!("…");
            }
            vec![m]
        }
        Msg::Tool { results } => results
            .iter()
            .map(|r| json!({ "role": "tool", "tool_call_id": r.id, "content": r.content }))
            .collect(),
    }
}

/// Local ids for servers that leave tool call ids out (some local runtimes do)
fn local_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    format!("call-{now}-{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

pub async fn complete(flavor: Flavor, conn: &Conn, model: &str, system: &str, msgs: &[Msg], tools: &[ToolSpec]) -> Result<Turn, String> {
    let mut messages = vec![json!({ "role": "system", "content": system })];
    messages.extend(msgs.iter().flat_map(to_api));
    let mut body = json!({
        "messages": messages,
        "tools": tools.iter().map(|t| json!({
            "type": "function",
            "function": { "name": t.name, "description": t.description, "parameters": t.schema },
        })).collect::<Vec<_>>(),
    });
    if flavor == Flavor::OpenAi {
        body["model"] = json!(model);
    }
    let res = send_json(request(flavor, conn, model), Some(&body)).await?;

    let message = res.pointer("/choices/0/message").cloned().unwrap_or(Value::Null);
    let text = message.get("content").and_then(Value::as_str).unwrap_or_default().to_string();
    let tool_calls: Vec<ToolCall> = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|c| {
            let f = c.get("function")?;
            // Arguments arrive as a JSON string; a few compatible servers send an object
            let args = match f.get("arguments") {
                Some(Value::String(s)) if !s.trim().is_empty() => serde_json::from_str(s).unwrap_or_else(|_| json!({})),
                Some(v @ Value::Object(_)) => v.clone(),
                _ => json!({}),
            };
            Some(ToolCall {
                id: c.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(local_id),
                name: f.get("name")?.as_str()?.to_string(),
                args,
            })
        })
        .collect();
    if text.is_empty() && tool_calls.is_empty() {
        let reason = res.pointer("/choices/0/finish_reason").and_then(Value::as_str).unwrap_or("unknown");
        return Err(format!("The model returned an empty answer (finish reason: {reason})."));
    }
    Ok(Turn { text, tool_calls, raw: message })
}

/// Chat models only, newest first. On api.openai.com the list also has audio, image,
/// embedding and Responses-only models that can't be used here.
pub async fn list_models(conn: &Conn) -> Result<Vec<ModelInfo>, String> {
    let req = client().get(format!("{}/models", conn.base));
    let req = if conn.key.is_empty() { req } else { req.bearer_auth(&conn.key) };
    let res = send_json(req, None).await?;
    let official = conn.base.contains("api.openai.com");
    let mut models: Vec<(i64, ModelInfo)> = res
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let id = m.get("id")?.as_str()?.to_string();
            if official && !is_openai_chat_model(&id) {
                return None;
            }
            let created = m.get("created").and_then(Value::as_i64).unwrap_or(0);
            Some((created, ModelInfo { label: id.clone(), id }))
        })
        .collect();
    models.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.id.cmp(&b.1.id)));
    Ok(models.into_iter().map(|(_, m)| m).collect())
}

fn is_openai_chat_model(id: &str) -> bool {
    let chat_family = id.starts_with("gpt-")
        || id.starts_with("chatgpt-")
        || (id.starts_with('o') && id[1..].starts_with(|c: char| c.is_ascii_digit()));
    const NOT_CHAT: [&str; 12] = ["audio", "realtime", "tts", "transcribe", "image", "search", "instruct", "embedding", "moderation", "codex", "-pro", "deep-research"];
    chat_family && !NOT_CHAT.iter().any(|x| id.contains(x))
}

/// Azure has no data-plane list of deployments, so the key, endpoint and deployment are
/// checked together with a one-word request.
pub async fn check_deployment(conn: &Conn, deployment: &str) -> Result<(), String> {
    let body = json!({ "messages": [{ "role": "user", "content": "Reply with OK." }] });
    send_json(request(Flavor::Azure, conn, deployment), Some(&body)).await.map(|_| ()).map_err(|e| {
        if e.contains("(404") {
            format!("Deployment '{deployment}' was not found at this endpoint. Use the deployment name from Azure AI Foundry, not the model name. ({e})")
        } else {
            e
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_openai_models_to_chat() {
        for keep in ["gpt-4.1", "gpt-5-mini", "o3", "o4-mini", "chatgpt-4o-latest"] {
            assert!(is_openai_chat_model(keep), "{keep}");
        }
        for drop in ["text-embedding-3-large", "gpt-4o-realtime-preview", "gpt-image-1", "o1-pro", "whisper-1", "omni-moderation-latest", "gpt-4o-mini-tts"] {
            assert!(!is_openai_chat_model(drop), "{drop}");
        }
    }

    #[test]
    fn converts_tool_turns() {
        let assistant = Msg::Assistant {
            text: String::new(),
            tool_calls: vec![ToolCall { id: "toolu_1".into(), name: "get_logs".into(), args: json!({ "pod": "a" }) }],
            raw: None,
            provider: Some("anthropic".into()),
        };
        let m = &to_api(&assistant)[0];
        assert_eq!(m["content"], Value::Null);
        assert_eq!(m["tool_calls"][0]["function"]["arguments"], json!(r#"{"pod":"a"}"#));
        let tool = Msg::Tool {
            results: vec![
                super::super::ToolResult { id: "toolu_1".into(), name: "get_logs".into(), content: "x".into(), is_error: false },
                super::super::ToolResult { id: "toolu_2".into(), name: "get_events".into(), content: "y".into(), is_error: false },
            ],
        };
        let out = to_api(&tool);
        assert_eq!(out.len(), 2);
        assert_eq!(out[1]["tool_call_id"], json!("toolu_2"));
    }
}
