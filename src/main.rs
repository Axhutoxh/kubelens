#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use futures_util::Stream;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    convert::Infallible,
    net::SocketAddr,
    path::PathBuf,
    process::Stdio,
    sync::Arc,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::RwLock,
};
use tower_http::{
    cors::{Any, CorsLayer},
    services::{ServeDir, ServeFile},
};

#[derive(Clone, Serialize, Deserialize)]
struct PortForwardSession {
    id: String,
    pod: String,
    namespace: String,
    #[serde(rename = "containerPort")]
    container_port: u16,
    #[serde(rename = "localPort")]
    local_port: u16,
    url: String,
    status: String,
    #[serde(rename = "startedAt")]
    started_at: String,
}

struct ActivePortForward {
    session: PortForwardSession,
    child: Arc<std::sync::Mutex<Option<std::process::Child>>>,
}

#[derive(Clone)]
struct AppState {
    current_context: Arc<RwLock<String>>,
    port_forwards: Arc<RwLock<HashMap<String, ActivePortForward>>>,
}

#[derive(Serialize, Deserialize)]
struct ContextItem {
    name: String,
    #[serde(rename = "isActive")]
    is_active: bool,
}

#[derive(Serialize, Deserialize)]
struct ContextResponse {
    #[serde(rename = "currentContext")]
    current_context: String,
    contexts: Vec<ContextItem>,
}

#[derive(Deserialize)]
struct SwitchContextRequest {
    context: String,
}

#[derive(Deserialize)]
struct ClusterOverviewQuery {
    context: Option<String>,
}

#[derive(Deserialize)]
struct ResourceQuery {
    namespace: Option<String>,
    context: Option<String>,
}

#[derive(Deserialize)]
struct ResourceDetailQuery {
    kind: String,
    name: String,
    namespace: Option<String>,
    context: Option<String>,
}

#[derive(Deserialize)]
struct PodEventsQuery {
    name: String,
    namespace: String,
    context: Option<String>,
}

#[derive(Deserialize)]
struct StartPortForwardRequest {
    pod: String,
    namespace: String,
    #[serde(rename = "containerPort")]
    container_port: u16,
    #[serde(rename = "localPort")]
    local_port: Option<u16>,
    context: Option<String>,
}

#[derive(Deserialize)]
struct StopPortForwardRequest {
    id: String,
}

#[derive(Deserialize)]
struct ManifestQuery {
    kind: String,
    name: String,
    namespace: Option<String>,
    context: Option<String>,
}

#[derive(Deserialize)]
struct ApplyRequest {
    manifest: String,
    context: Option<String>,
}

#[derive(Deserialize)]
struct DeleteRequest {
    kind: String,
    name: String,
    namespace: Option<String>,
    context: Option<String>,
}

#[derive(Deserialize)]
struct RestartRequest {
    kind: String,
    name: String,
    namespace: String,
    context: Option<String>,
}

#[derive(Deserialize)]
struct ScaleRequest {
    kind: String,
    name: String,
    namespace: String,
    replicas: i32,
    context: Option<String>,
}

#[derive(Deserialize)]
struct LogsQuery {
    pod: String,
    namespace: String,
    container: Option<String>,
    timestamps: Option<String>,
    tail: Option<String>,
    follow: Option<String>,
    context: Option<String>,
}

#[derive(Deserialize, Serialize, Clone)]
struct SetEnvItem {
    name: String,
    value: Option<String>,
    #[serde(default)]
    remove: bool,
}

