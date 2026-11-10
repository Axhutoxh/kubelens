//! Search logs across many pods at once: runs `kubectl logs --timestamps` per container in
//! parallel, keeps only matching lines while streaming (nothing else is held in memory) and
//! returns them merged by time.
//!
//! `POST /api/logs/search`

use crate::{create_kubectl_cmd, AppState};
use axum::{extract::State, http::StatusCode, Json};
use futures_util::StreamExt;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

const MAX_PODS: usize = 40;
const PARALLEL: usize = 8;
const MAX_MATCHES_PER_CONTAINER: usize = 1000;
const MAX_MATCHES: usize = 2000;
const MAX_LINE_CHARS: usize = 2000;
const CONTAINER_TIMEOUT_SECS: u64 = 45;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogSearchRequest {
    /// Namespace, or empty / "_all" for every namespace
    #[serde(default)]
    namespace: Option<String>,
    /// Pod name filter: `itam-*` style wildcard, or a plain substring
    #[serde(default)]
    pod_filter: String,
    /// Optional label selector instead of (or in addition to) the name filter
    #[serde(default)]
    selector: Option<String>,
    query: String,
    #[serde(default)]
    regex: bool,
    #[serde(default)]
    case_sensitive: bool,
    /// Time window such as 15m, 1h, 24h (default 1h)
    #[serde(default)]
    since: Option<String>,
    #[serde(default)]
    context: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LogMatch {
    ts: String,
    namespace: String,
    pod: String,
    container: String,
    line: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ContainerSummary {
    namespace: String,
    pod: String,
    container: String,
    matches: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// More matches than were kept for this container
    capped: bool,
}

type ApiError = (StatusCode, String);

fn bad(m: impl Into<String>) -> ApiError {
    (StatusCode::BAD_REQUEST, m.into())
}

/// `itam-*` / `*-worker` style wildcard (case-insensitive), or a substring when there is no `*`.
pub fn pod_matcher(filter: &str) -> Result<Box<dyn Fn(&str) -> bool + Send + Sync>, String> {
    let f = filter.trim().to_lowercase();
    if f.is_empty() {
        return Ok(Box::new(|_| true));
    }
    if !f.contains('*') {
        return Ok(Box::new(move |name| name.to_lowercase().contains(&f)));
    }
    let pattern = format!("^{}$", f.split('*').map(regex::escape).collect::<Vec<_>>().join(".*"));
    let re = Regex::new(&pattern).map_err(|e| e.to_string())?;
    Ok(Box::new(move |name| re.is_match(&name.to_lowercase())))
}

pub fn build_query(query: &str, regex: bool, case_sensitive: bool) -> Result<Regex, String> {
    if query.is_empty() {
        return Err("Enter text to search for.".into());
    }
    if query.len() > 500 {
        return Err("The search text is too long (500 characters max).".into());
    }
    let source = if regex { query.to_string() } else { regex::escape(query) };
    RegexBuilder::new(&source)
        .case_insensitive(!case_sensitive)
        .size_limit(1 << 20)
        .build()
        .map_err(|e| format!("Invalid regular expression: {e}"))
}

/// kubectl prints RFC3339Nano with trailing zeros trimmed ("…06.12Z", "…06.123456789Z"), which
/// doesn't sort as text. Pads the fraction to 9 digits so string order is time order.
pub fn sortable_ts(ts: &str) -> String {
    let Some(body) = ts.strip_suffix('Z') else { return ts.to_string() };
    match body.split_once('.') {
        Some((secs, frac)) => format!("{secs}.{frac:0<9}Z"),
        None => format!("{body}.000000000Z"),
    }
}

/// Splits a `kubectl logs --timestamps` line into (timestamp, message).
fn split_ts(line: &str) -> (&str, &str) {
    match line.split_once(' ') {
        Some((ts, rest)) if ts.len() >= 20 && ts.as_bytes()[4] == b'-' && ts.ends_with('Z') => (ts, rest),
        _ => ("", line),
    }
}

struct ContainerResult {
    summary: ContainerSummary,
    matches: Vec<LogMatch>,
}

async fn search_container(ctx: String, namespace: String, pod: String, container: String, since: String, re: Arc<Regex>) -> ContainerResult {
    let mut summary = ContainerSummary { namespace: namespace.clone(), pod: pod.clone(), container: container.clone(), matches: 0, error: None, capped: false };
    let mut matches = std::collections::VecDeque::new();

    let mut cmd = create_kubectl_cmd();
    if !ctx.is_empty() {
        cmd.arg("--context").arg(&ctx);
    }
    cmd.args(["logs", &pod, "-n", &namespace, "-c", &container, "--timestamps", &format!("--since={since}")]);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            summary.error = Some(format!("failed to start kubectl: {e}"));
            return ContainerResult { summary, matches: Vec::new() };
        }
    };
    let (Some(stdout), Some(mut stderr)) = (child.stdout.take(), child.stderr.take()) else {
        return ContainerResult { summary, matches: Vec::new() };
    };

    let scan = async {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let (ts, msg) = split_ts(&line);
            if !re.is_match(msg) {
                continue;
            }
            summary.matches += 1;
            if matches.len() >= MAX_MATCHES_PER_CONTAINER {
                // Keep the newest matches: drop the oldest
                matches.pop_front();
                summary.capped = true;
            }
            let text: String = if msg.chars().count() > MAX_LINE_CHARS { msg.chars().take(MAX_LINE_CHARS).chain("…".chars()).collect() } else { msg.to_string() };
            matches.push_back(LogMatch { ts: ts.to_string(), namespace: namespace.clone(), pod: pod.clone(), container: container.clone(), line: text });
        }
        let mut err = String::new();
        let _ = stderr.read_to_string(&mut err).await;
        err
    };
    match tokio::time::timeout(std::time::Duration::from_secs(CONTAINER_TIMEOUT_SECS), scan).await {
        Ok(err) => {
            let err = err.trim();
            if !err.is_empty() && summary.matches == 0 {
                summary.error = Some(err.lines().last().unwrap_or(err).to_string());
            }
        }
        Err(_) => summary.error = Some(format!("stopped after {CONTAINER_TIMEOUT_SECS}s; showing matches found so far")),
    }
    // kill_on_drop ends kubectl if it is still streaming
    drop(child);
    ContainerResult { summary, matches: matches.into() }
}

