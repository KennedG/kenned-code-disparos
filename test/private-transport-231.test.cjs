'use strict';

// Actual adapter and SQLite, with a controlled Baileys socket only. These
// protocol regressions do not establish receipt on a real WhatsApp account.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { createHash, randomUUID } = require('node:crypto');
const { createStore } = require('../src/core/store.cjs');
const { WhatsAppAdapter } = require('../src/adapters/whatsapp.cjs');

const OWNER = '5511999990001';
const SHOP = '5562999990002';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kenned-transport-231-'));
  const store = await createStore(dir);
  store.setSetting('integrationMode', 'whatsapp');
  let socket, lookupBehavior;
  let acknowledge = true;
  const submissions = [], incoming = [], diagnostics = [], lookups = [];
  const library = {
    BufferJSON: { replacer: (_key, value) => value, reviver: (_key, value) => value },
    initAuthCreds: () => ({}),
    WAMessageStubType: { CIPHERTEXT: 2 },
    default() {
      socket = { ev: new EventEmitter(), ws: new EventEmitter(), user: { id: `${SHOP}:7@s.whatsapp.net` }, end() {}, logout: async () => {},
        onWhatsApp: async number => { lookups.push(number); return lookupBehavior ? lookupBehavior(number) : [{ exists: true, jid: `${number}@s.whatsapp.net` }]; },
        sendMessage: async (target, content, options) => {
          submissions.push({ target, content, options });
          const current = socket;
          if (acknowledge) queueMicrotask(() => current.ws.emit('CB:ack,class:message', { attrs: { id: options.messageId } }));
          return { key: { id: options.messageId }, status: 1 };
        } };
      return socket;
    }
  };
  const config = { store, credentialsDir: path.join(dir, 'credentials'), runtimePlatform: 'win32', loadLibrary: async () => library,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() }, ackTimeoutMs: 25 };
  const adapter = new WhatsAppAdapter(config);
  adapter.on('incoming', value => incoming.push(value));
  adapter.on('transportDiagnostic', value => diagnostics.push(value));
  await adapter.connect(); socket.ev.emit('connection.update', { connection: 'open' });
  const emit = (message, extra = {}) => socket.ev.emit('messages.upsert', { type: 'notify', messages: [message], ...extra });
  t.after(async () => { await adapter.disconnect(); store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, store, adapter, incoming, diagnostics, submissions, lookups, emit,
    get socket() { return socket; }, makeAdapter: () => new WhatsAppAdapter(config), setLookup(fn) { lookupBehavior = fn; }, setAck(value) { acknowledge = value; } };
}

function message(id, text = '!busca iPhone 15 Pro Max 256GB', overrides = {}) {
  return { key: { id, remoteJid: `${OWNER}@s.whatsapp.net`, fromMe: false, ...overrides.key },
    messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: text }, ...overrides,
    ...(overrides.key ? { key: { id, remoteJid: `${OWNER}@s.whatsapp.net`, fromMe: false, ...overrides.key } } : {}) };
}

async function document(f) {
  const bytes = Buffer.from('PK\u0003\u0004controlled document fixture — actual workbook correctness is tested separately');
  const filename = path.join(f.dir, 'media', 'export.xlsx');
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, bytes);
  return { path: filename, name: 'Ofertas-filtradas.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), bytes };
}

test('RC14 fresh ciphertext then correlated phone recovery emits the manual private command once', async t => {
  const f = await fixture(t), command = message('recovered-command');
  f.emit({ ...command, message: undefined, messageStubType: 2, messageStubParameters: ['Message absent from node'] });
  assert.equal(f.incoming.length, 0);
  assert(f.diagnostics.some(row => row.code === 'WA_DECRYPTION_PENDING'));
  f.emit(command, { requestId: 'protocol-placeholder-recovery' });
  assert.equal(f.incoming.length, 1);
  assert.equal(f.incoming[0].senderNumber, OWNER);
  assert.equal(f.incoming[0].fromMe, false);
  assert.equal(f.incoming[0].accountNumber, SHOP);
  assert.equal(f.incoming[0].recoveredAfterDecryption, true);
  assert(f.incoming[0].replyProof);
  assert.equal((await f.adapter.resolveReplyRecipient(f.incoming[0])).jid, `${OWNER}@s.whatsapp.net`);
  f.emit(command); f.emit(command, { requestId: 'protocol-placeholder-recovery' });
  assert.equal(f.incoming.length, 1);
  assert(!JSON.stringify(f.diagnostics).includes('!busca'));
  assert(!JSON.stringify(f.diagnostics).includes(f.incoming[0].replyProof));
});

