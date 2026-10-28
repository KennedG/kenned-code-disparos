'use strict';

// These tests run the production alert service and WhatsAppAdapter with a
// controlled authenticated-socket facade. They do not establish real delivery.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AlertService } = require('../src/core/alerts.cjs');
const { WhatsAppAdapter } = require('../src/adapters/whatsapp.cjs');

const PHONE = '5562999990201';
const STORE_PHONE = '5562999990202';
const clone = value => value === undefined ? undefined : structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(t, { connected = true, error, settings = {} } = {}) {
  let at = Date.parse('2026-10-06T13:00:00-03:00'), stopped = false;
  const tables = new Map(), preferences = new Map(Object.entries(settings)), submitted = [];
  const store = {
    persistenceFailed: false,
    getSetting: (key, fallback) => preferences.has(key) ? clone(preferences.get(key)) : fallback,
    setSetting: (key, value) => { preferences.set(key, clone(value)); return clone(value); },
    getCampaign: () => null, listCampaigns: () => [], listJobs: () => [],
    saveEntity(table, value) { if (!tables.has(table)) tables.set(table, new Map()); tables.get(table).set(value.id, clone(value)); return clone(value); },
    getEntity: (table, id) => clone(tables.get(table)?.get(id)),
    listEntities: table => [...(tables.get(table)?.values() || [])].map(clone),
    addDiagnostic: value => store.saveEntity('diagnostics', value),
    addAudit: value => store.saveEntity('audit', value)
  };
  store.saveEntity('alert_recipients', { id: 'particular', name: 'Particular autorizado', phone: PHONE, enabled: true });
  const adapter = new WhatsAppAdapter({ store, ackTimeoutMs: 15 });
  adapter.status = { state: connected ? 'connected' : 'disconnected', mode: 'whatsapp' };
  adapter.library = {};
  adapter.socket = { user: { id: STORE_PHONE + '@s.whatsapp.net' }, end() {},
    async sendMessage(target, content, options) { submitted.push({ target, content, options }); if (error) throw error; return { key: { id: options.messageId }, status: 2 }; }
  };
  adapter.resolveRecipient = async number => ({ jid: number + '@s.whatsapp.net', phone: number, isSelf: number === STORE_PHONE, mode: 'whatsapp', simulation: false });
  const scheduler = new EventEmitter();
  scheduler.lastSubmissionAt = null;
  scheduler.persistenceFailed = false;
  scheduler.holdSubmissions = () => () => {};
  scheduler.waitForIdle = async () => {};
  scheduler.blockOnPersistenceFailure = () => { scheduler.persistenceFailed = true; };
  const service = new AlertService({ store, adapter, scheduler, now: () => at, sleep: async ms => { at += Math.max(0, ms); }, isAutomationStopped: () => stopped });
  const local = []; service.on('localAlert', event => local.push(event));
  t.after(async () => { await service.shutdown(); adapter._resolveAllPending(); });
  return { store, adapter, scheduler, service, submitted, local, get now() { return at; }, advance(ms) { at += ms; }, stop(value = true) { stopped = value; } };
}

test('alert recipient revoked during the transport second resolution never reaches socket.sendMessage', async t => {
  const f = fixture(t), started = deferred(), release = deferred(); let count = 0;
  f.adapter.resolveRecipient = async number => { if (++count === 2) { started.resolve(); await release.promise; } return { jid: number + '@s.whatsapp.net', phone: number, mode: 'whatsapp' }; };
  const pending = f.service.testRecipient(PHONE, 'owner-test', { recipientId: 'particular' });
  await started.promise;
  f.store.saveEntity('alert_recipients', { ...f.store.getEntity('alert_recipients', 'particular'), enabled: false });
  release.resolve(); const alert = await pending;
  assert.equal(f.submitted.length, 0);
  assert.equal(alert.status, 'failed'); assert.equal(alert.errorCode, 'ALERT_RECIPIENT_DISABLED');
  assert.equal(alert.lastAcceptedAt, undefined);
});