#[derive(Deserialize)]
struct SetEnvRequest {
    pod: String,
    namespace: String,
    #[serde(default)]
    container: Option<String>,
    env: Vec<SetEnvItem>,
    context: Option<String>,
}

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn create_kubectl_cmd() -> Command {
    let mut cmd = Command::new("kubectl");
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn create_kubectl_std_cmd() -> std::process::Command {
    let mut cmd = std::process::Command::new("kubectl");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

async fn get_current_context() -> String {
    let output = create_kubectl_cmd()
        .args(["config", "current-context"])
        .output()
        .await;

    match output {
        Ok(out) if out.status.success() => {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }
        _ => String::new(),
    }
}

async fn run_kubectl_cmd(args: &[&str], current_ctx: &str) -> Result<String, String> {
    let mut cmd = create_kubectl_cmd();
    if !current_ctx.is_empty() {
        cmd.arg("--context").arg(current_ctx);
    }
    for arg in args {
        cmd.arg(arg);
    }

    let res = tokio::time::timeout(tokio::time::Duration::from_secs(15), cmd.output()).await;
    match res {
        Ok(Ok(output)) => {
            if output.status.success() {
                Ok(String::from_utf8_lossy(&output.stdout).to_string())
            } else {
                Err(String::from_utf8_lossy(&output.stderr).to_string())
            }
        }
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err(format!(
            "Command timed out after 15s (context: '{}'). Cluster may be unreachable or requires auth.",
            current_ctx
        )),
    }
}

// Handlers
async fn handle_contexts(State(state): State<AppState>) -> impl IntoResponse {
    let current_ctx = state.current_context.read().await.clone();

    let output = create_kubectl_cmd()
        .args(["config", "get-contexts", "-o", "name"])
        .output()
        .await;

    let mut contexts = Vec::new();
    if let Ok(out) = output {
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            let name = line.trim();
            if !name.is_empty() {
                contexts.push(ContextItem {
                    name: name.to_string(),
                    is_active: name == current_ctx,
                });
            }
        }
    }

    Json(ContextResponse {
        current_context: current_ctx,
        contexts,
    })
}

async fn handle_switch_context(
    State(state): State<AppState>,
    Json(payload): Json<SwitchContextRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let res = create_kubectl_cmd()
        .args(["config", "use-context", &payload.context])
        .output()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if !res.status.success() {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            String::from_utf8_lossy(&res.stderr).to_string(),
        ));
    }

    let mut lock = state.current_context.write().await;
    *lock = payload.context.clone();

    Ok(Json(serde_json::json!({
        "success": true,
        "currentContext": payload.context
    })))
}

async fn handle_cluster_overview(
    Query(q): Query<ClusterOverviewQuery>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let current_ctx = state.current_context.read().await.clone();
    let ctx_to_use = q.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current_ctx);

    let nodes_raw = run_kubectl_cmd(&["get", "nodes", "-o", "json"], ctx_to_use)
        .await
        .unwrap_or_else(|_| "{}".to_string());
    let pods_raw = run_kubectl_cmd(&["get", "pods", "-A", "-o", "json"], ctx_to_use)
        .await
        .unwrap_or_else(|_| "{}".to_string());
    let ns_raw = run_kubectl_cmd(&["get", "namespaces", "-o", "json"], ctx_to_use)
        .await
        .unwrap_or_else(|_| "{}".to_string());

    let nodes_json: serde_json::Value = serde_json::from_str(&nodes_raw).unwrap_or_default();
    let pods_json: serde_json::Value = serde_json::from_str(&pods_raw).unwrap_or_default();
    let ns_json: serde_json::Value = serde_json::from_str(&ns_raw).unwrap_or_default();

    let nodes_count = nodes_json["items"].as_array().map_or(0, |a| a.len());
    let pods_count = pods_json["items"].as_array().map_or(0, |a| a.len());
    let ns_count = ns_json["items"].as_array().map_or(0, |a| a.len());

    Json(serde_json::json!({
        "context": ctx_to_use,
        "nodesCount": nodes_count,
        "podsCount": pods_count,
        "namespacesCount": ns_count
    }))
}

async fn handle_k8s_resource(
    Path(kind): Path<String>,
    Query(query): Query<ResourceQuery>,
    State(state): State<AppState>,
) -> Result<Response, (StatusCode, String)> {
    let current_ctx = state.current_context.read().await.clone();
    let ctx_to_use = query.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current_ctx);
    let mut args = vec!["get", &kind, "-o", "json"];

    let ns_val;
    if let Some(ns) = &query.namespace {
        if ns != "_all" {
            ns_val = ns.clone();
            args.push("-n");
            args.push(&ns_val);
        } else {
            args.push("-A");
        }
    } else {
        args.push("-A");
    }

    let out = run_kubectl_cmd(&args, ctx_to_use)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok((
        [(header::CONTENT_TYPE, "application/json")],
        out,
    )
        .into_response())
}

