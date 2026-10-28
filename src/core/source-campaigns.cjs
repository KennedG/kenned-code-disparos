'use strict';

const { EventEmitter } = require('node:events');
const { createHash, randomUUID } = require('node:crypto');
const { normalizePhone } = require('./phone.cjs');
const { schedule } = require('./validation.cjs');

const fault = (message, code) => Object.assign(new Error(message), { code });
const canonicalId = value => String(value || '').trim().replace(/:\d+(?=@)/, '');
const allowedId = value => typeof value === 'string' && value.length <= 256 ? normalizePhone(value) || (/^[1-9]\d*(?::\d+)?@(s\.whatsapp\.net|lid)$/.test(value) ? canonicalId(value) : null) : null;
const hash = value => createHash('sha256').update(value).digest('hex');
function localDay(at, timezone = 'America/Sao_Paulo') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at));
  const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function number(value, fallback, min, max, label) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw fault(`${label}: use um valor entre ${min} e ${max}.`, 'SOURCE_CONFIG_INVALID');
  return n;
}
function normalizeConfig(input = {}, old = {}, now = Date.now(), actorId = null) {
  const enabled = input.enabled ?? old.enabled ?? false;
  const groupId = input.groupId ?? old.groupId ?? '';
  const participants = input.allowedParticipantIds ?? old.allowedParticipantIds ?? [];
  if (!Array.isArray(participants) || participants.length > 1000 || participants.some(id => !allowedId(id))) throw fault('Participantes: informe números com país/DDD ou identificadores verificados do WhatsApp.', 'SOURCE_PARTICIPANTS_INVALID');
  const timezone = input.timezone ?? old.timezone ?? 'America/Sao_Paulo';
  try { new Intl.DateTimeFormat('pt-BR', { timeZone: timezone }).format(); } catch { throw fault('Fuso horário inválido.', 'SOURCE_CONFIG_INVALID'); }
  if (enabled && !groupId) throw fault('Selecione o grupo real de origem.', 'SOURCE_GROUP_REQUIRED');
  const raw = { ...old.configTemplate, ...input.configTemplate };
  if (raw.groupIds !== undefined && (!Array.isArray(raw.groupIds) || raw.groupIds.length > 1000 || raw.groupIds.some(id => typeof id !== 'string' || !id))) throw fault('Destinos do modelo inválidos.', 'SOURCE_CONFIG_INVALID');
  const groupIds = [...new Set(raw.groupIds || [])];
  if (groupIds.includes(groupId)) throw fault('O grupo de origem não pode ser destino desta automação.', 'SOURCE_CAPTURE_CYCLE');
  const maxRounds = number(raw.maxRounds, 0, 0, 10000, 'Quantidade de rodadas');
  if (!Number.isInteger(maxRounds)) throw fault('A quantidade de rodadas deve ser inteira.', 'SOURCE_CONFIG_INVALID');
  const endAt = raw.endAt ? new Date(raw.endAt).getTime() : null;
  if (endAt !== null && !Number.isFinite(endAt)) throw fault('Horário de encerramento inválido.', 'SOURCE_CONFIG_INVALID');
  const configTemplate = { groupIds, intervalMinutes: number(raw.intervalMinutes, 10, 1, 10080, 'Intervalo entre rodadas'),
    messageSpacingSeconds: number(raw.messageSpacingSeconds, 3, 3, 3600, 'Intervalo entre mensagens'),
    spacingSeconds: number(raw.spacingSeconds, 5, 3, 3600, 'Intervalo entre grupos'),
    sendTimeoutSeconds: number(raw.sendTimeoutSeconds, 30, 5, 300, 'Tempo limite de envio'),
    maxRounds, endAt, schedule: schedule(raw.schedule || { startTime: '08:00', endTime: '18:00' }) };
  return { enabled: Boolean(enabled), groupId, timezone, allowedParticipantIds: [...new Set(participants.map(allowedId))],
    allowOwnMessages: Boolean(input.allowOwnMessages ?? old.allowOwnMessages), configTemplate,
    mediaTimeoutSeconds: number(input.mediaTimeoutSeconds ?? old.mediaTimeoutSeconds, 30, 1, 1800, 'Tempo limite de download'),
    ownerId: actorId || old.ownerId || old.actorId || null, actorId: actorId || old.ownerId || old.actorId || null,
    enabledAt: enabled && (!old.enabled || old.groupId !== groupId) ? now : old.enabledAt || null,
    updatedAt: now, importFrom: old.importFrom || null, importUntil: old.importUntil || null };
}

// JSON contains only the bounded media key/protobuf needed to retry a download.
// Never retain adapter instances, closures, credentials, or an entire chat.
function persistRaw(raw) {
  if (!raw) return null;
  const json = JSON.stringify(raw, (_, value) => value instanceof Uint8Array && !Buffer.isBuffer(value) ? { type: 'Buffer', data: Array.from(value) } : typeof value === 'bigint' ? value.toString() : value);
  if (Buffer.byteLength(json) > 1024 * 1024) throw fault('Os metadados da mídia excedem o limite seguro. Reenvie a publicação ou importe o arquivo manualmente.', 'SOURCE_MEDIA_METADATA_TOO_LARGE');
  return JSON.parse(json);
}
function restoreRaw(raw) { return JSON.parse(JSON.stringify(raw), (_, value) => value?.type === 'Buffer' && Array.isArray(value.data) ? Buffer.from(value.data) : value); }
function sanitizeSourcePublication(record) { if (!record) return record; const { protectedContext, raw, mediaDownloadContext, downloadContext, ...publicRecord } = record; return publicRecord; }

