'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createStore } = require('../src/core/store.cjs');
const { OpportunityService, normalizeOpportunityConfig } = require('../src/core/opportunity-service.cjs');
const { assessCampaignItem, campaignItemFingerprint } = require('../src/core/opportunity-campaign.cjs');
const NOW = Date.parse('2026-10-19T15:00:00Z'), GROUP = '120363111111111111@g.us';
const offer = (patch = {}) => ({ id: 'item-12', type: 'text', text: 'iPhone 12 Pro 128GB Azul R$ 1.800,00\nDetalhe na tela pequeno', ...patch });
const campaign = (items = [offer()]) => ({ id: 'campaign-12', name: 'Lista da loja', items, state: 'draft', groupIds: [], createdAt: NOW - 86400000, updatedAt: NOW });

async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opportunity-raw-r5-')), store = await createStore(dir), sent = [], clock = { at: NOW }, adapter = new EventEmitter();
  adapter.status = { state: 'connected', mode: 'whatsapp' }; adapter.minimumSpacingSeconds = 3;
  adapter.configureOpportunityCapture = () => {};
  adapter.resolveRecipient = async phone => { await options.onResolve?.(); return { phone, jid: `${phone}@s.whatsapp.net` }; };
  adapter.sendSearchText = async (target, text, opts) => { opts.beforeSubmit(); sent.push({ target, text, opts, format: 'text' }); return options.send ? options.send(sent.at(-1), sent.length) : { status: 'accepted', messageId: opts.clientMessageId }; };
  adapter.sendPrivateContent = async (target, item, media, opts) => { opts.beforeSubmit(); sent.push({ target, text: item.caption, item, media, opts, format: item.type }); return options.send ? options.send(sent.at(-1), sent.length) : { status: 'accepted', messageId: opts.clientMessageId }; };
  store.setSetting('integrationMode', 'whatsapp'); store.upsertGroups([{ id: GROUP, name: 'Grupo autorizado', authorized: true }]); store.saveCampaign(campaign(options.items));
  const service = new OpportunityService({ store, adapter, now: options.realtime ? () => Date.now() : () => clock.at,
    assertCanCapture: () => true, assertCanOperate: () => true, assertOwnerPermissions: () => true });
  service.saveConfig({ enabled: true, mode: 'automatic', monitoredGroupIds: [GROUP], campaignIds: ['campaign-12'], ...options.config }, 'owner'); service.start();
  const event = (id, patch = {}) => ({ messageId: id, chatId: GROUP, originalTimestamp: options.realtime ? Date.now() : clock.at,
    senderNumber: '5562999999999', senderId: '5562999999999@s.whatsapp.net', identityVerified: true, isGroup: true, mode: 'whatsapp', type: 'text', text: 'Quem tem iPhone 12 Pro?', ...patch });
  t.after(async () => { await service.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, sent, clock, adapter, service, event };
}

// These use the real production OpportunityService and persistent SQLite. The
// WhatsApp transport is controlled: they do not prove real phone delivery.
const MANUAL = { campaignId: 'campaign-12', itemId: 'item-12' };
const RAW = '📱 Aparelho selecionado por mim\n🩷 Cor: ROSA\nPreço sob consulta\nDetalhe na tela pequeno\n𝗣𝗮𝗹𝗮𝗰𝗲 𝗣𝗮𝗿𝗳𝘂𝗺 — assinatura original';
const manualFixture = (t, options={}) => fixture(t, { items: [offer({ text: RAW })], ...options, config: { mode: 'evaluation', availabilityMode: 'confirmed', ...options.config } });
function request(f,id='RAW-REQUEST',patch={}) { return f.service.handleIncoming(f.event(id,patch)).opportunity; }
function preview(f,op,patch={}) { return f.service.preview({ id:op.id, manualCampaignSelection: MANUAL,...patch },'owner'); }
function submit(f,op,p,patch={}) { return f.service.respondManual({id:op.id,manualCampaignSelection:MANUAL,offerIds:p.offerIds,previewToken:p.previewToken,confirm:true,...patch},'owner'); }

