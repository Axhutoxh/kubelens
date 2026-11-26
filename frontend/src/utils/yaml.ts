// Small YAML helpers for the manifest editor: print JSON as YAML (for review diffs) and find the
// field path at the cursor (for field help). Not a YAML parser; they only need to be good
// enough for Kubernetes manifests as people write them.

const PLAIN = /^[A-Za-z0-9_./-][A-Za-z0-9 _./:@-]*$/;
const RESERVED = /^(true|false|null|yes|no|on|off|~|[-+]?\d[\d_.eE+-]*)$/i;

function scalar(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (s === '') return "''";
  if (s.includes('\n')) return JSON.stringify(s);
  if (PLAIN.test(s) && !RESERVED.test(s) && !s.endsWith(' ') && !s.includes(': ')) return s;
  return JSON.stringify(s);
}

/** JSON value as block-style YAML (keys in the order given). */
export function toYaml(v: unknown, indent = 0): string {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    if (v.length === 0) return `${pad}[]`;
    return v
      .map((item) => {
        if (item !== null && typeof item === 'object' && Object.keys(item).length > 0) {
          const inner = toYaml(item, indent + 2).split('\n');
          return `${pad}- ${inner[0].trimStart()}${inner.length > 1 ? '\n' + inner.slice(1).join('\n') : ''}`;
        }
        return `${pad}- ${item !== null && typeof item === 'object' ? (Array.isArray(item) ? '[]' : '{}') : scalar(item)}`;
      })
      .join('\n');
  }
  if (v !== null && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return `${pad}{}`;
    return entries
      .map(([k, val]) => {
        const key = PLAIN.test(k) && !RESERVED.test(k) ? k : JSON.stringify(k);
        if (val !== null && typeof val === 'object' && (Array.isArray(val) ? val.length > 0 : Object.keys(val).length > 0)) {
          return `${pad}${key}:\n${toYaml(val, Array.isArray(val) ? indent : indent + 2)}`;
        }
        return `${pad}${key}: ${val !== null && typeof val === 'object' ? (Array.isArray(val) ? '[]' : '{}') : scalar(val)}`;
      })
      .join('\n');
  }
  return pad + scalar(v);
}

const KEY_LINE = /^(\s*)(-\s+)?([A-Za-z0-9_.-]+):(\s.*|)$/;

/**
 * The `kubectl explain` path for the cursor position, e.g. "deployment.spec.template.spec":
 * the document's kind plus the parent keys of the line the cursor is on.
 */
export function yamlPathAt(text: string, offset: number): string | null {
  // The YAML document (between --- lines) holding the cursor
  const before = text.slice(0, offset);
  const docStart = Math.max(0, before.lastIndexOf('\n---') + 1);
  const afterIdx = text.indexOf('\n---', offset);
  const doc = text.slice(docStart, afterIdx === -1 ? text.length : afterIdx);
  const kind = /^kind:\s*["']?([A-Za-z0-9]+)/m.exec(doc)?.[1];
  if (!kind) return null;

  const lines = text.slice(docStart, offset).split('\n');
  const current = lines[lines.length - 1];
  const trimmed = current.replace(/^\s*-\s+/, (m) => ' '.repeat(m.length));
  // Indent the cursor's field would have
  let indent = trimmed.length - trimmed.trimStart().length;
  if (!trimmed.trim()) indent = current.length;
  const keys: string[] = [];
  for (let i = lines.length - 2; i >= 0 && indent > 0; i--) {
    const m = KEY_LINE.exec(lines[i]);
    if (!m) continue;
    const keyIndent = m[1].length + (m[2] ? m[2].length : 0);
    if (keyIndent < indent) {
      // Only mapping / list openers ("key:" with nothing after it) lead deeper
      if (m[4].trim() === '') keys.unshift(m[3]);
      indent = m[2] ? m[1].length : keyIndent;
    }
  }
  return [kind.toLowerCase(), ...keys].join('.');
}
