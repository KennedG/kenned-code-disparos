'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {createStore,seed}=require('../src/core/store.cjs');

async function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-buscas-db-')),stores=[];t.after(()=>{for(const s of stores)s.close();fs.rmSync(dir,{recursive:true,force:true});});const open=async(sub='data')=>{const s=await createStore(path.join(dir,sub));stores.push(s);return s;};return {dir,open,store:await open()};}
const at=Date.UTC(2026,9,2,12);
const message=(id='m1',extra={})=>({chatId:'g1@g.us',messageId:id,text:'iPhone 18 Pro Max 256GB Silver R$ 7.000,00',senderId:'seller@lid',originalAt:at,capturedAt:at+1000,...extra});
const offer=(extra={})=>({model:'iPhone 18 Pro Max',modelKey:'iphone-18-pro-max',storageGB:256,color:'Silver',colorKey:'silver',condition:'lacrado',priceCents:700000,priceKind:'cash',confidence:'confirmed',productKey:'iphone18promax|256|silver|lacrado',fingerprint:'same-product-body',supplierKey:'seller@lid',originalExcerpt:'iPhone 18 Pro Max 256GB Silver R$ 7.000,00',...extra});

test('schema v4 migrates narrowly preserving campaign progress and producing an original pre-migration copy',async t=>{
  const {store:s,open}=await fixture(t);seed(s);s.insertJob({id:'j1',roundId:'r1',campaignId:'c1',groupId:'g1',itemId:'i1',status:'confirmed',attempts:1,createdAt:at,messageId:'NEVER-REPEAT'});s.clearHistory({actor:'owner'});s.close();
  const db=new DatabaseSync(s.filename);db.exec('PRAGMA user_version=4');db.close();const before=fs.readFileSync(s.filename);
  const upgraded=await open();assert.equal(upgraded.schemaVersion,8);assert.equal(upgraded.getJob('j1').messageId,'NEVER-REPEAT');assert.equal(upgraded.listHistory().total,0);assert.equal(upgraded.listCampaigns().length,1);assert.equal(upgraded.getSearchMonitorStats().offers,0);
  const files=fs.readdirSync(path.join(upgraded.dir,'backups'));assert.equal(files.length,1);assert.deepEqual(fs.readFileSync(path.join(upgraded.dir,'backups',files[0])),before);
});

test('capture is atomic and idempotent, edits preserve original time/text, stale updates and resurrection are rejected',async t=>{
  const {store:s,open}=await fixture(t);const first=s.upsertSearchMessage(message(),[offer()]);assert.equal(first.inserted,true);assert.equal(first.offers.length,1);
  const duplicate=s.upsertSearchMessage(message(),[offer()]);assert.equal(duplicate.ignored,true);assert.equal(s.querySearchOffers().total,1);
  const edited=s.upsertSearchMessage(message('m1',{text:'iPhone 18 Pro Max 256GB Silver R$ 6.900',revisionAt:at+2000,capturedAt:at+3000,originalAt:at+2000}),[offer({priceCents:690000})]);assert.equal(edited.updated,true);assert.equal(edited.message.originalAt,at);assert.equal(edited.message.originalText,message().text);assert.equal(s.querySearchOffers().items[0].priceCents,690000);
  assert.equal(s.upsertSearchMessage(message('m1',{text:'stale',revisionAt:at+1000}),[offer({priceCents:1})]).ignored,true);
  assert.throws(()=>s.upsertSearchMessage(message('m1',{text:'invalid edit',revisionAt:at+4000}),[offer({priceCents:-1})]),/Preço/);assert.equal(s.getSearchMessage('g1@g.us','m1').text,edited.message.text);assert.equal(s.querySearchOffers().items[0].priceCents,690000);
  s.deleteSearchMessages([{chatId:'g1@g.us',messageId:'m1'}],at+5000);assert.equal(s.querySearchOffers().total,0);assert.equal(s.getSearchMessage('g1@g.us','m1').deletedAt,at+5000);assert.equal(s.upsertSearchMessage(message('m1',{text:'restore attempt',revisionAt:at+6000}),[offer()]).deleted,true);
  s.close();const again=await open();assert.equal(again.getSearchMessage('g1@g.us','m1').originalText,message().text);assert.equal(again.querySearchOffers().total,0);
});

