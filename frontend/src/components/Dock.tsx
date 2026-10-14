import React, { useState, useEffect, useRef } from 'react';
import { 
  X, 
  Terminal, 
  FileCode, 
  Download, 
  Trash2, 
  Clock, 
  ArrowDown, 
  Play, 
  CheckCircle, 
  AlertCircle,
  Minimize2,
  Maximize2
} from 'lucide-react';
import { applyManifest } from '../api/client';

// Upper bound on lines kept in memory per log view (oldest lines are dropped first)
const MAX_LOG_LINES = 5000;

export interface DockTask {
  id: string;
  type: 'logs' | 'manifest';
  title: string;
  pod?: string;
  namespace?: string;
  container?: string;
  containers?: string[];
  kind?: string;
  name?: string;
  content?: string;
  context?: string;
}

interface DockProps {
  isOpen: boolean;
  onClose: () => void;
  tasks: DockTask[];
  activeTaskId: string;
  onSelectTask: (id: string) => void;
  onCloseTask: (id: string) => void;
}

export const Dock: React.FC<DockProps> = ({
  isOpen,
  onClose,
  tasks,
  activeTaskId,
  onSelectTask,
  onCloseTask,
}) => {
  const activeTask = tasks.find((t) => t.id === activeTaskId) || tasks[0];

  const [logs, setLogs] = useState<string[]>([]);
  const [isFollowing, setIsFollowing] = useState(true);
  const [showTimestamps, setShowTimestamps] = useState(false);
  const [selectedContainer, setSelectedContainer] = useState<string>('');
  const [logFilter, setLogFilter] = useState('');
  const [isMaximized, setIsMaximized] = useState(false);

  // YAML editor state
  const [yamlContent, setYamlContent] = useState('');
  const [applyStatus, setApplyStatus] = useState<{ success?: boolean; message?: string } | null>(null);
  const [isApplying, setIsApplying] = useState(false);

  const logsEndRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Update container selection and YAML content when active task changes
  useEffect(() => {
    if (!activeTask) return;

    if (activeTask.type === 'manifest') {
      setYamlContent(activeTask.content || '');
      setApplyStatus(null);
    } else if (activeTask.type === 'logs') {
      if (activeTask.container) {
        setSelectedContainer(activeTask.container);
      } else if (activeTask.containers && activeTask.containers.length > 0) {
        setSelectedContainer(activeTask.containers[0]);
      } else {
        setSelectedContainer('');
      }
    }
  }, [activeTask?.id, activeTask?.type, activeTask?.content]);

  // Handle streaming logs via EventSource for active log task
  useEffect(() => {
    if (!isOpen || !activeTask || activeTask.type !== 'logs' || !activeTask.pod || !activeTask.namespace) {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      return;
    }

    setLogs([]);
    const url = new URL('/api/k8s/logs/stream', window.location.origin);
    url.searchParams.set('pod', activeTask.pod);
    url.searchParams.set('namespace', activeTask.namespace);
    if (selectedContainer) url.searchParams.set('container', selectedContainer);
    if (activeTask.context) url.searchParams.set('context', activeTask.context);
    url.searchParams.set('timestamps', showTimestamps ? 'true' : 'false');
    url.searchParams.set('follow', 'true');
    url.searchParams.set('tail', '200');

    const es = new EventSource(url.toString());
    eventSourceRef.current = es;

    // Batch incoming lines and flush once per frame: a chatty pod can emit hundreds of
    // lines a second, and re-rendering per line made the whole window stutter.
    let pending: string[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      const batch = pending;
      pending = [];
      setLogs((prev) => {
        const next = prev.concat(batch);
        // Keep memory bounded on long-running follows
        return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
      });
    };

    es.onmessage = (event) => {
      pending.push(event.data);
      if (!frame) frame = requestAnimationFrame(flush);
    };

    es.onerror = () => {
      es.close();
    };

    return () => {
      if (frame) cancelAnimationFrame(frame);
      es.close();
    };
  }, [isOpen, activeTask?.id, activeTask?.pod, activeTask?.namespace, activeTask?.context, selectedContainer, showTimestamps]);

  // Auto-scroll
  useEffect(() => {
    if (isFollowing && logsEndRef.current) {
      // Instant scroll: smooth scrolling can't keep up with a fast stream and lags behind
      logsEndRef.current.scrollIntoView({ block: 'end' });
    }
  }, [logs, isFollowing]);

  const handleApply = async () => {
    if (!yamlContent.trim()) return;
    setIsApplying(true);
    setApplyStatus(null);
    try {
      const res = await applyManifest(yamlContent, activeTask.context);
      setApplyStatus({ success: true, message: res.output || 'Applied successfully' });
    } catch (err: any) {
      setApplyStatus({ success: false, message: err.message });
    } finally {
      setIsApplying(false);
    }
  };

  const handleDownloadLogs = () => {
    const blob = new Blob([logs.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeTask?.pod || 'logs'}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!isOpen || tasks.length === 0 || !activeTask) return null;

  const filteredLogs = logFilter
    ? logs.filter((l) => l.toLowerCase().includes(logFilter.toLowerCase()))
    : logs;

  return (
    <div 
      className={`border-t border-slate-800 bg-slate-950 flex flex-col z-30 transition-all ${
        isMaximized ? 'h-[75vh]' : 'h-72'
      }`}
    >
      {/* Dock Tabs Header */}
      <div className="h-9 border-b border-slate-800 bg-slate-900/90 px-3 flex items-center justify-between gap-4 select-none shrink-0">
        
        {/* Dynamic Task Tabs */}
        <div className="flex items-center gap-1.5 overflow-x-auto max-w-3xl py-0.5 scrollbar-none">
          {tasks.map((task) => {
            const isActive = task.id === activeTask.id;
            return (
              <div
                key={task.id}
                onClick={() => onSelectTask(task.id)}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium cursor-pointer transition-all border group ${
                  isActive
                    ? 'bg-slate-800 text-cyan-300 font-semibold border-cyan-500/50 shadow-sm'
                    : 'bg-slate-900/60 text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border-slate-800/80'
                }`}
              >
                {task.type === 'logs' ? (
                  <Terminal className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                ) : (
                  <FileCode className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                )}
                <span className="truncate max-w-[200px]" title={task.title}>
                  {task.title}
                </span>

                {/* Individual Close Button for this Task/Process */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTask(task.id);
                  }}
                  title={`Close task: ${task.title}`}
                  className="p-0.5 rounded text-slate-500 hover:text-rose-400 hover:bg-slate-700/80 transition-colors ml-1"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2 shrink-0">
          {activeTask.type === 'logs' && (
            <>
              {/* Container selector */}
              {activeTask.containers && activeTask.containers.length > 1 && (
                <select
                  value={selectedContainer}
                  onChange={(e) => setSelectedContainer(e.target.value)}
                  className="bg-slate-950 border border-slate-800 text-[11px] text-slate-300 rounded px-2 py-0.5"
                >
                  {activeTask.containers.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              )}

              {/* Log filter input */}
              <input
                type="text"
                placeholder="Filter logs..."
                value={logFilter}
                onChange={(e) => setLogFilter(e.target.value)}
                className="bg-slate-950 border border-slate-800 text-[11px] text-slate-200 rounded px-2 py-0.5 w-32 focus:outline-none focus:border-cyan-500"
              />

              {/* Timestamps toggle */}
              <button
                onClick={() => setShowTimestamps(!showTimestamps)}
                className={`p-1 rounded text-slate-400 hover:text-slate-200 ${showTimestamps ? 'text-cyan-400 bg-slate-800' : ''}`}
                title="Toggle Timestamps"
              >
                <Clock className="w-3.5 h-3.5" />
              </button>

              {/* Follow / Auto-scroll toggle */}
              <button
                onClick={() => setIsFollowing(!isFollowing)}
                className={`p-1 rounded text-slate-400 hover:text-slate-200 ${isFollowing ? 'text-cyan-400 bg-slate-800' : ''}`}
                title="Auto-scroll to bottom"
              >
                <ArrowDown className="w-3.5 h-3.5" />
              </button>

              {/* Clear logs */}
              <button
                onClick={() => setLogs([])}
                className="p-1 rounded text-slate-400 hover:text-slate-200"
                title="Clear Logs Console"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>

              {/* Download logs */}
              <button
                onClick={handleDownloadLogs}
                className="p-1 rounded text-slate-400 hover:text-slate-200"
                title="Download Logs"
              >
                <Download className="w-3.5 h-3.5" />
              </button>
            </>
          )}

          {activeTask.type === 'manifest' && (
            <button
              onClick={handleApply}
              disabled={isApplying}
              className="flex items-center gap-1 bg-cyan-600 hover:bg-cyan-500 text-white text-[11px] font-semibold px-2.5 py-0.5 rounded transition-colors disabled:opacity-50"
            >
              <Play className="w-3 h-3 fill-current" />
              <span>{isApplying ? 'Applying...' : 'Apply Manifest'}</span>
            </button>
          )}

          {/* Maximize / Minimize Dock */}
          <button
            onClick={() => setIsMaximized(!isMaximized)}
            className="p-1 rounded text-slate-400 hover:text-slate-200"
            title={isMaximized ? 'Minimize' : 'Maximize'}
          >
            {isMaximized ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>

          {/* Close Entire Dock */}
          <button
            onClick={onClose}
            className="p-1 rounded text-slate-400 hover:text-rose-400 transition-colors"
            title="Close Dock"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Dock Content Body */}
      <div className="flex-1 overflow-hidden relative">
        {activeTask.type === 'logs' && (
          <div className="h-full overflow-auto p-3 font-mono text-xs text-slate-300 leading-relaxed bg-slate-950 selection:bg-cyan-500/30">
            {filteredLogs.length === 0 ? (
              <div className="text-slate-600 italic">Waiting for log stream from {activeTask.pod}...</div>
            ) : (
              filteredLogs.map((line, idx) => (
                <div key={idx} className="hover:bg-slate-900/60 px-1 rounded whitespace-pre-wrap break-all">
                  {line}
                </div>
              ))
            )}
            <div ref={logsEndRef} />
          </div>
        )}

        {activeTask.type === 'manifest' && (
          <div className="h-full flex flex-col">
            {applyStatus && (
              <div className={`px-4 py-1.5 text-xs flex items-center gap-2 ${
                applyStatus.success 
                  ? 'bg-emerald-950/80 text-emerald-300 border-b border-emerald-800' 
                  : 'bg-rose-950/80 text-rose-300 border-b border-rose-800'
              }`}>
                {applyStatus.success ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                <span className="font-mono truncate">{applyStatus.message}</span>
              </div>
            )}
            <textarea
              value={yamlContent}
              onChange={(e) => setYamlContent(e.target.value)}
              className="flex-1 w-full bg-slate-950 p-3 font-mono text-xs text-slate-200 resize-none focus:outline-none selection:bg-cyan-500/30"
              spellCheck={false}
              placeholder="Kubernetes YAML manifest..."
            />
          </div>
        )}
      </div>
    </div>
  );
};
