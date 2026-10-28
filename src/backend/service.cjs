'use strict';

// Runs in the backend worker. The desktop process only owns native Windows
// facilities and forwards explicitly named requests; it never owns the queue.
const {EventEmitter}=require('node:events');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID,randomBytes,createHash}=require('node:crypto');
const {createStore,seed,atomicWrite}=require('../core/store.cjs');
const {MediaManager}=require('../core/media.cjs');
const validation=require('../core/validation.cjs');
const {Scheduler}=require('../core/scheduler.cjs');
const {CommandController}=require('../core/commands.cjs');
const {SimulatedAdapter}=require('../adapters/simulated.cjs');
const {WhatsAppAdapter}=require('../adapters/whatsapp.cjs');
const {AuthService}=require('../core/auth.cjs');
const {AlertService}=require('../core/alerts.cjs');
const {SearchService}=require('../core/search-service.cjs');
const {writeRecordsJSON}=require('../core/export-records.cjs');

const SETTINGS=['integrationMode','admins','theme','maxSelectedGroups','launchAtLogin','closeBehavior','minimizeToTray','unofficialAcknowledged','reconnect','sound','notifications','retention','webhook'];
const DEFAULTS={reconnect:{enabled:false,maxAttempts:3,delaySeconds:15,autoResume:false},notifications:{nativeEnabled:true},sound:{enabled:true,volume:65,sound:'soft',customAudioId:null,events:['disconnect','critical'],repeat:false,intervalSeconds:30,maxRepeats:3,quiet:{enabled:false,start:'22:00',end:'08:00'}},retention:{days:90,maxEntries:20000,maxMegabytes:64},webhook:{enabled:false,url:''}};
const HISTORY_CATEGORIES=['campaigns','sends','errors','notifications'];
const cleanPhone=value=>String(value||'').replace(/[\s()+.-]/g,'');
const validPhone=value=>/^\d{10,15}$/.test(value);
const withoutPath=m=>{const {path:ignored,...safe}=m;return {...safe,previewUrl:`mega-media://asset/${encodeURIComponent(m.id)}`};};
const bounded=(v,min,max,name)=>validation.number(v,min,max,name);
const asText=(value,max)=>String(value??'').slice(0,max);

