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
  setSetting(key,value) { this.settings.set(key,copy(value)); }
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

test('relative start at 09:07 anchors the first and subsequent rounds without waiting for the old wall-clock grid',async()=>{
 const f=fixture({count:1});f.clock.value=at(5,9,7)+123;
 await f.scheduler.activate('c1',{relative:true});assert.equal(f.store.getCampaign('c1').nextRunAt,f.clock.value);
 const anchor=f.clock.value;await f.scheduler.tick();assert.equal(f.calls.length,1);assert.equal(f.store.getCampaign('c1').nextRunAt,anchor+600000);
 f.clock.value=anchor+600000;await f.scheduler.tick();assert.equal(f.calls.length,2);assert.equal(f.store.getCampaign('c1').roundAnchorAt,anchor);
});
test('explicit immediate round rebases an active campaign and replay cannot create another round',async()=>{
 const f=fixture({count:1});await f.scheduler.activate('c1',{relative:true});await f.scheduler.tick();
 f.clock.value=at(5,9,7);const result=await f.scheduler.sendNow('c1',{requestId:'manual-unique-001'});await f.scheduler.waitForIdle();
 assert.equal(result.roundAnchorAt,at(5,9,7));assert.equal(f.calls.length,2);assert.equal(f.store.getCampaign('c1').nextRunAt,at(5,9,17));
 await f.scheduler.sendNow('c1',{requestId:'manual-unique-001'});await f.scheduler.waitForIdle();assert.equal(f.calls.length,2);
});
test('immediate respects windows, manual STOP, connection and licence',async()=>{
 const f=fixture({count:1,changes:{schedule:{days:[1],startTime:'10:00',endTime:'18:00'}}});
 await assert.rejects(f.scheduler.sendNow('c1',{requestId:'outside'}),/horários|horário|limites/);assert.equal(f.store.listRounds().length,0);
 f.adapter.status.state='disconnected';await assert.rejects(f.scheduler.sendNow('c1',{requestId:'disconnected'}),/Conecte/);
 f.adapter.status.state='connected';f.scheduler.licenseGuard=()=>{throw new Error('licença vencida');};await assert.rejects(f.scheduler.sendNow('c1',{requestId:'expired'}),/licença/);
});
test('a round longer than the interval skips past slots without drifting or running concurrent rounds',async()=>{
 const f=fixture({count:1,sender:({clock,item})=>{clock.value+=720000;return {status:'confirmed',messageId:item.clientMessageId};}});f.clock.value=at(5,9,7);
 await f.scheduler.activate('c1',{relative:true});await f.scheduler.tick();assert.equal(f.calls.length,1);assert.equal(f.store.getCampaign('c1').nextRunAt,at(5,9,27));
});
test('normal start before the allowed window anchors at opening; persisted anchor survives a new scheduler',async()=>{
 const f=fixture({count:1,changes:{schedule:{days:[1],startTime:'10:00',endTime:'18:00'}}});f.clock.value=at(5,9,7);
 await f.scheduler.activate('c1',{relative:true});assert.equal(f.store.getCampaign('c1').roundAnchorAt,at(5,10,0));
 f.clock.value=at(5,10,0);const fresh=new Scheduler({store:f.store,adapter:f.adapter,now:()=>f.clock.value});await fresh.recoverAfterRestart();assert.equal(f.store.getCampaign('c1').roundAnchorAt,at(5,10,0));assert.equal(f.store.getCampaign('c1').nextRunAt,at(5,10,10));f.clock.value=at(5,10,10);await fresh.tick();assert.equal(f.calls.length,1);
});

test('replaying an older immediate request after a newer one cannot schedule another round',async()=>{
 const f=fixture({count:1});await f.scheduler.sendNow('c1',{requestId:'first'});await f.scheduler.waitForIdle();f.clock.value+=10000;
 await f.scheduler.sendNow('c1',{requestId:'second'});await f.scheduler.waitForIdle();const before=f.store.getCampaign('c1');
 await f.scheduler.sendNow('c1',{requestId:'first'});await f.scheduler.waitForIdle();assert.equal(f.calls.length,2);assert.equal(f.store.getCampaign('c1').roundAnchorAt,before.roundAnchorAt);
});

test('advancing real-world clock by a millisecond during activation cannot postpone the first round by a whole interval',async()=>{
 const f=fixture({count:1});let calls=0;f.scheduler.now=()=>at(5,9,7)+(calls++);
 const started=await f.scheduler.activate('c1',{relative:true});assert.equal(started.nextRunAt,started.roundAnchorAt);
});
