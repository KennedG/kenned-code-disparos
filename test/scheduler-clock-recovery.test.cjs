'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Scheduler, nextComputerRoundSlot } = require('../src/core/scheduler.cjs');
const { computerDateKey, computerClockStatus } = require('../src/core/computer-schedule.cjs');
const { createStore } = require('../src/core/store.cjs');

const local = (hour = 8, minute = 0, day = 5, second = 0) => new Date(2026, 0, day, hour, minute, second).getTime();
const clone = value => value === undefined ? undefined : structuredClone(value);
class MemoryStore {
  constructor() { this.campaigns = new Map(); this.jobs = new Map(); this.rounds = new Map(); this.settings = new Map(); this.groups = new Map(); this.diagnostics = []; }
  getSetting(k, fallback) { return this.settings.has(k) ? clone(this.settings.get(k)) : clone(fallback); }
  setSetting(k, value) { this.settings.set(k, clone(value)); }
  getCampaign(id) { return clone(this.campaigns.get(id)); }
  listCampaigns() { return [...this.campaigns.values()].map(clone); }
  saveCampaign(c) { const saved = { ...clone(c), revision: (this.campaigns.get(c.id)?.revision || 0) + 1 }; this.campaigns.set(c.id, saved); return clone(saved); }
  getGroup(id) { return clone(this.groups.get(id)); }
  getMedia() { return null; }
  listJobs(filter = {}) { return [...this.jobs.values()].filter(j => Object.entries(filter).every(([k,v]) => k === 'limit' || v === undefined || j[k] === v)).slice(0, filter.limit || Infinity).map(clone); }
  insertJob(j) { assert(!this.jobs.has(j.id)); this.jobs.set(j.id, clone(j)); return clone(j); }
  updateJob(id, patch) { this.jobs.set(id, { ...this.jobs.get(id), ...clone(patch) }); }
  getJob(id) { return clone(this.jobs.get(id)); }
  insertRound(r) { assert(!this.rounds.has(r.id)); this.rounds.set(r.id, clone(r)); }
  updateRound(id, patch) { this.rounds.set(id, { ...this.rounds.get(id), ...clone(patch) }); }
  listRounds(id) { return [...this.rounds.values()].filter(r => !id || r.campaignId === id).map(clone); }
  addDiagnostic(d) { this.diagnostics.push(clone(d)); }
}

function fixture({ at = local(), count = 2, campaign = {}, store = new MemoryStore(), sender, licenseGuard = () => {}, monotonicNow } = {}) {
  const clock = { at };
  if (store.setSetting) store.setSetting('integrationMode', 'simulated');
  const groups = Array.from({ length: count }, (_, i) => ({ id: `g${i + 1}@simulation`, name: `Grupo teste ${i + 1}`, authorized: true, simulation: true }));
  if (store.upsertGroups) store.upsertGroups(groups); else for (const g of groups) store.groups.set(g.id, g);
  const c = { id: 'c', name: 'Rodadas autorizadas', storageMode: 'simulated', state: 'draft', mode: 'repeat', intervalMinutes: 10, spacingSeconds: 3, schedule: { days: [0,1,2,3,4,5,6], startTime: '08:00', endTime: '18:00' }, groupIds: groups.map(g => g.id), groupOverrides: {}, items: [{ id: 'i', type: 'text', text: 'Oferta verdadeira do teste controlado' }], roundIndex: 0, nextRunAt: null, ...campaign };
  store.saveCampaign(c);
  const adapter = new EventEmitter(), calls = [];
  adapter.status = { state: 'connected', mode: 'simulated', ready: true };
  adapter.send = async (groupId, item, media, options) => {
    options.beforeSubmit();
    assert(groupId.endsWith('@simulation'));
    const persisted = store.listJobs({ messageId: item.clientMessageId })[0];
    assert.equal(persisted.status, 'sending');
    calls.push({ groupId, item: clone(item), at: clock.at, jobId: persisted.id, roundId: persisted.roundId });
    return sender ? sender({ clock, adapter, store, calls, groupId, item }) : { status: 'accepted', messageId: item.clientMessageId, simulation: true };
  };
  const scheduler = new Scheduler({ store, adapter, now: () => clock.at, sleep: async ms => { clock.at += ms; }, licenseGuard, monotonicNow });
  return { scheduler, store, adapter, clock, calls };
}
function disconnect(f, { manual = false } = {}) {
  f.adapter.status = { ...f.adapter.status, state: 'disconnected', reasonCode: manual ? 'manual' : 'unexpected', manual };
  f.adapter.emit('status', f.adapter.status);
}
function connected(f) { f.adapter.status = { ...f.adapter.status, state: 'connected', reasonCode: null, manual: false, ready: true }; f.adapter.emit('status', f.adapter.status); }

