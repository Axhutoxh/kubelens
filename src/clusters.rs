//! Health of every kubeconfig context on one page: nodes ready, failing / pending pods and
//! warning events in the last hour. Clusters are checked in parallel and an unreachable one
//! only marks its own card.
//!
//! `GET /api/clusters/health`

use crate::{run_cli, AppState};
use axum::{extract::State, Json};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_CLUSTERS: usize = 30;
const PARALLEL: usize = 6;
const TIMEOUT_SECS: u64 = 20;

/// Waiting reasons that don't fix themselves
const BAD_WAITING: &[&str] = &["CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "InvalidImageName", "CreateContainerConfigError", "CreateContainerError", "RunContainerError"];

#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PodCounts {
    total: usize,
    running: usize,
    pending: usize,
    failing: usize,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    namespace: String,
    pod: String,
    reason: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClusterHealth {
    context: String,
    reachable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    nodes_total: usize,
    nodes_ready: usize,
    /// e.g. "nodes is forbidden" for namespace-scoped users
    #[serde(skip_serializing_if = "Option::is_none")]
    nodes_error: Option<String>,
    pods: PodCounts,
    warnings_last_hour: Option<usize>,
    problems: Vec<Problem>,
    took_ms: u128,
}

/// Parses `NS NAME PHASE WAITING-REASONS` custom-columns rows.
pub fn pod_counts(text: &str) -> (PodCounts, Vec<Problem>) {
    let mut c = PodCounts::default();
    let mut problems = Vec::new();
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 3 {
            continue;
        }
        c.total += 1;
        let phase = cols[2];
        // Several containers' reasons come comma-separated; "<none>" when nothing waits
        let waiting = cols.get(3).copied().unwrap_or("<none>");
        let bad = waiting.split(',').find(|r| BAD_WAITING.contains(r));
        if let Some(reason) = bad.or(if phase == "Failed" { Some("Failed") } else { None }) {
            c.failing += 1;
            problems.push(Problem { namespace: cols[0].into(), pod: cols[1].into(), reason: reason.into() });
        } else if phase == "Pending" {
            c.pending += 1;
        } else if phase == "Running" {
            c.running += 1;
        }
    }
    (c, problems)
}

/// Counts warning events whose last occurrence is within `window` seconds of `now`.
pub fn recent_warnings(text: &str, now: i64, window: i64) -> usize {
    text.lines()
        .filter_map(|l| l.split_whitespace().find(|t| t.len() >= 20 && t.ends_with('Z')))
        .filter_map(parse_rfc3339)
        .filter(|t| now - t <= window)
        .count()
}

/// Seconds since the epoch for `YYYY-MM-DDTHH:MM:SS[.frac]Z`.
fn parse_rfc3339(t: &str) -> Option<i64> {
    let b = t.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[10] != b'T' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| t.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, s) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    // Days from civil (Howard Hinnant's algorithm)
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + h * 3600 + mi * 60 + s)
}

async fn check(ctx: String) -> ClusterHealth {
    let started = std::time::Instant::now();
    let nodes_args = ["get", "nodes", "--no-headers", "-o", r#"custom-columns=NAME:.metadata.name,READY:.status.conditions[?(@.type=="Ready")].status"#];
    let pods_args = ["get", "pods", "-A", "--no-headers", "-o", "custom-columns=NS:.metadata.namespace,NAME:.metadata.name,PHASE:.status.phase,WAIT:.status.containerStatuses[*].state.waiting.reason"];
    let events_args = ["get", "events", "-A", "--field-selector", "type=Warning", "--no-headers", "-o", "custom-columns=LAST:.lastTimestamp,TIME:.eventTime"];
    let (nodes, pods, events) = tokio::join!(
        run_cli("kubectl", "--context", &nodes_args, &ctx, TIMEOUT_SECS),
        run_cli("kubectl", "--context", &pods_args, &ctx, TIMEOUT_SECS),
        run_cli("kubectl", "--context", &events_args, &ctx, TIMEOUT_SECS),
    );
    // First meaningful line of kubectl's error (auth plugins can be chatty)
    let first_line = |e: &str| -> String { e.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("unreachable").chars().take(300).collect() };
    let mut h = ClusterHealth { context: ctx, reachable: false, error: None, nodes_total: 0, nodes_ready: 0, nodes_error: None, pods: PodCounts::default(), warnings_last_hour: None, problems: Vec::new(), took_ms: 0 };
    match &pods {
        Ok(p) => {
            h.reachable = true;
            let (counts, mut problems) = pod_counts(p);
            problems.truncate(8);
            h.pods = counts;
            h.problems = problems;
        }
        Err(e) => h.error = Some(first_line(e)),
    }
    // Namespace-scoped users often can't list nodes; that doesn't make the cluster unreachable
    match &nodes {
        Ok(n) => {
            h.reachable = true;
            for line in n.lines() {
                let cols: Vec<&str> = line.split_whitespace().collect();
                if cols.is_empty() {
                    continue;
                }
                h.nodes_total += 1;
                if cols.get(1) == Some(&"True") {
                    h.nodes_ready += 1;
                }
            }
        }
        Err(e) => h.nodes_error = Some(first_line(e)),
    }
    if let Ok(ev) = &events {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
        h.warnings_last_hour = Some(recent_warnings(ev, now, 3600));
    }
    h.took_ms = started.elapsed().as_millis();
    h
}

pub async fn handle_clusters_health(State(state): State<AppState>) -> Json<Value> {
    let current = state.ctx().await;
    let names = run_cli("kubectl", "--context", &["config", "get-contexts", "-o", "name"], "", 10).await.unwrap_or_default();
    let mut contexts: Vec<String> = names.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect();
    let total = contexts.len();
    contexts.truncate(MAX_CLUSTERS);
    let mut results: Vec<ClusterHealth> = futures_util::stream::iter(contexts.into_iter().map(check)).buffer_unordered(PARALLEL).collect().await;
    // Current cluster first, then the ones with problems, then by name
    results.sort_by(|a, b| {
        (b.context == current)
            .cmp(&(a.context == current))
            .then((b.pods.failing > 0 || !b.reachable).cmp(&(a.pods.failing > 0 || !a.reachable)))
            .then(a.context.cmp(&b.context))
    });
    Json(json!({ "clusters": results, "current": current, "skipped": total.saturating_sub(MAX_CLUSTERS) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_pods() {
        let text = "\
team   api-1        Running   <none>
team   api-2        Running   CrashLoopBackOff
team   worker-1     Pending   ContainerCreating
team   job-1        Failed    <none>
team   job-2        Succeeded <none>
web    web-1        Running   <none>,ImagePullBackOff
";
        let (c, problems) = pod_counts(text);
        // web-1 is Running but can't pull an image for one container: failing, not running
        assert_eq!(c, PodCounts { total: 6, running: 1, pending: 1, failing: 3 });
        assert_eq!(problems.iter().map(|p| p.reason.as_str()).collect::<Vec<_>>(), ["CrashLoopBackOff", "Failed", "ImagePullBackOff"]);
    }

    #[test]
    fn parses_times_and_windows() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339("2026-11-10T13:05:06Z"), Some(1_794_315_906));
        assert_eq!(parse_rfc3339("2026-11-10T13:05:06.123456Z"), Some(1_794_315_906));
        assert_eq!(parse_rfc3339("<none>"), None);
        let now = 1_794_315_906;
        let text = "2026-11-10T13:00:00Z   <none>\n2026-11-10T11:00:00Z   <none>\n<none>   2026-11-10T12:30:00.000000Z\n";
        assert_eq!(recent_warnings(text, now, 3600), 2);
    }
}
