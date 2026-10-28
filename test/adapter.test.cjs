'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { PassThrough, Readable } = require('node:stream');
const { SimulatedAdapter } = require('../src/adapters/simulated.cjs');
const { WhatsAppAdapter, EncryptedAuthStore } = require('../src/adapters/whatsapp.cjs');

function testProtection() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(text) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(text), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(buffer) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
      decipher.setAuthTag(buffer.subarray(-16));
      return Buffer.concat([decipher.update(buffer.subarray(12, -16)), decipher.final()]).toString();
    }
  };
}

async function fixture(t, { ackTimeoutMs = 30, submissionTimeoutMs = 90000, controlTimeoutMs = 90000 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mega-adapter-'));
  let socket;
  let options;
  let calls = 0;
  let sendBehavior = async (_jid, _content, opts) => ({ key: { id: opts?.messageId || 'reply-id' }, status: 1 });
  const library = {
    BufferJSON: { replacer: (_key, value) => value, reviver: (_key, value) => value },
    initAuthCreds: () => ({ token: 'a-secret-token', registered: false }),
    proto: { Message: { AppStateSyncKeyData: { fromObject: value => value } } },
    DisconnectReason: { loggedOut: 401, restartRequired: 515, forbidden: 403 },
    generateMessageIDV2: () => `generated-${++calls}`,
    default(config) {
      options = config;
      socket = {
        ev: new EventEmitter(), ws: new EventEmitter(), user: { id: '5511999999999@s.whatsapp.net' },
        end: () => {}, logout: async () => {},
        onWhatsApp: async number => [{ jid: `${number}@s.whatsapp.net`, exists: true }],
        groupFetchAllParticipating: async () => ({ 'a@g.us': { id: 'a@g.us', subject: 'Grupo autorizado' } }),
        sendMessage: (...args) => sendBehavior(...args)
      };
      return socket;
    }
  };
  const safeStorage = testProtection();
  const adapter = new WhatsAppAdapter({
    store: { dir, getGroup: id => id === 'a@g.us' ? { id, authorized: true, simulation: false } : null },
    credentialsDir: dir, safeStorage, loadLibrary: async () => library, runtimePlatform: 'win32', ackTimeoutMs, submissionTimeoutMs, controlTimeoutMs
  });
  t.after(async () => { await adapter.disconnect(); await fs.rm(dir, { recursive: true, force: true }); });
  await adapter.connect();
  socket.ev.emit('connection.update', { connection: 'open' });
  return { adapter, dir, safeStorage, library, get socket() { return socket; }, get options() { return options; }, setSendBehavior(fn) { sendBehavior = fn; } };
}

test('simulação identifica grupos fictícios e oferece falha antes do envio e resultado incerto', async () => {
  const adapter = new SimulatedAdapter({ delayMs: 0 });
  await adapter.connect();
  const groups = await adapter.listGroups();
  assert.equal(groups.length, 15);
  assert.ok(groups.every(group => group.simulation && group.id.endsWith('@simulation')));
  adapter.setNextOutcome('failed');
  await assert.rejects(adapter.send(groups[0].id, { type: 'text', text: 'Teste' }), error => error.safeToRetry === true);
  assert.equal(adapter.sent.length, 0);
  adapter.setNextOutcome('uncertain');
  assert.deepEqual(await adapter.send(groups[0].id, { type: 'text', text: 'Teste', clientMessageId: 'persisted' }), { status: 'uncertain', messageId: 'persisted', mode: 'simulated', simulation: true });
  await assert.rejects(adapter.send('real@g.us', { type: 'text', text: 'Teste' }));
});

test('integração real exige Windows e proteção do sistema operacional', async () => {
  const adapter = new WhatsAppAdapter({ runtimePlatform: 'linux' });
  await assert.rejects(adapter.connect(), /Windows/);
  const unprotected = new WhatsAppAdapter({ runtimePlatform: 'win32', safeStorage: { isEncryptionAvailable: () => false } });
  await assert.rejects(unprotected.connect(), /proteção de credenciais/);
});

test('sessão e chaves ficam cifradas e gravadas atomicamente, sem arquivos de texto de autenticação', async t => {
  const f = await fixture(t);
  await f.options.auth.keys.set({ session: { alice: { token: 'session-secret' } } });
  f.socket.ev.emit('creds.update', { token: 'updated-secret' });
  await f.adapter.authStore.writeChain;
  const entries = await fs.readdir(f.dir);
  assert.deepEqual(entries, ['session.dpapi']);
  const ciphertext = await fs.readFile(path.join(f.dir, 'session.dpapi'));
  assert.equal(ciphertext.includes('updated-secret'), false);
  assert.equal(ciphertext.includes('session-secret'), false);
  const reloaded = new EncryptedAuthStore({ dir: f.dir, safeStorage: f.safeStorage, library: f.library });
  const auth = await reloaded.load();
  assert.equal(auth.creds.token, 'updated-secret');
  assert.equal((await auth.keys.get('session', ['alice'])).alice.token, 'session-secret');
  assert.equal(f.options.enableRecentMessageCache, false);
  assert.equal(f.options.enableAutoSessionRecreation, false);
  assert.equal(f.options.maxMsgRetryCount, 0);
});

test('sendMessage sem ACK retorna incerto; ACK autenticado confirma inclusive após timeout', async t => {
  const f = await fixture(t);
  const receipts = [];
  f.adapter.on('receipt', receipt => receipts.push(receipt));
  assert.deepEqual(await f.adapter.send('a@g.us', { type: 'text', text: 'Olá', clientMessageId: 'uncertain-id' }), { status: 'uncertain', messageId: 'uncertain-id' });
  f.socket.ws.emit('CB:ack,class:message', { attrs: { id: 'uncertain-id', class: 'message' } });
  assert.equal(receipts.at(-1).messageId, 'uncertain-id');
  const result = f.adapter.send('a@g.us', { type: 'text', text: 'Olá', clientMessageId: 'ack-id' });
  f.socket.ws.emit('CB:ack,class:message', { attrs: { id: 'ack-id', class: 'message' } });
  assert.deepEqual(await result, { status: 'confirmed', messageId: 'ack-id' });
});

test('erro após submissão não autoriza retentativa e restrição pausa transporte', async t => {
  const f = await fixture(t);
  f.setSendBehavior(async () => { throw new Error('socket closed after transmission'); });
  assert.equal((await f.adapter.send('a@g.us', { type: 'text', text: 'Teste', clientMessageId: 'ambiguous' })).status, 'uncertain');
  f.setSendBehavior(async (_jid, _content, opts) => ({ key: { id: opts.messageId }, status: 1 }));
  const pending = f.adapter.send('a@g.us', { type: 'text', text: 'Teste', clientMessageId: 'restricted' });
  f.socket.ws.emit('CB:ack,class:message', { attrs: { id: 'restricted', error: '463' } });
  assert.equal((await pending).status, 'uncertain');
  assert.equal(f.adapter.status.state, 'restricted');
  f.socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: {} } });
  assert.equal(f.adapter.status.state, 'restricted');
});

