'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createStore } = require('../src/core/store.cjs');
const validation = require('../src/core/validation.cjs');

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcd-source-validation-'));
  const store = await createStore(dir);
  store.setSetting('integrationMode', 'whatsapp');
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store };
}

test('SQLite daily counters use Brasília midnight bounds and first attempt, and query campaign indexes', async t => {
  const { dir, store } = await fixture(t);
  const at = Date.parse('2026-10-08T01:00:00Z'); // Still 07/10, 22:00 in Brasília.
  const start = Date.parse('2026-10-07T03:00:00Z'), end = Date.parse('2026-10-08T03:00:00Z');
  const add = (id, instant, job = {}) => {
    store.insertRound({ id, campaignId: 'daily', startedAt: instant, finishedAt: instant, status: 'completed' });
    store.insertJob({ id: `job-${id}`, roundId: id, campaignId: 'daily', groupId: 'test@g.us', itemId: id,
      createdAt: instant, firstAttemptAt: instant, attempts: 1, status: 'accepted', ...job });
  };
  add('before', start - 1);
  add('inclusive-start', start);
  add('noon', start + 12 * 3600000, { firstAttemptAt: start - 1 });
  add('inclusive-last-millisecond', end - 1, { createdAt: start - 86400000 });
  add('exclusive-end', end, { attempts: 0, firstAttemptAt: null, status: 'queued' });
  store.insertJob({ id: 'fallback-createdAt', roundId: 'inclusive-start', campaignId: 'daily', groupId: 'test@g.us', itemId: 'fallback', createdAt: start, firstAttemptAt: null, attempts: 1, status: 'accepted' });
  store.insertJob({ id: 'later-first-attempt', roundId: 'inclusive-start', campaignId: 'daily', groupId: 'test@g.us', itemId: 'later', createdAt: start, firstAttemptAt: end, attempts: 1, status: 'accepted' });
  store.setSetting('integrationMode', 'simulated'); add('other-mode', start + 3600000);
  store.setSetting('integrationMode', 'whatsapp');
  assert.deepEqual(store.getCampaignCounts('daily', at, { timezone: 'America/Sao_Paulo' }), { rounds: 3, sends: 3 });
  assert.deepEqual(store.getCampaignCounts('daily', end, { timezone: 'America/Sao_Paulo' }), { rounds: 1, sends: 1 });
  const db = new DatabaseSync(path.join(dir, 'mega.sqlite'), { readOnly: true });
  try {
    const roundPlan = db.prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM rounds WHERE campaignId=? AND storageMode=? AND startedAt>=? AND startedAt<?').all('daily', 'whatsapp', start, end);
    const jobPlan = db.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM jobs WHERE campaignId=? AND storageMode=? AND attempts>0 AND COALESCE(json_extract(data,'$.firstAttemptAt'),createdAt)>=? AND COALESCE(json_extract(data,'$.firstAttemptAt'),createdAt)<?").all('daily', 'whatsapp', start, end);
    assert.ok(roundPlan.some(row => /SEARCH rounds USING (?:COVERING )?INDEX/i.test(row.detail)), 'Rounds are selected through an existing campaign index.');
    assert.ok(jobPlan.some(row => /SEARCH jobs USING (?:COVERING )?INDEX/i.test(row.detail)), 'Jobs are selected through an existing campaign index.');
  } finally { db.close(); }
});

test('campaign editing preserves source timezone, operational flags, album association and exact captions', async t => {
  const { store } = await fixture(t);
  store.upsertGroups([{ id: 'source@g.us', name: 'Origem', simulation: false, authorized: true }, { id: 'target@g.us', name: 'Destino', simulation: false, authorized: true }]);
  store.saveMedia({ id: 'photo', type: 'image', name: 'foto.jpg' });
  const caption = '📱 iPhone 16 128GB\n🩷 Cor: ROSA\nR$ 2.999,00\nDetalhe na tela pequeno\n𝗣𝗮𝗹𝗮𝗰𝗲 𝗣𝗮𝗿𝗳𝘂𝗺';
  const item = { id: 'photo-item', type: 'image', mediaId: 'photo', caption, ready: true, captureStatus: 'ready', sourcePublicationId: 'captured-photo', sourcePublicationRevision: 123, sourceAlbumParent: { chatId: 'source@g.us', messageId: 'original-album', ignoredInternal: 'not-public' }, sourceManualGroupId: 'manual-group' };
  const old = store.saveCampaign({ id: 'source-campaign', name: 'Lista da loja', state: 'paused', mode: 'repeat', groupIds: ['target@g.us'], items: [item], groupOverrides: {}, intervalMinutes: 10, spacingSeconds: 5,
    schedule: { days: [0,1,2,3,4,5,6], startTime: '08:00', endTime: '18:00', timezone: 'America/Sao_Paulo' }, sourceGroupId: 'source@g.us', sourceDateKey: '2026-10-07', sourceManaged: true, sourceTimezone: 'America/Sao_Paulo', sourceRevision: 8, sourceOrderCustomized: true, sourceConfigurationRequired: true,
    destinationHealth: { 'target@g.us': { suspended: true, code: 'WA_GROUP_NOT_PARTICIPANT' } } });
  const next = validation.campaign({ ...old, name: 'Lista revisada' }, store);
  assert.equal(next.state, 'paused'); assert.equal(next.sourceManaged, true);
  assert.equal(next.sourceTimezone, 'America/Sao_Paulo'); assert.equal(next.schedule.timezone, 'America/Sao_Paulo');
  assert.equal(next.sourceRevision, 8); assert.equal(next.sourceOrderCustomized, true); assert.equal(next.sourceConfigurationRequired, true);
  assert.deepEqual(next.destinationHealth, old.destinationHealth);
  assert.equal(next.items[0].caption, caption); assert.equal(next.items[0].sourcePublicationRevision, 123);
  assert.deepEqual(next.items[0].sourceAlbumParent, { chatId: 'source@g.us', messageId: 'original-album' });
  assert.equal(next.items[0].sourceManualGroupId, 'manual-group'); assert.equal(next.items[0].ready, true);
  const blocked = validation.items([{ ...item, ready: false, captureDeleted: true, captureStatus: 'review' }], store)[0];
  assert.equal(blocked.ready, false); assert.equal(blocked.captureDeleted, true); assert.equal(blocked.captureStatus, 'review');
  assert.equal(validation.schedule({ days: [1], startTime: '08:00', endTime: '18:00' }).timezone, undefined, 'Legacy campaigns keep their original implicit timezone.');
});

test('invalid album metadata and self-target capture cycles are rejected instead of silently normalized away', async t => {
  const { store } = await fixture(t);
  store.upsertGroups([{ id: 'source@g.us', name: 'Origem', simulation: false, authorized: true }]);
  store.saveMedia({ id: 'photo', type: 'image', name: 'foto.jpg' });
  assert.throws(() => validation.items([{ id: 'photo-item', type: 'image', mediaId: 'photo', caption: 'Texto', sourceAlbumParent: { chatId: 'source@g.us' } }], store), /associação/i);
  assert.throws(() => validation.schedule({ timezone: 'not-a-timezone' }), /fuso/i);
  assert.throws(() => validation.campaign({ name: 'Origem com ciclo', mode: 'repeat', sourceGroupId: 'source@g.us', groupIds: ['source@g.us'], intervalMinutes: 10, spacingSeconds: 3, schedule: {}, items: [] }, store), /origem.*destino/i);
});
