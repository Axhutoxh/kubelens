import React, { useState, useEffect, useCallback } from 'react';
import { 
  Sparkles, 
  ArrowLeftRight, 
  Box, 
  Server, 
  Network, 
  FileText, 
  RefreshCw, 
  Search, 
  Terminal, 
  FileCode, 
  Trash2, 
  Radio, 
  CheckCircle2, 
  AlertCircle, 
  Clock, 
  ExternalLink,
  Columns2,
  Sliders,
  Layers,
  Database,
  Globe
} from 'lucide-react';
import { 
  PodItem, 
  DeploymentItem, 
  ServiceItem, 
  ConfigMapItem, 
  PortForwardSession,
  ContextItem
} from '../types/k8s';
import { 
  fetchK8sResource, 
  deleteResource 
} from '../api/client';
import { PodDetailModal } from '../components/PodDetailModal';

interface SmartLensStudioProps {
  contexts: ContextItem[];
  currentContext: string;
  namespaces: string[];
  currentNamespace: string;
  activePortForwards: PortForwardSession[];
  onSelectPod: (
    pod: PodItem, 
    context?: string, 
    initialTab?: 'overview' | 'env' | 'containers' | 'portforward' | 'events' | 'yaml'
  ) => void;
  onOpenLogs: (pod: string, namespace: string, containers: string[], context?: string) => void;
  onOpenManifest: (kind: string, name: string, namespace: string, context?: string) => void;
  onToast: (message: string, type?: 'success' | 'error') => void;
}

