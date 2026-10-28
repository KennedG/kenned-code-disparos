'use strict';

// Production scheduler with a controlled transport and clock. These tests
// prove queue arbitration, not receipt by a real WhatsApp account.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Scheduler } = require('../src/core/scheduler.cjs');

const copy = value => value === undefined ? undefined : structuredClone(value);
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await turn(); } assert.fail('A etapa esperada da fila não foi alcançada.'); }

class Store {
  constructor() { this.campaigns = new Map(); this.groups = new Map(); this.jobs = new Map(); this.rounds = new Map(); this.settings = new Map(); }
  getSetting(key, fallback) { return this.settings.has(key) ? copy(this.settings.get(key)) : fallback; }
  getCampaign(id) { return copy(this.campaigns.get(id)); }
  saveCampaign(value) { this.campaigns.set(value.id, copy(value)); return copy(value); }
  listCampaigns() { return [...this.campaigns.values()].map(copy); }
  getGroup(id) { return copy(this.groups.get(id)); }
  getMedia() { return null; }
  insertRound(value) { assert(!this.rounds.has(value.id)); this.rounds.set(value.id, copy(value)); }
  updateRound(id, patch) { this.rounds.set(id, { ...this.rounds.get(id), ...copy(patch) }); }
  listRounds(id) { return [...this.rounds.values()].filter(value => !id || value.campaignId === id).map(copy); }
  insertJob(value) { assert(!this.jobs.has(value.id)); assert(![...this.jobs.values()].some(job => job.operationId === value.operationId)); this.jobs.set(value.id, copy(value)); }
  updateJob(id, patch) { this.jobs.set(id, { ...this.jobs.get(id), ...copy(patch) }); }
  getJob(id) { return copy(this.jobs.get(id)); }
  listJobs(filter = {}) { return [...this.jobs.values()].filter(job => Object.entries(filter).every(([key, value]) => key === 'limit' || value === undefined || job[key] === value)).map(copy); }
}

function fixture(t, { spacingSeconds = 60, send, timeoutMs = 1000 } = {}) {
  const store = new Store(), adapter = new EventEmitter(), calls = [], first = deferred();
  const clock = { value: new Date(2026, 9, 19, 9, 0).getTime() }, sleepers = new Set();
  let licenseValid = true, active = 0;
  const sleep = (ms, signal) => new Promise(resolve => {
    const entry = { at: clock.value + ms, finish: () => { sleepers.delete(entry); signal?.removeEventListener('abort', entry.finish); resolve(); } };
    if (signal?.aborted) return resolve();
    sleepers.add(entry); signal?.addEventListener('abort', entry.finish, { once: true });
  });
  const advance = ms => { clock.value += ms; for (const item of [...sleepers]) if (item.at <= clock.value) item.finish(); };
  adapter.status = { state: 'connected', mode: 'simulated' }; adapter.minimumSpacingSeconds = 3;
  const groupIds = ['g1', 'g2', 'g3'];
  for (const id of groupIds) store.groups.set(id, { id, name: id, authorized: true, simulation: true });
  store.saveCampaign({ id: 'campaign', name: 'Rodada longa', state: 'draft', mode: 'repeat', intervalMinutes: 10, spacingSeconds,
    groupIds, items: [{ id: 'phone', type: 'text', text: 'iPhone 12 Pro 256GB' }], schedule: { days: [0, 1, 2, 3, 4, 5, 6], startTime: '00:00', endTime: '00:00' } });
  adapter.send = async (groupId, item, media, options) => {
    assert.equal(active++, 0, 'A rede não pode receber duas submissões simultâneas.');
    calls.push({ kind: 'campaign', groupId, at: clock.value, messageId: item.clientMessageId });
    try {
      if (send) return await send({ groupId, item, options, first, calls, clock });
      if (groupId === 'g1') await first.promise;
      return { status: 'confirmed', messageId: item.clientMessageId };
    } finally { active--; }
  };
  const scheduler = new Scheduler({ store, adapter, sleep, now: () => clock.value, attemptTimeoutMs: timeoutMs,
    licenseGuard() { if (!licenseValid) throw Object.assign(new Error('Licença expirada.'), { code: 'LICENSE_EXPIRED', definitive: true, submitted: false }); } });
  const privateSubmission = (id = 'private', options = {}) => scheduler.runExternalSubmission(async context => {
    const remaining = 3000 - (clock.value - (scheduler.lastSubmissionAt ?? -Infinity));
    if (remaining > 0) await sleep(remaining, context.signal);
    context.beforeSubmit();
    assert.equal(active++, 0);
    try { scheduler.lastSubmissionAt = clock.value; calls.push({ kind: id, at: clock.value }); return { status: 'confirmed', messageId: id }; }
    finally { active--; }
  }, options);
  t.after(async () => { first.resolve(); await scheduler.shutdown({ preserveRecovery: false }); for (const item of [...sleepers]) item.finish(); });
  return { store, adapter, scheduler, clock, calls, first, advance, sleep, privateSubmission, expire() { licenseValid = false; } };
}

