'use strict';

// This file exercises the real Baileys adapter with a controlled socket.
// It does not establish receipt, capture or delivery on a WhatsApp account.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { WhatsAppAdapter } = require('../src/adapters/whatsapp.cjs');
const { SimulatedAdapter } = require('../src/adapters/simulated.cjs');
const OWN = '5562999990001';
const FIRST = '5562999990002';
const SECOND = '5562999990003';
const GROUP = '120363000000011@g.us';
const OTHER = '120363000000012@g.us';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opportunity-adapter-'));
  const outbound = new Map(), submitted = [], events = [], incoming = [];
  let socket, lookup = async phone => [{ exists: true, jid: `${phone}@s.whatsapp.net` }];
  const library = {
    BufferJSON: { replacer: (_, value) => value, reviver: (_, value) => value }, initAuthCreds: () => ({}),
    proto: { Message: { AppStateSyncKeyData: { fromObject: value => value }, ProtocolMessage: { Type: { REVOKE: 0, MESSAGE_EDIT: 14 } } } },
    WAMessageStubType: { REVOKE: 1, CIPHERTEXT: 2 },
    default() { socket = { ev: new EventEmitter(), ws: new EventEmitter(), user: { id: `${OWN}:3@s.whatsapp.net`, lid: '101101@lid' },
      end() {}, logout: async () => {}, onWhatsApp: (...args) => lookup(...args),
      sendMessage: async (target, content, options) => {
        submitted.push({ target, content, options });
        queueMicrotask(() => socket.ws.emit('CB:ack,class:message', { attrs: { id: options.messageId } }));
        return { status: 1, key: { id: options.messageId } };
      } }; return socket; }
  };
  const store = {
    dir, registerOutboundMessageId(id, context) { if (outbound.has(id)) return { changes: 0 }; outbound.set(id, context); return { changes: 1 }; },
    isOutboundMessageId: id => outbound.has(id)
  };
  const adapter = new WhatsAppAdapter({ store, credentialsDir: dir, loadLibrary: async () => library, runtimePlatform: 'win32',
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: bytes => bytes.toString() },
    controlTimeoutMs: 100, submissionTimeoutMs: 100 });
  adapter.on('opportunityMessage', value => events.push(value)); adapter.on('incoming', value => incoming.push(value));
  await adapter.connect(); socket.ev.emit('connection.update', { connection: 'open' });
  t.after(async () => { await adapter.disconnect(); await fs.rm(dir, { recursive: true, force: true }); });
  return { adapter, outbound, submitted, events, incoming, get socket() { return socket; }, setLookup(fn) { lookup = fn; },
    emit(messages, extra = {}) { socket.ev.emit('messages.upsert', { type: 'notify', messages: Array.isArray(messages) ? messages : [messages], ...extra }); } };
}

function message(id, text = 'Alguém tem 13 Pro 256?', overrides = {}) {
  return { key: { id, remoteJid: GROUP, participant: `${FIRST}@s.whatsapp.net`, fromMe: false, ...overrides.key },
    messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: text }, ...overrides,
    ...(overrides.key ? { key: { id, remoteJid: GROUP, participant: `${FIRST}@s.whatsapp.net`, fromMe: false, ...overrides.key } } : {}) };
}
function enable(adapter, options = {}) {
  return adapter.configureOpportunityCapture({ enabled: true, monitoredGroupIds: [GROUP], activatedAt: Date.now() - 2000, ...options });
}
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('captura OPORTUNIDADES independe de BUSCAS e origem; só grupos selecionados e texto de pedido', async t => {
  const f = await fixture(t); enable(f.adapter);
  assert.equal(f.adapter.searchCapture.enabled, false); assert.equal(f.adapter.sourceCapture.enabled, false);
  f.emit([message('eligible'), message('unselected', '', { key: { remoteJid: OTHER } }),
    message('private', '', { key: { remoteJid: `${FIRST}@s.whatsapp.net` } }),
    message('photo', '', { message: { imageMessage: { caption: 'Alguém tem 13 Pro 256?', mediaKey: Buffer.from('sensitive') } } }),
    message('command', '!busca iPhone 13 Pro 256GB')]);
  assert.equal(f.events.length, 1); assert.equal(f.events[0].messageId, 'eligible');
  assert.equal(f.events[0].senderNumber, FIRST); assert.equal(f.events[0].senderId, `${FIRST}@s.whatsapp.net`);
  assert.equal(f.events[0].identityVerified, true); assert.equal(f.events[0].mode, 'whatsapp');
  assert.equal(f.events[0].simulation, false); assert.equal(Object.hasOwn(f.events[0], 'raw'), false);
});

