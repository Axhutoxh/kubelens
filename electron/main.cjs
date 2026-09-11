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
  const isWin = process.platform === 'win32';
  const binName = isWin ? 'freelens-rust.exe' : 'freelens-rust';
  const rootDir = path.resolve(__dirname, '..');

  const candidates = [
    // 1. Packaged extraResources
    process.resourcesPath && path.join(process.resourcesPath, binName),
    process.resourcesPath && path.join(process.resourcesPath, 'bin', binName),
    process.resourcesPath && path.join(process.resourcesPath, 'app.asar.unpacked', binName),
    // 2. Project root / local development
    path.join(rootDir, binName),
    path.join(rootDir, 'target', 'release', binName),
    path.join(rootDir, 'target', 'debug', binName),
    path.join(__dirname, '..', '..', binName),
    path.join(__dirname, binName),
  ].filter(Boolean);

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
    console.warn('[Electron] freelens-rust backend executable not found. Proceeding assuming server will be started manually.');
    return;
  }

  console.log(`[Electron] Starting backend process: ${exePath}`);
  const rootDir = path.resolve(__dirname, '..');
  const workingDir = app.isPackaged ? path.dirname(exePath) : rootDir;

  const staticDirCandidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'dist'),
    process.resourcesPath && path.join(process.resourcesPath, 'frontend', 'dist'),
    path.join(rootDir, 'dist'),
    path.join(rootDir, 'frontend', 'dist'),
    path.resolve(__dirname, '..', 'dist'),
    path.resolve(__dirname, '..', '..', 'dist'),
    path.resolve(__dirname, '..', '..', 'frontend', 'dist'),
  ].filter(Boolean);

  let staticDir = '';
  for (const d of staticDirCandidates) {
    if (fs.existsSync(path.join(d, 'index.html'))) {
      staticDir = d;
      break;
    }
  }
  if (!staticDir) {
    for (const d of staticDirCandidates) {
      if (fs.existsSync(d)) {
        staticDir = d;
        break;
      }
    }
  }

  console.log(`[Electron] Using frontend static directory: ${staticDir || '(auto-detect)'}`);

  backendProcess = spawn(exePath, [], {
    cwd: workingDir,
    env: {
      ...process.env,
      FREELENS_NO_BROWSER: '1',
      FREELENS_ELECTRON: '1',
      FREELENS_STATIC_DIR: staticDir,
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
    title: 'lensbyacp - Kubernetes IDE',
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

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[Renderer LOG ${level}] ${message} (${sourceId}:${line})`);
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error(`[Renderer FAILED LOAD] code=${errorCode} error=${errorDescription} url=${validatedURL}`);
    // Auto-retry if backend was still binding
    if (validatedURL && validatedURL.includes('localhost') && errorCode !== -3) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          const devUrl = process.env.VITE_DEV_SERVER_URL;
          mainWindow.loadURL(devUrl || targetUrl);
        }
      }, 1000);
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log(`[Renderer FINISHED LOAD] current URL=${mainWindow.webContents.getURL()}`);
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
          width: 36px;
          height: 36px;
          border: 3px solid rgba(6, 182, 212, 0.15);
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
          font-size: 18px;
          font-weight: 700;
          letter-spacing: -0.01em;
          color: #f1f5f9;
        }
        .sub {
          font-size: 12px;
          color: #38bdf8;
          margin-top: 4px;
        }
        .author {
          font-size: 11px;
          color: #64748b;
          margin-top: 8px;
          font-weight: 500;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="spinner"></div>
        <div class="title">lensbyacp</div>
        <div class="sub">Initializing Kubernetes cluster engine...</div>
        <div class="author">Developed by Ashutosh Chandra</div>
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
