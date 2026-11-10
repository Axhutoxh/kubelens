import React, { useCallback, useEffect, useState } from 'react';
import { LayoutGrid, RefreshCw, Server, Box, AlertTriangle, CheckCircle2, XCircle, ArrowRight, Loader2, Radio } from 'lucide-react';
import { ClusterHealth, fetchClustersHealth } from '../api/insights';

interface ClustersViewProps {
  currentContext: string;
  refreshTick: number;
  onOpenCluster: (context: string) => void;
  onOpenPod?: (context: string, namespace: string, pod: string) => void;
}

// Checking every cluster costs a few kubectl calls each; once a minute is enough while open
const AUTO_REFRESH_MS = 60_000;

function verdict(c: ClusterHealth): { label: string; tone: string; Icon: typeof CheckCircle2 } {
  if (!c.reachable) return { label: 'Unreachable', tone: 'text-rose-300 border-rose-800/80 bg-rose-950/50', Icon: XCircle };
  if (c.pods.failing > 0 || (c.nodesTotal > 0 && c.nodesReady < c.nodesTotal)) return { label: 'Needs attention', tone: 'text-amber-300 border-amber-800/80 bg-amber-950/50', Icon: AlertTriangle };
  return { label: 'Healthy', tone: 'text-emerald-300 border-emerald-800/80 bg-emerald-950/50', Icon: CheckCircle2 };
}

/** Every kubeconfig context on one page: nodes, failing pods and recent warnings. */
export const ClustersView: React.FC<ClustersViewProps> = ({ currentContext, refreshTick, onOpenCluster, onOpenPod }) => {
  const [clusters, setClusters] = useState<ClusterHealth[] | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetchClustersHealth();
      setClusters(r.clusters);
      setSkipped(r.skipped);
      setError(null);
      setCheckedAt(new Date());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, AUTO_REFRESH_MS);
    return () => clearInterval(t);
  }, [load, refreshTick]);

  const stat = (Icon: typeof Server, label: string, value: React.ReactNode, tone = 'text-slate-200', title?: string) => (
    <div className="flex items-center gap-2 min-w-0" title={title}>
      <Icon className="w-3.5 h-3.5 text-slate-500 shrink-0" />
      <span className="text-[11px] text-slate-500">{label}</span>
      <span className={`ml-auto font-mono text-xs font-semibold ${tone}`}>{value}</span>
    </div>
  );

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-6 py-3 border-b border-slate-800 bg-slate-900/40 flex items-center justify-between text-xs text-slate-400 select-none">
        <div className="flex items-center gap-2 font-medium">
          <LayoutGrid className="w-4 h-4 text-cyan-400" />
          <span className="text-slate-200">All Clusters</span>
          <span className="bg-slate-800 text-slate-400 px-2 py-0.5 rounded font-mono text-[11px]">{clusters?.length ?? '…'}</span>
          {skipped > 0 && <span className="text-[11px] text-amber-300">{skipped} more contexts not checked</span>}
        </div>
        <div className="flex items-center gap-3">
          {checkedAt && <span className="text-[11px] text-slate-500">checked {checkedAt.toLocaleTimeString([], { hour12: false })} · refreshes every minute</span>}
          <button onClick={load} disabled={loading} title="Check all clusters now" className="p-1 rounded text-slate-400 hover:text-cyan-300 hover:bg-slate-800 disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {error && <div className="mb-4 text-xs text-rose-300 bg-rose-950/50 border border-rose-900 rounded p-3">{error}</div>}
        {!clusters ? (
          <div className="flex items-center justify-center gap-2 text-xs text-slate-500 py-16"><Loader2 className="w-4 h-4 animate-spin" /> Checking every cluster in your kubeconfig…</div>
        ) : clusters.length === 0 ? (
          <div className="text-xs text-slate-500 py-16 text-center">No contexts found in your kubeconfig.</div>
        ) : (
          <div className="grid gap-4 grid-cols-1 md:grid-cols-2 2xl:grid-cols-3">
            {clusters.map((c) => {
              const v = verdict(c);
              const isCurrent = c.context === currentContext;
              return (
                <div key={c.context} className={`rounded-xl border bg-slate-900/60 p-4 flex flex-col gap-3 ${isCurrent ? 'border-cyan-700/70' : 'border-slate-800'}`}>
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-sm text-slate-100 truncate" title={c.context}>{c.context}</div>
                      {isCurrent && <div className="text-[10px] text-cyan-400 font-semibold uppercase tracking-wide">current</div>}
                    </div>
                    <span className={`flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-semibold whitespace-nowrap ${v.tone}`}>
                      <v.Icon className="w-3 h-3" /> {v.label}
                    </span>
                  </div>

                  {c.error && <div className="text-[11px] text-rose-300 break-words" title={c.error}>{c.error}</div>}
                  {c.reachable && (
                    <div className="space-y-1.5">
                      {stat(Server, 'Nodes ready', c.nodesError ? 'no access' : `${c.nodesReady} / ${c.nodesTotal}`,
                        c.nodesError ? 'text-slate-500' : c.nodesReady < c.nodesTotal ? 'text-amber-300' : 'text-emerald-300', c.nodesError)}
                      {stat(Box, 'Pods running', `${c.pods.running} / ${c.pods.total}`)}
                      {stat(AlertTriangle, 'Failing pods', c.pods.failing, c.pods.failing ? 'text-rose-300' : 'text-emerald-300')}
                      {stat(Box, 'Pending pods', c.pods.pending, c.pods.pending ? 'text-amber-300' : 'text-slate-400')}
                      {stat(Radio, 'Warnings (last hour)', c.warningsLastHour ?? '—', c.warningsLastHour ? 'text-amber-300' : 'text-slate-400')}
                    </div>
                  )}

                  {c.problems.length > 0 && (
                    <div className="border-t border-slate-800 pt-2 space-y-0.5">
                      {c.problems.slice(0, 5).map((p) => (
                        <button
                          key={`${p.namespace}/${p.pod}`}
                          onClick={() => onOpenPod?.(c.context, p.namespace, p.pod)}
                          disabled={!onOpenPod}
                          className="w-full flex items-center gap-2 text-[11px] text-left hover:bg-slate-800/60 rounded px-1 py-0.5"
                          title={`${p.namespace}/${p.pod}`}
                        >
                          <span className="text-rose-300 shrink-0">{p.reason}</span>
                          <span className="font-mono text-slate-400 truncate">{p.namespace}/{p.pod}</span>
                        </button>
                      ))}
                      {c.pods.failing > 5 && <div className="text-[10px] text-slate-500 px-1">+{c.pods.failing - 5} more</div>}
                    </div>
                  )}

                  <div className="mt-auto flex items-center justify-between pt-1">
                    <span className="text-[10px] text-slate-600">{(c.tookMs / 1000).toFixed(1)} s</span>
                    {!isCurrent && (
                      <button onClick={() => onOpenCluster(c.context)} className="flex items-center gap-1 text-[11px] font-semibold text-cyan-300 hover:text-cyan-200">
                        Open <ArrowRight className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
