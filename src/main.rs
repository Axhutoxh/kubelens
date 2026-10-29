#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, Path, Query, State,
    },
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
    /// Logs of the previous (crashed / restarted) container instance
    previous: Option<String>,
    /// Relative window such as "15m" or "2h"
    since: Option<String>,
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

fn create_cli_cmd(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    // Timed-out commands and closed log streams must not leave child processes behind
    cmd.kill_on_drop(true);
    cmd
}

fn create_kubectl_cmd() -> Command {
    create_cli_cmd("kubectl")
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

/// Runs a cluster CLI (kubectl or helm) against `current_ctx` and returns stdout.
/// `context_flag` differs per tool: kubectl uses `--context`, helm `--kube-context`.
async fn run_cli(
    program: &str,
    context_flag: &str,
    args: &[&str],
    current_ctx: &str,
    timeout_secs: u64,
) -> Result<String, String> {
    let mut cmd = create_cli_cmd(program);
    if !current_ctx.is_empty() {
        cmd.arg(context_flag).arg(current_ctx);
    }
    cmd.args(args);

    let res = tokio::time::timeout(tokio::time::Duration::from_secs(timeout_secs), cmd.output()).await;
    match res {
        Ok(Ok(output)) => {
            if output.status.success() {
                Ok(String::from_utf8_lossy(&output.stdout).to_string())
            } else {
                Err(String::from_utf8_lossy(&output.stderr).to_string())
            }
        }
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(format!("`{}` was not found on PATH. Install it to use this feature.", program))
        }
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err(format!(
            "Command timed out after {}s (context: '{}'). Cluster may be unreachable or requires auth.",
            timeout_secs, current_ctx
        )),
    }
}

async fn run_kubectl_cmd(args: &[&str], current_ctx: &str) -> Result<String, String> {
    run_cli("kubectl", "--context", args, current_ctx, 15).await
}

async fn run_helm(args: &[&str], current_ctx: &str, timeout_secs: u64) -> Result<String, String> {
    run_cli("helm", "--kube-context", args, current_ctx, timeout_secs).await
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
    let previous = q.previous.as_deref() == Some("true");
    if previous {
        cmd.arg("--previous");
    } else if q.follow.as_deref() == Some("true") {
        // A terminated instance has nothing to follow
        cmd.arg("-f");
    }
    if let Some(since) = q.since.as_deref().filter(|s| !s.is_empty()) {
        let valid = since.len() <= 8
            && since.ends_with(['s', 'm', 'h'])
            && since[..since.len() - 1].chars().all(|c| c.is_ascii_digit())
            && since.len() > 1;
        if !valid {
            return Err((StatusCode::BAD_REQUEST, format!("Invalid since '{}' (use e.g. 15m, 2h)", since)));
        }
        cmd.arg(format!("--since={}", since));
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

    let stderr = child.stderr.take();
    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();

    let stream = async_stream::stream! {
        // Owning the child here ties the kubectl process to the SSE connection:
        // when the client closes the log tab the stream is dropped and kubectl is killed.
        let _child = child;
        while let Ok(Some(line)) = lines.next_line().await {
            yield Ok(Event::default().data(line));
        }
        // Surface kubectl's error (e.g. "previous terminated container not found")
        // instead of leaving the pane waiting forever
        if let Some(err) = stderr {
            let mut err_lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = err_lines.next_line().await {
                if !line.trim().is_empty() {
                    yield Ok(Event::default().data(format!("[kubellens] {}", line)));
                }
            }
        }
    };

    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(5))))
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

// ---------------------------------------------------------------------------
// Metrics (kubectl top). Requires metrics-server; reports `available: false` otherwise.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct MetricsQuery {
    namespace: Option<String>,
    context: Option<String>,
}

