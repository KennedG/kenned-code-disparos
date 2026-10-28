'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createStore } = require('../src/core/store.cjs');
const { parseOffers } = require('../src/core/search-parser.cjs');
const { CommerceAutomation, markupCost, publicDemandText, formatDailyReport } = require('../src/core/commerce-automation.cjs');

async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-commerce-'));
  const clock = { value: Date.parse('2026-10-05T22:59:00Z') };
  const store = await createStore(dir); store.setSetting('integrationMode', options.mode || 'whatsapp');
  const groupId = options.mode === 'simulated' ? 'offers@simulation' : '120363000000000001@g.us';
  store.upsertGroups([{ id: groupId, name: options.mode === 'simulated' ? 'Fornecedor simulado' : 'Grupo de teste autorizado', simulation: options.mode === 'simulated' }]);
  store.setSetting('buscasSettings', { enabled: true, monitoredGroupIds: [groupId], blockedGroupIds: [], blockedSupplierIds: [] });
  store.saveEntity('roles', { id: 'owner-role', isOwner: true });
  store.saveEntity('users', { id: 'owner', roleId: 'owner-role', name: 'Administrador de teste', phone: '5511999999999', active: true });
  store.saveEntity('users', { id: 'seller', name: 'Vendedor de teste', phone: '5511777777777', active: true });
  store.saveEntity('users', { id: 'manager', name: 'Gestor sem financeiro', phone: '5511666666666', active: true });
  store.saveEntity('contacts', { id: 'buyer', name: 'Comprador cadastrado', phone: '5511555555555', categories: ['Cliente Nerópolis'] });
  const permissions = { owner: new Set(['commerce.manage', 'finance.view', 'finance.reports']), manager: new Set(['commerce.manage']), seller: new Set(['search.run']) };
  const auth = { assertFor(actorId, permission) { const user = store.getEntity('users', actorId); if (!user || user.active === false || !permissions[actorId]?.has(permission)) throw Object.assign(new Error('Acesso recusado.'), { code: 'AUTH_DENIED', definitive: true, safeToRetry: false }); return user; } };
  const adapter = new EventEmitter(); adapter.status = { mode: options.mode || 'whatsapp', state: options.offline ? 'disconnected' : 'connected' }; adapter.minimumSpacingSeconds = 3;
  const calls = [], resolved = [], gate = { stopped: false };
  adapter.resolveRecipient = async number => { resolved.push(number); return options.resolve ? options.resolve(number, { store, adapter, clock, gate }) : { jid: `${number}@s.whatsapp.net`, phone: number, mode: adapter.status.mode, simulation: adapter.status.mode === 'simulated' }; };
  adapter.sendPrivate = async (number, text, metadata) => { const ledger = store.listEntities('commerce_deliveries').find(item => item.messageId === metadata.clientMessageId); assert.equal(ledger.status, 'sending'); assert(store.isOutboundMessage?.(metadata.clientMessageId) ?? true); calls.push({ number, text, metadata }); return options.send ? options.send({ number, text, metadata, store, adapter, clock, calls }) : { status: 'confirmed', confirmationScope: adapter.status.mode === 'simulated' ? 'simulation-only' : 'whatsapp-server', messageId: metadata.clientMessageId }; };
  let tail = Promise.resolve(); const scheduler = { lastSubmissionAt: null, persistenceFailed: false, runExternalSubmission(task) { const item = tail.then(task); tail = item.catch(() => {}); return item; }, blockOnPersistenceFailure() { this.persistenceFailed = true; } };
  const financeData = { date: '2026-10-05', timezone: 'America/Sao_Paulo', products: [{ model: 'iPhone 15 Pro Max', storage: '256GB', quantity: 1, totalCents: 385000, imei: 'DO-NOT-EXPORT' }], saleCount: 1, soldQuantity: 1, grossCents: 400000, totalCents: 385000, discountCents: 15000, cancellationCount: 0, cancellationCents: 0, knownCostCents: 300000, unknownCostCount: 0, feesCents: 5000, directExpensesCents: 10000, cancellationLossCents: 0, estimatedProfitCents: 70000, realizedProfitCents: 70000, generalExpensesCents: 2000, receivedByMethod: { cash: 100000, pix: 150000, debit: 0, credit: 135000 }, refundedByMethod: { cash: 0, pix: 0, debit: 0, credit: 0 }, receivedCents: 385000, refundCents: 0, priorSaleReceiptsCents: 50000, pendingCents: 0, unallocatedDepositsCents: 10000, audience: { retail: { count: 1, totalCents: 385000, estimatedProfitCents: 70000, realizedProfitCents: 70000 } }, cashSessions: [{ status: 'closed', expectedCashCents: 120000, countedCashCents: 119000, differenceCents: -1000 }], sales: [{ buyerPhone: 'DO-NOT-EXPORT', imei: 'DO-NOT-EXPORT' }] };
  const finance = { dailyReport(date, timezone) { assert.match(date, /^\d{4}-\d{2}-\d{2}$/); assert.equal(timezone, 'America/Sao_Paulo'); return { ...financeData, date }; } };
  const searches = new EventEmitter(); const incidents = [], services = [];
  const create = () => { const result = new CommerceAutomation({ store, auth, scheduler, adapter, searches, finance, now: () => clock.value, sleep: async ms => { clock.value += ms; }, isAutomationStopped: () => gate.stopped, onCriticalIncident: incident => incidents.push(incident) }); services.push(result); return result; };
  const service = create();
  const addOffer = (patch = {}) => { const id = patch.messageId || 'offer-1', at = patch.originalAt || clock.value - 30 * 60000, text = patch.text || 'iPhone 15 Pro Max 256GB Silver seminovo R$ 3.000,00'; const parsed = parseOffers(text); const offers = (Array.isArray(parsed) ? parsed : parsed.offers).map((offer, index) => ({ ...offer, id: `${groupId}:${id}:${index}`, supplierKey: patch.supplierKey || 'phone:5511888888888', supplierPhone: patch.supplierPhone === null ? null : '5511888888888', supplierName: 'Fornecedor de teste', groupId, chatId: groupId, groupName: 'Grupo de teste autorizado', messageId: id, originalAt: at, messageAt: at, snippet: offer.originalExcerpt, forwarded: patch.forwarded || false, originalSupplierKnown: !patch.forwarded, ...patch.offer })); store.upsertSearchMessage({ chatId: groupId, messageId: id, text, originalAt: at, capturedAt: clock.value, revisionAt: patch.revisionAt || at, senderId: '5511888888888@s.whatsapp.net' }, offers); return offers; };
  const opportunity = patch => service.saveOpportunity({ name: 'iPhone por até 3.500', model: 'iPhone 15 Pro Max', storageGB: 256, maxPriceCents: 350000, maxAgeMinutes: 120, groupIds: [groupId], recipientIds: ['user:owner'], ...patch }, 'owner');
  const demand = patch => service.saveDemand({ buyerName: 'Comprador cadastrado', contactId: 'buyer', model: 'iPhone 15 Pro Max', storageGB: 256, budgetCents: 350000, maxAgeMinutes: 120, groupIds: [groupId], recipientIds: ['user:owner'], markup: { type: 'fixed', valueCents: 30000 }, ...patch }, 'owner');
  t.after(async () => { for (const item of services) await item.shutdown(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, clock, adapter, calls, resolved, scheduler, auth, permissions, gate, finance, financeData, searches, incidents, service, create, addOffer, opportunity, demand, groupId };
}

test('known fixed and percentage markup calculations use cents and markup over cost', () => {
  assert.equal(markupCost(300000, { type: 'fixed', valueCents: 50000 }).finalPriceCents, 350000);
  assert.equal(markupCost(300000, { type: 'percent', basisPoints: 1000 }).finalPriceCents, 330000);
  assert.equal(markupCost(10005, { type: 'percent', basisPoints: 1000 }).finalPriceCents, 11006);
  assert.throws(() => markupCost(300000, { type: 'invalid', valueCents: 50000 }), /Escolha/);
});

test('opportunity matches exact model capacity condition price and original two-hour age', async t => {
  const f = await fixture(t); f.opportunity({ condition: 'seminovo' }); f.addOffer();
  f.addOffer({ messageId: 'wrong-version', text: 'iPhone 15 Pro 256GB Silver seminovo R$ 2.000,00' });
  f.addOffer({ messageId: 'wrong-capacity', text: 'iPhone 15 Pro Max 128GB Silver seminovo R$ 2.000,00' });
  f.addOffer({ messageId: 'wrong-condition', text: 'iPhone 15 Pro Max 256GB Silver lacrado R$ 2.000,00' });
  f.addOffer({ messageId: 'old', originalAt: f.clock.value - 121 * 60000, supplierKey: 'phone:5511444444444' });
  f.addOffer({ messageId: 'expensive', text: 'iPhone 15 Pro Max 256GB Silver seminovo R$ 4.000,00', supplierKey: 'phone:5511333333333' });
  await f.service.tick(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].number, '5511999999999'); assert(f.calls[0].text.includes('R$ 3.000,00')); assert(f.calls[0].text.includes('19:29'));
  assert.equal(f.store.listEntities('commerce_deliveries')[0].status, 'accepted');
});

