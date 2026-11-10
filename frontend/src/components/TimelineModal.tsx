import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, GitCommitVertical, Loader2, Rocket, Pencil, RotateCcw, FileText, Scaling, Box, Radio, Sparkles } from 'lucide-react';
import { TimelineEntry, fetchTimeline } from '../api/insights';

export interface TimelineTarget {
  kind: 'deployment' | 'statefulset' | 'daemonset' | 'pod';
  name: string;
  namespace: string;
  context?: string;
}

interface TimelineModalProps {
  target: TimelineTarget;
  onClose: () => void;
  onAskAi?: (text: string, focus?: string) => void;
}

const CATEGORY: Record<TimelineEntry['category'], { label: string; Icon: typeof Rocket; color: string }> = {
  rollout: { label: 'Rollouts', Icon: Rocket, color: 'text-cyan-300' },
  change: { label: 'Spec changes', Icon: Pencil, color: 'text-indigo-300' },
  config: { label: 'Config', Icon: FileText, color: 'text-violet-300' },
  restart: { label: 'Restarts', Icon: RotateCcw, color: 'text-rose-300' },
  scale: { label: 'Scaling', Icon: Scaling, color: 'text-sky-300' },
  pod: { label: 'Pods', Icon: Box, color: 'text-slate-300' },
  event: { label: 'Events', Icon: Radio, color: 'text-amber-300' },
};

const DOT: Record<TimelineEntry['severity'], string> = {
  info: 'bg-slate-500',
  warning: 'bg-amber-400',
  error: 'bg-rose-500',
};

function when(t: string) {
  if (!t) return { day: 'Now', time: '' };
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return {
    day: today ? 'Today' : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }),
    time: d.toLocaleTimeString([], { hour12: false }),
  };
}

/** Rollouts, spec edits, restarts, config changes and events of one workload, newest first. */
export const TimelineModal: React.FC<TimelineModalProps> = ({ target, onClose, onAskAi }) => {
  const [entries, setEntries] = useState<TimelineEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(['pod']));
  const [onlyProblems, setOnlyProblems] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchTimeline(target.kind, target.name, target.namespace, target.context)
      .then((r) => alive && setEntries(r.entries))
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [target]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    (entries || []).forEach((e) => m.set(e.category, (m.get(e.category) || 0) + 1));
    return m;
  }, [entries]);
  const shown = (entries || []).filter((e) => !hidden.has(e.category) && (!onlyProblems || e.severity !== 'info'));

  // Group by day for readability
  const groups: Array<{ day: string; items: TimelineEntry[] }> = [];
  shown.forEach((e) => {
    const { day } = when(e.time);
    if (groups[groups.length - 1]?.day !== day) groups.push({ day, items: [] });
    groups[groups.length - 1].items.push(e);
  });

  const askAi = () => {
    const recent = shown.slice(0, 40).map((e) => `- ${e.time || 'now'} [${e.category}/${e.severity}] ${e.title}${e.detail ? `: ${e.detail.replace(/\n/g, '; ')}` : ''}`).join('\n');
    onAskAi?.(
      `Here is the recent timeline of ${target.kind} ${target.namespace}/${target.name} (newest first):\n${recent}\n\nWhat changed before things went wrong, and what is the likely cause?`,
      `${target.kind} ${target.namespace}/${target.name}`
    );
    onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="timeline-title"
        className="w-full max-w-3xl h-[85vh] flex flex-col rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-800">
          <GitCommitVertical className="w-4 h-4 text-cyan-400" />
          <h2 id="timeline-title" className="text-sm font-semibold text-slate-100 truncate">Timeline · {target.kind} {target.name}</h2>
          <span className="text-[11px] text-slate-500 font-mono truncate">{target.namespace}{target.context ? ` · ${target.context}` : ''}</span>
          <div className="ml-auto flex items-center gap-1">
            {onAskAi && entries && entries.length > 0 && (
              <button onClick={askAi} className="flex items-center gap-1 px-2 py-1 rounded border border-violet-800/70 text-[11px] text-violet-300 hover:bg-violet-950/40" title="Ask the AI what changed before it broke">
                <Sparkles className="w-3 h-3" /> Ask AI
              </button>
            )}
            <button onClick={onClose} className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800" aria-label="Close"><X className="w-4 h-4" /></button>
          </div>
        </div>

        {entries && (
          <div className="px-4 py-2 border-b border-slate-800 flex flex-wrap items-center gap-1.5 text-[11px] select-none">
            {(Object.keys(CATEGORY) as TimelineEntry['category'][]).filter((c) => counts.get(c)).map((c) => {
              const { label, Icon, color } = CATEGORY[c];
              const on = !hidden.has(c);
              return (
                <button
                  key={c}
                  onClick={() => setHidden((h) => { const n = new Set(h); if (n.has(c)) n.delete(c); else n.add(c); return n; })}
                  className={`flex items-center gap-1 px-2 py-0.5 rounded border ${on ? 'border-slate-600 bg-slate-800 text-slate-200' : 'border-slate-800 text-slate-500 hover:text-slate-300'}`}
                >
                  <Icon className={`w-3 h-3 ${on ? color : ''}`} /> {label} <span className="text-slate-500 font-mono">{counts.get(c)}</span>
                </button>
              );
            })}
            <label className="ml-auto flex items-center gap-1.5 text-slate-400 cursor-pointer">
              <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} className="accent-cyan-500" />
              Warnings and errors only
            </label>
          </div>
        )}

        <div className="flex-1 overflow-auto px-4 py-3 select-text">
          {error ? (
            <div className="text-xs text-rose-300 bg-rose-950/50 border border-rose-900 rounded p-3 whitespace-pre-wrap">{error}</div>
          ) : !entries ? (
            <div className="flex items-center justify-center gap-2 text-xs text-slate-500 py-16"><Loader2 className="w-4 h-4 animate-spin" /> Collecting rollouts, restarts, config changes and events…</div>
          ) : shown.length === 0 ? (
            <div className="text-xs text-slate-500 py-10 text-center">Nothing to show with these filters. Kubernetes keeps events for about an hour, so older history comes from rollouts and object edits only.</div>
          ) : groups.map((g) => (
            <div key={g.day} className="mb-3">
              <div className="sticky top-0 bg-slate-900/95 backdrop-blur-sm py-1 text-[10px] uppercase tracking-wider text-slate-500 font-semibold z-10">{g.day}</div>
              <div className="border-l border-slate-800 ml-1.5">
                {g.items.map((e, i) => {
                  const { Icon, color } = CATEGORY[e.category];
                  return (
                    <div key={i} className="relative pl-5 py-1.5">
                      <span className={`absolute -left-[5px] top-3 w-2.5 h-2.5 rounded-full ring-2 ring-slate-900 ${DOT[e.severity]}`} />
                      <div className="flex items-start gap-2 text-xs">
                        <span className="text-slate-500 font-mono w-16 shrink-0 tabular-nums">{when(e.time).time}</span>
                        <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${color}`} />
                        <div className="min-w-0 flex-1">
                          <div className={`${e.severity === 'error' ? 'text-rose-200' : e.severity === 'warning' ? 'text-amber-100' : 'text-slate-200'}`}>{e.title}</div>
                          {e.detail && <div className="text-[11px] text-slate-400 whitespace-pre-wrap break-words font-mono">{e.detail}</div>}
                          {e.object && <div className="text-[10px] text-slate-600 font-mono truncate">{e.object}</div>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
};
