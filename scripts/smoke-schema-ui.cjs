'use strict';

// This fixture reproduces the known schema-8 database without reading or
// modifying a customer's profile. WhatsApp is simulated; licensing uses the
// published service and the production desktop client, with no bypass or key.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const { _electron, expect } = require('@playwright/test');
const { createStore, seed } = require('../src/core/store.cjs');
const { AuthService } = require('../src/core/auth.cjs');
const { MediaManager } = require('../src/core/media.cjs');
const { TemplateService } = require('../src/core/template-service.cjs');

const USERNAME = 'dono.compatibilidade';
const PASSWORD = 'Senha-Teste-Esquema-8-2026';

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-schema-8-ui-'));
  const screenshots = process.env.MEGA_SCREENSHOT_DIR || '/workspace/scratch/schema-fix-233';
  fs.mkdirSync(screenshots, { recursive: true });
  let app, page;
  const errors = [];
  const mediaBytes = Buffer.from('Documento gerenciado do teste de compatibilidade.\nPreservar estes bytes após atualização.\n');
  const preStore = await createStore(profile);
  seed(preStore);
  const auth = new AuthService({ store: preStore });
  const owner = (await auth.setupOwner({ name: 'Dono Teste Compatibilidade', username: USERNAME, password: PASSWORD })).user;
  const media = new MediaManager(preStore, { auth });
  const document = await media.importBuffer(mediaBytes, { name: 'compatibilidade-esquema-8.txt' });
  const model = new TemplateService({ store: preStore, auth, media }).save({ name: 'Modelo preservado — esquema 8', items: [{ type: 'text', text: '*Texto original* 😀\nSem alterações.' }, { type: 'document', mediaId: document.id, caption: 'Legenda original' }] }, owner.id);
  const campaign = preStore.saveCampaign({ id: randomUUID(), name: 'Campanha preservada — esquema 8', ownerId: owner.id, provenance: 'isolated-schema-8-test', state: 'active', mode: 'repeat', intervalMinutes: 10, spacingSeconds: 5, groupIds: ['sim-01@simulation'], items: model.items.map(item => ({ ...item, id: randomUUID() })), schedule: { days: [0, 1, 2, 3, 4, 5, 6], startTime: '08:00', endTime: '18:00', startDate: '', endDate: '' }, groupOverrides: {}, dailyRoundLimit: 0, dailySendLimit: 0, nextRunAt: Date.now() + 86400000, roundIndex: 4 });
  preStore.setSetting('theme', 'light');
  preStore.setSetting('closeBehavior', 'quit');
  preStore.setSetting('lastAppUpgradeVersion', '2.3.2');
  preStore.setSetting('automationState', { stopped: false });
  preStore.close();

  const databasePath = path.join(profile, 'mega.sqlite');
  const legacyOpaque = JSON.stringify({ id: 'opaque-legacy-record', notes: 'Registro legado preservado; sem módulo financeiro no aplicativo.' });
  const legacyDb = new DatabaseSync(databasePath);
  try {
    // The core tables already exist. Only the actual schema-8 additions and
    // indexes are introduced; the stored core schema remains unchanged.
    const sql = fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'schema-8.sql'), 'utf8')
      .replace(/CREATE TABLE /g, 'CREATE TABLE IF NOT EXISTS ')
      .replace(/CREATE (UNIQUE )?INDEX /g, (_, unique = '') => `CREATE ${unique}INDEX IF NOT EXISTS `)
      .replace(/CREATE TRIGGER /g, 'CREATE TRIGGER IF NOT EXISTS ');
    legacyDb.exec(sql);
    legacyDb.prepare('INSERT INTO sales(id,data,storageMode) VALUES(?,?,?)').run('opaque-legacy-record', legacyOpaque, 'simulated');
    assert.equal(legacyDb.prepare('PRAGMA user_version').get().user_version, 8);
  } finally { legacyDb.close(); }

  const inspectDatabase = filename => {
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      return {
        version: Number(db.prepare('PRAGMA user_version').get().user_version),
        integrity: db.prepare('PRAGMA quick_check').get().quick_check,
        opaque: db.prepare('SELECT data FROM sales WHERE id=?').get('opaque-legacy-record').data,
        review: (() => { const row = db.prepare("SELECT data FROM settings WHERE id='coreSchemaCompatibility'").get(); return row ? JSON.parse(row.data).value : null; })(),
        campaign: JSON.parse(db.prepare('SELECT data FROM campaigns WHERE id=?').get(campaign.id).data),
        media: JSON.parse(db.prepare('SELECT data FROM media WHERE id=?').get(document.id).data),
        compatibilityAudits: db.prepare("SELECT COUNT(*) AS total FROM audit WHERE json_extract(data,'$.action')='database.compatibility'").get().total
      };
    } finally { db.close(); }
  };
  const backups = () => fs.readdirSync(path.join(profile, 'backups')).filter(name => name.startsWith('antes-atualizacao-') && name.endsWith('.sqlite')).sort();
  const launch = async () => {
    app = await _electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', '--disable-gpu', ...(process.env.MEGA_PROXY_TEST ? ['--proxy-server=http://proxy:8080'] : []), process.env.MEGA_APP_PATH || '.'], env: { ...process.env, MEGA_DATA_DIR: profile }, timeout: 30000 });
    await expect.poll(() => { page = app.windows().find(window => /\/ui\/index\.html$/.test(window.url())); return Boolean(page); }, { timeout: 30000 }).toBe(true);
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.getByRole('heading', { name: 'Bem-vindo de volta' }).waitFor();
    await expect.poll(async () => (await rpc('licenseStatus')).allowed, { timeout: 30000 }).toBe(true);
  };
  const rpc = async (action, payload = {}) => {
    const value = await page.evaluate(({ action, payload }) => window.mega.call(action, payload), { action, payload });
    if (value?.error) throw Object.assign(new Error(value.error), { code: value.code });
    return value;
  };
  const login = async () => {
    await page.locator('#auth-form [name=username]').fill(USERNAME);
    await page.locator('#auth-form [name=password]').fill(PASSWORD);
    await page.locator('#auth-form [type=submit]').click();
    await page.getByRole('heading', { name: 'Tudo sob controle' }).waitFor();
  };
  const close = async () => {
    if (!app) return;
    const instance = app; app = null;
    await instance.evaluate(({ app }) => app.exit(0)).catch(error => { if (!/closed|destroyed/i.test(error.message)) throw error; });
    await instance.close().catch(() => {});
  };
  const assertPreserved = async () => {
    const snapshot = await rpc('snapshot');
    assert.equal(snapshot.auth.user.id, owner.id);
    assert.equal(snapshot.settings.theme, 'light');
    assert.equal(snapshot.settings.integrationMode, 'simulated');
    assert.equal(snapshot.automation.stopped, true, 'Opening the compatible database must require an explicit automation resume');
    const savedCampaign = snapshot.campaigns.find(value => value.id === campaign.id);
    assert(savedCampaign, 'The existing campaign must remain visible');
    assert(!['active', 'running'].includes(savedCampaign.state), 'The existing campaign must not resume automatically');
    assert.equal(savedCampaign.roundIndex, 4);
    assert.deepEqual(savedCampaign.items, campaign.items);
    assert.deepEqual(snapshot.templates.find(value => value.id === model.id).items, model.items);
    assert.equal(snapshot.media.find(value => value.id === document.id).name, document.name);
    assert.deepEqual(fs.readFileSync(document.path), mediaBytes);
    const navigation = await page.locator('#navigation').innerText();
    assert(!/vendas|financeiro|estoque|margens|custos|caixa/i.test(navigation), 'Legacy tables must not reintroduce removed modules');
    assert.match(await page.locator('body').innerText(), /SIMULAÇÃO — DADOS FICTÍCIOS/);
    const persisted = inspectDatabase(databasePath);
    assert.equal(persisted.version, 8, 'The app must not lower PRAGMA user_version');
    assert.equal(persisted.integrity, 'ok');
    assert.equal(persisted.opaque, legacyOpaque, 'The unexposed legacy record must remain byte-identical');
    assert.equal(persisted.media.path, document.path, 'The private managed media path must remain unchanged');
    assert.equal(persisted.review.databaseSchemaVersion, 8);
    assert.equal(persisted.review.extraTablesPreserved, 18);
    assert.equal(persisted.compatibilityAudits, 1, 'Opening a reviewed database must not duplicate the compatibility audit');
    return snapshot;
  };

  try {
    await launch(); await login();
    const first = await assertPreserved();
    assert(first.upgradeBackup?.path, 'A recoverable backup must be reported in the app');
    assert.equal(first.upgradeBackup.schemaVersion, 8);
    const original = inspectDatabase(first.upgradeBackup.path);
    assert.equal(original.version, 8); assert.equal(original.integrity, 'ok');
    assert.equal(original.opaque, legacyOpaque);
    assert.equal(original.review, null, 'The backup must predate compatibility bookkeeping');
    assert.equal(original.campaign.state, 'active', 'The backup must preserve the original operational state');
    await page.locator('#navigation [data-id=settings]').click();
    await expect(page.locator('#settings-form')).toContainText('Cópia anterior à atualização verificada');
    await expect(page.locator('#settings-form')).toContainText(first.upgradeBackup.path);
    await page.screenshot({ path: path.join(screenshots, 'esquema-8-backup-preservado.png'), fullPage: true });
    const firstBackups = backups(); assert.equal(firstBackups.length, 1);
    await close(); await launch(); await login();
    await assertPreserved();
    assert.deepEqual(backups(), firstBackups, 'A second launch must not create another identical upgrade backup');
    await page.locator('#navigation [data-id=library]').click();
    await page.locator('[data-action=library-tab][data-id=templates]').click();
    await expect(page.locator('#library-page')).toContainText(model.name);
    await page.screenshot({ path: path.join(screenshots, 'esquema-8-modelo-apos-reinicio.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log('Schema-8 desktop GUI smoke passed: existing owner login, real hosted licensing authorization, verified core compatibility, original schema version retained, one recoverable backup before writes, 18 legacy tables and opaque record preserved, campaigns and text/media models retained, media bytes unchanged, automation remains stopped, no financial navigation, Settings backup visible, restart retains user and content without duplicate backup or audit. WhatsApp was simulated in an isolated profile. This Linux Electron run does not verify physical Windows installation.');
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(screenshots, 'failed-schema-smoke.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await close().catch(() => {});
    if (process.env.MEGA_KEEP_TEST_DATA) console.log('Isolated schema test data:', profile);
    else fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
