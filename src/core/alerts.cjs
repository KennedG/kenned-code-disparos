'use strict';

const { EventEmitter } = require('node:events');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { configurationFingerprint } = require('./campaign-version.cjs');
const { normalizePhone } = require('./phone.cjs');

const validPhone = value => typeof value === 'string' && /^[1-9]\d{9,14}$/.test(value);
const copy = value => structuredClone(value);
const codeOf = (value, fallback) => typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value) ? value : fallback;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeDescription = value => String(value || '')
  .replace(/(Bearer\s+)[\w.\-]+/gi, '$1[omitido]')
  .replace(/((?:password|senha|token|secret|authorization|credential|api[_-]?key|private[_-]?key)\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[omitido]')
  .replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/gi, 'https://[omitido]@')
  .replace(/KCD-[MA]-[A-HJ-NP-Z2-9]{8}(?:-[A-HJ-NP-Z2-9]{8}){3}/gi, '[licença omitida]')
  .slice(0, 500);
const technicalDescription = error => {
  const description = safeDescription(error?.message);
  // Some providers emit a bare credential/secret instead of a structured
  // error. Keep actionable errors, never expose a suspicious unlabelled value.
  return /(?:secret|password|senha|token|credential)/i.test(description.replace(/(?:password|senha|token|secret|authorization|credential)\s*[=:]\s*\[omitido\]/gi, '')) ? 'Detalhe sensível do transporte omitido.' : description;
};
const timestampText = (at, timezone = 'America/Sao_Paulo') => {
  try { return new Date(at).toLocaleString('pt-BR', { timeZone: timezone }); } catch { return new Date(at).toISOString(); }
};
const computerTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo';

function alertText(incident) {
  const at = timestampText(incident.at, incident.timezone);
  const reason = safeDescription(incident.reason || 'Falha de envio.').slice(0, 240);
  if (incident.event === 'destination') {
    const summary = incident.summary === true;
    const connectivity = incident.connectionAvailable === true ? '✅ Os demais grupos elegíveis continuarão sendo processados.' : '⏸️ A conexão geral está indisponível. Os envios estão suspensos até a reconexão.';
    return `${summary ? '⚠️ Resumo de falhas no grupo' : '⚠️ Não foi possível enviar para um grupo'}\n\n📢 Campanha: ${safeDescription(incident.campaignName || 'Campanha')}\n👥 Grupo: ${safeDescription(incident.groupName || 'Nome indisponível')}\n🆔 ID: ${safeDescription(incident.groupId)}\n📱 Item: ${safeDescription(incident.itemLabel || 'Item não identificado')}\n❗ Motivo: ${reason}\n🔎 Código: ${codeOf(incident.code, 'GROUP_SEND_FAILED')}\n🕒 Ocorrência original: ${at}${summary ? `\n🔁 Recorrências neste período: ${incident.recurrences || 0}\n🕒 Última ocorrência: ${timestampText(incident.lastAt, incident.timezone)}` : ''}\n\n${connectivity}\n🔧 Ação necessária: Revise a conexão ou a permissão do grupo. Verifique novamente o destino no aplicativo antes de reativá-lo. Nenhum envio incerto será repetido automaticamente.`;
  }
  if (incident.event === 'disconnect') {
    const affected = (incident.affectedCampaigns || []).map(c => `📣 ${safeDescription(c.name)} — ${c.pending || 0} mensagens pendentes`).join('\n');
    return `🚨 WhatsApp desconectado\n\n🕒 Ocorrência original: ${at}\n⚠️ Motivo: ${reason}\n🔎 Código do erro: ${codeOf(incident.code, 'WHATSAPP_DISCONNECTED')}${affected ? `\n\n${affected}` : ''}${incident.recoveredAt ? `\n\n✅ Conexão recuperada: ${timestampText(incident.recoveredAt, incident.timezone)}` : ''}\n\nOs envios da campanha aguardam o próximo horário programado. Este aviso ficou pendente enquanto a conexão estava indisponível. Acesse o Kenned Code Disparos para verificar a conexão.`;
  }
  if(incident.event==='synchronization')return `⚠️ Sincronização do WhatsApp — Kenned Code Disparos\n\n🕒 Ocorrência: ${at}\n${reason}\n🔎 Código: ${codeOf(incident.code,'WA_DECRYPTION_UNAVAILABLE')}\n\nO conteúdo não foi inventado. Confira o aparelho principal e o diagnóstico da sessão. As demais mensagens elegíveis continuam sendo processadas conforme a conexão.`;
  if (incident.event === 'qr-required') return `📲 ${incident.recoveredAt ? 'Aviso da leitura de QR Code necessária durante a falha' : 'Nova leitura de QR Code necessária'} — Kenned Code Disparos\n\n🕒 Ocorrência original: ${at}\n⚠️ ${reason}\n\n${incident.recoveredAt ? `✅ Sessão recuperada: ${timestampText(incident.recoveredAt, incident.timezone)}. A conexão já está pronta; as campanhas aguardam o próximo horário programado.` : 'Abra o aplicativo e leia o QR Code em Aparelhos conectados do WhatsApp. As campanhas permanecem pausadas; este aviso só poderá sair quando houver conexão ou um canal independente autorizado.'}`;
  if (!incident.campaignId && !incident.campaignName) return `${incident.event === 'test' ? '🔔 Teste de alerta' : '🚨 Falha crítica'} — Kenned Code Disparos\n\n🕒 Ocorrência original: ${at}\n⚠️ Motivo: ${reason}\n🔎 Código do erro: ${codeOf(incident.code, 'SYSTEM_ERROR')}\n\nAcesse o sistema para verificar os detalhes. Nenhuma campanha foi ativada por este aviso.`;
  return `🚨 Campanha interrompida por erro\n\n📣 Campanha: ${String(incident.campaignName || 'Campanha').slice(0, 200)}\n🕒 Data e horário: ${at}\n⚠️ Motivo: ${reason}\n✅ Envios confirmados: ${incident.confirmed || 0}\n⏳ Pendentes: ${incident.pending || 0}\n🔎 Código do erro: ${codeOf(incident.code, 'CAMPAIGN_ERROR')}\n\nAcesse o sistema para verificar os detalhes e decidir sobre a retomada.`;
}

// This service never infers delivery from a successful request or socket write.
// Every network submission has a durable identifier and ambiguous work requires
// human review, including alerts interrupted while the application was closing.
class AlertService extends EventEmitter {
  constructor({ store, scheduler, adapter, now = () => Date.now(), sleep = wait, sendWebhook, secretGet, setTimer = setTimeout, clearTimer = clearTimeout, isAutomationStopped = () => false }) {
    super();
    Object.assign(this, { store, scheduler, adapter, now, sleep, sendWebhook, secretGet, setTimer, clearTimer, isAutomationStopped });
    this.started = false;
    this.closed = false;
    this.timer = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.reconnecting = null;
    this.reconnectNextAttemptAt = null;
    this.connectionPhaseAt=this.now();this.connectionStalled=false;
    this.flushing = null;
    this.disconnectOccurrence = null;
    this.previousState = adapter?.status?.state;
    this.activeBeforeDisconnect = new Map();
    this.storageAlertShown = false;
    this.criticalOccurrence = null;
    this.integrationMode = adapter?.status?.mode === 'simulated' ? 'simulated' : 'whatsapp';
    this.adapterRevision = 0;
    this.stopRevision = 0;
    this.incidentListener = incident => { try { this.recordIncident(incident); } catch { this.scheduler?.blockOnPersistenceFailure(); } };
    this.changeListener = details => {
      if (details?.error && this.scheduler?.persistenceFailed && !this.storageAlertShown) {
        this.storageAlertShown = true;
        // Persistence cannot be trusted here. Notify immediately, but never
        // pretend that a private warning could be durably queued on this disk.
        this.emit('localAlert', { id: 'storage-failure', occurrenceId: 'storage-failure', traceId: 'storage-failure', event: 'critical', title: 'Envios bloqueados por falha de armazenamento', body: 'Confira o espaço e as permissões do disco. Reabra o aplicativo após corrigir a falha e revise resultados incertos. O alerta privado não pôde ser salvo.', reason: 'Falha de persistência.', at: this.now(), campaignId: null, active: true, blocking: true, persistentAlarm: true, bringToFront: true, integrationMode: this._mode(), simulation: this._mode() === 'simulated' });
      }
      if (details?.error && !this.scheduler?.persistenceFailed && !this.store.persistenceFailed) {
        this.criticalOccurrence ||= randomUUID();
        const affectedCampaigns = this._affectedCampaigns();
        const incident = { id: details.occurrenceId || this.criticalOccurrence, traceId: details.traceId, at: this.now(), event: 'critical', code: codeOf(details.code, 'SYSTEM_PROCESSING_ERROR'), reason: 'Falha crítica no processamento. Consulte o diagnóstico do sistema.', affectedCampaigns, blocking: affectedCampaigns.length > 0 };
        try { this.recordSystemIncident(incident); } catch { this.scheduler?.blockOnPersistenceFailure(); }
      }
      if (!details?.error) this.criticalOccurrence = null;
      if (!this.store.persistenceFailed) this._rememberActive();
    };
    this.statusListener = status => { void this._onStatus(status).catch(() => this.scheduler?.blockOnPersistenceFailure()); };
    this.receiptListener = receipt => {
      if (!['accepted', 'confirmed', 'delivered', 'read'].includes(receipt.status) || !receipt.messageId || (receipt.mode && receipt.mode !== this._mode()) || (this._mode() === 'whatsapp' && receipt.simulation === true)) return;
      try {
        const matches = this.store.findAlertsByMessageId ? this.store.findAlertsByMessageId(receipt.messageId) : this._list('alerts').filter(alert => alert.messageId === receipt.messageId);
        for (const alert of matches) {
          if (alert.messageId !== receipt.messageId || alert.status === 'cancelled' || (alert.integrationMode && alert.integrationMode !== this._mode())) continue;
          const delivered = ['delivered', 'read'].includes(receipt.status) || ['whatsapp-delivered', 'whatsapp-read'].includes(receipt.confirmationScope);
          this._save('alerts', { ...alert, status: delivered || alert.status === 'delivered' ? 'delivered' : 'confirmed', resultAt: alert.resultAt || this.now(), lastAcceptedAt: alert.lastAcceptedAt || this.now(), acceptedAt: alert.acceptedAt || receipt.acceptedAt || this.now(), confirmationScope: alert.confirmationScope === 'whatsapp-read' ? 'whatsapp-read' : delivered ? receipt.confirmationScope || (receipt.status === 'read' ? 'whatsapp-read' : 'whatsapp-delivered') : alert.confirmationScope || receipt.confirmationScope || 'whatsapp-server', ...(delivered ? { deliveredAt: alert.deliveredAt || receipt.deliveredAt || this.now() } : {}), ...(receipt.readAt ? { readAt: alert.readAt || receipt.readAt } : {}), error: null, errorCode: null, technicalError: null, retryEligible: false });
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

  _stopped() { return this.isAutomationStopped() === true; }

  _requireRunning() {
    if (this._stopped()) throw Object.assign(new Error('Os envios automáticos estão interrompidos. Retome explicitamente o sistema antes de testar ou reenviar alertas.'), { code: 'AUTOMATION_STOPPED' });
  }

  stopPending({ userId, reason = 'Interrompido pelo comando parar tudo.' } = {}) {
    this.stopRevision++;
    let cancelled = 0;
    const inFlight = this._list('alerts', { status: 'sending' }).length;
    for (const alert of this._list('alerts', { status: 'pending' })) {
      this._save('alerts', { ...alert, status: 'cancelled', cancelledAt: this.now(), cancelledBy: userId || null, resultAt: this.now(), retryEligible: false, errorCode: 'AUTOMATION_STOPPED', error: safeDescription(reason) });
      this._trace(alert, 'cancelled', 'AUTOMATION_STOPPED', 'Alerta pendente cancelado antes da submissão.', 'Nenhuma nova tentativa automática.');
      cancelled++;
    }
    this.emit('change');
    return { cancelled, inFlight };
  }

  _trace(subject, stage, code, description, action, attempts = 0, detail = {}) {
    const level = detail.level || (stage === 'failure' ? subject.status === 'pending' || subject.status === 'uncertain' ? 'warning' : 'error' : code === 'ALERT_SEND_UNCERTAIN' ? 'warning' : stage === 'occurrence' && code !== 'ALERT_TEST' ? subject.event === 'disconnect' ? 'warning' : 'error' : 'info');
    this._diagnostic(code, description, action, subject.campaignId, attempts, { traceId: subject.traceId || subject.occurrenceId || subject.id, occurrenceId: subject.occurrenceId || subject.id, alertId: subject.occurrenceId ? subject.id : null, recipientId: subject.recipientId || null, targetId: subject.targetId || null, originalAt: subject.originalAt ?? subject.at ?? null, status: subject.status || null, level, error: level === 'error', warning: level === 'warning', stage: `alerta.${stage}`, userId: subject.userId || null, ...detail });
  }

  start() {
    if (this.started || this.closed) return;
    this.started = true;
    const previousDisconnect = this.store.getSetting(`alertDisconnectOccurrence:${this._mode()}`, null);
    if (previousDisconnect?.id && previousDisconnect.integrationMode === this._mode()) this.disconnectOccurrence = previousDisconnect;
    for (const alert of this._list('alerts', { status: 'sending' })) this._save('alerts', { ...alert, status: 'uncertain', resultAt: this.now(), error: 'Envio de alerta interrompido; revisão necessária antes de repetir.' });
    this.scheduler?.on('incident', this.incidentListener);
    this.scheduler?.on('change', this.changeListener);
    this.adapter?.on('status', this.statusListener);
    this.adapter?.on('receipt', this.receiptListener);
    this._rememberActive();
    // A persisted campaign occurrence may have preceded a process crash before
    // alert records were created. Recipient+occurrence keys prevent duplication.
    for (const c of this.store.listCampaigns()) if (c.lastError?.id) this.recordIncident(c.lastError);
    for (const notification of this._list('notifications')) if (notification.active === true && notification.blocking === true && !notification.muted && !notification.resolvedAt && (!notification.integrationMode || notification.integrationMode === this._mode()) && !(notification.event === 'disconnect' && this.adapter?.status?.state === 'connected')) this.emit('localAlert', copy(notification));
    this.timer = setInterval(() => { this.checkRecoveryHealth(); void this.flush().catch(() => this.scheduler?.blockOnPersistenceFailure()); }, 1000);
    this.timer.unref?.();
    void this.flush().catch(() => this.scheduler?.blockOnPersistenceFailure());
    if (this.disconnectOccurrence && this.adapter?.status?.state === 'connected') void this._onStatus(this.adapter.status).catch(() => this.scheduler?.blockOnPersistenceFailure());
    else if (this.adapter?.status?.state === 'disconnected' && !this.store.getSetting(`manualDisconnect:${this._mode()}`, false)) this._scheduleReconnect(this.adapter.status);
  }

  setAdapter(adapter) {
    this.adapter?.off('status', this.statusListener);
    this.adapter?.off('receipt', this.receiptListener);
    const oldMode = this._mode();
    const newMode = adapter.status?.mode === 'simulated' ? 'simulated' : 'whatsapp';
    if (oldMode !== newMode) for (const notification of this._list('notifications')) if (notification.active === true && notification.integrationMode === oldMode) this.resolveIncident(notification.occurrenceId || notification.id, { reason: 'Monitoramento desse modo encerrado pela troca de integração.' });
    this.adapter = adapter;
    this.integrationMode = adapter.status?.mode === 'simulated' ? 'simulated' : 'whatsapp';
    this.adapterRevision++;
    if (oldMode !== this._mode()) { this.disconnectOccurrence = null; this.activeBeforeDisconnect.clear(); this.reconnectAttempts = 0; }
    this.criticalOccurrence = null;
    this.previousState = adapter.status?.state;
    this._cancelReconnect();
    if (this.started) {
      adapter.on('status', this.statusListener);
      adapter.on('receipt', this.receiptListener);
    }
  }

  prepareModeChange() {
    this._cancelReconnect();
    for (const notification of this._list('notifications')) if (notification.active === true && (!notification.integrationMode || notification.integrationMode === this._mode())) this.resolveIncident(notification.occurrenceId || notification.id, { reason: 'Monitoramento desse modo encerrado pela troca de integração.' });
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
      const number=normalizePhone(r.phone);
      if (r.enabled !== false && (explicit ? explicit.has(r.id) : r.systemAlerts !== false) && number) result.set(number, { id: r.id, phone: number });
    }
    const responsible = new Set(campaign?.responsibleUserIds || []);
    for (const u of this._list('users')) {
      const number=normalizePhone(u.phone);
      if (u.active === false || u.requirePasswordChange === true || !number) continue;
      const role = this.store.getEntity?.('roles', u.roleId);
      if (role?.isOwner || u.roleId === 'role-owner' || responsible.has(u.id)) result.set(number, { id: `user:${u.id}`, phone: number });
    }
    return [...result.values()];
  }

  _validateRecipient(alert) {
    if (!validPhone(alert.number)) throw Object.assign(new Error('Telefone do destinatário inválido.'), { code: 'RECIPIENT_NUMBER_INVALID', definitive: true });
    const userRecipient = alert.recipientId?.startsWith('user:');
    const recipient = userRecipient ? this._list('users').find(user => `user:${user.id}` === alert.recipientId) : this._get('alert_recipients', alert.recipientId);
    if (recipient && (recipient.enabled === false || recipient.active === false || normalizePhone(recipient.phone) !== alert.number)) throw Object.assign(new Error('Destinatário desativado ou telefone alterado.'), { code: 'ALERT_RECIPIENT_DISABLED', definitive: true });
    if (alert.recipientId && alert.recipientId !== 'test' && !recipient) throw Object.assign(new Error('Destinatário não está mais disponível.'), { code: 'ALERT_RECIPIENT_DISABLED', definitive: true });
    const linkedUser = !userRecipient && recipient?.userId ? this._list('users').find(user => user.id === recipient.userId) : null;
    if (!userRecipient && recipient?.userId && (!linkedUser || linkedUser.active === false || linkedUser.requirePasswordChange === true || (linkedUser.phone && normalizePhone(linkedUser.phone) !== alert.number))) throw Object.assign(new Error('O usuário vinculado ao destinatário não está ativo, precisa recuperar o acesso ou teve o telefone alterado.'), { code: 'ALERT_RECIPIENT_DISABLED', definitive: true });
    if (userRecipient) {
      if (recipient.requirePasswordChange === true) throw Object.assign(new Error('Usuário precisa recuperar o acesso antes de receber alertas.'), { code: 'ALERT_RECIPIENT_DISABLED', definitive: true });
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
    const blocking = incident.blocking === true || (Boolean(incident.campaignId) && incident.kind !== 'uncertain') || (event === 'disconnect' && incident.affectedCampaigns?.length > 0);
    const notification = this._save('notifications', { id, occurrenceId: incident.id, traceId: incident.traceId || incident.id, event, title, body: safeDescription(body), at: incident.at, reason: safeDescription(incident.reason), code: codeOf(incident.code, 'ALERT_ERROR'), campaignId: incident.campaignId || null, groupId: incident.groupId || null, groupName: incident.groupName ? safeDescription(incident.groupName) : null, affectedCampaigns: copy(incident.affectedCampaigns || []), pending: incident.pending || 0, active: blocking, blocking, persistentAlarm: blocking, bringToFront: blocking, recipientSnapshot: incident.recipientSnapshot || null, integrationMode: this._mode(), simulation: this._mode() === 'simulated', automationSuppressed: this._stopped(), muted: false });
    this.emit('localAlert', copy(notification));
    this.emit('change');
    return notification;
  }

  recordIncident(incident) {
    if (this.closed || !incident?.id) return;
    const campaign = incident.campaignId ? this.store.getCampaign(incident.campaignId) : null;
    if (!campaign) return this.recordSystemIncident(incident);
    incident = { ...incident, traceId: incident.traceId || incident.id, automationSuppressed: incident.automationSuppressed === true || this._stopped() };
    const persisted = campaign.lastError?.id === incident.id ? campaign.lastError : incident;
    const recipientSnapshot = persisted.recipientSnapshot || this._recipients(campaign);
    const webhook = this.store.getSetting('independentAlertChannel', null);
    const independentQueued = persisted.independentQueued ?? Boolean(webhook?.enabled && webhook.url && this.sendWebhook && this.secretGet);
    if (!persisted.recipientSnapshot && campaign.lastError?.id === incident.id) this.store.saveCampaign({ ...campaign, lastError: { ...campaign.lastError, recipientSnapshot, independentQueued, automationSuppressed: incident.automationSuppressed } });
    if (!campaign.lastError?.localNotified) {
      const alreadyRecorded = this._get('notifications', `${incident.id}:critical`);
      this._local(incident, 'critical', incident.kind === 'uncertain' ? 'Envio precisa de revisão' : 'Campanha interrompida por erro', `${incident.campaignName || campaign.name}: ${incident.reason}`);
      if (!alreadyRecorded) this._trace(incident, 'occurrence', incident.code || 'CAMPAIGN_ERROR', 'Falha da campanha registrada e notificação local exibida.', this._stopped() ? 'A automação interrompida bloqueou novos alertas privados.' : recipientSnapshot.length ? 'Destinatários privados definidos para a ocorrência.' : 'Nenhum destinatário ativo com telefone válido está configurado.');
      if (campaign.lastError?.id === incident.id) {
        const latest = this.store.getCampaign(campaign.id);
        this.store.saveCampaign({ ...latest, lastError: { ...latest.lastError, localNotified: true } });
      }
    }
    const text = alertText({ ...incident, timezone: computerTimezone(), campaignName: incident.campaignName || campaign.name });
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
    const titles = { 'qr-required': 'Nova leitura de QR Code necessária', disconnect: 'WhatsApp desconectado', test: 'Teste de alerta — Kenned Code Disparos', critical: 'Falha crítica — Kenned Code Disparos' };
    const notification = this._local({ ...value, recipientSnapshot: recipients }, value.event, titles[value.event] || titles.critical, value.event === 'disconnect' ? `${value.reason} Envios pausados com segurança. Use Reconectar WhatsApp.` : value.reason || 'Consulte o diagnóstico do sistema.');
    if (!existing) this._trace(value, 'occurrence', value.code || 'SYSTEM_ERROR', 'Ocorrência registrada e notificação local exibida.', this._stopped() ? 'A automação interrompida bloqueou novos alertas privados.' : recipients.length ? 'Alertas privados serão processados pela fila.' : 'Nenhum destinatário ativo com telefone válido está configurado.');
    const text = alertText({ ...value, timezone: computerTimezone() });
    const alerts = recipients.map(recipient => this._queue(value, recipient, 'whatsapp', text)).filter(Boolean);
    const webhook = this.store.getSetting('independentAlertChannel', null);
    if (webhook?.enabled && webhook.url && this.sendWebhook && this.secretGet) { const queued = this._queue(value, { id: 'independent-webhook' }, 'webhook', text); if (queued) alerts.push(queued); }
    this.emit('change');
    queueMicrotask(() => { void this.flush().catch(() => this.scheduler?.blockOnPersistenceFailure()); });
    return { occurrenceId: value.id, traceId: value.traceId, notification, alerts };
  }

  _destinationState() {
    const value = this.store.getSetting(`destinationAlertGroups:${this._mode()}`, {});
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  _saveDestinationState(groups) {
    // The summary book is operational state, not erasable history. Keep it
    // mode-scoped and bounded; queued notices retain their own durable records.
    const cutoff = this.now() - 30 * 86400000;
    const entries = Object.entries(groups).filter(([, group]) => group && (group.lastAt || 0) >= cutoff).sort((a, b) => b[1].lastAt - a[1].lastAt).slice(0, 512);
    try { this.store.setSetting(`destinationAlertGroups:${this._mode()}`, Object.fromEntries(entries)); }
    catch (error) { this.scheduler?.blockOnPersistenceFailure(); throw error; }
  }

  _destinationSummaryInterval() {
    const policy = this.store.getSetting('destinationAlertPolicy', {});
    const seconds = Number(policy.summaryIntervalSeconds);
    return Math.max(60, Math.min(86400, Number.isFinite(seconds) ? seconds : 900)) * 1000;
  }

  _dispatchDestination(incident) {
    const notification = this._get('notifications', `${incident.id}:critical`);
    this._local(incident, 'critical', incident.summary ? 'Resumo de falhas por grupo' : 'Grupo indisponível para envio', `${incident.campaignName}: ${incident.groupName} — ${incident.reason}`);
    if (!notification) this._trace(incident, 'occurrence', incident.code, 'Falha do destino registrada separadamente do resultado do aviso privado.', incident.connectionAvailable ? 'Demais grupos elegíveis continuam; destino com falha requer revisão.' : 'Conexão geral indisponível; aviso privado permanece pendente.', 0, { groupId: incident.groupId, operationId: incident.operationId || null, recurrences: incident.recurrences || 0 });
    const text = alertText({ ...incident, timezone: computerTimezone() });
    const alerts = (incident.recipientSnapshot || []).map(recipient => this._queue(incident, recipient, 'whatsapp', text)).filter(Boolean);
    this.emit('change');
    return { occurrenceId: incident.id, traceId: incident.traceId, alerts };
  }

  destinationFailure(event) {
    if (this.closed || !event || typeof event.campaignId !== 'string' || typeof event.groupId !== 'string') return null;
    const campaign = this.store.getCampaign(event.campaignId);
    if (!campaign) return null;
    const group = this.store.getGroup?.(event.groupId) || this.store.listGroups?.().find(value => value.id === event.groupId);
    const code = codeOf(event.code, 'GROUP_SEND_FAILED');
    const key = createHash('sha256').update(JSON.stringify([event.campaignId, event.groupId, code])).digest('hex');
    const operationId = event.operationId || event.jobId || null;
    const operationKey = operationId ? createHash('sha256').update(String(operationId)).digest('hex') : null;
    const groups = this._destinationState();
    let bucket = groups[key];
    if (operationKey && bucket?.operationKeys?.includes(operationKey)) return { occurrenceId: bucket.first.id, duplicate: true, alerts: [] };
    // A stop-all occurrence must not become a backlog on resume. A genuinely
    // new failure after explicit resume is a new occurrence, not forever mute.
    if (bucket?.first?.automationSuppressed && !this._stopped()) bucket = null;
    const item = campaign.items?.find(value => value.id === event.itemId);
    const at = Number.isFinite(event.at) ? event.at : this.now();
    const data = { campaignId: campaign.id, campaignName: safeDescription(campaign.name), groupId: event.groupId, groupName: safeDescription(group?.name || event.groupName || 'Nome indisponível'), itemLabel: safeDescription(event.itemLabel || (item?.text || item?.caption || '').split('\n').find(line => line.trim()) || item?.name || 'Item não identificado'), code, reason: safeDescription(event.reason || 'Motivo não identificado. Consulte o erro técnico no diagnóstico.'), connectionAvailable: event.connectionAvailable === true && this.adapter?.status?.state === 'connected', event: 'destination', integrationMode: this._mode(), simulation: this._mode() === 'simulated', operationId, automationSuppressed: this._stopped() };
    if (!bucket) {
      const id = randomUUID();
      const first = { ...data, id, traceId: event.traceId || operationId || id, at, recipientSnapshot: this._recipients(campaign) };
      bucket = { first, firstQueued: false, lastAt: at, lastSummaryAt: this.now(), recurrences: 0, operationKeys: operationKey ? [operationKey] : [], latest: data };
    } else {
      bucket = { ...bucket, lastAt: at, recurrences: (bucket.recurrences || 0) + (this._stopped() ? 0 : 1), operationKeys: [...(bucket.operationKeys || []), ...(operationKey ? [operationKey] : [])].slice(-256), latest: this._stopped() ? bucket.latest : data };
    }
    groups[key] = bucket;
    this._saveDestinationState(groups);
    if (!bucket.firstQueued) {
      const result = this._dispatchDestination(bucket.first);
      bucket.firstQueued = true;
      this._saveDestinationState(groups);
      queueMicrotask(() => { void this.flush().catch(() => this.scheduler?.blockOnPersistenceFailure()); });
      return result;
    }
    queueMicrotask(() => { void this.flush().catch(() => this.scheduler?.blockOnPersistenceFailure()); });
    return { occurrenceId: bucket.first.id, grouped: true, recurrences: bucket.recurrences, alerts: [] };
  }

  _flushDestinationSummaries() {
    const groups = this._destinationState();
    let changed = false;
    for (const bucket of Object.values(groups)) {
      if (!bucket?.first?.id) continue;
      if (!bucket.firstQueued) { this._dispatchDestination(bucket.first); bucket.firstQueued = true; changed = true; }
      if (this._stopped() || bucket.first.automationSuppressed) continue;
      if (!bucket.pendingSummary && bucket.recurrences > 0 && this.now() - bucket.lastSummaryAt >= this._destinationSummaryInterval()) {
        const id = randomUUID();
        bucket.pendingSummary = { ...bucket.first, ...bucket.latest, id, traceId: id, summary: true, at: bucket.first.at, lastAt: bucket.lastAt, recurrences: bucket.recurrences, recipientSnapshot: this._recipients(this.store.getCampaign(bucket.first.campaignId)) };
        bucket.recurrences = 0;
        bucket.lastSummaryAt = this.now();
        // Save the summary identity and consumed count before queueing so a
        // crash cannot generate a second occurrence for the same interval.
        this._saveDestinationState(groups);
      }
      if (bucket.pendingSummary) { this._dispatchDestination(bucket.pendingSummary); bucket.pendingSummary = null; changed = true; }
    }
    if (changed) this._saveDestinationState(groups);
  }

  _queue(incident, recipient, channel, text) {
    if (this._stopped() || incident.automationSuppressed === true || this._get('notifications', `${incident.id}:${incident.event || 'critical'}`)?.automationSuppressed === true) return null;
    // Deterministic key survives restarts and settings changes. Phone numbers
    // are destinations, never message contents or diagnostic descriptions.
    const id = `${incident.id}:${channel}:${recipient.phone || recipient.id}`;
    const old = this._get('alerts', id);
    if (old) return old;
    const alert = this._save('alerts', { id, occurrenceId: incident.id, traceId: incident.traceId || incident.id, userId: incident.userId || null, campaignId: incident.campaignId || null, recipientId: recipient.id, number: recipient.phone || null, channel, integrationMode: this._mode(), simulation: this._mode() === 'simulated', status: 'pending', createdAt: this.now(), originalAt: incident.at, messageId: randomBytes(16).toString('hex').toUpperCase(), text, attempts: 0, nextAttemptAt: this.now(), resultAt: null, code: codeOf(incident.code, 'CAMPAIGN_ERROR'), error: null });
    this._trace(alert, 'queue', 'ALERT_QUEUED', 'Aviso colocado na fila; ainda não houve confirmação de envio.', this.adapter?.status?.state === 'connected' ? 'Aguardando processamento sequencial.' : 'Pendente até a reconexão do WhatsApp.');
    return alert;
  }

  async testRecipient(phone, userId, { recipientId } = {}) {
    this._requireRunning();
    phone=normalizePhone(phone);
    if (!validPhone(phone)) throw new Error('Informe o telefone com código do país e DDD, entre 10 e 15 dígitos.');
    const incident = { id: randomUUID(), at: this.now(), code: 'ALERT_TEST', event: 'test', userId, reason: 'Teste de alerta solicitado. Nenhuma campanha foi ativada.', recipientSnapshot: [{ id: recipientId || 'test', phone }] };
    const occurrence = this.recordSystemIncident(incident);
    const alert = occurrence.alerts.find(a => a.channel === 'whatsapp');
    this._audit('alert.test', alert.id, userId, 'Teste de destinatário solicitado.');
    await this._flushQueued([alert.id]);
    return this._get('alerts', alert.id);
  }

  async testAlert({ userId, event = 'critical' } = {}) {
    this._requireRunning();
    if (!['critical', 'disconnect', 'test'].includes(event)) throw new Error('Tipo de alerta de teste inválido.');
    const incident = { id: randomUUID(), at: this.now(), userId, event, code: 'ALERT_TEST', reason: 'Teste do fluxo de alerta solicitado. Nenhuma campanha foi ativada.' };
    const occurrence = this.recordSystemIncident(incident);
    this._audit('alert.test', occurrence.occurrenceId, userId, 'Teste do fluxo de ocorrência, notificação local e destinatários configurados.');
    await this._flushQueued(occurrence.alerts.map(alert => alert.id));
    const result = { ...occurrence, alerts: occurrence.alerts.map(alert => this._get('alerts', alert.id)) };
    if (!result.alerts.length) Object.assign(result, { deliveryStatus: 'not-configured', deliveryCode: 'ALERT_RECIPIENTS_NOT_CONFIGURED', deliveryReason: 'Nenhum destinatário ativo com telefone válido está configurado. A notificação local foi exibida; nenhum alerta privado entrou na fila.' });
    return result;
  }

  async retryAlert(id, { userId } = {}) {
    this._requireRunning();
    const alert = this._get('alerts', id);
    if (!alert || alert.status !== 'failed' || alert.retryEligible !== true) throw new Error('O alerta exige falha comprovada ou revisão explícita antes de tentar novamente. Resultados incertos não são repetidos.');
    const retry = this._save('alerts', { ...alert, status: 'pending', messageId: alert.reviewedBy && alert.reviewedConfirmed === false ? randomBytes(16).toString('hex').toUpperCase() : alert.messageId, lifetimeAttempts: (alert.lifetimeAttempts || 0) + (alert.attempts || 0), attempts: 0, nextAttemptAt: this.now(), resultAt: null, error: null, errorCode: null, technicalError: null, retryEligible: false, retriedAt: this.now(), retriedBy: userId || null });
    this._audit('alert.retry', id, userId, 'Nova tentativa manual autorizada após falha conhecida ou revisão.');
    this._trace(retry, 'queue', 'ALERT_MANUAL_RETRY', 'Tentativa manual registrada.', 'Aviso pendente; nenhuma confirmação antecipada.');
    await this._flushQueued([id]);
    return this._get('alerts', id);
  }

  async resolveUncertain(id, { confirmed, userId } = {}) {
    const alert = this._get('alerts', id);
    if (!alert || alert.status !== 'uncertain') throw new Error('O alerta não possui resultado incerto.');
    if (typeof confirmed !== 'boolean') throw new Error('Informe se o envio foi confirmado na revisão.');
    const result = this._save('alerts', { ...alert, status: confirmed ? 'confirmed' : 'failed', retryEligible: !confirmed, resultAt: this.now(), confirmationScope: confirmed ? 'manual-review' : alert.confirmationScope, error: confirmed ? null : 'Revisão manual: envio não confirmado; nenhum reenvio automático.', reviewedAt: this.now(), reviewedBy: userId || null, reviewedConfirmed: confirmed });
    this._audit('alert.review', id, userId, confirmed ? 'Envio confirmado manualmente.' : 'Envio não confirmado manualmente.');
    this.emit('change');
    return result;
  }

  muteOccurrence(id) {
    for (const notification of this._list('notifications')) if (notification.id === id || notification.occurrenceId === id) this._save('notifications', { ...notification, muted: true });
    this.emit('muted', { id });
  }

  resolveIncident(id, { reason = 'Problema corrigido.', at = this.now() } = {}) {
    const notificationIds = [];
    for (const notification of this._list('notifications')) {
      if ((notification.id !== id && notification.occurrenceId !== id) || notification.resolvedAt) continue;
      this._save('notifications', { ...notification, active: false, resolvedAt: at, recoveredAt: at, resolutionReason: safeDescription(reason) });
      notificationIds.push(notification.id);
    }
    if (notificationIds.length) { this.emit('resolved', { id, occurrenceId: id, notificationIds, recoveredAt: at, reason: safeDescription(reason) }); this.emit('change'); }
    return { notificationIds, resolvedAt: at };
  }

  resolveDestination(campaignId, groupId, { at = this.now(), reason = 'A integração confirmou a recuperação da permissão do grupo.' } = {}) {
    // Destination buckets are operational state. Resolve the exact group and
    // remove its recurrence bucket so polling cannot recreate an old incident.
    const groups = this._destinationState(), ids = new Set();
    for (const [key, bucket] of Object.entries(groups)) {
      if (bucket.first?.campaignId !== campaignId || bucket.first?.groupId !== groupId) continue;
      if (bucket.first?.id) ids.add(bucket.first.id);
      if (bucket.pendingSummary?.id) ids.add(bucket.pendingSummary.id);
      delete groups[key];
    }
    for (const notification of this._list('notifications')) if (notification.campaignId === campaignId && notification.groupId === groupId && notification.active && !notification.resolvedAt) ids.add(notification.occurrenceId || notification.id);
    this._saveDestinationState(groups);
    for (const id of ids) this.resolveIncident(id, { at, reason });
    return { resolved: [...ids], recoveredAt: at };
  }

  recordRecoveryStatistic(kind){const key=`recoveryStatistics:${this._mode()}`,old=this.store.getSetting(key,{since:this.now(),successes:0,failures:0});this.store.setSetting(key,{...old,[kind]:(old[kind]||0)+1,[kind==='successes'?'lastRecoveryAt':'lastFailureAt']:this.now()});}

  getRecoveryState() {
    return { statistics:this.store.getSetting(`recoveryStatistics:${this._mode()}`,{since:this.now(),successes:0,failures:0}), state: this.adapter?.status?.state || 'disconnected', attempts: this.reconnectAttempts, nextAttemptAt: this.reconnectNextAttemptAt, reconnecting: Boolean(this.reconnecting), incident: this.disconnectOccurrence ? copy(this.disconnectOccurrence) : null, manual: this.store.getSetting(`manualDisconnect:${this._mode()}`, false) === true };
  }

  flush() {
    if (this.flushing) { this.flushRequested = true; return this.flushing; }
    if (this.closed || this.scheduler?.closed || this.scheduler?.closing || this._stopped() || this.store.persistenceFailed || this.scheduler?.persistenceFailed) return Promise.resolve();
    // An occurrence can be queued after a concurrent pass observed an empty
    // queue, before its promise settles. Keep that wake-up on the same pump;
    // otherwise waitForIdle/testRecipient may finish with an unsent notice.
    this.flushRequested = false;
    this.flushing = Promise.resolve().then(async () => {
      do {
        this.flushRequested = false;
        this._flushDestinationSummaries();
        await this._flush();
      } while (this.flushRequested && !this.closed && !this.scheduler?.closed && !this.scheduler?.closing && !this._stopped() && !this.store.persistenceFailed && !this.scheduler?.persistenceFailed);
    }).finally(() => { this.flushing = null; });
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
    if (this.scheduler?.runExternalSubmission) {
      const attemptMs = this._attemptTimeoutMs();
      // The FIFO slot contains a bounded batch, while each network operation
      // gets its own shorter deadline. One stalled notice cannot occupy the
      // slot indefinitely or turn every following notice into uncertain work.
      const batchMs = attemptMs * 2 + Math.max(3, this.adapter?.minimumSpacingSeconds || 3) * 1000 + 5000;
      try {
        for (let count = 0; count < 50 && !this.closed && !this.scheduler.closed && !this.scheduler.closing && !this._stopped(); count++) {
          const channel = this.adapter?.status?.state === 'connected' ? undefined : 'webhook';
          const due = this.store.listPendingAlerts ? this.store.listPendingAlerts({ at: this.now(), channel, limit: 1 }) : this._list('alerts', { status: 'pending' }).filter(a => (!channel || a.channel === channel) && (a.nextAttemptAt || 0) <= this.now()).slice(0, 1);
          if (!due.length) break;
          await this.scheduler.runExternalSubmission(context => this._flushBatch({ ...context, managedSubmission: true, singleDelivery: true }), { timeoutMs: batchMs });
        }
        return;
      }
      catch (error) {
        // Cancelling an automatic queue is an intentional operator action,
        // not a disk fault. Do not latch a persistence failure on stop-all.
        if (error?.code === 'AUTOMATION_STOPPED') return;
        if (error?.code === 'SUBMISSION_SERVICE_CLOSED' && (this.closed || this.scheduler?.closed || this.scheduler?.closing)) return;
        if (error?.code === 'SUBMISSION_TIMEOUT') {
          for (const alert of this._list('alerts', { status: 'sending' })) {
            const uncertain = this._save('alerts', { ...alert, status: 'uncertain', resultAt: this.now(), retryEligible: false, errorCode: 'ALERT_SEND_TIMEOUT', error: 'Tempo limite excedido. O envio pode ter ocorrido; revise antes de repetir.' });
            this._trace(uncertain, 'failure', 'ALERT_SEND_TIMEOUT', uncertain.error, 'Fila liberada; nenhum reenvio automático.', alert.attempts || 0);
          }
          this.emit('change');
          return;
        }
        throw error;
      }
    }
    return this._flushBatch();
  }

  _attemptTimeoutMs() {
    if (this.scheduler?.getAttemptTimeoutMs) return this.scheduler.getAttemptTimeoutMs();
    return Math.max(5, Math.min(300, Number(this.store.getSetting('submissionTimeoutSeconds', 30)) || 30)) * 1000;
  }

  _boundedAlertAttempt(task, options = {}) {
    if (this.scheduler?.runBoundedAttempt) return this.scheduler.runBoundedAttempt(task, { timeoutMs: this._attemptTimeoutMs(), ...options });
    return task({ signal: options.signal, beforeSubmit: () => {
      if (options.signal?.aborted) throw Object.assign(new Error('Tentativa encerrada antes do envio.'), { code: 'SUBMISSION_ABORTED', submitted: false, definitive: true, safeToRetry: false });
    } });
  }

  _lateAlertProof(alert, result, mode) {
    if (this.closed || mode !== this._mode() || this.store.persistenceFailed || this.scheduler?.persistenceFailed) return;
    const current = this._get('alerts', alert.id);
    if (!current || current.status === 'cancelled' || current.messageId !== alert.messageId || !['accepted', 'confirmed', 'delivered', 'read'].includes(result?.status)) return;
    const delivered = current.status === 'delivered' || ['delivered', 'read'].includes(result.status) || ['whatsapp-delivered', 'whatsapp-read'].includes(result.confirmationScope);
    const proof = this._save('alerts', { ...current, status: delivered ? 'delivered' : 'confirmed', messageId: result.messageId || current.messageId, acceptedAt: current.acceptedAt || result.acceptedAt || this.now(), lastAcceptedAt: current.lastAcceptedAt || this.now(), resultAt: current.resultAt || this.now(), confirmationScope: current.confirmationScope === 'whatsapp-read' ? 'whatsapp-read' : result.confirmationScope || (current.channel === 'webhook' ? 'channel-accepted' : delivered ? result.status === 'read' ? 'whatsapp-read' : 'whatsapp-delivered' : 'whatsapp-server'), ...(delivered ? { deliveredAt: current.deliveredAt || result.deliveredAt || this.now() } : {}), ...(result.readAt ? { readAt: current.readAt || result.readAt } : {}), retryEligible: false, error: null, errorCode: null, technicalError: null, reconciledAt: this.now() });
    this._trace(proof, 'receipt', delivered ? 'ALERT_DELIVERED' : 'ALERT_CONFIRMED', 'Resposta tardia da mesma tentativa conciliada com a confirmação disponível.', 'Registro atualizado; nenhuma segunda submissão.', current.attempts || 0);
    this.emit('change');
  }

  _lateAlertError(alert, error, mode) {
    if (this.closed || mode !== this._mode() || this.store.persistenceFailed || this.scheduler?.persistenceFailed || (error?.definitive !== true && error?.submitted !== false)) return;
    const current = this._get('alerts', alert.id);
    if (!current || current.status !== 'uncertain' || current.messageId !== alert.messageId) return;
    const failed = this._save('alerts', { ...current, status: 'failed', errorCode: codeOf(error.code, 'ALERT_SEND_ERROR'), error: 'A resposta tardia confirmou a falha desta tentativa. Nenhum reenvio automático foi realizado.', technicalError: technicalDescription(error), lastFailureAt: this.now(), resultAt: this.now(), retryEligible: true, reconciledAt: this.now() });
    this._trace(failed, 'failure', failed.errorCode, failed.error, 'Uma nova tentativa exige ação manual.', current.attempts || 0, { technicalError: failed.technicalError });
    this.emit('change');
  }

  async _flushBatch({ signal, beforeSubmit: batchBeforeSubmit = () => {}, managedSubmission = false, singleDelivery = false } = {}) {
    if (this._stopped()) return;
    const stopRevision = this.stopRevision;
    const adapter = this.adapter;
    const adapterRevision = this.adapterRevision;
    const mode = this._mode();
    const channel = this.adapter?.status?.state === 'connected' ? undefined : 'webhook';
    const pending = this.store.listPendingAlerts ? this.store.listPendingAlerts({ at: this.now(), channel, limit: singleDelivery ? 1 : 50 }) : this._list('alerts', { status: 'pending' }).filter(a => (!channel || a.channel === channel) && (a.nextAttemptAt || 0) <= this.now()).sort((a, b) => a.createdAt - b.createdAt).slice(0, singleDelivery ? 1 : 50);
    if (!pending.length) return;
    const release = managedSubmission ? (() => {}) : this.scheduler?.holdSubmissions?.() || (() => {});
    try {
      if (!managedSubmission) await this.scheduler?.waitForIdle?.();
      for (const snapshot of pending) {
        if (signal?.aborted || this.closed || this._stopped() || stopRevision !== this.stopRevision || this.store.persistenceFailed || this.scheduler?.persistenceFailed || adapterRevision !== this.adapterRevision || mode !== this._mode()) break;
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
        if (signal?.aborted || this.closed || this._stopped() || stopRevision !== this.stopRevision || this.store.persistenceFailed || adapterRevision !== this.adapterRevision || mode !== this._mode() || (alert.channel === 'whatsapp' && adapter.status.state !== 'connected')) continue;
        const attempt = (alert.attempts || 0) + 1;
        this._save('alerts', { ...alert, attempts: attempt, lastAttemptAt: this.now() });
        if (this.store.persistenceFailed || this.scheduler?.persistenceFailed) break;
        let submitted = false;
        try {
          let result;
          if (alert.channel === 'whatsapp') {
            this._validateRecipient(alert);
            const resolved = adapter.resolveRecipient ? await this._boundedAlertAttempt(context => { batchBeforeSubmit(); context.beforeSubmit(); return adapter.resolveRecipient(alert.number, { traceId: alert.traceId || alert.occurrenceId || alert.id, signal: context.signal }); }, { signal }) : null;
            const targetId = typeof resolved === 'string' ? resolved : resolved?.jid || null;
            if (resolved && ((resolved.mode && resolved.mode !== mode) || (mode === 'whatsapp' && resolved.simulation === true))) throw Object.assign(new Error('Destinatário pertence a outro modo de execução.'), { code: 'RECIPIENT_MODE_MISMATCH', definitive: true });
            if (signal?.aborted || this.closed || this._stopped() || stopRevision !== this.stopRevision || this.store.persistenceFailed || adapterRevision !== this.adapterRevision || mode !== this._mode() || adapter.status.state !== 'connected') {
              const latest = this._get('alerts', alert.id);
              if (latest?.status === 'pending') this._save('alerts', { ...latest, attempts: Math.max(0, attempt - 1) });
              continue;
            }
            // Recipient lookup can wait on the network. Permission and contact
            // changes made during that wait must take effect before submission.
            this._validateRecipient(alert);
            const sending = this._save('alerts', { ...this._get('alerts', alert.id), status: 'sending', targetId, isSelf: resolved?.isSelf === true, submittedAt: this.now() });
            this._trace(sending, 'recipient', 'ALERT_RECIPIENT_RESOLVED', resolved?.isSelf ? 'Destinatário resolvido como a própria conta conectada.' : 'Destinatário privado resolvido pela integração.', 'Autorização atualizada. Iniciando submissão; envio ainda não confirmado.', attempt, { authorization: 'approved' });
            if (this.scheduler) this.scheduler.lastSubmissionAt = this.now();
            submitted = true;
            result = await this._boundedAlertAttempt(context => adapter.sendPrivate(alert.number, alert.text, { clientMessageId: alert.messageId, traceId: alert.traceId || alert.occurrenceId || alert.id, signal: context.signal, beforeSubmit: () => {
              batchBeforeSubmit(); context.beforeSubmit();
              if (this._stopped() || stopRevision !== this.stopRevision) throw Object.assign(new Error('Envio interrompido antes da submissão pelo comando parar tudo.'), { code: 'AUTOMATION_STOPPED', definitive: true, submitted: false, safeToRetry: false });
              if (this.closed || this.store.persistenceFailed || this.scheduler?.persistenceFailed) throw Object.assign(new Error('Processamento de alertas indisponível antes da submissão.'), { code: 'ALERT_PROCESSING_UNAVAILABLE', definitive: true, submitted: false, safeToRetry: false });
              if (adapterRevision !== this.adapterRevision || mode !== this._mode() || adapter !== this.adapter || adapter.status.state !== 'connected') throw Object.assign(new Error('A conexão mudou antes de enviar o alerta. Nenhuma mensagem foi enviada.'), { code: 'WA_RECIPIENT_CONNECTION_CHANGED', definitive: true, submitted: false, safeToRetry: true });
              const latest = this._get('alerts', alert.id);
              if (latest?.status !== 'sending' || latest.messageId !== alert.messageId || latest.number !== alert.number) throw Object.assign(new Error('O alerta foi cancelado ou alterado antes da submissão.'), { code: 'ALERT_SUBMISSION_CHANGED', definitive: true, submitted: false, safeToRetry: false });
              this._validateRecipient(latest);
            } }), { signal, onLateResult: proof => this._lateAlertProof(alert, proof, mode), onLateError: error => this._lateAlertError(alert, error, mode) });
          } else {
            const config = this.store.getSetting('independentAlertChannel', null);
            if (!config?.enabled || !/^https:\/\//i.test(config.url || '')) throw Object.assign(new Error('Canal independente indisponível.'), { safeToRetry: true, definitive: true });
            const secret = await this._boundedAlertAttempt(() => this.secretGet(config.secretId || 'independentAlertChannel'), { signal });
            if (signal?.aborted || this.closed || this._stopped() || stopRevision !== this.stopRevision || this._get('alerts', alert.id)?.status !== 'pending') continue;
            if (!secret) throw Object.assign(new Error('Credencial do canal ausente.'), { definitive: true });
            this._save('alerts', { ...this._get('alerts', alert.id), status: 'sending', submittedAt: this.now() });
            submitted = true;
            result = await this._boundedAlertAttempt(context => { batchBeforeSubmit(); context.beforeSubmit(); return this.sendWebhook({ url: config.url, secret, message: alert.text, occurrenceId: alert.occurrenceId, originalAt: alert.originalAt, idempotencyKey: alert.messageId, signal: context.signal }); }, { signal, onLateResult: proof => this._lateAlertProof(alert, proof, mode), onLateError: error => this._lateAlertError(alert, error, mode) });
          }
          const current = this._get('alerts', alert.id);
          const confirmed = ['accepted', 'confirmed', 'delivered', 'read'].includes(result?.status) || ['confirmed', 'delivered'].includes(current.status);
          const delivered = current.status === 'delivered' || ['delivered', 'read'].includes(result?.status) || (confirmed && ['whatsapp-delivered', 'whatsapp-read'].includes(result?.confirmationScope));
          const saved = this._save('alerts', { ...current, status: delivered ? 'delivered' : confirmed ? 'confirmed' : 'uncertain', resultAt: current.resultAt || this.now(), messageId: result?.messageId || alert.messageId, ...(confirmed ? { lastAcceptedAt: current.lastAcceptedAt || this.now(), acceptedAt: current.acceptedAt || this.now() } : {}), confirmationScope: confirmed ? alert.channel === 'webhook' ? 'channel-accepted' : delivered ? current.confirmationScope || result.confirmationScope || (result?.status === 'read' ? 'whatsapp-read' : 'whatsapp-delivered') : result?.confirmationScope || current.confirmationScope || 'whatsapp-server' : null, ...(delivered ? { deliveredAt: current.deliveredAt || result?.deliveredAt || this.now() } : {}), errorCode: confirmed ? null : 'ALERT_SEND_UNCERTAIN', retryEligible: false, error: confirmed ? null : 'Resultado de alerta incerto; revisão necessária.', technicalError: null });
          this._trace(saved, 'result', confirmed ? delivered ? 'ALERT_DELIVERED' : 'ALERT_CONFIRMED' : 'ALERT_SEND_UNCERTAIN', confirmed ? delivered ? 'A integração confirmou entrega ao dispositivo.' : 'A integração confirmou recebimento pelo servidor.' : 'A integração não comprovou o envio do aviso.', confirmed ? 'Resultado confirmado; nenhum reenvio.' : 'Alerta separado para revisão; nenhum reenvio automático.', attempt);
        } catch (error) {
          if (error?.code === 'SUBMISSION_TIMEOUT' && !submitted) error = Object.assign(new Error('Tempo limite excedido antes de submeter o alerta; nenhuma mensagem foi enviada.'), { code: 'ALERT_RECIPIENT_TIMEOUT', definitive: true, safeToRetry: true, submitted: false });
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
          if (acknowledged?.status === 'cancelled') continue;
          if (error?.code === 'SUBMISSION_SERVICE_CLOSED' && error.submitted === false && (this.closed || this.scheduler?.closed || this.scheduler?.closing)) {
            this._save('alerts', { ...acknowledged, status: 'pending', attempts: Math.max(0, attempt - 1), submittedAt: null, resultAt: null, errorCode: null, error: null, retryEligible: false });
            break;
          }
          if (error?.code === 'AUTOMATION_STOPPED' && error.submitted === false) {
            const cancelled = this._save('alerts', { ...acknowledged, status: 'cancelled', resultAt: this.now(), cancelledAt: this.now(), errorCode: 'AUTOMATION_STOPPED', error: 'Alerta interrompido antes da submissão pelo comando parar tudo.', retryEligible: false });
            this._trace(cancelled, 'cancelled', 'AUTOMATION_STOPPED', cancelled.error, 'Nenhuma mensagem foi enviada e nenhuma nova tentativa automática será realizada.', attempt);
            this.emit('change'); continue;
          }
          const policy = (alert.campaignId ? this.store.getCampaign(alert.campaignId)?.retryPolicy : null) || this.store.getSetting('alertRetryPolicy', { maxAttempts: 3, delaySeconds: 15 });
          const max = Math.max(1, Math.min(5, Number.isInteger(policy.maxAttempts) ? policy.maxAttempts : 3));
          // The integration uses definitive=true to mean a *known failed*
          // submission, including transient lookup failures. safeToRetry=true
          // remains its explicit proof that a bounded retry is permitted.
          const autoRetry = error?.safeToRetry === true || (!submitted && error?.definitive !== true && error?.safeToRetry !== false);
          const status = autoRetry && attempt < max ? 'pending' : definitive ? 'failed' : 'uncertain';
          const errorCode = codeOf(error?.code, 'ALERT_SEND_ERROR');
          const explanations = { SUBMISSION_TIMEOUT: 'O tempo limite da tentativa foi excedido. O envio pode ter ocorrido; a fila foi liberada e não haverá reenvio automático. Revise a operação.', ALERT_RECIPIENT_TIMEOUT: 'A identificação do destinatário excedeu o tempo limite antes da submissão. Nenhuma mensagem foi enviada; uma tentativa limitada pode ocorrer após o intervalo.', RECIPIENT_NOT_REGISTERED: 'O número não foi encontrado no WhatsApp. Confira país, DDD e número.', WA_RECIPIENT_NOT_FOUND: 'O número não foi encontrado no WhatsApp. Confira país, DDD e número.', RECIPIENT_NUMBER_INVALID: 'O telefone precisa conter código do país, DDD e número.', WA_RECIPIENT_INVALID: 'O telefone precisa conter código do país, DDD e número.', RECIPIENT_SELF_UNAVAILABLE: 'A integração ainda não identificou o número da própria conta. Reconecte e tente novamente.', WA_RECIPIENT_TIMEOUT: 'O WhatsApp não respondeu à consulta do destinatário. Confira a internet e tente novamente após o intervalo.', WA_RECIPIENT_OFFLINE: 'A conexão caiu antes de resolver o destinatário. O envio não ocorreu.', WA_RECIPIENT_UNSUPPORTED: 'A integração conectada não oferece a consulta de destinatários exigida. Atualize o aplicativo e reconecte o WhatsApp.', WA_RECIPIENT_MISMATCH: 'O WhatsApp retornou uma conta diferente do número solicitado. Confira o número e a sessão; o destino não foi substituído.', WA_RECIPIENT_AMBIGUOUS: 'O WhatsApp retornou mais de uma conta possível para o telefone. O destino não foi escolhido por suposição. Confira o número e reconecte.', WA_RECIPIENT_CONNECTION_CHANGED: 'A conexão mudou durante a identificação do destinatário. Nenhuma mensagem foi enviada; uma nova tentativa limitada pode ocorrer após reconectar.', WA_RECIPIENT_LOOKUP_TEMPORARY: 'Falha temporária na consulta do destinatário. Confira a internet e aguarde a tentativa limitada.', WA_RECIPIENT_LOOKUP_REJECTED: 'O WhatsApp recusou a consulta do destinatário. Confira a conexão e eventuais restrições.', ALERT_RECIPIENT_DISABLED: 'O destinatário foi removido, desativado, teve o telefone alterado ou está vinculado a um usuário sem acesso ativo. Confira o cadastro.', RECIPIENT_MODE_MISMATCH: 'O destinatário pertence a outro modo. Confira a conexão selecionada.', ALERT_PROCESSING_UNAVAILABLE: 'O processamento de alertas foi interrompido. Confira o diagnóstico e o armazenamento antes de tentar novamente.', ALERT_SUBMISSION_CHANGED: 'O alerta foi alterado ou cancelado antes da submissão. Nenhum envio foi realizado.' };
          const explanation = explanations[errorCode] || (status === 'pending' ? 'Falha anterior à submissão; tentativa limitada pendente.' : status === 'failed' ? 'Alerta falhou. Confira a conexão, o país/DDD do número e o cadastro do destinatário.' : 'Resultado de alerta incerto; revisão necessária antes de repetir.');
          const technicalError = technicalDescription(error);
          const delaySeconds = Math.min(3600, Math.max(3, Number(policy.delaySeconds) || 15) * Math.pow(2, Math.max(0, attempt - 1)));
          const failed = this._save('alerts', { ...this._get('alerts', alert.id), status, resultAt: status === 'pending' ? null : this.now(), lastFailureAt: this.now(), nextAttemptAt: this.now() + Math.max(delaySeconds, adapter.minimumSpacingSeconds || 3) * 1000, errorCode, retryEligible: status === 'failed' && definitive, error: explanation, technicalError });
          this._trace(failed, 'failure', errorCode, explanation, status === 'pending' ? 'Nova tentativa limitada agendada.' : status === 'failed' && definitive ? 'Envio não ocorreu. Uma nova tentativa manual pode ser solicitada.' : 'Revisão do alerta necessária.', attempt, { technicalError });
        }
        this.emit('change');
      }
    } finally { release(); }
  }

  _connectionReady(status = this.adapter?.status) {
    if (status?.state !== 'connected' || status.ready === false) return false;
    if (typeof this.adapter?.getConnectionReadiness === 'function') return this.adapter.getConnectionReadiness().ready === true;
    return true;
  }

  _affectedCampaigns() {
    return this.store.listCampaigns().filter(c => c.state === 'active' || (c.state === 'paused' && (c.executionRecovery?.kind === 'connection' || (this.activeBeforeDisconnect.has(c.id) && /^Conexão indisponível/.test(c.pauseReason || ''))))).map(c => {
      const jobs = this.store.listJobs?.({ campaignId: c.id, limit: 1000000 }) || [];
      return { id: c.id, name: safeDescription(c.name), pending: jobs.filter(job => ['queued', 'sending', 'uncertain', 'pending'].includes(job.status)).length, configRevision: c.configRevision ?? configurationFingerprint(c) };
    });
  }

  _recordQrRequired() {
    if (!this.disconnectOccurrence) return;
    const incident = { id: `${this.disconnectOccurrence.id}:qr-required`, traceId: this.disconnectOccurrence.traceId || this.disconnectOccurrence.id, event: 'qr-required', at: this.disconnectOccurrence.at, code: 'WA_QR_REQUIRED', reason: 'A sessão precisa ser vinculada novamente. Leia o QR Code exibido no aplicativo.', affectedCampaigns: this.disconnectOccurrence.affectedCampaigns, recipientSnapshot: this.disconnectOccurrence.recipientSnapshot, blocking: false };
    if (!this._get('notifications', `${incident.id}:qr-required`)) this.recordSystemIncident(incident);
  }

  async _onStatus(status) {
    if (this.closed || !status) return;
    const previous = this.previousState;
    if(previous!==status.state){this.connectionPhaseAt=this.now();this.connectionStalled=false;}
    this.previousState = status.state;
    if (status.state === 'connected') {
      if (!this._connectionReady(status)) { this.emit('change'); return; }
      this._cancelReconnect();
      this.reconnectAttempts = 0;
      this.store.setSetting?.(`manualDisconnect:${this._mode()}`, false);
      const occurrence = this.disconnectOccurrence;
      const recoveredAt = this.now();
      if (occurrence) {
        this.recordRecoveryStatistic('successes');
        // Add recovery time only to work that has never entered the transport.
        // An accepted or uncertain notice keeps the exact original payload.
        const recovered = { ...occurrence, recoveredAt, timezone: computerTimezone() };
        for (const alert of this._list('alerts', { status: 'pending' })) if (alert.occurrenceId === occurrence.id && (!alert.integrationMode || alert.integrationMode === this._mode())) this._save('alerts', { ...alert, recoveredAt, text: alertText(recovered) });
        for (const alert of this._list('alerts', { status: 'pending' })) if (alert.occurrenceId === `${occurrence.id}:qr-required` && (!alert.integrationMode || alert.integrationMode === this._mode())) this._save('alerts', { ...alert, recoveredAt, text: alertText({ ...recovered, event: 'qr-required', reason: 'Durante a falha, a sessão precisou ser vinculada novamente.' }) });
        this.resolveIncident(occurrence.id, { reason: 'Conexão recuperada — aguardando próximo horário de rodada.', at: recoveredAt });
        this.resolveIncident(`${occurrence.id}:qr-required`, { reason: 'Sessão pronta para envio.', at: recoveredAt });
        this._trace(occurrence, 'recovery', 'WA_CONNECTION_RECOVERED', 'Sessão autenticada e pronta para envio.', 'Alertas pendentes podem sair agora; campanhas aguardam o próximo horário programado.');
      }
      this.disconnectOccurrence = null;
      this.store.setSetting?.(`alertDisconnectOccurrence:${this._mode()}`, null);
      if (!this._stopped() && this.store.getSetting('reconnect', {}).autoResume !== false && typeof this.scheduler?.recoverAfterConnection === 'function') {
        try { await this.scheduler.recoverAfterConnection({ reason: 'reconnected' }); }
        catch (error) { this._diagnostic(error.code || 'CAMPAIGN_RECOVERY_FAILED', safeDescription(error.message), 'Campanhas permanecem pausadas; revise o diagnóstico.', null, 0, { stage: 'reconexao.recuperacao' }); }
      }
      this._rememberActive();
      this.emit('change');
      await this.flush();
      return;
    }
    if (status.state === 'connecting') { this._cancelReconnect(); this.emit('change'); return; }
    if (status.state === 'qr') { this._cancelReconnect(); this._recordQrRequired(); this.emit('change'); return; }
    if (status.reasonCode === 'manual' || status.manual) {
      this._cancelReconnect(); this.store.setSetting?.(`manualDisconnect:${this._mode()}`, true); this.activeBeforeDisconnect.clear(); this.emit('change'); return;
    }
    if (!this.disconnectOccurrence && (previous === 'connected' || ['expired', 'session_expired', 'internet', 'unexpected', 'restricted'].includes(status.reasonCode))) {
      const reason = { internet: 'Sem conexão com a internet.', expired: 'A sessão do WhatsApp expirou; conecte novamente.', session_expired: 'A sessão do WhatsApp expirou; conecte novamente.', restricted: 'O serviço restringiu os envios. Confira os limites e aguarde a liberação da integração.', unexpected: 'O WhatsApp desconectou inesperadamente.' }[status.reasonCode] || 'A conexão com o WhatsApp foi interrompida.';
      const originalAt = typeof status.at === 'number' ? status.at : Date.parse(status.at);
      const affectedCampaigns = this._affectedCampaigns();
      this.disconnectOccurrence = { id: randomUUID(), at: Number.isFinite(originalAt) ? originalAt : this.now(), code: codeOf(status.errorCode || status.code, 'WHATSAPP_DISCONNECTED'), reason, event: 'disconnect', integrationMode: this._mode(), affectedCampaigns, recipientSnapshot: this._recipients(null), pending: affectedCampaigns.reduce((count, campaign) => count + campaign.pending, 0) };
      this.store.setSetting?.(`alertDisconnectOccurrence:${this._mode()}`, this.disconnectOccurrence);
      this.recordSystemIncident(this.disconnectOccurrence);
    }
    if (['expired', 'session_expired'].includes(status.reasonCode)) this._recordQrRequired();
    this._scheduleReconnect(status);
    this.emit('change');
  }

  _cancelReconnect() { if (this.reconnectTimer) this.clearTimer(this.reconnectTimer); this.reconnectTimer = null; this.reconnectNextAttemptAt = null; }

  _canReconnect(status, config = this.store.getSetting('reconnect', {})) {
    const maximum = Number.isInteger(config.maxAttempts) ? Math.max(0, Math.min(10, config.maxAttempts)) : 5;
    return !this.closed && !this._stopped() && !this.store.persistenceFailed && !this.scheduler?.persistenceFailed && config.enabled !== false && !this.store.getSetting(`manualDisconnect:${this._mode()}`, false) && (!['connecting','qr','connected'].includes(status.state)||this.connectionStalled&&status.state!=='qr') && status.retryable !== false && !['manual', 'expired', 'session_expired', 'restricted'].includes(status.reasonCode) && this.reconnectAttempts < maximum;
  }

  _scheduleReconnect(status) {
    const config = this.store.getSetting('reconnect', {});
    if (!this._canReconnect(status, config) || this.reconnectTimer || this.reconnecting) return;
    const base = Math.max(3, Math.min(3600, Number(config.delaySeconds) || 5));
    const maximumDelay = Math.max(base, Math.min(3600, Number(config.maxDelaySeconds) || 120));
    const delay = Math.min(maximumDelay, base * Math.pow(2, this.reconnectAttempts)) * 1000;
    const revision = this.adapterRevision, mode = this._mode();
    this.reconnectNextAttemptAt = this.now() + delay;
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null; this.reconnectNextAttemptAt = null;
      if (revision !== this.adapterRevision || mode !== this._mode() || !this._canReconnect(this.adapter.status)) return;
      this.reconnectAttempts++;
      this._diagnostic('WA_RECONNECT_ATTEMPT', `Tentativa de reconexão ${this.reconnectAttempts}.`, 'Reutilizando a sessão existente; aguardando confirmação de prontidão.', null, this.reconnectAttempts, { stage: 'reconexao.tentativa' });
      this.emit('change');
      void this.reconnect({ automatic: true }).catch(error => this._diagnostic(codeOf(error.code, 'WA_RECONNECT_FAILED'), safeDescription(error.message || 'Falha de reconexão.'), 'Nova tentativa limitada com intervalo progressivo, quando permitida.', null, this.reconnectAttempts, { stage: 'reconexao.falha' })).finally(() => {
        if (revision !== this.adapterRevision || mode !== this._mode()) return;
        if (!this._connectionReady()) this._scheduleReconnect(this.adapter.status);
        this.emit('change');
      });
    }, delay);
    this.reconnectTimer?.unref?.();
  }

  checkRecoveryHealth() {
    this.adapter?.expirePendingDecryption?.();
    if(!this.closed&&!this._stopped())this.adapter?.checkOperationalHealth?.();
    if(this.closed||this._stopped()||this.store.getSetting(`manualDisconnect:${this._mode()}`,false))return;
    const status=this.adapter?.status||{},config=this.store.getSetting('reconnect',{});
    if(config.enabled===false||status.qr||['manual','session_expired','restricted'].includes(status.reasonCode))return;
    const deadline=Math.max(15,Math.min(180,Number(config.connectTimeoutSeconds)||45))*1000;
    if(['connecting','connected'].includes(status.state)&&!this._connectionReady(status)&&this.now()-this.connectionPhaseAt>=deadline){
      this.connectionStalled=true;
      if(this._canReconnect(status,config)&&!this.reconnectTimer){
        if(!this.reconnecting)this.recordRecoveryStatistic('failures');
      this._diagnostic('WA_RECOVERY_STALLED','A conexão permaneceu sem prontidão além do prazo.','Nova tentativa limitada usará o mesmo mecanismo do botão Reconectar.',null,this.reconnectAttempts,{stage:'reconexao.watchdog'});
        this.recoveryAbort?.(Object.assign(new Error('A conexão excedeu o prazo de recuperação.'),{code:'WA_RECOVERY_DEADLINE'}));
        this.reconnecting=null;this.adapter.abortConnectionAttempt?.();this._scheduleReconnect(this.adapter.status);
      }
    }
  }

  reconnect({ automatic = false } = {}) {
    if (this.reconnecting) return this.reconnecting;
    if (!automatic) { this.reconnectAttempts = 0; this.store.setSetting?.(`manualDisconnect:${this._mode()}`, false); }
    this._cancelReconnect();
    const source=this.adapter,revision=this.adapterRevision;
    this.connectionPhaseAt=this.now();let timer,operation;
    const deadline=new Promise((_resolve,reject)=>{
      this.recoveryAbort=reject;
      timer=setTimeout(()=>{if(source===this.adapter&&revision===this.adapterRevision){source.abortConnectionAttempt?.();reject(Object.assign(new Error('O preparo da conexão excedeu o prazo. Confira o diagnóstico.'),{code:'WA_RECOVERY_DEADLINE'}));}},Math.max(15,Math.min(180,Number(this.store.getSetting('reconnect',{}).connectTimeoutSeconds)||45))*1000);timer.unref?.();
    });
    operation=Promise.race([Promise.resolve().then(()=>source.connect({reconnect:true})),deadline]).catch(error=>{if(source===this.adapter&&revision===this.adapterRevision)this.recordRecoveryStatistic('failures');throw error;}).finally(()=>{clearTimeout(timer);if(this.reconnecting===operation){this.reconnecting=null;this.recoveryAbort=null;}});
    this.reconnecting=operation;return operation;
  }

  networkStateChanged({ online } = {}) {
    if (typeof online !== 'boolean') throw new Error('Estado da rede inválido.');
    if (this.adapter.setNetworkState) return this.adapter.setNetworkState({ online });
    if (this.adapter.setNetworkOnline) return this.adapter.setNetworkOnline(online);
    return Promise.resolve();
  }

  async shutdown() {
    this.closed = true;
    this.recoveryAbort?.(Object.assign(new Error('Recuperação encerrada com o aplicativo.'),{code:'WA_RECOVERY_CLOSED'}));
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