class SourceCampaignService extends EventEmitter {
  constructor({ store, mediaManager, adapter, safeStorage, now = () => Date.now(), isAutomationStopped = () => false, assertCanCapture = () => true, concurrency = 1 } = {}) {
    super();
    if (!store?.insertSourcePublication || !mediaManager?.importBuffer) throw new Error('O armazenamento de origem e a biblioteca de mídias são obrigatórios.');
    this.store = store; this.media = mediaManager; this.safeStorage = safeStorage; this.now = now; this.isAutomationStopped = isAutomationStopped; this.assertCanCapture = assertCanCapture;
    this.concurrency = Math.min(2, Math.max(1, Number(concurrency) || 1));
    this.adapter = adapter; this.started = false; this.closed = false; this.suspended = false; this.inFlight = new Set(); this.tasks = new Set(); this.controllers = new Set();
    this.queue = new Map(); this.pumpScheduled = false;
    this.publicationListener = context => this._receive(() => this.handlePublication(context));
    this.updateListener = context => this._receive(() => this.handleUpdate(context));
    this.deleteListener = context => this._receive(() => this.handleDelete(context));
    this.statusListener = status => { if (status?.state === 'connected') this._schedulePump(); this.emit('change'); };
  }
  _mode() { return this.store.getStorageMode?.() || this.store.getSetting('integrationMode', 'whatsapp'); }
  _trace(record, stage, code, message, action = '') {
    this.store.addDiagnostic?.({ id: randomUUID(), traceId: record?.traceId || record?.id || randomUUID(), at: this.now(),
      operationType: 'source_capture', stage, code, message, description: message, action, campaignId: record?.campaignId || null,
      groupId: record?.groupId || null, messageId: record?.messageId || null, userId: record?.ownerId || null, attempts: record?.attempts || 0 });
  }
  _receive(work) { try { const result = work(); if (result?.catch) result.catch(error => this._error(error)); } catch (error) { this._error(error); } }
  _error(error) { try { this._trace(null, 'failure', error.code || 'SOURCE_CAPTURE_ERROR', String(error.message || 'Falha de captura.').slice(0, 500), 'Abra a campanha de origem e revise o item.'); } catch { this.captureBlockedReason = 'SOURCE_STORAGE_UNAVAILABLE'; } this.emit('change'); }
  getConfig() { return normalizeConfig({}, this.store.getSourceConfig(), this.now()); }
  saveConfig(input, actorId) {
    const previous = this.store.getSourceConfig(), config = normalizeConfig(input, previous, this.now(), actorId);
    if (config.groupId) this._assertGroup(config.groupId, false);
    for (const id of config.configTemplate.groupIds) this._assertGroup(id, true);
    this.store.transaction(() => { this.store.setSourceConfig(config); this.store.addAudit?.({ id: randomUUID(), at: this.now(), userId: actorId, action: 'source.config', groupId: config.groupId, enabled: config.enabled }); });
    if (!config.enabled || previous.groupId && previous.groupId !== config.groupId) for (const controller of this.controllers) controller.abort();
    this._configureAdapter(); this._schedulePump(); this.emit('change'); return config;
  }
  _assertGroup(id, destination) {
    const group = this.store.getGroup(id), simulated = this._mode() === 'simulated';
    if (!group || group.available === false || Boolean(group.simulation) !== simulated || !simulated && !/^[^\s@]+@g\.us$/.test(id) || simulated && !/@simulation$/.test(id)) throw fault('O grupo não está disponível no modo atual. Sincronize os grupos reais da conta.', 'SOURCE_GROUP_UNAVAILABLE');
    if (destination && !group.authorized) throw fault('O destino não possui autorização para publicar.', 'SOURCE_DESTINATION_UNAUTHORIZED');
    return group;
  }
  _configureAdapter() { const c = this.getConfig(); const options = { enabled: c.enabled, groupIds: c.groupId ? [c.groupId] : [], activatedAt: c.enabledAt, importFrom: c.importFrom, importUntil: c.importUntil };
    if (this.adapter?.setSourceCapture) this.adapter.setSourceCapture(options); else this.adapter?.configureSourceCapture?.(options);
  }
  _attach() { this.adapter?.on('publication', this.publicationListener); this.adapter?.on('publicationUpdate', this.updateListener); this.adapter?.on('publicationDelete', this.deleteListener); this.adapter?.on('status', this.statusListener); }
  _detach() { this.adapter?.off('publication', this.publicationListener); this.adapter?.off('publicationUpdate', this.updateListener); this.adapter?.off('publicationDelete', this.deleteListener); this.adapter?.off('status', this.statusListener); }
  start() {
    if (this.started || this.closed) return; this.started = true; this._attach(); this._configureAdapter();
    for (;;) { const page = this.store.listSourcePublications({ status: 'downloading', limit: 200 });
      for (const record of page.items) this.store.updateSourcePublication(record.id, { status: 'pending', code: 'SOURCE_DOWNLOAD_INTERRUPTED', error: 'Download interrompido; será verificado sem duplicar o item.' });
      if (page.items.length < 200) break;
    }
    this._schedulePump();
  }
  setAdapter(adapter) { this._detach(); for (const controller of this.controllers) controller.abort(); this.adapter = adapter; if (this.started) this._attach(); this._configureAdapter(); this._schedulePump(); }
  _isCaptureAllowed(config = this.getConfig()) {
    if (this.closed || this.suspended || this.store.persistenceFailed || !config.enabled || this.isAutomationStopped()) return false;
    try { const allowed = this.assertCanCapture(config.ownerId) !== false; this.captureBlockedReason = allowed ? null : 'SOURCE_CAPTURE_BLOCKED'; return allowed; } catch (error) { this.captureBlockedReason = error.code || 'SOURCE_CAPTURE_BLOCKED'; return false; }
  }
  _identity(context, config) {
    const ids = new Set([context.senderId, ...(context.senderIds || [])].filter(Boolean).map(canonicalId));
    const phone = context.identityVerified === true ? normalizePhone(context.senderNumber || context.senderPhone) : null;
    if (context.fromMe === true) return config.allowOwnMessages && context.trustedSelf === true ? { phone, id: canonicalId(context.senderId) } : null;
    if (context.identityVerified !== true && context.senderVerified !== true) return null;
    if (!config.allowedParticipantIds.some(value => ids.has(value) || phone && normalizePhone(value) === phone)) return null;
    return { phone, id: canonicalId(context.senderId) };
  }
  _context(context, { importing = false, forUpdate = false } = {}) {
    const config = this.getConfig(), groupId = context?.chatId || context?.groupId, messageId = context?.messageId || context?.id;
    if (!this._isCaptureAllowed(config) || groupId !== config.groupId || typeof messageId !== 'string' || !messageId || messageId.length > 512) return null;
    const simulated = this._mode() === 'simulated';
    if (context.isGroup === false || context.automaticMessage || context.automated || context.machineGenerated || this.store.isOutboundMessageId?.(messageId)) return null;
    if (simulated ? context.simulation !== true || context.mode !== 'simulated' : context.simulation === true || context.mode && context.mode !== 'whatsapp') return null;
    const identity = this._identity(context, config); if (!identity) return null;
    this._assertGroup(groupId, false);
    const old = this.store.getSourcePublication(groupId, messageId);
    const originalAt = old?.originalAt ?? Number(context.originalTimestamp ?? context.originalAt ?? context.timestamp);
    if (!Number.isSafeInteger(originalAt) || originalAt <= 0 || originalAt > this.now() + 30000) return null;
    const history = importing || context.historical === true || context.history === true;
    if (history ? !config.importFrom || originalAt < config.importFrom || originalAt > config.importUntil : !forUpdate && originalAt < config.enabledAt) return null;
    return { config, groupId, messageId, identity, originalAt, history, old };
  }
  handlePublication(context, options = {}) {
    const checked = this._context(context, options); if (!checked) return { ignored: true };
    if (checked.old) return { ignored: true, duplicate: true, publication: checked.old };
    const { config, groupId, messageId, identity, originalAt } = checked;
    const caption = typeof context.caption === 'string' ? context.caption : typeof context.text === 'string' ? context.text : '';
    const type = context.type || context.media?.type || 'text';
    const image = type === 'image';
    const status = image ? 'pending' : 'review';
    let metadataError = null;
    try { if (image) persistRaw(context.raw); } catch (error) { metadataError = error; }
    if (image && [...this.queue.values()].filter(entry => entry.mode === this._mode()).length >= 64) metadataError = fault('A fila de captura está cheia. A legenda foi preservada; reenvie esta foto ou importe a mídia manualmente.', 'SOURCE_CAPTURE_QUEUE_FULL');
    const record = { id: hash(`${this._mode()}\0${groupId}\0${messageId}`), messageId, groupId,
      originalAt, capturedAt: this.now(), revisionAt: originalAt, dateKey: localDay(originalAt, config.timezone), ownerId: config.ownerId,
      senderId: identity.id, senderPhone: identity.phone, fromMe: context.fromMe === true, text: caption, caption, originalText: caption, originalCaption: caption,
      type, protectedContext: null, mediaFingerprint: /^[a-f0-9]{64}$/i.test(context.mediaFingerprint || '') ? context.mediaFingerprint : null,
      status: metadataError ? 'failed' : status, reason: image ? caption.trim() ? null : 'Foto sem legenda: revise antes de incluir.' : 'Texto ou outro formato recebido separadamente: revise antes de incluir.',
      error: metadataError?.message || null, code: metadataError?.code || null, attempts: 0, campaignId: null, itemId: null, mediaId: null,
      albumParent: context.albumParent || null, historical: checked.history, traceId: randomUUID() };
    const inserted = this.store.transaction(() => {
      if (image && caption.trim()) {
        try { record.campaignId = this._dailyCampaign(record, config).id; }
        catch (error) { if (error.code !== 'SOURCE_CAMPAIGN_REMOVED') throw error; record.status = 'failed'; record.code = error.code; record.error = error.message; }
      }
      return this.store.insertSourcePublication(record);
    });
    if (!inserted.inserted) return { ignored: true, duplicate: true, publication: inserted.publication };
    if (image && !metadataError && inserted.publication.status === 'pending') this.queue.set(record.id, { context, adapter: this.adapter, mode: this._mode() });
    this._trace(inserted.publication, record.status === 'failed' ? 'failure' : 'received', record.status === 'failed' ? record.code : status === 'review' ? 'SOURCE_PUBLICATION_REVIEW' : 'SOURCE_PUBLICATION_RECEIVED', record.status === 'failed' ? record.error : status === 'review' ? record.reason : 'Publicação autorizada registrada; mídia ainda não está pronta.', 'Salvar a mídia antes de incluir na campanha.');
    this._schedulePump(); this.emit('change'); return { accepted: true, publication: inserted.publication };
  }
  _schedulePump() { if (this.closed || this.pumpScheduled) return; this.pumpScheduled = true; queueMicrotask(() => { this.pumpScheduled = false; this._pump(); }); }
  _pump() {
    if (!this._isCaptureAllowed() || this.adapter?.status?.state !== 'connected') return;
    const capacity = this.concurrency - this.inFlight.size; if (capacity <= 0) return;
    const page = this.store.listSourcePublications({ status: 'pending', groupId: this.getConfig().groupId, limit: 200, order: 'capture' });
    for (const record of page.items) {
      if (this.inFlight.has(record.id) || this.inFlight.size >= this.concurrency) continue;
      this.inFlight.add(record.id);
      const task = this._download(record).catch(error => this._error(error)).finally(() => { this.inFlight.delete(record.id); this.tasks.delete(task); this._schedulePump(); });
      this.tasks.add(task);
    }
  }
  async _download(record) {
    const mode = this._mode(), adapter = this.adapter, revisionAt = record.revisionAt;
    const config = this.getConfig(), controller = new AbortController(); this.controllers.add(controller);
    let timeout, aborted; this.store.updateSourcePublication(record.id, { status: 'downloading', attempts: (record.attempts || 0) + 1, lastAttemptAt: this.now() });
    const deadline = new Promise((_, reject) => {
      aborted = () => reject(fault('Download suspenso com segurança; nenhum conteúdo parcial incluído.', 'SOURCE_MEDIA_DOWNLOAD_SUSPENDED'));
      controller.signal.addEventListener('abort', aborted, { once: true });
      timeout = setTimeout(() => { reject(fault('A captura da mídia excedeu o tempo limite. Outros itens continuarão sendo processados.', 'SOURCE_MEDIA_DOWNLOAD_TIMEOUT')); controller.abort(); }, config.mediaTimeoutSeconds * 1000);
    });
    const bounded = promise => Promise.race([promise, deadline]);
    try {
      const current = this.store.getSourcePublication(record.id);
      if (current.mediaId && this.store.getMedia(current.mediaId)) { this._ready(current); return; }
      const queued = this.queue.get(record.id); this.queue.delete(record.id);
      let context = queued?.context;
      if (context?.raw) {
        try {
          if (!this.safeStorage || !await bounded(this.safeStorage.isEncryptionAvailable())) throw fault('Proteção do sistema indisponível.', 'SOURCE_MEDIA_PROTECTION_UNAVAILABLE');
          const envelope = await bounded(this.safeStorage.encryptString(JSON.stringify(persistRaw(context.raw))));
          if (mode === this._mode() && adapter === this.adapter && this.store.getSourcePublication(record.id)?.revisionAt === revisionAt) this.store.updateSourcePublication(record.id, { protectedContext: Buffer.from(envelope).toString('base64'), retryRequiresRepost: false });
        } catch (error) {
          if (controller.signal.aborted) throw error;
          if (mode === this._mode()) this.store.updateSourcePublication(record.id, { retryRequiresRepost: true, protectionCode: 'SOURCE_MEDIA_PROTECTION_UNAVAILABLE' });
        }
      }
      if (!context) {
        if (!record.protectedContext) throw fault('Os dados protegidos desta mídia não estão disponíveis. Reenvie a publicação ou importe o arquivo manualmente.', 'SOURCE_MEDIA_REPOST_REQUIRED');
        if (!this.safeStorage || !await bounded(this.safeStorage.isEncryptionAvailable())) throw fault('A proteção do sistema está indisponível. Reenvie a mídia quando a proteção estiver ativa.', 'SOURCE_MEDIA_PROTECTION_UNAVAILABLE');
        try { context = { messageId: record.messageId, chatId: record.groupId, type: record.type, text: record.caption, raw: restoreRaw(JSON.parse(await bounded(this.safeStorage.decryptString(Buffer.from(record.protectedContext, 'base64'))))) }; }
        catch (error) { if (controller.signal.aborted) throw error; throw fault('Não foi possível abrir os dados protegidos desta mídia neste usuário do Windows. Reenvie a publicação ou importe o arquivo.', 'SOURCE_MEDIA_PROTECTION_UNAVAILABLE'); }
      }
      const work = queued?.context?.media?.download ? queued.context.media.download({ signal: controller.signal }) : adapter?.downloadIncoming?.(context, { signal: controller.signal, timeoutMs: config.mediaTimeoutSeconds * 1000 });
      if (!work) throw fault('A integração não fornece download desta mídia. Importe o arquivo ou revise a publicação.', 'SOURCE_MEDIA_DOWNLOAD_UNSUPPORTED');
      const downloaded = await bounded(work);
      if (this.closed || adapter !== this.adapter || mode !== this._mode() || controller.signal.aborted) return;
      const latest = this.store.getSourcePublication(record.id);
      if (!latest || latest.status === 'removed' || latest.revisionAt !== revisionAt) return;
      const buffer = Buffer.isBuffer(downloaded) ? downloaded : downloaded?.buffer;
      if (!buffer) throw fault('O download não retornou um arquivo completo.', 'SOURCE_MEDIA_DOWNLOAD_INVALID');
      const media = await bounded(this.media.importBuffer(buffer, { name: downloaded.name || `${record.messageId}.jpg`, mime: downloaded.mime || 'image/jpeg', signal: controller.signal, expectedMode: mode,
        beforeSave: () => { const publication = mode === this._mode() && this.store.getSourcePublication(record.id); return !this.closed && adapter === this.adapter && mode === this._mode() && this._isCaptureAllowed() && this.getConfig().groupId === record.groupId && publication?.status !== 'removed' && publication?.revisionAt === revisionAt; } }));
      if (this.closed || adapter !== this.adapter || mode !== this._mode()) return;
      const fresh = this.store.getSourcePublication(record.id);
      if (fresh?.status === 'removed' || fresh?.revisionAt !== revisionAt) return;
      this._ready({ ...fresh, mediaId: media.id, mediaType: media.type, error: null, code: null });
    } catch (error) {
      if (mode !== this._mode() || this.closed) return;
      const latest = this.store.getSourcePublication(record.id);
      if (!latest || latest.status === 'removed' || latest.revisionAt !== revisionAt) return;
      if (adapter !== this.adapter || error.code === 'SOURCE_MEDIA_DOWNLOAD_SUSPENDED') { this.store.updateSourcePublication(record.id, { status: 'pending' }); return; }
      const saved = this.store.updateSourcePublication(record.id, { status: 'failed', code: error.code || 'SOURCE_MEDIA_DOWNLOAD_FAILED', error: String(error.message || 'Não foi possível salvar a mídia.').slice(0, 500), failedAt: this.now() });
      this._trace(saved, 'media', saved.code, saved.error, 'Tente novamente ou revise/importa o arquivo; nenhum outro item será bloqueado.');
    } finally { clearTimeout(timeout); if (aborted) controller.signal.removeEventListener('abort', aborted); this.controllers.delete(controller); this.emit('change'); }
  }
  _baseCampaign(record, config) {
    const [y, m, d] = record.dateKey.split('-');
    return { id: randomUUID(), name: `Lista da loja — ${d}/${m}/${y}`, state: 'draft', mode: 'repeat',
      ...config.configTemplate, groupIds: [], items: [], groupOverrides: {}, ownerId: config.ownerId, responsibleUserIds: [], alertRecipientIds: [],
      dailyRoundLimit: 0, dailySendLimit: 0, retryPolicy: { maxAttempts: 3, delaySeconds: 3 }, nextRunAt: null, roundIndex: 0,
      sourceManaged: true, sourceGroupId: record.groupId, sourceDateKey: record.dateKey, sourceTimezone: config.timezone, sourceRevision: 0,
      sourceConfigurationRequired: true, createdAt: this.now() };
  }
  _dailyCampaign(record, config) {
    const day = this.store.getSourceDay(record.groupId, record.dateKey);
    let campaign = day && this.store.getCampaign(day.campaignId);
    if (day && !campaign) throw fault('A campanha diária foi excluída. Revise a publicação; ela não será recriada silenciosamente.', 'SOURCE_CAMPAIGN_REMOVED');
    if (campaign && (campaign.sourceManaged !== true || campaign.sourceGroupId !== record.groupId || campaign.sourceDateKey !== record.dateKey)) throw fault('O vínculo da origem aponta para outra campanha. A publicação não foi adicionada; restaure uma cópia consistente ou revise o cadastro da origem.', 'SOURCE_DAY_CAMPAIGN_INVALID');
    if (!campaign) { campaign = this.store.saveCampaign(this._baseCampaign(record, config)); this.store.insertSourceDay({ groupId: record.groupId, dateKey: record.dateKey, campaignId: campaign.id, createdAt: this.now() }); }
    return campaign;
  }
  _ready(record) {
    if (!this._isCaptureAllowed() || this.getConfig().groupId !== record.groupId) return this.store.updateSourcePublication(record.id, { ...record, status: 'pending' });
    if (!String(record.caption || record.text || '').trim()) return this.store.saveSourcePublication({ ...record, status: 'review', reason: 'Foto salva sem legenda. Revise manualmente; nenhum texto próximo será associado automaticamente.' });
    return this.store.transaction(() => {
      const existing = this.store.getSourcePublication(record.id);
      if (existing?.status === 'removed') return existing;
      const config = this.getConfig();
      let campaign = this._dailyCampaign(record, config);
      const itemId = existing?.itemId || record.itemId || `source:${record.id}`;
      const item = record.type === 'text' ? { id: itemId, type: 'text', text: record.text } : { id: itemId, type: record.mediaType || record.type, mediaId: record.mediaId, caption: record.caption };
      item.sourcePublicationId = record.id; item.sourcePublicationRevision = record.revisionAt;
      item.captureStatus = 'ready'; item.ready = true;
      if (record.albumParent) item.sourceAlbumParent = record.albumParent;
      if (record.manualGroupId) item.sourceManualGroupId = record.manualGroupId;
      if (!item.mediaId && item.type !== 'text') throw fault('Salve a mídia antes de incluir o item na campanha.', 'SOURCE_MEDIA_NOT_READY');
      const index = (campaign.items || []).findIndex(value => value.id === itemId), items = [...(campaign.items || [])];
      if (index === -1) {
        const position = campaign.sourceOrderCustomized ? -1 : items.findIndex(value => {
          const captured = value.sourcePublicationId && this.store.getSourcePublication(value.sourcePublicationId);
          return captured && captured.captureOrder > (record.captureOrder || existing?.captureOrder || Infinity);
        });
        if (position === -1) items.push(item); else items.splice(position, 0, item);
      } else items[index] = { ...items[index], ...item };
      campaign = this.store.saveCampaign({ ...campaign, items, sourceRevision: (campaign.sourceRevision || 0) + 1 });
      const saved = this.store.saveSourcePublication({ ...record, campaignId: campaign.id, itemId, status: 'ready', readyAt: this.now(), reason: null, error: null, code: null });
      this._trace(saved, 'ready', 'SOURCE_PUBLICATION_READY', 'Mídia salva e conteúdo completo incluído na campanha diária.', campaign.state === 'active' ? 'Disponível somente para a próxima rodada; rodada atual preservada.' : 'Rascunho aguardando destinos e confirmação de início.');
      return saved;
    });
  }
  handleUpdate(context) {
    const checked = this._context(context, { forUpdate: true }); if (!checked?.old || checked.old.status === 'removed') return { ignored: true };
    const old = checked.old, revisionAt = Number(context.revisionAt || context.editedAt || context.timestamp || this.now());
    if (!Number.isSafeInteger(revisionAt) || revisionAt <= old.revisionAt) return { ignored: true, duplicate: true };
    const caption = typeof context.caption === 'string' ? context.caption : typeof context.text === 'string' ? context.text : old.caption;
    const fingerprint = /^[a-f0-9]{64}$/i.test(context.mediaFingerprint || '') ? context.mediaFingerprint : null;
    const changedMedia = context.mediaChanged === true || Boolean(fingerprint && old.mediaFingerprint && fingerprint !== old.mediaFingerprint);
    return this.store.transaction(() => {
    if (context.raw && (changedMedia || !old.mediaId)) this.queue.set(old.id, { context, adapter: this.adapter, mode: this._mode() });
    const updated = this.store.updateSourcePublication(old.id, { caption, text: caption, revisionAt, lastEditedAt: revisionAt, mediaFingerprint: fingerprint || old.mediaFingerprint || null,
      ...(changedMedia ? { protectedContext: null, mediaId: null, status: 'pending' } : old.status === 'downloading' ? { status: 'pending' } : {}) });
    if (updated.mediaId && updated.caption.trim() || updated.type === 'text' && updated.status === 'ready') this._ready(updated);
    else if (changedMedia) {
      const campaign = updated.campaignId && this.store.getCampaign(updated.campaignId);
      if (campaign) this.store.saveCampaign({ ...campaign, items: campaign.items.map(item => item.id === updated.itemId ? { ...item, captureStatus: 'pending', ready: false } : item) });
    }
    else if (!updated.caption.trim()) {
      this.store.updateSourcePublication(old.id, { status: 'review', reason: 'Legenda removida; revise antes de incluir.' });
      const campaign = updated.campaignId && this.store.getCampaign(updated.campaignId);
      if (campaign) this.store.saveCampaign({ ...campaign, items: campaign.items.map(item => item.id === updated.itemId ? { ...item, captureStatus: 'review', ready: false } : item) });
    }
    this._trace(updated, 'edit', 'SOURCE_PUBLICATION_EDITED', 'Edição registrada para as próximas rodadas. Conteúdo já enviado preservado.');
    this._schedulePump(); this.emit('change'); return { updated: true, publication: this.store.getSourcePublication(old.id) };
    });
  }
  handleDelete(context) {
    const config = this.getConfig(), groupId = context?.chatId || context?.groupId;
    if (groupId !== config.groupId || context.automaticMessage || context.automated) return { ignored: true };
    if (context.all === true) {
      let removed = 0, offset = 0;
      for (;;) { const page = this.store.listSourcePublications({ groupId, limit: 200, offset }); for (const publication of page.items) if (publication.status !== 'removed') { this.removePublication(publication.id, { at: context.deletedAt, event: true }); removed++; }
        if (page.items.length < 200) break; offset += page.items.length; }
      return { removed };
    }
    const id = context?.messageId || context?.id, old = id && this.store.getSourcePublication(groupId, id);
    if (!old) {
      if (!config.enabled || typeof id !== 'string' || !id || id.length > 512) return { ignored: true };
      this._assertGroup(groupId, false);
      const removedAt = Number(context.deletedAt) || this.now();
      const publication = this.store.insertSourcePublication({ groupId, messageId: id, originalAt: removedAt, capturedAt: this.now(), revisionAt: removedAt,
        dateKey: localDay(removedAt, config.timezone), ownerId: config.ownerId, status: 'removed', caption: '', text: '',
        removedAt, removalOrigin: 'integration-event', reason: 'Exclusão recebida antes da publicação; uma repetição posterior não criará o item.', traceId: randomUUID() }).publication;
      this._trace(publication, 'delete', 'SOURCE_PUBLICATION_REMOVED', publication.reason);
      this.emit('change'); return { removed: true, tombstone: true, publication };
    }
    return this.removePublication(old.id, { at: context.deletedAt, event: true });
  }
  reviewPublication(id, { caption, text, include = true, mediaId } = {}, actorId) {
    let record = this.store.getSourcePublication(id); if (!record || record.status === 'removed') throw fault('Publicação não encontrada ou removida.', 'SOURCE_PUBLICATION_NOT_FOUND');
    if (!include) return this.removePublication(id, { actorId });
    const body = caption !== undefined ? String(caption) : text !== undefined ? String(text) : record.caption;
    if (!body.trim()) throw fault('Informe o texto ou legenda completo para revisão.', 'SOURCE_REVIEW_TEXT_REQUIRED');
    if (body.length > 16000) throw fault('Use até 16.000 caracteres, sem corte automático do texto original.', 'SOURCE_REVIEW_TEXT_TOO_LARGE');
    if (mediaId) { const media = this.store.getMedia(mediaId); if (!media) throw fault('Mídia gerenciada não encontrada.', 'SOURCE_MEDIA_NOT_READY'); record = { ...record, mediaId: media.id, mediaType: media.type, type: media.type }; }
    const patch = { ...record, caption: body, text: body, revisionAt: Math.max(this.now(), record.revisionAt + 1), reviewedBy: actorId || null, reviewedAt: this.now() };
    let saved;
    if (record.type === 'text' || record.mediaId) saved = this._ready(patch);
    else saved = this.store.saveSourcePublication({ ...patch, status: 'pending', code: null, error: null });
    this._schedulePump(); this.emit('change'); return saved;
  }
  removePublication(id, { at = this.now(), actorId = null, event = false } = {}) {
    const record = this.store.getSourcePublication(id); if (!record) throw fault('Publicação não encontrada.', 'SOURCE_PUBLICATION_NOT_FOUND');
    if (record.status === 'removed') return { removed: false, publication: record };
    const result = this.store.transaction(() => {
      const campaign = record.campaignId && this.store.getCampaign(record.campaignId);
      if (campaign) this.store.saveCampaign({ ...campaign, items: (campaign.items || []).filter(item => item.id !== record.itemId), sourceRevision: (campaign.sourceRevision || 0) + 1 });
      let cancelled = 0;
      if (record.campaignId) for (const job of this.store.listJobs({ campaignId: record.campaignId, status: ['queued', 'pending'] })) if (job.itemId === record.itemId || job.itemSnapshot?.sourcePublicationId === record.id) {
        this.store.updateJob(job.id, { status: 'cancelled', resultAt: this.now(), code: 'SOURCE_PUBLICATION_REMOVED', error: 'Publicação removida antes do início deste envio.' }); cancelled++;
      }
      const publication = this.store.updateSourcePublication(id, { status: 'removed', removedAt: Number(at) || this.now(), removedBy: actorId, removalOrigin: event ? 'integration-event' : 'manual', reason: 'Retirada dos próximos envios. Mensagens já enviadas não foram apagadas.' });
      this.store.addAudit?.({ id: randomUUID(), at: this.now(), userId: actorId, action: 'source.publication.remove', campaignId: record.campaignId, publicationId: id, cancelled });
      this._trace(publication, 'delete', 'SOURCE_PUBLICATION_REMOVED', publication.reason, 'Envios não iniciados cancelados; registros operacionais preservados.');
      return { removed: true, cancelled, publication };
    }); this.queue.delete(id); this.emit('change'); return result;
  }
  retryPublication(id) {
    const record = this.store.getSourcePublication(id); if (!record || record.status === 'removed') throw fault('Publicação não encontrada ou removida.', 'SOURCE_PUBLICATION_NOT_FOUND');
    if (!['failed', 'review', 'pending'].includes(record.status)) throw fault('Esta publicação já está pronta ou em processamento.', 'SOURCE_RETRY_NOT_ALLOWED');
    if (!record.caption.trim()) throw fault('Revise a foto sem legenda antes de tentar incluí-la.', 'SOURCE_REVIEW_TEXT_REQUIRED');
    const saved = this.store.updateSourcePublication(id, { status: 'pending', error: null, code: null }); this._schedulePump(); this.emit('change'); return saved;
  }
  reorderItems(campaignId, itemIds) {
    const campaign = this.store.getCampaign(campaignId); if (!campaign?.sourceManaged) throw fault('Campanha de origem não encontrada.', 'SOURCE_CAMPAIGN_NOT_FOUND');
    const original = campaign.items || [];
    if (!Array.isArray(itemIds) || itemIds.length !== original.length || new Set(itemIds).size !== itemIds.length || itemIds.some(id => !original.some(item => item.id === id))) throw fault('Informe todos os itens existentes uma única vez.', 'SOURCE_ITEM_ORDER_INVALID');
    const map = new Map(original.map(item => [item.id, item])); const result = this.store.saveCampaign({ ...campaign, items: itemIds.map(id => map.get(id)), sourceOrderCustomized: true, sourceRevision: (campaign.sourceRevision || 0) + 1 }); this.emit('change'); return result;
  }
  applyConfigTemplate(campaignId) {
    const campaign = this.store.getCampaign(campaignId); if (!campaign?.sourceManaged) throw fault('Campanha de origem não encontrada.', 'SOURCE_CAMPAIGN_NOT_FOUND');
    if (campaign.state === 'active') throw fault('Pause a campanha antes de aplicar configurações salvas.', 'SOURCE_CAMPAIGN_PAUSE_REQUIRED');
    const config = this.getConfig(); for (const id of config.configTemplate.groupIds) this._assertGroup(id, true);
    if (config.configTemplate.groupIds.includes(campaign.sourceGroupId)) throw fault('O grupo de origem não pode ser destino.', 'SOURCE_CAPTURE_CYCLE');
    const result = this.store.saveCampaign({ ...campaign, ...config.configTemplate, state: 'draft', nextRunAt: null, sourceConfigurationRequired: false }); this.emit('change'); return result;
  }
  groupPublications(ids, { caption } = {}, actorId) {
    if (!Array.isArray(ids) || ids.length < 2 || ids.length > 100 || new Set(ids).size !== ids.length) throw fault('Selecione de 2 a 100 fotos distintas para agrupar.', 'SOURCE_GROUPING_INVALID');
    const records = ids.map(id => this.store.getSourcePublication(id));
    if (records.some(record => !record || record.type !== 'image' || record.status === 'removed') || records.some(record => record.groupId !== records[0].groupId || record.dateKey !== records[0].dateKey)) throw fault('Agrupe apenas fotos da mesma origem e data, sem associar mensagens por horário.', 'SOURCE_GROUPING_INVALID');
    const groupKey = randomUUID();
    this.store.transaction(() => { for (const record of records) this.store.updateSourcePublication(record.id, { manualGroupId: groupKey, groupedBy: actorId || null, groupedAt: this.now() }); });
    if (caption !== undefined) for (const record of records) this.reviewPublication(record.id, { caption }, actorId);
    this.emit('change'); return { groupKey, ids, association: 'manual', preservedOriginalMessages: true };
  }
  async importHistory({ from, to }) {
    const parse = value => typeof value === 'number' ? value : Date.parse(value), start = parse(from), end = parse(to);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end < start || end > this.now()) throw fault('Informe um período anterior válido para importação explícita.', 'SOURCE_HISTORY_RANGE_INVALID');
    const config = this.getConfig();
    if (!this._isCaptureAllowed(config)) throw fault('Ative a origem e confira a licença/permissões antes de importar.', 'SOURCE_CAPTURE_BLOCKED');
    if (typeof this.adapter?.listSourceHistory !== 'function') throw fault('A integração atual não oferece importação completa por período. Somente novas publicações são capturadas. O histórico do WhatsApp pode ter lacunas e não será simulado.', 'SOURCE_HISTORY_UNSUPPORTED');
    this.store.setSourceConfig({ ...config, importFrom: start, importUntil: end }); this._configureAdapter();
    const messages = await this.adapter.listSourceHistory(config.groupId, { from: start, to: end });
    if (!Array.isArray(messages)) throw fault('A integração não retornou um histórico verificável.', 'SOURCE_HISTORY_UNSUPPORTED');
    let captured = 0; for (const context of messages) if (this.handlePublication({ ...context, historical: true }, { importing: true }).accepted) captured++;
    return { captured, complete: false, from: start, to: end, notice: 'Somente as mensagens realmente fornecidas pela integração foram importadas; o histórico pode ter lacunas.' };
  }
  metrics() { const config = this.getConfig(); return { ...this.store.getSourceMetrics(), groupId: config.groupId, groupName: this.store.getGroup(config.groupId)?.name || null, startedAt: config.enabledAt, enabled: config.enabled, captureBlockedReason: this.captureBlockedReason || null,
    limitations: { historyImport: typeof this.adapter?.listSourceHistory === 'function', albumAssociation: 'Somente vínculo explícito informado pela integração ou agrupamento manual; nunca por proximidade de horário.' } }; }
  async waitForIdle() { for (;;) { this._pump(); if (!this.tasks.size) return; await Promise.allSettled([...this.tasks]); } }
  suspendCapture() { this.suspended = true; for (const controller of this.controllers) controller.abort(); this.emit('change'); return { inProgress: this.inFlight.size }; }
  resumeCapture() { this.suspended = false; this._schedulePump(); this.emit('change'); }
  async stop() { this.closed = true; this.started = false; this._detach(); for (const controller of this.controllers) controller.abort(); await Promise.allSettled([...this.tasks]); this.queue.clear(); }
  async shutdown() { return this.stop(); }
}

module.exports = { SourceCampaignService, normalizeSourceConfig: normalizeConfig, localDay, persistRaw, restoreRaw, sanitizeSourcePublication };
