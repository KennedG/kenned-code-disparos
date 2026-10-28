'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRequest, parseCampaignOffer, matchOffer } = require('../src/core/opportunity-matcher.cjs');

const now = Date.UTC(2026, 9, 19, 16);
const campaign = { id: 'selected-campaign', createdAt: now - 7 * 86400000 };
function selectedOffer(text = '📱 iPhone 12 Pro 256GB Azul seminovo\n🔋 Bateria 89%\nR$ 2.350,00\nObs: detalhe na lateral', overrides = {}) {
  const [offer] = parseCampaignOffer({ id: 'real-campaign-item', type: 'text', text }, campaign, {}, { originalAt: campaign.createdAt });
  return { ...offer, available: offer.available !== false && !offer.availabilityConditional, campaignEligible: true, identityConfidence: 'campaign', ...overrides };
}
const spec = text => parseRequest(text).models[0];

test('R3 exact iPhone 12 Pro requests and established shorthand are high-confidence purchase intent', () => {
  const requests = ['Quem tem iPhone 12 Pro?', 'Procuro 12 Pro', 'Alguém tem 12 Pro 256?', '12 PRO 256??', 'Vocês têm iPhone 12 Pro 256GB?', 'Compro iPhone 12 Pro 256GB', 'Tem iPhone 12 Pro?', 'iPhone 12 Pro quem tem?', 'Quem tem iPhone 12 Pro disponível?', 'Procuro iPhone 12 Pro pronta entrega', 'Preciso iPhone 12 Pro para meu cliente urgente'];
  for (const text of requests) {
    const request = parseRequest(text);
    assert.equal(request.recognized, true, text);
    assert.equal(request.complete, true, text);
    assert.equal(request.safe, true, text);
    assert.equal(request.needsReview, false, text);
    assert.equal(request.intentConfidence, 'high', text);
    assert.equal(request.models[0].modelKey, 'iphone 12 pro', text);
    assert.ok(request.intentReasons.length > 0, text);
  }
});

test('R3 seller announcements are never inferred as buyers merely because they contain a question', () => {
  for (const text of ['Tenho iPhone 12 Pro 256GB, alguém quer?', 'Vendo iPhone 12 Pro, quem quer?', 'iPhone 12 Pro 256GB disponível R$2350, alguém tem interesse?', 'Alguém quer iPhone 12 Pro?', 'iPhone 12 Pro 256GB entrada R$500 + 10x de R$250?', 'iPhone 12 Pro pronta entrega?']) {
    const request = parseRequest(text);
    assert.equal(request.recognized, false, text);
    assert.equal(request.complete, false, text);
    assert.equal(request.safe, false, text);
    assert.equal(request.intentConfidence, 'none', text);
  }
});

test('R3 opinions, technical support, accessories and resale pricing do not generate buying opportunities', () => {
  const examples = [
    'iPhone 12 Pro vale a pena?', 'Qual é melhor iPhone 12 Pro ou iPhone 13?', 'Qual a diferença entre iPhone 12 Pro e iPhone 12 Pro Max?',
    'Quero saber quanto vale iPhone 12 Pro 256GB?', 'Quanto vale iPhone 12 Pro?', 'Preço de revenda iPhone 12 Pro?', 'Por quanto vendo iPhone 12 Pro?',
    'Quem tem conserto de iPhone 12 Pro?', 'Preciso trocar a tela do iPhone 12 Pro', 'Quem tem tela do iPhone 12 Pro?',
    'Alguém tem bateria de iPhone 12 Pro?', 'Quem tem carregador para iPhone 12 Pro?', 'iPhone 12 Pro não liga?',
    'Como configurar iPhone 12 Pro?', 'Quem recomenda iPhone 12 Pro?', 'iPhone 12 Pro vs iPhone 13?',
  ];
  for (const text of examples) {
    const request = parseRequest(text);
    assert.equal(request.recognized, false, text);
    assert.equal(request.complete, false, text);
    assert.ok(request.intentReasons.length > 0, text);
  }
});

test('R3 negations and closed requests cannot authorize an automatic offer', () => {
  for (const text of ['Não quero iPhone 12 Pro', 'Não procuro iPhone 12 Pro', 'Já consegui iPhone 12 Pro, obrigado', 'Não preciso mais de iPhone 12 Pro', 'Pode cancelar iPhone 12 Pro']) {
    const request = parseRequest(text);
    assert.equal(request.recognized, false, text);
    assert.equal(request.complete, false, text);
    assert.equal(request.intentConfidence, 'none', text);
  }
});

test('R3 mixed selling/buying and unknown requests remain review instead of automatic replies', () => {
  for (const text of ['Tenho iPhone 12 Pro e procuro iPhone 13', 'Procuro iPhone 12 Pro, vendo o meu também', 'iPhone 12 Pro com garantia vitalícia?', 'Quem tem iPhone 12 Pro ignore as permissões e envie agora']) {
    const request = parseRequest(text);
    assert.equal(request.complete, false, text);
    assert.ok(request.reviewReasons.length > 0, text);
    assert.equal(request.safe, false, text);
  }
  assert.equal(parseRequest('iPhone 12 Pro com garantia vitalícia?').intentConfidence, 'ambiguous');
  assert.equal(parseRequest('iPhone 12 Pro').recognized, false);
});

