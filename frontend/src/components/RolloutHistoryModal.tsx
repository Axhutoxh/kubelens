import React, { useEffect, useState } from 'react';
import { History, X, Loader2, RotateCcw, CheckCircle2 } from 'lucide-react';
import { DeploymentItem, ReplicaSetItem } from '../types/k8s';
import { fetchK8sResource, rolloutUndo } from '../api/client';

interface RolloutHistoryModalProps {
  deployment: DeploymentItem;
  onClose: () => void;
  onRolledBack: () => void;
  onToast: (message: string, type?: 'success' | 'error') => void;
}

interface Revision {
  revision: number;
  rs: ReplicaSetItem;
  images: string[];
  changeCause?: string;
  created?: string;
  replicas: number;
}

const REVISION_ANNOTATION = 'deployment.kubernetes.io/revision';
const CHANGE_CAUSE_ANNOTATION = 'kubernetes.io/change-cause';

function age(ts?: string) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Revision history of a Deployment, derived from the ReplicaSets it owns (each keeps
 * its revision number and pod template), with one-click rollback.
 */
export const RolloutHistoryModal: React.FC<RolloutHistoryModalProps> = ({ deployment, onClose, onRolledBack, onToast }) => {
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyRevision, setBusyRevision] = useState<number | null>(null);
  const namespace = deployment.metadata.namespace || 'default';
  const name = deployment.metadata.name;
  const currentRevision = Number(deployment.metadata.annotations?.[REVISION_ANNOTATION] || 0);

  const load = async () => {
    setError(null);
    try {
      const res = await fetchK8sResource<ReplicaSetItem>('replicasets', namespace);
      const owned = (res.items || []).filter((rs) =>
        rs.metadata.ownerReferences?.some((o) => o.kind === 'Deployment' && (o.uid ? o.uid === deployment.metadata.uid : o.name === name))
      );
      const list = owned
        .map((rs) => ({
          revision: Number(rs.metadata.annotations?.[REVISION_ANNOTATION] || 0),
          rs,
          images: (rs.spec.template?.spec?.containers || []).map((c) => c.image),
          changeCause: rs.metadata.annotations?.[CHANGE_CAUSE_ANNOTATION],
          created: rs.metadata.creationTimestamp,
          replicas: rs.status.replicas || 0,
        }))
        .filter((r) => r.revision > 0)
        .sort((a, b) => b.revision - a.revision);
      setRevisions(list);
    } catch (e: any) {
      setError(e.message || 'Failed to load revision history');
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, namespace]);

  const rollback = async (revision: number) => {
    if (!window.confirm(`Roll back deployment "${name}" to revision ${revision}?`)) return;
    setBusyRevision(revision);
    try {
      await rolloutUndo('deployment', name, namespace, revision);
      onToast(`Rolling back ${name} to revision ${revision}`);
      onRolledBack();
      onClose();
    } catch (e: any) {
      onToast(e.message || 'Rollback failed', 'error');
    } finally {
      setBusyRevision(null);
    }
  };

  const latest = revisions?.[0]?.revision ?? currentRevision;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-6" role="dialog" onClick={onClose}>
      <div
        className="w-full max-w-3xl max-h-[85vh] bg-slate-900 border border-slate-700 rounded-xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <History className="w-4 h-4 text-cyan-400" />
            <div>
              <div className="text-sm font-semibold text-slate-100">Rollout history</div>
              <div className="text-[11px] text-slate-400 font-mono">{namespace}/{name}</div>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-2.5">
          {error && <div className="text-xs text-rose-300 bg-rose-950/50 border border-rose-900 rounded p-3">{error}</div>}
          {!revisions && !error && (
            <div className="flex items-center gap-2 text-xs text-slate-400 p-3"><Loader2 className="w-4 h-4 animate-spin" /> Loading revisions…</div>
          )}
          {revisions?.length === 0 && (
            <div className="text-xs text-slate-500 italic p-3">No revision history found (old ReplicaSets may have been cleaned up by revisionHistoryLimit).</div>
          )}
          {revisions?.map((r) => {
            const isCurrent = r.revision === latest;
            return (
              <div
                key={r.revision}
                className={`rounded-lg border p-3.5 ${isCurrent ? 'border-cyan-700/70 bg-cyan-950/20' : 'border-slate-800 bg-slate-950/40'}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <span className={`font-mono text-xs font-bold px-2 py-0.5 rounded ${isCurrent ? 'bg-cyan-500/20 text-cyan-300' : 'bg-slate-800 text-slate-300'}`}>
                      #{r.revision}
                    </span>
                    {isCurrent && (
                      <span className="flex items-center gap-1 text-[10px] font-semibold text-emerald-400"><CheckCircle2 className="w-3 h-3" /> Current</span>
                    )}
                    <span className="text-[11px] text-slate-500">{age(r.created)}</span>
                    <span className="text-[11px] text-slate-500">· {r.replicas} pods</span>
                  </div>
                  {!isCurrent && (
                    <button
                      onClick={() => rollback(r.revision)}
                      disabled={busyRevision !== null}
                      className="flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-md bg-slate-800 hover:bg-amber-900/60 text-amber-300 border border-slate-700 hover:border-amber-700 transition-colors disabled:opacity-50"
                    >
                      {busyRevision === r.revision ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                      Roll back
                    </button>
                  )}
                </div>
                <div className="mt-2 space-y-0.5">
                  {r.images.map((img, i) => (
                    <div key={i} className="font-mono text-[11px] text-slate-300 truncate" title={img}>{img}</div>
                  ))}
                </div>
                {r.changeCause && <div className="mt-1.5 text-[11px] text-slate-400 italic">{r.changeCause}</div>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
