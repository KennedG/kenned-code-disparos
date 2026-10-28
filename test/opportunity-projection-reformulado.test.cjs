'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { EventEmitter } = require('node:events');
const { createStore } = require('../src/core/store.cjs');
const { OpportunityService } = require('../src/core/opportunity-service.cjs');
const { parseRequest } = require('../src/core/opportunity-matcher.cjs');
const { assessCampaignItem, campaignItemFingerprint } = require('../src/core/opportunity-campaign.cjs');
const NOW = Date.parse('2026-10-08T15:00:00Z');
const GROUP = '120363111111111111@g.us';
const OTHER_GROUP = '120363222222222222@g.us';
const REQUEST = 'Quem tem iPhone 13 Pro 256GB Azul?';
const CAPTION = '📱 iPhone 13 Pro 256GB Azul seminovo\nBateria: 90%\nR$ 3.000,00\nPequeno detalhe na tela\nDisponível';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-projection-reformulado-'));
  let store = await createStore(dir), service;
  const stores = [store], services = [], clock = { at: NOW }, adapter = new EventEmitter();
  adapter.status = { state: 'disconnected', mode: 'whatsapp' };
  adapter.configureOpportunityCapture = () => {};
  store.setSetting('integrationMode', 'whatsapp');
  store.upsertGroups([{ id: GROUP, name: 'Grupo real A', simulation: false, authorized: true }, { id: OTHER_GROUP, name: 'Grupo real B', simulation: false, authorized: true }]);
  const item = { id: 'image-1', type: 'image', mediaId: 'managed-image-1', caption: CAPTION, unitReference: 'UNIT-1', availability: { available: true, confirmedAt: NOW, quantity: 1 } };
  const mediaPath = path.join(dir, 'fixture-photo.png');
  fs.writeFileSync(mediaPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  const media = store.saveMedia({ id: item.mediaId, name: 'fixture-photo.png', type: 'image', mime: 'image/png', path: mediaPath, size: fs.statSync(mediaPath).size });
  const campaign = { id: 'campaign-1', name: 'Lista real da loja', state: 'draft', groupIds: [], createdAt: NOW, updatedAt: NOW, items: [item] };
  store.saveCampaign(campaign);
  const setup = () => { service = new OpportunityService({ store, adapter, now: () => clock.at, assertCanOperate: () => true, assertCanCapture: () => true, assertOwnerPermissions: () => true }); services.push(service); };
  setup(); service.saveConfig({ enabled: true, monitoredGroupIds: [GROUP, OTHER_GROUP], campaignIds: [campaign.id], mode: 'evaluation', availabilityMode: 'confirmed', sound: { enabled: false, burstSeconds: 1 } }, 'owner');
  const event = (id, patch = {}) => ({ messageId: id, chatId: GROUP, originalTimestamp: clock.at, timestamp: clock.at, senderNumber: '5562999999999', senderId: '5562999999999@s.whatsapp.net', identityVerified: true, isGroup: true, type: 'text', text: REQUEST, profileName: 'Lojista cadastrado', mode: 'whatsapp', ...patch });
  const ingest = (id, patch = {}) => service.handleIncoming(event(id, patch)).opportunity;
  const directIngest = (id, patch = {}) => store.ingestOpportunity({ event: { chatId: GROUP, groupId: GROUP, messageId: `message-${id}`, senderKey: `phone:5562998${String(id).padStart(6, '0')}`, senderName: patch.senderName || `Pessoa ${id}`, recipient: `5562998${String(id).padStart(6, '0')}`, originalAt: NOW + Number(id), text: patch.text || REQUEST, ...patch }, request: parseRequest(patch.text || REQUEST) }, NOW + Number(id)).opportunity;
  const saveOffer = (id, campaignId = 'campaign-1') => {
    const mediaId = store.getStorageMode() === 'simulated' ? `${item.mediaId}-simulated` : item.mediaId;
    if (!store.getMedia(mediaId)) store.saveMedia({ id: mediaId, name: 'fixture-photo.png', type: 'image', mime: 'image/png', path: mediaPath, size: fs.statSync(mediaPath).size });
    const sourceCampaign = store.getCampaign(campaignId) || store.saveCampaign({ ...campaign, id: campaignId, name: `Lista ${campaignId}`, items: [{ ...item, id: `item-${campaignId}`, mediaId, unitReference: `UNIT-${campaignId}` }] });
    const selected = sourceCampaign.items[0], sourceMedia = store.getMedia(selected.mediaId), cfg = store.getOpportunityConfig();
    if (!cfg.campaignIds.includes(campaignId)) store.setOpportunityConfig({ campaignIds: [...cfg.campaignIds, campaignId] });
    const assessment = assessCampaignItem(selected, sourceCampaign, { media: sourceMedia, availabilityMode: cfg.availabilityMode, now: NOW });
    return store.saveOpportunityOffer({ id, campaignId, itemId: selected.id, offerRevision: `revision-${id}`, identityConfidence: 'verified', eligible: true, available: true, availabilityConfirmedAt: NOW, quantityAvailable: 1, model: 'iPhone 13 Pro', modelKey: 'iphone 13 pro', storageGB: 256, color: 'Azul', colorKey: 'blue', confidence: 'confirmed', priceCents: 300000, priceKind: 'cash', ...assessment, campaignEligible: assessment.eligible, campaignItemFingerprint: campaignItemFingerprint(selected, sourceCampaign, { media: sourceMedia }) });
  };
  const reserve = (op, ids = ['shared-offer']) => { const result = store.reserveOpportunitySend({ opportunityId: op.id, offerIds: ids, recipient: op.recipient, clientId: `client-${op.id}`, automatic: true, now: NOW + 20000 }); assert.equal(result.ok, true, JSON.stringify(result)); return result.task; };
  const reopen = async () => { await service.stop(); store.close(); store = await createStore(dir); stores.push(store); setup(); return store; };
  const inspect = callback => { const db = new DatabaseSync(store.filename, { readOnly: true }); try { return callback(db); } finally { db.close(); } };
  t.after(async () => { for (const s of services) await s.stop(); for (const s of stores) { try { s.close(); } catch {} } fs.rmSync(dir, { recursive: true, force: true }); });
  return { get store() { return store; }, get service() { return service; }, clock, campaign, item, event, ingest, directIngest, saveOffer, reserve, reopen, inspect };
}

