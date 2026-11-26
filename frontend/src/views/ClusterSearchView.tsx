import React, { useEffect, useRef, useState } from 'react';
import { Globe, Search, Loader2, AlertTriangle, ArrowRight } from 'lucide-react';
import { ClusterSearchResult, searchAllClusters } from '../api/v18';

interface ClusterSearchViewProps {
  currentContext: string;
  /** Jump to the object: switch cluster / namespace and open its view filtered by name */
  onOpen: (context: string, kind: string, namespace: string, name: string) => void;
}

const KIND_TONE: Record<string, string> = {
  Pod: 'text-cyan-300 border-cyan-800/70',
  Deployment: 'text-indigo-300 border-indigo-800/70',
  StatefulSet: 'text-violet-300 border-violet-800/70',
  DaemonSet: 'text-violet-300 border-violet-800/70',
  CronJob: 'text-sky-300 border-sky-800/70',
  Service: 'text-emerald-300 border-emerald-800/70',
  Ingress: 'text-emerald-300 border-emerald-800/70',
  ConfigMap: 'text-amber-300 border-amber-800/70',
  Secret: 'text-rose-300 border-rose-800/70',
};

/** Find pods, workloads, services, ingresses, ConfigMaps and Secrets by name or image in every cluster. */
export const ClusterSearchView: React.FC<ClusterSearchViewProps> = ({ currentContext, onOpen }) => {
  const [q, setQ] = useState(() => { try { return sessionStorage.getItem('kubellens_cluster_search') || ''; } catch { return ''; } });
  const [results, setResults] = useState<ClusterSearchResult[] | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const run = async () => {
    const term = q.trim();
    if (term.length < 2) { setError('Type at least 2 characters'); return; }
    try { sessionStorage.setItem('kubellens_cluster_search', term); } catch { /* ignore */ }
    setBusy(true);
    setError(null);
    try {
      const r = await searchAllClusters(term);
      setResults(r.clusters);
      setSkipped(r.skipped);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const total = (results || []).reduce((s, c) => s + c.total, 0);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-6 py-3 border-b border-slate-800 bg-slate-900/40 space-y-2.5 select-none">
        <div className="flex items-center gap-2 text-xs font-medium">
          <Globe className="w-4 h-4 text-cyan-400" />
          <span className="text-slate-200">Search All Clusters</span>
          <span className="text-[11px] text-slate-500 font-normal">Names of pods, workloads, services, ingresses, ConfigMaps and Secrets, and container images, in every kubeconfig context.</span>
        </div>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); run(); }}>
          <div className="flex items-center flex-1 max-w-2xl bg-slate-950 border border-slate-700 rounded-md focus-within:border-cyan-500">
            <Search className="w-3.5 h-3.5 text-slate-500 ml-2" />
            <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. payments, redis:7, api-gateway" spellCheck={false}
              className="flex-1 bg-transparent px-2 py-1.5 text-xs text-slate-100 placeholder-slate-600 focus:outline-none font-mono" />
          </div>
          <button type="submit" disabled={busy || q.trim().length < 2} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold disabled:opacity-40">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />} Search
          </button>
        </form>
        {error && <div className="text-[11px] text-rose-300">{error}</div>}
      </div>

      <div className="flex-1 overflow-auto p-6 space-y-4">
        {busy && !results && <div className="flex items-center gap-2 text-xs text-slate-500"><Loader2 className="w-4 h-4 animate-spin" /> Indexing every cluster (cached for a minute afterwards)…</div>}
        {!results && !busy && (
          <div className="h-full flex flex-col items-center justify-center text-center gap-2 text-slate-500 text-xs">
            <Globe className="w-8 h-8 text-slate-700" />
            <p>Where does this service run? Which clusters still use that image? Search them all at once.</p>
          </div>
        )}
        {results && (
          <div className="text-[11px] text-slate-500">
            {total} match{total === 1 ? '' : 'es'} in {results.filter((c) => c.total > 0).length} of {results.length} clusters
            {skipped > 0 && <span className="text-amber-300"> · {skipped} more contexts not searched</span>}
          </div>
        )}
        {(results || []).map((c) => (
          <div key={c.context} className="rounded-xl border border-slate-800 bg-slate-900/50">
            <div className="px-4 py-2 border-b border-slate-800 flex items-center gap-2 text-xs">
              <span className="font-mono text-slate-100">{c.context}</span>
              {c.context === currentContext && <span className="text-[10px] text-cyan-400 font-semibold uppercase">current</span>}
              <span className="ml-auto text-slate-500">{c.error ? '' : `${c.total} match${c.total === 1 ? '' : 'es'}`}</span>
            </div>
            {c.error ? (
              <div className="px-4 py-2 text-[11px] text-rose-300 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> {c.error}</div>
            ) : c.hits.length === 0 ? (
              <div className="px-4 py-2 text-[11px] text-slate-500">No matches.</div>
            ) : (
              <div className="divide-y divide-slate-800/60">
                {c.hits.map((h) => (
                  <button key={`${h.kind}/${h.namespace}/${h.name}`} onClick={() => onOpen(c.context, h.kind, h.namespace, h.name)}
                    className="w-full text-left px-4 py-1.5 flex items-center gap-2 text-xs hover:bg-slate-800/50 group">
                    <span className={`w-24 shrink-0 px-1.5 py-0.5 rounded border text-[10px] text-center font-semibold ${KIND_TONE[h.kind] || 'text-slate-300 border-slate-700'}`}>{h.kind}</span>
                    <span className="font-mono text-slate-500 w-40 truncate shrink-0">{h.namespace}</span>
                    <span className="font-mono text-slate-100 truncate">{h.name}</span>
                    {h.matched === 'image' && (
                      <span className="font-mono text-[10.5px] text-amber-300 truncate">{(h.images || []).find((i) => i.toLowerCase().includes(q.trim().toLowerCase()))}</span>
                    )}
                    <ArrowRight className="w-3.5 h-3.5 ml-auto text-slate-600 group-hover:text-cyan-300 shrink-0" />
                  </button>
                ))}
                {c.total > c.hits.length && <div className="px-4 py-1.5 text-[10.5px] text-slate-500">+{c.total - c.hits.length} more; narrow the search</div>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
