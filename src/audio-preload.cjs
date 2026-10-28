const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('megaAudio',{
  onPlay(fn){ipcRenderer.on('mega:audioPlay',(_event,value)=>fn(value));},
  onStop(fn){ipcRenderer.on('mega:audioStop',(_event,value)=>fn(value));},
  ended(id,success){ipcRenderer.send('mega:audioEnded',{id,success:!!success});}
});
