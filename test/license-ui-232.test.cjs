'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

function fixture({ allowed = true, permissions = ['settings.edit', 'history.export', 'automation.control'], authenticated = true } = {}) {
  let monotonic = 1000, wall = Date.parse('2026-10-07T15:00:00Z'), interval;
  const license = { allowed, status: allowed ? 'trial' : 'expired', plan: 'trial', remainingMs: allowed ? 72 * 3600000 : 0, trialStartedAt: wall, expiresAt: wall + 72 * 3600000, offlineUntil: wall + 72 * 3600000, serverConfigured: true };
  const data = { auth: { authenticated, user: authenticated ? { id: 'owner' } : null }, license, automation: { stopped: !allowed } }, elements = new Map(), calls = [], toasts = [], renders = [], navigation = [];
  const document = { querySelector: selector => elements.get(selector) || null, querySelectorAll: () => [], activeElement: null };
  class AlterableDate extends Date { static now() { return wall; } }
  const context = vm.createContext({ window: { addEventListener() {} }, document, performance: { now: () => monotonic }, Date: AlterableDate, setInterval: callback => { interval = callback; return 1; }, clearInterval() {}, confirm: () => true, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/ui/license.js'), 'utf8'), context);
  const handlers = { licenseActivate: async () => { data.license = { ...data.license, allowed: true, status: 'active', plan: 'monthly', remainingMs: 31 * 86400000, expiresAt: wall + 31 * 86400000 }; }, licenseRefresh: async () => {}, resumeAutomation: async () => { data.automation.stopped = false; } };
  const ui = context.window.KennedLicenseUI.create({ data: () => data, auth: () => data.auth, can: permission => permissions.includes(permission), call: async (action, payload) => { calls.push({ action, payload }); return handlers[action](payload); }, refresh: async () => ui.sync(data), render: () => renders.push(ui.renderPage()), navigate: page => navigation.push(page), modalKind: () => null, closeModal() {}, showModal() {}, toast: (...args) => toasts.push(args) });
  ui.sync(data);
  const form = key => { const input = { value: key, disabled: false, isConnected: true }, submit = { disabled: false, isConnected: true }; return { input, controls: [input, submit], elements: { namedItem: () => input }, reportValidity: () => true, querySelectorAll: () => [input, submit] }; };
  return { ui, data, handlers, calls, toasts, renders, navigation, elements, form, clock: delta => { monotonic += delta; }, changeWall: delta => { wall += delta; }, tick: () => interval() };
}

test('License UI displays server dates in Brasília and remaining time uses a monotonic clock', () => {
  const f = fixture(); assert.match(f.ui.renderPage(), /10\/10\/2026, 12:00:00 \(Brasília\)/); assert.match(f.ui.renderPage(), /3 dia\(s\) e 0h/);
  f.changeWall(-10 * 86400000); assert.match(f.ui.renderPage(), /3 dia\(s\) e 0h/);
  f.clock(3600000); assert.match(f.ui.renderPage(), /2 dia\(s\) e 23h/);
});

test('Confirmed expired licence exposes activation and developer contact only, preserving data without readonly/export access', () => {
  const f = fixture({ allowed: false });
  const html = f.ui.renderPage();
  assert.match(html, /Sua licença expirou/); assert.match(html, /Seus dados estão preservados/);
  assert.match(html, /Guilherme Kenned/); assert.match(html, /99403-3173/); assert.match(html, /data-action="open-support"/);
  assert.doesNotMatch(html, /data-action="backup"|data-action="export-history"|data-action="license-resume"/);
  assert.doesNotMatch(html, /Configurações, consulta e exportação continuam disponíveis/);
  for (const action of ['confirm-activation', 'buscas-confirm-list', 'reminders-test', 'backup', 'export-history', 'save-template', 'pause', 'stop-all', 'opportunity-evaluate', 'source-resume-group']) assert.throws(() => f.ui.assertAction(action), /Ative|Renove|licen[cç]a|expir/i, action);
  for (const action of ['license-open', 'license-refresh', 'open-support', 'window-minimize']) assert.doesNotThrow(() => f.ui.assertAction(action));
  assert.equal(f.calls.length, 0, 'Developer contact must not open or send automatically while rendering');
  const restricted = fixture({ allowed: false, permissions: [] }); assert.doesNotMatch(restricted.ui.renderPage(), /data-action="backup"|data-action="export-history"/);
});

test('License UI pauses at expiry and opens activation again after an expired user logs in', () => {
  const f = fixture(); f.data.license = { ...f.data.license, allowed: false, status: 'expired', remainingMs: 0 };
  assert.equal(f.ui.sync(f.data), true); assert.equal(f.ui.sync(f.data), false);
  f.data.auth = { authenticated: false }; assert.equal(f.ui.sync(f.data), false);
  f.data.auth = { authenticated: true, user: { id: 'owner' } }; assert.equal(f.ui.sync(f.data), true);
  assert.equal(f.calls.filter(call => call.action === 'resumeAutomation').length, 0);
});

test('Activation is single-flight and clears the secret field before sending without resuming automations', async () => {
  const f = fixture({ allowed: false }), form = f.form('SEPARATE-TEST-KEY'); let release;
  f.handlers.licenseActivate = () => new Promise(resolve => { release = resolve; });
  const first = f.ui.onSubmit(form); await Promise.resolve(); assert.equal(form.input.value, ''); assert(form.controls.every(control => control.disabled));
  await f.ui.onSubmit(f.form('DUPLICATE-CLICK')); assert.equal(f.calls.length, 1);
  f.data.license = { ...f.data.license, allowed: true, status: 'active', plan: 'monthly', autoResumeRequired: true }; release(); await first;
  assert.equal(f.calls.filter(call => call.action === 'resumeAutomation').length, 0); assert(f.toasts.some(toast => toast[0].includes('Licença validada')));
  assert.match(f.ui.renderPage(), /envios permanecem pausados/); assert(form.controls.every(control => !control.disabled));
});

test('Rejected licence never reports success and never includes a submitted key in feedback', async () => {
  const f = fixture(); f.handlers.licenseActivate = async () => { throw Object.assign(new Error('Rejected PRIVATE-TEST-KEY'), { code: 'UNEXPECTED_TEST_REJECTION' }); };
  await f.ui.onSubmit(f.form('PRIVATE-TEST-KEY'));
  assert(!f.toasts.some(toast => toast[0].includes('Licença validada'))); assert(!f.toasts.some(toast => toast[0].includes('PRIVATE-TEST-KEY')));
  assert.doesNotMatch(f.ui.renderPage(), /PRIVATE-TEST-KEY/); assert.match(f.ui.renderPage(), /chave omitida/);
  f.handlers.licenseActivate = async () => { throw Object.assign(new Error('Server rejected'), { code: 'KEY_ALREADY_USED' }); };
  await f.ui.onSubmit(f.form('OTHER-TEST-KEY')); assert.match(f.ui.renderPage(), /vinculada a outro dispositivo/);
});

test('Activation response cannot produce success until a valid current status is available', async () => {
  const f = fixture({ allowed: false }); f.handlers.licenseActivate = async () => ({ allowed: true });
  await f.ui.onSubmit(f.form('UNCONFIRMED-TEST-KEY'));
  assert(!f.toasts.some(toast => toast[0].includes('Licença validada'))); assert.match(f.ui.renderPage(), /não confirmou uma licença válida/);
});

test('License status and errors are escaped, access without licence does not grant export permissions', () => {
  const f = fixture({ allowed: false, permissions: [] }); f.data.license = { ...f.data.license, reason: '<img src=x onerror=alert(1)>', status: '<script>' }; f.ui.sync(f.data);
  const html = f.ui.renderPage(); assert.doesNotMatch(html, /<img src=x|<script>/); assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /data-action="backup"|data-action="export-history"|data-action="license-resume"/);
});
