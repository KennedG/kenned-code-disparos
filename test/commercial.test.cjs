'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../src/core/store.cjs');
const { CommercialService, calculateMarkup, normalizeMarkup, zonedScheduleAllowed } = require('../src/core/commercial.cjs');
const AT = Date.UTC(2026, 9, 5, 18, 0); // 15:00 Brasília
const GROUP = '1234567890@g.us';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-commerce-'));
  const store = await createStore(dir);
  store.setSetting('integrationMode', 'whatsapp');
  store.upsertGroups([{ id: GROUP, name: 'Grupo autorizado real de teste', authorized: true, simulation: false }]);
  const service = new CommercialService({ store, now: () => AT });
  const product = store.saveEntity('inventory', { id: 'stock1', kind: 'device', model: 'iPhone 15 Pro Max', storage: '256GB', color: 'Azul', condition: 'seminovo', quantity: 1, reservedQuantity: 0, availableQuantity: 1, status: 'available', costCents: 300000, retailCents: 390000, wholesaleCents: 350000, supplierId: 'private-supplier', imei: 'SECRET-IMEI-123456', notes: 'Custo interno confidencial', updatedAt: AT - 1000 });
  const offer = { id: 'offer1', model: 'iPhone 15 Pro Max', storageGB: 256, color: 'Silver', condition: 'lacrado', priceCents: 350000, priceKind: 'cash', confidence: 'confirmed', status: 'active', supplierName: 'Fornecedor interno', supplierPhone: '5562999990001', originalExcerpt: 'iPhone 15 Pro Max 256GB Silver lacrado R$ 3.500,00', revisionAt: AT - 30000 };
  store.upsertSearchMessage({ chatId: GROUP, messageId: 'msg1', senderId: 'trusted-supplier', originalAt: AT - 30000, revisionAt: AT - 30000, text: offer.originalExcerpt }, [offer]);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, service, product, offer: store.getSearchOffer(offer.id) };
}
function stockList(service, input = {}) {
  return service.saveCommercialList({ name: 'Lista varejo', audience: 'retail', lines: [{ sourceType: 'inventory', sourceId: 'stock1' }], ...input }, 'admin');
}
function campaign(service, store, list) {
  service.setPromotionTarget({ type: 'group', targetId: GROUP, audience: list.audience });
  const item = service.toCampaignItems(list.id)[0];
  return { campaign: { id: 'campaign1', audience: list.audience, commercialListId: list.id, groupIds: [GROUP] }, job: { id: 'job1', groupId: GROUP, itemId: item.id, itemSnapshot: item } };
}

test('fixed and percentage rules are additions over cost, with exact cent rounding', () => {
  assert.deepEqual(calculateMarkup(300000, { type: 'fixed', value: '500,00' }), { costCents: 300000, priceCents: 350000, profitCents: 50000, markup: { type: 'fixed', valueCents: 50000 }, calculation: 'acrescimo_sobre_custo', profitType: 'estimated' });
  assert.equal(calculateMarkup(300000, { type: 'percent', value: '20' }).priceCents, 360000);
  assert.equal(calculateMarkup(101, { type: 'percent', basisPoints: 5000 }).priceCents, 152);
  assert.equal(calculateMarkup(10001, { type: 'percent', value: '12.25' }).priceCents, 11226);
  assert.equal(calculateMarkup(300000, { type: 'percent', value: '20' }).priceCents === 375000, false); // sales margin would be 3750
});

test('invalid or overflowing money and ambiguous percentages are rejected', () => {
  for (const input of [{ type: 'fixed', value: '-1' }, { type: 'percent', value: '20.123' }, { type: 'margin', value: 20 }, { type: 'fixed', valueCents: 0.1 }]) assert.throws(() => normalizeMarkup(input));
  assert.throws(() => calculateMarkup(0.1, { type: 'fixed', valueCents: 1 }), { code: 'COST_INVALID' });
  assert.throws(() => calculateMarkup(1_000_000_000_000, { type: 'fixed', valueCents: 1 }), { code: 'PRICE_LIMIT' });
});

