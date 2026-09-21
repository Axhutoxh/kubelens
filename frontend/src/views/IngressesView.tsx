import React, { useState } from 'react';
import {
  Globe,
  ExternalLink,
  Pencil,
  Trash2,
  MoreVertical,
  Layers,
  Lock
} from 'lucide-react';
import { IngressItem } from '../types/k8s';
import { IngressDetailModal } from '../components/IngressDetailModal';

interface IngressesViewProps {
  ingresses: IngressItem[];
  searchQuery: string;
  currentContext?: string;
  onOpenManifest: (kind: string, name: string, namespace: string, context?: string) => void;
  onDelete: (kind: string, name: string, namespace: string, context?: string) => void;
  onRefresh?: () => void;
  onToast?: (message: string, type?: 'success' | 'error') => void;
}

export function formatAge(timestamp?: string): string {
  if (!timestamp) return '-';
  const diff = Date.now() - new Date(timestamp).getTime();
  if (diff < 0) return '0s';
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export const IngressesView: React.FC<IngressesViewProps> = ({
  ingresses,
  searchQuery,
  currentContext,
  onOpenManifest,
  onDelete,
  onRefresh,
  onToast,
}) => {
  const [selectedIngress, setSelectedIngress] = useState<IngressItem | null>(null);

  const safeIngresses = Array.isArray(ingresses) ? ingresses : [];

  const filtered = safeIngresses.filter((item) => {
    if (!item || !item.metadata) return false;
    const q = (searchQuery || '').toLowerCase();
    const name = (item.metadata.name || '').toLowerCase();
    const ns = (item.metadata.namespace || '').toLowerCase();

    // Check rules (hosts and paths)
    const rules = item.spec?.rules || [];
    const matchesRules = rules.some((r) => {
      const host = (r?.host || '').toLowerCase();
      if (host.includes(q)) return true;
      const paths = r?.http?.paths || [];
      return paths.some((p) => {
        const pathStr = (p?.path || '').toLowerCase();
        const svc = (p?.backend?.service?.name || p?.backend?.resource?.name || '').toLowerCase();
        return pathStr.includes(q) || svc.includes(q);
      });
    });

    // Check load balancer endpoints
    const eps = item.status?.loadBalancer?.ingress || [];
    const matchesEps = eps.some(
      (ep) => (ep?.ip || '').toLowerCase().includes(q) || (ep?.hostname || '').toLowerCase().includes(q)
    );

    return name.includes(q) || ns.includes(q) || matchesRules || matchesEps;
  });

  return (
    <div className="h-full flex flex-col overflow-hidden select-text">
      {/* Top Header & Metrics Bar */}
      <div className="px-6 py-3 border-b border-slate-800 bg-slate-900/40 flex items-center justify-between text-xs text-slate-400 select-none shrink-0">
        <div className="flex items-center gap-2 font-medium">
          <Globe className="w-4 h-4 text-teal-400" />
          <span className="text-slate-200 font-semibold text-sm">Ingresses</span>
          <span className="bg-slate-800 text-slate-300 px-2 py-0.5 rounded font-mono text-[11px]">
            {filtered.length} {filtered.length === 1 ? 'item' : 'items'}
          </span>
        </div>
      </div>

      {/* Main Ingresses Table matching Freelens layout */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead className="bg-slate-950/80 text-slate-400 sticky top-0 z-10 border-b border-slate-800 select-none backdrop-blur-sm font-semibold">
            <tr>
              <th className="py-2.5 px-4 w-1/4">Name</th>
              <th className="py-2.5 px-4 w-1/6">Namespace</th>
              <th className="py-2.5 px-4 w-1/6">LoadBalancers</th>
              <th className="py-2.5 px-4 w-1/3">Rules</th>
              <th className="py-2.5 px-4 w-20">Age</th>
              <th className="py-2.5 px-4 text-right w-16">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50 text-slate-300">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-16 text-center text-slate-500">
                  <div className="max-w-md mx-auto space-y-3">
                    <Globe className="w-10 h-10 mx-auto text-slate-600 animate-pulse" />
                    <p className="text-sm font-medium text-slate-400">No Ingress resources found.</p>
                    <p className="text-xs text-slate-500 font-sans">
                      {searchQuery
                        ? `No ingresses matched query "${searchQuery}".`
                        : 'No Ingress rules deployed in the selected namespace.'}
                    </p>
                  </div>
                </td>
              </tr>
            ) : (
              filtered.map((item) => {
                const spec = item.spec || {};
                const metadata = item.metadata || { name: 'unnamed', namespace: 'default' };
                const rules = spec.rules || [];
                const tls = spec.tls || [];
                const tlsHosts = new Set(
                  tls.flatMap((t) => (Array.isArray(t?.hosts) ? t.hosts : t?.hosts ? [t.hosts] : []))
                );

                // Extract all paths across rules
                const allPaths: Array<{ host: string; path: string; fullUrl: string }> = [];
                for (const r of rules) {
                  const h = r?.host || '';
                  const isTls = h && tlsHosts.has(h);
                  const scheme = isTls ? 'https' : 'http';
                  const rulePaths = r?.http?.paths || [];
                  for (const p of rulePaths) {
                    const pathStr = p?.path || '/';
                    const fullUrl = h ? `${scheme}://${h}${pathStr}` : pathStr;
                    allPaths.push({ host: h, path: pathStr, fullUrl });
                  }
                }

                // First path rule & more count
                const firstRule = allPaths[0];
                const moreCount = allPaths.length > 1 ? allPaths.length - 1 : 0;

                // LoadBalancers
                const lbEndpoints = item.status?.loadBalancer?.ingress || [];
                const lbString =
                  lbEndpoints
                    .map((ep) => ep?.ip || ep?.hostname)
                    .filter(Boolean)
                    .join(', ') || '-';

                return (
                  <tr
                    key={metadata.uid || `${metadata.namespace}/${metadata.name}`}
                    className="hover:bg-slate-800/40 transition-colors group cursor-pointer"
                    onClick={() => setSelectedIngress(item)}
                  >
                    {/* Name */}
                    <td className="py-3 px-4 font-medium text-slate-100">
                      <span className="hover:text-teal-300 font-bold transition-colors">
                        {metadata.name}
                      </span>
                    </td>

                    {/* Namespace */}
                    <td className="py-3 px-4">
                      <span className="text-teal-400 hover:underline cursor-pointer">
                        {metadata.namespace || 'default'}
                      </span>
                    </td>

                    {/* LoadBalancers */}
                    <td className="py-3 px-4 font-mono text-slate-300">
                      {lbString}
                    </td>

                    {/* Rules */}
                    <td className="py-3 px-4">
                      {firstRule ? (
                        <div className="space-y-0.5">
                          <a
                            href={firstRule.fullUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-teal-400 hover:text-teal-300 hover:underline font-mono text-[11px] truncate block max-w-lg transition-colors"
                            title={firstRule.fullUrl}
                          >
                            {firstRule.fullUrl}
                          </a>
                          {moreCount > 0 && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedIngress(item);
                              }}
                              className="text-[11px] text-slate-400 hover:text-teal-300 transition-colors block text-left"
                            >
                              {moreCount} more...
                            </button>
                          )}
                        </div>
                      ) : (
                        <span className="text-slate-500">-</span>
                      )}
                    </td>

                    {/* Age */}
                    <td className="py-3 px-4 font-mono text-slate-400">
                      {formatAge(metadata.creationTimestamp)}
                    </td>

                    {/* Actions Menu */}
                    <td className="py-3 px-4 text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() =>
                            onOpenManifest(
                              'ingress',
                              metadata.name,
                              metadata.namespace || 'default',
                              currentContext
                            )
                          }
                          title="Edit Manifest"
                          className="p-1.5 text-slate-400 hover:text-teal-300 hover:bg-slate-800 rounded transition-colors"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() =>
                            onDelete(
                              'ingress',
                              metadata.name,
                              metadata.namespace || 'default',
                              currentContext
                            )
                          }
                          title="Delete Ingress"
                          className="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-slate-800 rounded transition-colors"
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

      {/* Slide-over Ingress Detail Drawer */}
      <IngressDetailModal
        isOpen={!!selectedIngress}
        onClose={() => setSelectedIngress(null)}
        ingress={selectedIngress}
        currentContext={currentContext}
        onOpenManifest={onOpenManifest}
        onDelete={onDelete}
        onToast={onToast}
      />
    </div>
  );
};
