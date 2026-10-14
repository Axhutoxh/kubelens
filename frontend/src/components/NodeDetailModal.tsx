import React, { useState } from 'react';
import { 
  X, 
  Cpu, 
  HardDrive, 
  Activity, 
  CheckCircle2, 
  AlertCircle, 
  FileCode, 
  Tag, 
  ShieldAlert,
  Server
} from 'lucide-react';
import { NodeItem } from '../types/k8s';

interface NodeDetailModalProps {
  isOpen: boolean;
  node: NodeItem | null;
  onClose: () => void;
  onOpenManifest?: (kind: string, name: string) => void;
}

export const NodeDetailModal: React.FC<NodeDetailModalProps> = ({
  isOpen,
  node,
  onClose,
  onOpenManifest,
}) => {
  if (!isOpen || !node) return null;

  const [activeTab, setActiveTab] = useState<'overview' | 'conditions' | 'labels'>('overview');

  const conditions = node.status?.conditions || [];
  const capacity = node.status?.capacity || {};
  const allocatable = node.status?.allocatable || {};
  const nodeInfo = node.status?.nodeInfo;
  const addresses = node.status?.addresses || [];
  const internalIp = addresses.find((a) => a.type === 'InternalIP')?.address || '-';
  const externalIp = addresses.find((a) => a.type === 'ExternalIP')?.address || '-';
  const hostname = addresses.find((a) => a.type === 'Hostname')?.address || node.metadata.name;

  const readyCond = conditions.find((c) => c.type === 'Ready');
  const isReady = readyCond?.status === 'True';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between shrink-0 bg-slate-900/60">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-cyan-950/80 border border-cyan-800/80 flex items-center justify-center text-cyan-400">
              <Cpu className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-slate-100 font-mono">
                  {node.metadata.name}
                </h2>
                <span className={`px-2 py-0.2 rounded text-[10px] font-semibold border flex items-center gap-1 ${
                  isReady 
                    ? 'bg-emerald-950 text-emerald-400 border-emerald-800/80' 
                    : 'bg-rose-950 text-rose-400 border-rose-800/80'
                }`}>
                  {isReady ? <CheckCircle2 className="w-2.5 h-2.5" /> : <AlertCircle className="w-2.5 h-2.5" />}
                  <span>{isReady ? 'Ready' : 'NotReady'}</span>
                </span>
              </div>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Cluster Node Hardware, Resource Allocations & Conditions
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {onOpenManifest && (
              <button
                onClick={() => onOpenManifest('nodes', node.metadata.name)}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs transition-colors cursor-pointer"
              >
                <FileCode className="w-3.5 h-3.5 text-cyan-400" />
                <span>YAML</span>
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="px-6 py-2 border-b border-slate-800 bg-slate-950/40 flex items-center gap-2 shrink-0">
          <button
            onClick={() => setActiveTab('overview')}
            className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors cursor-pointer ${
              activeTab === 'overview'
                ? 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/20'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Overview & Resources
          </button>
          <button
            onClick={() => setActiveTab('conditions')}
            className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors cursor-pointer ${
              activeTab === 'conditions'
                ? 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/20'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Conditions ({conditions.length})
          </button>
          <button
            onClick={() => setActiveTab('labels')}
            className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors cursor-pointer ${
              activeTab === 'labels'
                ? 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/20'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Labels & Annotations
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5 text-xs font-mono">
          {activeTab === 'overview' && (
            <>
              {/* Capacity vs Allocatable Cards */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-slate-950 border border-slate-800 rounded-lg p-3">
                  <div className="text-[11px] font-semibold text-slate-400 font-sans flex items-center gap-1.5 mb-2">
                    <Cpu className="w-3.5 h-3.5 text-cyan-400" />
                    <span>CPU Cores</span>
                  </div>
                  <div className="flex justify-between items-baseline mb-1">
                    <span className="text-slate-500 text-[10px]">Allocatable</span>
                    <span className="text-cyan-300 text-sm font-bold">{allocatable.cpu || '-'}</span>
                  </div>
                  <div className="flex justify-between items-baseline">
                    <span className="text-slate-500 text-[10px]">Capacity</span>
                    <span className="text-slate-400 text-xs">{capacity.cpu || '-'}</span>
                  </div>
                </div>

                <div className="bg-slate-950 border border-slate-800 rounded-lg p-3">
                  <div className="text-[11px] font-semibold text-slate-400 font-sans flex items-center gap-1.5 mb-2">
                    <HardDrive className="w-3.5 h-3.5 text-amber-400" />
                    <span>Memory</span>
                  </div>
                  <div className="flex justify-between items-baseline mb-1">
                    <span className="text-slate-500 text-[10px]">Allocatable</span>
                    <span className="text-amber-300 text-sm font-bold">{allocatable.memory || '-'}</span>
                  </div>
                  <div className="flex justify-between items-baseline">
                    <span className="text-slate-500 text-[10px]">Capacity</span>
                    <span className="text-slate-400 text-xs">{capacity.memory || '-'}</span>
                  </div>
                </div>

                <div className="bg-slate-950 border border-slate-800 rounded-lg p-3">
                  <div className="text-[11px] font-semibold text-slate-400 font-sans flex items-center gap-1.5 mb-2">
                    <Server className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Max Pods</span>
                  </div>
                  <div className="flex justify-between items-baseline mb-1">
                    <span className="text-slate-500 text-[10px]">Allocatable</span>
                    <span className="text-emerald-300 text-sm font-bold">{allocatable.pods || '-'}</span>
                  </div>
                  <div className="flex justify-between items-baseline">
                    <span className="text-slate-500 text-[10px]">Capacity</span>
                    <span className="text-slate-400 text-xs">{capacity.pods || '-'}</span>
                  </div>
                </div>
              </div>

              {/* Node System Info */}
              <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 space-y-2">
                <div className="text-slate-300 font-semibold mb-2 font-sans flex items-center gap-2">
                  <Server className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Node Details & Operating System</span>
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                  <div className="flex justify-between border-b border-slate-800/80 pb-1">
                    <span className="text-slate-500">Internal IP:</span>
                    <span className="text-slate-200">{internalIp}</span>
                  </div>
                  <div className="flex justify-between border-b border-slate-800/80 pb-1">
                    <span className="text-slate-500">External IP:</span>
                    <span className="text-slate-200">{externalIp}</span>
                  </div>
                  <div className="flex justify-between border-b border-slate-800/80 pb-1">
                    <span className="text-slate-500">Kubelet Version:</span>
                    <span className="text-cyan-300">{nodeInfo?.kubeletVersion || '-'}</span>
                  </div>
                  <div className="flex justify-between border-b border-slate-800/80 pb-1">
                    <span className="text-slate-500">Architecture:</span>
                    <span className="text-slate-200">{nodeInfo?.architecture || '-'}</span>
                  </div>
                  <div className="flex justify-between border-b border-slate-800/80 pb-1">
                    <span className="text-slate-500">Operating System:</span>
                    <span className="text-slate-200">{nodeInfo?.operatingSystem || '-'}</span>
                  </div>
                  <div className="flex justify-between border-b border-slate-800/80 pb-1">
                    <span className="text-slate-500">OS Image:</span>
                    <span className="text-slate-200 truncate max-w-[200px]" title={nodeInfo?.osImage}>
                      {nodeInfo?.osImage || '-'}
                    </span>
                  </div>
                </div>
              </div>
            </>
          )}

          {activeTab === 'conditions' && (
            <div className="space-y-2">
              {conditions.map((cond, idx) => {
                const isHealthy = (cond.type === 'Ready' && cond.status === 'True') ||
                  (cond.type !== 'Ready' && cond.status === 'False');

                return (
                  <div 
                    key={idx} 
                    className="p-3 bg-slate-950 border border-slate-800 rounded-lg flex items-start justify-between gap-4"
                  >
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-slate-100 font-semibold">{cond.type}</span>
                        <span className={`px-2 py-0.2 rounded text-[10px] font-semibold border ${
                          isHealthy 
                            ? 'bg-emerald-950 text-emerald-400 border-emerald-800/80' 
                            : 'bg-rose-950 text-rose-400 border-rose-800/80'
                        }`}>
                          {cond.status}
                        </span>
                      </div>
                      {cond.message && (
                        <p className="text-slate-400 text-[11px] font-sans leading-relaxed">
                          {cond.message}
                        </p>
                      )}
                    </div>
                    {cond.reason && (
                      <span className="bg-slate-900 text-slate-400 px-2 py-0.5 rounded text-[10px] shrink-0 border border-slate-800">
                        {cond.reason}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {activeTab === 'labels' && (
            <div className="space-y-3">
              <div className="bg-slate-950 border border-slate-800 rounded-lg p-4">
                <div className="text-slate-300 font-semibold mb-2 font-sans flex items-center gap-1.5">
                  <Tag className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Node Labels</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {node.metadata.labels && Object.entries(node.metadata.labels).map(([k, v]) => (
                    <span key={k} className="bg-slate-900 border border-slate-800 text-slate-300 px-2 py-0.5 rounded text-[11px]">
                      <span className="text-cyan-400">{k}</span>: {v}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
