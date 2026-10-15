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
use axum::body::Bytes;
use futures_util::{
    future::{BoxFuture, FutureExt, Shared},
    Stream,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    convert::Infallible,
    net::SocketAddr,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, OnceLock,
    },
    time::Instant,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{OnceCell, RwLock},
};
use tower_http::cors::{Any, CorsLayer};

#[derive(Clone)]
struct CachedEntry {
    // Bytes is reference-counted, so serving a cache hit never copies the payload
    payload: Bytes,
    expires_at: Instant,
}

type InflightFetch = Shared<BoxFuture<'static, Result<Bytes, String>>>;

#[derive(Clone)]
struct ResourceCache {
    entries: Arc<RwLock<HashMap<String, CachedEntry>>>,
    // Identical concurrent requests share one kubectl process instead of spawning one each
    inflight: Arc<std::sync::Mutex<HashMap<String, InflightFetch>>>,
    // Bumped on every invalidation so a fetch that started before a mutation is not cached
    generation: Arc<AtomicU64>,
}

impl ResourceCache {
    fn new() -> Self {
        Self {
            entries: Arc::new(RwLock::new(HashMap::new())),
            inflight: Arc::new(std::sync::Mutex::new(HashMap::new())),
            generation: Arc::new(AtomicU64::new(0)),
        }
    }

    async fn get(&self, key: &str) -> Option<Bytes> {
        let now = Instant::now();
        let map = self.entries.read().await;
        if let Some(entry) = map.get(key) {
            if entry.expires_at > now {
                return Some(entry.payload.clone());
            }
        }
        None
    }

    async fn set(&self, key: String, payload: Bytes, ttl_secs: u64) {
        let now = Instant::now();
        let mut map = self.entries.write().await;
        if map.len() > 150 {
            map.retain(|_, v| v.expires_at > now);
        }
        map.insert(
            key,
            CachedEntry {
                payload,
                expires_at: now + std::time::Duration::from_secs(ttl_secs),
            },
        );
    }

    /// Returns the cached kubectl output for `key`, or runs kubectl once and shares the
    /// result with every request waiting on the same key. Errors are never cached.
    async fn fetch(&self, key: String, ttl_secs: u64, args: Vec<String>, ctx: String) -> Result<Bytes, String> {
        if let Some(hit) = self.get(&key).await {
            return Ok(hit);
        }

        let fut = {
            let mut inflight = self.inflight.lock().unwrap();
            if let Some(existing) = inflight.get(&key) {
                existing.clone()
            } else {
                let cache = self.clone();
                let k = key.clone();
                let started_gen = self.generation.load(Ordering::Acquire);
                let fut = async move {
                    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
                    let res = run_kubectl_cmd(&arg_refs, &ctx).await.map(Bytes::from);
                    if let Ok(ref bytes) = res {
                        if cache.generation.load(Ordering::Acquire) == started_gen {
                            cache.set(k.clone(), bytes.clone(), ttl_secs).await;
                        }
                    }
                    cache.inflight.lock().unwrap().remove(&k);
                    res
                }
                .boxed()
                .shared();
                inflight.insert(key, fut.clone());
                fut
            }
        };
        fut.await
    }

    fn bump_generation(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
    }

    async fn invalidate_prefix(&self, prefix: &str) {
        self.bump_generation();
        self.inflight.lock().unwrap().retain(|k, _| !k.starts_with(prefix));
        let mut map = self.entries.write().await;
        map.retain(|k, _| !k.starts_with(prefix));
    }

    async fn invalidate_all(&self) {
        self.bump_generation();
        self.inflight.lock().unwrap().clear();
        let mut map = self.entries.write().await;
        map.clear();
    }
}

fn json_response(body: Bytes) -> Response {
    ([(header::CONTENT_TYPE, "application/json")], body).into_response()
}

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
    // The initial `kubectl config current-context` lookup runs in the background so the
    // window can open immediately; handlers wait on it only if it hasn't finished yet.
    context_init: Arc<OnceCell<()>>,
    port_forwards: Arc<RwLock<HashMap<String, ActivePortForward>>>,
    cache: ResourceCache,
}

impl AppState {
    async fn ctx(&self) -> String {
        self.context_init
            .get_or_init(|| async {
                let detected = get_current_context().await;
                let mut lock = self.current_context.write().await;
                // A context switch may have landed first; don't overwrite it
                if lock.is_empty() {
                    *lock = detected;
                }
            })
            .await;
        self.current_context.read().await.clone()
    }
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
    // Timed-out commands and closed log streams must not leave kubectl processes behind
    cmd.kill_on_drop(true);
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
    let current_ctx = state.ctx().await;

