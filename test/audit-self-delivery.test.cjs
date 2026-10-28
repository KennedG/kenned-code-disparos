'use strict';

// Full production pipelines with native SQLite and the actual WhatsAppAdapter.
// Only the authenticated Baileys socket/Windows encryption facade are fakes:
// these regressions do not establish delivery on a real WhatsApp account.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { createStore } = require('../src/core/store.cjs');
const { AuthService } = require('../src/core/auth.cjs');
const { Scheduler } = require('../src/core/scheduler.cjs');
const { SearchService } = require('../src/core/search-service.cjs');
const { AlertService } = require('../src/core/alerts.cjs');
const { WhatsAppAdapter } = require('../src/adapters/whatsapp.cjs');

const OWNER_PHONE = '5511999990001';
const GROUP = '1200999999999@g.us';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-audit-pipeline-'));
  const store = await createStore(dir);
  store.setSetting('integrationMode', 'whatsapp');
  store.setSetting('initialized', true);
  const auth = new AuthService({ store });
  const owner = (await auth.setupOwner({ name: 'Dono de teste', username: 'owner-pipeline', phone: OWNER_PHONE, password: 'Teste-Baileys-pipeline-2026' })).user;
  store.upsertGroups([{ id: GROUP, name: 'Origem autorizada', simulation: false, authorized: true }]);
  let clockOffset = 0, socket, maximumConcurrent = 0, activeSubmissions = 0;
  const sends = [], lookups = [], local = [];
  let ackEnabled = true;
  const library = {
    BufferJSON: { replacer: (_key, value) => value, reviver: (_key, value) => value },
    initAuthCreds: () => ({}),
    proto: { Message: { AppStateSyncKeyData: { fromObject: value => value } } },
    default() {
      socket = { ev: new EventEmitter(), ws: new EventEmitter(), user: { id: `${OWNER_PHONE}:27@s.whatsapp.net`, lid: '400099991111:27@lid' },
        end() {}, logout: async () => {},
        onWhatsApp: async number => { lookups.push(number); return [{ exists: true, jid: `${number}@s.whatsapp.net` }]; },
        groupFetchAllParticipating: async () => ({ [GROUP]: { id: GROUP, subject: 'Origem autorizada' } }),
        sendMessage: async (target, content, options) => {
          activeSubmissions++; maximumConcurrent = Math.max(maximumConcurrent, activeSubmissions);
          sends.push({ target, content, options });
          const current = socket;
          queueMicrotask(() => {
            activeSubmissions--;
            if (ackEnabled) current.ws.emit('CB:ack,class:message', { attrs: { id: options.messageId } });
          });
          return { key: { id: options.messageId }, status: 1 };
        }
      };
      return socket;
    }
  };
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: data => Buffer.from(data).toString() };
  const makeAdapter = () => new WhatsAppAdapter({ store, credentialsDir: path.join(dir, 'credentials'), safeStorage, loadLibrary: async () => library, runtimePlatform: 'win32', ackTimeoutMs: 250 });
  let adapter = makeAdapter(); await adapter.connect(); socket.ev.emit('connection.update', { connection: 'open' });
  const now = () => Date.now() + clockOffset;
  const sleep = async ms => { clockOffset += Math.max(0, ms); };
  const scheduler = new Scheduler({ store, adapter, now, sleep });
  const searches = new SearchService({ store, adapter, authService: auth, scheduler, now, sleep }); searches.start();
  searches.saveSettings({ enabled: true, monitoredGroupIds: [GROUP], commandGroupIds: [GROUP], selfCommandsEnabled: true }, owner.id);
  const alerts = new AlertService({ store, adapter, scheduler, now, sleep }); alerts.on('localAlert', event => local.push(event)); alerts.start();
  const emitMessage = (text, { id = randomUUID(), fromMe = false, group = true, phone = OWNER_PHONE } = {}) => {
    const current = socket;
    current.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id, fromMe, remoteJid: group ? GROUP : `${phone}@s.whatsapp.net`, ...(group ? { participant: `${phone}:5@s.whatsapp.net` } : {}) }, message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000), pushName: 'Nome exibido não autoriza' }] });
    return id;
  };
  const idle = async () => { await searches.waitForIdle(); await alerts.waitForIdle(); await searches.waitForIdle(); };
  const reconnect = async () => { await adapter.connect(); socket.ev.emit('connection.update', { connection: 'open' }); await idle(); };
  const restartAdapter = async () => { await searches.suspendCapture('audit restart'); await adapter.disconnect(); await alerts.waitForIdle(); adapter = makeAdapter(); scheduler.setAdapter(adapter); searches.setAdapter(adapter); alerts.setAdapter(adapter); await adapter.connect(); socket.ev.emit('connection.update', { connection: 'open' }); searches.resumeCapture(); await idle(); };
  t.after(async () => { await searches.shutdown(); await alerts.shutdown(); await scheduler.shutdown(); await adapter.disconnect(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, auth, owner, searches, alerts, scheduler, sends, lookups, local, emitMessage, idle, reconnect, restartAdapter,
    get adapter() { return adapter; }, get socket() { return socket; }, get maximumConcurrent() { return maximumConcurrent; },
    setAck(enabled) { ackEnabled = enabled; } };
}

test('native SQLite plus WhatsAppAdapter accepts a manual self command with device PN and sends no-results once', async t => {
  const f = await fixture(t);
  const commandId = f.emitMessage('!busca iPhone 18 Pro Max Silver', { fromMe: true, group: false }); await f.idle();
  assert.equal(f.sends.length, 1, 'a durable prequeued delivery must not suppress its first transport submission');
  assert.equal(f.sends[0].target, `${OWNER_PHONE}@s.whatsapp.net`);
  assert.match(f.sends[0].content.text, /Não foram encontradas ofertas compatíveis/);
  assert.equal(f.lookups.length, 0, 'authenticated self uses its own PN, without guessing a remote author or external lookup');
  const run = f.store.listSearchRuns().items.find(item => item.source === 'whatsapp-self');
  assert.equal(run.resultCount, 0); assert.equal(f.store.listSearchDeliveries({ runId: run.id }).items[0].status, 'confirmed');
  f.emitMessage('!busca iPhone 18 Pro Max Silver', { id: commandId, fromMe: true, group: false }); await f.idle();
  assert.equal(f.sends.length, 1);
  const trace = f.store.queryEntities('diagnostics', { traceId: run.traceId, limit: 100 }).items;
  for (const stage of ['received', 'authorization', 'parsed', 'results', 'recipient', 'queued', 'submitted', 'integration']) assert.ok(trace.some(item => item.stage === `buscas.${stage}`), stage);
});

test('authorized other sender is searched and configured private recipients receive results, never implicit group origin', async t => {
  const f = await fixture(t);
  const user = await f.auth.createUser({ name: 'Responsável autorizado', username: 'authorized-pipeline', phone: '5521999990002', password: 'Teste-pipeline-user-2026', roleId: 'role-admin', requirePasswordChange: false, permissionOverrides: { 'search.view': true, 'search.run': true } });
  f.searches.saveAuthorization({ userId: user.id, permissions: ['search'], enabled: true }, f.owner.id);
  f.store.saveAlertRecipient({ id: 'configured-recipient', name: 'Destino cadastrado', phone: '5531999990003', enabled: true });
  f.searches.saveSettings({ recipientMode: 'responsibles', responsibleRecipientIds: ['configured-recipient'] }, f.owner.id);
  f.emitMessage('iPhone 18 Pro Max 256GB Silver lacrado R$ 7.000,00', { phone: '5541999990004' }); await f.idle();
  assert.equal(f.store.getSearchMonitorStats().confirmed, 1, 'the supplier message traverses Baileys events and the persistent capture queue');
  f.emitMessage('!busca iPhone 18 Pro Max Silver', { phone: user.phone }); await f.idle();
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].target, '5531999990003@s.whatsapp.net'); assert.match(f.sends[0].content.text, /7\.000,00/);
  assert.ok(f.lookups.includes('5531999990003')); assert.equal(f.store.listSearchDeliveries().items[0].status, 'confirmed');
  assert.ok(!f.sends.some(item => item.target === GROUP || item.target === `${user.phone}@s.whatsapp.net`));
});

