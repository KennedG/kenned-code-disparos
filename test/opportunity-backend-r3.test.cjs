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
test('campaign item availability is persisted, scoped, audited and preserves the campaign runtime',async t=>{
 const f=await fixture(t);await f.config();
 const before=f.store.getCampaign(f.campaign.id);
 f.store.saveCampaign({...before,state:'active',roundIndex:7,nextRunAt:f.clock.now+600000});
 const changed=await f.service.call('opportunitySetCampaignItemAvailability',{campaignId:before.id,itemId:'op-unit',available:false});
 assert.equal(changed.available,false);const saved=f.store.getCampaign(before.id);
 assert.equal(saved.state,'active');assert.equal(saved.roundIndex,7);assert.equal(saved.nextRunAt,f.clock.now+600000);
 assert.equal(saved.items[0].text,before.items[0].text);assert.equal(saved.items[0].unitReference,before.items[0].unitReference);
 assert.equal(saved.items[0].opportunityAvailable,false);assert.equal(f.store.listEntities('audit').some(row=>row.action==='opportunity.campaignItemAvailability'),true);
 const catalog=await f.service.call('opportunityCampaignOffersPage',{limit:1});assert.equal(catalog.items[0].opportunityAvailable,false);assert.equal(catalog.items[0].available,false);
 await f.service.call('pauseCampaign',{id:before.id});const paused=f.store.getCampaign(before.id);
 await f.service.call('saveCampaign',{campaign:{...paused,name:'Nome editado'}});
 assert.equal(f.store.getCampaign(before.id).items[0].opportunityAvailable,false);
 await f.close();await f.open();await f.service.call('login',{username:OWNER.username,password:PASSWORD});
 assert.equal(f.store.getCampaign(before.id).items[0].opportunityAvailable,false);
 const copy=await f.service.call('duplicateCampaign',{id:before.id});assert.equal(copy.items[0].opportunityAvailable,false);
});
test('availability requires booleans, a live item, management and campaign edit permissions',async t=>{
 const f=await fixture(t);await f.config();
 await assert.rejects(f.service.call('opportunitySetCampaignItemAvailability',{campaignId:f.campaign.id,itemId:'op-unit',available:'false'}),/informe/i);
 await assert.rejects(f.service.call('opportunitySetCampaignItemAvailability',{campaignId:f.campaign.id,itemId:'gone',available:true}),/existe mais/i);
 await assert.rejects(f.service.call('saveCampaign',{campaign:{...f.campaign,items:[{...f.campaign.items[0],opportunityAvailable:'false'}]}}),/Oportunidades inválida/i);
 const restricted=await f.service.call('createUser',{user:{name:'Gestor sem edição',username:'op-reviewer',password:PASSWORD,roleId:'role-admin',campaignScope:'all',requirePasswordChange:false,permissionOverrides:{'opportunity.view':true,'opportunity.manage':true,'campaign.edit':false}}});
 await f.service.call('logout');await f.service.call('login',{username:restricted.username,password:PASSWORD});
 await assert.rejects(f.service.call('opportunitySetCampaignItemAvailability',{campaignId:f.campaign.id,itemId:'op-unit',available:false}),/permiss|acesso|autoriz/i);
 assert.notEqual(f.store.getCampaign(f.campaign.id).items[0].opportunityAvailable,false);
 await f.service.call('logout');await assert.rejects(f.service.call('opportunityCampaignOffersPage'),/login/i);
});
test('campaign catalog is paginated beyond the initial 100 entries',async t=>{
 const f=await fixture(t);const ids=[];
 for(let c=0;c<3;c++){const campaign=f.store.saveCampaign({...f.campaign,id:randomUUID(),name:'Catálogo '+c,items:Array.from({length:90},(_,i)=>({id:randomUUID(),type:'text',text:'iPhone 12 Pro 256GB R$ '+(3000+c*90+i)+',00',unitReference:'catalog-'+c+'-'+i}))});ids.push(campaign.id);}
 await f.config({campaignIds:ids});
 const state=await f.service.call('opportunityState');assert.equal(state.campaignOffers.length,100);assert.equal(state.campaignOfferTotal,270);
 const first=await f.service.call('opportunityCampaignOffersPage',{limit:100,offset:0}),second=await f.service.call('opportunityCampaignOffersPage',{limit:100,offset:100}),third=await f.service.call('opportunityCampaignOffersPage',{limit:100,offset:200});
 assert.equal(third.total,270);assert.equal(third.items.length,70);assert.equal(new Set([...first.items,...second.items,...third.items].map(o=>o.offerId)).size,270);
});
test('confirmed licence expiration blocks both availability RPCs while preserving items',async t=>{
 const f=await fixture(t);await f.config();f.license.set({allowed:false,status:'expired',reasonCode:'LICENSE_EXPIRED',expiresAt:f.clock.now-1});await f.service.systemCall('licenseChanged');
 await assert.rejects(f.service.call('opportunityCampaignOffersPage'),{code:'LICENSE_EXPIRED'});
 await assert.rejects(f.service.call('opportunitySetCampaignItemAvailability',{campaignId:f.campaign.id,itemId:'op-unit',available:false}),{code:'LICENSE_EXPIRED'});
 assert.notEqual(f.store.getCampaign(f.campaign.id).items[0].opportunityAvailable,false);
});
