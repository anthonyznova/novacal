const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const path = require('path')
const { spawn } = require('child_process')
require('@electron/remote/main').initialize()

let backendProcess = null;

function startBackend() {
  // Get the correct path for the backend executable
  const backendPath = app.isPackaged 
    ? path.join(process.resourcesPath, 'backend.exe')
    : path.join(__dirname, '../backend/backend.exe');

  console.log('Starting backend from:', backendPath);
  
  backendProcess = spawn(backendPath);

  backendProcess.stdout.on('data', (data) => {
    console.log(`Backend stdout: ${data}`);
  });

  backendProcess.stderr.on('data', (data) => {
    console.error(`Backend stderr: ${data}`);
  });

  backendProcess.on('error', (error) => {
    console.error('Failed to start backend:', error);
  });

  backendProcess.on('close', (code) => {
    console.log(`Backend process exited with code ${code}`);
  });
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    },
    backgroundColor: '#f8fafc',
    icon: path.join(__dirname, '../assets/icon.ico'),
    title: 'NOVACAL',
    frame: true,
    titleBarStyle: 'default',
    skipTaskbar: false,
    autoHideMenuBar: true
  })

  mainWindow.setIcon(path.join(__dirname, '../assets/icon.ico'))

  require('@electron/remote/main').enable(mainWindow.webContents)
  mainWindow.loadFile('src/index.html')

  // Handle folder selection
  ipcMain.on('open-folder-dialog', (event) => {
    dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select Folder',
      buttonLabel: 'Select'
    }).then(result => {
      if (!result.canceled) {
        event.reply('selected-folder', result.filePaths[0]);
      }
    }).catch(err => {
      console.error('Error selecting folder:', err);
    });
  });
}

if (process.platform === 'win32') {
  app.setAppUserModelId('com.novacal.app')
}

app.whenReady().then(() => {
  startBackend();
  createWindow();
});

app.on('window-all-closed', () => {
  if (backendProcess) {
    backendProcess.kill();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (backendProcess) {
    backendProcess.kill();
  }
}); 