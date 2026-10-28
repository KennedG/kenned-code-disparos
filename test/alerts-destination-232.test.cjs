'use strict';

// Controlled integration tests validate the durable alert flow. They do not
// establish receipt by a physical WhatsApp account or a Windows notification.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AlertService } = require('../src/core/alerts.cjs');
const { createStore } = require('../src/core/store.cjs');
const { Scheduler } = require('../src/core/scheduler.cjs');

const clone = value => value === undefined ? undefined : structuredClone(value);
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
function bound(f, milliseconds = 20) {
  // Use the production scheduler deadline implementation rather than a
  // simulated timeout; only the network transport is controlled here.
  f.scheduler.runBoundedAttempt = Scheduler.prototype.runBoundedAttempt;
  f.scheduler.getAttemptTimeoutMs = () => milliseconds;
  f.scheduler._timeoutMs = () => milliseconds;
  f.scheduler.detachedAttempts = new Set();
  f.scheduler._failClosed = f.scheduler.blockOnPersistenceFailure;
}
async function fixture(t, { connected = true, send, persistent = false, settings = {} } = {}) {
  let at = Date.parse('2026-10-08T11:00:00-03:00'), stopped = false;
  const tables = new Map(), preferences = new Map(Object.entries(settings));
  const root = persistent ? mkdtempSync(path.join(os.tmpdir(), 'kenned-destination-alert-')) : null;
  let store = persistent ? await createStore(root) : {
    getSetting: (key, fallback) => preferences.has(key) ? clone(preferences.get(key)) : fallback,
    setSetting: (key, value) => { preferences.set(key, clone(value)); return clone(value); },
    saveEntity(table, value) { if (!tables.has(table)) tables.set(table, new Map()); tables.get(table).set(value.id, clone(value)); return clone(value); },
    getEntity: (table, id) => clone(tables.get(table)?.get(id)),
    listEntities: table => [...(tables.get(table)?.values() || [])].map(clone),
    getCampaign: id => clone(tables.get('campaigns')?.get(id)),
    listCampaigns: () => [...(tables.get('campaigns')?.values() || [])].map(clone),
    getGroup: id => clone(tables.get('groups_data')?.get(id)),
    listJobs: () => [],
    addDiagnostic(record) { return this.saveEntity('diagnostics', record); },
    addAudit(record) { return this.saveEntity('audit', record); }
  };
  const save = (table, value) => table === 'campaigns' && store.saveCampaign ? store.saveCampaign(value) : table === 'groups_data' && store.upsertGroups ? store.upsertGroups([value]) : store.saveEntity(table, value);
  save('campaigns', { id: 'daily', name: 'Lista da loja — 08/10/2026', state: 'active', groupIds: ['123@g.us'], alertRecipientIds: ['owner-phone'], items: [{ id: 'phone-item', type: 'text', text: '📱 iPhone 16 128GB\n🩷 Cor: ROSA\nR$ 2.999,00\nDetalhe na tela pequeno' }] });
  save('groups_data', { id: '123@g.us', name: 'Grupo real autorizado', available: true });
  save('alert_recipients', { id: 'owner-phone', phone: '5562999990201', enabled: true, name: 'Particular autorizado' });
  for (const [key, value] of Object.entries(settings)) store.setSetting(key, value);
  const adapter = new EventEmitter();
  adapter.status = { mode: 'whatsapp', state: connected ? 'connected' : 'disconnected' };
  adapter.minimumSpacingSeconds = 3;
  const calls = [], notifications = [];
  adapter.resolveRecipient = async number => ({ jid: number + '@s.whatsapp.net', phone: number, mode: 'whatsapp', simulation: false });
  adapter.sendPrivate = async (number, text, options) => { calls.push({ number, text, options, at }); return send ? send({ number, text, options, adapter, store }) : { status: 'confirmed', messageId: options.clientMessageId, confirmationScope: 'whatsapp-server' }; };
  const scheduler = new EventEmitter();
  scheduler.holdSubmissions = () => () => {};
  scheduler.waitForIdle = async () => {};
  scheduler.blockOnPersistenceFailure = () => { scheduler.persistenceFailed = true; };
  const create = () => {
    const value = new AlertService({ store, adapter, scheduler, now: () => at, sleep: async ms => { at += ms; }, isAutomationStopped: () => stopped });
    value.on('localAlert', notification => notifications.push(clone(notification)));
    return value;
  };
  let service = create();
  t.after(async () => { await service.shutdown(); store.close?.(); if (root) rmSync(root, { recursive: true, force: true }); });
  const event = { campaignId: 'daily', groupId: '123@g.us', itemId: 'phone-item', code: 'GROUP_ADMIN_ONLY', reason: 'O grupo permite mensagens apenas de administradores e a conta conectada não é administradora.', operationId: 'round-one:phone-item:123@g.us', at, connectionAvailable: connected };
  return { get store() { return store; }, adapter, scheduler, get service() { return service; }, calls, notifications, event, advance(ms) { at += ms; }, stop(value = true) { stopped = value; }, async reopen() { await service.shutdown(); if (persistent) { store.close(); store = await createStore(root); } service = create(); return service; } };
}

