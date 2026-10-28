'use strict';
const {createLicenseFixture}=require('./fixtures/license.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {createAppService,validateSound,validateCategories}=require('../src/backend/service.cjs');
const {createStore,seed}=require('../src/core/store.cjs');
const {MediaManager}=require('../src/core/media.cjs');
const PASSWORD='Senha-Segura-Teste-2026';
const OWNER={name:'Dono de teste',username:'dono',password:PASSWORD,phone:'5511999990001'};

async function fixture(t,{prepare,host}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-backend-'));let service;
  if(prepare){const store=await createStore(dir);seed(store);await prepare(store);store.close();}
  const native=[];service=await createAppService({licenseService:createLicenseFixture(),dir,runtimePlatform:'linux',host:async(action,payload)=>{native.push({action,payload});return host?host(action,payload):{canceled:true,nativeStatus:'unsupported',soundStatus:'disabled'};}});
  t.after(async()=>{await service.shutdown();fs.rmSync(dir,{recursive:true,force:true});});
  return {service,dir,native};
}
async function owner(service){return service.call('setupOwner',OWNER);}

test('upgrade keeps existing campaigns and the first owner adopts them; no unauthenticated data or mutation',async t=>{
  const {service}=await fixture(t);const before=service.snapshot();assert.equal(before.auth.setupRequired,true);assert.deepEqual(before.campaigns,[]);assert.equal(before.connection,null);
  await assert.rejects(service.call('stopAll'),/login/i);await assert.rejects(service.call('systemCall',{action:'emergencyStop'}),/não autorizada/i);
  const result=await owner(service),s=service.snapshot();assert.equal(s.campaigns.length,1);assert.equal(s.campaigns[0].groupIds.length,15);assert.equal(s.campaigns[0].state,'draft');assert.equal(s.campaigns[0].ownerId,result.user.id);assert.equal(s.metrics.confirmed,0);
  await assert.rejects(service.call('setupOwner',OWNER),/já foi cadastrado/i);await service.call('logout');assert.equal(service.snapshot().auth.authenticated,false);assert.equal(service.snapshot().campaigns.length,0);
  await service.call('login',{username:OWNER.username,password:PASSWORD});assert.equal(service.snapshot().campaigns.length,1);assert.equal(JSON.stringify(service.snapshot()).includes('passwordHash'),false);
});

test('backend enforces own campaign scope, denied settings and media paths, and last owner protection',async t=>{
  let mediaId;const {service}=await fixture(t,{prepare:async store=>{mediaId=(await new MediaManager(store).importBuffer(Buffer.from('simulated PDF bytes'),{name:'documento.pdf'})).id;}});
  await owner(service);const existing=service.snapshot().campaigns[0];await assert.rejects(service.call('deleteUser',{id:service.snapshot().auth.user.id}),/último dono/i);
  const seller=await service.call('createUser',{user:{name:'Vendedor',username:'vendedor',password:PASSWORD,phone:'5511999990002',roleId:'role-seller',requirePasswordChange:false,permissionOverrides:{'media.view':false}}});
  await service.call('logout');await service.call('login',{username:'vendedor',password:PASSWORD});assert.equal(service.snapshot().campaigns.length,0);assert.equal(service.snapshot().media.length,0);assert.equal(service.snapshot().metrics.confirmed,0);
  await assert.rejects(service.call('previewCampaign',{id:existing.id}),/permissão/i);await assert.rejects(service.call('pauseCampaign',{id:existing.id}),/permissão/i);await assert.rejects(service.call('saveSettings',{settings:{theme:'light'}}),/permissão/i);await assert.rejects(service.call('mediaPath',{id:mediaId}),/permissão/i);await assert.rejects(service.call('listUsers'),/permissão/i);
  const saved=await service.call('saveCampaign',{campaign:{...existing,id:undefined,name:'Campanha do vendedor',ownerId:seller.id,revision:undefined,configRevision:undefined,groupIds:[existing.groupIds[0]],items:[{type:'text',text:'Olá'}]}});assert.equal(saved.ownerId,seller.id);assert.equal(saved.state,'draft');assert.equal(service.snapshot().campaigns.length,1);
  await assert.rejects(service.call('saveCampaign',{campaign:{...saved,ownerId:'outro'}}),/propriedade/i);await assert.rejects(service.call('cleanupPreview',{categories:['sends']}),/permissão/i);
});

test('history deletion requires preview and typed confirmation; confirmed and uncertain operational jobs remain reviewable',async t=>{
  let campaignId,confirmedId,uncertainId;
  const {service,dir}=await fixture(t,{prepare:store=>{const c=store.listCampaigns()[0];campaignId=c.id;const roundId=randomUUID();store.insertRound({id:roundId,campaignId,startedAt:Date.now(),finishedAt:Date.now(),status:'uncertain'});confirmedId=randomUUID();uncertainId=randomUUID();for(const [id,status] of [[confirmedId,'confirmed'],[uncertainId,'uncertain']])store.insertJob({id,roundId,campaignId,groupId:c.groupIds[0],itemId:randomUUID(),itemSnapshot:c.items[0],createdAt:Date.now(),status,attempts:1,messageId:randomUUID()});}});
  await owner(service);await assert.rejects(service.call('deleteCampaign',{id:campaignId}),/Revise os envios incertos/);assert.equal(service.snapshot().campaigns[0].id,campaignId,'The campaign must remain available for reviewing uncertain jobs');const page=await service.call('historyPage',{categories:['sends'],limit:1,offset:0});assert.equal(page.total,2);assert.equal(page.items.length,1);
  const preview=await service.call('cleanupPreview',{categories:['sends','campaigns']});assert.equal(typeof preview.counts.sends,'number');assert.equal(preview.counts.sends,2);assert.equal(preview.protected,true);
  await assert.rejects(service.call('clearHistory',{categories:preview.categories,token:preview.token,confirmation:'apagar'}),/APAGAR/);
  await service.call('clearHistory',{categories:preview.categories,token:preview.token,confirmation:'APAGAR'});assert.equal((await service.call('historyPage',{categories:['sends']})).total,0);assert.equal(service.snapshot().metrics.confirmed,1);assert.equal(service.snapshot().metrics.uncertain,1);assert.equal((await service.call('pendingReviewsPage')).items[0].id,uncertainId);
  await service.call('reviewJob',{id:uncertainId,decision:'discard'});assert.equal((await service.call('pendingReviewsPage')).total,0);
  const db=await createStore(dir);try{assert.equal(db.getJob(confirmedId).status,'confirmed');assert.equal(db.getCampaign(campaignId).state,'draft');assert.ok(db.listEntities('audit').some(a=>a.action==='history.clear'));}finally{db.close();}
  assert.equal(await service.call('deleteCampaign',{id:campaignId}),true);assert.equal(service.snapshot().metrics.confirmed,1,'Campaign deletion preserves the confirmed operational ledger');
});

test('native notification results are persisted truthfully and disconnection works while the GUI is logged out',async t=>{
  const {service,native}=await fixture(t,{host:async(action)=>action==='localAlert'?{nativeStatus:'requested',soundStatus:'scheduled'}:{canceled:true}});await owner(service);await service.call('logout');await service.systemCall('networkState',{online:false});
  await new Promise(resolve=>setTimeout(resolve,30));const notification=native.find(n=>n.action==='localAlert');assert.ok(notification);assert.equal(notification.payload.event,'disconnect');assert.equal(notification.payload.nativeEnabled,true);assert.equal(notification.payload.soundPreferences.volume,65);
  await service.systemCall('nativeNotificationResult',{id:notification.payload.id,status:'shown'});await service.call('login',{username:OWNER.username,password:PASSWORD});const s=service.snapshot();assert.equal(s.connection.reasonCode,'internet');assert.ok(s.notifications.some(n=>n.id===notification.payload.id&&n.nativeStatus==='shown'));
  await service.systemCall('networkState',{online:true});await service.call('connect');assert.equal(service.snapshot().connection.state,'connected');assert.equal(service.snapshot().metrics.confirmed,0);
});

test('history export uses native save selection and never contains password hashes or recovery codes',async t=>{
  const destination=path.join(os.tmpdir(),`mega-history-${randomUUID()}.json`);t.after(()=>fs.rmSync(destination,{force:true}));
  const {service}=await fixture(t,{host:async action=>action==='showSaveDialog'?{canceled:false,filePath:destination}:{canceled:true}});await owner(service);const exported=await service.call('exportHistory',{categories:['campaigns']});assert.ok(exported.count>=1);const data=fs.readFileSync(destination,'utf8');assert.equal(data.includes('passwordHash'),false);assert.equal(data.includes('recoveryCodes'),false);assert.equal(data.includes(PASSWORD),false);
});

test('sound preferences reject invalid values and the test passes exact configured volume to the native host',async t=>{
  const {service,native}=await fixture(t);await owner(service);await service.call('saveSettings',{settings:{sound:{enabled:true,volume:0,sound:'urgent',events:['critical'],repeat:false,intervalSeconds:30,maxRepeats:1,quiet:{enabled:false,start:'22:00',end:'08:00'}}}});await service.call('testSound');assert.equal(native.find(n=>n.action==='testSound').payload.preferences.volume,0);
  assert.throws(()=>validateSound({volume:101}),/Volume/);assert.throws(()=>validateSound({quiet:{start:'30:00'}}),/horários/i);assert.throws(()=>validateCategories(['credentials']),/categorias/i);
  await assert.rejects(service.call('saveSettings',{settings:{webhook:{enabled:true,url:'http://example.test'}}}),/HTTPS/);
});

test('own-scope settings editors cannot change the shared integration, backup foreign data or replace all campaigns',async t=>{
  const {service,native}=await fixture(t);await owner(service);
  const limited=await service.call('createUser',{user:{name:'Editor restrito',username:'editor-restrito',password:PASSWORD,roleId:'role-seller',campaignScope:'own',requirePasswordChange:false,permissionOverrides:{'settings.view':true,'settings.edit':true,'connection.manage':true,'campaign.stop':true,'notifications.manage':true}}});
  const originalCampaign=service.snapshot().campaigns[0];
  await service.call('logout');await service.call('login',{username:limited.username,password:PASSWORD});
  // Non-destructive display/sound preferences remain available to this editor.
  await service.call('saveSettings',{settings:{theme:'light'}});assert.equal(service.snapshot().settings.theme,'light');
  const before=native.length;
  await assert.rejects(service.call('saveSettings',{settings:{integrationMode:'whatsapp',unofficialAcknowledged:true}}),/todas as campanhas/i);
  await assert.rejects(service.call('backup'),/todas as campanhas/i);
  await assert.rejects(service.call('restore'),/todas as campanhas/i);
  await assert.rejects(service.call('saveSettings',{settings:{webhook:{enabled:true,url:'https://alerts.example.test/secret-path'},webhookToken:'not-a-real-token'}}),/todas as campanhas/i);
  assert.equal(native.length,before,'denied operations must not open dialogs or write protected channel secrets');
  assert.equal(service.snapshot().settings.integrationMode,'simulated');
  await service.call('logout');await service.call('login',{username:OWNER.username,password:PASSWORD});
  assert.equal(service.snapshot().campaigns.find(c=>c.id===originalCampaign.id).state,'draft');
  assert.equal(service.snapshot().settings.unofficialAcknowledged,false,'a denied integration change must not partially save its settings');
});

test('global campaign visibility alone does not authorize connection changes, complete backups or restore',async t=>{
  const {service,native}=await fixture(t);await owner(service);
  const reader=await service.call('createUser',{user:{name:'Editor sem manutenção',username:'editor-global',password:PASSWORD,roleId:'role-seller',campaignScope:'all',requirePasswordChange:false,permissionOverrides:{'settings.view':true,'settings.edit':true,'media.view':false,'connection.manage':false}}});
  await service.call('logout');await service.call('login',{username:reader.username,password:PASSWORD});
  assert.equal(service.snapshot().campaigns.length,1);const before=native.length;
  await assert.rejects(service.call('saveSettings',{settings:{integrationMode:'whatsapp',unofficialAcknowledged:true}}),/permissão/i);
  await assert.rejects(service.call('backup'),/permissão/i);await assert.rejects(service.call('restore'),/permissão/i);
  assert.equal(native.length,before);assert.equal(service.snapshot().settings.integrationMode,'simulated');
});

test('owner metrics survive display settings, rejected commands and logout without exposing totals to sellers',async t=>{
  let campaignId;const {service}=await fixture(t,{prepare:store=>{const c=store.listCampaigns()[0];campaignId=c.id;const roundId=randomUUID();store.insertRound({id:roundId,campaignId,startedAt:Date.now(),finishedAt:Date.now(),status:'confirmed'});for(let i=0;i<2;i++)store.insertJob({id:randomUUID(),roundId,campaignId,groupId:c.groupIds[i],itemId:randomUUID(),itemSnapshot:c.items[0],createdAt:Date.now(),status:'confirmed',attempts:1,messageId:randomUUID()});}});
  await owner(service);assert.equal(service.snapshot().metrics.confirmed,2);
  await service.call('saveSettings',{settings:{theme:'light',sound:{volume:37}}});
  await assert.rejects(service.call('testSimulation',{senderNumber:'5511999999999',text:'!mega status'}),/vinculado/i);
  assert.equal(service.snapshot().metrics.confirmed,2);
  const seller=await service.call('createUser',{user:{name:'Vendedor isolado',username:'vendedor-metricas',password:PASSWORD,roleId:'role-seller',requirePasswordChange:false}});
  await service.call('logout');assert.equal(service.snapshot().metrics.confirmed,0);assert.equal(service.snapshot().connection,null);
  const internal=await service.systemCall('settings');assert.equal(internal.sound.volume,37,'native preferences must remain readable with no logged-in identity');
  await service.call('login',{username:seller.username,password:PASSWORD});assert.equal(service.snapshot().metrics.confirmed,0);assert.equal(service.snapshot().campaigns.length,0);
  await service.call('logout');await service.call('login',{username:OWNER.username,password:PASSWORD});assert.equal(service.snapshot().metrics.confirmed,2);
});
