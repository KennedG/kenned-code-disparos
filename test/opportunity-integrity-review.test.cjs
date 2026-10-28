'use strict';

// Independent integration regressions: actual SQLite store, parser, service
// and WhatsApp transport with a controlled socket. No real WhatsApp account.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');
const { createStore } = require('../src/core/store.cjs');
const { WhatsAppAdapter } = require('../src/adapters/whatsapp.cjs');
const { OpportunityService } = require('../src/core/opportunity-service.cjs');
const { parseRequest, parseCampaignOffer } = require('../src/core/opportunity-matcher.cjs');
const { assessCampaignItem, campaignItemFingerprint } = require('../src/core/opportunity-campaign.cjs');
const SHOP = '5562999991001', FIRST = '5562999991002', SECOND = '5562999991003';
const GROUP = '120363000000021@g.us', OTHER = '120363000000022@g.us';
const APP = path.resolve(__dirname, '..');
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function campaignProjection(item, campaign, now) {
  const candidate = parseCampaignOffer(item, campaign, {}, { originalAt: now })[0];
  const assessment = assessCampaignItem(item, campaign, { availabilityMode: 'campaign', now });
  return { ...candidate, ...assessment, id: candidate.offerKey, eligible: true,
    campaignEligible: assessment.eligible, campaignItemFingerprint: campaignItemFingerprint(item, campaign) };
}
async function waitUntil(condition, timeout = 3000) { const until = Date.now() + timeout; while (!condition()) { if (Date.now() >= until) throw new Error('Fluxo não alcançou a etapa esperada no prazo.'); await new Promise(resolve => setTimeout(resolve, 5)); } }

async function fixture(t, { auto = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'op-review-integrity-'));
  const store = await createStore(dir); store.setSetting('integrationMode', 'whatsapp');
  store.upsertGroups([{ id: GROUP, name: 'Primeiro grupo', authorized: true, simulation: false }, { id: OTHER, name: 'Outro grupo', authorized: true, simulation: false }]);
  let now = Math.floor(Date.now() / 1000) * 1000 - 2000, socket, canOperate = true;
  const caption = '📱 iPhone 13 Pro 256GB Azul seminovo bateria 90% R$ 2.500,00 disponível\nObservação: pequena marca na lateral. ✅';
  const campaign = store.saveCampaign({ id: 'campaign-review', ownerId: 'owner', name: 'Lista real no fixture', state: 'draft', createdAt: now,
    items: [{ id: 'unit-item', type: 'text', text: caption, sourceGroupId: GROUP, sourceMessageId: 'original-unit', originalAt: now }], groupIds: [] });
  const submissions = [], localAlerts = [];
  let acknowledge = target => true, lookup = async number => [{ exists: true, jid: `${number}@s.whatsapp.net` }];
  const library = { BufferJSON: { replacer: (_, value) => value, reviver: (_, value) => value }, initAuthCreds: () => ({}),
    proto: { Message: { AppStateSyncKeyData: { fromObject: value => value } } }, WAMessageStubType: { CIPHERTEXT: 2, REVOKE: 1 },
    default() { socket = { ev: new EventEmitter(), ws: new EventEmitter(), user: { id: `${SHOP}:7@s.whatsapp.net` }, end() {}, logout: async () => {},
      onWhatsApp: (...args) => lookup(...args), sendMessage: async (target, content, options) => {
        submissions.push({ target, content, options }); if (acknowledge(target)) queueMicrotask(() => socket.ws.emit('CB:ack,class:message', { attrs: { id: options.messageId } }));
        return { status: 1, key: { id: options.messageId } };
      } }; return socket; } };
  const adapter = new WhatsAppAdapter({ store, credentialsDir: path.join(dir, 'credentials'), runtimePlatform: 'win32', loadLibrary: async () => library,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: bytes => bytes.toString() },
    controlTimeoutMs: 100, submissionTimeoutMs: 25, ackTimeoutMs: 15 });
  await adapter.connect(); socket.ev.emit('connection.update', { connection: 'open' });
  const service = new OpportunityService({ store, adapter, now: () => now, assertCanOperate: () => canOperate, assertCanCapture: () => true,
    assertOwnerPermissions: () => canOperate, onLocalAlert: value => localAlerts.push(value), sleep: async () => {} });
  service.saveConfig({ enabled: true, mode: auto ? 'automatic' : 'evaluation', monitoredGroupIds: [GROUP, OTHER], campaignIds: [campaign.id], sound: { burstSeconds: 1 } }, 'owner');
  service.start();
  const incoming = (id, text = 'iPhone 13 Pro 256GB quem tem?', extras = {}) => ({ key: { id, remoteJid: GROUP, participant: `${FIRST}@s.whatsapp.net`, fromMe: false, ...extras.key },
    messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: text }, pushName: 'Nome de perfil', ...extras,
    ...(extras.key ? { key: { id, remoteJid: GROUP, participant: `${FIRST}@s.whatsapp.net`, fromMe: false, ...extras.key } } : {}) });
  t.after(async () => { await service.stop(); await adapter.disconnect(); store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, store, service, adapter, campaign, caption, submissions, localAlerts, incoming, get socket() { return socket; }, get now() { return now; },
    advance(ms) { now += ms; }, setAck(fn) { acknowledge = fn; }, setLookup(fn) { lookup = fn; }, forbid() { canOperate = false; },
    emit(messages, options = {}) { socket.ev.emit('messages.upsert', { type: 'notify', messages: Array.isArray(messages) ? messages : [messages], ...options }); },
    context(id, text = '13 PRO 256??', sender = FIRST) { return { messageId: id, chatId: GROUP, isGroup: true, type: 'text', text, senderId: `${sender}@s.whatsapp.net`, senderIds: [`${sender}@s.whatsapp.net`],
      senderNumber: sender, identityVerified: true, verified: true, fromMe: false, mode: 'whatsapp', simulation: false, timestamp: now, originalTimestamp: now }; } };
}

