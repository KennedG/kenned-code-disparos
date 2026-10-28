'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore, seed } = require('../src/core/store.cjs');
const { Scheduler } = require('../src/core/scheduler.cjs');
const { AutomationControl } = require('../src/core/automation-control.cjs');
const { CommandController } = require('../src/core/commands.cjs');
const { SimulatedAdapter } = require('../src/adapters/simulated.cjs');
const { AuthService } = require('../src/core/auth.cjs');
const { EventEmitter } = require('node:events');

const turn = () => new Promise(resolve => setImmediate(resolve));
const barrier = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, { authenticated = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-global-stop-'));
  let store = await createStore(dir); seed(store);
  const clock = { now: Date.parse('2026-10-03T15:00:00Z') };
  const adapter = new SimulatedAdapter({ store, delayMs: 0 }); await adapter.connect();
  let scheduler = new Scheduler({ store, adapter, now: () => clock.now, sleep: async ms => { clock.now += ms; } });
  let control = new AutomationControl({ store, scheduler, now: () => clock.now });
  const releases = [];
  t.after(async () => {
    for (const release of releases) release.resolve();
    await scheduler.shutdown(); await adapter.disconnect(); store.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  let auth, owner;
  if (authenticated) {
    auth = new AuthService({ store, clock: () => clock.now });
    owner = (await auth.setupOwner({ name: 'Dono teste', username: 'owner', phone: '5511999990001', password: 'Senha-forte-para-teste-2026' })).user;
  }
  const campaign = store.listCampaigns()[0];
  store.saveCampaign({ ...campaign, groupIds: campaign.groupIds.slice(0, 2), schedule: { days: [0,1,2,3,4,5,6], startTime: '00:00', endTime: '00:00' } });
  return { dir, store, adapter, scheduler, control, clock, auth, owner, campaign,
    barrier: () => { const result = barrier(); releases.push(result); return result; },
    restart: async () => {
      await scheduler.shutdown(); store.close(); store = await createStore(dir); adapter.store = store;
      scheduler = new Scheduler({ store, adapter, now: () => clock.now }); control = new AutomationControl({ store, scheduler, now: () => clock.now });
      return { store, scheduler, control };
    }
  };
}

test('global stop latches synchronously before any awaited callback, cancels queued work and preserves campaigns', async t => {
  const f = await fixture(t), entered = f.barrier(), released = f.barrier(), calls = [];
  await f.scheduler.activate(f.campaign.id);
  const first = f.scheduler.runExternalSubmission(async () => { entered.resolve(); await released.promise; return 'already-submitted'; });
  await entered.promise;
  let secondExecuted = false;
  const second = f.scheduler.runExternalSubmission(async () => { secondExecuted = true; });
  const denied = assert.rejects(second, { code: 'AUTOMATION_STOPPED' });
  f.control.register('alerts', () => { assert.equal(f.control.isStopped(), true); calls.push('alerts'); return { cancelled: 2 }; });
  f.control.register('reminders', () => { calls.push('reminders'); return { cancelled: 3 }; });
  const stopping = f.control.stop({ actorId: 'owner', source: 'whatsapp' });
  assert.equal(f.control.isStopped(), true);
  assert.equal(f.store.getSetting('automationState').stopped, true);
  assert.deepEqual(calls, ['alerts','reminders']);
  await denied;
  const report = await stopping;
  assert.equal(report.inFlight, 0, 'a running service callback alone does not prove an irreversible network submission');
  assert.equal(report.processing, 1);
  assert.equal(report.campaigns.campaigns, 1);
  assert.equal(f.store.getCampaign(f.campaign.id).state, 'stopped');
  assert.equal(f.store.listCampaigns().length, 1);
  assert.equal(secondExecuted, false);
  await assert.rejects(f.scheduler.activate(f.campaign.id), { code: 'AUTOMATION_STOPPED' });
  await assert.rejects(f.scheduler.runExternalSubmission(() => { throw new Error('must not submit'); }), { code: 'AUTOMATION_STOPPED' });
  released.resolve(); assert.equal(await first, 'already-submitted');
  let adminRan = false;
  await f.scheduler.runExternalSubmission(async () => { adminRan = true; }, { manual: true });
  assert.equal(adminRan, true);
});

test('global stop aborts a campaign spacing wait and records an already-submitted result once', async t => {
  const f = await fixture(t), entered = f.barrier(), released = f.barrier();
  const send = f.adapter.send.bind(f.adapter);
  f.adapter.send = async (...args) => { entered.resolve(); await released.promise; return send(...args); };
  await f.scheduler.activate(f.campaign.id); const round = f.scheduler.tick(); await entered.promise;
  const report = await f.control.stop();
  assert.equal(report.inFlight, 1);
  const jobs = f.store.listJobs({ campaignId: f.campaign.id });
  assert.equal(jobs.filter(job => job.status === 'cancelled').length, 1);
  released.resolve(); await round;
  assert.equal(f.adapter.sent.length, 1);
  assert.equal(f.store.listJobs({ status: 'confirmed' }).length, 1);
  assert.equal(f.store.getCampaign(f.campaign.id).state, 'stopped');
  await f.scheduler.tick(); assert.equal(f.adapter.sent.length, 1);
});

test('stop remains persisted across restart and explicit resume does not reactivate old campaigns', async t => {
  const f = await fixture(t); await f.scheduler.activate(f.campaign.id); await f.control.stop({ actorId: 'owner' });
  const restarted = await f.restart();
  assert.equal(restarted.control.isStopped(), true);
  await assert.rejects(restarted.scheduler.runExternalSubmission(async () => 'never'), { code: 'AUTOMATION_STOPPED' });
  restarted.control.resume({ actorId: 'owner' });
  assert.equal(restarted.store.getSetting('automationState').stopped, false);
  assert.equal(restarted.store.getCampaign(f.campaign.id).state, 'stopped');
  await restarted.scheduler.tick(); assert.equal(f.adapter.sent.length, 0);
  assert.equal(await restarted.scheduler.runExternalSubmission(async () => 'new-work'), 'new-work');
});

test('a cancelled external callback cannot run after explicit resume while its predecessor remains in flight', async t => {
  const f = await fixture(t), entered = f.barrier(), released = f.barrier();
  const first = f.scheduler.runExternalSubmission(async () => { entered.resolve(); await released.promise; }); await entered.promise;
  let ran = false;
  const queued = f.scheduler.runExternalSubmission(async () => { ran = true; }); const denied = assert.rejects(queued, { code: 'AUTOMATION_STOPPED' });
  await f.control.stop(); await denied; f.control.resume(); released.resolve(); await first; await f.scheduler.externalSubmissions;
  assert.equal(ran, false); assert.equal(f.scheduler.submissionHolds, 0);
});

test('failed stop bookkeeping and failed resume persistence keep the runtime fail-closed', async t => {
  const f = await fixture(t), setting = f.store.setSetting.bind(f.store);
  f.control.register('alerts', () => { throw new Error('token=do-not-log'); });
  const report = await f.control.stop();
  assert.equal(report.errors.length, 1); assert.equal(JSON.stringify(report).includes('do-not-log'), false);
  f.store.setSetting = () => { throw new Error('disk unavailable'); };
  assert.throws(() => f.control.resume(), /disk unavailable/);
  assert.equal(f.control.isStopped(), true); assert.equal(f.scheduler.automationBlocked, true);
  f.store.setSetting = setting;
});

test('private administrator help, menu and status work with verified identity and a shared manual reply queue', async t => {
  const f = await fixture(t, { authenticated: true });
  const controller = new CommandController({ store: f.store, scheduler: f.scheduler, adapter: f.adapter, authService: f.auth, automationControl: f.control,
    statusProvider: () => ({ queues: { campaigns: 2 }, monitoring: { enabled: true }, alerts: { pending: 3 }, reminders: { active: 1 } }), now: () => f.clock.now });
  for (const command of ['!mega ajuda','!mega menu','!mega status']) {
    const ctx = f.adapter.injectIncoming({ senderNumber: f.owner.phone, timestamp: f.clock.now, text: command });
    assert.equal(await controller.handle(ctx), true);
  }
  assert.equal(f.adapter.sent.length, 3);
  assert.ok(f.adapter.sent.every(message => message.privateNumber === f.owner.phone && message.status === 'confirmed'));
  assert.match(f.adapter.sent[0].text, /!mega retomar sistema/);
  assert.match(f.adapter.sent[1].text, /Menu Kenned Code/);
  assert.match(f.adapter.sent[2].text, /Monitoramento: enabled: true/);
  assert.match(f.adapter.sent[2].text, /Alertas: pending: 3/);
  assert.match(f.adapter.sent[2].text, /Lembretes: active: 1/);
});

test('private stop is processed once, reports automatic queues, preserves administrative replies and requires explicit resume', async t => {
  const f = await fixture(t, { authenticated: true });
  const controller = new CommandController({ store: f.store, scheduler: f.scheduler, adapter: f.adapter, authService: f.auth, automationControl: f.control, now: () => f.clock.now });
  f.control.register('search', () => ({ cancelled: 4 })); f.control.register('alerts', () => ({ cancelled: 2 })); f.control.register('reminders', () => ({ cancelled: 1 }));
  await f.scheduler.activate(f.campaign.id);
  const ctx = f.adapter.injectIncoming({ senderNumber: f.owner.phone, timestamp: f.clock.now, text: '!mega parar tudo' });
  assert.equal(await controller.handle(ctx), true); assert.equal(await controller.handle(ctx), false);
  assert.equal(f.control.isStopped(), true); assert.equal(f.adapter.sent.length, 1);
  assert.match(f.adapter.sent[0].text, /Resultados de buscas pendentes: 4/);
  assert.match(f.adapter.sent[0].text, /Alertas pendentes: 2/);
  assert.match(f.adapter.sent[0].text, /Novas entradas nas filas estão bloqueadas/);
  await controller.handle(f.adapter.injectIncoming({ senderNumber: f.owner.phone, timestamp: f.clock.now, text: '!mega ajuda' }));
  assert.equal(f.adapter.sent.length, 2);
  await controller.handle(f.adapter.injectIncoming({ senderNumber: f.owner.phone, timestamp: f.clock.now, text: '!mega retomar sistema' }));
  assert.equal(f.control.isStopped(), false); assert.equal(f.store.getCampaign(f.campaign.id).state, 'stopped');
});

test('search authorization alone cannot execute administrative private commands, and names never authorize', async t => {
  const f = await fixture(t, { authenticated: true });
  f.store.saveEntity('roles', { id: 'role-search-only', name: 'Buscas', permissions: ['search.run'], campaignScope: 'own' });
  f.store.saveEntity('users', { id: 'search-only', username: 'search-only', name: 'Administrador', phone: '5511999990002', roleId: 'role-search-only', active: true });
  const controller = new CommandController({ store: f.store, scheduler: f.scheduler, adapter: f.adapter, authService: f.auth, automationControl: f.control, now: () => f.clock.now });
  for (const ctx of [f.adapter.injectIncoming({ senderNumber: '5511999990002', timestamp: f.clock.now, text: '!mega parar tudo' }),
    f.adapter.injectIncoming({ senderNumber: '5511999990003', pushName: f.owner.name, timestamp: f.clock.now, text: '!mega parar tudo' }),
    f.adapter.injectIncoming({ senderNumber: f.owner.phone, timestamp: f.clock.now, text: '!mega parar tudo', isGroup: true, chatId: 'sim-01@simulation' })]) {
    assert.equal(await controller.handle(ctx), false);
  }
  assert.equal(f.control.isStopped(), false); assert.equal(f.adapter.sent.length, 0);
});

test('manual own-account admin commands are supported, while automatic echoes and forwarded packets are ignored', async t => {
  const f = await fixture(t, { authenticated: true }); f.adapter.setOwnAccount(f.owner.phone);
  const controller = new CommandController({ store: f.store, scheduler: f.scheduler, adapter: f.adapter, authService: f.auth, automationControl: f.control, now: () => f.clock.now });
  const ctx = f.adapter.injectIncoming({ timestamp: f.clock.now, text: '!mega status', fromMe: true, chatId: `${f.owner.phone}@s.whatsapp.net` });
  assert.equal(await controller.handle(ctx), true); assert.equal(f.adapter.sent.length, 1);
  const echo = f.adapter.injectIncoming({ timestamp: f.clock.now, text: '!mega parar tudo', fromMe: true, chatId: ctx.chatId, messageId: f.adapter.sent[0].messageId });
  assert.equal(await controller.handle(echo), false);
  assert.equal(await controller.handle(f.adapter.injectIncoming({ timestamp: f.clock.now, text: '!mega parar tudo', fromMe: true, chatId: ctx.chatId, forwarded: true })), false);
  assert.equal(f.control.isStopped(), false);
});

test('queued admin reply revalidates revocation before its network submission', async t => {
  const f = await fixture(t, { authenticated: true }), entered = f.barrier(), released = f.barrier();
  const controller = new CommandController({ store: f.store, scheduler: f.scheduler, adapter: f.adapter, authService: f.auth, automationControl: f.control, now: () => f.clock.now });
  const blocker = f.scheduler.runExternalSubmission(async () => { entered.resolve(); await released.promise; }); await entered.promise;
  const handling = controller.handle(f.adapter.injectIncoming({ senderNumber: f.owner.phone, timestamp: f.clock.now, text: '!mega ajuda' }));
  await turn(); const owner = f.store.getEntity('users', f.owner.id); f.store.saveEntity('users', { ...owner, active: false });
  released.resolve(); await blocker; await assert.rejects(handling, /autorização foi alterada/);
  assert.equal(f.adapter.sent.length, 0);
});

test('simulation and real integration retain separate global stop latches', async t => {
  const f = await fixture(t); await f.control.stop();
  f.store.setSetting('integrationMode', 'whatsapp');
  const protocol = new EventEmitter(); protocol.status = { state: 'connected', mode: 'whatsapp' };
  f.scheduler.setAdapter(protocol); f.control.syncMode();
  assert.equal(f.control.isStopped(), false);
  assert.equal(await f.scheduler.runExternalSubmission(async () => 'no-network-test'), 'no-network-test');
  f.store.setSetting('integrationMode', 'simulated'); f.scheduler.setAdapter(f.adapter); f.control.syncMode();
  assert.equal(f.control.isStopped(), true);
  await assert.rejects(f.scheduler.runExternalSubmission(async () => 'must-not-run'), { code: 'AUTOMATION_STOPPED' });
});

test('verified administrator LID packets reply only to their original private chat', async t => {
  const f = await fixture(t, { authenticated: true });
  const controller = new CommandController({ store: f.store, scheduler: f.scheduler, adapter: f.adapter, authService: f.auth, automationControl: f.control, now: () => f.clock.now });
  const ctx = f.adapter.injectIncoming({ senderNumber: f.owner.phone, senderId: '987654321@lid', chatId: '987654321@lid', timestamp: f.clock.now, text: '!mega ajuda' });
  assert.equal(await controller.handle(ctx), true);
  assert.equal(f.adapter.sent.length, 1); assert.equal(f.adapter.sent[0].targetId, ctx.chatId);
  assert.equal(f.adapter.sent[0].privateNumber, undefined, 'an internal LID must not be fabricated into a phone number');
  assert.equal(await controller.handle({ ...ctx, messageId: 'spoof-lid-command', verified: false }), false);
});

test('an ambiguous administrative reply has one submission and cannot repeat a completed stop', async t => {
  const f = await fixture(t, { authenticated: true });
  const controller = new CommandController({ store: f.store, scheduler: f.scheduler, adapter: f.adapter, authService: f.auth, automationControl: f.control, now: () => f.clock.now });
  let attempts = 0;
  f.adapter.reply = async () => { attempts++; throw Object.assign(new Error('ack unknown token=do-not-log'), { code: 'WA_SEND_UNCERTAIN', safeToRetry: false }); };
  const ctx = f.adapter.injectIncoming({ senderNumber: f.owner.phone, timestamp: f.clock.now, text: '!mega parar tudo' });
  await assert.rejects(controller.handle(ctx), { code: 'WA_SEND_UNCERTAIN' });
  assert.equal(attempts, 1); assert.equal(f.control.isStopped(), true);
  assert.equal(await controller.handle(ctx), false); assert.equal(attempts, 1);
  const diagnostics = f.store.listEntities('diagnostics');
  assert.ok(diagnostics.some(row => row.code === 'WA_SEND_UNCERTAIN'));
  assert.equal(JSON.stringify(diagnostics).includes('do-not-log'), false);
});
