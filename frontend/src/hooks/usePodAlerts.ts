import { useCallback, useEffect, useRef, useState } from 'react';
import { PodItem } from '../types/k8s';
import { fetchK8sResource, requestAttention } from '../api/client';

export interface PodAlert {
  id: string;
  at: number;
  namespace: string;
  pod: string;
  container?: string;
  reason: string;
  message?: string;
  read: boolean;
}

// Container states that need a human: they don't recover on their own
const WAITING_ALERTS = new Set(['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'InvalidImageName', 'CreateContainerConfigError', 'CreateContainerError']);
const VISIBLE_POLL_MS = 15000;
// Keep watching while minimised (that is when an alert is most useful), just less often
const HIDDEN_POLL_MS = 30000;
const MAX_ALERTS = 100;
const SETTINGS_KEY = 'kubellens_alert_settings';

interface AlertSettings {
  enabled: boolean;
  desktop: boolean;
}

function loadSettings(): AlertSettings {
  try {
    return { enabled: true, desktop: false, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { enabled: true, desktop: false };
  }
}

/**
 * Current problems of a pod. Ids include the restart count, so a container that
 * crashes or gets OOM-killed again raises a fresh alert.
 */
function podProblems(pod: PodItem): Array<Omit<PodAlert, 'at' | 'read'>> {
  const ns = pod.metadata.namespace || 'default';
  const base = `${ns}/${pod.metadata.name}`;
  const out: Array<Omit<PodAlert, 'at' | 'read'>> = [];
  const statusReason = (pod.status as any).reason as string | undefined;
  if (statusReason === 'Evicted' || pod.status.phase === 'Failed') {
    out.push({ id: `${base}/${statusReason || 'Failed'}`, namespace: ns, pod: pod.metadata.name, reason: statusReason || 'Failed', message: (pod.status as any).message });
  }
  for (const c of [...(pod.status.initContainerStatuses || []), ...(pod.status.containerStatuses || [])]) {
    const waiting = c.state?.waiting?.reason;
    if (waiting && WAITING_ALERTS.has(waiting)) {
      out.push({
        id: `${base}/${c.name}/${waiting}/${c.restartCount}`,
        namespace: ns,
        pod: pod.metadata.name,
        container: c.name,
        reason: waiting,
        message: c.state?.waiting?.message,
      });
    }
    const last = c.lastState?.terminated?.reason;
    if (last === 'OOMKilled') {
      out.push({
        id: `${base}/${c.name}/OOMKilled/${c.restartCount}`,
        namespace: ns,
        pod: pod.metadata.name,
        container: c.name,
        reason: 'OOMKilled',
        message: `Container restarted after running out of memory (restart #${c.restartCount})`,
      });
    }
  }
  return out;
}

/**
 * Watches pods in `namespace` and raises an alert the first time a problem appears.
 * Problems already present when watching starts are listed but don't notify.
 */
export function usePodAlerts(namespace: string, context: string, onNewAlert?: (a: PodAlert) => void) {
  const [settings, setSettings] = useState<AlertSettings>(loadSettings);
  const [alerts, setAlerts] = useState<PodAlert[]>([]);
  const [pods, setPods] = useState<PodItem[]>([]);
  const seenRef = useRef<Set<string> | null>(null);
  const onNewRef = useRef(onNewAlert);
  onNewRef.current = onNewAlert;

  const updateSettings = useCallback((patch: Partial<AlertSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!settings.enabled || !context) return;
    let alive = true;
    let timer = 0;
    seenRef.current = null; // new scope: re-baseline
    const poll = async () => {
      try {
        const res = await fetchK8sResource<PodItem>('pods', namespace);
        if (!alive) return;
        const items = res.items || [];
        setPods(items);
        const problems = items.flatMap(podProblems);
        const baseline = seenRef.current === null;
        const seen = seenRef.current || new Set<string>();
        const fresh = problems.filter((p) => !seen.has(p.id));
        fresh.forEach((p) => seen.add(p.id));
        seenRef.current = seen;
        if (fresh.length > 0) {
          const now = Date.now();
          const created = fresh.map((p) => ({ ...p, at: now, read: baseline }));
          setAlerts((prev) => [...created.reverse(), ...prev].slice(0, MAX_ALERTS));
          if (!baseline) {
            created.forEach((a) => onNewRef.current?.(a));
            if (settings.desktop && 'Notification' in window && Notification.permission === 'granted') {
              const first = created[0];
              try {
                new Notification(created.length > 1 ? `${created.length} pod problems` : `${first.reason}: ${first.pod}`, {
                  body: created.length > 1 ? created.map((a) => `${a.reason}: ${a.pod}`).slice(0, 4).join('\n') : first.message || first.namespace,
                  tag: 'kubellens-pod-alert',
                });
              } catch { /* not supported in this webview */ }
            }
            requestAttention();
          }
        }
      } catch {
        // Cluster unreachable: try again next tick
      } finally {
        if (alive) timer = window.setTimeout(poll, document.hidden ? HIDDEN_POLL_MS : VISIBLE_POLL_MS);
      }
    };
    poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [namespace, context, settings.enabled, settings.desktop]);

  // Alerts belong to the cluster they were raised on
  useEffect(() => setAlerts([]), [context]);

  const markAllRead = useCallback(() => setAlerts((prev) => prev.map((a) => (a.read ? a : { ...a, read: true }))), []);
  const clear = useCallback(() => setAlerts([]), []);

  const enableDesktop = useCallback(async () => {
    if (!('Notification' in window)) return false;
    const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    const ok = perm === 'granted';
    updateSettings({ desktop: ok });
    return ok;
  }, [updateSettings]);

  return { alerts, pods, settings, updateSettings, markAllRead, clear, enableDesktop };
}
