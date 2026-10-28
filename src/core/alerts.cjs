'use strict';

const { EventEmitter } = require('node:events');
const { randomUUID, randomBytes } = require('node:crypto');
const { configurationFingerprint } = require('./campaign-version.cjs');

const validPhone = value => typeof value === 'string' && /^[1-9]\d{9,14}$/.test(value);
const copy = value => structuredClone(value);
const codeOf = (value, fallback) => typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value) ? value : fallback;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeDescription = value => String(value || '').slice(0, 500).replace(/(Bearer\s+)[\w.\-]+/gi, '$1[omitido]').replace(/((?:password|senha|token|secret|authorization|credential)\s*[:=]\s*)[^\s,;]+/gi, '$1[omitido]');
const timestampText = (at, timezone = 'America/Sao_Paulo') => {
  try { return new Date(at).toLocaleString('pt-BR', { timeZone: timezone }); } catch { return new Date(at).toISOString(); }
};

function alertText(incident) {
  const at = timestampText(incident.at, incident.timezone);
  const reason = safeDescription(incident.reason || 'Falha de envio.').slice(0, 240);
  if (incident.event === 'disconnect') return `🚨 WhatsApp desconectado\n\n🕒 Ocorrência original: ${at}\n⚠️ Motivo: ${reason}\n🔎 Código do erro: ${codeOf(incident.code, 'WHATSAPP_DISCONNECTED')}\n\nOs envios foram pausados com segurança. Este aviso ficou pendente enquanto a conexão estava indisponível. Acesse o Kenned Code Disparos para verificar a conexão.`;
  if (!incident.campaignId && !incident.campaignName) return `${incident.event === 'test' ? '🔔 Teste de alerta' : '🚨 Falha crítica'} — Kenned Code Disparos\n\n🕒 Ocorrência original: ${at}\n⚠️ Motivo: ${reason}\n🔎 Código do erro: ${codeOf(incident.code, 'SYSTEM_ERROR')}\n\nAcesse o sistema para verificar os detalhes. Nenhuma campanha foi ativada por este aviso.`;
  return `🚨 Campanha interrompida por erro\n\n📣 Campanha: ${String(incident.campaignName || 'Campanha').slice(0, 200)}\n🕒 Data e horário: ${at}\n⚠️ Motivo: ${reason}\n✅ Envios confirmados: ${incident.confirmed || 0}\n⏳ Pendentes: ${incident.pending || 0}\n🔎 Código do erro: ${codeOf(incident.code, 'CAMPAIGN_ERROR')}\n\nAcesse o sistema para verificar os detalhes e decidir sobre a retomada.`;
}

// This service never infers delivery from a successful request or socket write.
// Every network submission has a durable identifier and ambiguous work requires
// human review, including alerts interrupted while the application was closing.
class AlertService extends EventEmitter {
  constructor({ store, scheduler, adapter, now = () => Date.now(), sleep = wait, sendWebhook, secretGet, setTimer = setTimeout, clearTimer = clearTimeout }) {
    super();
    Object.assign(this, { store, scheduler, adapter, now, sleep, sendWebhook, secretGet, setTimer, clearTimer });
    this.started = false;
    this.closed = false;
    this.timer = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.reconnecting = null;
    this.flushing = null;
    this.disconnectOccurrence = null;
    this.previousState = adapter?.status?.state;
    this.activeBeforeDisconnect = new Map();
    this.storageAlertShown = false;
    this.criticalOccurrence = null;
    this.integrationMode = adapter?.status?.mode === 'simulated' ? 'simulated' : 'whatsapp';
    this.adapterRevision = 0;
    this.incidentListener = incident => { try { this.recordIncident(incident); } catch { this.scheduler?.blockOnPersistenceFailure(); } };
    this.changeListener = details => {
      if (details?.error && this.scheduler?.persistenceFailed && !this.storageAlertShown) {
        this.storageAlertShown = true;
        // Persistence cannot be trusted here. Notify immediately, but never
        // pretend that a private warning could be durably queued on this disk.
        this.emit('localAlert', { id: 'storage-failure', occurrenceId: 'storage-failure', traceId: 'storage-failure', event: 'critical', title: 'Envios bloqueados por falha de armazenamento', body: 'Confira o espaço e as permissões do disco. Reabra o aplicativo após corrigir a falha e revise resultados incertos. O alerta privado não pôde ser salvo.', reason: 'Falha de persistência.', at: this.now(), campaignId: null, integrationMode: this._mode(), simulation: this._mode() === 'simulated' });
      }
      if (details?.error && !this.scheduler?.persistenceFailed && !this.store.persistenceFailed) {
        this.criticalOccurrence ||= randomUUID();
        const incident = { id: details.occurrenceId || this.criticalOccurrence, traceId: details.traceId, at: this.now(), event: 'critical', code: codeOf(details.code, 'SYSTEM_PROCESSING_ERROR'), reason: 'Falha crítica no processamento. Consulte o diagnóstico do sistema.' };
        try { this.recordSystemIncident(incident); } catch { this.scheduler?.blockOnPersistenceFailure(); }
      }
      if (!details?.error) this.criticalOccurrence = null;
      if (!this.store.persistenceFailed) this._rememberActive();
    };
    this.statusListener = status => { void this._onStatus(status).catch(() => this.scheduler?.blockOnPersistenceFailure()); };
    this.receiptListener = receipt => {
      if (!['confirmed', 'delivered', 'read'].includes(receipt.status) || !receipt.messageId) return;
      try {
        const matches = this.store.findAlertsByMessageId ? this.store.findAlertsByMessageId(receipt.messageId) : this._list('alerts').filter(alert => alert.messageId === receipt.messageId);
        for (const alert of matches) {
          if (alert.messageId !== receipt.messageId || alert.status === 'cancelled') continue;
          const delivered = ['delivered', 'read'].includes(receipt.status) || ['whatsapp-delivered', 'whatsapp-read'].includes(receipt.confirmationScope);
          this._save('alerts', { ...alert, status: delivered || alert.status === 'delivered' ? 'delivered' : 'confirmed', resultAt: alert.resultAt || this.now(), confirmationScope: alert.confirmationScope === 'whatsapp-read' ? 'whatsapp-read' : delivered ? receipt.confirmationScope || (receipt.status === 'read' ? 'whatsapp-read' : 'whatsapp-delivered') : alert.confirmationScope || receipt.confirmationScope || 'whatsapp-server', ...(delivered ? { deliveredAt: alert.deliveredAt || receipt.deliveredAt || this.now() } : {}), ...(receipt.readAt ? { readAt: alert.readAt || receipt.readAt } : {}), error: null, retryEligible: false });
          this._trace(alert, 'receipt', delivered ? 'ALERT_DELIVERED' : 'ALERT_CONFIRMED', delivered ? 'A integração confirmou entrega ao dispositivo.' : 'A integração confirmou recebimento pelo servidor.', 'Registro conciliado sem novo envio.', alert.attempts || 0);
        }
        this.emit('change');
      } catch { this.scheduler?.blockOnPersistenceFailure(); }
    };
  }

