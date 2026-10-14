import React, { useState } from 'react';
import { 
  FolderTree, 
  Plus, 
  FileCode, 
  Trash2, 
  CheckCircle2, 
  AlertCircle, 
  Filter,
  X,
  Check
} from 'lucide-react';
import { NamespaceItem } from '../types/k8s';
import { applyManifest } from '../api/client';

interface NamespacesViewProps {
  namespaces: string[];
  namespaceItems?: NamespaceItem[];
  searchQuery: string;
  selectedNamespace: string;
  onSelectNamespace: (ns: string) => void;
  onOpenManifest: (kind: string, name: string) => void;
  onDelete: (kind: string, name: string) => void;
  onRefresh: () => void;
  onToast: (msg: string, type?: 'success' | 'error') => void;
}

export const NamespacesView: React.FC<NamespacesViewProps> = ({
  namespaces,
  namespaceItems = [],
  searchQuery,
  selectedNamespace,
  onSelectNamespace,
  onOpenManifest,
  onDelete,
  onRefresh,
  onToast,
}) => {
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newNsName, setNewNsName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Map namespaces to items if available, or generate default entries
  const items: NamespaceItem[] = namespaces.map((ns) => {
    const existing = namespaceItems.find((item) => item.metadata.name === ns);
    return (
      existing || {
        metadata: { name: ns },
        status: { phase: 'Active' },
      }
    );
  });

  const filtered = items.filter((item) => {
    const name = item.metadata.name.toLowerCase();
    const q = searchQuery.toLowerCase();
    return name.includes(q);
  });

  const handleCreateNamespace = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newNsName.trim().toLowerCase();
    if (!trimmed) return;

    try {
      setIsSubmitting(true);
      const manifest = `apiVersion: v1
kind: Namespace
metadata:
  name: ${trimmed}
`;
      await applyManifest(manifest);
      onToast(`Namespace '${trimmed}' created successfully`);
      setIsCreateModalOpen(false);
      setNewNsName('');
      onRefresh();
    } catch (err: any) {
      onToast(err.message || 'Failed to create namespace', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="h-full flex flex-col overflow-hidden select-text">
      {/* Header */}
      <div className="px-6 py-3 border-b border-slate-800 bg-slate-900/40 flex items-center justify-between text-xs text-slate-400 select-none">
        <div className="flex items-center gap-2 font-medium">
          <FolderTree className="w-4 h-4 text-cyan-400" />
          <span className="text-slate-200">Cluster Namespaces</span>
          <span className="bg-slate-800 text-slate-400 px-2 py-0.5 rounded font-mono text-[11px]">
            {filtered.length} of {namespaces.length}
          </span>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setIsCreateModalOpen(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-semibold rounded text-xs transition-colors cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Create Namespace</span>
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead className="bg-slate-950/80 text-slate-400 sticky top-0 z-10 border-b border-slate-800 select-none backdrop-blur-sm">
            <tr>
              <th className="py-2.5 px-4 font-semibold">Namespace Name</th>
              <th className="py-2.5 px-4 font-semibold">Status</th>
              <th className="py-2.5 px-4 font-semibold">Filter Status</th>
              <th className="py-2.5 px-4 font-semibold">Age</th>
              <th className="py-2.5 px-4 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50 font-mono text-slate-300">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-12 text-center text-slate-500 italic">
                  No namespaces found.
                </td>
              </tr>
            ) : (
              filtered.map((ns) => {
                const name = ns.metadata.name;
                const status = ns.status?.phase || 'Active';
                const isTerminating = status === 'Terminating';
                const isSelected = selectedNamespace === name;
                const age = ns.metadata.creationTimestamp
                  ? new Date(ns.metadata.creationTimestamp).toLocaleDateString()
                  : '-';

                return (
                  <tr key={name} className="hover:bg-slate-800/40 transition-colors">
                    <td className="py-2.5 px-4 font-medium text-slate-100 flex items-center gap-2">
                      <FolderTree className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                      <span className="truncate max-w-xs">{name}</span>
                      {isSelected && (
                        <span className="bg-cyan-950 text-cyan-300 border border-cyan-800/80 text-[10px] px-1.5 py-0.2 rounded font-sans font-medium">
                          Active Filter
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-4">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-semibold border flex items-center gap-1 w-max ${
                        isTerminating
                          ? 'bg-rose-950 text-rose-400 border-rose-800/80 animate-pulse'
                          : 'bg-emerald-950 text-emerald-400 border-emerald-800/80'
                      }`}>
                        {isTerminating ? <AlertCircle className="w-2.5 h-2.5" /> : <CheckCircle2 className="w-2.5 h-2.5" />}
                        <span>{status}</span>
                      </span>
                    </td>
                    <td className="py-2.5 px-4 font-sans">
                      <button
                        onClick={() => onSelectNamespace(isSelected ? '_all' : name)}
                        className={`px-2 py-0.8 rounded text-[11px] font-medium transition-colors cursor-pointer flex items-center gap-1 ${
                          isSelected
                            ? 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                            : 'bg-slate-900 border border-slate-800 text-cyan-400 hover:bg-slate-800 hover:border-cyan-500/40'
                        }`}
                      >
                        <Filter className="w-3 h-3" />
                        <span>{isSelected ? 'Clear Filter' : 'Filter by this'}</span>
                      </button>
                    </td>
                    <td className="py-2.5 px-4 text-slate-400">{age}</td>
                    <td className="py-2.5 px-4 text-right">
                      <div className="flex items-center justify-end gap-1 font-sans">
                        <button
                          onClick={() => onOpenManifest('namespaces', name)}
                          className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-cyan-300 transition-colors cursor-pointer"
                          title="View YAML Manifest"
                        >
                          <FileCode className="w-3.5 h-3.5" />
                        </button>
                        {name !== 'default' && name !== 'kube-system' && name !== 'kube-public' && (
                          <button
                            onClick={() => onDelete('namespace', name)}
                            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-rose-400 transition-colors cursor-pointer"
                            title="Delete Namespace"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Create Namespace Modal */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-md w-full overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-150">
            <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FolderTree className="w-4 h-4 text-cyan-400" />
                <h3 className="text-sm font-semibold text-slate-100">Create Namespace</h3>
              </div>
              <button
                onClick={() => setIsCreateModalOpen(false)}
                className="text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateNamespace} className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Namespace Name
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. staging, microservices"
                  value={newNsName}
                  onChange={(e) => setNewNsName(e.target.value)}
                  pattern="[a-z0-9]([-a-z0-9]*[a-z0-9])?"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none focus:border-cyan-500"
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  Must be lowercase RFC 1123 label (letters, numbers, hyphens).
                </p>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-3 py-1.5 rounded-lg border border-slate-700 text-xs font-medium text-slate-300 hover:bg-slate-800 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || !newNsName.trim()}
                  className="px-4 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-slate-950 text-xs font-bold transition-colors cursor-pointer flex items-center gap-1.5"
                >
                  {isSubmitting ? 'Creating...' : 'Create Namespace'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
