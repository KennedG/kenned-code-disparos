'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const { createStore } = require('../src/core/store.cjs');
const { MediaManager } = require('../src/core/media.cjs');
const { SourceCampaignService, normalizeSourceConfig, localDay, sanitizeSourcePublication } = require('../src/core/source-campaigns.cjs');

const CAPTION = '📱 iPhone 16 128GB\n🩷 Cor: ROSA\n🔋 Saúde da bateria: 92%\nR$ 2.999,00\nDetalhe na tela pequeno\n\n𝗣𝗮𝗹𝗮𝗰𝗲 𝗣𝗮𝗿𝗳𝘂𝗺 - 𝗖𝗮𝗺𝗲𝗹𝗼́𝗱𝗿𝗼𝗺𝗼 𝗢𝗞 𝗦𝗧𝗔𝗡𝗗 𝟭𝟯𝟬/𝟭𝟯𝟭';
const GROUP = '120363012345678901@g.us', DESTINATION = '120363012345678902@g.us', PHONE = '5562999999999';
function vault() {
  const key = randomBytes(32);
  return { isEncryptionAvailable: async () => true,
    encryptString: async text => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]); },
    decryptString: async data => { const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); decipher.setAuthTag(data.subarray(-16)); return Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString('utf8'); }
  };
}
async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-source-232-'));
  const clock = { value: Date.parse('2026-10-08T12:00:00Z') }, gate = { stopped: false, permitted: true };
  let store = await createStore(dir); store.setSetting('integrationMode', options.mode || 'whatsapp');
  const adapter = new EventEmitter(); adapter.status = { state: options.connected === false ? 'disconnected' : 'connected', mode: options.mode || 'whatsapp' };
  const calls = []; const protection = options.safeStorage || vault();
  adapter.setSourceCapture = config => { adapter.captureConfig = config; };
  adapter.downloadIncoming = async (context, config) => { calls.push({ context, config }); return options.download ? options.download(context, config) : { buffer: Buffer.from('test-image-bytes'), name: 'foto.jpg', mime: 'image/jpeg', type: 'image' }; };
  const group = options.mode === 'simulated' ? 'source-test@simulation' : GROUP;
  store.upsertGroups([{ id: group, name: 'Grupo real de teste autorizado', simulation: options.mode === 'simulated', authorized: true }, { id: DESTINATION, name: 'Destino de teste', simulation: options.mode === 'simulated', authorized: true }]);
  const services = [], stores = [store];
  const create = target => { const service = new SourceCampaignService({ store: target || store, mediaManager: new MediaManager(target || store), adapter, safeStorage: protection, now: () => clock.value,
    isAutomationStopped: () => gate.stopped, assertCanCapture: actorId => { assert.equal(actorId, 'owner-test'); return gate.permitted; }, concurrency: options.concurrency || 1 }); services.push(service); return service; };
  let service = create(); service.saveConfig({ enabled: true, groupId: group, allowedParticipantIds: [PHONE], allowOwnMessages: true, mediaTimeoutSeconds: options.timeout || 30 }, 'owner-test'); service.start();
  const publication = (id, patch = {}) => ({ messageId: id, chatId: group, timestamp: clock.value, originalTimestamp: clock.value, isGroup: true,
    identityVerified: true, senderNumber: PHONE, senderId: `${PHONE}@s.whatsapp.net`, senderIds: [`${PHONE}@s.whatsapp.net`],
    fromMe: false, trustedSelf: false, automaticMessage: false, type: 'image', text: CAPTION, caption: CAPTION,
    mode: options.mode || 'whatsapp', simulation: options.mode === 'simulated',
    raw: { key: { id, remoteJid: group }, message: { imageMessage: { caption: CAPTION, mediaKey: Buffer.from('SOURCE_TEST_MEDIA_SECRET'), directPath: '/private/test/media' } } }, ...patch });
  const reopen = async () => { await service.stop(); store.close(); store = await createStore(dir); stores.push(store); service = create(store); service.start(); return { store, service }; };
  t.after(async () => { for (const item of services) await item.stop(); for (const item of stores) item.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, get store() { return store; }, get service() { return service; }, clock, gate, adapter, calls, publication, group, reopen, create, protection };
}

test('manual photo plus caption creates one draft with exact Unicode, media bytes and original timestamp', async t => {
  const f = await fixture(t); const accepted = f.service.handlePublication(f.publication('ONE'));
  assert(accepted.publication.campaignId); assert.equal(f.store.getCampaign(accepted.publication.campaignId).items.length, 0); assert.equal(f.store.getSourceMetrics({ campaignId: accepted.publication.campaignId }).pending, 1);
  await f.service.waitForIdle();
  const record = f.store.getSourcePublication(accepted.publication.id), campaign = f.store.getCampaign(record.campaignId);
  assert.equal(record.status, 'ready'); assert.equal(record.originalAt, f.clock.value); assert.equal(campaign.name, 'Lista da loja — 08/10/2026');
  assert.equal(campaign.state, 'draft'); assert.deepEqual(campaign.groupIds, []); assert.equal(campaign.items.length, 1); assert.equal(campaign.items[0].caption, CAPTION);
  assert.equal(campaign.sourceGroupId, GROUP); assert.equal(campaign.items[0].sourcePublicationId, record.id);
  assert.equal(fs.readFileSync(f.store.getMedia(record.mediaId).path, 'utf8'), 'test-image-bytes');
  assert.equal(record.raw, undefined); assert(record.protectedContext); assert.equal(record.caption, CAPTION);
});

