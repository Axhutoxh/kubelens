//! Kubeconfig management: list contexts (credentials are never returned), rename, set the
//! default namespace, delete, import / merge another kubeconfig file, and fetch credentials
//! from AKS, EKS and GKE with their CLIs. Every change to the file is preceded by a backup
//! next to it (`config.kubellens-backup-<time>`).
//!
//! `/api/kubeconfig`, `/api/kubeconfig/{rename,namespace,delete,import}`, `/api/kubeconfig/cloud/{list,connect}`

use crate::{create_kubectl_cmd, run_cli, AppState};
use axum::{extract::State, http::StatusCode, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;

type ApiError = (StatusCode, String);

fn bad(m: impl Into<String>) -> ApiError {
    (StatusCode::BAD_REQUEST, m.into())
}

/// The file kubectl writes to: the first entry of KUBECONFIG, else ~/.kube/config.
pub fn primary_path() -> Option<PathBuf> {
    let sep = if cfg!(windows) { ';' } else { ':' };
    std::env::var("KUBECONFIG")
        .ok()
        .and_then(|v| v.split(sep).map(str::trim).find(|p| !p.is_empty()).map(PathBuf::from))
        .or_else(|| dirs::home_dir().map(|h| h.join(".kube").join("config")))
}

/// Context names come from kubeconfig files and may contain ':', '/', '@' (EKS ARNs, AKS
/// users); only reject what could be read as a flag or break the command.
pub fn valid_context(name: &str) -> bool {
    !name.is_empty() && name.len() <= 253 && !name.starts_with('-') && !name.chars().any(|c| c.is_control() || c.is_whitespace())
}

/// Cloud resource names, groups, regions and projects
pub fn valid_cloud_arg(v: &str) -> bool {
    !v.is_empty() && v.len() <= 100 && !v.starts_with('-') && v.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

async fn view(kubeconfig: Option<&str>) -> Result<Value, String> {
    let mut args = vec!["config", "view", "-o", "json"];
    if let Some(k) = kubeconfig {
        args.extend(["--kubeconfig", k]);
    }
    let out = run_cli("kubectl", "--context", &args, "", 20).await?;
    serde_json::from_str(&out).map_err(|e| e.to_string())
}

fn context_names(v: &Value) -> Vec<String> {
    v["contexts"].as_array().into_iter().flatten().filter_map(|c| c["name"].as_str().map(str::to_string)).collect()
}

/// Copies the kubeconfig before a change; returns the backup path.
async fn backup() -> Result<Option<String>, ApiError> {
    let Some(p) = primary_path().filter(|p| p.exists()) else { return Ok(None) };
    let stamp = chrono_like_stamp();
    let b = p.with_file_name(format!("{}.kubellens-backup-{stamp}", p.file_name().and_then(|n| n.to_str()).unwrap_or("config")));
    tokio::fs::copy(&p, &b).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Could not back up the kubeconfig: {e}")))?;
    Ok(Some(b.to_string_lossy().to_string()))
}

fn chrono_like_stamp() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("{secs}")
}

async fn kubectl(args: &[&str]) -> Result<String, ApiError> {
    run_cli("kubectl", "--context", args, "", 30).await.map_err(|e| bad(e.trim().to_string()))
}

pub async fn handle_list() -> Result<Json<Value>, ApiError> {
    let v = view(None).await.map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    let servers: std::collections::HashMap<String, String> = v["clusters"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| Some((c["name"].as_str()?.to_string(), c["cluster"]["server"].as_str().unwrap_or("").to_string())))
        .collect();
    let current = v["current-context"].as_str().unwrap_or("");
    let contexts: Vec<Value> = v["contexts"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| {
            let cluster = c["context"]["cluster"].as_str().unwrap_or("");
            json!({
                "name": c["name"],
                "cluster": cluster,
                "user": c["context"]["user"],
                "namespace": c["context"]["namespace"],
                "server": servers.get(cluster),
                "current": c["name"] == current,
            })
        })
        .collect();
    let cli = |p: &str| which(p);
    Ok(Json(json!({
        "contexts": contexts,
        "current": current,
        "path": primary_path().map(|p| p.to_string_lossy().to_string()),
        "clis": { "az": cli("az"), "aws": cli("aws"), "gcloud": cli("gcloud") },
    })))
}

/// The program name to run for a CLI: Azure CLI and gcloud are .cmd scripts on Windows.
fn program(name: &str) -> String {
    if cfg!(windows) && matches!(name, "az" | "gcloud") { format!("{name}.cmd") } else { name.to_string() }
}

/// True when the CLI is on PATH
fn which(name: &str) -> bool {
    let exe = program(name);
    let exts: Vec<String> = if cfg!(windows) && !exe.contains('.') { vec![".exe".into(), ".cmd".into()] } else { vec![String::new()] };
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| exts.iter().any(|e| d.join(format!("{exe}{e}")).is_file())))
        .unwrap_or(false)
}

