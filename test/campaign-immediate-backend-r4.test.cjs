'use strict';
// Production backend/RPC and SQLite with explicit licensing/transport fixtures.
// These checks do not claim receipt on WhatsApp or execution on Windows.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {createAppService}=require('../src/backend/service.cjs');
const {createStore}=require('../src/core/store.cjs');
const {SimulatedAdapter}=require('../src/adapters/simulated.cjs');
const {createLicenseFixture}=require('./fixtures/license.cjs');
const PASSWORD='Oportunidades-RPC-232-Test!';
const OWNER={name:'Dono de teste',username:'op-owner',password:PASSWORD,phone:'5562999990001'};
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kcd-opportunity-backend-')),clock={now:Date.now()},license=createLicenseFixture({clock:()=>clock.now});
 let service,store,adapter;const connect=SimulatedAdapter.prototype.connect;
 SimulatedAdapter.prototype.connect=async function(...args){adapter=this;return connect.apply(this,args);};
 const open=async()=>{service=await createAppService({dir,version:'2.3.2',runtimePlatform:'linux',now:()=>clock.now,licenseService:license,host:async action=>action==='secretGet'?null:action==='localAlert'?{nativeStatus:'unsupported',soundStatus:'disabled'}:{canceled:true}});store=await createStore(dir);};
 const close=async()=>{store?.close();store=null;if(service)await service.shutdown();service=null;};
 await open();await service.call('setupOwner',OWNER);const owner=service.snapshot().auth.user;
 t.after(async()=>{await close();SimulatedAdapter.prototype.connect=connect;fs.rmSync(dir,{recursive:true,force:true});});
 const seedCampaign=service.snapshot().campaigns[0];
 const campaign=await service.call('saveCampaign',{campaign:{...seedCampaign,id:randomUUID(),ownerId:owner.id,name:'Lista de teste registrada',state:'draft',groupIds:[],items:[{id:'op-unit',type:'text',text:'iPhone 13 Pro 256GB Azul seminovo bateria 90% R$ 3.000,00 disponível',unitReference:'real-reference-test-001',availability:{available:true,confirmedAt:clock.now,quantity:1}}]}});
 const config=patch=>service.call('opportunityConfigSave',{config:{enabled:true,mode:'evaluation',campaignIds:[campaign.id],monitoredGroupIds:['sim-01@simulation','sim-02@simulation'],...patch}});
 const event=(messageId,patch={})=>adapter.injectOpportunityMessage({messageId,chatId:'sim-01@simulation',senderNumber:'5562999990002',senderId:'5562999990002@s.whatsapp.net',senderIds:['5562999990002@s.whatsapp.net'],identityVerified:true,verified:true,text:'Quem tem iPhone 13 Pro 256GB?',type:'text',timestamp:clock.now,...patch});
 return{dir,owner,license,clock,campaign,config,event,open,close,get service(){return service;},get store(){return store;},get adapter(){return adapter;}};
}
test('normal activation through RPC records relative anchor and preserves it through campaign editing',async t=>{
 const f=await fixture(t);let c=f.store.getCampaign(f.campaign.id);c=f.store.saveCampaign({...c,groupIds:['sim-01@simulation'],schedule:{days:[0,1,2,3,4,5,6],startTime:'00:00',endTime:'00:00'}});
 const activated=await f.service.call('activateCampaign',{id:c.id,revision:c.revision,configRevision:c.configRevision,summaryState:c.state});
 assert.equal(activated.roundAnchorAt,f.clock.now);assert.equal(activated.nextRunAt,f.clock.now);
 await f.service.call('pauseCampaign',{id:c.id});const paused=f.store.getCampaign(c.id);const edited=await f.service.call('saveCampaign',{campaign:{...paused,name:'Renomeada'}});
 assert.equal(edited.roundAnchorAt,f.clock.now);await f.close();await f.open();await f.service.call('login',{username:OWNER.username,password:PASSWORD});assert.equal(f.store.getCampaign(c.id).roundAnchorAt,f.clock.now);
});
test('immediate RPC validates start permission, licensing, stale previews and valid request identifiers',async t=>{
 const f=await fixture(t);const c=f.store.getCampaign(f.campaign.id);
 await assert.rejects(f.service.call('sendCampaignNow',{id:c.id,requestId:'x',configRevision:c.configRevision+100}),/alterad|atualiz|versão|mudou/i);
 f.license.set({allowed:false,status:'expired',reasonCode:'LICENSE_EXPIRED',expiresAt:f.clock.now-1});await f.service.systemCall('licenseChanged');
 await assert.rejects(f.service.call('sendCampaignNow',{id:c.id,requestId:'x'}),{code:'LICENSE_EXPIRED'});assert.equal(f.store.listRounds(c.id).length,0);
});

test('failed persistence rolls back immediate activation and its idempotency marker together',async t=>{
 const f=await fixture(t),{Scheduler}=require('../src/core/scheduler.cjs');const original=f.store.getCampaign(f.campaign.id);
 f.store.saveCampaign({...original,groupIds:['sim-01@simulation'],schedule:{days:[0,1,2,3,4,5,6],startTime:'00:00',endTime:'00:00'}});
 const scheduler=new Scheduler({store:f.store,adapter:f.adapter,now:()=>f.clock.now}),set=f.store.setSetting;
 f.store.setSetting=function(key,...args){if(key.startsWith('campaignImmediate:'))throw new Error('controlled write failure');return set.call(this,key,...args);};
 await assert.rejects(scheduler.sendNow(original.id,{requestId:'atomic-write-test'}),/write failure/);
 assert.equal(f.store.getCampaign(original.id).state,'draft');assert.equal(f.store.getCampaign(original.id).roundAnchorAt,undefined);
 assert.equal(scheduler.hasImmediateRequest(original.id,'atomic-write-test'),false);assert.equal(f.store.listRounds(original.id).length,0);
 f.store.setSetting=set;await scheduler.shutdown();
});