test('fluxo completo agrupa variações em dois grupos e envia uma única resposta no privado correto', async t => {
  const f = await fixture(t);
  const original = f.incoming('request-1');
  f.emit([original, original, f.incoming('request-2', 'Alguém tem 13 pro 256?', { key: { remoteJid: OTHER } }), f.incoming('request-3', '13 PRO 256??')]);
  await f.service.waitForIdle();
  const opportunities = f.store.listOpportunities().items;
  assert.equal(opportunities.length, 1); assert.equal(opportunities[0].originCount, 3);
  assert.equal(f.store.listOpportunityOrigins(opportunities[0].id).length, 3);
  assert.equal(f.submissions.length, 1); assert.equal(f.submissions[0].target, `${FIRST}@s.whatsapp.net`);
  assert.equal(f.submissions[0].content.text.includes('pequena marca na lateral'), true);
  assert.equal(f.submissions[0].content.text.includes('R$'), true);
  assert.equal(f.store.listOpportunityTasks().length, 1); assert.equal(f.store.listOpportunityTasks()[0].status, 'accepted');
  assert.equal(f.service.getDetail(opportunities[0].id, 'owner').opportunity.groupCount, 2);
  f.service._flushNotifications(); assert.equal(f.localAlerts.length, 1); assert.equal(f.localAlerts[0].count, 1);
});

test('pessoas de mesmo nome continuam separadas e opções não geram várias mensagens por pessoa', async t => {
  const f = await fixture(t);
  f.store.saveCampaign({ ...f.store.getCampaign(f.campaign.id), items: [...f.campaign.items, { ...f.campaign.items[0], id: 'another-unit', sourceMessageId: 'original-unit-2' }] });
  f.emit([f.incoming('person-one'), f.incoming('person-two', '13 Pro 256 quem tem?', { key: { participant: `${SECOND}@s.whatsapp.net` } })]);
  await f.service.waitForIdle(); assert.equal(f.store.listOpportunities().total, 2); assert.equal(f.submissions.length, 2);
  assert.deepEqual(new Set(f.submissions.map(row => row.target)), new Set([`${FIRST}@s.whatsapp.net`, `${SECOND}@s.whatsapp.net`]));
  assert.equal(f.store.listOpportunityTasks().every(task => task.offerIds.length === 1), true);
  f.service._flushNotifications(); assert.equal(f.localAlerts.length, 1); assert.equal(f.localAlerts[0].count, 2);
});

