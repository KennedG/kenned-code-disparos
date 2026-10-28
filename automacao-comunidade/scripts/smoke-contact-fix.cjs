'use strict';

// Real Electron + preload + SQLite worker. Only isolated local fixtures are
// created; no WhatsApp session is connected and no invitation is submitted.
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { _electron: electron } = require('@playwright/test');
const { createStore } = require('../src/core/store.cjs');

const root = path.resolve(__dirname, '..');
const appPath = process.env.COMMUNITY_APP_PATH || root;
const output = path.resolve(process.env.COMMUNITY_CONTACT_FIX_OUTPUT || path.join(root, '..', 'scratch', 'community-contact-fix', `evidence-${Date.now()}`));
const profile = path.resolve(process.env.COMMUNITY_CONTACT_FIX_PROFILE || path.join(root, '..', 'scratch', 'community-contact-fix', `profile-${Date.now()}`));
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(profile, { recursive: true });
if (fs.existsSync(path.join(profile, 'automacao-comunidade.sqlite'))) throw new Error('Use a fresh isolated test profile; an existing database must not be overwritten.');
const store = createStore(profile), groupId = 'contact-fix-test@g.us';
store.save('groups', { id: groupId, name: 'TESTE LOCAL — SEM CONEXÃO' });
const fixtures = [
  ['eligible-one', '15555550101', 'Apto um'],
  ['eligible-two', '15555550102', 'Apto dois'],
  ['blocked', '15555550103', 'Bloqueado', { blocked: true }],
  ['optout', '15555550104', 'Não deseja receber', { optOut: true }],
  ['muted', '15555550105', 'Silenciado', { muted: true }],
  ['self', '15555550106', 'Conta conectada', { self: true }],
  ['ambiguous', null, 'Identidade ambígua', { ambiguous: true }],
  ['lid', null, 'Somente LID'],
];
for (const [id, phone, name, flags = {}] of fixtures) {
  const externalId = phone ? `${phone}@s.whatsapp.net` : `${id}-identity@lid`;
  store.save('contacts', { id, phone, name, displayName: `Perfil ${name}`, externalId, identifiers: [externalId], groupIds: [groupId], authorized: false, firstSeenAt: Date.now(), ...flags });
}
store.close();
const results = [], errors = [];
let app, page;
const rpc = (action, payload = {}) => page.evaluate(({ action, payload }) => window.community.call(action, payload), { action, payload });
const click = (action, within = page) => within.locator(`[data-action="${action}"]`).first().click();
const pass = (name, detail) => { results.push({ name, passed: true, detail }); process.stdout.write(`PASS ${name}: ${detail}\n`); };
async function close() { if (!app) return; await app.evaluate(async ({ app }) => app.quit()); await app.close().catch(() => {}); app = null; }

