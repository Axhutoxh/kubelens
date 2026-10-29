import React, { useMemo, useState } from 'react';
import { ChevronRight, ChevronDown, Equal, GitCompare } from 'lucide-react';
import { ConfigMapItem, DeploymentItem } from '../types/k8s';
import { DiffView } from './DiffView';
import { parseImage } from '../views/DeploymentsView';

type Status = 'same' | 'differs' | 'left' | 'right';

const STATUS_STYLE: Record<Status, { label: string; cls: string }> = {
  same: { label: 'Same', cls: 'text-slate-400 border-slate-700 bg-slate-800/60' },
  differs: { label: 'Differs', cls: 'text-amber-300 border-amber-800 bg-amber-950/60' },
  left: { label: 'Only left', cls: 'text-cyan-300 border-cyan-800 bg-cyan-950/60' },
  right: { label: 'Only right', cls: 'text-indigo-300 border-indigo-800 bg-indigo-950/60' },
};

/** The parts of a deployment worth comparing across environments (no status / UIDs / timestamps). */
function comparableSpec(d?: DeploymentItem): string {
  if (!d) return '';
  const pod = d.spec?.template?.spec || {};
  const container = (c: any) => ({
    name: c.name,
    image: c.image,
    command: c.command,
    args: c.args,
    env: c.env,
    envFrom: c.envFrom,
    ports: c.ports,
    resources: c.resources,
  });
  return JSON.stringify(
    {
      replicas: d.spec?.replicas,
      containers: (pod.containers || []).map(container),
      initContainers: pod.initContainers?.map(container),
    },
    null,
    2
  );
}

const tagsOf = (d?: DeploymentItem) =>
  (d?.spec?.template?.spec?.containers || []).map((c) => ({ name: c.name, tag: parseImage(c.image).tag, image: c.image }));

interface Row<T> {
  name: string;
  left?: T;
  right?: T;
  status: Status;
}

function pair<T extends { metadata: { name: string } }>(left: T[], right: T[], equal: (a: T, b: T) => boolean): Row<T>[] {
  const l = new Map(left.map((x) => [x.metadata.name, x]));
  const r = new Map(right.map((x) => [x.metadata.name, x]));
  const names = Array.from(new Set([...l.keys(), ...r.keys()])).sort();
  return names.map((name) => {
    const a = l.get(name);
    const b = r.get(name);
    const status: Status = !a ? 'right' : !b ? 'left' : equal(a, b) ? 'same' : 'differs';
    return { name, left: a, right: b, status };
  });
}

interface StudioDiffProps {
  leftLabel: string;
  rightLabel: string;
  leftDeployments: DeploymentItem[];
  rightDeployments: DeploymentItem[];
  leftConfigMaps: ConfigMapItem[];
  rightConfigMaps: ConfigMapItem[];
  filter: string;
  loading: boolean;
}

