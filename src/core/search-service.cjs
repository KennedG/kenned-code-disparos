'use strict';

const { EventEmitter } = require('node:events');
const { randomUUID, createHash } = require('node:crypto');

const DEFAULT_SEARCH_SETTINGS = Object.freeze({ enabled: false, prefix: '!busca', maxResults: 10,
  timezone: 'America/Sao_Paulo', monitoredGroupIds: [], commandGroupIds: [], privateCommandsEnabled: false,
  commandPrivateNumbers: [], validityHours: 24, customFrom: '', customTo: '', retentionDays: 30,
  aliases: { colors: { prata: 'silver' }, models: {} }, defaultFilters: {},
  blockedSupplierIds: [], blockedGroupIds: [], onePerSupplier: false, sort: 'cashAscending', priceCriterion: 'cash',
  recipientMode: 'owner', ownerRecipientUserId: null, responsibleRecipientIds: [], allowOriginReplies: false, selfCommandsEnabled: true,
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
  for (const name of ['enabled', 'privateCommandsEnabled', 'onePerSupplier', 'allowOriginReplies', 'importHistory', 'selfCommandsEnabled']) {
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
  _trace(traceId, stage, details = {}) {
    const descriptions = { received: 'Comando recebido.', authorization: 'Autorização do comando verificada.', parsed: 'Comando interpretado.', results: 'Consulta de ofertas concluída.', recipient: 'Destinatário da busca definido.', queued: 'Resposta colocada na fila persistente.', submitted: 'Resposta submetida à integração.', integration: 'Resultado da integração recebido.', rejected: 'Comando ignorado.', failure: 'Falha no processamento da busca.', retry: 'Nova tentativa de entrega solicitada.' };
    this.store.addDiagnostic?.({ id: randomUUID(), at: this.now(), traceId, stage: `buscas.${stage}`, code: details.code || `SEARCH_${stage.toUpperCase()}`, description: descriptions[stage] || 'Etapa do processamento de BUSCAS.', actorId: details.actorId || null, action: details.action || 'Consulte o histórico de BUSCAS para acompanhar a entrega.', attempts: details.attempts || 0, detail: Object.fromEntries(Object.entries(details).filter(([key]) => ['reason', 'approved', 'resultCount', 'deliveryId', 'recipientId', 'target', 'status', 'messageId', 'source', 'confirmationScope'].includes(key))) });
  }
  _safeError(error) {
    const messages = { SEARCH_RECIPIENT_MISSING: 'Nenhum destinatário válido está configurado', SEARCH_OWNER_RECIPIENT_INVALID: 'O dono selecionado está inativo ou sem telefone válido', SEARCH_RATE_LIMIT: 'Limite de buscas atingido; aguarde antes de tentar novamente', SEARCH_DENIED: 'A autorização para buscar foi removida', SEARCH_DISABLED: 'O módulo BUSCAS está desativado', RECIPIENT_NOT_REGISTERED: 'O destinatário não foi encontrado no WhatsApp', PRIVATE_RECIPIENT_INVALID: 'Telefone do destinatário inválido; confira código do país e DDD', DISCONNECTED: 'O WhatsApp está desconectado', SEARCH_TARGET_DISABLED: 'O destinatário ou a autorização mudou antes do envio; nenhuma mensagem foi enviada', SEARCH_RESULT_UNCERTAIN: 'Não foi possível confirmar a entrega; revise o histórico antes de repetir', SEARCH_INVALID: 'Os filtros ou a configuração da busca são inválidos' };
    Object.assign(messages, { WA_RECIPIENT_INVALID: 'Telefone inválido; confira código do país, DDD e número', WA_RECIPIENT_OFFLINE: 'O WhatsApp está desconectado; o envio permanece pendente', WA_RECIPIENT_NOT_FOUND: 'O número configurado não foi encontrado no WhatsApp', WA_RECIPIENT_AMBIGUOUS: 'O WhatsApp retornou mais de um destinatário; revise o telefone', WA_RECIPIENT_MISMATCH: 'O telefone resolvido difere do cadastrado; revise o destinatário', WA_RECIPIENT_INVALID_JID: 'O WhatsApp retornou um identificador de destinatário inválido', WA_RECIPIENT_NUMBER_UNAVAILABLE: 'Cadastre o telefone real do destinatário com código do país e DDD', WA_RECIPIENT_UNSUPPORTED: 'A integração instalada não disponibiliza a validação do destinatário; atualize o aplicativo', WA_RECIPIENT_TIMEOUT: 'O WhatsApp não respondeu à validação do telefone; será feita uma tentativa limitada', WA_RECIPIENT_CONNECTION_CHANGED: 'A conexão mudou durante a validação; nenhuma mensagem foi enviada', WA_RECIPIENT_LOOKUP_INCOMPLETE: 'O WhatsApp não confirmou o destinatário; nenhuma mensagem foi enviada', WA_RECIPIENT_LOOKUP_TEMPORARY: 'Falha temporária na validação do telefone; será feita uma tentativa limitada', WA_RECIPIENT_LOOKUP_REJECTED: 'O WhatsApp recusou a validação do telefone; verifique a conexão e restrições', WA_RECIPIENT_BUSY: 'A fila de validação de destinatários está ocupada; aguarde uma nova tentativa' });
    return messages[error?.code] || 'Não foi possível concluir a busca ou confirmar sua entrega';
  }
  _persistMonitor() { this.store.setSetting('buscasMonitor', this.monitor); }
  _openGap(reason, at = this.now()) { if (!this.monitor.openGap) this.monitor.openGap = { id: randomUUID(), startedAt: at, reason }; this._persistMonitor(); }
  _closeGap(at = this.now()) { if (!this.monitor.openGap) return; this.store.recordSearchGap?.({ ...this.monitor.openGap, endedAt: at, complete: false }); this.monitor.openGap = null; this._persistMonitor(); }
  _attach(adapter) { for (const [name, listener] of Object.entries(this.listeners)) adapter?.on(name, listener); }
  _detach(adapter) { for (const [name, listener] of Object.entries(this.listeners)) adapter?.off(name, listener); }
  _configure() { const s = this._settings(); this.groups = new Map(this.store.listGroups().map(group => [group.id, group])); this.adapter?.configureSearchCapture?.({ enabled: s.enabled && !this.paused, importHistory: s.importHistory, groupIds: s.monitoredGroupIds, commandGroupIds: s.commandGroupIds }); }
  refreshGroups() { this._configure(); this.emit('change'); }
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
  setAdapter(adapter) { this._detach(this.adapter); this.adapter = adapter; this.monitor = this.store.getSetting('buscasMonitor', { startedAt: null, lastCaptureAt: null, lastSyncAt: null, lastHeartbeatAt: null, openGap: null }); this.rateLimits.clear(); this.cleanupTokens.clear(); if (this.started && !this.closed) this._attach(adapter); this._configure(); this._onStatus(adapter?.status || { state: 'disconnected' }); }
  async suspendCapture(reason = 'maintenance') { this.paused = true; if (this._settings().enabled) this._openGap(reason); this._configure(); await this.capturePump?.catch(() => {}); await this.commandTail.catch(() => {}); await this.deliveryPump?.catch(() => {}); }
  resumeCapture() { this.paused = false; this._configure(); this._onStatus(this.adapter?.status || { state: 'disconnected' }); this._drain(); }
  async _waitCaptureIdle() { while (!this.closed && !this.paused) { const running = this._drain(); if (running) await running; if (!page(this.store.listSearchInbox({ status: 'queued', limit: 1 })).length) break; } }
  async waitForIdle() { await this._waitCaptureIdle(); await this.commandTail; await this._waitCaptureIdle(); do { await this.deliveryPump; if (this.closed || this.paused || this.adapter?.status?.state !== 'connected' || !page(this.store.listSearchDeliveries({ status: 'pending', dueAt: this.now(), limit: 1 })).length) break; await this.flushDeliveries(); } while (!this.closed); }
  _onStatus(status) { if (this.closed || !this._settings().enabled) return; if (status?.state === 'connected' && !this.paused) { this._closeGap(); void this.flushDeliveries(); } else this._openGap(status?.reasonCode || 'disconnected'); this.emit('change'); }
  getState(actorId) {
    this.groups = new Map(this.store.listGroups().map(group => [group.id, group]));
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
      recipients: permissions.manage ? this.store.listEntities('alert_recipients').map(r => ({ id: r.id, name: r.name, phone: r.phone, enabled: r.enabled !== false })) : [],
      recipientStatus: permissions.manage ? this.getRecipientStatus(actorId) : null };
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
  _eligibleCapture(ctx) { const s = this._settings(); return s.enabled && !this.paused && !this.closed && this._modeMatches(ctx) && ctx?.machineGenerated !== true && ctx?.automaticMessage !== true && (ctx?.isGroup === true || this.groups.has(ctx?.chatId)) && s.monitoredGroupIds.includes(ctx.chatId) && !s.blockedGroupIds.includes(ctx.chatId) && (ctx.all === true || typeof ctx.messageId === 'string' && ctx.messageId.length <= 512); }
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
  _trustedSelf(ctx) {
    if (ctx?.fromMe !== true || ctx.trustedSelf !== true || ctx.machineGenerated === true || ctx.automaticMessage === true) return false;
    const own = phone(this.adapter?.status?.ownNumber || ctx.ownAccountNumber || ctx.accountNumber);
    if (!own || own !== phone(ctx.senderNumber)) return false;
    if (ctx.ownAccountNumber && ctx.ownAccountNumber !== own || ctx.accountNumber && ctx.accountNumber !== own) return false;
    return typeof this.adapter?.isTrustedSelfContext === 'function' ? this.adapter.isTrustedSelfContext(ctx) === true : own === phone(ctx.ownAccountNumber || ctx.accountNumber);
  }
  _commandLocation(ctx, settings, own = false) {
    if (ctx.isGroup === true) return settings.commandGroupIds.includes(ctx.chatId);
    if (ctx.isGroup !== false) return false;
    const selfChat = own && (ctx.chatId === `${ctx.senderNumber}@s.whatsapp.net` || ctx.chatId === (ctx.ownAccountId || this.adapter?.status?.ownAccountId) || ctx.selfChat === true);
    if (selfChat && settings.selfCommandsEnabled) return true;
    if (!settings.privateCommandsEnabled) return false;
    if (own) { const number = phone(ctx.chatId?.match(/^(\d+)@s\.whatsapp\.net$/)?.[1]); return !!number && settings.commandPrivateNumbers.includes(number); }
    return settings.commandPrivateNumbers.includes(phone(ctx.senderNumber)) && (ctx.chatId === `${ctx.senderNumber}@s.whatsapp.net` || /^\d+@lid$/.test(ctx.chatId || ''));
  }
  async handleIncoming(ctx) {
    if (this.closed) return false; this._enqueue(ctx);
    const settings = this._settings();
    if (!ctx || ctx.dataOnly === true || ctx.type !== 'text' || ctx.forwarded !== false || ctx.history === true || ctx.historical === true || ctx.isHistory === true || ctx.machineGenerated === true || ctx.automaticMessage === true) return false;
    const text = typeof ctx.text === 'string' ? ctx.text.trim() : '', lower = text.toLocaleLowerCase('pt-BR'), prefix = settings.prefix.toLocaleLowerCase('pt-BR');
    if (!lower.startsWith(prefix) || text.length > prefix.length && !/\s/.test(text[prefix.length])) return false;
    const traceId = randomUUID(); this._trace(traceId, 'received', { messageId: ctx.messageId, source: ctx.fromMe ? 'manual-own-account' : 'incoming' });
    const reject = reason => { this._trace(traceId, 'rejected', { reason, approved: false }); return false; };
    if (!settings.enabled || this.paused) return reject('module_disabled_or_paused');
    if (!this._modeMatches(ctx)) return reject('integration_mode_mismatch');
    const own = this._trustedSelf(ctx);
    if (ctx.fromMe !== false && !own) return reject('untrusted_own_account_message');
    if (!(ctx.identityVerified === true || ctx.verified === true) || !phone(ctx.senderNumber) || !boundedText(ctx.messageId, 512) || !ctx.messageId) return reject('sender_identity_unavailable');
    const actor = this.authService.findAuthorizedPhone(ctx.senderNumber);
    if (!actor || !this._can(actor.id, 'search') || own && !this._user(actor.id)?.isOwner) return reject('sender_not_authorized');
    if (!this._commandLocation(ctx, settings, own)) return reject('conversation_not_enabled');
    this._trace(traceId, 'authorization', { actorId: actor.id, approved: true });
    const timestamp = milliseconds(ctx.timestamp); if (!timestamp || timestamp < this.now() - 300_000 || timestamp > this.now() + 60_000) return reject('old_or_missing_timestamp');
    if (this.waitingCommands >= 64) return reject('command_queue_full');
    const capturedMode = this._mode(); this.waitingCommands++;
    const operation = this.commandTail.then(async () => {
      const current = this._settings();
      if (capturedMode !== this._mode() || !this._can(actor.id, 'search') || !current.enabled || this.paused || this.closed || current.prefix.toLocaleLowerCase('pt-BR') !== prefix || !this._commandLocation(ctx, current, own)) return reject('authorization_or_settings_changed');
      const claim = this.store.claimSearchRun({ id: randomUUID(), traceId, chatId: ctx.chatId, messageId: ctx.messageId, actorId: actor.id, requestedAt: this.now(), originalAt: timestamp, source: own ? 'whatsapp-self' : ctx.isGroup ? 'whatsapp-group' : 'whatsapp-private', query: text.slice(prefix.length).trim(), status: 'queued', storageMode: capturedMode });
      if (!claim.claimed) return reject('duplicate_message');
      const run = claim.run; this._trace(traceId, 'parsed', { actorId: actor.id });
      if (!this._consumeRate(actor.id)) { this.store.saveSearchRun({ ...run, status: 'rate_limited', resultCount: 0, completedAt: this.now() }); this._trace(traceId, 'failure', { actorId: actor.id, code: 'SEARCH_RATE_LIMIT' }); await this._queueFailureNotice(run, ctx, Object.assign(new Error(), { code: 'SEARCH_RATE_LIMIT' })); return false; }
      try { await this._execute(run.query, {}, actor.id, { run, context: ctx, deliver: true, rateChecked: true }); }
      catch (error) { await this._queueFailureNotice(run, ctx, error); }
      return true;
    }).finally(() => { this.waitingCommands--; }); this.commandTail = operation.catch(() => {}); return operation;
  }
  _mode() { return this.store.getStorageMode?.() || (this.store.getSetting('integrationMode', 'simulated') === 'whatsapp' ? 'whatsapp' : 'simulated'); }
  _modeMatches(ctx) { return typeof ctx?.simulation !== 'boolean' || ctx.simulation === (this._mode() === 'simulated'); }
  _consumeRate(actorId) { const policy = this._settings().userRateLimit, now = this.now(), entry = this.rateLimits.get(actorId); const entries = entry && entry.startedAt > now - policy.windowSeconds * 1000 ? entry : { startedAt: now, count: 0 }; if (entries.count >= policy.max) return false; entries.count++; this.rateLimits.set(actorId, entries); if (this.rateLimits.size > 1000) for (const [id, item] of this.rateLimits) if (item.startedAt < now - 3600_000) this.rateLimits.delete(id); return true; }
  async executeSearch(payload, actorId, options = {}) { this._assert(actorId, 'search'); if (!this._settings().enabled) fail('Ative BUSCAS antes de pesquisar.', 'SEARCH_DISABLED'); if (!payload || !boundedText(payload.query, 500)) fail('Informe uma busca de até 500 caracteres.'); const filters = validateFilters(payload.filters || {}); if (!this._consumeRate(actorId)) fail('Limite de buscas atingido. Aguarde e tente novamente.', 'SEARCH_RATE_LIMIT'); return this._execute(payload.query.trim(), filters, actorId, { deliver: options.deliver === true, asyncDelivery: options.asyncDelivery === true }); }
  async _execute(query, filters, actorId, options) {
    this._assert(actorId, 'search'); const settings = this._settings();
    const run = options.run || { id: randomUUID(), traceId: randomUUID(), actorId, query, requestedAt: this.now(), source: 'application', chatId: null, messageId: null, status: 'queued', storageMode: this._mode() };
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
    const answer = { runId: run.id, traceId: run.traceId || run.id, query, results, count: results.length, period, order: settings.sort, timezone: settings.timezone, stale, warnings, guidance, filters: parsedFilters, delivery: [] };
    this.store.saveSearchRun({ ...run, query, status: 'completed', resultCount: results.length, resultOfferIds: results.map(o => o.id), filters: parsedFilters, period, warnings, completedAt: this.now() });
    this._trace(run.traceId || run.id, 'results', { actorId, resultCount: results.length });
    this._audit('search.executed', actorId, { runId: run.id, source: run.source, resultCount: results.length });
    if (options.deliver) {
      const targets = this._targets(settings, actorId, options.context); const chunks = formatSearchResults(answer, settings);
      if (!targets.length) fail('Nenhum destinatário autorizado com telefone válido está configurado.', 'SEARCH_RECIPIENT_MISSING');
      for (const target of targets) for (const [index, text] of chunks.entries()) this._queueDelivery({ id: `${run.id}:${hash(target).slice(0, 16)}:${index}`, run, actorId, target, text, recipientMode: settings.recipientMode, context: options.context });
      if (options.asyncDelivery) void this.flushDeliveries().catch(error => this._diagnostic('SEARCH_DELIVERY_PUMP_ERROR', this._safeError(error), error)); else await this.flushDeliveries(); answer.delivery = page(this.store.listSearchDeliveries({ runId: run.id, limit: 100 }));
    }
    this.emit('change'); return answer;
    } catch (error) { this.store.saveSearchRun({ ...this.store.getSearchRun(run.id), status: 'failed', code: error.code || 'SEARCH_QUERY_ERROR', error: this._safeError(error), completedAt: this.now() }); this._trace(run.traceId || run.id, 'failure', { actorId, code: error.code || 'SEARCH_QUERY_ERROR', reason: this._safeError(error) }); this._diagnostic(error.code || 'SEARCH_QUERY_ERROR', this._safeError(error), error); this.emit('change'); throw error; }
  }
  _queueDelivery({ id, run, actorId, target, text, recipientMode, context, recipientId, test = false, errorNotice = false }) {
    const clientMessageId = `KENNED-SEARCH-${randomUUID()}`;
    this._trace(run.traceId || run.id, 'recipient', { actorId, target, recipientId });
    const delivery = this.store.saveSearchDelivery({ id, runId: run.id, traceId: run.traceId || run.id, actorId, target, recipientId: recipientId || null, text, clientMessageId, messageId: clientMessageId, recipientMode, status: 'pending', attempts: 0, createdAt: this.now(), sourceChatId: context?.chatId || null, sourceIsGroup: context?.isGroup === true, sourceSenderNumber: context?.senderNumber || null, sourceTrustedSelf: context?.sourceTrustedSelf === true || this._trustedSelf(context), sourceSelfChat: context?.selfChat === true, test, errorNotice, storageMode: this._mode(), simulation: this._mode() === 'simulated' });
    this._trace(delivery.traceId, 'queued', { actorId, deliveryId: delivery.id, target, status: 'pending' }); return delivery;
  }
  async _queueFailureNotice(run, context, error, { deferFlush = false } = {}) {
    if (!run || !this._can(run.actorId, 'search') || this.closed || !phone(context?.senderNumber) || this.store.getSearchDelivery(`${run.id}:error-notice`)) return;
    try {
      this._queueDelivery({ id: `${run.id}:error-notice`, run, actorId: run.actorId, target: `${context.senderNumber}@s.whatsapp.net`, text: `⚠️ Kenned Code Disparos: ${this._safeError(error)}.\nConsulte BUSCAS e Diagnóstico no aplicativo.\nRastreamento: ${run.traceId || run.id}`, recipientMode: 'error-notice', context, errorNotice: true });
      if (!deferFlush) await this.flushDeliveries();
    } catch (noticeError) { this._trace(run.traceId || run.id, 'failure', { actorId: run.actorId, code: 'SEARCH_FAILURE_NOTICE_ERROR', reason: this._safeError(noticeError) }); }
  }
  _recipientById(id) { if (typeof id !== 'string') return null; if (id.startsWith('user:')) { const u = this._user(id.slice(5)); return u && phone(u.phone); } const r = this.store.getAlertRecipient?.(id) || this.store.getEntity('alert_recipients', id); return r?.enabled !== false && phone(r?.phone); }
  _targets(settings, actorId, ctx) {
    if (settings.recipientMode === 'origin') { if (!settings.allowOriginReplies || !ctx || !this._commandLocation(ctx, settings, ctx.sourceTrustedSelf === true || this._trustedSelf(ctx))) return []; return [ctx.chatId]; }
    if (settings.recipientMode === 'requester') { const user = this._assert(actorId, 'search'), sourceNumber = phone(ctx?.senderNumber); const number = sourceNumber && this.authService.findAuthorizedPhone(sourceNumber)?.id === actorId ? sourceNumber : phone(user.phone); return number ? [`${number}@s.whatsapp.net`] : []; }
    if (settings.recipientMode === 'responsibles') { const numbers = settings.responsibleRecipientIds.map(id => this._recipientById(id)); if (numbers.some(n => !n)) fail('Um responsável selecionado não tem telefone válido ou está desativado.', 'SEARCH_RECIPIENT_MISSING'); return [...new Set(numbers.map(n => `${n}@s.whatsapp.net`))]; }
    let owner = settings.ownerRecipientUserId ? this._user(settings.ownerRecipientUserId) : this.store.listEntities('users').map(u => this._user(u.id)).find(u => u?.isOwner && phone(u.phone));
    if (settings.ownerRecipientUserId && (!owner?.isOwner || !phone(owner.phone))) fail('O dono selecionado está inativo ou sem telefone válido.', 'SEARCH_OWNER_RECIPIENT_INVALID');
    return owner && phone(owner.phone) ? [`${owner.phone}@s.whatsapp.net`] : [];
  }
  _deliveryView(delivery) { if (!delivery) return null; const { id, runId, traceId, recipientId, target, resolvedTarget, status, attempts, createdAt, submittedAt, resultAt, error, code, deliveredAt, readAt, confirmationScope, safeToRetry, test, errorNotice, simulation } = delivery; return { id, runId, traceId, recipientId, target, resolvedTarget, status, attempts, createdAt, submittedAt, resultAt, error, code, deliveredAt, readAt, confirmationScope, safeToRetry, test, errorNotice, simulation }; }
  getRecipientStatus(actorId) {
    this._assert(actorId, 'manage');
    const settings = this._settings(), selected = settings.recipientMode === 'responsibles' ? settings.responsibleRecipientIds : settings.recipientMode === 'owner' ? (settings.ownerRecipientUserId ? [`user:${settings.ownerRecipientUserId}`] : this.store.listEntities('users').filter(u => this._user(u.id)?.isOwner && phone(u.phone)).slice(0, 1).map(u => `user:${u.id}`)) : settings.recipientMode === 'requester' ? [`user:${actorId}`] : [];
    const records = [...this.store.listEntities('users').filter(u => u.active !== false).map(u => ({ id: `user:${u.id}`, name: u.name, phone: phone(u.phone), userId: u.id })), ...this.store.listEntities('alert_recipients').map(r => ({ id: r.id, name: r.name, phone: phone(r.phone), enabled: r.enabled !== false }))];
    const recent = page(this.store.listSearchDeliveries({ limit: 500, order: 'recent' }));
    const recipients = records.map(record => { const target = record.phone && `${record.phone}@s.whatsapp.net`, deliveries = recent.filter(d => !d.errorNotice && (d.recipientId === record.id || target && d.target === target)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 5).map(d => this._deliveryView(d)), latest = deliveries[0]; return { ...record, label: record.name, selected: selected.includes(record.id), configured: selected.includes(record.id), status: latest?.status || 'not_tested', error: latest?.error || (!record.phone ? 'Cadastre telefone com código do país e DDD.' : null), deliveredAt: latest?.deliveredAt, confirmationScope: latest?.confirmationScope, deliveryId: latest?.id, jid: latest?.resolvedTarget || target || null, isSelf: !!record.phone && record.phone === this.adapter?.status?.ownNumber, deliveries }; });
    return { mode: this._mode(), recipients, items: recipients, total: records.length, deliveries: { items: recent.sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map(d => this._deliveryView(d)), total: this.store.listSearchDeliveries({ limit: 0 }).total } };
  }
  async testRecipient(payload, actorId) {
    this._assert(actorId, 'manage'); const recipientId = payload?.recipientId;
    const number = this._recipientById(recipientId); if (!number) fail('Selecione um destinatário ativo com telefone válido, incluindo código do país e DDD.', 'SEARCH_RECIPIENT_MISSING');
    const run = this.store.saveSearchRun({ id: randomUUID(), traceId: randomUUID(), actorId, requestedAt: this.now(), source: 'recipient-test', query: '', status: 'completed', resultCount: 0, completedAt: this.now(), storageMode: this._mode() });
    const delivery = this._queueDelivery({ id: `${run.id}:test`, run, actorId, target: `${number}@s.whatsapp.net`, text: `✅ Kenned Code Disparos — teste de envio dos resultados de BUSCAS.\nHorário: ${new Date(this.now()).toLocaleString('pt-BR', { timeZone: this._settings().timezone })}\nRastreamento: ${run.traceId}\nEste teste usa a fila e a confirmação da integração.`, recipientMode: 'test', recipientId, test: true });
    void this.flushDeliveries().catch(error => this._diagnostic('SEARCH_DELIVERY_PUMP_ERROR', this._safeError(error), error)); this.emit('change'); return this._deliveryView(this.store.getSearchDelivery(delivery.id));
  }
  async retryDelivery(payload, actorId) {
    const delivery = this.store.getSearchDelivery(payload?.id); if (!delivery) fail('Entrega não encontrada.');
    this._assert(actorId, delivery.test ? 'manage' : 'search'); if (!this._user(actorId)?.isOwner && delivery.actorId !== actorId) fail('Você não pode repetir uma entrega solicitada por outro usuário.', 'SEARCH_DENIED');
    if (!['failed', 'pending'].includes(delivery.status) || delivery.status === 'failed' && delivery.safeToRetry !== true) fail('Somente falhas comprovadamente anteriores ao envio podem ser repetidas. Resultados incertos precisam de revisão.', 'SEARCH_RETRY_UNSAFE');
    this.store.updateSearchDelivery(delivery.id, { status: 'pending', nextAttemptAt: 0, attempts: 0, resultAt: null, code: null, error: null }); this._trace(delivery.traceId || delivery.runId, 'retry', { actorId, deliveryId: delivery.id }); await this.flushDeliveries(); this.emit('change'); return this._deliveryView(this.store.getSearchDelivery(delivery.id));
  }
  _deliveryAuthorized(delivery) {
    if (delivery.storageMode && delivery.storageMode !== this._mode() || !this._can(delivery.actorId, delivery.test ? 'manage' : 'search')) return false;
    const currentSettings = this._settings();
    if (delivery.test) return `${this._recipientById(delivery.recipientId)}@s.whatsapp.net` === delivery.target;
    if (!currentSettings.enabled) return false;
    if (delivery.errorNotice) return this._commandLocation({ chatId: delivery.sourceChatId, isGroup: delivery.sourceIsGroup, senderNumber: delivery.sourceSenderNumber, selfChat: delivery.sourceSelfChat }, currentSettings, delivery.sourceTrustedSelf) && `${delivery.sourceSenderNumber}@s.whatsapp.net` === delivery.target;
    return this._targets(currentSettings, delivery.actorId, delivery.sourceChatId ? { chatId: delivery.sourceChatId, isGroup: delivery.sourceIsGroup, senderNumber: delivery.sourceSenderNumber, sourceTrustedSelf: delivery.sourceTrustedSelf, selfChat: delivery.sourceSelfChat } : null).includes(delivery.target);
  }
  flushDeliveries() { if (this.deliveryPump) return this.deliveryPump; if (this.closed || this.paused || this.adapter?.status?.state !== 'connected' || this.store.persistenceFailed) return Promise.resolve(); this.deliveryPump = (this.scheduler?.runExternalSubmission ? this.scheduler.runExternalSubmission(() => this._flushDeliveries()) : this._flushDeliveries()).finally(() => { this.deliveryPump = null; if (!this.closed && !this.paused && this.adapter?.status?.state === 'connected' && !this.store.persistenceFailed && page(this.store.listSearchDeliveries({ status: 'pending', dueAt: this.now(), limit: 1 })).length) queueMicrotask(() => { void this.flushDeliveries().catch(error => this._diagnostic('SEARCH_DELIVERY_PUMP_ERROR', this._safeError(error), error)); }); }); return this.deliveryPump; }
  async _flushDeliveries() {
    const release = this.scheduler?.holdSubmissions?.() || (() => {}); try { await this.scheduler?.waitForIdle?.();
      const pending = page(this.store.listSearchDeliveries({ status: 'pending', limit: 100 }));
      for (const delivery of pending) {
        if (this.closed || this.adapter?.status?.state !== 'connected') break;
        if (delivery.nextAttemptAt > this.now()) continue;
        if (!this._can(delivery.actorId, delivery.test ? 'manage' : 'search')) { this.store.updateSearchDelivery(delivery.id, { status: 'failed', resultAt: this.now(), code: 'SEARCH_DENIED', safeToRetry: true, error: 'A autorização do solicitante foi removida.' }); continue; }
        let authorizedTarget = false;
        try { authorizedTarget = this._deliveryAuthorized(delivery); }
        catch (error) { this._trace(delivery.traceId || delivery.runId, 'failure', { actorId: delivery.actorId, code: error.code, reason: this._safeError(error) }); }
        if (!authorizedTarget) { this.store.updateSearchDelivery(delivery.id, { status: 'failed', resultAt: this.now(), code: 'SEARCH_TARGET_DISABLED', safeToRetry: true, error: 'O destino da entrega deixou de estar habilitado.' }); continue; }
        const minimum = Math.max(3, this.adapter.minimumSpacingSeconds || 3) * 1000, previous = this.scheduler?.lastSubmissionAt;
        if (previous != null) await this.sleep(Math.max(0, minimum - (this.now() - previous)));
        if (this.closed || this.adapter?.status?.state !== 'connected') break;
        const attempt = (delivery.attempts || 0) + 1;
        try {
          const number = phone(delivery.target?.match(/^(\d+)@s\.whatsapp\.net$/)?.[1]);
          const sendingAdapter = this.adapter, sendingMode = this._mode();
          const resolved = number && sendingAdapter.resolveRecipient ? await sendingAdapter.resolveRecipient(number) : { jid: delivery.target };
          if (!resolved?.jid) fail('Não foi possível resolver o destinatário.', 'SEARCH_RECIPIENT_MISSING');
          if (this.closed || this.paused || this.adapter?.status?.state !== 'connected') break;
          if (this.adapter !== sendingAdapter || this._mode() !== sendingMode || !this._deliveryAuthorized(delivery)) fail('A autorização ou o destinatário mudou durante a preparação. Nenhuma mensagem foi enviada.', 'SEARCH_TARGET_DISABLED');
          this.store.updateSearchDelivery(delivery.id, { status: 'sending', attempts: attempt, submittedAt: this.now(), resolvedTarget: resolved.jid });
          this._trace(delivery.traceId || delivery.runId, 'recipient', { actorId: delivery.actorId, target: resolved.jid, deliveryId: delivery.id });
          if (this.scheduler) this.scheduler.lastSubmissionAt = this.now(); this._trace(delivery.traceId || delivery.runId, 'submitted', { actorId: delivery.actorId, deliveryId: delivery.id, attempts: attempt });
          const result = await this.adapter.sendSearchText(resolved.jid, delivery.text, { clientMessageId: delivery.clientMessageId });
          const current = this.store.getSearchDelivery(delivery.id); const confirmed = current?.status === 'confirmed' || result?.status === 'confirmed';
          this.store.updateSearchDelivery(delivery.id, { status: confirmed ? 'confirmed' : 'uncertain', resultAt: this.now(), messageId: result?.messageId || delivery.clientMessageId, confirmationScope: result?.confirmationScope || current?.confirmationScope || (confirmed ? 'integration-ack' : null), deliveredAt: result?.deliveredAt || current?.deliveredAt || null, readAt: result?.readAt || current?.readAt || null, code: confirmed ? null : 'SEARCH_RESULT_UNCERTAIN', safeToRetry: false, error: confirmed ? null : 'Envio sem confirmação; revisar antes de repetir.' });
          this._trace(delivery.traceId || delivery.runId, 'integration', { actorId: delivery.actorId, deliveryId: delivery.id, status: confirmed ? 'confirmed' : 'uncertain', confirmationScope: result?.confirmationScope, attempts: attempt });
        } catch (error) { const current = this.store.getSearchDelivery(delivery.id), submitted = current?.status === 'sending', safe = !submitted || error?.safeToRetry === true || error?.definitive === true, temporary = error?.safeToRetry === true, status = safe && temporary && attempt < 3 ? 'pending' : safe ? 'failed' : 'uncertain'; this.store.updateSearchDelivery(delivery.id, { status, attempts: attempt, nextAttemptAt: this.now() + 15_000, resultAt: status === 'pending' ? null : this.now(), code: error?.code || 'SEARCH_DELIVERY_ERROR', safeToRetry: safe, error: status === 'uncertain' ? 'Resultado incerto. Revisão necessária antes de repetir.' : this._safeError(error) }); this._trace(delivery.traceId || delivery.runId, 'integration', { actorId: delivery.actorId, deliveryId: delivery.id, status, code: error?.code || 'SEARCH_DELIVERY_ERROR', reason: this._safeError(error), attempts: attempt }); this._diagnostic(error?.code || 'SEARCH_DELIVERY_ERROR', this._safeError(error), error);
          if (['failed', 'uncertain'].includes(status) && delivery.sourceChatId && !delivery.errorNotice && !delivery.test) await this._queueFailureNotice(this.store.getSearchRun(delivery.runId), { chatId: delivery.sourceChatId, isGroup: delivery.sourceIsGroup, senderNumber: delivery.sourceSenderNumber, sourceTrustedSelf: delivery.sourceTrustedSelf, selfChat: delivery.sourceSelfChat }, status === 'uncertain' ? { code: 'SEARCH_RESULT_UNCERTAIN' } : error, { deferFlush: true });
        }
        this.emit('change');
      }
    } finally { release(); }
  }
  _receipt(receipt) { if (receipt?.status !== 'confirmed' || !receipt.messageId || !this._modeMatches(receipt)) return; for (const d of page(this.store.listSearchDeliveries({ messageId: receipt.messageId, limit: 100 }))) if ([d.messageId, d.clientMessageId].includes(receipt.messageId) && ['sending', 'uncertain', 'confirmed'].includes(d.status)) { this.store.updateSearchDelivery(d.id, { status: 'confirmed', resultAt: d.resultAt || this.now(), error: null, code: null, safeToRetry: false, confirmationScope: receipt.confirmationScope || d.confirmationScope || 'integration-ack', deliveredAt: receipt.deliveredAt || d.deliveredAt || null, readAt: receipt.readAt || d.readAt || null }); this._trace(d.traceId || d.runId, 'integration', { deliveryId: d.id, status: 'confirmed', confirmationScope: receipt.confirmationScope }); } }
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
