'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { WhatsAppAdapter } = require('../src/adapters/whatsapp.cjs');
const { SimulatedAdapter } = require('../src/adapters/simulated.cjs');
const { createStore } = require('../src/core/store.cjs');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mega-search-adapter-'));
  let socket;
  let options;
  const sends = [];
  const library = {
    BufferJSON: { replacer: (_, value) => value, reviver: (_, value) => value },
    initAuthCreds: () => ({}),
    proto: { Message: { AppStateSyncKeyData: { fromObject: value => value }, ProtocolMessage: { Type: { REVOKE: 0, MESSAGE_EDIT: 14 } } } },
    WAMessageStubType: { REVOKE: 1 },
    default(config) {
      options = config;
      socket = {
        ev: new EventEmitter(), ws: new EventEmitter(), user: { id: '5511999999999@s.whatsapp.net' },
        end() {}, logout: async () => {},
        onWhatsApp: async number => [{ jid: `${number}@s.whatsapp.net`, exists: true }],
        groupFetchAllParticipating: async () => ({ a: { id: '12001@g.us', subject: 'Lojistas', linkedParent: '12000@g.us', isCommunity: false, isCommunityAnnounce: false }, b: { id: '12002@g.us', subject: 'Avisos', isCommunityAnnounce: true } }),
        sendMessage: async (target, content, opts) => { sends.push({ target, content, opts }); return { key: { id: opts.messageId }, status: 1 }; }
      };
      return socket;
    }
  };
  const adapter = new WhatsAppAdapter({ credentialsDir: dir, store: { getGroup: id => id === '12001@g.us' ? { id, simulation: false } : null }, safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => Buffer.from(value).toString() }, loadLibrary: async () => library, runtimePlatform: 'win32', ackTimeoutMs: 15 });
  await adapter.connect();
  socket.ev.emit('connection.update', { connection: 'open' });
  t.after(async () => { await adapter.disconnect(); await fs.rm(dir, { recursive: true, force: true }); });
  return { adapter, socket, sends, options };
}

function message(id, text, overrides = {}) {
  return { message: { conversation: text }, pushName: 'Loja exibida', messageTimestamp: Math.floor(Date.now() / 1000), ...overrides, key: { id, remoteJid: '12001@g.us', participant: '5511888888888@s.whatsapp.net', fromMe: false, ...overrides.key } };
}

test('captura está desativada inicialmente; seleção de monitoramento é independente dos comandos', async t => {
  const { adapter, socket } = await fixture(t);
  const events = [];
  adapter.on('offerMessage', context => events.push(context));
  socket.ev.emit('messages.upsert', { type: 'notify', messages: [message('disabled', 'iPhone 15 128GB R$ 3000')] });
  assert.equal(events.length, 0);
  adapter.configureSearchCapture({ enabled: true, groupIds: ['12001@g.us'], commandGroupIds: ['12003@g.us'] });
  socket.ev.emit('messages.upsert', { type: 'notify', messages: [message('supplier', 'iPhone 15 128GB R$ 3000'), message('command-group', '!busca 18 pro Max Silver', { key: { remoteJid: '12003@g.us' } }), message('excluded', '!busca 15', { key: { remoteJid: '12004@g.us' } }), message('private', '!BUSCA', { key: { remoteJid: '5511888888888@s.whatsapp.net', participant: undefined } })] });
  assert.deepEqual(events.map(event => event.messageId), ['supplier', 'command-group', 'private']);
  assert.equal(events[2].isGroup, false);
});

