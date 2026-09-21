import React, { useState, useMemo } from 'react';
import {
  X,
  Network,
  Globe,
  Lock,
  Unlock,
  ExternalLink,
  Copy,
  Check,
  FileCode,
  Trash2,
  Tag,
  Search,
  CheckCircle2,
  AlertCircle,
  Clock,
  Layers,
  ArrowRight,
  ShieldCheck,
  Server,
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
  const [activeTab, setActiveTab] = useState<'rules' | 'tls' | 'endpoints' | 'annotations' | 'yaml'>('rules');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [annotationFilter, setAnnotationFilter] = useState('');

  if (!isOpen || !ingress) return null;

  const metadata = ingress.metadata;
  const spec = ingress.spec;
  const status = ingress.status;

  const ingressClass =
    spec?.ingressClassName ||
    metadata.annotations?.['kubernetes.io/ingress.class'] ||
    'default';

  const rules = spec?.rules || [];
  const tls = spec?.tls || [];
  const lbEndpoints = status?.loadBalancer?.ingress || [];
  const annotations = metadata.annotations || {};
  const labels = metadata.labels || {};

  const isTLSEnabled = tls.length > 0;
  const tlsHosts = new Set(tls.flatMap((t) => t.hosts || []));

  const copyToClipboard = (text: string, keyName: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(keyName);
    if (onToast) onToast(`Copied ${keyName} to clipboard`);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const filteredAnnotations = Object.entries(annotations).filter(([key, val]) => {
    if (!annotationFilter) return true;
    const q = annotationFilter.toLowerCase();
    return key.toLowerCase().includes(q) || val.toLowerCase().includes(q);
  });

  // Calculate age string
  const age = metadata.creationTimestamp
    ? new Date(metadata.creationTimestamp).toLocaleString()
    : 'Unknown';

  // Build clean YAML representation for quick view
  const yamlContent = useMemo(() => {
    try {
      return JSON.stringify(ingress, null, 2);
    } catch {
      return '';
    }
  }, [ingress]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150 select-text">
      <div className="bg-slate-900 border border-slate-800 rounded-xl shadow-2xl w-full max-w-4xl h-[85vh] flex flex-col overflow-hidden text-slate-100">
        {/* Header */}
        <div className="p-4 px-6 border-b border-slate-800 bg-slate-950/40 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2.5 rounded-lg bg-cyan-950/80 border border-cyan-800/60 text-cyan-400 shrink-0">
              <Network className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-slate-100 truncate">{metadata.name}</h2>
                <button
                  onClick={() => copyToClipboard(metadata.name, 'Ingress Name')}
                  className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 transition-colors"
                  title="Copy Name"
                >
                  {copiedKey === 'Ingress Name' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
              <div className="flex items-center gap-2 text-xs text-slate-400 font-mono mt-0.5 flex-wrap">
                <span className="bg-slate-800 px-2 py-0.5 rounded text-slate-300">
                  ns: {metadata.namespace || 'default'}
                </span>
                <span className="bg-indigo-950/70 border border-indigo-800/50 text-indigo-300 px-2 py-0.5 rounded">
                  class: {ingressClass}
                </span>
                {isTLSEnabled ? (
                  <span className="bg-emerald-950/80 border border-emerald-800/60 text-emerald-300 px-2 py-0.5 rounded flex items-center gap-1">
                    <Lock className="w-3 h-3" /> TLS Active
                  </span>
                ) : (
                  <span className="bg-slate-800 text-slate-400 px-2 py-0.5 rounded flex items-center gap-1">
                    <Unlock className="w-3 h-3" /> HTTP Only
                  </span>
                )}
                <span className="text-slate-400 flex items-center gap-1">
                  <Clock className="w-3 h-3" /> {age}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {onOpenManifest && (
              <button
                onClick={() => {
                  onOpenManifest('ingress', metadata.name, metadata.namespace || 'default', currentContext);
                  onClose();
                }}
                className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-amber-300 rounded text-xs font-medium transition-colors"
                title="View/Edit in Dock"
              >
                <FileCode className="w-3.5 h-3.5" />
                <span>Manifest</span>
              </button>
            )}
            {onDelete && (
              <button
                onClick={() => {
                  onDelete('ingress', metadata.name, metadata.namespace || 'default', currentContext);
                  onClose();
                }}
                className="flex items-center gap-1.5 px-2.5 py-1.5 bg-rose-950/80 hover:bg-rose-900 border border-rose-800/60 text-rose-300 rounded text-xs font-medium transition-colors"
                title="Delete Ingress"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Delete</span>
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-slate-200 transition-colors ml-1"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="px-6 border-b border-slate-800 bg-slate-950/20 flex gap-1 text-xs select-none">
          <button
            onClick={() => setActiveTab('rules')}
            className={`py-3 px-3.5 font-medium border-b-2 flex items-center gap-2 transition-colors ${
              activeTab === 'rules'
                ? 'border-cyan-400 text-cyan-400 font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Globe className="w-3.5 h-3.5" />
            <span>Rules & Routing</span>
            <span className="bg-slate-800 text-slate-400 px-1.5 py-0.2 rounded text-[10px] font-mono">
              {rules.length}
            </span>
          </button>

          <button
            onClick={() => setActiveTab('tls')}
            className={`py-3 px-3.5 font-medium border-b-2 flex items-center gap-2 transition-colors ${
              activeTab === 'tls'
                ? 'border-cyan-400 text-cyan-400 font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>TLS Certificates</span>
            <span className="bg-slate-800 text-slate-400 px-1.5 py-0.2 rounded text-[10px] font-mono">
              {tls.length}
            </span>
          </button>

          <button
            onClick={() => setActiveTab('endpoints')}
            className={`py-3 px-3.5 font-medium border-b-2 flex items-center gap-2 transition-colors ${
              activeTab === 'endpoints'
                ? 'border-cyan-400 text-cyan-400 font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Server className="w-3.5 h-3.5" />
            <span>Load Balancer & Status</span>
            <span className="bg-slate-800 text-slate-400 px-1.5 py-0.2 rounded text-[10px] font-mono">
              {lbEndpoints.length}
            </span>
          </button>

          <button
            onClick={() => setActiveTab('annotations')}
            className={`py-3 px-3.5 font-medium border-b-2 flex items-center gap-2 transition-colors ${
              activeTab === 'annotations'
                ? 'border-cyan-400 text-cyan-400 font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Tag className="w-3.5 h-3.5" />
            <span>Annotations & Labels</span>
            <span className="bg-slate-800 text-slate-400 px-1.5 py-0.2 rounded text-[10px] font-mono">
              {Object.keys(annotations).length}
            </span>
          </button>

          <button
            onClick={() => setActiveTab('yaml')}
            className={`py-3 px-3.5 font-medium border-b-2 flex items-center gap-2 transition-colors ${
              activeTab === 'yaml'
                ? 'border-cyan-400 text-cyan-400 font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Code className="w-3.5 h-3.5" />
            <span>Raw JSON / YAML</span>
          </button>
        </div>

        {/* Tab Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* TAB 1: RULES & ROUTING */}
          {activeTab === 'rules' && (
            <div className="space-y-4">
              {rules.length === 0 && !spec?.defaultBackend && (
                <div className="p-8 text-center text-slate-400 border border-slate-800/80 rounded-xl bg-slate-950/30">
                  <AlertCircle className="w-8 h-8 mx-auto mb-2 text-slate-500" />
                  <p className="text-sm font-medium">No routing rules or default backend configured.</p>
                </div>
              )}

              {rules.map((rule, idx) => {
                const host = rule.host || '* (All Hosts)';
                const isHostTLS = rule.host ? tlsHosts.has(rule.host) : false;
                const scheme = isHostTLS ? 'https' : 'http';
                const paths = rule.http?.paths || [];

                return (
                  <div key={idx} className="bg-slate-950/60 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
                    {/* Host Header */}
                    <div className="px-4 py-3 bg-slate-900/80 border-b border-slate-800 flex items-center justify-between">
                      <div className="flex items-center gap-2 font-mono text-xs">
                        <Globe className="w-4 h-4 text-cyan-400" />
                        <span className="font-bold text-slate-200 text-sm">{host}</span>
                        {isHostTLS ? (
                          <span className="bg-emerald-950 text-emerald-400 border border-emerald-800/60 px-2 py-0.5 rounded text-[10px] flex items-center gap-1 font-sans">
                            <Lock className="w-2.5 h-2.5" /> HTTPS
                          </span>
                        ) : (
                          <span className="bg-slate-800 text-slate-400 px-2 py-0.5 rounded text-[10px] font-sans">
                            HTTP
                          </span>
                        )}
                      </div>

                      {rule.host && rule.host !== '*' && (
                        <a
                          href={`${scheme}://${rule.host}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300 bg-cyan-950/60 border border-cyan-800/50 px-2.5 py-1 rounded transition-colors font-medium"
                        >
                          <span>Open Host</span>
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>

                    {/* Paths Table */}
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs border-collapse font-mono">
                        <thead className="bg-slate-900/40 text-slate-400 border-b border-slate-800/80">
                          <tr>
                            <th className="py-2.5 px-4 font-semibold">Path</th>
                            <th className="py-2.5 px-4 font-semibold">Path Type</th>
                            <th className="py-2.5 px-4 font-semibold">Target Backend</th>
                            <th className="py-2.5 px-4 font-semibold text-right">Action</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/40">
                          {paths.length === 0 ? (
                            <tr>
                              <td colSpan={4} className="py-4 px-4 text-slate-500 italic">
                                No specific paths configured for this host rule.
                              </td>
                            </tr>
                          ) : (
                            paths.map((p, pIdx) => {
                              const pathStr = p.path || '/';
                              const serviceName = p.backend?.service?.name;
                              const servicePort =
                                p.backend?.service?.port?.number ||
                                p.backend?.service?.port?.name ||
                                'default';
                              const resourceName = p.backend?.resource?.name;

                              return (
                                <tr key={pIdx} className="hover:bg-slate-800/30 transition-colors">
                                  <td className="py-2.5 px-4 font-bold text-cyan-300">
                                    {pathStr}
                                  </td>
                                  <td className="py-2.5 px-4 text-slate-400">
                                    <span className="bg-slate-800/80 text-slate-300 px-2 py-0.5 rounded text-[11px]">
                                      {p.pathType || 'ImplementationSpecific'}
                                    </span>
                                  </td>
                                  <td className="py-2.5 px-4">
                                    {serviceName ? (
                                      <div className="flex items-center gap-1.5">
                                        <Layers className="w-3.5 h-3.5 text-indigo-400" />
                                        <span className="text-slate-100 font-semibold">{serviceName}</span>
                                        <span className="text-slate-400">:</span>
                                        <span className="text-emerald-400">{servicePort}</span>
                                      </div>
                                    ) : resourceName ? (
                                      <div className="flex items-center gap-1.5 text-amber-300">
                                        <span>Resource: {resourceName}</span>
                                      </div>
                                    ) : (
                                      <span className="text-slate-500">-</span>
                                    )}
                                  </td>
                                  <td className="py-2.5 px-4 text-right">
                                    {rule.host && rule.host !== '*' && (
                                      <a
                                        href={`${scheme}://${rule.host}${pathStr}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-cyan-300 transition-colors"
                                      >
                                        <span>Visit</span>
                                        <ExternalLink className="w-3 h-3" />
                                      </a>
                                    )}
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

              {/* Default Backend Section */}
              {spec?.defaultBackend && (
                <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-1.5">
                    <ArrowRight className="w-3.5 h-3.5 text-cyan-400" />
                    Default Catch-All Backend
                  </h3>
                  <div className="bg-slate-900 border border-slate-800 p-3 rounded-lg flex items-center justify-between font-mono text-xs">
                    <div className="flex items-center gap-2">
                      <Layers className="w-4 h-4 text-indigo-400" />
                      <span className="font-semibold text-slate-100">
                        {spec.defaultBackend.service?.name || spec.defaultBackend.resource?.name || 'Unknown'}
                      </span>
                      <span className="text-slate-400">:</span>
                      <span className="text-emerald-400">
                        {spec.defaultBackend.service?.port?.number || spec.defaultBackend.service?.port?.name || 'default'}
                      </span>
                    </div>
                    <span className="text-[11px] text-slate-400 font-sans">
                      Handles all unmatched requests
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: TLS CERTIFICATES */}
          {activeTab === 'tls' && (
            <div className="space-y-4">
              {tls.length === 0 ? (
                <div className="p-8 text-center text-slate-400 border border-slate-800/80 rounded-xl bg-slate-950/30">
                  <Unlock className="w-8 h-8 mx-auto mb-2 text-slate-500" />
                  <p className="text-sm font-medium">No TLS certificates configured for this Ingress.</p>
                  <p className="text-xs text-slate-400 mt-1">Traffic is currently handled over unencrypted plain HTTP.</p>
                </div>
              ) : (
                tls.map((t, idx) => (
                  <div key={idx} className="bg-slate-950/60 border border-slate-800 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                      <div className="flex items-center gap-2">
                        <ShieldCheck className="w-4 h-4 text-emerald-400" />
                        <span className="text-xs text-slate-400">TLS Secret:</span>
                        <span className="text-xs font-mono font-bold text-emerald-300 bg-emerald-950/70 border border-emerald-800/60 px-2 py-0.5 rounded">
                          {t.secretName || 'Default Cert'}
                        </span>
                        {t.secretName && (
                          <button
                            onClick={() => copyToClipboard(t.secretName!, 'TLS Secret')}
                            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 transition-colors"
                            title="Copy Secret Name"
                          >
                            {copiedKey === 'TLS Secret' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                          </button>
                        )}
                      </div>
                      <span className="text-[11px] text-emerald-400 flex items-center gap-1 font-medium">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Certificate Configured
                      </span>
                    </div>

                    <div>
                      <span className="text-xs text-slate-400 block mb-1.5">Protected Hosts:</span>
                      <div className="flex flex-wrap gap-2">
                        {(t.hosts && t.hosts.length > 0) ? (
                          t.hosts.map((h, hIdx) => (
                            <span key={hIdx} className="bg-slate-900 border border-slate-800 text-cyan-300 px-2.5 py-1 rounded text-xs font-mono flex items-center gap-1">
                              <Globe className="w-3 h-3 text-cyan-400" />
                              {h}
                            </span>
                          ))
                        ) : (
                          <span className="text-xs text-slate-500 italic">All hosts covered by wildcard/secret</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* TAB 3: LOAD BALANCER & STATUS */}
          {activeTab === 'endpoints' && (
            <div className="space-y-4">
              <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4 space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                  <Server className="w-3.5 h-3.5 text-cyan-400" />
                  Assigned External Endpoints (Load Balancer Status)
                </h3>

                {lbEndpoints.length === 0 ? (
                  <div className="p-6 text-center text-slate-500 border border-dashed border-slate-800 rounded-lg">
                    <p className="text-xs">No external load balancer IP or hostname assigned yet.</p>
                    <p className="text-[11px] text-slate-400 mt-1">
                      Check that your Ingress Controller (e.g. ingress-nginx, AWS Load Balancer Controller) is running and configured.
                    </p>
                  </div>
                ) : (
                  <div className="divide-y divide-slate-800 font-mono text-xs">
                    {lbEndpoints.map((ep, idx) => {
                      const val = ep.ip || ep.hostname || 'Unknown';
                      return (
                        <div key={idx} className="py-2.5 flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-emerald-500" />
                            <span className="font-semibold text-slate-200">{val}</span>
                            {ep.ip && (
                              <span className="bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded text-[10px]">
                                IP
                              </span>
                            )}
                            {ep.hostname && (
                              <span className="bg-indigo-950 text-indigo-300 border border-indigo-800/50 px-1.5 py-0.5 rounded text-[10px]">
                                Hostname
                              </span>
                            )}
                          </div>
                          <button
                            onClick={() => copyToClipboard(val, `Endpoint ${idx}`)}
                            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 transition-colors"
                            title="Copy Endpoint"
                          >
                            {copiedKey === `Endpoint ${idx}` ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Ingress Class Configuration Card */}
              <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4 space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Ingress Controller Details
                </h3>
                <div className="grid grid-cols-2 gap-3 text-xs font-mono mt-2">
                  <div className="bg-slate-900 border border-slate-800 p-2.5 rounded-lg">
                    <span className="text-slate-400 block text-[11px]">spec.ingressClassName</span>
                    <span className="text-slate-200 font-semibold">{spec?.ingressClassName || '(Not set)'}</span>
                  </div>
                  <div className="bg-slate-900 border border-slate-800 p-2.5 rounded-lg">
                    <span className="text-slate-400 block text-[11px]">kubernetes.io/ingress.class annotation</span>
                    <span className="text-slate-200 font-semibold">
                      {metadata.annotations?.['kubernetes.io/ingress.class'] || '(None)'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: ANNOTATIONS & LABELS */}
          {activeTab === 'annotations' && (
            <div className="space-y-4">
              {/* Search Bar */}
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-500" />
                <input
                  type="text"
                  placeholder="Filter annotations..."
                  value={annotationFilter}
                  onChange={(e) => setAnnotationFilter(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-9 pr-4 py-2 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 transition-colors"
                />
              </div>

              {/* Annotations List */}
              <div className="bg-slate-950/60 border border-slate-800 rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 bg-slate-900/60 border-b border-slate-800 text-xs font-semibold text-slate-400 flex items-center justify-between">
                  <span>Annotations ({filteredAnnotations.length})</span>
                </div>
                <div className="divide-y divide-slate-800/60 max-h-72 overflow-y-auto font-mono text-xs">
                  {filteredAnnotations.length === 0 ? (
                    <div className="p-4 text-center text-slate-500 italic">No annotations found.</div>
                  ) : (
                    filteredAnnotations.map(([key, val]) => (
                      <div key={key} className="p-3 hover:bg-slate-900/40 flex items-start justify-between gap-3 group">
                        <div className="min-w-0 flex-1">
                          <span className="text-cyan-400 font-semibold break-all block">{key}</span>
                          <span className="text-slate-300 break-all text-[11px] block mt-0.5 select-all">{val}</span>
                        </div>
                        <button
                          onClick={() => copyToClipboard(val, key)}
                          className="p-1 text-slate-500 hover:text-slate-300 hover:bg-slate-800 rounded opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                          title="Copy Value"
                        >
                          {copiedKey === key ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Labels Section */}
              <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2.5">
                  Labels ({Object.keys(labels).length})
                </h3>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(labels).length === 0 ? (
                    <span className="text-xs text-slate-500 italic">No labels attached.</span>
                  ) : (
                    Object.entries(labels).map(([k, v]) => (
                      <span key={k} className="bg-slate-900 border border-slate-800 text-xs font-mono px-2.5 py-1 rounded-lg text-slate-300 flex items-center gap-1.5">
                        <Tag className="w-3 h-3 text-cyan-400" />
                        <span className="text-slate-400">{k}:</span>
                        <span className="text-cyan-300 font-medium">{v}</span>
                      </span>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}

          {/* TAB 5: RAW JSON / YAML */}
          {activeTab === 'yaml' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-400 font-mono">Resource Definition</span>
                <button
                  onClick={() => copyToClipboard(yamlContent, 'YAML Content')}
                  className="flex items-center gap-1 text-xs text-slate-300 hover:text-cyan-300 bg-slate-800 px-2.5 py-1 rounded transition-colors"
                >
                  {copiedKey === 'YAML Content' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>Copy JSON/YAML</span>
                </button>
              </div>
              <pre className="p-4 bg-slate-950 border border-slate-800 rounded-xl font-mono text-xs text-cyan-300/90 overflow-x-auto max-h-[50vh] leading-relaxed">
                {yamlContent}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
