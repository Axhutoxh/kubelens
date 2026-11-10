//! One timeline for a workload or pod: rollouts (with image changes), spec edits, restarts and
//! OOM kills, changes to the ConfigMaps / Secrets it uses, and Kubernetes events. Answers
//! "what changed before it broke?".
//!
//! `GET /api/timeline?kind=deployment|statefulset|daemonset|pod&name=&namespace=&context=`

use crate::{run_kubectl_cmd, AppState};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashSet};

const MAX_ENTRIES: usize = 400;

#[derive(Deserialize)]
pub struct TimelineQuery {
    kind: String,
    name: String,
    namespace: String,
    context: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// RFC3339
    pub time: String,
    /// rollout | change | restart | config | scale | pod | event
    pub category: &'static str,
    /// info | warning | error
    pub severity: &'static str,
    pub title: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub detail: String,
    /// e.g. "pod/api-7d9f8-x7k2p"
    #[serde(skip_serializing_if = "String::is_empty")]
    pub object: String,
}

type ApiError = (StatusCode, String);

async fn get_json(args: &[&str], ctx: &str) -> Result<Value, String> {
    let out = run_kubectl_cmd(args, ctx).await.map_err(|e| e.trim().to_string())?;
    serde_json::from_str(&out).map_err(|e| format!("unexpected kubectl output: {e}"))
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}

fn items(v: &Value) -> impl Iterator<Item = &Value> {
    v["items"].as_array().into_iter().flatten()
}

fn owned_by(obj: &Value, kind: &str, name: &str) -> bool {
    obj["metadata"]["ownerReferences"].as_array().into_iter().flatten().any(|o| s(&o["kind"]) == kind && s(&o["name"]) == name)
}

/// "container=image" pairs of a pod template, in order
fn images(template: &Value) -> Vec<(String, String)> {
    template["spec"]["containers"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| (s(&c["name"]).to_string(), s(&c["image"]).to_string()))
        .collect()
}

fn image_change(prev: &[(String, String)], next: &[(String, String)]) -> String {
    let changes: Vec<String> = next
        .iter()
        .filter_map(|(name, img)| match prev.iter().find(|(n, _)| n == name) {
            Some((_, old)) if old != img => Some(format!("{name}: {old} → {img}")),
            None if !prev.is_empty() => Some(format!("{name}: added {img}")),
            _ => None,
        })
        .collect();
    if prev.is_empty() {
        next.iter().map(|(n, i)| format!("{n}: {i}")).collect::<Vec<_>>().join("\n")
    } else if changes.is_empty() {
        "Same images; the pod template changed (env, config, resources or a restart)".to_string()
    } else {
        changes.join("\n")
    }
}

/// ConfigMaps and Secrets a pod template reads (env, envFrom, volumes, projected volumes).
pub fn config_refs(pod_spec: &Value) -> (BTreeSet<String>, BTreeSet<String>) {
    let (mut cms, mut secrets) = (BTreeSet::new(), BTreeSet::new());
    let containers = ["containers", "initContainers"].into_iter().flat_map(|k| pod_spec[k].as_array().into_iter().flatten());
    for c in containers {
        for e in c["env"].as_array().into_iter().flatten() {
            if let Some(n) = e["valueFrom"]["configMapKeyRef"]["name"].as_str() {
                cms.insert(n.to_string());
            }
            if let Some(n) = e["valueFrom"]["secretKeyRef"]["name"].as_str() {
                secrets.insert(n.to_string());
            }
        }
        for e in c["envFrom"].as_array().into_iter().flatten() {
            if let Some(n) = e["configMapRef"]["name"].as_str() {
                cms.insert(n.to_string());
            }
            if let Some(n) = e["secretRef"]["name"].as_str() {
                secrets.insert(n.to_string());
            }
        }
    }
    for v in pod_spec["volumes"].as_array().into_iter().flatten() {
        if let Some(n) = v["configMap"]["name"].as_str() {
            cms.insert(n.to_string());
        }
        if let Some(n) = v["secret"]["secretName"].as_str() {
            secrets.insert(n.to_string());
        }
        for src in v["projected"]["sources"].as_array().into_iter().flatten() {
            if let Some(n) = src["configMap"]["name"].as_str() {
                cms.insert(n.to_string());
            }
            if let Some(n) = src["secret"]["name"].as_str() {
                secrets.insert(n.to_string());
            }
        }
    }
    (cms, secrets)
}

