//! CPU / memory history per pod. metrics-server only knows the current value, so Kubellens
//! keeps samples in memory: every `kubectl top pods` the UI triggers is recorded, and while
//! someone has looked at a namespace's usage in the last 15 minutes a sampler adds a reading
//! every 30 s. Up to 3 hours per pod are kept; nothing is written to disk.
//!
//! `GET /api/metrics/history?namespace=&pods=a,b&context=`

use crate::{run_kubectl_cmd, AppState};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SAMPLE_EVERY: Duration = Duration::from_secs(30);
/// Recorded readings closer together than this are skipped
const MIN_GAP_SECS: i64 = 15;
const KEEP_SECS: i64 = 3 * 3600;
const INTEREST_FOR: Duration = Duration::from_secs(15 * 60);

type Key = (String, String, String); // context, namespace, pod
/// (unix seconds, CPU millicores, memory MiB)
type Sample = (i64, f64, f64);

#[derive(Default)]
struct Store {
    series: HashMap<Key, VecDeque<Sample>>,
    /// (context, namespace) -> last time someone asked for its history
    interest: HashMap<(String, String), Instant>,
}

fn store() -> &'static Mutex<Store> {
    static S: OnceLock<Mutex<Store>> = OnceLock::new();
    S.get_or_init(Default::default)
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// "250m" / "1" / "1500000n" -> millicores
pub fn cpu_millis(q: &str) -> Option<f64> {
    let (num, unit) = split_quantity(q)?;
    Some(match unit {
        "n" => num / 1e6,
        "u" => num / 1e3,
        "m" => num,
        "" => num * 1000.0,
        _ => return None,
    })
}

/// "512Mi" / "1Gi" / "2000Ki" / "1G" -> MiB
pub fn memory_mib(q: &str) -> Option<f64> {
    let (num, unit) = split_quantity(q)?;
    let bytes = match unit {
        "Ki" => num * 1024.0,
        "Mi" => num * 1024f64.powi(2),
        "Gi" => num * 1024f64.powi(3),
        "Ti" => num * 1024f64.powi(4),
        "k" => num * 1e3,
        "M" => num * 1e6,
        "G" => num * 1e9,
        "" => num,
        _ => return None,
    };
    Some(bytes / 1024f64.powi(2))
}

fn split_quantity(q: &str) -> Option<(f64, &str)> {
    let q = q.trim();
    let split = q.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(q.len());
    Some((q[..split].parse().ok()?, &q[split..]))
}

/// Records one `kubectl top pods` reading: (namespace, pod, cpu, memory) rows.
pub fn record<'a>(ctx: &str, rows: impl IntoIterator<Item = (&'a str, &'a str, &'a str, &'a str)>) {
    let t = now();
    let mut s = store().lock().unwrap();
    for (ns, pod, cpu, mem) in rows {
        let (Some(c), Some(m)) = (cpu_millis(cpu), memory_mib(mem)) else { continue };
        let series = s.series.entry((ctx.to_string(), ns.to_string(), pod.to_string())).or_default();
        if series.back().is_some_and(|(last, _, _)| t - last < MIN_GAP_SECS) {
            continue;
        }
        series.push_back((t, c, m));
        while series.front().is_some_and(|(ts, _, _)| t - ts > KEEP_SECS) {
            series.pop_front();
        }
    }
    // Forget pods that stopped reporting (deleted / replaced)
    s.series.retain(|_, v| v.back().is_some_and(|(ts, _, _)| t - ts <= KEEP_SECS));
}

/// Parses `kubectl top pods -n <ns> --no-headers` (NAME CPU MEMORY).
fn parse_top(ns: &str, text: &str) -> Vec<(String, String, String, String)> {
    text.lines()
        .filter_map(|l| {
            let c: Vec<&str> = l.split_whitespace().collect();
            (c.len() >= 3).then(|| (ns.to_string(), c[0].to_string(), c[1].to_string(), c[2].to_string()))
        })
        .collect()
}

