'use strict';

// Independent production-store/auth/media review. Every record and file is
// isolated in a temporary profile; no WhatsApp connection is made.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createStore } = require('../src/core/store.cjs');
const { AuthService } = require('../src/core/auth.cjs');
const { MediaManager } = require('../src/core/media.cjs');

const PHONE = '5562999990101';
const PASSWORD = 'Preservacao-Teste-2026';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-preservation-231-')), stores = [];
  const open = async (directory = dir, options) => { const store = await createStore(directory, options); stores.push(store); return store; };
  const store = await open(); store.setSetting('integrationMode', 'whatsapp'); store.setSetting('initialized', true);
  const auth = new AuthService({ store });
  const owner = (await auth.setupOwner({ name: 'Dono de teste', username: 'owner-preservation', phone: PHONE, password: PASSWORD })).user;
  const media = new MediaManager(store, { auth });
  t.after(() => { for (const database of stores) database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, auth, owner, media, open };
}

const context = extra => ({ verified: true, identityVerified: true, senderNumber: PHONE, senderId: PHONE + '@s.whatsapp.net', senderIds: [], isGroup: false, fromMe: false, chatId: PHONE + '@s.whatsapp.net', ...extra });
function operational(store, ownerId) {
  store.upsertGroups([{ id: 'real-test@g.us', name: 'Grupo real de teste local', simulation: false, authorized: true }]);
  const campaign = store.saveCampaign({ id: 'preserved-campaign', name: 'Campanha existente', ownerId, state: 'active', items: [{ id: 'content', type: 'text', text: '*Conteúdo existente* 😀' }], groupIds: ['real-test@g.us'], schedule: { days: [1], startTime: '08:00', endTime: '18:00' }, intervalMinutes: 10, spacingSeconds: 3, mode: 'repeat' });
  store.insertRound({ id: 'round', campaignId: campaign.id, status: 'running', startedAt: Date.now() });
  for (const status of ['confirmed', 'queued', 'sending', 'accepted', 'uncertain']) store.insertJob({ id: 'job-' + status, roundId: 'round', campaignId: campaign.id, groupId: 'real-test@g.us', itemId: status, status, createdAt: Date.now(), attempts: status === 'queued' ? 0 : 1, messageId: 'MESSAGE_' + status, itemSnapshot: campaign.items[0] });
  store.saveAlert({ id: 'alert', recipientId: 'recipient', channel: 'whatsapp', number: PHONE, status: 'pending', createdAt: Date.now(), messageId: 'ALERT_PENDING' });
  store.saveAlertRecipient({ id: 'recipient', name: 'Responsável existente', phone: PHONE, enabled: true });
  store.claimSearchRun({ id: 'search-run', chatId: PHONE + '@s.whatsapp.net', messageId: 'INPUT_ONCE', userId: ownerId, status: 'queued', createdAt: Date.now() });
  store.saveSearchDelivery({ id: 'delivery', runId: 'search-run', mediaId: 'preserved-excel', status: 'uncertain', createdAt: Date.now(), messageId: 'EXCEL_UNCERTAIN' });
  store.registerOutboundMessageId('RESERVED_TRANSPORT', { kind: 'whatsapp' });
  store.upsertSearchMessage({ chatId: 'real-test@g.us', messageId: 'original-offer', text: 'iPhone 15 Pro Max 256GB R$ 3.850,00', originalAt: Date.now(), capturedAt: Date.now(), senderId: '5562999990202@s.whatsapp.net' }, [{ id: 'offer', modelKey: 'iphone 15 pro max', storageGB: 256, priceCents: 385000, priceKind: 'cash', confidence: 'confirmed' }]);
  store.saveEntity('contacts', { id: 'contact', name: 'Contato real existente', phone: '5562999990303', category: 'Cliente Nerópolis' });
  store.saveTemplate({ id: 'template', name: 'Modelo existente', items: [{ id: 'template-item', type: 'text', text: '*Texto preservado*' }] });
  store.setSetting('customPreference', { selected: ['real-test@g.us'], theme: 'dark', prefix: '!procura' });
  return campaign;
}

