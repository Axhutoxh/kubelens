import React, { useState } from 'react';
import { Cpu, CheckCircle2, AlertCircle, HardDrive, FileCode } from 'lucide-react';
import { NodeItem } from '../types/k8s';
import { NodeDetailModal } from '../components/NodeDetailModal';

interface NodesViewProps {
  nodes: NodeItem[];
  searchQuery: string;
  onOpenManifest: (kind: string, name: string) => void;
}

export const NodesView: React.FC<NodesViewProps> = ({
  nodes,
  searchQuery,
  onOpenManifest,
}) => {
  const [selectedNode, setSelectedNode] = useState<NodeItem | null>(null);

  const filteredNodes = nodes.filter((n) => {
    const name = n.metadata.name.toLowerCase();
    const q = searchQuery.toLowerCase();
    return name.includes(q);
  });

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
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
          Click any node to view CPU/Memory allocatables, conditions, and taints
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
              <th className="py-2.5 px-4 font-semibold">Kubelet Version</th>
              <th className="py-2.5 px-4 font-semibold">OS / Arch</th>
              <th className="py-2.5 px-4 font-semibold">CPU</th>
              <th className="py-2.5 px-4 font-semibold">Memory</th>
              <th className="py-2.5 px-4 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50 font-mono text-slate-300">
            {filteredNodes.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-12 text-center text-slate-500 italic">
                  No nodes found.
                </td>
              </tr>
            ) : (
              filteredNodes.map((node) => {
                const isReady = node.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True');
                const internalIp = node.status.addresses?.find((a) => a.type === 'InternalIP')?.address || 'N/A';
                const info = node.status.nodeInfo;

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
                      <span className={`px-2 py-0.5 rounded text-[10px] font-semibold border flex items-center gap-1 w-max ${
                        isReady 
                          ? 'bg-emerald-950 text-emerald-400 border-emerald-800/80' 
                          : 'bg-rose-950 text-rose-400 border-rose-800/80'
                      }`}>
                        {isReady ? <CheckCircle2 className="w-2.5 h-2.5" /> : <AlertCircle className="w-2.5 h-2.5" />}
                        {isReady ? 'Ready' : 'NotReady'}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-slate-300">{internalIp}</td>
                    <td className="py-2.5 px-4 text-slate-400">{info?.kubeletVersion || 'N/A'}</td>
                    <td className="py-2.5 px-4 text-slate-400">{info?.operatingSystem}/{info?.architecture}</td>
                    <td className="py-2.5 px-4 text-cyan-300">{node.status.capacity?.cpu || 'N/A'}</td>
                    <td className="py-2.5 px-4 text-slate-200">{node.status.capacity?.memory || 'N/A'}</td>
                    <td className="py-2.5 px-4 text-right">
                      <div className="flex items-center justify-end gap-1 font-sans">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenManifest('nodes', node.metadata.name);
                          }}
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
    </div>
  );
};
