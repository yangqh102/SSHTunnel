const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const net = require('net');
const { Client } = require('ssh2');
const path = require('path');
const fs = require('fs');

// ========================== FILE PATHS ==========================
const APP_ICON_PATH = path.join('./', 'assets', 'app-icon.png');
const INDEX_HTML_PATH = path.join(__dirname, 'index.html');
const CONFIG_FILE = path.join(app.getPath('userData'), 'private-key-config.json');

// ========================== GLOBAL VARIABLES ==========================
let sshClient = null;
let localServer = null;
let mainWindow = null;

// ALL CONFIGS ARE FROM FRONTEND, NO HARDCODED VALUES
let SSH_CONFIG = {}; // Empty object, filled by frontend data
const LOCAL_LISTEN_IP = '127.0.0.1'; // 固定本地监听IP
let LOCAL_LISTEN_PORT;
const REMOTE_HOST = '127.0.0.1'; // Fixed remote forward host (standard for SSH tunnel)
let REMOTE_PORT;

// ========================== PRIVATE KEY UTILS ==========================
function savePrivateKeyPath(filePath) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify({ privateKeyPath: filePath }, null, 2)); }
  catch (e) { console.error('Failed to save private key:', e.message); }
}

function loadPrivateKeyPath() {
  try { return fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE)).privateKeyPath || null : null; }
  catch (e) { return null; }
}

function checkSavedKeyValid() {
  const p = loadPrivateKeyPath();
  return !!p && fs.existsSync(p);
}

function clearPrivateKeyPath() {
  try { if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE); }
  catch (e) { console.error('Failed to clear config:', e.message); }
}

// ========================== PORT OCCUPANCY CHECK ==========================
function checkPortInUse(port, ip) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => resolve(err.code === 'EADDRINUSE'));
    server.once('listening', () => { server.close(); resolve(false); });
    server.listen(port, ip);
  });
}

// ========================== SSH TUNNEL SETUP ==========================
function setupSSHTunneling() {
  return new Promise((resolve, reject) => {
    sshClient = new Client();
    sshClient
      .on('ready', () => {
        console.log('SSH client connected successfully');
        localServer = net.createServer((sock) => {
          sshClient.forwardOut('127.0.0.1', 0, REMOTE_HOST, REMOTE_PORT, (err, stream) => {
            if (err) { console.error('Forward failed:', err.message); sock.destroy(); return; }
            sock.pipe(stream).pipe(sock);
          });
        });

        localServer.listen(LOCAL_LISTEN_PORT, LOCAL_LISTEN_IP, () => {
          console.log(`Local server listening on ${LOCAL_LISTEN_IP}:${LOCAL_LISTEN_PORT}`);
          resolve();
        });

        localServer.on('error', (err) => reject(`Local server error: ${err.message}`));
      })
      .on('error', (err) => reject(`SSH connection failed: ${err.message}`))
      .on('end', () => console.log('SSH connection closed'))
      .connect(SSH_CONFIG);
  });
}

// ========================== WINDOW MANAGEMENT ==========================
async function createMainWindow() {
  mainWindow = new BrowserWindow({ 
    width: 1200, 
    height: 800, 
    icon: APP_ICON_PATH,
    autoHideMenuBar: true 
  });
  await mainWindow.loadURL(`http://${LOCAL_LISTEN_IP}:${LOCAL_LISTEN_PORT}`);
  mainWindow.on('closed', () => mainWindow = null);
}

function createSetupWindow() {
  mainWindow = new BrowserWindow({
    width: 600, 
    height: 580, // 适配新增的用户名输入框，适当增加高度
    icon: APP_ICON_PATH,
    resizable: false, 
    autoHideMenuBar: true, 
    frame: true,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
  });
  mainWindow.loadFile(INDEX_HTML_PATH);
  mainWindow.on('closed', () => mainWindow = null);
}

// ========================== APP START ==========================
async function startApplication(setupWin) {
  try {
    const occupied = await checkPortInUse(LOCAL_LISTEN_PORT, LOCAL_LISTEN_IP);
    if (occupied) {
      const msg = `Port ${LOCAL_LISTEN_PORT} on ${LOCAL_LISTEN_IP} is in use`;
      console.error(msg);
      return { success: false, message: msg };
    }

    await setupSSHTunneling();
    await createMainWindow();
    if (setupWin && !setupWin.isDestroyed()) setupWin.close();
    return { success: true, message: 'SSH tunnel established successfully' };
  } catch (err) {
    clearPrivateKeyPath();
    console.error('Startup failed:', err);
    return { success: false, message: err };
  }
}

// ========================== IPC HANDLERS (READ ALL DATA FROM FRONTEND) ==========================
ipcMain.handle('get-saved-key-status', () => ({ hasSavedKey: checkSavedKeyValid() }));
ipcMain.handle('clear-private-key', () => clearPrivateKeyPath());

// Select private key & login (ALL configs from frontend)
ipcMain.handle('select-private-key', async (event, config) => {
  // Assign ALL configs from frontend, NO hardcoded values
  SSH_CONFIG.host = config.remoteSshIp;
  SSH_CONFIG.port = config.remoteSshPort;
  // 修改：从前端配置读取用户名（移除硬编码的 'dell'）
  SSH_CONFIG.username = config.remoteSshUsername;
  SSH_CONFIG.readyTimeout = 15000;
  SSH_CONFIG.keepaliveInterval = 30000;
  
  LOCAL_LISTEN_PORT = config.localListenPort; // 仅接收本地端口，IP已固定
  REMOTE_PORT = config.forwardTargetPort;

  console.log('Loaded config from frontend:', config);

  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Select Private Key', defaultPath: path.join(app.getPath('home'), '.ssh'), properties: ['openFile']
  });
  if (canceled) return { success: false, message: 'Selection canceled' };

  try {
    SSH_CONFIG.privateKey = fs.readFileSync(filePaths[0]);
    savePrivateKeyPath(filePaths[0]);
    return await startApplication(event.sender.getOwnerBrowserWindow());
  } catch (e) {
    clearPrivateKeyPath();
    return { success: false, message: 'Invalid private key file' };
  }
});

// Login with saved key (ALL configs from frontend)
ipcMain.handle('login-with-saved-key', async (event, config) => {
  // Assign ALL configs from frontend, NO hardcoded values
  SSH_CONFIG.host = config.remoteSshIp;
  SSH_CONFIG.port = config.remoteSshPort;
  // 修改：从前端配置读取用户名（移除硬编码的 'dell'）
  SSH_CONFIG.username = config.remoteSshUsername;
  SSH_CONFIG.readyTimeout = 15000;
  SSH_CONFIG.keepaliveInterval = 30000;
  
  LOCAL_LISTEN_PORT = config.localListenPort; // 仅接收本地端口，IP已固定
  REMOTE_PORT = config.forwardTargetPort;

  console.log('Login config from frontend:', config);

  const keyPath = loadPrivateKeyPath();
  if (!keyPath || !fs.existsSync(keyPath)) {
    clearPrivateKeyPath();
    return { success: false, message: 'No valid private key found' };
  }

  try {
    SSH_CONFIG.privateKey = fs.readFileSync(keyPath);
    return await startApplication(event.sender.getOwnerBrowserWindow());
  } catch (e) {
    clearPrivateKeyPath();
    return { success: false, message: 'Private key corrupted' };
  }
});

// ========================== APP LIFECYCLE ==========================
app.whenReady().then(createSetupWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
  if (sshClient) sshClient.end();
  if (localServer) localServer.close();
  console.log('Application closed, resources cleaned up');
});