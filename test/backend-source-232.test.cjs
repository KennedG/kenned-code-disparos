'use strict';
// Production backend + SQLite. Licencing authority and WhatsApp are explicitly
// controlled test doubles, never a claim of real handset delivery.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {createAppService}=require('../src/backend/service.cjs');
const {createStore}=require('../src/core/store.cjs');
const {SimulatedAdapter}=require('../src/adapters/simulated.cjs');
const {createLicenseFixture}=require('./fixtures/license.cjs');
const PASSWORD='Senha-Backend-Origem-232!';
const OWNER={name:'Dono de teste',username:'source-owner',password:PASSWORD,phone:'5562999990001'};
const CAPTION='📱 iPhone 16 128GB\n🩷 Cor: ROSA\n🔋 Saúde da bateria: 92%\nR$ 2.999,00\nDetalhe na tela pequeno\n\n𝗣𝗮𝗹𝗮𝗰𝗲 𝗣𝗮𝗿𝗳𝘂𝗺 - 𝗖𝗮𝗺𝗲𝗹𝗼́𝗱𝗿𝗼𝗺𝗼 𝗢𝗞 𝗦𝗧𝗔𝗡𝗗 𝟭𝟯𝟬/𝟭𝟯𝟭';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kcd-backend-source-')),clock={now:Date.now()},license=createLicenseFixture({clock:()=>clock.now});let service,store,adapter;
 const connect=SimulatedAdapter.prototype.connect;
 SimulatedAdapter.prototype.connect=async function(...args){adapter=this;return connect.apply(this,args);};
 const host=async action=>action==='secretGet'?null:action==='localAlert'?{nativeStatus:'unsupported',soundStatus:'disabled'}:action==='showMessageBox'?{response:1}:{canceled:true};
 const open=async()=>{service=await createAppService({dir,version:'2.3.2',runtimePlatform:'linux',now:()=>clock.now,licenseService:license,host});store=await createStore(dir);};
 const close=async()=>{if(store){store.close();store=null;}if(service){await service.shutdown();service=null;}};
 await open();await service.call('setupOwner',OWNER);const owner=service.snapshot().auth.user;
 t.after(async()=>{await close();SimulatedAdapter.prototype.connect=connect;fs.rmSync(dir,{recursive:true,force:true});});
 const config=async patch=>service.call('sourceConfigSave',{config:{enabled:true,groupId:'sim-01@simulation',allowedParticipantIds:[OWNER.phone],allowOwnMessages:true,configTemplate:{groupIds:['sim-02@simulation'],schedule:{days:[0,1,2,3,4,5,6],startTime:'00:00',endTime:'00:00'},messageSpacingSeconds:3,spacingSeconds:3,sendTimeoutSeconds:30},...patch}});
 const record=async(id='PUB-ONE',patch={})=>{adapter.injectPublication({messageId:id,chatId:'sim-01@simulation',senderNumber:OWNER.phone,senderId:`${OWNER.phone}@s.whatsapp.net`,senderIds:[`${OWNER.phone}@s.whatsapp.net`],verified:true,identityVerified:true,isGroup:true,type:'image',text:CAPTION,caption:CAPTION,timestamp:clock.now,simulatedMedia:{buffer:Buffer.from('controlled-image-fixture'),name:'foto.jpg',mime:'image/jpeg',type:'image'},...patch});
  const deadline=Date.now()+5000;while(Date.now()<deadline){const items=store.listSourcePublications().items;const found=items.find(x=>x.messageId===id);if(found&&['ready','review','failed','removed'].includes(found.status))return found;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('A publicação de teste não foi processada dentro do prazo de cinco segundos.');};
 const job=(campaign,status='uncertain',patch={})=>{const roundId=randomUUID();store.insertRound({id:roundId,campaignId:campaign.id,startedAt:clock.now,finishedAt:clock.now,status:'completed',sequence:0});return store.insertJob({id:randomUUID(),roundId,campaignId:campaign.id,groupId:'sim-02@simulation',itemId:campaign.items[0].id,itemSnapshot:campaign.items[0],status,createdAt:clock.now,firstAttemptAt:clock.now,attempts:1,messageId:`TEST-${randomUUID()}`,resultAt:clock.now,...patch});};
 return{dir,license,clock,owner,open,close,config,record,job,get service(){return service;},get store(){return store;},get adapter(){return adapter;}};
}

