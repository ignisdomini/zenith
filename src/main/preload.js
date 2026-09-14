'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zenit', {
  lang: ipcRenderer.sendSync('settings:lang-sync'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  cacheStats: () => ipcRenderer.invoke('cache:stats'),
  cacheClear: () => ipcRenderer.invoke('cache:clear'),
  cacheOpen: () => ipcRenderer.invoke('cache:open'),
  saveFile: (opts) => ipcRenderer.invoke('file:save', opts),
  info: () => ipcRenderer.invoke('app:info'),
});