test('verified manual messages from connected account are configurable; automated and outbound messages never capture', async t => {
  const f = await fixture(t);
  assert(f.service.handlePublication(f.publication('SELF', { fromMe: true, trustedSelf: true })).accepted);
  for (const [id, patch] of [['UNTRUSTED_SELF', { fromMe: true, trustedSelf: false }], ['AUTO', { fromMe: true, trustedSelf: true, automaticMessage: true }], ['ROBOT', { automated: true }]]) assert(f.service.handlePublication(f.publication(id, patch)).ignored);
  f.store.registerOutboundMessageId('OUTBOUND'); assert(f.service.handlePublication(f.publication('OUTBOUND', { fromMe: true, trustedSelf: true })).ignored);
  f.service.saveConfig({ allowOwnMessages: false }, 'owner-test'); assert(f.service.handlePublication(f.publication('SELF_DISABLED', { fromMe: true, trustedSelf: true })).ignored);
  await f.service.waitForIdle(); assert.equal(f.store.listSourcePublications().total, 1);
});

test('authorization uses verified phone or exact account ID and rejects display-name/ambiguous identities', async t => {
  const f = await fixture(t);
  for (const patch of [{ identityVerified: false }, { senderNumber: '5562888888888', senderId: '5562888888888@s.whatsapp.net', senderIds: [] }, { senderNumber: null, senderId: '7777777@lid', senderIds: [], displayName: PHONE }, { simulation: true }]) assert(f.service.handlePublication(f.publication(`NO-${JSON.stringify(patch)}`, patch)).ignored);
  f.service.saveConfig({ allowedParticipantIds: ['7777777@lid'] }, 'owner-test');
  assert(f.service.handlePublication(f.publication('REAL_LID', { senderNumber: null, senderId: '7777777@lid', senderIds: ['7777777@lid'] })).accepted);
  await f.service.waitForIdle(); assert.equal(f.store.listSourcePublications().total, 1); assert.equal(f.store.listSourcePublications().items[0].senderPhone, null);
  assert.throws(() => f.service.saveConfig({ allowedParticipantIds: ['João dono'] }, 'owner-test'), { code: 'SOURCE_PARTICIPANTS_INVALID' });
});

test('new publications only after enabling; history requires explicit range and true adapter support', async t => {
  const f = await fixture(t);
  assert(f.service.handlePublication(f.publication('BEFORE', { timestamp: f.clock.value - 1, originalTimestamp: f.clock.value - 1 })).ignored);
  assert(f.service.handlePublication(f.publication('HISTORICAL', { historical: true })).ignored);
  await assert.rejects(f.service.importHistory({ from: f.clock.value - 10000, to: f.clock.value }), { code: 'SOURCE_HISTORY_UNSUPPORTED' });
  assert.equal(f.store.listCampaigns().length, 0);
  f.adapter.listSourceHistory = async (groupId, period) => { assert.equal(groupId, GROUP); return [f.publication('EXPLICIT', { originalTimestamp: period.from, timestamp: period.from })]; };
  const imported = await f.service.importHistory({ from: f.clock.value - 10000, to: f.clock.value }); await f.service.waitForIdle();
  assert.equal(imported.captured, 1); assert.equal(imported.complete, false); assert.equal(f.store.listSourcePublications().items[0].originalAt, f.clock.value - 10000);
});

test('simultaneous/replayed publication events create a single record and campaign per date/group', async t => {
  const f = await fixture(t, { concurrency: 2 });
  await Promise.all(Array.from({ length: 10 }, (_, i) => Promise.resolve(f.service.handlePublication(f.publication(`M-${i % 3}`)))));
  await f.service.waitForIdle(); assert.equal(f.store.listSourcePublications().total, 3); assert.equal(f.store.listCampaigns().length, 1); assert.equal(f.store.listCampaigns()[0].items.length, 3); assert.equal(f.calls.length, 3);
  const id = f.store.listCampaigns()[0].id; await f.reopen(); assert.equal(f.service.handlePublication(f.publication('M-1')).duplicate, true); await f.service.waitForIdle();
  assert.equal(f.store.listCampaigns().length, 1); assert.equal(f.store.listCampaigns()[0].id, id); assert.equal(f.calls.length, 3);
});

test('daily rollover uses original publication time in Brasília independent of UTC calendar date', async t => {
  const f = await fixture(t); f.clock.value = Date.parse('2026-10-09T02:59:59Z'); f.service.handlePublication(f.publication('BEFORE_MIDNIGHT')); await f.service.waitForIdle();
  f.clock.value = Date.parse('2026-10-09T03:00:00Z'); f.service.handlePublication(f.publication('AFTER_MIDNIGHT')); await f.service.waitForIdle();
  assert.deepEqual(f.store.listCampaigns().map(c => c.name), ['Lista da loja — 08/10/2026', 'Lista da loja — 09/10/2026']);
  assert.equal(localDay(Date.parse('2026-10-09T02:59:59Z')), '2026-10-08');
});

