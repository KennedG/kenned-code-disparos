'use strict';

// Production backend dispatcher, SQLite, Auth, Commands, Search, Alerts and
// WhatsAppAdapter. Only the socket and OS encryption facade are controlled.
// These checks never establish receipt on a real WhatsApp account or device.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const ExcelJS = require('exceljs');
const { createStore } = require('../src/core/store.cjs');
const { WhatsAppAdapter } = require('../src/adapters/whatsapp.cjs');
const { createAppService } = require('../src/backend/service.cjs');

const PERSONAL = '5562999990001';
const SHOP = '5562999990002';
const GROUP = '1200999999999@g.us';
const LID = '9876543212345@lid';
const PASSWORD = 'Senha-Controlada-Pipeline-231!';
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
async function until(read, predicate, message) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(message);
}
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kenned-private-backend-231-'));
  const seed = await createStore(dir);
  seed.setSetting('integrationMode', 'whatsapp');
  seed.setSetting('initialized', true);
  seed.upsertGroups([{ id: GROUP, name: 'Grupo de teste autorizado', authorized: true, simulation: false }]);
  seed.close();
  const originalConnect = WhatsAppAdapter.prototype.connect;
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() };
  let service, socket, offset = 0, lookupDisabled = false, failure = null;
  const adapters = [], submissions = [], local = [], lookups = [];
  const library = {
    BufferJSON: { replacer: (_key, value) => value, reviver: (_key, value) => value },
    initAuthCreds: () => ({}), WAMessageStubType: { CIPHERTEXT: 2 },
    default() {
      socket = { ev: new EventEmitter(), ws: new EventEmitter(), user: { id: `${SHOP}:2@s.whatsapp.net` }, end() {}, logout: async () => {},
        groupFetchAllParticipating: async () => ({ [GROUP]: { id: GROUP, subject: 'Grupo de teste autorizado' } }),
        signalRepository: { lidMapping: { getPNForLID: async lid => lid === LID ? `${PERSONAL}@s.whatsapp.net` : null } },
        onWhatsApp: async number => { lookups.push(number); if (lookupDisabled) throw new Error('Controlled USYNC unavailable'); return [{ exists: true, jid: `${number}@s.whatsapp.net` }]; },
        sendMessage: async (target, content, options) => {
          submissions.push({ target, content, options });
          offset += 4000; // Advance service scheduling clock instead of sleeping.
          if (failure) throw failure;
          const current = socket;
          queueMicrotask(() => current.ws.emit('CB:ack,class:message', { attrs: { id: options.messageId } }));
          return { key: { id: options.messageId }, status: 1 };
        } };
      return socket;
    }
  };
  // Inject the controlled boundary into adapters created by the production
  // backend, without adding a test switch to application implementation.
  WhatsAppAdapter.prototype.connect = function (options) {
    if (!adapters.includes(this)) adapters.push(this);
    this.runtimePlatform = 'win32';
    this.loadLibrary = async () => library;
    this.ackTimeoutMs = 25;
    return originalConnect.call(this, options);
  };
  const host = async (action, payload) => {
    if (action === 'secretGet') return null;
    if (action === 'localAlert') { local.push(payload); return { nativeStatus: 'unsupported', soundStatus: 'disabled' }; }
    if (action === 'setLoginItemSettings') return true;
    return { canceled: true };
  };
  const open = async () => {
    service = await createAppService({ dir, safeStorage, host, runtimePlatform: 'win32', now: () => Date.now() + offset });
    return service;
  };
  const close = async () => { if (service) { await service.shutdown(); service = null; } };
  const connect = async () => { await service.call('connect'); socket.ev.emit('connection.update', { connection: 'open' }); await nextTurn(); };
  const emit = (text, { id = randomUUID(), lid = false, group = false, phone = PERSONAL, fromMe = false } = {}) => {
    const current = socket;
    current.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id, fromMe, remoteJid: group ? GROUP : lid ? LID : `${phone}@s.whatsapp.net`, ...(group ? { participant: `${phone}:3@s.whatsapp.net` } : {}) }, message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000), pushName: 'Nome não autoriza' }] });
    return id;
  };
  const history = () => service.call('searchHistory', { limit: 100 });
  const diagnostics = () => service.call('diagnosticsPage', { limit: 200 });
  const searchFinished = id => until(history, value => value.items.some(run => run.messageId === id && ['confirmed', 'uncertain', 'failed'].includes(run.deliveryStatus)), `Command ${id} never reached a terminal delivery state`);
  t.after(async () => { await close(); WhatsAppAdapter.prototype.connect = originalConnect; await fs.rm(dir, { recursive: true, force: true }); });
  await open();
  const owner = (await service.call('setupOwner', { name: 'Dono de teste', username: 'dono-integrado', phone: PERSONAL, password: PASSWORD })).user;
  await service.call('saveSearchSettings', { settings: { enabled: true, monitoredGroupIds: [GROUP], commandGroupIds: [], privateCommandsEnabled: true, commandPrivateNumbers: [], userRateLimit: { max: 100, windowSeconds: 60 } } });
  await connect();
  return { dir, owner, submissions, local, lookups, emit, connect, close, open, history, diagnostics, searchFinished,
    get service() { return service; }, get socket() { return socket; }, get adapter() { return adapters.at(-1); },
    disableLookup(value = true) { lookupDisabled = value; }, failSending(error) { failure = error; } };
}