test('first destination failure identifies campaign, real group, item and permission; does not claim campaign ended', async t => {
  const f = await fixture(t); const occurrence = f.service.destinationFailure(f.event); await f.service.flush();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].number, '5562999990201');
  assert.match(f.calls[0].text, /Lista da loja — 08\/10\/2026/); assert.match(f.calls[0].text, /Grupo real autorizado/);
  assert.match(f.calls[0].text, /123@g\.us/); assert.match(f.calls[0].text, /iPhone 16 128GB/);
  assert.match(f.calls[0].text, /não é administradora/); assert.match(f.calls[0].text, /demais grupos elegíveis continuarão/);
  assert.doesNotMatch(f.calls[0].text, /Campanha interrompida por erro/);
  const alert = f.store.getEntity('alerts', occurrence.alerts[0].id);
  assert.equal(alert.status, 'confirmed'); assert.equal(alert.originalAt, f.event.at);
  assert.equal(alert.deliveredAt, undefined); assert.equal(alert.confirmationScope, 'whatsapp-server');
  assert.equal(f.notifications.length, 1);
});

test('duplicate operation and repeated same group errors produce first notice then one configurable summary', async t => {
  const f = await fixture(t, { settings: { destinationAlertPolicy: { summaryIntervalSeconds: 60 } } });
  f.service.destinationFailure(f.event); f.service.destinationFailure(f.event); await f.service.flush();
  for (let index = 0; index < 30; index++) f.service.destinationFailure({ ...f.event, operationId: 'new-' + index, at: f.event.at + index });
  await f.service.flush(); assert.equal(f.calls.length, 1);
  f.advance(59000); await f.service.flush(); assert.equal(f.calls.length, 1);
  f.advance(1000); await f.service.flush(); assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].text, /Resumo de falhas/); assert.match(f.calls[1].text, /Recorrências neste período: 30/);
  f.advance(60000); await f.service.flush(); assert.equal(f.calls.length, 2);
});

test('different groups produce independent notices and names without changing or stopping the campaign', async t => {
  const f = await fixture(t); f.store.saveEntity('groups_data', { id: 'other@g.us', name: 'Outro grupo real' });
  f.service.destinationFailure(f.event);
  f.service.destinationFailure({ ...f.event, groupId: 'other@g.us', operationId: 'other-job', code: 'GROUP_NOT_PARTICIPANT', reason: 'A conta conectada não participa do grupo.' });
  await f.service.flush(); assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].text, /Outro grupo real/); assert.match(f.calls[1].text, /não participa/);
  assert.equal(f.store.getCampaign('daily').state, 'active');
});

