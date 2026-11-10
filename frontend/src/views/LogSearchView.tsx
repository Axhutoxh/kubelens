import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FileSearch, Search, Regex, CaseSensitive, Loader2, Square, Download, AlertTriangle, Terminal } from 'lucide-react';
import { LogMatch, LogSearchResult, searchLogs } from '../api/insights';
import { saveTextFile } from '../api/client';
import { podColor, splitMatches } from '../utils/logs';

interface LogSearchViewProps {
  currentContext: string;
  namespace: string;
  namespaces: string[];
  onOpenLogs: (pod: string, namespace: string, containers: string[]) => void;
  onToast?: (message: string, type?: 'success' | 'error') => void;
}

const SINCE: Array<[string, string]> = [['15m', 'Last 15 min'], ['1h', 'Last hour'], ['6h', 'Last 6 hours'], ['24h', 'Last 24 hours']];
const FORM_KEY = 'kubellens_log_search';

interface Form {
  query: string;
  podFilter: string;
  namespace: string;
  since: string;
  regex: boolean;
  caseSensitive: boolean;
}

function loadForm(namespace: string): Form {
  const base: Form = { query: '', podFilter: '', namespace, since: '1h', regex: false, caseSensitive: false };
  try {
    const saved = JSON.parse(localStorage.getItem(FORM_KEY) || '{}');
    return { ...base, ...saved, namespace };
  } catch {
    return base;
  }
}

