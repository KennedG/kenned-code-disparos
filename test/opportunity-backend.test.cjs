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
test('evaluation button traverses every page without creating tasks or automatic replies',async t=>{
 const f=await fixture(t);await f.config();f.event('ORIGIN-A');f.event('ORIGIN-B',{chatId:'sim-02@simulation',text:'Alguém tem 13 pro 256?'});
 assert.equal(f.store.listOpportunities().total,1);const result=await f.service.call('opportunityEvaluate',{send:false});
 assert.equal(result.evaluated,1);assert.equal(result.queued,0);assert.equal(result.automatic,false);assert.deepEqual(result.results,result.items);assert.equal(result.items[0].opportunity.groupCount,2);
 assert.equal(f.store.listOpportunityTasks().length,0);assert.equal(f.adapter.sent.length,0);
 await assert.rejects(f.service.call('opportunityEvaluate',{send:true}),{code:'OPPORTUNITY_EVALUATION_ONLY'});
 const request=f.store.listOpportunities().items[0];for(let n=0;n<204;n++)f.store.ingestOpportunity({event:{chatId:'sim-01@simulation',messageId:`PAGE-${n}`,senderKey:`phone:5562999${String(n).padStart(6,'0')}`,senderPhone:`5562999${String(n).padStart(6,'0')}`,recipient:`5562999${String(n).padStart(6,'0')}`,text:'13 Pro 256?',originalAt:f.clock.now},request:request.request},f.clock.now);
 const all=await f.service.call('opportunityEvaluate',{send:false});assert.equal(all.evaluated,205);assert.equal(all.items.length,205);assert.equal(f.store.listOpportunityTasks().length,0);
});
test('unauthenticated and own-scope users cannot read global opportunities or mutate limits',async t=>{
 const f=await fixture(t);await f.config();f.event('AUTH');
 const seller=await f.service.call('createUser',{user:{name:'Pessoa restrita',username:'op-seller',password:PASSWORD,roleId:'role-seller',requirePasswordChange:false,permissionOverrides:{'opportunity.view':true,'opportunity.manage':true,'opportunity.respond':true}}});
 await f.service.call('logout');assert.equal(f.service.snapshot().opportunities,undefined);await assert.rejects(f.service.call('opportunityState'),/login|acesso|permiss/i);
 await f.service.call('login',{username:seller.username,password:PASSWORD});assert.equal(f.service.snapshot().opportunities,null);
 await assert.rejects(f.service.call('opportunityPage'),/todas as campanhas|acesso|permiss/i);await assert.rejects(f.service.call('opportunityEvaluate',{send:false}),/todas as campanhas|acesso|permiss/i);await assert.rejects(f.config({repeatHours:1}),/todas as campanhas|acesso|permiss/i);
 assert.equal(f.store.getOpportunityConfig().repeatHours,24);assert.equal(f.store.listOpportunityTasks().length,0);
});
test('availability and stable unit reference survive campaign RPC validation and duplication',async t=>{
 const f=await fixture(t);assert.equal(f.campaign.items[0].unitReference,'real-reference-test-001');assert.deepEqual(f.campaign.items[0].availability,{available:true,confirmedAt:f.clock.now,quantity:1});
 const copy=await f.service.call('duplicateCampaign',{id:f.campaign.id});assert.notEqual(copy.items[0].id,f.campaign.items[0].id);assert.equal(copy.items[0].unitReference,f.campaign.items[0].unitReference);
 await f.config({campaignIds:[f.campaign.id,copy.id]});f.event('COPY');const op=f.store.listOpportunities().items[0],detail=await f.service.call('opportunityDetail',{id:op.id});assert.equal(detail.candidates.length,1);assert.equal(detail.candidates[0].identityConfidence,'verified');
 await assert.rejects(f.service.call('saveCampaign',{campaign:{...f.campaign,items:[{...f.campaign.items[0],availability:{available:true,confirmedAt:f.clock.now,quantity:-1}}]}}),/quantidade/i);assert.equal(f.store.getCampaign(f.campaign.id).items[0].availability.quantity,1);
});
test('outside reply through RPC cancels pending task and still blocks repetitions after reopen',async t=>{
 const f=await fixture(t);await f.config();f.event('OUTSIDE-A');const op=f.store.listOpportunities().items[0];
 await f.service.call('opportunityAction',{id:op.id,action:'outsideAnswer'});assert.equal(f.store.listOpportunityTasks()[0].status,'outside');
 await f.close();await f.open();await f.service.call('login',{username:OWNER.username,password:PASSWORD});f.clock.now+=1000;f.event('OUTSIDE-B',{chatId:'sim-02@simulation'});
 assert.equal(f.store.listOpportunities().total,1);assert.equal(f.store.listOpportunityOrigins(op.id).length,2);const detail=await f.service.call('opportunityDetail',{id:op.id});assert.ok(detail.blockers.some(x=>/respond/i.test(x.reason)));assert.equal(f.adapter.sent.length,0);
});
test('global STOP cancels opportunity automation, blocks capture and requires explicit resume',async t=>{
 const f=await fixture(t);await f.config();f.event('STOP-A');const op=f.store.listOpportunities().items[0],offer=(await f.service.call('opportunityDetail',{id:op.id})).candidates[0];
 await f.service.call('disconnect');await f.config({mode:'automatic'});const reservation=f.store.reserveOpportunitySend({opportunityId:op.id,offerIds:[offer.id],recipient:op.recipient,automatic:true,clientId:'STOP-CONTROLLED',now:f.clock.now});assert.equal(reservation.ok,true);
 const stopped=await f.service.call('stopAll');assert.equal(stopped.opportunities,1);assert.equal(f.store.getOpportunityTask(reservation.task.id).status,'cancelled');assert.equal(f.service.snapshot().automation.stopped,true);
 f.event('STOP-B',{senderNumber:'5562999990003',senderId:'5562999990003@s.whatsapp.net'});assert.equal(f.store.listOpportunities().total,1);assert.equal(f.adapter.sent.length,0);
 await f.service.call('resumeAutomation');assert.equal(f.service.snapshot().automation.stopped,false);assert.equal(f.store.getOpportunityTask(reservation.task.id).status,'cancelled');
});
test('confirmed expired licence preserves records but blocks opportunity reading, configuration and response',async t=>{
 const f=await fixture(t);await f.config();f.event('LICENSE-A');const op=f.store.listOpportunities().items[0];
 f.license.set({allowed:false,status:'expired',reasonCode:'LICENSE_EXPIRED',expiresAt:f.clock.now-1});await f.service.systemCall('licenseChanged');
 await assert.rejects(f.config(),{code:'LICENSE_EXPIRED'});await assert.rejects(f.service.call('opportunityPreview',{id:op.id}),{code:'LICENSE_EXPIRED'});
 await assert.rejects(f.service.call('opportunityPage'),{code:'LICENSE_EXPIRED'});assert.equal(f.service.snapshot().licenseOnly,true);assert.equal(f.service.snapshot().opportunities,undefined);assert.equal(f.store.listOpportunities().total,1);assert.equal(f.store.listOpportunityTasks().length,0);assert.equal(f.adapter.sent.length,0);
});
test('real and simulation modes keep opportunity records, offers and settings separated',async t=>{
 const f=await fixture(t);await f.config({repeatHours:48});f.event('SIMULATION-A');assert.equal(f.service.snapshot().opportunities.metrics.total,1);
 await f.service.call('saveSettings',{settings:{integrationMode:'whatsapp',unofficialAcknowledged:true}});assert.equal((await f.service.call('opportunityPage')).total,0);assert.equal((await f.service.call('opportunityState')).config.enabled,false);assert.equal(f.service.snapshot().groups.some(g=>g.simulation),false);
 await f.service.call('saveSettings',{settings:{integrationMode:'simulated'}});assert.equal((await f.service.call('opportunityPage')).total,1);assert.equal((await f.service.call('opportunityState')).config.repeatHours,48);
});