test('texto original, legenda, identificação autenticada e nomes reais são preservados sem número fictício', async t => {
  const { adapter, socket } = await fixture(t);
  adapter.configureSearchCapture({ enabled: true });
  const events = [];
  adapter.on('offerMessage', context => events.push(context));
  const original = 'iPhone 18 Pro Max\n256GB Silver — R$ 7.000,00\nGarantia 90 dias ✅';
  socket.ev.emit('contacts.upsert', [{ id: '5511888888888@s.whatsapp.net', name: 'Minha loja salva', notify: 'Loja exibida' }]);
  socket.ev.emit('messages.upsert', { type: 'notify', messages: [message('phone', original), message('lid', original, { key: { participant: '123456@lid' }, pushName: '5511999999999' }), message('caption', '', { message: { imageMessage: { caption: original, contextInfo: { isForwarded: true, forwardingScore: 1 } } } })] });
  assert.equal(events[0].text, original);
  assert.equal(events[0].savedName, 'Minha loja salva');
  assert.equal(events[0].displayName, 'Loja exibida');
  assert.equal(events[0].senderNumber, '5511888888888');
  assert.equal(events[0].timestamp, message('now', '').messageTimestamp * 1000);
  assert.equal(events[1].senderId, '123456@lid');
  assert.equal(events[1].identityVerified, true);
  assert.equal(events[1].senderNumber, '');
  assert.equal(events[1].verified, false);
  assert.equal(events[2].text, original);
  assert.equal(events[2].type, 'image');
  assert.equal(events[2].forwarded, true);
});

test('PN alternativo e mapeamento autenticado resolvem LID; divergência não inventa telefone', async t => {
  const { adapter, socket } = await fixture(t);
  adapter.configureSearchCapture({ enabled: true });
  const events = [];
  adapter.on('offerMessage', context => events.push(context));
  socket.ev.emit('messages.upsert', { type: 'notify', messages: [message('lid-alt', 'Oferta', { key: { participant: '123456@lid', participantAlt: '5511888888888@s.whatsapp.net' } })] });
  socket.ev.emit('lid-mapping.update', { lid: '333333@lid', pn: '5511777777777@s.whatsapp.net' });
  socket.ev.emit('messages.upsert', { type: 'notify', messages: [message('lid-mapped', 'Oferta', { key: { participant: '333333@lid' } }), message('conflict', 'Oferta', { key: { participant: '5511888888888@s.whatsapp.net', participantAlt: '5511666666666@s.whatsapp.net' } })] });
  assert.equal(events[0].senderNumber, '5511888888888');
  assert.equal(events[1].senderNumber, '5511777777777');
  assert.equal(events[2].senderNumber, '');
  assert.equal(events[2].verified, false);
});

test('deduplicação usa mensagem e conversa; não interfere com a autorização legado', async t => {
  const { adapter, socket } = await fixture(t);
  adapter.configureSearchCapture({ enabled: true });
  const offers = [], incoming = [];
  adapter.on('offerMessage', event => offers.push(event));
  adapter.on('incoming', event => incoming.push(event));
  const first = message('same-id', '!mega status');
  socket.ev.emit('messages.upsert', { type: 'notify', messages: [first, first, message('same-id', 'Outra origem', { key: { remoteJid: '12003@g.us' } })] });
  assert.equal(offers.length, 2);
  assert.equal(incoming.length, 1, 'regras de proteção anteriores permanecem inalteradas');
});

test('histórico opt-in é recebido em lotes limitados e nunca vira comando ou histórico completo', async t => {
  const { adapter, socket, options } = await fixture(t);
  const history = [], live = [], legacy = [], statuses = [];
  adapter.on('offerHistory', value => history.push(value));
  adapter.on('offerMessage', value => live.push(value));
  adapter.on('incoming', value => legacy.push(value));
  adapter.on('captureHistoryStatus', value => statuses.push(value));
  adapter.configureSearchCapture({ enabled: true, groupIds: ['12001@g.us'], commandGroupIds: [], importHistory: false });
  assert.equal(options.syncFullHistory, false);
  assert.equal(options.shouldSyncHistoryMessage(), false);
  socket.ev.emit('messaging-history.set', { messages: [message('no-import', '!busca 15')], isLatest: true });
  adapter.configureSearchCapture({ enabled: true, groupIds: ['12001@g.us'], commandGroupIds: [], importHistory: true });
  assert.equal(options.shouldSyncHistoryMessage(), true);
  socket.ev.emit('messaging-history.set', { messages: Array.from({ length: 205 }, (_, index) => message(`history-${index}`, '!busca 15', { messageTimestamp: Math.floor(Date.now() / 1000) - 86400 })), isLatest: true, progress: 100, syncType: 3 });
  await adapter.captureHistoryChain;
  socket.ev.emit('messaging-history.status', { status: 'complete', explicit: true, syncType: 3 });
  assert.deepEqual(history.map(batch => batch.messages.length), [100, 100, 5]);
  assert.ok(history.every(batch => batch.complete === false && batch.messages.every(value => value.history === true)));
  assert.equal(statuses.at(-1).complete, false);
  assert.equal(legacy.length, 0);
  assert.equal(live.length, 0);
});

