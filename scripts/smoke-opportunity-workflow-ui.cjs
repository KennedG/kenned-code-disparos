'use strict';
// Electron renderer/backend/SQLite with a deliberately simulated WhatsApp adapter.
// This does not prove delivery to a handset or physical Windows installation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { _electron, expect } = require('@playwright/test');
const { createStore } = require('../src/core/store.cjs');
const { AuthService } = require('../src/core/auth.cjs');
const { OpportunityService } = require('../src/core/opportunity-service.cjs');
const { MediaManager } = require('../src/core/media.cjs');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-op-workflow-ui-'));
  const screenshots = process.env.MEGA_SCREENSHOT_DIR || '/workspace/scratch/op-workflow-ui';
  fs.mkdirSync(screenshots, { recursive: true });
  const credentials = { username: 'oportunidades.ui', password: 'Senha-Kenned-Oportunidades-2026!' };
  const source = 'sim-01@simulation', destinations = ['sim-03@simulation', 'sim-04@simulation'];
  const phone = '5562999990001', requester = '5562999990002';
  const prep = await createStore(dir);
  prep.setSetting('initialized', true); prep.setSetting('integrationMode', 'simulated'); prep.setSetting('unofficialAcknowledged', true);
  prep.upsertGroups([source, ...destinations].map((id, i) => ({ id, name: `Grupo isolado ${i}`, simulation: true, authorized: true })));
  const owner = (await new AuthService({ store: prep }).setupOwner({ ...credentials, name: 'Revisor de Oportunidades', phone })).user;
  const now = Date.now();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jAlkAAAAASUVORK5CYII=', 'base64');
  const media = await new MediaManager(prep).importBuffer(png, { name: 'anuncio-isolado.png', mime: 'image/png' });
  const caption = '📱 Aparelho escolhido da campanha\nConsulte o valor.\n🩷 Cor: ROSA\nDetalhe na tela pequeno\n𝗞𝗖 — assinatura original';
  const campaign = prep.saveCampaign({ id: 'gui-op-workflow-campaign', name: 'Anúncio sem preço interpretado', state: 'draft', ownerId: owner.id, mode: 'repeat', groupIds: destinations, items: [
    { id: 'gui-op-raw-image', type: 'image', mediaId: media.id, caption, text: caption, sourceGroupId: source, sourceMessageId: 'gui-op-source', sourceOriginalAt: now, ready: true },
    { id: 'gui-op-removed', type: 'text', text: 'Anúncio retirado', opportunityAvailable: false, ready: true }
  ], schedule: { days: [0, 1, 2, 3, 4, 5, 6], startTime: '00:00', endTime: '00:00' }, intervalMinutes: 10, spacingSeconds: 3, messageSpacingSeconds: 3, groupSpacingSeconds: 3 });
  const adapter = new EventEmitter(); adapter.status = { state: 'disconnected', mode: 'simulated' }; adapter.configureOpportunityCapture = () => {};
  const service = new OpportunityService({ store: prep, adapter, now: () => now + 100, assertCanCapture: () => true, assertCanOperate: () => true, onLocalAlert: () => {} });
  service.saveConfig({ enabled: true, mode: 'manual', availabilityMode: 'campaign', monitoredGroupIds: [source], campaignIds: [campaign.id], campaignDestinations: true, workflowVersion: 1, adminPhone: phone, adminActorId: owner.id }, owner.id);
  const record = service.handleIncoming({ messageId: 'gui-op-request', text: 'Quem tem iPhone 12 Pro?', chatId: source, timestamp: now + 100, originalTimestamp: now + 100, senderId: `${requester}@s.whatsapp.net`, senderNumber: requester, profileName: 'Interessado de teste', identityVerified: true, isGroup: true, simulation: true, mode: 'simulated', type: 'text' });
  assert(record.opportunity?.id); const opportunityId = record.opportunity.id;
  prep.setOpportunityConfig({ ...prep.getOpportunityConfig(), mode: 'automatic', automatic: true, evaluation: false });
  await service.stop(); prep.close();
  let app, page; const errors = [];
  const rpc = async (action, payload) => { const result = await page.evaluate(({ action, payload }) => window.mega.call(action, payload), { action, payload }); assert(!result?.error, `${action}: ${JSON.stringify(result)}`); return result; };
  const nav = async section => { const item = page.locator(`#navigation [data-id="${section}"]`).first(); if (!await item.isVisible()) await page.locator('#navigation [data-action=toggle-more-tools]').click(); await item.click(); };
  const launch = () => _electron.launch({ executablePath: process.env.MEGA_ELECTRON_EXECUTABLE || require('electron'), args: ['--no-sandbox', '--disable-gpu', ...(process.env.MEGA_PROXY_TEST ? ['--proxy-server=http://proxy:8080'] : []), process.env.MEGA_APP_PATH || '.'], env: { ...process.env, MEGA_DATA_DIR: dir }, timeout: 25000 });
  try {
    app = await launch();
    await expect.poll(() => { page = app.windows().find(window => /\/ui\/index\.html$/.test(window.url())); return Boolean(page); }, { timeout: 25000 }).toBe(true);
    page.on('pageerror', error => errors.push(error.message)); page.on('dialog', async dialog => dialog.accept());
    await page.getByRole('heading', { name: 'Bem-vindo de volta' }).waitFor();
    await expect.poll(async () => (await page.evaluate(() => window.mega.call('licenseStatus')))?.allowed, { timeout: 30000 }).toBe(true);
    for (const [name, value] of Object.entries(credentials)) await page.locator(`#auth-form [name="${name}"]`).fill(value);
    await page.locator('#auth-form [type=submit]').click(); await page.getByRole('heading', { name: 'Tudo sob controle' }).waitFor();
    await rpc('licenseRefresh'); await rpc('resumeAutomation'); await rpc('connect'); await nav('opportunities');
    const state = await rpc('opportunityState'); assert.equal(state.config.campaignDestinations, true); assert.equal(state.config.availabilityMode, 'campaign');
    const card = page.locator(`[data-opportunity-id="${opportunityId}"]`); await expect(card).toBeVisible();
    await card.locator('[data-action=opportunity-choose-campaign]').click();
    await expect(page.locator('#opportunity-campaign-chooser')).toContainText(caption);
    const chosen = page.locator('[data-action=opportunity-manual-item-send][data-item-id=gui-op-raw-image]');
    await expect(chosen).toBeEnabled();
    await page.screenshot({ path: path.join(screenshots, 'oportunidades-selecao-direta.png'), fullPage: true });
    await chosen.click();
    await expect(page.locator('#opportunity-preview')).toHaveCount(0);
    await expect.poll(async () => {
      const detail = await rpc('opportunityDetail', { id: opportunityId });
      return (detail.workflow?.jobs || []).filter(job => job.type === 'campaign-ad' && ['accepted', 'delivered'].includes(job.status)).length;
    }, { timeout: 30000 }).toBe(destinations.length);
    await expect.poll(async () => (await rpc('opportunityDetail', { id: opportunityId })).workflow?.jobs?.filter(job => job.type === 'admin-notice' && ['accepted', 'delivered'].includes(job.status)).length || 0, { timeout: 20000 }).toBeGreaterThanOrEqual(2);
    const detail = await rpc('opportunityDetail', { id: opportunityId });
    const notices = detail.workflow.jobs.filter(job => job.type === 'admin-notice');
    assert(notices.every(job => job.recipient === phone), 'notices must target only configured administrator');
    assert(notices.some(job => job.body.includes(opportunityId) && job.body.includes(caption)), 'new-opportunity notice identifies request and preserves the campaign message');
    const jobs = (detail.workflow?.jobs || []).filter(job => job.type === 'campaign-ad');
    assert.equal(jobs.length, 2); assert.deepEqual(jobs.map(job => job.recipient).sort(), [...destinations].sort());
    for (const job of jobs) assert.equal(job.itemSnapshot?.caption || detail.workflow.itemSnapshot?.caption, caption);
    assert.equal(detail.tasks.length, 0, 'legacy requester-private response tasks must remain empty');
    assert(!jobs.some(job => job.recipient === requester), 'requester is not an implicit campaign destination');
    const duplicate = await rpc('opportunityDispatch', { opportunityId, campaignId: campaign.id, itemId: 'gui-op-raw-image' });
    assert(duplicate.duplicate || duplicate.batch || duplicate.workflow || duplicate.ok === false && ['OP_ALREADY_RESPONDED', 'OP_CLOSED'].includes(duplicate.code), JSON.stringify(duplicate));
    assert.equal((await rpc('opportunityDetail', { id: opportunityId })).workflow.jobs.filter(job => job.type === 'campaign-ad').length, 2);
    if (await page.locator('[data-action=opportunity-close-modal]').count()) await page.locator('[data-action=opportunity-close-modal]').first().click();
    await nav('opportunities');
    await page.screenshot({ path: path.join(screenshots, 'oportunidades-envio-destinos-campanha.png'), fullPage: true });
    console.log('PASS: direct raw-photo selection sends preserved caption/media to exactly campaign destinations, without inventory, parsed price, preview token or repeated approval; duplicate dispatch does not create tasks. Explicitly simulated WhatsApp.');
    const privateStatus = await rpc('testSimulation', { senderNumber: phone, text: '!status' }); assert.match(privateStatus.text, /oportun|automático|automatico|pend/i);
    const help = await rpc('testSimulation', { senderNumber: phone, text: '!ajuda' }); assert.match(help.text, /!aprovar/); assert.match(help.text, /!automatico/);
    await rpc('testSimulation', { senderNumber: phone, text: '!automatico off' }); assert.equal((await rpc('opportunityState')).config.mode, 'manual');
    const beforeRestart = await rpc('opportunityDetail', { id: opportunityId });
    await app.close(); app = null; page = null;
    app = await launch();
    await expect.poll(() => { page = app.windows().find(window => /\/ui\/index\.html$/.test(window.url())); return Boolean(page); }, { timeout: 25000 }).toBe(true);
    page.on('pageerror', error => errors.push(error.message)); page.on('dialog', async dialog => dialog.accept());
    await page.getByRole('heading', { name: 'Bem-vindo de volta' }).waitFor();
    for (const [name, value] of Object.entries(credentials)) await page.locator(`#auth-form [name="${name}"]`).fill(value);
    await page.locator('#auth-form [type=submit]').click(); await page.getByRole('heading', { name: 'Tudo sob controle' }).waitFor();
    await rpc('connect');
    const persisted = await rpc('opportunityState'); assert.equal(persisted.config.mode, 'manual'); assert.equal(persisted.config.adminPhone, phone);
    const afterRestart = await rpc('opportunityDetail', { id: opportunityId });
    assert.deepEqual(afterRestart.workflow.jobs.map(job => [job.id, job.status]), beforeRestart.workflow.jobs.map(job => [job.id, job.status]), 'restart and reconnect preserve receipts and do not create another delivery');
    console.log('PASS: real Electron close/reopen and simulated reconnect preserve administrator, manual mode, accepted jobs and deduplication records.');
    await rpc('testSimulation', { senderNumber: phone, text: '!automatico on' }); assert.equal((await rpc('opportunityState')).config.mode, 'automatic');
    await rpc('testSimulation', { senderNumber: phone, text: '!pausar' }); assert.equal((await rpc('snapshot')).automation.stopped, true);
    assert.deepEqual(errors, []);
    console.log('PASS: configured administrator private help/status/automatic mode/pause commands; persisted mode visible through production RPC. No real WhatsApp or physical Windows delivery is asserted.');
  } catch (error) { if (page) await page.screenshot({ path: path.join(screenshots, 'failed-opportunity-workflow-ui.png'), fullPage: true }).catch(() => {}); throw error; }
  finally { if (app) await app.close(); if (process.env.MEGA_KEEP_TEST_DATA) console.log('Isolated test profile:', dir); else fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
