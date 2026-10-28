'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Readable } = require('node:stream');
const { WhatsAppAdapter } = require('../src/adapters/whatsapp.cjs');
const { SimulatedAdapter } = require('../src/adapters/simulated.cjs');
const OWN = '5562999999999@s.whatsapp.net';
const GROUP = '120363000000001@g.us';
const SECOND = '120363000000002@g.us';

// These authenticated-looking events are controlled socket fixtures, not real WhatsApp receipts.
async function fixture(t, { submissionTimeoutMs = 35, ackTimeoutMs = 15 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adapter-source-232-'));
  const outbound = new Map(), submitted = [];
  let socket, send = async (jid, content, opts) => { submitted.push({ jid, content, opts }); return { key: { id: opts.messageId }, status: 1 }; };
  const metadata = new Map([[GROUP, { id: GROUP, subject: 'Origem real no fixture', participants: [{ id: OWN }] }], [SECOND, { id: SECOND, subject: 'Outro destino', participants: [{ id: OWN }] }]]);
  const library = {
    BufferJSON: { replacer: (_, value) => value, reviver: (_, value) => value }, initAuthCreds: () => ({}),
    proto: { Message: { AppStateSyncKeyData: { fromObject: value => value }, ProtocolMessage: { Type: { REVOKE: 0, MESSAGE_EDIT: 14 } } }, MessageAssociation: { AssociationType: { MEDIA_ALBUM: 1 } } },
    WAMessageStubType: { REVOKE: 1 },
    default: () => (socket = { ev: new EventEmitter(), ws: new EventEmitter(), user: { id: OWN, lid: '888888@lid' }, end() {}, logout: async () => {},
      groupMetadata: async id => metadata.get(id), onWhatsApp: async phone => [{ jid: `${phone}@s.whatsapp.net`, exists: true }], sendMessage: (...args) => send(...args) })
  };
  const store = { dir, getGroup: id => ({ id, name: id === GROUP ? 'Grupo de origem' : 'Destino', authorized: true, simulation: false }),
    registerOutboundMessageId: (id, context) => { if (outbound.has(id)) return { changes: 0 }; outbound.set(id, context); return { changes: 1 }; }, isOutboundMessageId: id => outbound.has(id) };
  const adapter = new WhatsAppAdapter({ store, credentialsDir: dir, safeStorage: { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: buffer => buffer.toString() }, loadLibrary: async () => library, runtimePlatform: 'win32', submissionTimeoutMs, ackTimeoutMs, controlTimeoutMs: 35 });
  await adapter.connect(); socket.ev.emit('connection.update', { connection: 'open' });
  t.after(async () => { await adapter.disconnect(); await fs.rm(dir, { recursive: true, force: true }); });
  return { adapter, socket, library, store, metadata, submitted, outbound, setSend(fn) { send = fn; } };
}
function publication(id, caption = '📱 iPhone 16 128GB\n🩷 Cor: ROSA\n🔋 Saúde da bateria: 92%\nR$ 2.999,00\nDetalhe na tela pequeno\n\n𝗣𝗮𝗹𝗮𝗰𝗲 𝗣𝗮𝗿𝗳𝘂𝗺 - 𝗖𝗮𝗺𝗲𝗹𝗼́𝗱𝗿𝗼𝗺𝗼 𝗢𝗞 𝗦𝗧𝗔𝗡𝗗 𝟭𝟯𝟬/𝟭𝟯𝟭', extra = {}) {
  return { messageTimestamp: Math.floor(Date.now() / 1000), message: { imageMessage: { caption, mimetype: 'image/jpeg', fileLength: 4 } }, ...extra,
    key: { id, remoteJid: GROUP, participant: '5562888888888@s.whatsapp.net', fromMe: false, ...extra.key } };
}
function enable(adapter, extras = {}) { adapter.configureSourceCapture({ enabled: true, groupIds: [GROUP], activatedAt: Date.now() - 2000, ...extras }); }

 test('foto com legenda preserva texto completo e próprio número manual; ecos e legendas-comando não são executados', async t => {
  const { adapter, socket, outbound } = await fixture(t); enable(adapter);
  const publications = [], commands = []; adapter.on('publication', value => publications.push(value)); adapter.on('incoming', value => commands.push(value));
  const photo = publication('photo-1');
  const own = publication('own-manual', '!mega parar tudo\nLegenda e preço R$ 2.999,00', { key: { fromMe: true, participant: 'wrong@lid' } });
  outbound.set('automatic-photo', {});
  socket.ev.emit('messages.upsert', { type: 'notify', messages: [photo, own, publication('automatic-photo', 'Automático', { key: { fromMe: true } }), publication('other-group', 'Outra origem', { key: { remoteJid: SECOND } })] });
  assert.equal(publications.length, 2); assert.equal(publications[0].text, photo.message.imageMessage.caption);
  assert.equal(publications[0].raw.message.imageMessage.caption, photo.message.imageMessage.caption);
  assert.equal(publications[0].timestamp, photo.messageTimestamp * 1000);
  assert.equal(publications[1].senderNumber, '5562999999999'); assert.equal(publications[1].trustedSelf, true);
  assert.equal(commands.some(row => row.messageId === 'own-manual'), false);
  socket.ev.emit('messages.upsert', { type: 'notify', messages: [photo] }); assert.equal(publications.length, 2);
});

test('histórico exige intervalo explícito; seleção de origem independe de BUSCAS e nunca inventa histórico completo', async t => {
  const { adapter, socket } = await fixture(t); const events = []; adapter.on('publication', value => events.push(value));
  const old = publication('historical', 'Legenda antiga', { messageTimestamp: Math.floor(Date.now() / 1000) - 86400 });
  enable(adapter); socket.ev.emit('messages.upsert', { type: 'append', messages: [old] }); assert.equal(events.length, 0);
  enable(adapter, { importFrom: old.messageTimestamp * 1000 - 1000, importUntil: old.messageTimestamp * 1000 + 1000 });
  socket.ev.emit('messaging-history.set', { messages: [old, publication('outside-period', '', { messageTimestamp: old.messageTimestamp - 3600 })], contacts: [] });
  assert.equal(events.length, 1); assert.equal(events[0].history, true); assert.equal(events[0].timestamp, old.messageTimestamp * 1000);
  assert.equal(adapter.getSourceCapabilities().completeHistory, false);
});

test('edição e revogação usam ID original; álbum somente com associação explícita de protocolo', async t => {
  const { adapter, socket } = await fixture(t); enable(adapter);
  const adds = [], edits = [], deletes = []; adapter.on('publication', row => adds.push(row)); adapter.on('publicationUpdate', row => edits.push(row)); adapter.on('publicationDelete', row => deletes.push(row));
  const first = publication('child-photo'); first.message.messageContextInfo = { messageAssociation: { associationType: 1, parentMessageKey: { id: 'album-original', remoteJid: GROUP } } };
  socket.ev.emit('messages.upsert', { type: 'notify', messages: [first, publication('unrelated-photo')] });
  assert.deepEqual(adds[0].albumParent, { messageId: 'album-original', chatId: GROUP }); assert.equal(adds[1].albumParent, undefined);
  socket.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: 'protocol-edit', remoteJid: GROUP, participant: '5562888888888@s.whatsapp.net' }, messageTimestamp: first.messageTimestamp, message: { protocolMessage: { type: 14, key: first.key, timestampMs: Date.now(), editedMessage: { imageMessage: { caption: 'Observação alterada ✅', mimetype: 'image/jpeg' } } } } }] });
  assert.equal(edits[0].messageId, 'child-photo'); assert.equal(edits[0].text, 'Observação alterada ✅'); assert.equal(edits[0].originalTimestamp, null);
  socket.ev.emit('messages.update', [{ key: first.key, update: { message: null, messageStubType: 1 } }]);
  socket.ev.emit('messages.delete', { keys: [publication('other-deleted').key] });
  assert.deepEqual(deletes.map(row => row.messageId), ['child-photo', 'other-deleted']);
});

