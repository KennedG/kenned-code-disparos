'use strict';

// Actual SQLite and queue services. The isolated transport is simulated;
// these races do not establish delivery on a real WhatsApp account.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = process.env.KENNED_REVIEW_CODE_ROOT || path.resolve(__dirname, '..');
const { createStore, seed } = require(path.join(core, 'src/core/store.cjs'));
const { Scheduler } = require(path.join(core, 'src/core/scheduler.cjs'));
const { AlertService } = require(path.join(core, 'src/core/alerts.cjs'));
const { SearchService } = require(path.join(core, 'src/core/search-service.cjs'));
const { AuthService } = require(path.join(core, 'src/core/auth.cjs'));
const { SimulatedAdapter } = require(path.join(core, 'src/adapters/simulated.cjs'));
const turn = () => new Promise(resolve => setImmediate(resolve));
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcd-r5-shutdown-'));
  let store = await createStore(dir);
  seed(store);
  const clock = { at: Date.now() }, now = () => clock.at, sleep = async ms => { clock.at += Math.max(0, ms); };
  const auth = new AuthService({ store, clock: now });
  const owner = (await auth.setupOwner({ name: 'Teste de encerramento', username: 'shutdown-owner', phone: '5511999990001', password: 'Senha-R5-Shutdown-2026!' })).user;
  let adapter = new SimulatedAdapter({ store, delayMs: 0 }); await adapter.connect();
  let scheduler = new Scheduler({ store, adapter, now, sleep });
  let alerts = new AlertService({ store, adapter, scheduler, now, sleep });
  let searches = new SearchService({ store, adapter, authService: auth, scheduler, now, sleep });
  searches.saveSettings({ enabled: true, ownerRecipientUserId: owner.id }, owner.id);
  await searches.flushDeliveries();
  const releases = [];
  t.after(async () => {
    for (const release of releases) release();
    await Promise.allSettled([searches.shutdown(), alerts.shutdown()]);
    await scheduler.shutdown(); await adapter.disconnect(); store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const queueAlert = (id = 'shutdown-alert') => store.saveAlert({ id, recipientId: `user:${owner.id}`, number: owner.phone, text: 'Aviso de teste que deve sobreviver ao encerramento.', messageId: id.toUpperCase(), channel: 'whatsapp', createdAt: now(), nextAttemptAt: now(), originalAt: now(), status: 'pending', attempts: 0, integrationMode: 'simulated', simulation: true });
  const queueSearch = (id = 'shutdown-search') => {
    store.saveSearchRun({ id: id + '-run', actorId: owner.id, createdAt: now(), status: 'completed' });
    return store.saveSearchDelivery({ id, runId: id + '-run', actorId: owner.id, target: owner.phone + '@s.whatsapp.net', text: 'Resultado pendente de teste', clientMessageId: id.toUpperCase(), status: 'pending', createdAt: now(), attempts: 0 });
  };
  const reopen = async () => {
    await searches.shutdown(); await alerts.shutdown(); await scheduler.shutdown(); await adapter.disconnect(); store.close();
    store = await createStore(dir);
    adapter = new SimulatedAdapter({ store, delayMs: 0 }); await adapter.connect();
    scheduler = new Scheduler({ store, adapter, now, sleep });
    alerts = new AlertService({ store, adapter, scheduler, now, sleep });
    searches = new SearchService({ store, adapter, authService: auth, scheduler, now, sleep });
  };
  return { owner, queueAlert, queueSearch, reopen, releases,
    get store() { return store; }, get adapter() { return adapter; }, get scheduler() { return scheduler; }, get alerts() { return alerts; }, get searches() { return searches; } };
}

function monitorUnhandled(t) {
  const errors = [];
  const listener = error => errors.push(error);
  process.on('unhandledRejection', listener);
  t.after(() => process.off('unhandledRejection', listener));
  return errors;
}

function assertPreserved(f, id) {
  const pending = f.store.getAlert(id);
  assert.equal(pending.status, 'pending'); assert.equal(pending.attempts, 0);
  assert.equal(f.scheduler.persistenceFailed, false); assert.equal(f.store.persistenceFailed, false);
  assert.equal(f.adapter.sent.length, 0);
}

test('an alert wake-up racing scheduler shutdown remains pending and shutdown resolves without a persistence latch', { timeout: 10000 }, async t => {
  const f = await fixture(t), unhandled = monitorUnhandled(t);
  const alert = f.queueAlert();
  // Alert flushing intentionally begins in a microtask; shutdown closes the
  // scheduler synchronously before that existing producer gets its turn.
  const flushing = f.alerts.flush();
  const closing = f.scheduler.shutdown();
  await Promise.all([flushing, closing]);
  await f.alerts.shutdown(); await turn();
  assertPreserved(f, alert.id); assert.deepEqual(unhandled, []);
  const originalId = alert.messageId, originalAt = alert.originalAt;
  await f.reopen();
  assert.equal(f.store.getAlert(alert.id).messageId, originalId);
  assert.equal(f.store.getAlert(alert.id).originalAt, originalAt);
  await f.alerts.flush();
  assert.equal(f.store.getAlert(alert.id).status, 'confirmed');
  assert.equal(f.adapter.sent.length, 1);
  await f.alerts.flush(); assert.equal(f.adapter.sent.length, 1, 'the recovered notice submits once');
});

test('a private alert already queued behind another task tolerates closure of the scheduler before acquiring its turn', { timeout: 10000 }, async t => {
  const f = await fixture(t), unhandled = monitorUnhandled(t), entered = gate(), release = gate();
  f.releases.push(release.resolve);
  const preceding = f.scheduler.runExternalSubmission(async () => { entered.resolve(); await release.promise; return 'existing task completed'; }, { manual: true, controlOnly: true });
  await entered.promise;
  const alert = f.queueAlert('queued-before-close');
  const flushing = f.alerts.flush(); await turn();
  assert.equal(f.scheduler.getSubmissionQueueState().waitingPrivate, 1);
  const closing = f.scheduler.shutdown();
  release.resolve();
  assert.equal(await preceding, 'existing task completed');
  await Promise.all([flushing, closing]); await f.alerts.shutdown(); await turn();
  assertPreserved(f, alert.id); assert.deepEqual(unhandled, []);
});

test('search background wake-up after intentional scheduler closure leaves the delivery pending without reporting a spurious provider or disk failure', { timeout: 10000 }, async t => {
  const f = await fixture(t), unhandled = monitorUnhandled(t);
  const delivery = f.queueSearch();
  await f.scheduler.shutdown();
  for (let i = 0; i < 25; i++) f.searches._flushInBackground();
  await f.searches.shutdown(); await turn(); await turn();
  assert.equal(f.store.getSearchDelivery(delivery.id).status, 'pending');
  assert.equal(f.store.getSearchDelivery(delivery.id).attempts, 0);
  assert.equal(f.adapter.sent.length, 0);
  assert.equal(f.store.queryEntities('diagnostics', { code: 'SEARCH_DELIVERY_PUMP_ERROR', limit: 100 }).total, 0);
  assert.equal(f.scheduler.persistenceFailed, false); assert.equal(f.store.persistenceFailed, false);
  assert.deepEqual(unhandled, []);
});

test('a closed scheduler rejects a new external task as an intentional unsent operation rather than an ambiguous processing error', { timeout: 10000 }, async t => {
  const f = await fixture(t); await f.scheduler.shutdown();
  let called = false;
  await assert.rejects(f.scheduler.runExternalSubmission(() => { called = true; }), error => error.code === 'SUBMISSION_SERVICE_CLOSED' && error.submitted === false && error.definitive === true);
  assert.equal(called, false); assert.equal(f.scheduler.submissionHolds, 0);
  assert.equal(f.scheduler.persistenceFailed, false);
});

test('shutdown during an alert recipient lookup restores a prepared sending row to pending without sending or creating a false incident', { timeout: 10000 }, async t => {
  const f = await fixture(t), unhandled = monitorUnhandled(t), entered = gate(), release = gate();
  f.releases.push(release.resolve);
  const alert = f.queueAlert('lookup-close-alert'), states = [], local = [];
  const save = f.store.saveAlert.bind(f.store);
  f.store.saveAlert = value => { if (value.id === alert.id) states.push(value.status); return save(value); };
  f.alerts.on('localAlert', value => local.push(value));
  const resolve = f.adapter.resolveRecipient.bind(f.adapter);
  f.adapter.resolveRecipient = async (...args) => { entered.resolve(); await release.promise; return resolve(...args); };
  const flushing = f.alerts.flush(); await entered.promise;
  assert.equal(f.store.getAlert(alert.id).attempts, 1);
  const closing = f.scheduler.shutdown(); assert.equal(f.scheduler.closed, true);
  release.resolve();
  await Promise.all([flushing, closing]); await f.alerts.shutdown(); await turn();
  assert(states.includes('sending'), 'the final submission guard is exercised after preparing a sending row');
  assertPreserved(f, alert.id);
  assert.equal(f.store.getAlert(alert.id).errorCode, null);
  assert.equal(f.store.getAlert(alert.id).resultAt, null);
  assert.deepEqual(local, []); assert.deepEqual(unhandled, []);
});

test('shutdown during a search recipient lookup restores a prepared sending row to pending and creates no failure reply', { timeout: 10000 }, async t => {
  const f = await fixture(t), unhandled = monitorUnhandled(t), entered = gate(), release = gate();
  f.releases.push(release.resolve);
  const delivery = f.queueSearch('lookup-close-search'), states = [];
  const update = f.store.updateSearchDelivery.bind(f.store);
  f.store.updateSearchDelivery = (id, value) => { if (id === delivery.id && value.status) states.push(value.status); return update(id, value); };
  const resolve = f.adapter.resolveRecipient.bind(f.adapter);
  f.adapter.resolveRecipient = async (...args) => { entered.resolve(); await release.promise; return resolve(...args); };
  const flushing = f.searches.flushDeliveries(); await entered.promise;
  const closing = f.scheduler.shutdown(); assert.equal(f.scheduler.closed, true);
  release.resolve();
  await Promise.all([flushing, closing]); await f.searches.shutdown(); await turn();
  assert(states.includes('sending'), 'the final submission guard is exercised after preparing a sending row');
  const saved = f.store.getSearchDelivery(delivery.id);
  assert.equal(saved.status, 'pending'); assert.equal(saved.attempts, 0);
  assert.equal(saved.code, null); assert.equal(saved.error, null); assert.equal(saved.resultAt, null);
  assert.equal(f.adapter.sent.length, 0);
  assert.equal(f.store.listSearchDeliveries({ runId: delivery.runId, limit: 100 }).total, 1, 'no generic failure reply is queued during intentional closure');
  assert.equal(f.store.queryEntities('diagnostics', { code: 'SEARCH_DELIVERY_ERROR', limit: 100 }).total, 0);
  assert.equal(f.scheduler.persistenceFailed, false); assert.equal(f.store.persistenceFailed, false);
  assert.deepEqual(unhandled, []);
});
