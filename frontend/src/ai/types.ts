// Conversation format shared with the Rust backend (src/ai/providers/mod.rs). The UI keeps
// the whole conversation and sends it with every request; the backend is stateless.

export type ProviderId = 'anthropic' | 'gemini' | 'openai' | 'azure' | 'ollama';

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  name: string;
  content: string;
  isError?: boolean;
}

export type ChatMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[]; raw?: unknown; provider?: string }
  | { role: 'tool'; results: ToolResult[] };

export interface PermissionRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
  summary: string;
}

/** Server-Sent Events from POST /api/ai/chat */
export type ChatEvent =
  | { type: 'status'; text: string }
  | { type: 'messages'; messages: ChatMessage[] }
  | { type: 'tool_start'; id: string; name: string; summary: string; reveal: boolean }
  | { type: 'tool_end'; id: string; ok: boolean; redacted: number; truncated: boolean; chars: number; error?: string | null }
  | { type: 'permission'; requests: PermissionRequest[] }
  | { type: 'error'; message: string }
  | { type: 'done' };

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  configured: boolean;
  source: 'keychain' | 'env' | null;
  model: string;
  keyUrl: string;
  /** false for Ollama (local, no key) */
  needsKey: boolean;
  endpointMode: 'none' | 'optional' | 'required';
  /** Endpoint saved when the provider was connected */
  endpoint: string | null;
  defaultEndpoint: string | null;
}

export interface AiStatus {
  providers: ProviderStatus[];
  provider: ProviderId | null;
  mcp: { command: string; args: string[] };
  tools: Array<{ name: string; description: string; canReveal: boolean }>;
}

export interface ModelInfo {
  id: string;
  label: string;
}

export interface ChatContext {
  cluster?: string;
  namespace?: string;
  view?: string;
  focus?: string;
}