  _list(table, filter = {}) {
    const wrappers = { alerts: 'listAlerts', notifications: 'listNotifications', alert_recipients: 'listAlertRecipients', users: 'listUsers' };
    let records;
    if (this.store[wrappers[table]]) records = this.store[wrappers[table]](filter);
    else if (this.store.listEntities) records = this.store.listEntities(table, filter);
    else if (table === 'alert_recipients') records = this.store.getSetting('alertRecipients', []);
    else records = [];
    if (!Array.isArray(records)) records = records?.items || [];
    return records.filter(item => Object.entries(filter).every(([key, value]) => ['limit', 'offset'].includes(key) || value === undefined || item[key] === value));
  }

  _get(table, id) {
    const method = { alerts: 'getAlert', notifications: 'getNotification', alert_recipients: 'getAlertRecipient' }[table];
    return this.store[method] ? this.store[method](id) : this.store.getEntity ? this.store.getEntity(table, id) : this._list(table).find(x => x.id === id);
  }

  _save(table, value) {
    const method = { alerts: 'saveAlert', notifications: 'saveNotification' }[table];
    try {
      if (this.store[method]) return this.store[method](value);
      if (this.store.saveEntity) return this.store.saveEntity(table, value);
      throw new Error('Persistência de alertas indisponível.');
    } catch (error) { this.scheduler?.blockOnPersistenceFailure(); throw error; }
  }

  _audit(action, subjectId, userId, details) {
    if (this.store.addAudit) this.store.addAudit({ id: randomUUID(), at: this.now(), userId: userId || null, action, subjectId, details });
  }

  _diagnostic(code, description, action, campaignId, attempts = 0, extra = {}) {
    if (this.store.addDiagnostic) this.store.addDiagnostic({ id: randomUUID(), at: this.now(), campaignId: campaignId || null, userId: extra.userId || null, stage: extra.stage || 'alerta', code: codeOf(code, 'ALERT_ERROR'), description: safeDescription(description), attempts, action: safeDescription(action), guidance: extra.guidance || 'Confira a conexão e os destinatários. Um resultado incerto exige revisão antes de repetir.', integrationMode: this._mode(), simulation: this._mode() === 'simulated', ...extra });
  }

  _mode() {
    return ['simulated', 'whatsapp'].includes(this.adapter?.status?.mode) ? this.adapter.status.mode : this.integrationMode;
  }

  _trace(subject, stage, code, description, action, attempts = 0) {
    this._diagnostic(code, description, action, subject.campaignId, attempts, { traceId: subject.traceId || subject.occurrenceId || subject.id, occurrenceId: subject.occurrenceId || subject.id, alertId: subject.occurrenceId ? subject.id : null, recipientId: subject.recipientId || null, stage: `alerta.${stage}`, userId: subject.userId || null });
  }

