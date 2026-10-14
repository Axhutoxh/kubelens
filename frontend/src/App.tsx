import React, { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { Dock, DockTask } from './components/Dock';
import { CreateResourceModal } from './components/CreateResourceModal';
import { ScaleModal } from './components/ScaleModal';
import { ViewLoader } from './components/ViewLoader';

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
  fetchPortForwards
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
      if (currentView === 'nodes' || currentView === 'overview') {
        promises.push(fetchK8sResource<NodeItem>('nodes').then((res) => setNodes(res.items || [])).catch(() => {}));
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
          {currentView !== 'smart-lens-studio' && !loadedViews.has(viewKey) ? (
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
              onOpenManifest={handleOpenManifest}
              onDelete={handleDeleteResource}
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
