import React from 'react';

interface ViewLoaderProps {
  label?: string;
}

/** Full-pane loading state used while a view's code chunk or first data fetch is in flight. */
export const ViewLoader: React.FC<ViewLoaderProps> = ({ label = 'Loading…' }) => (
  <div className="h-full w-full flex flex-col p-5 gap-4">
    <div className="flex items-center gap-3">
      <div className="w-5 h-5 rounded-full border-2 border-cyan-500/20 border-t-cyan-400 animate-spin" />
      <span className="text-xs text-slate-400">{label}</span>
    </div>
    {/* Table skeleton so the layout doesn't jump when rows arrive */}
    <div className="rounded-lg border border-slate-800/80 overflow-hidden">
      <div className="h-9 bg-slate-900/80 border-b border-slate-800/80" />
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="h-10 flex items-center gap-4 px-4 border-b border-slate-800/40">
          <div className="h-2.5 rounded bg-slate-800 animate-pulse" style={{ width: `${28 + ((i * 17) % 22)}%` }} />
          <div className="h-2.5 w-[14%] rounded bg-slate-800/70 animate-pulse" />
          <div className="h-2.5 w-[10%] rounded bg-slate-800/50 animate-pulse" />
        </div>
      ))}
    </div>
  </div>
);