test('unsolicited, identity-changed and expired phone recoveries remain history and cannot execute commands', async t => {
  const f = await fixture(t), command = message('recovery-identity');
  f.emit(command, { requestId: 'unsolicited-history' });
  assert.equal(f.incoming.length, 0);
  f.emit({ ...command, message: undefined, messageStubType: 2 });
  f.emit({ ...command, key: { ...command.key, fromMe: true } }, { requestId: 'changed-author' });
  f.emit({ ...command, key: { ...command.key, remoteJid: '5511999990004@s.whatsapp.net' } }, { requestId: 'changed-chat' });
  f.emit({ ...command, messageTimestamp: command.messageTimestamp + 1 }, { requestId: 'changed-time' });
  assert.equal(f.incoming.length, 0);
  for (const row of f.adapter.pendingDecryption.values()) row.expiresAt = Date.now() - 1;
  f.emit(command, { requestId: 'expired-recovery' });
  assert.equal(f.incoming.length, 0);
  assert(f.diagnostics.some(row => row.code === 'WA_RECOVERY_NOT_LIVE'));
});

test('a contentless live event does not consume the ID before a usable notify arrives', async t => {
  const f = await fixture(t), command = message('decoded-after-placeholder');
  f.emit({ ...command, message: undefined, messageStubType: 2 });
  f.emit(command);
  assert.equal(f.incoming.length, 1);
  assert.equal(f.adapter.pendingDecryption.size, 0);
});

test('delayed and historical messages expose a specific reason and do not replay administrative commands', async t => {
  const f = await fixture(t);
  f.emit(message('old-stop', '!mega parar tudo', { messageTimestamp: Math.floor(Date.now() / 1000) - 300 }));
  f.emit(message('history-stop', '!mega parar tudo'), { type: 'append' });
  assert.equal(f.incoming.length, 0);
  assert(f.diagnostics.some(row => row.code === 'WA_MESSAGE_OUTSIDE_LIVE_WINDOW'));
  assert(f.diagnostics.some(row => row.code === 'WA_HISTORY_NOT_COMMAND'));
});

test('private document uses managed verified bytes, original requester route and protocol ACK', async t => {
  const f = await fixture(t), media = await document(f);
  f.emit(message('private-excel-command', '!busca --excel iPhone 15 Pro Max 256GB'));
  f.setLookup(() => { throw new Error('USYNC unavailable; factual inbound route must be used'); });
  const result = await f.adapter.sendPrivateContent(`${OWNER}@s.whatsapp.net`, { type: 'document', caption: '🔎 Ofertas filtradas' }, media,
    { clientMessageId: 'PRIVATE_EXCEL_DOCUMENT', replyContext: f.incoming[0] });
  assert.equal(result.status, 'confirmed');
  assert.equal(f.lookups.length, 0);
  assert.equal(f.submissions.length, 1);
  assert.equal(f.submissions[0].target, `${OWNER}@s.whatsapp.net`);
  assert.deepEqual(f.submissions[0].content.document, media.bytes);
  assert.equal(f.submissions[0].content.mimetype, media.mime);
  assert.equal(f.submissions[0].content.fileName, media.name);
  assert.equal(f.submissions[0].content.caption, '🔎 Ofertas filtradas');
  assert(f.diagnostics.some(row => row.code === 'WA_SERVER_ACCEPTED'));
  assert(!f.diagnostics.some(row => row.stage === 'transport.delivered'));
  f.socket.ev.emit('message-receipt.update', [{ key: { id: result.messageId, fromMe: true }, receipt: { receiptTimestamp: Math.floor(Date.now() / 1000) } }]);
  assert(f.diagnostics.some(row => row.code === 'WA_MESSAGE_DELIVERED'));
});

test('documents cannot be redirected from the requester to a responsible, group or forged context', async t => {
  const f = await fixture(t), media = await document(f);
  f.emit(message('recipient-proof'));
  for (const target of ['5511999990004', '120011111@g.us']) await assert.rejects(f.adapter.sendSearchDocument(target, media, { replyContext: f.incoming[0] }), { code: 'WA_REPLY_RECIPIENT_MISMATCH' });
  await assert.rejects(f.adapter.sendSearchDocument(OWNER, media, { replyContext: { ...f.incoming[0], senderNumber: '5511999990004' } }), { code: 'WA_REPLY_CONTEXT_INVALID' });
  await assert.rejects(f.adapter.sendSearchDocument('1234567890@lid', media), { code: 'WA_RECIPIENT_INVALID' });
  assert.equal(f.submissions.length, 0);
});

