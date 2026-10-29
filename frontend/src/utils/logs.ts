export type LogLevel = 'error' | 'warn' | 'debug' | null;

const LEVEL_WORDS = '(?:level|lvl|severity|loglevel)';
const ERROR_RE = new RegExp(
  `\\b(?:ERROR|ERR|FATAL|PANIC|CRITICAL|CRIT|SEVERE)\\b|\\bTraceback \\(most recent call last\\)|"${LEVEL_WORDS}"\\s*:\\s*"(?:error|err|fatal|panic|critical)"|\\b${LEVEL_WORDS}=(?:error|err|fatal|panic|critical)\\b`,
  'i'
);
const WARN_RE = new RegExp(`\\bWARN(?:ING)?\\b|"${LEVEL_WORDS}"\\s*:\\s*"warn(?:ing)?"|\\b${LEVEL_WORDS}=warn(?:ing)?\\b`, 'i');
const DEBUG_RE = new RegExp(`\\b(?:DEBUG|TRACE)\\b|"${LEVEL_WORDS}"\\s*:\\s*"(?:debug|trace)"|\\b${LEVEL_WORDS}=(?:debug|trace)\\b`, 'i');

/** Best-effort severity of a log line (plain text, logfmt or JSON). */
export function logLevel(line: string): LogLevel {
  if (ERROR_RE.test(line)) return 'error';
  if (WARN_RE.test(line)) return 'warn';
  if (DEBUG_RE.test(line)) return 'debug';
  return null;
}

export const LEVEL_RANK: Record<'all' | 'warn' | 'error', (l: LogLevel) => boolean> = {
  all: () => true,
  warn: (l) => l === 'warn' || l === 'error',
  error: (l) => l === 'error',
};

/** Pretty-printed JSON when the line is a JSON object (after an optional timestamp), else null. */
export function prettyJson(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1 || start > 40 || !text.trimEnd().endsWith('}')) return null;
  try {
    const obj = JSON.parse(text.slice(start));
    if (typeof obj !== 'object' || obj === null) return null;
    const prefix = text.slice(0, start);
    return prefix + JSON.stringify(obj, null, 2);
  } catch {
    return null;
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Compiles the log filter. Plain text matches case-insensitively; with `regex` the
 * pattern is used as-is (case-insensitive). Returns an error message for bad patterns.
 */
export function compileFilter(filter: string, regex: boolean): { test: RegExp | null; highlight: RegExp | null; error?: string } {
  if (!filter) return { test: null, highlight: null };
  try {
    const source = regex ? filter : escapeRe(filter);
    // Separate objects: a global regex keeps lastIndex between test() calls
    return { test: new RegExp(source, 'i'), highlight: new RegExp(source, 'gi') };
  } catch (e: any) {
    return { test: null, highlight: null, error: e.message };
  }
}

/** Splits `text` into plain strings and matched strings (odd indices are matches). */
export function splitMatches(text: string, re: RegExp | null): string[] {
  if (!re) return [text];
  const parts: string[] = [];
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === '') { re.lastIndex++; continue; }
    parts.push(text.slice(last, m.index), m[0]);
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}
