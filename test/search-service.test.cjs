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
  return { dir, store, auth, adapter, searches, owner, group, secondGroup, now, advance: ms => { clock += ms; }, message, capture, command };
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

test('manual commands from the authenticated own account work in self chat and are deduplicated; automation and non-owner self identity are rejected', async t => {
  const f = await fixture(t); f.adapter.setOwnAccount(f.owner.phone);
  const own = f.command('!busca iPhone 18 Pro Max Silver', { chatId: `${f.owner.phone}@s.whatsapp.net`, isGroup: false, fromMe: true, trustedSelf: true, ownAccountNumber: f.owner.phone, ownAccountId: f.adapter.status.ownAccountId, machineGenerated: false, simulation: true, accountId: f.adapter.status.ownAccountId });
  assert.equal(await f.searches.handleIncoming(own), true); assert.match(f.adapter.sent.at(-1).text, /Não foram encontradas ofertas compatíveis/);
  const sent = f.adapter.sent.length; assert.equal(await f.searches.handleIncoming(own), false); assert.equal(f.adapter.sent.length, sent);
  for (const changed of [{ trustedSelf: false }, { ownAccountNumber: '5511999990003' }, { machineGenerated: true }, { automaticMessage: true }, { forwarded: true }, { history: true }]) assert.equal(await f.searches.handleIncoming({ ...own, ...changed, messageId: randomUUID() }), false);
  f.searches.saveSettings({ privateCommandsEnabled: false, commandPrivateNumbers: [], selfCommandsEnabled: false }, f.owner.id);
  assert.equal(await f.searches.handleIncoming({ ...own, messageId: randomUUID() }), false);
  f.searches.saveSettings({ selfCommandsEnabled: true }, f.owner.id);
  assert.equal(await f.searches.handleIncoming({ ...own, messageId: randomUUID() }), true);
  const records = f.store.listEntities('diagnostics'); const trace = records.filter(r => r.traceId && r.stage === 'buscas.results'); assert.equal(trace.length, 2); assert.equal(trace[0].detail.resultCount, 0);
  assert.ok(records.some(r => r.stage === 'buscas.authorization' && r.detail.approved === true)); assert.ok(records.some(r => r.stage === 'buscas.rejected' && r.detail.reason === 'duplicate_message'));
});

test('own-account permission requires the active owner mapped to the authenticated phone and respects enabled command groups', async t => {
  const f = await fixture(t), admin = await f.auth.createUser({ name: 'Admin', username: 'admin-self', phone: '5511999990002', password: PASSWORD, roleId: 'role-admin', requirePasswordChange: false, permissionOverrides: { 'search.view': true, 'search.run': true } });
  f.searches.saveAuthorization({ userId: admin.id, permissions: ['search'] }, f.owner.id); f.adapter.setOwnAccount(admin.phone);
  const base = f.command('!busca iPhone 18 Pro Max Silver', { senderNumber: admin.phone, fromMe: true, trustedSelf: true, ownAccountNumber: admin.phone });
  assert.equal(await f.searches.handleIncoming(base), false);
  f.adapter.setOwnAccount(f.owner.phone);
  assert.equal(await f.searches.handleIncoming(f.command(base.text, { fromMe: true, trustedSelf: true, ownAccountNumber: f.owner.phone, chatId: f.secondGroup })), false);
});

