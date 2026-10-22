import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { execSocketUrl } from '../api/client';

interface ShellTerminalProps {
  pod: string;
  namespace: string;
  container?: string;
  context?: string;
  /** Hidden terminals stay mounted so their session survives tab switches */
  visible: boolean;
  /** Bumped by the parent to start a fresh session (e.g. after the shell exited) */
  sessionKey: number;
}

type Status = 'connecting' | 'connected' | 'closed';

/** Interactive `kubectl exec` session rendered with xterm.js over a WebSocket. */
const ShellTerminal: React.FC<ShellTerminalProps> = ({ pod, namespace, container, context, visible, sessionKey }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<Status>('connecting');

  useEffect(() => {
    if (!hostRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', Consolas, 'Courier New', monospace",
      fontSize: 12.5,
      scrollback: 5000,
      theme: {
        background: '#020617',
        foreground: '#e2e8f0',
        cursor: '#22d3ee',
        selectionBackground: 'rgba(34, 211, 238, 0.3)',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    try { fit.fit(); } catch { /* host not laid out yet */ }
    termRef.current = term;
    fitRef.current = fit;

    term.writeln(`\x1b[36mConnecting to ${namespace}/${pod}${container ? ` (${container})` : ''}…\x1b[0m`);
    setStatus('connecting');

    const ws = new WebSocket(execSocketUrl({ pod, namespace, container, context, cols: term.cols, rows: term.rows }));
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    const encoder = new TextEncoder();

    ws.onopen = () => {
      setStatus('connected');
      term.focus();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') term.write(ev.data);
      else term.write(new Uint8Array(ev.data));
    };
    ws.onclose = () => {
      setStatus('closed');
      term.writeln('\r\n\x1b[33m[session closed]\x1b[0m');
    };

    const dataSub = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ resize: { cols, rows } }));
    });

    // Keep the PTY size in sync with the dock (maximize/minimize, window resize)
    const observer = new ResizeObserver(() => {
      if (!hostRef.current || hostRef.current.offsetParent === null) return;
      try { fit.fit(); } catch { /* ignore */ }
    });
    observer.observe(hostRef.current);

    return () => {
      observer.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      ws.close();
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
    };
  }, [pod, namespace, container, context, sessionKey]);

  // Re-fit and focus when this tab becomes visible again
  useEffect(() => {
    if (!visible) return;
    const id = requestAnimationFrame(() => {
      try { fitRef.current?.fit(); } catch { /* ignore */ }
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [visible]);

  return (
    <div className={`h-full w-full flex-col bg-slate-950 ${visible ? 'flex' : 'hidden'}`}>
      {status !== 'connected' && (
        <div className={`px-3 py-1 text-[11px] border-b shrink-0 ${
          status === 'connecting'
            ? 'bg-cyan-950/60 text-cyan-300 border-cyan-900'
            : 'bg-amber-950/60 text-amber-300 border-amber-900'
        }`}>
          {status === 'connecting' ? 'Opening shell…' : 'Shell session ended. Use the restart button to reconnect.'}
        </div>
      )}
      <div ref={hostRef} className="flex-1 min-h-0 p-1.5" />
    </div>
  );
};

export default ShellTerminal;
