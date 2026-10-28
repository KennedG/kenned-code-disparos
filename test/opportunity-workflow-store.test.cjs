'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { attachOpportunityStore } = require('../src/core/opportunity-store.cjs');
const NOW = Date.parse('2026-10-23T15:00:00Z');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-workflow-')), filename = path.join(dir, 'ledger.db'), databases = [], settings = { integrationMode: 'whatsapp' };
  const campaign = { id: 'campaign', groupIds: ['one@g.us', 'two@g.us'], items: [{ id: 'item', type: 'text', text: '📱 iPhone 12 Pro 128GB\nR$ 2.000,00' }] };
  const open = () => {
    const db = new DatabaseSync(filename); databases.push(db); db.exec('PRAGMA busy_timeout=5000;'); let depth = 0;
    const transaction = callback => { if (depth) return callback(); db.exec('BEGIN IMMEDIATE'); depth++; try { const value = callback(); db.exec('COMMIT'); return value; } catch (e) { db.exec('ROLLBACK'); throw e; } finally { depth--; } };
    const store = { getStorageMode: () => settings.integrationMode, getCampaign: id => id === campaign.id ? campaign : null };
    attachOpportunityStore(store, { db, prepared: sql => db.prepare(sql), transaction }); return store;
  };
  const store = open(); store.setOpportunityConfig({ campaignIds: ['campaign'], enabled: true, mode: 'automatic' });
  const ingest = (patch = {}, target = store) => target.ingestOpportunity({ event: { chatId: 'source@g.us', messageId: 'MSG', senderKey: 'phone:5562999999999', originalAt: NOW, text: 'iPhone 12 Pro 128GB quem tem?', ...patch }, request: { intentKey: patch.intentKey || '12pro128', familyKey: patch.familyKey || '12pro', safe: true, complete: true, models: [{ modelKey: 'iphone 12 pro', storageGB: 128 }] } }, patch.now || NOW).opportunity;
  const reserve = (id, patch = {}, target = store) => target.reserveOpportunityWorkflow({ opportunityId: id, campaignId: campaign.id, itemId: 'item', itemSnapshot: campaign.items[0], recipients: campaign.groupIds.map(id => ({ id, type: 'group' })), automatic: true, selectionFingerprint: 'fingerprint', offerIdentity: 'unit:original', now: NOW, ...patch });
  t.after(() => { for (const db of databases) db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, open, campaign, settings, ingest, reserve, db: databases[0] };
}
test('workflow atomically creates exactly one persistent task for each campaign destination', t => {
  const f = fixture(t), op = f.ingest(), a = f.reserve(op.id); assert(a.ok); assert.equal(a.jobs.length, 2); assert.deepEqual(a.jobs.map(job => job.recipient), f.campaign.groupIds);
  const b = f.reserve(op.id, {}, f.open()); assert(b.duplicate); assert.deepEqual(b.jobs.map(job => job.id), a.jobs.map(job => job.id)); assert.equal(f.store.listOpportunityWorkflowJobs().length, 2);
});
test('workflow refuses destination outside campaign, requester phone and mode mixing', t => {
  const f = fixture(t), op = f.ingest();
  for (const recipients of [[{ id: 'outsider@g.us', type: 'group' }], [{ id: '5562999999999', type: 'private' }], [{ id: 'one@simulation', type: 'group' }]]) assert.equal(f.reserve(op.id, { recipients }).code, 'OP_RECIPIENT');
  assert.equal(f.store.listOpportunityWorkflowJobs().length, 0);
});
test('manual mode preserves pending approval after restart, approval is idempotent', t => {
  const f = fixture(t), op = f.ingest(), a = f.reserve(op.id, { automatic: false }); assert.equal(a.batch.status, 'awaiting_approval');
  const other = f.open(); assert.equal(other.getOpportunityWorkflow(op.id).status, 'awaiting_approval'); assert.equal(other.claimOpportunityWorkflowJob(a.jobs[0].id, { now: NOW }).ok, false);
  const approved = other.approveOpportunityWorkflow(op.id, { actorId: 'owner', now: NOW }); assert(approved.ok); assert(approved.jobs.every(job => job.status === 'queued')); assert(f.store.approveOpportunityWorkflow(op.id, { now: NOW }).duplicate);
});
test('independent database connections cannot claim one workflow job twice', t => {
  const f = fixture(t), op = f.ingest(), job = f.reserve(op.id).jobs[0], other = f.open();
  assert(f.store.claimOpportunityWorkflowJob(job.id, { now: NOW }).ok); assert.equal(other.claimOpportunityWorkflowJob(job.id, { now: NOW }).ok, false);
});
test('recovery distinguishes pre-submit work from uncertain transport and leaves other jobs runnable', t => {
  const f = fixture(t), op = f.ingest(), jobs = f.reserve(op.id).jobs;
  const a = f.store.claimOpportunityWorkflowJob(jobs[0].id, { now: NOW }).job; f.store.markOpportunityWorkflowSubmitted(a.id, { attemptId: a.attemptId, now: NOW });
  f.store.claimOpportunityWorkflowJob(jobs[1].id, { now: NOW });
  const other = f.open(); assert.deepEqual(other.recoverOpportunityWorkflowJobs(NOW + 1), { uncertain: 1, requeued: 1 });
  assert.equal(other.getOpportunityWorkflowJob(a.id).status, 'uncertain'); assert.equal(other.updateOpportunityWorkflowJob(a.id, { status: 'queued', now: NOW + 2 }).status, 'uncertain'); assert(other.claimOpportunityWorkflowJob(jobs[1].id, { now: NOW + 2 }).ok);
});
test('late receipt reconciles uncertain result without reopening queue or accepting another attempt', t => {
  const f = fixture(t), op = f.ingest(), job = f.reserve(op.id).jobs[0]; const claimed = f.store.claimOpportunityWorkflowJob(job.id, { now: NOW }).job;
  f.store.markOpportunityWorkflowSubmitted(job.id, { attemptId: claimed.attemptId, now: NOW }); f.store.updateOpportunityWorkflowJob(job.id, { status: 'uncertain', now: NOW });
  assert.equal(f.store.updateOpportunityWorkflowJob(job.id, { status: 'accepted', messageId: 'ACK', attemptId: 'wrong', now: NOW }).status, 'uncertain');
  assert.equal(f.store.updateOpportunityWorkflowJob(job.id, { status: 'accepted', messageId: 'ACK', attemptId: claimed.attemptId, now: NOW }).status, 'accepted');
  assert.equal(f.store.updateOpportunityWorkflowJob(job.id, { status: 'failed', now: NOW }).status, 'accepted');
  assert.equal(f.store.updateOpportunityWorkflowJob(job.id, { status: 'delivered', messageId: 'ACK', now: NOW }).status, 'delivered');
  assert.throws(() => f.store.updateOpportunityWorkflowJob(f.reserve(op.id).jobs[1].id, { status: 'accepted', now: NOW }), /identificador/);
});
test('pause cancels queued and pre-submit jobs, preserves submitted job for recorded result', t => {
  const f = fixture(t), op = f.ingest(), jobs = f.reserve(op.id).jobs;
  const running = f.store.claimOpportunityWorkflowJob(jobs[0].id, { now: NOW }).job; f.store.markOpportunityWorkflowSubmitted(running.id, { attemptId: running.attemptId, now: NOW });
  const notice = f.store.enqueueOpportunityAdminNotice({ opportunityId: op.id, key: 'new', recipient: '5562999999999', body: 'Novo pedido', now: NOW }).job;
  assert.deepEqual(f.store.cancelOpportunityWorkflow({ all: true, now: NOW }), { cancelled: 2, inProgress: 1 });
  assert.equal(f.store.getOpportunityWorkflowJob(running.id).status, 'processing'); assert.equal(f.store.getOpportunityWorkflowJob(notice.id).status, 'cancelled');
});
test('administrator notices dedupe persistently without redirecting recipients', t => {
  const f = fixture(t), op = f.ingest();
  const a = f.store.enqueueOpportunityAdminNotice({ opportunityId: op.id, key: 'new', recipient: '5562999999999', body: 'Novo pedido', now: NOW });
  assert(a.ok); assert(f.open().enqueueOpportunityAdminNotice({ opportunityId: op.id, key: 'new', recipient: '5562999999999', body: 'Novo pedido', now: NOW }).duplicate);
  assert.equal(f.store.enqueueOpportunityAdminNotice({ opportunityId: op.id, key: 'bad', recipient: '123@lid', body: 'Novo pedido', now: NOW }).code, 'OP_ADMIN_PHONE');
  assert.equal(f.store.listOpportunityWorkflowJobs({ type: 'admin-notice' }).length, 1);
});
test('workflow contact limits are counted once per opportunity instead of per destination', t => {
  const f = fixture(t), op = f.ingest(); assert(f.reserve(op.id).ok);
  const next = f.ingest({ messageId: 'OTHER', familyKey: 'different', intentKey: 'different' }); assert.equal(f.reserve(next.id, { offerIdentity: 'other-unit' }).code, 'OP_INTERVAL');
  f.store.setOpportunityConfig({ contactIntervalMinutes: 0, maxPerDay: 2 });
  assert(f.reserve(next.id, { offerIdentity: 'other-unit' }).ok);
  const third = f.ingest({ messageId: 'THIRD', familyKey: 'third', intentKey: 'third' }); assert.equal(f.reserve(third.id, { offerIdentity: 'third-unit' }).code, 'OP_DAILY_LIMIT');
});
test('write failure rolls back batch, destination jobs and operational opportunity state', t => {
  const f = fixture(t), op = f.ingest(); f.db.exec("CREATE TRIGGER workflow_write_failure BEFORE INSERT ON op_notifications WHEN NEW.kind LIKE 'wf:job:%' BEGIN SELECT RAISE(ABORT,'WORKFLOW_WRITE_FAILURE'); END;");
  assert.throws(() => f.reserve(op.id), /WORKFLOW_WRITE_FAILURE/); assert.equal(f.store.getOpportunityWorkflow(op.id), undefined); assert.equal(f.store.listOpportunityWorkflowJobs().length, 0); assert.equal(f.store.getOpportunity(op.id).status, 'open');
});
test('backup includes workflow protections and does not resume pending work on restore', t => {
  const f = fixture(t), op = f.ingest(), jobs = f.reserve(op.id).jobs;
  const claimed = f.store.claimOpportunityWorkflowJob(jobs[0].id, { now: NOW }).job; f.store.markOpportunityWorkflowSubmitted(claimed.id, { attemptId: claimed.attemptId, now: NOW });
  const backup = f.store.exportOpportunityData(); assert.equal(backup.notifications.filter(n => n.kind.startsWith('wf:')).length, 3);
  f.settings.integrationMode = 'simulated'; assert.equal(f.store.listOpportunityWorkflowJobs().length, 0); f.settings.integrationMode = 'whatsapp';
  f.db.exec('DELETE FROM op_notifications'); f.store.importOpportunityData(backup);
  assert.equal(f.store.getOpportunityWorkflowJob(jobs[0].id).status, 'uncertain'); assert.equal(f.store.getOpportunityWorkflowJob(jobs[1].id).status, 'cancelled');
  assert.equal(f.store.getOpportunityConfig().automatic, false); assert(f.reserve(op.id).duplicate);
});
test('index creation is explicitly deferred until after the recovery backup', t => {
  const f = fixture(t);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name LIKE 'op_workflow_%'").get().n, 0);
  f.store.ensureOpportunityWorkflowIndexes(); f.store.ensureOpportunityWorkflowIndexes();
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name LIKE 'op_workflow_%'").get().n, 4);
});
test('changing a selection before submission preserves cancelled job history and uses new identities', t => {
  const f = fixture(t), op = f.ingest(), previous = f.reserve(op.id, { automatic: false });
  f.campaign.items.push({ id: 'another-item', type: 'text', text: '📱 iPhone 12 Pro 256GB' });
  const next = f.reserve(op.id, { itemId: 'another-item', itemSnapshot: f.campaign.items[1], selectionFingerprint: 'new-fingerprint', offerIdentity: 'another-unit', replaceUnstarted: true });
  assert(next.ok); assert.equal(next.batch.selectionRevision, 1); assert.equal(next.jobs.length, 2);
  for (const job of previous.jobs) assert.equal(f.store.getOpportunityWorkflowJob(job.id).status, 'cancelled');
  assert(next.jobs.every(job => job.batchRevision === 1 && !previous.jobs.some(old => old.id === job.id)));
  for (const job of next.jobs) f.store.updateOpportunityWorkflowJob(job.id, { status: 'accepted', messageId: `ACK-${job.recipient}`, now: NOW });
  assert.equal(f.store.getOpportunityWorkflow(op.id).status, 'accepted');
  assert.equal(f.store.listOpportunityWorkflowJobs().length, 4);
});
test('explicitly dispatching the same waiting selection approves it without duplicate tasks', t => {
  const f = fixture(t), op = f.ingest(), first = f.reserve(op.id, { automatic: false });
  const second = f.reserve(op.id, { replaceUnstarted: true });
  assert(second.ok); assert.equal(second.batch.status, 'queued'); assert.deepEqual(second.jobs.map(job => job.id), first.jobs.map(job => job.id));
  assert.equal(f.store.listOpportunityWorkflowJobs().length, 2);
});
test('an attempt already claimed blocks item replacement even before submission', t => {
  const f = fixture(t), op = f.ingest(), first = f.reserve(op.id);
  f.store.claimOpportunityWorkflowJob(first.jobs[0].id, { now: NOW });
  assert.equal(f.reserve(op.id, { replaceUnstarted: true, itemId: 'another' }).code, 'OP_ALREADY_RESPONDED');
});
test('claim rechecks live campaign destinations and deletion while allowing another group after first acceptance', t => {
  const f = fixture(t), op = f.ingest(), jobs = f.reserve(op.id).jobs;
  const first = f.store.claimOpportunityWorkflowJob(jobs[0].id, { now: NOW }).job;
  f.store.updateOpportunityWorkflowJob(first.id, { status: 'accepted', messageId: 'ACK', now: NOW });
  assert.equal(f.store.getOpportunity(op.id).status, 'responded');
  assert(f.store.claimOpportunityWorkflowJob(jobs[1].id, { now: NOW }).ok);
  const g = fixture(t), other = g.ingest(), pending = g.reserve(other.id).jobs;
  g.campaign.groupIds = ['two@g.us'];
  assert.equal(g.store.claimOpportunityWorkflowJob(pending[0].id, { now: NOW }).code, 'OP_RECIPIENT_REMOVED');
  g.campaign.items = [];
  assert.equal(g.store.claimOpportunityWorkflowJob(pending[1].id, { now: NOW }).code, 'OP_CAMPAIGN_REMOVED');
});
test('claim rechecks expiration, contact mute and explicit automation gate', t => {
  for (const scenario of ['expired', 'muted', 'stopped']) {
    const f = fixture(t), op = f.ingest(), job = f.reserve(op.id).jobs[0];
    if (scenario === 'muted') f.store.setOpportunityContactMute(op.senderKey, true, { at: NOW });
    const result = f.store.claimOpportunityWorkflowJob(job.id, { now: scenario === 'expired' ? NOW + 121 * 60000 : NOW, automationAllowed: scenario !== 'stopped' });
    assert.equal(result.ok, false, scenario);
  }
});
test('malformed workflow backup is rejected atomically without changing persisted mode', t => {
  const f = fixture(t), op = f.ingest(); f.reserve(op.id);
  const backup = f.store.exportOpportunityData(); backup.notifications.find(row => row.type === 'campaign-ad').recipient = '5562999999999';
  const before = f.store.exportOpportunityData();
  assert.throws(() => f.store.importOpportunityData(backup), /Destinatário/); assert.deepEqual(f.store.exportOpportunityData(), before);
});
test('aggregated metrics and newest pagination include pending notices beyond the first thousand historic jobs', t => {
  const f = fixture(t), op = f.ingest();
  const statement = f.db.prepare('INSERT INTO op_notifications(storageMode,opportunityId,kind,at,data)VALUES(?,?,?,?,?)');
  f.db.exec('BEGIN IMMEDIATE');
  for (let i = 0; i < 1006; i++) {
    const id = i.toString(16).padStart(64, '0'), kind = `wf:job:${id}`, status = i < 1005 ? 'accepted' : 'queued';
    const data = { id, kind, opportunityId: op.id, type: 'admin-notice', recipient: '5562999999999', body: 'Aviso', status, at: NOW + i, createdAt: NOW + i, updatedAt: NOW + i, clientMessageId: i.toString(16).padStart(32, '0').toUpperCase(), attempts: 1, ...(status === 'accepted' ? { messageId: `ACK-${i}` } : {}) };
    statement.run('whatsapp', op.id, kind, NOW + i, JSON.stringify(data));
  }
  f.db.exec('COMMIT');
  f.store.ensureOpportunityWorkflowIndexes();
  const metrics = f.store.getOpportunityWorkflowMetrics(); assert.equal(metrics.total, 1006); assert.equal(metrics.jobs.accepted, 1005); assert.equal(metrics.jobs.queued, 1); assert.equal(metrics.byType['admin-notice'].queued, 1); assert.equal(metrics.lastUpdatedAt, NOW + 1005);
  assert.equal(f.store.listOpportunityWorkflowJobs({ newest: true, limit: 1 })[0].status, 'queued');
  assert.equal(f.store.listOpportunityWorkflowJobs({ status: 'queued', limit: 1 })[0].status, 'queued');
  f.settings.integrationMode = 'simulated'; assert.deepEqual(f.store.getOpportunityWorkflowMetrics(), { total: 0, jobs: {}, byType: {}, lastUpdatedAt: null });
});
test('reservation rejects a payload substituted for the campaign item without creating jobs', t => {
  const f = fixture(t), op = f.ingest();
  const result = f.reserve(op.id, { itemSnapshot: { ...f.campaign.items[0], text: 'Mensagem diferente da campanha' } });
  assert.equal(result.code, 'OP_OFFER_CHANGED'); assert.equal(f.store.listOpportunityWorkflowJobs().length, 0); assert.equal(f.store.getOpportunityWorkflow(op.id), undefined);
});
