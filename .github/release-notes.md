## Kubellens v1.8.0: live updates, debug shells, Helm installs and a locked-down API

Views update the moment something changes, port forwards survive pod restarts, and you can debug shell-less images, install Helm charts, search every cluster and manage your kubeconfig, all inside Kubellens.

### New
- **Live updates**: the views on screen update as soon as something changes in the cluster, instead of every 10 seconds. The footer shows **● Live**, or **○ Polling** when the cluster can't be watched.
- **Better port forwarding**: forward to Services and Deployments, not just pods. If the connection drops (for example the pod restarts), Kubellens reconnects on the same local port. Save forwards per workspace and restart them with one click (**Start all**). Forwards open in your browser and stop when the app closes.
- **Debug shells**: **Debug shell** adds a temporary debug container to a pod, so you get a shell even when the image has none. **Node shell** gives a root shell on a node through a helper pod that is removed afterwards. Both ask before changing anything.
- **CPU and memory history**: a chart per deployment with requests and limits, plus right-sizing advice (requests too high, too low, or close to the memory limit).
- **Safer YAML editing**: **Review & Apply** validates the manifest with the cluster first and shows exactly what changes per object. Ctrl+Space shows the valid fields at the cursor, from the cluster's own schema.
- **Helm install and upgrade**: add chart repositories, search charts, pick a version, edit values with a diff, run a dry run, then install or upgrade.
- **Search all clusters**: find pods, workloads, Services, Ingresses, ConfigMaps and Secrets by name, or workloads by image, in every kubeconfig context at once.
- **Alerts to Slack or Teams**: forward pod and certificate alerts to a Slack, Microsoft Teams or generic webhook (alerts bell → Send alerts to Slack / Teams).
- **Kubeconfig management**: rename contexts, set default namespaces, delete contexts, import and merge another kubeconfig, and add AKS, EKS or GKE clusters with their CLIs. Every change saves a backup first.

### Security
- **The local API is locked down.** Until now, any website open in your browser could send requests to Kubellens on localhost. Now only the Kubellens window can: requests need a per-launch session token, and requests from other sites or host names are refused.

### Fixes
- Port forwards wait until kubectl is really forwarding, show kubectl's own error messages, pick a free local port automatically, and work over IPv4 and IPv6.
- **Open in browser** for port forwards now works in the desktop app.

### Notes
- Debug shells need permission to add ephemeral containers; node shells need permission to create privileged pods. A pod keeps its stopped debug container until it is replaced (that's how Kubernetes works).
- Helm install / upgrade needs the `helm` CLI; cloud sign-in needs `az`, `aws` or `gcloud`.

### Downloads
| Platform | File |
| :--- | :--- |
| Windows | `kubellens-setup.exe` (installer), `kubellens.exe` (portable) |
| macOS (Apple Silicon + Intel) | `kubellens-macos-universal.dmg` |
| Linux | `kubellens-linux-amd64.AppImage`, `.deb`, `.rpm` |

Already on 1.6 or later? Kubellens offers this update itself: click **Update** in the top bar.