test('stop all during the transport second resolution cancels the unsent alert even after explicit resume', async t => {
  const f = fixture(t), started = deferred(), release = deferred(); let count = 0;
  f.adapter.resolveRecipient = async number => { if (++count === 2) { started.resolve(); await release.promise; } return { jid: number + '@s.whatsapp.net', phone: number, mode: 'whatsapp' }; };
  const pending = f.service.testRecipient(PHONE, 'owner-test', { recipientId: 'particular' }); await started.promise;
  f.stop(); f.service.stopPending({ userId: 'owner-test' }); f.stop(false);
  release.resolve(); const alert = await pending;
  assert.equal(f.submitted.length, 0); assert.equal(alert.status, 'cancelled');
  assert.equal(alert.errorCode, 'AUTOMATION_STOPPED');
  await f.service.flush(); assert.equal(f.submitted.length, 0);
});

test('test alert records requesting user, attempts and server acceptance separately from delivery', async t => {
  const f = fixture(t); f.service.start();
  const alert = await f.service.testRecipient(PHONE, 'owner-test', { recipientId: 'particular' });
  assert.equal(f.submitted.length, 1); assert.equal(f.submitted[0].target, PHONE + '@s.whatsapp.net');
  assert.notEqual(f.submitted[0].target, STORE_PHONE + '@s.whatsapp.net');
  assert.equal(alert.userId, 'owner-test'); assert.equal(alert.status, 'confirmed');
  assert.equal(alert.lastAttemptAt, f.now); assert.equal(alert.lastAcceptedAt, f.now);
  assert.equal(alert.deliveredAt, undefined); assert.equal(alert.confirmationScope, 'whatsapp-server');
  const diagnostics = f.store.listEntities('diagnostics').filter(entry => entry.traceId === alert.traceId);
  assert(diagnostics.every(entry => entry.userId === 'owner-test'));
  assert(diagnostics.every(entry => entry.level === 'info' && entry.error === false && entry.warning === false));
  assert(diagnostics.some(entry => entry.stage === 'alerta.recipient' && entry.targetId === PHONE + '@s.whatsapp.net'));
  f.adapter.emit('receipt', { messageId: alert.messageId, status: 'delivered', confirmationScope: 'whatsapp-delivered', deliveredAt: f.now + 60000 });
  const delivered = f.store.getEntity('alerts', alert.id);
  assert.equal(delivered.status, 'delivered'); assert.equal(delivered.deliveredAt, f.now + 60000);
  assert.equal(delivered.lastAcceptedAt, alert.lastAcceptedAt);
});

test('specific temporary lookup failure preserves sanitized technical detail and bounded retry schedule', async t => {
  const f = fixture(t, { settings: { alertRetryPolicy: { maxAttempts: 2, delaySeconds: 60 } } }); let lookups = 0;
  f.adapter.resolveRecipient = async () => { lookups++; throw Object.assign(new Error('Falha de consulta: ETIMEDOUT token="secret with spaces" senha=never-log'), { code: 'WA_RECIPIENT_TIMEOUT', definitive: true, safeToRetry: true }); };
  const alert = await f.service.testRecipient(PHONE, 'owner-test', { recipientId: 'particular' });
  assert.equal(alert.status, 'pending'); assert.equal(alert.nextAttemptAt, f.now + 60000);
  assert.equal(alert.lastAttemptAt, f.now); assert.equal(alert.lastFailureAt, f.now);
  assert.match(alert.technicalError, /ETIMEDOUT/);
  assert(!alert.technicalError.includes('secret with spaces')); assert(!alert.technicalError.includes('never-log'));
  assert(f.store.listEntities('diagnostics').some(entry => entry.code === 'WA_RECIPIENT_TIMEOUT' && entry.technicalError?.includes('ETIMEDOUT')));
  assert(f.store.listEntities('diagnostics').some(entry => entry.code === 'WA_RECIPIENT_TIMEOUT' && entry.level === 'warning'));
  f.advance(59000); await f.service.flush(); assert.equal(lookups, 1);
  f.advance(1000); await f.service.flush(); assert.equal(lookups, 2);
  const failed = f.store.getEntity('alerts', alert.id); assert.equal(failed.status, 'failed'); assert.equal(failed.attempts, 2);
  assert(f.store.listEntities('diagnostics').some(entry => entry.code === 'WA_RECIPIENT_TIMEOUT' && entry.level === 'error'));
  f.advance(1000000); await f.service.flush(); assert.equal(lookups, 2); assert.equal(f.submitted.length, 0);
});

