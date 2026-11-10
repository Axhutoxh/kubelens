//! In-app assistant: HTTP endpoints and the tool-calling loop.
//!
//! `POST /api/ai/chat` streams Server-Sent Events. The loop asks the model, runs the read-only
//! tools it requests, feeds results back, and repeats until the model answers. Two kinds of
//! call pause the loop with a `permission` event: a read that wants unmasked data
//! (`reveal: true`), and a proposed change (`actions`), which comes with a preview of exactly
//! what would change. The UI resends the conversation with the user's decisions in
//! `approvals` to continue; a change only runs when its approval is `true`.

use super::actions;
use super::keystore;
use super::providers::{self, Conn, EndpointMode, ModelInfo, Msg, Provider, ToolCall, ToolResult};
use super::settings::{self, AiSettings};
use super::tools::{self, ToolSpec};
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

/// Read-only tools plus the change proposals (in-app chat only; MCP gets the read-only set)
fn chat_tools() -> &'static [ToolSpec] {
    static TOOLS: std::sync::OnceLock<Vec<ToolSpec>> = std::sync::OnceLock::new();
    TOOLS.get_or_init(|| tools::specs().iter().chain(actions::specs()).cloned().collect())
}

fn summary(name: &str, args: &Value) -> String {
    if actions::is_action(name) { actions::describe(name, args) } else { tools::describe_call(name, args) }
}

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

/// Endpoint and key for a provider, or None when it isn't connected.
async fn conn_for(provider: Provider, settings: &AiSettings) -> Option<(Conn, Option<keystore::KeySource>)> {
    let base = provider.endpoint(settings)?;
    if !provider.needs_key() {
        return Some((Conn { base, key: String::new() }, None));
    }
    let (key, source) = key_for(provider).await?;
    Some((Conn { base, key }, Some(source)))
}

fn not_connected(provider: Provider) -> ApiError {
    let how = if provider.needs_key() { "add its API key" } else { "connect it" };
    (StatusCode::BAD_REQUEST, format!("Connect {} first: {how} in AI settings.", provider.label()))
}

