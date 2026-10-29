import React, { useEffect, useRef, useState } from 'react';
import { Bookmark, BookmarkPlus, Trash2, Check } from 'lucide-react';

export interface Workspace {
  id: string;
  name: string;
  context: string;
  namespace: string;
  view: string;
  search: string;
}

const STORAGE_KEY = 'kubellens_workspaces';

export function loadWorkspaces(): Workspace[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function storeWorkspaces(list: Workspace[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
}

interface WorkspacesMenuProps {
  workspaces: Workspace[];
  current: Omit<Workspace, 'id' | 'name'>;
  viewLabel: (view: string) => string;
  onSave: (name: string) => void;
  onApply: (ws: Workspace) => void;
  onDelete: (id: string) => void;
}

const isSame = (a: Omit<Workspace, 'id' | 'name'>, b: Omit<Workspace, 'id' | 'name'>) =>
  a.context === b.context && a.namespace === b.namespace && a.view === b.view && a.search === b.search;

/** Saved "cluster + namespace + view + filter" combinations, one click to switch. */
export const WorkspacesMenu: React.FC<WorkspacesMenuProps> = ({ workspaces, current, viewLabel, onSave, onApply, onDelete }) => {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const active = workspaces.find((w) => isSame(w, current));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const save = () => {
    const n = name.trim();
    if (!n) return;
    onSave(n);
    setName('');
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-md border transition-colors cursor-pointer max-w-[180px] ${
          active ? 'bg-slate-800 text-cyan-300 border-cyan-500/50' : 'bg-slate-950/80 text-slate-400 border-slate-800 hover:text-slate-200 hover:bg-slate-800'
        }`}
        title="Saved workspaces"
      >
        <Bookmark className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
        <span className="truncate">{active ? active.name : 'Workspaces'}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-9 z-50 w-80 bg-slate-900 border border-slate-700 rounded-lg shadow-2xl overflow-hidden">
          <div className="p-2 border-b border-slate-800">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-1">Save current view</div>
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setOpen(false); }}
                placeholder="e.g. ITAM dev"
                className="flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan-500"
              />
              <button
                onClick={save}
                disabled={!name.trim()}
                className="flex items-center gap-1 px-2 py-1 rounded bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold disabled:opacity-40"
              >
                <BookmarkPlus className="w-3.5 h-3.5" /> Save
              </button>
            </div>
            <div className="mt-1 text-[10px] text-slate-500 truncate font-mono">
              {current.context || 'current cluster'} · {current.namespace === '_all' ? 'all namespaces' : current.namespace} · {viewLabel(current.view)}
              {current.search ? ` · "${current.search}"` : ''}
            </div>
          </div>

          <div className="max-h-72 overflow-auto">
            {workspaces.length === 0 ? (
              <div className="p-3 text-xs text-slate-500">No saved workspaces yet.</div>
            ) : (
              workspaces.map((w) => (
                <div key={w.id} className="group flex items-center gap-2 px-2 py-1.5 hover:bg-slate-800/70 border-b border-slate-800/60">
                  <button onClick={() => { onApply(w); setOpen(false); }} className="flex-1 min-w-0 text-left">
                    <div className="flex items-center gap-1.5 text-xs text-slate-200 font-medium">
                      {active?.id === w.id && <Check className="w-3 h-3 text-cyan-400 shrink-0" />}
                      <span className="truncate">{w.name}</span>
                    </div>
                    <div className="text-[10px] text-slate-500 font-mono truncate">
                      {w.context} · {w.namespace === '_all' ? 'all namespaces' : w.namespace} · {viewLabel(w.view)}{w.search ? ` · "${w.search}"` : ''}
                    </div>
                  </button>
                  <button
                    onClick={() => onDelete(w.id)}
                    className="p-1 rounded text-slate-600 hover:text-rose-400 opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Delete workspace"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