test('desconexão libera envio pendente como incerto sem aguardar um transporte travado', async t => {
  const f = await fixture(t);
  f.setSendBehavior(() => new Promise(() => {}));
  const pending = f.adapter.send('a@g.us', { type: 'text', text: 'Teste', clientMessageId: 'hung-transport' });
  assert.equal(f.adapter.pendingAcks.size, 1);
  await f.adapter.disconnect();
  assert.deepEqual(await pending, { status: 'uncertain', messageId: 'hung-transport' });
  assert.equal(f.adapter.pendingAcks.size, 0);
});

test('tempo de submissão libera resultado incerto sem encerrar outros destinos e reconcilia ACK tardio', async t => {
  const f = await fixture(t, { submissionTimeoutMs: 20 });
  const previous = f.socket;
  let ended = 0;
  previous.end = () => { ended++; };
  f.setSendBehavior(() => new Promise(() => {}));
  assert.deepEqual(await f.adapter.send('a@g.us', { type: 'text', text: 'Teste', clientMessageId: 'submission-timeout' }),
    { status: 'uncertain', messageId: 'submission-timeout' });
  assert.equal(ended, 0);
  assert.equal(f.adapter.status.state, 'connected');
  assert.equal(f.adapter.socket, previous);
  assert.equal(f.adapter.pendingAcks.size, 0);
  let receipts = 0;
  f.adapter.on('receipt', () => { receipts++; });
  previous.ws.emit('CB:ack,class:message', { attrs: { id: 'submission-timeout' } });
  previous.ws.emit('CB:ack,class:message', { attrs: { id: 'submission-timeout' } });
  assert.equal(receipts, 1, 'late acceptance changes evidence once without a second send');
  assert.equal((await f.adapter.reconcile('submission-timeout')).accepted, true);
});

