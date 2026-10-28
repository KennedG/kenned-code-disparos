'use strict';

// These are controlled-socket integration tests. The real adapter, SQLite,
// authorization and private-command/alert controllers run, but no connection
// to WhatsApp or physical Windows notification/DPAPI is made.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createStore } = require('../src/core/store.cjs');
const { AuthService } = require('../src/core/auth.cjs');
const { WhatsAppAdapter } = require('../src/adapters/whatsapp.cjs');
const { OpportunityPrivateCommands } = require('../src/core/opportunity-private-commands.cjs');
const { AlertService } = require('../src/core/alerts.cjs');

const ADMIN = '5511987654321';
const CANONICAL = '551187654321';
const OWNER_ACCOUNT = '5521999900000';
const LID = '900000000111@lid';
const PASSWORD = 'Synthetic-Fixture-Password-R8!';

class USyncUser {
  withPhone(phone) { this.phone = phone; return this; }
}
class USyncQuery {
  constructor() { this.users = []; this.protocols = []; }
  withContactProtocol() { this.protocols.push('contact'); return this; }
  withLIDProtocol() { this.protocols.push('lid'); return this; }
  withUser(user) { this.users.push(user); return this; }
}

async function fixture(t, { aliasProof = 'valid' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kc-r8-private-integration-'));
  const store = await createStore(dir);
  store.setSetting('integrationMode', 'whatsapp');
  let socket, controller, alerts;
  const sends = [], lookups = [], actions = [], contexts = [], tasks = [], diagnostics = [];
  const library = {
    USyncQuery, USyncUser,
    BufferJSON: { replacer: (_key, value) => value, reviver: (_key, value) => value },
    initAuthCreds: () => ({ registered: true, fixtureSecret: 'not-allowed-in-diagnostics' }),
    WAMessageStubType: { CIPHERTEXT: 2 },
    proto: { Message: { AppStateSyncKeyData: { fromObject: value => value } } },
    default() {
      socket = {
        ev: new EventEmitter(), ws: new EventEmitter(), user: { id: `${OWNER_ACCOUNT}@s.whatsapp.net` },
        end() {}, logout: async () => {},
        signalRepository: { lidMapping: { getPNForLID: async lid => lid === LID ? `${CANONICAL}@s.whatsapp.net` : null } },
        onWhatsApp: async number => [{ jid: `${number === ADMIN ? CANONICAL : number}@s.whatsapp.net`, exists: true }],
        executeUSyncQuery: async query => {
          assert.equal(query.users.length, 1, 'each proof must come from a single-phone query');
          assert.deepEqual(query.protocols, ['contact', 'lid']);
          const number = query.users[0].phone.replace(/^\+/, '');
          lookups.push(number);
          const row = { id: `${CANONICAL}@s.whatsapp.net`, contact: true, lid: LID };
          if (aliasProof === 'missing-lid') delete row.lid;
          if (aliasProof === 'conflicting-lid' && number === CANONICAL) row.lid = '900000000222@lid';
          return { list: aliasProof === 'ambiguous' ? [row, { ...row, id: '551177770000@s.whatsapp.net' }] : [row], sideList: [] };
        },
        sendMessage: async (target, content, options) => {
          sends.push({ target, content, messageId: options.messageId });
          queueMicrotask(() => socket.ws.emit('CB:ack,class:message', { attrs: { id: options.messageId } }));
          return { key: { id: options.messageId, remoteJid: target, fromMe: true }, status: 1 };
        }
      };
      if (aliasProof === 'unsupported') delete socket.executeUSyncQuery;
      return socket;
    }
  };
  const adapter = new WhatsAppAdapter({ store, credentialsDir: path.join(dir, 'fixture-session'),
    safeStorage: { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() },
    loadLibrary: async () => library, runtimePlatform: 'win32', ackTimeoutMs: 100, controlTimeoutMs: 2000 });
  const auth = new AuthService({ store,
    identityAliases: number => adapter.verifiedPhoneAliases(number),
    prepareIdentity: (context, phones) => adapter.prepareIdentityAliases(context, phones) });
  const owner = (await auth.setupOwner({ name: 'Synthetic authorized owner', username: 'r8-owner', phone: ADMIN, password: PASSWORD })).user;
  const cfg = { adminPhone: ADMIN, adminActorId: owner.id, ownerId: owner.id, automatic: true };
  const workflow = {
    config: () => structuredClone(cfg),
    async setAutomatic(value, actor) { cfg.automatic = value; actions.push(['automatic', value, actor]); },
    async approve(id, actor) { actions.push(['approve', id, actor]); },
    async reject(id, actor) { actions.push(['reject', id, actor]); },
    async pause(actor) { actions.push(['pause', actor]); return { inFlight: 0 }; },
    status: () => ({ automatic: cfg.automatic, queued: 2, awaitingApproval: 1, uncertain: 1, failed: 0 })
  };
  const makeController = () => new OpportunityPrivateCommands({ store, adapter, authService: auth, workflow });
  controller = makeController();
  adapter.on('transportDiagnostic', record => { diagnostics.push(record); store.addDiagnostic(record); });
  adapter.on('incoming', context => { contexts.push(context); tasks.push(controller.handle(context)); });
  await adapter.connect(); socket.ev.emit('connection.update', { connection: 'open' });
  t.after(async () => { controller.close(); if (alerts) await alerts.shutdown(); await adapter.disconnect(); store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  let serial = 0;
  const message = (text, patch = {}) => ({ message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000), ...patch,
    key: { id: `R8-${++serial}`, remoteJid: `${CANONICAL}@s.whatsapp.net`, fromMe: false, ...patch.key } });
  const emit = value => socket.ev.emit('messages.upsert', { type: 'notify', messages: [value] });
  const settle = async () => {
    for (let tries = 0; tries < 50 && adapter.identityHydrations.size; tries++) await new Promise(resolve => setImmediate(resolve));
    await Promise.all(tasks);
  };
  const send = async (text, patch) => { const value = message(text, patch); emit(value); await settle(); return value; };
  const ledger = () => store.getSetting('opportunityControlCommands:whatsapp', []);
  const receipt = id => socket.ev.emit('message-receipt.update', [{ key: { id, fromMe: true }, receipt: { receiptTimestamp: Math.floor(Date.now() / 1000) } }]);
  return { store, adapter, auth, owner, workflow, cfg, sends, lookups, actions, contexts, tasks, diagnostics, message, emit, settle, send, ledger, receipt,
    get socket() { return socket; },
    restartController() { controller.close(); controller = makeController(); adapter.seenIncoming.clear(); },
    createAlerts() {
      const scheduler = new EventEmitter(); scheduler.lastSubmissionAt = null; scheduler.persistenceFailed = false;
      scheduler.holdSubmissions = () => () => {}; scheduler.waitForIdle = async () => {};
      scheduler.blockOnPersistenceFailure = () => { scheduler.persistenceFailed = true; };
      alerts = new AlertService({ store, scheduler, adapter, sleep: async () => {} });
      alerts.start(); return alerts;
    }
  };
}

test('R8 controlled socket: all private opportunity controls use a server-proven canonical identity and reply only to its real chat', async t => {
  const f = await fixture(t);
  for (const text of ['!status', '!ajuda', '!automatico off', '!automatico on', '!aprovar OP-A', '!recusar OP-B', '!pausar']) await f.send(text);
  assert.equal(f.contexts.length, 7);
  assert(f.contexts.every(ctx => ctx.senderNumber === CANONICAL && ctx.chatId === `${CANONICAL}@s.whatsapp.net` && ctx.verified && ctx.fromMe === false), 'actual sender identity is never rewritten to the configured display phone');
  assert.deepEqual(f.lookups.sort(), [ADMIN, CANONICAL].sort(), 'a verified current-session mapping is reused');
  assert.equal(f.sends.length, 7);
  assert(f.sends.every(send => send.target === `${CANONICAL}@s.whatsapp.net`));
  assert.match(f.sends[0].content.text, /Oportunidades — status/);
  assert.match(f.sends[1].content.text, /!aprovar ID/);
  assert.deepEqual(f.actions, [['automatic', false, f.owner.id], ['automatic', true, f.owner.id], ['approve', 'OP-A', f.owner.id], ['reject', 'OP-B', f.owner.id], ['pause', f.owner.id]]);
  assert(f.ledger().every(row => row.status === 'completed' && row.replies[0].status === 'accepted'));
  for (const send of f.sends) f.receipt(send.messageId);
  assert(f.ledger().every(row => row.replies[0].status === 'delivered'));
  assert.equal(f.store.getEntity('users', f.owner.id).phone, ADMIN, 'trusted resolution never edits user registration');
  assert(f.diagnostics.filter(row => row.code === 'WA_EVENT_RECEIVED').length >= 7, 'short commands have transport diagnostics');
  assert(!JSON.stringify([...f.diagnostics, ...f.store.listEntities('diagnostics')]).includes('not-allowed-in-diagnostics'));
});

test('R8 controlled socket: LID route keeps actual phone provenance and a repeated event/restarted controller cannot send twice', async t => {
  const f = await fixture(t);
  const first = await f.send('!status', { key: { remoteJid: LID, remoteJidAlt: `${CANONICAL}@s.whatsapp.net` } });
  assert.equal(f.contexts[0].senderNumber, CANONICAL); assert.equal(f.sends[0].target, LID);
  f.emit(first); await f.settle(); assert.equal(f.sends.length, 1);
  f.restartController(); f.emit(first); await f.settle(); assert.equal(f.sends.length, 1);
  assert.equal(f.ledger().length, 1);
  assert(f.store.listEntities('diagnostics').some(row => row.code === 'OP_CONTROL_DUPLICATE'));
});

test('R8 controlled socket: no authorization from a matching name, forwarded command, group caption or machine echo', async t => {
  const f = await fixture(t);
  await f.send('!status', { pushName: 'Synthetic authorized owner', key: { remoteJid: '5511977770000@s.whatsapp.net' } });
  await f.send('!status', { message: { extendedTextMessage: { text: '!status', contextInfo: { isForwarded: true, forwardingScore: 1 } } } });
  await f.send('!status', { key: { remoteJid: '120363000001@g.us', participant: `${CANONICAL}@s.whatsapp.net` } });
  f.store.registerOutboundMessageId('R8-AUTOMATIC', { kind: 'fixture', at: Date.now(), storageMode: 'whatsapp' });
  await f.send('!status', { key: { id: 'R8-AUTOMATIC', fromMe: true, remoteJid: `${OWNER_ACCOUNT}@s.whatsapp.net` } });
  assert.equal(f.sends.length, 0); assert.equal(f.actions.length, 0); assert.equal(f.lookups.length, 0);
  assert.equal(f.ledger().length, 0);
});

for (const aliasProof of ['unsupported', 'missing-lid', 'conflicting-lid', 'ambiguous']) {
  test(`R8 controlled socket: ${aliasProof} alias evidence cannot authorize or send an opportunity control`, async t => {
    const f = await fixture(t, { aliasProof });
    await f.send('!automatico off');
    assert.equal(f.sends.length, 0); assert.equal(f.actions.length, 0); assert.equal(f.ledger().length, 0);
    assert.equal(f.auth.findAuthorizedPhone(CANONICAL), null);
    assert.deepEqual(f.adapter.verifiedPhoneAliases(CANONICAL), []);
  });
}

test('R8 controlled socket: separate active users on aliases make central authorization ambiguous', async t => {
  const f = await fixture(t);
  await f.auth.createUser({ name: 'Second synthetic user', username: 'r8-second', phone: CANONICAL, password: PASSWORD,
    roleId: 'role-admin', campaignScope: 'all', requirePasswordChange: false });
  await f.send('!automatico off');
  assert.equal(f.sends.length, 0); assert.equal(f.actions.length, 0);
  assert.equal(f.auth.findAuthorizedPhone(CANONICAL), null);
  assert.equal(f.auth.resolveWhatsAppActor(f.contexts[0]).code, 'WA_AUTH_AMBIGUOUS');
});

test('R8 controlled socket: ciphertext executes nothing and the recovered plaintext executes once', async t => {
  const f = await fixture(t);
  const value = f.message('', { message: undefined, messageStubType: 2, key: { id: 'R8-CIPHERTEXT' } });
  f.emit(value); await f.settle(); assert.equal(f.contexts.length, 0); assert.equal(f.sends.length, 0);
  const recovered = { ...value, message: { conversation: '!status' }, messageStubType: undefined };
  f.socket.ev.emit('messages.upsert', { type: 'notify', requestId: 'recovered-fixture', messages: [recovered] });
  await f.settle(); assert.equal(f.sends.length, 1); assert.equal(f.contexts[0].recoveredAfterDecryption, true);
  f.emit(recovered); await f.settle(); assert.equal(f.sends.length, 1);
});

test('R8 controlled socket: the actual alert occurrence, queue and send flow accepts a proven recipient then awaits a real receipt', async t => {
  const f = await fixture(t);
  f.store.saveAlertRecipient({ id: 'r8-admin-recipient', name: 'Synthetic owner', phone: ADMIN, enabled: true, systemAlerts: true });
  const alerts = f.createAlerts();
  const result = await alerts.testAlert({ userId: f.owner.id });
  assert.equal(result.alerts.length, 1, 'owner and configured recipient are deduplicated by the configured phone');
  const alert = result.alerts[0];
  assert.equal(alert.status, 'confirmed'); assert.equal(alert.confirmationScope, 'whatsapp-server');
  assert.equal(alert.number, ADMIN); assert.equal(alert.targetId, `${CANONICAL}@s.whatsapp.net`);
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].target, `${CANONICAL}@s.whatsapp.net`);
  assert.equal(f.sends[0].messageId, alert.messageId);
  f.receipt(alert.messageId);
  const delivered = f.store.getAlert(alert.id);
  assert.equal(delivered.status, 'delivered'); assert.equal(delivered.confirmationScope, 'whatsapp-delivered');
  await alerts.flush(); assert.equal(f.sends.length, 1, 'receipt and later flush cannot repeat a confirmed alert');
  const records = f.store.listEntities('diagnostics').filter(row => row.traceId === alert.traceId);
  for (const stage of ['alerta.occurrence', 'alerta.queue', 'alerta.recipient', 'alerta.result', 'alerta.receipt']) assert(records.some(row => row.stage === stage), stage);
});

test('R8 controlled socket: alert stays failed with a clear recipient error when identity evidence is missing', async t => {
  const f = await fixture(t, { aliasProof: 'missing-lid' });
  f.store.saveAlertRecipient({ id: 'r8-admin-recipient', name: 'Synthetic owner', phone: ADMIN, enabled: true, systemAlerts: true });
  const alerts = f.createAlerts();
  const result = await alerts.testAlert({ userId: f.owner.id });
  assert.equal(result.alerts.length, 1); assert.equal(result.alerts[0].status, 'failed');
  assert.equal(result.alerts[0].errorCode, 'WA_RECIPIENT_MISMATCH');
  assert.equal(f.sends.length, 0);
  await alerts.flush(); assert.equal(f.sends.length, 0);
});
