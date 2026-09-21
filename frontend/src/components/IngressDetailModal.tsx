import React, { useState } from 'react';
import {
  X,
  Pencil,
  Trash2,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  ShieldCheck,
  Tag,
  Server,
  Layers,
  Code
} from 'lucide-react';
import { IngressItem } from '../types/k8s';

interface IngressDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  ingress: IngressItem | null;
  currentContext?: string;
  onOpenManifest?: (kind: string, name: string, namespace: string, context?: string) => void;
  onDelete?: (kind: string, name: string, namespace: string, context?: string) => void;
  onToast?: (message: string, type?: 'success' | 'error') => void;
}

export const IngressDetailModal: React.FC<IngressDetailModalProps> = ({
  isOpen,
  onClose,
  ingress,
  currentContext,
  onOpenManifest,
  onDelete,
  onToast,
}) => {
  const [showMetadata, setShowMetadata] = useState(false);

  if (!isOpen || !ingress) return null;

  const metadata = ingress.metadata;
  const spec = ingress.spec;
  const status = ingress.status;

  const rules = spec?.rules || [];
  const tls = spec?.tls || [];
  const tlsHosts = new Set(tls.flatMap((t) => t.hosts || []));
  const lbEndpoints = status?.loadBalancer?.ingress || [];
  const annotations = metadata.annotations || {};
  const labels = metadata.labels || {};

  return (
    <div className="fixed inset-0 z-50 overflow-hidden select-text">
      {/* Backdrop */}
      <div 
        className="fixed inset-0 bg-black/60 backdrop-blur-[2px] transition-opacity animate-in fade-in duration-150"
        onClick={onClose} 
      />

      {/* Slide-over Drawer */}
      <div className="fixed inset-y-0 right-0 max-w-full flex pl-10 z-50">
        <div className="w-screen max-w-xl md:max-w-2xl bg-slate-900 border-l border-slate-800 shadow-2xl flex flex-col h-full overflow-hidden text-slate-100 animate-in slide-in-from-right duration-200">
          
          {/* Signature Teal Header Bar */}
          <div className="h-14 px-6 bg-teal-600 text-white flex items-center justify-between shrink-0 shadow-md select-none">
            <h2 className="text-base font-bold tracking-wide truncate">
              Ingress: {metadata.name}
            </h2>

            <div className="flex items-center gap-2">
              {onOpenManifest && (
                <button
                  onClick={() => {
                    onOpenManifest('ingress', metadata.name, metadata.namespace || 'default', currentContext);
                    onClose();
                  }}
                  className="p-2 hover:bg-teal-700 rounded-md transition-colors text-white"
                  title="Edit Manifest"
                >
                  <Pencil className="w-4 h-4" />
                </button>
              )}
              {onDelete && (
                <button
                  onClick={() => {
                    onDelete('ingress', metadata.name, metadata.namespace || 'default', currentContext);
                    onClose();
                  }}
                  className="p-2 hover:bg-teal-700 rounded-md transition-colors text-white"
                  title="Delete Ingress"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
              <button
                onClick={onClose}
                className="p-2 hover:bg-teal-700 rounded-md transition-colors text-white ml-1"
                title="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Drawer Body Content */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            {/* If no rules configured */}
            {rules.length === 0 && !spec?.defaultBackend && (
              <div className="p-8 text-center text-slate-400 border border-slate-800 rounded-xl bg-slate-950/40">
                <p className="text-sm font-medium">No routing rules configured for this Ingress.</p>
              </div>
            )}

            {/* List of Hosts & their Path -> Link -> Backends table */}
            {rules.map((rule, idx) => {
              const host = rule.host || '*';
              const isHostTLS = rule.host ? tlsHosts.has(rule.host) : false;
              const scheme = isHostTLS ? 'https' : 'http';
              const paths = rule.http?.paths || [];

              return (
                <div key={idx} className="space-y-3">
                  {/* Host Title */}
                  <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                    <span>Host: {host}</span>
                    {isHostTLS && (
                      <span className="bg-emerald-950 text-emerald-400 border border-emerald-800/60 text-[10px] font-mono px-1.5 py-0.5 rounded font-normal">
                        TLS (HTTPS)
                      </span>
                    )}
                  </h3>

                  {/* Clean 3-Column Table: Path | Link | Backends */}
                  <div className="overflow-x-auto border border-slate-800 rounded-lg bg-slate-950/50 shadow-sm">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead className="bg-slate-800/70 text-slate-300 border-b border-slate-700/80 font-semibold select-none">
                        <tr>
                          <th className="py-2.5 px-4 w-[30%]">Path</th>
                          <th className="py-2.5 px-4 w-[45%]">Link</th>
                          <th className="py-2.5 px-4 w-[25%]">Backends</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60 text-slate-300">
                        {paths.length === 0 ? (
                          <tr>
                            <td colSpan={3} className="py-4 px-4 text-slate-500 italic">
                              No paths configured for this host.
                            </td>
                          </tr>
                        ) : (
                          paths.map((p, pIdx) => {
                            const pathStr = p.path || '/';
                            const fullUrl = host !== '*' ? `${scheme}://${host}${pathStr}` : '';
                            const backendStr = p.backend?.service
                              ? `${p.backend.service.name}:${p.backend.service.port?.number || p.backend.service.port?.name || '80'}`
                              : p.backend?.resource?.name || '-';

                            return (
                              <tr key={pIdx} className="hover:bg-slate-800/40 transition-colors">
                                <td className="py-3 px-4 font-mono text-slate-300 break-all align-top">
                                  {pathStr}
                                </td>
                                <td className="py-3 px-4 break-all align-top">
                                  {fullUrl ? (
                                    <a
                                      href={fullUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-teal-400 hover:text-teal-300 hover:underline font-medium transition-colors inline-block"
                                    >
                                      {fullUrl}
                                    </a>
                                  ) : (
                                    <span className="text-slate-500">-</span>
                                  )}
                                </td>
                                <td className="py-3 px-4 font-mono text-slate-200 break-all align-top">
                                  {backendStr}
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}

            {/* Default Catch-All Backend if configured */}
            {spec?.defaultBackend && (
              <div className="space-y-2 pt-2">
                <h3 className="text-sm font-bold text-slate-100">Default Backend</h3>
                <div className="border border-slate-800 bg-slate-950/50 rounded-lg p-3 text-xs font-mono text-slate-300 flex items-center justify-between">
                  <span>
                    {spec.defaultBackend.service?.name || spec.defaultBackend.resource?.name || 'Unknown'}:
                    {spec.defaultBackend.service?.port?.number || spec.defaultBackend.service?.port?.name || '80'}
                  </span>
                  <span className="text-slate-500 text-[11px] font-sans">Fallback for all unmatched routes</span>
                </div>
              </div>
            )}

            {/* Ingress Details & Metadata Collapsible Section */}
            <div className="border-t border-slate-800/80 pt-4">
              <button
                onClick={() => setShowMetadata(!showMetadata)}
                className="flex items-center gap-2 text-xs font-semibold text-slate-400 hover:text-slate-200 transition-colors select-none"
              >
                {showMetadata ? <ChevronDown className="w-4 h-4 text-teal-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
                <span>Resource Details, Annotations & Endpoints</span>
              </button>

              {showMetadata && (
                <div className="mt-4 space-y-4 text-xs animate-in fade-in duration-150">
                  {/* Load Balancer Endpoints */}
                  <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-3 space-y-1">
                    <span className="text-[11px] uppercase tracking-wider font-semibold text-slate-400 block mb-1">
                      Load Balancers
                    </span>
                    {lbEndpoints.length > 0 ? (
                      <div className="space-y-1 font-mono text-slate-200">
                        {lbEndpoints.map((ep, i) => (
                          <div key={i} className="flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                            <span>{ep.ip || ep.hostname}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className="text-slate-500 italic">No external load balancer IP reported</span>
                    )}
                  </div>

                  {/* TLS Certificates */}
                  {tls.length > 0 && (
                    <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-3 space-y-2">
                      <span className="text-[11px] uppercase tracking-wider font-semibold text-slate-400 block">
                        TLS Configuration
                      </span>
                      {tls.map((t, i) => (
                        <div key={i} className="flex items-center justify-between font-mono text-xs border-b border-slate-800/60 pb-1.5 last:border-0 last:pb-0">
                          <span className="text-slate-400">Secret: <strong className="text-emerald-400">{t.secretName}</strong></span>
                          <span className="text-slate-300">{(t.hosts || []).join(', ') || 'All hosts'}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Annotations */}
                  {Object.keys(annotations).length > 0 && (
                    <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-3 space-y-2">
                      <span className="text-[11px] uppercase tracking-wider font-semibold text-slate-400 block">
                        Annotations ({Object.keys(annotations).length})
                      </span>
                      <div className="space-y-1.5 font-mono text-[11px] max-h-48 overflow-y-auto">
                        {Object.entries(annotations).map(([k, v]) => (
                          <div key={k} className="p-1.5 bg-slate-900/60 rounded border border-slate-800/60">
                            <span className="text-teal-400 font-semibold block break-all">{k}</span>
                            <span className="text-slate-300 block break-all mt-0.5 select-all">{v}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

          </div>
        </div>
      </div>
    </div>
  );
};
