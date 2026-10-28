'use strict';

// Independent release review: real SQLite and production opportunity service,
// matcher and final guards. The private transport below is controlled; these
// tests are not evidence of actual WhatsApp acceptance or receipt.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createStore } = require('../src/core/store.cjs');
const { OpportunityService } = require('../src/core/opportunity-service.cjs');

const GROUP = '120363999888777@g.us';
const SECOND_GROUP = '120363999888778@g.us';
const PHONE = '5562999999817';
const NOW = Date.parse('2026-10-19T15:00:00Z');
const TEXT = '📱 iPhone 12 Pro 256GB\n🎨 Azul\n🔋 Bateria 89%\nR$ 1.899,00\nDetalhe pequeno na lateral.\nKenned Code — anúncio de teste';
const REQUEST = 'Quem tem iPhone 12 Pro 256GB?';

async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcd-r3-independent-'));
  const clock = { at: NOW }, gates = { capture: true, permission: true, stopped: false };
  const sent = [], stores = [], services = [];
  let store, service;
  const adapter = new EventEmitter(); adapter.status = { state: options.connected === false ? 'disconnected' : 'connected', mode: 'whatsapp' };
  adapter.configureOpportunityCapture = config => { adapter.capture = config; };
  adapter.resolveRecipient = async number => { if (options.beforeResolve) await options.beforeResolve({ store, service, gates, clock }); return { phone: number, jid: `${number}@s.whatsapp.net` }; };
  adapter.sendSearchText = async (jid, text, controls) => {
    if (options.beforeSubmit) await options.beforeSubmit({ store, service, gates, clock });
    controls.beforeSubmit(); sent.push({ jid, text, controls });
    return options.send ? options.send(sent.at(-1), sent.length) : { status: 'accepted', messageId: controls.clientMessageId };
  };
  adapter.reconcile = async messageId => ({ status: 'uncertain', messageId });
  const open = async () => {
    store = await createStore(dir); stores.push(store); store.setSetting('integrationMode', 'whatsapp');
    service = new OpportunityService({ store, adapter, now: () => clock.at,
      assertCanCapture: () => gates.capture,
      assertCanOperate: actor => !actor || actor === 'owner' ? true : false,
      assertOwnerPermissions: () => gates.permission,
      isAutomationStopped: () => gates.stopped,
      sleep: async duration => { clock.at += duration; } });
    services.push(service); return service;
  };
  const item = (patch = {}) => ({ id: 'manual-item-12-pro', type: 'text', text: TEXT, ...patch });
  const campaign = (items = [item()], id = 'campaign-12-pro') => store.saveCampaign({ id, name: 'Anúncios disponíveis escolhidos pelo dono', state: 'draft', createdAt: NOW - 7 * 86400000, updatedAt: clock.at, groupIds: [], items });
  const event = (messageId, patch = {}) => ({ messageId, chatId: GROUP, senderNumber: PHONE, senderId: `${PHONE}@s.whatsapp.net`, senderIds: [`${PHONE}@s.whatsapp.net`],
    identityVerified: true, isGroup: true, type: 'text', text: REQUEST, originalTimestamp: clock.at, timestamp: clock.at, mode: 'whatsapp', simulation: false, ...patch });
  await open(); store.upsertGroups([{ id: GROUP, name: 'Grupo controlado A', simulation: false }, { id: SECOND_GROUP, name: 'Grupo controlado B', simulation: false }]);
  campaign(); service.saveConfig({ enabled: true, mode: options.automatic === false ? 'evaluation' : 'automatic', availabilityMode: options.availabilityMode || 'campaign',
    monitoredGroupIds: [GROUP, SECOND_GROUP], campaignIds: ['campaign-12-pro'], sound: { enabled: false }, ...options.config }, 'owner');
  if (options.start !== false) service.start();
  t.after(async () => { for (const s of services) await s.stop(); for (const s of stores) s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const reopen = async () => { await service.stop(); store.close(); await open(); service.start(); return service; };
  return { dir, clock, gates, sent, adapter, item, campaign, event, reopen, get store() { return store; }, get service() { return service; } };
}

test('R3: anúncio normal da campanha selecionada responde iPhone 12 Pro sem cadastro de estoque nem confirmação periódica', async t => {
  const f = await fixture(t); const result = f.service.handleIncoming(f.event('EXACT-MANUAL'));
  await f.service.waitForIdle();
  assert.ok(result.opportunity, 'Uma pergunta clara de compra deve ser reconhecida.');
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].jid, `${PHONE}@s.whatsapp.net`);
  assert.match(f.sent[0].text, /iPhone 12 Pro/); assert.match(f.sent[0].text, /1\.899,00/); assert.match(f.sent[0].text, /Detalhe pequeno na lateral/);
  const task = f.store.listOpportunityTasks()[0];
  assert.equal(task.status, 'accepted'); assert.equal(task.availabilityMode, 'campaign');
  assert.equal(task.offerSnapshots[0].availabilityDeclared, true);
  assert.ok(task.offerSnapshots[0].campaignItemFingerprint);
  assert.equal(f.store.getCampaign('campaign-12-pro').items[0].availability, undefined, 'A autorização usa a campanha sem inventar um registro de estoque.');
});