test('raw selected announcement sends without parsed model, price or stock confirmation and keeps settings unchanged', async t => {
  const f=await manualFixture(t),op=request(f); await f.service.waitForIdle();
  assert.equal(f.sent.length,0); assert.equal(f.service.getDetail(op.id,'owner').candidates.length,0);
  const catalog=f.service.listCampaignItems(); assert.equal(catalog.total,1); assert.equal(catalog.items[0].manualEligible,true);
  const p=preview(f,op); assert.equal(p.canSend,true,JSON.stringify(p.blockers)); assert.equal(p.text,RAW); assert.equal(p.offers[0].model,null); assert.equal(p.offers[0].priceCents,null);
  assert.ok(p.warnings.some(v=>v.code==='MANUAL_CAMPAIGN_SELECTION'));
  const result=submit(f,op,p); await f.service.waitForIdle();
  assert.equal(f.sent.length,1); assert.equal(f.sent[0].text,RAW); assert.equal(f.sent[0].target,'5562999999999@s.whatsapp.net');
  const task=f.store.getOpportunityTask(result.task.id); assert.equal(task.status,'accepted'); assert.equal(task.automatic,false); assert.deepEqual(task.manualCampaignSelection,MANUAL);
  assert.equal(f.store.getOpportunityConfig().availabilityMode,'confirmed');
});

test('manual media keeps exact original caption, source media and explicit conditional availability', async t => {
  const caption=RAW+'\nSob encomenda — consultar prazo';
  const f=await manualFixture(t,{items:[offer({type:'image',text:'',caption,mediaId:'manual-photo'})]}),photoPath=path.join(f.store.dir,'media','manual-photo.png');
  fs.mkdirSync(path.dirname(photoPath),{recursive:true});fs.writeFileSync(photoPath,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1QAAAABJRU5ErkJggg==','base64'));
  f.store.saveMedia({id:'manual-photo',name:'original.png',mime:'image/png',path:photoPath,sha256:'b'.repeat(64)});
  const op=request(f),p=preview(f,op);assert.equal(p.canSend,true,JSON.stringify(p.blockers));assert.equal(p.text,caption);
  assert.ok(p.warnings.some(v=>v.code==='MANUAL_CONDITIONAL_OFFER'));submit(f,op,p);await f.service.waitForIdle();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].format,'image');assert.equal(f.sent[0].text,caption);assert.equal(f.sent[0].media.id,'manual-photo');assert.equal(f.sent[0].item.mediaId,'manual-photo');
});

test('manual preview token rejects another actor, missing selection, changed text and expired preview', async t => {
  const f=await manualFixture(t),op=request(f),p=preview(f,op);
  assert.throws(()=>f.service.respondManual({id:op.id,manualCampaignSelection:MANUAL,offerIds:p.offerIds,previewToken:p.previewToken,confirm:true},'another-actor'),{code:'OPPORTUNITY_PREVIEW_STALE'});
  assert.throws(()=>f.service.respondManual({id:op.id,offerIds:p.offerIds,previewToken:p.previewToken,confirm:true},'owner'));
  f.store.saveCampaign(campaign([offer({text:RAW+'\nNovo detalhe'})]));
  assert.throws(()=>submit(f,op,p),{code:'OPPORTUNITY_PREVIEW_STALE'});
  const fresh=preview(f,op);f.clock.at+=5*60000+1;assert.throws(()=>submit(f,op,fresh),{code:'OPPORTUNITY_PREVIEW_STALE'});
  await f.service.waitForIdle();assert.equal(f.sent.length,0);assert.equal(f.store.listOpportunityTasks().length,0);
});