async fn handle_pod_metrics(
    Query(q): Query<MetricsQuery>,
    State(state): State<AppState>,
) -> Json<serde_json::Value> {
    let current_ctx = state.ctx().await;
    let ctx_to_use = q.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current_ctx).to_string();
    let ns = q.namespace.filter(|n| !n.is_empty() && n != "_all");
    let cache_key = format!("metrics:pods:{}:{}", ctx_to_use, ns.as_deref().unwrap_or("_all"));

    let mut args = vec!["top".to_string(), "pods".to_string(), "--no-headers".to_string()];
    match &ns {
        Some(n) => {
            args.push("-n".to_string());
            args.push(n.clone());
        }
        None => args.push("-A".to_string()),
    }

    match state.cache.fetch(cache_key, 10, args, ctx_to_use).await {
        Ok(out) => {
            let text = String::from_utf8_lossy(&out);
            let items: Vec<serde_json::Value> = text
                .lines()
                .filter_map(|line| {
                    let cols: Vec<&str> = line.split_whitespace().collect();
                    // -A adds a leading NAMESPACE column
                    let (namespace, rest) = match &ns {
                        Some(n) => (n.as_str(), &cols[..]),
                        None if cols.len() >= 4 => (cols[0], &cols[1..]),
                        None => return None,
                    };
                    if rest.len() < 3 {
                        return None;
                    }
                    Some(serde_json::json!({
                        "namespace": namespace,
                        "name": rest[0],
                        "cpu": rest[1],
                        "memory": rest[2],
                    }))
                })
                .collect();
            Json(serde_json::json!({ "available": true, "items": items }))
        }
        Err(e) => Json(serde_json::json!({ "available": false, "error": e.trim() })),
    }
}

async fn handle_node_metrics(
    Query(q): Query<MetricsQuery>,
    State(state): State<AppState>,
) -> Json<serde_json::Value> {
    let current_ctx = state.ctx().await;
    let ctx_to_use = q.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current_ctx).to_string();
    let cache_key = format!("metrics:nodes:{}", ctx_to_use);
    let args = vec!["top".to_string(), "nodes".to_string(), "--no-headers".to_string()];

    match state.cache.fetch(cache_key, 10, args, ctx_to_use).await {
        Ok(out) => {
            let text = String::from_utf8_lossy(&out);
            let items: Vec<serde_json::Value> = text
                .lines()
                .filter_map(|line| {
                    let c: Vec<&str> = line.split_whitespace().collect();
                    if c.len() < 5 {
                        return None;
                    }
                    let pct = |s: &str| s.trim_end_matches('%').parse::<f64>().ok();
                    Some(serde_json::json!({
                        "name": c[0],
                        "cpu": c[1],
                        "cpuPercent": pct(c[2]),
                        "memory": c[3],
                        "memoryPercent": pct(c[4]),
                    }))
                })
                .collect();
            Json(serde_json::json!({ "available": true, "items": items }))
        }
        Err(e) => Json(serde_json::json!({ "available": false, "error": e.trim() })),
    }
}

// ---------------------------------------------------------------------------
// Rollout undo (roll a Deployment back to a revision)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct RolloutUndoRequest {
    kind: String,
    name: String,
    namespace: String,
    revision: Option<i64>,
    context: Option<String>,
}

async fn handle_rollout_undo(
    State(state): State<AppState>,
    Json(req): Json<RolloutUndoRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let current_ctx = state.ctx().await;
    let ctx_to_use = req.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current_ctx);
    let target = format!("{}/{}", req.kind, req.name);
    let mut args = vec!["rollout".to_string(), "undo".to_string(), target, "-n".to_string(), req.namespace.clone()];
    if let Some(rev) = req.revision {
        args.push(format!("--to-revision={}", rev));
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();

    let out = run_kubectl_cmd(&arg_refs, ctx_to_use)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    state.cache.invalidate_prefix(&format!("k8s:{}:", ctx_to_use)).await;
    state.cache.invalidate_prefix(&format!("detail:{}", ctx_to_use)).await;

    Ok(Json(serde_json::json!({ "success": true, "output": out })))
}

