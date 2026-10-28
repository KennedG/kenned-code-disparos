'use strict';

// The real production adapter and authenticated event pipeline are exercised
// with a controlled socket. This does not claim a real WhatsApp connection.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { WhatsAppAdapter } = require('../src/adapters/whatsapp.cjs');

const REQUESTED = '5511998765432', CANONICAL = '551198765432';
const CANONICAL_JID = `${CANONICAL}@s.whatsapp.net`;
const LID = '100000000000001@lid', OTHER_LID = '100000000000002@lid';
const flush = () => new Promise(resolve => setImmediate(resolve));
function protection() {
  const key = crypto.randomBytes(32);
  return { isEncryptionAvailable: () => true,
    encryptString(text) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(text), cipher.final(), cipher.getAuthTag()]); },
    decryptString(value) { const cipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(-16)); return Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]).toString(); } };
}
class USyncQuery {
  constructor() { this.users = []; this.protocols = []; }
  withContactProtocol() { this.protocols.push('contact'); return this; }
  withLIDProtocol() { this.protocols.push('lid'); return this; }
  withUser(user) { this.users.push(user); return this; }
}
class USyncUser { withPhone(phone) { this.phone = phone; return this; } }
const answer = (extra = {}) => ({ list: [{ id: CANONICAL_JID, contact: true, lid: LID, ...extra }], sideList: [] });

async function fixture(t, { controlTimeoutMs = 1000 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kenned-r8-alias-'));
  const sends = [], queries = [], lookups = [];
  let socket, queryBehavior = async () => answer(), lookupBehavior = async () => [{ exists: true, jid: CANONICAL_JID }];
  const library = { USyncQuery, USyncUser,
    BufferJSON: { replacer: (_key, value) => value, reviver: (_key, value) => value },
    initAuthCreds: () => ({ registered: false }),
    proto: { Message: { AppStateSyncKeyData: { fromObject: value => value } } },
    DisconnectReason: { loggedOut: 401, restartRequired: 515, forbidden: 403 },
    default() {
      socket = { ev: new EventEmitter(), ws: new EventEmitter(), user: { id: '5511981112222@s.whatsapp.net' },
        end() {}, logout: async () => {},
        onWhatsApp: async number => { lookups.push(number); return lookupBehavior(number); },
        executeUSyncQuery: async query => { queries.push(query); return queryBehavior(query); },
        sendMessage: async (jid, content, options) => {
          sends.push({ jid, content, options });
          queueMicrotask(() => socket.ws.emit('CB:ack,class:message', { attrs: { id: options.messageId, class: 'message' } }));
          return { key: { id: options.messageId }, status: 1 };
        } };
      return socket;
    } };
  const adapter = new WhatsAppAdapter({ store: { dir }, credentialsDir: dir, runtimePlatform: 'win32', safeStorage: protection(), loadLibrary: async () => library, controlTimeoutMs, ackTimeoutMs: 50 });
  t.after(async () => { await adapter.disconnect(); await fs.rm(dir, { recursive: true, force: true }); });
  await adapter.connect(); socket.ev.emit('connection.update', { connection: 'open' });
  return { adapter, sends, queries, lookups, library, get socket() { return socket; },
    setQuery(fn) { queryBehavior = fn; }, setLookup(fn) { lookupBehavior = fn; },
    incoming(text = '!status', extra = {}) {
      const message = { key: { id: crypto.randomUUID(), remoteJid: CANONICAL_JID, fromMe: false, ...(extra.key || {}) },
        messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: text }, ...extra };
      let context; adapter.once('incoming', value => { context = value; });
      socket.ev.emit('messages.upsert', { type: 'notify', messages: [message] });
      return context;
    } };
}

test('R8 verifies both phone inputs with contact and LID before accepting the canonical server route', async t => {
  const f = await fixture(t), recipient = await f.adapter.resolveRecipient(REQUESTED);
  assert.equal(recipient.phone, REQUESTED); assert.equal(recipient.requestedPhone, REQUESTED);
  assert.equal(recipient.resolvedPhone, CANONICAL); assert.equal(recipient.jid, CANONICAL_JID);
  assert.equal(recipient.resolutionSource, 'whatsapp-usync-confirmed-alias');
  assert.equal(recipient.identityAliasesConfirmed, true);
  assert.deepEqual(f.lookups, [REQUESTED]);
  assert.deepEqual(f.queries.map(query => query.users[0].phone).sort(), [`+${REQUESTED}`, `+${CANONICAL}`].sort());
  assert.ok(f.queries.every(query => query.users.length === 1 && query.protocols.includes('contact') && query.protocols.includes('lid')));
  assert.deepEqual(f.adapter.verifiedPhoneAliases(REQUESTED), [REQUESTED, CANONICAL]);
  assert.deepEqual(f.adapter.verifiedPhoneAliases(CANONICAL), [REQUESTED, CANONICAL]);
  assert.equal(f.adapter.contacts.get(CANONICAL_JID).phoneNumber, CANONICAL);
  const context = f.incoming();
  assert.equal(context.senderNumber, CANONICAL); assert.equal(context.verified, true);
});

