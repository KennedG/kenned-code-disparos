'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const { WhatsAppAdapter, EncryptedAuthStore, phoneFromJid, normalizeJid } = require('../src/adapters/whatsapp.cjs');
const { SimulatedAdapter } = require('../src/adapters/simulated.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Controlled encrypted test double. This is not a DPAPI/Windows validation.
function secureStorage() {
  const key = randomBytes(32);
  return { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test-encrypted',
    encryptString: async text => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]); },
    decryptString: async encrypted => { const cipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12)); cipher.setAuthTag(encrypted.subarray(12, 28)); return Buffer.concat([cipher.update(encrypted.subarray(28)), cipher.final()]).toString('utf8'); }
  };
}
function mockStore(contact = {}) { const settings = new Map(); const contacts = new Map(); if (contact.id) contacts.set(contact.id, contact); return { contacts, get: (kind, id) => contacts.get(id), getSetting: (key, fallback) => settings.has(key) ? settings.get(key) : fallback, setSetting: (key, value) => settings.set(key, structuredClone(value)) }; }
function testLibrary(sockets, participantList = []) {
  return { BufferJSON: { replacer: (k, v) => v, reviver: (k, v) => v?.type === 'Buffer' ? Buffer.from(v.data) : v }, initAuthCreds: () => ({ registrationId: 123, privateSecret: 'TEST_SECRET_NEVER_PLAINTEXT' }), proto: { Message: { AppStateSyncKeyData: { fromObject: value => value } } }, DisconnectReason: { loggedOut: 401 },
    default: options => {
      const socket = { ev: new EventEmitter(), ws: Object.assign(new EventEmitter(), { isOpen: true }), user: { id: '5562999999999:3@s.whatsapp.net', lid: '90000@lid' }, options, sends: [], end() {},
        signalRepository: { lidMapping: { getPNForLID: async lid => lid === '10001@lid' ? '5562988881111@s.whatsapp.net' : null } },
        groupFetchAllParticipating: async () => ({ '123-456@g.us': { id: '123-456@g.us', subject: 'Grupo real controlado', participants: participantList } }),
        groupMetadata: async id => ({ id, participants: participantList }),
        sendMessage: async (jid, message, opts) => { socket.sends.push({ jid, message, opts }); return { key: { id: opts.messageId, remoteJid: jid }, message }; }
      }; sockets.push(socket); return socket;
    }
  };
}
const contact = () => ({ id: 'contact-1', externalId: '5562988881111@s.whatsapp.net', identifiers: ['5562988881111@s.whatsapp.net'], phone: '5562988881111', authorized: true, blocked: false, optOut: false, muted: false, self: false, ambiguous: false });
async function harness(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'community-adapter-')); const sockets = []; const person = contact(); const store = options.store || mockStore(person); const security = options.safeStorage || secureStorage(); const library = testLibrary(sockets, options.participants);
  const adapter = new WhatsAppAdapter({ credentialsDir: dir, store, safeStorage: security, loadLibrary: async () => library, ackTimeoutMs: 15, reconnectDelays: [10, 20], ...options });
  t.after(async () => { await adapter.shutdown(); await fs.rm(dir, { recursive: true, force: true }); });
  await adapter.connect(); sockets[0]?.ev.emit('connection.update', { connection: 'open' });
  return { adapter, store, person, dir, sockets, library, security, socket: sockets[0] };
}

test('JID device suffix normalized; LID never converted to fictitious telephone', () => { assert.equal(phoneFromJid('10001@lid'), null); assert.equal(phoneFromJid('5562988881111:12@s.whatsapp.net'), '5562988881111'); assert.equal(normalizeJid('x@g.us'), null); });

test('connect is single-flight, authenticated open is required and groups remain truthful', async t => {
  const { adapter, socket, sockets } = await harness(t);
  await Promise.all([adapter.connect(), adapter.connect()]); assert.equal(sockets.length, 1); assert.equal(adapter.status.ready, true);
  assert.deepEqual((await adapter.listGroups()).map(g => g.id), ['123-456@g.us']);
  socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 403 } } } });
  assert.equal(adapter.status.ready, false); assert.equal(adapter.status.reasonCode, 'SESSION_RESTRICTED');
});