test('configured private recipients are used exactly, resolution precedes submission and test-send exposes pending then ACK status', async t => {
  const f = await fixture(t); f.store.saveAlertRecipient({ id: 'responsible', name: 'Responsável', phone: '5511888877777', enabled: true });
  f.searches.saveSettings({ recipientMode: 'responsibles', responsibleRecipientIds: ['responsible'] }, f.owner.id);
  const resolved = []; f.adapter.resolveRecipient = async number => { resolved.push(number); return { jid: `${number}@s.whatsapp.net`, phone: number }; };
  await f.searches.handleIncoming(f.command('!busca iPhone 18 Pro Max Silver'));
  assert.deepEqual(resolved, ['5511888877777']); assert.equal(f.adapter.sent[0].privateNumber, '5511888877777'); assert.notEqual(f.adapter.sent[0].targetId, f.group);
  f.searches.saveSettings({ enabled: false }, f.owner.id);
  const delivery = await f.searches.testRecipient({ recipientId: `user:${f.owner.id}` }, f.owner.id); assert.ok(['pending', 'sending'].includes(delivery.status));
  await f.searches.waitForIdle(); const state = f.searches.getRecipientStatus(f.owner.id); assert.equal(state.recipients.find(r => r.id === `user:${f.owner.id}`).status, 'confirmed');
  const stored = f.store.getSearchDelivery(delivery.id); f.adapter.emit('receipt', { messageId: stored.messageId, status: 'confirmed', confirmationScope: 'delivered', deliveredAt: f.now(), simulation: true });
  assert.equal(f.store.getSearchDelivery(delivery.id).deliveredAt, f.now()); assert.equal(f.store.getSearchDelivery(delivery.id).confirmationScope, 'delivered');
});

test('invalid explicitly selected owner never substitutes another recipient and a failure notice identifies the reason', async t => {
  const f = await fixture(t); f.searches.saveSettings({ ownerRecipientUserId: f.owner.id }, f.owner.id);
  const owner = f.store.getEntity('users', f.owner.id); f.store.saveEntity('users', { ...owner, phone: '' });
  await assert.rejects(f.searches.executeSearch({ query: 'iPhone 18 Pro Max Silver' }, f.owner.id, { deliver: true }), { code: 'SEARCH_OWNER_RECIPIENT_INVALID' }); assert.equal(f.adapter.sent.length, 0);
  f.store.saveEntity('users', { ...owner, phone: owner.phone });
  f.searches.saveSettings({ defaultFilters: { model: 'produto desconhecido' } }, f.owner.id);
  assert.equal(await f.searches.handleIncoming(f.command('!busca iPhone 18 Pro Max Silver')), true);
  assert.match(f.adapter.sent.at(-1).text, /Kenned Code Disparos/); assert.match(f.adapter.sent.at(-1).text, /filtros ou a configuração/);
  assert.ok(f.store.listSearchHistory().items.some(r => r.status === 'failed' && r.error));
});

test('safe recipient-resolution failures can be retried manually, uncertainty and confirmed delivery cannot', async t => {
  const f = await fixture(t); let failResolve = true;
  f.adapter.resolveRecipient = async number => { if (failResolve) throw Object.assign(new Error('raw sensitive detail must never enter diagnostics'), { code: 'RECIPIENT_NOT_REGISTERED', definitive: true }); return { jid: `${number}@s.whatsapp.net` }; };
  const first = await f.searches.testRecipient({ recipientId: `user:${f.owner.id}` }, f.owner.id); await f.searches.waitForIdle(); const failed = f.store.getSearchDelivery(first.id);
  assert.equal(failed.status, 'failed'); assert.equal(f.adapter.sent.length, 0); assert.equal(failed.safeToRetry, true); assert.match(failed.error, /não foi encontrado no WhatsApp/);
  failResolve = false; await f.searches.retryDelivery({ id: first.id }, f.owner.id); assert.equal(f.store.getSearchDelivery(first.id).status, 'confirmed');
  await assert.rejects(f.searches.retryDelivery({ id: first.id }, f.owner.id), { code: 'SEARCH_RETRY_UNSAFE' });
  f.adapter.setNextOutcome('uncertain'); const uncertain = await f.searches.testRecipient({ recipientId: `user:${f.owner.id}` }, f.owner.id); await f.searches.waitForIdle(); await assert.rejects(f.searches.retryDelivery({ id: uncertain.id }, f.owner.id), { code: 'SEARCH_RETRY_UNSAFE' });
  assert.equal(JSON.stringify(f.store.listEntities('diagnostics')).includes('raw sensitive detail'), false);
});

