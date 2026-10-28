'use strict';

// Production backend, real local SQLite persistence, isolated licence authority
// and simulated transport. No hosted activation, Windows or WhatsApp delivery
// is claimed by these tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createAppService } = require('../src/backend/service.cjs');
const { createStore } = require('../src/core/store.cjs');
const { SimulatedAdapter } = require('../src/adapters/simulated.cjs');
const { createLicenseFixture } = require('./fixtures/license.cjs');
const { confirmedLicenseExpiry } = require('../src/core/license-policy.cjs');

const PASSWORD = 'Licenca-Total-232-Teste!';
const OWNER = { name: 'Dono isolado', username: 'licenca-total', phone: '5562999990001', password: PASSWORD };
const expired = { allowed: false, status: 'expired', reasonCode: 'LICENSE_EXPIRED', reason: 'Vencimento confirmado pela autoridade isolada.' };
const unavailable = { allowed: false, status: 'network_required', reasonCode: 'LICENSE_CONNECTION_REQUIRED', reason: 'Serviço temporariamente indisponível.' };
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t, { authority, native } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcd-total-licence-'));
  const clock = { now: Date.now() };
  const licence = authority || createLicenseFixture({ clock: () => clock.now });
  const nativeCalls = [];
  let service, adapter;
  const host = async (action, payload) => {
    nativeCalls.push({ action, payload });
    if (action === 'secretGet') return null;
    if (native) { const result = await native(action, payload); if (result !== undefined) return result; }
    if (action === 'localAlert') return { soundStatus: 'disabled', nativeStatus: 'unsupported' };
    return { canceled: true };
  };
  const open = async () => {
    const connect = SimulatedAdapter.prototype.connect;
    SimulatedAdapter.prototype.connect = async function (...args) { adapter = this; return connect.apply(this, args); };
    try { service = await createAppService({ dir, version: '2.3.2', runtimePlatform: 'linux', now: () => clock.now, host, licenseService: licence }); }
    finally { SimulatedAdapter.prototype.connect = connect; }
    return service;
  };
  const close = async () => { if (service) { await service.shutdown(); service = null; } };
  await open();
  t.after(async () => { await close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const setup = async () => service.call('setupOwner', OWNER);
  const expire = async (patch = {}) => { licence.set({ ...expired, expiresAt: clock.now - 1, ...patch }); await service.systemCall('licenseChanged'); };
  const read = async fn => { const store = await createStore(dir); try { return fn(store); } finally { store.close(); } };
  return { dir, clock, licence, nativeCalls, open, close, setup, expire, read, get service() { return service; }, get adapter() { return adapter; } };
}

test('expiry classifier distinguishes confirmed expiry from temporary outage and valid offline grace', () => {
  assert.equal(confirmedLicenseExpiry(expired), true);
  for (const reasonCode of ['LICENSE_TRIAL_EXPIRED', 'TRIAL_EXPIRED']) assert.equal(confirmedLicenseExpiry({ allowed: false, status: 'trial', reasonCode }), true);
  assert.equal(confirmedLicenseExpiry(unavailable), false);
  assert.equal(confirmedLicenseExpiry({ allowed: true, status: 'offline_grace', reasonCode: 'LICENSE_OFFLINE_GRACE' }), false);
  assert.equal(confirmedLicenseExpiry({ allowed: true, status: 'expired' }), false);
});

test('confirmed expiration exposes only minimal license snapshot and never private user, connection or data', async t => {
  const f = await fixture(t); await f.setup();
  await f.service.call('saveContact', { name: 'Contato privado protegido', phone: '5562999990002' });
  await f.service.call('saveTemplate', { name: 'Modelo privado protegido', items: [{ type: 'text', text: 'Anúncio preservado 📱' }] });
  await f.expire();
  const snapshot = await f.service.call('snapshot');
  assert.equal(snapshot.licenseOnly, true); assert.equal(snapshot.license.totalBlocked, true);
  assert.equal(snapshot.connection, null); assert.equal(snapshot.auth.user, null); assert.deepEqual(snapshot.auth.permissions, []);
  assert.deepEqual(snapshot.settings, { theme: 'dark', sound: { enabled: false }, notifications: { nativeEnabled: false } });
  for (const field of ['campaigns', 'groups', 'contacts', 'media', 'templates', 'reminders', 'opportunities', 'history', 'dataDir', 'alertRecipients', 'buscas', 'notifications']) assert.equal(Object.hasOwn(snapshot, field), false, field);
  assert.equal(JSON.stringify(snapshot).includes('Contato privado protegido'), false);
  assert.equal(JSON.stringify(snapshot).includes('Modelo privado protegido'), false);
  assert.deepEqual(await f.service.call('authStatus'), snapshot.auth);
  await f.read(store => { assert.equal(store.listEntities('contacts').length, 1); assert.equal(store.listTemplates().length, 1); assert.equal(store.listCampaigns().length, 1); });
});

test('confirmed expiration blocks readonly, writes, media, exports, connection and every automation RPC', async t => {
  const f = await fixture(t); await f.setup(); await f.expire();
  const blocked = ['login', 'setupOwner', 'logout', 'recoverPassword', 'historyPage', 'diagnosticsPage', 'auditPage', 'mediaPath', 'importMedia', 'deleteMedia', 'mediaDeletionPreview', 'getTemplate', 'saveTemplate', 'duplicateTemplate', 'deleteTemplate', 'listContacts', 'saveContact', 'savePendingContact', 'listPendingContacts', 'saveCampaign', 'duplicateCampaign', 'deleteCampaign', 'activateCampaign', 'pauseCampaign', 'stopCampaign', 'stopAll', 'resumeAutomation', 'automationStatus', 'connect', 'disconnect', 'saveSettings', 'openDataFolder', 'backup', 'restore', 'exportHistory', 'exportDiagnostics', 'exportReports', 'searchOffers', 'searchMessages', 'searchHistory', 'runSearch', 'searchExportExcel', 'saveSearchSettings', 'searchesState', 'testSearchSimulation', 'opportunityPage', 'opportunityState', 'opportunityDetail', 'opportunityPreview', 'opportunityAction', 'opportunityEvaluate', 'opportunityConfigSave', 'sourceConfigGet', 'sourceConfigSave', 'sourcePublications', 'sourceResumeGroup', 'sourceImportHistory', 'sourceRetryMedia', 'sourceRemovePublication', 'sourceReorderItems', 'sourceReviewPublication', 'destinationRecheck', 'campaignReconcileUncertain', 'manualRetryJob', 'alertsPage', 'testAlert', 'testAlertRecipient', 'retryAlert', 'reviewAlert', 'listAlertRecipients', 'saveAlertRecipient', 'listReminders', 'saveReminder', 'testReminder', 'pauseReminder', 'activateReminder', 'deleteReminder', 'reminderHistory', 'testSound', 'importAudio', 'vitrineState', 'vitrineSave', 'vitrinePreview', 'vitrinePublish', 'vitrineWithdraw'];
  for (const action of blocked) await assert.rejects(f.service.call(action, {}), error => error.code === 'LICENSE_EXPIRED' && error.operation === action, action);
  assert.equal(f.nativeCalls.some(call => ['showOpenDialog', 'showSaveDialog', 'openDataFolder', 'testSound'].includes(call.action)), false);
});

test('only license operations, neutral public TV and native window/support actions remain accessible', async t => {
  const f = await fixture(t); await f.setup(); await f.expire();
  assert.equal((await f.service.call('licenseStatus')).totalBlocked, true);
  assert.equal((await f.service.call('licenseRefresh')).totalBlocked, true);
  const tv = await f.service.call('vitrinePublic'); assert.equal(tv.mode, 'neutral');
  assert.deepEqual(tv.items, []); assert.equal(tv.config.commercialPhone, undefined); assert.equal(tv.config.qrDataUrl, undefined);
  for (const action of ['windowMinimize', 'windowQuit', 'openSupport']) await f.service.call(action, { url: 'https://untrusted.invalid' });
  assert.deepEqual(f.nativeCalls.filter(call => call.action === 'openSupport').map(call => call.payload), [{}]);
  assert.equal(f.nativeCalls.filter(call => call.action === 'openSupport').length, 1);
  assert.equal((await f.service.call('licenseActivate', { key: 'ISOLATED-FIXTURE-ONLY' })).allowed, true);
  assert.equal(f.service.snapshot().automation.stopped, true);
});

test('expiry while native media dialog is open prevents imported files and queued writes from executing', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { native: async action => { if (action === 'showOpenDialog') { entered.resolve(); return release.promise; } } });
  await f.setup();
  const original = path.join(f.dir, 'image.png'); fs.writeFileSync(original, Buffer.from('image-fixture-not-imported'));
  const imported = f.service.call('importMedia'); const importedRejected = assert.rejects(imported, { code: 'LICENSE_EXPIRED' });
  await entered.promise;
  const queued = f.service.call('saveTemplate', { name: 'Fila não pode salvar', items: [{ type: 'text', text: 'Persistência bloqueada' }] });
  const queuedRejected = assert.rejects(queued, { code: 'LICENSE_EXPIRED' });
  await f.expire(); release.resolve({ canceled: false, filePaths: [original] });
  await Promise.all([importedRejected, queuedRejected]);
  await f.read(store => { assert.equal(store.listMedia().length, 0); assert.equal(store.listTemplates().length, 0); });
});

