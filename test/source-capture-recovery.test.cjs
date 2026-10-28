'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createStore } = require('../src/core/store.cjs');
const { MediaManager } = require('../src/core/media.cjs');
const { SourceCampaignService } = require('../src/core/source-campaigns.cjs');
const GROUP = '120363012345679011@g.us', OTHER = '120363012345679012@g.us', PHONE = '5562999999999';
const TEXT = '📱 iPhone 16 128GB\n🩷 Cor: ROSA\nR$ 2.999,00\nDetalhe na tela pequeno\n𝗣𝗮𝗹𝗮𝗰𝗲 𝗣𝗮𝗿𝗳𝘂𝗺';
const until = async predicate => { for (let i=0; i<100; i++) { if (predicate()) return; await new Promise(resolve=>setImmediate(resolve)); } throw new Error('Condição não atingida.'); };
async function fixture(t, options={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kenned-source-recovery-')), clock={value:Date.parse('2026-10-13T12:00:00Z')}, gate={allowed:true,stopped:false}, adapter=new EventEmitter(), calls={configure:0,download:[],groups:0};
 adapter.status={state:'connected'}; adapter.ready=true; adapter.getConnectionReadiness=()=>({ready:adapter.ready}); adapter.setSourceCapture=value=>{calls.configure++;adapter.captureConfig=value;};
 adapter.downloadIncoming=async(context,opts)=>{calls.download.push({context,opts});return options.download ? options.download(context,opts) : {buffer:Buffer.from('controlled-test-file'),name:context.type==='video'?'video.mp4':context.type==='document'?'arquivo.pdf':'foto.jpg',mime:context.type==='video'?'video/mp4':context.type==='document'?'application/pdf':'image/jpeg'};};
 adapter.listGroups=async()=>{calls.groups++;return [{id:GROUP,name:'Origem renomeada',simulation:false,authorized:false},{id:OTHER,name:'Outro grupo',simulation:false}];};
 let store=await createStore(dir);store.setSetting('integrationMode','whatsapp');store.upsertGroups([{id:GROUP,name:'Origem de teste',simulation:false,authorized:true},{id:OTHER,name:'Outro grupo',simulation:false,authorized:true}]);
 const services=[],stores=[store];
 const create=()=>{const service=new SourceCampaignService({store,mediaManager:new MediaManager(store),adapter,now:()=>clock.value,isAutomationStopped:()=>gate.stopped,assertCanCapture:()=>gate.allowed,safeStorage:{isEncryptionAvailable:async()=>false}});services.push(service);return service;};
 let service=create();service.saveConfig({enabled:true,groupId:GROUP,allowedParticipantIds:[PHONE],allowOwnMessages:true},'owner-test');service.start();
 const event=(id,patch={})=>({messageId:id,chatId:GROUP,isGroup:true,senderId:`${PHONE}@s.whatsapp.net`,senderIds:[`${PHONE}@s.whatsapp.net`],senderNumber:PHONE,identityVerified:true,fromMe:false,trustedSelf:false,automaticMessage:false,type:'text',text:TEXT,caption:TEXT,timestamp:clock.value,originalTimestamp:clock.value,mode:'whatsapp',simulation:false,...patch});
 const reopen=async()=>{await service.stop();store.close();store=await createStore(dir);stores.push(store);service=create();service.start();};
 t.after(async()=>{for(const value of services)await value.stop();for(const value of new Set(stores)){try{value.close();}catch{}}fs.rmSync(dir,{recursive:true,force:true});});
 return {get store(){return store;},get service(){return service;},adapter,clock,gate,calls,event,reopen};
}
test('text publications are independent original items in a single inactive daily campaign',async t=>{
 const f=await fixture(t);const first=f.service.handlePublication(f.event('TEXT-1')).publication;
 assert.equal(first.status,'ready');const campaign=f.store.getCampaign(first.campaignId);assert.equal(campaign.state,'draft');assert.equal(campaign.nextRunAt,null);assert.deepEqual(campaign.groupIds,[]);assert.equal(campaign.items[0].text,TEXT);assert.equal(first.originalAt,f.clock.value);
 f.service.handlePublication(f.event('TEXT-2',{text:'Outro texto independente',caption:'Outro texto independente'}));assert.equal(f.store.listCampaigns().length,1);assert.equal(f.store.getCampaign(campaign.id).items.length,2);assert.equal(f.calls.download.length,0);
 const diagnostics=f.store.listEntities('diagnostics').filter(value=>value.messageId==='TEXT-1').reverse();assert(diagnostics.findIndex(value=>value.stage==='received')<diagnostics.findIndex(value=>value.stage==='ready'));
});
test('video and document preserve their own exact caption and save managed files before readiness',async t=>{
 const f=await fixture(t);const ids=[];
 for(const type of ['image','video','document'])ids.push(f.service.handlePublication(f.event(type.toUpperCase(),{type,raw:{key:{id:type},message:{[`${type}Message`]:{caption:TEXT}}}})).publication.id);
 await f.service.waitForIdle();const campaign=f.store.listCampaigns()[0];assert.deepEqual(campaign.items.map(value=>value.type),['image','video','document']);
 for(const id of ids){const record=f.store.getSourcePublication(id),media=f.store.getMedia(record.mediaId);assert.equal(record.status,'ready');assert(media);assert(fs.existsSync(media.path));assert.equal(record.caption,TEXT);assert.equal(campaign.items.find(value=>value.mediaId===media.id).caption,TEXT);}
});
test('unsupported audio is explicitly held for review and cannot fake a campaign or successful download',async t=>{
 const f=await fixture(t);const publication=f.service.handlePublication(f.event('AUDIO',{type:'audio'})).publication;await f.service.waitForIdle();assert.equal(publication.status,'review');assert.equal(publication.code,'SOURCE_MEDIA_FORMAT_UNSUPPORTED');assert.equal(f.calls.download.length,0);assert.equal(f.store.listCampaigns().length,0);
});
test('capture test is armed only and confirms after the next real event is persisted as a ready item',async t=>{
 const f=await fixture(t);const probe=await f.service.testCapture({},'owner-test');assert.equal(probe.status,'waiting');assert.equal(f.store.listCampaigns().length,0);assert.equal(f.service.metrics().testCapture.status,'waiting');assert.equal((await f.service.testCapture({},'owner-test')).id,probe.id);
 f.adapter.emit('publication',f.event('PROBE-TEXT'));assert.equal(f.service.metrics().testCapture.status,'confirmed');assert.equal(f.service.metrics().testCapture.messageId,'PROBE-TEXT');assert.equal(f.service.metrics().testCapture.confirmedScope,'publication-persisted-and-ready');assert.equal(f.store.listCampaigns()[0].state,'draft');
});
test('capture probe does not approve unauthorized, automatic or historical events',async t=>{
 const f=await fixture(t);await f.service.testCapture({},'owner-test');
 f.adapter.emit('publication',f.event('NO',{senderNumber:'5562888888888',senderId:'5562888888888@s.whatsapp.net',senderIds:[]}));assert.equal(f.service.metrics().lastIgnoredReason,'SOURCE_PARTICIPANT_NOT_AUTHORIZED');assert.equal(f.service.metrics().testCapture.status,'waiting');
 for(const patch of [{automaticMessage:true},{historical:true},{fromMe:true,trustedSelf:false}])f.adapter.emit('publication',f.event(JSON.stringify(patch),patch));assert.equal(f.store.listCampaigns().length,0);assert.equal(f.service.metrics().testCapture.status,'waiting');
 f.clock.value+=120001;assert.equal(f.service.metrics().testCapture.status,'expired');assert.equal(f.service.metrics().captureStatus,'monitoring');
});
test('capture probe waits for managed photo save and surfaces actual download failure',async t=>{
 let finish;const f=await fixture(t,{download:()=>new Promise(resolve=>{finish=resolve;})});await f.service.testCapture({},'owner-test');f.adapter.emit('publication',f.event('PHOTO',{type:'image'}));await until(()=>finish);
 assert.equal(f.service.metrics().testCapture.status,'waiting');assert.equal(f.store.listCampaigns()[0].items.length,0);finish({buffer:Buffer.from('photo-ok'),name:'foto.jpg',mime:'image/jpeg'});await f.service.waitForIdle();assert.equal(f.service.metrics().testCapture.status,'confirmed');
 const broken=await fixture(t,{download:()=>{throw Object.assign(new Error('Arquivo não pôde ser baixado'),{code:'CONTROLLED_DOWNLOAD_ERROR'});}});await broken.service.testCapture({},'owner-test');broken.adapter.emit('publication',broken.event('BAD',{type:'image'}));await broken.service.waitForIdle();assert.equal(broken.service.metrics().testCapture.status,'failed');assert.equal(broken.service.metrics().lastError.code,'CONTROLLED_DOWNLOAD_ERROR');
});
test('sync refreshes real groups once, keeps permissions and never silently imports history',async t=>{
 const f=await fixture(t);let finish;f.adapter.listGroups=()=>{f.calls.groups++;return new Promise(resolve=>{finish=resolve;});};f.adapter.listSourceHistory=()=>{throw new Error('History must not be imported');};const a=f.service.syncNow({},'owner-test'),b=f.service.syncNow({},'owner-test');assert.equal(f.calls.groups,1);
 finish([{id:GROUP,name:'Novo nome real',simulation:false,authorized:false},{id:OTHER,name:'Outro grupo',simulation:false}]);const results=await Promise.all([a,b]);assert.equal(results[0].historyImported,false);assert.equal(f.store.getGroup(GROUP).name,'Novo nome real');assert.equal(f.store.getGroup(GROUP).authorized,true);assert.equal(f.service.metrics().lastSyncAt,f.clock.value);assert.equal(f.store.listSourcePublications().total,0);
});
test('sync after deleted campaign keeps durable pause, even across restart and reconnection',async t=>{
 const f=await fixture(t);const record=f.service.handlePublication(f.event('OLD')).publication;f.store.transaction(()=>{f.store.pauseSourceForCampaign(record.campaignId,{at:f.clock.value});f.store.deleteCampaign(record.campaignId);});f.service.cancelGroupCapture(GROUP);
 const synced=await f.service.syncNow({},'owner-test');assert.equal(synced.capturePaused,true);assert.equal(f.adapter.captureConfig.enabled,false);await f.reopen();f.adapter.emit('status',{state:'connected'});assert.equal(f.service.getConfig().capturePaused,true);assert.equal(f.store.listCampaigns().length,0);await assert.rejects(()=>f.service.testCapture({},'owner-test'),{code:'SOURCE_CAPTURE_BLOCKED'});
});
test('reconnect reapplies capture without multiplying listeners or duplicating manual self publications',async t=>{
 const f=await fixture(t);const initial=f.calls.configure;f.service.start();assert.equal(f.adapter.listenerCount('publication'),1);
 for(let i=0;i<3;i++){f.adapter.status={state:'disconnected'};f.adapter.emit('status',f.adapter.status);f.adapter.status={state:'connected'};f.adapter.emit('status',f.adapter.status);}
 assert.equal(f.calls.configure,initial+3);assert.equal(f.adapter.listenerCount('publication'),1);assert.equal(f.service.metrics().connectionReady,true);
 for(let i=0;i<3;i++)f.adapter.emit('publication',f.event('SELF',{fromMe:true,trustedSelf:true}));assert.equal(f.store.listSourcePublications().total,1);assert.equal(f.store.listCampaigns()[0].items.length,1);
 await f.reopen();assert.equal(f.adapter.listenerCount('publication'),1);f.adapter.emit('publication',f.event('SELF',{fromMe:true,trustedSelf:true}));assert.equal(f.store.listSourcePublications().total,1);assert.equal(f.store.listCampaigns()[0].items.length,1);
});
test('a disconnected download stays pending and resumes after readiness without duplicate items',async t=>{
 let started=false;const f=await fixture(t,{download:(context,{signal})=>{if(f.calls.download.length===1){started=true;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('disconnected'),{code:'SOURCE_MEDIA_DOWNLOAD_SUSPENDED'})),{once:true}));}return {buffer:Buffer.from('recovered'),name:'foto.jpg',mime:'image/jpeg'};}});
 const record=f.service.handlePublication(f.event('DROP',{type:'image'})).publication;await until(()=>started);f.adapter.status={state:'disconnected'};f.adapter.emit('status',f.adapter.status);await f.service.waitForIdle();assert.equal(f.store.getSourcePublication(record.id).status,'pending');assert.equal(f.store.listCampaigns()[0].items.length,0);
 f.adapter.ready=false;f.adapter.status={state:'connected'};f.adapter.emit('status',f.adapter.status);await f.service.waitForIdle();assert.equal(f.calls.download.length,1);
 f.adapter.ready=true;f.adapter.emit('status',f.adapter.status);await f.service.waitForIdle();assert.equal(f.calls.download.length,2);assert.equal(f.store.getSourcePublication(record.id).status,'ready');assert.equal(f.store.listCampaigns()[0].items.length,1);
});
test('capture probe and synchronization reject blocked permissions and unready sessions',async t=>{
 const f=await fixture(t);f.adapter.ready=false;await assert.rejects(()=>f.service.testCapture({},'owner-test'),{code:'SOURCE_CONNECTION_NOT_READY'});await assert.rejects(f.service.syncNow({},'owner-test'),{code:'SOURCE_CONNECTION_NOT_READY'});f.adapter.ready=true;f.gate.allowed=false;await assert.rejects(()=>f.service.testCapture({},'owner-test'),{code:'SOURCE_CAPTURE_BLOCKED'});await assert.rejects(f.service.syncNow({},'owner-test'),{code:'SOURCE_CAPTURE_BLOCKED'});assert.equal(f.calls.groups,0);
});