test('reconectar cria outro transporte e preserva a sessão cifrada', async t => {
  const f = await fixture(t);
  f.socket.ev.emit('creds.update', { token: 'saved-token' });
  await f.adapter.authStore.writeChain;
  const previous = f.socket;
  let ended = 0;
  previous.end = () => { ended++; };
  await f.adapter.connect({ reconnect: true });
  assert.notEqual(f.socket, previous);
  assert.equal(ended, 1);
  assert.equal(f.options.auth.creds.token, 'saved-token');
  assert.equal(f.adapter.status.state, 'connecting');
  previous.ev.emit('connection.update', { connection: 'open' });
  assert.equal(f.adapter.status.state, 'connecting');
  f.socket.ev.emit('connection.update', { connection: 'open' });
  assert.equal(f.adapter.status.state, 'connected');
});

test('logout confirmado remove a sessão inválida e aguarda conexão explícita', async t => {
  const f = await fixture(t);
  f.socket.ev.emit('creds.update', { registered: true, token: 'old-session' });
  await f.adapter.authStore.writeChain;
  const previous = f.socket;
  previous.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  await f.adapter.sessionResetPromise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.adapter.status.state, 'disconnected');
  assert.equal(f.adapter.socket, null);
  assert.equal(f.adapter.authStore, null);
  await assert.rejects(fs.access(path.join(f.dir, 'session.dpapi')), error => error.code === 'ENOENT');
  assert.equal(f.socket, previous, 'logout must never pair or reconnect automatically');
  await f.adapter.connect();
  assert.notEqual(f.socket, previous);
  assert.equal(f.options.auth.creds.registered, false);
});

test('sessão cifrada corrompida permanece bloqueada até remoção explícita', async t => {
  const f = await fixture(t);
  await f.adapter.authStore.persist();
  await f.adapter.disconnect();
  const filename = path.join(f.dir, 'session.dpapi');
  const corrupt = Buffer.from('invalid-encrypted-session');
  await fs.writeFile(filename, corrupt);
  await assert.rejects(f.adapter.connect(), /iniciar a integração/);
  assert.equal(f.adapter.status.state, 'disconnected');
  assert.deepEqual(await fs.readFile(filename), corrupt);
  await assert.rejects(f.adapter.connect(), /iniciar a integração/);
  await f.adapter.disconnect({ logout: true });
  await assert.rejects(fs.access(filename), error => error.code === 'ENOENT');
  await f.adapter.connect();
  assert.equal(f.adapter.status.state, 'connecting');
  assert.equal(f.options.auth.creds.registered, false);
});

test('resposta de controle travada tem prazo e encerra transporte sem repetir', async t => {
  const f = await fixture(t, { controlTimeoutMs: 20 });
  let submissions = 0;
  f.setSendBehavior(() => { submissions++; return new Promise(() => {}); });
  await assert.rejects(f.adapter.reply('5511888888888@s.whatsapp.net', 'Resumo'), /resposta de controle/);
  assert.equal(submissions, 1);
  assert.equal(f.adapter.status.state, 'disconnected');
  assert.equal(f.adapter.socket, null);
  await assert.rejects(f.adapter.reply('5511888888888@s.whatsapp.net', 'Resumo'), /desconectado/);
  assert.equal(submissions, 1);
});

test('download atrasado tem prazo e destrói um stream que chega depois sem fornecer mídia', async t => {
  const f = await fixture(t, { controlTimeoutMs: 20 });
  let release;
  f.library.downloadMediaMessage = () => new Promise(resolve => { release = resolve; });
  const context = { type: 'image', raw: { message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 10 } } } };
  await assert.rejects(f.adapter.downloadIncoming(context), /Nenhum conteúdo parcial/);
  const lateStream = new PassThrough();
  release(lateStream);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lateStream.destroyed, true);
  assert.equal(f.adapter.status.state, 'connected');
});

test('download que para após alguns bytes é rejeitado sem retornar conteúdo parcial', async t => {
  const f = await fixture(t, { controlTimeoutMs: 20 });
  const stream = new PassThrough();
  stream.write(Buffer.from('partial'));
  f.library.downloadMediaMessage = async () => stream;
  const context = { type: 'document', raw: { message: { documentMessage: { fileName: 'documento.pdf', mimetype: 'application/pdf', fileLength: 100 } } } };
  await assert.rejects(f.adapter.downloadIncoming(context), /Nenhum conteúdo parcial/);
  assert.equal(stream.destroyed, true);
  f.library.downloadMediaMessage = async () => Readable.from([Buffer.from('complete')]);
  const recovered = await f.adapter.downloadIncoming(context);
  assert.deepEqual(recovered.buffer, Buffer.from('complete'));
});

