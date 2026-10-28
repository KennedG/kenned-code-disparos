'use strict';

// A controlled licence authority and simulated adapter exercise the production
// SQLite backend. These are not hosted-service or real WhatsApp validations.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createAppService}=require('../src/backend/service.cjs');
const {createStore}=require('../src/core/store.cjs');
const {createLicenseFixture}=require('./fixtures/license.cjs');
const PASSWORD='Senha-Teste-Licenca-232!';
const OWNER={name:'Dono de teste',username:'licenca-dono',password:PASSWORD,phone:'5562999990001'};
const expired={allowed:false,status:'expired',reasonCode:'LICENSE_EXPIRED',reason:'O prazo terminou. Ative uma licença para realizar novos envios.'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

async function fixture(t,{license=createLicenseFixture(),missing=false}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kenned-license-backend-232-'));
  let service,savePath;
  const host=async(action)=>{if(action==='secretGet')return null;if(action==='showSaveDialog')return savePath?{canceled:false,filePath:savePath}:{canceled:true};if(action==='localAlert')return {nativeStatus:'unsupported',soundStatus:'disabled'};return {canceled:true};};
  const open=async()=>service=await createAppService({dir,version:'2.3.2',runtimePlatform:'linux',host,...(!missing?{licenseService:license}:{})});
  const close=async()=>{if(service){await service.shutdown();service=null;}};
  await open();
  t.after(async()=>{await close();fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,license,open,close,get service(){return service;},saveTo:value=>{savePath=value;}};
}

async function setup(f){return f.service.call('setupOwner',OWNER);}
async function enableSearch(f){await f.service.call('saveSearchSettings',{settings:{enabled:true,monitoredGroupIds:['sim-01@simulation'],commandGroupIds:[],privateCommandsEnabled:true,commandPrivateNumbers:[]}});}

// Fresh or incorrectly wired production callers cannot silently bypass
// licensing. Licence configuration remains available without a local login.
test('backend missing licensing dependency fails closed without deleting data or denying licence status',async t=>{
  const f=await fixture(t,{missing:true});
  const prelogin=await f.service.call('licenseStatus');assert.equal(prelogin.allowed,false);assert.equal(prelogin.reasonCode,'LICENSE_SERVICE_UNAVAILABLE');
  assert.equal(f.service.snapshot().license.allowed,false);assert.deepEqual(f.service.snapshot().campaigns,[]);
  await assert.rejects(f.service.call('licenseActivate',{key:'FAKE-KEY'}),error=>error.code==='LICENSE_SERVICE_UNAVAILABLE');
  await setup(f);const draft=f.service.snapshot().campaigns[0];
  assert.equal(draft.state,'draft');assert.equal(f.service.snapshot().automation.stopped,true);
  await assert.rejects(f.service.call('activateCampaign',{id:draft.id,configRevision:draft.configRevision}),error=>error.code==='LICENSE_SERVICE_UNAVAILABLE');
  const template=await f.service.call('saveTemplate',{name:'Preservado apesar da licença',items:[{type:'text',text:'*Conteúdo real do cadastro*'}]});
  assert.equal((await f.service.call('getTemplate',{id:template.id})).name,template.name);
  await assert.rejects(f.service.call('resumeAutomation'),error=>error.code==='LICENSE_SERVICE_UNAVAILABLE');
});

test('expiration stops campaign and reminders, renewal never resumes them automatically, and the stop survives reopening',async t=>{
  const f=await fixture(t);await setup(f);const first=f.service.snapshot().campaigns[0];
  const campaign=await f.service.call('activateCampaign',{id:first.id,configRevision:first.configRevision});assert.equal(campaign.state,'active');
  const owner=f.service.snapshot().auth.user;
  const reminder=await f.service.call('saveReminder',{title:'Lembrete persistente',time:'23:59',repeat:'daily',recipientId:`user:${owner.id}`,enabled:true});assert.equal(reminder.state,'active');
  f.license.set({...expired,expiresAt:Date.now()-1});await f.service.systemCall('licenseChanged');
  let state=f.service.snapshot();assert.equal(state.license.autoResumeRequired,true);assert.equal(state.automation.stopped,true);assert.equal(state.campaigns[0].state,'stopped');assert.equal(state.reminders.items[0].state,'paused');
  await assert.rejects(f.service.call('activateReminder',{id:reminder.id}),error=>error.code==='LICENSE_EXPIRED');
  await assert.rejects(f.service.call('testAlert'),error=>error.code==='LICENSE_EXPIRED');
  await f.service.call('licenseActivate',{key:'ISOLATED-FIXTURE-KEY'});
  state=f.service.snapshot();assert.equal(state.license.allowed,true);assert.equal(state.license.autoResumeRequired,true);assert.equal(state.automation.stopped,true);assert.equal(state.campaigns[0].state,'stopped');
  await f.close();await f.open();await f.service.call('login',{username:OWNER.username,password:PASSWORD});
  state=f.service.snapshot();assert.equal(state.license.allowed,true);assert.equal(state.automation.stopped,true);assert.equal(state.license.autoResumeRequired,true);assert.equal(state.reminders.items[0].state,'paused');
  await f.service.call('resumeAutomation');state=f.service.snapshot();assert.equal(state.automation.stopped,false);assert.equal(state.license.autoResumeRequired,false);assert.equal(state.campaigns[0].state,'stopped');assert.equal(state.reminders.items[0].state,'paused');
  const latest=state.campaigns[0];await f.service.call('activateCampaign',{id:latest.id,configRevision:latest.configRevision});assert.equal(f.service.snapshot().campaigns[0].state,'active');
});

test('expired licence preserves contact, template, captured offers and allows permission-checked Excel and complete backup export',async t=>{
  const f=await fixture(t);await setup(f);await enableSearch(f);
  const contact=await f.service.call('saveContact',{name:'Cadastro preservado',phone:'5562999990003'});
  const model=await f.service.call('saveTemplate',{name:'Modelo salvo',items:[{type:'text',text:'Descrição salva com emoji 📱'}]});
  await f.service.call('testSearchSimulation',{kind:'offer',messageId:'ORIGINAL-PRESERVED',senderNumber:'5562999991111',supplierName:'Fornecedor declarado',groupId:'sim-01@simulation',text:'iPhone 15 Pro Max 256GB Azul seminovo R$ 3.850,00',timestamp:Date.now()-60000});
  const result=await f.service.call('runSearch',{query:'iPhone 15 Pro Max 256GB'});assert.equal(result.results.length,1);
  f.license.set({...expired,expiresAt:Date.now()-1});await f.service.systemCall('licenseChanged');
  const state=f.service.snapshot();assert.ok(state.contacts.some(item=>item.id===contact.id));assert.ok(state.templates.some(item=>item.id===model.id));assert.equal((await f.service.call('searchOffers',{limit:20})).total,1);
  await assert.rejects(f.service.call('runSearch',{query:'iPhone 15 Pro Max',deliver:true}),error=>error.code==='LICENSE_EXPIRED');
  const workbook=path.join(f.dir,'user-export.xlsx');f.saveTo(workbook);const exported=await f.service.call('searchExportExcel',{runId:result.runId,selection:'all'});assert.equal(exported.saved,true);assert.ok(fs.statSync(workbook).size>1000);
  const backup=path.join(f.dir,'user-backup.mega.json');f.saveTo(backup);await f.service.call('backup');assert.ok(fs.statSync(backup).size>100);
  const value=JSON.parse(fs.readFileSync(backup,'utf8'));assert.equal(JSON.stringify(value).includes('Cadastro preservado'),true);assert.equal(JSON.stringify(value).includes('Modelo salvo'),true);
  await f.service.call('logout');await assert.rejects(f.service.call('backup'),/login/i);await assert.rejects(f.service.call('searchExportExcel',{runId:result.runId,selection:'all'}),/login/i);
});

test('licence state published before login excludes keys, signed receipts and administrative credentials',async t=>{
  const license=createLicenseFixture({state:{key:'SECRET-KEY-MUST-NOT-LEAK',privateKey:'PRIVATE-KEY',adminToken:'ADMIN-SECRET',receipt:{token:'SIGNED-RECEIPT'}}});
  const f=await fixture(t,{license});const json=JSON.stringify(f.service.snapshot());
  assert.equal(json.includes('SECRET-KEY-MUST-NOT-LEAK'),false);assert.equal(json.includes('PRIVATE-KEY'),false);assert.equal(json.includes('ADMIN-SECRET'),false);assert.equal(json.includes('SIGNED-RECEIPT'),false);
  const before=await f.service.call('licenseStatus');assert.equal(before.allowed,true);assert.equal(before.plan,'trial');
});

test('licence restoration or mode switching cannot bypass required explicit automation resume',async t=>{
  const f=await fixture(t);await setup(f);f.license.set(expired);await f.service.systemCall('licenseChanged');
  f.license.set({allowed:true,status:'active',plan:'annual',expiresAt:Date.now()+365*86400000,reasonCode:null,reason:null});await f.service.systemCall('licenseChanged');
  await f.service.call('saveSettings',{settings:{integrationMode:'whatsapp',unofficialAcknowledged:true}});
  assert.equal(f.service.snapshot().automation.stopped,true);assert.equal(f.service.snapshot().license.autoResumeRequired,true);
  await f.service.call('saveSettings',{settings:{integrationMode:'simulated'}});assert.equal(f.service.snapshot().automation.stopped,true);
  await f.service.call('resumeAutomation');assert.equal(f.service.snapshot().automation.stopped,false);
});