(async () => {
  app = await electron.launch({
    executablePath: process.env.COMMUNITY_ELECTRON_PATH || require('electron'),
    args: ['--no-sandbox', '--disable-dev-shm-usage', appPath],
    env: { ...process.env, COMMUNITY_TEST_MODE: '1', COMMUNITY_TEST_PROFILE: profile, COMMUNITY_TEST_HIDE: '0' }, timeout: 30000,
  });
  page = await app.firstWindow(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => document.querySelector('#app')?.getAttribute('aria-busy') === 'false');
  await page.locator('#navigation a[href="#contatos"]').click();
  await page.locator('table tbody tr').first().waitFor();
  const before = await rpc('listContacts', { limit: 200 });
  assert.equal(before.total, 8);
  assert.equal(before.items.filter(contact => contact.authorizationEligible).length, 2);
  assert.equal(await page.locator('[data-authorization-code]').count(), 6);
  assert((await page.locator('#main').textContent()).includes('LID'));
  pass('specific-contact-reasons', 'Backend eligibility and reasons are displayed separately for missing phone, LID, ambiguity, blocked, opt-out, muted and self contacts.');

  await click('select-filtered-contacts');
  assert((await page.locator('#contact-selection-count').textContent()).includes('8 selecionado(s) · 2 apto(s)'));
  await click('authorize-selected');
  assert.equal(await page.locator('#bulk-consent').count(), 1);
  assert((await page.locator('#modal-content').textContent()).includes('6 contato(s) ficarão fora'));
  assert.equal(await page.locator('.authorization-exclusions .inline-errors p').count(), 6);
  await page.screenshot({ path: path.join(output, '01-previa-apenas-contatos-aptos.png'), fullPage: true });
  pass('mixed-bulk-preview', 'All eight contacts remain selectable for management; the consent preview authorizes only two eligible identities and explicitly lists the other six exclusions.');

  // Simulate a restriction changing after the preview. The backend must recheck
  // and the UI must report a skipped recipient, not claim all were authorized.
  await rpc('updateContact', { id: 'eligible-two', changes: { blocked: true } });
  await page.locator('#bulk-consent').fill('Autorização explícita de teste local, sem envio de convites.');
  await page.locator('#authorize-form input[name="confirmed"]').check();
  await click('confirm-authorize');
  await page.locator('#modal-content h2').filter({ hasText: 'Resultado da autorização' }).waitFor();
  assert((await page.locator('#modal-content').textContent()).includes('1 autorização(ões) persistida(s).'));
  assert((await page.locator('#modal-content').textContent()).includes('7 contato(s) não foram autorizados.'));
  assert.equal(await page.locator('#modal-content .inline-errors p').count(), 7);
  assert((await page.locator('#modal-content .inline-errors').textContent()).includes('Apto dois'));
  assert(!(await page.locator('#modal-content').textContent()).includes('Error invoking remote method'));
  const after = await rpc('listContacts', { limit: 200 });
  assert.equal(after.items.filter(contact => contact.authorized).length, 1);
  assert.equal(after.items.find(contact => contact.id === 'eligible-one').authorized, true);
  assert(after.items.filter(contact => contact.id !== 'eligible-one').every(contact => !contact.authorized));
  await page.screenshot({ path: path.join(output, '02-resultado-parcial-explicito.png'), fullPage: true });
  await click('close-modal');
  pass('fresh-backend-recheck-and-result', 'A contact blocked after the consent preview is skipped, the eligible authorization persists, and the UI reports one saved and seven excluded without suggesting that all succeeded.');

  await page.locator('[data-contact-select="lid"]').check();
  assert.equal(await page.locator('[data-action="authorize-selected"]').isDisabled(), true);
  assert((await page.locator('#contact-selection-count').textContent()).includes('0 apto(s)'));
  await click('clear-contact-selection');
  pass('ineligible-only-selection-disabled', 'A selection containing only a LID without a reliable phone cannot open the authorization action.');

  for (const id of ['lid', 'blocked', 'muted', 'self']) {
    await page.locator(`[data-action="edit-contact"][data-id="${id}"]`).click();
    assert.equal(await page.locator('#contact-authorized').isDisabled(), true);
    await page.locator('#contact-name').fill(`Nome revisado ${id}`);
    await click('save-contact');
    await page.waitForFunction(() => !document.querySelector('#modal').open);
    const current = (await rpc('listContacts', { limit: 200 })).items.find(contact => contact.id === id);
    assert.equal(current.name, `Nome revisado ${id}`);
    assert.equal(current.authorized, false);
    if (id === 'lid') assert.equal(current.phone, null);
  }
  pass('restricted-name-only-edit', 'LID, blocked, muted and self contacts can have their saved name edited without attempting authorization, altering their identity or inventing a phone.');

  const authorizedAt = (await rpc('listContacts', { limit: 200 })).items.find(contact => contact.id === 'eligible-one').authorizedAt;
  await page.locator('[data-action="edit-contact"][data-id="eligible-one"]').click();
  await page.locator('#contact-name').fill('Apto um nome revisado');
  await click('save-contact');
  await page.waitForFunction(() => !document.querySelector('#modal').open);
  const edited = (await rpc('listContacts', { limit: 200 })).items.find(contact => contact.id === 'eligible-one');
  assert.equal(edited.authorized, true); assert.equal(edited.authorizedAt, authorizedAt);
  pass('authorized-name-edit-preserves-consent', 'A name-only edit preserves the original consent and authorization timestamp rather than reauthorizing the contact.');

  const snapshot = await rpc('snapshot');
  assert.equal(snapshot.connection.ready, false);
  assert.equal((await rpc('listHistory')).total, 0);
  assert.equal(snapshot.metrics.pending, 0); assert.equal(snapshot.metrics.processing, 0);
  assert.deepEqual(errors, []);
  pass('no-sends-or-renderer-errors', 'No account was connected, no invitation or queue entry was created, and Electron reported no renderer error.');
  fs.writeFileSync(path.join(output, 'contact-fix-ui-results.json'), JSON.stringify({ at: new Date().toISOString(), appPath, profile, tests: results, rendererErrors: errors, whatsapp: 'NOT CONNECTED — isolated local fixtures, no real delivery claimed', windows: 'Electron Linux renderer — physical Windows installation remains unverified' }, null, 2));
  await close();
})().catch(async error => {
  process.stderr.write(`${error.stack}\n`);
  if (page) await page.screenshot({ path: path.join(output, 'failed-contact-fix.png'), fullPage: true }).catch(() => {});
  fs.writeFileSync(path.join(output, 'contact-fix-ui-failure.json'), JSON.stringify({ error: error.stack, results, rendererErrors: errors }, null, 2));
  await close(); process.exitCode = 1;
});
