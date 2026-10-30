'use strict';
// Production adapter/service and SQLite with a controlled Baileys socket.
// These checks do not prove delivery to a real WhatsApp account or handset.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { createStore, seed } = require('../src/core/store.cjs');
const { AuthService } = require('../src/core/auth.cjs');
const { WhatsAppAdapter } = require('../src/adapters/whatsapp.cjs');
const { SearchService } = require('../src/core/search-service.cjs');
const GROUP = '120363000000000101@g.us';
const SECOND = '120363000000000102@g.us';
const STORE_PHONE = '5562999990001';
const OWNER_PHONE = '5562999990002';
const OFFER = '📱 iPhone 15 Pro Max 256GB Silver seminovo\n🔋 Bateria: 85%\nR$ 3.850,00 à vista\nDetalhe na tela pequeno\nAssinatura da loja ✅';
const settle = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-recovery-transport-'));
  const store = await createStore(dir); seed(store); store.setSetting('integrationMode', 'whatsapp');
  store.upsertGroups([{ id: GROUP, name: 'Grupo real — fixture controlada', authorized: true, simulation: false },
    { id: SECOND, name: 'Segundo grupo — fixture controlada', authorized: true, simulation: false }]);
  const auth = new AuthService({ store });
  const owner = (await auth.setupOwner({ name: 'Dono de teste', username: 'dono-recuperacao', phone: OWNER_PHONE, password: 'Senha-segura-recuperacao-2026' })).user;
  let socket;
  const sockets = [], sent = [];
  let groupQuery = async () => ({ [GROUP]: { id: GROUP, subject: 'Grupo real — fixture controlada' }, [SECOND]: { id: SECOND, subject: 'Segundo grupo — fixture controlada' } });
  const library = {
    BufferJSON: { replacer: (_k, v) => v, reviver: (_k, v) => v }, initAuthCreds: () => ({}),
    proto: { Message: { AppStateSyncKeyData: { fromObject: v => v }, ProtocolMessage: { Type: { REVOKE: 0, MESSAGE_EDIT: 14 } } } },
    WAMessageStubType: { CIPHERTEXT: 2, REVOKE: 1 }, DisconnectReason: { loggedOut: 401, restartRequired: 515 },
    default() {
      const created = { ev: new EventEmitter(), ws: new EventEmitter(), user: { id: `${STORE_PHONE}@s.whatsapp.net` }, end() {},
        groupFetchAllParticipating: () => groupQuery(),
        onWhatsApp: async phone => [{ jid: `${phone}@s.whatsapp.net`, exists: true }],
        fetchBlocklist: options.probe || (async () => []),
        sendMessage: async (target, content, sendOptions) => {
          sent.push({ target, content, messageId: sendOptions.messageId });
          if (options.ack !== false) setImmediate(() => created.ws.emit('CB:ack,class:message', { attrs: { id: sendOptions.messageId } }));
          return { key: { id: sendOptions.messageId }, status: 1 };
        } };
      created.ws.isOpen = true;
      socket = created; sockets.push(created); return created;
    }
  };
  const adapter = new WhatsAppAdapter({ store, credentialsDir: path.join(dir, 'session'), runtimePlatform: 'win32', ackTimeoutMs: 15, controlTimeoutMs: 100,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: v => Buffer.from(v), decryptString: v => Buffer.from(v).toString() }, loadLibrary: async () => library });
  await adapter.connect(); socket.ev.emit('connection.update', { connection: 'open' }); await settle();
  const searches = new SearchService({ store, adapter, authService: auth, sleep: async () => {} }); searches.start();
  searches.saveSettings({ enabled: true, monitoredGroupIds: [GROUP], commandGroupIds: [], privateCommandsEnabled: true, commandPrivateNumbers: [OWNER_PHONE] }, owner.id);
  t.after(async () => { await searches.shutdown(); await adapter.disconnect(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  function message(id, text = OFFER, extra = {}) {
    return { message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000), pushName: 'Nome exibido pelo socket', ...extra,
      key: { id, remoteJid: GROUP, participant: '5562988880003@s.whatsapp.net', fromMe: false, ...extra.key } };
  }
  async function emit(messages, event = {}, target = socket) {
    target.ev.emit('messages.upsert', { type: 'notify', messages: Array.isArray(messages) ? messages : [messages], ...event });
    await Promise.all([...adapter.identityHydrations.values()]); await settle(); await searches.waitForIdle();
  }
  return { dir, store, auth, owner, adapter, searches, sent, sockets, message, emit, get socket() { return socket; }, setGroupQuery: fn => { groupQuery = fn; } };
}

test('APPEND próprio manual atual captura foto/legenda e texto sem descartar ou duplicar publicações', async t => {
  const f = await fixture(t); const publications = [];
  f.adapter.configureSourceCapture({ enabled: true, groupIds: [GROUP], activatedAt: Date.now() - 2000 });
  f.adapter.on('publication', ctx => publications.push(ctx));
  const photo = f.message('own-photo-live', '', { key: { fromMe: true, participant: undefined }, message: { imageMessage: { caption: OFFER, mimetype: 'image/jpeg' } } });
  const text = f.message('own-text-live', OFFER, { key: { fromMe: true } });
  await f.emit([photo, text], { type: 'append' }); await f.emit([photo, text], { type: 'notify' });
  assert.equal(publications.length, 2); assert.equal(publications[0].text, OFFER); assert.equal(publications[0].type, 'image');
  assert.equal(publications[0].senderNumber, STORE_PHONE); assert.equal(publications[0].trustedSelf, true);
  assert.equal(f.store.getSearchMonitorStats().messages, 2);
  f.store.registerOutboundMessageId('automatic-do-not-import', { kind: 'campaign', at: Date.now(), storageMode: 'whatsapp' });
  await f.emit(f.message('automatic-do-not-import', OFFER, { key: { fromMe: true } }), { type: 'append' });
  assert.equal(publications.length, 2); assert.equal(f.store.getSearchMonitorStats().messages, 2);
});

test('APPEND antigo/histórico e requestId não observado continuam opt-in e nunca viram comando', async t => {
  const f = await fixture(t), publications = [], commands = [];
  f.adapter.configureSourceCapture({ enabled: true, groupIds: [GROUP], activatedAt: Date.now() - 2000 });
  f.adapter.on('publication', ctx => publications.push(ctx)); f.adapter.on('incoming', ctx => commands.push(ctx));
  await f.emit(f.message('old-append', OFFER, { messageTimestamp: Math.floor(Date.now() / 1000) - 600 }), { type: 'append' });
  await f.emit(f.message('explicit-history', OFFER), { type: 'append', history: true });
  await f.emit(f.message('unsolicited-phone-sync', OFFER), { type: 'append', requestId: 'history-request' });
  assert.equal(publications.length, 0); assert.equal(commands.length, 0); assert.equal(f.store.getSearchMonitorStats().messages, 0);
});

test('privado APPEND recente autorizado responde ao particular real, não ao responsável nem ao número da loja', async t => {
  const f = await fixture(t); await f.emit(f.message('captured-offer'));
  f.store.saveAlertRecipient({ id: 'other-responsible', name: 'Outro responsável controlado', phone: '5562977770004', enabled: true });
  f.searches.saveSettings({ recipientMode: 'responsibles', responsibleRecipientIds: ['other-responsible'] }, f.owner.id);
  const command = f.message('private-append-command', '!busca iPhone 15 Pro Max 256GB Silver', { key: { remoteJid: `${OWNER_PHONE}@s.whatsapp.net`, participant: undefined } });
  await f.emit(command, { type: 'append' }); await f.emit(command, { type: 'notify' });
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].target, `${OWNER_PHONE}@s.whatsapp.net`); assert.match(f.sent[0].content.text, /3\.850,00/);
  assert.equal(f.store.listSearchDeliveries().items[0].status, 'confirmed');
  assert.notEqual(f.sent[0].target, `${STORE_PHONE}@s.whatsapp.net`);
  const trace = f.store.listEntities('diagnostics');
  for (const stage of ['received', 'authorization', 'parsed', 'results', 'queued', 'submitted', 'integration']) assert.ok(trace.some(row => row.stage === `buscas.${stage}`), stage);
});

