'use strict';

// Real local SQLite/Auth/Scheduler; controlled protocol outcomes are explicitly
// not evidence of receiving a message on an actual WhatsApp handset.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { createStore } = require('../src/core/store.cjs');
const { AuthService } = require('../src/core/auth.cjs');
const { Scheduler } = require('../src/core/scheduler.cjs');
const { AutomationControl } = require('../src/core/automation-control.cjs');
const { CommandController } = require('../src/core/commands.cjs');

const PERSONAL = '5562999990001';
const SHOP = '5562999990002';
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kenned-commands-231-'));
  const clock = { now: Date.parse('2026-10-06T15:00:00Z') };
  let store = await createStore(dir);
  const auth = new AuthService({ store, clock: () => clock.now });
  store.saveEntity('users', { id: 'owner', name: 'Dono de teste', username: 'owner-test', roleId: 'role-owner', phone: PERSONAL, authorizedPhones: [], active: true, requirePasswordChange: false });
  auth.currentUserId = 'owner';
  const adapter = new EventEmitter();
  Object.assign(adapter, {
    status: { mode: 'whatsapp', state: 'connected', ownAccountNumber: SHOP },
    replies: [], outcome: 'confirmed',
    isTrustedSelfContext: context => context.trustedSelf === true && context.senderNumber === SHOP && context.accountId === `${SHOP}@s.whatsapp.net`,
    async reply(chatId, text, options) {
      if (this.beforeReply) await this.beforeReply(chatId, options);
      options.beforeSubmit?.();
      if (this.failure) throw this.failure;
      store.registerOutboundMessageId(options.clientMessageId, { kind: 'admin-test', at: clock.now });
      this.replies.push({ chatId, text, messageId: options.clientMessageId, replyContext: options.replyContext });
      if (this.outcome === 'confirmed') this.emit('receipt', { messageId: options.clientMessageId, status: 'confirmed', mode: 'whatsapp', simulation: false, confirmationScope: 'whatsapp-server' });
      return { messageId: options.clientMessageId, status: this.outcome, confirmationScope: this.outcome === 'confirmed' ? 'whatsapp-server' : undefined };
    }
  });
  const scheduler = new Scheduler({ store, adapter, now: () => clock.now });
  const automation = new AutomationControl({ store, scheduler, now: () => clock.now });
  const createController = () => new CommandController({ store, adapter, scheduler, authService: auth, automationControl: automation, now: () => clock.now,
    statusProvider: () => ({ queue: 3, search: { lastSyncAt: clock.now, enabled: true }, alerts: { pending: 2, failed: 1 }, reminders: { active: 1, pending: 0 } }) });
  let controller = createController();
  const context = (text, patch = {}) => ({ messageId: randomUUID(), senderNumber: PERSONAL, senderId: `${PERSONAL}@s.whatsapp.net`, senderIds: [`${PERSONAL}@s.whatsapp.net`], verified: true, identityVerified: true, isGroup: false, forwarded: false, fromMe: false, type: 'text', text, timestamp: clock.now, chatId: `${PERSONAL}@s.whatsapp.net`, accountId: `${SHOP}@s.whatsapp.net`, ...patch });
  const restart = async () => {
    controller.close();
    store.close();
    store = await createStore(dir);
    auth.store = store;
    scheduler.store = store;
    automation.store = store;
    controller = createController();
  };
  t.after(async () => { controller.close(); await scheduler.shutdown(); store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, clock, get store() { return store; }, auth, adapter, scheduler, automation, context, get controller() { return controller; }, restart, send: (text, patch) => controller.handle(context(text, patch)) };
}

const diagnostics = f => f.store.listEntities('diagnostics');
const ledger = f => f.store.getSetting('recentCommandIds', []);