test('R3: foto com legenda de campanha é uma fonte elegível sem inventar estado ou bateria ausente', async t => {
  const f = await fixture(t);
  const mediaPath = path.join(f.dir, 'foto-controlada.png'); fs.writeFileSync(mediaPath, Buffer.from('89504e470d0a1a0a', 'hex'));
  f.store.saveMedia({ id: 'photo-12-pro', path: mediaPath, mime: 'image/png', size: 8, sha256: 'a'.repeat(64) });
  f.campaign([f.item({ type: 'image', mediaId: 'photo-12-pro', text: undefined, caption: '📱 iPhone 12 Pro 256GB\nR$ 1.899,00\nDetalhe pequeno na lateral.' })]);
  f.service.handleIncoming(f.event('PHOTO')); await f.service.waitForIdle();
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].text, /Detalhe pequeno/); assert.doesNotMatch(f.sent[0].text, /lacrado|seminovo|Bateria|Azul/);
});

test('R3: pergunta simples por iPhone 12 Pro usa a configuração da campanha e informa a memória efetivamente anunciada', async t => {
  const f = await fixture(t); f.service.handleIncoming(f.event('SIMPLE-PHONE', { text: 'Alguém tem iPhone 12 Pro?' })); await f.service.waitForIdle();
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].text, /iPhone 12 Pro/); assert.match(f.sent[0].text, /256GB/);
});

test('R3: campanhas não selecionadas, grupo não monitorado e autoria não verificada não entram no automático', async t => {
  for (const scenario of ['campaign', 'group', 'identity', 'capture']) await t.test(scenario, async child => {
    const f = await fixture(child);
    if (scenario === 'campaign') f.service.saveConfig({ campaignIds: [] }, 'owner');
    if (scenario === 'capture') f.gates.capture = false;
    f.service.handleIncoming(f.event('UNSELECTED', scenario === 'group' ? { chatId: '120363000000001@g.us' } : scenario === 'identity' ? { identityVerified: false } : {}));
    await f.service.waitForIdle(); assert.equal(f.sent.length, 0); assert.equal(f.store.listOpportunityTasks().length, 0);
  });
});

test('R3: envio automático exige ativação explícita e não liga só por haver compatibilidade', async t => {
  const f = await fixture(t, { automatic: false });
  const result = f.service.handleIncoming(f.event('ONLY-NOTIFY')); await f.service.waitForIdle();
  assert.ok(result.opportunity); assert.equal(f.sent.length, 0); assert.equal(f.store.listOpportunityTasks().length, 0);
  assert.equal(f.service.getDetail(result.opportunity.id, 'owner').candidates.some(row => row.eligible), true);
});

test('R3: menção de vendedor, assistência, opinião e negativa não recebem oferta automática', async t => {
  const f = await fixture(t);
  const texts = ['Vendo iPhone 12 Pro 256GB R$ 1.899,00. Quem quer?', 'Quem tem capinha para iPhone 12 Pro 256GB?', 'iPhone 12 Pro 256GB vale a pena?',
    'Não quero iPhone 12 Pro 256GB.', 'Como configurar o iPhone 12 Pro 256GB?', 'Quero saber quanto vale iPhone 12 Pro 256GB.'];
  for (let index = 0; index < texts.length; index++) f.service.handleIncoming(f.event(`NOT-BUYING-${index}`, { text: texts[index] }));
  await f.service.waitForIdle(); assert.equal(f.sent.length, 0); assert.equal(f.store.listOpportunityTasks().length, 0);
});

test('R3: 12 Pro não oferece 12 Pro Max nem memória diferente como alternativa automática', async t => {
  const f = await fixture(t);
  f.campaign([f.item({ id: 'wrong-version', text: TEXT.replace('12 Pro', '12 Pro Max') }), f.item({ id: 'wrong-memory', text: TEXT.replace('256GB', '128GB') })]);
  f.service.handleIncoming(f.event('EXACT-VARIANT')); await f.service.waitForIdle();
  assert.equal(f.sent.length, 0); assert.equal(f.store.listOpportunityTasks().length, 0);
});

