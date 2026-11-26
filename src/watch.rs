//! Live updates. Instead of the UI re-listing resources on a timer, the backend keeps a
//! `kubectl get <kind> --watch-only` running per kind on screen and tells the UI (SSE) which
//! kinds changed, at most once a second each. The UI then reloads just those lists; the
//! cached copies are dropped first so the reload sees the change.
//!
//! `GET /api/watch?kinds=pods,deployments&namespace=&context=`

use crate::{create_kubectl_cmd, AppState};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::sse::{Event, KeepAlive, Sse},
};
use futures_util::{Stream, StreamExt};
use serde::Deserialize;
use std::collections::BTreeSet;
use std::convert::Infallible;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};

/// Kinds the UI may watch (the same names it lists with /api/k8s/:kind)
const WATCHABLE: &[&str] = &[
    "pods", "deployments", "statefulsets", "daemonsets", "jobs", "cronjobs", "services", "ingresses", "configmaps",
    "secrets", "events", "nodes", "namespaces", "persistentvolumeclaims", "persistentvolumes", "storageclasses",
];
const MAX_KINDS: usize = 6;
/// Cluster-scoped kinds are watched cluster-wide whatever namespace is selected
const CLUSTER_SCOPED: &[&str] = &["nodes", "namespaces", "persistentvolumes", "storageclasses"];

#[derive(Deserialize)]
pub struct WatchQuery {
    kinds: String,
    #[serde(default)]
    namespace: Option<String>,
    #[serde(default)]
    context: Option<String>,
}

/// Valid, de-duplicated kinds from "pods,deployments", or an error naming the bad one.
pub fn parse_kinds(raw: &str) -> Result<Vec<String>, String> {
    let mut kinds = BTreeSet::new();
    for k in raw.split(',').map(str::trim).filter(|k| !k.is_empty()) {
        if !WATCHABLE.contains(&k) {
            return Err(format!("Can't watch '{k}'"));
        }
        kinds.insert(k.to_string());
    }
    if kinds.is_empty() || kinds.len() > MAX_KINDS {
        return Err(format!("Watch between 1 and {MAX_KINDS} kinds"));
    }
    Ok(kinds.into_iter().collect())
}

/// What one kubectl watch reports
#[derive(Debug, PartialEq)]
enum Signal {
    /// The watch is running (cluster reachable and watching is allowed)
    Up,
    Changed(String),
    /// The watch stopped (cluster unreachable, no access, or the server closed it)
    Down,
}

/// Namespace flags for a kind
fn scope_args(kind: &str, ns: &Option<String>) -> Vec<String> {
    match (ns, CLUSTER_SCOPED.contains(&kind)) {
        (_, true) => Vec::new(),
        (Some(n), false) => vec!["-n".into(), n.clone()],
        (None, false) => vec!["-A".into()],
    }
}

/// One kubectl watch, restarted when it ends (the API server closes watches every few
/// minutes). Reports when it is up, every change, and when it drops. kubectl prints nothing
/// until something changes, so "up" is established first with `kubectl auth can-i watch`,
/// which answers quickly and fails when the cluster is unreachable.
fn watch_kind(kind: String, ns: Option<String>, ctx: String) -> std::pin::Pin<Box<dyn Stream<Item = Signal> + Send>> {
    Box::pin(async_stream::stream! {
        let mut failures = 0u32;
        loop {
            let scope = scope_args(&kind, &ns);
            let mut check: Vec<&str> = vec!["auth", "can-i", "watch", &kind];
            check.extend(scope.iter().map(String::as_str));
            let allowed = matches!(crate::run_kubectl_cmd(&check, &ctx).await, Ok(out) if out.trim() == "yes");
            let mut ran = false;
            if allowed {
                let mut cmd = create_kubectl_cmd();
                if !ctx.is_empty() {
                    cmd.arg("--context").arg(&ctx);
                }
                cmd.args(["get", &kind, "--watch-only", "-o", "name"]).args(&scope);
                cmd.stdout(Stdio::piped());
                cmd.stderr(Stdio::null());
                let Ok(mut child) = cmd.spawn() else { return };
                let Some(stdout) = child.stdout.take() else { return };
                ran = true;
                yield Signal::Up;
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if !line.trim().is_empty() {
                        yield Signal::Changed(kind.clone());
                    }
                }
                drop(child);
                yield Signal::Down;
            }
            // Unreachable or not allowed: retry slowly; a normal watch timeout restarts at once
            failures = if ran { 0 } else { failures + 1 };
            let wait = [1u64, 5, 15, 30, 60][(failures as usize).min(4)];
            tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
        }
    })
}

pub async fn handle_watch(
    Query(q): Query<WatchQuery>,
    State(state): State<AppState>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, (StatusCode, String)> {
    let kinds = parse_kinds(&q.kinds).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let ns = q.namespace.filter(|n| !n.is_empty() && n != "_all");
    if let Some(n) = &ns {
        if !crate::valid_k8s_name(n) {
            return Err((StatusCode::BAD_REQUEST, format!("Invalid namespace '{n}'")));
        }
    }
    let current = state.ctx().await;
    let ctx = q.context.filter(|c| !c.is_empty()).unwrap_or(current);
    let streams: Vec<_> = kinds.iter().map(|k| watch_kind(k.clone(), ns.clone(), ctx.clone())).collect();
    let mut changes = futures_util::stream::select_all(streams);

    let cache = state.cache.clone();
    let total = kinds.len();
    let stream = async_stream::stream! {
        let mut dirty: BTreeSet<String> = BTreeSet::new();
        let mut up = 0usize;
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
        loop {
            tokio::select! {
                signal = changes.next() => match signal {
                    Some(Signal::Changed(kind)) => { dirty.insert(kind); }
                    // "ready" once every watch is connected; "down" as soon as one drops, so the UI
                    // only relies on live updates (and slows its polling) while they really work
                    Some(Signal::Up) => {
                        up += 1;
                        if up == total {
                            yield Ok(Event::default().event("ready").data(kinds.join(",")));
                        }
                    }
                    Some(Signal::Down) => {
                        if up == total {
                            yield Ok(Event::default().event("down").data(""));
                        }
                        up = up.saturating_sub(1);
                    }
                    None => break,
                },
                _ = tick.tick() => {
                    if dirty.is_empty() {
                        continue;
                    }
                    for kind in &dirty {
                        cache.invalidate_prefix(&format!("k8s:{ctx}:{kind}")).await;
                    }
                    let list: Vec<String> = std::mem::take(&mut dirty).into_iter().collect();
                    yield Ok(Event::default().event("changed").data(list.join(",")));
                }
            }
        }
    };
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(15))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_kinds() {
        assert_eq!(parse_kinds("pods, deployments,pods").unwrap(), ["deployments", "pods"]);
        assert!(parse_kinds("pods,--all").is_err());
        assert!(parse_kinds("").is_err());
        assert!(parse_kinds("pods,deployments,statefulsets,daemonsets,jobs,cronjobs,services").is_err());
    }
}
