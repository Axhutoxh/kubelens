import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Radio, X, RefreshCw, AlertCircle } from 'lucide-react';
import { ForwardKind, startForward } from '../api/v18';
import { PortForwardSession } from '../types/k8s';
import { KIND_SHORT } from '../utils/savedForwards';

export interface ForwardTarget {
  kind: ForwardKind;
  name: string;
  namespace: string;
  /** Ports the target declares (service ports, container ports) */
  ports: Array<{ port: number; name?: string }>;
  context?: string;
}

interface PortForwardDialogProps {
  target: ForwardTarget;
  onClose: () => void;
  /** Called with the running forward (the caller opens it in the browser if asked) */
  onStarted: (session: PortForwardSession, openInBrowser: boolean) => void;
}

const OPEN_KEY = 'kubellens_pf_open_when_ready';

/** Port forward to a Service, Deployment or StatefulSet (kubectl picks a ready pod, and
 *  Kubellens reconnects to a new one if that pod goes away). */
export const PortForwardDialog: React.FC<PortForwardDialogProps> = ({ target, onClose, onStarted }) => {
  const [port, setPort] = useState(String(target.ports[0]?.port ?? ''));
  const [localPort, setLocalPort] = useState('');
  const [openWhenReady, setOpenWhenReady] = useState(() => {
    try { return localStorage.getItem(OPEN_KEY) !== 'false'; } catch { return true; }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const start = async () => {
    const p = parseInt(port, 10);
    const lp = localPort.trim() ? parseInt(localPort, 10) : undefined;
    if (!(p > 0 && p <= 65535)) { setError('Pick a port between 1 and 65535'); return; }
    if (lp !== undefined && !(lp > 0 && lp <= 65535)) { setError('The local port must be between 1 and 65535, or empty'); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await startForward({ kind: target.kind, name: target.name, namespace: target.namespace, port: p, localPort: lp, context: target.context });
      onStarted(res.session, openWhenReady);
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const input = 'w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700/80 text-slate-100 font-mono text-sm focus:outline-none focus:border-cyan-500';
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4" onClick={() => !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="pf-title" className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-800">
          <Radio className="w-4 h-4 text-cyan-400" />
          <h2 id="pf-title" className="text-sm font-semibold text-slate-100 truncate">Port forward to {KIND_SHORT[target.kind]}/{target.name}</h2>
          <button onClick={onClose} disabled={busy} className="ml-auto p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-4 text-xs">
          <div className="text-slate-400">
            <span className="font-mono text-slate-300">{target.namespace}</span>
            {target.kind !== 'pod' && ' · kubectl picks a ready pod; if it goes away, Kubellens reconnects to another.'}
          </div>
          {target.ports.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {target.ports.map((p) => (
                <button
                  key={`${p.port}-${p.name}`}
                  type="button"
                  onClick={() => setPort(String(p.port))}
                  className={`px-2.5 py-1 rounded-lg font-mono border ${port === String(p.port) ? 'bg-cyan-950 text-cyan-300 border-cyan-500/80' : 'bg-slate-900 text-slate-300 border-slate-700/80 hover:bg-slate-800'}`}
                >
                  {p.port}{p.name ? ` (${p.name})` : ''}
                </button>
              ))}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1">
              <span className="block text-slate-300 font-medium">{target.kind === 'service' ? 'Service port' : 'Container port'}</span>
              <input type="number" value={port} onChange={(e) => setPort(e.target.value)} className={input} />
            </label>
            <label className="space-y-1">
              <span className="block text-slate-300 font-medium">Local port</span>
              <input type="number" value={localPort} onChange={(e) => setLocalPort(e.target.value)} placeholder="auto" className={input} />
            </label>
          </div>
          <label className="flex items-center gap-2 text-slate-300 cursor-pointer w-fit">
            <input
              type="checkbox"
              checked={openWhenReady}
              onChange={(e) => {
                setOpenWhenReady(e.target.checked);
                try { localStorage.setItem(OPEN_KEY, String(e.target.checked)); } catch { /* ignore */ }
              }}
              className="accent-cyan-500"
            />
            Open in a browser tab when ready
          </label>
          {error && (
            <div className="p-2.5 rounded-lg bg-rose-950/60 border border-rose-800/80 text-rose-300 flex gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" /> <span className="break-words">{error}</span>
            </div>
          )}
          <div className="flex justify-end">
            <button onClick={start} disabled={busy || !port} className="px-4 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold flex items-center gap-2 disabled:opacity-50">
              {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Radio className="w-3.5 h-3.5" />}
              {busy ? 'Starting…' : 'Start forwarding'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