test('backend internal callbacks cannot start work after expiration, but minimal preferences remain available', async t => {
  const f = await fixture(t); await f.setup(); await f.expire();
  for (const action of ['networkState', 'suspend', 'resume', 'emergencyStop']) await assert.rejects(f.service.systemCall(action, { online: true }), error => error.code === 'LICENSE_EXPIRED' && error.operation === `internal.${action}`);
  assert.deepEqual(await f.service.systemCall('settings'), { theme: 'dark', sound: { enabled: false }, notifications: { nativeEnabled: false } });
});

test('final transport guard rejects private submission if license expires while recipient resolution awaits', async t => {
  const f = await fixture(t); await f.setup(); const entered = deferred(), release = deferred();
  f.adapter.resolveSearchRecipient = async () => { entered.resolve(); await release.promise; return { jid: `${OWNER.phone}@s.whatsapp.net`, phone: OWNER.phone }; };
  const submission = f.adapter.sendSearchText(OWNER.phone, 'Resposta ainda não submetida', { replyContext: { isolated: true }, clientMessageId: 'NO-SUBMISSION-AFTER-EXPIRY' });
  const rejected = assert.rejects(submission, error => error.code === 'LICENSE_EXPIRED' && error.submitted === false);
  await entered.promise; await f.expire(); release.resolve(); await rejected;
  assert.equal(f.adapter.sent.length, 0); assert.equal(f.adapter.replies.length, 0);
});

