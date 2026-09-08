const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');
const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');

let mainWindow = null;
let backendProcess = null;
let targetUrl = 'http://localhost:9090';

// Find the backend executable path
function findBackendExe() {
  const rootDir = path.resolve(__dirname, '..');
  const candidates = [
    path.join(rootDir, 'freelens-rust.exe'),
    path.join(rootDir, 'target', 'release', 'freelens-rust.exe'),
    path.join(rootDir, 'target', 'debug', 'freelens-rust.exe'),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

// Health check to verify if the backend is ready to accept requests
function checkServerReady(url) {
  return new Promise((resolve) => {
    const testUrl = new URL('/api/contexts', url);
    const req = http.get(testUrl.toString(), { timeout: 1000 }, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

// Wait for backend to be ready with timeout
async function waitForBackend(url, maxWaitMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const ready = await checkServerReady(url);
    if (ready) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// Launch the backend process if not already running
async function startBackend() {
  // Check if server is already running (e.g. started externally or in dev)
  const isAlreadyRunning = await checkServerReady(targetUrl);
  if (isAlreadyRunning) {
    console.log(`[Electron] Freelens backend already active at ${targetUrl}`);
    return;
  }

  const exePath = findBackendExe();
  if (!exePath) {
    console.warn('[Electron] freelens-rust.exe not found. Proceeding assuming server will be started manually.');
    return;
  }

  console.log(`[Electron] Starting backend process: ${exePath}`);
  const rootDir = path.resolve(__dirname, '..');

  backendProcess = spawn(exePath, [], {
    cwd: rootDir,
    env: {
      ...process.env,
      FREELENS_NO_BROWSER: '1',
      FREELENS_ELECTRON: '1',
      PORT: '9090',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  backendProcess.stdout.on('data', (data) => {
    const text = data.toString();
    process.stdout.write(`[Rust] ${text}`);
    // Extract dynamic port if printed
    const match = text.match(/http:\/\/localhost:(\d+)/i);
    if (match && match[1]) {
      targetUrl = `http://localhost:${match[1]}`;
    }
  });

  backendProcess.stderr.on('data', (data) => {
    process.stderr.write(`[Rust ERR] ${data.toString()}`);
  });

  backendProcess.on('exit', (code, signal) => {
    console.log(`[Electron] Backend process exited with code ${code}, signal ${signal}`);
    backendProcess = null;
  });
}

// Safely kill backend process on Windows / Unix
function killBackend() {
  if (backendProcess && !backendProcess.killed) {
    console.log('[Electron] Terminating backend process...');
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /pid ${backendProcess.pid} /T /F`, { stdio: 'ignore', windowsHide: true });
      } else {
        backendProcess.kill('SIGKILL');
      }
    } catch {
      try {
        backendProcess.kill();
      } catch {
        // ignore
      }
    }
    backendProcess = null;
  }
}

// Create the main Electron application window
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#020617', // Slate-950 dark theme
    title: 'Freelens - Kubernetes IDE',
    autoHideMenuBar: true,
    show: false, // will show when content is ready
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });

  // Intercept external links to open in the system default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Display initial dark loading state while backend spins up
  const loadingHtml = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <style>
        body {
          margin: 0;
          background: #020617;
          color: #f8fafc;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100vh;
          overflow: hidden;
          user-select: none;
        }
        .spinner {
          width: 32px;
          height: 32px;
          border: 3px solid rgba(6, 182, 212, 0.2);
          border-top-color: #06b6d4;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
          margin-bottom: 16px;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        .container {
          text-align: center;
          display: flex;
          flex-direction: column;
          align-items: center;
        }
        .title {
          font-size: 16px;
          font-weight: 600;
          letter-spacing: -0.01em;
          color: #e2e8f0;
        }
        .sub {
          font-size: 12px;
          color: #64748b;
          margin-top: 4px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="spinner"></div>
        <div class="title">Freelens Kubernetes IDE</div>
        <div class="sub">Initializing cluster engine...</div>
      </div>
    </body>
    </html>
  `;
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml)}`);
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// App lifecycle
app.whenReady().then(async () => {
  createMainWindow();
  await startBackend();

  // Wait until the backend is fully responding
  const ready = await waitForBackend(targetUrl);
  if (!ready) {
    console.error(`[Electron] Backend did not respond at ${targetUrl} within timeout.`);
  }

  // Load the live dashboard
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const urlToLoad = devUrl || targetUrl;
  console.log(`[Electron] Loading dashboard URL: ${urlToLoad}`);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(urlToLoad);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
      if (mainWindow) mainWindow.loadURL(urlToLoad);
    }
  });
});

// Clean shutdown
app.on('window-all-closed', () => {
  killBackend();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  killBackend();
});

process.on('exit', () => {
  killBackend();
});

process.on('SIGINT', () => {
  killBackend();
  process.exit(0);
});

process.on('SIGTERM', () => {
  killBackend();
  process.exit(0);
});
