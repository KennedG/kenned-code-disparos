'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createStore } = require('../src/core/store.cjs');
const { VitrineService, normalizeVitrineConfig, extractVitrineDefects } = require('../src/core/vitrine.cjs');
const NOW = Date.parse('2026-10-09T15:00:00Z');

async function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-vitrine-')), stores = [], context = { now: NOW, licensed: true, allowed: true };
  t.after(() => { for (const store of stores) { try { store.close(); } catch {} } fs.rmSync(dir, { recursive: true, force: true }); });
  const open = async () => { const store = await createStore(dir); stores.push(store); return store; }, store = await open(); store.setSetting('integrationMode', 'whatsapp');
  fs.mkdirSync(path.join(dir, 'media')); const filename = path.join(dir, 'media', 'foto.jpg'); fs.writeFileSync(filename, 'Foto de teste');
  const media = { id: 'media-1', name: 'foto.jpg', path: filename, type: 'image', mime: 'image/jpeg', sha256: 'PHOTO-HASH', size: 13 }, caption = '📱 iPhone 16 128GB\n🩷 Cor: ROSA\n🔋 Saúde da bateria: 92%\nR$ 2.999,00\nDetalhe na tela pequeno\nFornecedor: Ricardo\nIMEI: 123456789012345\nCusto: R$ 2.000,00\n📞 5562999999999\n𝗣𝗮𝗹𝗮𝗰𝗲 𝗣𝗮𝗿𝗳𝘂𝗺';
  const campaign = { id: 'campaign-1', name: 'Lista interna da loja', state: 'draft', mode: 'repeat', items: [{ id: 'item-1', type: 'image', mediaId: media.id, caption }], groupIds: [], groupOverrides: {}, ownerId: 'owner' }; store.saveMedia(media); store.saveCampaign(campaign);
  const callbacks = { now: () => context.now, isLicensed: () => context.licensed, assertAccess: (action, actor, source) => { if (!context.allowed || actor !== 'owner') throw Object.assign(new Error('Sem permissão'), { code: 'FORBIDDEN' }); if (source?.ownerId !== undefined && source.ownerId !== actor) throw new Error('Campanha restrita'); }, ...overrides };
  const service = new VitrineService({ store, ...callbacks }), config = { brandName: 'Mega Celulares', commercialContact: '(62) 99403-3173', whatsappUrl: 'https://wa.me/5562994033173', wholesaleUrl: 'https://example.com/comunidade', audience: 'retail', secondsPerItem: 10 }, item = { id: 'public-1', campaignId: campaign.id, itemId: 'item-1', model: 'iPhone 16', storage: '128GB', color: 'Rosa', publicDescription: 'Saúde da bateria: 92%', retailPriceCents: 299900, wholesalePriceCents: 280000, audience: 'both', availability: 'ready', enabled: true, expiresAt: NOW + 2 * 3600000 };
  const publish = async (input = { config, items: [item] }) => { const p = await service.preview(input, 'owner'); service.publish({ previewToken: p.previewToken, confirm: true }, 'owner'); return p; };
  return { store, service, context, config, item, campaign, media, filename, open, callbacks, publish };
}