/// Starts the background sampler once.
fn ensure_sampler() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        tokio::spawn(async {
            let mut tick = tokio::time::interval(SAMPLE_EVERY);
            loop {
                tick.tick().await;
                let targets: Vec<(String, String)> = {
                    let mut s = store().lock().unwrap();
                    s.interest.retain(|_, at| at.elapsed() < INTEREST_FOR);
                    s.interest.keys().cloned().collect()
                };
                for (ctx, ns) in targets {
                    if let Ok(out) = run_kubectl_cmd(&["top", "pods", "-n", &ns, "--no-headers"], &ctx).await {
                        let rows = parse_top(&ns, &out);
                        record(&ctx, rows.iter().map(|(a, b, c, d)| (a.as_str(), b.as_str(), c.as_str(), d.as_str())));
                    }
                }
            }
        });
    });
}

#[derive(Deserialize)]
pub struct HistoryQuery {
    namespace: String,
    /// Comma-separated pod names
    pods: String,
    #[serde(default)]
    context: Option<String>,
}

pub async fn handle_history(Query(q): Query<HistoryQuery>, State(state): State<AppState>) -> Result<Json<Value>, (StatusCode, String)> {
    if !crate::valid_k8s_name(&q.namespace) {
        return Err((StatusCode::BAD_REQUEST, "Invalid namespace".into()));
    }
    let current = state.ctx().await;
    let ctx = q.context.filter(|c| !c.is_empty()).unwrap_or(current);
    ensure_sampler();
    // Take a reading now too, so a first look isn't empty
    if let Ok(out) = run_kubectl_cmd(&["top", "pods", "-n", &q.namespace, "--no-headers"], &ctx).await {
        let rows = parse_top(&q.namespace, &out);
        record(&ctx, rows.iter().map(|(a, b, c, d)| (a.as_str(), b.as_str(), c.as_str(), d.as_str())));
    }
    let wanted: Vec<&str> = q.pods.split(',').map(str::trim).filter(|p| !p.is_empty()).take(100).collect();
    let mut s = store().lock().unwrap();
    s.interest.insert((ctx.clone(), q.namespace.clone()), Instant::now());
    let pods: serde_json::Map<String, Value> = wanted
        .iter()
        .map(|pod| {
            let series = s.series.get(&(ctx.clone(), q.namespace.clone(), pod.to_string()));
            let points: Vec<Value> = series.into_iter().flatten().map(|(t, c, m)| json!([t, (c * 10.0).round() / 10.0, (m * 10.0).round() / 10.0])).collect();
            (pod.to_string(), Value::Array(points))
        })
        .collect();
    Ok(Json(json!({ "pods": pods, "sampleEverySecs": SAMPLE_EVERY.as_secs(), "keepSecs": KEEP_SECS })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_quantities() {
        assert_eq!(cpu_millis("250m"), Some(250.0));
        assert_eq!(cpu_millis("2"), Some(2000.0));
        assert_eq!(cpu_millis("1500000n"), Some(1.5));
        assert_eq!(memory_mib("512Mi"), Some(512.0));
        assert_eq!(memory_mib("1Gi"), Some(1024.0));
        assert_eq!(memory_mib("2048Ki"), Some(2.0));
        assert!(cpu_millis("lots").is_none());
    }

    #[test]
    fn records_and_spaces_samples() {
        record("ctx-test", [("ns", "api-1", "100m", "256Mi")]);
        // A second reading right away is skipped (MIN_GAP_SECS)
        record("ctx-test", [("ns", "api-1", "900m", "999Mi")]);
        let s = store().lock().unwrap();
        let series = &s.series[&("ctx-test".to_string(), "ns".to_string(), "api-1".to_string())];
        assert_eq!(series.len(), 1);
        assert_eq!(series[0].1, 100.0);
        assert_eq!(parse_top("ns", "api-1   12m   80Mi\n").len(), 1);
    }
}
