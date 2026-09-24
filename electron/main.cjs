const { app, BrowserWindow, globalShortcut, dialog } = require('electron');
const path = require('path');
const { fork } = require('child_process'); // 🟢 FIXED: Using standard child_process for native SQLite compatibility
let serverProcess;

let mainWindow;

function startServer() {
  const serverPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'server.cjs')
    : path.join(__dirname, '../server.cjs');

  const userDataPath = app.getPath('userData'); 
  const isDev = !app.isPackaged;

  let serverStderr = ''; 

  serverProcess = fork(serverPath, [], {
      stdio: 'pipe',
  env: {
    ...process.env,
    NODE_PATH: path.join(process.resourcesPath, 'app.asar', 'node_modules'),
    PORT: '3001',
    USER_DATA_PATH: userDataPath,
    NODE_ENV: isDev ? 'development' : 'production'
  }
});

  serverProcess.stdout.on('data', (data) => console.log(`[Backend]: ${data.toString()}`));
  
  serverProcess.stderr.on('data', (data) => {
    const err = data.toString();
    serverStderr += err;
    console.error(`[Backend Error]: ${err}`);
  });

  serverProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      dialog.showErrorBox(
        'Backend Server Crash Output',
        `server.cjs exited with code ${code}.\n\nCrash Details:\n${serverStderr || 'No error log recorded. Process died during initialization.'}`
      );
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    kiosk: true,
    fullscreen: true,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      devTools: false
    }
  });

  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    let attempts = 0;
    const loadExpress = () => {
      mainWindow.loadURL('http://localhost:3001').catch(() => {
        attempts++;
        if (attempts <= 20) {
          setTimeout(loadExpress, 1000);
        }
      });
    };
    loadExpress();
  }

  mainWindow.on('focus', () => {
    globalShortcut.register('CommandOrControl+R', () => {});
    globalShortcut.register('CommandOrControl+Shift+R', () => {});
    globalShortcut.register('F5', () => {});
  });

  mainWindow.on('blur', () => {
    globalShortcut.unregisterAll();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  startServer();
  createWindow();
});

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  globalShortcut.unregisterAll();
  if (process.platform !== 'darwin') app.quit();
});