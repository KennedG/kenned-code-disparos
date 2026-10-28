'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { WorkerClient } = require('../src/core/worker-client.cjs');
function host(action) {
  if (action === 'secureStorage.status') return Promise.resolve({ available: false, backend: 'basic_text', platform: 'linux' });
  if (action === 'settings.apply') return Promise.resolve({ applied: true });
  throw new Error(`Recurso inesperado no teste: ${action}`);
}
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'community-real-worker-'));
  let current;
  t.after(async () => { await current?.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, async open() { current = new WorkerClient({ dir, version: '1.0.0', host }); await current.ready; return current; }, async close() { await current?.shutdown(); current = null; } };
}
test('thread real abre SQLite independente sem dados fictícios e preserva modelo e intervalo ao reiniciar', async t => {
  const fixture = setup(t);
  let service = await fixture.open();
  const first = await service.call('snapshot');
  assert.equal(first.appName, 'Automação Comunidade'); assert.equal(first.mode, 'whatsapp');
  assert.equal(first.groups.length, 0); assert.equal(first.campaigns.length, 0); assert.equal(first.connection.ready, false);
  const template = await service.call('saveTemplate', { template: { name: 'Convite personalizado', message: 'Olá, {nome}!\nAcesse {link_comunidade} 👋', communityLink: 'https://chat.whatsapp.com/TesteAutorizado123' } });
  await service.call('saveSettings', { settings: { defaultIntervalValue: 2, defaultIntervalUnit: 'minutes' } });
  await service.systemCall('suspend'); await service.systemCall('resume');
  await fixture.close(); service = await fixture.open();
  const restored = await service.call('listTemplates');
  assert.equal(restored.total, 1); assert.equal(restored.items[0].id, template.id);
  assert.equal(restored.items[0].message, 'Olá, {nome}!\nAcesse {link_comunidade} 👋');
  const snapshot = await service.call('snapshot');
  assert.equal(snapshot.settings.defaultIntervalValue, 2); assert.equal(snapshot.settings.defaultIntervalUnit, 'minutes');
  assert.equal(snapshot.connection.ready, false);
});
test('thread real não expõe recursos de segurança por RPC nem popula simulação no modo real', async t => {
  const fixture = setup(t), service = await fixture.open();
  await assert.rejects(service.call('secureStorage.decrypt'), { code: 'ACTION_NOT_ALLOWED' });
  await assert.rejects(service.call('testSimulation'), { code: 'SIMULATION_ONLY' });
  await assert.rejects(service.systemCall('deleteEverything'), { code: 'SYSTEM_ACTION_DENIED' });
  const snapshot = await service.call('snapshot'); assert.equal(snapshot.groups.length, 0); assert.equal(snapshot.metrics.identified, 0);
});
