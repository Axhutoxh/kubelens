// Saved log filters and bookmarked log lines. Each belongs to the workspace that was active
// when it was saved (or to none, which shows everywhere). Kept in this browser profile only.

export interface SavedLogFilter {
  id: string;
  name: string;
  workspaceId: string | null;
  filter: string;
  regex: boolean;
  level: 'all' | 'warn' | 'error';
  pretty: boolean;
}

export interface LogBookmark {
  id: string;
  workspaceId: string | null;
  context?: string;
  namespace: string;
  pod: string;
  container?: string;
  /** The log message, without kubectl's pod prefix or timestamp */
  text: string;
  savedAt: number;
}

const FILTERS_KEY = 'kubellens_log_filters';
const BOOKMARKS_KEY = 'kubellens_log_bookmarks';
const MAX_BOOKMARKS = 300;

function load<T>(key: string): T[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function store(key: string, list: unknown[]) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* storage full or unavailable */ }
}

export const loadLogFilters = () => load<SavedLogFilter>(FILTERS_KEY);
export const storeLogFilters = (list: SavedLogFilter[]) => store(FILTERS_KEY, list);
export const loadBookmarks = () => load<LogBookmark>(BOOKMARKS_KEY);
export const storeBookmarks = (list: LogBookmark[]) => store(BOOKMARKS_KEY, list.slice(-MAX_BOOKMARKS));

const PREFIX_RE = /^\[pod\/([^/\]]+)\/([^\]]+)\] ?/;
const TIMESTAMP_RE = /^\d{4}-\d\d-\d\dT[\d:.]+Z /;

/** A log line as the app shows it, reduced to its message (no pod prefix, no timestamp). */
export function logText(line: string) {
  return line.replace(PREFIX_RE, '').replace(TIMESTAMP_RE, '');
}

/** Pod and container from a combined-log line ("[pod/<name>/<container>] …"). */
export function linePod(line: string): { pod: string; container: string } | null {
  const m = PREFIX_RE.exec(line);
  return m ? { pod: m[1], container: m[2] } : null;
}

export const inWorkspace = (itemWorkspace: string | null, active: string | null) => itemWorkspace === null || itemWorkspace === active;
