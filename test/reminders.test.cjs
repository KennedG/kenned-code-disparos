'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createStore } = require('../src/core/store.cjs');
const { ReminderService, normalizeReminder, localEpoch, nextOccurrence, previousOccurrence, reminderText } = require('../src/core/reminders.cjs');

async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-reminders-'));
  const clock = { value: Date.parse('2026-10-03T12:59:00Z') };
  const store = await createStore(dir);
  store.setSetting('integrationMode', options.mode || 'whatsapp');
  store.saveEntity('roles', { id: 'role-owner', isOwner: true });
  store.saveEntity('users', { id: 'owner', roleId: 'role-owner', name: 'Dono de teste', phone: '5511999999999', active: true });
  const adapter = new EventEmitter(); adapter.status = { mode: options.mode || 'whatsapp', state: options.connected === false ? 'disconnected' : 'connected' }; adapter.minimumSpacingSeconds = 3;
  const calls = [], recipients = [];
  adapter.resolveRecipient = async number => { recipients.push(number); if (options.resolve) return options.resolve(number, { store, adapter, clock }); return { jid: `${number}@s.whatsapp.net`, phone: number, mode: adapter.status.mode, simulation: adapter.status.mode === 'simulated' }; };
  adapter.sendPrivate = async (number, text, submit) => {
    const ledger = store.listEntities('reminder_deliveries').find(item => item.messageId === submit.clientMessageId);
    assert.equal(ledger.status, 'sending');
    calls.push({ number, text, submit, at: clock.value });
    return options.send ? options.send({ number, text, submit, adapter, store, clock, calls }) : { status: 'confirmed', messageId: submit.clientMessageId, confirmationScope: adapter.status.mode === 'simulated' ? 'simulation-only' : 'whatsapp-server' };
  };
  let tail = Promise.resolve();
  const scheduler = { lastSubmissionAt: null, persistenceFailed: false, runExternalSubmission(task) { const work = tail.then(task); tail = work.catch(() => {}); return work; }, blockOnPersistenceFailure() { this.persistenceFailed = true; } };
  const permissions = new Set(['reminder.view', 'reminder.create', 'reminder.edit', 'reminder.delete', 'reminder.control']);
  const auth = { assertFor(actor, permission) { if (actor !== 'owner' || !permissions.has(permission)) throw Object.assign(new Error('Acesso recusado.'), { code: 'AUTH_DENIED', definitive: true }); return store.getEntity('users', actor); } };
  const gate = { stopped: false }, incidents = [];
  const services = [], cleanup = [];
  const create = () => { const service = new ReminderService({ store, auth, scheduler, adapter, now: () => clock.value, sleep: async ms => { clock.value += ms; }, isAutomationStopped: () => gate.stopped, onCriticalIncident: incident => incidents.push(incident) }); services.push(service); return service; };
  const service = create();
  t.after(async () => { for (const s of services) await s.stop(); for (const callback of cleanup) await callback(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const save = (patch = {}) => service.save({ title: 'Organizar estoque', description: 'Conferir a vitrine.', time: '10:00', timezone: 'America/Sao_Paulo', repeat: 'daily', recipientId: 'user:owner', enabled: true, ...patch }, 'owner');
  return { dir, store, clock, adapter, calls, recipients, scheduler, auth, permissions, gate, incidents, service, create, save, cleanup };
}

const config = patch => normalizeReminder({ title: 'Tarefa', recipientId: 'user:test', time: '10:00', ...patch });

test('Brasília recurring reminders map local 10:00 to original 13:00 UTC and respect configured weekdays', () => {
  const daily = config();
  assert.equal(nextOccurrence(daily, Date.parse('2026-10-03T12:00:00Z')), Date.parse('2026-10-03T13:00:00Z'));
  assert.equal(nextOccurrence(daily, Date.parse('2026-10-03T13:00:00Z')), Date.parse('2026-10-04T13:00:00Z'));
  const weekdays = config({ repeat: 'weekdays', weekdays: [1, 3] });
  assert.equal(nextOccurrence(weekdays, Date.parse('2026-10-03T13:00:00Z')), Date.parse('2026-10-05T13:00:00Z'));
  assert.equal(previousOccurrence(weekdays, Date.parse('2026-10-03T13:00:00Z')), Date.parse('2026-09-30T13:00:00Z'));
});

test('one-date reminders do not repeat, skip missing DST times, and choose only first ambiguous wall time', () => {
  const once = config({ repeat: 'once', date: '2026-10-03' });
  assert.equal(nextOccurrence(once, Date.parse('2026-10-03T12:00:00Z')), Date.parse('2026-10-03T13:00:00Z'));
  assert.equal(nextOccurrence(once, Date.parse('2026-10-03T13:00:00Z')), null);
  assert.equal(localEpoch({ year: 2026, month: 3, day: 8 }, '02:30', 'America/New_York'), null);
  assert.equal(localEpoch({ year: 2026, month: 11, day: 1 }, '01:30', 'America/New_York'), Date.parse('2026-11-01T05:30:00Z'));
});

test('invalid dates, unauthorized raw numbers, malformed schedule and unbounded retries reject', async t => {
  const f = await fixture(t);
  for (const patch of [{ date: '2026-02-30', repeat: 'once' }, { time: '25:00' }, { timezone: 'America/Inventado' }, { repeat: 'weekdays', weekdays: [] }, { maxAttempts: 99 }, { overdueGraceMinutes: 0 }]) assert.throws(() => f.save(patch), /válid|horário|Fuso|Selecione|tentativas|tolerância/);
  assert.throws(() => f.save({ recipientId: '5511888888888' }), /Destinatário/);
  assert.equal(f.store.listEntities('reminders').length, 0);
});

test('one due reminder persists before transport, goes only to its authorized private recipient, and cannot overlap ticks', async t => {
  const f = await fixture(t), reminder = f.save();
  f.clock.value = Date.parse('2026-10-03T13:00:00Z');
  await Promise.all([f.service.tick(), f.service.tick(), f.service.flush()]);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].number, '5511999999999');
  assert(f.calls[0].text.includes('10:00')); assert(f.calls[0].text.includes('Conferir a vitrine.'));
  assert.equal(f.store.listEntities('reminder_deliveries')[0].status, 'confirmed');
  assert.equal(f.store.getEntity('reminders', reminder.id).nextDueAt, Date.parse('2026-10-04T13:00:00Z'));
  await f.service.tick(); assert.equal(f.calls.length, 1);
});

