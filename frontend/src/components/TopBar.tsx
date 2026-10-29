import React from 'react';
import { 
  Search, 
  RotateCw, 
  Plus, 
  Terminal, 
  Filter, 
  Layers,
  Radio,
  Sparkles,
  PanelLeftClose,
  PanelLeftOpen
} from 'lucide-react';

interface TopBarProps {
  namespaces: string[];
  selectedNamespace: string;
  onSelectNamespace: (ns: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onOpenCreateModal: () => void;
  onToggleDock: () => void;
  isDockOpen: boolean;
  portForwardsCount?: number;
  onOpenPortForwards?: () => void;
  onOpenSmartLensStudio?: () => void;
  isSmartLensStudioActive?: boolean;
  onToggleSidebar?: () => void;
  isSidebarCollapsed?: boolean;
  /** Extra controls (alerts, workspaces) shown before the Dock toggle */
  extraActions?: React.ReactNode;
}

export const TopBar: React.FC<TopBarProps> = ({
  namespaces,
  selectedNamespace,
  onSelectNamespace,
  searchQuery,
  onSearchChange,
  onRefresh,
  isRefreshing,
  onOpenCreateModal,
  onToggleDock,
  isDockOpen,
  portForwardsCount = 0,
  onOpenPortForwards,
  onOpenSmartLensStudio,
  isSmartLensStudioActive = false,
  onToggleSidebar,
  isSidebarCollapsed = false,
  extraActions,
}) => {
  return (
    // z-40: backdrop-blur makes the header its own stacking context, so without a z-index its
    // dropdowns (workspaces, alerts) would paint underneath the main content
    <header className="relative z-40 h-12 border-b border-slate-800 bg-slate-900/90 backdrop-blur-md px-4 flex items-center justify-between gap-4 select-none shrink-0">
      {/* Left side: Toggle button + Search Input */}
      <div className="flex-1 max-w-md flex items-center gap-2">
        {onToggleSidebar && (
          <button
            onClick={onToggleSidebar}
            className="p-1.5 rounded-lg text-slate-400 hover:text-cyan-300 hover:bg-slate-800/80 transition-colors cursor-pointer shrink-0"
            title={isSidebarCollapsed ? 'Expand Sidebar' : 'Collapse Sidebar'}
            aria-label={isSidebarCollapsed ? 'Expand Sidebar' : 'Collapse Sidebar'}
          >
            {isSidebarCollapsed ? (
              <PanelLeftOpen className="w-4 h-4 text-cyan-400" />
            ) : (
              <PanelLeftClose className="w-4 h-4" />
            )}
          </button>
        )}
        <div className="flex-1 relative">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Filter resources by name, label, or status... (Ctrl+F)"
            className="w-full bg-slate-950/80 border border-slate-800 rounded-md pl-9 pr-3 py-1 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-cyan-500/80 transition-colors"
          />
        </div>
      </div>

      {/* Namespace Filter & Quick Actions */}
      <div className="flex items-center gap-2.5">
        {/* Namespace Filter */}
        <div className="flex items-center gap-1.5 bg-slate-950/80 border border-slate-800 rounded-md px-2.5 py-1">
          <Filter className="w-3 h-3 text-cyan-400" />
          <span className="text-[11px] text-slate-400">Namespace:</span>
          <select
            value={selectedNamespace}
            onChange={(e) => onSelectNamespace(e.target.value)}
            className="bg-transparent text-xs text-slate-200 font-medium focus:outline-none cursor-pointer max-w-[150px] truncate"
          >
            <option value="_all" className="bg-slate-900">All Namespaces</option>
            {namespaces.map((ns) => (
              <option key={ns} value={ns} className="bg-slate-900">
                {ns}
              </option>
            ))}
          </select>
        </div>

        {/* Refresh Button & Loader */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={onRefresh}
            disabled={isRefreshing}
            title="Refresh Resources"
            className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-md border border-slate-800 transition-colors disabled:opacity-50 cursor-pointer"
          >
            <RotateCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-cyan-400' : ''}`} />
          </button>
          {isRefreshing && (
            <span className="flex items-center gap-1 text-[11px] text-cyan-300 bg-cyan-950/80 border border-cyan-800/60 px-2 py-0.5 rounded-full font-medium animate-pulse shadow-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-ping" />
              <span>Loading...</span>
            </span>
          )}
        </div>

        {/* Smart Lens Studio Button */}
        {onOpenSmartLensStudio && (
          <button
            onClick={onOpenSmartLensStudio}
            className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1 rounded-md border transition-all shadow-sm cursor-pointer ${
              isSmartLensStudioActive
                ? 'bg-gradient-to-r from-cyan-500/20 to-indigo-500/20 text-cyan-300 border-cyan-400 shadow-cyan-500/20 ring-1 ring-cyan-500/30'
                : 'bg-slate-950/80 text-slate-300 border-slate-700 hover:border-cyan-500/60 hover:text-cyan-300 hover:bg-slate-800'
            }`}
            title="Open Smart Lens Studio: Dual-namespace comparator & manager"
          >
            <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
            <span className="bg-gradient-to-r from-cyan-300 to-indigo-300 bg-clip-text text-transparent font-bold">
              Smart Lens Studio
            </span>
          </button>
        )}

        {/* Create Resource Button */}
        <button
          onClick={onOpenCreateModal}
          className="flex items-center gap-1.5 bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold px-2.5 py-1 rounded-md transition-colors shadow-sm shadow-cyan-900/30 cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>New Resource</span>
        </button>

        {/* Active Port Forwards Pill */}
        {portForwardsCount > 0 && (
          <button
            onClick={onOpenPortForwards}
            title={`${portForwardsCount} active port forward(s)`}
            className="flex items-center gap-1.5 bg-cyan-950/90 border border-cyan-500/70 text-cyan-300 text-xs font-semibold px-2.5 py-1 rounded-md transition-colors hover:bg-cyan-900/60 cursor-pointer animate-pulse"
          >
            <Radio className="w-3.5 h-3.5 text-cyan-400" />
            <span>{portForwardsCount} Forward{portForwardsCount > 1 ? 's' : ''}</span>
          </button>
        )}

        {extraActions}

        {/* Dock Logs/Editor Toggle */}
        <button
          onClick={onToggleDock}
          className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-md border transition-colors cursor-pointer ${
            isDockOpen
              ? 'bg-slate-800 text-cyan-300 border-cyan-500/50'
              : 'bg-slate-950/80 text-slate-400 border-slate-800 hover:text-slate-200 hover:bg-slate-800'
          }`}
        >
          <Terminal className="w-3.5 h-3.5 text-cyan-400" />
          <span>Dock</span>
        </button>
      </div>
    </header>
  );
};
