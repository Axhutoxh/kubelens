import React, { useEffect, useMemo, useState } from 'react';
import { BadgeCheck, FileCode, AlertTriangle, RefreshCw, Link2, Sparkles } from 'lucide-react';
import { CertEntry, fetchCerts } from '../api/insights';
import { ViewLoader } from '../components/ViewLoader';

interface CertificatesViewProps {
  namespace: string;
  currentContext: string;
  searchQuery: string;
  refreshTick: number;
  onOpenManifest: (kind: string, name: string, namespace?: string) => void;
  onAskAi?: (text: string, focus?: string) => void;
}

type Filter = 'all' | 'soon' | 'expired' | 'problems';

/** "CN=R11, O=Let's Encrypt, C=US" -> "R11 (Let's Encrypt)" */
export function shortDn(dn: string) {
  const part = (key: string) => new RegExp(`(?:^|,\\s*)${key}=([^,]+)`).exec(dn)?.[1]?.trim();
  const cn = part('CN');
  const o = part('O');
  if (cn && o && o !== cn) return `${cn} (${o})`;
  return cn || o || dn;
}

export function daysTone(days?: number) {
  if (days === undefined) return 'bg-slate-800 text-slate-400 border-slate-700';
  if (days < 0) return 'bg-rose-600/30 text-rose-200 border-rose-500';
  if (days <= 7) return 'bg-rose-950 text-rose-300 border-rose-800/80';
  if (days <= 30) return 'bg-amber-950 text-amber-300 border-amber-800/80';
  return 'bg-emerald-950 text-emerald-400 border-emerald-800/80';
}

/** `days` is floored: 0 means under 24 hours left, -1 means expired less than a day ago. */
export function daysLabel(days?: number) {
  if (days === undefined) return '—';
  if (days < 0) {
    const ago = -days - 1;
    return ago === 0 ? 'expired < 1 day ago' : `expired ${ago} day${ago === 1 ? '' : 's'} ago`;
  }
  if (days === 0) return '< 1 day left';
  return `${days} day${days === 1 ? '' : 's'}`;
}

const isProblem = (c: CertEntry) => c.missing || !!c.error || (c.daysLeft !== undefined && c.daysLeft <= 30);

