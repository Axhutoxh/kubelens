import React from 'react';
import { 
  Server, 
  Sliders, 
  RotateCw, 
  FileCode, 
  Trash2, 
  CheckCircle2, 
  AlertCircle,
  Tag
} from 'lucide-react';
import { StatefulSetItem } from '../types/k8s';
import { parseImage } from './DeploymentsView';

interface StatefulSetsViewProps {
  statefulSets: StatefulSetItem[];
  searchQuery: string;
  onScale: (item: { kind: string; name: string; namespace: string; currentReplicas: number }) => void;
  onRestart: (kind: string, name: string, namespace: string) => void;
  onOpenManifest: (kind: string, name: string, namespace: string) => void;
  onDelete: (kind: string, name: string, namespace: string) => void;
}

export const StatefulSetsView: React.FC<StatefulSetsViewProps> = ({
  statefulSets,
  searchQuery,
  onScale,
  onRestart,
  onOpenManifest,
  onDelete,
}) => {
  const filtered = statefulSets.filter((s) => {
    const name = s.metadata.name.toLowerCase();
    const ns = (s.metadata.namespace || '').toLowerCase();
    const q = searchQuery.toLowerCase();

    const containers = s.spec?.template?.spec?.containers || [];
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
          <Server className="w-4 h-4 text-cyan-400" />
          <span className="text-slate-200">StatefulSets</span>
          <span className="bg-slate-800 text-slate-400 px-2 py-0.5 rounded font-mono text-[11px]">
            {filtered.length} of {statefulSets.length}
          </span>
        </div>
        <span className="text-[11px] text-slate-400 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          Stateful workloads with stable network identities & persistent storage
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
              <th className="py-2.5 px-4 font-semibold">Service Name</th>
              <th className="py-2.5 px-4 font-semibold">Age</th>
              <th className="py-2.5 px-4 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50 font-mono text-slate-300">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-12 text-center text-slate-500 italic">
                  No StatefulSets found.
                </td>
              </tr>
            ) : (
              filtered.map((sts) => {
                const desired = sts.spec.replicas ?? 0;
                const ready = sts.status.readyReplicas ?? 0;
                const isHealthy = ready === desired && desired > 0;
                const containers = sts.spec?.template?.spec?.containers || [];
                const age = sts.metadata.creationTimestamp 
                  ? new Date(sts.metadata.creationTimestamp).toLocaleDateString()
                  : 'N/A';

                return (
                  <tr key={sts.metadata.uid || sts.metadata.name} className="hover:bg-slate-800/40 transition-colors">
                    <td className="py-2.5 px-4 font-medium text-slate-100 flex items-center gap-2">
                      <Server className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                      <span className="truncate max-w-xs">{sts.metadata.name}</span>
                    </td>
                    <td className="py-2.5 px-4 text-slate-400">
                      <span className="bg-slate-800/80 text-slate-300 px-2 py-0.5 rounded text-[11px]">
                        {sts.metadata.namespace}
                      </span>
                    </td>
                    <td className="py-2.5 px-4">
                      {containers.length === 0 ? (
                        <span className="text-slate-600">-</span>
                      ) : (
                        <div className="flex flex-col gap-1">
                          {containers.slice(0, 2).map((c, idx) => {
                            const parsed = parseImage(c.image);
                            return (
                              <div key={idx} className="flex items-center gap-1.5 flex-wrap">
                                <span className="text-slate-300 truncate max-w-[130px] font-sans text-[11px]" title={c.image}>
                                  {parsed.name}
                                </span>
                                <span className="bg-slate-800 text-cyan-300 border border-slate-700/60 px-1.5 py-0.2 rounded text-[10px] flex items-center gap-0.5">
                                  <Tag className="w-2.5 h-2.5 text-cyan-400" />
                                  <span>{parsed.tag}</span>
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </td>
                    <td className="py-2.5 px-4">
                      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-semibold border ${
                        isHealthy
                          ? 'bg-emerald-950/80 text-emerald-400 border-emerald-800/80'
                          : 'bg-amber-950/80 text-amber-400 border-amber-800/80'
                      }`}>
                        {isHealthy ? (
                          <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                        ) : (
                          <AlertCircle className="w-3 h-3 text-amber-400" />
                        )}
                        <span>{ready} / {desired}</span>
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-slate-400">{sts.spec.serviceName || '-'}</td>
                    <td className="py-2.5 px-4 text-slate-400">{age}</td>
                    <td className="py-2.5 px-4 text-right">
                      <div className="flex items-center justify-end gap-1 font-sans">
                        <button
                          onClick={() => onScale({
                            kind: 'statefulset',
                            name: sts.metadata.name,
                            namespace: sts.metadata.namespace || 'default',
                            currentReplicas: desired,
                          })}
                          className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-cyan-300 transition-colors cursor-pointer"
                          title="Scale Replicas"
                        >
                          <Sliders className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => onRestart('statefulset', sts.metadata.name, sts.metadata.namespace || 'default')}
                          className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-amber-300 transition-colors cursor-pointer"
                          title="Rollout Restart"
                        >
                          <RotateCw className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => onOpenManifest('statefulsets', sts.metadata.name, sts.metadata.namespace || 'default')}
                          className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-cyan-300 transition-colors cursor-pointer"
                          title="View YAML Manifest"
                        >
                          <FileCode className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => onDelete('statefulset', sts.metadata.name, sts.metadata.namespace || 'default')}
                          className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-rose-400 transition-colors cursor-pointer"
                          title="Delete StatefulSet"
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
