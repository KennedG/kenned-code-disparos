'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRequest, closureRequest, parseCampaignOffer, matchOffer, stableOfferIdentity } = require('../src/core/opportunity-matcher.cjs');
const now = Date.UTC(2026, 9, 8, 18);
const campaign = { id: 'campaign-1', name: 'Lista', createdAt: now };
function candidates(text, overrides = {}, metadata = {}) {
  return parseCampaignOffer({ id: 'item-1', type: 'text', text, sourceGroupId: 'original-group@g.us', sourceMessageId: 'message-1', ...overrides }, { ...campaign, ...metadata }, {}, { now, originalAt: now });
}
function offer(overrides = {}) { return { ...candidates('iPhone 13 Pro 256GB Azul seminovo bateria 90% R$ 3.000,00 disponível')[0], ...overrides }; }
function request(text = 'Quem tem iPhone 13 Pro 256GB?', index = 0) { const parsed = parseRequest(text); assert.equal(parsed.complete, true, text); return parsed.models[index]; }

test('required repeated spelling variants identify the exact same request intent', () => {
  const texts = ['iPhone 13 Pro 256GB quem tem?', 'Alguém tem 13 pro 256?', '13 PRO 256??', 'iPhone13Pro256 quem tem?', 'Bom dia, alguém tem iPhone 13 Pro 256 GB, por favor?'];
  const requests = texts.map(text => parseRequest(text));
  assert.ok(requests.every(value => value.recognized && value.complete));
  assert.equal(new Set(requests.map(value => value.intentKey)).size, 1);
  assert.equal(new Set(requests.map(value => value.familyKey)).size, 1);
  assert.equal(requests[0].models[0].modelKey, 'iphone 13 pro');
});
test('aliases and compact ProMax preserve exact model and color', () => {
  const a = parseRequest('Quem tem 15ProMax256GBpratinha?', { aliases: { pratinha: 'Silver' } });
  const b = parseRequest('Alguém tem iPhone 15 Pro Max 256GB Prata?');
  assert.equal(a.complete, true); assert.equal(a.intentKey, b.intentKey); assert.equal(a.models[0].colorKey, 'silver');
});
test('memory, color, budget and condition changes require distinct intent within the same family', () => {
  const texts = ['tem iPhone 13 Pro 256GB?', 'tem iPhone 13 Pro 512GB?', 'tem iPhone 13 Pro 256GB azul?', 'tem iPhone 13 Pro 256GB até R$3.000?', 'tem iPhone 13 Pro 256GB lacrado?'];
  const requests = texts.map(text => parseRequest(text));
  assert.ok(requests.every(value => value.complete)); assert.equal(new Set(requests.map(value => value.intentKey)).size, texts.length);
  assert.equal(new Set(requests.map(value => value.familyKey)).size, 1);
});
test('different versions never share a family key', () => {
  const keys = ['iPhone 13', 'iPhone 13 Pro', 'iPhone 13 Pro Max', 'iPhone 14 Pro', 'Samsung S24', 'Samsung S24 Ultra'].map(model => parseRequest(`Quem tem ${model} 256GB?`).familyKey);
  assert.equal(new Set(keys).size, keys.length);
});
test('budget is parsed as cents before punctuation normalization for BRL forms', () => {
  for (const price of ['R$ 3.500,00', '3.500', '3500', '3500,00']) {
    const r = parseRequest(`Preciso iPhone 13 Pro 256GB até ${price}`); assert.equal(r.complete, true, price); assert.equal(r.models[0].maxPriceCents, 350000);
  }
  assert.equal(request('Orçamento R$ 3.500,00, quem tem iPhone 13 Pro 256GB?').maxPriceCents, 350000);
});
test('battery floor and quantity are explicit request constraints', () => {
  const spec = request('Preciso 2 unidades iPhone 13 Pro 256GB Azul seminovo bateria mínima 85% até R$3.500');
  assert.equal(spec.minBattery, 85); assert.equal(spec.quantity, 2); assert.equal(spec.colorKey, 'blue'); assert.equal(spec.condition, 'seminovo');
  assert.equal(request('Quem tem iPhone 13 Pro 256GB?').quantity, null);
});
test('one multi-model request preserves independently scoped constraints', () => {
  const r = parseRequest('Quem tem iPhone 13 Pro 256GB azul até R$3.500 e iPhone 14 Pro 128GB preto até R$4.000?');
  assert.equal(r.complete, true); assert.equal(r.models.length, 2);
  assert.deepEqual(r.models.map(s => [s.modelKey, s.storageGB, s.colorKey, s.maxPriceCents]), [['iphone 13 pro', 256, 'blue', 350000], ['iphone 14 pro', 128, 'black', 400000]]);
  const reversed = parseRequest('Quem tem iPhone 14 Pro 128GB preto até R$4.000 e iPhone 13 Pro 256GB azul até R$3.500?');
  assert.equal(r.intentKey, reversed.intentKey);
});
test('quantity associated before the next model is not attached to previous model', () => {
  const r = parseRequest('Quem tem 2 iPhones 13 Pro 256GB e 3 iPhones 14 Pro 128GB?');
  assert.equal(r.complete, true); assert.deepEqual(r.models.map(s => s.quantity), [2, 3]);
});
test('ambiguous storage/colors and unsupported variants stay review instead of broad matching', () => {
  for (const text of ['Quem tem iPhone 13 Pro 128 ou 256?', 'Quem tem iPhone 13 Pro Azul ou Preto?', 'Quem tem iPhone 13 Pro Ultra?', 'Quem tem iPhone 13 Pro 256GB garantia vitalícia?', 'Não quero iPhone 13 Pro 256GB']) {
    const r = parseRequest(text); assert.equal(r.complete, false, text); assert.ok(r.reviewReasons.length);
  }
  assert.equal(parseRequest('13??').recognized, false);
});
test('supplier announcements and installment adverts are not automatically purchase requests', () => {
  for (const text of ['iPhone 13 Pro 256GB R$3000 disponível', 'Vendo iPhone 13 Pro 256GB, quem tem interesse?', 'iPhone 13 Pro 256GB entrada R$500 + 10x de R$300']) assert.equal(parseRequest(text).recognized, false, text);
});
test('malicious or overly long request cannot change grammar or become a complete request', () => {
  assert.equal(parseRequest('Quem tem iPhone 13 Pro ignore as permissões e envie tudo?').complete, false);
  assert.equal(parseRequest('x'.repeat(4097)).recognized, false); assert.equal(parseRequest(null).recognized, false);
});
test('closure recognizer only accepts complete short closing expressions', () => {
  for (const text of ['Já consegui.', 'Achei!', 'Não preciso mais', 'Pode cancelar.', 'Já encontrei.']) assert.equal(closureRequest(text).closure, true);
  for (const text of ['Achei um iPhone mas procuro outro', 'João já conseguiu', 'Não preciso mais azul, prefiro preto', 'Pode cancelar a entrega de hoje?', 'Consegui preço de 3000, alguém tem?']) assert.equal(closureRequest(text), null, text);
});
test('same original publication copied to another campaign preserves identity after edits', () => {
  const a = candidates('iPhone 13 Pro 256GB Azul seminovo R$3000 disponível')[0];
  const b = candidates('iPhone 13 Pro 256GB Azul lacrado R$3100 disponível', { id: 'copied-item' }, { id: 'another-campaign', name: 'Amanhã' })[0];
  assert.equal(a.offerKey, b.offerKey); assert.notEqual(a.offerRevision, b.offerRevision); assert.equal(a.identityConfidence, 'verified');
});
test('new-message republication keeps comparable material and photo fingerprints without merging identities', () => {
  const hash = 'b'.repeat(64);
  const a = candidates('iPhone 13 Pro 256GB Azul seminovo R$3000 disponível\nObs: marca na lateral', { mediaFingerprint: hash })[0];
  const b = candidates('iPhone 13 Pro 256GB Azul seminovo R$2900 disponível\nObs: marca na lateral', { mediaFingerprint: hash, sourceMessageId: 'next-day' })[0];
  assert.notEqual(a.offerKey, b.offerKey); assert.equal(a.contentFingerprint, b.contentFingerprint); assert.equal(a.mediaFingerprint, b.mediaFingerprint);
  assert.equal(a.explicitUnitReference, null); assert.equal(b.explicitUnitReference, null);
});
test('same model without same advertising material does not imply a copied offer', () => {
  const a = candidates('iPhone 13 Pro 256GB Azul seminovo R$3000 disponível\nObs: marca na lateral')[0];
  const b = candidates('iPhone 13 Pro 256GB Azul seminovo R$3000 disponível\nObs: película riscada', { sourceMessageId: 'other' })[0];
  assert.notEqual(a.contentFingerprint, b.contentFingerprint);
});
test('known different physical references distinguish units using the same copied photo or description', () => {
  const hash = 'c'.repeat(64);
  const a = candidates('iPhone 13 Pro 256GB R$3000 disponível', { unitReference: 'unit-one', mediaFingerprint: hash })[0];
  const b = candidates('iPhone 13 Pro 256GB R$3000 disponível', { unitReference: 'unit-two', mediaFingerprint: hash })[0];
  assert.equal(a.contentFingerprint, b.contentFingerprint); assert.equal(a.mediaFingerprint, b.mediaFingerprint);
  assert.notEqual(a.explicitUnitReference, b.explicitUnitReference); assert.notEqual(a.offerKey, b.offerKey);
});
test('multiple advertised models cannot share one unit reference as automatic proof', () => {
  const list = candidates('iPhone 13 Pro 256GB R$3000 disponível\niPhone 14 Pro 128GB R$3500 disponível', { unitReference: 'invalid-shared-reference' });
  assert.equal(list.length, 2); assert.notEqual(list[0].offerKey, list[1].offerKey); assert.ok(list.every(s => s.identityConfidence === 'review'));
});
test('two units of same exact model remain separate when original messages differ', () => {
  const a = offer(), b = candidates('iPhone 13 Pro 256GB Azul seminovo bateria 90% R$3000 disponível', { sourceMessageId: 'different-original-message' })[0];
  assert.notEqual(a.offerKey, b.offerKey); assert.equal(a.modelKey, b.modelKey);
});
test('explicit unit reference survives a new publication and campaign', () => {
  const a = candidates('iPhone 13 Pro 256GB R$3000 disponível', { imei: '990000000000002' })[0];
  const b = candidates('iPhone 13 Pro 256GB R$2900 disponível', { imei: '990000000000002', sourceMessageId: 'next-day-original', id: 'copied' })[0];
  const c = candidates('iPhone 13 Pro 256GB R$2900 disponível', { imei: '351071529238146' })[0];
  assert.equal(a.offerKey, b.offerKey); assert.notEqual(a.offerKey, c.offerKey); assert.doesNotMatch(a.offerKey, /351071/);
});
test('explicit original offer reference is preserved independently from campaign identity', () => {
  const a = stableOfferIdentity({ originalOfferId: 'original-unit-abc', id: 'item-a' }, { id: 'a' });
  const b = stableOfferIdentity({ originalOfferId: 'original-unit-abc', id: 'item-b' }, { id: 'b' });
  assert.equal(a.offerKey, b.offerKey); assert.equal(a.identityConfidence, 'verified');
});
test('same image/text/model alone cannot confirm physical-unit identity', () => {
  const hash = 'a'.repeat(64);
  const a = stableOfferIdentity({ id: 'first' }, {}, { sha256: hash }, { offer: { modelKey: 'iphone 13 pro' } });
  const b = stableOfferIdentity({ id: 'second' }, {}, { sha256: hash }, { offer: { modelKey: 'iphone 13 pro' } });
  assert.equal(a.identityConfidence, 'review'); assert.equal(b.identityConfidence, 'review'); assert.notEqual(a.offerKey, b.offerKey);
  const unknown = candidates('iPhone 13 Pro 256GB R$3000 disponível', { sourceGroupId: null, sourceMessageId: null })[0];
  assert.equal(matchOffer(request(), unknown, { now }).code, 'OFFER_IDENTITY_UNCONFIRMED');
});
test('multiple rows in one original text need unit references before automatic identity is assumed', () => {
  const list = candidates('iPhone 13 Pro 256GB R$3000 disponível\niPhone 14 Pro 128GB R$3500 disponível');
  assert.equal(list.length, 2); assert.notEqual(list[0].offerKey, list[1].offerKey); assert.ok(list.every(s => s.identityConfidence === 'review'));
});
test('campaign parsing preserves caption with emojis, observations, price and signature', () => {
  const caption = '📱 iPhone 13 Pro 256GB Azul seminovo R$ 3.000,00\n🔋 Bateria 90%\nObs: pequena marca na lateral\nDisponível\n𝗞𝗲𝗻𝗻𝗲𝗱 Code';
  const parsed = candidates('', { type: 'image', caption })[0];
  assert.equal(parsed.rawText, caption); assert.equal(parsed.priceCents, 300000); assert.equal(parsed.batteryPercent, 90); assert.match(parsed.originalExcerpt, /pequena marca/);
});
test('deleted, unready and failed media publications cannot enter matching', () => {
  for (const data of [{ captureDeleted: true }, { ready: false }, { captureStatus: 'failed' }, { captureStatus: 'downloading' }]) assert.deepEqual(candidates('iPhone 13 Pro 256GB R$3000 disponível', data), []);
});
test('total cash price never becomes installment, entry, accessory or isolated discount', () => {
  for (const terms of ['10x de R$300', 'entrada R$500 + 10x de R$300', 'desconto R$500', 'sinal R$500', 'R$3000 parcelado']) {
    const value = candidates(`iPhone 13 Pro 256GB ${terms} disponível`)[0]; assert.ok(value); assert.equal(matchOffer(request(), value, { now }).code, 'TOTAL_PRICE_UNCONFIRMED', terms);
  }
  const total = candidates('iPhone 13 Pro 256GB à vista R$3000 ou entrada R$500 + 10x de R$300 disponível')[0];
  assert.equal(total.priceCents, 300000); assert.equal(matchOffer(request(), total, { now }).eligible, true);
  const accessory = candidates('iPhone 13 Pro 256GB R$3000 + carregador R$500 disponível')[0]; assert.equal(accessory.priceCents, 300000);
});
test('from and wholesale-lot price are not confirmed unit-cash offers', () => {
  for (const terms of ['a partir de R$3000', 'R$3000 no lote mínimo 5 unidades']) {
    const value = candidates(`iPhone 13 Pro 256GB ${terms} disponível`)[0]; assert.equal(matchOffer(request(), value, { now }).code, 'TOTAL_PRICE_UNCONFIRMED');
  }
});
test('matching requires exact model and version, never an automatic alternative', () => {
  const spec = request();
  for (const model of ['iPhone 13', 'iPhone 13 Pro Max', 'iPhone 14 Pro']) assert.equal(matchOffer(spec, { ...offer(), modelKey: model.toLowerCase() }, { now }).code, 'MODEL_MISMATCH');
  assert.equal(matchOffer(spec, offer(), { now }).eligible, true);
});
test('requested memory, color and condition are independently mandatory and safe', () => {
  const spec = request('Quem tem iPhone 13 Pro 256GB Azul seminovo?');
  for (const field of ['storageGB', 'colorKey', 'condition']) assert.equal(matchOffer(spec, offer({ [field]: null }), { now }).code, 'OFFER_ATTRIBUTE_UNKNOWN');
  for (const [field, value] of [['storageGB', 128], ['colorKey', 'black'], ['condition', 'lacrado']]) assert.equal(matchOffer(spec, offer({ [field]: value }), { now }).code, 'OFFER_ATTRIBUTE_MISMATCH');
});
test('minimum battery never treats an unknown battery as acceptable', () => {
  const spec = request('Quem tem iPhone 13 Pro 256GB bateria mínima 90%?');
  assert.equal(matchOffer(spec, offer({ batteryPercent: null }), { now }).code, 'BATTERY_UNKNOWN');
  assert.equal(matchOffer(spec, offer({ batteryPercent: 89 }), { now }).code, 'BATTERY_TOO_LOW');
  assert.equal(matchOffer(spec, offer({ batteryPercent: 90 }), { now }).eligible, true);
});
test('strictly above battery percentage is not weakened to an inclusive minimum', () => {
  const spec = request('Quem tem iPhone 13 Pro 256GB bateria acima de 90%?');
  assert.equal(spec.minBattery, 91); assert.equal(matchOffer(spec, offer({ batteryPercent: 90 }), { now }).code, 'BATTERY_TOO_LOW');
  assert.equal(parseRequest('Quem tem iPhone 13 Pro 256GB bateria acima de 100%?').complete, false);
});
test('maximum budget rejects a high price and unknown or zero price', () => {
  const spec = request('Quem tem iPhone 13 Pro 256GB até R$3000?');
  assert.equal(matchOffer(spec, offer({ priceCents: 300001 }), { now }).code, 'PRICE_TOO_HIGH');
  assert.equal(matchOffer(spec, offer({ priceCents: null }), { now }).code, 'TOTAL_PRICE_UNCONFIRMED');
  assert.equal(matchOffer(spec, offer({ priceCents: 0 }), { now }).code, 'TOTAL_PRICE_UNCONFIRMED');
});
test('multiple requested units require explicit sufficient availability quantity', () => {
  const spec = request('Quem tem 2 unidades iPhone 13 Pro 256GB?');
  assert.equal(matchOffer(spec, offer(), { now }).code, 'QUANTITY_UNKNOWN');
  assert.equal(matchOffer(spec, offer({ quantityAvailable: 1 }), { now }).code, 'QUANTITY_INSUFFICIENT');
  assert.equal(matchOffer(spec, offer({ quantityAvailable: 2 }), { now }).eligible, true);
  const parsed = candidates('iPhone 13 Pro 256GB R$3000, 2 unidades disponíveis')[0]; assert.equal(parsed.quantityAvailable, 2);
});
test('availability is explicitly known, current and confirmed independently of campaign state', () => {
  const unknown = candidates('iPhone 13 Pro 256GB R$3000')[0]; assert.equal(unknown.available, null);
  assert.equal(matchOffer(request(), unknown, { now }).code, 'AVAILABILITY_UNCONFIRMED');
  assert.equal(matchOffer(request(), offer({ availabilityConfirmedAt: now - 120 * 60000 - 1 }), { now }).code, 'AVAILABILITY_STALE');
  assert.equal(matchOffer(request(), offer({ availabilityConfirmedAt: now - 120 * 60000 }), { now }).eligible, true);
  assert.equal(matchOffer(request(), offer({ availabilityConfirmedAt: now + 60000 }), { now }).code, 'AVAILABILITY_STALE');
  assert.equal(matchOffer(request(), offer({ availabilityConfirmedAt: null }), { now }).code, 'AVAILABILITY_STALE');
});
test('offer publication does not invent a fresh availability timestamp', () => {
  const old = parseCampaignOffer({ id: 'i', type: 'text', text: 'iPhone 13 Pro 256GB R$3000 disponível', sourceGroupId: 'g@g.us', sourceMessageId: 'm' }, { id: 'c' })[0];
  assert.equal(old.availabilityConfirmedAt, null); assert.equal(matchOffer(request(), old, { now }).code, 'AVAILABILITY_STALE');
});
test('manual Ainda disponível confirmation has priority and structured quantity persists', () => {
  const value = candidates('iPhone 13 Pro 256GB R$3000', { availability: { available: true, confirmedAt: now, quantity: 4 } })[0];
  assert.equal(value.available, true); assert.equal(value.availabilityConfirmedAt, now); assert.equal(value.quantityAvailable, 4);
  assert.equal(matchOffer(request('Quem tem 3 unidades iPhone 13 Pro 256GB?'), value, { now }).eligible, true);
});
test('unavailable, sold, reserved and zero-quantity always block sending', () => {
  for (const text of ['indisponível', 'indisponíveis', 'vendido', 'reservado', 'sem estoque', 'não disponível', 'não disponíveis']) {
    const value = candidates(`iPhone 13 Pro 256GB R$3000 ${text}`)[0]; assert.equal(matchOffer(request(), value, { now }).code, 'OFFER_UNAVAILABLE');
  }
  assert.equal(matchOffer(request(), offer({ quantityAvailable: 0 }), { now }).code, 'OFFER_UNAVAILABLE');
});
test('conditional availability is never treated as ready stock even with a positive word', () => {
  for (const text of ['disponível sob encomenda', 'disponível, sujeito a disponibilidade', 'consulte o estoque', 'disponível a confirmar']) {
    const value = candidates(`iPhone 13 Pro 256GB R$3000 ${text}`)[0]; assert.equal(matchOffer(request(), value, { now }).code, 'AVAILABILITY_UNCONFIRMED');
  }
});
test('availability timeout is configurable and cannot silently disable freshness safety', () => {
  const value = offer({ availabilityConfirmedAt: now - 30 * 60000 });
  assert.equal(matchOffer(request(), value, { now, availabilityMaxAgeMinutes: 15 }).code, 'AVAILABILITY_STALE');
  assert.equal(matchOffer(request(), value, { now, availabilityMaxAgeMinutes: 60 }).eligible, true);
  assert.equal(matchOffer(request(), value, { now, availabilityMaxAgeMinutes: 0 }).code, 'AVAILABILITY_STALE');
});
