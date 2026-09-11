import React, { useState, useEffect, useMemo } from 'react';
import { 
  Box, 
  X, 
  Copy, 
  Check, 
  ExternalLink, 
  Terminal, 
  FileCode, 
  Trash2, 
  Radio, 
  CheckCircle2, 
  AlertCircle, 
  Clock, 
  Square, 
  Play, 
  RefreshCw, 
  Cpu, 
  Layers, 
  Tag, 
  ShieldCheck,
  ChevronRight,
  HardDrive,
  Sliders,
  Plus,
  Eye,
  EyeOff,
  RotateCcw,
  Search,
  Save,
  Key,
  Info,
  ArrowLeft,
  Maximize2
} from 'lucide-react';
import { 
  PodItem, 
  PortForwardSession, 
  EventItem,
  ContainerEnvVar
} from '../types/k8s';
import { 
  startPortForward, 
  stopPortForward, 
  fetchPortForwards, 
  fetchResourceDetail, 
  fetchPodEvents,
  deleteResource,
  setPodEnv
} from '../api/client';

interface EditableEnvItem {
  id: string;
  name: string;
  value: string;
  isRef?: boolean;
  refType?: 'secret' | 'configmap' | 'field' | 'resource' | 'literal';
  refName?: string;
  refKey?: string;
  refDetails?: string;
  isFromEnvFrom?: boolean;
  isNew?: boolean;
  isDeleted?: boolean;
  originalValue?: string;
}

export function parseImageTag(imageStr?: string): { repo: string; tag: string } {
  if (!imageStr) return { repo: 'unknown', tag: 'latest' };

  if (imageStr.includes('@')) {
    const parts = imageStr.split('@');
    return { repo: parts[0], tag: parts[1].substring(0, 16) + '...' };
  }

  const lastSlash = imageStr.lastIndexOf('/');
  const lastColon = imageStr.lastIndexOf(':');

  if (lastColon > lastSlash) {
    return {
      repo: imageStr.substring(0, lastColon),
      tag: imageStr.substring(lastColon + 1),
    };
  }

  return { repo: imageStr, tag: 'latest' };
}

interface PodDetailModalProps {
  pod: PodItem;
  context?: string;
  initialTab?: 'overview' | 'env' | 'containers' | 'portforward' | 'events' | 'yaml';
  isOpen: boolean;
  onClose: () => void;
  onOpenLogs: (pod: string, namespace: string, containers: string[]) => void;
  onOpenManifest: (kind: string, name: string, namespace: string) => void;
  onRefreshList?: () => void;
  onToast: (message: string, type?: 'success' | 'error') => void;
  isInline?: boolean;
  onExpandFullscreen?: (
    pod: PodItem, 
    context?: string, 
    initialTab?: 'overview' | 'env' | 'containers' | 'portforward' | 'events' | 'yaml'
  ) => void;
}