test('atrasos de reconexão preservam hora original e não executam comandos', async t => {
  const { adapter, socket } = await fixture(t);
  adapter.configureSearchCapture({ enabled: true });
  const history = [], live = [], legacy = [];
  adapter.on('offerHistory', value => history.push(value));
  adapter.on('offerMessage', value => live.push(value));
  adapter.on('incoming', value => legacy.push(value));
  const originalSeconds = Math.floor(Date.now() / 1000) - 600;
  socket.ev.emit('messages.upsert', { type: 'notify', messages: [message('missed', '!busca 15', { messageTimestamp: originalSeconds })] });
  assert.equal(history[0].messages[0].timestamp, originalSeconds * 1000);
  assert.equal(history[0].messages[0].history, true);
  assert.equal(legacy.length + live.length, 0);
});

test('mensagem recuperada do telefone é histórico mesmo com timestamp recente', async t => {
  const { adapter, socket } = await fixture(t);
  adapter.configureSearchCapture({ enabled: true });
  const history = [], live = [];
  adapter.on('offerHistory', value => history.push(value));
  adapter.on('offerMessage', value => live.push(value));
  socket.ev.emit('messages.upsert', { type: 'notify', requestId: 'phone-history-request', messages: [message('recovered-command', '!busca 18 pro Max Silver')] });
  assert.equal(history[0].source, 'phone-recovered-notify');
  assert.equal(history[0].messages[0].history, true);
  assert.equal(live.length, 0);
});

test('eventos reais de edição e revogação alteram a referência sem reescrever a hora original', async t => {
  const { adapter, socket } = await fixture(t);
  adapter.configureSearchCapture({ enabled: true, groupIds: ['12001@g.us'], commandGroupIds: [] });
  const updates = [], deletions = [];
  adapter.on('offerMessageUpdate', value => updates.push(value));
  adapter.on('offerMessageDelete', value => deletions.push(value));
  const revision = Math.floor(Date.now() / 1000);
  socket.ev.emit('messages.update', [{ key: message('edited', '').key, update: { message: { editedMessage: { message: { conversation: 'iPhone 15 128GB Prata R$ 2900' } } }, messageTimestamp: revision } }]);
  assert.equal(updates[0].messageId, 'edited');
  assert.equal(updates[0].revisionAt, revision * 1000);
  assert.equal(updates[0].text, 'iPhone 15 128GB Prata R$ 2900');
  assert.equal(Object.hasOwn(updates[0], 'timestamp'), false);
  socket.ev.emit('messages.update', [{ key: message('not-deleted', '').key, update: { message: null } }, { key: message('revoked', '').key, update: { message: null, messageStubType: 1 } }]);
  socket.ev.emit('messages.delete', { keys: [message('deleted', '').key] });
  socket.ev.emit('messages.delete', { jid: '12001@g.us', all: true });
  assert.deepEqual(deletions.map(value => value.messageId || 'all'), ['revoked', 'deleted', 'all']);
});

test('protocolMessage edit/revoke é dado operacional, sem executar textos editados como comandos', async t => {
  const { adapter, socket } = await fixture(t);
  adapter.configureSearchCapture({ enabled: true });
  const updates = [], deletions = [], live = [];
  adapter.on('offerMessageUpdate', value => updates.push(value));
  adapter.on('offerMessageDelete', value => deletions.push(value));
  adapter.on('offerMessage', value => live.push(value));
  socket.ev.emit('messages.upsert', { type: 'notify', messages: [message('protocol-edit', '', { message: { protocolMessage: { type: 14, key: message('original', '').key, timestampMs: Date.now(), editedMessage: { conversation: '!busca 18 pro Max Silver' } } } }), message('protocol-delete', '', { message: { protocolMessage: { type: 0, key: message('removed', '').key } } })] });
  assert.equal(updates[0].messageId, 'original');
  assert.equal(deletions[0].messageId, 'removed');
  assert.equal(live.length, 0);
});

