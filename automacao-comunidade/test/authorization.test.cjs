'use strict';

// SQLite-backed service regressions. The transport never connects or sends.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createService } = require('../src/backend/service.cjs');

const CONSENT = 'Autorização explícita registrada em ambiente controlado.';
const GROUP = 'controlled-authorization@g.us';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'community-contact-authorization-'));
  let store;
  class DisconnectedTransport extends EventEmitter {
    constructor(options) { super(); store = options.store; this.status = { state: 'disconnected', ready: false }; this.minimumSpacingMs = 3000; }
    async disconnect() {}
    async sendInvite() { throw new Error('This authorization regression must never send a message.'); }
  }
  const svc = await createService({ dir, adapterFactory: options => new DisconnectedTransport(options) });
  t.after(async () => { await svc.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
  store.replaceGroups([{ id: GROUP, name: 'Grupo de teste controlado' }]);
  let nextNumber = 101;
  const seed = (id, changes = {}) => {const phone=`15555550${nextNumber++}`;return store.save('contacts', {
    id, name: `Contato ${id}`, displayName: `Perfil ${id}`, phone,
    externalId: `${phone}@s.whatsapp.net`, identifiers: [`${phone}@s.whatsapp.net`],
    groupIds: [GROUP], firstSeenAt: 1000, authorized: false, blocked: false,
    optOut: false, muted: false, self: false, ambiguous: false, consentNote: changes.authorized ? CONSENT : '', ...changes
  });};
  return { svc, store, seed };
}

test('authorization: mixed bulk selection saves valid contacts and reports each ineligible identity without authorizing it', async t => {
  const { svc, store, seed } = await fixture(t);
  const valid = seed('valid');
  seed('lid', { phone: null, externalId: 'controlled-unresolved@lid', identifiers: ['controlled-unresolved@lid'] });
  seed('blocked', { blocked: true });
  seed('muted', { muted: true });
  seed('opt-out', { optOut: true });
  seed('self', { self: true });
  seed('ambiguous', { ambiguous: true });
  const result = await svc.call('authorizeContacts', { ids: ['valid', 'lid', 'blocked', 'muted', 'opt-out', 'self', 'ambiguous', 'missing', 'valid'], consentNote: CONSENT });
  assert.deepEqual(result.summary, { selected: 8, authorized: 1, revoked: 0, skipped: 7 });
  assert.deepEqual(result.items.map(row => row.id), [valid.id]);
  assert.equal(result.items[0].authorizationEligible, true);
  assert.equal(store.get('contacts', valid.id).authorized, true);
  assert.equal(store.get('contacts', valid.id).consentNote, CONSENT);
  const codes = Object.fromEntries(result.skipped.map(row => [row.id, row.code]));
  assert.deepEqual(codes, { lid: 'CONTACT_PHONE_UNAVAILABLE', blocked: 'CONTACT_BLOCKED', muted: 'CONTACT_MUTED', 'opt-out': 'CONTACT_OPTED_OUT', self: 'CONTACT_SELF', ambiguous: 'CONTACT_IDENTITY_AMBIGUOUS', missing: 'CONTACT_NOT_FOUND' });
  assert.match(result.skipped.find(row => row.id === 'lid').reason, /LID.*Atualizar participantes/u);
  assert.match(result.message, /1 autorização.*7 contato/u);
  assert.equal(result.skipped.every(row => row.id === 'missing' || store.get('contacts', row.id).authorized === false), true);
  assert.equal(store.count('jobs'), 0);
});

test('authorization: selecting only unavailable contacts returns explicit zero-success details instead of the old generic exception', async t => {
  const { svc, store, seed } = await fixture(t);
  seed('lid', { phone: null, externalId: 'digits-are-not-a-phone@lid', identifiers: ['digits-are-not-a-phone@lid'] });
  const result = await svc.call('authorizeContacts', { ids: ['lid'], consentNote: CONSENT });
  assert.deepEqual(result.summary, { selected: 1, authorized: 0, revoked: 0, skipped: 1 });
  assert.deepEqual(result.items, []);
  assert.match(result.message, /Nenhum contato foi autorizado/u);
  assert.equal(result.skipped[0].code, 'CONTACT_PHONE_UNAVAILABLE');
  assert.equal(store.get('contacts', 'lid').phone, null);
  assert.equal(store.get('contacts', 'lid').authorized, false);
});

test('authorization: listContacts and listParticipants expose precise eligibility independently of consent and prior invitations', async t => {
  const { svc, store, seed } = await fixture(t);
  seed('valid'); seed('invalid-phone', { phone: '123', externalId: 'invalid@lid', identifiers: ['invalid@lid'] });
  seed('conflict', { phone: '15555550991', identifiers: ['15555550991@s.whatsapp.net', '15555550992@s.whatsapp.net'], ambiguous: true });
  seed('opt-out', { optOut: true });
  store.markRecipient(store.get('contacts', 'valid'), 'prior-proof', 'accepted', { messageId: 'CONTROLLED-ACK' });
  for (const action of ['listContacts', 'listParticipants']) {
    const result = await svc.call(action, { groupId: GROUP });
    const contacts = Object.fromEntries(result.items.map(row => [row.id, row]));
    assert.equal(contacts.valid.authorizationEligible, true);
    assert.equal(contacts.valid.authorized, false);
    assert.equal(contacts.valid.previouslyInvited, true);
    assert.equal(contacts.valid.authorizationBlockReason, null);
    assert.equal(contacts['invalid-phone'].authorizationBlockCode, 'CONTACT_PHONE_UNAVAILABLE');
    assert.equal(contacts.conflict.authorizationBlockCode, 'CONTACT_IDENTITY_AMBIGUOUS');
    assert.equal(contacts['opt-out'].authorizationBlockCode, 'CONTACT_OPTED_OUT');
    assert.equal(contacts['invalid-phone'].authorizationEligible, false);
  }
});

test('authorization: missing, invalid and non-string consent reject the entire request before any changes', async t => {
  const { svc, store, seed } = await fixture(t); seed('valid');
  for (const consentNote of [undefined, '', '  ', 'ab', 'x'.repeat(1001), { text: CONSENT }]) {
    await assert.rejects(svc.call('authorizeContacts', { ids: ['valid'], consentNote }), { code: 'CONSENT_REQUIRED' });
    assert.equal(store.get('contacts', 'valid').authorized, false);
  }
  assert.equal(store.listAll('audit').some(row => row.action === 'contacts.authorization.batch'), false);
});

test('authorization: unexpected persistence failure rolls back all successful contact updates and their audit records', async t => {
  const { svc, store, seed } = await fixture(t);
  seed('valid-a'); seed('valid-b', { phone: '15555550102', externalId: '15555550102@s.whatsapp.net', identifiers: ['15555550102@s.whatsapp.net'] });
  const auditBefore = store.count('audit'), originalSave = store.save;
  store.save = function(kind, value) {
    if (kind === 'contacts' && value.id === 'valid-b') throw Object.assign(new Error('Controlled write failure'), { code: 'SQLITE_FULL' });
    return originalSave.call(this, kind, value);
  };
  await assert.rejects(svc.call('authorizeContacts', { ids: ['valid-a', 'valid-b'], consentNote: CONSENT }), { code: 'SQLITE_FULL' });
  store.save = originalSave;
  assert.equal(store.get('contacts', 'valid-a').authorized, false);
  assert.equal(store.get('contacts', 'valid-b').authorized, false);
  assert.equal(store.count('audit'), auditBefore);
});

test('authorization: single-contact errors identify the contact and the exact reason without fabricating its phone', async t => {
  const { svc, store, seed } = await fixture(t);
  seed('lid', { name: 'Pessoa identificada', phone: null, externalId: 'unresolved@lid', identifiers: ['unresolved@lid'] });
  await assert.rejects(svc.call('updateContact', { id: 'lid', changes: { authorized: true, consentNote: CONSENT } }), err => {
    assert.equal(err.code, 'CONTACT_PHONE_UNAVAILABLE');
    assert.match(err.message, /Pessoa identificada \(ID: lid\)/u);
    assert.match(err.message, /LID.*Atualizar participantes/u);
    return true;
  });
  assert.equal(store.get('contacts', 'lid').phone, null);
  assert.equal(store.get('contacts', 'lid').authorized, false);
});

test('authorization: applying a block, opt-out or mute takes priority over a stale authorized checkbox', async t => {
  const { svc, store, seed } = await fixture(t);
  for (const flag of ['blocked', 'optOut', 'muted']) {
    seed(flag, { authorized: true, authorizedAt: 1000, consentNote: CONSENT });
    const updated = await svc.call('updateContact', { id: flag, changes: { authorized: true, [flag]: true, consentNote: '' } });
    assert.equal(updated[flag], true);
    assert.equal(updated.authorized, false);
    assert.equal(updated.authorizationEligible, false);
    assert.ok(store.get('contacts', flag).authorizationRevokedAt);
    await assert.rejects(svc.call('updateContact', { id: flag, changes: { authorized: true, consentNote: CONSENT } }), { code: flag === 'blocked' ? 'CONTACT_BLOCKED' : flag === 'optOut' ? 'CONTACT_OPTED_OUT' : 'CONTACT_MUTED' });
  }
});

test('authorization: editing an unavailable contact name preserves identity, restrictions and authorization without demanding consent', async t => {
  const { svc, store, seed } = await fixture(t);
  seed('lid', { phone: null, externalId: 'original@lid', identifiers: ['original@lid'], optOut: true });
  const updated = await svc.call('updateContact', { id: 'lid', changes: { name: 'Nome revisado', phone: '15555550999', externalId: '15555550999@s.whatsapp.net' } });
  assert.equal(updated.name, 'Nome revisado');
  assert.equal(updated.phone, null);
  assert.equal(updated.externalId, 'original@lid');
  assert.equal(updated.displayName, 'Perfil lid');
  assert.equal(updated.optOut, true);
  assert.equal(updated.authorized, false);
  assert.equal(store.get('contacts', 'lid').authorizedAt, undefined);
});

test('authorization: explicit revocation works for restricted contacts and preserves sent invitation controls', async t => {
  const { svc, store, seed } = await fixture(t);
  const contact = seed('known', { authorized: true, authorizedAt: 1000, blocked: true });
  store.markRecipient(contact, 'already-sent', 'accepted', { messageId: 'CONTROLLED-PRIOR-INVITE' });
  const ledgerBefore = store.ledger(contact);
  const result = await svc.call('authorizeContacts', { ids: ['known'], authorized: false });
  assert.deepEqual(result.summary, { selected: 1, authorized: 0, revoked: 1, skipped: 0 });
  assert.equal(store.get('contacts', contact.id).blocked, true);
  assert.equal(store.get('contacts', contact.id).authorized, false);
  assert.deepEqual(store.ledger(contact), ledgerBefore);
});

test('authorization: a permission change after listing is rechecked in the bulk backend transaction', async t => {
  const { svc, store, seed } = await fixture(t); seed('changed');
  assert.equal((await svc.call('listContacts')).items[0].authorizationEligible, true);
  store.save('contacts', { ...store.get('contacts', 'changed'), optOut: true });
  const result = await svc.call('authorizeContacts', { ids: ['changed'], consentNote: CONSENT });
  assert.equal(result.summary.authorized, 0);
  assert.equal(result.skipped[0].code, 'CONTACT_OPTED_OUT');
  assert.equal(store.get('contacts', 'changed').authorized, false);
});

test('authorization: formatted numbers already supplied by the integration normalize safely while LIDs remain unavailable', async t => {
  const { svc, seed } = await fixture(t);
  seed('formatted', { phone: '+1 (555) 555-0101', externalId: '15555550101:2@s.whatsapp.net', identifiers: ['15555550101:2@s.whatsapp.net'] });
  const result = await svc.call('authorizeContacts', { ids: ['formatted'], consentNote: CONSENT });
  assert.equal(result.summary.authorized, 1);
  assert.equal(result.items[0].authorizationEligible, true);
});

test('authorization: invalid bulk permission types never silently authorize contacts', async t => {
  const { svc, store, seed } = await fixture(t); seed('valid');
  for (const authorized of ['false', 1, null, {}]) await assert.rejects(svc.call('authorizeContacts', { ids: ['valid'], authorized, consentNote: CONSENT }), { code: 'AUTHORIZATION_INVALID' });
  assert.equal(store.get('contacts', 'valid').authorized, false);
});
