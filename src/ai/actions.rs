//! Changes the in-app assistant can propose: restart, scale, roll back, delete a pod, set an
//! image. Nothing runs on the model's say-so: the chat loop pauses with a preview of the exact
//! change (current → new values and the kubectl command) and only applies it when the user
//! clicks Apply. These tools are never offered over MCP.

use super::tools::{arg, context_arg, kubectl, name_re, prop, ToolSpec, CONTEXT_DESC};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::OnceLock;

const MAX_REPLICAS: i64 = 100;

pub fn specs() -> &'static [ToolSpec] {
    static SPECS: OnceLock<Vec<ToolSpec>> = OnceLock::new();
    SPECS.get_or_init(|| {
        let workload = |kinds: &[&str]| json!({ "type": "string", "enum": kinds, "description": "Workload kind" });
        vec![
            ToolSpec {
                name: "restart_workload",
                description: "Propose a rolling restart (kubectl rollout restart). The user sees a preview and must click Apply; nothing changes otherwise.",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "kind": workload(&["deployment", "statefulset", "daemonset"]),
                        "name": prop("string", "Workload name"),
                        "namespace": prop("string", "Namespace"),
                        "context": prop("string", CONTEXT_DESC),
                    },
                    "required": ["kind", "name", "namespace"],
                }),
                can_reveal: false,
            },
            ToolSpec {
                name: "scale_workload",
                description: "Propose changing the replica count. The user sees current → new replicas and must click Apply.",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "kind": workload(&["deployment", "statefulset"]),
                        "name": prop("string", "Workload name"),
                        "namespace": prop("string", "Namespace"),
                        "replicas": prop("integer", "New replica count (0-100)"),
                        "context": prop("string", CONTEXT_DESC),
                    },
                    "required": ["kind", "name", "namespace", "replicas"],
                }),
                can_reveal: false,
            },
            ToolSpec {
                name: "rollback_deployment",
                description: "Propose rolling a deployment back (kubectl rollout undo) to the previous revision or a given one. The user sees the image changes and must click Apply.",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "name": prop("string", "Deployment name"),
                        "namespace": prop("string", "Namespace"),
                        "revision": prop("integer", "Revision to go back to; omit for the previous one"),
                        "context": prop("string", CONTEXT_DESC),
                    },
                    "required": ["name", "namespace"],
                }),
                can_reveal: false,
            },
            ToolSpec {
                name: "delete_pod",
                description: "Propose deleting one pod (e.g. stuck or crash-looping) so its controller replaces it. The preview says whether it will be recreated; the user must click Apply.",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "name": prop("string", "Pod name"),
                        "namespace": prop("string", "Namespace"),
                        "context": prop("string", CONTEXT_DESC),
                    },
                    "required": ["name", "namespace"],
                }),
                can_reveal: false,
            },
            ToolSpec {
                name: "set_image",
                description: "Propose changing one container's image (kubectl set image), e.g. to fix a wrong tag. The user sees old → new image and must click Apply.",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "kind": workload(&["deployment", "statefulset", "daemonset"]),
                        "name": prop("string", "Workload name"),
                        "namespace": prop("string", "Namespace"),
                        "container": prop("string", "Container name"),
                        "image": prop("string", "Full new image reference, e.g. registry/app:1.4.2"),
                        "context": prop("string", CONTEXT_DESC),
                    },
                    "required": ["kind", "name", "namespace", "container", "image"],
                }),
                can_reveal: false,
            },
        ]
    })
}

pub fn is_action(name: &str) -> bool {
    specs().iter().any(|t| t.name == name)
}

#[derive(Debug, PartialEq)]
enum Action {
    Restart { kind: String, name: String, ns: String },
    Scale { kind: String, name: String, ns: String, replicas: i64 },
    Rollback { name: String, ns: String, revision: Option<i64> },
    DeletePod { name: String, ns: String },
    SetImage { kind: String, name: String, ns: String, container: String, image: String },
}

fn kind_arg(args: &Value, allowed: &[&str]) -> Result<String, String> {
    match args.get("kind").and_then(Value::as_str).map(|k| k.trim().to_lowercase()) {
        Some(k) if allowed.contains(&k.as_str()) => Ok(k),
        Some(k) => Err(format!("kind must be one of {}, not {k:?}", allowed.join(", "))),
        None => Err("missing required argument: kind".into()),
    }
}

