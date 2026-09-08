import React from 'react';
import { 
  Box, 
  Terminal, 
  FileCode, 
  Trash2, 
  RotateCw, 
  CheckCircle2, 
  AlertCircle, 
  Clock,
  ExternalLink,
  Radio
} from 'lucide-react';
import { PodItem, PortForwardSession } from '../types/k8s';

interface PodsViewProps {
  pods: PodItem[];
  searchQuery: string;
  activePortForwards?: PortForwardSession[];
  onSelectPod: (pod: PodItem) => void;
  onOpenLogs: (pod: string, namespace: string, containers: string[]) => void;
  onOpenManifest: (kind: string, name: string, namespace: string) => void;
  onDelete: (kind: string, name: string, namespace: string) => void;
}

export const PodsView: React.FC<PodsViewProps> = ({
  pods,
  searchQuery,
  activePortForwards = [],
  onSelectPod,
  onOpenLogs,
  onOpenManifest,
  onDelete,
}) => {
  const filteredPods = pods.filter((p) => {
    const name = p.metadata.name.toLowerCase();
    const ns = (p.metadata.namespace || '').toLowerCase();
    const phase = (p.status.phase || '').toLowerCase();
    const q = searchQuery.toLowerCase();
    return name.includes(q) || ns.includes(q) || phase.includes(q);
  });

  const getPhaseBadge = (phase: string) => {
    switch (phase) {
      case 'Running':
        return <span className="bg-emerald-950 text-emerald-400 border border-emerald-800/80 px-2 py-0.5 rounded text-[10px] font-semibold flex items-center gap-1"><CheckCircle2 className="w-2.5 h-2.5" /> Running</span>;
      case 'Pending':
        return <span className="bg-amber-950 text-amber-400 border border-amber-800/80 px-2 py-0.5 rounded text-[10px] font-semibold flex items-center gap-1"><Clock className="w-2.5 h-2.5" /> Pending</span>;
      case 'Succeeded':
        return <span className="bg-blue-950 text-blue-400 border border-blue-800/80 px-2 py-0.5 rounded text-[10px] font-semibold">Completed</span>;
      default:
        return <span className="bg-rose-950 text-rose-400 border border-rose-800/80 px-2 py-0.5 rounded text-[10px] font-semibold flex items-center gap-1"><AlertCircle className="w-2.5 h-2.5" /> {phase}</span>;
    }
  };

  return (
    <div className="h-full flex flex-col overflow-hidden select-text">
      {/* Table Header / Stats Bar */}
      <div className="px-6 py-3 border-b border-slate-800 bg-slate-900/40 flex items-center justify-between text-xs text-slate-400 select-none">
        <div className="flex items-center gap-2 font-medium">
          <Box className="w-4 h-4 text-cyan-400" />
          <span className="text-slate-200">Pods</span>
          <span className="bg-slate-800 text-slate-400 px-2 py-0.5 rounded font-mono text-[11px]">
            {filteredPods.length} of {pods.length}
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
              <th className="py-2.5 px-4 font-semibold">Status</th>
              <th className="py-2.5 px-4 font-semibold">Ready</th>
              <th className="py-2.5 px-4 font-semibold">Restarts</th>
              <th className="py-2.5 px-4 font-semibold">Node</th>
              <th className="py-2.5 px-4 font-semibold">IP</th>
              <th className="py-2.5 px-4 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50 font-mono text-slate-300">
            {filteredPods.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-12 text-center text-slate-500 italic">
                  No pods found matching query.
                </td>
              </tr>
            ) : (
              filteredPods.map((pod) => {
                const containers = pod.spec.containers.map((c) => c.name);
                const readyContainers = pod.status.containerStatuses?.filter((c) => c.ready).length ?? 0;
                const totalContainers = pod.spec.containers.length;
                const totalRestarts = pod.status.containerStatuses?.reduce((acc, c) => acc + c.restartCount, 0) ?? 0;

                const podForwards = activePortForwards.filter(
                  (pf) => pf.pod === pod.metadata.name && pf.namespace === pod.metadata.namespace
                );

                return (
                  <tr 
                    key={pod.metadata.uid || pod.metadata.name} 
                    onClick={() => onSelectPod(pod)}
                    className="hover:bg-slate-800/50 cursor-pointer transition-colors group"
                  >
                    <td className="py-2.5 px-4 font-medium text-slate-100 flex items-center gap-2">
                      <span className="truncate max-w-xs group-hover:text-cyan-300 font-semibold transition-colors" title={pod.metadata.name}>
                        {pod.metadata.name}
                      </span>
                      {podForwards.length > 0 && (
                        <span 
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectPod(pod);
                          }}
                          className="bg-cyan-950/80 text-cyan-300 border border-cyan-500/60 px-1.5 py-0.5 rounded text-[10px] font-mono flex items-center gap-1 animate-pulse"
                          title={`Active Port Forward: ${podForwards[0].url}`}
                        >
                          <Radio className="w-2.5 h-2.5" />
                          <span>:{podForwards[0].localPort}</span>
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-4 text-slate-400">
                      <span className="bg-slate-800/80 text-slate-300 px-2 py-0.5 rounded text-[11px]">
                        {pod.metadata.namespace}
                      </span>
                    </td>
                    <td className="py-2.5 px-4">
                      {getPhaseBadge(pod.status.phase)}
                    </td>
                    <td className="py-2.5 px-4">
                      <span className={`${readyContainers === totalContainers ? 'text-emerald-400' : 'text-amber-400'}`}>
                        {readyContainers}/{totalContainers}
                      </span>
                    </td>
                    <td className="py-2.5 px-4">
                      <span className={totalRestarts > 0 ? 'text-amber-400 font-bold' : 'text-slate-400'}>
                        {totalRestarts}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-slate-400 truncate max-w-[140px]" title={pod.spec.nodeName}>
                      {pod.spec.nodeName || 'N/A'}
                    </td>
                    <td className="py-2.5 px-4 text-slate-400">
                      {pod.status.podIP || 'N/A'}
                    </td>
                    <td className="py-2.5 px-4 text-right">
                      <div className="flex items-center justify-end gap-1 select-none font-sans">
                        {/* Port Forward / Details */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectPod(pod);
                          }}
                          title="View Details & Port Forward"
                          className="p-1 text-slate-400 hover:text-cyan-300 hover:bg-slate-800 rounded transition-colors"
                        >
                          <Radio className="w-3.5 h-3.5" />
                        </button>
                        {/* Logs */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenLogs(pod.metadata.name, pod.metadata.namespace!, containers);
                          }}
                          title="Stream Logs"
                          className="p-1 text-slate-400 hover:text-cyan-300 hover:bg-slate-800 rounded transition-colors"
                        >
                          <Terminal className="w-3.5 h-3.5" />
                        </button>
                        {/* Manifest */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenManifest('pod', pod.metadata.name, pod.metadata.namespace!);
                          }}
                          title="View/Edit Manifest"
                          className="p-1 text-slate-400 hover:text-amber-300 hover:bg-slate-800 rounded transition-colors"
                        >
                          <FileCode className="w-3.5 h-3.5" />
                        </button>
                        {/* Delete */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onDelete('pod', pod.metadata.name, pod.metadata.namespace!);
                          }}
                          title="Delete Pod"
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