test('a destination removed during asynchronous WhatsApp resolution is revalidated and receives no result', async t => {
  const f = await fixture(t); f.store.saveAlertRecipient({ id: 'to-revoke', name: 'Destino', phone: '5511888877777', enabled: true });
  f.searches.saveSettings({ recipientMode: 'responsibles', responsibleRecipientIds: ['to-revoke'] }, f.owner.id);
  let entered, resume; const lookupEntered = new Promise(resolve => { entered = resolve; }), lookupBlocked = new Promise(resolve => { resume = resolve; });
  f.adapter.resolveRecipient = async number => { entered(); await lookupBlocked; return { jid: `${number}@s.whatsapp.net` }; };
  const command = f.searches.handleIncoming(f.command('!busca iPhone 18 Pro Max Silver')); await lookupEntered;
  f.searches.saveSettings({ recipientMode: 'owner', ownerRecipientUserId: f.owner.id }, f.owner.id); resume(); await command; await f.searches.waitForIdle();
  assert.equal(f.adapter.sent.length, 1); assert.equal(f.adapter.sent[0].privateNumber, f.owner.phone); assert.match(f.adapter.sent[0].text, /autorização mudou/); assert.equal(f.store.listSearchDeliveries().items[0].status, 'failed'); assert.equal(f.store.listSearchDeliveries().items[0].code, 'SEARCH_TARGET_DISABLED');
});

test('recipient status reads latest delivery after more than 500 older records, and group synchronization refreshes search selectors', async t => {
  const f = await fixture(t);
  f.store.transaction(() => { for (let i = 0; i < 505; i++) f.store.saveSearchDelivery({ id: `old-${i}`, runId: `old-run-${i}`, actorId: f.owner.id, createdAt: f.now() - 10000 + i, status: 'confirmed', target: `${f.owner.phone}@s.whatsapp.net` }); });
  const test = await f.searches.testRecipient({ recipientId: `user:${f.owner.id}` }, f.owner.id); await f.searches.waitForIdle();
  const latest = f.searches.getRecipientStatus(f.owner.id).recipients.find(r => r.id === `user:${f.owner.id}`); assert.equal(latest.deliveryId, test.id); assert.equal(latest.status, 'confirmed');
  f.store.upsertGroups([{ id: 'sim-20@simulation', name: 'Novo grupo', simulation: true }]); assert.ok(f.searches.getState(f.owner.id).groups.some(g => g.id === 'sim-20@simulation'));
});

test('a private result failure produces one private error notice without replacing result status or looping on failed notices', async t => {
  const f = await fixture(t); f.store.saveAlertRecipient({ id: 'bad-contact', name: 'Inválido', phone: '5511888877777', enabled: true });
  f.searches.saveSettings({ recipientMode: 'responsibles', responsibleRecipientIds: ['bad-contact'] }, f.owner.id);
  f.adapter.resolveRecipient = async number => { if (number === '5511888877777') throw Object.assign(new Error('secret upstream'), { code: 'WA_RECIPIENT_NOT_FOUND', definitive: true }); return { jid: `${number}@s.whatsapp.net` }; };
  const command = f.command('!busca iPhone 18 Pro Max Silver'); await f.searches.handleIncoming(command); await f.searches.waitForIdle();
  assert.equal(f.adapter.sent.length, 1); assert.equal(f.adapter.sent[0].privateNumber, f.owner.phone); assert.match(f.adapter.sent[0].text, /número configurado não foi encontrado/); assert.doesNotMatch(f.adapter.sent[0].text, /Encontradas|secret upstream/);
  const history = f.searches.listHistory({}, f.owner.id).items[0]; assert.equal(history.deliveryStatus, 'failed'); assert.deepEqual(history.deliveryTargets, ['5511888877777@s.whatsapp.net']);
  assert.equal(f.searches.getRecipientStatus(f.owner.id).recipients.find(r => r.id === 'bad-contact').status, 'failed');
  await f.searches.flushDeliveries(); assert.equal(f.adapter.sent.length, 1);
  f.adapter.resolveRecipient = async () => { throw Object.assign(new Error(), { code: 'WA_RECIPIENT_NOT_FOUND', definitive: true }); };
  await f.searches.handleIncoming(f.command('!busca iPhone 18 Pro Max Silver')); await f.searches.waitForIdle(); const runs = f.store.listSearchRuns().items; const newest = runs.sort((a,b)=>b.requestedAt-a.requestedAt)[0]; assert.equal(f.store.listSearchDeliveries({ runId: newest.id }).total, 2); assert.equal(f.store.listSearchDeliveries({ runId: newest.id }).items.filter(d=>d.errorNotice).length, 1);
});

