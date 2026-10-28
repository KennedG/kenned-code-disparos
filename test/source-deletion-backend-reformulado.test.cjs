'use strict';

// Backend RPC, production SQLite, and managed files with explicit licence,
// native-dialog, OS-protection, and simulated-transport fixtures. No Windows
// dialog or real WhatsApp account, group, or recipient is contacted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createAppService } = require('../src/backend/service.cjs');
const { createStore } = require('../src/core/store.cjs');
const { SimulatedAdapter } = require('../src/adapters/simulated.cjs');
const { createLicenseFixture } = require('./fixtures/license.cjs');

const GROUP = 'sim-01@simulation', DESTINATION = 'sim-02@simulation';
const GROUP_NAME = 'Origem controlada — nome cadastrado pelo adaptador';
const OWNER = { name: 'Dono controlado', username: 'source-delete-owner', password: 'Source-Delete-Backend-232!', phone: '5562999990001' };
const SUPPLIER = '5562999990002', INTERESTED = '5562999990003';
const CAPTION = '📱 iPhone 13 Pro 256GB Azul seminovo\n🔋 Bateria: 90%\nR$ 3.000,00\nDisponível\nDetalhe na tela pequeno';
const IMAGE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMesAAAAASUVORK5CYII=', 'base64');
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { const end = Date.now() + 5000; while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); } assert.fail('Controlled backend checkpoint was not reached'); }

async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-source-delete-backend-'));
  const clock = { now: Date.parse('2026-10-08T15:00:00Z') }, native = [], downloadCalls = [];
  const license = createLicenseFixture({ clock: () => clock.now }); let service, store, adapter, answer = options.answer ?? 1;
  const originalConnect = SimulatedAdapter.prototype.connect;
  SimulatedAdapter.prototype.connect = async function(...args) { adapter = this; return originalConnect.apply(this, args); };
  const safeStorage = { isEncryptionAvailable: async () => true, encryptString: async text => Buffer.from(text), decryptString: async bytes => Buffer.from(bytes).toString('utf8') };
  const host = async (action, payload) => { if (action === 'secretGet') return null; if (action === 'showMessageBox') { native.push(payload); return { response: answer }; } if (action === 'localAlert') return { nativeStatus: 'unsupported', soundStatus: 'disabled' }; return { canceled: true }; };
  const bindDownloads = () => { adapter.downloadIncoming = (context, config) => { downloadCalls.push({ messageId: context.messageId, signal: config.signal }); return options.download ? options.download(context, config) : Promise.resolve({ buffer: IMAGE, name: 'controlled.png', mime: 'image/png' }); }; };
  const open = async () => { service = await createAppService({ dir, version: '2.3.2', runtimePlatform: 'linux', now: () => clock.now, licenseService: license, safeStorage, host }); store = await createStore(dir); bindDownloads(); };
  const close = async () => { store?.close(); store = null; if (service) await service.shutdown(); service = null; };
  await open(); await service.call('setupOwner', OWNER); const owner = service.snapshot().auth.user;
  await service.call('authorizeGroup', { id: DESTINATION, authorized: true }); store.upsertGroups([{ ...store.getGroup(GROUP), name: GROUP_NAME, simulation: true }]);
  await service.call('sourceConfigSave', { config: { enabled: true, groupId: GROUP, allowedParticipantIds: [SUPPLIER], mediaTimeoutSeconds: 30 } });
  const inject = (id, patch = {}) => { adapter.injectPublication({ messageId: id, chatId: GROUP, senderNumber: SUPPLIER, verified: true, identityVerified: true, type: 'image', text: CAPTION, timestamp: clock.now, raw: { key: { id, remoteJid: GROUP }, message: { imageMessage: { caption: CAPTION } } }, ...patch }); return store.getSourcePublication(GROUP, id); };
  const ready = async id => { const record = inject(id); assert.ok(record?.campaignId); await until(() => store.getSourcePublication(record.id)?.status === 'ready'); return store.getSourcePublication(record.id); };
  const queuedJob = (campaignId, itemId, id = randomUUID()) => store.insertJob({ id, campaignId, roundId: `round-${id}`, itemId, groupId: DESTINATION, status: 'queued', attempts: 0, createdAt: clock.now, itemSnapshot: { id: itemId, type: 'text', text: 'Tarefa controlada' } });
  const reopen = async () => { await close(); await open(); await service.call('login', { username: OWNER.username, password: OWNER.password }); };
  t.after(async () => { await close(); SimulatedAdapter.prototype.connect = originalConnect; fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, clock, owner, native, downloadCalls, inject, ready, queuedJob, reopen, setAnswer: value => { answer = value; }, get service() { return service; }, get store() { return store; }, get adapter() { return adapter; } };
}