fn req(args: &Value, key: &str) -> Result<String, String> {
    Ok(arg(args, key, true, name_re())?.unwrap_or_default().to_string())
}

fn parse(tool: &str, args: &Value) -> Result<Action, String> {
    Ok(match tool {
        "restart_workload" => Action::Restart { kind: kind_arg(args, &["deployment", "statefulset", "daemonset"])?, name: req(args, "name")?, ns: req(args, "namespace")? },
        "scale_workload" => {
            let replicas = args.get("replicas").and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))).ok_or("replicas must be a whole number")?;
            if !(0..=MAX_REPLICAS).contains(&replicas) {
                return Err(format!("replicas must be between 0 and {MAX_REPLICAS}"));
            }
            Action::Scale { kind: kind_arg(args, &["deployment", "statefulset"])?, name: req(args, "name")?, ns: req(args, "namespace")?, replicas }
        }
        "rollback_deployment" => {
            let revision = match args.get("revision") {
                None | Some(Value::Null) => None,
                Some(v) => Some(v.as_i64().filter(|r| *r > 0).ok_or("revision must be a positive whole number")?),
            };
            Action::Rollback { name: req(args, "name")?, ns: req(args, "namespace")?, revision }
        }
        "delete_pod" => Action::DeletePod { name: req(args, "name")?, ns: req(args, "namespace")? },
        "set_image" => {
            let image = args.get("image").and_then(Value::as_str).map(str::trim).unwrap_or("");
            if image.is_empty() || image.len() > 500 || image.starts_with('-') || image.chars().any(|c| c.is_whitespace() || c.is_control()) {
                return Err(format!("invalid image: {image:?}"));
            }
            Action::SetImage { kind: kind_arg(args, &["deployment", "statefulset", "daemonset"])?, name: req(args, "name")?, ns: req(args, "namespace")?, container: req(args, "container")?, image: image.to_string() }
        }
        other => return Err(format!("unknown action: {other}")),
    })
}

fn command(a: &Action) -> Vec<String> {
    let v = |xs: &[&str]| xs.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    match a {
        Action::Restart { kind, name, ns } => v(&["rollout", "restart", &format!("{kind}/{name}"), "-n", ns]),
        Action::Scale { kind, name, ns, replicas } => v(&["scale", &format!("{kind}/{name}"), &format!("--replicas={replicas}"), "-n", ns]),
        Action::Rollback { name, ns, revision } => {
            let mut c = v(&["rollout", "undo", &format!("deployment/{name}"), "-n", ns]);
            if let Some(r) = revision {
                c.push(format!("--to-revision={r}"));
            }
            c
        }
        Action::DeletePod { name, ns } => v(&["delete", "pod", name, "-n", ns, "--wait=false"]),
        Action::SetImage { kind, name, ns, container, image } => v(&["set", "image", &format!("{kind}/{name}"), &format!("{container}={image}"), "-n", ns]),
    }
}

