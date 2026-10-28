'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');
const { createStore, normalizeIdentity, normalizePhone } = require('../src/core/store.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'community-store-'));
  const store = createStore(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store };
}
function participant(number = '15555550101', additions = {}) { return { externalId: `${number}@s.whatsapp.net`, identifiers: [`${number}@s.whatsapp.net`], phone: number, name: 'Contato de teste', ...additions }; }
function addContact(store, number) { store.importParticipants('test@g.us', [participant(number)], 1000); return store.listAll('contacts').find(contact => contact.phone === (number || '15555550101')); }

test('default real mode is empty; all entities/settings/ledgers are isolated from simulation', t => {
  const { store } = fixture(t);
  assert.equal(store.getMode(), 'whatsapp'); assert.equal(store.count('contacts'), 0);
  const contact = addContact(store);
  store.setSetting('intervalMs', 30000); store.markRecipient(contact, 'proof', 'accepted', { at: 2000 });
  store.setMode('simulated'); assert.equal(store.count('contacts'), 0); assert.equal(store.getSetting('intervalMs'), null); assert.equal(store.isPreviouslyInvited(contact), false);
  store.save('groups', { id: 'demo@simulation', name: 'SIMULAÇÃO' });
  store.setMode('whatsapp'); assert.equal(store.count('groups'), 0); assert.equal(store.count('contacts'), 1); assert.equal(store.getSetting('intervalMs'), 30000); assert.equal(store.isPreviouslyInvited(contact), true);
});

test('participants deduplicate across groups and imports never authorize', t => {
  const { store } = fixture(t);
  assert.deepEqual(store.importParticipants('one@g.us', [participant()], 1000), { identified: 1, newContacts: 1, unavailable: 0, ambiguous: 0 });
  store.importParticipants('two@g.us', [participant(undefined, { name: 'Outro nome' })], 2000);
  assert.equal(store.count('contacts'), 1);
  const contact = store.listAll('contacts')[0];
  assert.equal(contact.authorized, false); assert.deepEqual(contact.groupIds, ['one@g.us', 'two@g.us']); assert.equal(contact.firstSeenAt, 1000); assert.equal(contact.lastSeenAt, 2000);
  assert.equal(contact.name, 'Contato de teste'); assert.equal(contact.displayName, 'Outro nome');
  assert.equal(store.list('contacts', { groupId: 'two@g.us' }).total, 1);
});

test('imports preserve authorization, chosen name, optout, blocked and muted flags', t => {
  const { store } = fixture(t); const contact = addContact(store);
  store.save('contacts', { ...contact, name: 'Nome escolhido', authorized: true, consentNote: 'Autorização explícita em teste', blocked: true, optOut: true, muted: true });
  store.importParticipants('new@g.us', [participant(undefined, { name: 'Nome do perfil', authorized: false, blocked: false, optOut: false })]);
  const current = store.get('contacts', contact.id);
  assert.equal(current.name, 'Nome escolhido'); assert.equal(current.displayName, 'Nome do perfil'); assert.equal(current.authorized, true); assert.equal(current.blocked, true); assert.equal(current.optOut, true); assert.equal(current.muted, true);
});

test('numbers normalize without converting LIDs to fictitious phone numbers', t => {
  const { store } = fixture(t);
  assert.equal(normalizePhone('+1 (555) 555-0101'), '15555550101'); assert.equal(normalizePhone('12345@lid'), null);
  assert.equal(normalizeIdentity('15555550101:7@s.whatsapp.net'), '15555550101@s.whatsapp.net');
  store.importParticipants('test@g.us', [{ externalId: '984232345678901@lid', identifiers: ['984232345678901@lid'], phone: null, name: 'Sem telefone' }]);
  const contact = store.listAll('contacts')[0]; assert.equal(contact.phone, null); assert.equal(store.recipientKey(contact), 'account:984232345678901@lid'); assert.equal(contact.authorized, false);
  assert.throws(() => store.save('contacts', { ...contact, authorized: true, consentNote: 'Nome igual' }), { code: 'CONTACT_NOT_AUTHORIZABLE' });
});

