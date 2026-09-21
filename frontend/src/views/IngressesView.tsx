import React, { useState } from 'react';
import {
  Network,
  Globe,
  Lock,
  Unlock,
  ExternalLink,
  FileCode,
  Trash2,
  Eye,
  ShieldCheck,
  Server,
  Layers,
  ArrowUpRight
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

  const filtered = ingresses.filter((item) => {
    const q = searchQuery.toLowerCase();
    const name = item.metadata.name.toLowerCase();
    const ns = (item.metadata.namespace || '').toLowerCase();
    const cls = (
      item.spec?.ingressClassName ||
      item.metadata.annotations?.['kubernetes.io/ingress.class'] ||
      ''
    ).toLowerCase();

    // Check hosts & paths & backend service names
    const rules = item.spec?.rules || [];
    const matchesRules = rules.some((r) => {
      const host = (r.host || '').toLowerCase();
      if (host.includes(q)) return true;
      const paths = r.http?.paths || [];
      return paths.some((p) => {
        const pathStr = (p.path || '').toLowerCase();
        const svc = (p.backend?.service?.name || '').toLowerCase();
        return pathStr.includes(q) || svc.includes(q);
      });
    });

    // Check load balancer endpoints
    const eps = item.status?.loadBalancer?.ingress || [];
    const matchesEps = eps.some(
      (ep) => (ep.ip || '').toLowerCase().includes(q) || (ep.hostname || '').toLowerCase().includes(q)
    );

    return name.includes(q) || ns.includes(q) || cls.includes(q) || matchesRules || matchesEps;
  });

  // Calculate high-level metrics for summary cards
  const totalIngresses = ingresses.length;
  const tlsSecuredCount = ingresses.filter((i) => (i.spec?.tls?.length || 0) > 0).length;
  const uniqueHosts = new Set(
    ingresses.flatMap((i) => (i.spec?.rules || []).map((r) => r.host).filter(Boolean))
  );
  const uniqueClasses = new Set(
    ingresses.map(
      (i) =>
        i.spec?.ingressClassName ||
        i.metadata.annotations?.['kubernetes.io/ingress.class'] ||
        'default'
    )
  );

  return (
    <div className="h-full flex flex-col overflow-hidden select-text">
      {/* Top Header & Metrics Bar */}
      <div className="px-6 py-3 border-b border-slate-800 bg-slate-900/40 flex items-center justify-between text-xs text-slate-400 select-none shrink-0">
        <div className="flex items-center gap-2 font-medium">
          <Globe className="w-4 h-4 text-cyan-400" />
          <span className="text-slate-200 font-semibold text-sm">Ingresses</span>
          <span className="bg-slate-800 text-slate-300 px-2 py-0.5 rounded font-mono text-[11px]">
            {filtered.length} of {totalIngresses}
          </span>
        </div>

        {/* Quick summary stat chips */}
        <div className="flex items-center gap-3 text-[11px] font-mono">
          <div className="flex items-center gap-1.5 bg-slate-900 border border-slate-800 px-2.5 py-1 rounded-md">
            <Globe className="w-3.5 h-3.5 text-cyan-400" />
            <span className="text-slate-400">Hosts:</span>
            <span className="text-slate-200 font-bold">{uniqueHosts.size}</span>
          </div>
          <div className="flex items-center gap-1.5 bg-slate-900 border border-slate-800 px-2.5 py-1 rounded-md">
            <Lock className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-slate-400">TLS Secured:</span>
            <span className="text-emerald-400 font-bold">{tlsSecuredCount}</span>
          </div>
          <div className="flex items-center gap-1.5 bg-slate-900 border border-slate-800 px-2.5 py-1 rounded-md">
            <Server className="w-3.5 h-3.5 text-indigo-400" />
            <span className="text-slate-400">Classes:</span>
            <span className="text-indigo-300 font-bold">{uniqueClasses.size}</span>
          </div>
        </div>
      </div>

      {/* Main Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead className="bg-slate-950/80 text-slate-400 sticky top-0 z-10 border-b border-slate-800 select-none backdrop-blur-sm">
            <tr>
              <th className="py-2.5 px-4 font-semibold">Name</th>
              <th className="py-2.5 px-4 font-semibold">Namespace</th>
              <th className="py-2.5 px-4 font-semibold">Class</th>
              <th className="py-2.5 px-4 font-semibold">Hosts</th>
              <th className="py-2.5 px-4 font-semibold">Routing (Paths & Backends)</th>
              <th className="py-2.5 px-4 font-semibold">Load Balancer Endpoints</th>
              <th className="py-2.5 px-4 font-semibold">TLS</th>
              <th className="py-2.5 px-4 font-semibold">Age</th>
              <th className="py-2.5 px-4 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50 font-mono text-slate-300">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-16 text-center text-slate-500">
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
                const spec = item.spec;
                const metadata = item.metadata;
                const rules = spec?.rules || [];
                const tls = spec?.tls || [];
                const isTLS = tls.length > 0;
                const tlsHosts = new Set(tls.flatMap((t) => t.hosts || []));

                const ingressClass =
                  spec?.ingressClassName ||
                  metadata.annotations?.['kubernetes.io/ingress.class'] ||
                  '-';

                // Hosts list
                const hosts = rules
                  .map((r) => r.host)
                  .filter(Boolean) as string[];
                const displayHosts = hosts.length > 0 ? hosts : ['*'];

                // Endpoints
                const lbEndpoints = item.status?.loadBalancer?.ingress || [];
                const endpointsList = lbEndpoints
                  .map((ep) => ep.ip || ep.hostname)
                  .filter(Boolean);

                // Collect compact paths
                const pathsSummary: Array<{ path: string; target: string }> = [];
                for (const r of rules) {
                  for (const p of r.http?.paths || []) {
                    const pStr = p.path || '/';
                    const target = p.backend?.service
                      ? `${p.backend.service.name}:${p.backend.service.port?.number || p.backend.service.port?.name || '80'}`
                      : p.backend?.resource?.name || 'custom';
                    pathsSummary.push({ path: pStr, target });
                  }
                }

                return (
                  <tr
                    key={metadata.uid || `${metadata.namespace}/${metadata.name}`}
                    className="hover:bg-slate-800/40 transition-colors group cursor-pointer"
                    onClick={() => setSelectedIngress(item)}
                  >
                    {/* Name */}
                    <td className="py-2.5 px-4 font-medium text-slate-100">
                      <div className="flex items-center gap-2">
                        <div className="p-1 rounded bg-slate-800 text-cyan-400 shrink-0 group-hover:bg-cyan-950 transition-colors">
                          <Globe className="w-3.5 h-3.5" />
                        </div>
                        <span className="font-bold text-slate-100 hover:text-cyan-300 transition-colors truncate max-w-[180px]">
                          {metadata.name}
                        </span>
                        {isTLS && (
                          <span title="TLS Enabled">
                            <Lock className="w-3 h-3 text-emerald-400 shrink-0" />
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Namespace */}
                    <td className="py-2.5 px-4 text-slate-400">
                      <span className="bg-slate-800/80 text-slate-300 px-2 py-0.5 rounded text-[11px]">
                        {metadata.namespace || 'default'}
                      </span>
                    </td>

                    {/* Class */}
                    <td className="py-2.5 px-4">
                      <span className="bg-indigo-950/80 border border-indigo-800/50 text-indigo-300 px-2 py-0.5 rounded text-[10px] font-semibold">
                        {ingressClass}
                      </span>
                    </td>

                    {/* Hosts */}
                    <td className="py-2.5 px-4">
                      <div className="flex flex-col gap-1 max-w-[220px]">
                        {displayHosts.slice(0, 2).map((h, hIdx) => {
                          const hasTls = h !== '*' && tlsHosts.has(h);
                          const scheme = hasTls ? 'https' : 'http';
                          return (
                            <div key={hIdx} className="flex items-center gap-1">
                              <span className="text-cyan-300 truncate font-semibold">{h}</span>
                              {h !== '*' && (
                                <a
                                  href={`${scheme}://${h}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="text-slate-500 hover:text-cyan-300 transition-colors"
                                  title={`Open ${scheme}://${h}`}
                                >
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                              )}
                            </div>
                          );
                        })}
                        {displayHosts.length > 2 && (
                          <span className="text-[10px] text-slate-500">
                            +{displayHosts.length - 2} more hosts
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Routing (Paths & Backends) */}
                    <td className="py-2.5 px-4">
                      <div className="space-y-1 max-w-[260px]">
                        {pathsSummary.slice(0, 2).map((p, pIdx) => (
                          <div key={pIdx} className="flex items-center gap-1.5 text-[11px] truncate">
                            <span className="text-cyan-400 font-bold">{p.path}</span>
                            <span className="text-slate-500">→</span>
                            <span className="text-slate-300 font-semibold truncate">{p.target}</span>
                          </div>
                        ))}
                        {pathsSummary.length > 2 && (
                          <span className="text-[10px] text-slate-500 block">
                            +{pathsSummary.length - 2} more rules
                          </span>
                        )}
                        {pathsSummary.length === 0 && (
                          <span className="text-slate-500 italic">No HTTP paths</span>
                        )}
                      </div>
                    </td>

                    {/* Load Balancer Endpoints */}
                    <td className="py-2.5 px-4 text-slate-300">
                      {endpointsList.length > 0 ? (
                        <div className="flex flex-col gap-0.5">
                          {endpointsList.slice(0, 2).map((ep, epIdx) => (
                            <div key={epIdx} className="flex items-center gap-1.5">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                              <span className="text-slate-200 truncate max-w-[180px]">{ep}</span>
                            </div>
                          ))}
                          {endpointsList.length > 2 && (
                            <span className="text-[10px] text-slate-500">
                              +{endpointsList.length - 2} more
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-slate-500">-</span>
                      )}
                    </td>

                    {/* TLS */}
                    <td className="py-2.5 px-4">
                      {isTLS ? (
                        <span className="bg-emerald-950/80 border border-emerald-800/60 text-emerald-400 px-2 py-0.5 rounded text-[10px] font-semibold inline-flex items-center gap-1 font-sans">
                          <Lock className="w-2.5 h-2.5" />
                          <span>{tls[0]?.secretName || 'Configured'}</span>
                        </span>
                      ) : (
                        <span className="text-slate-500 text-[11px] font-sans">HTTP</span>
                      )}
                    </td>

                    {/* Age */}
                    <td className="py-2.5 px-4 text-slate-400">
                      {formatAge(metadata.creationTimestamp)}
                    </td>

                    {/* Actions */}
                    <td className="py-2.5 px-4 text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1 select-none font-sans">
                        {/* View Details */}
                        <button
                          onClick={() => setSelectedIngress(item)}
                          title="Inspect Details"
                          className="p-1.5 text-slate-400 hover:text-cyan-300 hover:bg-slate-800 rounded transition-colors"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>

                        {/* View Manifest */}
                        <button
                          onClick={() =>
                            onOpenManifest(
                              'ingress',
                              metadata.name,
                              metadata.namespace || 'default',
                              currentContext
                            )
                          }
                          title="View/Edit Manifest"
                          className="p-1.5 text-slate-400 hover:text-amber-300 hover:bg-slate-800 rounded transition-colors"
                        >
                          <FileCode className="w-3.5 h-3.5" />
                        </button>

                        {/* Delete */}
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

      {/* Interactive Ingress Detail Modal */}
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
