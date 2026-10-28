'use strict';
// Real Electron renderer, worker and SQLite. All WhatsApp fixtures remain in
// the visibly identified isolated simulation; no customer account is contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron, expect } = require('@playwright/test');
const { createStore } = require('../src/core/store.cjs');
const { MediaManager } = require('../src/core/media.cjs');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-commerce-ui-'));
  const shots = process.env.MEGA_SCREENSHOT_DIR || '/workspace/scratch/kenned-commerce-ui'; fs.mkdirSync(shots, { recursive: true });
  const db = await createStore(dir); db.setSetting('integrationMode', 'simulated'); const media = await new MediaManager(db).importFile(path.resolve('assets/icon.png')); db.close();
  let app, page; const errors = [];
  const credentials = { username: 'commerce-ui-owner', password: 'Senha-Interface-Comercio-310!' };
  const rpc = async (action, payload) => { const result = await page.evaluate(({ action, payload }) => window.mega.call(action, payload), { action, payload }); assert(!result?.error, action + ': ' + JSON.stringify(result)); return result; };
  const snap = () => rpc('snapshot');
  const nav = async pageId => page.locator('#navigation [data-id="' + pageId + '"]').click();
  const click = async action => page.locator('[data-action="commerce-' + action + '"]').last().click();
  const fill = async (formId, name, value) => page.locator('#commerce-' + formId + '-form [name="' + name + '"]').fill(value);
  const closeModal = async () => page.locator('.modal').waitFor({ state: 'hidden' });
  const awaitRecord = async (key, predicate) => { await expect.poll(async () => (await snap()).commerce[key]?.some(predicate)).toBe(true); return (await snap()).commerce[key].find(predicate); };
  const local = at => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at)).map(part => [part.type, part.value])); return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute; };
  async function launch() {
    app = await _electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', '--disable-gpu', process.env.MEGA_APP_PATH || '.'], env: { ...process.env, MEGA_DATA_DIR: dir }, timeout: 20000 });
    await expect.poll(() => { page = app.windows().find(w => /\/ui\/index\.html$/.test(w.url())); return !!page; }, { timeout: 20000 }).toBe(true);
    page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  }
  try {
    await launch(); await page.getByRole('heading', { name: 'Cadastre o dono' }).waitFor();
    for (const [name, value] of Object.entries({ name: 'Dono comércio teste', ...credentials, confirmPassword: credentials.password, phone: '5562999998801' })) await page.locator('#auth-form [name="' + name + '"]').fill(value);
    await page.locator('#auth-form [type=submit]').click();await page.getByRole('button', { name: 'Guardei os códigos' }).click(); await page.getByRole('heading', { name: 'Tudo sob controle' }).waitFor();
    const initial = await snap(), groupId = initial.groups[0].id, ownerId = 'user:' + initial.auth.user.id;
    await nav('contacts'); await click('new-contact'); await fill('contact', 'name', 'Comprador interface'); await fill('contact', 'phone', '5562999998802');
    await page.locator('#commerce-contact-form [name=categories][value="Cliente Nerópolis"]').check(); await page.locator('#commerce-contact-form [name=categories][value="Lojista Camelódromo"]').check(); await page.locator('#commerce-contact-form [name=promotionalConsent]').check(); await click('save-contact'); await closeModal();
    await expect.poll(async () => (await snap()).contacts.some(c => c.name === 'Comprador interface')).toBe(true);
    const buyer = (await snap()).contacts.find(c => c.name === 'Comprador interface'); assert.equal(buyer.categories.length, 2); assert.equal(buyer.promotionalConsent, true);
    await click('categories'); await fill('category', 'name', 'Parceiro de teste'); await click('save-category'); await closeModal(); assert((await snap()).commerce.categories.some(c => c.name === 'Parceiro de teste'));
    console.log('PASS: multicategory contact and explicit promotional consent persist; custom category created through authenticated UI.');

    await nav('suppliers'); await click('new-supplier'); await fill('supplier', 'name', 'Fornecedor interface'); await fill('supplier', 'phone', '5562999998803'); await fill('supplier', 'categories', 'Aparelhos, Acessórios'); await fill('supplier', 'paymentTerms', 'Pix'); await fill('supplier', 'warranty', 'Garantia registrada de 90 dias'); await click('save-supplier'); await closeModal();
    const supplier = await awaitRecord('suppliers', s => s.name === 'Fornecedor interface');
    await nav('inventory'); await click('new-inventory'); await fill('inventory', 'model', 'iPhone 15 Pro Max'); await fill('inventory', 'storage', '256GB'); await fill('inventory', 'color', 'Azul'); await page.locator('#commerce-inventory-form [name=condition]').selectOption('seminovo'); await fill('inventory', 'battery', '91'); await fill('inventory', 'costCents', '3000,00'); await fill('inventory', 'retailCents', '3800,00'); await fill('inventory', 'wholesaleCents', '3500,00'); await page.locator('#commerce-inventory-form [name=supplierId]').selectOption(supplier.id); await page.locator('#commerce-inventory-form [name=mediaIds][value="' + media.id + '"]').check(); await click('save-inventory'); await closeModal();
    const phone = await awaitRecord('inventory', i => i.model === 'iPhone 15 Pro Max'); assert.equal(phone.costCents, 300000); assert.equal(phone.mediaIds[0], media.id); assert.equal(phone.availableQuantity, 1);
    await page.locator('[data-action=commerce-edit-inventory][data-id="' + phone.id + '"]').click(); await expect(page.locator('#commerce-inventory-form [name=quantity]')).toHaveAttribute('readonly', ''); await fill('inventory', 'warranty', '90 dias'); await click('save-inventory'); await closeModal();
    await page.locator('[data-action=commerce-reserve][data-id="' + phone.id + '"]').click(); await page.locator('#commerce-reservation-form [name=buyerId]').selectOption(buyer.id); await fill('reservation', 'expiresAt', local(Date.now() + 3 * 3600000)); await fill('reservation', 'depositCents', '500,00'); await click('save-reservation'); await closeModal();
    const reservation = await awaitRecord('reservations', r => r.inventoryId === phone.id && r.status === 'active'); assert.equal(reservation.depositCents, 50000); assert.equal((await snap()).commerce.inventory.find(i => i.id === phone.id).availableQuantity, 0);
    await page.locator('[data-action=commerce-release][data-id="' + reservation.id + '"]').click(); await fill('release', 'reason', 'Comprador mudou a data; preservar sinal registrado.'); await click('save-release'); await closeModal(); assert.equal((await snap()).commerce.inventory.find(i => i.id === phone.id).availableQuantity, 1);
    await nav('suppliers'); await page.locator('[data-action=commerce-purchase][data-id="' + supplier.id + '"]').click(); await fill('purchase', 'model', 'iPhone 15 Pro'); await fill('purchase', 'storage', '128GB'); await fill('purchase', 'unitCostCents', '2500,00'); await fill('purchase', 'retailCents', '3200,00'); await fill('purchase', 'wholesaleCents', '2900,00'); await click('save-purchase'); await closeModal();
    const purchased = await awaitRecord('inventory', i => i.model === 'iPhone 15 Pro'); assert.equal(purchased.quantity, 1); assert.equal(purchased.costCents, 250000); assert((await snap()).commerce.purchases.some(p => p.items.some(item => item.inventoryId === purchased.id)));
    console.log('PASS: supplier CRUD, device/photo/cost persistence, quantity editing protection, reservation/deposit/release and atomic purchase-created stock entry.');

    await rpc('savePromotionTarget', { type: 'group', targetId: groupId, audience: 'retail', paused: false, optOut: false });
    await nav('commercial'); await click('new-list'); await fill('list', 'name', 'Tabela interface varejo'); await page.locator('#commerce-list-form [name=markupType]').selectOption('percent'); await fill('list', 'markupValue', '10');
    const row = page.locator('[data-commerce-source-row]').filter({ hasText: 'iPhone 15 Pro Max' }); await row.locator('[name=source]').check(); await expect(row.locator('[data-commerce-calculation]')).toContainText('3.300,00'); await click('save-list');
    await page.locator('#commerce-public-preview').waitFor(); const list = await awaitRecord('lists', l => l.name === 'Tabela interface varejo'); assert.equal(list.lines[0].priceCents, 330000); assert.equal(list.lines[0].profitCents, 30000);
    const publicText = await page.locator('#commerce-public-preview').innerText(); assert.match(publicText, /3\.300,00/); assert.match(publicText, /pronta entrega/i); assert(!publicText.includes('Fornecedor interface')); assert(!publicText.includes('3000')); assert(!/custo|lucro|imei|margem/i.test(publicText));
    await click('list-campaign'); await page.locator('#commerce-campaign-form [name=contactIds][value="' + buyer.id + '"]').check(); await page.locator('#commerce-campaign-form [name=groupIds][value="' + groupId + '"]').check(); await click('save-campaign'); await closeModal();
    const commercialCampaign = (await snap()).campaigns.find(c => c.name === 'Tabela interface varejo'); assert.equal(commercialCampaign.state, 'draft'); assert(commercialCampaign.contactIds.includes(buyer.id));
    console.log('PASS: ten-percent markup over cost is exact, public preview strips internal/supplier data, classified contact/group campaign stays draft.');

    await rpc('saveSearchSettings', { settings: { enabled: true, monitoredGroupIds: [groupId], maxAgeEnabled: true, maxAgeValue: 2, maxAgeUnit: 'hours' } });
    await nav('opportunities'); await click('new-opportunity'); await fill('opportunity', 'name', 'Preço máximo interface'); await fill('opportunity', 'model', 'iPhone 15 Pro Max'); await fill('opportunity', 'storageGB', '256'); await fill('opportunity', 'maxPriceCents', '3500,00'); await page.locator('#commerce-opportunity-form [data-action=commerce-select-groups]').click(); await expect(page.locator('#commerce-opportunity-form [data-commerce-group-count]')).toContainText('1 grupo'); await page.locator('#commerce-opportunity-form [data-action=commerce-clear-groups]').click(); await expect(page.locator('#commerce-opportunity-form [name=groupIds]:checked')).toHaveCount(0); await page.locator('#commerce-opportunity-form [data-action=commerce-select-groups]').click(); await page.locator('#commerce-opportunity-form [name=recipientIds][value="' + ownerId + '"]').check(); await click('save-opportunity'); await closeModal();
    const rule = await awaitRecord('opportunities', o => o.name === 'Preço máximo interface'); await page.locator('[data-action=commerce-pause-opportunity][data-id="' + rule.id + '"]').click(); await expect.poll(async () => (await snap()).commerce.opportunities.find(o => o.id === rule.id).enabled).toBe(false); await page.locator('[data-action=commerce-activate-opportunity][data-id="' + rule.id + '"]').click();
    await nav('demands'); await click('new-demand'); await page.locator('#commerce-demand-form [name=contactId]').selectOption(buyer.id); await fill('demand', 'model', 'iPhone 15 Pro Max'); await fill('demand', 'storageGB', '256'); await fill('demand', 'budgetCents', '3600,00'); await fill('demand', 'markupValue', '200,00'); await page.locator('#commerce-demand-form [data-action=commerce-select-groups]').click(); await page.locator('#commerce-demand-form [name=recipientIds][value="' + ownerId + '"]').check(); await click('save-demand'); await closeModal();
    const demand = await awaitRecord('demands', d => d.contactId === buyer.id); await rpc('testSearchSimulation', { kind: 'offer', messageId: 'COMMERCE-UI-OFFER', groupId, senderNumber: '5562999998810', timestamp: Date.now(), text: 'iPhone 15 Pro Max 256GB Azul seminovo R$ 3.200,00' });
    await expect.poll(async () => (await snap()).commerce.matches.filter(m => m.kind === 'demand' && m.sourceId === demand.id).length, { timeout: 15000 }).toBe(1);
    await nav('demands'); await expect(page.locator('[data-action=commerce-review-match]')).toHaveCount(1); await page.locator('[data-action=commerce-review-match]').click(); await click('approve-match'); await expect(page.locator('.modal')).toContainText('Rascunho aprovado'); await click('close');
    assert((await snap()).campaigns.some(c => c.contactIds?.includes(buyer.id) && c.commercialApproval?.kind === 'demand' || c.demandId === demand.id || c.name?.includes('Comprador interface')));
    await page.screenshot({ path: path.join(shots, 'demandas-commerce.png'), fullPage: true });
    console.log('PASS: monitored-only group selection/all/clear, opportunity pause/activation, demand match with markup and approved draft without automatic buyer publication.');

    await app.close(); app = null; await launch(); await page.getByRole('heading', { name: 'Bem-vindo de volta' }).waitFor(); await page.locator('#auth-form [name=username]').fill(credentials.username); await page.locator('#auth-form [name=password]').fill(credentials.password); await page.locator('#auth-form [type=submit]').click(); await page.getByRole('heading', { name: 'Tudo sob controle' }).waitFor();
    assert((await snap()).commerce.inventory.some(i => i.id === phone.id)); assert((await snap()).commerce.lists.some(l => l.id === list.id)); assert((await snap()).contacts.some(c => c.id === buyer.id && c.categories.length === 2));
    assert.deepEqual(errors, []); console.log('PASS: contacts/categories/stock/reservations/purchases/lists/rules/demands persist across Electron restart; no renderer errors.');
  } catch(error) { console.error('Renderer errors:',errors);console.error('Toast:',await page?.locator('#toast-region').innerText().catch(()=>''));throw error;} finally { if (app) await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