test('configuration and confirmation survive actual SQLite reopen without duplicate submission', async t => {
  const f = await fixture(t), item = f.save({ title: 'Limpar vitrine' });
  f.clock.value = Date.parse('2026-10-03T13:00:00Z'); await f.service.tick();
  const dir = f.dir; await f.service.stop(); f.store.close();
  const reopened = await createStore(dir); t.after(() => reopened.close());
  assert.equal(reopened.getEntity('reminders', item.id).title, 'Limpar vitrine');
  assert.equal(reopened.listEntities('reminder_deliveries')[0].status, 'confirmed');
  const next = new ReminderService({ store: reopened, auth: f.auth, scheduler: f.scheduler, adapter: f.adapter, now: () => f.clock.value });
  t.after(() => next.stop()); await next.tick(); assert.equal(f.calls.length, 1);
});

test('offline skip policy discards one overdue occurrence and never catches up lost rounds', async t => {
  const f = await fixture(t, { connected: false }), item = f.save();
  f.clock.value = Date.parse('2026-10-06T15:00:00Z'); await f.service.tick();
  const deliveries = f.store.listEntities('reminder_deliveries'); assert.equal(deliveries.length, 1); assert.equal(deliveries[0].status, 'skipped'); assert.equal(deliveries[0].dueAt, Date.parse('2026-10-06T13:00:00Z'));
  f.adapter.status.state = 'connected'; await f.service.tick(); assert.equal(f.calls.length, 0);
  assert.equal(f.store.getEntity('reminders', item.id).nextDueAt, Date.parse('2026-10-07T13:00:00Z'));
});