test('production projection preserves original request, real source identity and the compatible managed photo with exact details', async t => {
  const f = await fixture(t), original = f.ingest('first-request'); f.ingest('second-request', { chatId: OTHER_GROUP, text: 'Alguém tem 13 pro 256 Azul?' });
  const presented = f.service.list({ section: 'new' }, 'owner').items[0];
  assert.equal(presented.id, original.id); assert.equal(presented.originalText, REQUEST);
  assert.deepEqual(presented.originPreview, { messageId: 'first-request', groupId: GROUP, groupName: 'Grupo real A', originalAt: NOW, text: REQUEST });
  assert.equal(presented.originCount, 2); assert.equal(presented.groupCount, 2); assert.equal(presented.senderName, 'Lojista cadastrado'); assert.equal(presented.senderPhone, '5562999999999');
  const match = presented.matchPreview; assert.ok(match); assert.equal(match.campaignId, f.campaign.id); assert.equal(match.campaignName, f.campaign.name); assert.equal(match.itemId, f.item.id); assert.equal(match.mediaId, f.item.mediaId); assert.equal(match.mediaType, 'image');
  assert.equal(match.model, 'iPhone 13 Pro'); assert.equal(match.storageGB, 256); assert.equal(match.color, 'Azul'); assert.equal(match.priceCents, 300000); assert.equal(match.available, true); assert.equal(match.availabilityConfirmedAt, NOW); assert.equal(match.sentBefore, false);
  assert.match(match.text, /Pequeno detalhe na tela/); assert.match(match.text, /3\.000,00/); assert.equal(Object.hasOwn(match, 'supplierPhone'), false);
  assert.equal(f.store.listOpportunityTasks().length, 0, 'evaluation does not create a send task');
});

