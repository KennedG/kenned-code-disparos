'use strict';

// Runs the actual main-process entry point through an Electron facade. This
// validates event wiring, not physical Windows toast display or mixer volume.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {createRequire}=require('node:module'),{EventEmitter}=require('node:events');
const {writeOwnershipManifest}=require('./ownership-manifest.cjs');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function eventually(predicate){for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}throw new Error('Condição de teste não atingida.');}
const plain=value=>JSON.parse(JSON.stringify(value));

async function desktopHarness({locked=true,argv=[],settings={}}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-desktop-test-'));
  const state={dir,handlers:new Map(),listeners:new Map(),protocols:new Map(),windows:[],notifications:[],calls:[],systemCalls:[],dialogs:[],nativeSupported:true,online:true,workers:0,finalQuit:0,shutdownCalls:0,prefs:{closeBehavior:'ask',minimizeToTray:true,sound:{enabled:false},notifications:{nativeEnabled:true},...settings}};
  const app=new EventEmitter();
  Object.assign(app,{
    setName:value=>{state.appName=value;},setAppUserModelId:value=>{state.aumid=value;},commandLine:{appendSwitch:(...args)=>{state.switch=args;}},
    setPath(){},getPath:()=>dir,getVersion:()=> 'test',requestSingleInstanceLock:()=>locked,whenReady:()=>Promise.resolve(),
    quit(){const event={preventDefault(){this.prevented=true;}};app.emit('before-quit',event);if(!event.prevented)state.finalQuit++;},
    setLoginItemSettings:value=>{state.loginSettings=plain(value);}
  });
  class Window extends EventEmitter {
    constructor(options){super();this.options=options;this.hidden=options.show===false;this.webContents=new EventEmitter();this.webContents.mainFrame={};this.sent=[];this.webContents.send=(channel,payload)=>this.sent.push({channel,payload});this.webContents.setWindowOpenHandler=fn=>{this.windowOpenHandler=fn;};state.windows.push(this);}
    async loadFile(filename){this.loaded=filename;}isDestroyed(){return !!this.destroyed;}show(){this.hidden=false;}hide(){this.hidden=true;}focus(){this.focused=true;}destroy(){this.destroyed=true;}
  }
  class Client extends EventEmitter {
    constructor(worker,{host}){super();state.client=this;state.host=host;this.ready=Promise.resolve(state.prefs);}
    async call(action,payload){state.calls.push({action,payload});if(state.callResult)return state.callResult(action,payload);return {action};}
    async systemCall(action,payload){state.systemCalls.push({action,payload});return true;}
    async shutdown(){state.shutdownCalls++;if(state.shutdownGate)await state.shutdownGate.promise;}
  }
  class SoundController {
    constructor(){state.sound=this;}
    handle(payload,prefs){state.lastSound={payload,prefs};return {soundStatus:'disabled'};}
    async test(prefs){state.testPrefs=prefs;return {soundStatus:prefs.volume===0?'silent':'completed'};}
    mute(id){state.muted=id;}shutdown(){state.soundStopped=true;}
  }
  class TestNotification extends EventEmitter {
    constructor(options){super();this.options=options;state.notifications.push(this);}static isSupported(){return state.nativeSupported;}show(){this.requested=true;}
  }
  const powerMonitor=new EventEmitter();
  const electron={app,BrowserWindow:Window,ipcMain:{handle:(name,fn)=>state.handlers.set(name,fn),on:(name,fn)=>state.listeners.set(name,fn)},dialog:{showMessageBox:async(_,payload)=>{state.dialogs.push(payload);return {response:state.dialogResponse??2};},showOpenDialog:async()=>({canceled:true}),showSaveDialog:async()=>({canceled:true}),showErrorBox:(_,message)=>{state.startupError=message;}},Tray:class extends EventEmitter{constructor(){super();state.tray=this;}setToolTip(){}setContextMenu(menu){this.menu=menu;}destroy(){this.destroyed=true;}},Menu:{buildFromTemplate:value=>value,setApplicationMenu(){}},nativeImage:{createFromPath:()=>({})},shell:{openPath:async()=>''},powerMonitor,safeStorage:{isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value),decryptString:buffer=>buffer.toString()},protocol:{registerSchemesAsPrivileged(value){state.schemes=value;},handle:(name,fn)=>state.protocols.set(name,fn)},net:{isOnline:()=>state.online,fetch:async url=>({url})},Notification:TestNotification};
  const filename=path.resolve(__dirname,'../src/main.cjs'),baseRequire=createRequire(filename);
  const localRequire=name=>name==='electron'?electron:name==='node:worker_threads'?{Worker:class{constructor(){state.workers++;}}}:name==='./core/worker-client.cjs'?{WorkerClient:Client}:name==='./core/sound.cjs'?{SoundController}:baseRequire(name);
  const intervals=[];
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{require:localRequire,__dirname:path.dirname(filename),process:{env:{MEGA_DATA_DIR:dir},platform:'win32',argv,execPath:'C:\\Mega Disparos.exe'},setTimeout,clearTimeout,setInterval:fn=>{const timer={fn,unref(){}};intervals.push(timer);return timer;},clearInterval:timer=>{if(timer)timer.cleared=true;},Response,URL,Promise,Buffer,Date},{filename});
  if(locked)await eventually(()=>state.windows.length===2||state.startupError);
  assert(!state.startupError,state.startupError);
  const win=state.windows.find(w=>w.options.show!==false),audioWindow=state.windows.find(w=>w.options.show===false);
  const event=()=>({sender:win.webContents,senderFrame:win.webContents.mainFrame});
  return {state,app,win,audioWindow,powerMonitor,intervals,event,call:(action,payload={})=>state.handlers.get('mega:call')(event(),action,payload),async close(){if(locked){state.shutdownGate?.resolve();app.quit();await eventually(()=>state.finalQuit>0);}fs.rmSync(dir,{recursive:true,force:true});}};
}

