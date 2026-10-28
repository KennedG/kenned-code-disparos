'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Scheduler, isWithinSchedule, nextScheduledAt, nextRoundSlot } = require('../src/core/scheduler.cjs');

const copy = value => value === undefined ? undefined : structuredClone(value);
const at = (day = 5, hour = 9, minute = 0) => new Date(2026, 0, day, hour, minute).getTime();

class MemoryStore {
  constructor() {
    this.campaigns = new Map(); this.groups = new Map(); this.media = new Map();
    this.jobs = new Map(); this.rounds = new Map(); this.settings = new Map();
  }
  getSetting(key, fallback) { return this.settings.has(key) ? this.settings.get(key) : fallback; }
  getCampaign(id) { return copy(this.campaigns.get(id)); }
  listCampaigns() { return [...this.campaigns.values()].map(copy); }
  saveCampaign(c) { const saved = { ...copy(c), revision: (this.campaigns.get(c.id)?.revision || 0) + 1 }; this.campaigns.set(c.id, saved); return copy(saved); }
  getGroup(id) { return copy(this.groups.get(id)); }
  getMedia(id) { return copy(this.media.get(id)); }
  insertRound(r) { assert(!this.rounds.has(r.id)); this.rounds.set(r.id, copy(r)); }
  updateRound(id, patch) { this.rounds.set(id, { ...this.rounds.get(id), ...copy(patch) }); }
  listRounds(id) { return [...this.rounds.values()].filter(r => !id || r.campaignId === id).map(copy); }
  insertJob(j) { assert(!this.jobs.has(j.id)); this.jobs.set(j.id, copy(j)); }
  updateJob(id, patch) { this.jobs.set(id, { ...this.jobs.get(id), ...copy(patch) }); }
  getJob(id) { return copy(this.jobs.get(id)); }
  listJobs(filter = {}) { return [...this.jobs.values()].filter(j => Object.entries(filter).every(([k, v]) => k === 'limit' || v === undefined || j[k] === v)).map(copy); }
}

function fixture({ count = 2, changes = {}, sender } = {}) {
  const store = new MemoryStore();
  const clock = { value: at() };
  const adapter = new EventEmitter();
  adapter.status = { state: 'connected', mode: 'simulated' };
  const calls = [];
  adapter.send = async (groupId, item, media) => {
    const persisted = store.listJobs().find(j => j.messageId === item.clientMessageId);
    assert(persisted, 'Message identifier must be durable before network submission');
    assert.equal(persisted.status, 'sending');
    assert.equal(persisted.attempts > 0, true);
    calls.push({ groupId, item: copy(item), media: copy(media), at: clock.value });
    if (sender) return sender({ groupId, item, media, store, clock, adapter, calls });
    return { status: 'confirmed', messageId: item.clientMessageId };
  };
  const groupIds = Array.from({ length: count }, (_, i) => `g${i + 1}`);
  for (const id of groupIds) store.groups.set(id, { id, name: `Grupo ${id}`, authorized: true, simulation: true });
  store.media.set('m1', { id: 'm1', type: 'image', name: 'cartaz.jpg', path: '/managed/cartaz.jpg' });
  const c = {
    id: 'c1', name: 'Campanha teste', state: 'draft', mode: 'repeat',
    intervalMinutes: 10, spacingSeconds: 3,
    schedule: { days: [0,1,2,3,4,5,6], startTime: '00:00', endTime: '00:00', startDate: '', endDate: '' },
    dailyRoundLimit: 0, dailySendLimit: 0, groupIds,
    items: [{ id: 'i1', type: 'text', text: 'Olá 😊\n*Oferta* https://example.com' }],
    groupOverrides: {}, roundIndex: 0, nextRunAt: null, ...changes
  };
  store.saveCampaign(c);
  const sleeps = [];
  const scheduler = new Scheduler({ store, adapter, now: () => clock.value, sleep: async ms => { sleeps.push(ms); clock.value += ms; } });
  return { store, clock, adapter, scheduler, calls, sleeps };
}