test('2.3.1 private personal→shop help/menu/status reply only to the resolved original requester with a complete trace', async t => {
  const f = await fixture(t);
  assert.notEqual(PERSONAL, SHOP);
  f.store.setSetting('systemAlertRecipientIds', ['someone-else']);
  for (const command of ['!mega ajuda', '!mega menu', '!mega status']) {
    const ctx = f.context(command, { traceId: `wa-receive-${randomUUID().replaceAll('-', '').slice(0, 24)}` });
    assert.equal(await f.controller.handle(ctx), true);
    const response = f.adapter.replies.at(-1);
    assert.equal(response.chatId, `${PERSONAL}@s.whatsapp.net`);
    assert.equal(response.replyContext.fromMe, false);
    const entry = ledger(f).find(value => value.id === `${PERSONAL}:${ctx.messageId}`);
    assert.equal(entry.traceId, ctx.traceId);
    assert.equal(entry.replies[0].status, 'confirmed');
    assert.equal(entry.replies[0].confirmationScope, 'whatsapp-server');
    assert.equal(entry.replies[0].recipient, `${PERSONAL}@s.whatsapp.net`);
    const trace = diagnostics(f).filter(value => value.traceId === entry.traceId);
    assert.ok(trace.every(value => value.level === 'info'));
    for (const code of ['ADMIN_COMMAND_RECEIVED', 'ADMIN_AUTH_APPROVED', 'ADMIN_COMMAND_PARSED', 'ADMIN_REPLY_QUEUED', 'ADMIN_REPLY_SUBMITTED', 'ADMIN_REPLY_ACCEPTED']) assert.ok(trace.some(value => value.code === code), code);
  }
  assert.match(f.adapter.replies.at(-1).text, /Filas: 3/);
  assert.match(f.adapter.replies.at(-1).text, /Monitoramento:/);
  assert.match(f.adapter.replies.at(-1).text, /Alertas:/);
  assert.match(f.adapter.replies.at(-1).text, /Lembretes:/);
});

test('2.3.1 verified LID keeps original private chat while authorizing the real PN, never the LID digits', async t => {
  const f = await fixture(t);
  const lid = '123456789876543@lid';
  assert.equal(await f.send('!mega ajuda', { chatId: lid, senderId: lid, senderIds: [lid, `${PERSONAL}@s.whatsapp.net`] }), true);
  assert.equal(f.adapter.replies[0].chatId, lid);
  assert.equal(ledger(f)[0].actorId, 'owner');
  assert.equal(await f.send('!mega parar tudo', { chatId: lid, senderId: lid, senderIds: [lid], senderNumber: '123456789876543', verified: false }), false);
  assert.equal(f.automation.isStopped(), false);
});

test('2.3.1 unauthorized sender stays silent but refusal and exact stage are visible in diagnostics', async t => {
  const f = await fixture(t);
  const other = '5562999997777';
  assert.equal(await f.send('!mega parar tudo', { senderNumber: other, senderId: `${other}@s.whatsapp.net`, senderIds: [`${other}@s.whatsapp.net`], chatId: `${other}@s.whatsapp.net` }), false);
  assert.equal(f.adapter.replies.length, 0);
  assert.equal(f.automation.isStopped(), false);
  assert.ok(diagnostics(f).some(value => value.stage === 'admin.recebimento'));
  assert.ok(diagnostics(f).some(value => value.stage === 'admin.autorizacao' && value.code === 'WA_SENDER_NOT_AUTHORIZED'));
});

test('2.3.1 search permission alone never authorizes administrative control', async t => {
  const f = await fixture(t);
  f.store.saveEntity('roles', { id: 'search-only', name: 'Pesquisa', permissions: ['search.view', 'search.run'], campaignScope: 'own', isOwner: false });
  f.store.saveEntity('users', { id: 'owner', name: 'Pesquisador', username: 'owner-test', roleId: 'search-only', phone: PERSONAL, active: true, requirePasswordChange: false });
  assert.equal(await f.send('!mega parar tudo'), false);
  assert.equal(f.automation.isStopped(), false);
  assert.equal(f.adapter.replies.length, 0);
  assert.ok(diagnostics(f).some(value => value.code === 'ADMIN_CONTROL_PERMISSION_DENIED'));
});