// ---------------------------------------------------------------------------
// Set container images (one or many containers of a workload in a single rollout)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ContainerImage {
    container: String,
    image: String,
}

#[derive(Deserialize)]
struct SetImageRequest {
    kind: String,
    name: String,
    namespace: String,
    images: Vec<ContainerImage>,
    context: Option<String>,
}

async fn handle_set_image(
    State(state): State<AppState>,
    Json(req): Json<SetImageRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    if req.images.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "No images given".into()));
    }
    if req.images.iter().any(|i| i.container.is_empty() || i.image.trim().is_empty() || i.image.contains(char::is_whitespace)) {
        return Err((StatusCode::BAD_REQUEST, "Container names and images must be non-empty and contain no spaces".into()));
    }
    let current_ctx = state.ctx().await;
    let ctx_to_use = req.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current_ctx);
    let mut args = vec!["set".to_string(), "image".to_string(), format!("{}/{}", req.kind, req.name)];
    // All containers go in one command so the workload rolls out once, not once per container
    args.extend(req.images.iter().map(|i| format!("{}={}", i.container, i.image.trim())));
    args.extend(["-n".to_string(), req.namespace.clone()]);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();

    let out = run_kubectl_cmd(&arg_refs, ctx_to_use)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    state.cache.invalidate_prefix(&format!("k8s:{}:", ctx_to_use)).await;
    state.cache.invalidate_prefix(&format!("detail:{}", ctx_to_use)).await;

    Ok(Json(serde_json::json!({ "success": true, "output": out })))
}

// ---------------------------------------------------------------------------
// Save text to the user's Downloads folder. The desktop webview ignores
// `<a download>` links, so the UI hands exports (logs, …) to the backend instead.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct SaveFileRequest {
    filename: String,
    content: String,
}

// Only plain-text exports; a page that reaches the local API must not be able to drop executables
const SAVE_ALLOWED_EXTENSIONS: &[&str] = &["log", "txt", "yaml", "yml", "json", "env"];

async fn handle_save_file(
    Json(req): Json<SaveFileRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    // Keep only the base name and replace characters Windows / macOS / Linux reject
    let base = req.filename.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = base
        .chars()
        .map(|c| if c.is_control() || r#"<>:"|?*"#.contains(c) { '_' } else { c })
        .collect();
    let clean = clean.trim().trim_start_matches('.');
    let path = std::path::Path::new(clean);
    let stem = path.file_stem().and_then(|s| s.to_str()).filter(|s| !s.is_empty()).unwrap_or("export");
    let ext = path.extension().and_then(|s| s.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    if !SAVE_ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
        return Err((StatusCode::BAD_REQUEST, format!("Unsupported file type '.{}'", ext)));
    }

    let dir = dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, "Could not locate a Downloads folder".to_string()))?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Never overwrite: "name.log", "name (1).log", "name (2).log", …
    for n in 0..1000 {
        let file_name = if n == 0 { format!("{}.{}", stem, ext) } else { format!("{} ({}).{}", stem, n, ext) };
        let target = dir.join(file_name);
        match tokio::fs::OpenOptions::new().write(true).create_new(true).open(&target).await {
            Ok(mut f) => {
                f.write_all(req.content.as_bytes())
                    .await
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
                return Ok(Json(serde_json::json!({ "success": true, "path": target.to_string_lossy() })));
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
        }
    }
    Err((StatusCode::CONFLICT, "Too many files with that name in Downloads".into()))
}

// ---------------------------------------------------------------------------
// Ask for the user's attention (taskbar flash / dock bounce) when an alert fires
// while the window is in the background. No-op in headless mode.
// ---------------------------------------------------------------------------

static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