test('deletion arriving before an original message prevents late history from restoring a removed offer',async t=>{
  const {store:s}=await fixture(t);s.deleteSearchMessages([{chatId:'g1@g.us',messageId:'late'}],at+5000);const result=s.upsertSearchMessage(message('late'),[offer()]);assert.equal(result.deleted,true);assert.equal(s.querySearchOffers().total,0);
});

test('indexed queries preserve version, capacity, color, condition and uncertain prices with bounded pagination',async t=>{
  const {store:s}=await fixture(t);for(let i=0;i<80;i++)s.upsertSearchMessage(message('m'+i,{originalAt:at+i}),[offer({supplierKey:'seller'+i,priceCents:700000+i})]);
  s.upsertSearchMessage(message('wrong-model'),[offer({modelKey:'iphone-18-pro',priceCents:100})]);s.upsertSearchMessage(message('wrong-storage'),[offer({storageGB:128,priceCents:100})]);s.upsertSearchMessage(message('wrong-condition'),[offer({condition:'used',priceCents:100})]);s.upsertSearchMessage(message('ambiguous'),[offer({confidence:'review',priceCents:100})]);
  const f={modelKey:'iphone-18-pro-max',storageGB:256,colorKey:'silver',condition:'lacrado',limit:20};const first=s.querySearchOffers(f),second=s.querySearchOffers({...f,offset:20});assert.equal(first.total,80);assert.equal(first.items.length,20);assert.equal(second.items[0].priceCents,700020);assert.equal(new Set([...first.items,...second.items].map(i=>i.id)).size,40);assert.equal(s.querySearchOffers({limit:100000}).limit,500);assert.equal(s.querySearchOffers({modelKey:[]}).total,0);assert.equal(s.querySearchOffers({includeReview:true,confidence:'review'}).total,1);assert.equal(s.querySearchMessages({chatId:'g1@g.us',limit:2}).items.length,2);
  const db=new DatabaseSync(s.filename);const plan=db.prepare('EXPLAIN QUERY PLAN SELECT id FROM buscas_offers WHERE modelKey=? AND storageGB=? AND colorKey=? AND condition=? ORDER BY messageAt DESC LIMIT 10').all(f.modelKey,256,'silver','lacrado');assert.ok(plan.some(row=>row.detail.includes('buscas_offers_filters')));db.close();
});

test('latest supplier/product is chosen before price filters and a later sold product suppresses an older active price',async t=>{
  const {store:s}=await fixture(t);s.upsertSearchMessage(message('old'),[offer({priceCents:600000})]);s.upsertSearchMessage(message('new',{originalAt:at+1000}),[offer({priceCents:750000})]);
  assert.equal(s.querySearchOffers({latest:true,maxPriceCents:700000}).total,0);assert.equal(s.querySearchOffers({latest:true}).items[0].messageId,'new');assert.equal(s.querySearchOffers({latest:true,to:at}).items[0].messageId,'old');
  s.upsertSearchMessage(message('sold',{originalAt:at+2000}),[offer({unavailable:true,priceCents:null})]);assert.equal(s.querySearchOffers({latest:true}).total,0);assert.equal(s.querySearchOffers({latest:true,includeUnavailable:true,includeReview:true}).items[0].messageId,'sold');
  s.upsertSearchMessage(message('used',{originalAt:at+3000}),[offer({condition:'used',productKey:'iphone18promax|256|silver|used',priceCents:500000})]);assert.equal(s.querySearchOffers({latest:true}).total,1);assert.equal(s.querySearchOffers({latest:true}).items[0].condition,'used');
});