test('creating a campaign never activates it; 15 authorized destinations preserve media/text order', async () => {
  const f = fixture({ count: 15, changes: { items: [
    { id: 'i1', type: 'text', text: 'Olá 😊\n*Promoção*' },
    { id: 'i2', type: 'image', mediaId: 'm1', caption: 'Legenda' },
    { id: 'i3', type: 'text', text: 'Fim' }
  ] } });
  await f.scheduler.tick();
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.getCampaign('c1').state, 'draft');
  await f.scheduler.activate('c1');
  await f.scheduler.tick();
  assert.equal(f.calls.length, 45);
  assert.deepEqual(f.calls.slice(0, 3).map(c => c.item.id), ['i1', 'i2', 'i3']);
  assert.equal(f.calls[1].media.path, '/managed/cartaz.jpg');
  assert.equal(f.calls[1].item.caption, 'Legenda');
  assert.equal(new Set(f.store.listJobs().map(j => j.id)).size, 45);
  assert.equal(new Set(f.store.listJobs().map(j => j.messageId)).size, 45);
  assert(f.store.listJobs().every(j => j.status === 'accepted'));
  assert.equal(f.store.getCampaign('c1').nextRunAt, at(5, 9, 10));
});

test('interval counts from round start; separate spacing is enforced and early ticks do nothing', async () => {
  const f = fixture({ changes: { spacingSeconds: 5 } });
  await f.scheduler.activate('c1'); await f.scheduler.tick();
  assert.deepEqual(f.calls.map(c => c.at), [at(), at() + 5000]);
  f.clock.value = at(5, 9, 9) + 59000;
  await f.scheduler.tick(); assert.equal(f.calls.length, 2);
  f.clock.value = at(5, 9, 10);
  await f.scheduler.tick(); assert.equal(f.calls.length, 4);
  assert.equal(f.store.listRounds('c1')[1].startedAt, at(5, 9, 10));
});

test('a slow round skips elapsed slots with no simultaneous round or backlog', async () => {
  const f = fixture({ sender: ({ clock, item }) => { clock.value += 650000; return { status: 'confirmed', messageId: item.clientMessageId }; } });
  await f.scheduler.activate('c1'); await f.scheduler.tick();
  assert.equal(f.store.listRounds('c1').length, 1);
  assert.equal(f.store.getCampaign('c1').nextRunAt, at(5, 9, 30));
  await f.scheduler.tick();
  assert.equal(f.store.listRounds('c1').length, 1);
  assert.equal(nextRoundSlot(0, 1300000, 600000), 1800000);
  assert.equal(nextRoundSlot(0, 600000, 600000), 600000, 'An exactly completed slot needs no extra idle interval');
});

test('one global worker serializes campaigns and concurrent ticks', async () => {
  let release;
  const f = fixture({ count: 1, sender: async ({ item }) => {
    await new Promise(resolve => { release = resolve; });
    return { status: 'confirmed', messageId: item.clientMessageId };
  } });
  f.store.saveCampaign({ ...f.store.getCampaign('c1'), id: 'c2', name: 'Segunda', state: 'draft' });
  await f.scheduler.activate('c1'); await f.scheduler.activate('c2');
  const p1 = f.scheduler.tick(); const p2 = f.scheduler.tick();
  assert.equal(p1, p2); assert.equal(f.calls.length, 1);
  release(); await Promise.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 2);
  release(); await p1;
  assert.deepEqual(f.store.listRounds().map(r => r.campaignId), ['c1', 'c2']);
});

test('a synchronous transport event cannot reenter the worker and create a second round', async () => {
  let scheduler;
  let nested;
  const f = fixture({ count: 1, sender: ({ item }) => {
    nested = scheduler.tick();
    return { status: 'confirmed', messageId: item.clientMessageId };
  } });
  scheduler = f.scheduler;
  await scheduler.activate('c1'); await scheduler.tick(); await nested;
  assert.equal(f.calls.length, 1); assert.equal(f.store.listRounds().length, 1);
});

