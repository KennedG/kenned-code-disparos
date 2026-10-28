'use strict';

const { EventEmitter } = require('node:events');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { generateSearchExcel } = require('./search-excel.cjs');

const DEFAULT_SEARCH_SETTINGS = Object.freeze({ enabled: false, prefix: '!busca', maxResults: 10,
  timezone: 'America/Sao_Paulo', monitoredGroupIds: [], commandGroupIds: [], privateCommandsEnabled: true,
  commandPrivateNumbers: [], maxAgeEnabled: true, maxAgeValue: 2, maxAgeUnit: 'hours', validityHours: 24, customFrom: '', customTo: '', retentionDays: 30,
  aliases: { colors: { prata: 'silver' }, models: {} }, defaultFilters: {},
  blockedSupplierIds: [], blockedGroupIds: [], onePerSupplier: false, sort: 'cashAscending', priceCriterion: 'cash',
  recipientMode: 'owner', ownerRecipientUserId: null, responsibleRecipientIds: [], allowOriginReplies: false, selfCommandsEnabled: true,
  importHistory: false, userRateLimit: { max: 10, windowSeconds: 60 } });
const PERMISSIONS = { search: 'search.run', history: 'search.history', filters: 'search.filters', manage: 'search.manage', view: 'search.view' };
const { normalizePhone:phone } = require('./phone.cjs');
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
    else if (['model', 'modelKey', 'color', 'colorKey', 'condition', 'supplier', 'supplierKey', 'warranty', 'groupId'].includes(key)) { if (!boundedText(value, 256)) fail(`Filtro ${key} inválido.`); output[key] = value.trim(); }
    else if (key === 'groupIds') output[key] = strings(value);
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
  for (const name of ['enabled', 'privateCommandsEnabled', 'onePerSupplier', 'allowOriginReplies', 'importHistory', 'selfCommandsEnabled', 'maxAgeEnabled']) {
    if (input[name] !== undefined) { if (typeof input[name] !== 'boolean') fail(`Opção ${name} inválida.`); settings[name] = input[name]; }
  }
  for (const name of ['monitoredGroupIds', 'commandGroupIds', 'commandPrivateNumbers', 'blockedSupplierIds', 'blockedGroupIds', 'responsibleRecipientIds']) if (input[name] !== undefined) settings[name] = strings(input[name]);
  settings.blockedSupplierIds = [...new Set(settings.blockedSupplierIds.map(id => { const digits = id.replace(/[\s()+-]/g, ''); return phone(digits) ? `phone:${digits}` : id; }))];
  if (settings.commandPrivateNumbers.some(x => !phone(x))) fail('Conversas privadas exigem telefone real com código do país e DDD.');
  if (input.prefix !== undefined) { if (typeof input.prefix !== 'string' || !/^![\p{L}\p{N}_-]{1,31}$/u.test(input.prefix)) fail('O prefixo deve começar com ! e conter até 31 letras, números, _ ou -.'); settings.prefix = input.prefix; }
  if (input.maxResults !== undefined) settings.maxResults = safeNumber(input.maxResults, 1, 10, 'Quantidade de resultados');
  if (input.validityHours !== undefined) settings.validityHours = safeNumber(input.validityHours, 1, 8760, 'Validade em horas');
  if (input.maxAgeValue !== undefined) settings.maxAgeValue = safeNumber(input.maxAgeValue, 1, 525600, 'Idade máxima da oferta');
  if (input.maxAgeUnit !== undefined) { if (!['minutes', 'hours'].includes(input.maxAgeUnit)) fail('Unidade da idade máxima inválida.'); settings.maxAgeUnit = input.maxAgeUnit; }
  if (settings.maxAgeValue * (settings.maxAgeUnit === 'hours' ? 60 : 1) > 525600) fail('A idade máxima não pode exceder 365 dias.');
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
  constructor({ store, adapter, authService, scheduler, now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), automationGuard = () => true, mediaManager }) {
    super(); Object.assign(this, { store, adapter, authService, scheduler, now, sleep, automationGuard });
    this.mediaManager = mediaManager || new (require('./media.cjs').MediaManager)(store); this.listPreviews = new Map();
    this.started = false; this.closed = false; this.paused = false; this.capturePump = null; this.deliveryPump = null;
    this.waitingCommands = 0; this.commandTail = Promise.resolve(); this.rateLimits = new Map(); this.cleanupTokens = new Map();
    this.monitor = store.getSetting('buscasMonitor', { startedAt: null, lastCaptureAt: null, lastSyncAt: null, lastHeartbeatAt: null, openGap: null });
    this.groups = new Map(store.listGroups().map(group => [group.id, group]));
    this.listeners = {
      offerMessage: ctx => { void this.handleIncoming(ctx).catch(e => this._diagnostic('SEARCH_RECEIVE_ERROR', 'Falha ao processar uma mensagem de BUSCAS.', e)); },
      offerMessageUpdate: ctx => { this._enqueue(ctx, 'update'); },
      offerMessageDelete: ctx => { this._enqueue(ctx, 'delete'); },
      offerHistory: batch => { this._captureHistory(batch); },
      captureError: error => { this._captureFailure(error); },
      status: status => { this._onStatus(status); },
      receipt: receipt => { this._receipt(receipt); }
    };
  }
  setAutomationGuard(guard) { if (typeof guard !== 'function') throw new TypeError('Controle de automação inválido.'); this.automationGuard = guard; }
  _automationAllowed() { return this.automationGuard() !== false; }
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
    const descriptions = { received: 'Comando recebido.', authorization: 'Autorização do comando verificada.', parsed: 'Comando interpretado.', results: 'Consulta de ofertas concluída.', recipient: 'Destinatário da busca definido.', queued: 'Resposta colocada na fila persistente.', submitted: 'Resposta submetida à integração.', integration: 'Resultado da integração recebido.', rejected: 'Comando ignorado.', failure: 'Falha no processamento da busca.', retry: 'Nova tentativa de entrega solicitada.', export: 'Geração do arquivo Excel.' };
    const explanations = { conversation_not_enabled: 'Comando privado bloqueado pelas configurações de conversas habilitadas. Confira BUSCAS → Configurações: aceitar comandos privados e a lista opcional de números.', sender_not_authorized: 'O número real do remetente não possui autorização de busca e permissões correspondentes.', sender_identity_unavailable: 'O WhatsApp não forneceu identidade e telefone confiáveis suficientes para autorizar o comando.', module_disabled_or_paused: 'O módulo BUSCAS está desativado ou pausado.', old_or_missing_timestamp: 'O comando é antigo ou não possui data original confiável; foi ignorado para evitar repetição.', duplicate_message: 'Este comando já foi processado; nenhuma resposta duplicada foi criada.' };
    this.store.addDiagnostic?.({ id: randomUUID(), at: this.now(), traceId, stage: `buscas.${stage}`, code: details.code || `SEARCH_${stage.toUpperCase()}`, description: details.explanation && boundedText(details.explanation, 512) ? details.explanation : explanations[details.reason] || descriptions[stage] || 'Etapa do processamento de BUSCAS.', actorId: details.actorId || null, level: ['failure'].includes(stage) || details.status === 'failed' || details.status === 'uncertain' ? 'error' : stage === 'rejected' ? 'warning' : 'info', action: details.action || 'Consulte o histórico de BUSCAS para acompanhar a entrega.', attempts: details.attempts || 0, detail: Object.fromEntries(Object.entries(details).filter(([key]) => ['reason', 'approved', 'resultCount', 'deliveryId', 'recipientId', 'target', 'status', 'messageId', 'source', 'confirmationScope'].includes(key))) });
  }
  _safeError(error) {
    const messages = { SUBMISSION_TIMEOUT: 'Tempo limite excedido; confira o histórico antes de repetir o envio', SUBMISSION_ABORTED: 'A tentativa foi interrompida antes da submissão', SEARCH_RECIPIENT_MISSING: 'Nenhum destinatário válido está configurado', SEARCH_OWNER_RECIPIENT_INVALID: 'O dono selecionado está inativo ou sem telefone válido', SEARCH_RATE_LIMIT: 'Limite de buscas atingido; aguarde antes de tentar novamente', SEARCH_DENIED: 'A autorização para buscar foi removida', SEARCH_DISABLED: 'O módulo BUSCAS está desativado', SEARCH_MODE_CHANGED: 'O modo de operação mudou durante a busca; pesquise novamente', RECIPIENT_NOT_REGISTERED: 'O destinatário não foi encontrado no WhatsApp', PRIVATE_RECIPIENT_INVALID: 'Telefone do destinatário inválido; confira código do país e DDD', DISCONNECTED: 'O WhatsApp está desconectado', SEARCH_TARGET_DISABLED: 'O destinatário ou a autorização mudou antes do envio; nenhuma mensagem foi enviada', SEARCH_RESULT_UNCERTAIN: 'Não foi possível confirmar a entrega; revise o histórico antes de repetir', AUTOMATION_STOPPED: 'Os envios automáticos foram interrompidos; retome explicitamente para enviar novamente', WA_MEDIA_MISSING: 'O documento da biblioteca não está disponível; gere o Excel novamente', WA_MEDIA_INVALID: 'O arquivo gerenciado não é um documento válido', WA_MEDIA_READ: 'Não foi possível ler o documento gerenciado; confira acesso à pasta de dados', WA_MEDIA_CHANGED: 'O arquivo gerenciado foi alterado; gere o Excel novamente antes de enviar', WA_MEDIA_SIZE: 'O documento está vazio ou excede o limite de 64 MB', WA_MEDIA_PATH: 'O documento não pertence à pasta gerenciada; gere o Excel novamente', WA_CAPTION_INVALID: 'A legenda do documento excede o tamanho permitido', SEARCH_INVALID: 'Os filtros ou a configuração da busca são inválidos' };
    Object.assign(messages, { WA_RECIPIENT_INVALID: 'Telefone inválido; confira código do país, DDD e número', WA_RECIPIENT_OFFLINE: 'O WhatsApp está desconectado; o envio permanece pendente', WA_RECIPIENT_NOT_FOUND: 'O número configurado não foi encontrado no WhatsApp', WA_RECIPIENT_AMBIGUOUS: 'O WhatsApp retornou mais de um destinatário; revise o telefone', WA_RECIPIENT_MISMATCH: 'O telefone resolvido difere do cadastrado; revise o destinatário', WA_RECIPIENT_INVALID_JID: 'O WhatsApp retornou um identificador de destinatário inválido', WA_RECIPIENT_NUMBER_UNAVAILABLE: 'Cadastre o telefone real do destinatário com código do país e DDD', WA_RECIPIENT_UNSUPPORTED: 'A integração instalada não disponibiliza a validação do destinatário; atualize o aplicativo', WA_RECIPIENT_TIMEOUT: 'O WhatsApp não respondeu à validação do telefone; será feita uma tentativa limitada', WA_RECIPIENT_CONNECTION_CHANGED: 'A conexão mudou durante a validação; nenhuma mensagem foi enviada', WA_RECIPIENT_LOOKUP_INCOMPLETE: 'O WhatsApp não confirmou o destinatário; nenhuma mensagem foi enviada', WA_RECIPIENT_LOOKUP_TEMPORARY: 'Falha temporária na validação do telefone; será feita uma tentativa limitada', WA_RECIPIENT_LOOKUP_REJECTED: 'O WhatsApp recusou a validação do telefone; verifique a conexão e restrições', WA_RECIPIENT_BUSY: 'A fila de validação de destinatários está ocupada; aguarde uma nova tentativa', WA_REPLY_CONTEXT_INVALID: 'A conversa não possui prova válida do comando privado; envie o comando novamente pela conversa autorizada', WA_REPLY_RECIPIENT_MISMATCH: 'O destino da resposta difere do remetente autenticado; nenhuma mensagem foi enviada' });
    return messages[error?.code] || 'Não foi possível concluir a busca ou confirmar sua entrega';
  }
  _persistMonitor() { this.store.setSetting('buscasMonitor', this.monitor); }
  _captureFailure(error = {}) {
    this.monitor.lastError = { at: error.at || this.now(), code: String(error.code || 'SEARCH_CAPTURE_ERROR').slice(0, 80),
      message: typeof error.detail === 'string' ? error.detail.slice(0, 512) : 'Falha na captura. Verifique a conexão, os grupos e os registros.' };
    this._persistMonitor(); this._diagnostic(this.monitor.lastError.code, this.monitor.lastError.message); this.emit('change');
  }
  _openGap(reason, at = this.now()) { if (!this.monitor.openGap) this.monitor.openGap = { id: randomUUID(), startedAt: at, reason }; this._persistMonitor(); }
  _closeGap(at = this.now()) { if (!this.monitor.openGap) return; this.store.recordSearchGap?.({ ...this.monitor.openGap, endedAt: at, complete: false }); this.monitor.openGap = null; this._persistMonitor(); }
  _attach(adapter) { for (const [name, listener] of Object.entries(this.listeners)) adapter?.on(name, listener); }
  _detach(adapter) { for (const [name, listener] of Object.entries(this.listeners)) adapter?.off(name, listener); }
  _configure() { const s = this._settings(); this.groups = new Map(this.store.listGroups().map(group => [group.id, group])); this.adapter?.configureSearchCapture?.({ enabled: s.enabled && !this.paused, importHistory: s.importHistory, groupIds: s.monitoredGroupIds, commandGroupIds: s.commandGroupIds, commandPrefix: s.prefix }); }
  refreshGroups() { this._configure(); this.emit('change'); }
  start() {
    if (this.started || this.closed) return; this.started = true; this._attach(this.adapter);
    const s = this._settings(); if (s.enabled && this.monitor.lastHeartbeatAt && this.now() > this.monitor.lastHeartbeatAt + 1000) this.store.recordSearchGap?.({ id: randomUUID(), startedAt: this.monitor.lastHeartbeatAt, endedAt: this.now(), reason: 'application_not_running', complete: false });
    if (s.enabled && !this.monitor.startedAt) this.monitor.startedAt = this.now();
    this.monitor.lastHeartbeatAt = this.now(); this._persistMonitor();
    let interrupted; do { interrupted = page(this.store.listSearchDeliveries?.({ status: 'sending', limit: 500 })); for (const delivery of interrupted) this.store.updateSearchDelivery(delivery.id, { status: 'uncertain', resultAt: this.now(), code: 'SEARCH_RESTART_UNCERTAIN', safeToRetry: false, error: 'Envio interrompido; revisão necessária antes de repetir.' }); } while (interrupted.length);
    this._configure(); this._onStatus(this.adapter?.status || { state: 'disconnected' }); this._drain();
    this.timer = setInterval(() => { if (this.closed) return; try { this.monitor.lastHeartbeatAt = this.now(); this._persistMonitor(); this.store.applySearchRetention?.({ days: this._settings().retentionDays, at: this.now() }); this._drain(); this._flushInBackground(); } catch (e) { this._diagnostic('SEARCH_MAINTENANCE_ERROR', 'Falha na manutenção da captura.', e); } }, 30_000); this.timer.unref?.();
  }
  async shutdown() { if (this.closed) return; this.closed = true; clearInterval(this.timer); this._detach(this.adapter); await this.capturePump?.catch(() => {}); await this.commandTail.catch(() => {}); await this.deliveryPump?.catch(() => {}); this.monitor.lastHeartbeatAt = this.now(); this._persistMonitor(); }
  setAdapter(adapter) { this._detach(this.adapter); this.adapter = adapter; this.monitor = this.store.getSetting('buscasMonitor', { startedAt: null, lastCaptureAt: null, lastSyncAt: null, lastHeartbeatAt: null, openGap: null }); this.rateLimits.clear(); this.cleanupTokens.clear(); this.listPreviews.clear(); if (this.started && !this.closed) this._attach(adapter); this._configure(); this._onStatus(adapter?.status || { state: 'disconnected' }); }
  async suspendCapture(reason = 'maintenance') { this.paused = true; if (this._settings().enabled) this._openGap(reason); this._configure(); await this.capturePump?.catch(() => {}); await this.commandTail.catch(() => {}); await this.deliveryPump?.catch(() => {}); }
  resumeCapture() { this.paused = false; this._configure(); this._onStatus(this.adapter?.status || { state: 'disconnected' }); this._drain(); }
  async _waitCaptureIdle() { while (!this.closed && !this.paused) { const running = this._drain(); if (running) await running; if (!page(this.store.listSearchInbox({ status: 'queued', limit: 1 })).length) break; } }
  async waitForIdle() { await this._waitCaptureIdle(); await this.commandTail; await this._waitCaptureIdle(); do { await this.deliveryPump; if (this.closed || this.scheduler?.closed || this.scheduler?.closing || this.paused || !this._automationAllowed() || this.adapter?.status?.state !== 'connected' || !page(this.store.listSearchDeliveries({ status: 'pending', dueAt: this.now(), limit: 1 })).length) break; await this.flushDeliveries(); } while (!this.closed); }
  _onStatus(status) { if (this.closed || !this._settings().enabled) return; if (status?.state === 'connected' && status.ready !== false && !this.paused) { this._configure(); this._closeGap(); this._drain(); this._flushInBackground(); } else this._openGap(status?.reasonCode || 'disconnected'); this.emit('change'); }
  getState(actorId) {
    this.groups = new Map(this.store.listGroups().map(group => [group.id, group]));
    const permissions = Object.fromEntries(Object.keys(PERMISSIONS).map(p => [p, this._can(actorId, p)]));
    permissions.export = permissions.search && permissions.view; permissions.send = permissions.export && permissions.manage;
    if (!Object.values(permissions).some(Boolean)) return { authorized: false, permissions, enabled: false };
    const settings = this._settings(), stats = this.store.getSearchMonitorStats?.() || {};
    const publicSettings = permissions.manage ? settings : { ...settings, commandPrivateNumbers: [], ownerRecipientUserId: null, responsibleRecipientIds: [], blockedSupplierIds: [] };
    const health = this.adapter?.getCaptureHealth?.(), ready = this.adapter?.status?.state === 'connected' && this.adapter?.status?.ready !== false && health?.readiness?.ready !== false;
    return { authorized: true, permissions, settings: publicSettings, enabled: settings.enabled, monitor: { ...this.monitor, status: !settings.enabled ? 'disabled' : this.paused ? 'paused' : ready ? 'monitoring' : 'disconnected', connection: this.adapter?.status?.state || 'disconnected', ready, complete: false, monitoredGroups: settings.monitoredGroupIds.length, adapterHealth: health?.searches || null, gaps: page(this.store.listSearchGaps?.({ limit: 20 })), queueSize: stats.queued ?? stats.inbox ?? 0, failedCaptures: stats.failedInbox || 0 }, stats,
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
    const keys = Object.keys(input || {}); if (keys.some(k => !['defaultFilters', 'aliases', 'sort', 'maxAgeEnabled', 'maxAgeValue', 'maxAgeUnit'].includes(k))) this._assert(actorId, 'manage'); else this._assert(actorId, 'filters');
    const settings = validateSearchSettings(input, previous);
    const known = new Set(this.store.listGroups().map(g => g.id));
    if ([...settings.monitoredGroupIds, ...settings.commandGroupIds, ...settings.blockedGroupIds, ...(settings.defaultFilters.groupIds || []), ...(settings.defaultFilters.groupId ? [settings.defaultFilters.groupId] : [])].some(id => !known.has(id))) fail('Selecione grupos disponíveis na conta.');
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
        catch (e) { if (this.store.persistenceFailed) throw e; this.store.updateSearchInbox(entry.id, { status: 'failed', code: e.code || 'SEARCH_PARSE_ERROR' }); this._captureFailure({ code: e.code || 'SEARCH_PARSE_ERROR', detail: 'Uma mensagem não pôde ser interpretada. O anúncio não entrou no ranking; outras mensagens continuam sendo processadas.' }); }
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
    const persisted = this.store.upsertSearchMessage(message, offers);
    this.monitor.lastCaptureAt = this.now(); this.monitor.lastOriginalAt = originalAt; this.monitor.lastSyncAt = this.now(); this.monitor.lastError = null;
    const probe = this.monitor.captureProbe;
    if (probe && kind === 'message' && ctx.history !== true && persisted?.inserted === true && probe.expiresAt >= this.now() && originalAt >= probe.startedAt - 1000 && probe.groupIds.includes(ctx.chatId)) {
      this.monitor.captureProbe = { ...probe, status: 'captured', messageId: ctx.messageId, groupId: ctx.chatId, capturedAt: this.now() };
    }
    this._persistMonitor();
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
    return (!settings.commandPrivateNumbers.length || settings.commandPrivateNumbers.includes(phone(ctx.senderNumber))) && (ctx.chatId === `${ctx.senderNumber}@s.whatsapp.net` || /^\d+@lid$/.test(ctx.chatId || '')); 
  }
  async handleIncoming(ctx) {
    if (this.closed) return false; this._enqueue(ctx);
    const settings = this._settings();
    if (!ctx || ctx.dataOnly === true || ctx.type !== 'text' || ctx.forwarded !== false || ctx.history === true || ctx.historical === true || ctx.isHistory === true || ctx.machineGenerated === true || ctx.automaticMessage === true) return false;
    const text = typeof ctx.text === 'string' ? ctx.text.trim() : '', lower = text.toLocaleLowerCase('pt-BR'), prefix = settings.prefix.toLocaleLowerCase('pt-BR');
    if (!lower.startsWith(prefix) || text.length > prefix.length && !/\s/.test(text[prefix.length])) return false;
    const traceId = typeof ctx.traceId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(ctx.traceId) ? ctx.traceId : randomUUID(); this._trace(traceId, 'received', { messageId: ctx.messageId, source: ctx.fromMe ? 'manual-own-account' : 'incoming' });
    const reject = (reason, code, explanation) => { this._trace(traceId, 'rejected', { reason, code, explanation, approved: false }); return false; };
    if (!settings.enabled || this.paused) return reject('module_disabled_or_paused');
    if (!this._modeMatches(ctx)) return reject('integration_mode_mismatch');
    const own = this._trustedSelf(ctx);
    if (ctx.fromMe !== false && !own) return reject('untrusted_own_account_message');
    if (!(ctx.identityVerified === true || ctx.verified === true) || !phone(ctx.senderNumber) || !boundedText(ctx.messageId, 512) || !ctx.messageId) return reject('sender_identity_unavailable');
    const senderResolution = this.authService.resolveWhatsAppActor?.(ctx), actor = senderResolution ? senderResolution.user : this.authService.findAuthorizedPhone(ctx.senderNumber);
    if (!actor) return reject('sender_not_authorized', senderResolution?.code, senderResolution?.reason);
    if (!this._can(actor.id, 'search') || own && !this._user(actor.id)?.isOwner) return reject('sender_not_authorized', 'SEARCH_DENIED');
    if (!this._commandLocation(ctx, settings, own)) return reject('conversation_not_enabled');
    this._trace(traceId, 'authorization', { actorId: actor.id, approved: true });
    const timestamp = milliseconds(ctx.timestamp); if (!timestamp || timestamp < this.now() - 300_000 || timestamp > this.now() + 60_000) return reject('old_or_missing_timestamp');
    if (this.waitingCommands >= 64) return reject('command_queue_full');
    const capturedMode = this._mode(); this.waitingCommands++;
    const operation = this.commandTail.then(async () => {
      const current = this._settings();
      if (capturedMode !== this._mode() || !this._can(actor.id, 'search') || !current.enabled || this.paused || this.closed || current.prefix.toLocaleLowerCase('pt-BR') !== prefix || !this._commandLocation(ctx, current, own)) return reject('authorization_or_settings_changed');
      const claim = this.store.claimSearchRun({ id: randomUUID(), traceId, chatId: ctx.chatId, messageId: ctx.messageId, actorId: actor.id, requestedAt: this.now(), originalAt: timestamp, source: own ? 'whatsapp-self' : ctx.isGroup ? 'whatsapp-group' : 'whatsapp-private', query: parseSearchCommand(text.slice(prefix.length).trim()).query, outputFormat: parseSearchCommand(text.slice(prefix.length).trim()).format, status: 'queued', storageMode: capturedMode });
      if (!claim.claimed) return reject('duplicate_message');
      const run = claim.run; this._trace(traceId, 'parsed', { actorId: actor.id });
      if (!this._consumeRate(actor.id)) { this.store.saveSearchRun({ ...run, status: 'rate_limited', resultCount: 0, completedAt: this.now() }); this._trace(traceId, 'failure', { actorId: actor.id, code: 'SEARCH_RATE_LIMIT' }); await this._queueFailureNotice(run, ctx, Object.assign(new Error(), { code: 'SEARCH_RATE_LIMIT' })); return false; }
      try { await this._execute(run.query, {}, actor.id, { run, context: ctx, deliver: true, outputFormat: run.outputFormat || 'text', rateChecked: true }); }
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
    this._assert(actorId, 'search');
    if (run.storageMode && run.storageMode !== this._mode()) fail('O modo de operação mudou durante a busca. Pesquise novamente no modo atual.', 'SEARCH_MODE_CHANGED');
    const ageMinutes = settings.maxAgeEnabled ? settings.maxAgeValue * (settings.maxAgeUnit === 'hours' ? 60 : 1) : null;
    const ageFrom = ageMinutes === null ? null : this.now() - ageMinutes * 60_000;
    const customFrom = settings.customFrom ? parseZonedTime(settings.customFrom, settings.timezone) : null;
    const period = { from: customFrom === null ? ageFrom : ageFrom === null ? customFrom : Math.max(customFrom, ageFrom), to: settings.customTo ? parseZonedTime(settings.customTo, settings.timezone) : this.now(), maxAgeMinutes: ageMinutes }; 
    const stale = this.adapter?.status?.state !== 'connected' || this.adapter?.getConnectionReadiness?.().ready === false || !!this.monitor.openGap || !!this.monitor.lastError || !settings.monitoredGroupIds.length;
    let results = [], allResults = [], parsedFilters = {}, effectiveFilters = {}, persistedQueryFilters = null, guidance = null;
    if (!query) guidance = `Use ${settings.prefix} iPhone 18 Pro Max 256GB Silver para buscar ofertas capturadas.\nPara Excel: ${settings.prefix} --excel iPhone 15 Pro Max 256GB\nPara texto e Excel: ${settings.prefix} --ambos iPhone 15 Pro Max 256GB`; 
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
        const requestedGroups = effective.groupIds || (effective.groupId ? [effective.groupId] : null);
        queryFilters.groupIds = requestedGroups ? settings.monitoredGroupIds.filter(id => requestedGroups.includes(id)) : settings.monitoredGroupIds;
        delete queryFilters.valid; delete queryFilters.reason; effectiveFilters = effective; persistedQueryFilters = queryFilters;
        allResults = await this._collectMatches(queryFilters, effective, settings, actorId);
        results = allResults.slice(0, settings.maxResults);
      }
    }
    const warnings = ['A base inclui somente mensagens capturadas; o histórico pode conter lacunas.']; if (stale) warnings.unshift('⚠️ Captura desatualizada ou interrompida. Valores podem não refletir anúncios recentes.');
    if (!settings.monitoredGroupIds.length) warnings.push('⚠️ Nenhum grupo monitorado configurado. Selecione os grupos em BUSCAS → Configurações para capturar novas ofertas.');
    if (this.monitor.lastError) warnings.push(`⚠️ Captura: ${this.monitor.lastError.message} (${this.monitor.lastError.code}).`);
    if (results.some(o => o.forwarded)) warnings.push('Encaminhamentos: o remetente é quem republicou; o fornecedor original pode ser desconhecido.');
    const answer = { runId: run.id, traceId: run.traceId || run.id, query, results, count: results.length, totalCount: allResults.length, period, order: settings.sort, timezone: settings.timezone, stale, warnings, guidance, filters: effectiveFilters.modelKey ? effectiveFilters : parsedFilters, delivery: [] };
    this.store.saveSearchRun({ ...run, query, status: 'completed', resultCount: results.length, totalCount: allResults.length, resultOfferIds: results.map(o => o.id), filters: effectiveFilters.modelKey ? effectiveFilters : parsedFilters, queryFilters: persistedQueryFilters, resultSettings: { sort: settings.sort, maxResults: settings.maxResults, priceCriterion: settings.priceCriterion, onePerSupplier: settings.onePerSupplier, blockedSupplierIds: settings.blockedSupplierIds, blockedGroupIds: settings.blockedGroupIds, timezone: settings.timezone }, period, warnings, completedAt: this.now() });
    this._trace(run.traceId || run.id, 'results', { actorId, resultCount: results.length });
    this._audit('search.executed', actorId, { runId: run.id, source: run.source, resultCount: results.length });
    if (options.deliver) {
      const targets = this._targets(settings, actorId, options.context), outputFormat = options.outputFormat || 'text';
      if (!targets.length) fail('Nenhum destinatário autorizado com telefone válido está configurado.', 'SEARCH_RECIPIENT_MISSING');
      // Empty/invalid queries and no-match searches always receive useful text,
      // including when an Excel output flag was requested.
      const chunks = outputFormat !== 'excel' || answer.guidance || !allResults.length ? formatSearchResults(answer, settings) : [];
      let document = null;
      if (['excel', 'both'].includes(outputFormat) && !answer.guidance && allResults.length) document = await this._createExcel(results, this.store.getSearchRun(run.id), 'command', actorId);
      for (const target of targets) {
        for (const [index, text] of chunks.entries()) this._queueDelivery({ id: `${run.id}:${hash(target).slice(0, 16)}:${index}`, run, actorId, target, text, recipientMode: settings.recipientMode, context: options.context });
        if (document) this._queueDelivery({ id: `${run.id}:${hash(target).slice(0, 16)}:excel`, run, actorId, target, text: this._excelCaption(run.query, document.count, run.traceId || run.id), document, recipientMode: settings.recipientMode, context: options.context });
      }
      if (options.asyncDelivery) this._flushInBackground(); else await this.flushDeliveries(); answer.delivery = page(this.store.listSearchDeliveries({ runId: run.id, limit: 100 })).map(delivery => this._deliveryView(delivery));
    }
    this.emit('change'); return answer;
    } catch (error) { this.store.saveSearchRun({ ...this.store.getSearchRun(run.id), status: 'failed', code: error.code || 'SEARCH_QUERY_ERROR', error: this._safeError(error), completedAt: this.now() }); this._trace(run.traceId || run.id, 'failure', { actorId, code: error.code || 'SEARCH_QUERY_ERROR', reason: this._safeError(error) }); this._diagnostic(error.code || 'SEARCH_QUERY_ERROR', this._safeError(error), error); this.emit('change'); throw error; }
  }
  async _collectMatches(queryFilters, effective, settings, actorId) {
    const mode = this._mode(), candidates = []; let offset = 0;
    do {
      this._assert(actorId, 'search'); if (mode !== this._mode()) fail('O modo de operação mudou durante a busca.', 'SEARCH_MODE_CHANGED');
      const records = this.store.querySearchOffers({ ...queryFilters, limit: 500, offset });
      for (const offer of page(records)) { const compact = { ...offer }; delete compact.originalText; compact.snippet = String(offer.snippet || offer.originalExcerpt || offer.notes || '').slice(0, 1800); compact.originalExcerpt = compact.snippet; if (compact.notes) compact.notes = String(compact.notes).slice(0, 1800); candidates.push(compact); }
      offset += page(records).length; if (!page(records).length || offset >= records.total) break;
      await new Promise(resolve => setImmediate(resolve));
    } while (!this.closed);
    this._assert(actorId, 'search'); if (this.closed || mode !== this._mode()) fail('O modo de operação mudou durante a busca.', 'SEARCH_MODE_CHANGED');
    const { rankOffers } = require('./search-parser.cjs');
    let matches = rankOffers(candidates, effective, { allResults: true, priceCriterion: settings.priceCriterion, onePerSupplier: false, blockedSuppliers: settings.blockedSupplierIds || [], blockedGroups: settings.blockedGroupIds || [] });
    const order = settings.sort === 'recent' ? (a, b) => b.messageAt - a.messageAt : settings.sort === 'cashDescending' ? (a, b) => b.priceCents - a.priceCents || b.messageAt - a.messageAt : (a, b) => a.priceCents - b.priceCents || b.messageAt - a.messageAt;
    matches.sort(order);
    if (settings.onePerSupplier) { const seen = new Set(); matches = matches.filter(offer => { const key = offer.supplierKey || offer.id; if (seen.has(key)) return false; seen.add(key); return true; }); }
    return matches;
  }
  async _resolveListRun(payload, actorId) {
    this._assert(actorId, 'search'); this._assert(actorId, 'view');
    if (!this._settings().enabled) fail('Ative BUSCAS antes de exportar ou enviar uma lista.', 'SEARCH_DISABLED');
    let run = payload?.runId && this.store.getSearchRun(payload.runId);
    if (!run && payload?.runId) fail('A pesquisa não está disponível neste modo. Pesquise novamente.', 'SEARCH_RUN_MISSING');
    if (!run) { const answer = await this.executeSearch({ query: payload?.query || '', filters: payload?.filters || {} }, actorId); run = this.store.getSearchRun(answer.runId); }
    if (run.actorId !== actorId && !this._user(actorId)?.isOwner) fail('Você não pode acessar os resultados de outra pessoa.', 'SEARCH_DENIED');
    if (run.storageMode !== this._mode() || run.status !== 'completed') fail('A pesquisa não está concluída no modo atual. Pesquise novamente.', 'SEARCH_RUN_MISSING');
    if (!run.queryFilters || !run.filters?.modelKey) fail('Informe um modelo válido e execute a busca antes de exportar.', 'SEARCH_QUERY_REQUIRED');
    return run;
  }
  async _offersForRun(run, actorId, payload = {}) {
    const matches = await this._collectMatches(run.queryFilters, run.filters, run.resultSettings || this._settings(), actorId), selection = payload.selection || 'all';
    if (!['selected', 'all'].includes(selection)) fail('Escolha ofertas selecionadas ou todos os resultados filtrados.');
    if (selection === 'all') return matches;
    const ids = strings(payload.offerIds || [], 100_000); if (!ids.length) fail('Selecione ao menos uma oferta para exportar ou enviar.', 'SEARCH_SELECTION_EMPTY');
    const selected = new Set(ids), offers = matches.filter(offer => selected.has(offer.id));
    if (offers.length !== ids.length) fail('Uma oferta selecionada foi alterada, removida ou não corresponde aos filtros. Atualize a pesquisa e selecione novamente.', 'SEARCH_SELECTION_CHANGED');
    return offers;
  }
  async resultPage(payload, actorId) {
    const run = await this._resolveListRun(payload, actorId), offers = await this._offersForRun(run, actorId), offset = safeNumber(payload.offset ?? 0, 0, 10_000_000, 'Página'), limit = safeNumber(payload.limit ?? 50, 1, 100, 'Limite da página');
    return { runId: run.id, items: offers.slice(offset, offset + limit), total: offers.length, offset, limit, query: run.query, filters: run.filters, period: run.period, order: run.resultSettings?.sort || 'cashAscending' };
  }
  _excelCaption(query, count, traceId) { return `🔎 Kenned Code Disparos — lista de ofertas\n📱 ${String(query || '').slice(0, 500)}\n📊 ${count} oferta${count === 1 ? '' : 's'}\n📎 Excel com filtros e horários originais.\nValores conforme anúncios capturados. Confirme disponibilidade e condições com o fornecedor.\nRastreamento: ${traceId}`; }
  async _createExcel(offers, run, selection, actorId) {
    const mode = this._mode(); this._assert(actorId, 'search');
    this._trace(run.traceId || run.id, 'export', { actorId, resultCount: offers.length, status: 'processing' });
    const metadata = { query: run.query, filters: run.filters, period: run.period, order: run.resultSettings?.sort || this._settings().sort, timezone: run.resultSettings?.timezone || this._settings().timezone, generatedAt: this.now(), selection, resultLimit: selection === 'command' ? run.resultSettings?.maxResults || this._settings().maxResults : null, traceId: run.traceId || run.id, warnings: run.warnings || [] };
    let output, target;
    try {
      output = await generateSearchExcel({ offers, directory: path.join(this.store.dir, 'exports', mode), metadata });
      this._assert(actorId, 'search'); if (mode !== this._mode()) fail('O modo de operação mudou durante a exportação.', 'SEARCH_MODE_CHANGED');
      const mediaId = randomUUID(); target = path.join(this.mediaManager.dir, `${mediaId}.xlsx`); await fs.promises.rename(output.path, target);
      this._assert(actorId, 'search'); if (mode !== this._mode()) fail('O modo de operação mudou durante a exportação.', 'SEARCH_MODE_CHANGED');
      const media = this.store.saveMedia({ id: mediaId, name: output.name, path: target, type: 'document', mime: output.mime, size: output.size, sha256: output.sha256, createdAt: this.now(), generatedBy: 'search-excel', sourceRunId: run.id });
      this._audit('search.excel_generated', actorId, { runId: run.id, count: offers.length, selection, mediaId });
      this._trace(run.traceId || run.id, 'export', { actorId, resultCount: offers.length, status: 'completed' });
      return { ...media, count: offers.length, generatedAt: metadata.generatedAt, exportId: output.id };
    } catch (error) { if (output?.path) await fs.promises.unlink(output.path).catch(() => {}); if (target) await fs.promises.unlink(target).catch(() => {}); this._trace(run.traceId || run.id, 'failure', { actorId, code: error.code || 'SEARCH_EXCEL_ERROR', reason: 'Falha na geração persistente do Excel; nenhum documento foi enviado.' }); this._diagnostic(error.code || 'SEARCH_EXCEL_ERROR', 'Falha na geração do Excel. Nenhum sucesso foi informado.', error); throw error; }
  }
  assertExportPermission(actorId, expectedMode) {
    this._assert(actorId, 'search'); this._assert(actorId, 'view');
    if (!this._settings().enabled) fail('O módulo BUSCAS foi desativado. Ative-o antes de exportar.', 'SEARCH_DISABLED');
    if (expectedMode && expectedMode !== this._mode()) fail('O modo de operação mudou durante a exportação.', 'SEARCH_MODE_CHANGED');
    return { actorId, storageMode: this._mode() };
  }
  async exportSearchExcel(payload, actorId) {
    this.assertExportPermission(actorId);
    const run = await this._resolveListRun(payload, actorId), offers = await this._offersForRun(run, actorId, payload);
    return this._createExcel(offers, run, payload.selection || 'all', actorId);
  }
  _listRecipients(ids) {
    ids = strings(ids || [], 100); if (!ids.length) fail('Selecione ao menos um responsável autorizado.', 'SEARCH_RECIPIENT_MISSING');
    const seen = new Set(); return ids.map(id => {
      const number = this._recipientById(id); if (!number) fail('Um responsável está desativado ou sem telefone real com código do país e DDD.', 'SEARCH_RECIPIENT_MISSING');
      if (seen.has(number)) fail('O mesmo telefone foi selecionado em cadastros diferentes. Selecione somente um registro por número.', 'SEARCH_RECIPIENT_DUPLICATE'); seen.add(number);
      const record = id.startsWith('user:') ? this._user(id.slice(5)) : this.store.getAlertRecipient?.(id) || this.store.getEntity('alert_recipients', id);
      return { id, name: record.name || '', phone: number };
    });
  }
  _listAnswer(run, offers) { return { runId: run.id, traceId: run.traceId || run.id, query: run.query, results: offers, count: offers.length, period: run.period, order: run.resultSettings?.sort, timezone: run.resultSettings?.timezone, warnings: run.warnings || [], guidance: null }; }
  _offersSignature(offers) { return hash(JSON.stringify(offers)); }
  async previewSearchList(payload, actorId) {
    this._assert(actorId, 'manage'); const run = await this._resolveListRun(payload, actorId), offers = await this._offersForRun(run, actorId, payload), format = payload.format || 'text';
    if (!['text', 'excel', 'both'].includes(format)) fail('Escolha texto, Excel ou ambos.');
    const recipients = this._listRecipients(payload.recipientIds), chunks = format === 'excel' ? [] : formatSearchResults(this._listAnswer(run, offers), run.resultSettings || this._settings());
    const previewId = randomUUID(), expiresAt = this.now() + 300_000;
    const entry = { previewId, actorId, runId: run.id, selection: payload.selection || 'all', offerIds: payload.selection === 'selected' ? strings(payload.offerIds, 100_000) : [], signature: this._offersSignature(offers), format, recipientIds: recipients.map(r => r.id), recipients, mode: this._mode(), expiresAt, createdAt: this.now(), count: offers.length };
    for (const [id, item] of this.listPreviews) if (item.expiresAt < this.now()) this.listPreviews.delete(id);
    if (this.listPreviews.size >= 16) this.listPreviews.delete(this.listPreviews.keys().next().value); this.listPreviews.set(previewId, entry);
    return { previewId, count: offers.length, query: run.query, filters: run.filters, period: run.period, format, recipients, parts: chunks.length + (format !== 'text' ? 1 : 0), textParts: chunks.length, textPreview: chunks.slice(0, 2), previewPartCount: Math.min(2, chunks.length), truncated: chunks.length > 2, expiresAt, warnings: run.warnings || [] };
  }
  async previewSearchListPage(payload, actorId) {
    this._assert(actorId, 'manage'); this._assert(actorId, 'search'); this._assert(actorId, 'view');
    const entry = this.listPreviews.get(payload?.previewId);
    if (!entry || entry.actorId !== actorId || entry.mode !== this._mode() || entry.expiresAt < this.now()) fail('A prévia expirou ou pertence a outro modo. Gere a prévia novamente.', 'SEARCH_PREVIEW_EXPIRED');
    const run = await this._resolveListRun({ runId: entry.runId }, actorId), offers = await this._offersForRun(run, actorId, entry);
    if (this._offersSignature(offers) !== entry.signature || JSON.stringify(this._listRecipients(entry.recipientIds)) !== JSON.stringify(entry.recipients)) fail('Ofertas ou destinatários mudaram. Gere uma nova prévia antes de enviar.', 'SEARCH_PREVIEW_CHANGED');
    const chunks = entry.format === 'excel' ? [this._excelCaption(run.query, offers.length, run.traceId || run.id)] : formatSearchResults(this._listAnswer(run, offers), run.resultSettings || this._settings());
    const part = safeNumber(payload.part ?? 1, 1, chunks.length, 'Parte da prévia');
    this._assert(actorId, 'manage'); this._assert(actorId, 'search'); this._assert(actorId, 'view');
    if (entry.mode !== this._mode() || entry.expiresAt < this.now()) fail('A prévia expirou ou o modo mudou. Gere a prévia novamente.', 'SEARCH_PREVIEW_EXPIRED');
    return { previewId: entry.previewId, text: chunks[part - 1], part, total: chunks.length, format: entry.format, count: offers.length, expiresAt: entry.expiresAt };
  }
  async sendSearchList(payload, actorId) {
    this._assert(actorId, 'manage'); this._assert(actorId, 'search'); this._assert(actorId, 'view');
    const entry = this.listPreviews.get(payload?.previewId);
    if (!entry || entry.actorId !== actorId || entry.mode !== this._mode() || entry.expiresAt < this.now()) fail('A prévia expirou ou pertence a outro modo. Gere a prévia novamente.', 'SEARCH_PREVIEW_EXPIRED');
    if (entry.result) return entry.result;
    if (entry.sending) return entry.sending;
    entry.sending = (async () => {
      const run = await this._resolveListRun({ runId: entry.runId }, actorId), offers = await this._offersForRun(run, actorId, entry), recipients = this._listRecipients(entry.recipientIds);
      if (this._offersSignature(offers) !== entry.signature || JSON.stringify(recipients) !== JSON.stringify(entry.recipients)) fail('Ofertas ou destinatários mudaram. Gere uma nova prévia antes de enviar.', 'SEARCH_PREVIEW_CHANGED');
      if (!this._automationAllowed()) fail('Os envios estão interrompidos. Retome explicitamente antes de enviar listas.', 'AUTOMATION_STOPPED');
      const document = entry.format !== 'text' ? await this._createExcel(offers, run, entry.selection, actorId) : null;
      const freshOffers = await this._offersForRun(run, actorId, entry);
      if (this._offersSignature(freshOffers) !== entry.signature) fail('As ofertas mudaram durante a geração do documento. Gere uma nova prévia antes de enviar.', 'SEARCH_PREVIEW_CHANGED');
      const chunks = entry.format !== 'excel' ? formatSearchResults(this._listAnswer(run, offers), run.resultSettings || this._settings()) : [], batchId = `${run.id}:list:${entry.previewId}`, parts = chunks.length + (document ? 1 : 0);
      this.store.transaction(() => {
        this._assert(actorId, 'manage'); this._assert(actorId, 'search'); this._assert(actorId, 'view');
        if (entry.mode !== this._mode() || JSON.stringify(this._listRecipients(entry.recipientIds)) !== JSON.stringify(entry.recipients)) fail('Os destinatários ou o modo mudaram. Nenhum envio foi criado.', 'SEARCH_PREVIEW_CHANGED');
        for (const recipient of recipients) {
          const target = `${recipient.phone}@s.whatsapp.net`;
          for (const [index, text] of chunks.entries()) this._queueDelivery({ id: `${batchId}:${hash(target).slice(0, 16)}:${index}`, run, actorId, target, text, batchId, manualList: true, recipientMode: 'manual-list', recipientId: recipient.id, part: index + 1, parts });
          if (document) this._queueDelivery({ id: `${batchId}:${hash(target).slice(0, 16)}:excel`, run, actorId, target, text: this._excelCaption(run.query, offers.length, run.traceId || run.id), document, batchId, manualList: true, recipientMode: 'manual-list', recipientId: recipient.id, part: parts, parts });
        }
      });
      this._audit('search.list_queued', actorId, { runId: run.id, batchId, count: offers.length, recipients: recipients.length, format: entry.format });
      entry.result = await this.listListDeliveries({ batchId, runId: run.id }, actorId); this._flushInBackground(); this.emit('change'); return entry.result;
    })();
    try { return await entry.sending; } finally { entry.sending = null; }
  }
  async listListDeliveries(payload, actorId) {
    this._assert(actorId, 'manage');
    if (!boundedText(payload?.batchId, 256) || !payload.batchId) fail('Identificador de envio inválido.');
    let offset = 0; const deliveries = []; let records;
    do { records = this.store.listSearchDeliveries({ runId: payload.runId, limit: 500, offset }); for (const record of page(records)) if (record.batchId === payload.batchId && (record.actorId === actorId || this._user(actorId)?.isOwner)) deliveries.push(this._deliveryView(record)); offset += page(records).length; if (offset < records.total) await new Promise(resolve => setImmediate(resolve)); } while (page(records).length && offset < records.total);
    return { batchId: payload.batchId, deliveries, total: deliveries.length };
  }
  _queueDelivery({ id, run, actorId, target, text, recipientMode, context, recipientId, document, batchId, manualList = false, part, parts, test = false, errorNotice = false }) {
    const clientMessageId = `KENNED-SEARCH-${randomUUID()}`;
    if (!this._automationAllowed()) fail('Os envios automáticos estão interrompidos. Retome explicitamente pelo aplicativo ou comando administrativo.', 'AUTOMATION_STOPPED');
    this._trace(run.traceId || run.id, 'recipient', { actorId, target, recipientId });
    const delivery = this.store.saveSearchDelivery({ id, runId: run.id, traceId: run.traceId || run.id, actorId, target, recipientId: recipientId || null, text, document: document ? { id: document.id, path: document.path, name: document.name, mime: document.mime, size: document.size, sha256: document.sha256 } : null, mediaId: document?.id || null, kind: document ? 'document' : 'text', batchId: batchId || null, manualList, part: part || null, parts: parts || null, clientMessageId, messageId: clientMessageId, recipientMode, status: 'pending', attempts: 0, createdAt: this.now(), sourceChatId: context?.chatId || null, sourceIsGroup: context?.isGroup === true, sourceSenderNumber: context?.senderNumber || null, sourceIdentityVerified: context?.identityVerified === true || context?.verified === true, sourceSenderId: context?.senderId || null, sourceReplyProof: context?.replyProof || null,  sourceTrustedSelf: context?.sourceTrustedSelf === true || this._trustedSelf(context), sourceSelfChat: context?.selfChat === true, sourceIncomingPrivate: context?.isGroup === false && context?.fromMe === false, test, errorNotice, storageMode: this._mode(), simulation: this._mode() === 'simulated' });
    this._trace(delivery.traceId, 'queued', { actorId, deliveryId: delivery.id, target, status: 'pending' }); return delivery;
  }
  async _queueFailureNotice(run, context, error, { deferFlush = false } = {}) {
    if (!run || !this._can(run.actorId, 'search') || this.closed || !phone(context?.senderNumber) || this.authService.findAuthorizedPhone(phone(context.senderNumber))?.id!==run.actorId || this.store.getSearchDelivery(`${run.id}:error-notice`)) return;
    try {
      this._queueDelivery({ id: `${run.id}:error-notice`, run, actorId: run.actorId, target: `${context.senderNumber}@s.whatsapp.net`, text: `⚠️ Kenned Code Disparos: ${this._safeError(error)}.\nConsulte BUSCAS e Diagnóstico no aplicativo.\nRastreamento: ${run.traceId || run.id}`, recipientMode: 'error-notice', context, errorNotice: true });
      if (!deferFlush) await this.flushDeliveries();
    } catch (noticeError) { this._trace(run.traceId || run.id, 'failure', { actorId: run.actorId, code: 'SEARCH_FAILURE_NOTICE_ERROR', reason: this._safeError(noticeError) }); }
  }
  _recipientById(id) {
    if(typeof id!=='string')return null;
    if(id.startsWith('user:')){const u=this._user(id.slice(5));return u&&phone(u.phone);}
    const recipient=this.store.getAlertRecipient?.(id)||this.store.getEntity('alert_recipients',id),number=phone(recipient?.phone);
    if(!recipient||recipient.enabled===false||!number)return null;
    if(recipient.userId){const linked=this._user(recipient.userId);if(!linked||linked.phone&&phone(linked.phone)!==number)return null;}
    return number;
  }
  _targets(settings, actorId, ctx) {
    // A received private command is a private interaction with its authenticated
    // requester. Broadcast preferences apply only to groups and application searches.
    if (ctx?.fromMe === false && ctx.isGroup === false || ctx?.sourceIncomingPrivate === true) {
      const number = phone(ctx.senderNumber);
      if (!number || this.authService.findAuthorizedPhone(number)?.id !== actorId || !this._commandLocation(ctx, settings, false)) return [];
      return [ctx.chatId];
    }
    if (settings.recipientMode === 'origin') { if (!settings.allowOriginReplies || !ctx || !this._commandLocation(ctx, settings, ctx.sourceTrustedSelf === true || this._trustedSelf(ctx))) return []; return [ctx.chatId]; }
    if (settings.recipientMode === 'requester') { const user = this._assert(actorId, 'search'), sourceNumber = phone(ctx?.senderNumber); const number = sourceNumber && this.authService.findAuthorizedPhone(sourceNumber)?.id === actorId ? sourceNumber : phone(user.phone); return number ? [`${number}@s.whatsapp.net`] : []; }
    if (settings.recipientMode === 'responsibles') { const numbers = settings.responsibleRecipientIds.map(id => this._recipientById(id)); if (numbers.some(n => !n)) fail('Um responsável selecionado não tem telefone válido ou está desativado.', 'SEARCH_RECIPIENT_MISSING'); return [...new Set(numbers.map(n => `${n}@s.whatsapp.net`))]; }
    let owner = settings.ownerRecipientUserId ? this._user(settings.ownerRecipientUserId) : this.store.listEntities('users').map(u => this._user(u.id)).find(u => u?.isOwner && phone(u.phone));
    if (settings.ownerRecipientUserId && (!owner?.isOwner || !phone(owner.phone))) fail('O dono selecionado está inativo ou sem telefone válido.', 'SEARCH_OWNER_RECIPIENT_INVALID');
    return owner && phone(owner.phone) ? [`${phone(owner.phone)}@s.whatsapp.net`] : [];
  }
  _deliveryView(delivery) { if (!delivery) return null; const { id, runId, traceId, recipientId, batchId, kind, manualList, part, parts, target, resolvedTarget, status, attempts, createdAt, submittedAt, resultAt, error, code, deliveredAt, readAt, confirmationScope, safeToRetry, test, errorNotice, simulation } = delivery; return { id, runId, traceId, recipientId, batchId, kind, manualList, part, parts, fileName: delivery.document?.name || null, target, resolvedTarget, status, attempts, createdAt, submittedAt, resultAt, error, code, deliveredAt, readAt, confirmationScope, safeToRetry, test, errorNotice, simulation }; }
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
    this._flushInBackground(); this.emit('change'); return this._deliveryView(this.store.getSearchDelivery(delivery.id));
  }
  async retryDelivery(payload, actorId) {
    const delivery = this.store.getSearchDelivery(payload?.id); if (!delivery) fail('Entrega não encontrada.');
    this._assert(actorId, delivery.test || delivery.manualList ? 'manage' : 'search'); if (!this._user(actorId)?.isOwner && delivery.actorId !== actorId) fail('Você não pode repetir uma entrega solicitada por outro usuário.', 'SEARCH_DENIED');
    if (!['failed', 'pending'].includes(delivery.status) || delivery.status === 'failed' && delivery.safeToRetry !== true) fail('Somente falhas comprovadamente anteriores ao envio podem ser repetidas. Resultados incertos precisam de revisão.', 'SEARCH_RETRY_UNSAFE');
    this.store.updateSearchDelivery(delivery.id, { status: 'pending', nextAttemptAt: 0, attempts: 0, resultAt: null, code: null, error: null }); this._trace(delivery.traceId || delivery.runId, 'retry', { actorId, deliveryId: delivery.id }); await this.flushDeliveries(); this.emit('change'); return this._deliveryView(this.store.getSearchDelivery(delivery.id));
  }
  stopPending({ actorId = null, reason = 'Envios interrompidos pelo controle global.', at = this.now() } = {}) {
    let cancelled = 0, records;
    do { records = page(this.store.listSearchDeliveries({ status: 'pending', limit: 500 })); for (const delivery of records) { this.store.updateSearchDelivery(delivery.id, { status: 'cancelled', resultAt: at, cancelledAt: at, cancelledBy: actorId, code: 'AUTOMATION_STOPPED', error: reason, safeToRetry: false }); cancelled++; this._trace(delivery.traceId || delivery.runId, 'integration', { actorId, deliveryId: delivery.id, status: 'cancelled', code: 'AUTOMATION_STOPPED' }); } } while (records.length);
    const inFlight = this.store.listSearchDeliveries({ status: 'sending', limit: 0 }).total || 0; this.emit('change'); return { cancelled, inFlight };
  }
  _incomingPrivateDelivery(delivery) { return delivery.sourceIncomingPrivate === true || delivery.sourceIncomingPrivate === undefined && delivery.sourceIsGroup === false && delivery.sourceTrustedSelf !== true && !!phone(delivery.sourceSenderNumber) && (delivery.sourceChatId === `${delivery.sourceSenderNumber}@s.whatsapp.net` || /^\d+@lid$/.test(delivery.sourceChatId || '')); }
  _deliveryAuthorized(delivery) {
    if (delivery.storageMode && delivery.storageMode !== this._mode() || !this._can(delivery.actorId, delivery.test || delivery.manualList ? 'manage' : 'search')) return false;
    const currentSettings = this._settings();
    if (delivery.test) return `${this._recipientById(delivery.recipientId)}@s.whatsapp.net` === delivery.target;
    if (delivery.manualList) return currentSettings.enabled && this._can(delivery.actorId, 'view') && this._can(delivery.actorId, 'search') && `${this._recipientById(delivery.recipientId)}@s.whatsapp.net` === delivery.target;
    if (!currentSettings.enabled) return false;
    if (delivery.errorNotice) return this.authService.findAuthorizedPhone(phone(delivery.sourceSenderNumber))?.id===delivery.actorId && this._commandLocation({ chatId: delivery.sourceChatId, isGroup: delivery.sourceIsGroup, senderNumber: delivery.sourceSenderNumber, selfChat: delivery.sourceSelfChat }, currentSettings, delivery.sourceTrustedSelf) && `${delivery.sourceSenderNumber}@s.whatsapp.net` === delivery.target;
    return this._targets(currentSettings, delivery.actorId, delivery.sourceChatId ? { chatId: delivery.sourceChatId, isGroup: delivery.sourceIsGroup, senderNumber: delivery.sourceSenderNumber, sourceTrustedSelf: delivery.sourceTrustedSelf, selfChat: delivery.sourceSelfChat, sourceIncomingPrivate: this._incomingPrivateDelivery(delivery) } : null).includes(delivery.target);
  }
  _flushInBackground() {
    // Status events and maintenance have no caller awaiting their promise.
    // Catch synchronous setup failures as well as asynchronous queue failures.
    const report = error => {
      if (error?.code === 'SUBMISSION_SERVICE_CLOSED' && (this.closed || this.scheduler?.closed || this.scheduler?.closing)) return;
      try { this._diagnostic('SEARCH_DELIVERY_PUMP_ERROR', this._safeError(error), error); }
      catch { /* An unavailable diagnostic store cannot reject an event handler. */ }
    };
    try {
      const pump = Promise.resolve(this.flushDeliveries());
      this.backgroundDeliveryPumps ||= new WeakSet();
      if (this.backgroundDeliveryPumps.has(pump)) return;
      this.backgroundDeliveryPumps.add(pump);
      void pump.catch(report);
    }
    catch (error) { report(error); }
  }
  flushDeliveries() {
    if (this.deliveryPump) return this.deliveryPump;
    if (this.closed || this.scheduler?.closed || this.scheduler?.closing || this.paused || !this._automationAllowed() || this.adapter?.status?.state !== 'connected' || this.store.persistenceFailed) return Promise.resolve();
    let completed = false, submission;
    // Acquire the scheduler hold immediately, before another round can start.
    try {
      if (this.scheduler?.runExternalSubmission) {
        const submit = () => this.scheduler.runExternalSubmission(context => this._flushDeliveries({ ...context, managedSubmission: true, singleDelivery: true }), { timeoutMs: 2 * this._deliveryTimeoutMs() + Math.max(3, this.adapter.minimumSpacingSeconds || 3) * 1000 + 5000 });
        // Each durable delivery gets its own transport turn. Never wait for a
        // campaign while owning the turn that the campaign is waiting for.
        const first = submit();
        submission = Promise.resolve(first).then(async () => {
          for (let count = 1; count < 100 && !this.closed && !this.scheduler.closed && !this.scheduler.closing && !this.paused && this._automationAllowed() && this.adapter?.status?.state === 'connected' && !this.store.persistenceFailed && page(this.store.listSearchDeliveries({ status: 'pending', dueAt: this.now(), limit: 1 })).length; count++) await submit();
        });
      } else submission = this._flushDeliveries();
    }
    catch (error) { submission = Promise.reject(error); }
    this.deliveryPump = Promise.resolve(submission)
      .then(result => { completed = true; return result; })
      .catch(error => {
        // The shared scheduler cancels an unstarted submission during global
        // stop. Nothing was sent: the stop handler owns durable cancellation,
        // and this is not a provider error or a persistence failure.
        if (error?.code === 'AUTOMATION_STOPPED' && error.submitted === false) return;
        if (error?.code === 'SUBMISSION_SERVICE_CLOSED' && (this.closed || this.scheduler?.closed || this.scheduler?.closing)) return;
        throw error;
      }).finally(() => {
        this.deliveryPump = null;
        // Only a completed batch may immediately continue. A rejected pump
        // must not spin indefinitely in microtasks while pending rows remain.
        if (completed && !this.closed && !this.scheduler?.closed && !this.scheduler?.closing && !this.paused && this._automationAllowed() && this.adapter?.status?.state === 'connected' && !this.store.persistenceFailed && page(this.store.listSearchDeliveries({ status: 'pending', dueAt: this.now(), limit: 1 })).length)
          queueMicrotask(() => this._flushInBackground());
      });
    return this.deliveryPump;
  }
  _deliveryTimeoutMs() { return this.scheduler?.getAttemptTimeoutMs?.() || Math.max(5, Math.min(300, Number(this.store.getSetting('submissionTimeoutSeconds', 30)) || 30)) * 1000; }
  _boundedDelivery(work, options = {}) {
    return this.scheduler?.runBoundedAttempt ? this.scheduler.runBoundedAttempt(work, { timeoutMs: this._deliveryTimeoutMs(), ...options }) : Promise.resolve().then(() => work({ beforeSubmit: () => {}, signal: options.signal, timeoutMs: this._deliveryTimeoutMs() }));
  }
  _reconcileDelivery(delivery, proof, adapter, mode) {
    if (this.closed || adapter !== this.adapter || mode !== this._mode() || !proof) return false;
    const current = this.store.getSearchDelivery(delivery.id);
    if (!current || !['sending', 'uncertain', 'confirmed'].includes(current.status)) return false;
    if (proof.status === 'failed' && proof.confirmedFailure === true) {
      if (current.status === 'confirmed' || current.deliveredAt || current.readAt) return true;
      this.store.updateSearchDelivery(current.id, { status: 'failed', resultAt: this.now(), code: proof.code || 'SEARCH_CONFIRMED_REJECTION', safeToRetry: false, error: 'A integração confirmou que a resposta não foi aceita.' });
      return true;
    }
    if (!['confirmed', 'accepted', 'delivered', 'read'].includes(proof.status)) return false;
    const delivered = proof.status === 'delivered' || proof.status === 'read' || proof.delivered === true || Number.isFinite(proof.deliveredAt);
    this.store.updateSearchDelivery(current.id, { status: 'confirmed', resultAt: current.resultAt || this.now(), messageId: proof.messageId || current.messageId || current.clientMessageId, error: null, code: null, safeToRetry: false, confirmationScope: current.confirmationScope === 'whatsapp-read' ? current.confirmationScope : proof.confirmationScope || current.confirmationScope || 'integration-ack', deliveredAt: current.deliveredAt || proof.deliveredAt || (delivered ? this.now() : null), readAt: current.readAt || proof.readAt || (proof.status === 'read' ? this.now() : null) });
    this._trace(delivery.traceId || delivery.runId, 'integration', { actorId: delivery.actorId, deliveryId: delivery.id, status: delivered ? 'delivered' : 'confirmed', messageId: proof.messageId || current.messageId, confirmationScope: proof.confirmationScope });
    this.emit('change'); return true;
  }
  async _flushDeliveries(outer = {}) {
    const release = outer.managedSubmission ? (() => {}) : this.scheduler?.holdSubmissions?.() || (() => {}); try { if (!outer.managedSubmission) await this.scheduler?.waitForIdle?.();
      const pending = page(this.store.listSearchDeliveries({ status: 'pending', dueAt: this.now(), limit: outer.singleDelivery ? 1 : 100 }));
      for (const delivery of pending) {
        if (outer.signal?.aborted || this.closed || !this._automationAllowed() || this.adapter?.status?.state !== 'connected') break;
        if (delivery.nextAttemptAt > this.now()) continue;
        if (!this._can(delivery.actorId, delivery.test || delivery.manualList ? 'manage' : 'search')) { this.store.updateSearchDelivery(delivery.id, { status: 'failed', resultAt: this.now(), code: 'SEARCH_DENIED', safeToRetry: true, error: 'A autorização do solicitante foi removida.' }); continue; }
        let authorizedTarget = false;
        try { authorizedTarget = this._deliveryAuthorized(delivery); }
        catch (error) { this._trace(delivery.traceId || delivery.runId, 'failure', { actorId: delivery.actorId, code: error.code, reason: this._safeError(error) }); }
        if (!authorizedTarget) { this.store.updateSearchDelivery(delivery.id, { status: 'failed', resultAt: this.now(), code: 'SEARCH_TARGET_DISABLED', safeToRetry: true, error: 'O destino da entrega deixou de estar habilitado.' }); continue; }
        const minimum = Math.max(3, this.adapter.minimumSpacingSeconds || 3) * 1000, previous = this.scheduler?.lastSubmissionAt;
        if (previous != null) await this.sleep(Math.max(0, minimum - (this.now() - previous)));
        if (this.closed || !this._automationAllowed() || this.adapter?.status?.state !== 'connected') break;
        const attempt = (delivery.attempts || 0) + 1;
        try {
          const number = phone(delivery.target?.match(/^(\d+)@s\.whatsapp\.net$/)?.[1]);
          const sendingAdapter = this.adapter, sendingMode = this._mode();
          const replyContext = delivery.sourceIncomingPrivate && delivery.sourceIdentityVerified ? { chatId: delivery.sourceChatId, senderNumber: delivery.sourceSenderNumber, senderId: delivery.sourceSenderId, replyProof: delivery.sourceReplyProof, identityVerified: true, isGroup: false, traceId: delivery.traceId || delivery.runId } : null;
          const resolved = await this._boundedDelivery(context => {
            context.beforeSubmit(); outer.beforeSubmit?.();
            const options = { traceId: delivery.traceId || delivery.runId, signal: context.signal, timeoutMs: context.timeoutMs, beforeSubmit: () => { context.beforeSubmit(); outer.beforeSubmit?.(); } };
            return replyContext && sendingAdapter.resolveSearchRecipient ? sendingAdapter.resolveSearchRecipient(delivery.sourceSenderNumber, replyContext, options) : number && sendingAdapter.resolveRecipient ? sendingAdapter.resolveRecipient(number, options) : { jid: delivery.target };
          }, { signal: outer.signal });
          if (!resolved?.jid) fail('Não foi possível resolver o destinatário.', 'SEARCH_RECIPIENT_MISSING');
          if (this.closed || this.paused || !this._automationAllowed() || this.adapter?.status?.state !== 'connected') break;
          if (this.adapter !== sendingAdapter || this._mode() !== sendingMode || !this._deliveryAuthorized(delivery)) fail('A autorização ou o destinatário mudou durante a preparação. Nenhuma mensagem foi enviada.', 'SEARCH_TARGET_DISABLED');
          this.store.updateSearchDelivery(delivery.id, { status: 'sending', attempts: attempt, submittedAt: this.now(), resolvedTarget: resolved.jid });
          this._trace(delivery.traceId || delivery.runId, 'recipient', { actorId: delivery.actorId, target: resolved.jid, deliveryId: delivery.id });
          if (this.scheduler) this.scheduler.lastSubmissionAt = this.now(); this._trace(delivery.traceId || delivery.runId, 'submitted', { actorId: delivery.actorId, deliveryId: delivery.id, attempts: attempt });
          const result = await this._boundedDelivery(context => {
            const beforeSubmit = () => {
              context.beforeSubmit(); outer.beforeSubmit?.();
              const ledger = this.store.getSearchDelivery(delivery.id);
              if (this.closed || this.paused || !this._automationAllowed() || this.store.persistenceFailed || this.adapter !== sendingAdapter || this._mode() !== sendingMode || ledger?.status !== 'sending' || ledger.clientMessageId !== delivery.clientMessageId || !this._deliveryAuthorized(delivery)) throw Object.assign(new Error('O envio foi bloqueado porque a conexão, as permissões ou os destinatários mudaram.'), { code: 'SEARCH_TARGET_DISABLED', definitive: true, safeToRetry: false, submitted: false });
            };
            beforeSubmit();
            const options = { clientMessageId: delivery.clientMessageId, replyContext, beforeSubmit, signal: context.signal, timeoutMs: context.timeoutMs, traceId: delivery.traceId || delivery.runId };
            return delivery.document ? sendingAdapter.sendPrivateContent(resolved.jid, { type: 'document', caption: delivery.text }, this.store.getMedia(delivery.mediaId) || delivery.document, options) : sendingAdapter.sendSearchText(resolved.jid, delivery.text, options);
          }, { signal: outer.signal, onLateResult: proof => this._reconcileDelivery(delivery, proof, sendingAdapter, sendingMode), onLateError: error => {
            if (this.closed || this.adapter !== sendingAdapter || this._mode() !== sendingMode) return;
            const current = this.store.getSearchDelivery(delivery.id);
            if (current?.status === 'uncertain' && error?.definitive === true && error?.submitted === false) this.store.updateSearchDelivery(delivery.id, { status: 'failed', resultAt: this.now(), code: 'SEARCH_LATE_PRE_SUBMISSION_FAILURE', safeToRetry: true, error: 'A integração confirmou posteriormente que a resposta não foi submetida.' });
          } });
          if (result?.status === 'failed' && result.confirmedFailure === true) throw Object.assign(new Error('A integração confirmou a rejeição da resposta.'), { ...result, definitive: true });
          const current = this.store.getSearchDelivery(delivery.id); const confirmed = current?.status === 'confirmed' || (['confirmed', 'delivered'].includes(result?.status) || result?.status === 'accepted' && !!result.messageId);
          this.store.updateSearchDelivery(delivery.id, { status: confirmed ? 'confirmed' : 'uncertain', resultAt: this.now(), messageId: result?.messageId || delivery.clientMessageId, confirmationScope: result?.confirmationScope || current?.confirmationScope || (confirmed ? 'integration-ack' : null), deliveredAt: result?.deliveredAt || current?.deliveredAt || null, readAt: result?.readAt || current?.readAt || null, code: confirmed ? null : 'SEARCH_RESULT_UNCERTAIN', safeToRetry: false, error: confirmed ? null : 'Envio sem confirmação; revisar antes de repetir.' });
          this._trace(delivery.traceId || delivery.runId, 'integration', { actorId: delivery.actorId, deliveryId: delivery.id, status: confirmed ? 'confirmed' : 'uncertain', confirmationScope: result?.confirmationScope, attempts: attempt });
        } catch (error) { const current = this.store.getSearchDelivery(delivery.id); if (current?.status === 'cancelled') continue; if (current?.status === 'confirmed' || current?.deliveredAt || current?.readAt) { this._trace(delivery.traceId || delivery.runId, 'integration', { actorId: delivery.actorId, deliveryId: delivery.id, status: 'confirmed', confirmationScope: current.confirmationScope, attempts: attempt }); this.emit('change'); continue; }
          if (error?.code === 'SUBMISSION_SERVICE_CLOSED' && error.submitted === false && (this.closed || this.scheduler?.closed || this.scheduler?.closing)) {
            this.store.updateSearchDelivery(delivery.id, { status: 'pending', attempts: delivery.attempts || 0, submittedAt: null, resultAt: null, code: null, error: null, safeToRetry: false });
            break;
          }
          const submitted = current?.status === 'sending', safe = !submitted || error?.confirmedFailure === true || error?.safeToRetry === true && error?.submitted !== true && error?.submitted !== 'unknown' || error?.definitive === true && error?.submitted !== true && error?.submitted !== 'unknown', temporary = error?.safeToRetry === true, status = safe && temporary && attempt < 3 ? 'pending' : safe ? 'failed' : 'uncertain'; this.store.updateSearchDelivery(delivery.id, { status, attempts: attempt, nextAttemptAt: this.now() + Math.min(3600000, 15_000 * 2 ** (attempt - 1)), resultAt: status === 'pending' ? null : this.now(), code: error?.code || 'SEARCH_DELIVERY_ERROR', safeToRetry: safe, error: status === 'uncertain' ? 'Resultado incerto. Revisão necessária antes de repetir.' : this._safeError(error) }); this._trace(delivery.traceId || delivery.runId, 'integration', { actorId: delivery.actorId, deliveryId: delivery.id, status, code: error?.code || 'SEARCH_DELIVERY_ERROR', reason: this._safeError(error), attempts: attempt }); this._diagnostic(error?.code || 'SEARCH_DELIVERY_ERROR', this._safeError(error), error);
          if (['failed', 'uncertain'].includes(status) && delivery.sourceChatId && !delivery.errorNotice && !delivery.test) await this._queueFailureNotice(this.store.getSearchRun(delivery.runId), { chatId: delivery.sourceChatId, isGroup: delivery.sourceIsGroup, senderNumber: delivery.sourceSenderNumber, sourceTrustedSelf: delivery.sourceTrustedSelf, selfChat: delivery.sourceSelfChat, fromMe: delivery.sourceIncomingPrivate ? false : undefined, identityVerified: delivery.sourceIdentityVerified, senderId: delivery.sourceSenderId, replyProof: delivery.sourceReplyProof }, status === 'uncertain' ? { code: 'SEARCH_RESULT_UNCERTAIN' } : error, { deferFlush: true });
        }
        this.emit('change');
      }
    } finally { release(); }
  }
  _receipt(receipt) {
    if (!['confirmed', 'accepted', 'delivered', 'read', 'failed'].includes(receipt?.status) || !receipt.messageId || !this._modeMatches(receipt)) return;
    for (const delivery of page(this.store.listSearchDeliveries({ messageId: receipt.messageId, limit: 100 }))) if ([delivery.messageId, delivery.clientMessageId].includes(receipt.messageId)) this._reconcileDelivery(delivery, receipt, this.adapter, this._mode());
  }

  reviewOffer(payload, actorId) { this._assert(actorId, 'manage'); const offer = this.store.getSearchOffer(payload.id); if (!offer) fail('Oferta não encontrada.'); if (!['discard', 'confirm'].includes(payload.decision)) fail('Escolha confirmar ou descartar.'); const patch = { status: payload.decision === 'discard' ? 'unavailable' : 'active', confidence: payload.decision === 'confirm' ? 'confirmed' : offer.confidence, reviewedBy: actorId, reviewedAt: this.now() }; if (payload.decision === 'confirm') { if (offer.reviewReasons?.some(r => ['multiple_models', 'unsupported_model_variant', 'ambiguous_storage', 'ambiguous_color', 'ambiguous_condition'].includes(r))) fail('A associação entre produto e preço também é ambígua. Não é possível confirmá-la corrigindo apenas o preço; mantenha em revisão ou descarte.'); if (!Number.isInteger(payload.priceCents) || payload.priceCents <= 0 || payload.priceCents > 100_000_000) fail('Informe o preço total confirmado, em centavos.'); patch.priceCents = payload.priceCents; patch.priceKind = 'cash'; } const result = this.store.updateSearchOffer(payload.id, patch); this._audit('search.offer_review', actorId, { offerId: payload.id, decision: payload.decision }); this.emit('change'); return result; }
  cleanupPreview(payload, actorId) { this._assert(actorId, 'manage'); const scope = payload?.scope; if (!['history', 'base'].includes(scope)) fail('Selecione histórico de buscas ou base de ofertas.'); const stats = this.store.getSearchMonitorStats(); const token = randomUUID(); this.cleanupTokens.set(token, { actorId, scope, expiresAt: this.now() + 300_000 }); if (this.cleanupTokens.size > 100) this.cleanupTokens.delete(this.cleanupTokens.keys().next().value); return { scope, token, stats, effect: scope === 'history' ? 'Remove apenas o histórico de consultas. Ofertas, mensagens e controles de entrega permanecem.' : 'Remove mensagens capturadas e ofertas. Campanhas, usuários, configurações, histórico de consultas e controles de entrega permanecem.' }; }
  async clearData(payload, actorId) { this._assert(actorId, 'manage'); const token = this.cleanupTokens.get(payload.token); if (!token || token.actorId !== actorId || token.scope !== payload.scope || token.expiresAt < this.now()) fail('Visualize novamente o que será removido antes de apagar.'); if (payload.confirmation !== 'APAGAR') fail('Digite APAGAR para confirmar.'); this.cleanupTokens.delete(payload.token); if (payload.scope === 'base') { await this.suspendCapture('offers_base_cleared'); try { this.store.deleteSearchBase({ actor: actorId }); this.monitor.lastSyncAt = null; this.monitor.lastCaptureAt = null; } finally { this.resumeCapture(); } } else this.store.deleteSearchHistory({ actor: actorId }); this._audit(`search.${payload.scope}_cleared`, actorId); this.emit('change'); return { cleared: true, scope: payload.scope }; }
  importHistory(actorId) { this._assert(actorId, 'manage'); if (!this._settings().enabled || !this._settings().importHistory) fail('Ative BUSCAS e a importação parcial de histórico.'); if (typeof this.adapter?.requestSearchHistory !== 'function') return { supported: false, complete: false, detail: 'A integração entrega somente o histórico parcial disponibilizado durante a sincronização. Não há importação completa sob demanda.' }; return this.adapter.requestSearchHistory({ groupIds: this._settings().monitoredGroupIds }); }

  async synchronizeNow(actorId) {
    this._assert(actorId, 'manage');
    const settings = this._settings();
    if (!settings.enabled || this.paused || !this._automationAllowed()) fail('Ative BUSCAS e libere o monitoramento antes de sincronizar.', 'SEARCH_DISABLED');
    if (this.adapter?.status?.state !== 'connected' || this.adapter?.getConnectionReadiness?.().ready === false) fail('Conecte uma sessão pronta do WhatsApp antes de sincronizar.', 'DISCONNECTED');
    const adapter = this.adapter, mode = this._mode();
    try {
      const groups = await adapter.listGroups();
      this._assert(actorId, 'manage');
      if (adapter !== this.adapter || mode !== this._mode()) fail('O modo de operação mudou durante a sincronização.', 'SEARCH_MODE_CHANGED');
      if (!this._settings().enabled || this.paused || !this._automationAllowed()) fail('O monitoramento foi pausado durante a sincronização.', 'SEARCH_DISABLED');
      const available = new Set(groups.map(group => group.id));
      const missing = settings.monitoredGroupIds.filter(id => !available.has(id));
      this._configure();
      this.monitor.lastGroupCheckAt = this.now();
      this.monitor.unavailableGroupIds = missing;
      this.monitor.lastError = missing.length ? { at: this.now(), code: 'SEARCH_GROUPS_UNAVAILABLE', message: `${missing.length} grupo(s) monitorado(s) não constam entre os grupos acessíveis da sessão. Confira os identificadores e a participação da conta.` } : null;
      this._persistMonitor(); this.emit('change');
      return { synchronized: true, checkedAt: this.now(), monitoredGroupIds: settings.monitoredGroupIds,
        availableGroupIds: settings.monitoredGroupIds.filter(id => available.has(id)), unavailableGroupIds: missing,
        complete: false, historyImported: false, detail: 'Seleção e assinatura do monitoramento reaplicadas. Esta ação não importa mensagens antigas nem comprova o histórico completo.' };
    } catch (error) { if (adapter === this.adapter && mode === this._mode()) this._captureFailure({ code: error.code || 'SEARCH_SYNC_ERROR', detail: 'Não foi possível verificar os grupos da sessão. A tela não foi preenchida com grupos fictícios.' }); throw error; }
  }

  async testCapture(actorId) {
    this._assert(actorId, 'manage');
    const settings = this._settings();
    if (!settings.monitoredGroupIds.length) fail('Selecione ao menos um grupo real para monitorar.', 'SEARCH_GROUP_REQUIRED');
    const synchronization = await this.synchronizeNow(actorId);
    if (!synchronization.availableGroupIds.length) fail('Nenhum grupo selecionado está disponível na sessão conectada.', 'SEARCH_GROUPS_UNAVAILABLE');
    const captureProbe = { id: randomUUID(), startedAt: this.now(), expiresAt: this.now() + 120000,
      status: 'waiting', groupIds: synchronization.availableGroupIds };
    this.monitor.captureProbe = captureProbe; this._persistMonitor(); this.emit('change');
    return { ...captureProbe, verified: false, simulated: this._mode() === 'simulated',
      detail: 'Monitoramento preparado. Publique um texto com aparelho e preço em um grupo selecionado dentro de 2 minutos; a captura será confirmada somente quando o evento real for salvo.' };
  }
}

