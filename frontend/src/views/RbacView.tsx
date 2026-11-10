import React, { useEffect, useMemo, useState } from 'react';
import { KeyRound, Search, User, Users, Bot, Loader2, ChevronRight, ChevronDown, Info } from 'lucide-react';
import { RbacIndex, RbacSubject, fetchRbac } from '../api/insights';
import { ViewLoader } from '../components/ViewLoader';
import { CLUSTER_SCOPED, RESOURCE_GROUPS, VERBS, notables, roleName, subjectKey, whoCan } from '../utils/rbac';

interface RbacViewProps {
  currentContext: string;
  namespace: string;
  namespaces: string[];
  refreshTick: number;
}

const KIND_ICON = { User, Group: Users, ServiceAccount: Bot } as const;
const PRESETS: Array<{ label: string; verb: string; resource: string }> = [
  { label: 'Read Secrets', verb: 'get', resource: 'secrets' },
  { label: 'Exec into pods', verb: 'create', resource: 'pods/exec' },
  { label: 'Delete pods', verb: 'delete', resource: 'pods' },
  { label: 'Change deployments', verb: 'patch', resource: 'deployments' },
  { label: 'Edit ConfigMaps', verb: 'update', resource: 'configmaps' },
  { label: 'Grant roles', verb: 'bind', resource: 'clusterroles' },
];

const scopeLabel = (scope: string) => (scope === '*' ? 'all namespaces' : scope);

const KindBadge: React.FC<{ s: RbacSubject }> = ({ s }) => {
  const Icon = KIND_ICON[s.kind] || User;
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      <Icon className={`w-3.5 h-3.5 shrink-0 ${s.kind === 'ServiceAccount' ? 'text-violet-300' : s.kind === 'Group' ? 'text-sky-300' : 'text-emerald-300'}`} />
      <span className="truncate font-mono" title={`${s.kind} ${s.namespace ? `${s.namespace}/` : ''}${s.name}`}>
        {s.namespace && <span className="text-slate-500">{s.namespace}/</span>}{s.name}
      </span>
    </span>
  );
};

