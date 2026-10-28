'use strict';

// Exercises the shipped Electron interface and the worker backend with the
// isolated simulation transport. It never connects an account or sends WhatsApp.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { _electron, expect } = require('@playwright/test');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-fixes-ui-'));
  const shots = process.env.MEGA_SCREENSHOT_DIR || '/workspace/scratch/kenned-ui-fixes';
  fs.mkdirSync(shots, { recursive: true });
  const errors = [];
  let app, page;
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', '--disable-gpu', ...(process.env.MEGA_PROXY_TEST ? ['--proxy-server=http://proxy:8080'] : []), process.env.MEGA_APP_PATH || '.'], env: { ...process.env, MEGA_DATA_DIR: dir }, timeout: 20000 });
    await expect.poll(() => { page = app.windows().find(w => /\/ui\/index\.html$/.test(w.url())); return !!page; }, { timeout: 20000 }).toBe(true);
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    const rpc = async (action, payload) => {
      const response = await page.evaluate(({ action, payload }) => window.mega.call(action, payload), { action, payload });
      assert(!response?.error, action + ': ' + JSON.stringify(response));
      return response;
    };
    const snapshot = () => rpc('snapshot');
    const navigate = async id => { await page.locator('#navigation [data-id="' + id + '"]').click(); };
    const tabs = async id => { await page.locator('[data-action=buscas-tab][data-id="' + id + '"]').click(); };
    const saveBuscas = async () => { await page.locator('#buscas-settings-form [type=submit]').click(); await expect.poll(async () => (await rpc('searchesState')).settings.enabled).toBe(true); };
    await page.getByRole('heading', { name: 'Cadastre o dono' }).waitFor();await expect.poll(async()=>{const state=await page.evaluate(()=>window.mega.call('licenseStatus'));return state?.allowed===true;},{timeout:30000}).toBe(true);
    await expect(page.locator('#auth-root')).toContainText('KENNED CODE DISPAROS');
    assert.equal(await page.title(), 'Kenned Code Disparos');
    assert.equal(await app.evaluate(({ app }) => app.getName()), 'Kenned Code Disparos');
    for (const [key, value] of Object.entries({ name: 'Dono teste Kenned', username: 'dono.kenned', password: 'SenhaKenned-Teste-2026', confirmPassword: 'SenhaKenned-Teste-2026', phone: '5511999999999' })) await page.locator('#auth-form [name=' + key + ']').fill(value);
    await page.locator('#auth-form [type=submit]').click();
    await page.getByRole('button', { name: 'Guardei os códigos' }).click();
    await page.getByRole('heading', { name: 'Tudo sob controle' }).waitFor();await page.evaluate(async()=>{let r=await window.mega.call('licenseRefresh');if(r?.error||r?.allowed!==true)throw new Error(r?.error||'Real licensing service did not authorize test device');r=await window.mega.call('resumeAutomation');if(r?.error)throw new Error(r.error);});
    await expect(page.locator('#simulation-banner')).toBeVisible();
    await expect(page.locator('#simulation-banner')).toContainText('SIMULAÇÃO — DADOS FICTÍCIOS');
    await expect.poll(async () => (await snapshot()).connection.state).toBe('connected');
    const initial = await snapshot();
    assert.equal(initial.groups.length, 15); assert(initial.groups.every(g => g.simulation));
    assert.equal(initial.campaigns[0].state, 'draft');
    const groupId = initial.groups[0].id;
    const originalCampaignIds = initial.campaigns.map(c => c.id);

    await navigate('buscas'); await tabs('setup');
    await page.locator('#buscas-settings-form [name=enabled]').check();
    await page.locator('#buscas-settings-form [name=selfCommandsEnabled]').check();
    await page.locator('#buscas-settings-form [name=monitoredGroupIds]').first().check();
    await page.locator('#buscas-settings-form [name=commandGroupIds]').first().check();
    await saveBuscas();
    const self = await rpc('testSearchSimulation', { kind: 'command', fromMe: true, text: '!busca iPhone 18 Pro Max Silver' });
    assert.equal(self.replies.length, 1, 'Manual own-account command must be handled once');
    assert.equal(self.replies[0].privateNumber, '5511999999999');
    assert.equal(self.replies[0].status, 'confirmed');
    assert.match(self.replies[0].text, /Não foram encontradas ofertas compatíveis/);
    assert.notEqual(self.replies[0].targetId, groupId);
    console.log('PASS: branding, banner and own-account search with no results and one private reply.');

    await navigate('alerts');
    await page.locator('[data-action=new-recipient]').click();
    await page.locator('#recipient-form [name=name]').fill('Responsável de validação');
    await page.locator('#recipient-form [name=phone]').fill('5511888881234');
    await page.locator('[data-action=save-recipient]').click();
    await page.locator('.modal').waitFor({ state: 'hidden' });
    const recipient = (await rpc('listAlertRecipients')).find(r => r.phone === '5511888881234');
    assert(recipient?.enabled);
    await navigate('buscas'); await tabs('setup');
    await page.locator('#buscas-settings-form [name=recipientMode]').selectOption('responsibles');
    await page.locator('#buscas-settings-form [name=responsibleRecipientIds][value="' + recipient.id + '"]').check();
    await saveBuscas();
    await expect.poll(async () => (await rpc('searchesState')).settings.recipientMode).toBe('responsibles');
    const configured = await rpc('testSearchSimulation', { kind: 'command', fromMe: true, text: '!busca iPhone 18 Pro Max Silver' });
    assert.equal(configured.replies.length, 1);
    assert.equal(configured.replies[0].privateNumber, recipient.phone);
    assert.equal(configured.replies[0].status, 'confirmed');
    console.log('PASS: saved responsible recipient used for private command response.');

    await rpc('testSearchSimulation', { kind: 'disconnect' });
    await expect.poll(async () => (await snapshot()).notifications.some(n => n.event === 'disconnect')).toBe(true);
    const offlineAlerts = await rpc('alertsPage', { limit: 100 });
    assert(offlineAlerts.items.some(a => a.status === 'pending' && a.number === recipient.phone));
    assert(offlineAlerts.items.some(a => a.status === 'pending' && a.number === '5511999999999'));
    const originalFailureTime = offlineAlerts.items[0].originalAt;
    await tabs('destinations');
    await page.locator('[data-action=buscas-test-recipient][data-id="' + recipient.id + '"]').click();
    await expect.poll(async () => (await rpc('searchRecipientStatus')).recipients.find(r => r.id === recipient.id)?.status).toBe('pending');
    await expect(page.locator('#buscas-destinations').getByText('Pendente', { exact: true }).first()).toBeVisible();
    await navigate('alerts'); await page.locator('[data-action=test-alert]').click();
    await expect.poll(async () => (await rpc('alertsPage', { limit: 100 })).items.filter(a => a.code === 'ALERT_TEST').length).toBe(2);
    const alertsBeforeReconnect = await rpc('alertsPage', { limit: 100 });
    assert(alertsBeforeReconnect.items.every(a => a.status === 'pending'));
    assert((await snapshot()).notifications.some(n => n.event === 'critical' && n.code === 'ALERT_TEST'));
    await page.screenshot({ path: path.join(shots, 'alertas-pendentes.png'), fullPage: true });
    await rpc('connect');
    await expect.poll(async () => (await rpc('alertsPage', { limit: 100 })).items.filter(a => a.status !== 'confirmed').length, { timeout: 45000 }).toBe(0);
    await expect.poll(async () => (await rpc('searchRecipientStatus')).recipients.find(r => r.id === recipient.id)?.status, { timeout: 15000 }).toBe('confirmed');
    const reconnectedAlerts = await rpc('alertsPage', { limit: 100 });
    assert(reconnectedAlerts.items.some(a => a.originalAt === originalFailureTime && a.confirmationScope === 'simulation-only'));
    await navigate('buscas'); await tabs('destinations');
    await expect(page.locator('#buscas-destinations').getByText('Enviado — aceito pela integração', { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: path.join(shots, 'destinatarios-confirmados.png'), fullPage: true });
    console.log('PASS: disconnect occurrence, per-recipient UI test pending, general UI alert test, reconnect confirmation and original failure time. Native Windows notification hardware is not tested here.');

    await navigate('settings');
    await page.locator('#integration-mode').selectOption('whatsapp');
    await page.locator('[name=unofficialAcknowledged]').check();
    await page.locator('#settings-form [type=submit]').click();
    await expect.poll(async () => (await snapshot()).storageMode, { timeout: 15000 }).toBe('whatsapp');
    await expect(page.locator('#simulation-banner')).toBeHidden();
    const real = await snapshot();
    assert.equal(real.connection.state, 'disconnected');
    for (const key of ['groups', 'campaigns', 'contacts', 'media', 'templates', 'alertRecipients', 'history', 'notifications']) assert.equal(real[key].length, 0, 'Real mode must not show simulated ' + key);
    assert.equal(real.metrics.confirmed, 0); assert.equal(real.metrics.selectedGroups, 0);
    assert.equal((await rpc('searchOffers', { limit: 100 })).total, 0);
    assert.equal((await rpc('searchHistory', { limit: 100 })).total, 0);
    await navigate('groups'); await expect(page.getByRole('heading', { name: 'Nenhum grupo encontrado' })).toBeVisible();
    assert.equal(await page.locator('.group-card').count(), 0); assert(!String(await page.locator('#main').innerText()).includes('Grupo simulado'));
    await page.screenshot({ path: path.join(shots, 'modo-real-vazio.png'), fullPage: true });
    await navigate('buscas'); await tabs('setup');
    assert.equal(await page.locator('[name=monitoredGroupIds]').count(), 0); assert.equal(await page.locator('[name=commandGroupIds]').count(), 0); assert.equal(await page.locator('[name=responsibleRecipientIds]').count(), 0);
    assert(!(await page.locator('#main').innerText()).includes('Grupo simulado'));
    await navigate('settings'); await page.locator('#integration-mode').selectOption('simulated');
    await page.locator('#settings-form [type=submit]').click();
    await expect.poll(async () => (await snapshot()).storageMode, { timeout: 15000 }).toBe('simulated');
    await expect(page.locator('#simulation-banner')).toBeVisible();
    const returned = await snapshot();
    assert.deepEqual(returned.campaigns.map(c => c.id), originalCampaignIds); assert.equal(returned.groups.length, 15);
    assert.equal(returned.buscas.settings.recipientMode, 'responsibles'); assert.deepEqual(returned.buscas.settings.responsibleRecipientIds, [recipient.id]);
    await navigate('dashboard'); await page.screenshot({ path: path.join(shots, 'kenned-painel-simulacao.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log('PASS: real mode has empty real data, no simulation banner or selectors; simulation data and settings restored separately.');
    console.log('Kenned Code Disparos corrections: real Electron UI and SQLite worker verified with simulation only. No real WhatsApp or physical Windows test performed.');
  } catch (error) {
    if (page && !page.isClosed()) { console.error('Isolated UI failure page:', (await page.locator('body').innerText()).slice(0,1800)); await page.screenshot({path:path.join(shots,'failed-fixes-smoke.png'),fullPage:true}).catch(()=>{}); }
    throw error;
  } finally {
    if (app) await app.close();
    if (process.env.MEGA_KEEP_TEST_DATA) console.log('Test data:', dir);
    else fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
