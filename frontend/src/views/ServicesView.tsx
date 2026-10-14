import React from 'react';
import { Network, FileCode, Trash2 } from 'lucide-react';
import { ServiceItem } from '../types/k8s';

interface ServicesViewProps {
  services: ServiceItem[];
  searchQuery: string;
  onOpenManifest: (kind: string, name: string, namespace: string) => void;
  onDelete: (kind: string, name: string, namespace: string) => void;
}

export const ServicesView: React.FC<ServicesViewProps> = ({
  services,
  searchQuery,
  onOpenManifest,
  onDelete,
}) => {
  const filtered = services.filter((s) => {
    const name = s.metadata.name.toLowerCase();
    const ns = (s.metadata.namespace || '').toLowerCase();
    const q = searchQuery.toLowerCase();
    return name.includes(q) || ns.includes(q);
  });

  return (
    <div className="h-full flex flex-col overflow-hidden select-text">
      {/* Header */}
      <div className="px-6 py-3 border-b border-slate-800 bg-slate-900/40 flex items-center justify-between text-xs text-slate-400 select-none">
        <div className="flex items-center gap-2 font-medium">
          <Network className="w-4 h-4 text-cyan-400" />
          <span className="text-slate-200">Services</span>
          <span className="bg-slate-800 text-slate-400 px-2 py-0.5 rounded font-mono text-[11px]">
            {filtered.length} of {services.length}
          </span>
        </div>
        <span className="text-[11px] text-slate-400 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
          Internal network endpoints, load balancing & cluster IPs
        </span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead className="bg-slate-950/80 text-slate-400 sticky top-0 z-10 border-b border-slate-800 select-none backdrop-blur-sm">
            <tr>
              <th className="py-2.5 px-4 font-semibold">Name</th>
              <th className="py-2.5 px-4 font-semibold">Namespace</th>
              <th className="py-2.5 px-4 font-semibold">Type</th>
              <th className="py-2.5 px-4 font-semibold">Cluster IP</th>
              <th className="py-2.5 px-4 font-semibold">Ports</th>
              <th className="py-2.5 px-4 font-semibold">External IP</th>
              <th className="py-2.5 px-4 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50 font-mono text-slate-300">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-12 text-center text-slate-500 italic">
                  No services found.
                </td>
              </tr>
            ) : (
              filtered.map((svc) => {
                const ports = svc.spec.ports?.map((p) => `${p.port}/${p.protocol}`).join(', ') || 'None';
                const extIp = svc.status?.loadBalancer?.ingress?.[0]?.ip || svc.status?.loadBalancer?.ingress?.[0]?.hostname || '-';

                return (
                  <tr key={svc.metadata.uid || svc.metadata.name} className="hover:bg-slate-800/40 transition-colors">
                    <td className="py-2.5 px-4 font-medium text-slate-100 flex items-center gap-2">
                      <Network className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                      <span className="truncate max-w-xs">{svc.metadata.name}</span>
                    </td>
                    <td className="py-2.5 px-4 text-slate-400">
                      <span className="bg-slate-800/80 text-slate-300 px-2 py-0.5 rounded text-[11px]">
                        {svc.metadata.namespace}
                      </span>
                    </td>
                    <td className="py-2.5 px-4">
                      <span className="bg-cyan-950 text-cyan-400 border border-cyan-800/60 px-2 py-0.5 rounded text-[10px] font-semibold">
                        {svc.spec.type}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-slate-300">{svc.spec.clusterIP || 'None'}</td>
                    <td className="py-2.5 px-4 text-slate-300">{ports}</td>
                    <td className="py-2.5 px-4 text-slate-400">{extIp}</td>
                    <td className="py-2.5 px-4 text-right">
                      <div className="flex items-center justify-end gap-1 font-sans">
                        <button
                          onClick={() => onOpenManifest('services', svc.metadata.name, svc.metadata.namespace || 'default')}
                          className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-cyan-300 transition-colors cursor-pointer"
                          title="View YAML Manifest"
                        >
                          <FileCode className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => onDelete('service', svc.metadata.name, svc.metadata.namespace || 'default')}
                          className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-rose-400 transition-colors cursor-pointer"
                          title="Delete Service"
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
    </div>
  );
};
