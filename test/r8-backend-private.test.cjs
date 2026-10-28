'use strict';

// Real backend/SQLite/authorization/scheduler/controllers and WhatsAppAdapter.
// Only the licence authority, OS protection and WhatsApp socket are controlled
// fixtures. Passing this suite does not prove a live WhatsApp or Windows send.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createAppService } = require('../src/backend/service.cjs');
const { WhatsAppAdapter } = require('../src/adapters/whatsapp.cjs');
const { createLicenseFixture } = require('./fixtures/license.cjs');

const ADMIN = '5511987654321', CANONICAL = '551187654321';
const PN = `${CANONICAL}@s.whatsapp.net`, LID = '900000000111@lid';
const OWNER = { name: 'Backend synthetic owner', username: 'r8-backend-owner', password: 'Synthetic-Backend-Password-R8!', phone: ADMIN };
class USyncUser { withPhone(phone) { this.phone = phone; return this; } }
class USyncQuery {
  constructor() { this.users = []; }
  withContactProtocol() { return this; }
  withLIDProtocol() { return this; }
  withUser(user) { this.users.push(user); return this; }
}

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kc-r8-backend-private-'));
  const originalConnect = WhatsAppAdapter.prototype.connect;
  let service, socket, adapter, sequence = 0;
  const sends = [], queries = [];
  const library = {
    USyncQuery, USyncUser,
    BufferJSON: { replacer: (_key, value) => value, reviver: (_key, value) => value },
    initAuthCreds: () => ({ registered: true }),
    WAMessageStubType: { CIPHERTEXT: 2 },
    proto: { Message: { AppStateSyncKeyData: { fromObject: value => value } } },
    default() {
      const ownSocket = {
        ev: new EventEmitter(), ws: new EventEmitter(), user: { id: '5521999900000@s.whatsapp.net' },
        end() {}, logout: async () => {}, groupFetchAllParticipating: async () => ({}),
        signalRepository: { lidMapping: { getPNForLID: async id => id === LID ? PN : null } },
        onWhatsApp: async number => [{ jid: number === ADMIN ? PN : `${number}@s.whatsapp.net`, exists: true }],
        executeUSyncQuery: async query => {
          assert.equal(query.users.length, 1); queries.push(query.users[0].phone);
          return { list: [{ id: PN, contact: true, lid: LID }], sideList: [] };
        },
        sendMessage: async (target, content, options) => {
          sends.push({ target, content, messageId: options.messageId });
          queueMicrotask(() => ownSocket.ws.emit('CB:ack,class:message', { attrs: { id: options.messageId } }));
          return { key: { id: options.messageId, remoteJid: target, fromMe: true }, status: 1 };
        }
      };
      socket = ownSocket; return ownSocket;
    }
  };
  WhatsAppAdapter.prototype.connect = async function (...args) {
    adapter = this;
    this.runtimePlatform = 'win32'; this.loadLibrary = async () => library;
    this.ackTimeoutMs = 100; this.controlTimeoutMs = 2000;
    const result = await originalConnect.apply(this, args);
    socket.ev.emit('connection.update', { connection: 'open' });
    return result;
  };
  const protection = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() };
  const open = async () => service = await createAppService({ dir, safeStorage: protection, runtimePlatform: 'win32', licenseService: createLicenseFixture(),
    host: async action => action === 'secretGet' ? null : { canceled: true, nativeStatus: 'unsupported', soundStatus: 'disabled' } });
  const close = async () => { if (service) await service.shutdown(); service = null; };
  t.after(async () => { try { await close(); } finally { WhatsAppAdapter.prototype.connect = originalConnect; await fs.rm(dir, { recursive: true, force: true }); } });
  await open();
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const page = await service.call('diagnosticsPage', { limit: 100 });
    throw new Error(`Timed out waiting for ${label}; stages: ${JSON.stringify(page.items.map(row => [row.stage, row.code]).slice(0, 30))}`);
  };
  const message = (text, patch = {}) => ({ message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000), ...patch,
    key: { id: `R8-BACKEND-${++sequence}`, remoteJid: PN, fromMe: false, ...patch.key } });
  const emit = value => socket.ev.emit('messages.upsert', { type: 'notify', messages: [value] });
  const send = async (text, patch) => {
    const before = sends.length, value = message(text, patch); emit(value);
    await waitFor(() => sends.length > before, text);
    // Wait for the backend to commit the integration result, rather than only
    // considering a socket invocation to be a completed operation.
    await waitFor(async () => {
      const page = await service.call('diagnosticsPage', { limit: 100 });
      const sentIds = sends.slice(before).map(output => output.messageId);
      return sentIds.length > 0 && sentIds.every(messageId => page.items.some(row => row.stage === 'transport.accepted' && row.messageId === messageId));
    }, `${text} result`);
    return { value, output: sends.slice(before) };
  };
  return { dir, open, close, waitFor, sends, queries, message, emit, send,
    get app() { return service; }, get adapter() { return adapter; }, get socket() { return socket; } };
}