async fn handle_attention() -> Json<serde_json::Value> {
    use tauri::Manager;
    let flashed = APP_HANDLE
        .get()
        .and_then(|app| app.get_webview_window("main"))
        .filter(|win| !win.is_focused().unwrap_or(false))
        .map(|win| win.request_user_attention(Some(tauri::UserAttentionType::Informational)).is_ok())
        .unwrap_or(false);
    Json(serde_json::json!({ "success": true, "flashed": flashed }))
}

// ---------------------------------------------------------------------------
// Node maintenance: cordon / uncordon / drain
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct NodeActionRequest {
    node: String,
    action: String,
    #[serde(default)]
    force: bool,
    context: Option<String>,
}

async fn handle_node_action(
    State(state): State<AppState>,
    Json(req): Json<NodeActionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let current_ctx = state.ctx().await;
    let ctx_to_use = req.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current_ctx);

    let out = match req.action.as_str() {
        "cordon" | "uncordon" => run_kubectl_cmd(&[req.action.as_str(), &req.node], ctx_to_use).await,
        "drain" => {
            let mut args = vec![
                "drain",
                req.node.as_str(),
                "--ignore-daemonsets",
                "--delete-emptydir-data",
                "--timeout=110s",
            ];
            // --force also evicts pods without a controller; they will not be recreated
            if req.force {
                args.push("--force");
            }
            run_cli("kubectl", "--context", &args, ctx_to_use, 120).await
        }
        other => return Err((StatusCode::BAD_REQUEST, format!("Unknown node action '{}'", other))),
    }
    .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    state.cache.invalidate_prefix(&format!("k8s:{}:", ctx_to_use)).await;
    state.cache.invalidate_prefix(&format!("overview:{}", ctx_to_use)).await;

    Ok(Json(serde_json::json!({ "success": true, "output": out })))
}

// ---------------------------------------------------------------------------
// Helm releases (via the helm CLI)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct HelmListQuery {
    namespace: Option<String>,
    context: Option<String>,
}

async fn handle_helm_releases(
    Query(q): Query<HelmListQuery>,
    State(state): State<AppState>,
) -> Json<serde_json::Value> {
    let current_ctx = state.ctx().await;
    let ctx_to_use = q.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current_ctx);
    let ns = q.namespace.filter(|n| !n.is_empty() && n != "_all");

    // -a includes failed / pending releases, which are the ones people need to find
    let mut args = vec!["list", "-a", "-o", "json"];
    match &ns {
        Some(n) => {
            args.push("-n");
            args.push(n);
        }
        None => args.push("-A"),
    }

    match run_helm(&args, ctx_to_use, 30).await {
        Ok(out) => {
            let releases: serde_json::Value = serde_json::from_str(out.trim()).unwrap_or(serde_json::json!([]));
            Json(serde_json::json!({ "available": true, "releases": releases }))
        }
        Err(e) => Json(serde_json::json!({
            "available": false,
            "helmMissing": e.contains("was not found on PATH"),
            "error": e.trim(),
        })),
    }
}

#[derive(Deserialize)]
struct HelmReleaseQuery {
    name: String,
    namespace: String,
    what: String,
    all: Option<String>,
    context: Option<String>,
}

async fn handle_helm_release(
    Query(q): Query<HelmReleaseQuery>,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let current_ctx = state.ctx().await;
    let ctx_to_use = q.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current_ctx);

    let args: Vec<&str> = match q.what.as_str() {
        "values" if q.all.as_deref() == Some("true") => {
            vec!["get", "values", &q.name, "-n", &q.namespace, "--all", "-o", "yaml"]
        }
        "values" => vec!["get", "values", &q.name, "-n", &q.namespace, "-o", "yaml"],
        "manifest" => vec!["get", "manifest", &q.name, "-n", &q.namespace],
        "notes" => vec!["get", "notes", &q.name, "-n", &q.namespace],
        "history" => vec!["history", &q.name, "-n", &q.namespace, "-o", "json"],
        other => return Err((StatusCode::BAD_REQUEST, format!("Unknown helm view '{}'", other))),
    };

    let out = run_helm(&args, ctx_to_use, 30)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    if q.what == "history" {
        let parsed: serde_json::Value = serde_json::from_str(out.trim()).unwrap_or(serde_json::json!([]));
        return Ok(Json(serde_json::json!({ "history": parsed })));
    }
    Ok(Json(serde_json::json!({ "content": out })))
}

