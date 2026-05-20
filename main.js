const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const net = require('net');
const { Client } = require('ssh2');
const path = require('path');
const fs = require('fs');

// ========================== FILE PATHS ==========================
const APP_ICON_PATH = path.join('./', 'assets', 'app-icon.png');
const INDEX_HTML_PATH = path.join(__dirname, 'index.html');
const CONFIG_FILE = path.join(app.getPath('userData'), 'private-key-config.json');
const SSH_CONFIG_STORE = path.join(app.getPath('userData'), 'ssh-config.json');
const NAMED_CONFIGS_STORE = path.join(app.getPath('userData'), 'named-ssh-configs.json');
const APP_STATE_STORE = path.join(app.getPath('userData'), 'app-state.json');

// ========================== GLOBAL VARIABLES ==========================
let sshClient = null;
let localServer = null;
let setupWindow = null;   // Configuration window
let targetWindow = null;  // Target URL window

let SSH_CONFIG = {};
const LOCAL_LISTEN_IP = '127.0.0.1';
let LOCAL_LISTEN_PORT;
const REMOTE_HOST = '127.0.0.1';
let REMOTE_PORT;

// ========================== HEARTBEAT & RECONNECT ==========================
let heartbeatInterval = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;
const HEARTBEAT_INTERVAL_MS = 30000;
const RECONNECT_DELAY_MS = 2000;
let isReconnecting = false;
let tunnelWasConnected = false;
let reconnectingTargetUrl = null;
let wasConnectedBeforeCleanup = false; // Preserve across triggerReconnect → setupSSHTunneling
let lastTargetPageUrl = null; // Pre-disconnect target page URL, used for reload

// ========================== CONFIGURATION MANAGEMENT ==========================
function loadAllNamedConfigs() {
    try {
        if (fs.existsSync(NAMED_CONFIGS_STORE)) {
            return JSON.parse(fs.readFileSync(NAMED_CONFIGS_STORE, 'utf8'));
        }
    } catch (e) {
        console.error('Failed to load configurations:', e.message);
    }
    return {};
}

function saveNamedConfig(configName, config) {
    try {
        const allConfigs = loadAllNamedConfigs();
        allConfigs[configName] = config;
        fs.writeFileSync(NAMED_CONFIGS_STORE, JSON.stringify(allConfigs, null, 2));
    } catch (e) {
        console.error('Failed to save configuration:', e.message);
        throw new Error('Failed to save config: ' + e.message);
    }
}

function getConfigList() {
    const allConfigs = loadAllNamedConfigs();
    return Object.keys(allConfigs).map(name => ({ name }));
}

function loadNamedConfig(configName) {
    const allConfigs = loadAllNamedConfigs();
    if (!allConfigs[configName]) throw new Error('Config not found');
    return allConfigs[configName];
}

function deleteNamedConfig(configName) {
    try {
        const allConfigs = loadAllNamedConfigs();
        if (!allConfigs[configName]) throw new Error('Config not found');
        delete allConfigs[configName];
        fs.writeFileSync(NAMED_CONFIGS_STORE, JSON.stringify(allConfigs, null, 2));
    } catch (e) {
        throw new Error('Failed to delete config: ' + e.message);
    }
}

// ========================== APP STATE (last selected config) ==========================
function loadAppState() {
    try {
        if (fs.existsSync(APP_STATE_STORE)) {
            return JSON.parse(fs.readFileSync(APP_STATE_STORE, 'utf8'));
        }
    } catch (e) {
        console.error('Failed to load app state:', e.message);
    }
    return {};
}

function saveAppState(state) {
    try {
        const existing = loadAppState();
        const merged = { ...existing, ...state };
        fs.writeFileSync(APP_STATE_STORE, JSON.stringify(merged, null, 2));
    } catch (e) {
        console.error('Failed to save app state:', e.message);
    }
}

// ========================== DEFAULT CONFIG & PERSISTENCE ==========================
const DEFAULT_SSH_CONFIG = {
  remoteSshUsername: 'dell',
  remoteSshIp: '222.212.86.164',
  remoteSshPort: 10007,
  forwardTargetPort: 8008,
  localListenPort: 8008,
  targetUrl: 'http://127.0.0.1:8008'
};

