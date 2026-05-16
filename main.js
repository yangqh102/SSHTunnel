const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const net = require('net');
const { Client } = require('ssh2');
const path = require('path');
const fs = require('fs');

// ========================== FILE PATHS ==========================
const APP_ICON_PATH = path.join('./', 'assets', 'app-icon.png');
const INDEX_HTML_PATH = path.join(__dirname, 'index.html');
const CONFIG_FILE = path.join(app.getPath('userData'), 'private-key-config.json');
// 新增：SSH配置缓存文件（持久化保存用户名/IP/端口）
const SSH_CONFIG_STORE = path.join(app.getPath('userData'), 'ssh-config.json');

// ========================== GLOBAL VARIABLES ==========================
let sshClient = null;
let localServer = null;
let mainWindow = null;

let SSH_CONFIG = {};
const LOCAL_LISTEN_IP = '127.0.0.1';
let LOCAL_LISTEN_PORT;
const REMOTE_HOST = '127.0.0.1';
let REMOTE_PORT;

// ========================== 新增：配置持久化工具函数 ==========================
// 默认配置（第一次打开使用）
const DEFAULT_SSH_CONFIG = {
  remoteSshUsername: 'dell',
  remoteSshIp: '222.212.86.164',
  remoteSshPort: 10007,
  forwardTargetPort: 8008,
  localListenPort: 8008
};

// 加载保存的配置（无缓存则返回默认值）
function loadSavedConfig() {
  try {
    if (fs.existsSync(SSH_CONFIG_STORE)) {
      const saved = JSON.parse(fs.readFileSync(SSH_CONFIG_STORE, 'utf8'));
      return { ...DEFAULT_SSH_CONFIG, ...saved };
    }
  } catch (e) {
    console.error('加载配置失败:', e.message);
  }
  return DEFAULT_SSH_CONFIG;
}

// 保存配置到本地
function saveConfig(config) {
  try {
    const saveData = {
      remoteSshUsername: config.remoteSshUsername,
      remoteSshIp: config.remoteSshIp,
      remoteSshPort: config.remoteSshPort,
      forwardTargetPort: config.forwardTargetPort,
      localListenPort: config.localListenPort
    };
    fs.writeFileSync(SSH_CONFIG_STORE, JSON.stringify(saveData, null, 2));
  } catch (e) {
    console.error('保存配置失败:', e.message);
  }
}

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
    height: 580,
    icon: APP_ICON_PATH,
    resizable: false, 
    autoHideMenuBar: true, 
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

// ========================== IPC HANDLERS ==========================
ipcMain.handle('get-saved-key-status', () => ({ hasSavedKey: checkSavedKeyValid() }));
ipcMain.handle('clear-private-key', () => clearPrivateKeyPath());

// 新增：前端获取默认配置
ipcMain.handle('get-default-config', () => loadSavedConfig());

// 选择密钥并登录（自动保存配置）
ipcMain.handle('select-private-key', async (event, config) => {
  // 自动保存最新配置
  saveConfig(config);
  
  SSH_CONFIG.host = config.remoteSshIp;
  SSH_CONFIG.port = config.remoteSshPort;
  SSH_CONFIG.username = config.remoteSshUsername;
  SSH_CONFIG.readyTimeout = 15000;
  SSH_CONFIG.keepaliveInterval = 30000;
  
  LOCAL_LISTEN_PORT = config.localListenPort;
  REMOTE_PORT = config.forwardTargetPort;

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

// 使用保存的密钥登录（自动保存配置）
ipcMain.handle('login-with-saved-key', async (event, config) => {
  // 自动保存最新配置
  saveConfig(config);
  
  SSH_CONFIG.host = config.remoteSshIp;
  SSH_CONFIG.port = config.remoteSshPort;
  SSH_CONFIG.username = config.remoteSshUsername;
  SSH_CONFIG.readyTimeout = 15000;
  SSH_CONFIG.keepaliveInterval = 30000;
  
  LOCAL_LISTEN_PORT = config.localListenPort;
  REMOTE_PORT = config.forwardTargetPort;

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