test('TV starts empty and requires explicit preview and publication', async t => {
  const f = await fixture(t); assert.equal(f.service.getPublic().mode, 'neutral'); assert.equal(f.service.getState('owner').candidates.length, 1);
  f.service.save({ config: f.config, items: [f.item] }, 'owner'); assert.equal(f.service.getPublic().mode, 'neutral');
  const p = await f.service.preview(undefined, 'owner'); assert.equal(p.publicItems.length, 1); assert.equal(f.service.getPublic().mode, 'neutral');
  assert.throws(() => f.service.publish({ previewToken: p.previewToken }, 'owner'), e => e.code === 'VITRINE_CONFIRM_REQUIRED');
  f.service.publish({ previewToken: p.previewToken, confirm: true }, 'owner'); assert.equal(f.service.getPublic().mode, 'vitrine');
});
test('public projection excludes source captions, suppliers, IMEI, costs and all administrative data', async t => {
  const f = await fixture(t); const original = f.store.getCampaign(f.campaign.id).items[0].caption; await f.publish(); const out = f.service.getPublic(), encoded = JSON.stringify(out);
  for (const secret of ['Ricardo', '123456789012345', '5562999999999', 'Custo:', 'Fornecedor:', 'PHOTO-HASH', 'sourceCaption', 'sourceHash']) assert(!encoded.includes(secret), secret);
  assert.equal(out.items[0].defectNotes, 'Detalhe na tela pequeno'); assert.equal(out.items[0].priceCents, 299900); assert.equal(out.items[0].availability, 'ready');
  assert.equal(f.store.getCampaign(f.campaign.id).items[0].caption, original);
});
test('original defects cannot be removed through public description or editable defect field', async t => {
  const f = await fixture(t); await f.publish({ config: f.config, items: [{ ...f.item, defectNotes: '', publicDescription: 'Oferta especial' }] });
  assert.equal(f.service.getPublic().items[0].defectNotes, 'Detalhe na tela pequeno');
  assert.deepEqual(extractVitrineDefects('iPhone\nTela trincada\nBateria trocada\nFace ID não funciona\nSem Face ID'), ['Tela trincada', 'Bateria trocada', 'Face ID não funciona', 'Sem Face ID']);
});
test('wholesale never falls back to retail; mixed shows explicit audience blocks and independent prices', async t => {
  const f = await fixture(t), p = await f.service.preview({ config: { ...f.config, audience: 'wholesale' }, items: [{ ...f.item, wholesalePriceCents: null }] }, 'owner');
  assert.equal(p.publicItems.length, 0); assert.equal(p.warnings[0].code, 'VITRINE_PRICE_MISSING'); assert.throws(() => f.service.publish({ previewToken: p.previewToken, confirm: true }, 'owner'), e => e.code === 'VITRINE_EMPTY');
  await f.publish({ config: { ...f.config, audience: 'mixed' }, items: [f.item] }); assert.deepEqual(f.service.getPublic().items.map(i => [i.audience, i.priceCents]), [['retail', 299900], ['wholesale', 280000]]);
});
test('missing public price, disabled and expired adverts are skipped without inventing content', async t => {
  const f = await fixture(t), p = await f.service.preview({ config: f.config, items: [{ ...f.item, retailPriceCents: null }] }, 'owner'); assert.equal(p.publicItems.length, 0);
  const disabled = await f.service.preview({ config: f.config, items: [{ ...f.item, enabled: false }] }, 'owner'); assert.equal(disabled.publicItems.length, 0);
  await f.publish(); f.context.now = f.item.expiresAt; assert.equal(f.service.getPublic().mode, 'neutral'); assert.equal(f.service.getState('owner').publication.warnings[0].code, 'VITRINE_EXPIRED');
});
test('availability label is present only when explicitly registered', async t => {
  const f = await fixture(t); await f.publish({ config: f.config, items: [{ ...f.item, availability: '' }] }); assert.equal(f.service.getPublic().items[0].availability, '');
  assert.throws(() => f.service.save({ config: f.config, items: [{ ...f.item, availability: 'always-in-stock' }] }, 'owner'), e => e.code === 'VITRINE_AVAILABILITY_INVALID');
});
test('a real PNG QR is generated from the exact configured HTTPS URL', async t => {
  const f = await fixture(t), p = await f.publish(); assert(p.qrCode.startsWith('data:image/png;base64,')); const png = Buffer.from(p.qrCode.split(',')[1], 'base64'); assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]); assert.equal(f.service.getPublic().qrCode, p.qrCode);
});
test('QR validation refuses credentials, unsafe links and fabricated wa.me identifiers', () => {
  for (const whatsappUrl of ['http://wa.me/5562994033173', 'https://user:password@example.com', 'https://localhost/a', 'https://127.0.0.1', 'https://wa.me/123@lid', 'https://example.com/?token=secret']) assert.throws(() => normalizeVitrineConfig({ whatsappUrl }), e => e.code === 'VITRINE_URL_INVALID');
  assert.equal(normalizeVitrineConfig({ whatsappUrl: 'https://wa.me/5562994033173' }).whatsappUrl, 'https://wa.me/5562994033173');
});
test('private information is rejected in public fields and source defect lines cannot leak contacts', async t => {
  const f = await fixture(t); for (const publicDescription of ['Custo R$ 100', 'Fornecedor Ricardo', 'IMEI: 123456789012345', 'Telefone 5562999999999', 'Senha: segredo']) assert.throws(() => f.service.save({ config: f.config, items: [{ ...f.item, publicDescription }] }, 'owner'), e => e.code === 'VITRINE_PRIVATE_CONTENT');
  f.store.saveCampaign({ ...f.campaign, items: [{ ...f.campaign.items[0], caption: 'Detalhe na tela - fornecedor 5562999999999' }] }); assert.throws(() => f.service.save({ config: f.config, items: [f.item] }, 'owner'), e => e.code === 'VITRINE_PRIVATE_CONTENT');
});
test('previews are bound to actor, draft version, source revision and short validity', async t => {
  const f = await fixture(t), p = await f.service.preview({ config: f.config, items: [f.item] }, 'owner');
  assert.throws(() => f.service.publish({ previewToken: p.previewToken, confirm: true }, 'someone-else'), /Sem permissão/);
  f.store.saveCampaign({ ...f.campaign, items: [{ ...f.campaign.items[0], caption: f.campaign.items[0].caption + '\nRisco lateral' }] }); assert.throws(() => f.service.publish({ previewToken: p.previewToken, confirm: true }, 'owner'), e => e.code === 'VITRINE_SOURCE_CHANGED');
  const p2 = await f.service.preview({ config: f.config, items: [f.item] }, 'owner'); f.context.now += 5 * 60000; assert.throws(() => f.service.publish({ previewToken: p2.previewToken, confirm: true }, 'owner'), e => e.code === 'VITRINE_STALE');
});
test('an edit to an approved source removes it from TV until another explicit publication', async t => {
  const f = await fixture(t); await f.publish(); f.store.saveCampaign({ ...f.campaign, items: [{ ...f.campaign.items[0], caption: f.campaign.items[0].caption.replace('2.999,00', '3.100,00') }] });
  assert.equal(f.service.getPublic().mode, 'neutral'); assert.equal(f.service.getState('owner').publication.warnings[0].code, 'VITRINE_SOURCE_CHANGED'); await f.publish(); assert.equal(f.service.getPublic().mode, 'vitrine');
});
test('deleting a campaign with an existing preview never publishes or recreates it', async t => {
  const f = await fixture(t); await f.publish(); const p = await f.service.preview({ config: f.config, items: [f.item] }, 'owner'); f.store.deleteCampaign(f.campaign.id); const cleanup = f.service.handleCampaignDeleted(f.campaign.id);
  assert.equal(cleanup.removed, 1); assert.equal(f.service.getState('owner').items.length, 0); assert.equal(f.service.getPublic().mode, 'neutral'); assert.throws(() => f.service.publish({ previewToken: p.previewToken, confirm: true }, 'owner'), e => e.code === 'VITRINE_STALE'); assert.equal(f.store.getCampaign(f.campaign.id), undefined);
});
test('a deleted campaign is skipped even when an invalidation callback was not available', async t => {
  const f = await fixture(t); await f.publish(); f.store.deleteCampaign(f.campaign.id); assert.equal(f.service.getPublic().mode, 'neutral'); assert.equal(f.service.getPublic().mode, 'neutral'); assert.equal(f.store.listCampaigns().length, 0);
});
test('quick withdrawal removes live and draft items and persists on reopen', async t => {
  const f = await fixture(t); await f.publish(); f.service.withdraw({ id: f.item.id }, 'owner'); assert.equal(f.service.getState('owner').items.length, 0); assert.equal(f.service.getPublic().mode, 'neutral'); f.store.close(); const reopened = await f.open(), again = new VitrineService({ store: reopened, ...f.callbacks }); assert.equal(again.getState('owner').items.length, 0); assert.equal(again.getPublic().mode, 'neutral');
});
test('approved publication and draft persist after application restart without losing original caption', async t => {
  const f = await fixture(t); await f.publish(); f.store.close(); const reopened = await f.open(), again = new VitrineService({ store: reopened, ...f.callbacks }); assert.equal(again.getPublic().items[0].priceCents, 299900); assert.equal(again.getState('owner').config.brandName, 'Mega Celulares'); assert.equal(reopened.getCampaign(f.campaign.id).items[0].caption, f.campaign.items[0].caption);
});
test('simulation and real TV configuration, selections and publication remain separated', async t => {
  const f = await fixture(t); await f.publish(); f.store.setSetting('integrationMode', 'simulated'); assert.equal(f.service.getState('owner').items.length, 0); assert.equal(f.service.getPublic().mode, 'neutral'); assert.equal(f.service.getState('owner').candidates.length, 0); f.store.setSetting('integrationMode', 'whatsapp'); assert.equal(f.service.getPublic().items.length, 1);
});
test('license expiry instantly neutralizes TV and renewal never resumes old publication', async t => {
  const f = await fixture(t); await f.publish(); const dataBefore = f.store.getCampaign(f.campaign.id); f.context.licensed = false;
  assert.deepEqual(f.service.getPublic(), { mode: 'neutral', config: { brandName: 'Mega Celulares' }, items: [] }); assert.throws(() => f.service.getState('owner'), e => e.code === 'LICENSE_REQUIRED');
  f.context.licensed = true; assert.equal(f.service.getPublic().mode, 'neutral'); assert.equal(f.service.getState('owner').publication.reason, 'license_expired'); assert.deepEqual(f.store.getCampaign(f.campaign.id), dataBefore); await f.publish(); assert.equal(f.service.getPublic().mode, 'vitrine');
});
test('expiry while asynchronous QR is generated prevents publication and respects backend permissions', async t => {
  let release; const started = new Promise(resolve => { release = resolve; }), f = await fixture(t, { qrCode: async () => { await started; return 'data:image/png;base64,TEST'; } });
  const pending = f.service.preview({ config: f.config, items: [f.item] }, 'owner'); f.context.licensed = false; release(); await assert.rejects(pending, e => e.code === 'LICENSE_REQUIRED'); assert.equal(f.service.getPublic().mode, 'neutral');
  f.context.licensed = true; f.context.allowed = false; assert.throws(() => f.service.save({ config: f.config, items: [f.item] }, 'owner'), e => e.code === 'FORBIDDEN');
});
test('transaction failure cannot partially publish draft and live content or report success', async t => {
  const f = await fixture(t), p = await f.service.preview({ config: f.config, items: [f.item] }, 'owner'), setSetting = f.store.setSetting; f.store.setSetting = (key, value) => { if (key.endsWith(':publication')) throw new Error('Falha de gravação controlada'); return setSetting(key, value); };
  assert.throws(() => f.service.publish({ previewToken: p.previewToken, confirm: true }, 'owner'), /Falha de gravação/); f.store.setSetting = setSetting; assert.equal(f.service.getState('owner').items.length, 0); assert.equal(f.service.getPublic().mode, 'neutral');
});
test('missing managed image is not displayed and does not affect another approved advertisement', async t => {
  const f = await fixture(t); await f.publish(); fs.unlinkSync(f.filename); assert.equal(f.service.getPublic().mode, 'neutral'); assert.equal(f.service.getState('owner').publication.warnings[0].code, 'VITRINE_IMAGE_MISSING'); assert.throws(() => f.service.save({ config: f.config, items: [f.item] }, 'owner'), e => e.code === 'VITRINE_IMAGE_MISSING');
});
test('duplicate selected sources, contradictory audience and unsafe numeric prices are rejected', async t => {
  const f = await fixture(t); assert.throws(() => f.service.save({ config: f.config, items: [f.item, { ...f.item, id: 'other' }] }, 'owner'), e => e.code === 'VITRINE_DUPLICATE');
  for (const retailPriceCents of [0, -1, 2999.9, '299900', NaN]) assert.throws(() => f.service.save({ config: f.config, items: [{ ...f.item, retailPriceCents }] }, 'owner'), e => e.code === 'VITRINE_PRICE_INVALID');
  assert.throws(() => f.service.save({ config: { ...f.config, audience: 'everyone' }, items: [f.item] }, 'owner'), e => e.code === 'VITRINE_AUDIENCE_INVALID');
});

