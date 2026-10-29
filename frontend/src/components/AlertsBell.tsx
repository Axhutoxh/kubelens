import React, { useEffect, useRef, useState } from 'react';
import { Bell, BellOff, BellRing, Monitor } from 'lucide-react';
import { PodAlert } from '../hooks/usePodAlerts';

interface AlertsBellProps {
  alerts: PodAlert[];
  enabled: boolean;
  desktop: boolean;
  onToggleEnabled: () => void;
  onEnableDesktop: () => Promise<boolean>;
  onDisableDesktop: () => void;
  onMarkAllRead: () => void;
  onClear: () => void;
  onOpenAlert: (a: PodAlert) => void;
}

const REASON_TONE: Record<string, string> = {
  OOMKilled: 'text-violet-300 bg-violet-950/60 border-violet-800/70',
  CrashLoopBackOff: 'text-rose-300 bg-rose-950/60 border-rose-800/70',
  ImagePullBackOff: 'text-amber-300 bg-amber-950/60 border-amber-800/70',
  ErrImagePull: 'text-amber-300 bg-amber-950/60 border-amber-800/70',
};

function ago(ts: number) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/** Top-bar bell with the pod alert feed (crash loops, OOM kills, image pull failures). */
export const AlertsBell: React.FC<AlertsBellProps> = ({
  alerts,
  enabled,
  desktop,
  onToggleEnabled,
  onEnableDesktop,
  onDisableDesktop,
  onMarkAllRead,
  onClear,
  onOpenAlert,
}) => {
  const [open, setOpen] = useState(false);
  const [desktopNote, setDesktopNote] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const unread = alerts.filter((a) => !a.read).length;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const Icon = !enabled ? BellOff : unread > 0 ? BellRing : Bell;

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => {
          setOpen((o) => !o);
          if (!open && unread > 0) onMarkAllRead();
        }}
        className={`relative p-1.5 rounded-md border transition-colors cursor-pointer ${
          unread > 0 ? 'text-rose-300 border-rose-700/70 bg-rose-950/40' : 'text-slate-400 border-slate-800 hover:text-slate-200 hover:bg-slate-800'
        }`}
        title={enabled ? `${unread} new pod alert(s)` : 'Pod alerts are off'}
      >
        <Icon className={`w-3.5 h-3.5 ${unread > 0 ? 'animate-pulse' : ''}`} />
        {unread > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-4 h-4 px-1 rounded-full bg-rose-500 text-white text-[9px] font-bold flex items-center justify-center">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-9 z-50 w-[26rem] max-h-[70vh] flex flex-col bg-slate-900 border border-slate-700 rounded-lg shadow-2xl overflow-hidden">
          <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-200">Pod alerts</span>
            <div className="flex items-center gap-2 text-[11px]">
              <button onClick={onClear} disabled={alerts.length === 0} className="text-slate-400 hover:text-slate-200 disabled:opacity-40">Clear</button>
              <button onClick={onToggleEnabled} className={enabled ? 'text-slate-400 hover:text-rose-300' : 'text-cyan-300 hover:text-cyan-200'}>
                {enabled ? 'Turn off' : 'Turn on'}
              </button>
            </div>
          </div>

          <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between gap-2 text-[11px]">
            <span className="flex items-center gap-1.5 text-slate-400">
              <Monitor className="w-3.5 h-3.5" /> Desktop notifications
            </span>
            <button
              onClick={async () => {
                if (desktop) { onDisableDesktop(); setDesktopNote(null); return; }
                const ok = await onEnableDesktop();
                setDesktopNote(ok ? null : 'Not allowed here; the taskbar icon will still flash on new alerts.');
              }}
              className={`px-2 py-0.5 rounded border ${desktop ? 'text-emerald-300 border-emerald-800 bg-emerald-950/50' : 'text-slate-300 border-slate-700 hover:bg-slate-800'}`}
            >
              {desktop ? 'On' : 'Enable'}
            </button>
          </div>
          {desktopNote && <div className="px-3 py-1.5 text-[11px] text-amber-300 border-b border-slate-800">{desktopNote}</div>}

          <div className="flex-1 overflow-auto">
            {!enabled ? (
              <div className="p-4 text-xs text-slate-500">Alerts are off. Turn them on to watch pods in the selected namespace.</div>
            ) : alerts.length === 0 ? (
              <div className="p-4 text-xs text-slate-500">
                No problems. Watching pods in the selected namespace for crash loops, OOM kills, image pull failures and evictions.
              </div>
            ) : (
              alerts.map((a) => (
                <button
                  key={`${a.id}-${a.at}`}
                  onClick={() => { onOpenAlert(a); setOpen(false); }}
                  className="w-full text-left px-3 py-2 border-b border-slate-800/70 hover:bg-slate-800/60 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${REASON_TONE[a.reason] || 'text-rose-300 bg-rose-950/60 border-rose-800/70'}`}>
                      {a.reason}
                    </span>
                    <span className="font-mono text-[11px] text-slate-200 truncate">{a.pod}</span>
                    <span className="ml-auto text-[10px] text-slate-500 shrink-0">{ago(a.at)}</span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-slate-500 truncate">
                    {a.namespace}{a.container ? ` · ${a.container}` : ''}{a.message ? ` · ${a.message}` : ''}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
