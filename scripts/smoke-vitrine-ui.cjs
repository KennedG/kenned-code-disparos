'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { EventEmitter } = require('node:events');
const { _electron, expect } = require('@playwright/test');
const { createStore } = require('../src/core/store.cjs');
const { AuthService } = require('../src/core/auth.cjs');
const { MediaManager } = require('../src/core/media.cjs');
const { SourceCampaignService } = require('../src/core/source-campaigns.cjs');

// Actual Electron renderer, production RPCs, managed PNGs and SQLite. Licensing
// uses the published HTTPS service; WhatsApp capture uses an isolated simulator.
// MEGA_APP_PATH may point to the extracted installer ASAR for payload testing.
// This is not a physical Windows install or proof of real WhatsApp reception.
function tinyPNG() {
  const crc = bytes => { let n = 0xffffffff; for (const byte of bytes) { n ^= byte; for (let bit = 0; bit < 8; bit++) n = n >>> 1 ^ (n & 1 ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; };
  const chunk = (type, bytes) => { const length = Buffer.alloc(4), checksum = Buffer.alloc(4), name = Buffer.from(type); length.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc(Buffer.concat([name, bytes]))); return Buffer.concat([length, name, bytes, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 35, 165, 110]))), chunk('IEND', Buffer.alloc(0))]);
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-vitrine-ui-'));
  const shots = process.env.MEGA_SCREENSHOT_DIR || '/workspace/scratch/reformulado-ui/screenshots'; fs.mkdirSync(shots, { recursive: true });
  const credentials = { username: 'dono-vitrine-teste', password: 'Senha-Vitrine-Isolada-2026!' }, phone = '5562999990001', origin = 'sim-01@simulation';
  const caption = '📱 iPhone 16 128GB\n🩷 Cor: ROSA\n🔋 Saúde da bateria: 92%\nR$ 2.999,00\nDetalhe na tela pequeno\nFornecedor: Ricardo\nContato do fornecedor: 5562999999999\nAssinatura original preservada';
  const prep = await createStore(dir); prep.setSetting('initialized', true); prep.setSetting('integrationMode', 'simulated'); prep.setSetting('unofficialAcknowledged', true);
  prep.upsertGroups([{ id: origin, name: 'Origem simulada exclusiva do teste', authorized: true, simulation: true }]);
  const auth = new AuthService({ store: prep }), owner = (await auth.setupOwner({ ...credentials, name: 'Dono da vitrine de teste', phone })).user;
  const media = new MediaManager(prep), image = await media.importBuffer(tinyPNG(), { name: 'foto-controlada.png', mime: 'image/png' });
  const campaign = prep.saveCampaign({ id: 'gui-public-campaign', name: 'Campanha interna isolada', state: 'draft', ownerId: owner.id, mode: 'repeat', groupIds: [], items: [{ id: 'gui-public-item', type: 'image', mediaId: image.id, caption, ready: true }], schedule: { days: [0, 1, 2, 3, 4, 5, 6], startTime: '08:00', endTime: '18:00' }, intervalMinutes: 10, spacingSeconds: 5 });
  const adapter = new EventEmitter(); adapter.status = { state: 'connected', mode: 'simulated' }; adapter.setSourceCapture = () => {}; adapter.downloadIncoming = async () => ({ buffer: tinyPNG(), name: 'origem-controlada.png', mime: 'image/png', type: 'image' });
  const capture = new SourceCampaignService({ store: prep, mediaManager: media, adapter, assertCanCapture: () => true, isAutomationStopped: () => false });
  capture.saveConfig({ enabled: true, groupId: origin, allowedParticipantIds: [phone], allowOwnMessages: true, timezone: 'America/Sao_Paulo' }, owner.id); capture.start();
  const now = Date.now(); const captured = capture.handlePublication({ messageId: 'GUI-SOURCE-REFORMULADO', chatId: origin, timestamp: now, originalTimestamp: now, isGroup: true, identityVerified: true, senderNumber: phone, senderId: `${phone}@s.whatsapp.net`, senderIds: [`${phone}@s.whatsapp.net`], fromMe: true, trustedSelf: true, automaticMessage: false, type: 'image', text: caption, caption, mode: 'simulated', simulation: true, raw: { key: { id: 'GUI-SOURCE-REFORMULADO', remoteJid: origin }, message: { imageMessage: { caption } } } });
  assert(captured.accepted); await capture.waitForIdle(); const sourceCampaignId = prep.getSourcePublication(captured.publication.id).campaignId; assert(sourceCampaignId); await capture.stop(); prep.close();

  let app, page; const errors = [], confirmations = [];
  const rpc = async (action, payload) => { const result = await page.evaluate(({ action, payload }) => window.mega.call(action, payload), { action, payload }); assert(!result?.error, `${action}: ${JSON.stringify(result)}`); return result; };
  const launch = async () => {
    app = await _electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', '--disable-gpu', ...(process.env.MEGA_PROXY_TEST ? ['--proxy-server=http://proxy:8080'] : []), process.env.MEGA_APP_PATH || '.'], env: { ...process.env, MEGA_DATA_DIR: dir }, timeout: 25000 });
    await expect.poll(() => { page = app.windows().find(window => /\/ui\/index\.html$/.test(window.url())); return Boolean(page); }, { timeout: 25000 }).toBe(true);
    page.on('pageerror', error => errors.push(error.message)); page.on('dialog', async dialog => { confirmations.push(dialog.message()); await dialog.accept(); });
    // Only this isolated harness accepts the source-deletion native dialog.
    // No production code or other confirmation is changed.
    await app.evaluate(({ dialog }) => { const original = dialog.showMessageBox.bind(dialog); dialog.showMessageBox = async (...args) => { const options = args.find(value => Array.isArray(value?.buttons) && typeof value.message === 'string'); return options?.title === 'Excluir campanha vinculada' ? { response: 1, checkboxChecked: false } : original(...args); }; });
    await page.getByRole('heading', { name: 'Bem-vindo de volta' }).waitFor();
    await expect.poll(async () => (await rpc('licenseStatus')).allowed, { timeout: 30000 }).toBe(true);
    for (const [name, value] of Object.entries(credentials)) await page.locator(`#auth-form [name="${name}"]`).fill(value);
    await page.locator('#auth-form [type=submit]').click(); await page.getByRole('heading', { name: 'Tudo sob controle' }).waitFor();
  };
  const nav = id => page.locator(`#navigation [data-id="${id}"]`).click();
  const closeTV = async () => { await page.evaluate(() => document.querySelector('[data-action="vitrine-exit"]')?.click()); await expect(page.locator('#vitrine-tv-root')).toHaveCount(0); };
  try {
    await launch(); await rpc('licenseRefresh'); const licence = await rpc('licenseStatus'); assert.equal(licence.serverConfigured, true); assert.equal(licence.allowed, true);
    assert.equal(await page.title(), 'Kenned Code Disparos'); await expect(page.locator('#navigation [data-nav-main]:visible')).toHaveCount(7);
    await expect(page.locator('#nav-extra-tools')).toBeHidden(); await page.locator('[data-action=toggle-more-tools]').click(); await expect(page.locator('#nav-extra-tools')).toBeVisible();
    for (const category of ['Atendimento', 'Conteúdo', 'Automação', 'Diagnóstico']) await expect(page.locator('#nav-extra-tools')).toContainText(category);
    await page.locator('[data-action=toggle-more-tools]').click(); await expect(page.locator('#nav-extra-tools')).toBeHidden();
    const wide = await page.locator('.sidebar').evaluate(node => node.getBoundingClientRect().width); await page.locator('#sidebar-collapse').click();
    await expect.poll(async () => page.locator('.sidebar').evaluate(node => node.getBoundingClientRect().width)).toBeLessThan(wide);
    await expect(page.locator('#navigation [data-nav-main]').first()).toHaveAttribute('title', /Resumo das campanhas/); await page.locator('#sidebar-collapse').click();
    console.log('PASS: actual Electron navigation exposes seven main entries, expands categorized tools only on request and collapses sidebar width with icon tooltips. HTTPS licensing validated.');

    await page.locator('[data-action=vitrine-configure]').click(); await page.locator('#vitrine-config-form').waitFor();
    await page.locator('#vitrine-config-form [name=brandName]').fill('Marca comercial de teste'); await page.locator('#vitrine-config-form [name=commercialContact]').fill('(62) 99999-0001');
    await page.locator('#vitrine-config-form [name=whatsappUrl]').fill(`https://wa.me/${phone}`); await page.locator('#vitrine-config-form [name=wholesaleUrl]').fill('https://example.com/lojistas');
    await page.locator('#vitrine-config-form [name=secondsPerItem]').fill('5'); await page.locator('#vitrine-config-form [name=audience]').selectOption('mixed');
    await page.locator(`[data-vitrine-candidate="${campaign.id}:gui-public-item"]`).check();
    await page.locator('#vitrine-config-form [name=model-0]').fill('iPhone 16'); await page.locator('#vitrine-config-form [name=storage-0]').fill('128GB'); await page.locator('#vitrine-config-form [name=color-0]').fill('Rosa');
    await page.locator('#vitrine-config-form [name=retail-0]').fill('2999,00'); await page.locator('#vitrine-config-form [name=wholesale-0]').fill('2799,00'); await page.locator('#vitrine-config-form [name=audience-0]').selectOption('both'); await page.locator('#vitrine-config-form [name=availability-0]').selectOption('ready'); await page.locator('#vitrine-config-form [name=description-0]').fill('Saúde da bateria: 92%');
    await page.locator('[data-action=vitrine-save]').click(); await expect.poll(async () => (await rpc('vitrineState')).items.length).toBe(1);
    assert.equal((await rpc('vitrinePublic')).mode, 'neutral'); const draft = await rpc('vitrineState'); assert.equal(draft.items[0].wholesalePriceCents, 279900);
    await page.locator('[data-action=vitrine-preview]').click(); await expect(page.locator('.vitrine-preview-item')).toHaveCount(2); await expect(page.locator('#vitrine-public-preview')).toContainText('Detalhe na tela pequeno');
    const previewText = await page.locator('#vitrine-public-preview').innerText(); assert(!previewText.includes('Ricardo')); assert(!previewText.includes('5562999999999')); assert(!previewText.includes('Assinatura original'));
    const qrSrc = await page.locator('#vitrine-public-preview .vitrine-qr img').first().getAttribute('src'); assert.deepEqual([...Buffer.from(qrSrc.split(',')[1], 'base64').subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    await page.screenshot({ path: path.join(shots, 'tv-previa-publica.png'), fullPage: true });
    await page.locator('[data-action=vitrine-publish]').click(); await expect(page.locator('#vitrine-public-preview')).toHaveCount(0); assert(confirmations.some(message => /Publicar 2 anúncio/.test(message)));
    const published = await rpc('vitrinePublic'); assert.deepEqual(published.items.map(item => [item.audience, item.priceCents]), [['retail', 299900], ['wholesale', 279900]]);
    assert.equal((await rpc('snapshot')).campaigns.find(c => c.id === campaign.id).items[0].caption, caption);
    console.log('PASS: actual GUI selection, draft save, independent retail/wholesale prices, PNG QR, explicit preview and publication preserve full source caption while excluding supplier data.');

    // Xvfb has no window manager to resize the native window on the DOM
    // fullscreen request. Set the actual test window to the 16:9 display size.
    await app.evaluate(({ BrowserWindow, screen }) => { const main = BrowserWindow.getAllWindows().find(win => /\/ui\/index\.html$/.test(win.webContents.getURL())); const bounds = screen.getPrimaryDisplay().bounds; main.setSize(bounds.width, bounds.height); });
    await page.locator('[data-action=vitrine-open]').click(); await expect(page.locator('#vitrine-tv-root')).toBeVisible(); await expect(page.locator('#vitrine-tv-root')).toContainText('VAREJO');
    await expect.poll(async () => page.locator('#vitrine-tv-root .vitrine-photo img').evaluate(img => img.naturalWidth)).toBe(1);
    await expect.poll(async () => page.locator('#vitrine-tv-root .vitrine-qr img').evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
    await expect.poll(async () => page.evaluate(() => document.fullscreenElement?.id)).toBe('vitrine-tv-root');
    const dimensions = await page.locator('#vitrine-tv-root').evaluate(node => { const rect = node.getBoundingClientRect(); return { width: rect.width, height: rect.height, priceFont: Number.parseFloat(getComputedStyle(node.querySelector('.vitrine-price')).fontSize) }; });
    assert(dimensions.width / dimensions.height > 1.7 && dimensions.width / dimensions.height < 1.9); assert(dimensions.priceFont > 50);
    await page.screenshot({ path: path.join(shots, 'tv-varejo-fullscreen.png') }); await page.evaluate(() => document.querySelector('[data-action="vitrine-next"]').click());
    await expect(page.locator('#vitrine-tv-root')).toContainText('ATACADO'); await expect(page.locator('#vitrine-tv-root')).toContainText('2.799,00'); await expect(page.locator('#vitrine-tv-root')).toContainText('Consulte nossa lista para lojistas');
    await page.screenshot({ path: path.join(shots, 'tv-atacado-fullscreen.png') });
    await rpc('vitrineWithdraw', { id: draft.items[0].id }); await expect(page.locator('#vitrine-tv-root')).toContainText('Seja bem-vindo', { timeout: 8000 }); assert.equal((await rpc('vitrinePublic')).mode, 'neutral'); await closeTV();
    const expired = await rpc('vitrinePreview', { config: draft.config, items: [{ ...draft.items[0], expiresAt: Date.now() - 1 }] }); assert.equal(expired.publicItems.length, 0); assert(expired.warnings.some(w => w.code === 'VITRINE_EXPIRED'));
    console.log('PASS: fullscreen 16:9 display loads actual managed PNG and QR, uses legible prices, shows labeled wholesale slide and reflects actual withdrawal through polling; expired adverts are excluded.');

    await rpc('saveSettings', { settings: { integrationMode: 'whatsapp', unofficialAcknowledged: true } }); await expect(page.locator('#simulation-banner')).toBeHidden();
    const realTV = await rpc('vitrineState'); assert.equal(realTV.items.length, 0); assert.equal(realTV.candidates.length, 0); assert.equal((await rpc('vitrinePublic')).mode, 'neutral');
    await rpc('saveSettings', { settings: { integrationMode: 'simulated' } }); await expect(page.locator('#simulation-banner')).toBeVisible(); await rpc('connect');
    await nav('sources'); await page.locator('#source-campaign-filter').selectOption(sourceCampaignId); await page.locator(`[data-action=source-monitor][data-id="${sourceCampaignId}"]`).first().click(); await page.locator('#source-campaign-monitor').waitFor();
    await rpc('deleteCampaign', { id: sourceCampaignId }); await expect(page.locator('#source-campaign-monitor')).toHaveCount(0); await expect(page.locator('.source-capture-paused')).toContainText('Pausada');
    assert.equal((await rpc('sourceConfigGet')).config.capturePaused, true); assert.equal((await rpc('sourceConfigGet')).config.captureLink.campaignId, null);
    await expect(page.locator('[data-action=source-resume-new]')).toBeVisible(); await expect(page.locator('[data-action=source-resume-link]')).toBeVisible(); await expect(page.locator('[data-action=source-keep-paused]')).toBeVisible();
    await page.locator('[data-action=source-keep-paused]').click(); assert.equal((await rpc('sourceConfigGet')).config.capturePaused, true);
    await page.locator('[data-action=source-resume-link]').click(); await page.locator('#source-resume-campaign').selectOption(campaign.id); await page.locator('[data-action=source-save-resume-link]').click();
    await expect(page.locator('#source-resume-link-form')).toHaveCount(0); assert.equal((await rpc('sourceConfigGet')).config.captureLink.campaignId, campaign.id); assert.equal((await rpc('snapshot')).campaigns.find(c => c.id === campaign.id).items[0].caption, caption);
    await rpc('deleteCampaign', { id: campaign.id }); await expect(page.locator('.source-capture-paused')).toBeVisible(); await page.locator('[data-action=source-resume-new]').click();
    await expect.poll(async () => (await rpc('sourceConfigGet')).config.capturePaused).toBe(false); const newId = (await rpc('sourceConfigGet')).config.captureLink.campaignId;
    assert(newId && newId !== campaign.id && newId !== sourceCampaignId); assert.equal((await rpc('snapshot')).campaigns.find(c => c.id === newId).items.length, 0);
    assert.equal((await rpc('sourcePublications', { limit: 100 })).total, 1); assert.equal((await rpc('vitrinePublic')).mode, 'neutral');
    await page.screenshot({ path: path.join(shots, 'origem-retomada-explicita.png'), fullPage: true });
    console.log('PASS: real-mode TV excludes simulation data; deleting linked source campaign closes its live monitor and pauses the link, then explicit existing-link/new-draft actions preserve captions and do not import old publications. Capture remains a controlled simulator.');

    await app.close(); app = null; await launch(); await nav('sources'); await rpc('connect');
    assert.equal((await rpc('sourceConfigGet')).config.captureLink.campaignId, newId); assert.equal((await rpc('sourcePublications', { limit: 100 })).total, 1); assert.equal((await rpc('vitrinePublic')).mode, 'neutral');
    await expect(page.locator('#toast-region')).not.toContainText('Campanha não encontrada'); assert.deepEqual(errors, []);
    console.log('PASS: Electron restart/reconnection retain explicit source binding, preserve one original publication and never recreate deleted campaigns or republish withdrawn TV. No real WhatsApp receipt or physical Windows execution was verified.');
  } catch (error) { if (page) await page.screenshot({ path: path.join(shots, 'failed-vitrine.png'), fullPage: true }).catch(() => {}); throw error; }
  finally { if (app) await app.close(); if (process.env.MEGA_KEEP_TEST_DATA) console.log('Isolated profile:', dir); else fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
