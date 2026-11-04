import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpCircle, Loader2, X, ExternalLink, Download } from 'lucide-react';
import { Markdown } from '../ai/Markdown';

interface UpdateInfo {
  current: string;
  latest?: string;
  available: boolean;
  disabled?: boolean;
  notes?: string;
  url?: string;
  publishedAt?: string | null;
  /** What Install does here; null means only the release page is offered */
  install?: 'installer' | 'dmg' | 'appimage' | null;
}

interface UpdateNoticeProps {
  /** Bumped by "Check for updates" to run a check that reports its result */
  manualCheck: number;
  onToast?: (message: string, type?: 'success' | 'error') => void;
}

const SKIP_KEY = 'kubellens_update_skipped';
const readSkipped = () => {
  try { return localStorage.getItem(SKIP_KEY); } catch { return null; }
};

const INSTALL_LABEL: Record<string, string> = {
  installer: 'Install & restart',
  dmg: 'Download & open',
  appimage: 'Update & restart',
};

/** Top-bar "Update available" button and the release-notes dialog behind it. */
export const UpdateNotice: React.FC<UpdateNoticeProps> = ({ manualCheck, onToast }) => {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The parent's toast callback changes every render; a ref keeps `check` stable
  const toastRef = useRef(onToast);
  toastRef.current = onToast;

  const check = useCallback(async (manual: boolean) => {
    const toast = toastRef.current;
    try {
      const res = await fetch('/api/update/check');
      if (!res.ok) throw new Error((await res.text()) || `Update check failed (${res.status})`);
      const data: UpdateInfo = await res.json();
      setInfo(data);
      if (manual) {
        if (data.disabled) toast?.('Update checks are turned off on this computer');
        else if (data.available) setOpen(true);
        else toast?.(`Kubellens ${data.current} is the latest version`);
      }
    } catch (e: any) {
      // Background checks stay quiet (offline, proxies, rate limits)
      if (manual) toast?.(e.message || 'Could not check for updates', 'error');
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => check(false), 5000);
    return () => clearTimeout(t);
  }, [check]);

  useEffect(() => {
    if (manualCheck > 0) check(true);
  }, [manualCheck, check]);

  if (!info?.available || !info.latest) return null;
  const skipped = readSkipped() === info.latest;

  const install = async () => {
    setInstalling(true);
    setError(null);
    try {
      const res = await fetch('/api/update/install', { method: 'POST' });
      if (!res.ok) throw new Error((await res.text()) || `Update failed (${res.status})`);
      const data = await res.json();
      setResult(data.message);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setInstalling(false);
    }
  };

  const openRelease = () => {
    if (!info.url) return;
    fetch('/api/update/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: info.url }),
    })
      .then((r) => { if (!r.ok) throw new Error(); })
      .catch(() => {
        navigator.clipboard?.writeText(info.url!);
        onToast?.('Could not open the browser; release link copied');
      });
  };

  const skip = () => {
    try { localStorage.setItem(SKIP_KEY, info.latest!); } catch { /* storage unavailable */ }
    setOpen(false);
  };

  return (
    <>
      {!skipped && (
        <button
          onClick={() => setOpen(true)}
          title={`Kubellens ${info.latest} is available (you have ${info.current})`}
          className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-md border border-emerald-600/60 bg-emerald-950/40 text-emerald-300 hover:bg-emerald-900/40 transition-colors cursor-pointer"
        >
          <ArrowUpCircle className="w-3.5 h-3.5" />
          <span className="whitespace-nowrap hidden @4xl:inline">Update {info.latest}</span>
        </button>
      )}

      {/* Portal: the top bar is a CSS container, which would trap a fixed overlay inside it */}
      {open && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4" onClick={() => !installing && setOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="update-title"
            className="w-full max-w-xl max-h-[80vh] flex flex-col rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-800">
              <ArrowUpCircle className="w-4 h-4 text-emerald-400" />
              <h2 id="update-title" className="text-sm font-semibold text-slate-100">
                Kubellens {info.latest} is available
              </h2>
              <span className="text-[11px] text-slate-500">you have {info.current}</span>
              <button onClick={() => setOpen(false)} disabled={installing} className="ml-auto p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800" aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-auto px-4 py-3 text-xs text-slate-300 select-text">
              {info.notes ? <Markdown text={info.notes} /> : <span className="text-slate-500">No release notes.</span>}
            </div>

            <div className="px-4 py-3 border-t border-slate-800 space-y-2">
              {result && <div className="text-xs text-emerald-300">{result}</div>}
              {error && <div className="text-xs text-rose-300 break-words">{error}</div>}
              <div className="flex items-center gap-2">
                <button onClick={skip} disabled={installing} className="text-[11px] text-slate-500 hover:text-slate-300">
                  Skip this version
                </button>
                <button
                  onClick={openRelease}
                  className="ml-auto flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-slate-700 text-[11px] text-slate-300 hover:bg-slate-800"
                >
                  <ExternalLink className="w-3 h-3" /> Release page
                </button>
                {info.install && !result && (
                  <button
                    onClick={install}
                    disabled={installing}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-semibold disabled:opacity-60"
                  >
                    {installing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                    {installing ? 'Downloading…' : INSTALL_LABEL[info.install]}
                  </button>
                )}
              </div>
              {!info.install && (
                <div className="text-[10.5px] text-slate-500">
                  This install (deb / rpm or portable) is updated from the release page.
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
};
