import React from 'react';
import { 
  Server, 
  Layers, 
  Box, 
  Cpu, 
  Network, 
  ShieldCheck, 
  FileText, 
  Activity, 
  Database,
  Radio,
  ChevronRight,
  FolderTree,
  Sparkles,
  PanelLeftClose,
  PanelLeftOpen,
  Package,
  Puzzle
} from 'lucide-react';
import { ContextItem } from '../types/k8s';

export const NAV_SECTIONS = [
  {
    title: 'Studio & Cluster',
    items: [
      { id: 'smart-lens-studio', label: '⚡ Smart Lens Studio', icon: Sparkles },
      { id: 'overview', label: 'Overview', icon: Activity },
      { id: 'nodes', label: 'Nodes', icon: Cpu },
      { id: 'events', label: 'Events', icon: Radio },
      { id: 'namespaces', label: 'Namespaces', icon: FolderTree },
    ],
  },
  {
    title: 'Workloads',
    items: [
      { id: 'pods', label: 'Pods', icon: Box },
      { id: 'deployments', label: 'Deployments', icon: Layers },
      { id: 'statefulsets', label: 'StatefulSets', icon: Server },
      { id: 'daemonsets', label: 'DaemonSets', icon: Layers },
      { id: 'jobs', label: 'Jobs & CronJobs', icon: Activity },
    ],
  },
  {
    title: 'Configuration',
    items: [
      { id: 'configmaps', label: 'ConfigMaps', icon: FileText },
      { id: 'secrets', label: 'Secrets', icon: ShieldCheck },
    ],
  },
  {
    title: 'Network & Storage',
    items: [
      { id: 'services', label: 'Services', icon: Network },
      { id: 'ingresses', label: 'Ingresses', icon: Network },
      { id: 'storage', label: 'Storage Classes & PVs', icon: Database },
    ],
  },
  {
    title: 'Apps & Extensions',
    items: [
      { id: 'helm', label: 'Helm Releases', icon: Package },
      { id: 'crds', label: 'Custom Resources', icon: Puzzle },
    ],
  },
];