test('offline destination warning is local immediately, remains pending and preserves original time after reconnect', async t => {
  const f = await fixture(t, { connected: false });
  const occurrence = f.service.destinationFailure({ ...f.event, connectionAvailable: false }); await f.service.flush();
  assert.equal(f.notifications.length, 1); assert.equal(f.calls.length, 0);
  let alert = f.store.getEntity('alerts', occurrence.alerts[0].id); assert.equal(alert.status, 'pending');
  assert.match(alert.text, /conexão geral está indisponível/); assert.doesNotMatch(alert.text, /demais grupos elegíveis continuarão/);
  f.advance(3600000); f.adapter.status = { state: 'connected', mode: 'whatsapp' }; await f.service.flush();
  alert = f.store.getEntity('alerts', alert.id); assert.equal(f.calls.length, 1); assert.equal(alert.originalAt, f.event.at);
  assert.match(alert.text, /08\/10\/2026, 11:00:00/); assert.equal(alert.status, 'confirmed');
});

test('SQLite restart preserves summary counters, exact operation deduplication and already accepted first notice', async t => {
  const f = await fixture(t, { persistent: true, settings: { destinationAlertPolicy: { summaryIntervalSeconds: 60 } } });
  f.service.destinationFailure(f.event); await f.service.flush();
  f.service.destinationFailure({ ...f.event, operationId: 'recurrence', at: f.event.at + 10000 }); await f.service.flush();
  await f.reopen(); const duplicate = f.service.destinationFailure(f.event); assert.equal(duplicate.duplicate, true);
  f.advance(60000); await f.service.flush(); assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].text, /Recorrências neste período: 1/);
  await f.reopen(); await f.service.flush(); assert.equal(f.calls.length, 2);
});

test('revoked linked recipient cannot receive pending destination warning', async t => {
  const f = await fixture(t, { connected: false });
  f.store.saveEntity('users', { id: 'responsible', active: true, phone: '5562999990201' });
  f.store.saveEntity('alert_recipients', { id: 'owner-phone', enabled: true, phone: '5562999990201', userId: 'responsible' });
  const occurrence = f.service.destinationFailure(f.event); await f.service.flush();
  f.store.saveEntity('users', { id: 'responsible', active: false, phone: '5562999990201' });
  f.adapter.status = { state: 'connected', mode: 'whatsapp' }; await f.service.flush();
  assert.equal(f.calls.length, 0); const alert = f.store.getEntity('alerts', occurrence.alerts[0].id);
  assert.equal(alert.status, 'failed'); assert.equal(alert.errorCode, 'ALERT_RECIPIENT_DISABLED');
});

test('alert send failure is bounded and never recursively creates another group incident or private alert', async t => {
  const f = await fixture(t, { settings: { alertRetryPolicy: { maxAttempts: 2, delaySeconds: 10 } }, send: () => { throw Object.assign(new Error('temporarily refused token=do-not-log'), { definitive: true, safeToRetry: true, code: 'WA_TEMPORARY' }); } });
  f.service.destinationFailure(f.event); await f.service.flush(); f.advance(10000); await f.service.flush();
  f.advance(3600000); await f.service.flush(); assert.equal(f.calls.length, 2);
  assert.equal(f.store.listEntities('alerts').length, 1); assert.equal(f.notifications.length, 1);
  assert.equal(f.store.listEntities('alerts')[0].status, 'failed');
  assert.doesNotMatch(JSON.stringify(f.store.listEntities('diagnostics')), /do-not-log/);
});

