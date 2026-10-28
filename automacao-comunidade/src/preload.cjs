'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const actions = new Set(('snapshot connect disconnect reconnect testConnection listGroups refreshGroups listParticipants refreshParticipants listContacts updateContact authorizeContacts saveCampaign duplicateCampaign deleteCampaign previewCampaign activateCampaign pauseCampaign resumeCampaign stopCampaign stopAll resumeAutomation listCampaigns listRuns listHistory clearHistory listTemplates saveTemplate duplicateTemplate deleteTemplate saveSettings backup restore exportHistory reconcileJob retryJob testSimulation windowMinimize windowQuit openDataFolder').split(' '));
contextBridge.exposeInMainWorld('community', Object.freeze({
  call(action, payload = {}) {
    if (typeof action !== 'string' || !actions.has(action)) return Promise.reject(new Error('Operação não permitida.'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return Promise.reject(new Error('Dados da operação inválidos.'));
    return ipcRenderer.invoke('community:call', action, payload);
  },
  onUpdate(callback) {
    if (typeof callback !== 'function') throw new TypeError('Informe uma função para acompanhar atualizações.');
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('community:update', listener);
    return () => ipcRenderer.removeListener('community:update', listener);
  }
}));