test('retail, wholesale and per-device overrides are independent and persist', async t => {
  const { store, service } = await fixture(t);
  service.saveSettings({ retailMarkup: { type: 'percent', value: '30' }, wholesaleMarkup: { type: 'fixed', valueCents: 50000 } });
  assert.equal(stockList(service).lines[0].priceCents, 390000);
  assert.equal(stockList(service, { audience: 'wholesale' }).lines[0].priceCents, 350000);
  assert.equal(stockList(service, { lines: [{ sourceType: 'inventory', sourceId: 'stock1', markup: { type: 'fixed', valueCents: 12000 } }] }).lines[0].priceCents, 312000);
  assert.equal(new CommercialService({ store }).settings().wholesaleMarkup.valueCents, 50000);
});

test('public preview strips cost, profit, supplier contact, IMEI and internal notes and labels stock versus order', async t => {
  const { service } = await fixture(t);
  const list = stockList(service, { lines: [{ sourceType: 'inventory', sourceId: 'stock1', markup: { type: 'fixed', valueCents: 50000 } }, { sourceType: 'offer', sourceId: 'offer1', markup: { type: 'percent', value: '10' } }] });
  const preview = service.previewCommercialList(list.id);
  assert.equal(preview.totalCostCents, 650000); assert.equal(preview.totalPriceCents, 735000); assert.equal(preview.totalEstimatedProfitCents, 85000);
  assert.match(preview.text, /Pronta entrega/); assert.match(preview.text, /Sob encomenda/);
  const publicJSON = JSON.stringify({ text: preview.text, lines: service.publicList(list).lines, items: service.toCampaignItems(list.id) });
  for (const secret of ['costCents', 'profitCents', 'supplierPhone', '5562999990001', 'SECRET-IMEI', 'Custo interno', 'Fornecedor interno']) assert.equal(publicJSON.includes(secret), false, secret);
});

test('missing color, condition, battery or warranty is omitted rather than invented', async t => {
  const { store, service, product } = await fixture(t);
  store.saveEntity('inventory', { ...product, color: null, condition: null, warranty: null });
  const preview = service.previewCommercialList(stockList(service).id);
  assert.equal('color' in preview.lines[0].facts, false); assert.equal('condition' in preview.lines[0].facts, false);
  assert.doesNotMatch(preview.text, /lacrado|seminovo|Bateria|Garantia/);
});

test('installment, entry, unknown-price or ambiguous supplier offers cannot become commercial confirmed prices', async t => {
  const { store, service, offer } = await fixture(t);
  for (const patch of [{ priceKind: 'installment' }, { priceKind: 'entry' }, { confidence: 'review' }, { priceCents: null }, { status: 'unavailable' }]) {
    store.updateSearchOffer(offer.id, { ...offer, ...patch });
    assert.throws(() => stockList(service, { lines: [{ sourceType: 'offer', sourceId: offer.id }] }), { code: 'OFFER_REVIEW_REQUIRED' });
  }
});

test('original publication time determines supplier validity; edits do not renew an old offer', async t => {
  const { store, service, offer } = await fixture(t);
  store.upsertSearchMessage({ chatId: GROUP, messageId: 'old', originalAt: AT - 121 * 60000, revisionAt: AT - 5000, text: offer.originalExcerpt }, [{ ...offer, id: 'old-offer' }]);
  assert.throws(() => stockList(service, { lines: [{ sourceType: 'offer', sourceId: 'old-offer' }] }), { code: 'OFFER_EXPIRED' });
  service.saveSettings({ offerMaxAgeMinutes: 0 });
  assert.equal(stockList(service, { lines: [{ sourceType: 'offer', sourceId: 'old-offer' }] }).lines.length, 1);
});

test('a table intended for retail never goes to an unclassified or wholesale group', async t => {
  const { service } = await fixture(t);
  const c = { id: 'c1', audience: 'retail', groupIds: [GROUP] };
  assert.throws(() => service.validateCampaignAudience(c), { code: 'AUDIENCE_MISMATCH' });
  service.setPromotionTarget({ type: 'group', targetId: GROUP, audience: 'wholesale' });
  assert.throws(() => service.validateCampaignAudience(c), { code: 'AUDIENCE_MISMATCH' });
  service.setPromotionTarget({ type: 'group', targetId: GROUP, audience: 'retail' });
  assert.equal(service.validateCampaignAudience(c), true);
});

