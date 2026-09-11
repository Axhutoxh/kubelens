import React, { useState } from 'react';
import { FileText, ShieldCheck, Eye, FileCode, Trash2, KeyRound } from 'lucide-react';
import { ConfigMapItem, SecretItem } from '../types/k8s';
import { SecretDetailModal } from '../components/SecretDetailModal';

interface ConfigViewProps {
  configMaps: ConfigMapItem[];
  secrets: SecretItem[];
  type: 'configmaps' | 'secrets';
  searchQuery: string;
  currentContext?: string;
  onOpenManifest: (kind: string, name: string, namespace: string) => void;
  onDelete: (kind: string, name: string, namespace: string) => void;
  onRefresh?: () => void;
  onToast?: (message: string, type?: 'success' | 'error') => void;
}

export const ConfigView: React.FC<ConfigViewProps> = ({
  configMaps,
  secrets,
  type,
  searchQuery,
  currentContext,
  onOpenManifest,
  onDelete,
  onRefresh,
  onToast,
}) => {
  const isConfigMap = type === 'configmaps';
  const items = isConfigMap ? configMaps : secrets;

  // Selected secret for the interactive detail & edit modal
  const [selectedSecret, setSelectedSecret] = useState<SecretItem | null>(null);

  const filtered = items.filter((item) => {
    const name = item.metadata.name.toLowerCase();
    const ns = (item.metadata.namespace || '').toLowerCase();
    const q = searchQuery.toLowerCase();
    return name.includes(q) || ns.includes(q);
  });

  return (
    <div className="h-full flex flex-col overflow-hidden select-text">
      {/* Header */}
      <div className="px-6 py-3 border-b border-slate-800 bg-slate-900/40 flex items-center justify-between text-xs text-slate-400 select-none">
        <div className="flex items-center gap-2 font-medium">
          {isConfigMap ? (
            <FileText className="w-4 h-4 text-cyan-400" />
          ) : (
            <ShieldCheck className="w-4 h-4 text-amber-400" />
          )}
          <span className="text-slate-200">{isConfigMap ? 'ConfigMaps' : 'Secrets'}</span>
          <span className="bg-slate-800 text-slate-400 px-2 py-0.5 rounded font-mono text-[11px]">
            {filtered.length} of {items.length}
          </span>
        </div>
        {!isConfigMap && (
          <span className="text-[11px] text-slate-400 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
            Click any secret to view, decrypt/encrypt, and edit values
          </span>
        )}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead className="bg-slate-950/80 text-slate-400 sticky top-0 z-10 border-b border-slate-800 select-none backdrop-blur-sm">
            <tr>
              <th className="py-2.5 px-4 font-semibold">Name</th>
              <th className="py-2.5 px-4 font-semibold">Namespace</th>
              <th className="py-2.5 px-4 font-semibold">Keys Count</th>
              <th className="py-2.5 px-4 font-semibold">Age</th>
              <th className="py-2.5 px-4 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50 font-mono text-slate-300">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-12 text-center text-slate-500 italic">
                  No {isConfigMap ? 'ConfigMaps' : 'Secrets'} found.
                </td>
              </tr>
            ) : (
              filtered.map((item) => {
                const keysCount = item.data ? Object.keys(item.data).length : 0;
                const age = item.metadata.creationTimestamp 
                  ? new Date(item.metadata.creationTimestamp).toLocaleDateString()
                  : 'N/A';

                return (
                  <tr 
                    key={item.metadata.uid || item.metadata.name} 
                    onClick={() => {
                      if (!isConfigMap) {
                        setSelectedSecret(item as SecretItem);
                      }
                    }}
                    className={`transition-colors group ${
                      !isConfigMap 
                        ? 'hover:bg-slate-800/60 cursor-pointer' 
                        : 'hover:bg-slate-800/40'
                    }`}
                    title={!isConfigMap ? 'Click to inspect, decrypt/encrypt and edit secret values' : undefined}
                  >
                    <td className="py-2.5 px-4 font-medium text-slate-100 flex items-center gap-2">
                      {!isConfigMap && (
                        <KeyRound className="w-3.5 h-3.5 text-amber-400/70 group-hover:text-amber-400 shrink-0 transition-colors" />
                      )}
                      <span className={`truncate max-w-sm ${!isConfigMap ? 'group-hover:text-cyan-300 transition-colors' : ''}`}>
                        {item.metadata.name}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-slate-400">
                      <span className="bg-slate-800/80 text-slate-300 px-2 py-0.5 rounded text-[11px]">
                        {item.metadata.namespace}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-cyan-400 font-semibold">{keysCount} keys</td>
                    <td className="py-2.5 px-4 text-slate-400">{age}</td>
                    <td className="py-2.5 px-4 text-right">
                      <div className="flex items-center justify-end gap-1 select-none font-sans">
                        {/* Quick View / Edit Values for Secrets */}
                        {!isConfigMap && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedSecret(item as SecretItem);
                            }}
                            title="Inspect & Edit Secret (Decrypt / Encrypt)"
                            className="p-1 text-slate-400 hover:text-cyan-300 hover:bg-slate-800 rounded transition-colors"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenManifest(isConfigMap ? 'configmap' : 'secret', item.metadata.name, item.metadata.namespace!);
                          }}
                          title="View Manifest"
                          className="p-1 text-slate-400 hover:text-amber-300 hover:bg-slate-800 rounded transition-colors"
                        >
                          <FileCode className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onDelete(isConfigMap ? 'configmap' : 'secret', item.metadata.name, item.metadata.namespace!);
                          }}
                          title="Delete"
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

      {/* Interactive Secret Pop-up Modal */}
      <SecretDetailModal
        isOpen={!!selectedSecret}
        onClose={() => setSelectedSecret(null)}
        secret={selectedSecret}
        currentContext={currentContext}
        onSaveSuccess={() => {
          onRefresh?.();
        }}
        onToast={onToast}
      />
    </div>
  );
};
