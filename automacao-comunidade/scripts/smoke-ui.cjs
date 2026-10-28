'use strict';

// Exercises the real Electron preload, SQLite worker, service, queue and renderer.
// WhatsApp remains explicitly SIMULATED. This does not prove delivery to a phone.
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { _electron: electron } = require('@playwright/test');

const root = path.resolve(__dirname, '..');
const appPath = process.env.COMMUNITY_APP_PATH || root;
const output = path.resolve(process.env.COMMUNITY_UI_OUTPUT || path.join(root, '..', 'scratch', 'community-ui', 'evidence'));
const profile = path.resolve(process.env.COMMUNITY_UI_PROFILE || path.join(root, '..', 'scratch', 'community-ui', `profile-${Date.now()}`));
fs.mkdirSync(output, { recursive: true });
const results = [], errors = [];
let app, page;
const pass = (name, detail) => { results.push({ name, passed: true, detail }); process.stdout.write(`PASS ${name}: ${detail}\n`); };
const click = (action, within = page) => within.locator(`[data-action="${action}"]`).first().click();
const rpc = (action, payload = {}) => page.evaluate(({ action, payload }) => window.community.call(action, payload), { action, payload });
const go = async (name) => { await page.locator(`#navigation a[href="#${name}"]`).click(); await page.waitForFunction(name => location.hash === `#${name}`, name); await page.locator('.page-heading h1').waitFor(); };
const screenshot = (name) => page.screenshot({ path: path.join(output, name), fullPage: true });
async function poll(predicate, timeoutMs = 15000) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 150)); } throw new Error('Timed out waiting for a verified backend state.'); }
async function launch() {
  app = await electron.launch({
    executablePath: process.env.COMMUNITY_ELECTRON_PATH || require('electron'),
    args: ['--no-sandbox', '--disable-dev-shm-usage', appPath],
    env: { ...process.env, COMMUNITY_TEST_MODE: '1', COMMUNITY_TEST_PROFILE: profile, COMMUNITY_TEST_HIDE: '0' },
    timeout: 30000,
  });
  page = await app.firstWindow(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => document.querySelector('#app')?.getAttribute('aria-busy') === 'false');
  await page.locator('.page-heading h1').waitFor();
}
async function close() { if (!app) return; await app.evaluate(async ({ app }) => app.quit()); await app.close().catch(() => {}); app = null; }