test('comunidades usam somente metadados reais dos grupos participantes', async t => {
  const { adapter } = await fixture(t);
  const groups = await adapter.listGroups();
  assert.equal(groups[0].linkedParent, '12000@g.us');
  assert.equal(groups[0].isCommunity, false);
  assert.equal(groups[1].isCommunityAnnounce, true);
  assert.equal(Object.hasOwn(groups[1], 'linkedParent'), false);
  assert.equal(adapter.getSearchCapabilities().originalMessageLinks, false);
});

test('resposta da busca usa destinatário explícito, exige ACK e não repete resultado incerto', async t => {
  const { adapter, socket, sends } = await fixture(t);
  const result = await adapter.sendSearchText('5511888888888', 'Resultados', { clientMessageId: 'SEARCH-1' });
  assert.equal(result.status, 'uncertain');
  assert.equal(sends[0].target, '5511888888888@s.whatsapp.net');
  assert.deepEqual(await adapter.sendSearchText('5511888888888', 'Resultados', { clientMessageId: 'SEARCH-1' }), result);
  assert.equal(sends.length, 1);
  socket.ws.emit('CB:ack,class:message', { attrs: { id: 'SEARCH-1' } });
  assert.equal((await adapter.sendSearchText('5511888888888', 'Resultados', { clientMessageId: 'SEARCH-1' })).status, 'confirmed');
  await assert.rejects(adapter.sendSearchText('unknown@g.us', 'Busca'), /conhecido/);
  const pending = adapter.sendSearchText('12001@g.us', 'Busca na origem', { clientMessageId: 'SEARCH-GROUP' });
  socket.ws.emit('CB:ack,class:message', { attrs: { id: 'SEARCH-GROUP' } });
  assert.equal((await pending).status, 'confirmed');
  assert.equal(sends.at(-1).target, '12001@g.us');
});

test('desconexão suspende entrega e ignora eventos de geração antiga', async t => {
  const { adapter, socket } = await fixture(t);
  adapter.configureSearchCapture({ enabled: true });
  const offers = [];
  adapter.on('offerMessage', value => offers.push(value));
  adapter.setNetworkState({ online: false });
  socket.ev.emit('messages.upsert', { type: 'notify', messages: [message('after-disconnect', 'Oferta')] });
  assert.equal(offers.length, 0);
  assert.equal(adapter.status.reasonCode, 'internet');
  await assert.rejects(adapter.sendSearchText('5511888888888', 'Busca'), error => error.safeToRetry === true);
});

test('simulação fornece captura, edição, exclusão e entrega privada com identificação explícita', async () => {
  const adapter = new SimulatedAdapter({ delayMs: 0 });
  await adapter.connect();
  adapter.configureSearchCapture({ enabled: true, groupIds: ['sim-01@simulation'], commandGroupIds: [], importHistory: true });
  const live = [], edits = [], deletions = [], history = [];
  adapter.on('offerMessage', value => live.push(value));
  adapter.on('offerMessageUpdate', value => edits.push(value));
  adapter.on('offerMessageDelete', value => deletions.push(value));
  adapter.on('offerHistory', value => history.push(value));
  adapter.injectOfferMessage({ messageId: 'sim-offer', senderId: '123456@lid', text: 'iPhone 15 128GB R$ 3000' });
  adapter.injectOfferUpdate({ messageId: 'sim-offer', text: 'iPhone 15 128GB R$ 2900' });
  adapter.injectOfferDelete({ messageId: 'sim-offer' });
  adapter.injectOfferHistory([{ messageId: 'sim-history', text: '!busca 15' }]);
  adapter.injectIncoming({ senderNumber: '5511888888888', text: '!busca 18 pro Max Silver' });
  assert.equal(live[0].senderNumber, '');
  assert.equal(live[0].simulation, true);
  assert.equal(live.at(-1).isGroup, false);
  assert.equal(edits.length, 1);
  assert.equal(Object.hasOwn(edits[0], 'timestamp'), false);
  assert.equal(deletions.length, 1);
  assert.equal(history[0].complete, false);
  const result = await adapter.sendSearchText('5511999999999', '🔎 Resultado simulado', { clientMessageId: 'SIM-SEARCH-1' });
  assert.equal(result.status, 'confirmed');
  assert.equal(adapter.sent.at(-1).privateNumber, '5511999999999');
  assert.equal(adapter.sent.at(-1).search, true);
  assert.equal(adapter.sent.at(-1).simulation, true);
});