test('a durable queue write failure blocks submissions and further activation', async () => {
  const f = fixture();
  const insert = f.store.insertJob.bind(f.store);
  let written = 0;
  f.store.insertJob = job => { if (++written === 2) throw new Error('disk write failure'); insert(job); };
  await f.scheduler.activate('c1');
  await assert.rejects(f.scheduler.tick(), /disk write failure/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.getCampaign('c1').state, 'paused');
  assert.equal(f.store.listJobs({ status: 'cancelled' }).length, 1);
  await assert.rejects(f.scheduler.resume('c1'), /persistência/);
  await f.scheduler.tick(); assert.equal(f.calls.length, 0);
});

test('pause cancels pending destinations, allows the in-flight result to settle, and resume avoids recent duplicates', async () => {
  let release;
  const f = fixture({ sender: async ({ item }) => {
    await new Promise(resolve => { release = resolve; });
    return { status: 'confirmed', messageId: item.clientMessageId };
  } });
  await f.scheduler.activate('c1');
  const run = f.scheduler.tick();
  await f.scheduler.pause('c1');
  assert.equal(f.store.listJobs({ status: 'cancelled' }).length, 1);
  release(); await run;
  assert.equal(f.calls.length, 1); assert.equal(f.store.listJobs({ status: 'accepted' }).length, 1);
  f.adapter.send = async (groupId, item) => { f.calls.push({ groupId, item }); return { status: 'confirmed', messageId: item.clientMessageId }; };
  await f.scheduler.resume('c1'); await f.scheduler.tick();
  assert.deepEqual(f.calls.map(c => c.groupId), ['g1', 'g2']);
});

test('stop all interrupts a wait immediately and does not leave active campaigns', async () => {
  let asleep;
  const f = fixture();
  f.scheduler.sleep = ms => new Promise(resolve => { asleep = { ms, resolve }; });
  await f.scheduler.activate('c1'); const run = f.scheduler.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert(asleep);
  await f.scheduler.stopAll(); await run;
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.getCampaign('c1').state, 'stopped');
  assert.equal(f.store.listJobs({ status: 'cancelled' }).length, 1);
  asleep.resolve();
});

test('emergency stop aborts the current campaign before an earlier campaign persistence failure', async () => {
  let release;
  const f = fixture({ sender: async ({ item }) => {
    await new Promise(resolve => { release = resolve; });
    return { status: 'confirmed', messageId: item.clientMessageId };
  } });
  f.store.saveCampaign({ ...f.store.getCampaign('c1'), state: 'paused' });
  f.store.saveCampaign({ ...f.store.getCampaign('c1'), id: 'c2', name: 'Em execução', state: 'draft' });
  await f.scheduler.activate('c2');
  const run = f.scheduler.tick();
  assert.equal(f.calls.length, 1);
  const save = f.store.saveCampaign.bind(f.store);
  let failed = false;
  f.store.saveCampaign = campaign => {
    if (campaign.id === 'c1' && !failed) { failed = true; throw new Error('disk write failure'); }
    return save(campaign);
  };
  await assert.rejects(f.scheduler.stopAll(), /disk write failure/);
  assert.equal(f.scheduler.currentRound.controller.signal.aborted, true);
  release(); await run;
  assert.equal(f.calls.length, 1, 'A later active campaign must not continue after emergency stop fails to persist');
  assert.equal(f.scheduler.persistenceFailed, true);
  await assert.rejects(f.scheduler.resume('c2'), /persistência/);
  await f.scheduler.tick(); assert.equal(f.calls.length, 1);
});

test('a persistence failure after transport settlement blocks all later submissions even if another write succeeds', async () => {
  const f = fixture();
  const update = f.store.updateJob.bind(f.store);
  let failed = false;
  f.store.updateJob = (id, patch) => {
    if (patch.status === 'accepted' && !failed) { failed = true; throw new Error('disk write failure'); }
    return update(id, patch);
  };
  await f.scheduler.activate('c1'); await f.scheduler.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.scheduler.persistenceFailed, true);
  assert.equal(f.store.getCampaign('c1').state, 'paused');
  await assert.rejects(f.scheduler.resume('c1'), /persistência/);
});