test('private document rejects external files and altered content before any submission', async t => {
  const f = await fixture(t), media = await document(f);
  await assert.rejects(f.adapter.sendSearchDocument(OWNER, { ...media, sha256: 'altered' }), /alterada/);
  const outside = path.join(f.dir, 'outside.xlsx'); await fs.writeFile(outside, media.bytes);
  await assert.rejects(f.adapter.sendSearchDocument(OWNER, { ...media, path: outside }), /fora da pasta/);
  assert.equal(f.submissions.length, 0);
});

test('an uncertain private document is not resubmitted and never masquerades as delivered', async t => {
  const f = await fixture(t), media = await document(f); f.setAck(false);
  const first = await f.adapter.sendSearchDocument(OWNER, media, { clientMessageId: 'UNCERTAIN_EXCEL' });
  assert.equal(first.status, 'uncertain');
  assert.deepEqual(await f.adapter.sendSearchDocument(OWNER, media, { clientMessageId: 'UNCERTAIN_EXCEL' }), first);
  assert.equal(f.submissions.length, 1);
  assert(f.diagnostics.some(row => row.code === 'WA_ACK_TIMEOUT'));
  assert(!f.diagnostics.some(row => row.code === 'WA_SERVER_ACCEPTED'));
});

test('final private guard runs after asynchronous recipient lookup and rejects without reserving the ID', async t => {
  const f = await fixture(t);
  let enabled = true;
  f.setLookup(async number => { enabled = false; return [{ exists: true, jid: `${number}@s.whatsapp.net` }]; });
  const guard = () => { if (!enabled) throw Object.assign(new Error('Destinatário desativado.'), { code: 'ALERT_RECIPIENT_DISABLED' }); };
  await assert.rejects(f.adapter.sendPrivate(OWNER, 'Alerta', { clientMessageId: 'GUARDED_ALERT', beforeSubmit: guard }), error =>
    error.code === 'ALERT_RECIPIENT_DISABLED' && error.submitted === false && error.definitive === true && error.safeToRetry === false);
  assert.equal(f.submissions.length, 0);
  assert.equal(f.store.isOutboundMessageId('GUARDED_ALERT'), false);
  enabled = true;
  assert.equal((await f.adapter.sendPrivate(OWNER, 'Alerta', { clientMessageId: 'GUARDED_ALERT', beforeSubmit: guard })).status, 'confirmed');
  assert.equal(f.submissions.length, 1);
});

test('final document guard runs after asynchronous media processing and enforces STOP before reservation', async t => {
  const f = await fixture(t), media = await document(f);
  const original = f.adapter._managedContent.bind(f.adapter);
  let paused = false;
  f.adapter._managedContent = async (...args) => { const result = await original(...args); paused = true; return result; };
  await assert.rejects(f.adapter.sendSearchDocument(OWNER, media, { clientMessageId: 'STOPPED_DOCUMENT', beforeSubmit: () => {
    if (paused) throw Object.assign(new Error('Envios interrompidos.'), { code: 'AUTOMATION_STOPPED' });
  } }), error => error.code === 'AUTOMATION_STOPPED' && error.submitted === false);
  assert.equal(f.submissions.length, 0);
  assert.equal(f.store.isOutboundMessageId('STOPPED_DOCUMENT'), false);
});

test('connection changed while a private route is being resolved cannot send through the new account', async t => {
  const f = await fixture(t);
  f.emit(message('original-private-context'));
  const resolveOriginal = f.adapter.resolveReplyRecipient.bind(f.adapter);
  f.adapter.resolveReplyRecipient = async context => {
    const result = await resolveOriginal(context);
    f.adapter.generation += 1;
    f.adapter.socket = { ...f.socket, user: { id: '5511999990009@s.whatsapp.net' } };
    return result;
  };
  await assert.rejects(f.adapter.sendSearchText(OWNER, 'Resultado', { replyContext: f.incoming[0] }), { code: 'WA_RECIPIENT_CONNECTION_CHANGED' });
  assert.equal(f.submissions.length, 0);
});

