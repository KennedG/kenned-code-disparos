'use strict';

const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');

/** A local test transport. Its groups and receipts never represent WhatsApp. */
class SimulatedAdapter extends EventEmitter {
  constructor({ store, delayMs = 20 } = {}) {
    super();
    this.store = store;
    this.delayMs = delayMs;
    this.nextOutcome = null;
    this.replies = [];
    this.sent = [];
    this.automaticMessages = new Set();
    this.replyContexts = new Map();
    this.ownNumber = String(store?.getSetting?.('simulationOwnNumber', '') || '');
    this.searchCapture = { enabled: false, importHistory: false, groupIds: null, commandGroupIds: null };
    this.status = { state: 'disconnected', mode: 'simulated', detail: 'Simulação local: nenhum envio pelo WhatsApp.' };
  }

  _status(state, detail, extras = {}) {
    this.status = { state, ...(state === 'disconnected' ? { reasonCode: 'manual', at: new Date().toISOString(), manual: true, retryable: false } : {}), ...extras, mode: 'simulated', simulation: true, ownNumber: this.ownNumber, ownAccountId: this.ownNumber ? `${this.ownNumber}@s.whatsapp.net` : '', detail };
    this.emit('status', this.status);
  }

  async connect() {
    this._status('connected', 'Simulação local conectada. Grupos e resultados são fictícios.');
    return this.status;
  }

  async disconnect({ reasonCode = 'manual', manual = reasonCode === 'manual' } = {}) {
    this._status('disconnected', 'Simulação desconectada. Nenhum envio real foi realizado.', { reasonCode, manual: Boolean(manual), retryable: !manual && !['restricted', 'session_expired'].includes(reasonCode) });
  }

  async listGroups() {
    return Array.from({ length: 15 }, (_, index) => ({
      id: `sim-${String(index + 1).padStart(2, '0')}@simulation`,
      name: `Grupo simulado ${String(index + 1).padStart(2, '0')}`,
      authorized: false,
      simulation: true,
      mode: 'simulated'
    }));
  }

  setNextOutcome(outcome) {
    if (!['confirmed', 'failed', 'uncertain'].includes(outcome)) throw new Error('Resultado de simulação inválido.');
    this.nextOutcome = outcome;
  }

  setOwnAccount(number) {
    if (!/^[1-9]\d{9,14}$/.test(String(number || ''))) throw new Error('Telefone da conta de simulação inválido.');
    this.ownNumber = String(number);
    this._status(this.status.state, this.status.detail);
    return this.getOwnAccount();
  }

  getOwnAccount() {
    return { id: this.ownNumber ? `${this.ownNumber}@s.whatsapp.net` : '', phone: this.ownNumber, mode: 'simulated', simulation: true };
  }

  isTrustedSelfContext(context) {
    return context?.simulation === true && context.fromMe === true && context.trustedSelf === true && Boolean(this.ownNumber) && context.senderNumber === this.ownNumber && context.accountId === `${this.ownNumber}@s.whatsapp.net`;
  }

  async resolveRecipient(number) {
    const digits = String(number || '');
    if (!/^[1-9]\d{9,14}$/.test(digits)) throw Object.assign(new Error('Telefone privado inválido. Use código do país e DDD.'), { code: 'WA_RECIPIENT_INVALID', safeToRetry: false });
    if (this.status.state !== 'connected') throw Object.assign(new Error('Simulação desconectada.'), { code: 'WA_RECIPIENT_OFFLINE', safeToRetry: true });
    return { jid: `${digits}@s.whatsapp.net`, phone: digits, requestedPhone: digits, isSelf: digits === this.ownNumber, mode: 'simulated', simulation: true, resolutionSource: 'simulation-only' };
  }

