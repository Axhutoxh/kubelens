import React, { useEffect, useState } from 'react';
import { RotateCw, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { fetchK8sResource, restartResource } from '../api/client';

type RefKind = 'configmap' | 'secret';

export interface DependentWorkload {
  kind: 'deployment' | 'statefulset' | 'daemonset';
  name: string;
  namespace: string;
  /** How the workload consumes the object: "env", "envFrom", "volume" */
  via: string[];
}

const WORKLOAD_KINDS: Array<[DependentWorkload['kind'], string]> = [
  ['deployment', 'deployments'],
  ['statefulset', 'statefulsets'],
  ['daemonset', 'daemonsets'],
];

/** Ways a pod template references the ConfigMap / Secret called `name`. */
function referencesIn(podSpec: any, kind: RefKind, name: string): string[] {
  if (!podSpec) return [];
  const via = new Set<string>();
  const isCm = kind === 'configmap';
  const containers = [...(podSpec.containers || []), ...(podSpec.initContainers || [])];
  for (const c of containers) {
    for (const e of c.env || []) {
      const ref = isCm ? e.valueFrom?.configMapKeyRef : e.valueFrom?.secretKeyRef;
      if (ref?.name === name) via.add('env');
    }
    for (const ef of c.envFrom || []) {
      const ref = isCm ? ef.configMapRef : ef.secretRef;
      if (ref?.name === name) via.add('envFrom');
    }
  }
  for (const v of podSpec.volumes || []) {
    if (isCm ? v.configMap?.name === name : v.secret?.secretName === name) via.add('volume');
    for (const src of v.projected?.sources || []) {
      if ((isCm ? src.configMap?.name : src.secret?.name) === name) via.add('volume');
    }
  }
  return [...via];
}

export async function findDependentWorkloads(kind: RefKind, name: string, namespace: string, context?: string): Promise<DependentWorkload[]> {
  const lists = await Promise.all(
    WORKLOAD_KINDS.map(([k, plural]) =>
      fetchK8sResource<any>(plural, namespace, context)
        .then((res) => (res.items || []).map((item) => ({ k, item })))
        .catch(() => [])
    )
  );
  return lists.flat().flatMap(({ k, item }) => {
    const via = referencesIn(item.spec?.template?.spec, kind, name);
    return via.length ? [{ kind: k, name: item.metadata.name, namespace: item.metadata.namespace || namespace, via }] : [];
  });
}

interface RestartDependentsProps {
  refKind: RefKind;
  refName: string;
  namespace: string;
  context?: string;
  onToast?: (message: string, type?: 'success' | 'error') => void;
  onDone?: () => void;
}

/**
 * Shown after saving a ConfigMap / Secret: environment variables are only read at container
 * start, so workloads that use it keep the old values until they are restarted.
 */
export const RestartDependents: React.FC<RestartDependentsProps> = ({ refKind, refName, namespace, context, onToast, onDone }) => {
  const [deps, setDeps] = useState<DependentWorkload[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<Record<string, 'pending' | 'ok' | 'error'>>({});
  const [busy, setBusy] = useState(false);
  const key = (d: DependentWorkload) => `${d.kind}/${d.name}`;

  useEffect(() => {
    let alive = true;
    findDependentWorkloads(refKind, refName, namespace, context).then((list) => {
      if (!alive) return;
      setDeps(list);
      setChecked(new Set(list.map(key)));
    });
    return () => { alive = false; };
  }, [refKind, refName, namespace, context]);

  const restart = async () => {
    const targets = (deps || []).filter((d) => checked.has(key(d)));
    if (targets.length === 0) return;
    setBusy(true);
    setStatus(Object.fromEntries(targets.map((d) => [key(d), 'pending' as const])));
    const results = await Promise.allSettled(
      targets.map((d) =>
        restartResource(d.kind, d.name, d.namespace, context).then(
          () => setStatus((s) => ({ ...s, [key(d)]: 'ok' })),
          (e) => { setStatus((s) => ({ ...s, [key(d)]: 'error' })); throw e; }
        )
      )
    );
    setBusy(false);
    const failed = results.filter((r) => r.status === 'rejected').length;
    onToast?.(
      failed ? `Restarted ${targets.length - failed} of ${targets.length} workloads (${failed} failed)` : `Restarted ${targets.length} workload(s)`,
      failed ? 'error' : 'success'
    );
    if (!failed) onDone?.();
  };

  if (deps === null) {
    return <div className="flex items-center gap-2 text-[11px] text-slate-400"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Looking for workloads that use {refName}…</div>;
  }
  if (deps.length === 0) {
    return <div className="text-[11px] text-slate-500">No deployments, stateful sets or daemon sets in {namespace} use {refName}.</div>;
  }

  return (
    <div className="space-y-2">
      <div className="text-[11px] text-slate-300">
        <span className="font-semibold text-amber-300">{deps.length} workload(s)</span> use this {refKind === 'configmap' ? 'ConfigMap' : 'Secret'}.
        Running pods keep the old environment values until they restart.
      </div>
      <div className="max-h-40 overflow-auto space-y-1 pr-1">
        {deps.map((d) => {
          const k = key(d);
          const st = status[k];
          return (
            <label key={k} className="flex items-center gap-2 text-[11px] font-mono cursor-pointer select-none">
              <input
                type="checkbox"
                checked={checked.has(k)}
                disabled={busy}
                onChange={() => setChecked((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; })}
                className="accent-cyan-500 w-3.5 h-3.5"
              />
              <span className="text-slate-500">{d.kind}/</span>
              <span className="text-slate-200 truncate">{d.name}</span>
              <span className="text-[10px] text-slate-500 font-sans">via {d.via.join(', ')}</span>
              {st === 'pending' && <Loader2 className="w-3 h-3 animate-spin text-cyan-400" />}
              {st === 'ok' && <CheckCircle2 className="w-3 h-3 text-emerald-400" />}
              {st === 'error' && <AlertCircle className="w-3 h-3 text-rose-400" />}
            </label>
          );
        })}
      </div>
      <button
        onClick={restart}
        disabled={busy || checked.size === 0}
        className="flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold bg-amber-600 hover:bg-amber-500 text-slate-950 disabled:opacity-40 transition-colors"
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCw className="w-3.5 h-3.5" />}
        Restart {checked.size} selected
      </button>
    </div>
  );
};
