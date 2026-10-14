import React from 'react';
import { 
  Layers, 
  RotateCw, 
  FileCode, 
  Trash2, 
  CheckCircle2, 
  AlertCircle,
  Tag,
  Cpu
} from 'lucide-react';
import { DaemonSetItem } from '../types/k8s';
import { parseImage } from './DeploymentsView';

interface DaemonSetsViewProps {
  daemonSets: DaemonSetItem[];
  searchQuery: string;
  onRestart: (kind: string, name: string, namespace: string) => void;
  onOpenManifest: (kind: string, name: string, namespace: string) => void;
  onDelete: (kind: string, name: string, namespace: string) => void;
}

export const DaemonSetsView: React.FC<DaemonSetsViewProps> = ({
  daemonSets,
  searchQuery,
  onRestart,
  onOpenManifest,
  onDelete,
}) => {
  const filtered = daemonSets.filter((d) => {
    const name = d.metadata.name.toLowerCase();
    const ns = (d.metadata.namespace || '').toLowerCase();
    const q = searchQuery.toLowerCase();

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
          <span className="text-slate-200">DaemonSets</span>
          <span className="bg-slate-800 text-slate-400 px-2 py-0.5 rounded font-mono text-[11px]">
            {filtered.length} of {daemonSets.length}
          </span>
        </div>
        <span className="text-[11px] text-slate-400 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
          Ensures a copy of a pod runs across selected or all cluster nodes
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
              <th className="py-2.5 px-4 font-semibold">Node Selector</th>
              <th className="py-2.5 px-4 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50 font-mono text-slate-300">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-12 text-center text-slate-500 italic">
                  No DaemonSets found.
                </td>
              </tr>
            ) : (
              filtered.map((ds) => {
                const desired = ds.status.desiredNumberScheduled ?? 0;
                const ready = ds.status.numberReady ?? 0;
                const updated = ds.status.updatedNumberScheduled ?? 0;
                const available = ds.status.numberAvailable ?? 0;
                const isHealthy = ready === desired && desired > 0;
                const containers = ds.spec?.template?.spec?.containers || [];
                const nodeSelector = ds.spec?.template?.spec?.nodeSelector;
                const selectorText = nodeSelector 
                  ? Object.entries(nodeSelector).map(([k, v]) => `${k}=${v}`).join(', ')
                  : 'All Nodes';

                return (
                  <tr key={ds.metadata.uid || ds.metadata.name} className="hover:bg-slate-800/40 transition-colors">
                    <td className="py-2.5 px-4 font-medium text-slate-100 flex items-center gap-2">
                      <Layers className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                      <span className="truncate max-w-xs">{ds.metadata.name}</span>
                    </td>
                    <td className="py-2.5 px-4 text-slate-400">
                      <span className="bg-slate-800/80 text-slate-300 px-2 py-0.5 rounded text-[11px]">
                        {ds.metadata.namespace}
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
                    <td className="py-2.5 px-4 text-slate-300">{updated}</td>
                    <td className="py-2.5 px-4 text-slate-300">{available}</td>
                    <td className="py-2.5 px-4 text-slate-400 font-sans text-[11px] truncate max-w-[150px]" title={selectorText}>
                      <span className="flex items-center gap-1">
                        <Cpu className="w-3 h-3 text-slate-500" />
                        <span>{selectorText}</span>
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-right">
                      <div className="flex items-center justify-end gap-1 font-sans">
                        <button
                          onClick={() => onRestart('daemonset', ds.metadata.name, ds.metadata.namespace || 'default')}
                          className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-amber-300 transition-colors cursor-pointer"
                          title="Rollout Restart"
                        >
                          <RotateCw className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => onOpenManifest('daemonsets', ds.metadata.name, ds.metadata.namespace || 'default')}
                          className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-cyan-300 transition-colors cursor-pointer"
                          title="View YAML Manifest"
                        >
                          <FileCode className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => onDelete('daemonset', ds.metadata.name, ds.metadata.namespace || 'default')}
                          className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-rose-400 transition-colors cursor-pointer"
                          title="Delete DaemonSet"
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
