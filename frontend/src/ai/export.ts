import { ChatMessage, ToolCall } from './types';

export interface ExportMeta {
  title: string;
  cluster?: string;
  namespace?: string;
  model?: string;
}

const ACTIONS = new Set(['restart_workload', 'scale_workload', 'rollback_deployment', 'delete_pod', 'set_image']);

/** "get_logs (pod=api-1, namespace=team)": names and arguments only */
function callLine(c: ToolCall) {
  const args = Object.entries(c.args || {})
    .filter(([k, v]) => k !== 'reveal' && v !== undefined && v !== '' && v !== false)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ');
  return `${c.name.replace(/_/g, ' ')}${args ? ` (${args})` : ''}`;
}

/**
 * The conversation as Markdown for sharing a diagnosis: questions, answers, and one line per
 * cluster lookup or proposed change with its outcome. Tool output (raw cluster data, and
 * anything revealed with permission) is never included.
 */
export function chatToMarkdown(messages: ChatMessage[], meta: ExportMeta): string {
  // Outcome of each change proposal, read from its tool result
  const outcome = new Map<string, string>();
  messages.forEach((m) => {
    if (m.role !== 'tool') return;
    m.results.forEach((r) => {
      if (!ACTIONS.has(r.name)) return;
      outcome.set(r.id, r.isError ? 'failed' : r.content.startsWith('Applied') ? 'applied' : 'not applied');
    });
  });

  const where = [meta.cluster && `Cluster \`${meta.cluster}\``, meta.namespace && `namespace \`${meta.namespace === '_all' ? 'all' : meta.namespace}\``, meta.model && `model ${meta.model}`]
    .filter(Boolean)
    .join(' · ');
  const out: string[] = [`# ${meta.title}`, '', `_${where ? `${where} · ` : ''}exported from Kubellens ${new Date().toLocaleString()}_`, ''];

  let answered = false;
  for (const m of messages) {
    if (m.role === 'user') {
      out.push('## Question', '', m.text.trim(), '');
      answered = false;
    } else if (m.role === 'assistant') {
      const lookups = m.toolCalls.filter((c) => !ACTIONS.has(c.name));
      const changes = m.toolCalls.filter((c) => ACTIONS.has(c.name));
      if (m.text.trim()) {
        if (!answered) out.push('## Answer', '');
        out.push(m.text.trim(), '');
        answered = true;
      }
      if (lookups.length) {
        out.push(`<details><summary>Checked ${lookups.length} thing${lookups.length === 1 ? '' : 's'} in the cluster</summary>`, '');
        lookups.forEach((c) => out.push(`- ${callLine(c)}`));
        out.push('', '</details>', '');
      }
      changes.forEach((c) => out.push(`> **Proposed change:** ${callLine(c)} → **${outcome.get(c.id) || 'pending'}**`, ''));
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export function exportFileName(title: string) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'ai-chat';
  return `${slug}-${new Date().toISOString().slice(0, 10)}.md`;
}
