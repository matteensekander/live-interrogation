'use strict';

// Desktop wrapper. The app loads the game from a server:
//   1. LI_SERVER_URL env var, if set (handy for testing)
//   2. serverUrl in electron/config.json (your hosted Render URL, e.g. https://live-interrogation.onrender.com)
//   3. otherwise it starts the game server inside the app, for solo/offline play on this machine
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, shell, Menu } = require('electron');

let embedded = null;

function readConfig() {
  try {
    const file = path.join(__dirname, 'config.json');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_e) {
    return {};
  }
}

async function resolveServerUrl() {
  const fromEnv = process.env.LI_SERVER_URL;
  if (fromEnv) return fromEnv.trim();
  const configured = (readConfig().serverUrl || '').trim();
  if (configured) return configured;
  // No hosted server configured: run one locally inside the app.
  const { start } = require(path.join(__dirname, '..', 'server', 'app'));
  embedded = await start({ port: 0, host: '127.0.0.1' });
  return embedded.url;
}

async function createWindow() {
  const url = await resolveServerUrl();
  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1280,
    minHeight: 720,
    backgroundColor: '#05060a',
    title: 'Live Interrogation',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Keep the game inside the window; open any outside links in the real browser.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault();
      shell.openExternal(target);
    }
  });

  win.loadURL(url);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow().catch((err) => {
    console.error(err);
    app.quit();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (embedded) embedded.close().finally(() => app.quit());
  else app.quit();
});
