'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AlertService, alertText } = require('../src/core/alerts.cjs');
const copy = value => value === undefined ? undefined : structuredClone(value);

function fixture({ connected = true, mode = 'simulated', privateSend, webhook, settings = {}, users = [], timerDeps = {} } = {}) {
  const clock = { value: Date.parse('2026-10-01T12:00:00Z') };
  const tables = new Map();
  const campaigns = new Map([['c1', { id: 'c1', name: 'Ofertas', state: 'active', configRevision: 1, ownerId: 'u1', responsibleUserIds: ['u2'], alertRecipientIds: ['r1'], retryPolicy: { maxAttempts: 2, delaySeconds: 5 } }]]);
  const prefs = new Map(Object.entries(settings));
  const store = {
    persistenceFailed: false,
    getSetting: (key, fallback) => prefs.has(key) ? copy(prefs.get(key)) : fallback,
    setSetting: (key, value) => { prefs.set(key, copy(value)); return copy(value); },
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
  adapter.status = { state: connected ? 'connected' : 'disconnected', mode };
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
  const f = fixture({ connected: false, mode: 'whatsapp', settings: { independentAlertChannel: { enabled: true, url: 'https://alerts.example.test/events', secretId: 'webhook-token' } }, webhook: async request => { seen.push(request); return { status: 'confirmed' }; } });
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

test('disconnect immediately persists one local occurrence and private pending notices for owners and configured recipients', async () => {
  const f = fixture({ mode: 'whatsapp', users: [{ id: 'owner', roleId: 'role-owner', active: true, phone: '5521988888888' }] });
  f.service.start();
  f.adapter.status = { state: 'disconnected', mode: 'whatsapp', reasonCode: 'internet', at: f.clock.value, errorCode: 'NETWORK_OFFLINE' };
  f.adapter.emit('status', f.adapter.status); f.adapter.emit('status', f.adapter.status);
  await new Promise(resolve => setImmediate(resolve)); await f.service.flush();
  assert.equal(f.local.length, 1);
  let alerts = f.store.listEntities('alerts'); assert.equal(alerts.length, 2); assert.equal(f.calls.length, 0);
  assert(alerts.every(alert => alert.status === 'pending' && alert.originalAt === f.clock.value && alert.traceId === f.local[0].traceId));
  assert(alerts[0].text.includes('Ocorrência original:')); assert(alerts[0].text.includes('Kenned Code Disparos'));
  const failureTime = f.clock.value; f.clock.value += 3600000;
  f.adapter.status = { state: 'connected', mode: 'whatsapp' }; f.adapter.emit('status', f.adapter.status); await f.service.flush();
  alerts = f.store.listEntities('alerts'); assert.equal(f.calls.length, 2);
  assert(alerts.every(alert => alert.status === 'confirmed' && alert.originalAt === failureTime && alert.resultAt >= failureTime + 3600000));
  await f.service.shutdown();
});

test('global critical incidents use explicit system recipient selection and a separately recorded occurrence', async () => {
  const f = fixture({ connected: false, settings: { systemAlertRecipientIds: ['r2'] }, users: [{ id: 'owner', roleId: 'role-owner', active: true, phone: '5521988888888' }] });
  f.store.saveEntity('alert_recipients', { id: 'r2', enabled: true, phone: '5531988888888' });
  f.store.saveEntity('alert_recipients', { id: 'off', enabled: false, phone: '5541988888888' });
  const occurrence = { id: 'system-fatal', code: 'PROCESSING_FAILURE', at: f.clock.value, reason: 'Falha crítica no processamento.', event: 'critical' };
  const first = f.service.recordSystemIncident(occurrence); const second = f.service.recordSystemIncident(occurrence);
  await f.service.flush();
  assert.equal(first.traceId, occurrence.id); assert.equal(second.occurrenceId, first.occurrenceId);
  assert.equal(f.local.length, 1); assert.equal(f.store.listEntities('notifications').length, 1);
  const alerts = f.store.listEntities('alerts'); assert.deepEqual(alerts.map(a => a.number).sort(), ['5521988888888', '5531988888888']);
  const occurrenceLogs = f.store.listEntities('diagnostics').filter(d => d.stage === 'alerta.occurrence'); assert.equal(occurrenceLogs.length, 1);
  assert(alerts.every(a => a.traceId === occurrence.id && a.status === 'pending')); await f.service.shutdown();
});

test('per-recipient test and full alert test share the production occurrence notification and queue pipeline', async () => {
  const f = fixture({ connected: false });
  const one = await f.service.testRecipient('5511999999999', 'owner', { recipientId: 'r1' });
  assert.equal(one.status, 'pending'); assert.equal(f.local.length, 1); assert.equal(f.local[0].traceId, one.traceId);
  assert(one.text.includes('Kenned Code Disparos')); assert(!one.text.includes('Mega Disparos'));
  const all = await f.service.testAlert({ userId: 'owner', event: 'critical' });
  assert.equal(all.alerts.length, 1); assert.equal(all.alerts[0].status, 'pending'); assert.equal(f.local.length, 2);
  assert.equal(f.store.getCampaign('c1').state, 'active'); assert.equal(f.calls.length, 0);
  assert.equal(f.store.listEntities('audit').filter(a => a.action === 'alert.test').length, 2); await f.service.shutdown();
});

test('the own account recipient is resolved by the integration and confirmation is recorded only after transport acknowledgement', async () => {
  let resolved = 0, release;
  const f = fixture({ mode: 'whatsapp', privateSend: async ({ options }) => { await new Promise(resolve => { release = resolve; }); return { status: 'confirmed', messageId: options.clientMessageId }; } });
  f.adapter.resolveRecipient = async phone => { resolved++; assert.equal(phone, '5511999999999'); return { jid: '5511999999999@s.whatsapp.net', phone, isSelf: true, mode: 'whatsapp', simulation: false }; };
  const pending = f.service.testRecipient('5511999999999', 'owner');
  await new Promise(resolve => setImmediate(resolve));
  let alert = f.store.listEntities('alerts')[0]; assert.equal(alert.status, 'sending'); assert.equal(alert.isSelf, true); assert.equal(alert.targetId, '5511999999999@s.whatsapp.net'); assert.equal(alert.confirmationScope, undefined);
  release(); alert = await pending; assert.equal(alert.status, 'confirmed'); assert.equal(alert.confirmationScope, 'whatsapp-server'); assert.equal(resolved, 1);
  const stages = f.store.listEntities('diagnostics').filter(d => d.traceId === alert.traceId).map(d => d.stage);
  assert.deepEqual(stages, ['alerta.occurrence', 'alerta.queue', 'alerta.recipient', 'alerta.result']); await f.service.shutdown();
});

test('recipient resolution failures never submit and show an actionable reason without exposing provider secrets', async () => {
  const f = fixture({ mode: 'whatsapp' });
  f.adapter.resolveRecipient = async () => { throw Object.assign(new Error('token=provider-private-secret'), { code: 'RECIPIENT_NOT_REGISTERED', definitive: true }); };
  const alert = await f.service.testRecipient('5511999999999', 'owner');
  assert.equal(alert.status, 'failed'); assert.equal(alert.errorCode, 'RECIPIENT_NOT_REGISTERED'); assert.equal(alert.retryEligible, true); assert.match(alert.error, /país, DDD e número/); assert.equal(f.calls.length, 0);
  await f.service.flush(); assert.equal(f.calls.length, 0); assert.equal(f.store.getEntity('alerts', alert.id).attempts, 1);
  assert(!JSON.stringify(f.store.listEntities('diagnostics')).includes('provider-private-secret')); await f.service.shutdown();
});

test('known failed alerts support an explicit audited retry while uncertain and confirmed alerts reject it', async () => {
  let fail = true;
  const f = fixture({ privateSend: ({ options }) => { if (fail) throw Object.assign(new Error('Known rejection'), { definitive: true, code: 'RECIPIENT_NOT_REGISTERED' }); return { status: 'confirmed', messageId: options.clientMessageId }; } });
  const alert = await f.service.testRecipient('5511999999999', 'owner'); assert.equal(alert.status, 'failed'); assert.equal(alert.retryEligible, true);
  fail = false; const retried = await f.service.retryAlert(alert.id, { userId: 'owner' });
  assert.equal(retried.status, 'confirmed'); assert.equal(f.calls.length, 2); assert.equal(f.calls[0].options.clientMessageId, f.calls[1].options.clientMessageId);
  assert.equal(f.store.listEntities('audit').filter(a => a.action === 'alert.retry').length, 1);
  await assert.rejects(f.service.retryAlert(alert.id, { userId: 'owner' }), /incertos/);
  f.store.saveEntity('alerts', { id: 'uncertain-retry', status: 'uncertain', retryEligible: false });
  await assert.rejects(f.service.retryAlert('uncertain-retry', { userId: 'owner' }), /incertos/); await f.service.shutdown();
});

test('late delivered receipt reconciles uncertain or reviewed work without duplication and never degrades on a later server ACK', async () => {
  const f = fixture({ privateSend: ({ options }) => ({ status: 'uncertain', messageId: options.clientMessageId }) });
  f.service.start(); const alert = await f.service.testRecipient('5511999999999', 'owner');
  await f.service.resolveUncertain(alert.id, { confirmed: false, userId: 'owner' });
  f.adapter.emit('receipt', { status: 'confirmed', messageId: alert.messageId, confirmationScope: 'whatsapp-delivered', deliveredAt: f.clock.value + 30000 });
  let stored = f.store.getEntity('alerts', alert.id); assert.equal(stored.status, 'delivered'); assert.equal(stored.deliveredAt, f.clock.value + 30000); assert.equal(stored.retryEligible, false);
  f.adapter.emit('receipt', { status: 'confirmed', messageId: alert.messageId, confirmationScope: 'whatsapp-server' });
  stored = f.store.getEntity('alerts', alert.id); assert.equal(stored.status, 'delivered'); assert.equal(stored.confirmationScope, 'whatsapp-delivered');
  await assert.rejects(f.service.retryAlert(alert.id, { userId: 'owner' }), /incertos/); await f.service.flush(); assert.equal(f.calls.length, 1); await f.service.shutdown();
});

test('a receipt delivered during transport submission cannot be overwritten by a late uncertain transport result', async () => {
  const f = fixture({ privateSend: ({ options, adapter }) => { adapter.emit('receipt', { messageId: options.clientMessageId, status: 'confirmed', confirmationScope: 'whatsapp-read', readAt: f.clock.value }); return { status: 'uncertain', messageId: options.clientMessageId }; } });
  f.service.start(); const alert = await f.service.testRecipient('5511999999999', 'owner');
  assert.equal(alert.status, 'delivered'); assert.equal(alert.confirmationScope, 'whatsapp-read'); assert.equal(alert.readAt, f.clock.value); assert.equal(alert.error, null); assert.equal(f.calls.length, 1); await f.service.shutdown();
});

test('simulation never invokes an independent real webhook and simulated private work cannot leak after adapter mode switch', async () => {
  let webhookCalls = 0;
  const f = fixture({ connected: false, mode: 'simulated', settings: { independentAlertChannel: { enabled: true, url: 'https://alerts.example.test/events' } }, webhook: async () => { webhookCalls++; return { status: 'confirmed' }; } });
  f.service.recordIncident(f.incident); await f.service.flush(); assert.equal(webhookCalls, 0);
  const webhook = f.store.listEntities('alerts').find(a => a.channel === 'webhook'); assert.equal(webhook.status, 'failed'); assert.equal(webhook.errorCode, 'SIMULATION_EXTERNAL_SEND_BLOCKED');
  const real = new EventEmitter(); real.status = { state: 'connected', mode: 'whatsapp' }; real.minimumSpacingSeconds = 3; real.sendPrivate = async () => { throw new Error('Simulation must not reach this real adapter'); };
  f.service.setAdapter(real); await f.service.flush(); assert.equal(f.calls.length, 0);
  assert.equal(f.store.listEntities('alerts').find(a => a.channel === 'whatsapp').status, 'pending'); await f.service.shutdown();
});

test('removing or disabling a private recipient while offline prevents any queued delivery after reconnection', async () => {
  const f = fixture({ connected: false });
  f.service.recordIncident(f.incident); await f.service.flush();
  f.store.saveEntity('alert_recipients', { id: 'r1', phone: '5511999999999', enabled: false });
  f.adapter.status = { state: 'connected', mode: 'simulated' }; await f.service.flush();
  const alert = f.store.listEntities('alerts')[0]; assert.equal(alert.status, 'failed'); assert.equal(alert.errorCode, 'ALERT_RECIPIENT_DISABLED'); assert.equal(f.calls.length, 0); await f.service.shutdown();
});

test('critical scheduler failures notify once per unresolved occurrence and create a new occurrence after recovery', async () => {
  const f = fixture({ connected: false }); f.service.start();
  f.scheduler.emit('change', { error: 'token=should-not-leak', code: 'PROCESSING_FAILURE' }); f.scheduler.emit('change', { error: 'Repeated failure', code: 'PROCESSING_FAILURE' });
  await f.service.flush(); assert.equal(f.local.length, 1); assert.equal(f.store.listEntities('alerts').length, 1);
  f.scheduler.emit('change'); f.scheduler.emit('change', { error: 'New failure', code: 'PROCESSING_FAILURE' });
  await f.service.flush(); assert.equal(f.local.length, 2); assert.equal(f.store.listEntities('alerts').length, 2);
  assert(!JSON.stringify(f.store.listEntities('diagnostics')).includes('should-not-leak')); await f.service.shutdown();
});

test('a persisted offline disconnect is reused on restart instead of generating duplicate pending alerts', async () => {
  const f = fixture({ mode: 'whatsapp' }); f.service.start();
  f.adapter.status = { state: 'disconnected', mode: 'whatsapp', reasonCode: 'internet', at: f.clock.value };
  f.adapter.emit('status', f.adapter.status); await new Promise(resolve => setImmediate(resolve)); await f.service.flush(); await f.service.shutdown();
  const original = f.store.listEntities('alerts')[0]; const restart = new AlertService({ store: f.store, scheduler: f.scheduler, adapter: f.adapter, now: () => f.clock.value, sleep: async ms => { f.clock.value += ms; } });
  restart.start(); f.adapter.emit('status', f.adapter.status); await new Promise(resolve => setImmediate(resolve)); await restart.flush();
  assert.equal(f.store.listEntities('alerts').length, 1); assert.equal(f.store.listEntities('notifications').length, 1);
  f.adapter.status = { state: 'connected', mode: 'whatsapp' }; f.adapter.emit('status', f.adapter.status); await restart.flush();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.clientMessageId, original.messageId); await restart.shutdown();
});

test('a recipient disabled while WhatsApp resolves its private identifier is revalidated before submission', async () => {
  let releaseLookup;
  const f = fixture({ mode: 'whatsapp' });
  f.adapter.resolveRecipient = async phone => { await new Promise(resolve => { releaseLookup = resolve; }); return { jid: `${phone}@s.whatsapp.net`, mode: 'whatsapp' }; };
  const testing = f.service.testRecipient('5511999999999', 'owner', { recipientId: 'r1' });
  await new Promise(resolve => setImmediate(resolve));
  f.store.saveEntity('alert_recipients', { id: 'r1', enabled: false, phone: '5511999999999' }); releaseLookup();
  const alert = await testing; assert.equal(alert.status, 'failed'); assert.equal(alert.errorCode, 'ALERT_RECIPIENT_DISABLED'); assert.equal(f.calls.length, 0); await f.service.shutdown();
});

test('an active user who lost ownership while the private alert was pending no longer receives the global failure', async () => {
  const f = fixture({ connected: false, users: [{ id: 'owner', roleId: 'role-owner', active: true, phone: '5521988888888' }], settings: { systemAlertRecipientIds: [] } });
  f.service.recordSystemIncident({ id: 'global-owner-only', event: 'critical', at: f.clock.value, code: 'SYSTEM_ERROR', reason: 'Falha do sistema.' }); await f.service.flush();
  f.store.saveEntity('users', { id: 'owner', roleId: 'role-manager', active: true, phone: '5521988888888' });
  f.adapter.status = { state: 'connected', mode: 'simulated' }; await f.service.flush();
  const alert = f.store.listEntities('alerts')[0]; assert.equal(alert.status, 'failed'); assert.equal(alert.errorCode, 'ALERT_RECIPIENT_DISABLED'); assert.equal(f.calls.length, 0); await f.service.shutdown();
});

test('a confirmed delivery receipt wins over a later rejected transport promise and cannot become retryable work', async () => {
  const f = fixture({ privateSend: ({ options, adapter }) => { adapter.emit('receipt', { messageId: options.clientMessageId, status: 'confirmed', confirmationScope: 'whatsapp-delivered', deliveredAt: f.clock.value }); throw Object.assign(new Error('Late request failure'), { safeToRetry: true, code: 'WA_PRE_SUBMISSION_TEMPORARY' }); } });
  f.service.start(); const alert = await f.service.testRecipient('5511999999999', 'owner');
  assert.equal(alert.status, 'delivered'); assert.equal(alert.confirmationScope, 'whatsapp-delivered'); assert.equal(alert.retryEligible, false); assert.equal(alert.error, null);
  f.clock.value += 3600000; await f.service.flush(); assert.equal(f.calls.length, 1); await assert.rejects(f.service.retryAlert(alert.id, { userId: 'owner' }), /incertos/); await f.service.shutdown();
});

test('the real integration unsupported-recipient code gives the user an update instruction and cannot retry infinitely', async () => {
  const f = fixture({ mode: 'whatsapp' });
  f.adapter.resolveRecipient = async () => { throw Object.assign(new Error('Provider credentials must not be logged'), { code: 'WA_RECIPIENT_UNSUPPORTED', definitive: true }); };
  const alert = await f.service.testRecipient('5511999999999', 'owner');
  assert.equal(alert.status, 'failed'); assert.equal(alert.attempts, 1); assert.match(alert.error, /Atualize o aplicativo/); assert.equal(f.calls.length, 0);
  await f.service.flush(); assert.equal(f.store.getEntity('alerts', alert.id).attempts, 1); await f.service.shutdown();
});

test('the real integration known presubmission temporary failure remains retryable despite definitive outcome classification', async () => {
  let lookups = 0;
  const f = fixture({ mode: 'whatsapp' });
  f.adapter.resolveRecipient = async phone => { lookups++; if (lookups === 1) throw Object.assign(new Error('Known lookup timeout'), { code: 'WA_RECIPIENT_TIMEOUT', definitive: true, safeToRetry: true }); return { jid: `${phone}@s.whatsapp.net`, mode: 'whatsapp' }; };
  let alert = await f.service.testRecipient('5511999999999', 'owner'); assert.equal(alert.status, 'pending'); assert.equal(f.calls.length, 0); assert.equal(lookups, 1);
  f.clock.value += 15000; await f.service.flush(); alert = f.store.getEntity('alerts', alert.id);
  assert.equal(alert.status, 'confirmed'); assert.equal(f.calls.length, 1); assert.equal(lookups, 2); assert.equal(alert.attempts, 2); await f.service.shutdown();
});

test('real read proof stays stronger than later delivery proof or server acceptance', async () => {
  const f = fixture(); f.service.start(); const alert = await f.service.testRecipient('5511999999999', 'owner');
  f.adapter.emit('receipt', { messageId: alert.messageId, status: 'confirmed', confirmationScope: 'whatsapp-read', readAt: f.clock.value + 10000 });
  f.adapter.emit('receipt', { messageId: alert.messageId, status: 'confirmed', confirmationScope: 'whatsapp-delivered', deliveredAt: f.clock.value + 5000 });
  f.adapter.emit('receipt', { messageId: alert.messageId, status: 'confirmed', confirmationScope: 'whatsapp-server' });
  const stored = f.store.getEntity('alerts', alert.id); assert.equal(stored.status, 'delivered'); assert.equal(stored.confirmationScope, 'whatsapp-read'); assert.equal(stored.readAt, f.clock.value + 10000); assert.equal(f.calls.length, 1); await f.service.shutdown();
});

test('a simulation-only receipt never claims a real WhatsApp server confirmation scope', async () => {
  const f = fixture({ mode: 'simulated', privateSend: ({ options, adapter }) => { adapter.emit('receipt', { messageId: options.clientMessageId, status: 'confirmed', confirmationScope: 'simulation-only', mode: 'simulated', simulation: true }); return { status: 'confirmed', messageId: options.clientMessageId, simulation: true }; } });
  f.service.start(); const alert = await f.service.testRecipient('5511999999999', 'owner');
  assert.equal(alert.status, 'confirmed'); assert.equal(alert.confirmationScope, 'simulation-only'); assert.equal(alert.simulation, true); assert.equal(f.calls.length, 1); await f.service.shutdown();
});

test('parar tudo cancela pendentes, bloqueia novas filas e testes, mas mantém notificações locais', async () => {
  const f = fixture({ connected: false });
  let stopped = false; f.service.isAutomationStopped = () => stopped;
  f.service.recordSystemIncident({ id: 'before-stop', at: f.clock.value, event: 'critical', code: 'CRITICAL_TEST', reason: 'Falha anterior.' });
  assert.equal(f.store.listEntities('alerts').length, 1);
  stopped = true;
  assert.deepEqual(f.service.stopPending({ userId: 'owner' }), { cancelled: 1, inFlight: 0 });
  const during = { id: 'during-stop', at: f.clock.value, event: 'critical', code: 'CRITICAL_TEST', reason: 'Falha enquanto pausado.' };
  const occurrence = f.service.recordSystemIncident(during);
  assert.equal(occurrence.alerts.length, 0); assert.equal(f.local.length, 2);
  assert.equal(f.store.listEntities('alerts')[0].status, 'cancelled');
  await assert.rejects(f.service.testAlert({ userId: 'owner' }), error => error.code === 'AUTOMATION_STOPPED');
  await assert.rejects(f.service.testRecipient('5511888888888', 'owner'), error => error.code === 'AUTOMATION_STOPPED');
  f.adapter.status = { state: 'connected' }; await f.service.flush(); assert.equal(f.calls.length, 0);
  stopped = false; f.service.recordSystemIncident(during); await f.service.flush();
  assert.equal(f.calls.length, 0); // suppressed occurrence does not create a delayed backlog
  const testAlert = await f.service.testAlert({ userId: 'owner' });
  assert.equal(testAlert.alerts[0].status, 'confirmed'); assert.equal(f.calls.length, 1);
  await f.service.shutdown();
});

test('parar tudo durante resolução privada não deixa o antigo lote enviar após retomada', async () => {
  const f = fixture();
  let stopped = false, release, resolveStarted;
  f.service.isAutomationStopped = () => stopped;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  f.adapter.resolveRecipient = async () => { resolveStarted(); await new Promise(resolve => { release = resolve; }); return { jid: '5511999999999@s.whatsapp.net', mode: 'simulated', simulation: true }; };
  f.service.recordSystemIncident({ id: 'lookup-stop', at: f.clock.value, event: 'critical', code: 'CRITICAL_TEST', reason: 'Falha.' });
  const flushing = f.service.flush(); await started;
  stopped = true; assert.equal(f.service.stopPending().cancelled, 1);
  stopped = false; release(); await flushing;
  assert.equal(f.calls.length, 0); assert.equal(f.store.listEntities('alerts')[0].status, 'cancelled');
  await f.service.shutdown();
});

test('envio já em andamento mantém confirmação e é informado separadamente dos cancelados', async () => {
  let release, sendStarted;
  const started = new Promise(resolve => { sendStarted = resolve; });
  const f = fixture({ privateSend: async ({ options }) => { sendStarted(); await new Promise(resolve => { release = resolve; }); return { status: 'confirmed', messageId: options.clientMessageId }; } });
  let stopped = false; f.service.isAutomationStopped = () => stopped;
  f.service.recordSystemIncident({ id: 'in-flight-stop', at: f.clock.value, event: 'critical', code: 'CRITICAL_TEST', reason: 'Falha.' });
  const flushing = f.service.flush(); await started;
  stopped = true; assert.deepEqual(f.service.stopPending(), { cancelled: 0, inFlight: 1 });
  release(); await flushing;
  assert.equal(f.calls.length, 1); assert.equal(f.store.listEntities('alerts')[0].status, 'confirmed');
  stopped = false; await f.service.flush(); assert.equal(f.calls.length, 1);
  await f.service.shutdown();
});

test('política global de alerta limita tentativas e respeita intervalo configurado com identificador estável', async () => {
  const f = fixture({ settings: { alertRetryPolicy: { maxAttempts: 2, delaySeconds: 60 } }, privateSend: () => { throw Object.assign(new Error('transport temporary secret=do-not-log'), { safeToRetry: true, code: 'WA_TEMPORARY' }); } });
  f.service.recordSystemIncident({ id: 'global-retry', at: f.clock.value, event: 'critical', code: 'CRITICAL_TEST', reason: 'Falha.' });
  await f.service.flush();
  let alert = f.store.listEntities('alerts')[0]; assert.equal(alert.status, 'pending'); assert.equal(alert.attempts, 1);
  assert.equal(alert.nextAttemptAt - f.clock.value, 60000);
  f.clock.value += 59000; await f.service.flush(); assert.equal(f.calls.length, 1);
  f.clock.value += 1000; await f.service.flush(); alert = f.store.listEntities('alerts')[0];
  assert.equal(alert.status, 'failed'); assert.equal(alert.attempts, 2);
  f.clock.value += 600000; await f.service.flush(); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].options.clientMessageId, f.calls[1].options.clientMessageId);
  assert(!JSON.stringify(f.store.listEntities('diagnostics')).includes('do-not-log'));
  await f.service.shutdown();
});