test('proven PN/LID aliases merge safely and preserve all groups and restrictive flags', t => {
  const { store } = fixture(t);
  store.importParticipants('one@g.us', [{ externalId: '333333333333333@lid', identifiers: ['333333333333333@lid'], phone: null, name: 'LID' }]);
  const lid = store.listAll('contacts')[0]; store.save('contacts', { ...lid, blocked: true });
  const pn = addContact(store); store.markRecipient(pn, 'old-proof', 'accepted');
  store.importParticipants('three@g.us', [participant(undefined, { identifiers: ['333333333333333@lid', '15555550101@s.whatsapp.net'] })]);
  assert.equal(store.count('contacts'), 1);
  const merged = store.listAll('contacts')[0]; assert.equal(merged.phone, '15555550101'); assert.equal(merged.blocked, true); assert.deepEqual(new Set(merged.groupIds), new Set(['one@g.us', 'test@g.us', 'three@g.us'])); assert.equal(store.isPreviouslyInvited(merged), true);
});

test('conflicting phone identities are not merged and existing authorization is revoked for review', t => {
  const { store } = fixture(t); const first = addContact(store); addContact(store, '15555550102');
  store.save('contacts', { ...first, authorized: true, consentNote: 'Teste' });
  const result = store.importParticipants('conflict@g.us', [participant(undefined, { identifiers: ['15555550101@s.whatsapp.net', '15555550102@s.whatsapp.net'] })]);
  assert.equal(result.ambiguous, 1); assert.equal(store.count('contacts'), 2);
  for (const contact of store.listAll('contacts')) { assert.equal(contact.ambiguous, true); assert.equal(contact.authorized, false); }
});

test('same names do not deduplicate distinct people and duplicate PN saves are rejected', t => {
  const { store } = fixture(t); const first = addContact(store); addContact(store, '15555550102'); assert.equal(store.count('contacts'), 2);
  assert.throws(() => store.save('contacts', { ...first, id: 'different-id' }), { code: 'IDENTITY_CONFLICT' }); assert.equal(store.count('contacts'), 2);
});

test('atomic claims allow one owner and rollback all work on write failure', t => {
  const { store } = fixture(t); const contact = addContact(store);
  assert.throws(() => store.transaction(() => { assert.equal(store.claimRecipient(contact, 'job-1'), true); store.save('runs', { id: 'run-1', status: 'active' }); throw new Error('write failure'); }), /write failure/);
  assert.equal(store.ledger(contact).activeJobId, null); assert.equal(store.count('runs'), 0);
  assert.equal(store.claimRecipient(contact, 'job-1'), true); assert.equal(store.claimRecipient(contact, 'job-1'), true); assert.equal(store.claimRecipient(contact, 'job-2'), false);
  assert.equal(store.releaseRecipient(contact, 'wrong-job'), false); assert.equal(store.ledger(contact).activeJobId, 'job-1'); assert.equal(store.releaseRecipient(contact, 'job-1'), true);
});

test('two independent store connections cannot claim same recipient', t => {
  const { dir, store } = fixture(t); const contact = addContact(store), second = createStore(dir); t.after(() => second.close());
  assert.equal(store.claimRecipient(contact, 'first'), true); assert.equal(second.claimRecipient(contact, 'second'), false); assert.equal(second.ledger(contact).activeJobId, 'first');
});

