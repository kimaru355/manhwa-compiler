'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  chooseFolders: (mode) => ipcRenderer.invoke('choose-folders', mode),
  start: (options) => ipcRenderer.invoke('start', options),
  cancel: () => ipcRenderer.send('cancel'),
  reveal: (filePath) => ipcRenderer.send('reveal', filePath),
  onProgress: (callback) => ipcRenderer.on('progress', (_event, data) => callback(data)),
});
