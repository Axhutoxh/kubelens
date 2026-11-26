//! Guards the local API. Kubellens listens on localhost, but any web page open in the user's
//! browser can send requests to localhost too, and the API can read Secrets, exec into pods
//! and delete things. Every `/api` request therefore has to:
//!
//! - carry this launch's session token: an HttpOnly, SameSite=Strict cookie set when the app
//!   page loads (so other sites' requests never carry it), or the `X-Kubellens-Token` header;
//! - come from this app's own origin when the browser sends an `Origin` header;
//! - be addressed to `localhost` / `127.0.0.1` / `[::1]` (stops DNS-rebinding pages), unless
//!   the server was started with `FREELENS_BIND_ALL` for remote use.
//!
//! `KUBELLENS_INSECURE_API=1` turns the guard off for UI development with the Vite dev server.

use axum::{
    extract::Request,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::hash::{BuildHasher, Hasher};
use std::sync::OnceLock;

pub const COOKIE: &str = "kubellens_session";
pub const HEADER: &str = "x-kubellens-token";

struct Guard {
    token: String,
    any_host: bool,
    disabled: bool,
}

static GUARD: OnceLock<Guard> = OnceLock::new();

/// 256 random bits from the OS (RandomState is seeded from OS randomness), hex encoded.
fn random_token() -> String {
    (0..4)
        .map(|i| {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u64(i);
            format!("{:016x}", h.finish())
        })
        .collect()
}

fn guard() -> &'static Guard {
    GUARD.get_or_init(|| Guard {
        // A fixed token can be given for scripted tests; normally each launch gets a new one
        token: std::env::var("KUBELLENS_API_TOKEN").ok().filter(|t| t.len() >= 16).unwrap_or_else(random_token),
        any_host: std::env::var("FREELENS_BIND_ALL").is_ok(),
        disabled: std::env::var("KUBELLENS_INSECURE_API").map(|v| v == "1").unwrap_or(false),
    })
}

pub fn init() {
    let g = guard();
    if g.disabled {
        eprintln!("⚠️  KUBELLENS_INSECURE_API=1: the local API accepts requests from any page (development only)");
    }
}

/// `Set-Cookie` value handed out with the app page.
pub fn session_cookie() -> HeaderValue {
    HeaderValue::from_str(&format!("{COOKIE}={}; Path=/; HttpOnly; SameSite=Strict", guard().token)).expect("token is ASCII hex")
}

fn host_is_local(host: &str) -> bool {
    let name = if let Some(rest) = host.strip_prefix('[') {
        // [::1]:9090
        rest.split(']').next().map(|h| format!("[{h}]")).unwrap_or_default()
    } else {
        host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host).to_string()
    };
    matches!(name.as_str(), "localhost" | "127.0.0.1" | "[::1]")
}

fn cookie_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .find(|(k, _)| *k == COOKIE)
        .map(|(_, v)| v.to_string())
}

/// Compares without stopping at the first difference.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Why a request is refused, or None when it may pass.
fn check(headers: &HeaderMap) -> Option<(StatusCode, &'static str)> {
    let g = guard();
    if g.disabled {
        return None;
    }
    let host = headers.get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    if !g.any_host && !host_is_local(host) {
        return Some((StatusCode::FORBIDDEN, "Requests must be addressed to localhost"));
    }
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|o| o.to_str().ok()) {
        let own = [format!("http://{host}"), format!("https://{host}")];
        if !own.iter().any(|o| o == origin) {
            return Some((StatusCode::FORBIDDEN, "Cross-site requests to the Kubellens API are not allowed"));
        }
    }
    let presented = headers.get(HEADER).and_then(|v| v.to_str().ok()).map(str::to_string).or_else(|| cookie_token(headers));
    match presented {
        Some(t) if same(&t, &g.token) => None,
        _ => Some((StatusCode::UNAUTHORIZED, "Missing or expired Kubellens session; reload the app")),
    }
}

/// Axum middleware for the `/api` router.
pub async fn require_session(req: Request, next: Next) -> Response {
    match check(req.headers()) {
        None => next.run(req).await,
        Some((status, msg)) => (status, msg).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(*k, HeaderValue::from_str(v).unwrap());
        }
        h
    }

    #[test]
    fn requires_token_origin_and_local_host() {
        let token = guard().token.clone();
        let cookie = format!("theme=dark; {COOKIE}={token}");
        // The app itself
        assert!(check(&headers(&[("host", "localhost:9090"), ("origin", "http://localhost:9090"), ("cookie", &cookie)])).is_none());
        // Same-origin GET without Origin, and scripts using the header
        assert!(check(&headers(&[("host", "127.0.0.1:9090"), ("cookie", &cookie)])).is_none());
        assert!(check(&headers(&[("host", "[::1]:9090"), (HEADER, &token)])).is_none());
        // Another website: no cookie (SameSite=Strict) and a foreign Origin
        assert_eq!(check(&headers(&[("host", "localhost:9090"), ("origin", "https://evil.example")])).unwrap().0, StatusCode::FORBIDDEN);
        assert_eq!(check(&headers(&[("host", "localhost:9090")])).unwrap().0, StatusCode::UNAUTHORIZED);
        assert_eq!(check(&headers(&[("host", "localhost:9090"), ("cookie", "kubellens_session=wrong")])).unwrap().0, StatusCode::UNAUTHORIZED);
        // DNS rebinding: a foreign host name pointing at 127.0.0.1
        assert_eq!(check(&headers(&[("host", "attacker.example:9090"), ("cookie", &cookie)])).unwrap().0, StatusCode::FORBIDDEN);
    }

    #[test]
    fn tokens_are_long_and_random() {
        let (a, b) = (random_token(), random_token());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert!(session_cookie().to_str().unwrap().contains("HttpOnly; SameSite=Strict"));
    }
}