test('submission already accepted may settle after expiry while all subsequent sends remain blocked', async t => {
  const f = await fixture(t); await f.setup();
  f.adapter.delayMs = 50;
  const submitted = f.adapter.sendPrivate(OWNER.phone, 'Envio aceito antes do vencimento', { clientMessageId: 'ALREADY-SUBMITTED-LATE' });
  assert.equal(f.adapter.sent.length, 1);
  await f.expire(); const late = await submitted;
  assert.equal(late.messageId, 'ALREADY-SUBMITTED-LATE'); assert.equal(late.status, 'confirmed'); assert.equal(late.simulation, true);
  assert.throws(() => f.adapter.sendPrivate(OWNER.phone, 'Não iniciar envio após vencer'), { code: 'LICENSE_EXPIRED' });
  assert.equal(f.adapter.sent.length, 1); assert.equal(f.service.snapshot().licenseOnly, true);
});

test('expired private WhatsApp commands produce no replies, new contact intake or administrative mutations', async t => {
  const f = await fixture(t); await f.setup();
  const campaign = f.service.snapshot().campaigns[0];
  await f.service.call('activateCampaign', { id: campaign.id, configRevision: campaign.configRevision });
  await f.expire();
  for (const text of ['!mega ajuda', '!mega menu', '!mega status', '!mega parar tudo', '!busca', '!busca iPhone 15 Pro Max 256GB']) {
    f.adapter.injectIncoming({ messageId: randomUUID(), senderId: `${OWNER.phone}@s.whatsapp.net`, senderNumber: OWNER.phone, chatId: `${OWNER.phone}@s.whatsapp.net`, identityVerified: true, verified: true, isGroup: false, forwarded: false, fromMe: false, type: 'text', text, timestamp: f.clock.now });
  }
  await tick(); await tick();
  assert.equal(f.adapter.replies.length, 0); assert.equal(f.adapter.sent.length, 0);
  await f.read(store => { assert.deepEqual(store.getSetting('recentCommandIds', []), []); assert.equal(store.listEntities('contact_pending').length, 0); assert.equal(store.getCampaign(campaign.id).state, 'stopped'); });
  assert.throws(() => f.adapter.reply(`${OWNER.phone}@s.whatsapp.net`, 'Tentativa direta interna'), { code: 'LICENSE_EXPIRED' });
  assert.throws(() => f.adapter.send('sim-01@simulation', { type: 'text', text: 'Tentativa direta interna' }, null), { code: 'LICENSE_EXPIRED' });
});