test('comando manual da própria conta usa autor autenticado, não o destinatário ou participant', async t => {
  const { adapter, socket } = await fixture(t);
  socket.user.id = '5511999999999:4@s.whatsapp.net';
  adapter.configureSearchCapture({ enabled: true });
  const contexts = [];
  adapter.on('offerMessage', value => contexts.push(value));
  socket.ev.emit('messages.upsert', { type: 'notify', messages: [message('own-private', '!busca iPhone 18 Pro Max Silver', { key: { fromMe: true, remoteJid: '5511888888888@s.whatsapp.net', participant: undefined } }), message('own-group', '!busca 18 pro Max Silver', { key: { fromMe: true, participant: '5511666666666@s.whatsapp.net' } })] });
  assert.equal(contexts.length, 2);
  for (const context of contexts) {
    assert.equal(context.senderNumber, '5511999999999');
    assert.equal(context.senderId, '5511999999999@s.whatsapp.net');
    assert.equal(context.trustedSelf, true);
    assert.equal(context.automaticMessage, false);
    assert.equal(context.machineGenerated, false);
    assert.equal(context.accountNumber, '5511999999999');
    assert.equal(adapter.isTrustedSelfContext(context), true);
    assert.equal(context.simulation, false);
  }
});

test('self desconhecido ou LID sem mapeamento não transforma ID em telefone', async t => {
  const { adapter, socket } = await fixture(t);
  socket.user = { id: '1234567890123@lid' };
  adapter.configureSearchCapture({ enabled: true });
  const contexts = [];
  adapter.on('offerMessage', value => contexts.push(value));
  socket.ev.emit('messages.upsert', { type: 'notify', messages: [message('self-unresolved', '!busca 18', { pushName: '5511999999999', key: { fromMe: true, remoteJid: '5511888888888@s.whatsapp.net' } })] });
  assert.equal(contexts[0].senderNumber, '');
  assert.equal(contexts[0].trustedSelf, false);
  assert.equal(contexts[0].verified, false);
  socket.ev.emit('lid-mapping.update', { lid: '1234567890123@lid', pn: '5511999999999@s.whatsapp.net' });
  socket.ev.emit('messages.upsert', { type: 'notify', messages: [message('self-resolved', '!busca 18', { key: { fromMe: true, remoteJid: '5511888888888@s.whatsapp.net' } })] });
  assert.equal(contexts[1].senderNumber, '5511999999999');
  assert.equal(contexts[1].trustedSelf, true);
});

test('conversa self LID é identificada só pela conta e metadados autenticados, sem liberar conversa de terceiros', async t => {
  const { adapter, socket } = await fixture(t);
  socket.user.lid = '8888888888888@lid';
  adapter.configureSearchCapture({ enabled: true });
  const contexts = [];
  adapter.on('offerMessage', value => contexts.push(value));
  socket.ev.emit('messages.upsert', { type: 'notify', messages: [message('self-lid-chat', '!busca', { key: { fromMe: true, remoteJid: '8888888888888@lid' } }), message('other-private-chat', '!busca', { key: { fromMe: true, remoteJid: '5511888888888@s.whatsapp.net' } }), message('conflicting-self-chat', '!busca', { key: { fromMe: true, remoteJid: '8888888888888@lid', remoteJidAlt: '5511888888888@s.whatsapp.net' } })] });
  assert.deepEqual(contexts.map(value => value.selfChat), [true, false, false]);
  assert.ok(contexts.every(value => value.senderNumber === '5511999999999'));
});

test('respostas automáticas e ledger persistente são marcados antes do echo para impedir loops', async t => {
  const { adapter, socket } = await fixture(t);
  adapter.configureSearchCapture({ enabled: true });
  const persisted = new Set(['from-old-process']);
  adapter.store.isOutboundMessageId = id => persisted.has(id);
  adapter.store.registerOutboundMessageId = id => persisted.add(id);
  const contexts = [];
  adapter.on('offerMessage', value => contexts.push(value));
  socket.sendMessage = async (_target, content, options) => {
    assert.equal(persisted.has(options.messageId), true);
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [message(options.messageId, content.text, { key: { fromMe: true } })] });
    socket.ws.emit('CB:ack,class:message', { attrs: { id: options.messageId } });
    return { key: { id: options.messageId }, status: 1 };
  };
  assert.equal((await adapter.sendSearchText('5511999999999', '!busca resposta automática', { clientMessageId: 'automatic-reply' })).status, 'confirmed');
  socket.ev.emit('messages.upsert', { type: 'notify', messages: [message('from-old-process', '!busca texto persistido', { key: { fromMe: true } })] });
  assert.deepEqual(contexts.map(context => context.automaticMessage), [true, true]);
  assert.ok(contexts.every(context => context.trustedSelf && context.machineGenerated));
});

