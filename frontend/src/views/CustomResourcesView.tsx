import React, { useEffect, useMemo, useState } from 'react';
import { Puzzle, Search, Loader2, FileCode, Trash2, ChevronRight } from 'lucide-react';
import { fetchK8sResource } from '../api/client';
import { CustomResourceDefinitionItem } from '../types/k8s';
import { ViewLoader } from '../components/ViewLoader';

interface CustomResourcesViewProps {
  namespace: string;
  currentContext: string;
  searchQuery: string;
  refreshTick: number;
  onOpenManifest: (kind: string, name: string, namespace?: string) => void;
  onDelete: (kind: string, name: string, namespace?: string) => void;
}

/**
 * Minimal evaluator for the JSONPath subset used in CRD printer columns:
 * `.a.b`, `.a[0]`, and `.a[?(@.type=="Ready")].status`.
 */
function evalJsonPath(obj: any, path: string): any {
  const tokens = path.match(/\.[^.[\]]+|\[\?\(@\.[^=]+==["'][^"']*["']\)\]|\[\d+\]/g) || [];
  let cur = obj;
  for (const t of tokens) {
    if (cur == null) return undefined;
    if (t.startsWith('[?')) {
      const m = /\[\?\(@\.([^=]+)==["']([^"']*)["']\)\]/.exec(t);
      cur = Array.isArray(cur) && m ? cur.find((x) => String(x?.[m[1]]) === m[2]) : undefined;
    } else if (t.startsWith('[')) {
      cur = Array.isArray(cur) ? cur[Number(t.slice(1, -1))] : undefined;
    } else {
      cur = cur[t.slice(1)];
    }
  }
  return cur;
}