(async () => {
  await launch();
  assert.equal(await page.locator('#navigation .nav-link').count(), 7);
  assert.equal((await rpc('snapshot')).mode, 'whatsapp');
  assert.equal((await rpc('snapshot')).groups.length, 0);
  assert.equal(await page.locator('#simulation-banner').isVisible(), false);
  assert.equal(await page.locator('#stop-all').isVisible(), true);
  await screenshot('01-painel-real-vazio.png');
  pass('independent-real-empty', 'Real profile starts empty; seven sections and global stop are present. No sample contact or group is injected.');

  await go('configuracoes');
  await page.locator('#integration-mode').selectOption('simulated'); await click('switch-mode');
  await page.locator('[data-confirm="ok"]').click();
  await page.waitForFunction(() => document.querySelector('#simulation-banner')?.hidden === false);
  assert.equal((await rpc('snapshot')).groups.length, 0);
  await click('load-simulation');
  await poll(async () => (await rpc('snapshot')).groups.length > 0);
  await go('grupos');
  await click('refresh-participants');
  await poll(async () => (await rpc('listContacts', { limit: 200 })).total > 0);
  await screenshot('02-grupos-simulados-explicitos.png');
  pass('explicit-isolated-simulation', 'Changing mode does not create samples; explicit button loads a synthetic group and refresh imports identified participants without consent.');

  await go('contatos');
  const initial = await rpc('listContacts', { limit: 200 });
  assert(initial.items.every(contact => !contact.authorized));
  await click('select-filtered-contacts'); await click('authorize-selected');
  await page.locator('#bulk-consent').fill('Teste automatizado: contatos fictícios autorizados exclusivamente na simulação.');
  await page.locator('#authorize-form input[name="confirmed"]').check(); await click('confirm-authorize');
  await poll(async () => (await rpc('listContacts', { limit: 200 })).items.every(contact => contact.authorized));
  await click('edit-contact');
  await page.locator('#contact-name').fill('Nome salvo de teste');
  await click('save-contact');
  assert((await rpc('listContacts', { limit: 200 })).items.some(contact => contact.name === 'Nome salvo de teste'));
  await screenshot('03-contatos-autorizados.png');
  pass('contact-consent-and-edit', 'Bulk selection is distinct from consent. Typed consent is persisted; a saved contact name can be edited without changing account identity.');

  await go('modelos'); await click('new-template');
  await page.locator('#template-name').fill('Convite UI persistente');
  await page.locator('#template-message').fill('Olá, {nome}! 👋\nConheça nossa comunidade:\n{link_comunidade}\n*Convite de teste*');
  await click('save-template');
  let templates = await rpc('listTemplates'); assert.equal(templates.total, 1);
  await click('edit-template');
  await page.locator('#template-name').fill('Convite UI revisado'); await click('save-template');
  await click('duplicate-template');
  templates = await rpc('listTemplates'); assert.equal(templates.total, 2);
  await click('delete-template'); await page.locator('[data-confirm="ok"]').click();
  templates = await rpc('listTemplates'); assert.equal(templates.total, 1);
  const template = templates.items[0];
  pass('template-crud', 'Create, edit, duplicate and delete use the real persistent backend; template text preserves emoji, formatting and line breaks.');

  await click('use-template');
  await page.locator('#campaign-name').fill('Convite de teste da interface');
  await page.locator('#campaign-link').fill('https://chat.whatsapp.com/CommunityUiTestOnly');
  await click('editor-select-groups');
  await page.locator('#campaign-interval').fill('30');
  await page.locator('#campaign-execution-limit').fill('1');
  await page.locator('#campaign-start-time').fill('00:00'); await page.locator('#campaign-end-time').fill('23:59');
  await click('save-campaign');
  let snapshot = await rpc('snapshot'); assert.equal(snapshot.campaigns.length, 1);
  const campaignId = snapshot.campaigns[0].id;
  assert.equal(snapshot.campaigns[0].status, 'draft'); assert.equal(snapshot.campaigns[0].intervalMs, 30000);
  assert.equal(snapshot.campaigns[0].message, template.message);
  assert.equal((await rpc('listHistory')).total, 0);
  await go('campanhas'); await click('edit-campaign');
  await page.locator('#campaign-interval').fill('3'); await click('save-and-preview');
  await page.locator('#recipient-preview').waitFor();
  assert((await page.locator('#recipient-preview').textContent()).includes('https://chat.whatsapp.com/CommunityUiTestOnly'));
  assert(!(await page.locator('#recipient-preview').textContent()).includes('{nome}'));
  assert.equal(await page.locator('#preview-recipient option').count(), 1, 'Preview respects the configured execution limit.');
  await screenshot('04-previa-campanha.png');
  await click('close-modal');
  pass('campaign-persisted-preview', 'Saving creates only a draft. Thirty seconds is persisted; interval edits, selected real IDs and per-recipient rendered text are reflected by a server preview.');

  if (await page.locator('#global-pause').isVisible()) {
    await page.locator('#resume-automation').click(); await page.locator('[data-confirm="ok"]').click();
    await page.waitForFunction(() => document.querySelector('#global-pause')?.hidden);
  }
  await click('preview-campaign'); await click('confirm-campaign-start');
  await poll(async () => (await rpc('listHistory')).items.some(record => record.status === 'accepted'), 18000);
  let history = await rpc('listHistory'); assert.equal(history.items.filter(record => record.status === 'accepted').length, 1);
  assert.equal(history.items.filter(record => record.status === 'delivered').length, 0);
  await go('historico'); await screenshot('05-historico-aceitacao-simulada.png');
  const newPreview = await rpc('previewCampaign', { id: campaignId });
  assert.equal(newPreview.recipients.length, 1);
  const acceptedContactId = history.items.find(record => record.status === 'accepted').contactId;
  assert(!newPreview.recipients.some(contact => contact.id === acceptedContactId));
  pass('simulation-send-ledger', 'Explicit activation submits a single simulated recipient; accepted is not labelled delivered. A subsequent new-only preview excludes that contact globally.');

  await go('campanhas'); await click('edit-campaign');
  await page.locator('input[name="mode"][value="all"]').check();
  await click('save-and-preview'); await page.locator('#confirm-repeat').waitFor();
  await click('confirm-campaign-start');
  await page.waitForFunction(() => !document.querySelector('#modal-error')?.hidden);
  assert((await page.locator('#modal-error').textContent()).includes('confirmação'));
  await screenshot('06-confirmacao-reenvio.png');
  await click('close-modal');
  pass('repeat-explicit-confirmation', 'Reinvite mode exposes prior recipients and refuses UI activation without the explicit repeat checkbox.');

  await page.locator('#stop-all').click();
  await page.waitForFunction(() => document.querySelector('#global-pause')?.hidden === false);
  snapshot = await rpc('snapshot'); assert(snapshot.queue.stopped || snapshot.queue.automationStopped);
  pass('global-stop', 'Global stop is always accessible and persists the automatic-entry block.');

  await close(); await launch();
  snapshot = await rpc('snapshot');
  assert.equal(snapshot.mode, 'simulated'); assert.equal(snapshot.campaigns[0].id, campaignId); assert.equal(snapshot.campaigns[0].intervalMs, 3000);
  assert.equal((await rpc('listTemplates')).total, 1); assert.equal((await rpc('listContacts', { limit: 200 })).items.filter(contact => contact.authorized).length, initial.total);
  assert(snapshot.queue.stopped || snapshot.queue.automationStopped);
  history = await rpc('listHistory'); assert.equal(history.items.filter(record => record.status === 'accepted').length, 1);
  pass('restart-persistence', 'Campaign, interval, template, consent, accepted-send ledger and global stop survive restarting the actual desktop app. No invitation is repeated.');

  await go('configuracoes'); await page.locator('#integration-mode').selectOption('whatsapp'); await click('switch-mode'); await page.locator('[data-confirm="ok"]').click();
  await page.waitForFunction(() => document.querySelector('#simulation-banner')?.hidden === true);
  snapshot = await rpc('snapshot'); assert.equal(snapshot.groups.length, 0); assert.equal(snapshot.campaigns.length, 0);
  assert.equal((await rpc('listContacts')).total, 0); assert.equal((await rpc('listHistory')).total, 0);
  await go('painel'); await screenshot('07-retorno-real-sem-mistura.png');
  pass('return-to-real-isolation', 'Leaving simulation removes synthetic groups, contacts, campaigns and results from real screens and selectors.');

  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'ui-results.json'), JSON.stringify({ at: new Date().toISOString(), profile, appPath, tests: results, rendererErrors: errors, whatsapp: 'SIMULATED — no real account or phone delivery verified', windows: 'Electron Linux renderer — physical Windows installation not verified' }, null, 2));
  await close();
})().catch(async error => {
  process.stderr.write(`${error.stack}\n`);
  if (page) await screenshot('failed-ui.png').catch(() => {});
  fs.writeFileSync(path.join(output, 'ui-failure.json'), JSON.stringify({ error: error.stack, results, rendererErrors: errors }, null, 2));
  await close(); process.exitCode = 1;
});
