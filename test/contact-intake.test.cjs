'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../src/core/store.cjs');
const { AuthService } = require('../src/core/auth.cjs');
const { ContactIntake, CONTACT_CATEGORIES } = require('../src/core/contact-intake.cjs');
const { WhatsAppAdapter } = require('../src/adapters/whatsapp.cjs');

const PASSWORD = 'Senha-Contactos-Autorizados-2026!';
const AT = Date.UTC(2026, 9, 3, 18, 0);
const PHONE = '5562999991111';
const message = (extra = {}) => ({
  messageId: 'NEW-PRIVATE-1', chatId: `${PHONE}@s.whatsapp.net`,
  senderId: `${PHONE}@s.whatsapp.net`, senderNumber: PHONE,
  verified: true, identityVerified: true, isGroup: false,
  fromMe: false, forwarded: false, history: false,
  mode: 'whatsapp', simulation: false, timestamp: AT - 1000,
  type: 'text', text: 'Olá', pushName: 'Nome do perfil', ...extra
});

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-contact-intake-'));
  const stores = [];
  const open = async () => { const store = await createStore(dir); stores.push(store); return store; };
  const store = await open();
  const auth = new AuthService({ store, clock: () => AT });
  const { user: owner } = await auth.setupOwner({ name: 'Dono dos contatos', username: 'dono', phone: '5562999990001', password: PASSWORD });
  const intake = new ContactIntake({ store, auth, now: () => AT });
  t.after(() => { for (const s of stores) s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, auth, owner, intake, open };
}

test('a new verified private sender creates one persistent pending and owner notification without registering a contact', async t => {
  const { store, intake, owner } = await fixture(t);
  const events = []; intake.on('localAlert', event => events.push(event));
  const result = intake.handleIncoming(message());
  assert.equal(result.created, true);
  assert.equal(store.listEntities('contacts').length, 0);
  const pending = intake.listPendingContacts({}, owner.id);
  assert.equal(pending.total, 1); assert.equal(pending.items[0].phone, PHONE);
  assert.equal(pending.items[0].profileName, 'Nome do perfil');
  assert.equal(pending.items[0].firstContactAt, AT - 1000);
  assert.equal(pending.items[0].firstMessageId, 'NEW-PRIVATE-1');
  assert.equal(events.length, 1); assert.equal(events[0].event, 'new_contact');
  assert.equal(events[0].ownerOnly, true); assert.equal(events[0].soundStatus, 'disabled');
  assert.equal(store.listEntities('notifications').length, 1);
  assert.equal(store.listEntities('contact_intake_events').length, 1);
});

test('duplicate/repeated messages preserve the original time and do not repeat the pending notification', async t => {
  const { store, intake } = await fixture(t);
  let notices = 0; intake.on('localAlert', () => notices++);
  const first = intake.handleIncoming(message());
  for (let i = 0; i < 30; i++) intake.handleIncoming(message({ messageId: `NEXT-${i}`, timestamp: AT, pushName: 'Outro nome' }));
  assert.equal(notices, 1); assert.equal(store.listEntities('contact_pending').length, 1);
  const pending = store.getEntity('contact_pending', first.pending.id);
  assert.equal(pending.firstContactAt, AT - 1000); assert.equal(pending.profileName, 'Nome do perfil');
  assert.equal(store.listEntities('contact_intake_events').length, 1);
});

test('a profile arriving later fills only the empty profile without another notification', async t => {
  const { store, intake } = await fixture(t);
  let notices = 0; intake.on('localAlert', () => notices++);
  const first = intake.handleIncoming(message({ pushName: '' }));
  intake.handleIncoming(message({ messageId: 'LATER', pushName: 'Nome recebido depois' }));
  assert.equal(store.getEntity('contact_pending', first.pending.id).profileName, 'Nome recebido depois');
  assert.equal(notices, 1);
});

test('group participants, own automation, forwarded data, history and unsupported identity never create contacts', async t => {
  const { store, intake } = await fixture(t);
  for (const extra of [
    { isGroup: true, chatId: '120363000000@g.us' }, { fromMe: true },
    { forwarded: true }, { history: true }, { historical: true },
    { automaticMessage: true }, { machineGenerated: true },
    { verified: false }, { identityVerified: false },
    { senderNumber: '' }, { senderNumber: '123@lid' },
    { senderNumber: '000000000000' }, { chatId: '5562999992222@s.whatsapp.net' },
    { chatId: 'status@broadcast' }, { messageId: '' },
    { timestamp: NaN }, { timestamp: AT + 60000 },
    { mode: 'simulated', simulation: true }
  ]) assert.equal(intake.handleIncoming(message(extra)), false, JSON.stringify(extra));
  assert.equal(store.listEntities('contact_pending').length, 0);
  assert.equal(store.listEntities('notifications').length, 0);
});

