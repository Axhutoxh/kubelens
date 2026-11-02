import React, { useEffect, useState } from 'react';
import { CheckCircle2, KeyRound, Loader2, Trash2, Copy, ShieldCheck, Plug, LogIn } from 'lucide-react';
import { AiStatus, ModelInfo, ProviderId, ProviderStatus } from './types';
import { deleteAiKey, listAiModels, openProviderPage, saveAiKey, saveAiSettings } from './api';

interface AiSettingsProps {
  status: AiStatus;
  onChanged: () => void;
  onToast?: (message: string, type?: 'success' | 'error') => void;
}

const copy = (text: string, onToast?: AiSettingsProps['onToast'], what = 'Copied') => {
  navigator.clipboard?.writeText(text);
  onToast?.(what);
};

const ProviderCard: React.FC<{
  p: ProviderStatus;
  isDefault: boolean;
  onMakeDefault: () => void;
  onChanged: () => void;
  onModelChange: (model: string) => void;
  onToast?: AiSettingsProps['onToast'];
}> = ({ p, isDefault, onMakeDefault, onChanged, onModelChange, onToast }) => {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);

  useEffect(() => {
    if (!p.configured) { setModels([]); return; }
    listAiModels(p.id).then((r) => setModels(r.models)).catch(() => setModels([]));
  }, [p.id, p.configured]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await saveAiKey(p.id, key);
      setModels(r.models);
      setKey('');
      onToast?.(`${p.label} connected`);
      onChanged();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Remove the saved ${p.label} API key from this computer?`)) return;
    await deleteAiKey(p.id).catch(() => undefined);
    onChanged();
  };

  // Keep the saved model visible even if the provider's list doesn't include it
  const options = models.some((m) => m.id === p.model) || !p.model ? models : [{ id: p.model, label: p.model }, ...models];

  return (
    <div className={`rounded-lg border p-3 space-y-2 ${isDefault && p.configured ? 'border-cyan-700/70 bg-cyan-950/10' : 'border-slate-800 bg-slate-950/40'}`}>
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-slate-100">{p.label}</span>
        {p.configured ? (
          <span className="flex items-center gap-1 text-[10px] text-emerald-400 font-semibold">
            <CheckCircle2 className="w-3 h-3" /> Connected{p.source === 'env' ? ' (environment variable)' : ''}
          </span>
        ) : (
          <span className="text-[10px] text-slate-500">Not connected</span>
        )}
        {p.configured && (
          <label className="ml-auto flex items-center gap-1 text-[11px] text-slate-400 cursor-pointer">
            <input type="radio" checked={isDefault} onChange={onMakeDefault} className="accent-cyan-500" /> Default
          </label>
        )}
      </div>

      {p.configured && (
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-slate-500 w-12">Model</span>
          <select
            value={p.model}
            onChange={(e) => onModelChange(e.target.value)}
            className="flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 font-mono"
          >
            {options.map((m) => <option key={m.id} value={m.id}>{m.label === m.id ? m.id : `${m.label} (${m.id})`}</option>)}
          </select>
          {p.source === 'keychain' && (
            <button onClick={remove} title="Remove saved key" className="p-1 rounded text-slate-500 hover:text-rose-400 hover:bg-slate-800">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <KeyRound className="w-3.5 h-3.5 text-slate-500 shrink-0" />
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && key.trim()) save(); }}
          placeholder={p.configured ? 'Replace API key…' : 'Paste API key…'}
          autoComplete="off"
          spellCheck={false}
          className="flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 font-mono placeholder-slate-600 focus:outline-none focus:border-cyan-500"
        />
        <button
          onClick={save}
          disabled={busy || !key.trim()}
          className="flex items-center gap-1 px-2.5 py-1 rounded bg-cyan-600 hover:bg-cyan-500 text-white text-[11px] font-semibold disabled:opacity-40"
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
          {busy ? 'Checking…' : 'Save'}
        </button>
      </div>
      {error && <div className="text-[11px] text-rose-300">{error}</div>}
      {!p.configured && (
        <ol className="text-[11px] text-slate-400 list-decimal pl-4 space-y-0.5">
          <li>
            <button
              onClick={() => openProviderPage(p.keyUrl).catch(() => copy(p.keyUrl, onToast, 'Could not open the browser; link copied'))}
              className="inline-flex items-center gap-1 text-cyan-300 hover:text-cyan-200 font-semibold"
            >
              <LogIn className="w-3 h-3" /> Sign in to {p.id === 'anthropic' ? 'Anthropic Console' : 'Google AI Studio'}
            </button>{' '}
            (opens your browser)
          </li>
          <li>Create an API key there and copy it</li>
          <li>Paste it above and press Save</li>
        </ol>
      )}
      <div className="text-[10px] text-slate-500">
        {p.configured ? 'Usage' : 'Usage of the key'} is billed to that {p.id === 'anthropic' ? 'Anthropic' : 'Google'} API account.{' '}
        <button onClick={() => copy(p.keyUrl, onToast, 'Link copied')} className="text-slate-400 hover:text-cyan-300 underline-offset-2 hover:underline">
          Copy key page link
        </button>
      </div>
    </div>
  );
};

/** Provider keys, default model, and how to use Kubellens from other AI apps via MCP. */
export const AiSettings: React.FC<AiSettingsProps> = ({ status, onChanged, onToast }) => {
  const [defaultProvider, setDefaultProvider] = useState<ProviderId | null>(status.provider);
  const [models, setModels] = useState<Partial<Record<ProviderId, string>>>(
    Object.fromEntries(status.providers.map((p) => [p.id, p.model]))
  );

  const persist = async (provider: ProviderId | null, m: Partial<Record<ProviderId, string>>) => {
    try {
      await saveAiSettings({ provider, models: m });
      onChanged();
    } catch (e: any) {
      onToast?.(e.message, 'error');
    }
  };

  const command = status.mcp.command;
  const jsonEscaped = command.replace(/\\/g, '\\\\');
  const desktopConfig = `{\n  "mcpServers": {\n    "kubellens": {\n      "command": "${jsonEscaped}",\n      "args": ["--mcp"]\n    }\n  }\n}`;
  const claudeCode = `claude mcp add kubellens -- "${command}" --mcp`;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">AI providers</div>
        {status.providers.map((p) => (
          <ProviderCard
            key={p.id}
            p={{ ...p, model: models[p.id] || p.model }}
            isDefault={(defaultProvider || status.providers.find((x) => x.configured)?.id) === p.id}
            onMakeDefault={() => { setDefaultProvider(p.id); persist(p.id, models); }}
            onModelChange={(model) => { const next = { ...models, [p.id]: model }; setModels(next); persist(defaultProvider, next); }}
            onChanged={onChanged}
            onToast={onToast}
          />
        ))}
        <div className="flex gap-2 text-[11px] text-slate-400 bg-slate-950/50 border border-slate-800 rounded-lg p-2.5">
          <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>
            Keys are kept in your OS credential store, never in the app's files. Passwords, tokens, keys and Secret data are
            masked before anything is sent; the AI must ask, and you must allow it, to see a real value.
          </span>
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold flex items-center gap-1.5">
          <Plug className="w-3.5 h-3.5" /> Use from other AI apps (MCP)
        </div>
        <div className="text-[11px] text-slate-400">
          Kubellens is also an MCP server with the same read-only tools and masking. AI apps start it themselves; no key is needed here.
        </div>
        {[
          ['Claude Desktop: add to claude_desktop_config.json', desktopConfig],
          ['Claude Code: run in a terminal', claudeCode],
          ['Gemini CLI: add to ~/.gemini/settings.json', desktopConfig],
        ].map(([label, snippet]) => (
          <div key={label} className="space-y-1">
            <div className="flex items-center justify-between text-[11px] text-slate-300">
              <span>{label}</span>
              <button onClick={() => copy(snippet, onToast)} className="flex items-center gap-1 text-cyan-400 hover:text-cyan-300">
                <Copy className="w-3 h-3" /> Copy
              </button>
            </div>
            <pre className="p-2 rounded bg-slate-950 border border-slate-800 text-[10.5px] font-mono text-slate-300 overflow-x-auto select-text whitespace-pre">{snippet}</pre>
          </div>
        ))}
        {!command.toLowerCase().includes('kubellens') && (
          <div className="text-[10px] text-amber-300">
            This is a development build path; after installing Kubellens, copy the snippet again from the installed app.
          </div>
        )}
      </div>
    </div>
  );
};
