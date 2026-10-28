'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(options = {}) {
  const settings = { enabled: true, prefix: '!busca', timezone: 'America/Sao_Paulo', maxAgeEnabled: true, maxAgeValue: 2, maxAgeUnit: 'hours', defaultFilters: {}, responsibleRecipientIds: ['responsible-a'] };
  const base = { authorized: true, settings, permissions: { search: true, view: true, export: true, send: true, ...options.permissions }, groups: [], recipients: [{ id: 'responsible-a', name: 'Responsável A', phone: '5511988880001', enabled: true }, { id: 'responsible-b', name: 'Responsável B', phone: '5511988880002', enabled: true }] };
  const data = { storageMode: 'simulated', buscas: base, connection: { state: 'connected', mode: 'simulated' } };
  let auth = { user: { id: 'actor-a', isOwner: false } };
  const elements = new Map(), calls = [], toasts = [], modals = [], offers = Array.from({ length: 121 }, (_, i) => ({ id: 'offer-' + i, model: 'iPhone 15 Pro Max', storageGB: 256, priceCents: 300000 + i, messageAt: 1791205200000, supplierName: 'Fornecedor ' + i, groupName: 'Grupo de teste' }));
  const result = { runId: 'run-a', query: 'iPhone 15 Pro Max 256GB', results: offers.slice(0, 10), count: 10, period: { from: 1791198000000, to: 1791205200000 }, filters: { modelKey: 'iphone-15-pro-max', storageGB: 256 }, order: 'cashAscending' };
  let previewFormat = 'both';
  const handlers = {
    searchesState: () => base,
    runSearch: () => result,
    searchResultPage: p => ({ runId: p.runId, items: offers.slice(p.offset, p.offset + p.limit), total: offers.length, offset: p.offset, limit: p.limit }),
    searchExportExcel: () => ({ saved: true, name: 'ofertas.xlsx', count: 121 }),
    searchListPreview: p => { previewFormat = p.format; return { previewId: 'preview-a', count: p.selection === 'selected' ? p.offerIds.length : 121, query: result.query, filters: result.filters, period: result.period, format: p.format, recipients: base.recipients.filter(r => p.recipientIds.includes(r.id)), parts: 3, textParts: 3, textPreview: '1. iPhone 15 Pro Max — R$ 3.000,00' }; },
    searchListPreviewPage: p => ({ previewId: p.previewId, text: 'Conteúdo completo da parte ' + p.part, part: p.part, total: previewFormat === 'excel' ? 1 : 3 }),
    searchSendList: () => ({ batchId: 'batch-a', deliveries: [{ id: 'delivery-a', recipientId: 'responsible-a', status: 'pending', createdAt: 1791205200000, target: '5511988880001@s.whatsapp.net' }] }),
    searchListDeliveryStatus: () => ({ batchId: 'batch-a', deliveries: [{ id: 'delivery-a', recipientId: 'responsible-a', status: 'confirmed', createdAt: 1791205200000, target: '5511988880001@s.whatsapp.net' }] })
  };
  const document = { querySelector: selector => elements.get(selector) || null, querySelectorAll: () => [], activeElement: null };
  const context = vm.createContext({ window: {}, document, confirm: () => true, navigator: { clipboard: { writeText: async () => {} } }, console, Set, Map, Date });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/ui/searches.js'), 'utf8'), context);
  let renders = 0, closed = 0;
  const ui = context.window.MegaBuscasUI.create({ auth: () => auth, data: () => data, groups: () => [], call: async (action, payload) => { calls.push({ action, payload: structuredClone(payload) }); if (!handlers[action]) throw new Error('Unexpected action: ' + action); return handlers[action](payload); }, render: () => renders++, showModal: (...args) => modals.push(args), closeModal: () => closed++, toast: (...args) => toasts.push(args) });
  const form = (id, values, recipients = []) => ({ id, dataset: {}, elements: { namedItem: name => ({ value: values[name] ?? '', checked: values[name] === true }) }, querySelector: () => ({ disabled: false, isConnected: true }), querySelectorAll: selector => selector === 'input[name="recipientIds"]:checked' ? recipients.map(value => ({ value })) : [], reportValidity: () => true });
  const action = (name, id) => ui.onAction('buscas-' + name, { dataset: { id }, disabled: false, isConnected: true });
  const selectOffer = (id, checked = true) => ui.onInput({ dataset: { offerSelect: id }, checked, type: 'checkbox', closest: () => null });
  const search = () => ui.onSubmit(form('buscas-query-form', { query: result.query }));
  return { ui, calls, handlers, toasts, modals, elements, data, base, form, action, selectOffer, search, setAuth: value => { auth = value; }, closed: () => closed, renders: () => renders };
}

