import React, { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { Sidebar, NAV_SECTIONS } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { Dock, DockTask } from './components/Dock';
import { CreateResourceModal } from './components/CreateResourceModal';
import { ScaleModal } from './components/ScaleModal';
import { ViewLoader } from './components/ViewLoader';
import { CommandPalette } from './components/CommandPalette';

// Views and the (large) pod detail modal are split into their own chunks and only
// downloaded/parsed when first opened, which keeps startup work small.
const PodDetailModal = lazy(() => import('./components/PodDetailModal').then((m) => ({ default: m.PodDetailModal })));
const ClusterOverview = lazy(() => import('./views/ClusterOverview').then((m) => ({ default: m.ClusterOverview })));
const PodsView = lazy(() => import('./views/PodsView').then((m) => ({ default: m.PodsView })));
const DeploymentsView = lazy(() => import('./views/DeploymentsView').then((m) => ({ default: m.DeploymentsView })));
const StatefulSetsView = lazy(() => import('./views/StatefulSetsView').then((m) => ({ default: m.StatefulSetsView })));
const DaemonSetsView = lazy(() => import('./views/DaemonSetsView').then((m) => ({ default: m.DaemonSetsView })));
const JobsView = lazy(() => import('./views/JobsView').then((m) => ({ default: m.JobsView })));
const StorageView = lazy(() => import('./views/StorageView').then((m) => ({ default: m.StorageView })));
const NamespacesView = lazy(() => import('./views/NamespacesView').then((m) => ({ default: m.NamespacesView })));
const NodesView = lazy(() => import('./views/NodesView').then((m) => ({ default: m.NodesView })));
const ServicesView = lazy(() => import('./views/ServicesView').then((m) => ({ default: m.ServicesView })));
const IngressesView = lazy(() => import('./views/IngressesView').then((m) => ({ default: m.IngressesView })));
const ConfigView = lazy(() => import('./views/ConfigView').then((m) => ({ default: m.ConfigView })));
const EventsView = lazy(() => import('./views/EventsView').then((m) => ({ default: m.EventsView })));
const SmartLensStudio = lazy(() => import('./views/SmartLensStudio').then((m) => ({ default: m.SmartLensStudio })));
const HelmView = lazy(() => import('./views/HelmView').then((m) => ({ default: m.HelmView })));
const CustomResourcesView = lazy(() => import('./views/CustomResourcesView').then((m) => ({ default: m.CustomResourcesView })));

// Views that fetch their own data (and show their own loading state)
const SELF_LOADING_VIEWS = new Set(['smart-lens-studio', 'helm', 'crds']);

const PALETTE_VIEWS = NAV_SECTIONS.flatMap((s) => s.items.map((i) => ({ id: i.id, label: i.label.replace(/^⚡\s*/, '') })));

const VIEW_LABELS: Record<string, string> = {
  overview: 'cluster overview',
  pods: 'pods',
  deployments: 'deployments',
  statefulsets: 'stateful sets',
  daemonsets: 'daemon sets',
  jobs: 'jobs',
  storage: 'storage',
  namespaces: 'namespaces',
  nodes: 'nodes',
  services: 'services',
  ingresses: 'ingresses',
  configmaps: 'config maps',
  secrets: 'secrets',
  events: 'events',
  helm: 'Helm releases',
  crds: 'custom resources',
};

const POLL_INTERVAL_MS = 10000;
const PORT_FORWARD_POLL_MS = 4000;

import { 
  fetchContexts, 
  switchContext, 
  fetchClusterOverview, 
  fetchK8sResource,
  getResourceManifest,
  applyManifest,
  deleteResource,
  restartResource,
  fetchPortForwards,
  fetchPodMetrics,
  fetchNodeMetrics,
  nodeAction,
  PodMetric,
  NodeMetric
} from './api/client';

import { 
  ContextItem, 
  ClusterOverviewData, 
  PodItem, 
  DeploymentItem, 
  StatefulSetItem,
  DaemonSetItem,
  JobItem,
  CronJobItem,
  PersistentVolumeClaimItem,
  PersistentVolumeItem,
  StorageClassItem,
  NodeItem, 
  ServiceItem, 
  EventItem,
  ConfigMapItem,
  SecretItem,
  IngressItem,
  PortForwardSession
} from './types/k8s';

export const App: React.FC = () => {
  // Navigation & Filter State
  const [currentView, setCurrentView] = useState('overview');
  const [contexts, setContexts] = useState<ContextItem[]>([]);
  const [currentContext, setCurrentContext] = useState<string>('');
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [selectedNamespace, setSelectedNamespace] = useState<string>('_all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('freelens_sidebar_collapsed') === 'true';
    } catch {
      return false;
    }
  });

  const toggleSidebar = () => {
    setIsSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('freelens_sidebar_collapsed', String(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  // Cluster Resource State
  const [overview, setOverview] = useState<ClusterOverviewData | null>(null);
  const [pods, setPods] = useState<PodItem[]>([]);
  const [deployments, setDeployments] = useState<DeploymentItem[]>([]);
  const [statefulSets, setStatefulSets] = useState<StatefulSetItem[]>([]);
  const [daemonSets, setDaemonSets] = useState<DaemonSetItem[]>([]);
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [cronJobs, setCronJobs] = useState<CronJobItem[]>([]);
  const [pvcs, setPvcs] = useState<PersistentVolumeClaimItem[]>([]);
  const [pvs, setPvs] = useState<PersistentVolumeItem[]>([]);
  const [storageClasses, setStorageClasses] = useState<StorageClassItem[]>([]);
  const [nodes, setNodes] = useState<NodeItem[]>([]);
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [configMaps, setConfigMaps] = useState<ConfigMapItem[]>([]);
  const [secrets, setSecrets] = useState<SecretItem[]>([]);
  const [ingresses, setIngresses] = useState<IngressItem[]>([]);

  // Live usage from metrics-server (keyed `${namespace}/${name}` for pods, name for nodes)
  const [podMetrics, setPodMetrics] = useState<Map<string, PodMetric>>(() => new Map());
  const [nodeMetrics, setNodeMetrics] = useState<Map<string, NodeMetric>>(() => new Map());
  const [metricsAvailable, setMetricsAvailable] = useState<boolean | undefined>(undefined);

  // Bumped by the refresh button so self-loading views (Helm, CRDs) reload too
  const [refreshTick, setRefreshTick] = useState(0);
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);

  // Dock & Multi-Task State
  const [isDockOpen, setIsDockOpen] = useState(false);
  const [dockTasks, setDockTasks] = useState<DockTask[]>([]);
  const [activeDockTaskId, setActiveDockTaskId] = useState<string>('');

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [scaleTarget, setScaleTarget] = useState<{ kind: string; name: string; namespace: string; currentReplicas: number } | null>(null);

  // Pod Details Modal & Active Port Forwards State
  const [selectedPod, setSelectedPod] = useState<PodItem | null>(null);
  const [selectedPodContext, setSelectedPodContext] = useState<string | undefined>(undefined);
  const [selectedPodTab, setSelectedPodTab] = useState<'overview' | 'env' | 'containers' | 'portforward' | 'events' | 'yaml'>('overview');
  const [portForwards, setPortForwards] = useState<PortForwardSession[]>([]);

  // Notification Toast State
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  };

  const loadPortForwards = useCallback(async () => {
    try {
      const data = await fetchPortForwards();
      setPortForwards(data.sessions || []);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadPortForwards();
    // Skip polling while the window is minimized / hidden
    const timer = setInterval(() => {
      if (!document.hidden) loadPortForwards();
    }, PORT_FORWARD_POLL_MS);
    return () => clearInterval(timer);
  }, [loadPortForwards]);

  // Initial Load: Contexts & Overview
  const loadContexts = async () => {
    try {
      const data = await fetchContexts();
      setContexts(data.contexts || []);
      setCurrentContext(data.currentContext || '');
    } catch (err: any) {
      console.error('Failed to load contexts', err);
    }
  };

  // Read through refs inside loadResources so that receiving the namespace list or the
  // initial context doesn't recreate the callback (which restarted polling and refetched
  // every resource a second and third time during startup).
  const namespacesLoadedRef = useRef(false);
  const currentContextRef = useRef(currentContext);
  currentContextRef.current = currentContext;

  // Views whose first fetch has completed, keyed by view + namespace. Until then the view
  // shows a loading skeleton instead of an empty table.
  const [loadedViews, setLoadedViews] = useState<Set<string>>(() => new Set());
  const viewKey = `${currentView}|${selectedNamespace}`;

  // Fetch all Resources for active cluster & namespace
  const loadResources = useCallback(async (silent = false) => {
    if (currentView === 'smart-lens-studio') return;
    const loadedKey = `${currentView}|${selectedNamespace}`;
    if (!silent) setIsRefreshing(true);
    try {
      const promises: Promise<any>[] = [];

      // Namespaces list (fetch once or on manual refresh)
      if (!silent || !namespacesLoadedRef.current) {
        promises.push(
          fetchK8sResource('namespaces').then((res) => {
            namespacesLoadedRef.current = true;
            setNamespaces(res.items?.map((ns: any) => ns.metadata.name) || []);
          }).catch(() => {})
        );
      }

      // Overview only if overview view is active
      if (currentView === 'overview') {
        promises.push(fetchClusterOverview().then(setOverview).catch(() => {}));
      }

      // View-specific data
      const ns = selectedNamespace;

      if (currentView === 'pods' || currentView === 'overview') {
        promises.push(fetchK8sResource<PodItem>('pods', ns).then((res) => setPods(res.items || [])).catch(() => {}));
      }
      if (currentView === 'pods') {
        // Metrics never block the table: they arrive separately and fail soft
        fetchPodMetrics(ns).then((m) => {
          setMetricsAvailable(m.available);
          setPodMetrics(new Map((m.items || []).map((x) => [`${x.namespace}/${x.name}`, x])));
        }).catch(() => {});
      }
      if (currentView === 'nodes' || currentView === 'overview') {
        promises.push(fetchK8sResource<NodeItem>('nodes').then((res) => setNodes(res.items || [])).catch(() => {}));
      }
      if (currentView === 'nodes') {
        fetchNodeMetrics().then((m) => {
          setMetricsAvailable(m.available);
          setNodeMetrics(new Map((m.items || []).map((x) => [x.name, x])));
        }).catch(() => {});
      }
      if (currentView === 'events' || currentView === 'overview') {
        promises.push(fetchK8sResource<EventItem>('events', ns).then((res) => setEvents(res.items || [])).catch(() => {}));
      }
      if (currentView === 'deployments' || currentView === 'overview') {
        promises.push(fetchK8sResource<DeploymentItem>('deployments', ns).then((res) => setDeployments(res.items || [])).catch(() => {}));
      }
      if (currentView === 'statefulsets') {
        promises.push(fetchK8sResource<StatefulSetItem>('statefulsets', ns).then((res) => setStatefulSets(res.items || [])).catch(() => {}));
      }
      if (currentView === 'daemonsets') {
        promises.push(fetchK8sResource<DaemonSetItem>('daemonsets', ns).then((res) => setDaemonSets(res.items || [])).catch(() => {}));
      }
      if (currentView === 'jobs') {
        promises.push(fetchK8sResource<JobItem>('jobs', ns).then((res) => setJobs(res.items || [])).catch(() => {}));
        promises.push(fetchK8sResource<CronJobItem>('cronjobs', ns).then((res) => setCronJobs(res.items || [])).catch(() => {}));
      }
      if (currentView === 'storage') {
        promises.push(fetchK8sResource<PersistentVolumeClaimItem>('persistentvolumeclaims', ns).then((res) => setPvcs(res.items || [])).catch(() => {}));
        promises.push(fetchK8sResource<PersistentVolumeItem>('persistentvolumes').then((res) => setPvs(res.items || [])).catch(() => {}));
        promises.push(fetchK8sResource<StorageClassItem>('storageclasses').then((res) => setStorageClasses(res.items || [])).catch(() => {}));
      }
      if (currentView === 'services' || currentView === 'overview') {
        promises.push(fetchK8sResource<ServiceItem>('services', ns).then((res) => setServices(res.items || [])).catch(() => {}));
      }
      if (currentView === 'ingresses') {
        promises.push(
          fetchK8sResource<IngressItem>('ingresses', ns, currentContextRef.current)
            .then((res) => setIngresses(Array.isArray(res?.items) ? res.items : []))
            .catch((err) => {
              console.error('Failed to load ingresses:', err);
              setIngresses([]);
            })
        );
      }
      if (currentView === 'configmaps') {
        promises.push(fetchK8sResource<ConfigMapItem>('configmaps', ns).then((res) => setConfigMaps(res.items || [])).catch(() => {}));
      }
      if (currentView === 'secrets') {
        promises.push(fetchK8sResource<SecretItem>('secrets', ns).then((res) => setSecrets(res.items || [])).catch(() => {}));
      }

      await Promise.allSettled(promises);
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setIsRefreshing(false);
      setLoadedViews((prev) => (prev.has(loadedKey) ? prev : new Set(prev).add(loadedKey)));
    }
  }, [currentView, selectedNamespace]);

  useEffect(() => {
    loadContexts();
  }, []);

  useEffect(() => {
    if (currentView === 'smart-lens-studio') return;
    loadResources();
    // Poll only while the window is visible, and catch up as soon as it is shown again
    const interval = setInterval(() => {
      if (!document.hidden) loadResources(true);
    }, POLL_INTERVAL_MS);
    const onVisible = () => {
      if (!document.hidden) loadResources(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [loadResources, currentView]);

  // Handle Switch Context
  const handleSwitchContext = async (newCtx: string) => {
    try {
      setIsRefreshing(true);
      await switchContext(newCtx);
      currentContextRef.current = newCtx;
      setCurrentContext(newCtx);
      // Data from the previous cluster is stale; show loaders until the new cluster responds
      setLoadedViews(new Set());
      showToast(`Switched context to ${newCtx}`);
      await loadResources();
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setIsRefreshing(false);
    }
  };

  // Open Log Stream Task
  const handleOpenLogs = (pod: string, namespace: string, containers: string[], context?: string) => {
    const taskId = `logs-${context || 'default'}-${namespace}-${pod}`;
    const taskTitle = `Logs (${pod})${context ? ` [${context}]` : ''}`;
    setDockTasks((prev) => {
      const existing = prev.find((t) => t.id === taskId);
      if (existing) {
        return prev;
      }
      return [
        ...prev,
        {
          id: taskId,
          type: 'logs',
          title: taskTitle,
          pod,
          namespace,
          containers,
          container: containers[0] || '',
          context,
        },
      ];
    });
    setActiveDockTaskId(taskId);
    setIsDockOpen(true);
  };

  // Open YAML Manifest Task
  const handleOpenManifest = async (kind: string, name: string, namespace?: string, context?: string) => {
    try {
      const content = await getResourceManifest(kind, name, namespace, context);
      const taskId = `manifest-${context || 'default'}-${kind}-${namespace || 'cluster'}-${name}`;
      const taskTitle = `YAML ${kind}/${name}${context ? ` [${context}]` : ''}`;
      setDockTasks((prev) => {
        const existing = prev.find((t) => t.id === taskId);
        if (existing) {
          return prev.map((t) => (t.id === taskId ? { ...t, content } : t));
        }
        return [
          ...prev,
          {
            id: taskId,
            type: 'manifest',
            title: taskTitle,
            kind,
            name,
            namespace,
            content,
            context,
          },
        ];
      });
      setActiveDockTaskId(taskId);
      setIsDockOpen(true);
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  };

  // Open an interactive shell in a pod (one tab per pod; reopening focuses it)
  const handleOpenShell = (pod: string, namespace: string, containers: string[], context?: string) => {
    const taskId = `shell-${context || 'default'}-${namespace}-${pod}`;
    setDockTasks((prev) => prev.some((t) => t.id === taskId) ? prev : [
      ...prev,
      {
        id: taskId,
        type: 'shell',
        title: `Shell (${pod})${context ? ` [${context}]` : ''}`,
        pod,
        namespace,
        containers,
        container: containers[0] || '',
        context,
        sessionKey: 0,
      },
    ]);
    setActiveDockTaskId(taskId);
    setIsDockOpen(true);
  };

  // Combined log stream for several pods, or every pod matching a label selector
  const handleOpenMultiLogs = (opts: { targets?: Array<{ name: string; namespace: string }>; selector?: string; namespace?: string; title: string }) => {
    const taskId = opts.selector
      ? `multilogs-${opts.namespace}-${opts.selector}`
      : `multilogs-${opts.targets!.map((t) => `${t.namespace}/${t.name}`).sort().join(',')}`;
    setDockTasks((prev) => prev.some((t) => t.id === taskId) ? prev : [
      ...prev,
      { id: taskId, type: 'multilogs', title: opts.title, targets: opts.targets, selector: opts.selector, namespace: opts.namespace },
    ]);
    setActiveDockTaskId(taskId);
    setIsDockOpen(true);
  };

  const handleUpdateDockTask = (id: string, patch: Partial<DockTask>) => {
    setDockTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  };

  // Delete many pods at once (one confirmation, parallel requests, one summary toast)
  const handleBulkDeletePods = async (targets: Array<{ name: string; namespace: string }>) => {
    const preview = targets.slice(0, 8).map((t) => `  • ${t.namespace}/${t.name}`).join('\n');
    const more = targets.length > 8 ? `\n  …and ${targets.length - 8} more` : '';
    if (!window.confirm(`Delete ${targets.length} pods?\n\n${preview}${more}`)) return;
    setIsRefreshing(true);
    const results = await Promise.allSettled(targets.map((t) => deleteResource('pod', t.name, t.namespace)));
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed === 0) showToast(`Deleted ${targets.length} pods`);
    else showToast(`Deleted ${targets.length - failed} of ${targets.length} pods (${failed} failed)`, 'error');
    loadResources();
  };

  const handleNodeAction = async (node: string, action: 'cordon' | 'uncordon' | 'drain', force = false) => {
    try {
      if (action === 'drain') showToast(`Draining ${node}… this can take a minute`);
      await nodeAction(node, action, force);
      showToast(`${action[0].toUpperCase()}${action.slice(1)}ed ${node}`);
      loadResources();
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  };

  // Ctrl+K / Ctrl+Shift+P opens the command palette from anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if ((mod && e.key.toLowerCase() === 'k') || (mod && e.shiftKey && e.key.toLowerCase() === 'p')) {
        // Let a focused terminal keep Ctrl+K (clear line) unless the palette is already open
        if ((e.target as HTMLElement)?.closest?.('.xterm') && !isPaletteOpen) return;
        e.preventDefault();
        setIsPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isPaletteOpen]);

  // Close specific dock task / process individually
  const handleCloseDockTask = (taskId: string) => {
    setDockTasks((prev) => {
      const filtered = prev.filter((t) => t.id !== taskId);
      if (filtered.length === 0) {
        setIsDockOpen(false);
        setActiveDockTaskId('');
      } else if (activeDockTaskId === taskId) {
        setActiveDockTaskId(filtered[filtered.length - 1].id);
      }
      return filtered;
    });
  };

  // Delete Resource
  const handleDeleteResource = async (kind: string, name: string, namespace?: string) => {
    if (!window.confirm(`Are you sure you want to delete ${kind} "${name}" in namespace "${namespace || 'default'}"?`)) {
      return;
    }
    try {
      await deleteResource(kind, name, namespace);
      showToast(`Deleted ${kind} ${name}`);
      loadResources();
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  };

  // Restart Resource
  const handleRestartResource = async (kind: string, name: string, namespace: string) => {
    try {
      await restartResource(kind, name, namespace);
      showToast(`Triggered rollout restart for ${name}`);
      loadResources();
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-950 text-slate-100 font-sans">
      {/* Toast Notification */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-2.5 rounded-lg shadow-xl text-xs font-medium border transition-all animate-in fade-in slide-in-from-top-2 ${
          toast.type === 'success' 
            ? 'bg-emerald-950/90 border-emerald-800 text-emerald-300'
            : 'bg-rose-950/90 border-rose-800 text-rose-300'
        }`}>
          {toast.message}
        </div>
      )}

      {/* Main Sidebar */}
      <Sidebar
        currentView={currentView}
        onSelectView={setCurrentView}
        contexts={contexts}
        currentContext={currentContext}
        onSwitchContext={handleSwitchContext}
        isCollapsed={isSidebarCollapsed}
        onToggleCollapse={toggleSidebar}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        <TopBar
          namespaces={namespaces}
          selectedNamespace={selectedNamespace}
          onSelectNamespace={setSelectedNamespace}
          onToggleSidebar={toggleSidebar}
          isSidebarCollapsed={isSidebarCollapsed}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onRefresh={() => {
            loadResources();
            setRefreshTick((t) => t + 1);
            loadPortForwards();
          }}
          isRefreshing={isRefreshing}
          onOpenCreateModal={() => setIsCreateModalOpen(true)}
          onToggleDock={() => setIsDockOpen(!isDockOpen)}
          isDockOpen={isDockOpen}
          portForwardsCount={portForwards.length}
          onOpenPortForwards={() => setCurrentView('pods')}
          onOpenSmartLensStudio={() => setCurrentView('smart-lens-studio')}
          isSmartLensStudioActive={currentView === 'smart-lens-studio'}
        />

        {/* Global Loading Progress Bar */}
        {isRefreshing && (
          <div className="h-0.5 w-full bg-cyan-950 overflow-hidden shrink-0">
            <div className="h-full bg-gradient-to-r from-cyan-500 via-indigo-400 to-cyan-400 animate-[pulse_1s_infinite] w-full" />
          </div>
        )}

        {/* View Routing */}
        <main className="flex-1 overflow-hidden relative bg-slate-950/60">
          <Suspense fallback={<ViewLoader label={`Loading ${VIEW_LABELS[currentView] || 'view'}…`} />}>
          {!SELF_LOADING_VIEWS.has(currentView) && !loadedViews.has(viewKey) ? (
            <ViewLoader label={`Fetching ${VIEW_LABELS[currentView] || 'resources'} from ${currentContext || 'cluster'}…`} />
          ) : (
          <>
          {currentView === 'overview' && (
            <ClusterOverview
              overview={overview}
              pods={pods}
              nodes={nodes}
              events={events}
              onNavigate={setCurrentView}
            />
          )}

          {currentView === 'pods' && (
            <PodsView
              pods={pods}
              searchQuery={searchQuery}
              activePortForwards={portForwards}
              onSelectPod={(pod) => {
                setSelectedPod(pod);
                setSelectedPodContext(undefined);
                setSelectedPodTab('overview');
              }}
              onOpenLogs={handleOpenLogs}
              onOpenShell={(pod, ns, containers) => handleOpenShell(pod, ns, containers)}
              onOpenMultiLogs={(targets) => handleOpenMultiLogs({ targets, title: `Logs (${targets.length} pods)` })}
              onBulkDelete={handleBulkDeletePods}
              podMetrics={podMetrics}
              metricsAvailable={metricsAvailable}
              onOpenManifest={handleOpenManifest}
              onDelete={handleDeleteResource}
              onToast={showToast}
            />
          )}

          {currentView === 'deployments' && (
            <DeploymentsView
              deployments={deployments}
              searchQuery={searchQuery}
              onScale={(dep) => setScaleTarget({
                kind: 'deployment',
                name: dep.metadata.name,
                namespace: dep.metadata.namespace || 'default',
                currentReplicas: dep.spec.replicas || 1,
              })}
              onRestart={handleRestartResource}
              onOpenManifest={handleOpenManifest}
              onDelete={handleDeleteResource}
              onOpenAllLogs={(dep) => {
                const labels: Record<string, string> = dep.spec.selector?.matchLabels || {};
                const selector = Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(',');
                if (!selector) {
                  showToast('This deployment has no matchLabels selector', 'error');
                  return;
                }
                handleOpenMultiLogs({ selector, namespace: dep.metadata.namespace || 'default', title: `Logs (${dep.metadata.name}, all pods)` });
              }}
              onRefresh={() => loadResources()}
              onToast={showToast}
            />
          )}

          {currentView === 'statefulsets' && (
            <StatefulSetsView
              statefulSets={statefulSets}
              searchQuery={searchQuery}
              onScale={setScaleTarget}
              onRestart={handleRestartResource}
              onOpenManifest={handleOpenManifest}
              onDelete={handleDeleteResource}
            />
          )}

          {currentView === 'daemonsets' && (
            <DaemonSetsView
              daemonSets={daemonSets}
              searchQuery={searchQuery}
              onRestart={handleRestartResource}
              onOpenManifest={handleOpenManifest}
              onDelete={handleDeleteResource}
            />
          )}

          {currentView === 'jobs' && (
            <JobsView
              jobs={jobs}
              cronJobs={cronJobs}
              searchQuery={searchQuery}
              onOpenManifest={handleOpenManifest}
              onDelete={handleDeleteResource}
              onTriggerCronJob={async (cj) => {
                try {
                  const jobName = `${cj.metadata.name}-manual-${Date.now().toString().slice(-4)}`;
                  const templateSpec = cj.spec?.jobTemplate?.spec?.template;
                  const manifestObj = {
                    apiVersion: 'batch/v1',
                    kind: 'Job',
                    metadata: {
                      name: jobName,
                      namespace: cj.metadata.namespace || 'default',
                    },
                    spec: {
                      template: templateSpec || {},
                    },
                  };
                  await applyManifest(JSON.stringify(manifestObj), currentContext);
                  showToast(`Job "${jobName}" triggered successfully`);
                  loadResources();
                } catch (e: any) {
                  showToast(e.message || 'Failed to trigger Job', 'error');
                }
              }}
            />
          )}

          {currentView === 'storage' && (
            <StorageView
              pvcs={pvcs}
              pvs={pvs}
              storageClasses={storageClasses}
              searchQuery={searchQuery}
              onOpenManifest={handleOpenManifest}
              onDelete={handleDeleteResource}
            />
          )}

          {currentView === 'namespaces' && (
            <NamespacesView
              namespaces={namespaces}
              searchQuery={searchQuery}
              selectedNamespace={selectedNamespace}
              onSelectNamespace={setSelectedNamespace}
              onOpenManifest={handleOpenManifest}
              onDelete={handleDeleteResource}
              onRefresh={loadResources}
              onToast={showToast}
            />
          )}

          {currentView === 'nodes' && (
            <NodesView
              nodes={nodes}
              searchQuery={searchQuery}
              onOpenManifest={handleOpenManifest}
              nodeMetrics={nodeMetrics}
              metricsAvailable={metricsAvailable}
              onNodeAction={handleNodeAction}
            />
          )}

          {currentView === 'services' && (
            <ServicesView
              services={services}
              searchQuery={searchQuery}
              onOpenManifest={handleOpenManifest}
              onDelete={handleDeleteResource}
            />
          )}

          {currentView === 'ingresses' && (
            <IngressesView
              ingresses={ingresses}
              searchQuery={searchQuery}
              currentContext={currentContext}
              onOpenManifest={handleOpenManifest}
              onDelete={handleDeleteResource}
              onRefresh={loadResources}
              onToast={showToast}
            />
          )}

          {(currentView === 'configmaps' || currentView === 'secrets') && (
            <ConfigView
              configMaps={configMaps}
              secrets={secrets}
              type={currentView as any}
              searchQuery={searchQuery}
              currentContext={currentContext}
              onOpenManifest={handleOpenManifest}
              onDelete={handleDeleteResource}
              onRefresh={loadResources}
              onToast={showToast}
            />
          )}

          {currentView === 'events' && (
            <EventsView
              events={events}
              searchQuery={searchQuery}
            />
          )}

          {currentView === 'helm' && (
            <HelmView
              namespace={selectedNamespace}
              currentContext={currentContext}
              searchQuery={searchQuery}
              refreshTick={refreshTick}
              onToast={showToast}
            />
          )}

          {currentView === 'crds' && (
            <CustomResourcesView
              namespace={selectedNamespace}
              currentContext={currentContext}
              searchQuery={searchQuery}
              refreshTick={refreshTick}
              onOpenManifest={handleOpenManifest}
              onDelete={handleDeleteResource}
            />
          )}

          {currentView === 'smart-lens-studio' && (
            <SmartLensStudio
              contexts={contexts}
              currentContext={currentContext}
              namespaces={namespaces}
              currentNamespace={selectedNamespace}
              activePortForwards={portForwards}
              onSelectPod={(pod, ctx, initialTab) => {
                setSelectedPod(pod);
                setSelectedPodContext(ctx);
                setSelectedPodTab(initialTab || 'overview');
              }}
              onOpenLogs={(pod, ns, containers, ctx) => handleOpenLogs(pod, ns, containers, ctx)}
              onOpenManifest={(kind, name, ns, ctx) => handleOpenManifest(kind, name, ns, ctx)}
              onToast={showToast}
            />
          )}
          </>
          )}
          </Suspense>
        </main>

        {/* Bottom Dock (Multi-Task: Logs & YAML Editor with per-task close button) */}
        <Dock
          isOpen={isDockOpen}
          onClose={() => setIsDockOpen(false)}
          tasks={dockTasks}
          activeTaskId={activeDockTaskId}
          onSelectTask={setActiveDockTaskId}
          onCloseTask={handleCloseDockTask}
          onUpdateTask={handleUpdateDockTask}
        />

        {/* Bottom Status Bar */}
        <footer className="h-6 bg-slate-950 border-t border-slate-800/80 px-3 flex items-center justify-between text-[11px] text-slate-400 select-none shrink-0 z-10">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 text-emerald-400 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span>Connected: {currentContext || 'Detecting...'}</span>
            </span>
            {selectedNamespace !== '_all' && (
              <span className="text-slate-500">• Namespace: <span className="text-slate-300 font-mono">{selectedNamespace}</span></span>
            )}
            <button
              onClick={() => setIsPaletteOpen(true)}
              className="text-slate-500 hover:text-cyan-300 transition-colors"
              title="Command palette"
            >
              <kbd className="font-mono text-[10px] border border-slate-700 rounded px-1">Ctrl K</kbd> search everything
            </button>
            {isRefreshing && (
              <span className="flex items-center gap-1 text-cyan-400 text-[10px] animate-pulse">
                <span className="w-1 h-1 rounded-full bg-cyan-400" />
                <span>Syncing cluster...</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <img src="/logo.png" alt="Kubellens" className="w-3.5 h-3.5 rounded-sm object-contain" />
            <span className="text-slate-400 font-mono text-[10px] font-semibold">KUBELLENS</span>
            <span className="text-slate-700">•</span>
            <span className="text-cyan-400 font-semibold flex items-center gap-1">
              <span>developed by Ashutosh</span>
            </span>
          </div>
        </footer>
      </div>

      <CommandPalette
        isOpen={isPaletteOpen}
        onClose={() => setIsPaletteOpen(false)}
        views={PALETTE_VIEWS}
        contexts={contexts.map((c) => c.name)}
        currentContext={currentContext}
        namespaces={namespaces}
        selectedNamespace={selectedNamespace}
        onNavigate={(view, search) => {
          setCurrentView(view);
          if (search !== undefined) setSearchQuery(search);
        }}
        onSwitchContext={handleSwitchContext}
        onSelectNamespace={setSelectedNamespace}
        onOpenPod={(pod) => {
          setSelectedPod(pod);
          setSelectedPodContext(undefined);
          setSelectedPodTab('overview');
        }}
        actions={[
          { id: 'refresh', label: 'Refresh cluster data', run: () => { loadResources(); setRefreshTick((t) => t + 1); } },
          { id: 'create', label: 'Create resource from YAML', run: () => setIsCreateModalOpen(true) },
          { id: 'dock', label: isDockOpen ? 'Hide bottom panel' : 'Show bottom panel', run: () => setIsDockOpen(!isDockOpen) },
          { id: 'sidebar', label: isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar', run: toggleSidebar },
          { id: 'clear-search', label: 'Clear search filter', run: () => setSearchQuery('') },
        ]}
      />

      {/* Modals */}
      <CreateResourceModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onSuccess={() => loadResources()}
        defaultNamespace={selectedNamespace !== '_all' ? selectedNamespace : 'default'}
      />

      <ScaleModal
        isOpen={!!scaleTarget}
        onClose={() => setScaleTarget(null)}
        onSuccess={() => loadResources()}
        target={scaleTarget}
      />

      {/* Pod Detail & Port Forward Modal */}
      {selectedPod && (
        <Suspense fallback={
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-sm">
            <div className="w-8 h-8 rounded-full border-2 border-cyan-500/20 border-t-cyan-400 animate-spin" />
          </div>
        }>
        <PodDetailModal
          isOpen={!!selectedPod}
          pod={selectedPod}
          context={selectedPodContext}
          initialTab={selectedPodTab}
          onClose={() => {
            setSelectedPod(null);
            setSelectedPodContext(undefined);
            setSelectedPodTab('overview');
          }}
          onOpenLogs={(pod, ns, containers) => handleOpenLogs(pod, ns, containers, selectedPodContext)}
          onOpenManifest={(kind, name, ns) => handleOpenManifest(kind, name, ns, selectedPodContext)}
          onRefreshList={() => {
            loadResources();
            loadPortForwards();
          }}
          onToast={showToast}
        />
        </Suspense>
      )}
    </div>
  );
};
