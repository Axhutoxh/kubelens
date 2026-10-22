import React, { useMemo, useState } from 'react';
import { 
  Layers, 
  Sliders, 
  RotateCw, 
  FileCode, 
  Trash2, 
  CheckCircle2, 
  AlertCircle,
  Tag,
  History,
  Rows3
} from 'lucide-react';
import { DeploymentItem } from '../types/k8s';
import { PodMetric } from '../api/client';
import { RolloutHistoryModal } from '../components/RolloutHistoryModal';
import { ColumnDef, ColumnPicker, useColumnVisibility } from '../components/ColumnPicker';

const DEPLOYMENT_COLUMNS: ColumnDef[] = [
  { id: 'name', label: 'Name', locked: true },
  { id: 'namespace', label: 'Namespace' },
  { id: 'image', label: 'Image Tag' },
  { id: 'status', label: 'Status' },
  { id: 'ready', label: 'Ready' },
  { id: 'cpu', label: 'CPU' },
  { id: 'memory', label: 'Memory' },
  { id: 'uptodate', label: 'Up-to-date' },
  { id: 'available', label: 'Available' },
  { id: 'actions', label: 'Actions', locked: true },
];
const DEPLOYMENT_DEFAULT_COLUMNS = ['name', 'image', 'status', 'ready', 'cpu', 'memory', 'actions'];

// Kubernetes builds pod-template hashes and pod suffixes from this alphabet (no vowels),
// which lets us attribute "<deployment>-<hash>-<suffix>" pods without false matches.
const SAFE_CHARS = /^[bcdfghjklmnpqrstvwxz2456789]+$/;

/** Maps a ReplicaSet-managed pod name back to its deployment name, or null. */
function deploymentOfPod(podName: string): string | null {
  const parts = podName.split('-');
  if (parts.length < 3) return null;
  const suffix = parts[parts.length - 1];
  const hash = parts[parts.length - 2];
  if (suffix.length !== 5 || !SAFE_CHARS.test(suffix)) return null;
  if (hash.length < 6 || hash.length > 10 || !SAFE_CHARS.test(hash)) return null;
  return parts.slice(0, -2).join('-');
}

function cpuMillis(q: string): number {
  if (q.endsWith('n')) return parseFloat(q) / 1e6;
  if (q.endsWith('u')) return parseFloat(q) / 1e3;
  if (q.endsWith('m')) return parseFloat(q);
  return parseFloat(q) * 1000;
}

function memoryMi(q: string): number {
  const units: Record<string, number> = { Ki: 1 / 1024, Mi: 1, Gi: 1024, Ti: 1024 * 1024, K: 1000 / 1048576, M: 1e6 / 1048576, G: 1e9 / 1048576 };
  const m = /^([\d.]+)([A-Za-z]*)$/.exec(q);
  if (!m) return 0;
  return parseFloat(m[1]) * (units[m[2]] ?? 1 / 1048576);
}