test('media failure and timeout do not block later valid items or invent readiness', async t => {
  const f = await fixture(t, { timeout: 1, download: async context => {
    if (context.messageId === 'FAIL') throw Object.assign(new Error('Download indisponível.'), { code: 'TEST_MEDIA_FAILED' });
    if (context.messageId === 'HANG') return new Promise(() => {});
    return { buffer: Buffer.from('next-valid'), name: 'valid.jpg', mime: 'image/jpeg' };
  } });
  for (const id of ['FAIL', 'HANG', 'VALID']) f.service.handlePublication(f.publication(id)); await f.service.waitForIdle();
  assert.equal(f.store.getSourcePublication(GROUP, 'FAIL').status, 'failed'); assert.equal(f.store.getSourcePublication(GROUP, 'HANG').code, 'SOURCE_MEDIA_DOWNLOAD_TIMEOUT');
  assert.equal(f.store.getSourcePublication(GROUP, 'VALID').status, 'ready'); assert.equal(f.store.listCampaigns()[0].items.length, 1);
});

test('photo without caption and nearby text remain separate until explicit review', async t => {
  const f = await fixture(t); const photo = f.service.handlePublication(f.publication('EMPTY_PHOTO', { caption: '', text: '' })).publication;
  const text = f.service.handlePublication(f.publication('SEPARATE_TEXT', { type: 'text', raw: undefined })).publication;
  await f.service.waitForIdle(); assert.equal(f.store.getSourcePublication(photo.id).status, 'review'); assert.equal(f.store.listCampaigns().length, 0);
  assert.equal(f.store.getSourcePublication(text.id).status, 'review'); assert.notEqual(photo.id, text.id);
  f.service.reviewPublication(photo.id, { caption: CAPTION }, 'owner-test'); assert.equal(f.store.listCampaigns()[0].items[0].caption, CAPTION);
  assert.equal(f.store.getSourcePublication(text.id).status, 'review');
});

test('persisted pending download recovers with protected protobuf and no publication duplicate', async t => {
  let failing = true; const f = await fixture(t, { download: async context => {
    if (failing) throw new Error('Temporariamente indisponível.');
    assert(Buffer.isBuffer(context.raw.message.imageMessage.mediaKey)); return { buffer: Buffer.from('retry-ok'), name: 'retry.jpg', mime: 'image/jpeg' };
  } });
  const result = f.service.handlePublication(f.publication('RETRY')); await f.service.waitForIdle(); assert.equal(f.store.getSourcePublication(result.publication.id).status, 'failed');
  await f.reopen(); failing = false; f.service.retryPublication(result.publication.id); await f.service.waitForIdle();
  assert.equal(f.store.getSourcePublication(result.publication.id).status, 'ready'); assert.equal(f.store.listCampaigns().length, 1); assert.equal(f.store.listCampaigns()[0].items.length, 1); assert.equal(f.calls.length, 2);
  assert.equal(fs.readFileSync(f.store.filename).includes(Buffer.from('SOURCE_TEST_MEDIA_SECRET')), false);
});

test('unavailable OS protection permits in-memory capture but never persists plaintext and explains durable retry', async t => {
  const f = await fixture(t, { safeStorage: { isEncryptionAvailable: async () => false }, download: async () => { throw new Error('Download offline.'); } });
  const result = f.service.handlePublication(f.publication('NO_VAULT')); await f.service.waitForIdle();
  const record = f.store.getSourcePublication(result.publication.id); assert.equal(record.protectedContext, null); assert.equal(record.retryRequiresRepost, true); assert.equal(record.raw, undefined);
  assert.equal(JSON.stringify(record).includes('SOURCE_TEST_MEDIA_SECRET'), false);
  await f.reopen(); f.service.retryPublication(record.id); await f.service.waitForIdle(); assert.equal(f.store.getSourcePublication(record.id).code, 'SOURCE_MEDIA_REPOST_REQUIRED');
  assert.equal(f.store.listCampaigns().length, 1); assert.equal(f.store.listCampaigns()[0].items.length, 0);
});

test('new and edited items update only next campaign contents; previous operational snapshots remain unchanged', async t => {
  const f = await fixture(t); const publication = f.service.handlePublication(f.publication('EDIT')).publication; await f.service.waitForIdle();
  const record = f.store.getSourcePublication(publication.id), campaign = f.store.getCampaign(record.campaignId), snapshot = structuredClone(campaign.items[0]);
  f.store.saveCampaign({ ...campaign, state: 'active', nextRunAt: f.clock.value + 600000 });
  f.store.insertRound({ id: 'ROUND-1', campaignId: campaign.id, startedAt: f.clock.value, finishedAt: null, status: 'running' });
  f.store.insertJob({ id: 'JOB-1', campaignId: campaign.id, roundId: 'ROUND-1', groupId: DESTINATION, itemId: snapshot.id, itemSnapshot: snapshot, status: 'confirmed', createdAt: f.clock.value, resultAt: f.clock.value, attempts: 1 });
  f.clock.value += 1000; f.service.handlePublication(f.publication('NEW'));
  const edited = CAPTION.replace('2.999,00', '2.950,00'); f.service.handleUpdate(f.publication('EDIT', { text: edited, caption: edited, revisionAt: f.clock.value, originalTimestamp: null })); await f.service.waitForIdle();
  const updated = f.store.getCampaign(campaign.id); assert.equal(updated.state, 'active'); assert.equal(updated.items.length, 2); assert.equal(updated.items[0].caption, edited);
  assert.equal(f.store.getJob('JOB-1').itemSnapshot.caption, CAPTION); assert.equal(f.store.getSourcePublication(publication.id).originalAt, campaign.createdAt);
});

