//! Safer YAML editing.
//!
//! - Review: a server-side dry run (`kubectl apply --dry-run=server --validate=strict`) checks
//!   the manifest against the cluster's own schema and admission, and returns each object as it
//!   is now and as it would be after Apply, so the UI can show a diff. (`kubectl diff` needs an
//!   external `diff` program, which Windows doesn't have.)
//! - Explain: the fields under a path (`kubectl explain deployment.spec.template`), for the
//!   editor's field help.
//!
//! `POST /api/k8s/review`, `GET /api/k8s/explain?path=&context=`

use crate::{create_kubectl_cmd, AppState};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::process::Stdio;
use tokio::io::AsyncWriteExt;

type ApiError = (StatusCode, String);

/// Runs kubectl with `input` on stdin; Ok(stdout) or Err(stderr).
async fn kubectl_stdin(args: &[&str], ctx: &str, input: &str) -> Result<String, String> {
    let mut cmd = create_kubectl_cmd();
    if !ctx.is_empty() {
        cmd.arg("--context").arg(ctx);
    }
    cmd.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(input.as_bytes()).await.map_err(|e| e.to_string())?;
    }
    let out = tokio::time::timeout(std::time::Duration::from_secs(60), child.wait_with_output())
        .await
        .map_err(|_| "kubectl timed out after 60s".to_string())?
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Objects in kubectl's JSON output: a single object, a List, or nothing.
fn objects(text: &str) -> Vec<Value> {
    match serde_json::from_str::<Value>(text.trim()) {
        Ok(v) if v["kind"] == "List" => v["items"].as_array().cloned().unwrap_or_default(),
        Ok(v) if v.is_object() => vec![v],
        _ => Vec::new(),
    }
}

/// Drops fields the server manages, so the diff shows only what the user changes.
pub fn clean(mut obj: Value) -> Value {
    if let Some(meta) = obj.get_mut("metadata").and_then(Value::as_object_mut) {
        for k in ["managedFields", "resourceVersion", "uid", "generation", "creationTimestamp", "selfLink"] {
            meta.remove(k);
        }
        if let Some(ann) = meta.get_mut("annotations").and_then(Value::as_object_mut) {
            ann.remove("kubectl.kubernetes.io/last-applied-configuration");
            ann.remove("deployment.kubernetes.io/revision");
        }
        if meta.get("annotations").and_then(Value::as_object).is_some_and(|a| a.is_empty()) {
            meta.remove("annotations");
        }
    }
    if let Some(o) = obj.as_object_mut() {
        o.remove("status");
    }
    obj
}

fn identity(o: &Value) -> (String, String, String, String) {
    let s = |v: &Value| v.as_str().unwrap_or("").to_string();
    let group = s(&o["apiVersion"]).rsplit_once('/').map(|(g, _)| g.to_string()).unwrap_or_default();
    (group, s(&o["kind"]), s(&o["metadata"]["namespace"]), s(&o["metadata"]["name"]))
}

#[derive(Deserialize)]
pub struct ReviewRequest {
    manifest: String,
    #[serde(default)]
    context: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewedObject {
    kind: String,
    name: String,
    namespace: String,
    /// create | update | unchanged
    action: &'static str,
    /// The object now (null when it doesn't exist yet), managed fields removed
    live: Option<Value>,
    /// The object after Apply, as the API server would store it
    after: Value,
}

pub async fn handle_review(State(state): State<AppState>, Json(req): Json<ReviewRequest>) -> Result<Json<Value>, ApiError> {
    if req.manifest.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "The manifest is empty".into()));
    }
    let current = state.ctx().await;
    let ctx = req.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current).to_string();

    let (dry, live) = tokio::join!(
        kubectl_stdin(&["apply", "--dry-run=server", "--validate=strict", "-o", "json", "-f", "-"], &ctx, &req.manifest),
        kubectl_stdin(&["get", "-f", "-", "-o", "json", "--ignore-not-found"], &ctx, &req.manifest),
    );
    let dry = match dry {
        Ok(out) => out,
        // Schema, admission and syntax errors: nothing would be applied
        Err(e) => return Ok(Json(json!({ "valid": false, "errors": e, "objects": [] }))),
    };
    let live_objects = live.map(|t| objects(&t)).unwrap_or_default();
    let reviewed: Vec<ReviewedObject> = objects(&dry)
        .into_iter()
        .map(|after| {
            let id = identity(&after);
            let live = live_objects.iter().find(|l| identity(l) == id).cloned().map(clean);
            let after = clean(after);
            let action = match &live {
                None => "create",
                Some(l) if *l == after => "unchanged",
                Some(_) => "update",
            };
            ReviewedObject { kind: id.1, name: id.3, namespace: id.2, action, live, after }
        })
        .collect();
    Ok(Json(json!({ "valid": true, "objects": reviewed })))
}

