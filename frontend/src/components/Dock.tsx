import React, { useState, useEffect, useRef, useMemo, lazy, Suspense } from 'react';
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
  Maximize2,
  SquareTerminal,
  Rows3,
  RotateCcw,
  Regex,
  Braces,
  History,
  Search,
  Bookmark,
  BookmarkCheck,
  Filter
} from 'lucide-react';
import { applyManifest, multiLogsUrl, saveTextFile } from '../api/client';
import { FindBar, HighlightTextarea, findMatches } from './FindInText';
import {
  LogBookmark,
  SavedLogFilter,
  inWorkspace,
  linePod,
  loadBookmarks,
  loadLogFilters,
  logText,
  storeBookmarks,
  storeLogFilters,
} from '../utils/logBookmarks';
import { LEVEL_RANK, LogLevel, compileFilter, logLevel, podColor as colorFor, prettyJson, splitMatches } from '../utils/logs';

// xterm.js is only downloaded the first time a shell is opened
const ShellTerminal = lazy(() => import('./ShellTerminal'));

// Upper bound on lines kept in memory per log view (oldest lines are dropped first)
const MAX_LOG_LINES = 5000;
const EMPTY_LOGS = { lines: [] as string[], dropped: 0 };

const SINCE_OPTIONS: Array<[string, string]> = [
  ['', 'Last 200 lines'],
  ['5m', 'Last 5 min'],
  ['15m', 'Last 15 min'],
  ['1h', 'Last 1 hour'],
  ['6h', 'Last 6 hours'],
  ['24h', 'Last 24 hours'],
];

export interface DockTask {
  id: string;
  type: 'logs' | 'manifest' | 'shell' | 'multilogs';
  title: string;
  pod?: string;
  namespace?: string;
  container?: string;
  containers?: string[];
  kind?: string;
  name?: string;
  content?: string;
  context?: string;
  /** multilogs: explicit pods to merge */
  targets?: Array<{ name: string; namespace: string }>;
  /** multilogs: label selector (with `namespace`) instead of explicit pods */
  selector?: string;
  /** shell: bumped to reconnect */
  sessionKey?: number;
}

interface DockProps {
  isOpen: boolean;
  onClose: () => void;
  tasks: DockTask[];
  activeTaskId: string;
  onSelectTask: (id: string) => void;
  onCloseTask: (id: string) => void;
  onUpdateTask?: (id: string, patch: Partial<DockTask>) => void;
  onToast?: (message: string, type?: 'success' | 'error') => void;
  /** Workspace that saved filters and bookmarks belong to (null: none active) */
  workspace?: { id: string; name: string } | null;
  /** Opens a pod's log tab (used to jump to a bookmarked line) */
  onOpenLogs?: (pod: string, namespace: string, containers: string[], context?: string) => void;
}

// `kubectl logs --prefix` lines look like "[pod/<name>/<container>] message"
const PREFIX_RE = /^\[pod\/([^/\]]+)\/([^\]]+)\] ?(.*)$/;

const LEVEL_CLASSES: Record<NonNullable<LogLevel>, string> = {
  error: 'text-rose-300 border-l-2 border-rose-500/70 bg-rose-950/20',
  warn: 'text-amber-200 border-l-2 border-amber-500/60',
  debug: 'text-slate-500',
};

interface LogLineProps {
  line: string;
  lineKey: number;
  level: LogLevel;
  combined: boolean;
  highlight: RegExp | null;
  pretty: boolean;
  bookmarked: boolean;
  flash: boolean;
  onBookmark: (line: string) => void;
}

const Highlighted: React.FC<{ text: string; re: RegExp | null }> = ({ text, re }) => (
  <>
    {splitMatches(text, re).map((part, i) =>
      i % 2 ? <mark key={i} className="bg-cyan-400/30 text-inherit rounded-sm">{part}</mark> : part
    )}
  </>
);

