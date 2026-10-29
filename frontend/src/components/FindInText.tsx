import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { ChevronUp, ChevronDown, Search, X, CaseSensitive } from 'lucide-react';

export interface FindOptions {
  caseSensitive?: boolean;
}

/** [start, end) offsets of every occurrence of `query` in `text`. */
export function findMatches(text: string, query: string, opts: FindOptions = {}): Array<[number, number]> {
  if (!query) return [];
  const hay = opts.caseSensitive ? text : text.toLowerCase();
  const needle = opts.caseSensitive ? query : query.toLowerCase();
  const out: Array<[number, number]> = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
    out.push([i, i + needle.length]);
  }
  return out;
}

interface HighlightTextareaProps extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> {
  value: string;
  onChange: (value: string) => void;
  query: string;
  findOptions?: FindOptions;
  /** Index (within this textarea) of the match to emphasise and scroll to; -1 for none */
  activeMatch?: number;
  /** Typography + padding; applied to the textarea and the highlight layer so they line up */
  typography: string;
  /** Border / background / focus classes for the textarea itself */
  className?: string;
  /** Classes for the wrapper (e.g. flex-1 to fill a panel) */
  containerClassName?: string;
  /** The textarea has a 1px border (colour it via className); the layer mirrors its width */
  bordered?: boolean;
}

/**
 * A textarea with search matches highlighted in place. A mirror layer with the same
 * text (transparent) and <mark>s sits behind a transparent-background textarea.
 */
export const HighlightTextarea: React.FC<HighlightTextareaProps> = ({
  value,
  onChange,
  query,
  findOptions,
  activeMatch = -1,
  typography,
  className = '',
  containerClassName = '',
  bordered = false,
  ...rest
}) => {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const matches = findMatches(value, query, findOptions);

  const syncScroll = () => {
    if (taRef.current && layerRef.current) {
      layerRef.current.scrollTop = taRef.current.scrollTop;
      layerRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  };

  // Bring the active match into view inside the textarea, then the textarea into view
  useLayoutEffect(() => {
    if (activeMatch < 0 || !taRef.current || !layerRef.current) return;
    const mark = layerRef.current.querySelector<HTMLElement>('mark[data-active="true"]');
    if (!mark) return;
    const ta = taRef.current;
    ta.scrollTop = Math.max(0, mark.offsetTop - ta.clientHeight / 3);
    syncScroll();
    ta.parentElement?.scrollIntoView({ block: 'nearest' });
    // Not keyed on `value`: typing inside the active match must not keep scrolling the view
  }, [activeMatch, query]);

  const parts: React.ReactNode[] = [];
  let last = 0;
  matches.forEach(([s, e], idx) => {
    if (s > last) parts.push(value.slice(last, s));
    const active = idx === activeMatch;
    parts.push(
      <mark
        key={idx}
        data-active={active}
        className={`rounded-sm text-transparent ${active ? 'bg-amber-400/70 ring-1 ring-amber-300' : 'bg-cyan-400/30'}`}
      >
        {value.slice(s, e)}
      </mark>
    );
    last = e;
  });
  // Trailing newline needs a character after it or the mirror ends one line short
  parts.push(value.slice(last) + '​');

  return (
    <div className={`relative ${containerClassName}`}>
      <div
        ref={layerRef}
        aria-hidden
        className={`absolute inset-0 overflow-hidden pointer-events-none whitespace-pre-wrap break-words text-transparent ${bordered ? 'border border-transparent' : ''} ${typography}`}
      >
        {parts}
      </div>
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        spellCheck={false}
        className={`relative block w-full bg-transparent ${bordered ? 'border' : ''} ${typography} ${className}`}
        {...rest}
      />
    </div>
  );
};

interface FindBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  total: number;
  /** 0-based index of the active match */
  active: number;
  onNavigate: (direction: 1 | -1) => void;
  caseSensitive?: boolean;
  onToggleCase?: () => void;
  onClose?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
}

/** Search box with "3 of 12", previous / next and match-case; Enter / Shift+Enter navigate. */
export const FindBar: React.FC<FindBarProps> = ({
  query,
  onQueryChange,
  total,
  active,
  onNavigate,
  caseSensitive,
  onToggleCase,
  onClose,
  placeholder = 'Find in text…',
  autoFocus,
  className = '',
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) inputRef.current?.select();
  }, [autoFocus]);

  return (
    <div className={`flex items-center gap-1 bg-slate-900 border border-slate-700/80 rounded-md pl-2 pr-1 py-0.5 focus-within:border-cyan-500 ${className}`}>
      <Search className="w-3.5 h-3.5 text-slate-500 shrink-0" />
      <input
        ref={inputRef}
        autoFocus={autoFocus}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onNavigate(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape' && onClose) {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        placeholder={placeholder}
        spellCheck={false}
        className="flex-1 min-w-0 bg-transparent py-0.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none"
      />
      {query && (
        <span className={`text-[10px] font-mono shrink-0 tabular-nums ${total === 0 ? 'text-rose-400' : 'text-slate-400'}`}>
          {total === 0 ? 'No results' : `${active + 1} of ${total}`}
        </span>
      )}
      {onToggleCase && (
        <button
          type="button"
          onClick={onToggleCase}
          title="Match case"
          className={`p-0.5 rounded ${caseSensitive ? 'text-cyan-300 bg-slate-800' : 'text-slate-500 hover:text-slate-300'}`}
        >
          <CaseSensitive className="w-3.5 h-3.5" />
        </button>
      )}
      <button type="button" onClick={() => onNavigate(-1)} disabled={total === 0} title="Previous match (Shift+Enter)" className="p-0.5 rounded text-slate-400 hover:text-slate-200 disabled:opacity-30">
        <ChevronUp className="w-3.5 h-3.5" />
      </button>
      <button type="button" onClick={() => onNavigate(1)} disabled={total === 0} title="Next match (Enter)" className="p-0.5 rounded text-slate-400 hover:text-slate-200 disabled:opacity-30">
        <ChevronDown className="w-3.5 h-3.5" />
      </button>
      {onClose && (
        <button type="button" onClick={onClose} title="Close (Esc)" className="p-0.5 rounded text-slate-500 hover:text-slate-200">
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
};