test('overdue sendOnce sends only most recent occurrence within grace, once, with original local time', async t => {
  const f = await fixture(t, { connected: false }); f.save({ overduePolicy: 'sendOnce', overdueGraceMinutes: 120 });
  f.clock.value = Date.parse('2026-10-06T13:45:00Z'); await f.service.tick();
  assert.equal(f.calls.length, 0); assert.equal(f.store.listEntities('reminder_deliveries')[0].status, 'pending');
  f.adapter.status.state = 'connected'; await f.service.tick(); await f.service.tick();
  assert.equal(f.calls.length, 1); assert(f.calls[0].text.includes('10:00')); assert(f.calls[0].text.includes('após indisponibilidade')); assert.equal(f.store.listEntities('reminder_deliveries').length, 1);
});

test('a queued overdue reminder expires without network submission when reconnection exceeds grace', async t => {
  const f = await fixture(t, { connected: false }); f.save({ overduePolicy: 'sendOnce', overdueGraceMinutes: 120 });
  f.clock.value = Date.parse('2026-10-03T13:30:00Z'); await f.service.tick();
  f.clock.value = Date.parse('2026-10-03T16:00:00Z'); f.adapter.status.state = 'connected'; await f.service.flush();
  assert.equal(f.calls.length, 0); assert.equal(f.store.listEntities('reminder_deliveries')[0].status, 'skipped');
});

test('uncertain integration result never retries and late confirmed/delivered/read receipts reconcile without sending again', async t => {
  const f = await fixture(t, { send: () => ({ status: 'accepted' }) }); f.service.start(); const item = f.save({ enabled: false });
  const testDelivery = f.service.test(item.id, 'owner'); await f.service.waitForIdle();
  assert.equal(testDelivery.status, 'pending'); assert.equal(f.store.getEntity('reminder_deliveries', testDelivery.id).status, 'uncertain');
  await f.service.flush(); assert.equal(f.calls.length, 1);
  f.adapter.emit('receipt', { messageId: testDelivery.messageId, status: 'confirmed', confirmationScope: 'whatsapp-server' });
  assert.equal(f.store.getEntity('reminder_deliveries', testDelivery.id).status, 'confirmed');
  f.adapter.emit('receipt', { messageId: testDelivery.messageId, status: 'delivered', confirmationScope: 'whatsapp-delivered' });
  f.adapter.emit('receipt', { messageId: testDelivery.messageId, status: 'read', confirmationScope: 'whatsapp-read' });
  const ledger = f.store.getEntity('reminder_deliveries', testDelivery.id); assert.equal(ledger.status, 'delivered'); assert(ledger.readAt); assert.equal(f.calls.length, 1);
});

test('a crash in sending state becomes uncertain after restart and cannot be resent automatically', async t => {
  const f = await fixture(t, { connected: false }), item = f.save({ enabled: false });
  const delivery = f.service.test(item.id, 'owner'); await f.service.waitForIdle();
  f.store.saveEntity('reminder_deliveries', { ...delivery, status: 'sending', attempts: 1 });
  const restarted = f.create(); restarted.start(); f.adapter.status.state = 'connected'; await restarted.tick();
  assert.equal(f.store.getEntity('reminder_deliveries', delivery.id).status, 'uncertain'); assert.equal(f.calls.length, 0);
});

test('only safe failures retry with bounded configurable intervals and stable message identifier', async t => {
  const f = await fixture(t, { send: () => { throw Object.assign(new Error('secret token=should-not-log'), { code: 'WA_NETWORK', safeToRetry: true }); } });
  const item = f.save({ enabled: false, maxAttempts: 2, retryMinutes: 2 });
  const delivery = f.service.test(item.id, 'owner'); await f.service.waitForIdle();
  assert.equal(f.store.getEntity('reminder_deliveries', delivery.id).status, 'pending'); await f.service.flush(); assert.equal(f.calls.length, 1);
  f.clock.value += 120000; await f.service.flush(); assert.equal(f.calls.length, 2); assert.equal(f.calls[0].submit.clientMessageId, f.calls[1].submit.clientMessageId);
  assert.equal(f.store.getEntity('reminder_deliveries', delivery.id).status, 'failed'); await f.service.flush(); assert.equal(f.calls.length, 2);
  assert(!JSON.stringify(f.store.listEntities('diagnostics')).includes('should-not-log')); assert.equal(f.incidents.length, 1);
});

