//! In-app assistant: HTTP endpoints and the tool-calling loop.
//!
//! `POST /api/ai/chat` streams Server-Sent Events. The loop asks the model, runs the read-only
//! tools it requests, feeds results back, and repeats until the model answers. A tool call
//! that wants unmasked data (`reveal: true`) pauses the loop with a `permission` event; the
//! UI resends the conversation with the user's decision in `approvals` to continue.

use super::keystore;
use super::providers::{self, Msg, Provider, ToolCall, ToolResult};
use super::settings::{self, AiSettings};
use super::tools;
use crate::AppState;
use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::sse::{Event, KeepAlive, Sse},
    Json,
};
use futures_util::Stream;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::convert::Infallible;

/// Model round-trips per user message before giving up
const MAX_STEPS: usize = 12;

type ApiError = (StatusCode, String);

fn provider_param(p: &str) -> Result<Provider, ApiError> {
    Provider::parse(p).ok_or((StatusCode::BAD_REQUEST, format!("Unknown provider '{p}'")))
}

async fn key_for(provider: Provider) -> Option<(String, keystore::KeySource)> {
    // keyring calls are blocking OS calls
    tokio::task::spawn_blocking(move || keystore::get(provider)).await.ok().flatten()
}

fn model_for(provider: Provider, settings: &AiSettings, requested: Option<&str>) -> String {
    requested
        .filter(|m| !m.is_empty())
        .map(str::to_string)
        .or_else(|| settings.models.get(provider.as_str()).cloned())
        .unwrap_or_else(|| provider.default_model().to_string())
}

pub async fn handle_status() -> Json<Value> {
    let settings = settings::load();
    let mut providers_json = Vec::new();
    for p in Provider::ALL {
        let key = key_for(p).await;
        providers_json.push(json!({
            "id": p.as_str(),
            "label": p.label(),
            "configured": key.is_some(),
            "source": key.map(|(_, s)| s),
            "model": model_for(p, &settings, None),
            "keyUrl": p.key_help_url(),
        }));
    }
    let exe = std::env::current_exe().ok().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    Json(json!({
        "providers": providers_json,
        "provider": settings.provider,
        "mcp": { "command": exe, "args": ["--mcp"] },
        "tools": tools::specs().iter().map(|t| json!({ "name": t.name, "description": t.description, "canReveal": t.can_reveal })).collect::<Vec<_>>(),
    }))
}

#[derive(Deserialize)]
pub struct SaveKeyRequest {
    provider: String,
    key: String,
}

/// Validates the key against the provider (by listing models) before storing it.
pub async fn handle_save_key(Json(req): Json<SaveKeyRequest>) -> Result<Json<Value>, ApiError> {
    let provider = provider_param(&req.provider)?;
    let key = req.key.trim().to_string();
    if key.len() < 10 || key.chars().any(char::is_whitespace) {
        return Err((StatusCode::BAD_REQUEST, "That doesn't look like an API key.".into()));
    }
    let models = providers::list_models(provider, &key).await.map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    tokio::task::spawn_blocking(move || keystore::set(provider, &key))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Could not store the key: {e}")))?;
    let mut s = settings::load();
    if s.provider.is_none() {
        s.provider = Some(provider.as_str().to_string());
        let _ = settings::save(&s);
    }
    Ok(Json(json!({ "success": true, "models": models })))
}

#[derive(Deserialize)]
pub struct ProviderQuery {
    provider: String,
}

pub async fn handle_delete_key(Query(q): Query<ProviderQuery>) -> Result<Json<Value>, ApiError> {
    let provider = provider_param(&q.provider)?;
    tokio::task::spawn_blocking(move || keystore::delete(provider))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(json!({ "success": true })))
}

pub async fn handle_models(Query(q): Query<ProviderQuery>) -> Result<Json<Value>, ApiError> {
    let provider = provider_param(&q.provider)?;
    let (key, _) = key_for(provider).await.ok_or((StatusCode::BAD_REQUEST, format!("No API key for {}", provider.label())))?;
    let models = providers::list_models(provider, &key).await.map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    Ok(Json(json!({ "models": models })))
}