test('participante LID é resolvido pelo repositório autenticado; identificador interno sem vínculo não vira telefone', async t => {
  const { adapter, socket } = await fixture(t); enable(adapter); const events = []; adapter.on('publication', value => events.push(value));
  socket.signalRepository = { lidMapping: { getPNForLID: async lid => lid === '123123@lid' ? '5562888888888@s.whatsapp.net' : null } };
  socket.ev.emit('messages.upsert', { type: 'notify', messages: [publication('mapped-lid', '', { key: { participant: '123123@lid' } }), publication('unknown-lid', '', { key: { participant: '456456@lid' } })] });
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.find(row => row.messageId === 'mapped-lid').senderNumber, '5562888888888');
  assert.equal(events.find(row => row.messageId === 'unknown-lid').senderNumber, '');
});

test('pré-verificação distingue administradores, ausência de participação, PN/LID, cache e mudança de permissão', async t => {
  const { adapter, socket, metadata } = await fixture(t);
  metadata.set(GROUP, { id: GROUP, subject: 'Grupo renomeado', announce: true, participants: [{ id: '888888@lid', phoneNumber: OWN }] });
  const denied = await adapter.getGroupPublishingStatus(GROUP); assert.equal(denied.code, 'WA_GROUP_ADMIN_ONLY'); assert.equal(denied.available, false); assert.equal(denied.name, 'Grupo renomeado');
  metadata.get(GROUP).participants[0].admin = 'admin'; assert.equal((await adapter.getGroupPublishingStatus(GROUP)).available, false, 'cache limitado');
  socket.ev.emit('group-participants.update', { id: GROUP }); assert.equal((await adapter.getGroupPublishingStatus(GROUP)).available, true);
  metadata.get(GROUP).participants = [{ id: '5562111111111@s.whatsapp.net' }];
  assert.equal((await adapter.getGroupPublishingStatus(GROUP, { force: true })).code, 'WA_GROUP_NOT_PARTICIPANT');
  assert.equal((await adapter.getGroupPublishingStatus('fake@lid')).code, 'WA_GROUP_ID_INVALID');
});

