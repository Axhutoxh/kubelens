import React, { useMemo, useRef, useState, useEffect } from 'react';
import { 
  Box, 
  Terminal, 
  FileCode, 
  Trash2, 
  CheckCircle2, 
  AlertCircle, 
  Clock,
  Radio,
  Tag,
  SquareTerminal,
  Rows3,
  Copy,
  X
} from 'lucide-react';
import { PodItem, PortForwardSession } from '../types/k8s';
import { PodMetric } from '../api/client';
import { parseImageTag } from '../components/PodDetailModal';
import { ColumnDef, ColumnPicker, useColumnVisibility } from '../components/ColumnPicker';

const POD_COLUMNS: ColumnDef[] = [
  { id: 'name', label: 'Name', locked: true },
  { id: 'namespace', label: 'Namespace' },
  { id: 'image', label: 'Image Tag' },
  { id: 'status', label: 'Status' },
  { id: 'ready', label: 'Ready' },
  { id: 'restarts', label: 'Restarts' },
  { id: 'cpu', label: 'CPU' },
  { id: 'memory', label: 'Memory' },
  { id: 'node', label: 'Node' },
  { id: 'ip', label: 'IP' },
  { id: 'actions', label: 'Actions', locked: true },
];
const POD_DEFAULT_COLUMNS = ['name', 'image', 'status', 'ready', 'cpu', 'memory', 'actions'];

interface PodsViewProps {
  pods: PodItem[];
  searchQuery: string;
  activePortForwards?: PortForwardSession[];
  /** Keyed by `${namespace}/${name}` */
  podMetrics?: Map<string, PodMetric>;
  metricsAvailable?: boolean;
  onSelectPod: (pod: PodItem) => void;
  onOpenLogs: (pod: string, namespace: string, containers: string[]) => void;
  onOpenShell?: (pod: string, namespace: string, containers: string[]) => void;
  onOpenMultiLogs?: (pods: Array<{ name: string; namespace: string }>) => void;
  onBulkDelete?: (pods: Array<{ name: string; namespace: string }>) => void;
  onOpenManifest: (kind: string, name: string, namespace: string) => void;
  onDelete: (kind: string, name: string, namespace: string) => void;
  onToast?: (message: string, type?: 'success' | 'error') => void;
}

const podKey = (p: PodItem) => `${p.metadata.namespace}/${p.metadata.name}`;

