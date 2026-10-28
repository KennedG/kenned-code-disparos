'use strict';

const { EventEmitter } = require('node:events');
const { randomUUID, createHash } = require('node:crypto');

const DEFAULT_SEARCH_SETTINGS = Object.freeze({ enabled: false, prefix: '!busca', maxResults: 10,
  timezone: 'America/Sao_Paulo', monitoredGroupIds: [], commandGroupIds: [], privateCommandsEnabled: false,
  commandPrivateNumbers: [], validityHours: 24, customFrom: '', customTo: '', retentionDays: 30,
  aliases: { colors: { prata: 'silver' }, models: {} }, defaultFilters: {},
  blockedSupplierIds: [], blockedGroupIds: [], onePerSupplier: false, sort: 'cashAscending', priceCriterion: 'cash',
  recipientMode: 'owner', ownerRecipientUserId: null, responsibleRecipientIds: [], allowOriginReplies: false,
  importHistory: false, userRateLimit: { max: 10, windowSeconds: 60 } });
const PERMISSIONS = { search: 'search.run', history: 'search.history', filters: 'search.filters', manage: 'search.manage', view: 'search.view' };
const phone = value => typeof value === 'string' && /^[1-9]\d{9,14}$/.test(value) ? value : null;
const page = value => Array.isArray(value) ? value : value?.items || [];
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const fail = (message, code = 'SEARCH_INVALID') => { throw Object.assign(new Error(message), { code }); };
const boundedText = (value, max = 256) => typeof value === 'string' && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
const safeNumber = (value, min, max, name) => { if (!Number.isInteger(value) || value < min || value > max) fail(`${name} deve estar entre ${min} e ${max}.`); return value; };
const strings = (value, max = 500) => { if (!Array.isArray(value) || value.length > max || value.some(x => !boundedText(x, 512) || !x)) fail('Lista de identificadores inválida.'); return [...new Set(value)]; };
const milliseconds = value => { const n = Number(value); return Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : null; };

function parseZonedTime(value, timezone) {
  if (!value) return null;
  if (/(?:Z|[+-]\d\d:\d\d)$/i.test(value)) {
    const explicit = String(value).match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:\d\d)$/i);
    if (!explicit) fail('Data ISO inválida.');
    const [year, month, day, hour, minute, second] = explicit.slice(1).map(v => Number(v || 0));
    const probe = new Date(0); probe.setUTCFullYear(year, month - 1, day); probe.setUTCHours(hour, minute, second, 0);
    const at = Date.parse(value);
    if (!Number.isFinite(at) || month < 1 || month > 12 || day < 1 || probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) fail('Data ou horário inválido.');
    return at;
  }
  const match = String(value).match(/^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d)(?::(\d\d))?)?$/);
  if (!match) fail('Informe data e horário válidos, ou uma data ISO com fuso.');
  const [year, month, day, hour, minute, second] = match.slice(1).map(v => Number(v || 0));
  const probe = new Date(0); probe.setUTCFullYear(year, month - 1, day); probe.setUTCHours(hour, minute, second, 0); const desired = probe.getTime();
  if (month < 1 || month > 12 || day < 1 || probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) fail('Data ou horário inválido.');
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const represented = at => { const parts = Object.fromEntries(formatter.formatToParts(at).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)])); return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second); };
  let at = desired; for (let i = 0; i < 4 && represented(at) !== desired; i++) at += desired - represented(at);
  if (represented(at) !== desired) fail('O horário informado não existe neste fuso devido à mudança de horário.');
  return at;
}

function validateFilters(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Filtros inválidos.');
  const output = {}, numeric = { storageGB: [1, 8192], minBattery: [0, 100], maxBattery: [0, 100], batteryMin: [0, 100], batteryMax: [0, 100], batteryPercent: [0, 100], minPriceCents: [0, 100_000_000], maxPriceCents: [0, 100_000_000], priceMinCents: [0, 100_000_000], priceMaxCents: [0, 100_000_000] };
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined || value === '') continue;
    if (numeric[key]) output[key] = safeNumber(value, ...numeric[key], key);
    else if (['model', 'modelKey', 'color', 'colorKey', 'condition', 'supplier', 'supplierKey', 'warranty'].includes(key)) { if (!boundedText(value, 256)) fail(`Filtro ${key} inválido.`); output[key] = value.trim(); }
    else fail('Um filtro informado não é reconhecido.');
  }
  if (output.condition && !['lacrado', 'seminovo', 'usado', 'cpo'].includes(output.condition.toLowerCase())) fail('Condição inválida.');
  if (output.condition) output.condition = output.condition.toLowerCase();
  if ((output.minBattery ?? output.batteryMin ?? 0) > (output.maxBattery ?? output.batteryMax ?? 100)) fail('A bateria mínima deve ser menor que a máxima.');
  if ((output.minPriceCents ?? output.priceMinCents ?? 0) > (output.maxPriceCents ?? output.priceMaxCents ?? 100_000_000)) fail('O preço mínimo deve ser menor que o máximo.');
  return output;
}

function offerContact(text) {
  const raw = String(text).match(/\b(?:vendas|contato|whats(?:app)?|telefone|fone)\s*[:=-]?\s*(\+?\d[\d ()\-.]{7,24}\d)/i)?.[1]?.trim();
  if (!raw) return {};
  const digits = raw.replace(/\D/g, '');
  return { contactInOffer: raw, contactPhone: (raw.startsWith('+') || /^55\d{10,11}$/.test(digits)) && phone(digits) ? digits : null };
}