test('grupo sem permissão é bloqueado antes de submeter; erro real 403 durante outro envio não derruba conexão', async t => {
  const f = await fixture(t); f.metadata.get(GROUP).announce = true;
  await assert.rejects(f.adapter.send(GROUP, { type: 'text', text: 'Item', clientMessageId: 'before-denied' }), error => error.code === 'WA_GROUP_ADMIN_ONLY' && error.submitted === false);
  assert.equal(f.outbound.has('before-denied'), false);
  f.metadata.get(GROUP).announce = false; f.socket.ev.emit('groups.update', [{ id: GROUP }]);
  f.setSend(async (_jid, _content, opts) => { if (opts.messageId === 'rejected-group') throw Object.assign(new Error('forbidden'), { statusCode: 403 }); f.socket.ws.emit('CB:ack,class:message', { attrs: { id: opts.messageId } }); return { status: 1 }; });
  const rejection = await f.adapter.send(GROUP, { type: 'text', text: 'Item', clientMessageId: 'rejected-group' });
  assert.equal(rejection.status, 'failed'); assert.equal(rejection.code, 'WA_GROUP_REJECTED_403'); assert.equal(f.adapter.status.state, 'connected');
  assert.equal((await f.adapter.send(SECOND, { type: 'text', text: 'Outro item', clientMessageId: 'next-group' })).status, 'confirmed');
  assert.equal((await f.adapter.reconcile('rejected-group')).status, 'failed');
});

