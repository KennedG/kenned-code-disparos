'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');

const AUTH_FILE = 'session.dpapi';
const ACK_TIMEOUT_MS = 20000;
const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['text', 'image', 'video', 'document']);

function definitiveError(message, safeToRetry = false) {
  return Object.assign(new Error(message), { safeToRetry });
}

function unwrapMessage(message) {
  let value = message || {};
  for (let depth = 0; depth < 10; depth += 1) {
    const wrapper = value.ephemeralMessage || value.viewOnceMessage || value.viewOnceMessageV2 || value.viewOnceMessageV2Extension || value.documentWithCaptionMessage;
    if (!wrapper?.message) return value;
    value = wrapper.message;
  }
  return value;
}

function hasForwardedMetadata(message) {
  const stack = [message];
  const visited = new Set();
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || visited.has(value)) continue;
    visited.add(value);
    if (value.contextInfo?.isForwarded === true || Number(value.contextInfo?.forwardingScore) > 0) return true;
    for (const child of Object.values(value)) if (child && typeof child === 'object') stack.push(child);
  }
  return false;
}

function phoneFromJid(jid) {
  if (typeof jid !== 'string' || !jid.endsWith('@s.whatsapp.net')) return null;
  const digits = jid.split('@')[0].split(':')[0];
  return /^\d{8,15}$/.test(digits) ? digits : null;
}

