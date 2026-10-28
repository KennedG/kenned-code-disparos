'use strict';

// Runs in the backend worker. The desktop process only owns native Windows
// facilities and forwards explicitly named requests; it never owns the queue.
const {EventEmitter}=require('node:events');
const {AsyncLocalStorage}=require('node:async_hooks');
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
const {TemplateService}=require('../core/template-service.cjs');
const {ReminderService}=require('../core/reminders.cjs');
const {SourceCampaignService,sanitizeSourcePublication}=require('../core/source-campaigns.cjs');
const {OpportunityService}=require('../core/opportunity-service.cjs');
const {VitrineService}=require('../core/vitrine.cjs');
const {ContactIntake}=require('../core/contact-intake.cjs');
const {AutomationControl}=require('../core/automation-control.cjs');
const {writeRecordsJSON}=require('../core/export-records.cjs');
const {publicLicenseStatus,unavailableLicenseService,licenseError,confirmedLicenseExpiry}=require('../core/license-policy.cjs');

const SETTINGS=['integrationMode','admins','theme','maxSelectedGroups','launchAtLogin','closeBehavior','minimizeToTray','unofficialAcknowledged','reconnect','sound','notifications','retention','webhook','systemAlertRecipientIds','alertRetryPolicy','submissionTimeoutSeconds','destinationAlertPolicy'];
const DEFAULTS={alertRetryPolicy:{maxAttempts:3,delaySeconds:15},reconnect:{enabled:true,maxAttempts:5,delaySeconds:5,maxDelaySeconds:120,autoResume:true,policyVersion:2},notifications:{nativeEnabled:true},sound:{enabled:true,volume:65,sound:'soft',customAudioId:null,events:['disconnect','critical'],repeat:false,persistentAlarm:true,intervalSeconds:30,maxRepeats:3,quiet:{enabled:false,start:'22:00',end:'08:00'}},retention:{days:90,maxEntries:20000,maxMegabytes:64},webhook:{enabled:false,url:''}};
const HISTORY_CATEGORIES=['campaigns','sends','errors','notifications'];
const {normalizePhone}=require('../core/phone.cjs');
const cleanPhone=value=>normalizePhone(value)||'';
const validPhone=value=>/^[1-9]\d{9,14}$/.test(value);
const withoutPath=m=>{const {path:ignored,...safe}=m;return {...safe,previewUrl:`mega-media://asset/${encodeURIComponent(m.id)}`};};
const bounded=(v,min,max,name)=>validation.number(v,min,max,name);
const asText=(value,max)=>String(value??'').slice(0,max);

