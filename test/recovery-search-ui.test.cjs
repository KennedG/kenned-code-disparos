'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function fixture(manage = true) {
  const calls = [], notices = [];
  const data = { storageMode: 'whatsapp', connection: { state: 'connected', mode: 'whatsapp' }, buscas: {
    authorized: true, permissions: { search: true, view: true, manage }, groups: [],
    settings: { enabled: true, prefix: '!busca', timezone: 'America/Sao_Paulo', monitoredGroupIds: [] },
    stats: { messages: 12, offers: 20 }, monitor: { status: 'monitoring', monitoredGroups: 2, queueSize: 3, failedCaptures: 1,
      lastCaptureAt: Date.now(), lastSyncAt: Date.now(), lastError: { code: 'WA_CAPTURE_EVENT_ERROR', message: 'Verifique <script>não executar</script>', at: Date.now() } } } };
  const handlers = { searchesState: () => data.buscas,
    testSearchCapture: () => { data.buscas.monitor.captureProbe = { status: 'waiting', expiresAt: Date.now() + 120000 }; return { detail: 'Aguardando publicação nova; nenhum envio de teste automático.' }; },
    synchronizeSearchCapture: () => ({ detail: 'Seleção reaplicada; histórico não importado.' }) };
  const document = { querySelector: () => null, querySelectorAll: () => [] };
  const sandbox = vm.createContext({ window: {}, document, confirm: () => true, Date, Map, Set });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/ui/searches.js'), 'utf8'), sandbox);
  const ui = sandbox.window.MegaBuscasUI.create({ data: () => data, auth: () => ({ user: { id: 'responsible-test', isOwner: false } }), groups: () => [],
    call: async name => { calls.push(name); return handlers[name](); }, render() {}, toast: value => notices.push(value) });
  return { ui, data, calls, notices, action: name => ui.onAction(`buscas-${name}`, { dataset: {}, isConnected: true, disabled: false }) };
}

test('BUSCAS mostra contadores reais, falhas e última captura sem substituir dados vazios por exemplos', () => {
  const f = fixture(), html = f.ui.render();
  assert.match(html, /12 mensagens capturadas/); assert.match(html, /20 ofertas indexadas/); assert.match(html, /2 grupos monitorados/);
  assert.match(html, /3 na fila/); assert.match(html, /1 falha\(s\) de captura/); assert.match(html, /WA_CAPTURE_EVENT_ERROR/);
  assert.match(html, /&lt;script&gt;não executar&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /Capturar anúncio simulado|Grupo de exemplo/);
});

test('botões de captura e sincronização usam APIs reais e apresentam espera, nunca captura ou envio fictício', async () => {
  const f = fixture(); await f.action('test-capture');
  assert.deepEqual(f.calls, ['testSearchCapture', 'searchesState']); assert.match(f.ui.render(), /Teste de captura aguardando publicação nova/);
  assert.doesNotMatch(f.ui.render(), /Captura confirmada:/); assert.match(f.notices[0], /Aguardando publicação nova/);
  await f.action('synchronize'); assert.deepEqual(f.calls.slice(-2), ['synchronizeSearchCapture', 'searchesState']);
});

test('apenas gerentes podem preparar teste ou sincronização da captura', async () => {
  const f = fixture(false);
  assert.doesNotMatch(f.ui.render(), /data-action="buscas-test-capture"|data-action="buscas-synchronize"/);
  await assert.rejects(f.action('test-capture'), /Sem permissão/); await assert.rejects(f.action('synchronize'), /Sem permissão/);
  assert.equal(f.calls.length, 0);
});