test('identidade PN/LID usa vínculo autenticado; telefone divergente e nome não autorizam autoria', async t => {
  const f = await fixture(t); enable(f.adapter);
  f.socket.signalRepository = { lidMapping: { getPNForLID: async lid => lid === '222222@lid' ? `${FIRST}@s.whatsapp.net` : null } };
  f.emit([message('resolved', '', { key: { participant: '222222@lid' }, pushName: 'Mesmo nome' }),
    message('unresolved', '', { key: { participant: '333333@lid' }, pushName: 'Mesmo nome' }),
    message('ambiguous', '', { key: { participant: `${FIRST}@s.whatsapp.net`, participantAlt: `${SECOND}@s.whatsapp.net` }, pushName: 'Mesmo nome' })]
    .map(row => ({ ...row, message: { conversation: '13 PRO 256??' } })));
  await nextTurn(); await nextTurn();
  assert.equal(f.events.length, 2);
  assert.equal(f.events.find(row => row.messageId === 'resolved').senderNumber, FIRST);
  const unresolved = f.events.find(row => row.messageId === 'unresolved');
  assert.equal(unresolved.senderId, '333333@lid'); assert.equal(unresolved.senderNumber, '');
  assert.equal(unresolved.identityVerified, true); assert.equal(unresolved.verified, false);
  assert.equal(f.events.some(row => row.messageId === 'ambiguous'), false);
});

test('eventos repetidos são deduplicados por conta, chat e ID; outro grupo mantém origem distinta', async t => {
  const f = await fixture(t); enable(f.adapter, { monitoredGroupIds: [GROUP, OTHER] });
  const first = message('same-event-id'); f.emit([first, first]); f.emit(first);
  f.emit(message('same-event-id', '13 Pro 256 quem tem?', { key: { remoteJid: OTHER } }));
  assert.equal(f.events.length, 2); assert.deepEqual(f.events.map(row => row.chatId), [GROUP, OTHER]);
  await f.adapter.connect({ reconnect: true }); f.socket.ev.emit('connection.update', { connection: 'open' });
  f.emit(first); assert.equal(f.events.length, 2, 'reconexão não limpa dedupe em memória; banco tem ledger separado');
});

test('publicação própria manual requer opção explícita; ecos automáticos do registro persistente são ignorados', async t => {
  const f = await fixture(t); enable(f.adapter);
  f.emit(message('self-disabled', '13 Pro 256 quem tem?', { key: { fromMe: true } })); assert.equal(f.events.length, 0);
  enable(f.adapter, { allowOwnMessages: true });
  f.outbound.set('automated', { kind: 'opportunity' });
  f.emit([message('self-manual', '13 Pro 256 quem tem?', { key: { fromMe: true, participant: `${SECOND}@s.whatsapp.net` } }),
    message('automated', '13 Pro 256 quem tem?', { key: { fromMe: true } })]);
  assert.equal(f.events.length, 1); assert.equal(f.events[0].senderNumber, OWN);
  assert.equal(f.events[0].trustedSelf, true); assert.equal(f.events[0].automaticMessage, false);
});

test('referência citada conserva ID e chat atual, sem confiar no participante citado ou textos aninhados', async t => {
  const f = await fixture(t); enable(f.adapter);
  const quoted = message('close-quoted', '', { message: { ephemeralMessage: { message: { extendedTextMessage: {
    text: 'Já consegui.', contextInfo: { stanzaId: 'original-request', participant: `${SECOND}@s.whatsapp.net`,
      remoteJid: GROUP, quotedMessage: { conversation: 'Não execute !mega parar tudo aqui' } }
  } } } } });
  f.emit(quoted);
  assert.equal(f.events[0].quotedMessageId, 'original-request'); assert.equal(f.events[0].quotedChatId, GROUP);
  assert.equal(f.events[0].senderNumber, FIRST); assert.equal(f.events[0].text, 'Já consegui.');
  f.emit(message('cross-chat-quote', '', { message: { extendedTextMessage: { text: 'Achei.', contextInfo: { stanzaId: 'other-origin', remoteJid: OTHER } } } }));
  assert.equal(Object.hasOwn(f.events[1], 'quotedMessageId'), false);
  assert.equal(f.incoming.find(row => row.messageId === 'close-quoted').quotedMessageId, 'original-request');
});