test('mídia usa bytes verificados da biblioteca e rejeita caminho externo ou conteúdo alterado', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.dir, 'media'));
  const bytes = Buffer.from('document contents');
  const filename = path.join(f.dir, 'media', 'campaign.pdf');
  const outside = path.join(f.dir, 'external.pdf');
  await fs.writeFile(filename, bytes);
  await fs.writeFile(outside, bytes);
  const media = { id: 'media-id', name: 'Anexo.pdf', mime: 'application/pdf', path: filename, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  const item = { type: 'document', caption: 'Legenda com *negrito*', clientMessageId: 'media-ack' };
  let submitted = 0;
  f.setSendBehavior(async (_jid, content, opts) => {
    submitted += 1;
    assert.deepEqual(content.document, bytes);
    assert.equal(content.fileName, 'Anexo.pdf');
    assert.equal(content.caption, item.caption);
    queueMicrotask(() => f.socket.ws.emit('CB:ack,class:message', { attrs: { id: opts.messageId } }));
    return { key: { id: opts.messageId }, status: 1 };
  });
  await assert.rejects(f.adapter.send('a@g.us', item, { ...media, path: outside }), /fora da pasta/);
  await assert.rejects(f.adapter.send('a@g.us', item, { ...media, sha256: 'bad-hash' }), /alterada/);
  assert.equal(submitted, 0);
  assert.equal((await f.adapter.send('a@g.us', item, media)).status, 'confirmed');
  assert.equal(submitted, 1);
});

test('identidade vem do protocolo, LID sem número é rejeitado e histórico/replay não entram', async t => {
  const f = await fixture(t);
  const incoming = [];
  f.adapter.on('incoming', context => incoming.push(context));
  const recent = Math.floor(Date.now() / 1000);
  const message = (id, remoteJid, remoteJidAlt, timestamp = recent, body = { conversation: '!mega status' }) => ({
    key: { id, remoteJid, remoteJidAlt, fromMe: false }, messageTimestamp: timestamp,
    pushName: '5511999999999', message: body
  });
  f.socket.ev.emit('messages.upsert', { type: 'append', messages: [message('history', '5511888888888@s.whatsapp.net')] });
  f.socket.ev.emit('messages.upsert', { type: 'notify', messages: [message('old', '5511888888888@s.whatsapp.net', null, recent - 300)] });
  f.socket.ev.emit('messages.upsert', { type: 'notify', messages: [message('lid-unresolved', '123456@lid')] });
  assert.equal(incoming.at(-1).verified, false);
  assert.equal(incoming.at(-1).senderNumber, '');
  f.socket.ev.emit('messages.upsert', { type: 'notify', messages: [message('lid-verified', '123456@lid', '5511888888888@s.whatsapp.net')] });
  assert.equal(incoming.at(-1).verified, true);
  assert.equal(incoming.at(-1).senderNumber, '5511888888888');
  f.socket.ev.emit('messages.upsert', { type: 'notify', messages: [message('lid-verified', '123456@lid', '5511888888888@s.whatsapp.net')] });
  f.socket.ev.emit('messages.upsert', { type: 'notify', messages: [message('forwarded', '5511888888888@s.whatsapp.net', null, recent, {
    ephemeralMessage: { message: { extendedTextMessage: { text: '!mega parar tudo', contextInfo: { forwardingScore: 1, isForwarded: true } } } }
  })] });
  assert.equal(incoming.length, 3);
  assert.equal(incoming.at(-1).forwarded, true);
});

test('bridge assíncrona de proteção cifra e restaura credenciais antes de criar transporte', async t => {
  const f = await fixture(t);
  const protection = f.safeStorage;
  f.adapter.safeStorage = {
    isEncryptionAvailable: async () => protection.isEncryptionAvailable(),
    encryptString: async value => protection.encryptString(value),
    decryptString: async value => protection.decryptString(Buffer.from(value))
  };
  f.adapter.authStore.safeStorage = f.adapter.safeStorage;
  f.socket.ev.emit('creds.update', { token: 'async-only-secret' });
  await f.adapter.authStore.writeChain;
  const encrypted = await fs.readFile(path.join(f.dir, 'session.dpapi'));
  assert.equal(encrypted.includes(Buffer.from('async-only-secret')), false);
  await f.adapter.connect({ reconnect: true });
  assert.equal(f.options.auth.creds.token, 'async-only-secret');
});