async fn handle_get_manifest(
    Query(q): Query<ManifestQuery>,
    State(state): State<AppState>,
) -> Result<Response, (StatusCode, String)> {
    let current_ctx = state.current_context.read().await.clone();
    let ctx_to_use = q.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current_ctx);
    let mut args = vec!["get", &q.kind, &q.name, "-o", "yaml"];

    let ns_val;
    if let Some(ns) = &q.namespace {
        ns_val = ns.clone();
        args.push("-n");
        args.push(&ns_val);
    }

    let out = run_kubectl_cmd(&args, ctx_to_use)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok((
        [(header::CONTENT_TYPE, "text/yaml")],
        out,
    )
        .into_response())
}

async fn handle_apply_manifest(
    State(state): State<AppState>,
    Json(req): Json<ApplyRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let current_ctx = state.current_context.read().await.clone();
    let ctx_to_use = req.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current_ctx);
    let mut cmd = create_kubectl_cmd();
    if !ctx_to_use.is_empty() {
        cmd.arg("--context").arg(ctx_to_use);
    }
    cmd.args(["apply", "-f", "-"]);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(req.manifest.as_bytes())
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if output.status.success() {
        Ok(Json(serde_json::json!({
            "success": true,
            "output": String::from_utf8_lossy(&output.stdout).to_string()
        })))
    } else {
        Err((
            StatusCode::BAD_REQUEST,
            String::from_utf8_lossy(&output.stderr).to_string(),
        ))
    }
}

async fn handle_delete_resource(
    State(state): State<AppState>,
    Json(req): Json<DeleteRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let current_ctx = state.current_context.read().await.clone();
    let ctx_to_use = req.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current_ctx);
    let mut args = vec!["delete", &req.kind, &req.name];

    let ns_val;
    if let Some(ns) = &req.namespace {
        ns_val = ns.clone();
        args.push("-n");
        args.push(&ns_val);
    }

    let out = run_kubectl_cmd(&args, ctx_to_use)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(serde_json::json!({
        "success": true,
        "output": out
    })))
}

async fn handle_scale_resource(
    State(state): State<AppState>,
    Json(req): Json<ScaleRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let current_ctx = state.current_context.read().await.clone();
    let ctx_to_use = req.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current_ctx);
    let target = format!("{}/{}", req.kind, req.name);
    let replicas_arg = format!("--replicas={}", req.replicas);
    let args = vec!["scale", &target, &replicas_arg, "-n", &req.namespace];

    let out = run_kubectl_cmd(&args, ctx_to_use)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(serde_json::json!({
        "success": true,
        "output": out
    })))
}

async fn handle_restart_resource(
    State(state): State<AppState>,
    Json(req): Json<RestartRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let current_ctx = state.current_context.read().await.clone();
    let ctx_to_use = req.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current_ctx);
    let target = format!("{}/{}", req.kind, req.name);
    let args = vec!["rollout", "restart", &target, "-n", &req.namespace];

    let out = run_kubectl_cmd(&args, ctx_to_use)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(serde_json::json!({
        "success": true,
        "output": out
    })))
}

async fn handle_pod_logs(
    Query(q): Query<LogsQuery>,
    State(state): State<AppState>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, (StatusCode, String)> {
    let current_ctx = state.current_context.read().await.clone();
    let ctx_to_use = q.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current_ctx);
    let mut cmd = create_kubectl_cmd();
    if !ctx_to_use.is_empty() {
        cmd.arg("--context").arg(ctx_to_use);
    }

    let tail_lines = q.tail.unwrap_or_else(|| "200".to_string());
    cmd.args(["logs", &q.pod, "-n", &q.namespace, &format!("--tail={}", tail_lines)]);

    if let Some(c) = &q.container {
        if !c.is_empty() {
            cmd.arg("-c").arg(c);
        }
    }
    if q.timestamps.as_deref() == Some("true") {
        cmd.arg("--timestamps");
    }
    if q.follow.as_deref() == Some("true") {
        cmd.arg("-f");
    }

    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, "No stdout".to_string()))?;

    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();

    let stream = async_stream::stream! {
        while let Ok(Some(line)) = lines.next_line().await {
            yield Ok(Event::default().data(line));
        }
    };

    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

fn current_time_str() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let secs = now % 60;
    let mins = (now / 60) % 60;
    let hours = (now / 3600) % 24;
    format!("{:02}:{:02}:{:02} UTC", hours, mins, secs)
}

fn find_free_port(start: u16) -> Option<u16> {
    for port in start..65535 {
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Some(port);
        }
    }
    None
}