test('recipient revocation during lookup prevents transport and records a clear definitive failure', async t => {
  const f = await fixture(t, { resolve: async (number, { store }) => { store.saveEntity('users', { ...store.getEntity('users', 'owner'), active: false }); return { jid: `${number}@s.whatsapp.net`, phone: number, mode: 'whatsapp', simulation: false }; } });
  const item = f.save({ enabled: false }), delivery = f.service.test(item.id, 'owner'); await f.service.waitForIdle();
  assert.equal(f.calls.length, 0); assert.equal(f.store.getEntity('reminder_deliveries', delivery.id).status, 'failed'); assert.equal(f.store.getEntity('reminder_deliveries', delivery.id).code, 'REMINDER_RECIPIENT_DISABLED');
});

test('stop all cancels durable pending work and blocks new schedules and tests until explicit global resume', async t => {
  const f = await fixture(t, { connected: false }), item = f.save();
  f.clock.value = Date.parse('2026-10-03T13:00:00Z'); await f.service.tick(); f.gate.stopped = true;
  const stopped = f.service.stopAll({ actorId: 'owner' }); assert.equal(stopped.paused, 1); assert.equal(stopped.cancelled, 1);
  assert.throws(() => f.service.test(item.id, 'owner'), /bloquead/); assert.throws(() => f.service.activate(item.id, 'owner'), /bloquead/);
  f.adapter.status.state = 'connected'; await f.service.tick(); assert.equal(f.calls.length, 0);
  f.gate.stopped = false; f.service.activate(item.id, 'owner'); f.clock.value = Date.parse('2026-10-04T13:00:00Z'); await f.service.tick(); assert.equal(f.calls.length, 1);
});

test('stopping during recipient resolution prevents an already queued submission from reaching the network', async t => {
  let release, entered; const reached = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { resolve: number => new Promise(resolve => { release = () => resolve({ jid: `${number}@s.whatsapp.net`, phone: number, mode: 'whatsapp', simulation: false }); entered(); }) });
  const item = f.save({ enabled: false }), delivery = f.service.test(item.id, 'owner'); await reached;
  f.gate.stopped = true; const result = f.service.stopAll({ actorId: 'owner' }); assert.equal(result.cancelled, 1); release(); await f.service.waitForIdle();
  assert.equal(f.calls.length, 0); assert.equal(f.store.getEntity('reminder_deliveries', delivery.id).status, 'cancelled');
});

test('a message already in transport is reported as in flight and its eventual confirmation is preserved after stop', async t => {
  let release, entered; const reached = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { send: ({ submit }) => new Promise(resolve => { release = () => resolve({ status: 'confirmed', messageId: submit.clientMessageId }); entered(); }) });
  const item = f.save({ enabled: false }), delivery = f.service.test(item.id, 'owner'); await reached;
  f.gate.stopped = true; const stopped = f.service.stopAll({ actorId: 'owner' }); assert.equal(stopped.inFlight, 1); release(); await f.service.waitForIdle();
  assert.equal(f.calls.length, 1); assert.equal(f.store.getEntity('reminder_deliveries', delivery.id).status, 'confirmed');
});

test('editing or deleting a reminder cancels pending work without deleting confirmation ledger', async t => {
  const f = await fixture(t, { connected: false }); const item = f.save({ enabled: false }); const delivery = f.service.test(item.id, 'owner'); await f.service.waitForIdle();
  const edited = f.service.save({ id: item.id, title: 'Título editado' }, 'owner'); assert.equal(edited.scheduleRevision, item.scheduleRevision + 1); assert.equal(f.store.getEntity('reminder_deliveries', delivery.id).status, 'cancelled');
  f.service.remove(item.id, 'owner'); assert.equal(f.store.getEntity('reminders', item.id), undefined); assert(f.store.getEntity('reminder_deliveries', delivery.id));
});