  start() {
    if (this.started || this.closed) return;
    this.started = true;
    const previousDisconnect = this.store.getSetting(`alertDisconnectOccurrence:${this._mode()}`, null);
    if (previousDisconnect?.id && previousDisconnect.integrationMode === this._mode() && this.adapter?.status?.state !== 'connected') this.disconnectOccurrence = previousDisconnect;
    for (const alert of this._list('alerts', { status: 'sending' })) this._save('alerts', { ...alert, status: 'uncertain', resultAt: this.now(), error: 'Envio de alerta interrompido; revisão necessária antes de repetir.' });
    this.scheduler?.on('incident', this.incidentListener);
    this.scheduler?.on('change', this.changeListener);
    this.adapter?.on('status', this.statusListener);
    this.adapter?.on('receipt', this.receiptListener);
    this._rememberActive();
    // A persisted campaign occurrence may have preceded a process crash before
    // alert records were created. Recipient+occurrence keys prevent duplication.
    for (const c of this.store.listCampaigns()) if (c.lastError?.id) this.recordIncident(c.lastError);
    this.timer = setInterval(() => { void this.flush().catch(() => this.scheduler?.blockOnPersistenceFailure()); }, 1000);
    this.timer.unref?.();
    void this.flush().catch(() => this.scheduler?.blockOnPersistenceFailure());
  }

  setAdapter(adapter) {
    this.adapter?.off('status', this.statusListener);
    this.adapter?.off('receipt', this.receiptListener);
    const oldMode = this._mode();
    this.adapter = adapter;
    this.integrationMode = adapter.status?.mode === 'simulated' ? 'simulated' : 'whatsapp';
    this.adapterRevision++;
    if (oldMode !== this._mode()) { this.disconnectOccurrence = null; this.activeBeforeDisconnect.clear(); }
    this.criticalOccurrence = null;
    this.previousState = adapter.status?.state;
    this._cancelReconnect();
    if (this.started) {
      adapter.on('status', this.statusListener);
      adapter.on('receipt', this.receiptListener);
    }
  }

  _rememberActive() {
    if (this.adapter?.status?.state !== 'connected' || this.disconnectOccurrence) return;
    const active = this.store.listCampaigns().filter(c => c.state === 'active');
    this.activeBeforeDisconnect = new Map(active.map(c => [c.id, c.configRevision ?? configurationFingerprint(c)]));
  }

  _recipients(campaign) {
    const result = new Map();
    const configured = campaign ? campaign.alertRecipientIds || [] : this.store.getSetting('systemAlertRecipientIds', null);
    const explicit = Array.isArray(configured) ? new Set(configured) : null;
    for (const r of this._list('alert_recipients')) {
      if (r.enabled !== false && (explicit ? explicit.has(r.id) : r.systemAlerts !== false) && validPhone(r.phone)) result.set(r.phone, { id: r.id, phone: r.phone });
    }
    const responsible = new Set(campaign?.responsibleUserIds || []);
    for (const u of this._list('users')) {
      if (u.active === false || !validPhone(u.phone)) continue;
      const role = this.store.getEntity?.('roles', u.roleId);
      if (role?.isOwner || u.roleId === 'role-owner' || responsible.has(u.id)) result.set(u.phone, { id: `user:${u.id}`, phone: u.phone });
    }
    return [...result.values()];
  }

  _validateRecipient(alert) {
    if (!validPhone(alert.number)) throw Object.assign(new Error('Telefone do destinatário inválido.'), { code: 'RECIPIENT_NUMBER_INVALID', definitive: true });
    const userRecipient = alert.recipientId?.startsWith('user:');
    const recipient = userRecipient ? this._list('users').find(user => `user:${user.id}` === alert.recipientId) : this._get('alert_recipients', alert.recipientId);
    if (recipient && (recipient.enabled === false || recipient.active === false || recipient.phone !== alert.number)) throw Object.assign(new Error('Destinatário desativado ou telefone alterado.'), { code: 'ALERT_RECIPIENT_DISABLED', definitive: true });
    if (alert.recipientId && alert.recipientId !== 'test' && !recipient) throw Object.assign(new Error('Destinatário não está mais disponível.'), { code: 'ALERT_RECIPIENT_DISABLED', definitive: true });
    if (userRecipient) {
      const role = this.store.getEntity?.('roles', recipient.roleId);
      const owner = role?.isOwner || ['role-owner', 'owner'].includes(recipient.roleId);
      const responsible = alert.campaignId && this.store.getCampaign(alert.campaignId)?.responsibleUserIds?.includes(recipient.id);
      if (!owner && !responsible) throw Object.assign(new Error('Usuário deixou de ser dono ou responsável pelo alerta.'), { code: 'ALERT_RECIPIENT_DISABLED', definitive: true });
    }
    return recipient;
  }

  _local(incident, event, title, body) {
    const id = `${incident.id}:${event}`;
    const existing = this._get('notifications', id);
    if (existing) return existing;
    const notification = this._save('notifications', { id, occurrenceId: incident.id, traceId: incident.traceId || incident.id, event, title, body: safeDescription(body), at: incident.at, reason: safeDescription(incident.reason), code: codeOf(incident.code, 'ALERT_ERROR'), campaignId: incident.campaignId || null, recipientSnapshot: incident.recipientSnapshot || null, integrationMode: this._mode(), simulation: this._mode() === 'simulated', muted: false });
    this.emit('localAlert', copy(notification));
    this.emit('change');
    return notification;
  }

