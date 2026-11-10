//! TLS certificate expiry: reads every `kubernetes.io/tls` Secret, decodes `tls.crt` and
//! reports validity, names and which Ingresses serve it. Private keys are never read.
//!
//! `GET /api/certs?namespace=&context=`

use crate::{AppState, ResourceCache};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Deserialize)]
pub struct CertsQuery {
    namespace: Option<String>,
    context: Option<String>,
}

#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CertInfo {
    pub subject: String,
    pub common_name: Option<String>,
    pub dns_names: Vec<String>,
    pub issuer: String,
    pub not_before: i64,
    pub not_after: i64,
    pub self_signed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IngressUse {
    ingress: String,
    hosts: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CertEntry {
    namespace: String,
    name: String,
    /// Leaf certificate (first in tls.crt)
    #[serde(skip_serializing_if = "Option::is_none")]
    leaf: Option<CertInfo>,
    /// Earliest expiry in the bundle; an intermediate can expire before the leaf
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    days_left: Option<i64>,
    /// Set when a chain certificate (not the leaf) expires first
    #[serde(skip_serializing_if = "Option::is_none")]
    expiring_subject: Option<String>,
    chain_length: usize,
    /// cert-manager Certificate that renews this Secret, if any
    #[serde(skip_serializing_if = "Option::is_none")]
    managed_by: Option<String>,
    used_by: Vec<IngressUse>,
    /// Ingress refers to this Secret but it doesn't exist
    missing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Parses every certificate in a PEM bundle (or a single DER blob).
pub fn parse_bundle(bytes: &[u8]) -> Result<Vec<CertInfo>, String> {
    use x509_parser::prelude::*;
    let mut ders: Vec<Vec<u8>> = Vec::new();
    for pem in Pem::iter_from_buffer(bytes) {
        match pem {
            Ok(p) if p.label == "CERTIFICATE" => ders.push(p.contents),
            Ok(_) => {}
            Err(_) => break,
        }
    }
    if ders.is_empty() {
        // Some tools store DER without PEM armour
        ders.push(bytes.to_vec());
    }
    let mut out = Vec::new();
    for der in &ders {
        let (_, cert) = X509Certificate::from_der(der).map_err(|e| format!("not a valid certificate: {e}"))?;
        let common_name = cert.subject().iter_common_name().next().and_then(|cn| cn.as_str().ok()).map(str::to_string);
        let mut dns_names = Vec::new();
        if let Ok(Some(san)) = cert.subject_alternative_name() {
            for name in &san.value.general_names {
                match name {
                    GeneralName::DNSName(d) => dns_names.push(d.to_string()),
                    GeneralName::IPAddress(ip) if ip.len() == 4 => dns_names.push(format!("{}.{}.{}.{}", ip[0], ip[1], ip[2], ip[3])),
                    _ => {}
                }
            }
        }
        out.push(CertInfo {
            subject: cert.subject().to_string(),
            common_name,
            dns_names,
            issuer: cert.issuer().to_string(),
            not_before: cert.validity().not_before.timestamp(),
            not_after: cert.validity().not_after.timestamp(),
            self_signed: cert.subject() == cert.issuer(),
        });
    }
    Ok(out)
}

fn days_until(ts: i64, now: i64) -> i64 {
    // Floor, so "expires in 20 hours" reads as 0 days left
    (ts - now).div_euclid(86_400)
}

async fn kubectl_json(cache: &ResourceCache, key: String, args: Vec<String>, ctx: &str) -> Result<Value, String> {
    let bytes = cache.fetch(key, 30, args, ctx.to_string()).await?;
    serde_json::from_slice(&bytes).map_err(|e| format!("unexpected kubectl output: {e}"))
}

fn scope_args(mut args: Vec<String>, ns: Option<&str>) -> Vec<String> {
    match ns {
        Some(n) => args.extend(["-n".to_string(), n.to_string()]),
        None => args.push("-A".to_string()),
    }
    args
}

pub async fn handle_certs(
    Query(q): Query<CertsQuery>,
    State(state): State<AppState>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let current = state.ctx().await;
    let ctx = q.context.as_deref().filter(|c| !c.is_empty()).unwrap_or(&current).to_string();
    let ns = q.namespace.as_deref().filter(|n| !n.is_empty() && *n != "_all");
    if let Some(n) = ns {
        if !crate::valid_k8s_name(n) {
            return Err((StatusCode::BAD_REQUEST, format!("Invalid namespace '{n}'")));
        }
    }
    let scope = ns.unwrap_or("_all");

    let secrets_args = scope_args(
        vec!["get".into(), "secrets".into(), "--field-selector".into(), "type=kubernetes.io/tls".into(), "-o".into(), "json".into()],
        ns,
    );
    let ingress_args = scope_args(vec!["get".into(), "ingresses".into(), "-o".into(), "json".into()], ns);
    let (secrets, ingresses) = tokio::join!(
        kubectl_json(&state.cache, format!("certs:{ctx}:{scope}"), secrets_args, &ctx),
        kubectl_json(&state.cache, format!("k8s:{ctx}:ingresses:{scope}:certs"), ingress_args, &ctx),
    );
    let secrets = secrets.map_err(|e| (StatusCode::BAD_GATEWAY, e.trim().to_string()))?;
    // Ingresses are optional context; a cluster without the API still lists certificates
    let ingresses = ingresses.unwrap_or_else(|_| json!({ "items": [] }));

    // (namespace, secret) -> ingresses serving it
    let mut uses: HashMap<(String, String), Vec<IngressUse>> = HashMap::new();
    for ing in ingresses["items"].as_array().into_iter().flatten() {
        let ing_ns = ing["metadata"]["namespace"].as_str().unwrap_or("default").to_string();
        let ing_name = ing["metadata"]["name"].as_str().unwrap_or("").to_string();
        for tls in ing["spec"]["tls"].as_array().into_iter().flatten() {
            let Some(secret) = tls["secretName"].as_str() else { continue };
            let hosts = tls["hosts"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
            uses.entry((ing_ns.clone(), secret.to_string())).or_default().push(IngressUse { ingress: ing_name.clone(), hosts });
        }
    }

    let now = now_secs();
    let engine = base64::engine::general_purpose::STANDARD;
    let mut items = Vec::new();
    for s in secrets["items"].as_array().into_iter().flatten() {
        let namespace = s["metadata"]["namespace"].as_str().unwrap_or("default").to_string();
        let name = s["metadata"]["name"].as_str().unwrap_or("").to_string();
        let managed_by = s["metadata"]["annotations"]["cert-manager.io/certificate-name"].as_str().map(str::to_string);
        let used_by = uses.remove(&(namespace.clone(), name.clone())).unwrap_or_default();
        let mut entry = CertEntry { namespace, name, leaf: None, expires_at: None, days_left: None, expiring_subject: None, chain_length: 0, managed_by, used_by, missing: false, error: None };

        let parsed = s["data"]["tls.crt"]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| "tls.crt is empty".to_string())
            .and_then(|b64| engine.decode(b64).map_err(|e| format!("tls.crt is not base64: {e}")))
            .and_then(|bytes| parse_bundle(&bytes));
        match parsed {
            Ok(chain) if !chain.is_empty() => {
                let first = chain.iter().enumerate().min_by_key(|(_, c)| c.not_after).map(|(i, c)| (i, c.not_after, c.subject.clone())).unwrap();
                entry.expires_at = Some(first.1);
                entry.days_left = Some(days_until(first.1, now));
                if first.0 != 0 {
                    entry.expiring_subject = Some(first.2);
                }
                entry.chain_length = chain.len();
                entry.leaf = chain.into_iter().next();
            }
            Ok(_) => entry.error = Some("no certificate in tls.crt".into()),
            Err(e) => entry.error = Some(e),
        }
        items.push(entry);
    }

    // Ingresses pointing at Secrets that don't exist (TLS silently falls back to a default cert)
    let mut missing: Vec<_> = uses.into_iter().collect();
    missing.sort_by(|a, b| a.0.cmp(&b.0));
    for ((namespace, name), used_by) in missing {
        items.push(CertEntry { namespace, name, leaf: None, expires_at: None, days_left: None, expiring_subject: None, chain_length: 0, managed_by: None, used_by, missing: true, error: None });
    }

    items.sort_by(|a, b| a.expires_at.unwrap_or(i64::MAX).cmp(&b.expires_at.unwrap_or(i64::MAX)).then(a.name.cmp(&b.name)));
    Ok(Json(json!({ "items": items, "now": now })))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Throwaway self-signed certificate (key discarded): CN and SANs example.test / www.example.test,
    // valid 2026-11-10 13:05:06 .. 2036-11-07 13:05:06 UTC
    const PEM: &str = "-----BEGIN CERTIFICATE-----
MIIBrzCCAVSgAwIBAgIUOKvZhdJ1qToxCOwwdK3ltqJlRp0wCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMZXhhbXBsZS50ZXN0MB4XDTI2MTExMDEzMDUwNloXDTM2MTEw
NzEzMDUwNlowFzEVMBMGA1UEAwwMZXhhbXBsZS50ZXN0MFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAEquVSIeuXj/6ODWijT62FnWTroSzKGjFo7plo2W0IpF22LL5r
+3r+11pO7fpdEE1SYaGOSlu0921gyoBYeyWpVaN+MHwwHQYDVR0OBBYEFLdrxVBY
lXRLWhJtilCTAhnSD+AVMB8GA1UdIwQYMBaAFLdrxVBYlXRLWhJtilCTAhnSD+AV
MA8GA1UdEwEB/wQFMAMBAf8wKQYDVR0RBCIwIIIMZXhhbXBsZS50ZXN0ghB3d3cu
ZXhhbXBsZS50ZXN0MAoGCCqGSM49BAMCA0kAMEYCIQCeVLw6jfL2idY/7OCwDzTQ
LA4wo7S07EceKzm7H1+RBQIhAKSOGhkf+Zbh8xMxrnNPq6KhBa/Ztnc+HLgNtuRr
pBQR
-----END CERTIFICATE-----
";

    #[test]
    fn reads_names_and_validity() {
        let chain = parse_bundle(PEM.as_bytes()).unwrap();
        assert_eq!(chain.len(), 1);
        let c = &chain[0];
        assert_eq!(c.common_name.as_deref(), Some("example.test"));
        assert_eq!(c.dns_names, vec!["example.test", "www.example.test"]);
        assert_eq!(c.not_before, 1_794_315_906);
        assert_eq!(c.not_after, 2_109_675_906);
        assert!(c.self_signed);

        // A bundle (leaf + chain) yields every certificate in order
        let bundle = format!("{PEM}{PEM}");
        assert_eq!(parse_bundle(bundle.as_bytes()).unwrap().len(), 2);
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_bundle(b"not a cert").is_err());
        let truncated = &PEM[..300];
        assert!(parse_bundle(truncated.as_bytes()).is_err());
    }

    #[test]
    fn floors_days_left() {
        let now = 1_000_000;
        assert_eq!(days_until(now + 20 * 3600, now), 0);
        assert_eq!(days_until(now + 86_400 * 7, now), 7);
        assert_eq!(days_until(now - 3600, now), -1);
    }
}