test('BUSCAS selects offers across pages and exports all filtered results using a fixed run', async () => {
  const f = fixture(); await f.search();
  assert.match(f.ui.render(), /121 oferta\(s\) compatíveis/);
  assert.equal((f.ui.render().match(/data-offer-select=/g) || []).length, 50);
  f.selectOffer('offer-0'); f.selectOffer('offer-7');
  await f.action('result-next'); f.selectOffer('offer-57');
  assert.match(f.ui.render(), /3 oferta\(s\) selecionada\(s\) em todas as páginas/);
  await f.action('result-prev'); assert.match(f.ui.render(), /data-offer-select="offer-0" checked/);
  await f.action('export-options'); assert.match(f.modals.at(-1)[3], /121 resultados filtrados \(todas as páginas\)/);
  f.elements.set('#buscas-list-form', f.form('buscas-list-form', { selection: 'selected' }));
  await f.action('export-excel');
  const selected = f.calls.find(c => c.action === 'searchExportExcel');
  assert.deepEqual(selected.payload, { runId: 'run-a', selection: 'selected', offerIds: ['offer-0', 'offer-7', 'offer-57'] });
  f.elements.set('#buscas-list-form', f.form('buscas-list-form', { selection: 'all' }));
  await f.action('export-excel');
  assert.deepEqual(f.calls.filter(c => c.action === 'searchExportExcel').at(-1).payload, { runId: 'run-a', selection: 'all', offerIds: [] });
  assert.equal(f.calls.filter(c => c.action === 'runSearch').length, 1, 'Export uses the fixed original run rather than silently searching again');
  await f.action('clear-offers'); assert.match(f.ui.render(), /0 oferta\(s\) selecionada/);
});

test('BUSCAS rejects empty selected export and only reports success after saving', async () => {
  const f = fixture(); await f.search();
  f.elements.set('#buscas-list-form', f.form('buscas-list-form', { selection: 'selected' }));
  await assert.rejects(f.action('export-excel'), /Selecione pelo menos uma oferta/);
  f.elements.set('#buscas-list-form', f.form('buscas-list-form', { selection: 'all' }));
  f.handlers.searchExportExcel = () => ({ saved: false, cancelled: true });
  await f.action('export-excel'); assert.deepEqual(f.toasts.at(-1), ['Exportação cancelada.']); assert.equal(f.closed(), 0);
  f.handlers.searchExportExcel = () => ({ path: '/not-written.xlsx', count: 121 });
  await assert.rejects(f.action('export-excel'), /criação do Excel não foi confirmada/);
  assert(!f.toasts.some(t => t[0].includes('Excel salvo')));
});

test('BUSCAS requires an explicit responsible, previews before sending and prevents repeated clicks', async () => {
  const f = fixture(); await f.search(); await f.action('deliver');
  assert.equal(f.calls.filter(c => c.action === 'searchSendList').length, 0);
  f.elements.set('#buscas-list-form', f.form('buscas-list-form', { selection: 'all', format: 'both' }));
  await assert.rejects(f.action('preview-list'), /Selecione pelo menos um responsável/);
  f.elements.set('#buscas-list-form', f.form('buscas-list-form', { selection: 'all', format: 'both' }, ['responsible-b']));
  await f.action('preview-list');
  assert.deepEqual(f.calls.find(c => c.action === 'searchListPreview').payload.recipientIds, ['responsible-b']);
  assert.match(f.modals.at(-1)[3], /Responsável B/); assert.doesNotMatch(f.modals.at(-1)[3], /Responsável A/);
  let release; f.handlers.searchSendList = () => new Promise(resolve => { release = resolve; });
  const pending = f.action('confirm-list'); await Promise.resolve(); await f.action('confirm-list');
  assert.equal(f.calls.filter(c => c.action === 'searchSendList').length, 1);
  release({ batchId: 'batch-a', deliveries: [{ id: 'delivery-b', recipientId: 'responsible-b', status: 'pending' }] }); await pending;
  assert.match(f.ui.render(), /Pendente/);
  assert(!f.toasts.some(t => /sucesso|entregue/i.test(t[0])));
  await assert.rejects(f.action('confirm-list'), /prévia não está mais disponível/);
});