test('backend deletion confirms the current group name, pauses its binding, cancels jobs and opportunity tasks, and invalidates public TV references', async t => {
  const f = await fixture(t), publication = await f.ready('CURRENT-READY'); let campaign = f.store.getCampaign(publication.campaignId);
  campaign = await f.service.call('saveCampaign', { campaign: { ...campaign, items: campaign.items.map(item => ({ ...item, unitReference: 'controlled-physical-unit', availability: { available: true, confirmedAt: f.clock.now, quantity: 1 } })) } });
  const tvItem = { id: 'controlled-tv-item', campaignId: campaign.id, itemId: campaign.items[0].id, model: 'iPhone 13 Pro', storage: '256GB', color: 'Azul', retailPriceCents: 300000, wholesalePriceCents: null, audience: 'retail', expiresAt: f.clock.now + 3600000, publicDescription: 'Bateria: 90%' };
  await f.service.call('vitrineSave', { config: { brandName: 'Loja controlada', audience: 'retail' }, items: [tvItem] }); const preview = await f.service.call('vitrinePreview', {}); await f.service.call('vitrinePublish', { previewToken: preview.previewToken, confirm: true }); assert.equal((await f.service.call('vitrinePublic')).items.length, 1);
  await f.service.call('opportunityConfigSave', { config: { enabled: true, mode: 'evaluation', campaignIds: [campaign.id], monitoredGroupIds: [DESTINATION], sound: { enabled: false } } });
  f.adapter.injectOpportunityMessage({ messageId: 'CONTROLLED-REQUEST', chatId: DESTINATION, senderNumber: INTERESTED, senderId: `${INTERESTED}@s.whatsapp.net`, senderIds: [`${INTERESTED}@s.whatsapp.net`], identityVerified: true, verified: true, text: 'Quem tem iPhone 13 Pro 256GB?', type: 'text', timestamp: f.clock.now });
  const opportunity = f.store.listOpportunities().items[0]; assert.ok(opportunity); const candidate = (await f.service.call('opportunityDetail', { id: opportunity.id })).candidates[0]; assert.ok(candidate?.compatible);
  await f.service.call('disconnect'); const reservation = f.store.reserveOpportunitySend({ opportunityId: opportunity.id, offerIds: [candidate.id], recipient: opportunity.recipient, automatic: false, reviewed: true, actorId: f.owner.id, clientId: 'DELETE-OP-CONTROLLED', now: f.clock.now }); assert.equal(reservation.ok, true);
  const job = f.queuedJob(campaign.id, campaign.items[0].id), pending = f.inject('CURRENT-PENDING'); assert.equal(pending.status, 'pending'); const beforeMessages = f.native.length;
  const result = await f.service.call('deleteCampaign', { id: campaign.id }); assert.equal(result, true); assert.equal(f.native.length, beforeMessages + 1); assert.equal(f.native.at(-1).message, `Esta campanha recebe publicações automaticamente do grupo ${GROUP_NAME}. Ao excluir, a importação desse grupo será pausada até você vincular ou criar outra campanha.`);
  const link = f.store.getSourceLink(GROUP); assert.equal(link.status, 'paused'); assert.equal(link.campaignId, null); assert.equal(link.previousCampaignId, campaign.id); assert.equal(f.store.getCampaign(campaign.id), undefined); assert.equal(f.store.getJob(job.id).status, 'cancelled'); assert.equal(f.store.getOpportunityTask(reservation.task.id).status, 'cancelled'); assert.equal(f.store.getOpportunityTask(reservation.task.id).code, 'OP_CAMPAIGN_REMOVED');
  assert.equal(f.store.getSourcePublication(publication.id).status, 'removed'); assert.equal(f.store.getSourcePublication(pending.id).status, 'removed'); assert.equal((await f.service.call('vitrineState')).items.length, 0); assert.equal((await f.service.call('vitrinePublic')).mode, 'neutral'); assert.equal(f.adapter.sourceCapture.enabled, false);
  for (let index = 0; index < 3; index++) { await f.service.call('sourceConfigGet'); await f.service.call('sourcePublications', { limit: 50 }); }
  assert.equal(f.native.length, beforeMessages + 1); assert.equal(f.adapter.sent.length, 0); await f.reopen(); assert.equal((await f.service.call('sourceConfigGet')).config.capturePaused, true); f.inject('AFTER-DELETE-REOPEN'); await tick(); assert.equal(f.store.getSourcePublication(GROUP, 'AFTER-DELETE-REOPEN'), undefined); assert.equal(f.store.getCampaign(campaign.id), undefined);
});