test('a late receipt persistence failure blocks sending without throwing from a transport event', async () => {
  const f = fixture({ sender: ({ item }) => ({ status: 'uncertain', messageId: item.clientMessageId }) });
  await f.scheduler.activate('c1'); await f.scheduler.tick();
  const job = f.store.listJobs({ status: 'uncertain' })[0];
  f.store.updateJob = () => { throw new Error('disk write failure'); };
  assert.doesNotThrow(() => f.adapter.emit('receipt', { status: 'confirmed', messageId: job.messageId }));
  assert.equal(f.scheduler.persistenceFailed, true);
  assert.equal(f.store.getJob(job.id).status, 'uncertain');
  await assert.rejects(f.scheduler.resume('c1'), /persistência/);
});

test('a storage fault outside the scheduler blocks ticks and activation without repeated persistence attempts', async () => {
  const f = fixture();
  await f.scheduler.activate('c1');
  f.store.persistenceFailed = true;
  let writes = 0;
  f.store.saveCampaign = () => { writes++; throw new Error('storage unavailable'); };
  await f.scheduler.tick(); await f.scheduler.tick();
  assert.equal(f.calls.length, 0);
  assert.equal(writes, 0);
  assert.equal(f.scheduler.persistenceFailed, true);
  await assert.rejects(f.scheduler.activate('c1'), /persistência/);
  await assert.rejects(f.scheduler.resume('c1'), /persistência/);
});