test('LID hidratado por repositório autenticado em APPEND resolve remetente e mantém chat privado sem inventar telefone', async t => {
  const f = await fixture(t); await f.emit(f.message('offer-before-lid'));
  const lid = '999777333111@lid';
  f.socket.signalRepository = { lidMapping: { getPNForLID: async queried => queried === lid ? `${OWNER_PHONE}@s.whatsapp.net` : undefined } };
  await f.emit(f.message('lid-private-append', '!busca', { key: { remoteJid: lid, participant: undefined } }), { type: 'append' });
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].target, lid); assert.match(f.sent[0].content.text, /Use !busca/);
  const row = f.store.listSearchDeliveries().items[0]; assert.equal(row.sourceSenderNumber, OWNER_PHONE); assert.equal(row.resolvedTarget, lid);
  await f.emit(f.message('lid-without-mapping', '!busca', { key: { remoteJid: '1111111111@lid', participant: undefined } }), { type: 'append' });
  assert.equal(f.sent.length, 1);
});

test('bloqueio de número não autorizado, sem resultados e prefixo vazio retornam somente ao solicitante autorizado', async t => {
  const f = await fixture(t);
  const command = (id, text, phone = OWNER_PHONE) => f.message(id, text, { key: { remoteJid: `${phone}@s.whatsapp.net`, participant: undefined } });
  await f.emit(command('unapproved', '!busca iPhone 15 Pro Max 256GB', '5562966660005'));
  assert.equal(f.sent.length, 0);
  await f.emit(command('empty-dataset', '!busca iPhone 15 Pro Max 256GB')); await f.emit(command('bare-prefix', '!busca'));
  assert.equal(f.sent.length, 2); assert.match(f.sent[0].content.text, /Não foram encontradas ofertas/); assert.match(f.sent[1].content.text, /Use !busca/);
  assert.ok(f.sent.every(row => row.target === `${OWNER_PHONE}@s.whatsapp.net`));
});