test('deleted campaign, missing item or incompatible exact model never becomes a fabricated preview from stale offer records', async t => {
  const f = await fixture(t), op = f.ingest('request'); assert.ok(f.service.getDetail(op.id, 'owner').opportunity.matchPreview);
  const storedOffers = f.store.exportOpportunityData().offers; assert.ok(storedOffers.length);
  f.store.saveCampaign({ ...f.campaign, items: [{ ...f.item, caption: CAPTION.replace('13 Pro', '13 Pro Max') }] });
  assert.equal(f.service.list({ section: 'new' }, 'owner').items[0].matchPreview, null);
  f.store.saveCampaign({ ...f.campaign, items: [] }); assert.equal(f.service.list({}, 'owner').items[0].matchPreview, null);
  f.store.deleteCampaign(f.campaign.id); const after = f.service.getDetail(op.id, 'owner');
  assert.equal(after.opportunity.matchPreview, null); assert.equal(after.candidates.length, 0); assert.equal(after.opportunity.originalText, REQUEST); assert.ok(f.store.exportOpportunityData().offers.length, 'operational offers retained, but not projected as a live campaign');
});

test('production sections and query are applied before counts and pagination, including matches outside the first unfiltered page', async t => {
  const f = await fixture(t), rows = [];
  const statuses = ['open', 'queued', 'sending', 'responded', 'uncertain', 'closed', 'expired', 'cancelled'];
  for (let i = 0; i < 32; i++) { const status = statuses[i % statuses.length], op = f.directIngest(i + 1, { senderName: i < 16 ? `Needle ${i}` : `Recent person ${i}` }); f.store.updateOpportunity(op.id, { status }); rows.push({ id: op.id, status }); }
  const check = (section, expected) => {
    const first = f.store.listOpportunities({ section, query: 'needle', limit: 2, offset: 0 }), next = f.store.listOpportunities({ section, query: 'needle', limit: 2, offset: 2 });
    const wanted = rows.slice(0, 16).filter(row => expected.includes(row.status));
    assert.equal(first.total, wanted.length); assert.equal(next.total, wanted.length); assert.ok(first.items.every(row => expected.includes(row.status) && row.senderName.startsWith('Needle')));
    assert.ok(next.items.every(row => expected.includes(row.status) && row.senderName.startsWith('Needle'))); assert.equal(new Set([...first.items, ...next.items].map(row => row.id)).size, first.items.length + next.items.length);
    const all = f.store.listOpportunities({ section, query: 'NEEDLE', limit: 200 }); assert.deepEqual(new Set(all.items.map(row => row.id)), new Set(wanted.map(row => row.id)));
  };
  check('new', ['open']); check('following', ['queued', 'sending', 'responded', 'uncertain']); check('closed', ['closed', 'expired', 'cancelled']);
  assert.throws(() => f.store.listOpportunities({ section: 'not-a-section' }), /Seção de oportunidades inválida/);
  assert.equal(f.store.listOpportunities({ section: 'new', status: 'uncertain' }).total, 0);
});

test('review metric counts only flagged active requests and stays isolated between real and simulation data', async t => {
  const f = await fixture(t);
  for (const [i, status] of ['open', 'queued', 'sending', 'responded', 'uncertain', 'closed', 'expired', 'cancelled'].entries()) { const op = f.directIngest(i + 1); f.store.updateOpportunity(op.id, { needsReview: true, status }); }
  const unflagged = f.directIngest(100); f.store.updateOpportunity(unflagged.id, { needsReview: false });
  assert.equal(f.store.getOpportunityMetrics().review, 5);
  f.store.setSetting('integrationMode', 'simulated'); assert.equal(f.store.getOpportunityMetrics().review, 0); assert.equal(f.store.listOpportunities().total, 0);
  f.store.setSetting('integrationMode', 'whatsapp'); assert.equal(f.store.getOpportunityMetrics().review, 5); assert.equal(f.store.listOpportunities().total, 9);
});