// Memoised: with stable keys, a new batch of lines only renders the new rows
const LogLine = React.memo<LogLineProps>(({ line, lineKey, level, combined, highlight, pretty, bookmarked, flash, onBookmark }) => {
  const base = `group relative hover:bg-slate-900/60 px-1 pr-6 rounded whitespace-pre-wrap break-all ${level ? LEVEL_CLASSES[level] : ''} ${
    flash ? 'ring-1 ring-cyan-400 bg-cyan-500/15' : bookmarked ? 'bg-cyan-950/30' : ''
  }`;
  if (line.startsWith('[kubellens]')) {
    return <div className="px-1 text-amber-400/90 whitespace-pre-wrap break-all">{line}</div>;
  }
  let prefix: React.ReactNode = null;
  let message = line;
  if (combined) {
    const m = PREFIX_RE.exec(line);
    if (m) {
      prefix = (
        <>
          <span className={`${colorFor(m[1])} font-semibold`}>{m[1]}</span>
          <span className="text-slate-600">/{m[2]} </span>
        </>
      );
      message = m[3];
    }
  }
  const shown = (pretty && prettyJson(message)) || message;
  return (
    <div className={base} data-logkey={lineKey}>
      {prefix}
      <Highlighted text={shown} re={highlight} />
      <button
        onClick={() => onBookmark(line)}
        title={bookmarked ? 'Remove bookmark' : 'Bookmark this line'}
        className={`absolute right-1 top-0.5 p-0.5 rounded ${bookmarked ? 'text-cyan-300' : 'text-slate-600 opacity-0 group-hover:opacity-100 hover:text-cyan-300'}`}
      >
        {bookmarked ? <BookmarkCheck className="w-3 h-3" /> : <Bookmark className="w-3 h-3" />}
      </button>
    </div>
  );
});

