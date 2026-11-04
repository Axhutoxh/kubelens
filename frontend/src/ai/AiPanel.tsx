import React, { useEffect, useRef, useState } from 'react';
import { Sparkles, X, Settings2, Trash2, Lock, Loader2, Maximize2 } from 'lucide-react';
import { ChatContext, ProviderId } from './types';
import { useAiChat } from './useAiChat';
import { ChatThread } from './ChatThread';
import { AiSettings } from './AiSettings';
import { newChatId, saveChat, titleFor } from './history';

interface AiPanelProps {
  isOpen: boolean;
  onClose: () => void;
  context: ChatContext;
  /** A question to ask as soon as the panel opens (e.g. from "Ask AI" on an alert) */
  initialPrompt?: { text: string; focus?: string; nonce: number } | null;
  /** Continue this conversation in the full-page AI Chat */
  onOpenFull?: (chatId: string) => void;
  onToast?: (message: string, type?: 'success' | 'error') => void;
}

const SUGGESTIONS = [
  'Which pods in this namespace are unhealthy, and why?',
  'Summarise recent warning events',
  'Why did the last pod restart?',
  'Which deployments are not on the same image tag?',
];

/** Quick side panel (Ctrl+I) next to whatever view is open; follows the app's cluster / namespace. */
export const AiPanel: React.FC<AiPanelProps> = ({ isOpen, onClose, context, initialPrompt, onOpenFull, onToast }) => {
  const chat = useAiChat(context);
  const [showSettings, setShowSettings] = useState(false);

  // "Ask AI" from elsewhere in the app
  const lastNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!isOpen || !initialPrompt || !chat.current || lastNonce.current === initialPrompt.nonce) return;
    lastNonce.current = initialPrompt.nonce;
    chat.send(initialPrompt.text, initialPrompt.focus);
  }, [isOpen, initialPrompt, chat.current, chat.send]);

  if (!isOpen) return null;

  const ns = context.namespace && context.namespace !== '_all' ? context.namespace : 'all namespaces';
  const openFull = () => {
    const id = newChatId();
    if (chat.messages.length) {
      saveChat({ id, title: titleFor(chat.messages), updatedAt: Date.now(), cluster: context.cluster, namespace: context.namespace, provider: chat.provider || undefined, messages: chat.messages });
    }
    onOpenFull?.(chat.messages.length ? id : '');
    onClose();
  };

  return (
    <aside className="w-[420px] max-w-[45vw] shrink-0 h-full border-l border-slate-800 bg-slate-900 flex flex-col">
      <div className="h-12 px-3 border-b border-slate-800 flex items-center gap-2 shrink-0 select-none">
        <Sparkles className="w-4 h-4 text-cyan-400" />
        <span className="text-sm font-semibold text-slate-100">AI Assistant</span>
        {chat.connected.length > 0 && !showSettings && (
          <select
            value={chat.provider || ''}
            onChange={(e) => chat.setProvider(e.target.value as ProviderId)}
            className="ml-1 bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] text-slate-300 max-w-[140px]"
            title={chat.current ? `Model: ${chat.current.model}` : undefined}
          >
            {chat.connected.map((p) => <option key={p.id} value={p.id}>{p.label.replace(/ \(.*\)$/, '')} · {p.model}</option>)}
          </select>
        )}
        <div className="ml-auto flex items-center gap-1">
          {chat.messages.length > 0 && !showSettings && (
            <button onClick={() => chat.reset()} title="New conversation" className="p-1.5 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800"><Trash2 className="w-3.5 h-3.5" /></button>
          )}
          {onOpenFull && (
            <button onClick={openFull} title="Open in the full AI Chat window" className="p-1.5 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800"><Maximize2 className="w-3.5 h-3.5" /></button>
          )}
          <button onClick={() => setShowSettings((s) => !s)} title="AI settings" className={`p-1.5 rounded hover:bg-slate-800 ${showSettings ? 'text-cyan-300' : 'text-slate-400 hover:text-slate-200'}`}>
            <Settings2 className="w-3.5 h-3.5" />
          </button>
          <button onClick={onClose} title="Close (Ctrl+I)" className="p-1.5 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800"><X className="w-3.5 h-3.5" /></button>
        </div>
      </div>

      {!chat.status ? (
        <div className="flex-1 flex items-center justify-center text-xs text-slate-500"><Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading…</div>
      ) : showSettings || chat.connected.length === 0 ? (
        <div className="flex-1 overflow-auto p-3 space-y-3">
          {chat.connected.length === 0 && (
            <div className="text-xs text-slate-300">Connect an AI provider (Claude, Gemini, OpenAI, Azure OpenAI or local Ollama) to ask questions about your cluster and Kubellens.</div>
          )}
          <AiSettings status={chat.status} onChanged={chat.refreshStatus} onToast={onToast} />
        </div>
      ) : (
        <>
          <div className="px-3 py-1.5 border-b border-slate-800/80 text-[10.5px] text-slate-500 flex items-center gap-1.5 shrink-0 select-none">
            <Lock className="w-3 h-3 text-emerald-500" />
            <span className="truncate">
              Read-only · <span className="text-slate-300 font-mono">{context.cluster || 'current cluster'}</span> · <span className="text-slate-300 font-mono">{ns}</span>
            </span>
          </div>
          <ChatThread chat={chat} suggestions={SUGGESTIONS} scopeLabel={`${ns} on ${context.cluster || 'this cluster'}`} autoFocus />
        </>
      )}
    </aside>
  );
};
