'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const ui = require('../src/ui/recovery-presenter.js');

test('computer clock follows the OS date and timezone instead of forcing Brasília', () => {
  const script = `const ui=require(${JSON.stringify(require.resolve('../src/ui/recovery-presenter.js'))}); process.stdout.write(JSON.stringify(ui.clock(new Date('2026-10-13T15:07:31Z'))));`;
  const run = timezone => {
    const result = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: timezone }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  const sp = run('America/Sao_Paulo'), ny = run('America/New_York');
  assert.equal(sp.time, '12:07:31'); assert.equal(sp.timezone, 'America/Sao_Paulo'); assert.equal(sp.offsetMinutes, -180);
  assert.equal(ny.time, '11:07:31'); assert.equal(ny.timezone, 'America/New_York'); assert.equal(ny.offsetMinutes, -240);
  assert.equal(sp.now, ny.now); assert.equal(sp.date, '13/10/2026');
});

test('live clock changes only text nodes and has no RPC or scheduling side effects', () => {
  let writes = 0;
  const nodes = ['time', 'date', 'timezone'].map(key => ({ dataset: { computerClock: key }, get textContent() { return this.value; }, set textContent(value) { this.value = value; writes++; } }));
  const root = { querySelectorAll(selector) { assert.equal(selector, '[data-computer-clock]'); return nodes; } };
  const at = new Date('2026-10-13T15:07:00Z');
  ui.updateClock(root, at); const initial = writes;
  ui.updateClock(root, at); assert.equal(writes, initial, 'Same second does not mutate nodes');
  ui.updateClock(root, new Date(at.getTime() + 1000)); assert.equal(writes, initial + 1);
  assert.match(ui.renderClock(at), /Horário oficial do computador|HORÁRIO DO COMPUTADOR/);
  assert.match(ui.renderClock(at), /Nenhum horário perdido é acumulado/);
});

test('campaign timing shows scheduled slot rather than delayed completion and preserves manual authorization', () => {
  const c = { state: 'active', lastRoundScheduledAt: 1791896400000, lastRoundAt: 1791896520000, nextRunAt: 1791897000000, executionAuthorization: { at: 1791896400000, dateKey: '2026-10-13', timezone: 'America/Sao_Paulo', manual: true } };
  const value = ui.timing(c);
  assert.equal(value.last, c.lastRoundScheduledAt); assert.equal(value.next, c.nextRunAt);
  assert.equal(value.authorizedAt, c.executionAuthorization.at); assert.equal(value.authorizedTimezone, 'America/Sao_Paulo');
  const html = ui.renderTiming(c); assert.match(html, /Última rodada prevista/); assert.match(html, /Próxima rodada/); assert.match(html, /Iniciada:/);
});

test('recovered connection status and interrupted-round pending state do not claim immediate sending', () => {
  const message = 'Conexão recuperada — aguardando próximo horário de rodada';
  assert.equal(ui.timing({ state: 'active', executionRecovery: { status: message }, nextRunAt: Date.now() + 600000 }).status, message);
  assert.match(ui.timing({ state: 'active', executionPendingRoundId: 'round-1' }).status, /itens pendentes aguardam próximo horário/);
  assert.match(ui.timing({ state: 'draft' }).status, /nenhum envio autorizado/);
  assert.match(ui.timing({ state: 'paused' }).status, /requer retomada autorizada/);
  assert.match(ui.timing({ state: 'stopped' }).status, /nenhum envio agendado/);
});

test('muting a blocking incident preserves visual alert and recovering removes it', () => {
  const notification = { id: 'i:disconnect', occurrenceId: 'i', active: true, blocking: true, muted: true, integrationMode: 'whatsapp', reason: 'Conexão perdida', at: 1000 };
  const d = { storageMode: 'whatsapp', notifications: [notification], connection: { state: 'disconnected' } };
  assert.equal(ui.activeIncidents(d).length, 1); assert.equal(ui.incidentView(notification, d).muted, true);
  d.notifications = [{ ...notification, active: false, resolvedAt: 2000, recoveredAt: 2000 }];
  assert.equal(ui.activeIncidents(d).length, 0);
});

test('deduplicated occurrences and mode isolation prevent repeated or fictitious incident cards', () => {
  const d = { storageMode: 'whatsapp', notifications: [
    { id: 'a:critical', occurrenceId: 'a', active: true, at: 3000, integrationMode: 'whatsapp' },
    { id: 'a:disconnect', occurrenceId: 'a', active: true, at: 3000, integrationMode: 'whatsapp' },
    { id: 'b:critical', occurrenceId: 'b', active: true, at: 2000, integrationMode: 'simulated' },
    { id: 'old', occurrenceId: 'old', active: false, at: 1000 },
    { id: 'nonblocking', occurrenceId: 'nonblocking', at: 1500 },
  ] };
  assert.deepEqual(ui.activeIncidents(d).map(value => value.occurrenceId), ['a']);
});

test('critical campaign errors stay visible even with connected WhatsApp and show safe available details', () => {
  const incident = { id: 'error', occurrenceId: 'error', active: true, blocking: true, campaignId: 'c', pending: 7, reason: 'Grupo somente administradores', code: 'GROUP_PERMISSION_DENIED', traceId: 'trace' };
  const d = { connection: { state: 'connected' }, campaigns: [{ id: 'c', name: 'Lista da loja' }], notifications: [incident] };
  assert.equal(ui.activeIncidents(d).length, 1);
  const view = ui.incidentView(incident, d); assert.equal(view.campaigns, 'Lista da loja'); assert.equal(view.pending, 7); assert.equal(view.traceId, 'trace'); assert.equal(view.disconnected, false); assert.match(view.action, /Revise o destino/);
});

test('disconnect incident lists affected campaigns without inventing unknown counts or a delivery', () => {
  const view = ui.incidentView({ occurrenceId: 'connection', affectedCampaigns: [{ id: '1', name: 'A', pending: 2 }, { id: '2', name: 'B', pending: 3 }] }, { connection: { state: 'disconnected' } });
  assert.equal(view.campaigns, 'A · B'); assert.equal(view.pending, null); assert.match(view.action, /próximo horário/); assert.equal(view.disconnected, true);
  assert.doesNotMatch(view.reason, /entregue|enviado com sucesso/i);
});

test('campaign timing escapes untrusted status and timezone before displaying them', () => {
  const html = ui.renderTiming({ state: 'active', executionRecovery: { status: '<img src=x onerror=1>' }, executionAuthorization: { at: Date.now(), timezone: '<script>x</script>' } });
  assert.doesNotMatch(html, /<img|<script>/); assert.match(html, /&lt;img/); assert.match(html, /&lt;script/);
});