  async resolveReplyRecipient(context) {
    if (this.status.state !== 'connected') throw Object.assign(new Error('Simulação desconectada.'), { code: 'WA_RECIPIENT_OFFLINE', safeToRetry: true });
    const saved = this.replyContexts.get(context?.replyProof);
    if (!saved || context.isGroup !== false || context.chatId !== saved.chatId || context.senderId !== saved.senderId || String(context.senderNumber || '') !== saved.senderNumber) throw Object.assign(new Error('Origem privada simulada inválida.'), { code: 'WA_REPLY_CONTEXT_INVALID', safeToRetry: false, definitive: true });
    return { jid: saved.chatId, phone: saved.senderNumber, requestedPhone: saved.senderNumber, isSelf: saved.fromMe && saved.senderNumber === this.ownNumber, mode: 'simulated', simulation: true, resolutionSource: 'simulation-inbound' };
  }

  async resolveSearchRecipient(number, replyContext) {
    if (!replyContext) return this.resolveRecipient(number);
    const resolved = await this.resolveReplyRecipient(replyContext);
    if (![resolved.jid, resolved.phone].includes(String(number || ''))) throw Object.assign(new Error('O destinatário difere do comando simulado.'), { code: 'WA_REPLY_RECIPIENT_MISMATCH', safeToRetry: false, definitive: true });
    return resolved;
  }

  _markAutomatic(messageId, kind = 'simulated') {
    this.store?.registerOutboundMessageId?.(messageId, { kind, at: Date.now(), storageMode: 'simulated' });
    this.automaticMessages.add(messageId);
    while (this.automaticMessages.size > 10000) this.automaticMessages.delete(this.automaticMessages.values().next().value);
  }

  async send(groupId, item, media, {beforeSubmit}={}) {
    item=beforeSubmit?.()||item;
    if (this.status.state !== 'connected') {
      throw Object.assign(new Error('Simulação desconectada.'), { safeToRetry: true });
    }
    if (!/^sim-\d+@simulation$/.test(groupId)) {
      throw Object.assign(new Error('O modo de simulação aceita apenas grupos simulados.'), { safeToRetry: false });
    }
    if (!item || !['text', 'image', 'video', 'document'].includes(item.type)) {
      throw Object.assign(new Error('Tipo de conteúdo inválido.'), { safeToRetry: false });
    }
    if (item.type !== 'text' && !media) {
      throw Object.assign(new Error('Mídia não encontrada na biblioteca.'), { safeToRetry: false });
    }
    const outcome = this.nextOutcome || this.store?.getSetting('simulationNextOutcome', 'confirmed') || 'confirmed';
    this.nextOutcome = null;
    if (this.store?.getSetting('simulationNextOutcome', null)) this.store.setSetting('simulationNextOutcome', null);
    if (outcome === 'failed') {
      throw Object.assign(new Error('Falha temporária simulada antes do envio.'), { safeToRetry: true });
    }
    const messageId = item.clientMessageId || `SIM-${randomUUID()}`;
    this._markAutomatic(messageId);
    this.sent.push({ groupId, item: { ...item }, mediaId: media?.id, messageId, at: new Date().toISOString(), simulation: true });
    if (this.sent.length > 1000) this.sent.splice(0, this.sent.length - 1000);
    if (this.delayMs > 0) await new Promise(resolve => setTimeout(resolve, this.delayMs));
    const result = { status: outcome === 'uncertain' ? 'uncertain' : 'confirmed', messageId, mode: 'simulated', simulation: true };
    if (result.status === 'confirmed') this.emit('receipt', { messageId, status: 'confirmed', confirmationScope: 'simulation-only', mode: 'simulated', simulation: true });
    return result;
  }

  async sendPrivateContent(number,item,media,{beforeSubmit}={}) {
    const target=await this.resolveRecipient(String(number));item=beforeSubmit?.()||item;
    if(item.type!=='text'&&!media)throw Object.assign(new Error('Mídia simulada ausente.'),{definitive:true,submitted:false});
    const result=await this.sendPrivate(target.phone,item.text||item.caption||`Arquivo simulado: ${media.name}`,{clientMessageId:item.clientMessageId});
    const entry=this.sent.find(e=>e.messageId===result.messageId);if(entry){entry.item={...item};entry.mediaId=media?.id;}return result;
  }