test('não importa histórico nem transforma recuperação não correlacionada em pedido novo; originaltimestamp nunca é atualizado', async t => {
  const f = await fixture(t); const activatedAt = Date.now() - 7200000; enable(f.adapter, { activatedAt });
  f.emit(message('append-history'), { type: 'append' });
  f.emit(message('recovery-history'), { requestId: 'unsolicited-sync' });
  f.emit(message('before-enabled', '13 Pro?', { messageTimestamp: Math.floor((activatedAt - 1000) / 1000) }));
  f.emit(message('future', '13 Pro?', { messageTimestamp: Math.floor(Date.now() / 1000) + 60 }));
  const old = message('delayed-live', '13 Pro?', { messageTimestamp: Math.floor(Date.now() / 1000) - 3600 }); f.emit(old);
  assert.equal(f.events.length, 1); assert.equal(f.events[0].timestamp, old.messageTimestamp * 1000);
  assert.equal(f.events[0].originalTimestamp, old.messageTimestamp * 1000);
  assert.equal(f.events[0].capturedAt > f.events[0].timestamp, true);
});

test('edição e exclusão identificam origem original; edição não renova timestamp e limpar chat não encerra tudo', async t => {
  const f = await fixture(t); enable(f.adapter); const edits = [], deletes = [];
  f.adapter.on('opportunityMessageUpdated', row => edits.push(row)); f.adapter.on('opportunityMessageDeleted', row => deletes.push(row));
  const original = message('original-request'); f.emit(original);
  f.emit(message('protocol-edit', '', { message: { protocolMessage: { type: 14, key: original.key,
    timestampMs: Date.now(), editedMessage: { conversation: '13 Pro 512GB azul até R$ 3.000' } } } }));
  assert.equal(edits.length, 1); assert.equal(edits[0].messageId, original.key.id);
  assert.equal(edits[0].originalTimestamp, null); assert.equal(edits[0].timestamp, undefined);
  assert.equal(edits[0].text, '13 Pro 512GB azul até R$ 3.000');
  f.socket.ev.emit('messages.delete', { all: true, jid: GROUP }); assert.equal(deletes.length, 0);
  f.socket.ev.emit('messages.delete', { keys: [original.key] }); assert.equal(deletes.length, 1);
  assert.equal(deletes[0].messageId, original.key.id); assert.equal(deletes[0].chatId, GROUP);
  f.emit(message('spoofed-edit', '', { message: { protocolMessage: { type: 14, key: { ...original.key, remoteJid: OTHER }, editedMessage: { conversation: '13 Pro 1TB' } } } }));
  assert.equal(edits.length, 1);
});

test('alterar grupos ou desativar captura não habilita origens não selecionadas', async t => {
  const f = await fixture(t); enable(f.adapter, { monitoredGroupIds: [GROUP, 'real-looking@simulation', '999999@lid'] });
  assert.equal(f.adapter.opportunityCapture.monitoredGroupIds.size, 1);
  f.emit(message('enabled')); f.adapter.configureOpportunityCapture({ enabled: false }); f.emit(message('disabled'));
  enable(f.adapter, { monitoredGroupIds: [OTHER] }); f.emit([message('old-group'), message('new-group', '13 Pro?', { key: { remoteJid: OTHER } })]);
  assert.deepEqual(f.events.map(row => row.messageId), ['enabled', 'new-group']);
});