test('persisted automatic IDs reject own automation echoes and replay after reconnect while new manual commands still work', async t => {
  const f = await fixture(t);
  f.emitMessage('!busca iPhone 18 Pro Max Silver', { fromMe: true, group: false }); await f.idle();
  assert.equal(f.sends.length, 1); const automaticId = f.sends[0].options.messageId;
  f.emitMessage('!busca iPhone 18 Pro Max Silver', { id: automaticId, fromMe: true, group: false }); await f.idle(); assert.equal(f.sends.length, 1);
  await f.restartAdapter();
  f.emitMessage('!busca iPhone 18 Pro Max Silver', { id: automaticId, fromMe: true, group: false }); await f.idle(); assert.equal(f.sends.length, 1);
  f.emitMessage('!busca', { fromMe: true, group: false }); await f.idle(); assert.equal(f.sends.length, 2); assert.match(f.sends[1].content.text, /Use !busca/);
});

test('real production alerts queue on disconnect, notify locally, then send once after ACK; server acceptance is not device delivery', async t => {
  const f = await fixture(t);
  f.socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } }); await f.idle();
  assert.ok(f.local.some(event => event.event === 'disconnect')); assert.equal(f.sends.length, 0);
  const pending = f.store.listAlerts().find(alert => alert.channel === 'whatsapp'); assert.equal(pending.status, 'pending'); const originalAt = pending.originalAt;
  await f.reconnect(); await f.alerts.flush(); await f.idle();
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].target, `${OWNER_PHONE}@s.whatsapp.net`);
  const confirmed = f.store.getAlert(pending.id); assert.equal(confirmed.status, 'confirmed'); assert.equal(confirmed.originalAt, originalAt); assert.equal(confirmed.deliveredAt, undefined);
  assert.match(confirmed.text, /Ocorrência original/); assert.match(confirmed.text, /Kenned Code Disparos/);
  await f.alerts.flush(); assert.equal(f.sends.length, 1);
  f.socket.ev.emit('message-receipt.update', [{ key: { id: confirmed.messageId, fromMe: true }, receipt: { receiptTimestamp: Math.floor(Date.now() / 1000) } }]);
  assert.equal(f.store.getAlert(pending.id).status, 'delivered'); assert.ok(f.store.getAlert(pending.id).deliveredAt);
  assert.equal(f.maximumConcurrent, 1);
});