function parseSearchCommand(text) {
  let query = String(text || '').trim(), format = 'text';
  const match = query.match(/^--(excel|ambos)(?:\s+|$)/i);
  if (match) { format = match[1].toLowerCase() === 'excel' ? 'excel' : 'both'; query = query.slice(match[0].length).trim(); }
  return { query, format };
}

function formatSearchResults(answer, settings) {
  const timezone = settings.timezone || 'America/Sao_Paulo';
  const date = value => new Date(value).toLocaleString('pt-BR', { timeZone: timezone });
  const published = value => `${new Date(value).toLocaleDateString('pt-BR', { timeZone: timezone, day: '2-digit', month: '2-digit' })} às ${new Date(value).toLocaleTimeString('pt-BR', { timeZone: timezone, hour: '2-digit', minute: '2-digit' })}`;
  const money = value => (value / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const age = answer.period.maxAgeMinutes;
  const ageLabel = age == null ? 'Sem limite de idade — base capturada e retida' : age % 60 === 0 ? `Ofertas das últimas ${age / 60} hora${age === 60 ? '' : 's'}` : `Ofertas dos últimos ${age} minuto${age === 1 ? '' : 's'}`;
  const ordering = settings.sort === 'recent' ? 'Ordenadas pelas mais recentes' : settings.sort === 'cashDescending' ? 'Ordenadas pelo maior preço' : 'Ordenadas pelo menor preço';
  const header = answer.guidance || `🔎 RESULTADO DA BUSCA\n📱 ${answer.query}\n🕒 ${ageLabel}\n🗓️ Período consultado: ${answer.period.from == null ? 'sem início limitado' : date(answer.period.from)} a ${date(answer.period.to)}\n💰 ${ordering}\n📊 Encontradas ${answer.count} oferta${answer.count === 1 ? '' : 's'}${answer.warnings.length ? `\n${answer.warnings.join('\n')}` : ''}`;
  const indexes = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
  const blocks = answer.results.map((offer, index) => {
    const realPhone = phone(offer.supplierPhone), informed = phone(offer.contactPhone || offer.offerPhone);
    let names = offer.supplierName || offer.displayName || offer.savedName || 'Nome indisponível';
    if (offer.savedName && offer.displayName && offer.savedName !== offer.displayName) names = `${offer.savedName} (WhatsApp: ${offer.displayName})`;
    if (offer.forwarded) names += ' — republicador; fornecedor original desconhecido';
    const qualifier = offer.priceKind === 'from' ? 'a partir de' : offer.priceKind === 'lot' ? `preço para lote${offer.minPurchase ? `; mínimo ${offer.minPurchase} unidades` : ''}` : offer.priceQualifier;
    const lines = [`${indexes[index] || `${index + 1}.`} ${money(offer.priceCents)}${qualifier ? ` (${qualifier})` : ''}`, `📱 ${offer.model || offer.modelName || offer.modelKey} • ${offer.storageGB ? `${offer.storageGB}GB` : 'Capacidade não informada'}`];
    if (offer.color || offer.colorName || offer.colorKey) lines.push(`🎨 Cor: ${offer.color || offer.colorName || offer.colorKey}`);
    if (offer.condition) lines.push(`📦 Condição: ${offer.condition}`);
    if (Number.isFinite(offer.batteryPercent)) lines.push(`🔋 Bateria: ${offer.batteryPercent}%`);
    if (offer.warranty) lines.push(`🛡️ Garantia: ${offer.warranty}`);
    lines.push(`👤 Fornecedor: ${names}`, `📞 ${offer.forwarded ? 'WhatsApp de quem republicou' : 'WhatsApp'}: ${realPhone || 'Número indisponível'}`);
    if (realPhone && !offer.forwarded) lines.push(`🔗 https://wa.me/${realPhone}`);
    if (offer.contactInOffer || informed) lines.push(`Contato informado na oferta: ${offer.contactInOffer || informed}${informed ? `\n🔗 https://wa.me/${informed}` : ''}`);
    lines.push(`👥 Grupo: ${offer.groupName || offer.groupId || 'Grupo indisponível'}`, `📅 Publicado em: ${published(offer.originalAt || offer.messageAt)}`, `📝 Oferta original: “${String(offer.snippet || offer.originalText || '').slice(0, 1800)}”`);
    if (answer.period.to - (offer.originalAt || offer.messageAt) > 86400000) lines.push('⚠️ Oferta com mais de 24 horas');
    return lines.join('\n');
  });
  if (!answer.guidance && !answer.results.length) blocks.push('Não foram encontradas ofertas compatíveis com os filtros informados.');
  blocks.push('Valores conforme anúncios capturados. Confirme disponibilidade e condições com o fornecedor.');
  const chunks = []; let current = header;
  for (const block of blocks) { if (current.length + block.length + 2 > 3500) { chunks.push(current); current = block; } else current += `\n\n${block}`; }
  if (current) chunks.push(current); return chunks.length > 1 ? chunks.map((text, index) => `📄 Parte ${index + 1}/${chunks.length}\n\n${text}`) : chunks;
}

module.exports = { parseSearchCommand, SearchService, DEFAULT_SEARCH_SETTINGS, validateSearchSettings, validateFilters, parseZonedTime, formatSearchResults };