test('list participants trusts PN/LID metadata and stored mappings; names never become identity', async t => {
  const participants = [{ id: '10001@lid', notify: 'Nome repetido' }, { id: '10002@lid', notify: 'Nome repetido' }, { id: '5562999999999@s.whatsapp.net' }];
  const { adapter } = await harness(t, { participants }); const list = await adapter.listParticipants('123-456@g.us');
  assert.equal(list[0].phone, '5562988881111'); assert.equal(list[1].phone, null); assert.notEqual(list[0].externalId, list[1].externalId); assert.equal(list[2].self, true);
});

test('conflicting aliases are flagged and cannot become a recipient', async t => {
  const { adapter } = await harness(t, { participants: [{ id: '10001@lid', phoneNumber: '5562988881111@s.whatsapp.net' }, { id: '10001@lid', phoneNumber: '5562988882222@s.whatsapp.net' }] });
  const list = await adapter.listParticipants('123-456@g.us'); assert.equal(list[1].ambiguous, true); assert.equal(list[1].phone, null);
});

test('group rename keeps ID; stale metadata response after reconnection is rejected', async t => {
  const { adapter, socket } = await harness(t); let finish;
  socket.groupMetadata = () => new Promise(resolve => { finish = resolve; });
  const pending = adapter.listParticipants('123-456@g.us'); await wait(0); await adapter.disconnect();
  finish({ id: '123-456@g.us', subject: 'Novo nome', participants: [] });
  await assert.rejects(pending, { code: 'WA_CONNECTION_CHANGED' });
});

test('sendMessage resolution alone is uncertain; no accepted claim without ACK', async t => {
  const { adapter, socket, person } = await harness(t); const result = await adapter.sendInvite(person, 'Convite', { clientMessageId: 'test-resolution' });
  assert.equal(result.status, 'uncertain'); assert.equal(result.code, 'WA_ACK_TIMEOUT'); assert.equal(socket.sends.length, 1);
});

test('protocol ACK confirms acceptance and recipient receipt confirms delivery', async t => {
  const { adapter, socket, person } = await harness(t); const promise = adapter.sendInvite(person, 'Convite', { clientMessageId: 'test-ack' }); await wait(0);
  socket.ws.emit('CB:ack,class:message', { attrs: { id: 'test-ack', class: 'message' } });
  assert.equal((await promise).status, 'accepted');
  socket.ev.emit('messages.update', [{ key: { id: 'test-ack', remoteJid: person.externalId, fromMe: true }, update: { status: 3 } }]);
  assert.equal((await adapter.reconcile('test-ack')).status, 'delivered');
  socket.ws.emit('CB:ack,class:message', { attrs: { id: 'test-ack' } }); assert.equal((await adapter.reconcile('test-ack')).status, 'delivered');
});

test('ACK arriving before sendMessage settles is retained', async t => {
  const { adapter, socket, person } = await harness(t);
  socket.sendMessage = (jid, message, opts) => { socket.sends.push({ jid }); socket.ws.emit('CB:ack,class:message', { attrs: { id: opts.messageId } }); return new Promise(() => {}); };
  assert.equal((await adapter.sendInvite(person, 'Convite', { clientMessageId: 'early-ack' })).status, 'accepted'); assert.equal(socket.sends.length, 1);
});

test('late receipt reconciles uncertain once without another network send', async t => {
  const { adapter, socket, person } = await harness(t); const events = []; adapter.on('receipt', e => events.push(e));
  assert.equal((await adapter.sendInvite(person, 'Convite', { clientMessageId: 'late-ack' })).status, 'uncertain');
  socket.ev.emit('messages.update', [{ key: { id: 'late-ack', remoteJid: person.externalId }, update: { status: 3 } }]);
  socket.ev.emit('messages.update', [{ key: { id: 'late-ack', remoteJid: person.externalId }, update: { status: 3 } }]);
  assert.equal((await adapter.reconcile('late-ack')).status, 'delivered'); assert.equal(events.length, 1); assert.equal(socket.sends.length, 1);
});

