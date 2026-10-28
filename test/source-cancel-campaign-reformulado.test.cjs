'use strict';

// Controlled adapter and OS-protection promises exercise real SQLite and
// managed media. These tests do not connect to or send messages on WhatsApp.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createStore } = require('../src/core/store.cjs');
const { MediaManager } = require('../src/core/media.cjs');
const { SourceCampaignService } = require('../src/core/source-campaigns.cjs');

const GROUP = '120363111111111111@g.us';
const PHONE = '5562999999999';
const CAPTION = '📱 iPhone 16 128GB\nR$ 2.999,00\nDetalhe na tela pequeno';
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { const deadline = Date.now() + 5000; while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); } assert.fail('Controlled asynchronous checkpoint was not reached'); }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-source-cancel-'));
  const clock = { value: Date.parse('2026-10-08T15:00:00Z') }, stores = [], services = [], calls = [];
  let store = await createStore(dir); stores.push(store); store.setSetting('integrationMode', 'whatsapp'); store.upsertGroups([{ id: GROUP, name: 'Origem controlada', simulation: false, authorized: true }]);
  const adapter = new EventEmitter(); adapter.status = { state: options.connected === false ? 'disconnected' : 'connected', mode: 'whatsapp' }; adapter.setSourceCapture = value => { adapter.captureConfig = value; };
  adapter.downloadIncoming = (context, config) => { calls.push({ messageId: context.messageId, signal: config.signal }); return options.download ? options.download(context, config) : Promise.resolve({ buffer: Buffer.from('controlled-image'), name: 'test.jpg', mime: 'image/jpeg' }); };
  const safeStorage = { isEncryptionAvailable: async () => true, encryptString: options.encrypt || (async text => Buffer.from(text)), decryptString: async bytes => Buffer.from(bytes).toString('utf8') };
  const create = () => { const service = new SourceCampaignService({ store, mediaManager: new MediaManager(store), adapter, safeStorage, now: () => clock.value, concurrency: options.concurrency || 2, assertCanCapture: () => true }); services.push(service); return service; };
  let service = create(); service.saveConfig({ enabled: true, groupId: GROUP, allowedParticipantIds: [PHONE] }, 'owner-test'); service.start();
  const context = (id, patch = {}) => ({ messageId: id, chatId: GROUP, timestamp: clock.value, originalTimestamp: clock.value, isGroup: true, identityVerified: true, senderNumber: PHONE, senderId: `${PHONE}@s.whatsapp.net`, senderIds: [`${PHONE}@s.whatsapp.net`], fromMe: false, type: 'image', caption: CAPTION, text: CAPTION, mode: 'whatsapp', simulation: false, raw: { key: { id, remoteJid: GROUP }, message: { imageMessage: { caption: CAPTION } } }, ...patch });
  const publication = (id, patch) => service.handlePublication(context(id, patch)).publication;
  const erase = campaignId => store.transaction(() => { const result = store.pauseSourceForCampaign(campaignId, { at: clock.value }); store.deleteCampaign(campaignId); return result; });
  const reopen = async () => { await service.stop(); store.close(); store = await createStore(dir); stores.push(store); service = create(); service.start(); };
  t.after(async () => { for (const item of services) await item.stop(); for (const instance of stores) instance.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { get store() { return store; }, get service() { return service; }, clock, adapter, calls, context, publication, erase, reopen };
}

test('historical cancellation removes only its queued contexts and frees the capture capacity for the current campaign', async t => {
  const f = await fixture(t, { connected: false }); let old;
  for (let index = 0; index < 63; index++) old = f.publication(`old-queued-${index}`);
  f.clock.value += 86400000; const current = f.publication('current-queued'); assert.equal(f.service.queue.size, 64); const link = f.store.getSourceLink(GROUP);
  const paused = f.erase(old.campaignId); assert.deepEqual(paused.groupIds, []); const result = f.service.cancelCampaignCapture(old.campaignId);
  assert.deepEqual(result, { aborted: 0, queued: 63 }); assert.equal(f.service.queue.size, 1); assert.ok(f.service.queue.has(current.id)); assert.deepEqual(f.store.getSourceLink(GROUP), link); assert.equal(f.adapter.captureConfig.enabled, true);
  const next = f.publication('current-new-after-capacity'); assert.equal(next.status, 'pending'); assert.equal(next.code, null); assert.equal(f.service.queue.size, 2); assert.deepEqual(f.service.cancelCampaignCapture(old.campaignId), { aborted: 0, queued: 0 });
  f.adapter.status = { state: 'connected', mode: 'whatsapp' }; f.adapter.emit('status', f.adapter.status); await f.service.waitForIdle();
  assert.deepEqual(f.calls.map(call => call.messageId).sort(), ['current-new-after-capacity', 'current-queued']); assert.equal(f.store.getSourcePublication(current.id).status, 'ready'); assert.equal(f.store.getSourcePublication(old.id).status, 'removed'); assert.equal(f.store.getCampaign(current.campaignId).items.length, 2);
});

test('cancelling historical encryption aborts only that controller and preserves the current campaign download', async t => {
  const encrypted = deferred(), downloaded = deferred(); let encryptionStarted = false;
  const f = await fixture(t, { encrypt: async text => { if (JSON.parse(text).key.id === 'old-encrypting') { encryptionStarted = true; return encrypted.promise; } return Buffer.from(text); }, download: (context) => context.messageId === 'current-downloading' ? downloaded.promise : Promise.resolve({ buffer: Buffer.from('unexpected-old-image'), name: 'old.jpg', mime: 'image/jpeg' }) });
  const old = f.publication('old-encrypting'); await until(() => encryptionStarted); f.clock.value += 86400000; const current = f.publication('current-downloading'); await until(() => f.calls.some(call => call.messageId === current.messageId));
  const currentSignal = f.calls.find(call => call.messageId === current.messageId).signal, link = f.store.getSourceLink(GROUP), diagnosticsBefore = f.store.queryEntities('diagnostics', { limit: 1 }).total;
  assert.deepEqual(f.erase(old.campaignId).groupIds, []); const result = f.service.cancelCampaignCapture(old.campaignId); assert.deepEqual(result, { aborted: 1, queued: 0 }); assert.equal(currentSignal.aborted, false); assert.deepEqual(f.store.getSourceLink(GROUP), link);
  encrypted.resolve(Buffer.from('late-encrypted-checkpoint')); await tick(); const tombstone = f.store.getSourcePublication(old.id); assert.equal(tombstone.status, 'removed'); assert.equal(tombstone.protectedContext, null); assert.equal(f.calls.some(call => call.messageId === old.messageId), false);
  downloaded.resolve({ buffer: Buffer.from('current-image'), name: 'current.jpg', mime: 'image/jpeg' }); await f.service.waitForIdle(); assert.equal(f.store.getSourcePublication(current.id).status, 'ready'); assert.equal(f.store.getCampaign(current.campaignId).items.length, 1); assert.equal(f.store.listCampaigns().length, 1); assert.equal(f.store.queryEntities('diagnostics', { limit: 1 }).total, diagnosticsBefore + 1);
  assert.deepEqual(f.service.cancelCampaignCapture(old.campaignId), { aborted: 0, queued: 0 });
});

test('a late encryption checkpoint cannot restore protected context after a historical tombstone even before cancellation executes', async t => {
  const encrypted = deferred(); let entered = false;
  const f = await fixture(t, { encrypt: async text => { if (JSON.parse(text).key.id === 'guard-old') { entered = true; return encrypted.promise; } return Buffer.from(text); } });
  const old = f.publication('guard-old'); await until(() => entered); f.clock.value += 86400000; const current = f.publication('guard-current'); await until(() => f.store.getSourcePublication(current.id).status === 'ready');
  assert.deepEqual(f.erase(old.campaignId).groupIds, []); const before = f.store.getSourcePublication(old.id); encrypted.resolve(Buffer.from('late-context-must-not-persist')); await f.service.waitForIdle();
  assert.deepEqual(f.store.getSourcePublication(old.id), before); assert.equal(f.calls.some(call => call.messageId === old.messageId), false); assert.equal(f.store.getSourceLink(GROUP).status, 'active'); assert.equal(f.store.getSourceLink(GROUP).campaignId, current.campaignId); assert.equal(f.store.listMedia().length, 1);
});

test('a late encryption failure does not rewrite a removed publication or emit another failure', async t => {
  const encrypted = deferred(); let entered = false;
  const f = await fixture(t, { encrypt: async text => { if (JSON.parse(text).key.id === 'reject-old') { entered = true; return encrypted.promise; } return Buffer.from(text); } });
  const old = f.publication('reject-old'); await until(() => entered); f.clock.value += 86400000; const current = f.publication('reject-current'); await until(() => f.store.getSourcePublication(current.id).status === 'ready');
  f.erase(old.campaignId); const before = f.store.getSourcePublication(old.id), count = f.store.queryEntities('diagnostics', { limit: 1 }).total; encrypted.reject(new Error('Controlled late OS failure')); await f.service.waitForIdle();
  assert.deepEqual(f.store.getSourcePublication(old.id), before); assert.equal(f.store.queryEntities('diagnostics', { limit: 1 }).total, count); assert.equal(f.calls.some(call => call.messageId === old.messageId), false);
});

test('a deleted historical download releases the slot, ignores late failure, and cannot retry or recreate after restart', async t => {
  const oldDownload = deferred();
  const f = await fixture(t, { concurrency: 1, download: context => context.messageId === 'download-old' ? oldDownload.promise : Promise.resolve({ buffer: Buffer.from('current-only'), name: 'current.jpg', mime: 'image/jpeg' }) });
  const old = f.publication('download-old'); await until(() => f.calls.some(call => call.messageId === old.messageId)); const oldSignal = f.calls[0].signal; f.clock.value += 86400000; const current = f.publication('download-current');
  f.erase(old.campaignId); assert.deepEqual(f.service.cancelCampaignCapture(old.campaignId), { aborted: 1, queued: 0 }); assert.equal(oldSignal.aborted, true); await f.service.waitForIdle(); assert.equal(f.store.getSourcePublication(current.id).status, 'ready');
  const count = f.store.queryEntities('diagnostics', { limit: 1 }).total; oldDownload.reject(new Error('Controlled late transport failure')); await tick(); assert.equal(f.store.queryEntities('diagnostics', { limit: 1 }).total, count); assert.equal(f.store.getSourcePublication(old.id).status, 'removed'); assert.equal(f.store.getCampaign(old.campaignId), undefined);
  await f.reopen(); await f.service.waitForIdle(); assert.equal(f.calls.length, 2); assert.equal(f.service.handlePublication(f.context(old.messageId, { originalTimestamp: old.originalAt })).duplicate, true); assert.equal(f.service.handleUpdate(f.context(old.messageId, { timestamp: f.clock.value, revisionAt: f.clock.value })).ignored, true); assert.throws(() => f.service.retryPublication(old.id), { code: 'SOURCE_PUBLICATION_NOT_FOUND' }); assert.equal(f.store.getSourceLink(GROUP).campaignId, current.campaignId);
  const late = f.publication('different-late-old-message', { originalTimestamp: old.originalAt, timestamp: old.originalAt }); assert.equal(late.code, 'SOURCE_CAMPAIGN_REMOVED'); assert.equal(late.status, 'failed'); assert.equal(f.service.handlePublication(f.context(late.messageId, { originalTimestamp: old.originalAt, timestamp: old.originalAt })).duplicate, true); await f.service.waitForIdle(); assert.equal(f.store.getSourceLink(GROUP).campaignId, current.campaignId); assert.equal(f.store.getSourceLink(GROUP).status, 'active'); assert.equal(f.store.listCampaigns().length, 1); assert.equal(f.calls.length, 2);
});

test('current-campaign cancellation is idempotent when the group cancellation has already aborted its work', async t => {
  const pending = deferred(); const f = await fixture(t, { download: () => pending.promise }); const original = f.publication('current-delete'); await until(() => f.calls.length === 1);
  const paused = f.erase(original.campaignId); assert.deepEqual(paused.groupIds, [GROUP]); f.service.cancelGroupCapture(GROUP); assert.deepEqual(f.service.cancelCampaignCapture(original.campaignId), { aborted: 0, queued: 0 }); await f.service.waitForIdle(); pending.resolve({ buffer: Buffer.from('late'), name: 'late.jpg', mime: 'image/jpeg' }); await tick(); assert.equal(f.store.getSourcePublication(original.id).status, 'removed'); assert.equal(f.store.listMedia().length, 0); assert.equal(f.store.getSourceLink(GROUP).status, 'paused'); assert.equal(f.adapter.captureConfig.enabled, false);
});
