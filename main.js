const { app, BrowserWindow, shell, Menu } = require('electron'); // Added: Import Menu module
const net = require('net');
const { Client } = require('ssh2');
const path = require('path'); // Added: Import path module to handle icon path

// ====================== 1. Configure SSH Connection Info (Replace with your server info) ======================
const SSH_CONFIG = {
  host: '222.212.86.164', // e.g.: 192.168.1.100
  port: 10007, // Default SSH port
  username: 'dell', // e.g.: root
  // Authentication method (choose one): Password or Private Key
  // password: 'your_password', // Password authentication
  privateKey: require('fs').readFileSync('./id_rsa'), // Private key authentication (e.g. id_rsa)
  readyTimeout: 5000, // Connection timeout (milliseconds)
  keepaliveInterval: 30000, // Send keep-alive packet every 30 seconds to prevent disconnection
  keepaliveCountMax: 3, // Disconnect after 3 consecutive keep-alive failures
};

// ====================== Added: App Icon Path Configuration (Replace with your icon file path) ======================
// It is recommended to place the icon file in the assets folder of the project root directory, e.g.: assets/app-icon.png
// Note: .ico format is recommended for Windows, .icns format for macOS, PNG format is compatible with most scenarios
const APP_ICON_PATH = path.join(__dirname, 'assets', 'app-icon.png');

// ====================== 2. Global Variables: Save SSH connection and local port listening instances ======================
let sshClient = null;
let localServer = null;
const LOCAL_PORT = 8008; // Local forwarding port
const REMOTE_HOST = '127.0.0.1'; // Forwarding target on server side (127.0.0.1 for local server)
const REMOTE_PORT = 8008; // Target port on server

// ====================== 3. Implement SSH Port Forwarding ======================
function setupSSHTunneling() {
  return new Promise((resolve, reject) => {
    // 1. Create SSH client instance
    sshClient = new Client();

    // 2. Listen to SSH connection events
    sshClient
      .on('ready', () => {
        console.log('SSH connection successful, starting port forwarding...');
        
        // 3. Listen to local port 8008
        localServer = net.createServer((localSocket) => {
          // When a new connection is established to local port, forward it to server via SSH
          sshClient.forwardOut(
            'localhost', // Source address (local)
            LOCAL_PORT,  // Source port
            REMOTE_HOST, // Target address (server side)
            REMOTE_PORT, // Target port
            (err, sshStream) => {
              if (err) {
                console.error('Port forwarding failed:', err.message);
                localSocket.end();
                return;
              }

              // Establish bidirectional data transmission between local socket and SSH stream
              localSocket.pipe(sshStream).pipe(localSocket);

              // Error handling
              sshStream.on('error', (err) => {
                console.error('SSH stream error:', err.message);
                localSocket.end();
              });
              localSocket.on('error', (err) => {
                console.error('Local socket error:', err.message);
                sshStream.end();
              });
            }
          );
        }).listen(LOCAL_PORT, 'localhost', () => {
          console.log(`Local port forwarding successful: localhost:${LOCAL_PORT} -> ${SSH_CONFIG.host}:${REMOTE_PORT}`);
          resolve();
        });

        // Local port listening error handling (e.g. port occupied)
        localServer.on('error', (err) => {
          reject(`Failed to listen on local port ${LOCAL_PORT}: ${err.message}`);
        });
      })
      .on('error', (err) => {
        reject(`SSH connection failed: ${err.message}`);
      })
      .on('end', () => {
        console.log('SSH connection disconnected');
      })
      .connect(SSH_CONFIG); // Start SSH connection
  });
}

// ====================== 4. Create Electron Window ======================
async function createElectronWindow() {
  // Added: Close the application menu bar (global effect)
  Menu.setApplicationMenu(null);

  // Create browser window
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: APP_ICON_PATH, // Added: Set window icon
    webPreferences: {
      nodeIntegration: false, // Security best practice: Disable node integration
      contextIsolation: true, // Enable context isolation
      sandbox: false // Allow network access
    }
  });

  // Core: Intercept all new window open requests and force display in Electron
  mainWindow.webContents.setWindowOpenHandler((details) => {
    // Load new URL in current window (or create new window: new BrowserWindow().loadURL(details.url))
    mainWindow.loadURL(details.url);
    // Prevent opening in system browser
    return { action: 'deny' };
  });

  // Load the page of forwarded local port (Core: Access forwarded port 8008)
  await mainWindow.loadURL(`http://localhost:${LOCAL_PORT}`);

  // Optional: Open developer tools
  // mainWindow.webContents.openDevTools();

  // Clean up resources when window is closed
  mainWindow.on('closed', () => {
    if (sshClient) sshClient.end();
    if (localServer) localServer.close();
  });
}

// ====================== 5. App Lifecycle Management ======================
app.whenReady().then(async () => {
  try {
    // Establish SSH port forwarding first, then create window
    await setupSSHTunneling();
    await createElectronWindow();

    // Recreate window when Electron is activated (macOS feature)
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createElectronWindow();
    });
  } catch (err) {
    console.error(err);
    app.quit(); // Exit app if initialization fails
  }
});

// Quit app when all windows are closed (except macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (sshClient) sshClient.end();
    if (localServer) localServer.close();
    app.quit();
  }
});