test('simultaneous worker processes atomically grant only one recipient reservation', async t => {
  const { dir, store } = fixture(t); const contact = addContact(store);
  const source = `const {parentPort,workerData}=require('node:worker_threads'); const store=require(workerData.module).createStore(workerData.dir); parentPort.on('message',()=>{try{parentPort.postMessage({claimed:store.claimRecipient(workerData.contact,workerData.job)});}catch(error){parentPort.postMessage({error:error.message});}finally{store.close();parentPort.close();}}); parentPort.postMessage({ready:true});`;
  const workers = ['one', 'two'].map(job => new Worker(source, { eval: true, workerData: { module: require.resolve('../src/core/store.cjs'), dir, contact, job } }));
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  await Promise.all(workers.map(worker => once(worker, 'message')));
  const results = workers.map(worker => once(worker, 'message').then(([result]) => result)); workers.forEach(worker => worker.postMessage('claim'));
  const settled = await Promise.all(results); assert.equal(settled.some(result => result.error), false); assert.equal(settled.filter(result => result.claimed).length, 1);
});

test('global invitation ledger prevents new campaign/text from resetting invitation status', t => {
  const { store } = fixture(t); const contact = addContact(store);
  store.claimRecipient(contact, 'job-one'); store.markRecipient(contact, 'job-one', 'accepted', { messageId: 'wa-message', at: 1200 });
  assert.equal(store.ledger(contact).activeJobId, null); assert.equal(store.isPreviouslyInvited(contact), true); assert.equal(store.claimRecipient(contact, 'new-campaign-new-text'), false);
  assert.equal(store.claimRecipient(contact, 'explicit-repeat', { allowRepeat: true }), true);
  store.markRecipient(contact, 'explicit-repeat', 'delivered', { at: 1500 }); assert.equal(store.ledger(contact).status, 'delivered'); assert.equal(store.ledger(contact).attempts.length, 2);
});

test('uncertain releases worker claim but cannot be automatically resent, including allowRepeat', t => {
  const { store } = fixture(t); const contact = addContact(store), other = addContact(store, '15555550102');
  store.claimRecipient(contact, 'uncertain-job'); store.markRecipient(contact, 'uncertain-job', 'uncertain', { at: 3000 });
  assert.equal(store.ledger(contact).activeJobId, null); assert.equal(store.claimRecipient(contact, 'retry'), false); assert.equal(store.claimRecipient(contact, 'retry', { allowRepeat: true }), false); assert.equal(store.claimRecipient(other, 'next-person'), true);
});

test('explicit manual uncertainty review creates one reviewed resend without deleting original proof', t => {
  const { store } = fixture(t); const contact = addContact(store);
  store.markRecipient(contact, 'uncertain', 'uncertain');
  assert.throws(() => store.reviewUncertainRecipient(contact, 'uncertain', {}), { code: 'MANUAL_CONFIRMATION_REQUIRED' });
  store.transaction(() => { store.reviewUncertainRecipient(contact, 'uncertain', { allowManualDuplicate: true }); assert.equal(store.claimRecipient(contact, 'manual-retry', { allowRepeat: true, reviewedJobId: 'uncertain' }), true); });
  store.markRecipient(contact, 'manual-retry', 'accepted');
  assert.equal(store.ledger(contact).uncertain, true); assert.equal(store.claimRecipient(contact, 'another-retry', { allowRepeat: true, reviewedJobId: 'uncertain' }), false); assert.equal(store.count('audit'), 1);
});

test('late delivery proof upgrades uncertain; late failures never downgrade accepted or delivered', t => {
  const { store } = fixture(t); const contact = addContact(store);
  store.markRecipient(contact, 'job', 'uncertain', { at: 1000, messageId: 'message' }); store.markRecipient(contact, 'job', 'accepted', { at: 2000 }); store.markRecipient(contact, 'job', 'failed', { at: 3000 }); assert.equal(store.ledger(contact).status, 'accepted');
  store.markRecipient(contact, 'job', 'delivered', { at: 4000 }); store.markRecipient(contact, 'job', 'failed', { at: 5000 }); assert.equal(store.ledger(contact).status, 'delivered'); assert.equal(store.ledger(contact).attempts[0].messageId, 'message');
  store.save('jobs', { id: 'job', status: 'delivered', messageId: 'message', deliveredAt: 4000 }); assert.equal(store.save('jobs', { id: 'job', status: 'pending' }).status, 'delivered');
});