function validateSearchSettings(input, previous = DEFAULT_SEARCH_SETTINGS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Configurações de BUSCAS inválidas.');
  const settings = { ...structuredClone(DEFAULT_SEARCH_SETTINGS), ...structuredClone(previous) };
  for (const name of ['enabled', 'privateCommandsEnabled', 'onePerSupplier', 'allowOriginReplies', 'importHistory']) {
    if (input[name] !== undefined) { if (typeof input[name] !== 'boolean') fail(`Opção ${name} inválida.`); settings[name] = input[name]; }
  }
  for (const name of ['monitoredGroupIds', 'commandGroupIds', 'commandPrivateNumbers', 'blockedSupplierIds', 'blockedGroupIds', 'responsibleRecipientIds']) if (input[name] !== undefined) settings[name] = strings(input[name]);
  settings.blockedSupplierIds = [...new Set(settings.blockedSupplierIds.map(id => { const digits = id.replace(/[\s()+-]/g, ''); return phone(digits) ? `phone:${digits}` : id; }))];
  if (settings.commandPrivateNumbers.some(x => !phone(x))) fail('Conversas privadas exigem telefone real com código do país e DDD.');
  if (input.prefix !== undefined) { if (typeof input.prefix !== 'string' || !/^![\p{L}\p{N}_-]{1,31}$/u.test(input.prefix)) fail('O prefixo deve começar com ! e conter até 31 letras, números, _ ou -.'); settings.prefix = input.prefix; }
  if (input.maxResults !== undefined) settings.maxResults = safeNumber(input.maxResults, 1, 10, 'Quantidade de resultados');
  if (input.validityHours !== undefined) settings.validityHours = safeNumber(input.validityHours, 1, 8760, 'Validade em horas');
  if (input.retentionDays !== undefined) settings.retentionDays = safeNumber(input.retentionDays, 1, 3650, 'Retenção em dias');
  if (input.timezone !== undefined) { try { new Intl.DateTimeFormat('pt-BR', { timeZone: input.timezone }).format(); } catch { fail('Fuso horário inválido.'); } settings.timezone = input.timezone; }
  if (input.sort !== undefined) { if (!['cashAscending', 'cashDescending', 'recent'].includes(input.sort)) fail('Critério de ordenação inválido.'); settings.sort = input.sort; }
  if (input.priceCriterion !== undefined) { if (!['cash', 'announced', 'lot', 'from'].includes(input.priceCriterion)) fail('Critério de preço inválido.'); settings.priceCriterion = input.priceCriterion; }
  if (input.recipientMode !== undefined) { if (!['owner', 'requester', 'responsibles', 'origin'].includes(input.recipientMode)) fail('Destinatário de resultados inválido.'); settings.recipientMode = input.recipientMode; }
  if (input.ownerRecipientUserId !== undefined) { if (input.ownerRecipientUserId !== null && !boundedText(input.ownerRecipientUserId, 128)) fail('Dono destinatário inválido.'); settings.ownerRecipientUserId = input.ownerRecipientUserId; }
  if (settings.recipientMode === 'origin' && !settings.allowOriginReplies) fail('Respostas na conversa de origem exigem habilitação explícita.');
  for (const name of ['customFrom', 'customTo']) if (input[name] !== undefined) { if (input[name] && !boundedText(input[name], 50)) fail('Período personalizado inválido.'); settings[name] = input[name] || ''; }
  const from = parseZonedTime(settings.customFrom, settings.timezone), to = parseZonedTime(settings.customTo, settings.timezone);
  if (from !== null && to !== null && from > to) fail('O início deve anteceder o fim do período.');
  if (input.defaultFilters !== undefined) settings.defaultFilters = validateFilters(input.defaultFilters);
  if (input.aliases !== undefined) {
    if (!input.aliases || typeof input.aliases !== 'object' || Array.isArray(input.aliases) || JSON.stringify(input.aliases).length > 16384) fail('Sinônimos inválidos.');
    for (const [key, aliases] of Object.entries(input.aliases)) { if (!boundedText(key, 80) || !key) fail('Sinônimo inválido.'); if (typeof aliases === 'string') { if (!boundedText(aliases, 80) || !aliases) fail('Sinônimo inválido.'); } else if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases) || Object.entries(aliases).some(([a, b]) => !boundedText(a, 80) || !a || !boundedText(b, 80) || !b)) fail('Cada sinônimo deve associar dois textos curtos.'); }
    settings.aliases = structuredClone(input.aliases);
  }
  if (input.userRateLimit !== undefined) settings.userRateLimit = { max: safeNumber(input.userRateLimit.max, 1, 100, 'Limite de buscas'), windowSeconds: safeNumber(input.userRateLimit.windowSeconds, 1, 3600, 'Janela do limite') };
  return settings;
}

