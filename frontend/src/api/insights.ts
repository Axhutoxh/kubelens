// Clients for the cluster-insight endpoints: certificates, log search, RBAC, timelines and
// multi-cluster health (src/certs.rs, logsearch.rs, rbac.rs, timeline.rs, clusters.rs).

const API_BASE = '/api';

async function getJson<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
  const url = new URL(`${API_BASE}${path}`, window.location.origin);
  Object.entries(params).forEach(([k, v]) => { if (v && v.trim()) url.searchParams.set(k, v.trim()); });
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error((await res.text()) || `Request failed (${res.status})`);
  return res.json();
}

// ---------------------------------------------------------------------------
// TLS certificates
// ---------------------------------------------------------------------------

export interface CertInfo {
  subject: string;
  commonName: string | null;
  dnsNames: string[];
  issuer: string;
  notBefore: number;
  notAfter: number;
  selfSigned: boolean;
}

export interface CertEntry {
  namespace: string;
  name: string;
  leaf?: CertInfo;
  /** Earliest expiry in the bundle (seconds since epoch) */
  expiresAt?: number;
  daysLeft?: number;
  /** A chain certificate that expires before the leaf */
  expiringSubject?: string;
  chainLength: number;
  /** cert-manager Certificate that renews this Secret */
  managedBy?: string;
  usedBy: Array<{ ingress: string; hosts: string[] }>;
  /** An Ingress refers to this Secret but it doesn't exist */
  missing: boolean;
  error?: string;
}

export function fetchCerts(namespace?: string, context?: string) {
  return getJson<{ items: CertEntry[]; now: number }>('/certs', { namespace: namespace === '_all' ? undefined : namespace, context });
}

// ---------------------------------------------------------------------------
// Log search
// ---------------------------------------------------------------------------

export interface LogSearchRequest {
  namespace?: string;
  podFilter?: string;
  selector?: string;
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  since?: string;
  context?: string;
}

export interface LogMatch {
  ts: string;
  namespace: string;
  pod: string;
  container: string;
  line: string;
}

export interface LogSearchResult {
  matches: LogMatch[];
  totalMatches: number;
  truncated: boolean;
  containers: Array<{ namespace: string; pod: string; container: string; matches: number; error?: string; capped: boolean }>;
  podsSearched: number;
  podsSkipped: number;
  since: string;
}

export async function searchLogs(req: LogSearchRequest, signal?: AbortSignal): Promise<LogSearchResult> {
  const res = await fetch(`${API_BASE}/logs/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok) throw new Error((await res.text()) || 'Log search failed');
  return res.json();
}

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------

export interface RbacRule {
  verbs: string[];
  apiGroups: string[];
  resources: string[];
  resourceNames: string[];
  nonResourceUrls: string[];
}

export interface RbacGrant {
  /** "*" for a ClusterRoleBinding, else the namespace */
  scope: string;
  bindingKind: 'RoleBinding' | 'ClusterRoleBinding';
  bindingName: string;
  bindingNamespace?: string;
  /** Key into `roles` */
  role: string;
  roleMissing: boolean;
  viaGroup?: string;
}

export interface RbacSubject {
  kind: 'User' | 'Group' | 'ServiceAccount';
  name: string;
  namespace?: string;
  grants: RbacGrant[];
}

export interface RbacIndex {
  roles: Record<string, RbacRule[]>;
  subjects: RbacSubject[];
}

export function fetchRbac(context?: string) {
  return getJson<RbacIndex>('/rbac', { context });
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export interface TimelineEntry {
  time: string;
  category: 'rollout' | 'change' | 'restart' | 'config' | 'scale' | 'pod' | 'event';
  severity: 'info' | 'warning' | 'error';
  title: string;
  detail?: string;
  object?: string;
}

export function fetchTimeline(kind: string, name: string, namespace: string, context?: string) {
  return getJson<{ entries: TimelineEntry[]; truncated: boolean; pods: number }>('/timeline', { kind, name, namespace, context });
}

// ---------------------------------------------------------------------------
// All clusters
// ---------------------------------------------------------------------------

export interface ClusterHealth {
  context: string;
  reachable: boolean;
  error?: string;
  nodesTotal: number;
  nodesReady: number;
  nodesError?: string;
  pods: { total: number; running: number; pending: number; failing: number };
  warningsLastHour: number | null;
  problems: Array<{ namespace: string; pod: string; reason: string }>;
  tookMs: number;
}

export function fetchClustersHealth() {
  return getJson<{ clusters: ClusterHealth[]; current: string; skipped: number }>('/clusters/health');
}
