'use strict';

const { EventEmitter } = require('node:events');
const { randomUUID, randomBytes } = require('node:crypto');
const { configurationFingerprint } = require('./campaign-version.cjs');

const validPhone = value => typeof value === 'string' && /^[1-9]\d{9,14}$/.test(value);
const copy = value => structuredClone(value);
const codeOf = (value, fallback) => typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value) ? value : fallback;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function alertText(incident) {
  return `🚨 Campanha interrompida por erro\n\n📣 Campanha: ${String(incident.campaignName || 'Campanha').slice(0, 200)}\n🕒 Data e horário: ${new Date(incident.at).toLocaleString('pt-BR')}\n⚠️ Motivo: ${String(incident.reason || 'Falha de envio.').slice(0, 240)}\n✅ Envios confirmados: ${incident.confirmed || 0}\n⏳ Pendentes: ${incident.pending || 0}\n🔎 Código do erro: ${codeOf(incident.code, 'CAMPAIGN_ERROR')}\n\nAcesse o sistema para verificar os detalhes e decidir sobre a retomada.`;
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
    this.incidentListener = incident => { try { this.recordIncident(incident); } catch { this.scheduler?.blockOnPersistenceFailure(); } };
    this.changeListener = details => {
      if (details?.error && this.scheduler?.persistenceFailed && !this.storageAlertShown) {
        this.storageAlertShown = true;
        this.emit('localAlert', { id: 'storage-failure', occurrenceId: 'storage-failure', event: 'critical', title: 'Envios bloqueados por falha de armazenamento', body: 'Confira o espaço e as permissões do disco. Reabra o aplicativo após corrigir a falha e revise resultados incertos.', reason: 'Falha de persistência.', at: this.now(), campaignId: null });
      }
      if (!this.store.persistenceFailed) this._rememberActive();
    };
    this.statusListener = status => { void this._onStatus(status).catch(() => this.scheduler?.blockOnPersistenceFailure()); };
    this.receiptListener = receipt => {
      if (receipt.status !== 'confirmed' || !receipt.messageId) return;
      try {
        const matches = this.store.findAlertsByMessageId ? this.store.findAlertsByMessageId(receipt.messageId) : this._list('alerts', { status: 'uncertain' });
        for (const alert of matches) {
          if (alert.messageId === receipt.messageId) this._save('alerts', { ...alert, status: 'confirmed', resultAt: this.now(), error: null });
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

  _diagnostic(code, description, action, campaignId, attempts = 0) {
    if (this.store.addDiagnostic) this.store.addDiagnostic({ id: randomUUID(), at: this.now(), campaignId: campaignId || null, userId: null, stage: 'alerta', code, description, attempts, action, guidance: 'Confira a conexão. Um resultado incerto exige revisão antes de repetir.' });
  }

  start() {
    if (this.started || this.closed) return;
    this.started = true;
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
    this.adapter = adapter;
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
    const explicit = new Set(campaign?.alertRecipientIds || []);
    for (const r of this._list('alert_recipients')) {
      if (r.enabled !== false && explicit.has(r.id) && validPhone(r.phone)) result.set(r.phone, { id: r.id, phone: r.phone });
    }
    const responsible = new Set(campaign?.responsibleUserIds || []);
    for (const u of this._list('users')) {
      if (u.active === false || !validPhone(u.phone)) continue;
      const role = this.store.getEntity?.('roles', u.roleId);
      if (role?.isOwner || u.roleId === 'role-owner' || responsible.has(u.id)) result.set(u.phone, { id: `user:${u.id}`, phone: u.phone });
    }
    return [...result.values()];
  }

  _local(incident, event, title, body) {
    const id = `${incident.id}:${event}`;
    const existing = this._get('notifications', id);
    if (existing) return existing;
    const notification = this._save('notifications', { id, occurrenceId: incident.id, event, title, body, at: incident.at, reason: incident.reason, campaignId: incident.campaignId || null, muted: false });
    this.emit('localAlert', copy(notification));
    this.emit('change');
    return notification;
  }

  recordIncident(incident) {
    if (this.closed || !incident?.id) return;
    const campaign = this.store.getCampaign(incident.campaignId);
    if (!campaign) return;
    const persisted = campaign.lastError?.id === incident.id ? campaign.lastError : incident;
    const recipientSnapshot = persisted.recipientSnapshot || this._recipients(campaign);
    const webhook = this.store.getSetting('independentAlertChannel', null);
    const independentQueued = persisted.independentQueued ?? Boolean(webhook?.enabled && webhook.url && this.sendWebhook && this.secretGet);
    if (!persisted.recipientSnapshot && campaign.lastError?.id === incident.id) this.store.saveCampaign({ ...campaign, lastError: { ...campaign.lastError, recipientSnapshot, independentQueued } });
    if (!campaign.lastError?.localNotified) {
      this._local(incident, 'critical', incident.kind === 'uncertain' ? 'Envio precisa de revisão' : 'Campanha interrompida por erro', `${incident.campaignName || campaign.name}: ${incident.reason}`);
      if (campaign.lastError?.id === incident.id) {
        const latest = this.store.getCampaign(campaign.id);
        this.store.saveCampaign({ ...latest, lastError: { ...latest.lastError, localNotified: true } });
      }
    }
    const text = alertText({ ...incident, campaignName: incident.campaignName || campaign.name });
    for (const recipient of recipientSnapshot) this._queue(incident, recipient, 'whatsapp', text);
    if (independentQueued) this._queue(incident, { id: 'independent-webhook' }, 'webhook', text);
    this.emit('change');
    queueMicrotask(() => { void this.flush().catch(() => this.scheduler?.blockOnPersistenceFailure()); });
  }

  _queue(incident, recipient, channel, text) {
    // Deterministic key survives restarts and settings changes. Phone numbers
    // are destinations, never message contents or diagnostic descriptions.
    const id = `${incident.id}:${channel}:${recipient.phone || recipient.id}`;
    const old = this._get('alerts', id);
    if (old) return old;
    return this._save('alerts', { id, occurrenceId: incident.id, campaignId: incident.campaignId || null, recipientId: recipient.id, number: recipient.phone || null, channel, status: 'pending', createdAt: this.now(), originalAt: incident.at, messageId: randomBytes(16).toString('hex').toUpperCase(), text, attempts: 0, nextAttemptAt: this.now(), resultAt: null, code: codeOf(incident.code, 'CAMPAIGN_ERROR'), error: null });
  }

  async testRecipient(phone, userId) {
    if (!validPhone(phone)) throw new Error('Informe o telefone com código do país e DDD, entre 10 e 15 dígitos.');
    const incident = { id: randomUUID(), at: this.now(), code: 'ALERT_TEST' };
    const alert = this._queue(incident, { id: 'test', phone }, 'whatsapp', '🔔 Teste de alerta do Mega Disparos. Nenhuma campanha foi ativada.');
    this._audit('alert.test', alert.id, userId, 'Teste de destinatário solicitado.');
    await this.flush();
    return this._get('alerts', alert.id);
  }

  async resolveUncertain(id, { confirmed, userId } = {}) {
    const alert = this._get('alerts', id);
    if (!alert || alert.status !== 'uncertain') throw new Error('O alerta não possui resultado incerto.');
    if (typeof confirmed !== 'boolean') throw new Error('Informe se o envio foi confirmado na revisão.');
    const result = this._save('alerts', { ...alert, status: confirmed ? 'confirmed' : 'failed', resultAt: this.now(), error: confirmed ? null : 'Revisão manual: envio não confirmado; nenhum reenvio automático.', reviewedAt: this.now(), reviewedBy: userId || null });
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

  async _flush() {
    if (this.scheduler?.runExternalSubmission) return this.scheduler.runExternalSubmission(() => this._flushBatch());
    return this._flushBatch();
  }

  async _flushBatch() {
    const channel = this.adapter?.status?.state === 'connected' ? undefined : 'webhook';
    const pending = this.store.listPendingAlerts ? this.store.listPendingAlerts({ at: this.now(), channel, limit: 50 }) : this._list('alerts', { status: 'pending' }).filter(a => (!channel || a.channel === channel) && (a.nextAttemptAt || 0) <= this.now()).sort((a, b) => a.createdAt - b.createdAt).slice(0, 50);
    if (!pending.length) return;
    const release = this.scheduler?.holdSubmissions?.() || (() => {});
    try {
      await this.scheduler?.waitForIdle?.();
      for (const snapshot of pending) {
        if (this.closed || this.store.persistenceFailed || this.scheduler?.persistenceFailed) break;
        const alert = this._get('alerts', snapshot.id);
        if (alert?.status !== 'pending' || (alert.nextAttemptAt || 0) > this.now()) continue;
        if (alert.channel === 'whatsapp' && this.adapter?.status?.state !== 'connected') continue;
        if (alert.channel === 'webhook' && !this.sendWebhook) continue;
        const minimum = Math.max(3, this.adapter.minimumSpacingSeconds || 3) * 1000;
        const last = this.scheduler?.lastSubmissionAt;
        if (alert.channel === 'whatsapp' && last != null) await this.sleep(Math.max(0, minimum - (this.now() - last)));
        if (this.closed || this.store.persistenceFailed || (alert.channel === 'whatsapp' && this.adapter.status.state !== 'connected')) continue;
        const attempt = (alert.attempts || 0) + 1;
        this._save('alerts', { ...alert, status: 'sending', attempts: attempt, submittedAt: this.now() });
        if (this.store.persistenceFailed || this.scheduler?.persistenceFailed) break;
        try {
          let result;
          if (alert.channel === 'whatsapp') {
            if (this.scheduler) this.scheduler.lastSubmissionAt = this.now();
            result = await this.adapter.sendPrivate(alert.number, alert.text, { clientMessageId: alert.messageId });
          } else {
            const config = this.store.getSetting('independentAlertChannel', null);
            if (!config?.enabled || !/^https:\/\//i.test(config.url || '')) throw Object.assign(new Error('Canal independente indisponível.'), { safeToRetry: true, definitive: true });
            const secret = await this.secretGet(config.secretId || 'independentAlertChannel');
            if (!secret) throw Object.assign(new Error('Credencial do canal ausente.'), { definitive: true });
            result = await this.sendWebhook({ url: config.url, secret, message: alert.text, occurrenceId: alert.occurrenceId, originalAt: alert.originalAt, idempotencyKey: alert.messageId });
          }
          const confirmed = result?.status === 'confirmed';
          this._save('alerts', { ...this._get('alerts', alert.id), status: confirmed ? 'confirmed' : 'uncertain', resultAt: this.now(), messageId: result?.messageId || alert.messageId, confirmationScope: alert.channel === 'webhook' ? 'channel-accepted' : 'whatsapp-server', error: confirmed ? null : 'Resultado de alerta incerto; revisão necessária.' });
        } catch (error) {
          const safe = error?.safeToRetry === true;
          const definitive = safe || error?.definitive === true;
          const policy = this.store.getCampaign(alert.campaignId)?.retryPolicy || { maxAttempts: 3, delaySeconds: 15 };
          const max = policy.maxAttempts;
          const status = safe && attempt < max ? 'pending' : definitive ? 'failed' : 'uncertain';
          this._save('alerts', { ...this._get('alerts', alert.id), status, resultAt: status === 'pending' ? null : this.now(), nextAttemptAt: this.now() + Math.max(policy.delaySeconds, this.adapter.minimumSpacingSeconds || 3) * 1000, error: status === 'pending' ? 'Falha anterior à submissão; tentativa limitada pendente.' : status === 'failed' ? 'Alerta falhou; confira a configuração e a conexão.' : 'Resultado de alerta incerto; revisão necessária antes de repetir.' });
          this._diagnostic(codeOf(error?.code, 'ALERT_SEND_ERROR'), 'O alerta não recebeu confirmação de envio.', status === 'pending' ? 'Nova tentativa limitada agendada.' : 'Revisão do alerta necessária.', alert.campaignId, attempt);
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
      this.disconnectOccurrence = { id: randomUUID(), at: Number.isFinite(originalAt) ? originalAt : this.now(), code: codeOf(status.errorCode || status.code, 'WHATSAPP_DISCONNECTED'), reason };
      this._local(this.disconnectOccurrence, 'disconnect', 'WhatsApp desconectado', `${reason} Envios pausados com segurança. Use Reconectar WhatsApp.`);
      this._diagnostic(this.disconnectOccurrence.code, reason, 'Campanhas pausadas com segurança.', null);
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