async function capture(f) {
  f.emit('iPhone 15 Pro Max 256GB Azul seminovo R$ 3.850,00', { group: true, phone: '5562999991111' });
  await until(() => f.service.call('searchOffers', { limit: 20 }), value => value.total === 1, 'Real captured offer never reached the indexed search base');
}

async function adminReply(f, command, options) {
  const previous = f.submissions.length;
  const id = f.emit(command, options);
  await until(async () => f.submissions.length, count => count > previous, `${command} did not submit a private response`);
  await nextTurn();
  return { id, reply: f.submissions.at(-1) };
}

test('production backend private LID Excel and administrative replies keep requester, permissions and an end-to-end trace', async t => {
  const f = await fixture(t);
  await capture(f);
  const decoy = await f.service.call('saveAlertRecipient', { name: 'Outro responsável de teste', phone: '5562999997777' });
  await f.service.call('saveSearchSettings', { settings: { recipientMode: 'responsibles', responsibleRecipientIds: [decoy.id] } });
  f.disableLookup();
  const id = f.emit('!busca --excel iPhone 15 Pro Max 256GB', { lid: true });
  const history = await f.searchFinished(id), run = history.items.find(value => value.messageId === id);
  const document = f.submissions.find(value => value.content.document);
  assert.equal(document.target, LID);
  assert.notEqual(document.target, `${decoy.phone}@s.whatsapp.net`);
  assert.equal(f.lookups.length, 0);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(document.content.document);
  assert.equal(workbook.getWorksheet('Ofertas').rowCount, 2);
  assert.equal(workbook.getWorksheet('Ofertas').getCell('H2').value, 3850);
  const trace = await f.service.call('tracePage', { traceId: run.traceId });
  for (const stage of ['transport.received', 'transport.identity', 'buscas.received', 'buscas.authorization', 'buscas.results', 'buscas.queued', 'buscas.integration']) assert.ok(trace.items.some(value => value.stage === stage), stage);
  assert.ok(trace.items.some(value => value.code === 'WA_SERVER_ACCEPTED'), 'Adapter ACK must use the original command trace');
  const { reply } = await adminReply(f, '!mega ajuda', { lid: true });
  assert.equal(reply.target, LID);
  assert.match(reply.content.text, /Kenned Code|comandos/i);
  const records = await f.diagnostics();
  const commandTrace = records.items.find(value => value.code === 'ADMIN_REPLY_ACCEPTED').traceId;
  const adminTrace = await f.service.call('tracePage', { traceId: commandTrace });
  assert.ok(adminTrace.items.some(value => value.code === 'WA_SERVER_ACCEPTED'), 'Administrative ACK must use the same input trace');
  assert.equal(f.submissions.filter(value => value.content.document).length, 1);
});