test('manual selection refuses sold, missing media, missing source and unselected campaigns', async t => {
  const f=await manualFixture(t),op=request(f);
  const cases=[
    [offer({text:RAW+'\nVENDIDO'}),'OFFER_UNAVAILABLE'],
    [offer({type:'image',mediaId:'absent',caption:RAW}),'OFFER_MEDIA_MISSING'],
    [offer({text:RAW,sourcePublicationId:'absent',sourcePublicationRevision:NOW}),'OFFER_SOURCE_MISSING']
  ];
  for(const [item,code]of cases){f.store.saveCampaign(campaign([item]));assert.throws(()=>preview(f,op),{code});}
  assert.throws(()=>preview(f,op,{manualCampaignSelection:{campaignId:'unselected',itemId:'item-12'}}),{code:'OPPORTUNITY_CAMPAIGN_INVALID'});
  await f.service.waitForIdle();assert.equal(f.sent.length,0);
});

test('global stop and silenced contact block even manually selected ads with a valid preview', async t => {
  const f=await manualFixture(t),op=request(f),p=preview(f,op);
  f.service.isAutomationStopped=()=>true;const stopped=preview(f,op);assert.equal(stopped.canSend,false);assert.ok(stopped.blockers.some(v=>v.code==='OP_STOPPED'));
  assert.throws(()=>submit(f,op,p),{code:'OPPORTUNITY_SEND_BLOCKED'});
  f.service.isAutomationStopped=()=>false;f.service.mute(op.id,'owner');const muted=preview(f,op);assert.equal(muted.canSend,false);assert.ok(muted.blockers.some(v=>v.code==='OP_MUTED'));
  await f.service.waitForIdle();assert.equal(f.sent.length,0);assert.equal(f.store.listOpportunityTasks().length,0);
});

test('manual selection validates source again after recipient resolution and before transport', async t => {
  let f;f=await manualFixture(t,{onResolve:()=>f.store.saveCampaign(campaign([offer({text:RAW,status:'sold'})]))});
  const op=request(f),p=preview(f,op),reserved=submit(f,op,p);await f.service.waitForIdle();
  assert.equal(f.sent.length,0);const task=f.store.getOpportunityTask(reserved.task.id);assert.equal(task.status,'failed');assert.ok(['OFFER_UNAVAILABLE','OP_AVAILABILITY'].includes(task.code),task.code);
});

test('raw manual projection cannot be reserved or used by automatic matching', async t => {
  const f=await manualFixture(t),op=request(f),p=preview(f,op);f.service.saveConfig({mode:'automatic'},'owner');
  const automatic=f.store.reserveOpportunitySend({opportunityId:op.id,offerIds:p.offerIds,recipient:op.recipient,clientId:'AUTOMATIC-CANNOT-RAW',automatic:true,now:f.clock.at,actorId:'owner'});
  assert.equal(automatic.ok,false);assert.equal(automatic.code,'OP_OFFER_UNSAFE');
  f.service.saveConfig({mode:'automatic'},'owner');f.service.invalidateCampaignOffers({reevaluate:true});await f.service.waitForIdle();assert.equal(f.sent.length,0);
});

test('accepted raw manual response survives repeat event and blocks a second manual send', async t => {
  const f=await manualFixture(t),op=request(f),p=preview(f,op);submit(f,op,p);await f.service.waitForIdle();
  assert.equal(f.sent.length,1);f.service.handleIncoming(f.event('RAW-REQUEST'));const again=preview(f,op);assert.equal(again.canSend,false);assert.ok(again.blockers.some(v=>['OP_ALREADY_RESPONDED','OP_OFFER_SENT'].includes(v.code)));
  await f.service.waitForIdle();assert.equal(f.sent.length,1);
});

