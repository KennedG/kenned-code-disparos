'use strict';

// Exercises the production RPC and SQLite permission boundary. Transport and
// licensing are controlled fixtures; this does not attest WhatsApp delivery.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAppService } = require('../src/backend/service.cjs');
const { createStore } = require('../src/core/store.cjs');
const { createLicenseFixture } = require('./fixtures/license.cjs');

const PASSWORD = 'Source-RPC-security-test!';
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcd-source-rpc-security-'));
  const service = await createAppService({
    dir, version: '2.3.2', runtimePlatform: 'linux', licenseService: createLicenseFixture(),
    host: async action => action === 'secretGet' ? null : action === 'localAlert'
      ? { nativeStatus: 'unsupported', soundStatus: 'disabled' } : { canceled: true }
  });
  await service.call('setupOwner', { name: 'Security test owner', username: 'rpc-owner', password: PASSWORD, phone: '5562999990001' });
  const owner = service.snapshot().auth.user;
  const store = await createStore(dir);
  t.after(async () => { store.close(); await service.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
  function publication(id, overrides = {}) {
    const at = Date.now();
    return store.saveSourcePublication({
      id, messageId: `${id}-original`, groupId: 'sim-01@simulation', originalAt: at, capturedAt: at, revisionAt: at,
      ownerId: owner.id, campaignId: null, status: 'review', type: 'image', text: 'Foto aguardando revisão', caption: 'Foto aguardando revisão',
      protectedContext: 'PRIVATE-CONTEXT-SENTINEL', raw: { mediaKey: 'PRIVATE-RAW-SENTINEL' },
      mediaDownloadContext: { token: 'PRIVATE-DOWNLOAD-SENTINEL' }, downloadContext: { secret: 'PRIVATE-OTHER-SENTINEL' }, ...overrides
    });
  }
  return { service, store, owner, publication };
}

test('source removal returns a sanitized nested publication without protected download metadata', async t => {
  const f = await fixture(t);
  const record = f.publication('remove-secure');
  const result = await f.service.call('sourceRemovePublication', { id: record.id });
  assert.equal(result.removed, true);
  assert.equal(result.publication.status, 'removed');
  for (const field of ['protectedContext', 'raw', 'mediaDownloadContext', 'downloadContext']) assert.equal(result.publication[field], undefined);
  assert.equal(JSON.stringify(result).includes('SENTINEL'), false);
  assert.equal(f.store.getSourcePublication(record.id).protectedContext, 'PRIVATE-CONTEXT-SENTINEL', 'Operational encrypted context remains preserved locally.');
});

test('review with include false sanitizes its removal result as well as ordinary publication lists', async t => {
  const f = await fixture(t);
  const record = f.publication('review-secure');
  const result = await f.service.call('sourceReviewPublication', { id: record.id, include: false });
  assert.equal(result.removed, true);
  assert.equal(result.publication.status, 'removed');
  assert.equal(JSON.stringify(result).includes('SENTINEL'), false);
  assert.equal((await f.service.call('sourcePublications')).items[0].protectedContext, undefined);
});

test('own-scope editor cannot remove or edit another owner unassigned source publication despite settings view', async t => {
  const f = await fixture(t);
  const foreign = f.publication('foreign-unassigned');
  const seller = await f.service.call('createUser', { user: {
    name: 'Restricted editor', username: 'rpc-seller', password: PASSWORD, roleId: 'role-seller', campaignScope: 'own',
    requirePasswordChange: false, permissionOverrides: { 'campaign.view': true, 'campaign.edit': true, 'settings.view': true, 'media.create': true }
  } });
  const own = f.publication('own-unassigned', { ownerId: seller.id });
  await f.service.call('logout');
  await f.service.call('login', { username: seller.username, password: PASSWORD });
  assert.equal(f.service.snapshot().auth.campaignScope, 'own');
  await assert.rejects(f.service.call('sourceRemovePublication', { id: foreign.id }), /acesso|permiss|autoriz|outro usuário/i);
  await assert.rejects(f.service.call('sourceReviewPublication', { id: foreign.id, include: false }), /acesso|permiss|autoriz|outro usuário/i);
  await assert.rejects(f.service.call('sourceRetryMedia', { id: foreign.id }), /acesso|permiss|autoriz|outro usuário/i);
  assert.equal(f.store.getSourcePublication(foreign.id).status, 'review');
  assert.equal((await f.service.call('sourceRemovePublication', { id: own.id })).removed, true);
  assert.equal(f.store.getSourcePublication(own.id).status, 'removed');
});
