'use strict';

// Reproduce the historical sql.js DDL, then use the real 2.3 migration path.
// All records below are synthetic, isolated and unrelated to the user's file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createStore } = require('../src/core/store.cjs');
const { AuthService } = require('../src/core/auth.cjs');
const commercialSchema = fs.readFileSync(path.join(__dirname, 'fixtures/schema-8.sql'), 'utf8')
  .replace(/CREATE (UNIQUE )?INDEX /g, 'CREATE $1INDEX IF NOT EXISTS ')
  .replace(/CREATE TABLE /g, 'CREATE TABLE IF NOT EXISTS ')
  .replace(/CREATE TRIGGER /g, 'CREATE TRIGGER IF NOT EXISTS ');

test('historical sql.js spelling migrates through ALTER TABLE into schema eight and reopens with records, recovery copy and explicit pause', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-migrated-schema-234-'));
  const filename = path.join(directory, 'mega.sqlite'), stores = [];
  t.after(() => { for (const store of stores) store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const old = new DatabaseSync(filename);
  // Exact historical table spelling, including spaces before parentheses and
  // after commas. user_version was zero in this old sql.js implementation.
  old.exec(`CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS campaigns (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS groups_data (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rounds (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, roundId TEXT NOT NULL, campaignId TEXT NOT NULL, groupId TEXT NOT NULL, itemId TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(roundId,groupId,itemId));
    CREATE INDEX IF NOT EXISTS jobs_campaign ON jobs(campaignId,status);`);
  const at = Date.UTC(2026, 9, 7, 12);
  const campaign = { id: 'legacy-campaign', name: 'Campanha sintética preservada', state: 'active', mode: 'repeat', groupIds: ['legacy-test@g.us'], intervalMinutes: 10, spacingSeconds: 3, schedule: { days: [0,1,2,3,4,5,6], startTime: '00:00', endTime: '00:00' }, items: [{ id: 'item', type: 'text', text: '*Texto original* 😀\nLinha 2' }], groupOverrides: {}, revision: 3 };
  const insert = (table, record) => old.prepare(`INSERT INTO ${table}(id,data) VALUES(?,?)`).run(record.id, JSON.stringify(record));
  for (const [id, value] of [['integrationMode', 'whatsapp'], ['initialized', true], ['theme', 'light']]) insert('settings', { id, value });
  insert('campaigns', campaign);
  insert('groups_data', { id: 'legacy-test@g.us', name: 'Grupo sintético deste teste', authorized: true, simulation: false });
  insert('media', { id: 'legacy-media', name: 'arquivo-preservado.jpg', type: 'image' });
  insert('templates', { id: 'legacy-template', name: 'Modelo sintético', items: campaign.items });
  insert('rounds', { id: 'legacy-round', campaignId: campaign.id, startedAt: at, status: 'running' });
  const confirmed = { id: 'legacy-confirmed', roundId: 'legacy-round', campaignId: campaign.id, groupId: campaign.groupIds[0], itemId: 'item', status: 'confirmed', attempts: 1, messageId: 'LEGACY_CONFIRMED_NEVER_REPEAT', createdAt: at, itemSnapshot: campaign.items[0] };
  old.prepare('INSERT INTO jobs(id,roundId,campaignId,groupId,itemId,status,data) VALUES(?,?,?,?,?,?,?)').run(confirmed.id, confirmed.roundId, confirmed.campaignId, confirmed.groupId, confirmed.itemId, confirmed.status, JSON.stringify(confirmed));
  assert.equal(old.prepare('PRAGMA user_version').get().user_version, 0);
  old.close();

  const migrated = await createStore(directory); stores.push(migrated);
  assert.equal(migrated.schemaVersion, 7);
  const auth = new AuthService({ store: migrated });
  const owner = (await auth.setupOwner({ name: 'Dono sintético', username: 'legacy-owner', phone: '5562999990101', password: 'Migracao-Segura-234' })).user;
  migrated.saveCampaign({ ...migrated.getCampaign(campaign.id), ownerId: owner.id });
  migrated.setSetting('automationState', { stopped: false });
  migrated.close();
  const schemaEight = new DatabaseSync(filename);
  assert.match(schemaEight.prepare("SELECT sql FROM sqlite_schema WHERE name='campaigns'").get().sql, /campaigns \(id TEXT PRIMARY KEY, data TEXT NOT NULL, storageMode/);
  for (const table of ['rounds', 'jobs']) assert.ok(schemaEight.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'storageMode'));
  schemaEight.exec(commercialSchema);
  assert.equal(schemaEight.prepare('PRAGMA user_version').get().user_version, 8);
  schemaEight.close();

  const upgraded = await createStore(directory, { upgradeVersion: '2.3.4-diagnostic' }); stores.push(upgraded);
  assert.equal(upgraded.schemaVersion, 8); assert.equal(upgraded.coreSchemaVersion, 7);
  // The 20 historical tables and 11 persistent opportunity tables survive
  // compatibility inspection; adding this module does not erase either set.
  assert.equal(upgraded.schemaCompatibility.extraTablesPreserved, 32);
  assert.equal(upgraded.getCampaign(campaign.id).state, 'paused');
  assert.deepEqual(upgraded.getCampaign(campaign.id).items, campaign.items);
  assert.equal(upgraded.getJob(confirmed.id).status, 'confirmed');
  assert.equal(upgraded.getJob(confirmed.id).messageId, confirmed.messageId);
  assert.equal(upgraded.getTemplate('legacy-template').items[0].text, campaign.items[0].text);
  assert.equal(upgraded.getMedia('legacy-media').name, 'arquivo-preservado.jpg');
  assert.equal(upgraded.getSetting('theme'), 'light');
  assert.equal(upgraded.getSetting('automationState').stopped, true);
  assert.ok(upgraded.upgradeBackup?.path);
  const recovery = new DatabaseSync(upgraded.upgradeBackup.path, { readOnly: true });
  try {
    assert.equal(recovery.prepare('PRAGMA user_version').get().user_version, 8);
    assert.equal(recovery.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.equal(JSON.parse(recovery.prepare("SELECT data FROM campaigns WHERE id='legacy-campaign'").get().data).state, 'active');
    assert.equal(JSON.parse(recovery.prepare("SELECT data FROM jobs WHERE id='legacy-confirmed'").get().data).messageId, confirmed.messageId);
  } finally { recovery.close(); }
  const freshAuth = new AuthService({ store: upgraded });
  assert.equal((await freshAuth.login({ username: 'legacy-owner', password: 'Migracao-Segura-234' })).user.id, owner.id);
  upgraded.close();
  const reopened = await createStore(directory, { upgradeVersion: '2.3.4-diagnostic' }); stores.push(reopened);
  assert.equal(reopened.upgradeBackup, null);
  assert.equal(reopened.getJob(confirmed.id).status, 'confirmed');
  assert.equal(reopened.getCampaign(campaign.id).state, 'paused');
});
