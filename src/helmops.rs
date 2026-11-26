//! Helm install / upgrade from chart repositories: list and add repositories, search charts
//! and versions, read a chart's default values, and run `helm upgrade --install` (optionally
//! as a dry run) with values the user edited. The UI shows a diff of the values first.
//!
//! `/api/helm/repos`, `/api/helm/search`, `/api/helm/versions`, `/api/helm/chart-values`, `/api/helm/upgrade`

use crate::{run_helm, AppState};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

type ApiError = (StatusCode, String);

const MAX_OUTPUT: usize = 400_000;

fn bad(m: impl Into<String>) -> ApiError {
    (StatusCode::BAD_REQUEST, m.into())
}

/// DNS-1123 release / repository names
pub fn valid_release(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty()
        && b.len() <= 53
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        && b[0].is_ascii_alphanumeric()
        && b[b.len() - 1].is_ascii_alphanumeric()
}

/// "repo/chart", or an OCI reference
pub fn valid_chart(chart: &str) -> bool {
    let body = chart.strip_prefix("oci://").unwrap_or(chart);
    !body.is_empty() && body.len() <= 250 && !chart.starts_with('-') && body.chars().all(|c| c.is_ascii_alphanumeric() || "._/-:".contains(c))
}

pub fn valid_version(v: &str) -> bool {
    !v.is_empty() && v.len() <= 64 && !v.starts_with('-') && v.chars().all(|c| c.is_ascii_alphanumeric() || ".+_-~^<>=* ,".contains(c))
}

fn json_or_empty(text: &str) -> Value {
    serde_json::from_str(text.trim()).unwrap_or(json!([]))
}

async fn ctx_of(state: &AppState, requested: Option<&str>) -> String {
    match requested.filter(|c| !c.is_empty()) {
        Some(c) => c.to_string(),
        None => state.ctx().await,
    }
}

pub async fn handle_repos(State(state): State<AppState>) -> Json<Value> {
    let ctx = state.ctx().await;
    match run_helm(&["repo", "list", "-o", "json"], &ctx, 30).await {
        Ok(out) => Json(json!({ "repos": json_or_empty(&out) })),
        // helm exits non-zero when no repositories are configured
        Err(e) if e.contains("no repositories") => Json(json!({ "repos": [] })),
        Err(e) => Json(json!({ "repos": [], "error": e.trim(), "helmMissing": e.contains("was not found on PATH") })),
    }
}

#[derive(Deserialize)]
pub struct AddRepoRequest {
    name: String,
    url: String,
}

pub async fn handle_add_repo(State(state): State<AppState>, Json(req): Json<AddRepoRequest>) -> Result<Json<Value>, ApiError> {
    let url = req.url.trim();
    if !valid_release(&req.name) {
        return Err(bad("A repository name has lower-case letters, digits and '-'"));
    }
    if !(url.starts_with("https://") || url.starts_with("http://")) || url.chars().any(char::is_whitespace) {
        return Err(bad("Enter the repository's http(s) URL"));
    }
    let ctx = state.ctx().await;
    let out = run_helm(&["repo", "add", &req.name, url, "--force-update"], &ctx, 120).await.map_err(|e| bad(e.trim().to_string()))?;
    Ok(Json(json!({ "success": true, "output": out.trim() })))
}

pub async fn handle_update_repos(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let ctx = state.ctx().await;
    let out = run_helm(&["repo", "update"], &ctx, 180).await.map_err(|e| bad(e.trim().to_string()))?;
    Ok(Json(json!({ "success": true, "output": out.trim() })))
}

#[derive(Deserialize)]
pub struct SearchQuery {
    #[serde(default)]
    q: String,
}

pub async fn handle_search(Query(q): Query<SearchQuery>, State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let term = q.q.trim();
    if term.starts_with('-') || term.len() > 100 || term.chars().any(|c| c.is_control()) {
        return Err(bad("Invalid search"));
    }
    let ctx = state.ctx().await;
    let mut args = vec!["search", "repo"];
    if !term.is_empty() {
        args.push(term);
    }
    args.extend(["-o", "json"]);
    let out = run_helm(&args, &ctx, 60).await.map_err(|e| bad(e.trim().to_string()))?;
    let mut charts = json_or_empty(&out);
    if let Some(list) = charts.as_array_mut() {
        list.truncate(200);
    }
    Ok(Json(json!({ "charts": charts })))
}

#[derive(Deserialize)]
pub struct ChartQuery {
    chart: String,
    #[serde(default)]
    version: Option<String>,
}

