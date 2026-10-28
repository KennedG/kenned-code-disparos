const {contextBridge,ipcRenderer} = require('electron');
const actions = new Set(['snapshot','connect','disconnect','refreshGroups','authorizeGroup','saveCampaign','duplicateCampaign','deleteCampaign','previewCampaign','activateCampaign','pauseCampaign','resumeCampaign','stopAll','importMedia','saveTemplate','deleteTemplate','saveSettings','backup','restore','openDataFolder','testSimulation','reviewJob','windowMinimize','windowQuit']);
contextBridge.exposeInMainWorld('mega',{
  call(action,payload={}) { if(!actions.has(action)) return Promise.reject(new Error('Ação não permitida.')); return ipcRenderer.invoke('mega:call',action,payload); },
  onUpdate(fn) { const listener=(_,data)=>fn(data); ipcRenderer.on('mega:update',listener); return ()=>ipcRenderer.removeListener('mega:update',listener); }
});