test('existing free-form group campaigns preserve their optional audience behavior', async t => {
  const { service } = await fixture(t);
  assert.equal(service.validateCampaignAudience({ id: 'old', groupIds: [GROUP] }), true);
});

test('contact multicategories, custom categories and trusted phone deduplication preserve prior data', async t => {
  const { service, store } = await fixture(t);
  service.saveCategory({ name: 'Assistência técnica' });
  const first = service.saveContact({ name: 'Pessoa', phone: '+55 (62) 99999-1111', categories: ['Cliente Nerópolis', 'Lojista Camelódromo', 'Assistência técnica'], notes: 'Observação real' });
  assert.equal(first.categories.length, 3); assert.equal(first.category, 'Cliente Nerópolis');
  const second = service.saveContact({ name: 'Pessoa revisada', phone: '5562999991111', categories: ['Fornecedor'] });
  assert.equal(second.id, first.id); assert.equal(second.notes, 'Observação real'); assert.equal(store.listEntities('contacts').length, 1);
  assert.throws(() => service.saveContact({ name: 'X', phone: '1111', categories: [] }), { code: 'CONTACT_INVALID' });
});

test('private audience uses registered categories and explicit consent, never a display name', async t => {
  const { service } = await fixture(t);
  const contact = service.saveContact({ name: 'Varejo administrador', phone: '5562999991111', categories: ['Fornecedor'] });
  const c = { id: 'c1', audience: 'retail', groupIds: [], contactIds: [contact.id] };
  assert.throws(() => service.validateCampaignAudience(c), { code: 'PROMOTION_CONSENT_REQUIRED' });
  service.saveContact({ ...contact, promotionalConsent: true });
  assert.throws(() => service.validateCampaignAudience(c), { code: 'AUDIENCE_MISMATCH' });
  service.saveContact({ ...contact, promotionalConsent: true, categories: ['Cliente Nerópolis', 'Lojista Camelódromo'] });
  assert.equal(service.validateCampaignAudience(c), true);
  service.setPromotionTarget({ type: 'contact', targetId: contact.id, optOut: true });
  assert.throws(() => service.validateCampaignAudience(c), { code: 'PROMOTION_OPT_OUT' });
});

test('pausing a contact or group policy blocks every promotional attempt', async t => {
  const { service, store } = await fixture(t), list = stockList(service), ctx = campaign(service, store, list);
  service.setPromotionTarget({ type: 'group', targetId: GROUP, paused: true });
  assert.throws(() => service.evaluateJob(ctx), { code: 'PROMOTION_TARGET_PAUSED' });
});

test('sold or reserved products are removed only from unchanged structured generated announcements', async t => {
  const { service, store, product } = await fixture(t);
  const list = stockList(service, { lines: [{ sourceType: 'inventory', sourceId: 'stock1' }, { sourceType: 'offer', sourceId: 'offer1' }] }), ctx = campaign(service, store, list);
  store.saveEntity('inventory', { ...product, status: 'sold', quantity: 0, availableQuantity: 0 });
  const payload = service.evaluateJob(ctx);
  assert.equal(payload.commercialRef.lines.length, 1); assert.equal(payload.commercialRef.lines[0].sourceType, 'offer');
  assert.doesNotMatch(payload.text, /Pronta entrega/); assert.match(payload.text, /Sob encomenda/);
  assert.deepEqual(payload.promotionTracking.removedInventoryIds, ['stock1']);
  ctx.job.itemSnapshot.text += '\nTexto editado pelo usuário';
  assert.throws(() => service.evaluateJob(ctx), { code: 'INVENTORY_REVIEW_REQUIRED' });
});

test('an announcement cannot silently continue when all stock is sold or reserved', async t => {
  const { service, store, product } = await fixture(t), ctx = campaign(service, store, stockList(service));
  for (const status of ['reserved', 'sold']) {
    store.saveEntity('inventory', { ...product, status, availableQuantity: 0 });
    assert.throws(() => service.evaluateJob(ctx), { code: 'INVENTORY_UNAVAILABLE', submitted: false, definitive: true });
  }
});

