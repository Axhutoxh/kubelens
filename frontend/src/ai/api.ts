import { AiStatus, ChatContext, ChatEvent, ChatMessage, ModelInfo, ProviderId } from './types';

const BASE = '/api/ai';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.text()) || `Request failed (${res.status})`);
  return res.json();
}

export const getAiStatus = () => fetch(`${BASE}/status`).then((r) => json<AiStatus>(r));

/**
 * Connects a provider: checks the key (and endpoint / Azure deployment) with the provider,
 * then stores the key in the OS credential store. An empty key keeps the saved one.
 */
export const saveAiKey = (provider: ProviderId, key: string, extra: { endpoint?: string; model?: string } = {}) =>
  fetch(`${BASE}/key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, key, ...extra }),
  }).then((r) => json<{ models: ModelInfo[] }>(r));

export const deleteAiKey = (provider: ProviderId) =>
  fetch(`${BASE}/key?provider=${provider}`, { method: 'DELETE' }).then((r) => json<unknown>(r));

export const listAiModels = (provider: ProviderId) =>
  fetch(`${BASE}/models?provider=${provider}`).then((r) => json<{ models: ModelInfo[] }>(r));

export const saveAiSettings = (settings: { provider: ProviderId | null; models: Partial<Record<ProviderId, string>> }) =>
  fetch(`${BASE}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  }).then((r) => json<unknown>(r));

/** Opens a provider's sign-in / API key page in the system browser. */
export const openProviderPage = (url: string) =>
  fetch(`${BASE}/open-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  }).then((r) => json<unknown>(r));

/**
 * Runs one chat request and delivers its Server-Sent Events as they arrive.
 * (EventSource only supports GET, so the stream is parsed by hand.)
 */
export async function streamChat(
  body: {
    provider: ProviderId;
    model?: string;
    messages: ChatMessage[];
    context: ChatContext;
    approvals?: Record<string, boolean>;
  },
  onEvent: (e: ChatEvent) => void,
  signal: AbortSignal
) {
  const res = await fetch(`${BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw new Error((await res.text()) || `Chat failed (${res.status})`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, '');
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) onEvent(JSON.parse(data));
    }
  }
}