#[derive(Deserialize)]
struct HelmActionRequest {
    name: String,
    namespace: String,
    revision: Option<i64>,
    context: Option<String>,
}

async fn handle_helm_rollback(
    State(state): State<AppState>,
    Json(req): Json<HelmActionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let current_ctx = state.ctx().await;
    let ctx_to_use = req.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current_ctx);
    let rev = req.revision.map(|r| r.to_string()).unwrap_or_default();
    let mut args = vec!["rollback", req.name.as_str()];
    // helm treats an omitted revision as "previous release"
    if !rev.is_empty() {
        args.push(&rev);
    }
    args.push("-n");
    args.push(&req.namespace);

    let out = run_helm(&args, ctx_to_use, 300).await.map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    state.cache.invalidate_prefix(&format!("k8s:{}:", ctx_to_use)).await;
    Ok(Json(serde_json::json!({ "success": true, "output": out })))
}

async fn handle_helm_uninstall(
    State(state): State<AppState>,
    Json(req): Json<HelmActionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let current_ctx = state.ctx().await;
    let ctx_to_use = req.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current_ctx);
    let out = run_helm(&["uninstall", &req.name, "-n", &req.namespace], ctx_to_use, 300)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    state.cache.invalidate_prefix(&format!("k8s:{}:", ctx_to_use)).await;
    Ok(Json(serde_json::json!({ "success": true, "output": out })))
}

// ---------------------------------------------------------------------------
// Combined logs from several pods (or a label selector) in one SSE stream.
// One connection for N pods: browsers cap concurrent connections per host at ~6,
// so one EventSource per pod would starve the rest of the UI.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct MultiLogsQuery {
    /// Comma-separated `namespace/pod` pairs
    pods: Option<String>,
    /// Alternative to `pods`: label selector within `namespace`
    selector: Option<String>,
    namespace: Option<String>,
    tail: Option<String>,
    context: Option<String>,
}

type LineStream = std::pin::Pin<Box<dyn Stream<Item = String> + Send>>;

/// Streams stdout (and stderr, marked) of one `kubectl logs -f --prefix` process.
/// The child is owned by the stream, so dropping the stream kills kubectl.
fn kubectl_log_stream(args: Vec<String>, ctx: String) -> LineStream {
    Box::pin(async_stream::stream! {
        let mut cmd = create_kubectl_cmd();
        if !ctx.is_empty() {
            cmd.arg("--context").arg(&ctx);
        }
        cmd.args(&args);
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                yield format!("[kubellens] failed to start kubectl: {}", e);
                return;
            }
        };
        let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
            return;
        };
        let mut out = BufReader::new(stdout).lines();
        let mut err = BufReader::new(stderr).lines();
        let (mut out_done, mut err_done) = (false, false);

        while !(out_done && err_done) {
            let next = tokio::select! {
                l = out.next_line(), if !out_done => match l {
                    Ok(Some(line)) => Some(line),
                    _ => { out_done = true; None }
                },
                l = err.next_line(), if !err_done => match l {
                    Ok(Some(line)) => Some(format!("[kubellens] {}", line)),
                    _ => { err_done = true; None }
                },
            };
            if let Some(line) = next {
                yield line;
            }
        }
        drop(child);
    })
}