test('pending private Excel survives a full backend/account restart with protected route proof and sends once to original LID', async t => {
  const f = await fixture(t);
  await capture(f);
  const received = new Promise(resolve => f.adapter.once('incoming', resolve));
  const id = f.emit('!busca --excel iPhone 15 Pro Max 256GB', { lid: true });
  await received;
  // The live command was observed while connected; disconnect before its
  // asynchronous workbook processing places the reply in the delivery queue.
  f.socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
  const pending = await until(f.history, value => value.items.some(run => run.messageId === id && run.deliveryStatus === 'pending'), 'Disconnected command was not retained as pending');
  assert.equal(f.submissions.filter(value => value.content.document).length, 0);
  const original = pending.items.find(run => run.messageId === id);
  await f.close();
  await f.open();
  await f.service.call('login', { username: 'dono-integrado', password: PASSWORD });
  f.disableLookup();
  await f.connect();
  const done = await f.searchFinished(id);
  assert.equal(done.items.find(run => run.messageId === id).deliveryStatus, 'confirmed');
  const docs = f.submissions.filter(value => value.content.document);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].target, LID);
  assert.equal(f.lookups.length, 0);
  const trace = await f.service.call('tracePage', { traceId: original.traceId });
  assert.ok(trace.items.some(value => value.code === 'WA_SERVER_ACCEPTED'));
  await f.connect();
  await nextTurn();
  assert.equal(f.submissions.filter(value => value.content.document).length, 1);
  assert.equal((await f.history()).items.filter(run => run.messageId === id).length, 1);
});

test('provider rejection remains visible in the original private command trace and cannot appear as success', async t => {
  const f = await fixture(t);
  f.failSending(Object.assign(new Error('Controlled provider restriction'), { statusCode: 403 }));
  const id = f.emit('!busca iPhone 15 Pro Max 256GB');
  const done = await f.searchFinished(id), run = done.items.find(value => value.messageId === id);
  assert.equal(run.deliveryStatus, 'uncertain');
  const trace = await f.service.call('tracePage', { traceId: run.traceId });
  assert.ok(trace.items.some(value => value.code === 'WA_SUBMISSION_ERROR_403'), 'Specific provider error must be linked to the original command');
  assert.equal(trace.items.some(value => value.code === 'WA_SERVER_ACCEPTED'), false);
  assert.equal(f.service.snapshot().connection.state, 'restricted');
  const count = f.submissions.length;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(f.submissions.length, count, 'An uncertain rejected submission cannot loop or resend');
});

test('private admin channel survives global STOP and UI logout; automatic alert and list creation stay blocked', async t => {
  const f = await fixture(t);
  const { reply } = await adminReply(f, '!mega parar tudo');
  assert.equal(reply.target, `${PERSONAL}@s.whatsapp.net`);
  assert.match(reply.content.text, /Novas entradas nas filas estão bloqueadas/);
  assert.equal((await f.service.call('automationStatus')).stopped, true);
  await assert.rejects(f.service.call('testAlert'), { code: 'AUTOMATION_STOPPED' });
  await f.service.call('logout');
  for (const command of ['!mega ajuda', '!mega menu', '!mega status']) {
    const result = await adminReply(f, command);
    assert.equal(result.reply.target, `${PERSONAL}@s.whatsapp.net`);
  }
  assert.match(f.submissions.at(-1).content.text, /INTERROMPIDA/);
  await f.service.call('login', { username: 'dono-integrado', password: PASSWORD });
  await f.close();
  await f.open();
  await f.service.call('login', { username: 'dono-integrado', password: PASSWORD });
  assert.equal((await f.service.call('automationStatus')).stopped, true);
  await f.connect();
  const resume = await adminReply(f, '!mega retomar sistema');
  assert.equal(resume.reply.target, `${PERSONAL}@s.whatsapp.net`);
  assert.equal((await f.service.call('automationStatus')).stopped, false);
});

test('production alert uses the verified private route, shares occurrence trace and distinguishes acceptance from delivery', async t => {
  const f = await fixture(t);
  await adminReply(f, '!mega ajuda', { lid: true });
  f.disableLookup();
  const result = await f.service.call('testAlert');
  assert.equal(result.alerts.length, 1);
  const alert = result.alerts[0];
  assert.equal(alert.number, PERSONAL);
  assert.equal(alert.status, 'confirmed');
  assert.equal(alert.confirmationScope, 'whatsapp-server');
  assert.equal(alert.deliveredAt, undefined);
  assert.equal(f.submissions.at(-1).target, LID);
  assert.equal(f.lookups.length, 0);
  const trace = await f.service.call('tracePage', { traceId: result.traceId });
  assert.ok(trace.items.some(row => row.code === 'ALERT_QUEUED'));
  assert.ok(trace.items.some(row => row.code === 'ALERT_CONFIRMED'));
  assert.ok(trace.items.some(row => row.code === 'WA_SERVER_ACCEPTED'));
  f.socket.ev.emit('message-receipt.update', [{ key: { id: alert.messageId, fromMe: true }, receipt: { receiptTimestamp: Math.floor(Date.now() / 1000) } }]);
  const delivered = await f.service.call('alertsPage');
  assert.equal(delivered.items.find(row => row.id === alert.id).status, 'delivered');
  assert.equal(delivered.items.find(row => row.id === alert.id).confirmationScope, 'whatsapp-delivered');
  const count = f.submissions.length;
  await nextTurn();
  assert.equal(f.submissions.length, count);
});

