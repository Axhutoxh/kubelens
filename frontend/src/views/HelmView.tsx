import React, { useCallback, useEffect, useState } from 'react';
import { Package, Loader2, X, RotateCcw, Trash2, AlertTriangle, ExternalLink, Copy } from 'lucide-react';
import {
  fetchHelmReleases,
  fetchHelmRelease,
  helmRollback,
  helmUninstall,
  HelmRelease,
  HelmHistoryEntry,
} from '../api/client';
import { ViewLoader } from '../components/ViewLoader';

interface HelmViewProps {
  namespace: string;
  currentContext: string;
  searchQuery: string;
  /** Bumped by the app's refresh button */
  refreshTick: number;
  onToast: (message: string, type?: 'success' | 'error') => void;
}

const STATUS_STYLES: Record<string, string> = {
  deployed: 'bg-emerald-950 text-emerald-400 border-emerald-800/80',
  failed: 'bg-rose-950 text-rose-400 border-rose-800/80',
  superseded: 'bg-slate-800 text-slate-400 border-slate-700',
  uninstalling: 'bg-amber-950 text-amber-400 border-amber-800/80',
};
const statusClass = (s: string) =>
  STATUS_STYLES[s] || (s.startsWith('pending') ? 'bg-amber-950 text-amber-400 border-amber-800/80' : 'bg-slate-800 text-slate-300 border-slate-700');

// helm prints timestamps like "2026-10-20 14:03:11.123 +0000 UTC"
function shortDate(s: string) {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/.exec(s || '');
  return m ? `${m[1]} ${m[2]}` : s;
}

type Tab = 'values' | 'all-values' | 'manifest' | 'notes' | 'history';