test('confirmed expiry latch persists across reopen and a subsequent service outage never unlocks data', async t => {
  const f = await fixture(t); await f.setup(); await f.expire();
  await f.read(store => assert.equal(store.getSetting('licenseConfirmedExpired'), true));
  await f.close(); f.licence.set(unavailable); await f.open();
  const status = await f.service.call('licenseStatus'); assert.equal(status.status, 'expired'); assert.equal(status.totalBlocked, true); assert.equal(status.reasonCode, 'LICENSE_EXPIRED');
  assert.equal(f.service.snapshot().licenseOnly, true);
  await assert.rejects(f.service.call('login', { username: OWNER.username, password: PASSWORD }), { code: 'LICENSE_EXPIRED' });
  await assert.rejects(f.service.call('backup'), { code: 'LICENSE_EXPIRED' });
  await f.service.call('licenseActivate', { key: 'ISOLATED-RENEWAL-FIXTURE' });
  await f.service.call('login', { username: OWNER.username, password: PASSWORD });
  assert.equal(f.service.snapshot().licenseOnly, undefined); assert.equal(f.service.snapshot().automation.stopped, true);
  await f.read(store => assert.equal(store.getSetting('licenseConfirmedExpired'), false));
});

test('valid offline grace preserves access and active campaign instead of falsely declaring expiry', async t => {
  const f = await fixture(t); await f.setup();
  const campaign = f.service.snapshot().campaigns[0]; await f.service.call('activateCampaign', { id: campaign.id, configRevision: campaign.configRevision });
  f.licence.set({ allowed: true, status: 'offline_grace', reasonCode: null, expiresAt: f.clock.now + 86400000, offlineUntil: f.clock.now + 3600000 });
  await f.service.systemCall('licenseChanged');
  const snapshot = f.service.snapshot(); assert.equal(snapshot.license.totalBlocked, false); assert.equal(snapshot.licenseOnly, undefined);
  assert.equal(snapshot.automation.stopped, false); assert.equal(snapshot.campaigns[0].state, 'active');
  assert.equal((await f.service.call('listContacts')).length, 0);
  await f.read(store => assert.equal(store.getSetting('licenseConfirmedExpired', false), false));
});

test('unconfirmed service outage stops submissions without becoming confirmed expiry or exposing licence-only latch', async t => {
  const f = await fixture(t); await f.setup(); f.licence.set(unavailable); await f.service.systemCall('licenseChanged');
  const snapshot = f.service.snapshot(); assert.equal(snapshot.license.status, 'network_required'); assert.equal(snapshot.license.totalBlocked, false); assert.equal(snapshot.licenseOnly, undefined); assert.equal(snapshot.automation.stopped, true);
  assert.equal((await f.service.call('listContacts')).length, 0);
  await assert.rejects(f.service.call('testAlert'), { code: 'LICENSE_CONNECTION_REQUIRED' });
  await f.read(store => assert.equal(store.getSetting('licenseConfirmedExpired', false), false));
});