async fn handle_resource_detail(
    Query(q): Query<ResourceDetailQuery>,
    State(state): State<AppState>,
) -> Result<Response, (StatusCode, String)> {
    let current_ctx = state.current_context.read().await.clone();
    let ctx_to_use = q.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current_ctx);
    let mut args = vec!["get", &q.kind, &q.name, "-o", "json"];

    let ns_val;
    if let Some(ns) = &q.namespace {
        if !ns.is_empty() && ns != "_all" {
            ns_val = ns.clone();
            args.push("-n");
            args.push(&ns_val);
        }
    }

    let out = run_kubectl_cmd(&args, ctx_to_use)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok((
        [(header::CONTENT_TYPE, "application/json")],
        out,
    ).into_response())
}

async fn handle_pod_events(
    Query(q): Query<PodEventsQuery>,
    State(state): State<AppState>,
) -> Result<Response, (StatusCode, String)> {
    let current_ctx = state.current_context.read().await.clone();
    let ctx_to_use = q.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current_ctx);
    let field_selector = format!("involvedObject.name={}", q.name);
    let args = [
        "get",
        "events",
        "--field-selector",
        &field_selector,
        "-n",
        &q.namespace,
        "-o",
        "json",
    ];

    let out = run_kubectl_cmd(&args, ctx_to_use)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok((
        [(header::CONTENT_TYPE, "application/json")],
        out,
    ).into_response())
}