/// Spec edits recorded in managedFields (who changed the object, and when). Status
/// updates and the controller's own bookkeeping are skipped.
pub fn spec_changes(obj: &Value, object: &str) -> Vec<Entry> {
    let created = s(&obj["metadata"]["creationTimestamp"]);
    obj["metadata"]["managedFields"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|f| f["subresource"].is_null() && !s(&f["time"]).is_empty() && s(&f["time"]) != created)
        .filter(|f| !matches!(s(&f["manager"]), "kube-controller-manager" | "kubelet"))
        .map(|f| Entry {
            time: s(&f["time"]).to_string(),
            category: "change",
            severity: "info",
            title: format!("Changed by {}", s(&f["manager"])),
            detail: String::new(),
            object: object.to_string(),
        })
        .collect()
}

/// Restarts / terminations recorded in a pod's container statuses.
pub fn pod_entries(pod: &Value) -> Vec<Entry> {
    let name = s(&pod["metadata"]["name"]);
    let object = format!("pod/{name}");
    let mut out = vec![Entry {
        time: s(&pod["metadata"]["creationTimestamp"]).to_string(),
        category: "pod",
        severity: "info",
        title: format!("Pod {name} created"),
        detail: match s(&pod["spec"]["nodeName"]) {
            "" => String::new(),
            node => format!("on {node}"),
        },
        object: object.clone(),
    }];
    let statuses = ["initContainerStatuses", "containerStatuses"].into_iter().flat_map(|k| pod["status"][k].as_array().into_iter().flatten());
    for c in statuses {
        let t = &c["lastState"]["terminated"];
        if t.is_null() {
            continue;
        }
        let reason = s(&t["reason"]);
        let code = t["exitCode"].as_i64().unwrap_or(0);
        let restarts = c["restartCount"].as_i64().unwrap_or(0);
        out.push(Entry {
            time: s(&t["finishedAt"]).to_string(),
            category: "restart",
            severity: if reason == "OOMKilled" || code != 0 { "error" } else { "warning" },
            title: format!("Container {} {}", s(&c["name"]), if reason == "OOMKilled" { "was OOM-killed".to_string() } else { format!("exited ({}{})", if reason.is_empty() { "exit" } else { reason }, if code != 0 { format!(", code {code}") } else { String::new() }) }),
            detail: format!("{restarts} restart(s) so far{}", if s(&t["message"]).is_empty() { String::new() } else { format!(" · {}", s(&t["message"])) }),
            object: object.clone(),
        });
    }
    out
}

fn event_entry(e: &Value) -> Option<Entry> {
    let time = [&e["lastTimestamp"], &e["eventTime"], &e["firstTimestamp"], &e["metadata"]["creationTimestamp"]]
        .into_iter()
        .map(s)
        .find(|t| !t.is_empty())?
        .to_string();
    let reason = s(&e["reason"]);
    let warning = s(&e["type"]) == "Warning";
    let count = e["count"].as_i64().or_else(|| e["series"]["count"].as_i64()).unwrap_or(1);
    let category = if reason.starts_with("ScalingReplicaSet") || reason == "SuccessfulRescale" { "scale" } else { "event" };
    Some(Entry {
        time,
        category,
        severity: if warning { "warning" } else { "info" },
        title: if count > 1 { format!("{reason} (×{count})") } else { reason.to_string() },
        detail: s(&e["message"]).trim().to_string(),
        object: format!("{}/{}", s(&e["involvedObject"]["kind"]).to_lowercase(), s(&e["involvedObject"]["name"])),
    })
}

fn selector_string(sel: &Value) -> Option<String> {
    let labels = sel["matchLabels"].as_object()?;
    if labels.is_empty() {
        return None;
    }
    Some(labels.iter().map(|(k, v)| format!("{k}={}", s(v))).collect::<Vec<_>>().join(","))
}