test('real storage: a settings write fault immediately before transport prevents the network request', async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createStore } = require('../src/core/store.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-before-submission-fault-'));
  let injectFault = false;
  const store = await createStore(dir, { beforeWrite: () => { if (injectFault) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const example = fixture({ count: 1 });
  store.setSetting('integrationMode','simulated');
  store.upsertGroups([...example.store.groups.values()]);
  store.saveCampaign(example.store.getCampaign('c1'));
  let submissions = 0;
  const adapter = new EventEmitter();
  adapter.status = { state: 'connected', mode: 'simulated' };
  adapter.send = async (_, item) => { submissions++; return { status: 'confirmed', messageId: item.clientMessageId }; };
  const scheduler = new Scheduler({ store, adapter, now: () => example.clock.value });
  await scheduler.activate('c1');
  let faultInjected = false;
  scheduler.on('change', () => {
    if (faultInjected || !store.listJobs({ status: 'sending' }).length) return;
    faultInjected = true;
    injectFault = true;
    assert.throws(() => store.setSetting('theme', 'light'), /disk full/);
  });
  await assert.rejects(scheduler.tick(), /Armazenamento indisponível/);
  assert.equal(faultInjected, true);
  assert.equal(store.persistenceFailed, true);
  assert.equal(submissions, 0, 'A settings failure after durable queueing must still prevent transport submission');
  assert.equal(scheduler.persistenceFailed, true);
  await assert.rejects(scheduler.resume('c1'), /persistência/);
  await scheduler.tick(); assert.equal(submissions, 0);
});

test('waitForIdle settles the in-flight result before callers replace persistent data', async () => {
  let release;
  const f = fixture({ sender: async ({ item }) => {
    await new Promise(resolve => { release = resolve; });
    return { status: 'confirmed', messageId: item.clientMessageId };
  } });
  await f.scheduler.activate('c1'); const run = f.scheduler.tick();
  await f.scheduler.stopAll();
  let idle = false;
  const waiting = f.scheduler.waitForIdle().then(() => { idle = true; });
  await Promise.resolve(); assert.equal(idle, false);
  release(); await run; await waiting;
  assert.equal(idle, true);
  assert.equal(f.store.listJobs({ status: 'accepted' }).length, 1);
  assert.equal(f.store.listJobs({ status: 'cancelled' }).length, 1);
  assert.equal(f.scheduler.busy, false);
});

test('disconnection pauses active campaigns and prevents pending sends or disconnected activation', async () => {
  const f = fixture({ sender: ({ adapter, item }) => {
    adapter.status = { ...adapter.status, state: 'disconnected' };
    adapter.emit('status', adapter.status);
    return { status: 'confirmed', messageId: item.clientMessageId };
  } });
  await f.scheduler.activate('c1'); await f.scheduler.tick();
  assert.equal(f.calls.length, 1); assert.equal(f.store.getCampaign('c1').state, 'paused');
  await assert.rejects(f.scheduler.resume('c1'), /Conecte/);
});

test('uncertain outcome does not block other destinations and is not repeated; late server receipt reconciles', async () => {
  const f = fixture({ sender: ({ groupId, item }) => ({ status: groupId === 'g1' ? 'uncertain' : 'confirmed', messageId: item.clientMessageId }) });
  await f.scheduler.activate('c1'); await f.scheduler.tick();
  assert.equal(f.calls.length, 2); assert.equal(f.store.getCampaign('c1').state, 'active');
  f.clock.value += 3600000; await f.scheduler.tick(); assert.equal(f.calls.length, 3);
  assert.equal(f.calls.filter(call => call.groupId === 'g1').length, 1);
  const uncertain = f.store.listJobs({ status: 'uncertain' })[0];
  f.adapter.emit('receipt', { status: 'confirmed', messageId: uncertain.messageId });
  assert.equal(f.store.getJob(uncertain.id).status, 'accepted');
  assert.equal(f.store.getCampaign('c1').state, 'active');
});

test('ambiguous exceptions have one attempt and do not expose adapter secrets in history', async () => {
  const f = fixture({ sender: () => { throw new Error('session secret PRIVATE_KEY'); } });
  await f.scheduler.activate('c1'); await f.scheduler.tick();
  assert.equal(f.calls.length, 2);
  const job = f.store.listJobs({ status: 'uncertain' })[0];
  assert.equal(job.attempts, 1); assert(!job.error.includes('PRIVATE_KEY'));
});

test('only definitive pre-submission failures get bounded retries using the same durable message ID', async () => {
  const f = fixture({ sender: ({ groupId, item }) => {
    if (groupId === 'g1') throw Object.assign(new Error('temporary'), { safeToRetry: true });
    return { status: 'confirmed', messageId: item.clientMessageId };
  } });
  await f.scheduler.activate('c1'); await f.scheduler.tick();
  assert.deepEqual(f.calls.map(c => c.groupId), ['g1', 'g1', 'g1', 'g2']);
  assert.equal(new Set(f.calls.slice(0, 3).map(c => c.item.clientMessageId)).size, 1);
  assert.equal(f.store.listJobs({ status: 'failed' })[0].attempts, 3);
  assert.equal(f.store.listJobs({ status: 'accepted' }).length, 1);
  assert.equal(f.store.getCampaign('c1').state, 'active', 'Other eligible destinations remain active after a group exhausts retries');
  assert.equal(f.store.getCampaign('c1').destinationHealth.g1.suspended, true);
  assert(f.sleeps.every(ms => ms >= 3000));
});

test('a retry never submits after the group operating window has closed', async () => {
  const f = fixture({ count: 1, changes: {
    schedule: { days: [1], startTime: '09:00', endTime: '10:00', endDate: '2026-01-05' }
  }, sender: () => { throw Object.assign(new Error('before submission'), { safeToRetry: true }); } });
  f.clock.value = at(5, 9, 59) + 59000;
  await f.scheduler.activate('c1'); await f.scheduler.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.listJobs()[0].attempts, 1);
  assert.equal(f.store.listJobs()[0].status, 'cancelled');
  assert.equal(f.store.getCampaign('c1').state, 'stopped');
});

test('a retry rechecks the individual group end date before another network request', async () => {
  const f = fixture({ count: 1, changes: {
    groupOverrides: { g1: { enabled: true, schedule: { endDate: '2026-01-05' } } }
  }, sender: () => { throw Object.assign(new Error('before submission'), { safeToRetry: true }); } });
  f.clock.value = at(5, 23, 59) + 59000;
  await f.scheduler.activate('c1'); await f.scheduler.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.listJobs()[0].attempts, 1);
  assert.equal(f.store.getCampaign('c1').state, 'stopped');
});

