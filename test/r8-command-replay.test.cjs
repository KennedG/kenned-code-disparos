'use strict';

// Real AuthService and SQLite, controlled transport. The alias provider here
// represents an already verified binding; proof verification has socket tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { createStore } = require('../src/core/store.cjs');
const { AuthService } = require('../src/core/auth.cjs');
const { OpportunityPrivateCommands } = require('../src/core/opportunity-private-commands.cjs');
const { CommandController } = require('../src/core/commands.cjs');

const LONG = '5511987654321';
const SHORT = '551187654321';
const OTHER = '5511991112222';
const PASSWORD = 'Replay-Isolated-2026!';

async function fixture(t, kind) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kc-r8-command-replay-'));
  const replies = [], actions = [];
  let store, auth, controller, owner;
  const adapter = new EventEmitter();
  adapter.status = { mode: 'whatsapp', state: 'connected' };
  adapter.reply = async (chatId, text, options) => {
    options.beforeSubmit();
    replies.push({ chatId, text });
    return { status: 'confirmed', messageId: options.clientMessageId, confirmationScope: 'whatsapp-server' };
  };
  const open = async () => {
    store = await createStore(dir);
    store.setSetting('integrationMode', 'whatsapp');
    auth = new AuthService({ store, identityAliases: number => [LONG, SHORT].includes(number) ? [LONG, SHORT] : [] });
    if (!owner) {
      owner = (await auth.setupOwner({ name: 'Isolated replay owner', username: 'replay-owner', phone: LONG, password: PASSWORD })).user;
      store.setSetting('r8ReplayOpportunityConfig', { adminPhone: LONG, adminActorId: owner.id });
    }
    if (kind === 'opportunity') {
      controller = new OpportunityPrivateCommands({ store, adapter, authService: auth, workflow: {
        config: () => store.getSetting('r8ReplayOpportunityConfig', {}),
        async setAutomatic(value, actorId) { actions.push({ value, actorId }); },
        status: () => ({ automatic: false })
      } });
    } else controller = new CommandController({ store, adapter, authService: auth, scheduler: {} });
  };
  const close = () => { controller?.close(); store?.close(); };
  await open();
  t.after(async () => { close(); await fs.rm(dir, { recursive: true, force: true }); });
  const context = (number, messageId = 'SAME-MESSAGE-ID') => ({
    messageId, senderNumber: number, senderId: `${number}@s.whatsapp.net`, senderIds: [`${number}@s.whatsapp.net`],
    chatId: `${number}@s.whatsapp.net`, type: 'text', text: kind === 'opportunity' ? '!automatico off' : '!mega ajuda',
    verified: true, identityVerified: true, fromMe: false, isGroup: false, forwarded: false, timestamp: Date.now()
  });
  return {
    get store() { return store; }, get auth() { return auth; }, get controller() { return controller; },
    owner, replies, actions, context, send: (...args) => controller.handle(context(...args)),
    restart: async () => { close(); await open(); },
    key: kind === 'opportunity' ? 'opportunityControlCommands:whatsapp' : 'recentCommandIds'
  };
}

for (const kind of ['opportunity', 'legacy']) {
  test(`R8 ${kind}: a proven phone alias cannot replay a command after a SQLite/controller restart`, async t => {
    const f = await fixture(t, kind);
    assert.equal(await f.send(SHORT), true);
    assert.equal(f.replies.length, 1);
    await f.restart();
    assert.equal(await f.send(LONG), false);
    assert.equal(f.replies.length, 1);
    if (kind === 'opportunity') assert.equal(f.actions.length, 1);
    assert.equal(f.store.getSetting(f.key, []).length, 1);
    assert.equal(f.replies[0].chatId, `${SHORT}@s.whatsapp.net`, 'the actual original reply route stays intact');
  });

  test(`R8 ${kind}: pre-update ledger rows without an explicit messageId retain alias replay protection`, async t => {
    const f = await fixture(t, kind);
    const messageId = 'OLD:NAMESPACE:MESSAGE';
    f.store.setSetting(f.key, [{
      id: `${SHORT}:${messageId}`, actorId: f.owner.id, at: Date.now(), traceId: 'old-replay-trace',
      chatId: `${SHORT}@s.whatsapp.net`, status: 'completed', replies: []
    }]);
    await f.restart();
    assert.equal(await f.send(LONG, messageId), false);
    assert.equal(f.replies.length, 0);
    assert.equal(f.actions.length, 0);
    assert.equal(f.store.getSetting(f.key, []).length, 1);
  });

  test(`R8 ${kind}: equal message IDs from distinct central users are not globally merged`, async t => {
    const f = await fixture(t, kind);
    const other = await f.auth.createUser({
      name: 'Another isolated administrator', username: 'replay-other', phone: OTHER, password: PASSWORD,
      roleId: 'role-admin', campaignScope: 'all', requirePasswordChange: false
    });
    assert.equal(await f.send(SHORT), true);
    if (kind === 'opportunity') f.store.setSetting('r8ReplayOpportunityConfig', { adminPhone: OTHER, adminActorId: other.id });
    assert.equal(await f.send(OTHER), true);
    assert.equal(f.replies.length, 2);
    if (kind === 'opportunity') assert.deepEqual(f.actions.map(value => value.actorId), [f.owner.id, other.id]);
    assert.equal(f.store.getSetting(f.key, []).length, 2);
  });
}

test('R8 private search claims persist across PN/LID route changes and stay scoped to the actor', async t => {
  const f = await fixture(t, 'opportunity');
  const first = { id: 'private-original', actorId: f.owner.id, chatId: `${SHORT}@s.whatsapp.net`, messageId: 'SEARCH-REPLAY', source: 'whatsapp-private', status: 'queued', requestedAt: Date.now() };
  assert.equal(f.store.claimSearchRun(first).claimed, true);
  await f.restart();
  const repeated = f.store.claimSearchRun({ ...first, id: 'private-lid-duplicate', chatId: '777888999@lid' });
  assert.equal(repeated.claimed, false);
  assert.equal(repeated.run.id, first.id);
  assert.equal(repeated.run.chatId, first.chatId, 'duplicate detection must not replace the initial reply route');
  const other = f.store.claimSearchRun({ ...first, id: 'different-actor', actorId: 'another-central-actor', chatId: `${OTHER}@s.whatsapp.net` });
  assert.equal(other.claimed, true);
});

test('R8 historical private search rows with userId remain replay-safe across self/private routes', async t => {
  const f = await fixture(t, 'opportunity');
  const old = { id: 'private-before-update', userId: f.owner.id, chatId: `${SHORT}@s.whatsapp.net`, messageId: 'SEARCH-OLD', source: 'whatsapp-private', status: 'done', createdAt: Date.now() };
  assert.equal(f.store.claimSearchRun(old).claimed, true);
  await f.restart();
  const repeated = f.store.claimSearchRun({ id: 'self-after-update', actorId: f.owner.id, chatId: '777888999@lid', messageId: old.messageId, source: 'whatsapp-self', status: 'queued' });
  assert.equal(repeated.claimed, false);
  assert.equal(repeated.run.id, old.id);
});
