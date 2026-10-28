'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createAppService}=require('../src/backend/service.cjs');
const {createStore}=require('../src/core/store.cjs');
const {DatabaseSync}=require('node:sqlite');
const PASSWORD='Senha-Teste-Nucleo-Comercial-300!';
async function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kenned-business-backend-'));let service,clock=Date.parse('2026-10-05T15:00:00Z');
  const open=async()=>service=await createAppService({dir,now:()=>clock,runtimePlatform:'linux',host:async()=>({canceled:true})});
  await open();const owner=(await service.call('setupOwner',{name:'Dono teste',username:'owner300',password:PASSWORD,phone:'5562999990300'})).user;
  t.after(async()=>{await service?.shutdown();fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,owner,get s(){return service;},get clock(){return clock;},advance(ms){clock+=ms;},async reopen(){await service.shutdown();await open();await service.call('login',{username:'owner300',password:PASSWORD});}};
}
const stock=(s,extra={})=>s.call('saveInventory',{model:'iPhone 15 Pro Max',storage:'256GB',color:'Azul',condition:'seminovo',kind:'device',costCents:200000,retailCents:350000,wholesaleCents:320000,...extra});
test('backend sale idempotency and financial permission gates preserve stock and hide private costs from seller/manager',async t=>{
  const f=await fixture(t),item=await stock(f.s),input={inventoryId:item.id,audience:'retail',buyerName:'Teste',unitPriceCents:350000,discountCents:10000,feesCents:6000,directExpensesCents:4000,payments:[{method:'pix',amountCents:340000}],idempotencyKey:'one-sale'};
  const sale=await f.s.call('createSale',input),same=await f.s.call('createSale',input);assert.equal(sale.id,same.id);assert.equal(f.s.snapshot().commerce.sales.length,1);assert.equal(sale.netCents,330000);assert.equal(sale.realizedProfitCents,130000);
  await assert.rejects(f.s.call('createSale',{...input,unitPriceCents:360000}),{code:'IDEMPOTENCY_CONFLICT'});
  const seller=await f.s.call('createUser',{name:'Vendedor teste',username:'seller300',password:PASSWORD,roleId:'role-seller',requirePasswordChange:false,phone:'5562999990301'});
  await f.s.call('logout');await f.s.call('login',{username:'seller300',password:PASSWORD});
  assert.deepEqual(f.s.snapshot().commerce.sales,[]);assert.deepEqual(f.s.snapshot().commerce.cashMovements,[]);
  for(const [action,payload]of [['getDailyReport',{date:'2026-10-05'}],['createSale',input],['getCommercialReport',{from:'2026-10-05',to:'2026-10-05'}],['saveInventory',{...item,costCents:1}],['generateDailyReport',{deliver:true}],['backupBusinessData',{}]])await assert.rejects(f.s.call(action,payload));
  await f.s.call('logout');await f.s.call('login',{username:'owner300',password:PASSWORD});
  await f.s.call('createUser',{name:'Responsável teste',username:'manager300',password:PASSWORD,roleId:'role-manager',requirePasswordChange:false});
  await f.s.call('logout');await f.s.call('login',{username:'manager300',password:PASSWORD});
  const publicStock=f.s.snapshot().commerce.inventory[0];assert(publicStock);for(const field of ['costCents','costBasisTotalCents','supplierId','imei','serial','notes'])assert.equal(publicStock[field],undefined);assert.deepEqual(f.s.snapshot().commerce.sales,[]);
});
test('backend commercial draft protects audience, manages private consent, and saved stock templates keep availability provenance',async t=>{
  const f=await fixture(t),item=await stock(f.s),buyer=await f.s.call('saveContact',{name:'Comprador',phone:'5562999990310',categories:['Cliente Nerópolis','Lojista Camelódromo'],promotionalConsent:true});
  const list=await f.s.call('saveCommercialList',{name:'Tabela teste',audience:'retail',lines:[{sourceType:'inventory',sourceId:item.id,markup:{type:'percent',basisPoints:1000}}]});
  assert.equal(list.lines[0].priceCents,220000);const preview=await f.s.call('previewCommercialList',{id:list.id});assert.match(preview.text,/2\.200,00/);assert.doesNotMatch(preview.text,/custo|lucro|margem|IMEI/i);
  const campaign=await f.s.call('createCommercialCampaign',{listId:list.id,contactIds:[buyer.id],groupIds:[],schedule:{days:[0,1,2,3,4,5,6],startTime:'00:00',endTime:'00:00'}});assert.equal(campaign.state,'draft');assert.deepEqual(campaign.inventoryIds,[item.id]);
  const model=await f.s.call('saveTemplate',{name:'Modelo de estoque',items:campaign.items});assert.deepEqual(model.inventoryIds,[item.id]);
  const applied=await f.s.call('templateItems',{id:model.id}),second=await f.s.call('saveCampaign',{campaign:{name:'Modelo aplicado',mode:'repeat',intervalMinutes:10,spacingSeconds:3,schedule:{days:[0,1,2,3,4,5,6],startTime:'00:00',endTime:'00:00'},groupIds:[],contactIds:[buyer.id],items:applied.items}});assert.equal(second.items[0].commercialRef.listId,list.id);assert.deepEqual(second.inventoryIds,[item.id]);assert.equal(second.audience,'retail');
  await f.s.call('createSale',{inventoryId:item.id,audience:'retail',buyerName:'Comprador',payments:[],idempotencyKey:'sold-template'});
  const latest=f.s.snapshot().campaigns.find(c=>c.id===second.id);assert(latest.commercialReviewRequired);await f.s.call('activateCampaign',{id:latest.id,configRevision:latest.configRevision,summaryState:latest.state}).catch(()=>{});
  await new Promise(resolve=>setTimeout(resolve,1100));const state=f.s.snapshot().campaigns.find(c=>c.id===second.id);assert.notEqual(state.state,'active');
  await f.reopen();const persisted=await f.s.call('getTemplate',{id:model.id});assert.equal(persisted.items[0].commercialRef.listId,list.id);assert.equal(f.s.snapshot().commerce.sales.length,1);
});
test('schema upgrade takes recoverable pre-migration SQLite backup and local full snapshot preserves financial ledgers',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kenned-migration-business-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let store=await createStore(dir);store.setSetting('integrationMode','whatsapp');store.saveEntity('contacts',{id:'real',phone:'5562999990999',name:'Nome legítimo',categories:['Fornecedor']});store.saveEntity('sales',{id:'sale-original',totalCents:12345,createdAt:1});store.close();
  let raw=new DatabaseSync(path.join(dir,'mega.sqlite'));raw.exec('PRAGMA user_version=7');raw.close();store=await createStore(dir);assert.equal(store.schemaVersion,8);assert.equal(store.getEntity('contacts','real').name,'Nome legítimo');
  const backup=fs.readdirSync(path.join(dir,'backups')).find(n=>n.startsWith('antes-migracao-v8-'));assert(backup);raw=new DatabaseSync(path.join(dir,'backups',backup),{readOnly:true});assert.equal(raw.prepare('PRAGMA user_version').get().user_version,7);assert.equal(raw.prepare('PRAGMA quick_check').get().quick_check,'ok');raw.close();
  const snapshot=store.createRecoverySnapshot(path.join(dir,'recovery.sqlite'));assert(snapshot.bytes>0);raw=new DatabaseSync(snapshot.path,{readOnly:true});assert.equal(JSON.parse(raw.prepare('SELECT data FROM sales WHERE id=?').get('sale-original').data).totalCents,12345);raw.close();
  store.clearHistory({categories:['campaigns','sends','errors','notifications'],actor:'owner'});assert.equal(store.getEntity('sales','sale-original').totalCents,12345);store.close();
});
test('financial report recipients must have both report and financial permissions, and STOP blocks new automatic reports',async t=>{
  const f=await fixture(t),seller=await f.s.call('createUser',{name:'Vendedor relatório',username:'report-seller',password:PASSWORD,roleId:'role-seller',phone:'5562999990350',requirePasswordChange:false});
  await assert.rejects(f.s.call('saveDailyReportSettings',{enabled:true,time:'18:00',recipientIds:['user:'+seller.id]}));
  await f.s.call('saveDailyReportSettings',{enabled:true,time:'18:00',recipientIds:['user:'+f.owner.id]});await f.s.call('stopAll');
  await assert.rejects(f.s.call('generateDailyReport',{date:'2026-10-05',deliver:true}),{code:'AUTOMATION_STOPPED'});
  const preview=await f.s.call('getDailyReport',{date:'2026-10-05'});assert.equal(preview.totalCents,0);
  const reply=await f.s.call('testSimulation',{text:'!mega status'});assert.match(reply.text,/INTERROMPIDA/);assert.match(reply.text,/Oportunidades e relatórios/);
});