async fn handle_multi_logs(
    Query(q): Query<MultiLogsQuery>,
    State(state): State<AppState>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, (StatusCode, String)> {
    use futures_util::StreamExt;

    let current_ctx = state.ctx().await;
    let ctx_to_use = q.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current_ctx).to_string();
    let tail = format!("--tail={}", q.tail.as_deref().unwrap_or("100"));

    let mut streams: Vec<LineStream> = Vec::new();
    if let Some(selector) = q.selector.as_deref().filter(|s| !s.is_empty()) {
        let ns = q.namespace.clone().unwrap_or_else(|| "default".to_string());
        streams.push(kubectl_log_stream(
            vec![
                "logs".into(),
                "-f".into(),
                "-l".into(),
                selector.to_string(),
                "-n".into(),
                ns,
                "--prefix".into(),
                "--all-containers=true".into(),
                "--max-log-requests=30".into(),
                tail,
            ],
            ctx_to_use,
        ));
    } else {
        let targets: Vec<(String, String)> = q
            .pods
            .as_deref()
            .unwrap_or("")
            .split(',')
            .filter_map(|t| t.split_once('/').map(|(ns, p)| (ns.trim().to_string(), p.trim().to_string())))
            .filter(|(ns, p)| !ns.is_empty() && !p.is_empty())
            .take(30)
            .collect();
        if targets.is_empty() {
            return Err((StatusCode::BAD_REQUEST, "No pods selected".to_string()));
        }
        for (ns, pod) in targets {
            streams.push(kubectl_log_stream(
                vec![
                    "logs".into(),
                    "-f".into(),
                    pod,
                    "-n".into(),
                    ns,
                    "--prefix".into(),
                    "--all-containers=true".into(),
                    tail.clone(),
                ],
                ctx_to_use.clone(),
            ));
        }
    }

    let merged = futures_util::stream::select_all(streams).map(|line| Ok(Event::default().data(line)));
    Ok(Sse::new(merged).keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(5))))
}

// ---------------------------------------------------------------------------
// Interactive shell: `kubectl exec -it` inside a pseudo-terminal, bridged to a
// WebSocket. Binary frames carry terminal bytes both ways; text frames carry
// JSON control messages ({"resize": {"cols": .., "rows": ..}}).
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ExecQuery {
    pod: String,
    namespace: String,
    container: Option<String>,
    context: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
}