function age(ts?: string) {
  if (!ts) return '—';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function formatCell(value: any, type: string) {
  if (value == null || value === '') return '—';
  if (type === 'date') return age(String(value));
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Browse any installed CustomResourceDefinition and its instances. */
export const CustomResourcesView: React.FC<CustomResourcesViewProps> = ({
  namespace,
  currentContext,
  searchQuery,
  refreshTick,
  onOpenManifest,
  onDelete,
}) => {
  const [crds, setCrds] = useState<CustomResourceDefinitionItem[] | null>(null);
  const [crdError, setCrdError] = useState<string | null>(null);
  const [crdFilter, setCrdFilter] = useState('');
  const [active, setActive] = useState<CustomResourceDefinitionItem | null>(null);
  const [items, setItems] = useState<any[] | null>(null);
  const [itemsError, setItemsError] = useState<string | null>(null);

  useEffect(() => {
    fetchK8sResource<CustomResourceDefinitionItem>('customresourcedefinitions', undefined, currentContext)
      .then((res) => {
        const list = (res.items || []).sort((a, b) => a.spec.names.kind.localeCompare(b.spec.names.kind));
        setCrds(list);
        setCrdError(null);
      })
      .catch((e) => setCrdError(e.message));
  }, [currentContext, refreshTick]);

  const kindRef = active ? `${active.spec.names.plural}.${active.spec.group}` : '';
  const namespaced = active?.spec.scope === 'Namespaced';

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setItems(null);
    setItemsError(null);
    fetchK8sResource(kindRef, namespaced ? namespace : undefined, currentContext)
      .then((res) => !cancelled && setItems(res.items || []))
      .catch((e) => !cancelled && setItemsError(e.message));
    return () => { cancelled = true; };
  }, [active, kindRef, namespaced, namespace, currentContext, refreshTick]);

  // Group CRDs by API group for the side list
  const groups = useMemo(() => {
    const q = crdFilter.toLowerCase();
    const map = new Map<string, CustomResourceDefinitionItem[]>();
    (crds || [])
      .filter((c) => !q || c.spec.names.kind.toLowerCase().includes(q) || c.spec.group.toLowerCase().includes(q))
      .forEach((c) => {
        const list = map.get(c.spec.group) || [];
        list.push(c);
        map.set(c.spec.group, list);
      });
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [crds, crdFilter]);

  if (!crds && !crdError) return <ViewLoader label="Loading custom resource definitions…" />;

  const version = active?.spec.versions.find((v) => v.storage) || active?.spec.versions.find((v) => v.served);
  const printerColumns = (version?.additionalPrinterColumns || []).filter((c) => !c.priority && c.name.toLowerCase() !== 'age');
  const q = searchQuery.toLowerCase();
  const visibleItems = (items || []).filter((it) =>
    !q || it.metadata?.name?.toLowerCase().includes(q) || (it.metadata?.namespace || '').toLowerCase().includes(q)
  );

  return (
    <div className="h-full flex overflow-hidden">
      {/* CRD list */}
      <aside className="w-72 shrink-0 border-r border-slate-800 bg-slate-900/40 flex flex-col">
        <div className="p-3 border-b border-slate-800">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-200 mb-2">
            <Puzzle className="w-4 h-4 text-cyan-400" /> Custom Resources
            <span className="bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded font-mono text-[10px]">{crds?.length ?? 0}</span>
          </div>
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2 top-1/2 -translate-y-1/2" />
            <input
              value={crdFilter}
              onChange={(e) => setCrdFilter(e.target.value)}
              placeholder="Filter kinds or groups…"
              className="w-full bg-slate-950 border border-slate-800 rounded-md pl-7 pr-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {crdError && <div className="mx-3 text-[11px] text-rose-300">{crdError}</div>}
          {crds?.length === 0 && <div className="mx-3 text-[11px] text-slate-500 italic">No CRDs installed in this cluster.</div>}
          {groups.map(([group, list]) => (
            <div key={group} className="mb-2">
              <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-slate-500 font-semibold truncate" title={group}>{group}</div>
              {list.map((c) => {
                const isActive = active?.metadata.name === c.metadata.name;
                return (
                  <button
                    key={c.metadata.name}
                    onClick={() => setActive(c)}
                    className={`w-full text-left px-3 py-1.5 text-xs flex items-center justify-between gap-2 transition-colors ${
                      isActive ? 'bg-cyan-500/15 text-cyan-300 font-semibold' : 'text-slate-300 hover:bg-slate-800/60'
                    }`}
                  >
                    <span className="truncate">{c.spec.names.kind}</span>
                    <ChevronRight className={`w-3 h-3 shrink-0 ${isActive ? 'text-cyan-400' : 'text-slate-600'}`} />
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </aside>

      {/* Instances */}
      <section className="flex-1 flex flex-col overflow-hidden select-text">
        {!active ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center text-slate-500 text-xs gap-2 p-8">
            <Puzzle className="w-8 h-8 text-slate-700" />
            <p>Pick a resource type on the left to list its objects.</p>
            <p className="text-slate-600">Works with any operator: cert-manager, Istio, ArgoCD, Prometheus, and more.</p>
          </div>
        ) : (
          <>
            <div className="px-6 py-3 border-b border-slate-800 bg-slate-900/40 flex items-center justify-between text-xs text-slate-400 select-none">
              <div className="flex items-center gap-2 font-medium min-w-0">
                <span className="text-slate-200">{active.spec.names.kind}</span>
                <span className="font-mono text-[11px] text-slate-500 truncate">{kindRef}</span>
                <span className="bg-slate-800 text-slate-400 px-2 py-0.5 rounded font-mono text-[11px]">{items ? visibleItems.length : '…'}</span>
                {!items && !itemsError && <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" />}
              </div>
              <span className="text-[11px]">{namespaced ? 'Namespaced' : 'Cluster-scoped'}</span>
            </div>
            <div className="flex-1 overflow-auto">
              {itemsError ? (
                <div className="m-6 text-xs text-rose-300 bg-rose-950/50 border border-rose-900 rounded p-3 whitespace-pre-wrap">{itemsError}</div>
              ) : (
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-slate-950/80 text-slate-400 sticky top-0 z-10 border-b border-slate-800 select-none backdrop-blur-sm">
                    <tr>
                      <th className="py-2.5 px-4 font-semibold">Name</th>
                      {namespaced && <th className="py-2.5 px-4 font-semibold">Namespace</th>}
                      {printerColumns.map((c) => <th key={c.name} className="py-2.5 px-4 font-semibold">{c.name}</th>)}
                      <th className="py-2.5 px-4 font-semibold">Age</th>
                      <th className="py-2.5 px-4 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50 font-mono text-slate-300">
                    {items && visibleItems.length === 0 ? (
                      <tr><td colSpan={printerColumns.length + 4} className="py-12 text-center text-slate-500 italic font-sans">No {active.spec.names.plural} found.</td></tr>
                    ) : visibleItems.map((it) => (
                      <tr key={it.metadata.uid || `${it.metadata.namespace}/${it.metadata.name}`} className="hover:bg-slate-800/50 transition-colors">
                        <td className="py-2.5 px-4 font-semibold text-slate-100">{it.metadata.name}</td>
                        {namespaced && (
                          <td className="py-2.5 px-4"><span className="bg-slate-800/80 text-slate-300 px-2 py-0.5 rounded text-[11px]">{it.metadata.namespace}</span></td>
                        )}
                        {printerColumns.map((c) => (
                          <td key={c.name} className="py-2.5 px-4 text-slate-300 max-w-xs truncate">{formatCell(evalJsonPath(it, c.jsonPath), c.type)}</td>
                        ))}
                        <td className="py-2.5 px-4 text-slate-400">{age(it.metadata.creationTimestamp)}</td>
                        <td className="py-2.5 px-4 text-right">
                          <div className="flex items-center justify-end gap-1 font-sans">
                            <button
                              onClick={() => onOpenManifest(kindRef, it.metadata.name, it.metadata.namespace)}
                              title="View/Edit Manifest"
                              className="p-1 text-slate-400 hover:text-amber-300 hover:bg-slate-800 rounded transition-colors"
                            >
                              <FileCode className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => onDelete(kindRef, it.metadata.name, it.metadata.namespace)}
                              title="Delete"
                              className="p-1 text-slate-400 hover:text-rose-400 hover:bg-slate-800 rounded transition-colors"
                            >
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
          </>
        )}
      </section>
    </div>
  );
};