test('same client message ID, simultaneous callers, submits only once', async t => {
  const { adapter, socket, person } = await harness(t); let guardCount = 0;
  const options = { clientMessageId: 'double-click', beforeSubmit: async () => { guardCount++; await wait(2); } };
  const [a, b] = await Promise.all([adapter.sendInvite(person, 'Convite', options), adapter.sendInvite(person, 'Convite', options)]);
  assert.equal(a.status, 'uncertain'); assert.equal(b.status, 'uncertain'); assert.equal(socket.sends.length, 1); assert.equal(guardCount, 1);
  await adapter.sendInvite(person, 'Convite alterado', options); assert.equal(socket.sends.length, 1);
});

test('late callback revalidates consent; block after read-only lookup prevents submission', async t => {
  const { adapter, socket, store, person } = await harness(t);
  await assert.rejects(adapter.sendInvite(person, 'Convite', { clientMessageId: 'block-final', beforeSubmit: () => { store.contacts.set(person.id, { ...person, optOut: true }); } }), { code: 'WA_RECIPIENT_CHANGED' });
  assert.equal(socket.sends.length, 0);
});

test('beforeSubmit permission guard failure does not emit a message', async t => {
  const { adapter, socket, person } = await harness(t);
  await assert.rejects(adapter.sendInvite(person, 'Convite', { clientMessageId: 'guard-fail', beforeSubmit: () => { throw Object.assign(new Error('Parada geral'), { code: 'STOPPED' }); } }), { code: 'STOPPED' });
  assert.equal(socket.sends.length, 0);
});

test('group, unknown recipient, self, unresolved and unauthorized destinations refused', async t => {
  const { adapter, socket, store, person } = await harness(t);
  await assert.rejects(adapter.sendInvite({ ...person, id: 'outside' }, 'Convite', { clientMessageId: 'outside' }), { code: 'WA_CONTACT_NOT_REGISTERED' });
  for (const patch of [{ authorized: false }, { blocked: true }, { optOut: true }, { muted: true }, { ambiguous: true }, { self: true }]) {
    store.contacts.set(person.id, { ...person, ...patch }); await assert.rejects(adapter.sendInvite(person, 'Convite', { clientMessageId: `denied-${Object.keys(patch)[0]}` }), { code: 'WA_RECIPIENT_NOT_ELIGIBLE' });
  }
  store.contacts.set(person.id, { ...person, identifiers: ['10002@lid'], externalId: '10002@lid', phone: null });
  await assert.rejects(adapter.sendInvite({ ...person, externalId: '10002@lid' }, 'Convite', { clientMessageId: 'unresolved' }), { code: 'WA_IDENTITY_UNRESOLVED' }); assert.equal(socket.sends.length, 0);
});

test('post-submission network rejection is uncertain and not retryable safe failure', async t => {
  const { adapter, socket, person } = await harness(t); socket.sendMessage = async () => { throw new Error('token=DO_NOT_LOG'); }; const diagnostics = []; adapter.on('diagnostic', e => diagnostics.push(e));
  const result = await adapter.sendInvite(person, 'Convite', { clientMessageId: 'network-uncertain' });
  assert.equal(result.status, 'uncertain'); assert(!JSON.stringify(diagnostics).includes('DO_NOT_LOG'));
});

test('foreign chat receipt cannot confirm another contact; unknown IDs ignored', async t => {
  const { adapter, socket, person } = await harness(t); const pending = adapter.sendInvite(person, 'Convite', { clientMessageId: 'wrong-chat' }); await wait(0);
  socket.ev.emit('messages.update', [{ key: { id: 'wrong-chat', remoteJid: '5562988882222@s.whatsapp.net' }, update: { status: 3 } }]);
  socket.ws.emit('CB:ack,class:message', { attrs: { id: 'not-registered' } }); assert.equal((await pending).status, 'uncertain');
});