export const SmartLensStudio: React.FC<SmartLensStudioProps> = ({
  contexts,
  currentContext,
  namespaces: initialNamespaces,
  currentNamespace,
  activePortForwards,
  onSelectPod,
  onOpenLogs,
  onOpenManifest,
  onToast,
}) => {
  // Split ratio: '50-50' | '70-30' | '30-70'
  const [splitRatio, setSplitRatio] = useState<'50-50' | '70-30' | '30-70'>('50-50');
  const [globalFilter, setGlobalFilter] = useState('');

  // Determine initial left and right clusters
  const defaultLeftCluster = currentContext || contexts[0]?.name || '';
  const alternateContext = contexts.find((c) => c.name !== defaultLeftCluster);
  const defaultRightCluster = alternateContext ? alternateContext.name : defaultLeftCluster;

  // Left Pane State: Cluster, Namespaces & Resources
  const [leftCluster, setLeftCluster] = useState<string>(defaultLeftCluster);
  const [leftNamespaces, setLeftNamespaces] = useState<string[]>(initialNamespaces);
  const [leftNs, setLeftNs] = useState<string>(
    currentNamespace && currentNamespace !== '_all' ? currentNamespace : (initialNamespaces[0] || 'default')
  );
  const [leftResource, setLeftResource] = useState<'pods' | 'deployments' | 'services' | 'configmaps'>('pods');
  const [leftQuery, setLeftQuery] = useState('');
  const [leftPods, setLeftPods] = useState<PodItem[]>([]);
  const [leftDeployments, setLeftDeployments] = useState<DeploymentItem[]>([]);
  const [leftServices, setLeftServices] = useState<ServiceItem[]>([]);
  const [leftConfigMaps, setLeftConfigMaps] = useState<ConfigMapItem[]>([]);
  const [isLeftLoading, setIsLeftLoading] = useState(false);
  const [leftError, setLeftError] = useState<string | null>(null);

  // Left Selected Pod for inline detail view in Left Pane
  const [leftSelectedPod, setLeftSelectedPod] = useState<PodItem | null>(null);
  const [leftSelectedPodTab, setLeftSelectedPodTab] = useState<'overview' | 'env' | 'containers' | 'portforward' | 'events' | 'yaml'>('overview');

  // Right Pane State: Cluster, Namespaces & Resources
  const [rightCluster, setRightCluster] = useState<string>(defaultRightCluster);
  const [rightNamespaces, setRightNamespaces] = useState<string[]>(initialNamespaces);
  const [rightNs, setRightNs] = useState<string>(
    initialNamespaces.length > 1 ? (initialNamespaces[1] === leftNs ? initialNamespaces[0] : initialNamespaces[1]) : (initialNamespaces[0] || 'default')
  );
  const [rightResource, setRightResource] = useState<'pods' | 'deployments' | 'services' | 'configmaps'>('pods');
  const [rightQuery, setRightQuery] = useState('');
  const [rightPods, setRightPods] = useState<PodItem[]>([]);
  const [rightDeployments, setRightDeployments] = useState<DeploymentItem[]>([]);
  const [rightServices, setRightServices] = useState<ServiceItem[]>([]);
  const [rightConfigMaps, setRightConfigMaps] = useState<ConfigMapItem[]>([]);
  const [isRightLoading, setIsRightLoading] = useState(false);
  const [rightError, setRightError] = useState<string | null>(null);

  // Right Selected Pod for inline detail view in Right Pane
  const [rightSelectedPod, setRightSelectedPod] = useState<PodItem | null>(null);
  const [rightSelectedPodTab, setRightSelectedPodTab] = useState<'overview' | 'env' | 'containers' | 'portforward' | 'events' | 'yaml'>('overview');

  // Load Namespaces for Left Cluster
  const loadLeftNamespaces = useCallback(async (cluster: string) => {
    if (!cluster) return;
    try {
      const res = await fetchK8sResource('namespaces', undefined, cluster);
      const nsList = res.items?.map((ns: any) => ns.metadata.name) || [];
      if (nsList.length > 0) {
        setLeftNamespaces(nsList);
        setLeftNs((prev) => (nsList.includes(prev) ? prev : nsList[0]));
      }
    } catch {
      // Fallback to default namespaces
    }
  }, []);

  // Load Namespaces for Right Cluster
  const loadRightNamespaces = useCallback(async (cluster: string) => {
    if (!cluster) return;
    try {
      const res = await fetchK8sResource('namespaces', undefined, cluster);
      const nsList = res.items?.map((ns: any) => ns.metadata.name) || [];
      if (nsList.length > 0) {
        setRightNamespaces(nsList);
        setRightNs((prev) => (nsList.includes(prev) ? prev : nsList[0]));
      }
    } catch {
      // Fallback to default namespaces
    }
  }, []);

  // Load Left Cluster Data
  const loadLeftData = useCallback(async (cluster = leftCluster, ns = leftNs) => {
    if (!cluster) return;
    setIsLeftLoading(true);
    setLeftError(null);
    try {
      const [p, d, s, c] = await Promise.all([
        fetchK8sResource<PodItem>('pods', ns, cluster).catch((err) => {
          setLeftError(err.message);
          return { items: [] };
        }),
        fetchK8sResource<DeploymentItem>('deployments', ns, cluster).catch(() => ({ items: [] })),
        fetchK8sResource<ServiceItem>('services', ns, cluster).catch(() => ({ items: [] })),
        fetchK8sResource<ConfigMapItem>('configmaps', ns, cluster).catch(() => ({ items: [] })),
      ]);
      setLeftPods(p.items || []);
      setLeftDeployments(d.items || []);
      setLeftServices(s.items || []);
      setLeftConfigMaps(c.items || []);
    } catch (err: any) {
      setLeftError(err.message || 'Failed to load left cluster data');
    } finally {
      setIsLeftLoading(false);
    }
  }, [leftCluster, leftNs]);

  // Load Right Cluster Data
  const loadRightData = useCallback(async (cluster = rightCluster, ns = rightNs) => {
    if (!cluster) return;
    setIsRightLoading(true);
    setRightError(null);
    try {
      const [p, d, s, c] = await Promise.all([
        fetchK8sResource<PodItem>('pods', ns, cluster).catch((err) => {
          setRightError(err.message);
          return { items: [] };
        }),
        fetchK8sResource<DeploymentItem>('deployments', ns, cluster).catch(() => ({ items: [] })),
        fetchK8sResource<ServiceItem>('services', ns, cluster).catch(() => ({ items: [] })),
        fetchK8sResource<ConfigMapItem>('configmaps', ns, cluster).catch(() => ({ items: [] })),
      ]);
      setRightPods(p.items || []);
      setRightDeployments(d.items || []);
      setRightServices(s.items || []);
      setRightConfigMaps(c.items || []);
    } catch (err: any) {
      setRightError(err.message || 'Failed to load right cluster data');
    } finally {
      setIsRightLoading(false);
    }
  }, [rightCluster, rightNs]);

  // When leftCluster changes, reload namespaces and data
  useEffect(() => {
    loadLeftNamespaces(leftCluster);
  }, [leftCluster, loadLeftNamespaces]);

  useEffect(() => {
    loadLeftData(leftCluster, leftNs);
  }, [leftCluster, leftNs, loadLeftData]);

  // When rightCluster changes, reload namespaces and data
  useEffect(() => {
    loadRightNamespaces(rightCluster);
  }, [rightCluster, loadRightNamespaces]);

  useEffect(() => {
    loadRightData(rightCluster, rightNs);
  }, [rightCluster, rightNs, loadRightData]);

  // Reset inline pod selections when cluster or namespace changes
  useEffect(() => {
    setLeftSelectedPod(null);
  }, [leftCluster, leftNs]);

  useEffect(() => {
    setRightSelectedPod(null);
  }, [rightCluster, rightNs]);

  // Swap Left and Right Cluster & Namespace
  const handleSwapPanes = () => {
    const tempCluster = leftCluster;
    const tempNs = leftNs;
    const tempNamespaces = leftNamespaces;
    const tempPod = leftSelectedPod;
    const tempTab = leftSelectedPodTab;

    setLeftCluster(rightCluster);
    setLeftNs(rightNs);
    setLeftNamespaces(rightNamespaces);
    setLeftSelectedPod(rightSelectedPod);
    setLeftSelectedPodTab(rightSelectedPodTab);

    setRightCluster(tempCluster);
    setRightNs(tempNs);
    setRightNamespaces(tempNamespaces);
    setRightSelectedPod(tempPod);
    setRightSelectedPodTab(tempTab);
  };

  const handleDelete = async (kind: string, name: string, ns: string, side: 'left' | 'right') => {
    const targetCluster = side === 'left' ? leftCluster : rightCluster;
    if (!window.confirm(`Delete ${kind} "${name}" from namespace "${ns}" on cluster "${targetCluster}"?`)) return;
    try {
      await deleteResource(kind, name, ns, targetCluster);
      onToast(`Deleted ${kind}/${name}`);
      if (side === 'left') loadLeftData(leftCluster, leftNs);
      else loadRightData(rightCluster, rightNs);
    } catch (err: any) {
      onToast(err.message || 'Delete failed', 'error');
    }
  };

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

  // Helper filter logic
  const matchFilter = (name: string, localQ: string) => {
    const q1 = globalFilter.trim().toLowerCase();
    const q2 = localQ.trim().toLowerCase();
    const target = name.toLowerCase();
    const passGlobal = !q1 || target.includes(q1);
    const passLocal = !q2 || target.includes(q2);
    return passGlobal && passLocal;
  };

  // Filtered left items
  const filteredLeftPods = leftPods.filter((p) => matchFilter(p.metadata.name, leftQuery));
  const filteredLeftDeployments = leftDeployments.filter((d) => matchFilter(d.metadata.name, leftQuery));
  const filteredLeftServices = leftServices.filter((s) => matchFilter(s.metadata.name, leftQuery));
  const filteredLeftConfigMaps = leftConfigMaps.filter((c) => matchFilter(c.metadata.name, leftQuery));

  // Filtered right items
  const filteredRightPods = rightPods.filter((p) => matchFilter(p.metadata.name, rightQuery));
  const filteredRightDeployments = rightDeployments.filter((d) => matchFilter(d.metadata.name, rightQuery));
  const filteredRightServices = rightServices.filter((s) => matchFilter(s.metadata.name, rightQuery));
  const filteredRightConfigMaps = rightConfigMaps.filter((c) => matchFilter(c.metadata.name, rightQuery));

  // Calculate width classes based on splitRatio
  const leftWidthClass = splitRatio === '50-50' ? 'w-1/2' : splitRatio === '70-30' ? 'w-[70%]' : 'w-[30%]';
  const rightWidthClass = splitRatio === '50-50' ? 'w-1/2' : splitRatio === '70-30' ? 'w-[30%]' : 'w-[70%]';

  return (
    <div className="h-full flex flex-col overflow-hidden select-text bg-slate-950">
      
      {/* Studio Top Controls Bar */}
      <div className="px-6 py-2.5 bg-slate-900/90 border-b border-slate-800 flex items-center justify-between gap-4 select-none shrink-0 shadow-md">
        
        {/* Title & Brand */}
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded-lg bg-gradient-to-br from-cyan-500 to-indigo-600 text-slate-950 shadow-sm shadow-cyan-500/20">
            <Sparkles className="w-4 h-4 text-slate-950" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-bold text-slate-100 tracking-wide">
                Smart Lens Studio
              </h1>
              <span className="bg-gradient-to-r from-cyan-500/20 to-indigo-500/20 text-cyan-300 border border-cyan-500/40 text-[10px] font-bold px-2 py-0.5 rounded-full">
                Multi-Cluster Workspace
              </span>
            </div>
            <p className="text-[11px] text-slate-400">
              Select different clusters on left & right to compare workloads, inspect live diffs, and view/edit pod environment variables
            </p>
          </div>
        </div>

        {/* Global Search across both panes */}
        <div className="relative w-64">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search across both clusters..."
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="w-full pl-9 pr-3 py-1 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-cyan-500 transition-colors"
          />
        </div>

        {/* View Layout Controls & Swap */}
        <div className="flex items-center gap-2">
          {/* Swap Button */}
          <button
            onClick={handleSwapPanes}
            title="Swap Left and Right Clusters"
            className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium border border-slate-700/80 flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <ArrowLeftRight className="w-3.5 h-3.5 text-cyan-400" />
            <span>Swap Panes</span>
          </button>

          {/* Split Ratio Selector */}
          <div className="flex items-center bg-slate-950 border border-slate-800 rounded-lg p-0.5 text-xs font-mono">
            <button
              onClick={() => setSplitRatio('50-50')}
              className={`px-2 py-0.5 rounded transition-all cursor-pointer ${splitRatio === '50-50' ? 'bg-cyan-600 text-white font-bold' : 'text-slate-400 hover:text-slate-200'}`}
              title="50% / 50% Split"
            >
              50:50
            </button>
            <button
              onClick={() => setSplitRatio('70-30')}
              className={`px-2 py-0.5 rounded transition-all cursor-pointer ${splitRatio === '70-30' ? 'bg-cyan-600 text-white font-bold' : 'text-slate-400 hover:text-slate-200'}`}
              title="70% Left Focus"
            >
              70:30
            </button>
            <button
              onClick={() => setSplitRatio('30-70')}
              className={`px-2 py-0.5 rounded transition-all cursor-pointer ${splitRatio === '30-70' ? 'bg-cyan-600 text-white font-bold' : 'text-slate-400 hover:text-slate-200'}`}
              title="70% Right Focus"
            >
              30:70
            </button>
          </div>
        </div>
      </div>

      {/* Dual Split Panes Container */}
      <div className="flex-1 flex overflow-hidden">
        
        {/* ================= LEFT PANE ================= */}
        <div className={`${leftWidthClass} flex flex-col border-r border-slate-800 transition-all overflow-hidden`}>
          
          {/* Left Pane Cluster & Namespace Selector Bar */}
          <div className="px-4 py-2.5 bg-slate-950/95 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2.5 shrink-0">
            <div className="flex items-center gap-2 flex-wrap">
              {/* Cluster Selector */}
              <div className="flex items-center gap-1.5 bg-slate-900 border border-cyan-500/40 rounded-lg px-2 py-1">
                <Globe className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                <span className="text-[10px] font-bold text-cyan-400 uppercase tracking-wider">CLUSTER:</span>
                <select
                  value={leftCluster}
                  onChange={(e) => setLeftCluster(e.target.value)}
                  className="bg-transparent text-xs text-slate-100 font-mono font-bold focus:outline-none cursor-pointer max-w-[150px] truncate"
                  title="Select Left Cluster"
                >
                  {contexts.map((ctx) => (
                    <option key={ctx.name} value={ctx.name} className="bg-slate-900 text-slate-100 font-mono">
                      {ctx.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Namespace Selector */}
              <div className="flex items-center gap-1.5 bg-slate-900/80 border border-slate-700/80 rounded-lg px-2 py-1">
                <span className="text-[10px] font-semibold text-slate-400 uppercase">NS:</span>
                <select
                  value={leftNs}
                  onChange={(e) => setLeftNs(e.target.value)}
                  className="bg-transparent text-xs text-slate-200 font-mono focus:outline-none cursor-pointer max-w-[130px] truncate"
                  title="Select Left Namespace"
                >
                  <option value="_all" className="bg-slate-900">All Namespaces</option>
                  {leftNamespaces.map((ns) => (
                    <option key={ns} value={ns} className="bg-slate-900">{ns}</option>
                  ))}
                </select>
              </div>

              {/* Refresh Button */}
              <button
                onClick={() => loadLeftData(leftCluster, leftNs)}
                disabled={isLeftLoading}
                className="p-1 text-slate-400 hover:text-slate-200 rounded hover:bg-slate-800 transition-colors"
                title="Refresh Left Cluster"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isLeftLoading ? 'animate-spin text-cyan-400' : ''}`} />
              </button>
            </div>

            {/* Resource Type Filter */}
            <div className="flex items-center gap-1 text-xs select-none">
              <button
                onClick={() => { setLeftResource('pods'); setLeftSelectedPod(null); }}
                className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                  leftResource === 'pods' ? 'bg-cyan-950 text-cyan-300 border border-cyan-800/80 font-semibold' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Pods ({filteredLeftPods.length})
              </button>
              <button
                onClick={() => { setLeftResource('deployments'); setLeftSelectedPod(null); }}
                className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                  leftResource === 'deployments' ? 'bg-cyan-950 text-cyan-300 border border-cyan-800/80 font-semibold' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Deploy ({filteredLeftDeployments.length})
              </button>
              <button
                onClick={() => { setLeftResource('services'); setLeftSelectedPod(null); }}
                className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                  leftResource === 'services' ? 'bg-cyan-950 text-cyan-300 border border-cyan-800/80 font-semibold' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                SVC ({filteredLeftServices.length})
              </button>
              <button
                onClick={() => { setLeftResource('configmaps'); setLeftSelectedPod(null); }}
                className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                  leftResource === 'configmaps' ? 'bg-cyan-950 text-cyan-300 border border-cyan-800/80 font-semibold' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Config ({filteredLeftConfigMaps.length})
              </button>
            </div>
          </div>

          {/* Left Pane Content: Pod Detail View or Resource Table */}
          {leftSelectedPod ? (
            <div className="flex-1 min-h-0 overflow-hidden">
              <PodDetailModal
                pod={leftSelectedPod}
                context={leftCluster}
                initialTab={leftSelectedPodTab}
                isOpen={true}
                isInline={true}
                onClose={() => setLeftSelectedPod(null)}
                onOpenLogs={(podName, ns, containers) => onOpenLogs(podName, ns, containers, leftCluster)}
                onOpenManifest={(kind, name, ns) => onOpenManifest(kind, name, ns, leftCluster)}
                onRefreshList={() => loadLeftData(leftCluster, leftNs)}
                onToast={onToast}
                onExpandFullscreen={(p, ctx, tab) => onSelectPod(p, ctx, tab)}
              />
            </div>
          ) : (
            <>
              {/* Left Local Filter */}
              <div className="px-4 py-1.5 bg-slate-900/40 border-b border-slate-800/60 flex items-center justify-between gap-2 text-xs">
                <input
                  type="text"
                  placeholder={`Filter in ${leftCluster} / ${leftNs}...`}
                  value={leftQuery}
                  onChange={(e) => setLeftQuery(e.target.value)}
                  className="bg-transparent border-none text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none w-full"
                />
              </div>

              {/* Left Error Banner if any */}
              {leftError && (
                <div className="px-4 py-2 bg-rose-950/40 border-b border-rose-800/50 text-[11px] text-rose-300 flex items-center gap-2">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 text-rose-400" />
                  <span className="truncate">{leftError}</span>
                </div>
              )}

              {/* Left Pane Table Body */}
              <div className="flex-1 overflow-auto">
            {leftResource === 'pods' && (
              <table className="w-full text-left text-xs border-collapse font-mono">
                <thead className="bg-slate-950/90 text-slate-400 sticky top-0 z-10 border-b border-slate-800 select-none">
                  <tr>
                    <th className="py-2 px-3 font-semibold">Pod Name</th>
                    <th className="py-2 px-2 font-semibold">Status</th>
                    <th className="py-2 px-2 font-semibold">Ready</th>
                    <th className="py-2 px-2 font-semibold">Restarts</th>
                    <th className="py-2 px-3 text-right font-semibold">Actions / Env</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50 text-slate-300">
                  {filteredLeftPods.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-12 text-center text-slate-500 italic">
                        {isLeftLoading ? 'Loading pods...' : `No pods found in "${leftNs}" on cluster "${leftCluster}".`}
                      </td>
                    </tr>
                  ) : (
                    filteredLeftPods.map((pod) => {
                      const containers = pod.spec.containers.map((c) => c.name);
                      const readyContainers = pod.status.containerStatuses?.filter((c) => c.ready).length ?? 0;
                      const totalContainers = pod.spec.containers.length;
                      const totalRestarts = pod.status.containerStatuses?.reduce((acc, c) => acc + c.restartCount, 0) ?? 0;
                      const envCount = pod.spec.containers.reduce((acc, c) => acc + (c.env?.length || 0), 0);
                      const podForwards = activePortForwards.filter(
                        (pf) => pf.pod === pod.metadata.name && pf.namespace === pod.metadata.namespace
                      );

                      return (
                        <tr 
                          key={pod.metadata.uid || pod.metadata.name}
                          onClick={() => {
                            setLeftSelectedPod(pod);
                            setLeftSelectedPodTab('overview');
                          }}
                          className="hover:bg-slate-800/50 cursor-pointer transition-colors group"
                          title="Click to view pod details in left pane"
                        >
                          <td className="py-2 px-3 font-medium text-slate-100 flex items-center gap-1.5">
                            <span className="truncate max-w-[150px] group-hover:text-cyan-300 font-semibold transition-colors" title={pod.metadata.name}>
                              {pod.metadata.name}
                            </span>
                            {podForwards.length > 0 && (
                              <span className="bg-cyan-950 text-cyan-300 border border-cyan-500/60 px-1 py-0.2 rounded text-[10px] font-mono animate-pulse">
                                :{podForwards[0].localPort}
                              </span>
                            )}
                          </td>
                          <td className="py-2 px-2">{getPhaseBadge(pod.status.phase)}</td>
                          <td className="py-2 px-2 text-slate-300">
                            <span className={readyContainers === totalContainers ? 'text-emerald-400' : 'text-amber-400'}>
                              {readyContainers}/{totalContainers}
                            </span>
                          </td>
                          <td className="py-2 px-2">
                            <span className={totalRestarts > 0 ? 'text-amber-400 font-bold' : 'text-slate-400'}>
                              {totalRestarts}
                            </span>
                          </td>
                          <td className="py-2 px-3 text-right">
                            <div className="flex items-center justify-end gap-1 font-sans">
                              {/* Quick Environment Variables Button */}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setLeftSelectedPod(pod);
                                  setLeftSelectedPodTab('env');
                                }}
                                title="View & Edit Environment Variables in Left Pane"
                                className="px-2 py-0.5 rounded bg-emerald-950/60 hover:bg-emerald-900/80 text-emerald-300 border border-emerald-800/80 text-[10px] font-mono flex items-center gap-1 transition-all"
                              >
                                <Sliders className="w-2.5 h-2.5 text-emerald-400" />
                                <span>{envCount} envs</span>
                              </button>

                              <button
                                onClick={(e) => { 
                                  e.stopPropagation(); 
                                  setLeftSelectedPod(pod); 
                                  setLeftSelectedPodTab('portforward'); 
                                }}
                                title="Port Forward in Left Pane"
                                className="p-1 text-slate-400 hover:text-cyan-300 hover:bg-slate-800 rounded"
                              >
                                <Radio className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); onOpenLogs(pod.metadata.name, leftNs, containers, leftCluster); }}
                                title="Stream Logs"
                                className="p-1 text-slate-400 hover:text-cyan-300 hover:bg-slate-800 rounded"
                              >
                                <Terminal className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); onOpenManifest('pod', pod.metadata.name, leftNs, leftCluster); }}
                                title="Manifest"
                                className="p-1 text-slate-400 hover:text-amber-300 hover:bg-slate-800 rounded"
                              >
                                <FileCode className="w-3.5 h-3.5" />
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

            {leftResource === 'deployments' && (
              <div className="p-3 divide-y divide-slate-800/60 font-mono text-xs">
                {filteredLeftDeployments.map((d) => (
                  <div key={d.metadata.name} className="py-2 flex items-center justify-between hover:bg-slate-900/50 px-2 rounded">
                    <div>
                      <div className="font-semibold text-slate-100">{d.metadata.name}</div>
                      <div className="text-slate-400 text-[11px]">Replicas: {d.status?.readyReplicas || 0}/{d.spec?.replicas || 0}</div>
                    </div>
                    <button
                      onClick={() => onOpenManifest('deployment', d.metadata.name, leftNs, leftCluster)}
                      className="p-1 text-slate-400 hover:text-amber-300 rounded"
                      title="View Manifest"
                    >
                      <FileCode className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {leftResource === 'services' && (
              <div className="p-3 divide-y divide-slate-800/60 font-mono text-xs">
                {filteredLeftServices.map((s) => (
                  <div key={s.metadata.name} className="py-2 flex items-center justify-between hover:bg-slate-900/50 px-2 rounded">
                    <div>
                      <div className="font-semibold text-slate-100">{s.metadata.name}</div>
                      <div className="text-slate-400 text-[11px]">{s.spec?.type} • IP: {s.spec?.clusterIP || 'None'}</div>
                    </div>
                    <button
                      onClick={() => onOpenManifest('service', s.metadata.name, leftNs, leftCluster)}
                      className="p-1 text-slate-400 hover:text-amber-300 rounded"
                      title="View Manifest"
                    >
                      <FileCode className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {leftResource === 'configmaps' && (
              <div className="p-3 divide-y divide-slate-800/60 font-mono text-xs">
                {filteredLeftConfigMaps.map((c) => (
                  <div key={c.metadata.name} className="py-2 flex items-center justify-between hover:bg-slate-900/50 px-2 rounded">
                    <div>
                      <div className="font-semibold text-slate-100">{c.metadata.name}</div>
                      <div className="text-slate-400 text-[11px]">Keys: {Object.keys(c.data || {}).length}</div>
                    </div>
                    <button
                      onClick={() => onOpenManifest('configmap', c.metadata.name, leftNs, leftCluster)}
                      className="p-1 text-slate-400 hover:text-amber-300 rounded"
                      title="View Manifest"
                    >
                      <FileCode className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>

        {/* ================= RIGHT PANE ================= */}
        <div className={`${rightWidthClass} flex flex-col transition-all overflow-hidden bg-slate-950/40`}>
          
          {/* Right Pane Cluster & Namespace Selector Bar */}
          <div className="px-4 py-2.5 bg-slate-950/95 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2.5 shrink-0">
            <div className="flex items-center gap-2 flex-wrap">
              {/* Cluster Selector */}
              <div className="flex items-center gap-1.5 bg-slate-900 border border-indigo-500/40 rounded-lg px-2 py-1">
                <Globe className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-wider">CLUSTER:</span>
                <select
                  value={rightCluster}
                  onChange={(e) => setRightCluster(e.target.value)}
                  className="bg-transparent text-xs text-slate-100 font-mono font-bold focus:outline-none cursor-pointer max-w-[150px] truncate"
                  title="Select Right Cluster"
                >
                  {contexts.map((ctx) => (
                    <option key={ctx.name} value={ctx.name} className="bg-slate-900 text-slate-100 font-mono">
                      {ctx.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Namespace Selector */}
              <div className="flex items-center gap-1.5 bg-slate-900/80 border border-slate-700/80 rounded-lg px-2 py-1">
                <span className="text-[10px] font-semibold text-slate-400 uppercase">NS:</span>
                <select
                  value={rightNs}
                  onChange={(e) => setRightNs(e.target.value)}
                  className="bg-transparent text-xs text-slate-200 font-mono focus:outline-none cursor-pointer max-w-[130px] truncate"
                  title="Select Right Namespace"
                >
                  <option value="_all" className="bg-slate-900">All Namespaces</option>
                  {rightNamespaces.map((ns) => (
                    <option key={ns} value={ns} className="bg-slate-900">{ns}</option>
                  ))}
                </select>
              </div>

              {/* Refresh Button */}
              <button
                onClick={() => loadRightData(rightCluster, rightNs)}
                disabled={isRightLoading}
                className="p-1 text-slate-400 hover:text-slate-200 rounded hover:bg-slate-800 transition-colors"
                title="Refresh Right Cluster"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isRightLoading ? 'animate-spin text-indigo-400' : ''}`} />
              </button>
            </div>

            {/* Resource Type Filter */}
            <div className="flex items-center gap-1 text-xs select-none">
              <button
                onClick={() => { setRightResource('pods'); setRightSelectedPod(null); }}
                className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                  rightResource === 'pods' ? 'bg-indigo-950 text-indigo-300 border border-indigo-800/80 font-semibold' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Pods ({filteredRightPods.length})
              </button>
              <button
                onClick={() => { setRightResource('deployments'); setRightSelectedPod(null); }}
                className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                  rightResource === 'deployments' ? 'bg-indigo-950 text-indigo-300 border border-indigo-800/80 font-semibold' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Deploy ({filteredRightDeployments.length})
              </button>
              <button
                onClick={() => { setRightResource('services'); setRightSelectedPod(null); }}
                className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                  rightResource === 'services' ? 'bg-indigo-950 text-indigo-300 border border-indigo-800/80 font-semibold' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                SVC ({filteredRightServices.length})
              </button>
              <button
                onClick={() => { setRightResource('configmaps'); setRightSelectedPod(null); }}
                className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                  rightResource === 'configmaps' ? 'bg-indigo-950 text-indigo-300 border border-indigo-800/80 font-semibold' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Config ({filteredRightConfigMaps.length})
              </button>
            </div>
          </div>

          {/* Right Pane Content: Pod Detail View or Resource Table */}
          {rightSelectedPod ? (
            <div className="flex-1 min-h-0 overflow-hidden">
              <PodDetailModal
                pod={rightSelectedPod}
                context={rightCluster}
                initialTab={rightSelectedPodTab}
                isOpen={true}
                isInline={true}
                onClose={() => setRightSelectedPod(null)}
                onOpenLogs={(podName, ns, containers) => onOpenLogs(podName, ns, containers, rightCluster)}
                onOpenManifest={(kind, name, ns) => onOpenManifest(kind, name, ns, rightCluster)}
                onRefreshList={() => loadRightData(rightCluster, rightNs)}
                onToast={onToast}
                onExpandFullscreen={(p, ctx, tab) => onSelectPod(p, ctx, tab)}
              />
            </div>
          ) : (
            <>
              {/* Right Local Filter */}
              <div className="px-4 py-1.5 bg-slate-900/40 border-b border-slate-800/60 flex items-center justify-between gap-2 text-xs">
                <input
                  type="text"
                  placeholder={`Filter in ${rightCluster} / ${rightNs}...`}
                  value={rightQuery}
                  onChange={(e) => setRightQuery(e.target.value)}
                  className="bg-transparent border-none text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none w-full"
                />
              </div>

              {/* Right Error Banner if any */}
              {rightError && (
                <div className="px-4 py-2 bg-rose-950/40 border-b border-rose-800/50 text-[11px] text-rose-300 flex items-center gap-2">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 text-rose-400" />
                  <span className="truncate">{rightError}</span>
                </div>
              )}

              {/* Right Pane Table Body */}
              <div className="flex-1 overflow-auto">
            {rightResource === 'pods' && (
              <table className="w-full text-left text-xs border-collapse font-mono">
                <thead className="bg-slate-950/90 text-slate-400 sticky top-0 z-10 border-b border-slate-800 select-none">
                  <tr>
                    <th className="py-2 px-3 font-semibold">Pod Name</th>
                    <th className="py-2 px-2 font-semibold">Status</th>
                    <th className="py-2 px-2 font-semibold">Ready</th>
                    <th className="py-2 px-2 font-semibold">Restarts</th>
                    <th className="py-2 px-3 text-right font-semibold">Actions / Env</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50 text-slate-300">
                  {filteredRightPods.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-12 text-center text-slate-500 italic">
                        {isRightLoading ? 'Loading pods...' : `No pods found in "${rightNs}" on cluster "${rightCluster}".`}
                      </td>
                    </tr>
                  ) : (
                    filteredRightPods.map((pod) => {
                      const containers = pod.spec.containers.map((c) => c.name);
                      const readyContainers = pod.status.containerStatuses?.filter((c) => c.ready).length ?? 0;
                      const totalContainers = pod.spec.containers.length;
                      const totalRestarts = pod.status.containerStatuses?.reduce((acc, c) => acc + c.restartCount, 0) ?? 0;
                      const envCount = pod.spec.containers.reduce((acc, c) => acc + (c.env?.length || 0), 0);
                      const podForwards = activePortForwards.filter(
                        (pf) => pf.pod === pod.metadata.name && pf.namespace === pod.metadata.namespace
                      );

                      return (
                        <tr 
                          key={pod.metadata.uid || pod.metadata.name}
                          onClick={() => {
                            setRightSelectedPod(pod);
                            setRightSelectedPodTab('overview');
                          }}
                          className="hover:bg-slate-800/50 cursor-pointer transition-colors group"
                          title="Click to view pod details in right pane"
                        >
                          <td className="py-2 px-3 font-medium text-slate-100 flex items-center gap-1.5">
                            <span className="truncate max-w-[150px] group-hover:text-indigo-300 font-semibold transition-colors" title={pod.metadata.name}>
                              {pod.metadata.name}
                            </span>
                            {podForwards.length > 0 && (
                              <span className="bg-cyan-950 text-cyan-300 border border-cyan-500/60 px-1 py-0.2 rounded text-[10px] font-mono animate-pulse">
                                :{podForwards[0].localPort}
                              </span>
                            )}
                          </td>
                          <td className="py-2 px-2">{getPhaseBadge(pod.status.phase)}</td>
                          <td className="py-2 px-2 text-slate-300">
                            <span className={readyContainers === totalContainers ? 'text-emerald-400' : 'text-amber-400'}>
                              {readyContainers}/{totalContainers}
                            </span>
                          </td>
                          <td className="py-2 px-2">
                            <span className={totalRestarts > 0 ? 'text-amber-400 font-bold' : 'text-slate-400'}>
                              {totalRestarts}
                            </span>
                          </td>
                          <td className="py-2 px-3 text-right">
                            <div className="flex items-center justify-end gap-1 font-sans">
                              {/* Quick Environment Variables Button */}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setRightSelectedPod(pod);
                                  setRightSelectedPodTab('env');
                                }}
                                title="View & Edit Environment Variables in Right Pane"
                                className="px-2 py-0.5 rounded bg-emerald-950/60 hover:bg-emerald-900/80 text-emerald-300 border border-emerald-800/80 text-[10px] font-mono flex items-center gap-1 transition-all"
                              >
                                <Sliders className="w-2.5 h-2.5 text-emerald-400" />
                                <span>{envCount} envs</span>
                              </button>

                              <button
                                onClick={(e) => { 
                                  e.stopPropagation(); 
                                  setRightSelectedPod(pod); 
                                  setRightSelectedPodTab('portforward'); 
                                }}
                                title="Port Forward in Right Pane"
                                className="p-1 text-slate-400 hover:text-indigo-300 hover:bg-slate-800 rounded"
                              >
                                <Radio className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); onOpenLogs(pod.metadata.name, rightNs, containers, rightCluster); }}
                                title="Stream Logs"
                                className="p-1 text-slate-400 hover:text-indigo-300 hover:bg-slate-800 rounded"
                              >
                                <Terminal className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); onOpenManifest('pod', pod.metadata.name, rightNs, rightCluster); }}
                                title="Manifest"
                                className="p-1 text-slate-400 hover:text-amber-300 hover:bg-slate-800 rounded"
                              >
                                <FileCode className="w-3.5 h-3.5" />
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

            {rightResource === 'deployments' && (
              <div className="p-3 divide-y divide-slate-800/60 font-mono text-xs">
                {filteredRightDeployments.map((d) => (
                  <div key={d.metadata.name} className="py-2 flex items-center justify-between hover:bg-slate-900/50 px-2 rounded">
                    <div>
                      <div className="font-semibold text-slate-100">{d.metadata.name}</div>
                      <div className="text-slate-400 text-[11px]">Replicas: {d.status?.readyReplicas || 0}/{d.spec?.replicas || 0}</div>
                    </div>
                    <button
                      onClick={() => onOpenManifest('deployment', d.metadata.name, rightNs, rightCluster)}
                      className="p-1 text-slate-400 hover:text-amber-300 rounded"
                      title="View Manifest"
                    >
                      <FileCode className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {rightResource === 'services' && (
              <div className="p-3 divide-y divide-slate-800/60 font-mono text-xs">
                {filteredRightServices.map((s) => (
                  <div key={s.metadata.name} className="py-2 flex items-center justify-between hover:bg-slate-900/50 px-2 rounded">
                    <div>
                      <div className="font-semibold text-slate-100">{s.metadata.name}</div>
                      <div className="text-slate-400 text-[11px]">{s.spec?.type} • IP: {s.spec?.clusterIP || 'None'}</div>
                    </div>
                    <button
                      onClick={() => onOpenManifest('service', s.metadata.name, rightNs, rightCluster)}
                      className="p-1 text-slate-400 hover:text-amber-300 rounded"
                      title="View Manifest"
                    >
                      <FileCode className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {rightResource === 'configmaps' && (
              <div className="p-3 divide-y divide-slate-800/60 font-mono text-xs">
                {filteredRightConfigMaps.map((c) => (
                  <div key={c.metadata.name} className="py-2 flex items-center justify-between hover:bg-slate-900/50 px-2 rounded">
                    <div>
                      <div className="font-semibold text-slate-100">{c.metadata.name}</div>
                      <div className="text-slate-400 text-[11px]">Keys: {Object.keys(c.data || {}).length}</div>
                    </div>
                    <button
                      onClick={() => onOpenManifest('configmap', c.metadata.name, rightNs, rightCluster)}
                      className="p-1 text-slate-400 hover:text-amber-300 rounded"
                      title="View Manifest"
                    >
                      <FileCode className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>

      </div>
    </div>
  );
};