test('comando manual é capturado uma vez e recuperação da própria conta permanece histórico', async t => {
  const { adapter, socket } = await fixture(t);
  adapter.configureSearchCapture({ enabled: true });
  const live = [], history = [];
  adapter.on('offerMessage', value => live.push(value));
  adapter.on('offerHistory', value => history.push(value));
  const manual = message('manual-once', '!busca', { key: { fromMe: true } });
  socket.ev.emit('messages.upsert', { type: 'notify', messages: [manual, manual] });
  socket.ev.emit('messages.upsert', { type: 'notify', requestId: 'recovered', messages: [message('own-recovered', '!busca 18', { key: { fromMe: true } })] });
  assert.equal(live.length, 1);
  assert.equal(live[0].trustedSelf, true);
  assert.equal(history[0].messages[0].history, true);
});

test('destinatário próprio usa JID autenticado com dispositivo removido, sem consulta ou fallback', async t => {
  const { adapter, socket, sends } = await fixture(t);
  socket.user.id = '5511999999999:12@s.whatsapp.net';
  let lookups = 0;
  socket.onWhatsApp = async () => { lookups++; throw new Error('não deve consultar self'); };
  const recipient = await adapter.resolveRecipient('5511999999999');
  assert.equal(recipient.jid, '5511999999999@s.whatsapp.net');
  assert.equal(recipient.isSelf, true);
  const result = await adapter.sendPrivate('5511999999999', 'Teste privado self', { clientMessageId: 'self-private' });
  assert.equal(result.status, 'uncertain');
  assert.equal(sends[0].target, recipient.jid);
  assert.equal(lookups, 0);
});

test('USYNC resolve JID real, incluindo LID fornecido pelo servidor, sem telefone derivado do LID', async t => {
  const { adapter, socket, sends } = await fixture(t);
  let lookups = 0;
  socket.onWhatsApp = async number => { lookups++; assert.equal(number, '5511888888888'); return [{ jid: '1234567890123@lid', exists: true }]; };
  const recipient = await adapter.resolveRecipient('5511888888888');
  assert.equal(recipient.jid, '1234567890123@lid');
  assert.equal(recipient.phone, '5511888888888');
  assert.equal(recipient.isSelf, false);
  await adapter.sendSearchText('5511888888888', 'Resultado privado', { clientMessageId: 'lid-result' });
  assert.equal(sends[0].target, '1234567890123@lid');
  assert.equal(lookups, 1, 'lookup conhecido é compartilhado pelo cache da conexão');
});

test('número não encontrado, identificador divergente ou integração ausente falham antes do envio', async t => {
  const { adapter, socket, sends } = await fixture(t);
  socket.onWhatsApp = async () => [];
  await assert.rejects(adapter.sendPrivate('5511888888888', 'Não deve enviar'), error => error.code === 'WA_RECIPIENT_NOT_FOUND' && error.safeToRetry === false);
  socket.onWhatsApp = async () => [{ jid: '5511777777777@s.whatsapp.net', exists: true }];
  await assert.rejects(adapter.sendSearchText('5511888888888', 'Não deve enviar'), error => error.code === 'WA_RECIPIENT_MISMATCH');
  delete socket.onWhatsApp;
  await assert.rejects(adapter.resolveRecipient('5511888888888'), error => error.code === 'WA_RECIPIENT_UNSUPPORTED');
  assert.equal(sends.length, 0);
});

