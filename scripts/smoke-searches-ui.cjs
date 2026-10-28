'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { _electron, expect } = require('@playwright/test');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-buscas-ui-'));
  const shots = process.env.MEGA_SCREENSHOT_DIR || '/workspace/scratch/buscas-ui';
  fs.mkdirSync(shots, { recursive: true });
  let app; const errors = [];
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', '--disable-gpu', process.env.MEGA_APP_PATH || '.'], env: { ...process.env, MEGA_DATA_DIR: dir }, timeout: 20000 });
    let page; await expect.poll(() => { page = app.windows().find(w => /\/ui\/index\.html$/.test(w.url())); return !!page; }, { timeout: 20000 }).toBe(true);
    page.on('pageerror', err => errors.push(err.message));
    page.on('dialog', dialog => dialog.accept());
    const rpc = (action, payload) => page.evaluate(({ action, payload }) => window.mega.call(action, payload), { action, payload });
    await page.getByRole('heading', { name: 'Cadastre o dono' }).waitFor();
    for (const [key, value] of Object.entries({ name: 'Dono BUSCAS', username: 'dono.buscas', password: 'SenhaBuscas-Teste-2026', confirmPassword: 'SenhaBuscas-Teste-2026', phone: '5511999999999' })) await page.locator('#auth-form [name=' + key + ']').fill(value);
    await page.locator('#auth-form [type=submit]').click();
    await page.getByRole('button', { name: 'Guardei os códigos' }).click();
    await page.getByRole('heading', { name: 'Tudo sob controle' }).waitFor();
    const original = await rpc('snapshot');
    assert.equal(original.campaigns[0].state, 'draft');
    assert.equal(original.buscas.enabled, false);
    const groupId = original.groups[0].id;
    await page.locator('#navigation [data-id=buscas]').click();
    await page.getByRole('heading', { name: 'BUSCAS', exact: true }).waitFor();
    await page.locator('[data-action=buscas-tab][data-id=setup]').click();
    assert.equal(await page.locator('[name=prefix]').inputValue(), '!busca');
    assert.equal(await page.locator('[name=aliases]').inputValue(), 'prata=silver');
    await page.locator('[name=enabled]').check();
    await page.locator('[name=monitoredGroupIds]').first().check();
    await page.locator('[name=commandGroupIds]').first().check();
    await page.locator('[name=prefix]').fill('!oferta');
    await expect(page.locator('#buscas-prefix-example')).toHaveText('!oferta 18 pro Max Silver');
    await page.waitForTimeout(1200);
    assert.equal(await page.locator('[name=prefix]').inputValue(), '!oferta', 'Atualizações não sobrescrevem configuração em edição');
    await page.locator('#buscas-settings-form [type=submit]').click();
    await expect.poll(async () => (await rpc('searchesState')).settings.prefix).toBe('!oferta');
    await page.locator('[data-action=buscas-tab][data-id=query]').click();
    await page.locator('#buscas-simulation-form [type=submit]').click();
    await expect.poll(async () => (await rpc('searchOffers', { limit: 50 })).total).toBe(1);
    const fixture = await rpc('testSearchSimulation', { messages: [
      { groupId, messageId: 'offer-cheap', senderNumber: '5511988888888', supplierName: 'Fornecedor B', text: 'iPhone 18 Pro Max 256GB Silver lacrado R$ 6.700,00 à vista' },
      { groupId, messageId: 'installment', senderNumber: '5511977777777', text: 'iPhone 18 Pro Max 256GB Silver 12x R$ 699,00 entrada R$ 1.000,00' },
      { groupId, messageId: 'different-model', senderNumber: '5511966666666', text: 'iPhone 18 Pro 256GB Silver lacrado R$ 6.000,00 à vista' },
      { groupId, messageId: 'ambiguous-price', senderNumber: '5511955555555', text: 'iPhone 18 Pro Max 256GB Silver lacrado R$ 6.900,00 ou R$ 7.100,00' }
    ] }); assert.equal(fixture.simulation, true);
    await page.locator('#buscas-query').fill('!oferta 18 pro Max Silver');
    await page.locator('#buscas-query-form [type=submit]').click();
    await expect(page.locator('#buscas-results .buscas-offer')).toHaveCount(2);
    const cards = await page.locator('#buscas-results .buscas-price').allTextContents();
    assert(cards[0].includes('6.700')); assert(cards[1].includes('7.000'));
    await page.locator('#buscas-results [data-action=buscas-original]').first().click();
    await expect(page.locator('.summary-pre')).toContainText('6.700,00');
    await page.locator('[data-action=buscas-close]').click();
    await page.locator('[data-action=buscas-deliver]').click();
    await expect.poll(async () => (await rpc('searchHistory', { limit: 50 })).total).toBeGreaterThanOrEqual(2);
    const reply = await rpc('testSearchSimulation', { kind: 'command', isGroup: true, chatId: groupId, senderNumber: '5511999999999', text: '!OFERTA 18 pro Max Silver' });
    assert(reply.replies.some(r => (r.privateNumber === '5511999999999' || r.targetId === '5511999999999@s.whatsapp.net') && r.status === 'confirmed'));
    assert(reply.replies.every(r => r.targetId !== groupId));
    const help = await rpc('testSearchSimulation', { kind: 'command', isGroup: true, chatId: groupId, senderNumber: '5511999999999', text: '!oferta' });
    assert(help.replies.some(r => r.text.includes('Use !oferta')));
    await page.evaluate(()=>window.scrollTo(0,0)); await page.screenshot({ path: path.join(shots, 'buscas-resultados.png'), fullPage:true });
    await page.locator('[data-action=buscas-tab][data-id=offers]').click();
    await expect(page.locator('.buscas-offer')).toHaveCount(5);
    assert(await page.locator('.buscas-review').count() >= 1);
    await page.locator('[data-action=buscas-tab][data-id=history]').click();
    await expect(page.locator('#main tbody tr')).toHaveCount(4);
    await page.locator('[data-action=buscas-tab][data-id=people]').click();
    await page.getByRole('heading', { name: 'Pessoas autorizadas' }).waitFor();
    await page.locator('[data-action=buscas-tab][data-id=data]').click();
    await page.locator('[data-action=buscas-cleanup-history]').click();
    await page.locator('#buscas-cleanup-form [name=confirmation]').fill('ERRADO');
    await page.locator('[data-action=buscas-confirm-cleanup]').click();
    assert((await rpc('searchHistory', { limit: 50 })).total > 0);
    await page.locator('#buscas-cleanup-form [name=confirmation]').fill('APAGAR');
    await page.locator('[data-action=buscas-confirm-cleanup]').click();
    await page.locator('.modal').waitFor({ state: 'hidden' });
    assert.equal((await rpc('searchHistory', { limit: 50 })).total, 0);
    assert.equal((await rpc('searchOffers', { includeReview: true, limit: 50 })).total, 5);
    await page.locator('[data-action=buscas-cleanup-base]').click();
    await page.locator('#buscas-cleanup-form [name=confirmation]').fill('APAGAR');
    await page.locator('[data-action=buscas-confirm-cleanup]').click();
    await page.locator('.modal').waitFor({ state: 'hidden' });
    assert.equal((await rpc('searchOffers', { limit: 50 })).total, 0);
    const after = await rpc('snapshot');
    assert.deepEqual(after.campaigns.map(c => [c.id, c.state]), original.campaigns.map(c => [c.id, c.state]));
    assert.equal(after.groups.length, original.groups.length);
    await page.locator('[data-action=logout]').click();
    await page.getByRole('heading', { name: 'Bem-vindo de volta' }).waitFor();
    assert.equal(await page.locator('#buscas-results').count(), 0);
    assert((await rpc('searchesState')).error, 'Backend bloqueia BUSCAS sem login');
    assert.deepEqual(errors, []);
    console.log('BUSCAS GUI real Electron: módulo desativado, 7 abas, grupos independentes, prefixo atualizado, edição preservada, captura simulada, ranking sem parcelas/versões diferentes, mensagem original, entrega privada ao dono confirmada, comando vazio, ofertas para revisão, histórico, duas limpezas APAGAR, campanhas/grupos preservados e logout protegido passaram.');
  } finally {
    if (app) await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
