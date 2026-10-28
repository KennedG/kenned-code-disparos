'use strict';

const { EventEmitter } = require('node:events');
const { randomUUID, randomBytes } = require('node:crypto');
const ITEM_TYPES = new Set(['text', 'image', 'video', 'document']);

function dateKey(value) {
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
    endDate: schedule.endDate || ''
  };
}

// An overnight window belongs to the weekday/date on which it opens.
function isWithinSchedule(timestamp, schedule = {}) {
  const p = scheduleParts(schedule);
  const d = new Date(timestamp);
  const minute = d.getHours() * 60 + d.getMinutes();
  if (p.start !== p.end) {
    if (p.start < p.end && (minute < p.start || minute >= p.end)) return false;
    if (p.start > p.end) {
      if (minute >= p.end && minute < p.start) return false;
      if (minute < p.end) d.setDate(d.getDate() - 1);
    }
  }
  const key = dateKey(d);
  return p.days.includes(d.getDay()) && (!p.startDate || key >= p.startDate) && (!p.endDate || key <= p.endDate);
}

function nextScheduledAt(timestamp, schedule = {}) {
  if (isWithinSchedule(timestamp, schedule)) return timestamp;
  const p = scheduleParts(schedule);
  if (!p.days.length) return Infinity;
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

function nextLocalDay(timestamp) {
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
  constructor({ store, adapter, now = () => Date.now(), sleep = defaultSleep }) {
    super();
    this.store = store;
    this.now = now;
    this.sleep = sleep;
    this.timer = null;
    this.worker = null;
    this.busy = false;
    this.persistenceFailed = false;
    this.currentRound = null;
    this.lastSubmissionAt = null;
    this.closed = false;
    this.submissionHolds = 0;
    this.externalSubmissions = Promise.resolve();
    this.receipts = new Map();
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
    this.statusListener = status => {
      if (status.state !== 'connected') this._pauseActive(`Conexão indisponível: ${status.state}.`);
      this.emit('change');
    };
    this.receiptListener = receipt => {
      if (receipt.status !== 'confirmed' || !receipt.messageId) return;
      this.receipts.set(receipt.messageId, this.now());
      if (this.receipts.size > 1000) this.receipts.delete(this.receipts.keys().next().value);
      try {
        for (const job of this.store.listJobs({ status: 'uncertain', messageId: receipt.messageId, limit: 1000000 })) {
          if (job.messageId === receipt.messageId) this._persist('updateJob', job.id, { status: 'confirmed', resultAt: this.now(), error: null });
        }
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
    if (!override?.enabled) return { intervalMinutes: campaign.intervalMinutes, schedule: campaign.schedule || {}, items: campaign.items || [] };
    return {
      intervalMinutes: override.intervalMinutes ?? campaign.intervalMinutes,
      schedule: { ...(campaign.schedule || {}), ...(override.schedule || {}) },
      items: Array.isArray(override.items) && override.items.length ? override.items : campaign.items || []
    };
  }

  _validateSchedule(schedule = {}) {
    const p = scheduleParts(schedule);
    if (!Array.isArray(p.days) || !p.days.length || p.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('Selecione dias da semana válidos.');
    if (!Number.isFinite(p.start) || !Number.isFinite(p.end)) throw new Error('Informe os horários no formato HH:mm.');
    for (const value of [p.startDate, p.endDate]) {
      if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || dateKey(new Date(`${value}T12:00:00`)) !== value)) throw new Error('Informe datas válidas no formato AAAA-MM-DD.');
    }
    if (p.startDate && p.endDate && p.startDate > p.endDate) throw new Error('A data de encerramento deve ser posterior ao início.');
  }

  _validateCampaign(campaign) {
    if (!campaign) throw new Error('Campanha não encontrada.');
    if (!campaign.name?.trim()) throw new Error('Informe um nome para a campanha.');
    if (!['repeat', 'rotate'].includes(campaign.mode)) throw new Error('Escolha repetir ou alternar os conteúdos.');
    const retries = campaign.retryPolicy || { maxAttempts: 3, delaySeconds: 3 };
    if (!Number.isInteger(retries.maxAttempts) || retries.maxAttempts < 1 || retries.maxAttempts > 5 || !Number.isFinite(retries.delaySeconds) || retries.delaySeconds < 3 || retries.delaySeconds > 3600) throw new Error('Configure entre 1 e 5 tentativas, com intervalo entre 3 e 3600 segundos.');
    if (!Number.isFinite(campaign.intervalMinutes) || campaign.intervalMinutes < 1) throw new Error('O intervalo entre rodadas deve ser de pelo menos 1 minuto.');
    const minimumSpacing = Math.max(3, this.adapter.minimumSpacingSeconds ?? 3);
    if (!Number.isFinite(campaign.spacingSeconds) || campaign.spacingSeconds < minimumSpacing) throw new Error(`O espaçamento deve ser de pelo menos ${minimumSpacing} segundo(s).`);
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
    if (this.store.listJobs({ campaignId: campaign.id, status: 'uncertain', limit: 1 }).length) throw new Error('Revise os envios com resultado incerto no Histórico antes de retomar.');
  }

  _counts(campaignId, at) {
    if (this.store.getCampaignCounts) return this.store.getCampaignCounts(campaignId, at);
    const key = dateKey(at);
    const rounds = this.store.listRounds(campaignId).filter(r => dateKey(r.startedAt) === key).length;
    const sends = this.store.listJobs({ campaignId, limit: 1000000 }).filter(j => j.attempts > 0 && dateKey(j.firstAttemptAt ?? j.createdAt) === key).length;
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
    const counts = this._counts(campaign.id, at);
    let lower = at;
    if ((campaign.dailyRoundLimit && counts.rounds >= campaign.dailyRoundLimit) || (campaign.dailySendLimit && counts.sends >= campaign.dailySendLimit)) lower = nextLocalDay(at);
    const history = this._history(campaign);
    let next = Infinity;
    for (const groupId of campaign.groupIds) {
      const config = this._groupConfig(campaign, groupId);
      const last = history.get(groupId)?.lastAt;
      const interval = config.intervalMinutes * 60000;
      const due = last === undefined || last === null ? lower : afterRound ? nextRoundSlot(last, at, interval) : last + interval;
      next = Math.min(next, nextScheduledAt(Math.max(lower, due), config.schedule));
    }
    return next;
  }

  async activate(id) {
    if (this.closed) throw new Error('O agendador está encerrado.');
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
    for (const campaign of this.store.listCampaigns()) {
      if (['active', 'paused'].includes(campaign.state)) this._persist('saveCampaign', { ...campaign, state: 'stopped', nextRunAt: null });
      this._cancelQueued(campaign.id, 'Todos os envios foram interrompidos.');
    }
    this.emit('change');
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

  runExternalSubmission(task) {
    // All private alerts and search results share this queue. Holding the
    // scheduler immediately prevents a new campaign round taking their slot.
    const release = this.holdSubmissions();
    const operation = this.externalSubmissions.catch(() => {}).then(async () => {
      await this.waitForIdle();
      if (this.closed || this.persistenceFailed || this.store.persistenceFailed) throw new Error('Envios externos bloqueados: processamento indisponível.');
      return task();
    });
    this.externalSubmissions = operation.catch(() => {});
    return operation.finally(release);
  }

  tick() {
    if (this.store.persistenceFailed) this.blockOnPersistenceFailure();
    if (this.closed || this.persistenceFailed || this.submissionHolds) return Promise.resolve();
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
      if (this.closed || !this._connected()) break;
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

  _maySend(campaignId, groupId) {
    if (this.store.persistenceFailed) { this.blockOnPersistenceFailure(); return false; }
    const campaign = this.store.getCampaign(campaignId);
    const group = this.store.getGroup(groupId);
    return !this.closed && !this.persistenceFailed && this._connected() && campaign?.state === 'active' && campaign.groupIds.includes(groupId) && group?.authorized && Boolean(group.simulation) === (this.adapter.status.mode === 'simulated');
  }

  async _wait(ms, signal) {
    if (signal.aborted || ms <= 0) return;
    let listener;
    const cancelled = new Promise(resolve => { listener = resolve; signal.addEventListener('abort', listener, { once: true }); });
    try { await Promise.race([this.sleep(ms, signal), cancelled]); }
    finally { signal.removeEventListener('abort', listener); }
  }

  async _sendJob(job, signal) {
    const policy = this.store.getCampaign(job.campaignId)?.retryPolicy || { maxAttempts: 3, delaySeconds: 3 };
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      if (signal.aborted || !this._maySend(job.campaignId, job.groupId)) return 'cancelled';
      const at = this.now();
      const live = this.store.getCampaign(job.campaignId);
      const config = this._groupConfig(live, job.groupId);
      if (!isWithinSchedule(at, config.schedule)) return 'cancelled';
      // This durable transition must precede the irreversible network request.
      this._persist('updateJob', job.id, { status: 'sending', attempts: attempt, firstAttemptAt: job.firstAttemptAt ?? at });
      job.firstAttemptAt ??= at;
      this.lastSubmissionAt = at;
      this.emit('change');
      // A settings/media/receipt write can fail in a synchronous change
      // listener after the sending transition. Recheck immediately before the
      // irreversible network request, including the shared storage fault flag.
      if (signal.aborted || !this._maySend(job.campaignId, job.groupId)) return 'cancelled';
      try {
        const result = await this.adapter.send(job.groupId, { ...job.itemSnapshot, clientMessageId: job.messageId }, job.itemSnapshot.mediaId ? this.store.getMedia(job.itemSnapshot.mediaId) : null);
        const confirmed = result?.status === 'confirmed' || this.receipts.has(result?.messageId || job.messageId);
        this._persist('updateJob', job.id, {
          status: confirmed ? 'confirmed' : 'uncertain', messageId: result?.messageId || job.messageId, resultAt: this.now(),
          error: confirmed ? null : 'Resultado incerto; revise antes de qualquer reenvio.'
        });
        this.emit('change');
        return confirmed ? 'confirmed' : 'uncertain';
      } catch (error) {
        const safeRetry = error?.safeToRetry === true;
        const definitive = safeRetry || error?.definitive === true;
        const restricted = this.adapter.status.state === 'restricted' || error?.restricted === true;
        const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : definitive ? 'SEND_FAILED' : 'SEND_UNCERTAIN';
        if (safeRetry && attempt < policy.maxAttempts && !restricted && !signal.aborted && this._connected()) {
          this._persist('updateJob', job.id, { status: 'queued', error: 'Falha anterior à submissão; tentativa limitada pendente.' });
          this._diagnostic(job, code, 'Falha temporária anterior à submissão.', attempt, 'Nova tentativa limitada agendada.');
          await this._wait(Math.max(policy.delaySeconds * 1000, (this.adapter.minimumSpacingSeconds ?? 3) * 1000), signal);
          continue;
        }
        const status = definitive ? 'failed' : 'uncertain';
        // Persist only a curated description; adapter exceptions can contain secrets.
        this._persist('updateJob', job.id, { status, resultAt: this.now(), errorCode: code, error: definitive ? 'Falha confirmada; limite de tentativas atingido ou envio interrompido.' : 'Falha com submissão desconhecida; revisão manual obrigatória.' });
        this._diagnostic(job, code, definitive ? 'Envio não confirmado por falha definitiva ou limite de tentativas.' : 'O serviço não confirmou o resultado da submissão.', attempt, definitive ? 'Campanha interrompida; confira a conexão e a configuração.' : 'Revisão manual obrigatória; nenhum reenvio automático.');
        this.emit('change');
        if (restricted) this._pauseActive('Restrição informada pela integração.');
        if (definitive && !signal.aborted && (this._connected() || restricted)) this._incident(job.campaignId, 'fatal', code, 'Falha definitiva ou limite de tentativas atingido.');
        else if (!definitive) this._incident(job.campaignId, 'uncertain', code, 'Resultado de envio incerto; revisão manual obrigatória.');
        return status;
      }
    }
    return 'failed';
  }

  _diagnostic(job, code, description, attempts, action) {
    if (!this.store.addDiagnostic) return;
    const c = this.store.getCampaign(job.campaignId);
    this._persist('addDiagnostic', { id: randomUUID(), at: this.now(), campaignId: job.campaignId, userId: c?.ownerId || c?.ownerUserId || null, stage: 'envio', code, description, attempts, action, guidance: 'Confira a conexão, a autorização do grupo e a existência da mídia. Resultados incertos precisam de revisão.' });
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
      const items = campaign.mode === 'rotate' ? [config.items[index % config.items.length]] : config.items;
      for (const item of items) {
        const job = { id: randomUUID(), roundId: round.id, campaignId: campaign.id, groupId, itemId: item.id, itemSnapshot: structuredClone(item), status: 'queued', createdAt: at, attempts: 0, messageId: randomBytes(16).toString('hex').toUpperCase(), resultAt: null, error: null };
        this._persist('insertJob', job);
        jobs.push(job);
      }
    }
    this._persist('saveCampaign', { ...campaign, roundIndex: (campaign.roundIndex || 0) + 1, nextRunAt: null });
    this.emit('change');
    let roundStatus = 'completed';
    try {
      for (const job of jobs) {
        if (controller.signal.aborted || !this._maySend(campaign.id, job.groupId)) { roundStatus = 'cancelled'; break; }
        let config = this._groupConfig(this.store.getCampaign(campaign.id), job.groupId);
        if (!isWithinSchedule(this.now(), config.schedule)) { this._persist('updateJob', job.id, { status: 'cancelled', resultAt: this.now(), error: 'Fora do horário autorizado.' }); continue; }
        if (this.lastSubmissionAt !== null) await this._wait(Math.max(0, campaign.spacingSeconds * 1000 - (this.now() - this.lastSubmissionAt)), controller.signal);
        if (controller.signal.aborted || !this._maySend(campaign.id, job.groupId)) { roundStatus = 'cancelled'; break; }
        config = this._groupConfig(this.store.getCampaign(campaign.id), job.groupId);
        if (!isWithinSchedule(this.now(), config.schedule)) { this._persist('updateJob', job.id, { status: 'cancelled', resultAt: this.now(), error: 'Janela de horário encerrada.' }); continue; }
        const live = this.store.getCampaign(campaign.id);
        if (live.dailySendLimit && this._counts(campaign.id, this.now()).sends >= live.dailySendLimit) { roundStatus = 'limited'; break; }
        const result = await this._sendJob(job, controller.signal);
        if (result === 'uncertain') { roundStatus = 'uncertain'; this._incident(campaign.id, 'uncertain', 'SEND_UNCERTAIN', 'Resultado incerto exige revisão manual.'); await this.pause(campaign.id, 'Resultado incerto exige revisão manual.'); break; }
        if (result === 'failed' && this.store.getCampaign(campaign.id)?.state === 'stopped') { roundStatus = 'failed'; break; }
        if (result === 'cancelled') { roundStatus = 'cancelled'; break; }
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
        this._persist('saveCampaign', { ...live, state: Number.isFinite(next) ? 'active' : 'stopped', nextRunAt: Number.isFinite(next) ? next : null });
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
      `Intervalo entre inícios: ${c.intervalMinutes} min. Espaçamento entre envios: ${c.spacingSeconds} s.`,
      `Dias: ${p.days.map(d => days[d]).join(', ')}. Horário: ${c.schedule?.startTime || '00:00'}–${c.schedule?.endTime || '00:00'} (${duration / 60} h).`,
      `Datas: ${p.startDate || 'sem início fixo'} a ${p.endDate || 'sem encerramento fixo'}.`,
      `Limites diários: ${c.dailyRoundLimit || 'sem limite'} rodada(s); ${c.dailySendLimit || 'sem limite'} envio(s).`,
      ...(overrides.length ? ['Configuração individual:', ...overrides] : []),
      `Estimativa máxima: ${Number.isFinite(estimated) ? estimated : 0} envio(s) por dia ativo; filas e horários podem reduzir esse total.`,
      `Próximo início: ${c.nextRunAt ? new Date(c.nextRunAt).toLocaleString('pt-BR') : 'não agendado'}.`,
      'O computador precisa estar ligado, conectado à internet e sem suspensão. Rodadas perdidas não são acumuladas. Confirmado significa confirmação do servidor; não confirma leitura pelos integrantes.'
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