test('source APIs require login and global configuration permissions; scoped seller cannot read or edit another owner publication',async t=>{
 const f=await fixture(t);await f.config();const publication=await f.record(),campaign=f.store.getCampaign(publication.campaignId);
 const seller=await f.service.call('createUser',{user:{name:'Vendedor restrito',username:'source-seller',password:PASSWORD,phone:'5562999990002',roleId:'role-seller',requirePasswordChange:false,permissionOverrides:{'settings.edit':true,'settings.view':false,'campaign.view':true,'campaign.edit':true,'media.create':true,'groups.view':true}}});
 await f.service.call('logout');await assert.rejects(f.service.call('sourceConfigGet'),/login/i);await f.service.call('login',{username:seller.username,password:PASSWORD});
 await assert.rejects(f.service.call('sourceConfigSave',{config:{enabled:false}}),/todas as campanhas|acesso|permiss|autoriz/i);
 const list=await f.service.call('sourcePublications');assert.equal(list.total,0);assert.equal(f.service.snapshot().campaignOps[campaign.id],undefined);
 await assert.rejects(f.service.call('sourceReviewPublication',{id:publication.id,caption:'Não autorizado'}),/acesso|permiss|autoriz/i);await assert.rejects(f.service.call('sourceRemovePublication',{id:publication.id}),/acesso|permiss|autoriz/i);
 await assert.rejects(f.service.call('campaignReconcileUncertain',{campaignId:campaign.id}),/acesso|permiss|autoriz/i);
 await f.service.call('logout');await f.service.call('login',{username:OWNER.username,password:PASSWORD});assert.equal(f.store.getSourcePublication(publication.id).caption,CAPTION);
});

test('production source capture and API review preserve caption/media and never expose protected download fields',async t=>{
 const f=await fixture(t);await f.config();const publication=await f.record();assert.equal(publication.status,'ready');const campaign=f.store.getCampaign(publication.campaignId);assert.equal(campaign.state,'draft');assert.equal(campaign.items[0].caption,CAPTION);assert.deepEqual(campaign.groupIds,[]);
 f.store.updateSourcePublication(publication.id,{protectedContext:'PRIVATE-MEDIA-CONTEXT-SENTINEL',raw:{secret:'RAW-SECRET-SENTINEL'},mediaDownloadContext:{token:'DOWNLOAD-SECRET-SENTINEL'}});
 const list=await f.service.call('sourcePublications',{campaignId:campaign.id});assert.equal(list.total,1);assert(!JSON.stringify(list).includes('SECRET-SENTINEL'));assert(!JSON.stringify(list).includes('PRIVATE-MEDIA-CONTEXT-SENTINEL'));assert.equal(list.items[0].caption,CAPTION);
 const reviewed=await f.service.call('sourceReviewPublication',{id:publication.id,caption:CAPTION+'\nRevisado',include:true});assert.equal(reviewed.protectedContext,undefined);assert.equal(reviewed.raw,undefined);assert.equal(reviewed.caption,CAPTION+'\nRevisado');assert.equal(f.store.getCampaign(campaign.id).items[0].caption,reviewed.caption);
 const applied=await f.service.call('sourceApplyConfigTemplate',{campaignId:campaign.id});assert.deepEqual(applied.groupIds,['sim-02@simulation']);assert.equal(applied.state,'draft');assert.equal(applied.sourceGroupId,'sim-01@simulation');
});

test('snapshot operations distinguish acceptance/delivery/uncertainty and expose only matching campaign counters',async t=>{
 const f=await fixture(t);await f.config();const publication=await f.record();let campaign=f.store.getCampaign(publication.campaignId);campaign=f.store.saveCampaign({...campaign,groupIds:['sim-02@simulation'],roundIndex:1});
 f.job(campaign,'accepted',{acceptedAt:f.clock.now});f.job(campaign,'delivered',{acceptedAt:f.clock.now,deliveredAt:f.clock.now});f.job(campaign,'uncertain');
 const ownPending={id:'pending-own',groupId:'sim-01@simulation',messageId:'PENDING-OWN',originalAt:f.clock.now,capturedAt:f.clock.now,revisionAt:f.clock.now,dateKey:publication.dateKey,campaignId:campaign.id,status:'pending',caption:'Pendente',protectedContext:null};f.store.saveSourcePublication(ownPending);
 const foreign=f.store.saveCampaign({...campaign,id:randomUUID(),name:'Outra lista',items:[],sourceDateKey:'2026-01-01'});f.store.saveSourcePublication({...ownPending,id:'pending-foreign',messageId:'PENDING-FOREIGN',campaignId:foreign.id});
 const ops=f.service.snapshot().campaignOps[campaign.id];assert.equal(ops.counts.accepted,1);assert.equal(ops.counts.delivered,1);assert.equal(ops.counts.uncertain,1);assert.equal(ops.uncertainJobs.length,1);assert.equal(ops.pendingItems,1);assert.equal(ops.readyItems,1);assert.equal(ops.roundNumber,1);assert.equal(ops.destinations[0].groupId,'sim-02@simulation');
});

