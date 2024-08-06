const { app, BrowserWindow, dialog } = require('electron')
const path = require('path')
const remoteMain = require('@electron/remote/main')
const { spawn } = require('child_process')
const fs = require('fs')

remoteMain.initialize()

let backendProcess = null
let mainWindow = null

function startBackend() {
  let backendPath;
  if (app.isPackaged) {
    backendPath = path.join(process.resourcesPath, 'backend', 'novacal-backend.exe');
  } else {
    backendPath = path.join(__dirname, '..', 'backend', 'novacal-backend.exe');
  }

  console.log('Attempting to start backend from:', backendPath);

  if (!fs.existsSync(backendPath)) {
    dialog.showErrorBox('Backend Not Found', `The backend executable was not found at ${backendPath}. The application may not function correctly.`);
    return;
  }

  try {
    backendProcess = spawn(backendPath);

    backendProcess.stdout.on('data', (data) => {
      console.log(`Backend stdout: ${data}`);
    });

    backendProcess.stderr.on('data', (data) => {
      console.error(`Backend stderr: ${data}`);
    });


    backendProcess.on('error', (err) => {
      console.error('Failed to start backend process:', err);
      dialog.showErrorBox('Backend Error', `Failed to start the backend process: ${err.message}`);
    });
  } catch (error) {
    console.error('Error starting backend:', error);
    dialog.showErrorBox('Backend Error', `Error starting the backend: ${error.message}`);
  }
}

function createWindow() {
  const iconPath = path.join(__dirname, 'assets', 'nova_toolkit_icon.ico');
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    },
    icon: iconPath,
    show: false  // Don't show the window until it's ready
  })

  remoteMain.enable(mainWindow.webContents)

  mainWindow.loadFile('index.html')

  // Set the taskbar icon explicitly for Windows
  if (process.platform === 'win32') {
    mainWindow.setIcon(iconPath);
    app.setAppUserModelId(process.execPath);
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize()  // Maximize the window
    mainWindow.show()  // Show the window after it's maximized
  })

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('backend-status', backendProcess ? 'running' : 'not-running');
  });
}

app.whenReady().then(() => {
  startBackend()
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  if (backendProcess) {
    backendProcess.kill()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})