test('alerta privado valida telefone e não mostra confirmado sem ACK autenticado', async t => {
  const f = await fixture(t, { ackTimeoutMs: 15 });
  let calls = 0;
  f.setSendBehavior(async (target, content, opts) => {
    calls++;
    assert.equal(target, '5511888888888@s.whatsapp.net');
    assert.equal(content.text, '🚨 Campanha interrompida por erro');
    assert.equal(opts.messageId, 'private-alert-1');
    return { key: { id: opts.messageId }, status: 1 };
  });
  for (const phone of ['5511888888888@s.whatsapp.net', 'group@g.us', '+5511888888888', '123', '5511888888888 extra']) {
    await assert.rejects(f.adapter.sendPrivate(phone, 'Resumo'), /telefone privado/);
  }
  const result = await f.adapter.sendPrivate('5511888888888', '🚨 Campanha interrompida por erro', { clientMessageId: 'private-alert-1' });
  assert.deepEqual(result, { status: 'uncertain', messageId: 'private-alert-1' });
  assert.equal(calls, 1);
  assert.deepEqual(await f.adapter.sendPrivate('5511888888888', '🚨 Campanha interrompida por erro', { clientMessageId: 'private-alert-1' }), result);
  assert.equal(calls, 1, 'uncertain alert must never be automatically resubmitted');
  f.socket.ws.emit('CB:ack,class:message', { attrs: { id: 'private-alert-1' } });
  assert.equal((await f.adapter.sendPrivate('5511888888888', 'Resumo', { clientMessageId: 'private-alert-1' })).status, 'confirmed');
  assert.equal(calls, 1);
});

test('alertas privados concorrentes compartilham submissão e aguardam confirmação', async t => {
  const f = await fixture(t);
  let calls = 0;
  f.setSendBehavior(async (_target, _content, opts) => { calls++; return { key: { id: opts.messageId }, status: 1 }; });
  const a = f.adapter.sendPrivate('5511888888888', 'Erro original às 10:00', { clientMessageId: 'one-occurrence' });
  const b = f.adapter.sendPrivate('5511888888888', 'Erro original às 10:00', { clientMessageId: 'one-occurrence' });
  await assert.rejects(f.adapter.sendPrivate('5511777777777', 'Outro destinatário', { clientMessageId: 'one-occurrence' }), /outro destino/);
  assert.equal(calls, 1);
  f.socket.ws.emit('CB:ack,class:message', { attrs: { id: 'one-occurrence' } });
  assert.deepEqual(await a, { status: 'confirmed', messageId: 'one-occurrence' });
  assert.deepEqual(await b, await a);
});

test('queda de internet fecha transporte, mantém sessão e marca envio pendente como incerto', async t => {
  const f = await fixture(t);
  await f.adapter.authStore.persist();
  let ended = 0;
  f.socket.end = () => { ended++; };
  f.setSendBehavior(() => new Promise(() => {}));
  const pending = f.adapter.sendPrivate('5511888888888', 'Alerta', { clientMessageId: 'offline-alert' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.adapter.pendingAcks.has('offline-alert'), true, 'a queda ocorre depois da submissão, não durante a consulta do número');
  f.adapter.setNetworkOnline(false);
  assert.equal((await pending).status, 'uncertain');
  assert.equal(ended, 1);
  assert.equal(f.adapter.status.reasonCode, 'internet');
  assert.equal(f.adapter.status.manual, false);
  assert.equal(f.adapter.status.retryable, true);
  assert.equal(f.adapter.status.errorCode, 'NETWORK_OFFLINE');
  assert.ok(Number.isFinite(Date.parse(f.adapter.status.at)));
  await fs.access(path.join(f.dir, 'session.dpapi'));
  await assert.rejects(f.adapter.connect(), /internet/);
  f.adapter.setNetworkOnline(true);
  assert.equal(f.adapter.status.state, 'disconnected', 'network availability must not start an unlimited reconnect loop');
  await f.adapter.connect();
  f.socket.ev.emit('connection.update', { connection: 'open' });
  await f.adapter.disconnect();
  assert.equal(f.adapter.status.reasonCode, 'manual');
  assert.equal(f.adapter.status.retryable, false);
});

test('motivos de sessão expirada, restrição e erro de rede são tipados sem expor segredos', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.adapter._disconnectInfo({ code: 'ENOTFOUND', message: 'token=secret' }).reasonCode, 'internet');
  assert.equal(f.adapter._disconnectInfo({ output: { statusCode: 401 } }).reasonCode, 'session_expired');
  assert.equal(f.adapter._disconnectInfo({ output: { statusCode: 429 } }).retryable, false);
  assert.equal(f.adapter._disconnectInfo({ output: { statusCode: 403 } }).reasonCode, 'restricted');
  const info = f.adapter._disconnectInfo({ message: 'password=secret', code: 'token=secret' });
  assert.equal(info.reasonCode, 'unexpected');
  assert.equal(JSON.stringify(info).includes('secret'), false);
});

