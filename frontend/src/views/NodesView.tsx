import React from 'react';
import { Cpu, CheckCircle2, AlertCircle, HardDrive } from 'lucide-react';
import { NodeItem } from '../types/k8s';

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
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50 font-mono text-slate-300">
            {filteredNodes.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-12 text-center text-slate-500 italic">
                  No nodes found.
                </td>
              </tr>
            ) : (
              filteredNodes.map((node) => {
                const isReady = node.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True');
                const internalIp = node.status.addresses?.find((a) => a.type === 'InternalIP')?.address || 'N/A';
                const info = node.status.nodeInfo;

                return (
                  <tr key={node.metadata.name} className="hover:bg-slate-800/40 transition-colors">
                    <td className="py-2.5 px-4 font-medium text-slate-100 flex items-center gap-2">
                      <span className="truncate max-w-sm">{node.metadata.name}</span>
                    </td>
                    <td className="py-2.5 px-4">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-semibold flex items-center gap-1 w-max ${
                        isReady ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/80' : 'bg-rose-950 text-rose-400 border border-rose-800/80'
                      }`}>
                        {isReady ? <CheckCircle2 className="w-2.5 h-2.5" /> : <AlertCircle className="w-2.5 h-2.5" />}
                        {isReady ? 'Ready' : 'NotReady'}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-slate-300">{internalIp}</td>
                    <td className="py-2.5 px-4 text-slate-400">{info?.kubeletVersion || 'N/A'}</td>
                    <td className="py-2.5 px-4 text-slate-400">{info?.operatingSystem}/{info?.architecture}</td>
                    <td className="py-2.5 px-4 text-slate-200">{node.status.capacity?.cpu || 'N/A'}</td>
                    <td className="py-2.5 px-4 text-slate-200">{node.status.capacity?.memory || 'N/A'}</td>
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