async function createAppService({dir,safeStorage,host=async()=>{throw new Error('Recurso nativo indisponível.');},version='2.3.2',runtimePlatform='win32',now=()=>Date.now(),licenseService}={}){
  const licensing=licenseService||unavailableLicenseService();
  if(typeof licensing.initialize==='function')await licensing.initialize();
  const store=await createStore(dir,{upgradeVersion:`${version}-recuperacao-r2`});seed(store);
  if(store.getSetting('submissionTimeoutSeconds')===undefined)store.setSetting('submissionTimeoutSeconds',30);
  if(store.getSetting('destinationAlertPolicy')===undefined)store.setSetting('destinationAlertPolicy',{summaryIntervalSeconds:900});
  for(const [key,value] of Object.entries(DEFAULTS))if(store.getSetting(key)===undefined)store.setSetting(key,value);
  // The requested recovery policy supersedes the old disabled-by-default
  // behavior once. Later explicit choices in policy version 2 are preserved.
  const previousRecovery=store.getSetting('reconnect',{});
  if(previousRecovery.policyVersion!==2)store.transaction(()=>{store.setSetting('reconnect',{...DEFAULTS.reconnect,...previousRecovery,enabled:true,autoResume:true,maxDelaySeconds:previousRecovery.maxDelaySeconds??120,policyVersion:2});store.addAudit({id:randomUUID(),at:now(),action:'recovery.policyUpgrade',userId:null,description:'Recuperação por erro habilitada conforme a atualização solicitada; pausas e desconexões manuais continuam bloqueando retomada.'});});
  const previousSound=store.getSetting('sound',{});if(previousSound.persistentAlarm===undefined)store.setSetting('sound',{...previousSound,persistentAlarm:true});
  const media=new MediaManager(store),events=new EventEmitter();
  let channelUrl='';try{const value=await host('secretGet',{key:'webhookUrl'});if(typeof value==='string')channelUrl=value;}catch{}
  const auth=new AuthService({store,clock:now});
  let adapter,scheduler,commands,alerts,searches,reminders,sources,opportunities,vitrine,contacts,templates,automation,maintenance=false,closed=false,tail=Promise.resolve(),updateTimer=null,retentionTimer=null,licenseTimer=null,licenseStopOperation=null,licenseStopLatched=false,licenseCapturePaused=false,groupSync=null,groupSyncSource=null,groupLoadError=null;
  const controlReplyScope=new AsyncLocalStorage();
  const cleanupTokens=new Map();
  const nativeTasks=new Set();
  const audioDir=path.join(dir,'audio');fs.mkdirSync(audioDir,{recursive:true});
  const settings=()=>{const result=Object.fromEntries(SETTINGS.map(k=>[k,store.getSetting(k)]));result.sound={...result.sound,customAudioName:(store.getSetting('audioAssets',[])||[]).find(a=>a.id===result.sound.customAudioId)?.name||''};if(result.webhook)result.webhook={...result.webhook,url:can('settings.edit')&&channelUrl?channelUrl:result.webhook.url};return result;};
  let licenseExpiryLatched=store.getSetting('licenseConfirmedExpired',false)===true;
  const licenseStatus=()=>{const status=publicLicenseStatus(licensing.getStatus(),{resumeRequired:store.getSetting('licenseResumeRequired',false)===true});
    const previous=licenseExpiryLatched;if(confirmedLicenseExpiry(status))licenseExpiryLatched=true;else if(status.allowed)licenseExpiryLatched=false;
    if(previous!==licenseExpiryLatched)try{store.setSetting('licenseConfirmedExpired',licenseExpiryLatched);}catch{scheduler?.blockOnPersistenceFailure();}
    return licenseExpiryLatched&&!status.allowed&&!confirmedLicenseExpiry(status)?{...status,totalBlocked:true,status:'expired',reasonCode:'LICENSE_EXPIRED',reason:'A última validação confirmou o vencimento. Renove ou valide uma licença vigente para liberar o aplicativo. Seus dados foram preservados.'}:status;};
  const expiredLicenseActions=new Set(['snapshot','authStatus','licenseStatus','licenseActivate','licenseRefresh','windowMinimize','windowQuit','openSupport','vitrinePublic']);
  const minimalAuth=()=>{const s=auth.status();return {authenticated:s.authenticated===true,setupRequired:s.setupRequired===true,user:null,permissions:[],lockedByLicense:true};};
  const minimalSettings=()=>({theme:store.getSetting('theme','dark'),sound:{enabled:false},notifications:{nativeEnabled:false}});
  function assertNotExpired(operation){const status=licenseStatus();if(confirmedLicenseExpiry(status)){stopForLicense(status);throw licenseError(status,operation);}return status;}
  const nativeHost=host;
  host=async(action,payload={})=>{const exempt=['windowMinimize','windowQuit','openSupport'].includes(action);if(!exempt)assertNotExpired(`native.${action}`);const result=await nativeHost(action,payload);if(!exempt)assertNotExpired(`native.${action}`);return result;};
  function stopForLicense(status=licenseStatus(),force=false){
    if(status.allowed&&!force||!automation||licenseStopLatched)return licenseStopOperation;
    // Latch synchronously before callbacks/network awaits. Renewal leaves this
    // persisted stop in place until an authorised operator explicitly resumes.
    licenseStopLatched=true;
    vitrine?.handleLicenseExpired();
    try{store.setSetting('licenseResumeRequired',true);}catch{scheduler?.blockOnPersistenceFailure();}
    const reason=status.reason||'Teste ou licença indisponível; ative ou valide para realizar novos envios.';
    try{store.addDiagnostic({id:randomUUID(),at:now(),stage:'license.blocked',code:status.reasonCode||'LICENSE_REQUIRED',level:'warning',description:reason,action:'Novas automações e envios bloqueados; dados preservados.',guidance:'Abra Licença para ativar ou validar. Depois confirme a retomada e ative individualmente as campanhas desejadas.'});}catch{if(store.persistenceFailed)scheduler?.blockOnPersistenceFailure();}
    const stopped=automation.stop({source:'license',reason});
    licenseCapturePaused=true;
    const suspended=searches?.suspendCapture('license_unavailable');
    licenseStopOperation=Promise.allSettled([stopped,suspended,sources?.suspendCapture(),opportunities?.suspendCapture()]).then(()=>{broadcast(true);});
    return licenseStopOperation;
  }
  function assertLicense(operation){
    const status=licenseStatus();
    if(!status.allowed){stopForLicense(status);throw licenseError(status,operation);}
    try{
      const result=licensing.assertAllowed(operation);
      if(result&&typeof result.then==='function')throw Object.assign(new Error('A validação final da licença precisa ser síncrona.'),{code:'LICENSE_GUARD_ASYNC'});
    }catch(error){stopForLicense(licenseStatus());throw error;}
    return status;
  }
  const automationUnavailable=()=>!licenseStatus().allowed||automation?.isStopped()===true;
  function guardAdapter(source){
    // Each transport validates again after resolving PN/LID and reading media.
    // The bypass is a private async scope established only for authorised
    // administrative replies; renderer parameters cannot create this scope.
    for(const [name,index] of [['send',3],['sendPrivate',2],['sendPrivateContent',3],['sendSearchDocument',2],['sendSearchText',2],['reply',2]]){
      if(typeof source[name]!=='function')continue;
      const original=source[name];source[name]=function(...args){
        const options=args[index]||{},previous=options.beforeSubmit,control=controlReplyScope.getStore();
        const controlOnly=!!control&&control.adapter===source&&['reply','sendSearchText'].includes(name)&&args[0]===control.chatId&&args[1]===control.text&&options.clientMessageId===control.messageId&&options.replyContext===control.context;
        assertNotExpired(`whatsapp.${name}`);if(!controlOnly)assertLicense(`whatsapp.${name}`);
        args[index]={...options,beforeSubmit:()=>{if(previous)previous();assertNotExpired(`whatsapp.${name}`);if(!controlOnly)assertLicense(`whatsapp.${name}`);}};
        return original.apply(this,args);
      };
    }
    return source;
  }
  const makeAdapter=()=>guardAdapter(store.getSetting('integrationMode','simulated')==='whatsapp'?new WhatsAppAdapter({store,credentialsDir:path.join(dir,'credentials'),safeStorage}):new SimulatedAdapter({store}));
  const can=(permission,campaign)=>auth.can(permission,campaign);
  const assert=(permission,campaign)=>{assertNotExpired(permission);return auth.assert(permission,campaign);};
  const user=()=>auth.currentUser();
  const campaigns=()=>store.listCampaigns().filter(c=>can('campaign.view',c));
  const campaignIds=()=>campaigns().map(c=>c.id);
  const scopeIds=()=>user()?.isOwner||auth.status().campaignScope==='all'?undefined:store.listCampaigns().filter(c=>(c.ownerId||c.ownerUserId)===user()?.id).map(c=>c.id);
  function assertGlobal(permission,requirements=[]){assert(permission);if(!user()?.isOwner&&auth.status().campaignScope!=='all')throw new Error('Esta operação altera ou exporta dados de todo o aplicativo e exige acesso a todas as campanhas.');for(const p of requirements){assert(p);if(p.startsWith('campaign.'))for(const c of store.listCampaigns())assert(p,c);}}
  const assertModeChange=()=>assertGlobal('settings.edit',['connection.manage','campaign.stop']);
  const assertBackup=()=>assertGlobal('settings.edit',['campaign.view','media.view','groups.view','contacts.view','notifications.view','reminder.view','opportunity.view']);
  const assertRestore=()=>assertGlobal('settings.edit',['connection.manage','users.edit','campaign.view','campaign.create','campaign.edit','campaign.delete','campaign.stop','groups.edit','media.create','media.delete','contacts.create','contacts.delete','notifications.manage','reminder.view','reminder.create','reminder.edit','reminder.delete','reminder.control','opportunity.manage','opportunity.respond']);
  const assertSearchActor=()=>{const actor=user();if(!actor)throw new Error('Faça login para continuar.');return actor.id;};
  const opportunityVisible=()=>can('opportunity.view')&&(user()?.isOwner===true||auth.status().campaignScope==='all');
  const opportunityActor=permission=>{assertGlobal(`opportunity.${permission}`);return user().id;};
  function opportunityPermission(actorId,action='manage'){
    auth.assertFor(actorId,`opportunity.${action}`);
    const actor=store.getEntity('users',actorId),role=actor&&store.getEntity('roles',actor.roleId);
    if(!role?.isOwner&&(actor?.campaignScope||role?.campaignScope||'own')!=='all')throw Object.assign(new Error('O módulo OPORTUNIDADES exige acesso a todas as campanhas.'),{code:'AUTH_DENIED'});
    return true;
  }
  const getCampaign=(id,permission='campaign.view')=>{const c=store.getCampaign(id);if(!c)throw new Error('Campanha não encontrada.');assert(permission,c);return c;};
  const audit=(action,details={})=>store.addAudit({id:randomUUID(),at:now(),userId:user()?.id||null,userName:user()?.name||null,action,...details});
  const curatedError=(action,error)=>{
    if(!auth.status().authenticated)return;
    const code=error?.code&&/^[A-Z0-9_]{1,64}$/.test(error.code)?error.code:'ACTION_FAILED';
    // Adapter exceptions and native paths may contain credentials or personal
    // messages. Record the stage and a fixed description instead of raw errors.
    try{store.addDiagnostic({id:randomUUID(),at:now(),userId:user()?.id||null,stage:action,code,description:'A operação solicitada não foi concluída.',technicalError:String(error?.message||'Motivo não informado').slice(0,1200),level:'error',attempts:0,action:'Operação interrompida sem repetição automática.',guidance:'Confira a mensagem exibida e as permissões de acesso.'});}catch{}
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
  function sourceState(){
    if(!can('campaign.view'))return null;
    const config=sources?.getConfig()||{};
    if(!can('settings.view'))return {config:{enabled:config.enabled,groupId:config.groupId,timezone:config.timezone,enabledAt:config.enabledAt},metrics:{}};
    return {config,metrics:sources?.metrics()||{}};
  }
  function campaignOperations(values){
    const rows=store.getCampaignOperations({campaignIds:values.map(c=>c.id)}),output={};
    const countsFor=value=>({...value,accepted:(value?.accepted||0)+(value?.confirmed||0)});
    for(const c of values){const row=rows[c.id]||{},health=c.destinationHealth||{};
      const sourceCounts=c.sourceGroupId?store.getSourceMetrics({campaignId:c.id}):{};
      output[c.id]={...scheduler.getCampaignTiming?.(c.id),counts:countsFor(row.counts),roundNumber:Number.isInteger(row.round?.sequence)?row.round.sequence+1:row.round?.number||c.roundIndex||0,roundStatus:row.round?.status||null,nextRunAt:c.nextRunAt,
        readyItems:(c.items||[]).filter(item=>item.ready!==false).length,pendingItems:(sourceCounts.pending||0)+(sourceCounts.review||0)+(sourceCounts.failed||0),
        destinations:(c.groupIds||[]).map(groupId=>{const h=health[groupId]||{},group=store.getGroup(groupId);return {groupId,groupName:group?.name||groupId,state:h.suspended?'suspended':adapter.status.state!=='connected'?'unknown':h.checkedAt&&h.confirmed?'available':'unknown',reason:h.lastError?.reason||h.reason||'',code:h.lastError?.code||h.code||'',lastErrorAt:h.lastError?.at||(h.suspended?h.at:null),counts:countsFor(row.groups?.[groupId]?.counts)};}),
        uncertainJobs:can('history.view',c)&&can('campaign.edit',c)?row.uncertainJobs||[]:[]};
    }
    return output;
  }
  function sourcePublication(id,permission='campaign.edit'){
    const record=store.getSourcePublication(id);if(!record)throw new Error('Publicação não encontrada no modo atual.');
    if(record.campaignId)getCampaign(record.campaignId,permission);else{assert(permission);assert('settings.view');if(scopeIds()!==undefined&&record.ownerId!==user()?.id)throw Object.assign(new Error('Sem permissão: esta publicação pertence a outro usuário.'),{code:'AUTH_FORBIDDEN'});}
    return record;
  }
  const safeSourceResult=value=>value?.publication?{...value,publication:sanitizeSourcePublication(value.publication)}:sanitizeSourcePublication(value);
  function computerClock(){const c=scheduler?.getClockStatus?.()||{at:now(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC',timeZoneOffsetMinutes:new Date(now()).getTimezoneOffset()};return {...c,now:c.at};}
  function snapshot(){
    const license=licenseStatus();if(confirmedLicenseExpiry(license))return {auth:minimalAuth(),license,version,buildRevision:'oportunidades-r3',maintenance,connection:null,settings:minimalSettings(),licenseOnly:true};
    const status=auth.status(),base={auth:status,license:licenseStatus(),version,maintenance,clock:computerClock(),storageMode:store.getStorageMode(),settings:{theme:store.getSetting('theme','dark'),integrationMode:store.getStorageMode()},campaigns:[],groups:[],media:[],templates:[],contacts:[],alertRecipients:[],campaignUsers:[],history:[],metrics:{confirmed:0,failed:0,uncertain:0,activeCampaigns:0,selectedGroups:0,nextRunAt:null}};
    if(!status.authenticated)return {...base,connection:null};
    const cs=campaigns(),ids=cs.map(c=>c.id),storageError=store.persistenceFailed||scheduler.persistenceFailed?'Armazenamento indisponível: envios bloqueados. Corrija o espaço ou as permissões e reabra o aplicativo.':null;
    const metrics=store.getMetrics?store.getMetrics({campaignIds:scopeIds()}):{confirmed:0,failed:0,uncertain:0};
    let recent=[];if(can('history.view'))recent=historyPage({limit:50,offset:0}).items||[];
    const publicSettings=can('settings.view')?settings():{theme:store.getSetting('theme','dark'),integrationMode:store.getStorageMode()};
    return {...base,auth:status,buildRevision:'oportunidades-r3',sources:sourceState(),recoveryState:can('notifications.view')?alerts?.getRecoveryState():null,opportunities:opportunityVisible()?opportunities?.getState(user()?.id):null,campaignOps:campaignOperations(cs),schemaCompatibility:can('settings.view')?store.schemaCompatibility:null,buscas:searches?.getState(user()?.id),connection:can('connection.view')?{...adapter.status,detail:storageError?`${adapter.status.detail||''} ${storageError}`:adapter.status.detail}:null,groupLoadError:can('groups.view')?groupLoadError:null,storageError,campaigns:cs,groups:can('groups.view')?store.listGroups():[],media:visibleMedia(),templates:can('media.view')?store.listTemplates():[],contacts:can('contacts.view')?entityList('contacts'):[],alertRecipients:can('campaign.create')||can('campaign.edit')||can('settings.view')?listRecipients():[],campaignUsers:can('campaign.create')||can('campaign.edit')?stripEntities(entityList('users')).filter(u=>u.active!==false).map(u=>({id:u.id,name:u.name,phone:u.phone||'',isOwner:entityList('roles').find(r=>r.id===u.roleId)?.isOwner===true||u.roleId==='owner'})):[],settings:publicSettings,history:recent,pendingReviews:can('history.view')&&store.listOperationalReviews?pendingReviewsPage({limit:20}).items:[],metrics:{...metrics,activeCampaigns:cs.filter(c=>c.state==='active').length,selectedGroups:new Set(cs.flatMap(c=>c.groupIds||[])).size,nextRunAt:cs.filter(c=>c.state==='active'&&c.nextRunAt).map(c=>c.nextRunAt).sort((a,b)=>a-b)[0]||null},dataDir:can('settings.view')?dir:undefined,upgradeBackup:can('settings.view')?store.upgradeBackup:null,notifications:can('notifications.view')?pageEntities('notifications',{campaignIds:scopeIds(),includeGlobal:true,limit:20}).items.filter(n=>!n.ownerOnly||user()?.isOwner):[],pendingContacts:can('contacts.view')?contacts?.listPendingContacts({limit:50},user()?.id):{items:[],total:0},reminders:can('reminder.view')?reminders?.list(user()?.id):null,automation:automation?.getState()};
  }
  function broadcast(immediate=false){
    if(closed)return;
    if(immediate){clearTimeout(updateTimer);updateTimer=null;events.emit('update',snapshot());events.emit('nativeEvent',{type:'settings',payload:confirmedLicenseExpiry(licenseStatus())?minimalSettings():settings()});return;}
    if(!updateTimer)updateTimer=setTimeout(()=>{updateTimer=null;if(!closed){events.emit('update',snapshot());events.emit('nativeEvent',{type:'settings',payload:confirmedLicenseExpiry(licenseStatus())?minimalSettings():settings()});}},500);
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
    source.on('status',status=>{broadcast();if(status.state==='connected'&&!confirmedLicenseExpiry(licenseStatus()))syncGroups(source).catch(()=>{});});
    source.on('transportDiagnostic',record=>{
      if(source!==adapter||closed)return;
      try{store.addDiagnostic({...record,id:randomUUID(),at:record.at||now(),userId:record.userId||null,description:record.description||'Etapa do transporte WhatsApp.',action:record.action||'Rastreamento da integração.',level:record.level||'info'});broadcast();}catch{if(store.persistenceFailed)scheduler.blockOnPersistenceFailure();}
    });

    source.on('incoming',ctx=>{
      if(confirmedLicenseExpiry(licenseStatus())){stopForLicense();return;}
      if(source===adapter&&!maintenance){try{contacts?.handleIncoming(ctx);}catch(error){store.addDiagnostic({id:randomUUID(),at:now(),stage:'contacts.intake',code:'CONTACT_INTAKE_FAILED',description:'Não foi possível registrar o primeiro contato.',action:'Confira o armazenamento e as permissões do aplicativo.'});}}
      const emergency=ctx.type==='text'&&/^!mega\s+(?:parar\s+tudo|pausar\s+\S+)\s*$/i.test(String(ctx.text||''));
      if(source!==adapter||(maintenance&&!emergency))return;
      const handle=()=>source===adapter&&(!maintenance||emergency)?commands.handle(ctx):false;
      (emergency?Promise.resolve().then(handle):enqueue(handle)).then(()=>broadcast()).catch(error=>{try{store.addDiagnostic({id:randomUUID(),at:now(),traceId:ctx.traceId||randomUUID(),stage:'command.dispatch',code:error.code||'COMMAND_DISPATCH_FAILED',level:'error',description:'Falha ao processar o comando privado.',technicalError:String(error.message||'Motivo não informado').slice(0,1200),action:'Comando interrompido; consulte a etapa e o motivo.',guidance:'Confira a conexão, as autorizações e o armazenamento.'});}catch{}broadcast();});
    });
    source.on('receipt',()=>broadcast());
  }
  async function syncGroups(source=adapter){
    assertNotExpired('groups.sync');
    if(groupSync&&groupSyncSource===source)return groupSync;
    const mode=store.getStorageMode(),traceId=randomUUID();groupSyncSource=source;
    const operation=(async()=>{
      try{
        const groups=await source.listGroups();
        assertNotExpired('groups.sync');if(source!==adapter||mode!==store.getStorageMode())return [];
        const values=store.replaceGroups(groups);searches?.refreshGroups?.();groupLoadError=null;broadcast();return values;
      }catch(error){
        if(source===adapter&&mode===store.getStorageMode()){
          store.clearGroups();searches?.refreshGroups?.();groupLoadError={code:error.code||'GROUP_SYNC_FAILED',description:'Não foi possível carregar os grupos. Confira a conexão e tente sincronizar novamente.',traceId,at:now()};
          store.addDiagnostic({id:randomUUID(),at:now(),traceId,userId:user()?.id||null,stage:'groups.sync',code:groupLoadError.code,description:groupLoadError.description,action:'Lista atual ocultada; autorizações preservadas.',guidance:'Reconecte o WhatsApp e selecione Sincronizar grupos.'});broadcast();
        }
        throw error;
      }
    })();
    groupSync=operation;
    try{return await operation;}finally{if(groupSync===operation){groupSync=null;groupSyncSource=null;}}
  }
  function listRecipients(){return store.listAlertRecipients?store.listAlertRecipients():entityList('alert_recipients');}
  const getRecipient=id=>listRecipients().find(r=>r.id===id);
  function audioPath(id){
    if(!id)return null;const entry=(store.getSetting('audioAssets',[])||[]).find(a=>a.id===id);if(!entry)return null;
    try{const real=fs.realpathSync(entry.path);if(!real.startsWith(fs.realpathSync(audioDir)+path.sep))return null;return real;}catch{return null;}
  }
  async function withMaintenance(task){if(maintenance)throw new Error('Aguarde a manutenção dos dados e da conexão terminar.');maintenance=true;broadcast();try{await searches?.suspendCapture('maintenance');await sources?.suspendCapture();await opportunities?.suspendCapture();return await task();}finally{maintenance=false;if(licenseStatus().allowed&&!licenseCapturePaused){searches?.resumeCapture();if(!automation.isStopped()){sources?.resumeCapture();opportunities?.resumeCapture();}}broadcast();}}
  async function switchMode(mode){
    await scheduler.stopAll();await adapter.disconnect();await scheduler.waitForIdle();await alerts.waitForIdle?.();alerts.prepareModeChange();await reminders?.waitForIdle?.();if(groupSync)await groupSync.catch(()=>{});adapter.removeAllListeners();
    store.setSetting('integrationMode',mode);adapter=makeAdapter();scheduler.setAdapter(adapter);commands.setAdapter(adapter);alerts.setAdapter(adapter);searches.setAdapter(adapter);reminders?.setAdapter(adapter);sources?.setAdapter(adapter);opportunities?.setAdapter(adapter);automation?.syncMode();contacts?.invalidateContacts();bindAdapter();
    cleanupTokens.clear();groupLoadError=null;
    licenseStopLatched=false;if(!licenseStatus().allowed||store.getSetting('licenseResumeRequired',false))await stopForLicense(licenseStatus(),true);
    if(mode==='simulated'){await adapter.connect();await syncGroups(adapter);}
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
    const response=await host('showSaveDialog',{title:'Exportar registros',defaultPath:`Kenned-Code-Disparos-${table}-${new Date(now()).toISOString().slice(0,10)}.json`,filters:[{name:'Registros JSON',extensions:['json']}]});
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
      const fromMe=p.fromMe===true;
      if(fromMe){if(!auth.status().user?.isOwner)throw new Error('O comando manual da conta conectada é reservado ao dono.');adapter.setOwnAccount?.(senderNumber);}
      const own=fromMe?adapter.getOwnAccount?.():null;
      adapter.injectIncoming({messageId:`SIM-COMMAND-${randomUUID()}`,senderId:`${senderNumber}@s.whatsapp.net`,senderNumber,verified:true,identityVerified:true,isGroup,fromMe,trustedSelf:fromMe,ownAccountNumber:own?.phone||null,accountId:own?.id||null,ownAccountId:own?.id||null,selfChat:fromMe&&chatId===own?.id,forwarded:!!p.forwarded,chatId,text:String(p.text??p.command),type:'text',timestamp:now(),simulation:true});
      await searches.waitForIdle();
    }
    audit('search.simulation',{messages:fixtures.length});
    return {simulation:true,description:'Teste local com dados fictícios; nenhum envio pelo WhatsApp.',messages:fixtures.length,replies:(adapter.sent?.slice(before)||[]).filter(entry=>entry.search===true),state:searches.getState(actorId)};
  }
  const actions={
    vitrineState:async()=>vitrine.getState(assertSearchActor()),
    vitrineSave:async p=>{const actor=assertSearchActor(),result=vitrine.save(p,actor);audit('vitrine.draftSaved',{count:result.items.length});return result;},
    vitrinePreview:async p=>vitrine.preview(p,assertSearchActor()),
    vitrinePublish:async p=>{const result=vitrine.publish(p,assertSearchActor());audit('vitrine.published',{count:result.count});return result;},
    vitrinePublic:async()=>{if(!confirmedLicenseExpiry(licenseStatus()))assert('vitrine.view');return vitrine.getPublic();},
    vitrineWithdraw:async p=>{const result=vitrine.withdraw(p,assertSearchActor());audit('vitrine.withdrawn',{id:p.id});return result;},
    snapshot:async()=>snapshot(),authStatus:async()=>confirmedLicenseExpiry(licenseStatus())?minimalAuth():auth.status(),
    opportunityState:async()=>opportunities.getState(opportunityActor('view')),
    opportunityConfigSave:async p=>{const actor=opportunityActor('manage'),config=p.config||p;assert('groups.view');for(const id of config.campaignIds||[])getCampaign(id);if(config.enabled===true)assertLicense('opportunity.capture');if(config.automatic===true||config.mode==='automatic'){assert('opportunity.respond');assertLicense('opportunity.send');}return opportunities.saveConfig(config,actor);},
    opportunityPage:async p=>opportunities.list(p,opportunityActor('view')),
    opportunityCampaignOffersPage:async p=>{opportunityActor('view');return opportunities.listCampaignOffers(p);},
    opportunitySetCampaignItemAvailability:async p=>{
      const actor=opportunityActor('manage');
      if(typeof p.available!=='boolean'||typeof p.campaignId!=='string'||typeof p.itemId!=='string')throw new Error('Selecione um item de campanha e informe se ele pode ser oferecido.');
      const saved=store.transaction(()=>{
        const campaign=getCampaign(p.campaignId,'campaign.edit'),index=campaign.items.findIndex(item=>item.id===p.itemId);
        if(index<0)throw new Error('O item não existe mais nesta campanha. Atualize a lista.');
        const items=campaign.items.map((item,i)=>i===index?{...item,opportunityAvailable:p.available}:item);
        const result=store.saveCampaign({...campaign,items});
        audit('opportunity.campaignItemAvailability',{campaignId:campaign.id,itemId:p.itemId,available:p.available,actorId:actor});
        return result;
      });
      opportunities.invalidateCampaignOffers({reevaluate:true});
      return {campaignId:saved.id,itemId:p.itemId,available:p.available,revision:saved.revision};
    },
    opportunityDetail:async p=>opportunities.getDetail(p.id,opportunityActor('view')),
    opportunityPreview:async p=>opportunities.preview(p,opportunityActor('respond')),
    opportunitySendManual:async p=>{const actor=opportunityActor('respond'),result=opportunities.respondManual(p,actor);audit('opportunity.manualSend',{opportunityId:p.id});return result;},
    opportunityAction:async p=>{const permission=['close','outsideAnswer'].includes(p.action)?'respond':'manage',actor=opportunityActor(permission),result=opportunities.action(p,actor);audit('opportunity.action',{opportunityId:p.id,operation:p.action});return result;},
    opportunityConfirmAvailability:async p=>{const actor=opportunityActor('manage'),result=opportunities.confirmAvailable(p,actor);audit('opportunity.availability',{offerId:p.offerId});return result;},
    opportunityReconcile:async p=>opportunities.reconcile(p,opportunityActor('respond')),
    opportunityRetryUncertain:async p=>{const actor=opportunityActor('respond'),result=opportunities.retryUncertain(p,actor);audit('opportunity.retry',{taskId:p.id});return result;},
    opportunityEvaluate:async p=>{const actor=opportunityActor('view');if(p.send===true)throw Object.assign(new Error('Esta avaliação não realiza envios. Use a prévia e confirme a resposta manual.'),{code:'OPPORTUNITY_EVALUATION_ONLY'});const selection=p.id?{ids:[p.id]}:p;const result=await opportunities.evaluateAll(selection,actor);return {...result,results:result.items};},
    sourceConfigGet:async()=>{assert('campaign.view');return sourceState();},
    sourceTestCapture:async p=>{assertGlobal('settings.edit',['groups.view','campaign.create','media.create']);assertLicense('source.capture');const result=await sources.testCapture(p,user().id);audit('source.captureTest');return result;},
    sourceSyncNow:async p=>{assertGlobal('settings.edit',['groups.view','campaign.create','media.create']);assertLicense('source.capture');const result=await sources.syncNow(p,user().id);audit('source.syncNow');return result;},
    sourceConfigSave:async p=>{assertGlobal('settings.edit',['groups.view','campaign.create','media.create']);const config=p.config||p;if(config.enabled===true)assertLicense('source.capture');return sources.saveConfig(config,user().id);},
    sourcePublications:async p=>{assert('campaign.view');const filter={limit:Math.min(200,Math.max(1,Number(p.limit)||50)),offset:Math.max(0,Number(p.offset)||0)};
      if(p.campaignId)filter.campaignId=getCampaign(p.campaignId).id;else if(!can('settings.view')||scopeIds()!==undefined)filter.campaignId=campaignIds();
      const result=store.listSourcePublications(filter);return {...result,items:result.items.map(sanitizeSourcePublication)};},
    sourceRetryMedia:async p=>{sourcePublication(p.id);assert('media.create');return sanitizeSourcePublication(await sources.retryPublication(p.id));},
    sourceReviewPublication:async p=>{sourcePublication(p.id);if(p.mediaId)assert('media.create');const result=sources.reviewPublication(p.id,{caption:p.caption,text:p.text,include:p.include,mediaId:p.mediaId},user().id);audit('source.review',{publicationId:p.id});return safeSourceResult(result);},
    sourceRemovePublication:async p=>{sourcePublication(p.id);const result=sources.removePublication(p.id,{actorId:user().id});audit('source.remove',{publicationId:p.id});return safeSourceResult(result);},
    sourceResumeGroup:async p=>{assertGlobal('settings.edit',['groups.view','campaign.create','media.create']);assertLicense('source.capture');if(p.campaignId)getCampaign(p.campaignId,'campaign.edit');const result=await sources.resumeGroup({groupId:p.groupId,campaignId:p.campaignId,confirm:p.confirm},user().id);audit('source.resumeGroup',{groupId:p.groupId,campaignId:p.campaignId||null});return result;},
    sourceReorderItems:async p=>{getCampaign(p.campaignId,'campaign.edit');audit('source.reorder',{campaignId:p.campaignId});return sources.reorderItems(p.campaignId,p.itemIds);},
    sourceApplyConfigTemplate:async p=>{getCampaign(p.campaignId,'campaign.edit');assert('settings.view');const result=sources.applyConfigTemplate(p.campaignId);audit('source.applyTemplate',{campaignId:p.campaignId});return result;},
    sourceGroupPublications:async p=>{if(!Array.isArray(p.ids)||p.ids.length>100)throw new Error('Selecione de 2 a 100 fotos.');for(const id of p.ids)sourcePublication(id);return sources.groupPublications(p.ids,{caption:p.caption},user().id);},
    sourceImportHistory:async p=>{assertGlobal('settings.edit',['campaign.create','media.create','groups.view']);return sources.importHistory({from:p.from,to:p.to});},
    destinationRecheck:async p=>{getCampaign(p.campaignId,'campaign.edit');assert('groups.view');const result=await scheduler.recheckDestination(p.campaignId,p.groupId);if(result.suspended===false&&result.confirmed===true)alerts.resolveDestination(p.campaignId,p.groupId,{at:now()});audit('destination.recheck',{campaignId:p.campaignId,groupId:p.groupId,confirmed:result.confirmed===true});return {...result,state:result.suspended?'suspended':result.confirmed?'available':'unknown'};},
    campaignReconcileUncertain:async p=>{getCampaign(p.campaignId,'campaign.edit');assert('history.view');const pending=store.queryJobs({campaignId:p.campaignId,status:'uncertain',limit:50}),results=[];for(const job of pending.items)results.push(await scheduler.reconcileJob(job.id));const remaining=store.queryJobs({campaignId:p.campaignId,status:'uncertain',limit:1}).total;audit('campaign.reconcile',{campaignId:p.campaignId,checked:results.length,remaining});return {checked:results.length,remaining,more:pending.total>pending.items.length,message:`${results.length} envios verificados; ${remaining} continuam incertos. Sem evidência confiável, nenhum reenvio automático é realizado.`};},
    manualRetryJob:async p=>{assert('history.view');const job=store.getJob(p.id);if(!job)throw new Error('Envio não encontrado.');getCampaign(job.campaignId,'campaign.edit');getCampaign(job.campaignId,'campaign.start');if(p.confirmPossibleDuplicate!==true)throw new Error('Confirme explicitamente o risco de envio duplicado.');if(automation.isStopped())throw new Error('Retome explicitamente o sistema antes de solicitar o reenvio manual.');const result=await scheduler.retryUncertain(job.id,{duplicateRiskAcknowledged:true,userId:user().id});audit('campaign.manualRetry',{campaignId:job.campaignId,originalJobId:job.id,newJobId:result.id});return result;},
    licenseStatus:async()=>licenseStatus(),
    licenseActivate:async p=>{if(typeof p.key!=='string'||!p.key.trim()||p.key.length>256)throw Object.assign(new Error('Cole uma chave de licença válida.'),{code:'LICENSE_KEY_INVALID'});await licensing.activate(p.key.trim());await stopForLicense();broadcast(true);return licenseStatus();},
    licenseRefresh:async()=>{await licensing.validate();await stopForLicense();broadcast(true);return licenseStatus();},
    setupOwner:async p=>{const result=await auth.setupOwner(p);broadcast(true);return result;},
    login:async p=>{const result=await auth.login(p);broadcast(true);return result;},
    logout:async()=>{auth.logout();cleanupTokens.clear();broadcast(true);return true;},
    recoverPassword:async p=>auth.recoverPassword(p),changePassword:async p=>auth.changePassword(p),
    listUsers:async()=>auth.listUsers(),createUser:async p=>auth.createUser(p.user||p),updateUser:async p=>auth.updateUser({...p,...p.user,id:p.id||p.user?.id}),deleteUser:async p=>auth.deleteUser(p.id),
    issueReset:async p=>auth.issueReset({userId:p.id||p.userId}),listRoles:async()=>auth.listRoles(),saveRole:async p=>auth.saveRole(p.role||p),deleteRole:async p=>auth.deleteRole(p.id),rotateRecoveryCodes:async p=>auth.rotateRecoveryCodes(p),
    searchesState:async()=>searches.getState(assertSearchActor()),
    testSearchCapture:async()=>{assert('search.manage');assertLicense('search.capture');return searches.testCapture(assertSearchActor());},
    synchronizeSearchCapture:async()=>{assert('search.manage');assertLicense('search.capture');return searches.synchronizeNow(assertSearchActor());},
    searchResultPage:async p=>searches.resultPage(p,assertSearchActor()),
    searchListPreview:async p=>searches.previewSearchList(p,assertSearchActor()),
    searchListPreviewPage:async p=>searches.previewSearchListPage(p,assertSearchActor()),
    searchSendList:async p=>searches.sendSearchList(p,assertSearchActor()),
    searchListDeliveryStatus:async p=>searches.listListDeliveries(p,assertSearchActor()),
    searchExportExcel:async p=>{
      const actorId=assertSearchActor(),mode=store.getStorageMode();
      const generated=await searches.exportSearchExcel(p,actorId);
      const response=await host('showSaveDialog',{title:'Salvar ofertas em Excel',defaultPath:generated.name,filters:[{name:'Planilha Excel',extensions:['xlsx']}]});
      if(response.canceled)return {cancelled:true};
      if(user()?.id!==actorId||store.getStorageMode()!==mode)throw new Error('O usuário ou modo de operação mudou. Exporte novamente.');
      searches.assertExportPermission(actorId,mode);assert('search.view');assert('search.run');
      const destination=response.filePath;if(typeof destination!=='string'||path.extname(destination).toLowerCase()!=='.xlsx')throw new Error('Escolha um destino com extensão .xlsx.');
      if(path.resolve(destination)===path.resolve(generated.path))throw new Error('Escolha um arquivo fora da cópia gerenciada do aplicativo.');
      const stat=await fs.promises.stat(generated.path);if(!stat.isFile()||stat.size!==generated.size)throw new Error('A planilha gerenciada não está disponível ou foi alterada.');
      const {createHash}=require('node:crypto'),digest=createHash('sha256');for await(const bytes of fs.createReadStream(generated.path))digest.update(bytes);
      if(digest.digest('hex')!==generated.sha256)throw new Error('A planilha gerenciada foi alterada; gere novamente.');
      const temp=destination+'.'+randomUUID()+'.tmp';try{await fs.promises.copyFile(generated.path,temp);if(user()?.id!==actorId||store.getStorageMode()!==mode)throw new Error('A sessão de acesso mudou.');assert('search.view');assert('search.run');searches.assertExportPermission(actorId,mode);await fs.promises.rename(temp,destination);}catch(error){await fs.promises.unlink(temp).catch(()=>{});throw error;}
      audit('search.excelExport',{count:generated.count,exportId:generated.id});return {saved:true,name:path.basename(destination),filePath:destination,count:generated.count,bytes:generated.size};
    },

    saveSearchSettings:async p=>searches.saveSettings(p.settings||p,assertSearchActor()),
    searchOffers:async p=>searches.listOffers(p,assertSearchActor()),
    searchMessages:async p=>searches.listMessages(p,assertSearchActor()),
    searchHistory:async p=>searches.listHistory(p,assertSearchActor()),
    searchRecipientStatus:async()=>searches.getRecipientStatus(assertSearchActor()),
    testSearchRecipient:async p=>searches.testRecipient(p,assertSearchActor()),
    retrySearchDelivery:async p=>searches.retryDelivery(p,assertSearchActor()),
    runSearch:async p=>searches.executeSearch({query:p.query,filters:p.filters},assertSearchActor(),{deliver:p.deliver===true,asyncDelivery:store.getStorageMode()==='whatsapp'}),
    searchAuthorizations:async()=>searches.listAuthorizations(assertSearchActor()),
    saveSearchAuthorization:async p=>searches.saveAuthorization(p.authorization||p,assertSearchActor()),
    deleteSearchAuthorization:async p=>searches.deleteAuthorization(p.id,assertSearchActor()),
    reviewSearchOffer:async p=>searches.reviewOffer(p,assertSearchActor()),
    searchCleanupPreview:async p=>searches.cleanupPreview({scope:p.scope},assertSearchActor()),
    clearSearchHistory:async p=>searches.clearData({...p,scope:'history'},assertSearchActor()),
    clearSearchBase:async p=>searches.clearData({...p,scope:'base'},assertSearchActor()),
    importSearchHistory:async()=>searches.importHistory(assertSearchActor()),
    testSearchSimulation:async p=>testSearchSimulation(p),
    connect:async()=>{assert('connection.manage');await alerts.reconnect();if(adapter.status.state==='connected')await syncGroups(adapter);audit('connection.connect');return adapter.status;},
    testConnection:async()=>{assert('connection.manage');assertLicense('connection.test');const source=adapter;const result=typeof source.testConnection==='function'?await source.testConnection({timeoutMs:15000}):{ready:source.status.state==='connected',verified:false,simulation:source.status.mode==='simulated',code:'CONNECTION_PROBE_UNSUPPORTED',detail:'Esta integração não disponibiliza uma consulta autenticada de teste.'};if(source!==adapter)throw Object.assign(new Error('A integração mudou durante o teste. Teste novamente.'),{code:'CONNECTION_CHANGED'});audit('connection.test',{ready:result.ready===true,verified:result.verified===true,code:result.code||null});return {...result,testedAt:now()};},
    disconnect:async()=>{assert('connection.manage');for(const c of store.listCampaigns())if(c.state==='active'||c.state==='paused'&&c.executionRecovery?.eligible===true)await scheduler.pause(c.id,'Conexão encerrada manualmente; retome a campanha somente após confirmação.');await adapter.disconnect({logout:true});audit('connection.disconnect');return adapter.status;},
    refreshGroups:async()=>{assert('groups.view');return syncGroups(adapter);},
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
      opportunities.invalidateCampaignOffers({reevaluate:true});
      if(shouldResume){assert('campaign.start',saved);await scheduler.resume(saved.id);}audit(old?'campaign.edit':'campaign.create',{campaignId:saved.id});return store.getCampaign(saved.id);
    },
    duplicateCampaign:async p=>{const c=getCampaign(p.id);assert('campaign.create');const copy=store.saveCampaign({...c,id:randomUUID(),ownerId:user().id,name:`${c.name.slice(0,105)} (cópia)`,state:'draft',nextRunAt:null,roundIndex:0,lastError:null,items:c.items.map(i=>({...i,id:randomUUID()}))});audit('campaign.duplicate',{campaignId:copy.id});return copy;},
    deleteCampaign:async p=>{
      const c=getCampaign(p.id,'campaign.delete'),sourceDays=store.exportSourceData().days.filter(d=>d.campaignId===c.id),isSourceCampaign=c.sourceManaged===true||sourceDays.length>0,sourceGroups=new Set(store.getSourceGroupsLinkedToCampaign(c.id));
      const uncertain=store.queryJobs({campaignId:c.id,status:'uncertain',limit:1}).total,inFlight=store.queryJobs({campaignId:c.id,status:'sending',limit:1}).total;
      if(uncertain&&!isSourceCampaign)throw new Error('Revise os envios incertos desta campanha antes de excluí-la.');
      if(sourceGroups.size){const names=[...sourceGroups].map(id=>store.getGroup(id)?.name||id).join(', '),answer=await host('showMessageBox',{type:'warning',title:'Excluir campanha vinculada',message:`Esta campanha recebe publicações automaticamente do grupo ${names}. Ao excluir, a importação desse grupo será pausada até você vincular ou criar outra campanha.`,detail:`As tarefas ainda não iniciadas serão canceladas e a campanha não será recriada automaticamente.${inFlight?' Há um envio em andamento que pode não ser cancelável; o resultado será preservado, sem novas tentativas.':''}${uncertain?' Existem resultados incertos, que podem ter sido enviados. Eles permanecem no histórico e não serão reenviados.':''}`,buttons:['Cancelar','Excluir e pausar importação'],defaultId:0,cancelId:0});if(answer.response!==1)return {cancelled:true};}
      if(isSourceCampaign&&!sourceGroups.size&&(inFlight||uncertain)){const answer=await host('showMessageBox',{type:'warning',title:'Excluir campanha de origem anterior',message:'Excluir esta campanha preservando os resultados dos envios já iniciados?',detail:'O vínculo atual do grupo continuará funcionando. Envios já iniciados podem não ser canceláveis e resultados incertos não serão reenviados automaticamente.',buttons:['Cancelar','Excluir campanha'],defaultId:0,cancelId:0});if(answer.response!==1)return {cancelled:true};}
      assert('campaign.delete',getCampaign(c.id));await scheduler.pause(c.id,'Campanha excluída; tarefas pendentes canceladas.');if(!isSourceCampaign)await scheduler.waitForIdle();
      const result=store.transaction(()=>{const paused=store.pauseSourceForCampaign(c.id,{at:now(),actorId:user().id,reason:'Pausada — campanha excluída. Crie ou vincule outra campanha para retomar.'});vitrine.handleCampaignDeleted(c.id);opportunities.invalidateCampaign?.(c.id);store.deleteCampaign(c.id);audit('campaign.delete',{campaignId:c.id,sourceGroupsPaused:paused.groupIds,inFlight,uncertain});return paused;});
      sources.cancelCampaignCapture?.(c.id);for(const groupId of result.groupIds)sources.cancelGroupCapture(groupId);return true;
    },
    previewCampaign:async p=>({summary:scheduler.getSummary(getCampaign(p.id).id),campaign:getCampaign(p.id)}),
    activateCampaign:async p=>{const c=getCampaign(p.id,'campaign.start');checkRevision(c,p);await scheduler.activate(c.id);if(c.lastError?.id)alerts.resolveIncident(c.lastError.id,{at:now(),reason:'Campanha revisada e retomada por confirmação do administrador.'});audit('campaign.start',{campaignId:c.id});return store.getCampaign(c.id);},
    resumeCampaign:async p=>{const c=getCampaign(p.id,'campaign.start');checkRevision(c,p);await scheduler.resume(c.id);if(c.lastError?.id)alerts.resolveIncident(c.lastError.id,{at:now(),reason:'Campanha revisada e retomada por confirmação do administrador.'});audit('campaign.resume',{campaignId:c.id});return store.getCampaign(c.id);},
    pauseCampaign:async p=>{const c=getCampaign(p.id,'campaign.pause');await scheduler.pause(c.id);audit('campaign.pause',{campaignId:c.id});return store.getCampaign(c.id);},
    stopCampaign:async p=>{const c=getCampaign(p.id,'campaign.stop');await scheduler.pause(c.id);const latest=store.getCampaign(c.id);store.saveCampaign({...latest,state:'stopped',nextRunAt:null});audit('campaign.stop',{campaignId:c.id});return store.getCampaign(c.id);},
    stopAll:async()=>{assert('automation.control');const result=await automation.stop({actorId:user().id,source:'app'});audit('automation.stopAll',{result});return result;},
    resumeAutomation:async()=>{assert('automation.control');assertLicense('automation.resume');const result=await automation.resume({actorId:user().id,source:'app'});audit('automation.resume');return result;},
    automationStatus:async()=>{assert('automation.control');return automation.getState();},
    importMedia:async()=>{assert('media.create');const r=await host('showOpenDialog',{title:'Importar mídias para a biblioteca',properties:['openFile','multiSelections'],filters:[{name:'Mídias e documentos',extensions:['jpg','jpeg','png','webp','mp4','mov','pdf','doc','docx','xls','xlsx','pptx','txt','csv','zip']}]});if(r.canceled)return [];assert('media.create');const imported=[];for(const file of r.filePaths)imported.push(withoutPath(await media.importFile(file)));audit('media.create',{count:imported.length});return imported;},
    mediaPath:async p=>{if(p.kind&&p.kind!=='media')throw new Error('Tipo de recurso inválido.');assert('media.view');return media.getPath(p.id);},
    saveTemplate:async p=>templates.save(p.template||p,assertSearchActor()),
    duplicateTemplate:async p=>templates.duplicate(p.id,assertSearchActor()),
    deleteTemplate:async p=>templates.delete(p.id,assertSearchActor()),
    getTemplate:async p=>templates.get(p.id,assertSearchActor()),
    templateItems:async p=>templates.apply(p.id,assertSearchActor()),
    mediaDeletionPreview:async p=>media.inspectDeletion(p.ids||[p.id],assertSearchActor()),
    deleteMedia:async p=>media.deleteFiles(p.ids||[p.id],{confirmation:p.confirmation,userId:assertSearchActor()}),
    listReminders:async()=>reminders.list(assertSearchActor()),
    saveReminder:async p=>reminders.save(p.reminder||p,assertSearchActor()),
    pauseReminder:async p=>reminders.pause(p.id,assertSearchActor()),
    activateReminder:async p=>reminders.activate(p.id,assertSearchActor()),
    deleteReminder:async p=>reminders.remove(p.id,assertSearchActor()),
    testReminder:async p=>reminders.test(p.id,assertSearchActor()),
    reminderHistory:async p=>reminders.history(p,assertSearchActor()),
    listPendingContacts:async p=>contacts.listPendingContacts(p,assertSearchActor()),
    savePendingContact:async p=>contacts.savePendingContact(p,assertSearchActor()),
    dismissPendingContact:async p=>contacts.dismissPendingContact(p,assertSearchActor()),
    saveSettings:async p=>{
      assert('settings.edit');const changesMode=p.settings?.integrationMode&&p.settings.integrationMode!==store.getSetting('integrationMode');if(changesMode)assertModeChange();
      if(p.settings?.systemAlertRecipientIds!==undefined||p.settings?.alertRetryPolicy!==undefined)assert('notifications.manage');
      const next=validateSettings(p.settings||{},store),previousWebhook=store.getSetting('webhook',DEFAULTS.webhook);
      const changesChannel=p.settings?.webhookToken!==undefined||next.webhook&&(next.webhook.enabled!==previousWebhook.enabled||next.webhook.url!==(channelUrl||previousWebhook.url));
      if(changesChannel)assertGlobal('settings.edit',['notifications.manage']);
      if(p.settings?.webhookToken!==undefined){await host('secretSet',{key:'webhookToken',value:String(p.settings.webhookToken)});assertGlobal('settings.edit',['notifications.manage']);}
      if(next.webhook&&changesChannel){await host('secretSet',{key:'webhookUrl',value:next.webhook.url});assertGlobal('settings.edit',['notifications.manage']);channelUrl=next.webhook.url;next.webhook={...next.webhook,url:channelUrl?new URL(channelUrl).origin:''};}else if(next.webhook)delete next.webhook;
      if(changesMode)assertModeChange();for(const [key,value] of Object.entries(next))store.setSetting(key,value);if(next.webhook)store.setSetting('independentAlertChannel',{...next.webhook,secretId:'webhookToken'});
      if(runtimePlatform==='win32'&&next.launchAtLogin!==undefined)await host('setLoginItemSettings',{openAtLogin:next.launchAtLogin});if(changesMode)await withMaintenance(()=>switchMode(p.settings.integrationMode));audit('settings.edit');return settings();
    },
    backup:async()=>{assertBackup();const r=await host('showSaveDialog',{title:'Backup de campanhas e mídias',defaultPath:`Kenned-Code-Disparos-${new Date(now()).toISOString().slice(0,10)}.mega.json`,filters:[{name:'Backup Kenned Code Disparos',extensions:['json']}]});if(r.canceled)return {cancelled:true};assertBackup();await media.createBackup(r.filePath);audit('settings.backup');return {path:r.filePath};},
    restore:async()=>{assertRestore();const r=await host('showOpenDialog',{title:'Restaurar backup',properties:['openFile'],filters:[{name:'Backup Kenned Code Disparos',extensions:['json']}]});if(r.canceled)return {cancelled:true};const answer=await host('showMessageBox',{type:'question',message:'Restaurar campanhas, mídias e configurações?',detail:'Os dados atuais terão backup automático. Os usuários e as permissões atuais serão preservados. As campanhas restauradas ficarão desativadas.',buttons:['Cancelar','Restaurar'],cancelId:0,defaultId:0});if(answer.response!==1)return {cancelled:true};assertRestore();return withMaintenance(async()=>{await scheduler.stopAll();await adapter.disconnect();await scheduler.waitForIdle();await media.createBackup(path.join(dir,'backups',`antes-restauracao-${now()}.mega.json`));const result=await media.restoreBackup(r.filePaths[0]);for(const c of store.listCampaigns())if(!store.getEntity('users',c.ownerId))store.saveCampaign({...c,ownerId:user().id,responsibleUserIds:(c.responsibleUserIds||[]).filter(id=>store.getEntity('users',id)),alertRecipientIds:(c.alertRecipientIds||[]).filter(id=>getRecipient(id))});await switchMode(store.getStorageMode());if(runtimePlatform==='win32')await host('setLoginItemSettings',{openAtLogin:!!store.getSetting('launchAtLogin',false)});audit('settings.restore');return result;});},
    openDataFolder:async()=>{assert('settings.view');return host('openDataFolder',{path:dir});},
    historyPage:async p=>historyPage(p),diagnosticsPage:async p=>diagnosisPage(p),
    tracePage:async p=>{assert('diagnostics.view');if(typeof p.traceId!=='string'||!p.traceId||p.traceId.length>200)throw new Error('Identificador de rastreamento inválido.');return diagnosisPage({...p,traceId:p.traceId,limit:200});},
    auditPage:async p=>{assert('audit.view');return pageEntities('audit',{...p,limit:Math.min(200,Number(p.limit)||50)});},
    exportHistory:async p=>exportRecords('history',p),exportDiagnostics:async p=>exportRecords('diagnostics',p),
    exportReports:async()=>{assert('reports.export');const r=await host('showSaveDialog',{title:'Exportar relatório',defaultPath:`Kenned-Code-Disparos-relatorio-${new Date(now()).toISOString().slice(0,10)}.json`,filters:[{name:'Relatório JSON',extensions:['json']}]});if(r.canceled)return {cancelled:true};assert('reports.export');const cs=store.listCampaigns().filter(c=>can('reports.export',c)),data={format:'mega-disparos-report',exportedAt:new Date(now()).toISOString(),metrics:store.getMetrics({campaignIds:scopeIds()}),campaigns:cs.map(c=>({id:c.id,name:c.name,state:c.state,nextRunAt:c.nextRunAt,intervalMinutes:c.intervalMinutes,groups:c.groupIds.length}))};atomicWrite(r.filePath,Buffer.from(JSON.stringify(data,null,2)));audit('reports.export',{count:cs.length});return {path:r.filePath,count:cs.length};},
    pendingReviewsPage:async p=>pendingReviewsPage(p),
    cleanupPreview:async p=>{assert('history.clear');for(const [key,value] of cleanupTokens)if(now()-value.at>5*60*1000)cleanupTokens.delete(key);while(cleanupTokens.size>=32)cleanupTokens.delete(cleanupTokens.keys().next().value);const categories=validateCategories(p.categories);const counts=store.cleanupPreview(categories),token=randomBytes(18).toString('hex');cleanupTokens.set(token,{userId:user().id,categories,at:now(),fingerprint:JSON.stringify(counts)});return {token,categories,counts:counts.counts,total:counts.total,protected:true,description:'Serão removidos somente os registros visíveis selecionados. Campanhas, mídias, usuários, configurações, auditoria e o controle operacional de envios serão preservados.'};},
    clearHistory:async p=>{assert('history.clear');if(p.confirmation!=='APAGAR')throw new Error('Digite APAGAR para confirmar.');const token=cleanupTokens.get(p.token),categories=validateCategories(p.categories);if(!token||token.userId!==user().id||now()-token.at>5*60*1000||JSON.stringify(categories)!==JSON.stringify(token.categories))throw new Error('A confirmação expirou. Confira uma nova prévia.');if(token.fingerprint!==JSON.stringify(store.cleanupPreview(categories)))throw new Error('Os registros mudaram. Confira uma nova prévia antes de apagar.');cleanupTokens.delete(p.token);const result=store.clearHistory({categories,actor:{id:user().id,name:user().name},at:now()});broadcast();return result;},
    reviewJob:async p=>{assert('history.view');const j=store.getJob(p.id);if(!j||j.status!=='uncertain')throw new Error('Envio incerto não encontrado.');getCampaign(j.campaignId,'campaign.edit');if(!['confirm','discard'].includes(p.decision))throw new Error('Decisão inválida.');const result=store.updateJob(j.id,{status:p.decision==='confirm'?'confirmed':'cancelled',resultAt:now(),error:p.decision==='confirm'?'Confirmado manualmente após verificação no WhatsApp.':'Descartado manualmente. Não reenviado.',reviewed:true,reviewedBy:user().id});audit('history.review',{campaignId:j.campaignId,jobId:j.id,decision:p.decision});return result;},
    listContacts:async p=>{assert('contacts.view');return p?.limit?pageEntities('contacts',p):entityList('contacts');},
    saveContact:async p=>{const v=p.contact||p,old=v.id?store.getEntity('contacts',v.id):null;assert(old?'contacts.edit':'contacts.create');const phone=cleanPhone(v.phone);if(!asText(v.name,121).trim()||asText(v.name,121).length>120||!validPhone(phone))throw new Error('Informe nome e telefone com país + DDD + número.');const result=store.saveEntity('contacts',{id:old?.id||randomUUID(),name:asText(v.name,120).trim(),phone,notes:asText(v.notes,1000),category:v.category!==undefined?(['Cliente Nerópolis','Lojista Camelódromo'].includes(v.category)?v.category:old?.category||''):old?.category||'',savedLocation:'system',addressBookSupported:false,createdAt:old?.createdAt||now(),updatedAt:now()});contacts?.invalidateContacts();audit(old?'contacts.edit':'contacts.create',{contactId:result.id});return result;},
    deleteContact:async p=>{assert('contacts.delete');store.deleteEntity('contacts',p.id);contacts?.invalidateContacts();audit('contacts.delete',{contactId:p.id});return true;},
    listAlertRecipients:async()=>{assert('notifications.view');return listRecipients();},
    saveAlertRecipient:async p=>{assert('notifications.manage');const v=p.recipient||p,old=v.id?getRecipient(v.id):null,phone=cleanPhone(v.phone);if(!asText(v.name,121).trim()||asText(v.name,121).length>120||!validPhone(phone))throw new Error('Informe nome e telefone com país + DDD + número.');if(v.userId&&!store.getEntity('users',v.userId))throw new Error('Usuário não encontrado.');const result=store.saveEntity('alert_recipients',{id:old?.id||randomUUID(),name:asText(v.name,120).trim(),phone,userId:v.userId||null,enabled:v.enabled!==false});audit('alerts.recipientSave',{recipientId:result.id});return result;},
    deleteAlertRecipient:async p=>{assert('notifications.manage');if(store.listCampaigns().some(c=>(c.alertRecipientIds||[]).includes(p.id))||store.listEntities('reminders').some(r=>r.recipientId===p.id))throw new Error('Remova o destinatário das campanhas e dos lembretes antes de excluí-lo.');store.deleteEntity('alert_recipients',p.id);audit('alerts.recipientDelete',{recipientId:p.id});return true;},
    testAlertRecipient:async p=>{assert('notifications.manage');const r=getRecipient(p.id);if(!r||!r.enabled)throw new Error('Destinatário não encontrado ou desativado.');audit('alerts.test',{recipientId:r.id});return alerts.testRecipient(r.phone,user().id,{recipientId:r.id});},
    testAlert:async p=>{assert('notifications.manage');if(p.event!==undefined&&!['critical','disconnect'].includes(p.event))throw new Error('Evento de alerta inválido.');audit('alerts.testOccurrence',{event:p.event||'critical'});return alerts.testAlert({userId:user().id,event:p.event||'critical'});},
    retryAlert:async p=>{assert('notifications.manage');const a=store.getAlert(p.id);if(!a)throw new Error('Alerta não encontrado.');if(a.campaignId)getCampaign(a.campaignId,'campaign.view');audit('alerts.retry',{alertId:a.id});return alerts.retryAlert(a.id,{userId:user().id});},
    alertsPage:async p=>{assert('notifications.view');return pageEntities('alerts',{...p,campaignIds:scopeIds(),includeGlobal:true,limit:Math.min(200,Number(p.limit)||50)});},
    reviewAlert:async p=>{assert('notifications.manage');const a=store.getEntity('alerts',p.id);if(!a)throw new Error('Alerta não encontrado.');if(a.campaignId&&scopeIds()&&!scopeIds().includes(a.campaignId))throw new Error('Sem permissão para este alerta.');if(typeof p.confirmed!=='boolean'&&!['confirm','discard'].includes(p.decision))throw new Error('Informe uma decisão válida para o alerta.');audit('alerts.review',{alertId:p.id,confirmed:p.confirmed===true||p.decision==='confirm'});return alerts.resolveUncertain(p.id,{confirmed:p.confirmed===true||p.decision==='confirm',userId:user().id});},
    silenceAlert:async p=>{assert('notifications.view');const notification=store.getEntity('notifications',p.id)||store.listEntities('notifications').find(n=>n.occurrenceId===p.id);if(!notification)throw new Error('Alerta não encontrado.');if(notification.campaignId&&scopeIds()&&!scopeIds().includes(notification.campaignId))throw new Error('Sem permissão para este alerta.');alerts.muteOccurrence(p.id);await host('silenceAlert',{id:p.id,occurrenceId:p.occurrenceId||notification.occurrenceId});return true;},
    importAudio:async()=>{assert('settings.edit');const r=await host('showOpenDialog',{title:'Selecionar som de alerta',properties:['openFile'],filters:[{name:'Áudio',extensions:['wav','mp3','ogg']}]});if(r.canceled)return {cancelled:true};assert('settings.edit');const original=r.filePaths[0],stat=fs.statSync(original),ext=path.extname(original).toLowerCase();if(!stat.isFile()||stat.size<1||stat.size>20*1024*1024||!['.wav','.mp3','.ogg'].includes(ext))throw new Error('Escolha WAV, MP3 ou OGG de até 20 MB.');const id=randomUUID(),filename=path.join(audioDir,`${id}${ext}`);await fs.promises.copyFile(original,filename);const entry={id,name:path.basename(original),path:filename,size:stat.size,createdAt:now()};store.setSetting('audioAssets',[...(store.getSetting('audioAssets',[])||[]),entry]);audit('settings.importAudio');return {id,name:entry.name,size:entry.size};},
    testSound:async p=>{assert('settings.edit');const prefs=validateSound(p.preferences||p.sound||store.getSetting('sound'));return host('testSound',{preferences:prefs,audioPath:audioPath(prefs.customAudioId)});},
    testSimulation:async p=>{assert('settings.edit');if(adapter.status.mode!=='simulated'&&store.getSetting('integrationMode')!=='simulated')throw new Error('Disponível somente no modo simulado.');const senderNumber=cleanPhone(p.senderNumber||user().phone);if(![user().phone,...(user().authorizedPhones||[])].includes(senderNumber))throw new Error('O teste aceita somente um número vinculado ao usuário conectado.');const before=adapter.replies?.length||0;const context=adapter.injectIncoming({messageId:randomUUID(),senderNumber,verified:true,isGroup:!!p.isGroup,forwarded:!!p.forwarded,fromMe:false,chatId:`${senderNumber}@s.whatsapp.net`,text:String(p.text||''),type:'text',timestamp:now()});await commands.handle(context);const replies=adapter.replies?.slice(before)||[];return replies.length?{text:replies.map(r=>r.text).join('\n\n'),replies}:{text:'Comando ignorado; confira a autorização.'};},
    openSupport:async()=>host('openSupport',{}),windowMinimize:async()=>host('windowMinimize',{}),windowQuit:async()=>host('windowQuit',{})
  };
  const publicUnprotected=new Set(['snapshot','authStatus','setupOwner','login','recoverPassword','windowMinimize','windowQuit','openSupport','licenseStatus','licenseActivate','licenseRefresh','vitrinePublic']);
  const immediate=new Set(['opportunityCampaignOffersPage','testConnection','sourceTestCapture','sourceSyncNow','testSearchCapture','synchronizeSearchCapture','vitrineState','vitrinePublic','vitrinePreview','vitrineWithdraw','opportunityState','opportunityPage','opportunityDetail','opportunityPreview','opportunityEvaluate','opportunityAction','opportunityConfigSave','sourceConfigGet','sourcePublications','manualRetryJob','campaignReconcileUncertain','destinationRecheck','snapshot','authStatus','historyPage','diagnosticsPage','auditPage','alertsPage','mediaPath','pauseCampaign','stopCampaign','stopAll','windowMinimize','windowQuit','searchesState','searchOffers','searchMessages','searchHistory','searchRecipientStatus','searchResultPage','searchListDeliveryStatus','tracePage','listReminders','reminderHistory','listPendingContacts','automationStatus','resumeAutomation','licenseStatus','licenseActivate','licenseRefresh']);
  const licensedActions=new Set(['testConnection','sourceTestCapture','sourceSyncNow','testSearchCapture','synchronizeSearchCapture','manualRetryJob','sourceRetryMedia','sourceImportHistory','activateCampaign','resumeCampaign','searchSendList','testSearchRecipient','retrySearchDelivery','testReminder','activateReminder','testAlertRecipient','testAlert','retryAlert','importSearchHistory']);
  const silentReads=new Set(['opportunityCampaignOffersPage','vitrineState','vitrinePublic','vitrinePreview','snapshot','authStatus','sourceConfigGet','sourcePublications','mediaPath','opportunityState','opportunityPage','opportunityDetail','opportunityPreview','opportunityEvaluate']);
  events.call=async(action,payload={})=>{
    if(closed)throw new Error('Aplicativo encerrado.');if(!Object.hasOwn(actions,action))throw new Error('Ação não autorizada.');
    if(!expiredLicenseActions.has(action))assertNotExpired(action);
    if(!publicUnprotected.has(action)&&!auth.status().authenticated)throw new Error('Faça login para continuar.');
    if(maintenance&&!immediate.has(action))throw new Error('Aguarde a manutenção dos dados e da conexão terminar.');
    const invoke=async()=>{if(!expiredLicenseActions.has(action))assertNotExpired(action);if(!publicUnprotected.has(action)&&!auth.status().authenticated)throw new Error('Faça login para continuar.');if(maintenance&&!immediate.has(action))throw new Error('Aguarde a manutenção dos dados e da conexão terminar.');if(licensedActions.has(action)||action==='runSearch'&&payload.deliver===true||action==='saveReminder'&&(payload.reminder||payload).enabled===true)assertLicense(action);const result=await actions[action](payload||{});if(!expiredLicenseActions.has(action))assertNotExpired(action);return result;};
    try{const result=await (immediate.has(action)?invoke():enqueue(invoke));if(!silentReads.has(action))broadcast();return result;}catch(error){if(store.persistenceFailed)scheduler.blockOnPersistenceFailure();curatedError(action,error);broadcast();throw error;}
  };
  events.snapshot=snapshot;
  events.systemCall=async(action,payload={})=>{
    if(action==='licenseChanged'){await stopForLicense();broadcast(true);return licenseStatus();}
    if(action==='shutdown')return events.shutdown();
    if(action==='settings'&&confirmedLicenseExpiry(licenseStatus()))return minimalSettings();
    if(action!=='nativeNotificationResult')assertNotExpired(`internal.${action}`);
    if(action==='networkState'){if(typeof payload.online!=='boolean')throw new Error('Estado da rede inválido.');await alerts.networkStateChanged(payload);return true;}
    if(action==='nativeNotificationResult'){const record=store.getEntity('notifications',payload.id);if(record&&['shown','failed','disabled','unsupported'].includes(payload.status))store.saveNotification({...record,nativeStatus:payload.status,nativeResultAt:now()});broadcast();return true;}
    if(action==='suspend'){await scheduler.handleSuspend({reason:'computer_suspended'});broadcast();return true;}
    if(action==='resume'){await scheduler.handleClockChange({reason:'computer_resumed'});if(!automationUnavailable()&&!store.getSetting('licenseResumeRequired',false)&&store.getSetting('reconnect',{}).autoResume!==false){await scheduler.recoverAfterRestart();if(adapter.getConnectionReadiness?.().ready===true||adapter.status.state==='connected'&&typeof adapter.getConnectionReadiness!=='function')await scheduler.recoverAfterConnection({reason:'computer_resumed'});}broadcast();return true;}
    if(action==='clockChanged'){await scheduler.handleClockChange(payload);broadcast();return computerClock();}
    if(action==='settings')return settings();
    if(action==='emergencyStop'){await automation.stop({source:'native-emergency'});store.addAudit({id:randomUUID(),at:now(),action:'campaign.stopAll.native',userId:null,userName:'Parada de emergência local'});broadcast();return true;}
    throw new Error('Ação interna não autorizada.');
  };
  events.shutdown=async()=>{if(closed)return;closed=true;clearTimeout(updateTimer);clearInterval(retentionTimer);clearInterval(licenseTimer);licensing.off?.('change',licenseChanged);await licenseStopOperation;await scheduler?.shutdown({preserveRecovery:true});await searches?.shutdown();await sources?.stop();await opportunities?.stop();await reminders?.stop();commands?.close?.();await alerts?.shutdown();await adapter?.disconnect({manual:false,logout:false,reasonCode:'application_closed'});await Promise.allSettled([...nativeTasks]);auth.logout();store.close();};
  adapter=makeAdapter();scheduler=new Scheduler({store,adapter,now,licenseGuard:()=>assertLicense('campaign.send')});automation=new AutomationControl({store,scheduler,now,beforeResume:()=>{assertLicense('automation.resume');store.setSetting('licenseResumeRequired',false);licenseStopLatched=false;}});
  media.auth=auth;templates=new TemplateService({store,auth,media,now});contacts=new ContactIntake({store,auth,now});
  vitrine=new VitrineService({store,media,now,isLicensed:()=>licenseStatus().allowed&&!store.persistenceFailed,assertAccess:(action,actorId,campaign)=>{if(action==='source'){auth.assertFor(actorId,'campaign.view',campaign);auth.assertFor(actorId,'media.view');return true;}auth.assertFor(actorId,`vitrine.${action}`);if(action==='manage'){const actor=store.getEntity('users',actorId),role=actor&&store.getEntity('roles',actor.roleId);if(!role?.isOwner&&(actor?.campaignScope||role?.campaignScope||'own')!=='all')throw Object.assign(new Error('Gerenciar a vitrine exige acesso a todas as campanhas.'),{code:'AUTH_DENIED'});}return true;}});
  commands=new CommandController({store,scheduler,adapter,mediaManager:media,authService:auth,automationControl:automation,licenseGuard:operation=>assertNotExpired(operation),sendAdminReply:(context,text,options)=>scheduler.runExternalSubmission(attempt=>controlReplyScope.run({adapter,chatId:context.chatId,text,messageId:options.clientMessageId,context},()=>adapter.reply(context.chatId,text,{...options,signal:attempt.signal,beforeSubmit:attempt.beforeSubmit,replyContext:context})),{manual:true,controlOnly:true}),statusProvider:()=>({connection:adapter.status,license:licenseStatus(),campaigns:store.getMetrics(),queue:store.getMetrics().pending,search:searches?.getState(store.listEntities('users').find(u=>u.roleId==='role-owner')?.id)?.monitor,alerts:{pending:store.queryEntities('alerts',{status:'pending'}).total,failed:store.queryEntities('alerts',{status:'failed'}).total},reminders:reminders?.status(),source:sources?.metrics(),opportunities:store.getOpportunityMetrics?.(),automation:automation.getState()}),now});
  alerts=new AlertService({store,scheduler,adapter,now,isAutomationStopped:automationUnavailable,secretGet:async key=>host('secretGet',{key}),sendWebhook:async({secret,message,occurrenceId,originalAt,idempotencyKey})=>{assertLicense('alert.webhook');if(automation.isStopped())throw Object.assign(new Error('Envios automáticos interrompidos.'),{code:'AUTOMATION_STOPPED',definitive:true,submitted:false,safeToRetry:false});if(!channelUrl)throw Object.assign(new Error('Canal independente não configurado.'),{definitive:true});const parsed=new URL(channelUrl);if(parsed.protocol!=='https:'||parsed.username||parsed.password)throw Object.assign(new Error('Canal HTTPS inválido.'),{definitive:true});const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);try{assertLicense('alert.webhook');if(automation.isStopped())throw Object.assign(new Error('Envios automáticos interrompidos.'),{code:'AUTOMATION_STOPPED',definitive:true,submitted:false,safeToRetry:false});const response=await fetch(parsed.href,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${secret}`,'idempotency-key':idempotencyKey},body:JSON.stringify({message,occurrenceId,originalAt}),signal:controller.signal,redirect:'error'});if(!response.ok)throw Object.assign(new Error('WEBHOOK_HTTP_FAILURE'),{definitive:true,code:'WEBHOOK_HTTP_FAILURE'});return {status:'confirmed',messageId:idempotencyKey};}finally{clearTimeout(timer);}}});
  searches=new SearchService({store,adapter,authService:auth,now,scheduler,host,mediaManager:media,automationGuard:()=>!automationUnavailable()});
  reminders=new ReminderService({store,auth,scheduler,adapter,now,isAutomationStopped:automationUnavailable,onCriticalIncident:incident=>alerts.recordSystemIncident(incident)});
  sources=new SourceCampaignService({store,mediaManager:media,adapter,safeStorage,now,isAutomationStopped:automationUnavailable,assertCanCapture:actorId=>{assertLicense('source.capture');auth.assertFor(actorId,'campaign.create');auth.assertFor(actorId,'media.create');auth.assertFor(actorId,'settings.edit');return true;}});
  opportunities=new OpportunityService({store,adapter,scheduler,now,isAutomationStopped:automationUnavailable,
    assertCanCapture:actorId=>{assertLicense('opportunity.capture');opportunityPermission(actorId,'manage');auth.assertFor(actorId,'groups.view');return true;},
    assertCanOperate:(actorId,action)=>{assertNotExpired(`opportunity.${action}`);opportunityPermission(actorId,action);if(action==='respond')assertLicense('opportunity.send');return true;},
    assertOwnerPermissions:actorId=>{opportunityPermission(actorId,'manage');opportunityPermission(actorId,'respond');auth.assertFor(actorId,'campaign.view');assertLicense('opportunity.send');return true;},
    onLocalAlert:async payload=>{const globalSound=store.getSetting('sound',DEFAULTS.sound),moduleSound=payload.sound||{};
      const preferences={...globalSound,...moduleSound,enabled:globalSound.enabled!==false&&moduleSound.enabled!==false,events:['opportunity'],repeat:false,quiet:{...moduleSound.quiet,timezone:moduleSound.quiet?.timezone||'America/Sao_Paulo'}};
      const task=host('localAlert',{...payload,event:'opportunity',preferences,soundPreferences:preferences,nativeEnabled:store.getSetting('notifications',DEFAULTS.notifications).nativeEnabled!==false,audioPath:audioPath(preferences.customAudioId)}).catch(()=>({nativeStatus:'failed',soundStatus:'failed'}));
      nativeTasks.add(task);try{return await task;}finally{nativeTasks.delete(task);}
    }});
  automation.register('opportunities',()=>{opportunities.suspendCapture();return opportunities.cancelAutomatic();});
  automation.register('source',()=>sources.suspendCapture());automation.register('search',()=>searches.stopPending());automation.register('alerts',()=>alerts.stopPending());automation.register('reminders',()=>reminders.stopAll({source:'global-stop'}));
  automation.on('change',()=>{if(!automation.isStopped()&&licenseStatus().allowed&&!store.getSetting('licenseResumeRequired',false)&&licenseCapturePaused&&!maintenance){licenseCapturePaused=false;searches.resumeCapture();}if(!automation.isStopped()&&licenseStatus().allowed&&!maintenance){sources.resumeCapture();opportunities.resumeCapture();}broadcast();});reminders.on('change',()=>broadcast());contacts.on('change',()=>broadcast());
  contacts.on('localAlert',payload=>{const task=nativeAlert(payload).catch(()=>{});nativeTasks.add(task);task.finally(()=>nativeTasks.delete(task));});
  if(!licenseStatus().allowed||store.getSetting('licenseResumeRequired',false))await stopForLicense(licenseStatus(),true);
  let lastLicenseFingerprint='';
  const licenseChanged=()=>{if(closed)return;const status=licenseStatus();void Promise.resolve(stopForLicense(status)).catch(()=>{});const fingerprint=JSON.stringify([status.allowed,status.status,status.plan,status.expiresAt,status.offlineUntil,status.reasonCode,status.autoResumeRequired,Math.ceil((status.remainingMs||0)/60000)]);if(fingerprint!==lastLicenseFingerprint){lastLicenseFingerprint=fingerprint;broadcast(true);}};
  licensing.on?.('change',licenseChanged);
  licenseTimer=setInterval(licenseChanged,1000);licenseTimer.unref?.();
  reminders.start();
  searches.on('change',()=>broadcast());searches.start();
  let sourceOpportunityRefreshPending=false;
  sources.on('change',()=>{broadcast();if(sourceOpportunityRefreshPending||closed)return;sourceOpportunityRefreshPending=true;queueMicrotask(()=>{sourceOpportunityRefreshPending=false;if(closed)return;try{opportunities.invalidateCampaignOffers({reevaluate:true});}catch(error){curatedError('opportunity.sourceRefresh',error);}});});
  opportunities.on('change',()=>broadcast());sources.start();opportunities.start();
  scheduler.on('destinationFailure',event=>{try{const result=alerts.destinationFailure(event);if(result?.catch)result.catch(error=>curatedError('alerts.destinationFailure',error));}catch(error){curatedError('alerts.destinationFailure',error);}broadcast();});
  alerts.on('localAlert',payload=>{const task=nativeAlert(payload).catch(()=>{});nativeTasks.add(task);task.finally(()=>nativeTasks.delete(task));});alerts.on('resolved',payload=>{const task=host('resolveAlert',payload).catch(()=>{});nativeTasks.add(task);task.finally(()=>nativeTasks.delete(task));broadcast();});alerts.on('change',()=>broadcast());scheduler.on('change',()=>broadcast());bindAdapter();alerts.start();scheduler.start();
  retentionTimer=setInterval(()=>{try{store.applyRetention?.(store.getSetting('retention',DEFAULTS.retention));}catch{if(store.persistenceFailed)scheduler.blockOnPersistenceFailure();}},60000);retentionTimer.unref?.();
  if(store.getSetting('integrationMode')==='simulated'&&!confirmedLicenseExpiry(licenseStatus())){await adapter.connect();await syncGroups(adapter);}
  if(!automationUnavailable()&&!store.getSetting('licenseResumeRequired',false)&&store.getSetting('reconnect',{}).autoResume!==false)await scheduler.recoverAfterRestart();
  return events;
}

function validateCategories(values){if(!Array.isArray(values)||!values.length||values.some(v=>!HISTORY_CATEGORIES.includes(v)))throw new Error('Selecione categorias de histórico válidas.');return HISTORY_CATEGORIES.filter(v=>values.includes(v));}
function validateSound(v={}){
  if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('Configuração de som inválida.');
  if(!['soft','urgent','custom'].includes(v.sound??'soft'))throw new Error('Selecione um som válido.');
  const quiet=v.quiet||{},start=quiet.start??'22:00',end=quiet.end??'08:00';validation.schedule({startTime:start,endTime:end});
  const ev=v.events??['disconnect','critical'];if(!Array.isArray(ev)||ev.some(x=>!['disconnect','critical'].includes(x)))throw new Error('Eventos sonoros inválidos.');
  return {enabled:v.enabled!==false,volume:bounded(v.volume??65,0,100,'Volume'),sound:v.sound??'soft',customAudioId:v.customAudioId||null,events:[...new Set(ev)],repeat:!!v.repeat,persistentAlarm:v.persistentAlarm!==false,intervalSeconds:bounded(v.intervalSeconds??30,5,3600,'Intervalo de repetição sonora'),maxRepeats:Math.floor(bounded(v.maxRepeats??3,1,20,'Limite de repetição sonora')),quiet:{enabled:!!quiet.enabled,start,end}};
}
function validateSettings(v,store){
  const next={};if(v.submissionTimeoutSeconds!==undefined)next.submissionTimeoutSeconds=bounded(v.submissionTimeoutSeconds,5,300,'Tempo limite de envio');if(v.destinationAlertPolicy!==undefined){const p=v.destinationAlertPolicy;if(!p||typeof p!=='object'||Array.isArray(p))throw new Error('Configuração dos resumos de erro inválida.');next.destinationAlertPolicy={summaryIntervalSeconds:bounded(p.summaryIntervalSeconds??900,60,86400,'Intervalo dos resumos de erro')};}if(v.theme!==undefined){if(!['dark','light','system'].includes(v.theme))throw new Error('Tema inválido.');next.theme=v.theme;}
  if(v.admins!==undefined){if(!Array.isArray(v.admins))throw new Error('Administradores inválidos.');next.admins=[...new Set(v.admins.map(cleanPhone))];if(next.admins.some(n=>!validPhone(n)))throw new Error('Administradores: use país + DDD + número.');const active=store.listEntities('users').filter(u=>u.active!==false);if(next.admins.some(phone=>!active.some(u=>[u.phone,...(u.authorizedPhones||[])].map(cleanPhone).includes(phone))))throw new Error('Vincule cada número administrador a um usuário ativo nas configurações de usuários.');}
  if(v.maxSelectedGroups!==undefined)next.maxSelectedGroups=Math.floor(bounded(v.maxSelectedGroups,1,1000,'Limite de grupos'));
  if(v.closeBehavior!==undefined){if(!['tray','quit','ask'].includes(v.closeBehavior))throw new Error('Opção de fechamento inválida.');next.closeBehavior=v.closeBehavior;}
  for(const key of ['launchAtLogin','minimizeToTray','unofficialAcknowledged'])if(v[key]!==undefined)next[key]=!!v[key];
  if(v.integrationMode!==undefined&&!['simulated','whatsapp'].includes(v.integrationMode))throw new Error('Integração inválida.');
  if(v.integrationMode==='whatsapp'&&!(next.unofficialAcknowledged??store.getSetting('unofficialAcknowledged',false)))throw new Error('Reconheça as limitações da integração não oficial antes de conectar.');
  if(v.sound!==undefined){next.sound=validateSound(v.sound);if(next.sound.sound==='custom'&&!(store.getSetting('audioAssets',[])||[]).some(a=>a.id===next.sound.customAudioId))throw new Error('Importe o arquivo de áudio antes de selecioná-lo.');}
  if(v.reconnect!==undefined){const r=v.reconnect;next.reconnect={enabled:!!r.enabled,maxAttempts:Math.floor(bounded(r.maxAttempts??5,0,10,'Tentativas de reconexão')),delaySeconds:bounded(r.delaySeconds??5,3,3600,'Intervalo de reconexão'),maxDelaySeconds:bounded(r.maxDelaySeconds??120,3,3600,'Limite do intervalo progressivo'),autoResume:!!r.autoResume,policyVersion:2};}
  if(v.alertRetryPolicy!==undefined){const p=v.alertRetryPolicy;next.alertRetryPolicy={maxAttempts:Math.floor(bounded(p.maxAttempts??3,1,5,'Tentativas de alerta')),delaySeconds:bounded(p.delaySeconds??15,3,3600,'Intervalo de novas tentativas de alerta')};}
  if(v.notifications!==undefined)next.notifications={nativeEnabled:v.notifications.nativeEnabled!==false};
  if(v.systemAlertRecipientIds!==undefined){
    if(!Array.isArray(v.systemAlertRecipientIds)||v.systemAlertRecipientIds.length>100||v.systemAlertRecipientIds.some(id=>typeof id!=='string'||!id||id.length>512))throw new Error('Destinatários dos alertas do sistema inválidos.');
    next.systemAlertRecipientIds=[...new Set(v.systemAlertRecipientIds)];
    if(next.systemAlertRecipientIds.some(id=>!store.getAlertRecipient(id)?.enabled))throw new Error('Selecione destinatários de alertas ativos do modo atual.');
  }
  if(v.retention!==undefined){const r=v.retention;next.retention={days:Math.floor(bounded(r.days??90,1,3650,'Retenção em dias')),maxEntries:Math.floor(bounded(r.maxEntries??20000,100,1000000,'Limite de registros')),maxMegabytes:bounded(r.maxMegabytes??64,1,1024,'Tamanho máximo dos registros')};}
  if(v.webhook!==undefined){const w=v.webhook;let url='';if(w.url){const parsed=new URL(w.url);if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.hash)throw new Error('O canal independente exige endereço HTTPS sem credenciais na URL.');url=parsed.href;}if(w.enabled&&!url)throw new Error('Configure o endereço HTTPS do canal independente.');next.webhook={enabled:!!w.enabled,url};}
  return next;
}
function candidateSummary(c,store){const content=c.items.map((item,i)=>`${i+1}. ${item.type==='text'?item.text:store.getMedia(item.mediaId)?.name||'Mídia ausente'}${item.caption?' — '+item.caption:''}`).join('\n');return `${c.name}\n\n${c.items.length} conteúdos • ${c.groupIds.length} grupos\n${c.mode==='repeat'?'Repetir conjunto':'Alternar um item por rodada'}\nRodadas a cada ${c.intervalMinutes} minutos; envios espaçados ${c.spacingSeconds} segundos.\nHorário: ${c.schedule.startTime}–${c.schedule.endTime}, dias ${c.schedule.days.join(', ')}.\n\nGrupos:\n${c.groupIds.map(id=>store.getGroup(id)?.name||id).join('\n')}\n\nConteúdo:\n${content}`;}

module.exports={createAppService,validateSettings,validateSound,validateCategories};
