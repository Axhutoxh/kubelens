import React, { useMemo, useState } from 'react';
import { Tag, X, Loader2, CheckCircle2, AlertCircle, ArrowRight } from 'lucide-react';
import { DeploymentItem } from '../types/k8s';
import { setImages } from '../api/client';

interface SetImageTagModalProps {
  deployments: DeploymentItem[];
  onClose: () => void;
  onApplied: () => void;
  onToast: (message: string, type?: 'success' | 'error') => void;
}

// Docker tag grammar: up to 128 chars of [A-Za-z0-9_.-], not starting with '.' or '-'
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** "host:5000/team/app:1.2@sha256:…" -> "host:5000/team/app" */
function imageRepo(image: string): string {
  const noDigest = image.split('@')[0];
  const lastColon = noDigest.lastIndexOf(':');
  return lastColon > noDigest.lastIndexOf('/') ? noDigest.slice(0, lastColon) : noDigest;
}

function currentTag(image: string): string {
  if (image.includes('@')) return image.split('@')[1].slice(0, 15) + '…';
  const repo = imageRepo(image);
  return image.length > repo.length ? image.slice(repo.length + 1) : 'latest';
}

type RowStatus = { state: 'pending' } | { state: 'ok' } | { state: 'error'; message: string };

const depKey = (d: DeploymentItem) => `${d.metadata.namespace}/${d.metadata.name}`;

/**
 * Point the same tag at many deployments in one go: every ticked container keeps its
 * repository and gets the new tag; each deployment is updated with a single `kubectl set image`.
 */