test('one result per supplier is selected in SQL before pagination and honors numeric filter aliases',async t=>{
  const {store:s}=await fixture(t);for(let i=0;i<550;i++)s.upsertSearchMessage(message('variant'+i),[offer({storageGB:i+1,productKey:'p'+i,priceCents:500000+i,batteryPercent:90})]);
  s.upsertSearchMessage(message('other'),[offer({supplierKey:'other-seller',priceCents:600000,batteryPercent:80})]);
  const ranked=s.querySearchOffers({onePerSupplier:true,latest:true,limit:10});assert.equal(ranked.total,2);assert.deepEqual(ranked.items.map(o=>o.supplierKey),['seller@lid','other-seller']);assert.equal(ranked.items[0].priceCents,500000);
  assert.equal(s.querySearchOffers({onePerSupplier:true,batteryMin:85,priceMaxCents:550000}).total,1);assert.equal(s.querySearchOffers({onePerSupplier:true,order:'price-desc',limit:1}).items[0].supplierKey,'other-seller');
});

test('blocked original supplier also excludes identical forwarded copies before ranking pagination',async t=>{
  const {store:s}=await fixture(t);
  s.upsertSearchMessage(message('blocked'),[offer({supplierKey:'blocked-seller',fingerprint:'blocked-body',priceCents:100000})]);
  for(let i=0;i<501;i++)s.upsertSearchMessage(message('copy'+i,{forwarded:true}),[offer({supplierKey:'forwarded:'+i,fingerprint:'blocked-body',priceCents:100000})]);
  s.upsertSearchMessage(message('independent'),[offer({supplierKey:'independent-seller',fingerprint:'blocked-body',priceCents:700000})]);
  s.upsertSearchMessage(message('allowed'),[offer({supplierKey:'allowed-seller',fingerprint:'different-body',priceCents:800000})]);
  const ranked=s.querySearchOffers({excludedSupplierKeys:['blocked-seller'],limit:500});
  assert.equal(ranked.total,2);
  assert.deepEqual(ranked.items.map(o=>o.supplierKey),['independent-seller','allowed-seller']);
});

test('supplier identity and warranty filters are applied before the 500 candidate limit with escaped wildcards',async t=>{
  const {store:s}=await fixture(t);
  for(let i=0;i<501;i++)s.upsertSearchMessage(message('cheap'+i),[offer({supplierKey:'cheap'+i,supplierName:'Outro fornecedor',warranty:'GARANTÍA 3 MESES',priceCents:100000+i})]);
  s.upsertSearchMessage(message('matching'),[offer({supplierKey:'real-seller',supplierName:'Márcia 100%_Atacado',warranty:'GARANTÍA 6 MESES',priceCents:800000})]);
  assert.equal(s.querySearchOffers({supplierSearch:'iphone',limit:500}).total,0);
  let matched=s.querySearchOffers({supplierSearch:'marcia',warranty:'garantia 6 meses',limit:500});assert.equal(matched.total,1);assert.equal(matched.items[0].supplierKey,'real-seller');
  assert.equal(s.querySearchOffers({supplierSearch:'100%_Atacado'}).total,1);assert.equal(s.querySearchOffers({supplierSearch:'100%ZAtacado'}).total,0);
  matched=s.querySearchOffers({warranty:'6 meses',limit:500});assert.equal(matched.total,1);assert.equal(matched.items[0].supplierKey,'real-seller');
});

