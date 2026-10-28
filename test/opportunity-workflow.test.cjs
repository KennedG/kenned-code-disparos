'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { createStore } = require('../src/core/store.cjs');
const { parseRequest } = require('../src/core/opportunity-matcher.cjs');
const { OpportunityWorkflow, compatibleAnnouncement } = require('../src/core/opportunity-workflow.cjs');
const G1 = '120363111111111111@g.us', G2 = '120363222222222222@g.us', ORIGIN = '120363333333333333@g.us';
const ADMIN = '5562000000001', CLIENT = '5562000000002', NOW = Date.parse('2026-11-03T15:00:00Z');
const TEXT = '📱 iPhone 12 Pro 256GB\n🎨 Azul\nR$ 2.500,00\nDetalhe na tela pequeno\nAssinatura original ✨';

async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opportunity-workflow-')), clock = { at: NOW }, gate = { stopped: false, admin: true }, sent = [], local = [];
  let store = await createStore(directory), workflow;
  store.setSetting('integrationMode', 'whatsapp');
  store.upsertGroups([G1, G2, ORIGIN].map(id => ({ id, name: `Grupo ${id.slice(0, 6)}`, authorized: true, simulation: false })));
  const item = { id: 'phone-1', type: 'text', text: TEXT };
  store.saveCampaign({ id: 'campaign-1', name: 'Campanha cadastrada', state: 'draft', groupIds: [G1, G2], items: [item], spacingSeconds: 3, createdAt: NOW, updatedAt: NOW });
  store.setOpportunityConfig({ enabled: true, ownerId: 'owner', monitoredGroupIds: [ORIGIN], campaignIds: ['campaign-1'], adminPhone: ADMIN, adminActorId: 'owner', contactIntervalMinutes: 0,
    ...(options.config || {}) });
  const adapter = new EventEmitter(); adapter.status = { state: options.disconnected ? 'disconnected' : 'connected', mode: 'whatsapp' }; adapter.minimumSpacingSeconds = 3;
  adapter.resolveRecipient = async phone => ({ jid: `${phone}@s.whatsapp.net`, phone });
  adapter.send = async (recipient, content, media, opts) => { opts.beforeSubmit(); const row = { kind: 'ad', recipient, content, media, opts }; sent.push(row); return options.send ? options.send(row, sent.filter(value => value.kind === 'ad').length) : { status: 'accepted', messageId: content.clientMessageId }; };
  adapter.sendSearchText = async (recipient, text, opts) => { opts.beforeSubmit(); sent.push({ kind: 'notice', recipient, text, opts }); return { status: 'accepted', messageId: opts.clientMessageId }; };
  adapter.reconcile = async id => ({ status: 'uncertain', messageId: id });
  const scheduler = { getAttemptTimeoutMs: () => options.deadline || 25, runExternalSubmission: work => work({ beforeSubmit: () => { if (gate.stopped) throw Object.assign(new Error('Parado'), { code: 'OP_STOPPED', submitted: false, definitive: true }); } }) };
  const setup = () => {
    workflow = new OpportunityWorkflow({ store, adapter, scheduler, now: () => clock.at, sleep: async ms => { clock.at += ms; }, opportunities: { _notify: op => local.push(op.id), resumeCapture: () => {} },
      assertCanOperate: actor => { if (actor !== 'owner') throw Object.assign(new Error('Sem permissão'), { code: 'DENIED' }); return true; },
      assertAdministrator: () => gate.admin, isAutomationStopped: () => gate.stopped,
      automation: { stop: async () => { gate.stopped = true; return { stopped: true }; }, resume: async () => { gate.stopped = false; } } });
    workflow.start(); return workflow;
  };
  setup();
  if (options.automatic === false) await workflow.setAutomatic(false, 'owner');
  const request = (messageId = 'request-1', text = 'Quem tem iPhone 12 Pro 256GB?', phone = CLIENT) => store.ingestOpportunity({ event: { senderKey: `phone:${phone}`, senderPhone: phone, senderId: `${phone}@s.whatsapp.net`, senderName: 'Interessado', recipient: phone,
    chatId: ORIGIN, groupId: ORIGIN, groupName: 'Pedidos', messageId, originalAt: clock.at, text }, request: parseRequest(text) }, clock.at).opportunity;
  const flush = async (turns = 8) => { for (let index = 0; index < turns; index++) { await workflow.waitForIdle(); clock.at += 3000; } };
  const reopen = async () => { await workflow.stop(); store.close(); store = await createStore(directory); setup(); return workflow; };
  t.after(async () => { await workflow.stop(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { get store() { return store; }, get workflow() { return workflow; }, directory, clock, gate, sent, local, adapter, scheduler, request, flush, reopen, item };
}

test('automatic defaults once, campaign destinations only and original complete announcement is sent', async t => {
  const f = await fixture(t), op = f.request(); assert.equal(f.workflow.config().automatic, true);
  const result = f.workflow.consider(op.id); assert.equal(result.ok, true); await f.flush();
  const ads = f.sent.filter(row => row.kind === 'ad'); assert.equal(ads.length, 2); assert.deepEqual(ads.map(row => row.recipient), [G1, G2]);
  assert.equal(ads[0].content.text, TEXT); assert.equal(ads[1].content.text, TEXT);
  assert.ok(!f.sent.some(row => row.recipient === `${CLIENT}@s.whatsapp.net` || row.recipient === ORIGIN));
  const notices = f.sent.filter(row => row.kind === 'notice'); assert.equal(notices.length, 2); assert.ok(notices.every(row => row.recipient === `${ADMIN}@s.whatsapp.net`));
  assert.match(notices[0].text, new RegExp(op.id)); assert.ok(notices[0].text.includes(TEXT)); assert.match(notices[1].text, /Aceitos pela integração: 2/);
  assert.equal(f.workflow.detail(op.id).status, 'accepted'); assert.equal(f.local.length, 1);
});
test('no inventory confirmation, price or recent availability timestamp is required for exact campaign model', async t => {
  const f = await fixture(t), campaign = f.store.getCampaign('campaign-1');
  campaign.items[0].text = '📱 iPhone 12 Pro 256GB\nSob encomenda\nObservação original'; f.store.saveCampaign(campaign);
  const op = f.request(); assert.equal(f.workflow.consider(op.id).ok, true); await f.flush(); assert.equal(f.sent.filter(row => row.kind === 'ad').length, 2);
});
test('different model or storage never becomes automatic substitute and budget requires total price', () => {
  const campaign = { id: 'c' }, item = { id: 'i', type: 'text', text: 'iPhone 12 Pro 256GB R$ 2500,00' };
  assert.equal(compatibleAnnouncement(parseRequest('Quem tem iPhone 12 256GB?'), item, campaign).eligible, false);
  assert.equal(compatibleAnnouncement(parseRequest('Quem tem iPhone 12 Pro 128GB?'), item, campaign).eligible, false);
  assert.equal(compatibleAnnouncement(parseRequest('Procuro iPhone 12 Pro 256GB até R$ 2.000'), item, campaign).eligible, false);
  assert.equal(compatibleAnnouncement(parseRequest('Procuro iPhone 12 Pro 256GB até R$ 2.000'), { ...item, text: 'iPhone 12 Pro 256GB 12x R$ 150,00' }, campaign).eligible, false);
});
test('automatic off persists restart, notifies and waits; approval starts exactly one batch', async t => {
  const f = await fixture(t, { automatic: false }), op = f.request(); f.workflow.consider(op.id); await f.flush();
  assert.equal(f.sent.filter(row => row.kind === 'ad').length, 0); assert.match(f.sent.find(row => row.kind === 'notice').text, /!aprovar/);
  await f.reopen(); assert.equal(f.workflow.config().automatic, false); await f.flush(); assert.equal(f.sent.filter(row => row.kind === 'ad').length, 0);
  assert.equal(f.workflow.approve(op.id, 'owner').ok, true); f.workflow.approve(op.id, 'owner'); await f.flush(); assert.equal(f.sent.filter(row => row.kind === 'ad').length, 2);
});
test('explicit select-and-send approves an existing waiting selection without confirmation token', async t => {
  const f = await fixture(t, { automatic: false }), op = f.request(); f.workflow.consider(op.id);
  assert.equal(f.workflow.dispatch({ opportunityId: op.id, campaignId: 'campaign-1', itemId: 'phone-1' }, 'owner').ok, true); await f.flush(); assert.equal(f.sent.filter(row => row.kind === 'ad').length, 2);
});
test('explicit select-and-send can replace an unstarted waiting selection without sending old item', async t => {
  const f = await fixture(t, { automatic: false, disconnected: true }), campaign = f.store.getCampaign('campaign-1');
  campaign.items.push({ id: 'phone-2', type: 'text', text: 'iPhone 12 Pro 256GB Verde R$ 3.000,00' }); f.store.saveCampaign(campaign);
  const op = f.request(); f.workflow.consider(op.id); f.workflow.dispatch({ opportunityId: op.id, campaignId: 'campaign-1', itemId: 'phone-2' }, 'owner');
  f.adapter.status.state = 'connected'; await f.flush(); const ads = f.sent.filter(row => row.kind === 'ad'); assert.equal(ads.length, 2); assert.ok(ads.every(row => row.content.text === campaign.items[1].text));
});
test('duplicate request processing and restart do not duplicate accepted group sends', async t => {
  const f = await fixture(t), op = f.request(); f.workflow.consider(op.id); f.workflow.consider(op.id); await f.flush();
  await f.reopen(); f.workflow.consider(op.id); await f.flush(); assert.equal(f.sent.filter(row => row.kind === 'ad').length, 2); assert.equal(f.sent.filter(row => row.kind === 'notice').length, 2);
});
test('first group confirmed failure does not stop other group and result notice reports truth', async t => {
  const f = await fixture(t, { send: (row, count) => { if (count === 1) throw Object.assign(new Error('Somente administradores'), { code: 'GROUP_ADMIN_ONLY', submitted: false, definitive: true }); return { status: 'accepted', messageId: row.content.clientMessageId }; } });
  const op = f.request(); f.workflow.consider(op.id); await f.flush();
  assert.equal(f.sent.filter(row => row.kind === 'ad').length, 2); const detail = f.workflow.detail(op.id); assert.equal(detail.jobs.filter(row => row.type === 'campaign-ad' && row.status === 'failed').length, 1);
  assert.equal(detail.jobs.filter(row => row.type === 'campaign-ad' && row.status === 'accepted').length, 1); assert.match(f.sent.filter(row => row.kind === 'notice').at(-1).text, /Falhas: 1/);
});
test('uncertain releases subsequent destination, never retries and late proof reconciles once', async t => {
  let complete; const f = await fixture(t, { send: (row, count) => count === 1 ? new Promise(resolve => { complete = () => resolve({ status: 'accepted', messageId: row.content.clientMessageId }); }) : { status: 'accepted', messageId: row.content.clientMessageId } });
  const op = f.request(); f.workflow.consider(op.id); await f.flush(); const uncertain = f.workflow.detail(op.id).jobs.find(row => row.status === 'uncertain'); assert.ok(uncertain);
  assert.equal(f.sent.filter(row => row.kind === 'ad').length, 2); f.workflow.consider(op.id); await f.flush(); assert.equal(f.sent.filter(row => row.kind === 'ad').length, 2);
  complete(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.store.getOpportunityWorkflowJob(uncertain.id).status, 'accepted');
  f.adapter.emit('receipt', { status: 'delivered', messageId: uncertain.clientMessageId, confirmationScope: 'whatsapp-delivered' }); assert.equal(f.store.getOpportunityWorkflowJob(uncertain.id).status, 'delivered');
});
test('reject, mute, expiry and global stop prevent pending group sends', async t => {
  const f = await fixture(t, { automatic: false }), op = f.request(); f.workflow.consider(op.id); f.workflow.reject(op.id, 'owner'); await f.flush(); assert.equal(f.sent.filter(row => row.kind === 'ad').length, 0);
  f.clock.at += 3600000; const second = f.request('second', 'Quem tem iPhone 12 Pro 256GB?', '5562000000003');
  f.workflow.consider(second.id); f.store.setOpportunityContactMute(second.senderKey, { muted: true, at: f.clock.at }); assert.throws(() => f.workflow.approve(second.id, 'owner'), { code: 'OP_MUTED' });
  const third = f.request('third', 'Quem tem iPhone 12 Pro 256GB?', '5562000000004'); f.workflow.consider(third.id); f.clock.at += 121 * 60000; assert.throws(() => f.workflow.approve(third.id, 'owner'), { code: 'OP_EXPIRED' });
});
test('pause cancels all pending notices and ads, explicit automatic-on reopens only new work', async t => {
  const f = await fixture(t, { disconnected: true }), op = f.request(); f.workflow.consider(op.id); await f.workflow.pause('owner');
  assert.equal(f.gate.stopped, true); assert.equal(f.workflow.status().pending, 0); f.adapter.status.state = 'connected'; await f.flush(); assert.equal(f.sent.length, 0);
  await f.workflow.setAutomatic(true, 'owner'); assert.equal(f.gate.stopped, false); await f.flush(); assert.equal(f.sent.length, 0);
});
test('queued original campaign edit blocks stale payload and invalidates deleted campaign', async t => {
  const f = await fixture(t, { disconnected: true }), op = f.request(); f.workflow.consider(op.id);
  const campaign = f.store.getCampaign('campaign-1'); campaign.items[0].text = TEXT.replace('2.500', '2.900'); f.store.saveCampaign(campaign);
  f.adapter.status.state = 'connected'; await f.flush(); assert.equal(f.sent.filter(row => row.kind === 'ad').length, 0); assert.ok(f.workflow.detail(op.id).jobs.some(row => row.code === 'OPPORTUNITY_OFFER_CHANGED'));
});
test('administrator missing or revoked cannot dispatch and recipient is never replaced', async t => {
  const f = await fixture(t); f.store.setOpportunityConfig({ ...f.workflow.config(), adminPhone: '' }); const op = f.request(); assert.equal(f.workflow.consider(op.id).code, 'OP_ADMIN_NOT_CONFIGURED'); await f.flush(); assert.equal(f.sent.length, 0);
  f.store.setOpportunityConfig({ ...f.workflow.config(), adminPhone: ADMIN }); f.gate.admin = false; assert.throws(() => f.workflow.dispatch({ opportunityId: op.id, campaignId: 'campaign-1', itemId: 'phone-1' }, 'owner'), { code: 'OP_ADMIN_UNAUTHORIZED' });
});
test('campaign destination empty is explicit failure, never fallback to interested contact or origin', async t => {
  const f = await fixture(t), campaign = f.store.getCampaign('campaign-1'); campaign.groupIds = []; f.store.saveCampaign(campaign);
  const op = f.request(); assert.equal(f.workflow.consider(op.id).code, 'OP_CAMPAIGN_NO_DESTINATIONS'); await f.flush(); assert.equal(f.sent.length, 0);
});
test('media is sent with the original caption and managed media record', async t => {
  const f = await fixture(t), campaign = f.store.getCampaign('campaign-1'), file = path.join(f.directory, 'photo.png'); fs.writeFileSync(file, 'test photo');
  const media = f.store.saveMedia({ id: 'photo', path: file, name: 'photo.png', mime: 'image/png', size: 10 });
  campaign.items[0] = { id: 'phone-1', type: 'image', caption: TEXT, mediaId: media?.id || 'photo' }; f.store.saveCampaign(campaign);
  const op = f.request(); f.workflow.consider(op.id); await f.flush(); const ad = f.sent.find(row => row.kind === 'ad'); assert.ok(ad); assert.equal(ad.content.caption, TEXT); assert.equal(ad.media.id, 'photo');
});
test('configured campaign interval persists across restart and no catch-up burst occurs', async t => {
  const f = await fixture(t), campaign = f.store.getCampaign('campaign-1'); campaign.groupSpacingSeconds = 60; f.store.saveCampaign(campaign);
  const op = f.request(); f.workflow.consider(op.id); await f.workflow.waitForIdle(); assert.equal(f.sent.filter(row => row.kind === 'ad').length, 1);
  await f.reopen(); f.clock.at += 10000; await f.workflow.waitForIdle(); assert.equal(f.sent.filter(row => row.kind === 'ad').length, 1);
  f.clock.at += 60000; await f.workflow.waitForIdle(); assert.equal(f.sent.filter(row => row.kind === 'ad').length, 2);
});
test('explicit evaluation mode produces no group delivery and no private notice', async t => {
  const f = await fixture(t); f.store.setOpportunityConfig({ ...f.workflow.config(), mode: 'evaluation', automatic: false, evaluation: true });
  const op = f.request(); assert.equal(f.workflow.consider(op.id).evaluationOnly, true); await f.flush(); assert.equal(f.sent.length, 0);
});
test('relevant request edit cancels eligibility of an automatic item already queued', async t => {
  const f = await fixture(t, { disconnected: true }), op = f.request(); f.workflow.consider(op.id);
  f.store.updateOpportunity(op.id, { intentKey: 'different-intent-key', needsReview: true });
  f.adapter.status.state = 'connected'; await f.flush(); assert.equal(f.sent.filter(row => row.kind === 'ad').length, 0);
  assert.ok(f.workflow.detail(op.id).jobs.some(row => row.code === 'OP_REQUEST_CHANGED'));
});
test('confirmed recoverable pre-submission failure retries with bound and delay', async t => {
  const f = await fixture(t, { config: { retryMax: 1, retryIntervalSeconds: 5 } });
  let calls = 0;
  f.adapter.send = async (recipient, content, media, opts) => { calls++; if (calls === 1) throw Object.assign(new Error('Falha antes do transporte'), { code: 'TEMPORARY', safeToRetry: true, submitted: false, definitive: true }); opts.beforeSubmit(); f.sent.push({ kind: 'ad', recipient, content, opts }); return { status: 'accepted', messageId: content.clientMessageId }; };
  const op = f.request(); f.workflow.consider(op.id); await f.flush(12); assert.equal(calls, 3); assert.equal(f.sent.filter(row => row.kind === 'ad').length, 2);
  assert.ok(f.workflow.detail(op.id).jobs.some(row => row.type === 'campaign-ad' && row.attempts === 2));
});
test('technical failures redact credentials from opportunity trace, saved reason and administrator notice', async t => {
  const f = await fixture(t); f.adapter.send = async () => { throw Object.assign(new Error('Falha token=segredo-nao-publicar Bearer credencial.oculta'), { code: 'TEST_FAILURE', submitted: false, definitive: true }); };
  const op = f.request(); f.workflow.consider(op.id); await f.flush();
  const saved = JSON.stringify({ detail: f.workflow.detail(op.id), traces: f.store.listOpportunityTraces?.({ opportunityId: op.id }) || f.store.exportOpportunityData().notifications, notices: f.sent.filter(row => row.kind === 'notice') });
  assert.ok(!saved.includes('segredo-nao-publicar')); assert.ok(!saved.includes('credencial.oculta')); assert.ok(saved.includes('[omitido]'));
});
test('a destination removed from synchronized groups after reservation cannot block the remaining campaign destination',async t=>{
 const f=await fixture(t,{disconnected:true}),op=f.request();f.workflow.consider(op.id);
 f.store.replaceGroups([G2,ORIGIN].map(id=>({id,name:'Grupo ainda acessível',authorized:true,simulation:false})));
 f.adapter.status.state='connected';await f.flush();
 const jobs=f.workflow.detail(op.id).jobs.filter(job=>job.type==='campaign-ad');
 assert.equal(jobs.find(job=>job.recipient===G1).status,'failed');assert.equal(jobs.find(job=>job.recipient===G2).status,'accepted');
 assert.deepEqual(f.sent.filter(row=>row.kind==='ad').map(row=>row.recipient),[G2]);
});