test('R8 sends a private message only to the route confirmed by the dual server proof', async t => {
  const f = await fixture(t);
  const result = await f.adapter.sendPrivate(REQUESTED, 'Aviso controlado', { clientMessageId: 'r8-private-accepted' });
  assert.equal(result.status, 'confirmed'); assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].jid, CANONICAL_JID); assert.equal(f.queries.length, 2);
  await f.adapter.resolveRecipient(REQUESTED); assert.equal(f.queries.length, 2);
});

test('R8 does not invent a ninth-digit alias when richer USync is unavailable', async t => {
  const f = await fixture(t); delete f.socket.executeUSyncQuery;
  await assert.rejects(f.adapter.sendPrivate(REQUESTED, 'Não enviar'), error => error.code === 'WA_RECIPIENT_MISMATCH');
  assert.equal(f.sends.length, 0); assert.deepEqual(f.adapter.verifiedPhoneAliases(REQUESTED), []);
});

test('R8 unrelated phone mismatch is rejected even when a rich-query API exists', async t => {
  const f = await fixture(t);
  await assert.rejects(f.adapter.resolveRecipient('5511987654999'), error => error.code === 'WA_RECIPIENT_MISMATCH');
  assert.equal(f.queries.length, 0); assert.equal(f.sends.length, 0);
});

test('R8 does not apply Brazilian alias rules to a different country', async t => {
  const f = await fixture(t); f.setLookup(async () => [{ exists: true, jid: '541198765432@s.whatsapp.net' }]);
  await assert.rejects(f.adapter.resolveRecipient('5411998765432'), error => error.code === 'WA_RECIPIENT_MISMATCH');
  assert.equal(f.queries.length, 0);
});

test('R8 rejects mismatched LIDs from the two authenticated queries', async t => {
  const f = await fixture(t); f.setQuery(async query => answer({ lid: query.users[0].phone === `+${REQUESTED}` ? LID : OTHER_LID }));
  await assert.rejects(f.adapter.sendPrivate(REQUESTED, 'Não enviar'), error => error.code === 'WA_RECIPIENT_MISMATCH');
  assert.equal(f.sends.length, 0); assert.deepEqual(f.adapter.verifiedPhoneAliases(REQUESTED), []);
});

test('R8 missing LID cannot authorize a shape-compatible phone variation', async t => {
  const f = await fixture(t); f.setQuery(async () => answer({ lid: undefined }));
  await assert.rejects(f.adapter.resolveRecipient(REQUESTED), error => error.code === 'WA_RECIPIENT_MISMATCH');
  assert.deepEqual(f.adapter.verifiedPhoneAliases(REQUESTED), []);
});

test('R8 duplicate or additional server rows are ambiguous even if one row matches', async t => {
  const f = await fixture(t); f.setQuery(async () => ({ list: [...answer().list, ...answer().list] }));
  await assert.rejects(f.adapter.resolveRecipient(REQUESTED), error => error.code === 'WA_RECIPIENT_MISMATCH');
  assert.equal(f.sends.length, 0);
});

test('R8 side-list results cannot silently introduce another account', async t => {
  const f = await fixture(t); f.setQuery(async () => ({ ...answer(), sideList: [{ id: '5511888888888@s.whatsapp.net' }] }));
  await assert.rejects(f.adapter.resolveRecipient(REQUESTED), error => error.code === 'WA_RECIPIENT_MISMATCH');
});

test('R8 unregistered contacts and differing canonical IDs fail closed', async t => {
  const f = await fixture(t); f.setQuery(async () => answer({ contact: false }));
  await assert.rejects(f.adapter.resolveRecipient(REQUESTED), error => error.code === 'WA_RECIPIENT_MISMATCH');
  f.setQuery(async () => answer({ id: `${REQUESTED}@s.whatsapp.net` }));
  await assert.rejects(f.adapter.resolveRecipient(REQUESTED), error => error.code === 'WA_RECIPIENT_MISMATCH');
  assert.equal(f.sends.length, 0);
});