test('requester delivery uses the actual authorized requesting phone rather than a different primary profile number', async t => {
  const f = await fixture(t), alternate = '5511999990008';
  const user = f.store.getEntity('users', f.owner.id); f.store.saveEntity('users', { ...user, authorizedPhones: [alternate] });
  f.searches.saveSettings({ recipientMode: 'requester' }, f.owner.id);
  await f.searches.handleIncoming(f.command('!busca iPhone 18 Pro Max Silver', { senderNumber: alternate, senderId: `${alternate}@s.whatsapp.net` }));
  assert.equal(f.adapter.sent.length, 1); assert.equal(f.adapter.sent[0].privateNumber, alternate);
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


test('rolling two-hour window uses original publication time, supports minutes/hours and disabling without fake cheap prices', async t => {
  const f = await fixture(t);
  const capture = (value, ageMinutes, suffix) => f.capture(`iPhone 15 Pro Max 256GB Silver seminovo ${value}`, { timestamp: f.now() - ageMinutes * 60_000, senderNumber: `55118888800${suffix}`, senderId: `55118888800${suffix}@s.whatsapp.net` });
  await capture('R$ 3.900,00', 121, '11');
  await capture('R$ 4.100,00', 120, '12');
  await capture('R$ 4.200,00', 70, '13');
  await capture('R$ 4.700,00', 5, '14');
  await capture('entrada R$ 900 + 12x R$ 450', 4, '15');
  await capture('consulte o preço', 3, '16');
  let result = await f.searches.executeSearch({ query: 'iPhone 15 Pro Max 256GB' }, f.owner.id);
  assert.deepEqual(result.results.map(o => o.priceCents), [410000, 420000, 470000]);
  assert.equal(result.period.from, f.now() - 120 * 60_000); assert.equal(result.period.maxAgeMinutes, 120);
  assert.match(formatSearchResults(result, f.searches._settings()).join('\n'), /últimas 2 horas/);
  f.searches.saveSettings({ maxAgeValue: 60, maxAgeUnit: 'minutes' }, f.owner.id);
  result = await f.searches.executeSearch({ query: 'iPhone 15 Pro Max 256GB' }, f.owner.id);
  assert.deepEqual(result.results.map(o => o.priceCents), [470000]);
  f.searches.saveSettings({ maxAgeEnabled: false }, f.owner.id);
  result = await f.searches.executeSearch({ query: 'iPhone 15 Pro Max 256GB' }, f.owner.id);
  assert.equal(result.period.from, null); assert.equal(result.period.maxAgeMinutes, null);
  assert.deepEqual(result.results.map(o => o.priceCents), [390000, 410000, 420000, 470000]);
  assert.match(formatSearchResults(result, f.searches._settings()).join('\n'), /Sem limite de idade/);
  assert.ok(result.results.every(o => Number.isSafeInteger(o.priceCents) && o.priceKind === 'cash'));
});

test('an edited old offer stays outside the two-hour window even when captured or edited now', async t => {
  const f = await fixture(t), old = await f.capture('iPhone 15 Pro Max 256GB Silver seminovo R$ 3.500,00', { timestamp: f.now() - 121 * 60_000 });
  f.adapter.emit('offerMessageUpdate', { ...old, timestamp: f.now(), revisionAt: f.now(), text: 'iPhone 15 Pro Max 256GB Silver seminovo R$ 3.400,00' });
  await f.searches.waitForIdle();
  assert.equal((await f.searches.executeSearch({ query: 'iPhone 15 Pro Max' }, f.owner.id)).count, 0);
  f.searches.saveSettings({ maxAgeEnabled: false }, f.owner.id);
  const result = await f.searches.executeSearch({ query: 'iPhone 15 Pro Max' }, f.owner.id);
  assert.equal(result.count, 1); assert.equal(result.results[0].originalAt, old.timestamp); assert.equal(result.results[0].priceCents, 340000);
});

test('higher-price and newest sorting happen before the ten-result limit and saved preferences survive reopening SQLite', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 12; i++) { f.advance(1000); await f.capture(`iPhone 15 Pro Max 256GB Silver seminovo R$ ${5000 + i * 100}`, { senderNumber: `55118888000${String(i).padStart(2, '0')}`, displayName: `Fornecedor ${i}` }); }
  f.searches.saveSettings({ sort: 'cashDescending', maxAgeValue: 90, maxAgeUnit: 'minutes', defaultFilters: { storageGB: 256, condition: 'seminovo', groupIds: [f.group] } }, f.owner.id);
  let result = await f.searches.executeSearch({ query: 'iPhone 15 Pro Max' }, f.owner.id);
  assert.equal(result.count, 10); assert.equal(result.results[0].priceCents, 610000); assert.equal(result.results.at(-1).priceCents, 520000);
  f.searches.saveSettings({ sort: 'recent' }, f.owner.id); result = await f.searches.executeSearch({ query: 'iPhone 15 Pro Max' }, f.owner.id);
  assert.equal(result.results[0].priceCents, 610000);
  f.searches.saveSettings({ sort: 'cashAscending' }, f.owner.id); result = await f.searches.executeSearch({ query: 'iPhone 15 Pro Max' }, f.owner.id);
  assert.equal(result.results[0].priceCents, 500000);
  const reopened = await createStore(f.dir); t.after(() => reopened.close());
  assert.equal(reopened.getSetting('buscasSettings').maxAgeValue, 90); assert.equal(reopened.getSetting('buscasSettings').maxAgeUnit, 'minutes');
  assert.equal(reopened.getSetting('buscasSettings').sort, 'cashAscending'); assert.deepEqual(reopened.getSetting('buscasSettings').defaultFilters.groupIds, [f.group]);
});

