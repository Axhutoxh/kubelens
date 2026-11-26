//! Sends Kubellens alerts (pod problems, certificate expiry) to a Slack or Microsoft Teams
//! channel, or any HTTPS endpoint, through an incoming webhook. The webhook URL works like a
//! password, so it is kept in the user's config folder (0600 on macOS / Linux) and never sent
//! back to the UI in full.
//!
//! `GET|POST /api/notify/settings`, `POST /api/notify/test`, `POST /api/notify/send`

use axum::{http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

/// Alerts forwarded per minute at most (a crash-looping namespace can raise many at once)
const MAX_PER_MINUTE: usize = 20;

type ApiError = (StatusCode, String);

#[derive(Serialize, Deserialize, Clone, Default)]
struct NotifySettings {
    #[serde(default)]
    enabled: bool,
    /// slack | teams | generic
    #[serde(default)]
    kind: String,
    #[serde(default)]
    url: String,
}

fn path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("kubellens").join("notifications.json"))
}

fn load() -> NotifySettings {
    path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(s: &NotifySettings) -> Result<(), String> {
    let p = path().ok_or("no config directory")?;
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&p, serde_json::to_string_pretty(s).unwrap()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Host of an https URL, lower-cased
fn https_host(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let host = rest.split(['/', '?', '#']).next()?.split('@').last()?.split(':').next()?;
    (!host.is_empty()).then(|| host.to_lowercase())
}

/// Checks the URL fits the chosen service, so a typo can't send alerts somewhere unexpected.
pub fn validate(kind: &str, url: &str) -> Result<(), String> {
    if url.chars().any(char::is_whitespace) || url.len() > 2000 {
        return Err("That doesn't look like a webhook URL".into());
    }
    let host = https_host(url).ok_or("The webhook URL must start with https://")?;
    let ok = match kind {
        "slack" => host == "hooks.slack.com",
        // Teams incoming webhooks, and Power Automate / Teams workflow webhooks
        "teams" => host.ends_with(".webhook.office.com") || host.ends_with(".logic.azure.com") || host.ends_with(".powerplatform.com"),
        "generic" => true,
        _ => return Err("Choose Slack, Teams or a generic webhook".into()),
    };
    if ok {
        Ok(())
    } else {
        Err(match kind {
            "slack" => "Slack webhooks start with https://hooks.slack.com/".into(),
            _ => "Teams webhooks are on *.webhook.office.com, *.logic.azure.com or *.powerplatform.com".into(),
        })
    }
}

/// "https://hooks.slack.com/…/abcd" — enough to recognise it, not enough to use it
fn masked(url: &str) -> String {
    let host = https_host(url).unwrap_or_default();
    let tail: String = url.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    if host.is_empty() { String::new() } else { format!("https://{host}/…{tail}") }
}

pub fn payload(kind: &str, title: &str, text: &str, severity: &str, cluster: &str) -> Value {
    let color = match severity {
        "error" => "E11D48",
        "warning" => "F59E0B",
        _ => "22D3EE",
    };
    match kind {
        "slack" => json!({ "text": format!("*{title}*\n{text}\n_cluster: {cluster} · Kubellens_") }),
        "teams" => json!({
            "@type": "MessageCard",
            "@context": "https://schema.org/extensions",
            "summary": title,
            "themeColor": color,
            "title": title,
            "text": format!("{text}<br/><small>cluster: {cluster} · Kubellens</small>"),
        }),
        _ => json!({ "source": "kubellens", "title": title, "text": text, "severity": severity, "cluster": cluster }),
    }
}

fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).build().expect("HTTP client"))
}

async fn post(s: &NotifySettings, body: &Value) -> Result<(), String> {
    let res = client()
        .post(&s.url)
        .header("content-type", "application/json")
        .body(serde_json::to_vec(body).unwrap())
        .send()
        .await
        .map_err(|e| format!("Could not reach the webhook: {e}"))?;
    if res.status().is_success() {
        Ok(())
    } else {
        Err(format!("The webhook answered {}", res.status()))
    }
}

