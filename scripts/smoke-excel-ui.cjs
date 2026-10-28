'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { _electron, expect } = require('@playwright/test');
const ExcelJS = require('exceljs');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-excel-ui-'));
  const shots = process.env.MEGA_SCREENSHOT_DIR || '/workspace/scratch/kenned-excel-ui-231';
  fs.mkdirSync(shots, { recursive: true });
  let app, page; const errors = [];
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', '--disable-gpu', process.env.MEGA_APP_PATH || '.'], env: { ...process.env, MEGA_DATA_DIR: dir }, timeout: 30000 });
    await expect.poll(() => { page = app.windows().find(w => /\/ui\/index\.html$/.test(w.url())); return !!page; }, { timeout: 30000 }).toBe(true);
    page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
    const rpc = async (action, payload) => { const value = await page.evaluate(({ action, payload }) => window.mega.call(action, payload), { action, payload }); if (value?.error) throw new Error(action + ': ' + value.error); return value; };
    await page.getByRole('heading', { name: 'Cadastre o dono' }).waitFor();
    for (const [key, value] of Object.entries({ name: 'Dono Excel', username: 'dono.excel', password: 'SenhaExcel-Teste-2026', confirmPassword: 'SenhaExcel-Teste-2026', phone: '5511999999001' })) await page.locator('#auth-form [name=' + key + ']').fill(value);
    await page.locator('#auth-form [type=submit]').click(); await page.getByRole('button', { name: 'Guardei os códigos' }).click();
    await page.getByRole('heading', { name: 'Tudo sob controle' }).waitFor();
    const first = await rpc('snapshot'), ownerId = first.auth.user.id, groupId = first.groups[0].id;
    await rpc('saveSearchSettings', { settings: { enabled: true, monitoredGroupIds: [groupId], maxAgeEnabled: true, maxAgeValue: 2, maxAgeUnit: 'hours', recipientMode: 'owner', ownerRecipientUserId: ownerId } });
    const now = Date.now(), messages = Array.from({ length: 121 }, (_, i) => ({ groupId, messageId: 'excel-offer-' + i, senderNumber: '5511' + String(970000000 + i), supplierName: 'Fornecedor ' + i, timestamp: now - i * 1000, text: 'iPhone 15 Pro Max 256GB Azul seminovo bateria 85% R$ ' + (3000 + i).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) + ' à vista' }));
    for (let offset = 0; offset < messages.length; offset += 50) await rpc('testSearchSimulation', { messages: messages.slice(offset, offset + 50) });
    await rpc('testSearchSimulation', { messages: [{ groupId, messageId: 'excel-installment', senderNumber: '5511970000200', text: 'iPhone 15 Pro Max 256GB Azul 12x R$ 299,00 entrada R$ 500,00' }, { groupId, messageId: 'excel-different-model', senderNumber: '5511970000201', text: 'iPhone 15 Pro 256GB Azul R$ 1.000,00 à vista' }] });
    await page.locator('#navigation [data-id=buscas]').click(); await page.getByRole('heading', { name: 'BUSCAS', exact: true }).waitFor();
    await page.locator('#buscas-query').fill('iPhone 15 Pro Max 256GB'); await page.locator('#buscas-query-form [type=submit]').click();
    await expect(page.locator('#buscas-results .buscas-offer')).toHaveCount(50);
    await expect(page.locator('#buscas-results')).toContainText('121 oferta(s) compatíveis');
    await page.locator('[data-offer-select]').first().check(); await page.locator('[data-action=buscas-result-next]').click();
    await expect(page.locator('#buscas-results .buscas-offer')).toHaveCount(50); await page.locator('[data-offer-select]').nth(25).check();
    await expect(page.locator('[data-offer-selection-count]')).toHaveText('2 oferta(s) selecionada(s) em todas as páginas');
    await page.locator('[data-action=buscas-result-prev]').click(); await expect(page.locator('[data-offer-select]').first()).toBeChecked();
    const selectedPath = path.join(dir, 'selected.xlsx');
    await app.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename }); }, selectedPath);
    await page.locator('[data-action=buscas-export-options]').click(); await page.locator('[data-action=buscas-export-excel]').click();
    await expect.poll(() => fs.existsSync(selectedPath)).toBe(true);
    const selected = new ExcelJS.Workbook(); await selected.xlsx.readFile(selectedPath);
    assert.equal(selected.getWorksheet('Ofertas').rowCount, 3, 'Two selected offers exported across two pages');
    const allPath = path.join(dir, 'all.xlsx');
    await app.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename }); }, allPath);
    await page.locator('[data-action=buscas-export-options]').click(); await page.locator('#buscas-list-form [name=selection]').selectOption('all'); await page.locator('[data-action=buscas-export-excel]').click();
    await expect.poll(() => fs.existsSync(allPath)).toBe(true);
    const all = new ExcelJS.Workbook(); await all.xlsx.readFile(allPath);
    const sheet = all.getWorksheet('Ofertas'); assert.equal(sheet.rowCount, 122, 'All 121 filtered matches exported, including pages not viewed');
    assert.equal(sheet.getRow(2).getCell(8).value, 3000); assert.equal(sheet.getRow(122).getCell(8).value, 3120);
    assert.equal(typeof sheet.getRow(2).getCell(11).value, 'string'); assert.match(sheet.getRow(2).getCell(11).value, /^5511\d+$/);
    assert.equal(sheet.views[0].ySplit, 1); assert(sheet.autoFilter); assert(all.getWorksheet('Informações')); assert(sheet.getColumn(11).width >= 20);
    await page.locator('[data-action=buscas-deliver]').click(); await page.locator('#buscas-list-form [name=selection]').selectOption('all');
    await page.locator('#buscas-list-form [name=format]').selectOption('text'); await page.locator('[data-action=buscas-preview-list]').click();
    await expect(page.locator('.buscas-preview-pagination')).toContainText('Parte 1 de');
    const totalParts = Number((await page.locator('.buscas-preview-pagination > span').textContent()).match(/de (\d+)/)[1]);
    assert(totalParts > 2, 'The full preview must be accessible beyond the first two text parts');
    for (let part = 2; part <= totalParts; part++) { await page.locator('[data-action=buscas-preview-part-next]').click(); await expect(page.locator('.buscas-preview-pagination > span')).toHaveText('Parte ' + part + ' de ' + totalParts); }
    await expect(page.locator('#buscas-list-preview-text')).toContainText('Fornecedor 120');
    assert.equal((await rpc('searchRecipientStatus')).deliveries.total, 0, 'Navigating the full preview must never queue a delivery');
    await page.locator('[data-action=buscas-back-list-options]').click(); await page.locator('#buscas-list-form [name=selection]').selectOption('selected');
    await page.locator('#buscas-list-form [name=format]').selectOption('both'); await page.locator('[data-action=buscas-preview-list]').click();
    await expect(page.locator('.modal')).toContainText('2 oferta(s)'); await expect(page.locator('.modal')).toContainText('5511999999001');
    const before = await rpc('searchRecipientStatus'); assert.equal(before.deliveries.total, 0, 'Preview must not send');
    await page.locator('[data-action=buscas-confirm-list]').click();
    await expect.poll(async () => (await rpc('searchRecipientStatus')).deliveries.items.filter(d => d.manualList && d.status === 'confirmed').length).toBe(2);
    await page.locator('[data-action=buscas-refresh-list-delivery]').click(); await expect(page.locator('#main')).toContainText('Enviado — aceito pela integração');
    const sent = (await rpc('searchRecipientStatus')).deliveries.items.filter(d => d.manualList);
    assert(sent.every(d => d.target === '5511999999001@s.whatsapp.net')); assert.equal(sent.filter(d => d.kind === 'document').length, 1);
    assert(sent.every(d => !d.deliveredAt), 'Simulation acceptance is not real delivery');
    await page.screenshot({ path: path.join(shots, 'buscas-excel-selecionados-e-lista.png'), fullPage: true });
    await page.locator('[data-action=buscas-clear-offers]').click(); await expect(page.locator('[data-offer-selection-count]')).toHaveText('0 oferta(s) selecionada(s) em todas as páginas');
    await page.locator('[data-action=logout]').click(); await page.getByRole('heading', { name: 'Bem-vindo de volta' }).waitFor();
    assert.equal(await page.locator('[data-offer-select]').count(), 0); assert.deepEqual(errors, []);
    console.log('Excel GUI Electron isolated simulation: 121 true filtered results across pages, selected IDs retained, 2-row selected and 121-row all XLSX opened with numeric BRL/text phones/freeze/filter/metadata, all text parts reviewed through the last supplier without queuing, explicit preview before text+document private queue, accepted versus delivered and logout reset passed. No real WhatsApp account or cellphone receipt tested.');
  } catch (error) {
    if (page && !page.isClosed()) { console.error('Last isolated-test UI notice:', await page.locator('#toast').textContent().catch(() => 'unavailable')); await page.screenshot({ path: path.join(shots, 'failed-excel-smoke.png'), fullPage: true }).catch(() => {}); }
    throw error;
  } finally { if (app) await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
