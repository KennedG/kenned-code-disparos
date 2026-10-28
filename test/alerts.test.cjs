'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AlertService, alertText } = require('../src/core/alerts.cjs');
const copy = value => value === undefined ? undefined : structuredClone(value);

function fixture({ connected = true, privateSend, webhook, settings = {}, users = [], timerDeps = {} } = {}) {
  const clock = { value: Date.parse('2026-10-01T12:00:00Z') };
  const tables = new Map();
  const campaigns = new Map([['c1', { id: 'c1', name: 'Ofertas', state: 'active', configRevision: 1, ownerId: 'u1', responsibleUserIds: ['u2'], alertRecipientIds: ['r1'], retryPolicy: { maxAttempts: 2, delaySeconds: 5 } }]]);
  const prefs = new Map(Object.entries(settings));
  const store = {
    persistenceFailed: false,
    getSetting: (key, fallback) => prefs.has(key) ? copy(prefs.get(key)) : fallback,
    getCampaign: id => copy(campaigns.get(id)), listCampaigns: () => [...campaigns.values()].map(copy),
    saveCampaign: c => { campaigns.set(c.id, copy(c)); return copy(c); },
    listJobs: () => [],
    saveEntity: (table, value) => { if (!tables.has(table)) tables.set(table, new Map()); tables.get(table).set(value.id, copy(value)); return copy(value); },
    getEntity: (table, id) => copy(tables.get(table)?.get(id)),
    listEntities: table => [...(tables.get(table)?.values() || [])].map(copy),
    addAudit: record => store.saveEntity('audit', record), addDiagnostic: record => store.saveEntity('diagnostics', record)
  };
  store.saveEntity('alert_recipients', { id: 'r1', name: 'Dono', phone: '5511999999999', enabled: true });
  for (const u of users) store.saveEntity('users', u);
  const adapter = new EventEmitter();
  adapter.status = { state: connected ? 'connected' : 'disconnected', mode: 'simulated' };
  adapter.minimumSpacingSeconds = 3;
  const calls = [];
  adapter.sendPrivate = async (phone, text, options) => {
    const durable = store.listEntities('alerts').find(x => x.messageId === options.clientMessageId);
    assert.equal(durable.status, 'sending');
    calls.push({ phone, text, options, at: clock.value });
    return privateSend ? privateSend({ phone, text, options, clock, store, adapter, calls }) : { status: 'confirmed', messageId: options.clientMessageId };
  };
  const scheduler = new EventEmitter();
  scheduler.lastSubmissionAt = null; scheduler.persistenceFailed = false; scheduler.holds = 0;
  scheduler.holdSubmissions = () => { scheduler.holds++; return () => scheduler.holds--; };
  scheduler.waitForIdle = async () => {};
  scheduler.blockOnPersistenceFailure = () => { scheduler.persistenceFailed = true; };
  scheduler.resume = async id => store.saveCampaign({ ...store.getCampaign(id), state: 'active', pauseReason: null });
  const resumes = [];
  const resume = scheduler.resume;
  scheduler.resume = async id => { resumes.push(id); return resume(id); };
  adapter.connect = async () => { adapter.status = { state: 'connected' }; adapter.emit('status', adapter.status); };
  const local = [];
  const service = new AlertService({ store, scheduler, adapter, now: () => clock.value, sleep: async ms => { clock.value += ms; }, sendWebhook: webhook, secretGet: async () => 'credential-never-in-logs', ...timerDeps });
  service.on('localAlert', x => local.push(copy(x)));
  const incident = { id: 'occurrence-one', campaignId: 'c1', campaignName: 'Ofertas', at: clock.value, code: 'WA_SEND_FAILED', kind: 'fatal', reason: 'Limite de tentativas atingido.', confirmed: 12, pending: 3 };
  return { store, scheduler, adapter, service, clock, calls, local, incident, resumes, tables, prefs };
}

