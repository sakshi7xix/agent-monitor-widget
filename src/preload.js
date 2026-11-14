'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentMonitor', {
  getState: () => ipcRenderer.invoke('get-state'),
  onState: (callback) => ipcRenderer.on('state', (_event, state) => callback(state)),
  decide: (pendingId, behavior, options) => ipcRenderer.invoke('decide', pendingId, behavior, options),
  setExpanded: (expanded) => ipcRenderer.invoke('set-expanded', expanded),
  setPinned: (pinned) => ipcRenderer.invoke('set-pinned', pinned),
  installHooks: () => ipcRenderer.invoke('install-hooks'),
});