test('search cleanup preserves command dedupe, uncertain delivery, campaign data and independent audit',async t=>{
  const {store:s,open}=await fixture(t);seed(s);s.upsertSearchMessage(message(),[offer()]);const run={id:'run1',chatId:'control@g.us',messageId:'command-1',userId:'owner',createdAt:at,status:'done',query:'18 pro max silver'};assert.equal(s.claimSearchRun(run).claimed,true);assert.equal(s.claimSearchRun({...run,id:'newid'}).claimed,false);s.saveSearchDelivery({id:'d1',runId:'run1',status:'uncertain',createdAt:at,messageId:'DURABLE'});
  const cleaned=s.deleteSearchHistory({actor:{id:'owner',name:'Dono'}});assert.equal(cleaned.count,1);assert.equal(s.listSearchHistory().total,0);assert.equal(s.querySearchOffers().total,1);assert.equal(s.claimSearchRun({...run,id:'newid'}).claimed,false);assert.equal(s.getSearchDelivery('d1').status,'uncertain');assert.equal(s.getEntity('audit',cleaned.auditId).actorId,'owner');
  const base=s.deleteSearchBase({actor:'owner'});assert.equal(base.messages,1);assert.equal(base.offers,1);assert.equal(s.listCampaigns().length,1);assert.equal(s.getSearchRun('run1').messageId,'command-1');assert.equal(s.getSearchDelivery('d1').messageId,'DURABLE');
  s.close();const again=await open();assert.equal(again.listSearchHistory().total,0);assert.equal(again.claimSearchRun({...run,id:'newid'}).claimed,false);assert.equal(again.getEntity('audit',base.auditId).action,'buscas.base.clear');
});

test('confirmed and uncertain result deliveries cannot be automatically requeued, while late ACK can confirm uncertainty',async t=>{
  const {store:s}=await fixture(t);s.saveSearchDelivery({id:'confirmed',runId:'r1',status:'confirmed',createdAt:at});assert.throws(()=>s.updateSearchDelivery('confirmed',{status:'pending'}),/confirmada/);s.saveSearchDelivery({id:'uncertain',runId:'r1',status:'uncertain',createdAt:at,messageId:'ACK'});assert.throws(()=>s.updateSearchDelivery('uncertain',{status:'sending'}),/incerta/);assert.equal(s.updateSearchDelivery('uncertain',{status:'confirmed'}).status,'confirmed');assert.equal(s.listSearchDeliveries({statuses:['confirmed'],limit:1}).total,2);
});

test('batched delivery summaries include every part without pagination or exposing result text',async t=>{
  const {store:s}=await fixture(t);for(let i=0;i<501;i++)s.saveSearchDelivery({id:'part'+i,runId:'many-parts',target:'5511999990001@s.whatsapp.net',status:i===500?'uncertain':'confirmed',createdAt:at+i,submittedAt:at+i+1,resultAt:at+i+2,text:'PRIVATE RESULT TEXT'});
  const [summary]=s.getSearchDeliverySummaries(['many-parts','no-delivery']);assert.equal(summary.parts,501);assert.equal(summary.counts.confirmed,500);assert.equal(summary.counts.uncertain,1);assert.equal(summary.firstCreatedAt,at);assert.equal(summary.lastResultAt,at+502);assert.deepEqual(summary.targets,['5511999990001@s.whatsapp.net']);assert.equal(JSON.stringify(summary).includes('PRIVATE RESULT TEXT'),false);assert.deepEqual(s.getSearchDeliverySummaries([]),[]);assert.throws(()=>s.getSearchDeliverySummaries(Array(1001).fill('many-parts')),/limite/);
});

test('authorization identity is unique, pagination and deactivation survive restart without names granting identity',async t=>{
  const {store:s,open}=await fixture(t);s.saveSearchAuthorization({id:'a1',principalId:'real@lid',name:'Dono',active:true,permissions:['search.execute']});assert.throws(()=>s.saveSearchAuthorization({id:'a2',principalId:'real@lid',name:'Other'}),/UNIQUE/);assert.equal(s.persistenceFailed,false);s.saveSearchAuthorization({...s.getSearchAuthorization('a1'),active:false});assert.equal(s.listSearchAuthorizations({active:1}).total,0);assert.equal(s.findSearchAuthorization('real@lid').active,false);assert.equal(s.findSearchAuthorization('name:Dono'),undefined);s.close();const again=await open();assert.equal(again.getSearchAuthorization('a1').principalId,'real@lid');
});