test('buffers de simulação têm limite e alerta incerto continua incerto sem novo envio', async () => {
  const adapter = new SimulatedAdapter({ delayMs: 0 });
  await adapter.connect();
  for (let i = 0; i < 1005; i++) await adapter.send(`sim-01@simulation`, { type: 'text', text: `Item ${i}` });
  for (let i = 0; i < 1005; i++) await adapter.reply('5511888888888@s.whatsapp.net', `Resposta ${i}`);
  assert.equal(adapter.sent.length, 1000);
  assert.equal(adapter.replies.length, 1000);
  adapter.setNextOutcome('uncertain');
  const first = await adapter.sendPrivate('5511888888888', 'Alerta', { clientMessageId: 'private-uncertain-sim' });
  assert.equal(first.status, 'uncertain');
  assert.deepEqual(await adapter.sendPrivate('5511888888888', 'Alerta', { clientMessageId: 'private-uncertain-sim' }), first);
  assert.equal(adapter.sent.filter(entry => entry.messageId === 'private-uncertain-sim').length, 1);
});

test('gravação protegida agrupa rajadas e aguarda atualizações que chegam durante a cifra', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mega-auth-batch-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const protection = testProtection();
  const library = { BufferJSON: { replacer: (_key, value) => value, reviver: (_key, value) => value }, initAuthCreds: () => ({ token: 'initial' }), proto: { Message: { AppStateSyncKeyData: { fromObject: value => value } } } };
  let writes = 0, release, entered;
  const active = new Promise(resolve => { entered = resolve; });
  const safeStorage = {
    ...protection,
    encryptString: async value => {
      writes++;
      if (writes === 1) { entered(); await new Promise(resolve => { release = resolve; }); }
      return protection.encryptString(value);
    }
  };
  const auth = new EncryptedAuthStore({ dir, safeStorage, library });
  await auth.load();
  const initial = [];
  for (let i = 0; i < 100; i++) initial.push(auth.updateCreds({ initialIndex: i }));
  await active;
  for (let i = 0; i < 100; i++) initial.push(auth.updateCreds({ finalIndex: i }));
  release();
  await Promise.all(initial);
  assert.equal(writes, 2, '200 concurrent events need only the snapshots before and during the first write');
  const stored = JSON.parse(protection.decryptString(await fs.readFile(path.join(dir, 'session.dpapi'))));
  assert.equal(stored.creds.initialIndex, 99);
  assert.equal(stored.creds.finalIndex, 99);
  assert.equal(auth.persistedVersion, auth.requestedVersion);
  assert.equal(auth.persistPromise, null);
});

test('falha de proteção em uma rajada produz um único evento e encerra a conexão com segurança', async t => {
  const f = await fixture(t);
  const previous = f.socket;
  let stopped = 0;
  previous.end = () => { stopped++; };
  const events = [];
  f.adapter.on('status', value => events.push(value));
  f.safeStorage.encryptString = async () => { throw Object.assign(new Error('permission denied token=secret'), { code: 'EACCES' }); };
  for (let i = 0; i < 50; i++) previous.ev.emit('creds.update', { index: i });
  await f.adapter.authStore.writeChain.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, 1);
  assert.equal(events.filter(value => value.state === 'restricted').length, 1);
  assert.equal(f.adapter.status.errorCode, 'SESSION_PERSISTENCE_FAILED');
  assert.equal(JSON.stringify(events).includes('token=secret'), false);
  assert.equal(f.adapter.socket, null);
});

