//! Masks credentials in text before it is sent to an AI provider.
//!
//! Best effort by design: it catches the common shapes (key/value pairs with sensitive
//! names, env name/value pairs, URLs with passwords, private keys, JWTs, bearer tokens,
//! AWS key ids). Secret objects are masked structurally in `tools.rs`, not here.

use regex::{Captures, Regex};
use std::sync::OnceLock;

pub const MASK: &str = "[REDACTED]";

const SENSITIVE_WORDS: &str = r"password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credential|connection[_-]?string|conn[_-]?str";

struct Patterns {
    pem: Regex,
    jwt: Regex,
    bearer: Regex,
    url_creds: Regex,
    aws_key_id: Regex,
    yaml_env: Regex,
    json_env: Regex,
    key_value: Regex,
}

fn patterns() -> &'static Patterns {
    static P: OnceLock<Patterns> = OnceLock::new();
    P.get_or_init(|| Patterns {
        pem: Regex::new(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----").unwrap(),
        jwt: Regex::new(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}").unwrap(),
        bearer: Regex::new(r"(?i)\b(bearer\s+)[A-Za-z0-9._~+/-]{16,}=*").unwrap(),
        url_creds: Regex::new(r"\b([a-zA-Z][a-zA-Z0-9+.-]*://[^/\s:@]+:)([^@\s/]+)@").unwrap(),
        aws_key_id: Regex::new(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b").unwrap(),
        // - name: DB_PASSWORD
        //   value: hunter2
        yaml_env: Regex::new(&format!(
            r#"(?mi)(-\s*name:\s*["']?[A-Za-z0-9_.-]*(?:{SENSITIVE_WORDS}|pass|key)[A-Za-z0-9_.-]*["']?[ \t]*\r?\n\s*value:[ \t]*)(\S.*)$"#
        ))
        .unwrap(),
        // "name": "DB_PASSWORD", "value": "hunter2"
        json_env: Regex::new(&format!(
            r#"(?i)("name":\s*"[^"]*(?:{SENSITIVE_WORDS}|pass|key)[^"]*",\s*"value":\s*)"(?:[^"\\]|\\.)*""#
        ))
        .unwrap(),
        // password: x · "token": "x" · API_KEY=x · DB_PASSWORD:  x  (same line only), and the
        // escaped form found when a config file is a JSON string value: \"password\": \"x\"
        key_value: Regex::new(&format!(
            r#"(?i)((\\?["'])?([A-Za-z0-9_.-]*(?:{SENSITIVE_WORDS})[A-Za-z0-9_.-]*)(?:\\?["'])?[ \t]*[:=][ \t]*)(\\"(?:[^"\\]|\\[^"])*\\"|"(?:[^"\\\n]|\\.)*"|'[^'\n]*'|[^\s,;<{{}}\[\]"'\\][^\s,;}}\]\\]*)"#
        ))
        .unwrap(),
    })
}

/// Field names that mention a secret but hold a reference to it, not its value
/// (`secretName`, `secretKeyRef`, `tokenType`, …).
fn is_reference_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    ["name", "ref", "refs", "kind", "type", "path", "file", "mount", "count", "length", "expiry", "expires", "ttl"]
        .iter()
        .any(|suffix| k.ends_with(suffix))
}

/// Returns the masked text and how many values were masked.
pub fn redact(text: &str) -> (String, usize) {
    let p = patterns();
    let mut count = 0usize;
    let mut out = text.to_string();

    let mut replace = |re: &Regex, out: &mut String, f: &dyn Fn(&Captures) -> String| {
        let mut n = 0;
        let replaced = re.replace_all(out, |c: &Captures| {
            n += 1;
            f(c)
        });
        if n > 0 {
            *out = replaced.into_owned();
            count += n;
        }
    };

    replace(&p.pem, &mut out, &|_| "[REDACTED PRIVATE KEY]".to_string());
    replace(&p.jwt, &mut out, &|_| "[REDACTED JWT]".to_string());
    replace(&p.bearer, &mut out, &|c| format!("{}{MASK}", &c[1]));
    replace(&p.url_creds, &mut out, &|c| format!("{}{MASK}@", &c[1]));
    replace(&p.aws_key_id, &mut out, &|_| MASK.to_string());
    replace(&p.yaml_env, &mut out, &|c| format!("{}{MASK}", &c[1]));
    replace(&p.json_env, &mut out, &|c| format!("{}\"{MASK}\"", &c[1]));

    // key/value pairs need a per-match decision (references are kept), so count by hand
    let mut kv = 0;
    let replaced = p.key_value.replace_all(&out, |c: &Captures| {
        let value = &c[4];
        if is_reference_key(&c[3]) || value.contains(MASK) || value.starts_with("[REDACTED") {
            return c[0].to_string();
        }
        kv += 1;
        let quote = if value.starts_with("\\\"") {
            "\\\""
        } else if value.starts_with('"') {
            "\""
        } else if value.starts_with('\'') {
            "'"
        } else {
            ""
        };
        format!("{}{quote}{MASK}{quote}", &c[1])
    });
    if kv > 0 {
        out = replaced.into_owned();
        count += kv;
    }

    (out, count)
}

