const { contextBridge, ipcRenderer } = require('electron')

// Expose Electron API to renderer process (frontend)
contextBridge.exposeInMainWorld('electronAPI', {
  // Key & Default Config
  getSavedKeyStatus: () => ipcRenderer.invoke('get-saved-key-status'),
  selectPrivateKey: (config) => ipcRenderer.invoke('select-private-key', config),
  loginWithSavedKey: (config) => ipcRenderer.invoke('login-with-saved-key', config),
  clearPrivateKey: () => ipcRenderer.invoke('clear-private-key'),
  getDefaultConfig: () => ipcRenderer.invoke('get-default-config'),
  
  // Named Configuration Management
  getConfigList: () => ipcRenderer.invoke('get-config-list'),
  saveNamedConfig: (configName, config) => ipcRenderer.invoke('save-named-config', configName, config),
  loadNamedConfig: (configName) => ipcRenderer.invoke('load-named-config', configName),
  deleteNamedConfig: (configName) => ipcRenderer.invoke('delete-named-config', configName),

  // App State
  saveAppState: (state) => ipcRenderer.invoke('save-app-state', state),
  getAppState: () => ipcRenderer.invoke('get-app-state')
})