test('installments, entry and ambiguous values cannot trigger cheap opportunity alert', async t => {
  const f = await fixture(t); f.opportunity();
  f.addOffer({ messageId: 'installment', text: 'iPhone 15 Pro Max 256GB Silver 12x de R$ 300,00' });
  f.addOffer({ messageId: 'entry', text: 'iPhone 15 Pro Max 256GB Silver Entrada R$ 500,00' });
  f.addOffer({ messageId: 'unknown', text: 'iPhone 15 Pro Max 256GB Silver consultar preço' });
  await f.service.tick(); assert.equal(f.calls.length, 0); assert.equal(f.store.listEntities('commerce_matches').length, 0);
});

test('same provider offer repeated and forwarded copies cannot create duplicate alerts', async t => {
  const f = await fixture(t); f.opportunity(); f.addOffer(); f.addOffer({ messageId: 'republished' });
  await Promise.all([f.service.tick(), f.service.tick(), f.service.flush()]);
  await f.service.processOffers(); await f.service.flush(); assert.equal(f.calls.length, 1); assert.equal(f.store.listEntities('commerce_matches').length, 1);
});

test('opportunity pause cancels queued delivery and deletion preserves operational ledger', async t => {
  const f = await fixture(t, { offline: true }); const rule = f.opportunity(); f.addOffer(); await f.service.tick();
  assert.equal(f.store.listEntities('commerce_deliveries')[0].status, 'pending');
  f.service.setOpportunityState(rule.id, false, 'owner'); f.adapter.status.state = 'connected'; await f.service.flush(); assert.equal(f.calls.length, 0);
  f.service.deleteOpportunity(rule.id, 'owner'); assert.equal(f.store.getEntity('opportunity_rules', rule.id).status, 'deleted'); assert.equal(f.store.listEntities('commerce_matches').length, 1);
});