test('delete event/manual removal cancel only jobs not started and preserve sent history and media', async t => {
  const f = await fixture(t); const publication = f.service.handlePublication(f.publication('DELETE')).publication; await f.service.waitForIdle();
  const record = f.store.getSourcePublication(publication.id), campaign = f.store.getCampaign(record.campaignId);
  f.store.insertRound({ id: 'ROUND-DELETE', campaignId: campaign.id, startedAt: f.clock.value, finishedAt: null, status: 'running' });
  for (const [id, status] of [['QUEUED', 'queued'], ['SENDING', 'sending'], ['CONFIRMED', 'confirmed'], ['UNCERTAIN', 'uncertain']]) f.store.insertJob({ id, campaignId: campaign.id, roundId: 'ROUND-DELETE', groupId: `${id.toLowerCase()}@g.us`, itemId: record.itemId, itemSnapshot: campaign.items[0], status, createdAt: f.clock.value, attempts: status === 'queued' ? 0 : 1 });
  const result = f.service.handleDelete({ chatId: GROUP, messageId: 'DELETE', deletedAt: f.clock.value });
  assert.equal(result.cancelled, 1); assert.equal(f.store.getCampaign(campaign.id).items.length, 0); assert.equal(f.store.getJob('QUEUED').status, 'cancelled');
  for (const status of ['sending', 'confirmed', 'uncertain']) assert.equal(f.store.getJob(status.toUpperCase()).status, status);
  assert(f.store.getMedia(record.mediaId)); assert.equal(f.service.handlePublication(f.publication('DELETE')).duplicate, true);
  assert.equal(f.service.removePublication(record.id).removed, false);
});

test('saved configuration template reuses intervals and destinations but cannot target the origin', async t => {
  const f = await fixture(t); assert.throws(() => f.service.saveConfig({ configTemplate: { groupIds: [GROUP] } }, 'owner-test'), { code: 'SOURCE_CAPTURE_CYCLE' });
  f.service.saveConfig({ configTemplate: { groupIds: [DESTINATION], intervalMinutes: 15, messageSpacingSeconds: 4, spacingSeconds: 8, maxRounds: 3 } }, 'owner-test');
  const accepted = f.service.handlePublication(f.publication('CONFIG')); await f.service.waitForIdle(); const campaignId = f.store.getSourcePublication(accepted.publication.id).campaignId;
  assert.deepEqual(f.store.getCampaign(campaignId).groupIds, []); const updated = f.service.applyConfigTemplate(campaignId);
  assert.deepEqual(updated.groupIds, [DESTINATION]); assert.equal(updated.messageSpacingSeconds, 4); assert.equal(updated.spacingSeconds, 8); assert.equal(updated.maxRounds, 3); assert.equal(updated.state, 'draft');
  await f.reopen(); assert.equal(f.service.getConfig().configTemplate.intervalMinutes, 15); assert.equal(f.store.getCampaign(campaignId).state, 'draft');
});

test('renaming origin retains immutable group ID and item reorder remains explicit', async t => {
  const f = await fixture(t); for (const id of ['ORDER1', 'ORDER2']) f.service.handlePublication(f.publication(id)); await f.service.waitForIdle();
  f.store.upsertGroups([{ id: GROUP, name: 'Nome alterado', simulation: false }]); assert.equal(f.service.getConfig().groupId, GROUP); assert.equal(f.service.metrics().groupName, 'Nome alterado');
  const campaign = f.store.listCampaigns()[0], order = [...campaign.items].reverse().map(item => item.id);
  assert.deepEqual(f.service.reorderItems(campaign.id, order).items.map(item => item.id), order);
  assert.throws(() => f.service.reorderItems(campaign.id, [order[0], order[0]]), { code: 'SOURCE_ITEM_ORDER_INVALID' });
});

test('disabled module, automation stop and permission revocation refuse new automatic entries', async t => {
  const f = await fixture(t); f.gate.stopped = true; assert(f.service.handlePublication(f.publication('STOPPED')).ignored);
  f.gate.stopped = false; f.gate.permitted = false; assert(f.service.handlePublication(f.publication('REVOKED')).ignored);
  f.gate.permitted = true; f.service.saveConfig({ enabled: false }, 'owner-test'); assert(f.service.handlePublication(f.publication('DISABLED')).ignored);
  assert.equal(f.store.listSourcePublications().total, 0);
});