test('an unstructured replacement cannot bypass stock control by removing an item reference', async t => {
  const { service, store, product } = await fixture(t), ctx = campaign(service, store, stockList(service));
  ctx.job.itemSnapshot = { id: 'new-text-id', type: 'text', text: 'Anúncio refeito manualmente do mesmo aparelho' };
  store.saveEntity('inventory', { ...product, status: 'sold', availableQuantity: 0, quantity: 0 });
  assert.throws(() => service.evaluateJob(ctx), { code: 'INVENTORY_REVIEW_REQUIRED' });
});

test('updated product attributes require an explicit announcement review even when stock remains available', async t => {
  const { service, store, product } = await fixture(t), ctx = campaign(service, store, stockList(service));
  store.saveEntity('inventory', { ...product, color: 'Preto', updatedAt: AT });
  assert.throws(() => service.evaluateJob(ctx), { code: 'INVENTORY_CHANGED' });
});

test('edited original supplier offer requires review instead of retaining stale price', async t => {
  const { service, store, offer } = await fixture(t), list = stockList(service, { lines: [{ sourceType: 'offer', sourceId: 'offer1' }] }), ctx = campaign(service, store, list);
  store.updateSearchOffer(offer.id, { revisionAt: AT, priceCents: 360000 });
  assert.throws(() => service.evaluateJob(ctx), { code: 'OFFER_CHANGED' });
});

test('repetition ledger counts confirmed/uncertain once and excludes the same in-progress job from retries', async t => {
  const { service, store } = await fixture(t), ctx = campaign(service, store, stockList(service));
  service.saveSettings({ repeatLimit: 1 });
  const payload = service.evaluateJob(ctx);
  service.recordJobResult({ ...ctx, payload, status: 'sending' });
  assert.ok(service.evaluateJob(ctx));
  service.recordJobResult({ ...ctx, payload, status: 'uncertain' });
  assert.throws(() => service.evaluateJob({ ...ctx, job: { ...ctx.job, id: 'job2' } }), { code: 'PROMOTION_REPEAT_LIMIT' });
  service.recordJobResult({ ...ctx, payload, status: 'confirmed' });
  service.recordJobResult({ ...ctx, payload, status: 'uncertain' });
  assert.equal(store.listEntities('promotion_ledger').length, 1); assert.equal(store.listEntities('promotion_ledger')[0].status, 'confirmed');
});

test('a proven pre-submission failure releases a reservation; uncertain does not', async t => {
  const { service, store } = await fixture(t), ctx = campaign(service, store, stockList(service));
  service.saveSettings({ repeatLimit: 1 });
  const payload = service.evaluateJob(ctx);
  service.recordJobResult({ ...ctx, payload, status: 'sending' });
  assert.equal(service.releasePending(ctx.job.id, { submitted: true }), false);
  assert.equal(service.releasePending(ctx.job.id, { submitted: false }), true);
  assert.ok(service.evaluateJob({ ...ctx, job: { ...ctx.job, id: 'job2' } }));
  service.recordJobResult({ ...ctx, payload, status: 'uncertain' });
  assert.equal(service.releasePending(ctx.job.id, { submitted: false }), false);
});

test('promotional minimum interval and timezone schedule apply before sending', async t => {
  const { service, store } = await fixture(t), ctx = campaign(service, store, stockList(service));
  service.saveSettings({ minimumIntervalMinutes: 10 });
  const payload = service.evaluateJob(ctx); service.recordJobResult({ ...ctx, payload, status: 'confirmed', at: AT });
  assert.throws(() => service.evaluateJob({ ...ctx, job: { ...ctx.job, id: 'new' }, at: AT + 9 * 60000 }), { code: 'PROMOTION_INTERVAL' });
  assert.ok(service.evaluateJob({ ...ctx, job: { ...ctx.job, id: 'new' }, at: AT + 10 * 60000 }));
  service.saveSettings({ promotionSchedule: { enabled: true, timezone: 'America/Sao_Paulo', days: [1], startTime: '08:00', endTime: '14:00' } });
  assert.throws(() => service.evaluateJob(ctx), { code: 'PROMOTION_OUTSIDE_SCHEDULE' });
});

