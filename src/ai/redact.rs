//! Masks credentials in text before it is sent to an AI provider.
//!
//! Best effort by design: it catches the common shapes (key/value pairs with sensitive
//! names, env name/value pairs, URLs with passwords, private keys, JWTs, bearer tokens,
//! AWS key ids, well-known API token prefixes, SAS signatures) and, for secrets printed
//! without a label (typical in application logs), long random-looking tokens. Secret
//! objects are masked structurally in `tools.rs`, not here.

use regex::{Captures, Regex};
use std::sync::OnceLock;

pub const MASK: &str = "[REDACTED]";

const SENSITIVE_WORDS: &str = r"password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|account[_-]?key|private[_-]?key|client[_-]?secret|credential|connection[_-]?string|conn[_-]?str";

/// Unlabelled tokens shorter than this are left alone (too many ids and names are shorter).
const MIN_RANDOM_LEN: usize = 24;

struct Patterns {
    pem: Regex,
    jwt: Regex,
    bearer: Regex,
    url_creds: Regex,
    aws_key_id: Regex,
    known_token: Regex,
    sas_sig: Regex,
    certificate: Regex,
    candidate: Regex,
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
        // Tokens whose prefix gives them away: GitHub, GitLab, Slack, Google, Stripe, OpenAI,
        // Anthropic, npm
        known_token: Regex::new(
            r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36})",
        )
        .unwrap(),
        // Azure SAS URLs: the signature is the credential
        sas_sig: Regex::new(r#"([?&]sig=)[^&\s"'<>]+"#).unwrap(),
        // Public certificates are long base64 but not secret; the randomness check skips them
        certificate: Regex::new(r"-----BEGIN [A-Z ]*CERTIFICATE-----[\s\S]*?-----END [A-Z ]*CERTIFICATE-----").unwrap(),
        candidate: Regex::new(&format!(r"[A-Za-z0-9+/_.-]{{{MIN_RANDOM_LEN},}}={{0,2}}")).unwrap(),
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

fn shannon_entropy(s: &[u8]) -> f64 {
    let mut freq = [0u32; 256];
    for &b in s {
        freq[b as usize] += 1;
    }
    let n = s.len() as f64;
    freq.iter()
        .filter(|&&c| c > 0)
        .map(|&c| {
            let p = c as f64 / n;
            -p * p.log2()
        })
        .sum()
}

/// True for strings that look like generated credentials rather than names: long, mixing
/// upper case, lower case and digits, switching between them often (unlike CamelCase
/// identifiers), and close to the maximum entropy for their length. Hex strings (digests,
/// UUIDs, container ids) and lower-case Kubernetes names never match.
fn looks_random(token: &str) -> bool {
    let s = token.trim_end_matches('=').as_bytes();
    if s.len() < MIN_RANDOM_LEN {
        return false;
    }
    // Paths: a lower-case word between slashes means it's not one token
    if s.contains(&b'/') && token.split('/').any(|seg| seg.len() >= 3 && seg.bytes().all(|b| b.is_ascii_lowercase())) {
        return false;
    }
    let class = |b: u8| match b {
        b'A'..=b'Z' => 0,
        b'a'..=b'z' => 1,
        b'0'..=b'9' => 2,
        _ => 3,
    };
    let (mut upper, mut lower, mut digit) = (0, 0, 0);
    for &b in s {
        match class(b) {
            0 => upper += 1,
            1 => lower += 1,
            2 => digit += 1,
            _ => {}
        }
    }
    if upper == 0 || lower == 0 || digit == 0 {
        return false;
    }
    let switches = s.windows(2).filter(|w| class(w[0]) != class(w[1])).count();
    if (switches as f64) < 0.35 * (s.len() - 1) as f64 {
        return false;
    }
    let max_entropy = (s.len().min(64) as f64).log2();
    shannon_entropy(s) >= 0.8 * max_entropy
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
    replace(&p.known_token, &mut out, &|_| MASK.to_string());
    replace(&p.sas_sig, &mut out, &|c| format!("{}{MASK}", &c[1]));
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

    // Last: unlabelled random-looking tokens (e.g. a key printed in a log line)
    let certs: Vec<(usize, usize)> = p.certificate.find_iter(&out).map(|m| (m.start(), m.end())).collect();
    let mut random = 0;
    let replaced = p.candidate.replace_all(&out, |c: &Captures| {
        let m = c.get(0).unwrap();
        // Dotted runs are host names, versions and package names; a trailing dot ends a sentence
        let core = m.as_str().trim_end_matches('.');
        if core.contains('.') || certs.iter().any(|&(s, e)| m.start() >= s && m.end() <= e) || !looks_random(core) {
            return m.as_str().to_string();
        }
        random += 1;
        format!("{MASK}{}", &m.as_str()[core.len()..])
    });
    if random > 0 {
        out = replaced.into_owned();
        count += random;
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
    fn masks_unlabelled_tokens_in_logs() {
        for (line, secret) in [
            ("INFO connecting with Xk9pQ2mZ7vLw4RtY8nB3cJ6hF1sD5gA0", "Xk9pQ2mZ7vLw4RtY8nB3cJ6hF1sD5gA0"),
            // Azure storage key (the public Azurite development key)
            (
                "using key Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw== for blob",
                "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq",
            ),
            ("cloned with ghp_aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5 ok", "ghp_aB3dE5"),
            ("upload https://acct.blob.core.windows.net/c/f?sv=2022-11-02&se=2026&sig=abc%2Bdef%3D&sp=r", "abc%2Bdef"),
            ("DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=c2VjcmV0;EndpointSuffix=core.windows.net", "c2VjcmV0"),
        ] {
            let out = masked(line);
            assert!(!out.contains(secret), "not masked: {out}");
            assert!(out.contains("[REDACTED]"), "{out}");
        }
        // Assembled at runtime so secret scanners don't flag the fake key in source
        let stripe = format!("stripe sk_{}_51HcXz2eZvKYlo2C8a9b0c1d2e3f", "live");
        assert!(!masked(&stripe).contains("51HcXz"), "not masked: {}", masked(&stripe));
        assert_eq!(masked("retry Xk9pQ2mZ7vLw4RtY8nB3cJ6hF1sD5gA0."), "retry [REDACTED].");
    }

    #[test]
    fn keeps_ids_names_and_certificates() {
        for keep in [
            "pod itam-alm-service-65bc7d9f8-x7k2p restarted",
            "uid 3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f",
            "image sha256:9b2a7c1d4e5f60718293a4b5c6d7e8f9091a2b3c4d5e6f708192a3b4c5d6e7f8",
            "containerd://4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a",
            "at org.springframework.web.servlet.FrameworkServlet.processRequest(FrameworkServlet.java:1014)",
            "class SpringApplicationContextInitializer2 failed",
            "HorizontalPodAutoscalerV2Beta2Controller synced",
            "node aks-nodepool1-12345678-vmss000000 Ready",
            "image AKSUbuntu-2204gen2containerd-202410.15.0",
            "rg MC_tf-aks-qa-team_TF-AKS-QA-Team_eastus2",
            "GET /api/v1/namespaces/Default2/pods/Abc12345/LogsXyz9876 200",
            r"C:\Users\AshutoshChandra2\projects\freelens-main",
        ] {
            assert_eq!(masked(keep), keep, "should not change: {keep}");
        }
        let cert = r#""ca.crt": "-----BEGIN CERTIFICATE-----\nMIIC5zCCAc+gAwIBAgIBADANBgkqhkiG9w0BAQsFADAVMRMwEQYDVQQDEwprdWJl\n-----END CERTIFICATE-----\n""#;
        assert_eq!(masked(cert), cert);
    }

    #[test]
    fn counts_masked_values() {
        let (_, n) = redact("password: a\ntoken: b\nuser: c");
        assert_eq!(n, 2);
    }
}