async function testSingleInstanceAndIpcBoundary(){
  const stopped=await desktopHarness({locked:false});try{assert.equal(stopped.state.workers,0);assert.equal(stopped.state.windows.length,0);assert.equal(stopped.state.handlers.size,0);assert.equal(stopped.state.finalQuit,1);}finally{await stopped.close();}
  const h=await desktopHarness();try{
    assert.equal(h.state.aumid,'br.com.megadisparos.desktop');assert.equal(h.state.workers,1);
    assert.equal(h.win.options.webPreferences.contextIsolation,true);assert.equal(h.win.options.webPreferences.nodeIntegration,false);assert.equal(h.win.options.webPreferences.sandbox,true);
    assert.equal(h.audioWindow.options.webPreferences.backgroundThrottling,false);
    const ipc=h.state.handlers.get('mega:call');
    for(const event of [{sender:{},senderFrame:h.win.webContents.mainFrame},{sender:h.win.webContents,senderFrame:{}},{sender:h.audioWindow.webContents,senderFrame:h.audioWindow.webContents.mainFrame}])assert.equal((await ipc(event,'stopAll')).error,'Ação não autorizada.');
    assert.equal(h.state.calls.length,0,'Pedidos de outra janela ou subframe não alcançam o backend.');
    assert.deepEqual(plain(await h.call('snapshot')),{action:'snapshot'});
    h.state.callResult=async()=>{throw Object.assign(new Error('Acesso negado.'),{code:'AUTH_DENIED'});};assert.deepEqual(plain(await h.call('stopAll')),{error:'Acesso negado.',code:'AUTH_DENIED'});
    h.state.tray.menu.find(item=>item.label==='PARAR TODOS OS ENVIOS').click();await eventually(()=>h.state.dialogs.some(d=>/Entre com um usuário autorizado/.test(d.message)));
    assert.equal(h.state.calls.at(-1).action,'stopAll');assert(!h.state.systemCalls.some(c=>c.action==='emergencyStop'),'A bandeja conserva a autorização do usuário.');
    const foreign={preventDefault(){this.prevented=true;}};h.win.webContents.emit('will-navigate',foreign,'https://example.invalid');assert.equal(foreign.prevented,true);assert.equal(h.win.windowOpenHandler().action,'deny');
  }finally{await h.close();}
}

