'use strict';
// Real Electron renderer, worker, SQLite, native host and HTTPS licensing.
// WhatsApp is the isolated simulation adapter: this proves UI/backend behavior,
// not handset receipt, Windows foreground permission or speaker audibility.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { _electron, expect } = require('@playwright/test');
const { createStore } = require('../src/core/store.cjs');
const { AuthService } = require('../src/core/auth.cjs');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-recovery-ui-'));
  const shots = process.env.MEGA_SCREENSHOT_DIR || path.join(os.tmpdir(), 'kenned-recovery-ui-shots'); fs.mkdirSync(shots, { recursive: true });
  const owner = { username: 'owner-recovery-ui', password: 'Senha-Recovery-Interface-232!', name: 'Dono de teste', phone: '5562999990001' };
  const at = Date.now(), occurrenceId = 'isolated-ui-blocking-incident';
  let prep = await createStore(dir);
  prep.setSetting('initialized', true); prep.setSetting('integrationMode', 'simulated'); prep.setSetting('sound', { enabled: true, volume: 0, persistentAlarm: true, events: ['disconnect', 'critical'], sound: 'urgent', repeat: false, intervalSeconds: 5, maxRepeats: 1, quiet: { enabled: false, start: '22:00', end: '07:00' } });
  await new AuthService({ store: prep }).setupOwner(owner);
  prep.saveNotification({ id: `${occurrenceId}:critical`, occurrenceId, traceId: occurrenceId, at, event: 'critical', title: 'Campanha impedida por erro de teste', reason: 'Destino de teste sem permissão para publicar.', code: 'GROUP_PERMISSION_DENIED', affectedCampaigns: [{ id: 'fixture-campaign', name: 'Campanha isolada de revisão', pending: 4 }], pending: 4, active: true, blocking: true, persistentAlarm: true, muted: false, integrationMode: 'simulated', simulation: true });
  prep.close();
  let app, page; const errors = [];
  const launch = async () => {
    app = await _electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', '--disable-gpu', ...(process.env.MEGA_PROXY_TEST ? ['--proxy-server=http://proxy:8080'] : []), process.env.MEGA_APP_PATH || '.'], env: { ...process.env, MEGA_DATA_DIR: dir }, timeout: 30000 });
    await expect.poll(() => { page = app.windows().find(w => /\/ui\/index\.html$/.test(w.url())); return Boolean(page); }, { timeout: 20000 }).toBe(true);
    page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
    await page.getByRole('heading', { name: 'Bem-vindo de volta' }).waitFor();
    await expect.poll(async () => (await page.evaluate(() => window.mega.call('licenseStatus')))?.allowed, { timeout: 30000 }).toBe(true);
    await page.locator('#auth-form [name=username]').fill(owner.username); await page.locator('#auth-form [name=password]').fill(owner.password); await page.locator('#auth-form [type=submit]').click();
    await page.getByRole('heading', { name: 'Tudo sob controle' }).waitFor();
  };
  const rpc = async (action, payload) => { const result = await page.evaluate(({ action, payload }) => window.mega.call(action, payload), { action, payload }); assert(!result?.error, `${action}: ${JSON.stringify(result)}`); return result; };
  try {
    await launch(); await rpc('licenseRefresh');
    await expect(page.locator('[data-computer-clock=time]')).toBeVisible();
    const time = await page.locator('[data-computer-clock=time]').innerText();
    await expect.poll(() => page.locator('[data-computer-clock=time]').innerText(), { timeout: 4000 }).not.toBe(time);
    assert.equal((await rpc('snapshot')).clock.timezone, await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone));
    await expect(page.locator('.computer-clock')).toContainText('Nenhum horário perdido é acumulado');
    await expect(page.locator('.kc-header-brand')).toBeVisible();
    await expect(page.locator('.kc-header-brand .kc-brand-mark:visible')).toHaveCount(1);
    assert(await page.locator('.kc-header-brand .kc-brand-mark:visible').evaluate(image => image.complete && image.naturalWidth > 0), 'The actual contrast-specific KC identity image must load.');
    console.log('PASS: actual Electron dashboard clock ticks independently and uses OS timezone; professional KC identity is displayed.');

    const banner = page.locator(`[data-incident-id="${occurrenceId}"]`);
    await expect(banner).toContainText('Campanha isolada de revisão'); await expect(banner).toContainText('4 mensagem(ns) pendente(s)');
    await banner.locator('[data-action=incident-details]').click(); await expect(page.locator('.incident-details')).toContainText('GROUP_PERMISSION_DENIED');
    await page.getByRole('button', { name: 'Fechar', exact: true }).last().click();
    await banner.locator('[data-action=silence-alert]').click(); await expect(banner).toContainText('Alarme silenciado');
    await expect(banner).toBeVisible(); await expect(banner.locator('[data-action=silence-alert]')).toHaveCount(0);
    assert((await rpc('snapshot')).notifications.find(value => value.occurrenceId === occurrenceId)?.muted);
    await rpc('connect'); await banner.locator('[data-action=test-connection]').click();
    await expect(page.locator('#toast-region')).toContainText('Esta integração não disponibiliza uma consulta autenticada de teste.');
    const connectionProbe = await rpc('testConnection');
    assert.equal(connectionProbe.ready, true); assert.equal(connectionProbe.verified, false);
    assert.equal(connectionProbe.simulation, true); assert.equal(connectionProbe.code, 'CONNECTION_PROBE_UNSUPPORTED');
    await expect(page.locator('#toast-region')).not.toContainText('Conexão verificada');
    await expect(banner).toBeVisible();
    await page.screenshot({ path: path.join(shots, 'painel-incidente-silenciado.png'), fullPage: true });
    console.log('PASS: persisted blocking incident displays campaign, original error and pending count; silence mutes only its alarm, retains visual details, and test connection uses backend IPC with an explicit unsupported-authenticated-probe limitation for the simulation adapter. Connected state does not conceal a critical unresolved incident.');

    await page.locator('#navigation [data-id=settings]').click();
    await expect(page.locator('[name=persistentAlarm]')).toBeChecked();
    await page.locator('[name=reconnectEnabled]').check(); await page.locator('[name=autoResume]').check();
    await page.locator('[name=reconnectMaxAttempts]').fill('5'); await page.locator('[name=reconnectDelaySeconds]').fill('5'); await page.locator('[name=reconnectMaxDelaySeconds]').fill('120');
    await page.locator('#sound-volume').fill('37'); await page.locator('#sound-volume').dispatchEvent('input');
    await page.locator('#settings-form [type=submit]').click();
    await expect.poll(async () => (await rpc('snapshot')).settings.reconnect.policyVersion).toBe(2);
    let snapshot = await rpc('snapshot'); assert.equal(snapshot.settings.reconnect.maxDelaySeconds, 120); assert.equal(snapshot.settings.reconnect.autoResume, true); assert.equal(snapshot.settings.sound.volume, 37); assert.equal(snapshot.settings.sound.persistentAlarm, true);
    await rpc('saveAlertRecipient', { recipient: { name: 'Responsável isolado', phone: owner.phone, enabled: true } });
    await rpc('resumeAutomation'); // Explicit authorization in this isolated fixture only.
    await page.locator('#navigation [data-id=dashboard]').click(); await page.locator('#navigation [data-id=settings]').click();
    await expect(page.locator('[name=systemAlertRecipientIds]')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Testar envio de alerta', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Testar envio de alerta', exact: true }).click();
    await expect(page.locator('#toast-region')).toContainText(/aceito pela integração|Pendente|Falhou|Incerto/);
    const alerts = await rpc('alertsPage', { limit: 50 }); assert(alerts.items.some(item => item.number === owner.phone && item.simulation === true));
    await page.screenshot({ path: path.join(shots, 'configuracoes-recuperacao-alarme.png'), fullPage: true });
    console.log('PASS: progressive reconnect policy, bounded attempts, safe next-slot auto-resume, volume 37% and continuous alarm persist via backend; per-responsible alert test uses durable simulation delivery records rather than optimistic queue success.');

    // All probe actions below traverse the actual renderer/preload/worker APIs.
    // Fixture publications remain in this disposable simulation profile only.
    await rpc('refreshGroups');
    const sourceGroup = 'sim-01@simulation';
    await rpc('sourceConfigSave', { config: { enabled: true, groupId: sourceGroup, allowedParticipantIds: [owner.phone], allowOwnMessages: true } });
    await page.locator('#navigation [data-id=sources]').click();
    await expect(page.locator('.source-capture-diagnostics')).toContainText(sourceGroup);
    await page.locator('[data-action=source-test-capture]').click();
    await expect.poll(async () => (await rpc('sourceConfigGet')).metrics.testCapture?.status).toBe('waiting');
    await expect(page.locator('.source-capture-diagnostics')).toContainText('Aguardando nova publicação autorizada');
    const sourceProbe = (await rpc('sourceConfigGet')).metrics.testCapture;
    assert.equal(sourceProbe.checks.listenerAttached, true); assert.equal(sourceProbe.checks.groupAccessConfirmed, true);
    assert.equal(sourceProbe.checks.allowOwnMessages, true);
    await expect(page.locator('.source-capture-diagnostics')).not.toContainText('Captura confirmada');
    await page.locator('[data-action=source-sync-now]').click();
    await expect.poll(async () => (await rpc('sourceConfigGet')).metrics.lastSyncAt).toBeGreaterThan(0);
    assert.equal((await rpc('snapshot')).campaigns.length, 0, 'Preparing capture/synchronization must not create or activate a campaign.');
    await page.screenshot({ path: path.join(shots, 'origem-teste-captura-aguardando.png'), fullPage: true });
    console.log('PASS: source probe UI verifies configured group ID, live event subscription and own-message permission; remains Waiting until an authorized publication is persisted, synchronization does not invent history or activate campaigns.');

    await rpc('saveSearchSettings', { settings: { enabled: true, monitoredGroupIds: [sourceGroup], commandGroupIds: [], privateCommandsEnabled: true, commandPrivateNumbers: [owner.phone] } });
    await page.locator('#navigation [data-id=buscas]').click();
    await expect(page.locator('#buscas-monitor-status')).toContainText('1 grupos monitorados');
    await page.locator('[data-action=buscas-test-capture]').click();
    await expect.poll(async () => (await rpc('searchesState')).monitor.captureProbe?.status).toBe('waiting');
    await expect(page.locator('#buscas-monitor-status')).toContainText('Teste de captura aguardando publicação nova');
    const listText = 'iPhone 15 Pro Max 256GB Azul seminovo R$ 3.850,00\niPhone 15 Pro 256GB Azul seminovo R$ 3.000,00\niPhone 15 Pro Max 256GB Azul entrada 500 + 12x R$ 700';
    await rpc('testSearchSimulation', { kind: 'offer', groupId: sourceGroup, messageId: 'ISOLATED-GUI-CAPTURE-PROBE', text: listText, senderNumber: '5562999990002', supplierName: 'Fornecedor fictício isolado' });
    await expect.poll(async () => (await rpc('searchesState')).monitor.captureProbe?.status).toBe('captured');
    await expect(page.locator('#buscas-monitor-status')).toContainText('Captura confirmada: mensagem ISOLATED-GUI-CAPTURE-PROBE');
    const capturedState = await rpc('searchesState'); assert.equal(capturedState.stats.messages, 1); assert.equal(capturedState.stats.offers, 3);
    await page.locator('[data-action=buscas-synchronize]').click();
    await expect.poll(async () => (await rpc('searchesState')).monitor.lastSyncAt).toBeGreaterThan(0);
    assert.equal((await rpc('searchesState')).stats.messages, 1, 'Synchronizing cannot duplicate the captured source message.');
    await page.screenshot({ path: path.join(shots, 'buscas-captura-confirmada-simulacao.png'), fullPage: true });
    console.log('PASS: BUSCAS probe UI starts Waiting, confirms only after the controlled simulator event is actually persisted/indexed, displays original message ID and counters, and re-synchronizes without duplicating messages. No real account or handset is connected.');

    await app.close(); app = null; await launch();
    snapshot = await rpc('snapshot'); assert.equal(snapshot.settings.sound.persistentAlarm, true); assert.equal(snapshot.settings.sound.volume, 37); assert.equal(snapshot.settings.reconnect.policyVersion, 2); assert.equal(snapshot.alertRecipients.length, 1);
    await expect(page.locator(`[data-incident-id="${occurrenceId}"]`)).toContainText('Alarme silenciado');
    await app.close(); app = null;
    prep = await createStore(dir); const original = prep.getEntity('notifications', `${occurrenceId}:critical`); prep.saveNotification({ ...original, active: false, resolvedAt: Date.now(), recoveredAt: Date.now() }); prep.close();
    await launch(); await expect(page.locator(`[data-incident-id="${occurrenceId}"]`)).toHaveCount(0);
    assert.deepEqual(errors, []);
    console.log('PASS: restart preserves sound, recipients, reconnect preferences and per-incident silence; a recorded recovery removes its active banner. No real WhatsApp receipt or physical Windows foreground/sound claimed.');
  } finally { if (app) await app.close(); if (process.env.MEGA_KEEP_TEST_DATA) console.log('Isolated test profile:', dir); else fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
