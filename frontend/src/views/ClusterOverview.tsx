import React from 'react';
import { 
  Server, 
  Box, 
  Layers, 
  CheckCircle2, 
  AlertTriangle, 
  Cpu, 
  HardDrive,
  FolderTree
} from 'lucide-react';
import { ClusterOverviewData, PodItem, NodeItem, EventItem } from '../types/k8s';

interface ClusterOverviewProps {
  overview: ClusterOverviewData | null;
  pods: PodItem[];
  nodes: NodeItem[];
  events: EventItem[];
  onNavigate: (view: string) => void;
}

export const ClusterOverview: React.FC<ClusterOverviewProps> = ({
  overview,
  pods,
  nodes,
  events,
  onNavigate,
}) => {
  // Pod Status Stats
  const runningPods = pods.filter((p) => p.status.phase === 'Running').length;
  const pendingPods = pods.filter((p) => p.status.phase === 'Pending').length;
  const failedPods = pods.filter((p) => p.status.phase === 'Failed' || p.status.phase === 'Unknown').length;
  const completedPods = pods.filter((p) => p.status.phase === 'Succeeded').length;

  const recentWarnings = events.filter((e) => e.type === 'Warning').slice(0, 5);

  return (
    <div className="p-6 space-y-6 overflow-y-auto h-full">
      {/* Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Nodes Card */}
        <div 
          onClick={() => onNavigate('nodes')}
          className="bg-slate-900 border border-slate-800 hover:border-cyan-500/50 rounded-xl p-4 transition-all cursor-pointer shadow-sm group"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400">Total Nodes</span>
            <div className="p-2 bg-cyan-950/80 text-cyan-400 rounded-lg group-hover:scale-110 transition-transform">
              <Server className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-slate-100 font-mono">
              {overview?.nodesCount ?? nodes.length}
            </span>
            <span className="text-xs text-emerald-400 flex items-center gap-0.5">
              <CheckCircle2 className="w-3 h-3" /> Ready
            </span>
          </div>
        </div>

        {/* Pods Card */}
        <div 
          onClick={() => onNavigate('pods')}
          className="bg-slate-900 border border-slate-800 hover:border-cyan-500/50 rounded-xl p-4 transition-all cursor-pointer shadow-sm group"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400">Total Pods</span>
            <div className="p-2 bg-blue-950/80 text-blue-400 rounded-lg group-hover:scale-110 transition-transform">
              <Box className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-slate-100 font-mono">
              {overview?.podsCount ?? pods.length}
            </span>
            <span className="text-xs text-slate-400">
              ({runningPods} running)
            </span>
          </div>
        </div>

        {/* Namespaces Card */}
        <div 
          onClick={() => onNavigate('namespaces')}
          className="bg-slate-900 border border-slate-800 hover:border-cyan-500/50 rounded-xl p-4 transition-all cursor-pointer shadow-sm group"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400">Namespaces</span>
            <div className="p-2 bg-purple-950/80 text-purple-400 rounded-lg group-hover:scale-110 transition-transform">
              <FolderTree className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-slate-100 font-mono">
              {overview?.namespacesCount ?? 0}
            </span>
            <span className="text-xs text-purple-400">Active</span>
          </div>
        </div>

        {/* Health / Warnings Card */}
        <div 
          onClick={() => onNavigate('events')}
          className="bg-slate-900 border border-slate-800 hover:border-amber-500/50 rounded-xl p-4 transition-all cursor-pointer shadow-sm group"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400">Active Warnings</span>
            <div className="p-2 bg-amber-950/80 text-amber-400 rounded-lg group-hover:scale-110 transition-transform">
              <AlertTriangle className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-amber-400 font-mono">
              {recentWarnings.length}
            </span>
            <span className="text-xs text-slate-400">Recent events</span>
          </div>
        </div>
      </div>

      {/* Pod Status Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 lg:col-span-1">
          <h4 className="text-xs font-semibold text-slate-200 uppercase tracking-wider mb-4 flex items-center gap-2">
            <Box className="w-3.5 h-3.5 text-cyan-400" />
            <span>Pod Health Distribution</span>
          </h4>

          <div className="space-y-3">
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-emerald-400 font-medium">Running</span>
                <span className="font-mono text-slate-300">{runningPods}</span>
              </div>
              <div className="w-full bg-slate-950 rounded-full h-2">
                <div 
                  className="bg-emerald-500 h-2 rounded-full transition-all"
                  style={{ width: `${pods.length ? (runningPods / pods.length) * 100 : 0}%` }}
                />
              </div>
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-amber-400 font-medium">Pending</span>
                <span className="font-mono text-slate-300">{pendingPods}</span>
              </div>
              <div className="w-full bg-slate-950 rounded-full h-2">
                <div 
                  className="bg-amber-500 h-2 rounded-full transition-all"
                  style={{ width: `${pods.length ? (pendingPods / pods.length) * 100 : 0}%` }}
                />
              </div>
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-rose-400 font-medium">Failed</span>
                <span className="font-mono text-slate-300">{failedPods}</span>
              </div>
              <div className="w-full bg-slate-950 rounded-full h-2">
                <div 
                  className="bg-rose-500 h-2 rounded-full transition-all"
                  style={{ width: `${pods.length ? (failedPods / pods.length) * 100 : 0}%` }}
                />
              </div>
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-blue-400 font-medium">Completed</span>
                <span className="font-mono text-slate-300">{completedPods}</span>
              </div>
              <div className="w-full bg-slate-950 rounded-full h-2">
                <div 
                  className="bg-blue-500 h-2 rounded-full transition-all"
                  style={{ width: `${pods.length ? (completedPods / pods.length) * 100 : 0}%` }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Nodes Status Table */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 lg:col-span-2 flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <h4 className="text-xs font-semibold text-slate-200 uppercase tracking-wider flex items-center gap-2">
              <Cpu className="w-3.5 h-3.5 text-cyan-400" />
              <span>Node Resources</span>
            </h4>
            <button 
              onClick={() => onNavigate('nodes')}
              className="text-xs text-cyan-400 hover:text-cyan-300 font-medium"
            >
              View All →
            </button>
          </div>

          <div className="flex-1 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-slate-400 border-b border-slate-800">
                <tr>
                  <th className="pb-2 font-medium">Node Name</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium">Version</th>
                  <th className="pb-2 font-medium">CPU Capacity</th>
                  <th className="pb-2 font-medium">Memory</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono text-slate-300">
                {nodes.slice(0, 5).map((node) => {
                  const isReady = node.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True');
                  return (
                    <tr key={node.metadata.name} className="hover:bg-slate-800/40">
                      <td className="py-2.5 font-medium text-slate-200">{node.metadata.name}</td>
                      <td className="py-2.5">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                          isReady ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : 'bg-rose-950 text-rose-400 border border-rose-800'
                        }`}>
                          {isReady ? 'Ready' : 'NotReady'}
                        </span>
                      </td>
                      <td className="py-2.5 text-slate-400">{node.status.nodeInfo?.kubeletVersion || 'N/A'}</td>
                      <td className="py-2.5">{node.status.capacity?.cpu || 'N/A'}</td>
                      <td className="py-2.5">{node.status.capacity?.memory || 'N/A'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Recent Warning Events */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h4 className="text-xs font-semibold text-slate-200 uppercase tracking-wider flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
            <span>Recent Cluster Warnings</span>
          </h4>
          <button 
            onClick={() => onNavigate('events')}
            className="text-xs text-cyan-400 hover:text-cyan-300 font-medium"
          >
            All Events →
          </button>
        </div>

        {recentWarnings.length === 0 ? (
          <div className="text-xs text-slate-500 italic py-4">No warning events detected in the cluster.</div>
        ) : (
          <div className="space-y-2">
            {recentWarnings.map((event, idx) => (
              <div 
                key={idx}
                className="bg-slate-950/60 border border-slate-800/80 rounded-lg p-3 text-xs flex items-start gap-3"
              >
                <span className="bg-amber-950/80 text-amber-400 border border-amber-800/50 px-2 py-0.5 rounded text-[10px] font-bold shrink-0 mt-0.5">
                  {event.reason}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-slate-200 truncate">
                    {event.involvedObject.kind} / {event.involvedObject.name}
                  </div>
                  <div className="text-slate-400 text-[11px] mt-0.5 line-clamp-1">{event.message}</div>
                </div>
                <div className="text-slate-400 font-mono text-[10px] shrink-0">
                  {event.lastTimestamp ? new Date(event.lastTimestamp).toLocaleTimeString() : ''}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