test('bounded durable capture inbox and recorded gaps expose true timing and survive a restart',async t=>{
  const {store:s,open}=await fixture(t);s.setSearchMonitorStarted(at-1000);assert.equal(s.enqueueSearchInbox({id:'q1',createdAt:at,message:message()},{maximum:1}).enqueued,true);assert.equal(s.enqueueSearchInbox({id:'q1',createdAt:at},{maximum:1}).duplicate,true);assert.equal(s.enqueueSearchInbox({id:'q2',createdAt:at},{maximum:1}).full,true);s.recordSearchGap({id:'gap1',startedAt:at,reason:'disconnect'});s.upsertSearchMessage(message(),[offer()]);let stats=s.getSearchMonitorStats();assert.equal(stats.inbox,1);assert.equal(stats.openGaps,1);assert.equal(stats.startedAt,at-1000);assert.equal(stats.lastOriginalAt,at);assert.equal(stats.lastCapturedAt,at+1000);assert.equal(stats.groups[0].chatId,'g1@g.us');
  s.close();const again=await open();assert.equal(again.listSearchInbox().items[0].id,'q1');again.deleteSearchInbox('q1');again.recordSearchGap({id:'gap1',endedAt:at+60000});stats=again.getSearchMonitorStats();assert.equal(stats.inbox,0);assert.equal(stats.openGaps,0);assert.equal(stats.gaps[0].startedAt,at);
});

test('portable backup excludes captured data and grants; ordinary campaign restore preserves local BUSCAS settings and base',async t=>{
  const {store:s}=await fixture(t);seed(s);s.setSetting('buscasSettings',{enabled:true,ownerRecipient:'LOCAL_PRIVATE',prefix:'!busca'});s.setSetting('searchLegacyPermission',{secretGrant:true});s.upsertSearchMessage(message(),[offer()]);s.saveSearchAuthorization({id:'grant',principalId:'real@lid',active:true});const data=s.exportData(),serialized=JSON.stringify(data);assert.equal(serialized.includes('LOCAL_PRIVATE'),false);assert.equal(serialized.includes('real@lid'),false);assert.equal(serialized.includes('iPhone 18 Pro Max 256GB'),false);assert.equal(data.settings.some(row=>/^buscas|^search/i.test(row.id)),false);s.importData(data);assert.equal(s.getSetting('buscasSettings').ownerRecipient,'LOCAL_PRIVATE');assert.equal(s.querySearchOffers().total,1);assert.equal(s.getSearchAuthorization('grant').active,true);
});

test('retention removes captured source/offers and visible old search history without losing operational delivery or dedupe',async t=>{
  const {store:s}=await fixture(t);s.upsertSearchMessage(message('old',{originalAt:at-40*86400000}),[offer()]);s.upsertSearchMessage(message('fresh'),[offer({supplierKey:'fresh'})]);s.claimSearchRun({id:'run',chatId:'private',messageId:'cmd',userId:'owner',createdAt:at-100*86400000,status:'done'});s.saveSearchDelivery({id:'pending',runId:'run',status:'pending',createdAt:at});const result=s.applySearchRetention({days:30,at,historyDays:90});assert.equal(result.removed,1);assert.equal(s.querySearchOffers().total,1);assert.equal(s.listSearchHistory().total,0);assert.equal(s.getSearchRun('run').messageId,'cmd');assert.equal(s.getSearchDelivery('pending').status,'pending');
});