test('restart preserves contacts, authorization, settings, models, claims and proofs', t => {
  const { dir, store } = fixture(t); const contact = addContact(store);
  store.save('contacts', { ...contact, authorized: true, consentNote: 'Teste' }); store.setSetting('intervalMs', 60000); store.save('templates', { id: 'template', name: 'Convite', message: 'Olá {nome}\n{link_comunidade} 😀' }); store.markRecipient(contact, 'previous', 'accepted'); store.close();
  const second = createStore(dir); t.after(() => second.close()); assert.equal(second.get('contacts', contact.id).authorized, true); assert.equal(second.getSetting('intervalMs'), 60000); assert.match(second.get('templates', 'template').message, /😀/); assert.equal(second.isPreviouslyInvited(contact), true);
});

test('history cleanup cannot erase ledger, jobs or runs', t => {
  const { store } = fixture(t); const contact = addContact(store);
  store.save('jobs', { id: 'job', status: 'accepted' }); store.save('runs', { id: 'run' }); store.save('history', { id: 'history', contactId: contact.id }); store.markRecipient(contact, 'job', 'accepted'); store.remove('history', 'history');
  assert.equal(store.count('history'), 0); assert.equal(store.isPreviouslyInvited(contact), true); assert.throws(() => store.remove('jobs', 'job'), { code: 'OPERATIONAL_HISTORY_PROTECTED' }); assert.throws(() => store.remove('runs', 'run'), { code: 'OPERATIONAL_HISTORY_PROTECTED' }); assert.throws(() => store.remove('contacts', contact.id), { code: 'CONTACT_HISTORY_PROTECTED' });
});

test('pagination/filtering is indexed, deterministic and listAll has no hidden cap', t => {
  const { store } = fixture(t);
  store.transaction(() => { for (let index = 0; index < 245; index++) store.save('history', { id: `entry-${String(index).padStart(3, '0')}`, campaignId: 'campaign', runId: 'run', status: index % 2 ? 'failed' : 'accepted', name: `Registro ${index}`, createdAt: index }); });
  assert.equal(store.list('history', { limit: 10000 }).items.length, 200); assert.equal(store.listAll('history').length, 245); assert.equal(store.list('history', { campaignId: 'campaign', runId: 'run', status: 'failed', limit: 10, offset: 10 }).total, 122); assert.equal(store.list('history', { search: 'Registro 244' }).items[0].id, 'entry-244');
  store.save('history', { id: 'literal', name: '100% _ literal' }); assert.equal(store.list('history', { search: '% _' }).total, 1);
});

test('metrics and contact derived statuses distinguish identified, authorized, invited and blocked', t => {
  const { store } = fixture(t); const one = addContact(store), two = addContact(store, '15555550102'), three = addContact(store, '15555550103');
  store.save('contacts', { ...two, authorized: true, consentNote: 'Autorizou' }); store.save('contacts', { ...three, authorized: true, consentNote: 'Autorizou', blocked: true }); store.markRecipient(one, 'job', 'accepted'); store.save('jobs', { id: 'job', status: 'accepted' });
  assert.equal(store.list('contacts', { status: 'authorized' }).total, 1); assert.equal(store.list('contacts', { status: 'invited' }).total, 1); assert.equal(store.list('contacts', { status: 'blocked' }).total, 1);
  assert.deepEqual(store.getMetrics(), { identified: 3, authorized: 2, newEligible: 1, previouslyInvited: 1, pending: 0, processing: 0, accepted: 1, delivered: 0, uncertain: 0, failed: 0, cancelled: 0, activeCampaigns: 0 });
});

