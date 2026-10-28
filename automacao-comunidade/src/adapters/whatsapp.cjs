'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const AUTH_FILE = 'session.dpapi';
const normalizeJid = value => typeof value === 'string' && /^\d+(?::\d+)?@(s\.whatsapp\.net|lid)$/.test(value) ? value.replace(/:\d+(?=@)/, '') : null;
const phoneFromJid = value => { const jid = normalizeJid(value); return jid?.endsWith('@s.whatsapp.net') && /^\d{8,15}$/.test(jid.split('@')[0]) ? jid.split('@')[0] : null; };
const validGroup = value => typeof value === 'string' && /^[\d-]+@g\.us$/.test(value);
const safeError = (code, message, retryable = false) => Object.assign(new Error(message), { code, confirmedFailure: true, retryable, submitted: false });
const silentLogger = { level: 'silent', trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };

/** Independent, encrypted auth; no plaintext credentials are ever written. */
class EncryptedAuthStore {
  constructor({ dir, safeStorage, library }) { Object.assign(this, { dir, safeStorage, library }); this.data = null; this.chain = Promise.resolve(); this.persistPromise = null; this.version = 0; }
  async load() {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      this.data = JSON.parse(await this.safeStorage.decryptString(await fs.readFile(path.join(this.dir, AUTH_FILE))), this.library.BufferJSON.reviver);
      if (!this.data?.creds || !this.data?.keys) throw new Error('invalid');
    } catch (error) {
      if (error.code !== 'ENOENT') throw safeError('WA_AUTH_UNREADABLE', 'Não foi possível abrir a sessão protegida. Preserve os dados e reconecte a conta.');
      this.data = { creds: this.library.initAuthCreds(), keys: {} };
    }
    return { creds: this.data.creds, keys: {
      get: async (type, ids) => Object.fromEntries(ids.map(id => [id, type === 'app-state-sync-key' && this.data.keys[type]?.[id] ? this.library.proto.Message.AppStateSyncKeyData.fromObject(this.data.keys[type][id]) : this.data.keys[type]?.[id]])),
      set: async updates => { for (const [type, entries] of Object.entries(updates)) { this.data.keys[type] ||= {}; for (const [id, value] of Object.entries(entries)) { if (value == null) delete this.data.keys[type][id]; else this.data.keys[type][id] = value; } } await this.persist(); }
    } };
  }
  updateCreds(update) { Object.assign(this.data.creds, update); return this.persist(); }
  persist() {
    this.version++;
    if (this.persistPromise) return this.persistPromise;
    this.persistPromise = this.chain.catch(() => {}).then(async () => {
      try { let persisted; do {
        persisted = this.version;
        const encrypted = await this.safeStorage.encryptString(JSON.stringify(this.data, this.library.BufferJSON.replacer));
        const temporary = path.join(this.dir, `.session-${randomBytes(8).toString('hex')}.tmp`);
        let handle;
        try { handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(encrypted); await handle.sync(); await handle.close(); handle = null; await fs.rename(temporary, path.join(this.dir, AUTH_FILE)); }
        finally { if (handle) await handle.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); }
      } while (persisted !== this.version); }
      finally { this.persistPromise = null; }
    });
    this.chain = this.persistPromise; return this.persistPromise;
  }
  async flush() { await this.chain; }
  async clear() { await this.chain.catch(() => {}); await fs.unlink(path.join(this.dir, AUTH_FILE)).catch(error => { if (error.code !== 'ENOENT') throw error; }); this.data = null; }
}