export const Dock: React.FC<DockProps> = ({
  isOpen,
  onClose,
  tasks,
  activeTaskId,
  onSelectTask,
  onCloseTask,
  onUpdateTask,
  onToast,
  workspace = null,
  onOpenLogs,
}) => {
  const activeTask = tasks.find((t) => t.id === activeTaskId) || tasks[0];

  // `dropped` counts lines trimmed off the front so each line keeps a stable React key;
  // index keys would rewrite every row once the buffer is full and wipe the user's selection
  const [logBuf, setLogBuf] = useState<{ lines: string[]; dropped: number }>(EMPTY_LOGS);
  const logs = logBuf.lines;
  const [isFollowing, setIsFollowing] = useState(true);
  const [showTimestamps, setShowTimestamps] = useState(false);
  const [selectedContainer, setSelectedContainer] = useState<string>('');
  const [logFilter, setLogFilter] = useState('');
  const [useRegex, setUseRegex] = useState(false);
  const [levelFilter, setLevelFilter] = useState<'all' | 'warn' | 'error'>('all');
  const [prettyJsonLines, setPrettyJsonLines] = useState(false);
  const [showPrevious, setShowPrevious] = useState(false);
  const [since, setSince] = useState('');
  const [isMaximized, setIsMaximized] = useState(false);

  // YAML editor state
  const [yamlContent, setYamlContent] = useState('');
  const [applyStatus, setApplyStatus] = useState<{ success?: boolean; message?: string } | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const [yamlFindOpen, setYamlFindOpen] = useState(false);
  const [yamlQuery, setYamlQuery] = useState('');
  const [yamlCase, setYamlCase] = useState(false);
  const [yamlActive, setYamlActive] = useState(0);

  const logsEndRef = useRef<HTMLDivElement>(null);
  const logFilterRef = useRef<HTMLInputElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Update container selection and YAML content when active task changes
  useEffect(() => {
    if (!activeTask) return;

    if (activeTask.type === 'manifest') {
      setYamlContent(activeTask.content || '');
      setApplyStatus(null);
    } else if (activeTask.type === 'logs') {
      setShowPrevious(false);
      if (activeTask.container) {
        setSelectedContainer(activeTask.container);
      } else if (activeTask.containers && activeTask.containers.length > 0) {
        setSelectedContainer(activeTask.containers[0]);
      } else {
        setSelectedContainer('');
      }
    }
  }, [activeTask?.id, activeTask?.type, activeTask?.content]);

  // Handle streaming logs via EventSource for the active log / combined-log task
  useEffect(() => {
    const isSingle = activeTask?.type === 'logs' && !!activeTask.pod && !!activeTask.namespace;
    const isMulti = activeTask?.type === 'multilogs' && (!!activeTask.targets?.length || !!activeTask.selector);
    if (!isOpen || !activeTask || (!isSingle && !isMulti)) {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      return;
    }

    setLogBuf(EMPTY_LOGS);
    let streamUrl: string;
    if (isMulti) {
      streamUrl = multiLogsUrl({
        pods: activeTask.targets,
        selector: activeTask.selector,
        namespace: activeTask.namespace,
        context: activeTask.context,
      });
    } else {
      const url = new URL('/api/k8s/logs/stream', window.location.origin);
      url.searchParams.set('pod', activeTask.pod!);
      url.searchParams.set('namespace', activeTask.namespace!);
      if (selectedContainer) url.searchParams.set('container', selectedContainer);
      if (activeTask.context) url.searchParams.set('context', activeTask.context);
      url.searchParams.set('timestamps', showTimestamps ? 'true' : 'false');
      url.searchParams.set('follow', showPrevious ? 'false' : 'true');
      if (showPrevious) url.searchParams.set('previous', 'true');
      if (since) {
        url.searchParams.set('since', since);
        // The whole window, not just its last 200 lines (the buffer cap still applies)
        url.searchParams.set('tail', '-1');
      } else {
        url.searchParams.set('tail', '200');
      }
      streamUrl = url.toString();
    }

    const es = new EventSource(streamUrl);
    eventSourceRef.current = es;

    // Batch incoming lines and flush once per frame: a chatty pod can emit hundreds of
    // lines a second, and re-rendering per line made the whole window stutter.
    let pending: string[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      const batch = pending;
      pending = [];
      setLogBuf((prev) => {
        const next = prev.lines.concat(batch);
        // Keep memory bounded on long-running follows
        if (next.length <= MAX_LOG_LINES) return { lines: next, dropped: prev.dropped };
        const excess = next.length - MAX_LOG_LINES;
        return { lines: next.slice(excess), dropped: prev.dropped + excess };
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
  }, [isOpen, activeTask?.id, activeTask?.type, activeTask?.pod, activeTask?.namespace, activeTask?.context, activeTask?.targets, activeTask?.selector, selectedContainer, showTimestamps, showPrevious, since]);

  // Auto-scroll
  useEffect(() => {
    if (isFollowing && logsEndRef.current) {
      // Don't yank the view away while the user is selecting text in the log pane
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && logsEndRef.current.parentElement?.contains(sel.anchorNode)) return;
      // Instant scroll: smooth scrolling can't keep up with a fast stream and lags behind
      logsEndRef.current.scrollIntoView({ block: 'end' });
    }
  }, [logs, isFollowing]);

  const filter = useMemo(() => compileFilter(logFilter, useRegex), [logFilter, useRegex]);

  // Severity per line is computed once per line, not on every render
  const levelCache = useRef(new Map<number, LogLevel>());
  useEffect(() => { levelCache.current = new Map(); }, [activeTask?.id, showPrevious, since, selectedContainer]);
  const visibleLogs = useMemo(() => {
    const cache = levelCache.current;
    const keepLevel = LEVEL_RANK[levelFilter];
    const out: Array<{ line: string; key: number; level: LogLevel }> = [];
    logs.forEach((line, i) => {
      const key = logBuf.dropped + i;
      let level = cache.get(key);
      if (level === undefined) {
        level = logLevel(line);
        cache.set(key, level);
      }
      // The app's own notices (kubectl errors, stream ended) are never filtered away
      const notice = line.startsWith('[kubellens]');
      if (!notice && !keepLevel(level)) return;
      if (!notice && filter.test && !filter.test.test(line)) return;
      out.push({ line, key, level });
    });
    // Forget levels of lines that fell out of the buffer
    if (cache.size > MAX_LOG_LINES * 2) {
      for (const k of cache.keys()) if (k < logBuf.dropped) cache.delete(k);
    }
    return out;
  }, [logs, logBuf.dropped, filter, levelFilter]);

  // Saved filters and bookmarked lines (per workspace)
  const workspaceId = workspace?.id ?? null;
  const [savedFilters, setSavedFilters] = useState<SavedLogFilter[]>(loadLogFilters);
  const [bookmarks, setBookmarks] = useState<LogBookmark[]>(loadBookmarks);
  const [savedOpen, setSavedOpen] = useState(false);
  const [filterName, setFilterName] = useState('');
  const [jump, setJump] = useState<{ text: string; until: number } | null>(null);
  const [flashKey, setFlashKey] = useState<number | null>(null);
  const savedMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!savedOpen) return;
    const onDown = (e: MouseEvent) => {
      if (savedMenuRef.current && !savedMenuRef.current.contains(e.target as Node)) setSavedOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [savedOpen]);

  const scopedFilters = savedFilters.filter((f) => inWorkspace(f.workspaceId, workspaceId));
  const scopedBookmarks = bookmarks.filter((b) => inWorkspace(b.workspaceId, workspaceId)).slice().reverse();

  const saveFilter = () => {
    const name = filterName.trim();
    if (!name) return;
    const entry: SavedLogFilter = { id: `lf-${Date.now()}`, name, workspaceId, filter: logFilter, regex: useRegex, level: levelFilter, pretty: prettyJsonLines };
    const next = [...savedFilters.filter((f) => !(f.name === name && f.workspaceId === workspaceId)), entry];
    setSavedFilters(next);
    storeLogFilters(next);
    setFilterName('');
    onToast?.(`Saved filter "${name}"${workspace ? ` in workspace ${workspace.name}` : ''}`);
  };
  const applySavedFilter = (f: SavedLogFilter) => {
    setLogFilter(f.filter);
    setUseRegex(f.regex);
    setLevelFilter(f.level);
    setPrettyJsonLines(f.pretty);
    setSavedOpen(false);
  };
  const deleteFilter = (id: string) => {
    const next = savedFilters.filter((f) => f.id !== id);
    setSavedFilters(next);
    storeLogFilters(next);
  };

  // Pod / container a line belongs to in the active tab
  const lineOwner = (line: string) => {
    if (!activeTask) return null;
    if (activeTask.type === 'multilogs') {
      const p = linePod(line);
      if (!p) return null;
      const ns = activeTask.targets?.find((t) => t.name === p.pod)?.namespace || activeTask.namespace || 'default';
      return { pod: p.pod, container: p.container, namespace: ns };
    }
    if (activeTask.type === 'logs' && activeTask.pod && activeTask.namespace) {
      return { pod: activeTask.pod, container: selectedContainer, namespace: activeTask.namespace };
    }
    return null;
  };
  const toggleBookmark = (line: string) => {
    const owner = lineOwner(line);
    if (!owner) return;
    const text = logText(line);
    const ctx = activeTask?.context || '';
    const existing = bookmarks.find((b) => b.pod === owner.pod && b.namespace === owner.namespace && b.text === text && (b.context || '') === ctx);
    const next = existing
      ? bookmarks.filter((b) => b !== existing)
      : [...bookmarks, { id: `bm-${Date.now()}`, workspaceId, context: activeTask?.context, namespace: owner.namespace, pod: owner.pod, container: owner.container || undefined, text, savedAt: Date.now() }];
    setBookmarks(next);
    storeBookmarks(next);
  };
  // Stable for the memoised log lines
  const toggleBookmarkRef = useRef(toggleBookmark);
  toggleBookmarkRef.current = toggleBookmark;
  const onBookmarkLine = React.useCallback((line: string) => toggleBookmarkRef.current(line), []);

  const bookmarkedKeys = useMemo(
    () => new Set(bookmarks.filter((b) => (b.context || '') === (activeTask?.context || '')).map((b) => `${b.pod}|${b.text}`)),
    [bookmarks, activeTask?.context]
  );
  const isBookmarked = (line: string) => {
    if (bookmarkedKeys.size === 0) return false;
    const owner = activeTask?.type === 'multilogs' ? linePod(line)?.pod : activeTask?.pod;
    return !!owner && bookmarkedKeys.has(`${owner}|${logText(line)}`);
  };

  const removeBookmark = (id: string) => {
    const next = bookmarks.filter((b) => b.id !== id);
    setBookmarks(next);
    storeBookmarks(next);
  };
  const openBookmark = (b: LogBookmark) => {
    setSavedOpen(false);
    setLogFilter('');
    setLevelFilter('all');
    const taskId = `logs-${b.context || 'default'}-${b.namespace}-${b.pod}`;
    if (activeTask?.id === taskId) {
      if (b.container) setSelectedContainer(b.container);
    } else if (tasks.some((t) => t.id === taskId)) {
      if (b.container) onUpdateTask?.(taskId, { container: b.container });
      onSelectTask(taskId);
    } else if (onOpenLogs) {
      onOpenLogs(b.pod, b.namespace, b.container ? [b.container] : [], b.context);
    }
    // Look further back than the default 200 lines
    setSince('24h');
    setJump({ text: b.text, until: Date.now() + 10000 });
  };

  // Scroll to a bookmarked line once the stream has delivered it
  useEffect(() => {
    if (!jump) return;
    const hit = visibleLogs.find((v) => logText(v.line) === jump.text);
    if (hit) {
      setIsFollowing(false);
      setFlashKey(hit.key);
      setJump(null);
      requestAnimationFrame(() => document.querySelector(`[data-logkey="${hit.key}"]`)?.scrollIntoView({ block: 'center' }));
      const t = setTimeout(() => setFlashKey(null), 2500);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => {
      setJump(null);
      onToast?.('That line is no longer in the pod\'s logs (pod replaced or logs rotated)', 'error');
    }, Math.max(0, jump.until - Date.now()));
    return () => clearTimeout(t);
  }, [jump, visibleLogs]);

  const yamlMatches = useMemo(() => findMatches(yamlContent, yamlQuery, { caseSensitive: yamlCase }).length, [yamlContent, yamlQuery, yamlCase]);
  useEffect(() => setYamlActive(0), [yamlQuery, yamlCase]);

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

  const handleDownloadLogs = async () => {
    if (logs.length === 0) {
      onToast?.('No log lines to download yet', 'error');
      return;
    }
    const base = activeTask?.pod || activeTask?.title.replace(/[^a-z0-9-]+/gi, '_') || 'logs';
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    try {
      const path = await saveTextFile(`${base}${showPrevious ? '_previous' : ''}_${stamp}.log`, logs.join('\n') + '\n');
      onToast?.(path ? `Saved ${logs.length} lines to ${path}` : `Downloading ${logs.length} lines`);
    } catch (err: any) {
      onToast?.(`Download failed: ${err.message}`, 'error');
    }
  };

  const shellTasks = tasks.filter((t) => t.type === 'shell');
  // With live shells the dock stays mounted (just hidden) so closing the panel
  // doesn't kill their sessions
  if (tasks.length === 0 || !activeTask) return null;
  if (!isOpen && shellTasks.length === 0) return null;

  const isLogLike = activeTask.type === 'logs' || activeTask.type === 'multilogs';
  const isSingleLogs = activeTask.type === 'logs';

  // Ctrl+F inside the dock: find in the YAML editor, or focus the log filter
  const onDockKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'f') return;
    if (activeTask.type === 'manifest') {
      e.preventDefault();
      setYamlFindOpen(true);
    } else if (isLogLike) {
      e.preventDefault();
      logFilterRef.current?.select();
    }
  };

  const tabIcon = (type: DockTask['type']) => {
    switch (type) {
      case 'logs': return <Terminal className="w-3.5 h-3.5 text-cyan-400 shrink-0" />;
      case 'multilogs': return <Rows3 className="w-3.5 h-3.5 text-violet-400 shrink-0" />;
      case 'shell': return <SquareTerminal className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
      default: return <FileCode className="w-3.5 h-3.5 text-amber-400 shrink-0" />;
    }
  };

  const toggleBtn = (on: boolean) =>
    `p-1 rounded transition-colors ${on ? 'text-cyan-300 bg-slate-800' : 'text-slate-400 hover:text-slate-200'}`;

  return (
    <div
      onKeyDown={onDockKeyDown}
      className={`border-t border-slate-800 bg-slate-950 flex-col z-30 transition-all ${
        isOpen ? 'flex' : 'hidden'
      } ${isMaximized ? 'h-[75vh]' : 'h-72'}`}
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
                {tabIcon(task.type)}
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
          {activeTask.type === 'shell' && (
            <>
              {activeTask.containers && activeTask.containers.length > 1 && (
                <select
                  value={activeTask.container || activeTask.containers[0]}
                  onChange={(e) => onUpdateTask?.(activeTask.id, { container: e.target.value })}
                  className="bg-slate-950 border border-slate-800 text-[11px] text-slate-300 rounded px-2 py-0.5"
                  title="Container"
                >
                  {activeTask.containers.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              )}
              <button
                onClick={() => onUpdateTask?.(activeTask.id, { sessionKey: (activeTask.sessionKey || 0) + 1 })}
                className="p-1 rounded text-slate-400 hover:text-emerald-300"
                title="Restart shell session"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            </>
          )}

          {activeTask.type === 'manifest' && (
            <>
              <button
                onClick={() => setYamlFindOpen((o) => !o)}
                className={toggleBtn(yamlFindOpen)}
                title="Find in YAML (Ctrl+F)"
              >
                <Search className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={handleApply}
                disabled={isApplying}
                className="flex items-center gap-1 bg-cyan-600 hover:bg-cyan-500 text-white text-[11px] font-semibold px-2.5 py-0.5 rounded transition-colors disabled:opacity-50"
              >
                <Play className="w-3 h-3 fill-current" />
                <span>{isApplying ? 'Applying...' : 'Apply Manifest'}</span>
              </button>
            </>
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

      {/* Log toolbar */}
      {isLogLike && (
        <div className="h-8 border-b border-slate-800/80 bg-slate-900/50 px-3 flex items-center gap-2 select-none shrink-0 text-[11px]">
          {/* Container selector */}
          {isSingleLogs && activeTask.containers && activeTask.containers.length > 1 && (
            <select
              value={selectedContainer}
              onChange={(e) => setSelectedContainer(e.target.value)}
              className="bg-slate-950 border border-slate-800 text-slate-300 rounded px-2 py-0.5"
              title="Container"
            >
              {activeTask.containers.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          )}

          {/* Filter (plain text or regex) */}
          <div className={`flex items-center bg-slate-950 border rounded ${filter.error ? 'border-rose-600' : 'border-slate-800 focus-within:border-cyan-500'}`}>
            <input
              ref={logFilterRef}
              type="text"
              placeholder={useRegex ? 'Regex filter… (Ctrl+F)' : 'Filter logs… (Ctrl+F)'}
              value={logFilter}
              onChange={(e) => setLogFilter(e.target.value)}
              title={filter.error}
              spellCheck={false}
              className="bg-transparent text-slate-200 px-2 py-0.5 w-44 focus:outline-none font-mono"
            />
            <button onClick={() => setUseRegex(!useRegex)} className={toggleBtn(useRegex)} title="Use regular expression">
              <Regex className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Severity */}
          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value as any)}
            className="bg-slate-950 border border-slate-800 text-slate-300 rounded px-1.5 py-0.5"
            title="Show only lines at or above this level"
          >
            <option value="all">All levels</option>
            <option value="warn">Warnings + errors</option>
            <option value="error">Errors only</option>
          </select>

          {/* Time range / previous instance (single pod only) */}
          {isSingleLogs && (
            <>
              <select
                value={since}
                onChange={(e) => setSince(e.target.value)}
                className="bg-slate-950 border border-slate-800 text-slate-300 rounded px-1.5 py-0.5"
                title="Time range"
              >
                {SINCE_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
              <button
                onClick={() => setShowPrevious(!showPrevious)}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded border transition-colors ${
                  showPrevious ? 'text-amber-300 border-amber-700 bg-amber-950/50' : 'text-slate-400 border-slate-800 hover:text-slate-200'
                }`}
                title="Logs of the previous container instance (the one that crashed or restarted)"
              >
                <History className="w-3.5 h-3.5" />
                <span>Previous</span>
              </button>
              <button onClick={() => setShowTimestamps(!showTimestamps)} className={toggleBtn(showTimestamps)} title="Toggle Timestamps">
                <Clock className="w-3.5 h-3.5" />
              </button>
            </>
          )}

          <button onClick={() => setPrettyJsonLines(!prettyJsonLines)} className={toggleBtn(prettyJsonLines)} title="Pretty-print JSON log lines">
            <Braces className="w-3.5 h-3.5" />
          </button>

          {/* Saved filters & bookmarks */}
          <div className="relative" ref={savedMenuRef}>
            <button
              onClick={() => setSavedOpen((o) => !o)}
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded border transition-colors ${savedOpen ? 'text-cyan-300 border-cyan-700 bg-slate-800' : 'text-slate-400 border-slate-800 hover:text-slate-200'}`}
              title={`Saved filters and bookmarked lines${workspace ? ` (workspace ${workspace.name})` : ''}`}
            >
              <Bookmark className="w-3.5 h-3.5" />
              <span>Saved</span>
              {scopedBookmarks.length + scopedFilters.length > 0 && <span className="text-slate-500 tabular-nums">{scopedBookmarks.length + scopedFilters.length}</span>}
            </button>
            {savedOpen && (
              <div className="absolute left-0 top-7 z-40 w-[26rem] max-h-64 overflow-auto bg-slate-900 border border-slate-700 rounded-lg shadow-2xl text-[11px]">
                <div className="px-3 py-1.5 border-b border-slate-800 text-[10px] text-slate-500">
                  {workspace ? <>Workspace <span className="text-cyan-300">{workspace.name}</span>; items saved without a workspace show everywhere</> : 'No workspace active: items are shown in every workspace'}
                </div>
                <div className="px-3 py-2 border-b border-slate-800 space-y-1.5">
                  <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Filters</div>
                  <div className="flex items-center gap-1.5">
                    <input
                      value={filterName}
                      onChange={(e) => setFilterName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveFilter(); }}
                      placeholder={logFilter || levelFilter !== 'all' ? 'Name the current filter…' : 'Set a filter or level first'}
                      disabled={!logFilter && levelFilter === 'all'}
                      className="flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded px-2 py-0.5 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan-500 disabled:opacity-50"
                    />
                    <button onClick={saveFilter} disabled={!filterName.trim()} className="px-2 py-0.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white font-semibold disabled:opacity-40">Save</button>
                  </div>
                  {scopedFilters.length === 0 ? (
                    <div className="text-slate-600">No saved filters.</div>
                  ) : scopedFilters.map((f) => (
                    <div key={f.id} className="group flex items-center gap-2">
                      <button onClick={() => applySavedFilter(f)} className="flex-1 min-w-0 text-left hover:text-cyan-300 flex items-center gap-1.5">
                        <Filter className="w-3 h-3 text-slate-500 shrink-0" />
                        <span className="text-slate-200 truncate">{f.name}</span>
                        <span className="font-mono text-slate-500 truncate">{f.regex ? `/${f.filter}/` : f.filter}{f.level !== 'all' ? ` · ${f.level === 'error' ? 'errors' : 'warn+'}` : ''}</span>
                      </button>
                      <button onClick={() => deleteFilter(f.id)} className="p-0.5 text-slate-600 hover:text-rose-400 opacity-0 group-hover:opacity-100" title="Delete filter"><Trash2 className="w-3 h-3" /></button>
                    </div>
                  ))}
                </div>
                <div className="px-3 py-2 space-y-1">
                  <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Bookmarked lines</div>
                  {scopedBookmarks.length === 0 ? (
                    <div className="text-slate-600">Hover a log line and click its bookmark icon to keep it here.</div>
                  ) : scopedBookmarks.map((b) => (
                    <div key={b.id} className="group flex items-start gap-2">
                      <button onClick={() => openBookmark(b)} className="flex-1 min-w-0 text-left hover:bg-slate-800/60 rounded px-1 -mx-1" title={`${b.namespace}/${b.pod}${b.context ? ` [${b.context}]` : ''}\n${b.text}`}>
                        <div className="flex items-center gap-1.5">
                          <span className={`font-mono truncate ${colorFor(b.pod)}`}>{b.pod}</span>
                          <span className="ml-auto text-[10px] text-slate-600 shrink-0">{new Date(b.savedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
                        </div>
                        <div className="font-mono text-slate-400 truncate">{b.text}</div>
                      </button>
                      <button onClick={() => removeBookmark(b.id)} className="p-0.5 mt-0.5 text-slate-600 hover:text-rose-400 opacity-0 group-hover:opacity-100" title="Remove bookmark"><Trash2 className="w-3 h-3" /></button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <span className="ml-auto text-slate-500 tabular-nums">
            {visibleLogs.length === logs.length ? `${logs.length} lines` : `${visibleLogs.length} of ${logs.length} lines`}
          </span>

          {/* Follow / Auto-scroll toggle */}
          <button onClick={() => setIsFollowing(!isFollowing)} className={toggleBtn(isFollowing)} title="Auto-scroll to bottom">
            <ArrowDown className="w-3.5 h-3.5" />
          </button>

          {/* Clear logs */}
          <button onClick={() => setLogBuf(EMPTY_LOGS)} className="p-1 rounded text-slate-400 hover:text-slate-200" title="Clear Logs Console">
            <Trash2 className="w-3.5 h-3.5" />
          </button>

          {/* Download logs */}
          <button onClick={handleDownloadLogs} className="p-1 rounded text-slate-400 hover:text-slate-200" title="Download Logs">
            <Download className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Dock Content Body */}
      <div className="flex-1 overflow-hidden relative">
        {isLogLike && (
          // The app disables text selection on <body>; log output must stay selectable / copyable
          <div className="h-full overflow-auto p-3 font-mono text-xs text-slate-300 leading-relaxed bg-slate-950 select-text cursor-text selection:bg-cyan-500/30">
            {showPrevious && (
              <div className="mb-2 px-2 py-1 rounded bg-amber-950/40 border border-amber-900/60 text-amber-300 font-sans text-[11px]">
                Showing logs of the previous container instance (not live).
              </div>
            )}
            {visibleLogs.length === 0 ? (
              <div className="text-slate-600 italic">
                {logs.length > 0
                  ? 'No lines match the current filter.'
                  : <>Waiting for log stream from {activeTask.type === 'multilogs'
                      ? (activeTask.selector ? `pods matching ${activeTask.selector}` : `${activeTask.targets?.length || 0} pods`)
                      : activeTask.pod}...</>}
              </div>
            ) : (
              visibleLogs.map(({ line, key, level }) => (
                <LogLine
                  key={key}
                  line={line}
                  lineKey={key}
                  level={level}
                  combined={activeTask.type === 'multilogs'}
                  highlight={filter.highlight}
                  pretty={prettyJsonLines}
                  bookmarked={isBookmarked(line)}
                  flash={flashKey === key}
                  onBookmark={onBookmarkLine}
                />
              ))
            )}
            <div ref={logsEndRef} />
          </div>
        )}

        {/* Shell sessions stay mounted (hidden when inactive) so they keep running */}
        {shellTasks.length > 0 && (
          <Suspense fallback={<div className="p-3 text-xs text-slate-500">Loading terminal…</div>}>
            {shellTasks.map((t) => (
              <ShellTerminal
                key={t.id}
                pod={t.pod!}
                namespace={t.namespace!}
                container={t.container}
                context={t.context}
                sessionKey={t.sessionKey || 0}
                visible={isOpen && t.id === activeTask.id}
              />
            ))}
          </Suspense>
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
            {yamlFindOpen && (
              <div className="px-3 py-1.5 border-b border-slate-800 bg-slate-900/60 flex justify-end shrink-0">
                <FindBar
                  className="w-96"
                  autoFocus
                  query={yamlQuery}
                  onQueryChange={setYamlQuery}
                  total={yamlMatches}
                  active={yamlActive}
                  onNavigate={(d) => yamlMatches && setYamlActive((i) => (i + d + yamlMatches) % yamlMatches)}
                  caseSensitive={yamlCase}
                  onToggleCase={() => setYamlCase((c) => !c)}
                  onClose={() => { setYamlFindOpen(false); setYamlQuery(''); }}
                  placeholder="Find in YAML…"
                />
              </div>
            )}
            <HighlightTextarea
              value={yamlContent}
              onChange={setYamlContent}
              query={yamlFindOpen ? yamlQuery : ''}
              findOptions={{ caseSensitive: yamlCase }}
              activeMatch={yamlFindOpen && yamlMatches ? yamlActive : -1}
              typography="p-3 font-mono text-xs"
              containerClassName="flex-1 min-h-0 bg-slate-950"
              className="h-full text-slate-200 resize-none focus:outline-none selection:bg-cyan-500/30"
              placeholder="Kubernetes YAML manifest..."
            />
          </div>
        )}
      </div>
    </div>
  );
};