test('simultaneous capture-test requests query the session once and arm only one probe',async t=>{
 const f=await fixture(t);let finish;f.adapter.listGroups=()=>{f.calls.groups++;return new Promise(resolve=>{finish=resolve;});};const a=f.service.testCapture({},'owner-test'),b=f.service.testCapture({},'owner-test');assert.equal(f.calls.groups,1);f.clock.value+=5000;finish([{id:GROUP,simulation:false}]);const [first,second]=await Promise.all([a,b]);assert.equal(first.id,second.id);assert.equal(first.startedAt,f.clock.value);assert.equal(first.checks.groupAccessConfirmed,true);
});
test('capture test refuses a cached group that the real session no longer lists and records the precise error',async t=>{
 const f=await fixture(t);f.adapter.listGroups=async()=>[];await assert.rejects(f.service.testCapture({},'owner-test'),{code:'SOURCE_GROUP_UNAVAILABLE'});assert.equal(f.service.metrics().testCapture,null);assert.equal(f.service.metrics().lastError.code,'SOURCE_GROUP_UNAVAILABLE');assert.equal(f.store.listCampaigns().length,0);
});
test('failure details omit credential text and reconnection retains a truthful gap period',async t=>{
 const f=await fixture(t,{download:()=>{throw new Error('Falha token=PRIVATE_TEST_SENTINEL Bearer SECRET_TEST_SENTINEL');}});f.adapter.emit('publication',f.event('BAD-REDACT',{type:'image'}));await f.service.waitForIdle();const health=f.service.metrics();assert(!JSON.stringify(health).includes('PRIVATE_TEST_SENTINEL'));assert(!JSON.stringify(health).includes('SECRET_TEST_SENTINEL'));
 f.adapter.status={state:'disconnected',reason:'Sem internet'};f.adapter.emit('status',f.adapter.status);const start=f.clock.value;f.clock.value+=5000;f.adapter.status={state:'connected'};f.adapter.emit('status',f.adapter.status);assert.deepEqual(f.service.metrics().lastCaptureGap,{from:start,to:f.clock.value,reason:'Sem internet',complete:false});
});