    if let Some(cached) = state.cache.get("contexts").await {
        if let Ok(mut resp) = serde_json::from_slice::<ContextResponse>(&cached) {
            resp.current_context = current_ctx.clone();
            for c in &mut resp.contexts {
                c.is_active = c.name == current_ctx;
            }
            return Json(resp);
        }
    }

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

    let resp = ContextResponse {
        current_context: current_ctx,
        contexts,
    };

    if let Ok(json_str) = serde_json::to_string(&resp) {
        state.cache.set("contexts".to_string(), Bytes::from(json_str), 5).await;
    }

    Json(resp)
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
    state.cache.invalidate_all().await;

    Ok(Json(serde_json::json!({
        "success": true,
        "currentContext": payload.context
    })))
}

async fn handle_cluster_overview(
    Query(q): Query<ClusterOverviewQuery>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let current_ctx = state.ctx().await;
    let ctx_to_use = q.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current_ctx);
    let cache_key = format!("overview:{}", ctx_to_use);

    if let Some(cached) = state.cache.get(&cache_key).await {
        return json_response(cached);
    }

    // Run parallel async queries using tokio::join! with lightweight jsonpath
    let (nodes_res, pods_res, ns_res) = tokio::join!(
        run_kubectl_cmd(&["get", "nodes", "-o", "jsonpath={.items[*].metadata.name}"], ctx_to_use),
        run_kubectl_cmd(&["get", "pods", "-A", "-o", "jsonpath={.items[*].metadata.name}"], ctx_to_use),
        run_kubectl_cmd(&["get", "namespaces", "-o", "jsonpath={.items[*].metadata.name}"], ctx_to_use),
    );

    let nodes_count = nodes_res.ok().map(|s| s.split_whitespace().count()).unwrap_or(0);
    let pods_count = pods_res.ok().map(|s| s.split_whitespace().count()).unwrap_or(0);
    let ns_count = ns_res.ok().map(|s| s.split_whitespace().count()).unwrap_or(0);

    let payload = Bytes::from(serde_json::json!({
        "context": ctx_to_use,
        "nodesCount": nodes_count,
        "podsCount": pods_count,
        "namespacesCount": ns_count
    }).to_string());

    state.cache.set(cache_key, payload.clone(), 4).await;

    json_response(payload)
}

async fn handle_k8s_resource(
    Path(kind): Path<String>,
    Query(query): Query<ResourceQuery>,
    State(state): State<AppState>,
) -> Result<Response, (StatusCode, String)> {
    let current_ctx = state.ctx().await;
    let ctx_to_use = query.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current_ctx).to_string();
    let cache_key = format!("k8s:{}:{}:{}", ctx_to_use, kind, query.namespace.as_deref().unwrap_or("_all"));

    let mut args = vec!["get".to_string(), kind, "-o".to_string(), "json".to_string()];
    match query.namespace {
        Some(ns) if ns != "_all" => {
            args.push("-n".to_string());
            args.push(ns);
        }
        _ => args.push("-A".to_string()),
    }

    let out = state
        .cache
        .fetch(cache_key, 3, args, ctx_to_use)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(json_response(out))
}

async fn handle_get_manifest(
    Query(q): Query<ManifestQuery>,
    State(state): State<AppState>,
) -> Result<Response, (StatusCode, String)> {
    let current_ctx = state.ctx().await;
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
    let current_ctx = state.ctx().await;
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
        state.cache.invalidate_all().await;
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
    let current_ctx = state.ctx().await;
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

    state.cache.invalidate_prefix(&format!("k8s:{}:{}", ctx_to_use, req.kind)).await;
    state.cache.invalidate_prefix(&format!("overview:{}", ctx_to_use)).await;
    state.cache.invalidate_prefix(&format!("detail:{}:{}", ctx_to_use, req.kind)).await;

    Ok(Json(serde_json::json!({
        "success": true,
        "output": out
    })))
}

async fn handle_scale_resource(
    State(state): State<AppState>,
    Json(req): Json<ScaleRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let current_ctx = state.ctx().await;
    let ctx_to_use = req.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current_ctx);
    let target = format!("{}/{}", req.kind, req.name);
    let replicas_arg = format!("--replicas={}", req.replicas);
    let args = vec!["scale", &target, &replicas_arg, "-n", &req.namespace];

    let out = run_kubectl_cmd(&args, ctx_to_use)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    state.cache.invalidate_prefix(&format!("k8s:{}:{}", ctx_to_use, req.kind)).await;

    Ok(Json(serde_json::json!({
        "success": true,
        "output": out
    })))
}