test('uncertain contacts have a SQL-filtered paginated status even after an earlier accepted invite', t => {
  const { store } = fixture(t), accepted = addContact(store), uncertain = addContact(store, '15555550102'), fresh = addContact(store, '15555550103');
  for (const contact of [accepted, uncertain, fresh]) store.save('contacts', { ...contact, authorized: true, consentNote: 'Autorização de teste' });
  store.markRecipient(accepted, 'accepted', 'accepted');
  store.markRecipient(uncertain, 'old-accepted', 'accepted');
  store.markRecipient(uncertain, 'new-uncertain', 'uncertain');
  const before = store.getMetrics();
  const result = store.list('contacts', { status: 'uncertain', limit: 1, offset: 0 });
  assert.equal(result.total, 1); assert.equal(result.items[0].id, uncertain.id); assert.equal(store.list('contacts', { status: 'uncertain', limit: 1, offset: 1 }).items.length, 0);
  assert.equal(store.list('contacts', { status: 'invited' }).total, 1); assert.equal(store.list('contacts', { status: ['uncertain', 'invited'] }).total, 2);
  assert.equal(before.newEligible, 1); assert.equal(before.previouslyInvited, 2); assert.deepEqual(store.getMetrics(), before);
  store.markRecipient(uncertain, 'new-uncertain', 'accepted');
  assert.equal(store.list('contacts', { status: 'uncertain' }).total, 0); assert.equal(store.list('contacts', { status: 'invited' }).total, 2); assert.equal(store.getMetrics().newEligible, 1);
});

test('consistent backup includes operational ledger and templates but never copies session files', t => {
  const { dir, store } = fixture(t); const contact = addContact(store); store.markRecipient(contact, 'proof', 'delivered'); store.save('templates', { id: 'template', message: 'Convite' }); fs.mkdirSync(path.join(dir, 'session')); fs.writeFileSync(path.join(dir, 'session', 'creds.json'), 'TEST-CREDENTIAL-NOT-IN-BACKUP');
  const target = path.join(dir, 'export', 'backup.sqlite'); const result = store.backupTo(target); assert.equal(result.includesCredentials, false); assert.ok(result.size > 0); assert.equal(fs.readFileSync(target).includes(Buffer.from('TEST-CREDENTIAL-NOT-IN-BACKUP')), false);
  const backup = new DatabaseSync(target, { readOnly: true }); t.after(() => backup.close()); assert.equal(backup.prepare("SELECT count(*) AS n FROM invitation_ledger WHERE status='delivered'").get().n, 1);
});

test('restore preserves ledger, pauses all modes and converts submitted attempts into uncertainty', t => {
  const { dir, store } = fixture(t); const contact = addContact(store);
  store.save('campaigns', { id: 'campaign', status: 'active' }); store.save('runs', { id: 'run', status: 'running' }); store.save('jobs', { id: 'sent', contactId: contact.id, recipientKey: store.recipientKey(contact), status: 'processing', submittedAt: 1234 }); store.save('jobs', { id: 'safe', contactId: contact.id, recipientKey: store.recipientKey(contact), status: 'processing', submittedAt: null }); store.claimRecipient(contact, 'sent');
  const target = path.join(dir, 'backup.sqlite'); store.backupTo(target); store.save('templates', { id: 'post-backup' });
  const result = store.restoreFrom(target); assert.equal(result.paused, true); assert.ok(fs.existsSync(result.recoveryPath)); assert.equal(store.get('templates', 'post-backup'), null); assert.equal(store.get('campaigns', 'campaign').status, 'paused'); assert.equal(store.get('runs', 'run').status, 'paused'); assert.equal(store.get('jobs', 'sent').status, 'uncertain'); assert.equal(store.get('jobs', 'safe').status, 'pending'); assert.equal(store.ledger(contact).uncertain, true); assert.equal(store.getSetting('automationStopped'), true);
});

