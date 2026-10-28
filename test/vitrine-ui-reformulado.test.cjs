'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(t, { permissions = ['*'] } = {}) {
  const at = Date.now(), nodes = new Map(), intervals = new Map(), timers = new Map(), calls = [], toasts = [], modals = [], listeners = new Map(); let sequence = 0, modalKind = '';
  const data = { auth: { authenticated: true, user: { id: 'owner' } }, license: { allowed: true, status: 'active' }, storageMode: 'whatsapp' };
  const classes = new Set();
  const document = { querySelector: selector => nodes.get(selector) || null, querySelectorAll: () => [], fullscreenElement: null, addEventListener: (name, listener) => listeners.set(name, listener), exitFullscreen: async () => { document.fullscreenElement = null; }, createElement: () => {
    const node = { innerHTML: '', id: '', className: '', setAttribute: () => {}, requestFullscreen: async () => { document.fullscreenElement = node; }, remove: () => nodes.delete('#' + node.id) }; return node;
  }, body: { classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) }, appendChild: node => nodes.set('#' + node.id, node) } };
  const publicData = { mode: 'vitrine', config: { brandName: 'Marca pública de teste', commercialContact: 'CONTATO-COMERCIAL', secondsPerItem: 5 }, items: [{ id: 'public-1', model: 'iPhone 16', storage: '128GB', color: 'Rosa', priceCents: 299900, audience: 'retail', availability: 'ready', defectNotes: 'Detalhe na tela pequeno', publicDescription: 'Bateria: 92%', mediaId: 'photo-1', expiresAt: at + 600000 }], qrCode: 'data:image/png;base64,iVBORw0KGgo=' };
  const handlers = { vitrinePublic: () => structuredClone(publicData), vitrineState: () => ({ config: publicData.config, items: [], candidates: [] }) };
  const context = vm.createContext({ window: {}, document, Date, Intl, Set, Map, console, confirm: () => true, setTimeout: callback => { const id = ++sequence; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id), setInterval: callback => { const id = ++sequence; intervals.set(id, callback); return id; }, clearInterval: id => intervals.delete(id) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/ui/vitrine.js'), 'utf8'), context);
  const ui = context.window.MegaVitrine.create({ data: () => data, auth: () => data.auth, can: permission => permissions.includes('*') || permissions.includes(permission), call: async (action, payload) => { calls.push({ action, payload: structuredClone(payload) }); if (!handlers[action]) throw new Error('Unexpected RPC ' + action); return handlers[action](payload); }, render: () => {}, refresh: async () => {}, toast: (...args) => toasts.push(args), showModal: (...args) => { modalKind = args[0]; modals.push(args); }, closeModal: () => { modalKind = ''; }, modalKind: () => modalKind });
  ui.sync(data); t.after(() => ui.stop());
  return { ui, data, publicData, handlers, calls, nodes, intervals, timers, classes, document, toasts, modals, html: () => nodes.get('#vitrine-tv-root')?.innerHTML || '', poll: () => { for (const callback of [...intervals.values()]) callback(); }, flush: async () => { await new Promise(resolve => setImmediate(resolve)); } };
}

test('real TV renderer builds a public overlay with photo, price, defect notes and approved QR field', async t => {
  const f = fixture(t); await f.ui.onAction('vitrine-open');
  assert(f.classes.has('tv-mode')); assert.equal(f.document.fullscreenElement.id, 'vitrine-tv-root');
  assert.match(f.html(), /iPhone 16|128GB|Rosa|2\.999,00/); assert.match(f.html(), /Detalhe na tela pequeno/);
  assert.match(f.html(), /mega-media:\/\/asset\/photo-1/); assert.match(f.html(), /QR code do atendimento comercial/);
  assert.equal(f.intervals.size, 1); assert.equal(f.timers.size, 1);
});

test('confirmed expiry with stripped auth preserves mounted neutral TV showing brand only', async t => {
  const f = fixture(t); await f.ui.onAction('vitrine-open');
  f.data.auth = { authenticated: false }; delete f.data.storageMode; f.data.license = { allowed: false, status: 'expired', totalBlocked: true };
  f.ui.sync(f.data);
  assert(f.nodes.has('#vitrine-tv-root')); assert(f.classes.has('tv-mode')); assert.match(f.html(), /Marca pública de teste/);
  assert.doesNotMatch(f.html(), /iPhone 16|CONTATO-COMERCIAL|2\.999|Sua licença|expirou|Chave|Renove/);
  assert.equal(f.intervals.size, 0); assert.equal(f.timers.size, 0); assert.equal(f.toasts.length, 0);
  f.ui.sync(f.data); assert(f.nodes.has('#vitrine-tv-root')); assert.equal(f.intervals.size, 0);
});

test('valid offline grace keeps TV and timers running without interpreting outage as expiry', async t => {
  const f = fixture(t); await f.ui.onAction('vitrine-open');
  f.data.license = { allowed: true, status: 'offline_grace', reasonCode: 'LICENSE_SERVICE_UNAVAILABLE', offlineUntil: Date.now() + 7200000 };
  f.ui.sync(f.data); assert.match(f.html(), /iPhone 16/); assert.equal(f.intervals.size, 1); assert.equal(f.timers.size, 1);
  assert.equal(f.toasts.length, 0);
});

test('renewal restores permissions but cannot automatically republish the previous TV presentation', async t => {
  const f = fixture(t); await f.ui.onAction('vitrine-open');
  f.data.license = { allowed: false, status: 'expired', totalBlocked: true }; f.data.auth = {};
  f.ui.sync(f.data); const count = f.calls.length;
  f.data.auth = { authenticated: true, user: { id: 'owner' } }; f.data.storageMode = 'whatsapp'; f.data.license = { allowed: true, status: 'active' };
  f.ui.sync(f.data); f.poll(); await f.flush();
  assert.match(f.html(), /Marca pública de teste/); assert.doesNotMatch(f.html(), /iPhone 16|CONTATO-COMERCIAL/);
  assert.equal(f.calls.length, count); assert.equal(f.intervals.size, 0); assert.equal(f.timers.size, 0);
});

test('a delayed public poll cannot restore adverts after confirmed expiration', async t => {
  const f = fixture(t); await f.ui.onAction('vitrine-open'); let resolve;
  f.handlers.vitrinePublic = () => new Promise(done => { resolve = done; }); f.poll(); await f.flush();
  assert.equal(typeof resolve, 'function'); f.data.auth = {}; f.data.license = { allowed: false, status: 'expired', totalBlocked: true }; f.ui.sync(f.data);
  resolve(structuredClone(f.publicData)); await f.flush();
  assert.match(f.html(), /Marca pública de teste/); assert.doesNotMatch(f.html(), /iPhone 16|2\.999|CONTATO-COMERCIAL/);
  assert.equal(f.timers.size, 0); assert.equal(f.intervals.size, 0); assert.equal(f.toasts.length, 0);
});

test('expired and disabled adverts never become visible even if a stale payload contains them', async t => {
  const f = fixture(t); f.publicData.items = [{ ...f.publicData.items[0], expiresAt: Date.now() - 1 }, { ...f.publicData.items[0], id: 'disabled', enabled: false }, { ...f.publicData.items[0], id: 'no-price', priceCents: null }];
  await f.ui.onAction('vitrine-open'); assert.match(f.html(), /Seja bem-vindo/); assert.doesNotMatch(f.html(), /iPhone 16|2\.999/); assert.equal(f.timers.size, 0);
});

test('mix presentation uses approved retail and wholesale prices in separate labeled slides', async t => {
  const f = fixture(t); f.publicData.config.audience = 'mixed'; f.publicData.items.push({ ...f.publicData.items[0], audience: 'wholesale', priceCents: 280000 });
  await f.ui.onAction('vitrine-open'); assert.match(f.html(), /VAREJO · PARA VOCÊ/); assert.match(f.html(), /2\.999,00/); assert.doesNotMatch(f.html(), /2\.800,00/);
  await f.ui.onAction('vitrine-next'); assert.match(f.html(), /ATACADO · PARA LOJISTAS/); assert.match(f.html(), /2\.800,00/); assert.doesNotMatch(f.html(), /2\.999,00/);
  assert.match(f.html(), /Consulte nossa lista para lojistas/);
});

test('view-only users can open TV but cannot configure or publish; expired users cannot open it', async t => {
  const f = fixture(t, { permissions: ['vitrine.view'] });
  assert.match(f.ui.renderDashboard(), /Abrir modo TV/); assert.doesNotMatch(f.ui.renderDashboard(), /Selecionar e revisar anúncios/);
  await assert.rejects(f.ui.onAction('vitrine-configure'), /não permite gerenciar/); await f.ui.onAction('vitrine-open');
  f.ui.stop(); f.data.license = { allowed: false, status: 'expired' }; f.ui.sync(f.data);
  await assert.rejects(f.ui.onAction('vitrine-open'), /licença precisa estar válida/); assert(!f.nodes.has('#vitrine-tv-root'));
});

test('account or integration-mode switch removes old TV data and all rotation and poll timers', async t => {
  const f = fixture(t); await f.ui.onAction('vitrine-open');
  f.data.storageMode = 'simulated'; f.ui.sync(f.data);
  assert(!f.nodes.has('#vitrine-tv-root')); assert.equal(f.timers.size, 0); assert.equal(f.intervals.size, 0);
  f.data.storageMode = 'whatsapp'; f.ui.sync(f.data); await f.ui.onAction('vitrine-open');
  f.data.auth = { user: { id: 'other-user' } }; f.ui.sync(f.data); assert(!f.nodes.has('#vitrine-tv-root'));
});

test('simulation is identified in active TV while expired neutral branding exposes no operational banner', async t => {
  const f = fixture(t); f.data.storageMode = 'simulated'; f.ui.sync(f.data); await f.ui.onAction('vitrine-open');
  assert.match(f.html(), /SIMULAÇÃO — DADOS FICTÍCIOS/);
  f.data.license = { allowed: false, status: 'expired', totalBlocked: true }; f.data.auth = {};
  f.ui.sync(f.data); assert.match(f.html(), /Marca pública de teste/); assert.doesNotMatch(f.html(), /SIMULAÇÃO|licença|CONTATO-COMERCIAL|iPhone/);
});