test('R8 actual backend: canonical private commands, stop/control reply bypass, search replies and restart stay correctly authorized', async t => {
  const f = await fixture(t);
  await f.app.call('setupOwner', OWNER);
  await f.app.call('saveSettings', { settings: { integrationMode: 'whatsapp', unofficialAcknowledged: true } });
  await f.app.call('opportunityConfigSave', { config: { enabled: false, mode: 'manual', adminPhone: ADMIN } });
  await f.app.call('saveSearchSettings', { settings: { enabled: true, privateCommandsEnabled: true, commandPrivateNumbers: [ADMIN] } });
  await f.app.call('connect');
  assert.equal(f.app.snapshot().connection.state, 'connected');
  const configured = (await f.app.call('opportunityState')).config;
  assert.equal(configured.adminPhone, ADMIN); assert.equal(configured.adminActorId, f.app.snapshot().auth.user.id);

  for (const text of ['!status', '!ajuda', '!automatico off', '!automatico on']) {
    const result = await f.send(text);
    assert(result.output.every(output => output.target === PN), `${text}: private reply must stay at the actual requester chat`);
    assert(result.output.some(output => output.content.text), text);
  }
  assert.deepEqual(f.queries.sort(), [`+${ADMIN}`, `+${CANONICAL}`].sort());

  const stopped = await f.send('!pausar');
  assert(stopped.output.some(output => /pausados|interrompidos/i.test(output.content.text)));
  assert.equal((await f.app.call('automationStatus')).stopped, true);
  const duringStop = await f.send('!status');
  assert(duringStop.output.every(output => output.target === PN), 'global stop keeps manual administrative replies available');
  await f.send('!automatico on'); assert.equal((await f.app.call('automationStatus')).stopped, false);

  for (const text of ['!mega ajuda', '!mega status']) {
    const result = await f.send(text);
    assert(result.output.every(output => output.target === PN));
  }
  const empty = await f.send('!busca');
  assert(empty.output.every(output => output.target === PN));
  assert(empty.output.some(output => /exemplo|!busca|pesquis/i.test(output.content.text)));
  const none = await f.send('!busca iPhone 15 Pro Max 256GB');
  assert(none.output.every(output => output.target === PN));
  assert(none.output.some(output => /nenhuma|não.*oferta|0 oferta/i.test(output.content.text)));

  const menu = await f.send('!mega menu');
  assert(menu.output.every(output => output.target === PN));
  assert(menu.output.some(output => /menu|campanh/i.test(output.content.text)));
  const stopAll = await f.send('!mega parar tudo');
  assert(stopAll.output.every(output => output.target === PN));
  assert(stopAll.output.some(output => /interrompidos|bloqueadas/i.test(output.content.text)));
  assert.equal((await f.app.call('automationStatus')).stopped, true);
  await f.send('!status'); await f.send('!automatico on');
  assert.equal((await f.app.call('automationStatus')).stopped, false);

  // A central collision does not become a recipient redirect. Unknown accounts
  // receive neither control replies nor offers, even with an owner's name.
  const beforeUnauthorized = f.sends.length;
  f.emit(f.message('!status', { pushName: OWNER.name, key: { remoteJid: '5511977770000@s.whatsapp.net' } }));
  await f.waitFor(async () => (await f.app.call('diagnosticsPage', { limit: 100 })).items.some(row => row.code === 'OP_CONTROL_SENDER_DENIED'), 'denied unknown sender');
  assert.equal(f.sends.length, beforeUnauthorized);

  const repeated = await f.send('!status');
  const beforeDuplicate = f.sends.length; f.emit(repeated.value);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.sends.length, beforeDuplicate, 'a duplicate socket event cannot duplicate a response');
  await f.app.call('opportunityConfigSave', { config: { enabled: false, mode: 'manual', adminPhone: ADMIN } });
  await f.close(); await f.open(); await f.app.call('login', OWNER);
  assert.equal((await f.app.call('opportunityState')).config.adminPhone, ADMIN);
  assert.equal((await f.app.call('opportunityState')).config.automatic, false);
  assert.deepEqual((await f.app.call('searchesState')).settings.commandPrivateNumbers, [ADMIN]);
  await f.app.call('connect');
  const beforeReplay = f.sends.length; f.emit(repeated.value);
  await f.waitFor(async () => (await f.app.call('diagnosticsPage', { limit: 100 })).items.some(row => row.code === 'OP_CONTROL_DUPLICATE'), 'persistent command deduplication after backend reopen');
  assert.equal(f.sends.length, beforeReplay);
  const afterRestart = await f.send('!status', { key: { remoteJid: LID, remoteJidAlt: PN } });
  assert(afterRestart.output.every(output => output.target === LID), 'the authenticated actual LID chat is preserved after reconnect');
  assert.equal(f.app.snapshot().auth.user.phone, ADMIN, 'registration is preserved across server identity resolution and updates');
  assert(f.sends.every(output => [PN, LID].includes(output.target)), 'the full backend never broadcasts these commands to a group or other responsible');
});
