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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opportunity-campaign-r3-')), store = await createStore(dir), sent = [], clock = { at: NOW }, adapter = new EventEmitter();
  adapter.status = { state: 'connected', mode: 'whatsapp' }; adapter.minimumSpacingSeconds = 3;
  adapter.configureOpportunityCapture = () => {};
  adapter.resolveRecipient = async phone => { await options.onResolve?.(); return { phone, jid: `${phone}@s.whatsapp.net` }; };
  adapter.sendSearchText = async (target, text, opts) => { opts.beforeSubmit(); sent.push({ target, text, opts, format: 'text' }); return options.send ? options.send(sent.at(-1), sent.length) : { status: 'accepted', messageId: opts.clientMessageId }; };
  adapter.sendPrivateContent = async (target, item, media, opts) => { opts.beforeSubmit(); sent.push({ target, text: item.caption, item, media, opts, format: item.type }); return { status: 'accepted', messageId: opts.clientMessageId }; };
  store.setSetting('integrationMode', 'whatsapp'); store.upsertGroups([{ id: GROUP, name: 'Grupo autorizado', authorized: true }]); store.saveCampaign(campaign(options.items));
  const service = new OpportunityService({ store, adapter, now: options.realtime ? () => Date.now() : () => clock.at,
    assertCanCapture: () => true, assertCanOperate: () => true, assertOwnerPermissions: () => true });
  service.saveConfig({ enabled: true, mode: 'automatic', monitoredGroupIds: [GROUP], campaignIds: ['campaign-12'], ...options.config }, 'owner'); service.start();
  const event = (id, patch = {}) => ({ messageId: id, chatId: GROUP, originalTimestamp: options.realtime ? Date.now() : clock.at,
    senderNumber: '5562999999999', senderId: '5562999999999@s.whatsapp.net', identityVerified: true, isGroup: true, mode: 'whatsapp', type: 'text', text: 'Quem tem iPhone 12 Pro?', ...patch });
  t.after(async () => { await service.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, sent, clock, adapter, service, event };
}

test('campaign declarations are default, independent of inventory, IMEI and manual freshness', async t => {
  assert.equal(normalizeOpportunityConfig().availabilityMode, 'campaign');
  assert.throws(() => normalizeOpportunityConfig({ availabilityMode: 'ignore' }), { code: 'OPPORTUNITY_CONFIG_INVALID' });
  const f = await fixture(t); const op = f.service.handleIncoming(f.event('MANUAL-CAMPAIGN')).opportunity; await f.service.waitForIdle();
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].text, /Detalhe na tela pequeno/);
  const candidate = f.service.getDetail(op.id, 'owner').candidates[0]; assert.equal(candidate.id, 'campaign-item:item-12');
  assert.equal(candidate.identityConfidence, 'campaign'); assert.equal(candidate.availabilitySource, 'campaign'); assert.equal(candidate.availabilityConfirmedAt, null);
  assert.equal(candidate.explicitUnitReference, null); assert.equal(candidate.quantityAvailable, null);
  f.clock.at += 24 * 3600000;
  f.service.handleIncoming(f.event('STILL-CAMPAIGN', { senderId: '5562888888888@s.whatsapp.net', senderNumber: '5562888888888' })); await f.service.waitForIdle(); assert.equal(f.sent.length, 2);
});

test('campaign readiness rejects unavailable, conditional, missing or outdated originals', () => {
  const c = campaign(), source = { id: 'pub-1', status: 'ready', revisionAt: NOW, originalAt: NOW };
  for (const [item, options, code] of [
    [offer({ opportunityAvailable: false }), {}, 'OFFER_EXCLUDED'], [offer({ ready: false }), {}, 'OFFER_ITEM_NOT_READY'],
    [offer({ status: 'reserved' }), {}, 'OFFER_UNAVAILABLE'], [offer({ text: 'iPhone 12 Pro R$1800 vendido' }), {}, 'OFFER_UNAVAILABLE'],
    [offer({ quantityAvailable: 0 }), {}, 'OFFER_UNAVAILABLE'], [offer({ availability: { available: false } }), {}, 'OFFER_UNAVAILABLE'],
    [offer({ text: 'iPhone 12 Pro R$1800 sob encomenda' }), {}, 'OFFER_AVAILABILITY_CONDITIONAL'],
    [offer({ sourcePublicationId: 'pub-1', sourcePublicationRevision: NOW }), {}, 'OFFER_SOURCE_MISSING'],
    [offer({ sourcePublicationId: 'pub-1', sourcePublicationRevision: NOW }), { source: { ...source, status: 'review' } }, 'OFFER_SOURCE_NOT_READY'],
    [offer({ sourcePublicationId: 'pub-1', sourcePublicationRevision: NOW }), { source: { ...source, status: 'removed' } }, 'OFFER_SOURCE_REMOVED'],
    [offer({ sourcePublicationId: 'pub-1', sourcePublicationRevision: NOW - 1 }), { source }, 'OFFER_SOURCE_REVISION_STALE'],
    [offer({ type: 'image', mediaId: 'photo' }), {}, 'OFFER_MEDIA_MISSING']
  ]) assert.equal(assessCampaignItem(item, c, options).blocker.code, code);
  assert.equal(assessCampaignItem(offer(), c).eligible, true);
});