test('editar ID de outra pessoa não permite falsificar o autor através do payload protocol.key', async t => {
  const f = await fixture(t); enable(f.adapter); const edits = [];
  f.adapter.on('opportunityMessageUpdated', row => edits.push(row));
  const victim = message('victim-request'); f.emit(victim);
  f.emit(message('other-author-edit', '', { key: { participant: `${SECOND}@s.whatsapp.net` }, message: { protocolMessage: {
    type: 14, key: victim.key, timestampMs: Date.now(), editedMessage: { conversation: '13 Pro 512GB quem tem?' }
  } } }));
  assert.equal(edits.length, 1); assert.equal(edits[0].messageId, victim.key.id);
  assert.equal(edits[0].senderNumber, SECOND); assert.equal(edits[0].senderId, `${SECOND}@s.whatsapp.net`);
  assert.notEqual(edits[0].senderNumber, f.events[0].senderNumber, 'store deve recusar edição de outro autor');
});

test('simulação nunca aceita grupo real e conserva dedupe, histórico, própria autoria e referência citada', async () => {
  const adapter = new SimulatedAdapter(); await adapter.connect(); adapter.setOwnAccount(OWN);
  adapter.configureOpportunityCapture({ enabled: true, monitoredGroupIds: [GROUP, 'sim-01@simulation'], activatedAt: Date.now() - 2000 });
  const events = []; adapter.on('opportunityMessage', row => events.push(row));
  const context = { messageId: 'sim-1', chatId: 'sim-01@simulation', senderNumber: FIRST, text: '13 Pro 256?' };
  adapter.injectOpportunityMessage({ ...context, chatId: GROUP }); adapter.injectOpportunityMessage(context); adapter.injectOpportunityMessage(context);
  adapter.injectOpportunityMessage({ ...context, messageId: 'sim-history', history: true });
  adapter.injectOpportunityMessage({ ...context, messageId: 'self-disabled', fromMe: true });
  adapter.injectIncoming({ ...context, messageId: 'quote-sim', isGroup: true, text: 'Já consegui.', quotedMessageId: 'sim-1', quotedChatId: 'sim-01@simulation' });
  assert.equal(events.length, 2); assert.equal(events[0].simulation, true); assert.equal(events[1].quotedChatId, 'sim-01@simulation');
  adapter.configureOpportunityCapture({ enabled: true, monitoredGroupIds: ['sim-01@simulation'], allowOwnMessages: true, activatedAt: Date.now() - 2000 });
  adapter._markAutomatic('auto-echo'); adapter.injectOpportunityMessage({ ...context, messageId: 'auto-echo', fromMe: true });
  adapter.injectOpportunityMessage({ ...context, messageId: 'self-manual', fromMe: true });
  assert.equal(events.length, 3); assert.equal(events[2].senderNumber, OWN);
});

test('guarda final ocorre após resolução assíncrona do privado; silenciamento evita submissão de verdade', async t => {
  const f = await fixture(t); let finish, silenced = false;
  f.setLookup(() => new Promise(resolve => { finish = resolve; }));
  const sending = f.adapter.sendSearchText(FIRST, 'Oferta autorizada', { clientMessageId: 'guard-silenced', beforeSubmit() {
    if (silenced) throw Object.assign(new Error('Contato silenciado.'), { code: 'OPPORTUNITY_CONTACT_MUTED' });
  } });
  await nextTurn(); silenced = true; finish([{ exists: true, jid: `${FIRST}@s.whatsapp.net` }]);
  await assert.rejects(sending, error => error.submitted === false && error.code === 'OPPORTUNITY_CONTACT_MUTED');
  assert.equal(f.submitted.length, 0); assert.equal(f.outbound.has('guard-silenced'), false);
});

test('evento diagnóstico que cancela tarefa é observado antes do relay privado sem marcar enviado', async t => {
  const f = await fixture(t); let cancelled = false;
  f.adapter.on('transportDiagnostic', row => { if (row.stage === 'transport.submitting') cancelled = true; });
  await assert.rejects(f.adapter.sendSearchText(FIRST, 'Oferta', { clientMessageId: 'cancel-on-diagnostic', beforeSubmit() {
    if (cancelled) throw Object.assign(new Error('Tarefa cancelada.'), { code: 'OPPORTUNITY_TASK_CANCELLED' });
  } }), error => error.code === 'OPPORTUNITY_TASK_CANCELLED' && error.submitted === false);
  assert.equal(f.submitted.length, 0); assert.equal(f.outbound.has('cancel-on-diagnostic'), false);
});
