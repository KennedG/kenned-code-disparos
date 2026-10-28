'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createStore } = require('../src/core/store.cjs');
const { OpportunityService, normalizeOpportunityConfig, formatOpportunityResponse } = require('../src/core/opportunity-service.cjs');
const GROUP = '120363111111111111@g.us', OTHER_GROUP = '120363222222222222@g.us', PHONE = '5562999999999';
const NOW = Date.parse('2026-10-08T15:00:00Z');
const REQUEST = 'Quem tem iPhone 13 Pro 256GB?';
const OFFER = 'iPhone 13 Pro 256GB Azul seminovo bateria 90% R$ 3.000,00 disponível';
async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opportunity-service-')), clock = { at: NOW }, gate = { stopped: false, allowed: true }, sent = [], sounds = [];
  let store = await createStore(dir), service; const stores = [store], services = [];
  store.setSetting('integrationMode', options.mode || 'whatsapp');
  const adapter = new EventEmitter(); adapter.status = { state: options.connected === false ? 'disconnected' : 'connected', mode: options.mode || 'whatsapp' };
  adapter.configureOpportunityCapture = c => { adapter.capture = c; };
  adapter.resolveRecipient = async number => { if (options.resolve) return options.resolve(number); return { jid: `${number}@s.whatsapp.net`, phone: number }; };
  adapter.sendSearchText = async (target, text, sendOptions) => { sendOptions.beforeSubmit(); const entry = { target, text, options: sendOptions }; sent.push(entry); return options.send ? options.send(entry, sent.length) : { status: 'accepted', messageId: sendOptions.clientMessageId }; };
  adapter.reconcile = async id => options.reconcile ? options.reconcile(id) : { status: 'uncertain', messageId: id };
  const scheduler = { getAttemptTimeoutMs: () => options.deadlineMs || 1000,
    runExternalSubmission: async work => work({ beforeSubmit: () => { if (gate.stopped) throw Object.assign(new Error('Parado'), { code: 'AUTOMATION_STOPPED', definitive: true, submitted: false }); } }),
    runBoundedAttempt: async (work, cfg = {}) => {
      const controller = new AbortController(); let timer, late = false;
      const op = Promise.resolve().then(() => work({ signal: controller.signal, timeoutMs: cfg.timeoutMs, beforeSubmit: () => { if (controller.signal.aborted) throw Object.assign(new Error('Aborted'), { definitive: true, submitted: false }); } }));
      op.then(value => { if (late) cfg.onLateResult?.(value); }, e => { if (late) cfg.onLateError?.(e); });
      try { return await Promise.race([op, new Promise((_, reject) => { timer = setTimeout(() => { late = true; controller.abort(); reject(Object.assign(new Error('Timeout'), { code: 'SUBMISSION_TIMEOUT', submitted: 'unknown' })); }, cfg.timeoutMs); })]); } finally { clearTimeout(timer); }
    } };
  function setup() { service = new OpportunityService({ store, adapter, scheduler, now: () => clock.at, isAutomationStopped: () => gate.stopped,
    assertCanCapture: () => gate.allowed, assertCanOperate: actor => { if (actor && actor !== 'owner') throw Object.assign(new Error('Denied'), { code: 'OPPORTUNITY_FORBIDDEN' }); return gate.allowed; }, assertOwnerPermissions: () => gate.allowed,
    sleep: async ms => { clock.at += ms; }, onLocalAlert: payload => sounds.push(payload) }); services.push(service); return service; }
  const groups = options.mode === 'simulated' ? ['sim-1@simulation', 'sim-2@simulation'] : [GROUP, OTHER_GROUP];
  store.upsertGroups(groups.map((id, i) => ({ id, name: `Grupo ${i + 1}`, simulation: options.mode === 'simulated', authorized: true })));
  const item = (id = 'item-1', overrides = {}) => ({ id, type: 'text', text: OFFER, unitReference: `unit-${id}`, availability: { available: true, confirmedAt: NOW, quantity: 1 }, ...overrides });
  const campaign = (id = 'campaign-1', items = [item()]) => ({ id, name: 'Lista real registrada', state: 'draft', groupIds: [], createdAt: NOW, updatedAt: NOW, items });
  store.saveCampaign(campaign()); setup(); service.saveConfig({ enabled: true, monitoredGroupIds: groups, campaignIds: ['campaign-1'], availabilityMode: 'confirmed', mode: options.automatic === false ? 'evaluation' : 'automatic', sound: { burstSeconds: 1 }, ...options.config }, 'owner'); service.start();
  const event = (messageId, patch = {}) => ({ messageId, chatId: groups[0], originalTimestamp: clock.at, timestamp: clock.at, senderNumber: PHONE, senderId: `${PHONE}@s.whatsapp.net`, identityVerified: true, isGroup: true, text: REQUEST, type: 'text', mode: options.mode || 'whatsapp', simulation: options.mode === 'simulated', ...patch });
  const reopen = async () => { await service.stop(); store.close(); store = await createStore(dir); stores.push(store); setup(); service.start(); return service; };
  t.after(async () => { for (const s of services) await s.stop(); for (const s of stores) s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { get store() { return store; }, get service() { return service; }, clock, gate, sent, sounds, adapter, scheduler, event, item, campaign, groups, reopen };
}

test('defaults enforce evaluation, repetition, per-contact and expiry guards', () => {
  const c = normalizeOpportunityConfig(); assert.equal(c.mode, 'evaluation'); assert.equal(c.enabled, false); assert.equal(c.repeatHours, 24); assert.equal(c.contactIntervalMinutes, 30); assert.equal(c.maxPerDay, 3); assert.equal(c.validityMinutes, 120); assert.equal(c.automaticOfferLimit, 1);
  assert.equal(normalizeOpportunityConfig({ mode: 'evaluation' }, { mode: 'automatic', automatic: true }).automatic, false);
  assert.throws(() => normalizeOpportunityConfig({ maxPerDay: 0 })); assert.throws(() => normalizeOpportunityConfig({ sound: { quiet: { start: 'bad' } } }));
});
test('same event and variations across groups preserve origins and send exactly one private response', async t => {
  const f = await fixture(t), a = f.service.handleIncoming(f.event('A'));
  assert.equal(f.service.handleIncoming(f.event('A')).duplicate, true);
  const b = f.service.handleIncoming(f.event('B', { chatId: OTHER_GROUP, text: 'Alguém tem 13 pro 256?' }));
  const c = f.service.handleIncoming(f.event('C', { text: '13 PRO 256??' }));
  assert.equal(b.opportunity.id, a.opportunity.id); assert.equal(c.opportunity.id, a.opportunity.id); await f.service.waitForIdle();
  assert.equal(f.store.listOpportunities().total, 1); assert.equal(f.store.listOpportunityOrigins(a.opportunity.id).length, 3); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].target, `${PHONE}@s.whatsapp.net`);
  assert.equal(f.store.listOpportunityTasks()[0].status, 'accepted'); assert.equal(f.service.getDetail(a.opportunity.id, 'owner').opportunity.groupedLabel, 'Pedido repetido em 2 grupos.');
});
test('same display name never unites different actual sender identities', async t => {
  const f = await fixture(t); f.service.handleIncoming(f.event('A', { displayName: 'João' })); f.service.handleIncoming(f.event('B', { displayName: 'João', senderNumber: '5562888888888', senderId: '5562888888888@s.whatsapp.net' })); await f.service.waitForIdle(); assert.equal(f.store.listOpportunities().total, 2); assert.equal(f.sent.length, 2);
});
test('automatic response is one grouped message even when several safe offers match', async t => {
  const f = await fixture(t); f.store.saveCampaign(f.campaign('campaign-1', [f.item('one'), f.item('two', { text: OFFER.replace('3.000', '2.800') })])); f.service.handleIncoming(f.event('A')); await f.service.waitForIdle(); assert.equal(f.sent.length, 1); assert.match(f.sent[0].text, /2\.800,00/); assert.equal(f.store.listOpportunityTasks()[0].offerIds.length, 1);
});
test('relevant storage change cancels pending answer and requires review without extending expiry', async t => {
  const f = await fixture(t, { connected: false }); const first = f.service.handleIncoming(f.event('A')); f.clock.at += 60000;
  const changed = f.service.handleIncoming(f.event('B', { text: 'Quem tem iPhone 13 Pro 512GB?' })); assert.equal(changed.changedRelevant, true); assert.equal(changed.opportunity.id, first.opportunity.id); assert.equal(changed.opportunity.expiresAt, first.opportunity.expiresAt);
  assert.equal(f.store.listOpportunityTasks()[0].status, 'cancelled'); f.adapter.status.state = 'connected'; await f.service.waitForIdle(); assert.equal(f.sent.length, 0);
});
test('24-hour repetition survives restart and does not permit another offer as substitute', async t => {
  const f = await fixture(t); const first = f.service.handleIncoming(f.event('A')); await f.service.waitForIdle(); await f.reopen(); f.clock.at += 31 * 60000;
  const again = f.service.handleIncoming(f.event('B', { chatId: OTHER_GROUP })); assert.equal(again.opportunity.id, first.opportunity.id); await f.service.waitForIdle(); assert.equal(f.sent.length, 1);
});
test('copied campaign keeps original offer reference and cannot automatically send same unit twice', async t => {
  const f = await fixture(t), first = f.service.handleIncoming(f.event('A')); await f.service.waitForIdle();
  const copy = f.campaign('campaign-copy', [f.item('copied', { unitReference: 'unit-item-1' })]); f.store.saveCampaign(copy); f.service.saveConfig({ campaignIds: ['campaign-1', 'campaign-copy'] }, 'owner');
  const detail = f.service.getDetail(first.opportunity.id, 'owner'); assert.equal(detail.candidates.length, 1); assert.equal(detail.candidates[0].sentBefore, true); assert.equal(detail.candidates[0].eligible, false);
});
test('two independent units of same model remain separate candidates', async t => {
  const f = await fixture(t, { automatic: false }); f.store.saveCampaign(f.campaign('campaign-1', [f.item('one'), f.item('two')])); const op = f.service.handleIncoming(f.event('A')).opportunity;
  assert.equal(f.service.getDetail(op.id, 'owner').candidates.length, 2); assert.equal(f.sent.length, 0);
});
test('uncertain response releases other interested people but keeps repeat guard and late acceptance reconciles once', async t => {
  let resolve; const f = await fixture(t, { deadlineMs: 20, send: (entry, n) => n === 1 ? new Promise(done => { resolve = () => done({ status: 'accepted', messageId: entry.options.clientMessageId }); }) : { status: 'accepted', messageId: entry.options.clientMessageId } });
  const a = f.service.handleIncoming(f.event('A')).opportunity; f.service.handleIncoming(f.event('B', { senderNumber: '5562888888888', senderId: '5562888888888@s.whatsapp.net' })); await f.service.waitForIdle();
  assert.equal(f.sent.length, 2); assert.equal(f.store.listOpportunityTasks({ opportunityId: a.id })[0].status, 'uncertain'); f.service.handleIncoming(f.event('C', { chatId: OTHER_GROUP })); await f.service.waitForIdle(); assert.equal(f.sent.length, 2);
  resolve(); await new Promise(done => setImmediate(done)); assert.equal(f.store.listOpportunityTasks({ opportunityId: a.id })[0].status, 'accepted'); assert.equal(f.sent.length, 2);
});
test('pending requests expire before reconnect and are not dumped into WhatsApp', async t => {
  const f = await fixture(t, { connected: false }); const op = f.service.handleIncoming(f.event('A')).opportunity; f.clock.at += 121 * 60000; f.adapter.status.state = 'connected'; await f.service.waitForIdle(); assert.equal(f.sent.length, 0); assert.equal(f.store.getOpportunity(op.id).status, 'expired'); assert.equal(f.store.listOpportunityTasks()[0].status, 'cancelled');
});
test('same author quoted original can close; ambiguous phrases and another author cannot close', async t => {
  const f = await fixture(t, { connected: false }); const op = f.service.handleIncoming(f.event('A')).opportunity;
  assert.equal(f.service.handleIncoming(f.event('B', { text: 'Achei.' })).review, true); assert.notEqual(f.store.getOpportunity(op.id).status, 'closed');
  f.service.handleIncoming(f.event('C', { text: 'Já consegui.', quotedMessageId: 'A', senderNumber: '5562888888888', senderId: '5562888888888@s.whatsapp.net' })); assert.notEqual(f.store.getOpportunity(op.id).status, 'closed');
  f.service.handleIncoming(f.event('D', { text: 'Pode cancelar.', quotedMessageId: 'A', quotedChatId: OTHER_GROUP })); assert.notEqual(f.store.getOpportunity(op.id).status, 'closed');
  assert.equal(f.service.handleIncoming(f.event('E', { text: 'Não preciso mais.', quotedMessageId: 'A', quotedChatId: GROUP })).closed, true); assert.equal(f.store.getOpportunity(op.id).status, 'closed'); assert.equal(f.store.listOpportunityTasks()[0].status, 'cancelled');
});
test('already answered outside cancels pending and establishes repeat limit', async t => {
  const f = await fixture(t, { connected: false }); const op = f.service.handleIncoming(f.event('A')).opportunity; f.service.outsideAnswer(op.id, 'owner'); assert.equal(f.store.listOpportunityTasks({ status: 'queued' }).length, 0);
  f.adapter.status.state = 'connected'; f.service.handleIncoming(f.event('B', { chatId: OTHER_GROUP })); await f.service.waitForIdle(); assert.equal(f.sent.length, 0); assert.equal(f.store.listOpportunityTasks({ status: 'outside' }).length, 1);
});
test('contact mute cancels pending and reactivation preserves response controls', async t => {
  const f = await fixture(t, { connected: false }); const op = f.service.handleIncoming(f.event('A')).opportunity; f.service.mute(op.id, 'owner'); assert.equal(f.store.getOpportunityContactMute(op.senderKey).muted, true); assert.equal(f.store.listOpportunityTasks()[0].status, 'cancelled');
  f.adapter.status.state = 'connected'; f.service.handleIncoming(f.event('B')); await f.service.waitForIdle(); assert.equal(f.sent.length, 0); f.service.reactivate(op.id, 'owner'); assert.equal(f.store.getOpportunityContactMute(op.senderKey).muted, false);
});
test('unknown availability, condition, battery, budget or quantity never creates blind automatic match', async t => {
  const f = await fixture(t); f.store.saveCampaign(f.campaign('campaign-1', [f.item('unclear', { text: 'iPhone 13 Pro 256GB R$ 3.000,00', availability: undefined, unitReference: undefined })]));
  const op = f.service.handleIncoming(f.event('A', { text: 'Preciso 2 unidades iPhone 13 Pro 256GB Azul seminovo bateria mínima 90% até R$2.500' })).opportunity; await f.service.waitForIdle(); assert.equal(f.sent.length, 0); const detail = f.service.getDetail(op.id, 'owner'); assert.ok(detail.blockers.length);
});
test('manual availability and unit reference confirmation enable safe review without inventing stock', async t => {
  const f = await fixture(t, { automatic: false }); f.store.saveCampaign(f.campaign('campaign-1', [f.item('unknown', { text: 'iPhone 13 Pro 256GB R$ 3.000,00', availability: undefined, unitReference: undefined })]));
  const op = f.service.handleIncoming(f.event('A')).opportunity; let detail = f.service.getDetail(op.id, 'owner'); const id = detail.candidates[0].id; assert.equal(detail.candidates[0].eligible, false);
  f.service.confirmAvailable({ offerId: id, unitReference: 'unidade-revisada-1', quantity: 1 }, 'owner'); detail = f.service.getDetail(op.id, 'owner'); assert.equal(detail.candidates[0].eligible, true);
  const preview = f.service.preview({ id: op.id, offerIds: [id] }, 'owner'); assert.equal(preview.canSend, true); f.service.respondManual({ id: op.id, offerIds: [id], previewToken: preview.previewToken, confirm: true }, 'owner'); await f.service.waitForIdle(); assert.equal(f.sent.length, 1);
});
test('manual preview is required and invalidated when original price changes', async t => {
  const f = await fixture(t, { automatic: false }); const op = f.service.handleIncoming(f.event('A')).opportunity, preview = f.service.preview({ id: op.id }, 'owner');
  assert.throws(() => f.service.respondManual({ id: op.id, offerIds: preview.offerIds, confirm: true }, 'owner'), { code: 'OPPORTUNITY_PREVIEW_STALE' });
  f.store.saveCampaign(f.campaign('campaign-1', [f.item('item-1', { text: OFFER.replace('3.000', '3.100') })])); assert.throws(() => f.service.respondManual({ id: op.id, offerIds: preview.offerIds, previewToken: preview.previewToken, confirm: true }, 'owner'), { code: 'OPPORTUNITY_PREVIEW_STALE' }); assert.equal(f.sent.length, 0);
});
test('updated offer already sent permits explicit reviewed manual resend only', async t => {
  const f = await fixture(t), op = f.service.handleIncoming(f.event('A')).opportunity; await f.service.waitForIdle(); f.store.saveCampaign(f.campaign('campaign-1', [f.item('item-1', { text: OFFER.replace('3.000', '2.900') })]));
  const candidate = f.service.getDetail(op.id, 'owner').candidates[0]; assert.equal(candidate.updatedSinceSent, true); assert.equal(candidate.eligible, false);
  const preview = f.service.preview({ id: op.id, offerIds: [candidate.id], duplicateRiskAcknowledged: true }, 'owner'); assert.equal(preview.canSend, true); assert.match(preview.warnings[0].reason, /já enviada/);
  f.service.respondManual({ id: op.id, offerIds: [candidate.id], duplicateRiskAcknowledged: true, previewToken: preview.previewToken, confirm: true }, 'owner'); await f.service.waitForIdle(); assert.equal(f.sent.length, 2);
});
test('mode is reevaluated after recipient resolution and blocks stale automatic relay', async t => {
  let f; f = await fixture(t, { resolve: async number => { f.service.saveConfig({ mode: 'evaluation' }, 'owner'); return { jid: `${number}@s.whatsapp.net`, phone: number }; } }); f.service.handleIncoming(f.event('A')); await f.service.waitForIdle(); assert.equal(f.sent.length, 0); assert.equal(f.store.listOpportunityTasks()[0].status, 'cancelled');
});
test('evaluation records matches without sending, and unauthorized actor cannot respond', async t => {
  const f = await fixture(t, { automatic: false }); const op = f.service.handleIncoming(f.event('A')).opportunity; await f.service.waitForIdle(); const detail = f.service.getDetail(op.id, 'owner'); assert.equal(detail.candidates[0].eligible, true); assert.equal(f.sent.length, 0); assert.throws(() => f.service.preview({ id: op.id }, 'other'), { code: 'OPPORTUNITY_FORBIDDEN' });
});
test('forwarded, automatic, image captions, commands, ambiguous identity and unmapped LID cannot send', async t => {
  const f = await fixture(t); for (const [id, patch] of [['FWD', { forwarded: true }], ['AUTO', { automaticMessage: true }], ['IMAGE', { type: 'image' }], ['CMD', { text: '!mega apagar tudo' }], ['WHO', { identityVerified: false }]]) assert.equal(f.service.handleIncoming(f.event(id, patch)).ignored, true);
  const op = f.service.handleIncoming(f.event('LID', { senderNumber: null, senderId: '999999999999@lid' })).opportunity; assert(op); await f.service.waitForIdle(); assert.equal(f.sent.length, 0); assert.equal(f.store.getOpportunity(op.id).senderKey, 'account:999999999999@lid');
});
test('first compatible burst generates one sound, later duplicate/status/receipt does not', async t => {
  const f = await fixture(t, { automatic: false }); const a = f.service.handleIncoming(f.event('A')).opportunity; f.service.handleIncoming(f.event('B', { senderNumber: '5562888888888', senderId: '5562888888888@s.whatsapp.net' })); clearTimeout(f.service.notifyTimer); f.service.notifyTimer = null; f.service._flushNotifications(); assert.equal(f.sounds.length, 1); assert.equal(f.sounds[0].count, 2); assert.equal(f.sounds[0].sound.enabled, true);
  f.service.handleIncoming(f.event('A')); f.service.getDetail(a.id, 'owner'); f.adapter.emit('receipt', { messageId: 'UNKNOWN', status: 'delivered' }); f.service._flushNotifications(); assert.equal(f.sounds.length, 1); await f.reopen(); f.service.getDetail(a.id, 'owner'); f.service._flushNotifications(); assert.equal(f.sounds.length, 1);
});
test('quiet hours and persisted minimum sound interval are respected including 24-hour quiet', async t => {
  const f = await fixture(t, { automatic: false, config: { sound: { quiet: { enabled: true, start: '12:00', end: '12:00' } } } }); f.service.handleIncoming(f.event('A')); clearTimeout(f.service.notifyTimer); f.service.notifyTimer = null; f.service._flushNotifications(); assert.equal(f.sounds[0].sound.enabled, false);
  f.service.saveConfig({ sound: { quiet: { enabled: false } } }, 'owner'); f.service.handleIncoming(f.event('B', { senderNumber: '5562888888888', senderId: '5562888888888@s.whatsapp.net' })); clearTimeout(f.service.notifyTimer); f.service.notifyTimer = null; f.service._flushNotifications(); assert.equal(f.sounds[1].sound.enabled, true); await f.reopen();
  f.service.handleIncoming(f.event('C', { senderNumber: '5562777777777', senderId: '5562777777777@s.whatsapp.net' })); clearTimeout(f.service.notifyTimer); f.service.notifyTimer = null; f.service._flushNotifications(); assert.equal(f.sounds[2].sound.enabled, false);
});
test('uncertain reconciliation uses actual adapter reconcile API and preserves duplicate warning', async t => {
  const f = await fixture(t, { send: entry => ({ status: 'uncertain', messageId: entry.options.clientMessageId }), reconcile: id => ({ status: 'delivered', messageId: id, confirmationScope: 'controlled-receipt' }) }); f.service.handleIncoming(f.event('A')); await f.service.waitForIdle(); const task = f.store.listOpportunityTasks()[0]; assert.equal(task.status, 'uncertain'); const reconciled = await f.service.reconcile({ id: task.id }, 'owner'); assert.equal(reconciled.status, 'delivered'); assert.equal(f.sent.length, 1);
});
test('global stop blocks queued and new automatic entries while preserving opportunities', async t => {
  const f = await fixture(t, { connected: false }); f.service.handleIncoming(f.event('A')); f.gate.stopped = true; assert.equal(f.service.cancelAutomatic(), 1); f.adapter.status.state = 'connected'; await f.service.waitForIdle(); assert.equal(f.sent.length, 0); assert.equal(f.service.handleIncoming(f.event('B')).ignored, true); assert.equal(f.store.listOpportunities().total, 1);
});
test('reply formatting keeps only known attributes and does not claim delivery', () => {
  const text = formatOpportunityResponse({}, [{ model: 'iPhone 13 Pro', storageGB: 256, priceCents: 300000 }]); assert.match(text, /3\.000,00/); assert.doesNotMatch(text, /bateria|seminovo|Prata|entregue/i);
});