const ReleaseDetail: React.FC<{
  release: HelmRelease;
  context: string;
  onClose: () => void;
  onChanged: () => void;
  onToast: HelmViewProps['onToast'];
}> = ({ release, context, onClose, onChanged, onToast }) => {
  const [tab, setTab] = useState<Tab>('values');
  const [content, setContent] = useState<string>('');
  const [history, setHistory] = useState<HelmHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const what = tab === 'all-values' ? 'values' : tab;
    fetchHelmRelease(release.name, release.namespace, what, { all: tab === 'all-values', context })
      .then((res) => {
        if (cancelled) return;
        if (tab === 'history') setHistory([...(res.history || [])].reverse());
        else setContent(res.content || '');
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [tab, release.name, release.namespace, context]);

  const rollback = async (revision: number) => {
    if (!window.confirm(`Roll back release "${release.name}" to revision ${revision}?`)) return;
    setBusy(true);
    try {
      await helmRollback(release.name, release.namespace, revision, context);
      onToast(`Rolled back ${release.name} to revision ${revision}`);
      onChanged();
      onClose();
    } catch (e: any) {
      onToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const uninstall = async () => {
    if (!window.confirm(`Uninstall Helm release "${release.name}" from ${release.namespace}? This deletes all of its resources.`)) return;
    setBusy(true);
    try {
      await helmUninstall(release.name, release.namespace, context);
      onToast(`Uninstalled ${release.name}`);
      onChanged();
      onClose();
    } catch (e: any) {
      onToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'values', label: 'User values' },
    { id: 'all-values', label: 'All values' },
    { id: 'manifest', label: 'Manifest' },
    { id: 'notes', label: 'Notes' },
    { id: 'history', label: 'History' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/60 backdrop-blur-sm" role="dialog" onClick={onClose}>
      <div className="w-full max-w-3xl h-full bg-slate-900 border-l border-slate-700 shadow-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-slate-800 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Package className="w-4 h-4 text-cyan-400 shrink-0" />
              <span className="text-sm font-semibold text-slate-100 truncate">{release.name}</span>
              <span className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${statusClass(release.status)}`}>{release.status}</span>
            </div>
            <div className="text-[11px] text-slate-400 font-mono mt-1">
              {release.namespace} · {release.chart} · app {release.app_version || '—'} · rev {release.revision}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={uninstall}
              disabled={busy}
              className="flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-md bg-rose-950/70 hover:bg-rose-900/70 border border-rose-900 text-rose-300 disabled:opacity-50"
            >
              <Trash2 className="w-3 h-3" /> Uninstall
            </button>
            <button onClick={onClose} className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800"><X className="w-4 h-4" /></button>
          </div>
        </div>

        <div className="px-5 border-b border-slate-800 flex gap-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors ${
                tab === t.id ? 'border-cyan-400 text-cyan-300' : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-auto relative">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-slate-400 p-5"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
          ) : error ? (
            <div className="m-5 text-xs text-rose-300 bg-rose-950/50 border border-rose-900 rounded p-3 whitespace-pre-wrap">{error}</div>
          ) : tab === 'history' ? (
            <table className="w-full text-left text-xs">
              <thead className="text-slate-400 sticky top-0 bg-slate-900 border-b border-slate-800">
                <tr>
                  <th className="py-2 px-5 font-semibold">Rev</th>
                  <th className="py-2 px-3 font-semibold">Updated</th>
                  <th className="py-2 px-3 font-semibold">Status</th>
                  <th className="py-2 px-3 font-semibold">Chart</th>
                  <th className="py-2 px-3 font-semibold">Description</th>
                  <th className="py-2 px-5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono text-slate-300">
                {history.map((h) => (
                  <tr key={h.revision}>
                    <td className="py-2 px-5 font-bold">{h.revision}</td>
                    <td className="py-2 px-3 text-slate-400">{shortDate(h.updated)}</td>
                    <td className="py-2 px-3"><span className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${statusClass(h.status)}`}>{h.status}</span></td>
                    <td className="py-2 px-3">{h.chart}</td>
                    <td className="py-2 px-3 text-slate-400 font-sans">{h.description}</td>
                    <td className="py-2 px-5 text-right">
                      {String(h.revision) !== String(release.revision) && (
                        <button
                          onClick={() => rollback(h.revision)}
                          disabled={busy}
                          className="flex items-center gap-1 ml-auto text-[11px] font-sans font-semibold px-2 py-0.5 rounded bg-slate-800 hover:bg-amber-900/60 text-amber-300 disabled:opacity-50"
                        >
                          <RotateCcw className="w-3 h-3" /> Roll back
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <>
              <button
                onClick={() => { navigator.clipboard?.writeText(content); onToast('Copied to clipboard'); }}
                className="absolute top-3 right-4 p-1.5 rounded bg-slate-800/80 text-slate-400 hover:text-slate-200"
                title="Copy"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
              <pre className="p-5 text-xs font-mono text-slate-200 whitespace-pre-wrap break-words select-text">
                {content.trim() || (tab === 'values' ? '# No user-supplied values (chart defaults in use)' : '# Empty')}
              </pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

/** Lists Helm releases (all statuses) using the local helm CLI. */
export const HelmView: React.FC<HelmViewProps> = ({ namespace, currentContext, searchQuery, refreshTick, onToast }) => {
  const [state, setState] = useState<{ loading: boolean; releases: HelmRelease[]; error?: string; helmMissing?: boolean }>({
    loading: true,
    releases: [],
  });
  const [selected, setSelected] = useState<HelmRelease | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setState((s) => ({ ...s, loading: true }));
    const res = await fetchHelmReleases(namespace, currentContext);
    setState({
      loading: false,
      releases: res.releases || [],
      error: res.available ? undefined : res.error,
      helmMissing: res.helmMissing,
    });
  }, [namespace, currentContext]);

  useEffect(() => { load(); }, [load, refreshTick]);

  if (state.loading && state.releases.length === 0) return <ViewLoader label="Loading Helm releases…" />;

  const q = searchQuery.toLowerCase();
  const releases = state.releases.filter((r) =>
    [r.name, r.namespace, r.chart, r.status].some((v) => (v || '').toLowerCase().includes(q))
  );

  return (
    <div className="h-full flex flex-col overflow-hidden select-text">
      <div className="px-6 py-3 border-b border-slate-800 bg-slate-900/40 flex items-center justify-between text-xs text-slate-400 select-none">
        <div className="flex items-center gap-2 font-medium">
          <Package className="w-4 h-4 text-cyan-400" />
          <span className="text-slate-200">Helm Releases</span>
          <span className="bg-slate-800 text-slate-400 px-2 py-0.5 rounded font-mono text-[11px]">{releases.length}</span>
          {state.loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" />}
        </div>
        <span className="text-[11px]">Click a release for values, manifest, history & rollback</span>
      </div>

      {state.error ? (
        <div className="m-6 max-w-2xl rounded-lg border border-amber-900/70 bg-amber-950/30 p-4 text-xs text-amber-200">
          <div className="flex items-center gap-2 font-semibold mb-1.5">
            <AlertTriangle className="w-4 h-4" />
            {state.helmMissing ? 'Helm CLI not found' : 'Could not list Helm releases'}
          </div>
          {state.helmMissing ? (
            <p className="text-amber-200/80 leading-relaxed">
              This view uses the <code className="font-mono">helm</code> command-line tool. Install it and make sure it is on your PATH, then refresh.{' '}
              <a href="https://helm.sh/docs/intro/install/" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-cyan-300 hover:underline">
                Install guide <ExternalLink className="w-3 h-3" />
              </a>
            </p>
          ) : (
            <pre className="whitespace-pre-wrap font-mono text-amber-200/80">{state.error}</pre>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-slate-950/80 text-slate-400 sticky top-0 z-10 border-b border-slate-800 select-none backdrop-blur-sm">
              <tr>
                <th className="py-2.5 px-4 font-semibold">Name</th>
                <th className="py-2.5 px-4 font-semibold">Namespace</th>
                <th className="py-2.5 px-4 font-semibold">Chart</th>
                <th className="py-2.5 px-4 font-semibold">App Version</th>
                <th className="py-2.5 px-4 font-semibold">Revision</th>
                <th className="py-2.5 px-4 font-semibold">Status</th>
                <th className="py-2.5 px-4 font-semibold">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50 font-mono text-slate-300">
              {releases.length === 0 ? (
                <tr><td colSpan={7} className="py-12 text-center text-slate-500 italic font-sans">No Helm releases found.</td></tr>
              ) : releases.map((r) => (
                <tr key={`${r.namespace}/${r.name}`} onClick={() => setSelected(r)} className="hover:bg-slate-800/50 cursor-pointer transition-colors group">
                  <td className="py-2.5 px-4 font-semibold text-slate-100 group-hover:text-cyan-300">{r.name}</td>
                  <td className="py-2.5 px-4"><span className="bg-slate-800/80 text-slate-300 px-2 py-0.5 rounded text-[11px]">{r.namespace}</span></td>
                  <td className="py-2.5 px-4 text-cyan-300">{r.chart}</td>
                  <td className="py-2.5 px-4 text-slate-400">{r.app_version || '—'}</td>
                  <td className="py-2.5 px-4">{r.revision}</td>
                  <td className="py-2.5 px-4"><span className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${statusClass(r.status)}`}>{r.status}</span></td>
                  <td className="py-2.5 px-4 text-slate-400">{shortDate(r.updated)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <ReleaseDetail
          release={selected}
          context={currentContext}
          onClose={() => setSelected(null)}
          onChanged={() => load(true)}
          onToast={onToast}
        />
      )}
    </div>
  );
};