async function createAppService({dir,safeStorage,host=async()=>{throw new Error('Recurso nativo indisponível.');},version='2.0.0',runtimePlatform='win32',now=()=>Date.now()}={}){
  const store=await createStore(dir);seed(store);store.recoverInterrupted();
  for(const [key,value] of Object.entries(DEFAULTS))if(store.getSetting(key)===undefined)store.setSetting(key,value);
  const media=new MediaManager(store),events=new EventEmitter();
  let channelUrl='';try{const value=await host('secretGet',{key:'webhookUrl'});if(typeof value==='string')channelUrl=value;}catch{}
  const auth=new AuthService({store,clock:now});
  let adapter,scheduler,commands,alerts,searches,maintenance=false,closed=false,tail=Promise.resolve(),updateTimer=null,retentionTimer=null;
  const cleanupTokens=new Map();
  const nativeTasks=new Set();
  const audioDir=path.join(dir,'audio');fs.mkdirSync(audioDir,{recursive:true});
  const settings=()=>{const result=Object.fromEntries(SETTINGS.map(k=>[k,store.getSetting(k)]));result.sound={...result.sound,customAudioName:(store.getSetting('audioAssets',[])||[]).find(a=>a.id===result.sound.customAudioId)?.name||''};if(result.webhook)result.webhook={...result.webhook,url:can('settings.edit')&&channelUrl?channelUrl:result.webhook.url};return result;};
  const makeAdapter=()=>store.getSetting('integrationMode','simulated')==='whatsapp'?new WhatsAppAdapter({store,credentialsDir:path.join(dir,'credentials'),safeStorage}):new SimulatedAdapter({store});
  const can=(permission,campaign)=>auth.can(permission,campaign);
  const assert=(permission,campaign)=>auth.assert(permission,campaign);
  const user=()=>auth.currentUser();
  const campaigns=()=>store.listCampaigns().filter(c=>can('campaign.view',c));
  const campaignIds=()=>campaigns().map(c=>c.id);
  const scopeIds=()=>user()?.isOwner||auth.status().campaignScope==='all'?undefined:store.listCampaigns().filter(c=>(c.ownerId||c.ownerUserId)===user()?.id).map(c=>c.id);
  function assertGlobal(permission,requirements=[]){assert(permission);if(!user()?.isOwner&&auth.status().campaignScope!=='all')throw new Error('Esta operação altera ou exporta dados de todo o aplicativo e exige acesso a todas as campanhas.');for(const p of requirements){assert(p);if(p.startsWith('campaign.'))for(const c of store.listCampaigns())assert(p,c);}}
  const assertModeChange=()=>assertGlobal('settings.edit',['connection.manage','campaign.stop']);
  const assertBackup=()=>assertGlobal('settings.edit',['campaign.view','media.view','groups.view','contacts.view','notifications.view']);
  const assertRestore=()=>assertGlobal('settings.edit',['connection.manage','users.edit','campaign.view','campaign.create','campaign.edit','campaign.delete','campaign.stop','groups.edit','media.create','media.delete','contacts.create','contacts.delete','notifications.manage']);
  const assertSearchActor=()=>{const actor=user();if(!actor)throw new Error('Faça login para continuar.');return actor.id;};
  const getCampaign=(id,permission='campaign.view')=>{const c=store.getCampaign(id);if(!c)throw new Error('Campanha não encontrada.');assert(permission,c);return c;};
  const audit=(action,details={})=>store.addAudit({id:randomUUID(),at:now(),userId:user()?.id||null,userName:user()?.name||null,action,...details});
  const curatedError=(action,error)=>{
    if(!auth.status().authenticated)return;
    const code=error?.code&&/^[A-Z0-9_]{1,64}$/.test(error.code)?error.code:'ACTION_FAILED';
    // Adapter exceptions and native paths may contain credentials or personal
    // messages. Record the stage and a fixed description instead of raw errors.
    try{store.addDiagnostic({id:randomUUID(),at:now(),userId:user()?.id||null,stage:action,code,description:'A operação solicitada não foi concluída.',attempts:0,action:'Operação interrompida sem repetição automática.',guidance:'Confira a mensagem exibida e as permissões de acesso.'});}catch{}
  };
  const stripEntities=values=>values.map(v=>{const {passwordHash,passwordSalt,hash,salt,token,secret,...safe}=v;return safe;});
  const entityList=(table)=>store.listEntities(table);
  const pageEntities=(table,p={})=>store.queryEntities?store.queryEntities(table,p):{items:entityList(table).slice(Number(p.offset)||0,(Number(p.offset)||0)+(Number(p.limit)||50)),total:entityList(table).length,limit:Number(p.limit)||50,offset:Number(p.offset)||0};
  const historyPage=(p={})=>{
    assert('history.view');
    return store.listHistory({...p,campaignIds:scopeIds(),limit:Math.min(200,Math.max(1,Number(p.limit)||50)),offset:Math.max(0,Number(p.offset)||0)});
  };
  const diagnosisPage=(p={})=>{
    assert('diagnostics.view');
    return pageEntities('diagnostics',{...p,campaignIds:scopeIds(),includeGlobal:true,limit:Math.min(200,Math.max(1,Number(p.limit)||50)),offset:Math.max(0,Number(p.offset)||0)});
  };
  const pendingReviewsPage=(p={})=>{assert('history.view');const ids=campaigns().filter(c=>can('campaign.edit',c)).map(c=>c.id);return store.listOperationalReviews({...p,campaignIds:ids,limit:Math.min(200,Math.max(1,Number(p.limit)||50)),offset:Math.max(0,Number(p.offset)||0)});};
  const authorizedMediaIds=()=>{
    const ids=new Set();
    for(const c of campaigns())for(const item of [...(c.items||[]),...Object.values(c.groupOverrides||{}).flatMap(g=>g.items||[])])if(item.mediaId)ids.add(item.mediaId);
    return ids;
  };
  const visibleMedia=()=>can('media.view')?store.listMedia().map(withoutPath):[];
  function snapshot(){
    const status=auth.status(),base={auth:status,version,maintenance,settings:{theme:store.getSetting('theme','dark')},campaigns:[],groups:[],media:[],templates:[],contacts:[],alertRecipients:[],campaignUsers:[],history:[],metrics:{confirmed:0,failed:0,uncertain:0,activeCampaigns:0,selectedGroups:0,nextRunAt:null}};
    if(!status.authenticated)return {...base,connection:null};
    const cs=campaigns(),ids=cs.map(c=>c.id),storageError=store.persistenceFailed||scheduler.persistenceFailed?'Armazenamento indisponível: envios bloqueados. Corrija o espaço ou as permissões e reabra o aplicativo.':null;
    const metrics=store.getMetrics?store.getMetrics({campaignIds:scopeIds()}):{confirmed:0,failed:0,uncertain:0};
    let recent=[];if(can('history.view'))recent=historyPage({limit:50,offset:0}).items||[];
    const publicSettings=can('settings.view')?settings():{theme:store.getSetting('theme','dark')};
    return {...base,auth:status,buscas:searches?.getState(user()?.id),connection:can('connection.view')?{...adapter.status,detail:storageError?`${adapter.status.detail||''} ${storageError}`:adapter.status.detail}:null,storageError,campaigns:cs,groups:can('groups.view')?store.listGroups():[],media:visibleMedia(),templates:can('media.view')?store.listTemplates():[],contacts:can('contacts.view')?entityList('contacts'):[],alertRecipients:can('campaign.create')||can('campaign.edit')||can('settings.view')?listRecipients():[],campaignUsers:can('campaign.create')||can('campaign.edit')?stripEntities(entityList('users')).filter(u=>u.active!==false).map(u=>({id:u.id,name:u.name,phone:u.phone||'',isOwner:entityList('roles').find(r=>r.id===u.roleId)?.isOwner===true||u.roleId==='owner'})):[],settings:publicSettings,history:recent,pendingReviews:can('history.view')&&store.listOperationalReviews?pendingReviewsPage({limit:20}).items:[],metrics:{...metrics,activeCampaigns:cs.filter(c=>c.state==='active').length,selectedGroups:new Set(cs.flatMap(c=>c.groupIds||[])).size,nextRunAt:cs.filter(c=>c.state==='active'&&c.nextRunAt).map(c=>c.nextRunAt).sort((a,b)=>a-b)[0]||null},dataDir:can('settings.view')?dir:undefined,notifications:can('notifications.view')?pageEntities('notifications',{campaignIds:scopeIds(),includeGlobal:true,limit:20}).items:[]};
  }
  function broadcast(immediate=false){
    if(closed)return;
    if(immediate){clearTimeout(updateTimer);updateTimer=null;events.emit('update',snapshot());events.emit('nativeEvent',{type:'settings',payload:settings()});return;}
    if(!updateTimer)updateTimer=setTimeout(()=>{updateTimer=null;if(!closed){events.emit('update',snapshot());events.emit('nativeEvent',{type:'settings',payload:settings()});}},500);
  }
  const enqueue=task=>{const result=tail.then(task);tail=result.catch(()=>{});return result;};
  async function nativeAlert(payload){
    const preferences=store.getSetting('sound',DEFAULTS.sound),notificationPreferences=store.getSetting('notifications',DEFAULTS.notifications);
    const result=await host('localAlert',{...payload,preferences,soundPreferences:preferences,notificationPreferences,nativeEnabled:notificationPreferences.nativeEnabled!==false,audioPath:audioPath(preferences.customAudioId)}).catch(()=>({nativeStatus:'failed',soundStatus:'failed'}));
    const notification=store.getEntity('notifications',payload.id);
    if(notification&&!closed)store.saveNotification({...notification,nativeStatus:notification.nativeResultAt?notification.nativeStatus:result.nativeStatus||'pending',soundStatus:result.soundStatus||'disabled'});
    broadcast();
  }
  function bindAdapter(){
    const source=adapter;
    source.on('status',status=>{broadcast();if(status.state==='connected')source.listGroups().then(groups=>{if(source===adapter){store.upsertGroups(groups);broadcast();}}).catch(()=>{});});
    source.on('incoming',ctx=>{
      const emergency=ctx.type==='text'&&/^!mega\s+(?:parar\s+tudo|pausar\s+\S+)\s*$/i.test(String(ctx.text||''));
      if(source!==adapter||(maintenance&&!emergency))return;
      const handle=()=>source===adapter&&(!maintenance||emergency)?commands.handle(ctx):false;
      (emergency?Promise.resolve().then(handle):enqueue(handle)).then(()=>broadcast()).catch(()=>{});
    });
    source.on('receipt',()=>broadcast());
  }
  function listRecipients(){return store.listAlertRecipients?store.listAlertRecipients():entityList('alert_recipients');}
  const getRecipient=id=>listRecipients().find(r=>r.id===id);
  function audioPath(id){
    if(!id)return null;const entry=(store.getSetting('audioAssets',[])||[]).find(a=>a.id===id);if(!entry)return null;
    try{const real=fs.realpathSync(entry.path);if(!real.startsWith(fs.realpathSync(audioDir)+path.sep))return null;return real;}catch{return null;}
  }
  async function withMaintenance(task){if(maintenance)throw new Error('Aguarde a manutenção dos dados e da conexão terminar.');maintenance=true;broadcast();try{await searches?.suspendCapture('maintenance');return await task();}finally{searches?.resumeCapture();maintenance=false;broadcast();}}
  async function switchMode(mode){
    await scheduler.stopAll();await adapter.disconnect();await scheduler.waitForIdle();adapter.removeAllListeners();
    store.setSetting('integrationMode',mode);adapter=makeAdapter();scheduler.setAdapter(adapter);commands.setAdapter(adapter);alerts.setAdapter(adapter);searches.setAdapter(adapter);bindAdapter();
    if(mode==='simulated'){await adapter.connect();store.upsertGroups(await adapter.listGroups());}
  }
  const configRevision=c=>c.configRevision??c.revision;
  function checkRevision(c,p){const expected=p.configRevision??p.revision;if(expected===undefined||Number(expected)!==(p.configRevision!==undefined?configRevision(c):c.revision)||(p.summaryState!==undefined&&p.summaryState!==c.state))throw new Error('A configuração ou o estado mudou. Abra uma nova prévia antes de confirmar.');}
  function validateAssignments(c,old){
    const actor=user();if(!old)c.ownerId=c.ownerId||actor.id;
    if((old&&c.ownerId!==old.ownerId||!old&&c.ownerId!==actor.id)&&!can('users.edit'))throw new Error('Sem permissão para transferir a propriedade da campanha.');
    if(!(store.getEntity('users',c.ownerId)&&store.getEntity('users',c.ownerId).active!==false))throw new Error('Selecione um dono ativo para a campanha.');
    for(const id of c.responsibleUserIds)if(!(store.getEntity('users',id)&&store.getEntity('users',id).active!==false))throw new Error('Responsável não encontrado ou desativado.');
    for(const id of c.alertRecipientIds)if(!getRecipient(id)?.enabled)throw new Error('Destinatário de alerta não encontrado ou desativado.');
  }
  async function exportRecords(table,p){
    assert(table==='history'?'history.export':'diagnostics.export');
    const response=await host('showSaveDialog',{title:'Exportar registros',defaultPath:`Mega-Disparos-${table}-${new Date(now()).toISOString().slice(0,10)}.json`,filters:[{name:'Registros JSON',extensions:['json']}]});
    if(response.canceled)return {cancelled:true};
    const actor=user()?.id,count=await writeRecordsJSON(response.filePath,{header:{format:'mega-disparos-logs',version:1,exportedAt:new Date(now()).toISOString()},check:()=>{if(user()?.id!==actor)throw new Error('A sessão de acesso mudou.');assert(table==='history'?'history.export':'diagnostics.export');},page:(offset,limit)=>table==='history'?historyPage({...p,offset,limit}):diagnosisPage({...p,offset,limit})});
    audit(`${table}.export`,{count});return {path:response.filePath,count};
  }
  async function testSearchSimulation(p={}){
    const actorId=assertSearchActor();assert('search.manage');
    if(!searches.getState(actorId).permissions?.manage)throw new Error('Você não tem autorização para gerenciar o módulo BUSCAS.');
    if(adapter.status.mode!=='simulated'||store.getSetting('integrationMode')!=='simulated')throw new Error('Disponível somente no modo simulado; nenhum dado ou envio real é realizado.');
    if(p.kind==='disconnect'){
      assert('connection.manage');await adapter.disconnect({reasonCode:'unexpected',manual:false});await searches.waitForIdle();
      return {simulation:true,description:'Desconexão local simulada; nenhuma conta WhatsApp foi afetada.',state:searches.getState(actorId)};
    }
    if(p.kind!==undefined&&!['offer','edit','delete','command'].includes(p.kind))throw new Error('Tipo de teste simulado inválido.');
    if(['offer','edit','delete'].includes(p.kind))p={...p,text:undefined,command:undefined,messages:[{...p,event:p.kind==='edit'?'update':p.kind==='delete'?'delete':'message'}]};
    const fixtures=p.messages||p.fixtures||[];
    if(!Array.isArray(fixtures)||fixtures.length>50)throw new Error('Use no máximo 50 mensagens fictícias por teste.');
    const knownGroups=new Set(store.listGroups().filter(g=>g.simulation).map(g=>g.id));
    const before=adapter.sent?.length||0;
    for(const fixture of fixtures){
      const groupId=fixture.groupId||fixture.chatId;
      if(!knownGroups.has(groupId))throw new Error('O teste aceita apenas grupos identificados como simulados.');
      const text=String(fixture.text||'');if(fixture.event!=='delete'&&(!text.trim()||text.length>32000))throw new Error('Informe uma mensagem fictícia de até 32.000 caracteres.');
      const number=cleanPhone(fixture.senderNumber||'');if(number&&!validPhone(number))throw new Error('Telefone fictício inválido.');
      const messageId=fixture.messageId?String(fixture.messageId).slice(0,128):`SIM-OFFER-${randomUUID()}`;
      const senderId=number?`${number}@s.whatsapp.net`:`SIM-SUPPLIER-${String(fixture.senderId||'indisponivel').slice(0,100)}`;
      const timestamp=fixture.timestamp===undefined?now():Number(fixture.timestamp);if(!Number.isFinite(timestamp)||timestamp<0||timestamp>now()+60000)throw new Error('Data da mensagem fictícia inválida.');
      const context={messageId,groupId,chatId:groupId,text,type:'text',isGroup:true,fromMe:false,forwarded:!!fixture.forwarded,verified:true,identityVerified:true,senderId,senderNumber:number||null,pushName:asText(fixture.supplierName||fixture.pushName||'Fornecedor fictício',120),timestamp,simulation:true,dataOnly:true};
      if(fixture.event==='update')adapter.injectOfferUpdate(context);
      else if(fixture.event==='delete')adapter.injectOfferDelete(context);
      else if(fixture.event!==undefined&&fixture.event!=='message')throw new Error('Evento fictício inválido.');
      else adapter.injectOfferMessage(context);
    }
    await searches.waitForIdle();
    if(p.text!==undefined||p.command!==undefined){
      const actor=user(),senderNumber=cleanPhone(p.senderNumber||actor.phone);
      if(!validPhone(senderNumber)||![actor.phone,...(actor.authorizedPhones||[])].includes(senderNumber))throw new Error('O comando de teste aceita somente um número vinculado ao usuário conectado.');
      const chatId=p.chatId||(p.isGroup?p.groupId:`${senderNumber}@s.whatsapp.net`),isGroup=!!p.isGroup;
      if(isGroup&&!knownGroups.has(chatId))throw new Error('O comando aceita apenas grupos simulados.');
      if(!isGroup&&chatId!==`${senderNumber}@s.whatsapp.net`)throw new Error('A conversa privada de teste deve pertencer ao usuário conectado.');
      adapter.injectOfferMessage({messageId:`SIM-COMMAND-${randomUUID()}`,senderId:`${senderNumber}@s.whatsapp.net`,senderNumber,verified:true,identityVerified:true,isGroup,fromMe:false,forwarded:!!p.forwarded,chatId,text:String(p.text??p.command),type:'text',timestamp:now(),simulation:true});
      await searches.waitForIdle();
    }
    audit('search.simulation',{messages:fixtures.length});
    return {simulation:true,description:'Teste local com dados fictícios; nenhum envio pelo WhatsApp.',messages:fixtures.length,replies:(adapter.sent?.slice(before)||[]).filter(entry=>entry.search===true),state:searches.getState(actorId)};
  }
  const actions={
    snapshot:async()=>snapshot(),authStatus:async()=>auth.status(),
    setupOwner:async p=>{const result=await auth.setupOwner(p);broadcast(true);return result;},
    login:async p=>{const result=await auth.login(p);broadcast(true);return result;},
    logout:async()=>{auth.logout();cleanupTokens.clear();broadcast(true);return true;},
    recoverPassword:async p=>auth.recoverPassword(p),changePassword:async p=>auth.changePassword(p),
    listUsers:async()=>auth.listUsers(),createUser:async p=>auth.createUser(p.user||p),updateUser:async p=>auth.updateUser({...p,...p.user,id:p.id||p.user?.id}),deleteUser:async p=>auth.deleteUser(p.id),
    issueReset:async p=>auth.issueReset({userId:p.id||p.userId}),listRoles:async()=>auth.listRoles(),saveRole:async p=>auth.saveRole(p.role||p),deleteRole:async p=>auth.deleteRole(p.id),rotateRecoveryCodes:async p=>auth.rotateRecoveryCodes(p),
    searchesState:async()=>searches.getState(assertSearchActor()),
    saveSearchSettings:async p=>searches.saveSettings(p.settings||p,assertSearchActor()),
    searchOffers:async p=>searches.listOffers(p,assertSearchActor()),
    searchMessages:async p=>searches.listMessages(p,assertSearchActor()),
    searchHistory:async p=>searches.listHistory(p,assertSearchActor()),
    runSearch:async p=>searches.executeSearch({query:p.query,filters:p.filters},assertSearchActor(),{deliver:p.deliver===true}),
    searchAuthorizations:async()=>searches.listAuthorizations(assertSearchActor()),
    saveSearchAuthorization:async p=>searches.saveAuthorization(p.authorization||p,assertSearchActor()),
    deleteSearchAuthorization:async p=>searches.deleteAuthorization(p.id,assertSearchActor()),
    reviewSearchOffer:async p=>searches.reviewOffer(p,assertSearchActor()),
    searchCleanupPreview:async p=>searches.cleanupPreview({scope:p.scope},assertSearchActor()),
    clearSearchHistory:async p=>searches.clearData({...p,scope:'history'},assertSearchActor()),
    clearSearchBase:async p=>searches.clearData({...p,scope:'base'},assertSearchActor()),
    importSearchHistory:async()=>searches.importHistory(assertSearchActor()),
    testSearchSimulation:async p=>testSearchSimulation(p),
    connect:async()=>{assert('connection.manage');await adapter.connect({reconnect:true});if(adapter.status.state==='connected')store.upsertGroups(await adapter.listGroups());audit('connection.connect');return adapter.status;},
    disconnect:async()=>{assert('connection.manage');for(const c of store.listCampaigns())if(c.state==='active')await scheduler.pause(c.id);await adapter.disconnect({logout:true});audit('connection.disconnect');return adapter.status;},
    refreshGroups:async()=>{assert('groups.view');store.upsertGroups(await adapter.listGroups());return store.listGroups();},
    authorizeGroup:async p=>{assert('groups.edit');if(!p.authorized)for(const c of store.listCampaigns())if(c.state==='active'&&c.groupIds.includes(p.id))await scheduler.pause(c.id);audit('groups.authorize',{groupId:p.id,authorized:!!p.authorized});return store.authorizeGroup(p.id,p.authorized);},
    saveCampaign:async p=>{
      const old=p.campaign?.id?store.getCampaign(p.campaign.id):null;assert(old?'campaign.edit':'campaign.create',old);
      const c=validation.campaign(p.campaign,store);validateAssignments(c,old);
      if(old)checkRevision(old,{configRevision:p.campaign.configRevision,revision:p.campaign.revision,summaryState:p.campaign.state});
      if(old?.state==='active'){
        assert('campaign.pause',old);assert('campaign.start',old);
        const r=await host('showMessageBox',{type:'question',title:'Confirmar alterações',message:'Alterar a campanha em execução?',detail:candidateSummary(c,store),buttons:['Cancelar','Confirmar alterações'],defaultId:0,cancelId:0});if(r.response!==1)return {cancelled:true};
        assert('campaign.edit',getCampaign(c.id));checkRevision(store.getCampaign(c.id),{configRevision:configRevision(old),summaryState:old.state});await scheduler.pause(c.id);await scheduler.waitForIdle();
      }
      const latest=old?store.getCampaign(c.id):null;if(latest)checkRevision(latest,{configRevision:configRevision(old)});
      const shouldResume=old?.state==='active'&&latest?.state==='paused';
      const saved=store.saveCampaign({...c,...(latest?{state:latest.state,roundIndex:latest.roundIndex,nextRunAt:latest.nextRunAt}: {})});
      if(shouldResume){assert('campaign.start',saved);await scheduler.resume(saved.id);}audit(old?'campaign.edit':'campaign.create',{campaignId:saved.id});return store.getCampaign(saved.id);
    },
    duplicateCampaign:async p=>{const c=getCampaign(p.id);assert('campaign.create');const copy=store.saveCampaign({...c,id:randomUUID(),ownerId:user().id,name:`${c.name.slice(0,105)} (cópia)`,state:'draft',nextRunAt:null,roundIndex:0,lastError:null,items:c.items.map(i=>({...i,id:randomUUID()}))});audit('campaign.duplicate',{campaignId:copy.id});return copy;},
    deleteCampaign:async p=>{const c=getCampaign(p.id,'campaign.delete');await scheduler.pause(c.id);await scheduler.waitForIdle();assert('campaign.delete',c);if(store.queryJobs({campaignId:c.id,status:'uncertain',limit:1}).total)throw new Error('Revise os envios incertos desta campanha antes de excluí-la.');store.deleteCampaign(c.id);audit('campaign.delete',{campaignId:c.id});return true;},
    previewCampaign:async p=>({summary:scheduler.getSummary(getCampaign(p.id).id),campaign:getCampaign(p.id)}),
    activateCampaign:async p=>{const c=getCampaign(p.id,'campaign.start');checkRevision(c,p);await scheduler.activate(c.id);audit('campaign.start',{campaignId:c.id});return store.getCampaign(c.id);},
    resumeCampaign:async p=>{const c=getCampaign(p.id,'campaign.start');checkRevision(c,p);await scheduler.resume(c.id);audit('campaign.resume',{campaignId:c.id});return store.getCampaign(c.id);},
    pauseCampaign:async p=>{const c=getCampaign(p.id,'campaign.pause');await scheduler.pause(c.id);audit('campaign.pause',{campaignId:c.id});return store.getCampaign(c.id);},
    stopCampaign:async p=>{const c=getCampaign(p.id,'campaign.stop');await scheduler.pause(c.id);const latest=store.getCampaign(c.id);store.saveCampaign({...latest,state:'stopped',nextRunAt:null});audit('campaign.stop',{campaignId:c.id});return store.getCampaign(c.id);},
    stopAll:async()=>{assert('campaign.stop');const all=store.listCampaigns().filter(c=>can('campaign.stop',c));for(const c of all){await scheduler.pause(c.id);const latest=store.getCampaign(c.id);if(['active','paused'].includes(latest.state))store.saveCampaign({...latest,state:'stopped',nextRunAt:null});}audit('campaign.stopAll',{count:all.length});return true;},
    importMedia:async()=>{assert('media.create');const r=await host('showOpenDialog',{title:'Importar mídias para a biblioteca',properties:['openFile','multiSelections'],filters:[{name:'Mídias e documentos',extensions:['jpg','jpeg','png','webp','mp4','mov','pdf','doc','docx','xls','xlsx','pptx','txt','csv','zip']}]});if(r.canceled)return [];assert('media.create');const imported=[];for(const file of r.filePaths)imported.push(withoutPath(await media.importFile(file)));audit('media.create',{count:imported.length});return imported;},
    mediaPath:async p=>{if(p.kind&&p.kind!=='media')throw new Error('Tipo de recurso inválido.');assert('media.view');return media.getPath(p.id);},
    saveTemplate:async p=>{assert('media.create');if(!String(p.name||'').trim())throw new Error('Informe o nome do modelo.');return store.saveTemplate({id:randomUUID(),name:String(p.name).slice(0,120),items:validation.items(p.items,store),createdAt:now()});},
    deleteTemplate:async p=>{assert('media.delete');store.deleteTemplate(p.id);audit('media.deleteTemplate',{templateId:p.id});return true;},
    saveSettings:async p=>{
      assert('settings.edit');const changesMode=p.settings?.integrationMode&&p.settings.integrationMode!==store.getSetting('integrationMode');if(changesMode)assertModeChange();
      const next=validateSettings(p.settings||{},store),previousWebhook=store.getSetting('webhook',DEFAULTS.webhook);
      const changesChannel=p.settings?.webhookToken!==undefined||next.webhook&&(next.webhook.enabled!==previousWebhook.enabled||next.webhook.url!==(channelUrl||previousWebhook.url));
      if(changesChannel)assertGlobal('settings.edit',['notifications.manage']);
      if(p.settings?.webhookToken!==undefined){await host('secretSet',{key:'webhookToken',value:String(p.settings.webhookToken)});assertGlobal('settings.edit',['notifications.manage']);}
      if(next.webhook&&changesChannel){await host('secretSet',{key:'webhookUrl',value:next.webhook.url});assertGlobal('settings.edit',['notifications.manage']);channelUrl=next.webhook.url;next.webhook={...next.webhook,url:channelUrl?new URL(channelUrl).origin:''};}else if(next.webhook)delete next.webhook;
      if(changesMode)assertModeChange();for(const [key,value] of Object.entries(next))store.setSetting(key,value);if(next.webhook)store.setSetting('independentAlertChannel',{...next.webhook,secretId:'webhookToken'});
      if(runtimePlatform==='win32'&&next.launchAtLogin!==undefined)await host('setLoginItemSettings',{openAtLogin:next.launchAtLogin});if(changesMode)await withMaintenance(()=>switchMode(p.settings.integrationMode));audit('settings.edit');return settings();
    },
    backup:async()=>{assertBackup();const r=await host('showSaveDialog',{title:'Backup de campanhas e mídias',defaultPath:`Mega-Disparos-${new Date(now()).toISOString().slice(0,10)}.mega.json`,filters:[{name:'Backup Mega Disparos',extensions:['json']}]});if(r.canceled)return {cancelled:true};assertBackup();await media.createBackup(r.filePath);audit('settings.backup');return {path:r.filePath};},
    restore:async()=>{assertRestore();const r=await host('showOpenDialog',{title:'Restaurar backup',properties:['openFile'],filters:[{name:'Backup Mega Disparos',extensions:['json']}]});if(r.canceled)return {cancelled:true};const answer=await host('showMessageBox',{type:'question',message:'Restaurar campanhas, mídias e configurações?',detail:'Os dados atuais terão backup automático. Os usuários e as permissões atuais serão preservados. As campanhas restauradas ficarão desativadas.',buttons:['Cancelar','Restaurar'],cancelId:0,defaultId:0});if(answer.response!==1)return {cancelled:true};assertRestore();return withMaintenance(async()=>{await scheduler.stopAll();await adapter.disconnect();await scheduler.waitForIdle();await media.createBackup(path.join(dir,'backups',`antes-restauracao-${now()}.mega.json`));const result=await media.restoreBackup(r.filePaths[0]);for(const c of store.listCampaigns())if(!store.getEntity('users',c.ownerId))store.saveCampaign({...c,ownerId:user().id,responsibleUserIds:(c.responsibleUserIds||[]).filter(id=>store.getEntity('users',id)),alertRecipientIds:(c.alertRecipientIds||[]).filter(id=>getRecipient(id))});await switchMode('simulated');if(runtimePlatform==='win32')await host('setLoginItemSettings',{openAtLogin:!!store.getSetting('launchAtLogin',false)});audit('settings.restore');return result;});},
    openDataFolder:async()=>{assert('settings.view');return host('openDataFolder',{path:dir});},
    historyPage:async p=>historyPage(p),diagnosticsPage:async p=>diagnosisPage(p),
    auditPage:async p=>{assert('audit.view');return pageEntities('audit',{...p,limit:Math.min(200,Number(p.limit)||50)});},
    exportHistory:async p=>exportRecords('history',p),exportDiagnostics:async p=>exportRecords('diagnostics',p),
    exportReports:async()=>{assert('reports.export');const r=await host('showSaveDialog',{title:'Exportar relatório',defaultPath:`Mega-Disparos-relatorio-${new Date(now()).toISOString().slice(0,10)}.json`,filters:[{name:'Relatório JSON',extensions:['json']}]});if(r.canceled)return {cancelled:true};assert('reports.export');const cs=store.listCampaigns().filter(c=>can('reports.export',c)),data={format:'mega-disparos-report',exportedAt:new Date(now()).toISOString(),metrics:store.getMetrics({campaignIds:scopeIds()}),campaigns:cs.map(c=>({id:c.id,name:c.name,state:c.state,nextRunAt:c.nextRunAt,intervalMinutes:c.intervalMinutes,groups:c.groupIds.length}))};atomicWrite(r.filePath,Buffer.from(JSON.stringify(data,null,2)));audit('reports.export',{count:cs.length});return {path:r.filePath,count:cs.length};},
    pendingReviewsPage:async p=>pendingReviewsPage(p),
    cleanupPreview:async p=>{assert('history.clear');for(const [key,value] of cleanupTokens)if(now()-value.at>5*60*1000)cleanupTokens.delete(key);while(cleanupTokens.size>=32)cleanupTokens.delete(cleanupTokens.keys().next().value);const categories=validateCategories(p.categories);const counts=store.cleanupPreview(categories),token=randomBytes(18).toString('hex');cleanupTokens.set(token,{userId:user().id,categories,at:now(),fingerprint:JSON.stringify(counts)});return {token,categories,counts:counts.counts,total:counts.total,protected:true,description:'Serão removidos somente os registros visíveis selecionados. Campanhas, mídias, usuários, configurações, auditoria e o controle operacional de envios serão preservados.'};},
    clearHistory:async p=>{assert('history.clear');if(p.confirmation!=='APAGAR')throw new Error('Digite APAGAR para confirmar.');const token=cleanupTokens.get(p.token),categories=validateCategories(p.categories);if(!token||token.userId!==user().id||now()-token.at>5*60*1000||JSON.stringify(categories)!==JSON.stringify(token.categories))throw new Error('A confirmação expirou. Confira uma nova prévia.');if(token.fingerprint!==JSON.stringify(store.cleanupPreview(categories)))throw new Error('Os registros mudaram. Confira uma nova prévia antes de apagar.');cleanupTokens.delete(p.token);const result=store.clearHistory({categories,actor:{id:user().id,name:user().name},at:now()});broadcast();return result;},
    reviewJob:async p=>{assert('history.view');const j=store.getJob(p.id);if(!j||j.status!=='uncertain')throw new Error('Envio incerto não encontrado.');getCampaign(j.campaignId,'campaign.edit');if(!['confirm','discard'].includes(p.decision))throw new Error('Decisão inválida.');const result=store.updateJob(j.id,{status:p.decision==='confirm'?'confirmed':'cancelled',resultAt:now(),error:p.decision==='confirm'?'Confirmado manualmente após verificação no WhatsApp.':'Descartado manualmente. Não reenviado.',reviewed:true,reviewedBy:user().id});audit('history.review',{campaignId:j.campaignId,jobId:j.id,decision:p.decision});return result;},
    listContacts:async p=>{assert('contacts.view');return p?.limit?pageEntities('contacts',p):entityList('contacts');},
    saveContact:async p=>{const v=p.contact||p,old=v.id?store.getEntity('contacts',v.id):null;assert(old?'contacts.edit':'contacts.create');const phone=cleanPhone(v.phone);if(!asText(v.name,121).trim()||asText(v.name,121).length>120||!validPhone(phone))throw new Error('Informe nome e telefone com país + DDD + número.');const result=store.saveEntity('contacts',{id:old?.id||randomUUID(),name:asText(v.name,120).trim(),phone,notes:asText(v.notes,1000),createdAt:old?.createdAt||now(),updatedAt:now()});audit(old?'contacts.edit':'contacts.create',{contactId:result.id});return result;},
    deleteContact:async p=>{assert('contacts.delete');store.deleteEntity('contacts',p.id);audit('contacts.delete',{contactId:p.id});return true;},
    listAlertRecipients:async()=>{assert('notifications.view');return listRecipients();},
    saveAlertRecipient:async p=>{assert('notifications.manage');const v=p.recipient||p,old=v.id?getRecipient(v.id):null,phone=cleanPhone(v.phone);if(!asText(v.name,121).trim()||asText(v.name,121).length>120||!validPhone(phone))throw new Error('Informe nome e telefone com país + DDD + número.');if(v.userId&&!store.getEntity('users',v.userId))throw new Error('Usuário não encontrado.');const result=store.saveEntity('alert_recipients',{id:old?.id||randomUUID(),name:asText(v.name,120).trim(),phone,userId:v.userId||null,enabled:v.enabled!==false});audit('alerts.recipientSave',{recipientId:result.id});return result;},
    deleteAlertRecipient:async p=>{assert('notifications.manage');if(store.listCampaigns().some(c=>(c.alertRecipientIds||[]).includes(p.id)))throw new Error('Remova o destinatário das campanhas antes de excluí-lo.');store.deleteEntity('alert_recipients',p.id);audit('alerts.recipientDelete',{recipientId:p.id});return true;},
    testAlertRecipient:async p=>{assert('notifications.manage');const r=getRecipient(p.id);if(!r||!r.enabled)throw new Error('Destinatário não encontrado ou desativado.');audit('alerts.test',{recipientId:r.id});return alerts.testRecipient(r.phone,user().id);},
    alertsPage:async p=>{assert('notifications.view');return pageEntities('alerts',{...p,campaignIds:scopeIds(),includeGlobal:true,limit:Math.min(200,Number(p.limit)||50)});},
    reviewAlert:async p=>{assert('notifications.manage');const a=store.getEntity('alerts',p.id);if(!a)throw new Error('Alerta não encontrado.');if(a.campaignId&&scopeIds()&&!scopeIds().includes(a.campaignId))throw new Error('Sem permissão para este alerta.');if(typeof p.confirmed!=='boolean'&&!['confirm','discard'].includes(p.decision))throw new Error('Informe uma decisão válida para o alerta.');audit('alerts.review',{alertId:p.id,confirmed:p.confirmed===true||p.decision==='confirm'});return alerts.resolveUncertain(p.id,{confirmed:p.confirmed===true||p.decision==='confirm',userId:user().id});},
    silenceAlert:async p=>{assert('notifications.view');const notification=store.getEntity('notifications',p.id)||store.listEntities('notifications').find(n=>n.occurrenceId===p.id);if(!notification)throw new Error('Alerta não encontrado.');if(notification.campaignId&&scopeIds()&&!scopeIds().includes(notification.campaignId))throw new Error('Sem permissão para este alerta.');alerts.muteOccurrence(p.id);await host('silenceAlert',{id:p.id,occurrenceId:p.occurrenceId||notification.occurrenceId});return true;},
    importAudio:async()=>{assert('settings.edit');const r=await host('showOpenDialog',{title:'Selecionar som de alerta',properties:['openFile'],filters:[{name:'Áudio',extensions:['wav','mp3','ogg']}]});if(r.canceled)return {cancelled:true};assert('settings.edit');const original=r.filePaths[0],stat=fs.statSync(original),ext=path.extname(original).toLowerCase();if(!stat.isFile()||stat.size<1||stat.size>20*1024*1024||!['.wav','.mp3','.ogg'].includes(ext))throw new Error('Escolha WAV, MP3 ou OGG de até 20 MB.');const id=randomUUID(),filename=path.join(audioDir,`${id}${ext}`);await fs.promises.copyFile(original,filename);const entry={id,name:path.basename(original),path:filename,size:stat.size,createdAt:now()};store.setSetting('audioAssets',[...(store.getSetting('audioAssets',[])||[]),entry]);audit('settings.importAudio');return {id,name:entry.name,size:entry.size};},
    testSound:async p=>{assert('settings.edit');const prefs=validateSound(p.preferences||p.sound||store.getSetting('sound'));return host('testSound',{preferences:prefs,audioPath:audioPath(prefs.customAudioId)});},
    testSimulation:async p=>{assert('settings.edit');if(adapter.status.mode!=='simulated'&&store.getSetting('integrationMode')!=='simulated')throw new Error('Disponível somente no modo simulado.');const senderNumber=cleanPhone(p.senderNumber||user().phone);if(![user().phone,...(user().authorizedPhones||[])].includes(senderNumber))throw new Error('O teste aceita somente um número vinculado ao usuário conectado.');const before=adapter.replies?.length||0;await commands.handle({messageId:randomUUID(),senderNumber,verified:true,isGroup:!!p.isGroup,forwarded:!!p.forwarded,fromMe:false,chatId:`${senderNumber}@s.whatsapp.net`,text:String(p.text||''),type:'text',timestamp:now()});const replies=adapter.replies?.slice(before)||[];return replies.length?{text:replies.map(r=>r.text).join('\n\n'),replies}:{text:'Comando ignorado; confira a autorização.'};},
    windowMinimize:async()=>host('windowMinimize',{}),windowQuit:async()=>host('windowQuit',{})
  };
  const publicUnprotected=new Set(['snapshot','authStatus','setupOwner','login','recoverPassword','windowMinimize','windowQuit']);
  const immediate=new Set(['snapshot','authStatus','historyPage','diagnosticsPage','auditPage','alertsPage','mediaPath','pauseCampaign','stopCampaign','stopAll','windowMinimize','windowQuit','searchesState','searchOffers','searchMessages','searchHistory']);
  events.call=async(action,payload={})=>{
    if(closed)throw new Error('Aplicativo encerrado.');if(!Object.hasOwn(actions,action))throw new Error('Ação não autorizada.');
    if(!publicUnprotected.has(action)&&!auth.status().authenticated)throw new Error('Faça login para continuar.');
    if(maintenance&&!immediate.has(action))throw new Error('Aguarde a manutenção dos dados e da conexão terminar.');
    const invoke=async()=>{if(!publicUnprotected.has(action)&&!auth.status().authenticated)throw new Error('Faça login para continuar.');if(maintenance&&!immediate.has(action))throw new Error('Aguarde a manutenção dos dados e da conexão terminar.');return actions[action](payload||{});};
    try{const result=await (immediate.has(action)?invoke():enqueue(invoke));broadcast();return result;}catch(error){if(store.persistenceFailed)scheduler.blockOnPersistenceFailure();curatedError(action,error);broadcast();throw error;}
  };
  events.snapshot=snapshot;
  events.systemCall=async(action,payload={})=>{
    if(action==='networkState'){if(typeof payload.online!=='boolean')throw new Error('Estado da rede inválido.');await alerts.networkStateChanged(payload);return true;}
    if(action==='nativeNotificationResult'){const record=store.getEntity('notifications',payload.id);if(record&&['shown','failed','disabled','unsupported'].includes(payload.status))store.saveNotification({...record,nativeStatus:payload.status,nativeResultAt:now()});broadcast();return true;}
    if(action==='suspend'){for(const c of store.listCampaigns())if(c.state==='active')await scheduler.pause(c.id,'Computador suspenso; retome após conferir a conexão.');broadcast();return true;}
    if(action==='resume'){broadcast();return true;}
    if(action==='settings')return settings();
    if(action==='emergencyStop'){await scheduler.stopAll();store.addAudit({id:randomUUID(),at:now(),action:'campaign.stopAll.native',userId:null,userName:'Parada de emergência local'});broadcast();return true;}
    if(action==='shutdown')return events.shutdown();
    throw new Error('Ação interna não autorizada.');
  };
  events.shutdown=async()=>{if(closed)return;closed=true;clearTimeout(updateTimer);clearInterval(retentionTimer);await scheduler?.stopAll();await searches?.shutdown();await adapter?.disconnect();await alerts?.shutdown();await scheduler?.shutdown();await Promise.allSettled([...nativeTasks]);auth.logout();store.close();};
  adapter=makeAdapter();scheduler=new Scheduler({store,adapter,now});commands=new CommandController({store,scheduler,adapter,mediaManager:media,authService:auth,now});
  alerts=new AlertService({store,scheduler,adapter,now,secretGet:async key=>host('secretGet',{key}),sendWebhook:async({secret,message,occurrenceId,originalAt,idempotencyKey})=>{if(!channelUrl)throw Object.assign(new Error('Canal independente não configurado.'),{definitive:true});const parsed=new URL(channelUrl);if(parsed.protocol!=='https:'||parsed.username||parsed.password)throw Object.assign(new Error('Canal HTTPS inválido.'),{definitive:true});const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);try{const response=await fetch(parsed.href,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${secret}`,'idempotency-key':idempotencyKey},body:JSON.stringify({message,occurrenceId,originalAt}),signal:controller.signal,redirect:'error'});if(!response.ok)throw Object.assign(new Error('WEBHOOK_HTTP_FAILURE'),{definitive:true,code:'WEBHOOK_HTTP_FAILURE'});return {status:'confirmed',messageId:idempotencyKey};}finally{clearTimeout(timer);}}});
  searches=new SearchService({store,adapter,authService:auth,now,scheduler,host});
  searches.on('change',()=>broadcast());searches.start();
  alerts.on('localAlert',payload=>{const task=nativeAlert(payload).catch(()=>{});nativeTasks.add(task);task.finally(()=>nativeTasks.delete(task));});alerts.on('change',()=>broadcast());scheduler.on('change',()=>broadcast());bindAdapter();alerts.start();scheduler.start();
  retentionTimer=setInterval(()=>{try{store.applyRetention?.(store.getSetting('retention',DEFAULTS.retention));}catch{if(store.persistenceFailed)scheduler.blockOnPersistenceFailure();}},60000);retentionTimer.unref?.();
  if(store.getSetting('integrationMode')==='simulated'){await adapter.connect();store.upsertGroups(await adapter.listGroups());}
  return events;
}

function validateCategories(values){if(!Array.isArray(values)||!values.length||values.some(v=>!HISTORY_CATEGORIES.includes(v)))throw new Error('Selecione categorias de histórico válidas.');return HISTORY_CATEGORIES.filter(v=>values.includes(v));}
function validateSound(v={}){
  if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('Configuração de som inválida.');
  if(!['soft','urgent','custom'].includes(v.sound??'soft'))throw new Error('Selecione um som válido.');
  const quiet=v.quiet||{},start=quiet.start??'22:00',end=quiet.end??'08:00';validation.schedule({startTime:start,endTime:end});
  const ev=v.events??['disconnect','critical'];if(!Array.isArray(ev)||ev.some(x=>!['disconnect','critical'].includes(x)))throw new Error('Eventos sonoros inválidos.');
  return {enabled:v.enabled!==false,volume:bounded(v.volume??65,0,100,'Volume'),sound:v.sound??'soft',customAudioId:v.customAudioId||null,events:[...new Set(ev)],repeat:!!v.repeat,intervalSeconds:bounded(v.intervalSeconds??30,5,3600,'Intervalo de repetição sonora'),maxRepeats:Math.floor(bounded(v.maxRepeats??3,1,20,'Limite de repetição sonora')),quiet:{enabled:!!quiet.enabled,start,end}};
}
function validateSettings(v,store){
  const next={};if(v.theme!==undefined){if(!['dark','light','system'].includes(v.theme))throw new Error('Tema inválido.');next.theme=v.theme;}
  if(v.admins!==undefined){if(!Array.isArray(v.admins))throw new Error('Administradores inválidos.');next.admins=[...new Set(v.admins.map(cleanPhone))];if(next.admins.some(n=>!validPhone(n)))throw new Error('Administradores: use país + DDD + número.');const active=store.listEntities('users').filter(u=>u.active!==false);if(next.admins.some(phone=>!active.some(u=>[u.phone,...(u.authorizedPhones||[])].includes(phone))))throw new Error('Vincule cada número administrador a um usuário ativo nas configurações de usuários.');}
  if(v.maxSelectedGroups!==undefined)next.maxSelectedGroups=Math.floor(bounded(v.maxSelectedGroups,1,1000,'Limite de grupos'));
  if(v.closeBehavior!==undefined){if(!['tray','quit','ask'].includes(v.closeBehavior))throw new Error('Opção de fechamento inválida.');next.closeBehavior=v.closeBehavior;}
  for(const key of ['launchAtLogin','minimizeToTray','unofficialAcknowledged'])if(v[key]!==undefined)next[key]=!!v[key];
  if(v.integrationMode!==undefined&&!['simulated','whatsapp'].includes(v.integrationMode))throw new Error('Integração inválida.');
  if(v.integrationMode==='whatsapp'&&!(next.unofficialAcknowledged??store.getSetting('unofficialAcknowledged',false)))throw new Error('Reconheça as limitações da integração não oficial antes de conectar.');
  if(v.sound!==undefined){next.sound=validateSound(v.sound);if(next.sound.sound==='custom'&&!(store.getSetting('audioAssets',[])||[]).some(a=>a.id===next.sound.customAudioId))throw new Error('Importe o arquivo de áudio antes de selecioná-lo.');}
  if(v.reconnect!==undefined){const r=v.reconnect;next.reconnect={enabled:!!r.enabled,maxAttempts:Math.floor(bounded(r.maxAttempts??3,0,10,'Tentativas de reconexão')),delaySeconds:bounded(r.delaySeconds??15,3,3600,'Intervalo de reconexão'),autoResume:!!r.autoResume};}
  if(v.notifications!==undefined)next.notifications={nativeEnabled:v.notifications.nativeEnabled!==false};
  if(v.retention!==undefined){const r=v.retention;next.retention={days:Math.floor(bounded(r.days??90,1,3650,'Retenção em dias')),maxEntries:Math.floor(bounded(r.maxEntries??20000,100,1000000,'Limite de registros')),maxMegabytes:bounded(r.maxMegabytes??64,1,1024,'Tamanho máximo dos registros')};}
  if(v.webhook!==undefined){const w=v.webhook;let url='';if(w.url){const parsed=new URL(w.url);if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.hash)throw new Error('O canal independente exige endereço HTTPS sem credenciais na URL.');url=parsed.href;}if(w.enabled&&!url)throw new Error('Configure o endereço HTTPS do canal independente.');next.webhook={enabled:!!w.enabled,url};}
  return next;
}
function candidateSummary(c,store){const content=c.items.map((item,i)=>`${i+1}. ${item.type==='text'?item.text:store.getMedia(item.mediaId)?.name||'Mídia ausente'}${item.caption?' — '+item.caption:''}`).join('\n');return `${c.name}\n\n${c.items.length} conteúdos • ${c.groupIds.length} grupos\n${c.mode==='repeat'?'Repetir conjunto':'Alternar um item por rodada'}\nRodadas a cada ${c.intervalMinutes} minutos; envios espaçados ${c.spacingSeconds} segundos.\nHorário: ${c.schedule.startTime}–${c.schedule.endTime}, dias ${c.schedule.days.join(', ')}.\n\nGrupos:\n${c.groupIds.map(id=>store.getGroup(id)?.name||id).join('\n')}\n\nConteúdo:\n${content}`;}

module.exports={createAppService,validateSettings,validateSound,validateCategories};