async fn handle_set_env(
    State(state): State<AppState>,
    Json(req): Json<SetEnvRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let current_ctx = state.current_context.read().await.clone();
    let ctx_to_use = req.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current_ctx);

    // 1. Fetch Pod JSON to inspect owners and container spec
    let pod_raw = run_kubectl_cmd(&["get", "pod", &req.pod, "-n", &req.namespace, "-o", "json"], ctx_to_use)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Failed to inspect pod: {}", e)))?;

    let mut pod_json: serde_json::Value = serde_json::from_str(&pod_raw)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to parse pod JSON: {}", e)))?;

    // 2. Check if Pod is owned by a controller (Deployment via ReplicaSet, StatefulSet, DaemonSet)
    let mut target_controller: Option<(String, String)> = None;

    if let Some(owners) = pod_json.get("metadata").and_then(|m| m.get("ownerReferences")).and_then(|o| o.as_array()) {
        for owner in owners {
            let kind = owner.get("kind").and_then(|k| k.as_str()).unwrap_or("");
            let name = owner.get("name").and_then(|n| n.as_str()).unwrap_or("");
            if kind == "ReplicaSet" {
                let rs_raw = run_kubectl_cmd(&["get", "replicaset", name, "-n", &req.namespace, "-o", "json"], ctx_to_use).await;
                if let Ok(rs_str) = rs_raw {
                    if let Ok(rs_json) = serde_json::from_str::<serde_json::Value>(&rs_str) {
                        if let Some(rs_owners) = rs_json.get("metadata").and_then(|m| m.get("ownerReferences")).and_then(|o| o.as_array()) {
                            for rs_owner in rs_owners {
                                let rs_kind = rs_owner.get("kind").and_then(|k| k.as_str()).unwrap_or("");
                                let rs_name = rs_owner.get("name").and_then(|n| n.as_str()).unwrap_or("");
                                if rs_kind == "Deployment" {
                                    target_controller = Some(("deployment".to_string(), rs_name.to_string()));
                                    break;
                                }
                            }
                        }
                    }
                }
                if target_controller.is_none() {
                    target_controller = Some(("replicaset".to_string(), name.to_string()));
                }
                break;
            } else if kind == "Deployment" || kind == "StatefulSet" || kind == "DaemonSet" {
                target_controller = Some((kind.to_lowercase(), name.to_string()));
                break;
            }
        }
    }

    // 3. If controlled by a controller, execute kubectl set env on that controller
    if let Some((kind, name)) = target_controller {
        let target_arg = format!("{}/{}", kind, name);
        let mut args: Vec<String> = vec!["set".to_string(), "env".to_string(), target_arg.clone(), "-n".to_string(), req.namespace.clone()];

        if let Some(ref c) = req.container {
            if !c.is_empty() {
                args.push(format!("--containers={}", c));
            }
        }

        for item in &req.env {
            if item.remove {
                args.push(format!("{}-", item.name));
            } else {
                args.push(format!("{}={}", item.name, item.value.as_deref().unwrap_or("")));
            }
        }

        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let out = run_kubectl_cmd(&arg_refs, ctx_to_use)
            .await
            .map_err(|e| (StatusCode::BAD_REQUEST, format!("kubectl set env failed: {}", e)))?;

        return Ok(Json(serde_json::json!({
            "success": true,
            "target": target_arg,
            "isController": true,
            "message": format!("Updated environment on {} '{}' (rolling rollout triggered)", kind, name),
            "output": out
        })));
    }

    // 4. Standalone Pod: update spec.containers and replace
    if let Some(containers) = pod_json.get_mut("spec").and_then(|s| s.get_mut("containers")).and_then(|c| c.as_array_mut()) {
        let container_idx = if let Some(ref c_name) = req.container {
            containers.iter().position(|c| c.get("name").and_then(|n| n.as_str()) == Some(c_name.as_str())).unwrap_or(0)
        } else {
            0
        };

        if let Some(target_c) = containers.get_mut(container_idx) {
            let mut env_list = target_c.get("env").and_then(|e| e.as_array()).cloned().unwrap_or_default();
            for item in &req.env {
                if item.remove {
                    env_list.retain(|e| e.get("name").and_then(|n| n.as_str()) != Some(&item.name));
                } else {
                    let val = item.value.as_deref().unwrap_or("");
                    if let Some(existing) = env_list.iter_mut().find(|e| e.get("name").and_then(|n| n.as_str()) == Some(&item.name)) {
                        existing["value"] = serde_json::Value::String(val.to_string());
                        if let Some(obj) = existing.as_object_mut() {
                            obj.remove("valueFrom");
                        }
                    } else {
                        env_list.push(serde_json::json!({
                            "name": item.name,
                            "value": val
                        }));
                    }
                }
            }
            target_c["env"] = serde_json::Value::Array(env_list);
        }
    }

    if let Some(meta) = pod_json.get_mut("metadata").and_then(|m| m.as_object_mut()) {
        meta.remove("resourceVersion");
        meta.remove("uid");
        meta.remove("creationTimestamp");
        meta.remove("generation");
        meta.remove("managedFields");
    }
    if let Some(obj) = pod_json.as_object_mut() {
        obj.remove("status");
    }

    let updated_manifest = serde_json::to_string(&pod_json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut cmd = create_kubectl_cmd();
    if !ctx_to_use.is_empty() {
        cmd.arg("--context").arg(ctx_to_use);
    }
    cmd.args(["replace", "--force", "-f", "-"]);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(updated_manifest.as_bytes()).await;
    }
    let output = child.wait_with_output().await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if output.status.success() {
        Ok(Json(serde_json::json!({
            "success": true,
            "target": format!("pod/{}", req.pod),
            "isController": false,
            "message": format!("Standalone pod '{}' replaced with updated environment variables", req.pod),
            "output": String::from_utf8_lossy(&output.stdout).to_string()
        })))
    } else {
        Err((StatusCode::BAD_REQUEST, String::from_utf8_lossy(&output.stderr).to_string()))
    }
}

