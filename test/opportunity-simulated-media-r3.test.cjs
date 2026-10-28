'use strict';

// Local receipt simulation only. No account, socket, upload or real WhatsApp
// recipient is contacted; fixture bytes do not assert codec compatibility.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { SimulatedAdapter } = require('../src/adapters/simulated.cjs');
const TARGET = '5511999990001';

async function fixture(t, type = 'image') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opportunity-local-media-')), mediaDirectory = path.join(dir, 'media');
  fs.mkdirSync(mediaDirectory); const outbound = [];
  const adapter = new SimulatedAdapter({ delayMs: 0, store: { dir, getSetting: (_key, fallback) => fallback,
    registerOutboundMessageId: (id, metadata) => outbound.push({ id, ...metadata }) } });
  const receipts = []; adapter.on('receipt', receipt => receipts.push(receipt)); await adapter.connect();
  const filename = path.join(mediaDirectory, `fixture.${type}`), bytes = Buffer.from(`controlled ${type} fixture`);
  fs.writeFileSync(filename, bytes);
  const media = { id: `media-${type}`, name: `fixture.${type}`, path: filename, type,
    mime: type === 'image' ? 'image/jpeg' : type === 'video' ? 'video/mp4' : 'application/pdf',
    size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  t.after(async () => { await adapter.disconnect(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { adapter, media, dir, outbound, receipts, item: { type, caption: '📱 iPhone 12 Pro 256GB\nR$ 2.500,00\nDetalhe na tela — assinatura' } };
}

for (const type of ['image', 'video', 'document']) {
  test(`private ${type} preserves caption and managed metadata with simulation-only proof`, async t => {
    const f = await fixture(t, type), options = { clientMessageId: `${type}-operation` };
    const first = await f.adapter.sendPrivateContent(TARGET, f.item, f.media, options);
    assert.equal(first.status, 'confirmed'); assert.equal(first.simulation, true); assert.equal(first.mode, 'simulated');
    assert.equal(first.confirmationScope, 'simulation-only');
    assert.equal(f.adapter.sent[0].type, type); assert.equal(f.adapter.sent[0].caption, f.item.caption);
    assert.equal(f.adapter.sent[0].text, f.item.caption); assert.equal(f.adapter.sent[0].media.sha256, f.media.sha256);
    assert.equal(f.adapter.sent[0].mediaId, f.media.id); assert.equal(f.adapter.sent[0].simulation, true);
    assert.equal(f.receipts.length, 1); assert.equal(f.receipts[0].confirmationScope, 'simulation-only');
    assert(!f.receipts[0].deliveredAt); assert(!first.deliveredAt);
    assert.deepEqual(await f.adapter.sendPrivateContent(TARGET, f.item, f.media, options), first);
    assert.equal(f.adapter.sent.length, 1); assert.equal(f.outbound.length, 1); assert.equal(f.outbound[0].storageMode, 'simulated');
  });
}

test('a captionless photo remains a media record with an empty original caption', async t => {
  const f = await fixture(t); await f.adapter.sendPrivateContent(TARGET, { type: 'image', clientMessageId: 'captionless' }, f.media);
  assert.equal(f.adapter.sent[0].messageId, 'captionless'); assert.equal(f.adapter.sent[0].caption, ''); assert.equal(f.adapter.sent[0].text, '');
});

test('missing managed photo fails before a receipt or outbound reservation exists', async t => {
  const f = await fixture(t); fs.unlinkSync(f.media.path);
  await assert.rejects(f.adapter.sendPrivateContent(TARGET, f.item, f.media), error => error.code === 'WA_MEDIA_MISSING' && error.submitted === false && error.definitive);
  assert.equal(f.adapter.sent.length, 0); assert.equal(f.receipts.length, 0); assert.equal(f.outbound.length, 0);
});

test('external paths and symlinks cannot be presented as managed private media', async t => {
  const f = await fixture(t), external = path.join(f.dir, 'outside.jpg'); fs.copyFileSync(f.media.path, external);
  await assert.rejects(f.adapter.sendPrivateContent(TARGET, f.item, { ...f.media, path: external }), { code: 'WA_MEDIA_PATH' });
  const link = path.join(f.dir, 'media', 'link.jpg'); fs.symlinkSync(f.media.path, link);
  await assert.rejects(f.adapter.sendPrivateContent(TARGET, f.item, { ...f.media, path: link }), { code: 'WA_MEDIA_PATH' });
  assert.equal(f.receipts.length, 0);
});

test('changed hash, inconsistent size and wrong media type are confirmed pre-submit failures', async t => {
  const f = await fixture(t);
  await assert.rejects(f.adapter.sendPrivateContent(TARGET, f.item, { ...f.media, sha256: '0'.repeat(64) }), { code: 'WA_MEDIA_CHANGED' });
  await assert.rejects(f.adapter.sendPrivateContent(TARGET, f.item, { ...f.media, size: f.media.size + 1 }), { code: 'WA_MEDIA_CHANGED' });
  await assert.rejects(f.adapter.sendPrivateContent(TARGET, f.item, { ...f.media, mime: 'video/mp4' }), { code: 'SIM_MEDIA_TYPE' });
  await assert.rejects(f.adapter.sendPrivateContent(TARGET, { ...f.item, type: 'video' }, f.media), { code: 'SIM_MEDIA_TYPE' });
  assert.equal(f.adapter.sent.length, 0); assert.equal(f.outbound.length, 0);
});

test('invalid caption, cancellation and a rejecting final permission guard never generate success', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(f.adapter.sendPrivateContent(TARGET, { ...f.item, caption: {} }, f.media), { code: 'WA_CAPTION_INVALID' });
  await assert.rejects(f.adapter.sendPrivateContent(TARGET, f.item, f.media, { signal: controller.signal }), { code: 'WA_ATTEMPT_ABORTED' });
  await assert.rejects(f.adapter.sendPrivateContent(TARGET, f.item, f.media, { beforeSubmit: () => false }), { code: 'WA_SUBMISSION_GUARD_REJECTED' });
  await assert.rejects(f.adapter.sendPrivateContent(TARGET, f.item, f.media, { beforeSubmit: async () => true }), { code: 'WA_SUBMISSION_GUARD_ASYNC' });
  assert.equal(f.adapter.sent.length, 0); assert.equal(f.receipts.length, 0);
});

test('uncertain local media remains uncertain and an edited item cannot reuse its operation identifier', async t => {
  const f = await fixture(t); f.adapter.setNextOutcome('uncertain');
  const options = { clientMessageId: 'uncertain-photo' }, result = await f.adapter.sendPrivateContent(TARGET, f.item, f.media, options);
  assert.equal(result.status, 'uncertain'); assert.equal(result.confirmationScope, undefined); assert.equal(f.receipts.length, 0);
  assert.equal((await f.adapter.sendPrivateContent(TARGET, f.item, f.media, options)).status, 'uncertain');
  await assert.rejects(f.adapter.sendPrivateContent(TARGET, { ...f.item, caption: 'Novo preço' }, f.media, options), { code: 'SIM_MEDIA_OPERATION_CONFLICT' });
  assert.equal(f.adapter.sent.length, 1); assert.equal(f.outbound.length, 1);
});

test('failed or disconnected simulation never registers a media message as accepted', async t => {
  const f = await fixture(t); f.adapter.setNextOutcome('failed');
  await assert.rejects(f.adapter.sendPrivateContent(TARGET, f.item, f.media), error => error.safeToRetry === true);
  await f.adapter.disconnect(); await assert.rejects(f.adapter.sendPrivateContent(TARGET, f.item, f.media), /desconectada/);
  assert.equal(f.adapter.sent.length, 0); assert.equal(f.receipts.length, 0); assert.equal(f.outbound.length, 0);
});

test('document wrapper stays compatible and an altered transport mode is refused', async t => {
  const f = await fixture(t, 'document');
  const result = await f.adapter.sendSearchDocument(TARGET, { ...f.media, caption: 'Planilha de teste' });
  assert.equal(result.simulation, true); assert.equal(f.adapter.sent[0].document.name, f.media.name);
  f.adapter.status = { ...f.adapter.status, mode: 'whatsapp', simulation: false };
  await assert.rejects(f.adapter.sendPrivateContent(TARGET, f.item, f.media), { code: 'SIM_MODE_REQUIRED' });
  assert.equal(f.adapter.sent.length, 1);
});
