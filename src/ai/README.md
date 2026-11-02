# AI assistant (`src/ai`)

Ask Claude or Gemini about the cluster from inside Kubellens, or use Kubellens' cluster tools from other AI apps over MCP. Both paths share one set of **read-only** tools and the same masking of sensitive data.

```text
src/ai/
├── mod.rs             # module root + /api/ai routes
├── tools.rs           # read-only kubectl tools (shared by chat and MCP), argument validation
├── redact.rs          # masks passwords, tokens, keys, private keys, URL credentials
├── agent.rs           # in-app chat: HTTP handlers + tool-calling loop + permission pause
├── mcp.rs             # MCP server on stdio (`kubellens --mcp`)
├── keystore.rs        # API keys in Windows Credential Manager / macOS Keychain (Linux: 0600 file)
├── settings.rs        # default provider + model per provider (no secrets)
└── providers/
    ├── mod.rs         # provider-neutral messages, HTTP client, error mapping
    ├── anthropic.rs   # Claude (Messages API, tool use)
    └── gemini.rs      # Gemini (generateContent, function calling)

frontend/src/ai/
├── AiChatView.tsx     # full-page AI Chat: any cluster / namespace, saved conversations
├── AiPanel.tsx        # quick side panel (Ctrl+I) that follows the current view
├── ChatThread.tsx     # conversation, tool activity, permission card, input (shared)
├── useAiChat.ts       # chat state + streaming request loop (shared)
├── history.ts         # saved conversations: questions and answers only, no tool output
├── AiSettings.tsx     # connect providers (sign-in link + API key), models, MCP snippets
├── Markdown.tsx       # small Markdown renderer for replies (no HTML injection)
├── api.ts             # REST + streaming client for /api/ai
└── types.ts           # conversation / event types shared with the backend
```

## Tools

| Tool | kubectl | Can reveal |
| :--- | :--- | :--- |
| `list_contexts` | `config get-contexts` | |
| `list_resources` | `get <kind> -o wide` | |
| `describe_resource` | `describe <kind> <name>` | yes |
| `get_manifest` | `get <kind> <name> -o json` (managedFields and last-applied removed) | yes |
| `get_logs` | `logs` (tail, `--previous`, `--since`) | yes |
| `get_events` | `get events --sort-by=.lastTimestamp` | |
| `get_metrics` | `top pods/nodes` | |

Nothing can change the cluster. Arguments are validated, and values never start with `-`, so they can't be read as kubectl flags. Output is capped at 15,000 characters per call.

## Sensitive data and permission

1. Every tool output is masked by `redact.rs` before it goes to the provider. Secret objects are also masked structurally (`data` / `stringData` values become `[REDACTED: n chars]`).
2. If the model needs a real value, it must call the tool again with `reveal: true`.
3. **In the app:** the chat loop stops and shows a permission card. **Allow** reveals the values for that one call; **Keep masked** sends the masked output again.
4. **Over MCP:** the server asks the user through MCP *elicitation*. Clients without elicitation support get masked output plus a note.

Masking is best effort (pattern based). It covers common shapes, including config files embedded in JSON strings. The unit tests in `redact.rs` list what is covered.

## In-app chat flow

`POST /api/ai/chat` streams Server-Sent Events: `status`, `messages`, `tool_start`, `tool_end`, `permission`, `error`, `done`.

The UI keeps the conversation and sends all of it on every request; the backend keeps no chat state. To continue after a permission prompt, the UI sends the same conversation plus `approvals: { <toolCallId>: true|false }`. Assistant turns carry the provider's raw content, so Gemini thought signatures are sent back unchanged.

## MCP setup

The installed app is its own MCP server. The paths below are examples; use the ones AI settings shows.

```json
{ "mcpServers": { "kubellens": { "command": "C:\\Program Files\\Kubellens\\Kubellens.exe", "args": ["--mcp"] } } }
```

```bash
claude mcp add kubellens -- "/Applications/Kubellens.app/Contents/MacOS/Kubellens" --mcp
```

The server uses the current kubectl context by default; each tool also accepts `context`.

## Keys and configuration

| | |
| :--- | :--- |
| API keys | OS credential store, service `kubellens-ai`. `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` or `GOOGLE_API_KEY` is used when no key is saved |
| Settings | `<config dir>/kubellens/ai-settings.json` (provider, models) |
| Gateways / tests | `KUBELLENS_ANTHROPIC_BASE_URL`, `KUBELLENS_GEMINI_BASE_URL` |
| Sign-in links | `POST /api/ai/open-url` opens only the providers' API key pages in the system browser |

Saving a key checks it first by listing the provider's models.

## Tests

```bash
cargo test ai::
```

These cover masking (including config files embedded in JSON) and argument validation.
