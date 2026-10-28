'use strict';
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { normalizePhone, renderMessage, isAllowedAt, nextAllowedAt, localDay, MINIMUM_SPACING_MS, ValidationError } = require('./models.cjs');
const TERMINAL = new Set(['accepted', 'delivered', 'uncertain', 'failed', 'cancelled']);
const ACTIVE_RUN = new Set(['active', 'scheduled']);
class QueueGuardError extends Error {
  constructor(message, code, { hold = false, until = null } = {}) { super(message); this.code = code; this.confirmedFailure = true; this.submitted = false; this.hold = hold; this.until = until; }
}
class InviteQueue extends EventEmitter {
  constructor({ store, adapter, now = Date.now, attemptTimeoutMs, maxAttempts, retryBaseMs, autoTick = true, tickIntervalMs = 500 } = {}) {
    super(); if (!store) throw new TypeError('store obrigatório');
    this.store = store; this.now = now; this.autoTick = autoTick; this.tickIntervalMs = tickIntervalMs;
    this.options = { attemptTimeoutMs, maxAttempts, retryBaseMs }; this._busy = false; this._started = false; this._shutdown = false; this._timer = null; this._inFlight = null; this._epoch = 0;
    this._lastClock = null; this._lastMonotonic = null; this._lastTimezone = null;
    this.setAdapter(adapter);
  }
  _all(kind, filter = {}) { return this.store.listAll(kind, filter); }
  _settings() { return this.store.getSetting('settings', {}); }
  _state() { return this.store.getSetting('queueState', { automationStopped: false, lastCompletedAt: null, recoveryAt: null }); }
  _saveState(patch) { const state = { ...this._state(), ...patch }; this.store.setSetting('queueState', state); return state; }
  _emitChange() { this.emit('change', this.getState()); }
  _diagnostic(stage, result, detail = {}) {
    const event = { id: randomUUID(), traceId: detail.jobId || detail.runId || randomUUID(), type: 'queue', at: this.now(), stage, result, ...detail };
    try { this.store.diagnostics?.(event); } catch { /* Never disclose credentials or recursively notify. */ }
    this.emit('diagnostic', event);
  }
  _interval(campaign) { return Math.max(MINIMUM_SPACING_MS, this.adapter?.minimumSpacingMs || 0, Number(campaign.intervalMs) || (Number(campaign.intervalValue) || 30) * (campaign.intervalUnit === 'minutes' ? 60000 : 1000)); }
  _connected() { return this.adapter?.status?.ready === true && this.adapter?.status?.state === 'connected'; }
  _ledger(contact) { return this.store.ledger(contact) || {}; }
  _eligible(contact, { allowRepeat = false, ignoreClaim = false, ownJobId = null, reviewedJobId = null } = {}) {
    if (!contact) return 'Contato não encontrado.';
    if (contact.self) return 'A própria conta conectada não participa desta campanha de convites.';
    if (contact.ambiguous) return 'Identidade ambígua: revise o vínculo antes de enviar.';
    if (!normalizePhone(contact.phone)) return 'Número completo indisponível ou inválido.';
    if (contact.blocked) return 'Contato bloqueado.';
    if (contact.optOut) return 'Contato pediu para não receber mensagens.';
    if (contact.muted) return 'Contato silenciado.';
    if (contact.authorized !== true) return 'Contato identificado, mas ainda não autorizado.';
    const ledger = this._ledger(contact);
    if (ledger.uncertain && !reviewedJobId) return 'Envio anterior com resultado incerto: revisão manual necessária.';
    if (!ignoreClaim && ledger.activeJobId && ledger.activeJobId !== ownJobId) return 'Já existe um convite reservado ou em processamento para este contato.';
    if (!allowRepeat && (ledger.previouslyInvited || this.store.isPreviouslyInvited(contact))) return 'Este contato já recebeu um convite.';
    return null;
  }
  _contactsFor(campaign) {
    const selected = new Set(campaign.contactIds || []), groups = new Set(campaign.groupIds || []);
    return this._all('contacts').filter(c => selected.size ? selected.has(c.id) : (c.groupIds || []).some(g => groups.has(g)));
  }
  preview(campaignOrId) {
    const campaign = typeof campaignOrId === 'string' ? this.store.get('campaigns', campaignOrId) : campaignOrId;
    if (!campaign) throw new ValidationError('Campanha não encontrada.', 'CAMPAIGN_NOT_FOUND');
    const recipients = [], excluded = []; let previousCount = 0, newCount = 0, uncertainCount = 0;
    for (const contact of this._contactsFor(campaign)) {
      const ledger = this._ledger(contact);
      if (ledger.uncertain) uncertainCount++;
      const reason = this._eligible(contact, { allowRepeat: campaign.mode === 'all' });
      if (reason) { excluded.push({ contactId: contact.id, name: contact.name || contact.displayName || '', phone: contact.phone || null, reason }); continue; }
      if (recipients.length >= campaign.executionLimit) { excluded.push({ contactId: contact.id, reason: 'Limite de contatos por execução atingido.' }); continue; }
      const text = renderMessage(campaign, contact); recipients.push({ ...contact, text });
      if (ledger.previouslyInvited || this.store.isPreviouslyInvited(contact)) previousCount++; else newCount++;
    }
    return { recipients, excluded, newCount, previousCount, uncertainCount, total: recipients.length,
      intervalMs: this._interval(campaign), estimatedMs: Math.max(0, recipients.length - 1) * this._interval(campaign), mode: campaign.mode || 'new' };
  }
  async activate(campaignId, { activationKey, recipientIds, confirmRepeat = false } = {}) {
    if (this.store.persistenceFailed) throw new ValidationError('O armazenamento está indisponível. Corrija a falha antes de iniciar envios.', 'STORAGE_UNAVAILABLE');
    if (!activationKey || typeof activationKey !== 'string' || activationKey.length > 200) throw new ValidationError('A confirmação de início é obrigatória.', 'ACTIVATION_KEY_REQUIRED');
    if (this._state().automationStopped) throw new ValidationError('Os envios estão parados. Clique em retomar automações antes de iniciar.', 'AUTOMATION_STOPPED');
    const at = this.now(); let result;
    this.store.transaction(() => {
      const previous = this._all('runs', { campaignId }).find(run => run.activationKey === activationKey);
      if (previous) { result = { ...previous, idempotent: true }; return; }
      const campaign = this.store.get('campaigns', campaignId);
      if (!campaign) throw new ValidationError('Campanha não encontrada.', 'CAMPAIGN_NOT_FOUND');
      if (this._all('runs', { campaignId }).some(r => ['active', 'scheduled', 'paused'].includes(r.status))) throw new ValidationError('A campanha já possui uma execução ativa ou pausada.', 'RUN_ALREADY_ACTIVE');
      const preview = this.preview(campaign);
      const selected = recipientIds ? new Set(recipientIds) : null;
      if (selected && [...selected].some(id => !preview.recipients.some(c => c.id === id))) throw new ValidationError('A prévia mudou. Revise novamente os destinatários.', 'PREVIEW_CHANGED');
      const recipients = preview.recipients.filter(c => !selected || selected.has(c.id));
      if (!recipients.length) throw new ValidationError('Nenhum contato elegível para iniciar. Confira autorizações, bloqueios e convites anteriores.', 'NO_ELIGIBLE_RECIPIENTS');
      if (campaign.mode === 'all' && !confirmRepeat) throw new ValidationError('Confirme explicitamente o reenvio aos contatos registrados.', 'REPEAT_CONFIRMATION_REQUIRED');
      const run = { id: randomUUID(), campaignId, activationKey, status: campaign.startAt && campaign.startAt > at ? 'scheduled' : 'active', createdAt: at, startedAt: at, finishedAt: null, waitFromAt: this._state().lastCompletedAt || null, mode: campaign.mode || 'new', total: recipients.length, nextEligibleAt: Math.max(at, campaign.startAt || 0, (this._state().lastCompletedAt || 0) + this._interval(campaign)), lastCompletedAt: null, reason: null };
      this.store.save('runs', run);
      for (const contact of recipients) {
        const job = { id: randomUUID(), runId: run.id, campaignId, contactId: contact.id, recipientKey: this.store.recipientKey(contact), phoneSnapshot: contact.phone,
          textSnapshot: contact.text, allowRepeat: campaign.mode === 'all', status: 'pending', attempts: 0, clientMessageId: `AC${randomUUID().replaceAll('-', '').toUpperCase()}`, messageId: null,
          createdAt: at, startedAt: null, submittedAt: null, resultAt: null, nextAttemptAt: at, errorCode: null, error: null, acceptedAt: null, deliveredAt: null };
        if (!this.store.claimRecipient(contact, job.id, { allowRepeat: job.allowRepeat, at })) throw new ValidationError('Um destinatário foi reservado por outra execução. Atualize a prévia.', 'RECIPIENT_ALREADY_RESERVED');
        this.store.save('jobs', job);
      }
      this.store.save('campaigns', { ...campaign, status: run.status, lastRunId: run.id, updatedAt: at });
      this.store.audit?.({ id: randomUUID(), event: 'campaign_activated', campaignId, runId: run.id, at, recipients: recipients.length, repeat: run.mode === 'all' }); result = run;
    });
    this._diagnostic('activated', 'pending', { campaignId, runId: result.id, idempotent: !!result.idempotent }); this._emitChange(); return result;
  }
  setAdapter(adapter) {
    if (this.adapter && this._onStatus) { this.adapter.off('status', this._onStatus); this.adapter.off('receipt', this._onReceipt); }
    this.adapter = adapter;
    this._onStatus = () => {
      const ready = this._connected();
      if (ready && !this._ready) this._recoveryHold('Conexão recuperada — aguardando intervalo configurado.');
      if (!ready && this._ready) { this._saveState({ disconnectedAt: this.now() }); this._diagnostic('connection', 'waiting_connection', { code: adapter.status?.reasonCode || 'DISCONNECTED' }); }
      this._ready = ready; this._emitChange();
    };
    this._onReceipt = receipt => { try { this._receipt(receipt); } catch (error) { this.store.persistenceFailed = true; this.emit('storageError', { code: error.code || 'RECEIPT_STORAGE_ERROR', error: safeError(error) }); this._diagnostic('receipt_storage', 'failed', { code: error.code || 'RECEIPT_STORAGE_ERROR', reason: safeError(error) }); } };
    this._ready = this._connected();
    adapter?.on('status', this._onStatus); adapter?.on('receipt', this._onReceipt);
  }
  _recoveryHold(reason) {
    const at = this.now(); this._saveState({ recoveryAt: at, reason, ...(this._state().lastCompletedAt > at ? { lastCompletedAt: at } : {}) });
    for (const run of this._all('runs').filter(r => ACTIVE_RUN.has(r.status))) {
      const campaign = this.store.get('campaigns', run.campaignId); if (!campaign) continue;
      this.store.save('runs', { ...run, waitFromAt: at, nextEligibleAt: Math.max(campaign.startAt || 0, at + this._interval(campaign)), reason });
    }
  }
  start() {
    if (this._started) return; this._started = true; this._shutdown = false;
    this.store.transaction(() => {
      for (const job of this._all('jobs', { status: 'processing' })) {
        const contact = this.store.get('contacts', job.contactId);
        if (job.submittedAt) this._finish(job, 'uncertain', { errorCode: 'INTERRUPTED_AFTER_SUBMISSION', error: 'O aplicativo foi interrompido após o início da submissão. Verifique antes de reenviar.' }, { notify: false });
        else this.store.save('jobs', { ...job, status: 'pending', errorCode: 'RECOVERED_BEFORE_SUBMISSION', error: 'Pendente recuperado antes da submissão.', startedAt: null });
      }
    });
    this._saveState({ suspended: false });
    this._recoveryHold('Aplicativo iniciado — aguardando intervalo configurado.');
    if (this.autoTick) { this._timer = setInterval(() => this.tick().catch(error => this._diagnostic('worker', 'failed', { code: error.code || 'WORKER_ERROR', reason: safeError(error) })), this.tickIntervalMs); this._timer.unref?.(); }
    this._emitChange();
  }
  async shutdown() {
    this._shutdown = true; this._epoch++; clearInterval(this._timer); this._timer = null;
    if (this._inFlight) { this._inFlight.controller.abort(); this._inFlight.interrupt?.({ error: this._interruptionError('Aplicativo encerrado durante tentativa.', 'APP_SHUTDOWN') }); }
    if (this._tickPromise) await this._tickPromise;
    if (this.adapter && this._onStatus) { this.adapter.off('status', this._onStatus); this.adapter.off('receipt', this._onReceipt); }
    this._started = false;
  }
  _checkClock() {
    const wall = this.now(), mono = performance.now(), zone = Intl.DateTimeFormat().resolvedOptions().timeZone + ':' + new Date(wall).getTimezoneOffset();
    if (this._lastClock !== null && (Math.abs((wall - this._lastClock) - (mono - this._lastMonotonic)) > 60000 || zone !== this._lastTimezone)) this._recoveryHold('Horário, fuso ou suspensão detectados — aguardando intervalo configurado.');
    this._lastClock = wall; this._lastMonotonic = mono; this._lastTimezone = zone;
  }
  async tick() {
    if (this._busy || this._shutdown) return;
    this._busy = true;
    this._tickPromise = this._tick().finally(() => { this._busy = false; this._tickPromise = null; });
    return this._tickPromise;
  }
  async _tick() {
    this._checkClock();
    if (this.store.persistenceFailed || this._state().suspended || this._state().automationStopped || !this._connected()) return;
    const at = this.now();
    const dailyCounts = new Map();
    const jobs = this._all('jobs', { status: 'pending' }).sort((a,b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    for (const job of jobs) {
      if (this._shutdown || this.store.persistenceFailed || this._state().suspended || this._state().automationStopped || !this._connected()) return;
      const run = this.store.get('runs', job.runId), campaign = this.store.get('campaigns', job.campaignId);
      if (!run || !campaign) { this._finish(job, 'cancelled', { errorCode: 'CAMPAIGN_REMOVED', error: 'A campanha ou execução foi removida.' }); continue; }
      if (!ACTIVE_RUN.has(run.status) || !['active','scheduled'].includes(campaign.status)) continue;
      const due = this._due(job, run, campaign);
      if (at < due || !isAllowedAt(campaign, at)) continue;
      if (!dailyCounts.has(campaign.id)) dailyCounts.set(campaign.id, this._dailyCount(campaign.id, at));
      if (dailyCounts.get(campaign.id) >= campaign.dailyLimit) continue;
      if (this._manualRetryConfirmed(job)) { this._finish(job, 'cancelled', { errorCode: 'PREVIOUS_SEND_CONFIRMED', error: 'O envio anterior foi confirmado após a revisão. Este reenvio pendente foi cancelado para evitar duplicação.' }); continue; }
      const contact = this.store.get('contacts', job.contactId), reason = this._eligible(contact, { allowRepeat: job.allowRepeat, ownJobId: job.id, reviewedJobId: job.reviewedJobId });
      if (reason) { this._finish(job, 'cancelled', { errorCode: 'CONTACT_NO_LONGER_ELIGIBLE', error: reason }); continue; }
      if (normalizePhone(contact.phone) !== normalizePhone(job.phoneSnapshot)) { this._finish(job, 'cancelled', { errorCode: 'IDENTITY_CHANGED', error: 'O número do contato mudou após a prévia. Revise uma nova execução.' }); continue; }
      await this._process(job, campaign, run, contact); return;
    }
    this._completeRuns();
  }
  _due(job, run, campaign, state = this._state()) {
    const runDue = Number.isFinite(run.waitFromAt) ? run.waitFromAt + this._interval(campaign) : run.nextEligibleAt || 0;
    return Math.max(job.nextAttemptAt || 0, runDue, campaign.startAt || 0, (state.lastCompletedAt || 0) + this._interval(campaign));
  }
  _manualRetryConfirmed(job) {
    if (!job.reviewedJobId) return false;
    return ['accepted','delivered'].includes(this.store.get('jobs', job.reviewedJobId)?.status);
  }
  _dailyCount(campaignId, at, exceptJobId = null) {
    if (this.store.getSubmissionCount) { const from = new Date(at); from.setHours(0,0,0,0); const to = new Date(from); to.setDate(to.getDate() + 1); return this.store.getSubmissionCount(campaignId, { from: from.getTime(), to: to.getTime(), exceptJobId }); }
    return this._all('jobs', { campaignId }).filter(j => j.id !== exceptJobId && j.submittedAt && localDay(j.submittedAt) === localDay(at)).length;
  }
  _guard(jobId) {
    if (this.store.persistenceFailed) throw new QueueGuardError('A gravação local falhou. Nenhum novo convite será enviado até a correção.', 'STORAGE_UNAVAILABLE', { hold: true });
    this._checkClock();
    const at = this.now(), job = this.store.get('jobs', jobId); if (!job || job.status !== 'processing') throw new QueueGuardError('Tarefa cancelada ou já finalizada.', 'JOB_NOT_PROCESSING');
    const run = this.store.get('runs', job.runId), campaign = this.store.get('campaigns', job.campaignId), contact = this.store.get('contacts', job.contactId);
    if (this._shutdown || this._state().automationStopped || !run || !campaign || !ACTIVE_RUN.has(run.status) || !['active','scheduled'].includes(campaign.status)) throw new QueueGuardError('O envio foi pausado ou encerrado antes da submissão.', 'AUTOMATION_PAUSED', { hold: !!run && run.status === 'paused' });
    if (this._state().suspended) throw new QueueGuardError('Computador em suspensão. Aguardando retomada segura.', 'SYSTEM_SUSPEND', { hold: true });
    if (!this._connected()) throw new QueueGuardError('Aguardando reconexão do WhatsApp.', 'NOT_CONNECTED', { hold: true });
    if (!isAllowedAt(campaign, at)) throw new QueueGuardError('Fora dos dias ou horários permitidos.', 'OUTSIDE_SCHEDULE', { hold: true, until: nextAllowedAt(campaign, at) });
    const due = this._due(job, run, campaign);
    if (at < due) throw new QueueGuardError('Aguardando o intervalo atualizado ou a recuperação da conexão.', 'INTERVAL_WAIT', { hold: true, until: due });
    if (this._dailyCount(campaign.id, at, job.id) >= campaign.dailyLimit) throw new QueueGuardError('Limite diário atingido.', 'DAILY_LIMIT', { hold: true });
    const reason = this._eligible(contact, { allowRepeat: job.allowRepeat, ownJobId: job.id, reviewedJobId: job.reviewedJobId });
    if (reason) throw new QueueGuardError(reason, 'CONTACT_NO_LONGER_ELIGIBLE');
    if (normalizePhone(contact.phone) !== normalizePhone(job.phoneSnapshot)) throw new QueueGuardError('O número mudou após a prévia.', 'IDENTITY_CHANGED');
    if (this._manualRetryConfirmed(job)) throw new QueueGuardError('O envio anterior recebeu confirmação. Reenvio pendente cancelado para evitar duplicação.', 'PREVIOUS_SEND_CONFIRMED');
    const ledger = this._ledger(contact);
    if (ledger.activeJobId !== job.id) throw new QueueGuardError('Reserva do destinatário não pertence mais a esta tarefa.', 'RECIPIENT_CLAIM_LOST');
    return { job, campaign, contact };
  }
  async _process(initial, campaign, run, contact) {
    const attemptAt = this.now(), attempt = (initial.attempts || 0) + 1;
    let job = this.store.save('jobs', { ...initial, status: 'processing', attempts: attempt, startedAt: attemptAt, errorCode: null, error: null });
    // Stores may return the persisted object or void; reread ensures a durable, current view.
    job = this.store.get('jobs', initial.id) || { ...initial, status: 'processing', attempts: attempt, startedAt: attemptAt };
    const controller = new AbortController(); let timeout, interrupt;
    const timeoutMs = this.options.attemptTimeoutMs ?? this._settings().attemptTimeoutMs ?? 30000;
    const wait = new Promise(resolve => { interrupt = resolve; timeout = setTimeout(() => { controller.abort(); resolve({ timeout: true }); }, timeoutMs); });
    this._inFlight = { job, controller, interrupt };
    const beforeSubmit = () => {
      const current = this._guard(job.id);
      if (!current.job.submittedAt) this.store.save('jobs', { ...current.job, submittedAt: this.now() });
      this._diagnostic('submitting', 'processing', { jobId: job.id, campaignId: job.campaignId, runId: job.runId, attempt, recipient: job.phoneSnapshot });
    };
    this._diagnostic('processing', 'processing', { jobId: job.id, campaignId: job.campaignId, runId: job.runId, attempt });
    let sendPromise;
    try {
      sendPromise = Promise.resolve().then(() => this.adapter.sendInvite(contact, job.textSnapshot, { clientMessageId: job.clientMessageId, signal: controller.signal, beforeSubmit }));
      // The detached continuation records only late positive proof, never retries.
      const originMode = this.store.getMode();
      sendPromise.then(result => {
        try { if (!this.store.closed && this.store.getMode() === originMode && this.store.get('jobs', job.id)?.status === 'uncertain') this._lateProof(job.id, result); } catch { /* Shutdown or storage failure leaves durable uncertainty for later reconciliation. */ }
      }, () => {});
      const result = await Promise.race([sendPromise.then(value => ({ value }), error => ({ error })), wait]);
      const current = this.store.get('jobs', job.id);
      if (!current || ['accepted','delivered'].includes(current.status)) return;
      if (result.timeout) {
        if (!current.submittedAt) this._handleError(current, new QueueGuardError('A tentativa expirou antes da submissão.', 'PRE_SUBMISSION_TIMEOUT'));
        else this._finish(current, 'uncertain', { errorCode: 'SEND_TIMEOUT', error: 'Sem confirmação dentro do prazo. O convite pode ter sido enviado; revisão necessária.' });
      } else if (result.error) this._handleError(current, result.error);
      else if (result.value) this._applyResult(current, result.value);
      else if (result.status) this._applyResult(current, result);
      else this._finish(current, current.submittedAt ? 'uncertain' : 'cancelled', { errorCode: 'INTERRUPTED', error: 'Tentativa interrompida.' });
    } finally {
      clearTimeout(timeout); this._inFlight = null;
      const at = this.now(); this._saveState({ lastCompletedAt: at });
      const currentRun = this.store.get('runs', run.id), currentCampaign = this.store.get('campaigns', campaign.id);
      if (currentRun && currentCampaign) this.store.save('runs', { ...currentRun, lastCompletedAt: at, waitFromAt: at, nextEligibleAt: at + this._interval(currentCampaign) });
      this._completeRuns(); this._emitChange();
    }
  }
  _handleError(job, error) {
    const message = safeError(error), code = error.code || 'SEND_ERROR';
    // An expired/aborted network request after submission is never a safe retry.
    if (job.submittedAt && !(error.confirmedFailure === true && error.submitted === false)) { this._finish(job, 'uncertain', { errorCode: code, error: message }); return; }
    if (error.hold) {
      this.store.save('jobs', { ...job, status: 'pending', attempts: Math.max(0, (job.attempts || 0) - 1), submittedAt: null, nextAttemptAt: this.now(), errorCode: code, error: message });
      this._diagnostic('held', 'pending', { jobId: job.id, campaignId: job.campaignId, code, reason: message }); return;
    }
    const max = this.options.maxAttempts ?? this._settings().maxAttempts ?? 3;
    if (error.confirmedFailure === true && error.retryable === true && error.submitted === false && job.attempts < max) {
      const base = this.options.retryBaseMs ?? this._settings().retryBaseMs ?? 10000;
      const delay = Math.min(3600000, base * (2 ** Math.min(job.attempts - 1, 10)));
      this.store.save('jobs', { ...job, status: 'pending', submittedAt: null, nextAttemptAt: this.now() + delay, errorCode: code, error: message });
      this._diagnostic('retry_scheduled', 'pending', { jobId: job.id, campaignId: job.campaignId, attempt: job.attempts, code, delayMs: delay, reason: message }); return;
    }
    this._finish(job, error instanceof QueueGuardError && !job.submittedAt ? 'cancelled' : 'failed', { errorCode: code, error: message });
  }
  _applyResult(job, result) {
    if (result.status === 'delivered' || result.status === 'accepted') this._finish(job, result.status, { messageId: result.messageId || job.clientMessageId, confirmationScope: result.confirmationScope || 'integration', errorCode: null, error: null });
    else if (result.status === 'failed' && result.confirmedFailure === true && result.submitted === false) this._handleError(job, Object.assign(new Error(result.error || 'Falha confirmada antes da submissão.'), result));
    else this._finish(job, 'uncertain', { messageId: result.messageId || job.clientMessageId, errorCode: result.errorCode || 'NO_ACCEPTANCE_PROOF', error: result.error || 'A integração não forneceu confirmação de aceitação. Não reenvie sem revisão.' });
  }
  _finish(jobOrId, status, details = {}, { notify = true } = {}) {
    let final;
    this.store.transaction(() => {
      const job = typeof jobOrId === 'string' ? this.store.get('jobs', jobOrId) : this.store.get('jobs', jobOrId.id) || jobOrId;
      if (!job) return;
      if (job.status === 'delivered' || (job.status === 'accepted' && status !== 'delivered') || (job.status === 'uncertain' && !['accepted','delivered'].includes(status))) { final = job; return; }
      const at = this.now();
      final = { ...job, ...details, status, resultAt: at, ...(status === 'accepted' || status === 'delivered' ? { acceptedAt: job.acceptedAt || at } : {}), ...(status === 'delivered' ? { deliveredAt: job.deliveredAt || at } : {}) };
      this.store.save('jobs', final);
      const contact = this.store.get('contacts', job.contactId);
      if (contact) this.store.markRecipient(contact, job.id, status, { at, messageId: final.messageId, recipientKey: job.recipientKey });
      this.store.save('history', { id: job.id, jobId: job.id, runId: job.runId, campaignId: job.campaignId, contactId: job.contactId, at, status, attempts: final.attempts, messageId: final.messageId || null, errorCode: final.errorCode || null, error: final.error || null, phone: job.phoneSnapshot });
    });
    if (notify && final) this._diagnostic('result', final.status, { jobId: final.id, runId: final.runId, campaignId: final.campaignId, messageId: final.messageId || null, code: final.errorCode || null, reason: final.error || null, attempt: final.attempts });
    return final;
  }
  _lateProof(jobId, result) {
    if (!result || !['accepted','delivered'].includes(result.status)) return;
    const job = this.store.get('jobs', jobId); if (!job) return;
    this._finish(job, result.status, { messageId: result.messageId || job.messageId || job.clientMessageId, confirmationScope: result.confirmationScope || 'late_integration', errorCode: null, error: null });
    this._diagnostic('late_confirmation', result.status, { jobId, campaignId: job.campaignId, messageId: result.messageId || job.clientMessageId }); this._emitChange();
  }
  _receipt(receipt) {
    if (!receipt?.messageId || !['accepted','delivered'].includes(receipt.status)) return;
    const jobs = this._all('jobs').filter(job => job.messageId === receipt.messageId || job.clientMessageId === receipt.messageId);
    for (const job of jobs) {
      if (!job.submittedAt && job.status !== 'uncertain') continue;
      this._lateProof(job.id, receipt);
      if (this._inFlight?.job.id === job.id) this._inFlight.interrupt({ value: receipt });
    }
  }
  _completeRuns() {
    for (const run of this._all('runs').filter(r => ACTIVE_RUN.has(r.status))) {
      const jobs = this._all('jobs', { runId: run.id });
      if (jobs.length && jobs.every(j => TERMINAL.has(j.status))) {
        this.store.save('runs', { ...run, status: 'completed', finishedAt: this.now() });
        const campaign = this.store.get('campaigns', run.campaignId);
        if (campaign && ['active','scheduled'].includes(campaign.status)) this.store.save('campaigns', { ...campaign, status: 'completed', updatedAt: this.now() });
      }
    }
  }
  _interruptionError(message, code) {
    const error = new QueueGuardError(message, code, { hold: true });
    if (this._inFlight && this.store.get('jobs', this._inFlight.job.id)?.submittedAt) { error.submitted = true; error.confirmedFailure = false; }
    return error;
  }
  pauseForSuspend() {
    this._saveState({ suspended: true, suspendedAt: this.now(), reason: 'Computador suspenso — envios interrompidos com segurança.' });
    if (this._inFlight) { this._inFlight.controller.abort(); this._inFlight.interrupt?.({ error: this._interruptionError('Tentativa interrompida pela suspensão do computador.', 'SYSTEM_SUSPEND') }); }
    this._emitChange(); return { suspended: true, inFlight: this._inFlight?.job.id || null };
  }
  onResume() {
    this._saveState({ suspended: false, resumedFromSuspendAt: this.now() });
    this._recoveryHold('Computador retomado — aguardando intervalo configurado.');
    this._emitChange(); return { resumed: true };
  }
  async pause(campaignId) {
    const campaign = this.store.get('campaigns', campaignId); if (!campaign) throw new ValidationError('Campanha não encontrada.', 'CAMPAIGN_NOT_FOUND');
    this.store.transaction(() => { this.store.save('campaigns', { ...campaign, status: 'paused', updatedAt: this.now() }); for (const run of this._all('runs', { campaignId }).filter(r => ACTIVE_RUN.has(r.status))) this.store.save('runs', { ...run, status: 'paused', reason: 'Pausado pelo usuário.' }); });
    this._diagnostic('paused', 'paused', { campaignId }); this._emitChange(); return { paused: true, inFlight: this._inFlight?.job.campaignId === campaignId };
  }
  async resume(campaignId) {
    if (this._state().automationStopped) throw new ValidationError('Retome primeiro as automações na parada geral.', 'AUTOMATION_STOPPED');
    const campaign = this.store.get('campaigns', campaignId); if (!campaign) throw new ValidationError('Campanha não encontrada.', 'CAMPAIGN_NOT_FOUND');
    const runs = this._all('runs', { campaignId }).filter(r => r.status === 'paused'); if (!runs.length) throw new ValidationError('Não há execução pausada para retomar.', 'NO_PAUSED_RUN');
    this.store.transaction(() => { this.store.save('campaigns', { ...campaign, status: 'active', updatedAt: this.now() }); for (const run of runs) this.store.save('runs', { ...run, status: 'active', waitFromAt: this.now(), nextEligibleAt: this.now() + this._interval(campaign), reason: 'Retomada confirmada — aguardando intervalo configurado.' }); });
    this._emitChange(); return { resumed: true };
  }
  async stop(campaignId) {
    const campaign = this.store.get('campaigns', campaignId); if (!campaign) throw new ValidationError('Campanha não encontrada.', 'CAMPAIGN_NOT_FOUND');
    let cancelled = 0;
    this.store.transaction(() => { this.store.save('campaigns', { ...campaign, status: 'stopped', updatedAt: this.now() }); for (const run of this._all('runs', { campaignId }).filter(r => [...ACTIVE_RUN,'paused'].includes(r.status))) this.store.save('runs', { ...run, status: 'stopped', finishedAt: this.now() }); for (const job of this._all('jobs', { campaignId, status: 'pending' })) { this._finish(job, 'cancelled', { errorCode: 'USER_STOPPED', error: 'Encerrado pelo usuário.' }, { notify: false }); cancelled++; } });
    this._emitChange(); return { cancelled, inFlight: this._inFlight?.job.campaignId === campaignId };
  }
  async stopAll() {
    this._saveState({ automationStopped: true, stoppedAt: this.now() }); let cancelled = 0, campaigns = 0;
    for (const campaign of this._all('campaigns').filter(c => ['active','scheduled','paused'].includes(c.status))) { const result = await this.stop(campaign.id); cancelled += result.cancelled; campaigns++; }
    // Orphaned pending jobs must not bypass a global stop.
    for (const job of this._all('jobs', { status: 'pending' })) { this._finish(job, 'cancelled', { errorCode: 'GLOBAL_STOPPED', error: 'Cancelado pela parada geral.' }); cancelled++; }
    const inFlight = this._inFlight?.job || null; this._diagnostic('global_stop', 'stopped', { cancelled, campaigns, inFlight: inFlight?.id || null }); this._emitChange(); return { stopped: true, cancelled, campaigns, inFlight: inFlight ? { jobId: inFlight.id, submitted: !!this.store.get('jobs', inFlight.id)?.submittedAt } : null };
  }
  resumeAutomation() { this._saveState({ automationStopped: false, resumedAt: this.now() }); this._recoveryHold('Automações liberadas — campanhas encerradas não são reiniciadas automaticamente.'); this._emitChange(); return { resumed: true, campaignsResumed: 0 }; }
  async retryJob(jobId, { confirmPossibleDuplicate = false, activationKey } = {}) {
    if (this.store.persistenceFailed) throw new ValidationError('O armazenamento está indisponível. Corrija a falha antes de reenviar.', 'STORAGE_UNAVAILABLE');
    const previous = this.store.get('jobs', jobId); if (!previous || !['uncertain','failed','cancelled'].includes(previous.status)) throw new ValidationError('Somente tarefas incertas, com falha ou canceladas podem ser revisadas.', 'JOB_NOT_RETRYABLE');
    if (this._state().automationStopped) throw new ValidationError('Retome primeiro as automações.', 'AUTOMATION_STOPPED');
    if (previous.status === 'uncertain' && !confirmPossibleDuplicate) throw new ValidationError('O convite pode ter sido enviado. Confirme o risco de duplicação antes de reenviar.', 'POSSIBLE_DUPLICATE_CONFIRMATION_REQUIRED');
    const campaign = this.store.get('campaigns', previous.campaignId), contact = this.store.get('contacts', previous.contactId);
    if (!campaign || !contact) throw new ValidationError('Campanha ou contato não encontrado.', 'RETRY_TARGET_MISSING');
    const at = this.now(); let result;
    this.store.transaction(() => {
      const key = activationKey || `manual:${previous.id}`;
      const existing = this._all('jobs', { campaignId: campaign.id }).find(j => j.manualRetryKey === key); if (existing) { result = existing; return; }
      const ledger = this._ledger(contact), reviewedJobId = ledger.uncertain ? previous.id : null;
      const reason = this._eligible(contact, { allowRepeat: true, reviewedJobId }); if (reason) throw new ValidationError(reason, 'CONTACT_NO_LONGER_ELIGIBLE');
      if (reviewedJobId) { if (!confirmPossibleDuplicate || !this.store.reviewUncertainRecipient) throw new ValidationError('A revisão do envio incerto é obrigatória.', 'UNCERTAIN_REVIEW_REQUIRED'); this.store.reviewUncertainRecipient(contact, previous.id, { allowManualDuplicate: true, at }); }
      const run = { id: randomUUID(), campaignId: campaign.id, activationKey: key, status: 'active', mode: 'manual', createdAt: at, startedAt: at, finishedAt: null, total: 1, waitFromAt: at, nextEligibleAt: at + this._interval(campaign), reason: 'Reenvio manual aprovado.' };
      const job = { ...previous, id: randomUUID(), runId: run.id, status: 'pending', attempts: 0, clientMessageId: `AC${randomUUID().replaceAll('-', '').toUpperCase()}`, messageId: null, createdAt: at, startedAt: null, submittedAt: null, resultAt: null, acceptedAt: null, deliveredAt: null, nextAttemptAt: at, errorCode: null, error: null, allowRepeat: true, reviewedJobId, manualRetryOf: previous.id, manualRetryKey: key };
      if (!this.store.claimRecipient(contact, job.id, { allowRepeat: true, reviewedJobId, at })) throw new ValidationError('Não foi possível reservar o destinatário para revisão.', 'RECIPIENT_ALREADY_RESERVED');
      this.store.save('runs', run); this.store.save('jobs', job); this.store.save('campaigns', { ...campaign, status: 'active', lastRunId: run.id, updatedAt: at }); this.store.audit?.({ id: randomUUID(), event: 'manual_retry', at, jobId: job.id, previousJobId: previous.id, possibleDuplicate: previous.status === 'uncertain' }); result = job;
    }); this._emitChange(); return result;
  }
  async reconcileJob(jobId) {
    const job = this.store.get('jobs', jobId); if (!job) throw new ValidationError('Envio não encontrado.', 'JOB_NOT_FOUND');
    if (job.status === 'delivered') return job;
    if (!this._connected()) throw new ValidationError('Conecte o WhatsApp para verificar o resultado.', 'NOT_CONNECTED');
    const result = await this.adapter.reconcile(job.messageId || job.clientMessageId);
    this._lateProof(job.id, result); return this.store.get('jobs', job.id);
  }
  getState() {
    const state = this._state(), at = this.now(), pending = this._all('jobs', { status: 'pending' }); let nextAt = null; const dailyCounts = new Map();
    for (const job of pending) {
      const run = this.store.get('runs', job.runId), campaign = this.store.get('campaigns', job.campaignId);
      if (!run || !campaign || !ACTIVE_RUN.has(run.status) || !['active','scheduled'].includes(campaign.status)) continue;
      let due = Math.max(at, this._due(job, run, campaign, state));
      if (!dailyCounts.has(campaign.id)) dailyCounts.set(campaign.id, this._dailyCount(campaign.id, at));
      if (dailyCounts.get(campaign.id) >= campaign.dailyLimit) { const tomorrow = new Date(at); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(0,0,0,0); due = Math.max(due, tomorrow.getTime()); }
      due = nextAllowedAt(campaign, due); if (nextAt === null || due < nextAt) nextAt = due;
    }
    const counts = {};
    if (this.store.getMetrics) { const metrics = this.store.getMetrics(); for (const status of ['pending','processing','accepted','delivered','uncertain','failed','cancelled']) counts[status] = metrics[status] || 0; }
    else for (const job of this._all('jobs')) counts[job.status] = (counts[job.status] || 0) + 1;
    return { ...state, busy: this._busy, connected: this._connected(), inFlight: this._inFlight ? { jobId: this._inFlight.job.id, campaignId: this._inFlight.job.campaignId } : null, counts, nextAt: state.automationStopped || state.suspended || !this._connected() ? null : nextAt, countdownMs: state.automationStopped || state.suspended || !this._connected() || nextAt === null ? null : Math.max(0, nextAt - at), now: at };
  }
}
function safeError(error) {
  const text = String(error?.message || 'Falha não identificada.');
  return text.replace(/(?:bearer\s+)[A-Za-z0-9._-]+/gi, 'Bearer [oculto]').replace(/(token|password|senha|secret|authorization|credential|chave)\s*[:=]\s*[^\s,;]+/gi, '$1=[oculto]').slice(0, 600);
}
module.exports = { InviteQueue, QueueGuardError };
