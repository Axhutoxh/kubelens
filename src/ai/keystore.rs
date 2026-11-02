//! API key storage. Windows Credential Manager / macOS Keychain where available; on
//! Linux a file in the user's config dir readable only by the user (0600).
//!
//! An `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` environment variable is used when no key
//! has been saved, so CLI users don't have to paste it again.

use super::providers::Provider;

#[derive(Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeySource {
    Keychain,
    Env,
}

pub fn get(provider: Provider) -> Option<(String, KeySource)> {
    if let Some(k) = platform::get(provider.as_str()).filter(|k| !k.trim().is_empty()) {
        return Some((k, KeySource::Keychain));
    }
    provider
        .env_vars()
        .iter()
        .find_map(|v| std::env::var(v).ok().filter(|k| !k.trim().is_empty()))
        .map(|k| (k, KeySource::Env))
}

pub fn set(provider: Provider, key: &str) -> Result<(), String> {
    platform::set(provider.as_str(), key.trim())
}

pub fn delete(provider: Provider) -> Result<(), String> {
    platform::delete(provider.as_str())
}

#[cfg(any(windows, target_os = "macos"))]
mod platform {
    const SERVICE: &str = "kubellens-ai";

    fn entry(account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())
    }

    pub fn get(account: &str) -> Option<String> {
        entry(account).ok()?.get_password().ok()
    }

    pub fn set(account: &str, secret: &str) -> Result<(), String> {
        entry(account)?.set_password(secret).map_err(|e| e.to_string())
    }

    pub fn delete(account: &str) -> Result<(), String> {
        match entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn path() -> Option<PathBuf> {
        dirs::config_dir().map(|d| d.join("kubellens").join("ai-keys.json"))
    }

    fn load() -> HashMap<String, String> {
        path()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn store(map: &HashMap<String, String>) -> Result<(), String> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let p = path().ok_or("no config directory")?;
        std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&p)
            .map_err(|e| e.to_string())?;
        f.write_all(serde_json::to_string(map).unwrap().as_bytes()).map_err(|e| e.to_string())
    }

    pub fn get(account: &str) -> Option<String> {
        load().remove(account)
    }

    pub fn set(account: &str, secret: &str) -> Result<(), String> {
        let mut map = load();
        map.insert(account.to_string(), secret.to_string());
        store(&map)
    }

    pub fn delete(account: &str) -> Result<(), String> {
        let mut map = load();
        map.remove(account);
        store(&map)
    }
}
