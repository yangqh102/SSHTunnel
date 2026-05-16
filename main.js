const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const net = require('net');
const { Client } = require('ssh2');
const path = require('path');
const fs = require('fs');

// ====================== 配置 ======================
const SSH_CONFIG = {
  host: '222.212.86.164',
  port: 10007,
  username: 'dell',
  privateKey: null,
  readyTimeout: 5000,
  keepaliveInterval: 30000,
};

const INDEX_HTML_PATH = path.join(__dirname, 'index.html');
const CONFIG_FILE = path.join(app.getPath('userData'), 'private-key-config.json');

// ====================== 全局变量 ======================
let sshClient = null;
let localServer = null;
let mainWindow = null;
const LOCAL_PORT = 80;
const REMOTE_HOST = '127.0.0.1';
const REMOTE_PORT = 8008;

// ====================== 配置工具函数 ======================
// 保存密钥路径
function savePrivateKeyPath(filePath) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify({ privateKeyPath: filePath }, null, 2)); }
  catch (e) { console.error('保存密钥失败', e); }
}

// 加载密钥路径
function loadPrivateKeyPath() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE)).privateKeyPath || null;
  } catch (e) {}
  return null;
}

// 检查密钥有效性
function checkSavedKeyValid() {
  const p = loadPrivateKeyPath();
  return !!p && fs.existsSync(p);
}

// 【核心】清除密钥配置文件（所有失败场景调用）
function clearPrivateKeyPath() {
  try { if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE); }
  catch (e) { console.error('清除配置失败', e); }
}

// ====================== SSH 隧道 ======================
function setupSSHTunneling() {
  return new Promise((resolve, reject) => {
    sshClient = new Client();
    sshClient
      .on('ready', () => {
        localServer = net.createServer((sock) => {
          sshClient.forwardOut('localhost', LOCAL_PORT, REMOTE_HOST, REMOTE_PORT, (err, stream) => {
            if (err) { sock.destroy(); return; }
            sock.pipe(stream).pipe(sock);
          });
        }).listen(LOCAL_PORT, 'localhost', () => resolve());
      })
      .on('error', (e) => reject(e.message))
      .connect(SSH_CONFIG);
  });
}

// ====================== 窗口创建 ======================
async function createMainWindow() {
  mainWindow = new BrowserWindow({ width: 1200, height: 800, autoHideMenuBar: true });
  await mainWindow.loadURL(`http://localhost:${LOCAL_PORT}`);
  mainWindow.on('closed', () => mainWindow = null);
}

function createSetupWindow() {
  mainWindow = new BrowserWindow({
    width: 600, height: 450, resizable: false,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
  });
  mainWindow.loadFile(INDEX_HTML_PATH);
  mainWindow.on('closed', () => mainWindow = null);
}

// 启动应用（失败自动清除配置）
async function startApplication(setupWin) {
  try {
    await setupSSHTunneling();
    await createMainWindow();
    if (setupWin && !setupWin.isDestroyed()) setupWin.close();
    return { success: true, message: 'Login successful!' };
  } catch (err) {
    // 【核心】SSH登录失败 → 自动清除无效密钥配置
    clearPrivateKeyPath();
    return { success: false, message: `SSH连接失败: ${err}` };
  }
}

// ====================== IPC 通信 ======================
ipcMain.handle('get-saved-key-status', () => ({ hasSavedKey: checkSavedKeyValid() }));
ipcMain.handle('clear-private-key', () => clearPrivateKeyPath());

// 选择私钥
ipcMain.handle('select-private-key', async (e) => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Select id_rsa', defaultPath: path.join(app.getPath('home'), '.ssh'), properties: ['openFile']
  });
  if (canceled) return { success: false, message: '取消选择' };

  const keyPath = filePaths[0];
  try {
    // 尝试读取密钥文件
    SSH_CONFIG.privateKey = fs.readFileSync(keyPath);
    savePrivateKeyPath(keyPath);
    // 启动应用，失败会自动清除配置
    return await startApplication(e.sender.getOwnerBrowserWindow());
  } catch (e) {
    // 【核心】密钥文件无效 → 自动清除配置
    clearPrivateKeyPath();
    return { success: false, message: '无效的密钥文件' };
  }
});

// 使用保存的密钥登录
ipcMain.handle('login-with-saved-key', async (e) => {
  const keyPath = loadPrivateKeyPath();
  if (!keyPath || !fs.existsSync(keyPath)) {
    clearPrivateKeyPath();
    return { success: false, message: '未找到有效密钥' };
  }

  try {
    SSH_CONFIG.privateKey = fs.readFileSync(keyPath);
    return await startApplication(e.sender.getOwnerBrowserWindow());
  } catch (e) {
    // 【核心】密钥损坏 → 自动清除配置
    clearPrivateKeyPath();
    return { success: false, message: '密钥文件已损坏' };
  }
});

// ====================== 应用启动 ======================
app.whenReady().then(createSetupWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
  if (sshClient) sshClient.end();
  if (localServer) localServer.close();
});