test('2.3.1 conflicting PN mapping fails closed rather than choosing the first user', async t => {
  const f = await fixture(t);
  f.store.saveEntity('users', { id: 'second', name: 'Outra identidade', username: 'other-test', roleId: 'role-admin', phone: PERSONAL, active: true, requirePasswordChange: false });
  assert.equal(await f.send('!mega parar tudo'), false);
  assert.equal(f.automation.isStopped(), false);
  assert.equal(f.adapter.replies.length, 0);
  assert.ok(diagnostics(f).some(value => value.stage === 'admin.autorizacao'));
});

test('2.3.1 forwarded/group/history/automatic events never execute control, with specific refusal reasons', async t => {
  const f = await fixture(t);
  for (const [patch, code] of [[{ forwarded: true }, 'ADMIN_FORWARDED_REJECTED'], [{ isGroup: true, chatId: 'test@g.us' }, 'ADMIN_PRIVATE_CHAT_REQUIRED'], [{ historical: true }, 'ADMIN_HISTORY_REJECTED'], [{ automaticMessage: true }, 'ADMIN_AUTOMATION_ECHO_REJECTED'], [{ senderNumber: '123' }, 'ADMIN_PHONE_INVALID'], [{ chatId: `${SHOP}@s.whatsapp.net` }, 'ADMIN_REPLY_CHAT_MISMATCH']]) {
    assert.equal(await f.send('!mega parar tudo', patch), false);
    assert.ok(diagnostics(f).some(value => value.code === code), code);
  }
  assert.equal(f.automation.isStopped(), false);
  assert.equal(f.adapter.replies.length, 0);
});

test('2.3.1 own-account manual self command requires explicit mapping and automatic echoes never loop', async t => {
  const f = await fixture(t);
  const owner = f.store.getEntity('users', 'owner');
  f.store.saveEntity('users', { ...owner, authorizedPhones: [SHOP] });
  const patch = { senderNumber: SHOP, senderId: `${SHOP}@s.whatsapp.net`, senderIds: [`${SHOP}@s.whatsapp.net`], chatId: `${SHOP}@s.whatsapp.net`, fromMe: true, trustedSelf: true, selfChat: true };
  assert.equal(await f.send('!mega ajuda', patch), true);
  assert.equal(f.adapter.replies[0].chatId, `${SHOP}@s.whatsapp.net`);
  const echo = { ...patch, messageId: f.adapter.replies[0].messageId };
  assert.equal(await f.send('!mega parar tudo', echo), false);
  assert.equal(f.automation.isStopped(), false);
  assert.equal(f.adapter.replies.length, 1);
  assert.equal(await f.send('!mega parar tudo', { ...patch, selfChat: false }), false);
});

test('2.3.1 durable command claim prevents duplicates even after a newer command and restart', async t => {
  const f = await fixture(t);
  const original = f.context('!mega ajuda');
  assert.equal(await f.controller.handle(original), true);
  f.clock.now += 6 * 60_000;
  await f.send('!mega status');
  await f.restart();
  assert.equal(await f.controller.handle({ ...original, timestamp: f.clock.now }), false);
  assert.equal(f.adapter.replies.length, 2);
  assert.ok(ledger(f).some(value => value.id === `${PERSONAL}:${original.messageId}`));
  assert.ok(diagnostics(f).some(value => value.code === 'ADMIN_COMMAND_DUPLICATE'));
});

test('2.3.1 stale/future commands are not executed and the rejection is diagnosable', async t => {
  const f = await fixture(t);
  assert.equal(await f.send('!mega parar tudo', { timestamp: f.clock.now - 6 * 60_000 }), false);
  assert.equal(await f.send('!mega parar tudo', { timestamp: f.clock.now + 2 * 60_000 }), false);
  assert.equal(f.automation.isStopped(), false);
  assert.equal(diagnostics(f).filter(value => value.code === 'ADMIN_COMMAND_STALE').length, 2);
});