  recordIncident(incident) {
    if (this.closed || !incident?.id) return;
    const campaign = this.store.getCampaign(incident.campaignId);
    if (!campaign) return this.recordSystemIncident(incident);
    incident = { ...incident, traceId: incident.traceId || incident.id };
    const persisted = campaign.lastError?.id === incident.id ? campaign.lastError : incident;
    const recipientSnapshot = persisted.recipientSnapshot || this._recipients(campaign);
    const webhook = this.store.getSetting('independentAlertChannel', null);
    const independentQueued = persisted.independentQueued ?? Boolean(webhook?.enabled && webhook.url && this.sendWebhook && this.secretGet);
    if (!persisted.recipientSnapshot && campaign.lastError?.id === incident.id) this.store.saveCampaign({ ...campaign, lastError: { ...campaign.lastError, recipientSnapshot, independentQueued } });
    if (!campaign.lastError?.localNotified) {
      const alreadyRecorded = this._get('notifications', `${incident.id}:critical`);
      this._local(incident, 'critical', incident.kind === 'uncertain' ? 'Envio precisa de revisão' : 'Campanha interrompida por erro', `${incident.campaignName || campaign.name}: ${incident.reason}`);
      if (!alreadyRecorded) this._trace(incident, 'occurrence', incident.code || 'CAMPAIGN_ERROR', 'Falha da campanha registrada e notificação local exibida.', recipientSnapshot.length ? 'Destinatários privados definidos para a ocorrência.' : 'Nenhum destinatário ativo com telefone válido está configurado.');
      if (campaign.lastError?.id === incident.id) {
        const latest = this.store.getCampaign(campaign.id);
        this.store.saveCampaign({ ...latest, lastError: { ...latest.lastError, localNotified: true } });
      }
    }
    const text = alertText({ ...incident, timezone: this.store.getSetting('timezone', 'America/Sao_Paulo'), campaignName: incident.campaignName || campaign.name });
    for (const recipient of recipientSnapshot) this._queue(incident, recipient, 'whatsapp', text);
    if (independentQueued) this._queue(incident, { id: 'independent-webhook' }, 'webhook', text);
    this.emit('change');
    queueMicrotask(() => { void this.flush().catch(() => this.scheduler?.blockOnPersistenceFailure()); });
  }

  recordSystemIncident(incident) {
    if (this.closed || !incident?.id) return null;
    const value = { ...incident, traceId: incident.traceId || incident.id, event: incident.event || 'critical', at: Number.isFinite(incident.at) ? incident.at : this.now(), integrationMode: this._mode(), simulation: this._mode() === 'simulated' };
    const existing = this._get('notifications', `${value.id}:${value.event}`);
    const recipients = existing?.recipientSnapshot || value.recipientSnapshot || this._recipients(null);
    const titles = { disconnect: 'WhatsApp desconectado', test: 'Teste de alerta — Kenned Code Disparos', critical: 'Falha crítica — Kenned Code Disparos' };
    const notification = this._local({ ...value, recipientSnapshot: recipients }, value.event, titles[value.event] || titles.critical, value.event === 'disconnect' ? `${value.reason} Envios pausados com segurança. Use Reconectar WhatsApp.` : value.reason || 'Consulte o diagnóstico do sistema.');
    if (!existing) this._trace(value, 'occurrence', value.code || 'SYSTEM_ERROR', 'Ocorrência registrada e notificação local exibida.', recipients.length ? 'Alertas privados serão processados pela fila.' : 'Nenhum destinatário ativo com telefone válido está configurado.');
    const text = alertText({ ...value, timezone: this.store.getSetting('timezone', 'America/Sao_Paulo') });
    const alerts = recipients.map(recipient => this._queue(value, recipient, 'whatsapp', text));
    const webhook = this.store.getSetting('independentAlertChannel', null);
    if (webhook?.enabled && webhook.url && this.sendWebhook && this.secretGet) alerts.push(this._queue(value, { id: 'independent-webhook' }, 'webhook', text));
    this.emit('change');
    queueMicrotask(() => { void this.flush().catch(() => this.scheduler?.blockOnPersistenceFailure()); });
    return { occurrenceId: value.id, traceId: value.traceId, notification, alerts };
  }

  _queue(incident, recipient, channel, text) {
    // Deterministic key survives restarts and settings changes. Phone numbers
    // are destinations, never message contents or diagnostic descriptions.
    const id = `${incident.id}:${channel}:${recipient.phone || recipient.id}`;
    const old = this._get('alerts', id);
    if (old) return old;
    const alert = this._save('alerts', { id, occurrenceId: incident.id, traceId: incident.traceId || incident.id, campaignId: incident.campaignId || null, recipientId: recipient.id, number: recipient.phone || null, channel, integrationMode: this._mode(), simulation: this._mode() === 'simulated', status: 'pending', createdAt: this.now(), originalAt: incident.at, messageId: randomBytes(16).toString('hex').toUpperCase(), text, attempts: 0, nextAttemptAt: this.now(), resultAt: null, code: codeOf(incident.code, 'CAMPAIGN_ERROR'), error: null });
    this._trace(alert, 'queue', 'ALERT_QUEUED', 'Aviso colocado na fila; ainda não houve confirmação de envio.', this.adapter?.status?.state === 'connected' ? 'Aguardando processamento sequencial.' : 'Pendente até a reconexão do WhatsApp.');
    return alert;
  }

