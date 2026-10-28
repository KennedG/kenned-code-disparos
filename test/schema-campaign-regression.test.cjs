'use strict';

// Real persistent store and permissions; the transport and license are isolated
// fixtures. These tests do not establish receipt by a real WhatsApp account.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createStore } = require('../src/core/store.cjs');
const { AuthService } = require('../src/core/auth.cjs');
const { Scheduler } = require('../src/core/scheduler.cjs');
const validation = require('../src/core/validation.cjs');
const { TemplateService } = require('../src/core/template-service.cjs');
const { campaignVersionFeatures, assertCampaignSchemaCompatible } = require('../src/core/campaign-schema-compat.cjs');
const { createLicenseFixture } = require('./fixtures/license.cjs');

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-schema-campaign-233-'));
  const store = await createStore(dir);
  store.setSetting('integrationMode', 'simulated');
  store.setSetting('initialized', true);
  const now = () => new Date(2026, 9, 7, 10).getTime();
  const auth = new AuthService({ store, clock: now });
  const owner = (await auth.setupOwner({ name: 'Dono do teste', username: 'schema-owner', password: 'SenhaSegura-233', phone: '5562999990101' })).user;
  const adapter = new EventEmitter();
  adapter.status = { state: 'connected', mode: 'simulated' };
  adapter.minimumSpacingSeconds = 3;
  const submitted = [];
  adapter.send = async (groupId, item, media, options) => {
    options.beforeSubmit();
    submitted.push({ groupId, item, media });
    return { status: 'confirmed', messageId: item.clientMessageId };
  };
  const license = createLicenseFixture({ clock: now });
  store.upsertGroups([{ id: 'schema-test@simulation', name: 'Simulação isolada', authorized: true, simulation: true }]);
  const scheduler = new Scheduler({ store, adapter, now, licenseGuard: () => license.assertAllowed('campaign') });
  const campaign = store.saveCampaign({
    id: 'schema-campaign', name: 'Campanha preservada', ownerId: owner.id,
    state: 'draft', mode: 'repeat', groupIds: ['schema-test@simulation'],
    intervalMinutes: 10, spacingSeconds: 3, dailyRoundLimit: 0, dailySendLimit: 0,
    schedule: { days: [0, 1, 2, 3, 4, 5, 6], startTime: '00:00', endTime: '00:00' },
    items: [{ id: 'item', type: 'text', text: 'Estoque disponível. Valor: R$ 3.850,00. Venda sob encomenda.' }],
    groupOverrides: {}, nextRunAt: null, roundIndex: 0
  });
  t.after(async () => { await scheduler.shutdown(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, auth, owner, scheduler, adapter, submitted, campaign, now };
}

test('commercial compatibility guard inspects structured fields only and accepts ordinary text, names and empty links', () => {
  const plain = { name: 'Estoque e vendas', items: [{ type: 'text', text: 'inventoryIds:123 — estoque, venda e custos' }], commercialListId: '', inventoryIds: [], inventoryRefs: {}, contactIds: [], promotionPolicy: {}, audience: 'general', oneShot: false };
  assert.deepEqual(campaignVersionFeatures(plain), []);
  assert.doesNotThrow(() => assertCampaignSchemaCompatible(plain));
  for (const [field, value] of Object.entries({ commercialListId: 'list', commercialRef: { lines: [] }, inventoryId: 'stock', inventoryIds: ['stock'], inventoryRefs: [{ id: 'stock' }], stockId: 'stock', stockIds: ['stock'], stockRefs: ['stock'], contactIds: ['buyer'], promotionPolicy: { repeatLimit: 1 }, audience: 'retail', oneShot: true })) {
    assert.throws(() => assertCampaignSchemaCompatible({ ...plain, [field]: value }), error => error.code === 'CAMPAIGN_VERSION_REVIEW' && error.submitted === false && error.safeToRetry === false && error.fields.includes('campaign.' + field));
  }
  assert.throws(() => assertCampaignSchemaCompatible({ items: [], groupOverrides: { group: { items: [{ commercialRef: { listId: 'list' } }] } } }), error => error.fields.includes('groupItem.commercialRef'));
  assert.throws(() => assertCampaignSchemaCompatible(plain, { stockId: 'stock' }), error => error.fields.includes('queuedItem.stockId'));
});

test('authorized activation refuses commercial references and preserves the original without creating jobs', async t => {
  const f = await fixture(t);
  f.store.saveCampaign({ ...f.campaign, commercialListId: 'retained-commercial-list', inventoryIds: ['retained-stock'], items: [{ ...f.campaign.items[0], commercialRef: { listId: 'retained-commercial-list', lines: [{ sourceType: 'inventory', sourceId: 'retained-stock' }] } }] });
  const original = f.store.getCampaign(f.campaign.id);
  f.auth.assertFor(f.owner, 'campaign.start', original);
  await assert.rejects(f.scheduler.activate(original.id), error => error.code === 'CAMPAIGN_VERSION_REVIEW');
  assert.deepEqual(f.store.getCampaign(original.id), original);
  assert.equal(f.store.listJobs().length, 0);
  assert.equal(f.submitted.length, 0);
});

test('an ordinary authorized campaign with commercial words sends through the final guard', async t => {
  const f = await fixture(t);
  f.auth.assertFor(f.owner, 'campaign.start', f.campaign);
  await f.scheduler.activate(f.campaign.id);
  await f.scheduler.tick();
  assert.equal(f.submitted.length, 1);
  assert.equal(f.store.listJobs()[0].status, 'accepted');
});

test('a queued snapshot with an unsupported reference is cancelled without a retry or network submission', async t => {
  const f = await fixture(t);
  await f.scheduler.activate(f.campaign.id);
  f.store.insertRound({ id: 'legacy-round', campaignId: f.campaign.id, status: 'running', startedAt: f.now() });
  const snapshot = { ...f.campaign.items[0], commercialRef: { listId: 'retained-list', lines: [{ sourceType: 'inventory', sourceId: 'retained-stock' }] } };
  const job = { id: 'legacy-job', roundId: 'legacy-round', campaignId: f.campaign.id, groupId: f.campaign.groupIds[0], itemId: snapshot.id, itemSnapshot: snapshot, status: 'queued', createdAt: f.now(), attempts: 0, messageId: 'UNSUBMITTED_LEGACY' };
  f.store.insertJob(job);
  assert.equal(await f.scheduler._sendJob(job, new AbortController().signal), 'cancelled');
  const saved = f.store.getJob(job.id);
  assert.equal(saved.errorCode, 'CAMPAIGN_VERSION_REVIEW');
  assert.equal(saved.status, 'cancelled');
  assert.equal(saved.attempts, 0);
  assert.deepEqual(saved.itemSnapshot, snapshot);
  assert.equal(f.store.getCampaign(f.campaign.id).state, 'paused');
  assert.equal(f.submitted.length, 0);
  assert.equal(f.store.listEntities('diagnostics', { code: 'CAMPAIGN_VERSION_REVIEW' }).length, 1);
});

test('adding a structured reference during transport preparation is caught immediately before submission', async t => {
  const f = await fixture(t);
  let started, release;
  const entered = new Promise(resolve => { started = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  f.adapter.send = async (groupId, item, media, options) => {
    started(); await waiting;
    options.beforeSubmit();
    f.submitted.push({ groupId, item, media });
    return { status: 'confirmed', messageId: item.clientMessageId };
  };
  await f.scheduler.activate(f.campaign.id);
  const running = f.scheduler.tick();
  await entered;
  const original = f.store.getCampaign(f.campaign.id);
  f.store.saveCampaign({ ...original, inventoryIds: ['retained-stock'] });
  release(); await running;
  const saved = f.store.listJobs()[0];
  assert.equal(saved.status, 'cancelled');
  assert.equal(saved.errorCode, 'CAMPAIGN_VERSION_REVIEW');
  assert.equal(saved.attempts, 1);
  assert.equal(f.submitted.length, 0);
  assert.deepEqual(f.store.getCampaign(f.campaign.id).inventoryIds, ['retained-stock']);
  assert.equal(f.store.getCampaign(f.campaign.id).state, 'paused');
  assert.equal(f.store.persistenceFailed, false);
  assert.equal(f.scheduler.persistenceFailed, false);
});

test('validation refuses to strip inherited or new commercial metadata while preserving ordinary content', async t => {
  const f = await fixture(t);
  const legacy = f.store.saveCampaign({ ...f.campaign, commercialListId: 'retained-list' });
  const original = f.store.getCampaign(legacy.id);
  const sanitizedInput = { ...f.campaign, name: 'Tentativa de editar sem referências' };
  assert.throws(() => validation.campaign(sanitizedInput, f.store), error => error.code === 'CAMPAIGN_VERSION_REVIEW');
  assert.deepEqual(f.store.getCampaign(legacy.id), original);
  assert.throws(() => validation.campaign({ ...f.campaign, id: undefined, inventoryIds: ['stock'] }, f.store), error => error.code === 'CAMPAIGN_VERSION_REVIEW');
  assert.throws(() => validation.items([{ ...f.campaign.items[0], commercialRef: { listId: 'retained-list' } }], f.store), error => error.code === 'CAMPAIGN_VERSION_REVIEW');
  assert.equal(validation.items([{ ...f.campaign.items[0], inventoryIds: [], commercialRef: {} }], f.store)[0].text, f.campaign.items[0].text);
});

test('legacy models remain readable, exportable and deletable but edit, duplicate and apply cannot shed references', async t => {
  const f = await fixture(t);
  const templates = new TemplateService({ store: f.store, auth: f.auth, now: f.now, media: { getPath: () => { throw new Error('No media needed'); } } });
  f.store.saveTemplate({ id: 'legacy-model', name: 'Modelo preservado', inventoryIds: ['retained-stock'], items: [{ ...f.campaign.items[0], commercialRef: { listId: 'retained-list' } }] });
  const original = f.store.getTemplate('legacy-model');
  assert.deepEqual(templates.get('legacy-model', f.owner.id), original);
  assert.deepEqual(f.store.exportData().templates.find(model => model.id === original.id), original);
  for (const action of [
    () => templates.save({ id: original.id, name: 'Editar sem vínculo', items: f.campaign.items }, f.owner.id),
    () => templates.duplicate(original.id, f.owner.id),
    () => templates.apply(original.id, f.owner.id),
    () => templates.save({ name: 'Novo com vínculo', inventoryIds: ['stock'], items: f.campaign.items }, f.owner.id)
  ]) assert.throws(action, error => error.code === 'CAMPAIGN_VERSION_REVIEW');
  assert.deepEqual(f.store.getTemplate(original.id), original);
  assert.equal(f.store.listTemplates().length, 1);
  assert.deepEqual(templates.delete(original.id, f.owner.id), { deleted: true, id: original.id });
  assert.equal(f.store.getTemplate(original.id), undefined);
  const ordinary = templates.save({ name: 'Estoque, venda e custos são texto', inventoryIds: [], items: f.campaign.items }, f.owner.id);
  assert.equal(templates.apply(ordinary.id, f.owner.id).items[0].text, f.campaign.items[0].text);
  assert.equal(templates.duplicate(ordinary.id, f.owner.id).items[0].text, f.campaign.items[0].text);
});