test('campaign fingerprint covers live exclusions and trusted original/media revisions', () => {
  const item = offer(), c = campaign(), before = campaignItemFingerprint(item, c);
  assert.notEqual(campaignItemFingerprint({ ...item, opportunityAvailable: false }, c), before);
  const sourced = { ...item, sourcePublicationId: 'pub-1', sourcePublicationRevision: NOW };
  assert.notEqual(campaignItemFingerprint(sourced, c, { source: { id: 'pub-1', status: 'ready', revisionAt: NOW } }), campaignItemFingerprint(sourced, c, { source: { id: 'pub-1', status: 'removed', revisionAt: NOW } }));
  const image = { ...item, type: 'image', mediaId: 'image-1' };
  assert.notEqual(campaignItemFingerprint(image, c, { media: { id: 'image-1', sha256: 'a'.repeat(64) } }), campaignItemFingerprint(image, c, { media: { id: 'image-1', sha256: 'b'.repeat(64) } }));
});

test('repeated reads and independent requests reuse parsed campaign index', async t => {
  const f = await fixture(t), first = f.service.handleIncoming(f.event('INDEX-1')).opportunity; await f.service.waitForIdle();
  const count = f.service.offerParseCount; assert.equal(count, 1);
  f.service.getDetail(first.id, 'owner'); f.service.list({}, 'owner'); f.service.getState('owner');
  f.service.handleIncoming(f.event('INDEX-2', { senderId: '5562888888888@s.whatsapp.net', senderNumber: '5562888888888' })); await f.service.waitForIdle();
  assert.equal(f.service.offerParseCount, count); assert.equal(f.sent.length, 2);
  f.store.saveCampaign(campaign([offer({ text: offer().text.replace('1.800', '1.750') })]));
  assert.equal(f.service.listCampaignOffers().items[0].priceCents, 175000); assert.equal(f.service.offerParseCount, count + 1);
});

test('single campaign photo is sent once with original notes preserved in its caption', async t => {
  const f = await fixture(t, { items: [offer({ type: 'image', mediaId: 'media-photo', caption: '📱 iPhone 12 Pro 128GB Azul\nR$ 1.800,00\nDetalhe na tela pequeno\nAssinatura da loja' })] });
  f.store.saveMedia({ id: 'media-photo', name: 'foto.jpg', mime: 'image/jpeg', path: path.join(f.store.dir, 'media', 'foto.jpg'), sha256: 'a'.repeat(64) });
  f.service.handleIncoming(f.event('PHOTO-ONCE')); await f.service.waitForIdle();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].format, 'image'); assert.match(f.sent[0].text, /Detalhe na tela pequeno\nAssinatura da loja/);
  assert.equal(f.store.listOpportunityTasks()[0].status, 'accepted');
});

test('new matching campaign item reevaluates only a fresh unanswered request', async t => {
  const f = await fixture(t, { items: [] }); const op = f.service.handleIncoming(f.event('WAIT-FOR-AD')).opportunity; await f.service.waitForIdle(); assert.equal(f.sent.length, 0);
  f.store.saveCampaign(campaign()); const result = f.service.invalidateCampaignOffers({ reevaluate: true }); await f.service.waitForIdle(); assert.equal(result.evaluated, 1); assert.equal(f.sent.length, 1);
  f.service.invalidateCampaignOffers({ reevaluate: true }); await f.service.waitForIdle(); assert.equal(f.sent.length, 1); assert.equal(f.store.getOpportunity(op.id).status, 'responded');
});

test('campaign edits do not dump an old backlog or activate evaluation-mode requests', async t => {
  const f = await fixture(t, { items: [] }); f.service.handleIncoming(f.event('OLD-WAIT')); f.clock.at += 61000;
  f.store.saveCampaign(campaign()); assert.equal(f.service.invalidateCampaignOffers({ reevaluate: true }).evaluated, 0); await f.service.waitForIdle(); assert.equal(f.sent.length, 0);
  f.service.saveConfig({ mode: 'evaluation' }, 'owner'); f.service.handleIncoming(f.event('MANUAL-WAIT', { senderId: '5562888888888@s.whatsapp.net', senderNumber: '5562888888888' }));
  f.service.saveConfig({ mode: 'automatic' }, 'owner'); f.service.invalidateCampaignOffers({ reevaluate: true }); await f.service.waitForIdle(); assert.equal(f.sent.length, 0);
});

test('retry runs at its persisted due time rather than waiting for the 15-second sweep', async t => {
  let firstAt = null;
  const f = await fixture(t, { realtime: true, config: { retryIntervalSeconds: 5 }, send: (entry, n) => {
    if (n === 1) { firstAt = Date.now(); throw Object.assign(new Error('Falha confirmada antes da submissão.'), { code: 'TEMPORARY_TEST', definitive: true, submitted: false, safeToRetry: true }); }
    return { status: 'accepted', messageId: entry.opts.clientMessageId };
  } });
  f.service.handleIncoming(f.event('RETRY-DUE')); await f.service.waitForIdle(); assert.equal(f.store.listOpportunityTasks()[0].status, 'queued');
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Retry não foi executado no prazo.')), 7000); const listener = () => {
    if (f.sent.length === 2 && f.store.listOpportunityTasks()[0].status === 'accepted') { clearTimeout(timer); f.service.off('change', listener); resolve(); }
  }; f.service.on('change', listener); });
  assert.ok(Date.now() - firstAt < 7000); assert.equal(f.sent.length, 2);
});