async function testNativeNotificationAcknowledgement(){
  const h=await desktopHarness();try{
    const payload={id:'disconnect-1',event:'disconnect',at:Date.now(),title:'WhatsApp desconectou',body:'Confira a conexão.'};
    assert.equal((await h.state.host('localAlert',payload)).nativeStatus,'requested');assert.equal(h.state.notifications.length,1);assert.equal(h.state.notifications[0].options.silent,true);
    assert.equal(h.state.systemCalls.filter(c=>c.action==='nativeNotificationResult').length,0,'Solicitar ao Windows não confirma que a notificação foi exibida.');
    h.state.notifications[0].emit('show');await eventually(()=>h.state.systemCalls.some(c=>c.action==='nativeNotificationResult'));
    assert.deepEqual(plain(h.state.systemCalls.at(-1).payload),{id:payload.id,status:'shown'});
    assert.equal((await h.state.host('localAlert',payload)).nativeStatus,'suppressed');assert.equal(h.state.notifications.length,1);
    await h.state.host('localAlert',{...payload,id:'disconnect-2'});h.state.notifications[1].emit('failed');assert.equal(h.state.systemCalls.at(-1).payload.status,'failed');
    h.state.nativeSupported=false;assert.equal((await h.state.host('localAlert',{...payload,id:'unsupported'})).nativeStatus,'unsupported');
    assert.equal((await h.state.host('localAlert',{...payload,id:'disabled',nativeEnabled:false})).nativeStatus,'disabled');assert.equal(h.state.notifications.length,2);
  }finally{await h.close();}
}

async function testLifecycleAndNetwork(){
  const h=await desktopHarness({argv:['--autostart']});try{
    assert.equal(h.win.hidden,true);h.app.emit('second-instance');assert.equal(h.win.hidden,false);
    h.powerMonitor.emit('suspend');h.powerMonitor.emit('resume');assert(h.state.systemCalls.some(c=>c.action==='suspend'));assert(h.state.systemCalls.some(c=>c.action==='resume'));
    const timer=h.intervals[0];assert(timer);const initialNetworkCalls=h.state.systemCalls.filter(c=>c.action==='networkState').length;timer.fn();assert.equal(h.state.systemCalls.filter(c=>c.action==='networkState').length,initialNetworkCalls);
    h.state.online=false;timer.fn();assert.equal(h.state.systemCalls.at(-1).action,'networkState');assert.equal(h.state.systemCalls.at(-1).payload.online,false);timer.fn();assert.equal(h.state.systemCalls.filter(c=>c.action==='networkState').length,initialNetworkCalls+1);
    h.win.emit('minimize');assert.equal(h.win.hidden,true);
    h.win.show();h.state.dialogResponse=0;const event={preventDefault(){this.prevented=true;}};h.win.emit('close',event);await eventually(()=>h.win.hidden);assert(event.prevented);assert.equal(h.state.finalQuit,0);
    assert(/computador precisa estar ligado/i.test(h.state.dialogs.at(-1).detail));
    await h.state.host('setLoginItemSettings',{openAtLogin:true});assert.deepEqual(h.state.loginSettings,{openAtLogin:true,path:'C:\\Mega Disparos.exe',args:['--autostart']});
    h.state.shutdownGate=deferred();h.app.quit();h.app.quit();assert.equal(h.state.shutdownCalls,1);assert.equal(h.state.finalQuit,0);assert.equal(timer.cleared,true);assert.equal(h.state.soundStopped,true);
    h.state.shutdownGate.resolve();await eventually(()=>h.state.finalQuit>0);assert.equal(h.state.tray.destroyed,true);assert.equal(h.audioWindow.destroyed,true);
  }finally{await h.close();}
}

