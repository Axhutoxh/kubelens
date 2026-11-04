## Kubellens v1.6.0: more AI providers, in-app updates

Use OpenAI, Azure OpenAI or a local Ollama model with the AI assistant, keep secrets in application logs masked, update Kubellens from inside the app, and see ConfigMaps and Secrets in one list.

### New
- **OpenAI, Azure OpenAI and Ollama**: connect them in AI settings next to Claude and Gemini.
  - **OpenAI**: paste an API key. An optional base URL also works with OpenAI-compatible gateways.
  - **Azure OpenAI**: enter your resource endpoint, deployment name and key; all three are checked when you save.
  - **Ollama**: no key needed. Models run on your own machine, so cluster data never leaves it.
- **Secrets in logs stay masked**: besides labelled passwords and tokens, the assistant now masks well-known token formats (GitHub, GitLab, Slack, Google, Stripe, OpenAI, Anthropic, npm), Azure SAS signatures and storage account keys, and random-looking tokens printed without a label. Pod names, UUIDs, image digests and certificates are left alone.
- **In-app updates**: Kubellens checks for a new release shortly after it starts. An **Update** button in the top bar shows the release notes; **Install & restart** downloads the installer, checks it against the release's SHA-256 checksum, and runs it. Check any time by clicking the version in the sidebar or with **Check for updates** in Ctrl+K.
- **ConfigMaps & Secrets in one list**: a new **Configuration → ConfigMaps & Secrets** view lists both together, with a Kind column (including the Secret type: Opaque, TLS, Docker config, Helm release…), All / ConfigMaps / Secrets filters and search. Rows open the usual editors.

### Notes
- This is the first version with in-app updates, so 1.5.0 has to be updated by downloading this release. From 1.6.0 on, Kubellens offers new versions itself.
- One-click install works for the Windows installer, the macOS dmg (opens it) and the Linux AppImage. The portable `.exe`, `.deb` and `.rpm` link to the release page instead.
- Set `KUBELLENS_NO_UPDATE_CHECK=1` to turn update checks off.

### Downloads
| Platform | File |
| :--- | :--- |
| Windows | `kubellens-setup.exe` (installer), `kubellens.exe` (portable) |
| macOS (Apple Silicon + Intel) | `kubellens-macos-universal.dmg` |
| Linux | `kubellens-linux-amd64.AppImage`, `.deb`, `.rpm` |