test('captura/reconexão preserva IDs, listener único, hora original e edições/exclusões sem ressuscitar ofertas', async t => {
  const f = await fixture(t), original = f.message('stable-publication');
  await f.emit(original); const storedTime = f.store.getSearchMessage(GROUP, original.key.id).originalAt;
  const oldSocket = f.socket; await f.adapter.disconnect({ reasonCode: 'unexpected', manual: false });
  await f.adapter.connect(); f.socket.ev.emit('connection.update', { connection: 'open' }); await settle();
  assert.equal(f.socket.ev.listenerCount('messages.upsert'), 1);
  await f.emit(f.message('stale-socket'), {}, oldSocket); await f.emit(original); await f.emit(f.message('after-reconnect'), { type: 'append' });
  assert.equal(f.store.getSearchMonitorStats().messages, 2); assert.equal(f.store.getSearchMessage(GROUP, 'stale-socket'), undefined);
  f.socket.ev.emit('messages.update', [{ key: original.key, update: { message: { conversation: OFFER.replace('3.850,00', '3.750,00') }, messageTimestamp: original.messageTimestamp + 2 } }]);
  await f.searches.waitForIdle(); assert.equal(f.store.getSearchMessage(GROUP, original.key.id).originalAt, storedTime);
  f.socket.ev.emit('messages.delete', { keys: [original.key] }); await f.searches.waitForIdle();
  await f.emit(original); assert.ok(f.store.getSearchMessage(GROUP, original.key.id).deletedAt);
});