test('2.3.1 uncertain reply is never resent or followed by a second generic response; late ACK reconciles it', async t => {
  const f = await fixture(t);
  f.adapter.outcome = 'uncertain';
  const ctx = f.context('!mega ajuda');
  assert.equal(await f.controller.handle(ctx), true);
  assert.equal(f.adapter.replies.length, 1);
  assert.equal(ledger(f)[0].replies[0].status, 'uncertain');
  await f.restart();
  assert.equal(await f.controller.handle(ctx), false);
  assert.equal(f.adapter.replies.length, 1);
  f.adapter.emit('receipt', { messageId: f.adapter.replies[0].messageId, status: 'confirmed', mode: 'whatsapp', simulation: false, confirmationScope: 'whatsapp-delivered', deliveredAt: f.clock.now });
  assert.equal(ledger(f)[0].replies[0].status, 'delivered');
  assert.ok(diagnostics(f).some(value => value.code === 'ADMIN_REPLY_DELIVERED'));
  const size = diagnostics(f).length;
  f.adapter.emit('receipt', { messageId: f.adapter.replies[0].messageId, status: 'confirmed', mode: 'whatsapp', simulation: false, confirmationScope: 'whatsapp-server' });
  assert.equal(ledger(f)[0].replies[0].status, 'delivered');
  assert.equal(diagnostics(f).length, size);
});

test('2.3.1 processing reply after interruption is recovered as uncertain, not submitted again', async t => {
  const f = await fixture(t);
  const commandId = randomUUID();
  const messageId = 'UNCERTAIN_AFTER_CRASH';
  f.store.setSetting('recentCommandIds', [{ id: `${PERSONAL}:${commandId}`, at: f.clock.now, traceId: randomUUID(), actorId: 'owner', chatId: `${PERSONAL}@s.whatsapp.net`, replies: [{ messageId, status: 'processing', submittedAt: f.clock.now }] }]);
  await f.restart();
  assert.equal(ledger(f)[0].replies[0].status, 'uncertain');
  assert.equal(ledger(f)[0].replies[0].code, 'ADMIN_REPLY_INTERRUPTED');
  assert.equal(await f.send('!mega ajuda', { messageId: commandId }), false);
  assert.equal(f.adapter.replies.length, 0);
});

test('2.3.1 typed pre-submission error retains the reason and sanitizes credentials, without claiming sent', async t => {
  const f = await fixture(t);
  f.adapter.failure = Object.assign(new Error('Destinatário recusado; token=SHOULD_NOT_LEAK Bearer ALSO_SECRET password="SECRET WITH SPACES" \"private_key\":\"ALSO PRIVATE\"'), { code: 'WA_RECIPIENT_NOT_FOUND', definitive: true, submitted: false });
  await assert.rejects(f.send('!mega ajuda'), { code: 'WA_RECIPIENT_NOT_FOUND' });
  const reply = ledger(f)[0].replies[0];
  assert.equal(reply.status, 'failed');
  assert.equal(reply.code, 'WA_RECIPIENT_NOT_FOUND');
  const records = diagnostics(f);
  assert.ok(records.some(value => value.code === 'WA_RECIPIENT_NOT_FOUND' && /Destinatário recusado/.test(value.description)));
  assert.doesNotMatch(JSON.stringify(records), /SHOULD_NOT_LEAK|ALSO_SECRET|SECRET WITH SPACES|ALSO PRIVATE/);
  assert.doesNotMatch(JSON.stringify(ledger(f)), /SHOULD_NOT_LEAK|ALSO_SECRET|SECRET WITH SPACES|ALSO PRIVATE/);
  assert.equal(f.adapter.replies.length, 0);
});