test('one occurrence queues one alert per distinct authorized recipient and uses the original failure time', async () => {
  const f = fixture({ connected: false, users: [
    { id: 'u1', roleId: 'role-owner', active: true, phone: '5511999999999' },
    { id: 'u2', roleId: 'role-manager', active: true, phone: '5521999999999' },
    { id: 'u3', roleId: 'role-owner', active: false, phone: '5531999999999' }
  ] });
  f.store.saveCampaign({ ...f.store.getCampaign('c1'), state: 'stopped', lastError: f.incident });
  f.service.recordIncident(f.incident); f.service.recordIncident(f.incident); await f.service.flush();
  assert.equal(f.local.length, 1); assert.equal(f.calls.length, 0);
  const alerts = f.store.listEntities('alerts'); assert.equal(alerts.length, 2); assert(alerts.every(x => x.status === 'pending'));
  assert(alerts[0].text.includes('✅ Envios confirmados: 12')); assert(alerts[0].text.includes('⏳ Pendentes: 3'));
  assert(alerts.every(x => x.originalAt === f.incident.at));
  await f.service.shutdown();
});

test('reconnection flushes pending alerts sequentially with server confirmation and preserves failure timestamp', async () => {
  const f = fixture({ connected: false, users: [{ id: 'u2', roleId: 'role-manager', active: true, phone: '5521999999999' }] });
  f.service.start(); f.service.recordIncident(f.incident); await f.service.flush();
  f.clock.value += 3600000; f.adapter.status = { state: 'connected' }; f.adapter.emit('status', f.adapter.status); await f.service.flush();
  assert.equal(f.calls.length, 2); assert(f.calls[1].at - f.calls[0].at >= 3000);
  assert(f.store.listEntities('alerts').every(x => x.status === 'confirmed' && x.originalAt === f.incident.at));
  assert.equal(f.scheduler.holds, 0); await f.service.shutdown();
});

test('ambiguous alert result never retries; late ACK reconciles only its durable message identifier', async () => {
  const f = fixture({ privateSend: ({ options }) => ({ status: 'uncertain', messageId: options.clientMessageId }) });
  f.service.start(); f.service.recordIncident(f.incident); await f.service.flush(); await f.service.flush();
  assert.equal(f.calls.length, 1); const alert = f.store.listEntities('alerts')[0]; assert.equal(alert.status, 'uncertain');
  f.adapter.emit('receipt', { status: 'confirmed', messageId: 'OTHER_ID' }); assert.equal(f.store.getEntity('alerts', alert.id).status, 'uncertain');
  f.adapter.emit('receipt', { status: 'confirmed', messageId: alert.messageId }); assert.equal(f.store.getEntity('alerts', alert.id).status, 'confirmed');
  await f.service.shutdown();
});

test('a crash during alert submission recovers to uncertain and never performs a second network request', async () => {
  const f = fixture();
  f.store.saveEntity('alerts', { id: 'old', status: 'sending', messageId: 'DURABLE_OLD', channel: 'whatsapp', attempts: 1, number: '5511999999999', createdAt: f.clock.value });
  f.service.start(); f.service.start(); await f.service.flush();
  assert.equal(f.store.getEntity('alerts', 'old').status, 'uncertain'); assert.equal(f.calls.length, 0);
  assert.equal(f.adapter.listenerCount('status'), 1); assert.equal(f.scheduler.listenerCount('incident'), 1);
  await f.service.shutdown(); assert.equal(f.adapter.listenerCount('status'), 0);
});

test('only safe presubmission alert failures retry using bounded configurable delays and the same identifier', async () => {
  const f = fixture({ privateSend: () => { throw Object.assign(new Error('private-secret'), { safeToRetry: true, code: 'WA_TEMPORARY' }); } });
  f.service.recordIncident(f.incident); await f.service.flush();
  let alert = f.store.listEntities('alerts')[0]; assert.equal(alert.status, 'pending'); assert.equal(f.calls.length, 1);
  await f.service.flush(); assert.equal(f.calls.length, 1);
  f.clock.value += 5000; await f.service.flush(); alert = f.store.listEntities('alerts')[0];
  assert.equal(alert.status, 'failed'); assert.equal(f.calls.length, 2); assert.equal(f.calls[0].options.clientMessageId, f.calls[1].options.clientMessageId);
  assert(!JSON.stringify(f.store.listEntities('diagnostics')).includes('private-secret'));
  await f.service.shutdown();
});