test('demand matches sale price after markup and notifies administrator only', async t => {
  const f = await fixture(t); const item = f.demand({ budgetCents: 320000 }); f.addOffer(); await f.service.tick(); assert.equal(f.calls.length, 0);
  f.service.saveDemand({ ...item, budgetCents: 350000 }, 'owner'); await f.service.tick(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].number, '5511999999999'); assert(f.calls[0].text.includes('R$ 3.300,00')); assert(f.calls[0].text.includes('comprador não recebeu'));
  assert.equal(f.store.getEntity('buyer_demands', item.id).status, 'found'); assert.equal(f.store.listEntities('commerce_matches')[0].buyerNotified, false);
});

test('buyer proposal requires explicit approval, strips internal data, and never publishes automatically', async t => {
  const f = await fixture(t); f.demand(); f.addOffer(); await f.service.tick(); const match = f.store.listEntities('commerce_matches')[0];
  assert.throws(() => f.service.approveDemandMatch({ id: match.id }, 'owner'), /confirme explicitamente/);
  const result = f.service.approveDemandMatch({ id: match.id, approved: true }, 'owner'); assert.equal(result.contactId, 'buyer'); assert.equal(result.draft, true); assert.equal(result.buyerNotified, false); assert.equal(result.requiresPublicationApproval, true);
  assert.match(result.publicText, /Sob encomenda/); assert(!result.publicText.includes('5511888888888')); assert(!result.publicText.includes('Fornecedor de teste')); assert(!result.publicText.includes('3.000')); assert(!result.publicText.includes('acréscimo')); assert.equal(f.calls.length, 1);
});

test('stale edited and opted-out buyer proposals refuse approval', async t => {
  const f = await fixture(t); f.demand(); f.addOffer(); await f.service.tick(); const match = f.store.listEntities('commerce_matches')[0];
  f.store.saveEntity('contacts', { ...f.store.getEntity('contacts', 'buyer'), promotionalOptOut: true }); assert.throws(() => f.service.approveDemandMatch({ id: match.id, approved: true }, 'owner'), /recusa/);
  f.store.saveEntity('contacts', { ...f.store.getEntity('contacts', 'buyer'), promotionalOptOut: false });
  f.addOffer({ text: 'iPhone 15 Pro Max 256GB Silver seminovo R$ 4.000,00', revisionAt: f.clock.value + 1 }); assert.throws(() => f.service.approveDemandMatch({ id: match.id, approved: true }, 'owner'), /alterada|validade/);
});