test('configured model, storage, condition, supplier and group filters use captured metadata', async t => {
  const f = await fixture(t);
  await f.capture('iPhone 15 Pro Max 256GB Silver seminovo R$ 3.850,00', { displayName: 'Loja Alfa' });
  await f.capture('iPhone 15 Pro Max 512GB Silver lacrado R$ 5.500,00', { senderNumber: '5511888880002', displayName: 'Loja Beta', chatId: f.secondGroup });
  f.searches.saveSettings({ defaultFilters: { model: 'iPhone 15 Pro Max', storageGB: 256, condition: 'seminovo', supplier: 'Alfa', groupIds: [f.group] } }, f.owner.id);
  const result = await f.searches.executeSearch({ query: 'iPhone 15 Pro Max' }, f.owner.id);
  assert.equal(result.count, 1); assert.equal(result.results[0].supplierName, 'Loja Alfa'); assert.equal(result.results[0].groupId, f.group);
  assert.equal((await f.searches.executeSearch({ query: 'iPhone 15 Pro Max', filters: { groupIds: [f.secondGroup] } }, f.owner.id)).count, 0);
  assert.throws(() => f.searches.saveSettings({ defaultFilters: { groupIds: ['not-a-loaded-group@g.us'] } }, f.owner.id), /grupos disponíveis/);
});

