# AI assistant (`src/ai`)

Ask Claude, Gemini, OpenAI, Azure OpenAI or a local Ollama model about the cluster from inside Kubellens, or use Kubellens' cluster tools from other AI apps over MCP. Both paths share one set of **read-only** tools and the same masking of sensitive data. In the app, the assistant can also **propose** a fix (restart, scale, roll back, delete a pod, set an image); it only runs after the user reviews a preview and clicks Apply. MCP stays read-only.

```text
src/ai/
├── mod.rs             # module root + /api/ai routes
├── tools.rs           # read-only kubectl tools (shared by chat and MCP), argument validation
├── actions.rs         # changes the in-app assistant may propose: preview + apply after approval
├── redact.rs          # masks passwords, tokens, keys, private keys, URL credentials, random-looking tokens
├── agent.rs           # in-app chat: HTTP handlers + tool-calling loop + permission pause
├── mcp.rs             # MCP server on stdio (`kubellens --mcp`)
├── keystore.rs        # API keys in Windows Credential Manager / macOS Keychain (Linux: 0600 file)
├── settings.rs        # default provider, model and endpoint per provider (no secrets)
└── providers/
    ├── mod.rs         # provider list, endpoints, provider-neutral messages, HTTP client, error mapping
    ├── anthropic.rs   # Claude (Messages API, tool use)
    ├── gemini.rs      # Gemini (generateContent, function calling)
    └── openai.rs      # OpenAI Chat Completions: OpenAI / compatible gateways, Azure OpenAI, Ollama

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

These can't change the cluster. Arguments are validated, and values never start with `-`, so they can't be read as kubectl flags. Output is capped at 15,000 characters per call.

### Proposed changes (in-app chat only)

| Tool | kubectl | Preview shows |
| :--- | :--- | :--- |
| `restart_workload` | `rollout restart <kind>/<name>` | last restart → now, pod count |
| `scale_workload` | `scale --replicas=N` (0–100) | replicas current → new; red when scaling to 0 |
| `rollback_deployment` | `rollout undo [--to-revision=N]` | revision and each changed image |
| `delete_pod` | `delete pod --wait=false` | whether a controller recreates it; red when nothing does |
| `set_image` | `set image <kind>/<name> <container>=<image>` | container image old → new |

A proposal pauses the chat loop with a `permission` event of kind `action`. Its preview is computed from the live object (and fails, back to the model, when the target doesn't exist or nothing would change). The change runs only when the UI resends the conversation with `approvals: { <id>: true }`; declining tells the model nothing changed. These tools are not offered over MCP.

## Sensitive data and permission

1. Every tool output is masked by `redact.rs` before it goes to the provider. Secret objects are also masked structurally (`data` / `stringData` values become `[REDACTED: n chars]`).
2. If the model needs a real value, it must call the tool again with `reveal: true`.
3. **In the app:** the chat loop stops and shows a permission card. **Allow** reveals the values for that one call; **Keep masked** sends the masked output again.
4. **Over MCP:** the server asks the user through MCP *elicitation*. Clients without elicitation support get masked output plus a note.

Masking is best effort (pattern based). It covers common shapes, including config files embedded in JSON strings, well-known token prefixes (GitHub, GitLab, Slack, Google, Stripe, OpenAI, Anthropic, npm), Azure SAS signatures and account keys. Secrets printed without a label, as in application logs, are caught by a randomness check: 24+ characters mixing upper case, lower case and digits, switching between them often, with near-maximum entropy. Hex strings (digests, UUIDs, container ids), lower-case Kubernetes names, dotted names, paths and certificates are left alone. On 7,984 real log lines it masked nothing; it catches 98–100% of random 24–40 character tokens. The unit tests in `redact.rs` list what is covered.

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
| API keys | OS credential store, service `kubellens-ai`. `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` / `GOOGLE_API_KEY`, `OPENAI_API_KEY` or `AZURE_OPENAI_API_KEY` is used when no key is saved. Ollama needs no key |
| Settings | `<config dir>/kubellens/ai-settings.json` (provider, models, endpoints) |
| Endpoints | OpenAI: optional base URL (default `https://api.openai.com/v1`, or any compatible gateway). Azure: resource endpoint (`AZURE_OPENAI_ENDPOINT` as fallback) plus deployment name, API version `2024-10-21`. Ollama: server URL (default `http://localhost:11434/v1`); connecting it is what marks it as connected |
| Gateways / tests | `KUBELLENS_ANTHROPIC_BASE_URL`, `KUBELLENS_GEMINI_BASE_URL`, `KUBELLENS_OPENAI_BASE_URL`, `KUBELLENS_OLLAMA_BASE_URL` (override saved endpoints) |
| Sign-in links | `POST /api/ai/open-url` opens only the providers' API key pages in the system browser |

Connecting checks the provider first by listing its models. Azure can't list deployments, so it sends a one-word request to the deployment instead.

## Tests

```bash
cargo test ai::
```

These cover masking (including config files embedded in JSON), argument validation, and parsing / command building of the proposed changes.