#[cfg(test)]
mod tests {
    use super::redact;

    fn masked(s: &str) -> String {
        redact(s).0
    }

    #[test]
    fn masks_key_value_shapes() {
        assert_eq!(masked(r#""password": "caa49508-d335""#), r#""password": "[REDACTED]""#);
        assert_eq!(masked("password: hunter2"), "password: [REDACTED]");
        assert_eq!(masked("API_KEY=abc123"), "API_KEY=[REDACTED]");
        assert_eq!(masked("      DB_PASSWORD:  s3cr3t"), "      DB_PASSWORD:  [REDACTED]");
        assert_eq!(masked("client_secret = 'xyz'"), "client_secret = '[REDACTED]'");
    }

    #[test]
    fn masks_config_files_embedded_as_json_strings() {
        // A ConfigMap value holding JSON, as it appears in `kubectl get -o json`
        let manifest = r#""nats.conf": "{\n  \"users\": [{\n    \"password\": \"caa49508-d335\",\n    \"user\": \"qaproton01\"\n  }],\n  \"token\": \"t0k\"\n}""#;
        let out = masked(manifest);
        assert!(!out.contains("caa49508") && !out.contains("t0k"), "{out}");
        assert!(out.contains(r#"\"password\": \"[REDACTED]\""#), "{out}");
        assert!(out.contains(r#"\"user\": \"qaproton01\""#), "{out}");
        // YAML / properties inside a JSON string: bare values stop at the escaped newline
        let yaml_in_json = r#""app.yaml": "db:\n  password: hunter2\n  host: db""#;
        assert_eq!(masked(yaml_in_json), r#""app.yaml": "db:\n  password: [REDACTED]\n  host: db""#);
    }

    #[test]
    fn masks_env_pairs() {
        let yaml = "- name: DB_PASSWORD\n  value: hunter2\n- name: LOG_LEVEL\n  value: debug";
        assert_eq!(masked(yaml), "- name: DB_PASSWORD\n  value: [REDACTED]\n- name: LOG_LEVEL\n  value: debug");
        let json = r#"{"name": "STRIPE_KEY", "value": "sk_live_123"}, {"name": "PORT", "value": "80"}"#;
        assert_eq!(masked(json), r#"{"name": "STRIPE_KEY", "value": "[REDACTED]"}, {"name": "PORT", "value": "80"}"#);
    }

    #[test]
    fn masks_tokens_urls_and_keys() {
        assert_eq!(masked("postgres://app:pa55@db:5432/x"), "postgres://app:[REDACTED]@db:5432/x");
        assert_eq!(masked("Authorization: Bearer abcdefghijklmnop1234"), "Authorization: Bearer [REDACTED]");
        assert!(masked("t=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijkl").contains("[REDACTED JWT]"));
        let pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----";
        assert_eq!(masked(pem), "[REDACTED PRIVATE KEY]");
        assert_eq!(masked("id AKIAIOSFODNN7EXAMPLE"), "id [REDACTED]");
    }

    #[test]
    fn keeps_references_and_plain_text() {
        for keep in [
            "secretName: nats-secrets",
            "secretKeyRef:\n  key: password\n  name: db",
            "      DB_PASSWORD:  <set to the key 'password' in secret 'db'>  Optional: false",
            "authentication error - User \"qamanualq3p1\"",
            "GET /api/v1/am/assets/inventory/config HTTP/1.1 200",
            "tokenType: Bearer",
            "passwordSecretRef: {",
        ] {
            assert_eq!(masked(keep), keep, "should not change: {keep}");
        }
    }

    #[test]
    fn counts_masked_values() {
        let (_, n) = redact("password: a\ntoken: b\nuser: c");
        assert_eq!(n, 2);
    }
}