test('per-contact 30-minute interval and maximum 3 responses in a local day are persistent across models', async t => {
  const f = await fixture(t); const models = ['13 Pro', '14 Pro', '15 Pro', '16 Pro']; f.store.saveCampaign(f.campaign('campaign-1', models.map((model, index) => f.item(`model-${index}`, { text: `iPhone ${model} 256GB R$ 3.000,00 disponível` }))));
  f.service.handleIncoming(f.event('A', { text: 'Quem tem iPhone 13 Pro 256GB?' })); await f.service.waitForIdle();
  const tooSoon = f.service.handleIncoming(f.event('B', { text: 'Quem tem iPhone 14 Pro 256GB?' })).opportunity; await f.service.waitForIdle(); assert.equal(f.sent.length, 1); assert.equal(f.store.getOpportunity(tooSoon.id).lastBlocker.code, 'OP_INTERVAL');
  f.clock.at += 31 * 60000; f.service.handleIncoming(f.event('C', { text: 'Quem tem iPhone 14 Pro 256GB?' })); await f.service.waitForIdle(); assert.equal(f.sent.length, 2);
  await f.reopen(); f.clock.at += 31 * 60000; f.service.handleIncoming(f.event('D', { text: 'Quem tem iPhone 15 Pro 256GB?' })); await f.service.waitForIdle(); assert.equal(f.sent.length, 3);
  f.clock.at += 31 * 60000; const limit = f.service.handleIncoming(f.event('E', { text: 'Quem tem iPhone 16 Pro 256GB?' })).opportunity; await f.service.waitForIdle(); assert.equal(f.sent.length, 3); assert.equal(f.store.getOpportunity(limit.id).lastBlocker.code, 'OP_DAILY_LIMIT');
});
test('multi-model message is one opportunity with grouped manual selection and exactly one response', async t => {
  const f = await fixture(t, { automatic: false }); f.store.saveCampaign(f.campaign('campaign-1', [f.item('13'), f.item('14', { text: 'iPhone 14 Pro 128GB R$ 3.500,00 disponível' })]));
  const op = f.service.handleIncoming(f.event('A', { text: 'Quem tem iPhone 13 Pro 256GB e iPhone 14 Pro 128GB?' })).opportunity; const details = f.service.getDetail(op.id, 'owner'); assert.equal(details.opportunity.requests.length, 2); assert.equal(details.candidates.length, 2);
  const input = { id: op.id, offerIds: details.candidates.map(v => v.id) }; const preview = f.service.preview(input, 'owner'); assert.equal(preview.canSend, true); assert.match(preview.text, /iPhone 13 Pro/); assert.match(preview.text, /iPhone 14 Pro/);
  f.service.respondManual({ ...input, previewToken: preview.previewToken, confirm: true }, 'owner'); await f.service.waitForIdle(); assert.equal(f.sent.length, 1); assert.equal(f.store.listOpportunityTasks()[0].offerIds.length, 2);
});
test('unavailable or different model never becomes an automatic alternative', async t => {
  const f = await fixture(t); f.store.saveCampaign(f.campaign('campaign-1', [f.item('wrong', { text: 'iPhone 13 Pro Max 256GB R$ 2.000,00 disponível' }), f.item('unavailable', { text: 'iPhone 13 Pro 256GB R$ 2.500,00 vendido', availability: { available: false, confirmedAt: NOW } })])); f.service.handleIncoming(f.event('A')); await f.service.waitForIdle(); assert.equal(f.sent.length, 0); assert.equal(f.store.listOpportunityTasks().length, 0);
});
test('trusted edits change request for review and deletes cancel unstarted responses without erasing origins', async t => {
  const f = await fixture(t, { connected: false }); const op = f.service.handleIncoming(f.event('A')).opportunity;
  assert.equal(f.service.handleUpdate(f.event('A', { text: 'Quem tem iPhone 13 Pro 512GB?', originalTimestamp: null })).changedRelevant, true); assert.equal(f.store.getOpportunity(op.id).needsReview, true); assert.equal(f.store.listOpportunityTasks()[0].status, 'cancelled'); assert.equal(f.store.getOpportunity(op.id).expiresAt, op.expiresAt);
  f.service.handleDelete({ messageId: 'A', chatId: GROUP, mode: 'whatsapp', deletedAt: f.clock.at }); assert.equal(f.store.getOpportunity(op.id).status, 'closed'); assert.equal(f.store.listOpportunityOrigins(op.id).length, 1); assert.equal(f.service.handleIncoming(f.event('A')).duplicate, true);
});
test('delete one grouped source does not close a safely remaining origin', async t => {
  const f = await fixture(t, { connected: false }); const op = f.service.handleIncoming(f.event('A')).opportunity; f.service.handleIncoming(f.event('B', { chatId: OTHER_GROUP }));
  f.service.handleDelete({ messageId: 'A', chatId: GROUP, mode: 'whatsapp' }); assert.notEqual(f.store.getOpportunity(op.id).status, 'closed'); assert.equal(f.store.listOpportunityOrigins(op.id).length, 2);
});
test('expiry can only be bypassed by explicit reviewed manual preview, never by reactivate alone', async t => {
  const f = await fixture(t, { automatic: false }); const op = f.service.handleIncoming(f.event('A')).opportunity; f.clock.at += 121 * 60000;
  const candidate = f.service.getDetail(op.id, 'owner').candidates[0]; f.service.confirmAvailable({ offerId: candidate.id, quantity: 1 }, 'owner'); f.service.reactivate(op.id, 'owner'); assert.equal(f.store.getOpportunity(op.id).status, 'expired');
  const denied = f.service.preview({ id: op.id, offerIds: [candidate.id] }, 'owner'); assert.equal(denied.canSend, false);
  const input = { id: op.id, offerIds: [candidate.id], reviewed: true }; const preview = f.service.preview(input, 'owner'); assert.equal(preview.canSend, true); assert.ok(preview.warnings.length);
  f.service.respondManual({ ...input, previewToken: preview.previewToken, confirm: true }, 'owner'); await f.service.waitForIdle(); assert.equal(f.sent.length, 1); assert.equal(f.store.getOpportunity(op.id).expiresAt, op.expiresAt);
});
test('confirmed temporary failures retry with backoff but uncertain results never retry by timer', async t => {
  const f = await fixture(t, { send: (entry, n) => { if (n === 1) throw Object.assign(new Error('Falha temporária antes de enviar.'), { code: 'TEMPORARY', definitive: true, submitted: false, safeToRetry: true }); return { status: 'accepted', messageId: entry.options.clientMessageId }; } }); f.service.handleIncoming(f.event('A')); await f.service.waitForIdle(); assert.equal(f.sent.length, 1); const task = f.store.listOpportunityTasks()[0]; assert.equal(task.status, 'queued'); assert.equal(task.nextAttemptAt, f.clock.at + 30000);
  f.clock.at += 30000; await f.service.waitForIdle(); assert.equal(f.sent.length, 2); assert.equal(f.store.listOpportunityTasks()[0].status, 'accepted');
});
test('automatic setting and deadlines remain stable after reconfiguration, including zero minimum interval', () => {
  const c = normalizeOpportunityConfig({ automatic: false, evaluation: false, contactIntervalMinutes: 0, sound: { quiet: { enabled: true } }, timezone: 'UTC' }, { mode: 'automatic' }); assert.equal(c.mode, 'manual'); assert.equal(c.contactIntervalMinutes, 0); assert.equal(c.sound.quiet.timezone, 'UTC');
});