test('protocol rejection retains a useful sanitized code instead of a generic send error', async t => {
  const f = await fixture(t); f.setAck(false);
  const pending = f.adapter.sendPrivate(OWNER, 'Alerta', { clientMessageId: 'PROTOCOL_REJECTION' });
  await new Promise(resolve => setImmediate(resolve));
  f.socket.ws.emit('CB:ack,class:message', { attrs: { id: 'PROTOCOL_REJECTION', error: '463', token: 'DO-NOT-LOG' } });
  assert.equal((await pending).status, 'uncertain');
  assert.equal(f.adapter.status.state, 'restricted');
  assert(f.diagnostics.some(row => row.code === 'WA_PROTOCOL_REJECTED_463' && row.description.includes('privacidade')));
  assert(!JSON.stringify(f.diagnostics).includes('DO-NOT-LOG'));
});

test('normal group offers and private chatter do not flood diagnostics, configurable command prefixes do', async t => {
  const f = await fixture(t);
  f.adapter.configureSearchCapture({ enabled: true, commandPrefix: '!oferta' });
  f.emit(message('normal-group-offer', 'iPhone 15 128GB R$ 3.000', { key: { remoteJid: '120011111@g.us', participant: `${OWNER}@s.whatsapp.net` } }));
  f.emit(message('normal-private-message', 'Olá, gostaria de conhecer a loja.'));
  assert.equal(f.diagnostics.length, 0);
  f.emit(message('configured-prefix', '!OFERTA\tiPhone 15 Pro Max 256GB'));
  const received = f.diagnostics.find(row => row.messageId === 'configured-prefix' && row.stage === 'transport.received');
  const identified = f.diagnostics.find(row => row.messageId === 'configured-prefix' && row.stage === 'transport.identity');
  const context = f.incoming.find(row => row.messageId === 'configured-prefix');
  assert(received && identified);
  assert.match(received.traceId, /^wa-receive-[a-f0-9]{24}$/);
  assert.equal(context.traceId, received.traceId);
  assert.equal(identified.traceId, received.traceId);
  assert.equal(received.detail.commandCandidate, true);
});

test('a stop triggered while recording the prepared trace is checked before durable submission', async t => {
  const f = await fixture(t);
  let paused = false;
  f.adapter.on('transportDiagnostic', row => { if (row.code === 'WA_SUBMISSION_PREPARED') paused = true; });
  await assert.rejects(f.adapter.sendPrivate(OWNER, 'Teste controlado', { clientMessageId: 'TRACE_STOP_GUARD', beforeSubmit: () => {
    if (paused) throw Object.assign(new Error('Sistema interrompido.'), { code: 'AUTOMATION_STOPPED' });
  } }), error => error.code === 'AUTOMATION_STOPPED' && error.submitted === false);
  assert.equal(f.submissions.length, 0);
  assert.equal(f.store.isOutboundMessageId('TRACE_STOP_GUARD'), false);
});

test('received private command, reply ACK and delivery share one authenticated operation trace', async t => {
  const f = await fixture(t);
  f.emit(message('private-command-trace', '!mega status'));
  const context = f.incoming[0], forgedTrace = randomUUID();
  const result = await f.adapter.reply(context.chatId, 'Status de teste', { replyContext: { ...context, traceId: forgedTrace }, clientMessageId: 'TRACED_ADMIN_REPLY', traceId: forgedTrace });
  assert.equal(result.status, 'confirmed');
  f.socket.ev.emit('message-receipt.update', [{ key: { id: result.messageId, fromMe: true }, receipt: { receiptTimestamp: Math.floor(Date.now() / 1000) } }]);
  const related = f.diagnostics.filter(row => ['private-command-trace', 'TRACED_ADMIN_REPLY'].includes(row.messageId));
  assert(related.some(row => row.stage === 'transport.received'));
  assert(related.some(row => row.stage === 'transport.accepted'));
  assert(related.some(row => row.stage === 'transport.delivered'));
  assert(related.every(row => row.traceId === context.traceId));
  assert(!related.some(row => row.traceId === forgedTrace));
});