test('computer schedule: grid follows opening time, including overnight dates and strict recovery slots', () => {
  const s = { days: [1], startTime: '08:00', endTime: '09:00', timezone: 'Pacific/Honolulu' };
  assert.equal(nextComputerRoundSlot(local(7, 30), s, 10), local());
  assert.equal(nextComputerRoundSlot(local(8, 3), s, 10), local(8, 10));
  assert.equal(nextComputerRoundSlot(local(8, 10), s, 10, { strictlyFuture: true }), local(8, 20));
  assert.equal(nextComputerRoundSlot(local(8, 59), s, 10), local(8, 0, 12));
  const overnight = { days: [1], startTime: '22:00', endTime: '02:00', endDate: '2026-01-05' };
  assert.equal(nextComputerRoundSlot(local(1, 7, 6), overnight, 10), local(1, 10, 6));
  assert.equal(nextComputerRoundSlot(local(2, 0, 6), overnight, 10), Infinity);
});

test('application opened before the window: activation preserves authorization and waits for the first grid slot', async () => {
  const f = fixture({ at: local(7, 40) });
  await f.scheduler.activate('c');
  const c = f.store.getCampaign('c');
  assert.equal(c.nextRunAt, local());
  assert.equal(c.executionAuthorization.dateKey, '2026-01-05');
  assert.equal(c.executionAuthorization.timezone, computerClockStatus(f.clock.at).timezone);
  await f.scheduler.tick(); assert.equal(f.calls.length, 0);
  f.clock.at = local(); await f.scheduler.tick(); assert.equal(f.calls.length, 2);
  assert.equal(f.store.getCampaign('c').nextRunAt, local(8, 10));
});

test('activation between grid slots and a delayed round do not shift later rounds', async () => {
  const f = fixture({ at: local(8, 3), count: 1, sender: ({ clock, item }) => { clock.at += 120000; return { status: 'accepted', messageId: item.clientMessageId }; } });
  await f.scheduler.activate('c'); await f.scheduler.tick(); assert.equal(f.calls.length, 0);
  assert.equal(f.store.getCampaign('c').nextRunAt, local(8, 10));
  f.clock.at = local(8, 10); await f.scheduler.tick();
  assert.equal(f.store.getCampaign('c').nextRunAt, local(8, 20));
  assert.equal(f.store.getCampaign('c').lastRoundScheduledAt, local(8, 10));
});