test('uncertain raw manual retry keeps explicit campaign selection and requires duplicate risk confirmation', async t => {
  const f=await manualFixture(t,{send:(entry,n)=>n===1?{status:'uncertain',messageId:entry.opts.clientMessageId}:{status:'accepted',messageId:entry.opts.clientMessageId}}),op=request(f),p=preview(f,op),reserved=submit(f,op,p);
  await f.service.waitForIdle();const first=f.store.getOpportunityTask(reserved.task.id);assert.equal(first.status,'uncertain');assert.equal(f.sent.length,1);
  await assert.rejects(()=>f.service.retryUncertain({id:first.id,confirm:true},'owner'),{code:'OPPORTUNITY_DUPLICATE_RISK_REQUIRED'});
  const result=await f.service.retryUncertain({id:first.id,confirm:true,duplicateRiskAcknowledged:true},'owner');await f.service.waitForIdle();
  const retried=f.store.getOpportunityTask(result.task.id);assert.deepEqual(retried.manualCampaignSelection,MANUAL);assert.equal(retried.automatic,false);assert.equal(retried.status,'accepted');assert.equal(retried.retryOf,first.id);assert.equal(f.sent.length,2);assert.equal(f.sent[1].text,RAW);
});

test('the original campaign offer cannot automatically bypass a prior manual response projection on the next day', async t => {
  const f=await manualFixture(t,{items:[offer()],config:{availabilityMode:'campaign'}}),op=request(f),p=preview(f,op);submit(f,op,p);await f.service.waitForIdle();assert.equal(f.sent.length,1);
  f.clock.at+=25*3600000;f.service.saveConfig({mode:'automatic'},'owner');const next=request(f,'NEXT-DAY-ORIGINAL');await f.service.waitForIdle();
  assert.notEqual(next.id,op.id);assert.equal(f.sent.length,1);const detail=f.service.getDetail(next.id,'owner');assert.ok(detail.candidates[0].sentBefore);assert.equal(detail.candidates[0].updatedSinceSent,false);assert.ok(detail.blockers.some(v=>['OFFER_ALREADY_SENT','OP_OFFER_SENT','OP_OFFER_REPOST'].includes(v.code)),JSON.stringify(detail.blockers));
});

test('manual projection cannot bypass an earlier automatic response of the same campaign item', async t => {
  const f=await fixture(t),op=request(f);await f.service.waitForIdle();assert.equal(f.sent.length,1);
  f.clock.at+=25*3600000;f.service.saveConfig({mode:'evaluation'},'owner');const next=request(f,'NEXT-DAY-MANUAL'),p=preview(f,next);assert.notEqual(next.id,op.id);assert.equal(p.canSend,false);assert.ok(p.blockers.some(v=>['OP_OFFER_SENT','OP_OFFER_REPOST'].includes(v.code)),JSON.stringify(p.blockers));await f.service.waitForIdle();assert.equal(f.sent.length,1);
});

test('repeated and weaker proofs do not rewrite results or repeat accepted diagnostics', async t => {
  const f=await manualFixture(t),op=request(f),p=preview(f,op),reserved=submit(f,op,p);await f.service.waitForIdle();
  const id=reserved.task.id,task=f.store.getOpportunityTask(id),proof={status:'accepted',messageId:task.messageId};
  const resultAt=task.resultAt;let writes=0,traces=0;const update=f.store.updateOpportunityTask.bind(f.store),trace=f.service._trace.bind(f.service);
  f.store.updateOpportunityTask=(...args)=>{writes++;return update(...args)};f.service._trace=(...args)=>{traces++;return trace(...args)};
  for(let i=0;i<100;i++){f.clock.at++;f.service._proof(id,proof)}
  assert.equal(writes,0);assert.equal(traces,0);assert.equal(f.store.getOpportunityTask(id).resultAt,resultAt);
  f.service._proof(id,{status:'delivered',messageId:task.messageId,deliveredAt:f.clock.at,confirmationScope:'recipient'});assert.equal(f.store.getOpportunityTask(id).status,'delivered');const deliveredAt=f.store.getOpportunityTask(id).deliveredAt;
  const written=writes,traced=traces;f.clock.at++;f.service._proof(id,proof);assert.equal(writes,written);assert.equal(traces,traced);assert.equal(f.store.getOpportunityTask(id).status,'delivered');assert.equal(f.store.getOpportunityTask(id).deliveredAt,deliveredAt);assert.equal(f.store.getOpportunityTask(id).resultAt,resultAt);
});