test('verified LID first and later trusted PN retain one persistent interested person and one alert', async t => {
  const f = await fixture(t, { automatic: false }), lid = '9876543210@lid';
  const first = f.service.handleIncoming(f.event('LID-FIRST', { senderNumber: null, senderId: lid, senderIds: [lid] })).opportunity;
  assert.equal(first.senderKey, `account:${lid}`); assert.equal(first.recipient, undefined);
  const linked = f.service.handleIncoming(f.event('PN-LINK', { chatId: OTHER_GROUP, senderId: lid, senderIds: [lid, `${PHONE}@s.whatsapp.net`], senderNumber: PHONE })).opportunity;
  assert.equal(linked.id, first.id); assert.equal(linked.senderKey, first.senderKey); assert.equal(linked.recipient, PHONE);
  clearTimeout(f.service.notifyTimer); f.service.notifyTimer = null; f.service._flushNotifications(); assert.equal(f.sounds.length, 1); assert.equal(f.sounds[0].count, 1);
  await f.reopen(); f.service.saveConfig({ mode: 'automatic' }, 'owner');
  const pnOnly = f.service.handleIncoming(f.event('PN-ONLY')).opportunity; assert.equal(pnOnly.id, first.id); await f.service.waitForIdle();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].target, `${PHONE}@s.whatsapp.net`); assert.equal(f.store.listOpportunities().total, 1);
  f.service.handleIncoming(f.event('LID-REPEATED', { senderNumber: null, senderId: lid, senderIds: [lid] })); await f.service.waitForIdle();
  assert.equal(f.sent.length, 1); assert.equal(f.store.listOpportunities().total, 1); f.service._flushNotifications(); assert.equal(f.sounds.length, 1);
});
test('conflicting confirmed account aliases are refused instead of merging real people or bypassing limits', async t => {
  const f = await fixture(t, { automatic: false }), lid = '9876543210@lid';
  const a = f.service.handleIncoming(f.event('ONE', { senderNumber: null, senderId: lid })).opportunity;
  const b = f.service.handleIncoming(f.event('TWO')).opportunity; assert.notEqual(a.id, b.id);
  const ambiguous = f.service.handleIncoming(f.event('BAD-LINK', { senderId: lid, senderIds: [lid, `${PHONE}@s.whatsapp.net`] }));
  assert.equal(ambiguous.ignored, true); assert.equal(f.store.listOpportunities().total, 2); assert.equal(f.store.listOpportunityOrigins(a.id).length, 1);
  assert.ok(f.store.listOpportunityTraces().some(row => row.code === 'OP_IDENTITY_AMBIGUOUS'));
  const incompatiblePhone = f.service.handleIncoming(f.event('BAD-PHONE', { senderId: `${PHONE}@s.whatsapp.net`, senderNumber: '5562888888888' }));
  assert.equal(incompatiblePhone.ignored, true); assert.equal(f.sent.length, 0);
});
test('evaluation uses live per-contact limits without reserving tasks and removes elapsed interval blockers', async t => {
  const f = await fixture(t); f.store.saveCampaign(f.campaign('campaign-1', [f.item('13'), f.item('14', { text: OFFER.replace('13 Pro', '14 Pro') })]));
  f.service.handleIncoming(f.event('FIRST')); await f.service.waitForIdle(); f.service.saveConfig({ mode: 'evaluation' }, 'owner');
  const op = f.service.handleIncoming(f.event('NEXT-MODEL', { text: 'Quem tem iPhone 14 Pro 256GB?' })).opportunity;
  const before = f.store.exportOpportunityData(), detail = f.service.getDetail(op.id, 'owner');
  assert.ok(detail.blockers.some(row => row.code === 'OP_INTERVAL')); assert.match(detail.opportunity.reason, /intervalo/);
  const evaluated = await f.service.evaluateAll({}, 'owner'); assert.equal(evaluated.evaluated, 2); assert.equal(evaluated.queued, 0); assert.equal(f.store.listOpportunityTasks().length, 1);
  assert.equal(f.store.exportOpportunityData().lastAt, before.lastAt); assert.deepEqual(f.store.exportOpportunityData().tasks, before.tasks);
  f.clock.at += 31 * 60000; const ready = f.service.getDetail(op.id, 'owner'); assert.equal(ready.blockers.some(row => row.code === 'OP_INTERVAL'), false); assert.doesNotMatch(ready.opportunity.reason, /intervalo/); assert.equal(f.sent.length, 1);
});
test('evaluation shows persisted daily cap after restart without creating automatic sends', async t => {
  const f = await fixture(t); const models = ['13 Pro', '14 Pro', '15 Pro', '16 Pro']; f.store.saveCampaign(f.campaign('campaign-1', models.map((model, index) => f.item(`daily-${index}`, { text: OFFER.replace('13 Pro', model) }))));
  for (let index = 0; index < 3; index++) { f.service.handleIncoming(f.event(`DAILY-${index}`, { text: `Quem tem iPhone ${models[index]} 256GB?` })); await f.service.waitForIdle(); f.clock.at += 31 * 60000; }
  await f.reopen(); f.service.saveConfig({ mode: 'evaluation' }, 'owner');
  const op = f.service.handleIncoming(f.event('FOURTH', { text: 'Quem tem iPhone 16 Pro 256GB?' })).opportunity;
  assert.ok(f.service.getDetail(op.id, 'owner').blockers.some(row => row.code === 'OP_DAILY_LIMIT')); assert.equal(f.sent.length, 3); assert.equal(f.store.listOpportunityTasks().length, 3);
});
test('review of a relevant request change alone cannot bypass an existing contact interval', async t => {
  const f = await fixture(t); f.store.saveCampaign(f.campaign('campaign-1', [f.item('256'), f.item('512', { text: OFFER.replace('256GB', '512GB') })]));
  const op = f.service.handleIncoming(f.event('SENT')).opportunity; await f.service.waitForIdle();
  f.service.handleIncoming(f.event('CHANGED', { text: 'Quem tem iPhone 13 Pro 512GB?' }));
  const candidate = f.service.getDetail(op.id, 'owner').candidates.find(row => row.storageGB === 512);
  const preview = f.service.preview({ id: op.id, offerIds: [candidate.id], reviewed: true }, 'owner'); assert.equal(preview.canSend, false); assert.ok(preview.blockers.some(row => row.code === 'OP_ALREADY_RESPONDED'));
  assert.equal(f.sent.length, 1);
});