test('central authorization requires verified identity and rejects conflicting PN aliases without inferring a LID phone', async t => {
  const f = await fixture(t);
  assert.equal(f.auth.resolveWhatsAppActor(context()).user.id, f.owner.id);
  assert.equal(f.auth.resolveWhatsAppActor(context({ senderId: PHONE + ':12@c.us' })).user.id, f.owner.id);
  const lid = '9099999999999@lid';
  assert.equal(f.auth.resolveWhatsAppActor(context({ senderId: lid, senderIds: [lid, PHONE + '@s.whatsapp.net'] })).user.id, f.owner.id);
  assert.equal(f.auth.resolveWhatsAppActor(context({ senderId: lid, senderNumber: '', senderIds: [lid] })).user, null);
  assert.equal(f.auth.resolveWhatsAppActor(context({ senderNumber: lid, senderId: lid })).user, null);
  assert.equal(f.auth.resolveWhatsAppActor(context({ verified: false, displayName: f.owner.name })).code, 'WA_IDENTITY_UNVERIFIED');
  assert.equal(f.auth.resolveWhatsAppActor(context({ senderIds: ['5511999990101@s.whatsapp.net'] })).code, 'WA_IDENTITY_CONFLICT');
});

test('phone collisions fail closed and inactive, reset-required or roleless users do not authorize commands', async t => {
  const f = await fixture(t), owner = f.store.getEntity('users', f.owner.id);
  f.store.saveEntity('users', { id: 'duplicate', name: 'Outro', roleId: 'role-seller', active: true, phone: '(55) 62 99999-0101' });
  assert.equal(f.auth.resolveWhatsAppActor(context()).code, 'WA_AUTH_AMBIGUOUS'); assert.equal(f.auth.findAuthorizedPhone(PHONE), null);
  f.store.saveEntity('users', { ...f.store.getEntity('users', 'duplicate'), active: false });
  assert.equal(f.auth.resolveWhatsAppActor(context()).user.id, owner.id);
  for (const patch of [{ active: false }, { requirePasswordChange: true }, { roleId: 'missing-role' }]) {
    f.store.saveEntity('users', { ...owner, ...patch }); assert.equal(f.auth.resolveWhatsAppActor(context()).user, null);
  }
});

test('legacy authorized phone aliases are preserved but never provide administrative permission to a search-only role', async t => {
  const f = await fixture(t), alias = '5511999990102';
  f.store.saveEntity('roles', { id: 'role-search-only', name: 'Somente buscas', permissions: ['search.view', 'search.run'], isOwner: false });
  f.store.saveEntity('users', { id: 'searcher', name: 'Busca autorizada', roleId: 'role-search-only', active: true, phone: '5511999990103', authorizedPhones: ['+55 (11) 99999-0102'] });
  const actor = f.auth.resolveWhatsAppActor(context({ senderNumber: alias, senderId: alias + '@s.whatsapp.net' })).user;
  assert.equal(actor.id, 'searcher'); assert(f.auth.canFor(actor, 'search.run')); assert.equal(f.auth.canFor(actor, 'automation.control'), false);
  f.store.saveEntity('users', { ...f.store.getEntity('users', f.owner.id), authorizedPhones: [alias] });
  assert.equal(f.auth.resolveWhatsAppActor(context({ senderNumber: alias, senderId: alias + '@s.whatsapp.net' })).code, 'WA_AUTH_AMBIGUOUS');
});