test('private test uses the real transport path and an uncertain result requires an audited explicit review', async () => {
  const f = fixture({ privateSend: () => ({ status: 'uncertain' }) });
  const alert = await f.service.testRecipient('5511888888888', 'owner-1'); assert.equal(alert.status, 'uncertain');
  await assert.rejects(f.service.testRecipient('bad-phone', 'owner-1'), /telefone/);
  const reviewed = await f.service.resolveUncertain(alert.id, { confirmed: false, userId: 'owner-1' });
  assert.equal(reviewed.status, 'failed'); await f.service.flush(); assert.equal(f.calls.length, 1);
  assert.equal(f.store.listEntities('audit').length, 2); await f.service.shutdown();
});

test('disconnect notifications deduplicate a failure, omit manual disconnects and create a new occurrence after reconnection', async () => {
  const f = fixture(); f.service.start();
  const status = { state: 'disconnected', reasonCode: 'internet', retryable: true, at: new Date(f.clock.value).toISOString(), errorCode: 'WA_NETWORK' };
  f.adapter.status = status; f.adapter.emit('status', status); f.adapter.emit('status', status);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.local.length, 1); assert.equal(f.local[0].event, 'disconnect'); assert.equal(f.local[0].at, f.clock.value);
  assert(f.local[0].reason.includes('internet'));
  f.adapter.status = { state: 'connected' }; f.adapter.emit('status', f.adapter.status); await new Promise(resolve => setImmediate(resolve));
  f.adapter.status = { state: 'disconnected', reasonCode: 'manual', manual: true }; f.adapter.emit('status', f.adapter.status);
  assert.equal(f.local.length, 1);
  f.adapter.status = { state: 'connected' }; f.adapter.emit('status', f.adapter.status); await new Promise(resolve => setImmediate(resolve));
  f.adapter.status = status; f.adapter.emit('status', status); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.local.length, 2); assert.notEqual(f.local[0].occurrenceId, f.local[1].occurrenceId); await f.service.shutdown();
});

test('automatic resume is opt-in and only resumes previously active unchanged connection-paused campaigns', async () => {
  const f = fixture({ settings: { reconnect: { enabled: false, autoResume: true } } });
  f.service.start();
  f.store.saveCampaign({ ...f.store.getCampaign('c1'), state: 'paused', pauseReason: 'Conexão indisponível: disconnected.' });
  f.adapter.status = { state: 'disconnected', reasonCode: 'unexpected' }; f.adapter.emit('status', f.adapter.status);
  await new Promise(resolve => setImmediate(resolve));
  f.adapter.status = { state: 'connected' }; f.adapter.emit('status', f.adapter.status); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.resumes, ['c1']);
  f.adapter.status = { state: 'disconnected', reasonCode: 'unexpected' }; f.adapter.emit('status', f.adapter.status);
  f.store.saveCampaign({ ...f.store.getCampaign('c1'), state: 'paused', configRevision: 2, pauseReason: 'Conexão indisponível: disconnected.' });
  f.adapter.status = { state: 'connected' }; f.adapter.emit('status', f.adapter.status); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.resumes, ['c1']); await f.service.shutdown();
});

test('independent HTTPS channel is marked channel acceptance and works while WhatsApp is disconnected', async () => {
  const seen = [];
  const f = fixture({ connected: false, settings: { independentAlertChannel: { enabled: true, url: 'https://alerts.example.test/events', secretId: 'webhook-token' } }, webhook: async request => { seen.push(request); return { status: 'confirmed' }; } });
  f.service.recordIncident(f.incident); await f.service.flush();
  assert.equal(seen.length, 1); assert.equal(f.calls.length, 0);
  const alerts = f.store.listEntities('alerts'); assert.equal(alerts.find(x => x.channel === 'webhook').confirmationScope, 'channel-accepted');
  assert.equal(alerts.find(x => x.channel === 'whatsapp').status, 'pending'); assert.equal(seen[0].originalAt, f.incident.at);
  assert(!JSON.stringify(alerts).includes('credential-never-in-logs')); await f.service.shutdown();
});

