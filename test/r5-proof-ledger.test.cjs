'use strict';

// Native SQLite regressions for the private operational receipt ledger.
// No test below connects a real WhatsApp account or establishes device receipt.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createStore } = require('../src/core/store.cjs');

async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-r5-proof-'));
  let store = await createStore(dir, options);
  store.setSetting('integrationMode', 'whatsapp');
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, get store() { return store; }, async reopen() { store.close(); store = await createStore(dir); return store; } };
}
const DEST = '5511999990001@s.whatsapp.net';
const proof = (scope, extra = {}) => ({ confirmationScope: scope, targetId: DEST, ...extra });

test('receipt milestones advance monotonically in SQLite and preserve first known milestone times after reopening', async t => {
  const f = await fixture(t), id = 'R5-SQL-PROGRESSION';
  assert.equal(f.store.advanceOutboundProof(id, proof('whatsapp-server', { acceptedAt: 1000 })).changed, true);
  assert.equal(f.store.advanceOutboundProof(id, proof('whatsapp-delivered', { acceptedAt: 2000, deliveredAt: 3000 })).changed, true);
  assert.equal(f.store.advanceOutboundProof(id, proof('whatsapp-read', { acceptedAt: 4000, deliveredAt: 5000, readAt: 6000 })).changed, true);
  const expected = { messageId: id, confirmationScope: 'whatsapp-read', targetId: DEST, acceptedAt: 1000, deliveredAt: 3000, readAt: 6000 };
  assert.deepEqual(f.store.getOutboundProof(id), expected);
  await f.reopen();
  assert.deepEqual(f.store.getOutboundProof(id), expected);
  const stale = f.store.advanceOutboundProof(id, proof('whatsapp-server', { acceptedAt: 10000 }));
  assert.equal(stale.changed, false); assert.deepEqual(stale.proof, expected);
});

test('repeated group participant receipts do not acquire transactions or rewrite persisted timestamps', async t => {
  let writes = 0;
  const f = await fixture(t, { beforeWrite() { writes++; } });
  f.store.advanceOutboundProof('R5-SQL-BURST', proof('whatsapp-read', { acceptedAt: 1000, deliveredAt: 2000, readAt: 3000 }));
  const baseline = writes;
  for (let i = 0; i < 3000; i++) {
    assert.equal(f.store.advanceOutboundProof('R5-SQL-BURST', proof('whatsapp-read', { acceptedAt: 1001 + i, deliveredAt: 2001 + i, readAt: 3001 + i })).changed, false);
  }
  assert.equal(writes, baseline, 'all 3000 duplicates use the read-only fast path');
  assert.equal(f.store.getOutboundProof('R5-SQL-BURST').readAt, 3000);
});

test('proofs reject malformed identities and omit arbitrary protocol bodies, credentials, and content', async t => {
  const f = await fixture(t);
  assert.throws(() => f.store.advanceOutboundProof('', proof('whatsapp-server')));
  assert.throws(() => f.store.advanceOutboundProof('R5-SQL-INVALID', proof('unknown-status')));
  assert.throws(() => f.store.advanceOutboundProof('R5-SQL-INVALID', proof('whatsapp-server', { messageId: 'OTHER-MESSAGE' })));
  assert.throws(() => f.store.advanceOutboundProof('R5-SQL-INVALID', proof('whatsapp-server', { acceptedAt: -1 })));
  assert.throws(() => f.store.advanceOutboundProof('R5-SQL-INVALID', proof('whatsapp-server', { targetId: 'not-a-chat' })));
  assert.equal(f.store.getOutboundProof('R5-SQL-INVALID'), undefined);
  const saved = f.store.advanceOutboundProof('R5-SQL-CLEAN', proof('whatsapp-server', { acceptedAt: 1000, token: 'synthetic-secret', text: 'Private content', rawProtocol: { anything: true } })).proof;
  assert.deepEqual(saved, { messageId: 'R5-SQL-CLEAN', confirmationScope: 'whatsapp-server', targetId: DEST, acceptedAt: 1000 });
});

test('an aggregate proof cannot be reassigned to a different destination by a later receipt', async t => {
  const f = await fixture(t), id = 'R5-SQL-IDENTITY';
  const first = f.store.advanceOutboundProof(id, proof('whatsapp-server', { acceptedAt: 1000 })).proof;
  const conflict = f.store.advanceOutboundProof(id, proof('whatsapp-read', { targetId: '5511999990002@s.whatsapp.net', readAt: 3000 }));
  assert.equal(conflict.changed, false); assert.deepEqual(conflict.proof, first);
  assert.deepEqual(f.store.getOutboundProof(id), first);
});