  async sendPrivate(number, text, { clientMessageId, beforeSubmit } = {}) {
    if (!/^[1-9]\d{9,14}$/.test(String(number || ''))) throw Object.assign(new Error('Telefone privado inválido. Use código do país e DDD.'), { safeToRetry: false });
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw Object.assign(new Error('Alerta privado inválido.'), { safeToRetry: false });
    if (this.status.state !== 'connected') throw Object.assign(new Error('Simulação desconectada.'), { safeToRetry: true });
    beforeSubmit?.();
    const outcome = this.nextOutcome || 'confirmed';
    this.nextOutcome = null;
    if (outcome === 'failed') throw Object.assign(new Error('Falha temporária simulada antes do alerta.'), { safeToRetry: true });
    const messageId = clientMessageId || `SIM-PRIVATE-${randomUUID()}`;
    const existing = this.sent.find(entry => entry.messageId === messageId);
    if (existing) {
      if (existing.privateNumber !== String(number)) throw Object.assign(new Error('Identificador do alerta já pertence a outro destino.'), { safeToRetry: false });
      return { status: existing.status || 'uncertain', messageId, simulation: true };
    }
    this._markAutomatic(messageId);
    this.sent.push({ privateNumber: String(number), text, messageId, at: new Date().toISOString(), simulation: true, status: outcome });
    if (this.sent.length > 1000) this.sent.splice(0, this.sent.length - 1000);
    if (this.delayMs > 0) await new Promise(resolve => setTimeout(resolve, this.delayMs));
    const status = outcome === 'uncertain' ? 'uncertain' : 'confirmed';
    if (status === 'confirmed') this.emit('receipt', { messageId, status, confirmationScope: 'simulation-only', mode: 'simulated', simulation: true });
    return { status, messageId, simulation: true };
  }

  configureSearchCapture({ enabled = false, importHistory = false, groupIds, commandGroupIds } = {}) {
    const normalize = value => Array.isArray(value) ? new Set(value.filter(id => typeof id === 'string')) : null;
    this.searchCapture = { enabled: enabled === true, importHistory: importHistory === true, groupIds: normalize(groupIds), commandGroupIds: normalize(commandGroupIds) };
    return { enabled: this.searchCapture.enabled, importHistory: this.searchCapture.importHistory, ...this.getSearchCapabilities() };
  }

  getSearchCapabilities() {
    return { searchCapture: true, live: true, edits: true, deletes: true, opportunisticHistory: true, communityGroups: 'simulation-only', historySupport: 'simulated', complete: false, originalMessageLinks: false, official: false, simulation: true };
  }

  _searchChatAllowed(chatId, history = false) {
    if (!this.searchCapture.enabled || typeof chatId !== 'string') return false;
    const isGroup = chatId.endsWith('@simulation');
    if (!isGroup) return !history && /^\d+(?::\d+)?@(s\.whatsapp\.net|lid)$/.test(chatId);
    const { groupIds, commandGroupIds } = this.searchCapture;
    return groupIds === null || groupIds.has(chatId) || (!history && (commandGroupIds === null || commandGroupIds.has(chatId)));
  }