test('uncertain destination alert is not retried; late real delivery reconciles by message ID only', async t => {
  const f = await fixture(t, { send: ({ options }) => ({ status: 'uncertain', messageId: options.clientMessageId }) }); f.service.start();
  const occurrence = f.service.destinationFailure(f.event); await f.service.flush();
  const alert = f.store.getEntity('alerts', occurrence.alerts[0].id); assert.equal(alert.status, 'uncertain');
  f.advance(3600000); await f.service.flush(); assert.equal(f.calls.length, 1);
  f.adapter.emit('receipt', { status: 'delivered', messageId: alert.messageId, confirmationScope: 'whatsapp-delivered' });
  assert.equal(f.store.getEntity('alerts', alert.id).status, 'delivered'); assert.equal(f.calls.length, 1);
});

test('stop-all suppresses its old destination occurrences after resume; genuinely new failure may notify again', async t => {
  const f = await fixture(t); f.stop(); f.service.destinationFailure(f.event); await f.service.flush();
  assert.equal(f.notifications.length, 1); assert.equal(f.store.listEntities('alerts').length, 0);
  f.stop(false); f.advance(900000); f.service.destinationFailure(f.event); await f.service.flush();
  assert.equal(f.calls.length, 0);
  f.service.destinationFailure({ ...f.event, operationId: 'later' }); await f.service.flush();
  assert.equal(f.calls.length, 1);
});

test('unknown group reason stays unknown, technical secrets and keys are removed from private alerts and logs', async t => {
  const f = await fixture(t); f.service.destinationFailure({ ...f.event, code: 'UNCLASSIFIED', reason: 'Motivo não identificado. E500 token=credential KCD-M-ABCDEFGH-ABCDEFGH-ABCDEFGH-ABCDEFGH' }); await f.service.flush();
  assert.match(f.calls[0].text, /Motivo não identificado/); assert.doesNotMatch(f.calls[0].text, /token=credential|KCD-M-/);
  assert.doesNotMatch(JSON.stringify(f.store.listEntities('diagnostics')), /credential|KCD-M-/);
});

test('stalled private notice reaches its real deadline, frees the next recipient and reconciles late acceptance once', async t => {
  const delayed = deferred();
  const f = await fixture(t, { send: ({ number, options }) => number === '5562999990201' ? delayed.promise : { status: 'confirmed', messageId: options.clientMessageId } }); bound(f);
  f.store.saveEntity('alert_recipients', { id: 'second', enabled: true, phone: '5562999990203' });
  f.store.saveEntity('campaigns', { ...f.store.getCampaign('daily'), alertRecipientIds: ['owner-phone', 'second'] });
  const occurrence = f.service.destinationFailure(f.event); await f.service.flush();
  assert.equal(f.calls.length, 2); const first = f.store.getEntity('alerts', occurrence.alerts[0].id);
  assert.equal(first.status, 'uncertain'); assert.equal(first.errorCode, 'SUBMISSION_TIMEOUT'); assert.equal(first.retryEligible, false);
  assert.equal(f.store.getEntity('alerts', occurrence.alerts[1].id).status, 'confirmed');
  await f.service.flush(); assert.equal(f.calls.length, 2);
  delayed.resolve({ status: 'confirmed', messageId: first.messageId, confirmationScope: 'whatsapp-server' });
  await new Promise(resolve => setImmediate(resolve));
  const reconciled = f.store.getEntity('alerts', first.id); assert.equal(reconciled.status, 'confirmed'); assert(reconciled.reconciledAt);
  await f.service.flush(); assert.equal(f.calls.length, 2);
});

test('recipient lookup timeout proves no submission and allows bounded retry while other recipient proceeds', async t => {
  const delayed = deferred(); const f = await fixture(t); bound(f);
  f.store.saveEntity('alert_recipients', { id: 'second', enabled: true, phone: '5562999990203' });
  f.store.saveEntity('campaigns', { ...f.store.getCampaign('daily'), alertRecipientIds: ['owner-phone', 'second'] });
  f.adapter.resolveRecipient = async number => number === '5562999990201' ? delayed.promise : { jid: number + '@s.whatsapp.net', phone: number, mode: 'whatsapp' };
  const occurrence = f.service.destinationFailure(f.event); await f.service.flush();
  const first = f.store.getEntity('alerts', occurrence.alerts[0].id);
  assert.equal(first.status, 'pending'); assert.equal(first.errorCode, 'ALERT_RECIPIENT_TIMEOUT');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].number, '5562999990203');
  delayed.resolve({ jid: '5562999990201@s.whatsapp.net', phone: '5562999990201', mode: 'whatsapp' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, 1);
});

