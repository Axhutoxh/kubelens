import { useEffect, useRef, useState } from 'react';
import { watchUrl } from '../api/v18';

/** Kinds each view shows, so the backend watches exactly those (max 6) */
export const VIEW_KINDS: Record<string, string[]> = {
  overview: ['pods', 'nodes', 'events', 'deployments', 'services'],
  pods: ['pods'],
  deployments: ['deployments'],
  statefulsets: ['statefulsets'],
  daemonsets: ['daemonsets'],
  jobs: ['jobs', 'cronjobs'],
  storage: ['persistentvolumeclaims', 'persistentvolumes', 'storageclasses'],
  namespaces: ['namespaces'],
  nodes: ['nodes'],
  services: ['services'],
  ingresses: ['ingresses'],
  configmaps: ['configmaps'],
  secrets: ['secrets'],
  'config-all': ['configmaps', 'secrets'],
  events: ['events'],
};

/**
 * Live updates for the current view: an SSE stream from the backend's kubectl watches calls
 * `onChange` (debounced) when anything shown changes. `live` is true while the stream is up,
 * so the caller can poll less often.
 */
export function useLiveUpdates(view: string, namespace: string, context: string, onChange: () => void) {
  const [live, setLive] = useState(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const kinds = VIEW_KINDS[view];

  useEffect(() => {
    setLive(false);
    if (!kinds || !context) return;
    let es: EventSource | null = null;
    let retry = 0;
    let retryTimer = 0;
    let debounce = 0;
    let closed = false;

    const connect = () => {
      es = new EventSource(watchUrl(kinds, namespace, context));
      es.addEventListener('ready', () => { setLive(true); retry = 0; });
      // A watch dropped (cluster unreachable, server closed it): poll until it is back
      es.addEventListener('down', () => setLive(false));
      es.addEventListener('changed', () => {
        // Bursts (a rollout touches many pods) collapse into one reload
        clearTimeout(debounce);
        debounce = window.setTimeout(() => { if (!document.hidden) onChangeRef.current(); }, 400);
      });
      es.onerror = () => {
        setLive(false);
        es?.close();
        if (closed) return;
        retry = Math.min(retry + 1, 5);
        retryTimer = window.setTimeout(connect, retry * 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retryTimer);
      clearTimeout(debounce);
      es?.close();
    };
    // kinds is derived from view
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, namespace, context]);

  return live;
}