pub async fn handle_timeline(Query(q): Query<TimelineQuery>, State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let kind = q.kind.to_lowercase();
    if !matches!(kind.as_str(), "deployment" | "statefulset" | "daemonset" | "pod") {
        return Err((StatusCode::BAD_REQUEST, format!("Timeline isn't available for '{}'", q.kind)));
    }
    if !crate::valid_k8s_name(&q.name) || !crate::valid_k8s_name(&q.namespace) {
        return Err((StatusCode::BAD_REQUEST, "Invalid name or namespace".into()));
    }
    let current = state.ctx().await;
    let ctx = q.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current).to_string();
    let ns = q.namespace.as_str();
    let bad_gateway = |e: String| (StatusCode::BAD_GATEWAY, e);

    let obj = get_json(&["get", &kind, &q.name, "-n", ns, "-o", "json"], &ctx).await.map_err(bad_gateway)?;
    let mut entries: Vec<Entry> = Vec::new();
    let self_ref = format!("{kind}/{}", q.name);
    // Names whose events belong on this timeline
    let mut related: HashSet<String> = HashSet::from([q.name.clone()]);

    let is_pod = kind == "pod";
    let pod_spec = if is_pod { obj["spec"].clone() } else { obj["spec"]["template"]["spec"].clone() };
    let (rev_kind, owner_kind) = match kind.as_str() {
        "deployment" => ("replicasets", "Deployment"),
        "statefulset" => ("controllerrevisions", "StatefulSet"),
        _ => ("controllerrevisions", "DaemonSet"),
    };
    // Revisions and pods carry the workload's selector labels; narrowing by them avoids listing the whole namespace
    let sel = if is_pod { None } else { selector_string(&obj["spec"]["selector"]) };

    // Everything below only depends on the object, so it is fetched in parallel
    // (each kubectl call can take a second or two against a managed cluster)
    let revs_fut = async {
        if is_pod {
            return Ok(Value::Null);
        }
        let mut args = vec!["get", rev_kind, "-n", ns, "-o", "json"];
        if let Some(sel) = &sel {
            args.extend(["-l", sel.as_str()]);
        }
        get_json(&args, &ctx).await
    };
    let pods_fut = async {
        match (&sel, is_pod) {
            (_, true) => vec![obj.clone()],
            (Some(sel), false) => get_json(&["get", "pods", "-n", ns, "-l", sel, "-o", "json"], &ctx).await.map(|v| items(&v).cloned().collect()).unwrap_or_default(),
            (None, false) => Vec::new(),
        }
    };
    let (cms, secrets) = config_refs(&pod_spec);
    let lookups: Vec<(&str, String)> = cms.iter().map(|n| ("configmap", n.clone())).chain(secrets.iter().map(|n| ("secret", n.clone()))).collect();
    let configs_fut = futures_util::future::join_all(lookups.into_iter().map(|(k, n)| {
        let ctx = ctx.clone();
        async move {
            let r = get_json(&["get", k, &n, "-n", ns, "-o", "json"], &ctx).await;
            (k, n, r)
        }
    }));
    let events_fut = async { get_json(&["get", "events", "-n", ns, "-o", "json"], &ctx).await };
    let (revs, pods, fetched, events) = tokio::join!(revs_fut, pods_fut, configs_fut, events_fut);

    if !is_pod {
        entries.extend(spec_changes(&obj, &self_ref));
        entries.push(Entry {
            time: s(&obj["metadata"]["creationTimestamp"]).to_string(),
            category: "change",
            severity: "info",
            title: format!("{} created", q.name),
            detail: String::new(),
            object: self_ref.clone(),
        });

        // Rollouts: ReplicaSets (deployment) or ControllerRevisions (statefulset / daemonset)
        let revs = revs.map_err(bad_gateway)?;
        let mut owned: Vec<(i64, String, String, Vec<(String, String)>)> = items(&revs)
            .filter(|r| owned_by(r, owner_kind, &q.name))
            .map(|r| {
                let revision = if kind == "deployment" {
                    s(&r["metadata"]["annotations"]["deployment.kubernetes.io/revision"]).parse().unwrap_or(0)
                } else {
                    r["revision"].as_i64().unwrap_or(0)
                };
                let template = if kind == "deployment" { &r["spec"]["template"] } else { &r["data"]["spec"]["template"] };
                (revision, s(&r["metadata"]["name"]).to_string(), s(&r["metadata"]["creationTimestamp"]).to_string(), images(template))
            })
            .collect();
        owned.sort_by_key(|r| r.0);
        let mut prev: Vec<(String, String)> = Vec::new();
        for (revision, name, created, imgs) in &owned {
            related.insert(name.clone());
            entries.push(Entry {
                time: created.clone(),
                category: "rollout",
                severity: "info",
                title: format!("Rollout to revision {revision}"),
                detail: image_change(&prev, imgs),
                object: format!("{}/{name}", if kind == "deployment" { "replicaset" } else { "controllerrevision" }),
            });
            prev = imgs.clone();
        }
    }
    for p in &pods {
        related.insert(s(&p["metadata"]["name"]).to_string());
        entries.extend(pod_entries(p));
    }

    // ConfigMaps / Secrets it reads: their last edits (data never leaves this function)
    for (k, n, r) in fetched {
        let label = if k == "configmap" { "ConfigMap" } else { "Secret" };
        match r {
            Ok(v) => {
                let created = s(&v["metadata"]["creationTimestamp"]).to_string();
                let edits: BTreeSet<(String, String)> = v["metadata"]["managedFields"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|f| !s(&f["time"]).is_empty() && s(&f["time"]) != created)
                    .map(|f| (s(&f["time"]).to_string(), s(&f["manager"]).to_string()))
                    .collect();
                entries.push(Entry { time: created, category: "config", severity: "info", title: format!("{label} {n} created"), detail: String::new(), object: format!("{k}/{n}") });
                for (time, manager) in edits {
                    entries.push(Entry { time, category: "config", severity: "warning", title: format!("{label} {n} changed"), detail: format!("by {manager}"), object: format!("{k}/{n}") });
                }
            }
            Err(e) if e.contains("NotFound") || e.contains("not found") => entries.push(Entry {
                time: String::new(),
                category: "config",
                severity: "error",
                title: format!("{label} {n} is missing"),
                detail: "Referenced by the pod template but doesn't exist".into(),
                object: format!("{k}/{n}"),
            }),
            Err(_) => {}
        }
    }

    // Events for the object, its ReplicaSets / revisions and its pods
    if let Ok(evs) = events {
        entries.extend(items(&evs).filter(|e| related.contains(s(&e["involvedObject"]["name"]))).filter_map(event_entry));
    }

    // Newest first; undated entries (missing references) on top
    entries.sort_by(|a, b| b.time.is_empty().cmp(&a.time.is_empty()).then(b.time.cmp(&a.time)));
    entries.dedup();
    let truncated = entries.len() > MAX_ENTRIES;
    entries.truncate(MAX_ENTRIES);
    Ok(Json(json!({ "entries": entries, "truncated": truncated, "pods": pods.len() })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_config_references() {
        let spec = json!({
            "containers": [{
                "env": [
                    { "name": "A", "valueFrom": { "configMapKeyRef": { "name": "app-config", "key": "a" } } },
                    { "name": "B", "valueFrom": { "secretKeyRef": { "name": "db", "key": "pw" } } }
                ],
                "envFrom": [{ "configMapRef": { "name": "common" } }]
            }],
            "volumes": [
                { "name": "v", "configMap": { "name": "files" } },
                { "name": "t", "secret": { "secretName": "tls" } },
                { "name": "p", "projected": { "sources": [{ "configMap": { "name": "ca" } }, { "secret": { "name": "token" } }] } }
            ]
        });
        let (cms, secrets) = config_refs(&spec);
        assert_eq!(cms.into_iter().collect::<Vec<_>>(), ["app-config", "ca", "common", "files"]);
        assert_eq!(secrets.into_iter().collect::<Vec<_>>(), ["db", "tls", "token"]);
    }

    #[test]
    fn describes_image_changes() {
        let a = vec![("api".to_string(), "repo/api:1.2".to_string()), ("sidecar".to_string(), "envoy:1".to_string())];
        let b = vec![("api".to_string(), "repo/api:1.3".to_string()), ("sidecar".to_string(), "envoy:1".to_string())];
        assert_eq!(image_change(&a, &b), "api: repo/api:1.2 → repo/api:1.3");
        // First revision lists every image
        assert_eq!(image_change(&[], &a), "api: repo/api:1.2\nsidecar: envoy:1");
        assert!(image_change(&a, &a).starts_with("Same images"));
    }

    #[test]
    fn reads_restarts_and_spec_edits() {
        let pod = json!({
            "metadata": { "name": "api-1", "creationTimestamp": "2026-11-10T10:00:00Z" },
            "spec": { "nodeName": "node-a" },
            "status": { "containerStatuses": [
                { "name": "api", "restartCount": 3, "lastState": { "terminated": { "reason": "OOMKilled", "exitCode": 137, "finishedAt": "2026-11-10T11:00:00Z" } } },
                { "name": "ok", "restartCount": 0, "lastState": {} }
            ] }
        });
        let e = pod_entries(&pod);
        assert_eq!(e.len(), 2);
        assert_eq!(e[1].title, "Container api was OOM-killed");
        assert_eq!(e[1].severity, "error");

        let dep = json!({ "metadata": { "creationTimestamp": "2026-11-01T00:00:00Z", "managedFields": [
            { "manager": "kubectl", "operation": "Update", "time": "2026-11-09T08:00:00Z" },
            { "manager": "kube-controller-manager", "operation": "Update", "time": "2026-11-09T08:00:01Z", "subresource": "status" },
            { "manager": "helm", "operation": "Update", "time": "2026-11-01T00:00:00Z" }
        ] } });
        let c = spec_changes(&dep, "deployment/api");
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].title, "Changed by kubectl");
    }
}
