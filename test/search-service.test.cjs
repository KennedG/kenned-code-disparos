'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createStore, seed } = require('../src/core/store.cjs');
const { AuthService } = require('../src/core/auth.cjs');
const { SimulatedAdapter } = require('../src/adapters/simulated.cjs');
const { SearchService, validateSearchSettings, parseZonedTime, validateFilters, formatSearchResults } = require('../src/core/search-service.cjs');

const PASSWORD = 'Senha-de-teste-BUSCAS-2026';
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-search-service-'));
  const store = await createStore(dir); seed(store);
  let clock = Date.now(); const now = () => clock;
  const auth = new AuthService({ store, clock: now });
  const owner = (await auth.setupOwner({ name: 'Dono', username: 'dono', phone: '5511999990001', password: PASSWORD })).user;
  const adapter = new SimulatedAdapter({ store, delayMs: 0 }); await adapter.connect();
  const searches = new SearchService({ store, adapter, authService: auth, now, sleep: async () => {} }); searches.start();
  const group = store.listGroups()[0].id, secondGroup = store.listGroups()[1].id;
  searches.saveSettings({ enabled: true, monitoredGroupIds: [group, secondGroup], commandGroupIds: [group], privateCommandsEnabled: true, commandPrivateNumbers: [owner.phone] }, owner.id);
  t.after(async () => { await searches.shutdown(); await adapter.disconnect(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const message = (text, overrides = {}) => ({ messageId: randomUUID(), chatId: group, isGroup: true, senderId: '5511888880001@s.whatsapp.net', senderNumber: '5511888880001', verified: true, identityVerified: true, displayName: 'Fornecedor 1', savedName: null, type: 'text', text, timestamp: now(), capturedAt: now(), forwarded: false, fromMe: false, history: false, ...overrides });
  const capture = async (text, overrides = {}) => { const ctx = message(text, { dataOnly: true, ...overrides }); await searches.handleIncoming(ctx); await searches.waitForIdle(); return ctx; };
  const command = (text, overrides = {}) => message(text, { senderNumber: owner.phone, senderId: `${owner.phone}@s.whatsapp.net`, displayName: 'Dono', ...overrides });
  return { store, auth, adapter, searches, owner, group, secondGroup, now, advance: ms => { clock += ms; }, message, capture, command };
}

test('BUSCAS captures separate list products, exact versions and prices without monthly instalments', async t => {
  const f = await fixture(t);
  await f.capture('iPhone 18 Pro Max 256GB Silver lacrado R$ 7.000,00\niPhone 18 Pro 256GB Silver lacrado R$ 6.000,00\niPhone 15 128GB Preto lacrado R$ 3.500,00\niPhone 18 Pro Max 256GB Silver lacrado entrada 500 + 12x R$ 700');
  const result = await f.searches.executeSearch({ query: '18 pro Max Silver' }, f.owner.id);
  assert.equal(result.count, 1); assert.equal(result.results[0].priceCents, 700000); assert.equal(result.results[0].modelKey, 'iphone 18 pro max');
  assert.equal(result.results[0].storageGB, 256); assert.equal(result.results[0].condition, 'lacrado');
  assert.ok(f.store.querySearchOffers({ includeReview: true }).items.some(o => o.confidence === 'review'));
  assert.equal(f.store.getSearchMonitorStats().messages, 1);
});

test('command is anchored and case insensitive; results go to private owner; bare prefix returns guidance', async t => {
  const f = await fixture(t); await f.capture('iPhone 18 Pro Max 256GB Prata lacrado R$ 7.000,00');
  assert.equal(await f.searches.handleIncoming(f.command('!BuScA 18 pro Max Silver')), true);
  assert.equal(f.adapter.sent.length, 1); assert.equal(f.adapter.sent[0].target || `${f.adapter.sent[0].privateNumber}@s.whatsapp.net`, `${f.owner.phone}@s.whatsapp.net`);
  assert.match(f.adapter.sent[0].text, /7\.000,00/); assert.match(f.adapter.sent[0].text, /Valores conforme anúncios capturados/);
  assert.equal(f.adapter.replies.length, 0);
  assert.equal(await f.searches.handleIncoming(f.command('!busca')), true); assert.match(f.adapter.sent.at(-1).text, /Use !busca iPhone/);
  assert.equal(await f.searches.handleIncoming(f.command('texto !busca 18 pro Max Silver')), false);
  assert.equal(await f.searches.handleIncoming(f.command('!buscador 18 pro Max Silver')), false);
});

test('unapproved numbers, disallowed locations, forwarded and supplier-data commands are silently ignored', async t => {
  const f = await fixture(t);
  const variations = [ { senderNumber: '5511777770001', senderId: '5511777770001@s.whatsapp.net' }, { chatId: f.secondGroup }, { forwarded: true }, { history: true }, { fromMe: true }, { identityVerified: false, verified: false }, { dataOnly: true }, { isGroup: false, chatId: '5511777770001@s.whatsapp.net' } ];
  for (const override of variations) assert.equal(await f.searches.handleIncoming(f.command('!busca 18 Pro Max Silver', override)), false);
  assert.equal(f.store.listSearchRuns({ limit: 100 }).total, 0); assert.equal(f.adapter.sent.length, 0);
});

test('local roles need explicit module authorization and effective backend permissions', async t => {
  const f = await fixture(t);
  const admin = await f.auth.createUser({ name: 'Administrador', username: 'admin-buscas', phone: '5511999990002', password: PASSWORD, roleId: 'role-admin', requirePasswordChange: false, permissionOverrides: { 'search.view': true, 'search.run': true, 'search.history': true } });
  await assert.rejects(f.searches.executeSearch({ query: '18 Pro Max Silver' }, admin.id), /não está autorizado/);
  f.searches.saveAuthorization({ userId: admin.id, permissions: ['search', 'history'], enabled: true }, f.owner.id);
  assert.equal(f.searches.getState(admin.id).authorized, true);
  await f.capture('iPhone 18 Pro Max 256GB Silver lacrado R$ 7.000,00'); assert.equal((await f.searches.executeSearch({ query: '18 Pro Max Silver' }, admin.id)).count, 1);
  assert.throws(() => f.searches.saveSettings({ prefix: '!preco' }, admin.id), /não está autorizado/);
  f.searches.saveAuthorization({ userId: admin.id, permissions: ['search'], enabled: false }, f.owner.id);
  await assert.rejects(f.searches.executeSearch({ query: '18 Pro Max Silver' }, admin.id), /não está autorizado/);
  assert.equal(f.searches.getState(admin.id).authorized, false);
});

test('prefix changes, per-user limit and durable command IDs prevent duplicate replies', async t => {
  const f = await fixture(t); f.searches.saveSettings({ prefix: '!preco', userRateLimit: { max: 2, windowSeconds: 60 } }, f.owner.id);
  assert.equal(await f.searches.handleIncoming(f.command('!busca 18 Pro Max Silver')), false);
  const ctx = f.command('!PRECO 18 Pro Max Silver'); assert.equal(await f.searches.handleIncoming(ctx), true); const count = f.adapter.sent.length;
  assert.equal(await f.searches.handleIncoming(ctx), false); assert.equal(f.adapter.sent.length, count);
  assert.equal(await f.searches.handleIncoming(f.command('!preco')), true);
  assert.equal(await f.searches.handleIncoming(f.command('!preco iPhone 15')), false);
  assert.equal(f.store.listSearchRuns({ status: 'rate_limited' }).total, 1);
  f.advance(61_000); assert.equal(await f.searches.handleIncoming(f.command('!preco iPhone 15')), true);
});

test('latest same supplier offer replaces cheaper old price while condition remains separate; unavailability removes exact product', async t => {
  const f = await fixture(t);
  await f.capture('iPhone 18 Pro Max 256GB Silver lacrado R$ 6.000,00'); f.advance(1000);
  await f.capture('iPhone 18 Pro Max 256GB Silver lacrado R$ 7.000,00'); f.advance(1000);
  await f.capture('iPhone 18 Pro Max 256GB Silver seminovo R$ 5.000,00');
  let result = await f.searches.executeSearch({ query: '18 Pro Max Silver' }, f.owner.id);
  assert.deepEqual(result.results.map(o => o.priceCents), [500000, 700000]);
  f.advance(1000); await f.capture('iPhone 18 Pro Max 256GB Silver lacrado esgotado');
  result = await f.searches.executeSearch({ query: '18 Pro Max Silver' }, f.owner.id);
  assert.equal(result.count, 1); assert.equal(result.results[0].condition, 'seminovo');
});

test('edits retain original timestamps and deletes do not resurrect through later events', async t => {
  const f = await fixture(t), original = await f.capture('iPhone 18 Pro Max 256GB Silver lacrado R$ 7.000,00');
  f.advance(1000); f.adapter.emit('offerMessageUpdate', { ...original, text: 'iPhone 18 Pro Max 256GB Silver lacrado R$ 6.500,00', timestamp: undefined, revisionAt: f.now() }); await f.searches.waitForIdle();
  let result = await f.searches.executeSearch({ query: '18 Pro Max Silver' }, f.owner.id); assert.equal(result.results[0].priceCents, 650000); assert.equal(result.results[0].originalAt, original.timestamp);
  f.adapter.emit('offerMessageDelete', { chatId: f.group, messageId: original.messageId, deletedAt: f.now() }); await f.searches.waitForIdle();
  assert.equal((await f.searches.executeSearch({ query: '18 Pro Max Silver' }, f.owner.id)).count, 0);
  f.advance(1000); await f.capture(original.text, { messageId: original.messageId, timestamp: original.timestamp, revisionAt: f.now() });
  assert.equal((await f.searches.executeSearch({ query: '18 Pro Max Silver' }, f.owner.id)).count, 0);
});

test('unknown LID phone remains unavailable; forwarded copies do not pretend the reposter is original supplier', async t => {
  const f = await fixture(t);
  const text = 'iPhone 18 Pro Max 256GB Silver lacrado R$ 7.000,00\nVendas: +55 (11) 95555-1234';
  await f.capture(text, { senderId: '123456789012345@lid', senderNumber: '', displayName: 'Apelido', savedName: 'Nome salvo' });
  await f.capture(text, { forwarded: true, chatId: f.secondGroup, senderNumber: '5511888880002' });
  const answer = await f.searches.executeSearch({ query: '18 Pro Max Silver' }, f.owner.id); assert.equal(answer.count, 1);
  const formatted = formatSearchResults(answer, f.searches._settings()).join('\n'); assert.match(formatted, /Número indisponível/); assert.doesNotMatch(formatted, /123456789012345/);
  assert.match(formatted, /Nome salvo \(WhatsApp: Apelido\)/);
  assert.equal(answer.results[0].forwardedCopies, true);
});

test('disconnect creates a gap and queues delivery; reconnect sends once and uncertainty is never automatically repeated', async t => {
  const f = await fixture(t); await f.capture('iPhone 18 Pro Max 256GB Silver lacrado R$ 7.000,00');
  await f.adapter.disconnect({ reasonCode: 'internet', manual: false });
  const answer = await f.searches.executeSearch({ query: '18 Pro Max Silver' }, f.owner.id, { deliver: true }); assert.equal(answer.stale, true); assert.equal(answer.delivery[0].status, 'pending'); assert.equal(f.adapter.sent.length, 0);
  await f.adapter.connect(); await f.searches.waitForIdle(); assert.equal(f.adapter.sent.length, 1); assert.equal(f.store.listSearchDeliveries({ runId: answer.runId }).items[0].status, 'confirmed');
  f.adapter.setNextOutcome('uncertain'); const uncertain = await f.searches.executeSearch({ query: '18 Pro Max Silver' }, f.owner.id, { deliver: true }); assert.equal(uncertain.delivery[0].status, 'uncertain');
  await f.adapter.disconnect(); await f.adapter.connect(); await f.searches.flushDeliveries(); assert.equal(f.adapter.sent.length, 2);
  assert.ok(f.searches.getState(f.owner.id).monitor.gaps.length);
});

test('history and offers cleanup are separate and retain campaigns, permissions and command delivery ledgers', async t => {
  const f = await fixture(t), campaignCount = f.store.listCampaigns().length;
  await f.capture('iPhone 18 Pro Max 256GB Silver lacrado R$ 7.000,00'); const ctx = f.command('!busca 18 Pro Max Silver'); await f.searches.handleIncoming(ctx);
  const preview = f.searches.cleanupPreview({ scope: 'history' }, f.owner.id);
  await assert.rejects(f.searches.clearData({ ...preview, confirmation: 'apagar' }, f.owner.id), /APAGAR/);
  await f.searches.clearData({ ...preview, confirmation: 'APAGAR' }, f.owner.id); assert.equal(f.store.listSearchHistory().total, 0); assert.equal(f.store.getSearchMonitorStats().offers, 1);
  assert.equal(await f.searches.handleIncoming(ctx), false); assert.equal(f.adapter.sent.length, 1);
  const base = f.searches.cleanupPreview({ scope: 'base' }, f.owner.id); await f.searches.clearData({ ...base, confirmation: 'APAGAR' }, f.owner.id);
  assert.equal(f.store.getSearchMonitorStats().offers, 0); assert.equal(f.store.listCampaigns().length, campaignCount); assert.equal(f.store.listSearchDeliveries().total, 1); assert.equal(f.store.listSearchRuns().total, 1); assert.equal(f.store.getSetting('buscasSettings').enabled, true);
});

test('recipient destinations require explicit origin enabling and valid registered contacts', () => {
  assert.throws(() => validateSearchSettings({ recipientMode: 'origin' }), /habilitação explícita/);
  assert.throws(() => validateSearchSettings({ commandPrivateNumbers: ['1234'] }), /telefone real/);
  assert.throws(() => validateSearchSettings({ maxResults: 11 }), /entre 1 e 10/);
  assert.throws(() => validateSearchSettings({ prefix: '!busca agora' }), /prefixo/);
  assert.equal(validateSearchSettings({ aliases: { prata: 'silver' } }).aliases.prata, 'silver');
});

test('blocked supplier does not reappear through a forwarded copy and independent original sellers remain eligible', async t => {
  const f = await fixture(t), text = 'iPhone 18 Pro Max 256GB Silver lacrado R$ 7.000,00';
  await f.capture(text); await f.capture(text, { forwarded: true, chatId: f.secondGroup });
  await f.capture(text, { senderNumber: '5511888880003', senderId: '5511888880003@s.whatsapp.net', displayName: 'Fornecedor independente' });
  f.searches.saveSettings({ blockedSupplierIds: ['phone:5511888880001'] }, f.owner.id);
  const result = await f.searches.executeSearch({ query: '18 Pro Max Silver' }, f.owner.id);
  assert.equal(result.count, 1); assert.equal(result.results[0].supplierPhone, '5511888880003'); assert.equal(result.results[0].forwarded, false);
});

test('commands awaiting the serial queue honor module, location and prefix changes before execution', async t => {
  const f = await fixture(t);
  for (const change of [{enabled:false},{commandGroupIds:[]},{prefix:'!preco'}]) {
    f.searches.saveSettings({enabled:true,commandGroupIds:[f.group],prefix:'!busca'},f.owner.id);
    let release; f.searches.commandTail = new Promise(resolve => { release = resolve; });
    const pending = f.searches.handleIncoming(f.command('!busca 18 Pro Max Silver'));
    f.searches.saveSettings(change,f.owner.id); release();
    assert.equal(await pending,false);
  }
  assert.equal(f.store.listSearchRuns().total,0); assert.equal(f.adapter.sent.length,0);
});

test('price-only review cannot promote offers with ambiguous product association', async t => {
  const f = await fixture(t);
  await f.capture('iPhone 18 Pro Max 256/512GB Silver lacrado R$ 7.000,00');
  const offer = f.store.querySearchOffers({includeReview:true}).items[0];
  assert.equal(offer.confidence,'review'); assert.ok(offer.reviewReasons.includes('ambiguous_storage'));
  assert.throws(() => f.searches.reviewOffer({id:offer.id,decision:'confirm',priceCents:700000},f.owner.id),/associação entre produto e preço/);
  assert.equal(f.store.getSearchOffer(offer.id).confidence,'review');
  assert.equal((await f.searches.executeSearch({query:'18 Pro Max Silver'},f.owner.id)).count,0);
});

test('custom periods use configured timezone and reject normalized invalid calendar dates', () => {
  assert.equal(parseZonedTime('2026-10-02T09:30','America/Sao_Paulo'),Date.UTC(2026,9,2,12,30));
  assert.equal(parseZonedTime('2026-10-02T09:30:00-03:00','America/Sao_Paulo'),Date.UTC(2026,9,2,12,30));
  assert.equal(parseZonedTime('2026-10-02T12:30:00.125Z','America/Sao_Paulo'),Date.UTC(2026,9,2,12,30,0,125));
  for(const value of ['2026-02-30T09:00','2026-02-30T09:00:00Z','2026-02-30T09:00:00-03:00','2026-10-02T24:00:00Z']) assert.throws(()=>parseZonedTime(value,'America/Sao_Paulo'),/inválid/);
  assert.throws(()=>parseZonedTime('2026-03-08T02:30','America/New_York'),/não existe/);
  assert.throws(()=>validateFilters({minBattery:101}),/entre/);
  assert.throws(()=>validateFilters({minPriceCents:800000,maxPriceCents:700000}),/mínimo/);
});

test('default battery, price, warranty and supplier filters preserve exact model and latest offer semantics',async t=>{
  const f=await fixture(t);
  await f.capture('iPhone 18 Pro Max 256GB Silver seminovo bateria 90% garantia 6 meses R$ 6.000,00');
  f.advance(1000); await f.capture('iPhone 18 Pro Max 256GB Silver seminovo bateria 90% garantia 6 meses R$ 7.500,00');
  await f.capture('iPhone 18 Pro Max 256GB Silver seminovo bateria 80% garantia 6 meses R$ 6.500,00',{senderNumber:'5511888880002',senderId:'5511888880002@s.whatsapp.net'});
  await f.capture('iPhone 18 Pro Max 256GB Silver seminovo bateria 95% garantia 3 meses R$ 7.000,00',{senderNumber:'5511888880003',senderId:'5511888880003@s.whatsapp.net'});
  f.searches.saveSettings({defaultFilters:{minBattery:85,maxPriceCents:700000,warranty:'6 meses'}},f.owner.id);
  assert.equal((await f.searches.executeSearch({query:'18 Pro Max Silver'},f.owner.id)).count,0);
  f.searches.saveSettings({defaultFilters:{minBattery:85,maxPriceCents:800000,warranty:'6 meses',supplier:'5511888880001'}},f.owner.id);
  const result=await f.searches.executeSearch({query:'18 Pro Max Silver'},f.owner.id);assert.equal(result.count,1);assert.equal(result.results[0].priceCents,750000);
});

test('search history distinguishes local queries, pending private results and confirmed or uncertain deliveries', async t => {
  const f=await fixture(t);await f.capture('iPhone 18 Pro Max 256GB Silver lacrado R$ 7.000,00');
  const local=await f.searches.executeSearch({query:'18 Pro Max Silver'},f.owner.id);
  await f.adapter.disconnect({reasonCode:'internet',manual:false});
  const remote=await f.searches.executeSearch({query:'18 Pro Max Silver'},f.owner.id,{deliver:true});
  let history=f.searches.listHistory({limit:20},f.owner.id);
  assert.equal(history.items.find(r=>r.id===local.runId).deliveryStatus,'local');
  let row=history.items.find(r=>r.id===remote.runId);assert.equal(row.status,'completed');assert.equal(row.deliveryStatus,'pending');assert.equal(row.deliveryParts,1);assert.equal(row.deliveryCounts.confirmed,0);assert.deepEqual(row.deliveryTargets,[`${f.owner.phone}@s.whatsapp.net`]);
  assert.equal(row.text,undefined);assert.equal(row.clientMessageId,undefined);
  await f.adapter.connect();await f.searches.waitForIdle();
  row=f.searches.getState(f.owner.id).history.items.find(r=>r.id===remote.runId);assert.equal(row.deliveryStatus,'confirmed');assert.equal(row.deliveryCounts.confirmed,row.deliveryParts);assert.ok(row.deliveryResultAt);
  f.adapter.setNextOutcome('uncertain');const uncertain=await f.searches.executeSearch({query:'18 Pro Max Silver'},f.owner.id,{deliver:true});
  assert.equal(f.searches.listHistory({},f.owner.id).items.find(r=>r.id===uncertain.runId).deliveryStatus,'uncertain');
  const user=await f.auth.createUser({name:'Busca sem histórico',username:'busca-sem-historico',phone:'5511999990004',password:PASSWORD,roleId:'role-admin',requirePasswordChange:false,permissionOverrides:{'search.view':true,'search.run':true}});
  f.searches.saveAuthorization({userId:user.id,permissions:['search'],enabled:true},f.owner.id);
  assert.throws(()=>f.searches.listHistory({},user.id),/não está autorizado/);assert.equal(f.searches.getState(user.id).history.total,0);
});

test('supplier filters inspect identity fields and bare blocked phones match trusted sender keys',async t=>{
  const f=await fixture(t);await f.capture('iPhone 18 Pro Max 256GB Silver lacrado R$ 7.000,00',{displayName:'Márcia Atacado'});
  assert.equal((await f.searches.executeSearch({query:'18 Pro Max Silver',filters:{supplier:'iphone'}},f.owner.id)).count,0);
  assert.equal((await f.searches.executeSearch({query:'18 Pro Max Silver',filters:{supplier:'marcia'}},f.owner.id)).count,1);
  assert.deepEqual(f.searches.saveSettings({blockedSupplierIds:['5511888880001','phone:5511888880001','account:trusted@lid']},f.owner.id).blockedSupplierIds,['phone:5511888880001','account:trusted@lid']);
  assert.equal((await f.searches.executeSearch({query:'18 Pro Max Silver'},f.owner.id)).count,0);
});