test('desconexão com automação interrompida avisa localmente e não retoma campanhas ou alertas', async () => {
  const f = fixture({ settings: { reconnect: { autoResume: true } } });
  f.service.isAutomationStopped = () => true; f.service.start();
  f.store.saveCampaign({ ...f.store.getCampaign('c1'), state: 'paused', pauseReason: 'Conexão indisponível: disconnected.' });
  f.adapter.status = { state: 'disconnected', reasonCode: 'internet', at: new Date(f.clock.value).toISOString() };
  f.adapter.emit('status', f.adapter.status); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.local.length, 1); assert.equal(f.local[0].event, 'disconnect'); assert.equal(f.store.listEntities('alerts').length, 0);
  f.adapter.status = { state: 'connected' }; f.adapter.emit('status', f.adapter.status); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.resumes, []); assert.equal(f.calls.length, 0); await f.service.shutdown();
});

test('cancelamento da fila automática é controle operacional e não produz falha de persistência', async () => {
  const f = fixture();
  f.scheduler.runExternalSubmission = async () => { throw Object.assign(new Error('Automatic queue stopped'), { code: 'AUTOMATION_STOPPED' }); };
  f.service.recordSystemIncident({ id: 'queued-stop', at: f.clock.value, code: 'CRITICAL_TEST', reason: 'Falha de teste.' });
  await f.service.flush(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.scheduler.persistenceFailed, false); assert.equal(f.calls.length, 0);
  await f.service.shutdown();
});