function messageTimestamp(value) {
  const seconds = typeof value?.toNumber === 'function' ? value.toNumber() : Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

/** Serialized auth state is encrypted by Windows DPAPI; plaintext auth files are never created. */
class EncryptedAuthStore {
  constructor({ dir, safeStorage, library }) {
    this.dir = dir;
    this.safeStorage = safeStorage;
    this.library = library;
    this.data = null;
    this.writeChain = Promise.resolve();
  }

  async load() {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      const ciphertext = await fs.readFile(path.join(this.dir, AUTH_FILE));
      this.data = JSON.parse(this.safeStorage.decryptString(ciphertext), this.library.BufferJSON.reviver);
      if (!this.data?.creds || !this.data?.keys) throw new Error('invalid');
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Não foi possível abrir a sessão protegida. Desconecte a conta para criar uma nova sessão.');
      this.data = { creds: this.library.initAuthCreds(), keys: {} };
    }
    return {
      creds: this.data.creds,
      keys: {
        get: async (type, ids) => {
          const result = {};
          for (const id of ids) {
            let value = this.data.keys[type]?.[id];
            if (value && type === 'app-state-sync-key') value = this.library.proto.Message.AppStateSyncKeyData.fromObject(value);
            if (value) result[id] = value;
          }
          return result;
        },
        set: async updates => {
          for (const [type, entries] of Object.entries(updates)) {
            this.data.keys[type] ||= {};
            for (const [id, value] of Object.entries(entries)) {
              if (value == null) delete this.data.keys[type][id];
              else this.data.keys[type][id] = value;
            }
          }
          await this.persist();
        }
      }
    };
  }

  updateCreds(update) {
    Object.assign(this.data.creds, update);
    return this.persist();
  }

  persist() {
    const operation = this.writeChain.catch(() => {}).then(async () => {
      const plaintext = JSON.stringify(this.data, this.library.BufferJSON.replacer);
      const encrypted = this.safeStorage.encryptString(plaintext);
      const temporary = path.join(this.dir, `.session-${randomBytes(8).toString('hex')}.tmp`);
      let handle;
      try {
        handle = await fs.open(temporary, 'wx', 0o600);
        await handle.writeFile(encrypted);
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(temporary, path.join(this.dir, AUTH_FILE));
      } finally {
        if (handle) await handle.close().catch(() => {});
        await fs.unlink(temporary).catch(() => {});
      }
    });
    this.writeChain = operation;
    return operation;
  }

  async clear() {
    await this.writeChain.catch(() => {});
    await fs.unlink(path.join(this.dir, AUTH_FILE)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    this.data = null;
  }
}

class WhatsAppAdapter extends EventEmitter {
  constructor({ store, credentialsDir, safeStorage, ackTimeoutMs = ACK_TIMEOUT_MS, loadLibrary, runtimePlatform = process.platform } = {}) {
    super();
    this.store = store;
    this.credentialsDir = credentialsDir;
    this.safeStorage = safeStorage;
    this.ackTimeoutMs = ackTimeoutMs;
    this.loadLibrary = loadLibrary || (() => import('@whiskeysockets/baileys'));
    this.runtimePlatform = runtimePlatform;
    this.status = { state: 'disconnected', mode: 'whatsapp', detail: 'WhatsApp desconectado. Integração Baileys não oficial.' };
    this.socket = null;
    this.library = null;
    this.authStore = null;
    this.logger = null;
    this.connectPromise = null;
    this.generation = 0;
    this.pendingAcks = new Map();
    this.receipts = new Map();
    this.seenIncoming = new Map();
    this.connectStartedAt = 0;
    this.requestedDisconnect = false;
    this.restartCount = 0;
  }

  _status(state, detail, extras = {}) {
    this.status = { state, mode: 'whatsapp', detail, ...extras };
    this.emit('status', this.status);
  }

  _ensureProtection() {
    if (this.runtimePlatform !== 'win32') throw new Error('A conexão real está disponível no aplicativo Windows; nesta plataforma, use a simulação.');
    if (!this.safeStorage?.isEncryptionAvailable()) throw new Error('A proteção de credenciais do Windows não está disponível. A conexão foi bloqueada.');
    if (!this.credentialsDir) throw new Error('Pasta protegida da sessão não configurada.');
  }

  async connect() {
    if (this.status.state === 'connected') return this.status;
    if (this.connectPromise) return this.connectPromise;
    this.requestedDisconnect = false;
    this.restartCount = 0;
    this.connectPromise = this._connect().finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }

  async _connect() {
    this._ensureProtection();
    this._status('connecting', 'Preparando a conexão não oficial com o WhatsApp…');
    const generation = ++this.generation;
    this.connectStartedAt = Date.now();
    try {
      if (this.socket) this.socket.end(new Error('Reconexão solicitada.'));
      this.library ||= await this.loadLibrary();
      this.logger ||= require('pino')({ level: 'silent' });
      this.authStore ||= new EncryptedAuthStore({ dir: this.credentialsDir, safeStorage: this.safeStorage, library: this.library });
      const auth = await this.authStore.load();
      if (generation !== this.generation || this.requestedDisconnect) return this.status;
      const makeSocket = this.library.default || this.library.makeWASocket;
      const socket = makeSocket({
        auth,
        logger: this.logger,
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        shouldSyncHistoryMessage: () => false,
        getMessage: async () => undefined,
        enableRecentMessageCache: false,
        enableAutoSessionRecreation: false,
        maxMsgRetryCount: 0,
        browser: this.library.Browsers?.windows?.('Mega Disparos') || ['Mega Disparos', 'Chrome', '1.0.0'],
        connectTimeoutMs: 30000,
        defaultQueryTimeoutMs: 30000,
        keepAliveIntervalMs: 30000
      });
      this.socket = socket;
      socket.ev.on('creds.update', update => {
        if (generation !== this.generation) return;
        this.authStore.updateCreds(update).catch(() => {
          this._status('restricted', 'Falha ao proteger a sessão no Windows. Envios pausados.');
          socket.end(new Error('Não foi possível salvar a sessão protegida.'));
        });
      });
      socket.ev.on('connection.update', update => {
        this._connectionUpdate(update, socket, generation).catch(() => {
          if (generation === this.generation) this._status('disconnected', 'Falha ao atualizar a conexão. Tente reconectar.');
        });
      });
      socket.ev.on('messages.upsert', event => this._incoming(event, generation));
      socket.ev.on('messages.update', updates => {
        if (generation !== this.generation) return;
        for (const event of updates || []) {
          if (Number(event.update?.status) >= 2 && (event.key?.fromMe || this.pendingAcks.has(event.key?.id))) this._ack(event.key.id);
          if (Number(event.update?.status) === 0 && event.key?.fromMe) {
            if ((event.update?.messageStubParameters || []).some(value => ['403', '429', '463'].includes(String(value)))) this._restrict(socket);
            this._uncertain(event.key.id);
          }
        }
      });
      socket.ev.on('message-receipt.update', updates => {
        if (generation !== this.generation) return;
        for (const event of updates || []) {
          if (event.key?.fromMe && (event.receipt?.receiptTimestamp || event.receipt?.readTimestamp || event.receipt?.playedTimestamp)) this._ack(event.key.id);
        }
      });
      // rc14 emits group delivery receipts but no high-level successful server ACK.
      // Listen to the authenticated protocol ACK; never treat sendMessage resolution as confirmation.
      const protocolAck = node => {
        if (generation !== this.generation || !node?.attrs?.id) return;
        if (node.attrs.error) {
          if (['403', '429', '463'].includes(String(node.attrs.error))) this._restrict(socket);
          this._uncertain(node.attrs.id);
        } else this._ack(node.attrs.id);
      };
      if (socket.ws?.prependListener) socket.ws.prependListener('CB:ack,class:message', protocolAck);
      else socket.ws?.on('CB:ack,class:message', protocolAck);
      return this.status;
    } catch (error) {
      if (generation === this.generation) this._status('disconnected', 'Não foi possível conectar. Verifique a internet, a instalação e a sessão protegida.');
      throw definitiveError(error.message === 'A proteção de credenciais do Windows não está disponível. A conexão foi bloqueada.' ? error.message : 'Não foi possível iniciar a integração com o WhatsApp. Verifique a internet ou reconecte a conta.');
    }
  }

  async _connectionUpdate(update, socket, generation) {
    if (generation !== this.generation) return;
    if (update.qr) {
      const qr = await require('qrcode').toDataURL(update.qr, { errorCorrectionLevel: 'M', margin: 2, width: 300 });
      if (generation === this.generation) this._status('connecting', 'No WhatsApp, abra Aparelhos conectados e leia o QR Code. Integração não oficial.', { qr });
    }
    if (update.connection === 'open') {
      this.restartCount = 0;
      this._status('connected', 'WhatsApp conectado por Baileys, integração não oficial. Use apenas grupos autorizados.');
    }
    if (update.connection !== 'close') return;
    this.socket = null;
    this._resolveAllPending();
    const code = update.lastDisconnect?.error?.output?.statusCode || update.lastDisconnect?.error?.statusCode;
    const reasons = this.library.DisconnectReason || {};
    if (this.status.state === 'restricted' || code === 403 || code === 429 || (reasons.forbidden && code === reasons.forbidden)) {
      this._status('restricted', 'O WhatsApp restringiu a conexão. Todos os envios estão pausados; respeite a restrição.');
    } else if (code === reasons.loggedOut || code === 401) {
      this._status('disconnected', 'A conta foi desconectada pelo WhatsApp. Conecte novamente pelo QR Code.');
    } else {
      this._status('disconnected', this.requestedDisconnect ? 'WhatsApp desconectado.' : 'Conexão interrompida. Envios pausados; reconecte para continuar.');
    }
    // Pairing requires one transport restart. This never retries a submitted campaign item.
    if (!this.requestedDisconnect && code === (reasons.restartRequired || 515) && this.restartCount < 2) {
      this.restartCount += 1;
      await this.authStore.writeChain.catch(() => {});
      if (generation === this.generation && !this.requestedDisconnect) await this._connect();
    }
  }

  async disconnect({ logout = false } = {}) {
    this.requestedDisconnect = true;
    this.generation += 1;
    const socket = this.socket;
    this.socket = null;
    this._resolveAllPending();
    let logoutFailed = false;
    try {
      if (logout && socket) await socket.logout();
    } catch { logoutFailed = true; }
    finally {
      socket?.end(new Error('Desconexão solicitada pelo usuário.'));
      if (logout) {
        if (this.authStore) await this.authStore.clear();
        else if (this.credentialsDir) await fs.unlink(path.join(this.credentialsDir, AUTH_FILE)).catch(error => { if (error.code !== 'ENOENT') throw error; });
        this.authStore = null;
      } else if (this.authStore) await this.authStore.writeChain.catch(() => {});
      this._status('disconnected', logout ? (logoutFailed ? 'Sessão local removida. Remova também o aparelho nas configurações do WhatsApp.' : 'Conta desconectada e sessão local removida.') : 'WhatsApp desconectado. A sessão permanece protegida para reconexão.');
    }
  }

  async listGroups() {
    if (this.status.state !== 'connected' || !this.socket) throw definitiveError('Conecte o WhatsApp antes de carregar os grupos.', true);
    const groups = await this.socket.groupFetchAllParticipating();
    return Object.values(groups || {}).filter(group => typeof group.id === 'string' && group.id.endsWith('@g.us')).map(group => ({
      id: group.id,
      name: group.subject || group.id,
      authorized: false,
      simulation: false
    }));
  }

  _ack(messageId) {
    if (!messageId) return;
    this.receipts.set(messageId, Date.now());
    while (this.receipts.size > 1000) this.receipts.delete(this.receipts.keys().next().value);
    const pending = this.pendingAcks.get(messageId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingAcks.delete(messageId);
      pending.resolve({ status: 'confirmed', messageId });
    }
    this.emit('receipt', { messageId, status: 'confirmed' });
  }

  _resolveAllPending() {
    for (const [messageId, pending] of this.pendingAcks) {
      clearTimeout(pending.timer);
      pending.resolve({ status: 'uncertain', messageId });
    }
    this.pendingAcks.clear();
  }

  _uncertain(messageId) {
    const pending = this.pendingAcks.get(messageId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingAcks.delete(messageId);
    pending.resolve({ status: 'uncertain', messageId });
  }

  _restrict(socket) {
    this._status('restricted', 'O WhatsApp restringiu o envio. Campanhas pausadas; respeite os limites da integração.');
    this._resolveAllPending();
    socket?.end(new Error('Restrição do WhatsApp: conexão pausada.'));
  }

  async send(groupId, item, media) {
    if (this.status.state !== 'connected' || !this.socket) throw definitiveError('WhatsApp desconectado. Envios pausados.', true);
    if (typeof groupId !== 'string' || !groupId.endsWith('@g.us')) throw definitiveError('O destino precisa ser um grupo do WhatsApp.');
    if (!ALLOWED_TYPES.has(item?.type)) throw definitiveError('Tipo de conteúdo não suportado.');
    const group = this.store?.getGroup(groupId);
    if (!group || !group.authorized || group.simulation) throw definitiveError('O grupo não tem autorização registrada para envio real.');
    let content;
    if (item.type === 'text') {
      if (!String(item.text || '').trim()) throw definitiveError('O texto da mensagem está vazio.');
      content = { text: String(item.text) };
    } else {
      if (!media?.path) throw definitiveError('Mídia não encontrada na pasta gerenciada.');
      let stat, filename, libraryDirectory;
      try {
        libraryDirectory = await fs.realpath(path.join(this.store.dir, 'media'));
        filename = await fs.realpath(media.path);
        stat = await fs.stat(filename);
      } catch { throw definitiveError('O arquivo da biblioteca não está disponível.'); }
      if (!filename.startsWith(libraryDirectory + path.sep)) throw definitiveError('O arquivo está fora da pasta gerenciada.');
      if (!stat.isFile()) throw definitiveError('O arquivo da biblioteca não é válido.');
      if (!stat.size || stat.size > MAX_MEDIA_BYTES) throw definitiveError('A mídia precisa ter entre 1 byte e 64 MB.');
      let bytes;
      try { bytes = await fs.readFile(filename); } catch { throw definitiveError('Não foi possível ler a mídia gerenciada.'); }
      if (!media.sha256 || createHash('sha256').update(bytes).digest('hex') !== media.sha256) throw definitiveError('A mídia foi alterada na pasta gerenciada. Importe o arquivo novamente.');
      // Send the verified bytes, avoiding a second path read between verification and upload.
      content = { [item.type]: bytes, mimetype: media.mime || 'application/octet-stream' };
      if (item.caption) content.caption = String(item.caption);
      if (item.type === 'document') content.fileName = media.name || path.basename(media.path);
    }
    if (this.status.state !== 'connected' || !this.socket) throw definitiveError('WhatsApp desconectado antes da submissão. Envios pausados.', true);
    const messageId = item.clientMessageId || this.library.generateMessageIDV2?.(this.socket.user?.id) || randomBytes(16).toString('hex').toUpperCase();
    const socket = this.socket;
    // Register before submitting so even an immediate server ACK cannot be lost.
    const resultPromise = new Promise(resolve => {
      this.pendingAcks.set(messageId, { resolve, timer: null });
    });
    const sent = message => {
      if (Number(message?.status) >= 2 || this.receipts.has(messageId)) this._ack(messageId);
      const pending = this.pendingAcks.get(messageId);
      if (pending) pending.timer = setTimeout(() => this._uncertain(messageId), this.ackTimeoutMs);
    };
    const failed = error => {
      const code = error?.output?.statusCode || error?.statusCode;
      if (code === 429 || code === 403 || code === 463) this._restrict(socket);
      // A transport exception after submission cannot prove the server did not accept the item.
      this._uncertain(messageId);
    };
    try { Promise.resolve(socket.sendMessage(groupId, content, { messageId })).then(sent, failed); }
    catch (error) { failed(error); }
    return resultPromise;
  }

  _incoming(event, generation) {
    if (generation !== this.generation || event?.type !== 'notify') return;
    const now = Date.now();
    for (const message of event.messages || []) {
      const key = message.key || {};
      const timestamp = messageTimestamp(message.messageTimestamp);
      if (!key.id || !timestamp || timestamp < Math.max(this.connectStartedAt - 5000, now - 120000) || timestamp > now + 30000 || this.seenIncoming.has(key.id)) continue;
      this.seenIncoming.set(key.id, now);
      while (this.seenIncoming.size > 2000) this.seenIncoming.delete(this.seenIncoming.keys().next().value);
      const chatId = key.remoteJid;
      const isGroup = typeof chatId === 'string' && chatId.endsWith('@g.us');
      const senderJid = isGroup ? key.participant : chatId;
      const senderAlt = isGroup ? key.participantAlt : key.remoteJidAlt;
      const directPhone = phoneFromJid(senderJid);
      const alternatePhone = phoneFromJid(senderAlt);
      const isLid = typeof senderJid === 'string' && senderJid.endsWith('@lid');
      const senderNumber = directPhone || (isLid ? alternatePhone : null);
      const verified = Boolean(senderNumber) && (!directPhone || !alternatePhone || directPhone === alternatePhone);
      const body = unwrapMessage(message.message);
      let type;
      let text = '';
      if (typeof body.conversation === 'string') { type = 'text'; text = body.conversation; }
      else if (body.extendedTextMessage) { type = 'text'; text = body.extendedTextMessage.text || ''; }
      else if (body.imageMessage) { type = 'image'; text = body.imageMessage.caption || ''; }
      else if (body.videoMessage) { type = 'video'; text = body.videoMessage.caption || ''; }
      else if (body.documentMessage) { type = 'document'; text = body.documentMessage.caption || ''; }
      else continue;
      this.emit('incoming', {
        messageId: key.id,
        senderNumber: senderNumber || '',
        verified,
        isGroup,
        forwarded: hasForwardedMetadata(message.message),
        fromMe: key.fromMe === true,
        chatId,
        text,
        type,
        raw: message,
        timestamp
      });
    }
  }

  async reply(chatId, text) {
    if (this.status.state !== 'connected' || !this.socket) throw definitiveError('WhatsApp desconectado.', true);
    if (typeof chatId !== 'string' || (!phoneFromJid(chatId) && !/^\d+@lid$/.test(chatId))) throw definitiveError('Conversa de controle inválida.');
    const result = await this.socket.sendMessage(chatId, { text: String(text) });
    return { messageId: result?.key?.id };
  }

  async downloadIncoming(context) {
    if (!this.socket || !context?.raw || !['image', 'video', 'document'].includes(context.type)) throw definitiveError('Mídia de controle inválida.');
    const body = unwrapMessage(context.raw.message);
    const metadata = body[`${context.type}Message`];
    if (!metadata) throw definitiveError('Anexo não encontrado.');
    const declaredSize = typeof metadata.fileLength?.toNumber === 'function' ? metadata.fileLength.toNumber() : Number(metadata.fileLength || 0);
    if (declaredSize > MAX_MEDIA_BYTES) throw definitiveError('O anexo excede o limite local de 64 MB.');
    const stream = await this.library.downloadMediaMessage(context.raw, 'stream', {}, { logger: this.logger, reuploadRequest: this.socket.updateMediaMessage });
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > MAX_MEDIA_BYTES) throw definitiveError('O anexo excede o limite local de 64 MB.');
        chunks.push(Buffer.from(chunk));
      }
    } finally { stream.destroy?.(); }
    const buffer = Buffer.concat(chunks, size);
    const extension = context.type === 'image' ? '.jpg' : context.type === 'video' ? '.mp4' : '';
    return { buffer, name: metadata.fileName || `anexo-${Date.now()}${extension}`, mime: metadata.mimetype || 'application/octet-stream', type: context.type };
  }
}

module.exports = { WhatsAppAdapter, EncryptedAuthStore, phoneFromJid, hasForwardedMetadata, unwrapMessage };