export const PodsView: React.FC<PodsViewProps> = ({
  pods,
  searchQuery,
  activePortForwards = [],
  podMetrics,
  metricsAvailable,
  onSelectPod,
  onOpenLogs,
  onOpenShell,
  onOpenMultiLogs,
  onBulkDelete,
  onOpenManifest,
  onDelete,
  onToast,
}) => {
  const filteredPods = pods.filter((p) => {
    const name = p.metadata.name.toLowerCase();
    const ns = (p.metadata.namespace || '').toLowerCase();
    const phase = (p.status.phase || '').toLowerCase();
    const q = searchQuery.toLowerCase();
    return name.includes(q) || ns.includes(q) || phase.includes(q);
  });

  const cols = useColumnVisibility('pods', POD_COLUMNS, POD_DEFAULT_COLUMNS);

  // Multi-select: keys of selected pods. Pods that disappear are simply ignored.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const lastClickedRef = useRef<number | null>(null);
  const selectedPods = useMemo(() => pods.filter((p) => selected.has(podKey(p))), [pods, selected]);
  const visibleSelected = filteredPods.filter((p) => selected.has(podKey(p))).length;
  const allVisibleSelected = filteredPods.length > 0 && visibleSelected === filteredPods.length;

  const toggleOne = (index: number, shiftKey: boolean) => {
    const pod = filteredPods[index];
    setSelected((prev) => {
      const next = new Set(prev);
      const turnOn = !prev.has(podKey(pod));
      // Shift-click selects / clears the whole range since the last click
      if (shiftKey && lastClickedRef.current !== null) {
        const [a, b] = [lastClickedRef.current, index].sort((x, y) => x - y);
        for (let i = a; i <= b; i++) {
          const k = podKey(filteredPods[i]);
          if (turnOn) next.add(k); else next.delete(k);
        }
      } else if (turnOn) {
        next.add(podKey(pod));
      } else {
        next.delete(podKey(pod));
      }
      return next;
    });
    lastClickedRef.current = index;
  };

  const toggleAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) filteredPods.forEach((p) => next.delete(podKey(p)));
      else filteredPods.forEach((p) => next.add(podKey(p)));
      return next;
    });
  };

  const clearSelection = () => {
    setSelected(new Set());
    lastClickedRef.current = null;
  };

  // Esc clears the selection
  useEffect(() => {
    if (selected.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest?.('input,textarea,[role=dialog]')) clearSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected.size]);

  const selectionRefs = () => selectedPods.map((p) => ({ name: p.metadata.name, namespace: p.metadata.namespace || 'default' }));

  const getPhaseBadge = (phase: string) => {
    switch (phase) {
      case 'Running':
        return <span className="bg-emerald-950 text-emerald-400 border border-emerald-800/80 px-2 py-0.5 rounded text-[10px] font-semibold flex items-center gap-1"><CheckCircle2 className="w-2.5 h-2.5" /> Running</span>;
      case 'Pending':
        return <span className="bg-amber-950 text-amber-400 border border-amber-800/80 px-2 py-0.5 rounded text-[10px] font-semibold flex items-center gap-1"><Clock className="w-2.5 h-2.5" /> Pending</span>;
      case 'Succeeded':
        return <span className="bg-blue-950 text-blue-400 border border-blue-800/80 px-2 py-0.5 rounded text-[10px] font-semibold">Completed</span>;
      default:
        return <span className="bg-rose-950 text-rose-400 border border-rose-800/80 px-2 py-0.5 rounded text-[10px] font-semibold flex items-center gap-1"><AlertCircle className="w-2.5 h-2.5" /> {phase}</span>;
    }
  };

  return (
    <div className="h-full flex flex-col overflow-hidden select-text">
      {/* Table Header / Stats Bar */}
      <div className="px-6 py-3 border-b border-slate-800 bg-slate-900/40 flex items-center justify-between text-xs text-slate-400 select-none">
        <div className="flex items-center gap-2 font-medium">
          <Box className="w-4 h-4 text-cyan-400" />
          <span className="text-slate-200">Pods</span>
          <span className="bg-slate-800 text-slate-400 px-2 py-0.5 rounded font-mono text-[11px]">
            {filteredPods.length} of {pods.length}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {selected.size === 0 && (
            <span className="text-[11px] text-slate-500 hidden lg:inline">Tip: tick pods (Shift-click for a range) for bulk logs & delete</span>
          )}
          <ColumnPicker columns={POD_COLUMNS} visible={cols.visible} onToggle={cols.toggle} onReset={cols.reset} isDefault={cols.isDefault} />
        </div>
      </div>

      {/* Bulk action bar */}
      {selectedPods.length > 0 && (
        <div className="px-6 py-2 border-b border-cyan-900/60 bg-cyan-950/30 flex items-center gap-3 text-xs select-none">
          <span className="text-cyan-300 font-semibold">{selectedPods.length} selected</span>
          <div className="h-4 w-px bg-slate-700" />
          {onOpenMultiLogs && (
            <button
              onClick={() => onOpenMultiLogs(selectionRefs())}
              disabled={selectedPods.length > 30}
              title={selectedPods.length > 30 ? 'Combined logs support up to 30 pods' : 'Stream logs from all selected pods in one view'}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-40 transition-colors"
            >
              <Rows3 className="w-3.5 h-3.5 text-violet-400" /> Combined logs
            </button>
          )}
          <button
            onClick={() => {
              navigator.clipboard?.writeText(selectedPods.map((p) => p.metadata.name).join('\n'));
              onToast?.(`Copied ${selectedPods.length} pod names`);
            }}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors"
          >
            <Copy className="w-3.5 h-3.5 text-cyan-400" /> Copy names
          </button>
          {onBulkDelete && (
            <button
              onClick={() => onBulkDelete(selectionRefs())}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-rose-950/70 hover:bg-rose-900/70 border border-rose-900 text-rose-300 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" /> Delete {selectedPods.length}
            </button>
          )}
          <button
            onClick={clearSelection}
            className="ml-auto flex items-center gap-1 px-2 py-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
            title="Clear selection (Esc)"
          >
            <X className="w-3.5 h-3.5" /> Clear
          </button>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead className="bg-slate-950/80 text-slate-400 sticky top-0 z-10 border-b border-slate-800 select-none backdrop-blur-sm">
            <tr>
              <th className="py-2.5 pl-4 pr-1 w-8">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  ref={(el) => { if (el) el.indeterminate = visibleSelected > 0 && !allVisibleSelected; }}
                  onChange={toggleAllVisible}
                  title="Select all visible pods"
                  className="accent-cyan-500 w-3.5 h-3.5 cursor-pointer align-middle"
                />
              </th>
              <th className="py-2.5 px-4 font-semibold">Name</th>
              {cols.show('namespace') && <th className="py-2.5 px-4 font-semibold">Namespace</th>}
              {cols.show('image') && <th className="py-2.5 px-4 font-semibold">Image Tag</th>}
              {cols.show('status') && <th className="py-2.5 px-4 font-semibold">Status</th>}
              {cols.show('ready') && <th className="py-2.5 px-4 font-semibold">Ready</th>}
              {cols.show('restarts') && <th className="py-2.5 px-4 font-semibold">Restarts</th>}
              {cols.show('cpu') && (
                <th
                  className="py-2.5 px-4 font-semibold"
                  title={metricsAvailable === false ? 'Live usage needs metrics-server in the cluster' : 'Live CPU usage'}
                >CPU</th>
              )}
              {cols.show('memory') && (
                <th
                  className="py-2.5 px-4 font-semibold"
                  title={metricsAvailable === false ? 'Live usage needs metrics-server in the cluster' : 'Live memory usage'}
                >Memory</th>
              )}
              {cols.show('node') && <th className="py-2.5 px-4 font-semibold">Node</th>}
              {cols.show('ip') && <th className="py-2.5 px-4 font-semibold">IP</th>}
              <th className="py-2.5 px-4 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50 font-mono text-slate-300">
            {filteredPods.length === 0 ? (
              <tr>
                <td colSpan={cols.visible.size + 1} className="py-12 text-center text-slate-500 italic">
                  No pods found matching query.
                </td>
              </tr>
            ) : (
              filteredPods.map((pod, index) => {
                const containers = pod.spec.containers.map((c) => c.name);
                const readyContainers = pod.status.containerStatuses?.filter((c) => c.ready).length ?? 0;
                const totalContainers = pod.spec.containers.length;
                const totalRestarts = pod.status.containerStatuses?.reduce((acc, c) => acc + c.restartCount, 0) ?? 0;

                const podForwards = activePortForwards.filter(
                  (pf) => pf.pod === pod.metadata.name && pf.namespace === pod.metadata.namespace
                );
                const isSelected = selected.has(podKey(pod));
                const usage = podMetrics?.get(podKey(pod));

                return (
                  <tr
                    key={pod.metadata.uid || pod.metadata.name}
                    onClick={() => onSelectPod(pod)}
                    className={`cursor-pointer transition-colors group ${
                      isSelected ? 'bg-cyan-950/30 hover:bg-cyan-950/50' : 'hover:bg-slate-800/50'
                    }`}
                  >
                    <td className="py-2.5 pl-4 pr-1 w-8" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => { /* handled in onClick to read shiftKey */ }}
                        onClick={(e) => toggleOne(index, e.shiftKey)}
                        className="accent-cyan-500 w-3.5 h-3.5 cursor-pointer align-middle"
                        aria-label={`Select ${pod.metadata.name}`}
                      />
                    </td>
                    <td className="py-2.5 px-4 font-medium text-slate-100 flex items-center gap-2">
                      <span className="truncate max-w-xs group-hover:text-cyan-300 font-semibold transition-colors" title={`${pod.metadata.namespace}/${pod.metadata.name}`}>
                        {pod.metadata.name}
                      </span>
                      {podForwards.length > 0 && (
                        <span 
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectPod(pod);
                          }}
                          className="bg-cyan-950/80 text-cyan-300 border border-cyan-500/60 px-1.5 py-0.5 rounded text-[10px] font-mono flex items-center gap-1 animate-pulse"
                          title={`Active Port Forward: ${podForwards[0].url}`}
                        >
                          <Radio className="w-2.5 h-2.5" />
                          <span>:{podForwards[0].localPort}</span>
                        </span>
                      )}
                    </td>
                    {cols.show('namespace') && (
                      <td className="py-2.5 px-4 text-slate-400">
                        <span className="bg-slate-800/80 text-slate-300 px-2 py-0.5 rounded text-[11px]">
                          {pod.metadata.namespace}
                        </span>
                      </td>
                    )}
                    {cols.show('image') && <td className="py-2.5 px-4">
                      {(() => {
                        const firstImg = pod.spec.containers[0]?.image || '';
                        const { tag } = parseImageTag(firstImg);
                        return (
                          <span 
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-cyan-950/80 text-cyan-300 border border-cyan-800/60 font-mono text-[10px] font-semibold max-w-[150px] truncate"
                            title={`Full image: ${firstImg} (click pod for details)`}
                          >
                            <Tag className="w-2.5 h-2.5 text-cyan-400 shrink-0" />
                            <span className="truncate">{tag}</span>
                            {pod.spec.containers.length > 1 && (
                              <span className="text-slate-500 font-sans text-[9px]">+{pod.spec.containers.length - 1}</span>
                            )}
                          </span>
                        );
                      })()}
                    </td>}
                    {cols.show('status') && (
                      <td className="py-2.5 px-4">
                        {getPhaseBadge(pod.status.phase)}
                      </td>
                    )}
                    {cols.show('ready') && (
                      <td className="py-2.5 px-4">
                        <span className={`${readyContainers === totalContainers ? 'text-emerald-400' : 'text-amber-400'}`}>
                          {readyContainers}/{totalContainers}
                        </span>
                      </td>
                    )}
                    {cols.show('restarts') && (
                      <td className="py-2.5 px-4">
                        <span className={totalRestarts > 0 ? 'text-amber-400 font-bold' : 'text-slate-400'}>
                          {totalRestarts}
                        </span>
                      </td>
                    )}
                    {cols.show('cpu') && (
                      <td className="py-2.5 px-4 text-sky-300 whitespace-nowrap">{usage?.cpu ?? <span className="text-slate-600">—</span>}</td>
                    )}
                    {cols.show('memory') && (
                      <td className="py-2.5 px-4 text-violet-300 whitespace-nowrap">{usage?.memory ?? <span className="text-slate-600">—</span>}</td>
                    )}
                    {cols.show('node') && (
                      <td className="py-2.5 px-4 text-slate-400 truncate max-w-[140px]" title={pod.spec.nodeName}>
                        {pod.spec.nodeName || 'N/A'}
                      </td>
                    )}
                    {cols.show('ip') && (
                      <td className="py-2.5 px-4 text-slate-400">
                        {pod.status.podIP || 'N/A'}
                      </td>
                    )}
                    <td className="py-2.5 px-4 text-right">
                      <div className="flex items-center justify-end gap-1 select-none font-sans">
                        {/* Port Forward / Details */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectPod(pod);
                          }}
                          title="View Details & Port Forward"
                          className="p-1 text-slate-400 hover:text-cyan-300 hover:bg-slate-800 rounded transition-colors"
                        >
                          <Radio className="w-3.5 h-3.5" />
                        </button>
                        {/* Logs */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenLogs(pod.metadata.name, pod.metadata.namespace!, containers);
                          }}
                          title="Stream Logs"
                          className="p-1 text-slate-400 hover:text-cyan-300 hover:bg-slate-800 rounded transition-colors"
                        >
                          <Terminal className="w-3.5 h-3.5" />
                        </button>
                        {/* Shell */}
                        {onOpenShell && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenShell(pod.metadata.name, pod.metadata.namespace!, containers);
                            }}
                            disabled={pod.status.phase !== 'Running'}
                            title={pod.status.phase === 'Running' ? 'Open Shell' : 'Shell is available for running pods'}
                            className="p-1 text-slate-400 hover:text-emerald-300 hover:bg-slate-800 rounded transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
                          >
                            <SquareTerminal className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {/* Manifest */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenManifest('pod', pod.metadata.name, pod.metadata.namespace!);
                          }}
                          title="View/Edit Manifest"
                          className="p-1 text-slate-400 hover:text-amber-300 hover:bg-slate-800 rounded transition-colors"
                        >
                          <FileCode className="w-3.5 h-3.5" />
                        </button>
                        {/* Delete */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onDelete('pod', pod.metadata.name, pod.metadata.namespace!);
                          }}
                          title="Delete Pod"
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
    </div>
  );
};
