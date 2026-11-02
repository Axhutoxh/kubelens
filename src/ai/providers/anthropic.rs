//! Claude via the Anthropic Messages API.

use super::{send_json, client, ModelInfo, Msg, ToolCall, Turn};
use crate::ai::tools::ToolSpec;
use serde_json::{json, Value};

const API_VERSION: &str = "2023-06-01";
const MAX_TOKENS: u32 = 4096;

fn to_api(msg: &Msg) -> Value {
    match msg {
        Msg::User { text } => json!({ "role": "user", "content": text }),
        Msg::Assistant { text, tool_calls, raw, provider } => {
            if provider.as_deref() == Some("anthropic") {
                if let Some(raw) = raw {
                    return json!({ "role": "assistant", "content": raw });
                }
            }
            let mut blocks = Vec::new();
            if !text.is_empty() {
                blocks.push(json!({ "type": "text", "text": text }));
            }
            for c in tool_calls {
                blocks.push(json!({ "type": "tool_use", "id": c.id, "name": c.name, "input": c.args }));
            }
            if blocks.is_empty() {
                blocks.push(json!({ "type": "text", "text": "…" }));
            }
            json!({ "role": "assistant", "content": blocks })
        }
        Msg::Tool { results } => json!({
            "role": "user",
            "content": results.iter().map(|r| json!({
                "type": "tool_result",
                "tool_use_id": r.id,
                "content": r.content,
                "is_error": r.is_error,
            })).collect::<Vec<_>>(),
        }),
    }
}

pub async fn complete(base: &str, model: &str, key: &str, system: &str, msgs: &[Msg], tools: &[ToolSpec]) -> Result<Turn, String> {
    let body = json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": system,
        "messages": msgs.iter().map(to_api).collect::<Vec<_>>(),
        "tools": tools.iter().map(|t| json!({
            "name": t.name,
            "description": t.description,
            "input_schema": t.schema,
        })).collect::<Vec<_>>(),
    });
    let req = client()
        .post(format!("{base}/v1/messages"))
        .header("x-api-key", key)
        .header("anthropic-version", API_VERSION);
    let res = send_json(req, Some(&body)).await?;

    let content = res.get("content").cloned().unwrap_or_else(|| json!([]));
    let mut text = String::new();
    let mut tool_calls = Vec::new();
    for block in content.as_array().into_iter().flatten() {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => text.push_str(block.get("text").and_then(Value::as_str).unwrap_or("")),
            Some("tool_use") => tool_calls.push(ToolCall {
                id: block.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
                name: block.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
                args: block.get("input").cloned().unwrap_or_else(|| json!({})),
            }),
            _ => {}
        }
    }
    if text.is_empty() && tool_calls.is_empty() {
        let reason = res.get("stop_reason").and_then(Value::as_str).unwrap_or("unknown");
        return Err(format!("Claude returned an empty answer (stop reason: {reason})."));
    }
    Ok(Turn { text, tool_calls, raw: content })
}

pub async fn list_models(base: &str, key: &str) -> Result<Vec<ModelInfo>, String> {
    let req = client()
        .get(format!("{base}/v1/models?limit=100"))
        .header("x-api-key", key)
        .header("anthropic-version", API_VERSION);
    let res = send_json(req, None).await?;
    Ok(res
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let id = m.get("id")?.as_str()?.to_string();
            let label = m.get("display_name").and_then(Value::as_str).unwrap_or(&id).to_string();
            Some(ModelInfo { id, label })
        })
        .collect())
}