test('tentativa incerta libera próxima tarefa; ACK tardio é reconciliado uma vez sem segundo envio', async t => {
  const f = await fixture(t); let calls = 0, finish;
  f.setSend((_jid, _content, opts) => { calls++; if (opts.messageId === 'unknown-attempt') return new Promise(resolve => { finish = resolve; }); f.socket.ws.emit('CB:ack,class:message', { attrs: { id: opts.messageId } }); return { status: 1 }; });
  assert.equal((await f.adapter.send(GROUP, { type: 'text', text: 'A', clientMessageId: 'unknown-attempt' }, null, { timeoutMs: 10 })).status, 'uncertain');
  assert.equal(f.adapter.status.state, 'connected'); assert.equal((await f.adapter.reconcile('unknown-attempt')).status, 'uncertain');
  assert.equal((await f.adapter.send(SECOND, { type: 'text', text: 'B', clientMessageId: 'next-attempt' })).status, 'confirmed');
  assert.equal((await f.adapter.send(GROUP, { type: 'text', text: 'A', clientMessageId: 'unknown-attempt' })).status, 'uncertain'); assert.equal(calls, 2);
  const receipts = []; f.adapter.on('receipt', value => receipts.push(value)); finish({ status: 1 });
  f.socket.ws.emit('CB:ack,class:message', { attrs: { id: 'unknown-attempt' } }); f.socket.ws.emit('CB:ack,class:message', { attrs: { id: 'unknown-attempt' } });
  assert.equal(receipts.length, 1); assert.equal((await f.adapter.reconcile('unknown-attempt')).accepted, true); assert.equal(calls, 2);
  f.socket.ev.emit('message-receipt.update', [{ key: { id: 'unknown-attempt', fromMe: true }, receipt: { receiptTimestamp: Math.floor(Date.now() / 1000) } }]);
  assert.equal((await f.adapter.reconcile('unknown-attempt')).delivered, true);
});