test('renewal restores access but preserves stopped campaigns and paused reminders until explicit individual activation', async t => {
  const f = await fixture(t); await f.setup(); const initial = f.service.snapshot(), campaign = initial.campaigns[0];
  await f.service.call('activateCampaign', { id: campaign.id, configRevision: campaign.configRevision });
  const reminder = await f.service.call('saveReminder', { title: 'Não retomar silenciosamente', time: '23:59', repeat: 'daily', recipientId: `user:${initial.auth.user.id}`, enabled: true });
  await f.expire({ reasonCode: 'LICENSE_TRIAL_EXPIRED' });
  await f.service.call('licenseActivate', { key: 'ISOLATED-RENEWAL-FIXTURE' });
  let snapshot = f.service.snapshot(); assert.equal(snapshot.license.autoResumeRequired, true); assert.equal(snapshot.automation.stopped, true); assert.equal(snapshot.campaigns[0].state, 'stopped'); assert.equal(snapshot.reminders.items.find(item => item.id === reminder.id).state, 'paused');
  await f.service.call('resumeAutomation'); snapshot = f.service.snapshot(); assert.equal(snapshot.automation.stopped, false); assert.equal(snapshot.license.autoResumeRequired, false); assert.equal(snapshot.campaigns[0].state, 'stopped'); assert.equal(snapshot.reminders.items.find(item => item.id === reminder.id).state, 'paused');
  await f.close(); await f.open(); await f.service.call('login', { username: OWNER.username, password: PASSWORD });
  snapshot = f.service.snapshot(); assert.equal(snapshot.campaigns[0].state, 'stopped'); assert.equal(snapshot.reminders.items.find(item => item.id === reminder.id).state, 'paused');
});

test('confirmed-expired launch before login permits activation but not setup, login or private data', async t => {
  const f = await fixture(t, { authority: createLicenseFixture({ state: expired }) });
  const status = await f.service.call('authStatus'); assert.equal(status.setupRequired, true); assert.equal(status.authenticated, false); assert.equal(status.user, null); assert.deepEqual(status.permissions, []);
  await assert.rejects(f.service.call('setupOwner', OWNER), { code: 'LICENSE_EXPIRED' });
  await assert.rejects(f.service.call('login', { username: OWNER.username, password: PASSWORD }), { code: 'LICENSE_EXPIRED' });
  assert.equal((await f.service.call('licenseStatus')).totalBlocked, true);
  await f.service.call('licenseActivate', { key: 'ISOLATED-FIRST-ACTIVATION' });
  await f.setup(); assert.equal(f.service.snapshot().auth.authenticated, true); assert.equal(f.service.snapshot().automation.stopped, true);
});

test('late native confirmation records only an existing notification after expiry without creating or sending work', async t => {
  const f = await fixture(t); await f.setup(); await f.close();
  await f.read(store => store.saveNotification({ id: 'known-native-notification', at: f.clock.now, title: 'Operação já iniciada', nativeStatus: 'pending' }));
  f.licence.set({ ...expired, expiresAt: f.clock.now - 1 }); await f.open();
  assert.equal(await f.service.systemCall('nativeNotificationResult', { id: 'known-native-notification', status: 'shown' }), true);
  assert.equal(await f.service.systemCall('nativeNotificationResult', { id: 'unknown-notification', status: 'shown' }), true);
  await f.read(store => { const known = store.getEntity('notifications', 'known-native-notification'); assert.equal(known.nativeStatus, 'shown'); assert.equal(known.nativeResultAt, f.clock.now); assert.equal(store.getEntity('notifications', 'unknown-notification'), undefined); });
  assert.equal(f.service.snapshot().licenseOnly, true); assert.equal(f.adapter.replies.length, 0);
});

