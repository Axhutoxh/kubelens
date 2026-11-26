//! Port forwarding to pods, services, deployments and stateful sets (`kubectl port-forward`).
//!
//! A start request returns once kubectl is really forwarding. Each forward then has a
//! supervisor: when kubectl exits (the pod behind a service / deployment restarted, the
//! connection dropped) it starts kubectl again on the same local port, with backoff, until the
//! user stops the forward. Every forward is stopped when the app exits.
//!
//! `/api/port-forward/{start,stop,list,open}`

use crate::{create_kubectl_std_cmd, current_time_str, valid_k8s_name, AppState};
use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::RwLock;

pub type Forwards = Arc<RwLock<HashMap<String, ActivePortForward>>>;

/// How long kubectl gets to start forwarding (cloud auth plugins alone can take a few seconds)
const READY_SECS: u64 = 25;
/// Waits between reconnect attempts; the last one repeats
const RECONNECT_DELAYS: [u64; 6] = [1, 2, 5, 10, 20, 30];
/// Consecutive failed reconnects (about five minutes) before a forward is given up
const MAX_FAILED_RECONNECTS: u32 = 12;

type ApiError = (StatusCode, String);

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardSession {
    pub id: String,
    /// pod | service | deployment | statefulset
    pub kind: String,
    /// Target name (called `pod` for older clients)
    pub pod: String,
    pub namespace: String,
    /// Port on the target (container port, or service port)
    pub container_port: u16,
    pub local_port: u16,
    pub url: String,
    /// Active | Reconnecting
    pub status: String,
    pub started_at: String,
    pub context: String,
    /// Times kubectl was restarted after the connection dropped
    pub reconnects: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

pub struct ActivePortForward {
    session: Arc<Mutex<PortForwardSession>>,
    child: Arc<Mutex<Option<Child>>>,
    stopped: Arc<AtomicBool>,
}

impl ActivePortForward {
    fn snapshot(&self) -> PortForwardSession {
        self.session.lock().unwrap().clone()
    }

    fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(mut c) = self.child.lock().unwrap().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    /// pod (default) | service | deployment | statefulset
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    name: Option<String>,
    /// Older clients send the pod name here
    #[serde(default)]
    pod: Option<String>,
    namespace: String,
    container_port: u16,
    #[serde(default)]
    local_port: Option<u16>,
    #[serde(default)]
    context: Option<String>,
    /// Restart kubectl when the connection drops (default on)
    #[serde(default = "default_true")]
    reconnect: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Deserialize)]
pub struct IdRequest {
    id: String,
}

fn kubectl_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "pod" | "pods" => Some("pod"),
        "service" | "services" | "svc" => Some("service"),
        "deployment" | "deployments" => Some("deployment"),
        "statefulset" | "statefulsets" => Some("statefulset"),
        _ => None,
    }
}

/// Local port from a `kubectl port-forward` line such as
/// "Forwarding from 127.0.0.1:54321 -> 8080" or "Forwarding from [::1]:54321 -> 8080".
pub fn forwarded_local_port(line: &str) -> Option<u16> {
    let addr = line.trim().strip_prefix("Forwarding from ")?.split(" -> ").next()?;
    addr.rsplit(':').next()?.parse().ok()
}

/// True when nothing on this machine listens on `port` (IPv4 loopback).
pub fn local_port_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Port numbers browsers serve over TLS; everything else opens as http://
pub fn forward_scheme(port: u16) -> &'static str {
    if matches!(port, 443 | 8443 | 9443) { "https" } else { "http" }
}

