import React, { useEffect, useMemo, useState } from 'react';
import { Sparkles, Plus, MessageSquare, Trash2, Settings2, Globe, FolderTree, Loader2, ShieldCheck, ArrowLeft } from 'lucide-react';
import { ContextItem } from '../types/k8s';
import { fetchK8sResource } from '../api/client';
import { useAiChat } from './useAiChat';
import { ChatThread } from './ChatThread';
import { AiSettings } from './AiSettings';
import { SavedChat, deleteChat, loadChats, newChatId, saveChat, titleFor } from './history';
import { ProviderId } from './types';

interface AiChatViewProps {
  contexts: ContextItem[];
  currentContext: string;
  currentNamespace: string;
  /** Conversation to open (e.g. "Open in full window" from the side panel) */
  openChatId?: string | null;
  onToast?: (message: string, type?: 'success' | 'error') => void;
}

function ago(ts: number) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Full-page AI chat: connect providers, pick any cluster / namespace, keep conversations. */
export const AiChatView: React.FC<AiChatViewProps> = ({ contexts, currentContext, currentNamespace, openChatId, onToast }) => {
  const [cluster, setCluster] = useState(currentContext);
  const [namespace, setNamespace] = useState(currentNamespace || '_all');
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [nsLoading, setNsLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [chats, setChats] = useState<SavedChat[]>(loadChats);
  const [chatId, setChatId] = useState<string>(() => newChatId());

  const chat = useAiChat({ cluster, namespace, view: 'AI Chat' });

  // The app may resolve its context after this view mounts
  useEffect(() => {
    if (!cluster && currentContext) setCluster(currentContext);
  }, [currentContext, cluster]);

  // Namespaces of the chosen cluster (any kubeconfig context, not only the active one)
  useEffect(() => {
    if (!cluster) return;
    let alive = true;
    setNsLoading(true);
    fetchK8sResource<any>('namespaces', undefined, cluster)
      .then((res) => {
        if (!alive) return;
        const list = (res.items || []).map((n) => n.metadata.name as string).sort();
        setNamespaces(list);
        setNamespace((ns) => (ns === '_all' || list.includes(ns) ? ns : '_all'));
      })
      .catch(() => alive && setNamespaces([]))
      .finally(() => alive && setNsLoading(false));
    return () => { alive = false; };
  }, [cluster]);

  // Keep the conversation list up to date (questions and answers only)
  useEffect(() => {
    if (chat.busy || chat.messages.length === 0) return;
    setChats(saveChat({
      id: chatId,
      title: titleFor(chat.messages),
      updatedAt: Date.now(),
      cluster,
      namespace,
      provider: chat.provider || undefined,
      messages: chat.messages,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.messages, chat.busy]);

  const openChat = (c: SavedChat) => {
    chat.reset(c.messages);
    setChatId(c.id);
    if (c.cluster) setCluster(c.cluster);
    if (c.namespace) setNamespace(c.namespace);
    if (c.provider && chat.connected.some((p) => p.id === c.provider)) chat.setProvider(c.provider as ProviderId);
    setShowSettings(false);
  };

  // Open a conversation handed over from the side panel
  useEffect(() => {
    if (!openChatId) return;
    const c = loadChats().find((x) => x.id === openChatId);
    if (c) openChat(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openChatId]);

  const newChat = () => {
    chat.reset();
    setChatId(newChatId());
    setShowSettings(false);
  };

  const removeChat = (id: string) => {
    setChats(deleteChat(id));
    if (id === chatId) newChat();
  };

  const nsLabel = namespace === '_all' ? 'all namespaces' : namespace;
  const scopeLabel = `${nsLabel} on ${cluster || 'the current cluster'}`;
  const suggestions = useMemo(() => {
    const where = namespace === '_all' ? 'this cluster' : namespace;
    return [
      `Which pods in ${where} are unhealthy, and why?`,
      `Summarise recent warning events in ${where}`,
      `Which deployments in ${where} are not on the same image tag?`,
      `Is anything close to its CPU or memory limits in ${where}?`,
      'Which nodes are under pressure right now?',
      'How do I roll back a deployment in Kubellens?',
    ];
  }, [namespace]);

  const status = chat.status;
  const connected = chat.connected;

  return (
    <div className="h-full flex overflow-hidden bg-slate-950">
      {/* Conversations */}
      <aside className="w-64 shrink-0 border-r border-slate-800 bg-slate-900/60 flex flex-col select-none">
        <div className="p-3 border-b border-slate-800">
          <button
            onClick={newChat}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> New chat
          </button>
        </div>
        <div className="flex-1 overflow-auto p-2 space-y-0.5">
          {chats.length === 0 ? (
            <div className="px-2 py-3 text-[11px] text-slate-500">Your conversations appear here. Only questions and answers are saved, never cluster data or revealed secrets.</div>
          ) : (
            chats.map((c) => (
              <div
                key={c.id}
                role="button"
                tabIndex={0}
                onClick={() => openChat(c)}
                className={`group flex items-start gap-2 px-2 py-1.5 rounded-md cursor-pointer ${c.id === chatId ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'}`}
              >
                <MessageSquare className="w-3.5 h-3.5 mt-0.5 shrink-0 text-slate-500" />
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] truncate">{c.title}</div>
                  <div className="text-[10px] text-slate-500 truncate font-mono">
                    {c.namespace && c.namespace !== '_all' ? c.namespace : 'all'} · {ago(c.updatedAt)}
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); removeChat(c.id); }}
                  className="p-0.5 rounded text-slate-600 hover:text-rose-400 opacity-0 group-hover:opacity-100"
                  title="Delete conversation"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))
          )}
        </div>
        <div className="p-3 border-t border-slate-800 space-y-1.5">
          <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Connected AI</div>
          {status?.providers.map((p) => (
            <div key={p.id} className="flex items-center gap-1.5 text-[11px]">
              <span className={`w-1.5 h-1.5 rounded-full ${p.configured ? 'bg-emerald-400' : 'bg-slate-600'}`} />
              <span className={p.configured ? 'text-slate-200' : 'text-slate-500'}>{p.label}</span>
            </div>
          ))}
          <button onClick={() => setShowSettings(true)} className="text-[11px] text-cyan-400 hover:text-cyan-300">
            {connected.length ? 'Manage connections' : 'Connect an AI account'}
          </button>
        </div>
      </aside>

      {/* Chat */}
      <main className="flex-1 min-w-0 flex flex-col">
        <div className="h-12 px-4 border-b border-slate-800 bg-slate-900/80 flex items-center gap-3 shrink-0 select-none">
          <Sparkles className="w-4 h-4 text-cyan-400 shrink-0" />
          <span className="text-sm font-semibold text-slate-100 shrink-0">AI Chat</span>

          <div className="flex items-center gap-1.5 bg-slate-950 border border-slate-700/80 rounded-lg px-2 py-1 min-w-0" title="Cluster the assistant looks at">
            <Globe className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
            <select value={cluster} onChange={(e) => setCluster(e.target.value)} className="bg-transparent text-xs text-slate-100 font-mono focus:outline-none max-w-[190px]">
              {!contexts.some((c) => c.name === cluster) && cluster && <option value={cluster}>{cluster}</option>}
              {contexts.map((c) => <option key={c.name} value={c.name} className="bg-slate-900">{c.name}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1.5 bg-slate-950 border border-slate-700/80 rounded-lg px-2 py-1 min-w-0" title="Namespace the assistant focuses on">
            <FolderTree className="w-3.5 h-3.5 text-violet-300 shrink-0" />
            <select value={namespace} onChange={(e) => setNamespace(e.target.value)} className="bg-transparent text-xs text-slate-100 font-mono focus:outline-none max-w-[170px]">
              <option value="_all" className="bg-slate-900">All namespaces</option>
              {namespace !== '_all' && !namespaces.includes(namespace) && <option value={namespace}>{namespace}</option>}
              {namespaces.map((n) => <option key={n} value={n} className="bg-slate-900">{n}</option>)}
            </select>
            {nsLoading && <Loader2 className="w-3 h-3 animate-spin text-slate-500" />}
          </div>

          <div className="ml-auto flex items-center gap-2 shrink-0">
            {connected.length > 0 && !showSettings && (
              <select
                value={chat.provider || ''}
                onChange={(e) => chat.setProvider(e.target.value as ProviderId)}
                className="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-[11px] text-slate-300 max-w-[220px]"
                title="AI model"
              >
                {connected.map((p) => <option key={p.id} value={p.id}>{p.label.replace(/ \(.*\)$/, '')} · {p.model}</option>)}
              </select>
            )}
            <button
              onClick={() => setShowSettings((s) => !s)}
              title="Connections & settings"
              className={`p-1.5 rounded-md border ${showSettings ? 'text-cyan-300 border-cyan-700 bg-slate-800' : 'text-slate-400 border-slate-700 hover:text-slate-200 hover:bg-slate-800'}`}
            >
              <Settings2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {!status ? (
          <div className="flex-1 flex items-center justify-center text-xs text-slate-500"><Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading…</div>
        ) : showSettings || connected.length === 0 ? (
          <div className="flex-1 overflow-auto">
            <div className="max-w-2xl mx-auto p-6 space-y-4">
              {connected.length === 0 ? (
                <div className="text-center space-y-2 pb-2">
                  <div className="inline-flex p-3 rounded-2xl bg-gradient-to-br from-cyan-500/20 to-violet-500/20 border border-cyan-800/60">
                    <Sparkles className="w-7 h-7 text-cyan-300" />
                  </div>
                  <h2 className="text-lg font-semibold text-slate-100">Connect your AI</h2>
                  <p className="text-xs text-slate-400 max-w-md mx-auto">
                    Connect Claude, Gemini, OpenAI, Azure OpenAI, or a local model with Ollama. Then ask anything about any cluster and namespace in your kubeconfig.
                  </p>
                  <p className="flex items-center justify-center gap-1.5 text-[11px] text-emerald-300/90">
                    <ShieldCheck className="w-3.5 h-3.5" /> Read-only access · secrets masked · you approve every reveal
                  </p>
                </div>
              ) : (
                <button onClick={() => setShowSettings(false)} className="flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300">
                  <ArrowLeft className="w-3.5 h-3.5" /> Back to chat
                </button>
              )}
              <AiSettings status={status} onChanged={chat.refreshStatus} onToast={onToast} />
            </div>
          </div>
        ) : (
          <ChatThread chat={chat} suggestions={suggestions} scopeLabel={scopeLabel} roomy autoFocus />
        )}
      </main>
    </div>
  );
};
