//! Search every kubeconfig context at once for pods, workloads, services, ingresses,
//! ConfigMaps and Secrets by name, or for workloads by image. Each cluster's index (names and
//! images only, never Secret data) is one kubectl call, cached for a minute.
//!
//! `GET /api/search/clusters?q=`

use crate::{run_cli, AppState};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const KINDS: &str = "pods,deployments,statefulsets,daemonsets,cronjobs,services,ingresses,configmaps,secrets";
const MAX_CLUSTERS: usize = 30;
const PARALLEL: usize = 6;
const MAX_HITS_PER_CLUSTER: usize = 200;
const INDEX_TTL_SECS: u64 = 60;

#[derive(Deserialize)]
pub struct SearchQuery {
    q: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Hit {
    kind: String,
    namespace: String,
    name: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    images: Vec<String>,
    /// "name" or "image"
    matched: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClusterHits {
    context: String,
    hits: Vec<Hit>,
    total: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Rows of `KIND NS NAME IMAGES TEMPLATE-IMAGES` custom columns matching `q` (case-insensitive).
pub fn match_rows(text: &str, q: &str) -> (Vec<Hit>, usize) {
    let q = q.to_lowercase();
    let mut hits = Vec::new();
    let mut total = 0;
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 3 {
            continue;
        }
        let images: Vec<String> = cols[3..]
            .iter()
            .flat_map(|c| c.split(','))
            .filter(|i| *i != "<none>" && !i.is_empty())
            .map(str::to_string)
            .collect();
        let matched = if cols[2].to_lowercase().contains(&q) {
            "name"
        } else if images.iter().any(|i| i.to_lowercase().contains(&q)) {
            "image"
        } else {
            continue;
        };
        total += 1;
        if hits.len() < MAX_HITS_PER_CLUSTER {
            hits.push(Hit { kind: cols[0].to_string(), namespace: cols[1].to_string(), name: cols[2].to_string(), images, matched });
        }
    }
    (hits, total)
}

async fn search_cluster(state: AppState, ctx: String, q: String) -> ClusterHits {
    let key = format!("search-index:{ctx}");
    let index = match state.cache.get(&key).await {
        Some(b) => Ok(String::from_utf8_lossy(&b).to_string()),
        None => {
            let args = [
                "get", KINDS, "-A", "--no-headers", "-o",
                "custom-columns=KIND:.kind,NS:.metadata.namespace,NAME:.metadata.name,IMAGES:.spec.containers[*].image,TEMPLATE:.spec.template.spec.containers[*].image",
            ];
            let r = run_cli("kubectl", "--context", &args, &ctx, 30).await;
            if let Ok(text) = &r {
                state.cache.set(key, axum::body::Bytes::from(text.clone()), INDEX_TTL_SECS).await;
            }
            r
        }
    };
    match index {
        Ok(text) => {
            let (hits, total) = match_rows(&text, &q);
            ClusterHits { context: ctx, hits, total, error: None }
        }
        Err(e) => ClusterHits {
            context: ctx,
            hits: Vec::new(),
            total: 0,
            error: Some(e.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("unreachable").chars().take(300).collect()),
        },
    }
}

pub async fn handle_search(Query(q): Query<SearchQuery>, State(state): State<AppState>) -> Result<Json<Value>, (StatusCode, String)> {
    let term = q.q.trim().to_string();
    if term.len() < 2 || term.len() > 200 {
        return Err((StatusCode::BAD_REQUEST, "Type at least 2 characters".into()));
    }
    let names = run_cli("kubectl", "--context", &["config", "get-contexts", "-o", "name"], "", 10).await.unwrap_or_default();
    let mut contexts: Vec<String> = names.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect();
    let skipped = contexts.len().saturating_sub(MAX_CLUSTERS);
    contexts.truncate(MAX_CLUSTERS);
    let mut results: Vec<ClusterHits> = futures_util::stream::iter(contexts.into_iter().map(|c| search_cluster(state.clone(), c, term.clone())))
        .buffer_unordered(PARALLEL)
        .collect()
        .await;
    results.sort_by(|a, b| b.total.cmp(&a.total).then(a.context.cmp(&b.context)));
    Ok(Json(json!({ "clusters": results, "skipped": skipped })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_names_and_images() {
        let text = "\
Pod          team   api-7d9f8-x7k2p     repo/api:1.4,envoy:1.29   <none>
Deployment   team   api                 <none>                    repo/api:1.4
ConfigMap    team   api-config          <none>                    <none>
Secret       team   db-credentials      <none>                    <none>
Service      web    frontend            <none>                    <none>
";
        let (hits, total) = match_rows(text, "API");
        assert_eq!(total, 3);
        assert_eq!(hits[1].images, ["repo/api:1.4"]);
        let (hits, _) = match_rows(text, "envoy");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].matched, "image");
        assert_eq!(match_rows(text, "nothing-like-this").1, 0);
    }
}