test('a restriction stops attempts even when a failure was definitely before submission', async () => {
  const f = fixture({ sender: () => { throw Object.assign(new Error('rate restricted'), { safeToRetry: true, restricted: true }); } });
  await f.scheduler.activate('c1'); await f.scheduler.tick();
  assert.equal(f.calls.length, 1); assert.equal(f.store.getCampaign('c1').state, 'paused');
});

test('daily send and round limits defer to the next local day instead of accumulating slots', async () => {
  const f = fixture({ changes: { dailySendLimit: 1 } });
  await f.scheduler.activate('c1'); await f.scheduler.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.getCampaign('c1').nextRunAt, at(6, 0));
  f.clock.value = at(6, 0); await f.scheduler.tick();
  assert.equal(f.calls.length, 2);
  const g = fixture({ changes: { dailyRoundLimit: 1 } });
  await g.scheduler.activate('c1'); await g.scheduler.tick();
  g.clock.value = at(5, 20); await g.scheduler.tick();
  assert.equal(g.store.listRounds().length, 1);
  assert.equal(g.store.getCampaign('c1').nextRunAt, at(6, 0));
});

test('a simulated suspension creates one current round rather than all missed rounds', async () => {
  const f = fixture({ count: 1 });
  await f.scheduler.activate('c1'); await f.scheduler.tick();
  f.clock.value = at(6, 9); await f.scheduler.tick();
  assert.equal(f.calls.length, 2); assert.equal(f.store.listRounds().length, 2);
  assert.equal(f.store.getCampaign('c1').nextRunAt, at(6, 9, 10));
});

test('group override intervals can be shorter and rotation advances per group participation', async () => {
  const f = fixture({ changes: {
    mode: 'rotate', items: [{ id: 'a', type: 'text', text: 'A' }, { id: 'b', type: 'text', text: 'B' }],
    groupOverrides: { g2: { enabled: true, intervalMinutes: 5, items: [{ id: 'x', type: 'text', text: 'X' }, { id: 'y', type: 'text', text: 'Y' }] } }
  } });
  await f.scheduler.activate('c1'); await f.scheduler.tick();
  f.clock.value = at(5, 9, 5); await f.scheduler.tick();
  f.clock.value = at(5, 9, 10); await f.scheduler.tick();
  assert.deepEqual(f.calls.filter(c => c.groupId === 'g1').map(c => c.item.text), ['A', 'B']);
  assert.deepEqual(f.calls.filter(c => c.groupId === 'g2').map(c => c.item.text), ['X', 'Y', 'X']);
});

test('individual windows run independently, including outside the main campaign window', async () => {
  const f = fixture({ changes: {
    schedule: { days: [1], startTime: '10:00', endTime: '11:00' },
    groupOverrides: { g2: { enabled: true, schedule: { startTime: '09:00', endTime: '09:30' } } }
  } });
  await f.scheduler.activate('c1'); await f.scheduler.tick();
  assert.deepEqual(f.calls.map(c => c.groupId), ['g2']);
  f.clock.value = at(5, 10); await f.scheduler.tick();
  assert.deepEqual(f.calls.map(c => c.groupId), ['g2', 'g1']);
});

test('local weekday, inclusive dates and overnight windows use the opening day', () => {
  const schedule = { days: [1], startTime: '22:00', endTime: '06:00', startDate: '2026-01-05', endDate: '2026-01-05' };
  assert(isWithinSchedule(at(5, 22), schedule));
  assert(isWithinSchedule(at(6, 5, 59), schedule));
  assert(!isWithinSchedule(at(6, 6), schedule));
  assert(!isWithinSchedule(at(5, 21), schedule));
  assert.equal(nextScheduledAt(at(5, 9), schedule), at(5, 22));
  assert.equal(nextScheduledAt(at(6, 6), schedule), Infinity);
  assert.equal(nextScheduledAt(at(5, 9), { days: [1], startTime: '08:00', endTime: '18:00', startDate: '2026-02-02' }), new Date(2026, 1, 2, 8).getTime());
});