interface SidebarProps {
  currentView: string;
  onSelectView: (view: string) => void;
  contexts: ContextItem[];
  currentContext: string;
  onSwitchContext: (ctx: string) => void;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentView,
  onSelectView,
  contexts,
  currentContext,
  onSwitchContext,
  isCollapsed = false,
  onToggleCollapse,
}) => {

  return (
    <div 
      className={`bg-slate-900 border-r border-slate-800 flex flex-col h-full shrink-0 select-none transition-all duration-200 ease-in-out ${
        isCollapsed ? 'w-16' : 'w-64'
      }`}
    >
      {/* Brand Header */}
      <div className="p-3 border-b border-slate-800 bg-slate-950/80 flex items-center justify-between">
        {!isCollapsed ? (
          <div className="flex items-center gap-2.5 min-w-0">
            <img 
              src="/logo.png" 
              alt="Kubellens" 
              className="w-8 h-8 rounded-lg shadow-md shadow-cyan-500/20 shrink-0 object-contain bg-slate-900 p-0.5 border border-cyan-800/40"
            />
            <div className="flex flex-col min-w-0">
              <span className="font-bold text-slate-100 text-sm tracking-tight truncate font-sans">
                KUBELLENS
              </span>
              <span className="text-[9px] text-cyan-400 font-semibold tracking-wider uppercase font-mono">
                Lens by ACP
              </span>
            </div>
          </div>
        ) : (
          <img 
            src="/logo.png" 
            alt="Kubellens" 
            className="w-8 h-8 rounded-lg shadow-md shadow-cyan-500/20 mx-auto shrink-0 object-contain bg-slate-900 p-0.5 border border-cyan-800/40 cursor-pointer"
            title="KUBELLENS • Lens by ACP"
            onClick={onToggleCollapse}
          />
        )}
        {onToggleCollapse && !isCollapsed && (
          <button
            onClick={onToggleCollapse}
            className="p-1.5 rounded-lg text-slate-400 hover:text-cyan-300 hover:bg-slate-800/80 transition-colors cursor-pointer ml-auto"
            title="Collapse Sidebar"
            aria-label="Collapse Sidebar"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Cluster / Context Selector Header */}
      <div className="p-3 border-b border-slate-800 bg-slate-900/50">
        <div className="flex items-center justify-between mb-1.5">
          {!isCollapsed && (
            <label className="text-[10px] font-semibold tracking-wider uppercase text-slate-400 flex items-center gap-1.5">
              <span>Connected Context</span>
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            </label>
          )}
          {onToggleCollapse && isCollapsed && (
            <button
              onClick={onToggleCollapse}
              className="p-1.5 rounded-lg text-slate-400 hover:text-cyan-300 hover:bg-slate-800/80 transition-colors cursor-pointer mx-auto"
              title="Expand Sidebar"
              aria-label="Expand Sidebar"
            >
              <PanelLeftOpen className="w-4 h-4 text-cyan-400" />
            </button>
          )}
        </div>

        {!isCollapsed ? (
          <div className="relative mt-1">
            <select 
              value={currentContext}
              onChange={(e) => onSwitchContext(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700/80 rounded-md py-1.5 px-2.5 text-xs text-slate-200 font-medium focus:outline-none focus:border-cyan-500 transition-colors cursor-pointer appearance-none truncate pr-7"
            >
              {contexts.map((ctx) => (
                <option key={ctx.name} value={ctx.name}>
                  {ctx.name} {ctx.name === currentContext ? '✓' : ''}
                </option>
              ))}
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-slate-400">
              <ChevronRight className="w-3.5 h-3.5 rotate-90" />
            </div>
          </div>
        ) : (
          <div className="flex justify-center mt-1">
            <div 
              className="w-8 h-8 rounded-lg bg-slate-950 border border-slate-800 flex items-center justify-center text-cyan-400 font-mono text-xs font-bold"
              title={`Active Context: ${currentContext}`}
            >
              ☸️
            </div>
          </div>
        )}
      </div>

      {/* Navigation List */}
      <div className="flex-1 overflow-y-auto py-2 px-2 space-y-4">
        {NAV_SECTIONS.map((section) => (
          <div key={section.title}>
            {!isCollapsed && (
              <div className="px-2 mb-1 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                {section.title}
              </div>
            )}
            <div className="space-y-0.5">
              {section.items.map((item) => {
                const Icon = item.icon;
                const isActive = currentView === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => onSelectView(item.id)}
                    title={isCollapsed ? item.label : undefined}
                    className={`w-full flex items-center rounded-md text-xs font-medium transition-all ${
                      isCollapsed 
                        ? 'justify-center p-2.5' 
                        : 'gap-2.5 px-2.5 py-1.5'
                    } ${
                      isActive
                        ? 'bg-cyan-500/15 text-cyan-300 font-semibold border-cyan-400 shadow-sm' +
                          (isCollapsed ? ' border' : ' border-l-2 pl-2')
                        : 'text-slate-300 hover:bg-slate-800/60 hover:text-slate-100'
                    }`}
                  >
                    <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-cyan-400' : 'text-slate-400'}`} />
                    {!isCollapsed && <span>{item.label}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Footer Info */}
      <div className="p-3 border-t border-slate-800 text-[11px] text-slate-400 bg-slate-950/40">
        {!isCollapsed ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="font-mono text-cyan-400/90 font-bold tracking-tight">KUBELLENS</span>
              <span className="bg-cyan-950/80 text-cyan-400 border border-cyan-800/50 px-1.5 py-0.5 rounded text-[10px] font-mono">
                v1.2.0 Native
              </span>
            </div>
            <div className="text-[10px] text-slate-500 font-medium truncate" title="Author: Ashutosh Chandra">
              by <span className="text-slate-400 font-semibold">Ashutosh Chandra</span>
            </div>
          </div>
        ) : (
          <img 
            src="/logo.png" 
            alt="Kubellens" 
            className="w-5 h-5 mx-auto opacity-80 hover:opacity-100 transition-opacity" 
            title="KUBELLENS • Developed by Ashutosh Chandra"
          />
        )}
      </div>
    </div>
  );
};