test('encerramento citado pelo próprio autor durante resolução privada cancela antes da submissão', async t => {
  const f = await fixture(t); let finish;
  f.setLookup(() => new Promise(resolve => { finish = resolve; }));
  f.emit(f.incoming('quoted-request')); const completion = f.service.waitForIdle(); await waitUntil(() => typeof finish === 'function');
  assert.equal(typeof finish, 'function');
  f.emit(f.incoming('other-person-close', '', { key: { participant: `${SECOND}@s.whatsapp.net` }, message: { extendedTextMessage: { text: 'Já consegui.', contextInfo: { stanzaId: 'quoted-request' } } } }));
  assert.equal(f.store.listOpportunities().items[0].status, 'queued');
  f.emit(f.incoming('author-close', '', { message: { extendedTextMessage: { text: 'Já consegui.', contextInfo: { stanzaId: 'quoted-request' } } } }));
  finish([{ exists: true, jid: `${FIRST}@s.whatsapp.net` }]); await completion;
  assert.equal(f.submissions.length, 0); assert.equal(f.store.listOpportunityTasks()[0].status, 'cancelled');
  assert.equal(f.store.listOpportunities().items[0].status, 'closed');
});

test('reconexão reavalia a validade original e não despeja resposta antiga acumulada', async t => {
  const f = await fixture(t); f.adapter._status('disconnected', 'Queda controlada', { reasonCode: 'internet' });
  f.emit(f.incoming('while-offline')); assert.equal(f.store.listOpportunityTasks()[0].status, 'queued');
  f.advance(120 * 60000 + 5000); f.adapter._status('connected', 'Reconexão controlada'); await f.service.waitForIdle();
  assert.equal(f.submissions.length, 0); assert.equal(f.store.listOpportunityTasks()[0].status, 'cancelled');
  assert.equal(f.store.listOpportunities().items[0].status, 'expired');
});

test('incerto não autoriza oferta substituta; libera outros interessados e ACK tardio apenas confirma a tarefa', async t => {
  const f = await fixture(t); f.setAck(target => target !== `${FIRST}@s.whatsapp.net`);
  f.emit([f.incoming('uncertain-one'), f.incoming('second-eligible', '13 Pro 256?', { key: { participant: `${SECOND}@s.whatsapp.net` } })]);
  await f.service.waitForIdle();
  const first = f.store.listOpportunityTasks().find(task => task.recipient === FIRST);
  assert.equal(first.status, 'uncertain'); assert.equal(f.submissions.length, 2);
  assert.equal(f.store.listOpportunityTasks().find(task => task.recipient === SECOND).status, 'accepted');
  f.emit(f.incoming('uncertain-repeat', 'Alguém tem 13 Pro 256?', { key: { remoteJid: OTHER } })); await f.service.waitForIdle();
  assert.equal(f.submissions.length, 2); assert.equal(f.store.listOpportunities().total, 2);
  f.socket.ws.emit('CB:ack,class:message', { attrs: { id: first.clientMessageId } });
  assert.equal(f.store.getOpportunityTask(first.id).status, 'accepted');
  f.socket.ev.emit('message-receipt.update', [{ key: { id: first.clientMessageId, fromMe: true }, receipt: { receiptTimestamp: Math.floor(Date.now() / 1000) } }]);
  assert.equal(f.store.getOpportunityTask(first.id).status, 'delivered'); assert.equal(f.submissions.length, 2);
});

test('permissão revogada enquanto número é resolvido bloqueia relay; cadastro e busca permanecem', async t => {
  const f = await fixture(t); let finish;
  f.setLookup(() => new Promise(resolve => { finish = resolve; })); f.emit(f.incoming('permission-race'));
  const completion = f.service.waitForIdle(); await waitUntil(() => typeof finish === 'function'); f.forbid(); finish([{ exists: true, jid: `${FIRST}@s.whatsapp.net` }]);
  await completion; assert.equal(f.submissions.length, 0); assert.equal(f.store.listOpportunities().total, 1);
  assert.equal(f.store.listOpportunityTasks()[0].status, 'failed'); assert.equal(f.store.listCampaigns().length, 1);
});

