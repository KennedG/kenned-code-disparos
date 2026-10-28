'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore, seed } = require('../src/core/store.cjs');
const { AuthService } = require('../src/core/auth.cjs');
const { SimulatedAdapter } = require('../src/adapters/simulated.cjs');
const { Scheduler } = require('../src/core/scheduler.cjs');
const { AutomationControl } = require('../src/core/automation-control.cjs');
const { SearchService } = require('../src/core/search-service.cjs');

const turn = () => new Promise(resolve => setImmediate(resolve));
const barrier = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-search-stop-pump-'));
  const store = await createStore(dir); seed(store);
  let clock = Date.now();
  const now = () => clock;
  const auth = new AuthService({ store, clock: now });
  const owner = (await auth.setupOwner({ name: 'Dono teste', username: 'owner', phone: '5511999990001', password: 'Senha-forte-teste-pump-2026' })).user;
  const adapter = new SimulatedAdapter({ store, delayMs: 0 }); await adapter.connect();
  const scheduler = new Scheduler({ store, adapter, now, sleep: async ms => { clock += ms; } });
  const control = new AutomationControl({ store, scheduler, now });
  const searches = new SearchService({ store, adapter, authService: auth, scheduler, now, sleep: async ms => { clock += ms; }, automationGuard: () => !control.isStopped() });
  searches.start(); searches.saveSettings({ enabled: true, privateCommandsEnabled: true, commandPrivateNumbers: [owner.phone] }, owner.id);
  control.register('search', () => searches.stopPending({ actorId: owner.id }));
  const releases = [];
  t.after(async () => {
    for (const release of releases) release.resolve();
    await searches.shutdown(); await scheduler.shutdown(); await adapter.disconnect(); store.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  await searches.waitForIdle();
  return { store, owner, adapter, scheduler, control, searches, now, barrier: () => { const result = barrier(); releases.push(result); return result; } };
}

for (const trigger of ['reconnect', 'maintenance']) {
  test(`${trigger}: global stop safely settles a search pump queued behind a manual task and explicit resume permits only new replies`, async t => {
    if (trigger === 'maintenance') t.mock.timers.enable({ apis: ['setInterval'] });
    const f = await fixture(t), entered = f.barrier(), released = f.barrier();
    const unhandled = [], track = error => unhandled.push(error);
    process.on('unhandledRejection', track); t.after(() => process.off('unhandledRejection', track));
    await f.adapter.disconnect();
    const result = await f.searches.executeSearch({ query: 'iPhone 15 Pro Max 256GB' }, f.owner.id, { deliver: true });
    const deliveryId = result.delivery[0].id;
    assert.equal(f.store.getSearchDelivery(deliveryId).status, 'pending');
    const held = f.scheduler.runExternalSubmission(async () => { entered.resolve(); await released.promise; return 'administrative-task'; }, { manual: true });
    await entered.promise;
    if (trigger === 'reconnect') await f.adapter.connect();
    else {
      // Preserve the connected state without emitting a status event so this
      // pump is started exclusively by the maintenance timer.
      f.adapter.status = { ...f.adapter.status, state: 'connected' };
      t.mock.timers.tick(30_000);
    }
    const pump = f.searches.deliveryPump;
    assert.ok(pump, 'the background trigger must enqueue a real delivery pump');
    assert.equal(f.scheduler.externalPending.size, 2);
    const settled = assert.doesNotReject(pump);
    const report = await f.control.stop({ actorId: f.owner.id, source: 'whatsapp' });
    await settled; await turn(); await turn();
    assert.deepEqual(unhandled, []);
    assert.equal(f.store.getSearchDelivery(deliveryId).status, 'cancelled');
    assert.equal(f.store.getSearchDelivery(deliveryId).code, 'AUTOMATION_STOPPED');
    assert.equal(f.store.getSearchDelivery(deliveryId).attempts, 0);
    assert.equal(f.adapter.sent.length, 0);
    assert.equal(report.search.cancelled, 1); assert.equal(report.inFlight, 0);
    assert.equal(f.scheduler.persistenceFailed, false); assert.notEqual(f.store.persistenceFailed, true);
    assert.equal(f.searches.deliveryPump, null);
    assert.ok(!f.store.queryEntities('diagnostics', { limit: 100 }).items.some(d => d.code === 'SEARCH_DELIVERY_PUMP_ERROR'));

    f.control.resume({ actorId: f.owner.id }); released.resolve();
    assert.equal(await held, 'administrative-task'); await f.scheduler.externalSubmissions;
    await f.searches.waitForIdle(); assert.equal(f.adapter.sent.length, 0, 'cancelled delivery must never be replayed after resume');
    const context = f.adapter.injectIncoming({ senderNumber: f.owner.phone, text: '!busca iPhone 15 Pro Max 256GB', timestamp: f.now() });
    await f.searches.waitForIdle();
    assert.equal(f.adapter.sent.length, 1);
    assert.equal(f.adapter.sent[0].targetId, `${f.owner.phone}@s.whatsapp.net`);
    assert.match(f.adapter.sent[0].text, /Não foram encontradas ofertas compatíveis/);
    f.adapter.injectIncoming(context); await f.searches.waitForIdle();
    assert.equal(f.adapter.sent.length, 1, 'command deduplication survives stop and resume');
    assert.equal(f.store.getSearchDelivery(deliveryId).status, 'cancelled');
  });
}

test('a reconnect pump rejection is diagnosed once without an unhandled rejection or an immediate retry loop', async t => {
  const f = await fixture(t), unhandled = [], track = error => unhandled.push(error);
  process.on('unhandledRejection', track); t.after(() => process.off('unhandledRejection', track));
  await f.adapter.disconnect();
  const result = await f.searches.executeSearch({ query: 'iPhone 15 Pro Max' }, f.owner.id, { deliver: true });
  let submissions = 0;
  const normalSubmit = f.scheduler.runExternalSubmission.bind(f.scheduler);
  f.scheduler.runExternalSubmission = () => { submissions++; return Promise.reject(Object.assign(new Error('Queue unavailable'), { code: 'QUEUE_UNAVAILABLE' })); };
  await f.adapter.connect(); await turn(); await turn();
  assert.deepEqual(unhandled, []); assert.equal(submissions, 1);
  const diagnostics = f.store.queryEntities('diagnostics', { limit: 100 }).items.filter(d => d.code === 'SEARCH_DELIVERY_PUMP_ERROR');
  assert.equal(diagnostics.length, 1); assert.equal(diagnostics[0].detail, 'QUEUE_UNAVAILABLE');
  assert.equal(f.store.getSearchDelivery(result.delivery[0].id).status, 'pending');
  assert.equal(f.store.getSearchDelivery(result.delivery[0].id).attempts, 0);
  assert.equal(f.adapter.sent.length, 0); assert.equal(f.scheduler.persistenceFailed, false);
  f.scheduler.runExternalSubmission = normalSubmit;
  await f.searches.flushDeliveries();
  assert.equal(f.adapter.sent.length, 1); assert.equal(f.store.getSearchDelivery(result.delivery[0].id).status, 'confirmed');
});

test('background setup errors remain contained even if the diagnostic store is also unavailable', async t => {
  const f = await fixture(t), unhandled = [], track = error => unhandled.push(error);
  process.on('unhandledRejection', track); t.after(() => process.off('unhandledRejection', track));
  const flush = f.searches.flushDeliveries.bind(f.searches), diagnostic = f.searches._diagnostic.bind(f.searches);
  f.searches.flushDeliveries = () => { throw Object.assign(new Error('Setup failed'), { code: 'QUEUE_SETUP_FAILED' }); };
  f.searches._diagnostic = () => { throw new Error('Diagnostics disk unavailable'); };
  assert.doesNotThrow(() => f.searches._onStatus({ state: 'connected' }));
  await turn(); await turn(); assert.deepEqual(unhandled, []);
  f.searches.flushDeliveries = flush; f.searches._diagnostic = diagnostic;
});
