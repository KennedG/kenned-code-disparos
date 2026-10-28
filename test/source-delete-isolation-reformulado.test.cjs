'use strict';

// Production SQLite ledgers with controlled origin data. No real WhatsApp
// account, source group, download, or outgoing message is used here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../src/core/store.cjs');

const GROUP = '120363111111111111@g.us';
const OTHER_GROUP = '120363222222222222@g.us';
const NOW = Date.parse('2026-10-09T16:00:00Z');

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-source-isolation-'));
  const stores = [];
  const open = async () => { const store = await createStore(dir); stores.push(store); return store; };
  const store = await open(); store.setSetting('integrationMode', 'whatsapp');
  store.upsertGroups([{ id: GROUP, name: 'Origem controlada', simulation: false, authorized: true }, { id: OTHER_GROUP, name: 'Outra origem controlada', simulation: false, authorized: true }]);
  t.after(() => { for (const instance of stores) instance.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const campaign = (id, date, groupId = GROUP) => {
    const createdAt = Date.parse(`${date}T15:00:00Z`);
    const value = store.saveCampaign({ id, name: id, state: 'draft', groupIds: [], items: [], sourceManaged: true, sourceGroupId: groupId, sourceDateKey: date, sourceTimezone: 'America/Sao_Paulo' });
    store.insertSourceDay({ groupId, dateKey: date, campaignId: id, createdAt }); return value;
  };
  const publication = (id, campaignId, status = 'pending', groupId = GROUP) => store.insertSourcePublication({ id, groupId, messageId: id, campaignId, dateKey: campaignId === 'previous-day' ? '2026-10-08' : '2026-10-09', originalAt: NOW - 1000, capturedAt: NOW - 1000, revisionAt: NOW - 1000, status, caption: 'Texto original preservado 📱', protectedContext: 'controlled-test-context' }).publication;
  const link = (campaignId, groupId = GROUP) => store.setSourceLink({ groupId, status: 'active', campaignId, generation: 4, captureFrom: NOW - 60000, createdAt: NOW - 60000 });
  const remove = campaignId => store.transaction(() => { const result = store.pauseSourceForCampaign(campaignId, { at: NOW, actorId: 'owner-test' }); store.deleteCampaign(campaignId); return result; });
  return { dir, store, open, campaign, publication, link, remove };
}

test('deleting a historical daily campaign preserves the newer binding and all its capture states', async t => {
  const f = await fixture(t); f.campaign('previous-day', '2026-10-08'); f.campaign('current-day', '2026-10-09');
  const expectedLink = f.link('current-day'), expectedCampaign = f.store.getCampaign('current-day');
  const oldReady = f.publication('old-ready', 'previous-day', 'ready'), oldPending = f.publication('old-pending', 'previous-day');
  const current = ['pending', 'downloading', 'ready', 'review'].map(status => f.publication(`current-${status}`, 'current-day', status));
  const unassigned = f.publication('new-unassigned', null);
  assert.deepEqual(f.store.getSourceGroupsLinkedToCampaign('previous-day'), []);
  assert.deepEqual(f.store.getSourceGroupsLinkedToCampaign('current-day'), [GROUP]);
  const result = f.remove('previous-day'); assert.deepEqual(result.groupIds, []); assert.equal(result.pausedGroups, 0); assert.equal(result.cancelledPublications, 2);
  assert.deepEqual(f.store.getSourceLink(GROUP), expectedLink); assert.deepEqual(f.store.getCampaign('current-day'), expectedCampaign);
  for (const original of [...current, unassigned]) assert.deepEqual(f.store.getSourcePublication(original.id), original);
  for (const original of [oldReady, oldPending]) { const removed = f.store.getSourcePublication(original.id); assert.equal(removed.status, 'removed'); assert.equal(removed.protectedContext, null); assert.equal(removed.code, 'SOURCE_CAMPAIGN_REMOVED'); }
  assert.equal(f.store.getSourceDay(GROUP, '2026-10-08').campaignDeleted, true); assert.equal(f.store.getSourceDay(GROUP, '2026-10-09').campaignDeleted, undefined);
  f.store.close(); const reopened = await f.open(); assert.deepEqual(reopened.getSourceLink(GROUP), expectedLink); assert.equal(reopened.getSourcePublication('current-downloading').status, 'downloading'); assert.equal(reopened.getCampaign('previous-day'), undefined);
});

test('deleting an older legacy daily record without a persistent link does not pause the latest campaign', async t => {
  const f = await fixture(t); f.campaign('previous-day', '2026-10-08'); f.campaign('current-day', '2026-10-09');
  const next = f.publication('legacy-new-pending', 'current-day'); f.publication('legacy-old-pending', 'previous-day');
  assert.equal(f.store.getSourceLink(GROUP), undefined); assert.deepEqual(f.store.getSourceGroupsLinkedToCampaign('previous-day'), []);
  const result = f.remove('previous-day'); assert.deepEqual(result.groupIds, []); assert.equal(f.store.getSourceLink(GROUP), undefined); assert.deepEqual(f.store.getSourcePublication(next.id), next);
  assert.equal(f.store.getSourcePublication('legacy-old-pending').status, 'removed'); assert.equal(f.store.getSourceDay(GROUP, '2026-10-08').campaignDeleted, true);
});

test('deleting the latest legacy binding creates the durable paused link needed to prevent automatic recreation', async t => {
  const f = await fixture(t); f.campaign('previous-day', '2026-10-08'); f.campaign('current-day', '2026-10-09'); f.publication('legacy-current-pending', 'current-day');
  assert.deepEqual(f.store.getSourceGroupsLinkedToCampaign('current-day'), [GROUP]); const result = f.remove('current-day');
  assert.deepEqual(result.groupIds, [GROUP]); assert.equal(result.pausedGroups, 1); assert.equal(f.store.getSourceLink(GROUP).status, 'paused'); assert.equal(f.store.getSourceLink(GROUP).campaignId, null); assert.equal(f.store.getSourceLink(GROUP).previousCampaignId, 'current-day'); assert.equal(f.store.getSourcePublication('legacy-current-pending').status, 'removed'); assert.ok(f.store.getCampaign('previous-day'));
});

test('the persisted explicit binding takes precedence over another daily record when deciding which origin to pause', async t => {
  const f = await fixture(t); f.campaign('previous-day', '2026-10-08'); f.campaign('current-day', '2026-10-09'); f.link('previous-day');
  assert.deepEqual(f.store.getSourceGroupsLinkedToCampaign('previous-day'), [GROUP]); const result = f.remove('previous-day');
  assert.deepEqual(result.groupIds, [GROUP]); assert.equal(f.store.getSourceLink(GROUP).status, 'paused'); assert.equal(f.store.getSourceLink(GROUP).previousCampaignId, 'previous-day'); assert.ok(f.store.getCampaign('current-day'));
});

test('deleting the actual current campaign leaves other source groups and their pending downloads unchanged', async t => {
  const f = await fixture(t); f.campaign('current-day', '2026-10-09'); f.campaign('other-current', '2026-10-09', OTHER_GROUP); f.link('current-day'); const otherLink = f.link('other-current', OTHER_GROUP);
  f.publication('current-download', 'current-day', 'downloading'); const otherDownload = f.publication('other-download', 'other-current', 'downloading', OTHER_GROUP);
  const result = f.remove('current-day'); assert.deepEqual(result.groupIds, [GROUP]); assert.deepEqual(f.store.getSourceLink(OTHER_GROUP), otherLink); assert.deepEqual(f.store.getSourcePublication(otherDownload.id), otherDownload); assert.ok(f.store.getCampaign('other-current')); assert.equal(f.store.getSourcePublication('current-download').status, 'removed');
});

test('historical ledger removal is idempotent and processes more than one database batch without touching new captures', async t => {
  const f = await fixture(t); f.campaign('previous-day', '2026-10-08'); f.campaign('current-day', '2026-10-09'); const nextLink = f.link('current-day'); const next = f.publication('batch-new-pending', 'current-day');
  for (let index = 0; index < 405; index++) f.publication(`historical-${index}`, 'previous-day', index % 2 ? 'ready' : 'pending');
  const first = f.remove('previous-day'); assert.equal(first.cancelledPublications, 405); assert.deepEqual(first.groupIds, []); assert.equal(f.store.listSourcePublications({ campaignId: 'previous-day', status: 'removed' }).total, 405);
  const repeated = f.store.pauseSourceForCampaign('previous-day', { at: NOW + 1000 }); assert.equal(repeated.cancelledPublications, 0); assert.deepEqual(repeated.groupIds, []); assert.deepEqual(f.store.getSourceLink(GROUP), nextLink); assert.deepEqual(f.store.getSourcePublication(next.id), next);
});

test('a failed delete rolls back historical tombstones and the current link consistently', async t => {
  const f = await fixture(t); f.campaign('previous-day', '2026-10-08'); f.campaign('current-day', '2026-10-09'); const nextLink = f.link('current-day'), old = f.publication('rollback-old', 'previous-day');
  assert.throws(() => f.store.transaction(() => { f.store.pauseSourceForCampaign('previous-day', { at: NOW }); f.store.deleteCampaign('previous-day'); throw new Error('CONTROLLED_DELETE_FAILURE'); }), /CONTROLLED_DELETE_FAILURE/);
  assert.deepEqual(f.store.getSourceLink(GROUP), nextLink); assert.deepEqual(f.store.getSourcePublication(old.id), old); assert.ok(f.store.getCampaign('previous-day')); assert.equal(f.store.getSourceDay(GROUP, '2026-10-08').campaignDeleted, undefined);
});