const formatCpu = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} cores` : `${Math.round(m)}m`);
const formatMemory = (mi: number) => (mi >= 1024 ? `${(mi / 1024).toFixed(2)}Gi` : `${Math.round(mi)}Mi`);

type Tone = 'emerald' | 'amber' | 'rose' | 'slate';
const TONE_CLASSES: Record<Tone, string> = {
  emerald: 'bg-emerald-950 text-emerald-400 border-emerald-800/80',
  amber: 'bg-amber-950 text-amber-400 border-amber-800/80',
  rose: 'bg-rose-950 text-rose-400 border-rose-800/80',
  slate: 'bg-slate-800 text-slate-400 border-slate-700',
};

/** Summarises rollout state the way `kubectl rollout status` would read it. */
function deploymentStatus(dep: DeploymentItem): { label: string; tone: Tone; hint?: string } {
  const desired = dep.spec.replicas ?? 0;
  const ready = dep.status.readyReplicas ?? 0;
  const updated = dep.status.updatedReplicas ?? 0;
  const available = dep.status.availableReplicas ?? 0;
  const conditions: Array<{ type: string; status: string; reason?: string; message?: string }> = (dep.status as any).conditions || [];
  const stalled = conditions.find((c) => c.type === 'Progressing' && c.status === 'False');
  const failure = conditions.find((c) => c.type === 'ReplicaFailure' && c.status === 'True');

  if (desired === 0) return { label: 'Scaled to 0', tone: 'slate' };
  if (failure) return { label: 'Failed', tone: 'rose', hint: failure.message };
  if (stalled) return { label: 'Stalled', tone: 'rose', hint: stalled.message || stalled.reason };
  if (ready === desired && updated === desired && available >= desired) return { label: 'Running', tone: 'emerald' };
  if (ready === 0 && available === 0) return { label: 'Unavailable', tone: 'rose' };
  return { label: 'Progressing', tone: 'amber', hint: `${updated}/${desired} updated, ${available} available` };
}

interface DeploymentsViewProps {
  deployments: DeploymentItem[];
  searchQuery: string;
  onScale: (deployment: DeploymentItem) => void;
  onRestart: (kind: string, name: string, namespace: string) => void;
  onOpenManifest: (kind: string, name: string, namespace: string) => void;
  onDelete: (kind: string, name: string, namespace: string) => void;
  /** Combined logs from every pod of the deployment (via its label selector) */
  onOpenAllLogs?: (dep: DeploymentItem) => void;
  onRefresh?: () => void;
  onToast?: (message: string, type?: 'success' | 'error') => void;
  /** Pod usage keyed by `${namespace}/${name}`; summed per deployment */
  podMetrics?: Map<string, PodMetric>;
  metricsAvailable?: boolean;
}

export function parseImage(imageStr?: string) {
  if (!imageStr) return { fullName: '', name: 'unknown', tag: 'latest' };

  const fullName = imageStr.trim();

  // Digest format: image@sha256:...
  if (fullName.includes('@')) {
    const [repoPart, digestPart] = fullName.split('@');
    const name = repoPart.split('/').pop() || repoPart;
    const shortDigest = digestPart.startsWith('sha256:')
      ? digestPart.slice(0, 15) + '…'
      : digestPart.slice(0, 12);
    return { fullName, name, tag: shortDigest };
  }

  // Handle image:tag (watch out for host:port/path/image:tag)
  const lastColon = fullName.lastIndexOf(':');
  const lastSlash = fullName.lastIndexOf('/');

  if (lastColon > lastSlash) {
    const repoPart = fullName.slice(0, lastColon);
    const tag = fullName.slice(lastColon + 1);
    const name = repoPart.split('/').pop() || repoPart;
    return { fullName, name, tag: tag || 'latest' };
  }

  const name = fullName.split('/').pop() || fullName;
  return { fullName, name, tag: 'latest' };
}

export const DeploymentsView: React.FC<DeploymentsViewProps> = ({
  deployments,
  searchQuery,
  onScale,
  onRestart,
  onOpenManifest,
  onDelete,
  onOpenAllLogs,
  onRefresh,
  onToast,
  podMetrics,
  metricsAvailable,
}) => {
  const [historyFor, setHistoryFor] = useState<DeploymentItem | null>(null);
  const cols = useColumnVisibility('deployments', DEPLOYMENT_COLUMNS, DEPLOYMENT_DEFAULT_COLUMNS);

  // Sum pod usage per deployment once per metrics refresh (O(pods), not O(pods × deployments))
  const usageByDeployment = useMemo(() => {
    const totals = new Map<string, { cpu: number; memory: number; pods: number }>();
    podMetrics?.forEach((m) => {
      const dep = deploymentOfPod(m.name);
      if (!dep) return;
      const key = `${m.namespace}/${dep}`;
      const t = totals.get(key) || { cpu: 0, memory: 0, pods: 0 };
      t.cpu += cpuMillis(m.cpu);
      t.memory += memoryMi(m.memory);
      t.pods += 1;
      totals.set(key, t);
    });
    return totals;
  }, [podMetrics]);
  const filteredDeployments = deployments.filter((d) => {
    const name = d.metadata.name.toLowerCase();
    const ns = (d.metadata.namespace || '').toLowerCase();
    const q = searchQuery.toLowerCase();

    // Match image and tag name
    const containers = d.spec?.template?.spec?.containers || [];
    const matchesImage = containers.some((c) => {
      const img = (c.image || '').toLowerCase();
      const parsed = parseImage(c.image);
      return (
        img.includes(q) ||
        parsed.tag.toLowerCase().includes(q) ||
        parsed.name.toLowerCase().includes(q)
      );
    });

    return name.includes(q) || ns.includes(q) || matchesImage;
  });

  return (
    <div className="h-full flex flex-col overflow-hidden select-text">
      {/* Header */}
      <div className="px-6 py-3 border-b border-slate-800 bg-slate-900/40 flex items-center justify-between text-xs text-slate-400 select-none">
        <div className="flex items-center gap-2 font-medium">
          <Layers className="w-4 h-4 text-cyan-400" />
          <span className="text-slate-200">Deployments</span>
          <span className="bg-slate-800 text-slate-400 px-2 py-0.5 rounded font-mono text-[11px]">
            {filteredDeployments.length} of {deployments.length}
          </span>
        </div>
        <ColumnPicker
          columns={DEPLOYMENT_COLUMNS}
          visible={cols.visible}
          onToggle={cols.toggle}
          onReset={cols.reset}
          isDefault={cols.isDefault}
        />
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead className="bg-slate-950/80 text-slate-400 sticky top-0 z-10 border-b border-slate-800 select-none backdrop-blur-sm">
            <tr>
              <th className="py-2.5 px-4 font-semibold">Name</th>
              {cols.show('namespace') && <th className="py-2.5 px-4 font-semibold">Namespace</th>}
              {cols.show('image') && <th className="py-2.5 px-4 font-semibold">Image Tag</th>}
              {cols.show('status') && <th className="py-2.5 px-4 font-semibold">Status</th>}
              {cols.show('ready') && <th className="py-2.5 px-4 font-semibold" title="Ready / desired pods">Ready</th>}
              {cols.show('cpu') && (
                <th className="py-2.5 px-4 font-semibold" title={metricsAvailable === false ? 'Live usage needs metrics-server in the cluster' : 'Total CPU of all pods'}>CPU</th>
              )}
              {cols.show('memory') && (
                <th className="py-2.5 px-4 font-semibold" title={metricsAvailable === false ? 'Live usage needs metrics-server in the cluster' : 'Total memory of all pods'}>Memory</th>
              )}
              {cols.show('uptodate') && <th className="py-2.5 px-4 font-semibold">Up-to-date</th>}
              {cols.show('available') && <th className="py-2.5 px-4 font-semibold">Available</th>}
              <th className="py-2.5 px-4 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50 font-mono text-slate-300">
            {filteredDeployments.length === 0 ? (
              <tr>
                <td colSpan={cols.visible.size} className="py-12 text-center text-slate-500 italic">
                  No deployments found.
                </td>
              </tr>
            ) : (
              filteredDeployments.map((dep) => {
                const desired = dep.spec.replicas ?? 0;
                const ready = dep.status.readyReplicas ?? 0;
                const updated = dep.status.updatedReplicas ?? 0;
                const available = dep.status.availableReplicas ?? 0;
                const isHealthy = ready === desired && desired > 0;
                const containers = dep.spec?.template?.spec?.containers || [];
                const status = deploymentStatus(dep);
                const usage = usageByDeployment.get(`${dep.metadata.namespace}/${dep.metadata.name}`);

                return (
                  <tr key={dep.metadata.uid || dep.metadata.name} className="hover:bg-slate-800/40 transition-colors">
                    <td className="py-2.5 px-4 font-medium text-slate-100 flex items-center gap-2">
                      <span className="truncate max-w-xs" title={`${dep.metadata.namespace}/${dep.metadata.name}`}>{dep.metadata.name}</span>
                    </td>
                    {cols.show('namespace') && (
                      <td className="py-2.5 px-4 text-slate-400">
                        <span className="bg-slate-800/80 text-slate-300 px-2 py-0.5 rounded text-[11px]">
                          {dep.metadata.namespace}
                        </span>
                      </td>
                    )}
                    {/* Images & Tags Column */}
                    {cols.show('image') && <td className="py-2.5 px-4">
                      {containers.length === 0 ? (
                        <span className="text-slate-500 italic text-[11px]">No containers</span>
                      ) : (
                        <div className="space-y-1 max-w-sm py-0.5">
                          {containers.map((c, idx) => {
                            const { fullName, name: imgName, tag } = parseImage(c.image);
                            return (
                              <div 
                                key={idx} 
                                className="flex items-center gap-1.5 text-[11px] leading-tight" 
                                title={`Container: ${c.name || 'default'} | Full Image: ${fullName}`}
                              >
                                {containers.length > 1 && (
                                  <span className="text-slate-400 text-[10px] font-mono shrink-0 truncate max-w-[90px]" title={`${c.name}: ${imgName}`}>
                                    {c.name}:
                                  </span>
                                )}
                                <span
                                  className="bg-indigo-950/90 text-indigo-300 border border-indigo-700/70 px-1.5 py-0.2 rounded font-mono text-[10px] font-bold shrink-0 flex items-center gap-0.5 shadow-sm"
                                  title={`${fullName}`}
                                >
                                  <Tag className="w-2.5 h-2.5 text-indigo-400 shrink-0" />
                                  <span className="truncate max-w-[120px]">{tag}</span>
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </td>}
                    {cols.show('status') && (
                      <td className="py-2.5 px-4">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-semibold border whitespace-nowrap ${TONE_CLASSES[status.tone]}`}
                          title={status.hint}
                        >
                          {status.label}
                        </span>
                      </td>
                    )}
                    {cols.show('ready') && (
                      <td className="py-2.5 px-4">
                        <span className={`px-2 py-0.5 rounded text-[11px] font-bold whitespace-nowrap ${
                          isHealthy ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/80' : 'bg-amber-950 text-amber-400 border border-amber-800/80'
                        }`}>
                          {ready} / {desired}
                        </span>
                      </td>
                    )}
                    {cols.show('cpu') && (
                      <td className="py-2.5 px-4 text-sky-300 whitespace-nowrap" title={usage ? `${usage.pods} pods` : undefined}>
                        {usage ? formatCpu(usage.cpu) : <span className="text-slate-600">—</span>}
                      </td>
                    )}
                    {cols.show('memory') && (
                      <td className="py-2.5 px-4 text-violet-300 whitespace-nowrap" title={usage ? `${usage.pods} pods` : undefined}>
                        {usage ? formatMemory(usage.memory) : <span className="text-slate-600">—</span>}
                      </td>
                    )}
                    {cols.show('uptodate') && <td className="py-2.5 px-4 text-slate-300">{updated}</td>}
                    {cols.show('available') && <td className="py-2.5 px-4 text-slate-300">{available}</td>}
                    <td className="py-2.5 px-4 text-right">
                      <div className="flex items-center justify-end gap-1 select-none font-sans">
                        {/* Scale */}
                        <button
                          onClick={() => onScale(dep)}
                          title="Scale Replicas"
                          className="p-1 text-slate-400 hover:text-cyan-300 hover:bg-slate-800 rounded transition-colors"
                        >
                          <Sliders className="w-3.5 h-3.5" />
                        </button>
                        {/* Rollout Restart */}
                        <button
                          onClick={() => onRestart('deployment', dep.metadata.name, dep.metadata.namespace!)}
                          title="Rolling Restart"
                          className="p-1 text-slate-400 hover:text-blue-300 hover:bg-slate-800 rounded transition-colors"
                        >
                          <RotateCw className="w-3.5 h-3.5" />
                        </button>
                        {/* Rollout history / rollback */}
                        <button
                          onClick={() => setHistoryFor(dep)}
                          title="Rollout History & Rollback"
                          className="p-1 text-slate-400 hover:text-amber-300 hover:bg-slate-800 rounded transition-colors"
                        >
                          <History className="w-3.5 h-3.5" />
                        </button>
                        {/* Combined logs of all pods */}
                        {onOpenAllLogs && (
                          <button
                            onClick={() => onOpenAllLogs(dep)}
                            title="Logs from all pods"
                            className="p-1 text-slate-400 hover:text-violet-300 hover:bg-slate-800 rounded transition-colors"
                          >
                            <Rows3 className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {/* Manifest */}
                        <button
                          onClick={() => onOpenManifest('deployment', dep.metadata.name, dep.metadata.namespace!)}
                          title="View/Edit Manifest"
                          className="p-1 text-slate-400 hover:text-amber-300 hover:bg-slate-800 rounded transition-colors"
                        >
                          <FileCode className="w-3.5 h-3.5" />
                        </button>
                        {/* Delete */}
                        <button
                          onClick={() => onDelete('deployment', dep.metadata.name, dep.metadata.namespace!)}
                          title="Delete Deployment"
                          className="p-1 text-slate-400 hover:text-rose-400 hover:bg-slate-800 rounded transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {historyFor && (
        <RolloutHistoryModal
          deployment={historyFor}
          onClose={() => setHistoryFor(null)}
          onRolledBack={() => onRefresh?.()}
          onToast={(m, t) => onToast?.(m, t)}
        />
      )}
    </div>
  );
};
