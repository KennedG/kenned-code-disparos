'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { _electron, expect } = require('@playwright/test');
const { createStore } = require('../src/core/store.cjs');
const { AuthService } = require('../src/core/auth.cjs');
const { MediaManager } = require('../src/core/media.cjs');
const { SourceCampaignService } = require('../src/core/source-campaigns.cjs');

// This harness deliberately uses an isolated profile and a controlled capture
// adapter. Only licensing is checked against the published HTTPS service.
// It does not prove WhatsApp delivery, a physical Windows install, or DPAPI.
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-source-ui-232-'));
  const shots = process.env.MEGA_SCREENSHOT_DIR || '/workspace/scratch/source-ui-232/source-ui';
  fs.mkdirSync(shots, { recursive: true });
  const credentials = { username: 'dono-origem-ui', password: 'Senha-Kenned-Origem-Interface-232!' };
  const phone = '5562999990001', origin = 'sim-01@simulation', target = 'sim-02@simulation';
  const caption = '📱 iPhone 16 128GB\n🩷 Cor: ROSA\n🔋 Saúde da bateria: 92%\nR$ 2.999,00\nDetalhe na tela pequeno\n\n𝗣𝗮𝗹𝗮𝗰𝗲 𝗣𝗮𝗿𝗳𝘂𝗺 - 𝗖𝗮𝗺𝗲𝗹𝗼́𝗱𝗿𝗼𝗺𝗼 𝗢𝗞 𝗦𝗧𝗔𝗡𝗗 𝟭𝟯𝟬/𝟭𝟯𝟭';
  const prep = await createStore(dir);
  prep.setSetting('initialized', true); prep.setSetting('integrationMode', 'simulated'); prep.setSetting('unofficialAcknowledged', true);
  prep.upsertGroups([{ id: origin, name: 'Origem simulada de teste', authorized: true, simulation: true }, { id: target, name: 'Destino simulado de teste', authorized: true, simulation: true }]);
  const auth = new AuthService({ store: prep }), owner = (await auth.setupOwner({ ...credentials, name: 'Dono da origem de teste', phone })).user;
  const adapter = new EventEmitter(); adapter.status = { state: 'connected', mode: 'simulated' }; adapter.setSourceCapture = () => {};
  adapter.downloadIncoming = async context => {
    if (context.messageId === 'GUI-MEDIA-FAILED') throw Object.assign(new Error('Falha controlada de download para validar a interface.'), { code: 'SOURCE_MEDIA_DOWNLOAD_FAILED' });
    return { buffer: fs.readFileSync(path.resolve('assets/icon.png')), name: `${context.messageId}.png`, mime: 'image/png', type: 'image' };
  };
  const capture = new SourceCampaignService({ store: prep, mediaManager: new MediaManager(prep), adapter, isAutomationStopped: () => false, assertCanCapture: () => true });
  capture.saveConfig({ enabled: true, groupId: origin, allowedParticipantIds: [phone], allowOwnMessages: true, timezone: 'America/Sao_Paulo', configTemplate: { groupIds: [target], maxRounds: 2 } }, owner.id);
  capture.start();
  const publication = (messageId, text = caption, extra = {}) => ({ messageId, chatId: origin, timestamp: Date.now(), originalTimestamp: Date.now(), isGroup: true, identityVerified: true, senderNumber: phone, senderId: `${phone}@s.whatsapp.net`, senderIds: [`${phone}@s.whatsapp.net`], fromMe: true, trustedSelf: true, automaticMessage: false, type: 'image', text, caption: text, mode: 'simulated', simulation: true, raw: { key: { id: messageId, remoteJid: origin }, message: { imageMessage: { caption: text } } }, ...extra });
  const captured = capture.handlePublication(publication('GUI-CAPTURED'));
  const emptyPhoto = capture.handlePublication(publication('GUI-PHOTO-REVIEW', ''));
  const failedPhoto = capture.handlePublication(publication('GUI-MEDIA-FAILED'));
  assert(captured.accepted && emptyPhoto.accepted && failedPhoto.accepted); await capture.waitForIdle();
  const readyFile=prep.getMedia(prep.getSourcePublication(captured.publication.id).mediaId);assert(readyFile);assert.deepEqual(fs.readFileSync(readyFile.path),fs.readFileSync(path.resolve('assets/icon.png')));
  assert.equal(prep.getSourceMetrics().ready, 1); assert.equal(prep.getSourceMetrics().review, 1); assert.equal(prep.getSourceMetrics().failed, 1);
  let c = prep.listCampaigns()[0]; assert(c); assert.equal(c.state, 'draft'); assert.equal(c.items[0].caption, caption); assert.equal(c.groupIds.length, 0);
  c = prep.saveCampaign({ ...c, groupIds: [target], destinationHealth: { [target]: { suspended: true, code: 'GROUP_ADMIN_ONLY', reason: 'Somente administradores podem enviar neste destino de teste.', confirmed: true, at: Date.now() } } });
  prep.insertRound({ id: 'gui-round-uncertain', campaignId: c.id, startedAt: Date.now(), finishedAt: Date.now(), status: 'completed', number: 1 });
  prep.insertJob({ id: 'gui-job-uncertain', campaignId: c.id, roundId: 'gui-round-uncertain', itemId: c.items[0].id, groupId: target, itemSnapshot: c.items[0], messageId: 'gui-message-uncertain', status: 'uncertain', attempts: 1, createdAt: Date.now(), resultAt: Date.now(), error: 'Tempo limite de teste: resultado sem evidência.' });
  await capture.stop(); prep.close();
  let app, page; const errors = [], dialogs = [];
  const launch = async () => {
    app = await _electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', '--disable-gpu', ...(process.env.MEGA_PROXY_TEST ? ['--proxy-server=http://proxy:8080'] : []), process.env.MEGA_APP_PATH || '.'], env: { ...process.env, MEGA_DATA_DIR: dir }, timeout: 25000 });
    await expect.poll(() => { page = app.windows().find(window => /\/ui\/index\.html$/.test(window.url())); return Boolean(page); }, { timeout: 25000 }).toBe(true);
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); if (/risco de duplicação/.test(dialog.message())) await dialog.dismiss(); else await dialog.accept(); });
    await page.getByRole('heading', { name: 'Bem-vindo de volta' }).waitFor();
    await expect.poll(async () => (await page.evaluate(() => window.mega.call('licenseStatus')))?.allowed, { timeout: 30000 }).toBe(true);
    for (const [name, value] of Object.entries(credentials)) await page.locator(`#auth-form [name="${name}"]`).fill(value);
    await page.locator('#auth-form [type=submit]').click(); await page.getByRole('heading', { name: 'Tudo sob controle' }).waitFor();
  };
  const rpc = async (action, payload) => { const result = await page.evaluate(({ action, payload }) => window.mega.call(action, payload), { action, payload }); assert(!result?.error, `${action}: ${JSON.stringify(result)}`); return result; };
  const snapshot = () => rpc('snapshot');
  const nav = id => page.locator(`#navigation [data-id="${id}"]`).click();
  try {
    await launch(); await rpc('licenseRefresh'); await rpc('resumeAutomation'); await rpc('connect');
    assert.equal(await page.title(), 'Kenned Code Disparos'); await nav('sources'); await page.getByRole('heading', { name: 'Origem da loja', exact: true }).waitFor();
    await expect(page.locator('.source-publication')).toHaveCount(3); assert.equal(await page.locator(`[data-publication-id="${captured.publication.id}"] .source-caption`).innerText(), caption);
    await page.locator(`[data-publication-id="${captured.publication.id}"] img`).scrollIntoViewIfNeeded();
    await expect.poll(async () => page.locator(`[data-publication-id="${captured.publication.id}"] img`).evaluate(image => image.naturalWidth),{timeout:15000}).toBeGreaterThan(0);
    await expect(page.locator('#source-page')).toContainText('Falha controlada de download');
    assert.equal((await rpc('sourcePublications', { limit: 100 })).items.some(item => 'protectedContext' in item), false, 'Renderer must never receive protected media metadata.');
    console.log('PASS: Electron displays captured photo and exact multiline Unicode caption, pending review and independent failed download. Capture fixture is simulated.');
    await page.locator('#source-config-form [name=messageSpacingSeconds]').fill('4'); await page.locator('#source-config-form [name=spacingSeconds]').fill('7'); await page.locator('#source-config-form [name=intervalMinutes]').fill('15'); await page.locator('#source-config-form [name=sendTimeoutSeconds]').fill('45'); await page.locator('#source-config-form [name=maxRounds]').fill('3');
    await page.locator('#source-config-form [type=submit]').click();
    await expect.poll(async () => (await rpc('sourceConfigGet')).config.configTemplate.spacingSeconds).toBe(7);
    const savedConfig = (await rpc('sourceConfigGet')).config; assert.equal(savedConfig.groupId, origin); assert.equal(savedConfig.configTemplate.messageSpacingSeconds, 4); assert.equal(savedConfig.configTemplate.intervalMinutes, 15); assert.equal(savedConfig.configTemplate.sendTimeoutSeconds, 45); assert.equal(savedConfig.configTemplate.maxRounds, 3); assert.deepEqual(savedConfig.allowedParticipantIds, [phone]);
    const persistedCampaign = (await snapshot()).campaigns.find(item => item.id === c.id); assert.equal(persistedCampaign.state, 'draft');
    await page.screenshot({ path: path.join(shots, 'origem-capturas-config.png'), fullPage: true });
    console.log('PASS: actual backend RPC persists source ID, authorized participant and three distinct intervals, timeout and round limit without automatic activation.');

    await page.locator(`[data-action=source-review][data-id="${emptyPhoto.publication.id}"]`).click(); await page.locator('#source-review-caption').fill('📱 Foto revisada manualmente\nR$ 1.234,00\nAssinatura preservada'); await page.locator('[data-action=source-save-review]').click(); await page.locator('.modal').waitFor({ state: 'hidden' });
    await expect.poll(async () => (await rpc('sourcePublications', { limit: 100 })).items.find(item => item.id === emptyPhoto.publication.id)?.status).toBe('ready');
    const reviewed = (await rpc('sourcePublications', { limit: 100 })).items.find(item => item.id === emptyPhoto.publication.id); assert.equal(reviewed.originalCaption, ''); assert.equal(reviewed.caption, '📱 Foto revisada manualmente\nR$ 1.234,00\nAssinatura preservada');
    await page.locator(`[data-source-select="${captured.publication.id}"]`).check(); await page.locator(`[data-source-select="${emptyPhoto.publication.id}"]`).check(); await page.locator('[data-action=source-group]').click(); await page.locator('#source-group-caption').fill(caption); await page.locator('[data-action=source-save-group]').click(); await page.locator('.modal').waitFor({ state: 'hidden' });
    const grouped = (await rpc('sourcePublications', { limit: 100 })).items; assert.equal(grouped.find(item => item.id === captured.publication.id).manualGroupId, grouped.find(item => item.id === emptyPhoto.publication.id).manualGroupId); assert.ok(grouped.find(item => item.id === captured.publication.id).manualGroupId);
    console.log('PASS: manual review and explicit photo grouping use actual RPCs, preserve original captions and do not infer text from adjacent messages.');

    await nav('campaigns'); await page.locator(`[data-action=source-monitor][data-id="${c.id}"]`).click(); await expect(page.locator('#source-campaign-monitor')).toContainText('Somente administradores'); await expect(page.locator('#source-campaign-monitor')).toContainText('gui-message-uncertain');
    await page.locator('[data-action=source-reconcile]').click(); await expect(page.locator('#source-campaign-monitor')).toContainText('gui-message-uncertain'); assert.equal((await rpc('historyPage', { campaignId: c.id, status: 'uncertain', limit: 100 })).total, 1);
    await page.locator('[data-action=source-manual-retry]').click(); assert.ok(dialogs.some(message => /risco de duplicação/.test(message))); assert.equal((await rpc('historyPage', { campaignId: c.id, status: 'uncertain', limit: 100 })).total, 1);
    await page.locator('[data-action=source-recheck-destination]').click(); await expect(page.locator('#source-campaign-monitor')).toContainText('Apto');
    await page.locator('[data-action=source-apply-template]').click(); assert.equal((await snapshot()).campaigns.find(item => item.id === c.id).state, 'draft');
    await page.locator('[data-action=source-order]').click(); await page.locator('[data-action=source-order-down]').first().click(); await page.locator('[data-action=source-save-order]').click();
    const reordered = (await snapshot()).campaigns.find(item => item.id === c.id); assert.equal(reordered.items.length, 2); assert.equal(reordered.items[1].id, persistedCampaign.items[0].id);
    await page.screenshot({ path: path.join(shots, 'origem-painel-destinos-incertos.png'), fullPage: true }); await page.locator('[data-action=source-close]').click();
    console.log('PASS: campaign operation panel distinguishes uncertainty, renders group-specific reason, reconciles without blind resend, warns and cancels manual retry, rechecks actual simulated destination and persists next-round order/template.');

    await nav('sources'); await page.locator(`[data-action=source-remove][data-id="${emptyPhoto.publication.id}"]`).click(); await expect.poll(async () => (await rpc('sourcePublications', { limit: 100 })).items.find(item => item.id === emptyPhoto.publication.id)?.status).toBe('removed');
    assert.equal((await snapshot()).campaigns.find(item => item.id === c.id).items.length, 1);
    await rpc('stopAll'); await rpc('saveSettings', { settings: { integrationMode: 'whatsapp', unofficialAcknowledged: true } }); await nav('sources');
    await expect(page.locator('#source-groupId option')).toHaveCount(1); await expect(page.locator('.source-publication')).toHaveCount(0); await expect(page.locator('#source-page')).toContainText('Não há grupos carregados'); await expect(page.locator('#simulation-banner')).toBeHidden();
    assert.equal((await snapshot()).groups.length, 0);
    await rpc('saveSettings', { settings: { integrationMode: 'simulated' } }); await nav('sources'); await expect(page.locator('.source-publication')).toHaveCount(3);
    await app.close(); app = null; await launch(); await nav('sources'); await expect(page.locator('.source-publication')).toHaveCount(3);
    const restored = (await rpc('sourceConfigGet')).config; assert.equal(restored.groupId, origin); assert.equal(restored.configTemplate.sendTimeoutSeconds, 45); assert.equal(restored.configTemplate.spacingSeconds, 7); assert.equal((await snapshot()).campaigns.find(item => item.id === c.id).items.length, 1); assert.equal((await rpc('historyPage', { campaignId: c.id, status: 'uncertain' })).total, 1);
    assert.deepEqual(errors, []);
    console.log('PASS: manual removal protects historical uncertainty; real mode has no simulated groups/publications; config/media/draft/ledger survive mode return and Electron close/reopen. No real WhatsApp delivery or physical Windows test was performed.');
  } catch(error){if(page)await page.screenshot({path:path.join(shots,'failed-source-gui.png'),fullPage:true}).catch(()=>{});throw error;} finally {
    if (app) await app.close();
    if (process.env.MEGA_KEEP_TEST_DATA) console.log('Isolated test profile:', dir); else fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