/// Starts `kubectl port-forward` and waits until it forwards. Both pipes are read for the
/// whole life of the process: kubectl logs every connection, and a full pipe would stall it.
async fn spawn_forward(ctx: &str, target: &str, ns: &str, local_spec: &str, remote: u16) -> Result<(Child, u16), String> {
    let mut cmd = create_kubectl_std_cmd();
    if !ctx.is_empty() {
        cmd.arg("--context").arg(ctx);
    }
    // --address localhost: both 127.0.0.1 and ::1, so http://localhost works whichever the browser tries
    cmd.args(["port-forward", target, &format!("{local_spec}:{remote}"), "-n", ns, "--address", "localhost"]);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Failed to run kubectl port-forward: {e}"))?;
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        let _ = child.kill();
        return Err("kubectl port-forward has no output pipes".to_string());
    };

    enum Line {
        Ready(u16),
        Stderr(String),
    }
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Line>();
    let tx_out = tx.clone();
    std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(port) = forwarded_local_port(&line) {
                let _ = tx_out.send(Line::Ready(port));
            }
        }
    });
    std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = tx.send(Line::Stderr(line));
        }
    });

    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(READY_SECS);
    let mut errors: Vec<String> = Vec::new();
    let outcome = loop {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(Line::Ready(port))) => break Ok(port),
            Ok(Some(Line::Stderr(line))) => {
                if !line.trim().is_empty() {
                    errors.push(line.trim().to_string());
                }
            }
            // Both pipes closed: kubectl exited without forwarding
            Ok(None) => break Err(false),
            Err(_) => break Err(true),
        }
    };
    match outcome {
        Ok(port) => Ok((child, port)),
        Err(timed_out) => {
            let _ = child.kill();
            let _ = child.wait();
            let reason = errors
                .iter()
                .rev()
                .find(|l| l.starts_with("error") || l.starts_with("Error") || l.contains("unable to"))
                .or(errors.last())
                .cloned();
            Err(match (timed_out, reason) {
                (_, Some(r)) if r.contains("unable to listen") => {
                    format!("The local port is already in use. Pick another port, or leave it empty to use a free one. ({r})")
                }
                (true, r) => format!(
                    "kubectl didn't start forwarding within {READY_SECS}s (cluster unreachable or sign-in pending?){}",
                    r.map(|r| format!(": {r}")).unwrap_or_default()
                ),
                (false, Some(r)) => r,
                (false, None) => "kubectl port-forward exited without forwarding".to_string(),
            })
        }
    }
}

/// Watches one forward: restarts kubectl on the same local port whenever it exits, until the
/// forward is stopped or keeps failing; then removes it from the list.
fn supervise(forwards: Forwards, id: String, entry: (Arc<Mutex<PortForwardSession>>, Arc<Mutex<Option<Child>>>, Arc<AtomicBool>), target: String, reconnect: bool) {
    let (session, child, stopped) = entry;
    tokio::spawn(async move {
        let (ctx, ns, remote, local) = {
            let s = session.lock().unwrap();
            (s.context.clone(), s.namespace.clone(), s.container_port, s.local_port)
        };
        let mut failures = 0u32;
        loop {
            // Wait until kubectl exits, or the forward is stopped (child taken)
            let waiting = child.clone();
            let _ = tokio::task::spawn_blocking(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(1000));
                let mut guard = waiting.lock().unwrap();
                match guard.as_mut() {
                    None => return,
                    Some(c) => {
                        if let Ok(Some(_)) = c.try_wait() {
                            *guard = None;
                            return;
                        }
                    }
                }
            })
            .await;
            if stopped.load(Ordering::SeqCst) || !reconnect {
                break;
            }
            // kubectl resolves a service / deployment to a running pod again on every start
            session.lock().unwrap().status = "Reconnecting".to_string();
            let delay = RECONNECT_DELAYS[(failures as usize).min(RECONNECT_DELAYS.len() - 1)];
            tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
            if stopped.load(Ordering::SeqCst) {
                break;
            }
            match spawn_forward(&ctx, &target, &ns, &local.to_string(), remote).await {
                Ok((c, _)) => {
                    if stopped.load(Ordering::SeqCst) {
                        let mut c = c;
                        let _ = c.kill();
                        let _ = c.wait();
                        break;
                    }
                    *child.lock().unwrap() = Some(c);
                    let mut s = session.lock().unwrap();
                    s.status = "Active".to_string();
                    s.reconnects += 1;
                    s.last_error = None;
                    failures = 0;
                }
                Err(e) => {
                    failures += 1;
                    session.lock().unwrap().last_error = Some(e);
                    if failures >= MAX_FAILED_RECONNECTS {
                        break;
                    }
                }
            }
        }
        // Remove the entry only if it is still this forward (the id can be reused later)
        let mut map = forwards.write().await;
        if map.get(&id).is_some_and(|e| Arc::ptr_eq(&e.stopped, &stopped)) {
            map.remove(&id);
        }
    });
}

