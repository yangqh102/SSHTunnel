// Preload script: Expose safe IPC APIs to renderer process
const { contextBridge, ipcRenderer } = require('electron');

// Expose Electron API to window global object
contextBridge.exposeInMainWorld('electronAPI', {
  getSavedKeyStatus: () => ipcRenderer.invoke('get-saved-key-status'),
  selectPrivateKey: (localPort) => ipcRenderer.invoke('select-private-key', localPort),
  loginWithSavedKey: (localPort) => ipcRenderer.invoke('login-with-saved-key', localPort),
  clearPrivateKey: () => ipcRenderer.invoke('clear-private-key')
});