test('document timeout, late acceptance and protocol rejection retain the parent command trace', async t => {
  const f = await fixture(t), media = await document(f); f.setAck(false);
  f.emit(message('excel-command-trace', '!busca --excel iPhone 15 Pro Max 256GB'));
  const context = f.incoming[0];
  const result = await f.adapter.sendSearchDocument(context.chatId, media, { replyContext: context, clientMessageId: 'TRACED_EXCEL_REPLY', traceId: context.traceId });
  assert.equal(result.status, 'uncertain');
  f.socket.ws.emit('CB:ack,class:message', { attrs: { id: result.messageId } });
  assert(f.diagnostics.filter(row => row.messageId === result.messageId).every(row => row.traceId === context.traceId));
  assert(f.diagnostics.some(row => row.messageId === result.messageId && row.code === 'WA_ACK_TIMEOUT'));
  assert(f.diagnostics.some(row => row.messageId === result.messageId && row.code === 'WA_SERVER_ACCEPTED'));
  const second = f.adapter.sendSearchText(context.chatId, 'Resposta de teste', { replyContext: context, clientMessageId: 'TRACED_REJECTED_REPLY', traceId: context.traceId });
  await new Promise(resolve => setImmediate(resolve));
  f.socket.ws.emit('CB:ack,class:message', { attrs: { id: 'TRACED_REJECTED_REPLY', error: '403' } });
  assert.equal((await second).status, 'uncertain');
  const rejection = f.diagnostics.find(row => row.code === 'WA_PROTOCOL_REJECTED_403');
  assert.equal(rejection.traceId, context.traceId);
});

test('private alert recipient resolution failures are correlated without storing credentials', async t => {
  const f = await fixture(t), traceId = randomUUID();
  f.setLookup(() => { throw Object.assign(new Error('password=NEVER_PRINT_PROVIDER_MESSAGE'), { statusCode: 404 }); });
  await assert.rejects(f.adapter.sendPrivate(OWNER, 'Alerta controlado', { clientMessageId: 'ALERT_TRACE_RESOLUTION', traceId }), { code: 'WA_RECIPIENT_LOOKUP_REJECTED' });
  const row = f.diagnostics.find(value => value.code === 'WA_RECIPIENT_LOOKUP_REJECTED');
  assert.equal(row.traceId, traceId);
  assert.equal(row.detail.submitted, false);
  assert.equal(f.submissions.length, 0);
  assert(!JSON.stringify(f.diagnostics).includes('NEVER_PRINT_PROVIDER_MESSAGE'));
});

test('after adapter restart late ACK recovers the original search trace from its persistent delivery ledger', async t => {
  const f = await fixture(t), traceId = randomUUID(), messageId = 'RESTART_TRACE_SEARCH';
  f.setAck(false);
  f.store.saveSearchDelivery({ id: randomUUID(), runId: randomUUID(), traceId, messageId, status: 'uncertain', createdAt: Date.now(), target: `${OWNER}@s.whatsapp.net` });
  assert.equal((await f.adapter.sendPrivate(OWNER, 'Pesquisa de teste', { clientMessageId: messageId, traceId })).status, 'uncertain');
  await f.adapter.disconnect();
  const restarted = f.makeAdapter(), diagnostics = [];
  restarted.on('transportDiagnostic', row => diagnostics.push(row));
  await restarted.connect(); f.socket.ev.emit('connection.update', { connection: 'open' });
  f.socket.ws.emit('CB:ack,class:message', { attrs: { id: messageId } });
  const accepted = diagnostics.find(row => row.code === 'WA_SERVER_ACCEPTED');
  assert.equal(accepted?.traceId, traceId);
  assert.equal(f.submissions.length, 1);
  await restarted.disconnect();
});

test('after restart administrative reply receipts recover their parent trace from recentCommandIds', async t => {
  const f = await fixture(t), traceId = randomUUID(), messageId = 'RESTART_TRACE_ADMIN';
  f.store.setSetting('recentCommandIds', [{ id: 'test-command', traceId, at: Date.now(), replies: [{ messageId, status: 'uncertain' }] }]);
  f.store.registerOutboundMessageId(messageId, { kind: 'control-reply' });
  await f.adapter.disconnect();
  const restarted = f.makeAdapter(), diagnostics = [];
  restarted.on('transportDiagnostic', row => diagnostics.push(row));
  await restarted.connect(); f.socket.ev.emit('connection.update', { connection: 'open' });
  f.socket.ws.emit('CB:ack,class:message', { attrs: { id: messageId } });
  assert.equal(diagnostics.find(row => row.code === 'WA_SERVER_ACCEPTED')?.traceId, traceId);
  assert.equal(f.submissions.length, 0);
  await restarted.disconnect();
});