test('public advert needs a registered validity; a missing deadline is never published silently', async t => {
  const f=await fixture(t), preview=await f.service.preview({config:f.config,items:[{...f.item,expiresAt:null}]},'owner');
  assert.equal(preview.publicItems.length,0);assert.equal(preview.warnings[0].code,'VITRINE_EXPIRY_MISSING');
  assert.throws(()=>f.service.publish({previewToken:preview.previewToken,confirm:true},'owner'),e=>e.code==='VITRINE_EMPTY');
  assert.equal(f.service.getPublic().mode,'neutral');
});
test('removed, pending and stale source captures are excluded without changing the original campaign', async t => {
  const f=await fixture(t), item={...f.campaign.items[0],sourcePublicationId:'original-source',sourcePublicationRevision:100};
  f.store.saveCampaign({...f.campaign,items:[item]});let publication={status:'ready',revisionAt:100};f.store.getSourcePublication=()=>publication;
  await f.publish();assert.equal(f.service.getPublic().mode,'vitrine');
  for(const changed of [{status:'removed',revisionAt:100},{status:'pending',revisionAt:100},{status:'ready',revisionAt:101}]){publication=changed;assert.equal(f.service.getPublic().mode,'neutral');assert.equal(f.service.getState('owner').publication.warnings[0].code,'VITRINE_SOURCE_UNAVAILABLE');}
  publication={status:'ready',revisionAt:100};f.store.saveCampaign({...f.campaign,items:[{...item,sourcePublicationRevision:undefined}]});assert.equal(f.service.getPublic().mode,'neutral');
  assert.equal(f.store.getCampaign(f.campaign.id).items[0].caption,item.caption);
});
