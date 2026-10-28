const {app,BrowserWindow,ipcMain,dialog,Tray,Menu,nativeImage,shell,powerMonitor,safeStorage,protocol,net} = require('electron');
const {pathToFileURL}=require('node:url');
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {createStore,seed}=require('./core/store.cjs');
const {MediaManager}=require('./core/media.cjs');
const validation=require('./core/validation.cjs');
const {Scheduler}=require('./core/scheduler.cjs');
const {CommandController}=require('./core/commands.cjs');
const {SimulatedAdapter}=require('./adapters/simulated.cjs');
const {WhatsAppAdapter}=require('./adapters/whatsapp.cjs');

app.setName('Mega Disparos');
protocol.registerSchemesAsPrivileged([{scheme:'mega-media',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}]);
if(process.env.MEGA_DATA_DIR) app.setPath('userData',path.resolve(process.env.MEGA_DATA_DIR));
const locked=app.requestSingleInstanceLock();
if(!locked) app.quit();
let win,tray,store,media,scheduler,adapter,commands,quitting=false,quitStarted=false,maintenance=false;
let mutationQueue=Promise.resolve();
const immediateActions=new Set(['snapshot','previewCampaign','stopAll','windowMinimize','windowQuit','openDataFolder']);
function enqueueMutation(task){const result=mutationQueue.then(task);mutationQueue=result.catch(()=>{});return result;}
async function withMaintenance(task){
  if(maintenance)throw new Error('Aguarde a manutenção dos dados e da conexão terminar.');
  maintenance=true;broadcast();
  try{return await task();}finally{maintenance=false;broadcast();}
}
const settingKeys=['integrationMode','admins','theme','maxSelectedGroups','launchAtLogin','closeBehavior','minimizeToTray','unofficialAcknowledged'];
function snapshot(){
  const campaigns=store.listCampaigns(),recentJobs=store.listJobs({limit:500}),groups=store.listGroups();
  const jobs=[...new Map([...recentJobs,...store.listJobs({status:'uncertain'})].map(j=>[j.id,j])).values()].sort((a,b)=>b.createdAt-a.createdAt);
  const settings=Object.fromEntries(settingKeys.map(k=>[k,store.getSetting(k)]));
  const storageError=store.persistenceFailed||scheduler.persistenceFailed?'Armazenamento indisponível: envios bloqueados. Corrija o espaço ou as permissões e reabra o aplicativo.':null;
  return {connection:{...adapter.status,detail:storageError?`${adapter.status.detail||''} ${storageError}`:adapter.status.detail},storageError,maintenance,campaigns,groups,media:store.listMedia().map(m=>({...m,previewUrl:`mega-media://asset/${encodeURIComponent(m.id)}`})),templates:store.listTemplates(),settings,history:jobs.map(j=>({...j,campaignName:store.getCampaign(j.campaignId)?.name||j.campaignId,groupName:store.getGroup(j.groupId)?.name||j.groupId,content:j.itemSnapshot?.text||j.itemSnapshot?.caption||j.itemId})),metrics:{confirmed:store.listJobs({status:'confirmed'}).length,failed:store.listJobs({status:'failed'}).length,uncertain:store.listJobs({status:'uncertain'}).length,activeCampaigns:campaigns.filter(c=>c.state==='active').length,selectedGroups:new Set(campaigns.flatMap(c=>c.groupIds||[])).size,nextRunAt:campaigns.filter(c=>c.state==='active'&&c.nextRunAt).map(c=>c.nextRunAt).sort((a,b)=>a-b)[0]||null},dataDir:store.dir,version:app.getVersion()};
}
function broadcast(){if(win&&!win.isDestroyed())win.webContents.send('mega:update',snapshot());}
function makeAdapter(){return store.getSetting('integrationMode','simulated')==='whatsapp'?new WhatsAppAdapter({store,credentialsDir:path.join(store.dir,'credentials'),safeStorage}):new SimulatedAdapter({store});}
function bindAdapter(){
  adapter.on('status',status=>{broadcast();if(status.state==='connected')adapter.listGroups().then(groups=>{store.upsertGroups(groups);broadcast();}).catch(()=>{});});
  const source=adapter;
  adapter.on('incoming',ctx=>{
    const emergency=ctx.type==='text'&&/^!mega\s+(?:parar\s+tudo|pausar\s+\S+)\s*$/i.test(String(ctx.text||''));
    if(source!==adapter||(maintenance&&!emergency))return;
    const handle=()=>{if(source===adapter&&(!maintenance||emergency))return commands.handle(ctx);};
    (emergency?Promise.resolve().then(handle):enqueueMutation(handle)).catch(()=>{/* Never log private control messages. */});
  });
  adapter.on('receipt',broadcast);
}
function showWindow(){win.show();win.focus();}
function createWindow(){
  win=new BrowserWindow({width:1380,height:900,minWidth:1060,minHeight:700,title:'Mega Disparos',backgroundColor:'#0b101b',icon:path.join(__dirname,'../assets/icon.png'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
  win.loadFile(path.join(__dirname,'ui/index.html'));
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,url)=>{if(url.split('#')[0]!==pathToFileURL(path.join(__dirname,'ui/index.html')).href)event.preventDefault();});
  win.on('minimize',()=>{if(store.getSetting('minimizeToTray',true))win.hide();});
  win.on('close',async event=>{
    if(quitting)return;
    event.preventDefault();
    const behavior=store.getSetting('closeBehavior','ask');
    if(behavior==='tray'){win.hide();return;}
    if(behavior==='quit'){app.quit();return;}
    const result=await dialog.showMessageBox(win,{type:'question',title:'Fechar Mega Disparos',message:'Deseja continuar com os agendamentos na bandeja ou encerrar o aplicativo?',detail:'O envio depende deste computador ligado, conectado e sem suspensão.',buttons:['Minimizar para a bandeja','Encerrar aplicativo','Cancelar'],cancelId:2,defaultId:0});
    if(result.response===0)win.hide();else if(result.response===1)app.quit();
  });
  tray=new Tray(nativeImage.createFromPath(path.join(__dirname,'../assets/tray.png')));
  tray.setToolTip('Mega Disparos • agendamentos locais');
  tray.setContextMenu(Menu.buildFromTemplate([{label:'Abrir Mega Disparos',click:showWindow},{label:'PARAR TODOS OS ENVIOS',click:()=>scheduler.stopAll().then(broadcast)},{type:'separator'},{label:'Encerrar',click:()=>app.quit()}]));
  tray.on('double-click',showWindow);Menu.setApplicationMenu(null);
}
function getCampaign(id){const c=store.getCampaign(id);if(!c)throw new Error('Campanha não encontrada.');return c;}
function configurationRevision(c){return c.configRevision??c.revision;}
function checkRevision(c,revision,state,configuration=true){if((configuration?configurationRevision(c):c.revision)!==Number(revision)||(state!==undefined&&c.state!==state))throw new Error('A configuração ou o estado da campanha mudou. Abra uma nova prévia antes de confirmar.');}
function candidateSummary(c){
  const content=items=>items.map((i,n)=>`${n+1}. ${i.type==='text'?i.text:store.getMedia(i.mediaId)?.name}${i.caption?' — '+i.caption:''}`).join('\n');
  const individual=Object.entries(c.groupOverrides||{}).filter(([,v])=>v.enabled).map(([g,v])=>`${store.getGroup(g)?.name||g}: ${v.intervalMinutes} minutos, ${v.schedule.startTime}–${v.schedule.endTime}, dias ${v.schedule.days.join(', ')}.\n${content(v.items?.length?v.items:c.items)}`).join('\n\n');
  return `${c.name}\n\n${c.items.length} conteúdos • ${c.groupIds.length} grupos\n${c.mode==='repeat'?'Repetir conjunto':'Alternar um item por rodada'}\nRodadas a cada ${c.intervalMinutes} minutos; envios espaçados ${c.spacingSeconds} segundos.\nHorário: ${c.schedule.startTime}–${c.schedule.endTime}, dias ${c.schedule.days.join(', ')}.\nDatas ${c.schedule.startDate||'sem início fixo'} a ${c.schedule.endDate||'sem encerramento'}.\nLimite diário: ${c.dailyRoundLimit||'sem limite'} rodadas, ${c.dailySendLimit||'sem limite'} envios.\n\nGrupos:\n${c.groupIds.map(id=>store.getGroup(id)?.name||id).join('\n')}\n\nConteúdo:\n${content(c.items)}${individual?'\n\nConfigurações individuais:\n'+individual:''}`;
}
async function switchMode(mode){
  await scheduler.stopAll();await adapter.disconnect();await scheduler.waitForIdle();adapter.removeAllListeners();
  store.setSetting('integrationMode',mode);adapter=makeAdapter();scheduler.setAdapter(adapter);commands=new CommandController({store,scheduler,adapter,mediaManager:media});bindAdapter();
  if(mode==='simulated'){await adapter.connect();store.upsertGroups(await adapter.listGroups());}
}
const actions={
  snapshot:async()=>snapshot(),
  connect:async()=>{await adapter.connect({reconnect:true});if(adapter.status.state==='connected')store.upsertGroups(await adapter.listGroups());return adapter.status;},
  disconnect:async()=>{for(const c of store.listCampaigns())if(c.state==='active')await scheduler.pause(c.id);await adapter.disconnect({logout:true});return adapter.status;},
  refreshGroups:async()=>{store.upsertGroups(await adapter.listGroups());return store.listGroups();},
  authorizeGroup:async p=>{if(!p.authorized)for(const c of store.listCampaigns())if(c.state==='active'&&c.groupIds.includes(p.id))await scheduler.pause(c.id);return store.authorizeGroup(p.id,p.authorized);},
  saveCampaign:async p=>{
    const c=validation.campaign(p.campaign,store),old=store.getCampaign(c.id);
    if(old)checkRevision(old,p.campaign.configRevision??p.campaign.revision,p.campaign.state,p.campaign.configRevision!==undefined);
    if(old?.state==='active'){
      const r=await dialog.showMessageBox(win,{type:'question',title:'Confirmar alterações',message:'Alterar a campanha em execução?',detail:candidateSummary(c),buttons:['Cancelar','Confirmar alterações'],defaultId:0,cancelId:0});if(r.response!==1)return {cancelled:true};
      checkRevision(getCampaign(c.id),configurationRevision(old),old.state);await scheduler.pause(c.id);await scheduler.waitForIdle();
    }
    const latest=old?getCampaign(c.id):null;
    if(latest)checkRevision(latest,configurationRevision(old));
    const shouldResume=old?.state==='active'&&latest?.state==='paused';
    const saved=store.saveCampaign({...c,...(latest?{state:latest.state,roundIndex:latest.roundIndex,nextRunAt:latest.nextRunAt}: {})});
    if(shouldResume)await scheduler.resume(saved.id);return store.getCampaign(saved.id);
  },
  duplicateCampaign:async p=>{const c=getCampaign(p.id);return store.saveCampaign({...c,id:randomUUID(),name:`${c.name.slice(0,105)} (cópia)`,state:'draft',nextRunAt:null,roundIndex:0,items:c.items.map(i=>({...i,id:randomUUID()}))});},
  deleteCampaign:async p=>{const c=getCampaign(p.id);await scheduler.pause(c.id);await scheduler.waitForIdle();store.deleteCampaign(c.id);return true;},
  previewCampaign:async p=>({summary:scheduler.getSummary(p.id),campaign:getCampaign(p.id)}),
  activateCampaign:async p=>{checkRevision(getCampaign(p.id),p.configRevision??p.revision,p.summaryState,p.configRevision!==undefined);await scheduler.activate(p.id);return getCampaign(p.id);},
  pauseCampaign:async p=>{await scheduler.pause(p.id);return getCampaign(p.id);},
  resumeCampaign:async p=>{checkRevision(getCampaign(p.id),p.configRevision??p.revision,p.summaryState,p.configRevision!==undefined);await scheduler.resume(p.id);return getCampaign(p.id);},
  stopAll:async()=>{await scheduler.stopAll();return true;},
  importMedia:async()=>{const result=await dialog.showOpenDialog(win,{title:'Importar mídias para a biblioteca',properties:['openFile','multiSelections'],filters:[{name:'Mídias e documentos',extensions:['jpg','jpeg','png','webp','mp4','mov','pdf','doc','docx','xls','xlsx','pptx','txt','csv','zip']}]});if(result.canceled)return [];const imported=[];for(const file of result.filePaths)imported.push(await media.importFile(file));return imported;},
  saveTemplate:async p=>{if(!String(p.name||'').trim())throw new Error('Informe o nome do modelo.');return store.saveTemplate({id:randomUUID(),name:String(p.name).slice(0,120),items:validation.items(p.items,store),createdAt:Date.now()});},
  deleteTemplate:async p=>{store.deleteTemplate(p.id);return true;},
  saveSettings:async p=>{
    const v=p.settings||{},next={};
    if(v.theme!==undefined){if(!['dark','light','system'].includes(v.theme))throw new Error('Tema inválido.');next.theme=v.theme;}
    if(v.admins!==undefined){if(!Array.isArray(v.admins))throw new Error('Administradores inválidos.');next.admins=[...new Set(v.admins.map(n=>String(n).replace(/\D/g,'')))];if(next.admins.some(n=>!/^\d{10,15}$/.test(n)))throw new Error('Administradores: use código do país + DDD + número, com 10 a 15 dígitos.');}
    if(v.maxSelectedGroups!==undefined)next.maxSelectedGroups=Math.floor(validation.number(v.maxSelectedGroups,1,1000,'Limite de grupos'));
    if(v.closeBehavior!==undefined){if(!['tray','quit','ask'].includes(v.closeBehavior))throw new Error('Opção de fechamento inválida.');next.closeBehavior=v.closeBehavior;}
    for(const key of ['launchAtLogin','minimizeToTray','unofficialAcknowledged'])if(v[key]!==undefined)next[key]=!!v[key];
    if(v.integrationMode!==undefined&&!['simulated','whatsapp'].includes(v.integrationMode))throw new Error('Integração inválida.');
    if(v.integrationMode==='whatsapp'&&!(next.unofficialAcknowledged??store.getSetting('unofficialAcknowledged',false)))throw new Error('Leia e reconheça as limitações da integração não oficial antes de conectar.');
    for(const [key,value] of Object.entries(next))store.setSetting(key,value);
    if(process.platform==='win32'&&next.launchAtLogin!==undefined)app.setLoginItemSettings({openAtLogin:next.launchAtLogin,path:process.execPath,args:['--autostart']});
    if(v.integrationMode&&v.integrationMode!==store.getSetting('integrationMode'))await withMaintenance(()=>switchMode(v.integrationMode));
    return snapshot().settings;
  },
  backup:async()=>{const r=await dialog.showSaveDialog(win,{title:'Backup de campanhas e mídias',defaultPath:`Mega-Disparos-${new Date().toISOString().slice(0,10)}.mega.json`,filters:[{name:'Backup Mega Disparos',extensions:['json']}]});if(r.canceled)return {cancelled:true};await media.createBackup(r.filePath);return {path:r.filePath};},
  restore:async()=>{const r=await dialog.showOpenDialog(win,{title:'Restaurar backup',properties:['openFile'],filters:[{name:'Backup Mega Disparos',extensions:['json']}]});if(r.canceled)return {cancelled:true};const answer=await dialog.showMessageBox(win,{type:'question',message:'Restaurar campanhas, mídias e configurações?',detail:'Os dados atuais serão copiados para um backup automático. As campanhas restauradas ficarão desativadas e a conexão será simulada.',buttons:['Cancelar','Restaurar'],cancelId:0,defaultId:0});if(answer.response!==1)return {cancelled:true};return withMaintenance(async()=>{await scheduler.stopAll();await adapter.disconnect();await scheduler.waitForIdle();await media.createBackup(path.join(store.dir,'backups',`antes-restauracao-${Date.now()}.mega.json`));const result=await media.restoreBackup(r.filePaths[0]);await switchMode('simulated');if(process.platform==='win32')app.setLoginItemSettings({openAtLogin:!!store.getSetting('launchAtLogin',false),path:process.execPath,args:['--autostart']});return result;});},
  openDataFolder:async()=>shell.openPath(store.dir),
  testSimulation:async p=>{if(adapter.status.mode!=='simulated'&&store.getSetting('integrationMode')!=='simulated')throw new Error('Disponível somente no modo simulado.');const senderNumber=String(p.senderNumber||'').replace(/\D/g,'');const before=adapter.replies?.length||0;await commands.handle({messageId:randomUUID(),senderNumber,verified:true,isGroup:!!p.isGroup,forwarded:!!p.forwarded,fromMe:false,chatId:`${senderNumber}@s.whatsapp.net`,text:String(p.text||''),type:'text',timestamp:Date.now()});const replies=adapter.replies?.slice(before)||[];return replies.length?{text:replies.map(r=>r.text).join('\n\n'),replies}:{text:'Comando ignorado; confira a autorização.'};},
  reviewJob:async p=>{const j=store.getJob(p.id);if(!j||j.status!=='uncertain')throw new Error('Envio incerto não encontrado.');if(!['confirm','discard'].includes(p.decision))throw new Error('Decisão inválida.');return store.updateJob(j.id,{status:p.decision==='confirm'?'confirmed':'cancelled',resultAt:Date.now(),error:p.decision==='confirm'?'Confirmado manualmente após verificação no WhatsApp.':'Descartado manualmente. Não reenviado.',reviewed:true});},
  windowMinimize:async()=>{win.hide();return true;},windowQuit:async()=>{app.quit();return true;}
};
if(locked){
  app.on('second-instance',()=>{if(win)showWindow();});
  app.whenReady().then(async()=>{
    store=await createStore(app.getPath('userData'));seed(store);store.recoverInterrupted();media=new MediaManager(store);adapter=makeAdapter();scheduler=new Scheduler({store,adapter});commands=new CommandController({store,scheduler,adapter,mediaManager:media});bindAdapter();
    protocol.handle('mega-media',request=>{try{const url=new URL(request.url);if(url.hostname!=='asset')throw new Error('Destino inválido.');const file=media.getPath(decodeURIComponent(url.pathname.slice(1)));return net.fetch(pathToFileURL(file).href,{headers:request.headers});}catch{return new Response('Mídia não encontrada',{status:404});}});
    ipcMain.handle('mega:call',async(event,action,payload)=>{
      if(event.sender!==win?.webContents||event.senderFrame!==win.webContents.mainFrame||!Object.hasOwn(actions,action))return {error:'Ação não autorizada.'};
      if(maintenance&&!immediateActions.has(action))return {error:'Aguarde a manutenção dos dados e da conexão terminar.'};
      try{const invoke=()=>{if(maintenance&&!immediateActions.has(action))throw new Error('Aguarde a manutenção dos dados e da conexão terminar.');return actions[action](payload||{});};const result=await (immediateActions.has(action)?invoke():enqueueMutation(invoke));broadcast();return result;}catch(e){if(store.persistenceFailed)scheduler.blockOnPersistenceFailure();broadcast();return {error:e.message||'Não foi possível concluir a ação.'};}
    });
    createWindow();scheduler.on?.('change',broadcast);scheduler.start();
    if(store.getSetting('integrationMode')==='simulated'){await adapter.connect();store.upsertGroups(await adapter.listGroups());}
    powerMonitor.on('suspend',()=>{for(const c of store.listCampaigns())if(c.state==='active')scheduler.pause(c.id);broadcast();});
    powerMonitor.on('resume',broadcast);
    setInterval(broadcast,5000).unref();
    if(process.argv.includes('--autostart'))win.hide();
  }).catch(async e=>{dialog.showErrorBox('Mega Disparos',`Não foi possível abrir o aplicativo: ${e.message}`);quitting=true;app.quit();});
  app.on('before-quit',event=>{
    if(quitting)return;event.preventDefault();if(quitStarted)return;quitStarted=true;
    (async()=>{try{await scheduler?.stopAll();await adapter?.disconnect();await scheduler?.shutdown();store?.close();}finally{quitting=true;tray?.destroy();app.quit();}})();
  });
}
