'use strict';

const { EventEmitter } = require('node:events');
const { randomUUID, createHash } = require('node:crypto');

const MINUTE = 60000;
const ON_TIME_GRACE = MINUTE;
const terminal = new Set(['confirmed', 'delivered', 'failed', 'uncertain', 'cancelled', 'skipped']);
const { normalizePhone } = require('./phone.cjs');
const validPhone = value => normalizePhone(value)!==null;
const fail = (text, code = 'REMINDER_INVALID') => Object.assign(new Error(text), { code, definitive: true, safeToRetry: false });
const codeOf = value => typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value) ? value : 'REMINDER_SEND_ERROR';
const safeText = value => String(value || '').slice(0, 300).replace(/(Bearer\s+)[\w.\-]+/gi, '$1[omitido]').replace(/((?:password|senha|token|secret|authorization|credential)\s*[:=]\s*)[^\s,;]+/gi, '$1[omitido]');
const sleepDefault = ms => new Promise(resolve => setTimeout(resolve, ms));
const formatters = new Map();
function formatter(timezone) {
  if (!formatters.has(timezone)) {
    if (formatters.size > 128) formatters.delete(formatters.keys().next().value);
    formatters.set(timezone, new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }));
  }
  return formatters.get(timezone);
}
function localParts(at, timezone) {
  const p = Object.fromEntries(formatter(timezone).formatToParts(at).filter(v => v.type !== 'literal').map(v => [v.type, Number(v.value)]));
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second };
}
function dateKey(p) { return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`; }
function shiftDate(p, days) { const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days)); return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }; }
function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw fail('Informe uma data válida.');
  const [year, month, day] = value.split('-').map(Number);
  if (year < 2000 || year > 2200 || dateKey(shiftDate({ year, month, day }, 0)) !== value) throw fail('Informe uma data válida entre 2000 e 2200.');
  return { year, month, day };
}
// Offsets are sampled on both sides of a transition. A DST gap has no matching
// instant and is skipped; an ambiguous wall time chooses its first occurrence.
function localEpoch(day, time, timezone) {
  const [hour, minute] = time.split(':').map(Number);
  const desired = Date.UTC(day.year, day.month - 1, day.day, hour, minute);
  const offsets = new Set();
  for (const delta of [-86400000, 0, 86400000]) {
    const probe = desired + delta, p = localParts(probe, timezone);
    offsets.add(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - probe);
  }
  const matches = [...offsets].map(offset => desired - offset).filter(at => {
    const p = localParts(at, timezone);
    return p.year === day.year && p.month === day.month && p.day === day.day && p.hour === hour && p.minute === minute && p.second === 0;
  });
  return matches.length ? Math.min(...matches) : null;
}
function occurrence(config, anchor, direction) {
  if (config.repeat === 'once') {
    const at = localEpoch(parseDate(config.date), config.time, config.timezone);
    return at != null && (direction > 0 ? at > anchor : at <= anchor) ? at : null;
  }
  const start = localParts(anchor, config.timezone);
  for (let index = 0; index <= 370; index++) {
    const day = shiftDate(start, index * direction);
    if (config.repeat === 'weekdays' && !config.weekdays.includes(new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay())) continue;
    const at = localEpoch(day, config.time, config.timezone);
    if (at != null && (direction > 0 ? at > anchor : at <= anchor)) return at;
  }
  return null;
}
const nextOccurrence = (config, after) => occurrence(config, after, 1);
const previousOccurrence = (config, at) => occurrence(config, at, -1);
function normalize(input, previous = {}) {
  if (!input || typeof input !== 'object') throw fail('Informe os dados do lembrete.');
  const merged = { ...previous, ...input };
  const title = String(merged.title || '').trim();
  const description = String(merged.description || '').trim();
  if (!title || title.length > 120 || /[\x00-\x1f]/.test(title)) throw fail('Informe um título de até 120 caracteres.');
  if (description.length > 4000 || /\x00/.test(description)) throw fail('A descrição deve ter até 4.000 caracteres.');
  const time = merged.time || '09:00', timezone = merged.timezone || 'America/Sao_Paulo';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw fail('Informe o horário no formato HH:mm.');
  if (typeof timezone !== 'string' || timezone.length > 100) throw fail('Informe um fuso horário válido.');
  try { formatter(timezone).format(0); } catch { throw fail('Fuso inválido. Use, por exemplo, America/Sao_Paulo.'); }
  const repeat = merged.repeat || 'daily';
  if (!['daily', 'weekdays', 'once'].includes(repeat)) throw fail('Repetição de lembrete inválida.');
  const weekdays = [...new Set(Array.isArray(merged.weekdays) ? merged.weekdays : [])];
  if (weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6) || repeat === 'weekdays' && !weekdays.length) throw fail('Selecione pelo menos um dia da semana válido.');
  const date = repeat === 'once' ? dateKey(parseDate(merged.date)) : '';
  if (repeat === 'once' && localEpoch(parseDate(date), time, timezone) === null) throw fail('Este horário não existe no fuso selecionado devido à mudança de horário.');
  if (typeof merged.recipientId !== 'string' || !merged.recipientId || merged.recipientId.length > 200) throw fail('Selecione um destinatário autorizado.');
  const overduePolicy = merged.overduePolicy || 'skip';
  if (!['skip', 'sendOnce'].includes(overduePolicy)) throw fail('Tratamento de lembretes vencidos inválido.');
  const integer = (value, fallback, min, max, text) => {
    const result = value == null ? fallback : Number(value);
    if (!Number.isInteger(result) || result < min || result > max) throw fail(text);
    return result;
  };
  return { title, description, time, timezone, repeat, weekdays: weekdays.sort((a, b) => a - b), date, recipientId: merged.recipientId, overduePolicy,
    overdueGraceMinutes: integer(merged.overdueGraceMinutes, 120, 1, 10080, 'A tolerância deve ficar entre 1 e 10.080 minutos.'),
    maxAttempts: integer(merged.maxAttempts, 3, 1, 5, 'Configure de 1 a 5 tentativas.'),
    retryMinutes: integer(merged.retryMinutes, 1, 1, 1440, 'O intervalo de tentativa deve ficar entre 1 e 1.440 minutos.') };
}
function reminderText(reminder, delivery) {
  const at = new Date(delivery.dueAt).toLocaleString('pt-BR', { timeZone: reminder.timezone, dateStyle: 'short', timeStyle: 'short' });
  return `${delivery.test ? '🔔 TESTE DE LEMBRETE' : '⏰ LEMBRETE'}\n\n📌 ${reminder.title}${reminder.description ? `\n\n${reminder.description}` : ''}\n\n🕒 ${delivery.test ? 'Teste solicitado' : 'Horário original'}: ${at}\n🌎 ${reminder.timezone}${delivery.delayed ? '\n⚠️ Aviso enviado após indisponibilidade, dentro da tolerância configurada.' : ''}\n\nKenned Code Disparos`;
}

class ReminderService extends EventEmitter {
  constructor({ store, auth, scheduler, adapter, now = () => Date.now(), sleep = sleepDefault, isAutomationStopped = () => false, onCriticalIncident } = {}) {
    super(); Object.assign(this, { store, auth, scheduler, adapter, now, sleep, isAutomationStopped, onCriticalIncident });
    this.started = false; this.closed = false; this.timer = null; this.flushing = null; this.flushRequested = false; this.ticking = null; this.inFlight = new Set(); this.adapterRevision = 0;
    this.statusListener = status => { if (status.state === 'connected') void this.tick().catch(error => this._fatal(error)); };
    this.receiptListener = receipt => this._receipt(receipt);
  }
  _mode() { return this.adapter?.status?.mode === 'simulated' ? 'simulated' : 'whatsapp'; }
  _list(table, filter = {}) { return this.store.listEntities(table, filter); }
  _get(table, id) { return this.store.getEntity(table, id); }
  _save(table, value) { try { return this.store.saveEntity(table, value); } catch (error) { this.scheduler?.blockOnPersistenceFailure?.(); throw error; } }
  _assert(actorId, permission) { if (!this.auth?.assertFor) throw fail('Permissões de lembretes indisponíveis.', 'AUTH_REQUIRED'); return this.auth.assertFor(actorId, permission); }
  _blocked() { return this.closed || this.store.persistenceFailed || this.scheduler?.persistenceFailed || this.isAutomationStopped(); }
  _trace(delivery, stage, code, description, action) {
    this.store.addDiagnostic?.({ id: randomUUID(), at: this.now(), traceId: delivery.traceId || delivery.id, reminderId: delivery.reminderId, userId: delivery.userId || null, stage: `lembrete.${stage}`, code: codeOf(code), description: safeText(description), action: safeText(action), attempts: delivery.attempts || 0, guidance: 'Confira a conexão, o destinatário autorizado e o fuso. Resultados incertos exigem revisão, sem repetição automática.', integrationMode: this._mode(), simulation: this._mode() === 'simulated' });
  }
  _audit(action, reminderId, actorId, detail = {}) { this.store.addAudit?.({ at: this.now(), action, subjectId: reminderId, userId: actorId || null, actorId: actorId || null, details: detail }); }
  _fatal(error) { this.scheduler?.blockOnPersistenceFailure?.(); this.emit('change', { error: 'Falha ao persistir o processamento de lembretes.', code: 'REMINDER_STORAGE_ERROR' }); }
  recipients() {
    const choices = new Map();
    for (const user of this._list('users')) if (user.active !== false && !user.requirePasswordChange && validPhone(user.phone) && this._get('roles', user.roleId)) choices.set(`user:${user.id}`, { id: `user:${user.id}`, name: user.name, phone: normalizePhone(user.phone), source: 'user' });
    for (const item of this._list('alert_recipients')) {
      const number=normalizePhone(item.phone),linked=item.userId?this._get('users',item.userId):null;
      if(item.userId&&(!linked||linked.active===false||linked.requirePasswordChange||!this._get('roles',linked.roleId)||linked.phone&&normalizePhone(linked.phone)!==number))continue;
      if(item.enabled!==false&&number)choices.set(item.id,{id:item.id,name:item.name,phone:number,source:'configured'});
    }
    return [...choices.values()];
  }
  _recipient(id) { const value = this.recipients().find(item => item.id === id); if (!value) throw fail('Destinatário removido, desativado ou sem telefone com país e DDD.', 'REMINDER_RECIPIENT_DISABLED'); return value; }
  list(actorId) {
    this._assert(actorId, 'reminder.view');
    const items = this._list('reminders').map(item => ({ ...item, recipient: this.recipients().find(r => r.id === item.recipientId) || null, lastDelivery: item.lastDeliveryId ? this._get('reminder_deliveries', item.lastDeliveryId) || null : null }));
    return { items, recipients: this.recipients(), status: this.status() };
  }
  history(filter = {}, actorId) {
    this._assert(actorId, 'reminder.view');
    const query = { limit: filter.limit || 50, offset: filter.offset || 0, ...(filter.reminderId ? { campaignId: filter.reminderId } : {}) };
    return this.store.queryEntities ? this.store.queryEntities('reminder_deliveries', query) : { items: this._list('reminder_deliveries').filter(d => !filter.reminderId || d.reminderId === filter.reminderId).slice(query.offset, query.offset + query.limit) };
  }
  status() {
    const items = this._list('reminders'), pending = this._list('reminder_deliveries', { status: 'pending' });
    const due = items.filter(item => item.state === 'active' && item.nextDueAt != null).map(item => item.nextDueAt);
    return { active: items.filter(item => item.state === 'active').length, paused: items.filter(item => item.state === 'paused').length, pending: pending.length, inFlight: this.inFlight.size, uncertain: this._list('reminder_deliveries', { status: 'uncertain' }).length, nextDueAt: due.length ? Math.min(...due) : null, automationStopped: this.isAutomationStopped(), connected: this.adapter?.status?.state === 'connected' };
  }
  save(input, actorId) {
    const old = input?.id ? this._get('reminders', input.id) : null;
    if (input?.id && !old) throw fail('Lembrete não encontrado.', 'REMINDER_NOT_FOUND');
    this._assert(actorId, old ? 'reminder.edit' : 'reminder.create');
    const config = normalize(input, old || {}); this._recipient(config.recipientId);
    if (input.enabled != null && typeof input.enabled !== 'boolean') throw fail('A ativação do lembrete deve ser verdadeira ou falsa.');
    const active = input.enabled == null ? old?.state === 'active' : input.enabled === true;
    if (active && (!old || old.state !== 'active')) this._assert(actorId, 'reminder.control');
    if (active && this.isAutomationStopped()) throw fail('Os envios automáticos estão bloqueados. Retome o sistema explicitamente antes de ativar lembretes.', 'AUTOMATION_STOPPED');
    const changed = !old || JSON.stringify(normalize(old)) !== JSON.stringify(config);
    const revision = (old?.scheduleRevision || 0) + (changed ? 1 : 0);
    const nextDueAt = active ? config.repeat === 'once' ? localEpoch(parseDate(config.date), config.time, config.timezone) : nextOccurrence(config, this.now() - 1) : null;
    const result = this.store.transaction(() => {
      if (old && (changed || !active)) this._cancelPending(old.id, changed ? 'Configuração do lembrete alterada.' : 'Lembrete pausado.');
      const saved = this._save('reminders', { ...old, ...config, id: old?.id || randomUUID(), state: active ? 'active' : 'paused', enabled: active, scheduleRevision: revision || 1, nextDueAt: old?.state === 'active' && !changed && active ? old.nextDueAt : nextDueAt, createdAt: old?.createdAt || this.now(), updatedAt: this.now(), ownerId: old?.ownerId || actorId, lastActorId: actorId, reviewRequired: false, error: null });
      this._audit(old ? 'reminder.updated' : 'reminder.created', saved.id, actorId, { state: saved.state, scheduleRevision: saved.scheduleRevision }); return saved;
    });
    this.emit('change'); return result;
  }
  _cancelPending(id, reason) {
    let cancelled = 0;
    for (const item of this._list('reminder_deliveries', { campaignId: id, status: 'pending' })) {
      this._save('reminder_deliveries', { ...item, status: 'cancelled', resultAt: this.now(), code: 'REMINDER_CANCELLED', error: reason }); cancelled++;
    }
    return cancelled;
  }
  pause(id, actorId) {
    this._assert(actorId, 'reminder.control'); const item = this._get('reminders', id); if (!item) throw fail('Lembrete não encontrado.', 'REMINDER_NOT_FOUND');
    const result = this.store.transaction(() => { const cancelled = this._cancelPending(id, 'Lembrete pausado.'); const value = this._save('reminders', { ...item, state: 'paused', enabled: false, nextDueAt: null, updatedAt: this.now() }); this._audit('reminder.paused', id, actorId, { cancelled, inFlight: this.inFlight.size }); return value; });
    this.emit('change'); return result;
  }
  activate(id, actorId) {
    this._assert(actorId, 'reminder.control'); const item = this._get('reminders', id); if (!item) throw fail('Lembrete não encontrado.', 'REMINDER_NOT_FOUND');
    if (this._blocked()) throw fail('Os envios automáticos estão bloqueados. Retome o sistema antes de ativar.', 'AUTOMATION_STOPPED');
    this._recipient(item.recipientId);
    const nextDueAt = item.repeat === 'once' ? localEpoch(parseDate(item.date), item.time, item.timezone) : nextOccurrence(item, this.now() - 1);
    const saved = this.store.transaction(() => { const value = this._save('reminders', { ...item, state: 'active', enabled: true, nextDueAt, updatedAt: this.now(), lastActorId: actorId, reviewRequired: false, error: null }); this._audit('reminder.activated', id, actorId); return value; });
    this.emit('change'); return saved;
  }
  remove(id, actorId) {
    this._assert(actorId, 'reminder.delete'); if (!this._get('reminders', id)) throw fail('Lembrete não encontrado.', 'REMINDER_NOT_FOUND');
    this.store.transaction(() => { this._cancelPending(id, 'Lembrete excluído.'); this.store.deleteEntity('reminders', id); this._audit('reminder.deleted', id, actorId); });
    this.emit('change'); return { deleted: true, preservedOperationalLedger: true };
  }
  test(id, actorId) {
    this._assert(actorId, 'reminder.control'); const item = this._get('reminders', id); if (!item) throw fail('Lembrete não encontrado.', 'REMINDER_NOT_FOUND');
    if (this._blocked()) throw fail('Envios automáticos bloqueados ou armazenamento indisponível. Retome antes de testar.', 'AUTOMATION_STOPPED');
    const delivery = this._queue(item, this.now(), { test: true, userId: actorId }); this._audit('reminder.test', id, actorId, { deliveryId: delivery.id });
    void this.flush().catch(error => this._fatal(error)); return delivery;
  }
  _queue(reminder, dueAt, { test = false, userId = null, skipped = false, delayed = false } = {}) {
    const mode = this._mode(), occurrenceId = test ? randomUUID() : createHash('sha256').update(`${mode}:${reminder.id}:${reminder.scheduleRevision}:${dueAt}`).digest('hex');
    const id = `reminder:${occurrenceId}`, existing = this._get('reminder_deliveries', id); if (existing) return existing;
    const recipient = this._recipient(reminder.recipientId);
    if (!test) for (const older of this._list('reminder_deliveries', { campaignId: reminder.id, status: 'pending' })) {
      if (older.test || older.dueAt >= dueAt) continue;
      this._save('reminder_deliveries', { ...older, status: 'skipped', resultAt: this.now(), code: 'REMINDER_OVERDUE_REPLACED', error: 'Aviso pendente anterior substituído pela ocorrência mais recente; não haverá acúmulo de lembretes vencidos.' });
    }
    const delivery = { id, traceId: occurrenceId, reminderId: reminder.id, campaignId: reminder.id, scheduleRevision: reminder.scheduleRevision, recipientId: recipient.id, number: recipient.phone, messageId: `KCDR${createHash('sha256').update(occurrenceId).digest('hex').slice(0, 28).toUpperCase()}`, status: skipped ? 'skipped' : 'pending', dueAt, originalAt: dueAt, createdAt: this.now(), attempts: 0, nextAttemptAt: this.now(), resultAt: skipped ? this.now() : null, deadlineAt: test ? this.now() + 10080 * MINUTE : dueAt + (reminder.overduePolicy === 'sendOnce' ? reminder.overdueGraceMinutes * MINUTE : ON_TIME_GRACE), test, delayed, userId, storageMode: mode, simulation: mode === 'simulated', code: skipped ? 'REMINDER_OVERDUE_SKIPPED' : null, error: skipped ? 'Horário vencido; nenhum aviso enviado conforme a política configurada.' : null };
    delivery.text = reminderText(reminder, delivery);
    const saved = this._save('reminder_deliveries', delivery);
    this._save('reminders', { ...reminder, lastDeliveryId: id, lastOccurrenceAt: dueAt });
    this._trace(saved, 'queue', skipped ? 'REMINDER_OVERDUE_SKIPPED' : 'REMINDER_QUEUED', skipped ? 'Ocorrência vencida descartada.' : 'Aviso privado colocado na fila, ainda sem envio confirmado.', skipped ? 'Próximo horário preservado.' : 'Aguardando conexão e disponibilidade da fila sequencial.');
    return saved;
  }
  start() {
    if (this.started || this.closed) return; this.started = true;
    for (const item of this._list('reminder_deliveries', { status: 'sending' })) this._save('reminder_deliveries', { ...item, status: 'uncertain', resultAt: this.now(), code: 'REMINDER_RECOVERY_UNCERTAIN', error: 'Aplicativo encerrado durante o envio. Revise antes de repetir; não haverá reenvio automático.' });
    this.adapter?.on('status', this.statusListener); this.adapter?.on('receipt', this.receiptListener);
    this.timer = setInterval(() => { void this.tick().catch(error => this._fatal(error)); }, 1000); this.timer.unref?.();
    void this.tick().catch(error => this._fatal(error));
  }
  setAdapter(adapter) {
    this.adapter?.off('status', this.statusListener); this.adapter?.off('receipt', this.receiptListener); this.adapter = adapter; this.adapterRevision++;
    if (this.started) { adapter?.on('status', this.statusListener); adapter?.on('receipt', this.receiptListener); }
    for (const item of this._list('reminder_deliveries', { status: 'sending' })) this._save('reminder_deliveries', { ...item, status: 'uncertain', resultAt: this.now(), code: 'REMINDER_RECOVERY_UNCERTAIN', error: 'Envio interrompido durante troca da integração. Revisão necessária.' });
  }
  tick() {
    if (this.ticking) return this.ticking;
    this.ticking = this._tick().finally(() => { this.ticking = null; }); return this.ticking;
  }
  async _tick() {
    if (this._blocked()) return;
    const now = this.now(); let changed = false;
    for (const item of this._list('reminders').filter(r => r.state === 'active' && r.nextDueAt != null && r.nextDueAt <= now)) {
      changed = true; this.store.transaction(() => {
        const dueAt = now - item.nextDueAt > ON_TIME_GRACE ? previousOccurrence(item, now) ?? item.nextDueAt : item.nextDueAt;
        const allowedDelay = item.overduePolicy === 'sendOnce' ? item.overdueGraceMinutes * MINUTE : ON_TIME_GRACE;
        const skipped = now - dueAt > allowedDelay;
        try { this._queue(item, dueAt, { delayed: now - dueAt > ON_TIME_GRACE, skipped }); }
        catch (error) { if (error?.code !== 'REMINDER_RECIPIENT_DISABLED') throw error; this._save('reminders', { ...item, state: 'paused', enabled: false, nextDueAt: null, error: error.message }); this._trace({ id: item.id, reminderId: item.id }, 'recipient', error.code, error.message, 'Lembrete pausado; confira o destinatário.'); return; }
        const current = this._get('reminders', item.id);
        const nextDueAt = nextOccurrence(item, now);
        this._save('reminders', { ...current, nextDueAt, ...(item.repeat === 'once' ? { state: 'completed', enabled: false } : {}) });
      });
    }
    if (changed) this.emit('change'); await this.flush();
  }
  flush() {
    this.flushRequested = true;
    if (this.flushing) return this.flushing;
    this.flushing = (async () => { do { this.flushRequested = false; await this._flush(); } while (this.flushRequested && !this._blocked()); })().finally(() => {
      this.flushing = null;
      if (this.flushRequested && !this._blocked()) queueMicrotask(() => { void this.flush().catch(error => this._fatal(error)); });
    });
    return this.flushing;
  }
  async _flush() {
    if (this._blocked() || this.adapter?.status?.state !== 'connected') return;
    const adapter = this.adapter, revision = this.adapterRevision, mode = this._mode();
    for (const item of this._list('reminder_deliveries', { status: 'pending' })) {
      if (this._blocked() || adapter !== this.adapter || revision !== this.adapterRevision || mode !== this._mode() || adapter.status?.state !== 'connected') break;
      if (item.nextAttemptAt > this.now()) continue;
      if (item.deadlineAt < this.now()) { this._save('reminder_deliveries', { ...item, status: 'skipped', resultAt: this.now(), code: 'REMINDER_OVERDUE_SKIPPED', error: 'A tolerância venceu antes da conexão ou do envio; aviso descartado.' }); this.emit('change'); continue; }
      const work = () => this._submit(item, adapter, revision, mode);
      try {
        if (this.scheduler?.runExternalSubmission) await this.scheduler.runExternalSubmission(work);
        else await work();
      } catch (error) {
        // Cancelling the global shared queue is a requested stop, not a disk
        // failure. It must leave explicit resume available to administrators.
        if (error?.code === 'AUTOMATION_STOPPED' || this.closed || this.isAutomationStopped()) return;
        throw error;
      }
    }
  }
  async _submit(item, adapter, revision, mode) {
    if (this._blocked() || adapter !== this.adapter || revision !== this.adapterRevision || mode !== this._mode() || adapter.status?.state !== 'connected') return;
    let current = this._get('reminder_deliveries', item.id); if (current?.status !== 'pending') return;
    let submitted = false, attempt = (current.attempts || 0) + 1;
    try {
      const reminder = this._get('reminders', current.reminderId);
      if (!reminder || reminder.scheduleRevision !== current.scheduleRevision || !current.test && !['active', 'completed'].includes(reminder.state)) throw fail('Lembrete removido, pausado ou alterado antes do envio.', 'REMINDER_CANCELLED');
      if (current.userId) this._assert(current.userId, 'reminder.control');
      let recipient = this._recipient(current.recipientId); if (recipient.phone !== current.number) throw fail('O telefone do destinatário foi alterado.', 'REMINDER_RECIPIENT_DISABLED');
      const spacingMs = Math.max(3, adapter.minimumSpacingSeconds || 0) * 1000;
      if (this.scheduler?.lastSubmissionAt != null && this.now() - this.scheduler.lastSubmissionAt < spacingMs) await this.sleep(spacingMs - (this.now() - this.scheduler.lastSubmissionAt));
      if (this._blocked() || adapter !== this.adapter || revision !== this.adapterRevision || mode !== this._mode()) return;
      current = this._save('reminder_deliveries', { ...current, attempts: attempt });
      if (typeof adapter.resolveRecipient !== 'function') throw fail('A integração não permite resolver destinatários privados.', 'WA_RECIPIENT_UNSUPPORTED');
      const resolved = await adapter.resolveRecipient(current.number);
      const fresh = this._get('reminders', current.reminderId), ledger = this._get('reminder_deliveries', current.id);
      if (this._blocked() || adapter !== this.adapter || revision !== this.adapterRevision || mode !== this._mode() || ledger?.status !== 'pending') return;
      if (!fresh || fresh.scheduleRevision !== current.scheduleRevision || !current.test && !['active', 'completed'].includes(fresh.state)) throw fail('Lembrete alterado ou pausado durante a consulta do número.', 'REMINDER_CANCELLED');
      recipient = this._recipient(current.recipientId); if (recipient.phone !== current.number) throw fail('O destinatário foi alterado antes do envio.', 'REMINDER_RECIPIENT_DISABLED');
      if (current.userId) this._assert(current.userId, 'reminder.control');
      if (current.deadlineAt < this.now()) throw fail('A tolerância venceu enquanto o destinatário era consultado.', 'REMINDER_OVERDUE_SKIPPED');
      if (!resolved?.jid || resolved.phone !== current.number || resolved.mode && resolved.mode !== mode || Boolean(resolved.simulation) !== (mode === 'simulated')) throw fail('A integração não confirmou a identidade do destinatário neste modo.', 'WA_RECIPIENT_MISMATCH');
      current = this._save('reminder_deliveries', { ...ledger, attempts: attempt, status: 'sending', submittedAt: this.now(), targetId: resolved.jid, isSelf: resolved.isSelf === true });
      this._trace(current, 'recipient', 'REMINDER_RECIPIENT_RESOLVED', 'Destinatário privado resolvido e autorização validada.', 'Submissão iniciada; confirmação ainda pendente.');
      this.inFlight.add(current.id); if (this.scheduler) this.scheduler.lastSubmissionAt = this.now(); submitted = true;
      const result = await adapter.sendPrivate(current.number, current.text, { clientMessageId: current.messageId });
      if (mode !== this._mode() || adapter !== this.adapter) return;
      const latest = this._get('reminder_deliveries', current.id), confirmed = ['confirmed', 'delivered'].includes(latest?.status) || ['confirmed', 'delivered'].includes(result?.status);
      const delivered = latest?.status === 'delivered' || result?.status === 'delivered' || confirmed && ['whatsapp-delivered', 'whatsapp-read'].includes(result?.confirmationScope);
      const saved = this._save('reminder_deliveries', { ...latest, status: delivered ? 'delivered' : confirmed ? 'confirmed' : 'uncertain', resultAt: latest.resultAt || this.now(), confirmationScope: confirmed ? result?.confirmationScope || latest.confirmationScope || (mode === 'simulated' ? 'simulation-only' : 'whatsapp-server') : null, ...(delivered ? { deliveredAt: latest.deliveredAt || result?.deliveredAt || this.now() } : {}), code: confirmed ? null : 'REMINDER_SEND_UNCERTAIN', error: confirmed ? null : 'A integração não confirmou o envio. Revise antes de repetir; sem reenvio automático.' });
      this._trace(saved, 'result', delivered ? 'REMINDER_DELIVERED' : confirmed ? 'REMINDER_CONFIRMED' : 'REMINDER_SEND_UNCERTAIN', confirmed ? 'Confirmação disponível na integração registrada.' : 'Resultado incerto registrado.', confirmed ? 'Nenhum reenvio.' : 'Revisão necessária.');
    } catch (error) {
      if (mode !== this._mode() || adapter !== this.adapter) return;
      const latest = this._get('reminder_deliveries', item.id); if (['confirmed', 'delivered', 'cancelled'].includes(latest?.status)) return;
      const reminder = this._get('reminders', item.reminderId), max = reminder?.maxAttempts || 3;
      const safe = error?.safeToRetry === true || !submitted && error?.definitive !== true && error?.safeToRetry !== false;
      const cancelled = error.code === 'REMINDER_CANCELLED', skipped = error.code === 'REMINDER_OVERDUE_SKIPPED';
      const status = cancelled ? 'cancelled' : skipped ? 'skipped' : safe && attempt < max ? 'pending' : !submitted || error?.safeToRetry === true || error?.definitive === true ? 'failed' : 'uncertain';
      const explanation = cancelled || skipped ? safeText(error.message) : status === 'pending' ? 'Falha temporária anterior à confirmação. Nova tentativa limitada agendada.' : status === 'uncertain' ? 'Não foi possível confirmar o envio. Revise antes de repetir; sem reenvio automático.' : `Não foi possível enviar o lembrete (${codeOf(error.code)}). Confira conexão, número com país/DDD e autorização.`;
      const saved = this._save('reminder_deliveries', { ...latest, attempts: attempt, status, code: codeOf(error.code), error: explanation, resultAt: status === 'pending' ? null : this.now(), nextAttemptAt: this.now() + Math.max(reminder?.retryMinutes || 1, (adapter.minimumSpacingSeconds || 0) / 60) * MINUTE });
      this._trace(saved, 'failure', saved.code, explanation, status === 'pending' ? 'Nova tentativa com limite e intervalo.' : 'Nenhum reenvio automático.');
      if (['failed', 'uncertain'].includes(status)) this.onCriticalIncident?.({ id: saved.id, traceId: saved.traceId, event: 'critical', at: saved.resultAt, code: saved.code, reason: `Lembrete “${reminder?.title || 'removido'}”: ${explanation}` });
    } finally { this.inFlight.delete(item.id); this.emit('change'); }
  }
  _receipt(receipt) {
    if (!receipt?.messageId || !['confirmed', 'delivered', 'read'].includes(receipt.status)) return;
    try {
      for (const item of this._list('reminder_deliveries', { status: ['sending', 'confirmed', 'delivered', 'uncertain'] })) {
        if (item.messageId !== receipt.messageId) continue;
        const delivered = item.status === 'delivered' || ['delivered', 'read'].includes(receipt.status);
        this._save('reminder_deliveries', { ...item, status: delivered ? 'delivered' : 'confirmed', resultAt: item.resultAt || this.now(), confirmationScope: item.confirmationScope === 'whatsapp-read' ? item.confirmationScope : receipt.confirmationScope || item.confirmationScope || (this._mode() === 'simulated' ? 'simulation-only' : 'whatsapp-server'), ...(delivered ? { deliveredAt: item.deliveredAt || receipt.deliveredAt || this.now() } : {}), ...(receipt.status === 'read' ? { readAt: receipt.readAt || this.now() } : {}), error: null, code: null });
      }
      this.emit('change');
    } catch (error) { this._fatal(error); }
  }
  stopAll({ actorId = null } = {}) {
    const result = this.store.transaction(() => {
      let paused = 0, cancelled = 0;
      for (const reminder of this._list('reminders')) { cancelled += this._cancelPending(reminder.id, 'Interrupção geral dos envios automáticos.'); if (reminder.state === 'active') { this._save('reminders', { ...reminder, state: 'paused', enabled: false, nextDueAt: null }); paused++; } }
      const value = { paused, cancelled, inFlight: this.inFlight.size }; this._audit('reminder.stop_all', null, actorId, value); return value;
    });
    this.emit('change'); return result;
  }
  async waitForIdle() {
    if (this.ticking) await this.ticking;
    while (this.flushing || this.flushRequested && !this._blocked()) { if (this.flushing) await this.flushing; else await this.flush(); }
  }
  async stop() { this.closed = true; this.started = false; clearInterval(this.timer); this.timer = null; this.adapter?.off('status', this.statusListener); this.adapter?.off('receipt', this.receiptListener); await this.waitForIdle(); }
  async shutdown() { return this.stop(); }
}

module.exports = { ReminderService, normalizeReminder: normalize, localParts, localEpoch, nextOccurrence, previousOccurrence, reminderText };