test('real and simulation reminder entities, recipients and deliveries remain physically mode isolated', async t => {
  const f = await fixture(t); const real = f.save({ enabled: false }); f.service.test(real.id, 'owner'); await f.service.waitForIdle();
  f.store.setSetting('integrationMode', 'simulated'); const sim = new EventEmitter(); sim.status = { mode: 'simulated', state: 'disconnected' }; f.service.setAdapter(sim);
  assert.equal(f.service.list('owner').items.length, 0); assert.equal(f.service.history({}, 'owner').items.length, 0);
  const simulation = f.service.save({ title: 'Tarefa fictícia', time: '09:00', recipientId: 'user:owner', enabled: false }, 'owner'); assert.equal(simulation.storageMode, 'simulated');
  f.store.setSetting('integrationMode', 'whatsapp'); f.service.setAdapter(f.adapter);
  assert.equal(f.service.list('owner').items.length, 1); assert.equal(f.service.list('owner').items[0].id, real.id); assert.equal(f.calls.length, 1);
});

test('independent reminder permissions are enforced in backend for view, create, edit, control and delete', async t => {
  const f = await fixture(t); const item = f.save({ enabled: false });
  f.permissions.delete('reminder.edit'); f.service.activate(item.id, 'owner'); f.service.pause(item.id, 'owner'); assert.throws(() => f.service.save({ id: item.id, title: 'Forbidden' }, 'owner'), /Acesso/);
  f.permissions.delete('reminder.control'); assert.throws(() => f.service.test(item.id, 'owner'), /Acesso/); assert.throws(() => f.service.activate(item.id, 'owner'), /Acesso/);
  f.permissions.delete('reminder.delete'); assert.throws(() => f.service.remove(item.id, 'owner'), /Acesso/);
  f.permissions.delete('reminder.view'); assert.throws(() => f.service.list('owner'), /Acesso/); assert.throws(() => f.service.history({}, 'owner'), /Acesso/);
  f.permissions.delete('reminder.create'); assert.throws(() => f.save({ enabled: false }), /Acesso/); assert.equal(f.store.listEntities('reminders').length, 1);
});

test('a real delivery cannot fall back to a guessed recipient or simulation resolution', async t => {
  const f = await fixture(t, { resolve: number => ({ jid: `${number}@s.whatsapp.net`, phone: number, mode: 'simulated', simulation: true }) });
  const item = f.save({ enabled: false }); f.service.test(item.id, 'owner'); await f.service.waitForIdle();
  assert.equal(f.calls.length, 0); assert.equal(f.store.listEntities('reminder_deliveries')[0].code, 'WA_RECIPIENT_MISMATCH');
});

test('confirmation receipt wins a competing request error and remains non-retryable', async t => {
  const f = await fixture(t, { send: ({ adapter, submit }) => { adapter.emit('receipt', { messageId: submit.clientMessageId, status: 'confirmed', confirmationScope: 'whatsapp-server' }); throw Object.assign(new Error('request rejected late'), { safeToRetry: true }); } });
  f.service.start(); const item = f.save({ enabled: false }); f.service.test(item.id, 'owner'); await f.service.waitForIdle();
  assert.equal(f.store.listEntities('reminder_deliveries')[0].status, 'confirmed'); await f.service.flush(); assert.equal(f.calls.length, 1);
});


test('several due days while running offline retain only one pending automatic occurrence for later reconnect', async t => {
  const f = await fixture(t, { connected: false }); f.save({ overduePolicy: 'sendOnce', overdueGraceMinutes: 10080 });
  for (let day = 3; day <= 6; day++) { f.clock.value = Date.parse(`2026-10-0${day}T13:30:00Z`); await f.service.tick(); }
  assert.equal(f.store.listEntities('reminder_deliveries', { status: 'pending' }).length, 1);
  assert.equal(f.store.listEntities('reminder_deliveries', { status: 'skipped' }).length, 3);
  f.adapter.status.state = 'connected'; await f.service.flush(); assert.equal(f.calls.length, 1); assert(f.calls[0].text.includes('06/10/2026'));
});