test('source configuration and global timeout survive reopen; illegal intervals fail without changing committed settings',async t=>{
 const f=await fixture(t);await f.config({configTemplate:{groupIds:['sim-02@simulation'],messageSpacingSeconds:4,spacingSeconds:9,intervalMinutes:10,sendTimeoutSeconds:25,maxRounds:3,schedule:{startTime:'08:00',endTime:'18:00',days:[1,2,3,4,5]}}});await f.service.call('saveSettings',{settings:{submissionTimeoutSeconds:22,destinationAlertPolicy:{summaryIntervalSeconds:300}}});
 await assert.rejects(f.service.call('saveSettings',{settings:{submissionTimeoutSeconds:0}}),/5.*300|entre/i);assert.equal(f.service.snapshot().settings.submissionTimeoutSeconds,22);
 await f.close();await f.open();await f.service.call('login',{username:OWNER.username,password:PASSWORD});const state=await f.service.call('sourceConfigGet');assert.equal(state.config.groupId,'sim-01@simulation');assert.equal(state.config.configTemplate.sendTimeoutSeconds,25);assert.equal(state.config.configTemplate.messageSpacingSeconds,4);assert.equal(f.service.snapshot().settings.submissionTimeoutSeconds,22);assert.equal(f.service.snapshot().settings.destinationAlertPolicy.summaryIntervalSeconds,300);assert.equal(f.service.snapshot().license.allowed,true);
});

test('STOP blocks new capture and licence expiration blocks reactivation, preserving existing source records',async t=>{
 const f=await fixture(t);await f.config();const first=await f.record();await f.service.call('stopAll');assert.equal(f.service.snapshot().automation.stopped,true);
 f.adapter.injectPublication({messageId:'STOP-IGNORED',chatId:'sim-01@simulation',senderNumber:OWNER.phone,type:'image',text:CAPTION,timestamp:f.clock.now,simulatedMedia:{buffer:Buffer.from('test'),name:'photo.jpg',mime:'image/jpeg',type:'image'}});await tick();assert.equal(f.store.listSourcePublications().total,1);
 await f.service.call('resumeAutomation');f.clock.now+=1000;const second=await f.record('AFTER-RESUME');assert.equal(second.campaignId,first.campaignId);
 f.license.set({allowed:false,status:'expired',reasonCode:'LICENSE_EXPIRED',expiresAt:f.clock.now-1});await f.service.systemCall('licenseChanged');await assert.rejects(f.service.call('sourceConfigSave',{config:{enabled:true}}),error=>error.code==='LICENSE_EXPIRED');assert.equal(f.store.listSourcePublications().total,2);assert.equal(f.service.snapshot().automation.stopped,true);
});

test('real and simulation sources, selectors and metrics are isolated when changing mode and recover after return',async t=>{
 const f=await fixture(t);await f.config();await f.record();assert.equal((await f.service.call('sourcePublications')).total,1);
 await f.service.call('saveSettings',{settings:{integrationMode:'whatsapp',unofficialAcknowledged:true}});const real=f.service.snapshot();assert.equal(real.storageMode,'whatsapp');assert.equal((await f.service.call('sourcePublications')).total,0);assert.equal(real.sources.config.enabled,false);assert.equal(real.groups.filter(g=>g.simulation).length,0);
 await f.service.call('saveSettings',{settings:{integrationMode:'simulated'}});assert.equal((await f.service.call('sourcePublications')).total,1);assert.equal((await f.service.call('sourceConfigGet')).config.groupId,'sim-01@simulation');
});