test('falha tardia do transporte antigo não restringe a nova conexão', async t => {
  const f = await fixture(t);
  let rejectOld;
  f.setSendBehavior(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
  const old = f.adapter.send('a@g.us', { type: 'text', text: 'Antigo', clientMessageId: 'old-generation-id' });
  await f.adapter.disconnect();
  assert.equal((await old).status, 'uncertain');
  await f.adapter.connect();
  f.socket.ev.emit('connection.update', { connection: 'open' });
  rejectOld({ output: { statusCode: 403 } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.adapter.status.state, 'connected');
});

test('resposta privada usa chat recebido autenticado sem USYNC e rejeita contexto fabricado', async t => {
  const f = await fixture(t);
  const pn = '5562998887777';
  let lookups = 0, sends = 0, incoming;
  f.socket.onWhatsApp = async () => { lookups++; throw new Error('lookup unavailable despite inbound chat'); };
  f.adapter.on('incoming', context => { incoming = context; });
  f.setSendBehavior(async (jid, _content, options) => { sends++; assert.equal(jid, `${pn}@s.whatsapp.net`); return { key: { id: options.messageId }, status: 2 }; });
  f.socket.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: 'PRIVATE_PN_COMMAND', remoteJid: `${pn}:5@s.whatsapp.net`, fromMe: false }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: '!busca iPhone 15 Pro Max 256GB' } }] });
  assert.equal(incoming.chatId, `${pn}@s.whatsapp.net`);
  assert.equal(incoming.senderNumber, pn);
  assert(incoming.replyProof);
  const context = { chatId: incoming.chatId, senderNumber: incoming.senderNumber, senderId: incoming.senderId, isGroup: false, replyProof: incoming.replyProof };
  const resolved = await f.adapter.resolveSearchRecipient(pn, context);
  assert.equal(resolved.resolutionSource, 'authenticated-private-message');
  const result = await f.adapter.sendSearchText(resolved.jid, 'Nenhuma oferta compatível.', { clientMessageId: 'REPLY_PRIVATE_PN', replyContext: context });
  assert.equal(result.status, 'confirmed'); assert.equal(lookups, 0); assert.equal(sends, 1);
  assert.equal((await f.adapter.resolveRecipient(pn)).jid, resolved.jid);
  await assert.rejects(f.adapter.resolveReplyRecipient({ ...context, replyProof: null }), error => error.code === 'WA_REPLY_CONTEXT_INVALID');
  await assert.rejects(f.adapter.resolveReplyRecipient({ ...context, senderNumber: '5562998880000' }), error => error.code === 'WA_REPLY_CONTEXT_INVALID');
  await assert.rejects(f.adapter.sendSearchText('5562998880000', 'Proibido', { replyContext: context }), error => error.code === 'WA_REPLY_RECIPIENT_MISMATCH');
  assert.equal(sends, 1);
});

test('chat privado LID usa PN alternativo autenticado e mantém o JID original na resposta', async t => {
  const f = await fixture(t);
  const pn = '5562998887777', lid = '8123456789@lid';
  let incoming, sends = 0;
  f.socket.onWhatsApp = async () => { throw new Error('must not query a known private chat'); };
  f.adapter.on('incoming', value => { incoming = value; });
  f.setSendBehavior(async (jid, _text, options) => { sends++; assert.equal(jid, lid); return { key: { id: options.messageId }, status: 2 }; });
  f.socket.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: 'LID_PRIVATE_COMMAND', remoteJid: lid, remoteJidAlt: `${pn}@s.whatsapp.net`, fromMe: false }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: '!busca' } }] });
  assert.equal(incoming.senderNumber, pn); assert.equal(incoming.senderId, lid);
  const recipient = await f.adapter.resolveSearchRecipient(pn, incoming);
  assert.equal(recipient.jid, lid);
  assert.equal((await f.adapter.sendSearchText(lid, 'Como pesquisar: !busca iPhone 15 128GB', { replyContext: incoming, clientMessageId: 'LID_PRIVATE_REPLY' })).status, 'confirmed');
  assert.equal(sends, 1);
});