test('authorized incoming private search replies only to the requester despite configured owner or responsible recipients', async t => {
  const f = await fixture(t);
  const requester = await f.auth.createUser({ name: 'Pessoa autorizada', username: 'private-buscas', phone: '5511999990002', password: PASSWORD, roleId: 'role-admin', requirePasswordChange: false, permissionOverrides: { 'search.view': true, 'search.run': true } });
  f.searches.saveAuthorization({ userId: requester.id, permissions: ['search'] }, f.owner.id);
  f.searches.saveSettings({ privateCommandsEnabled: true, commandPrivateNumbers: [], recipientMode: 'owner' }, f.owner.id);
  await f.capture('iPhone 15 Pro Max 256GB Azul seminovo R$ 3.850,00');
  const incoming = f.adapter.injectIncoming({ text: '!busca iPhone 15 Pro Max 256GB', senderNumber: requester.phone, isGroup: false }); await f.searches.waitForIdle();
  assert.equal(f.adapter.sent.length, 1); assert.equal(f.adapter.sent[0].targetId, `${requester.phone}@s.whatsapp.net`);
  assert.match(f.adapter.sent[0].text, /RESULTADO DA BUSCA/); assert.match(f.adapter.sent[0].text, /3\.850,00/); assert.match(f.adapter.sent[0].text, /Cor: Azul/i);
  assert.equal(f.store.listSearchDeliveries().items[0].status, 'confirmed');
  assert.equal(await f.searches.handleIncoming(incoming), false); assert.equal(f.adapter.sent.length, 1);
  f.store.saveAlertRecipient({ id: 'responsible-other', name: 'Outro destinatário', phone: '5511999990003', enabled: true });
  f.searches.saveSettings({ recipientMode: 'responsibles', responsibleRecipientIds: ['responsible-other'] }, f.owner.id);
  f.adapter.injectIncoming({ text: '!busca iPhone 18 Pro Max', senderNumber: requester.phone, isGroup: false }); await f.searches.waitForIdle();
  assert.equal(f.adapter.sent.at(-1).targetId, `${requester.phone}@s.whatsapp.net`); assert.match(f.adapter.sent.at(-1).text, /Não foram encontradas ofertas compatíveis/);
  f.adapter.injectIncoming({ text: '!busca', senderNumber: requester.phone, isGroup: false }); await f.searches.waitForIdle();
  assert.equal(f.adapter.sent.at(-1).targetId, `${requester.phone}@s.whatsapp.net`); assert.match(f.adapter.sent.at(-1).text, /Use !busca iPhone/);
  assert.ok(f.adapter.sent.every(send => send.targetId === `${requester.phone}@s.whatsapp.net`));
});

test('private default allows explicitly authorized users while unapproved identities, an explicit disable and a restricted whitelist are respected', async t => {
  const f = await fixture(t); f.searches.saveSettings({ privateCommandsEnabled: true, commandPrivateNumbers: [] }, f.owner.id);
  assert.equal(validateSearchSettings({}).privateCommandsEnabled, true);
  const before = f.adapter.sent.length;
  f.adapter.injectIncoming({ text: '!busca iPhone 15 Pro Max', senderNumber: '5511999990099', displayName: 'Dono', isGroup: false }); await f.searches.waitForIdle(); assert.equal(f.adapter.sent.length, before);
  f.adapter.injectIncoming({ text: '!busca', senderNumber: f.owner.phone, isGroup: false }); await f.searches.waitForIdle(); assert.equal(f.adapter.sent.length, before + 1);
  f.searches.saveSettings({ privateCommandsEnabled: false }, f.owner.id);
  f.adapter.injectIncoming({ text: '!busca', senderNumber: f.owner.phone, isGroup: false }); await f.searches.waitForIdle(); assert.equal(f.adapter.sent.length, before + 1);
  const diagnostics = f.store.queryEntities('diagnostics', { limit: 100 }).items;
  assert.ok(diagnostics.some(d => d.stage === 'buscas.rejected' && /Comando privado bloqueado/.test(d.description)));
  const other = await f.auth.createUser({ name: 'Outro', username: 'private-whitelist', phone: '5511999990004', password: PASSWORD, roleId: 'role-admin', requirePasswordChange: false });
  f.searches.saveSettings({ privateCommandsEnabled: true, commandPrivateNumbers: [other.phone] }, f.owner.id);
  f.adapter.injectIncoming({ text: '!busca', senderNumber: f.owner.phone, isGroup: false }); await f.searches.waitForIdle(); assert.equal(f.adapter.sent.length, before + 1);
});