pub async fn handle_status() -> Json<Value> {
    let settings = settings::load();
    let mut providers_json = Vec::new();
    for p in Provider::ALL {
        let conn = conn_for(p, &settings).await;
        let model = model_for(p, &settings, None);
        // Azure also needs a deployment to be usable
        let configured = conn.is_some() && !model.is_empty();
        providers_json.push(json!({
            "id": p.as_str(),
            "label": p.label(),
            "configured": configured,
            "source": conn.as_ref().and_then(|(_, s)| *s),
            "model": model,
            "keyUrl": p.key_help_url(),
            "needsKey": p.needs_key(),
            "endpointMode": p.endpoint_mode(),
            "endpoint": settings.endpoints.get(p.as_str()),
            "defaultEndpoint": p.default_endpoint(),
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
    /// May be empty to keep the saved key (e.g. when only the endpoint changes) and for Ollama
    #[serde(default)]
    key: String,
    #[serde(default)]
    endpoint: Option<String>,
    /// Azure: the deployment name
    #[serde(default)]
    model: Option<String>,
}

/// Connects a provider: checks the key / endpoint / deployment against the provider (by
/// listing models, or a one-word request on Azure) before saving anything.
pub async fn handle_save_key(Json(req): Json<SaveKeyRequest>) -> Result<Json<Value>, ApiError> {
    let bad = |m: String| (StatusCode::BAD_REQUEST, m);
    let provider = provider_param(&req.provider)?;
    let mut s = settings::load();

    let new_key = req.key.trim().to_string();
    let key = if !provider.needs_key() {
        String::new()
    } else if !new_key.is_empty() {
        if new_key.len() < 10 || new_key.chars().any(char::is_whitespace) {
            return Err(bad("That doesn't look like an API key.".into()));
        }
        new_key.clone()
    } else {
        key_for(provider).await.map(|(k, _)| k).ok_or_else(|| bad("Paste an API key.".into()))?
    };

    let typed = req.endpoint.as_deref().map(str::trim).filter(|e| !e.is_empty());
    let endpoint = match (provider.endpoint_mode(), typed) {
        (EndpointMode::None, _) => None,
        (_, Some(e)) => Some(providers::normalize_endpoint(provider, e).map_err(bad)?),
        (EndpointMode::Required, None) => match provider.endpoint(&s) {
            Some(saved) => Some(saved),
            None => return Err(bad("Enter the endpoint URL.".into())),
        },
        // Ollama connects to the default local server when no URL is typed
        (EndpointMode::Optional, None) if provider == Provider::Ollama => provider.default_endpoint().map(str::to_string),
        (EndpointMode::Optional, None) => None,
    };
    let base = endpoint.clone().or_else(|| provider.endpoint(&s)).ok_or_else(|| bad("Enter the endpoint URL.".into()))?;
    let conn = Conn { base, key };

    let deployment = req.model.as_deref().map(str::trim).filter(|m| !m.is_empty()).map(str::to_string);
    let models: Vec<ModelInfo> = if provider == Provider::Azure {
        let dep = deployment
            .clone()
            .or_else(|| s.models.get("azure").cloned())
            .ok_or_else(|| bad("Enter the deployment name.".into()))?;
        if !dep.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
            return Err(bad("A deployment name has only letters, digits, '.', '_' and '-'.".into()));
        }
        providers::check_azure_deployment(&conn, &dep).await.map_err(bad)?;
        vec![ModelInfo { id: dep.clone(), label: dep }]
    } else {
        providers::list_models(provider, &conn, "").await.map_err(|e| {
            if provider == Provider::Ollama && e.starts_with("Could not reach") {
                bad(format!("Ollama isn't running at {}. Start Ollama (or check the URL) and try again.", conn.base))
            } else {
                bad(e)
            }
        })?
    };
    if models.is_empty() {
        return Err(bad(if provider == Provider::Ollama {
            "Ollama is running but has no models. Pull one that supports tool calling (for example `ollama pull qwen3` or `ollama pull llama3.1`) and try again.".into()
        } else {
            "The provider returned no chat models for this key.".into()
        }));
    }

    if provider.needs_key() && !new_key.is_empty() {
        tokio::task::spawn_blocking(move || keystore::set(provider, &new_key))
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Could not store the key: {e}")))?;
    }
    let id = provider.as_str().to_string();
    match endpoint {
        Some(e) => {
            s.endpoints.insert(id.clone(), e);
        }
        // OpenAI with the URL field cleared goes back to api.openai.com
        None if provider.endpoint_mode() == EndpointMode::Optional => {
            s.endpoints.remove(&id);
        }
        None => {}
    }
    let current = s.models.get(&id).cloned();
    let chosen = if provider == Provider::Azure {
        models[0].id.clone()
    } else if let Some(m) = current.filter(|m| models.iter().any(|x| &x.id == m)) {
        m
    } else if models.iter().any(|x| x.id == provider.default_model()) {
        provider.default_model().to_string()
    } else {
        models[0].id.clone()
    };
    s.models.insert(id.clone(), chosen);
    if s.provider.is_none() {
        s.provider = Some(id);
    }
    settings::save(&s).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(json!({ "success": true, "models": models })))
}

#[derive(Deserialize)]
pub struct ProviderQuery {
    provider: String,
}

/// Disconnects a provider: removes its saved key and endpoint.
pub async fn handle_delete_key(Query(q): Query<ProviderQuery>) -> Result<Json<Value>, ApiError> {
    let provider = provider_param(&q.provider)?;
    if provider.needs_key() {
        tokio::task::spawn_blocking(move || keystore::delete(provider))
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    }
    let mut s = settings::load();
    if s.endpoints.remove(provider.as_str()).is_some() {
        settings::save(&s).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    }
    Ok(Json(json!({ "success": true })))
}

pub async fn handle_models(Query(q): Query<ProviderQuery>) -> Result<Json<Value>, ApiError> {
    let provider = provider_param(&q.provider)?;
    let s = settings::load();
    let (conn, _) = conn_for(provider, &s).await.ok_or_else(|| not_connected(provider))?;
    let models = providers::list_models(provider, &conn, &model_for(provider, &s, None)).await.map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    Ok(Json(json!({ "models": models })))
}

/// Saves the default provider and model choices. Endpoints are only changed by connecting.
pub async fn handle_save_settings(Json(mut s): Json<AiSettings>) -> Result<Json<Value>, ApiError> {
    if let Some(p) = &s.provider {
        provider_param(p)?;
    }
    s.endpoints = settings::load().endpoints;
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
    crate::browser::open(&req.url).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
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
- Looking is read-only. To fix something you can propose one change with restart_workload, scale_workload, \
rollback_deployment, delete_pod or set_image. Nothing runs until the user reviews a preview and clicks Apply, and \
they may decline. Only propose a change when the user asks for a fix or clearly wants one; explain the cause and \
why the change helps first, and propose the smallest change that fixes it, one at a time. If the user declines, \
don't propose it again unless asked. For anything these can't do (ConfigMap edits, env vars, resources, Helm), \
say exactly what to do: the Kubellens action (e.g. ConfigMaps → Review & Save, Helm → Roll back) and/or the \
kubectl command.\n\
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
Deployments; pod and certificate-expiry alerts (bell icon); saved Workspaces; port forwarding; rollout history and \
rollback; TLS Certificates (expiry of every TLS Secret and the Ingresses using it); Log Search across many pods; \
Timeline per workload (rollouts, restarts, config changes, events); All Clusters health page; deployment health \
score; HPA, PodDisruptionBudget, NetworkPolicy, quota, service account and role views; Who Can Do What (RBAC)."
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
    let (conn, _) = conn_for(provider, &settings).await.ok_or_else(|| not_connected(provider))?;
    let model = model_for(provider, &settings, req.model.as_deref());
    if model.is_empty() {
        return Err(not_connected(provider));
    }
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
                let turn = match providers::complete(provider, &conn, &model, &system, &msgs, chat_tools()).await {
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

            // Reveals and changes need a decision before anything in this turn runs. A change
            // whose preview fails (not found, nothing to change) goes back to the model as an error.
            let mut undecided: Vec<Value> = Vec::new();
            let mut failed_previews: HashMap<String, String> = HashMap::new();
            for c in &pending {
                if approvals.contains_key(&c.id) {
                    continue;
                }
                if tools::wants_reveal(&c.name, &c.args) {
                    undecided.push(json!({ "kind": "reveal", "id": c.id, "name": c.name, "args": c.args, "summary": tools::describe_call(&c.name, &c.args) }));
                } else if actions::is_action(&c.name) {
                    yield event(json!({ "type": "status", "text": format!("Preparing: {}", actions::describe(&c.name, &c.args)) }));
                    match actions::preview(&c.name, &c.args, &cluster).await {
                        Ok(p) => undecided.push(json!({ "kind": "action", "id": c.id, "name": c.name, "args": c.args, "summary": actions::describe(&c.name, &c.args), "preview": p })),
                        Err(e) => {
                            failed_previews.insert(c.id.clone(), e);
                        }
                    }
                }
            }
            if !undecided.is_empty() {
                yield event(json!({ "type": "permission", "requests": undecided }));
                return;
            }

            let mut results = Vec::new();
            for call in std::mem::take(&mut pending) {
                if actions::is_action(&call.name) {
                    let applied = approvals.get(&call.id).copied() == Some(true) && !failed_previews.contains_key(&call.id);
                    yield event(json!({ "type": "tool_start", "id": call.id, "name": call.name, "summary": summary(&call.name, &call.args), "reveal": false, "action": true, "applied": applied }));
                    let (content, is_error) = if let Some(e) = failed_previews.get(&call.id) {
                        (format!("Error: {e}"), true)
                    } else if applied {
                        match actions::apply(&call.name, &call.args, &cluster).await {
                            Ok(out) => {
                                state.cache.invalidate_all().await;
                                (format!("Applied: {}\n{out}\nTell the user what changed and how to check the result.", actions::describe(&call.name, &call.args)), false)
                            }
                            Err(e) => (format!("Error: applying the change failed: {e}"), true),
                        }
                    } else {
                        ("The user chose not to apply this change. Nothing was changed; don't propose it again unless they ask.".to_string(), false)
                    };
                    yield event(json!({
                        "type": "tool_end",
                        "id": call.id,
                        "ok": !is_error,
                        "redacted": 0,
                        "truncated": false,
                        "chars": content.len(),
                        "error": if is_error { Some(content.clone()) } else { None },
                        "declined": !applied && !is_error,
                    }));
                    results.push(ToolResult { id: call.id, name: call.name, content, is_error });
                    continue;
                }
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
