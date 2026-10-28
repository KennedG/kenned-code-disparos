'use strict';

const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');

const CONTACT_CATEGORIES = Object.freeze(['Cliente Nerópolis', 'Lojista Camelódromo']);
const normalizePhone = value => String(value || '').replace(/[\s()+.\-]/g, '');
const validPhone = value => /^[1-9]\d{9,14}$/.test(value);
const text = (value, max) => String(value ?? '').trim().slice(0, max);
const fault = (message, code) => Object.assign(new Error(message), { code });

/**
 * Intake accepts adapter-verified, fresh private messages only. WhatsApp group
 * participants and display names never establish an account identity here.
 * No message body is stored, executed, or used as a contact name.
 */
class ContactIntake extends EventEmitter {
  constructor({ store, auth, now = () => Date.now() } = {}) {
    super();
    if (!store || !auth) throw new Error('Armazenamento e autorização são obrigatórios.');
    this.store = store;
    this.auth = auth;
    this.now = now;
    this.contactCache = null;
    this.cacheMode = null;
  }

  _mode() { return this.store.getStorageMode?.() || this.store.getSetting('integrationMode', 'whatsapp'); }
  _tx(fn) { return this.store.transaction ? this.store.transaction(fn) : fn(); }
  _assert(permission, actorId) { return this.auth.assertFor(actorId || this.auth.currentUser()?.id, permission); }
  _id(phone) { return `contact-pending:${this._mode()}:${phone}`; }
  invalidateContacts() { this.contactCache = null; this.cacheMode = null; }

  _contact(phone) {
    if (this.store.findContactByPhone) return this.store.findContactByPhone(phone);
    const mode = this._mode();
    if (!this.contactCache || this.cacheMode !== mode) {
      this.contactCache = new Map(this.store.listEntities('contacts').map(contact => [normalizePhone(contact.phone), contact]));
      this.cacheMode = mode;
    }
    return this.contactCache.get(phone);
  }

  _identity(ctx) {
    if (!ctx || ctx.isGroup !== false || ctx.fromMe !== false || ctx.verified !== true || ctx.identityVerified !== true ||
        ctx.history === true || ctx.historical === true || ctx.forwarded === true || ctx.automaticMessage === true || ctx.machineGenerated === true) return null;
    const mode = this._mode();
    if (mode === 'simulated' ? ctx.simulation !== true || ctx.mode !== 'simulated' : ctx.simulation === true || ctx.mode !== 'whatsapp') return null;
    const phone = normalizePhone(ctx.senderNumber);
    if (!validPhone(phone) || !text(ctx.messageId, 256)) return null;
    const chat = String(ctx.chatId || '');
    const direct = /^([1-9]\d{9,14})(?::\d+)?@s\.whatsapp\.net$/.exec(chat);
    // A LID is accepted only with the trusted PN supplied by the adapter. It
    // must never be converted into a pretend phone number by stripping @lid.
    if (direct ? direct[1] !== phone : !/^\d+(?::\d+)?@lid$/.test(chat)) return null;
    const at = Number(ctx.timestamp);
    if (!Number.isFinite(at) || at <= 0 || at > this.now() + 30000) return null;
    return { phone, chatId: chat, at };
  }

  handleIncoming(ctx) {
    const identity = this._identity(ctx);
    if (!identity) return false;
    const profileName = text(ctx.pushName || ctx.displayName || ctx.raw?.pushName, 120);
    const id = this._id(identity.phone);
    let created = false, changed = false;
    const pending = this._tx(() => {
      const existing = this.store.getEntity('contact_pending', id);
      if (existing) {
        // Resolve a late profile name without reopening/renotifying a pending
        // or previously dismissed contact. Preserve the original first time.
        if (existing.status === 'pending' && !existing.profileName && profileName) { changed = true; return this.store.saveEntity('contact_pending', { ...existing, profileName }); }
        return existing;
      }
      if (this._contact(identity.phone)) return null;
      const record = this.store.saveEntity('contact_pending', {
        id, phone: identity.phone, profileName, chatId: identity.chatId,
        firstMessageId: text(ctx.messageId, 256), firstContactAt: identity.at,
        createdAt: this.now(), status: 'pending', savedLocation: null,
        storageMode: this._mode(), simulation: this._mode() === 'simulated'
      });
      const notificationId = `contact-intake:${id}`;
      this.store.saveNotification({
        id: notificationId, event: 'new_contact', kind: 'contact_intake',
        pendingContactId: id, ownerOnly: true, at: this.now(),
        title: 'Kenned Code Disparos: novo contato',
        body: `O número ${identity.phone} entrou em contato. Abra Contatos para salvar e classificar.`,
        originalAt: identity.at, nativeStatus: 'pending', soundStatus: 'disabled',
        integrationMode: this._mode(), simulation: this._mode() === 'simulated'
      });
      this.store.saveEntity('contact_intake_events', {
        id: notificationId, pendingContactId: id, phone: identity.phone,
        kind: 'first_contact', status: 'pending', createdAt: this.now(),
        originalAt: identity.at, notificationId
      });
      created = true;
      return record;
    });
    if (!pending) return false;
    if (created) this.emit('localAlert', this.store.getEntity('notifications', `contact-intake:${id}`));
    if (created || changed) this.emit('change');
    return { created, pending };
  }