/** Side-by-side environment diff: deployment images/specs and ConfigMap contents. */
export const StudioDiff: React.FC<StudioDiffProps> = ({
  leftLabel,
  rightLabel,
  leftDeployments,
  rightDeployments,
  leftConfigMaps,
  rightConfigMaps,
  filter,
  loading,
}) => {
  const [tab, setTab] = useState<'deployments' | 'configmaps'>('deployments');
  const [onlyDiffs, setOnlyDiffs] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const depRows = useMemo(
    () => pair(leftDeployments, rightDeployments, (a, b) => comparableSpec(a) === comparableSpec(b)),
    [leftDeployments, rightDeployments]
  );
  const cmRows = useMemo(
    () => pair(leftConfigMaps, rightConfigMaps, (a, b) => JSON.stringify(a.data || {}) === JSON.stringify(b.data || {})),
    [leftConfigMaps, rightConfigMaps]
  );

  const rows = (tab === 'deployments' ? depRows : cmRows) as Row<any>[];
  const q = filter.trim().toLowerCase();
  const shown = rows.filter((r) => (!onlyDiffs || r.status !== 'same') && (!q || r.name.toLowerCase().includes(q)));
  const counts = (list: Row<any>[]) => ({
    differs: list.filter((r) => r.status === 'differs').length,
    left: list.filter((r) => r.status === 'left').length,
    right: list.filter((r) => r.status === 'right').length,
    same: list.filter((r) => r.status === 'same').length,
  });
  const c = counts(rows);

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-4 py-2 border-b border-slate-800 bg-slate-900/60 flex items-center gap-3 text-xs select-none shrink-0">
        {(['deployments', 'configmaps'] as const).map((t) => {
          const cc = counts((t === 'deployments' ? depRows : cmRows) as Row<any>[]);
          const n = cc.differs + cc.left + cc.right;
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-2.5 py-1 rounded-md font-semibold transition-colors ${
                tab === t ? 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/30' : 'text-slate-400 hover:text-slate-200 border border-transparent'
              }`}
            >
              {t === 'deployments' ? 'Deployments' : 'ConfigMaps'}
              <span className={`ml-1.5 text-[10px] ${n ? 'text-amber-300' : 'text-slate-500'}`}>{n} diff</span>
            </button>
          );
        })}
        <label className="flex items-center gap-1.5 text-slate-400 cursor-pointer ml-2">
          <input type="checkbox" checked={onlyDiffs} onChange={(e) => setOnlyDiffs(e.target.checked)} className="accent-cyan-500" />
          Only differences
        </label>
        <span className="ml-auto text-[11px] text-slate-500">
          <span className="text-amber-300">{c.differs} differ</span> · <span className="text-cyan-300">{c.left} only left</span> ·{' '}
          <span className="text-indigo-300">{c.right} only right</span> · {c.same} same
        </span>
      </div>

      <div className="px-4 py-1.5 border-b border-slate-800 grid grid-cols-[1.2fr_1fr_1fr_90px] gap-3 text-[10px] uppercase tracking-wide text-slate-500 font-semibold shrink-0">
        <span>Name</span>
        <span className="text-cyan-400 truncate" title={leftLabel}>Left · {leftLabel}</span>
        <span className="text-indigo-400 truncate" title={rightLabel}>Right · {rightLabel}</span>
        <span>Status</span>
      </div>

      <div className="flex-1 overflow-auto select-text">
        {loading && rows.length === 0 ? (
          <div className="p-6 text-xs text-slate-500">Loading both sides…</div>
        ) : shown.length === 0 ? (
          <div className="p-6 text-xs text-slate-500 flex items-center gap-2">
            <Equal className="w-4 h-4" /> {rows.length === 0 ? 'Nothing to compare.' : 'No differences.'}
          </div>
        ) : (
          shown.map((r) => {
            const key = `${tab}:${r.name}`;
            const open = expanded.has(key);
            const canExpand = r.status !== 'same';
            return (
              <div key={key} className="border-b border-slate-800/70">
                <button
                  onClick={() => canExpand && toggle(key)}
                  className={`w-full px-4 py-2 grid grid-cols-[1.2fr_1fr_1fr_90px] gap-3 text-left text-xs items-start ${canExpand ? 'hover:bg-slate-900/70 cursor-pointer' : 'cursor-default'}`}
                >
                  <span className="flex items-center gap-1 font-mono text-slate-100 min-w-0">
                    {canExpand ? (open ? <ChevronDown className="w-3.5 h-3.5 shrink-0 text-slate-500" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0 text-slate-500" />) : <span className="w-3.5 shrink-0" />}
                    <span className="truncate">{r.name}</span>
                  </span>
                  {tab === 'deployments' ? (
                    <>
                      <TagList items={tagsOf(r.left)} other={tagsOf(r.right)} />
                      <TagList items={tagsOf(r.right)} other={tagsOf(r.left)} />
                    </>
                  ) : (
                    <>
                      <span className="text-slate-400 font-mono text-[11px]">{r.left ? `${Object.keys(r.left.data || {}).length} keys` : '—'}</span>
                      <span className="text-slate-400 font-mono text-[11px]">{r.right ? `${Object.keys(r.right.data || {}).length} keys` : '—'}</span>
                    </>
                  )}
                  <span>
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${STATUS_STYLE[r.status as Status].cls}`}>
                      {STATUS_STYLE[r.status as Status].label}
                    </span>
                  </span>
                </button>
                {open && (
                  <div className="px-4 pb-3">
                    {tab === 'deployments' ? (
                      <DiffView before={comparableSpec(r.left)} after={comparableSpec(r.right)} className="max-h-96" />
                    ) : (
                      <ConfigMapKeyDiff left={r.left} right={r.right} />
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

const TagList: React.FC<{ items: Array<{ name: string; tag: string; image: string }>; other: Array<{ name: string; tag: string }> }> = ({ items, other }) => {
  if (items.length === 0) return <span className="text-slate-600">—</span>;
  return (
    <span className="flex flex-col gap-0.5 min-w-0">
      {items.map((it) => {
        const counterpart = other.find((o) => o.name === it.name);
        const differs = counterpart ? counterpart.tag !== it.tag : other.length > 0;
        return (
          <span key={it.name} className="flex items-center gap-1 text-[11px] font-mono min-w-0" title={it.image}>
            {items.length > 1 && <span className="text-slate-500 shrink-0">{it.name}:</span>}
            <span className={`truncate ${differs ? 'text-amber-300 font-semibold' : 'text-slate-300'}`}>{it.tag}</span>
          </span>
        );
      })}
    </span>
  );
};

const ConfigMapKeyDiff: React.FC<{ left?: ConfigMapItem; right?: ConfigMapItem }> = ({ left, right }) => {
  const a = left?.data || {};
  const b = right?.data || {};
  const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort().filter((k) => a[k] !== b[k]);
  if (keys.length === 0) return <div className="text-[11px] text-slate-500">Data is identical.</div>;
  return (
    <div className="space-y-2">
      {keys.map((k) => (
        <div key={k} className="space-y-1">
          <div className="flex items-center gap-2 text-[11px]">
            <GitCompare className="w-3 h-3 text-slate-500" />
            <span className="font-mono text-cyan-300">{k}</span>
            <span className="text-slate-500">{a[k] === undefined ? 'only right' : b[k] === undefined ? 'only left' : 'changed'}</span>
          </div>
          <DiffView before={a[k] ?? ''} after={b[k] ?? ''} className="max-h-72" />
        </div>
      ))}
    </div>
  );
};
