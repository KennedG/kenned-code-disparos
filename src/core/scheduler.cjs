'use strict';

const { EventEmitter } = require('node:events');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { assertCampaignSchemaCompatible } = require('./campaign-schema-compat.cjs');
const { localParts, localEpoch } = require('./reminders.cjs');
const { computerClockStatus, computerDateKey, localSchedule, nextComputerRoundSlot } = require('./computer-schedule.cjs');
const ITEM_TYPES = new Set(['text', 'image', 'video', 'document']);

function executionPolicyFingerprint(campaign) {
  const normalize = v => Array.isArray(v) ? v.map(normalize) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, normalize(v[k])])) : v;
  const fields = ['mode', 'intervalMinutes', 'spacingSeconds', 'messageSpacingSeconds', 'groupSpacingSeconds', 'schedule', 'dailyRoundLimit', 'dailySendLimit', 'groupIds', 'maxRounds', 'endAt'];
  const value = Object.fromEntries(fields.map(k => [k, campaign[k]]));
  value.groupOverrides = Object.fromEntries(Object.entries(campaign.groupOverrides || {}).map(([id, g]) => [id, { enabled: g.enabled, intervalMinutes: g.intervalMinutes, schedule: g.schedule }]));
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

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
  constructor({ store, adapter, now = () => Date.now(), sleep = defaultSleep, licenseGuard = () => {}, attemptTimeoutMs, monotonicNow }) {
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
    this.submissionTurn = null;
    this.submissionTurnWaiters = [];
    this.automationBlocked = store.getSetting?.('automationState', {})?.stopped === true;
    this.receipts = new Map();
    this.attemptTimeoutMs = attemptTimeoutMs;
    this.detachedAttempts = new Set();
    this.manualRetries = new Map();
    this.monotonicNow = monotonicNow || (() => performance.now());
    this.observeWallClock = Boolean(monotonicNow) || Math.abs(now() - Date.now()) < 5000;
    this.clockObservation = { ...computerClockStatus(now()), monotonicAt: this.monotonicNow() };
    this._prepareRestart();
    this.setAdapter(adapter);
  }

  setAdapter(adapter) {
    if (this.adapter) {
      this.adapter.off('status', this.statusListener);
      this.adapter.off('receipt', this.receiptListener);
      this._pauseActive('Integração alterada; retome após conferir a conexão.', { includeRecovery: true });
    }
    this.adapter = adapter;
    this.setAutomationBlocked(this.store.getSetting?.('automationState', {})?.stopped === true);
    this.receipts.clear();
    this.lastSubmissionAt=null;
    this.statusListener = status => {
      if (status.state !== 'connected') {
        if (status.manual || status.reasonCode === 'manual') this._pauseActive('WhatsApp desconectado pelo administrador.', { includeRecovery: true });
        else if (status.state === 'restricted') this._pauseActive('Restrição informada pela integração; confira antes de retomar.', { includeRecovery: true });
        else this._interruptActive(`Conexão indisponível: ${status.state}.`, 'connection');
      }
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

  _connected() { return !this.store.persistenceFailed && this.adapter?.status?.state === 'connected' && this.adapter.status.ready !== false; }

  blockOnPersistenceFailure() { this._failClosed(); }

  _failClosed() {
    // Cancelling the runtime queue cannot depend on a working disk. Latch this
    // before any best-effort status writes so a later successful write cannot
    // accidentally allow another network submission.
    this.currentRound?.controller.abort();
    if (this.persistenceFailed) return;
    this.persistenceFailed = true;
    if (!this.store.persistenceFailed) {
      try { this._pauseActive('Falha de persistência; reinicie e confira o histórico.', { includeRecovery: true }); }
      catch { /* The queue is already blocked even if storage cannot be read. */ }
    }
    this.emit('change', { error: 'Falha de persistência; envios bloqueados até reiniciar o aplicativo.' });
  }

  _persist(method, ...args) {
    try { return this.store[method](...args); }
    catch (error) { this._failClosed(); throw error; }
  }

  getClockStatus() { return computerClockStatus(this.now()); }

  getCampaignTiming(id) {
    const c = this.store.getCampaign(id);
    if (!c) throw new Error('Campanha não encontrada.');
    return { computerClock: this.getClockStatus(), nextRoundAt: c.nextRunAt ?? null, lastRoundAt: c.lastRoundAt ?? null, lastRoundScheduledAt: c.lastRoundScheduledAt ?? null, state: c.state, recoveryStatus: c.executionRecovery?.status || null, pendingRoundId: c.executionPendingRoundId || null };
  }

  _authorizedOnIncidentDay(campaign, at) {
    const authorization = campaign.executionAuthorization;
    return authorization?.manual === true && (authorization.dateKey === computerDateKey(at) || campaign.lastExecutionDayKey === computerDateKey(at));
  }

  _recoveryMetadata(campaign, reason, kind) {
    const at = this.now(), previous = campaign.executionRecovery;
    const pending = this.store.listJobs({ campaignId: campaign.id, status: 'queued', limit: 1 })[0];
    return {
      kind, interruptedAt: previous?.eligible ? previous.interruptedAt : at,
      authorizedDate: campaign.executionAuthorization?.dateKey || null,
      incidentDate: previous?.eligible ? previous.incidentDate : computerDateKey(at),
      timezone: this.getClockStatus().timezone,
      roundId: campaign.executionPendingRoundId || pending?.roundId || null,
      eligible: previous?.eligible === true || this._authorizedOnIncidentDay(campaign, at) || kind === 'clock' && campaign.executionAuthorization?.manual === true,
      configRevision: campaign.configRevision ?? null, policyFingerprint: executionPolicyFingerprint(campaign), reason, status: 'Interrompida por erro — aguardando recuperação da conexão'
    };
  }

  _prepareRestart() {
    // Construction only classifies interrupted work. It never submits it.
    // Unsubmitted queued items retain their exact frozen round, while a sending
    // item becomes uncertain and cannot be resent without reliable evidence.
    const affected = new Set();
    const write = () => {
      for (const job of [...this.store.listJobs({ status: 'sending', limit: 1000000 }), ...this.store.listJobs({ status: 'queued', limit: 1000000 })]) {
        const c = this.store.getCampaign(job.campaignId);
        const retained = c?.executionAuthorization?.manual === true && (c.state === 'active' || c.state === 'paused' && c.executionRecovery?.eligible === true);
        if (job.status === 'sending') this._persist('updateJob', job.id, { status: 'uncertain', resultAt: this.now(), errorCode: 'PROCESS_INTERRUPTED', error: 'Aplicativo interrompido durante a submissão; confirme antes de repetir.' });
        else if (!retained) this._persist('updateJob', job.id, { status: 'cancelled', resultAt: this.now(), error: 'Fila anterior sem autorização de recuperação; confira antes de retomar.' });
        affected.add(job.campaignId);
      }
      for (const c of this.store.listCampaigns()) {
        if (c.state !== 'active') continue;
        const recovery = this._recoveryMetadata(c, 'Aplicativo reaberto; aguardando a sessão e o próximo horário programado.', 'restart');
        this._persist('saveCampaign', { ...c, state: 'paused', nextRunAt: null, pauseReason: recovery.reason, pausedAt: this.now(), executionRecovery: recovery, executionPendingRoundId: recovery.roundId });
        affected.add(c.id);
      }
      for (const id of affected) for (const round of this.store.listRounds(id)) if (!round.finishedAt && round.status === 'running') this._persist('updateRound', round.id, { status: 'interrupted', interruptedAt: this.now(), finishedAt: this.now() });
    };
    if (typeof this.store.transaction === 'function') this.store.transaction(write); else write();
  }

  _interruptActive(reason, kind = 'connection') {
    if (this.store.persistenceFailed) { this.blockOnPersistenceFailure(); return; }
    this.currentRound?.controller.abort();
    for (const c of this.store.listCampaigns()) {
      if (c.state !== 'active') continue;
      const recovery = this._recoveryMetadata(c, reason, kind);
      this._persist('saveCampaign', { ...c, state: 'paused', nextRunAt: null, pauseReason: reason, pausedAt: this.now(), executionRecovery: recovery, executionPendingRoundId: recovery.roundId });
      if (this.store.addDiagnostic) this._persist('addDiagnostic', { id: randomUUID(), at: this.now(), campaignId: c.id, stage: 'campaign.interrupted', code: 'CAMPAIGN_TECHNICAL_INTERRUPTION', description: reason, action: recovery.eligible ? 'Itens pendentes preservados. A recuperação aguardará o próximo horário da grade.' : 'Sem autorização de início neste dia; a campanha exige retomada manual.', details: { kind, roundId: recovery.roundId, authorizationDate: recovery.authorizedDate } });
    }
    this.emit('change');
  }

  _pendingRound(campaign) {
    const queued = this.store.listJobs({ campaignId: campaign.id, status: 'queued', limit: 1000000 });
    if (!queued.length) return null;
    const id = campaign.executionPendingRoundId || queued[0].roundId;
    const round = this.store.listRounds(campaign.id).find(r => r.id === id);
    return round ? { round, jobs: queued.filter(j => j.roundId === id) } : null;
  }

  async _recoverScheduling({ reason = 'reconnected', kind = 'connection', activeClockIds = [] } = {}) {
    this.licenseGuard();
    const result = { recovered: [], skipped: [], at: this.now() };
    if (this.closed || this.persistenceFailed || this.store.persistenceFailed || this._automationStopped() || !this._connected()) return result;
    // Settle the old worker first. No new round can race its finally block.
    await this.waitForIdle();
    this.licenseGuard();
    if (this._automationStopped() || !this._connected() || this.closed) return result;
    for (const c of this.store.listCampaigns()) {
      const recovery = c.executionRecovery;
      if (c.state !== 'paused' || !recovery) continue;
      if (this.store.getSetting?.('reconnect', {})?.autoResume === false && !activeClockIds.includes(c.id)) {
        result.skipped.push({ campaignId: c.id, reason: 'A retomada automática está desativada nas configurações.' });
        continue;
      }
      const policyChanged = recovery.policyFingerprint ? recovery.policyFingerprint !== executionPolicyFingerprint(c) : recovery.configRevision !== null && recovery.configRevision !== undefined && c.configRevision !== recovery.configRevision;
      if (!recovery.eligible || c.executionAuthorization?.manual !== true || policyChanged) {
        result.skipped.push({ campaignId: c.id, reason: 'A campanha não possui autorização preservada para recuperação automática.' });
        continue;
      }
      try { this._validateCampaign(c); }
      catch (error) { result.skipped.push({ campaignId: c.id, reason: error.message }); continue; }
      const next = this._nextEligibleAt(c, this.now(), { strictlyFuture: true, includePending: true });
      if (!Number.isFinite(next)) { result.skipped.push({ campaignId: c.id, reason: 'Não há próximo horário elegível na programação.' }); continue; }
      const status = 'Conexão recuperada — aguardando próximo horário de rodada';
      const saved = this._persist('saveCampaign', { ...c, state: 'active', nextRunAt: next, pauseReason: null, pausedAt: null, executionRecovery: { ...recovery, recoveredAt: this.now(), recoveredBy: kind, recoveryReason: reason, status }, scheduleClock: this.getClockStatus() });
      const pending = this.store.listJobs({ campaignId: c.id, status: 'queued', limit: 1000000 }).length;
      result.recovered.push({ campaignId: c.id, nextRunAt: saved.nextRunAt, pending, roundId: c.executionPendingRoundId || null, status });
      this._reconcileRecoveryEvidence(c);
    }
    this.emit('change');
    return result;
  }

  _reconcileRecoveryEvidence(campaign) {
    if (typeof this.adapter?.reconcile !== 'function') return;
    const uncertain = this.store.listJobs({ campaignId: campaign.id, status: 'uncertain', limit: 10 });
    // Evidence lookup is bounded and detached from scheduling. It never sends.
    void Promise.allSettled(uncertain.map(job => this.runBoundedAttempt(context => this.adapter.reconcile(job.messageId, context), { timeoutMs: 3000, onLateResult: proof => this._recordProof(job, proof, { reconciled: true }) }).then(proof => this._recordProof(job, proof, { reconciled: true }))));
  }

  recoverAfterConnection(options = {}) { return this._recoverScheduling({ ...options, kind: 'connection' }); }
  recoverAfterRestart(options = {}) { return this._recoverScheduling({ ...options, reason: options.reason || 'restarted', kind: 'restart' }); }

  async handleSuspend({ reason = 'Computador suspenso; itens pendentes preservados para o próximo horário.' } = {}) {
    this._interruptActive(reason, 'suspend');
    if (this.worker) await this.worker;
    return { paused: this.store.listCampaigns().filter(c => c.executionRecovery?.kind === 'suspend' && c.state === 'paused').map(c => c.id) };
  }

  async handleClockChange({ reason = 'Relógio ou fuso do computador alterado; programação recalculada.' } = {}) {
    const activeClockIds = this.store.listCampaigns().filter(c => c.state === 'active').map(c => c.id);
    this._interruptActive(reason, 'clock');
    if (this.worker) await this.worker;
    this.clockObservation = { ...this.getClockStatus(), monotonicAt: this.monotonicNow() };
    return this._recoverScheduling({ reason, kind: 'clock', activeClockIds });
  }

  _groupConfig(campaign, groupId) {
    const override = campaign.groupOverrides?.[groupId];
    const schedule = localSchedule(campaign.schedule || {});
    if (!override?.enabled) return { intervalMinutes: campaign.intervalMinutes, schedule, items: campaign.items || [] };
    return {
      intervalMinutes: override.intervalMinutes ?? campaign.intervalMinutes,
      schedule: localSchedule({ ...schedule, ...(override.schedule || {}) }),
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
    this._validateSchedule(localSchedule(campaign.schedule));
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
    const timezone = this.getClockStatus().timezone === 'local' ? null : this.getClockStatus().timezone;
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

  _nextEligibleAt(campaign, at, { afterRound = false, strictlyFuture = false, includePending = false, tickToleranceMs = 0 } = {}) {
    const pending = includePending ? this._pendingRound(campaign) : null;
    if ((!pending && campaign.maxRounds && (campaign.roundIndex || 0) >= campaign.maxRounds) || (campaign.endAt && at >= campaign.endAt)) return Infinity;
    const counts = this._counts(campaign.id, at);
    let lower = at - tickToleranceMs;
    if ((!pending && campaign.dailyRoundLimit && counts.rounds >= campaign.dailyRoundLimit) || (campaign.dailySendLimit && counts.sends >= campaign.dailySendLimit)) lower = nextLocalDay(at);
    const history = this._history(campaign);
    let next = Infinity;
    for (const groupId of campaign.groupIds) {
      if (campaign.destinationHealth?.[groupId]?.suspended || !this._eligibleItems(campaign, groupId).length) continue;
      if (pending && !pending.jobs.some(j => j.groupId === groupId && this._itemStillConfigured(j))) continue;
      const config = this._groupConfig(campaign, groupId);
      const last = campaign.groupLastScheduledSlots?.[groupId] ?? history.get(groupId)?.lastAt;
      const interval = config.intervalMinutes * 60000;
      const pendingDue = pending ? Math.min(...pending.jobs.filter(j => j.groupId === groupId).map(j => j.nextAttemptAt || lower)) : lower;
      const due = pending ? Math.max(lower, pendingDue) : last === undefined || last === null ? lower : last + interval;
      const scheduled = nextComputerRoundSlot(Math.max(lower, due), config.schedule, config.intervalMinutes, { strictlyFuture: strictlyFuture && lower <= at && due <= at, anchorAt: campaign.roundAnchorAt });
      if (!campaign.endAt || scheduled < campaign.endAt) next = Math.min(next, scheduled);
    }
    return next;
  }

  async activate(id, { relative = false } = {}) {
    if (this.closed) throw new Error('O agendador está encerrado.');
    this.licenseGuard();
    if (this._automationStopped()) throw this._automationError();
    if (this.store.persistenceFailed) this.blockOnPersistenceFailure();
    if (this.persistenceFailed) throw new Error('O agendador foi bloqueado após uma falha de persistência. Reinicie o aplicativo e confira o histórico.');
    let campaign = this.store.getCampaign(id);
    this._validateCampaign(campaign);
    if (!this._connected()) throw new Error('Conecte o WhatsApp ou o modo simulado antes de ativar.');
    if (campaign.state === 'active') return campaign;
    const at = this.now();
    if (relative) {
      const anchor = Math.min(...campaign.groupIds.map(groupId => nextScheduledAt(at, this._groupConfig(campaign, groupId).schedule)));
      campaign = { ...campaign, roundAnchorAt: anchor, groupLastScheduledSlots: Object.fromEntries(campaign.groupIds.map(groupId => [groupId, anchor - this._groupConfig(campaign, groupId).intervalMinutes * 60000])) };
    }
    const next = this._nextEligibleAt(campaign, at, { includePending: true });
    if (!Number.isFinite(next)) throw new Error('Não há horário futuro disponível na programação.');
    this._persist('saveCampaign', { ...campaign, state: 'active', nextRunAt: next, pauseReason: null, pausedAt: null, executionAuthorization: { at, dateKey: computerDateKey(at), timezone: this.getClockStatus().timezone, manual: true }, executionRecovery: null, scheduleClock: this.getClockStatus() });
    this.emit('change');
    return this.store.getCampaign(id);
  }

  async resume(id, options) { return this.activate(id, options); }

  _immediateKey(id, requestId) { return `campaignImmediate:${this.store.getStorageMode?.() || this.adapter?.status?.mode || 'local'}:${id}:${requestId}`; }
  hasImmediateRequest(id, requestId) { return typeof requestId === 'string' && !!requestId && (this.store.getCampaign(id)?.lastImmediateRequestId === requestId || Boolean(this.store.getSetting?.(this._immediateKey(id, requestId), null))); }

  async sendNow(id, { requestId } = {}) {
    this.licenseGuard();
    if (this.closed || this._automationStopped()) throw this._automationError();
    if (typeof requestId !== 'string' || !requestId || requestId.length > 128) throw new Error('Identificador da solicitação imediata inválido.');
    const campaign = this.store.getCampaign(id); this._validateCampaign(campaign);
    if (this.hasImmediateRequest(id, requestId)) return campaign;
    if (this.busy || this.submissionHolds || this.currentRound) throw Object.assign(new Error('Há um envio em andamento. Aguarde sua conclusão antes de enviar uma rodada imediata.'), { code: 'SCHEDULER_BUSY' });
    if (!this._connected()) throw new Error('Conecte o WhatsApp antes de enviar agora.');
    if (this.store.persistenceFailed || this.persistenceFailed) throw new Error('Persistência indisponível. Reinicie e revise os registros antes de enviar.');
    const at = this.now(), candidate = { ...campaign, roundAnchorAt: at, groupLastScheduledSlots: Object.fromEntries(campaign.groupIds.map(groupId => [groupId, at - this._groupConfig(campaign, groupId).intervalMinutes * 60000])) };
    const due = this._nextEligibleAt(candidate, at);
    if (due !== at) throw new Error('Não é possível enviar agora: confira dias, horários, destinos e limites de rodadas/envios.');
    const persist = () => { const saved = this._persist('saveCampaign', { ...candidate, state: 'active', nextRunAt: at, lastImmediateRequestId: requestId, pauseReason: null, pausedAt: null, executionPendingRoundId: null, executionRecovery: null, executionAuthorization: { at, dateKey: computerDateKey(at), timezone: this.getClockStatus().timezone, manual: true }, scheduleClock: this.getClockStatus() });
      if (typeof this.store.setSetting === 'function') this._persist('setSetting', this._immediateKey(id, requestId), { campaignId: id, requestId, requestedAt: at });
      return saved; };
    const result = typeof this.store.transaction === 'function' ? this.store.transaction(persist) : persist();
    this.emit('change');
    // Tick remains the only queue owner. Repeated RPCs use the durable request ID.
    queueMicrotask(() => { if (!this.closed) void this.tick().catch(() => {}); });
    return result || this.store.getCampaign(id);
  }

  _cancelQueued(campaignId, reason) {
    for (const job of this.store.listJobs({ campaignId, status: 'queued', limit: 1000000 })) this._persist('updateJob', job.id, { status: 'cancelled', error: reason, resultAt: this.now() });
  }

  async pause(id, reason = 'Campanha pausada pelo administrador.') {
    if (this.currentRound?.campaignId === id) this.currentRound.controller.abort();
    const campaign = this.store.getCampaign(id);
    if (!campaign) throw new Error('Campanha não encontrada.');
    if (['active', 'paused'].includes(campaign.state)) this._persist('saveCampaign', { ...campaign, state: 'paused', nextRunAt: null, pauseReason: reason, pausedAt: this.now(), executionRecovery: null, executionPendingRoundId: null });
    this._cancelQueued(id, reason);
    this.emit('change');
  }

  _pauseActive(reason, { includeRecovery = false } = {}) {
    if (this.store.persistenceFailed) { this.blockOnPersistenceFailure(); return; }
    for (const campaign of this.store.listCampaigns()) {
      if (campaign.state === 'active' || includeRecovery && campaign.state === 'paused' && campaign.executionRecovery) {
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
      if (['active', 'paused'].includes(campaign.state)) { this._persist('saveCampaign', { ...campaign, state: 'stopped', nextRunAt: null, executionRecovery: null, executionPendingRoundId: null }); campaigns++; }
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

  getSubmissionQueueState() {
    const pending = [...this.externalPending].filter(entry => !entry.cancelled && !entry.started).length;
    return { active: this.submissionTurn?.kind || null, waitingPrivate: pending,
      waitingCampaign: this.submissionTurnWaiters.filter(entry => entry.kind === 'campaign').length,
      reason: pending ? this.submissionTurn?.kind === 'campaign' ? 'Aguardando a mensagem em andamento, sem esperar a rodada inteira.' : 'Aguardando o próximo turno de envio privado.' : null };
  }

  _acquireSubmissionTurn(kind, signal) {
    // A round retains its immutable jobs while yielding only the transport.
    // FIFO arbitration prevents overlapping submissions and lets a waiting
    // campaign progress between finite private batches, without restarting it.
    if (!this.submissionTurn && !this.submissionTurnWaiters.length && !signal?.aborted) return this._takeSubmissionTurn({ kind });
    return new Promise((resolve, reject) => {
      const entry = { kind, signal, resolve, reject, abort: null };
      entry.abort = () => {
        const index = this.submissionTurnWaiters.indexOf(entry);
        if (index !== -1) this.submissionTurnWaiters.splice(index, 1);
        reject(Object.assign(new Error('Envio cancelado antes de obter o próximo turno.'), { code: 'SUBMISSION_ABORTED', definitive: true, submitted: false, safeToRetry: false }));
      };
      if (signal?.aborted) return entry.abort();
      signal?.addEventListener('abort', entry.abort, { once: true });
      this.submissionTurnWaiters.push(entry);
      this._grantSubmissionTurn();
    });
  }

  _grantSubmissionTurn() {
    if (this.submissionTurn) return;
    const entry = this.submissionTurnWaiters.shift();
    if (!entry) return;
    entry.signal?.removeEventListener('abort', entry.abort);
    if (entry.signal?.aborted) { entry.abort(); this._grantSubmissionTurn(); return; }
    entry.resolve(this._takeSubmissionTurn(entry));
  }

  _takeSubmissionTurn(entry) {
    this.submissionTurn = entry;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.submissionTurn === entry) this.submissionTurn = null;
      this._grantSubmissionTurn();
    };
  }

  _campaignSubmissionTurn(job, signal) {
    if (signal.aborted) return Promise.reject(Object.assign(new Error('Campanha interrompida antes do envio.'), { code: 'SUBMISSION_ABORTED', definitive: true, submitted: false }));
    const acquired = this._acquireSubmissionTurn('campaign', signal);
    const inspect = release => {
      try {
      const campaign = this.store.getCampaign(job.campaignId);
      const spacing = this.lastSubmissionGroupId === job.groupId ? campaign?.messageSpacingSeconds ?? campaign?.spacingSeconds : campaign?.groupSpacingSeconds ?? campaign?.spacingSeconds;
      const minimum = Math.max(Number(this.adapter.minimumSpacingSeconds) || 3, Number(spacing) || 3) * 1000;
      const remaining = this.lastSubmissionAt === null ? 0 : minimum - (this.now() - this.lastSubmissionAt);
      if (remaining <= 0) return release;
      // Do not own the transport during the configured campaign delay. A
      // private response may use it now; re-evaluate its resulting timestamp
      // after reacquiring instead of sending immediately behind that response.
      release();
      return this._wait(remaining, signal).then(() => this._campaignSubmissionTurn(job, signal));
      } catch (error) { release(); throw error; }
    };
    return typeof acquired === 'function' ? inspect(acquired) : acquired.then(inspect);
  }

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
      const releaseTurn = await this._acquireSubmissionTurn('private', entry.controller.signal);
      try {
      if (entry.cancelled) return;
      if (this.closed || this.persistenceFailed || this.store.persistenceFailed) throw new Error('Envios externos bloqueados: processamento indisponível.');
      if(!controlOnly)this.licenseGuard();
      if (!entry.manual && this._automationStopped()) throw this._automationError();
      entry.started = true;
      this.externalInFlight++;
      this.lastSubmissionGroupId = null;
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
      } finally { releaseTurn(); }
    });
    this.externalSubmissions = operation.catch(() => {});
    operation.then(resolve, reject).finally(() => this.externalPending.delete(entry));
    return result.finally(release);
  }

  tick() {
    if (this.store.persistenceFailed) this.blockOnPersistenceFailure();
    try{this.licenseGuard();}catch{return Promise.resolve();}
    if (this.closed || this.closing || this.persistenceFailed || this.submissionHolds || this._automationStopped()) return Promise.resolve();
    // Lock before invoking _tick: an adapter may synchronously emit an event
    // that calls tick again, before the worker promise has been assigned.
    if (this.busy) return this.worker || Promise.resolve();
    if (this.clockRecoveryOperation) return this.clockRecoveryOperation;
    const clock = { ...this.getClockStatus(), monotonicAt: this.monotonicNow() };
    const previousClock = this.clockObservation;
    this.clockObservation = clock;
    const timezoneChanged = clock.timezone !== previousClock.timezone || clock.timeZoneOffsetMinutes !== previousClock.timeZoneOffsetMinutes;
    const wallJump = this.observeWallClock && Math.abs((clock.at - previousClock.at) - (clock.monotonicAt - previousClock.monotonicAt)) > 5000;
    if (timezoneChanged || wallJump) {
      const operation = this.handleClockChange();
      this.clockRecoveryOperation = operation.finally(() => { this.clockRecoveryOperation = null; });
      return this.clockRecoveryOperation;
    }
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
    if (!this._connected()) { this._interruptActive('Conexão indisponível.', 'connection'); return; }
    const candidates = this.store.listCampaigns().filter(c => c.state === 'active' && (c.nextRunAt ?? 0) <= this.now()).sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0));
    for (const snapshot of candidates) {
      if (this.closed || this._automationStopped() || !this._connected()) break;
      const campaign = this.store.getCampaign(snapshot.id);
      if (campaign?.state !== 'active') continue;
      try { this._validateCampaign(campaign); }
      catch (error) { await this.pause(campaign.id, error.message); continue; }
      const currentAt = this.now(), slot = campaign.nextRunAt;
      const tolerance = Math.max(1000, Math.min(10000, Number(this.store.getSetting?.('roundSlotToleranceMilliseconds', 5000)) || 5000));
      const slotValid = Number.isFinite(slot) && currentAt >= slot && currentAt - slot <= tolerance && campaign.groupIds.some(id => {
        const config = this._groupConfig(campaign, id);
        return nextComputerRoundSlot(slot, config.schedule, config.intervalMinutes, { anchorAt: campaign.roundAnchorAt }) === slot && isWithinSchedule(currentAt, config.schedule);
      });
      const pending = this._pendingRound(campaign);
      const due = slotValid ? slot : this._nextEligibleAt(campaign, currentAt, { includePending: Boolean(pending), tickToleranceMs: tolerance });
      if (due > currentAt || !Number.isFinite(due)) {
        this._persist('saveCampaign', { ...campaign, state: Number.isFinite(due) ? 'active' : 'stopped', nextRunAt: Number.isFinite(due) ? due : null });
        this.emit('change');
        continue;
      }
      await this._runRound(campaign, { scheduledAt: due, pending });
    }
  }

  _maySend(campaignId, groupId, { manual = false } = {}) {
    try{this.licenseGuard();}catch{return false;}
    if (this.store.persistenceFailed) { this.blockOnPersistenceFailure(); return false; }
    const campaign = this.store.getCampaign(campaignId);
    const group = this.store.getGroup(groupId);
    return !this.closed && !this.persistenceFailed && !this._automationStopped() && this._connected() && (campaign?.state === 'active' || (manual && campaign?.state === 'paused')) && campaign.groupIds.includes(groupId) && !campaign.destinationHealth?.[groupId]?.suspended && group?.authorized && Boolean(group.simulation) === (this.adapter.status.mode === 'simulated') && isWithinSchedule(this.now(), this._groupConfig(campaign, groupId).schedule) && (!campaign.endAt || this.now() < campaign.endAt);
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
      nextAttemptAt: null,
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

  async _sendJob(job, signal, { ownsSubmissionTurn = false } = {}) {
    const campaign = this.store.getCampaign(job.campaignId);
    const policy = campaign?.retryPolicy || { maxAttempts: 3, delaySeconds: 3 };
    try { assertCampaignSchemaCompatible(campaign, job.itemSnapshot); }
    catch (error) { if (error.code === 'CAMPAIGN_VERSION_REVIEW') return this._cancelVersionReviewJob(job, error); throw error; }
    const maySend = () => this._maySend(job.campaignId, job.groupId, { manual: job.manualResend === true }) && this._itemStillConfigured(job);
    const preservePending = () => {
      const c = this.store.getCampaign(job.campaignId);
      return !this._automationStopped() && !this.persistenceFailed && c && this._itemStillConfigured(job) && !(c.endAt && this.now() >= c.endAt) && (c.executionRecovery || c.state === 'active' && (!this._connected() || !isWithinSchedule(this.now(), this._groupConfig(c, job.groupId).schedule)));
    };
    const attemptsAlreadyUsed = Number(this.store.getJob(job.id)?.attempts) || 0;
    if (attemptsAlreadyUsed >= policy.maxAttempts) {
      this._persist('updateJob', job.id, { status: 'failed', resultAt: this.now(), errorCode: 'SEND_RETRY_LIMIT', error: 'Limite persistido de tentativas atingido; nenhum novo envio foi realizado.' });
      this._diagnostic(job, 'SEND_RETRY_LIMIT', 'As tentativas confirmadas anteriores já consumiram o limite configurado.', attemptsAlreadyUsed, 'Revise a falha; reiniciar ou reconectar não reinicia o limite.');
      return 'failed';
    }
    for (let attempt = attemptsAlreadyUsed + 1; attempt <= policy.maxAttempts; attempt++) {
      let releaseTurn = () => {};
      try {
      if (!ownsSubmissionTurn) {
        try { const turn = this._campaignSubmissionTurn(job, signal); releaseTurn = typeof turn === 'function' ? turn : await turn; }
        catch (error) { if (error.code === 'SUBMISSION_ABORTED') return preservePending() ? 'queued' : 'cancelled'; throw error; }
      }
      if (signal.aborted || !maySend()) return preservePending() ? 'queued' : 'cancelled';
      const at = this.now();
      const live = this.store.getCampaign(job.campaignId);
      if (!isWithinSchedule(at, this._groupConfig(live, job.groupId).schedule)) return preservePending() ? 'queued' : 'cancelled';
      const persisted = this.store.getJob(job.id);
      // Accepted, ambiguous and terminal tasks are never submitted a second time.
      if (persisted && !['queued'].includes(persisted.status)) return persisted.status;
      this._persist('updateJob', job.id, { status: 'sending', attempts: attempt, firstAttemptAt: job.firstAttemptAt ?? at, attemptStartedAt: at });
      job.firstAttemptAt ??= at;
      this.lastSubmissionAt = at;
      this.lastSubmissionGroupId = job.groupId;
      this.emit('change');
      if (signal.aborted || !maySend()) {
        const status = preservePending() ? 'queued' : 'cancelled';
        this._persist('updateJob', job.id, { status, resultAt: status === 'queued' ? null : this.now(), error: 'Tentativa interrompida antes de submeter a mensagem.' });
        return status;
      }
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
        const retainedCampaign = this.store.getCampaign(job.campaignId);
        const technicalPause = retainedCampaign?.executionRecovery || retainedCampaign?.state === 'active' && (!this._connected() || !isWithinSchedule(this.now(), this._groupConfig(retainedCampaign, job.groupId).schedule));
        if (error?.submitted === false && technicalPause && this._itemStillConfigured(job) && !this._automationStopped() && !(error.safeToRetry === true && attempt >= policy.maxAttempts)) {
          const nextAttemptAt = error.safeToRetry === true ? this.now() + Math.max(Math.min(3600000, policy.delaySeconds * 1000 * (policy.backoffFactor ?? 2) ** (attempt - 1)), (this.adapter.minimumSpacingSeconds ?? 3) * 1000) : this.now();
          this._persist('updateJob', job.id, { status: 'queued', resultAt: null, nextAttemptAt, errorCode: error.code || 'CAMPAIGN_WAITING_NEXT_SLOT', error: 'Submissão não ocorreu; item pendente aguardando conexão e o próximo horário autorizado.' });
          return 'queued';
        }
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
          const retryDelayMs = Math.max(Math.min(3600000, policy.delaySeconds * 1000 * (policy.backoffFactor ?? 2) ** (attempt - 1)), (this.adapter.minimumSpacingSeconds ?? 3) * 1000);
          this._persist('updateJob', job.id, { status: 'queued', nextAttemptAt: this.now() + retryDelayMs, error: 'Falha confirmada anterior à submissão; tentativa limitada pendente.' });
          this._diagnostic(job, code, 'Falha temporária anterior à submissão.', attempt, 'Nova tentativa limitada, com intervalo progressivo.');
          releaseTurn();
          await this._wait(retryDelayMs, signal);
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
        if (!this._connected()) this._interruptActive('Conexão indisponível; itens pendentes preservados até o próximo horário após recuperar.', 'connection');
        this.emit('change');
        return status;
      }
      } finally { releaseTurn(); }
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
        const status = await this._sendJob(job, context.signal, { ownsSubmissionTurn: true });
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

  async _runRound(campaign, { scheduledAt = campaign.nextRunAt, pending = null } = {}) {
    const at = this.now();
    const history = this._history(campaign);
    const groups = campaign.groupIds.filter(groupId => {
      if (campaign.destinationHealth?.[groupId]?.suspended || !this._eligibleItems(campaign, groupId).length) return false;
      const config = this._groupConfig(campaign, groupId);
      const last = campaign.groupLastScheduledSlots?.[groupId] ?? history.get(groupId)?.lastAt;
      const onGrid = nextComputerRoundSlot(scheduledAt, config.schedule, config.intervalMinutes, { anchorAt: campaign.roundAnchorAt }) === scheduledAt;
      return onGrid && (pending ? pending.jobs.some(j => j.groupId === groupId && (!j.nextAttemptAt || j.nextAttemptAt <= at)) : last === undefined || last === null || last + config.intervalMinutes * 60000 <= scheduledAt) && isWithinSchedule(at, config.schedule);
    });
    if (!groups.length) return;
    const round = pending ? { ...pending.round, status: 'running', finishedAt: null, resumedAt: at, resumeSlotAt: scheduledAt, resumeCount: (pending.round.resumeCount || 0) + 1 } : { id: randomUUID(), campaignId: campaign.id, startedAt: at, scheduledAt, computerTimezone: this.getClockStatus().timezone, finishedAt: null, status: 'running', sequence: campaign.roundIndex || 0 };
    const controller = new AbortController();
    this.currentRound = { ...round, controller };
    if (pending) this._persist('updateRound', round.id, round); else this._persist('insertRound', round);
    const jobs = pending ? pending.jobs.filter(j => groups.includes(j.groupId) && (!j.nextAttemptAt || j.nextAttemptAt <= at)) : [];
    for (const groupId of pending ? [] : groups) {
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
    this._persist('saveCampaign', { ...campaign, roundIndex: (campaign.roundIndex || 0) + (pending ? 0 : 1), nextRunAt: null, lastRoundAt: at, lastRoundScheduledAt: scheduledAt, lastExecutionDayKey: computerDateKey(at), executionPendingRoundId: round.id, executionRecovery: null, scheduleClock: this.getClockStatus(), groupLastScheduledSlots: { ...(campaign.groupLastScheduledSlots || {}), ...Object.fromEntries(groups.map(id => [id, scheduledAt])) } });
    this.emit('change');
    let roundStatus = 'completed';
    try {
      for (const job of jobs) {
        const current = this.store.getCampaign(campaign.id);
        if (controller.signal.aborted || current?.state !== 'active' || !this._connected() || this._automationStopped()) { roundStatus = current?.executionRecovery || !this._connected() ? 'interrupted' : 'cancelled'; break; }
        const currentItems = this._groupConfig(current, job.groupId).items;
        let config = this._groupConfig(current, job.groupId);
        if (!isWithinSchedule(this.now(), config.schedule)) { roundStatus = 'interrupted'; break; }
        if (!this._maySend(campaign.id, job.groupId) || !currentItems.some(item => item.id === job.itemId && !item.captureDeleted && item.ready !== false)) {
          this._persist('updateJob', job.id, { status: 'cancelled', resultAt: this.now(), error: 'Destino suspenso, removido ou item retirado antes do envio.' });
          continue;
        }
        config = this._groupConfig(this.store.getCampaign(campaign.id), job.groupId);
        const spacing = this.lastSubmissionGroupId === job.groupId ? campaign.messageSpacingSeconds ?? campaign.spacingSeconds : campaign.groupSpacingSeconds ?? campaign.spacingSeconds;
        if (this.lastSubmissionAt !== null) await this._wait(Math.max(0, spacing * 1000 - (this.now() - this.lastSubmissionAt)), controller.signal);
        if (controller.signal.aborted || !this._connected() || this.store.getCampaign(campaign.id)?.state !== 'active') { roundStatus = this.store.getCampaign(campaign.id)?.executionRecovery || !this._connected() ? 'interrupted' : 'cancelled'; break; }
        config = this._groupConfig(this.store.getCampaign(campaign.id), job.groupId);
        if (!isWithinSchedule(this.now(), config.schedule)) { roundStatus = 'interrupted'; break; }
        if (!this._maySend(campaign.id, job.groupId)) { this._persist('updateJob', job.id, { status: 'cancelled', resultAt: this.now(), error: 'Destino suspenso ou removido durante o intervalo.' }); continue; }
        config = this._groupConfig(this.store.getCampaign(campaign.id), job.groupId);
        if (!isWithinSchedule(this.now(), config.schedule)) { roundStatus = 'interrupted'; break; }
        const live = this.store.getCampaign(campaign.id);
        if (live.endAt && this.now() >= live.endAt) { roundStatus = 'limited'; break; }
        if (live.dailySendLimit && this._counts(campaign.id, this.now()).sends >= live.dailySendLimit) { roundStatus = 'interrupted'; break; }
        const result = await this._sendJob(job, controller.signal);
        if (result === 'cancelled') this._persist('updateJob', job.id, { status: 'cancelled', resultAt: this.now(), error: 'Envio cancelado antes da submissão.' });
      }
    } catch (error) {
      roundStatus = 'interrupted';
      // A store/network boundary exception leaves a sending job ambiguous.
      for (const job of this.store.listJobs({ roundId: round.id, status: 'sending', limit: 1000000 })) this._persist('updateJob', job.id, { status: 'uncertain', resultAt: this.now(), error: 'Execução interrompida; revisão manual obrigatória.' });
      await this.pause(campaign.id, 'A rodada foi interrompida.');
    } finally {
      const liveBeforeFinish = this.store.getCampaign(campaign.id);
      const remaining = this.store.listJobs({ roundId: round.id, status: 'queued', limit: 1000000 }).filter(job => {
        if (!liveBeforeFinish) return true;
        const config = this._groupConfig(liveBeforeFinish, job.groupId);
        const nextSlot = nextComputerRoundSlot(this.now(), config.schedule, config.intervalMinutes, { strictlyFuture: true, anchorAt: liveBeforeFinish.roundAnchorAt });
        if (Number.isFinite(nextSlot) && (!liveBeforeFinish.endAt || nextSlot < liveBeforeFinish.endAt)) return true;
        // Preserve technical interruptions only when this destination can
        // actually run again. A definitive end date must not leave dangling
        // queued work or hold eligible destinations in an interrupted round.
        this._persist('updateJob', job.id, { status: 'cancelled', resultAt: this.now(), errorCode: 'CAMPAIGN_SCHEDULE_ENDED', error: 'Programação encerrada para este destino; não há próximo horário autorizado.' });
        return false;
      });
      const preserve = remaining.length > 0 && !this.closed && !this._automationStopped() && liveBeforeFinish && (liveBeforeFinish.executionRecovery || liveBeforeFinish.state === 'active') && !(liveBeforeFinish.endAt && this.now() >= liveBeforeFinish.endAt);
      if (!preserve) for (const job of remaining) this._persist('updateJob', job.id, { status: 'cancelled', resultAt: this.now(), error: 'Rodada encerrada por ação manual ou término definitivo; nenhum reenvio.' });
      if (preserve) roundStatus = 'interrupted';
      this._persist('updateRound', round.id, { status: roundStatus, finishedAt: this.now(), ...(preserve ? { interruptedAt: this.now() } : {}) });
      this.currentRound = null;
      const live = this.store.getCampaign(campaign.id);
      if (live?.state === 'active') {
        const next = this._nextEligibleAt(live, this.now(), { afterRound: true, includePending: preserve });
        const finished = (live.maxRounds && (live.roundIndex || 0) >= live.maxRounds) || (live.endAt && this.now() >= live.endAt) || !live.groupIds.some(id => Number.isFinite(nextScheduledAt(this.now(), this._groupConfig(live, id).schedule)));
        this._persist('saveCampaign', { ...live, state: Number.isFinite(next) ? 'active' : finished ? 'stopped' : 'paused', nextRunAt: Number.isFinite(next) ? next : null, executionPendingRoundId: preserve ? round.id : null, ...(Number.isFinite(next) || finished ? {} : { pauseReason: 'Nenhum item ou destino está elegível. Revise os envios incertos e os grupos suspensos.', pausedAt: this.now() }) });
      } else if (live && !preserve && live.executionPendingRoundId === round.id) {
        this._persist('saveCampaign', { ...live, executionPendingRoundId: null });
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
      `Referência de execução: relógio e fuso do computador (${this.getClockStatus().timezone}). As rodadas seguem a grade a partir da abertura da janela, sem deslocar os horários por atrasos.`,
      `Datas: ${p.startDate || 'sem início fixo'} a ${p.endDate || 'sem encerramento fixo'}.`,
      `Limites diários: ${c.dailyRoundLimit || 'sem limite'} rodada(s); ${c.dailySendLimit || 'sem limite'} envio(s).`,
      ...(overrides.length ? ['Configuração individual:', ...overrides] : []),
      `Estimativa máxima: ${Number.isFinite(estimated) ? estimated : 0} envio(s) por dia ativo; filas e horários podem reduzir esse total.`,
      `Próximo início: ${c.nextRunAt ? new Date(c.nextRunAt).toLocaleString('pt-BR') : 'não agendado'}.`,
      'O computador precisa estar ligado, conectado à internet e sem suspensão. Rodadas perdidas não são acumuladas. Envio aceito significa confirmação da integração; entrega depende de evento posterior disponível. Um resultado incerto fica para revisão, sem bloquear as outras tarefas elegíveis e sem reenvio automático do mesmo item ao mesmo destino.'
    ].join('\n');
  }

  async shutdown({ preserveRecovery = true } = {}) {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (preserveRecovery) this._interruptActive('Aplicativo encerrado; a recuperação aguardará a conexão e o próximo horário programado.', 'restart');
    else this._pauseActive('Aplicativo encerrado pelo administrador.', { includeRecovery: true });
    this.currentRound?.controller.abort();
    if (this.worker) await this.worker;
    this.closed = true;
    await this.externalSubmissions;
    this.adapter.off('status', this.statusListener);
    this.adapter.off('receipt', this.receiptListener);
  }
}

module.exports = { Scheduler, isWithinSchedule, nextScheduledAt, nextRoundSlot, dateKey, nextComputerRoundSlot, computerClockStatus };