test('recipient linked to a deactivated user cannot receive a pending alert', async t => {
  const f = fixture(t, { connected: false });
  f.store.saveEntity('users', { id: 'responsible', phone: PHONE, active: true, roleId: 'role-manager' });
  f.store.saveEntity('alert_recipients', { ...f.store.getEntity('alert_recipients', 'particular'), userId: 'responsible' });
  const alert = await f.service.testRecipient(PHONE, 'owner-test', { recipientId: 'particular' }); assert.equal(alert.status, 'pending');
  f.store.saveEntity('users', { ...f.store.getEntity('users', 'responsible'), active: false });
  f.adapter.status = { state: 'connected', mode: 'whatsapp' }; await f.service.flush();
  assert.equal(f.submitted.length, 0); assert.equal(f.store.getEntity('alerts', alert.id).status, 'failed');
});

test('disconnect emits local alert immediately and sends pending private alert once after reconnection with original time', async t => {
  const f = fixture(t); f.service.start(); const originalAt = f.now;
  f.adapter.status = { state: 'disconnected', mode: 'whatsapp', reasonCode: 'internet', at: originalAt, errorCode: 'WA_NETWORK_OFFLINE' };
  f.adapter.emit('status', f.adapter.status);
  assert.equal(f.local.length, 1); assert.equal(f.local[0].at, originalAt); assert.equal(f.submitted.length, 0);
  let alert = f.store.listEntities('alerts')[0]; assert.equal(alert.status, 'pending'); assert.equal(alert.lastAcceptedAt, undefined);
  f.advance(3600000); f.adapter.status = { state: 'connected', mode: 'whatsapp' }; f.adapter.emit('status', f.adapter.status);
  await new Promise(resolve => setImmediate(resolve)); await f.service.flush();
  assert.equal(f.submitted.length, 1); alert = f.store.getEntity('alerts', alert.id);
  assert.equal(alert.originalAt, originalAt); assert.equal(alert.status, 'confirmed'); assert.equal(alert.lastAcceptedAt, f.now);
  assert(alert.text.includes(`Ocorrência original: ${new Date(originalAt).toLocaleString('pt-BR', {timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone})}`)); assert.match(alert.text,/Conexão recuperada:/);
  await f.service.flush(); assert.equal(f.submitted.length, 1);
});

test('transport timeout is uncertain and never automatically repeated or presented as accepted', async t => {
  const f = fixture(t, { error: Object.assign(new Error('Socket lost during submission'), { code: 'ETIMEDOUT' }) });
  const alert = await f.service.testRecipient(PHONE, 'owner-test', { recipientId: 'particular' });
  assert.equal(alert.status, 'uncertain'); assert.equal(alert.lastAcceptedAt, undefined); assert.equal(f.submitted.length, 1);
  f.advance(3600000); await f.service.flush(); assert.equal(f.submitted.length, 1);
  await assert.rejects(f.service.retryAlert(alert.id, { userId: 'owner-test' }));
});

test('failed full-flow alert test with no configured recipients explains that no private alert was queued', async t => {
  const f = fixture(t, { connected: false });
  f.store.saveEntity('alert_recipients', { ...f.store.getEntity('alert_recipients', 'particular'), enabled: false });
  const occurrence = await f.service.testAlert({ userId: 'owner-test' });
  assert.equal(occurrence.alerts.length, 0); assert.equal(occurrence.deliveryStatus, 'not-configured');
  assert.equal(occurrence.deliveryCode, 'ALERT_RECIPIENTS_NOT_CONFIGURED');
  assert.match(occurrence.deliveryReason, /destinatário/i); assert.equal(f.local.length, 1);
  assert.equal(f.submitted.length, 0);
});
