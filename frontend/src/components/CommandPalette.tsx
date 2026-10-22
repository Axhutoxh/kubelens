import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Box, Layers, Network, Compass, Zap, Globe, FolderTree, CornerDownLeft } from 'lucide-react';
import { fetchK8sResource } from '../api/client';
import { PodItem } from '../types/k8s';

export interface PaletteView {
  id: string;
  label: string;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  views: PaletteView[];
  contexts: string[];
  currentContext: string;
  namespaces: string[];
  selectedNamespace: string;
  onNavigate: (view: string, search?: string) => void;
  onSwitchContext: (ctx: string) => void;
  onSelectNamespace: (ns: string) => void;
  onOpenPod: (pod: PodItem) => void;
  actions: Array<{ id: string; label: string; hint?: string; run: () => void }>;
}

interface Item {
  key: string;
  group: string;
  label: string;
  detail?: string;
  icon: React.ReactNode;
  run: () => void;
}

/** Subsequence fuzzy match; returns a score (higher is better) or -1 for no match. */
function fuzzyScore(text: string, query: string): number {
  if (!query) return 0;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  const idx = t.indexOf(q);
  if (idx >= 0) return 1000 - idx * 2 - (t.length - q.length) * 0.1; // contiguous match wins
  let ti = 0, score = 0, streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 5 - (found - ti);
    ti = found + 1;
  }
  return score;
}