test('R3: disponibilidade negativa, retirada ou condicional nunca é ignorada pelo modo campanha', async t => {
  const patches = [{ available: false }, { availability: { available: false } }, { availability: { quantity: 0 } }, { status: 'sold' }, { status: 'reserved' },
    { opportunityAvailable: false }, { captureDeleted: true }, { text: TEXT + '\nVendido' }, { text: TEXT + '\nSob encomenda' }];
  for (const patch of patches) await t.test(JSON.stringify(patch), async child => {
    const f = await fixture(child); f.campaign([f.item(patch)]); f.service.handleIncoming(f.event('UNAVAILABLE')); await f.service.waitForIdle();
    assert.equal(f.sent.length, 0); assert.equal(f.store.listOpportunityTasks().length, 0);
  });
});

test('R3: não presume cor, condição, bateria, orçamento ou quantidade exigidos no pedido', async t => {
  const requests = ['Quem tem iPhone 12 Pro 256GB Prata?', 'Quem tem iPhone 12 Pro 256GB lacrado?', 'Quem tem iPhone 12 Pro 256GB bateria mínima 95%?',
    'Quem tem iPhone 12 Pro 256GB até R$ 1.500?', 'Preciso 2 unidades iPhone 12 Pro 256GB'];
  for (let index = 0; index < requests.length; index++) await t.test(requests[index], async child => {
    const f = await fixture(child); f.service.handleIncoming(f.event(`CONSTRAINT-${index}`, { text: requests[index] })); await f.service.waitForIdle();
    assert.equal(f.sent.length, 0); assert.equal(f.store.listOpportunityTasks().length, 0);
  });
});

test('R3: anúncios com apenas parcela ou entrada não ganham preço total por estarem na campanha', async t => {
  const f = await fixture(t);
  f.campaign([f.item({ id: 'installments', text: 'iPhone 12 Pro 256GB\n12x R$ 199,00' }), f.item({ id: 'down-payment', text: 'iPhone 12 Pro 256GB\nEntrada R$ 500,00 mais parcelas' })]);
  f.service.handleIncoming(f.event('NO-CASH-TOTAL')); await f.service.waitForIdle(); assert.equal(f.sent.length, 0);
});

test('R3: modo de confirmação manual preserva vencimento da disponibilidade e persiste ao reabrir', async t => {
  const f = await fixture(t, { availabilityMode: 'confirmed' });
  f.campaign([f.item({ unitReference: 'MANUAL-VERIFIED-UNIT', availability: { available: true, quantity: 1, confirmedAt: NOW - 3 * 3600000 } })]);
  const op = f.service.handleIncoming(f.event('STALE-CONFIRMED')).opportunity; await f.service.waitForIdle(); assert.equal(f.sent.length, 0);
  await f.reopen(); assert.equal(f.store.getOpportunityConfig().availabilityMode, 'confirmed');
  const detail = f.service.getDetail(op.id, 'owner'); assert.equal(detail.candidates.some(row => row.eligible), false);
  f.service.confirmAvailable({ offerId: detail.candidates[0].id, quantity: 1 }, 'owner');
  const preview = f.service.preview({ id: op.id }, 'owner'); assert.equal(preview.canSend, true);
});

test('R3: remover anúncio durante resolução privada cancela a reserva sem enviar', async t => {
  const f = await fixture(t, { beforeResolve: ({ store }) => store.saveCampaign({ ...store.getCampaign('campaign-12-pro'), items: [] }) });
  f.service.handleIncoming(f.event('REMOVED-DURING-RESOLVE')); await f.service.waitForIdle();
  assert.equal(f.sent.length, 0); assert.ok(['cancelled', 'failed'].includes(f.store.listOpportunityTasks()[0].status));
});

test('R3: marcar indisponível no último instante antes do relay invalida o snapshot já preparado', async t => {
  const f = await fixture(t, { beforeSubmit: ({ store }) => { const c = store.getCampaign('campaign-12-pro'); store.saveCampaign({ ...c, items: c.items.map(item => ({ ...item, available: false })) }); } });
  f.service.handleIncoming(f.event('CHANGED-BEFORE-RELAY')); await f.service.waitForIdle();
  assert.equal(f.sent.length, 0); assert.ok(['cancelled', 'failed'].includes(f.store.listOpportunityTasks()[0].status));
});

test('R3: trocar regra de disponibilidade após reservar exige revisão e não libera envio por snapshot antigo', async t => {
  const f = await fixture(t, { beforeResolve: ({ service }) => service.saveConfig({ availabilityMode: 'confirmed' }, 'owner') });
  f.service.handleIncoming(f.event('MODE-CHANGED')); await f.service.waitForIdle();
  assert.equal(f.sent.length, 0); assert.ok(['cancelled', 'failed'].includes(f.store.listOpportunityTasks()[0].status));
});