test('expired scheduling stops rather than replaying previous dates', async () => {
  const f = fixture({ count: 1, changes: { schedule: { days: [1], startTime: '09:00', endTime: '10:00', endDate: '2026-01-05' } } });
  await f.scheduler.activate('c1'); await f.scheduler.tick();
  f.clock.value = at(6, 9); await f.scheduler.tick();
  assert.equal(f.calls.length, 1); assert.equal(f.store.getCampaign('c1').state, 'stopped');
});

test('restart marks in-flight work uncertain and stale queued work cancelled without any submission', async () => {
  const f = fixture();
  f.store.saveCampaign({ ...f.store.getCampaign('c1'), state: 'active', nextRunAt: at() });
  f.store.insertRound({ id: 'r', campaignId: 'c1', startedAt: at(), status: 'running' });
  f.store.insertJob({ id: 'old-sending', roundId: 'r', campaignId: 'c1', groupId: 'g1', itemId: 'i1', itemSnapshot: { id: 'i1', type: 'text', text: 'Olá' }, status: 'sending', attempts: 1, createdAt: at(), messageId: 'old' });
  f.store.insertJob({ id: 'old-queued', roundId: 'r', campaignId: 'c1', groupId: 'g2', itemId: 'i1', itemSnapshot: { id: 'i1', type: 'text', text: 'Olá' }, status: 'queued', attempts: 0, createdAt: at() });
  const restarted = new Scheduler({ store: f.store, adapter: f.adapter, now: () => f.clock.value });
  await restarted.tick();
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.getJob('old-sending').status, 'uncertain');
  assert.equal(f.store.getJob('old-queued').status, 'cancelled');
  assert.equal(f.store.getCampaign('c1').state, 'paused');
  await restarted.resume('c1');
  assert.equal(f.calls.length, 0, 'Resuming does not replay an uncertain or cancelled old task');
  assert.equal(f.store.getCampaign('c1').state, 'active');
});

test('activation rejects unauthorized, mixed integration groups, invalid limits, duplicate destinations and missing media', async () => {
  const f = fixture();
  f.store.groups.set('g1', { ...f.store.groups.get('g1'), authorized: false });
  await assert.rejects(f.scheduler.activate('c1'), /autorização/);
  f.store.groups.set('g1', { ...f.store.groups.get('g1'), authorized: true, simulation: false });
  await assert.rejects(f.scheduler.activate('c1'), /misturados/);
  f.store.groups.set('g1', { ...f.store.groups.get('g1'), simulation: true });
  f.store.saveCampaign({ ...f.store.getCampaign('c1'), dailySendLimit: -1 });
  await assert.rejects(f.scheduler.activate('c1'), /limites/);
  f.store.saveCampaign({ ...f.store.getCampaign('c1'), dailySendLimit: 0, groupIds: ['g1', 'g1'] });
  await assert.rejects(f.scheduler.activate('c1'), /repetidos/);
  f.store.saveCampaign({ ...f.store.getCampaign('c1'), groupIds: ['g1'], items: [{ id: 'img', type: 'image', mediaId: 'missing' }] });
  await assert.rejects(f.scheduler.activate('c1'), /biblioteca/);
});

test('summary includes content, authorized groups, frequency, individual settings and sending estimate', () => {
  const f = fixture({ changes: { groupOverrides: { g2: { enabled: true, intervalMinutes: 20 } } } });
  const summary = f.scheduler.getSummary('c1');
  for (const expected of ['Olá 😊', 'Grupo g1', '10 min', '3 s', 'Estimativa máxima:', '20 min', 'sem suspensão']) assert(summary.includes(expected), expected);
});