async fn handle_restart_resource(
    State(state): State<AppState>,
    Json(req): Json<RestartRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let current_ctx = state.ctx().await;
    let ctx_to_use = req.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current_ctx);
    let target = format!("{}/{}", req.kind, req.name);
    let args = vec!["rollout", "restart", &target, "-n", &req.namespace];

    let out = run_kubectl_cmd(&args, ctx_to_use)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    state.cache.invalidate_prefix(&format!("k8s:{}:{}", ctx_to_use, req.kind)).await;
    state.cache.invalidate_prefix(&format!("k8s:{}:pods", ctx_to_use)).await;

    Ok(Json(serde_json::json!({
        "success": true,
        "output": out
    })))
}

async fn handle_pod_logs(
    Query(q): Query<LogsQuery>,
    State(state): State<AppState>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, (StatusCode, String)> {
    let current_ctx = state.ctx().await;
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
        // Owning the child here ties the kubectl process to the SSE connection:
        // when the client closes the log tab the stream is dropped and kubectl is killed.
        let _child = child;
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

async fn handle_resource_detail(
    Query(q): Query<ResourceDetailQuery>,
    State(state): State<AppState>,
) -> Result<Response, (StatusCode, String)> {
    let current_ctx = state.ctx().await;
    let ctx_to_use = q.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current_ctx).to_string();
    let cache_key = format!("detail:{}:{}:{}:{}", ctx_to_use, q.kind, q.namespace.as_deref().unwrap_or(""), q.name);

    let mut args = vec!["get".to_string(), q.kind, q.name, "-o".to_string(), "json".to_string()];
    if let Some(ns) = q.namespace {
        if !ns.is_empty() && ns != "_all" {
            args.push("-n".to_string());
            args.push(ns);
        }
    }

    let out = state
        .cache
        .fetch(cache_key, 5, args, ctx_to_use)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(json_response(out))
}

async fn handle_pod_events(
    Query(q): Query<PodEventsQuery>,
    State(state): State<AppState>,
) -> Result<Response, (StatusCode, String)> {
    let current_ctx = state.ctx().await;
    let ctx_to_use = q.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current_ctx).to_string();
    let cache_key = format!("events:{}:{}:{}", ctx_to_use, q.namespace, q.name);

    let args = vec![
        "get".to_string(),
        "events".to_string(),
        "--field-selector".to_string(),
        format!("involvedObject.name={}", q.name),
        "-n".to_string(),
        q.namespace,
        "-o".to_string(),
        "json".to_string(),
    ];

    let out = state
        .cache
        .fetch(cache_key, 3, args, ctx_to_use)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(json_response(out))
}

async fn handle_set_env(
    State(state): State<AppState>,
    Json(req): Json<SetEnvRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let current_ctx = state.ctx().await;
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

        state.cache.invalidate_prefix(&format!("k8s:{}:pods", ctx_to_use)).await;
        state.cache.invalidate_prefix(&format!("k8s:{}:deployment", ctx_to_use)).await;
        state.cache.invalidate_prefix(&format!("k8s:{}:replicaset", ctx_to_use)).await;
        state.cache.invalidate_prefix(&format!("detail:{}", ctx_to_use)).await;

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
        state.cache.invalidate_prefix(&format!("k8s:{}:pods", ctx_to_use)).await;
        state.cache.invalidate_prefix(&format!("detail:{}", ctx_to_use)).await;
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
    let current_ctx = state.ctx().await;
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

#[derive(rust_embed::RustEmbed)]
#[folder = "frontend/dist/"]
struct EmbeddedFrontend;

/// Optional on-disk UI override (FREELENS_STATIC_DIR), resolved once at startup.
/// Without it the UI is served from the assets compiled into the binary.
fn static_dir_override() -> Option<&'static PathBuf> {
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| {
        std::env::var("FREELENS_STATIC_DIR")
            .ok()
            .map(PathBuf::from)
            .filter(|p| p.join("index.html").is_file())
    })
    .as_ref()
}

fn asset_response(path: &str, body: Bytes) -> Response {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    // Vite emits content-hashed file names under assets/, so they can be cached forever;
    // everything else (index.html, logo) is revalidated so a new build is picked up.
    let cache = if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    (
        [
            (header::CONTENT_TYPE, mime.as_ref().to_string()),
            (header::CACHE_CONTROL, cache.to_string()),
        ],
        body,
    )
        .into_response()
}

