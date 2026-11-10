//! "Who can do what": joins Roles, ClusterRoles and their bindings into one index of
//! subjects (users, groups, service accounts) and the rules they hold. The UI answers both
//! "what can X do" and "who can do Y" from it. Computed from RBAC objects, so it needs no
//! impersonation rights; webhook / ABAC authorizers aren't visible this way.
//!
//! `GET /api/rbac?context=`

use crate::AppState;
use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};

#[derive(Deserialize)]
pub struct RbacQuery {
    context: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    verbs: Vec<String>,
    api_groups: Vec<String>,
    resources: Vec<String>,
    resource_names: Vec<String>,
    non_resource_urls: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    /// "*" for a ClusterRoleBinding (every namespace + cluster-scoped), else the namespace
    scope: String,
    binding_kind: String,
    binding_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    binding_namespace: Option<String>,
    /// Key into `roles`: "ClusterRole/<name>" or "Role/<namespace>/<name>"
    role: String,
    role_missing: bool,
    /// Set when the subject gets this through a group it is implicitly in
    #[serde(skip_serializing_if = "Option::is_none")]
    via_group: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Subject {
    kind: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    namespace: Option<String>,
    grants: Vec<Grant>,
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

fn rules_of(role: &Value) -> Vec<Rule> {
    role["rules"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| Rule {
            verbs: strings(&r["verbs"]),
            api_groups: strings(&r["apiGroups"]),
            resources: strings(&r["resources"]),
            resource_names: strings(&r["resourceNames"]),
            non_resource_urls: strings(&r["nonResourceURLs"]),
        })
        .collect()
}

/// Builds the index from `kubectl get roles,clusterroles,rolebindings,clusterrolebindings -A`
/// items plus the service accounts (so accounts without any binding are listed too).
pub fn build(items: &[Value], service_accounts: &[Value]) -> (BTreeMap<String, Vec<Rule>>, Vec<Subject>) {
    let mut roles: BTreeMap<String, Vec<Rule>> = BTreeMap::new();
    for it in items {
        let name = it["metadata"]["name"].as_str().unwrap_or("");
        match it["kind"].as_str() {
            Some("ClusterRole") => {
                roles.insert(format!("ClusterRole/{name}"), rules_of(it));
            }
            Some("Role") => {
                let ns = it["metadata"]["namespace"].as_str().unwrap_or("default");
                roles.insert(format!("Role/{ns}/{name}"), rules_of(it));
            }
            _ => {}
        }
    }

    // subject key -> subject
    let mut subjects: BTreeMap<(String, String, String), Subject> = BTreeMap::new();
    let mut entry = |kind: &str, name: &str, ns: Option<&str>| -> (String, String, String) {
        let key = (kind.to_string(), ns.unwrap_or("").to_string(), name.to_string());
        subjects.entry(key.clone()).or_insert_with(|| Subject { kind: kind.to_string(), name: name.to_string(), namespace: ns.map(str::to_string), grants: Vec::new() });
        key
    };
    let mut grants: Vec<((String, String, String), Grant)> = Vec::new();

    for b in items {
        let binding_kind = match b["kind"].as_str() {
            Some(k @ ("RoleBinding" | "ClusterRoleBinding")) => k,
            _ => continue,
        };
        let binding_ns = b["metadata"]["namespace"].as_str();
        let role_kind = b["roleRef"]["kind"].as_str().unwrap_or("ClusterRole");
        let role_name = b["roleRef"]["name"].as_str().unwrap_or("");
        let role = if role_kind == "Role" {
            format!("Role/{}/{role_name}", binding_ns.unwrap_or("default"))
        } else {
            format!("ClusterRole/{role_name}")
        };
        let scope = if binding_kind == "ClusterRoleBinding" { "*".to_string() } else { binding_ns.unwrap_or("default").to_string() };
        for s in b["subjects"].as_array().into_iter().flatten() {
            let kind = s["kind"].as_str().unwrap_or("User");
            let name = s["name"].as_str().unwrap_or("");
            // A service account subject without a namespace means the binding's namespace
            let ns = if kind == "ServiceAccount" { Some(s["namespace"].as_str().or(binding_ns).unwrap_or("default")) } else { None };
            let key = entry(kind, name, ns);
            grants.push((key, Grant {
                scope: scope.clone(),
                binding_kind: binding_kind.to_string(),
                binding_name: b["metadata"]["name"].as_str().unwrap_or("").to_string(),
                binding_namespace: binding_ns.map(str::to_string),
                role: role.clone(),
                role_missing: !roles.contains_key(&role),
                via_group: None,
            }));
        }
    }
    for sa in service_accounts {
        let name = sa["metadata"]["name"].as_str().unwrap_or("");
        entry("ServiceAccount", name, Some(sa["metadata"]["namespace"].as_str().unwrap_or("default")));
    }

    // Direct grants first
    let mut by_group: HashMap<String, Vec<Grant>> = HashMap::new();
    for (key, g) in grants {
        if key.0 == "Group" {
            by_group.entry(key.2.clone()).or_default().push(g.clone());
        }
        if let Some(s) = subjects.get_mut(&key) {
            s.grants.push(g);
        }
    }
    // Implicit groups: every service account is in system:serviceaccounts and
    // system:serviceaccounts:<ns>; every user and service account is in system:authenticated
    for s in subjects.values_mut() {
        let groups: Vec<String> = match s.kind.as_str() {
            "ServiceAccount" => vec![
                "system:serviceaccounts".to_string(),
                format!("system:serviceaccounts:{}", s.namespace.as_deref().unwrap_or("default")),
                "system:authenticated".to_string(),
            ],
            "User" => vec!["system:authenticated".to_string()],
            _ => continue,
        };
        for g in groups {
            for grant in by_group.get(&g).into_iter().flatten() {
                s.grants.push(Grant { via_group: Some(g.clone()), ..grant.clone() });
            }
        }
    }
    (roles, subjects.into_values().collect())
}

pub async fn handle_rbac(Query(q): Query<RbacQuery>, State(state): State<AppState>) -> Result<Json<Value>, (StatusCode, String)> {
    let current = state.ctx().await;
    let ctx = q.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current).to_string();
    let rbac_args = ["get", "roles,clusterroles,rolebindings,clusterrolebindings", "-A", "-o", "json"].map(String::from).to_vec();
    let sa_args = ["get", "serviceaccounts", "-A", "-o", "json"].map(String::from).to_vec();
    let (rbac, sas) = tokio::join!(
        state.cache.fetch(format!("rbac:{ctx}"), 30, rbac_args, ctx.clone()),
        state.cache.fetch(format!("k8s:{ctx}:serviceaccounts:_all"), 30, sa_args, ctx.clone()),
    );
    let rbac = rbac.map_err(|e| (StatusCode::BAD_GATEWAY, e.trim().to_string()))?;
    let parse = |b: &[u8]| -> Vec<Value> {
        serde_json::from_slice::<Value>(b).ok().and_then(|v| v["items"].as_array().cloned()).unwrap_or_default()
    };
    let items = parse(&rbac);
    // Listing service accounts is a convenience; RBAC alone still answers
    let sa_items = sas.map(|b| parse(&b)).unwrap_or_default();
    let (roles, subjects) = build(&items, &sa_items);
    Ok(Json(json!({ "roles": roles, "subjects": subjects })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_bindings_roles_and_implicit_groups() {
        let items = vec![
            json!({ "kind": "ClusterRole", "metadata": { "name": "view" }, "rules": [{ "verbs": ["get", "list"], "apiGroups": [""], "resources": ["pods"] }] }),
            json!({ "kind": "Role", "metadata": { "name": "secret-reader", "namespace": "team" }, "rules": [{ "verbs": ["get"], "apiGroups": [""], "resources": ["secrets"], "resourceNames": ["db"] }] }),
            json!({ "kind": "RoleBinding", "metadata": { "name": "read-db", "namespace": "team" },
                    "roleRef": { "kind": "Role", "name": "secret-reader" },
                    "subjects": [{ "kind": "ServiceAccount", "name": "api" }, { "kind": "User", "name": "alice@example.com" }] }),
            json!({ "kind": "ClusterRoleBinding", "metadata": { "name": "all-sa-view" },
                    "roleRef": { "kind": "ClusterRole", "name": "view" },
                    "subjects": [{ "kind": "Group", "name": "system:serviceaccounts:team" }] }),
            json!({ "kind": "RoleBinding", "metadata": { "name": "dangling", "namespace": "team" },
                    "roleRef": { "kind": "ClusterRole", "name": "gone" }, "subjects": [{ "kind": "User", "name": "bob" }] }),
        ];
        let sas = vec![json!({ "metadata": { "name": "idle", "namespace": "other" } })];
        let (roles, subjects) = build(&items, &sas);
        assert_eq!(roles.len(), 2);
        assert_eq!(roles["Role/team/secret-reader"][0].resource_names, vec!["db"]);

        let find = |kind: &str, name: &str| subjects.iter().find(|s| s.kind == kind && s.name == name).unwrap();
        let api = find("ServiceAccount", "api");
        // Subject without a namespace takes the binding's namespace
        assert_eq!(api.namespace.as_deref(), Some("team"));
        assert_eq!(api.grants.len(), 2);
        assert!(api.grants.iter().any(|g| g.role == "Role/team/secret-reader" && g.scope == "team" && g.via_group.is_none()));
        assert!(api.grants.iter().any(|g| g.role == "ClusterRole/view" && g.scope == "*" && g.via_group.as_deref() == Some("system:serviceaccounts:team")));

        // Unbound service accounts are listed with no grants
        assert!(find("ServiceAccount", "idle").grants.is_empty());
        // Users don't inherit service-account groups
        assert_eq!(find("User", "alice@example.com").grants.len(), 1);
        assert!(find("User", "bob").grants[0].role_missing);
        assert_eq!(find("Group", "system:serviceaccounts:team").grants.len(), 1);
    }
}