class WhatsAppAdapter extends EventEmitter {
  constructor({ credentialsDir, safeStorage, store, loadLibrary, now = Date.now, ackTimeoutMs = 20000, reconnectDelays = [2000, 5000, 15000, 30000, 60000], runtimePlatform = process.platform } = {}) {
    super(); Object.assign(this, { credentialsDir, safeStorage, store, now, ackTimeoutMs, reconnectDelays, runtimePlatform });
    this.loadLibrary = loadLibrary || (() => import('@whiskeysockets/baileys'));
    this.minimumSpacingMs = 3000; this.socket = null; this.generation = 0; this.manual = true; this.closed = false; this.connectPromise = null; this.reconnectTimer = null; this.reconnectAttempt = 0;
    this.status = { mode: 'whatsapp', state: 'disconnected', ready: false, detail: 'WhatsApp desconectado. Integração não oficial Baileys.' };
    this.aliases = new Map(); this.conflicts = new Set(); this.registry = new Map(); this.pending = new Map(); this.sentMessages = new Map(); this.inflightInvites = new Map();
    for (const entry of this.store?.getSetting('wa.messageRegistry', []) || []) if (entry?.messageId && normalizeJid(entry.targetId)) this.registry.set(entry.messageId, entry);
  }
  _status(state, detail, extra = {}) { this.status = { mode: 'whatsapp', state, ready: state === 'connected', detail, ...extra }; this.emit('status', this.status); return this.status; }
  _diagnostic(stage, code, detail) { this.emit('diagnostic', { at: this.now(), stage, code, detail }); }
  _eventFailure() {
    this.manual = true; clearTimeout(this.reconnectTimer); this.reconnectTimer = null; this._disposeSocket();
    for (const [messageId, pending] of [...this.pending]) pending.settle({ status: 'uncertain', messageId, code: 'WA_RECEIPT_PERSIST_FAILED', confirmationScope: 'not-persisted' });
    try { this._status('disconnected', 'Não foi possível registrar o resultado com segurança. Os envios foram pausados; verifique armazenamento e diagnóstico.', { reasonCode: 'WA_RECEIPT_PERSIST_FAILED' }); } catch {}
    try { this._diagnostic('receipt.persist', 'WA_RECEIPT_PERSIST_FAILED', 'Falha ao registrar confirmação. Nenhum reenvio automático será iniciado.'); } catch {}
  }
  _guardEvent(task) { try { task(); } catch { this._eventFailure(); } }
  _ready() { return this.status.ready && this.socket?.user && this.socket?.ws?.isOpen !== false; }
  async connect({ reconnect = false } = {}) {
    if (this.closed) throw safeError('WA_CLOSED', 'O aplicativo está encerrando.');
    if (this._ready()) return this.status;
    if (this.connectPromise) return this.connectPromise;
    this.manual = false; clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    if (!reconnect) this.reconnectAttempt = 0;
    this.connectPromise = this._connect().finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }
  async _connect() {
    const generation = ++this.generation;
    this._disposeSocket(); this._status('connecting', 'Conectando à sessão protegida do WhatsApp…');
    try {
      if (!this.safeStorage || !await this.safeStorage.isEncryptionAvailable() || this.runtimePlatform === 'linux' && await this.safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw safeError('WA_SECURE_STORAGE_UNAVAILABLE', 'Proteção segura de credenciais indisponível. No Windows, a sessão usa DPAPI.');
      this.library ||= await this.loadLibrary();
      this.authStore ||= new EncryptedAuthStore({ dir: this.credentialsDir, safeStorage: this.safeStorage, library: this.library });
      const auth = this.authStore.data ? { creds: this.authStore.data.creds, keys: this.authState.keys } : await this.authStore.load();
      this.authState = auth;
      if (generation !== this.generation || this.manual || this.closed) return this.status;
      const makeSocket = this.library.default || this.library.makeWASocket;
      const socket = makeSocket({ auth, logger: silentLogger, browser: ['Automação Comunidade', 'Desktop', '1.0.1'], markOnlineOnConnect: false, syncFullHistory: false, shouldSyncHistoryMessage: () => false, printQRInTerminal: false, getMessage: async key => this.sentMessages.get(key.id) });
      this.socket = socket;
      const current = () => generation === this.generation && socket === this.socket && !this.manual;
      socket.ev.on('creds.update', update => { if (current()) this.authStore.updateCreds(update).catch(() => { this._diagnostic('auth.persist', 'WA_AUTH_WRITE_FAILED', 'Não foi possível persistir a sessão protegida; os envios foram pausados.'); this.disconnect({ manual: true }).catch(() => {}); }); });
      socket.ev.on('connection.update', update => { if (current()) this._connectionUpdate(update, socket, generation).catch(() => this._eventFailure()); });
      socket.ev.on('contacts.upsert', contacts => { if (current()) this._rememberContacts(contacts); });
      socket.ev.on('contacts.update', contacts => { if (current()) this._rememberContacts(contacts); });
      socket.ev.on('lid-mapping.update', mapping => { if (current()) this._rememberContacts([{ id: mapping.lid, phoneNumber: mapping.pn }]); });
      socket.ev.on('messages.update', updates => this._guardEvent(() => { if (current()) for (const event of updates || []) {
        const status = Number(event.update?.status);
        if (status >= 2) this._receipt(event.key?.id, status >= 3 ? 'delivered' : 'accepted', event.key?.remoteJid);
        else if (status === 0) this._uncertain(event.key?.id, 'WA_STATUS_UNCERTAIN');
      } }));
      socket.ev.on('message-receipt.update', updates => this._guardEvent(() => { if (current()) for (const event of updates || []) if (event.receipt?.receiptTimestamp || event.receipt?.readTimestamp) this._receipt(event.key?.id, 'delivered', event.key?.remoteJid); }));
      const protocolAck = node => this._guardEvent(() => { if (!current() || !node?.attrs?.id) return; if (node.attrs.error) this._uncertain(node.attrs.id, 'WA_PROTOCOL_REJECTED'); else this._receipt(node.attrs.id, 'accepted', node.attrs.from); });
      socket.ws?.on('CB:ack,class:message', protocolAck);
      socket.ev.on('messages.upsert', event => { if (current() && event.type === 'notify') for (const message of event.messages || []) this._incoming(message, socket, generation).catch(() => {}); });
      return this.status;
    } catch (error) {
      if (generation === this.generation) { this._status('disconnected', error.code === 'WA_SECURE_STORAGE_UNAVAILABLE' || error.code === 'WA_AUTH_UNREADABLE' ? error.message : 'Não foi possível iniciar a conexão. Verifique internet e sessão.', { reasonCode: error.code || 'WA_CONNECT_FAILED' }); if (!error.confirmedFailure) this._scheduleReconnect(); }
      if (error.confirmedFailure) throw error;
      throw safeError('WA_CONNECT_FAILED', 'Não foi possível iniciar a conexão com o WhatsApp.', true);
    }
  }
  async _connectionUpdate(update, socket, generation) {
    if (update.qr) {
      const qr = await require('qrcode').toDataURL(update.qr, { width: 320, margin: 2 });
      if (generation === this.generation && socket === this.socket) this._status('qr', 'Leia o QR Code em WhatsApp → Aparelhos conectados. Integração não oficial.', { qr, reasonCode: 'QR_REQUIRED' });
    }
    if (update.connection === 'open') {
      if (!socket.user) { this._status('connecting', 'Aguardando identificação autenticada da sessão…'); return; }
      this.reconnectAttempt = 0; this._status('connected', 'WhatsApp pronto. Integração não oficial Baileys.');
    }
    if (update.connection !== 'close') return;
    this._disposeSocket(); this._settlePending('WA_DISCONNECTED');
    const code = Number(update.lastDisconnect?.error?.output?.statusCode || update.lastDisconnect?.error?.statusCode);
    const loggedOut = code === 401 || code === Number(this.library?.DisconnectReason?.loggedOut);
    const restricted = [403, 429, 440].includes(code);
    this._status('disconnected', loggedOut ? 'Sessão encerrada. Clique em conectar para ler um novo QR Code.' : restricted ? 'O WhatsApp restringiu ou substituiu a sessão. Revise a conta antes de reconectar.' : 'Conexão interrompida. Os envios permanecem pendentes.', { reasonCode: loggedOut ? 'SESSION_EXPIRED' : restricted ? 'SESSION_RESTRICTED' : 'CONNECTION_LOST', reconnectAttempt: this.reconnectAttempt });
    if (loggedOut) { this.manual = true; await this.authStore.clear(); this.authStore = null; this.authState = null; }
    else if (!restricted) this._scheduleReconnect();
  }
  _scheduleReconnect() {
    if (this.manual || this.closed || this.reconnectTimer || this.store?.getSetting('settings', {})?.autoReconnect === false || this.reconnectAttempt >= this.reconnectDelays.length) return;
    const delay = this.reconnectDelays[this.reconnectAttempt++];
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; if (!this.manual && !this.closed) this.connect({ reconnect: true }).catch(() => {}); }, delay);
    this.reconnectTimer.unref?.();
    this._diagnostic('connection.reconnect', 'WA_RECONNECT_SCHEDULED', `Nova tentativa ${this.reconnectAttempt}/${this.reconnectDelays.length} em ${Math.ceil(delay / 1000)} segundos.`);
  }
  _disposeSocket() { const old = this.socket; this.socket = null; if (old) { old.ev?.removeAllListeners?.(); old.ws?.removeAllListeners?.('CB:ack,class:message'); try { old.end?.(new Error('Conexão substituída pelo aplicativo.')); } catch {} } }
  async disconnect({ logout = false, manual = true } = {}) {
    this.manual = manual; ++this.generation; clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    const old = this.socket; this._disposeSocket(); this._settlePending('WA_DISCONNECTED');
    if (logout && old?.logout) await old.logout().catch(() => {});
    if (logout && this.authStore) { await this.authStore.clear(); this.authStore = null; this.authState = null; }
    else if (this.authStore) await this.authStore.flush();
    return this._status('disconnected', manual ? 'Desconexão manual. A reconexão automática está desativada.' : 'WhatsApp desconectado.', { reasonCode: manual ? 'MANUAL_DISCONNECT' : 'CONNECTION_LOST' });
  }
  async shutdown() { this.closed = true; await this.disconnect({ manual: true }); }
  testConnection() { if (!this._ready()) throw safeError('WA_NOT_READY', 'WhatsApp não está pronto para enviar.', true); return { ...this.status, accountPhone: phoneFromJid(this.socket.user.id), testedAt: this.now() }; }
  _rememberContacts(contacts) {
    for (const contact of contacts || []) {
      const values = [contact.id, contact.lid, contact.phoneNumber].map(normalizeJid).filter(Boolean);
      const pns = [...new Set(values.filter(phoneFromJid))];
      if (pns.length > 1) { for (const id of values) this.conflicts.add(id); continue; }
      const pn = pns[0]; if (!pn) continue;
      for (const id of values) { if (this.aliases.has(id) && this.aliases.get(id) !== pn) this.conflicts.add(id); else this.aliases.set(id, pn); }
    }
  }
  async listGroups() {
    this.testConnection(); const socket = this.socket; const generation = this.generation;
    let metadata;
    try { metadata = await socket.groupFetchAllParticipating(); }
    catch (error) { const code = Number(error?.output?.statusCode || error?.statusCode); throw safeError('WA_GROUP_QUERY_FAILED', `O WhatsApp não disponibilizou a lista de grupos${Number.isInteger(code) ? ` (código ${code})` : ''}. Verifique conexão e sessão.`, ![401, 403].includes(code)); }
    if (socket !== this.socket || generation !== this.generation || !this._ready()) throw safeError('WA_CONNECTION_CHANGED', 'A conexão mudou ao consultar os grupos.', true);
    return Object.values(metadata || {}).filter(group => validGroup(group.id)).map(group => ({ id: group.id, name: group.subject || 'Grupo sem nome disponível', participantCount: group.size ?? group.participants?.length ?? null, isCommunity: !!group.isCommunity, linkedParent: group.linkedParent || null, fetchedAt: this.now() }));
  }
  async _participant(participant, socket) {
    this._rememberContacts([participant]);
    const externalId = normalizeJid(participant.id); if (!externalId) return null;
    const identifiers = [...new Set([externalId, participant.lid, participant.phoneNumber].map(normalizeJid).filter(Boolean))];
    if (externalId.endsWith('@lid') && !this.aliases.has(externalId)) {
      let mapped = null;
      try { mapped = normalizeJid(await socket.signalRepository?.lidMapping?.getPNForLID?.(externalId)); }
      catch {
        // A missing/unreadable local LID mapping is not permission to guess a phone,
        // nor should it prevent importing the other identifiable group members.
        this._diagnostic('identity.resolve', 'WA_PARTICIPANT_PHONE_UNAVAILABLE', 'O número de um participante não pôde ser resolvido. Ele permanece sem telefone confiável; os demais participantes continuam disponíveis.');
      }
      if (phoneFromJid(mapped)) { identifiers.push(mapped); this._rememberContacts([{ id: externalId, phoneNumber: mapped }]); }
    }
    const pn = this.aliases.get(externalId) || identifiers.find(phoneFromJid);
    if (pn && !identifiers.includes(pn)) identifiers.push(pn);
    const selfIds = [socket.user?.id, socket.user?.lid, this.authState?.creds?.me?.id, this.authState?.creds?.me?.lid].map(normalizeJid).filter(Boolean);
    return { externalId, identifiers: [...new Set(identifiers)], phone: this.conflicts.has(externalId) ? null : phoneFromJid(pn), name: participant.name || participant.notify || participant.verifiedName || null, displayName: participant.notify || null, self: identifiers.some(id => selfIds.includes(id)), ambiguous: identifiers.some(id => this.conflicts.has(id)) };
  }
  async listParticipants(groupId) {
    if (!validGroup(groupId)) throw safeError('WA_INVALID_GROUP', 'Selecione um identificador real de grupo.');
    this.testConnection(); const socket = this.socket; const generation = this.generation;
    let group;
    try { group = await socket.groupMetadata(groupId); }
    catch (error) { const code = Number(error?.output?.statusCode || error?.statusCode); throw safeError([401, 403, 404].includes(code) ? 'WA_GROUP_ACCESS_DENIED' : 'WA_GROUP_METADATA_FAILED', `Não foi possível consultar os participantes deste grupo${Number.isInteger(code) ? ` (código ${code})` : ''}. Confirme a participação e a permissão da conta.`, ![401, 403, 404].includes(code)); }
    if (group?.id !== groupId || !Array.isArray(group.participants)) throw safeError('WA_GROUP_UNAVAILABLE', 'O grupo não está acessível ou seus participantes não foram disponibilizados.');
    const result = []; for (const participant of group.participants) { const item = await this._participant(participant, socket); if (item) result.push(item); }
    if (socket !== this.socket || generation !== this.generation || !this._ready()) throw safeError('WA_CONNECTION_CHANGED', 'A conexão mudou ao consultar participantes.', true);
    return result.map(item => item.identifiers.some(id => this.conflicts.has(id)) ? { ...item, ambiguous: true, phone: null } : item);
  }
  _saveRegistry() {
    // Pending proofs are also saved in queue jobs. Bound this supplementary receipt cache.
    const entries = [...this.registry.values()].slice(-5000); this.registry = new Map(entries.map(entry => [entry.messageId, entry]));
    this.store?.setSetting('wa.messageRegistry', entries);
  }
  _receipt(messageId, status, remoteJid) {
    const entry = this.registry.get(messageId); if (!entry) return;
    const remote = normalizeJid(remoteJid);
    if (remote && remote !== entry.targetId && this.aliases.get(remote) !== entry.targetId) return;
    if (entry.status === 'delivered' || entry.status === status) return;
    entry.status = status; entry.at = this.now(); this._saveRegistry();
    const receipt = { messageId, status, at: entry.at, confirmationScope: status === 'delivered' ? 'whatsapp-delivery-receipt' : 'whatsapp-server-ack' };
    this.pending.get(messageId)?.settle(receipt); this.emit('receipt', receipt);
  }
  _uncertain(messageId, code) {
    const entry = this.registry.get(messageId); if (!entry || ['accepted', 'delivered'].includes(entry.status)) return;
    entry.status = 'uncertain'; entry.code = code; this._saveRegistry();
    this.pending.get(messageId)?.settle({ status: 'uncertain', messageId, code, confirmationScope: 'not-confirmed' });
    this._diagnostic('send', code, 'Não há confirmação segura do resultado. Revise antes de reenviar.');
  }
  _settlePending(code) { for (const id of [...this.pending.keys()]) this._uncertain(id, code); }
  async sendInvite(contact, text, { clientMessageId, signal, beforeSubmit } = {}) {
    if (this.inflightInvites.has(clientMessageId)) return this.inflightInvites.get(clientMessageId);
    const promise = this._sendInvite(contact, text, { clientMessageId, signal, beforeSubmit });
    this.inflightInvites.set(clientMessageId, promise);
    try { return await promise; } finally { if (this.inflightInvites.get(clientMessageId) === promise) this.inflightInvites.delete(clientMessageId); }
  }
  async _sendInvite(contact, text, { clientMessageId, signal, beforeSubmit } = {}) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(String(clientMessageId || ''))) throw safeError('WA_MESSAGE_ID_REQUIRED', 'Identificador único do envio ausente ou inválido.');
    if (this.registry.has(clientMessageId)) return this.reconcile(clientMessageId);
    this.testConnection(); const socket = this.socket; const generation = this.generation;
    const registered = this.store?.get('contacts', contact?.id);
    if (!registered || registered.externalId !== contact.externalId || registered.simulation || registered.externalId?.endsWith('@simulation') || this.store?.getMode?.() === 'simulated') throw safeError('WA_CONTACT_NOT_REGISTERED', 'O destinatário não pertence ao cadastro real desta aplicação.');
    if (!registered.authorized || registered.blocked || registered.optOut || registered.muted || registered.ambiguous || registered.self) throw safeError('WA_RECIPIENT_NOT_ELIGIBLE', 'Contato sem autorização, bloqueado, silenciado, ambíguo ou pertencente à conta conectada.');
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw safeError('WA_INVALID_TEXT', 'A mensagem deve conter de 1 a 16.000 caracteres.');
    const identifiers = [...new Set([registered.externalId, ...(registered.identifiers || [])].map(normalizeJid).filter(Boolean))];
    const phones = new Set(identifiers.map(phoneFromJid).filter(Boolean));
    for (const id of identifiers) if (id.endsWith('@lid')) { const mapped = normalizeJid(this.aliases.get(id) || await socket.signalRepository?.lidMapping?.getPNForLID?.(id)); if (phoneFromJid(mapped)) phones.add(phoneFromJid(mapped)); }
    const phone = String(registered.phone || '').replace(/^\+/, '');
    if (phones.size !== 1 || !phones.has(phone) || identifiers.some(id => this.conflicts.has(id)) || !/^\d{8,15}$/.test(phone)) throw safeError('WA_IDENTITY_UNRESOLVED', 'Não foi possível resolver um número único e confiável para este contato. Nenhum destinatário foi substituído.');
    const targetId = `${phone}@s.whatsapp.net`;
    if (targetId === normalizeJid(socket.user?.id)) throw safeError('WA_SELF_RECIPIENT', 'A própria conta conectada foi excluída dos convites.');
    if (signal?.aborted) throw safeError('WA_CANCELLED', 'Envio cancelado antes da submissão.');
    if (socket !== this.socket || generation !== this.generation || !this._ready()) throw safeError('WA_CONNECTION_CHANGED', 'A conexão mudou antes do envio.', true);
    // Caller atomically revalidates campaign, consent, stop flag, schedule and claims here.
    if (beforeSubmit) await beforeSubmit();
    if (signal?.aborted || socket !== this.socket || generation !== this.generation || !this._ready()) throw safeError('WA_CANCELLED', 'Envio cancelado ou conexão alterada antes da submissão.');
    const latest = this.store.get('contacts', contact.id);
    if (!latest?.authorized || latest.blocked || latest.optOut || latest.muted || latest.ambiguous || latest.self || latest.phone !== registered.phone || latest.externalId !== registered.externalId) throw safeError('WA_RECIPIENT_CHANGED', 'A autorização ou a identidade do contato mudou antes do envio.');
    this.registry.set(clientMessageId, { messageId: clientMessageId, targetId, status: 'uncertain', at: this.now() }); this._saveRegistry();
    let settle;
    const outcome = new Promise(resolve => { let finished = false; const timer = setTimeout(() => finish({ status: 'uncertain', messageId: clientMessageId, code: 'WA_ACK_TIMEOUT', confirmationScope: 'not-confirmed' }), this.ackTimeoutMs);
      const finish = value => { if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted); this.pending.delete(clientMessageId); resolve(value); };
      const aborted = () => finish({ status: 'uncertain', messageId: clientMessageId, code: 'WA_ABORTED_AFTER_SUBMISSION', confirmationScope: 'not-confirmed' });
      settle = finish; this.pending.set(clientMessageId, { settle }); signal?.addEventListener('abort', aborted, { once: true });
    });
    try {
      // Exactly one transport call. Resolution alone is not a server ACK or delivery proof.
      Promise.resolve(socket.sendMessage(targetId, { text }, { messageId: clientMessageId })).then(message => { if (message?.message) { this.sentMessages.set(clientMessageId, message.message); if (this.sentMessages.size > 200) this.sentMessages.delete(this.sentMessages.keys().next().value); } }).catch(() => this._guardEvent(() => this._uncertain(clientMessageId, 'WA_SUBMISSION_RESULT_UNCERTAIN')));
    } catch { this._guardEvent(() => this._uncertain(clientMessageId, 'WA_SUBMISSION_RESULT_UNCERTAIN')); }
    return outcome;
  }
  async reconcile(messageId) {
    const entry = this.registry.get(messageId);
    return entry ? { status: ['accepted', 'delivered'].includes(entry.status) ? entry.status : 'uncertain', messageId, confirmationScope: entry.status === 'delivered' ? 'whatsapp-delivery-receipt' : entry.status === 'accepted' ? 'whatsapp-server-ack' : 'not-confirmed' } : { status: 'uncertain', messageId, confirmationScope: 'history-not-available', code: 'WA_NO_RELIABLE_HISTORY' };
  }
  async _incoming(message, socket, generation) {
    if (message.key?.fromMe || !message.key?.id || !normalizeJid(message.key?.remoteJid)) return;
    const body = message.message?.conversation ?? message.message?.extendedTextMessage?.text;
    if (typeof body !== 'string') return;
    const context = message.message?.extendedTextMessage?.contextInfo;
    if (context?.isForwarded || context?.forwardingScore > 0) return;
    const identity = await this._participant({ id: message.key.remoteJid, phoneNumber: message.key.remoteJidAlt, notify: message.pushName }, socket);
    if (generation === this.generation && socket === this.socket && identity?.phone && !identity.ambiguous) this.emit('incoming', { ...identity, senderId: identity.externalId, messageId: message.key.id, text: body, private: true, isGroup: false, fromMe: false, forwarded: false, verified: true, identityVerified: true, at: this.now() });
  }
}

module.exports = { WhatsAppAdapter, EncryptedAuthStore, normalizeJid, phoneFromJid };
