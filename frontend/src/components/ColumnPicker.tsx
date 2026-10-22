import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Columns3, Check, Lock, RotateCcw } from 'lucide-react';

export interface ColumnDef {
  id: string;
  label: string;
  /** Always shown; listed in the menu but can't be turned off */
  locked?: boolean;
}

const storageKey = (tableId: string) => `kubellens.columns.${tableId}`;

/**
 * Visible-column state for a table, remembered per table in localStorage.
 * Unknown / removed column ids in saved state are ignored, and locked columns
 * are always visible.
 */
export function useColumnVisibility(tableId: string, columns: ColumnDef[], defaults: string[]) {
  const sanitize = useCallback(
    (ids: string[]) => {
      const known = new Set(columns.map((c) => c.id));
      const next = new Set(ids.filter((id) => known.has(id)));
      columns.forEach((c) => c.locked && next.add(c.id));
      return next;
    },
    [columns]
  );

  const [visible, setVisible] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(storageKey(tableId));
      if (saved) return sanitize(JSON.parse(saved));
    } catch {
      /* storage unavailable or corrupt: fall back to defaults */
    }
    return sanitize(defaults);
  });

  const persist = (next: Set<string>) => {
    try {
      localStorage.setItem(storageKey(tableId), JSON.stringify([...next]));
    } catch {
      /* ignore */
    }
  };

  const toggle = (id: string) => {
    if (columns.find((c) => c.id === id)?.locked) return;
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persist(next);
      return next;
    });
  };

  const reset = () => {
    const next = sanitize(defaults);
    setVisible(next);
    try {
      localStorage.removeItem(storageKey(tableId));
    } catch {
      /* ignore */
    }
  };

  const isDefault = visible.size === sanitize(defaults).size && defaults.every((id) => visible.has(id));

  return { visible, show: (id: string) => visible.has(id), toggle, reset, isDefault };
}

interface ColumnPickerProps {
  columns: ColumnDef[];
  visible: Set<string>;
  onToggle: (id: string) => void;
  onReset: () => void;
  isDefault: boolean;
}

/** "Columns" button with a dropdown of checkboxes to show / hide table columns. */
export const ColumnPicker: React.FC<ColumnPickerProps> = ({ columns, visible, onToggle, onReset, isDefault }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const hiddenCount = columns.filter((c) => !visible.has(c.id)).length;

  return (
    <div className="relative select-none" ref={rootRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-medium transition-colors ${
          open ? 'bg-slate-800 border-cyan-600/60 text-cyan-300' : 'bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-slate-100'
        }`}
        title="Show or hide columns"
        aria-expanded={open}
      >
        <Columns3 className="w-3.5 h-3.5" />
        Columns
        {hiddenCount > 0 && <span className="text-slate-500 font-mono">({columns.length - hiddenCount}/{columns.length})</span>}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-40 w-56 rounded-lg border border-slate-700 bg-slate-900 shadow-2xl shadow-black/50 py-1.5" role="menu">
          <div className="px-3 pt-1 pb-2 text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Visible columns</div>
          {columns.map((c) => {
            const on = visible.has(c.id);
            return (
              <button
                key={c.id}
                role="menuitemcheckbox"
                aria-checked={on}
                disabled={c.locked}
                onClick={() => onToggle(c.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-left transition-colors ${
                  c.locked ? 'text-slate-500 cursor-default' : 'text-slate-200 hover:bg-slate-800'
                }`}
              >
                <span
                  className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
                    on ? (c.locked ? 'bg-slate-700 border-slate-600' : 'bg-cyan-500 border-cyan-500') : 'border-slate-600'
                  }`}
                >
                  {on && <Check className="w-2.5 h-2.5 text-slate-950" strokeWidth={3} />}
                </span>
                <span className="flex-1">{c.label}</span>
                {c.locked && <Lock className="w-3 h-3 text-slate-600" />}
              </button>
            );
          })}
          <div className="border-t border-slate-800 mt-1.5 pt-1.5 px-1.5">
            <button
              onClick={onReset}
              disabled={isDefault}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <RotateCcw className="w-3 h-3" /> Reset to default
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