test('LID sem telefone no evento consulta mapeamento autenticado antes da autorização, sem número fictício', async t => {
  const f = await fixture(t);
  const pn = '5562998887777', lid = '8234567890@lid';
  let incoming, mappings = 0;
  f.socket.signalRepository = { lidMapping: { getPNForLID: async id => { mappings++; assert.equal(id, lid); return `${pn}@s.whatsapp.net`; } } };
  f.adapter.on('incoming', context => { incoming = context; });
  const message = { key: { id: 'PRIVATE_MAPPING_COMMAND', remoteJid: lid, fromMe: false }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: '!mega status' } };
  f.socket.ev.emit('messages.upsert', { type: 'notify', messages: [message] });
  f.socket.ev.emit('messages.upsert', { type: 'notify', messages: [message] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mappings, 1); assert.equal(incoming.senderNumber, pn); assert.equal(incoming.verified, true);
  assert.equal((await f.adapter.resolveReplyRecipient(incoming)).jid, lid);
  f.socket.signalRepository.lidMapping.getPNForLID = async () => undefined;
  f.socket.ev.emit('messages.upsert', { type: 'notify', messages: [{ ...message, key: { ...message.key, id: 'MAPPING_UNAVAILABLE', remoteJid: '9999999999@lid' } }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(incoming.senderNumber, ''); assert.equal(incoming.verified, false);
  assert.equal((await f.adapter.resolveReplyRecipient(incoming)).phone, '');
});

test('prova da conversa privada persiste protegida na sessão e resiste a reinício sem confiar em chamadas externas', async t => {
  const f = await fixture(t);
  let incoming;
  f.adapter.on('incoming', value => { incoming = value; });
  f.socket.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: 'PERSISTED_PRIVATE_COMMAND', remoteJid: '5562998887777@s.whatsapp.net', fromMe: false }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: '!busca iphone' } }] });
  const secret = f.adapter.replyProofKey.toString('hex');
  assert.equal((await fs.readFile(path.join(f.dir, 'session.dpapi'))).includes(secret), false);
  await f.adapter.disconnect();
  const restarted = new WhatsAppAdapter({ store: f.adapter.store, credentialsDir: f.dir, safeStorage: f.safeStorage, loadLibrary: async () => f.library, runtimePlatform: 'win32' });
  t.after(() => restarted.disconnect());
  await restarted.connect(); f.socket.ev.emit('connection.update', { connection: 'open' });
  assert.equal((await restarted.resolveReplyRecipient(incoming)).jid, incoming.chatId);
  f.socket.user = { id: '5562998880000@s.whatsapp.net' };
  await assert.rejects(restarted.resolveReplyRecipient(incoming), error => error.code === 'WA_REPLY_CONTEXT_INVALID');
});

test('resposta administrativa com prova usa confirmação da integração e eco automático é identificado', async t => {
  const f = await fixture(t);
  let incoming;
  f.adapter.on('incoming', value => { incoming = value; });
  f.setSendBehavior(async (_jid, _text, options) => ({ key: { id: options.messageId }, status: 2 }));
  f.socket.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: 'ADMIN_PRIVATE_COMMAND', remoteJid: '5562998887777@s.whatsapp.net', fromMe: false }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: '!mega menu' } }] });
  const result = await f.adapter.reply(incoming.chatId, 'Menu administrativo', { replyContext: incoming, clientMessageId: 'ADMIN_REPLY' });
  assert.equal(result.status, 'confirmed');
  f.socket.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: result.messageId, remoteJid: '5562998887777@s.whatsapp.net', fromMe: true }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: '!mega menu' } }] });
  assert.equal(incoming.automaticMessage, true);
  assert.equal(incoming.senderNumber, '5511999999999');
});

test('identificação privada factual sobrevive à reconexão e reinício protegidos sem depender de USYNC', async t => {
  const f = await fixture(t);
  const pn = '5562998887777', lid = '8987654321@lid';
  f.socket.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: 'RECIPIENT_HINT_RECEIVED', remoteJid: lid, remoteJidAlt: pn + '@s.whatsapp.net', fromMe: false }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: 'Olá' } }] });
  await f.adapter.authStore.writeChain;
  await f.adapter.disconnect();
  await f.adapter.connect(); f.socket.ev.emit('connection.update', { connection: 'open' });
  f.socket.onWhatsApp = async () => { throw new Error('must not query known recipient after reconnect'); };
  assert.equal((await f.adapter.resolveRecipient(pn)).jid, lid);
  await f.adapter.disconnect();
  const restarted = new WhatsAppAdapter({ store: f.adapter.store, credentialsDir: f.dir, safeStorage: f.safeStorage, loadLibrary: async () => f.library, runtimePlatform: 'win32' });
  t.after(() => restarted.disconnect());
  await restarted.connect(); f.socket.ev.emit('connection.update', { connection: 'open' });
  f.socket.onWhatsApp = async () => { throw new Error('must not query known recipient after restart'); };
  assert.equal((await restarted.resolveRecipient(pn)).jid, lid);
  restarted.protocolRecipientHints.get(pn).receivedAt = Date.now() - 8 * 86400000;
  await assert.rejects(restarted.resolveRecipient(pn), error => error.code === 'WA_RECIPIENT_LOOKUP_TEMPORARY');
  restarted.protocolRecipientHints.get(pn).receivedAt = Date.now();
  f.socket.user = { id: '5562998880000@s.whatsapp.net' };
  await assert.rejects(restarted.resolveRecipient(pn), error => error.code === 'WA_RECIPIENT_LOOKUP_TEMPORARY');
});
