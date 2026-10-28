'use strict';

// Actual Electron renderer + worker + SQLite. The adapter is explicitly the
// isolated simulation; no real WhatsApp account is contacted by this script.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron, expect } = require('@playwright/test');
const { createStore } = require('../src/core/store.cjs');
const { MediaManager } = require('../src/core/media.cjs');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-230-ui-'));
  const shots = process.env.MEGA_SCREENSHOT_DIR || '/workspace/scratch/kenned-230-ui'; fs.mkdirSync(shots, { recursive: true });
  const prep = await createStore(dir); prep.setSetting('integrationMode', 'simulated');
  const manager = new MediaManager(prep), image = await manager.importFile(path.resolve('assets/icon.png'));
  const free1 = await manager.importBuffer(Buffer.from('Primeiro arquivo independente'), { name: 'livre-a.txt' });
  const free2 = await manager.importBuffer(Buffer.from('Segundo arquivo independente'), { name: 'livre-b.txt' }); prep.close();
  let app, page; const errors = [];
  const credentials = { username: 'dono-ui230', password: 'Senha-Kenned-Interface-230!' };
  const rpc = async (action, payload) => { const result = await page.evaluate(({ action, payload }) => window.mega.call(action, payload), { action, payload }); assert(!result?.error, action + ': ' + JSON.stringify(result)); return result; };
  const snap = () => rpc('snapshot');
  const nav = async id => { await page.locator('#navigation [data-id="' + id + '"]').click(); };
  const tab = async id => { await page.locator('[data-action=buscas-tab][data-id="' + id + '"]').click(); };
  const launch = async () => {
    app = await _electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', '--disable-gpu', process.env.MEGA_APP_PATH || '.'], env: { ...process.env, MEGA_DATA_DIR: dir }, timeout: 20000 });
    await expect.poll(() => { page = app.windows().find(w => /\/ui\/index\.html$/.test(w.url())); return !!page; }, { timeout: 20000 }).toBe(true);
    page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  };
  try {
    await launch(); await page.getByRole('heading', { name: 'Cadastre o dono' }).waitFor();
    for (const [name, value] of Object.entries({ name: 'Dono interface 2.3', ...credentials, confirmPassword: credentials.password, phone: '5562999990001' })) await page.locator('#auth-form [name="' + name + '"]').fill(value);
    await page.locator('#auth-form [type=submit]').click(); await page.getByRole('button', { name: 'Guardei os códigos' }).click(); await page.getByRole('heading', { name: 'Tudo sob controle' }).waitFor();
    assert.equal(await page.title(), 'Kenned Code Disparos'); const initial = await snap(); assert.equal(initial.groups.length, 15); assert.equal(initial.media.length, 3);

    await nav('buscas'); await tab('setup'); await page.locator('#buscas-settings-form [name=enabled]').check();
    for (const name of ['monitoredGroupIds', 'commandGroupIds', 'filterGroupIds', 'blockedGroupIds']) {
      const selector = page.locator('[data-group-selector="' + name + '"]');
      await selector.locator('[data-action=buscas-select-groups]').click(); await expect(selector.locator('input[type=checkbox]:checked')).toHaveCount(15); await expect(selector.locator('[data-group-count]')).toContainText('15 de 15');
      await selector.locator('[data-action=buscas-clear-groups]').click(); await expect(selector.locator('input[type=checkbox]:checked')).toHaveCount(0);
    }
    const monitored = page.locator('[data-group-selector=monitoredGroupIds]');
    await monitored.locator('[data-group-search]').fill(initial.groups[0].name); await monitored.locator('[data-action=buscas-select-groups]').click();
    await expect(monitored.locator('input[type=checkbox]:checked')).toHaveCount(1); await expect(monitored.locator('[data-group-count]')).toContainText('1 exibidos');
    await monitored.locator('[data-group-search]').fill(''); await monitored.locator('[data-action=buscas-select-groups]').click(); await page.locator('#buscas-settings-form [type=submit]').click();
    await expect.poll(async () => (await rpc('searchesState')).settings.monitoredGroupIds.length).toBe(15);
    console.log('PASS: all BUSCAS setup selectors select/clear all, count selection and select only displayed search matches.');

    const at = Date.now(), g = initial.groups[0].id;
    const fixtureOffer = (messageId, senderNumber, timestamp, text) => rpc('testSearchSimulation', { kind: 'offer', messageId, senderNumber, timestamp, text, groupId: g });
    await fixtureOffer('UI-CHEAP', '5562999990101', at - 90 * 60000, 'iPhone 15 Pro Max 256GB Azul seminovo R$ 3.850,00');
    await fixtureOffer('UI-EXPENSIVE', '5562999990102', at - 10 * 60000, 'iPhone 15 Pro Max 256GB Azul seminovo R$ 4.100,00');
    await fixtureOffer('UI-OLD', '5562999990103', at - 150 * 60000, 'iPhone 15 Pro Max 256GB Azul seminovo R$ 2.000,00');
    await fixtureOffer('UI-FINANCED', '5562999990104', at - 10 * 60000, 'iPhone 15 Pro Max 256GB Azul seminovo entrada R$ 500 + 10x R$ 400');
    await tab('query');
    const qgroups = page.locator('[data-group-selector=queryFilterGroupIds]'); await qgroups.locator('[data-action=buscas-select-groups]').click(); await expect(qgroups.locator('input:checked')).toHaveCount(15); await qgroups.locator('[data-action=buscas-clear-groups]').click(); await expect(qgroups.locator('input:checked')).toHaveCount(0);
    await page.locator('#buscas-query-form [name=query]').fill('iPhone 15 Pro Max 256GB'); await page.locator('#buscas-query-form [type=submit]').click();
    await expect(page.locator('#buscas-results .buscas-offer')).toHaveCount(2); assert.match(await page.locator('#buscas-results .buscas-price').first().innerText(), /3\.850,00/);
    await page.locator('#buscas-query-form [name=sort]').selectOption('cashDescending'); await page.locator('#buscas-query-form [name=maxAgeValue]').fill('180'); await page.locator('#buscas-query-form [name=maxAgeUnit]').selectOption('minutes'); await page.locator('#buscas-query-form [type=submit]').click();
    await expect(page.locator('#buscas-results .buscas-offer')).toHaveCount(3); assert.match(await page.locator('#buscas-results .buscas-price').first().innerText(), /4\.100,00/);
    await expect.poll(async () => (await rpc('searchesState')).settings.maxAgeUnit).toBe('minutes'); await page.screenshot({ path: path.join(shots, 'buscas-filtros-230.png'), fullPage: true });
    console.log('PASS: UI two-hour publication window, cash ranking, financing exclusion, configurable minutes and saved sorting.');

    await nav('library'); await page.locator('[data-action=library-new-template]').click();
    await page.locator('#library-template-form [name=name]').fill('Modelo da loja 2.3'); const originalText = '*Oferta do dia* 😀\n_iPhone 15 Pro Max_\nhttps://loja.exemplo/oferta';
    await page.locator('[data-library-text]').fill(originalText); await page.locator('[data-action=library-choose-media]').click(); await page.locator('#library-media-choice').selectOption(image.id); await page.locator('[data-action=library-attach-media]').click(); await page.locator('[data-library-caption]').fill('*Legenda da foto*\nConferir estoque'); await page.locator('[data-action=library-save-template]').click();
    await page.locator('.modal').waitFor({ state: 'hidden' }); await expect.poll(async () => (await snap()).templates.length).toBe(1); let model = (await snap()).templates[0]; assert.equal(model.items[0].text, originalText); assert.equal(model.items[1].mediaId, image.id);
    await page.locator('[data-action=library-edit-template][data-id="' + model.id + '"]').click(); await page.locator('#library-template-form [name=name]').fill('Modelo revisado 2.3'); await page.locator('[data-action=library-save-template]').click(); await page.locator('.modal').waitFor({ state: 'hidden' });
    await page.locator('[data-action=library-duplicate-template][data-id="' + model.id + '"]').click(); await expect.poll(async () => (await snap()).templates.length).toBe(2);
    await page.locator('[data-action=library-use-template][data-id="' + model.id + '"]').click(); await page.locator('#campaign-name').fill('Campanha com modelo 2.3'); await page.locator('[data-select-group]').first().check(); await page.locator('[data-action=save-campaign]').click(); await page.locator('.modal').waitFor({ state: 'hidden' });
    const campaign = (await snap()).campaigns.find(c => c.name === 'Campanha com modelo 2.3'); assert.equal(campaign.items[0].text, originalText); assert.equal(campaign.items[1].mediaId, image.id); assert.equal(campaign.state, 'draft');
    await nav('library'); await page.locator('[data-action=library-tab][data-id=media]').click(); await page.locator('[data-action=library-delete-media][data-id="' + image.id + '"]').click();
    await expect(page.locator('.modal')).toContainText('Modelo revisado 2.3'); await expect(page.locator('.modal')).toContainText('Campanha com modelo 2.3'); await expect(page.locator('[data-action=library-confirm-delete-media]')).toHaveCount(0); await page.locator('[data-action=library-close]').click();
    await page.locator('[data-action=library-select-all]').click(); await expect(page.locator('#library-selected-count')).toContainText('3 arquivo'); await page.locator('[data-action=library-deselect-all]').click(); await expect(page.locator('#library-selected-count')).toContainText('0 arquivo');
    for (const m of [free1, free2]) await page.locator('[data-library-media="' + m.id + '"]').check(); await page.locator('[data-action=library-delete-selected]').click(); await page.locator('#library-delete-form [name=confirmation]').fill('EXCLUIR'); await page.locator('[data-action=library-confirm-delete-media]').click(); await page.locator('.modal').waitFor({ state: 'hidden' }); await expect.poll(async () => (await snap()).media.length).toBe(1); await expect(page.locator('[data-library-media]')).toHaveCount(1);
    console.log('PASS: create/edit/duplicate/apply model with media; linked file protected with usage details; select-all, clear and typed batch deletion update the library.');

    await nav('reminders'); await page.locator('[data-action=reminders-new]').click(); await page.locator('#reminders-form [name=title]').fill('Organizar estoque 2.3'); await page.locator('#reminders-form [name=description]').fill('Conferir prateleira da loja'); await page.locator('#reminders-form [name=time]').fill('09:30'); await page.locator('#reminders-form [name=recipientId]').selectOption('user:' + initial.auth.user.id); await page.locator('#reminders-form [name=enabled]').check(); await page.locator('[data-action=reminders-save]').click(); await page.locator('.modal').waitFor({ state: 'hidden' });
    const reminder = (await rpc('listReminders')).items[0]; assert.equal(reminder.timezone, 'America/Sao_Paulo'); assert.ok(reminder.nextDueAt);
    await rpc('testSearchSimulation', { kind: 'disconnect' }); await page.locator('[data-action=reminders-test][data-id="' + reminder.id + '"]').click();
    await expect.poll(async () => (await rpc('listReminders')).items[0].lastDelivery?.status).toBe('pending'); await expect(page.locator('#reminders-page')).toContainText('Pendente'); await rpc('connect');
    await expect.poll(async () => (await rpc('listReminders')).items[0].lastDelivery?.status, { timeout: 15000 }).toBe('confirmed'); await expect(page.locator('#reminders-page')).toContainText('Enviado — aceito pelo servidor');
    await page.locator('[data-action=reminders-pause][data-id="' + reminder.id + '"]').click(); await expect.poll(async () => (await rpc('listReminders')).items[0].state).toBe('paused');
    await page.screenshot({ path: path.join(shots, 'lembretes-230.png'), fullPage: true });
    console.log('PASS: reminder GUI save, timezone/default next occurrence, offline pending test, reconnect server confirmation and pause.');

    await rpc('testSearchSimulation', { kind: 'command', text: 'Olá, quero saber sobre aparelhos.' }); await rpc('testSearchSimulation', { kind: 'command', text: 'Segunda mensagem.' });
    await nav('contacts'); await expect(page.locator('.contact-intake-form')).toHaveCount(1);
    // A second explicitly bound identity supplies a separate pending, allowing
    // the actual dismiss button to be tested without inventing group contacts.
    await rpc('updateUser', { id: initial.auth.user.id, phone: '5562999990002' });
    await rpc('testSearchSimulation', { kind: 'command', text: 'Contato para dispensar na validação.' });
    await rpc('updateUser', { id: initial.auth.user.id, phone: '5562999990001' });
    const pendingList = await rpc('listPendingContacts'); assert.equal(pendingList.total, 2);
    const extraPending = pendingList.items.find(p => p.phone === '5562999990002');
    await nav('dashboard'); await nav('contacts'); await expect(page.locator('.contact-intake-form')).toHaveCount(2);
    await page.locator('[data-action=contact-intake-dismiss][data-id="' + extraPending.id + '"]').click();
    await expect.poll(async () => (await rpc('listPendingContacts')).total).toBe(1);
    await page.locator('.contact-intake-form [name=contactIntakeName]').fill('Cliente da validação'); await page.locator('.contact-intake-form [name=contactIntakeCategories][value="Cliente Nerópolis"]').check(); await page.locator('.contact-intake-form [type=submit]').click();
    await expect.poll(async () => (await rpc('listPendingContacts')).total).toBe(0); const savedContact = (await snap()).contacts[0]; assert.equal(savedContact.name, 'Cliente da validação'); assert.equal(savedContact.category, 'Cliente Nerópolis'); assert.equal(savedContact.addressBookSupported, false); await expect(page.locator('#main')).toContainText('Salvo no sistema');
    console.log('PASS: repeated verified private contact produces one pending; editable name/classification saved locally with truthful agenda limitation.');

    await nav('alerts'); await page.locator('[data-action=test-alert]').click();
    await expect.poll(async () => (await rpc('alertsPage', { limit: 100 })).items.filter(a => a.code === 'ALERT_TEST').length).toBe(1); await expect.poll(async () => (await rpc('alertsPage', { limit: 100 })).items.find(a => a.code === 'ALERT_TEST')?.status, { timeout: 15000 }).toBe('confirmed');
    for (const text of ['!mega ajuda', '!mega menu', '!mega status']) { const reply = await rpc('testSimulation', { text }); assert.ok(reply.replies.length); }
    const stop = await rpc('testSimulation', { text: '!mega parar tudo' }); assert.match(stop.text, /bloqueadas/); assert.equal((await snap()).automation.stopped, true); assert.equal((await rpc('listReminders')).items[0].state, 'paused');
    const statusStopped = await rpc('testSimulation', { text: '!mega status' }); assert.match(statusStopped.text, /INTERROMPIDA/); await rpc('testSimulation', { text: '!mega retomar sistema' }); assert.equal((await snap()).automation.stopped, false);
    console.log('PASS: alert test button and all private admin commands; persistent stop gate remains controllable and explicitly resumes.');

    await app.close(); app = null; await launch(); await page.getByRole('heading', { name: 'Bem-vindo de volta' }).waitFor(); for (const [name, value] of Object.entries(credentials)) await page.locator('#auth-form [name="' + name + '"]').fill(value); await page.locator('#auth-form [type=submit]').click(); await page.getByRole('heading', { name: 'Tudo sob controle' }).waitFor();
    const restored = await snap(); assert.equal(restored.templates.length, 2); assert.equal(restored.media.length, 1); assert.equal(restored.contacts.length, 1); assert.equal(restored.reminders.items[0].title, reminder.title); assert.equal(restored.buscas.settings.sort, 'cashDescending'); assert.equal(restored.buscas.settings.maxAgeValue, 180); assert.equal(restored.buscas.settings.maxAgeUnit, 'minutes');
    await nav('library'); await page.locator('[data-action=library-tab][data-id=templates]').click(); await expect(page.locator('#library-page')).toContainText('Modelo revisado 2.3'); await page.screenshot({ path: path.join(shots, 'modelos-persistidos-230.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log('PASS: Electron close/reopen preserves models, media, contacts, reminder and BUSCAS preferences. No live WhatsApp receipt or physical Windows test was performed.');
  } finally { if (app) await app.close(); if (process.env.MEGA_KEEP_TEST_DATA) console.log('Test data:', dir); else fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
