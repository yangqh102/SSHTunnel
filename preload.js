// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectPrivateKey: () => ipcRenderer.invoke('select-private-key')
});