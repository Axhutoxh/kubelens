import React, { useEffect, useRef, useState } from 'react';
import { Send, Square, Loader2, CheckCircle2, AlertCircle, Wrench, ShieldAlert, Eye, EyeOff, Sparkles } from 'lucide-react';
import { AiChat } from './useAiChat';
import { Markdown } from './Markdown';

interface ChatThreadProps {
  chat: AiChat;
  suggestions: string[];
  /** Where the conversation is about, shown in the empty state */
  scopeLabel: string;
  /** Larger type and centred column for the full-page chat */
  roomy?: boolean;
  autoFocus?: boolean;
}

/** Conversation, tool activity, permission prompt and input box. */
export const ChatThread: React.FC<ChatThreadProps> = ({ chat, suggestions, scopeLabel, roomy, autoFocus }) => {
  const { messages, activity, permission, decisions, setDecisions, busy, statusText, error, current } = chat;
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, activity, permission, statusText, error]);

  useEffect(() => {
    if (autoFocus) requestAnimationFrame(() => inputRef.current?.focus());
  }, [autoFocus]);

  const submit = (text: string) => {
    if (!text.trim() || busy || permission) return;
    chat.send(text);
    setInput('');
  };

  const column = roomy ? 'max-w-3xl mx-auto w-full' : '';
  const providerName = current?.label || 'the AI provider';

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div ref={scrollRef} className="flex-1 overflow-auto px-3 py-3">
        <div className={`space-y-3 ${column}`}>
          {messages.length === 0 && (
            <div className={`space-y-2 ${roomy ? 'pt-10' : ''}`}>
              {roomy && (
                <div className="flex flex-col items-center text-center gap-2 pb-4">
                  <div className="p-2.5 rounded-xl bg-gradient-to-br from-cyan-500/20 to-violet-500/20 border border-cyan-800/60">
                    <Sparkles className="w-6 h-6 text-cyan-300" />
                  </div>
                  <div className="text-base font-semibold text-slate-100">Ask about {scopeLabel}</div>
                  <div className="text-xs text-slate-400 max-w-md">
                    The assistant checks the live cluster with read-only tools. Passwords, tokens and Secret data stay masked unless you allow them.
                  </div>
                </div>
              )}
              {!roomy && <div className="text-xs text-slate-400">Ask about {scopeLabel}. The assistant uses read-only tools; secrets stay masked unless you allow them.</div>}
              <div className={roomy ? 'grid grid-cols-1 sm:grid-cols-2 gap-2' : 'space-y-2'}>
                {suggestions.map((s) => (
                  <button
                    key={s}
                    onClick={() => submit(s)}
                    className="block w-full text-left px-3 py-2 rounded-lg border border-slate-800 bg-slate-950/50 hover:border-cyan-700 hover:text-cyan-200 text-[12px] text-slate-300 transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] px-3 py-2 rounded-lg bg-cyan-950/60 border border-cyan-900/70 text-[12.5px] text-cyan-50 whitespace-pre-wrap break-words select-text">{m.text}</div>
              </div>
            ) : m.role === 'assistant' ? (
              <div key={i} className="space-y-1.5 select-text">
                {m.text && <Markdown text={m.text} />}
                {m.toolCalls.map((c) => {
                  const a = activity[c.id];
                  return (
                    <div key={c.id} className="flex items-center gap-1.5 text-[11px] text-slate-500 font-mono">
                      {!a || a.state === 'running'
                        ? (a ? <Loader2 className="w-3 h-3 animate-spin text-cyan-400" /> : <Wrench className="w-3 h-3" />)
                        : a.state === 'ok' ? <CheckCircle2 className="w-3 h-3 text-emerald-500" /> : <AlertCircle className="w-3 h-3 text-rose-400" />}
                      <span className="truncate" title={a?.error || JSON.stringify(c.args)}>{a?.summary || c.name}</span>
                      {a?.reveal && <span className="flex items-center gap-0.5 text-amber-400 font-sans"><Eye className="w-3 h-3" /> revealed</span>}
                      {!!a?.redacted && <span className="flex items-center gap-0.5 text-emerald-400/90 font-sans" title="Sensitive values were masked before sending"><EyeOff className="w-3 h-3" /> {a.redacted} masked</span>}
                      {a?.truncated && <span className="text-slate-600 font-sans">· trimmed</span>}
                    </div>
                  );
                })}
              </div>
            ) : null
          )}

          {permission && (
            <div className="rounded-lg border border-amber-700/70 bg-amber-950/30 p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-200">
                <ShieldAlert className="w-4 h-4" /> The assistant wants to see sensitive values
              </div>
              <div className="text-[11px] text-amber-100/80">
                Passwords, tokens and Secret data are masked by default. Allowing a request sends the real values to {providerName} for that one lookup.
              </div>
              {permission.map((r) => (
                <div key={r.id} className="flex items-center gap-2 text-[11px]">
                  <span className="flex-1 min-w-0 truncate font-mono text-slate-200" title={JSON.stringify(r.args)}>{r.summary}</span>
                  <button
                    onClick={() => setDecisions((d) => ({ ...d, [r.id]: true }))}
                    className={`px-2 py-0.5 rounded border ${decisions[r.id] === true ? 'bg-amber-600 text-slate-950 border-amber-500 font-semibold' : 'border-amber-800 text-amber-200 hover:bg-amber-900/40'}`}
                  >
                    Allow
                  </button>
                  <button
                    onClick={() => setDecisions((d) => ({ ...d, [r.id]: false }))}
                    className={`px-2 py-0.5 rounded border ${decisions[r.id] === false ? 'bg-slate-600 text-white border-slate-500 font-semibold' : 'border-slate-700 text-slate-300 hover:bg-slate-800'}`}
                  >
                    Keep masked
                  </button>
                </div>
              ))}
              <div className="flex justify-end">
                <button
                  onClick={chat.decide}
                  disabled={permission.some((r) => decisions[r.id] === undefined)}
                  className="px-3 py-1 rounded-md bg-slate-200 hover:bg-white text-slate-900 text-[11px] font-semibold disabled:opacity-40"
                >
                  Continue
                </button>
              </div>
            </div>
          )}

          {busy && statusText && (
            <div className="flex items-center gap-1.5 text-[11px] text-cyan-300"><Loader2 className="w-3 h-3 animate-spin" /> {statusText}</div>
          )}
          {error && (
            <div className="flex gap-1.5 text-[11px] text-rose-300 bg-rose-950/40 border border-rose-900/70 rounded-md p-2">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> <span className="break-words select-text">{error}</span>
            </div>
          )}
        </div>
      </div>

      <div className="p-2.5 border-t border-slate-800 shrink-0">
        <div className={column}>
          <div className="flex items-end gap-2 bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 focus-within:border-cyan-500">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit(input);
                }
              }}
              disabled={!!permission}
              rows={Math.min(6, Math.max(roomy ? 2 : 1, input.split('\n').length))}
              placeholder={permission ? 'Answer the permission request above first' : `Ask about ${scopeLabel}… (Enter to send, Shift+Enter for a new line)`}
              className="flex-1 bg-transparent resize-none text-[12.5px] text-slate-100 placeholder-slate-600 focus:outline-none py-0.5 disabled:opacity-50"
            />
            {busy ? (
              <button onClick={chat.stop} title="Stop" className="p-1.5 rounded-md bg-slate-700 hover:bg-slate-600 text-slate-100"><Square className="w-3.5 h-3.5" /></button>
            ) : (
              <button onClick={() => submit(input)} disabled={!input.trim() || !!permission} title="Send" className="p-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white disabled:opacity-40">
                <Send className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <div className="mt-1 text-[10px] text-slate-600">Answers can be wrong; check before acting. Cluster data is sent to {providerName}.</div>
        </div>
      </div>
    </div>
  );
};