test('owner reconciliation and controlled manual retry use persisted identity, warning and one linked task; no unsafe requeue',async t=>{
 const f=await fixture(t);await f.config();const publication=await f.record();let campaign=f.store.getCampaign(publication.campaignId);campaign=f.store.saveCampaign({...campaign,groupIds:['sim-02@simulation'],state:'paused'});const original=f.job(campaign,'uncertain');
 const reconciled=await f.service.call('campaignReconcileUncertain',{campaignId:campaign.id});assert.equal(reconciled.checked,1);assert.equal(reconciled.remaining,1);assert.equal(f.adapter.sent.length,0);
 await assert.rejects(f.service.call('manualRetryJob',{id:original.id}),/risco|duplic/i);
 const [a,b]=await Promise.all([f.service.call('manualRetryJob',{id:original.id,confirmPossibleDuplicate:true}),f.service.call('manualRetryJob',{id:original.id,confirmPossibleDuplicate:true})]);assert.equal(a.id,b.id);assert.equal(a.status,'accepted');assert.notEqual(a.messageId,original.messageId);assert.equal(a.originalJobId,original.id);assert.equal(f.adapter.sent.length,1);assert.equal(f.store.getJob(original.id).status,'uncertain');assert.equal(f.store.getJob(original.id).manualResendJobId,a.id);
 await f.service.call('stopAll');await assert.rejects(f.service.call('manualRetryJob',{id:original.id,confirmPossibleDuplicate:true}),/retome|interromp/i);assert.equal(f.adapter.sent.length,1);
});

test('destination recheck requires permission and truthful current metadata; clearing suspension never starts a campaign',async t=>{
 const f=await fixture(t);await f.config();const publication=await f.record();let campaign=f.store.getCampaign(publication.campaignId);campaign=f.store.saveCampaign({...campaign,groupIds:['sim-02@simulation'],destinationHealth:{'sim-02@simulation':{suspended:true,code:'WA_GROUP_ADMIN_ONLY',reason:'Apenas administradores',at:f.clock.now}}});
 const ready=await f.service.call('destinationRecheck',{campaignId:campaign.id,groupId:'sim-02@simulation'});assert.equal(ready.state,'available');assert.equal(ready.suspended,false);assert.equal(f.store.getCampaign(campaign.id).state,'draft');assert.equal(f.adapter.sent.length,0);
 f.adapter.setGroupPublishingStatus('sim-02@simulation',{available:false,canSend:false,code:'WA_GROUP_NOT_PARTICIPANT',reason:'Conta removida',confirmed:true});const blocked=await f.service.call('destinationRecheck',{campaignId:campaign.id,groupId:'sim-02@simulation'});assert.equal(blocked.state,'suspended');assert.equal(blocked.code,'WA_GROUP_NOT_PARTICIPANT');assert.equal(f.store.getCampaign(campaign.id).state,'draft');
});

test('backend source scheduling preserves explicit timezone and indexed daily limits follow Brasília rather than Windows midnight',async t=>{
 const f=await fixture(t);f.clock.now=Date.parse('2026-10-08T00:30:00Z');await f.config({configTemplate:{groupIds:['sim-02@simulation'],schedule:{timezone:'America/Sao_Paulo',days:[0,1,2,3,4,5,6],startTime:'00:00',endTime:'00:00'},messageSpacingSeconds:3,spacingSeconds:3,sendTimeoutSeconds:30}});
 const publication=await f.record();assert.equal(publication.dateKey,'2026-10-07');let campaign=await f.service.call('sourceApplyConfigTemplate',{campaignId:publication.campaignId});
 campaign=await f.service.call('saveCampaign',{campaign:{...campaign,dailyRoundLimit:1}});assert.equal(campaign.sourceTimezone,'America/Sao_Paulo');assert.equal(campaign.schedule.timezone,'America/Sao_Paulo');
 f.store.insertRound({id:randomUUID(),campaignId:campaign.id,startedAt:Date.parse('2026-10-07T23:00:00Z'),finishedAt:Date.parse('2026-10-07T23:00:00Z'),status:'completed'});
 assert.equal(f.store.getCampaignCounts(campaign.id,f.clock.now,{timezone:'America/Sao_Paulo'}).rounds,1);
 const activated=await f.service.call('activateCampaign',{id:campaign.id,configRevision:campaign.configRevision,summaryState:campaign.state});assert.equal(activated.state,'active');assert.equal(activated.nextRunAt,Date.parse('2026-10-08T03:00:00Z'));assert.equal(f.adapter.sent.length,0);
});
