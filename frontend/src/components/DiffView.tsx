import React, { useMemo } from 'react';
import { diffLines, withContext } from '../utils/diff';

interface DiffViewProps {
  before: string;
  after: string;
  /** Unchanged lines kept around each change; Infinity shows everything */
  context?: number;
  className?: string;
}

/** Unified line diff: red "-" for removed lines, green "+" for added ones. */
export const DiffView: React.FC<DiffViewProps> = ({ before, after, context = 3, className = '' }) => {
  const rows = useMemo(() => {
    const ops = diffLines(before, after);
    return Number.isFinite(context) ? withContext(ops, context) : ops;
  }, [before, after, context]);

  if (before === after) {
    return <div className={`text-[11px] text-slate-500 italic ${className}`}>No changes</div>;
  }

  return (
    <pre className={`font-mono text-[11px] leading-relaxed overflow-auto rounded-md border border-slate-800 bg-slate-950 py-1 select-text ${className}`}>
      {rows.map((op, idx) =>
        op === null ? (
          <div key={idx} className="px-2 text-slate-600 bg-slate-900/60 select-none">⋯</div>
        ) : (
          <div
            key={idx}
            className={`px-2 whitespace-pre-wrap break-all ${
              op.type === 'add' ? 'bg-emerald-950/60 text-emerald-300' : op.type === 'del' ? 'bg-rose-950/60 text-rose-300' : 'text-slate-400'
            }`}
          >
            <span className="select-none inline-block w-3 text-slate-600">{op.type === 'add' ? '+' : op.type === 'del' ? '-' : ' '}</span>
            {op.text || ' '}
          </div>
        )
      )}
    </pre>
  );
};