test('sessão aberta sem identidade ou com transporte fechado não é apresentada como pronta', async t => {
  const f = await fixture(t); const user = f.socket.user;
  f.socket.user = null; await f.adapter._connectionUpdate({ connection: 'open' }, f.socket, f.adapter.generation);
  assert.equal(f.adapter.status.state, 'connecting'); assert.equal(f.adapter.getConnectionReadiness().ready, false);
  f.socket.user = user; f.socket.ws.isOpen = false;
  await f.adapter._connectionUpdate({ connection: 'open' }, f.socket, f.adapter.generation);
  assert.equal(f.adapter.status.state, 'connecting'); assert.equal(f.adapter.status.ready, false);
  f.socket.ws.isOpen = true; await f.adapter._connectionUpdate({ connection: 'open' }, f.socket, f.adapter.generation);
  assert.equal(f.adapter.status.ready, true); assert.equal(f.adapter.getConnectionReadiness().ready, true);
  const probe = await f.adapter.testConnection(); assert.equal(probe.verified, true); assert.equal(probe.serverProbeSupported, true); assert.equal(f.sent.length, 0);
  delete f.socket.fetchBlocklist; const unsupported = await f.adapter.testConnection(); assert.equal(unsupported.ready, true); assert.equal(unsupported.verified, false);
  assert.match(unsupported.detail, /não comprova envio ou recebimento/);
});

test('consulta de grupos iniciada na sessão antiga não contamina a sessão reconectada', async t => {
  const f = await fixture(t); let release;
  f.setGroupQuery(() => new Promise(resolve => { release = resolve; }));
  const pending = f.adapter.listGroups(); const rejected = assert.rejects(pending, error => error.code === 'WA_RECIPIENT_CONNECTION_CHANGED'); await settle();
  await f.adapter.disconnect({ reasonCode: 'unexpected', manual: false }); await f.adapter.connect(); f.socket.ev.emit('connection.update', { connection: 'open' }); await settle();
  release({ stale: { id: '120363555555555555@g.us', subject: 'Não deve contaminar' } }); await rejected;
  assert.equal(f.adapter.knownSearchGroups.has('120363555555555555@g.us'), false);
});

test('testar captura aguarda publicação, sincronizar não inventa histórico e falha real da consulta aparece no monitor', async t => {
  const f = await fixture(t); const probe = await f.searches.testCapture(f.owner.id);
  assert.equal(probe.verified, false); assert.equal(probe.status, 'waiting'); assert.equal(f.store.getSearchMonitorStats().messages, 0);
  await f.emit(f.message('probe-first-live')); const state = f.searches.getState(f.owner.id);
  assert.equal(state.monitor.captureProbe.status, 'captured'); assert.equal(state.stats.messages, 1); assert.equal(state.stats.offers, 1);
  assert.equal(state.monitor.adapterHealth.received, 1);
  const sync = await f.searches.synchronizeNow(f.owner.id); assert.equal(sync.historyImported, false); assert.equal(sync.complete, false);
  f.setGroupQuery(async () => { throw Object.assign(new Error('controlled-network-unreachable'), { code: 'ETIMEDOUT' }); });
  await assert.rejects(f.searches.synchronizeNow(f.owner.id));
  assert.equal(f.searches.getState(f.owner.id).monitor.lastError.code, 'ETIMEDOUT'); assert.equal(f.store.listGroups().length, 2);
  assert.ok(f.store.listGroups().every(group => group.simulation === false));
});

test('reconexão interna não emite desconexão manual; escolha explícita do usuário continua manual', async t => {
  const f = await fixture(t), statuses = []; f.adapter.on('status', status => statuses.push(status));
  await f.adapter.connect({ reconnect: true });
  assert.equal(statuses.some(status => status.manual === true || status.reasonCode === 'manual'), false);
  assert.ok(statuses.some(status => status.reasonCode === 'reconnecting' && status.manual === false));
  f.socket.ev.emit('connection.update', { connection: 'open' }); await settle();
  await f.adapter.disconnect(); assert.equal(statuses.at(-1).reasonCode, 'manual'); assert.equal(statuses.at(-1).manual, true);
});

test('evento tardio do transporte já fechado não consome identificador de publicação nova', async t => {
  const f = await fixture(t), late = f.message('late-after-close');
  const old = f.socket; old.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: Object.assign(new Error('controlled-close'), { statusCode: 503 }) } });
  await settle(); assert.equal(f.adapter.status.state, 'disconnected'); await f.emit(late, {}, old);
  assert.equal(f.store.getSearchMonitorStats().messages, 0);
  await f.adapter.connect(); f.socket.ev.emit('connection.update', { connection: 'open' }); await settle(); await f.emit(late);
  assert.equal(f.store.getSearchMonitorStats().messages, 1);
});