export const SetImageTagModal: React.FC<SetImageTagModalProps> = ({ deployments, onClose, onApplied, onToast }) => {
  // Pre-fill with the most common current tag so a typo-fix is a small edit
  const initialTag = useMemo(() => {
    const counts = new Map<string, number>();
    deployments.forEach((d) =>
      (d.spec.template?.spec?.containers || []).forEach((c) => {
        if (c.image && !c.image.includes('@')) counts.set(currentTag(c.image), (counts.get(currentTag(c.image)) || 0) + 1);
      })
    );
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  }, [deployments]);

  const [tag, setTag] = useState(initialTag);
  // Ticked containers, keyed "<ns>/<deployment>/<container>"; all ticked by default
  const [checked, setChecked] = useState<Set<string>>(
    () =>
      new Set(
        deployments.flatMap((d) => (d.spec.template?.spec?.containers || []).map((c) => `${depKey(d)}/${c.name}`))
      )
  );
  const [status, setStatus] = useState<Record<string, RowStatus>>({});
  const [isApplying, setIsApplying] = useState(false);

  const trimmed = tag.trim();
  const tagValid = TAG_RE.test(trimmed);

  const plan = deployments
    .map((d) => ({
      dep: d,
      images: (d.spec.template?.spec?.containers || [])
        .filter((c) => checked.has(`${depKey(d)}/${c.name}`) && c.image)
        .map((c) => ({ container: c.name, image: `${imageRepo(c.image)}:${trimmed}`, from: c.image })),
    }))
    // Skip deployments that would not change, so they don't get a pointless rollout
    .map((p) => ({ ...p, images: p.images.filter((i) => i.image !== i.from) }))
    .filter((p) => p.images.length > 0);

  const toggle = (key: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  const apply = async () => {
    if (!tagValid || plan.length === 0) return;
    const summary = plan.map((p) => `  • ${p.dep.metadata.name}`).slice(0, 10).join('\n');
    const more = plan.length > 10 ? `\n  …and ${plan.length - 10} more` : '';
    if (!window.confirm(`Set image tag "${trimmed}" on ${plan.length} deployment(s)? Each will roll out new pods.\n\n${summary}${more}`)) return;

    setIsApplying(true);
    setStatus(Object.fromEntries(plan.map((p) => [depKey(p.dep), { state: 'pending' } as RowStatus])));
    const results = await Promise.allSettled(
      plan.map(async (p) => {
        const key = depKey(p.dep);
        try {
          await setImages('deployment', p.dep.metadata.name, p.dep.metadata.namespace || 'default', p.images.map(({ container, image }) => ({ container, image })));
          setStatus((s) => ({ ...s, [key]: { state: 'ok' } }));
        } catch (e: any) {
          setStatus((s) => ({ ...s, [key]: { state: 'error', message: e.message || 'Failed' } }));
          throw e;
        }
      })
    );
    setIsApplying(false);
    onApplied();

    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed === 0) {
      onToast(`Set tag ${trimmed} on ${plan.length} deployment(s)`);
      onClose();
    } else {
      onToast(`Updated ${plan.length - failed} of ${plan.length} deployments (${failed} failed)`, 'error');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-6" role="dialog" onClick={isApplying ? undefined : onClose}>
      <div
        className="w-full max-w-3xl max-h-[85vh] bg-slate-900 border border-slate-700 rounded-xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Tag className="w-4 h-4 text-indigo-400" />
            <div>
              <div className="text-sm font-semibold text-slate-100">Set image tag</div>
              <div className="text-[11px] text-slate-400">{deployments.length} deployment(s) · repositories are kept, only the tag changes</div>
            </div>
          </div>
          <button onClick={onClose} disabled={isApplying} className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 disabled:opacity-40"><X className="w-4 h-4" /></button>
        </div>

        <div className="px-5 py-3.5 border-b border-slate-800 space-y-1.5">
          <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide" htmlFor="new-image-tag">New tag</label>
          <input
            id="new-image-tag"
            autoFocus
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') apply(); }}
            placeholder="e.g. 2026.10.26-1105"
            spellCheck={false}
            className={`w-full px-3 py-2 bg-slate-950 border rounded-lg font-mono text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none ${
              trimmed && !tagValid ? 'border-rose-600 focus:border-rose-500' : 'border-slate-700 focus:border-cyan-500'
            }`}
          />
          {trimmed && !tagValid && (
            <div className="text-[11px] text-rose-400">
              Enter just the tag (letters, digits, <code>_ . -</code>, max 128 chars), not the full image.
            </div>
          )}
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-2">
          {deployments.map((d) => {
            const key = depKey(d);
            const containers = d.spec.template?.spec?.containers || [];
            const st = status[key];
            return (
              <div key={key} className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                <div className="flex items-center justify-between gap-3 mb-1.5">
                  <span className="font-mono text-xs font-semibold text-slate-100 truncate" title={key}>{d.metadata.name}</span>
                  {st?.state === 'pending' && <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400 shrink-0" />}
                  {st?.state === 'ok' && <span className="flex items-center gap-1 text-[10px] font-semibold text-emerald-400 shrink-0"><CheckCircle2 className="w-3 h-3" /> Updated</span>}
                  {st?.state === 'error' && (
                    <span className="flex items-center gap-1 text-[10px] font-semibold text-rose-400 truncate max-w-[60%]" title={st.message}>
                      <AlertCircle className="w-3 h-3 shrink-0" /> {st.message}
                    </span>
                  )}
                </div>
                <div className="space-y-1">
                  {containers.map((c) => {
                    const ck = `${key}/${c.name}`;
                    const on = checked.has(ck);
                    const next = `${imageRepo(c.image)}:${trimmed || '…'}`;
                    const unchanged = on && tagValid && next === c.image;
                    return (
                      <label key={c.name} className="flex items-center gap-2 text-[11px] font-mono cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggle(ck)}
                          disabled={isApplying}
                          className="accent-cyan-500 w-3.5 h-3.5 shrink-0"
                        />
                        <span className="text-slate-400 shrink-0">{c.name}:</span>
                        <span className={`truncate ${on ? 'text-slate-500 line-through decoration-slate-600' : 'text-slate-400'}`} title={c.image}>
                          {currentTag(c.image)}
                        </span>
                        {on && (
                          <>
                            <ArrowRight className="w-3 h-3 text-slate-500 shrink-0" />
                            <span className={`truncate ${unchanged ? 'text-slate-500' : 'text-indigo-300 font-semibold'}`} title={next}>
                              {trimmed || '…'}
                            </span>
                            {unchanged && <span className="text-slate-600 font-sans italic shrink-0">already on this tag</span>}
                          </>
                        )}
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        <div className="px-5 py-3 border-t border-slate-800 flex items-center justify-between gap-3">
          <span className="text-[11px] text-slate-400">
            {plan.length === 0
              ? 'Nothing to change'
              : `${plan.length} deployment(s), ${plan.reduce((n, p) => n + p.images.length, 0)} container(s) will be updated`}
          </span>
          <div className="flex items-center gap-2">
            <button onClick={onClose} disabled={isApplying} className="px-3 py-1.5 rounded-md text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-40">Cancel</button>
            <button
              onClick={apply}
              disabled={!tagValid || plan.length === 0 || isApplying}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-cyan-600 hover:bg-cyan-500 text-white disabled:opacity-40 transition-colors"
            >
              {isApplying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Tag className="w-3.5 h-3.5" />}
              {isApplying ? 'Applying…' : 'Apply tag'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
