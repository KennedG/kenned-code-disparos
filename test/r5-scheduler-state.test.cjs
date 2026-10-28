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

// Sanitized regressions derived from support diagnostics. No client data is embedded.
test('a running photo/text campaign is not interrupted just because nextRunAt is deliberately empty',async()=>{
 let release, firstId;const first=new Promise(resolve=>{release=resolve;});
 const f=fixture({count:2,sender:({item,calls})=>{if(calls.length===1){firstId=item.clientMessageId;return first;}return {status:'confirmed',messageId:item.clientMessageId};}});
 await f.scheduler.activate('c1',{relative:true});const worker=f.scheduler.tick();
 assert.equal(f.calls.length,1);const before=f.store.getCampaign('c1');assert.equal(before.nextRunAt,null);assert.ok(before.executionPendingRoundId);
 const runtime=f.scheduler.getExecutionState('c1');assert.equal(runtime.runningRound,true);assert.equal(runtime.stoppingRound,false);assert.equal(runtime.roundStatus,'running');assert.equal(runtime.roundId,before.executionPendingRoundId);assert.equal(runtime.nextRoundAt,null);assert.equal(runtime.nextRoundEstimateAt,at(5,9,10));assert.equal(runtime.estimate,true);
 assert.deepEqual(f.store.getCampaign('c1'),before,'reading a forecast cannot mutate the live schedule or create a round');
 const acknowledgement=await f.scheduler.sendNow('c1',{requestId:'second-click-during-active-round'});
 assert.equal(acknowledgement.immediateStatus,'already-running');assert.equal(acknowledgement.executionAlreadyRunning,true);assert.equal(acknowledgement.runningRoundId,runtime.roundId);assert.equal(f.calls.length,1);assert.equal(f.store.listRounds('c1').length,1);assert.equal(f.store.getCampaign('c1').roundAnchorAt,before.roundAnchorAt);
 release({status:'confirmed',messageId:firstId});await worker;
 assert.equal(f.calls.length,2);const finished=f.scheduler.getExecutionState('c1');assert.equal(finished.runningRound,false);assert.equal(finished.roundId,null);assert.equal(finished.nextRoundAt,at(5,9,10));assert.equal(finished.nextRoundEstimateAt,null);assert.equal(finished.estimate,false);
});
test('runtime distinguishes an administrator stopping the current round from normal processing',async()=>{
 let release,firstId;const first=new Promise(resolve=>{release=resolve;});
 const f=fixture({count:1,sender:({item})=>{firstId=item.clientMessageId;return first;}});
 await f.scheduler.activate('c1',{relative:true});const worker=f.scheduler.tick();await f.scheduler.pause('c1');
 const runtime=f.scheduler.getExecutionState('c1');assert.equal(runtime.runningRound,true);assert.equal(runtime.stoppingRound,true);assert.equal(runtime.nextRoundEstimateAt,null);assert.equal(f.store.getCampaign('c1').state,'paused');
 release({status:'confirmed',messageId:firstId});await worker;assert.equal(f.scheduler.getExecutionState('c1').runningRound,false);assert.equal(f.store.listJobs()[0].status,'accepted');
});
test('a real transport timeout releases the other destination and leaves its result uncertain for review',async()=>{
 const f=fixture({count:2,sender:({item,calls})=>calls.length===1?new Promise(()=>{}):{status:'confirmed',messageId:item.clientMessageId}});f.scheduler.attemptTimeoutMs=10;
 await f.scheduler.activate('c1',{relative:true});await f.scheduler.tick();
 assert.equal(f.calls.length,2);assert.equal(f.store.listJobs({status:'uncertain'}).length,1);assert.equal(f.store.listJobs({status:'accepted'}).length,1);assert.equal(f.scheduler.getExecutionState('c1').runningRound,false);assert.equal(f.store.getCampaign('c1').state,'active');assert.equal(f.store.getCampaign('c1').nextRunAt,at(5,9,10));
});
test('an executing final allowed round has no invented future execution but stays visibly running until it finishes',async()=>{
 let release,firstId;const first=new Promise(resolve=>{release=resolve;});const f=fixture({count:1,changes:{maxRounds:1},sender:({item})=>{firstId=item.clientMessageId;return first;}});
 await f.scheduler.activate('c1',{relative:true});const worker=f.scheduler.tick();const runtime=f.scheduler.getExecutionState('c1');assert.equal(runtime.runningRound,true);assert.equal(runtime.nextRoundEstimateAt,null);assert.equal(runtime.estimate,false);
 release({status:'confirmed',messageId:firstId});await worker;assert.equal(f.store.getCampaign('c1').state,'stopped');assert.equal(f.scheduler.getExecutionState('c1').nextRoundAt,null);
});
test('background global busy cannot acknowledge a different campaign as already being sent',async()=>{
 const f=fixture({count:1});const c=f.store.getCampaign('c1');f.store.saveCampaign({...c,id:'c2'});f.scheduler.busy=true;
 await assert.rejects(f.scheduler.sendNow('c2',{requestId:'separate-campaign'}),{code:'SCHEDULER_BUSY'});assert.equal(f.store.listRounds('c2').length,0);
});

test('duplicate group receipts do not rewrite timestamps or trigger repeated scheduler broadcasts',async()=>{
 const f=fixture({count:1});await f.scheduler.activate('c1',{relative:true});await f.scheduler.tick();
 const job=f.store.listJobs()[0];let writes=0,changes=0;const update=f.store.updateJob.bind(f.store);f.store.updateJob=(...args)=>{writes++;return update(...args);};f.scheduler.on('change',()=>changes++);
 const original=f.store.getJob(job.id);f.clock.value+=1000;
 for(let i=0;i<1000;i++)f.adapter.emit('receipt',{messageId:job.messageId,status:'accepted',acceptedAt:f.clock.value});
 assert.equal(writes,0);assert.equal(changes,0);assert.deepEqual(f.store.getJob(job.id),original);
 f.adapter.emit('receipt',{messageId:job.messageId,status:'delivered',deliveredAt:f.clock.value});
 assert.equal(writes,1);assert.equal(changes,1);const delivered=f.store.getJob(job.id);assert.equal(delivered.status,'delivered');assert.equal(delivered.acceptedAt,original.acceptedAt);
 f.clock.value+=1000;f.adapter.emit('receipt',{messageId:job.messageId,status:'delivered',deliveredAt:f.clock.value,readAt:f.clock.value});
 assert.equal(writes,2);assert.equal(changes,2);const read=f.store.getJob(job.id);
 f.clock.value+=1000;for(let i=0;i<1000;i++)f.adapter.emit('receipt',{messageId:job.messageId,status:'delivered',deliveredAt:f.clock.value,readAt:f.clock.value});
 f.adapter.emit('receipt',{messageId:job.messageId,status:'accepted'});
 assert.equal(writes,2);assert.equal(changes,2);assert.deepEqual(f.store.getJob(job.id),read);assert.equal(f.scheduler.receipts.get(job.messageId).readAt,read.readAt);
});
test('an unknown receipt cannot trigger unrelated campaign screen updates',async()=>{
 const f=fixture({count:1});let changes=0;f.scheduler.on('change',()=>changes++);
 f.adapter.emit('receipt',{messageId:'FOREIGN-MESSAGE',status:'delivered',readAt:f.clock.value});
 assert.equal(changes,0);assert.equal(f.store.listJobs().length,0);
});
