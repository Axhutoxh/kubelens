const API_BASE = '/api';

export async function fetchContexts() {
  const res = await fetch(`${API_BASE}/contexts`);
  if (!res.ok) throw new Error('Failed to load contexts');
  return res.json();
}

export async function switchContext(contextName: string) {
  const res = await fetch(`${API_BASE}/context/switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context: contextName }),
  });
  if (!res.ok) throw new Error('Failed to switch context');
  return res.json();
}

export async function fetchClusterOverview(context?: string) {
  const url = new URL(`${API_BASE}/cluster/overview`, window.location.origin);
  if (context) url.searchParams.set('context', context);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error('Failed to load overview');
  return res.json();
}

export async function fetchK8sResource<T = any>(
  kind: string, 
  namespace?: string, 
  context?: string
): Promise<{ items: T[] }> {
  const url = new URL(`${API_BASE}/k8s/${kind}`, window.location.origin);
  if (namespace && namespace !== '_all') {
    url.searchParams.set('namespace', namespace);
  }
  if (context && context.trim()) {
    url.searchParams.set('context', context.trim());
  }
  const res = await fetch(url.toString());
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to load ${kind}: ${errText}`);
  }
  return res.json();
}

export async function getResourceManifest(
  kind: string, 
  name: string, 
  namespace?: string,
  context?: string
): Promise<string> {
  const url = new URL(`${API_BASE}/k8s/manifest`, window.location.origin);
  url.searchParams.set('kind', kind);
  url.searchParams.set('name', name);
  if (namespace) url.searchParams.set('namespace', namespace);
  if (context && context.trim()) url.searchParams.set('context', context.trim());
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error('Failed to get manifest');
  return res.text();
}

export async function applyManifest(manifest: string, context?: string) {
  const res = await fetch(`${API_BASE}/k8s/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest, context }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Apply failed: ${errText}`);
  }
  return res.json();
}

export async function deleteResource(
  kind: string, 
  name: string, 
  namespace?: string,
  context?: string
) {
  const res = await fetch(`${API_BASE}/k8s/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, name, namespace, context }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err);
  }
  return res.json();
}

export async function restartResource(
  kind: string, 
  name: string, 
  namespace: string,
  context?: string
) {
  const res = await fetch(`${API_BASE}/k8s/restart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, name, namespace, context }),
  });
  if (!res.ok) throw new Error('Restart failed');
  return res.json();
}

export async function scaleResource(
  kind: string, 
  name: string, 
  namespace: string, 
  replicas: number,
  context?: string
) {
  const res = await fetch(`${API_BASE}/k8s/scale`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, name, namespace, replicas, context }),
  });
  if (!res.ok) throw new Error('Scale failed');
  return res.json();
}

export async function setPodEnv(
  pod: string,
  namespace: string,
  env: Array<{ name: string; value?: string; remove?: boolean }>,
  container?: string,
  context?: string
) {
  const res = await fetch(`${API_BASE}/k8s/env/set`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pod, namespace, env, container, context }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || 'Failed to update environment variables');
  }
  return res.json();
}

export async function startPortForward(
  pod: string,
  namespace: string,
  containerPort: number,
  localPort?: number,
  context?: string
) {
  const res = await fetch(`${API_BASE}/port-forward/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pod, namespace, containerPort, localPort, context }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || 'Failed to start port forward');
  }
  return res.json();
}

export async function stopPortForward(id: string) {
  const res = await fetch(`${API_BASE}/port-forward/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || 'Failed to stop port forward');
  }
  return res.json();
}

export async function fetchPortForwards() {
  const res = await fetch(`${API_BASE}/port-forward/list`);
  if (!res.ok) throw new Error('Failed to fetch port forwards');
  return res.json();
}

export async function fetchResourceDetail<T = any>(
  kind: string, 
  name: string, 
  namespace?: string,
  context?: string
): Promise<T> {
  const url = new URL(`${API_BASE}/resource/detail`, window.location.origin);
  url.searchParams.set('kind', kind);
  url.searchParams.set('name', name);
  if (namespace && namespace !== '_all') url.searchParams.set('namespace', namespace);
  if (context && context.trim()) url.searchParams.set('context', context.trim());
  const res = await fetch(url.toString());
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || `Failed to fetch ${kind}/${name}`);
  }
  return res.json();
}

export async function fetchPodEvents(name: string, namespace: string, context?: string) {
  const url = new URL(`${API_BASE}/resource/events`, window.location.origin);
  url.searchParams.set('name', name);
  url.searchParams.set('namespace', namespace);
  if (context && context.trim()) url.searchParams.set('context', context.trim());
  const res = await fetch(url.toString());
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || 'Failed to fetch pod events');
  }
  return res.json();
}


// ---------------------------------------------------------------------------
// Metrics (requires metrics-server in the cluster)
// ---------------------------------------------------------------------------

export interface PodMetric { namespace: string; name: string; cpu: string; memory: string }
export interface NodeMetric { name: string; cpu: string; cpuPercent: number | null; memory: string; memoryPercent: number | null }
export interface MetricsResponse<T> { available: boolean; items?: T[]; error?: string }

