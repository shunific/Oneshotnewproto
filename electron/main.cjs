const { app, BrowserWindow, globalShortcut, dialog, safeStorage } = require('electron');
const {createDeviceKeyStore}=require('./device-key-store.cjs');
const {createHostDeviceKeyChannel}=require('./host-device-key-channel.cjs');
const {readNativeDeviceId}=require('./native-device-id.cjs');
const path = require('path');
const { fork } = require('child_process');

// Explicit isolated QA data path; normal launches retain the existing user data location.
if (process.env.ONESHOT_QA_USER_DATA) app.setPath('userData', path.resolve(process.env.ONESHOT_QA_USER_DATA));

// 🟢 Prevent Windows DWM & Chromium from unloading GPU buffers/textures or flashing white on Alt-Tab
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

let serverProcess;
let deviceKeyChannel;

let mainWindow;
let isQuitting = false;
let serverReady = false;
let serverPort = 3001;
let cancelServerStartup;

function stopServer() {
  serverReady = false;
  if(deviceKeyChannel){void deviceKeyChannel.close().catch(()=>{});deviceKeyChannel=null;}
  if (cancelServerStartup) cancelServerStartup();
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
}

function startServer() {
  if (serverProcess) return Promise.reject(new Error('Backend startup is already in progress.'));
  const requestedPort = process.env.ONESHOT_QA_PORT;
  if (requestedPort !== undefined) {
    if (!/^[1-9]\d{0,4}$/.test(requestedPort) || Number(requestedPort) > 65535) throw new Error('ONESHOT_QA_PORT must be an integer between 1 and 65535.');
    serverPort = Number(requestedPort);
  }
  const serverPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'server.cjs')
    : path.join(__dirname, '../server.cjs');

  const userDataPath = app.getPath('userData'); 
  const isDev = !app.isPackaged;

  let serverStderr = ''; 

  serverProcess = fork(serverPath, [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: {
    ...process.env,
    NODE_PATH: path.join(process.resourcesPath, 'app.asar', 'node_modules'),
    PORT: String(serverPort),
    USER_DATA_PATH: userDataPath,
    NODE_ENV: isDev ? 'development' : 'production'
  }
});

  const keyStore=createDeviceKeyStore({app,safeStorage,rootPath:path.join(userDataPath,'device-credentials')});
  deviceKeyChannel=createHostDeviceKeyChannel({child:serverProcess,store:keyStore,resolveDeviceId:()=>readNativeDeviceId(path.join(userDataPath,'oneshot.db'))});

  serverProcess.stdout.on('data', (data) => console.log(`[Backend]: ${data.toString()}`));
  
  serverProcess.stderr.on('data', (data) => {
    const err = data.toString();
    serverStderr += err;
    console.error(`[Backend Error]: ${err}`);
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      failStartup(new Error('The owned local server did not become ready within 30 seconds.'));
      stopServer();
    }, 30000);
    const cleanup = () => {
      clearTimeout(timer);
      cancelServerStartup = null;
    };
    const failStartup = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    cancelServerStartup = () => failStartup(new Error('Backend startup was cancelled.'));
    serverProcess.on('message', message => {
      if (settled || isQuitting || message?.type !== 'backend-ready' || message.port !== serverPort) return;
      settled = true;
      serverReady = true;
      cleanup();
      resolve();
    });
    serverProcess.on('error', error => {
      if (!settled) return failStartup(error);
      if (!isQuitting) {
        serverReady = false;
        dialog.showErrorBox('Backend Server Error', error.message);
        app.quit();
      }
    });
    serverProcess.on('exit', (code, signal) => {
      serverProcess = null;
      serverReady = false;
      const error = new Error(`server.cjs exited with code ${code}, signal ${signal || 'none'}.\n\nCrash Details:\n${serverStderr || 'No error log recorded.'}`);
      if (!settled) return failStartup(error);
      if (!isQuitting) {
        dialog.showErrorBox('Backend Server Stopped', error.message);
        app.quit();
      }
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    kiosk: false,
    fullscreen: false,
    alwaysOnTop: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0a0a',
    show: false,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: false,
      backgroundThrottling: false
    }
  });

  const window = mainWindow;
  let retryTimer;

  window.maximize();

  window.once('ready-to-show', () => {
    window.show();
  });

  if (!app.isPackaged) {
    window.loadURL('http://localhost:5173').catch((error) => {
      if (!window.isDestroyed()) dialog.showErrorBox('Unable to Load Application', error.message);
    });
  } else {
    let attempts = 0;
    const loadExpress = () => {
      if (window.isDestroyed() || isQuitting) return;
      window.loadURL(`http://127.0.0.1:${serverPort}`).catch(() => {
        if (window.isDestroyed() || isQuitting) return;
        attempts++;
        if (attempts <= 20) {
          retryTimer = setTimeout(loadExpress, 1000);
        } else if (!window.isDestroyed() && !isQuitting) {
          dialog.showErrorBox('Unable to Load Application', 'The local server did not become available. Please restart the application.');
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

  window.on('closed', () => {
    clearTimeout(retryTimer);
    globalShortcut.unregisterAll();
    mainWindow = null;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    if (isQuitting) return;
    await startServer();
    if (!isQuitting && serverReady) createWindow();
  }).catch((error) => {
    if (!isQuitting) {
      dialog.showErrorBox('Unable to Start Application', error.message);
      app.quit();
    }
  });

  app.on('activate', () => {
    if (!isQuitting && serverReady && !mainWindow) createWindow();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    stopServer();
    globalShortcut.unregisterAll();
  });

  // This POS owns its backend; closing its final window ends both processes.
  app.on('window-all-closed', () => app.quit());
}
