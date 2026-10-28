'use strict';

// This smoke uses the shipped public service configuration and the real desktop
// licensing client. It has no licence bypass, local clock override or server
// administrative credentials. A separately generated test key is optional;
// never pass one of the 120 unused distribution keys to this script.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { _electron, expect } = require('@playwright/test');

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-license-ui-'));
  const screenshots = process.env.MEGA_SCREENSHOT_DIR || '/workspace/scratch/kenned-license-ui-232';
  fs.mkdirSync(screenshots, { recursive: true });
  const errors = []; let app, page;
  const launch = async () => {
    app = await _electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', '--disable-gpu', ...(process.env.MEGA_HEADLESS_TEST ? ['--ozone-platform=headless'] : []), ...(process.env.MEGA_PROXY_TEST ? ['--proxy-server=http://proxy:8080'] : []), process.env.MEGA_APP_PATH || '.'], env: { ...process.env, MEGA_DATA_DIR: profile }, timeout: 30000 });
    await expect.poll(() => { page = app.windows().find(win => /\/ui\/index\.html$/.test(win.url())); return Boolean(page); }, { timeout: 30000 }).toBe(true);
    page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  };
  const rpc = async (action, payload = {}) => {
    const value = await page.evaluate(({ action, payload }) => window.mega.call(action, payload), { action, payload });
    if (value?.error) throw Object.assign(new Error(value.error), { code: value.code }); return value;
  };
  const close = async () => { if (app) { const instance = app; app = null; await instance.evaluate(({ app }) => app.exit(0)).catch(error => { if (!/closed|destroyed/i.test(error.message)) throw error; }); await instance.close().catch(() => {}); } };
  try {
    await launch(); await page.getByRole('heading', { name: 'Cadastre o dono' }).waitFor();
    await expect.poll(async () => (await rpc('licenseStatus')).allowed, { timeout: 30000 }).toBe(true);
    const initial = await rpc('licenseStatus');
    assert(['trial', 'active'].includes(initial.status)); assert(initial.expiresAt > Date.now());
    if (initial.plan === 'trial') assert(Math.abs(initial.expiresAt - initial.trialStartedAt - 72 * 3600000) < 2000);
    await expect(page.locator('#auth-license')).toContainText(initial.plan === 'trial' ? 'Teste gratuito' : 'Licença ativa');
    await page.locator('#auth-license [data-action=license-open]').click();
    await expect(page.locator('.modal h2')).toHaveText('Ativar licença');
    await page.locator('#license-key').fill('INVALID-ISOLATED-UI-TEST'); await page.locator('#license-activation-form [type=submit]').click();
    await expect(page.locator('#license-feedback')).toContainText('Chave inválida');
    await expect(page.locator('#license-feedback')).toContainText('KEY_INVALID');
    await expect(page.locator('#license-key')).toHaveValue('');
    assert(!(await page.locator('body').innerText()).includes('INVALID-ISOLATED-UI-TEST'));
    assert.equal((await rpc('licenseStatus')).expiresAt, initial.expiresAt, 'Invalid key must not extend or reset the existing period');
    await page.getByRole('button', { name: 'Voltar ao acesso' }).click();
    for (const [name, value] of Object.entries({ name: 'Dono Teste Licença', username: 'dono.licenca', password: 'Senha-Licenca-Teste-2026', confirmPassword: 'Senha-Licenca-Teste-2026' })) await page.locator('#auth-form [name=' + name + ']').fill(value);
    await page.locator('#auth-form [type=submit]').click(); await page.getByRole('button', { name: 'Guardei os códigos' }).click();
    await page.getByRole('heading', { name: 'Tudo sob controle' }).waitFor();
    await page.locator('#navigation [data-id=settings]').click();
    await expect(page.locator('#settings-license')).toContainText('Licença do aplicativo');
    await page.locator('#settings-license [data-action=license-open]').click();
    await expect(page.locator('#license-page h1')).toHaveText('Ativar licença');
    await expect(page.locator('#license-page')).toContainText('Brasília');
    await page.locator('#license-key').fill('UNSUBMITTED-KEY-STAYS-WHILE-REFRESHING');
    await rpc('licenseRefresh'); await rpc('snapshot');
    await expect(page.locator('#license-key')).toHaveValue('UNSUBMITTED-KEY-STAYS-WHILE-REFRESHING');
    await page.locator('#license-key').fill('');
    const before = await rpc('snapshot');
    const model = await rpc('saveTemplate', { template: { name: 'Modelo preservado após licença', items: [{ type: 'text', text: 'Texto do teste com *formatação*.' }] } });
    assert(model?.id || model?.template?.id);
    await rpc('saveSettings', { settings: { theme: 'light' } });
    await expect(page.locator('body')).toHaveAttribute('data-theme', 'light');
    assert.deepEqual(await page.locator('.sidebar').evaluate(element => { const style = getComputedStyle(element); return { background: style.backgroundColor, text: style.color }; }), { background: 'rgb(20, 27, 36)', text: 'rgb(237, 243, 251)' });
    const testKeyFile = process.env.KENNED_TEST_LICENSE_KEY_FILE;
    if (testKeyFile) {
      const testKey = fs.readFileSync(testKeyFile, 'utf8').trim(); assert(testKey.length > 20);
      await page.locator('#license-key').fill(testKey); await page.locator('#license-activation-form [type=submit]').click();
      await expect(page.locator('#license-activation-form [type=submit]')).toBeEnabled({ timeout: 30000 });
      await expect.poll(async () => (await rpc('licenseStatus')).plan, { timeout: 30000 }).toBe(testKey.startsWith('KCD-A-') ? 'annual' : 'monthly');
      await expect.poll(async () => (await rpc('licenseStatus')).status, { timeout: 30000 }).toBe('active');
      await expect(page.locator('#license-page')).toContainText('Licença ativa');
      const paid = await rpc('licenseStatus'); assert(['monthly', 'annual'].includes(paid.plan));
      const repeated = await rpc('licenseActivate', { key: testKey }); assert.equal(repeated.expiresAt, paid.expiresAt, 'Repeated activation must not add a second period');
    }
    const preserved = await rpc('snapshot'), status = await rpc('licenseStatus');
    assert.equal(preserved.campaigns.length, before.campaigns.length, 'Activation must not remove or create campaigns');
    assert(preserved.templates.some(template => template.name === 'Modelo preservado após licença'));
    assert.equal(preserved.campaigns.filter(campaign => campaign.state === 'active').length, 0, 'A test or licence must never activate campaigns automatically');
    await page.screenshot({ path: path.join(screenshots, 'licenca-ativacao-real-servico.png'), fullPage: true });
    await close(); await launch(); await page.getByRole('heading', { name: 'Bem-vindo de volta' }).waitFor();
    await expect.poll(async () => (await rpc('licenseStatus')).allowed, { timeout: 30000 }).toBe(true);
    assert.equal((await rpc('licenseStatus')).expiresAt, status.expiresAt, 'Restart must preserve the same server-issued expiry');
    await page.locator('#auth-form [name=username]').fill('dono.licenca'); await page.locator('#auth-form [name=password]').fill('Senha-Licenca-Teste-2026'); await page.locator('#auth-form [type=submit]').click();
    await page.getByRole('heading', { name: 'Tudo sob controle' }).waitFor();
    assert((await rpc('snapshot')).templates.some(template => template.name === 'Modelo preservado após licença'));
    await expect(page.locator('#license-indicator')).toBeVisible(); assert.deepEqual(errors, []);
    console.log('Real desktop licensing UI smoke passed: public hosted service trial, invalid key rejected before login, unchanged expiry, secret-free feedback, local owner registration, Settings licence status, editable key retained during background refresh, dark sidebar/light body, saved template and campaigns retained, no automatic activation, restart retains signed expiry. Optional separate paid test-key activation: ' + Boolean(testKeyFile) + '. This Linux Electron test does not verify physical Windows installation.');
  } catch (error) {
    if (page && !page.isClosed()) console.error('Licensing status at UI failure:', JSON.stringify(await rpc('licenseStatus').catch(error => ({ code: error.code, error: error.message }))));
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(screenshots, 'failed-license-smoke.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally { await close().catch(() => {}); fs.rmSync(profile, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