  async sendSearchText(target, text, { clientMessageId, replyContext } = {}) {
    if (this.status.state !== 'connected') throw Object.assign(new Error('Simulação desconectada.'), { safeToRetry: true });
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw Object.assign(new Error('Resultado da busca inválido.'), { safeToRetry: false });
    if (typeof target !== 'string' || !(/^\d{10,15}$/.test(target) || /^\d+(?::\d+)?@(s\.whatsapp\.net|lid)$/.test(target) || /^sim-\d+@simulation$/.test(target))) throw Object.assign(new Error('Destinatário da busca inválido para simulação.'), { safeToRetry: false });
    if (replyContext) { const resolved = await this.resolveSearchRecipient(target, replyContext); target = resolved.jid; }
    const targetId = /^\d{10,15}$/.test(target) ? `${target}@s.whatsapp.net` : target.replace(/:\d+(?=@)/, '');
    const messageId = clientMessageId || `SIM-SEARCH-${randomUUID()}`;
    const existing = this.sent.find(entry => entry.messageId === messageId);
    if (existing) {
      if (existing.targetId !== targetId) throw Object.assign(new Error('Identificador da busca já pertence a outro destino.'), { safeToRetry: false });
      return { status: existing.status, messageId, simulation: true };
    }
    const outcome = this.nextOutcome || 'confirmed';
    this.nextOutcome = null;
    if (outcome === 'failed') throw Object.assign(new Error('Falha temporária simulada antes da resposta da busca.'), { safeToRetry: true });
    this._markAutomatic(messageId);
    this.sent.push({ targetId, chatId: targetId, privateNumber: /^\d+@s\.whatsapp\.net$/.test(targetId) ? targetId.split('@')[0] : undefined, text, messageId, status: outcome, search: true, simulation: true, at: new Date().toISOString() });
    if (this.sent.length > 1000) this.sent.splice(0, this.sent.length - 1000);
    if (this.delayMs > 0) await new Promise(resolve => setTimeout(resolve, this.delayMs));
    if (outcome === 'confirmed') this.emit('receipt', { messageId, status: 'confirmed', confirmationScope: 'simulation-only', mode: 'simulated', simulation: true });
    return { status: outcome, messageId, simulation: true };
  }

  setNetworkOnline(online) { return this.setNetworkState({ online }); }

  setNetworkState(value) {
    const online = typeof value === 'boolean' ? value : value?.online;
    if (typeof online !== 'boolean') throw new Error('Estado de rede inválido.');
    if (online === false && this.status.state === 'connected') this._status('disconnected', 'Queda de rede simulada: nenhum envio real.', { reasonCode: 'internet', manual: false, retryable: true, errorCode: 'NETWORK_OFFLINE' });
    return this.status;
  }

  async reply(chatId, text, { replyContext, clientMessageId } = {}) {
    if (replyContext) {
      const result = await this.sendSearchText(chatId, String(text), { replyContext, clientMessageId });
      if (!this.replies.some(reply => reply.messageId === result.messageId)) {
        this.replies.push({ chatId, text: String(text), messageId: result.messageId, status: result.status, at: new Date().toISOString(), simulation: true });
        if (this.replies.length > 1000) this.replies.splice(0, this.replies.length - 1000);
        this.emit('reply', this.replies[this.replies.length - 1]);
      }
      return result;
    }
    if (this.status.state !== 'connected') throw Object.assign(new Error('Simulação desconectada.'), { safeToRetry: true });
    const messageId = `SIM-REPLY-${randomUUID()}`;
    this._markAutomatic(messageId, 'simulated-control-reply');
    this.replies.push({ chatId, text: String(text), messageId, at: new Date().toISOString(), simulation: true });
    if (this.replies.length > 1000) this.replies.splice(0, this.replies.length - 1000);
    this.emit('reply', this.replies[this.replies.length - 1]);
    return { status: 'confirmed', messageId, mode: 'simulated', simulation: true };
  }

  async downloadIncoming(context) {
    const media = context?.simulatedMedia;
    if (!media || !Buffer.isBuffer(media.buffer)) throw new Error('Anexe uma mídia de teste válida.');
    return { buffer: media.buffer, name: media.name || 'anexo-simulado', mime: media.mime || 'application/octet-stream', type: media.type || 'document' };
  }

  /** Test-only ingress; authorization still runs through the command controller. */
  injectIncoming(context = {}) {
    const senderNumber = context.fromMe === true ? this.ownNumber : String(context.senderNumber || '').replace(/\D/g, '');
    const event = this._offerContext({
      messageId: context.messageId || `SIM-IN-${randomUUID()}`,
      senderNumber,
      verified: context.verified ?? true,
      isGroup: context.isGroup ?? false,
      forwarded: context.forwarded ?? false,
      fromMe: context.fromMe ?? false,
      chatId: context.chatId || `${senderNumber}@s.whatsapp.net`,
      text: context.text || '',
      type: context.type || 'text',
      timestamp: context.timestamp || Date.now(),
      ...context,
      simulation: true
    }, context.history === true || context.historical === true);
    if (!event.history && event.isGroup === false) {
      event.replyProof = `SIM-REPLY-PROOF-${randomUUID()}`;
      this.replyContexts.set(event.replyProof, { chatId: event.chatId, senderId: event.senderId, senderNumber: event.senderNumber, fromMe: event.fromMe });
      while (this.replyContexts.size > 10000) this.replyContexts.delete(this.replyContexts.keys().next().value);
    }
    if (!event.history) this.emit('incoming', event);
    if (this._searchChatAllowed(event.chatId) && !event.history) this.emit('offerMessage', event);
    return event;
  }