test('removing an inconsistent copy clears its conflict only after the remaining original is safe', async t => {
  const f = await fixture(t, { automatic: false }); f.store.saveCampaign(f.campaign('copy', [f.item('copy-item', { unitReference: 'unit-item-1', text: OFFER.replace('3.000', '2.900') })])); f.service.saveConfig({ campaignIds: ['campaign-1', 'copy'] }, 'owner');
  const op = f.service.handleIncoming(f.event('CONFLICT')).opportunity; const conflict = f.service.getDetail(op.id, 'owner').candidates[0]; assert.equal(conflict.copyConflict, true); assert.equal(conflict.eligible, false);
  f.service.saveConfig({ campaignIds: ['campaign-1'] }, 'owner'); const resolved = f.service.getDetail(op.id, 'owner').candidates[0]; assert.equal(resolved.copyConflict, false); assert.equal(resolved.eligible, true); assert.equal(f.sent.length, 0);
});

test('source ledger pending review or failure overrides copied availability and manual availability confirmation', async t => {
  const f = await fixture(t, { automatic: false }), source = f.store.insertSourcePublication({ groupId: GROUP, messageId: 'SOURCE', originalAt: NOW, capturedAt: NOW, revisionAt: NOW, status: 'ready', caption: OFFER, text: OFFER, campaignId: 'campaign-1', itemId: 'item-1', dateKey: '2026-10-08' }).publication;
  f.store.saveCampaign(f.campaign('campaign-1', [f.item('item-1', { sourcePublicationId: source.id, sourcePublicationRevision: NOW })]));
  const op = f.service.handleIncoming(f.event('SOURCE-REQUEST')).opportunity; assert.equal(f.service.getDetail(op.id, 'owner').candidates[0].eligible, true);
  for (const status of ['pending', 'review', 'failed']) {
    f.store.updateSourcePublication(source.id, { status }); const blocked = f.service.getDetail(op.id, 'owner').candidates[0]; assert.equal(blocked.eligible, false); assert.equal(blocked.sourceBlocker.code, 'OFFER_SOURCE_NOT_READY');
    f.service.confirmAvailable({ offerId: blocked.id, quantity: 1 }, 'owner'); assert.equal(f.service.getDetail(op.id, 'owner').candidates[0].eligible, false);
  }
  f.store.updateSourcePublication(source.id, { status: 'ready' }); assert.equal(f.service.getDetail(op.id, 'owner').candidates[0].eligible, true); assert.equal(f.sent.length, 0);
});
test('copied older source revision requires review until copied item references the current original revision', async t => {
  const f = await fixture(t, { automatic: false }), source = f.store.insertSourcePublication({ groupId: GROUP, messageId: 'REVISION-SOURCE', originalAt: NOW, capturedAt: NOW, revisionAt: NOW, status: 'ready', caption: OFFER, text: OFFER, campaignId: 'campaign-1', itemId: 'item-1', dateKey: '2026-10-08' }).publication;
  const copied = f.item('item-1', { sourcePublicationId: source.id, sourcePublicationRevision: NOW }); f.store.saveCampaign(f.campaign('campaign-1', [copied]));
  const op = f.service.handleIncoming(f.event('REVISION-REQUEST')).opportunity; assert.equal(f.service.getDetail(op.id, 'owner').candidates[0].eligible, true);
  f.store.updateSourcePublication(source.id, { revisionAt: NOW + 1 }); const stale = f.service.getDetail(op.id, 'owner').candidates[0]; assert.equal(stale.eligible, false); assert.equal(stale.sourceBlocker.code, 'OFFER_SOURCE_REVISION_STALE');
  f.store.saveCampaign(f.campaign('campaign-1', [{ ...copied, sourcePublicationRevision: NOW + 1 }])); assert.equal(f.service.getDetail(op.id, 'owner').candidates[0].eligible, true); assert.equal(f.sent.length, 0);
});
