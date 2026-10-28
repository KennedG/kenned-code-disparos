'use strict';
const {createLicenseFixture}=require('./fixtures/license.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {createStore,seed}=require('../src/core/store.cjs');
const {createAppService}=require('../src/backend/service.cjs');
async function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kenned-mode-')),stores=[];t.after(()=>{for(const s of stores)s.close();fs.rmSync(dir,{recursive:true,force:true});});const open=async()=>{const s=await createStore(dir);stores.push(s);return s;};return{dir,open,store:await open()};}
const phone='5511999990001';
const campaign=(id,groupId)=>({id,name:'Cadastro legítimo: Mega Celulares',state:'draft',mode:'repeat',intervalMinutes:10,spacingSeconds:3,schedule:{days:[0,1,2,3,4,5,6],startTime:'00:00',endTime:'00:00'},groupIds:[groupId],items:[{id:'i-'+id,type:'text',text:'*Mega Celulares* — conteúdo legítimo sem substituição.'}],groupOverrides:{},roundIndex:0,nextRunAt:null});

test('real and simulation data, settings, metrics and pending outbound queues remain separated across restarts',async t=>{
  const {store:s,open}=await fixture(t);seed(s);const simulated=s.listCampaigns()[0];
  s.saveEntity('users',{id:'owner',name:'Dono real',active:true,phone});s.saveEntity('roles',{id:'owner-role',isOwner:true});
  s.saveEntity('contacts',{id:'sim-contact',name:'Contato fictício',phone});s.saveMedia({id:'sim-media',name:'Arquivo fictício.pdf'});s.saveTemplate({id:'sim-template',name:'Modelo fictício',items:[]});s.saveAlertRecipient({id:'sim-recipient',name:'Responsável fictício',phone,enabled:true});
  s.insertRound({id:'sim-round',campaignId:simulated.id,startedAt:Date.now(),finishedAt:Date.now(),status:'finished'});s.insertJob({id:'sim-job',campaignId:simulated.id,roundId:'sim-round',groupId:simulated.groupIds[0],itemId:simulated.items[0].id,status:'confirmed',attempts:1,createdAt:Date.now(),messageId:'SIM-CONFIRMED'});
  s.saveAlert({id:'sim-alert',status:'pending',channel:'whatsapp',phone});s.setSetting('buscasSettings',{enabled:true,monitoredGroupIds:simulated.groupIds});s.setSetting('systemAlertRecipientIds',['sim-recipient']);
  assert.equal(s.getMetrics().confirmed,1);assert.equal(s.listPendingAlerts().length,1);
  s.setSetting('integrationMode','whatsapp');
  for(const key of ['listCampaigns','listGroups','listMedia','listTemplates','listAlerts','listAlertRecipients'])assert.deepEqual(s[key](),[],key+' must hide simulated data');
  assert.equal(s.getCampaign(simulated.id),undefined);assert.equal(s.getMetrics().confirmed,0);assert.equal(s.listHistory().total,0);assert.equal(s.getSetting('buscasSettings'),undefined);assert.equal(s.getSetting('systemAlertRecipientIds'),undefined);assert.equal(s.getEntity('users','owner').name,'Dono real');assert.equal(s.getEntity('roles','owner-role').isOwner,true);
  s.upsertGroups([{id:'real@g.us',name:'Grupo de exemplo 01',authorized:true,simulation:false}]);s.saveCampaign(campaign('real-campaign','real@g.us'));s.saveEntity('contacts',{id:'real-contact',name:'Grupo simulado é apenas o nome legítimo',phone});s.saveAlert({id:'real-alert',status:'pending',channel:'whatsapp',phone});s.setSetting('buscasSettings',{enabled:false});
  assert.throws(()=>s.saveCampaign({...simulated,state:'active'}),/outro modo/);assert.throws(()=>s.upsertGroups([{id:'wrong@simulation',name:'Não aceitar',simulation:true}]),/outro modo/);
  s.setSetting('integrationMode','simulated');assert.equal(s.listCampaigns().length,1);assert.equal(s.getSetting('buscasSettings').enabled,true);assert.equal(s.listEntities('contacts')[0].id,'sim-contact');assert.equal(s.getCampaign('real-campaign'),undefined);s.clearHistory({actor:'owner'});
  s.setSetting('integrationMode','whatsapp');assert.ok(s.listHistory().total>0);assert.equal(s.getCampaign('real-campaign').items[0].text,'*Mega Celulares* — conteúdo legítimo sem substituição.');assert.deepEqual(s.listPendingAlerts().map(a=>a.id),['real-alert']);
  s.close();const reopened=await open();assert.equal(reopened.getStorageMode(),'whatsapp');assert.deepEqual(reopened.listGroups().map(g=>g.id),['real@g.us']);assert.equal(reopened.getSetting('buscasSettings').enabled,false);reopened.setSetting('integrationMode','simulated');assert.equal(reopened.getMetrics().confirmed,1);assert.equal(reopened.listHistory().total,0);
});

test('group synchronization can hide an unavailable list without deleting saved publishing authorization',async t=>{
  const {store:s}=await fixture(t);s.upsertGroups([{id:'actual@g.us',name:'Grupo real',authorized:true,simulation:false}]);
  s.clearGroups();assert.deepEqual(s.listGroups(),[]);assert.equal(s.getGroup('actual@g.us'),undefined);
  s.replaceGroups([{id:'actual@g.us',name:'Nome atualizado',authorized:false,simulation:false}]);assert.equal(s.getGroup('actual@g.us').authorized,true);assert.equal(s.getGroup('actual@g.us').name,'Nome atualizado');
});

test('automation IDs remain detectable after history cleanup, mode changes and application restart',async t=>{
  const {store:s,open}=await fixture(t);s.registerOutboundMessageId('AUTOMATED',{kind:'search'});assert.equal(s.registerOutboundMessageId('AUTOMATED').changes,0);s.setSetting('integrationMode','simulated');s.insertRound({id:'round',campaignId:'c',startedAt:Date.now()});s.insertJob({id:'job',roundId:'round',campaignId:'c',groupId:'sim@simulation',itemId:'item',status:'confirmed',attempts:1,createdAt:Date.now(),messageId:'JOB-AUTOMATED'});s.saveAlert({id:'alert',status:'confirmed',messageId:'ALERT-AUTOMATED'});s.clearHistory({actor:'owner'});s.setSetting('integrationMode','whatsapp');
  for(const id of ['AUTOMATED','JOB-AUTOMATED','ALERT-AUTOMATED'])assert.equal(s.isOutboundMessageId(id),true);assert.equal(s.isOutboundMessageId('MANUAL-COMMAND'),false);s.close();const next=await open();assert.equal(next.isOutboundMessageId('AUTOMATED'),true);
});

test('legacy migration identifies explicit simulated destinations while preserving real lookalikes and quarantining ambiguous pending sends',async t=>{
  const {store:s,dir,open}=await fixture(t);seed(s);const sim=s.listCampaigns()[0];s.saveAlert({id:'unknown-old-alert',status:'pending',channel:'whatsapp',phone});s.setSetting('integrationMode','whatsapp');s.upsertGroups([{id:'legitimate@g.us',name:'Grupo de exemplo 01',authorized:true,simulation:false}]);s.saveCampaign({...campaign('legitimate','legitimate@g.us'),name:'Exemplo • 15 grupos a cada 10 minutos'});s.setSetting('integrationMode','simulated');s.close();
  const db=new DatabaseSync(path.join(dir,'mega.sqlite'));
  for(const table of ['campaigns','groups_data','alerts'])for(const row of db.prepare(`SELECT id,data FROM ${table}`).all()){const v=JSON.parse(row.data);delete v.storageMode;db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(v),row.id);}
  db.prepare('INSERT INTO settings(id,data) VALUES(?,?)').run('buscasSettings',JSON.stringify({id:'buscasSettings',value:{enabled:true,monitoredGroupIds:sim.groupIds}}));db.exec('PRAGMA user_version=5');db.close();
  const migrated=await open();assert.equal(migrated.listCampaigns()[0].id,sim.id);assert.equal(migrated.getSetting('buscasSettings').enabled,true);assert.equal(migrated.getAlert('unknown-old-alert'),undefined);
  migrated.setSetting('integrationMode','whatsapp');assert.equal(migrated.getCampaign('legitimate').name,'Exemplo • 15 grupos a cada 10 minutos');assert.equal(migrated.getGroup('legitimate@g.us').authorized,true);const old=migrated.getAlert('unknown-old-alert');assert.equal(old.status,'uncertain');assert.equal(old.code,'MIGRATION_MODE_REVIEW');assert.equal(old.retryEligible,false);assert.equal(migrated.listPendingAlerts().length,0);assert.equal(migrated.getSetting('buscasSettings'),undefined);
});

