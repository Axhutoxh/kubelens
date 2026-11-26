import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FileCog, Loader2, Pencil, Trash2, Upload, Cloud, Check, X, ArrowRightLeft, Plus } from 'lucide-react';
import { CloudCluster, CloudProvider, KubeContext, cloudConnect, cloudList, kubeconfigDelete, kubeconfigImport, kubeconfigList, kubeconfigNamespace, kubeconfigRename } from '../api/v18';

interface KubeconfigViewProps {
  onChanged: () => void;
  onSwitch: (context: string) => void;
  onToast: (message: string, type?: 'success' | 'error') => void;
}

const CLOUDS: Array<{ id: CloudProvider; label: string; cli: string; needs: 'none' | 'region' | 'project' }> = [
  { id: 'aks', label: 'Azure AKS', cli: 'az', needs: 'none' },
  { id: 'eks', label: 'AWS EKS', cli: 'aws', needs: 'region' },
  { id: 'gke', label: 'Google GKE', cli: 'gcloud', needs: 'project' },
];

/** Contexts in the kubeconfig: rename, default namespace, delete, import / merge, cloud sign-in. */
export const KubeconfigView: React.FC<KubeconfigViewProps> = ({ onChanged, onSwitch, onToast }) => {
  const [data, setData] = useState<{ contexts: KubeContext[]; current: string; path?: string; clis: Record<string, boolean> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ ctx: string; field: 'name' | 'namespace'; value: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<{ added: string[]; skipped: string[]; backup?: string } | null>(null);
  const [cloud, setCloud] = useState<CloudProvider>('aks');
  const [cloudOpts, setCloudOpts] = useState({ region: '', project: '' });
  const [cloudClusters, setCloudClusters] = useState<CloudCluster[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => kubeconfigList().then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  const act = async (label: string, fn: () => Promise<string | void>) => {
    setBusy(label);
    try {
      const msg = await fn();
      if (msg) onToast(msg);
      await load();
      onChanged();
    } catch (e: any) {
      onToast(e.message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const saveEdit = () => {
    if (!edit) return;
    const { ctx, field, value } = edit;
    setEdit(null);
    if (field === 'name') {
      if (!value.trim() || value.trim() === ctx) return;
      act(`rename:${ctx}`, async () => { await kubeconfigRename(ctx, value.trim()); return `Renamed to ${value.trim()} (backup saved)`; });
    } else {
      act(`ns:${ctx}`, async () => { await kubeconfigNamespace(ctx, value.trim()); return `Default namespace of ${ctx}: ${value.trim() || 'none'}`; });
    }
  };

  const importFile = async (file: File) => {
    const text = await file.text();
    act('import', async () => {
      const r = await kubeconfigImport(text);
      setImportResult(r);
      return r.added.length ? `Added ${r.added.length} context(s)` : 'No new contexts (all names already existed)';
    });
  };

  const listCloud = () => act('cloud-list', async () => {
    setCloudClusters(null);
    const r = await cloudList(cloud, { region: cloudOpts.region.trim() || undefined, project: cloudOpts.project.trim() || undefined });
    setCloudClusters(r.clusters);
  });

  const connect = (c: CloudCluster) => act(`connect:${c.name}`, async () => {
    await cloudConnect(cloud, { name: c.name, resourceGroup: c.resourceGroup, region: c.location || cloudOpts.region.trim() || undefined, project: cloudOpts.project.trim() || undefined });
    return `Added ${c.name} to your kubeconfig`;
  });

  if (!data && !error) return <div className="h-full flex items-center justify-center text-xs text-slate-500"><Loader2 className="w-4 h-4 animate-spin mr-2" /> Reading kubeconfig…</div>;

  const input = 'bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-cyan-500';
  const provider = CLOUDS.find((c) => c.id === cloud)!;
  const cliPresent = data?.clis?.[provider.cli];

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-6 py-3 border-b border-slate-800 bg-slate-900/40 flex items-center gap-2 text-xs text-slate-400 select-none">
        <FileCog className="w-4 h-4 text-cyan-400" />
        <span className="text-slate-200 font-medium">Kubeconfig</span>
        {data?.path && <span className="font-mono text-[11px] text-slate-500 truncate" title={data.path}>{data.path}</span>}
        <span className="ml-auto text-[11px]">Every change saves a backup next to the file first.</span>
      </div>
      <div className="flex-1 overflow-auto p-6 space-y-6">
        {error && <div className="text-xs text-rose-300 bg-rose-950/50 border border-rose-900 rounded p-3">{error}</div>}

        <section className="rounded-xl border border-slate-800 bg-slate-900/50 overflow-hidden">
          <div className="px-4 py-2 border-b border-slate-800 text-xs font-semibold text-slate-200">Contexts</div>
          <table className="w-full text-left text-xs">
            <thead className="text-slate-500 border-b border-slate-800">
              <tr><th className="py-2 px-4 font-medium">Name</th><th className="py-2 px-4 font-medium">Cluster</th><th className="py-2 px-4 font-medium">User</th><th className="py-2 px-4 font-medium">Default namespace</th><th className="py-2 px-4 font-medium text-right">Actions</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono">
              {(data?.contexts || []).map((c) => {
                const editing = edit?.ctx === c.name ? edit : null;
                return (
                  <tr key={c.name} className="hover:bg-slate-800/30 align-top">
                    <td className="py-2 px-4">
                      {editing?.field === 'name' ? (
                        <span className="flex items-center gap-1">
                          <input autoFocus value={editing.value} onChange={(e) => setEdit({ ...editing, value: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEdit(null); }} className={`${input} w-56`} />
                          <button onClick={saveEdit} className="p-1 text-emerald-300"><Check className="w-3.5 h-3.5" /></button>
                          <button onClick={() => setEdit(null)} className="p-1 text-slate-500"><X className="w-3.5 h-3.5" /></button>
                        </span>
                      ) : (
                        <span className="text-slate-100 break-all">{c.name}{c.current && <span className="ml-2 text-[10px] font-sans text-cyan-400 font-semibold uppercase">current</span>}</span>
                      )}
                    </td>
                    <td className="py-2 px-4 text-slate-400 max-w-xs"><div className="truncate" title={c.server}>{c.cluster}</div><div className="text-[10px] text-slate-600 truncate">{c.server}</div></td>
                    <td className="py-2 px-4 text-slate-400 max-w-[200px] truncate" title={c.user}>{c.user}</td>
                    <td className="py-2 px-4">
                      {editing?.field === 'namespace' ? (
                        <span className="flex items-center gap-1">
                          <input autoFocus value={editing.value} onChange={(e) => setEdit({ ...editing, value: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEdit(null); }} placeholder="none" className={`${input} w-40`} />
                          <button onClick={saveEdit} className="p-1 text-emerald-300"><Check className="w-3.5 h-3.5" /></button>
                        </span>
                      ) : (
                        <button onClick={() => setEdit({ ctx: c.name, field: 'namespace', value: c.namespace || '' })} className="text-slate-300 hover:text-cyan-300" title="Set the default namespace">
                          {c.namespace || <span className="text-slate-600 font-sans">none</span>}
                        </button>
                      )}
                    </td>
                    <td className="py-2 px-4 text-right whitespace-nowrap font-sans">
                      {busy?.endsWith(c.name) && <Loader2 className="inline w-3.5 h-3.5 animate-spin text-cyan-400 mr-1" />}
                      {!c.current && (
                        <button onClick={() => onSwitch(c.name)} title="Switch to this context" className="p-1 rounded text-slate-400 hover:text-cyan-300 hover:bg-slate-800"><ArrowRightLeft className="w-3.5 h-3.5" /></button>
                      )}
                      <button onClick={() => setEdit({ ctx: c.name, field: 'name', value: c.name })} title="Rename" className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800"><Pencil className="w-3.5 h-3.5" /></button>
                      <button
                        onClick={() => window.confirm(`Delete context "${c.name}" from your kubeconfig?\n\nIts cluster and user entries are removed too when no other context uses them. A backup is saved first.`)
                          && act(`delete:${c.name}`, async () => { const r = await kubeconfigDelete(c.name); return `Removed ${r.removed.join(', ')}`; })}
                        title="Delete" className="p-1 rounded text-slate-400 hover:text-rose-400 hover:bg-slate-800"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 space-y-3 text-xs">
            <div className="flex items-center gap-2 font-semibold text-slate-200"><Upload className="w-4 h-4 text-cyan-400" /> Import a kubeconfig</div>
            <p className="text-slate-400">Merges another kubeconfig file (from a colleague, a cloud console or kind / minikube) into yours. Contexts whose names you already have are kept as they are.</p>
            <input ref={fileRef} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ''; }} />
            <button onClick={() => fileRef.current?.click()} disabled={!!busy} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white font-semibold disabled:opacity-40">
              {busy === 'import' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} Choose file…
            </button>
            {importResult && (
              <div className="text-[11px] space-y-0.5">
                <div className="text-emerald-300">Added: {importResult.added.join(', ') || 'none'}</div>
                {importResult.skipped.length > 0 && <div className="text-amber-300">Already existed (kept yours): {importResult.skipped.join(', ')}</div>}
                {importResult.backup && <div className="text-slate-500 font-mono break-all">Backup: {importResult.backup}</div>}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 space-y-3 text-xs">
            <div className="flex items-center gap-2 font-semibold text-slate-200"><Cloud className="w-4 h-4 text-cyan-400" /> Add a cloud cluster</div>
            <div className="flex gap-1">
              {CLOUDS.map((c) => (
                <button key={c.id} onClick={() => { setCloud(c.id); setCloudClusters(null); }} className={`px-2.5 py-1 rounded-md border ${cloud === c.id ? 'border-cyan-500/70 text-cyan-200 bg-cyan-500/10' : 'border-slate-700 text-slate-400 hover:bg-slate-800'}`}>{c.label}</button>
              ))}
            </div>
            {!cliPresent ? (
              <p className="text-amber-300">The <code className="font-mono">{provider.cli}</code> CLI isn't on your PATH. Install it and sign in ({provider.cli === 'az' ? 'az login' : provider.cli === 'aws' ? 'aws configure / aws sso login' : 'gcloud auth login'}), then come back.</p>
            ) : (
              <>
                <div className="flex gap-2">
                  {provider.needs === 'region' && <input value={cloudOpts.region} onChange={(e) => setCloudOpts({ ...cloudOpts, region: e.target.value })} placeholder="Region, e.g. eu-west-1" className={`${input} flex-1`} />}
                  {provider.needs === 'project' && <input value={cloudOpts.project} onChange={(e) => setCloudOpts({ ...cloudOpts, project: e.target.value })} placeholder="Project (optional)" className={`${input} flex-1`} />}
                  <button onClick={listCloud} disabled={!!busy || (provider.needs === 'region' && !cloudOpts.region.trim())} className="px-3 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-40 flex items-center gap-1.5">
                    {busy === 'cloud-list' && <Loader2 className="w-3.5 h-3.5 animate-spin" />} List my clusters
                  </button>
                </div>
                <p className="text-slate-500">Uses your signed-in {provider.cli} CLI to fetch credentials into your kubeconfig.</p>
                {cloudClusters && (cloudClusters.length === 0 ? <div className="text-slate-500">No clusters found.</div> : (
                  <div className="rounded border border-slate-800 divide-y divide-slate-800/60 max-h-56 overflow-auto">
                    {cloudClusters.map((c) => {
                      const known = (data?.contexts || []).some((k) => k.name === c.name || k.cluster === c.name);
                      return (
                        <div key={`${c.resourceGroup}/${c.name}`} className="px-3 py-1.5 flex items-center gap-2">
                          <span className="font-mono text-slate-200">{c.name}</span>
                          <span className="text-slate-500 font-mono text-[10.5px]">{[c.resourceGroup, c.location].filter(Boolean).join(' · ')}</span>
                          {known ? <span className="ml-auto text-[10.5px] text-emerald-400">in kubeconfig</span> : (
                            <button onClick={() => connect(c)} disabled={!!busy} className="ml-auto px-2 py-0.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white text-[11px] font-semibold flex items-center gap-1 disabled:opacity-40">
                              {busy === `connect:${c.name}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />} Add
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};
