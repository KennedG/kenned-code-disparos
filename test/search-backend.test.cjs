'use strict';
const {createLicenseFixture}=require('./fixtures/license.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createAppService}=require('../src/backend/service.cjs');
const {createStore,seed}=require('../src/core/store.cjs');
const PASSWORD='Senha-Buscas-Teste-2026';
const OWNER={name:'Dono BUSCAS',username:'dono-buscas',phone:'5511999990001',password:PASSWORD};
const SEARCH_PERMISSIONS=['search.view','search.run','search.history','search.filters','search.manage'];
const searchGrants=Object.fromEntries(SEARCH_PERMISSIONS.map(permission=>[permission,true]));

async function fixture(t,{prepare}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-search-backend-'));
  if(prepare){const store=await createStore(dir);seed(store);await prepare(store);store.close();}
  const service=await createAppService({licenseService:createLicenseFixture(),dir,runtimePlatform:'linux',host:async()=>({canceled:true,nativeStatus:'unsupported',soundStatus:'disabled'})});
  t.after(async()=>{await service.shutdown();fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,service};
}
async function owner(service){return service.call('setupOwner',OWNER);}
async function ownerLogin(service){await service.call('logout');return service.call('login',{username:OWNER.username,password:PASSWORD});}
async function addUser(service,changes={}){
  return service.call('createUser',{user:{name:'Usuário BUSCAS',username:'usuario-buscas',phone:'5511999990002',password:PASSWORD,roleId:'role-admin',requirePasswordChange:false,...changes}});
}
async function enableSearch(service,settings={}){
  return service.call('saveSearchSettings',{settings:{enabled:true,monitoredGroupIds:['sim-01@simulation'],commandGroupIds:['sim-01@simulation'],privateCommandsEnabled:true,commandPrivateNumbers:[OWNER.phone],userRateLimit:{max:100,windowSeconds:60},...settings}});
}
async function offer(service,{text,groupId='sim-01@simulation',senderNumber='5511999990100',supplierName='Fornecedor fictício A',...rest}){
  return service.call('testSearchSimulation',{kind:'offer',text,groupId,senderNumber,supplierName,...rest});
}

test('BUSCAS upgrade preserves campaigns, settings and paused state; only owners automatically get search permissions',async t=>{
  let id;const {service}=await fixture(t,{prepare:store=>{store.setSetting('theme','light');const campaign=store.listCampaigns()[0];id=campaign.id;store.saveCampaign({...campaign,state:'paused'});}});
  const locked=service.snapshot();assert.equal(locked.auth.setupRequired,true);assert.equal(locked.buscas,undefined);
  await assert.rejects(service.call('searchMessages'),/login/i);
  const result=await owner(service),snapshot=service.snapshot();
  assert.equal(snapshot.settings.theme,'light');assert.equal(snapshot.campaigns[0].id,id);assert.equal(snapshot.campaigns[0].state,'paused');
  assert.equal(snapshot.buscas.authorized,true);assert.equal(snapshot.buscas.settings.enabled,false);
  for(const permission of SEARCH_PERMISSIONS)assert.ok(result.user.permissions.includes(permission));
  for(const roleId of ['role-admin','role-manager','role-seller']){
    const created=await addUser(service,{roleId,username:`user-${roleId}`,phone:''});
    for(const permission of SEARCH_PERMISSIONS)assert.equal(created.permissions.includes(permission),false,`${roleId} does not automatically receive ${permission}`);
  }
});

test('backend requires both account permission and explicit BUSCAS authorization; payload actor cannot impersonate owner',async t=>{
  const {service}=await fixture(t),first=await owner(service),ownerId=first.user.id;
  const delegated=await addUser(service,{permissionOverrides:searchGrants});
  await service.call('logout');await service.call('login',{username:delegated.username,password:PASSWORD});
  assert.equal((await service.call('searchesState')).authorized,false);
  await assert.rejects(service.call('runSearch',{query:'18 Pro Max Silver',actorId:ownerId,userId:ownerId}),/autoriz|permiss/i);
  await assert.rejects(service.call('searchMessages',{actorId:ownerId}),/autoriz|permiss/i);
  await assert.rejects(service.call('saveSearchSettings',{actorId:ownerId,settings:{enabled:true}}),/autoriz|permiss/i);
  await ownerLogin(service);
  const authorization=await service.call('saveSearchAuthorization',{authorization:{userId:delegated.id,enabled:true,permissions:['search','history']}});
  assert.ok(authorization.id);
  await service.call('logout');await service.call('login',{username:delegated.username,password:PASSWORD});
  const state=await service.call('searchesState');assert.equal(state.authorized,true);assert.equal(state.permissions.search,true);assert.equal(state.permissions.manage,false);
  await assert.rejects(service.call('saveSearchSettings',{settings:{enabled:true}}),/autoriz|permiss/i);
  await assert.rejects(service.call('testSearchSimulation',{kind:'offer',groupId:'sim-01@simulation',text:'iPhone 18 Pro Max 256GB Silver R$ 7000'}),/autoriz|permiss/i);
  await ownerLogin(service);await service.call('deleteSearchAuthorization',{id:authorization.id});
  await service.call('logout');await service.call('login',{username:delegated.username,password:PASSWORD});
  assert.equal((await service.call('searchesState')).authorized,false);
  await assert.rejects(service.call('runSearch',{query:'18 Pro Max Silver'}),/autoriz|permiss/i);
});

test('BUSCAS honors password-change gate and deactivated accounts even when grants exist',async t=>{
  const {service,dir}=await fixture(t);await owner(service);
  const temporary=await addUser(service,{requirePasswordChange:false,permissionOverrides:searchGrants});
  await service.call('saveSearchAuthorization',{authorization:{userId:temporary.id,enabled:true,permissions:['search','history','filters','manage']}});
  // The saved account is authoritative even if its password policy changes
  // after the module authorization was issued.
  const db=await createStore(dir);try{const saved=db.getEntity('users',temporary.id);db.saveEntity('users',{...saved,requirePasswordChange:true});}finally{db.close();}
  await service.call('logout');await service.call('login',{username:temporary.username,password:PASSWORD});
  assert.equal((await service.call('searchesState')).authorized,false);
  await assert.rejects(service.call('runSearch',{query:'iPhone 15'}),/autoriz|permiss|senha/i);
  await ownerLogin(service);await service.call('updateUser',{id:temporary.id,active:false});
  await assert.rejects(service.call('login',{username:temporary.username,password:PASSWORD}),/inválid|desativad/i);
});

test('simulated transport captures multi-product lists and ranks shorthand without confusing versions or financing',async t=>{
  const {service}=await fixture(t);await owner(service);await enableSearch(service);
  await offer(service,{messageId:'LISTA-A',text:'iPhone 18 ProMax 256GB Silver lacrado — R$ 7.000,00\niPhone 18 Pro 256GB Silver lacrado — R$ 2.000,00\niPhone 18 Pro Max 512GB Silver lacrado — R$ 8.000,00\nSamsung S24 Ultra 256GB Preto lacrado — R$ 3.000,00'});
  await offer(service,{messageId:'LISTA-B',senderNumber:'5511999990101',supplierName:'Fornecedor fictício B',text:'iPhone 18 Pro Max 256GB Prata lacrado R$ 6.500,00'});
  await offer(service,{messageId:'PARCELAS',senderNumber:'5511999990102',text:'iPhone 18 Pro Max 256GB Silver lacrado: entrada R$ 500 + 10x R$ 600'});
  const result=await service.call('runSearch',{query:'18 pro Max Silver'});
  assert.ok(result.count>=2);assert.ok(result.results.every(item=>item.modelKey==='iphone 18 pro max'));
  assert.deepEqual(result.results.map(item=>item.priceCents),[650000,700000,800000]);
  assert.equal(result.results.some(item=>item.messageId==='PARCELAS'),false);
  const precise=await service.call('runSearch',{query:'iPhone 18 Pro Max 256GB Silver lacrado'});
  assert.deepEqual(precise.results.map(item=>item.priceCents),[650000,700000]);
  const privateReply=await service.call('testSearchSimulation',{kind:'command',text:'!busca 18 pro Max Silver',isGroup:true,chatId:'sim-01@simulation'});
  assert.ok(privateReply.replies.length>0);assert.ok(privateReply.replies.every(item=>item.privateNumber===OWNER.phone));
  assert.ok(privateReply.replies.every(item=>item.status==='confirmed'&&item.simulation===true));
  assert.match(privateReply.replies.map(item=>item.text).join('\n'),/Valores conforme anúncios capturados/);
});

test('simulated command tests cannot forge actors; fixture text stays data; prefix and locations are enforced',async t=>{
  const {service}=await fixture(t);await owner(service);await enableSearch(service);
  await offer(service,{messageId:'DADOS-SEM-TELEFONE',senderNumber:'',text:'iPhone 18 Pro Max 256GB Silver lacrado R$ 7000'});
  const noPhone=await service.call('runSearch',{query:'18 Pro Max Silver'});assert.equal(noPhone.count,1);assert.equal(noPhone.results[0].supplierPhone,null);
  const before=(await service.call('searchHistory')).total;
  const fixtureCommand=await offer(service,{messageId:'FORGED-FIXTURE',senderNumber:OWNER.phone,text:'!busca 18 Pro Max Silver'});
  assert.deepEqual(fixtureCommand.replies,[]);assert.equal((await service.call('searchHistory')).total,before);
  await assert.rejects(service.call('testSearchSimulation',{kind:'command',senderNumber:'5511999990999',text:'!busca 18 Pro Max Silver'}),/vinculado/i);
  const blocked=await service.call('testSearchSimulation',{kind:'command',text:'!busca 18 Pro Max Silver',isGroup:true,chatId:'sim-02@simulation'});assert.deepEqual(blocked.replies,[]);
  const guidance=await service.call('testSearchSimulation',{kind:'command',text:'!BuScA'});assert.ok(guidance.replies.length);assert.match(guidance.replies.map(r=>r.text).join('\n'),/Use !busca iPhone/);
  await service.call('saveSearchSettings',{settings:{prefix:'!oferta'}});
  const old=await service.call('testSearchSimulation',{kind:'command',text:'!busca 18 Pro Max Silver'});assert.deepEqual(old.replies,[]);
  const updated=await service.call('testSearchSimulation',{kind:'command',text:'!OFERTA 18 pro Max Silver'});assert.ok(updated.replies.length);assert.ok(updated.replies.every(r=>r.privateNumber===OWNER.phone));
  assert.match(updated.replies.map(r=>r.text).join('\n'),/Número indisponível/);
});

test('latest supplier offer replaces older prices; edit and delete retain the original message reference',async t=>{
  const {service}=await fixture(t);await owner(service);await enableSearch(service);
  await offer(service,{messageId:'ANTIGA',timestamp:Date.now()-60000,text:'iPhone 18 Pro Max 256GB Silver lacrado R$ 6000'});
  await offer(service,{messageId:'NOVA',text:'iPhone 18 Pro Max 256GB Silver lacrado R$ 7000'});
  let result=await service.call('runSearch',{query:'18 Pro Max 256GB Silver lacrado'});assert.equal(result.count,1);assert.equal(result.results[0].messageId,'NOVA');assert.equal(result.results[0].priceCents,700000);
  const originalAt=result.results[0].originalAt;
  await service.call('testSearchSimulation',{kind:'edit',messageId:'NOVA',groupId:'sim-01@simulation',senderNumber:'5511999990100',text:'iPhone 18 Pro Max 256GB Silver lacrado R$ 6900'});
  result=await service.call('runSearch',{query:'18 Pro Max 256GB Silver lacrado'});assert.equal(result.count,1);assert.equal(result.results[0].priceCents,690000);assert.equal(result.results[0].originalAt,originalAt);
  await service.call('testSearchSimulation',{kind:'delete',messageId:'NOVA',groupId:'sim-01@simulation',senderNumber:'5511999990100'});
  result=await service.call('runSearch',{query:'18 Pro Max 256GB Silver lacrado'});assert.equal(result.results.some(item=>item.messageId==='NOVA'),false);
  const messages=await service.call('searchMessages',{includeDeleted:true});assert.ok(messages.items.some(item=>item.messageId==='NOVA'&&item.deletedAt));
});

test('separate BUSCAS cleanup preserves campaigns, users, settings and operational delivery protection',async t=>{
  const {service,dir}=await fixture(t);await owner(service);await enableSearch(service);
  const legacy=service.snapshot().campaigns[0];
  await offer(service,{messageId:'LIMPEZA',text:'iPhone 18 Pro Max 256GB Silver lacrado R$ 7000'});
  await service.call('testSearchSimulation',{kind:'command',text:'!busca 18 Pro Max Silver'});
  const historyPreview=await service.call('searchCleanupPreview',{scope:'history'});
  await assert.rejects(service.call('clearSearchHistory',{token:historyPreview.token,confirmation:'apagar'}),/APAGAR/);
  await service.call('clearSearchHistory',{token:historyPreview.token,confirmation:'APAGAR'});
  assert.equal((await service.call('searchHistory')).total,0);assert.equal((await service.call('searchMessages')).total,1);
  const basePreview=await service.call('searchCleanupPreview',{scope:'base'});await service.call('clearSearchBase',{token:basePreview.token,confirmation:'APAGAR'});
  assert.equal((await service.call('searchMessages')).total,0);assert.equal((await service.call('searchOffers')).total,0);
  const snapshot=service.snapshot();assert.equal(snapshot.campaigns[0].id,legacy.id);assert.equal(snapshot.campaigns[0].state,legacy.state);assert.equal(snapshot.auth.user.username,OWNER.username);assert.equal(snapshot.buscas.settings.prefix,'!busca');assert.equal(snapshot.buscas.settings.enabled,true);
  const db=await createStore(dir);try{assert.ok(db.listSearchRuns({limit:10}).total>=1);assert.ok(db.listSearchDeliveries({limit:10}).items.some(item=>item.status==='confirmed'));assert.ok(db.listEntities('audit').some(item=>item.action==='buscas.base.clear'));}finally{db.close();}
});

test('disconnect warns about stale capture and keeps private delivery pending until simulated reconnect',async t=>{
  const {service,dir}=await fixture(t);await owner(service);await enableSearch(service);
  await offer(service,{text:'iPhone 18 Pro Max 256GB Silver lacrado R$ 7000'});
  await service.call('testSearchSimulation',{kind:'disconnect'});
  const stale=await service.call('runSearch',{query:'18 Pro Max Silver',deliver:true});
  assert.equal(stale.stale,true);assert.ok(stale.warnings.some(warning=>/desatualizada|interrompida/.test(warning)));
  assert.equal(stale.delivery.length,1);assert.equal(stale.delivery[0].status,'pending');assert.equal(stale.delivery[0].target,`${OWNER.phone}@s.whatsapp.net`);
  assert.equal(service.snapshot().buscas.monitor.connection,'disconnected');
  await service.call('connect');await service.call('testSearchSimulation',{messages:[]});
  const db=await createStore(dir);try{const deliveries=db.listSearchDeliveries({runId:stale.runId}).items;assert.equal(deliveries.length,1);assert.equal(deliveries[0].status,'confirmed');assert.ok(db.listSearchGaps({limit:20}).items.some(gap=>gap.reason==='unexpected'&&gap.endedAt));}finally{db.close();}
  await service.call('saveSearchSettings',{settings:{importHistory:true}});
  const historyCapability=await service.call('importSearchHistory');assert.equal(historyCapability.complete,false);assert.equal(historyCapability.supported,false);
});