test('notification muting persists and cleanup does not recreate the local occurrence on restart', async () => {
  const f = fixture({ connected: false });
  f.store.saveCampaign({ ...f.store.getCampaign('c1'), state: 'stopped', lastError: f.incident });
  f.service.recordIncident(f.incident); await f.service.flush();
  const notification = f.local[0]; f.service.muteOccurrence(notification.id);
  assert.equal(f.store.getEntity('notifications', notification.id).muted, true);
  f.tables.get('notifications').clear(); await f.service.shutdown();
  const restart = new AlertService({ store: f.store, scheduler: f.scheduler, adapter: f.adapter, now: () => f.clock.value });
  const local = []; restart.on('localAlert', x => local.push(x)); restart.start(); await restart.flush();
  assert.equal(local.length, 0); assert.equal(f.store.listEntities('alerts').length, 1); await restart.shutdown();
});

test('alert message exposes campaign outcome counts without credentials', () => {
  const text = alertText({ at: Date.now(), campaignName: 'Ofertas', code: 'E1', confirmed: 10, pending: 2, reason: 'Falha segura.' });
  assert(text.startsWith('🚨 Campanha interrompida por erro')); assert(text.includes('✅ Envios confirmados: 10')); assert(text.includes('Acesse o sistema'));
});

test('automatic reconnection obeys a finite attempt limit and never reconnects an expired or manual session', async () => {
  const timers = new Map(); let sequence = 0;
  const f = fixture({ settings: { reconnect: { enabled: true, maxAttempts: 2, delaySeconds: 4, autoResume: false } }, timerDeps: {
    setTimer: (callback, delay) => { assert.equal(delay, 4000); const handle = { id: ++sequence, unref() {} }; timers.set(handle, callback); return handle; },
    clearTimer: handle => timers.delete(handle)
  } });
  let attempts = 0; f.adapter.connect = async () => { attempts++; throw new Error('Network still unavailable'); };
  f.service.start();
  f.adapter.status = { state: 'disconnected', reasonCode: 'internet', retryable: true }; f.adapter.emit('status', f.adapter.status);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(timers.size, 1);
  for (let i = 0; i < 2; i++) {
    const [handle, callback] = timers.entries().next().value; timers.delete(handle); callback();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(attempts, 2); assert.equal(timers.size, 0);
  f.adapter.status = { state: 'connected' }; f.adapter.emit('status', f.adapter.status); await new Promise(resolve => setImmediate(resolve));
  f.adapter.status = { state: 'disconnected', reasonCode: 'session_expired', retryable: false }; f.adapter.emit('status', f.adapter.status);
  assert.equal(timers.size, 0); assert(f.local.at(-1).reason.includes('expirou'));
  f.adapter.status = { state: 'disconnected', reasonCode: 'manual', manual: true }; f.adapter.emit('status', f.adapter.status);
  assert.equal(timers.size, 0); await f.service.shutdown();
});

test('uncertain sends and an explicit manual pause are never automatically resumed', async () => {
  const f = fixture({ settings: { reconnect: { enabled: false, autoResume: true } } });
  f.service.start();
  f.adapter.status = { state: 'disconnected', reasonCode: 'unexpected' }; f.adapter.emit('status', f.adapter.status);
  f.store.saveCampaign({ ...f.store.getCampaign('c1'), state: 'paused', pauseReason: 'Conexão indisponível: disconnected.' });
  f.store.listJobs = () => [{ id: 'uncertain', status: 'uncertain' }];
  f.adapter.status = { state: 'connected' }; f.adapter.emit('status', f.adapter.status); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.resumes.length, 0);
  f.store.listJobs = () => [];
  f.store.saveCampaign({ ...f.store.getCampaign('c1'), state: 'active' }); f.scheduler.emit('change');
  f.adapter.status = { state: 'disconnected', reasonCode: 'unexpected' }; f.adapter.emit('status', f.adapter.status);
  f.store.saveCampaign({ ...f.store.getCampaign('c1'), state: 'paused', pauseReason: 'Campanha pausada pelo administrador.' });
  f.adapter.status = { state: 'connected' }; f.adapter.emit('status', f.adapter.status); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.resumes.length, 0); await f.service.shutdown();
});