test('a private opportunity enters after the current message instead of waiting for the whole round', async t => {
  const f = fixture(t); await f.scheduler.activate('campaign'); const round = f.scheduler.tick();
  await until(() => f.calls.length === 1);
  const response = f.privateSubmission();
  await turn(); assert.equal(f.calls.length, 1, 'A tentativa ainda em andamento não pode ser ultrapassada.');
  assert.match(f.scheduler.getSubmissionQueueState().reason, /mensagem em andamento/);
  const roundId = f.store.listRounds()[0].id; f.first.resolve();
  await until(() => f.scheduler.externalInFlight === 1);
  f.advance(3000); await response;
  assert.deepEqual(f.calls.map(call => call.kind), ['campaign', 'private']);
  assert.equal(f.store.listJobs({ status: 'accepted' }).length, 1);
  assert.equal(f.store.listJobs({ status: 'queued' }).length, 2);
  assert.equal(f.store.listRounds()[0].status, 'running');
  f.advance(59000); await turn(); assert.equal(f.calls.length, 2, 'O intervalo da campanha deve contar novamente após o privado.');
  f.advance(1000); await until(() => f.calls.length === 3);
  f.advance(60000); await round;
  assert.deepEqual(f.calls.map(call => call.kind), ['campaign', 'private', 'campaign', 'campaign']);
  assert.equal(f.store.listRounds().length, 1); assert.equal(f.store.listRounds()[0].id, roundId);
  assert.equal(new Set(f.store.listJobs().map(job => job.operationId)).size, 3);
  assert.equal(f.store.listJobs({ status: 'accepted' }).length, 3);
});

test('a private opportunity can use a long campaign spacing delay without waiting for it to finish', async t => {
  const f = fixture(t); f.first.resolve(); await f.scheduler.activate('campaign'); const round = f.scheduler.tick();
  await until(() => f.calls.length === 1 && f.scheduler.campaignInFlight === 0);
  const response = f.privateSubmission(); await until(() => f.scheduler.externalInFlight === 1);
  f.advance(3000); await response;
  assert.deepEqual(f.calls.map(call => call.kind), ['campaign', 'private']);
  assert.equal(f.calls[1].at - f.calls[0].at, 3000);
  await f.scheduler.stopAll(); await round;
  assert.equal(f.store.listJobs({ status: 'cancelled' }).length, 2);
});

test('pausing the campaign while its private turn runs cancels its remaining jobs without repeating accepted work', async t => {
  const f = fixture(t); await f.scheduler.activate('campaign'); const round = f.scheduler.tick();
  const response = f.privateSubmission(); f.first.resolve(); await until(() => f.scheduler.externalInFlight === 1);
  await f.scheduler.pause('campaign'); f.advance(3000); await response; await round;
  assert.deepEqual(f.calls.map(call => call.kind), ['campaign', 'private']);
  assert.equal(f.store.getCampaign('campaign').state, 'paused');
  assert.equal(f.store.listJobs({ status: 'accepted' }).length, 1);
  assert.equal(f.store.listJobs({ status: 'cancelled' }).length, 2);
});

test('global stop cancels an automatic opportunity waiting for a campaign boundary but keeps manual control available', async t => {
  const f = fixture(t); await f.scheduler.activate('campaign'); const round = f.scheduler.tick();
  const response = f.privateSubmission(); const denied = assert.rejects(response, { code: 'AUTOMATION_STOPPED' });
  f.store.settings.set('automationState', { stopped: true }); f.scheduler.setAutomationBlocked(true); await f.scheduler.stopAll();
  f.first.resolve(); await denied; await round;
  assert.deepEqual(f.calls.map(call => call.kind), ['campaign']);
  assert.equal(await f.scheduler.runExternalSubmission(() => 'controle disponível', { manual: true }), 'controle disponível');
});