test('resultado incerto de resposta privada não bloqueia a próxima busca nem é repetido após reconectar', async t => {
  const f = await fixture(t, { ack: false }); await f.emit(f.message('offer-before-uncertain'));
  const command = id => f.message(id, '!busca iPhone 15 Pro Max 256GB', { key: { remoteJid: `${OWNER_PHONE}@s.whatsapp.net`, participant: undefined } });
  const first = command('uncertain-one'); await f.emit(first); await f.emit(command('uncertain-two'));
  assert.equal(f.sent.length, 2); assert.ok(f.store.listSearchDeliveries().items.every(delivery => delivery.status === 'uncertain'));
  await f.adapter.disconnect({ reasonCode: 'unexpected', manual: false }); await f.adapter.connect(); f.socket.ev.emit('connection.update', { connection: 'open' }); await settle();
  await f.emit(first); await f.searches.waitForIdle(); assert.equal(f.sent.length, 2);
  const firstId = f.sent[0].messageId;
  f.socket.ws.emit('CB:ack,class:message', { attrs: { id: firstId } }); await settle();
  assert.equal(f.store.listSearchDeliveries({ messageId: firstId }).items[0].status, 'confirmed');
  assert.equal(f.sent.length, 2);
});

test('QR gerado tardiamente não substitui estado conectado nem reconecta uma sessão já encerrada', async t => {
  const f = await fixture(t), qrcode = require('qrcode'), original = qrcode.toDataURL;
  let release; qrcode.toDataURL = () => new Promise(resolve => { release = resolve; });
  try {
    f.adapter._status('connecting', 'Fixture de emparelhamento');
    const qrUpdate = f.adapter._connectionUpdate({ qr: 'controlled-qr-not-a-real-session' }, f.socket, f.adapter.generation);
    await settle(); await f.adapter._connectionUpdate({ connection: 'open' }, f.socket, f.adapter.generation);
    release('data:image/png;base64,controlled'); await qrUpdate;
    assert.equal(f.adapter.status.state, 'connected'); assert.equal(f.adapter.status.qr, undefined);
    const late = f.adapter._connectionUpdate({ qr: 'controlled-second-qr' }, f.socket, f.adapter.generation);
    await settle(); await f.adapter.disconnect({ reasonCode: 'unexpected', manual: false });
    release('data:image/png;base64,controlled'); await late;
    assert.equal(f.adapter.status.state, 'disconnected'); assert.equal(f.adapter.status.qr, undefined);
  } finally { qrcode.toDataURL = original; }
});

test('falhas permanentes da captura são mostradas separadamente da fila elegível', async t => {
  const f = await fixture(t);
  const invalid = { messageId: 'no-original-date', chatId: GROUP, isGroup: true, fromMe: false, text: OFFER, type: 'text',
    verified: true, identityVerified: true, senderNumber: '5562988880003', senderId: '5562988880003@s.whatsapp.net', simulation: false, timestamp: null, dataOnly: true };
  await f.searches.handleIncoming(invalid); await f.searches.waitForIdle();
  const state = f.searches.getState(f.owner.id);
  assert.equal(state.monitor.queueSize, 0); assert.equal(state.monitor.failedCaptures, 1); assert.equal(state.stats.messages, 0);
  assert.equal(state.monitor.lastError.code, 'SEARCH_TIMESTAMP_UNKNOWN');
  const answer = await f.searches.executeSearch({ query: 'iPhone 15 Pro Max 256GB' }, f.owner.id);
  assert.equal(answer.count, 0); assert.equal(answer.stale, true); assert.ok(answer.warnings.some(warning => warning.includes('SEARCH_TIMESTAMP_UNKNOWN')));
});


