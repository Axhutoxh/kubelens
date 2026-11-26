import React, { useEffect, useState } from 'react';
import { Send, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { NotifySettings as Settings, notifySettings, saveNotifySettings, testNotify } from '../api/v18';

const HELP: Record<Settings['kind'], string> = {
  slack: 'Slack: Apps → Incoming Webhooks → Add to channel; paste the https://hooks.slack.com/… URL.',
  teams: 'Teams: channel → Workflows → "Post to a channel when a webhook request is received" (or an Incoming Webhook); paste its URL.',
  generic: 'Any HTTPS endpoint; receives {"source":"kubellens","title","text","severity","cluster"} as JSON.',
};

/** Alerts-bell section: forward new alerts to Slack, Teams or a generic webhook. */
export const NotifySettings: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [s, setS] = useState<Settings | null>(null);
  const [kind, setKind] = useState<Settings['kind']>('slack');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!open || s) return;
    notifySettings().then((r) => { setS(r); setKind(r.kind); }).catch((e) => setNote({ ok: false, text: e.message }));
  }, [open, s]);

  const save = async (enabled: boolean) => {
    setBusy('save');
    setNote(null);
    try {
      const r = await saveNotifySettings({ enabled, kind, url: url.trim() || undefined });
      setS(r);
      setUrl('');
      setNote({ ok: true, text: enabled ? 'On: new alerts are sent to the webhook.' : 'Off.' });
    } catch (e: any) {
      setNote({ ok: false, text: e.message });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy('test');
    setNote(null);
    try {
      await testNotify();
      setNote({ ok: true, text: 'Test message sent.' });
    } catch (e: any) {
      setNote({ ok: false, text: e.message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="border-b border-slate-800 text-[11px]">
      <button onClick={() => setOpen((o) => !o)} className="w-full px-3 py-2 flex items-center gap-1.5 text-slate-400 hover:text-slate-200">
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <Send className="w-3.5 h-3.5" /> Send alerts to Slack / Teams
        {s?.enabled && <span className="ml-auto px-1.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800">on</span>}
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2">
          <div className="flex gap-1">
            {(['slack', 'teams', 'generic'] as const).map((k) => (
              <button key={k} onClick={() => setKind(k)} className={`px-2 py-0.5 rounded border capitalize ${kind === k ? 'border-cyan-500/70 text-cyan-200 bg-cyan-500/10' : 'border-slate-700 text-slate-400 hover:bg-slate-800'}`}>{k === 'generic' ? 'Webhook' : k}</button>
            ))}
          </div>
          <div className="text-slate-500">{HELP[kind]}</div>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={s?.configured ? `Saved: ${s.url} (paste to replace)` : 'https://…'}
            spellCheck={false}
            className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200 placeholder-slate-600 font-mono focus:outline-none focus:border-cyan-500"
          />
          <div className="flex items-center gap-2">
            <button onClick={() => save(true)} disabled={!!busy || (!url.trim() && !s?.configured)} className="px-2 py-0.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white font-semibold disabled:opacity-40">
              {busy === 'save' ? <Loader2 className="w-3 h-3 animate-spin" /> : s?.enabled ? 'Save' : 'Turn on'}
            </button>
            {s?.enabled && <button onClick={() => save(false)} disabled={!!busy} className="px-2 py-0.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800">Turn off</button>}
            {s?.configured && (
              <button onClick={test} disabled={!!busy} className="ml-auto px-2 py-0.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 flex items-center gap-1">
                {busy === 'test' && <Loader2 className="w-3 h-3 animate-spin" />} Send test
              </button>
            )}
          </div>
          {note && <div className={note.ok ? 'text-emerald-300' : 'text-rose-300'}>{note.text}</div>}
          <div className="text-slate-600">The URL is stored on this computer only and never shown in full again. At most 20 alerts a minute are sent.</div>
        </div>
      )}
    </div>
  );
};
