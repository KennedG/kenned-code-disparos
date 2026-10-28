'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createStore, seed } = require('../src/core/store.cjs');
const { Scheduler } = require('../src/core/scheduler.cjs');
const { SimulatedAdapter } = require('../src/adapters/simulated.cjs');

const beginning = new Date(2026, 0, 5, 9).getTime();

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-scheduler-integration-'));
  const stores = [];
  t.after(() => { for (const store of stores) store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const open = async () => { const store = await createStore(dir); stores.push(store); return store; };
  const store = await open(); seed(store);
  const clock = { now: beginning };
  const adapter = new SimulatedAdapter({ store, delayMs: 0 });
  const scheduler = new Scheduler({ store, adapter, now: () => clock.now, sleep: async ms => { clock.now += ms; } });
  await adapter.connect();
  return { dir, open, store, clock, adapter, scheduler, campaign: store.listCampaigns()[0] };
}

test('real SQLite + local simulator: 15 deliveries are durable before transport and restart rebases without replay', async t => {
  const f = await setup(t);
  const simulatedSend = f.adapter.send.bind(f.adapter);
  f.adapter.send = async (groupId, item, media) => {
    assert(groupId.endsWith('@simulation'), 'Integration tests must never target WhatsApp');
    const disk = new DatabaseSync(f.store.filename, { readOnly: true });
    try {
      const matched = disk.prepare('SELECT status,data FROM jobs WHERE status=? AND messageId=?').get('sending', item.clientMessageId);
      assert(matched, 'sending state and client message ID must already be committed to disk, including WAL');
      assert.equal(matched.status, 'sending');
      assert.equal(JSON.parse(matched.data).messageId, item.clientMessageId);
    } finally { disk.close(); }
    return simulatedSend(groupId, item, media);
  };
  await f.scheduler.tick(); assert.equal(f.adapter.sent.length, 0);
  await f.scheduler.activate(f.campaign.id); await f.scheduler.tick();
  assert.equal(f.adapter.sent.length, 15);
  assert.equal(f.store.listJobs({ status: 'confirmed' }).length, 15);
  assert.equal(f.store.getCampaign(f.campaign.id).nextRunAt, beginning + 600000);
  // Emulate process termination between rounds, without a graceful shutdown.
  f.store.close();
  const reopened = await f.open(); reopened.recoverInterrupted();
  const secondAdapter = new SimulatedAdapter({ store: reopened, delayMs: 0 });
  const secondScheduler = new Scheduler({ store: reopened, adapter: secondAdapter, now: () => f.clock.now, sleep: async ms => { f.clock.now += ms; } });
  await secondAdapter.connect(); await secondScheduler.tick();
  assert.equal(reopened.getCampaign(f.campaign.id).state, 'paused');
  assert.equal(secondAdapter.sent.length, 0);
  await secondScheduler.resume(f.campaign.id); await secondScheduler.tick();
  assert.equal(secondAdapter.sent.length, 0);
  f.clock.now = beginning + 600000;
  await secondScheduler.tick();
  assert.equal(secondAdapter.sent.length, 15);
  assert.equal(reopened.listJobs({ status: 'confirmed' }).length, 30);
  await secondScheduler.shutdown();
});

test('real SQLite + local simulator: uncertain delivery survives restart, blocks resume and reconciles by durable ID', async t => {
  const f = await setup(t);
  f.adapter.setNextOutcome('uncertain');
  await f.scheduler.activate(f.campaign.id); await f.scheduler.tick();
  assert.equal(f.adapter.sent.length, 1);
  const uncertain = f.store.listJobs({ status: 'uncertain' })[0];
  assert.equal(uncertain.messageId, f.adapter.sent[0].messageId);
  assert.equal(f.store.listJobs({ status: 'cancelled' }).length, 14);
  f.store.close();
  const reopened = await f.open(); reopened.recoverInterrupted();
  const adapter = new SimulatedAdapter({ store: reopened, delayMs: 0 });
  const scheduler = new Scheduler({ store: reopened, adapter, now: () => f.clock.now, sleep: async ms => { f.clock.now += ms; } });
  await adapter.connect();
  await assert.rejects(scheduler.resume(f.campaign.id), /resultado incerto/);
  await scheduler.tick(); assert.equal(adapter.sent.length, 0);
  adapter.emit('receipt', { messageId: uncertain.messageId, status: 'confirmed', simulation: true });
  assert.equal(reopened.getJob(uncertain.id).status, 'confirmed');
  await scheduler.resume(f.campaign.id); await scheduler.tick();
  assert.equal(adapter.sent.length, 14);
  assert(adapter.sent.every(send => send.groupId !== uncertain.groupId));
  assert.equal(reopened.listJobs({ status: 'confirmed' }).length, 15);
  await scheduler.shutdown();
});
