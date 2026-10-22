import React, { useState } from 'react';
import { Cpu, CheckCircle2, AlertCircle, FileCode, Ban, PlayCircle, ArrowDownToLine, Loader2, X } from 'lucide-react';
import { NodeItem } from '../types/k8s';
import { NodeMetric } from '../api/client';
import { NodeDetailModal } from '../components/NodeDetailModal';

type NodeAction = 'cordon' | 'uncordon' | 'drain';

interface NodesViewProps {
  nodes: NodeItem[];
  searchQuery: string;
  nodeMetrics?: Map<string, NodeMetric>;
  metricsAvailable?: boolean;
  onOpenManifest: (kind: string, name: string) => void;
  onNodeAction?: (node: string, action: NodeAction, force?: boolean) => Promise<void>;
}

/** Thin usage bar that turns amber / red as it fills */
const UsageBar: React.FC<{ percent: number | null | undefined; label?: string }> = ({ percent, label }) => {
  if (percent == null) return <span className="text-slate-600">—</span>;
  const color = percent >= 85 ? 'bg-rose-500' : percent >= 65 ? 'bg-amber-400' : 'bg-emerald-400';
  return (
    <div className="flex items-center gap-2 min-w-[120px]" title={label}>
      <div className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
        <div className={`h-full ${color} transition-all duration-500`} style={{ width: `${Math.min(100, percent)}%` }} />
      </div>
      <span className="w-9 text-right text-[11px] text-slate-300">{Math.round(percent)}%</span>
    </div>
  );
};

