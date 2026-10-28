'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const ExcelJS = require('exceljs');
const { createStore, seed } = require('../src/core/store.cjs');
const { AuthService } = require('../src/core/auth.cjs');
const { SimulatedAdapter } = require('../src/adapters/simulated.cjs');
const { SearchService, parseSearchCommand } = require('../src/core/search-service.cjs');
const PASSWORD = 'Senha-de-teste-Excel-231';
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-buscas-231-')), store = await createStore(dir); seed(store);
  let clock = Date.parse('2026-10-06T15:00:00-03:00'), stopped = false; const now = () => clock, auth = new AuthService({ store, clock: now });
  const owner = (await auth.setupOwner({ name: 'Dono de teste', username: 'dono', phone: '5562999990001', password: PASSWORD })).user;
  const adapter = new SimulatedAdapter({ store, delayMs: 0 }); await adapter.connect();
  const searches = new SearchService({ store, adapter, authService: auth, now, sleep: async () => {}, automationGuard: () => !stopped }); searches.start();
  const group = store.listGroups()[0].id; searches.saveSettings({ enabled: true, monitoredGroupIds: [group], commandPrivateNumbers: [owner.phone] }, owner.id);
  t.after(async () => { await searches.shutdown(); await adapter.disconnect(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const insert = (count, extra = {}) => { const offers = []; for (let i = 0; i < count; i++) offers.push({ id: `offer-${i}`, model: 'iPhone 15 Pro Max', modelKey: 'iphone 15 pro max', storageGB: 256, color: 'Azul', colorKey: 'blue', condition: 'seminovo', batteryPercent: 85, priceCents: 300000 + i * 100, priceKind: 'cash', confidence: 'confirmed', status: 'active', supplierKey: `phone:5562${String(i + 500000000).padStart(9, '0')}`, supplierPhone: `5562${String(i + 500000000).padStart(9, '0')}`, supplierName: `Fornecedor ${i}`, groupName: 'Grupo de teste', productKey: 'iphone 15 pro max|256|blue|seminovo', fingerprint: `fingerprint-${i}`, snippet: `iPhone 15 Pro Max 256GB Azul seminovo R$ ${3000 + i}`, ...extra }); store.upsertSearchMessage({ chatId: group, messageId: randomUUID(), text: 'Ofertas reais fornecidas ao teste determinístico', originalAt: now(), capturedAt: now(), senderId: '5562999999876@s.whatsapp.net' }, offers); };
  const command = (text, extra = {}) => { const context = { type: 'text', text, chatId: `${owner.phone}@s.whatsapp.net`, isGroup: false, fromMe: false, senderNumber: owner.phone, senderId: `${owner.phone}@s.whatsapp.net`, verified: true, identityVerified: true, timestamp: now(), forwarded: false, messageId: randomUUID(), simulation: true, traceId: `TRACE-${randomUUID()}`, ...extra }; context.replyProof = `SIM-REPLY-PROOF-${randomUUID()}`; adapter.replyContexts.set(context.replyProof, { chatId: context.chatId, senderId: context.senderId, senderNumber: context.senderNumber, fromMe: context.fromMe }); return context; };
  return { store, owner, adapter, searches, auth, insert, command, group, dir, now, stop: () => { stopped = true; }, advance: ms => { clock += ms; } };
}

test('flag parser remains compatible, case-insensitive and never treats output flags as product filters', () => {
  assert.deepEqual(parseSearchCommand('--EXCEL iPhone 15 Pro Max 256GB'), { query: 'iPhone 15 Pro Max 256GB', format: 'excel' }); assert.deepEqual(parseSearchCommand('--ambos iPhone 15'), { query: 'iPhone 15', format: 'both' }); assert.deepEqual(parseSearchCommand('--excel'), { query: '', format: 'excel' }); assert.equal(parseSearchCommand('iPhone 15 Pro Max').format, 'text');
});

test('all filtered results cross 500 candidates and preserve frozen query filters and order across pages and XLSX', async t => {
  const f = await fixture(t); f.insert(603);
  f.searches.saveSettings({ sort: 'cashDescending' }, f.owner.id); const answer = await f.searches.executeSearch({ query: 'iPhone 15 Pro Max 256GB' }, f.owner.id);
  assert.equal(answer.count, 10); assert.equal(answer.totalCount, 603); assert.equal(answer.results[0].priceCents, 360200);
  f.searches.saveSettings({ sort: 'cashAscending', defaultFilters: { maxPriceCents: 300100 } }, f.owner.id);
  const secondPage = await f.searches.resultPage({ runId: answer.runId, offset: 550, limit: 50 }, f.owner.id); assert.equal(secondPage.total, 603); assert.equal(secondPage.items.length, 50); assert.equal(secondPage.items[0].priceCents, 305200);
  const file = await f.searches.exportSearchExcel({ runId: answer.runId, selection: 'all' }, f.owner.id); assert.equal(file.count, 603);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(file.path); const sheet = workbook.getWorksheet('Ofertas'); assert.equal(sheet.rowCount, 604); assert.equal(sheet.getCell('H2').value, 3602); assert.equal(sheet.getCell('H604').value, 3000);
  const selected = await f.searches.exportSearchExcel({ runId: answer.runId, selection: 'selected', offerIds: [secondPage.items[0].id, answer.results[0].id] }, f.owner.id); assert.equal(selected.count, 2);
  const selectedBook = new ExcelJS.Workbook(); await selectedBook.xlsx.readFile(selected.path); assert.equal(selectedBook.getWorksheet('Ofertas').getCell('H2').value, 3602);
});

test('selected exports reject foreign stale and no-price offers instead of inventing cheap results', async t => {
  const f = await fixture(t); f.insert(3); f.store.updateSearchOffer('offer-2', { priceCents: null, confidence: 'review' });
  const answer = await f.searches.executeSearch({ query: 'iPhone 15 Pro Max 256GB' }, f.owner.id); assert.equal(answer.totalCount, 2);
  await assert.rejects(f.searches.exportSearchExcel({ runId: answer.runId, selection: 'selected', offerIds: ['offer-2'] }, f.owner.id), error => error.code === 'SEARCH_SELECTION_CHANGED');
  f.store.updateSearchOffer('offer-0', { status: 'unavailable' }); await assert.rejects(f.searches.exportSearchExcel({ runId: answer.runId, selection: 'selected', offerIds: ['offer-0'] }, f.owner.id), error => error.code === 'SEARCH_SELECTION_CHANGED');
});

test('private --excel document goes only to authenticated requester, dedupes command and keeps trace chain', async t => {
  const f = await fixture(t); f.insert(3);
  f.store.saveEntity('alert_recipients', { id: 'decoy', name: 'Outro responsável', phone: '5562999997777', enabled: true }); f.searches.saveSettings({ recipientMode: 'responsibles', responsibleRecipientIds: ['decoy'] }, f.owner.id);
  const ctx = f.command('!BuScA --EXCEL iPhone 15 Pro Max 256GB'); assert.equal(await f.searches.handleIncoming(ctx), true); await f.searches.waitForIdle();
  const deliveries = f.store.listSearchDeliveries().items; assert.equal(deliveries.length, 1); assert.equal(deliveries[0].kind, 'document'); assert.equal(deliveries[0].target, `${f.owner.phone}@s.whatsapp.net`); assert.equal(deliveries[0].status, 'confirmed');
  assert.equal(await f.searches.handleIncoming(ctx), false); assert.equal(f.store.listSearchDeliveries().total, 1); assert.equal(f.adapter.sent.length, 1);
  const trace = f.store.listEntities('diagnostics').filter(row => row.traceId === ctx.traceId); for (const stage of ['received', 'authorization', 'parsed', 'results', 'queued', 'submitted', 'integration']) assert.ok(trace.some(row => row.stage === `buscas.${stage}`), stage);
});

test('bare Excel prefix and no-result Excel search send useful private text and no empty document', async t => {
  const f = await fixture(t); f.searches.saveSettings({ prefix: '!achar' }, f.owner.id);
  assert.equal(await f.searches.handleIncoming(f.command('!ACHAR --excel')), true); assert.match(f.adapter.sent[0].text, /!achar --excel iPhone/);
  assert.equal(await f.searches.handleIncoming(f.command('!achar --excel iPhone 15 Pro Max 256GB')), true); assert.match(f.adapter.sent[1].text, /Não foram encontradas ofertas/); assert.equal(f.store.listMedia().filter(m => m.generatedBy === 'search-excel').length, 0);
});

test('manual list preview requires manage and preserves per-recipient document/text statuses without redirection or double clicks', async t => {
  const f = await fixture(t); f.insert(2); f.store.saveEntity('alert_recipients', { id: 'responsible', name: 'Responsável autorizado', phone: '5562999992222', enabled: true });
  const answer = await f.searches.executeSearch({ query: 'iPhone 15 Pro Max 256GB' }, f.owner.id), preview = await f.searches.previewSearchList({ runId: answer.runId, selection: 'all', recipientIds: [`user:${f.owner.id}`, 'responsible'], format: 'both' }, f.owner.id);
  assert.equal(preview.count, 2); assert.equal(preview.recipients.length, 2); assert.equal(f.store.listSearchDeliveries().total, 0);
  const [first, second] = await Promise.all([f.searches.sendSearchList({ previewId: preview.previewId }, f.owner.id), f.searches.sendSearchList({ previewId: preview.previewId }, f.owner.id)]); assert.equal(first.batchId, second.batchId); await f.searches.waitForIdle();
  const statuses = await f.searches.listListDeliveries({ batchId: first.batchId }, f.owner.id); assert.equal(statuses.total, 4); assert.ok(statuses.deliveries.every(d => d.status === 'confirmed')); assert.equal(statuses.deliveries.filter(d => d.kind === 'document').length, 2); assert.equal(f.adapter.sent.length, 4);
  await f.searches.sendSearchList({ previewId: preview.previewId }, f.owner.id); assert.equal(f.store.listSearchDeliveries().total, 4);
});

test('responsible or offer changes after preview require a fresh preview; global stop prevents queue creation', async t => {
  const f = await fixture(t); f.insert(2); const answer = await f.searches.executeSearch({ query: 'iPhone 15 Pro Max 256GB' }, f.owner.id);
  const input = { runId: answer.runId, selection: 'all', recipientIds: [`user:${f.owner.id}`], format: 'text' }, preview = await f.searches.previewSearchList(input, f.owner.id);
  f.store.updateSearchOffer('offer-0', { priceCents: 350000 }); await assert.rejects(f.searches.sendSearchList({ previewId: preview.previewId }, f.owner.id), error => error.code === 'SEARCH_PREVIEW_CHANGED');
  const next = await f.searches.previewSearchList(input, f.owner.id); f.stop(); await assert.rejects(f.searches.sendSearchList({ previewId: next.previewId }, f.owner.id), error => error.code === 'AUTOMATION_STOPPED'); assert.equal(f.store.listSearchDeliveries().total, 0);
});

test('unapproved sender and inconsistent PN identity cannot obtain documents or execute a private search', async t => {
  const f = await fixture(t); f.insert(2);
  assert.equal(await f.searches.handleIncoming(f.command('!busca --excel iPhone 15 Pro Max', { senderNumber: '5562999993333', senderId: '5562999993333@s.whatsapp.net', chatId: '5562999993333@s.whatsapp.net' })), false);
  assert.equal(await f.searches.handleIncoming(f.command('!busca iPhone 15 Pro Max', { senderId: '5562999993333@s.whatsapp.net' })), false); assert.equal(f.store.listSearchDeliveries().total, 0);
});

test('search-only user may search and export own query, cannot broadcast or access another run', async t => {
  const f = await fixture(t); f.insert(2); const admin = await f.auth.createUser({ name: 'Busca limitada', username: 'busca-limitada', phone: '5562999995555', password: PASSWORD, roleId: 'role-seller', requirePasswordChange: false, permissionOverrides: { 'search.run': true, 'search.view': true, 'search.manage': false } });
  f.searches.saveAuthorization({ userId: admin.id, permissions: ['search'], enabled: true }, f.owner.id);
  const ownerRun = await f.searches.executeSearch({ query: 'iPhone 15 Pro Max 256GB' }, f.owner.id), limitedRun = await f.searches.executeSearch({ query: 'iPhone 15 Pro Max 256GB' }, admin.id);
  assert.equal((await f.searches.exportSearchExcel({ runId: limitedRun.runId, selection: 'all' }, admin.id)).count, 2);
  await assert.rejects(f.searches.exportSearchExcel({ runId: ownerRun.runId, selection: 'all' }, admin.id), error => error.code === 'SEARCH_DENIED');
  await assert.rejects(f.searches.previewSearchList({ runId: limitedRun.runId, recipientIds: [`user:${f.owner.id}`] }, admin.id), error => error.code === 'SEARCH_DENIED');
});

test('private command Excel honors the configured ten-result limit while application export includes all pages', async t => {
  const f = await fixture(t); f.insert(27); assert.equal(await f.searches.handleIncoming(f.command('!busca --ambos iPhone 15 Pro Max 256GB')), true); await f.searches.waitForIdle();
  const document = f.store.listSearchDeliveries().items.find(delivery => delivery.kind === 'document'); const book = new ExcelJS.Workbook(); await book.xlsx.readFile(document.document.path); assert.equal(book.getWorksheet('Ofertas').rowCount, 11); assert.match(document.text, /10 ofertas/);
  assert.ok(f.adapter.sent.every(sent => sent.privateNumber === f.owner.phone));
});

test('managed Excel and responsible survive restart and pending private manual list resumes exactly once', async t => {
  const f = await fixture(t); f.insert(2); const answer = await f.searches.executeSearch({ query: 'iPhone 15 Pro Max 256GB' }, f.owner.id);
  await f.adapter.disconnect(); const preview = await f.searches.previewSearchList({ runId: answer.runId, selection: 'all', format: 'excel', recipientIds: [`user:${f.owner.id}`] }, f.owner.id), queued = await f.searches.sendSearchList({ previewId: preview.previewId }, f.owner.id);
  assert.equal(queued.deliveries[0].status, 'pending'); await f.searches.shutdown(); f.store.close();
  const store = await createStore(f.dir), auth = new AuthService({ store }), adapter = new SimulatedAdapter({ store, delayMs: 0 }); await adapter.connect(); const searches = new SearchService({ store, adapter, authService: auth, sleep: async () => {} });
  t.after(async () => { await searches.shutdown(); await adapter.disconnect(); store.close(); }); searches.start(); await searches.waitForIdle();
  const delivery = store.listSearchDeliveries().items[0]; assert.equal(delivery.status, 'confirmed'); assert.equal(adapter.sent.length, 1); assert.equal(adapter.sent[0].document.name, store.getMedia(delivery.mediaId).name);
  await adapter.disconnect(); await adapter.connect(); await searches.waitForIdle(); assert.equal(adapter.sent.length, 1);
});

test('uncertain Excel delivery never becomes a retry after reconnect and after application restart', async t => {
  const f = await fixture(t); f.insert(2); f.adapter.setNextOutcome('uncertain');
  const answer = await f.searches.executeSearch({ query: 'iPhone 15 Pro Max 256GB' }, f.owner.id), preview = await f.searches.previewSearchList({ runId: answer.runId, selection: 'all', format: 'excel', recipientIds: [`user:${f.owner.id}`] }, f.owner.id); await f.searches.sendSearchList({ previewId: preview.previewId }, f.owner.id); await f.searches.waitForIdle();
  const delivery = f.store.listSearchDeliveries().items[0]; assert.equal(delivery.status, 'uncertain'); await assert.rejects(f.searches.retryDelivery({ id: delivery.id }, f.owner.id), error => error.code === 'SEARCH_RETRY_UNSAFE');
  await f.adapter.disconnect(); await f.adapter.connect(); await f.searches.waitForIdle(); assert.equal(f.adapter.sent.length, 1);
  await f.searches.shutdown(); f.store.close(); const store = await createStore(f.dir), auth = new AuthService({ store }), adapter = new SimulatedAdapter({ store, delayMs: 0 }); await adapter.connect(); const searches = new SearchService({ store, adapter, authService: auth, sleep: async () => {} });
  t.after(async () => { await searches.shutdown(); await adapter.disconnect(); store.close(); }); searches.start(); await searches.waitForIdle(); assert.equal(adapter.sent.length, 0); assert.equal(store.listSearchDeliveries().items[0].status, 'uncertain');
});

test('restart reviews every interrupted delivery above 500 without skipping rows or retrying uncertainty', async t => {
  const f = await fixture(t); const run = f.store.saveSearchRun({ id: randomUUID(), actorId: f.owner.id, requestedAt: f.now(), source: 'application', query: 'iPhone 15 Pro Max', status: 'completed', storageMode: 'simulated' });
  f.store.transaction(() => { for (let i = 0; i < 607; i++) f.store.saveSearchDelivery({ id: `interrupted-${i}`, runId: run.id, actorId: f.owner.id, target: `${f.owner.phone}@s.whatsapp.net`, status: 'sending', text: 'Fila interrompida de teste', clientMessageId: `TEST-${i}`, createdAt: f.now(), storageMode: 'simulated' }); });
  await f.searches.shutdown(); const recovered = new SearchService({ store: f.store, adapter: f.adapter, authService: f.auth, now: f.now, sleep: async () => {} }); recovered.start();
  assert.equal(f.store.listSearchDeliveries({ status: 'sending', limit: 0 }).total, 0); assert.equal(f.store.listSearchDeliveries({ status: 'uncertain', limit: 0 }).total, 607); assert.equal(f.adapter.sent.length, 0); await recovered.shutdown();
});

test('recipient disabled during asynchronous document preparation is rejected immediately before submission', async t => {
  const f = await fixture(t); f.insert(2); f.store.saveEntity('alert_recipients', { id: 'responsible', name: 'Responsável autorizado', phone: '5562999992222', enabled: true });
  const answer = await f.searches.executeSearch({ query: 'iPhone 15 Pro Max 256GB' }, f.owner.id), preview = await f.searches.previewSearchList({ runId: answer.runId, selection: 'all', format: 'excel', recipientIds: ['responsible'] }, f.owner.id);
  const send = f.adapter.sendPrivateContent.bind(f.adapter); f.adapter.sendPrivateContent = async (...args) => { f.store.saveEntity('alert_recipients', { ...f.store.getEntity('alert_recipients', 'responsible'), enabled: false }); return send(...args); };
  await f.searches.sendSearchList({ previewId: preview.previewId }, f.owner.id); await f.searches.waitForIdle(); const delivery = f.store.listSearchDeliveries().items[0]; assert.equal(delivery.status, 'failed'); assert.equal(delivery.code, 'SEARCH_TARGET_DISABLED'); assert.equal(f.adapter.sent.length, 0);
});

test('export permission is revalidated synchronously after user deactivation or module disable', async t => {
  const f = await fixture(t); assert.equal(f.searches.assertExportPermission(f.owner.id, 'simulated').storageMode, 'simulated'); assert.throws(() => f.searches.assertExportPermission(f.owner.id, 'whatsapp'), error => error.code === 'SEARCH_MODE_CHANGED');
  f.searches.saveSettings({ enabled: false }, f.owner.id); assert.throws(() => f.searches.assertExportPermission(f.owner.id), error => error.code === 'SEARCH_DISABLED');
  f.store.saveEntity('users', { ...f.store.getEntity('users', f.owner.id), active: false }); assert.throws(() => f.searches.assertExportPermission(f.owner.id), error => error.code === 'SEARCH_DENIED');
});

test('complete preview is available in numbered authorized pages without creating deliveries and rejects changed or expired content', async t => {
  const f = await fixture(t); f.insert(30); const answer = await f.searches.executeSearch({ query: 'iPhone 15 Pro Max 256GB' }, f.owner.id), preview = await f.searches.previewSearchList({ runId: answer.runId, selection: 'all', format: 'both', recipientIds: [`user:${f.owner.id}`] }, f.owner.id);
  assert.equal(preview.truncated, true); assert.ok(preview.textParts > 2);
  const last = await f.searches.previewSearchListPage({ previewId: preview.previewId, part: preview.textParts }, f.owner.id); assert.equal(last.total, preview.textParts); assert.equal(last.part, preview.textParts); assert.match(last.text, /Valores conforme anúncios capturados/); assert.equal(f.store.listSearchDeliveries().total, 0);
  const all = []; for (let part = 1; part <= preview.textParts; part++) all.push((await f.searches.previewSearchListPage({ previewId: preview.previewId, part }, f.owner.id)).text); assert.match(all.join('\n'), /Fornecedor 29/);
  f.store.updateSearchOffer('offer-0', { priceCents: 499900 }); await assert.rejects(f.searches.previewSearchListPage({ previewId: preview.previewId, part: 1 }, f.owner.id), error => error.code === 'SEARCH_PREVIEW_CHANGED');
  const next = await f.searches.previewSearchList({ runId: answer.runId, selection: 'all', format: 'text', recipientIds: [`user:${f.owner.id}`] }, f.owner.id); f.advance(300001); await assert.rejects(f.searches.previewSearchListPage({ previewId: next.previewId, part: 1 }, f.owner.id), error => error.code === 'SEARCH_PREVIEW_EXPIRED');
});
