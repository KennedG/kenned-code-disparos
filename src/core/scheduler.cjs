'use strict';

const { EventEmitter } = require('node:events');
const { randomUUID, randomBytes } = require('node:crypto');
const { assertCampaignSchemaCompatible } = require('./campaign-schema-compat.cjs');
const { localParts, localEpoch } = require('./reminders.cjs');
const ITEM_TYPES = new Set(['text', 'image', 'video', 'document']);

function dateKey(value, timezone) {
  if (timezone) { const p = localParts(Number(new Date(value)), timezone); return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`; }
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function minutesOf(time, fallback) {
  if (time === undefined || time === '') return fallback;
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

function scheduleParts(schedule = {}) {
  return {
    days: schedule.days ?? [0, 1, 2, 3, 4, 5, 6],
    start: minutesOf(schedule.startTime, 0),
    end: minutesOf(schedule.endTime, 0),
    startDate: schedule.startDate || '',
    endDate: schedule.endDate || '',
    timezone: schedule.timezone || null
  };
}

// An overnight window belongs to the weekday/date on which it opens.
function isWithinSchedule(timestamp, schedule = {}) {
  const p = scheduleParts(schedule);
  const local = p.timezone ? localParts(timestamp, p.timezone) : null;
  const d = local ? new Date(Date.UTC(local.year, local.month - 1, local.day)) : new Date(timestamp);
  const minute = local ? local.hour * 60 + local.minute : d.getHours() * 60 + d.getMinutes();
  if (p.start !== p.end) {
    if (p.start < p.end && (minute < p.start || minute >= p.end)) return false;
    if (p.start > p.end) {
      if (minute >= p.end && minute < p.start) return false;
      if (minute < p.end) { if (local) d.setUTCDate(d.getUTCDate() - 1); else d.setDate(d.getDate() - 1); }
    }
  }
  const key = local ? d.toISOString().slice(0, 10) : dateKey(d);
  return p.days.includes(local ? d.getUTCDay() : d.getDay()) && (!p.startDate || key >= p.startDate) && (!p.endDate || key <= p.endDate);
}

function nextScheduledAt(timestamp, schedule = {}) {
  if (isWithinSchedule(timestamp, schedule)) return timestamp;
  const p = scheduleParts(schedule);
  if (!p.days.length) return Infinity;
  if (p.timezone) {
    const local = localParts(timestamp, p.timezone);
    let cursor = new Date(Date.UTC(local.year, local.month - 1, local.day));
    if (p.startDate && cursor.toISOString().slice(0, 10) < p.startDate) cursor = new Date(`${p.startDate}T00:00:00Z`);
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const time = `${String(Math.floor(p.start / 60)).padStart(2, '0')}:${String(p.start % 60).padStart(2, '0')}`;
    for (let i = 0; i < 10; i++) {
      const candidate = localEpoch({ year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1, day: cursor.getUTCDate() }, time, p.timezone);
      if (candidate !== null && candidate >= timestamp && isWithinSchedule(candidate, schedule)) return candidate;
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      if (p.endDate && cursor.toISOString().slice(0, 10) > p.endDate) break;
    }
    return Infinity;
  }
  let cursor = new Date(timestamp);
  if (p.startDate && dateKey(cursor) < p.startDate) {
    const [y, m, d] = p.startDate.split('-').map(Number);
    cursor = new Date(y, m - 1, d);
  }
  // A weekly schedule needs at most eight local days. Calendar arithmetic
  // deliberately handles timezone/DST changes instead of adding 24 hours.
  cursor.setDate(cursor.getDate() - 1);
  for (let i = 0; i < 10; i++) {
    const candidate = new Date(cursor);
    candidate.setHours(Math.floor(p.start / 60), p.start % 60, 0, 0);
    if (candidate.getTime() >= timestamp && isWithinSchedule(candidate.getTime(), schedule)) return candidate.getTime();
    cursor.setDate(cursor.getDate() + 1);
    if (p.endDate && dateKey(cursor) > p.endDate) break;
  }
  return Infinity;
}

function nextLocalDay(timestamp, timezone) {
  if (timezone) {
    const p = localParts(timestamp, timezone), next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
    const day = { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
    for (let minute = 0; minute <= 180; minute++) { const at = localEpoch(day, `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`, timezone); if (at !== null) return at; }
    throw new Error('Não foi possível calcular a abertura do próximo dia no fuso configurado.');
  }
  const d = new Date(timestamp);
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function nextRoundSlot(startedAt, finishedAt, intervalMs) {
  return startedAt + Math.max(1, Math.ceil((finishedAt - startedAt) / intervalMs)) * intervalMs;
}

function defaultSleep(ms, signal) {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

class Scheduler extends EventEmitter {
  constructor({ store, adapter, now = () => Date.now(), sleep = defaultSleep, licenseGuard = () => {}, attemptTimeoutMs }) {
    super();
    this.store = store;
    this.now = now;
    this.sleep = sleep;
    this.licenseGuard = licenseGuard;
    this.timer = null;
    this.worker = null;
    this.busy = false;
    this.persistenceFailed = false;
    this.currentRound = null;
    this.lastSubmissionAt = null;
    this.closed = false;
    this.submissionHolds = 0;
    this.externalSubmissions = Promise.resolve();
    this.externalPending = new Set();
    this.externalInFlight = 0;
    this.campaignInFlight = 0;
    this.automationBlocked = store.getSetting?.('automationState', {})?.stopped === true;
    this.receipts = new Map();
    this.attemptTimeoutMs = attemptTimeoutMs;
    this.detachedAttempts = new Set();
    this.manualRetries = new Map();
    // Defense in depth: constructing a worker never replays an old queue.
    const interrupted = new Set();
    for (const job of [...store.listJobs({ status: 'sending', limit: 1000000 }), ...store.listJobs({ status: 'queued', limit: 1000000 })]) {
      if (job.status === 'sending' || job.status === 'queued') {
        this._persist('updateJob', job.id, {
          status: job.status === 'sending' ? 'uncertain' : 'cancelled',
          resultAt: now(), error: 'Execução anterior interrompida; nenhum reenvio automático.'
        });
        interrupted.add(job.campaignId);
      }
    }
    for (const id of interrupted) {
      const campaign = store.getCampaign(id);
      if (campaign?.state === 'active') this._persist('saveCampaign', { ...campaign, state: 'paused', nextRunAt: null });
    }
    this.setAdapter(adapter);
  }

  setAdapter(adapter) {
    if (this.adapter) {
      this.adapter.off('status', this.statusListener);
      this.adapter.off('receipt', this.receiptListener);
      this._pauseActive('Integração alterada; retome após conferir a conexão.');
    }
    this.adapter = adapter;
    this.setAutomationBlocked(this.store.getSetting?.('automationState', {})?.stopped === true);
    this.receipts.clear();
    this.lastSubmissionAt=null;
    this.statusListener = status => {
      if (status.state !== 'connected') this._pauseActive(`Conexão indisponível: ${status.state}.`);
      this.emit('change');
    };
    this.receiptListener = receipt => {
      if (receipt.status === 'failed' && receipt.messageId && receipt.confirmedFailure === true) {
        try {
          for (const job of this.store.listJobs({ messageId: receipt.messageId, limit: 1000000 })) {
            if (!['sending', 'uncertain'].includes(job.status)) continue;
            this._persist('updateJob', job.id, { status: 'failed', resultAt: this.now(), errorCode: receipt.code || 'SEND_CONFIRMED_REJECTION', error: 'A integração confirmou que a mensagem não foi aceita.' });
            if (receipt.groupScoped === true || receipt.destinationUnavailable === true) this._destinationFailure(job, receipt);
          }
        } catch { this._failClosed(); }
        this.emit('change');
        return;
      }
      if (!['confirmed', 'accepted', 'delivered'].includes(receipt.status) || !receipt.messageId) return;
      this.receipts.set(receipt.messageId, receipt);
      if (this.receipts.size > 1000) this.receipts.delete(this.receipts.keys().next().value);
      try {
        for (const job of this.store.listJobs({ messageId: receipt.messageId, limit: 1000000 })) this._recordProof(job, receipt, { reconciled: true });
      } catch { this._failClosed(); }
      this.emit('change');
    };
    adapter.on('status', this.statusListener);
    adapter.on('receipt', this.receiptListener);
  }

  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => {
      this.tick().catch(error => { this.emit('change', { error: error.message }); });
    }, 1000);
    this.timer.unref?.();
  }

  _connected() { return !this.store.persistenceFailed && this.adapter?.status?.state === 'connected'; }

  blockOnPersistenceFailure() { this._failClosed(); }

  _failClosed() {
    // Cancelling the runtime queue cannot depend on a working disk. Latch this
    // before any best-effort status writes so a later successful write cannot
    // accidentally allow another network submission.
    this.currentRound?.controller.abort();
    if (this.persistenceFailed) return;
    this.persistenceFailed = true;
    if (!this.store.persistenceFailed) {
      try { this._pauseActive('Falha de persistência; reinicie e confira o histórico.'); }
      catch { /* The queue is already blocked even if storage cannot be read. */ }
    }
    this.emit('change', { error: 'Falha de persistência; envios bloqueados até reiniciar o aplicativo.' });
  }

  _persist(method, ...args) {
    try { return this.store[method](...args); }
    catch (error) { this._failClosed(); throw error; }
  }

  _groupConfig(campaign, groupId) {
    const override = campaign.groupOverrides?.[groupId];
    const timezone = campaign.schedule?.timezone || (campaign.sourceManaged ? campaign.sourceTimezone || 'America/Sao_Paulo' : null);
    const schedule = { ...(campaign.schedule || {}), ...(timezone ? { timezone } : {}) };
    if (!override?.enabled) return { intervalMinutes: campaign.intervalMinutes, schedule, items: campaign.items || [] };
    return {
      intervalMinutes: override.intervalMinutes ?? campaign.intervalMinutes,
      schedule: { ...schedule, ...(override.schedule || {}) },
      items: Array.isArray(override.items) && override.items.length ? override.items : campaign.items || []
    };
  }

  _validateSchedule(schedule = {}) {
    const p = scheduleParts(schedule);
    if (p.timezone) { try { localParts(0, p.timezone); } catch { throw new Error('Informe um fuso horário válido para a campanha.'); } }
    if (!Array.isArray(p.days) || !p.days.length || p.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('Selecione dias da semana válidos.');
    if (!Number.isFinite(p.start) || !Number.isFinite(p.end)) throw new Error('Informe os horários no formato HH:mm.');
    for (const value of [p.startDate, p.endDate]) {
      if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || dateKey(new Date(`${value}T12:00:00`)) !== value)) throw new Error('Informe datas válidas no formato AAAA-MM-DD.');
    }
    if (p.startDate && p.endDate && p.startDate > p.endDate) throw new Error('A data de encerramento deve ser posterior ao início.');
  }

  _validateCampaign(campaign) {
    if (!campaign) throw new Error('Campanha não encontrada.');
    assertCampaignSchemaCompatible(campaign);
    if(campaign.storageMode&&campaign.storageMode!==this.adapter.status.mode)throw new Error('A campanha pertence a outro modo de integração.');
    if (!campaign.name?.trim()) throw new Error('Informe um nome para a campanha.');
    if (!['repeat', 'rotate'].includes(campaign.mode)) throw new Error('Escolha repetir ou alternar os conteúdos.');
    const retries = campaign.retryPolicy || { maxAttempts: 3, delaySeconds: 3 };
    if (!Number.isInteger(retries.maxAttempts) || retries.maxAttempts < 1 || retries.maxAttempts > 5 || !Number.isFinite(retries.delaySeconds) || retries.delaySeconds < 3 || retries.delaySeconds > 3600) throw new Error('Configure entre 1 e 5 tentativas, com intervalo entre 3 e 3600 segundos.');
    if (retries.backoffFactor !== undefined && (!Number.isFinite(retries.backoffFactor) || retries.backoffFactor < 1 || retries.backoffFactor > 10)) throw new Error('O fator progressivo das tentativas deve estar entre 1 e 10.');
    if (!Number.isFinite(campaign.intervalMinutes) || campaign.intervalMinutes < 1) throw new Error('O intervalo entre rodadas deve ser de pelo menos 1 minuto.');
    const minimumSpacing = Math.max(3, this.adapter.minimumSpacingSeconds ?? 3);
    if (!Number.isFinite(campaign.spacingSeconds) || campaign.spacingSeconds < minimumSpacing) throw new Error(`O espaçamento deve ser de pelo menos ${minimumSpacing} segundo(s).`);
    for (const value of [campaign.messageSpacingSeconds, campaign.groupSpacingSeconds]) if (value !== undefined && (!Number.isFinite(value) || value < minimumSpacing)) throw new Error(`Os intervalos entre mensagens e entre grupos devem ser de pelo menos ${minimumSpacing} segundo(s).`);
    if (campaign.sendTimeoutSeconds !== undefined && (!Number.isFinite(campaign.sendTimeoutSeconds) || campaign.sendTimeoutSeconds < 5 || campaign.sendTimeoutSeconds > 300)) throw new Error('O tempo limite por envio deve estar entre 5 e 300 segundos.');
    if (campaign.maxRounds !== undefined && (!Number.isInteger(campaign.maxRounds) || campaign.maxRounds < 0)) throw new Error('O limite de rodadas deve ser um inteiro igual ou maior que zero.');
    const maxGroups = Number(this.store.getSetting('maxSelectedGroups', 15));
    if (!Array.isArray(campaign.groupIds) || !campaign.groupIds.length || campaign.groupIds.length > maxGroups) throw new Error(`Selecione entre 1 e ${maxGroups} grupos.`);
    if (new Set(campaign.groupIds).size !== campaign.groupIds.length) throw new Error('A seleção contém grupos repetidos.');
    this._validateSchedule(campaign.schedule);
    for (const field of ['dailyRoundLimit', 'dailySendLimit']) {
      if (campaign[field] !== undefined && (!Number.isInteger(campaign[field]) || campaign[field] < 0)) throw new Error('Os limites diários devem ser inteiros iguais ou maiores que zero.');
    }
    for (const groupId of campaign.groupIds) {
      const group = this.store.getGroup(groupId);
      if (!group?.authorized) throw new Error('Todos os grupos precisam de autorização para publicar.');
      if (Boolean(group.simulation) !== (this.adapter.status.mode === 'simulated')) throw new Error('Grupos simulados e reais não podem ser misturados.');
      const config = this._groupConfig(campaign, groupId);
      if (!Number.isFinite(config.intervalMinutes) || config.intervalMinutes < 1) throw new Error('O intervalo individual deve ser de pelo menos 1 minuto.');
      this._validateSchedule(config.schedule);
      if (!config.items.length) throw new Error('Adicione pelo menos um conteúdo à campanha.');
      const ids = new Set();
      for (const item of config.items) {
        if (!item.id || ids.has(item.id)) throw new Error('Cada conteúdo deve ter um identificador único.');
        ids.add(item.id);
        if (!ITEM_TYPES.has(item.type)) throw new Error('Tipo de conteúdo não suportado.');
        if (item.type === 'text' && !item.text?.trim()) throw new Error('Uma mensagem de texto está vazia.');
        if (item.type !== 'text' && !this.store.getMedia(item.mediaId)) throw new Error('Uma mídia não existe na biblioteca gerenciada.');
      }
    }
  }

  _eligibleItems(campaign, groupId) {
    // Read the indexed uncertain ledger once per destination, rather than
    // repeating the same database query for every item in a large campaign.
    const unresolved = new Set(this.store.listJobs({ campaignId: campaign.id, groupId, status: 'uncertain', limit: 1000000 }).filter(job => !job.manualResendJobId).map(job => job.itemId));
    return this._groupConfig(campaign, groupId).items.filter(item => item.ready !== false && !item.captureDeleted && !['pending', 'error', 'review'].includes(item.captureStatus) && !unresolved.has(item.id));
  }

  _itemStillConfigured(job) {
    const campaign = this.store.getCampaign(job.campaignId);
    if (!campaign) return false;
    return this._groupConfig(campaign, job.groupId).items.some(item => item.id === job.itemId && !item.captureDeleted && item.ready !== false && !['pending', 'error', 'review'].includes(item.captureStatus));
  }

  _counts(campaignId, at) {
    const campaign = this.store.getCampaign(campaignId), timezone = campaign?.schedule?.timezone || (campaign?.sourceManaged ? campaign.sourceTimezone || 'America/Sao_Paulo' : null);
    if (this.store.getCampaignCounts) return this.store.getCampaignCounts(campaignId, at, { timezone });
    const key = dateKey(at, timezone);
    const rounds = this.store.listRounds(campaignId).filter(r => dateKey(r.startedAt, timezone) === key).length;
    const sends = this.store.listJobs({ campaignId, limit: 1000000 }).filter(j => j.attempts > 0 && dateKey(j.firstAttemptAt ?? j.createdAt, timezone) === key).length;
    return { rounds, sends };
  }

  _history(campaign) {
    if (this.store.getGroupHistory) {
      const result = this.store.getGroupHistory(campaign.id);
      return new Map([...result].map(([id, value]) => [id, { ...value, roundCount: value.roundCount ?? value.rounds?.size ?? value.roundsSet?.size ?? 0 }]));
    }
    const rounds = new Map(this.store.listRounds(campaign.id).map(r => [r.id, r]));
    const byGroup = new Map();
    for (const job of this.store.listJobs({ campaignId: campaign.id, limit: 1000000 })) {
      if (!(job.attempts > 0) && !['confirmed', 'uncertain', 'sending'].includes(job.status)) continue;
      const round = rounds.get(job.roundId);
      if (!round) continue;
      let history = byGroup.get(job.groupId);
      if (!history) byGroup.set(job.groupId, history = { lastAt: null, rounds: new Set() });
      history.lastAt = Math.max(history.lastAt ?? -Infinity, round.startedAt);
      history.rounds.add(round.id);
    }
    return byGroup;
  }

  _nextEligibleAt(campaign, at, { afterRound = false } = {}) {
    if ((campaign.maxRounds && (campaign.roundIndex || 0) >= campaign.maxRounds) || (campaign.endAt && at >= campaign.endAt)) return Infinity;
    const counts = this._counts(campaign.id, at);
    let lower = at;
    if ((campaign.dailyRoundLimit && counts.rounds >= campaign.dailyRoundLimit) || (campaign.dailySendLimit && counts.sends >= campaign.dailySendLimit)) lower = nextLocalDay(at, campaign.schedule?.timezone || (campaign.sourceManaged ? campaign.sourceTimezone || 'America/Sao_Paulo' : null));
    const history = this._history(campaign);
    let next = Infinity;
    for (const groupId of campaign.groupIds) {
      if (campaign.destinationHealth?.[groupId]?.suspended || !this._eligibleItems(campaign, groupId).length) continue;
      const config = this._groupConfig(campaign, groupId);
      const last = history.get(groupId)?.lastAt;
      const interval = config.intervalMinutes * 60000;
      const due = last === undefined || last === null ? lower : afterRound ? nextRoundSlot(last, at, interval) : last + interval;
      const scheduled = nextScheduledAt(Math.max(lower, due), config.schedule);
      if (!campaign.endAt || scheduled < campaign.endAt) next = Math.min(next, scheduled);
    }
    return next;
  }

  async activate(id) {
    if (this.closed) throw new Error('O agendador está encerrado.');
    this.licenseGuard();
    if (this._automationStopped()) throw this._automationError();
    if (this.store.persistenceFailed) this.blockOnPersistenceFailure();
    if (this.persistenceFailed) throw new Error('O agendador foi bloqueado após uma falha de persistência. Reinicie o aplicativo e confira o histórico.');
    const campaign = this.store.getCampaign(id);
    this._validateCampaign(campaign);
    if (!this._connected()) throw new Error('Conecte o WhatsApp ou o modo simulado antes de ativar.');
    if (campaign.state === 'active') return campaign;
    const next = this._nextEligibleAt(campaign, this.now());
    if (!Number.isFinite(next)) throw new Error('Não há horário futuro disponível na programação.');
    this._persist('saveCampaign', { ...campaign, state: 'active', nextRunAt: next, pauseReason: null, pausedAt: null });
    this.emit('change');
    return this.store.getCampaign(id);
  }

  async resume(id) { return this.activate(id); }

  _cancelQueued(campaignId, reason) {
    for (const job of this.store.listJobs({ campaignId, status: 'queued', limit: 1000000 })) this._persist('updateJob', job.id, { status: 'cancelled', error: reason, resultAt: this.now() });
  }

  async pause(id, reason = 'Campanha pausada pelo administrador.') {
    if (this.currentRound?.campaignId === id) this.currentRound.controller.abort();
    const campaign = this.store.getCampaign(id);
    if (!campaign) throw new Error('Campanha não encontrada.');
    if (['active', 'paused'].includes(campaign.state)) this._persist('saveCampaign', { ...campaign, state: 'paused', nextRunAt: null, pauseReason: reason, pausedAt: this.now() });
    this._cancelQueued(id, reason);
    this.emit('change');
  }

  _pauseActive(reason) {
    if (this.store.persistenceFailed) { this.blockOnPersistenceFailure(); return; }
    for (const campaign of this.store.listCampaigns()) {
      if (campaign.state === 'active') {
        // An event listener must not create an unhandled rejection if the disk
        // is unavailable. _persist already aborts and latches the runtime gate.
        void this.pause(campaign.id, reason).catch(() => {});
      }
    }
  }

  async stopAll() {
    // Stop the current worker before touching any campaign on disk, including
    // a different campaign that happens to appear first in the database.
    this.currentRound?.controller.abort();
    let campaigns = 0, jobs = 0;
    for (const campaign of this.store.listCampaigns()) {
      if (['active', 'paused'].includes(campaign.state)) { this._persist('saveCampaign', { ...campaign, state: 'stopped', nextRunAt: null }); campaigns++; }
      jobs += this.store.listJobs({ campaignId: campaign.id, status: 'queued', limit: 1000000 }).length;
      this._cancelQueued(campaign.id, 'Todos os envios foram interrompidos.');
    }
    this.emit('change');
    return { campaigns, cancelled: jobs, jobs, inFlight: this.campaignInFlight };
  }

  async waitForIdle() {
    // A synchronous transport event can run before tick assigns its promise.
    // Yield one microtask in that case, then wait for the actual settlement.
    while (this.busy) {
      if (this.worker) await this.worker;
      else await Promise.resolve();
    }
  }

  holdSubmissions() {
    this.submissionHolds++;
    let released = false;
    return () => { if (!released) { released = true; this.submissionHolds = Math.max(0, this.submissionHolds - 1); } };
  }

  _automationStopped() { return this.automationBlocked || this.store.getSetting?.('automationState', {})?.stopped === true; }

  _automationError() { return Object.assign(new Error('Envios automáticos bloqueados: o sistema foi interrompido. Use !mega retomar sistema ou a retomada explícita no aplicativo.'), { code: 'AUTOMATION_STOPPED', safeToRetry: false, definitive: true, submitted: false }); }

  setAutomationBlocked(blocked) {
    this.automationBlocked = blocked === true;
    if (!this.automationBlocked) return;
    this.currentRound?.controller.abort();
    for (const entry of this.externalPending || []) {
      if (entry.manual || entry.cancelled) continue;
      entry.controller?.abort();
      if (entry.started) continue;
      entry.cancelled = true;
      entry.reject(this._automationError());
    }
  }

  getInFlightCount() { return this.externalInFlight + this.campaignInFlight; }
  getCampaignInFlightCount() { return this.campaignInFlight; }

  _timeoutMs(campaign) {
    if (Number.isFinite(this.attemptTimeoutMs) && this.attemptTimeoutMs > 0) return this.attemptTimeoutMs;
    const seconds = campaign?.sendTimeoutSeconds ?? this.store.getSetting?.('submissionTimeoutSeconds', 30) ?? 30;
    return Math.max(5, Math.min(300, Number(seconds) || 30)) * 1000;
  }

  getAttemptTimeoutMs(campaign) { return this._timeoutMs(campaign); }

  runBoundedAttempt(task, { timeoutMs, onLateResult, onLateError, signal: parentSignal } = {}) {
    const controller = new AbortController();
    const duration = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : this._timeoutMs();
    const abort = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) abort();
    else parentSignal?.addEventListener('abort', abort, { once: true });
    let expired = false, timer;
    const beforeSubmit = () => {
      if (controller.signal.aborted) throw Object.assign(new Error('Tentativa encerrada antes de submeter a mensagem.'), { code: 'SUBMISSION_ABORTED', submitted: false, definitive: true, safeToRetry: false });
    };
    // Invoke synchronously, before yielding, preserving the single-worker lock.
    let transport;
    try { transport = Promise.resolve(task({ signal: controller.signal, timeoutMs: duration, beforeSubmit })); }
    catch (error) { transport = Promise.reject(error); }
    const detached = { controller, transport };
    this.detachedAttempts.add(detached);
    transport.then(result => {
      if (expired && !this.closed && onLateResult) return onLateResult(result);
    }, error => {
      if (expired && !this.closed && onLateError) return onLateError(error);
    }).catch(() => { this._failClosed(); }).finally(() => this.detachedAttempts.delete(detached));
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        controller.abort();
        this.detachedAttempts.delete(detached);
        reject(Object.assign(new Error('Tempo limite excedido; resultado incerto. Nenhum reenvio automático.'), { code: 'SUBMISSION_TIMEOUT', submitted: 'unknown', definitive: false, safeToRetry: false }));
      }, duration);
    });
    return Promise.race([transport, deadline]).finally(() => { clearTimeout(timer); parentSignal?.removeEventListener('abort', abort); });
  }

  runExternalSubmission(task, { manual = false, controlOnly = false, timeoutMs, onLateResult, onLateError } = {}) {
    // All private alerts and search results share this queue. Holding the
    // scheduler immediately prevents a new campaign round taking their slot.
    try{if(!controlOnly)this.licenseGuard();}catch(error){return Promise.reject(error);}
    if (!manual && this._automationStopped()) return Promise.reject(this._automationError());
    const release = this.holdSubmissions();
    let resolve, reject;
    const result = new Promise((done, fail) => { resolve = done; reject = fail; });
    const entry = { manual: manual === true, started: false, cancelled: false, resolve, reject, controller: new AbortController() };
    this.externalPending.add(entry);
    const operation = this.externalSubmissions.catch(() => {}).then(async () => {
      if (entry.cancelled) return;
      await this.waitForIdle();
      if (entry.cancelled) return;
      if (this.closed || this.persistenceFailed || this.store.persistenceFailed) throw new Error('Envios externos bloqueados: processamento indisponível.');
      if(!controlOnly)this.licenseGuard();
      if (!entry.manual && this._automationStopped()) throw this._automationError();
      entry.started = true;
      this.externalInFlight++;
      try { return await this.runBoundedAttempt(context => {
        const beforeSubmit = () => {
          context.beforeSubmit();
          if (this.closed || this.persistenceFailed || this.store.persistenceFailed) throw Object.assign(new Error('Envios externos bloqueados: processamento indisponível.'), { code: 'SUBMISSION_SERVICE_CLOSED', definitive: true, submitted: false, safeToRetry: false });
          if (!controlOnly) this.licenseGuard();
          if (!entry.manual && this._automationStopped()) throw this._automationError();
        };
        beforeSubmit();
        return task({ ...context, beforeSubmit });
      }, { timeoutMs, onLateResult, onLateError, signal: entry.controller.signal }); }
      finally { this.externalInFlight--; }
    });
    this.externalSubmissions = operation.catch(() => {});
    operation.then(resolve, reject).finally(() => this.externalPending.delete(entry));
    return result.finally(release);
  }

  tick() {
    if (this.store.persistenceFailed) this.blockOnPersistenceFailure();
    try{this.licenseGuard();}catch{return Promise.resolve();}
    if (this.closed || this.persistenceFailed || this.submissionHolds || this._automationStopped()) return Promise.resolve();
    // Lock before invoking _tick: an adapter may synchronously emit an event
    // that calls tick again, before the worker promise has been assigned.
    if (this.busy) return this.worker || Promise.resolve();
    this.busy = true;
    this.worker = this._tick().catch(error => {
      this._failClosed();
      try {
        if (this.currentRound) this._persist('updateRound', this.currentRound.id, { status: 'interrupted', finishedAt: this.now() });
        this._pauseActive('Falha de persistência; reinicie e confira o histórico.');
      } catch { /* The disk may reject further writes. The worker stays blocked. */ }
      this.currentRound = null;
      throw error;
    }).finally(() => { this.worker = null; this.busy = false; });
    return this.worker;
  }

  async _tick() {
    if (!this._connected()) { this._pauseActive('Conexão indisponível.'); return; }
    const candidates = this.store.listCampaigns().filter(c => c.state === 'active' && (c.nextRunAt ?? 0) <= this.now()).sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0));
    for (const snapshot of candidates) {
      if (this.closed || this._automationStopped() || !this._connected()) break;
      const campaign = this.store.getCampaign(snapshot.id);
      if (campaign?.state !== 'active') continue;
      try { this._validateCampaign(campaign); }
      catch (error) { await this.pause(campaign.id, error.message); continue; }
      const due = this._nextEligibleAt(campaign, this.now());
      if (due > this.now()) {
        this._persist('saveCampaign', { ...campaign, state: Number.isFinite(due) ? 'active' : 'stopped', nextRunAt: Number.isFinite(due) ? due : null });
        this.emit('change');
        continue;
      }
      await this._runRound(campaign);
    }
  }

  _maySend(campaignId, groupId, { manual = false } = {}) {
    try{this.licenseGuard();}catch{return false;}
    if (this.store.persistenceFailed) { this.blockOnPersistenceFailure(); return false; }
    const campaign = this.store.getCampaign(campaignId);
    const group = this.store.getGroup(groupId);
    return !this.closed && !this.persistenceFailed && !this._automationStopped() && this._connected() && (campaign?.state === 'active' || (manual && campaign?.state === 'paused')) && campaign.groupIds.includes(groupId) && !campaign.destinationHealth?.[groupId]?.suspended && group?.authorized && Boolean(group.simulation) === (this.adapter.status.mode === 'simulated');
  }

  async _wait(ms, signal) {
    if (signal.aborted || ms <= 0) return;
    let listener;
    const cancelled = new Promise(resolve => { listener = resolve; signal.addEventListener('abort', listener, { once: true }); });
    try { await Promise.race([this.sleep(ms, signal), cancelled]); }
    finally { signal.removeEventListener('abort', listener); }
  }

  _recordProof(job, proof, { reconciled = false } = {}) {
    if (!proof || !['confirmed', 'accepted', 'delivered'].includes(proof.status)) return false;
    if (proof.status === 'accepted' && !proof.messageId && !proof.accepted && !proof.proofAccepted) return false;
    const live = this.store.getJob(job.id);
    if (!live || !(live.attempts > 0)) return false;
    const messageId = proof.messageId || live.messageId;
    if (messageId !== live.messageId && messageId !== live.clientMessageId && live.messageId !== job.messageId) return false;
    const delivered = proof.status === 'delivered' || proof.delivered === true || Number.isFinite(proof.deliveredAt);
    const status = delivered || live.status === 'delivered' ? 'delivered' : 'accepted';
    const patch = {
      status, messageId, clientMessageId: live.clientMessageId || job.messageId,
      acceptedAt: live.acceptedAt || proof.acceptedAt || this.now(), resultAt: this.now(),
      proofAccepted: true, reconciled, error: null, errorCode: null,
      confirmationScope: proof.confirmationScope || live.confirmationScope || (proof.simulation ? 'simulation-only' : 'integration-accepted')
    };
    if (delivered) patch.deliveredAt = live.deliveredAt || proof.deliveredAt || this.now();
    if (Number.isFinite(proof.readAt)) patch.readAt = proof.readAt;
    this._persist('updateJob', live.id, patch);
    this.emit('change');
    return true;
  }

  _destinationFailure(job, error) {
    const campaign = this.store.getCampaign(job.campaignId);
    if (!campaign) return;
    const code = /^[A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'DESTINATION_SEND_FAILED';
    const reasons = {
      GROUP_NOT_PARTICIPANT: 'A conta conectada não participa mais do grupo.',
      GROUP_NOT_ACCESSIBLE: 'O grupo não está acessível para a conta conectada.',
      GROUP_ADMIN_ONLY: 'O grupo permite mensagens apenas de administradores e a conta conectada não é administradora.',
      GROUP_INVALID_ID: 'O identificador do grupo não é válido.',
      GROUP_ANNOUNCEMENT_ONLY: 'O grupo permite mensagens apenas de administradores e a conta conectada não é administradora.'
    };
    const canonical = code.replace(/^WA_/, '');
    const reason = reasons[canonical] || (error?.confirmed === true && typeof error?.reason === 'string' ? error.reason.slice(0, 500) : `Motivo não identificado; código técnico: ${code}.`);
    const previous = campaign.destinationHealth?.[job.groupId];
    const health = { ...(previous || {}), suspended: true, code, reason, confirmed: error?.confirmed === true || error?.confirmedFailure === true || Boolean(reasons[canonical]), at: this.now(), lastError: { code, reason, at: this.now() }, lastJobId: job.id, occurrences: (previous?.occurrences || 0) + 1 };
    this._persist('saveCampaign', { ...campaign, destinationHealth: { ...(campaign.destinationHealth || {}), [job.groupId]: health } });
    this.emit('destinationFailure', { campaignId: job.campaignId, campaignName: campaign.name, groupId: job.groupId, groupName: this.store.getGroup(job.groupId)?.name || job.groupId, itemId: job.itemId, itemLabel: job.itemSnapshot?.caption?.split('\n')[0] || job.itemSnapshot?.text?.split('\n')[0] || 'Mídia', code, reason, operationId: job.operationId || job.id, at: health.at, connectionAvailable: this._connected(), confirmed: health.confirmed });
    this.emit('change');
  }

  _recordDestinationAvailable(job, check) {
    if (check?.available !== true || check.canSend === false || check.confirmed !== true) return;
    const campaign = this.store.getCampaign(job.campaignId);
    const previous = campaign?.destinationHealth?.[job.groupId];
    // Automatic checks must never reactivate a destination suspended by a
    // previous failure. Explicit recheckDestination() owns that decision.
    if (!campaign || previous?.suspended === true) return;
    const at = this.now();
    if (previous?.confirmed === true && Number.isFinite(previous.checkedAt) && at - previous.checkedAt < 60000) return;
    const checkedAt = Number.isFinite(check.checkedAt) && check.checkedAt <= at ? check.checkedAt : at;
    const health = { ...(previous || {}), suspended: false, checkedAt, confirmed: true, code: 'GROUP_AVAILABLE', reason: 'A integração confirmou que a conta pode enviar neste grupo.' };
    this._persist('saveCampaign', { ...campaign, destinationHealth: { ...(campaign.destinationHealth || {}), [job.groupId]: health } });
    this.emit('change');
  }

  async _sendJob(job, signal) {
    const campaign = this.store.getCampaign(job.campaignId);
    const policy = campaign?.retryPolicy || { maxAttempts: 3, delaySeconds: 3 };
    try { assertCampaignSchemaCompatible(campaign, job.itemSnapshot); }
    catch (error) { if (error.code === 'CAMPAIGN_VERSION_REVIEW') return this._cancelVersionReviewJob(job, error); throw error; }
    const maySend = () => this._maySend(job.campaignId, job.groupId, { manual: job.manualResend === true }) && this._itemStillConfigured(job);
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      if (signal.aborted || !maySend()) return 'cancelled';
      const at = this.now();
      const live = this.store.getCampaign(job.campaignId);
      if (!isWithinSchedule(at, this._groupConfig(live, job.groupId).schedule)) return 'cancelled';
      const persisted = this.store.getJob(job.id);
      // Accepted, ambiguous and terminal tasks are never submitted a second time.
      if (persisted && !['queued'].includes(persisted.status)) return persisted.status;
      this._persist('updateJob', job.id, { status: 'sending', attempts: attempt, firstAttemptAt: job.firstAttemptAt ?? at, attemptStartedAt: at });
      job.firstAttemptAt ??= at;
      this.lastSubmissionAt = at;
      this.lastSubmissionGroupId = job.groupId;
      this.emit('change');
      if (signal.aborted || !maySend()) return 'cancelled';
      try {
        this.campaignInFlight++;
        let result;
        try {
          result = await this.runBoundedAttempt(async context => {
            const beforeSubmit = () => {
              context.beforeSubmit(); this.licenseGuard();
              assertCampaignSchemaCompatible(this.store.getCampaign(job.campaignId), job.itemSnapshot);
              if (signal.aborted || !maySend()) throw Object.assign(new Error('Campanha interrompida antes da submissão.'), { code: 'CAMPAIGN_SUBMISSION_BLOCKED', definitive: true, submitted: false, safeToRetry: false });
            };
            if (typeof this.adapter.getGroupPublishingStatus === 'function') {
              const check = await this.adapter.getGroupPublishingStatus(job.groupId, { force: false, signal: context.signal, timeoutMs: context.timeoutMs });
              if (check?.available === false || check?.canSend === false) throw Object.assign(new Error('Destino sem permissão de envio.'), { ...check, groupScoped: true, definitive: true, submitted: false, safeToRetry: check.temporary === true });
              beforeSubmit();
              this._recordDestinationAvailable(job, check);
            }
            beforeSubmit();
            return this.adapter.send(job.groupId, { ...job.itemSnapshot, clientMessageId: job.clientMessageId || job.messageId }, job.itemSnapshot.mediaId ? this.store.getMedia(job.itemSnapshot.mediaId) : null, { beforeSubmit, signal: context.signal, timeoutMs: context.timeoutMs, traceId: job.id });
          }, { timeoutMs: this._timeoutMs(live), signal, onLateResult: proof => {
            if (proof?.status === 'failed' && proof?.confirmedFailure === true) {
              const current = this.store.getJob(job.id);
              if (current?.status === 'uncertain') {
                this._persist('updateJob', job.id, { status: 'failed', resultAt: this.now(), errorCode: proof.code || 'SEND_CONFIRMED_REJECTION', error: 'A integração confirmou posteriormente que a mensagem foi rejeitada.' });
                if (proof.groupScoped === true || proof.destinationUnavailable === true) this._destinationFailure(job, proof);
              }
            } else this._recordProof(job, proof, { reconciled: true });
          }, onLateError: error => {
            const current = this.store.getJob(job.id);
            if (current?.status === 'uncertain' && error?.definitive === true && error?.submitted === false) this._persist('updateJob', job.id, { status: 'failed', resultAt: this.now(), errorCode: 'LATE_PRE_SUBMISSION_FAILURE', error: 'A integração confirmou posteriormente que a submissão não ocorreu.' });
          } });
        } finally { this.campaignInFlight--; }
        if (result?.status === 'failed' && result.confirmedFailure === true) throw Object.assign(new Error('A integração confirmou a rejeição da mensagem.'), { ...result, definitive: true });
        const receipt = this.receipts.get(result?.messageId || job.messageId);
        if (this._recordProof(job, receipt || result)) return this.store.getJob(job.id).status;
        // A receipt can race the adapter return. Never downgrade durable evidence.
        if (['accepted', 'delivered', 'confirmed'].includes(this.store.getJob(job.id)?.status)) return this.store.getJob(job.id).status;
        if (this.store.getJob(job.id)?.status === 'failed') return 'failed';
        this._persist('updateJob', job.id, { status: 'uncertain', messageId: result?.messageId || job.messageId, clientMessageId: job.clientMessageId || job.messageId, resultAt: this.now(), errorCode: 'SEND_UNCERTAIN', error: 'Resultado incerto; revise antes de qualquer reenvio.' });
        this._diagnostic(job, 'SEND_UNCERTAIN', 'A integração não confirmou o resultado.', attempt, 'Outras tarefas elegíveis continuam; este item não será reenviado sem revisão.');
        this.emit('change');
        return 'uncertain';
      } catch (error) {
        if (this.persistenceFailed || this.store.persistenceFailed) throw error;
        if (error?.code === 'CAMPAIGN_VERSION_REVIEW' && error.submitted === false) return this._cancelVersionReviewJob(job, error);
        if (['accepted', 'delivered', 'confirmed'].includes(this.store.getJob(job.id)?.status)) return this.store.getJob(job.id).status;
        if (this.store.getJob(job.id)?.status === 'failed') return 'failed';
        if (error?.submitted === false && (signal.aborted || !this._itemStillConfigured(job))) {
          this._persist('updateJob', job.id, { status: 'cancelled', resultAt: this.now(), errorCode: error.code || 'CAMPAIGN_SUBMISSION_BLOCKED', error: 'Campanha interrompida ou item retirado antes da submissão.' });
          this.emit('change');
          return 'cancelled';
        }
        const safeRetry = error?.safeToRetry === true && error?.submitted !== true && error?.submitted !== 'unknown';
        const definitive = safeRetry || error?.confirmedFailure === true || (error?.definitive === true && error?.submitted !== true && error?.submitted !== 'unknown');
        const restricted = this.adapter.status.state === 'restricted' || error?.restricted === true;
        const code = /^[A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : definitive ? 'SEND_FAILED' : 'SEND_UNCERTAIN';
        if (safeRetry && attempt < policy.maxAttempts && !restricted && !signal.aborted && this._connected()) {
          this._persist('updateJob', job.id, { status: 'queued', error: 'Falha confirmada anterior à submissão; tentativa limitada pendente.' });
          this._diagnostic(job, code, 'Falha temporária anterior à submissão.', attempt, 'Nova tentativa limitada, com intervalo progressivo.');
          await this._wait(Math.max(Math.min(3600000, policy.delaySeconds * 1000 * (policy.backoffFactor ?? 2) ** (attempt - 1)), (this.adapter.minimumSpacingSeconds ?? 3) * 1000), signal);
          continue;
        }
        const status = definitive ? 'failed' : 'uncertain';
        this._persist('updateJob', job.id, { status, resultAt: this.now(), errorCode: code, error: definitive ? 'Falha confirmada; envio não realizado. Revise o destino ou o conteúdo.' : 'Submissão desconhecida; revisão obrigatória antes de repetir.' });
        this._diagnostic(job, code, definitive ? 'Falha confirmada ou limite de tentativas atingido.' : 'O serviço não confirmou o resultado.', attempt, definitive ? 'Destino ou item precisa de revisão; outras tarefas elegíveis continuam.' : 'Resultado incerto preservado; nenhum reenvio automático.');
        const licenseBlocked = /^(?:LICENSE|TRIAL)_/.test(code);
        if (licenseBlocked) this._pauseActive('Licença indisponível; operações automáticas pausadas.');
        else if (definitive && !signal.aborted && this._connected() && (error.groupScoped === true || error.destinationUnavailable === true || /^(?:WA_)?GROUP_/.test(code) || safeRetry)) {
          // A synchronous negative receipt may already have suspended this job's destination.
          if (this.store.getCampaign(job.campaignId)?.destinationHealth?.[job.groupId]?.lastJobId !== job.id) this._destinationFailure(job, { ...error, code });
        }
        if (restricted) this._pauseActive('Restrição informada pela integração.');
        if (!this._connected()) this._pauseActive('Conexão indisponível; a fila permanece pausada até revisão e reconexão.');
        this.emit('change');
        return status;
      }
    }
    return 'failed';
  }

  async _cancelVersionReviewJob(job, error) {
    this._persist('updateJob', job.id, { status: 'cancelled', resultAt: this.now(), errorCode: error.code, error: error.message, reviewRequired: true });
    this._diagnostic(job, error.code, error.message, this.store.getJob(job.id)?.attempts || 0, 'Envio cancelado antes da submissão e campanha pausada; cadastro original preservado. Crie uma campanha comum revisada nesta versão.');
    await this.pause(job.campaignId, error.message);
    this.emit('change', { error: error.message, code: error.code });
    return 'cancelled';
  }

  _diagnostic(job, code, description, attempts, action) {
    if (!this.store.addDiagnostic) return;
    const c = this.store.getCampaign(job.campaignId);
    this._persist('addDiagnostic', { id: randomUUID(), traceId: job.id, at: this.now(), campaignId: job.campaignId, groupId: job.groupId, itemId: job.itemId, userId: c?.ownerId || c?.ownerUserId || null, stage: 'envio', code, description, attempts, action, details: { operationId: job.operationId || job.id, messageId: job.messageId }, guidance: 'Confira a conexão, a autorização do grupo e a existência da mídia. Resultados incertos precisam de revisão.' });
  }

  async reconcileJob(id) {
    const job = this.store.getJob(id);
    if (!job) throw new Error('Envio não encontrado.');
    if (job.status !== 'uncertain') return job;
    const receipt = this.receipts.get(job.messageId) || this.receipts.get(job.clientMessageId);
    if (receipt) this._recordProof(job, receipt, { reconciled: true });
    else if (typeof this.adapter.reconcile === 'function') {
      const apply = proof => {
        if (proof?.status === 'failed' && proof.confirmedFailure === true && this.store.getJob(job.id)?.status === 'uncertain') {
          this._persist('updateJob', job.id, { status: 'failed', resultAt: this.now(), errorCode: proof.code || 'SEND_CONFIRMED_REJECTION', error: 'A reconciliação confirmou que a mensagem foi rejeitada.' });
          if (proof.groupScoped === true || proof.destinationUnavailable === true) this._destinationFailure(job, proof);
          this.emit('change');
        } else this._recordProof(job, proof, { reconciled: true });
      };
      const proof = await this.runBoundedAttempt(context => this.adapter.reconcile(job.messageId, context), { onLateResult: apply });
      apply(proof);
    }
    const result = this.store.getJob(id);
    if (result.status === 'uncertain') this._diagnostic(job, 'RECONCILIATION_NO_EVIDENCE', 'Não há confirmação confiável disponível para este identificador.', job.attempts || 0, 'Mantenha para revisão; reenvio manual pode duplicar a mensagem.');
    return result;
  }

  async recheckDestination(campaignId, groupId) {
    const campaign = this.store.getCampaign(campaignId);
    if (!campaign?.groupIds?.includes(groupId)) throw new Error('Destino não encontrado nesta campanha.');
    if (!this._connected()) throw new Error('Reconecte o WhatsApp antes de verificar o destino.');
    if (typeof this.adapter.getGroupPublishingStatus !== 'function') throw new Error('A integração não disponibiliza a verificação de permissões do grupo.');
    const result = await this.runBoundedAttempt(context => this.adapter.getGroupPublishingStatus(groupId, { ...context, force: true }));
    const live = this.store.getCampaign(campaignId);
    const previous = live.destinationHealth?.[groupId] || {};
    const available = result?.available === true && result?.canSend !== false;
    const health = { ...previous, suspended: !available, checkedAt: this.now(), code: result?.code || (available ? 'GROUP_AVAILABLE' : 'GROUP_PERMISSION_UNKNOWN'), reason: available ? 'A integração confirmou que a conta pode enviar neste grupo.' : result?.reason || 'Não foi possível confirmar a permissão para publicar.', confirmed: result?.confirmed === true, at: previous.at || this.now() };
    this._persist('saveCampaign', { ...live, destinationHealth: { ...(live.destinationHealth || {}), [groupId]: health } });
    this.emit('change');
    return health;
  }

  retryUncertain(id, { duplicateRiskAcknowledged = false, userId = null } = {}) {
    if (!duplicateRiskAcknowledged) return Promise.reject(new Error('Confirme o risco de duplicar uma mensagem que pode já ter sido enviada.'));
    if (this.manualRetries.has(id)) return this.manualRetries.get(id);
    const operation = (async () => {
      await this.reconcileJob(id);
      const original = this.store.getJob(id);
      if (original.manualResendJobId) return this.store.getJob(original.manualResendJobId);
      if (original.status !== 'uncertain') throw new Error('O envio já possui confirmação. Não é necessário reenviar.');
      const campaign = this.store.getCampaign(original.campaignId);
      const timeoutMs = this._timeoutMs(campaign);
      const retries = campaign?.retryPolicy || { maxAttempts: 3, delaySeconds: 3 };
      let retryWaitMs = 0;
      for (let attempt = 1; attempt < retries.maxAttempts; attempt++) retryWaitMs += Math.max(Math.min(3600000, retries.delaySeconds * 1000 * (retries.backoffFactor ?? 2) ** (attempt - 1)), (this.adapter.minimumSpacingSeconds ?? 3) * 1000);
      return this.runExternalSubmission(async context => {
        context.beforeSubmit(); this.licenseGuard();
        const current = this.store.getJob(id);
        if (current.manualResendJobId) return this.store.getJob(current.manualResendJobId);
        if (current.status !== 'uncertain') throw new Error('O envio foi confirmado durante a revisão; nenhum reenvio foi realizado.');
        if (!this._maySend(current.campaignId, current.groupId, { manual: true })) throw new Error('A campanha ou o destino está bloqueado; revise e reconecte antes de reenviar.');
        if (!this._itemStillConfigured(current)) throw new Error('O item foi retirado ou não está pronto na campanha. Revise o conteúdo antes de solicitar um reenvio.');
        const at = this.now(), round = { id: randomUUID(), campaignId: current.campaignId, startedAt: at, finishedAt: null, status: 'running', manual: true };
        const messageId = randomBytes(16).toString('hex').toUpperCase();
        const job = { ...current, id: randomUUID(), roundId: round.id, operationId: `${current.campaignId}:${round.id}:${current.groupId}:${current.itemId}`, status: 'queued', attempts: 0, createdAt: at, firstAttemptAt: null, resultAt: null, messageId, clientMessageId: messageId, error: null, errorCode: null, manualResend: true, originalJobId: current.id, duplicateRiskAcknowledged: true, requestedBy: userId, manualResendJobId: null };
        const write = () => { this._persist('insertRound', round); const saved = this._persist('insertJob', job); if (saved) Object.assign(job, saved); this._persist('updateJob', current.id, { manualResendJobId: job.id, reviewedBy: userId, reviewedAt: at, reviewDecision: 'resend-with-duplication-risk' }); };
        if (typeof this.store.transaction === 'function') this.store.transaction(write); else write();
        if (this.lastSubmissionAt !== null) await this._wait(Math.max(0, (campaign.spacingSeconds || 3) * 1000 - (this.now() - this.lastSubmissionAt)), context.signal);
        const status = await this._sendJob(job, context.signal);
        if (status === 'cancelled') this._persist('updateJob', job.id, { status, resultAt: this.now(), error: 'Reenvio cancelado antes de submeter.' });
        this._persist('updateRound', round.id, { status: 'completed', finishedAt: this.now() });
        return this.store.getJob(job.id);
      }, { manual: false, timeoutMs: timeoutMs * retries.maxAttempts + retryWaitMs + (campaign.spacingSeconds || 3) * 1000 + 1000 });
    })();
    this.manualRetries.set(id, operation);
    operation.finally(() => this.manualRetries.delete(id)).catch(() => {});
    return operation;
  }

  _incident(campaignId, kind, code, reason) {
    const campaign = this.store.getCampaign(campaignId);
    if (!campaign || campaign.lastError?.roundId === this.currentRound?.id) return;
    const incident = { id: randomUUID(), campaignId, campaignName: campaign.name, at: this.now(), code, reason, kind, roundId: this.currentRound?.id || null, userId: campaign.ownerId || campaign.ownerUserId || null };
    if (this.store.getMetrics) {
      const metrics = this.store.getMetrics({ campaignIds: [campaignId] });
      incident.confirmed = metrics.confirmed || 0;
      incident.pending = (metrics.pending || 0) + (metrics.uncertain || 0);
    } else {
      const jobs = this.store.listJobs({ campaignId, limit: 1000000 });
      incident.confirmed = jobs.filter(j => j.status === 'confirmed').length;
      incident.pending = jobs.filter(j => ['queued', 'sending', 'uncertain'].includes(j.status)).length;
    }
    this.currentRound?.controller.abort();
    this._persist('saveCampaign', { ...campaign, state: kind === 'fatal' ? 'stopped' : 'paused', nextRunAt: null, pauseReason: reason, pausedAt: incident.at, lastError: incident });
    if (this.store.addAudit) this._persist('addAudit', { id: randomUUID(), at: incident.at, userId: incident.userId, action: 'campaign.error', subjectId: campaignId, campaignId, details: { occurrenceId: incident.id, code, kind, action: kind === 'fatal' ? 'encerrada' : 'pausada para revisão' } });
    this.emit('incident', incident);
    this.emit('change');
  }

  async _runRound(campaign) {
    const at = this.now();
    const history = this._history(campaign);
    const groups = campaign.groupIds.filter(groupId => {
      if (campaign.destinationHealth?.[groupId]?.suspended || !this._eligibleItems(campaign, groupId).length) return false;
      const config = this._groupConfig(campaign, groupId);
      const last = history.get(groupId)?.lastAt;
      return (last === undefined || last === null || last + config.intervalMinutes * 60000 <= at) && isWithinSchedule(at, config.schedule);
    });
    if (!groups.length) return;
    const round = { id: randomUUID(), campaignId: campaign.id, startedAt: at, finishedAt: null, status: 'running', sequence: campaign.roundIndex || 0 };
    const controller = new AbortController();
    this.currentRound = { ...round, controller };
    this._persist('insertRound', round);
    const jobs = [];
    for (const groupId of groups) {
      const config = this._groupConfig(campaign, groupId);
      const past = history.get(groupId);
      const index = past?.roundCount ?? past?.rounds?.size ?? 0;
      const eligible = this._eligibleItems(campaign, groupId);
      const items = campaign.mode === 'rotate' ? [eligible[index % eligible.length]] : eligible;
      for (const item of items) {
        const messageId = randomBytes(16).toString('hex').toUpperCase();
        const job = { id: randomUUID(), operationId: `${campaign.id}:${round.id}:${groupId}:${item.id}`, roundId: round.id, campaignId: campaign.id, groupId, itemId: item.id, itemSnapshot: structuredClone(item), status: 'queued', createdAt: at, attempts: 0, messageId, clientMessageId: messageId, resultAt: null, error: null };
        const saved = this._persist('insertJob', job);
        jobs.push(saved || job);
      }
    }
    this._persist('saveCampaign', { ...campaign, roundIndex: (campaign.roundIndex || 0) + 1, nextRunAt: null });
    this.emit('change');
    let roundStatus = 'completed';
    try {
      for (const job of jobs) {
        const current = this.store.getCampaign(campaign.id);
        if (controller.signal.aborted || current?.state !== 'active' || !this._connected() || this._automationStopped()) { roundStatus = 'cancelled'; break; }
        const currentItems = this._groupConfig(current, job.groupId).items;
        if (!this._maySend(campaign.id, job.groupId) || !currentItems.some(item => item.id === job.itemId && !item.captureDeleted && item.ready !== false)) {
          this._persist('updateJob', job.id, { status: 'cancelled', resultAt: this.now(), error: 'Destino suspenso, removido ou item retirado antes do envio.' });
          continue;
        }
        let config = this._groupConfig(this.store.getCampaign(campaign.id), job.groupId);
        if (!isWithinSchedule(this.now(), config.schedule)) { this._persist('updateJob', job.id, { status: 'cancelled', resultAt: this.now(), error: 'Fora do horário autorizado.' }); continue; }
        const spacing = this.lastSubmissionGroupId === job.groupId ? campaign.messageSpacingSeconds ?? campaign.spacingSeconds : campaign.groupSpacingSeconds ?? campaign.spacingSeconds;
        if (this.lastSubmissionAt !== null) await this._wait(Math.max(0, spacing * 1000 - (this.now() - this.lastSubmissionAt)), controller.signal);
        if (controller.signal.aborted || !this._connected() || this.store.getCampaign(campaign.id)?.state !== 'active') { roundStatus = 'cancelled'; break; }
        if (!this._maySend(campaign.id, job.groupId)) { this._persist('updateJob', job.id, { status: 'cancelled', resultAt: this.now(), error: 'Destino suspenso ou removido durante o intervalo.' }); continue; }
        config = this._groupConfig(this.store.getCampaign(campaign.id), job.groupId);
        if (!isWithinSchedule(this.now(), config.schedule)) { this._persist('updateJob', job.id, { status: 'cancelled', resultAt: this.now(), error: 'Janela de horário encerrada.' }); continue; }
        const live = this.store.getCampaign(campaign.id);
        if (live.endAt && this.now() >= live.endAt) { roundStatus = 'limited'; break; }
        if (live.dailySendLimit && this._counts(campaign.id, this.now()).sends >= live.dailySendLimit) { roundStatus = 'limited'; break; }
        const result = await this._sendJob(job, controller.signal);
        if (result === 'cancelled') this._persist('updateJob', job.id, { status: 'cancelled', resultAt: this.now(), error: 'Envio cancelado antes da submissão.' });
      }
    } catch (error) {
      roundStatus = 'interrupted';
      // A store/network boundary exception leaves a sending job ambiguous.
      for (const job of this.store.listJobs({ roundId: round.id, status: 'sending', limit: 1000000 })) this._persist('updateJob', job.id, { status: 'uncertain', resultAt: this.now(), error: 'Execução interrompida; revisão manual obrigatória.' });
      await this.pause(campaign.id, 'A rodada foi interrompida.');
    } finally {
      for (const job of this.store.listJobs({ roundId: round.id, status: 'queued', limit: 1000000 })) this._persist('updateJob', job.id, { status: 'cancelled', resultAt: this.now(), error: 'Rodada encerrada; fila não será repetida.' });
      this._persist('updateRound', round.id, { status: roundStatus, finishedAt: this.now() });
      this.currentRound = null;
      const live = this.store.getCampaign(campaign.id);
      if (live?.state === 'active') {
        const next = this._nextEligibleAt(live, this.now(), { afterRound: true });
        const finished = (live.maxRounds && (live.roundIndex || 0) >= live.maxRounds) || (live.endAt && this.now() >= live.endAt) || !live.groupIds.some(id => Number.isFinite(nextScheduledAt(this.now(), this._groupConfig(live, id).schedule)));
        this._persist('saveCampaign', { ...live, state: Number.isFinite(next) ? 'active' : finished ? 'stopped' : 'paused', nextRunAt: Number.isFinite(next) ? next : null, ...(Number.isFinite(next) || finished ? {} : { pauseReason: 'Nenhum item ou destino está elegível. Revise os envios incertos e os grupos suspensos.', pausedAt: this.now() }) });
      }
      this.emit('change');
    }
  }

  getSummary(id) {
    const c = this.store.getCampaign(id);
    if (!c) throw new Error('Campanha não encontrada.');
    const names = c.groupIds.map(id => this.store.getGroup(id)?.name || id);
    const types = { text: 'Texto', image: 'Imagem', video: 'Vídeo', document: 'Documento' };
    const content = (c.items || []).map((item, i) => `${i + 1}. ${types[item.type] || item.type}: ${item.type === 'text' ? item.text : this.store.getMedia(item.mediaId)?.name || 'Mídia ausente'}${item.caption ? ` — ${item.caption}` : ''}`);
    const days = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
    const p = scheduleParts(c.schedule);
    const duration = p.start === p.end ? 1440 : (p.end - p.start + 1440) % 1440;
    let estimated = 0;
    for (const groupId of c.groupIds) {
      const config = this._groupConfig(c, groupId);
      const gp = scheduleParts(config.schedule);
      const length = gp.start === gp.end ? 1440 : (gp.end - gp.start + 1440) % 1440;
      estimated += Math.ceil(length / config.intervalMinutes) * (c.mode === 'rotate' ? Math.min(1, config.items.length) : config.items.length);
    }
    if (c.dailySendLimit) estimated = Math.min(estimated, c.dailySendLimit);
    if (c.dailyRoundLimit) estimated = Math.min(estimated, c.dailyRoundLimit * c.groupIds.reduce((sum, id) => sum + (c.mode === 'rotate' ? 1 : this._groupConfig(c, id).items.length), 0));
    const overrides = c.groupIds.filter(id => c.groupOverrides?.[id]?.enabled).map(id => {
      const config = this._groupConfig(c, id);
      const preview = config.items.map((item, index) => `${index + 1}. ${types[item.type]}: ${item.type === 'text' ? item.text : this.store.getMedia(item.mediaId)?.name || 'Mídia ausente'}${item.caption ? ` — ${item.caption}` : ''}`).join('\n');
      return `${this.store.getGroup(id)?.name || id}: ${config.intervalMinutes} min, ${config.schedule.startTime || '00:00'}–${config.schedule.endTime || '00:00'}, ${config.items.length} conteúdo(s), dias ${(config.schedule.days || [0,1,2,3,4,5,6]).map(d => days[d]).join(', ')}; datas ${config.schedule.startDate || 'livre'} a ${config.schedule.endDate || 'livre'}.\n${preview}`;
    });
    return [
      `${c.name} (${c.id}) — ${c.state}`,
      `Modo: ${c.mode === 'rotate' ? 'alternar: próximo conteúdo a cada participação do grupo' : 'repetir todos os conteúdos na ordem'}.`,
      `Grupos (${names.length}): ${names.join(', ') || 'nenhum'}.`,
      'Conteúdo:', ...(content.length ? content : ['Nenhum conteúdo principal.']),
      `Intervalo entre inícios: ${c.intervalMinutes} min. Espaçamento entre envios: ${c.spacingSeconds} s. Entre mensagens no mesmo grupo: ${c.messageSpacingSeconds ?? c.spacingSeconds} s; entre grupos: ${c.groupSpacingSeconds ?? c.spacingSeconds} s.`,
      `Tempo limite por tentativa: ${this._timeoutMs(c) / 1000} s. Limite total: ${c.maxRounds || 'sem limite'} rodada(s)${c.endAt ? `; encerramento: ${new Date(c.endAt).toLocaleString('pt-BR')}` : ''}.`,
      `Dias: ${p.days.map(d => days[d]).join(', ')}. Horário: ${c.schedule?.startTime || '00:00'}–${c.schedule?.endTime || '00:00'} (${duration / 60} h).`,
      `Datas: ${p.startDate || 'sem início fixo'} a ${p.endDate || 'sem encerramento fixo'}.`,
      `Limites diários: ${c.dailyRoundLimit || 'sem limite'} rodada(s); ${c.dailySendLimit || 'sem limite'} envio(s).`,
      ...(overrides.length ? ['Configuração individual:', ...overrides] : []),
      `Estimativa máxima: ${Number.isFinite(estimated) ? estimated : 0} envio(s) por dia ativo; filas e horários podem reduzir esse total.`,
      `Próximo início: ${c.nextRunAt ? new Date(c.nextRunAt).toLocaleString('pt-BR') : 'não agendado'}.`,
      'O computador precisa estar ligado, conectado à internet e sem suspensão. Rodadas perdidas não são acumuladas. Envio aceito significa confirmação da integração; entrega depende de evento posterior disponível. Um resultado incerto fica para revisão, sem bloquear as outras tarefas elegíveis e sem reenvio automático do mesmo item ao mesmo destino.'
    ].join('\n');
  }

  async shutdown() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this._pauseActive('Aplicativo encerrado.');
    this.currentRound?.controller.abort();
    if (this.worker) await this.worker;
    await this.externalSubmissions;
    this.adapter.off('status', this.statusListener);
    this.adapter.off('receipt', this.receiptListener);
  }
}

module.exports = { Scheduler, isWithinSchedule, nextScheduledAt, nextRoundSlot, dateKey };
