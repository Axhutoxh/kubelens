import React, { useState } from 'react';
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
import { RolloutHistoryModal } from '../components/RolloutHistoryModal';

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
}) => {
  const [historyFor, setHistoryFor] = useState<DeploymentItem | null>(null);
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
        <span className="text-[11px] text-slate-400 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
          Displays container images & active image tag versions
        </span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead className="bg-slate-950/80 text-slate-400 sticky top-0 z-10 border-b border-slate-800 select-none backdrop-blur-sm">
            <tr>
              <th className="py-2.5 px-4 font-semibold">Name</th>
              <th className="py-2.5 px-4 font-semibold">Namespace</th>
              <th className="py-2.5 px-4 font-semibold">Images & Tags</th>
              <th className="py-2.5 px-4 font-semibold">Pods (Ready / Desired)</th>
              <th className="py-2.5 px-4 font-semibold">Up-to-date</th>
              <th className="py-2.5 px-4 font-semibold">Available</th>
              <th className="py-2.5 px-4 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50 font-mono text-slate-300">
            {filteredDeployments.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-12 text-center text-slate-500 italic">
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

                return (
                  <tr key={dep.metadata.uid || dep.metadata.name} className="hover:bg-slate-800/40 transition-colors">
                    <td className="py-2.5 px-4 font-medium text-slate-100 flex items-center gap-2">
                      <span className="truncate max-w-xs">{dep.metadata.name}</span>
                    </td>
                    <td className="py-2.5 px-4 text-slate-400">
                      <span className="bg-slate-800/80 text-slate-300 px-2 py-0.5 rounded text-[11px]">
                        {dep.metadata.namespace}
                      </span>
                    </td>
                    {/* Images & Tags Column */}
                    <td className="py-2.5 px-4">
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
                                  <span className="text-slate-400 text-[10px] font-mono shrink-0">
                                    {c.name}:
                                  </span>
                                )}
                                <span className="text-slate-200 truncate font-mono font-medium max-w-[130px]" title={fullName}>
                                  {imgName}
                                </span>
                                <span 
                                  className="bg-indigo-950/90 text-indigo-300 border border-indigo-700/70 px-1.5 py-0.2 rounded font-mono text-[10px] font-bold shrink-0 flex items-center gap-0.5 shadow-sm"
                                  title={`Tag: ${tag}`}
                                >
                                  <Tag className="w-2.5 h-2.5 text-indigo-400 shrink-0" />
                                  <span className="truncate max-w-[120px]">{tag}</span>
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </td>
                    <td className="py-2.5 px-4">
                      <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                        isHealthy ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/80' : 'bg-amber-950 text-amber-400 border border-amber-800/80'
                      }`}>
                        {ready} / {desired}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-slate-300">{updated}</td>
                    <td className="py-2.5 px-4 text-slate-300">{available}</td>
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