export async function fetchPodMetrics(namespace?: string, context?: string): Promise<MetricsResponse<PodMetric>> {
  const url = new URL(`${API_BASE}/metrics/pods`, window.location.origin);
  if (namespace && namespace !== '_all') url.searchParams.set('namespace', namespace);
  if (context && context.trim()) url.searchParams.set('context', context.trim());
  const res = await fetch(url.toString());
  if (!res.ok) return { available: false, error: await res.text() };
  return res.json();
}

export async function fetchNodeMetrics(context?: string): Promise<MetricsResponse<NodeMetric>> {
  const url = new URL(`${API_BASE}/metrics/nodes`, window.location.origin);
  if (context && context.trim()) url.searchParams.set('context', context.trim());
  const res = await fetch(url.toString());
  if (!res.ok) return { available: false, error: await res.text() };
  return res.json();
}

// ---------------------------------------------------------------------------
// Rollouts & nodes
// ---------------------------------------------------------------------------

async function postJson(path: string, body: unknown, fallbackError: string) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || fallbackError);
  }
  return res.json();
}

export function rolloutUndo(kind: string, name: string, namespace: string, revision?: number, context?: string) {
  return postJson('/k8s/rollout/undo', { kind, name, namespace, revision, context }, 'Rollback failed');
}

export function nodeAction(node: string, action: 'cordon' | 'uncordon' | 'drain', force = false, context?: string) {
  return postJson('/node/action', { node, action, force, context }, `Failed to ${action} node`);
}

// ---------------------------------------------------------------------------
// Helm
// ---------------------------------------------------------------------------

export interface HelmRelease {
  name: string;
  namespace: string;
  revision: string;
  updated: string;
  status: string;
  chart: string;
  app_version: string;
}

export interface HelmHistoryEntry {
  revision: number;
  updated: string;
  status: string;
  chart: string;
  app_version: string;
  description: string;
}

export async function fetchHelmReleases(namespace?: string, context?: string): Promise<{
  available: boolean;
  helmMissing?: boolean;
  releases?: HelmRelease[];
  error?: string;
}> {
  const url = new URL(`${API_BASE}/helm/releases`, window.location.origin);
  if (namespace && namespace !== '_all') url.searchParams.set('namespace', namespace);
  if (context && context.trim()) url.searchParams.set('context', context.trim());
  const res = await fetch(url.toString());
  if (!res.ok) return { available: false, error: await res.text() };
  return res.json();
}

export async function fetchHelmRelease(
  name: string,
  namespace: string,
  what: 'values' | 'manifest' | 'notes' | 'history',
  opts: { all?: boolean; context?: string } = {}
): Promise<{ content?: string; history?: HelmHistoryEntry[] }> {
  const url = new URL(`${API_BASE}/helm/release`, window.location.origin);
  url.searchParams.set('name', name);
  url.searchParams.set('namespace', namespace);
  url.searchParams.set('what', what);
  if (opts.all) url.searchParams.set('all', 'true');
  if (opts.context && opts.context.trim()) url.searchParams.set('context', opts.context.trim());
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error((await res.text()) || `Failed to load helm ${what}`);
  return res.json();
}

export function helmRollback(name: string, namespace: string, revision?: number, context?: string) {
  return postJson('/helm/rollback', { name, namespace, revision, context }, 'Helm rollback failed');
}

export function helmUninstall(name: string, namespace: string, context?: string) {
  return postJson('/helm/uninstall', { name, namespace, context }, 'Helm uninstall failed');
}

// ---------------------------------------------------------------------------
// Streaming endpoints (URLs only; consumers open EventSource / WebSocket)
// ---------------------------------------------------------------------------

export function multiLogsUrl(opts: {
  pods?: Array<{ name: string; namespace: string }>;
  selector?: string;
  namespace?: string;
  tail?: number;
  context?: string;
}) {
  const url = new URL(`${API_BASE}/k8s/logs/multi`, window.location.origin);
  if (opts.pods?.length) url.searchParams.set('pods', opts.pods.map((p) => `${p.namespace}/${p.name}`).join(','));
  if (opts.selector) url.searchParams.set('selector', opts.selector);
  if (opts.namespace) url.searchParams.set('namespace', opts.namespace);
  url.searchParams.set('tail', String(opts.tail ?? 100));
  if (opts.context && opts.context.trim()) url.searchParams.set('context', opts.context.trim());
  return url.toString();
}

export function execSocketUrl(opts: { pod: string; namespace: string; container?: string; context?: string; cols: number; rows: number }) {
  const url = new URL(`${API_BASE}/exec/ws`, window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('pod', opts.pod);
  url.searchParams.set('namespace', opts.namespace);
  if (opts.container) url.searchParams.set('container', opts.container);
  if (opts.context && opts.context.trim()) url.searchParams.set('context', opts.context.trim());
  url.searchParams.set('cols', String(opts.cols));
  url.searchParams.set('rows', String(opts.rows));
  return url.toString();
}
