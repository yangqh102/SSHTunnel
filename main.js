const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const net = require('net');
const { Client } = require('ssh2');
const path = require('path');
const fs = require('fs');

// ====================== SSH Configuration ======================
const SSH_CONFIG = {
  host: '222.212.86.164',
  port: 10007,
  username: 'dell',
  privateKey: null,
  readyTimeout: 15000,
  keepaliveInterval: 30000,
};

// File paths
const APP_ICON_PATH = path.join('./', 'assets', 'app-icon.png');
const INDEX_HTML_PATH = path.join(__dirname, 'index.html');
const CONFIG_FILE = path.join(app.getPath('userData'), 'private-key-config.json');

// ====================== Global Variables ======================
let sshClient = null;
let localServer = null;
let mainWindow = null;

// Remote target address (fixed, no user input required)
const REMOTE_HOST = '127.0.0.1';
const REMOTE_PORT = 8008;

// Local listen port (user-defined, default: 8008)
let LOCAL_LISTEN_PORT = 8008;

// ====================== Config Utility Functions ======================
/**
 * Save private key path to config file
 * @param {string} filePath - Private key file path
 */
function savePrivateKeyPath(filePath) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ privateKeyPath: filePath }, null, 2));
  } catch (e) {
    console.error('Failed to save private key path:', e.message);
  }
}

/**
 * Load saved private key path from config file
 * @returns {string|null} Private key path or null
 */
function loadPrivateKeyPath() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE)).privateKeyPath || null;
    }
  } catch (e) {
    console.error('Failed to load private key path:', e.message);
  }
  return null;
}

/**
 * Check if saved private key is valid
 * @returns {boolean} True if key exists and is valid
 */
function checkSavedKeyValid() {
  const keyPath = loadPrivateKeyPath();
  return !!keyPath && fs.existsSync(keyPath);
}

/**
 * Clear invalid private key config file
 */
function clearPrivateKeyPath() {
  try {
    if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
  } catch (e) {
    console.error('Failed to clear config file:', e.message);
  }
}

// ====================== Port Occupancy Check ======================
/**
 * Check if a local port is in use
 * @param {number} port - Port number to check
 * @returns {Promise<boolean>} True if port is occupied
 */
function checkPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      resolve(err.code === 'EADDRINUSE');
    });
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port, '127.0.0.1');
  });
}

// ====================== SSH Tunnel Setup ======================
/**
 * Create SSH tunnel and local TCP server
 * @returns {Promise<void>} Tunnel setup result
 */
function setupSSHTunneling() {
  return new Promise((resolve, reject) => {
    sshClient = new Client();

    sshClient
      .on('ready', () => {
        console.log('SSH client connected successfully');
        
        // Start local TCP server for port forwarding
        localServer = net.createServer((sock) => {
          sshClient.forwardOut('127.0.0.1', 0, REMOTE_HOST, REMOTE_PORT, (err, stream) => {
            if (err) {
              console.error('SSH port forwarding failed:', err.message);
              sock.destroy();
              return;
            }
            sock.pipe(stream).pipe(sock);
          });
        });

        // Listen on user-defined local port
        localServer.listen(LOCAL_LISTEN_PORT, '127.0.0.1', () => {
          console.log(`Local server listening on port ${LOCAL_LISTEN_PORT}`);
          resolve();
        });

        localServer.on('error', (err) => {
          console.error('Local server error:', err.message);
          reject(`Local server failed to start: ${err.message}`);
        });
      })
      .on('error', (err) => {
        console.error('SSH connection failed:', err.message);
        reject(`SSH connection failed: ${err.message}`);
      })
      .on('end', () => {
        console.log('SSH connection closed');
      })
      .connect(SSH_CONFIG);
  });
}

// ====================== Window Management ======================
/**
 * Create main application window after tunnel is ready
 */
async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: APP_ICON_PATH,
    autoHideMenuBar: true
  });
  await mainWindow.loadURL(`http://localhost:${LOCAL_LISTEN_PORT}`);
  mainWindow.on('closed', () => mainWindow = null);
}

/**
 * Create setup window for key/port configuration
 */
function createSetupWindow() {
  mainWindow = new BrowserWindow({
    width: 600,
    height: 480,
    icon: APP_ICON_PATH,
    resizable: false,
    autoHideMenuBar: true,  // 隐藏顶部菜单控制栏 ✅
    frame: true,           // 彻底关闭顶部标题栏/边框（纯界面）✅
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  mainWindow.loadFile(INDEX_HTML_PATH);
  mainWindow.on('closed', () => mainWindow = null);
}

// ====================== Application Startup ======================
/**
 * Start application: check port → create SSH tunnel → open main window
 * @param {BrowserWindow} setupWin - Setup window to close on success
 * @returns {Promise<object>} Result object with success/error message
 */
async function startApplication(setupWin) {
  try {
    // Step 1: Check if local port is occupied
    const isPortOccupied = await checkPortInUse(LOCAL_LISTEN_PORT);
    if (isPortOccupied) {
      const errorMsg = `Port ${LOCAL_LISTEN_PORT} is already in use, please enter a new port`;
      console.error(errorMsg);
      return { success: false, message: errorMsg };
    }

    // Step 2: Establish SSH tunnel
    await setupSSHTunneling();

    // Step 3: Open main window and close setup window
    await createMainWindow();
    if (setupWin && !setupWin.isDestroyed()) setupWin.close();

    return { success: true, message: 'Login successful! SSH tunnel established' };
  } catch (err) {
    clearPrivateKeyPath();
    console.error('Application startup failed:', err);
    return { success: false, message: err };
  }
}

// ====================== IPC Communication Handlers ======================
// Check if a private key is saved
ipcMain.handle('get-saved-key-status', () => ({ hasSavedKey: checkSavedKeyValid() }));

// Clear saved private key
ipcMain.handle('clear-private-key', () => clearPrivateKeyPath());

// Select private key file and login
ipcMain.handle('select-private-key', async (event, localPort) => {
  LOCAL_LISTEN_PORT = localPort;
  console.log(`User selected local port: ${LOCAL_LISTEN_PORT}`);

  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Select id_rsa Private Key',
    defaultPath: path.join(app.getPath('home'), '.ssh'),
    properties: ['openFile']
  });

  if (canceled) {
    return { success: false, message: 'File selection canceled' };
  }

  const keyPath = filePaths[0];
  try {
    SSH_CONFIG.privateKey = fs.readFileSync(keyPath);
    savePrivateKeyPath(keyPath);
    return await startApplication(event.sender.getOwnerBrowserWindow());
  } catch (e) {
    clearPrivateKeyPath();
    console.error('Invalid private key file:', e.message);
    return { success: false, message: 'Invalid private key file' };
  }
});

// Login with saved private key
ipcMain.handle('login-with-saved-key', async (event, localPort) => {
  LOCAL_LISTEN_PORT = localPort;
  console.log(`User login with local port: ${LOCAL_LISTEN_PORT}`);

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
    console.error('Private key file corrupted:', e.message);
    return { success: false, message: 'Private key file corrupted' };
  }
});

// ====================== App Lifecycle ======================
app.whenReady().then(createSetupWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
  
  // Clean up connections
  if (sshClient) sshClient.end();
  if (localServer) localServer.close();
  console.log('Application closed, resources cleaned up');
});