test('campaign error and recipient test share the real alert pipeline without first-send suppression or duplicate occurrences', async t => {
  const f = await fixture(t);
  const incident = { id: randomUUID(), campaignId: 'campaign-audit', campaignName: 'Campanha legítima', at: Date.now(), reason: 'Falha definitiva de teste', code: 'CAMPAIGN_TEST_ERROR', kind: 'fatal', confirmed: 2, pending: 3 };
  f.store.saveCampaign({ id: incident.campaignId, name: incident.campaignName, state: 'stopped', ownerId: f.owner.id, items: [], groupIds: [GROUP], lastError: incident });
  f.scheduler.emit('incident', incident); f.scheduler.emit('incident', incident); await f.alerts.flush(); await f.idle();
  assert.equal(f.sends.length, 1); assert.match(f.sends[0].content.text, /Campanha interrompida por erro/);
  assert.equal(f.store.listAlerts().filter(alert => alert.occurrenceId === incident.id).length, 1);
  const result = await f.alerts.testRecipient(OWNER_PHONE, f.owner.id); assert.equal(result.status, 'confirmed'); assert.equal(f.sends.length, 2);
  assert.match(f.sends[1].content.text, /Teste de alerta/); assert.equal(f.maximumConcurrent, 1);
});

test('search and alert queues share one FIFO and stay unconfirmed until their individual authenticated ACKs', async t => {
  const f = await fixture(t); f.setAck(false);
  const until = async predicate => { const deadline = Date.now() + 200; while (!predicate() && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve)); assert.ok(predicate(), 'production queue reached the expected stage'); };
  const delivery = await f.searches.testRecipient({ recipientId: `user:${f.owner.id}` }, f.owner.id);
  await until(() => f.sends.length === 1);
  assert.equal(f.store.getSearchDelivery(delivery.id).status, 'sending');
  const alertTask = f.alerts.testRecipient(OWNER_PHONE, f.owner.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sends.length, 1, 'the alert cannot submit while the preceding search is awaiting its confirmation');
  assert.equal(f.store.listAlerts().find(item => item.code === 'ALERT_TEST').status, 'pending');
  f.socket.ws.emit('CB:ack,class:message', { attrs: { id: f.sends[0].options.messageId } });
  await until(() => f.sends.length === 2);
  assert.equal(f.store.getSearchDelivery(delivery.id).status, 'confirmed');
  assert.equal(f.store.listAlerts().find(item => item.code === 'ALERT_TEST').status, 'sending');
  f.socket.ws.emit('CB:ack,class:message', { attrs: { id: f.sends[1].options.messageId } });
  assert.equal((await alertTask).status, 'confirmed');
  assert.equal(f.sends.length, 2); assert.equal(f.maximumConcurrent, 1);
});