test('real and simulated proof ledgers are isolated even if their message IDs are equal', async t => {
  const f = await fixture(t), id = 'R5-SQL-MODE';
  f.store.advanceOutboundProof(id, proof('whatsapp-server', { acceptedAt: 1000 }));
  f.store.setSetting('integrationMode', 'simulated');
  assert.equal(f.store.getOutboundProof(id), undefined);
  f.store.advanceOutboundProof(id, proof('whatsapp-read', { acceptedAt: 2000, readAt: 3000 }));
  f.store.setSetting('integrationMode', 'whatsapp');
  assert.equal(f.store.getOutboundProof(id).confirmationScope, 'whatsapp-server');
  assert.equal(f.store.getOutboundProof(id).acceptedAt, 1000);
  f.store.setSetting('integrationMode', 'simulated');
  assert.equal(f.store.getOutboundProof(id).readAt, 3000);
});

test('visual history cleanup and portable configuration backup do not erase or export the private operational ledger', async t => {
  const f = await fixture(t), id = 'R5-SQL-PRIVATE';
  f.store.advanceOutboundProof(id, proof('whatsapp-read', { acceptedAt: 1000, readAt: 3000 }));
  f.store.setSetting('theme', 'dark');
  const portable = f.store.exportData();
  assert(!portable.settings.some(s => /^outboundProof:/i.test(s.id)));
  assert(!JSON.stringify(portable).includes(id));
  assert.equal(portable.settings.find(s => s.id === 'theme').value, 'dark');
  f.store.clearHistory({ actor: 'owner-test' });
  f.store.deleteSearchHistory({ actor: 'owner-test' });
  assert.equal(f.store.getOutboundProof(id).readAt, 3000);
  f.store.importData(portable);
  assert.equal(f.store.getOutboundProof(id).readAt, 3000, 'configuration restore preserves local idempotency state');
});

test('full recovery snapshots retain the ledger and remain readable with valid SQLite integrity', async t => {
  const f = await fixture(t), id = 'R5-SQL-RECOVERY';
  f.store.advanceOutboundProof(id, proof('whatsapp-server', { acceptedAt: 1000 }));
  const snapshot = f.store.createRecoverySnapshot(path.join(f.dir, 'recovery', 'before-update.sqlite'));
  assert(snapshot.bytes > 0);
  const db = new DatabaseSync(snapshot.path, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    const rows = db.prepare("SELECT data FROM settings WHERE id LIKE 'outboundProof:%'").all().map(r => JSON.parse(r.data));
    assert.equal(rows.length, 1); assert.equal(rows[0].value.messageId, id); assert.equal(rows[0].value.acceptedAt, 1000);
  } finally { db.close(); }
});

test('failed milestone persistence never returns a false success and retains the previous durable proof across reopen', async t => {
  let fail = false;
  const f = await fixture(t, { beforeWrite() { if (fail) throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' }); } });
  const id = 'R5-SQL-DISK-FAILURE';
  f.store.advanceOutboundProof(id, proof('whatsapp-server', { acceptedAt: 1000 }));
  fail = true;
  assert.throws(() => f.store.advanceOutboundProof(id, proof('whatsapp-read', { readAt: 3000 })), { code: 'ENOSPC' });
  assert.equal(f.store.persistenceFailed, true);
  assert.equal(f.store.getOutboundProof(id).confirmationScope, 'whatsapp-server');
  await f.reopen();
  assert.equal(f.store.getOutboundProof(id).acceptedAt, 1000);
  assert.equal(f.store.getOutboundProof(id).confirmationScope, 'whatsapp-server');
});

test('a restarted adapter reuses durable server acceptance without submission, while a reservation without proof stays uncertain', async t => {
  const f = await fixture(t);
  const { WhatsAppAdapter } = require('../src/adapters/whatsapp.cjs');
  f.store.registerOutboundMessageId('R5-SQL-ACCEPTED');
  f.store.advanceOutboundProof('R5-SQL-ACCEPTED', proof('whatsapp-server', { acceptedAt: 1000 }));
  f.store.registerOutboundMessageId('R5-SQL-UNKNOWN');
  await f.reopen();
  let submissions = 0;
  const adapter = new WhatsAppAdapter({ store: f.store });
  adapter.status = { state: 'connected', mode: 'whatsapp' };
  adapter.library = {};
  adapter.socket = { user: { id: DEST }, sendMessage() { submissions++; throw new Error('must not repeat transport'); } };
  const accepted = await adapter._submitVerified(DEST, { text: 'Same durable operation' }, 'R5-SQL-ACCEPTED');
  assert.equal(accepted.status, 'confirmed');
  assert.equal(accepted.confirmationScope, 'whatsapp-server');
  assert.notEqual(accepted.delivered, true, 'server acceptance does not establish delivery');
  const reconciled = await adapter.reconcile('R5-SQL-ACCEPTED');
  assert.equal(reconciled.status, 'confirmed'); assert.equal(reconciled.delivered, false);
  assert.equal(reconciled.source, 'authenticated-durable-receipt');
  const unknown = await adapter._submitVerified(DEST, { text: 'Potentially already submitted' }, 'R5-SQL-UNKNOWN');
  assert.equal(unknown.status, 'uncertain');
  assert.equal(submissions, 0, 'neither a proved send nor an unknown reserved send is repeated');
});