test('lookup temporário tem prazo, erros sanitizados e pode repetir somente antes da submissão', async t => {
  const { adapter, socket, sends } = await fixture(t);
  adapter.controlTimeoutMs = 10;
  socket.onWhatsApp = () => new Promise(() => {});
  await assert.rejects(adapter.sendPrivate('5511888888888', 'Teste'), error => error.code === 'WA_RECIPIENT_TIMEOUT' && error.safeToRetry === true);
  socket.onWhatsApp = async () => { throw new Error('token=password=segredo'); };
  await assert.rejects(adapter.resolveRecipient('5511888888888'), error => error.code === 'WA_RECIPIENT_LOOKUP_TEMPORARY' && error.safeToRetry && !error.message.includes('segredo'));
  assert.equal(sends.length, 0);
  assert.equal(adapter.status.state, 'connected');
});

test('consultas simultâneas compartilham resolução e mudança de conexão invalida resultado antigo', async t => {
  const { adapter, socket } = await fixture(t);
  let calls = 0, resolve;
  socket.onWhatsApp = () => { calls++; return new Promise(done => { resolve = done; }); };
  const first = adapter.resolveRecipient('5511888888888');
  const second = adapter.resolveRecipient('5511888888888');
  await new Promise(done => setImmediate(done));
  assert.equal(calls, 1);
  adapter.setNetworkOnline(false);
  resolve([{ jid: '5511888888888@s.whatsapp.net', exists: true }]);
  for (const request of [first, second]) await assert.rejects(request, error => error.code === 'WA_RECIPIENT_CONNECTION_CHANGED' && error.safeToRetry === true);
});

test('ACK comprova aceitação; entrega e leitura só aparecem quando recibos reais chegam', async t => {
  const { adapter, socket } = await fixture(t);
  const receipts = [];
  adapter.on('receipt', value => receipts.push(value));
  socket.ws.emit('CB:ack,class:message', { attrs: { id: 'not-submitted' } });
  assert.equal(receipts.length, 0, 'um ID não reservado não confirma envio novo');
  const pending = adapter.sendSearchText('12001@g.us', 'Resultado', { clientMessageId: 'proof-1' });
  socket.ws.emit('CB:ack,class:message', { attrs: { id: 'proof-1' } });
  assert.equal((await pending).status, 'confirmed');
  assert.equal(receipts.at(-1).confirmationScope, 'whatsapp-server');
  assert.equal(receipts.at(-1).deliveredAt, undefined);
  const seconds = Math.floor(Date.now() / 1000);
  socket.ev.emit('message-receipt.update', [{ key: { id: 'proof-1', fromMe: true }, receipt: { receiptTimestamp: seconds } }]);
  assert.equal(receipts.at(-1).confirmationScope, 'whatsapp-delivered');
  assert.equal(receipts.at(-1).deliveredAt, seconds * 1000);
  socket.ev.emit('message-receipt.update', [{ key: { id: 'proof-1', fromMe: true }, receipt: { readTimestamp: seconds + 1 } }]);
  assert.equal(receipts.at(-1).confirmationScope, 'whatsapp-read');
  assert.equal(receipts.at(-1).readAt, (seconds + 1) * 1000);
});

test('reserva persistida após queda não permite reenviar item sem confirmação', async t => {
  const { adapter, sends } = await fixture(t);
  adapter.store.isOutboundMessageId = id => id === 'reserved-before-crash';
  adapter.store.registerOutboundMessageId = id => ({ changes: id === 'reserved-before-crash' ? 0 : 1 });
  const result = await adapter.sendSearchText('5511999999999', 'Não reenviar', { clientMessageId: 'reserved-before-crash' });
  assert.equal(result.status, 'uncertain');
  assert.equal(sends.length, 0);
});

test('simulação de self e destinatários nunca utiliza rede e identifica dados fictícios', async () => {
  const adapter = new SimulatedAdapter({ delayMs: 0 });
  adapter.setOwnAccount('5511999999999');
  await adapter.connect();
  adapter.configureSearchCapture({ enabled: true });
  const contexts = [];
  adapter.on('offerMessage', value => contexts.push(value));
  adapter.injectIncoming({ messageId: 'sim-manual', fromMe: true, senderNumber: '5511888888888', chatId: '5511777777777@s.whatsapp.net', text: '!busca iPhone 18 Pro Max Silver' });
  assert.equal(contexts[0].senderNumber, '5511999999999');
  assert.equal(adapter.isTrustedSelfContext(contexts[0]), true);
  const recipient = await adapter.resolveRecipient('5511999999999');
  assert.equal(recipient.simulation, true);
  assert.equal(recipient.isSelf, true);
  await adapter.sendSearchText('5511999999999', '!busca automático', { clientMessageId: 'sim-auto' });
  adapter.injectIncoming({ messageId: 'sim-auto', fromMe: true, text: '!busca automático' });
  assert.equal(contexts.at(-1).automaticMessage, true);
  assert.ok(adapter.sent.every(entry => entry.simulation === true));
});