test('BUSCAS presents accepted and delivered results separately and clears sensitive state on reset', async () => {
  const f = fixture(); await f.search();
  f.elements.set('#buscas-list-form', f.form('buscas-list-form', { selection: 'all', format: 'excel' }, ['responsible-a']));
  await f.action('preview-list'); await f.action('confirm-list'); await f.action('refresh-list-delivery');
  assert.match(f.ui.render(), /Enviado — aceito pela integração/);
  assert.doesNotMatch(f.ui.render(), /Entregue — recibo recebido/);
  f.handlers.searchListDeliveryStatus = () => ({ batchId: 'batch-a', deliveries: [{ id: 'delivery-a', recipientId: 'responsible-a', status: 'confirmed', deliveredAt: 1791205300000 }] });
  await f.action('refresh-list-delivery'); assert.match(f.ui.render(), /Entregue — recibo recebido/);
  f.selectOffer('offer-0'); f.ui.reset();
  assert.doesNotMatch(f.ui.render(), /Entrega da lista|data-offer-select=|121 oferta\(s\)/);
});

test('BUSCAS discards async preview when the logged-in user changes', async () => {
  const f = fixture(); await f.search();
  f.elements.set('#buscas-list-form', f.form('buscas-list-form', { selection: 'all', format: 'text' }, ['responsible-a']));
  let release; f.handlers.searchListPreview = () => new Promise(resolve => { release = resolve; });
  const pending = f.action('preview-list'); await Promise.resolve();
  f.setAuth({ user: { id: 'actor-b', isOwner: false } }); release({ previewId: 'stale', count: 121 });
  await assert.rejects(pending, /usuário ou o modo de operação mudou/);
  assert(!f.modals.some(m => m[0] === 'buscas-list-preview'));
});

test('BUSCAS hides export and manual delivery without permissions and documents configurable commands', async () => {
  const f = fixture({ permissions: { export: false, send: false } }); await f.search();
  assert.doesNotMatch(f.ui.render(), /data-action="buscas-export-options"|data-action="buscas-deliver"|data-offer-select=/);
  await assert.rejects(f.action('export-options'), /Sem permissão/);
  await assert.rejects(f.action('deliver'), /Sem permissão/);
  f.base.settings.prefix = '!oferta';
  assert.match(f.ui.render(), /!oferta --excel iPhone 15 Pro Max 256GB/);
  assert.match(f.ui.render(), /!oferta --ambos iPhone 15 Pro Max 256GB/);
});

test('BUSCAS preserves basic text search when the profile cannot consult the full offer catalog', async () => {
  const f = fixture({ permissions: { view: false, export: false, send: false } }); await f.search();
  assert.equal(f.calls.filter(c => c.action === 'searchResultPage').length, 0);
  assert.equal((f.ui.render().match(/data-offer-id=/g) || []).length, 10);
  assert.doesNotMatch(f.ui.render(), /data-action="buscas-result-next"/);
});

test('BUSCAS allows complete message preview beyond the first two parts without queuing any delivery', async () => {
  const f = fixture(); await f.search(); await f.action('deliver');
  f.elements.set('#buscas-list-form', f.form('buscas-list-form', { selection: 'all', format: 'text' }, ['responsible-a']));
  await f.action('preview-list');
  assert.match(f.modals.at(-1)[3], /Conteúdo completo da parte 1/);
  assert.match(f.modals.at(-1)[3], /Parte 1 de 3/);
  await f.action('preview-part-next'); await f.action('preview-part-next');
  assert.match(f.modals.at(-1)[3], /Conteúdo completo da parte 3/);
  assert.match(f.modals.at(-1)[3], /Parte 3 de 3/);
  assert.doesNotMatch(f.modals.at(-1)[3], /data-action="buscas-preview-part-next"/);
  await f.action('preview-part-prev'); assert.match(f.modals.at(-1)[3], /Parte 2 de 3/);
  assert.deepEqual(f.calls.filter(c => c.action === 'searchListPreviewPage').map(c => c.payload.part), [1, 2, 3, 2]);
  assert.equal(f.calls.filter(c => c.action === 'searchSendList').length, 0);
  f.handlers.searchListPreviewPage = () => { throw new Error('A prévia expirou. Gere novamente.'); };
  await assert.rejects(f.action('preview-part-next'), /prévia expirou/);
  assert.equal(f.calls.filter(c => c.action === 'searchSendList').length, 0);
});

test('BUSCAS does not restore a closed or replaced preview after asynchronous navigation', async () => {
  const f = fixture(); await f.search(); await f.action('deliver');
  f.elements.set('#buscas-list-form', f.form('buscas-list-form', { selection: 'all', format: 'text' }, ['responsible-a']));
  await f.action('preview-list'); const before = f.modals.length;
  let release; f.handlers.searchListPreviewPage = () => new Promise(resolve => { release = resolve; });
  const pending = f.action('preview-part-next'); await Promise.resolve(); await f.action('close');
  release({ previewId: 'preview-a', part: 2, total: 3, text: 'Must not restore old preview' }); await pending;
  assert.equal(f.modals.length, before); assert.equal(f.calls.filter(c => c.action === 'searchSendList').length, 0);
});