test('backend mode switching removes all fictitious screens and selectors and keeps legitimate users and real registrations',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kenned-backend-mode-'));const service=await createAppService({licenseService:createLicenseFixture(),dir,runtimePlatform:'linux',host:async()=>({canceled:true,nativeStatus:'unsupported',soundStatus:'disabled'})});t.after(async()=>{await service.shutdown();fs.rmSync(dir,{recursive:true,force:true});});
  await service.call('setupOwner',{name:'Dono',username:'dono',password:'Senha-Segura-Teste-2026',phone});const simulation=service.snapshot();assert.equal(simulation.storageMode,'simulated');assert.equal(simulation.groups.length,15);
  await service.call('saveContact',{name:'Contato criado na simulação',phone});await service.call('saveAlertRecipient',{name:'Fictício',phone});
  await service.call('saveSettings',{settings:{integrationMode:'whatsapp',unofficialAcknowledged:true}});const real=service.snapshot();assert.equal(real.storageMode,'whatsapp');assert.deepEqual(real.groups,[]);assert.deepEqual(real.campaigns,[]);assert.deepEqual(real.contacts,[]);assert.deepEqual(real.alertRecipients,[]);assert.equal(real.metrics.confirmed,0);assert.equal(real.auth.user.name,'Dono');assert.equal(real.buscas.groups.length,0);
  await service.call('saveContact',{name:'Mega Celulares',phone});await service.call('saveSettings',{settings:{integrationMode:'simulated'}});const back=service.snapshot();assert.equal(back.groups.length,15);assert.equal(back.contacts.length,1);assert.equal(back.contacts[0].name,'Contato criado na simulação');assert.equal(back.metrics.activeCampaigns,0);
  await service.call('saveSettings',{settings:{integrationMode:'whatsapp'}});assert.equal(service.snapshot().contacts[0].name,'Mega Celulares');
});