test('overnight promotional windows belong to the configured opening weekday in Brasília', () => {
  const s = { enabled: true, timezone: 'America/Sao_Paulo', days: [1], startTime: '22:00', endTime: '02:00' };
  assert.equal(zonedScheduleAllowed(Date.UTC(2026, 9, 6, 4, 0), s), true); // Tuesday 01:00 -> Monday
  assert.equal(zonedScheduleAllowed(Date.UTC(2026, 9, 6, 6, 0), s), false);
});

test('commercial reference tampering and stale previews cannot supply campaign source metadata', async t => {
  const { service } = await fixture(t), list = stockList(service), item = service.toCampaignItems(list.id)[0];
  assert.deepEqual(service.validateCommercialRef(item.commercialRef, item), item.commercialRef);
  assert.throws(() => service.validateCommercialRef({ ...item.commercialRef, lines: [{ ...item.commercialRef.lines[0], priceCents: 1 }] }, item), { code: 'COMMERCIAL_REF_STALE' });
  service.saveCommercialList({ ...list, expectedRevision: list.revision });
  assert.throws(() => service.validateCommercialRef(item.commercialRef, item), { code: 'COMMERCIAL_REF_STALE' });
});

test('WhatsApp advertisement suggestion is a draft with factual attributes and explicit audience/availability', async t => {
  const { service } = await fixture(t);
  const draft = service.createAdDraft({ text: 'iPhone 15 Pro Max 256GB Azul R$ 3.850,00', audience: 'retail', availability: 'sob encomenda' });
  assert.equal(draft.approvalRequired, true); assert.equal(draft.status, 'draft'); assert.equal(draft.priceCents, 385000);
  assert.equal('condition' in draft.facts, false); assert.doesNotMatch(draft.text, /seminovo|lacrado/);
  assert.throws(() => service.createAdDraft({ text: 'iPhone 15 Pro Max 256GB entrada R$ 500 + 12x R$ 300', audience: 'retail', availability: 'pronta entrega' }), { code: 'AD_REVIEW_REQUIRED' });
  assert.throws(() => service.createAdDraft({ model: 'iPhone 15', priceCents: 300000, audience: 'retail' }), { code: 'AVAILABILITY_REQUIRED' });
});

test('multicategories, lists and policies survive a real SQLite close/reopen and remain separate from simulation', async t => {
  const { dir, service, store } = await fixture(t);
  const contact = service.saveContact({ name: 'Contato', phone: '5562999991111', categories: ['Cliente Nerópolis', 'Fornecedor'] }), list = stockList(service);
  service.setPromotionTarget({ type: 'contact', targetId: contact.id, optOut: true }); store.close();
  const reopened = await createStore(dir); t.after(() => reopened.close());
  const next = new CommercialService({ store: reopened, now: () => AT });
  assert.equal(next.getCommercialList(list.id).name, list.name); assert.deepEqual(reopened.getEntity('contacts', contact.id).categories, contact.categories); assert.equal(next.listPromotionTargets()[0].optOut, true);
  reopened.setSetting('integrationMode', 'simulated'); assert.equal(next.listCommercialLists().length, 0); assert.equal(next.listPromotionTargets().length, 0);
  reopened.setSetting('integrationMode', 'whatsapp'); assert.equal(next.listCommercialLists().length, 1);
});

test('failure persisting a contact or a commercial list rolls back data and audit atomically', async t => {
  const { store, service } = await fixture(t), original = store.addAudit, before = store.listEntities('audit').length;
  store.addAudit = () => { throw new Error('Gravação de auditoria indisponível'); };
  assert.throws(() => stockList(service), /auditoria indisponível/); assert.equal(service.listCommercialLists().length, 0);
  assert.throws(() => service.saveContact({ name: 'Contato', phone: '5562999991111', categories: ['Cliente Nerópolis'] }), /auditoria indisponível/);
  assert.equal(store.listEntities('contacts').length, 0); assert.equal(store.listEntities('audit').length, before); store.addAudit = original;
});