test('sinal abortado impede submissão e upload atrasado não publica depois do prazo', async t => {
  const f = await fixture(t); const aborted = new AbortController(); aborted.abort();
  await assert.rejects(f.adapter.send(GROUP, { type: 'text', text: 'A', clientMessageId: 'aborted' }, null, { signal: aborted.signal }), error => error.code === 'WA_ATTEMPT_ABORTED' && error.submitted === false);
  assert.equal(f.outbound.size, 0);
  let finishUpload, relays = 0;
  f.socket.waUploadToServer = () => new Promise(resolve => { finishUpload = resolve; });
  f.setSend(async (_jid, _content, opts) => { await opts.upload('some-encrypted-file', {}); relays++; return { status: 1 }; });
  const pending = f.adapter._submitVerified(GROUP, { image: Buffer.from('JPEG'), caption: 'Preço correto R$ 2999,00' }, 'late-upload', null, null, { timeoutMs: 10 });
  assert.equal((await pending).status, 'uncertain'); finishUpload({ mediaUrl: 'https://example.invalid' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(relays, 0); assert.equal(f.adapter.status.state, 'connected');
});

test('download abortado destrói stream sem guardar parcial; próxima mídia continua utilizável', async t => {
  const { adapter, library } = await fixture(t); const controller = new AbortController(), stream = new PassThrough();
  library.downloadMediaMessage = async () => stream;
  const context = { type: 'image', raw: publication('media-download') };
  const pending = adapter.downloadIncoming(context, { signal: controller.signal, timeoutMs: 100 });
  stream.write(Buffer.from('JP')); controller.abort();
  await assert.rejects(pending, error => error.code === 'WA_MEDIA_DOWNLOAD_ABORTED'); assert.equal(stream.destroyed, true);
  library.downloadMediaMessage = async () => Readable.from([Buffer.from('JPEG')]);
  assert.equal((await adapter.downloadIncoming(context)).buffer.toString(), 'JPEG'); assert.equal(adapter.status.state, 'connected');
});

test('simulação conserva contrato sem aceitar destinos nem origens reais', async () => {
  const adapter = new SimulatedAdapter({ delayMs: 0 }); await adapter.connect(); adapter.setOwnAccount('5562999999999');
  adapter.configureSourceCapture({ enabled: true, groupIds: [GROUP, 'sim-01@simulation'], activatedAt: Date.now() - 1000 });
  const events = []; adapter.on('publication', value => events.push(value));
  adapter.injectPublication({ chatId: GROUP, messageId: 'real-rejected', type: 'image', text: 'Foto', senderNumber: '5562888888888' });
  adapter.injectPublication({ chatId: 'sim-01@simulation', messageId: 'sim-only', type: 'image', text: 'Foto ✅', fromMe: true });
  assert.equal(events.length, 1); assert.equal(events[0].simulation, true);
  assert.equal((await adapter.getGroupPublishingStatus(GROUP)).available, false);
  adapter.setNextOutcome('uncertain'); const item = { type: 'text', text: 'Simulação', clientMessageId: 'sim-uncertain' };
  assert.equal((await adapter.send('sim-01@simulation', item)).status, 'uncertain'); assert.equal((await adapter.send('sim-01@simulation', item)).status, 'uncertain'); assert.equal(adapter.sent.length, 1);
});

test('metadados parciais e vínculos próprios divergentes não são apresentados como remoção confirmada', async t => {
  const { adapter, metadata } = await fixture(t);
  metadata.set(GROUP, { id: GROUP, subject: 'Lista parcial', size: 200, participants: [{ id: '5562111111111@s.whatsapp.net' }] });
  const partial = await adapter.getGroupPublishingStatus(GROUP, { force: true }); assert.equal(partial.available, null); assert.equal(partial.confirmed, false); assert.equal(partial.code, 'WA_GROUP_METADATA_INCOMPLETE');
  metadata.set(GROUP, { id: GROUP, subject: 'Identidade divergente', participants: [{ id: '888888@lid', phoneNumber: '5562111111111@s.whatsapp.net' }] });
  const ambiguous = await adapter.getGroupPublishingStatus(GROUP, { force: true }); assert.equal(ambiguous.available, false); assert.equal(ambiguous.code, 'WA_GROUP_IDENTITY_AMBIGUOUS'); assert.equal(ambiguous.confirmed, false);
});

test('mídia em associatedChildMessage conserva associação de álbum e legenda sem associar por horário', async t => {
  const { adapter, socket } = await fixture(t); enable(adapter); const events = []; adapter.on('publication', row => events.push(row));
  const wrapped = publication('wrapped-album'); wrapped.message = { associatedChildMessage: { message: wrapped.message }, messageContextInfo: { messageAssociation: { associationType: 1, parentMessageKey: { id: 'album-key', remoteJid: GROUP } } } };
  socket.ev.emit('messages.upsert', { type: 'notify', messages: [wrapped] });
  assert.equal(events.length, 1); assert.equal(events[0].type, 'image'); assert.equal(events[0].text, wrapped.message.associatedChildMessage.message.imageMessage.caption); assert.equal(events[0].albumParent.messageId, 'album-key');
});

test('hash seguro disponível distingue troca de imagem de edição de legenda sem inferir quando ausente', async t => {
  const { adapter, socket } = await fixture(t); enable(adapter); const adds = [], edits = []; adapter.on('publication', row => adds.push(row)); adapter.on('publicationUpdate', row => edits.push(row));
  const original = publication('hash-image'); original.message.imageMessage.fileSha256 = Buffer.alloc(32, 1);
  socket.ev.emit('messages.upsert', { type: 'notify', messages: [original] });
  socket.ev.emit('messages.update', [{ key: original.key, update: { message: { imageMessage: { caption: 'Legenda editada', fileSha256: Buffer.alloc(32, 1) } } } }, { key: original.key, update: { message: { imageMessage: { caption: 'Imagem editada', fileSha256: Buffer.alloc(32, 2) } } } }, { key: original.key, update: { message: { imageMessage: { caption: 'Hash não fornecido' } } } }]);
  assert.equal(adds[0].mediaFingerprint, '01'.repeat(32)); assert.equal(edits[0].mediaFingerprint, adds[0].mediaFingerprint); assert.notEqual(edits[1].mediaFingerprint, adds[0].mediaFingerprint); assert.equal(edits[2].mediaFingerprint, undefined);
});