test('unavailable supplier phone is shown honestly and forwarded sender never becomes original provider', async t => {
  const f = await fixture(t); f.opportunity(); f.addOffer({ supplierPhone: null, forwarded: true }); await f.service.tick(); assert.match(f.calls[0].text, /Número indisponível/); assert.match(f.calls[0].text, /fornecedor original desconhecido/);
});

test('off-line deliveries remain pending with original publication and resume once after reconnection', async t => {
  const f = await fixture(t, { offline: true }); f.opportunity(); f.addOffer(); await f.service.tick(); const original = f.store.listEntities('commerce_deliveries')[0].originalAt; assert.equal(f.calls.length, 0);
  f.clock.value += 10 * 60000; f.adapter.status.state = 'connected'; await f.service.flush(); await f.service.flush(); assert.equal(f.calls.length, 1); assert.equal(f.store.listEntities('commerce_deliveries')[0].originalAt, original);
});

test('permissions for searching administering and finance are separate on writes and recipients', async t => {
  const f = await fixture(t); assert.throws(() => f.service.saveOpportunity({ model: 'iPhone 15 Pro Max' }, 'seller'), /recusado/);
  assert.throws(() => f.opportunity({ recipientIds: ['user:seller'] }), /recusado/);
  assert.throws(() => f.service.saveReportSettings({ enabled: true, recipientIds: ['user:manager'] }, 'owner'), /recusado/);
  await assert.rejects(f.service.generateDailyReport({}, 'manager'), /recusado/);
  assert.throws(() => f.service.saveDemand({ model: 'iPhone 15 Pro Max', contactId: 'buyer', markup: { type: 'fixed', valueCents: 20000 } }, 'manager'), /recusado/);
});

test('admin-only daily report distinguishes sales profit receipts cards and physical drawer', async t => {
  const f = await fixture(t); f.service.saveReportSettings({ enabled: true, time: '20:00', recipientIds: ['user:owner'] }, 'owner'); f.clock.value += 60000; await f.service.tick();
  assert.equal(f.calls.length, 1); const text = f.calls[0].text; assert.match(text, /R\$ 3\.850,00/); assert.match(text, /R\$ 700,00/); assert.match(text, /Crédito: R\$ 1\.350,00/); assert.match(text, /Dinheiro esperado: R\$ 1\.200,00/); assert.match(text, /Recebimentos de vendas anteriores: R\$ 500,00/); assert.match(text, /Diferença: -R\$ 10,00/); assert(!text.includes('DO-NOT-EXPORT')); assert(!JSON.stringify(f.store.listEntities('daily_reports')).includes('DO-NOT-EXPORT'));
  await f.service.tick(); await f.service.flush(); assert.equal(f.calls.length, 1);
});

test('daily report actual financial updates get clearly identified version and no automatic duplicate', async t => {
  const f = await fixture(t); f.service.saveReportSettings({ enabled: true, time: '20:00', recipientIds: ['user:owner'] }, 'owner'); const first = await f.service.generateDailyReport({ date: '2026-10-05' }, 'owner'); assert.equal(first.version, 1);
  f.financeData.totalCents = 400000; f.clock.value += 60000; await f.service.tick(); assert.equal(f.calls.length, 1); assert.match(f.calls[0].text, /Versão atualizada 2/); assert.match(f.calls[0].text, /R\$ 4\.000,00/);
  f.financeData.totalCents = 410000; await f.service.tick(); assert.equal(f.calls.length, 1);
  const updated = await f.service.generateDailyReport({ date: '2026-10-05', updated: true, deliver: true }, 'owner'); assert.equal(updated.version, 3); assert.equal(f.calls.length, 2); assert.match(f.calls[1].text, /Versão atualizada 3/);
});

test('no sales and unknown costs produce explicit truthful daily report', () => {
  const text = formatDailyReport({ saleCount: 0, products: [], totalCents: 0, unknownCostCount: 2 }, { date: '2026-10-05' }); assert.match(text, /Nenhuma venda registrada/); assert.match(text, /custo desconhecido/); assert.match(text, /Lucro realizado: não informado/);
});

test('bounded safe pre-submission retry and final failure do not claim success', async t => {
  let resolveCount = 0; const f = await fixture(t, { resolve: () => { resolveCount++; throw Object.assign(new Error('Consulta temporariamente indisponível'), { code: 'WA_RECIPIENT_TIMEOUT', safeToRetry: true }); } }); f.opportunity({ maxAttempts: 2, retrySeconds: 60 }); f.addOffer(); await f.service.tick();
  assert.equal(f.store.listEntities('commerce_deliveries')[0].status, 'pending'); assert.equal(f.calls.length, 0); f.clock.value += 60000; await f.service.flush(); assert.equal(f.store.listEntities('commerce_deliveries')[0].status, 'failed'); await f.service.flush(); assert.equal(resolveCount, 2);
});