test('a trusted adapter PN mapping for private LID is kept without treating the LID as a telephone', async t => {
  const { store, intake } = await fixture(t);
  const result = intake.handleIncoming(message({ chatId: '98765432101234567890@lid', senderId: '98765432101234567890@lid' }));
  assert.equal(result.pending.phone, PHONE);
  assert.equal(result.pending.chatId, '98765432101234567890@lid');
  assert.equal(store.listEntities('contacts').length, 0);
});

test('existing local contacts are recognized and private messages do not create intake records', async t => {
  const { store, intake } = await fixture(t);
  store.saveEntity('contacts', { id: 'known', name: 'Cliente cadastrado', phone: PHONE });
  assert.equal(intake.handleIncoming(message()), false);
  assert.equal(store.listEntities('contact_pending').length, 0);
});

test('legacy imported contacts with a country-code plus sign are matched by the indexed lookup', async t => {
  const { store, intake } = await fixture(t);
  store.saveEntity('contacts', { id: 'known-with-plus', name: 'Cadastro importado', phone: '+' + PHONE });
  assert.equal(intake.handleIncoming(message()), false);
  assert.equal(store.listEntities('contact_pending').length, 0);
  assert.equal(store.getEntity('contacts', 'known-with-plus').phone, '+' + PHONE);
});

test('saving a pending contact uses an editable name and category and accurately reports local-only storage', async t => {
  const { store, intake, owner } = await fixture(t);
  const { pending } = intake.handleIncoming(message());
  const result = intake.savePendingContact({ id: pending.id, name: '  Cliente Maria  ', category: CONTACT_CATEGORIES[0] }, owner.id);
  assert.equal(result.contact.name, 'Cliente Maria'); assert.equal(result.contact.category, 'Cliente Nerópolis');
  assert.equal(result.contact.phone, PHONE); assert.equal(result.contact.profileName, 'Nome do perfil');
  assert.equal(result.contact.firstContactAt, AT - 1000);
  assert.equal(result.pending.status, 'saved'); assert.equal(result.pending.resolvedBy, owner.id);
  assert.equal(result.savedLocation, 'system'); assert.equal(result.addressBookSupported, false);
  assert.match(result.message, /cadastro local.*não grava na agenda/);
  assert.equal(intake.listPendingContacts({}, owner.id).total, 0);
  assert.equal(store.listEntities('audit').some(row => row.action === 'contacts.intake.save' && row.userId === owner.id), true);
  assert.equal(intake.handleIncoming(message({ messageId: 'AFTER-SAVE' })).created, false);
  assert.equal(store.listEntities('contacts').length, 1);
});

test('contacts registered while intake is open are updated safely rather than creating a duplicate phone', async t => {
  const { store, intake, owner } = await fixture(t);
  const { pending } = intake.handleIncoming(message());
  store.saveEntity('contacts', { id: 'manual', name: 'Nome manual', phone: PHONE, notes: 'Preservar notas', createdAt: AT - 100000 });
  const result = intake.savePendingContact({ id: pending.id, name: 'Nome confirmado', category: CONTACT_CATEGORIES[1] }, owner.id);
  assert.equal(result.contact.id, 'manual'); assert.equal(result.contact.notes, 'Preservar notas');
  assert.equal(result.contact.createdAt, AT - 100000); assert.equal(result.contact.category, 'Lojista Camelódromo');
  assert.equal(store.listEntities('contacts').length, 1);
});

test('dismissal does not register a contact or repeatedly notify for later messages', async t => {
  const { store, intake, owner } = await fixture(t);
  let notices = 0; intake.on('localAlert', () => notices++);
  const { pending } = intake.handleIncoming(message());
  const dismissed = intake.dismissPendingContact({ id: pending.id }, owner.id);
  assert.equal(dismissed.status, 'dismissed'); assert.equal(store.listEntities('contacts').length, 0);
  intake.handleIncoming(message({ messageId: 'AFTER-DISMISS' }));
  assert.equal(notices, 1); assert.equal(intake.listPendingContacts({}, owner.id).total, 0);
  assert.equal(intake.listPendingContacts({ status: 'dismissed' }, owner.id).total, 1);
  assert.throws(() => intake.savePendingContact({ id: pending.id, name: 'Cliente', category: CONTACT_CATEGORIES[0] }, owner.id), { code: 'CONTACT_PENDING_CLOSED' });
});