test('existing formatted owner phone works consistently for private authorization, configured alerts and manual Excel lists', async t => {
  const f = await fixture(t);
  // Represent preserved legacy data rather than the current validated UI save.
  const legacy = await createStore(f.dir);
  legacy.saveEntity('users', { ...legacy.getEntity('users', f.owner.id), phone: '+55 (62) 99999-0001' });
  legacy.close();
  const { reply } = await adminReply(f, '!mega ajuda');
  assert.equal(reply.target, `${PERSONAL}@s.whatsapp.net`);
  const result = await f.service.call('testAlert');
  assert.equal(result.alerts.length, 1, 'An authorized owner with a valid formatted legacy phone must not disappear from the alert flow');
  assert.equal(result.alerts[0].number, PERSONAL);
  assert.equal(result.alerts[0].status, 'confirmed');
  await capture(f);
  const search = await f.service.call('runSearch', { query: 'iPhone 15 Pro Max 256GB' });
  const preview = await f.service.call('searchListPreview', { runId: search.runId, selection: 'all', format: 'both', recipientIds: [`user:${f.owner.id}`] });
  assert.equal(preview.recipients[0].phone, PERSONAL);
  const sent = await f.service.call('searchSendList', { previewId: preview.previewId });
  const done = await until(() => f.service.call('searchListDeliveryStatus', { batchId: sent.batchId, runId: search.runId }), value => value.deliveries.length === 2 && value.deliveries.every(delivery => delivery.status === 'confirmed'), 'Formatted legacy owner did not receive both manual-list parts');
  assert.ok(done.deliveries.every(delivery => delivery.target === `${PERSONAL}@s.whatsapp.net`));
  const document = f.submissions.find(submission => submission.content.document);
  assert.equal(document.target, `${PERSONAL}@s.whatsapp.net`);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(document.content.document);
  assert.equal(workbook.getWorksheet('Ofertas').getCell('H2').value, 3850);
});

test('revoking a requester phone during private route resolution blocks both results and the generic failure notice', async t => {
  const f = await fixture(t);
  const resolveOriginal = f.adapter.resolveSearchRecipient.bind(f.adapter);
  let release, entered, first = true;
  const ready = new Promise(resolve => { entered = resolve; });
  f.adapter.resolveSearchRecipient = async (...args) => {
    if (first) { first = false; entered(); await new Promise(resolve => { release = resolve; }); }
    return resolveOriginal(...args);
  };
  const id = f.emit('!busca iPhone 15 Pro Max 256GB');
  await ready;
  await f.service.call('updateUser', { id: f.owner.id, phone: SHOP });
  release();
  await f.searchFinished(id);
  await until(f.diagnostics, value => value.items.some(row => row.stage === 'buscas.integration' && row.detail?.status === 'failed'), 'Changed identity never reached the rejection stage');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(f.submissions.length, 0, 'Even a generic error notice must not be sent to a number whose authorization was removed');
});

test('deactivated user linked to a responsible is excluded consistently from alert and manual-list destinations', async t => {
  const f = await fixture(t);
  await capture(f);
  const user = await f.service.call('createUser', { user: { name: 'Responsável de teste', username: 'responsavel-desativado', phone: '5562999993333', password: PASSWORD, roleId: 'role-manager', requirePasswordChange: false } });
  const recipient = await f.service.call('saveAlertRecipient', { name: 'Responsável vinculado', phone: user.phone, userId: user.id });
  const result = await f.service.call('runSearch', { query: 'iPhone 15 Pro Max 256GB' });
  await f.service.call('updateUser', { id: user.id, active: false });
  await assert.rejects(f.service.call('searchListPreview', { runId: result.runId, selection: 'all', format: 'excel', recipientIds: [recipient.id] }), error => ['SEARCH_RECIPIENT_MISSING', 'SEARCH_RECIPIENT_INVALID'].includes(error.code));
  assert.equal(f.submissions.length, 0);
});
