//! Read-only cluster tools shared by the in-app assistant and the MCP server.
//!
//! Every tool runs `kubectl` with validated arguments (never a shell), and its output is
//! masked with `redact` unless the user explicitly allowed that one call to reveal data.

use super::redact;
use crate::run_kubectl_cmd;
use regex::Regex;
use serde_json::{json, Value};
use std::sync::OnceLock;

/// Upper bound on characters returned to the model per tool call
const MAX_OUTPUT_CHARS: usize = 15_000;

pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub schema: Value,
    /// Accepts `reveal: true` to return unmasked data (only after the user agrees)
    pub can_reveal: bool,
}

pub struct ToolOutput {
    pub text: String,
    pub redacted: usize,
    pub truncated: bool,
}

fn prop(kind: &str, description: &str) -> Value {
    json!({ "type": kind, "description": description })
}

const REVEAL_DESC: &str = "Set true ONLY if masked values are essential to answer. The user is asked for permission first; default false.";
const CONTEXT_DESC: &str = "kubeconfig context (cluster). Defaults to the one the user is working in.";

pub fn specs() -> &'static [ToolSpec] {
    static SPECS: OnceLock<Vec<ToolSpec>> = OnceLock::new();
    SPECS.get_or_init(|| {
        vec![
            ToolSpec {
                name: "list_contexts",
                description: "List the kubeconfig contexts (clusters) available and which one is current.",
                schema: json!({ "type": "object", "properties": {} }),
                can_reveal: false,
            },
            ToolSpec {
                name: "list_resources",
                description: "List Kubernetes resources of one kind as a table (kubectl get -o wide): status, readiness, restarts, age, node, images. Use for an overview before drilling in.",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "kind": prop("string", "Resource kind, e.g. pods, deployments, statefulsets, services, ingresses, configmaps, nodes, jobs, pvc, or a CRD plural"),
                        "namespace": prop("string", "Namespace; omit for all namespaces"),
                        "label_selector": prop("string", "Optional label selector, e.g. app=api,tier=web"),
                        "context": prop("string", CONTEXT_DESC),
                    },
                    "required": ["kind"],
                }),
                can_reveal: false,
            },
            ToolSpec {
                name: "describe_resource",
                description: "kubectl describe one resource: conditions, container states, restart reasons, probes, mounts and recent events. Best first step to diagnose a failing pod or deployment.",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "kind": prop("string", "Resource kind, e.g. pod, deployment, node"),
                        "name": prop("string", "Resource name"),
                        "namespace": prop("string", "Namespace (omit for cluster-scoped kinds such as nodes)"),
                        "reveal": prop("boolean", REVEAL_DESC),
                        "context": prop("string", CONTEXT_DESC),
                    },
                    "required": ["kind", "name"],
                }),
                can_reveal: true,
            },
            ToolSpec {
                name: "get_manifest",
                description: "Full JSON manifest of one resource (spec + status). Secret values and credentials are masked unless revealed.",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "kind": prop("string", "Resource kind"),
                        "name": prop("string", "Resource name"),
                        "namespace": prop("string", "Namespace (omit for cluster-scoped kinds)"),
                        "reveal": prop("boolean", REVEAL_DESC),
                        "context": prop("string", CONTEXT_DESC),
                    },
                    "required": ["kind", "name"],
                }),
                can_reveal: true,
            },
            ToolSpec {
                name: "get_logs",
                description: "Container logs of a pod. Use previous=true for the instance that crashed/restarted, since for a time window, tail to limit lines.",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "pod": prop("string", "Pod name"),
                        "namespace": prop("string", "Namespace of the pod"),
                        "container": prop("string", "Container name (needed for multi-container pods)"),
                        "tail": prop("integer", "Number of most recent lines, 1-1000 (default 200)"),
                        "previous": prop("boolean", "Logs of the previous (terminated) container instance"),
                        "since": prop("string", "Relative window such as 15m or 2h"),
                        "reveal": prop("boolean", REVEAL_DESC),
                        "context": prop("string", CONTEXT_DESC),
                    },
                    "required": ["pod", "namespace"],
                }),
                can_reveal: true,
            },
            ToolSpec {
                name: "get_events",
                description: "Recent Kubernetes events (warnings, scheduling, image pulls, kills), newest last. Optionally only for one object.",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "namespace": prop("string", "Namespace; omit for all namespaces"),
                        "object_name": prop("string", "Only events about this object (e.g. a pod name)"),
                        "context": prop("string", CONTEXT_DESC),
                    },
                }),
                can_reveal: false,
            },
            ToolSpec {
                name: "get_metrics",
                description: "Live CPU / memory usage from metrics-server (kubectl top) for pods or nodes.",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "resource": { "type": "string", "enum": ["pods", "nodes"], "description": "pods or nodes" },
                        "namespace": prop("string", "Namespace for pods; omit for all"),
                        "context": prop("string", CONTEXT_DESC),
                    },
                    "required": ["resource"],
                }),
                can_reveal: false,
            },
        ]
    })
}