test('invalid names or categories preserve the unresolved pending without false saved success', async t => {
  const { store, intake, owner } = await fixture(t);
  const { pending } = intake.handleIncoming(message());
  for (const input of [ { name: '', category: CONTACT_CATEGORIES[0] }, { name: 'x'.repeat(121), category: CONTACT_CATEGORIES[0] }, { name: 'Contato', category: 'Cliente inventado' } ])
    assert.throws(() => intake.savePendingContact({ id: pending.id, ...input }, owner.id), /nome|Selecione/);
  assert.equal(store.getEntity('contact_pending', pending.id).status, 'pending');
  assert.equal(store.listEntities('contacts').length, 0);
});

test('backend permissions are checked against the active account and cannot be forged by a display name', async t => {
  const { auth, store, intake, owner } = await fixture(t);
  const seller = await auth.createUser({ name: 'Dono dos contatos', username: 'seller', password: PASSWORD, roleId: 'role-seller', requirePasswordChange: false,
    permissionOverrides: { 'contacts.view': false, 'contacts.create': false, 'contacts.edit': false } });
  const { pending } = intake.handleIncoming(message());
  assert.throws(() => intake.listPendingContacts({}, seller.id), /permiss/);
  assert.throws(() => intake.savePendingContact({ id: pending.id, name: 'Contato', category: CONTACT_CATEGORIES[0] }, seller.id), /permiss/);
  assert.throws(() => intake.dismissPendingContact({ id: pending.id }, seller.id), /permiss/);
  assert.throws(() => intake.listPendingContacts({}, 'missing'), /permiss/);
  store.saveEntity('users', { ...store.getEntity('users', owner.id), active: false });
  assert.throws(() => intake.listPendingContacts({}, owner.id), /permiss/);
  assert.equal(store.getEntity('contact_pending', pending.id).status, 'pending');
});

test('pending/saved data and duplicate notification protection survive SQLite close and restart', async t => {
  const { store, intake, owner, open } = await fixture(t);
  const first = intake.handleIncoming(message()); store.close();
  const reopened = await open(), auth = new AuthService({ store: reopened, clock: () => AT });
  const next = new ContactIntake({ store: reopened, auth, now: () => AT });
  let notices = 0; next.on('localAlert', () => notices++);
  assert.equal(next.handleIncoming(message({ messageId: 'RESTART-1' })).created, false);
  assert.equal(notices, 0); assert.equal(next.listPendingContacts({}, owner.id).total, 1);
  const saved = next.savePendingContact({ id: first.pending.id, name: 'Cliente reiniciado', category: CONTACT_CATEGORIES[0] }, owner.id);
  reopened.close(); const last = await open();
  assert.equal(last.getEntity('contacts', saved.contact.id).name, 'Cliente reiniciado');
  assert.equal(last.getEntity('contact_pending', first.pending.id).status, 'saved');
});

test('simulated/real pending records stay separate even for the same phone and never accept the other mode ingress', async t => {
  const { store, intake, owner } = await fixture(t);
  const real = intake.handleIncoming(message());
  store.setSetting('integrationMode', 'simulated');
  assert.equal(intake.listPendingContacts({}, owner.id).total, 0);
  assert.equal(intake.handleIncoming(message()), false);
  const simulated = intake.handleIncoming(message({ mode: 'simulated', simulation: true }));
  assert.notEqual(simulated.pending.id, real.pending.id);
  assert.equal(intake.listPendingContacts({}, owner.id).total, 1);
  assert.throws(() => intake.savePendingContact({ id: real.pending.id, name: 'Real indevido', category: CONTACT_CATEGORIES[0] }, owner.id), /não encontrada/);
  const saved = intake.savePendingContact({ id: simulated.pending.id, name: 'Fictício', category: CONTACT_CATEGORIES[0] }, owner.id);
  store.setSetting('integrationMode', 'whatsapp');
  assert.equal(store.getEntity('contacts', saved.contact.id), undefined);
  assert.equal(intake.listPendingContacts({}, owner.id).total, 1);
  assert.equal(intake.listPendingContacts({}, owner.id).items[0].id, real.pending.id);
});