test('backend deletion aborts a source download and late image bytes cannot recreate the campaign', async t => {
  const pending = deferred(), f = await fixture(t, { download: () => pending.promise }), record = f.inject('DELETING-IN-DOWNLOAD'); await until(() => f.downloadCalls.length === 1); const signal = f.downloadCalls[0].signal;
  assert.equal(await f.service.call('deleteCampaign', { id: record.campaignId }), true); await until(() => signal.aborted); assert.equal(f.store.getSourcePublication(record.id).status, 'removed'); assert.equal(f.store.getSourcePublication(record.id).protectedContext, null); assert.equal(f.store.listMedia().length, 0);
  pending.resolve({ buffer: IMAGE, name: 'late.png', mime: 'image/png' }); await tick(); await tick(); assert.equal(f.store.getCampaign(record.campaignId), undefined); assert.equal(f.store.listMedia().length, 0); assert.equal(f.native.length, 1); assert.equal(f.adapter.sourceCapture.enabled, false);
});

test('backend deletion of a historical campaign preserves the current origin, its queued jobs and pending capture', async t => {
  const oldDownload = deferred(), f = await fixture(t, { download: context => context.messageId === 'HISTORICAL-DOWNLOAD' ? oldDownload.promise : Promise.resolve({ buffer: IMAGE, name: 'current.png', mime: 'image/png' }) });
  const old = await f.ready('HISTORICAL-READY'); f.inject('HISTORICAL-DOWNLOAD'); await until(() => f.downloadCalls.some(call => call.messageId === 'HISTORICAL-DOWNLOAD')); const oldSignal = f.downloadCalls.find(call => call.messageId === 'HISTORICAL-DOWNLOAD').signal;
  f.clock.now += 86400000; const current = f.inject('NEW-DAY-PENDING'), currentCampaign = f.store.getCampaign(current.campaignId), currentJob = f.queuedJob(current.campaignId, 'current-queued-item'), expectedLink = f.store.getSourceLink(GROUP);
  assert.notEqual(current.campaignId, old.campaignId); assert.equal(await f.service.call('deleteCampaign', { id: old.campaignId }), true); assert.equal(f.native.length, 0); assert.deepEqual(f.store.getSourceLink(GROUP), expectedLink); assert.equal(f.store.getJob(currentJob.id).status, 'queued'); assert.equal(f.store.getCampaign(currentCampaign.id).name, currentCampaign.name); assert.equal(f.adapter.sourceCapture.enabled, true); await until(() => oldSignal.aborted); await until(() => f.store.getSourcePublication(current.id).status === 'ready');
  oldDownload.resolve({ buffer: IMAGE, name: 'late-old.png', mime: 'image/png' }); await tick(); assert.equal(f.store.getCampaign(old.campaignId), undefined); assert.equal(f.store.getSourceLink(GROUP).campaignId, current.campaignId); assert.equal(f.store.getSourcePublication(GROUP, 'HISTORICAL-DOWNLOAD').status, 'removed'); assert.equal(f.downloadCalls.filter(call => call.messageId === 'NEW-DAY-PENDING').length, 1);
});