async function testActualAudioRenderer(){
  const state={ended:[],contexts:[],audios:[],timers:[],gains:[]},bridge={
    onPlay:fn=>{state.play=fn;},onStop:fn=>{state.stop=fn;},ended:(id,success)=>state.ended.push({id,success})
  };
  class Context {
    constructor(){state.contexts.push(this);this.destination={};this.currentTime=0;this.oscillators=[];}
    async resume(){this.resumed=true;}async close(){this.closed=true;}
    createGain(){const result={gain:{value:0,setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){}};state.gains.push(result);return result;}
    createOscillator(){const result={frequency:{value:0},connect(){},start(){},stop(){}};this.oscillators.push(result);return result;}
  }
  class AudioFile {
    constructor(url){this.src=url;state.audios.push(this);}async play(){this.played=true;}pause(){this.paused=true;}
  }
  const filename=path.resolve(__dirname,'../src/ui/audio-player.js');
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{window:{megaAudio:bridge},AudioContext:Context,Audio:AudioFile,setTimeout:(callback,ms)=>{const timer={callback,ms};state.timers.push(timer);return timer;},clearTimeout:timer=>{if(timer)timer.cleared=true;},Number,Math},{filename});
  await state.play({id:'tone-37',sound:'soft',volume:0.37});assert.equal(state.gains[0].gain.value,0.37);assert.equal(state.contexts[0].resumed,true);assert.equal(state.contexts[0].oscillators.length,2);
  state.timers.at(-1).callback();await eventually(()=>state.ended.length===1);assert.deepEqual(state.ended[0],{id:'tone-37',success:true});assert.equal(state.contexts[0].closed,true);
  await state.play({id:'tone-limit',sound:'urgent',volume:2});assert.equal(state.gains[3].gain.value,1);assert.equal(state.contexts[1].oscillators.length,3);
  state.stop({id:'different-alert'});assert.equal(state.ended.length,1);state.stop({id:'tone-limit'});await eventually(()=>state.ended.length===2);assert.equal(state.contexts[1].closed,true);
  await state.play({id:'custom-62',sound:'custom',volume:0.62,audioUrl:'mega-audio://asset/test'});assert.equal(state.audios[0].volume,0.62);assert.equal(state.audios[0].played,true);assert.equal(state.timers.at(-1).ms,15000);
  state.audios[0].onended();await eventually(()=>state.ended.length===3);assert.deepEqual(state.ended[2],{id:'custom-62',success:true});assert.equal(state.audios[0].paused,true);assert.equal(state.audios[0].src,'');
  await state.play({id:'custom-error',sound:'custom',volume:0.5,audioUrl:'mega-audio://asset/error'});state.audios[1].onerror();await eventually(()=>state.ended.length===4);assert.equal(state.ended[3].success,false);
  await state.play({id:'missing-file',sound:'custom',volume:0.5});assert.deepEqual(state.ended.at(-1),{id:'missing-file',success:false});
}

function testOwnershipManifest(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-owned-test-'));
  try{
    fs.mkdirSync(path.join(dir,'resources','nested'),{recursive:true});fs.writeFileSync(path.join(dir,'Mega Disparos.exe'),'app');fs.writeFileSync(path.join(dir,'resources','nested','app.asar'),'payload');
    const result=writeOwnershipManifest(dir);assert.equal(result.files,2);
    const manifest=fs.readFileSync(path.join(dir,'.mega-owned-files.txt'),'utf16le').trim().split(/\r?\n/);
    assert(manifest.includes('F|resources\\nested\\app.asar'));assert(manifest.indexOf('D|resources\\nested')<manifest.indexOf('D|resources'));
    fs.writeFileSync(path.join(dir,'minhas-anotacoes.txt'),'preservar');
    for(const line of manifest){const target=path.join(dir,...line.slice(2).split('\\'));if(line.startsWith('F|'))fs.unlinkSync(target);else if(line.startsWith('D|'))fs.rmdirSync(target);}
    assert.equal(fs.readFileSync(path.join(dir,'minhas-anotacoes.txt'),'utf8'),'preservar');
    const nsis=fs.readFileSync(path.join(__dirname,'installer.nsi'),'utf8');assert(!/RMDir\s+\/r\s+"\$INSTDIR"/i.test(nsis));assert(nsis.includes('Call ValidateInstallDirectory'));assert(nsis.includes('Call un.EnsureAppClosed'));assert(nsis.includes('WinShell::SetLnkAUMI'));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}

(async()=>{testOwnershipManifest();await testSingleInstanceAndIpcBoundary();await testNativeNotificationAcknowledgement();await testLifecycleAndNetwork();await testActualAudioRenderer();console.log('Desktop: 5 fluxos passaram (instância/IPC/bandeja, retorno das notificações, suspensão/rede/encerramento, manifesto e renderizador real de áudio com ganho/volume). Facade nativa; exibição e áudio físicos no Windows não verificados.');})().catch(error=>{console.error(error);process.exitCode=1;});