test('restoring an old backup cannot erase newer accepted/uncertain invites or optouts', t => {
  const { dir, store } = fixture(t), contact = addContact(store);
  store.save('contacts', { ...contact, authorized: true, consentNote: 'Autorização original' });
  const target = path.join(dir, 'old.sqlite'); store.backupTo(target);
  store.markRecipient(contact, 'post-backup-accepted', 'accepted', { at: 5000 });
  store.save('jobs', { id: 'post-backup-accepted', contactId: contact.id, recipientKey: store.recipientKey(contact), campaignId: 'campaign', status: 'accepted', submittedAt: 4000 });
  store.save('contacts', { ...store.get('contacts', contact.id), optOut: true });
  const newer = addContact(store, '15555550102'); store.markRecipient(newer, 'post-backup-uncertain', 'uncertain', { at: 6000 });
  store.save('contacts', { ...newer, authorized: true, consentNote: 'Não restaurar autorização posterior', muted: true });
  store.restoreFrom(target);
  const oldContact = store.get('contacts', contact.id), newContact = store.get('contacts', newer.id);
  assert.equal(oldContact.optOut, true); assert.equal(oldContact.authorized, false); assert.equal(store.isPreviouslyInvited(oldContact), true); assert.equal(store.claimRecipient(oldContact, 'new-auto'), false);
  assert.equal(newContact.authorized, false); assert.equal(newContact.muted, true); assert.equal(store.ledger(newContact).uncertain, true); assert.equal(store.claimRecipient(newContact, 'again', { allowRepeat: true }), false);
  assert.equal(store.getSubmissionCount('campaign', { from: 0, to: 10000 }), 1); assert.equal(store.getSetting('queueState').automationStopped, true);
});

test('pre-restore cancellation cannot release the reservation of a restored pending invitation', t => {
  const { dir, store } = fixture(t), contact = addContact(store);
  store.save('campaigns', { id: 'campaign', status: 'active' });
  store.save('runs', { id: 'run', campaignId: 'campaign', status: 'active' });
  store.save('jobs', { id: 'pending', campaignId: 'campaign', runId: 'run', contactId: contact.id, recipientKey: store.recipientKey(contact), status: 'pending', submittedAt: null });
  assert.equal(store.claimRecipient(contact, 'pending'), true);
  const backup = path.join(dir, 'pending-before-stop.sqlite'); store.backupTo(backup);
  store.save('jobs', { id: 'pending', status: 'cancelled' }); store.markRecipient(contact, 'pending', 'cancelled');
  assert.equal(store.ledger(contact).activeJobId, null);
  store.restoreFrom(backup);
  assert.equal(store.get('jobs', 'pending').status, 'pending'); assert.equal(store.get('runs', 'run').status, 'paused');
  assert.equal(store.ledger(contact).activeJobId, 'pending'); assert.equal(store.claimRecipient(contact, 'competing-new-job'), false);
  assert.equal(store.getSetting('queueState').automationStopped, true);
});

test('restore protection remains separated in real and simulated namespaces', t => {
  const { dir, store } = fixture(t), real = addContact(store);
  const target = path.join(dir, 'before.sqlite'); store.backupTo(target);
  store.markRecipient(real, 'real-proof', 'accepted');
  store.setMode('simulated'); const simulated = addContact(store); store.markRecipient(simulated, 'simulated-proof', 'uncertain'); store.save('contacts', { ...simulated, blocked: true });
  store.restoreFrom(target); assert.equal(store.getMode(), 'whatsapp'); assert.equal(store.ledger(real).status, 'accepted'); assert.equal(store.ledger(real).attempts.length, 1); assert.equal(store.getSetting('queueState').automationStopped, true);
  store.setMode('simulated'); const recovered = store.get('contacts', simulated.id); assert.equal(recovered.blocked, true); assert.equal(store.ledger(recovered).status, 'uncertain'); assert.equal(store.ledger(recovered).attempts.length, 1); assert.equal(store.getSetting('queueState').automationStopped, true);
});