/** Every TLS Secret with its expiry, names, issuer and the Ingresses that serve it. */
export const CertificatesView: React.FC<CertificatesViewProps> = ({ namespace, currentContext, searchQuery, refreshTick, onOpenManifest, onAskAi }) => {
  const [items, setItems] = useState<CertEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchCerts(namespace, currentContext)
      .then((r) => { if (alive) { setItems(r.items); setError(null); } })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [namespace, currentContext, refreshTick, reload]);

  const q = searchQuery.toLowerCase();
  const searched = useMemo(() => (items || []).filter((c) => {
    if (!q) return true;
    const hay = [c.name, c.namespace, c.leaf?.commonName || '', ...(c.leaf?.dnsNames || []), c.leaf?.issuer || '', ...c.usedBy.flatMap((u) => [u.ingress, ...u.hosts])].join(' ').toLowerCase();
    return hay.includes(q);
  }), [items, q]);

  const counts = {
    all: searched.length,
    soon: searched.filter((c) => c.daysLeft !== undefined && c.daysLeft >= 0 && c.daysLeft <= 30).length,
    expired: searched.filter((c) => c.daysLeft !== undefined && c.daysLeft < 0).length,
    problems: searched.filter(isProblem).length,
  };
  const shown = searched.filter((c) =>
    filter === 'all' ? true
      : filter === 'soon' ? c.daysLeft !== undefined && c.daysLeft >= 0 && c.daysLeft <= 30
      : filter === 'expired' ? c.daysLeft !== undefined && c.daysLeft < 0
      : isProblem(c)
  );

  if (!items && !error) return <ViewLoader label={`Reading TLS certificates from ${currentContext || 'cluster'}…`} />;

  const chip = (id: Filter, label: string, n: number, tone = '') => (
    <button
      key={id}
      onClick={() => setFilter(id)}
      className={`px-2 py-0.5 rounded border text-[11px] font-semibold transition-colors ${
        filter === id ? 'bg-cyan-500/15 text-cyan-200 border-cyan-500/60' : `bg-slate-900 border-slate-700 hover:bg-slate-800 ${tone || 'text-slate-400'}`
      }`}
    >
      {label} <span className="font-mono opacity-80">{n}</span>
    </button>
  );

  return (
    <div className="h-full flex flex-col overflow-hidden select-text">
      <div className="px-6 py-3 border-b border-slate-800 bg-slate-900/40 flex items-center justify-between gap-3 text-xs text-slate-400 select-none">
        <div className="flex items-center gap-2 font-medium">
          <BadgeCheck className="w-4 h-4 text-cyan-400" />
          <span className="text-slate-200">TLS Certificates</span>
          <span className="bg-slate-800 text-slate-400 px-2 py-0.5 rounded font-mono text-[11px]">{shown.length} of {items?.length ?? 0}</span>
        </div>
        <div className="flex items-center gap-1.5" role="group" aria-label="Filter certificates">
          {chip('all', 'All', counts.all)}
          {chip('soon', 'Expiring in 30 days', counts.soon, counts.soon ? 'text-amber-300' : '')}
          {chip('expired', 'Expired', counts.expired, counts.expired ? 'text-rose-300' : '')}
          {chip('problems', 'Needs attention', counts.problems, counts.problems ? 'text-rose-300' : '')}
          <button onClick={() => setReload((n) => n + 1)} title="Re-read certificates" className="ml-1 p-1 rounded text-slate-400 hover:text-cyan-300 hover:bg-slate-800">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error && <div className="m-4 text-xs text-rose-300 bg-rose-950/50 border border-rose-900 rounded p-3 whitespace-pre-wrap">{error}</div>}

      <div className="flex-1 overflow-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead className="bg-slate-950/80 text-slate-400 sticky top-0 z-10 border-b border-slate-800 select-none backdrop-blur-sm">
            <tr>
              <th className="py-2.5 px-4 font-semibold">Secret</th>
              <th className="py-2.5 px-4 font-semibold">Domains</th>
              <th className="py-2.5 px-4 font-semibold">Issuer</th>
              <th className="py-2.5 px-4 font-semibold">Expires</th>
              <th className="py-2.5 px-4 font-semibold">Time left</th>
              <th className="py-2.5 px-4 font-semibold">Used by</th>
              <th className="py-2.5 px-4 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50 font-mono text-slate-300">
            {shown.length === 0 ? (
              <tr><td colSpan={7} className="py-12 text-center text-slate-500 italic font-sans">
                {items?.length ? 'No certificates match this filter.' : 'No TLS Secrets in this scope.'}
              </td></tr>
            ) : shown.map((c) => {
              const names = c.leaf ? [...new Set([c.leaf.commonName, ...c.leaf.dnsNames].filter(Boolean) as string[])] : [];
              const expires = c.expiresAt ? new Date(c.expiresAt * 1000) : null;
              return (
                <tr key={`${c.namespace}/${c.name}`} className="hover:bg-slate-800/40 transition-colors align-top">
                  <td className="py-2.5 px-4">
                    <div className="font-semibold text-slate-100">{c.name}</div>
                    <div className="text-[10px] text-slate-500">{c.namespace}</div>
                  </td>
                  <td className="py-2.5 px-4 max-w-xs">
                    {c.missing ? (
                      <span className="flex items-center gap-1 text-rose-300 font-sans"><AlertTriangle className="w-3.5 h-3.5" /> Secret missing: the Ingress serves a default certificate</span>
                    ) : c.error ? (
                      <span className="text-rose-300 font-sans">{c.error}</span>
                    ) : (
                      <div className="space-y-0.5" title={names.join('\n')}>
                        {names.slice(0, 3).map((n) => <div key={n} className="truncate">{n}</div>)}
                        {names.length > 3 && <div className="text-[10px] text-slate-500 font-sans">+{names.length - 3} more</div>}
                      </div>
                    )}
                  </td>
                  <td className="py-2.5 px-4 text-slate-400 max-w-[220px]">
                    {c.leaf && (
                      <div className="truncate" title={c.leaf.issuer}>{c.leaf.selfSigned ? <span className="text-amber-300 font-sans">Self-signed</span> : shortDn(c.leaf.issuer)}</div>
                    )}
                    {c.managedBy && <div className="text-[10px] text-emerald-400 font-sans" title={`cert-manager Certificate "${c.managedBy}" renews this automatically`}>auto-renewed (cert-manager)</div>}
                  </td>
                  <td className="py-2.5 px-4 whitespace-nowrap text-slate-300" title={expires?.toString()}>
                    {expires ? expires.toISOString().slice(0, 10) : '—'}
                    {c.expiringSubject && <div className="text-[10px] text-amber-300 font-sans" title={c.expiringSubject}>chain cert expires first</div>}
                  </td>
                  <td className="py-2.5 px-4">
                    {c.daysLeft !== undefined && (
                      <span className={`px-2 py-0.5 rounded text-[10px] font-semibold border whitespace-nowrap ${daysTone(c.daysLeft)}`}>{daysLabel(c.daysLeft)}</span>
                    )}
                  </td>
                  <td className="py-2.5 px-4 max-w-xs">
                    {c.usedBy.length === 0 ? <span className="text-slate-600">—</span> : c.usedBy.map((u) => (
                      <div key={u.ingress} className="flex items-center gap-1 truncate" title={u.hosts.join('\n')}>
                        <Link2 className="w-3 h-3 text-cyan-500 shrink-0" />
                        <span className="text-slate-200">{u.ingress}</span>
                        {u.hosts.length > 0 && <span className="text-[10px] text-slate-500 truncate">{u.hosts[0]}{u.hosts.length > 1 ? ` +${u.hosts.length - 1}` : ''}</span>}
                      </div>
                    ))}
                  </td>
                  <td className="py-2.5 px-4 text-right">
                    <div className="flex items-center justify-end gap-1 font-sans">
                      {onAskAi && isProblem(c) && (
                        <button
                          onClick={() => onAskAi(
                            c.missing
                              ? `Ingress ${c.usedBy.map((u) => u.ingress).join(', ')} in ${c.namespace} refers to TLS Secret ${c.name}, which doesn't exist. What breaks and how do I fix it?`
                              : `TLS Secret ${c.namespace}/${c.name} (${names[0] || 'certificate'}): ${daysLabel(c.daysLeft)}${c.daysLeft !== undefined && c.daysLeft > 0 ? ' left' : ''}. Who uses it and how should I renew it?`,
                            `secret ${c.namespace}/${c.name}`
                          )}
                          title="Ask the AI assistant"
                          className="p-1 text-slate-400 hover:text-violet-300 hover:bg-slate-800 rounded transition-colors"
                        >
                          <Sparkles className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {!c.missing && (
                        <button onClick={() => onOpenManifest('secret', c.name, c.namespace)} title="View manifest" className="p-1 text-slate-400 hover:text-amber-300 hover:bg-slate-800 rounded transition-colors">
                          <FileCode className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