test('2.3.1 permission revocation during recipient resolution blocks final submission', async t => {
  const f = await fixture(t);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  f.adapter.beforeReply = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
  const work = f.send('!mega ajuda');
  await ready;
  f.store.saveEntity('users', { ...f.store.getEntity('users', 'owner'), active: false });
  release();
  await assert.rejects(work, { code: 'ADMIN_REPLY_AUTH_CHANGED' });
  assert.equal(f.adapter.replies.length, 0);
  assert.equal(ledger(f)[0].replies[0].status, 'failed');
});

test('2.3.1 replacing actor while a command waits prevents execution under the replacement user', async t => {
  const f = await fixture(t);
  let release;
  f.controller._tail = new Promise(resolve => { release = resolve; });
  const work = f.send('!mega parar tudo');
  // STOP deliberately bypasses the command tail; use a non-emergency command.
  await work;
  await f.automation.resume();
  const pending = f.send('!mega ajuda');
  f.store.saveEntity('users', { ...f.store.getEntity('users', 'owner'), phone: SHOP });
  f.store.saveEntity('users', { id: 'replacement', name: 'Novo titular', username: 'replacement', roleId: 'role-admin', phone: PERSONAL, active: true, requirePasswordChange: false });
  release();
  assert.equal(await pending, false);
  assert.equal(f.adapter.replies.length, 1);
  assert.ok(diagnostics(f).some(value => value.code === 'ADMIN_ACTOR_CHANGED'));
});

test('2.3.1 STOP synchronously blocks new automatic queues, cancels all families and keeps private administrative replies working', async t => {
  const f = await fixture(t);
  const stopped = [];
  f.automation.register('alerts', () => { stopped.push('alerts'); return { cancelled: 2, inFlight: 1 }; });
  f.automation.register('search', () => { stopped.push('search'); return { cancelled: 3 }; });
  f.automation.register('reminders', () => { stopped.push('reminders'); return { cancelled: 1, paused: 4 }; });
  await f.send('!mega parar tudo');
  assert.deepEqual(stopped.sort(), ['alerts', 'reminders', 'search']);
  assert.equal(f.automation.isStopped(), true);
  assert.equal(f.store.getSetting('automationState').stopped, true);
  await assert.rejects(f.scheduler.runExternalSubmission(async () => {}, { manual: false }), { code: 'AUTOMATION_STOPPED' });
  assert.match(f.adapter.replies.at(-1).text, /1 envio\(s\) já em andamento/);
  assert.match(f.adapter.replies.at(-1).text, /Novas entradas nas filas estão bloqueadas/);
  for (const command of ['!mega ajuda', '!mega menu', '!mega status']) assert.equal(await f.send(command), true);
  assert.equal(f.adapter.replies.length, 4);
  await f.restart();
  f.automation.syncMode();
  assert.equal(f.automation.isStopped(), true);
  await f.send('!mega retomar sistema');
  assert.equal(f.automation.isStopped(), false);
  assert.equal(f.store.getSetting('automationState').stopped, false);
});

test('2.3.1 real/simulated replay ledgers and receipts stay isolated when switching modes', async t => {
  const f = await fixture(t);
  await f.send('!mega ajuda');
  const real = ledger(f)[0];
  const oldAdapter = f.adapter;
  const simulator = new EventEmitter();
  Object.assign(simulator, { status: { mode: 'simulated', state: 'connected' }, reply: oldAdapter.reply.bind(oldAdapter) });
  f.store.setSetting('integrationMode', 'simulated');
  f.controller.setAdapter(simulator);
  assert.equal(ledger(f).length, 0);
  simulator.emit('receipt', { messageId: real.replies[0].messageId, status: 'delivered', mode: 'whatsapp', simulation: false, confirmationScope: 'whatsapp-delivered' });
  assert.equal(ledger(f).length, 0);
  f.store.setSetting('integrationMode', 'whatsapp');
  f.controller.setAdapter(oldAdapter);
  assert.equal(ledger(f)[0].traceId, real.traceId);
  assert.equal(ledger(f)[0].replies[0].status, 'confirmed');
  assert.equal(oldAdapter.listenerCount('receipt'), 2, 'one scheduler listener, one command listener');
  f.controller.close();
  assert.equal(oldAdapter.listenerCount('receipt'), 1);
});


