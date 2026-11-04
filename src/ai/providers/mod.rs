//! Provider-neutral chat types and the provider adapters (Claude, Gemini, and the OpenAI
//! wire format used by OpenAI, Azure OpenAI and Ollama).
//!
//! The UI keeps the conversation in this neutral form and sends it with every request, so
//! the backend stays stateless. Assistant turns also carry the provider's raw content
//! (`raw`) so it can be echoed back verbatim: Gemini needs its thought signatures back on
//! function-call turns.

mod anthropic;
mod gemini;
mod openai;

use super::settings::AiSettings;
use super::tools::ToolSpec;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provider {
    Anthropic,
    Gemini,
    OpenAi,
    Azure,
    Ollama,
}

/// Whether a provider takes a user-supplied endpoint URL.
#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EndpointMode {
    None,
    /// Has a default; the user may point it at a gateway or another server
    Optional,
    Required,
}

impl Provider {
    pub const ALL: [Provider; 5] = [Provider::Anthropic, Provider::Gemini, Provider::OpenAi, Provider::Azure, Provider::Ollama];

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "anthropic" | "claude" => Some(Self::Anthropic),
            "gemini" | "google" => Some(Self::Gemini),
            "openai" => Some(Self::OpenAi),
            "azure" | "azure-openai" => Some(Self::Azure),
            "ollama" => Some(Self::Ollama),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
            Self::OpenAi => "openai",
            Self::Azure => "azure",
            Self::Ollama => "ollama",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Anthropic => "Claude (Anthropic)",
            Self::Gemini => "Gemini (Google)",
            Self::OpenAi => "OpenAI",
            Self::Azure => "Azure OpenAI",
            Self::Ollama => "Ollama (local models)",
        }
    }

    /// Ollama runs on the user's machine and needs no key.
    pub fn needs_key(self) -> bool {
        self != Self::Ollama
    }

    pub fn env_vars(self) -> &'static [&'static str] {
        match self {
            Self::Anthropic => &["ANTHROPIC_API_KEY"],
            Self::Gemini => &["GEMINI_API_KEY", "GOOGLE_API_KEY"],
            Self::OpenAi => &["OPENAI_API_KEY"],
            Self::Azure => &["AZURE_OPENAI_API_KEY"],
            Self::Ollama => &[],
        }
    }

    /// Used until the user picks a model (the list comes from the provider's API). Azure has
    /// no default: the deployment name is entered when connecting.
    pub fn default_model(self) -> &'static str {
        match self {
            Self::Anthropic => "claude-sonnet-5-5",
            Self::Gemini => "gemini-2.5-flash",
            Self::OpenAi => "gpt-5",
            Self::Azure => "",
            Self::Ollama => "llama3.1",
        }
    }

    pub fn key_help_url(self) -> &'static str {
        match self {
            Self::Anthropic => "https://console.anthropic.com/settings/keys",
            Self::Gemini => "https://aistudio.google.com/apikey",
            Self::OpenAi => "https://platform.openai.com/api-keys",
            Self::Azure => "https://ai.azure.com/",
            Self::Ollama => "https://ollama.com/download",
        }
    }

    pub fn endpoint_mode(self) -> EndpointMode {
        match self {
            Self::Anthropic | Self::Gemini => EndpointMode::None,
            Self::OpenAi | Self::Ollama => EndpointMode::Optional,
            Self::Azure => EndpointMode::Required,
        }
    }

    pub fn default_endpoint(self) -> Option<&'static str> {
        match self {
            Self::Anthropic => Some("https://api.anthropic.com"),
            Self::Gemini => Some("https://generativelanguage.googleapis.com"),
            Self::OpenAi => Some("https://api.openai.com/v1"),
            Self::Azure => None,
            Self::Ollama => Some("http://localhost:11434/v1"),
        }
    }

    /// Where requests go: a `KUBELLENS_*` override (gateways, tests against a local mock), then
    /// the endpoint saved in settings, then the default. Ollama has no endpoint until the user
    /// connects it, which is what marks it as connected.
    pub fn endpoint(self, settings: &AiSettings) -> Option<String> {
        let override_var = match self {
            Self::Anthropic => Some("KUBELLENS_ANTHROPIC_BASE_URL"),
            Self::Gemini => Some("KUBELLENS_GEMINI_BASE_URL"),
            Self::OpenAi => Some("KUBELLENS_OPENAI_BASE_URL"),
            Self::Azure => None,
            Self::Ollama => Some("KUBELLENS_OLLAMA_BASE_URL"),
        };
        let env = |var: &str| std::env::var(var).ok().filter(|v| !v.trim().is_empty());
        let saved = || settings.endpoints.get(self.as_str()).filter(|v| !v.is_empty()).cloned();
        let url = override_var.and_then(env).or_else(|| match self {
            Self::Anthropic | Self::Gemini => None,
            Self::OpenAi => saved().or_else(|| self.default_endpoint().map(str::to_string)),
            Self::Azure => saved().or_else(|| env("AZURE_OPENAI_ENDPOINT")),
            Self::Ollama => saved(),
        });
        let url = match self {
            Self::Anthropic | Self::Gemini => url.or_else(|| self.default_endpoint().map(str::to_string)),
            _ => url,
        }?;
        Some(url.trim().trim_end_matches('/').to_string())
    }
}

/// Validates and tidies an endpoint typed by the user.
pub fn normalize_endpoint(provider: Provider, raw: &str) -> Result<String, String> {
    let mut url = raw.trim().trim_end_matches('/').to_string();
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) || url.contains(char::is_whitespace) {
        return Err("The endpoint must be a URL starting with https:// (or http:// for a local server).".into());
    }
    if provider == Provider::Azure {
        if !lower.starts_with("https://") {
            return Err("Azure OpenAI endpoints use https://.".into());
        }
        // People often paste a full request URL; keep only the resource endpoint
        if let Some(i) = lower.find("/openai") {
            url.truncate(i);
        }
    }
    Ok(url)
}

/// Where and how to reach a provider. `key` is empty for providers that don't need one.
pub struct Conn {
    pub base: String,
    pub key: String,
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

pub async fn complete(provider: Provider, conn: &Conn, model: &str, system: &str, msgs: &[Msg], tools: &[ToolSpec]) -> Result<Turn, String> {
    match provider {
        Provider::Anthropic => anthropic::complete(&conn.base, model, &conn.key, system, msgs, tools).await,
        Provider::Gemini => gemini::complete(&conn.base, model, &conn.key, system, msgs, tools).await,
        Provider::OpenAi | Provider::Ollama => openai::complete(openai::Flavor::OpenAi, conn, model, system, msgs, tools).await,
        Provider::Azure => openai::complete(openai::Flavor::Azure, conn, model, system, msgs, tools).await,
    }
}

/// Lists chat models; doubles as the connection check when a provider is connected. Azure
/// can't list deployments, so it reports the saved one.
pub async fn list_models(provider: Provider, conn: &Conn, azure_deployment: &str) -> Result<Vec<ModelInfo>, String> {
    match provider {
        Provider::Anthropic => anthropic::list_models(&conn.base, &conn.key).await,
        Provider::Gemini => gemini::list_models(&conn.base, &conn.key).await,
        Provider::OpenAi | Provider::Ollama => openai::list_models(conn).await,
        Provider::Azure => Ok(vec![ModelInfo { id: azure_deployment.to_string(), label: azure_deployment.to_string() }]),
    }
}

pub async fn check_azure_deployment(conn: &Conn, deployment: &str) -> Result<(), String> {
    openai::check_deployment(conn, deployment).await
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
