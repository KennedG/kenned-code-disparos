'use strict';

// Full production pipelines with native SQLite and the actual WhatsAppAdapter (version 2.3 regressions).
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
      socket = { ev: new EventEmitter(), ws: new EventEmitter(), user: { id: '5562998881111:27@s.whatsapp.net', lid: '400099991111:27@lid' },
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

test('comando privado PN autorizado consulta oferta capturada e responde somente ao solicitante sem USYNC', async t => {
  const f = await fixture(t);
  f.socket.onWhatsApp = async () => { throw new Error('USYNC blocked for a factual private chat'); };
  f.store.saveAlertRecipient({ id: 'other-private-recipient', name: 'Outro destinatário', phone: '5531999990003', enabled: true });
  f.searches.saveSettings({ recipientMode: 'responsibles', responsibleRecipientIds: ['other-private-recipient'] }, f.owner.id);
  f.emitMessage('iPhone 15 Pro Max 256GB Azul seminovo R$ 3.850,00', { group: true, phone: '5541999990004' }); await f.idle();
  const id = f.emitMessage('!busca iPhone 15 Pro Max 256GB', { group: false }); await f.idle();
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].target, OWNER_PHONE + '@s.whatsapp.net');
  assert(f.sends[0].content.text.includes('3.850,00')); assert.match(f.sends[0].content.text, /RESULTADO DA BUSCA/);
  const run = f.store.listSearchRuns().items.find(x => x.messageId === id);
  assert.equal(run.resultCount, 1); assert.equal(f.store.listSearchDeliveries({ runId: run.id }).items[0].status, 'confirmed');
  f.emitMessage('!busca iPhone 15 Pro Max 256GB', { group: false, id }); await f.idle(); assert.equal(f.sends.length, 1);
});

test('comando privado LID mapeado pelo protocolo responde ao solicitante sem consulta de existência', async t => {
  const f = await fixture(t), lid = '8234567890@lid';
  f.socket.onWhatsApp = async () => { throw new Error('USYNC blocked'); };
  f.socket.signalRepository = { lidMapping: { getPNForLID: async jid => { assert.equal(jid, lid); return OWNER_PHONE + '@s.whatsapp.net'; } } };
  const emit = text => f.socket.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: randomUUID(), fromMe: false, remoteJid: lid }, message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000) }] });
  emit('!busca iPhone 18 Pro Max Silver'); await new Promise(resolve => setImmediate(resolve)); await f.idle();
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].target, lid); assert.match(f.sends[0].content.text, /Não foram encontradas ofertas compatíveis/);
  assert.equal(f.store.listSearchDeliveries().items[0].status, 'confirmed');
  emit('!busca'); await f.idle(); assert.equal(f.sends.length, 2); assert.equal(f.sends[1].target, lid); assert.match(f.sends[1].content.text, /Use !busca|exemplo/i);
});

test('número privado não autorizado não executa busca nem recebe resposta apesar do nome exibido', async t => {
  const f = await fixture(t);
  f.emitMessage('!busca iPhone 15 Pro Max 256GB', { group: false, phone: '5562998880000' }); await f.idle();
  assert.equal(f.sends.length, 0); assert.equal(f.store.listSearchRuns().total, 0);
  assert(f.store.queryEntities('diagnostics', { limit: 100 }).items.some(x => x.stage === 'buscas.rejected' && x.detail?.reason === 'sender_not_authorized'));
});

test('alerta privado do dono particular usa chat recebido e separa servidor de entrega ao dispositivo', async t => {
  const f = await fixture(t);
  f.socket.onWhatsApp = async () => { throw new Error('USYNC blocked for a factual inbound'); };
  f.emitMessage('Olá', { group: false }); await f.idle();
  const result = await f.alerts.testRecipient(OWNER_PHONE, f.owner.id, { recipientId: 'user:' + f.owner.id }); await f.idle();
  assert.equal(result.status, 'confirmed'); assert.equal(result.confirmationScope, 'whatsapp-server'); assert.equal(result.deliveredAt, undefined);
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].target, OWNER_PHONE + '@s.whatsapp.net'); assert.equal(f.local.length, 1);
  f.socket.ev.emit('message-receipt.update', [{ key: { id: result.messageId, fromMe: true }, receipt: { receiptTimestamp: Math.floor(Date.now() / 1000) } }]);
  assert.equal(f.store.getAlert(result.id).status, 'delivered'); assert.ok(f.store.getAlert(result.id).deliveredAt);
});
