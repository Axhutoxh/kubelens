import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Package, X, Search, Loader2, Plus, RefreshCw, Play, FlaskConical, GitCompare, FileText } from 'lucide-react';
import { HelmChart, helmAddRepo, helmChartValues, helmRepos, helmSearch, helmUpdateRepos, helmUpgrade, helmVersions } from '../api/v18';
import { HelmRelease, fetchHelmRelease } from '../api/client';
import { diffLines, withContext } from '../utils/diff';

interface HelmInstallDialogProps {
  /** Upgrade this release; omit to install a new one */
  release?: HelmRelease;
  namespace: string;
  context?: string;
  onClose: () => void;
  onDone: () => void;
  onToast: (message: string, type?: 'success' | 'error') => void;
}

/** "redis-18.6.1" -> "redis" */
const chartBaseName = (chart: string) => chart.replace(/-v?\d+(\.\d+)*([-+][\w.]+)?$/, '');

/** Install a chart from a repository, or upgrade a release, with a values editor, a diff of
 *  the values and a dry run before anything changes. */
export const HelmInstallDialog: React.FC<HelmInstallDialogProps> = ({ release, namespace, context, onClose, onDone, onToast }) => {
  const upgrading = !!release;
  const [repos, setRepos] = useState<Array<{ name: string; url: string }> | null>(null);
  const [helmMissing, setHelmMissing] = useState(false);
  const [newRepo, setNewRepo] = useState({ name: '', url: '' });
  const [query, setQuery] = useState(release ? chartBaseName(release.chart) : '');
  const [charts, setCharts] = useState<HelmChart[] | null>(null);
  const [chart, setChart] = useState('');
  const [versions, setVersions] = useState<HelmChart[]>([]);
  const [version, setVersion] = useState('');
  const [name, setName] = useState(release?.name || '');
  const [ns, setNs] = useState(release?.namespace || (namespace === '_all' ? 'default' : namespace));
  const [createNs, setCreateNs] = useState(false);
  const [baseline, setBaseline] = useState('');
  const [values, setValues] = useState('');
  const [tab, setTab] = useState<'values' | 'diff' | 'output'>('values');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const loadRepos = () => helmRepos().then((r) => { setRepos(r.repos || []); setHelmMissing(!!r.helmMissing); if (r.error && !r.helmMissing) setError(r.error); });
  useEffect(() => { loadRepos(); }, []);

  // Upgrade: start from the release's current user-supplied values
  useEffect(() => {
    if (!release) return;
    fetchHelmRelease(release.name, release.namespace, 'values', { context })
      .then((r) => {
        const v = (r.content || '').replace(/^USER-SUPPLIED VALUES:\s*\n?/, '').replace(/^null\s*$/, '');
        setBaseline(v);
        setValues(v);
      })
      .catch((e) => setError(e.message));
  }, [release, context]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try { await fn(); } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  const search = () => run('search', async () => setCharts((await helmSearch(query.trim())).charts));
  useEffect(() => { if (repos && repos.length > 0 && query) search(); /* initial search for upgrades */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos?.length]);

  const pickChart = (c: HelmChart) => run('chart', async () => {
    setChart(c.name);
    setVersion(c.version);
    if (!name && !upgrading) setName(c.name.split('/').pop() || '');
    const [vs, defaults] = await Promise.all([helmVersions(c.name), helmChartValues(c.name, c.version)]);
    setVersions(vs.versions);
    if (!upgrading) {
      setBaseline(defaults.values);
      setValues(defaults.values);
    }
  });

  const loadDefaults = () => run('defaults', async () => {
    const d = await helmChartValues(chart, version);
    setValues(d.values);
  });

  const submit = (dryRun: boolean) => run(dryRun ? 'dry' : 'apply', async () => {
    if (!dryRun && !window.confirm(`${upgrading ? 'Upgrade' : 'Install'} ${name} with ${chart}${version ? ` ${version}` : ''} in ${ns}?`)) return;
    const r = await helmUpgrade({ release: name.trim(), namespace: ns.trim(), chart, version: version || undefined, values, install: !upgrading, createNamespace: createNs, dryRun, context });
    setOutput(r.output);
    setTab('output');
    if (!dryRun) {
      onToast(`${upgrading ? 'Upgraded' : 'Installed'} ${name}`);
      onDone();
    }
  });

  const diff = useMemo(() => withContext(diffLines(baseline, values), 3), [baseline, values]);
  const changed = diff.some((op) => op && op.type !== 'same');
  const input = 'bg-slate-950 border border-slate-700 rounded-md px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500';

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4" onClick={() => !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="helm-title" className="w-full max-w-5xl h-[88vh] flex flex-col rounded-xl border border-slate-700 bg-slate-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-800">
          <Package className="w-4 h-4 text-cyan-400" />
          <h2 id="helm-title" className="text-sm font-semibold text-slate-100">{upgrading ? `Upgrade ${release!.name}` : 'Install a Helm chart'}</h2>
          {upgrading && <span className="text-[11px] text-slate-500 font-mono">{release!.chart} · {release!.namespace}</span>}
          <button onClick={onClose} disabled={!!busy} className="ml-auto p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>

        {helmMissing ? (
          <div className="p-6 text-xs text-amber-200">The <code>helm</code> CLI isn't on your PATH. Install it, then reopen this dialog.</div>
        ) : (
          <div className="flex-1 min-h-0 flex">
            {/* Left: repositories, chart search, versions, release */}
            <div className="w-80 shrink-0 border-r border-slate-800 flex flex-col text-xs">
              <div className="p-3 border-b border-slate-800 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Repositories</span>
                  <button onClick={() => run('update', async () => { await helmUpdateRepos(); onToast('Repositories updated'); })} disabled={!!busy} className="ml-auto text-[11px] text-cyan-300 hover:text-cyan-200 flex items-center gap-1" title="helm repo update">
                    <RefreshCw className={`w-3 h-3 ${busy === 'update' ? 'animate-spin' : ''}`} /> Update
                  </button>
                </div>
                <div className="flex flex-wrap gap-1">
                  {repos === null ? <Loader2 className="w-3 h-3 animate-spin text-slate-500" /> : repos.length === 0 ? <span className="text-slate-500">None yet: add one below.</span> : repos.map((r) => (
                    <span key={r.name} title={r.url} className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 font-mono text-[10.5px]">{r.name}</span>
                  ))}
                </div>
                <div className="flex gap-1">
                  <input value={newRepo.name} onChange={(e) => setNewRepo({ ...newRepo, name: e.target.value })} placeholder="name" className={`${input} w-20`} />
                  <input value={newRepo.url} onChange={(e) => setNewRepo({ ...newRepo, url: e.target.value })} placeholder="https://charts.example.com" className={`${input} flex-1 min-w-0`} />
                  <button
                    onClick={() => run('repo', async () => { await helmAddRepo(newRepo.name.trim(), newRepo.url.trim()); setNewRepo({ name: '', url: '' }); await loadRepos(); onToast('Repository added'); })}
                    disabled={!newRepo.name || !newRepo.url || !!busy}
                    className="px-2 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-40" title="helm repo add"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <div className="p-3 border-b border-slate-800">
                <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); search(); }}>
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search charts, e.g. redis" className={`${input} flex-1 min-w-0`} />
                  <button type="submit" disabled={!!busy} className="px-2 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white disabled:opacity-40">
                    {busy === 'search' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                  </button>
                </form>
              </div>
              <div className="flex-1 overflow-auto">
                {charts?.length === 0 && <div className="p-3 text-slate-500">No charts found. Add a repository or update them.</div>}
                {(charts || []).map((c) => (
                  <button key={c.name} onClick={() => pickChart(c)} className={`w-full text-left px-3 py-2 border-b border-slate-800/60 hover:bg-slate-800/60 ${chart === c.name ? 'bg-cyan-500/10' : ''}`}>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-cyan-300 truncate">{c.name}</span>
                      <span className="ml-auto text-[10px] text-slate-500 font-mono">{c.version}</span>
                    </div>
                    <div className="text-[10.5px] text-slate-500 truncate">{c.description}</div>
                  </button>
                ))}
              </div>
              <div className="p-3 border-t border-slate-800 space-y-2">
                <div className="flex gap-2">
                  <label className="flex-1 space-y-0.5">
                    <span className="text-[10px] text-slate-500">Release</span>
                    <input value={name} onChange={(e) => setName(e.target.value)} disabled={upgrading} className={`${input} w-full`} />
                  </label>
                  <label className="flex-1 space-y-0.5">
                    <span className="text-[10px] text-slate-500">Namespace</span>
                    <input value={ns} onChange={(e) => setNs(e.target.value)} disabled={upgrading} className={`${input} w-full`} />
                  </label>
                </div>
                <label className="block space-y-0.5">
                  <span className="text-[10px] text-slate-500">Chart version {chart && <span className="font-mono text-slate-400">({chart})</span>}</span>
                  <select value={version} onChange={(e) => setVersion(e.target.value)} disabled={!chart} className={`${input} w-full`}>
                    {!versions.some((v) => v.version === version) && version && <option value={version}>{version}</option>}
                    {versions.map((v) => <option key={v.version} value={v.version}>{v.version}{v.app_version ? ` (app ${v.app_version})` : ''}</option>)}
                  </select>
                </label>
                {!upgrading && (
                  <label className="flex items-center gap-1.5 text-slate-400"><input type="checkbox" checked={createNs} onChange={(e) => setCreateNs(e.target.checked)} className="accent-cyan-500" /> Create the namespace if missing</label>
                )}
              </div>
            </div>

            {/* Right: values, diff, output */}
            <div className="flex-1 min-w-0 flex flex-col">
              <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-1 text-xs">
                {([['values', 'Values', FileText], ['diff', changed ? 'Changes' : 'Changes (none)', GitCompare], ['output', 'Output', FlaskConical]] as const).map(([id, label, Icon]) => (
                  <button key={id} onClick={() => setTab(id)} className={`px-2.5 py-1 rounded-md flex items-center gap-1 ${tab === id ? 'bg-slate-800 text-cyan-300' : 'text-slate-400 hover:text-slate-200'}`}>
                    <Icon className="w-3.5 h-3.5" /> {label}
                  </button>
                ))}
                {chart && <button onClick={loadDefaults} disabled={!!busy} className="ml-auto text-[11px] text-slate-400 hover:text-slate-200">Load chart defaults</button>}
              </div>
              <div className="flex-1 min-h-0 overflow-auto">
                {tab === 'values' && (
                  <textarea value={values} onChange={(e) => setValues(e.target.value)} spellCheck={false} placeholder={chart ? '# values.yaml' : 'Pick a chart on the left'} className="w-full h-full p-3 bg-slate-950 text-slate-200 font-mono text-xs resize-none focus:outline-none" />
                )}
                {tab === 'diff' && (
                  <pre className="font-mono text-[11.5px] leading-relaxed py-2">
                    <div className="px-3 pb-1 text-slate-500 font-sans text-[11px]">{upgrading ? 'Current release values → your edits' : 'Chart defaults → your edits'}</div>
                    {!changed ? <div className="px-3 text-slate-500 font-sans">No changes.</div> : diff.map((op, i) => op === null
                      ? <div key={i} className="px-3 text-slate-600">⋯</div>
                      : <div key={i} className={`px-3 whitespace-pre ${op.type === 'add' ? 'bg-emerald-950/50 text-emerald-200' : op.type === 'del' ? 'bg-rose-950/50 text-rose-200' : 'text-slate-400'}`}>{op.type === 'add' ? '+ ' : op.type === 'del' ? '- ' : '  '}{op.text}</div>)}
                  </pre>
                )}
                {tab === 'output' && <pre className="p-3 font-mono text-[11.5px] text-slate-300 whitespace-pre-wrap">{output || 'Run a dry run to see what Helm would render.'}</pre>}
              </div>
              {error && <div className="mx-3 mb-2 p-2.5 rounded-lg bg-rose-950/60 border border-rose-800/80 text-rose-300 text-xs whitespace-pre-wrap break-words max-h-32 overflow-auto">{error}</div>}
              <div className="px-3 py-2 border-t border-slate-800 flex items-center gap-2 justify-end text-xs">
                <button onClick={() => submit(true)} disabled={!chart || !name || !ns || !!busy} className="px-3 py-1.5 rounded-md border border-slate-700 text-slate-200 hover:bg-slate-800 flex items-center gap-1.5 disabled:opacity-40">
                  {busy === 'dry' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FlaskConical className="w-3.5 h-3.5" />} Dry run
                </button>
                <button onClick={() => submit(false)} disabled={!chart || !name || !ns || !!busy} className="px-3 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white font-semibold flex items-center gap-1.5 disabled:opacity-40">
                  {busy === 'apply' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} {upgrading ? 'Upgrade' : 'Install'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};
