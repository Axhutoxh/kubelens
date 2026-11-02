import React from 'react';

// Small Markdown subset for assistant replies: headings, lists, fenced code, inline code,
// bold, italics and links. Rendered as React nodes (never as HTML), so model output can't
// inject markup.

function inline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${keyBase}-${i++}`;
    if (tok.startsWith('`')) {
      out.push(<code key={k} className="px-1 py-0.5 rounded bg-slate-800 text-cyan-200 font-mono text-[0.92em]">{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith('**')) {
      out.push(<strong key={k} className="font-semibold text-slate-100">{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('[')) {
      const label = tok.slice(1, tok.indexOf(']'));
      out.push(<a key={k} href={m[2]} target="_blank" rel="noreferrer" className="text-cyan-300 underline underline-offset-2">{label}</a>);
    } else {
      out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export const Markdown: React.FC<{ text: string }> = ({ text }) => {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = `b${i}`;
    if (line.trimStart().startsWith('```')) {
      const lang = line.trim().slice(3);
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) code.push(lines[i++]);
      i++; // closing fence
      blocks.push(
        <pre key={key} className="my-2 p-2.5 rounded-md bg-slate-950 border border-slate-800 overflow-x-auto font-mono text-[11px] leading-relaxed text-slate-200 select-text" data-lang={lang}>
          {code.join('\n')}
        </pre>
      );
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(<div key={key} className="mt-2 mb-1 font-semibold text-slate-100">{inline(heading[2], key)}</div>);
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''));
        i++;
      }
      const List = ordered ? 'ol' : 'ul';
      blocks.push(
        <List key={key} className={`my-1 pl-5 space-y-0.5 ${ordered ? 'list-decimal' : 'list-disc'}`}>
          {items.map((it, j) => <li key={j}>{inline(it, `${key}-${j}`)}</li>)}
        </List>
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*([-*]|\d+\.)\s|\s*```)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={key} className="my-1">{inline(para.join(' '), key)}</p>);
  }
  return <div className="text-[12.5px] leading-relaxed text-slate-300 break-words">{blocks}</div>;
};
