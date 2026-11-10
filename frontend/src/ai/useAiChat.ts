import { useCallback, useEffect, useRef, useState } from 'react';
import { AiStatus, ChatContext, ChatEvent, ChatMessage, PermissionRequest, ProviderId } from './types';
import { getAiStatus, streamChat } from './api';

export interface ToolActivity {
  summary: string;
  state: 'running' | 'ok' | 'error';
  redacted?: number;
  truncated?: boolean;
  reveal?: boolean;
  error?: string | null;
  /** A change proposal: applied after approval, or declined */
  action?: boolean;
  applied?: boolean;
  declined?: boolean;
}

/**
 * Chat state and the request loop, shared by the full-page chat and the side panel.
 * `context` is read when a request starts, so changing cluster / namespace applies to the
 * next question.
 */
export function useAiChat(context: ChatContext) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [provider, setProvider] = useState<ProviderId | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activity, setActivity] = useState<Record<string, ToolActivity>>({});
  const [permission, setPermission] = useState<PermissionRequest[] | null>(null);
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const contextRef = useRef(context);
  contextRef.current = context;

  const refreshStatus = useCallback(async () => {
    try {
      const s = await getAiStatus();
      setStatus(s);
      setProvider((cur) => {
        const configured = s.providers.filter((p) => p.configured).map((p) => p.id);
        if (cur && configured.includes(cur)) return cur;
        return (s.provider && configured.includes(s.provider) ? s.provider : configured[0]) || null;
      });
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const connected = status?.providers.filter((p) => p.configured) || [];
  const current = connected.find((p) => p.id === provider);
  const currentRef = useRef(current);
  currentRef.current = current;

  const run = useCallback(async (history: ChatMessage[], approvals?: Record<string, boolean>, focus?: string) => {
    const prov = currentRef.current;
    if (!prov) return;
    setBusy(true);
    setError(null);
    setPermission(null);
    setStatusText('Thinking…');
    const ac = new AbortController();
    abortRef.current = ac;
    const onEvent = (e: ChatEvent) => {
      switch (e.type) {
        case 'status': setStatusText(e.text); break;
        case 'messages': setMessages((m) => [...m, ...e.messages]); break;
        case 'tool_start':
          setStatusText(e.summary);
          setActivity((a) => ({ ...a, [e.id]: { summary: e.summary, state: 'running', reveal: e.reveal, action: e.action, applied: e.applied } }));
          break;
        case 'tool_end':
          setActivity((a) => ({ ...a, [e.id]: { ...a[e.id], state: e.ok ? 'ok' : 'error', redacted: e.redacted, truncated: e.truncated, error: e.error, declined: e.declined } }));
          break;
        case 'permission':
          setPermission(e.requests);
          setDecisions({});
          break;
        case 'error': setError(e.message); break;
        case 'done': break;
      }
    };
    try {
      await streamChat(
        { provider: prov.id, model: prov.model, messages: history, context: { ...contextRef.current, ...(focus ? { focus } : {}) }, approvals },
        onEvent,
        ac.signal
      );
    } catch (e: any) {
      if (e.name !== 'AbortError') setError(e.message);
    } finally {
      setBusy(false);
      setStatusText('');
      abortRef.current = null;
    }
  }, []);

  const send = useCallback((text: string, focus?: string) => {
    const q = text.trim();
    if (!q || abortRef.current) return;
    let history = messagesRef.current;
    // A turn that was stopped mid-way leaves tool calls without results; close them so the
    // provider accepts the conversation
    const last = history[history.length - 1];
    if (last?.role === 'assistant' && last.toolCalls.length > 0) {
      history = [...history, { role: 'tool', results: last.toolCalls.map((c) => ({ id: c.id, name: c.name, content: 'Cancelled by the user.', isError: true })) }];
    }
    history = [...history, { role: 'user', text: q }];
    setMessages(history);
    setPermission(null);
    run(history, undefined, focus);
  }, [run]);

  const decide = useCallback(() => {
    if (!permission) return;
    run(messagesRef.current, Object.fromEntries(permission.map((r) => [r.id, !!decisions[r.id]])));
  }, [permission, decisions, run]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  /** Start over, or load a saved conversation. */
  const reset = useCallback((next: ChatMessage[] = []) => {
    abortRef.current?.abort();
    setMessages(next);
    setActivity({});
    setPermission(null);
    setDecisions({});
    setError(null);
  }, []);

  return {
    status, refreshStatus, provider, setProvider, connected, current,
    messages, activity, permission, decisions, setDecisions, busy, statusText, error,
    send, decide, stop, reset,
  };
}

export type AiChat = ReturnType<typeof useAiChat>;
