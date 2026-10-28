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
    this.searchCapture = { enabled: false, importHistory: false, groupIds: null, commandGroupIds: null };
    this.status = { state: 'disconnected', mode: 'simulated', detail: 'Simulação local: nenhum envio pelo WhatsApp.' };
  }

  _status(state, detail, extras = {}) {
    this.status = { state, ...(state === 'disconnected' ? { reasonCode: 'manual', at: new Date().toISOString(), manual: true, retryable: false } : {}), ...extras, mode: 'simulated', detail };
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
      simulation: true
    }));
  }

  setNextOutcome(outcome) {
    if (!['confirmed', 'failed', 'uncertain'].includes(outcome)) throw new Error('Resultado de simulação inválido.');
    this.nextOutcome = outcome;
  }

  async send(groupId, item, media) {
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
    this.sent.push({ groupId, item: { ...item }, mediaId: media?.id, messageId, at: new Date().toISOString(), simulation: true });
    if (this.sent.length > 1000) this.sent.splice(0, this.sent.length - 1000);
    if (this.delayMs > 0) await new Promise(resolve => setTimeout(resolve, this.delayMs));
    const result = { status: outcome === 'uncertain' ? 'uncertain' : 'confirmed', messageId };
    if (result.status === 'confirmed') this.emit('receipt', { messageId, status: 'confirmed', simulation: true });
    return result;
  }

  async sendPrivate(number, text, { clientMessageId } = {}) {
    if (!/^\d{10,15}$/.test(String(number || ''))) throw Object.assign(new Error('Telefone privado inválido. Use código do país e DDD.'), { safeToRetry: false });
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw Object.assign(new Error('Alerta privado inválido.'), { safeToRetry: false });
    if (this.status.state !== 'connected') throw Object.assign(new Error('Simulação desconectada.'), { safeToRetry: true });
    const outcome = this.nextOutcome || 'confirmed';
    this.nextOutcome = null;
    if (outcome === 'failed') throw Object.assign(new Error('Falha temporária simulada antes do alerta.'), { safeToRetry: true });
    const messageId = clientMessageId || `SIM-PRIVATE-${randomUUID()}`;
    const existing = this.sent.find(entry => entry.messageId === messageId);
    if (existing) return { status: existing.status || 'uncertain', messageId, simulation: true };
    this.sent.push({ privateNumber: String(number), text, messageId, at: new Date().toISOString(), simulation: true, status: outcome });
    if (this.sent.length > 1000) this.sent.splice(0, this.sent.length - 1000);
    if (this.delayMs > 0) await new Promise(resolve => setTimeout(resolve, this.delayMs));
    const status = outcome === 'uncertain' ? 'uncertain' : 'confirmed';
    if (status === 'confirmed') this.emit('receipt', { messageId, status, simulation: true });
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

  async sendSearchText(target, text, { clientMessageId } = {}) {
    if (this.status.state !== 'connected') throw Object.assign(new Error('Simulação desconectada.'), { safeToRetry: true });
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw Object.assign(new Error('Resultado da busca inválido.'), { safeToRetry: false });
    if (typeof target !== 'string' || !(/^\d{10,15}$/.test(target) || /^\d+(?::\d+)?@(s\.whatsapp\.net|lid)$/.test(target) || /^sim-\d+@simulation$/.test(target))) throw Object.assign(new Error('Destinatário da busca inválido para simulação.'), { safeToRetry: false });
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
    this.sent.push({ targetId, chatId: targetId, privateNumber: /^\d+@s\.whatsapp\.net$/.test(targetId) ? targetId.split('@')[0] : undefined, text, messageId, status: outcome, search: true, simulation: true, at: new Date().toISOString() });
    if (this.sent.length > 1000) this.sent.splice(0, this.sent.length - 1000);
    if (this.delayMs > 0) await new Promise(resolve => setTimeout(resolve, this.delayMs));
    if (outcome === 'confirmed') this.emit('receipt', { messageId, status: 'confirmed', simulation: true });
    return { status: outcome, messageId, simulation: true };
  }

  setNetworkOnline(online) { return this.setNetworkState({ online }); }

  setNetworkState(value) {
    const online = typeof value === 'boolean' ? value : value?.online;
    if (typeof online !== 'boolean') throw new Error('Estado de rede inválido.');
    if (online === false && this.status.state === 'connected') this._status('disconnected', 'Queda de rede simulada: nenhum envio real.', { reasonCode: 'internet', manual: false, retryable: true, errorCode: 'NETWORK_OFFLINE' });
    return this.status;
  }

  async reply(chatId, text) {
    if (this.status.state !== 'connected') throw Object.assign(new Error('Simulação desconectada.'), { safeToRetry: true });
    this.replies.push({ chatId, text: String(text), at: new Date().toISOString(), simulation: true });
    if (this.replies.length > 1000) this.replies.splice(0, this.replies.length - 1000);
    this.emit('reply', this.replies[this.replies.length - 1]);
    return { status: 'confirmed', messageId: `SIM-REPLY-${randomUUID()}` };
  }

  async downloadIncoming(context) {
    const media = context?.simulatedMedia;
    if (!media || !Buffer.isBuffer(media.buffer)) throw new Error('Anexe uma mídia de teste válida.');
    return { buffer: media.buffer, name: media.name || 'anexo-simulado', mime: media.mime || 'application/octet-stream', type: media.type || 'document' };
  }

  /** Test-only ingress; authorization still runs through the command controller. */
  injectIncoming(context = {}) {
    const senderNumber = String(context.senderNumber || '').replace(/\D/g, '');
    const event = {
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
    };
    this.emit('incoming', event);
    if (this._searchChatAllowed(event.chatId) && !event.history) this.emit('offerMessage', this._offerContext(event));
    return event;
  }

  _offerContext(context = {}, history = false) {
    const number = String(context.senderNumber || '').replace(/\D/g, '');
    const senderId = context.senderId || (number ? `${number}@s.whatsapp.net` : '');
    return { ...context, messageId: context.messageId || `SIM-OFFER-${randomUUID()}`, chatId: context.chatId || 'sim-01@simulation', isGroup: context.isGroup ?? (context.chatId || 'sim-01@simulation').endsWith('@simulation'), senderId, senderIds: context.senderIds || [senderId].filter(Boolean), identityVerified: context.identityVerified ?? context.verified ?? Boolean(senderId), senderNumber: number, verified: context.verified ?? Boolean(number), pushName: context.pushName || context.displayName || '', displayName: context.displayName || context.pushName || '', savedName: context.savedName || '', text: context.text || '', type: context.type || 'text', timestamp: context.timestamp ?? Date.now(), capturedAt: context.capturedAt ?? Date.now(), forwarded: context.forwarded === true, fromMe: context.fromMe === true, history, revisionAt: context.revisionAt ?? null, simulation: true };
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
