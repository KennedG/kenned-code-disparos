'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { _electron, expect } = require('@playwright/test');
const { createStore } = require('../src/core/store.cjs');
const { AuthService } = require('../src/core/auth.cjs');
const { OpportunityService } = require('../src/core/opportunity-service.cjs');

// The renderer, backend RPCs, persistent SQLite store and matcher are real.
// WhatsApp is deliberately simulated in an isolated profile; the HTTPS licence
// service is real. This does not establish delivery on a real test handset.
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-opportunities-ui-'));
  const screenshots = process.env.MEGA_SCREENSHOT_DIR || '/workspace/scratch/opportunities-ui/screenshots';
  fs.mkdirSync(screenshots, { recursive: true });
  const credentials = { username: 'oportunidades.ui', password: 'Senha-Kenned-Oportunidades-2026!' };
  const phone = '5562999990001', otherPhone = '5562999990002', groupA = 'sim-01@simulation', groupB = 'sim-02@simulation';
  const prep = await createStore(dir); prep.setSetting('initialized', true); prep.setSetting('integrationMode', 'simulated'); prep.setSetting('unofficialAcknowledged', true);
  prep.upsertGroups([{ id: groupA, name: 'Procura simulada A', simulation: true, authorized: true }, { id: groupB, name: 'Procura simulada B', simulation: true, authorized: true }]);
  const owner = (await new AuthService({ store: prep }).setupOwner({ ...credentials, name: 'Dono de oportunidades de teste', phone })).user;
  const now = Date.now();
  const campaign = prep.saveCampaign({ id: 'gui-opportunity-campaign', name: 'Lista isolada de oportunidades', state: 'draft', ownerId: owner.id, mode: 'repeat', groupIds: [], items: [
    { id: 'gui-item-13', type: 'text', text: '📱 iPhone 13 Pro 256GB Azul\nSeminovo\nBateria: 90%\nR$ 3.000,00\nDisponível', sourceGroupId: groupA, sourceMessageId: 'gui-original-offer-13', sourceOriginalAt: now, ready: true, available: true, availabilityConfirmedAt: now, quantityAvailable: 1 },
    { id: 'gui-item-14', type: 'text', text: '📱 iPhone 14 128GB Roxo\nR$ 2.500,00', unitReference: 'unidade-local-teste-14', sourceOriginalAt: now, ready: true }
  ], schedule: { days: [0, 1, 2, 3, 4, 5, 6], startTime: '00:00', endTime: '00:00' }, intervalMinutes: 10, spacingSeconds: 5, messageSpacingSeconds: 3 });
  const adapter = new EventEmitter(); adapter.status = { state: 'disconnected', mode: 'simulated' }; adapter.configureOpportunityCapture = () => {};
  const service = new OpportunityService({ store: prep, adapter, now: () => now + 100, assertCanCapture: () => true, assertCanOperate: () => true, onLocalAlert: () => {} });
  service.saveConfig({ enabled: true, mode: 'evaluation', monitoredGroupIds: [groupA, groupB], campaignIds: [campaign.id] }, owner.id);
  const incoming = (messageId, text, number = phone, chatId = groupA) => ({ messageId, text, chatId, timestamp: now + 100, originalTimestamp: now + 100, senderId: `${number}@s.whatsapp.net`, senderNumber: number, profileName: `Perfil de teste ${number.slice(-1)}`, identityVerified: true, isGroup: true, simulation: true, mode: 'simulated', type: 'text' });
  const first = service.handleIncoming(incoming('gui-request-first', 'iPhone 13 Pro 256GB quem tem?'));
  service.handleIncoming(incoming('gui-request-duplicate', 'Alguém tem 13 pro 256?', phone, groupB));
  service.handleIncoming(incoming('gui-request-third', '13 PRO 256??', phone, groupB));
  const second = service.handleIncoming(incoming('gui-request-other', 'Alguém tem iPhone 13 Pro 256GB?', otherPhone));
  const pending = service.handleIncoming(incoming('gui-request-review', 'Quem tem iPhone 14 128GB?', '5562999990003'));
  assert(first.opportunity?.id && second.opportunity?.id && pending.opportunity?.id); assert.equal(prep.listOpportunities({ limit: 100 }).total, 3); assert.equal(prep.listOpportunityOrigins(first.opportunity.id).length, 3);
  await service.stop(); prep.close();
  let app, page; const errors = [], dialogs = [];
  const launch = async () => {
    app = await _electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', '--disable-gpu', ...(process.env.MEGA_PROXY_TEST ? ['--proxy-server=http://proxy:8080'] : []), process.env.MEGA_APP_PATH || '.'], env: { ...process.env, MEGA_DATA_DIR: dir }, timeout: 25000 });
    await expect.poll(() => { page = app.windows().find(window => /\/ui\/index\.html$/.test(window.url())); return Boolean(page); }, { timeout: 25000 }).toBe(true);
    page.on('pageerror', error => errors.push(error.message)); page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
    await page.getByRole('heading', { name: 'Bem-vindo de volta' }).waitFor();
    await expect.poll(async () => (await page.evaluate(() => window.mega.call('licenseStatus')))?.allowed, { timeout: 30000 }).toBe(true);
    for (const [name, value] of Object.entries(credentials)) await page.locator(`#auth-form [name="${name}"]`).fill(value);
    await page.locator('#auth-form [type=submit]').click(); await page.getByRole('heading', { name: 'Tudo sob controle' }).waitFor();
  };
  const rpc = async (action, payload) => { const result = await page.evaluate(({ action, payload }) => window.mega.call(action, payload), { action, payload }); assert(!result?.error, `${action}: ${JSON.stringify(result)}`); return result; };
  const nav = async section => { const item = page.locator(`#navigation [data-id="${section}"]`).first(); if (!await item.isVisible()) await page.locator('#navigation [data-action=toggle-more-tools]').click(); await item.click(); };
  const openControls = async () => { const controls = page.locator('.opportunity-controls'); if (await controls.getAttribute('open') === null) await page.locator('.opportunity-controls > summary').click(); };
  try {
    await launch(); await rpc('licenseRefresh'); await rpc('resumeAutomation'); await rpc('connect'); await nav('opportunities');
    await page.getByRole('heading', { name: 'Oportunidades', exact: true }).waitFor(); await expect(page.locator('.opportunity-card')).toHaveCount(3);
    await expect(page.locator('#opportunity-page .subtitle')).toHaveText('Pedidos dos grupos que combinam com seus anúncios.');
    await expect(page.locator('.opportunity-metric')).toHaveCount(4); await expect(page.locator('.opportunity-controls')).not.toHaveAttribute('open', '');
    await expect(page.locator('#opportunity-page')).toContainText('Modo atual: Somente avisar');
    await expect(page.locator(`[data-opportunity-id="${first.opportunity.id}"] .opportunity-request-original`)).toContainText('iPhone 13 Pro 256GB quem tem?');
    await expect(page.locator('#opportunity-page')).toContainText('AVALIAÇÃO — SEM ENVIO AUTOMÁTICO'); await expect(page.locator(`[data-opportunity-id="${first.opportunity.id}"]`)).toContainText('Pedido repetido em 2 grupo');
    assert.equal((await rpc('opportunityDetail', { id: first.opportunity.id })).origins.length, 3);
    await page.screenshot({ path: path.join(screenshots, 'oportunidades-avaliacao.png'), fullPage: true });
    console.log('PASS: Electron OPORTUNIDADES displays actual SQLite grouped requests with three origins in two groups and starts in evaluation mode. WhatsApp fixture is simulated.');

    const taskCounts = async () => Promise.all([first, second, pending].map(async record => (await rpc('opportunityDetail', { id: record.opportunity.id })).tasks.length));
    const beforeEvaluation = await taskCounts();
    await page.locator('[data-action=opportunity-evaluate]').click();
    await expect(page.locator('#toast-region')).toContainText('3 oportunidade(s) reavaliada(s)');
    assert.deepEqual(await taskCounts(), beforeEvaluation, 'Evaluation must not reserve or enqueue any automatic response');
    assert.equal((await rpc('opportunityState')).config.mode, 'evaluation');
    console.log('PASS: actual Reavaliar sem enviar button evaluates all three stored requests, reports the count and creates zero send tasks.');

    await openControls(); await page.locator('#opportunity-group-search').fill('sim-01@'); await page.locator('[data-action=opportunity-clear-groups]').click(); await page.locator('[data-action=opportunity-select-groups]').click();
    await expect(page.locator('#opportunity-group-count')).toHaveText('1 selecionado(s)');
    await page.locator('#opportunity-group-search').fill(''); await page.locator('[data-action=opportunity-select-groups]').click();
    await expect(page.locator('#opportunity-group-count')).toHaveText('15 selecionado(s)');
    await page.locator('[data-action=opportunity-clear-groups]').click(); await page.locator(`[name=monitoredGroupIds][value="${groupA}"]`).check(); await page.locator(`[name=monitoredGroupIds][value="${groupB}"]`).check();
    await page.locator('#opportunity-config-form [name=repeatHours]').fill('36'); await page.locator('#opportunity-config-form [name=contactIntervalMinutes]').fill('45'); await page.locator('#opportunity-config-form [name=maxPerDay]').fill('2'); await page.locator('#opportunity-config-form [name=soundVolume]').fill('33'); await page.locator('#opportunity-config-form [type=submit]').click();
    await expect.poll(async () => (await rpc('opportunityState')).config.repeatHours).toBe(36); const saved = (await rpc('opportunityState')).config; assert.equal(saved.contactIntervalMinutes, 45); assert.equal(saved.maxPerDay, 2); assert.equal(saved.sound.volume, 33); assert.equal(saved.mode, 'evaluation'); assert.deepEqual(saved.monitoredGroupIds.sort(), [groupA, groupB].sort());
    console.log('PASS: group selection applies to displayed results only; deselection, counters, persisted limits and sound volume use backend RPCs.');

    await page.locator(`[data-action=opportunity-origins][data-id="${first.opportunity.id}"]`).click(); await expect(page.locator('#opportunity-detail .opportunity-origin')).toHaveCount(3);
    await expect(page.locator('#opportunity-detail')).toContainText('gui-request-first'); await expect(page.locator('#opportunity-detail')).toContainText('gui-request-duplicate'); await expect(page.locator('#opportunity-detail')).toContainText('gui-request-third');
    await page.locator('[data-opportunity-offer-select]').first().check(); await page.locator('[data-action=opportunity-preview]').click(); await expect(page.locator('#opportunity-preview')).toContainText('R$ 3.000,00');
    assert.equal((await rpc('opportunityDetail', { id: first.opportunity.id })).tasks.length, 0, 'Preview does not create a send');
    await page.locator('[data-action=opportunity-back]').click(); await page.locator('#modal-root [data-action=opportunity-outside]').click(); await expect.poll(async () => (await rpc('opportunityDetail', { id: first.opportunity.id })).opportunity.status).toBe('responded');
    assert(dialogs.some(text => /bloqueio de repetição/.test(text))); await page.locator('[data-action=opportunity-close-modal]').click();
    console.log('PASS: all original messages are accessible, grouped preview creates no task, and Already answered outside persists the repetition block through the actual service.');

    await page.locator(`[data-action=opportunity-origins][data-id="${pending.opportunity.id}"]`).click(); await expect(page.locator('#opportunity-detail')).toContainText('Disponibilidade');
    await page.locator('[data-action=opportunity-availability]').first().click(); await expect(page.locator('#opportunity-availability-form')).toContainText('Referência desta unidade');
    await page.locator('#opportunity-availability-form [name=quantity]').fill('2'); await page.locator('[data-action=opportunity-save-availability]').click(); await expect(page.locator('#opportunity-detail')).toContainText('Quantidade confirmada: 2'); await page.locator('[data-action=opportunity-close-modal]').click();
    await openControls(); await page.locator('#opportunity-config-form [name=operatingMode]').selectOption('manual'); await page.locator('#opportunity-config-form [type=submit]').click(); await expect.poll(async () => (await rpc('opportunityState')).config.mode).toBe('manual');
    await page.locator(`[data-action=opportunity-origins][data-id="${second.opportunity.id}"]`).click(); await page.locator('[data-opportunity-offer-select]').first().check(); await page.locator('[data-action=opportunity-preview]').click(); await expect(page.locator('[data-action=opportunity-confirm-send]')).toBeEnabled(); await page.locator('[data-action=opportunity-confirm-send]').click();
    await expect.poll(async () => (await rpc('opportunityDetail', { id: second.opportunity.id })).tasks.at(-1)?.status, { timeout: 15000 }).toBe('accepted');
    await expect(page.locator('#opportunity-detail')).toContainText('Envio aceito pela integração'); assert.equal((await rpc('opportunityDetail', { id: second.opportunity.id })).tasks.at(-1).recipient, otherPhone); await page.screenshot({ path: path.join(screenshots, 'oportunidades-origens-resposta.png'), fullPage: true }); await page.locator('[data-action=opportunity-close-modal]').click();
    console.log('PASS: manual availability confirmation updates quantity, tokenized preview sends one grouped task to the resolved interested party, and simulated acceptance is not labeled delivered.');

    await rpc('stopAll'); await rpc('saveSettings', { settings: { integrationMode: 'whatsapp', unofficialAcknowledged: true } }); await nav('opportunities'); await expect(page.locator('.opportunity-card')).toHaveCount(0); await expect(page.locator('[data-opportunity-group-row]')).toHaveCount(0); await expect(page.locator('#simulation-banner')).toBeHidden();
    await rpc('saveSettings', { settings: { integrationMode: 'simulated' } }); await nav('opportunities'); await expect(page.locator('.opportunity-card')).toHaveCount(1); await page.locator('[data-action=opportunity-section][data-id=following]').click(); await expect(page.locator('.opportunity-card')).toHaveCount(2);
    await app.close(); app = null; await launch(); await nav('opportunities'); await expect(page.locator('.opportunity-card')).toHaveCount(1); await page.locator('[data-action=opportunity-section][data-id=following]').click(); await expect(page.locator('.opportunity-card')).toHaveCount(2); const persisted = (await rpc('opportunityState')).config; assert.equal(persisted.repeatHours, 36); assert.equal(persisted.sound.volume, 33); assert.equal((await rpc('opportunityDetail', { id: second.opportunity.id })).tasks.length, 1); assert.equal((await rpc('opportunityDetail', { id: first.opportunity.id })).opportunity.status, 'responded');
    console.log('PASS: real mode excludes simulation storage/groups/results; configuration, outside-answer blocking, source origins and one accepted send survive Electron close/reopen.');

    const viewerRole = await rpc('saveRole', { role: { name: 'Consulta isolada de oportunidades', campaignScope: 'all', permissions: ['opportunity.view'] } });
    const viewer = await rpc('createUser', { user: { name: 'Revisor de teste', username: 'revisor.oportunidades', password: 'Senha-Revisor-Oportunidades-2026!', roleId: viewerRole.id, campaignScope: 'all', requirePasswordChange: false } });
    const switchLogin = async (username, password) => {
      await page.locator('[data-action=logout]').click(); await page.getByRole('heading', { name: 'Bem-vindo de volta' }).waitFor();
      await page.locator('#auth-form [name=username]').fill(username); await page.locator('#auth-form [name=password]').fill(password); await page.locator('#auth-form [type=submit]').click(); await page.getByRole('heading', { name: 'Tudo sob controle' }).waitFor();
    };
    await switchLogin(viewer.username, 'Senha-Revisor-Oportunidades-2026!'); await nav('opportunities'); await expect(page.locator('.opportunity-card')).toHaveCount(1); await page.locator('[data-action=opportunity-section][data-id=following]').click(); await expect(page.locator('.opportunity-card')).toHaveCount(2);
    await expect(page.locator('[data-action=opportunity-evaluate]')).toBeDisabled(); await expect(page.locator('[data-action=opportunity-outside]')).toHaveCount(0); await expect(page.locator('[data-action=opportunity-mute]')).toHaveCount(0);
    await page.locator('[data-action=opportunity-origins]').first().click(); await expect(page.locator('[data-action=opportunity-preview]')).toHaveCount(0); await expect(page.locator('[data-action=opportunity-availability]')).toHaveCount(0); await page.locator('[data-action=opportunity-close-modal]').click();
    const deniedSend = await page.evaluate(id => window.mega.call('opportunitySendManual', { id, offerIds: [], confirm: true }), first.opportunity.id); assert(deniedSend.error, 'View-only actor cannot bypass renderer and send through RPC');
    await switchLogin(credentials.username, credentials.password); await rpc('updateUser', { id: viewer.id, campaignScope: 'own' });
    await switchLogin(viewer.username, 'Senha-Revisor-Oportunidades-2026!'); await expect(page.locator('#navigation [data-id=opportunities]')).toHaveCount(0);
    const deniedScope = await page.evaluate(() => window.mega.call('opportunityState')); assert(deniedScope.error, 'Own-scope actor cannot read cross-campaign opportunities through RPC');
    assert.deepEqual(errors, []); console.log('PASS: view-only user sees no response or availability actions, backend refuses direct send, and own-scope user cannot see or read the global module. No real WhatsApp receipt or physical Windows execution was verified.');
  } catch (error) { if (page) await page.screenshot({ path: path.join(screenshots, 'failed-opportunities.png'), fullPage: true }).catch(() => {}); throw error; }
  finally { if (app) await app.close(); if (process.env.MEGA_KEEP_TEST_DATA) console.log('Isolated test profile:', dir); else fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
