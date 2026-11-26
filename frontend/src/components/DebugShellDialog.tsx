import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bug, X, AlertTriangle, ServerCog } from 'lucide-react';

export type DebugShellRequest =
  | { kind: 'pod'; pod: string; namespace: string; containers: string[]; context?: string }
  | { kind: 'node'; node: string; context?: string };

interface DebugShellDialogProps {
  request: DebugShellRequest;
  onClose: () => void;
  onStart: (opts: { image: string; target?: string; namespace?: string }) => void;
}

const IMAGES = ['busybox:1.36', 'nicolaka/netshoot:latest', 'alpine:3.20'];
const IMAGE_KEY = 'kubellens_debug_image';

/**
 * Confirms a debug shell before anything is created: an ephemeral container added to a pod
 * (for images without a shell), or a privileged helper pod on a node (deleted afterwards).
 */
export const DebugShellDialog: React.FC<DebugShellDialogProps> = ({ request, onClose, onStart }) => {
  const [image, setImage] = useState(() => {
    try { return localStorage.getItem(IMAGE_KEY) || IMAGES[0]; } catch { return IMAGES[0]; }
  });
  const [target, setTarget] = useState(request.kind === 'pod' ? request.containers[0] || '' : '');
  const [namespace, setNamespace] = useState('default');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const validImage = /^[A-Za-z0-9][A-Za-z0-9./:_@-]{0,299}$/.test(image.trim());
  const start = () => {
    if (!validImage) return;
    try { localStorage.setItem(IMAGE_KEY, image.trim()); } catch { /* ignore */ }
    onStart({ image: image.trim(), target: request.kind === 'pod' ? target || undefined : undefined, namespace: request.kind === 'node' ? namespace : undefined });
    onClose();
  };

  const input = 'w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700/80 text-slate-100 font-mono text-xs focus:outline-none focus:border-cyan-500';
  const isNode = request.kind === 'node';
  return createPortal(
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="dbg-title" className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-800">
          {isNode ? <ServerCog className="w-4 h-4 text-amber-400" /> : <Bug className="w-4 h-4 text-emerald-400" />}
          <h2 id="dbg-title" className="text-sm font-semibold text-slate-100 truncate">
            {isNode ? `Node shell on ${request.node}` : `Debug shell in ${request.pod}`}
          </h2>
          <button onClick={onClose} className="ml-auto p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-3 text-xs">
          <div className={`p-2.5 rounded-lg border flex gap-2 ${isNode ? 'bg-amber-950/40 border-amber-800/70 text-amber-100' : 'bg-slate-950/60 border-slate-700 text-slate-300'}`}>
            <AlertTriangle className={`w-4 h-4 shrink-0 ${isNode ? 'text-amber-400' : 'text-slate-400'}`} />
            {isNode ? (
              <span>
                Creates a <b>privileged pod</b> on this node with the host filesystem at <code>/</code> (via <code>chroot /host</code>). You get root on the node.
                Kubellens deletes the pod when you close the shell. Needs permission to create privileged pods.
              </span>
            ) : (
              <span>
                Adds an <b>ephemeral debug container</b> to this pod (<code>kubectl debug</code>), for images without a shell. It can see the
                target container's processes. Kubernetes keeps the stopped container in the pod spec until the pod is replaced; the app isn't restarted.
              </span>
            )}
          </div>
          <label className="block space-y-1">
            <span className="text-slate-300 font-medium">Debug image</span>
            <input value={image} onChange={(e) => setImage(e.target.value)} spellCheck={false} className={`${input} ${validImage ? '' : 'border-rose-600'}`} />
            <div className="flex gap-1.5 flex-wrap">
              {IMAGES.map((i) => (
                <button key={i} type="button" onClick={() => setImage(i)} className={`px-2 py-0.5 rounded border font-mono text-[10.5px] ${image === i ? 'border-cyan-500/70 text-cyan-200' : 'border-slate-700 text-slate-400 hover:bg-slate-800'}`}>{i}</button>
              ))}
            </div>
          </label>
          {request.kind === 'pod' && request.containers.length > 0 && (
            <label className="block space-y-1">
              <span className="text-slate-300 font-medium">Share processes with</span>
              <select value={target} onChange={(e) => setTarget(e.target.value)} className={input}>
                {request.containers.map((c) => <option key={c} value={c}>{c}</option>)}
                <option value="">(none)</option>
              </select>
            </label>
          )}
          {isNode && (
            <label className="block space-y-1">
              <span className="text-slate-300 font-medium">Namespace for the helper pod</span>
              <input value={namespace} onChange={(e) => setNamespace(e.target.value)} className={input} />
            </label>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800">Cancel</button>
            <button onClick={start} disabled={!validImage || (isNode && !namespace.trim())} className={`px-3 py-1.5 rounded-lg font-semibold disabled:opacity-50 ${isNode ? 'bg-amber-500 hover:bg-amber-400 text-slate-950' : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950'}`}>
              {isNode ? 'Start node shell' : 'Start debug shell'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
