'use strict';

// Real SQLite/campaign provenance regressions. Transport is not connected.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createStore } = require('../src/core/store.cjs');
const { normalizeOpportunityConfig } = require('../src/core/opportunity-store.cjs');
const { parseRequest, parseCampaignOffer } = require('../src/core/opportunity-matcher.cjs');
const { assessCampaignItem, campaignItemFingerprint } = require('../src/core/opportunity-campaign.cjs');

const NOW = Date.parse('2026-10-19T15:00:00Z');
const GROUP = '120363000000024@g.us';
const PHONE = '5562999991002';
async function fixture(t, config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-availability-r3-'));
  const stores = [], open = async () => { const store = await createStore(dir); stores.push(store); return store; };
  const store = await open(); store.setSetting('integrationMode', 'whatsapp');
  const item = { id: 'campaign-item-12-pro', type: 'text', text: '📱 iPhone 12 Pro 256GB Azul\nBateria 85%\nR$ 1.999,00\nPequena marca na lateral.', originalAt: NOW - 30 * 86400000 };
  const campaign = store.saveCampaign({ id: 'selected-campaign', name: 'Aparelhos para divulgar', state: 'draft', createdAt: item.originalAt, items: [item], groupIds: [] });
  store.setOpportunityConfig({ enabled: true, mode: 'automatic', campaignIds: [campaign.id], monitoredGroupIds: [GROUP], ...config });
  const ingest = (patch = {}) => store.ingestOpportunity({ event: { chatId: GROUP, messageId: 'ask-12-pro', senderKey: `phone:${PHONE}`, recipient: `${PHONE}@s.whatsapp.net`, originalAt: NOW, text: 'Quem tem iPhone 12 Pro 256GB?', ...patch }, request: parseRequest(patch.text || 'Quem tem iPhone 12 Pro 256GB?') }, NOW).opportunity;
  const project = (campaignId = campaign.id) => {
    const current = store.getCampaign(campaignId), selected = current.items[0];
    const source = selected.sourcePublicationId ? store.getSourcePublication(selected.sourcePublicationId) : undefined;
    const media = selected.mediaId ? store.getMedia(selected.mediaId) : undefined;
    const parsed = parseCampaignOffer(selected, current, media, { now: NOW })[0]; assert(parsed, 'expected parsed campaign offer');
    const assessment = assessCampaignItem(selected, current, { source, media, now: NOW, availabilityMode: store.getOpportunityConfig().availabilityMode });
    const campaignIdentity = store.getOpportunityConfig().availabilityMode === 'campaign' && parsed.identityConfidence !== 'verified';
    const offer = { ...parsed, ...assessment, id: campaignIdentity ? assessment.identityReference : parsed.offerKey || parsed.id, ...(campaignIdentity ? { identityConfidence: 'campaign', identityReason: 'campaign_item_reference' } : {}), campaignId: current.id, itemId: selected.id, offerRevision: parsed.offerRevision || 'revision', eligible: true, campaignEligible: assessment.eligible, campaignItemFingerprint: campaignItemFingerprint(selected, current, { source, media }) };
    delete offer.blocker;
    return store.saveOpportunityOffer(offer);
  };
  const reserve = (opportunity, offer, patch = {}) => store.reserveOpportunitySend({ opportunityId: opportunity.id, offerIds: [offer.id], recipient: opportunity.recipient, clientId: `send-${opportunity.id}`, automatic: true, now: NOW, ...patch });
  t.after(() => { for (const db of stores) db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, open, campaign, item, ingest, project, reserve };
}

test('campaign availability is default, validates strict enum and persists independently of a TTL', async t => {
  assert.equal(normalizeOpportunityConfig().availabilityMode, 'campaign');
  for (const bad of [null, false, 1, 'stock', 'CAMPAIGN', {}, []]) assert.throws(() => normalizeOpportunityConfig({ availabilityMode: bad }), /disponibilidade/i);
  const f = await fixture(t); f.store.setOpportunityConfig({ availabilityMode: 'confirmed', availabilityMaxAgeMinutes: 30 });
  const reopened = await f.open(); assert.equal(reopened.getOpportunityConfig().availabilityMode, 'confirmed'); assert.equal(reopened.getOpportunityConfig().availabilityMaxAgeMinutes, 30);
});

test('an exact declared campaign item can reserve automatically without stock lookup, IMEI or manual freshness', async t => {
  const f = await fixture(t), op = f.ingest(), offer = f.project();
  assert.equal(offer.available, true); assert.equal(offer.availabilityDeclared, true); assert.equal(offer.availabilityConfirmedAt, null);
  assert.equal(offer.explicitUnitReference, null); assert.equal(f.reserve(op, offer).ok, true);
  assert.equal(f.store.listOpportunityTasks()[0].availabilityMode, 'campaign');
});

test('the final guard never authorizes a different version of the requested phone', async t => {
  const f = await fixture(t); f.store.saveCampaign({ ...f.campaign, items: [{ ...f.item, text: f.item.text.replace('12 Pro', '12 Pro Max') }] });
  const offer = f.project(), op = f.ingest(); assert.equal(f.reserve(op, offer).matchCode, 'MODEL_MISMATCH');
});

test('the selected campaign and its current item are re-read before claiming a queued response', async t => {
  for (const change of ['campaign-removed', 'item-removed', 'selection-removed', 'price-edited', 'item-disabled', 'sold', 'reserved', 'quantity-zero']) {
    const f = await fixture(t), op = f.ingest(), offer = f.project(), queued = f.reserve(op, offer); assert(queued.ok, change);
    if (change === 'campaign-removed') f.store.deleteCampaign(f.campaign.id);
    else if (change === 'selection-removed') f.store.setOpportunityConfig({ campaignIds: [] });
    else {
      const patch = change === 'price-edited' ? { text: f.item.text.replace('1.999', '2.099') } : change === 'item-disabled' ? { opportunityAvailable: false } : change === 'quantity-zero' ? { availability: { quantity: 0 } } : { status: change };
      f.store.saveCampaign({ ...f.campaign, items: change === 'item-removed' ? [] : [{ ...f.item, ...patch }] });
    }
    const result = f.store.claimOpportunityTask(queued.task.id, { now: NOW }); assert.equal(result.ok, false, change);
    assert.equal(f.store.getOpportunityTask(queued.task.id).status, 'cancelled', change);
  }
});

test('late campaign edits after claim are caught again immediately before submission', async t => {
  const f = await fixture(t), op = f.ingest(), offer = f.project(), queued = f.reserve(op, offer);
  assert(f.store.claimOpportunityTask(queued.task.id, { now: NOW }).ok);
  f.store.saveCampaign({ ...f.campaign, items: [{ ...f.item, availability: { available: false } }] });
  assert.equal(f.store.finalGuardOpportunitySend(queued.task.id, { now: NOW }).ok, false);
});

test('campaign availability mode cannot remove explicit unavailable, pending or conditional source blockers', async t => {
  for (const patch of [{ available: false }, { availability: { available: false } }, { availability: { quantity: 0 } }, { captureDeleted: true }, { ready: false }, { text: fText('sob encomenda') }, { text: fText('reservado') }]) {
    const f = await fixture(t); f.store.saveCampaign({ ...f.campaign, items: [{ ...f.item, ...patch }] });
    const current = f.store.getCampaign(f.campaign.id), assessment = assessCampaignItem(current.items[0], current, { availabilityMode: 'campaign', now: NOW }); assert.equal(assessment.eligible, false, JSON.stringify(patch));
  }
  function fText(state) { return `iPhone 12 Pro 256GB R$ 1.999,00 ${state}`; }
});

test('a removed or edited original publication blocks a cached campaign offer at the final guard', async t => {
  for (const change of ['removed', 'review', 'revision']) {
    const f = await fixture(t), source = f.store.saveSourcePublication({ id: 'original-photo', groupId: GROUP, messageId: 'original-message', originalAt: NOW - 60000, capturedAt: NOW - 60000, revisionAt: NOW - 60000, status: 'ready', campaignId: f.campaign.id });
    f.store.saveCampaign({ ...f.campaign, items: [{ ...f.item, sourcePublicationId: source.id, sourcePublicationRevision: source.revisionAt }] });
    const op = f.ingest(), offer = f.project(), queued = f.reserve(op, offer); assert(queued.ok, change);
    f.store.saveSourcePublication({ ...source, status: change === 'revision' ? 'ready' : change, revisionAt: NOW });
    assert.equal(f.store.claimOpportunityTask(queued.task.id, { now: NOW }).ok, false, change);
  }
});

test('switching availability rules does not make old pending tasks eligible without a new review', async t => {
  const f = await fixture(t), op = f.ingest(), offer = f.project(), queued = f.reserve(op, offer); assert(queued.ok);
  f.store.setOpportunityConfig({ availabilityMode: 'confirmed' });
  assert.equal(f.store.claimOpportunityTask(queued.task.id, { now: NOW }).code, 'OP_REVIEW');
  f.store.setOpportunityConfig({ availabilityMode: 'campaign' }); f.project();
  assert.equal(f.store.claimOpportunityTask(queued.task.id, { now: NOW }).code, 'OP_TASK_STATE');
});

test('confirmed availability mode retains its manual confirmation age limit', async t => {
  const f = await fixture(t, { availabilityMode: 'confirmed' });
  f.store.saveCampaign({ ...f.campaign, items: [{ ...f.item, unitReference: 'test-unit', availability: { available: true, confirmedAt: NOW - 121 * 60000, quantity: 1 } }] });
  const op = f.ingest(), offer = f.project(); assert.equal(f.reserve(op, offer).matchCode, 'AVAILABILITY_STALE');
});

test('intent filters apply in SQLite to the complete result set and reject invalid values', async t => {
  const f = await fixture(t);
  for (let n = 0; n < 51; n++) f.store.ingestOpportunity({ event: { chatId: GROUP, messageId: `review-${n}`, senderKey: `account-${n}`, originalAt: NOW, text: 'pedido para revisão' }, request: { intentKey: `review-${n}`, familyKey: `review-${n}`, safe: false, complete: false, models: [] } }, NOW);
  f.ingest();
  const clear = f.store.listOpportunities({ intent: 'clear', limit: 1 }); assert.equal(clear.total, 1); assert.equal(clear.items.length, 1); assert.equal(clear.items[0].needsReview, false);
  const review = f.store.listOpportunities({ intent: 'review', limit: 10, offset: 50 }); assert.equal(review.total, 51); assert.equal(review.items.length, 1);
  assert.equal(f.store.listOpportunities({ intent: 'all' }).total, 52);
  assert.throws(() => f.store.listOpportunities({ intent: 'unsafe' }), /intenção/i);
});