#[derive(Deserialize)]
struct ExecResize {
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
struct ExecControl {
    resize: Option<ExecResize>,
}

// Prefer bash when the image has it; distroless images without any shell report an error
const SHELL_BOOTSTRAP: &str =
    "export TERM=xterm-256color; if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi";

async fn handle_exec_ws(
    ws: WebSocketUpgrade,
    Query(q): Query<ExecQuery>,
    State(state): State<AppState>,
) -> Response {
    let current_ctx = state.ctx().await;
    let ctx = q.context.clone().filter(|c| !c.is_empty()).unwrap_or(current_ctx);
    ws.on_upgrade(move |socket| exec_session(socket, q, ctx))
}

async fn exec_session(mut socket: WebSocket, q: ExecQuery, ctx: String) {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::io::{Read, Write};

    let size = PtySize {
        rows: q.rows.unwrap_or(24).max(2),
        cols: q.cols.unwrap_or(80).max(10),
        pixel_width: 0,
        pixel_height: 0,
    };
    let mut cmd = CommandBuilder::new("kubectl");
    if !ctx.is_empty() {
        cmd.args(["--context", &ctx]);
    }
    cmd.args(["exec", "-it", &q.pod, "-n", &q.namespace]);
    if let Some(c) = q.container.as_deref().filter(|c| !c.is_empty()) {
        cmd.args(["-c", c]);
    }
    cmd.args(["--", "sh", "-c", SHELL_BOOTSTRAP]);

    // Every PTY call can block (ConPTY in particular), so none of them may run on an
    // async worker thread: a stuck worker can stall the whole server.
    let setup = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let pair = native_pty_system().openpty(size).map_err(|e| format!("Failed to open terminal: {}", e))?;
        let child = pair.slave.spawn_command(cmd).map_err(|e| format!("Failed to start kubectl exec: {}", e))?;
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        Ok((pair.master, child, reader, writer))
    })
    .await;

    let (master, mut child, mut reader, mut writer) = match setup {
        Ok(Ok(parts)) => parts,
        Ok(Err(e)) => {
            let _ = socket.send(Message::Text(format!("\r\n{}\r\n", e))).await;
            return;
        }
        Err(e) => {
            let _ = socket.send(Message::Text(format!("\r\nTerminal setup failed: {}\r\n", e))).await;
            return;
        }
    };
    let mut killer = child.clone_killer();
    let master = Arc::new(std::sync::Mutex::new(master));

    // PTY reads/writes are blocking, so they run on their own threads and talk to this
    // task through channels.
    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if out_tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let (in_tx, in_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        for data in in_rx {
            if writer.write_all(&data).is_err() || writer.flush().is_err() {
                break;
            }
        }
    });

    // On Windows (ConPTY) the reader doesn't reliably see EOF when the child exits,
    // so wait on the process itself and signal the session loop.
    let (exit_tx, mut exit_rx) = tokio::sync::oneshot::channel::<()>();
    std::thread::spawn(move || {
        let _ = child.wait();
        let _ = exit_tx.send(());
    });

    loop {
        tokio::select! {
            out = out_rx.recv() => match out {
                Some(bytes) => {
                    if socket.send(Message::Binary(bytes)).await.is_err() {
                        break;
                    }
                }
                None => break,
            },
            msg = socket.recv() => match msg {
                Some(Ok(Message::Binary(bytes))) => {
                    let _ = in_tx.send(bytes);
                }
                Some(Ok(Message::Text(text))) => {
                    if let Ok(ExecControl { resize: Some(r) }) = serde_json::from_str::<ExecControl>(&text) {
                        let master = master.clone();
                        tokio::task::spawn_blocking(move || {
                            if let Ok(m) = master.lock() {
                                let _ = m.resize(PtySize { rows: r.rows.max(2), cols: r.cols.max(10), pixel_width: 0, pixel_height: 0 });
                            }
                        });
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
            _ = &mut exit_rx => {
                // Give the reader a moment to deliver the shell's last output
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                while let Ok(bytes) = out_rx.try_recv() {
                    let _ = socket.send(Message::Binary(bytes)).await;
                }
                break;
            }
        }
    }

    let _ = socket.send(Message::Close(None)).await;
    // ConPTY opens with a cursor-position query (ESC[6n) and won't shut down until it is
    // answered. xterm.js answers it, but a session dropped within the first moments
    // never did, so answer it here; the session is being torn down anyway.
    let _ = in_tx.send(b"\x1b[1;1R".to_vec());
    drop(in_tx);
    // Keep draining PTY output while the console shuts down: ConPTY's close waits for
    // its output pipe to be read, and the reader thread needs a live receiver for that.
    tokio::spawn(async move { while out_rx.recv().await.is_some() {} });
    tokio::task::spawn_blocking(move || {
        let _ = killer.kill();
        drop(master);
    });
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
        .route("/metrics/pods", get(handle_pod_metrics))
        .route("/metrics/nodes", get(handle_node_metrics))
        .route("/k8s/rollout/undo", post(handle_rollout_undo))
        .route("/k8s/set-image", post(handle_set_image))
        // Log exports can be several MB; axum's default JSON limit is 2 MB
        .route("/files/save", post(handle_save_file).layer(DefaultBodyLimit::max(64 * 1024 * 1024)))
        .route("/node/action", post(handle_node_action))
        .route("/attention", post(handle_attention))
        .route("/helm/releases", get(handle_helm_releases))
        .route("/helm/release", get(handle_helm_release))
        .route("/helm/rollback", post(handle_helm_rollback))
        .route("/helm/uninstall", post(handle_helm_uninstall))
        .route("/k8s/logs/multi", get(handle_multi_logs))
        .route("/exec/ws", get(handle_exec_ws))
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
            let _ = APP_HANDLE.set(app_handle.handle().clone());
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