test('campaign invalidation cancels all 405 queued references in bounded batches, preserves other campaigns and submission proofs across reopening', async t => {
  const f = await fixture(t); f.store.setOpportunityConfig({ mode: 'automatic', autoMaxOffers: 2 }); f.saveOffer('shared-offer'); f.saveOffer('other-offer', 'campaign-10');
  const pending = [];
  for (let i = 1; i <= 405; i++) pending.push(f.reserve(f.directIngest(i)));
  const other = f.reserve(f.directIngest(500), ['other-offer']);
  const mixed = f.reserve(f.directIngest(501), ['shared-offer', 'other-offer']);
  const sending = f.reserve(f.directIngest(502)); assert.equal(f.store.claimOpportunityTask(sending.id, { now: NOW + 20000 }).ok, true);
  const uncertain = f.reserve(f.directIngest(503)); assert.equal(f.store.claimOpportunityTask(uncertain.id, { now: NOW + 20000 }).ok, true); f.store.updateOpportunityTask(uncertain.id, { status: 'uncertain', resultAt: NOW + 20001 });
  const accepted = f.reserve(f.directIngest(504)); assert.equal(f.store.claimOpportunityTask(accepted.id, { now: NOW + 20001 }).ok, true); f.store.updateOpportunityTask(accepted.id, { status: 'accepted', messageId: 'confirmed-before-delete', acceptedAt: NOW + 20002 });
  const beforeLedger = f.store.exportOpportunityData().sentOffers;
  const result = f.store.cancelOpportunityCampaign('campaign-1', NOW + 21000); assert.deepEqual(result, { cancelled: 406, inProgress: 1 });
  for (const task of [...pending, mixed]) { const cancelled = f.store.getOpportunityTask(task.id); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.code, 'OP_CAMPAIGN_REMOVED'); }
  assert.equal(f.store.getOpportunityTask(other.id).status, 'queued'); assert.equal(f.store.getOpportunityTask(sending.id).status, 'sending'); assert.equal(f.store.getOpportunityTask(uncertain.id).status, 'uncertain'); assert.equal(f.store.getOpportunityTask(accepted.id).status, 'accepted');
  assert.equal(f.store.exportOpportunityData().sentOffers.length, beforeLedger.length, 'deletion must preserve reserved and submitted identities');
  assert.deepEqual(f.store.cancelOpportunityCampaign('campaign-1', NOW + 21001), { cancelled: 0, inProgress: 1 });
  await f.reopen(); assert.equal(f.store.getOpportunityTask(pending[0].id).status, 'cancelled'); assert.equal(f.store.getOpportunityTask(pending.at(-1).id).status, 'cancelled'); assert.equal(f.store.getOpportunityTask(uncertain.id).status, 'uncertain'); assert.equal(f.store.getOpportunityTask(other.id).status, 'queued');
  assert.equal(f.store.recoverOpportunityTasks(NOW + 22000).uncertain, 1); assert.equal(f.store.getOpportunityTask(sending.id).status, 'uncertain');
  f.store.updateOpportunityTask(sending.id, { status: 'accepted', messageId: 'late-integration-proof', acceptedAt: NOW + 22001 });
  f.store.updateOpportunityTask(sending.id, { status: 'delivered', messageId: 'late-integration-proof', deliveredAt: NOW + 22002 });
  assert.equal(f.store.getOpportunityTask(sending.id).status, 'delivered'); assert.equal(f.store.getOpportunityTask(sending.id).messageId, 'late-integration-proof');
  assert.equal(f.store.claimOpportunityTask(sending.id, { now: NOW + 22003 }).ok, false);
  const counts = f.inspect(db => db.prepare('SELECT status,COUNT(*) n FROM op_tasks WHERE storageMode=? GROUP BY status').all('whatsapp'));
  assert.equal(counts.find(row => row.status === 'cancelled').n, 406); assert.equal(counts.find(row => row.status === 'queued').n, 1); assert.equal(counts.find(row => row.status === 'uncertain').n, 1); assert.equal(counts.find(row => row.status === 'accepted').n, 1); assert.equal(counts.find(row => row.status === 'delivered').n, 1);
});