test('reconnection at 08:07 resumes only pending frozen items at 08:10, then a normal new round at 08:20', async () => {
  let first = true;
  const f = fixture({ sender: ({ adapter, item }) => { if (first) { first = false; adapter.status = { ...adapter.status, state: 'disconnected', reasonCode: 'unexpected' }; adapter.emit('status', adapter.status); } return { status: 'accepted', messageId: item.clientMessageId }; } });
  await f.scheduler.activate('c'); await f.scheduler.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.listJobs({ status: 'queued' }).length, 1);
  const original = f.store.listRounds('c')[0];
  f.clock.at = local(8, 7); connected(f);
  const recovered = await f.scheduler.recoverAfterConnection();
  assert.equal(recovered.recovered.length, 1);
  assert.equal(recovered.recovered[0].nextRunAt, local(8, 10));
  assert.equal(f.store.getCampaign('c').executionRecovery.status, 'Conexão recuperada — aguardando próximo horário de rodada');
  await f.scheduler.tick(); assert.equal(f.calls.length, 1);
  f.clock.at = local(8, 10); await f.scheduler.tick();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].roundId, original.id);
  assert.equal(f.store.listRounds('c').length, 1);
  assert.equal(f.store.getCampaign('c').roundIndex, 1);
  assert.equal(f.store.listJobs({ status: 'accepted' }).length, 2);
  f.clock.at = local(8, 20); await f.scheduler.tick();
  assert.equal(f.calls.length, 4);
  assert.equal(f.store.listRounds('c').length, 2);
});

test('recovery exactly on a slot chooses the strictly following slot', async () => {
  const f = fixture({ count: 1 });
  await f.scheduler.activate('c'); await f.scheduler.tick(); disconnect(f);
  f.clock.at = local(8, 10); connected(f); await f.scheduler.recoverAfterConnection();
  assert.equal(f.store.getCampaign('c').nextRunAt, local(8, 20));
  await f.scheduler.tick(); assert.equal(f.calls.length, 1);
});

test('reconnection after the end waits for the next allowed day and preserves pending work', async () => {
  const f = fixture({ campaign: { schedule: { days: [1,2], startTime: '08:00', endTime: '09:00' } } });
  await f.scheduler.activate('c'); disconnect(f);
  f.clock.at = local(10); connected(f); await f.scheduler.recoverAfterConnection();
  assert.equal(f.store.getCampaign('c').nextRunAt, local(8, 0, 6));
  await f.scheduler.tick(); assert.equal(f.calls.length, 0);
  f.clock.at = local(8, 0, 6); await f.scheduler.tick(); assert.equal(f.calls.length, 2);
});

test('drafts, manually paused/stopped campaigns, and a previous-day unstarted campaign cannot auto-activate', async () => {
  const f = fixture();
  disconnect(f); connected(f); await f.scheduler.recoverAfterConnection(); assert.equal(f.store.getCampaign('c').state, 'draft');
  await f.scheduler.activate('c'); await f.scheduler.pause('c'); disconnect(f); connected(f);
  assert.equal((await f.scheduler.recoverAfterConnection()).recovered.length, 0);
  assert.equal(f.store.getCampaign('c').state, 'paused');
  await f.scheduler.resume('c'); await f.scheduler.stopAll(); disconnect(f); connected(f); await f.scheduler.recoverAfterConnection();
  assert.equal(f.store.getCampaign('c').state, 'stopped');
  const other = fixture(); await other.scheduler.activate('c'); other.clock.at = local(7, 0, 6); disconnect(other); connected(other);
  assert.equal(other.store.getCampaign('c').executionRecovery.eligible, false);
  assert.equal((await other.scheduler.recoverAfterConnection()).recovered.length, 0);
  assert.equal(other.calls.length, 0);
});

test('manual disconnection clears technical recovery and does not schedule a new round', async () => {
  const f = fixture(); await f.scheduler.activate('c'); disconnect(f, { manual: true });
  assert.equal(f.store.getCampaign('c').executionRecovery, null);
  connected(f); assert.equal((await f.scheduler.recoverAfterConnection()).recovered.length, 0);
  assert.equal(f.store.getCampaign('c').nextRunAt, null);
});

