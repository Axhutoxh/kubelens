import React, { useEffect, useState } from 'react';
import { Gauge, ShieldHalf, Shield, Scale, UserCog, KeyRound, FileCode, Trash2, Loader2, LucideIcon } from 'lucide-react';
import { fetchK8sResource } from '../api/client';
import { notables } from '../utils/rbac';

// List views for kinds that had no page of their own: autoscalers, disruption budgets,
// network policies, quotas / limit ranges, service accounts and RBAC objects.

interface Column {
  label: string;
  title?: string;
  render: (it: any) => React.ReactNode;
}

interface KindTab {
  kind: string;
  label: string;
  namespaced: boolean;
  columns: Column[];
  empty: string;
}

interface ViewConfig {
  title: string;
  icon: LucideIcon;
  hint?: string;
  tabs: KindTab[];
}

export const POLICY_VIEW_IDS = ['hpa', 'pdb', 'networkpolicies', 'quotas', 'serviceaccounts', 'roles'] as const;
export type PolicyViewId = (typeof POLICY_VIEW_IDS)[number];

const tone = {
  ok: 'bg-emerald-950 text-emerald-400 border-emerald-800/80',
  warn: 'bg-amber-950 text-amber-300 border-amber-800/80',
  bad: 'bg-rose-950 text-rose-300 border-rose-800/80',
  dim: 'bg-slate-800 text-slate-400 border-slate-700',
};
const Badge: React.FC<{ t: keyof typeof tone; children: React.ReactNode; title?: string }> = ({ t, children, title }) => (
  <span title={title} className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold whitespace-nowrap ${tone[t]}`}>{children}</span>
);
const dash = <span className="text-slate-600">—</span>;

function age(ts?: string) {
  if (!ts) return '—';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Kubernetes quantity ("500m", "2Gi", "10") as a plain number, for used / hard ratios */
export function quantity(q: unknown): number {
  const s = String(q ?? '').trim();
  const m = /^([0-9.]+)([a-zA-Z]*)$/.exec(s);
  if (!m) return NaN;
  const mult: Record<string, number> = { '': 1, m: 1e-3, u: 1e-6, n: 1e-9, k: 1e3, M: 1e6, G: 1e9, T: 1e12, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 };
  return parseFloat(m[1]) * (mult[m[2]] ?? NaN);
}

function selectorText(sel: any): string {
  if (!sel || (!sel.matchLabels && !sel.matchExpressions)) return '';
  const labels = Object.entries(sel.matchLabels || {}).map(([k, v]) => `${k}=${v}`);
  const exprs = (sel.matchExpressions || []).map((e: any) => `${e.key} ${e.operator}${e.values ? ` (${e.values.join(',')})` : ''}`);
  return [...labels, ...exprs].join(', ');
}

function peers(list: any[] | undefined): string {
  if (!list || list.length === 0) return 'anywhere';
  return list.map((p) => {
    if (p.ipBlock) return `IP ${p.ipBlock.cidr}`;
    const parts: string[] = [];
    if (p.namespaceSelector) parts.push(selectorText(p.namespaceSelector) ? `ns: ${selectorText(p.namespaceSelector)}` : 'all namespaces');
    if (p.podSelector) parts.push(selectorText(p.podSelector) ? `pods: ${selectorText(p.podSelector)}` : 'all pods');
    return parts.join(' & ');
  }).join(' | ');
}

function subjectsText(subjects: any[] | undefined) {
  return (subjects || []).map((s) => `${s.kind === 'ServiceAccount' ? 'sa' : s.kind.toLowerCase()}:${s.namespace ? `${s.namespace}/` : ''}${s.name}`);
}

const hpaMetric = (m: any, status: any) => {
  const r = m.resource || m.containerResource;
  if (r) {
    const cur = status?.resource?.current?.averageUtilization ?? status?.containerResource?.current?.averageUtilization;
    const target = r.target?.averageUtilization;
    if (target !== undefined) return { text: `${r.name} ${cur ?? '?'}% / ${target}%`, hot: cur !== undefined && cur >= target };
    return { text: `${r.name} ${status?.resource?.current?.averageValue ?? '?'} / ${r.target?.averageValue ?? '?'}`, hot: false };
  }
  const name = m.pods?.metric?.name || m.object?.metric?.name || m.external?.metric?.name || m.type;
  return { text: `${name}`, hot: false };
};

const CONFIGS: Record<PolicyViewId, ViewConfig> = {
  hpa: {
    title: 'Horizontal Pod Autoscalers',
    icon: Gauge,
    hint: 'Scales workloads on CPU, memory or custom metrics',
    tabs: [{
      kind: 'horizontalpodautoscalers',
      label: 'Autoscalers',
      namespaced: true,
      empty: 'No autoscalers.',
      columns: [
        { label: 'Target', render: (h) => <span>{h.spec?.scaleTargetRef?.kind?.toLowerCase()}/{h.spec?.scaleTargetRef?.name}</span> },
        { label: 'Replicas', title: 'current → desired (min – max)', render: (h) => {
          const cur = h.status?.currentReplicas ?? 0;
          const max = h.spec?.maxReplicas;
          const atMax = max !== undefined && cur >= max;
          return (
            <span className="flex items-center gap-1.5 whitespace-nowrap">
              {cur} → {h.status?.desiredReplicas ?? '?'}
              <span className="text-slate-500">({h.spec?.minReplicas ?? 1} – {max})</span>
              {atMax && <Badge t="warn" title="Running at its maximum: it can't scale further if load grows">at max</Badge>}
            </span>
          );
        } },
        { label: 'Metrics', render: (h) => {
          const specs = h.spec?.metrics || [];
          if (!specs.length) return dash;
          return <div className="space-y-0.5">{specs.map((m: any, i: number) => {
            const x = hpaMetric(m, (h.status?.currentMetrics || [])[i]);
            return <div key={i} className={`whitespace-nowrap ${x.hot ? 'text-amber-300' : ''}`}>{x.text}</div>;
          })}</div>;
        } },
        { label: 'Status', render: (h) => {
          const conds: any[] = h.status?.conditions || [];
          const bad = conds.find((c) => (c.type === 'AbleToScale' || c.type === 'ScalingActive') && c.status === 'False');
          if (bad) return <Badge t="bad" title={bad.message}>{bad.reason}</Badge>;
          const limited = conds.find((c) => c.type === 'ScalingLimited' && c.status === 'True');
          return limited ? <Badge t="warn" title={limited.message}>{limited.reason}</Badge> : <Badge t="ok">Active</Badge>;
        } },
      ],
    }],
  },
  pdb: {
    title: 'Pod Disruption Budgets',
    icon: ShieldHalf,
    hint: 'How many pods may be down during node drains and upgrades',
    tabs: [{
      kind: 'poddisruptionbudgets',
      label: 'Budgets',
      namespaced: true,
      empty: 'No disruption budgets.',
      columns: [
        { label: 'Pods', render: (p) => <span className="truncate block max-w-xs" title={selectorText(p.spec?.selector)}>{selectorText(p.spec?.selector) || 'all pods'}</span> },
        { label: 'Budget', render: (p) => p.spec?.minAvailable !== undefined ? `min available ${p.spec.minAvailable}` : `max unavailable ${p.spec?.maxUnavailable ?? '?'}` },
        { label: 'Healthy', title: 'current / desired healthy pods', render: (p) => `${p.status?.currentHealthy ?? '?'} / ${p.status?.desiredHealthy ?? '?'}` },
        { label: 'Disruptions allowed', render: (p) => {
          const n = p.status?.disruptionsAllowed;
          if (n === undefined) return dash;
          return n === 0
            ? <Badge t="bad" title="Draining a node that runs these pods will wait (or fail) until more pods are healthy">0: blocks drains</Badge>
            : <Badge t="ok">{n}</Badge>;
        } },
      ],
    }],
  },
  networkpolicies: {
    title: 'Network Policies',
    icon: Shield,
    hint: 'Which traffic may reach (ingress) and leave (egress) pods',
    tabs: [{
      kind: 'networkpolicies',
      label: 'Policies',
      namespaced: true,
      empty: 'No network policies: all pod traffic is allowed in this scope.',
      columns: [
        { label: 'Applies to', render: (n) => selectorText(n.spec?.podSelector) || <span className="text-slate-400">all pods in namespace</span> },
        { label: 'Ingress (from)', render: (n) => {
          const types: string[] = n.spec?.policyTypes || ['Ingress'];
          if (!types.includes('Ingress')) return <span className="text-slate-500">not restricted</span>;
          const rules: any[] = n.spec?.ingress || [];
          if (rules.length === 0) return <Badge t="bad">deny all</Badge>;
          return <div className="space-y-0.5 max-w-sm">{rules.map((r, i) => (
            <div key={i} className="truncate" title={peers(r.from)}>{peers(r.from)}{r.ports ? <span className="text-slate-500"> · {r.ports.map((p: any) => `${p.port ?? '*'}/${p.protocol || 'TCP'}`).join(', ')}</span> : null}</div>
          ))}</div>;
        } },
        { label: 'Egress (to)', render: (n) => {
          const types: string[] = n.spec?.policyTypes || [];
          if (!types.includes('Egress')) return <span className="text-slate-500">not restricted</span>;
          const rules: any[] = n.spec?.egress || [];
          if (rules.length === 0) return <Badge t="bad">deny all</Badge>;
          return <div className="space-y-0.5 max-w-sm">{rules.map((r, i) => (
            <div key={i} className="truncate" title={peers(r.to)}>{peers(r.to)}{r.ports ? <span className="text-slate-500"> · {r.ports.map((p: any) => `${p.port ?? '*'}/${p.protocol || 'TCP'}`).join(', ')}</span> : null}</div>
          ))}</div>;
        } },
      ],
    }],
  },
  quotas: {
    title: 'Quotas & Limits',
    icon: Scale,
    hint: 'Namespace resource quotas and default container limits',
    tabs: [
      {
        kind: 'resourcequotas',
        label: 'Resource quotas',
        namespaced: true,
        empty: 'No resource quotas.',
        columns: [
          { label: 'Usage', render: (q) => {
            const hard = q.status?.hard || q.spec?.hard || {};
            const used = q.status?.used || {};
            return (
              <div className="space-y-1 min-w-[280px]">
                {Object.keys(hard).sort().map((k) => {
                  const pct = Math.min(100, (quantity(used[k] ?? 0) / quantity(hard[k])) * 100);
                  const color = !isFinite(pct) ? 'bg-slate-600' : pct >= 90 ? 'bg-rose-500' : pct >= 75 ? 'bg-amber-500' : 'bg-emerald-500';
                  return (
                    <div key={k} className="flex items-center gap-2">
                      <span className="w-40 truncate text-slate-400" title={k}>{k}</span>
                      <div className="flex-1 h-1.5 rounded bg-slate-800 overflow-hidden"><div className={`h-full ${color}`} style={{ width: `${isFinite(pct) ? pct : 0}%` }} /></div>
                      <span className="w-28 text-right text-slate-300 whitespace-nowrap">{used[k] ?? 0} / {hard[k]}</span>
                    </div>
                  );
                })}
              </div>
            );
          } },
        ],
      },
      {
        kind: 'limitranges',
        label: 'Limit ranges',
        namespaced: true,
        empty: 'No limit ranges.',
        columns: [
          { label: 'Limits', render: (l) => (
            <div className="space-y-0.5">
              {(l.spec?.limits || []).map((x: any, i: number) => (
                <div key={i}>
                  <span className="text-slate-400">{x.type}</span>
                  {x.default && <span> · default {Object.entries(x.default).map(([k, v]) => `${k} ${v}`).join(', ')}</span>}
                  {x.defaultRequest && <span> · request {Object.entries(x.defaultRequest).map(([k, v]) => `${k} ${v}`).join(', ')}</span>}
                  {x.max && <span className="text-amber-300/90"> · max {Object.entries(x.max).map(([k, v]) => `${k} ${v}`).join(', ')}</span>}
                </div>
              ))}
            </div>
          ) },
        ],
      },
    ],
  },
  serviceaccounts: {
    title: 'Service Accounts',
    icon: UserCog,
    hint: 'Identities pods run as; see Who Can Do What for their permissions',
    tabs: [{
      kind: 'serviceaccounts',
      label: 'Service accounts',
      namespaced: true,
      empty: 'No service accounts.',
      columns: [
        { label: 'Token mount', title: 'automountServiceAccountToken', render: (s) => s.automountServiceAccountToken === false ? <Badge t="ok">off</Badge> : <Badge t="dim">on (default)</Badge> },
        { label: 'Image pull secrets', render: (s) => (s.imagePullSecrets || []).map((x: any) => x.name).join(', ') || dash },
        { label: 'Workload identity', render: (s) => {
          const a = s.metadata?.annotations || {};
          const id = a['azure.workload.identity/client-id'] || a['eks.amazonaws.com/role-arn'] || a['iam.gke.io/gcp-service-account'];
          return id ? <span className="truncate block max-w-xs" title={id}>{id}</span> : dash;
        } },
      ],
    }],
  },
  roles: {
    title: 'Roles & Bindings',
    icon: KeyRound,
    hint: 'RBAC objects; Who Can Do What answers questions across all of them',
    tabs: [
      {
        kind: 'roles',
        label: 'Roles',
        namespaced: true,
        empty: 'No roles.',
        columns: [
          { label: 'Rules', render: (r) => `${(r.rules || []).length}` },
          { label: 'Notable', render: (r) => <span className="flex gap-1 flex-wrap">{notables(rulesOf(r)).map((n) => <span key={n.label} className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${n.tone}`}>{n.label}</span>)}</span> },
        ],
      },
      {
        kind: 'rolebindings',
        label: 'Role bindings',
        namespaced: true,
        empty: 'No role bindings.',
        columns: [
          { label: 'Role', render: (b) => `${b.roleRef?.kind}/${b.roleRef?.name}` },
          { label: 'Subjects', render: (b) => <div className="max-w-md">{subjectsText(b.subjects).map((s) => <div key={s} className="truncate">{s}</div>)}</div> },
        ],
      },
      {
        kind: 'clusterroles',
        label: 'Cluster roles',
        namespaced: false,
        empty: 'No cluster roles.',
        columns: [
          { label: 'Rules', render: (r) => r.aggregationRule ? <span title="Aggregated from other roles">{(r.rules || []).length} (aggregated)</span> : `${(r.rules || []).length}` },
          { label: 'Notable', render: (r) => <span className="flex gap-1 flex-wrap">{notables(rulesOf(r)).map((n) => <span key={n.label} className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${n.tone}`}>{n.label}</span>)}</span> },
        ],
      },
      {
        kind: 'clusterrolebindings',
        label: 'Cluster role bindings',
        namespaced: false,
        empty: 'No cluster role bindings.',
        columns: [
          { label: 'Role', render: (b) => `${b.roleRef?.kind}/${b.roleRef?.name}` },
          { label: 'Subjects', render: (b) => <div className="max-w-md">{subjectsText(b.subjects).map((s) => <div key={s} className="truncate">{s}</div>)}</div> },
        ],
      },
    ],
  },
};

function rulesOf(role: any) {
  return (role.rules || []).map((r: any) => ({
    verbs: r.verbs || [],
    apiGroups: r.apiGroups || [],
    resources: r.resources || [],
    resourceNames: r.resourceNames || [],
    nonResourceUrls: r.nonResourceURLs || [],
  }));
}

interface PolicyViewProps {
  view: PolicyViewId;
  namespace: string;
  currentContext: string;
  searchQuery: string;
  refreshTick: number;
  onOpenManifest: (kind: string, name: string, namespace?: string) => void;
  onDelete: (kind: string, name: string, namespace?: string) => void;
}

export const PolicyView: React.FC<PolicyViewProps> = ({ view, namespace, currentContext, searchQuery, refreshTick, onOpenManifest, onDelete }) => {
  const config = CONFIGS[view];
  const [tabIndex, setTabIndex] = useState(0);
  const tab = config.tabs[Math.min(tabIndex, config.tabs.length - 1)];
  const [items, setItems] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setTabIndex(0), [view]);
  useEffect(() => {
    let alive = true;
    setItems(null);
    setError(null);
    const load = () => fetchK8sResource(tab.kind, tab.namespaced ? namespace : undefined, currentContext)
      .then((r) => alive && setItems(r.items || []))
      .catch((e) => alive && setError(e.message));
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 15000);
    return () => { alive = false; clearInterval(t); };
  }, [tab.kind, tab.namespaced, namespace, currentContext, refreshTick]);

  const q = searchQuery.toLowerCase();
  const shown = (items || []).filter((it) => !q || JSON.stringify([it.metadata?.name, it.metadata?.namespace, it.spec, it.roleRef, it.subjects]).toLowerCase().includes(q));
  const Icon = config.icon;
  const showNs = tab.namespaced && namespace === '_all';

  return (
    <div className="h-full flex flex-col overflow-hidden select-text">
      <div className="px-6 py-3 border-b border-slate-800 bg-slate-900/40 flex items-center justify-between gap-3 text-xs text-slate-400 select-none">
        <div className="flex items-center gap-2 font-medium min-w-0">
          <Icon className="w-4 h-4 text-cyan-400 shrink-0" />
          <span className="text-slate-200">{config.title}</span>
          <span className="bg-slate-800 text-slate-400 px-2 py-0.5 rounded font-mono text-[11px]">{items ? `${shown.length} of ${items.length}` : '…'}</span>
          {!items && !error && <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" />}
          {config.hint && <span className="text-[11px] text-slate-500 font-normal truncate hidden lg:inline">{config.hint}</span>}
        </div>
        {config.tabs.length > 1 && (
          <div className="flex items-center gap-1 bg-slate-950 border border-slate-800 rounded-lg p-0.5 shrink-0">
            {config.tabs.map((t, i) => (
              <button key={t.kind} onClick={() => setTabIndex(i)} className={`px-2.5 py-1 rounded-md text-[11px] font-semibold ${t === tab ? 'bg-slate-800 text-cyan-300' : 'text-slate-400 hover:text-slate-200'}`}>
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex-1 overflow-auto">
        {error ? (
          <div className="m-6 text-xs text-rose-300 bg-rose-950/50 border border-rose-900 rounded p-3 whitespace-pre-wrap">{error}</div>
        ) : (
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-slate-950/80 text-slate-400 sticky top-0 z-10 border-b border-slate-800 select-none backdrop-blur-sm">
              <tr>
                <th className="py-2.5 px-4 font-semibold">Name</th>
                {showNs && <th className="py-2.5 px-4 font-semibold">Namespace</th>}
                {tab.columns.map((c) => <th key={c.label} className="py-2.5 px-4 font-semibold" title={c.title}>{c.label}</th>)}
                <th className="py-2.5 px-4 font-semibold">Age</th>
                <th className="py-2.5 px-4 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50 font-mono text-slate-300">
              {items && shown.length === 0 ? (
                <tr><td colSpan={tab.columns.length + 4} className="py-12 text-center text-slate-500 italic font-sans">{items.length ? 'Nothing matches the search.' : tab.empty}</td></tr>
              ) : shown.map((it) => (
                <tr key={it.metadata?.uid || `${it.metadata?.namespace}/${it.metadata?.name}`} className="hover:bg-slate-800/40 transition-colors align-top">
                  <td className="py-2.5 px-4 font-semibold text-slate-100 max-w-xs truncate" title={it.metadata?.name}>{it.metadata?.name}</td>
                  {showNs && <td className="py-2.5 px-4"><span className="bg-slate-800/80 text-slate-300 px-2 py-0.5 rounded text-[11px]">{it.metadata?.namespace}</span></td>}
                  {tab.columns.map((c) => <td key={c.label} className="py-2.5 px-4 text-[11px]">{c.render(it)}</td>)}
                  <td className="py-2.5 px-4 text-slate-400">{age(it.metadata?.creationTimestamp)}</td>
                  <td className="py-2.5 px-4 text-right">
                    <div className="flex items-center justify-end gap-1 font-sans">
                      <button onClick={() => onOpenManifest(tab.kind, it.metadata.name, it.metadata.namespace)} title="View/Edit Manifest" className="p-1 text-slate-400 hover:text-amber-300 hover:bg-slate-800 rounded transition-colors">
                        <FileCode className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => onDelete(tab.kind, it.metadata.name, it.metadata.namespace)} title="Delete" className="p-1 text-slate-400 hover:text-rose-400 hover:bg-slate-800 rounded transition-colors">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};