pub fn find(name: &str) -> Option<&'static ToolSpec> {
    specs().iter().find(|t| t.name == name)
}

/// True when this call asks for unmasked data and therefore needs the user's permission.
pub fn wants_reveal(name: &str, args: &Value) -> bool {
    find(name).map(|t| t.can_reveal).unwrap_or(false) && args.get("reveal").and_then(Value::as_bool).unwrap_or(false)
}

/// Short human-readable description of a call, for activity rows and permission prompts.
pub fn describe_call(name: &str, args: &Value) -> String {
    let s = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("");
    let ns = |k: &str| {
        let v = s(k);
        if v.is_empty() { "all namespaces".to_string() } else { v.to_string() }
    };
    match name {
        "list_contexts" => "List clusters".to_string(),
        "list_resources" => format!("List {} in {}", s("kind"), ns("namespace")),
        "describe_resource" => format!("Describe {} {}{}", s("kind"), s("name"), in_ns(s("namespace"))),
        "get_manifest" => format!("Manifest of {} {}{}", s("kind"), s("name"), in_ns(s("namespace"))),
        "get_logs" => format!(
            "{}logs of {}{}",
            if args.get("previous").and_then(Value::as_bool).unwrap_or(false) { "Previous " } else { "" },
            s("pod"),
            in_ns(s("namespace"))
        ),
        "get_events" => {
            if s("object_name").is_empty() { format!("Events in {}", ns("namespace")) } else { format!("Events for {}", s("object_name")) }
        }
        "get_metrics" => format!("CPU / memory of {}", s("resource")),
        other => other.to_string(),
    }
}

fn in_ns(ns: &str) -> String {
    if ns.is_empty() { String::new() } else { format!(" ({ns})") }
}

// ---------------------------------------------------------------------------
// Argument validation: values become separate argv entries (no shell), so the risk is
// flag injection (a value starting with '-') and nonsense; both are rejected here.
// ---------------------------------------------------------------------------

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap()
}

fn name_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| re(r"^[A-Za-z0-9]([A-Za-z0-9._:-]{0,252})$"))
}

fn selector_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| re(r"^[A-Za-z0-9][A-Za-z0-9._/=!, ()-]{0,252}$"))
}

fn since_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| re(r"^[0-9]{1,5}[smh]$"))
}

fn arg<'a>(args: &'a Value, key: &str, required: bool, check: &Regex) -> Result<Option<&'a str>, String> {
    match args.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()) {
        Some(v) if check.is_match(v) => Ok(Some(v)),
        Some(v) => Err(format!("invalid {key}: {v:?}")),
        None if required => Err(format!("missing required argument: {key}")),
        None => Ok(None),
    }
}

fn context_arg<'a>(args: &'a Value, default_ctx: &'a str) -> Result<&'a str, String> {
    match args.get("context").and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()) {
        Some(c) if c.starts_with('-') || c.len() > 300 || c.chars().any(char::is_control) => Err(format!("invalid context: {c:?}")),
        Some(c) => Ok(c),
        None => Ok(default_ctx),
    }
}