test('manual disconnect prevents automatic retries', async t => {
  const { adapter, socket, sockets } = await harness(t); await adapter.disconnect({ manual: true });
  socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 500 } } } }); await wait(35);
  assert.equal(sockets.length, 1); assert.equal(adapter.status.reasonCode, 'MANUAL_DISCONNECT');
});

test('recoverable disconnect reconnects once and ignores stale socket events', async t => {
  const { adapter, socket, sockets } = await harness(t); const stale = socket.ev.listeners('messages.update')[0];
  socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 500 } } } }); await wait(16);
  assert.equal(sockets.length, 2); assert.equal(adapter.status.ready, false);
  sockets[1].ev.emit('connection.update', { connection: 'open' }); assert.equal(adapter.status.ready, true);
  stale([{ key: { id: 'not-known' }, update: { status: 3 } }]); assert.equal(adapter.registry.size, 0);
});

test('disconnection after submission frees result as uncertain; no blind fallback', async t => {
  const { adapter, socket, person } = await harness(t); const pending = adapter.sendInvite(person, 'Convite', { clientMessageId: 'drop-mid-send' }); await wait(0);
  socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 403 } } } });
  assert.equal((await pending).status, 'uncertain'); assert.equal(socket.sends.length, 1);
});

test('receipt registry persists and survives a new adapter without resubmitting', async t => {
  const { adapter, socket, person, store, dir, security, library } = await harness(t);
  const pending = adapter.sendInvite(person, 'Convite', { clientMessageId: 'persist-proof' }); await wait(0); socket.ws.emit('CB:ack,class:message', { attrs: { id: 'persist-proof' } }); await pending; await adapter.disconnect();
  const restored = new WhatsAppAdapter({ credentialsDir: dir, store, safeStorage: security, loadLibrary: async () => library });
  assert.equal((await restored.reconcile('persist-proof')).status, 'accepted'); await restored.shutdown();
});

test('encrypted auth coalesces updates and restores credentials and signal keys', async t => {
  const { dir, security, library } = await harness(t); const auth = new EncryptedAuthStore({ dir, safeStorage: security, library }); const state = await auth.load();
  await Promise.all([auth.updateCreds({ exampleSecret: 'PRIVATE-CREDS-EXAMPLE' }), state.keys.set({ session: { device: { privateKey: Buffer.from('PRIVATE-SIGNAL-KEY') } } }), auth.updateCreds({ registered: true })]);
  const files = await fs.readdir(dir); assert.deepEqual(files, ['session.dpapi']); const raw = await fs.readFile(path.join(dir, 'session.dpapi')); assert(!raw.includes(Buffer.from('PRIVATE-CREDS-EXAMPLE'))); assert(!raw.includes(Buffer.from('PRIVATE-SIGNAL-KEY')));
  const next = new EncryptedAuthStore({ dir, safeStorage: security, library }); const restored = await next.load(); assert.equal(restored.creds.registered, true); assert.equal((await restored.keys.get('session', ['device'])).device.privateKey.toString(), 'PRIVATE-SIGNAL-KEY');
});

test('corrupt protected session is not overwritten with an empty session', async t => {
  const { dir, security, library } = await harness(t); await fs.writeFile(path.join(dir, 'session.dpapi'), 'corrupt');
  const auth = new EncryptedAuthStore({ dir, safeStorage: security, library }); await assert.rejects(auth.load(), { code: 'WA_AUTH_UNREADABLE' }); assert.equal(await fs.readFile(path.join(dir, 'session.dpapi'), 'utf8'), 'corrupt');
});