/** "Who can do what": what a user / group / service account may do, and who may do a given action. */
export const RbacView: React.FC<RbacViewProps> = ({ currentContext, namespace, namespaces, refreshTick }) => {
  const [index, setIndex] = useState<RbacIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'who' | 'subject'>('who');

  // "Who can…"
  const [verb, setVerb] = useState('get');
  const [resource, setResource] = useState('secrets');
  const [ns, setNs] = useState(namespace === '_all' ? '_any' : namespace);
  const [hideSystem, setHideSystem] = useState(true);

  // "What can … do"
  const [subjectFilter, setSubjectFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<number>>(() => new Set());

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchRbac(currentContext)
      .then((r) => { if (alive) { setIndex(r); setError(null); } })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [currentContext, refreshTick]);

  const isSystem = (s: RbacSubject) => s.name.startsWith('system:') || (s.namespace || '').startsWith('kube-');

  const hits = useMemo(() => {
    if (!index || !resource.trim()) return [];
    const all = whoCan(index, verb, resource.trim().toLowerCase(), ns);
    return hideSystem ? all.filter((h) => !isSystem(h.subject)) : all;
  }, [index, verb, resource, ns, hideSystem]);
  const bySubject = useMemo(() => {
    const m = new Map<string, typeof hits>();
    hits.forEach((h) => {
      const k = subjectKey(h.subject);
      m.set(k, [...(m.get(k) || []), h]);
    });
    return [...m.values()].sort((a, b) => a[0].subject.kind.localeCompare(b[0].subject.kind) || a[0].subject.name.localeCompare(b[0].subject.name));
  }, [hits]);

  const subjects = useMemo(() => {
    const q = subjectFilter.toLowerCase();
    return (index?.subjects || []).filter((s) => (!hideSystem || !isSystem(s)) && (!q || `${s.kind} ${s.namespace || ''}/${s.name}`.toLowerCase().includes(q)));
  }, [index, subjectFilter, hideSystem]);
  const current = index?.subjects.find((s) => subjectKey(s) === selected) || null;

  if (!index && !error) return <ViewLoader label={`Reading roles and bindings from ${currentContext || 'cluster'}…`} />;

  const field = 'bg-slate-950 border border-slate-700 rounded-md px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500';
  const tab = (id: typeof mode, label: string) => (
    <button onClick={() => setMode(id)} className={`px-3 py-1 rounded-md text-xs font-semibold ${mode === id ? 'bg-slate-800 text-cyan-300' : 'text-slate-400 hover:text-slate-200'}`}>{label}</button>
  );

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-6 py-3 border-b border-slate-800 bg-slate-900/40 flex items-center justify-between gap-3 text-xs text-slate-400 select-none">
        <div className="flex items-center gap-2 font-medium">
          <KeyRound className="w-4 h-4 text-cyan-400" />
          <span className="text-slate-200">Who Can Do What</span>
          {index && <span className="bg-slate-800 text-slate-400 px-2 py-0.5 rounded font-mono text-[11px]">{index.subjects.length} subjects · {Object.keys(index.roles).length} roles</span>}
          {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" />}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[11px] cursor-pointer">
            <input type="checkbox" checked={hideSystem} onChange={(e) => setHideSystem(e.target.checked)} className="accent-cyan-500" />
            Hide system accounts
          </label>
          <div className="flex items-center gap-1 bg-slate-950 border border-slate-800 rounded-lg p-0.5">
            {tab('who', 'Who can…')}
            {tab('subject', 'What can … do')}
          </div>
        </div>
      </div>
      {error && <div className="m-4 text-xs text-rose-300 bg-rose-950/50 border border-rose-900 rounded p-3 whitespace-pre-wrap">{error}</div>}

      {mode === 'who' ? (
        <>
          <div className="px-6 py-3 border-b border-slate-800 space-y-2 select-none">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <span>Who can</span>
              <select value={verb} onChange={(e) => setVerb(e.target.value)} className={field}>
                {VERBS.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
              <input
                list="rbac-resources"
                value={resource}
                onChange={(e) => setResource(e.target.value)}
                placeholder="resource, e.g. secrets"
                spellCheck={false}
                className={`${field} w-48 font-mono`}
              />
              <datalist id="rbac-resources">{Object.keys(RESOURCE_GROUPS).map((r) => <option key={r} value={r} />)}</datalist>
              <span>in</span>
              <select value={ns} onChange={(e) => setNs(e.target.value)} className={`${field} max-w-[200px]`} disabled={CLUSTER_SCOPED.has(resource)}>
                <option value="_any">any namespace</option>
                {namespaces.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <span className="text-slate-500">?</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => { setVerb(p.verb); setResource(p.resource); }}
                  className={`px-2 py-0.5 rounded border text-[11px] ${verb === p.verb && resource === p.resource ? 'border-cyan-500/60 text-cyan-200 bg-cyan-500/10' : 'border-slate-700 text-slate-400 hover:bg-slate-800'}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 overflow-auto">
            <div className="px-6 py-2 text-[11px] text-slate-500 flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5" />
              {bySubject.length} subject{bySubject.length === 1 ? '' : 's'} can {verb} {resource || '…'}{CLUSTER_SCOPED.has(resource) ? ' (cluster-scoped: only cluster-wide bindings count)' : ns === '_any' ? ' somewhere' : ` in ${ns}`}.
              Computed from Roles and bindings; group membership beyond the built-in groups isn't known.
            </div>
            <table className="w-full text-left text-xs border-collapse">
              <thead className="bg-slate-950/80 text-slate-400 sticky top-0 z-10 border-b border-slate-800 select-none">
                <tr>
                  <th className="py-2 px-6 font-semibold">Subject</th>
                  <th className="py-2 px-4 font-semibold">Where</th>
                  <th className="py-2 px-4 font-semibold">Through</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50 text-slate-300">
                {bySubject.map((group) => (
                  <tr key={subjectKey(group[0].subject)} className="align-top hover:bg-slate-800/40">
                    <td className="py-2 px-6 max-w-sm">
                      <button onClick={() => { setSelected(subjectKey(group[0].subject)); setMode('subject'); }} className="hover:underline text-left max-w-full">
                        <KindBadge s={group[0].subject} />
                      </button>
                    </td>
                    <td className="py-2 px-4 text-slate-400 font-mono">
                      {[...new Set(group.map((h) => scopeLabel(h.grant.scope)))].join(', ')}
                    </td>
                    <td className="py-2 px-4">
                      {group.map((h, i) => (
                        <div key={i} className="text-[11px] font-mono">
                          <span className="text-slate-500">{h.grant.bindingKind}</span> {h.grant.bindingName} → <span className="text-slate-200">{roleName(h.grant.role)}</span>
                          {h.grant.viaGroup && <span className="text-sky-300 font-sans"> · via group {h.grant.viaGroup}</span>}
                          {h.limited && <span className="text-amber-300 font-sans"> · only: {h.rule.resourceNames.join(', ')}</span>}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
                {bySubject.length === 0 && (
                  <tr><td colSpan={3} className="py-10 text-center text-slate-500 italic">Nobody{hideSystem ? ' (outside system accounts)' : ''} has this permission.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="flex-1 flex overflow-hidden">
          <aside className="w-80 shrink-0 border-r border-slate-800 flex flex-col">
            <div className="p-3 border-b border-slate-800">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2 top-1/2 -translate-y-1/2" />
                <input value={subjectFilter} onChange={(e) => setSubjectFilter(e.target.value)} placeholder="Find a user, group or service account…" className={`${field} w-full pl-7`} />
              </div>
              <div className="mt-1 text-[10px] text-slate-500">{subjects.length} shown</div>
            </div>
            <div className="flex-1 overflow-auto py-1">
              {subjects.slice(0, 500).map((s) => {
                const k = subjectKey(s);
                return (
                  <button
                    key={k}
                    onClick={() => { setSelected(k); setOpen(new Set()); }}
                    className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 ${selected === k ? 'bg-cyan-500/15 text-cyan-200' : 'text-slate-300 hover:bg-slate-800/60'}`}
                  >
                    <span className="flex-1 min-w-0"><KindBadge s={s} /></span>
                    <span className="text-[10px] text-slate-500 shrink-0">{s.grants.length}</span>
                  </button>
                );
              })}
            </div>
          </aside>
          <section className="flex-1 overflow-auto p-5">
            {!current ? (
              <div className="h-full flex flex-col items-center justify-center text-xs text-slate-500 gap-2">
                <KeyRound className="w-8 h-8 text-slate-700" />
                Pick a subject to see everything it is allowed to do.
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-slate-100">
                  <KindBadge s={current} />
                  <span className="text-[11px] text-slate-500">{current.kind}</span>
                </div>
                {current.grants.length === 0 && <div className="text-xs text-slate-500">No roles are bound to it: it can only do what every authenticated user can.</div>}
                {current.grants.map((g, i) => {
                  const rules = index?.roles[g.role] || [];
                  const isOpen = open.has(i);
                  return (
                    <div key={i} className="rounded-lg border border-slate-800 bg-slate-900/50">
                      <button
                        onClick={() => setOpen((o) => { const n = new Set(o); if (n.has(i)) n.delete(i); else n.add(i); return n; })}
                        className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs"
                      >
                        {isOpen ? <ChevronDown className="w-3.5 h-3.5 text-slate-500" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-500" />}
                        <span className="font-mono text-slate-100">{roleName(g.role)}</span>
                        <span className="text-slate-500">{g.role.startsWith('ClusterRole/') ? 'ClusterRole' : 'Role'}</span>
                        <span className="text-slate-400">in {scopeLabel(g.scope)}</span>
                        {g.viaGroup && <span className="text-sky-300">via {g.viaGroup}</span>}
                        {g.roleMissing && <span className="text-rose-300">role doesn't exist</span>}
                        <span className="ml-auto flex gap-1">
                          {notables(rules).map((n) => <span key={n.label} className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${n.tone}`}>{n.label}</span>)}
                        </span>
                      </button>
                      {isOpen && (
                        <div className="border-t border-slate-800 px-3 py-2">
                          <div className="text-[10px] text-slate-500 mb-1 font-mono">{g.bindingKind} {g.bindingNamespace ? `${g.bindingNamespace}/` : ''}{g.bindingName}</div>
                          <table className="w-full text-[11px] font-mono">
                            <thead className="text-slate-500"><tr><th className="text-left font-normal py-0.5">Verbs</th><th className="text-left font-normal">Resources</th><th className="text-left font-normal">API groups</th><th className="text-left font-normal">Only names</th></tr></thead>
                            <tbody className="text-slate-300">
                              {rules.map((r, j) => (
                                <tr key={j} className="border-t border-slate-800/60 align-top">
                                  <td className="py-1 pr-3">{r.verbs.join(', ')}</td>
                                  <td className="py-1 pr-3">{r.resources.length ? r.resources.join(', ') : r.nonResourceUrls.join(', ')}</td>
                                  <td className="py-1 pr-3 text-slate-500">{r.apiGroups.map((x) => x || 'core').join(', ')}</td>
                                  <td className="py-1 text-amber-300">{r.resourceNames.join(', ')}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
};