  listPendingContacts(filter = {}, actorId) {
    this._assert('contacts.view', actorId);
    const status = filter.status === 'all' ? undefined : filter.status || 'pending';
    if (status !== undefined && !['pending', 'saved', 'dismissed'].includes(status)) throw fault('Filtro de pendências inválido.', 'CONTACT_PENDING_FILTER_INVALID');
    const options = { ...filter, status, limit: Math.min(200, Math.max(1, Number(filter.limit) || 50)), offset: Math.max(0, Number(filter.offset) || 0) };
    return this.store.queryEntities('contact_pending', options);
  }

  savePendingContact(input = {}, actorId) {
    const pending = this.store.getEntity('contact_pending', input.id);
    if (!pending) throw fault('Pendência não encontrada neste modo de operação.', 'CONTACT_PENDING_NOT_FOUND');
    const existing = this._contact(pending.phone);
    const actor = this._assert(existing ? 'contacts.edit' : 'contacts.create', actorId);
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 120) throw fault('Informe um nome com até 120 caracteres.', 'CONTACT_NAME_INVALID');
    if (!CONTACT_CATEGORIES.includes(input.category)) throw fault('Selecione Cliente Nerópolis ou Lojista Camelódromo.', 'CONTACT_CATEGORY_INVALID');
    if (pending.status !== 'pending') throw fault('Esta pendência já foi resolvida. Edite o cadastro de contatos para alterá-la.', 'CONTACT_PENDING_CLOSED');
    const result = this._tx(() => {
      const saved = this.store.saveEntity('contacts', {
        ...existing, id: existing?.id || randomUUID(), name, phone: pending.phone,
        category: input.category, notes: existing?.notes || '',
        profileName: pending.profileName, firstContactAt: pending.firstContactAt,
        createdAt: existing?.createdAt || this.now(), updatedAt: this.now(),
        savedLocation: 'system', addressBookSupported: false
      });
      const persisted = this.store.getEntity('contacts', saved.id);
      if (!persisted || persisted.name !== name || persisted.phone !== pending.phone || persisted.category !== input.category) throw fault('O contato não foi persistido. A pendência foi preservada.', 'CONTACT_PERSISTENCE_FAILED');
      const resolved = this.store.saveEntity('contact_pending', {
        ...pending, status: 'saved', resolvedAt: this.now(), resolvedBy: actor.id,
        contactId: persisted.id, savedLocation: 'system'
      });
      this.store.addAudit({ id: randomUUID(), at: this.now(), userId: actor.id,
        action: 'contacts.intake.save', contactId: persisted.id,
        pendingContactId: pending.id, category: input.category, savedLocation: 'system' });
      return { contact: persisted, pending: resolved, savedLocation: 'system', addressBookSupported: false,
        message: 'Contato salvo no cadastro local do sistema. A integração não grava na agenda do WhatsApp.' };
    });
    this.invalidateContacts();
    this.emit('change');
    return result;
  }

  dismissPendingContact(input = {}, actorId) {
    const actor = this._assert('contacts.edit', actorId);
    const pending = this.store.getEntity('contact_pending', input.id);
    if (!pending) throw fault('Pendência não encontrada neste modo de operação.', 'CONTACT_PENDING_NOT_FOUND');
    if (pending.status !== 'pending') return pending;
    const result = this._tx(() => {
      const saved = this.store.saveEntity('contact_pending', { ...pending, status: 'dismissed', resolvedAt: this.now(), resolvedBy: actor.id });
      this.store.addAudit({ id: randomUUID(), at: this.now(), userId: actor.id, action: 'contacts.intake.dismiss', pendingContactId: pending.id });
      return saved;
    });
    this.emit('change');
    return result;
  }
}

module.exports = { ContactIntake, CONTACT_CATEGORIES, normalizePhone };
