'use strict';
// Real Electron renderer/backend/SQLite; WhatsApp transport is explicitly simulated.
// This harness does not prove delivery to a real handset or Windows execution.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-stability-ui-'));
  const screenshots = process.env.MEGA_SCREENSHOT_DIR || '/workspace/scratch/r5-raw-ui';
  fs.mkdirSync(screenshots, { recursive: true });
  const credentials = { username: 'estabilidade.ui', password: 'Senha-Kenned-Estabilidade-2026!' };
  const group = 'sim-01@simulation', phone = '5562999990001', requester = '5562999990002';
  const prep = await createStore(dir); prep.setSetting('initialized', true); prep.setSetting('integrationMode', 'simulated'); prep.setSetting('unofficialAcknowledged', true);
  prep.upsertGroups([{ id: group, name: 'Teste isolado de procura', simulation: true, authorized: true }]);
  const owner = (await new AuthService({ store: prep }).setupOwner({ ...credentials, name: 'Revisor R5', phone })).user;
  const now = Date.now();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jAlkAAAAASUVORK5CYII=', 'base64');
  const media = await new MediaManager(prep).importBuffer(png, { name: 'anuncio-isolado.png', mime: 'image/png' });
  const caption = '📱 Aparelho anunciado na loja\nConsulte o valor.\n🩷 Cor: ROSA\nDetalhe na tela pequeno\n𝗞𝗖 — assinatura original';
  const campaign = prep.saveCampaign({ id: 'gui-r5-raw', name: 'Lista isolada sem preço interpretado', state: 'draft', ownerId: owner.id, mode: 'repeat', groupIds: [], items: [
    { id: 'gui-r5-item', type: 'image', mediaId: media.id, caption, text: caption, sourceGroupId: group, sourceMessageId: 'gui-r5-source', sourceOriginalAt: now, ready: true },
    { id: 'gui-r5-sold', type: 'text', text: 'Este anúncio foi vendido', sold: true, available: false, ready: true }
  ], schedule: { days: [0,1,2,3,4,5,6], startTime: '00:00', endTime: '00:00' }, intervalMinutes: 10, spacingSeconds: 5, messageSpacingSeconds: 3 });
  const adapter = new EventEmitter(); adapter.status = { state: 'disconnected', mode: 'simulated' }; adapter.configureOpportunityCapture = () => {};
  const service = new OpportunityService({ store: prep, adapter, now: () => now + 100, assertCanCapture: () => true, assertCanOperate: () => true, onLocalAlert: () => {} });
  service.saveConfig({ enabled: true, mode: 'evaluation', availabilityMode: 'confirmed', monitoredGroupIds: [group], campaignIds: [campaign.id] }, owner.id);
  const record = service.handleIncoming({ messageId: 'gui-r5-request', text: 'Quem tem iPhone 12 Pro?', chatId: group, timestamp: now+100, originalTimestamp: now+100, senderId: `${requester}@s.whatsapp.net`, senderNumber: requester, profileName: 'Interessado de teste', identityVerified: true, isGroup: true, simulation: true, mode: 'simulated', type: 'text' });
  assert(record.opportunity?.id); assert.equal(prep.listOpportunityOffers({ limit:100 }).length, 0, 'raw caption intentionally yields no parsed offer');
  const opportunityId = record.opportunity.id;
  await service.stop(); prep.close();
  let app, page; const errors = [];
  const rpc = async (action,payload) => { const result=await page.evaluate(({action,payload})=>window.mega.call(action,payload),{action,payload}); assert(!result?.error,`${action}: ${JSON.stringify(result)}`); return result; };
  const nav = async section => { const item=page.locator(`#navigation [data-id="${section}"]`).first(); if(!await item.isVisible())await page.locator('#navigation [data-action=toggle-more-tools]').click();await item.click(); };
  try {
    app=await _electron.launch({executablePath:process.env.MEGA_ELECTRON_EXECUTABLE||require('electron'),args:['--no-sandbox','--disable-gpu',...(process.env.MEGA_PROXY_TEST?['--proxy-server=http://proxy:8080']:[]),process.env.MEGA_APP_PATH||'.'],env:{...process.env,MEGA_DATA_DIR:dir},timeout:25000});
    await expect.poll(()=>{page=app.windows().find(window=>/\/ui\/index\.html$/.test(window.url()));return Boolean(page);},{timeout:25000}).toBe(true);
    page.on('pageerror', error=>errors.push(error.message)); page.on('dialog',async dialog=>dialog.accept());
    await page.getByRole('heading',{name:'Bem-vindo de volta'}).waitFor();
    await expect.poll(async()=>(await page.evaluate(()=>window.mega.call('licenseStatus')))?.allowed,{timeout:30000}).toBe(true);
    for(const [name,value]of Object.entries(credentials))await page.locator(`#auth-form [name="${name}"]`).fill(value);
    await page.locator('#auth-form [type=submit]').click();await page.getByRole('heading',{name:'Tudo sob controle'}).waitFor();
    await rpc('licenseRefresh');await rpc('resumeAutomation');await rpc('connect');await nav('opportunities');
    const card=page.locator(`[data-opportunity-id="${opportunityId}"]`);
    await expect(card).toBeVisible();await expect(card.getByRole('button',{name:'Escolher anúncio da campanha',exact:true})).toBeVisible();
    assert.equal((await rpc('opportunityDetail',{id:opportunityId})).candidates.length,0);
    console.log('PASS: unmatched opportunity exposes raw campaign chooser with no parsed offer or price. Real Electron renderer/backend/SQLite, simulated WhatsApp.');
    await card.getByRole('button',{name:'Escolher anúncio da campanha',exact:true}).click();
    await expect(page.locator('#opportunity-campaign-chooser')).toContainText(caption);
    const chosen=page.locator('[data-action=opportunity-manual-item-preview][data-item-id=gui-r5-item]');
    const sold=page.locator('[data-action=opportunity-manual-item-preview][data-item-id=gui-r5-sold]');
    await expect(chosen).toBeEnabled();await expect(sold).toBeDisabled();
    await chosen.click();await expect(page.locator('#opportunity-preview')).toContainText(caption);
    await expect(page.locator('#opportunity-preview')).toContainText(requester);
    await expect(page.locator('#opportunity-preview img')).toBeVisible();
    assert.equal((await rpc('opportunityDetail',{id:opportunityId})).tasks.length,0,'preview cannot send');
    await page.screenshot({path:path.join(screenshots,'r5-anuncio-original-previa.png'),fullPage:true});
    await page.locator('[data-action=opportunity-confirm-send]').click();
    await expect.poll(async()=>(await rpc('opportunityDetail',{id:opportunityId})).tasks.at(-1)?.status,{timeout:15000}).toBe('accepted');
    const detail=await rpc('opportunityDetail',{id:opportunityId});assert.equal(detail.tasks.length,1);assert.equal(detail.tasks[0].recipient,requester);assert.equal(detail.tasks[0].automatic,false);assert.equal(detail.tasks[0].offerSnapshots[0].rawText,caption);
    assert.equal((await rpc('opportunityState')).config.availabilityMode,'confirmed');
    await expect(page.locator('#opportunity-detail')).toContainText('Envio aceito pela integração');
    await page.screenshot({path:path.join(screenshots,'r5-envio-manual-aceito-simulado.png'),fullPage:true});
    console.log('PASS: raw photo+caption preview preserves all text, image and destination; manual send creates exactly one accepted simulated task, skips no-stock TTL only for manual selection and leaves global configuration unchanged.');
    await page.locator('[data-action=opportunity-close-modal]').click();
    const role=await rpc('saveRole',{role:{name:'Revisor somente leitura R5',campaignScope:'all',permissions:['opportunity.view','campaign.view']}});
    const viewer=await rpc('createUser',{user:{name:'Revisor R5',username:'revisor.r5',password:'Senha-Revisor-R5-2026!',roleId:role.id,campaignScope:'all',requirePasswordChange:false}});
    await page.locator('[data-action=logout]').click();await page.getByRole('heading',{name:'Bem-vindo de volta'}).waitFor();
    await page.locator('#auth-form [name=username]').fill(viewer.username);await page.locator('#auth-form [name=password]').fill('Senha-Revisor-R5-2026!');await page.locator('#auth-form [type=submit]').click();await page.getByRole('heading',{name:'Tudo sob controle'}).waitFor();
    const denied=await page.evaluate(()=>window.mega.call('opportunityCampaignItemsPage',{limit:30,offset:0}));assert(denied.error,'readonly actor must not enumerate raw manual action catalog via new backend RPC');
    await nav('opportunities');await expect(page.locator('[data-action=opportunity-choose-campaign]')).toHaveCount(0);
    assert.deepEqual(errors,[]);
    console.log('PASS: backend and UI block raw manual actions for a read-only user; sold/unavailable item cannot be selected. No real WhatsApp or physical Windows delivery is asserted.');
  }catch(error){if(page)await page.screenshot({path:path.join(screenshots,'failed-stability-ui.png'),fullPage:true}).catch(()=>{});throw error;}
  finally{if(app)await app.close();if(process.env.MEGA_KEEP_TEST_DATA)console.log('Isolated test profile:',dir);else fs.rmSync(dir,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