async fn handle_start_port_forward(
    State(state): State<AppState>,
    Json(req): Json<StartPortForwardRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let current_ctx = state.current_context.read().await.clone();
    let ctx_to_use = req.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current_ctx);
    
    let requested_port = req.local_port.unwrap_or(0);
    let local_port = if requested_port > 0 {
        requested_port
    } else {
        req.container_port
    };

    let session_id = format!("{}-{}-{}", req.pod, local_port, req.container_port);

    {
        let lock = state.port_forwards.read().await;
        if lock.contains_key(&session_id) {
            return Err((
                StatusCode::CONFLICT,
                "A port forward session for this port already exists".to_string(),
            ));
        }
    }

    let mut cmd = create_kubectl_std_cmd();
    if !ctx_to_use.is_empty() {
        cmd.arg("--context").arg(ctx_to_use);
    }
    cmd.args([
        "port-forward",
        &format!("pod/{}", req.pod),
        &format!("{}:{}", local_port, req.container_port),
        "-n",
        &req.namespace,
        "--address",
        "127.0.0.1",
    ]);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());

    let mut child = cmd.spawn().map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to run kubectl port-forward: {}", e))
    })?;

    // Wait a moment to ensure it didn't exit with immediate error
    tokio::time::sleep(tokio::time::Duration::from_millis(600)).await;
    match child.try_wait() {
        Ok(Some(status)) => {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("kubectl port-forward failed to start (exit status: {})", status),
            ));
        }
        _ => {}
    }

    let session = PortForwardSession {
        id: session_id.clone(),
        pod: req.pod.clone(),
        namespace: req.namespace.clone(),
        container_port: req.container_port,
        local_port,
        url: format!("http://localhost:{}", local_port),
        status: "Active".to_string(),
        started_at: current_time_str(),
    };

    let child_shared = Arc::new(std::sync::Mutex::new(Some(child)));
    let child_clone = child_shared.clone();
    let pf_map = state.port_forwards.clone();
    let sid_clone = session_id.clone();

    tokio::task::spawn_blocking(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_millis(1000));
            let mut lock = child_clone.lock().unwrap();
            if let Some(ref mut c) = *lock {
                if let Ok(Some(_)) = c.try_wait() {
                    break;
                }
            } else {
                break;
            }
        }
        let map_clone = pf_map.clone();
        tokio::spawn(async move {
            let mut map = map_clone.write().await;
            map.remove(&sid_clone);
        });
    });

    {
        let mut map = state.port_forwards.write().await;
        map.insert(
            session_id,
            ActivePortForward {
                session: session.clone(),
                child: child_shared,
            },
        );
    }

    Ok(Json(serde_json::json!({
        "success": true,
        "session": session
    })))
}

async fn handle_stop_port_forward(
    State(state): State<AppState>,
    Json(req): Json<StopPortForwardRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let mut map = state.port_forwards.write().await;
    if let Some(entry) = map.remove(&req.id) {
        let mut lock = entry.child.lock().unwrap();
        if let Some(mut c) = lock.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        Ok(Json(serde_json::json!({ "success": true })))
    } else {
        Err((StatusCode::NOT_FOUND, "Port forward session not found".to_string()))
    }
}

async fn handle_list_port_forwards(State(state): State<AppState>) -> impl IntoResponse {
    let map = state.port_forwards.read().await;
    let list: Vec<PortForwardSession> = map.values().map(|v| v.session.clone()).collect();
    Json(serde_json::json!({ "sessions": list }))
}

fn find_frontend_dir() -> PathBuf {
    // 1. Current working directory
    let p1 = PathBuf::from("frontend/dist");
    if p1.exists() {
        return p1;
    }

    // 2. Relative to the executable
    if let Ok(mut exe) = std::env::current_exe() {
        exe.pop(); // remove executable file name
        let p2 = exe.join("frontend").join("dist");
        if p2.exists() {
            return p2;
        }
        let p3 = exe.join("dist");
        if p3.exists() {
            return p3;
        }
        // If running from target/debug or target/release
        if exe.ends_with("debug") || exe.ends_with("release") {
            exe.pop(); // target
            exe.pop(); // freelens-rust root
            let p4 = exe.join("frontend").join("dist");
            if p4.exists() {
                return p4;
            }
        }
    }

    // 3. One folder up
    let p5 = PathBuf::from("../frontend/dist");
    if p5.exists() {
        return p5;
    }

    PathBuf::from("frontend/dist")
}