test('R3: indisponibilidade alterada depois da prévia manual não pode ser confirmada com token anterior', async t => {
  const f = await fixture(t, { automatic: false }); const op = f.service.handleIncoming(f.event('PREVIEW')).opportunity;
  const preview = f.service.preview({ id: op.id }, 'owner'); assert.equal(preview.canSend, true);
  f.campaign([f.item({ available: false })]);
  assert.throws(() => f.service.respondManual({ id: op.id, offerIds: preview.offerIds, previewToken: preview.previewToken, confirm: true }, 'owner'));
  assert.equal(f.store.listOpportunityTasks().length, 0); assert.equal(f.sent.length, 0);
});

test('R3: eventos repetidos e pedido em dois grupos reservam uma única resposta persistente', async t => {
  const f = await fixture(t); const first = f.service.handleIncoming(f.event('ONE'));
  f.service.handleIncoming(f.event('ONE')); f.service.handleIncoming(f.event('TWO', { chatId: SECOND_GROUP, text: 'Alguém tem 12 pro 256?' }));
  await f.service.waitForIdle(); assert.equal(f.sent.length, 1); assert.equal(f.store.listOpportunityTasks().length, 1);
  assert.equal(f.store.listOpportunityOrigins(first.opportunity.id).length, 2);
  await f.reopen(); f.service.handleIncoming(f.event('AFTER-RESTART', { chatId: SECOND_GROUP })); await f.service.waitForIdle();
  assert.equal(f.sent.length, 1); assert.equal(f.store.listOpportunityTasks().length, 1);
});

test('R3: anúncio republicado em outra campanha não zera a proteção por destinatário', async t => {
  const f = await fixture(t); f.service.handleIncoming(f.event('ORIGINAL')); await f.service.waitForIdle(); assert.equal(f.sent.length, 1);
  f.clock.at += 25 * 3600000; f.campaign([f.item({ id: 'republished-next-day' })], 'tomorrow-copy');
  f.service.saveConfig({ campaignIds: ['tomorrow-copy'] }, 'owner'); f.service.handleIncoming(f.event('NEXT-DAY')); await f.service.waitForIdle();
  assert.equal(f.sent.length, 1, 'Mesmo com nova procura e nova campanha, a republicação da mesma oferta pede revisão.');
});

test('R3: resultado incerto não envia substituta, não zera com reconexão e libera outro interessado', async t => {
  const f = await fixture(t, { send: (entry, n) => ({ status: n === 1 ? 'uncertain' : 'accepted', messageId: entry.controls.clientMessageId }) });
  const op = f.service.handleIncoming(f.event('UNCERTAIN')).opportunity; await f.service.waitForIdle();
  f.adapter.status.state = 'disconnected'; f.adapter.emit('status'); f.adapter.status.state = 'connected'; f.adapter.emit('status');
  f.service.handleIncoming(f.event('REPEATED-UNCERTAIN', { chatId: SECOND_GROUP }));
  f.service.handleIncoming(f.event('OTHER-PERSON', { senderNumber: '5562999999818', senderId: '5562999999818@s.whatsapp.net', senderIds: ['5562999999818@s.whatsapp.net'] }));
  await f.service.waitForIdle(); assert.equal(f.sent.length, 2); assert.equal(f.store.listOpportunityTasks({ opportunityId: op.id })[0].status, 'uncertain');
});

test('R3: perda de licença ou permissão, modo automático desligado e parada geral impedem relay', async t => {
  for (const scenario of ['license', 'permission', 'automatic', 'stop']) await t.test(scenario, async child => {
    const f = await fixture(child, { beforeResolve: ({ service, gates }) => {
      if (scenario === 'license') { gates.capture = false; gates.permission = false; }
      if (scenario === 'permission') gates.permission = false;
      if (scenario === 'automatic') service.saveConfig({ mode: 'evaluation' }, 'owner');
      if (scenario === 'stop') { gates.stopped = true; service.cancelAutomatic(); }
    } });
    f.service.handleIncoming(f.event('GATE-CHANGED')); await f.service.waitForIdle(); assert.equal(f.sent.length, 0);
  });
});

test('R3: silenciar ou responder por fora enquanto aguarda conexão cancela resposta antes de reconectar', async t => {
  for (const action of ['mute', 'outsideAnswer']) await t.test(action, async child => {
    const f = await fixture(child, { connected: false }); const op = f.service.handleIncoming(f.event('PENDING')).opportunity;
    f.service[action](op.id, 'owner'); f.adapter.status.state = 'connected'; f.adapter.emit('status'); await f.service.waitForIdle();
    assert.equal(f.sent.length, 0); assert.equal(f.store.listOpportunityTasks({ status: 'queued' }).length, 0);
  });
});
