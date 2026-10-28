'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLicenseFixture } = require('./fixtures/license.cjs');
const { createAppService } = require('../src/backend/service.cjs');
const { createStore, seed } = require('../src/core/store.cjs');
const packageMetadata = require('../package.json');

const OWNER = { name: 'Exportação isolada', username: 'export-owner', password: 'Export-Safe-Password-2026', phone: '5511999990001' };

async function fixture(t, { cancelled = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-r8-diagnostic-export-'));
  const profile = path.join(dir, 'profile');
  const store = await createStore(profile);
  seed(store);
  store.addDiagnostic({ id: 'export-diagnostic-fixture', at: Date.now(), stage: 'fixture', code: 'TEST_DIAGNOSTIC', description: 'Registro de teste sem conexão ou envio.' });
  store.close();
  const requests = [];
  const service = await createAppService({
    dir: profile,
    version: '2.3.2',
    runtimePlatform: 'win32',
    licenseService: createLicenseFixture(),
    host: async (action, payload) => {
      requests.push({ action, payload });
      if (action === 'showSaveDialog') return { canceled: cancelled, filePath: path.join(dir, payload.defaultPath) };
      return { canceled: true, nativeStatus: 'unsupported', soundStatus: 'disabled' };
    }
  });
  t.after(async () => { await service.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, service, requests };
}

test('exportação real do backend identifica versão/revisão/plataforma sem perder registros ou incluir dados de autenticação', async t => {
  const { service } = await fixture(t);
  await service.call('setupOwner', OWNER);
  for (const action of ['exportDiagnostics', 'exportHistory']) {
    const result = await service.call(action, action === 'exportHistory' ? { categories: ['campaigns'] } : {});
    const raw = fs.readFileSync(result.path, 'utf8');
    const exported = JSON.parse(raw);
    assert.equal(exported.format, 'mega-disparos-logs');
    assert.equal(exported.version, 1, 'o formato de registros continua compatível');
    assert.equal(exported.appVersion, '2.3.2');
    assert.equal(exported.releaseRevision, packageMetadata.releaseRevision);
    assert.equal(exported.platform, 'win32');
    assert.ok(Number.isFinite(Date.parse(exported.exportedAt)));
    assert.ok(Array.isArray(exported.records));
    assert.equal(exported.records.length, result.count);
    if (action === 'exportDiagnostics') assert.ok(exported.records.some(record => record.id === 'export-diagnostic-fixture'));
    for (const field of ['passwordHash', 'recoveryCodes', OWNER.password, OWNER.phone]) assert.equal(raw.includes(field), false, field);
    assert.deepEqual(Object.keys(exported).sort(), ['appVersion', 'exportedAt', 'format', 'platform', 'records', 'releaseRevision', 'version']);
  }
});

test('metadados de diagnóstico não contornam autenticação nem criam arquivo ao cancelar', async t => {
  const { dir, service, requests } = await fixture(t, { cancelled: true });
  await assert.rejects(service.call('exportDiagnostics'), /login|autentic/i);
  assert.equal(requests.some(request => request.action === 'showSaveDialog'), false);
  await service.call('setupOwner', OWNER);
  assert.deepEqual(await service.call('exportDiagnostics'), { cancelled: true });
  assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.json')), false);
});