test('uncertain submission retains evidence and does not block another pending destination after reconnect', async () => {
  let first = true;
  const f = fixture({ sender: ({ adapter, item }) => { if (first) { first = false; adapter.status = { ...adapter.status, state: 'disconnected' }; adapter.emit('status', adapter.status); return { status: 'uncertain', messageId: item.clientMessageId }; } return { status: 'accepted', messageId: item.clientMessageId }; } });
  await f.scheduler.activate('c'); await f.scheduler.tick();
  const uncertain = f.store.listJobs({ status: 'uncertain' })[0];
  f.clock.at = local(8, 7); connected(f); await f.scheduler.recoverAfterConnection();
  f.clock.at = local(8, 10); await f.scheduler.tick();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls.filter(c => c.groupId === uncertain.groupId).length, 1);
  assert.equal(f.store.getJob(uncertain.id).status, 'uncertain');
  f.adapter.emit('receipt', { status: 'accepted', messageId: uncertain.messageId });
  assert.equal(f.store.getJob(uncertain.id).status, 'accepted');
  await f.scheduler.tick(); assert.equal(f.calls.length, 2);
});

test('suspension and clock changes wait for the next slot without catch-up bursts', async () => {
  const f = fixture({ count: 1 }); await f.scheduler.activate('c'); await f.scheduler.tick();
  await f.scheduler.handleSuspend(); f.clock.at = local(11, 23);
  await f.scheduler.recoverAfterConnection({ reason: 'resume' });
  assert.equal(f.store.getCampaign('c').nextRunAt, local(11, 30));
  await f.scheduler.tick(); assert.equal(f.calls.length, 1);
  f.clock.at = local(11, 30); await f.scheduler.tick(); assert.equal(f.calls.length, 2);
  f.clock.at = local(12, 4); await f.scheduler.handleClockChange();
  assert.equal(f.store.getCampaign('c').nextRunAt, local(12, 10));
  await f.scheduler.tick(); assert.equal(f.calls.length, 2);
});

test('operational clock detection regrids a wall-clock jump against a monotonic clock', async () => {
  let monotonic = 0;
  const f = fixture({ count: 1, monotonicNow: () => monotonic });
  await f.scheduler.activate('c'); await f.scheduler.tick();
  monotonic = 1000; f.clock.at = local(9, 4);
  await f.scheduler.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.getCampaign('c').nextRunAt, local(9, 10));
});

test('final connection/window checks after a group permission await preserve an unsubmitted item', async () => {
  const f = fixture({ count: 1, campaign: { schedule: { days: [1,2], startTime: '08:00', endTime: '08:01' } } });
  f.adapter.getGroupPublishingStatus = async () => { f.clock.at = local(8, 1); return { available: true, confirmed: true }; };
  await f.scheduler.activate('c'); await f.scheduler.tick();
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.listJobs({ status: 'queued' }).length, 1);
  assert.equal(f.store.listJobs({ status: 'failed' }).length, 0);
  assert.equal(f.store.getCampaign('c').nextRunAt, local(8, 0, 6));
});

test('licence/global stop gates override technical recovery and never grant authorization', async () => {
  let licensed = true;
  const f = fixture({ licenseGuard: () => { if (!licensed) throw Object.assign(new Error('Licença vencida'), { code: 'LICENSE_EXPIRED' }); } });
  await f.scheduler.activate('c'); disconnect(f); connected(f); licensed = false;
  await assert.rejects(f.scheduler.recoverAfterConnection(), /Licença/);
  assert.equal(f.store.getCampaign('c').state, 'paused');
  licensed = true; f.store.setSetting('automationState', { stopped: true });
  assert.equal((await f.scheduler.recoverAfterConnection()).recovered.length, 0);
  assert.equal(f.calls.length, 0);
});

test('unready connected sessions cannot recover or submit until verified ready', async () => {
  const f = fixture(); await f.scheduler.activate('c'); disconnect(f);
  f.adapter.status = { ...f.adapter.status, state: 'connected', ready: false };
  assert.equal((await f.scheduler.recoverAfterConnection()).recovered.length, 0);
  await f.scheduler.tick(); assert.equal(f.calls.length, 0);
  f.adapter.status.ready = true; f.clock.at = local(8, 7); await f.scheduler.recoverAfterConnection();
  assert.equal(f.store.getCampaign('c').nextRunAt, local(8, 10));
});