test('restore cannot reinstate a consent that was explicitly revoked after the backup', t => {
  const { dir, store } = fixture(t), contact = addContact(store);
  store.save('contacts', { ...contact, authorized: true, authorizedAt: 1000, consentNote: 'Autorizou' });
  const backup = path.join(dir, 'before-revocation.sqlite'); store.backupTo(backup);
  store.save('contacts', { ...store.get('contacts', contact.id), authorized: false });
  store.restoreFrom(backup); assert.equal(store.get('contacts', contact.id).authorized, false); assert.equal(store.get('contacts', contact.id).blocked, false);
});

test('a real SQLite disk-full write latches persistenceFailed without accepting a lost record', t => {
  const { store } = fixture(t); const pages = Number(store.db.prepare('PRAGMA page_count').get().page_count);
  store.db.exec(`PRAGMA max_page_count=${pages}`);
  assert.throws(() => store.save('templates', { id: 'must-not-save', message: 'X'.repeat(1024 * 1024) }), /database or disk is full/);
  assert.equal(store.persistenceFailed, true); assert.equal(store.get('templates', 'must-not-save'), null);
});

test('submission count uses true timestamps and does not count unsent or other campaigns', t => {
  const { store } = fixture(t);
  store.save('jobs', { id: 'before', campaignId: 'one', submittedAt: 999, status: 'accepted' }); store.save('jobs', { id: 'in', campaignId: 'one', submittedAt: 1000, status: 'uncertain' }); store.save('jobs', { id: 'after', campaignId: 'one', submittedAt: 2000, status: 'accepted' }); store.save('jobs', { id: 'unsent', campaignId: 'one', submittedAt: null, status: 'pending' }); store.save('jobs', { id: 'other', campaignId: 'two', submittedAt: 1500, status: 'accepted' });
  assert.equal(store.getSubmissionCount('one', { from: 1000, to: 2000 }), 1); assert.equal(store.getSubmissionCount('one', { from: 1000, to: 2000, exceptJobId: 'in' }), 0);
});

test('confirmed phone cannot be changed to bypass the global invitation ledger', t => {
  const { store } = fixture(t), contact = addContact(store); store.markRecipient(contact, 'accepted', 'accepted');
  assert.throws(() => store.save('contacts', { ...contact, phone: '15555550102' }), { code: 'CONTACT_IDENTITY_IMMUTABLE' }); assert.equal(store.isPreviouslyInvited(store.get('contacts', contact.id)), true);
});

test('invalid/corrupt backup does not alter live database', t => {
  const { dir, store } = fixture(t); addContact(store); const invalid = path.join(dir, 'not-a-backup.sqlite'); const db = new DatabaseSync(invalid); db.exec('CREATE TABLE other(id TEXT)'); db.close(); assert.throws(() => store.restoreFrom(invalid), { code: 'BACKUP_INCOMPATIBLE' }); assert.equal(store.count('contacts'), 1);
});

test('unsupported existing schema is backed up and refused without destructive reset', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'community-old-schema-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); const file = path.join(dir, 'automacao-comunidade.sqlite'); const db = new DatabaseSync(file); db.exec('CREATE TABLE old_data(value TEXT); INSERT INTO old_data VALUES(\'preserved\'); PRAGMA user_version=99;'); db.close(); assert.throws(() => createStore(dir), { code: 'SCHEMA_INCOMPATIBLE' }); const copy = fs.readdirSync(dir).find(name => name.includes('before-migration')); assert.ok(copy); const backup = new DatabaseSync(path.join(dir, copy), { readOnly: true }); assert.equal(backup.prepare('SELECT value FROM old_data').get().value, 'preserved'); backup.close();
});

test('diagnostics redact secrets and sensitive settings are rejected', t => {
  const { store } = fixture(t); const item = store.diagnostics({ stage: 'connect', token: 'never-show', nested: { privateKey: 'private', detail: 'authorization=Bearer secret-value' } }); assert.equal(item.token, '[REDACTED]'); assert.equal(item.nested.privateKey, '[REDACTED]'); assert.equal(item.nested.detail.includes('secret-value'), false); assert.throws(() => store.setSetting('sessionCredential', 'secret'), { code: 'SENSITIVE_SETTING' });
});