function loadSavedConfig() {
  try {
    if (fs.existsSync(SSH_CONFIG_STORE)) {
      const saved = JSON.parse(fs.readFileSync(SSH_CONFIG_STORE, 'utf8'));
      return { ...DEFAULT_SSH_CONFIG, ...saved };
    }
  } catch (e) {
    console.error('Failed to load config:', e.message);
  }
  return DEFAULT_SSH_CONFIG;
}

function saveConfig(config) {
  try {
    const saveData = {
      remoteSshUsername: config.remoteSshUsername,
      remoteSshIp: config.remoteSshIp,
      remoteSshPort: config.remoteSshPort,
      forwardTargetPort: config.forwardTargetPort,
      localListenPort: config.localListenPort,
      targetUrl: config.targetUrl
    };
    fs.writeFileSync(SSH_CONFIG_STORE, JSON.stringify(saveData, null, 2));
  } catch (e) {
    console.error('Failed to save config:', e.message);
  }
}

// ========================== PRIVATE KEY MANAGEMENT ==========================
function savePrivateKeyPath(filePath) {
  try { 
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ privateKeyPath: filePath }, null, 2)); 
  }
  catch (e) { 
    console.error('Failed to save private key:', e.message); 
  }
}

function loadPrivateKeyPath() {
  try { 
    return fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE)).privateKeyPath || null : null; 
  }
  catch (e) { 
    return null; 
  }
}

function checkSavedKeyValid() {
  const p = loadPrivateKeyPath();
  return !!p && fs.existsSync(p);
}

function clearPrivateKeyPath() {
  try { 
    if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE); 
  }
  catch (e) { 
    console.error('Failed to clear key:', e.message); 
  }
}

// ========================== PORT AVAILABILITY CHECK ==========================
function checkPortInUse(port, ip) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => resolve(err.code === 'EADDRINUSE'));
    server.once('listening', () => { server.close(); resolve(false); });
    server.listen(port, ip);
  });
}

// ========================== RESOURCE CLEANUP ==========================
function stopHeartbeat() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
}

function cleanupResources() {
  stopHeartbeat();
  if (sshClient) { sshClient.end(); sshClient = null; }
  if (localServer) { localServer.close(); localServer = null; }
}

function closeTargetWindow() {
  if (targetWindow && !targetWindow.isDestroyed()) {
    targetWindow.destroy();
    targetWindow = null;
  }
}

// ========================== SSH TUNNEL SETUP ==========================
function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    if (sshClient && sshClient.forwardOut) {
      sshClient.forwardOut('127.0.0.1', 0, REMOTE_HOST, REMOTE_PORT, (err, stream) => {
        if (err || !stream) return;
        stream.end();
      });
    }
  }, HEARTBEAT_INTERVAL_MS);
}

