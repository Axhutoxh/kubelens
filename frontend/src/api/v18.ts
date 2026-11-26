// Clients for the 1.8 endpoints: port forwards to services / workloads, live updates, usage
// history, manifest review and field help, Helm install / upgrade, cross-cluster search,
// alert webhooks and kubeconfig management.

const API = '/api';

async function get<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
  const url = new URL(`${API}${path}`, window.location.origin);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') url.searchParams.set(k, v); });
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error((await res.text()) || `Request failed (${res.status})`);
  return res.json();
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error((await res.text()) || `Request failed (${res.status})`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Port forwards to any target
// ---------------------------------------------------------------------------

export type ForwardKind = 'pod' | 'service' | 'deployment' | 'statefulset';

export function startForward(opts: { kind: ForwardKind; name: string; namespace: string; port: number; localPort?: number; context?: string }) {
  return post<{ success: boolean; session: import('../types/k8s').PortForwardSession }>('/port-forward/start', {
    kind: opts.kind,
    name: opts.name,
    namespace: opts.namespace,
    containerPort: opts.port,
    localPort: opts.localPort,
    context: opts.context,
  });
}

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------

export function watchUrl(kinds: string[], namespace?: string, context?: string) {
  const url = new URL(`${API}/watch`, window.location.origin);
  url.searchParams.set('kinds', kinds.join(','));
  if (namespace && namespace !== '_all') url.searchParams.set('namespace', namespace);
  if (context) url.searchParams.set('context', context);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Usage history
// ---------------------------------------------------------------------------

/** [unix seconds, CPU millicores, memory MiB] */
export type UsagePoint = [number, number, number];

export function fetchUsageHistory(namespace: string, pods: string[], context?: string) {
  return get<{ pods: Record<string, UsagePoint[]>; sampleEverySecs: number; keepSecs: number }>('/metrics/history', {
    namespace,
    pods: pods.join(','),
    context,
  });
}

// ---------------------------------------------------------------------------
// Manifest review and field help
// ---------------------------------------------------------------------------

export interface ReviewedObject {
  kind: string;
  name: string;
  namespace: string;
  action: 'create' | 'update' | 'unchanged';
  live: unknown | null;
  after: unknown;
}

export function reviewManifest(manifest: string, context?: string) {
  return post<{ valid: boolean; errors?: string; objects: ReviewedObject[] }>('/k8s/review', { manifest, context });
}

export interface ExplainField {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export function explainPath(path: string, context?: string) {
  return get<{ path: string; fields: ExplainField[] }>('/k8s/explain', { path, context });
}

// ---------------------------------------------------------------------------
// Helm install / upgrade
// ---------------------------------------------------------------------------

export interface HelmChart { name: string; version: string; app_version: string; description: string }

export const helmRepos = () => get<{ repos: Array<{ name: string; url: string }>; error?: string; helmMissing?: boolean }>('/helm/repos');
export const helmAddRepo = (name: string, url: string) => post<{ success: boolean; output: string }>('/helm/repos', { name, url });
export const helmUpdateRepos = () => post<{ success: boolean; output: string }>('/helm/repos/update', {});
export const helmSearch = (q: string) => get<{ charts: HelmChart[] }>('/helm/search', { q });
export const helmVersions = (chart: string) => get<{ versions: HelmChart[] }>('/helm/versions', { chart });
export const helmChartValues = (chart: string, version?: string) => get<{ values: string }>('/helm/chart-values', { chart, version });
export function helmUpgrade(req: {
  release: string; namespace: string; chart: string; version?: string; values: string;
  install: boolean; createNamespace: boolean; dryRun: boolean; context?: string;
}) {
  return post<{ success: boolean; dryRun: boolean; output: string }>('/helm/upgrade', req);
}

// ---------------------------------------------------------------------------
// Search all clusters
// ---------------------------------------------------------------------------

export interface ClusterSearchHit { kind: string; namespace: string; name: string; images?: string[]; matched: 'name' | 'image' }
export interface ClusterSearchResult { context: string; hits: ClusterSearchHit[]; total: number; error?: string }

export const searchAllClusters = (q: string) => get<{ clusters: ClusterSearchResult[]; skipped: number }>('/search/clusters', { q });

// ---------------------------------------------------------------------------
// Alert webhooks
// ---------------------------------------------------------------------------

export interface NotifySettings { enabled: boolean; kind: 'slack' | 'teams' | 'generic'; configured: boolean; url: string }

export const notifySettings = () => get<NotifySettings>('/notify/settings');
export const saveNotifySettings = (s: { enabled: boolean; kind: string; url?: string }) => post<NotifySettings>('/notify/settings', s);
export const testNotify = () => post<{ success: boolean }>('/notify/test', {});
export function sendNotify(n: { title: string; text?: string; severity?: string; cluster?: string }) {
  return post<{ sent: boolean }>('/notify/send', n).catch(() => ({ sent: false }));
}

// ---------------------------------------------------------------------------
// Kubeconfig
// ---------------------------------------------------------------------------

export interface KubeContext { name: string; cluster: string; user: string; namespace?: string; server?: string; current: boolean }

export const kubeconfigList = () => get<{ contexts: KubeContext[]; current: string; path?: string; clis: Record<string, boolean> }>('/kubeconfig');
export const kubeconfigRename = (from: string, to: string) => post<{ success: boolean; backup?: string }>('/kubeconfig/rename', { from, to });
export const kubeconfigNamespace = (context: string, namespace: string) => post<{ success: boolean }>('/kubeconfig/namespace', { context, namespace });
export const kubeconfigDelete = (context: string) => post<{ success: boolean; removed: string[]; backup?: string }>('/kubeconfig/delete', { context });
export const kubeconfigImport = (content: string) => post<{ success: boolean; added: string[]; skipped: string[]; backup?: string }>('/kubeconfig/import', { content });

export type CloudProvider = 'aks' | 'eks' | 'gke';
export interface CloudCluster { name: string; resourceGroup?: string; location?: string }
export const cloudList = (provider: CloudProvider, opts: { region?: string; project?: string } = {}) =>
  post<{ clusters: CloudCluster[] }>('/kubeconfig/cloud/list', { provider, ...opts });
export const cloudConnect = (provider: CloudProvider, opts: { name: string; resourceGroup?: string; region?: string; project?: string }) =>
  post<{ success: boolean; output: string; backup?: string }>('/kubeconfig/cloud/connect', { provider, ...opts });