test('R8 alias verification has a total deadline and does not reserve a send on timeout', async t => {
  const f = await fixture(t, { controlTimeoutMs: 20 }); f.setQuery(() => new Promise(() => {}));
  const started = Date.now();
  await assert.rejects(f.adapter.sendPrivate(REQUESTED, 'Não enviar'), error => error.code === 'WA_RECIPIENT_TIMEOUT' && error.safeToRetry === true);
  assert.ok(Date.now() - started < 1000); assert.equal(f.sends.length, 0);
  assert.deepEqual(f.adapter.verifiedPhoneAliases(REQUESTED), []);
});

test('R8 parallel lookups coalesce the contact lookup and both alias proof queries', async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.adapter.resolveRecipient(REQUESTED), f.adapter.resolveRecipient(REQUESTED)]);
  assert.equal(a.jid, b.jid); assert.equal(f.lookups.length, 1); assert.equal(f.queries.length, 2);
});

test('R8 stale server replies cannot create an alias after the connection changes', async t => {
  const f = await fixture(t); const resolvers = []; f.setQuery(() => new Promise(resolve => resolvers.push(resolve)));
  const pending = f.adapter.resolveRecipient(REQUESTED); await flush();
  assert.equal(resolvers.length, 2); f.adapter.setNetworkOnline(false);
  for (const resolve of resolvers) resolve(answer());
  await assert.rejects(pending, error => error.code === 'WA_RECIPIENT_CONNECTION_CHANGED');
  assert.deepEqual(f.adapter.verifiedPhoneAliases(REQUESTED), []); assert.equal(f.sends.length, 0);
});

test('R8 alias proof expires after its own TTL and is revalidated rather than presumed', async t => {
  const f = await fixture(t); await f.adapter.resolveRecipient(REQUESTED);
  f.adapter.verifiedRecipientAliases.get(REQUESTED).expiresAt = Date.now() - 1;
  assert.deepEqual(f.adapter.verifiedPhoneAliases(REQUESTED), []);
  await f.adapter.resolveRecipient(REQUESTED); assert.equal(f.queries.length, 4);
});

test('R8 proof is scoped to the authenticated account and is cleared on disconnect', async t => {
  const f = await fixture(t); await f.adapter.resolveRecipient(REQUESTED);
  f.socket.user.id = '5511981113333@s.whatsapp.net';
  assert.deepEqual(f.adapter.verifiedPhoneAliases(REQUESTED), []);
  await f.adapter.resolveRecipient(REQUESTED); assert.equal(f.queries.length, 4);
  await f.adapter.disconnect(); assert.equal(f.adapter.verifiedRecipientAliases.size, 0);
});

test('R8 prepares only a proven configured alias while retaining actual inbound sender and route', async t => {
  const f = await fixture(t), context = f.incoming('!status');
  const prepared = await f.adapter.prepareIdentityAliases(context, [REQUESTED]);
  assert.equal(prepared, context); assert.equal(prepared.senderNumber, CANONICAL);
  assert.equal(prepared.chatId, CANONICAL_JID); assert.equal(f.queries.length, 2);
  const proof = await f.adapter.reply(context.chatId, 'Status controlado', { replyContext: context, clientMessageId: 'r8-reply' });
  assert.equal(proof.status, 'confirmed'); assert.equal(f.sends[0].jid, CANONICAL_JID);
});

test('R8 an arbitrary reply context cannot make an authorization alias', async t => {
  const f = await fixture(t), context = f.incoming(); context.replyProof = 'forged.signature';
  await assert.rejects(f.adapter.prepareIdentityAliases(context, [REQUESTED]), error => error.code === 'WA_REPLY_CONTEXT_INVALID');
  assert.equal(f.lookups.length, 0); assert.equal(f.queries.length, 0);
});

test('R8 forwarded, historical, automated, unrelated and expired commands do not trigger identity lookups', async t => {
  const f = await fixture(t), context = f.incoming();
  for (const patch of [{ forwarded: true }, { history: true }, { automaticMessage: true }, { timestamp: Date.now() - 180000 }, { senderNumber: '551188765432' }]) {
    await f.adapter.prepareIdentityAliases({ ...context, ...patch }, [REQUESTED]);
  }
  await f.adapter.prepareIdentityAliases({ ...context, text: 'Uma conversa normal' }, [REQUESTED]);
  assert.equal(f.lookups.length, 0); assert.equal(f.queries.length, 0);
});