#[tokio::main]
async fn main() {
    let initial_context = get_current_context().await;
    let state = AppState {
        current_context: Arc::new(RwLock::new(initial_context.clone())),
        port_forwards: Arc::new(RwLock::new(HashMap::new())),
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let api_router = Router::new()
        .route("/contexts", get(handle_contexts))
        .route("/context/switch", post(handle_switch_context))
        .route("/cluster/overview", get(handle_cluster_overview))
        .route("/resource/detail", get(handle_resource_detail))
        .route("/resource/events", get(handle_pod_events))
        .route("/k8s/:kind", get(handle_k8s_resource))
        .route("/k8s/manifest", get(handle_get_manifest))
        .route("/k8s/apply", post(handle_apply_manifest))
        .route("/k8s/delete", post(handle_delete_resource))
        .route("/k8s/scale", post(handle_scale_resource))
        .route("/k8s/restart", post(handle_restart_resource))
        .route("/k8s/env/set", post(handle_set_env))
        .route("/k8s/logs/stream", get(handle_pod_logs))
        .route("/port-forward/start", post(handle_start_port_forward))
        .route("/port-forward/stop", post(handle_stop_port_forward))
        .route("/port-forward/list", get(handle_list_port_forwards))
        .with_state(state);

    let frontend_dir = find_frontend_dir();
    let index_file = frontend_dir.join("index.html");

    println!("📁 Serving UI from: {:?}", frontend_dir);

    let app = Router::new()
        .nest("/api", api_router)
        .fallback_service(
            ServeDir::new(&frontend_dir).not_found_service(ServeFile::new(&index_file)),
        )
        .layer(cors);

    let base_port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(9090);

    // Try base_port, or find next available port up to +10
    let mut bound_listener = None;
    let mut active_port = base_port;

    for p in base_port..(base_port + 15) {
        let addr = SocketAddr::from(([0, 0, 0, 0], p));
        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => {
                bound_listener = Some(listener);
                active_port = p;
                break;
            }
            Err(_) => {
                // Port busy, try next
                continue;
            }
        }
    }

    let listener = match bound_listener {
        Some(l) => l,
        None => {
            eprintln!("❌ Failed to bind to any port in range {}-{}", base_port, base_port + 15);
            std::process::exit(1);
        }
    };

    let url = format!("http://localhost:{}", active_port);
    println!("🦀 Freelens Rust Backend running at {}", url);
    println!("☸️ Active Kubernetes Context: {}", initial_context);

    // Automatically launch application window on Windows unless disabled
    #[cfg(target_os = "windows")]
    {
        let no_browser = std::env::var("FREELENS_NO_BROWSER").is_ok()
            || std::env::var("FREELENS_ELECTRON").is_ok()
            || std::env::var("ELECTRON_RUN_AS_NODE").is_ok()
            || std::env::args().any(|a| a == "--no-browser" || a == "-n");

        if !no_browser {
            let u = url.clone();
            tokio::spawn(async move {
                tokio::time::sleep(tokio::time::Duration::from_millis(400)).await;
                launch_desktop_app(&u).await;
            });
        } else {
            println!("🖥️ Running in Electron / headless mode (external browser launch disabled)");
        }
    }

    axum::serve(listener, app).await.unwrap();
}

#[cfg(target_os = "windows")]
fn find_desktop_browser() -> Option<PathBuf> {
    let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let program_files = std::env::var("ProgramFiles").unwrap_or_default();
    let program_files_x86 = std::env::var("ProgramFiles(x86)").unwrap_or_default();

    let candidates = [
        // Edge (Standard Windows locations)
        format!("{}\\Microsoft\\Edge\\Application\\msedge.exe", program_files_x86),
        format!("{}\\Microsoft\\Edge\\Application\\msedge.exe", program_files),
        format!("{}\\Microsoft\\Edge\\Application\\msedge.exe", local_app_data),
        // Chrome
        format!("{}\\Google\\Chrome\\Application\\chrome.exe", program_files),
        format!("{}\\Google\\Chrome\\Application\\chrome.exe", program_files_x86),
        format!("{}\\Google\\Chrome\\Application\\chrome.exe", local_app_data),
        // Brave
        format!("{}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe", program_files),
        format!("{}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe", program_files_x86),
    ];

    for path_str in &candidates {
        if !path_str.is_empty() {
            let path = PathBuf::from(path_str);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
async fn launch_desktop_app(url: &str) {
    if let Some(browser_exe) = find_desktop_browser() {
        let mut user_data = std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."));
        user_data.push("FreelensApp");
        user_data.push("profile");

        let app_arg = format!("--app={}", url);
        let data_arg = format!("--user-data-dir={}", user_data.display());

        let child_res = Command::new(&browser_exe)
            .args([
                &app_arg,
                &data_arg,
                "--window-size=1440,900",
                "--disable-features=Translate",
                "--no-first-run",
                "--no-default-browser-check",
            ])
            .spawn();

        if let Ok(mut child) = child_res {
            // Keep server running; do not abruptly exit when the launcher helper delegates to Edge
            tokio::spawn(async move {
                let _ = child.wait().await;
            });
            return;
        }
    }

    // Fallback: standard browser start
    let u = url.to_string();
    tokio::spawn(async move {
        let mut cmd = Command::new("cmd");
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let _ = cmd.args(["/c", "start", &u]).spawn();
    });
}

