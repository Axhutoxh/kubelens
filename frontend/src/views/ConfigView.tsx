import React, { useMemo, useState } from 'react';
import { FileText, ShieldCheck, Eye, FileCode, Trash2, KeyRound, FileKey } from 'lucide-react';
import { ConfigMapItem, SecretItem } from '../types/k8s';
import { SecretDetailModal } from '../components/SecretDetailModal';
import { ConfigMapDetailModal } from '../components/ConfigMapDetailModal';

export type ConfigViewType = 'configmaps' | 'secrets' | 'config-all';

interface ConfigViewProps {
  configMaps: ConfigMapItem[];
  secrets: SecretItem[];
  type: ConfigViewType;
  searchQuery: string;
  currentContext?: string;
  onOpenManifest: (kind: string, name: string, namespace: string) => void;
  onDelete: (kind: string, name: string, namespace: string) => void;
  onRefresh?: () => void;
  onToast?: (message: string, type?: 'success' | 'error') => void;
}

type Row =
  | { kind: 'ConfigMap'; item: ConfigMapItem }
  | { kind: 'Secret'; item: SecretItem };

type KindFilter = 'all' | 'ConfigMap' | 'Secret';

/** Short label for well-known Secret types; anything else is shown as is. */
const secretTypeLabel = (t?: string) => {
  switch (t) {
    case 'kubernetes.io/tls': return 'TLS';
    case 'kubernetes.io/dockerconfigjson': return 'Docker config';
    case 'kubernetes.io/service-account-token': return 'SA token';
    case 'kubernetes.io/basic-auth': return 'Basic auth';
    case 'kubernetes.io/ssh-auth': return 'SSH auth';
    case 'helm.sh/release.v1': return 'Helm release';
    default: return t || 'Opaque';
  }
};

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
  const isAll = type === 'config-all';
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');

  // Selected item for interactive detail & edit modals
  const [selectedSecret, setSelectedSecret] = useState<SecretItem | null>(null);
  const [selectedConfigMap, setSelectedConfigMap] = useState<ConfigMapItem | null>(null);

  const rows: Row[] = useMemo(() => {
    const cms: Row[] = type === 'secrets' ? [] : configMaps.map((item) => ({ kind: 'ConfigMap', item }));
    const secs: Row[] = type === 'configmaps' ? [] : secrets.map((item) => ({ kind: 'Secret', item }));
    const all = [...cms, ...secs];
    if (isAll) {
      // One list: grouped by namespace, then name, ConfigMap before Secret on a name clash
      all.sort((a, b) =>
        (a.item.metadata.namespace || '').localeCompare(b.item.metadata.namespace || '') ||
        a.item.metadata.name.localeCompare(b.item.metadata.name) ||
        a.kind.localeCompare(b.kind)
      );
    }
    return all;
  }, [configMaps, secrets, type, isAll]);

  const q = searchQuery.toLowerCase();
  const matchesSearch = (r: Row) =>
    r.item.metadata.name.toLowerCase().includes(q) ||
    (r.item.metadata.namespace || '').toLowerCase().includes(q) ||
    (isAll && r.kind === 'Secret' && (r.item.type || '').toLowerCase().includes(q));
  const searched = rows.filter(matchesSearch);
  const filtered = isAll && kindFilter !== 'all' ? searched.filter((r) => r.kind === kindFilter) : searched;
  const counts = {
    all: searched.length,
    ConfigMap: searched.filter((r) => r.kind === 'ConfigMap').length,
    Secret: searched.filter((r) => r.kind === 'Secret').length,
  };

  const title = isAll ? 'ConfigMaps & Secrets' : type === 'configmaps' ? 'ConfigMaps' : 'Secrets';
  const open = (r: Row) => {
    if (r.kind === 'ConfigMap') setSelectedConfigMap(r.item);
    else setSelectedSecret(r.item);
  };

  return (
    <div className="h-full flex flex-col overflow-hidden select-text">
      {/* Header */}
      <div className="px-6 py-3 border-b border-slate-800 bg-slate-900/40 flex items-center justify-between gap-3 text-xs text-slate-400 select-none">
        <div className="flex items-center gap-2 font-medium">
          {isAll ? (
            <FileKey className="w-4 h-4 text-violet-300" />
          ) : type === 'configmaps' ? (
            <FileText className="w-4 h-4 text-cyan-400" />
          ) : (
            <ShieldCheck className="w-4 h-4 text-amber-400" />
          )}
          <span className="text-slate-200">{title}</span>
          <span className="bg-slate-800 text-slate-400 px-2 py-0.5 rounded font-mono text-[11px]">
            {filtered.length} of {rows.length}
          </span>
          {isAll && (
            <div className="flex items-center gap-1 ml-2" role="group" aria-label="Filter by kind">
              {(['all', 'ConfigMap', 'Secret'] as KindFilter[]).map((k) => (
                <button
                  key={k}
                  onClick={() => setKindFilter(k)}
                  aria-pressed={kindFilter === k}
                  className={`px-2 py-0.5 rounded-md border text-[11px] transition-colors cursor-pointer ${
                    kindFilter === k
                      ? 'bg-cyan-500/15 text-cyan-200 border-cyan-500/60'
                      : 'bg-slate-950/60 text-slate-400 border-slate-700 hover:text-slate-200'
                  }`}
                >
                  {k === 'all' ? 'All' : k === 'ConfigMap' ? 'ConfigMaps' : 'Secrets'}
                  <span className="ml-1 font-mono text-slate-500">{counts[k]}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <span className="text-[11px] text-slate-400 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
          {isAll
            ? 'Click any item to view and edit it'
            : type === 'configmaps'
              ? 'Click any ConfigMap to view, edit, and save configuration keys'
              : 'Click any secret to view, decrypt/encrypt, and edit values'}
        </span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead className="bg-slate-950/80 text-slate-400 sticky top-0 z-10 border-b border-slate-800 select-none backdrop-blur-sm">
            <tr>
              <th className="py-2.5 px-4 font-semibold">Name</th>
              {isAll && <th className="py-2.5 px-4 font-semibold">Kind</th>}
              <th className="py-2.5 px-4 font-semibold">Namespace</th>
              <th className="py-2.5 px-4 font-semibold">Keys Count</th>
              <th className="py-2.5 px-4 font-semibold">Age</th>
              <th className="py-2.5 px-4 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50 font-mono text-slate-300">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={isAll ? 6 : 5} className="py-12 text-center text-slate-500 italic">
                  No {title} found.
                </td>
              </tr>
            ) : (
              filtered.map((r) => {
                const { item } = r;
                const isConfigMap = r.kind === 'ConfigMap';
                const keysCount = item.data ? Object.keys(item.data).length : 0;
                const age = item.metadata.creationTimestamp
                  ? new Date(item.metadata.creationTimestamp).toLocaleDateString()
                  : 'N/A';

                return (
                  <tr
                    key={`${r.kind}/${item.metadata.uid || `${item.metadata.namespace}/${item.metadata.name}`}`}
                    onClick={() => open(r)}
                    className="hover:bg-slate-800/60 cursor-pointer transition-colors group"
                    title={`Click to inspect and edit ${r.kind}`}
                  >
                    <td className="py-2.5 px-4 font-medium text-slate-100 flex items-center gap-2">
                      {isConfigMap ? (
                        <FileText className="w-3.5 h-3.5 text-cyan-400/70 group-hover:text-cyan-400 shrink-0 transition-colors" />
                      ) : (
                        <KeyRound className="w-3.5 h-3.5 text-amber-400/70 group-hover:text-amber-400 shrink-0 transition-colors" />
                      )}
                      <span className="truncate max-w-sm group-hover:text-cyan-300 transition-colors">
                        {item.metadata.name}
                      </span>
                    </td>
                    {isAll && (
                      <td className="py-2.5 px-4 font-sans">
                        {r.kind === 'ConfigMap' ? (
                          <span className="text-[11px] px-2 py-0.5 rounded border border-cyan-800/60 bg-cyan-950/40 text-cyan-300">ConfigMap</span>
                        ) : (
                          <span
                            className="text-[11px] px-2 py-0.5 rounded border border-amber-800/60 bg-amber-950/40 text-amber-300"
                            title={r.item.type}
                          >
                            Secret · {secretTypeLabel(r.item.type)}
                          </span>
                        )}
                      </td>
                    )}
                    <td className="py-2.5 px-4 text-slate-400">
                      <span className="bg-slate-800/80 text-slate-300 px-2 py-0.5 rounded text-[11px]">
                        {item.metadata.namespace}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-slate-200">
                      <span className="bg-slate-900 border border-slate-700/60 text-cyan-300 px-2 py-0.5 rounded text-[11px]">
                        {keysCount} {keysCount === 1 ? 'key' : 'keys'}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-slate-400">{age}</td>
                    <td className="py-2.5 px-4 text-right">
                      <div className="flex items-center justify-end gap-1 font-sans">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            open(r);
                          }}
                          title="Inspect Keys"
                          className="p-1 text-slate-400 hover:text-cyan-300 hover:bg-slate-800 rounded transition-colors"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenManifest(isConfigMap ? 'configmaps' : 'secrets', item.metadata.name, item.metadata.namespace!);
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

      {/* Interactive Secret Modal */}
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

      {/* Interactive ConfigMap Modal */}
      <ConfigMapDetailModal
        isOpen={!!selectedConfigMap}
        onClose={() => setSelectedConfigMap(null)}
        configMap={selectedConfigMap}
        context={currentContext}
        onRefreshList={onRefresh}
        onOpenManifest={onOpenManifest}
        onToast={onToast}
      />
    </div>
  );
};