#[derive(Deserialize)]
pub struct RenameRequest {
    from: String,
    to: String,
}

pub async fn handle_rename(State(state): State<AppState>, Json(r): Json<RenameRequest>) -> Result<Json<Value>, ApiError> {
    if !valid_context(&r.from) || !valid_context(&r.to) {
        return Err(bad("Context names can't contain spaces or start with '-'"));
    }
    let backup = backup().await?;
    kubectl(&["config", "rename-context", &r.from, &r.to]).await?;
    // The app's own idea of the current context follows the rename
    {
        let mut cur = state.current_context.write().await;
        if *cur == r.from {
            *cur = r.to.clone();
        }
    }
    state.cache.invalidate_all().await;
    Ok(Json(json!({ "success": true, "backup": backup })))
}

#[derive(Deserialize)]
pub struct NamespaceRequest {
    context: String,
    namespace: String,
}

pub async fn handle_namespace(State(state): State<AppState>, Json(r): Json<NamespaceRequest>) -> Result<Json<Value>, ApiError> {
    if !valid_context(&r.context) || !(r.namespace.is_empty() || crate::valid_k8s_name(&r.namespace)) {
        return Err(bad("Invalid context or namespace"));
    }
    kubectl(&["config", "set-context", &r.context, &format!("--namespace={}", r.namespace)]).await?;
    state.cache.invalidate_all().await;
    Ok(Json(json!({ "success": true })))
}

#[derive(Deserialize)]
pub struct DeleteRequest {
    context: String,
}

pub async fn handle_delete(State(state): State<AppState>, Json(r): Json<DeleteRequest>) -> Result<Json<Value>, ApiError> {
    if !valid_context(&r.context) {
        return Err(bad("Invalid context"));
    }
    let v = view(None).await.map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    let ctx = v["contexts"].as_array().into_iter().flatten().find(|c| c["name"] == r.context.as_str()).cloned().ok_or_else(|| bad("No such context"))?;
    let cluster = ctx["context"]["cluster"].as_str().unwrap_or("").to_string();
    let user = ctx["context"]["user"].as_str().unwrap_or("").to_string();
    let others = |field: &str, value: &str| {
        v["contexts"].as_array().into_iter().flatten().any(|c| c["name"] != r.context.as_str() && c["context"][field] == value)
    };
    let backup = backup().await?;
    kubectl(&["config", "delete-context", &r.context]).await?;
    // Cluster and user entries only this context used go too
    let mut removed = vec![format!("context {}", r.context)];
    if !cluster.is_empty() && !others("cluster", &cluster) && kubectl(&["config", "delete-cluster", &cluster]).await.is_ok() {
        removed.push(format!("cluster {cluster}"));
    }
    if !user.is_empty() && !others("user", &user) && kubectl(&["config", "delete-user", &user]).await.is_ok() {
        removed.push(format!("user {user}"));
    }
    state.cache.invalidate_all().await;
    Ok(Json(json!({ "success": true, "removed": removed, "backup": backup })))
}

#[derive(Deserialize)]
pub struct ImportRequest {
    /// The kubeconfig file's text
    content: String,
}