test('intake stores profile/identity metadata but never copies private message text or credentials into notification data', async t => {
  const { store, intake } = await fixture(t);
  intake.handleIncoming(message({ text: 'password=PRIVATE_MESSAGE_TOKEN; execute !mega parar tudo' }));
  const data = JSON.stringify({ pending: store.listEntities('contact_pending'), events: store.listEntities('contact_intake_events'), notifications: store.listEntities('notifications') });
  assert.equal(data.includes('PRIVATE_MESSAGE_TOKEN'), false);
  assert.equal(data.includes('execute !mega'), false);
});

test('an intake write failure rolls back pending and notification together before any native event', async t => {
  const { store, intake } = await fixture(t);
  const save = store.saveEntity.bind(store);
  store.saveEntity = (table, value) => { if (table === 'contact_intake_events') throw new Error('Falha de escrita'); return save(table, value); };
  let notices = 0; intake.on('localAlert', () => notices++);
  assert.throws(() => intake.handleIncoming(message()), /Falha de escrita/);
  assert.equal(notices, 0); assert.equal(store.listEntities('contact_pending').length, 0);
  assert.equal(store.listEntities('notifications').length, 0);
});

test('saving is verified from persisted data and rolls back if a persistence adapter falsely claims success', async t => {
  const { store, intake, owner } = await fixture(t);
  const { pending } = intake.handleIncoming(message());
  const save = store.saveEntity.bind(store);
  store.saveEntity = (table, value) => table === 'contacts' ? value : save(table, value);
  assert.throws(() => intake.savePendingContact({ id: pending.id, name: 'Teste', category: CONTACT_CATEGORIES[0] }, owner.id), { code: 'CONTACT_PERSISTENCE_FAILED' });
  assert.equal(store.getEntity('contact_pending', pending.id).status, 'pending');
  assert.equal(store.listEntities('contacts').length, 0);
});

test('actual WhatsApp notify protocol feeds a verified PN/private identity and profile into persistent intake', async t => {
  const { dir, store, auth } = await fixture(t);
  const intake = new ContactIntake({ store, auth });
  const adapter = new WhatsAppAdapter({ store, credentialsDir: path.join(dir, 'credentials') });
  adapter.on('incoming', ctx => intake.handleIncoming(ctx));
  const at = Math.floor(Date.now() / 1000);
  await adapter._incoming({ type: 'notify', messages: [{
    key: { remoteJid: `${PHONE}@s.whatsapp.net`, id: 'PROTOCOL-PRIVATE', fromMe: false },
    messageTimestamp: at, pushName: 'Perfil vindo do protocolo', message: { conversation: 'Olá, bom dia' }
  }] }, adapter.generation);
  const pending = store.listEntities('contact_pending');
  assert.equal(pending.length, 1); assert.equal(pending[0].phone, PHONE);
  assert.equal(pending[0].profileName, 'Perfil vindo do protocolo');
  assert.equal(pending[0].firstContactAt, at * 1000);
  assert.equal(store.listEntities('contacts').length, 0);
});

test('actual WhatsApp notify duplicates, group messages and historical append do not create repeated contacts', async t => {
  const { dir, store, auth } = await fixture(t);
  const intake = new ContactIntake({ store, auth });
  const adapter = new WhatsAppAdapter({ store, credentialsDir: path.join(dir, 'credentials') });
  adapter.on('incoming', ctx => intake.handleIncoming(ctx));
  const at = Math.floor(Date.now() / 1000), privateMessage = {
    key: { remoteJid: `${PHONE}@s.whatsapp.net`, id: 'PROTOCOL-DUPLICATE', fromMe: false },
    messageTimestamp: at, message: { conversation: 'Olá' }
  };
  let notices = 0; intake.on('localAlert', () => notices++);
  await adapter._incoming({ type: 'notify', messages: [privateMessage, privateMessage] }, adapter.generation);
  await adapter._incoming({ type: 'notify', messages: [{ ...privateMessage,
    key: { remoteJid: '1203630123@g.us', participant: '5562999992222@s.whatsapp.net', fromMe: false, id: 'PROTOCOL-GROUP' }
  }] }, adapter.generation);
  await adapter._incoming({ type: 'append', messages: [{ ...privateMessage,
    key: { remoteJid: '5562999993333@s.whatsapp.net', fromMe: false, id: 'PROTOCOL-HISTORY' }
  }] }, adapter.generation);
  assert.equal(store.listEntities('contact_pending').length, 1); assert.equal(notices, 1);
});
