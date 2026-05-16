// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSavedKeyStatus: () => ipcRenderer.invoke('get-saved-key-status'),
  selectPrivateKey: () => ipcRenderer.invoke('select-private-key'),
  loginWithSavedKey: () => ipcRenderer.invoke('login-with-saved-key'),
  // 新增：清除已保存的私钥配置
  clearPrivateKey: () => ipcRenderer.invoke('clear-private-key')
});