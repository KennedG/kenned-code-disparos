'use strict';

// Independent review: production backend and SQLite, deterministic clock and
// controlled transports. These tests do not assert real WhatsApp/Windows delivery.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createAppService } = require('../src/backend/service.cjs');
const { createStore } = require('../src/core/store.cjs');
const { Scheduler } = require('../src/core/scheduler.cjs');
const { SimulatedAdapter } = require('../src/adapters/simulated.cjs');
const { computerDateKey } = require('../src/core/computer-schedule.cjs');
const { createLicenseFixture } = require('./fixtures/license.cjs');

const local = (hour, minute = 0, day = 13) => new Date(2026, 9, day, hour, minute).getTime();
const PASSWORD = 'Independent-Recovery-Review-2026!';
const OWNER = { name: 'Dono de teste isolado', username: 'review-owner', phone: '5562999990001', password: PASSWORD };
const settle = () => new Promise(resolve => setImmediate(resolve));

async function backend(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-backend-recovery-review-'));
  const clock = { at: local(7, 40) };
  const authority = createLicenseFixture({ clock: () => clock.at });
  let scheduler, adapter, service;
  const savedStart = Scheduler.prototype.start, savedConnect = SimulatedAdapter.prototype.connect;
  Scheduler.prototype.start = function () { scheduler = this; };
  SimulatedAdapter.prototype.connect = async function (...args) { adapter = this; return savedConnect.apply(this, args); };
  try {
    service = await createAppService({ dir, version: '2.3.2', runtimePlatform: 'linux', now: () => clock.at, licenseService: authority,
      host: async action => action === 'localAlert' ? { nativeStatus: 'unsupported', soundStatus: 'disabled' } : { canceled: true } });
  } finally { Scheduler.prototype.start = savedStart; SimulatedAdapter.prototype.connect = savedConnect; }
  t.after(async () => { await service.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
  await service.call('setupOwner', OWNER);
  const original = service.snapshot().campaigns[0];
  const campaign = await service.call('saveCampaign', { campaign: { ...original, name: 'Grade independente', groupIds: [original.groupIds[0]],
    intervalMinutes: 10, spacingSeconds: 3, schedule: { days: [0,1,2,3,4,5,6], startTime: '08:00', endTime: '18:00' },
    items: [{ id: 'review-text', type: 'text', text: 'Conteúdo de teste; nenhum envio real.' }] } });
  const activate = async () => { const c = service.snapshot().campaigns.find(row => row.id === campaign.id); return service.call('activateCampaign', { id: c.id, configRevision: c.configRevision, summaryState: c.state }); };
  const current = () => service.snapshot().campaigns.find(row => row.id === campaign.id);
  const disconnect = async () => { adapter._status('disconnected', 'Queda controlada', { reasonCode: 'unexpected', manual: false, retryable: true }); await settle(); };
  const connect = async () => { await adapter.connect(); await settle(); };
  return { service, authority, clock, scheduler, adapter, campaign, activate, current, disconnect, connect };
}

test('backend respects saved autoResume:false after reconnect, clock change and computer resume', async t => {
  const f = await backend(t);
  await f.service.call('saveSettings', { settings: { reconnect: { enabled: false, autoResume: false, maxAttempts: 3, delaySeconds: 5, maxDelaySeconds: 120 } } });
  await f.activate(); await f.disconnect();
  f.clock.at = local(8, 7); await f.connect();
  assert.equal(f.current().state, 'paused');
  await f.service.systemCall('clockChanged', { reason: 'timezone_changed' });
  assert.equal(f.current().state, 'paused', 'clock observation must not override the saved recovery policy');
  await f.service.systemCall('resume');
  assert.equal(f.current().state, 'paused', 'Windows resume must not override the saved recovery policy');
  assert.equal(f.current().nextRunAt, null);
});

test('backend automatic recovery schedules the next grid slot and never resumes manual pause', async t => {
  const f = await backend(t);
  await f.activate(); await f.disconnect();
  f.clock.at = local(8, 7); await f.connect();
  assert.equal(f.current().state, 'active'); assert.equal(f.current().nextRunAt, local(8, 10));
  await f.scheduler.tick(); assert.equal(f.adapter.sent.filter(row => row.groupId).length, 0);
  await f.service.call('pauseCampaign', { id: f.campaign.id });
  await f.disconnect(); await f.connect(); await f.service.systemCall('clockChanged', { reason: 'clock_changed' });
  assert.equal(f.current().state, 'paused'); assert.equal(f.current().executionRecovery, null);
  assert.equal(f.current().nextRunAt, null);
});

test('manual disconnect revokes recovery even when the error had already paused the campaign', async t => {
  const f = await backend(t);
  await f.activate(); await f.disconnect();
  assert.equal(f.current().state, 'paused'); assert.equal(f.current().executionRecovery.eligible, true);
  await f.service.call('disconnect');
  assert.equal(f.current().executionRecovery, null, 'manual disconnection revokes the earlier technical recovery authorization');
  f.clock.at = local(8, 7); await f.service.call('connect'); await settle();
  assert.equal(f.current().state, 'paused'); assert.equal(f.current().nextRunAt, null);
  await f.scheduler.tick(); assert.equal(f.adapter.sent.filter(row => row.groupId).length, 0);
});

test('backend licence renewal and global-stop resumption do not grant campaign recovery authorization', async t => {
  const f = await backend(t); await f.activate(); await f.disconnect();
  f.authority.set({ allowed: false, status: 'expired', reasonCode: 'LICENSE_EXPIRED', expiresAt: f.clock.at - 1 });
  await f.service.systemCall('licenseChanged');
  await assert.rejects(f.service.systemCall('clockChanged', { reason: 'clock_changed' }), /licen|venc|renov/i);
  await f.service.call('licenseActivate', { key: 'ISOLATED-FIXTURE-NOT-A-REAL-KEY' });
  f.clock.at = local(8, 7); await f.connect();
  assert.equal(f.current().state, 'stopped');
  await f.service.call('resumeAutomation'); await f.service.systemCall('resume');
  assert.equal(f.current().state, 'stopped'); assert.equal(f.current().nextRunAt, null);
  await f.activate(); await f.service.call('stopAll');
  await f.disconnect(); await f.connect(); await f.service.systemCall('clockChanged', { reason: 'timezone_changed' });
  assert.equal(f.current().state, 'stopped');
  assert.equal(f.service.snapshot().automation.stopped, true);
  assert.equal(f.adapter.sent.filter(row => row.groupId).length, 0);
});

test('new capture and connection RPCs enforce backend permissions and expiry before running', async t => {
  const f = await backend(t);
  await f.service.call('createUser', { user: { name: 'Vendedor restrito', username: 'review-seller', password: PASSWORD,
    roleId: 'role-seller', requirePasswordChange: false, campaignScope: 'own' } });
  await f.service.call('logout'); await f.service.call('login', { username: 'review-seller', password: PASSWORD });
  for (const action of ['sourceTestCapture','sourceSyncNow','testSearchCapture','synchronizeSearchCapture','testConnection'])
    await assert.rejects(f.service.call(action, {}), /permiss|acesso/i, action);
  await f.service.call('logout'); await f.service.call('login', { username: OWNER.username, password: PASSWORD });
  f.authority.set({ allowed: false, status: 'expired', reasonCode: 'LICENSE_EXPIRED', expiresAt: f.clock.at - 1 });
  await f.service.systemCall('licenseChanged');
  for (const action of ['sourceTestCapture','sourceSyncNow','testSearchCapture','synchronizeSearchCapture','testConnection'])
    await assert.rejects(f.service.call(action, {}), /licen|venc|renov/i, action);
});

test('SQLite restart retains the total attempt budget of one interrupted job', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-retry-budget-review-'));
  let store, scheduler;
  t.after(async () => { if (scheduler) await scheduler.shutdown(); store?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let at = local(8, 3); store = await createStore(dir); store.setSetting('integrationMode', 'simulated');
  const groupId = 'retry-review@simulation', item = { id: 'retry-item', type: 'text', text: 'Mensagem do teste controlado.' };
  store.upsertGroups([{ id: groupId, name: 'Grupo fictício isolado', authorized: true, simulation: true }]);
  const campaign = store.saveCampaign({ id: 'retry-campaign', name: 'Tentativas persistentes', storageMode: 'simulated', state: 'paused', mode: 'repeat',
    intervalMinutes: 10, spacingSeconds: 3, groupIds: [groupId], groupOverrides: {}, items: [item],
    retryPolicy: { maxAttempts: 3, delaySeconds: 3 }, schedule: { days: [0,1,2,3,4,5,6], startTime: '08:00', endTime: '18:00' },
    roundIndex: 1, nextRunAt: null, executionAuthorization: { manual: true, at: local(8), dateKey: computerDateKey(at) },
    executionPendingRoundId: 'retry-round', executionRecovery: { kind: 'connection', eligible: true, roundId: 'retry-round' } });
  store.insertRound({ id: 'retry-round', campaignId: campaign.id, startedAt: local(8), scheduledAt: local(8), finishedAt: at, status: 'interrupted' });
  store.insertJob({ id: 'retry-job', operationId: `${campaign.id}:retry-round:${groupId}:${item.id}`, campaignId: campaign.id, roundId: 'retry-round',
    groupId, itemId: item.id, itemSnapshot: item, status: 'queued', attempts: 2, createdAt: local(8), firstAttemptAt: local(8),
    clientMessageId: 'REVIEW-RETRY-CLIENT', messageId: 'REVIEW-RETRY-CLIENT', resultAt: null });
  store.close(); store = await createStore(dir);
  const adapter = new EventEmitter(); adapter.status = { state: 'connected', ready: true, mode: 'simulated' }; adapter.minimumSpacingSeconds = 3;
  let attempts = 0;
  adapter.send = async (_group, _item, _media, options) => { options.beforeSubmit(); attempts++;
    throw Object.assign(new Error('Falha temporária confirmada antes de envio.'), { code: 'GROUP_TEST_TEMPORARY', definitive: true, submitted: false, safeToRetry: true, groupScoped: true }); };
  scheduler = new Scheduler({ store, adapter, now: () => at, sleep: async ms => { at += ms; } });
  await scheduler.recoverAfterRestart(); assert.equal(store.getCampaign(campaign.id).nextRunAt, local(8, 10));
  at = local(8, 10); await scheduler.tick();
  assert.equal(attempts, 1, 'only the third and final attempt remains after reopening');
  assert.equal(store.getJob('retry-job').attempts, 3);
  assert.equal(store.getJob('retry-job').status, 'failed');
  assert.equal(store.listRounds(campaign.id).length, 1);
});
