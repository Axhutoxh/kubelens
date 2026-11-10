## Kubellens v1.7.0: AI fixes, certificate expiry, log search and more

Let the AI assistant fix things (only after you click Apply), catch expiring TLS certificates, search logs across many pods, and see what changed before something broke.

### New
- **AI fixes with your approval**: the assistant can propose a restart, scale, rollback, pod delete or image change. You see the target cluster, current → new values and the exact kubectl command; nothing runs until you click **Apply**, and you can decline. MCP stays read-only.
- **TLS certificate expiry**: **Configuration → TLS Certificates** lists every TLS Secret with its domains, issuer, expiry and the Ingresses using it, and flags Ingresses whose Secret is missing. The alert bell warns 30, 7 and 1 days before expiry and when a certificate has expired.
- **Log Search**: search up to 40 pods at once (e.g. `payments-*`) over the last 15 minutes to 24 hours. Matches are merged by time; click one to open that pod's live logs, or save the results.
- **Timeline**: a new button on Deployments, StatefulSets, DaemonSets and Pods shows rollouts (with image changes), spec edits, restarts and OOM kills, ConfigMap / Secret changes and events in one list, with **Ask AI** to find what changed before it broke.
- **All Clusters**: nodes ready, failing and pending pods and warnings of every kubeconfig context on one page, refreshed every minute.
- **Who Can Do What**: ask who can read Secrets, exec into pods, delete pods or grant roles, or pick a user, group or service account to see everything it may do.
- **More resource views**: Autoscalers (HPA), Pod Disruption Budgets, Network Policies, Quotas & Limits, Service Accounts, Roles & Bindings, with problems called out (autoscaler at max, budgets that block node drains, deny-all policies).
- **Deployment health score**: a 0–100 score per deployment for limits, requests, probes, pinned image tags, replicas and root containers, with a filter for the ones below target.
- **Saved log filters & bookmarks**: save a log filter, bookmark log lines and jump back to them; both belong to the active workspace.
- **Export AI chats**: save a conversation as Markdown or copy it. Only questions, answers and what was checked are included, never raw cluster data.

### Notes
- Proposed changes run with your own kubeconfig credentials, against the cluster shown on the card.
- Who Can Do What reads Roles and bindings; it can't see group memberships from your identity provider or webhook authorizers.
- If you customised the Deployments columns before, turn on the new **Health** column under **Columns**.

### Downloads
| Platform | File |
| :--- | :--- |
| Windows | `kubellens-setup.exe` (installer), `kubellens.exe` (portable) |
| macOS (Apple Silicon + Intel) | `kubellens-macos-universal.dmg` |
| Linux | `kubellens-linux-amd64.AppImage`, `.deb`, `.rpm` |

Already on 1.6.0? Kubellens offers this update itself: click **Update** in the top bar.