test('SQLite com filas pendentes permite primeira submissão e reserva de transporte impede repetição após reinício', async t => {
  const { adapter, socket } = await fixture(t);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kenned-transport-ledger-'));
  const store = await createStore(dir);
  t.after(async () => { store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  store.setSetting('integrationMode', 'whatsapp');
  store.upsertGroups([{ id: '12001@g.us', name: 'Grupo real de fixture', authorized: true, simulation: false }]);
  store.insertJob({ id: 'campaign-job', roundId: 'round-1', campaignId: 'campaign-1', groupId: '12001@g.us', itemId: 'item-1', status: 'queued', createdAt: Date.now(), messageId: 'CAMP-FIRST' });
  store.saveAlert({ id: 'alert-1', status: 'pending', messageId: 'ALERT-FIRST', createdAt: Date.now(), text: 'Alerta', channel: 'whatsapp' });
  store.saveSearchRun({ id: 'search-run', status: 'pending', createdAt: Date.now() });
  store.saveSearchDelivery({ id: 'search-delivery', runId: 'search-run', status: 'pending', messageId: 'SEARCH-FIRST', createdAt: Date.now() });
  adapter.store = store;
  const submitted = [];
  socket.sendMessage = async (target, content, options) => {
    submitted.push({ target, text: content.text, id: options.messageId });
    socket.ws.emit('CB:ack,class:message', { attrs: { id: options.messageId } });
    return { key: { id: options.messageId }, status: 1 };
  };
  for (const id of ['CAMP-FIRST', 'ALERT-FIRST', 'SEARCH-FIRST']) assert.equal(store.isOutboundMessageId(id), true, 'a fila identifica automação mas ainda não é reserva de transporte');
  assert.equal((await adapter.send('12001@g.us', { type: 'text', text: 'Campanha', clientMessageId: 'CAMP-FIRST' })).status, 'confirmed');
  assert.equal((await adapter.sendPrivate('5511999999999', 'Alerta', { clientMessageId: 'ALERT-FIRST' })).status, 'confirmed');
  assert.equal((await adapter.sendSearchText('5511999999999', 'Busca', { clientMessageId: 'SEARCH-FIRST' })).status, 'confirmed');
  assert.equal(submitted.length, 3);
  const reopenedAdapter = new WhatsAppAdapter({ store });
  reopenedAdapter.socket = socket;
  reopenedAdapter.library = adapter.library;
  reopenedAdapter.status = { state: 'connected', mode: 'whatsapp' };
  for (const id of ['ALERT-FIRST', 'SEARCH-FIRST']) assert.equal((await reopenedAdapter.sendPrivate('5511999999999', 'Nunca repetir', { clientMessageId: id })).status, 'uncertain');
  assert.equal(submitted.length, 3, 'reserva durável protege mesmo sem caches do processo antigo');
  store.clearHistory({ actor: 'owner' });
  store.deleteSearchHistory({ actor: 'owner' });
  assert.equal((await reopenedAdapter.sendSearchText('5511999999999', 'Nunca repetir', { clientMessageId: 'SEARCH-FIRST' })).status, 'uncertain');
  assert.equal(submitted.length, 3);
});

test('falha de persistência bloqueia transporte antes de enviar e erro não revela conteúdo sensível', async t => {
  const { adapter, sends } = await fixture(t);
  adapter.store.registerOutboundMessageId = () => { throw new Error('sqlite token=secret disk failure'); };
  await assert.rejects(adapter.sendPrivate('5511999999999', 'Teste', { clientMessageId: 'blocked-disk' }), error => error.code === 'WA_AUTOMATION_PERSISTENCE_FAILED' && !error.message.includes('secret') && error.safeToRetry === false);
  assert.equal(sends.length, 0);
});