test('failure while cancelling a campaign rolls back tasks, request statuses and operational ledgers together', async t => {
  const f = await fixture(t); f.store.setOpportunityConfig({ mode: 'automatic' }); f.saveOffer('shared-offer');
  const tasks = [1, 2, 3].map(id => f.reserve(f.directIngest(id)));
  const before = f.store.exportOpportunityData();
  const db = new DatabaseSync(f.store.filename); db.exec(`CREATE TRIGGER fail_campaign_cancellation BEFORE UPDATE ON op_tasks WHEN NEW.id='${tasks[1].id}' BEGIN SELECT RAISE(ABORT,'TEST_CANCELLATION_WRITE_FAILURE'); END;`);
  try { assert.throws(() => f.store.cancelOpportunityCampaign('campaign-1', NOW + 22000), /TEST_CANCELLATION_WRITE_FAILURE/); }
  finally { db.exec('DROP TRIGGER fail_campaign_cancellation'); db.close(); }
  assert.deepEqual(f.store.exportOpportunityData(), before); assert.ok(tasks.every(task => f.store.getOpportunityTask(task.id).status === 'queued'));
  assert.deepEqual(f.store.cancelOpportunityCampaign('campaign-1', NOW + 22001), { cancelled: 3, inProgress: 0 });
});

test('compatible projection leaves unknown color and condition empty and never turns an unmapped LID into a phone', async t => {
  const f = await fixture(t);
  const caption = 'iPhone 13 Pro 256GB\nR$ 3.000,00\nDisponível';
  f.store.saveCampaign({ ...f.campaign, items: [{ ...f.item, caption }] });
  const op = f.ingest('lid-request', { text: 'Quem tem iPhone 13 Pro 256GB?', senderNumber: null, senderId: '12345678912345@lid', profileName: '' });
  const presented = f.service.getDetail(op.id, 'owner').opportunity;
  assert.equal(presented.senderPhone, null); assert.equal(presented.senderId, '12345678912345@lid'); assert.equal(presented.senderName, '');
  assert.ok(presented.matchPreview); assert.equal(presented.matchPreview.color, null); assert.equal(presented.matchPreview.condition, null); assert.equal(presented.matchPreview.priceCents, 300000);
  assert.equal(presented.originalText, 'Quem tem iPhone 13 Pro 256GB?'); assert.equal(f.store.listOpportunityTasks().length, 0);
});

test('campaign cancellation is scoped to the current real or simulation storage mode', async t => {
  const f = await fixture(t); f.store.setOpportunityConfig({ mode: 'automatic' }); f.saveOffer('shared-offer'); const real = f.reserve(f.directIngest(1));
  const simulationCampaignId = 'campaign-1-simulated';
  f.store.setSetting('integrationMode', 'simulated'); f.store.setOpportunityConfig({ enabled: true, mode: 'automatic' }); f.saveOffer('shared-offer', simulationCampaignId); const simulated = f.reserve(f.directIngest(2));
  assert.deepEqual(f.store.cancelOpportunityCampaign('campaign-1', NOW + 21000), { cancelled: 0, inProgress: 0 }); assert.equal(f.store.getOpportunityTask(simulated.id).status, 'queued');
  assert.deepEqual(f.store.cancelOpportunityCampaign(simulationCampaignId, NOW + 21000), { cancelled: 1, inProgress: 0 }); assert.equal(f.store.getOpportunityTask(simulated.id).status, 'cancelled');
  f.store.setSetting('integrationMode', 'whatsapp'); assert.equal(f.store.getOpportunityTask(real.id).status, 'queued'); assert.equal(f.store.getOpportunityTask(simulated.id), undefined);
  assert.deepEqual(f.store.cancelOpportunityCampaign('campaign-1', NOW + 21001), { cancelled: 1, inProgress: 0 }); assert.equal(f.store.getOpportunityTask(real.id).status, 'cancelled');
});
