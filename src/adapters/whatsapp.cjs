'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, createHash, createHmac, timingSafeEqual } = require('node:crypto');

const AUTH_FILE = 'session.dpapi';
const ACK_TIMEOUT_MS = 20000;
const SUBMISSION_TIMEOUT_MS = 90000;
const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['text', 'image', 'video', 'document']);

function definitiveError(message, safeToRetry = false, code = safeToRetry ? 'WA_PRE_SUBMISSION_TEMPORARY' : 'WA_VALIDATION') {
  return Object.assign(new Error(message), { safeToRetry, temporary: safeToRetry, definitive: !safeToRetry, code });
}

function unwrapMessage(message) {
  let value = message || {};
  for (let depth = 0; depth < 10; depth += 1) {
    const wrapper = value.ephemeralMessage || value.viewOnceMessage || value.viewOnceMessageV2 || value.viewOnceMessageV2Extension || value.documentWithCaptionMessage || value.associatedChildMessage;
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

function accountJid(value) {
  if (typeof value !== 'string' || value.length > 160 || !/^\d+(?::\d+)?@(s\.whatsapp\.net|lid)$/.test(value)) return '';
  return value.replace(/:\d+(?=@)/, '');
}

function messageContent(message, { edits = false } = {}) {
  let body = unwrapMessage(message);
  if (edits && body.editedMessage?.message) body = unwrapMessage(body.editedMessage.message);
  if (typeof body.conversation === 'string') return { type: 'text', text: body.conversation };
  if (body.extendedTextMessage) return { type: 'text', text: body.extendedTextMessage.text || '' };
  for (const type of ['image', 'video', 'document']) if (body[`${type}Message`]) return { type, text: body[`${type}Message`].caption || '' };
  return null;
}

// A quote is a reference, never proof of its author's identity. Consumers must
// match this ID to a stored origin in this same chat and authenticate the
// current sender before changing the original request.
function quotedReference(message, chatId) {
  const info = unwrapMessage(message)?.extendedTextMessage?.contextInfo;
  const id = info?.stanzaId;
  if (typeof id !== 'string' || !id.trim() || id.length > 512 ||
      info.remoteJid && info.remoteJid !== chatId) return {};
  return { quotedMessageId: id, quotedChatId: chatId };
}

/** Serialized auth state is encrypted by Windows DPAPI; plaintext auth files are never created. */
class EncryptedAuthStore {
  constructor({ dir, safeStorage, library }) {
    this.dir = dir;
    this.safeStorage = safeStorage;
    this.library = library;
    this.data = null;
    this.writeChain = Promise.resolve();
    this.persistPromise = null;
    this.requestedVersion = 0;
    this.persistedVersion = 0;
  }

  async load() {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      const ciphertext = await fs.readFile(path.join(this.dir, AUTH_FILE));
      this.data = JSON.parse(await this.safeStorage.decryptString(ciphertext), this.library.BufferJSON.reviver);
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
    this.requestedVersion++;
    if (this.persistPromise) return this.persistPromise;
    const operation = this.writeChain.catch(() => {}).then(async () => {
      // Coalesce bursts of key/credential events. Do not release any caller until every
      // update received during the write has reached the encrypted, atomically replaced file.
      try {
        do {
          const version = this.requestedVersion;
          const plaintext = JSON.stringify(this.data, this.library.BufferJSON.replacer);
          const encrypted = await this.safeStorage.encryptString(plaintext);
          const temporary = path.join(this.dir, `.session-${randomBytes(8).toString('hex')}.tmp`);
          let handle;
          try {
            handle = await fs.open(temporary, 'wx', 0o600);
            await handle.writeFile(encrypted);
            await handle.sync();
            await handle.close();
            handle = null;
            await fs.rename(temporary, path.join(this.dir, AUTH_FILE));
            this.persistedVersion = version;
          } finally {
            if (handle) await handle.close().catch(() => {});
            await fs.unlink(temporary).catch(() => {});
          }
        } while (this.persistedVersion < this.requestedVersion);
      } finally {
        // Clear synchronously inside the operation so a newly arriving request cannot
        // attach to an already completed write before an outer promise.finally runs.
        this.persistPromise = null;
      }
    });
    this.persistPromise = operation;
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
  constructor({ store, credentialsDir, safeStorage, ackTimeoutMs = ACK_TIMEOUT_MS, submissionTimeoutMs = SUBMISSION_TIMEOUT_MS, controlTimeoutMs = SUBMISSION_TIMEOUT_MS, loadLibrary, runtimePlatform = process.platform } = {}) {
    super();
    this.store = store;
    this.credentialsDir = credentialsDir;
    this.safeStorage = safeStorage;
    this.ackTimeoutMs = ackTimeoutMs;
    this.submissionTimeoutMs = submissionTimeoutMs;
    this.controlTimeoutMs = controlTimeoutMs;
    this.loadLibrary = loadLibrary || (() => import('@whiskeysockets/baileys'));
    this.runtimePlatform = runtimePlatform;
    this.status = { state: 'disconnected', mode: 'whatsapp', detail: 'WhatsApp desconectado. Integração Baileys não oficial.' };
    this.socket = null;
    this.library = null;
    this.authStore = null;
    this.logger = null;
    this.connectPromise = null;
    this.sessionResetPromise = null;
    this.generation = 0;
    this.pendingAcks = new Map();
    this.receipts = new Map();
    this.submittedOutcomes = new Map();
    this.seenIncoming = new Map();
    this.connectStartedAt = 0;
    this.requestedDisconnect = false;
    this.restartCount = 0;
    this.networkAvailable = true;
    this.searchCapture = { enabled: false, importHistory: false, groupIds: null, commandGroupIds: null };
    this.seenOffers = new Map();
    this.contacts = new Map();
    this.knownSearchGroups = new Set();
    this.captureHistoryChain = Promise.resolve();
    this.captureHistoryQueued = 0;
    this.automaticMessages = new Set();
    this.recipientCache = new Map();
    this.protocolRecipientHints = new Map();
    this.recipientResolutions = new Map();
    this.deliveryProofs = new Map();
    this.replyProofKey = null;
    this.identityHydrations = new Map();
    this.pendingDecryption = new Map();
    this.commandPrefix = '!busca';
    this.submissionTraceIds = new Map();
    this.sourceCapture = { enabled: false, groupIds: new Set(), activatedAt: 0, importFrom: 0, importUntil: 0 };
    this.seenPublications = new Map();
    this.groupMetadataCache = new Map();
    this.groupMetadataRequests = new Map();
    this.networkSubmissions = new Set();
    this.opportunityCapture = { enabled: false, monitoredGroupIds: new Set(), allowOwnMessages: false, activatedAt: 0 };
    this.seenOpportunities = new Map();
  }

  _receiveTraceId(key = {}, accountId = this._ownAccount().id) {
    const chatId = accountJid(key.remoteJid) || (typeof key.remoteJid === 'string' && key.remoteJid.endsWith('@g.us') ? key.remoteJid : '');
    return `wa-receive-${createHash('sha256').update(`${accountId}:${chatId}:${key.id || ''}`).digest('hex').slice(0, 24)}`;
  }

  _validTraceId(value) {
    return typeof value === 'string' && /^(?:wa-receive-[a-f0-9]{24}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(value) ? value : '';
  }

  _submissionTrace(messageId, supplied) {
    if (this.submissionTraceIds.has(messageId)) return this.submissionTraceIds.get(messageId);
    let traceId = '';
    // Existing operational ledgers survive restart. Read their parent trace
    // without adding a new backup-visible credential or operational setting.
    try {
      const alerts = this.store?.findAlertsByMessageId?.(messageId) || [];
      traceId = this._validTraceId(alerts.find(row => this._validTraceId(row.traceId))?.traceId);
      if (!traceId) {
        const result = this.store?.listSearchDeliveries?.({ messageId, limit: 1 });
        const rows = Array.isArray(result) ? result : result?.items || [];
        traceId = this._validTraceId(rows[0]?.traceId || rows[0]?.runId);
      }
      if (!traceId) {
        const commands = this.store?.getSetting?.('recentCommandIds', []);
        if (Array.isArray(commands)) traceId = this._validTraceId(commands.slice(-2000).find(row => Array.isArray(row.replies) && row.replies.some(reply => reply.messageId === messageId))?.traceId);
      }
    } catch { /* Trace lookup is optional metadata; it never authorizes an operation. */ }
    traceId ||= this._validTraceId(supplied);
    if (traceId && messageId) {
      this.submissionTraceIds.set(messageId, traceId);
      while (this.submissionTraceIds.size > 5000) this.submissionTraceIds.delete(this.submissionTraceIds.keys().next().value);
    }
    return traceId;
  }

  _commandCandidate(message) {
    const text = messageContent(message?.message)?.text;
    if (typeof text !== 'string') return false;
    const normalized = text.trimStart().toLowerCase();
    return [this.commandPrefix, '!mega'].some(prefix => normalized.startsWith(prefix.toLowerCase()) &&
      (normalized.length === prefix.length || /\s/.test(normalized[prefix.length])));
  }

  _transportDiagnostic(message, stage, code, description, detail = {}, operationTraceId) {
    const key = message?.key || {};
    const messageId = typeof key.id === 'string' ? key.id.slice(0, 128) : '';
    const chatId = accountJid(key.remoteJid) || (typeof key.remoteJid === 'string' && key.remoteJid.endsWith('@g.us') ? key.remoteJid : '');
    const outgoing = ['transport.submitting', 'transport.accepted', 'transport.delivered', 'transport.failed'].includes(stage);
    const unknownPrivate = !chatId.endsWith('@g.us') && message?.messageStubType === (this.library?.WAMessageStubType?.CIPHERTEXT ?? 2);
    const commandCandidate = this._commandCandidate(message);
    if (!outgoing && !commandCandidate && !unknownPrivate) return;
    const traceId = outgoing ? this._submissionTrace(messageId, operationTraceId) || this._receiveTraceId(key) : this._receiveTraceId(key);
    // Deliberately exclude text, raw protocol objects, credentials and signed reply proofs.
    const level = stage === 'transport.failed' ? 'error' : stage === 'transport.ignored' || stage === 'transport.waiting' ? 'warning' : 'info';
    this.emit('transportDiagnostic', { traceId, messageId, at: Date.now(), level, stage, code, description,
      detail: { isGroup: chatId.endsWith('@g.us'), fromMe: key.fromMe === true, commandCandidate, ...detail } });
  }

  _decryptionKey(message, generation = this.generation) {
    const key = message?.key || {};
    return `${generation}:${accountJid(key.remoteJid) || key.remoteJid || ''}:${key.id || ''}`;
  }

  _isPendingRecovery(message, generation = this.generation) {
    const pending = this.pendingDecryption.get(this._decryptionKey(message, generation));
    const timestamp = messageTimestamp(message?.messageTimestamp);
    return Boolean(pending && pending.expiresAt >= Date.now() && timestamp === pending.timestamp &&
      (message?.key?.fromMe === true) === pending.fromMe);
  }

  _status(state, detail, extras = {}) {
    const failure = ['disconnected', 'restricted'].includes(state);
    const own = this._ownAccount();
    this.status = { state, mode: 'whatsapp', simulation: false, detail, ownNumber: own.phone || '', ownAccountId: own.id || '', ...(failure ? { reasonCode: state === 'restricted' ? 'restricted' : 'unexpected', at: new Date().toISOString(), manual: false, retryable: state !== 'restricted' } : {}), ...extras };
    this.emit('status', this.status);
  }

  async _ensureProtection() {
    if (this.runtimePlatform !== 'win32') throw new Error('A conexão real está disponível no aplicativo Windows; nesta plataforma, use a simulação.');
    if (!this.safeStorage || !await this.safeStorage.isEncryptionAvailable()) throw new Error('A proteção de credenciais do Windows não está disponível. A conexão foi bloqueada.');
    if (!this.credentialsDir) throw new Error('Pasta protegida da sessão não configurada.');
  }

  async connect({ reconnect = false } = {}) {
    if (this.connectPromise) return this.connectPromise;
    if (this.status.state === 'connected' && !reconnect) return this.status;
    this.connectPromise = (async () => {
      if (reconnect && this.socket) await this.disconnect();
      this.requestedDisconnect = false;
      this.restartCount = 0;
      return this._connect();
    })().finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }

  async _connect() {
    if (!this.networkAvailable) {
      this._status('disconnected', 'Sem conexão com a internet. A tentativa de conexão foi adiada.', { reasonCode: 'internet', manual: false, retryable: true, errorCode: 'NETWORK_OFFLINE' });
      throw definitiveError('Sem conexão com a internet. Tente novamente após restabelecer a rede.', true);
    }
    await this._ensureProtection();
    this._status('connecting', 'Preparando a conexão não oficial com o WhatsApp…');
    const generation = ++this.generation;
    this.recipientCache.clear();
    this.recipientResolutions.clear();
    this.pendingDecryption.clear();
    this.groupMetadataCache.clear();
    this.groupMetadataRequests.clear();
    this.networkSubmissions.clear();
    this.connectStartedAt = Date.now();
    try {
      if (this.socket) this.socket.end(new Error('Reconexão solicitada.'));
      this.library ||= await this.loadLibrary();
      this.logger ||= require('pino')({ level: 'silent' });
      await this.sessionResetPromise;
      this.authStore ||= new EncryptedAuthStore({ dir: this.credentialsDir, safeStorage: this.safeStorage, library: this.library });
      await this.authStore.writeChain;
      const auth = await this.authStore.load();
      // Route proofs contain no credentials. Their signing key remains inside
      // the same Windows-encrypted session, allowing pending replies to survive
      // a restart without trusting a JID supplied by a renderer or HTTP caller.
      this.authStore.data.appMetadata ||= {};
      let proofKey = this.authStore.data.appMetadata.replyProofKey;
      if (typeof proofKey !== 'string' || !/^[a-f0-9]{64}$/.test(proofKey)) {
        proofKey = randomBytes(32).toString('hex');
        this.authStore.data.appMetadata.replyProofKey = proofKey;
        await this.authStore.persist();
      }
      this.replyProofKey = Buffer.from(proofKey, 'hex');
      this.protocolRecipientHints.clear();
      for (const hint of (Array.isArray(this.authStore.data.appMetadata.recipientHints) ? this.authStore.data.appMetadata.recipientHints : []).slice(-1000)) {
        if (hint && /^[1-9]\d{9,14}$/.test(hint.phone || '') && accountJid(hint.jid) && accountJid(hint.accountId) && Number.isFinite(hint.receivedAt) && hint.receivedAt > Date.now() - 7 * 86400000 && hint.receivedAt <= Date.now() + 30000 && (!phoneFromJid(hint.jid) || phoneFromJid(hint.jid) === hint.phone)) this.protocolRecipientHints.set(hint.phone, hint);
        if (this.protocolRecipientHints.size >= 1000) break;
      }
      if (generation !== this.generation || this.requestedDisconnect) return this.status;
      const makeSocket = this.library.default || this.library.makeWASocket;
      const socket = makeSocket({
        auth,
        logger: this.logger,
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        // History is explicitly opt-in and opportunistic. Do not request full-account sync.
        shouldSyncHistoryMessage: () => (this.searchCapture.enabled && this.searchCapture.importHistory) || this._sourceHistoryEnabled(),
        getMessage: async () => undefined,
        enableRecentMessageCache: false,
        enableAutoSessionRecreation: false,
        maxMsgRetryCount: 0,
        browser: this.library.Browsers?.windows?.('Kenned Code Disparos') || ['Kenned Code Disparos', 'Chrome', '1.0.0'],
        connectTimeoutMs: 30000,
        defaultQueryTimeoutMs: 30000,
        keepAliveIntervalMs: 30000
      });
      this.socket = socket;
      socket.ev.on('creds.update', update => {
        if (generation !== this.generation) return;
        this.authStore.updateCreds(update).catch(() => {
          if (generation !== this.generation || this.status.state === 'restricted') return;
          this._status('restricted', 'Falha ao proteger a sessão no Windows. Envios pausados.', { errorCode: 'SESSION_PERSISTENCE_FAILED', reasonCode: 'restricted', retryable: false });
          this._resolveAllPending();
          if (this.socket === socket) {
            this.generation += 1;
            this.socket = null;
            socket.end(new Error('Não foi possível salvar a sessão protegida.'));
          }
        });
      });
      socket.ev.on('connection.update', update => {
        this._connectionUpdate(update, socket, generation).catch(() => {
          if (generation === this.generation) this._status('disconnected', 'Falha ao atualizar a conexão. Tente reconectar.');
        });
      });
      socket.ev.on('groups.update', groups => {
        if (generation !== this.generation) return;
        for (const group of groups || []) if (group?.id) this.groupMetadataCache.delete(group.id);
      });
      socket.ev.on('group-participants.update', event => {
        if (generation === this.generation && event?.id) this.groupMetadataCache.delete(event.id);
      });
      socket.ev.on('messages.upsert', event => {
        this._handleUpsert(event, generation);
      });
      socket.ev.on('messages.update', updates => {
        if (generation !== this.generation) return;
        for (const event of updates || []) {
          this._captureUpdate(event);
          this._sourceUpdate(event);
          this._opportunityUpdate(event);
          if (Number(event.update?.status) >= 2 && (event.key?.fromMe || this.pendingAcks.has(event.key?.id))) {
            const status = Number(event.update.status);
            this._ack(event.key.id, { confirmationScope: status >= 4 ? 'whatsapp-read' : status >= 3 ? 'whatsapp-delivered' : 'whatsapp-server' });
          }
          if (Number(event.update?.status) === 0 && event.key?.fromMe) {
            const targetId = this.pendingAcks.get(event.key.id)?.targetId || this.submittedOutcomes.get(event.key.id)?.targetId || event.key.remoteJid;
            const rejection = (event.update?.messageStubParameters || []).find(value => ['403', '404', '410'].includes(String(value)));
            if (targetId?.endsWith('@g.us') && rejection) this._rejectMessage(event.key.id, targetId, Number(rejection));
            else { if ((event.update?.messageStubParameters || []).some(value => ['403', '429', '463'].includes(String(value)))) this._restrict(socket); this._uncertain(event.key.id); }
          }
        }
      });
      socket.ev.on('messages.delete', event => {
        if (generation === this.generation) { this._captureDelete(event); this._sourceDelete(event); this._opportunityDelete(event); }
      });
      socket.ev.on('contacts.upsert', contacts => {
        if (generation === this.generation) this._rememberContacts(contacts);
      });
      socket.ev.on('contacts.update', contacts => {
        if (generation === this.generation) this._rememberContacts(contacts);
      });
      socket.ev.on('lid-mapping.update', mapping => {
        if (generation === this.generation) this._rememberContacts([{ id: mapping.lid, lid: mapping.lid, phoneNumber: mapping.pn }]);
      });
      socket.ev.on('messaging-history.set', event => {
        if (generation !== this.generation) return;
        this._rememberContacts(event.contacts);
        if (this.searchCapture.enabled && this.searchCapture.importHistory) this._queueCaptureHistory(event.messages, generation, 'messaging-history.set', event);
        if (this._sourceHistoryEnabled()) this._sourceUpsert({ type: 'append', messages: event.messages }, generation);
      });
      socket.ev.on('messaging-history.status', event => {
        if (generation !== this.generation || !this.searchCapture.enabled || !this.searchCapture.importHistory) return;
        this.emit('captureHistoryStatus', { source: 'messaging-history.status', status: event.status, explicit: event.explicit === true, syncType: event.syncType ?? null, complete: false, at: Date.now(), detail: 'Estado de uma etapa de sincronização; não comprova histórico completo dos grupos.' });
      });
      socket.ev.on('message-receipt.update', updates => {
        if (generation !== this.generation) return;
        for (const event of updates || []) {
          if (event.key?.fromMe && (event.receipt?.receiptTimestamp || event.receipt?.readTimestamp || event.receipt?.playedTimestamp)) {
            const deliveredAt = messageTimestamp(event.receipt.receiptTimestamp);
            const readAt = messageTimestamp(event.receipt.readTimestamp || event.receipt.playedTimestamp);
            this._ack(event.key.id, { confirmationScope: readAt ? 'whatsapp-read' : 'whatsapp-delivered', ...(deliveredAt ? { deliveredAt } : {}), ...(readAt ? { readAt } : {}) });
          }
        }
      });
      // rc14 emits group delivery receipts but no high-level successful server ACK.
      // Listen to the authenticated protocol ACK; never treat sendMessage resolution as confirmation.
      const protocolAck = node => {
        if (generation !== this.generation || !node?.attrs?.id) return;
        if (node.attrs.error) {
          const protocolStatus = /^\d{1,4}$/.test(String(node.attrs.error)) ? String(node.attrs.error) : 'unknown';
          this._transportDiagnostic({ key: { id: node.attrs.id, remoteJid: this.pendingAcks.get(node.attrs.id)?.targetId, fromMe: true } }, 'transport.failed', `WA_PROTOCOL_REJECTED_${protocolStatus.toUpperCase()}`, protocolStatus === '463' ? 'O WhatsApp recusou a mensagem por restrição da conta ou ausência de autorização de privacidade da conversa. O envio não será repetido automaticamente.' : `O WhatsApp retornou uma rejeição de protocolo (${protocolStatus}). Revise o diagnóstico antes de reenviar.`, { protocolStatus });
          const targetId = this.pendingAcks.get(node.attrs.id)?.targetId || this.submittedOutcomes.get(node.attrs.id)?.targetId;
          if (targetId?.endsWith('@g.us') && ['403', '404', '410'].includes(String(node.attrs.error))) this._rejectMessage(node.attrs.id, targetId, Number(node.attrs.error));
          else { if (['403', '429', '463'].includes(String(node.attrs.error))) this._restrict(socket); this._uncertain(node.attrs.id); }
        } else this._ack(node.attrs.id);
      };
      if (socket.ws?.prependListener) socket.ws.prependListener('CB:ack,class:message', protocolAck);
      else socket.ws?.on('CB:ack,class:message', protocolAck);
      return this.status;
    } catch (error) {
      if (generation === this.generation) this._status('disconnected', 'Não foi possível conectar. Verifique a internet, a instalação e a sessão protegida.', this._disconnectInfo(error));
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
    const error = update.lastDisconnect?.error;
    const rawCode = error?.output?.statusCode || error?.statusCode;
    const code = rawCode == null ? null : Number(rawCode);
    const info = this._disconnectInfo(error);
    const reasons = this.library.DisconnectReason || {};
    if (this.status.state === 'restricted' || code === 403 || code === 429 || (reasons.forbidden && code === reasons.forbidden)) {
      this._status('restricted', 'O WhatsApp restringiu a conexão. Todos os envios estão pausados; respeite a restrição.', { ...info, reasonCode: 'restricted', retryable: false });
    } else if ((reasons.loggedOut != null && code === Number(reasons.loggedOut)) || code === 401) {
      const reset = this._clearSession();
      this._status('disconnected', 'A conta foi desconectada pelo WhatsApp. Removendo a sessão local inválida…', { ...info, reasonCode: 'session_expired', retryable: false });
      try {
        await reset;
        if (generation === this.generation) this._status('disconnected', 'A conta foi desconectada pelo WhatsApp. Conecte novamente pelo QR Code.', { ...info, reasonCode: 'session_expired', retryable: false });
      } catch {
        if (generation === this.generation) this._status('disconnected', 'Não foi possível remover a sessão inválida. Use Remover sessão antes de conectar novamente.', { ...info, reasonCode: 'session_expired', retryable: false });
      }
    } else {
      this._status('disconnected', this.requestedDisconnect ? 'WhatsApp desconectado.' : info.reasonCode === 'internet' ? 'Sem conexão com a internet. Envios pausados; reconecte após restabelecer a rede.' : 'Conexão interrompida. Envios pausados; reconecte para continuar.', info);
    }
    // Pairing requires one transport restart. This never retries a submitted campaign item.
    if (!this.requestedDisconnect && code === (reasons.restartRequired || 515) && this.restartCount < 1) {
      this.restartCount += 1;
      await this.authStore.writeChain.catch(() => {});
      if (generation === this.generation && !this.requestedDisconnect) await this._connect();
    }
  }

  _disconnectInfo(error) {
    const statusCode = error?.output?.statusCode || error?.statusCode;
    const networkCode = error?.code || error?.cause?.code;
    const manual = this.requestedDisconnect === true;
    const reasonCode = manual ? 'manual' : [401].includes(Number(statusCode)) ? 'session_expired' :
      [403, 429, 463].includes(Number(statusCode)) ? 'restricted' :
      this.networkAvailable === false || ['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'].includes(networkCode) ? 'internet' : 'unexpected';
    const safeCode = Number.isInteger(Number(statusCode)) && statusCode != null ? `WA_${Number(statusCode)}` :
      /^[A-Z0-9_]{1,32}$/.test(String(networkCode || '')) ? String(networkCode) : 'WA_CONNECTION_CLOSED';
    return { reasonCode, at: new Date().toISOString(), manual, retryable: !['manual', 'session_expired', 'restricted'].includes(reasonCode), errorCode: safeCode };
  }

  setNetworkOnline(online) { return this.setNetworkState({ online }); }

  setNetworkState(value) {
    const online = typeof value === 'boolean' ? value : value?.online;
    if (typeof online !== 'boolean') throw definitiveError('Estado de rede inválido.');
    this.networkAvailable = online;
    if (online || this.requestedDisconnect || this.status.state === 'disconnected' || this.status.state === 'restricted') return this.status;
    const socket = this.socket;
    this.generation += 1;
    this.socket = null;
    this._resolveAllPending();
    this._status('disconnected', 'Sem conexão com a internet. Envios pausados até a reconexão.', { reasonCode: 'internet', manual: false, retryable: true, errorCode: 'NETWORK_OFFLINE' });
    socket?.end(new Error('A conexão de rede foi interrompida.'));
    return this.status;
  }

  async _clearSession() {
    if (this.sessionResetPromise) return this.sessionResetPromise;
    const previous = this.authStore;
    this.authStore = null;
    this.replyProofKey = null;
    this.recipientCache.clear();
    this.contacts.clear();
    this.protocolRecipientHints.clear();
    this.sessionResetPromise = (async () => {
      if (previous) await previous.clear();
      else if (this.credentialsDir) await fs.unlink(path.join(this.credentialsDir, AUTH_FILE)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    })().finally(() => { this.sessionResetPromise = null; });
    return this.sessionResetPromise;
  }

  async disconnect({ logout = false, reasonCode = 'manual', manual = reasonCode === 'manual' } = {}) {
    this.requestedDisconnect = Boolean(manual);
    this.generation += 1;
    this.networkSubmissions.clear();
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
        await this._clearSession();
      } else if (this.authStore) await this.authStore.writeChain.catch(() => {});
      this._status('disconnected', logout ? (logoutFailed ? 'Sessão local removida. Remova também o aparelho nas configurações do WhatsApp.' : 'Conta desconectada e sessão local removida.') : 'WhatsApp desconectado. A sessão permanece protegida para reconexão.', { reasonCode, manual: Boolean(manual), retryable: !manual && !['restricted', 'session_expired'].includes(reasonCode) });
    }
  }

  async listGroups() {
    if (this.status.state !== 'connected' || !this.socket) throw definitiveError('Conecte o WhatsApp antes de carregar os grupos.', true);
    const groups = await this.socket.groupFetchAllParticipating();
    const result = Object.values(groups || {}).filter(group => typeof group.id === 'string' && group.id.endsWith('@g.us')).map(group => ({
      id: group.id,
      name: group.subject || group.id,
      authorized: false,
      simulation: false,
      mode: 'whatsapp',
      ...(typeof group.linkedParent === 'string' ? { linkedParent: group.linkedParent } : {}),
      ...(typeof group.isCommunity === 'boolean' ? { isCommunity: group.isCommunity } : {}),
      ...(typeof group.isCommunityAnnounce === 'boolean' ? { isCommunityAnnounce: group.isCommunityAnnounce } : {})
    }));
    this.knownSearchGroups = new Set(result.map(group => group.id));
    return result;
  }

  _assertSignal(signal) {
    if (signal?.aborted) throw Object.assign(definitiveError('A tentativa foi cancelada antes da submissão. Nenhuma mensagem foi enviada.', false, 'WA_ATTEMPT_ABORTED'), { submitted: false });
  }

  async _boundedControl(operation, { signal, timeoutMs = this.controlTimeoutMs } = {}) {
    this._assertSignal(signal);
    let timer, abort;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(Object.assign(definitiveError('A verificação do destino excedeu o tempo de espera.', true, 'WA_GROUP_CHECK_TIMEOUT'), { submitted: false })), Math.max(1, Math.min(Number(timeoutMs) || this.controlTimeoutMs, 120000)));
          if (signal) {
            abort = () => reject(Object.assign(definitiveError('A tentativa foi cancelada antes da submissão.', false, 'WA_ATTEMPT_ABORTED'), { submitted: false }));
            signal.addEventListener('abort', abort, { once: true });
          }
        })
      ]);
    } finally { clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort); }
  }

  async getGroupPublishingStatus(groupId, { force = false, signal, timeoutMs } = {}) {
    this._assertSignal(signal);
    const base = { groupId, id: groupId, name: this.store?.getGroup?.(groupId)?.name || groupId, checkedAt: Date.now(), groupScoped: true };
    if (typeof groupId !== 'string' || !/^\d+(?:-\d+)?@g\.us$/.test(groupId)) return { ...base, available: false, canSend: false, confirmed: true, temporary: false, code: 'WA_GROUP_ID_INVALID', reason: 'O identificador do grupo não é válido.' };
    if (this.status.state !== 'connected' || !this.socket) return { ...base, available: false, canSend: false, confirmed: true, temporary: true, groupScoped: false, code: 'WA_CONNECTION_OFFLINE', reason: 'A conexão geral do WhatsApp está indisponível.' };
    const cached = this.groupMetadataCache.get(groupId);
    if (!force && cached && cached.generation === this.generation && cached.expiresAt > Date.now()) return { ...cached.result };
    const socket = this.socket, generation = this.generation;
    if (typeof socket.groupMetadata !== 'function') return { ...base, available: null, canSend: null, supported: false, confirmed: false, temporary: false, code: 'WA_GROUP_CHECK_UNSUPPORTED', reason: 'A integração não disponibilizou a verificação prévia deste grupo.' };
    let operation = this.groupMetadataRequests.get(groupId);
    if (!operation || operation.generation !== generation) {
      if (this.groupMetadataRequests.size >= 64) return { ...base, available: false, canSend: false, confirmed: false, temporary: true, code: 'WA_GROUP_CHECK_BUSY', reason: 'Há verificações demais em andamento. Tente novamente.' };
      const promise = Promise.resolve().then(() => socket.groupMetadata(groupId));
      operation = { promise, generation };
      this.groupMetadataRequests.set(groupId, operation);
      promise.finally(() => { if (this.groupMetadataRequests.get(groupId) === operation) this.groupMetadataRequests.delete(groupId); }).catch(() => {});
    }
    try {
      const metadata = await this._boundedControl(() => operation.promise, { signal, timeoutMs });
      this._assertSignal(signal); this._assertTransport(socket, generation);
      const result = { ...base, name: metadata?.subject || base.name, supported: true, checkedAt: Date.now(), temporary: false, announce: metadata?.announce === true };
      if (!metadata || metadata.id !== groupId || !Array.isArray(metadata.participants)) return { ...result, available: null, canSend: null, confirmed: false, code: 'WA_GROUP_METADATA_INCOMPLETE', reason: 'Motivo não identificado: os metadados do grupo não permitem confirmar a participação.' };
      const own = this._ownAccount();
      if (!own.id) return { ...result, available: null, canSend: null, confirmed: false, code: 'WA_ACCOUNT_ID_UNAVAILABLE', reason: 'A identidade da conta conectada não pôde ser confirmada.' };
      const mapping = socket.signalRepository?.lidMapping;
      if (!own.ids.some(id => id.endsWith('@lid')) && own.id.endsWith('@s.whatsapp.net') && typeof mapping?.getLIDForPN === 'function') {
        const mapped = accountJid(await this._boundedControl(() => mapping.getLIDForPN(own.id), { signal, timeoutMs }));
        this._assertSignal(signal); this._assertTransport(socket, generation);
        if (mapped.endsWith('@lid')) own.ids.push(mapped);
      }
      const conflictingOwn = metadata.participants.some(participant => {
        const ids = [accountJid(participant.id), accountJid(participant.lid), accountJid(participant.phoneNumber)].filter(Boolean);
        return ids.some(id => own.ids.includes(id)) && own.phone && ids.map(phoneFromJid).filter(Boolean).some(phone => phone !== own.phone);
      });
      if (conflictingOwn) return { ...result, available: false, canSend: false, confirmed: false, code: 'WA_GROUP_IDENTITY_AMBIGUOUS', reason: 'Os metadados apresentam identidades divergentes para a conta conectada. Revise o vínculo PN/LID antes de publicar.' };
      const matches = metadata.participants.filter(participant => {
        const ids = [accountJid(participant.id), accountJid(participant.lid), accountJid(participant.phoneNumber)].filter(Boolean);
        const phones = ids.map(phoneFromJid).filter(Boolean);
        if (own.phone && phones.some(phone => phone !== own.phone)) return false;
        return ids.some(id => own.ids.includes(id));
      });
      if (matches.length > 1) return { ...result, available: false, canSend: false, confirmed: false, code: 'WA_GROUP_IDENTITY_AMBIGUOUS', reason: 'Os metadados possuem vínculos ambíguos para a conta conectada. Revise a identidade antes de enviar.' };
      if (!matches.length && Number(metadata.size) > metadata.participants.length) return { ...result, available: null, canSend: null, confirmed: false, code: 'WA_GROUP_METADATA_INCOMPLETE', reason: 'Motivo não identificado: a lista de participantes disponibilizada está incompleta.' };
      if (!matches.length) return { ...result, available: false, canSend: false, confirmed: true, code: 'WA_GROUP_NOT_PARTICIPANT', reason: 'A conta conectada não consta entre os participantes desse grupo.' };
      const participant = matches[0];
      const administrator = ['admin', 'superadmin'].includes(participant.admin) || participant.isAdmin === true || participant.isSuperAdmin === true;
      const allowed = !result.announce || administrator;
      const status = { ...result, available: allowed, canSend: allowed, confirmed: true, participant: true, administrator,
        code: allowed ? 'WA_GROUP_READY' : 'WA_GROUP_ADMIN_ONLY', reason: allowed ? 'Grupo acessível e conta autorizada a publicar.' : 'O grupo permite mensagens apenas de administradores e a conta conectada não é administradora.' };
      this.groupMetadataCache.set(groupId, { result: status, generation, expiresAt: Date.now() + 60000 });
      while (this.groupMetadataCache.size > 1000) this.groupMetadataCache.delete(this.groupMetadataCache.keys().next().value);
      return status;
    } catch (error) {
      if (error.code === 'WA_ATTEMPT_ABORTED') throw error;
      const connectionLost = socket !== this.socket || generation !== this.generation || this.status.state !== 'connected';
      const code = Number(error?.output?.statusCode || error?.statusCode);
      const confirmed = [403, 404, 410].includes(code);
      return { ...base, available: false, canSend: false, confirmed, temporary: !confirmed, groupScoped: !connectionLost,
        code: connectionLost ? 'WA_CONNECTION_OFFLINE' : confirmed ? `WA_GROUP_UNAVAILABLE_${code}` : error.code === 'WA_GROUP_CHECK_TIMEOUT' ? error.code : 'WA_GROUP_CHECK_FAILED',
        reason: connectionLost ? 'A conexão geral caiu durante a verificação.' : confirmed ? `O WhatsApp negou o acesso ao grupo (código ${code}). A integração não informou se a conta foi removida ou se outra restrição foi aplicada.` : 'Motivo não identificado: a integração não conseguiu verificar o grupo.',
        technicalCode: Number.isFinite(code) && code > 0 ? String(code) : String(error.code || 'UNKNOWN').slice(0, 80) };
    }
  }

  async reconcile(messageId) {
    if (typeof messageId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(messageId)) throw definitiveError('Identificador de mensagem inválido.', false, 'WA_MESSAGE_ID_INVALID');
    const outcome = this.submittedOutcomes.get(messageId);
    const delivered = this.deliveryProofs.get(messageId);
    if (this.receipts.has(messageId) || outcome?.status === 'confirmed') return { status: 'confirmed', messageId, confirmed: true, accepted: true, delivered: Boolean(delivered), confirmationScope: delivered?.confirmationScope || 'whatsapp-server', ...(delivered || {}), source: 'authenticated-receipt-cache', mode: 'whatsapp', simulation: false };
    if (outcome?.status === 'failed') return { ...outcome, messageId, confirmed: true, source: 'authenticated-rejection', mode: 'whatsapp', simulation: false };
    // rc14 provides receipt events but no authoritative historical lookup by message ID.
    // Absence in a local cache never proves that WhatsApp did not receive the message.
    return { status: 'uncertain', messageId, confirmed: false, source: 'no-authoritative-receipt', historicalLookupSupported: false, mode: 'whatsapp', simulation: false };
  }

  configureSearchCapture({ enabled = false, importHistory = false, groupIds, commandGroupIds, commandPrefix } = {}) {
    const normalize = value => Array.isArray(value) ? new Set(value.filter(id => typeof id === 'string' && id.endsWith('@g.us'))) : null;
    this.searchCapture = { enabled: enabled === true, importHistory: importHistory === true, groupIds: normalize(groupIds), commandGroupIds: normalize(commandGroupIds) };
    if (typeof commandPrefix === 'string' && commandPrefix.length <= 50 && commandPrefix.trim()) this.commandPrefix = commandPrefix.trim();
    return { enabled: this.searchCapture.enabled, importHistory: this.searchCapture.importHistory, ...this.getSearchCapabilities() };
  }

  getSearchCapabilities() {
    return { searchCapture: true, live: true, edits: true, deletes: true, opportunisticHistory: true, communityGroups: 'participating-groups-only', historySupport: 'opportunistic', complete: false, originalMessageLinks: false, official: false };
  }

  configureSourceCapture({ enabled = false, groupIds = [], activatedAt = Date.now(), importFrom = 0, importUntil = 0 } = {}) {
    const timestamp = value => typeof value === 'string' ? Date.parse(value) || 0 : Number(value) || 0;
    this.sourceCapture = {
      enabled: enabled === true,
      groupIds: new Set(Array.isArray(groupIds) ? groupIds.filter(id => typeof id === 'string' && /^\d+(?:-\d+)?@g\.us$/.test(id)) : []),
      activatedAt: timestamp(activatedAt), importFrom: timestamp(importFrom), importUntil: timestamp(importUntil)
    };
    return { enabled: this.sourceCapture.enabled, ...this.getSourceCapabilities() };
  }

  setSourceCapture(options) { return this.configureSourceCapture(options); }

  getSourceCapabilities() {
    return { live: true, edits: true, deletes: true, opportunisticHistory: true, completeHistory: false,
      albumAssociation: 'explicit-protocol-parent-only', automaticCaptionAssociation: false, official: false };
  }

  _sourceHistoryEnabled() {
    const config = this.sourceCapture;
    return config.enabled && config.importFrom > 0 && config.importUntil >= config.importFrom;
  }

  _sourceChatAllowed(chatId) {
    return this.sourceCapture.enabled && this.sourceCapture.groupIds.has(chatId);
  }

  _sourceContext(message, { history = false, edits = false } = {}) {
    const key = message?.key || {};
    if (!key.id || !this._sourceChatAllowed(key.remoteJid)) return null;
    const content = messageContent(message.message, { edits });
    if (!content) return null;
    const body = unwrapMessage(message.message);
    const timestamp = messageTimestamp(message.messageTimestamp);
    const { contact, ...identity } = this._identityContext(key, true);
    if (identity.automaticMessage) return null;
    const mediaBody = edits && body.editedMessage?.message ? unwrapMessage(body.editedMessage.message) : body;
    const fileHash = mediaBody[`${content.type}Message`]?.fileSha256;
    let mediaFingerprint = null;
    try {
      const bytes = Buffer.isBuffer(fileHash) || fileHash instanceof Uint8Array ? Buffer.from(fileHash) : typeof fileHash === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(fileHash) ? Buffer.from(fileHash, 'base64') : null;
      if (bytes?.length === 32) mediaFingerprint = bytes.toString('hex');
    } catch { /* Missing/malformed content hashes cannot prove that the image changed. */ }
    const association = body.messageContextInfo?.messageAssociation || message.message?.messageContextInfo?.messageAssociation;
    const albumType = this.library?.proto?.MessageAssociation?.AssociationType?.MEDIA_ALBUM;
    const parent = association?.parentMessageKey;
    const albumParent = parent?.id && (association.associationType === albumType || association.associationType === 1) && (!parent.remoteJid || parent.remoteJid === key.remoteJid)
      ? { messageId: String(parent.id), chatId: key.remoteJid } : null;
    const context = {
      ...identity, messageId: String(key.id), chatId: key.remoteJid, isGroup: true, fromMe: key.fromMe === true,
      type: content.type, text: content.text, caption: content.text,
      timestamp, originalTimestamp: edits ? null : timestamp, capturedAt: Date.now(), history,
      pushName: typeof message.pushName === 'string' ? message.pushName.slice(0, 500) : contact.notify || '',
      displayName: typeof message.pushName === 'string' ? message.pushName.slice(0, 500) : contact.notify || '', savedName: contact.name || '',
      forwarded: hasForwardedMetadata(message.message), traceId: this._receiveTraceId(key),
      originalKey: { id: String(key.id), remoteJid: key.remoteJid, fromMe: key.fromMe === true, ...(key.participant ? { participant: key.participant } : {}) },
      ...(edits ? { revisionAt: timestamp || Date.now() } : {}),
      ...(albumParent ? { albumParent } : {}),
      ...(mediaFingerprint ? { mediaFingerprint } : {}),
      raw: { key: { ...key }, message: edits && body.editedMessage?.message ? body.editedMessage.message : message.message, messageTimestamp: message.messageTimestamp }
    };
    return context;
  }

  _sourceUpsert(event, generation) {
    if (generation !== this.generation || !this.sourceCapture.enabled) return;
    const now = Date.now();
    for (const message of event?.messages || []) {
      if (!this._sourceChatAllowed(message.key?.remoteJid)) continue;
      const body = unwrapMessage(message.message), protocol = body.protocolMessage;
      if (protocol?.key?.id) {
        const key = { ...message.key, ...protocol.key, remoteJid: protocol.key.remoteJid || message.key.remoteJid };
        if (protocol.type === 14 && protocol.editedMessage) {
          const context = this._sourceContext({ key, message: protocol.editedMessage, messageTimestamp: protocol.timestampMs ? Number(protocol.timestampMs) / 1000 : message.messageTimestamp }, { edits: true });
          if (context) this.emit('publicationUpdate', context);
        } else if (protocol.type === 0) this._sourceDelete({ keys: [key] });
        continue;
      }
      const timestamp = messageTimestamp(message.messageTimestamp);
      if (!timestamp || timestamp > now + 30000) continue;
      const history = event.type !== 'notify' || timestamp < this.sourceCapture.activatedAt ||
        (typeof event.requestId === 'string' && !this._isPendingRecovery(message, generation));
      if (history && (!this._sourceHistoryEnabled() || timestamp < this.sourceCapture.importFrom || timestamp > this.sourceCapture.importUntil)) continue;
      const context = this._sourceContext(message, { history });
      if (!context) continue;
      const dedupeId = `${context.accountId}:${context.chatId}:${context.messageId}`;
      if (this.seenPublications.has(dedupeId)) continue;
      this.seenPublications.set(dedupeId, now);
      while (this.seenPublications.size > 5000) this.seenPublications.delete(this.seenPublications.keys().next().value);
      this.emit('publication', context);
    }
  }

  _sourceUpdate(event) {
    if (!this._sourceChatAllowed(event?.key?.remoteJid) || !event.key.id) return;
    const update = event.update || {};
    if (update.message === null && (update.messageStubType === this.library?.WAMessageStubType?.REVOKE || update.messageStubType === 1)) {
      this._sourceDelete({ keys: [event.key] }); return;
    }
    if (!update.message) return;
    const context = this._sourceContext({ key: event.key, ...update }, { edits: true });
    if (context) this.emit('publicationUpdate', context);
  }

  _sourceDelete(event) {
    if (event?.all === true && this._sourceChatAllowed(event.jid)) this.emit('publicationDelete', { chatId: event.jid, all: true, deletedAt: Date.now(), source: 'messages.delete' });
    for (const key of event?.keys || []) if (key.id && this._sourceChatAllowed(key.remoteJid)) {
      this.emit('publicationDelete', { messageId: String(key.id), chatId: key.remoteJid, deletedAt: Date.now(), source: 'messages.delete', automaticMessage: key.fromMe === true && this._isAutomaticMessage(String(key.id)) });
    }
  }

  _captureChatAllowed(chatId, { history = false } = {}) {
    if (!this.searchCapture.enabled || typeof chatId !== 'string') return false;
    if (!chatId.endsWith('@g.us')) return !history && Boolean(accountJid(chatId));
    const { groupIds, commandGroupIds } = this.searchCapture;
    return groupIds === null || groupIds.has(chatId) || (!history && (commandGroupIds === null || commandGroupIds.has(chatId)));
  }

  configureOpportunityCapture({ enabled = false, monitoredGroupIds = [], allowOwnMessages = false, activatedAt = Date.now() } = {}) {
    const groups = Array.isArray(monitoredGroupIds) ? monitoredGroupIds : [];
    this.opportunityCapture = { enabled: enabled === true,
      monitoredGroupIds: new Set(groups.slice(0, 1000).filter(id => typeof id === 'string' && /^[^\s@]+@g\.us$/.test(id))),
      allowOwnMessages: allowOwnMessages === true,
      activatedAt: Number.isFinite(Number(activatedAt)) && Number(activatedAt) >= 0 ? Number(activatedAt) : Date.now() };
    return { enabled: this.opportunityCapture.enabled, ...this.getOpportunityCapabilities() };
  }

  getOpportunityCapabilities() {
    return { live: true, edits: true, deletes: true, history: false,
      quotedReferences: 'stored-same-chat-origin-and-current-sender-required',
      official: false, mode: 'whatsapp', simulation: false };
  }

  _opportunityChatAllowed(chatId) {
    return this.opportunityCapture.enabled && this.opportunityCapture.monitoredGroupIds.has(chatId);
  }

  _opportunityContext(message, { edits = false } = {}) {
    const key = message?.key || {};
    if (!this._opportunityChatAllowed(key.remoteJid) || typeof key.id !== 'string' || !key.id || key.id.length > 512) return null;
    const content = messageContent(message.message, { edits });
    if (content?.type !== 'text' || !content.text.trim() || content.text.length > 16000) return null;
    if (this._commandCandidate(message)) return null;
    const { contact, ...identity } = this._identityContext(key, true);
    if (!identity.identityVerified || identity.automaticMessage ||
        key.fromMe && (!this.opportunityCapture.allowOwnMessages || !identity.trustedSelf)) return null;
    const timestamp = messageTimestamp(message.messageTimestamp);
    if (!edits && (!timestamp || timestamp < this.opportunityCapture.activatedAt || timestamp > Date.now() + 30000)) return null;
    return { ...identity, messageId: key.id, chatId: key.remoteJid, isGroup: true, fromMe: key.fromMe === true,
      type: 'text', text: content.text, timestamp: edits ? undefined : timestamp,
      originalTimestamp: edits ? null : timestamp, capturedAt: Date.now(), history: false,
      ...(edits ? { revisionAt: timestamp || Date.now() } : {}),
      pushName: typeof message.pushName === 'string' ? message.pushName.slice(0, 500) : contact.notify || '',
      displayName: typeof message.pushName === 'string' ? message.pushName.slice(0, 500) : contact.notify || '',
      savedName: contact.name || '', forwarded: hasForwardedMetadata(message.message),
      traceId: this._receiveTraceId(key), ...quotedReference(message.message, key.remoteJid) };
  }

  _opportunityUpsert(event, generation) {
    if (generation !== this.generation || !this.opportunityCapture.enabled || event?.type !== 'notify') return;
    for (const message of event.messages || []) {
      if (!this._opportunityChatAllowed(message.key?.remoteJid)) continue;
      const body = unwrapMessage(message.message), protocol = body.protocolMessage;
      if (protocol?.key?.id) {
        if (protocol.key.remoteJid && protocol.key.remoteJid !== message.key.remoteJid) continue;
        // The edited ID refers to the old message, but its participant fields
        // are supplied in the payload. Authenticate the current envelope's
        // author; a claimed original participant must never impersonate them.
        const key = { ...message.key, id: String(protocol.key.id), remoteJid: message.key.remoteJid };
        if (protocol.type === 14 && protocol.editedMessage) {
          const context = this._opportunityContext({ key, message: protocol.editedMessage, messageTimestamp: protocol.timestampMs ? Number(protocol.timestampMs) / 1000 : message.messageTimestamp }, { edits: true });
          if (context) this.emit('opportunityMessageUpdated', context);
        } else if (protocol.type === 0) this._opportunityDelete({ keys: [key] });
        continue;
      }
      if (typeof event.requestId === 'string' && event.requestId && !this._isPendingRecovery(message, generation)) continue;
      const context = this._opportunityContext(message); if (!context) continue;
      const dedupeId = `${context.accountId}:${context.chatId}:${context.messageId}`;
      if (this.seenOpportunities.has(dedupeId)) continue;
      this.seenOpportunities.set(dedupeId, Date.now());
      while (this.seenOpportunities.size > 5000) this.seenOpportunities.delete(this.seenOpportunities.keys().next().value);
      this.emit('opportunityMessage', context);
    }
  }

  _opportunityUpdate(event) {
    if (!this._opportunityChatAllowed(event?.key?.remoteJid) || !event.key.id) return;
    const update = event.update || {};
    if (update.message === null && (update.messageStubType === this.library?.WAMessageStubType?.REVOKE || update.messageStubType === 1)) {
      this._opportunityDelete({ keys: [event.key] }); return;
    }
    if (!update.message) return;
    const context = this._opportunityContext({ key: event.key, ...update }, { edits: true });
    if (context) this.emit('opportunityMessageUpdated', context);
  }

  _opportunityDelete(event) {
    // A chat cleared locally is not evidence that each original request was
    // withdrawn. Expose only identifiable deletion events; consumers review.
    for (const key of event?.keys || []) if (typeof key.id === 'string' && key.id && key.id.length <= 512 && this._opportunityChatAllowed(key.remoteJid)) {
      this.emit('opportunityMessageDeleted', { messageId: key.id, chatId: key.remoteJid, deletedAt: Date.now(),
        source: 'messages.delete', mode: 'whatsapp', simulation: false });
    }
  }

  _rememberContacts(contacts) {
    for (const contact of contacts || []) {
      const id = accountJid(contact?.id);
      if (!id) continue;
      const previous = this.contacts.get(id) || {};
      const saved = { ...previous, id };
      for (const key of ['name', 'notify', 'verifiedName']) if (typeof contact[key] === 'string') saved[key] = contact[key].slice(0, 500);
      const phone = phoneFromJid(contact.phoneNumber) || (/^[1-9]\d{9,14}$/.test(String(contact.phoneNumber || '')) ? String(contact.phoneNumber) : null) || phoneFromJid(id);
      if (phone) saved.phoneNumber = phone;
      this.contacts.set(id, saved);
      const lid = accountJid(contact.lid);
      if (lid) this.contacts.set(lid, { ...saved, id: lid });
      while (this.contacts.size > 10000) this.contacts.delete(this.contacts.keys().next().value);
    }
  }

  _handleUpsert(event, generation) {
    if (generation !== this.generation) return;
    // Most events are processed synchronously. Some Baileys private events
    // carry only a LID; read the authenticated mapping repository before
    // authorization instead of inventing a telephone from the internal ID.
    const ready = [];
    for (const message of event?.messages || []) {
      const key = message?.key || {};
      this._transportDiagnostic(message, 'transport.received', 'WA_EVENT_RECEIVED', 'Evento de mensagem recebido pela integração.', { eventType: event.type || 'unknown', recovered: Boolean(event.requestId) });
      const isGroup = String(key.remoteJid || '').endsWith('@g.us');
      const jid = accountJid(isGroup ? key.participant : key.remoteJid);
      const alternate = isGroup ? key.participantAlt : key.remoteJidAlt;
      const lookup = this.socket?.signalRepository?.lidMapping?.getPNForLID;
      if (event.type !== 'notify' || key.fromMe || !jid.endsWith('@lid') || phoneFromJid(alternate) || this.contacts.get(jid)?.phoneNumber || typeof lookup !== 'function') {
        ready.push(message); continue;
      }
      const hydrationId = `${generation}:${jid}:${key.id || ''}`;
      if (this.identityHydrations.has(hydrationId)) continue;
      if (this.identityHydrations.size >= 64) { ready.push(message); continue; }
      const socket = this.socket;
      let timer;
      const pending = Promise.race([
        Promise.resolve().then(() => lookup.call(socket.signalRepository.lidMapping, jid)),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), Math.min(this.controlTimeoutMs, 5000)); })
      ]).catch(() => null).then(mapping => {
        if (generation !== this.generation || socket !== this.socket) return;
        const pn = accountJid(mapping);
        const phone = phoneFromJid(pn);
        const hydrated = phone ? { ...message, key: { ...key, [isGroup ? 'participantAlt' : 'remoteJidAlt']: pn } } : message;
        if (phone) this._rememberContacts([{ id: jid, phoneNumber: pn }]);
        const batch = { ...event, messages: [hydrated] };
        this._captureUpsert(batch, generation);
        this._sourceUpsert(batch, generation);
        this._opportunityUpsert(batch, generation);
        this._incoming(batch, generation);
      }).finally(() => { clearTimeout(timer); this.identityHydrations.delete(hydrationId); });
      this.identityHydrations.set(hydrationId, pending);
    }
    if (ready.length) {
      const batch = { ...event, messages: ready };
      this._captureUpsert(batch, generation);
      this._sourceUpsert(batch, generation);
      this._opportunityUpsert(batch, generation);
      this._incoming(batch, generation);
    }
  }

  _replyProof(context) {
    if (!this.replyProofKey || context.isGroup || !accountJid(context.chatId) || !context.identityVerified || !accountJid(context.senderId)) return null;
    const own = this._ownAccount();
    if (!own.id) return null;
    const payload = { v: 1, messageId: String(context.messageId), chatId: accountJid(context.chatId), senderId: accountJid(context.senderId), senderNumber: context.senderNumber || '', accountId: own.id, fromMe: context.fromMe === true, timestamp: context.timestamp };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', this.replyProofKey).update(encoded).digest('base64url');
    if (!context.fromMe && context.verified && /^[1-9]\d{9,14}$/.test(payload.senderNumber)) {
      const result = { jid: payload.chatId, phone: payload.senderNumber, requestedPhone: payload.senderNumber, isSelf: false, mode: 'whatsapp', simulation: false, resolutionSource: 'authenticated-private-message' };
      this.recipientCache.set(payload.senderNumber, { result, generation: this.generation, expiresAt: Date.now() + 600000 });
      const previous = this.protocolRecipientHints.get(payload.senderNumber);
      const hint = { phone: payload.senderNumber, jid: payload.chatId, accountId: own.id, receivedAt: payload.timestamp, persistedAt: previous?.persistedAt || previous?.receivedAt || payload.timestamp };
      this.protocolRecipientHints.set(hint.phone, hint);
      while (this.protocolRecipientHints.size > 1000) this.protocolRecipientHints.delete(this.protocolRecipientHints.keys().next().value);
      // Persist only new routes or a daily freshness refresh. AuthStore coalesces
      // bursts; this is protected account metadata, never a common backup/log.
      if (this.authStore?.data && (!previous || previous.jid !== hint.jid || previous.accountId !== hint.accountId || hint.receivedAt - (previous.persistedAt || previous.receivedAt) >= 86400000)) {
        hint.persistedAt = hint.receivedAt;
        this.authStore.data.appMetadata.recipientHints = [...this.protocolRecipientHints.values()];
        void this.authStore.persist().catch(() => {
          if (this.status.state === 'connected') this._status('restricted', 'Falha ao proteger a identificação de destinatários no Windows. Envios pausados.', { errorCode: 'SESSION_PERSISTENCE_FAILED', reasonCode: 'restricted', retryable: false });
        });
      }
      while (this.recipientCache.size > 1000) this.recipientCache.delete(this.recipientCache.keys().next().value);
    }
    return `${encoded}.${signature}`;
  }

  async resolveReplyRecipient(context) {
    if (this.status.state !== 'connected' || !this.socket) throw definitiveError('WhatsApp desconectado antes de responder ao comando.', true, 'WA_RECIPIENT_OFFLINE');
    if (!this.replyProofKey || context?.isGroup !== false || typeof context.replyProof !== 'string' || context.replyProof.length > 2500) throw definitiveError('A conversa privada não possui prova de recebimento autenticado. Envie o comando novamente.', false, 'WA_REPLY_CONTEXT_INVALID');
    const [encoded, signature, extra] = context.replyProof.split('.');
    let payload;
    try {
      const expected = createHmac('sha256', this.replyProofKey).update(encoded).digest();
      const supplied = Buffer.from(signature || '', 'base64url');
      if (extra || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('invalid');
      payload = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    } catch { throw definitiveError('Não foi possível validar a origem privada do comando. Envie o comando novamente.', false, 'WA_REPLY_CONTEXT_INVALID'); }
    const own = this._ownAccount();
    if (payload.v !== 1 || !accountJid(payload.chatId) || !accountJid(payload.senderId) || !own.ids.includes(payload.accountId) || payload.chatId !== accountJid(context.chatId) || payload.senderId !== accountJid(context.senderId) || payload.senderNumber !== String(context.senderNumber || '') || !Number.isFinite(payload.timestamp) || payload.timestamp > Date.now() + 30000 || payload.timestamp < Date.now() - 7 * 86400000) throw definitiveError('A origem ou a conta deste comando mudou. Envie o comando novamente na conversa autorizada.', false, 'WA_REPLY_CONTEXT_INVALID');
    return { jid: payload.chatId, phone: payload.senderNumber, requestedPhone: payload.senderNumber, isSelf: payload.fromMe && payload.senderNumber === own.phone, mode: 'whatsapp', simulation: false, resolutionSource: 'authenticated-private-message', traceId: this._receiveTraceId({ id: payload.messageId, remoteJid: payload.chatId }, payload.accountId) };
  }

  async resolveSearchRecipient(number, replyContext, options = {}) {
    if (!replyContext) return this.resolveRecipient(number, options);
    const resolved = await this.resolveReplyRecipient(replyContext);
    if (String(number || '') !== resolved.phone && String(number || '') !== resolved.jid) throw definitiveError('O destinatário difere de quem enviou o comando. Nenhuma mensagem foi enviada.', false, 'WA_REPLY_RECIPIENT_MISMATCH');
    return resolved;
  }

  _ownAccount() {
    // For an outbound message remoteJid is its destination, never its author.
    // Only authenticated socket metadata and authenticated PN/LID mappings identify self.
    const user = this.socket?.user;
    const id = accountJid(user?.id);
    if (!id) return { id: '', phone: '', ids: [] };
    const lid = accountJid(user?.lid);
    const contact = this.contacts.get(id) || this.contacts.get(lid) || {};
    const numbers = [phoneFromJid(id), phoneFromJid(user?.phoneNumber), contact.phoneNumber].filter(Boolean);
    const phone = new Set(numbers).size === 1 ? numbers[0] : '';
    return { id, phone: phone || '', ids: [id, lid].filter(Boolean) };
  }

  getOwnAccount() {
    const own = this._ownAccount();
    return { id: own.id, phone: own.phone, mode: 'whatsapp', simulation: false };
  }

  _isAutomaticMessage(messageId) {
    if (!messageId) return false;
    if (this.automaticMessages.has(messageId) || this.pendingAcks.has(messageId) || this.submittedOutcomes.has(messageId)) return true;
    try {
      if (this.store?.isOutboundMessageId) return this.store.isOutboundMessageId(messageId) === true;
      // Compatibility with older stores while their migration is being opened.
      if (this.store?.listJobs?.({ messageId, limit: 1 })?.length) return true;
      const deliveries = this.store?.listSearchDeliveries?.({ messageId, limit: 1 });
      return Array.isArray(deliveries) ? deliveries.length > 0 : (deliveries?.items?.length || 0) > 0;
    } catch {
      // Do not turn an uncertain automation echo into an administrator command.
      return true;
    }
  }

  _markAutomatic(messageId, kind = 'whatsapp') {
    let reservation;
    try { reservation = this.store?.registerOutboundMessageId?.(messageId, { kind, at: Date.now(), storageMode: 'whatsapp' }); }
    catch { throw definitiveError('Não foi possível registrar o controle contra duplicidade. Nenhuma mensagem foi enviada.', false, 'WA_AUTOMATION_PERSISTENCE_FAILED'); }
    this.automaticMessages.add(messageId);
    while (this.automaticMessages.size > 10000) this.automaticMessages.delete(this.automaticMessages.values().next().value);
    return reservation?.changes !== 0;
  }

  isTrustedSelfContext(context) {
    const own = this._ownAccount();
    return context?.fromMe === true && context.trustedSelf === true && Boolean(own.phone) && context.senderNumber === own.phone && context.accountId === own.id;
  }

  _identityContext(key, isGroup) {
    const own = this._ownAccount();
    const fromMe = key.fromMe === true;
    const senderId = fromMe ? own.id : accountJid(isGroup ? key.participant : key.remoteJid);
    const senderAlt = fromMe ? own.ids.find(id => id !== senderId) || '' : accountJid(isGroup ? key.participantAlt : key.remoteJidAlt);
    const contact = this.contacts.get(senderId) || this.contacts.get(senderAlt) || {};
    const direct = phoneFromJid(senderId);
    const alternate = phoneFromJid(senderAlt);
    const mapped = contact.phoneNumber || null;
    const numbers = [direct, alternate, mapped, ...(fromMe ? [own.phone] : [])].filter(Boolean);
    const consistent = new Set(numbers).size <= 1;
    const senderNumber = consistent ? (fromMe ? own.phone : direct || (senderId.endsWith('@lid') ? alternate || mapped : null)) || '' : '';
    const automaticMessage = fromMe && this._isAutomaticMessage(String(key.id || ''));
    const remoteId = accountJid(key.remoteJid);
    const remoteAlt = accountJid(key.remoteJidAlt);
    const remotePhones = [phoneFromJid(remoteId), phoneFromJid(remoteAlt)].filter(Boolean);
    const selfChat = !isGroup && Boolean(own.phone) && remotePhones.every(number => number === own.phone) &&
      (own.ids.includes(remoteId) || own.ids.includes(remoteAlt) || remotePhones.includes(own.phone));
    return {
      senderId, senderIds: [senderId, senderAlt].filter(Boolean), identityVerified: Boolean(senderId) && consistent,
      senderNumber, verified: Boolean(senderNumber) && consistent, contact,
      trustedSelf: fromMe && Boolean(senderNumber) && senderNumber === own.phone,
      selfChat,
      automaticMessage, machineGenerated: automaticMessage,
      accountNumber: own.phone, ownAccountNumber: own.phone,
      accountId: own.id, ownAccountId: own.id, mode: 'whatsapp', simulation: false
    };
  }

  _captureContext(message, { history = false, edits = false } = {}) {
    const key = message?.key || {};
    const chatId = accountJid(key.remoteJid) || key.remoteJid;
    if (!key.id || !this._captureChatAllowed(chatId, { history })) return null;
    const content = messageContent(message.message, { edits });
    if (!content || typeof content.text !== 'string') return null;
    const timestamp = messageTimestamp(message.messageTimestamp);
    if (!edits && (!timestamp || timestamp > Date.now() + 30000)) return null;
    const isGroup = chatId.endsWith('@g.us');
    const { contact, ...identity } = this._identityContext(key, isGroup);
      const normalized = {
      messageId: String(key.id), chatId, isGroup, fromMe: key.fromMe === true,
      ...identity,
      pushName: typeof message.pushName === 'string' ? message.pushName : contact.notify || '',
      displayName: typeof message.pushName === 'string' ? message.pushName : contact.notify || '',
      savedName: contact.name || '', ...content, capturedAt: Date.now(),
      forwarded: hasForwardedMetadata(message.message), history, revisionAt: edits ? timestamp || Date.now() : null
    };
    normalized.traceId = this._receiveTraceId(key);
    // An edit timestamp belongs to the edit; never replace the original offer time with it.
    if (!edits) normalized.timestamp = timestamp;
    if (!history && !edits) normalized.replyProof = this._replyProof(normalized);
    return normalized;
  }

  _captureProtocol(message) {
    const body = unwrapMessage(message.message);
    const protocol = body.protocolMessage;
    if (!protocol?.key?.id) return false;
    const constants = this.library?.proto?.Message?.ProtocolMessage?.Type || {};
    const key = { ...message.key, ...protocol.key, remoteJid: protocol.key.remoteJid || message.key?.remoteJid };
    const isEdit = (constants.MESSAGE_EDIT != null && protocol.type === constants.MESSAGE_EDIT) || protocol.type === 14;
    const isRevoke = (constants.REVOKE != null && protocol.type === constants.REVOKE) || protocol.type === 0;
    if (isEdit && protocol.editedMessage) {
      const value = this._captureContext({ key, message: protocol.editedMessage, messageTimestamp: protocol.timestampMs ? Number(protocol.timestampMs) / 1000 : message.messageTimestamp }, { edits: true });
      if (value) this.emit('offerMessageUpdate', value);
    } else if (isRevoke && this._captureChatAllowed(key.remoteJid, { history: true })) {
      this.emit('offerMessageDelete', { messageId: String(key.id), chatId: key.remoteJid, deletedAt: messageTimestamp(message.messageTimestamp) || Date.now(), source: 'protocol-revoke' });
    }
    return isEdit || isRevoke;
  }

  _captureUpsert(event, generation) {
    if (generation !== this.generation || !this.searchCapture.enabled) return;
    if (event?.type === 'append') {
      if (this.searchCapture.importHistory) this._queueCaptureHistory(event.messages, generation, 'messages.upsert.append');
      return;
    }
    if (event?.type !== 'notify') return;
    const now = Date.now();
    for (const message of event.messages || []) {
      if (!this._captureChatAllowed(message.key?.remoteJid)) continue;
      if (this._captureProtocol(message)) continue;
      const timestamp = messageTimestamp(message.messageTimestamp);
      // An unsolicited phone recovery is history. The one exception is the
      // recovery of a recent live ciphertext already observed by this socket:
      // rc14 uses requestId when the linked phone supplies its decrypted body.
      const recovered = typeof event.requestId === 'string' && event.requestId.length > 0;
      const history = (recovered && !this._isPendingRecovery(message, generation)) || timestamp < Math.max(this.connectStartedAt - 5000, now - 120000);
      const context = this._captureContext(message, { history });
      if (!context) continue;
      const dedupeId = `${context.chatId}:${context.messageId}`;
      if (this.seenOffers.has(dedupeId)) continue;
      this.seenOffers.set(dedupeId, now);
      while (this.seenOffers.size > 4000) this.seenOffers.delete(this.seenOffers.keys().next().value);
      if (history) this.emit('offerHistory', { messages: [context], source: recovered ? 'phone-recovered-notify' : 'delayed-notify', complete: false, at: now });
      else this.emit('offerMessage', context);
    }
  }

  _captureUpdate(event) {
    if (!this.searchCapture.enabled || !event?.key?.id) return;
    const update = event.update || {};
    const revoke = this.library?.WAMessageStubType?.REVOKE;
    if (update.message === null && ((revoke != null && update.messageStubType === revoke) || update.messageStubType === 1)) {
      this._captureDelete({ keys: [event.key] });
      return;
    }
    if (!update.message) return;
    const value = this._captureContext({ key: event.key, ...update }, { edits: true });
    if (value) this.emit('offerMessageUpdate', value);
  }

  _captureDelete(event) {
    if (!this.searchCapture.enabled) return;
    if (event?.all === true && this._captureChatAllowed(event.jid, { history: true })) {
      this.emit('offerMessageDelete', { chatId: event.jid, all: true, deletedAt: Date.now(), source: 'messages.delete' });
    }
    for (const key of event?.keys || []) if (key.id && this._captureChatAllowed(key.remoteJid, { history: true })) {
      this.emit('offerMessageDelete', { messageId: String(key.id), chatId: key.remoteJid, deletedAt: Date.now(), source: 'messages.delete' });
    }
  }

  _queueCaptureHistory(messages, generation, source, metadata = {}) {
    if (!Array.isArray(messages) || !messages.length) return;
    // The transport may deliver an enormous history event. Retain at most 5,000
    // queued raw items; signal gaps explicitly instead of allowing unbounded memory.
    const capacity = Math.max(0, 5000 - this.captureHistoryQueued);
    const accepted = messages.slice(0, capacity);
    if (messages.length > accepted.length) this.emit('captureHistoryStatus', { source, status: 'truncated', complete: false, skipped: messages.length - accepted.length, at: Date.now(), detail: 'Lote de histórico excedeu a fila limitada; existem lacunas.' });
    if (!accepted.length) return;
    this.captureHistoryQueued += accepted.length;
    this.captureHistoryChain = this.captureHistoryChain.catch(() => {}).then(async () => {
      try {
        for (let offset = 0; offset < accepted.length; offset += 100) {
          if (generation !== this.generation || !this.searchCapture.enabled || !this.searchCapture.importHistory) break;
          const values = accepted.slice(offset, offset + 100).map(message => this._captureContext(message, { history: true })).filter(Boolean);
          if (values.length) this.emit('offerHistory', { messages: values, source, complete: false, isLatest: metadata.isLatest === true, progress: Number.isFinite(Number(metadata.progress)) && metadata.progress != null ? Number(metadata.progress) : null, syncType: metadata.syncType ?? null, at: Date.now() });
          await new Promise(resolve => setImmediate(resolve));
        }
      } finally { this.captureHistoryQueued -= accepted.length; }
    });
  }

  _ack(messageId, proof = {}) {
    if (!messageId || !this._isAutomaticMessage(messageId)) return;
    const targetId = this.pendingAcks.get(messageId)?.targetId || this.submittedOutcomes.get(messageId)?.targetId;
    const previouslyAccepted = this.receipts.has(messageId);
    const previousProof = this.deliveryProofs.get(messageId);
    const ranks = { 'whatsapp-server': 1, 'whatsapp-delivered': 2, 'whatsapp-read': 3 };
    const previousRank = previouslyAccepted ? ranks[previousProof?.confirmationScope || 'whatsapp-server'] : 0;
    const scope = proof.confirmationScope || 'whatsapp-server';
    if (previousRank >= ranks[scope]) return;
    const acceptedAt = this.receipts.get(messageId) || Date.now();
    this.receipts.set(messageId, acceptedAt);
    this._rememberOutcome(messageId, 'confirmed');
    if (proof.confirmationScope === 'whatsapp-delivered' || proof.confirmationScope === 'whatsapp-read') {
      const previous = this.deliveryProofs.get(messageId) || {};
      this.deliveryProofs.set(messageId, { ...previous, ...proof, ...(previous.confirmationScope === 'whatsapp-read' ? { confirmationScope: 'whatsapp-read' } : {}) });
      while (this.deliveryProofs.size > 1000) this.deliveryProofs.delete(this.deliveryProofs.keys().next().value);
    }
    while (this.receipts.size > 1000) this.receipts.delete(this.receipts.keys().next().value);
    const pending = this.pendingAcks.get(messageId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingAcks.delete(messageId);
      pending.resolve({ status: 'confirmed', messageId, ...(this.deliveryProofs.get(messageId) || {}) });
    }
    this.emit('receipt', { messageId, status: 'confirmed', accepted: true, acceptedAt, delivered: scope === 'whatsapp-delivered' || scope === 'whatsapp-read', mode: 'whatsapp', simulation: false, confirmationScope: 'whatsapp-server', ...proof });
    this._transportDiagnostic({ key: { id: messageId, remoteJid: targetId, fromMe: true } }, proof.confirmationScope === 'whatsapp-read' || proof.confirmationScope === 'whatsapp-delivered' ? 'transport.delivered' : 'transport.accepted', proof.confirmationScope === 'whatsapp-read' ? 'WA_MESSAGE_READ' : proof.confirmationScope === 'whatsapp-delivered' ? 'WA_MESSAGE_DELIVERED' : 'WA_SERVER_ACCEPTED', proof.confirmationScope === 'whatsapp-read' ? 'Leitura confirmada pelo recibo disponibilizado pelo WhatsApp.' : proof.confirmationScope === 'whatsapp-delivered' ? 'Entrega confirmada pelo recibo disponibilizado pelo WhatsApp.' : 'O servidor do WhatsApp confirmou a aceitação. Isso não comprova recebimento no celular.', { confirmationScope: proof.confirmationScope || 'whatsapp-server' });
  }

  _rememberOutcome(messageId, status, targetId) {
    const previous = this.submittedOutcomes.get(messageId);
    if (previous?.status === 'confirmed' && status !== 'confirmed') return;
    this.submittedOutcomes.set(messageId, { status, targetId: targetId || previous?.targetId });
    while (this.submittedOutcomes.size > 1000) this.submittedOutcomes.delete(this.submittedOutcomes.keys().next().value);
  }

  _resolveAllPending() {
    for (const [messageId, pending] of this.pendingAcks) {
      clearTimeout(pending.timer);
      this._rememberOutcome(messageId, 'uncertain', pending.targetId);
      pending.resolve({ status: 'uncertain', messageId });
    }
    this.pendingAcks.clear();
  }

  _uncertain(messageId) {
    const pending = this.pendingAcks.get(messageId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingAcks.delete(messageId);
    this._rememberOutcome(messageId, 'uncertain', pending.targetId);
    pending.resolve({ status: 'uncertain', messageId });
  }

  _rejectMessage(messageId, targetId, code) {
    if (!messageId || !this._isAutomaticMessage(messageId) || this.receipts.has(messageId)) return;
    const error = Object.assign(definitiveError(`O WhatsApp recusou o envio para este grupo (código ${code}). Verifique a participação e a permissão para publicar.`, false, `WA_GROUP_REJECTED_${code}`),
      { submitted: true, confirmedFailure: true, groupScoped: true, destinationUnavailable: true, groupId: targetId });
    const pending = this.pendingAcks.get(messageId);
    if (pending) {
      clearTimeout(pending.timer); this.pendingAcks.delete(messageId);
      pending.resolve({ status: 'failed', messageId, code: error.code, reason: error.message, safeToRetry: false, confirmedFailure: true, groupScoped: true, destinationUnavailable: true });
    }
    this.submittedOutcomes.set(messageId, { status: 'failed', targetId, code: error.code, reason: error.message, safeToRetry: false, confirmedFailure: true, groupScoped: true, destinationUnavailable: true });
    while (this.submittedOutcomes.size > 1000) this.submittedOutcomes.delete(this.submittedOutcomes.keys().next().value);
    this.groupMetadataCache.delete(targetId);
    this._transportDiagnostic({ key: { id: messageId, remoteJid: targetId, fromMe: true } }, 'transport.failed', error.code, error.message, { submitted: true, confirmedFailure: true, groupScoped: true });
    this.emit('receipt', { messageId, status: 'failed', code: error.code, reason: error.message, confirmedFailure: true, safeToRetry: false, confirmationScope: 'whatsapp-rejection', groupScoped: true, destinationUnavailable: true, mode: 'whatsapp', simulation: false });
  }

  _restrict(socket) {
    if (socket && this.socket !== socket) return;
    if (this.status.state !== 'restricted') this._status('restricted', 'O WhatsApp restringiu o envio. Campanhas pausadas; respeite os limites da integração.', { reasonCode: 'restricted', retryable: false, errorCode: 'WA_RESTRICTED' });
    this._resolveAllPending();
    if (this.socket === socket) {
      this.generation += 1;
      this.socket = null;
      socket?.end(new Error('Restrição do WhatsApp: conexão pausada.'));
    }
  }

  _textContent(item) {
    if (typeof item?.text !== 'string' || !item.text.trim() || item.text.length > 16000) throw definitiveError('Informe um texto de 1 a 16.000 caracteres.');
    return { text: item.text };
  }

  async _managedContent(item, media) {
    if (!ALLOWED_TYPES.has(item?.type)) throw definitiveError('Tipo de conteúdo não suportado.');
    if (item.type === 'text') {
      return this._textContent(item);
    }
    if (!media?.path || !this.store?.dir) throw definitiveError('Mídia não encontrada na pasta gerenciada.', false, 'WA_MEDIA_MISSING');
    let stat, filename, libraryDirectory;
    try {
      libraryDirectory = await fs.realpath(path.join(this.store.dir, 'media'));
      filename = await fs.realpath(media.path);
      stat = await fs.stat(filename);
    } catch { throw definitiveError('O arquivo da biblioteca não está disponível.', false, 'WA_MEDIA_MISSING'); }
    if (!filename.startsWith(libraryDirectory + path.sep)) throw definitiveError('O arquivo está fora da pasta gerenciada.', false, 'WA_MEDIA_PATH');
    if (!stat.isFile()) throw definitiveError('O arquivo da biblioteca não é válido.', false, 'WA_MEDIA_INVALID');
    if (!stat.size || stat.size > MAX_MEDIA_BYTES) throw definitiveError('A mídia precisa ter entre 1 byte e 64 MB.', false, 'WA_MEDIA_SIZE');
    let bytes;
    try { bytes = await fs.readFile(filename); } catch { throw definitiveError('Não foi possível ler a mídia gerenciada.', false, 'WA_MEDIA_READ'); }
    if (!media.sha256 || createHash('sha256').update(bytes).digest('hex') !== media.sha256) throw definitiveError('A mídia foi alterada na pasta gerenciada. Importe o arquivo novamente.', false, 'WA_MEDIA_CHANGED');
    if (item.caption != null && (typeof item.caption !== 'string' || item.caption.length > 16000)) throw definitiveError('Legenda precisa ter até 16.000 caracteres.', false, 'WA_CAPTION_INVALID');
    const content = { [item.type]: bytes, mimetype: media.mime || 'application/octet-stream' };
    if (item.caption) content.caption = item.caption;
    if (item.type === 'document') content.fileName = media.name || path.basename(media.path);
    return content;
  }

  _beforeSubmit(callback) {
    if (callback == null) return;
    if (typeof callback !== 'function') throw definitiveError('Validação final do envio inválida.', false, 'WA_SUBMISSION_GUARD_INVALID');
    try {
      const result = callback();
      if (result && typeof result.then === 'function') throw definitiveError('A validação final do envio precisa ser síncrona.', false, 'WA_SUBMISSION_GUARD_ASYNC');
      if (result === false) throw definitiveError('O envio foi bloqueado pela validação final.', false, 'WA_SUBMISSION_GUARD_REJECTED');
    } catch (error) {
      // A guard fails before transport submission; it is never an uncertain
      // send and must not leave an outbound reservation that could hide it.
      throw Object.assign(error instanceof Error ? error : new Error('O envio foi bloqueado antes da submissão.'), { definitive: true, safeToRetry: false, temporary: false, submitted: false, code: error?.code || 'WA_SUBMISSION_GUARD_REJECTED' });
    }
  }

  _assertTransport(socket, generation) {
    if (socket !== this.socket || generation !== this.generation || this.status.state !== 'connected') throw definitiveError('A conexão mudou antes da submissão. Nenhuma mensagem foi enviada.', true, 'WA_RECIPIENT_CONNECTION_CHANGED');
  }

  async send(groupId, item, media, { beforeSubmit, traceId, signal, timeoutMs } = {}) {
    this._assertSignal(signal);
    if (this.status.state !== 'connected' || !this.socket) throw definitiveError('WhatsApp desconectado. Envios pausados.', true);
    if (typeof groupId !== 'string' || !groupId.endsWith('@g.us')) throw definitiveError('O destino precisa ser um grupo do WhatsApp.');
    const group = this.store?.getGroup(groupId);
    if (!group || !group.authorized || group.simulation) throw definitiveError('O grupo não tem autorização registrada para envio real.');
    const socket = this.socket, generation = this.generation;
    if (typeof socket.groupMetadata === 'function') {
      const publishing = await this.getGroupPublishingStatus(groupId, { signal, timeoutMs });
      if (publishing.available === false) throw Object.assign(definitiveError(publishing.reason, publishing.temporary === true, publishing.code), { submitted: false, groupScoped: publishing.groupScoped, destinationUnavailable: !publishing.temporary, confirmedFailure: publishing.confirmed, groupId, groupName: publishing.name });
    }
    // Keep text submission synchronous up to socket.sendMessage, so an
    // immediate ACK or disconnect cannot race an unnecessary promise turn.
    const content = item?.type === 'text' ? this._textContent(item) : await this._managedContent(item, media);
    this._assertSignal(signal);
    this._assertTransport(socket, generation);
    // Media reads are asynchronous. Check local authorization again after them.
    const current = this.store?.getGroup(groupId);
    if (!current?.authorized || current.simulation) throw definitiveError('A autorização do grupo mudou antes do envio.', false, 'WA_GROUP_AUTHORIZATION_CHANGED');
    return this._submitVerified(groupId, content, item.clientMessageId, beforeSubmit, traceId, { signal, timeoutMs });
  }

  async sendPrivate(number, text, { clientMessageId, beforeSubmit, traceId, signal, timeoutMs } = {}) {
    this._assertSignal(signal);
    const digits = String(number || '');
    if (!/^[1-9]\d{9,14}$/.test(digits)) throw definitiveError('Informe o telefone privado com código do país e DDD, usando 10 a 15 dígitos.');
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw definitiveError('Informe um alerta de 1 a 16.000 caracteres.');
    const socket = this.socket, generation = this.generation;
    const recipient = await this.resolveRecipient(digits, { traceId });
    this._assertTransport(socket, generation);
    return this._submitVerified(recipient.jid, { text }, clientMessageId, beforeSubmit, traceId, { signal, timeoutMs });
  }

  async sendPrivateContent(target, item, media, { clientMessageId = item?.clientMessageId, replyContext, beforeSubmit, traceId, signal, timeoutMs } = {}) {
    this._assertSignal(signal);
    if (this.status.state !== 'connected' || !this.socket) throw definitiveError('WhatsApp desconectado antes de enviar o documento.', true, 'WA_RECIPIENT_OFFLINE');
    const socket = this.socket, generation = this.generation;
    let recipient;
    if (replyContext) {
      recipient = await this.resolveReplyRecipient(replyContext);
      if (![recipient.jid, recipient.phone].includes(target)) throw definitiveError('O destino do documento difere do solicitante do comando.', false, 'WA_REPLY_RECIPIENT_MISMATCH');
    } else {
      const number = /^[1-9]\d{9,14}$/.test(String(target || '')) ? target : phoneFromJid(target);
      if (!number) throw definitiveError('Informe o telefone do destinatário privado com código do país e DDD.', false, 'WA_RECIPIENT_INVALID');
      recipient = await this.resolveRecipient(number, { traceId });
    }
    const content = await this._managedContent(item, media);
    this._assertTransport(socket, generation);
    return this._submitVerified(recipient.jid, content, clientMessageId, beforeSubmit, recipient.traceId || traceId, { signal, timeoutMs });
  }

  async sendSearchDocument(target, document, options = {}) {
    return this.sendPrivateContent(target, { type: 'document', caption: document?.caption || '' }, document, options);
  }

  async resolveRecipient(number, { traceId } = {}) {
    try { return await this._resolveRecipient(number); }
    catch (error) {
      if (this._validTraceId(traceId)) this._transportDiagnostic({ key: { id: '', remoteJid: /^\d{10,15}$/.test(String(number || '')) ? `${number}@s.whatsapp.net` : '', fromMe: true } }, 'transport.failed', /^[A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'WA_RECIPIENT_LOOKUP_REJECTED', 'Não foi possível resolver o destinatário pela integração. Nenhuma mensagem foi submetida.', { submitted: false }, traceId);
      throw error;
    }
  }

  async _resolveRecipient(number) {
    const digits = String(number || '');
    if (!/^[1-9]\d{9,14}$/.test(digits)) throw definitiveError('Informe o telefone privado com código do país e DDD, usando 10 a 15 dígitos.', false, 'WA_RECIPIENT_INVALID');
    if (this.status.state !== 'connected' || !this.socket) throw definitiveError('WhatsApp desconectado antes de resolver o destinatário.', true, 'WA_RECIPIENT_OFFLINE');
    const socket = this.socket;
    const generation = this.generation;
    const own = this._ownAccount();
    if (own.phone === digits) {
      // Baileys sends to the authenticated account's own PN JID and synchronizes
      // its companion devices. onWhatsApp is unnecessary for the already verified self.
      const ownJid = own.ids.find(id => phoneFromJid(id) === digits) || `${digits}@s.whatsapp.net`;
      return { jid: ownJid, phone: digits, requestedPhone: digits, isSelf: true, mode: 'whatsapp', simulation: false, resolutionSource: 'authenticated-account' };
    }
    const hint = this.protocolRecipientHints.get(digits);
    if (hint && own.ids.includes(hint.accountId) && hint.receivedAt > Date.now() - 7 * 86400000 && (!phoneFromJid(hint.jid) || phoneFromJid(hint.jid) === digits)) {
      return { jid: hint.jid, phone: digits, requestedPhone: digits, isSelf: false, mode: 'whatsapp', simulation: false, resolutionSource: 'authenticated-private-message' };
    }
    const cached = this.recipientCache.get(digits);
    if (cached && cached.generation === generation && cached.expiresAt > Date.now()) return { ...cached.result };
    if (this.recipientResolutions.has(digits)) return this.recipientResolutions.get(digits);
    if (this.recipientResolutions.size >= 64) throw definitiveError('Há destinatários demais sendo resolvidos. Aguarde a fila atual.', true, 'WA_RECIPIENT_BUSY');
    if (typeof socket.onWhatsApp !== 'function') throw definitiveError('Esta integração não disponibiliza a resolução de números. Atualize a instalação antes de enviar.', false, 'WA_RECIPIENT_UNSUPPORTED');
    const operation = (async () => {
      let timer;
      try {
        const results = await Promise.race([
          Promise.resolve().then(() => socket.onWhatsApp(digits)),
          new Promise((_resolve, reject) => { timer = setTimeout(() => reject(definitiveError('O WhatsApp não respondeu à validação do destinatário. Nenhuma mensagem foi enviada.', true, 'WA_RECIPIENT_TIMEOUT')), Math.min(this.controlTimeoutMs, 30000)); })
        ]);
        if (generation !== this.generation || this.socket !== socket || this.status.state !== 'connected') throw definitiveError('A conexão mudou durante a resolução do destinatário. Nenhuma mensagem foi enviada.', true, 'WA_RECIPIENT_CONNECTION_CHANGED');
        if (!Array.isArray(results)) throw definitiveError('Não foi possível confirmar o destinatário no WhatsApp. Nenhuma mensagem foi enviada.', true, 'WA_RECIPIENT_LOOKUP_INCOMPLETE');
        const available = results.filter(result => result?.exists === true);
        if (!available.length) throw definitiveError('O número configurado não foi encontrado no WhatsApp. Confira o código do país, DDD e telefone.', false, 'WA_RECIPIENT_NOT_FOUND');
        if (available.length !== 1) throw definitiveError('A integração retornou uma identificação ambígua para o destinatário. Nenhuma mensagem foi enviada.', false, 'WA_RECIPIENT_AMBIGUOUS');
        const jid = accountJid(this.library?.jidNormalizedUser?.(available[0].jid) || available[0].jid);
        if (!jid) throw definitiveError('O WhatsApp retornou um identificador de destinatário inválido. Nenhuma mensagem foi enviada.', false, 'WA_RECIPIENT_INVALID_JID');
        const resolvedPhone = phoneFromJid(jid);
        if (resolvedPhone && resolvedPhone !== digits) throw definitiveError('O WhatsApp retornou um telefone diferente do configurado. Revise o destinatário; nenhuma mensagem foi enviada.', false, 'WA_RECIPIENT_MISMATCH');
        const result = { jid, phone: digits, requestedPhone: digits, isSelf: false, mode: 'whatsapp', simulation: false, resolutionSource: 'whatsapp-usync' };
        this._rememberContacts([{ id: jid, phoneNumber: `${digits}@s.whatsapp.net` }]);
        this.recipientCache.set(digits, { result, generation, expiresAt: Date.now() + 600000 });
        while (this.recipientCache.size > 1000) this.recipientCache.delete(this.recipientCache.keys().next().value);
        return { ...result };
      } catch (error) {
        if (/^WA_RECIPIENT_/.test(error?.code || '')) throw error;
        const statusCode = Number(error?.output?.statusCode || error?.statusCode);
        const temporary = ![400, 401, 403, 404, 429, 463].includes(statusCode);
        if ([403, 429, 463].includes(statusCode)) this._restrict(socket);
        throw definitiveError(temporary ? 'Falha temporária ao validar o destinatário no WhatsApp. Nenhuma mensagem foi enviada.' : 'O WhatsApp recusou a validação do destinatário. Verifique a conexão e eventuais restrições.', temporary, temporary ? 'WA_RECIPIENT_LOOKUP_TEMPORARY' : 'WA_RECIPIENT_LOOKUP_REJECTED');
      } finally { clearTimeout(timer); }
    })();
    this.recipientResolutions.set(digits, operation);
    try { return await operation; }
    finally { if (this.recipientResolutions.get(digits) === operation) this.recipientResolutions.delete(digits); }
  }

  async sendSearchText(target, text, { clientMessageId, replyContext, beforeSubmit, traceId, signal, timeoutMs } = {}) {
    this._assertSignal(signal);
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw definitiveError('Resultado da busca precisa ter de 1 a 16.000 caracteres.');
    if (typeof target !== 'string') throw definitiveError('Destinatário da busca inválido.');
    const socket = this.socket, generation = this.generation;
    let targetId;
    if (replyContext) {
      const resolved = await this.resolveReplyRecipient(replyContext);
      if (![resolved.jid, resolved.phone].includes(target)) throw definitiveError('O destino da resposta difere do comando recebido.', false, 'WA_REPLY_RECIPIENT_MISMATCH');
      targetId = resolved.jid;
      traceId = resolved.traceId || traceId;
    }
    else if (/^[1-9]\d{9,14}$/.test(target)) targetId = (await this.resolveRecipient(target, { traceId })).jid;
    else if (phoneFromJid(target)) targetId = (await this.resolveRecipient(phoneFromJid(target), { traceId })).jid;
    else if (accountJid(target) && target.endsWith('@lid')) {
      const normalized = accountJid(target);
      const mapped = this.contacts.get(normalized)?.phoneNumber || phoneFromJid(await this.socket?.signalRepository?.lidMapping?.getPNForLID?.(normalized));
      if (!mapped) throw definitiveError('O número real desse destinatário não foi disponibilizado pelo WhatsApp. Cadastre o telefone com código do país e DDD.', false, 'WA_RECIPIENT_NUMBER_UNAVAILABLE');
      targetId = (await this.resolveRecipient(mapped, { traceId })).jid;
    }
    else if (target.endsWith('@g.us')) {
      const group = this.store?.getGroup(target);
      if ((!group || group.simulation) && !this.knownSearchGroups.has(target)) throw definitiveError('O destino da busca precisa ser um grupo real conhecido da conta.');
      targetId = target;
    } else throw definitiveError('Destinatário da busca inválido.');
    // Sending to a group is permitted here only after the service explicitly authorizes
    // the origin-recipient option; no result is broadcast or sent via unconfirmed reply().
    this._assertTransport(socket, generation);
    return this._submitVerified(targetId, { text }, clientMessageId, beforeSubmit, traceId, { signal, timeoutMs });
  }

  async _submitVerified(targetId, content, clientMessageId, beforeSubmit, traceId, { signal, timeoutMs } = {}) {
    this._assertSignal(signal);
    if (this.status.state !== 'connected' || !this.socket) throw definitiveError('WhatsApp desconectado antes da submissão. Envios pausados.', true);
    if (clientMessageId != null && (typeof clientMessageId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(clientMessageId))) throw definitiveError('Identificador de envio inválido.');
    if (this.networkSubmissions.size >= 64 && !this.networkSubmissions.has(clientMessageId)) throw Object.assign(definitiveError('Há operações de transporte demais ainda em andamento. Verifique a conexão ou reconecte antes de tentar novamente.', true, 'WA_TRANSPORT_BUSY'), { submitted: false });
    if (this.pendingAcks.size >= 64 && !this.pendingAcks.has(clientMessageId)) throw definitiveError('Há envios demais aguardando confirmação. Aguarde a fila atual.', true);
    const messageId = clientMessageId || this.library.generateMessageIDV2?.(this.socket.user?.id) || randomBytes(16).toString('hex').toUpperCase();
    this._submissionTrace(messageId, traceId);
    const pendingSubmission = this.pendingAcks.get(messageId);
    if (pendingSubmission) {
      if (pendingSubmission.targetId !== targetId) throw definitiveError('O identificador do envio já pertence a outro destino.');
      return pendingSubmission.promise;
    }
    const outcome = this.submittedOutcomes.get(messageId);
    if (outcome) {
      if (outcome.targetId && outcome.targetId !== targetId) throw definitiveError('O identificador do envio já pertence a outro destino.');
      return { ...(outcome.status === 'failed' ? outcome : {}), status: outcome.status, messageId, ...(outcome.status === 'confirmed' ? this.deliveryProofs.get(messageId) || {} : {}) };
    }
    if (this.receipts.has(messageId)) return { status: 'confirmed', messageId };
    const socket = this.socket, generation = this.generation;
    // Publish diagnostics before the final guard: listeners may synchronously
    // pause the system or invalidate a recipient. No external event listener
    // runs between that guard and actual socket submission.
    this._transportDiagnostic({ key: { id: messageId, remoteJid: targetId, fromMe: true } }, 'transport.submitting', 'WA_SUBMISSION_PREPARED', 'Preparando o envio pela integração; a validação final ocorre antes de submeter a mensagem.', { submitted: false, type: Buffer.isBuffer(content.document) ? 'document' : Buffer.isBuffer(content.image) ? 'image' : Buffer.isBuffer(content.video) ? 'video' : 'text' });
    try { this._assertSignal(signal); this._beforeSubmit(beforeSubmit); this._assertTransport(socket, generation); }
    catch (error) {
      this._transportDiagnostic({ key: { id: messageId, remoteJid: targetId, fromMe: true } }, 'transport.failed', /^[A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'WA_SUBMISSION_GUARD_REJECTED', 'Envio bloqueado pela validação final, antes de qualquer submissão à integração.', { submitted: false });
      throw error;
    }
    if (!this._markAutomatic(messageId)) {
      // Only the transport reservation proves this ID already reached submission.
      // Queued jobs/alerts/search deliveries are automatic, but have not been sent.
      return { status: 'uncertain', messageId };
    }
    // Register before submission so an immediate server ACK cannot be lost.
    // A per-message deadline does not imply that the whole connection failed.
    // Only real disconnection/restriction events pause every destination.
    let attemptExpired = false, abort;
    const attemptTimeoutMs = Math.max(1, Math.min(Number(timeoutMs) || this.submissionTimeoutMs, 600000));
    const expire = code => {
      if (!this.pendingAcks.has(messageId)) return;
      attemptExpired = true;
      this._transportDiagnostic({ key: { id: messageId, remoteJid: targetId, fromMe: true } }, 'transport.failed', code,
        'A tentativa terminou sem confirmação. Resultado incerto; os demais itens elegíveis podem continuar e este envio não será repetido automaticamente.', { submitted: true });
      this._uncertain(messageId);
    };
    const resultPromise = new Promise(resolve => {
      const timer = setTimeout(() => expire('WA_SUBMISSION_TIMEOUT'), attemptTimeoutMs);
      const cleanup = () => { if (abort) signal.removeEventListener('abort', abort); };
      this.pendingAcks.set(messageId, { resolve: result => { cleanup(); resolve(result); }, timer, targetId, promise: null });
      if (signal) {
        abort = () => expire('WA_ATTEMPT_TIMEOUT');
        signal.addEventListener('abort', abort, { once: true });
      }
    });
    this.pendingAcks.get(messageId).promise = resultPromise;
    this._rememberOutcome(messageId, 'uncertain', targetId);
    const sent = message => {
      if (generation !== this.generation || socket !== this.socket) return;
      if (Number(message?.status) >= 2 || this.receipts.has(messageId)) {
        const status = Number(message?.status);
        this._ack(messageId, status >= 3 ? { confirmationScope: status >= 4 ? 'whatsapp-read' : 'whatsapp-delivered' } : {});
      }
      const pending = this.pendingAcks.get(messageId);
      if (pending) {
        clearTimeout(pending.timer);
        pending.timer = setTimeout(() => expire('WA_ACK_TIMEOUT'), Math.min(this.ackTimeoutMs, Math.max(1, attemptTimeoutMs - (Date.now() - startedAt))));
      }
    };
    const failed = error => {
      if (generation !== this.generation || socket !== this.socket) return;
      const code = Number(error?.output?.statusCode || error?.statusCode);
      const protocolStatus = Number.isInteger(code) && code >= 100 && code <= 999 ? code : null;
      if (targetId.endsWith('@g.us') && [403, 404, 410].includes(code)) {
        this._rejectMessage(messageId, targetId, code); return;
      }
      this._transportDiagnostic({ key: { id: messageId, remoteJid: targetId, fromMe: true } }, 'transport.failed', protocolStatus ? `WA_SUBMISSION_ERROR_${protocolStatus}` : 'WA_SUBMISSION_ERROR', 'A integração apresentou erro após iniciar a submissão. Resultado incerto; não será repetido automaticamente.', { submitted: true, ...(protocolStatus ? { protocolStatus } : {}) });
      if (code === 429 || code === 403 || code === 463) this._restrict(socket);
      // A transport exception after submission cannot prove that WhatsApp did not accept it.
      this._uncertain(messageId);
    };
    const startedAt = Date.now();
    const uploadGuard = () => {
      this._assertSignal(signal);
      if (attemptExpired) throw Object.assign(definitiveError('A tentativa expirou durante a preparação da mídia. A mídia não será publicada depois do prazo.', false, 'WA_UPLOAD_ATTEMPT_EXPIRED'), { submitted: false });
      this._beforeSubmit(beforeSubmit); this._assertTransport(socket, generation);
    };
    const sendOptions = { messageId, mediaUploadTimeoutMs: attemptTimeoutMs };
    if (typeof socket.waUploadToServer === 'function') {
      sendOptions.upload = async (...args) => {
        uploadGuard();
        const uploaded = await socket.waUploadToServer(...args);
        uploadGuard();
        return uploaded;
      };
    }
    this.networkSubmissions.add(messageId);
    try {
      Promise.resolve(socket.sendMessage(targetId, content, sendOptions)).then(sent, failed).finally(() => this.networkSubmissions.delete(messageId));
    } catch (error) { this.networkSubmissions.delete(messageId); failed(error); }

    return resultPromise;
  }

  _incoming(event, generation) {
    if (generation !== this.generation) return;
    const now = Date.now();
    for (const [id, pending] of this.pendingDecryption) if (pending.expiresAt < now) this.pendingDecryption.delete(id);
    for (const message of event.messages || []) {
      const key = message.key || {};
      const recovered = typeof event.requestId === 'string' && event.requestId.length > 0;
      if (event?.type !== 'notify' || (recovered && !this._isPendingRecovery(message, generation))) {
        this._transportDiagnostic(message, 'transport.ignored', recovered ? 'WA_RECOVERY_NOT_LIVE' : 'WA_HISTORY_NOT_COMMAND', recovered ? 'Recuperação sem mensagem privada recente observada; não executada como comando.' : 'Evento de histórico não executado como comando.', { eventType: event.type || 'unknown' });
        continue;
      }
      const timestamp = messageTimestamp(message.messageTimestamp);
      const chatId = accountJid(key.remoteJid) || key.remoteJid;
      const dedupeId = key.id;
      if (!key.id || !timestamp || timestamp < Math.max(this.connectStartedAt - 5000, now - 120000) || timestamp > now + 30000) {
        this._transportDiagnostic(message, 'transport.ignored', 'WA_MESSAGE_OUTSIDE_LIVE_WINDOW', 'Mensagem sem identificação/data válida ou fora da janela de comandos em tempo real. Reenvie o comando após conectar.');
        continue;
      }
      if (this.seenIncoming.has(dedupeId)) {
        this._transportDiagnostic(message, 'transport.ignored', 'WA_EVENT_DUPLICATE', 'Evento repetido; comando não executado novamente.');
        continue;
      }
      const isGroup = typeof chatId === 'string' && chatId.endsWith('@g.us');
      const { contact, ...identity } = this._identityContext(key, isGroup);
      const body = unwrapMessage(message.message);
      let type;
      let text = '';
      if (typeof body.conversation === 'string') { type = 'text'; text = body.conversation; }
      else if (body.extendedTextMessage) { type = 'text'; text = body.extendedTextMessage.text || ''; }
      else if (body.imageMessage) { type = 'image'; text = body.imageMessage.caption || ''; }
      else if (body.videoMessage) { type = 'video'; text = body.videoMessage.caption || ''; }
      else if (body.documentMessage) { type = 'document'; text = body.documentMessage.caption || ''; }
      else {
        // Do not consume its command ID before decryption succeeds. Without
        // this, a ciphertext event permanently suppresses the recovered body.
        const ciphertext = this.library?.WAMessageStubType?.CIPHERTEXT ?? this.library?.proto?.WebMessageInfo?.StubType?.CIPHERTEXT ?? 2;
        if (message.messageStubType === ciphertext) {
          this.pendingDecryption.set(this._decryptionKey(message, generation), { timestamp, fromMe: key.fromMe === true, expiresAt: now + 120000 });
          while (this.pendingDecryption.size > 2000) this.pendingDecryption.delete(this.pendingDecryption.keys().next().value);
          this._transportDiagnostic(message, 'transport.waiting', 'WA_DECRYPTION_PENDING', 'Mensagem recebida sem conteúdo decifrado. Aguardando recuperação suportada pela integração.');
        } else this._transportDiagnostic(message, 'transport.ignored', 'WA_MESSAGE_CONTENT_UNSUPPORTED', 'Evento sem texto ou mídia compatível; não interpretado como comando.');
        continue;
      }
      this.pendingDecryption.delete(this._decryptionKey(message, generation));
      if (isGroup && type !== 'text' && this._sourceChatAllowed(chatId)) {
        this._transportDiagnostic(message, 'transport.ignored', 'WA_SOURCE_CAPTION_DATA', 'Legenda do grupo de origem tratada somente como conteúdo, sem executar comandos.');
        continue;
      }
      this.seenIncoming.set(dedupeId, now);
      while (this.seenIncoming.size > 2000) this.seenIncoming.delete(this.seenIncoming.keys().next().value);
      const context = {
        messageId: key.id,
        traceId: this._receiveTraceId(key),
        ...identity,
        pushName: typeof message.pushName === 'string' ? message.pushName.slice(0, 500) : contact.notify || '',
        displayName: typeof message.pushName === 'string' ? message.pushName.slice(0, 500) : contact.notify || '',
        savedName: contact.name || '',
        isGroup,
        forwarded: hasForwardedMetadata(message.message),
        fromMe: key.fromMe === true,
        chatId,
        text,
        type,
        raw: message,
        timestamp,
        ...quotedReference(message.message, chatId),
        ...(recovered ? { recoveredAfterDecryption: true } : {})
      };
      context.replyProof = this._replyProof(context);
      this._transportDiagnostic(message, 'transport.identity', context.verified ? 'WA_IDENTITY_RESOLVED' : 'WA_IDENTITY_UNRESOLVED', context.verified ? 'Remetente identificado pelo protocolo; autorização será verificada pelo serviço.' : 'Telefone do remetente indisponível ou divergente. Nenhum telefone foi inferido do nome ou do identificador interno.', { identityVerified: context.identityVerified, verified: context.verified, automaticMessage: context.automaticMessage, recoveredAfterDecryption: recovered });
      this.emit('incoming', context);
    }
  }

  async reply(chatId, text, { replyContext, clientMessageId, beforeSubmit, traceId } = {}) {
    if (replyContext) return this.sendSearchText(chatId, String(text), { replyContext, clientMessageId, beforeSubmit, traceId });
    if (this.status.state !== 'connected' || !this.socket) throw definitiveError('WhatsApp desconectado.', true);
    if (typeof chatId !== 'string' || (!phoneFromJid(chatId) && !/^\d+@lid$/.test(chatId))) throw definitiveError('Conversa de controle inválida.');
    const socket = this.socket;
    const messageId = this.library.generateMessageIDV2?.(socket.user?.id) || randomBytes(16).toString('hex').toUpperCase();
    this._beforeSubmit(beforeSubmit);
    this._markAutomatic(messageId, 'control-reply');
    let timer;
    try {
      const result = await Promise.race([
        socket.sendMessage(chatId, { text: String(text) }, { messageId }),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            if (this.socket === socket) {
              this.generation += 1;
              this.socket = null;
              this._status('disconnected', 'A resposta de controle excedeu o tempo de espera. Reconecte para continuar.', { reasonCode: 'unexpected', errorCode: 'WA_CONTROL_TIMEOUT' });
              this._resolveAllPending();
              socket.end(new Error('Tempo de resposta de controle excedido.'));
            }
            reject(definitiveError('Não foi possível confirmar a resposta de controle. Ela não será repetida automaticamente.'));
          }, this.controlTimeoutMs);
        })
      ]);
      if (result?.key?.id && result.key.id !== messageId) this._markAutomatic(result.key.id, 'control-reply');
      return { messageId: result?.key?.id || messageId };
    } finally { clearTimeout(timer); }
  }

  async downloadIncoming(context, { signal, timeoutMs = this.controlTimeoutMs } = {}) {
    this._assertSignal(signal);
    if (!this.socket || !context?.raw || !['image', 'video', 'document'].includes(context.type)) throw definitiveError('Mídia de controle inválida.');
    const body = unwrapMessage(context.raw.message);
    const metadata = body[`${context.type}Message`];
    if (!metadata) throw definitiveError('Anexo não encontrado.');
    const declaredSize = typeof metadata.fileLength?.toNumber === 'function' ? metadata.fileLength.toNumber() : Number(metadata.fileLength || 0);
    if (declaredSize > MAX_MEDIA_BYTES) throw definitiveError('O anexo excede o limite local de 64 MB.');
    const socket = this.socket;
    let stream, timer, abort;
    let timedOut = false;
    const timeoutError = definitiveError('O download da mídia excedeu o tempo de espera. Nenhum conteúdo parcial foi adicionado. Envie o anexo novamente.');
    const download = (async () => {
      stream = await this.library.downloadMediaMessage(context.raw, 'stream', { options: signal ? { signal } : undefined }, { logger: this.logger, reuploadRequest: socket.updateMediaMessage });
      if (timedOut || signal?.aborted) { stream.destroy?.(); throw timeoutError; }
      const chunks = [];
      let size = 0;
      try {
        for await (const chunk of stream) {
          if (timedOut || signal?.aborted) throw timeoutError;
          size += chunk.length;
          if (size > MAX_MEDIA_BYTES) throw definitiveError('O anexo excede o limite local de 64 MB.');
          chunks.push(Buffer.from(chunk));
        }
      } finally { stream.destroy?.(); }
      if (timedOut) throw timeoutError;
      const buffer = Buffer.concat(chunks, size);
      const extension = context.type === 'image' ? '.jpg' : context.type === 'video' ? '.mp4' : '';
      return { buffer, name: metadata.fileName || `anexo-${Date.now()}${extension}`, mime: metadata.mimetype || 'application/octet-stream', type: context.type };
    })();
    try {
      return await Promise.race([download, new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          stream?.destroy?.();
          reject(timeoutError);
        }, Math.max(1, Math.min(Number(timeoutMs) || this.controlTimeoutMs, 600000)));
        if (signal) {
          abort = () => { timedOut = true; stream?.destroy?.(); reject(Object.assign(timeoutError, { code: 'WA_MEDIA_DOWNLOAD_ABORTED', submitted: false })); };
          signal.addEventListener('abort', abort, { once: true });
        }
      })]);
    } finally { clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort); }
  }
}

module.exports = { WhatsAppAdapter, EncryptedAuthStore, phoneFromJid, hasForwardedMetadata, unwrapMessage, accountJid, messageContent };
