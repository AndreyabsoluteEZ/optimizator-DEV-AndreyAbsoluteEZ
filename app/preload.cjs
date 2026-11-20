'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function request(channel, ...args) {
  const response = await ipcRenderer.invoke(channel, ...args);
  if (response.error) throw new Error(response.error);
  return response.value;
}

contextBridge.exposeInMainWorld('optimizer', {
  state: () => request('system:state'),
  metrics: () => request('system:metrics'),
  profile: enabled => request('gaming:profile', enabled),
  games: () => request('gaming:apps'),
  priority: (enabled, id) => request('gaming:priority', enabled, id),
  ping: host => request('network:test', host),
  chooseBackground: () => request('network:pick'),
  qos: (enabled, rate) => request('network:qos', enabled, rate),
  settings: section => request('system:settings', section),
  window: action => request('window:control', action),
  onBusy: callback => ipcRenderer.on('window:busy', () => callback())
});
