const { app, BrowserWindow, shell, Menu, dialog } = require('electron');
const net = require('net');
const { Client } = require('ssh2');
const path = require('path');
const fs = require('fs');

// ====================== 1. Configuration ======================
const SSH_CONFIG = {
  host: '222.212.86.164',
  port: 10007,
  username: 'dell',
  privateKey: null, 
  readyTimeout: 5000,
  keepaliveInterval: 30000,
  keepaliveCountMax: 3,
};

const APP_ICON_PATH = path.join('./', 'assets', 'app-icon.png');
const PRIVATE_KEY_PATH = path.join(__dirname, 'assets', 'id_rsa');
const INDEX_HTML_PATH = path.join('./', 'index.html'); 

// ====================== 2. Global Variables ======================
let sshClient = null;
let localServer = null;
let mainWindow = null; // This variable will point to whichever window is currently active
const LOCAL_PORT = 80;
const REMOTE_HOST = '127.0.0.1';
const REMOTE_PORT = 8008;

// ====================== 3. SSH Tunnel Setup ======================
function setupSSHTunneling() {
  return new Promise((resolve, reject) => {
    sshClient = new Client();
    sshClient
      .on('ready', () => {
        console.log('SSH connection successful, starting port forwarding...');
        localServer = net.createServer((localSocket) => {
          sshClient.forwardOut('localhost', LOCAL_PORT, REMOTE_HOST, REMOTE_PORT, (err, sshStream) => {
            if (err) {
              console.error('Port forwarding failed:', err.message);
              localSocket.end();
              return;
            }
            localSocket.pipe(sshStream).pipe(localSocket);
            sshStream.on('error', (err) => { console.error('SSH stream error:', err.message); localSocket.end(); });
            localSocket.on('error', (err) => { console.error('Local socket error:', err.message); sshStream.end(); });
          });
        }).listen(LOCAL_PORT, 'localhost', () => {
          console.log(`Local port forwarding successful: localhost:${LOCAL_PORT} -> ${SSH_CONFIG.host}:${REMOTE_PORT}`);
          resolve();
        });
        localServer.on('error', (err) => { reject(`Failed to listen on local port ${LOCAL_PORT}: ${err.message}`); });
      })
      .on('error', (err) => { reject(`SSH connection failed: ${err.message}`); })
      .on('end', () => { console.log('SSH connection disconnected'); })
      .connect(SSH_CONFIG);
  });
}

// ====================== 4. Create Main Application Window ======================
async function createMainWindow() {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: APP_ICON_PATH,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false }
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    mainWindow.loadURL(details.url);
    return { action: 'deny' };
  });

  await mainWindow.loadURL(`http://localhost:${LOCAL_PORT}`);
  // mainWindow.webContents.openDevTools();

  // Clean up resources when this specific window is closed
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ====================== 5. Create Setup Window (Wizard) ======================
function createSetupWindow() {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 600,
    height: 400,
    icon: APP_ICON_PATH,
    resizable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js') 
    }
  });

  mainWindow.loadFile(INDEX_HTML_PATH); 
  // mainWindow.webContents.openDevTools();

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ====================== 6. IPC Handler (FIXED LOGIC) ======================
const { ipcMain } = require('electron');
ipcMain.handle('select-private-key', async () => {
  // 1. Open File Dialog
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Select SSH Private Key (id_rsa)',
    defaultPath: path.join(app.getPath('home'), '.ssh'),
    properties: ['openFile'],
    filters: [{ name: 'Private Key Files', extensions: ['*'] }, { name: 'All Files', extensions: ['*'] }]
  });

  if (canceled || filePaths.length === 0) {
    return { success: false, message: 'Selection cancelled by user.' };
  }

  const selectedFilePath = filePaths[0];
  const assetsDir = path.join(__dirname, 'assets');
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
  }

  try {
    // 2. Copy File
    fs.copyFileSync(selectedFilePath, PRIVATE_KEY_PATH);
    console.log(`File successfully copied to: ${PRIVATE_KEY_PATH}`);
    
    // 3. Update SSH Config
    SSH_CONFIG.privateKey = fs.readFileSync(PRIVATE_KEY_PATH);
    
    // --- CRITICAL FIX START ---
    
    // 4. Save reference to the CURRENT window (the Setup Window)
    // We need this because createMainWindow() will overwrite the global 'mainWindow' variable
    const setupWindowRef = mainWindow;

    // 5. Start the Main Application Logic (SSH + Remote Page)
    // This runs BEFORE we close the setup window to ensure the app doesn't quit
    try {
        await setupSSHTunneling();
        await createMainWindow(); // This creates the new window and updates global 'mainWindow'
        console.log('Main application started successfully.');
    } catch (err) {
        console.error('Error starting main app:', err);
        return { success: false, message: `Failed to start app: ${err.message}` };
    }

    // 6. Close the OLD Setup Window explicitly
    if (setupWindowRef && !setupWindowRef.isDestroyed()) {
        setupWindowRef.close();
    }
    // --- CRITICAL FIX END ---
    
    return { success: true, message: 'Private key updated. Starting application...' };
    
  } catch (err) {
    console.error('Error copying file:', err);
    return { success: false, message: `File copy failed: ${err.message}` };
  }
});

// ====================== 7. Core Startup Logic ======================
async function startMainApplication() {
  try {
    await setupSSHTunneling();
    await createMainWindow();
  } catch (err) {
    console.error('Main application startup failed:', err);
    app.quit();
  }
}

app.whenReady().then(async () => {
  if (fs.existsSync(PRIVATE_KEY_PATH)) {
    // Case 1: File exists
    try {
      SSH_CONFIG.privateKey = fs.readFileSync(PRIVATE_KEY_PATH);
      console.log('Private key detected, starting directly...');
      await startMainApplication();
    } catch (err) {
      console.error('Failed to read private key file:', err);
      createSetupWindow();
    }
  } else {
    // Case 2: File does not exist
    console.log('No private key detected, opening setup wizard...');
    createSetupWindow();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createSetupWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (sshClient) sshClient.end();
    if (localServer) localServer.close();
    app.quit();
  }
});