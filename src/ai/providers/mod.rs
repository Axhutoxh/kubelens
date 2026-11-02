//! Provider-neutral chat types and the Claude / Gemini adapters.
//!
//! The UI keeps the conversation in this neutral form and sends it with every request, so
//! the backend stays stateless. Assistant turns also carry the provider's raw content
//! (`raw`) so it can be echoed back verbatim: Gemini needs its thought signatures back on
//! function-call turns.

mod anthropic;
mod gemini;

use super::tools::ToolSpec;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provider {
    Anthropic,
    Gemini,
}

impl Provider {
    pub const ALL: [Provider; 2] = [Provider::Anthropic, Provider::Gemini];

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "anthropic" | "claude" => Some(Self::Anthropic),
            "gemini" | "google" => Some(Self::Gemini),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Anthropic => "Claude (Anthropic)",
            Self::Gemini => "Gemini (Google)",
        }
    }

    pub fn env_vars(self) -> &'static [&'static str] {
        match self {
            Self::Anthropic => &["ANTHROPIC_API_KEY"],
            Self::Gemini => &["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        }
    }

    /// Used until the user picks a model (the list comes from the provider's API).
    pub fn default_model(self) -> &'static str {
        match self {
            Self::Anthropic => "claude-sonnet-5-5",
            Self::Gemini => "gemini-2.5-flash",
        }
    }

    pub fn key_help_url(self) -> &'static str {
        match self {
            Self::Anthropic => "https://console.anthropic.com/settings/keys",
            Self::Gemini => "https://aistudio.google.com/apikey",
        }
    }

    fn base_url(self) -> String {
        // Overridable for proxies / gateways and for tests against a local mock
        let (var, default) = match self {
            Self::Anthropic => ("KUBELLENS_ANTHROPIC_BASE_URL", "https://api.anthropic.com"),
            Self::Gemini => ("KUBELLENS_GEMINI_BASE_URL", "https://generativelanguage.googleapis.com"),
        };
        std::env::var(var).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| default.to_string()).trim_end_matches('/').to_string()
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub args: Value,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ToolResult {
    pub id: String,
    pub name: String,
    pub content: String,
    #[serde(default, rename = "isError")]
    pub is_error: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "role", rename_all = "lowercase")]
pub enum Msg {
    User {
        text: String,
    },
    Assistant {
        #[serde(default)]
        text: String,
        #[serde(default, rename = "toolCalls")]
        tool_calls: Vec<ToolCall>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        raw: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider: Option<String>,
    },
    Tool {
        results: Vec<ToolResult>,
    },
}

/// One model response.
pub struct Turn {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    pub raw: Value,
}

#[derive(Serialize, Clone)]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
}

fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(180))
            .build()
            .expect("HTTP client")
    })
}

pub async fn complete(provider: Provider, model: &str, key: &str, system: &str, msgs: &[Msg], tools: &[ToolSpec]) -> Result<Turn, String> {
    match provider {
        Provider::Anthropic => anthropic::complete(&provider.base_url(), model, key, system, msgs, tools).await,
        Provider::Gemini => gemini::complete(&provider.base_url(), model, key, system, msgs, tools).await,
    }
}

/// Lists chat models; doubles as the API key check when a key is saved.
pub async fn list_models(provider: Provider, key: &str) -> Result<Vec<ModelInfo>, String> {
    match provider {
        Provider::Anthropic => anthropic::list_models(&provider.base_url(), key).await,
        Provider::Gemini => gemini::list_models(&provider.base_url(), key).await,
    }
}

/// Sends a request and returns the JSON body, turning API errors into readable messages.
async fn send_json(req: reqwest::RequestBuilder, body: Option<&Value>) -> Result<Value, String> {
    let req = match body {
        Some(b) => req.header("content-type", "application/json").body(serde_json::to_vec(b).unwrap()),
        None => req,
    };
    let res = req.send().await.map_err(|e| {
        if e.is_timeout() { "The AI provider did not answer in time.".to_string() } else { format!("Could not reach the AI provider: {e}") }
    })?;
    let status = res.status();
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    let json: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(json);
    }
    let detail = json
        .pointer("/error/message")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| String::from_utf8_lossy(&bytes).chars().take(300).collect());
    Err(match status.as_u16() {
        401 | 403 => format!("The API key was rejected ({status}): {detail}"),
        429 => format!("Rate limit or quota reached ({status}): {detail}"),
        _ => format!("AI provider error ({status}): {detail}"),
    })
}