class SearchService extends EventEmitter {
  constructor({ store, adapter, authService, scheduler, now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    super(); Object.assign(this, { store, adapter, authService, scheduler, now, sleep });
    this.started = false; this.closed = false; this.paused = false; this.capturePump = null; this.deliveryPump = null;
    this.waitingCommands = 0; this.commandTail = Promise.resolve(); this.rateLimits = new Map(); this.cleanupTokens = new Map();
    this.monitor = store.getSetting('buscasMonitor', { startedAt: null, lastCaptureAt: null, lastSyncAt: null, lastHeartbeatAt: null, openGap: null });
    this.groups = new Map(store.listGroups().map(group => [group.id, group]));
    this.listeners = {
      offerMessage: ctx => { void this.handleIncoming(ctx).catch(e => this._diagnostic('SEARCH_RECEIVE_ERROR', 'Falha ao processar uma mensagem de BUSCAS.', e)); },
      offerMessageUpdate: ctx => { this._enqueue(ctx, 'update'); },
      offerMessageDelete: ctx => { this._enqueue(ctx, 'delete'); },
      offerHistory: batch => { this._captureHistory(batch); },
      status: status => { this._onStatus(status); },
      receipt: receipt => { this._receipt(receipt); }
    };
  }
  _settings() { return validateSearchSettings({}, this.store.getSetting('buscasSettings', DEFAULT_SEARCH_SETTINGS)); }
  _user(id) { if (typeof id !== 'string' || !id) return null; const user = this.store.getEntity('users', id), role = user && this.store.getEntity('roles', user.roleId); return user && role && user.active !== false && !user.requirePasswordChange ? { ...user, isOwner: !!role.isOwner } : null; }
  _grant(actorId) { return this.store.getSearchAuthorization?.(`user:${actorId}`) || this.store.getSearchAuthorization?.(actorId) || null; }
  _can(actorId, permission) {
    const user = this._user(actorId); if (!user || !this.authService?.canFor(actorId, PERMISSIONS[permission])) return false;
    if (user.isOwner) return true;
    const grant = this._grant(actorId); if (!grant || grant.enabled === false || grant.userId !== actorId) return false;
    return permission === 'view' ? grant.permissions?.some(p => ['search', 'history', 'filters', 'manage'].includes(p)) : grant.permissions?.includes(permission);
  }
  _assert(actorId, permission) { if (!this._can(actorId, permission)) fail('Você não está autorizado para esta ação no módulo BUSCAS.', 'SEARCH_DENIED'); return this._user(actorId); }
  _audit(action, actorId, details = {}) { this.store.addAudit?.({ id: randomUUID(), at: this.now(), actorId: actorId || null, action, details }); }
  _diagnostic(code, description, error) { this.store.addDiagnostic?.({ id: randomUUID(), at: this.now(), stage: 'buscas', code, description, action: 'Consulte BUSCAS e reveja a captura ou o resultado incerto.', guidance: 'Verifique conexão, grupos selecionados e permissões. Ofertas ambíguas não entram no ranking.', attempts: 0, detail: error?.code || null }); }
  _persistMonitor() { this.store.setSetting('buscasMonitor', this.monitor); }
  _openGap(reason, at = this.now()) { if (!this.monitor.openGap) this.monitor.openGap = { id: randomUUID(), startedAt: at, reason }; this._persistMonitor(); }
  _closeGap(at = this.now()) { if (!this.monitor.openGap) return; this.store.recordSearchGap?.({ ...this.monitor.openGap, endedAt: at, complete: false }); this.monitor.openGap = null; this._persistMonitor(); }
  _attach(adapter) { for (const [name, listener] of Object.entries(this.listeners)) adapter?.on(name, listener); }
  _detach(adapter) { for (const [name, listener] of Object.entries(this.listeners)) adapter?.off(name, listener); }
  _configure() { const s = this._settings(); this.groups = new Map(this.store.listGroups().map(group => [group.id, group])); this.adapter?.configureSearchCapture?.({ enabled: s.enabled && !this.paused, importHistory: s.importHistory, groupIds: s.monitoredGroupIds, commandGroupIds: s.commandGroupIds }); }
  start() {
    if (this.started || this.closed) return; this.started = true; this._attach(this.adapter);
    const s = this._settings(); if (s.enabled && this.monitor.lastHeartbeatAt && this.now() > this.monitor.lastHeartbeatAt + 1000) this.store.recordSearchGap?.({ id: randomUUID(), startedAt: this.monitor.lastHeartbeatAt, endedAt: this.now(), reason: 'application_not_running', complete: false });
    if (s.enabled && !this.monitor.startedAt) this.monitor.startedAt = this.now();
    this.monitor.lastHeartbeatAt = this.now(); this._persistMonitor();
    for (const delivery of page(this.store.listSearchDeliveries?.({ status: 'sending', limit: 500 }))) this.store.updateSearchDelivery(delivery.id, { status: 'uncertain', resultAt: this.now(), error: 'Envio interrompido; revisão necessária antes de repetir.' });
    this._configure(); this._onStatus(this.adapter?.status || { state: 'disconnected' }); this._drain();
    this.timer = setInterval(() => { if (this.closed) return; try { this.monitor.lastHeartbeatAt = this.now(); this._persistMonitor(); this.store.applySearchRetention?.({ days: this._settings().retentionDays, at: this.now() }); this._drain(); void this.flushDeliveries(); } catch (e) { this._diagnostic('SEARCH_MAINTENANCE_ERROR', 'Falha na manutenção da captura.', e); } }, 30_000); this.timer.unref?.();
  }
  async shutdown() { if (this.closed) return; this.closed = true; clearInterval(this.timer); this._detach(this.adapter); await this.capturePump?.catch(() => {}); await this.commandTail.catch(() => {}); await this.deliveryPump?.catch(() => {}); this.monitor.lastHeartbeatAt = this.now(); this._persistMonitor(); }
  setAdapter(adapter) { this._detach(this.adapter); if (this._settings().enabled) this._openGap('integration_changed'); this.adapter = adapter; if (this.started && !this.closed) this._attach(adapter); this._configure(); this._onStatus(adapter?.status || { state: 'disconnected' }); }
  async suspendCapture(reason = 'maintenance') { this.paused = true; if (this._settings().enabled) this._openGap(reason); this._configure(); await this.capturePump?.catch(() => {}); }
  resumeCapture() { this.paused = false; this._configure(); this._onStatus(this.adapter?.status || { state: 'disconnected' }); this._drain(); }
  async _waitCaptureIdle() { while (!this.closed && !this.paused) { const running = this._drain(); if (running) await running; if (!page(this.store.listSearchInbox({ status: 'queued', limit: 1 })).length) break; } }
  async waitForIdle() { await this._waitCaptureIdle(); await this.commandTail; await this._waitCaptureIdle(); await this.deliveryPump; }
  _onStatus(status) { if (this.closed || !this._settings().enabled) return; if (status?.state === 'connected' && !this.paused) { this._closeGap(); void this.flushDeliveries(); } else this._openGap(status?.reasonCode || 'disconnected'); this.emit('change'); }
  getState(actorId) {
    const permissions = Object.fromEntries(Object.keys(PERMISSIONS).map(p => [p, this._can(actorId, p)]));
    if (!Object.values(permissions).some(Boolean)) return { authorized: false, permissions, enabled: false };
    const settings = this._settings(), stats = this.store.getSearchMonitorStats?.() || {};
    const publicSettings = permissions.manage ? settings : { ...settings, commandPrivateNumbers: [], ownerRecipientUserId: null, responsibleRecipientIds: [], blockedSupplierIds: [] };
    return { authorized: true, permissions, settings: publicSettings, enabled: settings.enabled, monitor: { ...this.monitor, status: !settings.enabled ? 'disabled' : this.paused ? 'paused' : this.adapter?.status?.state === 'connected' ? 'monitoring' : 'disconnected', connection: this.adapter?.status?.state || 'disconnected', complete: false, gaps: page(this.store.listSearchGaps?.({ limit: 20 })), queueSize: stats.inbox || stats.queued || 0 }, stats,
      history: permissions.history ? this._historyPage({ limit: 20 }) : { items: [], total: 0 },
      offers: permissions.view ? this.store.querySearchOffers({ limit: 20, includeReview: true, includeUnavailable: true }) : { items: [], total: 0 },
      authorizations: permissions.manage ? this.listAuthorizations(actorId) : { items: [], total: 0 },
      groups: [...this.groups.values()].map(({ id, name, simulation, community, isCommunity, linkedParent, isCommunityAnnounce }) => ({ id, name, simulation, community, isCommunity, linkedParent, isCommunityAnnounce })),
      users: permissions.manage ? this.store.listEntities('users').map(u => ({ id: u.id, name: u.name, phone: u.phone || '', active: u.active !== false, isOwner: !!this.store.getEntity('roles', u.roleId)?.isOwner })) : [],
      recipients: permissions.manage ? this.store.listEntities('alert_recipients').map(r => ({ id: r.id, name: r.name, phone: r.phone, enabled: r.enabled !== false })) : [] };
  }
  saveSettings(payload, actorId) {
    const input = payload?.settings || payload; const previous = this._settings();
    const keys = Object.keys(input || {}); if (keys.some(k => !['defaultFilters', 'aliases'].includes(k))) this._assert(actorId, 'manage'); else this._assert(actorId, 'filters');
    const settings = validateSearchSettings(input, previous);
    const known = new Set(this.store.listGroups().map(g => g.id));
    if ([...settings.monitoredGroupIds, ...settings.commandGroupIds, ...settings.blockedGroupIds].some(id => !known.has(id))) fail('Selecione grupos disponíveis na conta.');
    if (settings.ownerRecipientUserId) { const user = this._user(settings.ownerRecipientUserId); if (!user?.isOwner || !phone(user.phone)) fail('Selecione um Dono ativo com telefone real.'); }
    for (const id of settings.responsibleRecipientIds) if (!this._recipientById(id)) fail('Um responsável selecionado não está cadastrado ou não tem telefone válido.');
    for (const number of settings.commandPrivateNumbers) if (!this.authService.findAuthorizedPhone(number)) fail('Conversas de comando devem corresponder a usuários ativos com telefone autorizado.');
    this.store.setSetting('buscasSettings', settings);
    if (settings.enabled && !previous.enabled) { if (!this.monitor.startedAt) this.monitor.startedAt = this.now(); this._openGap('monitoring_disabled', this.monitor.lastCaptureAt || this.now()); }
    if (!settings.enabled && previous.enabled) this._openGap('monitoring_disabled');
    this._configure(); this._onStatus(this.adapter?.status || {}); this._persistMonitor(); this._audit('search.settings', actorId, { enabled: settings.enabled, groups: settings.monitoredGroupIds.length, prefix: settings.prefix }); this.emit('change'); return settings;
  }
  listAuthorizations(actorId) { this._assert(actorId, 'manage'); const records = this.store.listSearchAuthorizations({ limit: 500 }); return { ...(Array.isArray(records) ? { items: records, total: records.length } : records), items: page(records).map(record => ({ ...record, userName: this._user(record.userId)?.name || 'Usuário indisponível', phone: this._user(record.userId)?.phone || '' })) }; }
  saveAuthorization(payload, actorId) { this._assert(actorId, 'manage'); const input = payload?.authorization || payload; const user = this._user(input.userId); if (!user) fail('Selecione um usuário ativo com acesso regular.'); const permissions = strings(input.permissions || [], 4); if (permissions.some(p => !['search', 'history', 'filters', 'manage'].includes(p))) fail('Permissão de BUSCAS inválida.'); if (input.enabled !== undefined && typeof input.enabled !== 'boolean') fail('Estado da autorização inválido.'); const result = this.store.saveSearchAuthorization({ id: `user:${user.id}`, userId: user.id, enabled: input.enabled !== false, permissions, createdAt: this._grant(user.id)?.createdAt || this.now(), updatedAt: this.now(), actorId }); this._audit('search.authorization', actorId, { userId: user.id, permissions, enabled: result.enabled }); this.emit('change'); return result; }
  deleteAuthorization(id, actorId) { this._assert(actorId, 'manage'); if (typeof id === 'object') id = id.id || `user:${id.userId}`; const record = this.store.getSearchAuthorization(id); if (record) this.store.deleteSearchAuthorization(id); this._audit('search.authorization_removed', actorId, { userId: record?.userId }); this.emit('change'); return !!record; }
  listHistory(filters, actorId) { this._assert(actorId, 'history'); return this._historyPage(this._pageFilters(filters)); }
  _historyPage(filters) {
    const records = this.store.listSearchHistory(filters), summaries = new Map(this.store.getSearchDeliverySummaries(page(records).map(run => run.id)).map(summary => [summary.runId, summary]));
    return { ...records, items: page(records).map(run => {
      const summary = summaries.get(run.id);
      if (!summary) return { ...run, deliveryStatus: run.deliveryStatus || (run.status === 'failed' ? 'failed' : 'local'), deliveryTargets: [], deliveryParts: 0, deliveryCounts: { pending: 0, sending: 0, confirmed: 0, uncertain: 0, failed: 0, cancelled: 0 } };
      const counts = summary.counts;
      const deliveryStatus = counts.uncertain ? 'uncertain' : counts.failed ? 'failed' : counts.sending ? 'sending' : counts.pending ? 'pending' : counts.cancelled ? 'cancelled' : counts.confirmed === summary.parts ? 'confirmed' : 'uncertain';
      return { ...run, deliveryStatus, deliveryTargets: summary.targets, deliveryParts: summary.parts, deliveryCounts: counts, deliveryCreatedAt: summary.firstCreatedAt, deliveryFirstSubmittedAt: summary.firstSubmittedAt, deliveryLastSubmittedAt: summary.lastSubmittedAt, deliveryResultAt: summary.lastResultAt };
    }) };
  }
  listOffers(filters, actorId) { this._assert(actorId, 'view'); return this.store.querySearchOffers(this._pageFilters(filters)); }
  listMessages(filters, actorId) { this._assert(actorId, 'view'); return this.store.querySearchMessages(this._pageFilters(filters)); }
  _pageFilters(filters = {}) { const result = { ...filters }; if (result.limit !== undefined) result.limit = safeNumber(result.limit, 1, 100, 'Limite da página'); if (result.offset !== undefined) result.offset = safeNumber(result.offset, 0, 1_000_000, 'Página'); return result; }
  _eligibleCapture(ctx) { const s = this._settings(); return s.enabled && !this.paused && !this.closed && (ctx?.isGroup === true || this.groups.has(ctx?.chatId)) && s.monitoredGroupIds.includes(ctx.chatId) && !s.blockedGroupIds.includes(ctx.chatId) && (ctx.all === true || typeof ctx.messageId === 'string' && ctx.messageId.length <= 512); }
  _enqueue(ctx, kind = 'message') {
    if (!this._eligibleCapture(ctx)) return false;
    if (kind !== 'delete' && (!boundedText(ctx.text, 128_000) || !ctx.text.trim())) return false;
    const enqueue = this.store.enqueueSearchInbox({ id: hash(`${ctx.chatId}:${ctx.messageId}:${kind}:${ctx.revisionAt || ctx.deletedAt || ''}`), kind, context: structuredClone(ctx), createdAt: this.now(), status: 'queued' }, { maximum: 5000 });
    if (enqueue.full) { this.store.recordSearchGap({ id: randomUUID(), startedAt: this.now(), endedAt: this.now(), reason: 'capture_queue_full', groupId: ctx.chatId, complete: false }); this._diagnostic('SEARCH_QUEUE_FULL', 'A fila de captura ficou cheia. Há uma lacuna de mensagens.'); return false; }
    this._drain(); return enqueue.enqueued;
  }
  _captureHistory(batch) { const s = this._settings(); if (!s.enabled || !s.importHistory) return; for (const ctx of (batch?.messages || []).slice(0, 500)) this._enqueue({ ...ctx, history: true }); this.monitor.lastSyncAt = this.now(); this._persistMonitor(); this.store.recordSearchGap?.({ id: randomUUID(), startedAt: this.now(), endedAt: this.now(), reason: 'partial_history_import', complete: false, source: batch?.source || 'integration' }); this.emit('change'); }
  _drain() {
    if (this.capturePump || this.closed || this.paused) return this.capturePump;
    this.capturePump = this._processInbox().catch(e => this._diagnostic('SEARCH_CAPTURE_ERROR', 'A captura encontrou uma falha; mensagens pendentes serão retomadas.', e)).finally(() => { this.capturePump = null; if (!this.closed && !this.paused && page(this.store.listSearchInbox({ status: 'queued', limit: 1 })).length) queueMicrotask(() => this._drain()); }); return this.capturePump;
  }
  async _processInbox() {
    while (!this.closed && !this.paused) {
      const inbox = page(this.store.listSearchInbox({ status: 'queued', limit: 50 })); if (!inbox.length) break;
      for (const entry of inbox) {
        if (this.closed || this.paused) break;
        const ctx = entry.context || entry.payload || entry.message;
        try { this._capture(ctx, entry.kind || 'message'); this.store.deleteSearchInbox(entry.id); }
        catch (e) { if (this.store.persistenceFailed) throw e; this.store.updateSearchInbox(entry.id, { status: 'failed', code: e.code || 'SEARCH_PARSE_ERROR' }); this._diagnostic('SEARCH_PARSE_ERROR', 'Uma mensagem não pôde ser interpretada. O anúncio não entrou no ranking.', e); }
      }
      await new Promise(resolve => setImmediate(resolve));
    }
    this.emit('change');
  }
  _capture(ctx, kind) {
    if (!ctx) return;
    if (kind === 'delete') {
      const deletedAt = milliseconds(ctx.deletedAt) || this.now();
      if (ctx.all === true) { let records; do { records = page(this.store.querySearchMessages({ chatId: ctx.chatId, limit: 500 })); if (records.length) this.store.deleteSearchMessages(records.map(m => ({ chatId: m.chatId, messageId: m.messageId })), deletedAt); } while (records.length); }
      else this.store.deleteSearchMessages([{ chatId: ctx.chatId, messageId: ctx.messageId }], deletedAt);
      return;
    }
    const previous = this.store.getSearchMessage(ctx.chatId, ctx.messageId);
    const originalAt = previous?.originalAt || previous?.messageAt || milliseconds(ctx.timestamp);
    if (!originalAt) fail('Mensagem sem data original confiável.', 'SEARCH_TIMESTAMP_UNKNOWN');
    const actualPhone = ctx.identityVerified === true || ctx.verified === true ? phone(ctx.senderNumber) : null;
    const senderId = typeof ctx.senderId === 'string' && ctx.senderId.length <= 256 ? ctx.senderId : previous?.senderId || '';
    const supplierKey = ctx.forwarded ? `forwarded:${hash(ctx.text)}` : actualPhone ? `phone:${actualPhone}` : senderId ? `account:${senderId}` : `unknown:${ctx.chatId}:${ctx.messageId}`;
    const group = this.groups.get(ctx.chatId);
    const message = { ...previous, id: previous?.id || `${ctx.chatId}:${ctx.messageId}`, chatId: ctx.chatId, groupId: ctx.chatId, groupName: group?.name || ctx.chatId, messageId: ctx.messageId, text: ctx.text, senderId, senderNumber: actualPhone || previous?.senderNumber || null, savedName: ctx.savedName || previous?.savedName || null, displayName: ctx.displayName || ctx.pushName || previous?.displayName || null, originalAt, capturedAt: this.now(), revisionAt: milliseconds(ctx.revisionAt) || previous?.revisionAt || originalAt, forwarded: ctx.forwarded === true, history: ctx.history === true, supplierKey };
    const { parseOffers } = require('./search-parser.cjs');
    const parsed = parseOffers(message.text, { aliases: this._settings().aliases });
    const offers = (Array.isArray(parsed) ? parsed : parsed.offers || []).map((offer, index) => ({ ...offer, ...offerContact(offer.originalExcerpt || message.text), id: `${hash(`${message.chatId}:${message.messageId}`)}:${index}`, messageKey: message.id, chatId: message.chatId, messageId: message.messageId, groupId: message.groupId, groupName: message.groupName, supplierKey, senderId, supplierPhone: message.senderNumber, savedName: message.savedName, supplierName: message.displayName || message.savedName || 'Fornecedor sem nome disponível', displayName: message.displayName, forwarded: message.forwarded, originalSupplierKnown: !message.forwarded, messageAt: originalAt, originalAt, revisionAt: message.revisionAt, capturedAt: message.capturedAt, originalText: message.text, snippet: offer.originalExcerpt || offer.snippet || offer.originalText || message.text, fingerprint: offer.fingerprint || hash(`${offer.productKey}|${offer.priceCents}|${offer.originalExcerpt || message.text}`) }));
    this.store.upsertSearchMessage(message, offers);
    this.monitor.lastCaptureAt = this.now(); this.monitor.lastSyncAt = this.now(); this._persistMonitor();
  }
  async handleIncoming(ctx) {
    if (this.closed) return false; this._enqueue(ctx);
    const settings = this._settings(); if (!settings.enabled || this.paused || !ctx || ctx.dataOnly === true || ctx.type !== 'text' || ctx.fromMe !== false || ctx.forwarded !== false || ctx.history === true || ctx.historical === true || ctx.isHistory === true) return false;
    const text = typeof ctx.text === 'string' ? ctx.text.trim() : ''; const lower = text.toLocaleLowerCase('pt-BR'), prefix = settings.prefix.toLocaleLowerCase('pt-BR');
    if (!lower.startsWith(prefix) || text.length > prefix.length && !/\s/.test(text[prefix.length])) return false;
    if (ctx.isGroup === true ? !settings.commandGroupIds.includes(ctx.chatId) : ctx.isGroup !== false || !settings.privateCommandsEnabled || !settings.commandPrivateNumbers.includes(phone(ctx.senderNumber))) return false;
    if (!(ctx.identityVerified === true || ctx.verified === true) || !phone(ctx.senderNumber) || !boundedText(ctx.messageId, 512) || !ctx.messageId) return false;
    const actor = this.authService.findAuthorizedPhone(ctx.senderNumber); if (!actor || !this._can(actor.id, 'search')) return false;
    const timestamp = milliseconds(ctx.timestamp); if (!timestamp || timestamp < this.now() - 300_000 || timestamp > this.now() + 60_000) return false;
    if (ctx.isGroup === false && ctx.chatId !== `${ctx.senderNumber}@s.whatsapp.net` && !/^\d+@lid$/.test(ctx.chatId || '')) return false;
    if (this.waitingCommands >= 64) return false;
    this.waitingCommands++;
    const operation = this.commandTail.then(async () => {
      const current = this._settings();
      if (!this._can(actor.id, 'search') || !current.enabled || this.paused || this.closed || current.prefix.toLocaleLowerCase('pt-BR') !== prefix) return false;
      if (ctx.isGroup ? !current.commandGroupIds.includes(ctx.chatId) : !current.privateCommandsEnabled || !current.commandPrivateNumbers.includes(ctx.senderNumber)) return false;
      const claim = this.store.claimSearchRun({ id: randomUUID(), chatId: ctx.chatId, messageId: ctx.messageId, actorId: actor.id, requestedAt: this.now(), originalAt: timestamp, source: ctx.isGroup ? 'whatsapp-group' : 'whatsapp-private', query: text.slice(prefix.length).trim(), status: 'queued' });
      if (!claim.claimed) return false;
      const run = claim.run;
      if (!this._consumeRate(actor.id)) { this.store.saveSearchRun({ ...run, status: 'rate_limited', resultCount: 0, completedAt: this.now() }); return false; }
      await this._execute(run.query, {}, actor.id, { run, context: ctx, deliver: true, rateChecked: true }); return true;
    }).finally(() => { this.waitingCommands--; }); this.commandTail = operation.catch(() => {}); return operation;
  }
  _consumeRate(actorId) { const policy = this._settings().userRateLimit, now = this.now(), entry = this.rateLimits.get(actorId); const entries = entry && entry.startedAt > now - policy.windowSeconds * 1000 ? entry : { startedAt: now, count: 0 }; if (entries.count >= policy.max) return false; entries.count++; this.rateLimits.set(actorId, entries); if (this.rateLimits.size > 1000) for (const [id, item] of this.rateLimits) if (item.startedAt < now - 3600_000) this.rateLimits.delete(id); return true; }
  async executeSearch(payload, actorId, options = {}) { this._assert(actorId, 'search'); if (!this._settings().enabled) fail('Ative BUSCAS antes de pesquisar.', 'SEARCH_DISABLED'); if (!payload || !boundedText(payload.query, 500)) fail('Informe uma busca de até 500 caracteres.'); const filters = validateFilters(payload.filters || {}); if (!this._consumeRate(actorId)) fail('Limite de buscas atingido. Aguarde e tente novamente.', 'SEARCH_RATE_LIMIT'); return this._execute(payload.query.trim(), filters, actorId, { deliver: options.deliver === true }); }
  async _execute(query, filters, actorId, options) {
    this._assert(actorId, 'search'); const settings = this._settings();
    const run = options.run || { id: randomUUID(), actorId, query, requestedAt: this.now(), source: 'application', chatId: null, messageId: null, status: 'queued' };
    if (!options.run) this.store.saveSearchRun(run);
    try {
    await this._waitCaptureIdle();
    const period = { from: settings.customFrom ? parseZonedTime(settings.customFrom, settings.timezone) : this.now() - settings.validityHours * 3600_000, to: settings.customTo ? parseZonedTime(settings.customTo, settings.timezone) : this.now() };
    const stale = this.adapter?.status?.state !== 'connected' || !!this.monitor.openGap;
    let results = [], parsedFilters = {}, guidance = null;
    if (!query) guidance = `Use ${settings.prefix} iPhone 18 Pro Max 256GB Silver para buscar ofertas capturadas.`;
    else {
      const { parseQuery, rankOffers, normalize } = require('./search-parser.cjs'); parsedFilters = parseQuery(query, { aliases: settings.aliases });
      if (parsedFilters.valid === false || parsedFilters.unknownTokens?.length || !parsedFilters.modelKey) guidance = parsedFilters.errors?.[0] || 'Informe o modelo e a versão exatos do aparelho. Exemplo: iPhone 18 Pro Max 256GB Silver.';
      else {
        const normalizeFilters = values => { const result = { ...values }; if (result.model || result.modelKey) { const model = parseQuery(result.model || result.modelKey, { aliases: settings.aliases }); if (!model.valid || model.unknownTokens.length || !model.modelKey) fail('Modelo do filtro não reconhecido.'); result.modelKey = model.modelKey; } if (result.color || result.colorKey) result.colorKey = normalize(result.color || result.colorKey, settings.aliases); if (result.supplier) { const digits = result.supplier.replace(/[\s()+-]/g, ''); if (phone(digits)) result.supplierKey = `phone:${digits}`; else result.supplierSearch = result.supplier; } return result; };
        const extra = normalizeFilters(filters), defaults = normalizeFilters(settings.defaultFilters);
        for (const key of ['modelKey', 'storageGB', 'colorKey', 'condition']) if (parsedFilters[key] != null && extra[key] != null && parsedFilters[key] !== extra[key]) fail('Um filtro adicional contradiz o produto descrito na busca. Ajuste o comando ou o filtro.');
        const effective = { ...defaults, ...Object.fromEntries(Object.entries(parsedFilters).filter(([, value]) => value !== null && value !== undefined)), ...extra };
        effective.batteryMin = effective.minBattery ?? effective.batteryMin; effective.batteryMax = effective.maxBattery ?? effective.batteryMax; effective.priceMinCents = effective.minPriceCents ?? effective.priceMinCents; effective.priceMaxCents = effective.maxPriceCents ?? effective.priceMaxCents;
        const queryFilters = { ...effective, minBattery: effective.batteryMin, maxBattery: effective.batteryMax, minPriceCents: effective.priceMinCents, maxPriceCents: effective.priceMaxCents, priceKind: settings.priceCriterion === 'announced' ? undefined : settings.priceCriterion, order: settings.sort === 'recent' ? 'recent' : settings.sort === 'cashDescending' ? 'price-desc' : 'price', onePerSupplier: settings.onePerSupplier, from: period.from, to: period.to, excludedSupplierKeys: settings.blockedSupplierIds, excludedGroupIds: settings.blockedGroupIds, confidence: 'confirmed', latest: true, limit: 500, offset: 0, includeReview: false, includeUnavailable: false };
        delete queryFilters.valid; delete queryFilters.reason;
        const candidates = page(this.store.querySearchOffers(queryFilters));
        results = rankOffers(candidates, effective, { priceCriterion: settings.priceCriterion, candidateLimit: 500, maxResults: 10, onePerSupplier: false, blockedSuppliers: settings.blockedSupplierIds, blockedGroups: settings.blockedGroupIds }); const seenSuppliers = new Set();
        const order = settings.sort === 'recent' ? (a, b) => b.messageAt - a.messageAt : settings.sort === 'cashDescending' ? (a, b) => b.priceCents - a.priceCents : (a, b) => a.priceCents - b.priceCents || b.messageAt - a.messageAt;
        results.sort(order); if (settings.onePerSupplier) results = results.filter(offer => { if (seenSuppliers.has(offer.supplierKey)) return false; seenSuppliers.add(offer.supplierKey); return true; }); results = results.slice(0, settings.maxResults);
      }
    }
    const warnings = ['A base inclui somente mensagens capturadas; o histórico pode conter lacunas.']; if (stale) warnings.unshift('⚠️ Captura desatualizada ou interrompida. Valores podem não refletir anúncios recentes.');
    if (results.some(o => o.forwarded)) warnings.push('Encaminhamentos: o remetente é quem republicou; o fornecedor original pode ser desconhecido.');
    const answer = { runId: run.id, query, results, count: results.length, period, order: settings.sort, timezone: settings.timezone, stale, warnings, guidance, filters: parsedFilters, delivery: [] };
    this.store.saveSearchRun({ ...run, query, status: 'completed', resultCount: results.length, resultOfferIds: results.map(o => o.id), filters: parsedFilters, period, warnings, completedAt: this.now() });
    this._audit('search.executed', actorId, { runId: run.id, source: run.source, resultCount: results.length });
    if (options.deliver) {
      const targets = this._targets(settings, actorId, options.context); const chunks = formatSearchResults(answer, settings);
      if (!targets.length) { this.store.saveSearchRun({ ...this.store.getSearchRun(run.id), deliveryStatus: 'failed', deliveryError: 'Nenhum destinatário autorizado com telefone válido está configurado.' }); this._diagnostic('SEARCH_RECIPIENT_MISSING', 'A busca foi concluída, mas não há destinatário privado válido.'); }
      for (const target of targets) for (const [index, text] of chunks.entries()) { const clientMessageId = `MEGA-SEARCH-${randomUUID()}`; this.store.saveSearchDelivery({ id: `${run.id}:${hash(target).slice(0, 16)}:${index}`, runId: run.id, actorId, target, text, clientMessageId, messageId: clientMessageId, recipientMode: settings.recipientMode, status: 'pending', attempts: 0, createdAt: this.now(), sourceChatId: options.context?.chatId || null, sourceIsGroup: options.context?.isGroup === true, sourceSenderNumber: options.context?.senderNumber || null }); }
      await this.flushDeliveries(); answer.delivery = page(this.store.listSearchDeliveries({ runId: run.id, limit: 100 }));
    }
    this.emit('change'); return answer;
    } catch (error) { this.store.saveSearchRun({ ...this.store.getSearchRun(run.id), status: 'failed', code: error.code || 'SEARCH_QUERY_ERROR', completedAt: this.now() }); this._diagnostic('SEARCH_QUERY_ERROR', 'A busca não foi concluída. Confira os filtros antes de repetir.', error); throw error; }
  }
  _recipientById(id) { if (typeof id !== 'string') return null; if (id.startsWith('user:')) { const u = this._user(id.slice(5)); return u && phone(u.phone); } const r = this.store.getAlertRecipient?.(id) || this.store.getEntity('alert_recipients', id); return r?.enabled !== false && phone(r?.phone); }
  _targets(settings, actorId, ctx) {
    if (settings.recipientMode === 'origin') { if (!settings.allowOriginReplies || !ctx || (ctx.isGroup ? !settings.commandGroupIds.includes(ctx.chatId) : !settings.commandPrivateNumbers.includes(ctx.senderNumber))) return []; return [ctx.chatId]; }
    if (settings.recipientMode === 'requester') { const user = this._assert(actorId, 'search'); return phone(user.phone) ? [`${user.phone}@s.whatsapp.net`] : []; }
    if (settings.recipientMode === 'responsibles') return [...new Set(settings.responsibleRecipientIds.map(id => this._recipientById(id)).filter(Boolean).map(n => `${n}@s.whatsapp.net`))];
    let owner = settings.ownerRecipientUserId && this._user(settings.ownerRecipientUserId);
    if (!owner?.isOwner || !phone(owner.phone)) owner = this.store.listEntities('users').map(u => this._user(u.id)).find(u => u?.isOwner && phone(u.phone));
    return owner && phone(owner.phone) ? [`${owner.phone}@s.whatsapp.net`] : [];
  }
  flushDeliveries() { if (this.deliveryPump) return this.deliveryPump; if (this.closed || this.adapter?.status?.state !== 'connected' || this.store.persistenceFailed) return Promise.resolve(); this.deliveryPump = (this.scheduler?.runExternalSubmission ? this.scheduler.runExternalSubmission(() => this._flushDeliveries()) : this._flushDeliveries()).finally(() => { this.deliveryPump = null; }); return this.deliveryPump; }
  async _flushDeliveries() {
    const release = this.scheduler?.holdSubmissions?.() || (() => {}); try { await this.scheduler?.waitForIdle?.();
      const pending = page(this.store.listSearchDeliveries({ status: 'pending', limit: 100 }));
      for (const delivery of pending) {
        if (this.closed || this.adapter?.status?.state !== 'connected') break;
        if (delivery.nextAttemptAt > this.now()) continue;
        if (!this._can(delivery.actorId, 'search')) { this.store.updateSearchDelivery(delivery.id, { status: 'failed', resultAt: this.now(), error: 'A autorização do solicitante foi removida.' }); continue; }
        const currentSettings = this._settings();
        if (!currentSettings.enabled || !this._targets(currentSettings, delivery.actorId, delivery.sourceChatId ? { chatId: delivery.sourceChatId, isGroup: delivery.sourceIsGroup, senderNumber: delivery.sourceSenderNumber } : null).includes(delivery.target)) { this.store.updateSearchDelivery(delivery.id, { status: 'failed', resultAt: this.now(), error: 'O destino da entrega deixou de estar habilitado.' }); continue; }
        const minimum = Math.max(3, this.adapter.minimumSpacingSeconds || 3) * 1000, previous = this.scheduler?.lastSubmissionAt;
        if (previous != null) await this.sleep(Math.max(0, minimum - (this.now() - previous)));
        if (this.closed || this.adapter?.status?.state !== 'connected') break;
        const attempt = (delivery.attempts || 0) + 1; this.store.updateSearchDelivery(delivery.id, { status: 'sending', attempts: attempt, submittedAt: this.now() });
        try { if (this.scheduler) this.scheduler.lastSubmissionAt = this.now(); const result = await this.adapter.sendSearchText(delivery.target, delivery.text, { clientMessageId: delivery.clientMessageId });
          const current = this.store.getSearchDelivery(delivery.id); const confirmed = current?.status === 'confirmed' || result?.status === 'confirmed';
          this.store.updateSearchDelivery(delivery.id, { status: confirmed ? 'confirmed' : 'uncertain', resultAt: this.now(), messageId: result?.messageId || delivery.clientMessageId, error: confirmed ? null : 'Envio sem confirmação; revisar antes de repetir.' });
        } catch (error) { const safe = error?.safeToRetry === true, status = safe && attempt < 3 ? 'pending' : safe || error?.definitive === true ? 'failed' : 'uncertain'; this.store.updateSearchDelivery(delivery.id, { status, nextAttemptAt: this.now() + 15_000, resultAt: status === 'pending' ? null : this.now(), error: status === 'pending' ? 'Falha anterior à submissão. Tentativa limitada pendente.' : status === 'failed' ? 'Falha definitiva na entrega.' : 'Resultado incerto. Revisão necessária antes de repetir.' }); this._diagnostic('SEARCH_DELIVERY_ERROR', 'A entrega dos resultados não recebeu confirmação.', error); }
        this.emit('change');
      }
    } finally { release(); }
  }
  _receipt(receipt) { if (receipt?.status !== 'confirmed' || !receipt.messageId) return; for (const d of page(this.store.listSearchDeliveries({ messageId: receipt.messageId, limit: 100 }))) if ([d.messageId, d.clientMessageId].includes(receipt.messageId) && ['sending', 'uncertain'].includes(d.status)) this.store.updateSearchDelivery(d.id, { status: 'confirmed', resultAt: this.now(), error: null }); }
  reviewOffer(payload, actorId) { this._assert(actorId, 'manage'); const offer = this.store.getSearchOffer(payload.id); if (!offer) fail('Oferta não encontrada.'); if (!['discard', 'confirm'].includes(payload.decision)) fail('Escolha confirmar ou descartar.'); const patch = { status: payload.decision === 'discard' ? 'unavailable' : 'active', confidence: payload.decision === 'confirm' ? 'confirmed' : offer.confidence, reviewedBy: actorId, reviewedAt: this.now() }; if (payload.decision === 'confirm') { if (offer.reviewReasons?.some(r => ['multiple_models', 'unsupported_model_variant', 'ambiguous_storage', 'ambiguous_color', 'ambiguous_condition'].includes(r))) fail('A associação entre produto e preço também é ambígua. Não é possível confirmá-la corrigindo apenas o preço; mantenha em revisão ou descarte.'); if (!Number.isInteger(payload.priceCents) || payload.priceCents <= 0 || payload.priceCents > 100_000_000) fail('Informe o preço total confirmado, em centavos.'); patch.priceCents = payload.priceCents; patch.priceKind = 'cash'; } const result = this.store.updateSearchOffer(payload.id, patch); this._audit('search.offer_review', actorId, { offerId: payload.id, decision: payload.decision }); this.emit('change'); return result; }
  cleanupPreview(payload, actorId) { this._assert(actorId, 'manage'); const scope = payload?.scope; if (!['history', 'base'].includes(scope)) fail('Selecione histórico de buscas ou base de ofertas.'); const stats = this.store.getSearchMonitorStats(); const token = randomUUID(); this.cleanupTokens.set(token, { actorId, scope, expiresAt: this.now() + 300_000 }); if (this.cleanupTokens.size > 100) this.cleanupTokens.delete(this.cleanupTokens.keys().next().value); return { scope, token, stats, effect: scope === 'history' ? 'Remove apenas o histórico de consultas. Ofertas, mensagens e controles de entrega permanecem.' : 'Remove mensagens capturadas e ofertas. Campanhas, usuários, configurações, histórico de consultas e controles de entrega permanecem.' }; }
  async clearData(payload, actorId) { this._assert(actorId, 'manage'); const token = this.cleanupTokens.get(payload.token); if (!token || token.actorId !== actorId || token.scope !== payload.scope || token.expiresAt < this.now()) fail('Visualize novamente o que será removido antes de apagar.'); if (payload.confirmation !== 'APAGAR') fail('Digite APAGAR para confirmar.'); this.cleanupTokens.delete(payload.token); if (payload.scope === 'base') { await this.suspendCapture('offers_base_cleared'); try { this.store.deleteSearchBase({ actor: actorId }); this.monitor.lastSyncAt = null; this.monitor.lastCaptureAt = null; } finally { this.resumeCapture(); } } else this.store.deleteSearchHistory({ actor: actorId }); this._audit(`search.${payload.scope}_cleared`, actorId); this.emit('change'); return { cleared: true, scope: payload.scope }; }
  importHistory(actorId) { this._assert(actorId, 'manage'); if (!this._settings().enabled || !this._settings().importHistory) fail('Ative BUSCAS e a importação parcial de histórico.'); if (typeof this.adapter?.requestSearchHistory !== 'function') return { supported: false, complete: false, detail: 'A integração entrega somente o histórico parcial disponibilizado durante a sincronização. Não há importação completa sob demanda.' }; return this.adapter.requestSearchHistory({ groupIds: this._settings().monitoredGroupIds }); }
}

function formatSearchResults(answer, settings) {
  const date = value => new Date(value).toLocaleString('pt-BR', { timeZone: settings.timezone });
  const money = value => (value / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const header = answer.guidance || `🔎 Busca: ${answer.query}\n📊 Encontradas ${answer.count} ofertas\n🗓️ Período consultado: ${date(answer.period.from)} a ${date(answer.period.to)}\n💰 Ordem: ${settings.sort === 'recent' ? 'mais recentes' : settings.sort === 'cashDescending' ? 'maior para menor preço' : 'menor para maior preço'}\n${answer.warnings.join('\n')}`;
  const blocks = answer.results.map((offer, index) => { const realPhone = phone(offer.supplierPhone), informed = phone(offer.contactPhone || offer.offerPhone); const displayed = offer.supplierName || offer.displayName || offer.savedName || 'Nome indisponível'; let names = displayed; if (offer.savedName && offer.displayName && offer.savedName !== offer.displayName) names = `${offer.savedName} (WhatsApp: ${offer.displayName})`; if (offer.forwarded) names = `${names} — republicador; fornecedor original desconhecido`;
    const condition = offer.condition || 'Condição não informada', battery = Number.isFinite(offer.batteryPercent) ? `; bateria ${offer.batteryPercent}%` : '';
    const qualifier = offer.priceKind === 'from' ? 'a partir de' : offer.priceKind === 'lot' ? `preço para lote${offer.minPurchase ? `; mínimo ${offer.minPurchase} unidades` : ''}` : offer.priceQualifier;
    const old = (answer.period.to - (offer.originalAt || offer.messageAt)) > 86400000 ? '\n⚠️ Oferta com mais de 24 horas' : '';
    return `${index + 1}. 📱 ${offer.model || offer.modelName || offer.modelKey} — ${offer.storageGB ? `${offer.storageGB}GB` : 'Capacidade não informada'} — ${offer.color || offer.colorName || offer.colorKey || 'Cor não informada'}\n💰 ${money(offer.priceCents)}${qualifier ? ` (${qualifier})` : ''}\n📦 ${condition}${battery}\n👤 ${names}\n📞 ${offer.forwarded ? 'Telefone de quem republicou: ' : ''}${realPhone || 'Número indisponível'}${realPhone && !offer.forwarded ? `\n🔗 https://wa.me/${realPhone}` : ''}${offer.contactInOffer || informed ? `\nContato informado na oferta: ${offer.contactInOffer || informed}${informed ? `\n🔗 https://wa.me/${informed}` : ''}` : ''}\n📝 “${String(offer.snippet || offer.originalText || '').slice(0, 1800)}”\n👥 ${offer.groupName || offer.groupId}\n📅 ${date(offer.originalAt || offer.messageAt)}${old}`;
  });
  if (!answer.guidance && !answer.results.length) blocks.push('Não foram encontradas ofertas compatíveis com os filtros informados.');
  blocks.push('Valores conforme anúncios capturados. Confirme disponibilidade e condições com o fornecedor.');
  const chunks = []; let current = header; for (const block of blocks) { if (current.length + block.length + 2 > 3500) { chunks.push(current); current = block; } else current += `\n\n${block}`; } if (current) chunks.push(current); return chunks;
}

module.exports = { SearchService, DEFAULT_SEARCH_SETTINGS, validateSearchSettings, validateFilters, parseZonedTime, formatSearchResults };
