//! Non-secret AI preferences (default provider and model per provider), stored as JSON in
//! the user's config directory. API keys are never written here; see `keystore`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct AiSettings {
    /// "anthropic" or "gemini"
    #[serde(default)]
    pub provider: Option<String>,
    /// provider id -> model id
    #[serde(default)]
    pub models: HashMap<String, String>,
}

fn path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("kubellens").join("ai-settings.json"))
}

pub fn load() -> AiSettings {
    path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(settings: &AiSettings) -> Result<(), String> {
    let p = path().ok_or("no config directory")?;
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&p, serde_json::to_string_pretty(settings).unwrap()).map_err(|e| e.to_string())
}