test('SQLite restart preserves an interrupted frozen round and never repeats confirmed work', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-clock-recovery-'));
  const stores = []; t.after(() => { for (const s of stores) s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const firstStore = await createStore(dir); stores.push(firstStore);
  let first = true;
  const f = fixture({ store: firstStore, sender: ({ adapter, item }) => { if (first) { first = false; adapter.status = { ...adapter.status, state: 'disconnected' }; adapter.emit('status', adapter.status); } return { status: 'accepted', messageId: item.clientMessageId }; } });
  await f.scheduler.activate('c'); await f.scheduler.tick();
  const originalJob = f.store.listJobs({ status: 'accepted' })[0], originalRound = originalJob.roundId;
  f.store.close();
  const reopened = await createStore(dir); stores.push(reopened);
  const adapter = new EventEmitter(); adapter.status = { state: 'connected', mode: 'simulated' }; const calls = [];
  adapter.send = async (groupId, item, media, options) => { options.beforeSubmit(); calls.push({ groupId, id: item.clientMessageId }); return { status: 'accepted', messageId: item.clientMessageId }; };
  let now = local(8, 7); const scheduler = new Scheduler({ store: reopened, adapter, now: () => now, sleep: async ms => { now += ms; } });
  await scheduler.tick(); assert.equal(calls.length, 0);
  await scheduler.recoverAfterRestart(); await scheduler.tick(); assert.equal(calls.length, 0);
  assert.equal(reopened.getCampaign('c').nextRunAt, local(8, 10));
  now = local(8, 10); await scheduler.tick();
  assert.equal(calls.length, 1);
  assert.equal(reopened.listRounds('c').length, 1);
  assert.equal(reopened.listJobs({ status: 'accepted' }).length, 2);
  assert(reopened.listJobs({ status: 'accepted' }).every(j => j.roundId === originalRound));
  assert.equal(reopened.getJob(originalJob.id).messageId, originalJob.messageId);
});

test('graceful shutdown preserves technical recovery while an explicit stop cancels pending work', async () => {
  const f = fixture({ count: 1 }); await f.scheduler.activate('c');
  await f.scheduler.shutdown();
  assert.equal(f.store.getCampaign('c').executionRecovery.kind, 'restart');
  assert.equal(f.store.getCampaign('c').state, 'paused');
  const other = fixture(); await other.scheduler.activate('c'); await other.scheduler.stopAll(); await other.scheduler.shutdown();
  assert.equal(other.store.getCampaign('c').state, 'stopped');
  assert.equal(other.store.getCampaign('c').executionRecovery, null);
});

test('computer date and timezone snapshots remain actual local clock metadata', () => {
  const value = local(23, 59);
  const s = computerClockStatus(value);
  assert.equal(s.dateKey, computerDateKey(value));
  assert.equal(s.timeZoneOffsetMinutes, new Date(value).getTimezoneOffset());
  assert.equal(s.at, value);
});

test('autoResume false is enforced by the scheduler APIs and clock changes cannot revive an already paused campaign', async () => {
  const f = fixture({ count: 1 }); f.store.setSetting('reconnect', { autoResume: false });
  await f.scheduler.activate('c'); await f.scheduler.tick(); disconnect(f); connected(f); f.clock.at = local(8, 7);
  assert.equal((await f.scheduler.recoverAfterConnection()).recovered.length, 0);
  assert.equal((await f.scheduler.recoverAfterRestart()).recovered.length, 0);
  assert.equal((await f.scheduler.handleClockChange()).recovered.length, 0);
  assert.equal(f.store.getCampaign('c').state, 'paused');
  await f.scheduler.resume('c'); f.clock.at = local(8, 8);
  await f.scheduler.handleClockChange();
  assert.equal(f.store.getCampaign('c').state, 'active', 'Regridding an already active authorized campaign preserves its normal schedule');
  assert.equal(f.store.getCampaign('c').nextRunAt, local(8, 10));
  assert.equal(f.calls.length, 1);
});

test('a changed computer timezone re-evaluates the active grid while preserving the original authorization timezone', async () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'UTC';
    const f = fixture({ at: Date.UTC(2026, 0, 5, 8, 0), count: 1 });
    await f.scheduler.activate('c'); await f.scheduler.tick();
    process.env.TZ = 'America/Sao_Paulo';
    await f.scheduler.handleClockChange();
    assert.equal(f.store.getCampaign('c').nextRunAt, Date.UTC(2026, 0, 5, 11, 0));
    assert.equal(f.store.getCampaign('c').executionAuthorization.timezone, 'UTC');
    assert.equal(f.store.getCampaign('c').scheduleClock.timezone, 'America/Sao_Paulo');
    assert.equal(f.calls.length, 1);
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test('an interrupted final permitted round resumes its own pending item without creating an extra round', async () => {
  let first = true;
  const f = fixture({ campaign: { maxRounds: 1 }, sender: ({ adapter, item }) => { if (first) { first = false; adapter.status = { ...adapter.status, state: 'disconnected' }; adapter.emit('status', adapter.status); } return { status: 'accepted', messageId: item.clientMessageId }; } });
  await f.scheduler.activate('c'); await f.scheduler.tick();
  f.clock.at = local(8, 7); connected(f); await f.scheduler.recoverAfterConnection();
  assert.equal(f.store.getCampaign('c').nextRunAt, local(8, 10));
  f.clock.at = local(8, 10); await f.scheduler.tick();
  assert.equal(f.calls.length, 2);
  assert.equal(f.store.listRounds('c').length, 1);
  assert.equal(f.store.getCampaign('c').roundIndex, 1);
  assert.equal(f.store.getCampaign('c').state, 'stopped');
});

test('new contents received during interruption affect only the next normal round', async () => {
  let first = true;
  const f = fixture({ sender: ({ adapter, item }) => { if (first) { first = false; adapter.status = { ...adapter.status, state: 'disconnected' }; adapter.emit('status', adapter.status); } return { status: 'accepted', messageId: item.clientMessageId }; } });
  await f.scheduler.activate('c'); await f.scheduler.tick();
  const c = f.store.getCampaign('c');
  f.store.saveCampaign({ ...c, items: [...c.items, { id: 'new', type: 'text', text: 'Aparelho adicionado depois' }], configRevision: (c.configRevision || 0) + 1 });
  f.clock.at = local(8, 7); connected(f); await f.scheduler.recoverAfterConnection();
  f.clock.at = local(8, 10); await f.scheduler.tick();
  assert.deepEqual(f.calls.map(c => c.item.id), ['i', 'i']);
  f.clock.at = local(8, 20); await f.scheduler.tick();
  assert.deepEqual(f.calls.slice(2).map(c => c.item.id), ['i', 'new', 'i', 'new']);
});

test('shutdown during a submitted send records its late proof and preserves remaining unsubmitted tasks', async () => {
  let release;
  const f = fixture({ sender: async ({ item }) => { await new Promise(resolve => { release = resolve; }); return { status: 'accepted', messageId: item.clientMessageId }; } });
  await f.scheduler.activate('c'); const run = f.scheduler.tick();
  assert.equal(f.calls.length, 1);
  const shutdown = f.scheduler.shutdown();
  release(); await run; await shutdown;
  assert.equal(f.store.listJobs({ status: 'accepted' }).length, 1);
  assert.equal(f.store.listJobs({ status: 'queued' }).length, 1);
  assert.equal(f.store.getCampaign('c').executionRecovery.kind, 'restart');
});