test('campaign retry policy controls attempts and delay; exhausted failures emit one durable incident per destination', async () => {
  const f = fixture({ changes: { retryPolicy: { maxAttempts: 2, delaySeconds: 8 }, ownerId: 'owner-1' }, sender: () => { throw Object.assign(new Error('SECRET_TOKEN'), { safeToRetry: true, code: 'WA_TEMPORARY' }); } });
  const incidents = [], diagnostics = [];
  f.store.addDiagnostic = value => { diagnostics.push(copy(value)); return value; };
  f.scheduler.on('destinationFailure', value => { assert.equal(f.store.getCampaign('c1').destinationHealth[value.groupId].suspended, true); assert.equal(f.store.getCampaign('c1').destinationHealth[value.groupId].code, value.code); incidents.push(copy(value)); });
  await f.scheduler.activate('c1'); await f.scheduler.tick(); await f.scheduler.tick();
  assert.equal(f.calls.length, 4); assert.deepEqual(f.sleeps, [8000, 3000, 8000]);
  assert.equal(f.store.getCampaign('c1').state, 'paused', 'All destinations exhausted; no tasks remain eligible');
  assert.equal(f.store.listJobs({ status: 'failed' }).length, 2);
  assert.equal(incidents.length, 2); assert.deepEqual(incidents.map(x => x.groupId), ['g1', 'g2']);
  assert.equal(incidents[0].code, 'WA_TEMPORARY');
  assert.equal(diagnostics.length, 4); assert.equal(diagnostics[1].attempts, 2);
  assert(!JSON.stringify({ incidents, diagnostics }).includes('SECRET_TOKEN'));
});

test('a known definitive nonretryable item error is recorded once per task and does not abort unrelated tasks', async () => {
  const f = fixture({ sender: () => { throw Object.assign(new Error('invalid media'), { safeToRetry: false, definitive: true, code: 'WA_VALIDATION' }); } });
  const incidents = []; f.scheduler.on('incident', x => incidents.push(x));
  await f.scheduler.activate('c1'); await f.scheduler.tick();
  assert.equal(f.calls.length, 2); assert.equal(f.store.listJobs({ status: 'failed' }).length, 2);
  assert.equal(f.store.getCampaign('c1').state, 'active'); assert.equal(incidents.length, 0);
  assert(f.store.listJobs().every(job => job.attempts === 1));
});

test('a temporary failure which succeeds within the configured policy preserves campaign progression', async () => {
  const f = fixture({ changes: { retryPolicy: { maxAttempts: 2, delaySeconds: 7 } }, sender: ({ calls, item }) => {
    if (calls.length === 1) throw Object.assign(new Error('temporary'), { safeToRetry: true });
    return { status: 'confirmed', messageId: item.clientMessageId };
  } });
  const incidents = []; f.scheduler.on('incident', x => incidents.push(x));
  await f.scheduler.activate('c1'); await f.scheduler.tick();
  assert.deepEqual(f.calls.map(x => x.groupId), ['g1', 'g1', 'g2']);
  assert.equal(f.store.listJobs({ status: 'accepted' }).length, 2); assert.equal(incidents.length, 0);
});

test('idempotent timer startup and a private-alert submission hold cannot duplicate campaign work', async () => {
  const f = fixture({ count: 1 });
  f.scheduler.start(); const timer = f.scheduler.timer; f.scheduler.start(); assert.equal(f.scheduler.timer, timer);
  await f.scheduler.activate('c1'); const release = f.scheduler.holdSubmissions();
  await f.scheduler.tick(); assert.equal(f.calls.length, 0);
  release(); release(); assert.equal(f.scheduler.submissionHolds, 0);
  await f.scheduler.tick(); assert.equal(f.calls.length, 1);
  await f.scheduler.shutdown(); assert.equal(f.scheduler.timer, null);
});

test('indexed aggregate queries replace loading old history and accept compact group round counts', async () => {
  const f = fixture({ count: 1, changes: { mode: 'rotate', items: [{ id: 'one', type: 'text', text: 'Primeiro' }, { id: 'two', type: 'text', text: 'Segundo' }] } });
  f.store.getCampaignCounts = () => ({ rounds: 0, sends: 0 });
  f.store.getGroupHistory = () => new Map([['g1', { lastAt: at() - 600000, roundCount: 100001 }]]);
  f.store.listRounds = () => { throw new Error('Full history load must not occur'); };
  await f.scheduler.activate('c1'); await f.scheduler.tick();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].item.id, 'two');
});
