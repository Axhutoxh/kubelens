//! Gemini via the Generative Language API (generateContent with function calling).

use super::{send_json, client, ModelInfo, Msg, ToolCall, Turn};
use crate::ai::tools::ToolSpec;
use serde_json::{json, Value};

/// Prefix for ids we invent; Gemini only sometimes returns its own call ids.
const LOCAL_ID: &str = "gcall-";

/// Unique across turns, so approvals for one call can never match another
fn local_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    format!("{LOCAL_ID}{now}-{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

fn to_api(msg: &Msg) -> Value {
    match msg {
        Msg::User { text } => json!({ "role": "user", "parts": [{ "text": text }] }),
        Msg::Assistant { text, tool_calls, raw, provider } => {
            // Echo Gemini's own parts back verbatim: they carry thought signatures that
            // function-calling turns must return
            if provider.as_deref() == Some("gemini") {
                if let Some(raw) = raw {
                    return json!({ "role": "model", "parts": raw });
                }
            }
            let mut parts = Vec::new();
            if !text.is_empty() {
                parts.push(json!({ "text": text }));
            }
            for c in tool_calls {
                parts.push(json!({ "functionCall": { "name": c.name, "args": c.args } }));
            }
            if parts.is_empty() {
                parts.push(json!({ "text": "…" }));
            }
            json!({ "role": "model", "parts": parts })
        }
        Msg::Tool { results } => json!({
            "role": "user",
            "parts": results.iter().map(|r| {
                let mut fr = json!({
                    "name": r.name,
                    "response": if r.is_error { json!({ "error": r.content }) } else { json!({ "result": r.content }) },
                });
                if !r.id.starts_with(LOCAL_ID) {
                    fr["id"] = json!(r.id);
                }
                json!({ "functionResponse": fr })
            }).collect::<Vec<_>>(),
        }),
    }
}

fn declaration(t: &ToolSpec) -> Value {
    let mut d = json!({ "name": t.name, "description": t.description });
    // Gemini rejects an object schema without properties; omit parameters instead
    let has_props = t.schema.get("properties").and_then(Value::as_object).map(|p| !p.is_empty()).unwrap_or(false);
    if has_props {
        d["parameters"] = t.schema.clone();
    }
    d
}

pub async fn complete(base: &str, model: &str, key: &str, system: &str, msgs: &[Msg], tools: &[ToolSpec]) -> Result<Turn, String> {
    let body = json!({
        "systemInstruction": { "parts": [{ "text": system }] },
        "contents": msgs.iter().map(to_api).collect::<Vec<_>>(),
        "tools": [{ "functionDeclarations": tools.iter().map(declaration).collect::<Vec<_>>() }],
    });
    let req = client()
        .post(format!("{base}/v1beta/models/{model}:generateContent"))
        .header("x-goog-api-key", key);
    let res = send_json(req, Some(&body)).await?;

    let candidate = res.pointer("/candidates/0").cloned().unwrap_or(Value::Null);
    let parts = candidate.pointer("/content/parts").cloned().unwrap_or_else(|| json!([]));
    let mut text = String::new();
    let mut tool_calls = Vec::new();
    for part in parts.as_array().into_iter().flatten() {
        if part.get("thought").and_then(Value::as_bool).unwrap_or(false) {
            continue;
        }
        if let Some(t) = part.get("text").and_then(Value::as_str) {
            text.push_str(t);
        }
        if let Some(fc) = part.get("functionCall") {
            tool_calls.push(ToolCall {
                id: fc.get("id").and_then(Value::as_str).map(str::to_string).unwrap_or_else(local_id),
                name: fc.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
                args: fc.get("args").cloned().unwrap_or_else(|| json!({})),
            });
        }
    }
    if text.is_empty() && tool_calls.is_empty() {
        let reason = candidate
            .get("finishReason")
            .and_then(Value::as_str)
            .or_else(|| res.pointer("/promptFeedback/blockReason").and_then(Value::as_str))
            .unwrap_or("unknown");
        return Err(format!("Gemini returned an empty answer (reason: {reason})."));
    }
    Ok(Turn { text, tool_calls, raw: parts })
}

pub async fn list_models(base: &str, key: &str) -> Result<Vec<ModelInfo>, String> {
    let req = client().get(format!("{base}/v1beta/models?pageSize=200")).header("x-goog-api-key", key);
    let res = send_json(req, None).await?;
    Ok(res
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|m| {
            m.get("supportedGenerationMethods")
                .and_then(Value::as_array)
                .map(|a| a.iter().any(|x| x == "generateContent"))
                .unwrap_or(false)
        })
        .filter_map(|m| {
            let id = m.get("name")?.as_str()?.trim_start_matches("models/").to_string();
            if !id.starts_with("gemini") {
                return None;
            }
            let label = m.get("displayName").and_then(Value::as_str).unwrap_or(&id).to_string();
            Some(ModelInfo { id, label })
        })
        .collect())
}