test('storage poisoning creates one immediate local critical warning and blocks all private submissions', async () => {
  const f = fixture(); f.service.start(); f.store.persistenceFailed = true; f.scheduler.persistenceFailed = true;
  f.scheduler.emit('change', { error: 'Envios bloqueados.' }); f.scheduler.emit('change', { error: 'Envios bloqueados.' });
  await f.service.flush(); assert.equal(f.calls.length, 0); assert.equal(f.local.length, 1);
  assert.equal(f.local[0].event, 'critical'); assert.equal(f.local[0].occurrenceId, 'storage-failure'); await f.service.shutdown();
});

test('zero automatic reconnect attempts means zero socket attempts even when reconnect is enabled', async () => {
  let scheduled = 0;
  const f = fixture({ settings: { reconnect: { enabled: true, maxAttempts: 0, delaySeconds: 3 } }, timerDeps: { setTimer: () => { scheduled++; return { unref() {} }; }, clearTimer() {} } });
  f.service.start(); f.adapter.status = { state: 'disconnected', reasonCode: 'internet', retryable: true }; f.adapter.emit('status', f.adapter.status);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(scheduled, 0); assert.equal(f.service.reconnectAttempts, 0);
  await f.service.shutdown();
});

test('an automatic connection attempt waits for handshake or QR instead of recreating the socket on a timer', async () => {
  const timers = new Map(); let sequence = 0, attempts = 0;
  const f = fixture({ settings: { reconnect: { enabled: true, maxAttempts: 3, delaySeconds: 3 } }, timerDeps: {
    setTimer: callback => { const handle = { id: ++sequence, unref() {} }; timers.set(handle, callback); return handle; }, clearTimer: handle => timers.delete(handle)
  } });
  f.adapter.connect = async () => { attempts++; f.adapter.status = { state: 'connecting' }; f.adapter.emit('status', f.adapter.status); };
  f.service.start(); f.adapter.status = { state: 'disconnected', reasonCode: 'internet', retryable: true }; f.adapter.emit('status', f.adapter.status);
  const [handle, callback] = timers.entries().next().value; timers.delete(handle); callback(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1); assert.equal(timers.size, 0);
  f.adapter.status = { state: 'qr' }; f.adapter.emit('status', f.adapter.status); await new Promise(resolve => setImmediate(resolve)); assert.equal(timers.size, 0);
  f.adapter.status = { state: 'disconnected', reasonCode: 'unexpected', retryable: true }; f.adapter.emit('status', f.adapter.status); await new Promise(resolve => setImmediate(resolve)); assert.equal(timers.size, 1);
  await f.service.shutdown(); assert.equal(timers.size, 0);
});

test('pending alerts use bounded indexed batches and concurrent flush calls share one network worker', async () => {
  let release;
  const f = fixture({ privateSend: async ({ options }) => {
    if (f.calls.length === 1) await new Promise(resolve => { release = resolve; });
    return { status: 'confirmed', messageId: options.clientMessageId };
  } });
  for (let i = 0; i < 65; i++) f.store.saveEntity('alerts', { id: `queued-${i}`, status: 'pending', number: '5511999999999', channel: 'whatsapp', messageId: `MSG${i}`, text: 'Alerta de teste', attempts: 0, createdAt: f.clock.value + i, nextAttemptAt: f.clock.value });
  const requested = [];
  f.store.listPendingAlerts = ({ at, limit, channel }) => { requested.push({ limit, channel }); return f.store.listEntities('alerts').filter(a => a.status === 'pending' && a.nextAttemptAt <= at && (!channel || a.channel === channel)).sort((a, b) => a.createdAt - b.createdAt).slice(0, limit); };
  f.store.listAlerts = () => { throw new Error('Unbounded alert history query must not occur'); };
  const first = f.service.flush(); const concurrent = f.service.flush(); assert.equal(first, concurrent);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, 1); assert.equal(f.scheduler.holds, 1);
  release(); await first; assert.equal(f.calls.length, 50); assert.equal(f.scheduler.holds, 0);
  await f.service.flush(); assert.equal(f.calls.length, 65); assert(requested.every(r => r.limit === 50));
  assert.equal(new Set(f.calls.map(c => c.options.clientMessageId)).size, 65); await f.service.shutdown();
});