test('pre-upgrade private SQLite backup precedes upgrade marker and preserves schema seven and operational records', async t => {
  const f = await fixture(t); operational(f.store, f.owner.id);
  const hashBefore = f.store.getEntity('users', f.owner.id).passwordHash;
  f.store.close(); const upgraded = await f.open(f.dir, { upgradeVersion: '2.3.1' });
  assert.equal(upgraded.schemaVersion, 7); assert(upgraded.upgradeBackup?.path); assert.equal(fs.statSync(upgraded.upgradeBackup.path).mode & 0o777, 0o600);
  const backup = new DatabaseSync(upgraded.upgradeBackup.path, { readOnly: true });
  try {
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 7); assert.equal(backup.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.equal(backup.prepare("SELECT data FROM settings WHERE id='lastAppUpgradeVersion'").get(), undefined);
    assert.deepEqual(JSON.parse(backup.prepare('SELECT data FROM users WHERE id=?').get(f.owner.id).data).passwordHash, hashBefore);
    assert.equal(backup.prepare('SELECT COUNT(*) n FROM recovery_tokens').get().n, 8);
    assert.equal(backup.prepare('SELECT COUNT(*) n FROM jobs').get().n, 5);
    assert.equal(backup.prepare("SELECT status FROM buscas_deliveries WHERE id='delivery'").get().status, 'uncertain');
    assert.equal(backup.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN('sales','inventory','cash_sessions','sale_payments')").get().n, 0);
  } finally { backup.close(); }
  assert.equal(upgraded.getSetting('lastAppUpgradeVersion'), '2.3.1'); assert.equal(upgraded.getCampaign('preserved-campaign').state, 'active');
  assert.equal(upgraded.getSearchMonitorStats().totalOffers, 1); assert.equal(upgraded.getTemplate('template').items[0].text, '*Texto preservado*');
  upgraded.close(); const reopened = await f.open(f.dir, { upgradeVersion: '2.3.1' });
  assert.equal(reopened.upgradeBackup, null); assert.equal(fs.readdirSync(path.join(f.dir, 'backups')).length, 1);
});

test('recovery snapshot is a private, independently recoverable database including WAL writes and rejects overwrites', async t => {
  const f = await fixture(t); operational(f.store, f.owner.id);
  const target = path.join(f.dir, 'recovery', 'private.sqlite'), result = f.store.createRecoverySnapshot(target);
  assert(result.bytes > 0); assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.throws(() => f.store.createRecoverySnapshot(f.store.filename), /arquivo novo/);
  assert.throws(() => f.store.createRecoverySnapshot(target), /arquivo novo/);
  assert.throws(() => f.store.createRecoverySnapshot('relative.sqlite'), /absoluto/);
  const restoreDir = path.join(f.dir, 'restored'); fs.mkdirSync(restoreDir); fs.copyFileSync(target, path.join(restoreDir, 'mega.sqlite'));
  const restored = await f.open(restoreDir), restoredAuth = new AuthService({ store: restored });
  const logged = await restoredAuth.login({ username: 'owner-preservation', password: PASSWORD }); assert.equal(logged.user.id, f.owner.id);
  assert.deepEqual(restored.getSetting('customPreference'), f.store.getSetting('customPreference'));
  assert.equal(restored.getAlert('alert').status, 'pending'); assert.equal(restored.getSearchDelivery('delivery').status, 'uncertain');
  assert.equal(restored.isOutboundMessageId('RESERVED_TRANSPORT'), true);
  assert.equal(restored.getSearchMonitorStats().totalOffers, 1); assert.equal(restored.listEntities('recovery_tokens').length, 8);
});

test('failed pre-upgrade backup prevents updates and leaves the existing profile recoverable', async t => {
  const f = await fixture(t); operational(f.store, f.owner.id); f.store.close();
  fs.writeFileSync(path.join(f.dir, 'backups'), 'blocking-file');
  await assert.rejects(f.open(f.dir, { upgradeVersion: '2.3.1' }), error => error.code === 'EEXIST');
  fs.unlinkSync(path.join(f.dir, 'backups')); const reopened = await f.open();
  assert.equal(reopened.getSetting('lastAppUpgradeVersion', null), null);
  assert.equal(reopened.getCampaign('preserved-campaign').state, 'active'); assert.equal(reopened.getJob('job-confirmed').status, 'confirmed');
  assert.equal(reopened.getSearchDelivery('delivery').status, 'uncertain');
});

test('informational traces remain diagnosable but do not become error history and true failures still do', async t => {
  const f = await fixture(t);
  for (const level of ['info', 'debug', 'warning', 'error']) f.store.addDiagnostic({ id: 'trace-' + level, traceId: 'same-trace', at: Date.now(), level, code: level === 'error' ? 'WA_REJECTED' : 'WA_STAGE_OK', description: 'Etapa do fluxo', stage: 'teste.' + level });
  f.store.addDiagnostic({ id: 'legacy-error', at: Date.now(), code: 'LEGACY_FATAL', description: 'Falha antiga sem nível explícito' });
  assert.equal(f.store.queryEntities('diagnostics', { traceId: 'same-trace' }).total, 4);
  const errors = f.store.listHistory({ category: 'errors', limit: 50 }); assert.equal(errors.total, 2);
  assert.deepEqual(errors.items.map(entry => entry.id).sort(), ['legacy-error', 'trace-error']);
});

test('Excel references beyond the first 500 deliveries protect pending, sending and uncertain files', async t => {
  const f = await fixture(t), files = {};
  for (const status of ['pending', 'sending', 'uncertain', 'confirmed', 'failed', 'cancelled']) files[status] = await f.media.importBuffer(Buffer.from('Managed document ' + status), { name: 'lista-' + status + '.xlsx' });
  f.store.claimSearchRun({ id: 'large-queue', status: 'queued', userId: f.owner.id, createdAt: Date.now() });
  f.store.transaction(() => {
    for (let i = 0; i < 600; i++) f.store.saveSearchDelivery({ id: 'filler-' + i, runId: 'large-queue', status: 'pending', mediaId: 'other-file', createdAt: Date.now() + i });
    let index = 601;
    for (const [status, file] of Object.entries(files)) f.store.saveSearchDelivery({ id: 'linked-' + status, runId: 'large-queue', status, mediaId: file.id, createdAt: Date.now() + index++ });
  });
  const scan = f.media.inspectDeletion(Object.values(files).map(file => file.id), f.owner.id);
  assert.equal(scan.blocked, 3);
  for (const status of ['pending', 'sending', 'uncertain']) {
    const item = scan.items.find(item => item.id === files[status].id); assert(item.blocked);
    assert(item.references.some(reference => reference.kind === 'searchDelivery' && reference.state === status));
    await assert.rejects(f.media.deleteFiles([files[status].id], { userId: f.owner.id, confirmation: 'EXCLUIR' }), error => error.code === 'MEDIA_IN_USE');
    assert(fs.existsSync(files[status].path)); assert(f.store.getMedia(files[status].id));
  }
  for (const status of ['confirmed', 'failed', 'cancelled']) assert.equal(scan.items.find(item => item.id === files[status].id).blocked, false);
});

test('history cleanup preserves dedupe ledgers, unknown outcomes, media and account data through recovery', async t => {
  const f = await fixture(t); operational(f.store, f.owner.id);
  const file = await f.media.importBuffer(Buffer.from('Excel preservado'), { name: 'lista.xlsx' });
  f.store.updateSearchDelivery('delivery', { mediaId: file.id });
  f.store.addDiagnostic({ id: 'error', code: 'REAL_ERROR', at: Date.now(), description: 'Falha de teste', level: 'error' });
  const cleaned = f.store.clearHistory({ actor: f.owner.id }); assert(cleaned.auditId);
  f.store.deleteSearchHistory({ actor: f.owner.id });
  assert.equal(f.store.listHistory({ limit: 50 }).total, 0); assert.equal(f.store.listSearchHistory({ limit: 50 }).total, 0);
  assert.equal(f.store.claimSearchRun({ id: 'should-not-be-created', chatId: PHONE + '@s.whatsapp.net', messageId: 'INPUT_ONCE', userId: f.owner.id, status: 'queued' }).claimed, false);
  assert.equal(f.store.getSearchDelivery('delivery').status, 'uncertain'); assert.equal(f.store.getAlert('alert').status, 'pending');
  assert.equal(f.store.listJobs().length, 5); assert.equal(f.store.isOutboundMessageId('RESERVED_TRANSPORT'), true);
  assert.equal(f.media.inspectDeletion([file.id], f.owner.id).blocked, 1);
  f.store.recoverInterrupted();
  assert.equal(f.store.getJob('job-confirmed').status, 'confirmed');
  assert.equal(f.store.getJob('job-queued').status, 'cancelled');
  for (const status of ['sending', 'uncertain']) assert.equal(f.store.getJob('job-' + status).status, 'uncertain');
  assert.equal(f.store.getJob('job-accepted').status, 'accepted', 'History cleanup and recovery preserve server acceptance');
  assert.equal(f.store.getCampaign('preserved-campaign').state, 'paused');
  assert.equal(f.store.getEntity('users', f.owner.id).active, true); assert(f.store.getMedia(file.id)); assert(fs.existsSync(file.path));
  assert(f.store.queryEntities('audit', { kind: 'history.clear' }).total >= 1);
});