pub async fn handle_save_settings(Json(s): Json<AiSettings>) -> Result<Json<Value>, ApiError> {
    if let Some(p) = &s.provider {
        provider_param(p)?;
    }
    settings::save(&s).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(json!({ "success": true })))
}

#[derive(Deserialize)]
pub struct OpenUrlRequest {
    url: String,
}

/// Opens a provider's sign-in / API key page in the user's browser (the app's webview can't
/// open external links). Only those pages are allowed, so this can't open arbitrary URLs.
pub async fn handle_open_url(Json(req): Json<OpenUrlRequest>) -> Result<Json<Value>, ApiError> {
    if !Provider::ALL.iter().any(|p| p.key_help_url() == req.url) {
        return Err((StatusCode::BAD_REQUEST, "URL not allowed".into()));
    }
    #[cfg(target_os = "windows")]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("rundll32");
        c.args(["url.dll,FileProtocolHandler", &req.url]).creation_flags(0x08000000);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(&req.url);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&req.url);
        c
    };
    cmd.spawn().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Could not open the browser: {e}")))?;
    Ok(Json(json!({ "success": true })))
}

#[derive(Deserialize, Default)]
pub struct ChatContext {
    #[serde(default)]
    cluster: Option<String>,
    #[serde(default)]
    namespace: Option<String>,
    #[serde(default)]
    view: Option<String>,
    /// e.g. "pod platform26q4/itam-alm-service-65bc…" when the user opened chat from a resource
    #[serde(default)]
    focus: Option<String>,
}

#[derive(Deserialize)]
pub struct ChatRequest {
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    messages: Vec<Msg>,
    #[serde(default)]
    context: ChatContext,
    /// tool call id -> whether the user allowed it to reveal masked data
    #[serde(default)]
    approvals: HashMap<String, bool>,
}

fn system_prompt(cluster: &str, ctx: &ChatContext) -> String {
    let ns = ctx.namespace.as_deref().filter(|n| !n.is_empty() && *n != "_all").unwrap_or("all namespaces");
    let mut where_ = format!("Cluster (kubeconfig context): {cluster}\nNamespace in view: {ns}");
    if let Some(v) = ctx.view.as_deref().filter(|v| !v.is_empty()) {
        where_.push_str(&format!("\nScreen: {v}"));
    }
    if let Some(f) = ctx.focus.as_deref().filter(|f| !f.is_empty()) {
        where_.push_str(&format!("\nThe user is looking at: {f}"));
    }
    format!(
        "You are the assistant built into Kubellens, a desktop Kubernetes IDE. You help the user understand \
and troubleshoot their cluster and use Kubellens.\n\n\
{where_}\n\n\
How to work:\n\
- Use the tools to look at real cluster state before answering questions about it; don't guess. Start broad \
(list_resources, get_events) and drill in (describe_resource, get_logs with previous=true for crash loops).\n\
- Tools are read-only. You cannot change the cluster. When a change is needed, say exactly what to do: the \
Kubellens action (e.g. Deployments → tag icon → Set image tag, Rolling Restart, Scale, ConfigMaps → Review & Save, \
Rollout History → Roll back) and/or the equivalent kubectl command.\n\
- Sensitive values (passwords, tokens, keys, Secret data) are replaced with [REDACTED] before you see them. Work \
with the masked output whenever possible. Only call a tool with reveal=true when the actual value is essential, and \
explain why in your answer; the user is asked to allow each such call and may decline. Never repeat a revealed \
secret in full in your reply.\n\
- Be concise and specific: name the pods, containers, reasons and timestamps you found. Use short Markdown \
(bullets, `code`, fenced blocks for commands).\n\n\
About Kubellens (for questions about the app): views for Pods, Deployments, StatefulSets, DaemonSets, Jobs/CronJobs, \
Services, Ingresses, ConfigMaps, Secrets, Storage, Nodes, Namespaces, Events, Helm releases and Custom Resources; \
Smart Lens Studio compares two clusters/namespaces side by side (Diff mode compares images, env and ConfigMaps); \
pod shell, live and previous-container logs with level/regex filters and download; Ctrl+K command palette; Ctrl+F \
find in ConfigMaps and YAML; bulk Set image tag with live rollout tracking and Undo all; release-drift badges on \
Deployments; pod alerts (bell icon); saved Workspaces; port forwarding; rollout history and rollback."
    )
}

