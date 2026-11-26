import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { BarChart3, X, Loader2, Lightbulb } from 'lucide-react';
import { fetchK8sResource } from '../api/client';
import { UsagePoint, fetchUsageHistory } from '../api/v18';
import { formatCpu, formatMem, percentile, podTotal } from '../utils/quantity';

export interface UsageTarget {
  title: string;
  namespace: string;
  context?: string;
  /** Pods to chart: by label selector (workloads) or by name (one pod) */
  matchLabels?: Record<string, string>;
  podNames?: string[];
  /** Container specs of one pod (template), for requests / limits */
  containers?: any[];
}

interface UsageModalProps {
  target: UsageTarget;
  onClose: () => void;
}

const COLORS = ['#22d3ee', '#a78bfa', '#f59e0b', '#34d399', '#f472b6', '#60a5fa', '#a3e635', '#fb923c'];
const REFRESH_MS = 30_000;
/** Samples needed before advice (about 5 minutes) */
const MIN_SAMPLES = 10;

interface ChartProps {
  series: Array<{ name: string; points: Array<[number, number]> }>;
  request: number;
  limit: number;
  format: (v: number) => string;
}

/** Small SVG line chart: one line per pod, dashed request (amber) and limit (rose) lines. */
const Chart: React.FC<ChartProps> = ({ series, request, limit, format }) => {
  const W = 640, H = 150, PAD = 4;
  const all = series.flatMap((s) => s.points);
  if (all.length < 2) return <div className="h-[150px] flex items-center justify-center text-[11px] text-slate-500">Collecting samples…</div>;
  const t0 = Math.min(...all.map((p) => p[0])), t1 = Math.max(...all.map((p) => p[0]));
  const vmax = Math.max(...all.map((p) => p[1]), isFinite(request) ? request : 0, isFinite(limit) ? limit : 0) * 1.1 || 1;
  const x = (t: number) => PAD + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - (v / vmax) * (H - 2 * PAD);
  const hline = (v: number, color: string, label: string) =>
    isFinite(v) && v > 0 ? (
      <g key={label}>
        <line x1={0} x2={W} y1={y(v)} y2={y(v)} stroke={color} strokeDasharray="5 4" strokeWidth={1} />
        <text x={W - 4} y={y(v) - 3} textAnchor="end" fontSize={10} fill={color}>{label} {format(v)}</text>
      </g>
    ) : null;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[150px]" preserveAspectRatio="none">
      {hline(request, '#f59e0b', 'request')}
      {hline(limit, '#f43f5e', 'limit')}
      {series.map((s, i) => (
        <polyline
          key={s.name}
          fill="none"
          stroke={COLORS[i % COLORS.length]}
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
          points={s.points.map(([t, v]) => `${x(t)},${y(v)}`).join(' ')}
        >
          <title>{s.name}</title>
        </polyline>
      ))}
    </svg>
  );
};

/** Advice from the p95 / peak of per-pod usage against the per-pod request and limit. */
function advice(kind: 'cpu' | 'memory', values: number[], request: number, limit: number): string[] {
  if (values.length < MIN_SAMPLES) return [];
  const p95 = percentile(values, 95);
  const peak = Math.max(...values);
  const fmt = kind === 'cpu' ? formatCpu : formatMem;
  const out: string[] = [];
  if (kind === 'cpu') {
    const suggested = Math.max(10, Math.ceil((p95 * 1.2) / 10) * 10);
    if (!isFinite(request)) out.push(`No CPU request: set about ${fmt(suggested)} (p95 ${fmt(p95)} + 20%) so the scheduler reserves it.`);
    else if (request > suggested * 2) out.push(`CPU request ${fmt(request)} is over 2× what pods use (p95 ${fmt(p95)}); about ${fmt(suggested)} would free capacity.`);
    else if (p95 > request) out.push(`Pods use more CPU than requested (p95 ${fmt(p95)} > ${fmt(request)}); raise the request to about ${fmt(suggested)}.`);
    if (isFinite(limit) && peak > limit * 0.9) out.push(`CPU peaks at ${fmt(peak)}, close to the ${fmt(limit)} limit: expect throttling.`);
  } else {
    const suggested = Math.ceil((peak * 1.25) / 16) * 16;
    if (!isFinite(request)) out.push(`No memory request: set about ${fmt(suggested)} (peak ${fmt(peak)} + 25%).`);
    else if (request > suggested * 2) out.push(`Memory request ${fmt(request)} is over 2× the peak (${fmt(peak)}); about ${fmt(suggested)} is enough.`);
    else if (peak > request) out.push(`Memory peaks above the request (${fmt(peak)} > ${fmt(request)}); raise it to about ${fmt(suggested)}.`);
    if (!isFinite(limit)) out.push('No memory limit: one leaking pod can exhaust its node.');
    else if (peak > limit * 0.85) out.push(`Memory peaks at ${fmt(peak)}, ${Math.round((peak / limit) * 100)}% of the ${fmt(limit)} limit: OOM-kill risk.`);
  }
  return out;
}

