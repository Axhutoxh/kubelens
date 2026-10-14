import React, { useState } from 'react';
import { 
  Database, 
  HardDrive, 
  Layers, 
  FileCode, 
  Trash2, 
  CheckCircle2, 
  AlertCircle, 
  Clock,
  Check
} from 'lucide-react';
import { PersistentVolumeClaimItem, PersistentVolumeItem, StorageClassItem } from '../types/k8s';

interface StorageViewProps {
  pvcs: PersistentVolumeClaimItem[];
  pvs: PersistentVolumeItem[];
  storageClasses: StorageClassItem[];
  searchQuery: string;
  onOpenManifest: (kind: string, name: string, namespace?: string) => void;
  onDelete: (kind: string, name: string, namespace?: string) => void;
}

export const StorageView: React.FC<StorageViewProps> = ({
  pvcs,
  pvs,
  storageClasses,
  searchQuery,
  onOpenManifest,
  onDelete,
}) => {
  const [activeTab, setActiveTab] = useState<'pvcs' | 'pvs' | 'classes'>('pvcs');

  const filteredPvcs = pvcs.filter((p) => {
    const name = p.metadata.name.toLowerCase();
    const ns = (p.metadata.namespace || '').toLowerCase();
    const q = searchQuery.toLowerCase();
    return name.includes(q) || ns.includes(q);
  });

  const filteredPvs = pvs.filter((p) => {
    const name = p.metadata.name.toLowerCase();
    const q = searchQuery.toLowerCase();
    return name.includes(q);
  });

  const filteredClasses = storageClasses.filter((c) => {
    const name = c.metadata.name.toLowerCase();
    const prov = (c.provisioner || '').toLowerCase();
    const q = searchQuery.toLowerCase();
    return name.includes(q) || prov.includes(q);
  });

  return (
    <div className="h-full flex flex-col overflow-hidden select-text">
      {/* Header & Tabs */}
      <div className="px-6 py-3 border-b border-slate-800 bg-slate-900/40 flex items-center justify-between text-xs text-slate-400 select-none">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 font-medium">
            <Database className="w-4 h-4 text-cyan-400" />
            <span className="text-slate-200">Storage Management</span>
          </div>

          <div className="flex bg-slate-950 p-0.5 rounded-lg border border-slate-800">
            <button
              onClick={() => setActiveTab('pvcs')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'pvcs'
                  ? 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/20'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span>Volume Claims (PVCs)</span>
              <span className="bg-slate-800 text-slate-400 px-1.5 py-0.2 rounded text-[10px] font-mono">
                {pvcs.length}
              </span>
            </button>
            <button
              onClick={() => setActiveTab('pvs')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'pvs'
                  ? 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/20'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span>Persistent Volumes</span>
              <span className="bg-slate-800 text-slate-400 px-1.5 py-0.2 rounded text-[10px] font-mono">
                {pvs.length}
              </span>
            </button>
            <button
              onClick={() => setActiveTab('classes')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'classes'
                  ? 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/20'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span>Storage Classes</span>
              <span className="bg-slate-800 text-slate-400 px-1.5 py-0.2 rounded text-[10px] font-mono">
                {storageClasses.length}
              </span>
            </button>
          </div>
        </div>

        <span className="text-[11px] text-slate-400 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          Cluster storage abstractions, claim bindings & volume provisioners
        </span>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-auto">
        {activeTab === 'pvcs' && (
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-slate-950/80 text-slate-400 sticky top-0 z-10 border-b border-slate-800 select-none backdrop-blur-sm">
              <tr>
                <th className="py-2.5 px-4 font-semibold">Name</th>
                <th className="py-2.5 px-4 font-semibold">Namespace</th>
                <th className="py-2.5 px-4 font-semibold">Status</th>
                <th className="py-2.5 px-4 font-semibold">Volume</th>
                <th className="py-2.5 px-4 font-semibold">Capacity</th>
                <th className="py-2.5 px-4 font-semibold">Access Modes</th>
                <th className="py-2.5 px-4 font-semibold">Storage Class</th>
                <th className="py-2.5 px-4 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50 font-mono text-slate-300">
              {filteredPvcs.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-slate-500 italic">
                    No PersistentVolumeClaims found.
                  </td>
                </tr>
              ) : (
                filteredPvcs.map((pvc) => {
                  const status = pvc.status?.phase || 'Pending';
                  const capacity = pvc.status?.capacity?.storage || pvc.spec?.resources?.requests?.storage || '-';
                  const accessModes = (pvc.status?.accessModes || pvc.spec?.accessModes || []).join(', ') || '-';
                  const isBound = status === 'Bound';

                  return (
                    <tr key={pvc.metadata.uid || pvc.metadata.name} className="hover:bg-slate-800/40 transition-colors">
                      <td className="py-2.5 px-4 font-medium text-slate-100 flex items-center gap-2">
                        <HardDrive className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                        <span className="truncate max-w-xs">{pvc.metadata.name}</span>
                      </td>
                      <td className="py-2.5 px-4 text-slate-400">
                        <span className="bg-slate-800/80 text-slate-300 px-2 py-0.5 rounded text-[11px]">
                          {pvc.metadata.namespace}
                        </span>
                      </td>
                      <td className="py-2.5 px-4">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-semibold border flex items-center gap-1 w-max ${
                          isBound
                            ? 'bg-emerald-950 text-emerald-400 border-emerald-800/80'
                            : 'bg-amber-950 text-amber-400 border-amber-800/80'
                        }`}>
                          {isBound ? <CheckCircle2 className="w-2.5 h-2.5" /> : <Clock className="w-2.5 h-2.5" />}
                          <span>{status}</span>
                        </span>
                      </td>
                      <td className="py-2.5 px-4 text-slate-300 truncate max-w-[150px]" title={pvc.spec?.volumeName}>
                        {pvc.spec?.volumeName || '-'}
                      </td>
                      <td className="py-2.5 px-4 text-cyan-300 font-semibold">{capacity}</td>
                      <td className="py-2.5 px-4 text-slate-400 font-sans text-[11px]">{accessModes}</td>
                      <td className="py-2.5 px-4 text-slate-300">{pvc.spec?.storageClassName || '-'}</td>
                      <td className="py-2.5 px-4 text-right">
                        <div className="flex items-center justify-end gap-1 font-sans">
                          <button
                            onClick={() => onOpenManifest('persistentvolumeclaims', pvc.metadata.name, pvc.metadata.namespace || 'default')}
                            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-cyan-300 transition-colors cursor-pointer"
                            title="View YAML Manifest"
                          >
                            <FileCode className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => onDelete('persistentvolumeclaim', pvc.metadata.name, pvc.metadata.namespace || 'default')}
                            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-rose-400 transition-colors cursor-pointer"
                            title="Delete PVC"
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
        )}

        {activeTab === 'pvs' && (
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-slate-950/80 text-slate-400 sticky top-0 z-10 border-b border-slate-800 select-none backdrop-blur-sm">
              <tr>
                <th className="py-2.5 px-4 font-semibold">Name</th>
                <th className="py-2.5 px-4 font-semibold">Capacity</th>
                <th className="py-2.5 px-4 font-semibold">Access Modes</th>
                <th className="py-2.5 px-4 font-semibold">Reclaim Policy</th>
                <th className="py-2.5 px-4 font-semibold">Status</th>
                <th className="py-2.5 px-4 font-semibold">Claim</th>
                <th className="py-2.5 px-4 font-semibold">Storage Class</th>
                <th className="py-2.5 px-4 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50 font-mono text-slate-300">
              {filteredPvs.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-slate-500 italic">
                    No PersistentVolumes found.
                  </td>
                </tr>
              ) : (
                filteredPvs.map((pv) => {
                  const capacity = pv.spec?.capacity?.storage || '-';
                  const accessModes = (pv.spec?.accessModes || []).join(', ') || '-';
                  const status = pv.status?.phase || 'Available';
                  const isBound = status === 'Bound';
                  const claim = pv.spec?.claimRef 
                    ? `${pv.spec.claimRef.namespace}/${pv.spec.claimRef.name}`
                    : '-';

                  return (
                    <tr key={pv.metadata.uid || pv.metadata.name} className="hover:bg-slate-800/40 transition-colors">
                      <td className="py-2.5 px-4 font-medium text-slate-100 flex items-center gap-2">
                        <Database className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                        <span className="truncate max-w-xs">{pv.metadata.name}</span>
                      </td>
                      <td className="py-2.5 px-4 text-cyan-300 font-semibold">{capacity}</td>
                      <td className="py-2.5 px-4 text-slate-400 font-sans text-[11px]">{accessModes}</td>
                      <td className="py-2.5 px-4 text-slate-300">{pv.spec?.persistentVolumeReclaimPolicy || 'Retain'}</td>
                      <td className="py-2.5 px-4">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-semibold border flex items-center gap-1 w-max ${
                          isBound
                            ? 'bg-emerald-950 text-emerald-400 border-emerald-800/80'
                            : 'bg-blue-950 text-blue-400 border-blue-800/80'
                        }`}>
                          {isBound ? <CheckCircle2 className="w-2.5 h-2.5" /> : <Clock className="w-2.5 h-2.5" />}
                          <span>{status}</span>
                        </span>
                      </td>
                      <td className="py-2.5 px-4 text-slate-300 truncate max-w-[150px]" title={claim}>
                        {claim}
                      </td>
                      <td className="py-2.5 px-4 text-slate-300">{pv.spec?.storageClassName || '-'}</td>
                      <td className="py-2.5 px-4 text-right">
                        <div className="flex items-center justify-end gap-1 font-sans">
                          <button
                            onClick={() => onOpenManifest('persistentvolumes', pv.metadata.name)}
                            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-cyan-300 transition-colors cursor-pointer"
                            title="View YAML Manifest"
                          >
                            <FileCode className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => onDelete('persistentvolume', pv.metadata.name)}
                            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-rose-400 transition-colors cursor-pointer"
                            title="Delete PV"
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
        )}

        {activeTab === 'classes' && (
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-slate-950/80 text-slate-400 sticky top-0 z-10 border-b border-slate-800 select-none backdrop-blur-sm">
              <tr>
                <th className="py-2.5 px-4 font-semibold">Name</th>
                <th className="py-2.5 px-4 font-semibold">Provisioner</th>
                <th className="py-2.5 px-4 font-semibold">Reclaim Policy</th>
                <th className="py-2.5 px-4 font-semibold">Volume Binding Mode</th>
                <th className="py-2.5 px-4 font-semibold">Allow Expansion</th>
                <th className="py-2.5 px-4 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50 font-mono text-slate-300">
              {filteredClasses.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-slate-500 italic">
                    No StorageClasses found.
                  </td>
                </tr>
              ) : (
                filteredClasses.map((sc) => {
                  const isDefault = sc.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true';

                  return (
                    <tr key={sc.metadata.uid || sc.metadata.name} className="hover:bg-slate-800/40 transition-colors">
                      <td className="py-2.5 px-4 font-medium text-slate-100 flex items-center gap-2">
                        <Layers className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                        <span className="truncate max-w-xs">{sc.metadata.name}</span>
                        {isDefault && (
                          <span className="bg-amber-950 text-amber-300 border border-amber-800/60 text-[9px] px-1.5 py-0.2 rounded font-sans uppercase font-bold">
                            Default
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-4 text-cyan-300">{sc.provisioner}</td>
                      <td className="py-2.5 px-4 text-slate-300">{sc.reclaimPolicy || 'Delete'}</td>
                      <td className="py-2.5 px-4 text-slate-400 font-sans text-[11px]">{sc.volumeBindingMode || 'Immediate'}</td>
                      <td className="py-2.5 px-4 text-slate-300">
                        {sc.allowVolumeExpansion ? (
                          <span className="text-emerald-400 flex items-center gap-1"><Check className="w-3 h-3" /> Yes</span>
                        ) : 'No'}
                      </td>
                      <td className="py-2.5 px-4 text-right">
                        <div className="flex items-center justify-end gap-1 font-sans">
                          <button
                            onClick={() => onOpenManifest('storageclasses', sc.metadata.name)}
                            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-cyan-300 transition-colors cursor-pointer"
                            title="View YAML Manifest"
                          >
                            <FileCode className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => onDelete('storageclass', sc.metadata.name)}
                            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-rose-400 transition-colors cursor-pointer"
                            title="Delete StorageClass"
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
        )}
      </div>
    </div>
  );
};