export const PodDetailModal: React.FC<PodDetailModalProps> = ({
  pod: initialPod,
  context,
  initialTab = 'overview',
  isOpen,
  onClose,
  onOpenLogs,
  onOpenManifest,
  onRefreshList,
  onToast,
  isInline = false,
  onExpandFullscreen,
}) => {
  const [activeTab, setActiveTab] = useState<'overview' | 'env' | 'containers' | 'portforward' | 'events' | 'yaml'>(initialTab);
  const [pod, setPod] = useState<PodItem>(initialPod);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);

  useEffect(() => {
    if (initialTab) {
      setActiveTab(initialTab);
    }
  }, [initialTab]);

  useEffect(() => {
    setPod(initialPod);
  }, [initialPod.metadata.uid || initialPod.metadata.name]);
  const [copiedText, setCopiedText] = useState<string | null>(null);

  // Events State
  const [events, setEvents] = useState<EventItem[]>([]);
  const [isLoadingEvents, setIsLoadingEvents] = useState(false);

  // Port Forward State
  const [activeForwards, setActiveForwards] = useState<PortForwardSession[]>([]);
  const [isLoadingForwards, setIsLoadingForwards] = useState(false);
  const [containerPortInput, setContainerPortInput] = useState<string>('');
  const [localPortInput, setLocalPortInput] = useState<string>('');
  const [isStartingForward, setIsStartingForward] = useState(false);
  const [forwardError, setForwardError] = useState<string | null>(null);

  // Environment Variables Editing State
  const [selectedEnvContainer, setSelectedEnvContainer] = useState<string>(
    initialPod.spec.containers[0]?.name || ''
  );
  const [editableEnvs, setEditableEnvs] = useState<EditableEnvItem[]>([]);
  const [envFilter, setEnvFilter] = useState<string>('');
  const [showSensitiveValues, setShowSensitiveValues] = useState<Record<string, boolean>>({});
  const [newEnvKey, setNewEnvKey] = useState<string>('');
  const [newEnvValue, setNewEnvValue] = useState<string>('');
  const [isSavingEnv, setIsSavingEnv] = useState<boolean>(false);
  const [showAllValues, setShowAllValues] = useState<boolean>(false);
  const [isTogglingAll, setIsTogglingAll] = useState<boolean>(false);

  // Secret & ConfigMap inspection / reveal state (Lens style)
  const [secretCache, setSecretCache] = useState<Record<string, any>>({});
  const [configMapCache, setConfigMapCache] = useState<Record<string, any>>({});
  const [revealedKeys, setRevealedKeys] = useState<Record<string, boolean>>({});
  const [loadingKeys, setLoadingKeys] = useState<Record<string, boolean>>({});
  const [envFromVars, setEnvFromVars] = useState<Record<string, EditableEnvItem[]>>({});
  const [isLoadingEnvFrom, setIsLoadingEnvFrom] = useState<boolean>(false);
  const [overviewEnvFilter, setOverviewEnvFilter] = useState<string>('');

  // Raw YAML State
  const [rawYaml, setRawYaml] = useState<string>('');

  const podName = pod.metadata.name;
  const podNamespace = pod.metadata.namespace || 'default';
  const containerNames = pod.spec.containers.map((c) => c.name);

  // Safely decode base64 strings with UTF-8 support
  const decodeBase64Utf8 = (b64: string): string => {
    try {
      const binStr = atob(b64);
      const bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) {
        bytes[i] = binStr.charCodeAt(i);
      }
      return new TextDecoder().decode(bytes);
    } catch {
      try {
        return atob(b64);
      } catch {
        return b64;
      }
    }
  };

  const getSecretValue = (secretName: string, key: string): string | null => {
    const s = secretCache[secretName];
    if (!s) return null;
    if (s.data && s.data[key] !== undefined) {
      return decodeBase64Utf8(s.data[key]);
    }
    if (s.stringData && s.stringData[key] !== undefined) {
      return s.stringData[key];
    }
    return null;
  };

  const getConfigMapValue = (cmName: string, key: string): string | null => {
    const cm = configMapCache[cmName];
    if (!cm) return null;
    if (cm.data && cm.data[key] !== undefined) {
      return cm.data[key];
    }
    if (cm.binaryData && cm.binaryData[key] !== undefined) {
      return decodeBase64Utf8(cm.binaryData[key]);
    }
    return null;
  };

  // Helper to check if a specific env item is revealed
  const isItemRevealed = (itemId: string): boolean => {
    return revealedKeys[itemId] !== undefined ? !!revealedKeys[itemId] : showAllValues;
  };

  const toggleRevealValue = async (item: EditableEnvItem) => {
    const isCurrentlyRevealed = isItemRevealed(item.id);
    if (isCurrentlyRevealed) {
      setRevealedKeys((prev) => ({ ...prev, [item.id]: false }));
      return;
    }

    if (item.refType === 'secret' && item.refName && item.refKey) {
      if (!secretCache[item.refName]) {
        setLoadingKeys((prev) => ({ ...prev, [item.id]: true }));
        try {
          const sec = await fetchResourceDetail('secret', item.refName, podNamespace, context);
          setSecretCache((prev) => ({ ...prev, [item.refName!]: sec }));
          setRevealedKeys((prev) => ({ ...prev, [item.id]: true }));
        } catch (err: any) {
          onToast(`Failed to load secret "${item.refName}": ${err.message}`, 'error');
        } finally {
          setLoadingKeys((prev) => ({ ...prev, [item.id]: false }));
        }
      } else {
        setRevealedKeys((prev) => ({ ...prev, [item.id]: true }));
      }
    } else if (item.refType === 'configmap' && item.refName && item.refKey) {
      if (!configMapCache[item.refName]) {
        setLoadingKeys((prev) => ({ ...prev, [item.id]: true }));
        try {
          const cm = await fetchResourceDetail('configmap', item.refName, podNamespace, context);
          setConfigMapCache((prev) => ({ ...prev, [item.refName!]: cm }));
          setRevealedKeys((prev) => ({ ...prev, [item.id]: true }));
        } catch (err: any) {
          onToast(`Failed to load ConfigMap "${item.refName}": ${err.message}`, 'error');
        } finally {
          setLoadingKeys((prev) => ({ ...prev, [item.id]: false }));
        }
      } else {
        setRevealedKeys((prev) => ({ ...prev, [item.id]: true }));
      }
    } else {
      setRevealedKeys((prev) => ({ ...prev, [item.id]: true }));
    }
  };

  // Toggle reveal all / mask all for all environment variables in current view
  const handleToggleRevealAll = async () => {
    const currentEnvs = editableEnvs.length > 0 ? editableEnvs : getContainerAllEnvs(selectedEnvContainer);

    if (showAllValues) {
      // MASK ALL
      setShowAllValues(false);
      setShowSensitiveValues({});
      const next: Record<string, boolean> = {};
      currentEnvs.forEach((e) => {
        next[e.id] = false;
      });
      setRevealedKeys(next);
    } else {
      // REVEAL ALL
      setIsTogglingAll(true);
      try {
        const newSecretCache = { ...secretCache };
        const newConfigMapCache = { ...configMapCache };

        // Identify missing secrets in the current container
        const missingSecrets = Array.from(
          new Set(
            currentEnvs
              .filter((e) => e.refType === 'secret' && e.refName && !newSecretCache[e.refName])
              .map((e) => e.refName!)
          )
        );

        if (missingSecrets.length > 0) {
          await Promise.all(
            missingSecrets.map(async (sName) => {
              try {
                const data = await fetchResourceDetail('secret', sName, podNamespace, context);
                if (data) newSecretCache[sName] = data;
              } catch (err) {
                console.warn(`Failed to fetch secret ${sName}:`, err);
              }
            })
          );
          setSecretCache(newSecretCache);
        }

        // Identify missing configmaps in the current container
        const missingCms = Array.from(
          new Set(
            currentEnvs
              .filter((e) => e.refType === 'configmap' && e.refName && !newConfigMapCache[e.refName])
              .map((e) => e.refName!)
          )
        );

        if (missingCms.length > 0) {
          await Promise.all(
            missingCms.map(async (cmName) => {
              try {
                const data = await fetchResourceDetail('configmap', cmName, podNamespace, context);
                if (data) newConfigMapCache[cmName] = data;
              } catch (err) {
                console.warn(`Failed to fetch configmap ${cmName}:`, err);
              }
            })
          );
          setConfigMapCache(newConfigMapCache);
        }

        setShowAllValues(true);
        const sensitiveMap: Record<string, boolean> = {};
        const nextRevealed: Record<string, boolean> = {};
        currentEnvs.forEach((e) => {
          sensitiveMap[e.id] = true;
          nextRevealed[e.id] = true;
        });
        setShowSensitiveValues(sensitiveMap);
        setRevealedKeys(nextRevealed);
      } finally {
        setIsTogglingAll(false);
      }
    }
  };

  // Detect exposed container ports
  const exposedPorts: Array<{ port: number; name?: string; protocol?: string; container: string }> = [];
  pod.spec.containers.forEach((c) => {
    if (c.ports) {
      c.ports.forEach((p) => {
        exposedPorts.push({
          port: p.containerPort,
          name: p.name,
          protocol: p.protocol || 'TCP',
          container: c.name,
        });
      });
    }
  });

  // Keep selectedEnvContainer valid if containers change
  useEffect(() => {
    if (!containerNames.includes(selectedEnvContainer)) {
      setSelectedEnvContainer(containerNames[0] || '');
    }
  }, [containerNames, selectedEnvContainer]);

  // Reset visibility state when switching containers
  useEffect(() => {
    setShowAllValues(false);
    setRevealedKeys({});
    setShowSensitiveValues({});
  }, [selectedEnvContainer]);

  // Load all envFrom secrets and configmaps for the pod
  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;
    const loadAllEnvFromSources = async () => {
      setIsLoadingEnvFrom(true);
      const newEnvFromMap: Record<string, EditableEnvItem[]> = {};
      const newSecretCache = { ...secretCache };
      const newConfigMapCache = { ...configMapCache };

      for (const container of pod.spec.containers) {
        const envFromList = container.envFrom || [];
        const containerItems: EditableEnvItem[] = [];

        for (const ef of envFromList) {
          if (ef.secretRef?.name) {
            const sName = ef.secretRef.name;
            try {
              let secretData = newSecretCache[sName];
              if (!secretData) {
                secretData = await fetchResourceDetail('secret', sName, podNamespace, context);
                newSecretCache[sName] = secretData;
              }
              const dataMap = { ...(secretData?.data || {}), ...(secretData?.stringData || {}) };
              if (dataMap && Object.keys(dataMap).length > 0) {
                Object.keys(dataMap).forEach((rawKey) => {
                  const varName = ef.prefix ? `${ef.prefix}${rawKey}` : rawKey;
                  containerItems.push({
                    id: `envfrom-sec-${container.name}-${sName}-${rawKey}`,
                    name: varName,
                    value: '',
                    isRef: true,
                    refType: 'secret',
                    refName: sName,
                    refKey: rawKey,
                    refDetails: `secret(${sName})[${rawKey}]`,
                    isFromEnvFrom: true,
                  });
                });
              }
            } catch (err) {
              console.warn(`Could not load secret ${sName} for container ${container.name}:`, err);
            }
          }

          if (ef.configMapRef?.name) {
            const cmName = ef.configMapRef.name;
            try {
              let cmData = newConfigMapCache[cmName];
              if (!cmData) {
                cmData = await fetchResourceDetail('configmap', cmName, podNamespace, context);
                newConfigMapCache[cmName] = cmData;
              }
              const cmMap = { ...(cmData?.data || {}), ...(cmData?.binaryData || {}) };
              if (cmMap && Object.keys(cmMap).length > 0) {
                Object.keys(cmMap).forEach((rawKey) => {
                  const varName = ef.prefix ? `${ef.prefix}${rawKey}` : rawKey;
                  const val = cmData.data?.[rawKey] || '';
                  containerItems.push({
                    id: `envfrom-cm-${container.name}-${cmName}-${rawKey}`,
                    name: varName,
                    value: val,
                    isRef: true,
                    refType: 'configmap',
                    refName: cmName,
                    refKey: rawKey,
                    refDetails: `configMap(${cmName})[${rawKey}]`,
                    isFromEnvFrom: true,
                  });
                });
              }
            } catch (err) {
              console.warn(`Could not load configmap ${cmName} for container ${container.name}:`, err);
            }
          }
        }

        newEnvFromMap[container.name] = containerItems;
      }

      if (isMounted) {
        setSecretCache(newSecretCache);
        setConfigMapCache(newConfigMapCache);
        setEnvFromVars(newEnvFromMap);
        setIsLoadingEnvFrom(false);
      }
    };

    loadAllEnvFromSources();

    return () => {
      isMounted = false;
    };
  }, [isOpen, pod, podNamespace, context]);

  // Helper to compile all env vars for a container (direct env + envFrom)
  const getContainerAllEnvs = (containerName: string): EditableEnvItem[] => {
    const targetC = pod.spec.containers.find((c) => c.name === containerName);
    if (!targetC) return [];

    const directList: EditableEnvItem[] = (targetC.env || []).map((e, idx) => {
      let isRef = !!e.valueFrom;
      let refType: EditableEnvItem['refType'] = 'literal';
      let refName = '';
      let refKey = '';
      let refDetails = '';

      if (e.valueFrom?.secretKeyRef) {
        refType = 'secret';
        refName = e.valueFrom.secretKeyRef.name;
        refKey = e.valueFrom.secretKeyRef.key;
        refDetails = `secret(${refName})[${refKey}]`;
      } else if (e.valueFrom?.configMapKeyRef) {
        refType = 'configmap';
        refName = e.valueFrom.configMapKeyRef.name;
        refKey = e.valueFrom.configMapKeyRef.key;
        refDetails = `configMap(${refName})[${refKey}]`;
      } else if (e.valueFrom?.fieldRef) {
        refType = 'field';
        refDetails = `fieldRef(${e.valueFrom.fieldRef.fieldPath})`;
      } else if (e.valueFrom?.resourceFieldRef) {
        refType = 'resource';
        refDetails = `resourceFieldRef(${e.valueFrom.resourceFieldRef.resource})`;
      } else if (isRef) {
        refDetails = 'Reference';
      }

      return {
        id: `${targetC.name}-${e.name}-${idx}`,
        name: e.name,
        value: e.value !== undefined ? e.value : '',
        isRef,
        refType,
        refName,
        refKey,
        refDetails,
        originalValue: e.value !== undefined ? e.value : '',
      };
    });

    const directNames = new Set(directList.map((d) => d.name));
    const fromEf = (envFromVars[containerName] || []).filter(
      (item) => !directNames.has(item.name)
    );

    return [...directList, ...fromEf];
  };

  // Sync editableEnvs whenever selectedEnvContainer or pod or envFromVars changes
  useEffect(() => {
    setEditableEnvs(getContainerAllEnvs(selectedEnvContainer));
  }, [pod, selectedEnvContainer, envFromVars]);

  // Render an environment variable item in OpenLens format with eye reveal icon
  const renderLensEnvItem = (item: EditableEnvItem) => {
    const isRevealed = isItemRevealed(item.id);
    const isLoading = !!loadingKeys[item.id];

    if (item.refType === 'secret') {
      const secretVal = item.refName && item.refKey ? getSecretValue(item.refName, item.refKey) : null;

      return (
        <div className="flex flex-col gap-1 w-full">
          <div className="flex items-center gap-2 flex-wrap text-slate-300">
            <span>
              secret({item.refName})[{item.refKey}]
            </span>
            <button
              type="button"
              onClick={() => toggleRevealValue(item)}
              disabled={isLoading}
              className="p-1 rounded text-slate-400 hover:text-cyan-400 hover:bg-slate-800 transition-colors inline-flex items-center justify-center cursor-pointer"
              title={isRevealed ? 'Hide secret value' : 'Reveal secret value'}
            >
              {isLoading ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin text-cyan-400" />
              ) : isRevealed ? (
                <EyeOff className="w-3.5 h-3.5 text-cyan-400" />
              ) : (
                <Eye className="w-3.5 h-3.5 text-slate-400 hover:text-cyan-400" />
              )}
            </button>
            {item.isFromEnvFrom && (
              <span className="px-1.5 py-0.2 rounded text-[9px] font-sans font-medium bg-purple-950/80 text-purple-300 border border-purple-800/60">
                envFrom
              </span>
            )}
          </div>

          {isRevealed && (
            <div className="flex items-center gap-2 mt-0.5 animate-in fade-in slide-in-from-top-1 duration-150">
              <div className="px-2.5 py-1 rounded-lg bg-slate-900 border border-cyan-500/40 text-cyan-300 font-mono text-xs break-all max-w-xl shadow-inner select-text">
                {secretVal !== null ? (
                  secretVal === '' ? (
                    <span className="text-slate-500 italic">(empty string)</span>
                  ) : (
                    <span>{secretVal}</span>
                  )
                ) : (
                  <span className="text-amber-400 italic">(Key not found in secret data)</span>
                )}
              </div>
              {secretVal !== null && (
                <button
                  type="button"
                  onClick={() => copyToClipboard(secretVal, item.name)}
                  className="p-1 rounded text-slate-400 hover:text-cyan-300 hover:bg-slate-800 transition-colors cursor-pointer"
                  title="Copy Decoded Secret"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}
        </div>
      );
    }

    if (item.refType === 'configmap') {
      const cmVal = item.refName && item.refKey ? getConfigMapValue(item.refName, item.refKey) : null;
      const displayVal = cmVal ?? item.value;

      return (
        <div className="flex flex-col gap-1 w-full">
          <div className="flex items-center gap-2 flex-wrap text-slate-300">
            <span>
              configMap({item.refName})[{item.refKey}]
            </span>
            <button
              type="button"
              onClick={() => toggleRevealValue(item)}
              disabled={isLoading}
              className="p-1 rounded text-slate-400 hover:text-indigo-400 hover:bg-slate-800 transition-colors inline-flex items-center justify-center cursor-pointer"
              title={isRevealed ? 'Hide configmap value' : 'Reveal configmap value'}
            >
              {isLoading ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin text-indigo-400" />
              ) : isRevealed ? (
                <EyeOff className="w-3.5 h-3.5 text-indigo-400" />
              ) : (
                <Eye className="w-3.5 h-3.5 text-slate-400 hover:text-indigo-400" />
              )}
            </button>
            {item.isFromEnvFrom && (
              <span className="px-1.5 py-0.2 rounded text-[9px] font-sans font-medium bg-purple-950/80 text-purple-300 border border-purple-800/60">
                envFrom
              </span>
            )}
          </div>

          {isRevealed && (
            <div className="flex items-center gap-2 mt-0.5 animate-in fade-in slide-in-from-top-1 duration-150">
              <div className="px-2.5 py-1 rounded-lg bg-slate-900 border border-indigo-500/40 text-indigo-200 font-mono text-xs break-all max-w-xl shadow-inner select-text">
                {displayVal !== null ? (
                  displayVal === '' ? (
                    <span className="text-slate-500 italic">(empty string)</span>
                  ) : (
                    <span>{displayVal}</span>
                  )
                ) : (
                  <span className="text-amber-400 italic">(Key not found in ConfigMap)</span>
                )}
              </div>
              {displayVal && (
                <button
                  type="button"
                  onClick={() => copyToClipboard(displayVal, item.name)}
                  className="p-1 rounded text-slate-400 hover:text-indigo-300 hover:bg-slate-800 transition-colors cursor-pointer"
                  title="Copy ConfigMap Value"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}
        </div>
      );
    }

    if (item.refType === 'field' || item.refType === 'resource') {
      return (
        <span className="text-slate-300 select-text">
          {item.refDetails}
        </span>
      );
    }

    // Literal value
    return (
      <div className="flex items-center gap-2 text-slate-200 select-text">
        <span className="break-all">{item.value !== '' ? item.value : '""'}</span>
        {item.value && (
          <button
            type="button"
            onClick={() => copyToClipboard(item.value, item.name)}
            className="p-0.5 rounded text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-colors cursor-pointer"
            title="Copy Value"
          >
            <Copy className="w-3 h-3" />
          </button>
        )}
      </div>
    );
  };

  // Load detailed pod data & port forwards when opened
  useEffect(() => {
    if (!isOpen) return;

    // Reset tab to initialTab or overview on open
    setActiveTab(initialTab || 'overview');
    setShowAllValues(false);
    setIsTogglingAll(false);
    setRevealedKeys({});
    setShowSensitiveValues({});
    setOverviewEnvFilter('');
    setForwardError(null);
    setPod(initialPod);

    // Default container port input if ports exist
    if (exposedPorts.length > 0) {
      setContainerPortInput(exposedPorts[0].port.toString());
      setLocalPortInput(exposedPorts[0].port.toString());
    } else {
      setContainerPortInput('8080');
      setLocalPortInput('8080');
    }

    loadFreshPodData();
    loadPortForwards();
    loadEvents();
  }, [isOpen, initialPod.metadata.name, initialPod.metadata.namespace, initialTab]);

  // Handle ESC key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const loadFreshPodData = async () => {
    setIsLoadingDetail(true);
    try {
      const fresh = await fetchResourceDetail<PodItem>('pod', podName, podNamespace, context);
      if (fresh && fresh.metadata) {
        setPod(fresh);
      }
    } catch {
      // Keep using current pod object if detail fetch fails
    } finally {
      setIsLoadingDetail(false);
    }
  };

  const loadEvents = async () => {
    setIsLoadingEvents(true);
    try {
      const data = await fetchPodEvents(podName, podNamespace, context);
      setEvents(data.items || []);
    } catch {
      setEvents([]);
    } finally {
      setIsLoadingEvents(false);
    }
  };

  const loadPortForwards = async () => {
    setIsLoadingForwards(true);
    try {
      const data = await fetchPortForwards();
      const relevant = (data.sessions || []).filter(
        (s: PortForwardSession) => s.pod === podName && s.namespace === podNamespace
      );
      setActiveForwards(relevant);
    } catch {
      setActiveForwards([]);
    } finally {
      setIsLoadingForwards(false);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(label);
    onToast(`Copied ${label} to clipboard`);
    setTimeout(() => setCopiedText(null), 2000);
  };

  const handleStartForward = async (cPortStr?: string, lPortStr?: string) => {
    const cp = parseInt(cPortStr || containerPortInput, 10);
    const lp = parseInt(lPortStr || localPortInput || containerPortInput, 10);

    if (isNaN(cp) || cp <= 0 || cp > 65535) {
      setForwardError('Please specify a valid container port (1-65535)');
      return;
    }

    setForwardError(null);
    setIsStartingForward(true);

    try {
      const res = await startPortForward(podName, podNamespace, cp, isNaN(lp) ? undefined : lp, context);
      if (res.success) {
        onToast(`⚡ Port forward active: http://localhost:${res.session.localPort}`);
        await loadPortForwards();
        setActiveTab('portforward');
      }
    } catch (err: any) {
      setForwardError(err.message || 'Failed to start port forward');
      onToast(err.message || 'Port forward failed', 'error');
    } finally {
      setIsStartingForward(false);
    }
  };

  const handleStopForward = async (sessionId: string) => {
    try {
      await stopPortForward(sessionId);
      onToast('Port forward stopped');
      await loadPortForwards();
    } catch (err: any) {
      onToast(err.message || 'Failed to stop port forward', 'error');
    }
  };

  const handleDeletePod = async () => {
    if (!window.confirm(`Are you sure you want to delete pod "${podName}" in namespace "${podNamespace}"?`)) {
      return;
    }
    try {
      await deleteResource('pod', podName, podNamespace, context);
      onToast(`Pod "${podName}" deleted successfully`);
      if (onRefreshList) onRefreshList();
      onClose();
    } catch (err: any) {
      onToast(err.message || 'Failed to delete pod', 'error');
    }
  };

  // Environment variables logic
  const totalEnvCount = useMemo(() => {
    let count = 0;
    for (const c of pod.spec.containers) {
      const directNames = new Set((c.env || []).map((e) => e.name));
      count += directNames.size;
      const fromEf = (envFromVars[c.name] || []).filter((ef) => !directNames.has(ef.name));
      count += fromEf.length;
    }
    return count;
  }, [pod.spec.containers, envFromVars]);

  const selectedContainer = pod.spec.containers.find((c) => c.name === selectedEnvContainer);
  const containerEnvFrom = selectedContainer?.envFrom || [];

  const pendingChanges = editableEnvs.filter(
    (e) => !e.isFromEnvFrom && (e.isNew || e.isDeleted || (e.originalValue !== undefined && e.value !== e.originalValue))
  );
  const pendingChangesCount = pendingChanges.length;

  const filteredEnvs = editableEnvs.filter((e) => {
    if (!envFilter.trim()) return true;
    const q = envFilter.toLowerCase();
    return (
      e.name.toLowerCase().includes(q) ||
      (e.value && e.value.toLowerCase().includes(q)) ||
      (e.refDetails && e.refDetails.toLowerCase().includes(q))
    );
  });

  const overviewEnvList = useMemo(() => {
    return getContainerAllEnvs(selectedEnvContainer);
  }, [selectedEnvContainer, pod, envFromVars]);

  const filteredOverviewEnvs = useMemo(() => {
    if (!overviewEnvFilter.trim()) return overviewEnvList;
    const q = overviewEnvFilter.toLowerCase();
    return overviewEnvList.filter(
      (e) => e.name.toLowerCase().includes(q) || (e.refDetails || e.value).toLowerCase().includes(q)
    );
  }, [overviewEnvList, overviewEnvFilter]);

  const handleSaveEnv = async () => {
    if (pendingChangesCount === 0) return;
    setIsSavingEnv(true);
    try {
      const payload = pendingChanges.map((e) => ({
        name: e.name,
        value: e.value,
        remove: !!e.isDeleted,
      }));
      const res = await setPodEnv(podName, podNamespace, payload, selectedEnvContainer, context);
      onToast(res.message || 'Environment updated successfully!', 'success');
      await loadFreshPodData();
      if (onRefreshList) onRefreshList();
    } catch (err: any) {
      onToast(err.message || 'Failed to save environment variables', 'error');
    } finally {
      setIsSavingEnv(false);
    }
  };

  const handleDiscardEnv = () => {
    setEditableEnvs(getContainerAllEnvs(selectedEnvContainer));
  };

  const handleAddEnv = (e: React.FormEvent) => {
    e.preventDefault();
    const key = newEnvKey.trim();
    if (!key) {
      onToast('Variable name cannot be empty', 'error');
      return;
    }
    if (editableEnvs.some((ev) => !ev.isDeleted && ev.name.toLowerCase() === key.toLowerCase())) {
      onToast(`Variable "${key}" already exists`, 'error');
      return;
    }
    setEditableEnvs((prev) => [
      ...prev,
      {
        id: `new-${Date.now()}`,
        name: key,
        value: newEnvValue,
        isRef: false,
        refType: 'literal',
        isNew: true,
        originalValue: undefined,
      },
    ]);
    setNewEnvKey('');
    setNewEnvValue('');
  };

  const handleDeleteEnv = (id: string) => {
    setEditableEnvs((prev) =>
      prev.map((e) => (e.id === id ? { ...e, isDeleted: true } : e)).filter((e) => !(e.isNew && e.isDeleted))
    );
  };

  const handleUndoDeleteEnv = (id: string) => {
    setEditableEnvs((prev) => prev.map((e) => (e.id === id ? { ...e, isDeleted: false } : e)));
  };

  const handleUpdateEnvValue = (id: string, val: string) => {
    setEditableEnvs((prev) =>
      prev.map((e) => (e.id === id ? { ...e, value: val } : e))
    );
  };

  const owners = pod.metadata.ownerReferences || [];
  const isControllerManaged = owners.length > 0;
  const controllerDesc = isControllerManaged 
    ? `${owners[0].kind} "${owners[0].name}"` 
    : 'Standalone Pod';

  if (!isOpen) return null;

  const phase = pod.status.phase || 'Unknown';
  const readyContainers = pod.status.containerStatuses?.filter((c) => c.ready).length ?? 0;
  const totalContainers = pod.spec.containers.length;
  const totalRestarts = pod.status.containerStatuses?.reduce((acc, c) => acc + c.restartCount, 0) ?? 0;

  const modalBody = (
    <div className={`flex flex-col bg-slate-900 overflow-hidden ${
      isInline 
        ? 'w-full h-full' 
        : 'relative w-full max-w-5xl max-h-[92vh] rounded-2xl border border-slate-700/80 shadow-2xl shadow-cyan-950/30 z-10 animate-in zoom-in-95 duration-150'
    }`}>
      {/* Top Loading Progress Bar */}
      {isLoadingDetail && (
        <div className="h-0.5 w-full bg-cyan-950 overflow-hidden shrink-0">
          <div className="h-full bg-gradient-to-r from-cyan-500 via-indigo-400 to-cyan-400 animate-[pulse_1s_infinite] w-full" />
        </div>
      )}

      {/* Top Header Bar */}
      <div className="px-4 sm:px-6 py-3 bg-slate-950/90 border-b border-slate-800 flex items-center justify-between gap-3 select-none flex-wrap">
        <div className="flex items-center gap-2.5 min-w-0">
          {isInline && (
            <button
              type="button"
              onClick={onClose}
              className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5 border border-slate-700/80 transition-colors cursor-pointer shrink-0"
              title="Back to Pod List"
            >
              <ArrowLeft className="w-3.5 h-3.5 text-cyan-400" />
              <span>Back</span>
            </button>
          )}

          <div className="p-2 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 shrink-0">
            <Box className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm sm:text-base font-bold text-slate-100 truncate font-mono" title={podName}>
                {podName}
              </h2>
              <button
                onClick={() => copyToClipboard(podName, 'Pod Name')}
                className="text-slate-400 hover:text-cyan-400 p-1 rounded hover:bg-slate-800 transition-colors"
                title="Copy Pod Name"
              >
                {copiedText === 'Pod Name' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-400 mt-0.5 flex-wrap">
              {context && (
                <>
                  <span className="bg-indigo-950 text-indigo-300 px-2 py-0.5 rounded font-mono text-[10px] sm:text-[11px] border border-indigo-800/80">
                    ctx: {context}
                  </span>
                  <span className="text-slate-600">•</span>
                </>
              )}
              <span>Namespace:</span>
              <span className="bg-slate-800 text-cyan-300 px-2 py-0.5 rounded font-mono text-[10px] sm:text-[11px] border border-slate-700/60">
                {podNamespace}
              </span>
              <span className="text-slate-600">•</span>
              <span>Node:</span>
              <span className="text-slate-300 font-mono text-[10px] sm:text-[11px] truncate max-w-[140px]" title={pod.spec.nodeName}>
                {pod.spec.nodeName || 'Unassigned'}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          {/* Status Badge */}
          <div className={`px-2.5 py-1 rounded-full border text-xs font-semibold flex items-center gap-1.5 ${
            phase === 'Running' 
              ? 'bg-emerald-950/80 text-emerald-300 border-emerald-800/80'
              : phase === 'Pending'
              ? 'bg-amber-950/80 text-amber-300 border-amber-800/80'
              : 'bg-rose-950/80 text-rose-300 border-rose-800/80'
          }`}>
            <span className={`w-2 h-2 rounded-full ${
              phase === 'Running' ? 'bg-emerald-400 animate-pulse' : phase === 'Pending' ? 'bg-amber-400' : 'bg-rose-400'
            }`} />
            <span>{phase}</span>
          </div>

          {/* Maximize Fullscreen Button (if inline) */}
          {isInline && onExpandFullscreen && (
            <button
              type="button"
              onClick={() => onExpandFullscreen(pod, context, activeTab)}
              className="p-1.5 rounded-lg text-slate-400 hover:text-cyan-300 hover:bg-slate-800 transition-colors cursor-pointer"
              title="Open in Fullscreen Modal"
            >
              <Maximize2 className="w-4 h-4" />
            </button>
          )}

          {/* Close Button */}
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors cursor-pointer"
            title={isInline ? "Back to Pods" : "Close (Esc)"}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

        {/* Quick Action Toolbar */}
        <div className="px-6 py-2.5 bg-slate-900/90 border-b border-slate-800 flex items-center justify-between text-xs text-slate-300 select-none">
          <div className="flex items-center gap-2">
            {/* Environment Variables Button */}
            <button
              onClick={() => setActiveTab('env')}
              className={`px-3 py-1.5 rounded-lg font-medium flex items-center gap-1.5 transition-all ${
                activeTab === 'env' 
                  ? 'bg-cyan-500 text-slate-950 shadow-md shadow-cyan-500/20 font-bold' 
                  : 'bg-emerald-950/40 hover:bg-emerald-900/60 text-emerald-300 border border-emerald-800/60'
              }`}
            >
              <Sliders className="w-3.5 h-3.5" />
              <span>Environment Variables</span>
              {pendingChangesCount > 0 && (
                <span className="bg-amber-400 text-slate-950 px-1.5 py-0.2 rounded-full font-bold text-[10px] ml-1 animate-pulse">
                  {pendingChangesCount}
                </span>
              )}
            </button>

            {/* Port Forward Button */}
            <button
              onClick={() => setActiveTab('portforward')}
              className={`px-3 py-1.5 rounded-lg font-medium flex items-center gap-1.5 transition-all ${
                activeTab === 'portforward' 
                  ? 'bg-cyan-500 text-slate-950 shadow-md shadow-cyan-500/20 font-bold' 
                  : 'bg-cyan-950/50 hover:bg-cyan-900/60 text-cyan-300 border border-cyan-800/60'
              }`}
            >
              <Radio className="w-3.5 h-3.5" />
              <span>Port Forward</span>
              {activeForwards.length > 0 && (
                <span className="bg-cyan-400 text-slate-950 px-1.5 py-0.2 rounded-full font-bold text-[10px] ml-1 animate-pulse">
                  {activeForwards.length}
                </span>
              )}
            </button>

            {/* Stream Logs */}
            <button
              onClick={() => {
                onOpenLogs(podName, podNamespace, containerNames);
                onClose();
              }}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700/80 text-slate-200 border border-slate-700/80 flex items-center gap-1.5 transition-colors"
            >
              <Terminal className="w-3.5 h-3.5 text-cyan-400" />
              <span>Stream Logs</span>
            </button>

            {/* View Manifest */}
            <button
              onClick={() => {
                onOpenManifest('pod', podName, podNamespace);
                onClose();
              }}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700/80 text-slate-200 border border-slate-700/80 flex items-center gap-1.5 transition-colors"
            >
              <FileCode className="w-3.5 h-3.5 text-amber-400" />
              <span>Manifest</span>
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={loadFreshPodData}
              disabled={isLoadingDetail}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
              title="Refresh Pod Info"
            >
              <RefreshCw className={`w-4 h-4 ${isLoadingDetail ? 'animate-spin text-cyan-400' : ''}`} />
            </button>

            <button
              onClick={handleDeletePod}
              className="px-3 py-1.5 rounded-lg bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 border border-rose-800/60 flex items-center gap-1.5 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Delete</span>
            </button>
          </div>
        </div>

        {/* Modal Navigation Tabs */}
        <div className="px-6 border-b border-slate-800 bg-slate-950/40 flex items-center gap-6 text-xs font-medium text-slate-400 select-none">
          <button
            onClick={() => setActiveTab('overview')}
            className={`py-3 border-b-2 transition-colors flex items-center gap-1.5 ${
              activeTab === 'overview' ? 'border-cyan-400 text-cyan-300 font-semibold' : 'border-transparent hover:text-slate-200'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>Overview</span>
          </button>

          <button
            onClick={() => setActiveTab('env')}
            className={`py-3 border-b-2 transition-colors flex items-center gap-1.5 ${
              activeTab === 'env' ? 'border-cyan-400 text-cyan-300 font-semibold' : 'border-transparent hover:text-slate-200'
            }`}
          >
            <Sliders className="w-3.5 h-3.5 text-cyan-400" />
            <span>Env Variables ({totalEnvCount})</span>
            {pendingChangesCount > 0 && (
              <span className="bg-amber-400/20 text-amber-300 border border-amber-500/40 px-1.5 py-0.2 rounded-full font-mono text-[10px]">
                {pendingChangesCount} unsaved
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('containers')}
            className={`py-3 border-b-2 transition-colors flex items-center gap-1.5 ${
              activeTab === 'containers' ? 'border-cyan-400 text-cyan-300 font-semibold' : 'border-transparent hover:text-slate-200'
            }`}
          >
            <Cpu className="w-3.5 h-3.5" />
            <span>Containers ({pod.spec.containers.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('portforward')}
            className={`py-3 border-b-2 transition-colors flex items-center gap-1.5 ${
              activeTab === 'portforward' ? 'border-cyan-400 text-cyan-300 font-semibold' : 'border-transparent hover:text-slate-200'
            }`}
          >
            <Radio className="w-3.5 h-3.5 text-cyan-400" />
            <span>Port Forwarding</span>
            {activeForwards.length > 0 && (
              <span className="bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 px-1.5 py-0.2 rounded-full font-mono text-[10px]">
                {activeForwards.length}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('events')}
            className={`py-3 border-b-2 transition-colors flex items-center gap-1.5 ${
              activeTab === 'events' ? 'border-cyan-400 text-cyan-300 font-semibold' : 'border-transparent hover:text-slate-200'
            }`}
          >
            <Clock className="w-3.5 h-3.5" />
            <span>Events ({events.length})</span>
          </button>
        </div>

        {/* Tab Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">

          {/* ================= TAB 1: OVERVIEW ================= */}
          {activeTab === 'overview' && (
            <div className="space-y-6">
              {/* Summary Stats Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800">
                  <div className="text-[11px] text-slate-400 font-medium">Pod IP</div>
                  <div className="text-sm font-bold text-slate-100 font-mono mt-1 flex items-center justify-between">
                    <span>{pod.status.podIP || 'Pending'}</span>
                    {pod.status.podIP && (
                      <button onClick={() => copyToClipboard(pod.status.podIP!, 'Pod IP')} className="text-slate-500 hover:text-slate-300">
                        <Copy className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800">
                  <div className="text-[11px] text-slate-400 font-medium">Ready Containers</div>
                  <div className="text-sm font-bold text-slate-100 font-mono mt-1">
                    <span className={readyContainers === totalContainers ? 'text-emerald-400' : 'text-amber-400'}>
                      {readyContainers}
                    </span>
                    <span className="text-slate-500"> / {totalContainers}</span>
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800">
                  <div className="text-[11px] text-slate-400 font-medium">Restarts</div>
                  <div className={`text-sm font-bold font-mono mt-1 ${totalRestarts > 0 ? 'text-amber-400' : 'text-slate-200'}`}>
                    {totalRestarts}
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800">
                  <div className="text-[11px] text-slate-400 font-medium">QoS Class</div>
                  <div className="text-sm font-bold text-cyan-300 font-mono mt-1">
                    {pod.status.qosClass || 'Burstable'}
                  </div>
                </div>
              </div>

              {/* Container Images & Tags Card (Prominently displayed when pod is clicked) */}
              <div className="rounded-xl bg-slate-950/60 border border-slate-800/90 p-4 space-y-3 shadow-inner">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Tag className="w-4 h-4 text-cyan-400" />
                    <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                      Container Images &amp; Tags ({pod.spec.containers.length})
                    </h3>
                  </div>
                  <span className="text-[11px] text-slate-400 font-sans">
                    Click copy icon to copy tag
                  </span>
                </div>

                <div className="space-y-2.5">
                  {pod.spec.containers.map((c, idx) => {
                    const { repo, tag } = parseImageTag(c.image);
                    const status = pod.status.containerStatuses?.find((cs) => cs.name === c.name);
                    const isReady = status?.ready ?? false;

                    return (
                      <div 
                        key={c.name}
                        className="p-3.5 rounded-xl bg-slate-900/95 border border-slate-800/90 hover:border-cyan-500/50 transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-sm"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <span className={`w-3 h-3 rounded-full shrink-0 ${isReady ? 'bg-emerald-400 shadow-sm shadow-emerald-400/50' : 'bg-rose-400'}`} />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2.5 flex-wrap">
                              <span className="font-bold text-slate-100 font-mono text-sm">{c.name}</span>
                              <span className="text-slate-500 text-xs">#{idx + 1}</span>
                              {/* Image Tag Highlighted Badge */}
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-cyan-950/90 text-cyan-300 border border-cyan-600/70 font-mono text-xs font-bold shadow-sm shadow-cyan-950/60">
                                <Tag className="w-3 h-3 text-cyan-400" />
                                <span>tag:</span>
                                <span className="text-white font-black underline decoration-cyan-400 decoration-2">{tag}</span>
                              </span>
                              <button
                                type="button"
                                onClick={() => copyToClipboard(tag, `Tag (${c.name})`)}
                                className="p-1 rounded text-slate-400 hover:text-cyan-300 hover:bg-slate-800 transition-colors cursor-pointer"
                                title={`Copy Image Tag "${tag}"`}
                              >
                                {copiedText === `Tag (${c.name})` ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                              </button>
                            </div>
                            <div className="text-xs font-mono text-slate-400 truncate mt-1 max-w-xl" title={c.image}>
                              <span className="text-slate-500">Full Image: </span>
                              <span className="text-slate-300">{repo}</span>
                              <span className="text-cyan-400 font-bold">:{tag}</span>
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                          <button
                            type="button"
                            onClick={() => copyToClipboard(c.image, `Full Image (${c.name})`)}
                            className="px-3 py-1.5 rounded-lg bg-slate-800/90 hover:bg-slate-700 text-slate-300 hover:text-cyan-300 text-xs font-mono flex items-center gap-1.5 transition-colors border border-slate-700/80 cursor-pointer"
                            title="Copy Full Image string"
                          >
                            {copiedText === `Full Image (${c.name})` ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                            <span>Copy Image URI</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Node & Metadata Info */}
              <div className="rounded-xl bg-slate-950/40 border border-slate-800 p-4 space-y-3">
                <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Metadata & Placement</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-y-2 gap-x-6 text-xs font-mono">
                  <div className="flex justify-between py-1 border-b border-slate-800/60">
                    <span className="text-slate-400 font-sans">Created At:</span>
                    <span className="text-slate-200">{pod.metadata.creationTimestamp || 'N/A'}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-800/60">
                    <span className="text-slate-400 font-sans">Start Time:</span>
                    <span className="text-slate-200">{pod.status.startTime || 'N/A'}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-800/60">
                    <span className="text-slate-400 font-sans">Node Name:</span>
                    <span className="text-slate-200 truncate max-w-[220px]" title={pod.spec.nodeName}>
                      {pod.spec.nodeName || 'N/A'}
                    </span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-800/60">
                    <span className="text-slate-400 font-sans">Host IP:</span>
                    <span className="text-slate-200">{pod.status.hostIP || 'N/A'}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-800/60">
                    <span className="text-slate-400 font-sans">Service Account:</span>
                    <span className="text-slate-200">{pod.spec.serviceAccountName || 'default'}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-800/60">
                    <span className="text-slate-400 font-sans">Restart Policy:</span>
                    <span className="text-slate-200">{pod.spec.restartPolicy || 'Always'}</span>
                  </div>
                </div>
              </div>

              {/* Status Conditions */}
              {pod.status.conditions && pod.status.conditions.length > 0 && (
                <div className="rounded-xl bg-slate-950/40 border border-slate-800 p-4 space-y-3">
                  <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Pod Conditions</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {pod.status.conditions.map((cond) => {
                      const isTrue = cond.status === 'True';
                      return (
                        <div key={cond.type} className="flex items-center justify-between p-2.5 rounded-lg bg-slate-900/60 border border-slate-800/80 text-xs">
                          <div className="flex items-center gap-2">
                            {isTrue ? (
                              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                            ) : (
                              <AlertCircle className="w-4 h-4 text-amber-400" />
                            )}
                            <span className="font-medium text-slate-200">{cond.type}</span>
                          </div>
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold font-mono ${
                            isTrue ? 'bg-emerald-950 text-emerald-300 border border-emerald-800' : 'bg-amber-950 text-amber-300 border border-amber-800'
                          }`}>
                            {cond.status}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Environment Section (OpenLens Style) */}
              <div className="rounded-xl bg-slate-950/40 border border-slate-800 p-4 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800/80 pb-2.5">
                  <div className="flex items-center gap-2">
                    <Sliders className="w-4 h-4 text-cyan-400" />
                    <h3 className="text-xs font-semibold text-slate-200 uppercase tracking-wider">
                      Environment
                    </h3>
                    <span className="bg-slate-800 text-slate-400 px-2 py-0.5 rounded-full text-[10px] font-mono">
                      {overviewEnvList.length}
                    </span>
                    {isLoadingEnvFrom && (
                      <RefreshCw className="w-3 h-3 animate-spin text-cyan-400 ml-1" />
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    {/* Container switcher if multiple containers */}
                    {pod.spec.containers.length > 1 && (
                      <div className="flex items-center gap-1 bg-slate-900 p-0.5 rounded-lg border border-slate-800 text-[11px]">
                        {pod.spec.containers.map((c) => (
                          <button
                            key={c.name}
                            type="button"
                            onClick={() => setSelectedEnvContainer(c.name)}
                            className={`px-2 py-0.5 rounded transition-colors font-mono cursor-pointer ${
                              selectedEnvContainer === c.name
                                ? 'bg-cyan-500/20 text-cyan-300 font-bold border border-cyan-500/40'
                                : 'text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            {c.name}
                          </button>
                        ))}
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={handleToggleRevealAll}
                      disabled={isTogglingAll}
                      className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs flex items-center gap-1 border border-slate-700/60 transition-colors cursor-pointer disabled:opacity-50"
                      title={showAllValues ? 'Mask all values' : 'Reveal all values'}
                    >
                      {isTogglingAll ? (
                        <RefreshCw className="w-3 h-3 animate-spin text-cyan-400" />
                      ) : showAllValues ? (
                        <EyeOff className="w-3 h-3 text-amber-400" />
                      ) : (
                        <Eye className="w-3 h-3 text-cyan-400" />
                      )}
                      <span>{isTogglingAll ? 'Loading...' : showAllValues ? 'Mask Values' : 'Reveal All'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setActiveTab('env')}
                      className="text-xs text-cyan-400 hover:text-cyan-300 flex items-center gap-1 font-medium transition-colors cursor-pointer"
                    >
                      <span>Manage & Edit</span>
                      <ChevronRight className="w-3 h-3" />
                    </button>
                  </div>
                </div>

                {/* Filter within overview environment if variables exist */}
                {overviewEnvList.length > 5 && (
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
                    <input
                      type="text"
                      placeholder={`Filter variables in ${selectedEnvContainer}...`}
                      value={overviewEnvFilter}
                      onChange={(e) => setOverviewEnvFilter(e.target.value)}
                      className="w-full pl-8 pr-3 py-1 bg-slate-900/80 border border-slate-800 rounded-lg text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-cyan-500 font-mono"
                    />
                  </div>
                )}

                {/* OpenLens Style 2-Column Row Layout */}
                <div className="grid grid-cols-1 md:grid-cols-[140px_1fr] gap-4 text-xs font-mono pt-1">
                  <div className="text-slate-400 font-sans font-medium text-xs">
                    Environment
                  </div>
                  <div className="space-y-2 divide-y divide-slate-800/40 min-w-0">
                    {filteredOverviewEnvs.length === 0 ? (
                      <div className="text-slate-500 italic py-2">
                        {isLoadingEnvFrom ? 'Loading environment variables...' : 'No environment variables found.'}
                      </div>
                    ) : (
                      filteredOverviewEnvs.map((item) => (
                        <div key={item.id} className="pt-2 first:pt-0 flex items-start gap-2">
                          <span className="font-semibold text-slate-200 shrink-0 select-text">
                            {item.name}
                          </span>
                          <span className="text-slate-500">:</span>
                          <div className="flex-1 min-w-0 select-text">
                            {renderLensEnvItem(item)}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>

              {/* Labels & Annotations */}
              <div className="rounded-xl bg-slate-950/40 border border-slate-800 p-4 space-y-3">
                <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                  <Tag className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Labels</span>
                </h3>
                {pod.metadata.labels && Object.keys(pod.metadata.labels).length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(pod.metadata.labels).map(([k, v]) => (
                      <span key={k} className="bg-slate-900 border border-slate-700/70 text-slate-300 px-2 py-1 rounded text-xs font-mono">
                        <span className="text-cyan-400">{k}</span>
                        <span className="text-slate-500">=</span>
                        <span className="text-slate-200">{v}</span>
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-slate-500 italic">No labels configured.</div>
                )}
              </div>
            </div>
          )}

          {/* ================= TAB 2: ENVIRONMENT VARIABLES ================= */}
          {activeTab === 'env' && (
            <div className="space-y-5">
              
              {/* Container Selection Tabs (if multiple containers) */}
              {pod.spec.containers.length > 1 && (
                <div className="flex items-center gap-2 p-1 bg-slate-950/80 rounded-xl border border-slate-800 w-fit">
                  <span className="text-[11px] text-slate-400 font-semibold px-2">Container:</span>
                  {pod.spec.containers.map((c) => (
                    <button
                      key={c.name}
                      onClick={() => setSelectedEnvContainer(c.name)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-mono font-medium transition-all ${
                        selectedEnvContainer === c.name
                          ? 'bg-cyan-500 text-slate-950 font-bold shadow-md shadow-cyan-500/20'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                      }`}
                    >
                      {c.name} ({c.env?.length || 0})
                    </button>
                  ))}
                </div>
              )}

              {/* Workload Controller Info Alert */}
              <div className="flex items-start gap-3 p-3.5 rounded-xl bg-slate-950/60 border border-slate-800 text-xs">
                <Info className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 font-semibold text-slate-200">
                    <span>Workload Management:</span>
                    <span className="font-mono text-cyan-300 bg-cyan-950/80 px-2 py-0.5 rounded border border-cyan-800/60 text-[11px]">
                      {controllerDesc}
                    </span>
                    {context && (
                      <span className="font-mono text-indigo-300 bg-indigo-950/80 px-2 py-0.5 rounded border border-indigo-800/60 text-[11px]">
                        cluster: {context}
                      </span>
                    )}
                  </div>
                  <p className="text-slate-400 mt-1 text-[11px] leading-relaxed">
                    {isControllerManaged
                      ? 'This pod is managed by a controller. Saving changes applies environment variable updates to the parent deployment/statefulset, triggering a graceful rolling rollout.'
                      : 'This is a standalone pod. Saving changes will automatically update and replace the pod manifest in Kubernetes.'}
                  </p>
                </div>
              </div>

              {/* Injected Sources (envFrom) Card if present */}
              {containerEnvFrom && containerEnvFrom.length > 0 && (
                <div className="p-3.5 rounded-xl bg-slate-950/40 border border-slate-800/80 space-y-2">
                  <div className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                    <Key className="w-3.5 h-3.5 text-indigo-400" />
                    <span>Injected Environment Sources (envFrom)</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {containerEnvFrom.map((ef, idx) => (
                      <div key={idx} className="flex items-center justify-between p-2 rounded-lg bg-slate-900/60 border border-slate-800 text-xs font-mono">
                        <span className="text-slate-300">
                          {ef.configMapRef ? 'ConfigMap: ' : ef.secretRef ? 'Secret: ' : 'Ref: '}
                          <span className="text-indigo-300 font-bold">
                            {ef.configMapRef?.name || ef.secretRef?.name}
                          </span>
                        </span>
                        {ef.prefix && (
                          <span className="text-[10px] text-slate-500">prefix: {ef.prefix}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Add New Variable Form */}
              <form onSubmit={handleAddEnv} className="p-4 rounded-xl bg-slate-950/70 border border-slate-800 space-y-3">
                <div className="text-xs font-semibold text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
                  <Plus className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Add Environment Variable to "{selectedEnvContainer}"</span>
                </div>
                <div className="flex flex-col sm:flex-row items-center gap-3">
                  <div className="flex-1 w-full">
                    <input
                      type="text"
                      placeholder="NAME (e.g. DATABASE_URL, LOG_LEVEL)"
                      value={newEnvKey}
                      onChange={(e) => setNewEnvKey(e.target.value.toUpperCase())}
                      className="w-full bg-slate-900 border border-slate-700/80 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 font-mono focus:outline-none focus:border-cyan-500 transition-colors"
                    />
                  </div>
                  <div className="flex-1 w-full">
                    <input
                      type="text"
                      placeholder="VALUE (e.g. postgres://..., debug)"
                      value={newEnvValue}
                      onChange={(e) => setNewEnvValue(e.target.value)}
                      className="w-full bg-slate-900 border border-slate-700/80 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 font-mono focus:outline-none focus:border-cyan-500 transition-colors"
                    />
                  </div>
                  <button
                    type="submit"
                    className="w-full sm:w-auto px-4 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-semibold text-xs flex items-center justify-center gap-1.5 shadow-md shadow-cyan-600/20 transition-all cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Variable</span>
                  </button>
                </div>
              </form>

              {/* Controls Bar: Search & Visibility Toggle */}
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-slate-950/40 p-2.5 rounded-xl border border-slate-800">
                <div className="relative w-full sm:w-72">
                  <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    placeholder={`Filter variables in ${selectedEnvContainer}...`}
                    value={envFilter}
                    onChange={(e) => setEnvFilter(e.target.value)}
                    className="w-full pl-9 pr-3 py-1 bg-slate-900 border border-slate-700/70 rounded-lg text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-cyan-500"
                  />
                </div>

                <div className="flex items-center gap-2 self-end sm:self-auto text-xs">
                  <span className="text-slate-400 text-[11px]">
                    Showing <strong className="text-slate-200">{filteredEnvs.length}</strong> of {editableEnvs.length} variables
                  </span>
                  <button
                    type="button"
                    onClick={handleToggleRevealAll}
                    disabled={isTogglingAll}
                    className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs flex items-center gap-1.5 border border-slate-700/60 transition-colors cursor-pointer disabled:opacity-50"
                    title={showAllValues ? 'Mask all values' : 'Reveal all values'}
                  >
                    {isTogglingAll ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin text-cyan-400" />
                    ) : showAllValues ? (
                      <EyeOff className="w-3.5 h-3.5 text-amber-400" />
                    ) : (
                      <Eye className="w-3.5 h-3.5 text-cyan-400" />
                    )}
                    <span>{isTogglingAll ? 'Loading...' : showAllValues ? 'Mask Values' : 'Reveal All'}</span>
                  </button>
                </div>
              </div>

              {/* Environment Variables Table */}
              <div className="rounded-xl bg-slate-950/60 border border-slate-800 overflow-hidden shadow-sm">
                <table className="w-full text-left text-xs border-collapse font-mono">
                  <thead className="bg-slate-900/90 text-slate-400 border-b border-slate-800 select-none">
                    <tr>
                      <th className="py-2.5 px-4 font-semibold w-1/4">Variable Name</th>
                      <th className="py-2.5 px-3 font-semibold w-1/6">Type / Source</th>
                      <th className="py-2.5 px-3 font-semibold">Value</th>
                      <th className="py-2.5 px-4 text-right font-semibold w-28">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 text-slate-300">
                    {filteredEnvs.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="py-10 text-center text-slate-500 italic">
                          No environment variables found matching filter in container "{selectedEnvContainer}".
                        </td>
                      </tr>
                    ) : (
                      filteredEnvs.map((item) => {
                        const isModified = !item.isNew && !item.isDeleted && item.value !== item.originalValue;
                        const isRevealed = isItemRevealed(item.id);
                        const isMasked = !isRevealed;

                        return (
                          <tr
                            key={item.id}
                            className={`transition-colors ${
                              item.isDeleted
                                ? 'bg-rose-950/20 opacity-60'
                                : item.isNew
                                ? 'bg-emerald-950/20'
                                : isModified
                                ? 'bg-amber-950/20'
                                : 'hover:bg-slate-900/40'
                            }`}
                          >
                            {/* Variable Name */}
                            <td className="py-2.5 px-4 font-semibold text-slate-100 flex items-center gap-2">
                              <span
                                className={`truncate max-w-[200px] ${
                                  item.isDeleted ? 'line-through text-rose-400' : 'text-cyan-300'
                                }`}
                                title={item.name}
                              >
                                {item.name}
                              </span>
                              {item.isNew && (
                                <span className="bg-emerald-950 text-emerald-400 border border-emerald-800/80 px-1.5 py-0.2 rounded text-[9px] font-sans font-bold">
                                  NEW
                                </span>
                              )}
                              {isModified && (
                                <span className="bg-amber-950 text-amber-400 border border-amber-800/80 px-1.5 py-0.2 rounded text-[9px] font-sans font-bold">
                                  MODIFIED
                                </span>
                              )}
                              {item.isDeleted && (
                                <span className="bg-rose-950 text-rose-400 border border-rose-800/80 px-1.5 py-0.2 rounded text-[9px] font-sans font-bold">
                                  REMOVED
                                </span>
                              )}
                            </td>

                            {/* Type / Source */}
                            <td className="py-2.5 px-3">
                              {item.isFromEnvFrom ? (
                                <span
                                  className="bg-purple-950/80 text-purple-300 border border-purple-800/80 px-2 py-0.5 rounded text-[10px] truncate max-w-[150px] inline-block font-sans"
                                  title={`Injected via envFrom ${item.refType === 'secret' ? 'Secret' : 'ConfigMap'}: ${item.refName}`}
                                >
                                  envFrom ({item.refType})
                                </span>
                              ) : item.isRef ? (
                                <span
                                  className="bg-indigo-950/80 text-indigo-300 border border-indigo-800/80 px-2 py-0.5 rounded text-[10px] truncate max-w-[150px] inline-block font-sans"
                                  title={item.refDetails}
                                >
                                  {item.refType || 'ref'}
                                </span>
                              ) : (
                                <span className="bg-slate-800 text-slate-400 border border-slate-700/60 px-2 py-0.5 rounded text-[10px] font-sans">
                                  Literal Value
                                </span>
                              )}
                            </td>

                            {/* Value (Editable if literal; interactive reveal if secret/configmap) */}
                            <td className="py-2 px-3">
                              {item.isDeleted ? (
                                <span className="text-slate-500 italic line-through text-xs">
                                  {item.value || '(empty)'}
                                </span>
                              ) : item.isRef ? (
                                <div className="py-0.5">
                                  {renderLensEnvItem(item)}
                                </div>
                              ) : (
                                <div className="flex items-center gap-1.5 w-full">
                                  <input
                                    type={isMasked ? 'password' : 'text'}
                                    value={item.value}
                                    onChange={(e) => handleUpdateEnvValue(item.id, e.target.value)}
                                    placeholder="(empty)"
                                    className="w-full bg-slate-900 border border-slate-700/80 rounded px-2 py-1 text-xs text-slate-100 font-mono focus:outline-none focus:border-cyan-500 transition-colors"
                                  />
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setRevealedKeys((prev) => ({
                                        ...prev,
                                        [item.id]: !isRevealed,
                                      }))
                                    }
                                    className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 cursor-pointer"
                                    title={isMasked ? 'Reveal Value' : 'Mask Value'}
                                  >
                                    {isMasked ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => copyToClipboard(item.value, item.name)}
                                    className="p-1 rounded text-slate-400 hover:text-cyan-300 hover:bg-slate-800"
                                    title="Copy Value"
                                  >
                                    <Copy className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              )}
                            </td>

                            {/* Actions */}
                            <td className="py-2.5 px-4 text-right">
                              {item.isFromEnvFrom ? (
                                <span className="text-[10px] text-slate-500 font-sans italic" title="Injected via envFrom source; managed by secret/configmap">
                                  envFrom
                                </span>
                              ) : item.isDeleted ? (
                                <button
                                  onClick={() => handleUndoDeleteEnv(item.id)}
                                  className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 text-xs font-sans font-medium flex items-center gap-1 ml-auto transition-colors"
                                  title="Undo Deletion"
                                >
                                  <RotateCcw className="w-3 h-3" />
                                  <span>Undo</span>
                                </button>
                              ) : (
                                <button
                                  onClick={() => handleDeleteEnv(item.id)}
                                  className="p-1.5 text-slate-400 hover:text-rose-300 hover:bg-rose-950/40 rounded transition-colors ml-auto flex items-center gap-1"
                                  title="Delete Environment Variable"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* Floating / Sticky Save Toolbar when changes are pending */}
              {pendingChangesCount > 0 && (
                <div className="sticky bottom-0 z-20 p-4 rounded-xl bg-slate-900 border border-amber-500/50 shadow-2xl shadow-amber-950/40 flex items-center justify-between gap-4 animate-in slide-in-from-bottom-2">
                  <div className="flex items-center gap-2.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse" />
                    <div>
                      <span className="text-xs font-bold text-slate-100 font-sans">
                        {pendingChangesCount} Unsaved Environment {pendingChangesCount === 1 ? 'Change' : 'Changes'}
                      </span>
                      <p className="text-[11px] text-slate-400 font-sans">
                        Targeting {controllerDesc}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleDiscardEnv}
                      disabled={isSavingEnv}
                      className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-sans font-medium transition-colors"
                    >
                      Discard Changes
                    </button>

                    <button
                      onClick={handleSaveEnv}
                      disabled={isSavingEnv}
                      className="px-4 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-sans font-bold flex items-center gap-1.5 shadow-lg shadow-cyan-600/30 transition-all cursor-pointer disabled:opacity-50"
                    >
                      {isSavingEnv ? (
                        <>
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          <span>Saving to Kubernetes...</span>
                        </>
                      ) : (
                        <>
                          <Save className="w-3.5 h-3.5" />
                          <span>Save & Apply Changes</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}

            </div>
          )}

          {/* ================= TAB 3: CONTAINERS ================= */}
          {activeTab === 'containers' && (
            <div className="space-y-4">
              {pod.spec.containers.map((c, idx) => {
                const status = pod.status.containerStatuses?.find((cs) => cs.name === c.name);
                const isReady = status?.ready ?? false;
                const restarts = status?.restartCount ?? 0;

                return (
                  <div key={c.name} className="rounded-xl bg-slate-950/50 border border-slate-800 overflow-hidden">
                    {/* Container Card Header */}
                    <div className="px-4 py-3 bg-slate-900/80 border-b border-slate-800 flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <span className={`w-2.5 h-2.5 rounded-full ${isReady ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                        <span className="font-bold text-slate-100 font-mono text-sm">{c.name}</span>
                        <span className="text-slate-500 text-xs">#{idx + 1}</span>
                      </div>

                      <div className="flex items-center gap-2 text-xs">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                          isReady ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : 'bg-rose-950 text-rose-400 border border-rose-800'
                        }`}>
                          {isReady ? 'Ready' : 'Not Ready'}
                        </span>
                        <span className="bg-slate-800 text-slate-300 px-2 py-0.5 rounded text-[10px] font-mono">
                          Restarts: {restarts}
                        </span>
                      </div>
                    </div>

                    <div className="p-4 space-y-4 text-xs">
                      {/* Image */}
                      <div>
                        <div className="text-slate-400 font-medium mb-1">Image:</div>
                        <div className="p-2 rounded-lg bg-slate-900 border border-slate-800 font-mono text-cyan-300 break-all flex items-center justify-between">
                          <span>{c.image}</span>
                          <button onClick={() => copyToClipboard(c.image, 'Image Tag')} className="text-slate-400 hover:text-cyan-400 ml-2">
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      {/* Exposed Ports with 1-Click Port Forward */}
                      <div>
                        <div className="text-slate-400 font-medium mb-1.5 flex items-center justify-between">
                          <span>Exposed Ports ({c.ports?.length || 0}):</span>
                        </div>
                        {c.ports && c.ports.length > 0 ? (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {c.ports.map((p, pIdx) => (
                              <div 
                                key={pIdx} 
                                className="flex items-center justify-between p-2 rounded-lg bg-slate-900/90 border border-slate-800 text-xs font-mono"
                              >
                                <div className="flex items-center gap-2">
                                  <Radio className="w-3.5 h-3.5 text-cyan-400" />
                                  <span className="font-bold text-slate-100">{p.containerPort}</span>
                                  <span className="text-slate-400 text-[10px]">/{p.protocol || 'TCP'}</span>
                                  {p.name && <span className="text-cyan-400 text-[10px]">({p.name})</span>}
                                </div>
                                <button
                                  onClick={() => {
                                    setContainerPortInput(p.containerPort.toString());
                                    setLocalPortInput(p.containerPort.toString());
                                    setActiveTab('portforward');
                                  }}
                                  className="px-2 py-1 rounded bg-cyan-950 hover:bg-cyan-900/80 text-cyan-300 border border-cyan-800/80 text-[11px] font-sans font-medium flex items-center gap-1 transition-colors"
                                >
                                  <span>⚡ Forward</span>
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="text-slate-500 italic p-2 bg-slate-900/40 rounded border border-slate-800/50">
                            No explicit ports exposed. You can still forward any port from the Port Forwarding tab.
                          </div>
                        )}
                      </div>

                      {/* Environment Variables (OpenLens Style) */}
                      <div>
                        {(() => {
                          const cAllEnvs = getContainerAllEnvs(c.name);
                          return (
                            <>
                              <div className="text-slate-400 font-medium mb-1.5 flex items-center justify-between">
                                <div className="flex items-center gap-1.5">
                                  <span>Environment Variables ({cAllEnvs.length}):</span>
                                  {isLoadingEnvFrom && (
                                    <RefreshCw className="w-3 h-3 animate-spin text-cyan-400" />
                                  )}
                                </div>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSelectedEnvContainer(c.name);
                                    setActiveTab('env');
                                  }}
                                  className="text-cyan-400 hover:text-cyan-300 flex items-center gap-1 font-sans text-[11px] font-semibold cursor-pointer"
                                >
                                  <Sliders className="w-3 h-3" />
                                  <span>Edit in Env Tab →</span>
                                </button>
                              </div>
                              {cAllEnvs.length > 0 ? (
                                <div className="max-h-56 overflow-y-auto rounded-lg bg-slate-900 border border-slate-800 p-3 font-mono text-[11px] space-y-2 divide-y divide-slate-800/60">
                                  {cAllEnvs.map((ev) => (
                                    <div key={ev.id} className="pt-2 first:pt-0 flex items-start gap-2">
                                      <span className="text-cyan-300 font-semibold shrink-0 select-text">
                                        {ev.name}
                                      </span>
                                      <span className="text-slate-500">:</span>
                                      <div className="flex-1 min-w-0 select-text">
                                        {renderLensEnvItem(ev)}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <div className="text-slate-500 italic p-2 bg-slate-900/40 rounded border border-slate-800/50">
                                  {isLoadingEnvFrom ? 'Loading environment variables...' : 'No environment variables configured.'}
                                </div>
                              )}
                            </>
                          );
                        })()}
                      </div>

                      {/* Volume Mounts */}
                      {c.volumeMounts && c.volumeMounts.length > 0 && (
                        <div>
                          <div className="text-slate-400 font-medium mb-1.5 flex items-center gap-1.5">
                            <HardDrive className="w-3.5 h-3.5 text-slate-400" />
                            <span>Volume Mounts ({c.volumeMounts.length}):</span>
                          </div>
                          <div className="max-h-32 overflow-y-auto rounded-lg bg-slate-900 border border-slate-800 divide-y divide-slate-800/60 font-mono text-[11px]">
                            {c.volumeMounts.map((vm, vmIdx) => (
                              <div key={vmIdx} className="px-3 py-1.5 flex items-center justify-between">
                                <span className="text-slate-200">{vm.mountPath}</span>
                                <span className="text-slate-500 text-[10px]">({vm.name})</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ================= TAB 3: PORT FORWARDING ================= */}
          {activeTab === 'portforward' && (
            <div className="space-y-6">
              
              {/* Active Port Forwards List */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
                    <Radio className="w-4 h-4 text-cyan-400" />
                    <span>Active Port Forwards for this Pod</span>
                  </h3>
                  <button 
                    onClick={loadPortForwards}
                    disabled={isLoadingForwards}
                    className="text-xs text-cyan-400 hover:text-cyan-300 flex items-center gap-1"
                  >
                    <RefreshCw className={`w-3 h-3 ${isLoadingForwards ? 'animate-spin' : ''}`} />
                    <span>Refresh</span>
                  </button>
                </div>

                {activeForwards.length === 0 ? (
                  <div className="p-6 rounded-xl bg-slate-950/40 border border-slate-800 text-center text-slate-400 text-xs">
                    No active port forwarding sessions for this pod right now.
                    <div className="mt-1 text-slate-500">Configure ports below to expose this pod to your local machine!</div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {activeForwards.map((pf) => (
                      <div 
                        key={pf.id}
                        className="p-3.5 rounded-xl bg-slate-950/70 border border-cyan-500/40 shadow-lg shadow-cyan-950/20 flex items-center justify-between gap-4"
                      >
                        <div className="flex items-center gap-3">
                          <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
                          <div>
                            <div className="flex items-center gap-2">
                              <a
                                href={pf.url}
                                target="_blank"
                                rel="noreferrer"
                                className="text-sm font-bold text-cyan-300 hover:underline font-mono flex items-center gap-1"
                              >
                                {pf.url}
                                <ExternalLink className="w-3 h-3" />
                              </a>
                              <button
                                onClick={() => copyToClipboard(pf.url, 'Port Forward URL')}
                                className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800"
                                title="Copy URL"
                              >
                                <Copy className="w-3 h-3" />
                              </button>
                            </div>
                            <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                              Forwarding <span className="text-slate-200 font-semibold">{pf.localPort}</span> → Pod Container Port <span className="text-slate-200 font-semibold">{pf.containerPort}</span>
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <a
                            href={pf.url}
                            target="_blank"
                            rel="noreferrer"
                            className="px-3 py-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/50 text-xs font-semibold flex items-center gap-1.5 transition-colors"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                            <span>Open</span>
                          </a>

                          <button
                            onClick={() => handleStopForward(pf.id)}
                            className="px-3 py-1.5 rounded-lg bg-rose-950/50 hover:bg-rose-900/80 text-rose-300 border border-rose-800/80 text-xs font-semibold flex items-center gap-1.5 transition-colors"
                          >
                            <Square className="w-3 h-3 fill-rose-400" />
                            <span>Stop</span>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Start New Forward Form */}
              <div className="p-5 rounded-xl bg-slate-950/60 border border-slate-800 space-y-4">
                <h3 className="text-xs font-semibold text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
                  <Play className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Start New Port Forward</span>
                </h3>

                {/* Detected Port Shortcut Buttons */}
                {exposedPorts.length > 0 && (
                  <div>
                    <div className="text-[11px] text-slate-400 mb-1.5">Quick Select Detected Ports:</div>
                    <div className="flex flex-wrap gap-2">
                      {exposedPorts.map((p, pIdx) => (
                        <button
                          key={pIdx}
                          type="button"
                          onClick={() => {
                            setContainerPortInput(p.port.toString());
                            setLocalPortInput(p.port.toString());
                          }}
                          className={`px-2.5 py-1 rounded-lg text-xs font-mono border transition-all ${
                            containerPortInput === p.port.toString()
                              ? 'bg-cyan-950 text-cyan-300 border-cyan-500/80 ring-1 ring-cyan-500/40'
                              : 'bg-slate-900 text-slate-300 border-slate-700/80 hover:bg-slate-800'
                          }`}
                        >
                          {p.port} {p.name ? `(${p.name})` : ''}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">
                      Container Port <span className="text-cyan-400">*</span>
                    </label>
                    <input
                      type="number"
                      placeholder="e.g. 8080"
                      value={containerPortInput}
                      onChange={(e) => setContainerPortInput(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700/80 text-slate-100 font-mono text-sm focus:outline-none focus:border-cyan-500"
                    />
                    <span className="text-[11px] text-slate-500 mt-1 block">Port inside the pod to reach</span>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">
                      Local Port (on your computer)
                    </label>
                    <input
                      type="number"
                      placeholder="e.g. 8080 (Leave empty for auto)"
                      value={localPortInput}
                      onChange={(e) => setLocalPortInput(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700/80 text-slate-100 font-mono text-sm focus:outline-none focus:border-cyan-500"
                    />
                    <span className="text-[11px] text-slate-500 mt-1 block">Local port will be http://localhost:&lt;port&gt;</span>
                  </div>
                </div>

                {forwardError && (
                  <div className="p-3 rounded-lg bg-rose-950/60 border border-rose-800/80 text-rose-300 text-xs flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
                    <span>{forwardError}</span>
                  </div>
                )}

                <div className="pt-2">
                  <button
                    type="button"
                    onClick={() => handleStartForward()}
                    disabled={isStartingForward || !containerPortInput}
                    className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs flex items-center justify-center gap-2 transition-all shadow-lg shadow-cyan-500/25 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isStartingForward ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>Starting Port Forward...</span>
                      </>
                    ) : (
                      <>
                        <Radio className="w-3.5 h-3.5" />
                        <span>Start Port Forwarding</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ================= TAB 4: EVENTS ================= */}
          {activeTab === 'events' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>Recent Kubernetes events for this pod:</span>
                <button onClick={loadEvents} className="text-cyan-400 hover:underline flex items-center gap-1">
                  <RefreshCw className={`w-3 h-3 ${isLoadingEvents ? 'animate-spin' : ''}`} />
                  <span>Refresh</span>
                </button>
              </div>

              {events.length === 0 ? (
                <div className="p-8 text-center text-slate-500 text-xs italic bg-slate-950/40 rounded-xl border border-slate-800">
                  No recent events recorded for this pod.
                </div>
              ) : (
                <div className="rounded-xl bg-slate-950/60 border border-slate-800 overflow-hidden divide-y divide-slate-800/60 text-xs">
                  {events.map((ev, idx) => {
                    const isWarning = ev.type === 'Warning';
                    return (
                      <div key={idx} className="p-3.5 flex items-start gap-3 hover:bg-slate-900/40">
                        {isWarning ? (
                          <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                        ) : (
                          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={`px-1.5 py-0.2 rounded text-[10px] font-bold font-mono ${
                              isWarning ? 'bg-amber-950 text-amber-300 border border-amber-800' : 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                            }`}>
                              {ev.reason}
                            </span>
                            <span className="text-slate-500 text-[11px]">
                              {ev.lastTimestamp || ev.eventTime || 'recently'}
                            </span>
                          </div>
                          <div className="text-slate-200 mt-1 font-mono text-[11px] break-words">
                            {ev.message}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

        </div>

        {/* Modal Footer */}
        <div className="px-4 sm:px-6 py-2.5 bg-slate-950 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400 select-none shrink-0">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-cyan-400" />
            <span className="truncate max-w-[280px]">{context ? `Cluster: ${context}` : 'lensbyacp Kubernetes IDE'}</span>
            <span className="text-slate-600">•</span>
            <span className="text-cyan-400/90 font-medium">Developed by Ashutosh Chandra</span>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium transition-colors cursor-pointer"
            >
              {isInline ? 'Back to Pods' : 'Close'}
            </button>
          </div>
        </div>

      </div>
  );

  if (isInline) {
    return modalBody;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 select-text">
      {/* Backdrop */}
      <div 
        className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm transition-opacity animate-in fade-in" 
        onClick={onClose}
      />
      {modalBody}
    </div>
  );
};