test('real and simulated publications, configuration, campaigns and media never share storage selectors', async t => {
  const f = await fixture(t); f.service.handlePublication(f.publication('REAL')); await f.service.waitForIdle(); assert.equal(f.store.getSourceMetrics().ready, 1);
  f.store.setSetting('integrationMode', 'simulated'); assert.equal(f.store.listSourcePublications().total, 0); assert.equal(f.service.getConfig().enabled, false); assert.equal(f.store.listCampaigns().length, 0);
  const simulatedGroup = 'source-test@simulation'; f.store.upsertGroups([{ id: simulatedGroup, name: 'SIMULAÇÃO — DADOS FICTÍCIOS', simulation: true, authorized: true }]);
  f.service.saveConfig({ enabled: true, groupId: simulatedGroup, allowedParticipantIds: [PHONE] }, 'owner-test');
  assert(f.service.handlePublication(f.publication('REAL-IN-SIM')).ignored);
  assert(f.service.handlePublication(f.publication('SIM', { chatId: simulatedGroup, mode: 'simulated', simulation: true })).accepted); await f.service.waitForIdle();
  assert.equal(f.store.getSourceMetrics().ready, 1); assert.equal(f.store.listCampaigns()[0].storageMode, 'simulated');
  f.store.setSetting('integrationMode', 'whatsapp'); assert.equal(f.store.listSourcePublications().total, 1); assert.equal(f.store.listSourcePublications().items[0].messageId, 'REAL'); assert.equal(f.store.listCampaigns().length, 1);
});

test('manual grouping retains all photos and originals without association by nearby timestamps', async t => {
  const f = await fixture(t); const records = ['G1', 'G2'].map(id => f.service.handlePublication(f.publication(id, { caption: '', text: '' })).publication); await f.service.waitForIdle();
  const result = f.service.groupPublications(records.map(record => record.id), { caption: CAPTION }, 'owner-test');
  assert.equal(result.association, 'manual'); assert.equal(f.store.listCampaigns()[0].items.length, 2);
  for (const record of records) { const updated = f.store.getSourcePublication(record.id); assert.equal(updated.originalCaption, ''); assert.equal(updated.manualGroupId, result.groupKey); assert.equal(updated.caption, CAPTION); }
});

test('caption content is data only; !mega or !busca inside it never executes a command', async t => {
  const f = await fixture(t), dangerous = `${CAPTION}\n!mega parar tudo\n!busca iPhone 15`;
  f.service.handlePublication(f.publication('DATA_ONLY', { caption: dangerous, text: dangerous })); await f.service.waitForIdle();
  assert.equal(f.gate.stopped, false); assert.equal(f.store.listCampaigns()[0].items[0].caption, dangerous);
});

test('config rejects invalid timeouts, participant names and missing origin without silently normalizing IDs', () => {
  for (const input of [{ enabled: true }, { allowedParticipantIds: ['123@lid-falso'] }, { mediaTimeoutSeconds: 0 }, { configTemplate: { maxRounds: 1.5 } }, { timezone: 'INVALID' }]) assert.throws(() => normalizeSourceConfig(input));
  assert.equal(normalizeSourceConfig({ allowedParticipantIds: ['+55 (62) 99999-9999'] }).allowedParticipantIds[0], PHONE);
});

test('revocation arriving before publication leaves a tombstone and never creates a later item', async t => {
  const f = await fixture(t); const deleted = f.service.handleDelete({ chatId: GROUP, messageId: 'DELETED_EARLY', deletedAt: f.clock.value });
  assert.equal(deleted.tombstone, true); assert.equal(f.service.handlePublication(f.publication('DELETED_EARLY')).duplicate, true);
  await f.service.waitForIdle(); assert.equal(f.store.listCampaigns().length, 0); assert.equal(f.calls.length, 0); assert.equal(f.store.getSourcePublication(GROUP, 'DELETED_EARLY').status, 'removed');
});

test('suspension cancels a hung download promptly and requires explicit capture resume', async t => {
  let downloads = 0; const f = await fixture(t, { download: async () => { if (++downloads === 1) return new Promise(() => {}); return { buffer: Buffer.from('resumed'), name: 'resumed.jpg', mime: 'image/jpeg' }; } });
  const record = f.service.handlePublication(f.publication('SUSPEND')).publication;
  for (let attempts = 0; f.calls.length === 0 && attempts < 20; attempts++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1); const started = Date.now(); f.service.suspendCapture(); await f.service.waitForIdle();
  assert(Date.now() - started < 500); assert.equal(f.store.getSourcePublication(record.id).status, 'pending'); assert(f.service.handlePublication(f.publication('SUSPENDED_NEW')).ignored);
  assert.equal(f.store.listCampaigns().length, 1); assert.equal(f.store.listCampaigns()[0].items.length, 0); f.service.resumeCapture(); await f.service.waitForIdle(); assert.equal(f.store.getSourcePublication(record.id).status, 'ready'); assert.equal(downloads, 2);
});