#[derive(Deserialize)]
pub struct ExplainQuery {
    /// e.g. "deployment.spec.template.spec"
    path: String,
    #[serde(default)]
    context: Option<String>,
}

#[derive(Serialize, PartialEq, Debug)]
pub struct Field {
    name: String,
    #[serde(rename = "type")]
    kind: String,
    required: bool,
    description: String,
}

/// Fields listed under "FIELDS:" in `kubectl explain` output.
pub fn parse_explain(text: &str) -> Vec<Field> {
    let mut fields: Vec<Field> = Vec::new();
    let mut in_fields = false;
    for line in text.lines() {
        if line.starts_with("FIELDS:") {
            in_fields = true;
            continue;
        }
        if !in_fields {
            continue;
        }
        let trimmed = line.trim_start();
        let indent = line.len() - trimmed.len();
        // "  name\t<type> -required-"
        if indent > 0 && indent <= 3 && trimmed.contains('<') {
            let mut parts = trimmed.splitn(2, |c: char| c.is_whitespace());
            let name = parts.next().unwrap_or("").to_string();
            let rest = parts.next().unwrap_or("").trim();
            if let (Some(a), Some(b)) = (rest.find('<'), rest.find('>')) {
                fields.push(Field { name, kind: rest[a + 1..b].to_string(), required: rest.contains("-required-"), description: String::new() });
                continue;
            }
        }
        // Description lines (deeper indent) belong to the last field; keep the first sentence or so
        if indent > 3 {
            if let Some(f) = fields.last_mut() {
                if f.description.len() < 240 {
                    if !f.description.is_empty() {
                        f.description.push(' ');
                    }
                    f.description.push_str(trimmed);
                }
            }
        }
    }
    fields
}

pub async fn handle_explain(Query(q): Query<ExplainQuery>, State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let path = q.path.trim().trim_matches('.').to_lowercase();
    if path.is_empty() || path.len() > 200 || !path.chars().all(|c| c.is_ascii_alphanumeric() || c == '.') {
        return Err((StatusCode::BAD_REQUEST, "Invalid field path".into()));
    }
    let current = state.ctx().await;
    let ctx = q.context.filter(|c| !c.is_empty()).unwrap_or(current);
    // Schemas only change with the cluster version: cache for an hour
    let out = state
        .cache
        .fetch(format!("explain:{ctx}:{path}"), 3600, vec!["explain".into(), path.clone()], ctx)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e.trim().to_string()))?;
    let text = String::from_utf8_lossy(&out);
    Ok(Json(json!({ "path": path, "fields": parse_explain(&text) })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_explain_fields() {
        let text = "GROUP:      apps\nKIND:       Deployment\nVERSION:    v1\n\nFIELD: spec <DeploymentSpec>\n\nDESCRIPTION:\n    Specification of the desired behavior.\n\nFIELDS:\n  minReadySeconds\t<integer>\n    Minimum number of seconds for which a newly created pod should be ready.\n\n  selector\t<LabelSelector> -required-\n    Label selector for pods.\n\n  template\t<PodTemplateSpec> -required-\n    Template describes the pods that will be created.\n";
        let f = parse_explain(text);
        assert_eq!(f.len(), 3);
        assert_eq!(f[0].name, "minReadySeconds");
        assert_eq!(f[0].kind, "integer");
        assert!(!f[0].required && f[1].required);
        assert!(f[2].description.starts_with("Template describes"));
    }

    #[test]
    fn cleans_server_fields_and_matches_objects() {
        let live = json!({ "apiVersion": "apps/v1", "kind": "Deployment", "metadata": { "name": "api", "namespace": "team", "resourceVersion": "9",
            "managedFields": [], "annotations": { "kubectl.kubernetes.io/last-applied-configuration": "{}" } }, "spec": { "replicas": 2 }, "status": {} });
        let c = clean(live.clone());
        assert!(c["metadata"].get("resourceVersion").is_none() && c["metadata"].get("annotations").is_none() && c.get("status").is_none());
        assert_eq!(identity(&live), ("apps".into(), "Deployment".into(), "team".into(), "api".into()));
        assert_eq!(objects(r#"{"kind":"List","items":[{"kind":"A"},{"kind":"B"}]}"#).len(), 2);
        assert_eq!(objects("").len(), 0);
    }
}
