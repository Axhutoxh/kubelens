//! MCP server over stdio (`kubellens --mcp`), exposing the read-only cluster tools to MCP
//! clients such as Claude Desktop, Claude Code or Gemini CLI.
//!
//! Masking works as in the app. A call with `reveal: true` asks the user through MCP
//! elicitation; clients that don't support elicitation get masked data only.

use super::tools;
use serde_json::{json, Value};
use std::collections::VecDeque;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines, Stdin, Stdout};

const SUPPORTED_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
const ELICIT_TIMEOUT_SECS: u64 = 300;

struct Server {
    lines: Lines<BufReader<Stdin>>,
    out: Stdout,
    /// Messages read while waiting for an elicitation answer, handled afterwards
    backlog: VecDeque<Value>,
    can_elicit: bool,
    context: String,
    next_id: u64,
}

pub async fn run() {
    let context = crate::get_current_context().await;
    eprintln!("kubellens MCP server ready (context: {})", if context.is_empty() { "<none>" } else { &context });
    let mut server = Server {
        lines: BufReader::new(tokio::io::stdin()).lines(),
        out: tokio::io::stdout(),
        backlog: VecDeque::new(),
        can_elicit: false,
        context,
        next_id: 1,
    };
    while let Some(msg) = server.next_message().await {
        server.handle(msg).await;
    }
}

impl Server {
    async fn read(&mut self) -> Option<Value> {
        loop {
            let line = self.lines.next_line().await.ok()??;
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(&line) {
                Ok(v) => return Some(v),
                Err(e) => {
                    self.send(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": format!("Parse error: {e}") } })).await;
                }
            }
        }
    }

    async fn next_message(&mut self) -> Option<Value> {
        match self.backlog.pop_front() {
            Some(m) => Some(m),
            None => self.read().await,
        }
    }

    async fn send(&mut self, msg: Value) {
        let mut line = msg.to_string();
        line.push('\n');
        // stdout carries only protocol messages; diagnostics go to stderr
        if self.out.write_all(line.as_bytes()).await.is_err() || self.out.flush().await.is_err() {
            std::process::exit(0);
        }
    }

    async fn reply(&mut self, id: Value, result: Value) {
        self.send(json!({ "jsonrpc": "2.0", "id": id, "result": result })).await;
    }

    async fn reply_error(&mut self, id: Value, code: i64, message: &str) {
        self.send(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })).await;
    }

    async fn handle(&mut self, msg: Value) {
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("").to_string();
        let id = msg.get("id").cloned();
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        let Some(id) = id else {
            // Notifications (initialized, cancelled, …) need no answer
            return;
        };
        if method.is_empty() {
            // A stray response (e.g. to an elicitation that already timed out)
            return;
        }
        match method.as_str() {
            "initialize" => {
                let requested = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
                let version = if SUPPORTED_VERSIONS.contains(&requested) { requested } else { SUPPORTED_VERSIONS[0] };
                self.can_elicit = params.pointer("/capabilities/elicitation").is_some();
                self.reply(id, json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "kubellens", "title": "Kubellens", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": "Read-only access to the user's Kubernetes clusters through kubectl. Sensitive values are masked as [REDACTED]; pass reveal=true only when a value is essential, and the user will be asked to allow it.",
                }))
                .await;
            }
            "ping" => self.reply(id, json!({})).await,
            "tools/list" => {
                let list: Vec<Value> = tools::specs()
                    .iter()
                    .map(|t| json!({
                        "name": t.name,
                        "description": t.description,
                        "inputSchema": t.schema,
                        "annotations": { "readOnlyHint": true, "openWorldHint": false },
                    }))
                    .collect();
                self.reply(id, json!({ "tools": list })).await;
            }
            "tools/call" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
                if tools::find(&name).is_none() {
                    self.reply_error(id, -32602, &format!("Unknown tool: {name}")).await;
                    return;
                }
                let mut note = None;
                let mut reveal = false;
                if tools::wants_reveal(&name, &args) {
                    let what = tools::describe_call(&name, &args);
                    match self.ask_permission(&what).await {
                        Ok(true) => reveal = true,
                        Ok(false) => note = Some("The user declined to reveal masked values; showing masked output."),
                        Err(reason) => {
                            eprintln!("reveal not possible: {reason}");
                            note = Some("This MCP client cannot ask the user for permission, so masked values stay hidden. The user can view them in the Kubellens app.");
                        }
                    }
                }
                let context = self.context.clone();
                let result = match tools::execute(&name, &args, &context, reveal).await {
                    Ok(out) => {
                        let mut text = out.text;
                        if let Some(n) = note {
                            text.push_str(&format!("\n\n[{n}]"));
                        }
                        json!({ "content": [{ "type": "text", "text": text }], "isError": false })
                    }
                    Err(e) => json!({ "content": [{ "type": "text", "text": format!("Error: {e}") }], "isError": true }),
                };
                self.reply(id, result).await;
            }
            "resources/list" => self.reply(id, json!({ "resources": [] })).await,
            "prompts/list" => self.reply(id, json!({ "prompts": [] })).await,
            other => self.reply_error(id, -32601, &format!("Method not found: {other}")).await,
        }
    }

    /// Asks the user (through the MCP client) to allow unmasked output for one call.
    async fn ask_permission(&mut self, what: &str) -> Result<bool, String> {
        if !self.can_elicit {
            return Err("client does not support elicitation".into());
        }
        let req_id = format!("kubellens-elicit-{}", self.next_id);
        self.next_id += 1;
        self.send(json!({
            "jsonrpc": "2.0",
            "id": req_id,
            "method": "elicitation/create",
            "params": {
                "message": format!("Kubellens: the AI wants to see unmasked sensitive values (passwords, tokens, Secret data) for \"{what}\" on cluster {}. Allow this once?", self.context),
                "requestedSchema": {
                    "type": "object",
                    "properties": {
                        "allow": { "type": "boolean", "title": "Allow", "description": "Reveal sensitive values for this one request" }
                    },
                    "required": ["allow"],
                },
            },
        }))
        .await;

        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(ELICIT_TIMEOUT_SECS);
        loop {
            let msg = match tokio::time::timeout_at(deadline, self.read()).await {
                Ok(Some(m)) => m,
                Ok(None) => return Err("client disconnected".into()),
                Err(_) => return Ok(false),
            };
            if msg.get("id").and_then(Value::as_str) == Some(req_id.as_str()) && msg.get("method").is_none() {
                if msg.get("error").is_some() {
                    return Err(msg["error"].to_string());
                }
                let action = msg.pointer("/result/action").and_then(Value::as_str).unwrap_or("decline");
                let allow = msg.pointer("/result/content/allow").and_then(Value::as_bool).unwrap_or(false);
                return Ok(action == "accept" && allow);
            }
            self.backlog.push_back(msg);
        }
    }
}