const MAX_RESULTS = 60;

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  views,
  contexts,
  currentContext,
  namespaces,
  selectedNamespace,
  onNavigate,
  onSwitchContext,
  onSelectNamespace,
  onOpenPod,
  actions,
}) => {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [resources, setResources] = useState<{ pods: PodItem[]; deployments: any[]; services: any[] }>({ pods: [], deployments: [], services: [] });
  const [loadingResources, setLoadingResources] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Fresh resource list each time the palette opens (backend cache makes this cheap)
  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setActive(0);
    requestAnimationFrame(() => inputRef.current?.focus());
    let cancelled = false;
    setLoadingResources(true);
    Promise.allSettled([
      fetchK8sResource<PodItem>('pods', selectedNamespace),
      fetchK8sResource('deployments', selectedNamespace),
      fetchK8sResource('services', selectedNamespace),
    ]).then(([p, d, s]) => {
      if (cancelled) return;
      setResources({
        pods: p.status === 'fulfilled' ? p.value.items || [] : [],
        deployments: d.status === 'fulfilled' ? d.value.items || [] : [],
        services: s.status === 'fulfilled' ? s.value.items || [] : [],
      });
      setLoadingResources(false);
    });
    return () => { cancelled = true; };
  }, [isOpen, selectedNamespace]);

  const allItems: Item[] = useMemo(() => {
    const icon = (C: any, cls: string) => <C className={`w-3.5 h-3.5 ${cls}`} />;
    return [
      ...actions.map((a) => ({ key: `a:${a.id}`, group: 'Actions', label: a.label, detail: a.hint, icon: icon(Zap, 'text-amber-400'), run: a.run })),
      ...views.map((v) => ({ key: `v:${v.id}`, group: 'Go to', label: v.label, icon: icon(Compass, 'text-cyan-400'), run: () => onNavigate(v.id) })),
      ...resources.pods.map((p) => ({
        key: `p:${p.metadata.namespace}/${p.metadata.name}`,
        group: 'Pods',
        label: p.metadata.name,
        detail: `${p.metadata.namespace} · ${p.status.phase}`,
        icon: icon(Box, 'text-cyan-300'),
        run: () => onOpenPod(p),
      })),
      ...resources.deployments.map((d) => ({
        key: `d:${d.metadata.namespace}/${d.metadata.name}`,
        group: 'Deployments',
        label: d.metadata.name,
        detail: d.metadata.namespace,
        icon: icon(Layers, 'text-blue-300'),
        run: () => onNavigate('deployments', d.metadata.name),
      })),
      ...resources.services.map((s) => ({
        key: `s:${s.metadata.namespace}/${s.metadata.name}`,
        group: 'Services',
        label: s.metadata.name,
        detail: s.metadata.namespace,
        icon: icon(Network, 'text-teal-300'),
        run: () => onNavigate('services', s.metadata.name),
      })),
      ...contexts.map((c) => ({
        key: `c:${c}`,
        group: 'Switch context',
        label: c,
        detail: c === currentContext ? 'current' : undefined,
        icon: icon(Globe, 'text-emerald-400'),
        run: () => onSwitchContext(c),
      })),
      ...['_all', ...namespaces].map((ns) => ({
        key: `n:${ns}`,
        group: 'Namespace',
        label: ns === '_all' ? 'All namespaces' : ns,
        detail: ns === selectedNamespace ? 'current' : undefined,
        icon: icon(FolderTree, 'text-violet-400'),
        run: () => onSelectNamespace(ns),
      })),
    ];
  }, [actions, views, resources, contexts, currentContext, namespaces, selectedNamespace, onNavigate, onOpenPod, onSwitchContext, onSelectNamespace]);

  const results = useMemo(() => {
    if (!query.trim()) {
      // Without a query show the most useful groups, not thousands of pods
      return allItems.filter((i) => i.group === 'Actions' || i.group === 'Go to');
    }
    const scored = allItems
      .map((item) => ({ item, score: Math.max(fuzzyScore(item.label, query), fuzzyScore(`${item.group} ${item.label}`, query) - 50) }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS);
    // Keep each group together (ordered by its best match) so headers aren't repeated
    const groupRank = new Map<string, number>();
    scored.forEach((r, i) => { if (!groupRank.has(r.item.group)) groupRank.set(r.item.group, i); });
    return scored
      .map((r, i) => ({ ...r, i }))
      .sort((a, b) => groupRank.get(a.item.group)! - groupRank.get(b.item.group)! || a.i - b.i)
      .map((r) => r.item);
  }, [allItems, query]);

  useEffect(() => { setActive(0); }, [query]);

  // Keep the highlighted row in view
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!isOpen) return null;

  const choose = (item?: Item) => {
    if (!item) return;
    onClose();
    item.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(results.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(results[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  let lastGroup = '';

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh] bg-slate-950/60 backdrop-blur-sm" onMouseDown={onClose} role="dialog">
      <div
        className="w-full max-w-xl bg-slate-900 border border-slate-700 rounded-xl shadow-2xl shadow-cyan-950/50 overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2.5 px-4 border-b border-slate-800">
          <Search className="w-4 h-4 text-slate-500" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pods, deployments, views, contexts…"
            className="flex-1 bg-transparent py-3.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
          />
          {loadingResources && <span className="text-[10px] text-slate-500">loading…</span>}
          <kbd className="text-[10px] text-slate-500 border border-slate-700 rounded px-1.5 py-0.5">Esc</kbd>
        </div>
        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-1.5">
          {results.length === 0 && <div className="px-4 py-6 text-center text-xs text-slate-500">No matches for “{query}”.</div>}
          {results.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <React.Fragment key={item.key}>
                {header && <div className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-wider text-slate-500 font-semibold">{header}</div>}
                <button
                  data-index={i}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(item)}
                  className={`w-full flex items-center gap-2.5 px-4 py-2 text-left text-xs transition-colors ${
                    i === active ? 'bg-cyan-500/15 text-slate-100' : 'text-slate-300'
                  }`}
                >
                  {item.icon}
                  <span className="truncate font-medium">{item.label}</span>
                  {item.detail && <span className="truncate text-[11px] text-slate-500">{item.detail}</span>}
                  {i === active && <CornerDownLeft className="w-3 h-3 text-slate-500 ml-auto shrink-0" />}
                </button>
              </React.Fragment>
            );
          })}
        </div>
        <div className="px-4 py-2 border-t border-slate-800 text-[10px] text-slate-500 flex gap-4">
          <span><kbd className="font-mono">↑↓</kbd> navigate</span>
          <span><kbd className="font-mono">Enter</kbd> open</span>
          <span><kbd className="font-mono">Ctrl+K</kbd> toggle</span>
        </div>
      </div>
    </div>
  );
};