test('global automation guard blocks new search deliveries and prevents queued sends until an explicit resumption', async t => {
  const f = await fixture(t); let allowed = true; f.searches.setAutomationGuard(() => allowed);
  await f.adapter.disconnect(); const pending = await f.searches.executeSearch({ query: 'iPhone 15 Pro Max' }, f.owner.id, { deliver: true });
  assert.equal(pending.delivery[0].status, 'pending'); allowed = false;
  await f.adapter.connect(); await f.searches.waitForIdle(); assert.equal(f.adapter.sent.length, 0);
  await assert.rejects(f.searches.executeSearch({ query: 'iPhone 15 Pro Max' }, f.owner.id, { deliver: true }), { code: 'AUTOMATION_STOPPED' });
  assert.equal((await f.searches.executeSearch({ query: 'iPhone 15 Pro Max' }, f.owner.id)).count, 0);
  allowed = true; await f.searches.flushDeliveries(); assert.equal(f.adapter.sent.length, 1); assert.equal(f.store.getSearchDelivery(pending.delivery[0].id).status, 'confirmed');
});


test('a global stop cancels pending search deliveries permanently, reports in-flight submissions and preserves command dedupe', async t => {
  const f = await fixture(t); await f.adapter.disconnect();
  const result = await f.searches.executeSearch({ query: 'iPhone 15 Pro Max' }, f.owner.id, { deliver: true });
  f.store.saveSearchDelivery({ id: 'submitted-search', runId: 'submitted-run', actorId: f.owner.id, target: `${f.owner.phone}@s.whatsapp.net`, text: 'Já em processamento', status: 'sending', messageId: 'ALREADY-IN-FLIGHT', clientMessageId: 'ALREADY-IN-FLIGHT', createdAt: f.now() });
  const stopped = f.searches.stopPending({ actorId: f.owner.id, reason: 'Parar tudo de teste' });
  assert.deepEqual(stopped, { cancelled: 1, inFlight: 1 });
  assert.equal(f.store.getSearchDelivery(result.delivery[0].id).status, 'cancelled'); assert.equal(f.store.getSearchDelivery('submitted-search').status, 'sending');
  await f.adapter.connect(); await f.searches.waitForIdle(); assert.equal(f.adapter.sent.length, 0);
  await assert.rejects(f.searches.retryDelivery({ id: result.delivery[0].id }, f.owner.id), /Somente falhas/);
  assert.equal(f.store.getSearchRun(result.runId).resultCount, 0);
});

test('a confirmed integration receipt wins over a later provider rejection and cannot become a retry', async t => {
  const f = await fixture(t);
  f.adapter.sendSearchText = async (_target, _text, { clientMessageId }) => {
    f.adapter.emit('receipt', { messageId: clientMessageId, status: 'confirmed', confirmationScope: 'recipient-delivered', deliveredAt: f.now(), simulation: true });
    throw Object.assign(new Error('Falha do retorno após recibo'), { safeToRetry: true, code: 'WA_RECIPIENT_TIMEOUT' });
  };
  const result = await f.searches.executeSearch({ query: 'iPhone 15 Pro Max' }, f.owner.id, { deliver: true });
  assert.equal(result.delivery[0].status, 'confirmed'); assert.equal(result.delivery[0].deliveredAt, f.now()); assert.equal(result.delivery[0].safeToRetry, false);
  assert.equal(f.store.listSearchDeliveries({ status: 'pending' }).total, 0);
});
