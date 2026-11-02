## Kubellens v1.5.0: AI assistant

Ask Claude or Gemini about your clusters, right inside Kubellens, without giving away your secrets.

### New
- **AI Chat window**: open **AI Chat** in the sidebar (or **Ask AI** in the top bar). Pick any cluster and namespace from your kubeconfig in the chat itself and ask away. Conversations are kept in a list; only questions and answers are saved.
- **Connect your AI account**: **Sign in** opens Anthropic Console or Google AI Studio in your browser. Create an API key, paste it, done. The key is checked, then stored in Windows Credential Manager / macOS Keychain.
- **Grounded, read-only answers**: the assistant looks at live data (resources, describe, manifests, logs including crashed containers, events, metrics) before answering. It can't change your cluster; it tells you the Kubellens action or kubectl command to use.
- **You approve every reveal**: passwords, tokens, keys, private keys, credentials in URLs and Secret values are masked before anything is sent. If the AI needs a real value, you choose **Allow** or **Keep masked** for that one request.
- **Quick side panel**: **Ctrl+I** opens the assistant next to any view; **Ask AI** on a pod alert starts a diagnosis.
- **MCP server**: run `Kubellens --mcp` to give Claude Desktop, Claude Code, Gemini CLI and other MCP clients the same read-only tools and masking. AI settings has copy-ready setup snippets.

### Notes
- An Anthropic or Google AI Studio **API key** is required; usage is billed to that API account. Third-party apps can't use Claude.ai or Gemini chat subscriptions.
- Cluster data you ask about is sent to the AI provider you choose (masked as described above). Check your organisation's policy for AI use.

### Downloads
| Platform | File |
| :--- | :--- |
| Windows | `kubellens-setup.exe` (installer), `kubellens.exe` (portable) |
| macOS (Apple Silicon + Intel) | `kubellens-macos-universal.dmg` |
| Linux | `kubellens-linux-amd64.AppImage`, `.deb`, `.rpm` |
