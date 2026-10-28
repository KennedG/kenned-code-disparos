'use strict';

const { EventEmitter } = require('node:events');

/** Explicitly selected, isolated test transport. It never imports Baileys. */
class SimulatedAdapter extends EventEmitter {
  constructor({ store, now = Date.now, outcomes = {} } = {}) {
    super(); Object.assign(this, { store, now, outcomes }); this.minimumSpacingMs = 3000; this.seeded = false; this.groups = []; this.participantsByGroup = {};
    this.registry = new Map(this.store?.getSetting('simulation.messageRegistry', []) || []);
    this.status = { mode: 'simulated', state: 'disconnected', ready: false, detail: 'SIMULAÇÃO — DADOS FICTÍCIOS. Nenhuma mensagem real será enviada.' };
  }
  _status(connected) { this.status = { mode: 'simulated', state: connected ? 'connected' : 'disconnected', ready: connected, detail: 'SIMULAÇÃO — DADOS FICTÍCIOS. Nenhuma mensagem real será enviada.' }; this.emit('status', this.status); return this.status; }
  async connect() { return this._status(true); }
  async disconnect() { return this._status(false); }
  async shutdown() { await this.disconnect(); }
  testConnection() { if (!this.status.ready) throw Object.assign(new Error('Conecte a simulação antes de testar.'), { code: 'SIMULATION_DISCONNECTED', confirmedFailure: true, retryable: true, submitted: false }); return { ...this.status, testedAt: this.now() }; }
  testSimulation() {
    this.seeded = true;
    this.groups = [{ id: 'grupo-exemplo@simulation', name: 'Grupo de teste — SIMULAÇÃO', participantCount: 3, simulation: true }];
    this.participantsByGroup = { 'grupo-exemplo@simulation': [1, 2, 3].map(n => ({ externalId: `contato-00${n}@simulation`, identifiers: [`contato-00${n}@simulation`], phone: `551199999000${n}`, name: `Contato fictício ${n}`, displayName: `Contato fictício ${n}`, self: false, ambiguous: false, simulation: true })) };
    this.store?.setSetting('simulation.fixturesEnabled', true);
    return { groups: structuredClone(this.groups), participantsByGroup: structuredClone(this.participantsByGroup), participants: structuredClone(this.participantsByGroup['grupo-exemplo@simulation']) };
  }
  async listGroups() { this.testConnection(); if (!this.seeded && this.store?.getSetting('simulation.fixturesEnabled', false)) this.testSimulation(); return structuredClone(this.groups); }
  async listParticipants(groupId) { this.testConnection(); if (!this.seeded && this.store?.getSetting('simulation.fixturesEnabled', false)) this.testSimulation(); if (!this.participantsByGroup[groupId]) throw Object.assign(new Error('Grupo de simulação não encontrado. Crie os dados de teste explicitamente.'), { code: 'SIMULATION_GROUP_NOT_FOUND', confirmedFailure: true }); return structuredClone(this.participantsByGroup[groupId]); }
  async sendInvite(contact, text, { clientMessageId, signal, beforeSubmit } = {}) {
    this.testConnection();
    const fixture = /^contato-00([123])@simulation$/.exec(contact?.externalId || '');
    const fixturePhone = fixture ? `551199999000${fixture[1]}` : null;
    if (!fixture || contact.phone !== fixturePhone || (contact.identifiers || []).some(id => id !== contact.externalId && id !== `${fixturePhone}@s.whatsapp.net`)) throw Object.assign(new Error('A simulação só aceita seus próprios contatos fictícios; destinatários reais foram bloqueados.'), { code: 'SIMULATION_REAL_RECIPIENT_BLOCKED', confirmedFailure: true, submitted: false });
    const saved = this.store?.get('contacts', contact.id) || contact;
    if (!saved.authorized || saved.blocked || saved.optOut || saved.muted || saved.ambiguous || saved.self) throw Object.assign(new Error('Contato de teste não autorizado ou bloqueado.'), { code: 'SIMULATION_CONTACT_BLOCKED', confirmedFailure: true, submitted: false });
    if (!clientMessageId || typeof text !== 'string' || !text.trim()) throw Object.assign(new Error('Identificador e texto são obrigatórios.'), { code: 'SIMULATION_INVALID_MESSAGE', confirmedFailure: true, submitted: false });
    if (this.registry.has(clientMessageId)) return this.reconcile(clientMessageId);
    if (signal?.aborted) throw Object.assign(new Error('Envio cancelado.'), { code: 'CANCELLED', confirmedFailure: true, submitted: false });
    if (beforeSubmit) await beforeSubmit();
    if (!this.status.ready || signal?.aborted) throw Object.assign(new Error('Envio interrompido antes da simulação.'), { code: 'CANCELLED', confirmedFailure: true, submitted: false });
    const configured = this.outcomes[contact.externalId] || 'accepted';
    const result = { status: configured === 'uncertain' ? 'uncertain' : configured === 'delivered' ? 'delivered' : 'accepted', messageId: clientMessageId, confirmationScope: 'simulated-only', simulated: true };
    this.registry.set(clientMessageId, result); this.store?.setSetting('simulation.messageRegistry', [...this.registry.entries()].slice(-5000));
    if (result.status !== 'uncertain') queueMicrotask(() => this.emit('receipt', { ...result, at: this.now() }));
    return result;
  }
  async reconcile(messageId) { return this.registry.get(messageId) || { status: 'uncertain', messageId, confirmationScope: 'simulated-only', simulated: true }; }
}

module.exports = { SimulatedAdapter };