fn push_namespace(cmd: &mut Vec<String>, ns: Option<&str>) {
    match ns {
        Some(ns) => cmd.extend(["-n".to_string(), ns.to_string()]),
        None => cmd.push("-A".to_string()),
    }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/// Runs one tool. `reveal` must only be true after the user approved this exact call.
pub async fn execute(name: &str, args: &Value, default_ctx: &str, reveal: bool) -> Result<ToolOutput, String> {
    let ctx = context_arg(args, default_ctx)?;
    let mut tail_keep = false; // logs: keep the newest lines when truncating
    let raw = match name {
        "list_contexts" => {
            let names = run_kubectl_cmd(&["config", "get-contexts", "-o", "name"], "").await?;
            format!("Current context: {}\nAvailable contexts:\n{}", default_ctx, names.trim())
        }
        "list_resources" => {
            let kind = arg(args, "kind", true, name_re())?.unwrap();
            let mut cmd = vec!["get".to_string(), kind.to_string(), "-o".to_string(), "wide".to_string()];
            push_namespace(&mut cmd, arg(args, "namespace", false, name_re())?);
            if let Some(sel) = arg(args, "label_selector", false, selector_re())? {
                cmd.extend(["-l".to_string(), sel.to_string()]);
            }
            kubectl(&cmd, ctx).await?
        }
        "describe_resource" => {
            let kind = arg(args, "kind", true, name_re())?.unwrap();
            let rname = arg(args, "name", true, name_re())?.unwrap();
            let mut cmd = vec!["describe".to_string(), kind.to_string(), rname.to_string()];
            if let Some(ns) = arg(args, "namespace", false, name_re())? {
                cmd.extend(["-n".to_string(), ns.to_string()]);
            }
            kubectl(&cmd, ctx).await?
        }
        "get_manifest" => {
            let kind = arg(args, "kind", true, name_re())?.unwrap();
            let rname = arg(args, "name", true, name_re())?.unwrap();
            let mut cmd = vec!["get".to_string(), kind.to_string(), rname.to_string(), "-o".to_string(), "json".to_string()];
            if let Some(ns) = arg(args, "namespace", false, name_re())? {
                cmd.extend(["-n".to_string(), ns.to_string()]);
            }
            let text = kubectl(&cmd, ctx).await?;
            let mut obj: Value = serde_json::from_str(&text).map_err(|e| format!("unexpected kubectl output: {e}"))?;
            let masked_secret = sanitize_manifest(&mut obj, reveal);
            let mut out = serde_json::to_string_pretty(&obj).unwrap_or(text);
            if masked_secret > 0 {
                out.push_str(&format!("\n\n[{masked_secret} Secret value(s) masked]"));
                // Count them so the caller reports them like text redactions
                return finish(out, masked_secret, false, reveal);
            }
            out
        }
        "get_logs" => {
            let pod = arg(args, "pod", true, name_re())?.unwrap();
            let ns = arg(args, "namespace", true, name_re())?.unwrap();
            let tail = args.get("tail").and_then(Value::as_u64).unwrap_or(200).clamp(1, 1000);
            let mut cmd = vec!["logs".to_string(), pod.to_string(), "-n".to_string(), ns.to_string(), format!("--tail={tail}")];
            if let Some(c) = arg(args, "container", false, name_re())? {
                cmd.extend(["-c".to_string(), c.to_string()]);
            }
            if args.get("previous").and_then(Value::as_bool).unwrap_or(false) {
                cmd.push("--previous".to_string());
            }
            if let Some(since) = arg(args, "since", false, since_re())? {
                cmd.push(format!("--since={since}"));
            }
            tail_keep = true;
            let text = kubectl(&cmd, ctx).await?;
            if text.trim().is_empty() { "(no log lines)".to_string() } else { text }
        }
        "get_events" => {
            let mut cmd = vec!["get".to_string(), "events".to_string(), "--sort-by=.lastTimestamp".to_string()];
            push_namespace(&mut cmd, arg(args, "namespace", false, name_re())?);
            if let Some(obj) = arg(args, "object_name", false, name_re())? {
                cmd.push(format!("--field-selector=involvedObject.name={obj}"));
            }
            tail_keep = true;
            let text = kubectl(&cmd, ctx).await?;
            if text.trim().is_empty() { "No events found.".to_string() } else { text }
        }
        "get_metrics" => {
            let resource = match args.get("resource").and_then(Value::as_str) {
                Some(r @ ("pods" | "nodes")) => r,
                _ => return Err("resource must be \"pods\" or \"nodes\"".to_string()),
            };
            let mut cmd = vec!["top".to_string(), resource.to_string()];
            if resource == "pods" {
                push_namespace(&mut cmd, arg(args, "namespace", false, name_re())?);
            }
            kubectl(&cmd, ctx).await.map_err(|e| format!("{e}\n(metrics-server may not be installed in this cluster)"))?
        }
        other => return Err(format!("unknown tool: {other}")),
    };
    finish(raw, 0, tail_keep, reveal)
}

async fn kubectl(cmd: &[String], ctx: &str) -> Result<String, String> {
    let refs: Vec<&str> = cmd.iter().map(String::as_str).collect();
    run_kubectl_cmd(&refs, ctx).await.map_err(|e| e.trim().to_string())
}

/// Masks (unless revealed) and truncates tool output.
fn finish(raw: String, already_masked: usize, keep_tail: bool, reveal: bool) -> Result<ToolOutput, String> {
    let (text, redacted) = if reveal { (raw, 0) } else { redact::redact(&raw) };
    let redacted = redacted + already_masked;
    let (mut text, truncated) = truncate(text, keep_tail);
    if redacted > 0 {
        text.push_str(&format!(
            "\n\n[{redacted} sensitive value(s) shown as [REDACTED]. Only if they are essential, call the tool again with reveal=true; the user will be asked to allow it.]"
        ));
    }
    Ok(ToolOutput { text, redacted, truncated })
}

fn truncate(text: String, keep_tail: bool) -> (String, bool) {
    if text.chars().count() <= MAX_OUTPUT_CHARS {
        return (text, false);
    }
    let chars: Vec<char> = text.chars().collect();
    let kept: String = if keep_tail {
        chars[chars.len() - MAX_OUTPUT_CHARS..].iter().collect()
    } else {
        chars[..MAX_OUTPUT_CHARS].iter().collect()
    };
    let note = format!("[output truncated: showing {} of {} characters]", MAX_OUTPUT_CHARS, chars.len());
    (if keep_tail { format!("{note}\n{kept}") } else { format!("{kept}\n{note}") }, true)
}

/// Drops noise and secret material from a manifest. Returns how many Secret values were
/// masked (always 0 when `reveal`).
fn sanitize_manifest(obj: &mut Value, reveal: bool) -> usize {
    if let Some(meta) = obj.get_mut("metadata").and_then(Value::as_object_mut) {
        meta.remove("managedFields");
        // kubectl apply stores the whole previous manifest here, Secret data included
        if let Some(ann) = meta.get_mut("annotations").and_then(Value::as_object_mut) {
            ann.remove("kubectl.kubernetes.io/last-applied-configuration");
        }
    }
    if reveal || obj.get("kind").and_then(Value::as_str) != Some("Secret") {
        return 0;
    }
    let mut masked = 0;
    for field in ["data", "stringData"] {
        if let Some(map) = obj.get_mut(field).and_then(Value::as_object_mut) {
            for v in map.values_mut() {
                let len = v.as_str().map(str::len).unwrap_or(0);
                *v = Value::String(format!("[REDACTED: {len} chars]"));
                masked += 1;
            }
        }
    }
    masked
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_arguments() {
        let r = name_re();
        assert!(arg(&json!({"kind": "pods"}), "kind", true, r).is_ok());
        assert!(arg(&json!({"kind": "deployments.apps"}), "kind", true, r).is_ok());
        assert!(arg(&json!({"kind": "--kubeconfig=/tmp/x"}), "kind", true, r).is_err());
        assert!(arg(&json!({"name": "a b"}), "name", true, r).is_err());
        assert!(arg(&json!({}), "name", true, r).is_err());
        assert_eq!(arg(&json!({}), "namespace", false, r).unwrap(), None);
        assert!(arg(&json!({"since": "15m"}), "since", false, since_re()).is_ok());
        assert!(arg(&json!({"since": "15 minutes"}), "since", false, since_re()).is_err());
        assert!(context_arg(&json!({"context": "-x"}), "dflt").is_err());
        assert_eq!(context_arg(&json!({}), "dflt").unwrap(), "dflt");
        assert_eq!(context_arg(&json!({"context": "arn:aws:eks:eu-west-1:1:cluster/prod"}), "d").unwrap(), "arn:aws:eks:eu-west-1:1:cluster/prod");
    }

    #[test]
    fn masks_secret_manifests() {
        let mut secret = json!({
            "kind": "Secret",
            "metadata": { "name": "db", "annotations": { "kubectl.kubernetes.io/last-applied-configuration": "{\"data\":{\"password\":\"aHVudGVyMg==\"}}" }, "managedFields": [] },
            "data": { "password": "aHVudGVyMg==", "user": "YXBw" }
        });
        assert_eq!(sanitize_manifest(&mut secret, false), 2);
        assert_eq!(secret["data"]["password"], "[REDACTED: 12 chars]");
        assert!(secret["metadata"].get("managedFields").is_none());
        assert!(secret["metadata"]["annotations"].get("kubectl.kubernetes.io/last-applied-configuration").is_none());

        let mut revealed = json!({ "kind": "Secret", "metadata": {}, "data": { "password": "aHVudGVyMg==" } });
        assert_eq!(sanitize_manifest(&mut revealed, true), 0);
        assert_eq!(revealed["data"]["password"], "aHVudGVyMg==");
    }

    #[test]
    fn reveal_needs_capable_tool_and_flag() {
        assert!(wants_reveal("get_logs", &json!({"reveal": true})));
        assert!(!wants_reveal("get_logs", &json!({})));
        assert!(!wants_reveal("list_resources", &json!({"reveal": true})));
    }

    #[test]
    fn truncation_keeps_the_right_end() {
        let long = "a".repeat(MAX_OUTPUT_CHARS) + "TAIL";
        let (head, t1) = truncate(long.clone(), false);
        assert!(t1 && !head.contains("TAIL"));
        let (tail, t2) = truncate(long, true);
        assert!(t2 && tail.ends_with("TAIL"));
    }
}