test('R8 exact configured number lookup does not authorize a different incoming alias without proof', async t => {
  const f = await fixture(t), context = f.incoming();
  f.setLookup(async number => [{ exists: true, jid: `${number}@s.whatsapp.net` }]);
  await assert.rejects(f.adapter.prepareIdentityAliases(context, [REQUESTED]), error => error.code === 'WA_RECIPIENT_MISMATCH');
  assert.deepEqual(f.adapter.verifiedPhoneAliases(REQUESTED), []); assert.equal(f.queries.length, 0);
});

test('R8 all seven short opportunity commands emit transport receive and identity diagnostics', async t => {
  const f = await fixture(t), diagnostics = [], incoming = [];
  f.adapter.on('transportDiagnostic', value => diagnostics.push(value));
  f.adapter.on('incoming', value => incoming.push(value));
  for (const command of ['!automatico on', '!automatico off', '!aprovar teste', '!recusar teste', '!pausar', '!status', '!ajuda']) f.incoming(command);
  assert.equal(incoming.length, 7);
  assert.equal(diagnostics.filter(row => row.code === 'WA_EVENT_RECEIVED').length, 7);
  assert.equal(diagnostics.filter(row => row.code === 'WA_IDENTITY_RESOLVED').length, 7);
  assert.ok(diagnostics.every(row => !JSON.stringify(row).includes('!automatico')));
});

test('R8 raw conflicting PN identities remain unverified without server alias evidence', async t => {
  const f = await fixture(t);
  const context = f.incoming('!status', { key: { id: crypto.randomUUID(), remoteJid: CANONICAL_JID, remoteJidAlt: `${REQUESTED}@s.whatsapp.net`, fromMe: false } });
  assert.equal(context.verified, false); assert.equal(context.senderNumber, '');
  await f.adapter.prepareIdentityAliases(context, [REQUESTED]); assert.equal(f.queries.length, 0);
});

test('R8 successful alias proof records sanitized evidence under the caller trace without pretending it was sent', async t => {
  const f = await fixture(t), diagnostics = [], traceId = crypto.randomUUID();
  f.adapter.on('transportDiagnostic', value => diagnostics.push(value));
  await f.adapter.resolveRecipient(REQUESTED, { traceId });
  const event = diagnostics.find(row => row.code === 'WA_RECIPIENT_IDENTITY_CONFIRMED');
  assert.ok(event); assert.equal(event.traceId, traceId);
  assert.equal(event.stage, 'transport.recipient'); assert.equal(event.detail.submitted, false);
  assert.equal(event.detail.identityConfirmed, true); assert.equal(event.detail.evidence, 'dual-single-user-contact-lid');
  assert.equal(event.detail.requestedPhoneLength, 13); assert.equal(event.detail.returnedPhoneLength, 12);
  const serialized = JSON.stringify(event);
  assert.ok(!serialized.includes(REQUESTED) && !serialized.includes(CANONICAL) && !serialized.includes(LID));
  assert.equal(f.sends.length, 0);
});

test('R8 actual Baileys USync classes support the single-phone contact plus LID proof query', async () => {
  const { pathToFileURL } = require('node:url');
  const libRoot = path.dirname(require.resolve('@whiskeysockets/baileys'));
  const actual = await import(pathToFileURL(path.join(libRoot, 'WAUSync', 'index.js')).href);
  const query = new actual.USyncQuery().withContactProtocol().withLIDProtocol().withUser(new actual.USyncUser().withPhone(`+${REQUESTED}`));
  assert.equal(query.users.length, 1); assert.equal(query.users[0].phone, `+${REQUESTED}`);
  assert.deepEqual(query.protocols.map(protocol => protocol.name), ['contact', 'lid']);
});

test('R8 server-proven LID mapping identifies a later LID-only private event without fabricating a phone', async t => {
  const f = await fixture(t); await f.adapter.resolveRecipient(REQUESTED);
  const context = f.incoming('!status', { key: { id: crypto.randomUUID(), remoteJid: LID, fromMe: false } });
  assert.equal(context.verified, true); assert.equal(context.senderId, LID);
  assert.equal(context.senderNumber, CANONICAL); assert.equal(context.chatId, LID);
  await f.adapter.prepareIdentityAliases(context, [REQUESTED]);
  await f.adapter.reply(context.chatId, 'Resposta controlada', { replyContext: context, clientMessageId: 'r8-lid-reply' });
  assert.equal(f.sends[0].jid, LID); assert.equal(f.queries.length, 2);
  assert.notEqual(context.senderNumber, LID.split('@')[0]);
});