fn event(v: Value) -> Result<Event, Infallible> {
    Ok(Event::default().data(v.to_string()))
}

pub async fn handle_chat(
    State(state): State<AppState>,
    Json(req): Json<ChatRequest>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let settings = settings::load();
    let provider = match req.provider.as_deref().or(settings.provider.as_deref()) {
        Some(p) => provider_param(p)?,
        None => Provider::Anthropic,
    };
    let (key, _) = key_for(provider)
        .await
        .ok_or((StatusCode::BAD_REQUEST, format!("Connect {} first: add an API key in AI settings.", provider.label())))?;
    let model = model_for(provider, &settings, req.model.as_deref());
    let cluster = match req.context.cluster.as_deref().filter(|c| !c.is_empty()) {
        Some(c) => c.to_string(),
        None => state.ctx().await,
    };
    let system = system_prompt(&cluster, &req.context);
    let approvals = req.approvals;
    let mut msgs = req.messages;

    let stream = async_stream::stream! {
        // A conversation can resume with tool calls that were waiting for permission
        let mut pending: Vec<ToolCall> = match msgs.last() {
            Some(Msg::Assistant { tool_calls, .. }) => tool_calls.clone(),
            _ => Vec::new(),
        };

        for _ in 0..MAX_STEPS {
            if pending.is_empty() {
                yield event(json!({ "type": "status", "text": "Thinking…" }));
                let turn = match providers::complete(provider, &model, &key, &system, &msgs, tools::specs()).await {
                    Ok(t) => t,
                    Err(e) => {
                        yield event(json!({ "type": "error", "message": e }));
                        return;
                    }
                };
                let assistant = Msg::Assistant {
                    text: turn.text,
                    tool_calls: turn.tool_calls.clone(),
                    raw: Some(turn.raw),
                    provider: Some(provider.as_str().to_string()),
                };
                yield event(json!({ "type": "messages", "messages": [assistant.clone()] }));
                msgs.push(assistant);
                if turn.tool_calls.is_empty() {
                    yield event(json!({ "type": "done" }));
                    return;
                }
                pending = turn.tool_calls;
            }

            // Calls that want unmasked data need a decision before anything in this turn runs
            let undecided: Vec<Value> = pending
                .iter()
                .filter(|c| tools::wants_reveal(&c.name, &c.args) && !approvals.contains_key(&c.id))
                .map(|c| json!({
                    "id": c.id,
                    "name": c.name,
                    "args": c.args,
                    "summary": tools::describe_call(&c.name, &c.args),
                }))
                .collect();
            if !undecided.is_empty() {
                yield event(json!({ "type": "permission", "requests": undecided }));
                return;
            }

            let mut results = Vec::new();
            for call in std::mem::take(&mut pending) {
                let wants = tools::wants_reveal(&call.name, &call.args);
                let allowed = wants && approvals.get(&call.id).copied().unwrap_or(false);
                let summary = tools::describe_call(&call.name, &call.args);
                yield event(json!({ "type": "tool_start", "id": call.id, "name": call.name, "summary": summary, "reveal": allowed }));
                let (content, is_error, redacted, truncated) = match tools::execute(&call.name, &call.args, &cluster, allowed).await {
                    Ok(out) => {
                        let mut text = out.text;
                        if wants && !allowed {
                            text.push_str("\n\n[The user declined to reveal masked values for this call. Continue with the masked data.]");
                        }
                        (text, false, out.redacted, out.truncated)
                    }
                    Err(e) => (format!("Error: {e}"), true, 0, false),
                };
                yield event(json!({
                    "type": "tool_end",
                    "id": call.id,
                    "ok": !is_error,
                    "redacted": redacted,
                    "truncated": truncated,
                    "chars": content.len(),
                    "error": if is_error { Some(content.clone()) } else { None },
                }));
                results.push(ToolResult { id: call.id, name: call.name, content, is_error });
            }
            let tool_msg = Msg::Tool { results };
            yield event(json!({ "type": "messages", "messages": [tool_msg.clone()] }));
            msgs.push(tool_msg);
        }
        yield event(json!({ "type": "error", "message": format!("Stopped after {MAX_STEPS} steps without a final answer. Try a narrower question.") }));
    };

    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}
