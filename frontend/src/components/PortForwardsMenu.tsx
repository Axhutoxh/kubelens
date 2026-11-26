import React, { useEffect, useRef, useState } from 'react';
import { Radio, ExternalLink, Copy, Square, Bookmark, BookmarkCheck, Play, Trash2, RefreshCw } from 'lucide-react';
import { PortForwardSession } from '../types/k8s';
import { KIND_SHORT, SavedForward } from '../utils/savedForwards';

interface PortForwardsMenuProps {
  forwards: PortForwardSession[];
  /** Saved forwards of the active workspace (and those saved without one) */
  saved: SavedForward[];
  workspaceName?: string;
  onOpen: (pf: PortForwardSession) => void;
  onStop: (pf: PortForwardSession) => void;
  onCopy: (pf: PortForwardSession) => void;
  onSave: (pf: PortForwardSession) => void;
  onStartSaved: (sf: SavedForward) => Promise<void>;
  onRemoveSaved: (id: string) => void;
}

const sameTarget = (pf: PortForwardSession, sf: SavedForward) =>
  (pf.kind || 'pod') === sf.kind && pf.pod === sf.name && pf.namespace === sf.namespace && pf.containerPort === sf.port && (pf.context || '') === (sf.context || pf.context || '');

/** Top-bar list of running port forwards (open, copy, save, stop) and saved ones to restart. */
export const PortForwardsMenu: React.FC<PortForwardsMenuProps> = ({ forwards, saved, workspaceName, onOpen, onStop, onCopy, onSave, onStartSaved, onRemoveSaved }) => {
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState<Set<string>>(() => new Set());
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  if (forwards.length === 0 && saved.length === 0) return null;

  const notRunning = saved.filter((sf) => !forwards.some((pf) => sameTarget(pf, sf)));
  const start = async (list: SavedForward[]) => {
    setStarting((s) => new Set([...s, ...list.map((x) => x.id)]));
    await Promise.allSettled(list.map((sf) => onStartSaved(sf)));
    setStarting((s) => { const n = new Set(s); list.forEach((x) => n.delete(x.id)); return n; });
  };
  const reconnecting = forwards.some((f) => f.status === 'Reconnecting');

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        title={forwards.length ? `${forwards.length} active port forward(s)` : 'Saved port forwards'}
        className={`flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-md border transition-colors cursor-pointer ${
          forwards.length
            ? 'bg-cyan-950/90 border-cyan-500/70 text-cyan-300 hover:bg-cyan-900/60'
            : 'bg-slate-950/80 border-slate-700 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
        }`}
      >
        <Radio className={`w-3.5 h-3.5 ${forwards.length ? 'text-cyan-400 animate-pulse' : ''} ${reconnecting ? 'text-amber-400' : ''}`} />
        <span className="whitespace-nowrap">{forwards.length ? `${forwards.length} Forward${forwards.length > 1 ? 's' : ''}` : 'Forwards'}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-9 z-50 w-[28rem] max-h-[70vh] overflow-auto bg-slate-900 border border-slate-700 rounded-lg shadow-2xl">
          <div className="px-3 py-2 border-b border-slate-800 text-xs font-semibold text-slate-200">Port forwards</div>
          {forwards.length === 0 && <div className="px-3 py-2 text-[11px] text-slate-500">None running.</div>}
          {forwards.map((pf) => {
            const isSaved = saved.some((sf) => sameTarget(pf, sf));
            return (
              <div key={pf.id} className="px-3 py-2 border-b border-slate-800/70 flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full shrink-0 ${pf.status === 'Reconnecting' ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'}`} />
                <div className="flex-1 min-w-0">
                  <button onClick={() => onOpen(pf)} className="font-mono text-xs text-cyan-300 hover:underline truncate block max-w-full text-left" title="Open in your browser">
                    {pf.url}
                  </button>
                  <div className="text-[10px] text-slate-500 font-mono truncate" title={`${pf.namespace}/${pf.pod}${pf.context ? ` [${pf.context}]` : ''}${pf.lastError ? `\n${pf.lastError}` : ''}`}>
                    → {KIND_SHORT[pf.kind || 'pod']}/{pf.pod}:{pf.containerPort} · {pf.namespace}
                    {pf.status === 'Reconnecting' && <span className="text-amber-300 font-sans"> · reconnecting…</span>}
                    {!!pf.reconnects && pf.status !== 'Reconnecting' && <span className="font-sans"> · reconnected {pf.reconnects}×</span>}
                  </div>
                </div>
                <button onClick={() => onOpen(pf)} title="Open in your browser" className="p-1 rounded text-slate-400 hover:text-cyan-300 hover:bg-slate-800"><ExternalLink className="w-3.5 h-3.5" /></button>
                <button onClick={() => onCopy(pf)} title="Copy URL" className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800"><Copy className="w-3.5 h-3.5" /></button>
                <button
                  onClick={() => !isSaved && onSave(pf)}
                  title={isSaved ? 'Saved' : `Save${workspaceName ? ` to workspace ${workspaceName}` : ''} to restart later`}
                  className={`p-1 rounded hover:bg-slate-800 ${isSaved ? 'text-cyan-300' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  {isSaved ? <BookmarkCheck className="w-3.5 h-3.5" /> : <Bookmark className="w-3.5 h-3.5" />}
                </button>
                <button onClick={() => onStop(pf)} title="Stop forwarding" className="p-1 rounded text-slate-400 hover:text-rose-400 hover:bg-slate-800"><Square className="w-3.5 h-3.5" /></button>
              </div>
            );
          })}

          {saved.length > 0 && (
            <>
              <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Saved{workspaceName ? ` · ${workspaceName}` : ''}</span>
                {notRunning.length > 1 && (
                  <button onClick={() => start(notRunning)} className="ml-auto text-[11px] text-cyan-300 hover:text-cyan-200 flex items-center gap-1">
                    <Play className="w-3 h-3" /> Start all ({notRunning.length})
                  </button>
                )}
              </div>
              {saved.map((sf) => {
                const running = !notRunning.includes(sf);
                return (
                  <div key={sf.id} className="group px-3 py-1.5 border-b border-slate-800/60 flex items-center gap-2 text-[11px]">
                    <div className="flex-1 min-w-0 font-mono truncate" title={sf.context}>
                      <span className="text-slate-200">{KIND_SHORT[sf.kind]}/{sf.name}:{sf.port}</span>
                      <span className="text-slate-500"> · {sf.namespace}{sf.localPort ? ` · localhost:${sf.localPort}` : ''}</span>
                    </div>
                    {running ? (
                      <span className="text-emerald-400 text-[10px]">running</span>
                    ) : (
                      <button onClick={() => start([sf])} disabled={starting.has(sf.id)} title="Start" className="p-1 rounded text-slate-400 hover:text-emerald-300 hover:bg-slate-800 disabled:opacity-50">
                        {starting.has(sf.id) ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                      </button>
                    )}
                    <button onClick={() => onRemoveSaved(sf.id)} title="Remove from saved" className="p-1 rounded text-slate-600 hover:text-rose-400 opacity-0 group-hover:opacity-100"><Trash2 className="w-3 h-3" /></button>
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
};