test('cancelling the native deletion confirmation preserves the campaign, binding, publications and queued jobs', async t => {
  const f = await fixture(t, { answer: 0 }), publication = await f.ready('CANCEL-DELETE'), campaign = f.store.getCampaign(publication.campaignId), expectedLink = f.store.getSourceLink(GROUP), job = f.queuedJob(campaign.id, campaign.items[0].id);
  assert.deepEqual(await f.service.call('deleteCampaign', { id: campaign.id }), { cancelled: true }); assert.deepEqual(f.store.getCampaign(campaign.id), campaign); assert.deepEqual(f.store.getSourceLink(GROUP), expectedLink); assert.equal(f.store.getSourcePublication(publication.id).status, 'ready'); assert.equal(f.store.getJob(job.id).status, 'queued'); assert.equal(f.adapter.sourceCapture.enabled, true); assert.equal(f.native.length, 1);
});

test('backend resume links an inactive ordinary campaign while preserving its items and settings and capturing only after the new timestamp', async t => {
  const f = await fixture(t), original = await f.ready('BEFORE-RESUME'); await f.service.call('deleteCampaign', { id: original.campaignId });
  const seed = f.service.snapshot().campaigns.find(campaign => !campaign.sourceManaged); assert.ok(seed);
  const target = await f.service.call('saveCampaign', { campaign: { ...seed, id: randomUUID(), name: 'Configuração própria preservada', ownerId: f.owner.id, state: 'draft', groupIds: [DESTINATION], intervalMinutes: 17, spacingSeconds: 13, messageSpacingSeconds: 7, maxRounds: 4, items: [{ id: 'ordinary-original-text', type: 'text', text: '*Texto original* 📱\nSem alteração' }] } });
  f.clock.now += 60000; const resumed = await f.service.call('sourceResumeGroup', { groupId: GROUP, campaignId: target.id, confirm: true }); assert.equal(resumed.campaign.id, target.id); assert.deepEqual(resumed.campaign.items, target.items); for (const field of ['name', 'groupIds', 'intervalMinutes', 'spacingSeconds', 'messageSpacingSeconds', 'maxRounds', 'schedule']) assert.deepEqual(resumed.campaign[field], target[field]); assert.equal(resumed.captureFrom, f.clock.now); assert.equal(resumed.campaign.state, 'draft'); assert.equal(resumed.campaign.nextRunAt, null);
  assert.equal((await f.service.call('sourceConfigGet')).config.capturePaused, false); f.inject('MISSED-DURING-PAUSE', { timestamp: resumed.captureFrom - 1 }); assert.equal(f.store.getSourcePublication(GROUP, 'MISSED-DURING-PAUSE'), undefined); f.clock.now += 1; const fresh = await f.ready('AFTER-RESUME'); assert.equal(fresh.campaignId, target.id); const saved = f.store.getCampaign(target.id); assert.equal(saved.items.length, 2); assert.deepEqual(saved.items[0], target.items[0]); assert.equal(f.store.getSourcePublication(original.id).status, 'removed'); assert.equal(f.store.getCampaign(original.campaignId), undefined);
});

test('SQLite failure during backend deletion rolls back the binding and publication tombstones with the campaign row', async t => {
  const f = await fixture(t), publication = await f.ready('ROLLBACK-DELETE'), campaign = f.store.getCampaign(publication.campaignId), expectedLink = f.store.getSourceLink(GROUP), expectedPublication = f.store.getSourcePublication(publication.id);
  const database = new DatabaseSync(f.store.filename); const trigger = database.prepare('SELECT quote(?) quoted').get(campaign.id).quoted; database.exec(`CREATE TRIGGER controlled_campaign_delete_failure BEFORE DELETE ON campaigns WHEN OLD.id=${trigger} BEGIN SELECT RAISE(ABORT,'CONTROLLED_CAMPAIGN_DELETE_FAILURE'); END;`);
  try { await assert.rejects(f.service.call('deleteCampaign', { id: campaign.id }), /CONTROLLED_CAMPAIGN_DELETE_FAILURE/); assert.ok(f.store.getCampaign(campaign.id)); assert.deepEqual(f.store.getSourceLink(GROUP), expectedLink); assert.deepEqual(f.store.getSourcePublication(publication.id), expectedPublication); assert.equal(f.store.getSourceDay(GROUP, campaign.sourceDateKey).campaignDeleted, undefined); assert.equal(f.adapter.sourceCapture.enabled, true); }
  finally { database.exec('DROP TRIGGER controlled_campaign_delete_failure'); database.close(); }
});