pub async fn handle_import(State(state): State<AppState>, Json(r): Json<ImportRequest>) -> Result<Json<Value>, ApiError> {
    if r.content.trim().is_empty() || r.content.len() > 2_000_000 {
        return Err(bad("Choose a kubeconfig file"));
    }
    let target = primary_path().ok_or_else(|| bad("Could not find the kubeconfig location"))?;
    let tmp = std::env::temp_dir().join(format!("kubellens-import-{}-{}.yaml", std::process::id(), crate::current_unix_nanos()));
    tokio::fs::write(&tmp, r.content.as_bytes()).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let tmp_s = tmp.to_string_lossy().to_string();
    let result = async {
        let incoming = view(Some(&tmp_s)).await.map_err(|e| bad(format!("Not a valid kubeconfig: {}", e.trim())))?;
        let new_names = context_names(&incoming);
        if new_names.is_empty() {
            return Err(bad("That file has no contexts"));
        }
        let existing: Vec<String> = if target.exists() { view(None).await.map(|v| context_names(&v)).unwrap_or_default() } else { Vec::new() };
        let (skipped, added): (Vec<String>, Vec<String>) = new_names.into_iter().partition(|n| existing.contains(n));
        let backup = backup().await?;

        // Merge with kubectl itself; the current file comes first, so its entries win on name clashes
        let sep = if cfg!(windows) { ";" } else { ":" };
        let merged_from = if target.exists() { format!("{}{sep}{tmp_s}", target.to_string_lossy()) } else { tmp_s.clone() };
        let mut cmd = create_kubectl_cmd();
        cmd.env("KUBECONFIG", &merged_from).args(["config", "view", "--flatten", "--raw"]);
        let out = cmd.output().await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        if !out.status.success() {
            return Err(bad(String::from_utf8_lossy(&out.stderr).trim().to_string()));
        }
        if let Some(dir) = target.parent() {
            tokio::fs::create_dir_all(dir).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        }
        tokio::fs::write(&target, &out.stdout).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Could not write the kubeconfig: {e}")))?;
        Ok((added, skipped, backup))
    }
    .await;
    let _ = tokio::fs::remove_file(&tmp).await;
    let (added, skipped, backup) = result?;
    state.cache.invalidate_all().await;
    Ok(Json(json!({ "success": true, "added": added, "skipped": skipped, "backup": backup })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudRequest {
    /// aks | eks | gke
    provider: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    resource_group: String,
    #[serde(default)]
    region: String,
    #[serde(default)]
    project: String,
}

fn check_args(r: &CloudRequest, need: &[&str]) -> Result<(), ApiError> {
    for (field, value) in [("name", &r.name), ("resourceGroup", &r.resource_group), ("region", &r.region), ("project", &r.project)] {
        let required = need.contains(&field);
        if (required || !value.is_empty()) && !valid_cloud_arg(value) {
            return Err(bad(format!("Enter a valid {field}")));
        }
    }
    Ok(())
}

async fn cloud(cli: &str, args: &[&str], timeout: u64) -> Result<String, ApiError> {
    run_cli(&program(cli), "--context", args, "", timeout).await.map_err(|e| {
        let e = e.trim().to_string();
        if e.contains("was not found on PATH") {
            bad(format!("The {cli} CLI isn't installed (or not on PATH)."))
        } else {
            bad(e)
        }
    })
}

pub async fn handle_cloud_list(Json(r): Json<CloudRequest>) -> Result<Json<Value>, ApiError> {
    let clusters: Vec<Value> = match r.provider.as_str() {
        "aks" => {
            check_args(&r, &[])?;
            let out = cloud("az", &["aks", "list", "--query", "[].{name:name,resourceGroup:resourceGroup,location:location}", "-o", "json"], 120).await?;
            serde_json::from_str(&out).unwrap_or_default()
        }
        "eks" => {
            check_args(&r, &["region"])?;
            let out = cloud("aws", &["eks", "list-clusters", "--region", &r.region, "--output", "json"], 120).await?;
            let v: Value = serde_json::from_str(&out).unwrap_or(json!({}));
            v["clusters"].as_array().into_iter().flatten().map(|n| json!({ "name": n, "location": r.region })).collect()
        }
        "gke" => {
            check_args(&r, &[])?;
            let mut args = vec!["container", "clusters", "list", "--format=json"];
            let project = format!("--project={}", r.project);
            if !r.project.is_empty() {
                args.push(&project);
            }
            let out = cloud("gcloud", &args, 120).await?;
            let v: Value = serde_json::from_str(&out).unwrap_or(json!([]));
            v.as_array().into_iter().flatten().map(|c| json!({ "name": c["name"], "location": c["location"] })).collect()
        }
        _ => return Err(bad("Choose AKS, EKS or GKE")),
    };
    Ok(Json(json!({ "clusters": clusters })))
}

pub async fn handle_cloud_connect(State(state): State<AppState>, Json(r): Json<CloudRequest>) -> Result<Json<Value>, ApiError> {
    let backup = backup().await?;
    let out = match r.provider.as_str() {
        "aks" => {
            check_args(&r, &["name", "resourceGroup"])?;
            cloud("az", &["aks", "get-credentials", "-g", &r.resource_group, "-n", &r.name, "--overwrite-existing"], 180).await?
        }
        "eks" => {
            check_args(&r, &["name", "region"])?;
            cloud("aws", &["eks", "update-kubeconfig", "--name", &r.name, "--region", &r.region], 180).await?
        }
        "gke" => {
            check_args(&r, &["name", "region"])?;
            let location = format!("--location={}", r.region);
            let project = format!("--project={}", r.project);
            let mut args = vec!["container", "clusters", "get-credentials", r.name.as_str(), location.as_str()];
            if !r.project.is_empty() {
                args.push(&project);
            }
            cloud("gcloud", &args, 180).await?
        }
        _ => return Err(bad("Choose AKS, EKS or GKE")),
    };
    state.cache.invalidate_all().await;
    Ok(Json(json!({ "success": true, "output": out.trim(), "backup": backup })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_names() {
        assert!(valid_context("arn:aws:eks:eu-west-1:123:cluster/prod"));
        assert!(valid_context("tf-aks-development"));
        assert!(!valid_context("--kubeconfig=/x"));
        assert!(!valid_context("two words"));
        assert!(valid_cloud_arg("rg-platform_01"));
        assert!(!valid_cloud_arg("rg;rm"));
        assert!(!valid_cloud_arg("-g"));
    }

    #[test]
    fn reads_context_names() {
        let v = json!({ "contexts": [{ "name": "a" }, { "name": "b" }] });
        assert_eq!(context_names(&v), ["a", "b"]);
    }
}
