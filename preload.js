const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // 原有接口
  getSavedKeyStatus: () => ipcRenderer.invoke('get-saved-key-status'),
  selectPrivateKey: (config) => ipcRenderer.invoke('select-private-key', config),
  loginWithSavedKey: (config) => ipcRenderer.invoke('login-with-saved-key', config),
  clearPrivateKey: () => ipcRenderer.invoke('clear-private-key'),
  
  // 新增：获取默认缓存配置
  getDefaultConfig: () => ipcRenderer.invoke('get-default-config')
})