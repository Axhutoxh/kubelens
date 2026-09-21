const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('freelensDesktop', {
  isElectron: true,
  platform: process.platform,
  version: process.versions.electron,
  appVersion: '1.0.1',
});
