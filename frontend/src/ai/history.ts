import { ChatMessage, ProviderId } from './types';

// Saved conversations live in this browser profile only. They keep the questions and the
// assistant's answers, never tool output: raw cluster data (and anything revealed with
// permission) is not written to disk.

export interface SavedChat {
  id: string;
  title: string;
  updatedAt: number;
  cluster?: string;
  namespace?: string;
  provider?: ProviderId;
  messages: ChatMessage[];
}

const KEY = 'kubellens_ai_chats';
const MAX_CHATS = 50;

export function loadChats(): SavedChat[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function store(chats: SavedChat[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(chats.slice(0, MAX_CHATS)));
  } catch {
    // storage full or unavailable: chats just aren't remembered
  }
}

/** Questions and answers only; tool calls / results are dropped. */
export function textOnly(messages: ChatMessage[]): ChatMessage[] {
  return messages.flatMap((m): ChatMessage[] => {
    if (m.role === 'user') return [m];
    if (m.role === 'assistant' && m.text.trim()) return [{ role: 'assistant', text: m.text, toolCalls: [] }];
    return [];
  });
}

export function saveChat(chat: SavedChat): SavedChat[] {
  const chats = [{ ...chat, messages: textOnly(chat.messages) }, ...loadChats().filter((c) => c.id !== chat.id)];
  chats.sort((a, b) => b.updatedAt - a.updatedAt);
  store(chats);
  return chats;
}

export function deleteChat(id: string): SavedChat[] {
  const chats = loadChats().filter((c) => c.id !== id);
  store(chats);
  return chats;
}

export function titleFor(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user');
  const text = first && first.role === 'user' ? first.text.replace(/\s+/g, ' ').trim() : 'New chat';
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

export const newChatId = () => `chat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