test('late media completion after timeout never appends a phantom item or blocks the next photo', async t => {
  let release; const f = await fixture(t, { timeout: 1, download: context => context.messageId === 'LATE' ? new Promise(resolve => { release = resolve; }) : { buffer: Buffer.from('on-time'), name: 'ontime.jpg', mime: 'image/jpeg' } });
  f.service.handlePublication(f.publication('LATE')); f.service.handlePublication(f.publication('ON_TIME')); await f.service.waitForIdle();
  assert.equal(f.store.getSourcePublication(GROUP, 'LATE').status, 'failed'); assert.equal(f.store.listCampaigns()[0].items.length, 1); assert.equal(f.store.listMedia().length, 1);
  release({ buffer: Buffer.from('late-file'), name: 'late.jpg', mime: 'image/jpeg' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.listCampaigns()[0].items.length, 1); assert.equal(f.store.listMedia().length, 1); assert.equal(f.store.getSourcePublication(GROUP, 'LATE').status, 'failed');
});

test('attempt deadline includes the OS encryption bridge so a hung bridge does not block later items', async t => {
  const protection = vault(); let encryptions = 0; const safeStorage = { ...protection, encryptString: text => ++encryptions === 1 ? new Promise(() => {}) : protection.encryptString(text) };
  const f = await fixture(t, { timeout: 1, safeStorage });
  f.service.handlePublication(f.publication('CRYPTO_HANG')); f.service.handlePublication(f.publication('CRYPTO_NEXT')); await f.service.waitForIdle();
  assert.equal(f.store.getSourcePublication(GROUP, 'CRYPTO_HANG').code, 'SOURCE_MEDIA_DOWNLOAD_TIMEOUT'); assert.equal(f.store.getSourcePublication(GROUP, 'CRYPTO_NEXT').status, 'ready'); assert.equal(f.store.listCampaigns()[0].items.length, 1);
});

test('changing origin while downloading cannot promote old-origin publications under the new settings', async t => {
  const f = await fixture(t, { download: context => context.chatId === GROUP ? new Promise(() => {}) : { buffer: Buffer.from('new-origin'), name: 'origin.jpg', mime: 'image/jpeg' } });
  const old = f.service.handlePublication(f.publication('OLD_ORIGIN')).publication;
  for (let attempts = 0; f.calls.length === 0 && attempts < 20; attempts++) await new Promise(resolve => setImmediate(resolve));
  const otherGroup = '120363012345678999@g.us'; f.store.upsertGroups([{ id: otherGroup, name: 'Nova origem de teste', simulation: false }]); f.clock.value += 1000;
  f.service.saveConfig({ groupId: otherGroup }, 'owner-test'); f.service.handlePublication(f.publication('NEW_ORIGIN', { chatId: otherGroup })); await f.service.waitForIdle();
  assert.equal(f.store.getSourcePublication(old.id).status, 'pending'); assert.equal(f.store.listCampaigns().length, 2); assert.equal(f.store.listCampaigns()[0].items.length, 0); assert.equal(f.store.listCampaigns()[1].sourceGroupId, otherGroup);
});

test('same image caption edits reuse media, actual file fingerprint changes replace only upcoming image', async t => {
  const f = await fixture(t); const accepted = f.service.handlePublication(f.publication('FINGERPRINT', { mediaFingerprint: 'a'.repeat(64) })); await f.service.waitForIdle();
  const first = f.store.getSourcePublication(accepted.publication.id), oldMediaId = first.mediaId;
  f.clock.value += 1000; f.service.handleUpdate(f.publication('FINGERPRINT', { mediaFingerprint: 'a'.repeat(64), revisionAt: f.clock.value, caption: CAPTION + '\nEditado' })); await f.service.waitForIdle();
  assert.equal(f.calls.length, 1); assert.equal(f.store.getSourcePublication(first.id).mediaId, oldMediaId);
  f.clock.value += 1000; f.service.handleUpdate(f.publication('FINGERPRINT', { mediaFingerprint: 'b'.repeat(64), revisionAt: f.clock.value })); await f.service.waitForIdle();
  const replacement = f.store.getSourcePublication(first.id); assert.equal(f.calls.length, 2); assert.notEqual(replacement.mediaId, oldMediaId); assert.equal(f.store.listCampaigns()[0].items.length, 1); assert(f.store.getMedia(oldMediaId));
});

test('renderer-safe publication details omit encrypted and plaintext media credentials', async t => {
  const f = await fixture(t); const accepted = f.service.handlePublication(f.publication('SAFE_DETAILS')); await f.service.waitForIdle();
  const internal = f.store.getSourcePublication(accepted.publication.id), safe = sanitizeSourcePublication(internal);
  assert(internal.protectedContext); assert.equal(safe.protectedContext, undefined); assert.equal(safe.raw, undefined); assert.equal(safe.caption, CAPTION); assert.equal(safe.mediaId, internal.mediaId);
});

test('default queue and campaign item order follow publication arrival even when message IDs sort differently', async t => {
  const f = await fixture(t); f.service.handlePublication(f.publication('ZZ_FIRST')); f.service.handlePublication(f.publication('AA_SECOND')); await f.service.waitForIdle();
  assert.deepEqual(f.calls.map(call => call.context.messageId), ['ZZ_FIRST', 'AA_SECOND']);
  const campaign = f.store.listCampaigns()[0]; assert.deepEqual(campaign.items.map(item => f.store.getSourcePublication(item.sourcePublicationId).messageId), ['ZZ_FIRST', 'AA_SECOND']);
});

test('photo review media is protected from library deletion until its publication is removed', async t => {
  const f = await fixture(t), accepted = f.service.handlePublication(f.publication('PHOTO_REVIEW', { text: '', caption: '' })); await f.service.waitForIdle();
  const record = f.store.getSourcePublication(accepted.publication.id), auth = { assertFor: () => ({ id: 'owner-test' }), canFor: () => true };
  const manager = new MediaManager(f.store, { auth }); const preview = manager.inspectDeletion([record.mediaId], 'owner-test');
  assert.equal(preview.canDelete, false); assert(preview.items[0].references.some(reference => reference.kind === 'sourcePublication'));
  await assert.rejects(manager.deleteFiles([record.mediaId], { confirmation: 'EXCLUIR', userId: 'owner-test' }), { code: 'MEDIA_IN_USE' });
  f.service.removePublication(record.id); assert.equal(manager.inspectDeletion([record.mediaId], 'owner-test').canDelete, true);
  assert.equal((await manager.deleteFiles([record.mediaId], { confirmation: 'EXCLUIR', userId: 'owner-test' })).count, 1);
});

test('portable backup restores source captions, ready files and daily identity with capture paused and no media credentials', async t => {
  const f = await fixture(t); f.service.handlePublication(f.publication('BACKUP_READY')); f.service.handlePublication(f.publication('BACKUP_REVIEW', { text: '', caption: '' })); await f.service.waitForIdle();
  const filename = path.join(f.dir, 'portable-source-backup.json'); await new MediaManager(f.store).createBackup(filename);
  const backup = JSON.parse(fs.readFileSync(filename, 'utf8')); assert.equal(backup.sources.publications.length, 2);
  assert.equal(JSON.stringify(backup.sources).includes('protectedContext'), false); assert.equal(JSON.stringify(backup.sources).includes('SOURCE_TEST_MEDIA_SECRET'), false);
  const target = await fixture(t); await target.service.stop(); const result = await new MediaManager(target.store).restoreBackup(filename);
  assert.equal(result.campaigns, 1); assert.equal(target.store.listSourcePublications().total, 2); assert.equal(target.store.getSourceConfig().enabled, false); assert.equal(target.store.getSourceConfig().ownerId, null);
  const restored = target.store.getSourcePublication(GROUP, 'BACKUP_READY'); assert.equal(restored.caption, CAPTION); assert.equal(restored.protectedContext, null); assert.equal(restored.status, 'ready');
  assert.equal(fs.readFileSync(target.store.getMedia(restored.mediaId).path, 'utf8'), 'test-image-bytes'); assert.equal(target.store.getSourceDay(GROUP, restored.dateKey).campaignId, restored.campaignId);
  assert.equal(target.store.listCampaigns()[0].state, 'draft');
});

test('native media import abort or mode switch cannot commit an orphan file into the other storage mode', async t => {
  const f = await fixture(t), manager = new MediaManager(f.store), controller = new AbortController(), originalRename = fs.promises.rename;
  let switchMode = true;
  fs.promises.rename = async (...args) => { const result = await originalRename(...args); if (switchMode) { switchMode = false; f.store.setSetting('integrationMode', 'simulated'); } return result; };
  try { await assert.rejects(manager.importBuffer(Buffer.from('mode-sensitive-file'), { name: 'switch.jpg', mime: 'image/jpeg', expectedMode: 'whatsapp', signal: controller.signal }), { code: 'MEDIA_IMPORT_CANCELLED' }); }
  finally { fs.promises.rename = originalRename; }
  assert.equal(f.store.listMedia().length, 0); f.store.setSetting('integrationMode', 'whatsapp'); assert.equal(f.store.listMedia().length, 0);
  assert.deepEqual(fs.readdirSync(manager.dir), []);
  controller.abort(); await assert.rejects(manager.importBuffer(Buffer.from('abort-file'), { name: 'abort.jpg', mime: 'image/jpeg', signal: controller.signal }), { code: 'MEDIA_IMPORT_CANCELLED' });
});

test('caption edit during OS protection requeues the authenticated media context without requiring repost', async t => {
  const protection = vault(); let release, count = 0;
  const safeStorage = { ...protection, encryptString: async text => ++count === 1 ? new Promise(resolve => { release = () => protection.encryptString(text).then(resolve); }) : protection.encryptString(text) };
  const f = await fixture(t, { safeStorage }), accepted = f.service.handlePublication(f.publication('EDIT_PROTECTION'));
  for (let attempts = 0; !release && attempts < 20; attempts++) await new Promise(resolve => setImmediate(resolve)); assert(release);
  f.clock.value += 1000; const editedCaption = `${CAPTION}\nLegenda revisada`;
  f.service.handleUpdate(f.publication('EDIT_PROTECTION', { revisionAt: f.clock.value, caption: editedCaption, text: editedCaption })); release(); await f.service.waitForIdle();
  const record = f.store.getSourcePublication(accepted.publication.id); assert.equal(record.status, 'ready'); assert.equal(record.caption, editedCaption); assert.equal(record.code, null); assert.equal(f.store.listCampaigns()[0].items.length, 1);
});

test('inconsistent portable day cannot target an ordinary active campaign and full restore rolls back atomically', async t => {
  const f = await fixture(t); f.service.handlePublication(f.publication('CONSISTENT')); await f.service.waitForIdle();
  const source = f.store.listCampaigns()[0], common = f.store.saveCampaign({ ...source, id: 'ordinary-active-test', name: 'Campanha comum preservada', state: 'active', sourceManaged: false, sourceGroupId: undefined, sourceDateKey: undefined, items: [{ id: 'ordinary-item', type: 'text', text: 'Conteúdo original' }] });
  const before = f.store.getSourceConfig(), data = f.store.exportData(); data.sources.days[0].campaignId = common.id;
  assert.throws(() => f.store.importData(data), /campanha incompatível/);
  assert.deepEqual(f.store.getSourceConfig(), before); assert.equal(f.store.getCampaign(common.id).state, 'active'); assert.equal(f.store.getCampaign(common.id).items[0].text, 'Conteúdo original');
  assert.equal(f.store.getSourceDay(GROUP, source.sourceDateKey).campaignId, source.id); assert.equal(f.store.listSourcePublications().total, 1); assert.equal(f.store.persistenceFailed, false);
});

test('runtime foreign daily link rejects capture instead of appending to a campaign already active', async t => {
  const f = await fixture(t), common = f.store.saveCampaign({ id: 'foreign-active', name: 'Campanha comum', state: 'active', items: [{ id: 'original-user-item', type: 'text', text: 'Não alterar' }], groupIds: [DESTINATION], ownerId: 'owner-test' });
  f.store.insertSourceDay({ groupId: GROUP, dateKey: localDay(f.clock.value), campaignId: common.id, createdAt: f.clock.value });
  assert.throws(() => f.service.handlePublication(f.publication('FOREIGN_LINK')), { code: 'SOURCE_DAY_CAMPAIGN_INVALID' });
  await f.service.waitForIdle(); assert.equal(f.store.listSourcePublications().total, 0); assert.equal(f.calls.length, 0); assert.equal(f.store.getCampaign(common.id).state, 'active'); assert.equal(f.store.getCampaign(common.id).items.length, 1); assert.equal(f.store.getCampaign(common.id).items[0].text, 'Não alterar');
});

test('portable deleted-campaign day remains an explicit tombstone and never silently recreates a daily campaign', async t => {
  const f = await fixture(t); const accepted = f.service.handlePublication(f.publication('BEFORE_DAY_DELETE')); await f.service.waitForIdle();
  const record = f.store.getSourcePublication(accepted.publication.id); f.store.deleteCampaign(record.campaignId);
  const portable = f.store.exportSourceData(); assert.equal(portable.days[0].campaignDeleted, true);
  const restored = f.store.importSourceData(portable); assert.equal(restored.enabled, false); assert.equal(f.store.getSourceDay(GROUP, record.dateKey).campaignId, record.campaignId);
  f.service.saveConfig({ enabled: true }, 'owner-test'); const received = f.service.handlePublication(f.publication('AFTER_DAY_DELETE')); await f.service.waitForIdle();
  assert.equal(received.publication.status, 'failed'); assert.equal(received.publication.code, 'SOURCE_CAMPAIGN_REMOVED'); assert.equal(f.store.listCampaigns().length, 0); assert.equal(f.calls.length, 1);
});

test('portable restoration never reuses local encrypted media credentials for a different image revision', async t => {
  const f = await fixture(t); const captured = f.service.handlePublication(f.publication('PORTABLE_IMAGE_CHANGE', { mediaFingerprint: 'a'.repeat(64) })); await f.service.waitForIdle();
  const old = f.store.getSourcePublication(captured.publication.id); assert(old.protectedContext);
  const portable = f.store.exportSourceData(), incoming = portable.publications[0]; incoming.revisionAt += 1000; incoming.mediaFingerprint = 'b'.repeat(64); incoming.mediaId = 'not-restored-image'; incoming.status = 'pending';
  f.store.importSourceData(portable); const restored = f.store.getSourcePublication(old.id); assert.equal(restored.protectedContext, null); assert.equal(restored.status, 'review'); assert.equal(restored.mediaFingerprint, 'b'.repeat(64));
  f.service.saveConfig({ enabled: true }, 'owner-test'); f.service.retryPublication(old.id); await f.service.waitForIdle();
  assert.equal(f.store.getSourcePublication(old.id).code, 'SOURCE_MEDIA_REPOST_REQUIRED'); assert.equal(f.calls.length, 1);
});

test('capture queue capacity is independent per integration mode and retains pending contexts when returning', async t => {
  const f = await fixture(t, { connected: false });
  for (let i = 0; i < 64; i++) assert(f.service.handlePublication(f.publication(`REAL_CAPACITY_${i}`)).accepted);
  assert.equal(f.service.queue.size, 64); assert.equal(f.store.listSourcePublications().total, 64);
  const full = f.service.handlePublication(f.publication('REAL_CAPACITY_OVERFLOW')); assert.equal(full.publication.code, 'SOURCE_CAPTURE_QUEUE_FULL');
  f.store.setSetting('integrationMode', 'simulated'); const simulatedGroup = 'mode-capacity@simulation';
  f.store.upsertGroups([{ id: simulatedGroup, name: 'SIMULAÇÃO — DADOS FICTÍCIOS', simulation: true, authorized: true }]);
  f.service.saveConfig({ enabled: true, groupId: simulatedGroup, allowedParticipantIds: [PHONE] }, 'owner-test');
  const first = f.service.handlePublication(f.publication('SIMULATED_FIRST', { chatId: simulatedGroup, mode: 'simulated', simulation: true, raw: { key: { id: 'SIMULATED_FIRST', remoteJid: simulatedGroup }, message: { imageMessage: { caption: CAPTION } } } }));
  assert.equal(first.publication.status, 'pending'); assert.equal(first.publication.code, null); assert.equal(f.service.queue.size, 65); assert.equal(f.store.listSourcePublications().total, 1);
  f.store.setSetting('integrationMode', 'whatsapp'); assert.equal(f.store.listSourcePublications().total, 65); assert.equal([...f.service.queue.values()].filter(entry => entry.mode === 'whatsapp').length, 64);
  assert.equal(f.store.getSourcePublication(simulatedGroup, 'SIMULATED_FIRST'), undefined); assert.equal(f.calls.length, 0);
});
