'use strict';
const {app,BrowserWindow,ipcMain,dialog,Tray,Menu,nativeImage,shell,powerMonitor,safeStorage,protocol,net,Notification}=require('electron');
const {Worker}=require('node:worker_threads');
const {pathToFileURL}=require('node:url');
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {WorkerClient}=require('./core/worker-client.cjs');
const {SoundController}=require('./core/sound.cjs');
const {LicenseClient}=require('./core/license-client.cjs');
const {LicenseIdentityHost}=require('./core/license-host.cjs');

const APP_NAME='Kenned Code Disparos';
// Keep the existing profile and the OS mutex during the identity update.
// This preserves SQLite, managed media, DPAPI credentials and WhatsApp sessions.
const LEGACY_PROFILE_NAME='Mega Disparos';
app.setName(APP_NAME);
app.setAppUserModelId('br.com.megadisparos.desktop');
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
protocol.registerSchemesAsPrivileged([
  {scheme:'mega-media',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}},
  {scheme:'mega-audio',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}
]);
const profileDir=process.env.MEGA_DATA_DIR?path.resolve(process.env.MEGA_DATA_DIR):path.join(app.getPath('appData'),LEGACY_PROFILE_NAME);
fs.mkdirSync(profileDir,{recursive:true});
app.setPath('userData',profileDir);
const locked=app.requestSingleInstanceLock();
if(!locked)app.quit();
let win,tray,audioWindow,client,sounds,licensing,licenseTimer,quitting=false,quitStarted=false,networkTimer,settings={},lastSnapshot=null,resolveAudio;
const audioReady=new Promise(resolve=>{resolveAudio=resolve;});
const nativeOccurrences=new Set(),audioFiles=new Map(),audioRequests=new Map();
const uiPath=path.join(__dirname,'ui/index.html'),audioPath=path.join(__dirname,'ui/audio-player.html');
const dataDir=()=>app.getPath('userData');
const nativeActions=new Set(['windowMinimize','windowQuit']);
function showWindow(){if(win&&!win.isDestroyed()){win.show();win.focus();}}
function publish(snapshot){
  lastSnapshot=snapshot;
  if(snapshot?.settings)settings={...settings,...snapshot.settings};
  if(win&&!win.isDestroyed())win.webContents.send('mega:update',snapshot);
}
function registerAudio(filename){
  if(!filename)return undefined;
  const root=path.join(dataDir(),'audio'),real=fs.realpathSync(filename),base=fs.realpathSync(root);
  if(!real.startsWith(base+path.sep)||!fs.statSync(real).isFile())throw new Error('Arquivo de áudio gerenciado inválido.');
  for(const [id,file]of audioFiles)if(file===real)return 'mega-audio://asset/'+id;
  const id=randomUUID();audioFiles.set(id,real);
  if(audioFiles.size>32)audioFiles.delete(audioFiles.keys().next().value);
  return 'mega-audio://asset/'+id;
}
async function createAudioWindow(){
  audioWindow=new BrowserWindow({show:false,width:100,height:100,webPreferences:{preload:path.join(__dirname,'audio-preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,backgroundThrottling:false}});
  audioWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  audioWindow.webContents.on('will-navigate',(event,url)=>{if(url!==pathToFileURL(audioPath).href)event.preventDefault();});
  await audioWindow.loadFile(audioPath);resolveAudio();
}
async function playAudio(payload){
  await audioReady;
  if(!audioWindow||audioWindow.isDestroyed())throw new Error('O reprodutor de alertas não está disponível.');
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{audioRequests.delete(payload.id);audioWindow.webContents.send('mega:audioStop',{id:payload.id});reject(new Error('O áudio não pôde ser concluído.'));},17000);
    audioRequests.set(payload.id,{resolve,reject,timer});audioWindow.webContents.send('mega:audioPlay',payload);
  });
}
async function nativeAlert(payload){
  const preferences=payload.soundPreferences||payload.sound||settings.sound||{};
  let audioUrl;try{audioUrl=registerAudio(payload.audioPath);}catch{}
  const audio=sounds.handle(payload,preferences,{audioUrl});
  if(nativeOccurrences.has(payload.id))return {...audio,nativeStatus:'suppressed'};
  nativeOccurrences.add(payload.id);
  if(nativeOccurrences.size>512)nativeOccurrences.delete(nativeOccurrences.values().next().value);
  if(payload.nativeEnabled===false||settings.notifications?.nativeEnabled===false)return {...audio,nativeStatus:'disabled'};
  if(!Notification.isSupported())return {...audio,nativeStatus:'unsupported'};
  try{
    const notification=new Notification({title:payload.title||APP_NAME,body:payload.body||payload.reason||'Verifique os detalhes no aplicativo.',icon:path.join(__dirname,'../assets/icon.png'),silent:true,timeoutType:'default'});
    notification.on('click',showWindow);
    notification.on('show',()=>{void client?.systemCall('nativeNotificationResult',{id:payload.id,status:'shown'}).catch(()=>{});});
    notification.on('failed',()=>{void client?.systemCall('nativeNotificationResult',{id:payload.id,status:'failed',error:'O Windows não aceitou a notificação; confira as permissões de notificações.'}).catch(()=>{});});
    notification.show();return {...audio,nativeStatus:'requested'};
  }catch{return {...audio,nativeStatus:'failed'};}
}
function secureFile(){return path.join(dataDir(),'credentials','channels.dpapi');}
function readSecrets(){
  if(!fs.existsSync(secureFile()))return {};
  if(!safeStorage.isEncryptionAvailable())throw new Error('A proteção de credenciais do sistema não está disponível.');
  try{return JSON.parse(safeStorage.decryptString(fs.readFileSync(secureFile())));}catch{throw new Error('Não foi possível abrir a configuração protegida dos canais.');}
}
async function nativeHost(action,payload={}){
  switch(action){
    case 'licenseStatus':return licensing.getStatus();
    case 'licenseInitialize':return licensing.initialize();
    case 'licenseActivate':return licensing.activate(payload.key);
    case 'licenseValidate':return licensing.validate();
    case 'licenseTick':return licensing.tick();
    case 'encryptionAvailable':return safeStorage.isEncryptionAvailable();
    case 'encryptString':if(!safeStorage.isEncryptionAvailable())throw new Error('Proteção do Windows indisponível.');return safeStorage.encryptString(String(payload.value));
    case 'decryptString':if(!safeStorage.isEncryptionAvailable())throw new Error('Proteção do Windows indisponível.');return safeStorage.decryptString(Buffer.from(payload.value));
    case 'showOpenDialog':return dialog.showOpenDialog(win,payload);
    case 'showSaveDialog':return dialog.showSaveDialog(win,payload);
    case 'showMessageBox':return dialog.showMessageBox(win,payload);
    case 'openDataFolder':return shell.openPath(dataDir());
    case 'setLoginItemSettings':if(process.platform==='win32')app.setLoginItemSettings({name:APP_NAME,openAtLogin:!!payload.openAtLogin,path:process.execPath,args:['--autostart']});return true;
    case 'localAlert':return nativeAlert(payload);
    case 'testSound':return sounds.test(payload.preferences||payload.soundPreferences||payload.sound||settings.sound,{audioUrl:registerAudio(payload.audioPath)});
    case 'silenceAlert':sounds.mute(payload.id);return true;
    case 'secretGet':return readSecrets()[payload.key]??null;
    case 'secretSet':{
      if(!safeStorage.isEncryptionAvailable())throw new Error('Proteção do Windows indisponível.');
      if(!/^[a-zA-Z0-9_.-]{1,80}$/.test(payload.key||''))throw new Error('Chave protegida inválida.');
      const values=readSecrets();
      if(payload.value==null)delete values[payload.key];else values[payload.key]=String(payload.value);
      require('./core/store.cjs').atomicWrite(secureFile(),safeStorage.encryptString(JSON.stringify(values)));return true;
    }
    default:throw new Error('Ação nativa não permitida.');
  }
}
function createWindow(){
  win=new BrowserWindow({width:1380,height:920,minWidth:1060,minHeight:700,title:APP_NAME,backgroundColor:'#0b101b',icon:path.join(__dirname,'../assets/icon.png'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
  win.loadFile(uiPath);win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,url)=>{if(url.split('#')[0]!==pathToFileURL(uiPath).href)event.preventDefault();});
  win.on('minimize',()=>{if(settings.minimizeToTray!==false)win.hide();});
  win.on('close',async event=>{
    if(quitting)return;event.preventDefault();
    if(settings.closeBehavior==='tray'){win.hide();return;}
    if(settings.closeBehavior==='quit'){app.quit();return;}
    const result=await dialog.showMessageBox(win,{type:'question',title:'Fechar '+APP_NAME,message:'Continuar na bandeja ou encerrar o aplicativo?',detail:'Campanhas e notificações dependem deste aplicativo em execução. O computador precisa estar ligado, conectado e sem suspensão.',buttons:['Minimizar para a bandeja','Encerrar aplicativo','Cancelar'],cancelId:2,defaultId:0});
    if(result.response===0)win.hide();else if(result.response===1)app.quit();
  });
  tray=new Tray(nativeImage.createFromPath(path.join(__dirname,'../assets/tray.png')));
  tray.setToolTip(APP_NAME+' • campanhas locais');
  tray.setContextMenu(Menu.buildFromTemplate([
    {label:'Abrir '+APP_NAME,click:showWindow},
    {label:'PARAR TODOS OS ENVIOS',click:()=>{void client.call('stopAll').then(result=>{if(result?.error)throw new Error(result.error);}).catch(()=>{showWindow();void dialog.showMessageBox(win,{type:'warning',message:'Entre com um usuário autorizado para interromper as campanhas.'});});}},
    {type:'separator'},{label:'Sobre '+APP_NAME,click:()=>{void dialog.showMessageBox(win,{type:'info',title:'Sobre '+APP_NAME,message:APP_NAME+' '+app.getVersion(),detail:'Aplicativo local para Windows. Campanhas e buscas autorizadas pelo WhatsApp.\nIntegração Baileys não oficial. Os dados da instalação anterior foram preservados.',buttons:['OK']});}},{label:'Encerrar',click:()=>app.quit()}
  ]));
  tray.on('double-click',showWindow);Menu.setApplicationMenu(null);
}
if(locked){
  app.on('second-instance',showWindow);
  app.whenReady().then(async()=>{
    licensing=new LicenseClient({identityProvider:new LicenseIdentityHost({safeStorage}),fetchImpl:(url,options)=>net.fetch(url,options)});
    licensing.on('change',status=>{if(client&&!client.closed)client.worker?.postMessage({type:'licenseChanged',status});});
    // Start on the first execution, even before the owner registers. The UI is
    // allowed to open while the hosted, authoritative trial request runs.
    void licensing.initialize();
    licenseTimer=setInterval(()=>{void licensing.tick().catch(()=>{});},5000);licenseTimer.unref();
    sounds=new SoundController({play:playAudio,stop:id=>audioWindow?.webContents.send('mega:audioStop',{id})});
    protocol.handle('mega-audio',request=>{
      try{const url=new URL(request.url);if(url.hostname!=='asset')throw new Error();const file=audioFiles.get(url.pathname.slice(1));if(!file)throw new Error();return net.fetch(pathToFileURL(file).href,{headers:request.headers});}catch{return new Response('Áudio indisponível',{status:404});}
    });
    protocol.handle('mega-media',async request=>{
      try{const url=new URL(request.url);if(url.hostname!=='asset')throw new Error();const result=await client.call('mediaPath',{id:decodeURIComponent(url.pathname.slice(1))});const filename=typeof result==='string'?result:result?.path;if(!filename)throw new Error();return net.fetch(pathToFileURL(filename).href,{headers:request.headers});}catch{return new Response('Mídia indisponível ou acesso negado',{status:404});}
    });
    const worker=new Worker(path.join(__dirname,'backend/worker.cjs'),{workerData:{dir:dataDir(),version:app.getVersion(),runtimePlatform:process.platform}});
    client=new WorkerClient(worker,{host:nativeHost});
    client.on('update',publish);
    client.on('nativeEvent',event=>{if(event?.type==='settings')settings={...settings,...event.payload};else if(event?.type==='localAlert')void nativeAlert(event.payload);});
    client.on('fatal',()=>{
      if(quitting||quitStarted)return;
      const message='O processamento de campanhas foi interrompido. Reabra o aplicativo e revise os resultados incertos.';
      publish({...lastSnapshot,backendError:message,storageError:message,connection:{state:'disconnected',detail:message}});
      void nativeAlert({id:'backend-failure',event:'critical',title:APP_NAME+': processamento interrompido',body:message,at:Date.now(),soundPreferences:settings.sound,nativeEnabled:settings.notifications?.nativeEnabled});
    });
    settings=await client.ready;
    ipcMain.handle('mega:call',async(event,action,payload={})=>{
      if(event.sender!==win?.webContents||event.senderFrame!==win.webContents.mainFrame)return {error:'Ação não autorizada.'};
      try{
        if(nativeActions.has(action)){if(action==='windowMinimize')win.hide();else app.quit();return true;}
        return await client.call(action,payload);
      }catch(error){return {error:error.message||'Não foi possível concluir a operação.',code:error.code};}
    });
    ipcMain.on('mega:audioEnded',(event,payload)=>{
      if(event.sender!==audioWindow?.webContents||event.senderFrame!==audioWindow.webContents.mainFrame)return;
      const request=audioRequests.get(payload?.id);if(!request)return;
      audioRequests.delete(payload.id);clearTimeout(request.timer);
      if(payload.success)request.resolve({success:true});else request.reject(new Error('Não foi possível reproduzir o áudio. Confira o arquivo e as configurações de som.'));
    });
    createWindow();await createAudioWindow();
    powerMonitor.on('suspend',()=>{void client.systemCall('suspend').catch(()=>{});});
    powerMonitor.on('resume',()=>{void client.systemCall('resume').catch(()=>{});});
    let online=net.isOnline();void client.systemCall('networkState',{online,at:Date.now()}).catch(()=>{});
    networkTimer=setInterval(()=>{const value=net.isOnline();if(value!==online){online=value;void client.systemCall('networkState',{online,at:Date.now()}).catch(()=>{});}},15000);networkTimer.unref();
    if(process.argv.includes('--autostart'))win.hide();
  }).catch(error=>{dialog.showErrorBox(APP_NAME,'Não foi possível abrir o aplicativo: '+error.message);quitting=true;app.quit();});
  app.on('before-quit',event=>{
    if(quitting)return;event.preventDefault();if(quitStarted)return;
    quitStarted=true;clearInterval(networkTimer);clearInterval(licenseTimer);sounds?.shutdown();
    (async()=>{try{await Promise.allSettled([client?.shutdown(),licensing?.shutdown()]);}catch{/* Interrupted durable dispatches require review on reopen. */}finally{quitting=true;for(const request of audioRequests.values()){clearTimeout(request.timer);request.reject(new Error('Aplicativo encerrado.'));}audioRequests.clear();tray?.destroy();audioWindow?.destroy();app.quit();}})();
  });
}