/// Short description for activity rows and the approval card.
pub fn describe(tool: &str, args: &Value) -> String {
    match parse(tool, args) {
        Ok(Action::Restart { kind, name, ns }) => format!("Restart {kind} {name} ({ns})"),
        Ok(Action::Scale { kind, name, ns, replicas }) => format!("Scale {kind} {name} to {replicas} ({ns})"),
        Ok(Action::Rollback { name, ns, revision }) => match revision {
            Some(r) => format!("Roll back deployment {name} to revision {r} ({ns})"),
            None => format!("Roll back deployment {name} to the previous revision ({ns})"),
        },
        Ok(Action::DeletePod { name, ns }) => format!("Delete pod {name} ({ns})"),
        Ok(Action::SetImage { kind, name, ns, container, image }) => format!("Set {kind} {name} / {container} image to {image} ({ns})"),
        Err(_) => tool.replace('_', " "),
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    label: String,
    from: String,
    to: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    title: String,
    cluster: String,
    changes: Vec<Change>,
    /// The kubectl command that Apply runs
    command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    /// Shown in red: scaling to zero, deleting a pod nothing recreates
    danger: bool,
}

fn change(label: impl Into<String>, from: impl Into<String>, to: impl Into<String>) -> Change {
    Change { label: label.into(), from: from.into(), to: to.into() }
}

async fn get_obj(kind: &str, name: &str, ns: &str, ctx: &str) -> Result<Value, String> {
    let text = kubectl(&[ "get", kind, name, "-n", ns, "-o", "json"].map(String::from), ctx).await?;
    serde_json::from_str(&text).map_err(|e| format!("unexpected kubectl output: {e}"))
}

fn container_images(template: &Value) -> Vec<(String, String)> {
    template["spec"]["containers"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| (c["name"].as_str().unwrap_or("").to_string(), c["image"].as_str().unwrap_or("").to_string()))
        .collect()
}

fn quote(s: &str) -> String {
    if s.chars().all(|c| c.is_ascii_alphanumeric() || "-_./:=@".contains(c)) { s.to_string() } else { format!("'{s}'") }
}

/// Looks at the live object and describes exactly what Apply would change.
pub async fn preview(tool: &str, args: &Value, default_ctx: &str) -> Result<Preview, String> {
    let ctx = context_arg(args, default_ctx)?.to_string();
    let action = parse(tool, args)?;
    let mut cmd = format!("kubectl --context {} ", quote(&ctx));
    cmd.push_str(&command(&action).iter().map(|a| quote(a)).collect::<Vec<_>>().join(" "));
    let mut p = Preview { title: describe(tool, args), cluster: ctx.clone(), changes: Vec::new(), command: cmd, note: None, danger: false };

    match &action {
        Action::Restart { kind, name, ns } => {
            let obj = get_obj(kind, name, ns, &ctx).await?;
            let last = obj["spec"]["template"]["metadata"]["annotations"]["kubectl.kubernetes.io/restartedAt"].as_str().unwrap_or("never");
            p.changes.push(change("Last restart", last, "now"));
            let pods = obj["status"]["replicas"].as_i64().or_else(|| obj["status"]["desiredNumberScheduled"].as_i64()).unwrap_or(0);
            p.note = Some(format!("All {pods} pod(s) are replaced one at a time; ready pods keep serving during the rollout."));
        }
        Action::Scale { kind, name, ns, replicas } => {
            let obj = get_obj(kind, name, ns, &ctx).await?;
            let current = obj["spec"]["replicas"].as_i64().unwrap_or(1);
            if current == *replicas {
                return Err(format!("{kind} {name} already has {replicas} replica(s); nothing to change"));
            }
            p.changes.push(change("Replicas", current.to_string(), replicas.to_string()));
            if *replicas == 0 {
                p.danger = true;
                p.note = Some("Scaling to 0 stops every pod: the workload serves nothing until it is scaled up again.".into());
            } else if obj["metadata"]["annotations"].as_object().map(|a| a.keys().any(|k| k.contains("autoscal"))).unwrap_or(false) {
                p.note = Some("An autoscaler may change the replica count again.".into());
            }
        }
        Action::Rollback { name, ns, revision } => {
            let dep = get_obj("deployment", name, ns, &ctx).await?;
            let current_rev: i64 = dep["metadata"]["annotations"]["deployment.kubernetes.io/revision"].as_str().and_then(|r| r.parse().ok()).unwrap_or(0);
            let labels = dep["spec"]["selector"]["matchLabels"].as_object().cloned().unwrap_or_default();
            let sel = labels.iter().map(|(k, v)| format!("{k}={}", v.as_str().unwrap_or(""))).collect::<Vec<_>>().join(",");
            let mut list_args = vec!["get".to_string(), "replicasets".to_string(), "-n".to_string(), ns.clone(), "-o".to_string(), "json".to_string()];
            if !sel.is_empty() {
                list_args.extend(["-l".to_string(), sel]);
            }
            let rs: Value = serde_json::from_str(&kubectl(&list_args, &ctx).await?).map_err(|e| e.to_string())?;
            let mut revs: Vec<(i64, Vec<(String, String)>)> = rs["items"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|r| r["metadata"]["ownerReferences"].as_array().into_iter().flatten().any(|o| o["kind"] == "Deployment" && o["name"] == name.as_str()))
                .filter_map(|r| Some((r["metadata"]["annotations"]["deployment.kubernetes.io/revision"].as_str()?.parse().ok()?, container_images(&r["spec"]["template"]))))
                .collect();
            revs.sort_by_key(|r| r.0);
            let target = match revision {
                Some(r) if *r == current_rev => return Err(format!("revision {r} is already the current one")),
                Some(r) => revs.iter().find(|x| x.0 == *r).ok_or(format!("revision {r} not found (kept revisions: {})", revs.iter().map(|x| x.0.to_string()).collect::<Vec<_>>().join(", ")))?,
                None => revs.iter().rev().find(|x| x.0 < current_rev).ok_or("there is no earlier revision to roll back to")?,
            };
            p.changes.push(change("Revision", current_rev.to_string(), target.0.to_string()));
            let now = container_images(&dep["spec"]["template"]);
            for (c, img) in &target.1 {
                let old = now.iter().find(|(n, _)| n == c).map(|(_, i)| i.as_str()).unwrap_or("(none)");
                if old != img {
                    p.changes.push(change(format!("{c} image"), old, img.as_str()));
                }
            }
            if p.changes.len() == 1 {
                p.note = Some("The images are the same; the rollback restores the older pod template (env, resources, probes).".into());
            }
        }
        Action::DeletePod { name, ns } => {
            let pod = get_obj("pod", name, ns, &ctx).await?;
            let owner = pod["metadata"]["ownerReferences"].as_array().into_iter().flatten().find(|o| o["controller"] == true);
            let phase = pod["status"]["phase"].as_str().unwrap_or("Unknown");
            p.changes.push(change("Pod", format!("{name} ({phase})"), "deleted"));
            match owner {
                Some(o) => p.note = Some(format!("Owned by {} {}: a replacement pod is created automatically.", o["kind"].as_str().unwrap_or(""), o["name"].as_str().unwrap_or(""))),
                None => {
                    p.danger = true;
                    p.note = Some("This pod has no controller, so nothing recreates it.".into());
                }
            }
        }
        Action::SetImage { kind, name, ns, container, image } => {
            let obj = get_obj(kind, name, ns, &ctx).await?;
            let imgs = container_images(&obj["spec"]["template"]);
            let old = imgs
                .iter()
                .find(|(n, _)| n == container)
                .map(|(_, i)| i.clone())
                .ok_or(format!("{kind} {name} has no container {container:?} (containers: {})", imgs.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>().join(", ")))?;
            if &old == image {
                return Err(format!("container {container} already runs {image}"));
            }
            p.changes.push(change(format!("{container} image"), old, image.as_str()));
            p.note = Some("Starts a rolling update to the new image.".into());
        }
    }
    Ok(p)
}

/// Runs the change. Only called after the user approved this exact call.
pub async fn apply(tool: &str, args: &Value, default_ctx: &str) -> Result<String, String> {
    let ctx = context_arg(args, default_ctx)?;
    let action = parse(tool, args)?;
    let out = kubectl(&command(&action), ctx).await?;
    Ok(out.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_builds_commands() {
        let a = parse("scale_workload", &json!({ "kind": "Deployment", "name": "api", "namespace": "team", "replicas": 3 })).unwrap();
        assert_eq!(command(&a), ["scale", "deployment/api", "--replicas=3", "-n", "team"]);
        let a = parse("rollback_deployment", &json!({ "name": "api", "namespace": "team", "revision": 4 })).unwrap();
        assert_eq!(command(&a), ["rollout", "undo", "deployment/api", "-n", "team", "--to-revision=4"]);
        let a = parse("set_image", &json!({ "kind": "deployment", "name": "api", "namespace": "team", "container": "app", "image": "reg.io/app:1.4" })).unwrap();
        assert_eq!(command(&a), ["set", "image", "deployment/api", "app=reg.io/app:1.4", "-n", "team"]);
        assert_eq!(describe("delete_pod", &json!({ "name": "api-1", "namespace": "team" })), "Delete pod api-1 (team)");
    }

    #[test]
    fn rejects_unsafe_or_odd_arguments() {
        assert!(parse("scale_workload", &json!({ "kind": "deployment", "name": "api", "namespace": "team", "replicas": 500 })).is_err());
        assert!(parse("scale_workload", &json!({ "kind": "daemonset", "name": "api", "namespace": "team", "replicas": 1 })).is_err());
        assert!(parse("restart_workload", &json!({ "kind": "deployment", "name": "--all", "namespace": "team" })).is_err());
        assert!(parse("set_image", &json!({ "kind": "deployment", "name": "api", "namespace": "team", "container": "app", "image": "a b" })).is_err());
        assert!(parse("set_image", &json!({ "kind": "deployment", "name": "api", "namespace": "team", "container": "app", "image": "--x" })).is_err());
        assert!(parse("rollback_deployment", &json!({ "name": "api", "namespace": "team", "revision": 0 })).is_err());
        assert!(parse("delete_pod", &json!({ "name": "api-1" })).is_err());
        assert!(!is_action("get_logs") && is_action("delete_pod"));
    }
}
