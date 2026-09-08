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


