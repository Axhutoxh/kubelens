## Kubellens v1.3.0

Finding things, shipping releases and comparing environments, without leaving the app.

### New
- **Find in text**: search inside ConfigMap values and the YAML editor (Ctrl+F) with in-place highlights, a "3 of 12" counter and next / previous.
- **Smarter logs**: previous (crashed) container logs, time ranges, coloured ERROR / WARN lines with an "errors only" filter, regex filter and pretty-printed JSON.
- **Release drift**: deployments that aren't on the tag their neighbours run are flagged and can be selected in one click.
- **Live rollout tracking**: after setting an image tag, watch each deployment roll out, see image pull failures and crash loops, and **Undo all** in one click.
- **Safe ConfigMap edits**: review a diff before applying, then restart the workloads that use the ConfigMap (also after saving a Secret).
- **Environment diff**: Smart Lens Studio's **Diff** mode compares deployments (images, env, resources) and ConfigMaps between two clusters or namespaces.
- **Pod alerts**: a bell watches for CrashLoopBackOff, OOMKilled, image pull failures and evictions, with a toast, optional desktop notification and taskbar flash.
- **Workspaces**: save cluster + namespace + view + filter and switch back in one click.

### Fixes
- Smart Lens Studio no longer shows stale data after switching cluster / namespace quickly, and shows load errors instead of treating them as empty lists.
- Log stream errors (for example "no previous container") are shown in the log pane instead of waiting forever.

### Downloads
| Platform | File |
| :--- | :--- |
| Windows | `kubellens-setup.exe` (installer), `kubellens.exe` (portable) |
| macOS (Apple Silicon + Intel) | `kubellens-macos-universal.dmg` |
| Linux | `kubellens-linux-amd64.AppImage`, `.deb`, `.rpm` |