async fn load_asset(path: &str) -> Option<Bytes> {
    if let Some(dir) = static_dir_override() {
        if let Ok(bytes) = tokio::fs::read(dir.join(path)).await {
            return Some(Bytes::from(bytes));
        }
    }
    EmbeddedFrontend::get(path).map(|f| match f.data {
        std::borrow::Cow::Borrowed(b) => Bytes::from_static(b),
        std::borrow::Cow::Owned(v) => Bytes::from(v),
    })
}

async fn static_handler(uri: axum::http::Uri) -> impl IntoResponse {
    let raw_path = uri.path().trim_start_matches('/');
    let path = if raw_path.is_empty() { "index.html" } else { raw_path };

    if let Some(bytes) = load_asset(path).await {
        return asset_response(path, bytes);
    }

    // Fallback to index.html for Single-Page Application (SPA) client routes
    if let Some(index) = load_asset("index.html").await {
        return asset_response("index.html", index);
    }

    (StatusCode::NOT_FOUND, "lensbyacp: UI assets not found").into_response()
}

/// Apps started from Finder / a Linux desktop launcher inherit a minimal PATH that lacks
/// Homebrew and user bin dirs, so kubectl and its auth plugins (gke-gcloud-auth-plugin,
/// kubelogin, aws, ...) would not be found. Append the usual install locations.
#[cfg(not(target_os = "windows"))]
fn extend_path_for_gui_launch() {
    let mut paths: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut extra = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        PathBuf::from("/snap/bin"),
    ];
    if let Some(h) = &home {
        extra.push(h.join(".local/bin"));
        extra.push(h.join("bin"));
        extra.push(h.join(".krew/bin"));
        extra.push(h.join("google-cloud-sdk/bin"));
    }
    for dir in extra {
        if dir.is_dir() && !paths.contains(&dir) {
            paths.push(dir);
        }
    }
    if let Ok(joined) = std::env::join_paths(paths) {
        std::env::set_var("PATH", joined);
    }
}

#[tokio::main]
async fn main() {
    #[cfg(not(target_os = "windows"))]
    extend_path_for_gui_launch();

    let state = AppState {
        current_context: Arc::new(RwLock::new(String::new())),
        context_init: Arc::new(OnceCell::new()),
        port_forwards: Arc::new(RwLock::new(HashMap::new())),
        cache: ResourceCache::new(),
    };

    // Resolve the active kube context in the background instead of blocking window startup
    {
        let state = state.clone();
        tokio::spawn(async move {
            let ctx = state.ctx().await;
            println!("☸️ Active Kubernetes Context: {}", ctx);
        });
    }

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

    match static_dir_override() {
        Some(dir) => println!("📁 Serving UI from: {:?}", dir),
        None => println!("📁 Serving UI from embedded assets"),
    }

    let app = Router::new()
        .nest("/api", api_router)
        .fallback(static_handler)
        .layer(cors);

    let base_port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(9090);

    // The API can read secrets and exec into the cluster, so only listen on loopback
    // unless explicitly asked to expose it (e.g. headless server mode on a remote box).
    let bind_ip: [u8; 4] = if std::env::var("FREELENS_BIND_ALL").is_ok() {
        [0, 0, 0, 0]
    } else {
        [127, 0, 0, 1]
    };

    // Try base_port, or find next available port up to +15
    let mut bound_listener = None;
    let mut active_port = base_port;

    for p in base_port..(base_port + 15) {
        let addr = SocketAddr::from((bind_ip, p));
        if let Ok(listener) = tokio::net::TcpListener::bind(addr).await {
            bound_listener = Some(listener);
            active_port = p;
            break;
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
    println!("🦀 lensbyacp Desktop running at {}", url);

    // Spawn high-speed Axum backend server in background Tokio task
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("❌ Axum server error: {}", e);
        }
    });

    let is_headless = std::env::var("FREELENS_HEADLESS").is_ok()
        || std::env::var("FREELENS_NO_BROWSER").is_ok()
        || std::env::args().any(|a| a == "--headless" || a == "-h" || a == "--server-only");

    if is_headless {
        println!("🖥️ Running in headless / server-only mode at {}", url);
        let _ = tokio::signal::ctrl_c().await;
        return;
    }

    // Launch native Tauri desktop application window. It opens on the bundled splash
    // screen and is pointed at the local server as soon as the window exists.
    tauri::Builder::default()
        .setup(move |app_handle| {
            use tauri::Manager;
            if let Some(win) = app_handle.get_webview_window("main") {
                let dev_url = std::env::var("TAURI_DEV_URL").ok();
                let target_url = dev_url.unwrap_or_else(|| format!("http://localhost:{}", active_port));
                if let Ok(parsed) = target_url.parse() {
                    let _ = win.navigate(parsed);
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running lensbyacp Tauri application");
}