test('reserva simultânea em workers e conexões SQLite independentes autoriza apenas uma tarefa', async t => {
  const f = await fixture(t, { auto: false }); f.store.setOpportunityConfig({ mode: 'automatic' });
  const request = parseRequest('13 PRO 256??'), event = { senderKey: `phone:${FIRST}`, recipient: FIRST, senderPhone: FIRST, senderId: `${FIRST}@s.whatsapp.net`,
    chatId: GROUP, messageId: 'worker-request', text: '13 PRO 256??', originalAt: f.now };
  const op = f.store.ingestOpportunity({ event, request }, f.now).opportunity;
  const candidate = campaignProjection(f.campaign.items[0], f.campaign, f.now);
  f.store.saveOpportunityOffer({ ...candidate, id: candidate.offerKey, eligible: true });
  const barrier = new SharedArrayBuffer(4), flag = new Int32Array(barrier), workers = [], replies = [];
  const code = `const {parentPort,workerData}=require('node:worker_threads');
    const {createStore}=require(workerData.app+'/src/core/store.cjs');
    (async()=>{const store=await createStore(workerData.dir);parentPort.postMessage({ready:true});Atomics.wait(new Int32Array(workerData.barrier),0,0);
      const result=store.reserveOpportunitySend({opportunityId:workerData.opportunityId,offerIds:[workerData.offerId],recipient:workerData.recipient,clientId:'worker-'+workerData.index,automatic:true,now:workerData.now});
      parentPort.postMessage({result});store.close();})().catch(error=>{parentPort.postMessage({error:error.message});process.exitCode=1;});`;
  for (let index = 0; index < 4; index++) {
    const worker = new Worker(code, { eval: true, workerData: { app: APP, dir: f.dir, opportunityId: op.id, offerId: candidate.offerKey, recipient: FIRST, now: f.now, index, barrier } }); workers.push(worker);
    const ready = new Promise((resolve, reject) => { worker.on('message', message => { if (message.ready) resolve(); if (message.error) reject(new Error(message.error)); }); worker.on('error', reject); });
    const result = new Promise((resolve, reject) => { worker.on('message', message => { if (message.result) resolve(message.result); if (message.error) reject(new Error(message.error)); }); worker.on('error', reject); });
    replies.push({ ready, result });
  }
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  await Promise.all(replies.map(reply => reply.ready)); Atomics.store(flag, 0, 1); Atomics.notify(flag, 0);
  const results = await Promise.all(replies.map(reply => reply.result));
  assert.equal(results.filter(result => result.ok).length, 1); assert.equal(results.filter(result => result.code === 'OP_PENDING').length, 3);
  assert.equal(f.store.listOpportunityTasks().length, 1); assert.equal(f.store.getOpportunitySentOffers(op.senderKey).length, 1);
});

test('lookup do recibo posterior encontra tarefa além de cem registros sem atribuir a outro interessado', async t => {
  const f = await fixture(t, { auto: false }); f.store.setOpportunityConfig({ mode: 'automatic' });
  const request = parseRequest('13 PRO 256??'), offer = campaignProjection(f.campaign.items[0], f.campaign, f.now);
  f.store.saveOpportunityOffer({ ...offer, id: offer.offerKey, eligible: true }); let last;
  for (let index = 0; index < 105; index++) {
    const phone = `55628888${String(index).padStart(5, '0')}`, op = f.store.ingestOpportunity({ event: { senderKey: `phone:${phone}`, recipient: phone,
      chatId: GROUP, messageId: `receipt-request-${index}`, text: '13 PRO 256??', originalAt: f.now }, request }, f.now).opportunity;
    last = f.store.reserveOpportunitySend({ opportunityId: op.id, offerIds: [offer.offerKey], recipient: phone, clientId: `RECEIPT-${index}`, automatic: true, now: f.now }).task;
    f.store.claimOpportunityTask(last.id, { now: f.now }); f.store.updateOpportunityTask(last.id, { status: 'uncertain', resultAt: f.now });
  }
  f.adapter.emit('receipt', { status: 'confirmed', accepted: true, mode: 'whatsapp', simulation: false, messageId: last.clientMessageId, confirmationScope: 'whatsapp-server' });
  assert.equal(f.store.getOpportunityTask(last.id).status, 'accepted');
  assert.equal(f.store.listOpportunityTasks({ status: 'accepted', limit: 200 }).length, 1);
  assert.equal(f.store.listOpportunityTasks({ status: 'uncertain', limit: 200 }).length, 104);
});
