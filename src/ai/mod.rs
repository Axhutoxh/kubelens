//! AI assistant for Kubellens.
//!
//! - `tools`     read-only cluster tools (kubectl), shared by everything below
//! - `redact`    masks passwords / tokens / keys before data leaves the machine
//! - `providers` Claude and Gemini adapters behind one neutral message format
//! - `agent`     in-app chat: HTTP endpoints + tool-calling loop with permission prompts
//! - `mcp`       the same tools as an MCP server (`kubellens --mcp`)
//! - `keystore`  API keys in the OS credential store
//! - `settings`  non-secret preferences (provider, model)

pub mod agent;
pub mod keystore;
pub mod mcp;
pub mod providers;
pub mod redact;
pub mod settings;
pub mod tools;

use crate::AppState;
use axum::routing::{get, post};
use axum::Router;

/// Routes mounted under `/api/ai`.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/status", get(agent::handle_status))
        .route("/key", post(agent::handle_save_key).delete(agent::handle_delete_key))
        .route("/models", get(agent::handle_models))
        .route("/settings", post(agent::handle_save_settings))
        .route("/chat", post(agent::handle_chat))
        .route("/open-url", post(agent::handle_open_url))
}