test('uncertain submission is not automatically repeated and receipt upgrades to delivered', async t => {
  const f = await fixture(t, { send: () => { throw Object.assign(new Error('Resposta perdida após submissão'), { code: 'WA_SEND_TIMEOUT' }); } }); f.opportunity(); f.addOffer(); await f.service.tick(); const item = f.store.listEntities('commerce_deliveries')[0]; assert.equal(item.status, 'uncertain'); f.clock.value += 60000; await f.service.flush(); assert.equal(f.calls.length, 1);
  f.service._receipt({ status: 'delivered', messageId: item.messageId, confirmationScope: 'whatsapp-delivered' }); assert.equal(f.store.getEntity('commerce_deliveries', item.id).status, 'delivered');
});

test('permission revoked during asynchronous recipient resolution blocks final network call', async t => {
  const f = await fixture(t, { resolve: (number, { store, adapter }) => { store.saveEntity('users', { ...store.getEntity('users', 'owner'), active: false }); return { jid: `${number}@s.whatsapp.net`, phone: number, mode: adapter.status.mode, simulation: false }; } }); f.opportunity(); f.addOffer(); await f.service.tick(); assert.equal(f.calls.length, 0); assert.equal(f.store.listEntities('commerce_deliveries')[0].status, 'failed');
});

test('STOP during recipient resolution cancels pending delivery and prevents new automatic work', async t => {
  let f; f = await fixture(t, { resolve: (number, { adapter, gate }) => { gate.stopped = true; f.service.stopPending({ userId: 'owner' }); return { jid: `${number}@s.whatsapp.net`, phone: number, mode: adapter.status.mode, simulation: false }; } }); f.opportunity(); f.addOffer(); await f.service.tick(); assert.equal(f.calls.length, 0); assert.equal(f.store.listEntities('commerce_deliveries')[0].status, 'cancelled');
  f.addOffer({ messageId: 'next' }); await f.service.tick(); assert.equal(f.store.listEntities('commerce_matches').length, 1); assert.equal(f.service.status().stopped, true);
});

test('simulation records never resolve or send while real mode is active', async t => {
  const f = await fixture(t, { mode: 'simulated', offline: true }); f.opportunity(); f.addOffer(); await f.service.tick(); assert.equal(f.store.listEntities('commerce_deliveries').length, 1);
  f.store.setSetting('integrationMode', 'whatsapp'); const real = new EventEmitter(); real.status = { mode: 'whatsapp', state: 'connected' }; real.resolveRecipient = async () => { throw new Error('Simulation leaked into real mode'); }; f.service.setAdapter(real); await f.service.tick(); assert.equal(f.store.listEntities('commerce_deliveries').length, 0); assert.equal(f.service.snapshot('owner').opportunities.length, 0); assert.equal(f.calls.length, 0);
});

test('restart converts interrupted deliveries to uncertain without resubmitting and retains persistent config', async t => {
  const f = await fixture(t, { offline: true }); const rule = f.opportunity(); f.addOffer(); await f.service.tick(); const delivery = f.store.listEntities('commerce_deliveries')[0]; f.store.saveEntity('commerce_deliveries', { ...delivery, status: 'sending' }); await f.service.shutdown(); f.store.close();
  const reopened = await createStore(f.dir); const next = new CommerceAutomation({ store: reopened, auth: f.auth, scheduler: f.scheduler, adapter: f.adapter, now: () => f.clock.value }); t.after(async () => { await next.shutdown(); reopened.close(); }); next.start(); await next.waitForIdle(); assert.equal(reopened.getEntity('commerce_deliveries', delivery.id).status, 'uncertain'); assert.equal(reopened.getEntity('opportunity_rules', rule.id).name, rule.name); assert.equal(f.calls.length, 0);
});

test('financial details remain absent from nonfinancial commerce snapshot', async t => {
  const f = await fixture(t); f.demand(); f.addOffer(); await f.service.tick(); const snapshot = f.service.snapshot('manager'); assert.equal(snapshot.reportSettings, null); assert.equal(snapshot.reports.length, 0); assert.equal(snapshot.demands[0].markup, undefined); assert.equal(snapshot.matches[0].finalPriceCents, undefined); assert.match(snapshot.deliveries[0].text, /protegido/);
});