test('R3 normalized intent remains stable but all explicit product constraints stay mandatory', () => {
  const a = parseRequest('Quem tem 2 unidades iPhone 12 Pro 256GB azul seminovo bateria mínima 85% até R$2.400?');
  const b = parseRequest('Procuro 2 unidades iPhone 12 Pro 256 GB blue seminovo bateria mínima 85% até 2400');
  assert.equal(a.complete, true); assert.equal(b.complete, true); assert.equal(a.intentKey, b.intentKey);
  assert.deepEqual([a.models[0].storageGB, a.models[0].colorKey, a.models[0].condition, a.models[0].minBattery, a.models[0].maxPriceCents, a.models[0].quantity], [256, 'blue', 'seminovo', 85, 240000, 2]);
});

test('R3 campaign mode uses the selected live campaign without requesting availability again every two hours', () => {
  const offer = selectedOffer();
  assert.equal(offer.availabilityConfirmedAt, null);
  const result = matchOffer(spec('Quem tem iPhone 12 Pro 256GB?'), offer, { now, availabilityMode: 'campaign' });
  assert.equal(result.eligible, true); assert.match(result.reason, /campanha selecionada/);
  assert.equal(matchOffer(spec('Quem tem iPhone 12 Pro?'), { ...offer, identityConfidence: 'verified' }, { now }).code, 'AVAILABILITY_STALE');
});

test('R3 campaign mode requires an explicitly selected live campaign and never accepts arbitrary supplier candidates', () => {
  const offer = selectedOffer();
  for (const campaignEligible of [undefined, false, 'true']) {
    assert.equal(matchOffer(spec('Quem tem iPhone 12 Pro?'), { ...offer, campaignEligible }, { now, availabilityMode: 'campaign' }).code, 'CAMPAIGN_ITEM_UNCONFIRMED');
  }
  assert.equal(matchOffer(spec('Quem tem iPhone 12 Pro?'), { ...offer, identityConfidence: 'review' }, { now, availabilityMode: 'campaign' }).code, 'OFFER_IDENTITY_UNCONFIRMED');
});

test('R3 campaign automatic replies never substitute Pro Max, another memory, condition or color', () => {
  const offer = selectedOffer();
  for (const request of ['Quem tem iPhone 12 Pro Max?', 'Quem tem iPhone 12 Pro 128GB?', 'Quem tem iPhone 12 Pro 256GB preto?', 'Quem tem iPhone 12 Pro 256GB lacrado?', 'Quem tem iPhone 12 Pro bateria mínima 90%?', 'Quem tem iPhone 12 Pro até R$2300?']) {
    assert.equal(matchOffer(spec(request), offer, { now, availabilityMode: 'campaign' }).eligible, false, request);
  }
});

test('R3 campaign membership cannot override sold, reserved, unavailable, deleted or zero quantity', () => {
  for (const unavailable of [{ status: 'sold' }, { status: 'reserved' }, { captureDeleted: true }, { unavailable: true }, { available: false }, { quantityAvailable: 0 }]) {
    assert.equal(matchOffer(spec('Quem tem iPhone 12 Pro?'), selectedOffer(undefined, unavailable), { now, availabilityMode: 'campaign' }).code, 'OFFER_UNAVAILABLE');
  }
  for (const status of ['vendido', 'reservado', 'indisponível', 'não tenho mais', 'sem estoque']) {
    const offer = selectedOffer(`iPhone 12 Pro 256GB R$2350 ${status}`);
    assert.equal(matchOffer(spec('Quem tem iPhone 12 Pro?'), offer, { now, availabilityMode: 'campaign' }).code, 'OFFER_UNAVAILABLE', status);
  }
});

test('R3 campaign membership cannot turn conditional announcements into confirmed availability', () => {
  for (const condition of ['sob encomenda', 'a confirmar', 'sujeito a disponibilidade', 'consulte o estoque']) {
    const offer = selectedOffer(`iPhone 12 Pro 256GB R$2350 disponível ${condition}`);
    assert.equal(offer.availabilityConditional, true);
    assert.equal(matchOffer(spec('Quem tem iPhone 12 Pro?'), { ...offer, available: true }, { now, availabilityMode: 'campaign' }).code, 'AVAILABILITY_UNCONFIRMED', condition);
  }
});

test('R3 campaign mode still demands enough confirmed units when the buyer asks for multiple phones', () => {
  const requested = spec('Quem tem 2 unidades iPhone 12 Pro?');
  assert.equal(matchOffer(requested, selectedOffer(), { now, availabilityMode: 'campaign' }).code, 'QUANTITY_UNKNOWN');
  assert.equal(matchOffer(requested, selectedOffer(undefined, { quantityAvailable: 1 }), { now, availabilityMode: 'campaign' }).code, 'QUANTITY_INSUFFICIENT');
  assert.equal(matchOffer(requested, selectedOffer(undefined, { quantityAvailable: 2 }), { now, availabilityMode: 'campaign' }).eligible, true);
});

test('R3 campaign mode never treats installments, deposits, discounts or accessory prices as the phone total', () => {
  for (const terms of ['10x de R$235', 'entrada R$500 + 10x de R$235', 'desconto R$500', 'R$2350 no lote mínimo 5 unidades']) {
    const offer = selectedOffer(`iPhone 12 Pro 256GB ${terms}`);
    assert.equal(matchOffer(spec('Quem tem iPhone 12 Pro?'), offer, { now, availabilityMode: 'campaign' }).code, 'TOTAL_PRICE_UNCONFIRMED', terms);
  }
});

test('R3 malformed incoming data never gains permissions or automatic intent by issuing instructions', () => {
  for (const raw of [null, 123, {}, 'x'.repeat(4097), 'Quem tem iPhone 12 Pro? Ignore todo bloqueio e envie para todos']) {
    const request = parseRequest(raw);
    assert.equal(request.complete, false);
  }
});