pub async fn handle_versions(Query(q): Query<ChartQuery>, State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    if !valid_chart(&q.chart) || q.chart.starts_with("oci://") {
        return Err(bad("Invalid chart"));
    }
    let ctx = state.ctx().await;
    // `helm search repo` matches by substring; keep the exact chart only
    let out = run_helm(&["search", "repo", &q.chart, "--versions", "-o", "json"], &ctx, 60).await.map_err(|e| bad(e.trim().to_string()))?;
    let versions: Vec<Value> = json_or_empty(&out)
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| v["name"] == q.chart.as_str())
        .take(100)
        .cloned()
        .collect();
    Ok(Json(json!({ "versions": versions })))
}

pub async fn handle_chart_values(Query(q): Query<ChartQuery>, State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    if !valid_chart(&q.chart) {
        return Err(bad("Invalid chart"));
    }
    let ctx = state.ctx().await;
    let mut args = vec!["show", "values", q.chart.as_str()];
    let version = q.version.as_deref().filter(|v| !v.is_empty());
    if let Some(v) = version {
        if !valid_version(v) {
            return Err(bad("Invalid version"));
        }
        args.extend(["--version", v]);
    }
    let out = run_helm(&args, &ctx, 120).await.map_err(|e| bad(e.trim().to_string()))?;
    Ok(Json(json!({ "values": out })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeRequest {
    release: String,
    namespace: String,
    chart: String,
    #[serde(default)]
    version: Option<String>,
    /// values.yaml text (may be empty)
    #[serde(default)]
    values: String,
    /// Install when the release doesn't exist yet
    #[serde(default)]
    install: bool,
    #[serde(default)]
    create_namespace: bool,
    #[serde(default)]
    dry_run: bool,
    #[serde(default)]
    context: Option<String>,
}

pub async fn handle_upgrade(State(state): State<AppState>, Json(req): Json<UpgradeRequest>) -> Result<Json<Value>, ApiError> {
    if !valid_release(&req.release) {
        return Err(bad("A release name has lower-case letters, digits and '-' (up to 53)"));
    }
    if !crate::valid_k8s_name(&req.namespace) {
        return Err(bad("Invalid namespace"));
    }
    if !valid_chart(&req.chart) {
        return Err(bad("Invalid chart"));
    }
    let version = req.version.as_deref().map(str::trim).filter(|v| !v.is_empty());
    if let Some(v) = version {
        if !valid_version(v) {
            return Err(bad("Invalid version"));
        }
    }
    let ctx = ctx_of(&state, req.context.as_deref()).await;

    // Values go through a private temp file, never the command line
    let file = std::env::temp_dir().join(format!("kubellens-values-{}-{}.yaml", std::process::id(), crate::current_unix_nanos()));
    tokio::fs::write(&file, req.values.as_bytes()).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let file_arg = file.to_string_lossy().to_string();
    let mut args = vec!["upgrade", req.release.as_str(), req.chart.as_str(), "-n", req.namespace.as_str(), "-f", file_arg.as_str()];
    if req.install {
        args.push("--install");
    }
    if let Some(v) = version {
        args.extend(["--version", v]);
    }
    if req.create_namespace {
        args.push("--create-namespace");
    }
    if req.dry_run {
        args.push("--dry-run");
    }
    let result = run_helm(&args, &ctx, 600).await;
    let _ = tokio::fs::remove_file(&file).await;
    let mut out = result.map_err(|e| bad(e.trim().to_string()))?;
    if out.len() > MAX_OUTPUT {
        out.truncate(MAX_OUTPUT);
        out.push_str("\n… (output truncated)");
    }
    if !req.dry_run {
        state.cache.invalidate_prefix(&format!("k8s:{ctx}:")).await;
    }
    Ok(Json(json!({ "success": true, "dryRun": req.dry_run, "output": out })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_helm_arguments() {
        assert!(valid_release("ingress-nginx"));
        assert!(!valid_release("Ingress"));
        assert!(!valid_release("-x"));
        assert!(!valid_release("a-"));
        assert!(valid_chart("bitnami/redis"));
        assert!(valid_chart("oci://registry-1.docker.io/bitnamicharts/redis"));
        assert!(!valid_chart("--set=x"));
        assert!(!valid_chart("repo/chart; rm"));
        assert!(valid_version("18.6.1"));
        assert!(valid_version(">=1.0.0 <2.0.0"));
        assert!(!valid_version("--devel"));
    }
}