async function reconnect() {
  reconnectAttempts++;
  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    console.error(`Reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts, giving up`);
    return { success: false, message: 'Reconnection failed after multiple attempts' };
  }
  const savedUrl = reconnectingTargetUrl;
  console.log(`Attempting reconnect (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
  await new Promise(r => setTimeout(r, RECONNECT_DELAY_MS));
  return await startApplication(savedUrl);
}

function triggerReconnect() {
  if (isReconnecting) return;
  isReconnecting = true;
  // Save "was connected" state BEFORE cleanup so onSshError can use it
  wasConnectedBeforeCleanup = tunnelWasConnected;
  // Save the exact pre-disconnect target URL (not SSH_CONFIG which may have changed)
  const targetPageUrl = targetWindow && !targetWindow.isDestroyed()
    ? targetWindow.getURL()
    : SSH_CONFIG._targetUrl;
  reconnectingTargetUrl = targetPageUrl;

  // Stop heartbeat, close SSH + local server
  stopHeartbeat();
  tunnelWasConnected = false;
  if (sshClient) {
    const origClient = sshClient;
    sshClient = null; // Nullify BEFORE end() to prevent close event from triggering recursive cleanup
    origClient.end();
  }
  if (localServer) { localServer.close(); localServer = null; }

  // Delay to let cleanup complete before reconnecting
  setTimeout(async () => {
    isReconnecting = false;
    if (!reconnectingTargetUrl) {
      console.log('No target URL saved, skipping reconnect');
      return;
    }
    console.log('Triggering reconnect...');
    const result = await reconnect();
    if (!result.success) {
      // Reconnect exhausted - close target and show setup
      closeTargetWindow();
      if (setupWindow && !setupWindow.isDestroyed()) {
        setupWindow.show();
        
      } else {
        createSetupWindow();
      }
    }
  }, 300);
}

function setupSSHTunneling() {
  return new Promise((resolve, reject) => {
    // Capture and reset the state SYNCHRONOUSLY to prevent recursive triggerReconnect from overwriting it
    const wasConnected = wasConnectedBeforeCleanup;
    wasConnectedBeforeCleanup = false;

    // Only cleanup if we're NOT already in a reconnect (triggerReconnect already did cleanup)
    if (!wasConnected) {
      cleanupResources();
    }
    // For reconnect: preserve reconnectAttempts so the > MAX check works
    // For initial connection: reset to 0
    if (!wasConnected) {
      reconnectAttempts = 0;
    }
    sshClient = new Client();

    function onSshError(err) {
      // If the tunnel was active before disconnect, this is a runtime disconnect → reconnect
      if (wasConnected) {
        triggerReconnect();
        return;
      }
      // Initial connection failed
      cleanupResources();
      reject(`SSH connection failed: ${err.message}`);
    }

    sshClient
      .on('ready', () => {
        tunnelWasConnected = true;
        wasConnectedBeforeCleanup = false; // Will be set to true by triggerReconnect on next disconnect
        if (wasConnected) reconnectAttempts = 0; // Reset on successful reconnect
        startHeartbeat();
        localServer = net.createServer((sock) => {
          sshClient.forwardOut('127.0.0.1', 0, REMOTE_HOST, REMOTE_PORT, (err, stream) => {
            if (err) { sock.destroy(); return; }
            stream.on('error', () => { triggerReconnect(); });
            sock.on('error', () => { triggerReconnect(); });
            sock.pipe(stream).pipe(sock);
          });
        });

        localServer.listen(LOCAL_LISTEN_PORT, LOCAL_LISTEN_IP, () => {
          resolve();
        });
      })
      .on('close', () => {
        console.log('SSH tunnel closed');
        // Trigger reconnect if the tunnel was ever connected (even if wasConnected is false for initial setup)
        if (tunnelWasConnected && !isReconnecting) {
          triggerReconnect();
        }
      })
      .on('error', onSshError)
      .connect(SSH_CONFIG);
  });
}

// ========================== WINDOW MANAGEMENT ==========================
async function createTargetWindow(targetUrl) {
  // If an existing window is alive, just reload the URL — don't destroy it (avoids flash)
  if (targetWindow && !targetWindow.isDestroyed()) {
    try {
      await targetWindow.loadURL(targetUrl);
    } catch (loadErr) {
      closeTargetWindow();
      throw loadErr;
    }
    return;
  }

  targetWindow = new BrowserWindow({
    width: 1200, height: 800, icon: APP_ICON_PATH, autoHideMenuBar: true
  });

  // Suppress Chromium page load error dialog for disconnected tunnel
  targetWindow.webContents.on('did-fail-load', () => {
    // Silently ignore — loadURL() rejection is handled by try/catch
  });
  targetWindow.webContents.on('page-favicon-updated', () => {});
  targetWindow.webContents.on('page-error', () => {
    // Suppress error dialog
  });

  targetWindow.on('closed', () => { targetWindow = null; });
  try {
    await targetWindow.loadURL(targetUrl);
  } catch (loadErr) {
    // loadURL may reject on tunnel disconnect — tunnel's reconnect handler manages recovery
    closeTargetWindow();
    throw loadErr;
  }
}

function createSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 560, height: 580, icon: APP_ICON_PATH, resizable: false, autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
  });
  setupWindow.loadFile(INDEX_HTML_PATH);
  setupWindow.on('closed', () => { setupWindow = null; });
}

// ========================== CORE LOGIN LOGIC ==========================
async function startApplication(targetUrl) {
  try {
    SSH_CONFIG._targetUrl = targetUrl;
    // Port check
    const occupied = await checkPortInUse(LOCAL_LISTEN_PORT, LOCAL_LISTEN_IP);
    if (occupied) {
      return { success: false, message: `Port ${LOCAL_LISTEN_PORT} is in use` };
    }

    // Create SSH tunnel
    await setupSSHTunneling();
    // Open target URL window
    await createTargetWindow(targetUrl);

    // Login SUCCESS → CLOSE setup window
    if (setupWindow && !setupWindow.isDestroyed()) {
      setupWindow.close();
    }

    return { success: true, message: 'SSH tunnel established successfully' };
  } catch (err) {
    // If a reconnect is already in progress, don't destroy the target window
    if (isReconnecting) {
      console.log('Reconnect already in progress, skipping cleanup');
      return { success: false, message: err.toString() };
    }
    cleanupResources();
    closeTargetWindow();
    return { success: false, message: err.toString() };
  }
}

// ========================== IPC HANDLERS ==========================
ipcMain.handle('get-saved-key-status', () => ({ hasSavedKey: checkSavedKeyValid() }));
ipcMain.handle('clear-private-key', () => clearPrivateKeyPath());
ipcMain.handle('get-default-config', () => loadSavedConfig());
ipcMain.handle('get-config-list', () => getConfigList());
ipcMain.handle('save-named-config', (e, n, c) => saveNamedConfig(n, c));
ipcMain.handle('load-named-config', (e, n) => loadNamedConfig(n));
ipcMain.handle('delete-named-config', (e, n) => deleteNamedConfig(n));
ipcMain.handle('save-app-state', (_e, state) => saveAppState(state));
ipcMain.handle('get-app-state', () => loadAppState());

ipcMain.handle('select-private-key', async (event, config) => {
  saveConfig(config);
  SSH_CONFIG = { host: config.remoteSshIp, port: config.remoteSshPort, username: config.remoteSshUsername, readyTimeout: 15000, _targetUrl: config.targetUrl };
  LOCAL_LISTEN_PORT = config.localListenPort;
  REMOTE_PORT = config.forwardTargetPort;

  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Select Private Key', defaultPath: path.join(app.getPath('home'), '.ssh'), properties: ['openFile']
  });
  if (canceled) return { success: false, message: 'Selection canceled' };

  try {
    savePrivateKeyPath(filePaths[0]);
    return { success: true, message: 'Private key saved successfully' };
  } catch (e) {
    clearPrivateKeyPath();
    return { success: false, message: 'Invalid private key file' };
  }
});

ipcMain.handle('login-with-saved-key', async (event, config) => {
  saveConfig(config);
  SSH_CONFIG = { host: config.remoteSshIp, port: config.remoteSshPort, username: config.remoteSshUsername, readyTimeout: 15000, _targetUrl: config.targetUrl };
  LOCAL_LISTEN_PORT = config.localListenPort;
  REMOTE_PORT = config.forwardTargetPort;

  const keyPath = loadPrivateKeyPath();
  if (!keyPath || !fs.existsSync(keyPath)) {
    clearPrivateKeyPath();
    return { success: false, message: 'No valid private key found' };
  }

  try {
    SSH_CONFIG.privateKey = fs.readFileSync(keyPath);
    return await startApplication(config.targetUrl);
  } catch (e) {
    clearPrivateKeyPath();
    cleanupResources();
    closeTargetWindow();
    return { success: false, message: 'Private key corrupted' };
  }
});

// ========================== APP LIFECYCLE ==========================
// Prevent tunnel disconnect errors from showing a dialog
process.on('uncaughtException', (err) => {
  if (err.code === 'ECONNRESET') {
    console.log('Caught ECONNRESET, tunnel reconnect handler will manage recovery');
  } else {
    console.error('Uncaught exception:', err);
  }
});

app.whenReady().then(createSetupWindow);

app.on('window-all-closed', () => {
  cleanupResources();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!setupWindow) createSetupWindow();
});