/** "2026-11-10T13:05:06.123456789Z" -> local "13:05:06.123" plus the date when not today */
function shortTime(ts: string) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  const time = d.toLocaleTimeString([], { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

function highlighter(form: Form): RegExp | null {
  if (!form.query) return null;
  try {
    const src = form.regex ? form.query : form.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(src, form.caseSensitive ? 'g' : 'gi');
  } catch {
    // Rust regex syntax JS doesn't understand: show matches without highlighting
    return null;
  }
}

/** Search the logs of many pods at once, merged by time. */
export const LogSearchView: React.FC<LogSearchViewProps> = ({ currentContext, namespace, namespaces, onOpenLogs, onToast }) => {
  const [form, setForm] = useState<Form>(() => loadForm(namespace));
  const [result, setResult] = useState<LogSearchResult | null>(null);
  const [searched, setSearched] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [onlyPod, setOnlyPod] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const queryRef = useRef<HTMLInputElement>(null);

  useEffect(() => { queryRef.current?.focus(); }, []);
  // Follow the app's namespace selector
  useEffect(() => setForm((f) => ({ ...f, namespace })), [namespace]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  const run = async () => {
    if (!form.query.trim() || busy) return;
    try { localStorage.setItem(FORM_KEY, JSON.stringify({ ...form, namespace: undefined })); } catch { /* ignore */ }
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    setError(null);
    setOnlyPod(null);
    try {
      const r = await searchLogs({
        namespace: form.namespace,
        podFilter: form.podFilter,
        query: form.query,
        regex: form.regex,
        caseSensitive: form.caseSensitive,
        since: form.since,
        context: currentContext,
      }, ac.signal);
      setResult(r);
      setSearched(form);
    } catch (e: any) {
      if (e.name !== 'AbortError') setError(e.message);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const hl = useMemo(() => (searched ? highlighter(searched) : null), [searched]);
  const podCounts = useMemo(() => {
    const m = new Map<string, number>();
    (result?.matches || []).forEach((x) => m.set(x.pod, (m.get(x.pod) || 0) + 1));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [result]);
  const shown: LogMatch[] = useMemo(() => (result?.matches || []).filter((m) => !onlyPod || m.pod === onlyPod), [result, onlyPod]);
  const failed = (result?.containers || []).filter((c) => c.error);

  const exportResults = async () => {
    if (!shown.length) return;
    const text = shown.map((m) => `${m.ts} ${m.namespace}/${m.pod}/${m.container} ${m.line}`).join('\n') + '\n';
    try {
      const path = await saveTextFile(`log-search_${(searched?.query || 'results').replace(/[^a-z0-9-]+/gi, '_').slice(0, 40)}.log`, text);
      onToast?.(path ? `Saved ${shown.length} lines to ${path}` : `Downloading ${shown.length} lines`);
    } catch (e: any) {
      onToast?.(`Save failed: ${e.message}`, 'error');
    }
  };

  const toggle = (on: boolean) => `p-1 rounded transition-colors ${on ? 'text-cyan-300 bg-slate-800' : 'text-slate-500 hover:text-slate-200'}`;
  const input = 'bg-slate-950 border border-slate-700 rounded-md px-2 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan-500';

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-6 py-3 border-b border-slate-800 bg-slate-900/40 space-y-2.5 select-none">
        <div className="flex items-center gap-2 text-xs font-medium">
          <FileSearch className="w-4 h-4 text-cyan-400" />
          <span className="text-slate-200">Log Search</span>
          <span className="text-[11px] text-slate-500 font-normal">Search many pods at once; results are merged by time.</span>
        </div>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); run(); }}
        >
          <div className="flex items-center flex-1 min-w-[260px] bg-slate-950 border border-slate-700 rounded-md focus-within:border-cyan-500">
            <Search className="w-3.5 h-3.5 text-slate-500 ml-2" />
            <input
              ref={queryRef}
              value={form.query}
              onChange={(e) => set({ query: e.target.value })}
              placeholder={form.regex ? 'Regular expression, e.g. timeout|refused' : 'Text to find, e.g. NullPointerException'}
              spellCheck={false}
              className="flex-1 bg-transparent px-2 py-1.5 text-xs text-slate-100 placeholder-slate-600 focus:outline-none font-mono"
            />
            <button type="button" onClick={() => set({ caseSensitive: !form.caseSensitive })} className={toggle(form.caseSensitive)} title="Match case">
              <CaseSensitive className="w-3.5 h-3.5" />
            </button>
            <button type="button" onClick={() => set({ regex: !form.regex })} className={`${toggle(form.regex)} mr-1`} title="Regular expression">
              <Regex className="w-3.5 h-3.5" />
            </button>
          </div>
          <input
            value={form.podFilter}
            onChange={(e) => set({ podFilter: e.target.value })}
            placeholder="Pods: itam-* or part of a name"
            title="Which pods to search: a wildcard such as itam-* or *-worker, or part of a name. Empty searches every pod in the namespace (up to 40)."
            spellCheck={false}
            className={`${input} w-56 font-mono`}
          />
          <select value={form.namespace} onChange={(e) => set({ namespace: e.target.value })} className={`${input} max-w-[180px]`} title="Namespace">
            <option value="_all">All namespaces</option>
            {form.namespace !== '_all' && !namespaces.includes(form.namespace) && <option value={form.namespace}>{form.namespace}</option>}
            {namespaces.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <select value={form.since} onChange={(e) => set({ since: e.target.value })} className={input} title="Time window">
            {SINCE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {busy ? (
            <button type="button" onClick={() => abortRef.current?.abort()} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-700 hover:bg-slate-600 text-white text-xs font-semibold">
              <Square className="w-3 h-3" /> Stop
            </button>
          ) : (
            <button type="submit" disabled={!form.query.trim()} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold disabled:opacity-40">
              <Search className="w-3.5 h-3.5" /> Search
            </button>
          )}
        </form>
        {form.namespace === '_all' && !form.podFilter.trim() && (
          <div className="text-[11px] text-amber-300/90">Searching all namespaces needs a pod filter, e.g. <span className="font-mono">payments-*</span>.</div>
        )}
      </div>

      {(result || busy || error) && (
        <div className="px-6 py-2 border-b border-slate-800 bg-slate-950/60 flex items-center gap-2 flex-wrap text-[11px] select-none min-h-9">
          {busy ? (
            <span className="flex items-center gap-1.5 text-cyan-300"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading logs…</span>
          ) : error ? (
            <span className="text-rose-300 whitespace-pre-wrap">{error}</span>
          ) : result && (
            <>
              <span className="text-slate-300">
                <b className="text-slate-100">{result.totalMatches}</b> match{result.totalMatches === 1 ? '' : 'es'} in {podCounts.length} pod{podCounts.length === 1 ? '' : 's'}
                <span className="text-slate-500"> · searched {result.podsSearched} pods, {SINCE.find(([v]) => v === result.since)?.[1].toLowerCase() || result.since}</span>
              </span>
              {result.truncated && <span className="text-amber-300" title="Only the newest matches are shown">showing the newest {result.matches.length}</span>}
              {result.podsSkipped > 0 && <span className="text-amber-300">{result.podsSkipped} more pods matched; narrow the pod filter to search them</span>}
              {podCounts.length > 1 && (
                <div className="flex items-center gap-1 flex-wrap">
                  {podCounts.slice(0, 12).map(([pod, n]) => (
                    <button
                      key={pod}
                      onClick={() => setOnlyPod(onlyPod === pod ? null : pod)}
                      className={`px-1.5 py-0.5 rounded border font-mono ${onlyPod === pod ? 'border-cyan-500 bg-cyan-500/10' : 'border-slate-800 hover:bg-slate-800'} ${podColor(pod)}`}
                      title={onlyPod === pod ? 'Show all pods' : 'Show only this pod'}
                    >
                      {pod.length > 32 ? `${pod.slice(0, 30)}…` : pod} <span className="text-slate-500">{n}</span>
                    </button>
                  ))}
                </div>
              )}
              {shown.length > 0 && (
                <button onClick={exportResults} className="ml-auto flex items-center gap-1 text-slate-400 hover:text-slate-200" title="Save results as a .log file">
                  <Download className="w-3.5 h-3.5" /> Save
                </button>
              )}
            </>
          )}
        </div>
      )}

      <div className="flex-1 overflow-auto p-3 font-mono text-xs text-slate-300 leading-relaxed select-text">
        {!result && !busy && !error && (
          <div className="h-full flex flex-col items-center justify-center text-center gap-2 text-slate-500 font-sans">
            <FileSearch className="w-8 h-8 text-slate-700" />
            <p>Find an error across every replica: type what to look for, narrow the pods, pick a time window.</p>
            <p className="text-slate-600 text-[11px]">Up to 40 pods are searched in parallel; nothing is downloaded except the matching lines.</p>
          </div>
        )}
        {result && shown.length === 0 && !busy && (
          <div className="text-slate-500 italic font-sans">No lines matched in this window.</div>
        )}
        {shown.map((m, i) => (
          <div key={`${m.ts}-${m.pod}-${m.container}-${i}`} className="group flex gap-2 px-1 rounded hover:bg-slate-900/70">
            <span className="text-slate-500 shrink-0 tabular-nums" title={m.ts}>{shortTime(m.ts)}</span>
            <button
              onClick={() => onOpenLogs(m.pod, m.namespace, [m.container])}
              className={`shrink-0 max-w-[260px] truncate text-left hover:underline ${podColor(m.pod)}`}
              title={`${m.namespace}/${m.pod} (${m.container}): open its live logs`}
            >
              {m.pod}
            </button>
            <span className="whitespace-pre-wrap break-all min-w-0">
              {splitMatches(m.line, hl).map((part, j) => (j % 2 ? <mark key={j} className="bg-cyan-400/30 text-inherit rounded-sm">{part}</mark> : part))}
            </span>
          </div>
        ))}
        {failed.length > 0 && !busy && (
          <details className="mt-3 font-sans text-[11px] text-slate-500">
            <summary className="cursor-pointer flex items-center gap-1 text-amber-300/90"><AlertTriangle className="w-3.5 h-3.5" /> {failed.length} container(s) couldn't be read completely</summary>
            {failed.map((c) => (
              <div key={`${c.pod}/${c.container}`} className="ml-5 flex items-center gap-1">
                <Terminal className="w-3 h-3" /> <span className="font-mono">{c.pod}/{c.container}</span>: {c.error}
              </div>
            ))}
          </details>
        )}
      </div>
    </div>
  );
};