fn allow_send() -> bool {
    static SENT: OnceLock<Mutex<Vec<Instant>>> = OnceLock::new();
    let mut sent = SENT.get_or_init(Default::default).lock().unwrap();
    sent.retain(|t| t.elapsed().as_secs() < 60);
    if sent.len() >= MAX_PER_MINUTE {
        return false;
    }
    sent.push(Instant::now());
    true
}

pub async fn handle_get_settings() -> Json<Value> {
    let s = load();
    Json(json!({ "enabled": s.enabled, "kind": if s.kind.is_empty() { "slack" } else { s.kind.as_str() }, "configured": !s.url.is_empty(), "url": masked(&s.url) }))
}

#[derive(Deserialize)]
pub struct SettingsRequest {
    enabled: bool,
    kind: String,
    /// Empty keeps the saved URL
    #[serde(default)]
    url: String,
}

pub async fn handle_save_settings(Json(req): Json<SettingsRequest>) -> Result<Json<Value>, ApiError> {
    let mut s = load();
    let url = req.url.trim();
    let url = if url.is_empty() { s.url.clone() } else { url.to_string() };
    if req.enabled || !url.is_empty() {
        if url.is_empty() {
            return Err((StatusCode::BAD_REQUEST, "Paste the webhook URL".into()));
        }
        validate(&req.kind, &url).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    }
    s.enabled = req.enabled;
    s.kind = req.kind;
    s.url = url;
    save(&s).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(handle_get_settings().await)
}

pub async fn handle_test() -> Result<Json<Value>, ApiError> {
    let s = load();
    if s.url.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Save a webhook URL first".into()));
    }
    let body = payload(&s.kind, "Kubellens test alert", "Alerts from Kubellens will appear here.", "info", "-");
    post(&s, &body).await.map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    Ok(Json(json!({ "success": true })))
}

#[derive(Deserialize)]
pub struct SendRequest {
    title: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    severity: String,
    #[serde(default)]
    cluster: String,
}

pub async fn handle_send(Json(req): Json<SendRequest>) -> Result<Json<Value>, ApiError> {
    let s = load();
    if !s.enabled || s.url.is_empty() {
        return Ok(Json(json!({ "sent": false, "reason": "off" })));
    }
    if !allow_send() {
        return Ok(Json(json!({ "sent": false, "reason": "rate limited" })));
    }
    let clip = |t: &str, n: usize| t.chars().take(n).collect::<String>();
    let body = payload(&s.kind, &clip(&req.title, 200), &clip(&req.text, 1500), &req.severity, &clip(&req.cluster, 200));
    post(&s, &body).await.map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    Ok(Json(json!({ "sent": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_webhook_urls() {
        assert!(validate("slack", "https://hooks.slack.com/services/T000/B000/XXXX").is_ok());
        assert!(validate("slack", "https://hooks.slack.com.evil.example/x").is_err());
        assert!(validate("slack", "http://hooks.slack.com/services/x").is_err());
        assert!(validate("teams", "https://contoso.webhook.office.com/webhookb2/abc").is_ok());
        assert!(validate("teams", "https://prod-12.westeurope.logic.azure.com:443/workflows/abc").is_ok());
        assert!(validate("teams", "https://example.com/hook").is_err());
        assert!(validate("generic", "https://alerts.example.com/hook").is_ok());
        assert!(validate("generic", "https://alerts.example.com/hook with space").is_err());
    }

    #[test]
    fn masks_and_formats() {
        assert_eq!(masked("https://hooks.slack.com/services/T000/B000/abcd1234"), "https://hooks.slack.com/…1234");
        assert!(payload("slack", "CrashLoopBackOff: api", "team/api-1", "error", "prod")["text"].as_str().unwrap().contains("*CrashLoopBackOff: api*"));
        assert_eq!(payload("teams", "t", "x", "error", "c")["themeColor"], "E11D48");
        assert_eq!(payload("generic", "t", "x", "warning", "c")["severity"], "warning");
    }
}