export const NodesView: React.FC<NodesViewProps> = ({
  nodes,
  searchQuery,
  nodeMetrics,
  metricsAvailable,
  onOpenManifest,
  onNodeAction,
}) => {
  const [selectedNode, setSelectedNode] = useState<NodeItem | null>(null);
  const [busyNode, setBusyNode] = useState<string | null>(null);
  const [drainTarget, setDrainTarget] = useState<string | null>(null);
  const [drainForce, setDrainForce] = useState(false);

  const filteredNodes = nodes.filter((n) => {
    const name = n.metadata.name.toLowerCase();
    const q = searchQuery.toLowerCase();
    return name.includes(q);
  });

  const run = async (node: string, action: NodeAction, force = false) => {
    if (!onNodeAction) return;
    setBusyNode(node);
    try {
      await onNodeAction(node, action, force);
    } finally {
      setBusyNode(null);
    }
  };

  return (
    <div className="h-full flex flex-col overflow-hidden select-text">
      {/* Header */}
      <div className="px-6 py-3 border-b border-slate-800 bg-slate-900/40 flex items-center justify-between text-xs text-slate-400 select-none">
        <div className="flex items-center gap-2 font-medium">
          <Cpu className="w-4 h-4 text-cyan-400" />
          <span className="text-slate-200">Cluster Nodes</span>
          <span className="bg-slate-800 text-slate-400 px-2 py-0.5 rounded font-mono text-[11px]">
            {filteredNodes.length} of {nodes.length}
          </span>
        </div>
        <span className="text-[11px] text-slate-400 flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${metricsAvailable === false ? 'bg-slate-600' : 'bg-cyan-400'}`} />
          {metricsAvailable === false
            ? 'Live usage unavailable (metrics-server not installed)'
            : 'Click any node to view allocatables, conditions, and taints'}
        </span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead className="bg-slate-950/80 text-slate-400 sticky top-0 z-10 border-b border-slate-800 select-none backdrop-blur-sm">
            <tr>
              <th className="py-2.5 px-4 font-semibold">Node Name</th>
              <th className="py-2.5 px-4 font-semibold">Status</th>
              <th className="py-2.5 px-4 font-semibold">Internal IP</th>
              <th className="py-2.5 px-4 font-semibold">Kubelet / OS</th>
              <th className="py-2.5 px-4 font-semibold">CPU (capacity)</th>
              <th className="py-2.5 px-4 font-semibold">CPU usage</th>
              <th className="py-2.5 px-4 font-semibold">Memory (capacity)</th>
              <th className="py-2.5 px-4 font-semibold">Memory usage</th>
              <th className="py-2.5 px-4 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50 font-mono text-slate-300">
            {filteredNodes.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-12 text-center text-slate-500 italic">
                  No nodes found.
                </td>
              </tr>
            ) : (
              filteredNodes.map((node) => {
                const isReady = node.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True');
                const cordoned = !!node.spec?.unschedulable;
                const internalIp = node.status.addresses?.find((a) => a.type === 'InternalIP')?.address || 'N/A';
                const info = node.status.nodeInfo;
                const usage = nodeMetrics?.get(node.metadata.name);
                const busy = busyNode === node.metadata.name;

                return (
                  <tr
                    key={node.metadata.name}
                    onClick={() => setSelectedNode(node)}
                    className="hover:bg-slate-800/60 cursor-pointer transition-colors group"
                    title="Click to view node details"
                  >
                    <td className="py-2.5 px-4 font-medium text-slate-100 flex items-center gap-2">
                      <Cpu className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                      <span className="truncate max-w-sm group-hover:text-cyan-300 transition-colors">
                        {node.metadata.name}
                      </span>
                    </td>
                    <td className="py-2.5 px-4">
                      <div className="flex items-center gap-1.5">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-semibold border flex items-center gap-1 w-max ${
                          isReady
                            ? 'bg-emerald-950 text-emerald-400 border-emerald-800/80'
                            : 'bg-rose-950 text-rose-400 border-rose-800/80'
                        }`}>
                          {isReady ? <CheckCircle2 className="w-2.5 h-2.5" /> : <AlertCircle className="w-2.5 h-2.5" />}
                          {isReady ? 'Ready' : 'NotReady'}
                        </span>
                        {cordoned && (
                          <span className="px-2 py-0.5 rounded text-[10px] font-semibold border bg-amber-950 text-amber-400 border-amber-800/80 w-max" title="Unschedulable: new pods won't be placed here">
                            Cordoned
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 px-4 text-slate-300">{internalIp}</td>
                    <td className="py-2.5 px-4 text-slate-400">
                      <div>{info?.kubeletVersion || 'N/A'}</div>
                      <div className="text-[10px] text-slate-500">{info?.operatingSystem}/{info?.architecture}</div>
                    </td>
                    <td className="py-2.5 px-4 text-cyan-300">{node.status.capacity?.cpu || 'N/A'}</td>
                    <td className="py-2.5 px-4"><UsageBar percent={usage?.cpuPercent} label={usage ? `${usage.cpu} in use` : undefined} /></td>
                    <td className="py-2.5 px-4 text-slate-200">{node.status.capacity?.memory || 'N/A'}</td>
                    <td className="py-2.5 px-4"><UsageBar percent={usage?.memoryPercent} label={usage ? `${usage.memory} in use` : undefined} /></td>
                    <td className="py-2.5 px-4 text-right">
                      <div className="flex items-center justify-end gap-1 font-sans" onClick={(e) => e.stopPropagation()}>
                        {busy ? (
                          <Loader2 className="w-3.5 h-3.5 text-cyan-400 animate-spin mx-1" />
                        ) : onNodeAction && (
                          <>
                            {cordoned ? (
                              <button
                                onClick={() => run(node.metadata.name, 'uncordon')}
                                className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-emerald-300 transition-colors"
                                title="Uncordon (allow scheduling)"
                              >
                                <PlayCircle className="w-3.5 h-3.5" />
                              </button>
                            ) : (
                              <button
                                onClick={() => run(node.metadata.name, 'cordon')}
                                className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-amber-300 transition-colors"
                                title="Cordon (stop scheduling new pods)"
                              >
                                <Ban className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button
                              onClick={() => { setDrainForce(false); setDrainTarget(node.metadata.name); }}
                              className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-rose-300 transition-colors"
                              title="Drain (cordon and evict pods)"
                            >
                              <ArrowDownToLine className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => onOpenManifest('nodes', node.metadata.name)}
                          className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-cyan-300 transition-colors cursor-pointer"
                          title="View YAML Manifest"
                        >
                          <FileCode className="w-3.5 h-3.5" />
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

      <NodeDetailModal
        isOpen={!!selectedNode}
        node={selectedNode}
        onClose={() => setSelectedNode(null)}
        onOpenManifest={onOpenManifest}
      />

      {/* Drain confirmation */}
      {drainTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm" role="dialog">
          <div className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-5 text-sm">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-slate-100 flex items-center gap-2">
                <ArrowDownToLine className="w-4 h-4 text-rose-400" /> Drain node
              </h3>
              <button onClick={() => setDrainTarget(null)} className="text-slate-400 hover:text-slate-200"><X className="w-4 h-4" /></button>
            </div>
            <p className="text-slate-300 text-xs leading-relaxed">
              <span className="font-mono text-cyan-300">{drainTarget}</span> will be cordoned and its pods evicted
              (DaemonSet pods are left in place, emptyDir data is deleted). Workloads are rescheduled on other nodes.
            </p>
            <label className="flex items-start gap-2 mt-4 text-xs text-slate-300 cursor-pointer">
              <input type="checkbox" checked={drainForce} onChange={(e) => setDrainForce(e.target.checked)} className="accent-rose-500 mt-0.5" />
              <span>
                <b>Force</b>: also delete pods that aren't managed by a controller.
                <span className="block text-rose-300/80">These pods are not recreated anywhere.</span>
              </span>
            </label>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setDrainTarget(null)} className="px-3 py-1.5 rounded-md text-xs text-slate-300 hover:bg-slate-800">Cancel</button>
              <button
                onClick={() => {
                  const target = drainTarget;
                  setDrainTarget(null);
                  run(target, 'drain', drainForce);
                }}
                className="px-3 py-1.5 rounded-md text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white"
              >
                Drain node
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