test('2.3.1 adapter switch while a private response is queued blocks submission through the new account', async t => {
  const f = await fixture(t);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  f.scheduler.runExternalSubmission = async work => { entered(); await new Promise(resolve => { release = resolve; }); return work(); };
  const work = f.send('!mega ajuda');
  await ready;
  const replacement = new EventEmitter();
  Object.assign(replacement, { status: { mode: 'whatsapp', state: 'connected' }, replies: [], reply: async function (chatId, text) { this.replies.push({ chatId, text }); return { status: 'confirmed' }; } });
  f.controller.setAdapter(replacement);
  release();
  await assert.rejects(work, { code: 'ADMIN_REPLY_INTEGRATION_CHANGED' });
  assert.equal(f.adapter.replies.length, 0);
  assert.equal(replacement.replies.length, 0);
  assert.equal(ledger(f)[0].replies[0].status, 'failed');
});

test('2.3.1 shutting down while a reply awaits recipient resolution blocks the final submission', async t => {
  const f = await fixture(t);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  f.adapter.beforeReply = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
  const work = f.send('!mega ajuda');
  await ready;
  f.controller.close();
  release();
  await assert.rejects(work, { code: 'ADMIN_REPLY_INTEGRATION_CHANGED' });
  assert.equal(f.adapter.replies.length, 0);
  assert.equal(ledger(f)[0].replies[0].status, 'failed');
});


test('2.3.1 queue refusal before adapter invocation is a failed unsent response, not an uncertain network outcome', async t => {
  const f = await fixture(t);
  f.scheduler.runExternalSubmission = async () => { throw new Error('Fila indisponível antes da chamada ao adaptador.'); };
  await assert.rejects(f.send('!mega ajuda'), /Fila indisponível/);
  assert.equal(f.adapter.replies.length, 0);
  assert.equal(ledger(f)[0].replies[0].status, 'failed');
  assert.equal(ledger(f)[0].replies[0].code, 'ADMIN_REPLY_FAILED');
  assert.ok(diagnostics(f).some(value => value.code === 'ADMIN_REPLY_FAILED' && value.detail.submitted === false));
});

test('2.3.1 legacy formatted authorized phone is normalized exactly without inventing a different digit sequence', async t => {
  const f = await fixture(t);
  f.store.saveEntity('users', { ...f.store.getEntity('users', 'owner'), phone: '+55 (62) 99999-0001' });
  assert.equal(await f.send('!mega ajuda'), true);
  assert.equal(f.adapter.replies[0].chatId, `${PERSONAL}@s.whatsapp.net`);
  assert.equal(await f.send('!mega ajuda', { senderNumber: '556299990001', senderId: '556299990001@s.whatsapp.net', senderIds: ['556299990001@s.whatsapp.net'], chatId: '556299990001@s.whatsapp.net' }), false);
  assert.equal(f.adapter.replies.length, 1);
});

test('2.3.1 cleaning diagnostic history preserves operational replay and uncertain reply protection across restart', async t => {
  const f = await fixture(t);
  f.adapter.outcome = 'uncertain';
  const ctx = f.context('!mega ajuda');
  await f.controller.handle(ctx);
  const entry = ledger(f)[0];
  f.store.clearHistory({ categories: ['errors'], actor: { id: 'owner', name: 'Dono de teste' } });
  assert.equal(ledger(f)[0].replies[0].status, 'uncertain');
  assert.equal(ledger(f)[0].traceId, entry.traceId);
  await f.restart();
  assert.equal(await f.controller.handle(ctx), false);
  assert.equal(f.adapter.replies.length, 1);
  assert.equal(ledger(f)[0].replies[0].status, 'uncertain');
});