test('configured active alert recipient is available but disabling it before a due send safely pauses the reminder', async t => {
  const f = await fixture(t); f.store.saveEntity('alert_recipients', { id: 'r1', name: 'Responsável de teste', phone: '5521999999999', enabled: true });
  const item = f.save({ recipientId: 'r1' }); f.store.saveEntity('alert_recipients', { ...f.store.getEntity('alert_recipients', 'r1'), enabled: false });
  f.clock.value = Date.parse('2026-10-03T13:00:00Z'); await f.service.tick(); assert.equal(f.calls.length, 0); assert.equal(f.store.getEntity('reminders', item.id).state, 'paused');
});

test('one-date automatic reminder completes once while preserving pending delivery until a bounded reconnect', async t => {
  const f = await fixture(t, { connected: false }); const item = f.save({ repeat: 'once', date: '2026-10-03', overduePolicy: 'sendOnce', overdueGraceMinutes: 120 });
  f.clock.value = Date.parse('2026-10-03T13:00:00Z'); await f.service.tick(); assert.equal(f.store.getEntity('reminders', item.id).state, 'completed');
  f.clock.value += 15 * 60000; f.adapter.status.state = 'connected'; await f.service.tick(); assert.equal(f.calls.length, 1);
  f.clock.value += 86400000; await f.service.tick(); assert.equal(f.calls.length, 1); assert.equal(f.store.listEntities('reminder_deliveries').length, 1);
});


test('the actual shared Scheduler and SimulatedAdapter confirm reminder transport and global queued cancellation allows explicit resume', async t => {
  const { Scheduler } = require('../src/core/scheduler.cjs');
  const { SimulatedAdapter } = require('../src/adapters/simulated.cjs');
  const { AutomationControl } = require('../src/core/automation-control.cjs');
  const f = await fixture(t, { mode: 'simulated' }); await f.service.stop();
  const adapter = new SimulatedAdapter({ store: f.store, delayMs: 0 }); await adapter.connect();
  const scheduler = new Scheduler({ store: f.store, adapter, now: () => f.clock.value, sleep: async ms => { f.clock.value += ms; } });
  const automation = new AutomationControl({ store: f.store, scheduler, now: () => f.clock.value });
  const reminders = new ReminderService({ store: f.store, auth: f.auth, scheduler, adapter, now: () => f.clock.value, isAutomationStopped: () => automation.isStopped() }); reminders.start();
  automation.register('reminders', () => reminders.stopAll({ actorId: 'owner' }));
  f.cleanup.push(async () => { await reminders.stop(); await scheduler.shutdown(); await adapter.disconnect(); });
  const item = reminders.save({ title: 'Tarefa integrada', recipientId: 'user:owner', time: '10:00', enabled: false }, 'owner');
  const delivered = reminders.test(item.id, 'owner'); await reminders.waitForIdle();
  assert.equal(adapter.sent.length, 1); assert.equal(f.store.getEntity('reminder_deliveries', delivered.id).status, 'confirmed'); assert.equal(f.store.getEntity('reminder_deliveries', delivered.id).confirmationScope, 'simulation-only');
  let entered, release; const reached = new Promise(resolve => { entered = resolve; });
  const first = scheduler.runExternalSubmission(async () => { entered(); await new Promise(resolve => { release = resolve; }); }); await reached;
  const pending = reminders.test(item.id, 'owner');
  await new Promise(resolve => setImmediate(resolve)); const report = await automation.stop({ actorId: 'owner' });
  assert.equal(report.reminders.cancelled, 1); assert.equal(f.store.getEntity('reminder_deliveries', pending.id).status, 'cancelled');
  release(); await first; await reminders.waitForIdle(); assert.equal(scheduler.persistenceFailed, false);
  assert.equal(automation.resume({ actorId: 'owner' }).stopped, false); assert.equal(adapter.sent.length, 1);
});