  async testRecipient(phone, userId, { recipientId } = {}) {
    if (!validPhone(phone)) throw new Error('Informe o telefone com código do país e DDD, entre 10 e 15 dígitos.');
    const incident = { id: randomUUID(), at: this.now(), code: 'ALERT_TEST', event: 'test', userId, reason: 'Teste de alerta solicitado. Nenhuma campanha foi ativada.', recipientSnapshot: [{ id: recipientId || 'test', phone }] };
    const occurrence = this.recordSystemIncident(incident);
    const alert = occurrence.alerts.find(a => a.channel === 'whatsapp');
    this._audit('alert.test', alert.id, userId, 'Teste de destinatário solicitado.');
    await this._flushQueued([alert.id]);
    return this._get('alerts', alert.id);
  }

  async testAlert({ userId, event = 'critical' } = {}) {
    if (!['critical', 'disconnect', 'test'].includes(event)) throw new Error('Tipo de alerta de teste inválido.');
    const incident = { id: randomUUID(), at: this.now(), userId, event, code: 'ALERT_TEST', reason: 'Teste do fluxo de alerta solicitado. Nenhuma campanha foi ativada.' };
    const occurrence = this.recordSystemIncident(incident);
    this._audit('alert.test', occurrence.occurrenceId, userId, 'Teste do fluxo de ocorrência, notificação local e destinatários configurados.');
    await this._flushQueued(occurrence.alerts.map(alert => alert.id));
    return { ...occurrence, alerts: occurrence.alerts.map(alert => this._get('alerts', alert.id)) };
  }

  async retryAlert(id, { userId } = {}) {
    const alert = this._get('alerts', id);
    if (!alert || alert.status !== 'failed' || alert.retryEligible !== true) throw new Error('O alerta exige falha comprovada ou revisão explícita antes de tentar novamente. Resultados incertos não são repetidos.');
    const retry = this._save('alerts', { ...alert, status: 'pending', messageId: alert.reviewedBy && alert.reviewedConfirmed === false ? randomBytes(16).toString('hex').toUpperCase() : alert.messageId, lifetimeAttempts: (alert.lifetimeAttempts || 0) + (alert.attempts || 0), attempts: 0, nextAttemptAt: this.now(), resultAt: null, error: null, retryEligible: false, retriedAt: this.now(), retriedBy: userId || null });
    this._audit('alert.retry', id, userId, 'Nova tentativa manual autorizada após falha conhecida ou revisão.');
    this._trace(retry, 'queue', 'ALERT_MANUAL_RETRY', 'Tentativa manual registrada.', 'Aviso pendente; nenhuma confirmação antecipada.');
    await this._flushQueued([id]);
    return this._get('alerts', id);
  }

  async resolveUncertain(id, { confirmed, userId } = {}) {
    const alert = this._get('alerts', id);
    if (!alert || alert.status !== 'uncertain') throw new Error('O alerta não possui resultado incerto.');
    if (typeof confirmed !== 'boolean') throw new Error('Informe se o envio foi confirmado na revisão.');
    const result = this._save('alerts', { ...alert, status: confirmed ? 'confirmed' : 'failed', retryEligible: !confirmed, resultAt: this.now(), error: confirmed ? null : 'Revisão manual: envio não confirmado; nenhum reenvio automático.', reviewedAt: this.now(), reviewedBy: userId || null, reviewedConfirmed: confirmed });
    this._audit('alert.review', id, userId, confirmed ? 'Envio confirmado manualmente.' : 'Envio não confirmado manualmente.');
    this.emit('change');
    return result;
  }

  muteOccurrence(id) {
    for (const notification of this._list('notifications')) if (notification.id === id || notification.occurrenceId === id) this._save('notifications', { ...notification, muted: true });
    this.emit('muted', { id });
  }