  _offerContext(context = {}, history = false) {
    const fromMe = context.fromMe === true;
    const number = fromMe ? this.ownNumber : String(context.senderNumber || '').replace(/\D/g, '');
    const senderId = context.senderId || (number ? `${number}@s.whatsapp.net` : '');
    const messageId = context.messageId || `SIM-OFFER-${randomUUID()}`;
    const automaticMessage = fromMe && (this.automaticMessages.has(messageId) || this.store?.isOutboundMessageId?.(messageId) === true);
    return { ...context, messageId, chatId: context.chatId || 'sim-01@simulation', isGroup: context.isGroup ?? (context.chatId || 'sim-01@simulation').endsWith('@simulation'), senderId: fromMe ? `${number}@s.whatsapp.net` : senderId, senderIds: context.senderIds || [senderId].filter(Boolean), identityVerified: context.identityVerified ?? context.verified ?? Boolean(senderId), senderNumber: number, verified: context.verified ?? Boolean(number), pushName: context.pushName || context.displayName || '', displayName: context.displayName || context.pushName || '', savedName: context.savedName || '', text: context.text || '', type: context.type || 'text', timestamp: context.timestamp ?? Date.now(), capturedAt: context.capturedAt ?? Date.now(), forwarded: context.forwarded === true, fromMe, trustedSelf: fromMe && Boolean(number), selfChat: Boolean(this.ownNumber) && context.chatId === `${this.ownNumber}@s.whatsapp.net`, automaticMessage, machineGenerated: automaticMessage, accountNumber: this.ownNumber, ownAccountNumber: this.ownNumber, accountId: this.ownNumber ? `${this.ownNumber}@s.whatsapp.net` : '', ownAccountId: this.ownNumber ? `${this.ownNumber}@s.whatsapp.net` : '', history, revisionAt: context.revisionAt ?? null, mode: 'simulated', simulation: true };
  }

  injectOfferMessage(context = {}) {
    const event = this._offerContext(context);
    if (this._searchChatAllowed(event.chatId)) this.emit('offerMessage', event);
    return event;
  }

  injectOfferUpdate(context = {}) {
    const event = this._offerContext({ ...context, revisionAt: context.revisionAt ?? Date.now() });
    delete event.timestamp;
    if (this._searchChatAllowed(event.chatId, true)) this.emit('offerMessageUpdate', event);
    return event;
  }

  injectOfferDelete(context = {}) {
    const event = { ...context, chatId: context.chatId || 'sim-01@simulation', deletedAt: context.deletedAt ?? Date.now(), simulation: true };
    if (this._searchChatAllowed(event.chatId, true)) this.emit('offerMessageDelete', event);
    return event;
  }

  injectOfferHistory(messages = [], metadata = {}) {
    if (!this.searchCapture.enabled || !this.searchCapture.importHistory) return [];
    const values = messages.slice(0, 5000).map(message => this._offerContext(message, true)).filter(message => this._searchChatAllowed(message.chatId, true));
    for (let offset = 0; offset < values.length; offset += 100) this.emit('offerHistory', { ...metadata, messages: values.slice(offset, offset + 100), source: 'simulated-history', complete: false, at: Date.now(), simulation: true });
    this.emit('captureHistoryStatus', { source: 'simulated-history', status: messages.length > 5000 ? 'truncated' : 'batch-received', complete: false, at: Date.now(), simulation: true });
    return values;
  }
}

module.exports = { SimulatedAdapter };