pub async fn handle_start(State(state): State<AppState>, Json(req): Json<StartRequest>) -> Result<Json<Value>, ApiError> {
    let bad = |m: &str| (StatusCode::BAD_REQUEST, m.to_string());
    let kind = kubectl_kind(req.kind.as_deref().unwrap_or("pod")).ok_or_else(|| bad("kind must be pod, service, deployment or statefulset"))?;
    let name = req.name.clone().or(req.pod.clone()).unwrap_or_default();
    if !valid_k8s_name(&name) || !valid_k8s_name(&req.namespace) {
        return Err(bad("Invalid name or namespace"));
    }
    if req.container_port == 0 {
        return Err(bad("The port must be between 1 and 65535"));
    }
    let current_ctx = state.ctx().await;
    let ctx = req.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current_ctx).to_string();

    // Local port: the one asked for; otherwise the target port when it is free and doesn't need
    // admin rights (< 1024 on macOS / Linux); otherwise kubectl picks a free one.
    let requested = req.local_port.filter(|p| *p > 0);
    let local_spec = {
        let map = state.port_forwards.read().await;
        let taken = |port: u16| map.values().map(|f| f.snapshot()).find(|s| s.local_port == port).map(|s| format!("{}/{}", s.namespace, s.pod));
        match requested {
            Some(p) => {
                if let Some(other) = taken(p) {
                    return Err((StatusCode::CONFLICT, format!("Local port {p} is already forwarding to {other}. Pick another port, or leave it empty to use a free one.")));
                }
                if !local_port_free(p) {
                    return Err((StatusCode::CONFLICT, format!("Local port {p} is already in use on this computer. Pick another port, or leave it empty to use a free one.")));
                }
                p.to_string()
            }
            None if req.container_port >= 1024 && taken(req.container_port).is_none() && local_port_free(req.container_port) => req.container_port.to_string(),
            None => String::new(),
        }
    };

    let target = format!("{kind}/{name}");
    let (child, local_port) = spawn_forward(&ctx, &target, &req.namespace, &local_spec, req.container_port)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    let id = format!("{}/{}/{}/{}:{}", req.namespace, kind, name, local_port, req.container_port);
    let session = PortForwardSession {
        id: id.clone(),
        kind: kind.to_string(),
        pod: name,
        namespace: req.namespace.clone(),
        container_port: req.container_port,
        local_port,
        url: format!("{}://localhost:{}", forward_scheme(req.container_port), local_port),
        status: "Active".to_string(),
        started_at: current_time_str(),
        context: ctx,
        reconnects: 0,
        last_error: None,
    };
    let entry = ActivePortForward {
        session: Arc::new(Mutex::new(session.clone())),
        child: Arc::new(Mutex::new(Some(child))),
        stopped: Arc::new(AtomicBool::new(false)),
    };
    let handles = (entry.session.clone(), entry.child.clone(), entry.stopped.clone());
    state.port_forwards.write().await.insert(id.clone(), entry);
    supervise(state.port_forwards.clone(), id, handles, target, req.reconnect);

    Ok(Json(json!({ "success": true, "session": session })))
}

pub async fn handle_stop(State(state): State<AppState>, Json(req): Json<IdRequest>) -> Result<Json<Value>, ApiError> {
    let entry = state.port_forwards.write().await.remove(&req.id).ok_or((StatusCode::NOT_FOUND, "Port forward session not found".to_string()))?;
    tokio::task::spawn_blocking(move || entry.stop()).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "success": true })))
}

pub async fn handle_list(State(state): State<AppState>) -> Json<Value> {
    let map = state.port_forwards.read().await;
    let mut list: Vec<PortForwardSession> = map.values().map(|f| f.snapshot()).collect();
    list.sort_by(|a, b| (&a.namespace, &a.pod, a.local_port).cmp(&(&b.namespace, &b.pod, b.local_port)));
    Json(json!({ "sessions": list }))
}

/// Opens an active forward's URL in the system browser (the app's webview ignores links that
/// ask for a new window). Only URLs of running forwards can be opened this way.
pub async fn handle_open(State(state): State<AppState>, Json(req): Json<IdRequest>) -> Result<Json<Value>, ApiError> {
    let url = state
        .port_forwards
        .read()
        .await
        .get(&req.id)
        .map(|f| f.snapshot().url)
        .ok_or((StatusCode::NOT_FOUND, "This port forward is no longer running".to_string()))?;
    crate::browser::open(&url).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(json!({ "success": true, "url": url })))
}

/// Stops every forward (app exit). Safe to call from a synchronous context.
pub fn stop_all(forwards: &Forwards) {
    if let Ok(map) = forwards.try_read() {
        for f in map.values() {
            f.stop();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_forwarded_local_port() {
        assert_eq!(forwarded_local_port("Forwarding from 127.0.0.1:54321 -> 8080"), Some(54321));
        assert_eq!(forwarded_local_port("Forwarding from [::1]:8080 -> 80"), Some(8080));
        assert_eq!(forwarded_local_port("Handling connection for 8080"), None);
        assert_eq!(forwarded_local_port("error: unable to forward port because pod is not running"), None);
    }

    #[test]
    fn picks_scheme_kind_and_detects_busy_ports() {
        assert_eq!(forward_scheme(443), "https");
        assert_eq!(forward_scheme(8080), "http");
        assert_eq!(kubectl_kind("svc"), Some("service"));
        assert_eq!(kubectl_kind("deployments"), Some("deployment"));
        assert_eq!(kubectl_kind("job"), None);
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(!local_port_free(port));
        drop(listener);
        assert!(local_port_free(port));
    }
}
