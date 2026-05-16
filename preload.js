// Preload script: Expose safe IPC APIs to renderer process
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSavedKeyStatus: () => ipcRenderer.invoke('get-saved-key-status'),
  selectPrivateKey: (config) => ipcRenderer.invoke('select-private-key', config),
  loginWithSavedKey: (config) => ipcRenderer.invoke('login-with-saved-key', config),
  clearPrivateKey: () => ipcRenderer.invoke('clear-private-key')
});