test('license expiration while a private opportunity is queued prevents both private and next campaign submissions', async t => {
  const f = fixture(t); await f.scheduler.activate('campaign'); const round = f.scheduler.tick();
  const response = f.privateSubmission(); const denied = assert.rejects(response, { code: 'LICENSE_EXPIRED' });
  f.expire(); f.first.resolve(); await denied;
  f.advance(60000); await round;
  assert.deepEqual(f.calls.map(call => call.kind), ['campaign']);
  assert.equal(f.scheduler.getInFlightCount(), 0);
});

test('a bounded uncertain campaign attempt yields to a private opportunity and late proof updates its original job only', async t => {
  const late = deferred();
  const f = fixture(t, { timeoutMs: 25, send: ({ groupId, item }) => groupId === 'g1' ? late.promise : { status: 'confirmed', messageId: item.clientMessageId } });
  // This transport intentionally ignores abort to model already-submitted
  // network work. Its late result is evidence, never permission to resend.
  await f.scheduler.activate('campaign'); const round = f.scheduler.tick();
  const response = f.scheduler.runExternalSubmission(context => { context.beforeSubmit(); f.calls.push({ kind: 'private', at: f.clock.value }); f.scheduler.lastSubmissionAt = f.clock.value; return 'respondido'; });
  assert.equal(await response, 'respondido');
  const uncertain = f.store.listJobs({ status: 'uncertain' })[0]; assert(uncertain); assert.equal(uncertain.attempts, 1);
  assert.deepEqual(f.calls.map(call => call.kind), ['campaign', 'private']);
  late.resolve({ status: 'confirmed', messageId: uncertain.messageId }); await turn();
  assert.equal(f.store.getJob(uncertain.id).status, 'accepted');
  assert.equal(f.calls.filter(call => call.groupId === 'g1').length, 1);
  await f.scheduler.stopAll(); await round;
  assert.equal(f.scheduler.submissionTurn, null);
});

test('a disconnected campaign never submits another item while a waiting private task performs its final readiness check', async t => {
  const f = fixture(t); await f.scheduler.activate('campaign'); const round = f.scheduler.tick();
  const response = f.scheduler.runExternalSubmission(context => {
    context.beforeSubmit();
    if (f.adapter.status.state !== 'connected') throw Object.assign(new Error('Sem conexão.'), { code: 'WA_DISCONNECTED', definitive: true, submitted: false });
    assert.fail('Uma tarefa privada desconectada não pode submeter mensagem.');
  });
  const denied = assert.rejects(response, { code: 'WA_DISCONNECTED' });
  f.adapter.status = { ...f.adapter.status, state: 'disconnected' }; f.adapter.emit('status', f.adapter.status); f.first.resolve();
  await denied; await round;
  assert.equal(f.calls.length, 1); assert.equal(f.store.listJobs({ status: 'queued' }).length, 2);
  assert.equal(f.store.getCampaign('campaign').state, 'paused');
});

test('private submission serialization preserves FIFO and releases the campaign after a finite batch', async t => {
  const f = fixture(t, { spacingSeconds: 3 }); await f.scheduler.activate('campaign'); const round = f.scheduler.tick();
  const one = f.privateSubmission('private-1'), two = f.privateSubmission('private-2'); f.first.resolve();
  await until(() => f.scheduler.externalInFlight === 1); f.advance(3000); await one;
  await until(() => f.scheduler.externalInFlight === 1); f.advance(3000); await two;
  for (let i = 0; i < 4 && f.calls.filter(call => call.kind === 'campaign').length < 3; i++) { f.advance(3000); await turn(); }
  await round;
  assert.deepEqual(f.calls.filter(call => call.kind.startsWith('private')).map(call => call.kind), ['private-1', 'private-2']);
  assert.equal(f.store.listJobs({ status: 'accepted' }).length, 3); assert.equal(f.scheduler.submissionTurnWaiters.length, 0);
});