  flush() {
    if (this.flushing) return this.flushing;
    if (this.closed || this.store.persistenceFailed || this.scheduler?.persistenceFailed) return Promise.resolve();
    this.flushing = this._flush().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  waitForIdle() { return this.flushing || Promise.resolve(); }

  async _flushQueued(ids) {
    // A concurrent flush may have read its bounded batch before this command
    // queued the test/retry. Give newly queued work a fresh batch afterward.
    await this.flush();
    if (!this.closed && ids.some(id => { const alert = this._get('alerts', id); return alert?.status === 'pending' && (alert.nextAttemptAt || 0) <= this.now() && (alert.channel === 'webhook' || this.adapter?.status?.state === 'connected'); })) await this.flush();
  }

  async _flush() {
    if (this.scheduler?.runExternalSubmission) return this.scheduler.runExternalSubmission(() => this._flushBatch());
    return this._flushBatch();
  }

  async _flushBatch() {
    const adapter = this.adapter;
    const adapterRevision = this.adapterRevision;
    const mode = this._mode();
    const channel = this.adapter?.status?.state === 'connected' ? undefined : 'webhook';
    const pending = this.store.listPendingAlerts ? this.store.listPendingAlerts({ at: this.now(), channel, limit: 50 }) : this._list('alerts', { status: 'pending' }).filter(a => (!channel || a.channel === channel) && (a.nextAttemptAt || 0) <= this.now()).sort((a, b) => a.createdAt - b.createdAt).slice(0, 50);
    if (!pending.length) return;
    const release = this.scheduler?.holdSubmissions?.() || (() => {});
    try {
      await this.scheduler?.waitForIdle?.();
      for (const snapshot of pending) {
        if (this.closed || this.store.persistenceFailed || this.scheduler?.persistenceFailed || adapterRevision !== this.adapterRevision || mode !== this._mode()) break;
        const alert = this._get('alerts', snapshot.id);
        if (alert?.status !== 'pending' || (alert.nextAttemptAt || 0) > this.now()) continue;
        if ((alert.integrationMode && alert.integrationMode !== mode) || (mode === 'whatsapp' && alert.simulation === true)) continue;
        if (alert.channel === 'whatsapp' && adapter?.status?.state !== 'connected') continue;
        if (alert.channel === 'webhook' && !this.sendWebhook) continue;
        if (mode === 'simulated' && alert.channel === 'webhook') {
          this._save('alerts', { ...alert, status: 'failed', resultAt: this.now(), error: 'Canal externo bloqueado durante a simulação.', errorCode: 'SIMULATION_EXTERNAL_SEND_BLOCKED', retryEligible: false });
          this._trace(alert, 'failure', 'SIMULATION_EXTERNAL_SEND_BLOCKED', 'A simulação não pode enviar avisos por um canal externo real.', 'Envio externo bloqueado.');
          continue;
        }
        const minimum = Math.max(3, adapter.minimumSpacingSeconds || 3) * 1000;
        const last = this.scheduler?.lastSubmissionAt;
        if (alert.channel === 'whatsapp' && last != null) await this.sleep(Math.max(0, minimum - (this.now() - last)));
        if (this.closed || this.store.persistenceFailed || adapterRevision !== this.adapterRevision || mode !== this._mode() || (alert.channel === 'whatsapp' && adapter.status.state !== 'connected')) continue;
        const attempt = (alert.attempts || 0) + 1;
        this._save('alerts', { ...alert, attempts: attempt });
        if (this.store.persistenceFailed || this.scheduler?.persistenceFailed) break;
        let submitted = false;
        try {
          let result;
          if (alert.channel === 'whatsapp') {
            this._validateRecipient(alert);
            const resolved = adapter.resolveRecipient ? await adapter.resolveRecipient(alert.number) : null;
            const targetId = typeof resolved === 'string' ? resolved : resolved?.jid || null;
            if (resolved && ((resolved.mode && resolved.mode !== mode) || (mode === 'whatsapp' && resolved.simulation === true))) throw Object.assign(new Error('Destinatário pertence a outro modo de execução.'), { code: 'RECIPIENT_MODE_MISMATCH', definitive: true });
            if (this.closed || this.store.persistenceFailed || adapterRevision !== this.adapterRevision || mode !== this._mode() || adapter.status.state !== 'connected') {
              this._save('alerts', { ...this._get('alerts', alert.id), status: 'pending', attempts: Math.max(0, attempt - 1) });
              continue;
            }
            // Recipient lookup can wait on the network. Permission and contact
            // changes made during that wait must take effect before submission.
            this._validateRecipient(alert);
            this._save('alerts', { ...this._get('alerts', alert.id), status: 'sending', targetId, isSelf: resolved?.isSelf === true, submittedAt: this.now() });
            this._trace(alert, 'recipient', 'ALERT_RECIPIENT_RESOLVED', resolved?.isSelf ? 'Destinatário resolvido como a própria conta conectada.' : 'Destinatário privado resolvido pela integração.', 'Iniciando submissão; envio ainda não confirmado.', attempt);
            if (this.scheduler) this.scheduler.lastSubmissionAt = this.now();
            submitted = true;
            result = await adapter.sendPrivate(alert.number, alert.text, { clientMessageId: alert.messageId });
          } else {
            const config = this.store.getSetting('independentAlertChannel', null);
            if (!config?.enabled || !/^https:\/\//i.test(config.url || '')) throw Object.assign(new Error('Canal independente indisponível.'), { safeToRetry: true, definitive: true });
            const secret = await this.secretGet(config.secretId || 'independentAlertChannel');
            if (!secret) throw Object.assign(new Error('Credencial do canal ausente.'), { definitive: true });
            this._save('alerts', { ...this._get('alerts', alert.id), status: 'sending', submittedAt: this.now() });
            submitted = true;
            result = await this.sendWebhook({ url: config.url, secret, message: alert.text, occurrenceId: alert.occurrenceId, originalAt: alert.originalAt, idempotencyKey: alert.messageId });
          }
          const current = this._get('alerts', alert.id);
          const confirmed = result?.status === 'confirmed' || ['confirmed', 'delivered'].includes(current.status);
          const delivered = current.status === 'delivered' || (confirmed && ['whatsapp-delivered', 'whatsapp-read'].includes(result?.confirmationScope));
          this._save('alerts', { ...current, status: delivered ? 'delivered' : confirmed ? 'confirmed' : 'uncertain', resultAt: current.resultAt || this.now(), messageId: result?.messageId || alert.messageId, confirmationScope: confirmed ? alert.channel === 'webhook' ? 'channel-accepted' : delivered ? current.confirmationScope || result.confirmationScope : result?.confirmationScope || current.confirmationScope || 'whatsapp-server' : null, ...(delivered ? { deliveredAt: current.deliveredAt || result?.deliveredAt || this.now() } : {}), errorCode: confirmed ? null : 'ALERT_SEND_UNCERTAIN', retryEligible: false, error: confirmed ? null : 'Resultado de alerta incerto; revisão necessária.' });
          this._trace(alert, 'result', confirmed ? delivered ? 'ALERT_DELIVERED' : 'ALERT_CONFIRMED' : 'ALERT_SEND_UNCERTAIN', confirmed ? delivered ? 'A integração confirmou entrega ao dispositivo.' : 'A integração confirmou recebimento pelo servidor.' : 'A integração não comprovou o envio do aviso.', confirmed ? 'Resultado confirmado; nenhum reenvio.' : 'Alerta separado para revisão; nenhum reenvio automático.', attempt);
        } catch (error) {
          const acknowledged = this._get('alerts', alert.id);
          if (['confirmed', 'delivered'].includes(acknowledged?.status)) {
            // A real receipt may race a timeout/rejection of the request
            // promise. Its proof wins; never downgrade it into retryable work.
            this._trace(acknowledged, 'result', acknowledged.status === 'delivered' ? 'ALERT_DELIVERED' : 'ALERT_CONFIRMED', 'Recibo confirmado preservado após falha da solicitação de transporte.', 'Nenhum reenvio: a integração já confirmou o aviso.', attempt);
            this.emit('change');
            continue;
          }
          const safe = !submitted || error?.safeToRetry === true;
          const definitive = safe || error?.definitive === true;
          const policy = this.store.getCampaign(alert.campaignId)?.retryPolicy || { maxAttempts: 3, delaySeconds: 15 };
          const max = Math.max(1, Math.min(5, Number.isInteger(policy.maxAttempts) ? policy.maxAttempts : 3));
          // The integration uses definitive=true to mean a *known failed*
          // submission, including transient lookup failures. safeToRetry=true
          // remains its explicit proof that a bounded retry is permitted.
          const autoRetry = error?.safeToRetry === true || (!submitted && error?.definitive !== true && error?.safeToRetry !== false);
          const status = autoRetry && attempt < max ? 'pending' : definitive ? 'failed' : 'uncertain';
          const errorCode = codeOf(error?.code, 'ALERT_SEND_ERROR');
          const explanations = { RECIPIENT_NOT_REGISTERED: 'O número não foi encontrado no WhatsApp. Confira país, DDD e número.', WA_RECIPIENT_NOT_FOUND: 'O número não foi encontrado no WhatsApp. Confira país, DDD e número.', RECIPIENT_NUMBER_INVALID: 'O telefone precisa conter código do país, DDD e número.', WA_RECIPIENT_INVALID: 'O telefone precisa conter código do país, DDD e número.', RECIPIENT_SELF_UNAVAILABLE: 'A integração ainda não identificou o número da própria conta. Reconecte e tente novamente.', WA_RECIPIENT_TIMEOUT: 'O WhatsApp não respondeu à consulta do destinatário. Confira a internet e tente novamente após o intervalo.', WA_RECIPIENT_OFFLINE: 'A conexão caiu antes de resolver o destinatário. O envio não ocorreu.', WA_RECIPIENT_UNSUPPORTED: 'A integração conectada não oferece a consulta de destinatários exigida. Atualize o aplicativo e reconecte o WhatsApp.', WA_RECIPIENT_MISMATCH: 'O WhatsApp retornou uma conta diferente do número solicitado. Confira o número e a sessão; o destino não foi substituído.', ALERT_RECIPIENT_DISABLED: 'O destinatário foi removido, desativado ou teve o telefone alterado. Confira o cadastro.', RECIPIENT_MODE_MISMATCH: 'O destinatário pertence a outro modo. Confira a conexão selecionada.' };
          const explanation = explanations[errorCode] || (status === 'pending' ? 'Falha anterior à submissão; tentativa limitada pendente.' : status === 'failed' ? 'Alerta falhou. Confira a conexão, o país/DDD do número e o cadastro do destinatário.' : 'Resultado de alerta incerto; revisão necessária antes de repetir.');
          this._save('alerts', { ...this._get('alerts', alert.id), status, resultAt: status === 'pending' ? null : this.now(), nextAttemptAt: this.now() + Math.max(3, Math.min(3600, Number(policy.delaySeconds) || 15), adapter.minimumSpacingSeconds || 3) * 1000, errorCode, retryEligible: status === 'failed' && definitive, error: explanation });
          this._trace(alert, 'failure', errorCode, explanation, status === 'pending' ? 'Nova tentativa limitada agendada.' : status === 'failed' && definitive ? 'Envio não ocorreu. Uma nova tentativa manual pode ser solicitada.' : 'Revisão do alerta necessária.', attempt);
        }
        this.emit('change');
      }
    } finally { release(); }
  }

  async _onStatus(status) {
    const previous = this.previousState;
    this.previousState = status.state;
    if (status.state === 'connected') {
      this._cancelReconnect();
      this.reconnectAttempts = 0;
      const occurrence = this.disconnectOccurrence;
      this.disconnectOccurrence = null;
      if (this.store.setSetting) this.store.setSetting(`alertDisconnectOccurrence:${this._mode()}`, null);
      if (occurrence && this.store.getSetting('reconnect', {}).autoResume === true) {
        for (const [id, revision] of this.activeBeforeDisconnect) {
          const c = this.store.getCampaign(id);
          if (c?.state !== 'paused' || (c.configRevision ?? configurationFingerprint(c)) !== revision || !/^Conexão indisponível/.test(c.pauseReason || '')) continue;
          if (this.store.listJobs({ campaignId: id, status: 'uncertain', limit: 1 }).length) continue;
          try { await this.scheduler.resume(id); } catch { /* The scheduler validates all safety conditions again. */ }
        }
      }
      this._rememberActive();
      await this.flush();
      return;
    }
    if (status.state === 'connecting' || status.state === 'qr') return;
    if (status.reasonCode === 'manual' || status.manual) { this._cancelReconnect(); this.activeBeforeDisconnect.clear(); return; }
    if (!this.disconnectOccurrence && (previous === 'connected' || ['expired', 'session_expired', 'internet', 'unexpected'].includes(status.reasonCode))) {
      const reason = { internet: 'Sem conexão com a internet.', expired: 'A sessão do WhatsApp expirou; conecte novamente.', session_expired: 'A sessão do WhatsApp expirou; conecte novamente.', restricted: 'O serviço restringiu os envios. Confira os limites e aguarde a liberação da integração.', unexpected: 'O WhatsApp desconectou inesperadamente.' }[status.reasonCode] || 'A conexão com o WhatsApp foi interrompida.';
      const originalAt = typeof status.at === 'number' ? status.at : Date.parse(status.at);
      this.disconnectOccurrence = { id: randomUUID(), at: Number.isFinite(originalAt) ? originalAt : this.now(), code: codeOf(status.errorCode || status.code, 'WHATSAPP_DISCONNECTED'), reason, event: 'disconnect', integrationMode: this._mode() };
      if (this.store.setSetting) this.store.setSetting(`alertDisconnectOccurrence:${this._mode()}`, this.disconnectOccurrence);
      this.recordSystemIncident(this.disconnectOccurrence);
    }
    this._scheduleReconnect(status);
  }

  _cancelReconnect() { if (this.reconnectTimer) this.clearTimer(this.reconnectTimer); this.reconnectTimer = null; }

  _scheduleReconnect(status) {
    const config = this.store.getSetting('reconnect', {});
    const maximum = Number.isInteger(config.maxAttempts) ? Math.max(0, Math.min(10, config.maxAttempts)) : 3;
    if (this.closed || !config.enabled || ['connecting', 'qr', 'connected'].includes(status.state) || status.retryable === false || ['manual', 'expired', 'session_expired'].includes(status.reasonCode) || this.reconnectTimer || this.reconnecting || this.reconnectAttempts >= maximum) return;
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;
      void this.reconnect().catch(() => {}).finally(() => { if (this.adapter.status.state !== 'connected') this._scheduleReconnect(this.adapter.status); });
    }, Math.max(3, config.delaySeconds || 15) * 1000);
    this.reconnectTimer.unref?.();
  }

  reconnect() {
    if (this.reconnecting) return this.reconnecting;
    this._cancelReconnect();
    this.reconnecting = Promise.resolve().then(() => this.adapter.connect({ reconnect: true })).finally(() => { this.reconnecting = null; });
    return this.reconnecting;
  }

  networkStateChanged({ online } = {}) {
    if (typeof online !== 'boolean') throw new Error('Estado da rede inválido.');
    if (this.adapter.setNetworkState) return this.adapter.setNetworkState({ online });
    if (this.adapter.setNetworkOnline) return this.adapter.setNetworkOnline(online);
    return Promise.resolve();
  }

  async shutdown() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this._cancelReconnect();
    this.scheduler?.off('incident', this.incidentListener);
    this.scheduler?.off('change', this.changeListener);
    this.adapter?.off('status', this.statusListener);
    this.adapter?.off('receipt', this.receiptListener);
    if (this.flushing) await this.flushing;
  }
}

module.exports = { AlertService, alertText, validPhone };