test('late definitive failure reconciles uncertain attempt without an automatic retry or recursive alert', async t => {
  const delayed = deferred(); const f = await fixture(t, { send: () => delayed.promise }); bound(f);
  const occurrence = f.service.destinationFailure(f.event); await f.service.flush();
  assert.equal(f.store.getEntity('alerts', occurrence.alerts[0].id).status, 'uncertain');
  delayed.reject(Object.assign(new Error('Account rejected recipient token=do-not-log'), { definitive: true, code: 'WA_RECIPIENT_NOT_FOUND', submitted: false }));
  await new Promise(resolve => setImmediate(resolve));
  const alert = f.store.getEntity('alerts', occurrence.alerts[0].id);
  assert.equal(alert.status, 'failed'); assert.equal(alert.retryEligible, true); assert.equal(alert.errorCode, 'WA_RECIPIENT_NOT_FOUND');
  f.advance(3600000); await f.service.flush(); assert.equal(f.calls.length, 1); assert.equal(f.store.listEntities('alerts').length, 1);
  assert.doesNotMatch(JSON.stringify(f.store.listEntities('diagnostics')), /do-not-log/);
});

test('safe confirmed temporary failures back off progressively with a stable message ID', async t => {
  const f = await fixture(t, { settings: { alertRetryPolicy: { maxAttempts: 3, delaySeconds: 10 } }, send: () => { throw Object.assign(new Error('Temporary rejection'), { definitive: true, safeToRetry: true, code: 'WA_TEMPORARY' }); } });
  f.service.destinationFailure(f.event); await f.service.flush();
  const initial = f.store.listEntities('alerts')[0]; f.advance(10000); await f.service.flush();
  let alert = f.store.getEntity('alerts', initial.id); assert.equal(alert.status, 'pending'); assert.equal(alert.nextAttemptAt - alert.lastAttemptAt, 20000);
  f.advance(19000); await f.service.flush(); assert.equal(f.calls.length, 2);
  f.advance(1000); await f.service.flush(); alert = f.store.getEntity('alerts', initial.id); assert.equal(alert.status, 'failed'); assert.equal(f.calls.length, 3);
  assert(f.calls.every(call => call.options.clientMessageId === initial.messageId));
});

test('production Scheduler and SQLite FIFO release other external work after a stalled alert deadline', async t => {
  const delayed = deferred(), entered = deferred();
  const f = await fixture(t, { persistent: true, send: () => { entered.resolve(); return delayed.promise; } });
  const scheduler = new Scheduler({ store: f.store, adapter: f.adapter, attemptTimeoutMs: 20 });
  f.service.scheduler = scheduler;
  f.service.destinationFailure(f.event); const flush = f.service.flush(); await entered.promise;
  let nextExecuted = 0;
  const next = scheduler.runExternalSubmission(async () => { nextExecuted++; return 'next'; }, { manual: true });
  await flush; assert.equal(await next, 'next'); assert.equal(nextExecuted, 1);
  const first = f.store.listAlerts()[0]; assert.equal(first.status, 'uncertain'); assert.equal(f.calls.length, 1);
  assert.equal(scheduler.submissionHolds, 0);
  delayed.resolve({ status: 'confirmed', messageId: first.messageId, confirmationScope: 'whatsapp-server' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.getAlert(first.id).status, 'confirmed'); assert.equal(f.calls.length, 1); assert.equal(scheduler.detachedAttempts.size, 0);
  await scheduler.shutdown();
});
