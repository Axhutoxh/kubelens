import React from 'react';
import { 
  Layers, 
  Sliders, 
  RotateCw, 
  FileCode, 
  Trash2, 
  CheckCircle2, 
  AlertCircle 
} from 'lucide-react';
import { DeploymentItem } from '../types/k8s';

interface DeploymentsViewProps {
  deployments: DeploymentItem[];
  searchQuery: string;
  onScale: (deployment: DeploymentItem) => void;
  onRestart: (kind: string, name: string, namespace: string) => void;
  onOpenManifest: (kind: string, name: string, namespace: string) => void;
  onDelete: (kind: string, name: string, namespace: string) => void;
}

export const DeploymentsView: React.FC<DeploymentsViewProps> = ({
  deployments,
  searchQuery,
  onScale,
  onRestart,
  onOpenManifest,
  onDelete,
}) => {
  const filteredDeployments = deployments.filter((d) => {
    const name = d.metadata.name.toLowerCase();
    const ns = (d.metadata.namespace || '').toLowerCase();
    const q = searchQuery.toLowerCase();
    return name.includes(q) || ns.includes(q);
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
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead className="bg-slate-950/80 text-slate-400 sticky top-0 z-10 border-b border-slate-800 select-none backdrop-blur-sm">
            <tr>
              <th className="py-2.5 px-4 font-semibold">Name</th>
              <th className="py-2.5 px-4 font-semibold">Namespace</th>
              <th className="py-2.5 px-4 font-semibold">Pods (Ready / Desired)</th>
              <th className="py-2.5 px-4 font-semibold">Up-to-date</th>
              <th className="py-2.5 px-4 font-semibold">Available</th>
              <th className="py-2.5 px-4 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50 font-mono text-slate-300">
            {filteredDeployments.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-12 text-center text-slate-500 italic">
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
    </div>
  );
};