test('real and simulation search storage have independent messages, grants, runs, deliveries, counters and cleanup even with identical IDs',async t=>{
  const {store:s,open}=await fixture(t);
  s.setSetting('integrationMode','simulated');s.setSetting('buscasSettings',{enabled:true,prefix:'!sim'});s.upsertSearchMessage(message(),[offer({id:'same-offer',priceCents:100})]);s.saveSearchAuthorization({id:'same-grant',userId:'owner',enabled:true,permissions:['search']});s.claimSearchRun({id:'same-run',chatId:'same-chat',messageId:'same-command',actorId:'owner',createdAt:at,status:'done'});s.saveSearchDelivery({id:'same-delivery',runId:'same-run',createdAt:at,status:'pending',target:'5511999990001@s.whatsapp.net'});s.enqueueSearchInbox({id:'same-inbox',createdAt:at,status:'queued'});s.recordSearchGap({id:'same-gap',startedAt:at});
  s.setSetting('integrationMode','whatsapp');assert.equal(s.querySearchOffers().total,0);assert.equal(s.getSearchMessage('g1@g.us','m1'),undefined);assert.equal(s.getSearchAuthorization('same-grant'),undefined);assert.equal(s.listSearchRuns().total,0);assert.equal(s.listSearchDeliveries().total,0);assert.equal(s.listSearchInbox().total,0);assert.equal(s.listSearchGaps().total,0);assert.equal(s.getSearchMonitorStats().messages,0);assert.equal(s.getSetting('buscasSettings',null),null);
  s.setSetting('buscasSettings',{enabled:true,prefix:'!real'});s.upsertSearchMessage(message(),[offer({id:'same-offer',priceCents:700000})]);assert.equal(s.claimSearchRun({id:'same-run',chatId:'same-chat',messageId:'same-command',actorId:'owner',createdAt:at,status:'done'}).claimed,true);s.saveSearchDelivery({id:'same-delivery',runId:'same-run',createdAt:at,status:'confirmed',target:'5511999990001@s.whatsapp.net'});s.deleteSearchBase({actor:'owner'});assert.equal(s.querySearchOffers().total,0);
  assert.throws(()=>s.saveSearchDelivery({id:'forged',runId:'same-run',createdAt:at,status:'pending',storageMode:'simulated'}),/outro modo/);
  s.setSetting('integrationMode','simulated');assert.equal(s.getSetting('buscasSettings').prefix,'!sim');assert.equal(s.querySearchOffers().items[0].priceCents,100);assert.equal(s.getSearchDelivery('same-delivery').status,'pending');assert.equal(s.getSearchAuthorization('same-grant').userId,'owner');assert.equal(s.listSearchInbox().total,1);assert.equal(s.claimSearchRun({id:'new-id',chatId:'same-chat',messageId:'same-command',actorId:'owner',createdAt:at}).claimed,false);
  s.close();const restarted=await open();assert.equal(restarted.querySearchOffers().items[0].priceCents,100);restarted.setSetting('integrationMode','whatsapp');assert.equal(restarted.getSetting('buscasSettings').prefix,'!real');assert.equal(restarted.getSearchDelivery('same-delivery').status,'confirmed');
});

test('legacy simulation migration uses explicit protocol or metadata evidence, preserving legitimately named real data',async t=>{
  const {store:s,open}=await fixture(t);s.close();
  const db=new DatabaseSync(s.filename);db.exec('DELETE FROM buscas_isolation_meta');
  const insert=db.prepare('INSERT INTO buscas_messages(chatId,messageId,originalAt,capturedAt,revisionAt,deletedAt,senderId,forwarded,data) VALUES(?,?,?,?,?,NULL,NULL,0,?)');
  for(const [chatId,simulation]of [['sim-01@simulation',false],['real@g.us',false],['other-real@g.us',true]]){const value=message(chatId,{chatId,text:'Fornecedor real chamado Grupo simulado',simulation});insert.run(chatId,chatId,at,at,at,JSON.stringify(value));}db.close();
  const upgraded=await open();upgraded.setSetting('integrationMode','whatsapp');assert.deepEqual(upgraded.listSearchMessages().items.map(x=>x.chatId),['real@g.us']);upgraded.setSetting('integrationMode','simulated');assert.equal(upgraded.listSearchMessages().total,2);
});
