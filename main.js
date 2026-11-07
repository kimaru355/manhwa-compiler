'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { findManhwas, describeFolder, runJob } = require('./src/builder');

let win = null;
let running = false;
let cancelRequested = false;

function createWindow() {
  win = new BrowserWindow({
    width: 860,
    height: 680,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#14161a',
    title: 'HDoujin PDF Maker',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function defaultChooserDir() {
  const hdoujin = path.join(app.getPath('downloads'), 'HDoujin');
  return fs.existsSync(hdoujin) ? hdoujin : app.getPath('downloads');
}

const DIALOGS = {
  single: { title: 'Choose a manhwa folder', properties: ['openDirectory'] },
  multi: { title: 'Choose one or more manhwa folders', properties: ['openDirectory', 'multiSelections'] },
  library: { title: 'Choose a folder that contains manhwas', properties: ['openDirectory'] },
};

// Returns the manhwa folders found for the chosen mode, or null if the dialog was cancelled.
ipcMain.handle('choose-folders', async (_event, mode) => {
  const dialogOptions = DIALOGS[mode];
  if (!dialogOptions) return null;
  const result = await dialog.showOpenDialog(win, { ...dialogOptions, defaultPath: defaultChooserDir() });
  if (result.canceled || !result.filePaths.length) return null;
  if (mode === 'library') return { root: result.filePaths[0], items: await findManhwas(result.filePaths[0]) };
  return { root: null, items: await Promise.all(result.filePaths.map(describeFolder)) };
});

ipcMain.handle('start', async (_event, { folders, buildChapters, buildComplete, skipExisting }) => {
  if (running) return { ok: false, error: 'A job is already running.' };
  if (!Array.isArray(folders) || !folders.length) return { ok: false, error: 'No folders selected.' };
  running = true;
  cancelRequested = false;
  const emit = (payload) => win && !win.isDestroyed() && win.webContents.send('progress', payload);
  try {
    const result = await runJob({ folders, buildChapters, buildComplete, skipExisting }, emit, () => cancelRequested);
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    running = false;
  }
});

ipcMain.on('cancel', () => {
  cancelRequested = true;
});

ipcMain.on('reveal', (_event, filePath) => {
  shell.showItemInFolder(filePath);
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