test('R10 opening a socket does not announce an operational session until authenticated probe succeeds', async t => {
 let release;const probe=new Promise(r=>release=r);const f=await fixture(t,{probe:()=>probe});assert.equal(f.adapter.status.state,'connecting');assert.equal(f.adapter.status.operationalState,'synchronizing');assert.equal(f.adapter.getConnectionReadiness().ready,false);release([]);await settle();assert.equal(f.adapter.status.state,'connected');assert.equal(f.adapter.status.serverAuthenticated,true);
});
test('R10 failed authenticated probe stays disconnected and preserves protected credentials', async t => {
 const f=await fixture(t,{probe:async()=>{throw Error('Servidor indisponível');}});await settle();assert.equal(f.adapter.status.state,'disconnected');assert.equal(f.adapter.status.errorCode,'WA_RECOVERY_DEADLINE');assert.equal(f.adapter.status.retryable,true);
});
test('R10 private opportunity identity resolves actual participant PN and authenticated LID without group substitution',async t=>{
 const f=await fixture(t);let result=await f.adapter.resolveParticipantNumber({senderId:`${OWNER_PHONE}@s.whatsapp.net`,senderPhone:OWNER_PHONE});assert.equal(result.phone,OWNER_PHONE);const lid='9912345678@lid';f.socket.signalRepository={lidMapping:{getPNForLID:async()=>`${OWNER_PHONE}@s.whatsapp.net`}};result=await f.adapter.resolveParticipantNumber({senderId:lid});assert.equal(result.phone,OWNER_PHONE);await assert.rejects(f.adapter.resolveParticipantNumber({senderId:GROUP}),/identidade|participante|telefone/i);await assert.rejects(f.adapter.resolveParticipantNumber({senderId:`${OWNER_PHONE}@s.whatsapp.net`,senderPhone:'5562999990999'}),{code:'OP_PRIVATE_IDENTITY_CONFLICT'});
});
test('R10 unresolved LID is never converted to a fake telephone or sent to group',async t=>{const f=await fixture(t);await assert.rejects(f.adapter.resolveParticipantNumber({senderId:'998877665544@lid'}),/telefone|identificar|identidade/i);assert.equal(f.sent.length,0);});

test('R10 a stale operational socket is probed once and a failing probe triggers controlled recovery',async t=>{const f=await fixture(t);let probes=0;f.adapter.lastHealthProbeAt=Date.now()-130000;f.socket.fetchBlocklist=async()=>{probes++;throw Error('Sem resposta');};const a=f.adapter.checkOperationalHealth(),b=f.adapter.checkOperationalHealth();assert.equal(a,b);await a;assert.equal(probes,1);assert.equal(f.adapter.status.state,'disconnected');assert.equal(f.adapter.status.reasonCode,'stalled');});
test('R10 frequent UI refreshes do not create excess server health queries',async t=>{const f=await fixture(t);let probes=0;f.socket.fetchBlocklist=async()=>{probes++;return[];};for(let i=0;i<100;i++)await f.adapter.checkOperationalHealth();assert.equal(probes,0);});
test('R10 persisted Brazilian phone variant requires refreshed authenticated alias proof after reconnect',async t=>{const f=await fixture(t),canonical=OWNER_PHONE.slice(0,4)+OWNER_PHONE.slice(5),original=f.adapter.resolveRecipient;let called=0;f.adapter.resolveRecipient=async number=>{called++;assert.equal(number,OWNER_PHONE);const phones=[canonical,OWNER_PHONE],binding={phones,generation:f.adapter.generation,socket:f.socket,accountId:f.adapter._ownAccount().id,expiresAt:Date.now()+60000};for(const p of phones)f.adapter.verifiedRecipientAliases.set(p,binding);return{jid:canonical+'@s.whatsapp.net',phone:canonical,identityAliasesConfirmed:true};};t.after(()=>f.adapter.resolveRecipient=original);const resolved=await f.adapter.resolveParticipantNumber({senderId:canonical+'@s.whatsapp.net',senderPhone:OWNER_PHONE});assert.equal(called,1);assert.equal(resolved.phone,canonical);assert.deepEqual(new Set(f.adapter.verifiedPhoneAliases(canonical)),new Set([canonical,OWNER_PHONE]));});
