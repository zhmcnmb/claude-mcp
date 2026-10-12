const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getState: () => ipcRenderer.invoke('get-state'),
  chooseWorkspace: () => ipcRenderer.invoke('choose-workspace'),
  start: (settings) => ipcRenderer.invoke('start', settings),
  stop: () => ipcRenderer.invoke('stop'),
  copyUrl: () => ipcRenderer.invoke('copy-url'),
  closeAction: (action) => ipcRenderer.invoke('close-action', action),
  onCloseRequested: (callback) => ipcRenderer.on('close-requested', () => callback()),
  onState: (callback) => ipcRenderer.on('state', (_event, state) => callback(state)),
});
