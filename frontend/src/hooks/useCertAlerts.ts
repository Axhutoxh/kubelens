import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchCerts, CertEntry } from '../api/insights';
import { requestAttention } from '../api/client';
import { PodAlert } from './usePodAlerts';

// Certificates change slowly; checking twice an hour is plenty
const POLL_MS = 30 * 60 * 1000;
const SEEN_KEY = 'kubellens_cert_alerts_seen';
const MAX_SEEN = 500;

/**
 * The tightest threshold a certificate has crossed, or null with more than 30 days left.
 * `days` is floored, so 0 means less than 24 hours.
 */
export function certThreshold(days: number | undefined): { level: string; reason: string } | null {
  if (days === undefined) return null;
  if (days < 0) return { level: 'expired', reason: 'Certificate expired' };
  if (days < 1) return { level: '1', reason: 'Certificate expires within a day' };
  if (days <= 7) return { level: '7', reason: 'Certificate expires within 7 days' };
  if (days <= 30) return { level: '30', reason: 'Certificate expires within 30 days' };
  return null;
}

function loadSeen(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

function storeSeen(seen: Set<string>) {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-MAX_SEEN))); } catch { /* storage unavailable */ }
}

function toAlert(c: CertEntry, context: string): Omit<PodAlert, 'at' | 'read'> | null {
  if (c.missing) {
    return {
      id: `cert/${context}/${c.namespace}/${c.name}/missing`,
      kind: 'cert',
      namespace: c.namespace,
      pod: c.name,
      reason: 'TLS Secret missing',
      message: `Used by ${c.usedBy.map((u) => u.ingress).join(', ')}`,
    };
  }
  const t = certThreshold(c.daysLeft);
  if (!t) return null;
  const names = c.leaf ? [c.leaf.commonName, ...c.leaf.dnsNames].filter(Boolean) : [];
  return {
    id: `cert/${context}/${c.namespace}/${c.name}/${t.level}`,
    kind: 'cert',
    namespace: c.namespace,
    pod: c.name,
    reason: t.reason,
    message: [names[0], c.expiresAt ? `expires ${new Date(c.expiresAt * 1000).toISOString().slice(0, 10)}` : '', c.managedBy ? 'auto-renewed by cert-manager' : '']
      .filter(Boolean)
      .join(' · '),
  };
}

/**
 * Watches TLS certificates of the whole cluster (or the selected namespace when the user can't
 * list Secrets cluster-wide) and raises one alert per certificate per threshold: 30, 7 and 1
 * days, and expired. Thresholds already shown are remembered across restarts.
 */
export function useCertAlerts(namespace: string, context: string, enabled: boolean, onNewAlert?: (a: PodAlert) => void) {
  const [alerts, setAlerts] = useState<PodAlert[]>([]);
  const onNewRef = useRef(onNewAlert);
  onNewRef.current = onNewAlert;

  useEffect(() => {
    if (!enabled || !context) return;
    let alive = true;
    let timer = 0;
    const poll = async () => {
      try {
        const res = await fetchCerts(undefined, context).catch(() => fetchCerts(namespace, context));
        if (!alive) return;
        const seen = loadSeen();
        const now = Date.now();
        const current = res.items.map((c) => toAlert(c, context)).filter(Boolean) as Array<Omit<PodAlert, 'at' | 'read'>>;
        const fresh = current.filter((a) => !seen.has(a.id));
        fresh.forEach((a) => seen.add(a.id));
        if (fresh.length) storeSeen(seen);
        setAlerts((prev) => {
          const old = new Map(prev.map((a) => [a.id, a]));
          return current.map((a) => old.get(a.id) || { ...a, at: now, read: !fresh.some((f) => f.id === a.id) });
        });
        if (fresh.length) {
          fresh.forEach((a) => onNewRef.current?.({ ...a, at: now, read: false }));
          requestAttention();
        }
      } catch {
        // No access to Secrets or cluster unreachable: no certificate alerts
      } finally {
        if (alive) timer = window.setTimeout(poll, POLL_MS);
      }
    };
    // Let the views load first
    timer = window.setTimeout(poll, 8000);
    return () => { alive = false; clearTimeout(timer); };
  }, [namespace, context, enabled]);

  useEffect(() => setAlerts([]), [context]);

  const markAllRead = useCallback(() => setAlerts((prev) => prev.map((a) => (a.read ? a : { ...a, read: true }))), []);
  const clear = useCallback(() => setAlerts([]), []);
  return { alerts, markAllRead, clear };
}
