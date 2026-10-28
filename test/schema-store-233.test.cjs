'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createStore } = require('../src/core/store.cjs');
const { AuthService } = require('../src/core/auth.cjs');
const schema8 = fs.readFileSync(path.join(__dirname, 'fixtures/schema-8.sql'), 'utf8');
const additiveSchema = schema8.replace(/CREATE (UNIQUE )?INDEX /g, 'CREATE $1INDEX IF NOT EXISTS ').replace(/CREATE TABLE /g, 'CREATE TABLE IF NOT EXISTS ').replace(/CREATE TRIGGER /g, 'CREATE TRIGGER IF NOT EXISTS ');
const password = 'Schema-Preservacao-2026';
const digest = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-schema-233-')), stores = [];
  t.after(() => { for (const store of stores) store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const open = async options => { const store = await createStore(dir, options); stores.push(store); return store; };
  const store = await open(); store.setSetting('integrationMode', 'whatsapp'); store.setSetting('initialized', true);
  const auth = new AuthService({ store });
  const owner = (await auth.setupOwner({ name: 'Dono preservado', username: 'owner-schema', phone: '5562999990101', password })).user;
  store.setSetting('lastAppUpgradeVersion', '3.1.0'); store.setSetting('automationState', { stopped: false });
  store.setSetting('customPreferences', { prefix: '!procura', maxAgeHours: 2, theme: 'light' });
  store.upsertGroups([{ id: 'known@g.us', name: 'Cadastro legítimo', simulation: false, authorized: true }]);
  fs.mkdirSync(path.join(dir, 'media')); const mediaFile = path.join(dir, 'media', 'retained.jpg'); fs.writeFileSync(mediaFile, Buffer.from('Managed media fixture bytes'));
  fs.writeFileSync(path.join(dir, 'credentials.bin'), Buffer.from('Protected credential sentinel, not a real secret'));
  store.saveMedia({ id: 'media', name: 'retained.jpg', path: mediaFile, type: 'image', mime: 'image/jpeg' });
  store.saveTemplate({ id: 'model', name: 'Modelo antigo', items: [{ id: 'text', type: 'text', text: '*Texto* 😀\nLinha 2' }, { id: 'image', type: 'image', mediaId: 'media', caption: 'Legenda' }] });
  const campaign = store.saveCampaign({ id: 'campaign', name: 'Campanha preservada', ownerId: owner.id, state: 'active', mode: 'repeat', intervalMinutes: 10, spacingSeconds: 3, schedule: { days: [0,1,2,3,4,5,6], startTime: '00:00', endTime: '23:59' }, groupIds: ['known@g.us'], items: [{ id: 'item', type: 'text', text: 'Conteúdo sem alterações' }], groupOverrides: {} });
  store.insertRound({ id: 'round', campaignId: campaign.id, startedAt: Date.now(), status: 'running' });
  for (const status of ['confirmed', 'uncertain', 'queued']) store.insertJob({ id: status, roundId: 'round', campaignId: campaign.id, groupId: 'known@g.us', itemId: status, status, attempts: status === 'queued' ? 0 : 1, messageId: 'ID_' + status, createdAt: Date.now() });
  store.upsertSearchMessage({ chatId: 'known@g.us', messageId: 'offer-original', text: 'iPhone 15 Pro Max 256GB R$ 3.850,00', originalAt: Date.now(), capturedAt: Date.now(), senderId: '5562999990202@s.whatsapp.net' }, [{ id: 'offer', modelKey: 'iphone 15 pro max', storageGB: 256, priceCents: 385000, priceKind: 'cash', confidence: 'confirmed' }]);
  store.saveEntity('contacts', { id: 'contact', name: 'Contato preservado', phone: '5562999990303', categories: ['Cliente Nerópolis', 'Fornecedor'] });
  store.saveEntity('reminders', { id: 'reminder', title: 'Lembrete existente', state: 'paused', time: '15:00', timezone: 'America/Sao_Paulo', repeat: 'daily', recipientId: owner.id });
  store.saveAlertRecipient({ id: 'responsible', name: 'Responsável', phone: '5562999990101', enabled: true });
  store.setSetting('integrationMode', 'simulated'); store.setSetting('automationState', { stopped: false });
  store.upsertGroups([{ id: 'test@simulation', name: 'Grupo da simulação', simulation: true, authorized: true }]);
  store.setSetting('integrationMode', 'whatsapp');
  const passwordHash = store.getEntity('users', owner.id).passwordHash; store.close();
  const filename = path.join(dir, 'mega.sqlite'), db = new DatabaseSync(filename); db.exec(additiveSchema);
  const inactiveRecord = { id: 'archived-sale', recordedAt: 123456, internal: 'Preserved dormant legacy record' };
  db.prepare('INSERT INTO sales(id,data,storageMode) VALUES(?,?,?)').run(inactiveRecord.id, JSON.stringify(inactiveRecord), 'whatsapp');
  db.close();
  return { dir, filename, open, owner, passwordHash, mediaFile, inactiveRecord };
}
test('known schema eight opens with a verified snapshot, retained accounts, media, offers and send ledger, without downgrading or loading extra modules', async t => {
  const f = await fixture(t), mediaHash = digest(f.mediaFile), credentialsHash = digest(path.join(f.dir, 'credentials.bin'));
  const store = await f.open({ upgradeVersion: '2.3.3' });
  assert.equal(store.schemaVersion, 8); assert.equal(store.coreSchemaVersion, 7); assert.equal(store.schemaCompatibility.extraTablesPreserved, 18);
  assert(store.upgradeBackup?.path); assert.equal(fs.statSync(store.upgradeBackup.path).mode & 0o777, 0o600);
  const backup = new DatabaseSync(store.upgradeBackup.path, { readOnly: true });
  try {
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 8); assert.equal(backup.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.equal(JSON.parse(backup.prepare("SELECT data FROM campaigns WHERE id='campaign'").get().data).state, 'active');
    assert.equal(JSON.parse(backup.prepare("SELECT data FROM settings WHERE id='mode:whatsapp:automationState'").get().data).value.stopped, false);
    assert.equal(backup.prepare("SELECT data FROM settings WHERE id='coreSchemaCompatibility'").get(), undefined);
    assert.deepEqual(JSON.parse(backup.prepare("SELECT data FROM sales WHERE id='archived-sale'").get().data), f.inactiveRecord);
  } finally { backup.close(); }
  const auth = new AuthService({ store }); assert.equal((await auth.login({ username: 'owner-schema', password })).user.id, f.owner.id);
  assert.deepEqual(store.getEntity('users', f.owner.id).passwordHash, f.passwordHash);
  assert.equal(store.listEntities('recovery_tokens').length, 8); assert.deepEqual(store.getSetting('customPreferences'), { prefix: '!procura', maxAgeHours: 2, theme: 'light' });
  assert.equal(store.getCampaign('campaign').state, 'paused'); assert.equal(store.getCampaign('campaign').items[0].text, 'Conteúdo sem alterações');
  assert.equal(store.getJob('confirmed').status, 'confirmed'); assert.equal(store.getJob('confirmed').messageId, 'ID_confirmed'); assert.equal(store.getJob('uncertain').status, 'uncertain'); assert.equal(store.getJob('queued').status, 'queued');
  assert.equal(store.getSearchMonitorStats().totalOffers, 1); assert.equal(store.getTemplate('model').items[1].caption, 'Legenda');
  assert.equal(store.listGroups().length, 1); assert.equal(store.listEntities('contacts').length, 1); assert.equal(store.listEntities('reminders').length, 1); assert.equal(store.listAlertRecipients().length, 1);
  assert.equal(store.getSetting('automationState').stopped, true); store.setSetting('integrationMode', 'simulated'); assert.equal(store.getSetting('automationState').stopped, true); assert.equal(store.listGroups()[0].id, 'test@simulation'); store.setSetting('integrationMode', 'whatsapp');
  assert.throws(() => store.listEntities('sales'), /Coleção inválida/);
  assert.equal(digest(f.mediaFile), mediaHash); assert.equal(digest(path.join(f.dir, 'credentials.bin')), credentialsHash);
  store.close(); const raw = new DatabaseSync(f.filename, { readOnly: true }); try { assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 8); assert.deepEqual(JSON.parse(raw.prepare("SELECT data FROM sales WHERE id='archived-sale'").get().data), f.inactiveRecord); } finally { raw.close(); }
});
test('compatibility approval and backup are not repeated on reopening and do not reset an explicit resume', async t => {
  const f = await fixture(t); let store = await f.open({ upgradeVersion: '2.3.3' });
  const originalBackup = store.upgradeBackup.path; store.setSetting('automationState', { stopped: false, source: 'explicit-user-resume' }); store.close();
  store = await f.open({ upgradeVersion: '2.3.3' }); assert.equal(store.upgradeBackup, null); assert.equal(store.getSetting('automationState').stopped, false); assert.equal(store.getSetting('coreSchemaCompatibility').backupPath, originalBackup);
  assert.equal(fs.readdirSync(path.join(f.dir, 'backups')).length, 1); assert.equal(store.listEntities('audit').filter(row => row.action === 'database.compatibility').length, 1);
  const target = path.join(f.dir, 'export-snapshot.sqlite'); assert.equal(store.createRecoverySnapshot(target).schemaVersion, 8);
});
test('unknown newer schemas are rejected without altering the database or writing upgrade markers', async t => {
  const f = await fixture(t), db = new DatabaseSync(f.filename); db.exec('PRAGMA user_version=9'); db.close(); const before = digest(f.filename);
  await assert.rejects(f.open({ upgradeVersion: '2.3.3' }), error => error.code === 'DATABASE_SCHEMA_NEWER' && error.databaseSchemaVersion === 9);
  assert.equal(digest(f.filename), before); assert.equal(fs.existsSync(path.join(f.dir, 'backups')), false);
});
test('a schema-eight label cannot bypass missing deduplication constraints or an unknown core trigger', async t => {
  const f = await fixture(t); let db = new DatabaseSync(f.filename); db.exec('DROP INDEX buscas_runs_command'); db.close(); let before = digest(f.filename);
  await assert.rejects(f.open({ upgradeVersion: '2.3.3' }), error => error.code === 'DATABASE_SCHEMA_INCOMPATIBLE'); assert.equal(digest(f.filename), before);
  db = new DatabaseSync(f.filename); db.exec('CREATE UNIQUE INDEX buscas_runs_command ON buscas_runs(chatId,messageId) WHERE chatId IS NOT NULL AND messageId IS NOT NULL; CREATE TRIGGER unknown_campaign_trigger AFTER UPDATE ON campaigns BEGIN SELECT 1; END;'); db.close(); before = digest(f.filename);
  await assert.rejects(f.open({ upgradeVersion: '2.3.3' }), error => error.code === 'DATABASE_SCHEMA_INCOMPATIBLE'); assert.equal(digest(f.filename), before); assert.equal(fs.existsSync(path.join(f.dir, 'backups')), false);
});
test('failure creating the required recovery copy blocks compatibility writes and preserves the original profile', async t => {
  const f = await fixture(t); fs.writeFileSync(path.join(f.dir, 'backups'), 'Blocked backup destination');
  await assert.rejects(f.open({ upgradeVersion: '2.3.3' }), error => error.code === 'EEXIST');
  const db = new DatabaseSync(f.filename, { readOnly: true }); try { assert.equal(JSON.parse(db.prepare("SELECT data FROM campaigns WHERE id='campaign'").get().data).state, 'active'); assert.equal(db.prepare("SELECT data FROM settings WHERE id='coreSchemaCompatibility'").get(), undefined); assert.equal(JSON.parse(db.prepare("SELECT data FROM settings WHERE id='lastAppUpgradeVersion'").get().data).value, '3.1.0'); } finally { db.close(); }
  fs.unlinkSync(path.join(f.dir, 'backups')); assert.equal((await f.open({ upgradeVersion: '2.3.3' })).schemaVersion, 8);
});
test('write interruption after backup rolls back the pause and compatibility marker together', async t => {
  const f = await fixture(t);
  await assert.rejects(f.open({ upgradeVersion: '2.3.3', beforeWrite: () => { throw Object.assign(new Error('Injected disk failure'), { code: 'ENOSPC' }); } }), error => error.code === 'ENOSPC');
  const db = new DatabaseSync(f.filename, { readOnly: true }); try { assert.equal(JSON.parse(db.prepare("SELECT data FROM campaigns WHERE id='campaign'").get().data).state, 'active'); assert.equal(JSON.parse(db.prepare("SELECT data FROM settings WHERE id='mode:whatsapp:automationState'").get().data).value.stopped, false); assert.equal(db.prepare("SELECT data FROM settings WHERE id='coreSchemaCompatibility'").get(), undefined); } finally { db.close(); }
  assert.equal(fs.readdirSync(path.join(f.dir, 'backups')).length, 1); assert.equal((await f.open({ upgradeVersion: '2.3.3' })).getSetting('automationState').stopped, true);
});
test('an untouched schema-eight fixture and a fresh schema-seven database both remain supported', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-schema-fresh-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacy = path.join(root, 'legacy'); fs.mkdirSync(legacy); const db = new DatabaseSync(path.join(legacy, 'mega.sqlite')); db.exec(schema8); db.close();
  const store = await createStore(legacy, { upgradeVersion: '2.3.3' }); assert.equal(store.schemaVersion, 8); store.close();
  const fresh = await createStore(path.join(root, 'fresh'), { upgradeVersion: '2.3.3' }); assert.equal(fresh.schemaVersion, 7); assert.equal(fresh.schemaCompatibility, null); assert.equal(fresh.upgradeBackup, null); assert.throws(() => fresh.listEntities('sales'), /Coleção inválida/); fresh.close();
});
