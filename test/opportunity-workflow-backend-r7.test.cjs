'use strict';
// Real backend/auth/SQLite, explicit simulated WhatsApp and licence fixtures.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createAppService}=require('../src/backend/service.cjs');
const {createStore}=require('../src/core/store.cjs');
const {createLicenseFixture}=require('./fixtures/license.cjs');
const OWNER={name:'Administrador isolado R7',username:'admin-r7',password:'Senha-Segura-R7-2026!',phone:'5562999990001'};
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kc-op-workflow-backend-'));let service;
 const license=createLicenseFixture();
 const open=async()=>service=await createAppService({dir,licenseService:license,runtimePlatform:'linux',host:async action=>action==='secretGet'?null:{canceled:true,nativeStatus:'unsupported',soundStatus:'disabled'}});
 const close=async()=>{if(service)await service.shutdown();service=null;};
 await open();t.after(async()=>{await close();fs.rmSync(dir,{recursive:true,force:true});});
 return{dir,open,close,license,get app(){return service;}};
}
test('R7 routing policy defaults automatic once, verifies pre-migration backup and keeps explicit off across restart',async t=>{
 const f=await fixture(t);await f.app.call('setupOwner',OWNER);
 let cfg=(await f.app.call('opportunityState')).config;
 assert.equal(cfg.campaignDestinations,true);assert.equal(cfg.automatic,true);assert.equal(cfg.availabilityMode,'campaign');
 const backups=fs.readdirSync(path.join(f.dir,'backups')).filter(n=>n.startsWith('pre-oportunidades-r7-')&&n.endsWith('.sqlite'));assert.equal(backups.length,1);assert(fs.statSync(path.join(f.dir,'backups',backups[0])).size>0);
 await f.app.call('opportunityConfigSave',{config:{enabled:false,mode:'manual',adminPhone:OWNER.phone,campaignIds:[],monitoredGroupIds:[]}});
 const saved=(await f.app.call('opportunityState')).config;assert.equal(saved.automatic,false);assert.equal(saved.adminPhone,OWNER.phone);assert.equal(saved.adminActorId,f.app.snapshot().auth.user.id);
 await assert.rejects(f.app.call('opportunityConfigSave',{config:{adminPhone:'123'}}),{code:'OP_ADMIN_PHONE_INVALID'});
 await assert.rejects(f.app.call('opportunityConfigSave',{config:{adminPhone:'5562999990999'}}),{code:'OP_ADMIN_UNAUTHORIZED'});
 assert.equal((await f.app.call('opportunityState')).config.adminPhone,OWNER.phone,'invalid admin is not committed');
 await f.close();await f.open();await f.app.call('login',OWNER);cfg=(await f.app.call('opportunityState')).config;assert.equal(cfg.automatic,false);assert.equal(cfg.adminPhone,OWNER.phone);assert.equal(fs.readdirSync(path.join(f.dir,'backups')).filter(n=>n.startsWith('pre-oportunidades-r7-')).length,1);
});
test('new dispatch, approval and automatic mode RPCs require backend permissions and licence',async t=>{
 const f=await fixture(t);await f.app.call('setupOwner',OWNER);const owner=f.app.snapshot().auth.user;
 await f.app.call('opportunityConfigSave',{config:{enabled:false,mode:'manual',adminPhone:OWNER.phone}});
 const role=await f.app.call('saveRole',{role:{name:'Consulta R7',campaignScope:'all',permissions:['opportunity.view','campaign.view']}});
 const reader=await f.app.call('createUser',{user:{name:'Consulta isolada',username:'reader-r7',password:OWNER.password,roleId:role.id,campaignScope:'all',requirePasswordChange:false}});
 await f.app.call('logout');await f.app.call('login',{username:reader.username,password:OWNER.password});
 await assert.rejects(f.app.call('opportunityDispatch',{opportunityId:'missing',campaignId:'missing',itemId:'missing'}),/permiss|acesso|autoriz/i);
 await assert.rejects(f.app.call('opportunityWorkflowAction',{id:'missing',action:'approve'}),/permiss|acesso|autoriz/i);
 await assert.rejects(f.app.call('opportunityWorkflowAction',{action:'automaticOn'}),/permiss|acesso|autoriz/i);
 await f.app.call('logout');await f.app.call('login',OWNER);
 f.license.set({allowed:false,status:'expired',reasonCode:'LICENSE_EXPIRED',expiresAt:Date.now()-1});await f.app.systemCall('licenseChanged');
 await assert.rejects(f.app.call('opportunityDispatch',{opportunityId:'missing',campaignId:'missing',itemId:'missing'}),{code:'LICENSE_EXPIRED'});
 await assert.rejects(f.app.call('opportunityWorkflowAction',{action:'automaticOn'}),{code:'LICENSE_EXPIRED'});
 assert.equal(owner.phone,OWNER.phone);
});
test('private admin commands traverse actual backend dispatcher, persist mode and cannot revive cancelled tasks',async t=>{
 const f=await fixture(t);await f.app.call('setupOwner',OWNER);await f.app.call('opportunityConfigSave',{config:{enabled:false,mode:'manual',adminPhone:OWNER.phone}});await f.app.call('connect');
 for(const text of ['!ajuda','!status','!automatico on','!automatico off','!pausar']){
  const result=await f.app.call('testSimulation',{text});assert(result.replies?.length,`${text} must return a private reply`);assert(result.replies.every(reply=>reply.chatId===`${OWNER.phone}@s.whatsapp.net`));
 }
 assert.equal((await f.app.call('automationStatus')).stopped,true);
 await f.app.call('testSimulation',{text:'!automatico on'});assert.equal((await f.app.call('automationStatus')).stopped,false);
 const db=await createStore(f.dir);try{const ledger=db.getSetting('opportunityControlCommands:simulated',[]);assert.equal(ledger.length,6);assert(ledger.every(row=>row.status==='completed'));assert(ledger.every(row=>row.replies.every(reply=>['accepted','delivered'].includes(reply.status))));assert.equal(db.listOpportunityTasks({limit:100}).length,0);}finally{db.close();}
});
test('switching integration mode settles an in-flight opportunity in its original partition before changing settings',async t=>{
 const {SimulatedAdapter}=require('../src/adapters/simulated.cjs');const {DatabaseSync}=require('node:sqlite');
 const originalConnect=SimulatedAdapter.prototype.connect,originalSend=SimulatedAdapter.prototype.send;
 let adapter,release,entered;const gate=new Promise(r=>release=r),inside=new Promise(r=>entered=r);
 SimulatedAdapter.prototype.connect=async function(...args){adapter=this;return originalConnect.apply(this,args);};
 SimulatedAdapter.prototype.send=async function(groupId,item,media,options){options.beforeSubmit();entered();await gate;return {status:'accepted',messageId:item.clientMessageId,mode:'simulated',simulation:true};};
 t.after(()=>{release();SimulatedAdapter.prototype.connect=originalConnect;SimulatedAdapter.prototype.send=originalSend;});
 const f=await fixture(t);await f.app.call('setupOwner',OWNER);const snapshot=f.app.snapshot(),base=snapshot.campaigns[0],groupId='sim-03@simulation',origin='sim-01@simulation';
 await f.app.call('authorizeGroup',{id:groupId,authorized:true});
 const campaign=await f.app.call('saveCampaign',{campaign:{...base,name:'Teste controlado de mudança de sessão',groupIds:[groupId],items:[{id:'mode-phone',type:'text',text:'iPhone 12 Pro 256GB Azul R$ 2.500,00'}]}});
 await f.app.call('opportunityConfigSave',{config:{enabled:true,mode:'automatic',adminPhone:OWNER.phone,campaignIds:[campaign.id],monitoredGroupIds:[origin]}});
 adapter.injectOpportunityMessage({messageId:'MODE-IN-FLIGHT',chatId:origin,senderId:'5562999990002@s.whatsapp.net',senderNumber:'5562999990002',identityVerified:true,verified:true,type:'text',text:'Quem tem iPhone 12 Pro 256GB?',timestamp:Date.now()});
 await Promise.race([inside,new Promise((_,reject)=>setTimeout(()=>reject(Error('Attempt did not start')),3000))]);
 const switching=f.app.call('saveSettings',{settings:{integrationMode:'whatsapp',unofficialAcknowledged:true}});let finished=false;switching.then(()=>finished=true);
 await new Promise(r=>setTimeout(r,30));
 const db=new DatabaseSync(path.join(f.dir,'mega.sqlite'),{readOnly:true});try{const setting=db.prepare('SELECT data FROM settings WHERE id=?').get('integrationMode');assert.equal(JSON.parse(setting.data).value,'simulated','partition cannot change before original result is stored');assert.equal(finished,false);release();await switching;
  const rows=db.prepare("SELECT data FROM op_notifications WHERE storageMode='simulated' AND kind LIKE 'wf:job:%'").all().map(r=>JSON.parse(r.data));
  assert.equal(rows.filter(j=>j.type==='campaign-ad').length,1);assert.equal(rows.find(j=>j.type==='campaign-ad').status,'accepted');assert.equal(rows.some(j=>j.status==='processing'),false);
  assert.equal(db.prepare("SELECT count(*) n FROM op_notifications WHERE storageMode='whatsapp' AND kind LIKE 'wf:job:%'").get().n,0,'no old result written to new partition');
 }finally{release();db.close();}
 assert.equal(f.app.snapshot().storageMode,'whatsapp');assert.equal((await f.app.call('opportunityState')).config.campaignDestinations,true,'first real-mode use also receives the upgraded routing policy');
});