pub async fn handle_log_search(State(state): State<AppState>, Json(req): Json<LogSearchRequest>) -> Result<Json<Value>, ApiError> {
    let re = Arc::new(build_query(&req.query, req.regex, req.case_sensitive).map_err(bad)?);
    let since = req.since.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or("1h").to_string();
    let since_ok = since.len() <= 6 && since.len() > 1 && since.ends_with(['s', 'm', 'h']) && since[..since.len() - 1].chars().all(|c| c.is_ascii_digit());
    if !since_ok {
        return Err(bad(format!("Invalid time window '{since}' (use e.g. 15m, 1h, 24h)")));
    }
    let matches_pod = pod_matcher(&req.pod_filter).map_err(bad)?;
    let ns = req.namespace.as_deref().map(str::trim).filter(|n| !n.is_empty() && *n != "_all");
    if let Some(n) = ns {
        if !crate::valid_k8s_name(n) {
            return Err(bad(format!("Invalid namespace '{n}'")));
        }
    }
    let selector = req.selector.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if let Some(s) = selector {
        if s.starts_with('-') || s.len() > 300 || s.chars().any(|c| c.is_control() || c == ' ') {
            return Err(bad(format!("Invalid label selector '{s}'")));
        }
    }
    if ns.is_none() && req.pod_filter.trim().is_empty() && selector.is_none() {
        return Err(bad("Searching every namespace needs a pod name filter or a label selector."));
    }

    let current = state.ctx().await;
    let ctx = req.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current).to_string();

    let mut args = vec!["get".to_string(), "pods".to_string(), "-o".to_string(), "json".to_string()];
    match ns {
        Some(n) => args.extend(["-n".to_string(), n.to_string()]),
        None => args.push("-A".to_string()),
    }
    if let Some(s) = selector {
        args.extend(["-l".to_string(), s.to_string()]);
    }
    let key = format!("k8s:{ctx}:pods:{}{}", ns.unwrap_or("_all"), selector.map(|s| format!(":sel={s}")).unwrap_or_default());
    let raw = state.cache.fetch(key, 3, args, ctx.clone()).await.map_err(|e| (StatusCode::BAD_GATEWAY, e.trim().to_string()))?;
    let pods: Value = serde_json::from_slice(&raw).map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    // (namespace, pod, containers) of pods whose containers have started
    let mut targets: Vec<(String, String, Vec<String>)> = pods["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| !matches!(p["status"]["phase"].as_str(), Some("Pending") | Some("Unknown")))
        .filter_map(|p| {
            let name = p["metadata"]["name"].as_str()?;
            if !matches_pod(name) {
                return None;
            }
            let namespace = p["metadata"]["namespace"].as_str().unwrap_or("default");
            let containers: Vec<String> = p["spec"]["containers"].as_array()?.iter().filter_map(|c| c["name"].as_str().map(str::to_string)).collect();
            Some((namespace.to_string(), name.to_string(), containers))
        })
        .collect();
    targets.sort();
    let matched_pods = targets.len();
    targets.truncate(MAX_PODS);

    let jobs: Vec<_> = targets
        .iter()
        .flat_map(|(n, p, cs)| cs.iter().map(move |c| (n.clone(), p.clone(), c.clone())))
        .map(|(n, p, c)| search_container(ctx.clone(), n, p, c, since.clone(), re.clone()))
        .collect();
    let results: Vec<ContainerResult> = futures_util::stream::iter(jobs).buffer_unordered(PARALLEL).collect().await;

    let mut summaries = Vec::new();
    let mut all = Vec::new();
    let mut total = 0;
    for r in results {
        total += r.summary.matches;
        all.extend(r.matches);
        summaries.push(r.summary);
    }
    summaries.sort_by(|a, b| b.matches.cmp(&a.matches).then(a.pod.cmp(&b.pod)));
    all.sort_by_cached_key(|m| sortable_ts(&m.ts));
    let truncated = all.len() > MAX_MATCHES || summaries.iter().any(|s| s.capped);
    if all.len() > MAX_MATCHES {
        all.drain(..all.len() - MAX_MATCHES);
    }

    Ok(Json(json!({
        "matches": all,
        "totalMatches": total,
        "truncated": truncated,
        "containers": summaries,
        "podsSearched": targets.len(),
        "podsSkipped": matched_pods - targets.len(),
        "since": since,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pod_filters() {
        let m = pod_matcher("itam-*").unwrap();
        assert!(m("itam-alm-service-65bc7d9f8-x7k2p"));
        assert!(!m("api-itam-1"));
        let m = pod_matcher("*-worker-*").unwrap();
        assert!(m("billing-worker-7d9f8-x7k2p"));
        let m = pod_matcher("ALM").unwrap();
        assert!(m("itam-alm-service"));
        assert!(pod_matcher("").unwrap()("anything"));
        // Regex characters in a wildcard are literal
        assert!(!pod_matcher("a.c*").unwrap()("abc-1"));
    }

    #[test]
    fn queries() {
        assert!(build_query("NullPointerException", false, false).unwrap().is_match("java.lang.nullpointerexception at"));
        assert!(!build_query("Error", false, true).unwrap().is_match("error"));
        assert!(build_query("a.b", false, false).unwrap().is_match("a.b") && !build_query("a.b", false, false).unwrap().is_match("axb"));
        let re = build_query("time(out|d out)", true, false).unwrap();
        assert!(re.is_match("Timed out after 5s") && re.is_match("timeout") && !re.is_match("timer"));
        assert!(build_query("(", true, false).is_err());
        assert!(build_query("", false, false).is_err());
    }

    #[test]
    fn timestamps_sort_as_time() {
        let mut v = vec!["2026-11-10T13:05:06.1234Z", "2026-11-10T13:05:06.12345Z", "2026-11-10T13:05:06Z"];
        v.sort_by_key(|t| sortable_ts(t));
        assert_eq!(v, ["2026-11-10T13:05:06Z", "2026-11-10T13:05:06.1234Z", "2026-11-10T13:05:06.12345Z"]);
        assert_eq!(split_ts("2026-11-10T13:05:06.12Z hello world"), ("2026-11-10T13:05:06.12Z", "hello world"));
        assert_eq!(split_ts("no timestamp here"), ("", "no timestamp here"));
    }
}