/** CPU / memory over time for a workload's pods, with right-sizing advice. */
export const UsageModal: React.FC<UsageModalProps> = ({ target, onClose }) => {
  const [pods, setPods] = useState<string[] | null>(target.podNames || null);
  const [data, setData] = useState<Record<string, UsagePoint[]> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Pods of a workload: match its selector labels
  useEffect(() => {
    if (target.podNames || !target.matchLabels) return;
    fetchK8sResource<any>('pods', target.namespace, target.context)
      .then((r) => {
        const sel = Object.entries(target.matchLabels || {});
        setPods((r.items || []).filter((p) => sel.every(([k, v]) => p.metadata?.labels?.[k] === v)).map((p) => p.metadata.name).slice(0, 50));
      })
      .catch((e) => setError(e.message));
  }, [target]);

  useEffect(() => {
    if (!pods) return;
    if (pods.length === 0) { setData({}); return; }
    let alive = true;
    const load = () => fetchUsageHistory(target.namespace, pods, target.context)
      .then((r) => alive && setData(r.pods))
      .catch((e) => alive && setError(e.message));
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => { alive = false; clearInterval(t); };
  }, [pods, target.namespace, target.context]);

  const req = { cpu: podTotal(target.containers, 'requests', 'cpu'), mem: podTotal(target.containers, 'requests', 'memory') };
  const lim = { cpu: podTotal(target.containers, 'limits', 'cpu'), mem: podTotal(target.containers, 'limits', 'memory') };

  const series = useMemo(() => Object.entries(data || {}).filter(([, pts]) => pts.length > 0), [data]);
  const cpuValues = series.flatMap(([, pts]) => pts.map((p) => p[1]));
  const memValues = series.flatMap(([, pts]) => pts.map((p) => p[2]));
  const samples = Math.max(0, ...series.map(([, pts]) => pts.length));
  const tips = [...advice('cpu', cpuValues, req.cpu, lim.cpu), ...advice('memory', memValues, req.mem, lim.mem)];

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="usage-title" className="w-full max-w-3xl max-h-[88vh] flex flex-col rounded-xl border border-slate-700 bg-slate-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-800">
          <BarChart3 className="w-4 h-4 text-sky-400" />
          <h2 id="usage-title" className="text-sm font-semibold text-slate-100 truncate">Usage · {target.title}</h2>
          <span className="text-[11px] text-slate-500 font-mono">{target.namespace}</span>
          <button onClick={onClose} className="ml-auto p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 overflow-auto p-4 space-y-4 text-xs">
          {error && <div className="text-rose-300 bg-rose-950/50 border border-rose-900 rounded p-2.5">{error}</div>}
          {!data && !error ? (
            <div className="flex items-center gap-2 text-slate-500 py-10 justify-center"><Loader2 className="w-4 h-4 animate-spin" /> Reading metrics…</div>
          ) : (
            <>
              <div className="text-[11px] text-slate-500">
                {series.length} pod{series.length === 1 ? '' : 's'} · {samples} sample{samples === 1 ? '' : 's'} per pod.
                Kubellens samples every 30 s while this or the Pods / Deployments view is open (kept for 3 hours, in memory).
                {series.length === 0 && ' No metrics yet: metrics-server may be missing, or the pods just started.'}
              </div>
              {[
                { label: 'CPU per pod', idx: 1 as const, fmt: formatCpu, r: req.cpu, l: lim.cpu },
                { label: 'Memory per pod', idx: 2 as const, fmt: formatMem, r: req.mem, l: lim.mem },
              ].map((c) => {
                const values = series.flatMap(([, pts]) => pts.map((p) => p[c.idx]));
                return (
                  <div key={c.label} className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                    <div className="flex items-center gap-3 mb-1.5 text-[11px]">
                      <span className="font-semibold text-slate-200">{c.label}</span>
                      {values.length > 0 && (
                        <span className="text-slate-400 font-mono">now {c.fmt(values[values.length - 1])} · p95 {c.fmt(percentile(values, 95))} · peak {c.fmt(Math.max(...values))}</span>
                      )}
                    </div>
                    <Chart series={series.map(([name, pts]) => ({ name, points: pts.map((p) => [p[0], p[c.idx]] as [number, number]) }))} request={c.r} limit={c.l} format={c.fmt} />
                  </div>
                );
              })}
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10.5px] font-mono">
                {series.slice(0, 12).map(([name], i) => (
                  <span key={name} className="flex items-center gap-1 text-slate-400"><span className="w-2.5 h-0.5" style={{ background: COLORS[i % COLORS.length] }} />{name}</span>
                ))}
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 space-y-1.5">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-200"><Lightbulb className="w-3.5 h-3.5" /> Right-sizing</div>
                {samples < MIN_SAMPLES ? (
                  <div className="text-slate-500">Advice appears after about 5 minutes of samples ({samples}/{MIN_SAMPLES}). Leave this open or come back later.</div>
                ) : tips.length === 0 ? (
                  <div className="text-emerald-300">Requests and limits fit the observed usage.</div>
                ) : (
                  tips.map((t) => <div key={t} className="text-slate-300">• {t}</div>)
                )}
                <div className="text-[10px] text-slate-600">Based on the history Kubellens has seen, not on long-term data; check peaks at busy times before changing.</div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