test('Linux basic_text and unavailable encryption refuse real auth', async t => {
  for (const security of [{ isEncryptionAvailable: () => false }, { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' }]) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'community-secure-')); const adapter = new WhatsAppAdapter({ credentialsDir: dir, safeStorage: security, runtimePlatform: 'linux' });
    await assert.rejects(adapter.connect(), { code: 'WA_SECURE_STORAGE_UNAVAILABLE' }); await adapter.shutdown(); await fs.rm(dir, { recursive: true, force: true });
  }
});

test('simulation starts empty and cannot ever send to real phone numbers', async () => {
  const adapter = new SimulatedAdapter(); await adapter.connect(); assert.deepEqual(await adapter.listGroups(), []);
  const data = adapter.testSimulation(); assert.equal(data.groups.length, 1); assert(data.participants.every(p => p.simulation && p.phone.startsWith('551199999000')));
  await assert.rejects(adapter.sendInvite(contact(), 'Convite', { clientMessageId: 'real-denied' }), { code: 'SIMULATION_REAL_RECIPIENT_BLOCKED' });
  const result = await adapter.sendInvite({ ...data.participants[0], authorized: true }, 'Convite de teste', { clientMessageId: 'simulation-only' }); assert.equal(result.confirmationScope, 'simulated-only'); await adapter.shutdown();
});

test('private opt-out incoming identity is verified, forwarded/group messages ignored', async t => {
  const { adapter, socket } = await harness(t); const incoming = []; adapter.on('incoming', event => incoming.push(event));
  socket.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: 'private', remoteJid: '10001@lid', fromMe: false }, message: { conversation: 'Não quero receber' } }, { key: { id: 'group', remoteJid: '123-456@g.us', fromMe: false }, message: { conversation: 'SAIR' } }, { key: { id: 'forwarded', remoteJid: '5562988881111@s.whatsapp.net' }, message: { extendedTextMessage: { text: 'SAIR', contextInfo: { isForwarded: true } } } }] });
  await wait(1); assert.equal(incoming.length, 1); assert.equal(incoming[0].phone, '5562988881111'); assert.equal(incoming[0].private, true);
  assert.equal(incoming[0].verified, true); assert.equal(incoming[0].senderId, '10001@lid');
});

test('receipt persistence failure stops transport instead of throwing from an event callback', async t => {
  const { adapter, socket, store, person } = await harness(t);
  const pending = adapter.sendInvite(person, 'Convite', { clientMessageId: 'disk-failed-after-submit' }); await wait(0);
  store.setSetting = () => { throw new Error('disk full SECRET_VALUE'); };
  assert.doesNotThrow(() => socket.ws.emit('CB:ack,class:message', { attrs: { id: 'disk-failed-after-submit' } }));
  assert.equal((await pending).status, 'uncertain'); assert.equal(adapter.status.ready, false); assert.equal(adapter.status.reasonCode, 'WA_RECEIPT_PERSIST_FAILED'); assert.equal(adapter.manual, true);
});

test('auto reconnect setting false prevents retry after an unexpected drop', async t => {
  const { adapter, socket, store, sockets } = await harness(t); store.setSetting('settings', { autoReconnect: false });
  socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 500 } } } }); await wait(35);
  assert.equal(sockets.length, 1); assert.equal(adapter.status.ready, false); assert.equal(adapter.reconnectTimer, null);
});

test('simulation accepts only its exact fixtures with a canonical store PN alias', async () => {
  const adapter = new SimulatedAdapter(); await adapter.connect(); const fixture = adapter.testSimulation().participants[0];
  const saved = { ...fixture, authorized: true, identifiers: [...fixture.identifiers, `${fixture.phone}@s.whatsapp.net`] };
  assert.equal((await adapter.sendInvite(saved, 'Convite', { clientMessageId: 'canonical-fixture' })).status, 'accepted');
  await assert.rejects(adapter.sendInvite({ ...saved, phone: '5562988881111' }, 'Convite', { clientMessageId: 'spoof-fixture' }), { code: 'SIMULATION_REAL_RECIPIENT_BLOCKED' }); await adapter.shutdown();
});
