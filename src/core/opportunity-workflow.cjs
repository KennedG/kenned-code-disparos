'use strict';

// Fixed rules only. Request/campaign text is data, never executable instructions.
// This workflow sends a selected campaign announcement to its explicit group
// destinations. It deliberately does not reuse the legacy private-requester queue.
const { EventEmitter } = require('node:events');
const { createHash, randomUUID } = require('node:crypto');
const { normalizePhone } = require('./phone.cjs');
const { parseQuery } = require('./search-parser.cjs');
const { parseCampaignOffer, stableOfferIdentity } = require('./opportunity-matcher.cjs');
const { assessCampaignItem, campaignItemFingerprint } = require('./opportunity-campaign.cjs');

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rows = value => Array.isArray(value) ? value : value?.items || [];
const failure = (message, code, extra = {}) => Object.assign(new Error(message), { code, definitive: true, submitted: false, ...extra });
const CLOSED = new Set(['closed', 'expired', 'cancelled', 'answered_outside']);
const FINAL = new Set(['accepted', 'delivered', 'uncertain', 'failed', 'cancelled']);
const clone = value => structuredClone(value);
const safeTechnical = value => String(value || '').slice(0, 16000).replace(/(Bearer\s+)[\w.\-]+/gi, '$1[omitido]')
  .replace(/((?:password|senha|token|secret|authorization|api[_-]?key|private[_-]?key|credential)\s*[:=]\s*)[^\s,;]+/gi, '$1[omitido]').slice(0, 500);

function announcementText(item) { return item?.type === 'text' ? String(item.text || '') : String(item?.caption || ''); }
function compatibleAnnouncement(request, item, campaign, media, aliases) {
  const text = announcementText(item), parsed = parseCampaignOffer(item, campaign, media, { aliases });
  // Multiple product options in one announcement require an explicit operator
  // selection. Never infer which price/condition belongs to another product.
  let offer = parsed.length === 1 ? parsed[0] : null;
  if (parsed.length > 1) return { eligible: false, code: 'OP_SELECTION_REQUIRED', reason: 'O anúncio possui várias opções; selecione o item manualmente.' };
  if (!offer) {
    let query;
    try { query = parseQuery(text.slice(0, 2048), { aliases }); } catch { return { eligible: false, code: 'OP_MODEL_UNKNOWN', reason: 'Modelo não identificado no anúncio.' }; }
    // Unknown advertising words and signatures are allowed. Ambiguous model,
    // capacity, colour or condition are not silently discarded.
    if (!query.modelKey || query.errors.some(value => !value.startsWith('Filtros não reconhecidos:'))) return { eligible: false, code: 'OP_SELECTION_REQUIRED', reason: 'O anúncio precisa de seleção manual.' };
    offer = { ...query, priceCents: null, batteryPercent: query.batteryPercent };
  }
  for (const spec of request?.models || []) {
    if (!spec.modelKey || spec.complete === false || spec.reviewReasons?.length || spec.modelKey !== offer.modelKey) continue;
    if (['storageGB', 'colorKey', 'condition'].some(field => spec[field] != null && spec[field] !== offer[field])) continue;
    const battery = spec.minBattery ?? spec.batteryMin;
    if (battery != null && (!Number.isInteger(offer.batteryPercent) || offer.batteryPercent < battery)) continue;
    const budget = spec.maxPriceCents ?? spec.priceMaxCents;
    if (budget != null && (offer.confidence !== 'confirmed' || offer.priceKind !== 'cash' || !Number.isInteger(offer.priceCents) || offer.priceCents > budget)) continue;
    // We do not consult inventory. An explicit multi-unit request still cannot
    // be answered using a quantity invented from one campaign photograph.
    const quantity = item.availability?.quantity ?? item.quantityAvailable;
    if (spec.quantity > 1 && (!Number.isInteger(quantity) || quantity < spec.quantity)) continue;
    return { eligible: true, model: offer.model, storageGB: offer.storageGB, priceCents: offer.priceCents ?? null, offer };
  }
  return { eligible: false, code: 'OP_NO_EXACT_CAMPAIGN_ITEM', reason: 'Nenhum anúncio corresponde ao modelo e aos filtros do pedido.' };
}

class OpportunityWorkflow extends EventEmitter {
  constructor({ store, adapter, scheduler, opportunities, now = () => Date.now(), assertCanOperate = () => true,
    assertAdministrator = () => true, isAutomationStopped = () => false, automation, automationControl, onChange = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    super();
    if (!store?.reserveOpportunityWorkflow) throw new Error('Persistência do fluxo de oportunidades obrigatória.');
    Object.assign(this, { store, adapter, scheduler, opportunities, now, assertCanOperate, assertAdministrator, isAutomationStopped, automation: automation || automationControl, onChange, sleep });
    this.started = false; this.closed = false; this.controllers = new Set(); this.lastSubmissionAt = null; this.pump = null;
    this.connectionListener = () => { this.wake(); this._changed(); };
    this.receiptListener = proof => this._receipt(proof);
  }
  _mode() { return this.store.getStorageMode?.() || this.store.getSetting('integrationMode', 'whatsapp'); }
  config() { return this.store.getOpportunityConfig(); }
  initializeDefaults() {
    this.store.ensureOpportunityWorkflowIndexes?.();
    const old = this.config();
    if (old.campaignDestinations === true && old.workflowVersion >= 1) return old;
    const next = { ...old, workflowVersion: 1, campaignDestinations: true, mode: 'automatic', automatic: true, evaluation: false, availabilityMode: 'campaign', updatedAt: this.now() };
    // Migration changes the routing policy, never replays a legacy private
    // response as a group broadcast. Existing sent/uncertain history survives.
    this.store.cancelOpportunityTasks?.({ automaticOnly: false, now: this.now(), reason: 'Fluxo atualizado: selecione o anúncio para os destinos da campanha.' });
    this.store.setOpportunityConfig(next); return next;
  }
  _assert(actorId, action = 'respond') {
    if (this.assertCanOperate(actorId, action) === false) throw failure('Sem permissão para Oportunidades.', 'OPPORTUNITY_FORBIDDEN');
  }
  _changed() { this.emit('change'); this.onChange(); }
  _trace(id, stage, code, description, detail = {}) {
    const row = { id: randomUUID(), traceId: id || randomUUID(), opportunityId: detail.opportunityId || null, taskId: detail.taskId || null,
      at: this.now(), operationType: 'opportunity', stage: `opportunities.workflow.${stage}`, code, description: safeTechnical(description),
      detail: Object.fromEntries(Object.entries(detail).filter(([key]) => ['opportunityId', 'taskId', 'campaignId', 'itemId', 'recipient', 'messageId', 'status', 'attempts'].includes(key))) };
    this.store.addOpportunityTrace?.(row); this.store.addDiagnostic?.(row); return row;
  }
  _block(id, code, reason) { reason = safeTechnical(reason); const op = this.store.getOpportunity(id); if (op) this.store.updateOpportunity(id, { lastBlocker: { code, reason, at: this.now() }, updatedAt: this.now() }); this._trace(id, 'blocked', code, reason, { opportunityId: id }); this._changed(); return { ok: false, code, reason }; }
  _validateOpportunity(id, { automatic = false } = {}) {
    const op = this.store.getOpportunity(id);
    if (!op) throw failure('Oportunidade não encontrada.', 'OPPORTUNITY_NOT_FOUND');
    if (CLOSED.has(op.status) || op.outsideAnsweredAt) throw failure('Oportunidade encerrada ou já respondida por fora.', 'OP_CLOSED');
    if (op.expiresAt <= this.now()) throw failure('Pedido expirado; nenhum envio automático será iniciado.', 'OP_EXPIRED');
    if (this.store.getOpportunityContactMute?.(op.senderKey)?.muted) throw failure('Contato silenciado.', 'OP_MUTED');
    if (automatic && op.needsReview) throw failure('Pedido alterado ou incompleto; escolha o anúncio manualmente.', 'OP_REVIEW');
    if (this.closed || this.store.persistenceFailed || this.isAutomationStopped()) throw failure('Envios pausados. Retome explicitamente o sistema.', 'OP_STOPPED');
    return op;
  }
  _administrator() {
    const config = this.config(), phone = normalizePhone(config.adminPhone);
    if (!phone || !config.adminActorId) throw failure('Configure o número completo do administrador autorizado nas Oportunidades.', 'OP_ADMIN_NOT_CONFIGURED');
    if (this.assertAdministrator(phone, config.adminActorId) === false) throw failure('O administrador configurado não está mais autorizado. Revise suas permissões.', 'OP_ADMIN_UNAUTHORIZED');
    return { phone, actorId: config.adminActorId };
  }
  _selection(campaignId, itemId, { onlyRecipient } = {}) {
    const cfg = this.config();
    if (!cfg.campaignIds.includes(campaignId)) throw failure('A campanha não está selecionada nas Oportunidades.', 'OPPORTUNITY_CAMPAIGN_INVALID');
    const campaign = this.store.getCampaign(campaignId), item = campaign?.items?.find(value => value.id === itemId);
    if (!campaign || !item) throw failure('O anúncio foi removido ou a campanha foi excluída.', 'OPPORTUNITY_OFFER_CHANGED');
    const source = item.sourcePublicationId ? this.store.getSourcePublication?.(item.sourcePublicationId) : undefined;
    const media = item.mediaId ? this.store.getMedia?.(item.mediaId) : undefined;
    const assessment = assessCampaignItem(item, campaign, { source, media, availabilityMode: 'campaign', manualSelection: true });
    if (!assessment.eligible) throw failure(assessment.blocker.reason, assessment.blocker.code);
    const text = announcementText(item);
    if (text.length > 16000 || item.type === 'text' && !text.trim()) throw failure('O anúncio deve ter texto de até 16.000 caracteres.', 'OPPORTUNITY_TEXT_INVALID');
    const fingerprint = campaignItemFingerprint(item, campaign, { source, media }), groups = [...new Set(campaign.groupIds || [])];
    if (!groups.length) throw failure('A campanha selecionada não possui grupos de destino. Configure os destinos na campanha.', 'OP_CAMPAIGN_NO_DESTINATIONS');
    const simulated = this._mode() === 'simulated';
    const recipients = groups.map(id => {
      const group = this.store.getGroup(id);
      if ((!onlyRecipient || onlyRecipient === id) && (!group || group.authorized !== true || Boolean(group.simulation) !== simulated || !(simulated ? /@simulation$/.test(id) : /@g\.us$/.test(id)))) throw failure('Há um destino da campanha inválido ou sem autorização. Revise os grupos da campanha.', 'OP_CAMPAIGN_DESTINATION_INVALID');
      return { id, type: 'group', name: group?.name || id };
    });
    const identity = stableOfferIdentity(item, campaign, media || {});
    return { campaign, item, media, fingerprint, recipients, offerIdentity: identity.offerKey, text };
  }
  _choose(op) {
    const cfg = this.config(), candidates = [];
    for (const campaign of this.store.listCampaigns({ ids: cfg.campaignIds })) {
      if (!cfg.campaignIds.includes(campaign.id)) continue;
      for (const item of campaign.items || []) {
        try {
          const selection = this._selection(campaign.id, item.id), matched = compatibleAnnouncement(op.request, item, campaign, selection.media, cfg.aliases);
          if (matched.eligible) candidates.push({ ...selection, ...matched });
        } catch (e) { this.lastCandidateError = { code: e.code, reason: e.message }; }
      }
    }
    candidates.sort((a, b) => cfg.priority === 'campaign' ? cfg.campaignIds.indexOf(a.campaign.id) - cfg.campaignIds.indexOf(b.campaign.id)
      : cfg.priority === 'recent' ? (b.item.originalAt || b.campaign.updatedAt || 0) - (a.item.originalAt || a.campaign.updatedAt || 0)
      : (a.priceCents ?? Infinity) - (b.priceCents ?? Infinity));
    return candidates[0] || null;
  }
  consider(id) {
    const existing = this.store.getOpportunityWorkflow(id); if (existing) return { ok: true, duplicate: true, batch: existing };
    const cfg = this.config(); if (!cfg.enabled) return { ignored: true };
    if (cfg.mode === 'evaluation' || cfg.evaluation === true) return { ok: true, evaluationOnly: true, reason: 'Modo de avaliação: nenhum envio ou aviso privado foi criado.' };
    try {
      const op = this._validateOpportunity(id, { automatic: true }); this._assert(cfg.ownerId || cfg.adminActorId, 'respond'); this._administrator();
      const selected = this._choose(op);
      if (!selected) return this._block(id, this.lastCandidateError?.code || 'OP_NO_EXACT_CAMPAIGN_ITEM', this.lastCandidateError?.reason || 'Nenhum anúncio exato nas campanhas selecionadas. Você pode escolher um item manualmente.');
      return this._reserve(op, selected, cfg.automatic === true && cfg.mode === 'automatic', cfg.ownerId || cfg.adminActorId);
    } catch (e) { return this._block(id, e.code || 'OPPORTUNITY_ERROR', e.message); }
  }
  dispatch(input, actorId) {
    this._assert(actorId, 'respond'); this._administrator();
    const id = input.opportunityId || input.id, op = this._validateOpportunity(id), selected = this._selection(input.campaignId, input.itemId);
    const existing = this.store.getOpportunityWorkflow(id);
    if (existing?.status === 'awaiting_approval' && existing.campaignId === selected.campaign.id && existing.itemId === selected.item.id && existing.selectionFingerprint === selected.fingerprint) return this.approve(id, actorId);
    if (existing && existing.status !== 'awaiting_approval' && (existing.campaignId !== selected.campaign.id || existing.itemId !== selected.item.id || existing.selectionFingerprint !== selected.fingerprint)) throw failure('Esta oportunidade já tem um envio reservado ou processado. Consulte seu resultado antes de escolher outro anúncio.', 'OP_SELECTION_ALREADY_RESERVED');
    return this._reserve(op, selected, true, actorId, { explicit: true });
  }
  _reserve(op, selected, automatic, actorId, { explicit = false } = {}) {
    const cfg = this.config(), result = this.store.reserveOpportunityWorkflow({ opportunityId: op.id, campaignId: selected.campaign.id, itemId: selected.item.id,
      itemSnapshot: { ...clone(selected.item), campaignName: selected.campaign.name }, recipients: selected.recipients, automatic,
      selectionFingerprint: selected.fingerprint, offerIdentity: selected.offerIdentity, actorId, now: this.now(), traceId: op.id, replaceUnstarted: explicit });
    if (!result.ok) return this._block(op.id, result.code || 'OP_SEND_BLOCKED', result.reason || 'O envio está bloqueado.');
    if (!result.duplicate) {
      if (explicit && result.batch) this.store.patchOpportunityWorkflowBatch(op.id, { explicitlyApproved: true, approvedAt: this.now(), approvedBy: actorId, now: this.now() });
      this._newNotice(op, result.batch || this.store.getOpportunityWorkflow(op.id));
      this.opportunities?._notify?.(op);
      this._trace(op.id, 'queued', automatic ? 'OP_CAMPAIGN_SEND_QUEUED' : 'OP_AWAITING_APPROVAL', automatic ? 'Anúncio reservado para os destinos da campanha.' : 'Administrador avisado; aguardando !aprovar ou !recusar.', { opportunityId: op.id, campaignId: selected.campaign.id, itemId: selected.item.id });
    }
    this._changed(); this.wake(); return result;
  }
  _enqueueNotice(opportunityId, key, body) {
    try { const admin = this._administrator(); return this.store.enqueueOpportunityAdminNotice({ opportunityId, key, recipient: admin.phone, body, now: this.now() }); }
    catch (e) { this._trace(opportunityId, 'notice', e.code || 'OP_ADMIN_NOTICE_ERROR', e.message, { opportunityId }); return { ok: false, code: e.code, reason: safeTechnical(e.message) }; }
  }
  _newNotice(op, batch) {
    const item = batch.itemSnapshot, cfg = this.config(), text = announcementText(item), name = op.senderName || op.senderPhone || 'Nome não informado';
    const heading = `🔔 *Nova oportunidade*\n🆔 ${op.id}\n👤 Cliente: ${name}\n📱 Celular: ${text.split('\n').find(line => line.trim()) || 'Anúncio selecionado'}\n📢 Campanha: ${item.campaignName || batch.campaignId}\n👥 Destinos da campanha: ${batch.recipients.length}\n⚙️ ${batch.status === 'awaiting_approval' ? 'Aguardando sua decisão' : 'Envio automático autorizado'}\n\n📝 *Mensagem da campanha*\n`;
    const footer = batch.status === 'awaiting_approval' ? `\n\n!aprovar ${op.id}\n!recusar ${op.id}` : '\n\nO resultado será informado neste particular.';
    // Preserve the complete campaign message. Split at message boundaries only
    // if the fixed envelope would push a valid 16k announcement over the limit.
    const key = `new:${batch.selectionRevision || 0}`;
    if ((heading + text + footer).length <= 16000) this._enqueueNotice(op.id, key, heading + text + footer);
    else { this._enqueueNotice(op.id, key, heading + footer); this._enqueueNotice(op.id, `${key}:content`, text); }
  }
  approve(id, actorId) {
    this._assert(actorId, 'respond'); this._administrator(); this._validateOpportunity(id);
    let batch = this.store.getOpportunityWorkflow(id);
    if (!batch) {
      const selected = this.consider(id);
      if (!selected.ok) return selected;
      batch = this.store.getOpportunityWorkflow(id);
      if (!batch) return selected;
    }
    this._validateBatch(batch);
    const result = this.store.approveOpportunityWorkflow(id, { actorId, now: this.now() }); this._changed(); this.wake(); return result;
  }
  reject(id, actorId) {
    this._assert(actorId, 'respond');
    if (!this.store.getOpportunity(id)) throw failure('Oportunidade não encontrada.', 'OPPORTUNITY_NOT_FOUND');
    const result = this.store.cancelOpportunityWorkflow({ opportunityId: id, reason: 'Oportunidade recusada pelo administrador.', now: this.now() });
    this.store.patchOpportunityWorkflowBatch?.(id, { status: 'cancelled', cancelledAt: this.now(), cancelledBy: actorId, now: this.now() });
    this.store.closeOpportunity?.(id, { actorId, now: this.now(), reason: 'Oportunidade recusada pelo administrador.' });
    this._trace(id, 'cancelled', 'OP_ADMIN_REJECTED', 'Oportunidade recusada; tarefas não iniciadas canceladas.', { opportunityId: id }); this._changed(); return result;
  }
  async setAutomatic(value, actorId) {
    if (typeof value !== 'boolean') throw failure('Use !automatico on ou !automatico off.', 'OP_AUTOMATIC_VALUE');
    this._assert(actorId, 'manage');
    if (value && this.isAutomationStopped()) await this.automation?.resume?.({ actorId, source: 'opportunity-control' });
    this.store.setOpportunityConfig({ ...this.config(), mode: value ? 'automatic' : 'manual', automatic: value, evaluation: false, campaignDestinations: true, workflowVersion: 1, availabilityMode: 'campaign', updatedAt: this.now() });
    this.configurationChanged();
    this.opportunities?.resumeCapture?.(); this._changed(); this.wake(); return this.status();
  }
  configurationChanged() {
    const config = this.config();
    if (!config.automatic || config.mode !== 'automatic') {
      for (const job of rows(this.store.listOpportunityWorkflowJobs({ status: 'queued', type: 'campaign-ad', limit: 1000 }))) {
        const batch = this.store.getOpportunityWorkflow(job.opportunityId);
        if (batch?.explicitlyApproved || batch?.approvedAt) continue;
        this.store.updateOpportunityWorkflowJob(job.id, { status: 'awaiting_approval', reason: 'Modo automático desativado; aguardando aprovação.', now: this.now() });
        this.store.patchOpportunityWorkflowBatch(job.opportunityId, { status: 'awaiting_approval', automatic: false, now: this.now() });
      }
    }
    this._changed(); this.wake();
  }
  async pause(actorId) {
    this._assert(actorId, 'manage');
    const global = await this.automation?.stop?.({ actorId, source: 'opportunity-private-command', reason: 'Parada solicitada por !pausar.' });
    const result = this.cancelPending('Parada solicitada pelo administrador.');
    this._changed(); return { ...result, automation: global || null, inProgress: result.inProgress || 0, inFlight: global?.inFlight || result.inProgress || 0 };
  }
  cancelPending(reason = 'Envios interrompidos.') {
    const result = this.store.cancelOpportunityWorkflow({ all: true, reason, now: this.now() });
    for (const controller of this.controllers) controller.abort(); this._changed(); return result;
  }
  cancel(id, reason = 'Oportunidade interrompida.') { const result = this.store.cancelOpportunityWorkflow({ opportunityId: id, reason, now: this.now() }); this._changed(); return result; }
  invalidateCampaign(campaignId) {
    let cancelled = 0, inProgress = 0;
    for (const batch of rows(this.store.listOpportunityWorkflows({ limit: 1000 }))) if (batch.campaignId === campaignId) {
      const result = this.cancel(batch.id, 'Campanha excluída; envios pendentes cancelados.'); cancelled += result.cancelled; inProgress += result.inProgress;
    }
    return { cancelled, inProgress };
  }
  _validateBatch(batch, job) {
    const op = this._validateOpportunity(batch.opportunityId || batch.id, { automatic: false });
    const cfg = this.config(); this._assert(batch.actorId || cfg.ownerId || cfg.adminActorId, 'respond'); this._administrator();
    if (batch.intentKey !== op.intentKey || job?.automatic && !batch.explicitlyApproved && !batch.approvedAt && op.needsReview) throw failure('O pedido mudou após a seleção. Escolha novamente o anúncio.', 'OP_REQUEST_CHANGED');
    const selected = this._selection(batch.campaignId, batch.itemId, { onlyRecipient: job?.recipient });
    if (selected.fingerprint !== batch.selectionFingerprint) throw failure('O anúncio mudou após a seleção. Revise a oportunidade.', 'OPPORTUNITY_OFFER_CHANGED');
    if (job && !selected.recipients.some(value => value.id === job.recipient)) throw failure('O destino foi retirado da campanha.', 'OP_CAMPAIGN_DESTINATION_REMOVED');
    if (job && job.automatic && cfg.mode !== 'automatic' && !batch.explicitlyApproved && !batch.approvedAt) throw failure('Modo automático desativado; aguardando sua decisão.', 'OP_AUTOMATIC_DISABLED');
    return { op, selected };
  }
  _guard(job, adapter, mode, beforeSubmit = () => {}) {
    beforeSubmit();
    if (adapter !== this.adapter || mode !== this._mode() || adapter?.status?.state !== 'connected' || this.closed || this.store.persistenceFailed || this.isAutomationStopped()) throw failure('Envio pausado por conexão ou controles do sistema.', 'OP_STOPPED');
    const current = this.store.getOpportunityWorkflowJob(job.id);
    if (!current || !['queued', 'processing'].includes(current.status)) throw failure('Tarefa cancelada ou já processada.', 'OP_JOB_CANCELLED');
    if (job.type === 'campaign-ad') {
      const batch = this.store.getOpportunityWorkflow(job.opportunityId); if (!batch) throw failure('Reserva não encontrada.', 'OP_BATCH_MISSING');
      return this._validateBatch(batch, current);
    }
    const admin = this._administrator(); this._assert(admin.actorId, 'view');
    if (normalizePhone(job.recipient) !== admin.phone) throw failure('O administrador configurado mudou; aviso preservado para revisão.', 'OP_ADMIN_CHANGED');
    return null;
  }
  start() {
    if (this.started || this.closed) return;
    this.initializeDefaults(); this.started = true; this.store.recoverOpportunityWorkflowJobs(this.now());
    this.adapter?.on('status', this.connectionListener); this.adapter?.on('receipt', this.receiptListener);
    this.timer = setInterval(() => this.wake(), 15000); this.timer.unref?.(); this.wake();
  }
  async stop() {
    if (this.closed) return; this.closed = true; clearInterval(this.timer); clearTimeout(this.dueTimer);
    this.adapter?.off('status', this.connectionListener); this.adapter?.off('receipt', this.receiptListener);
    for (const controller of this.controllers) controller.abort(); await this.pump?.catch(() => {});
  }
  shutdown() { return this.stop(); }
  setAdapter(adapter) {
    this.adapter?.off('status', this.connectionListener); this.adapter?.off('receipt', this.receiptListener);
    for (const controller of this.controllers) controller.abort(); this.adapter = adapter;
    if (this.started) { adapter?.on('status', this.connectionListener); adapter?.on('receipt', this.receiptListener); }
    this.wake();
  }
  wake() {
    if (this.pump) { this.pumpAgain = true; return this.pump; }
    if (!this.started || this.closed || this.store.persistenceFailed || this.isAutomationStopped() || this.adapter?.status?.state !== 'connected') return;
    clearTimeout(this.dueTimer);
    this.pump = Promise.resolve().then(() => this._drain()).catch(e => this._trace(null, 'failure', e.code || 'OP_WORKFLOW_ERROR', e.message)).finally(() => {
      this.pump = null; const again = this.pumpAgain; this.pumpAgain = false;
      if (again) queueMicrotask(() => this.wake());
      else {
        const jobs = rows(this.store.listOpportunityWorkflowJobs({ status: 'queued', limit: 1000 }));
        if (jobs.length && !this.closed && !this.isAutomationStopped() && this.adapter?.status?.state === 'connected') {
          const at = Math.min(...jobs.map(job => job.nextAttemptAt || this.now()));
          this.dueTimer = setTimeout(() => this.wake(), Math.max(1, Math.min(2147483647, at - this.now()))); this.dueTimer.unref?.();
        }
      }
    }); return this.pump;
  }
  async waitForIdle() { await this.pump; if (this.started && !this.closed) { this.wake(); await this.pump; } }
  async _drain() {
    const jobs = rows(this.store.listOpportunityWorkflowJobs({ status: 'queued', dueAt: this.now(), limit: 100 }));
    for (const job of jobs) {
      if (this.closed || this.store.persistenceFailed || this.isAutomationStopped() || this.adapter?.status?.state !== 'connected') break;
      const next = this._lastSubmission() + this._spacing(job);
      if (next > this.now()) { this.store.updateOpportunityWorkflowJob(job.id, { nextAttemptAt: next, now: this.now() }); continue; }
      await this._send(job);
    }
  }
  _deadline() { return this.scheduler?.getAttemptTimeoutMs?.() || Math.max(5, Math.min(300, Number(this.store.getSetting('submissionTimeoutSeconds', 30)) || 30)) * 1000; }
  _lastSubmission() {
    const persisted = this.store.getSetting(`opportunityWorkflowLastSubmission:${this._mode()}`, 0);
    return Math.max(this.lastSubmissionAt || 0, this.scheduler?.lastSubmissionAt || 0, typeof persisted === 'number' && Number.isFinite(persisted) ? persisted : 0);
  }
  _spacing(job) {
    let seconds = Math.max(3, Number(this.adapter?.minimumSpacingSeconds) || 3);
    if (job.type === 'campaign-ad') {
      const campaign = this.store.getCampaign(job.campaignId || this.store.getOpportunityWorkflow(job.opportunityId)?.campaignId);
      const previous = this.store.getSetting(`opportunityWorkflowLastDestination:${this._mode()}`, null);
      const configured = previous === job.recipient ? campaign?.messageSpacingSeconds ?? campaign?.spacingSeconds : campaign?.groupSpacingSeconds ?? campaign?.spacingSeconds;
      if (Number.isFinite(configured) && configured > 0) seconds = Math.max(seconds, configured);
    }
    return seconds * 1000;
  }
  async _bounded(work, options) {
    if (this.scheduler?.runBoundedAttempt) return this.scheduler.runBoundedAttempt(work, { timeoutMs: this._deadline(), ...options });
    const controller = new AbortController(); this.controllers.add(controller); let timer, expired = false;
    const attempt = Promise.resolve().then(() => work({ signal: controller.signal, timeoutMs: this._deadline(), beforeSubmit: () => { if (controller.signal.aborted) throw failure('Tentativa encerrada.', 'SUBMISSION_ABORTED'); } }));
    attempt.then(proof => { if (expired) options?.onLateResult?.(proof); }, e => { if (expired) options?.onLateError?.(e); });
    try { return await Promise.race([attempt, new Promise((_, reject) => { timer = setTimeout(() => { expired = true; controller.abort(); reject(failure('Tempo limite; resultado incerto.', 'SUBMISSION_TIMEOUT', { definitive: false, submitted: 'unknown' })); }, this._deadline()); })]); }
    finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  async _send(initial) {
    const adapter = this.adapter, mode = this._mode(); let submitted = false, job = initial;
    const work = async outer => {
      this._guard(job, adapter, mode, outer.beforeSubmit);
      const spacing = this._spacing(job), last = this._lastSubmission();
      if (last && this.now() - last < spacing) await this.sleep(spacing - (this.now() - last));
      this._guard(job, adapter, mode, outer.beforeSubmit);
      const claim = this.store.claimOpportunityWorkflowJob(job.id, { now: this.now() });
      if (!claim.ok) throw failure(claim.reason || 'Tarefa já processada.', claim.code || 'OP_JOB_CLAIMED');
      job = claim.job;
      return this._bounded(async ctx => {
        const beforeSubmit = () => { this._guard(job, adapter, mode, () => { ctx.beforeSubmit(); outer.beforeSubmit?.(); });
          if (!submitted) { const marked = this.store.markOpportunityWorkflowSubmitted(job.id, { attemptId: job.attemptId, now: this.now() }); if (!marked) throw failure('Reserva encerrada antes do envio.', 'OP_JOB_CANCELLED'); submitted = true; this.lastSubmissionAt = this.now(); this.store.setSetting(`opportunityWorkflowLastSubmission:${mode}`, this.now()); this.store.setSetting(`opportunityWorkflowLastDestination:${mode}`, job.recipient); if (this.scheduler) this.scheduler.lastSubmissionAt = this.now(); }
        };
        const options = { clientMessageId: job.clientMessageId, traceId: job.id, signal: ctx.signal, timeoutMs: ctx.timeoutMs, beforeSubmit };
        if (job.type === 'campaign-ad') {
          const batch = this.store.getOpportunityWorkflow(job.opportunityId), current = this._validateBatch(batch, job), media = current.selected.media;
          // The adapter performs group permission checks and calls beforeSubmit
          // immediately before the transport. The immutable original caption is
          // used, including emojis, defects, signature and quoted price.
          return adapter.send(job.recipient, { ...clone(job.itemSnapshot || batch.itemSnapshot), clientMessageId: job.clientMessageId }, media, options);
        }
        const resolved = await adapter.resolveRecipient(job.recipient, options);
        this._guard(job, adapter, mode, () => { ctx.beforeSubmit(); outer.beforeSubmit?.(); });
        if (!resolved?.jid || /@g\.us$/.test(resolved.jid) || !normalizePhone(job.recipient) || resolved.phone && normalizePhone(resolved.phone) !== normalizePhone(job.recipient)) throw failure('O número privado do administrador não pôde ser resolvido com segurança.', 'OP_ADMIN_RESOLUTION_FAILED');
        this.store.updateOpportunityWorkflowJob(job.id, { resolvedRecipient: resolved.jid, now: this.now() });
        return adapter.sendSearchText(resolved.jid, job.body, options);
      }, { signal: outer.signal, onLateResult: proof => this._proof(job.id, proof, adapter, mode), onLateError: e => this._lateFailure(job.id, e, adapter, mode) });
    };
    try {
      const proof = this.scheduler?.runExternalSubmission ? await this.scheduler.runExternalSubmission(work, { manual: false, timeoutMs: 2 * this._deadline() + 15000 + this._spacing(job) }) : await work({ beforeSubmit: () => {} });
      if (proof?.status === 'failed' && proof.confirmedFailure) throw failure(proof.reason || 'Envio recusado pela integração.', proof.code || 'OP_SEND_REJECTED', { safeToRetry: proof.safeToRetry === true, confirmedFailure: true });
      if (!this._proof(job.id, proof, adapter, mode)) this.store.updateOpportunityWorkflowJob(job.id, { status: 'uncertain', resultAt: this.now(), code: 'OP_RESULT_UNCERTAIN', reason: 'Resultado incerto. Não haverá reenvio automático.', safeToRetry: false, attemptId: job.attemptId, now: this.now() });
    } catch (e) {
      const current = this.store.getOpportunityWorkflowJob(job.id);
      if (!current || ['accepted', 'delivered', 'cancelled'].includes(current.status)) return;
      const known = !submitted || e.confirmedFailure === true || e.definitive === true && e.submitted === false;
      const cfg = this.config(), attempts = current.attempts || 1;
      const retry = known && e.safeToRetry === true && e.submitted === false && attempts <= (cfg.retryMax ?? 2) && !this.closed && !this.isAutomationStopped();
      this.store.updateOpportunityWorkflowJob(job.id, { status: known ? 'failed' : 'uncertain', code: e.code || 'OP_SEND_ERROR', reason: known ? safeTechnical(e.message) : 'Envio com resultado incerto; revisão necessária.', resultAt: this.now(),
        attempts, safeToRetry: retry, confirmedFailure: known, nextAttemptAt: null, attemptId: job.attemptId, now: this.now() });
      if (retry) this.store.updateOpportunityWorkflowJob(job.id, { status: 'queued', confirmedFailure: true, recoverable: true, nextAttemptAt: this.now() + (cfg.retryIntervalSeconds || 30) * 1000 * 2 ** (attempts - 1), now: this.now(), attemptId: job.attemptId });
      this._trace(job.id, 'result', e.code || 'OP_SEND_ERROR', known ? e.message : 'Resultado incerto; nenhuma repetição automática.', { taskId: job.id, opportunityId: job.opportunityId, recipient: job.recipient, status: retry ? 'queued' : known ? 'failed' : 'uncertain' });
    } finally { if (job.type === 'campaign-ad') this._summarize(job.opportunityId); this._changed(); }
  }
  _lateFailure(id, e, adapter, mode) {
    if (adapter !== this.adapter || mode !== this._mode() || this.closed || !e?.confirmedFailure) return;
    const job = this.store.getOpportunityWorkflowJob(id);
    if (!job || ['accepted', 'delivered'].includes(job.status)) return;
    this.store.updateOpportunityWorkflowJob(id, { status: 'failed', reason: safeTechnical(e.message), code: e.code || 'OP_CONFIRMED_FAILURE', resultAt: this.now(), safeToRetry: false, confirmedFailure: true, now: this.now(), attemptId: job.attemptId }); this._changed();
  }
  _proof(id, proof, adapter = this.adapter, mode = this._mode()) {
    if (this.closed || adapter !== this.adapter || mode !== this._mode() || !proof || proof.mode && proof.mode !== mode || proof.simulation === true && mode !== 'simulated') return false;
    const job = this.store.getOpportunityWorkflowJob(id);
    if (!job || !['accepted', 'confirmed', 'delivered', 'read'].includes(proof.status) || !proof.messageId) return false;
    if (job.messageId && job.messageId !== proof.messageId && job.clientMessageId !== proof.messageId) return false;
    const delivered = ['delivered', 'read'].includes(proof.status) || proof.deliveredAt || proof.delivered === true || ['whatsapp-delivered', 'whatsapp-read'].includes(proof.confirmationScope);
    if (job.status === 'delivered' || job.status === 'accepted' && !delivered) return true;
    this.store.updateOpportunityWorkflowJob(id, { status: delivered ? 'delivered' : 'accepted', messageId: proof.messageId, acceptedAt: job.acceptedAt || proof.acceptedAt || this.now(), deliveredAt: job.deliveredAt || proof.deliveredAt || (delivered ? this.now() : null), resultAt: job.resultAt || this.now(),
      confirmationScope: proof.confirmationScope || (delivered ? 'whatsapp-delivered' : 'integration-ack'), code: null, reason: null, safeToRetry: false, proof: true, attemptId: job.attemptId, now: this.now() });
    this._trace(id, 'result', delivered ? 'OP_DELIVERED' : 'OP_ACCEPTED', delivered ? 'Entrega confirmada pela integração.' : 'Envio aceito pela integração; entrega não presumida.', { taskId: id, opportunityId: job.opportunityId, recipient: job.recipient, messageId: proof.messageId, status: delivered ? 'delivered' : 'accepted' });
    if (job.type === 'campaign-ad') this._summarize(job.opportunityId); this._changed(); return true;
  }
  _receipt(proof) {
    if (!proof?.messageId) return;
    for (const job of rows(this.store.listOpportunityWorkflowJobs({ messageId: proof.messageId, limit: 100 }))) this._proof(job.id, proof);
  }
  _summarize(opportunityId) {
    const batch = this.store.getOpportunityWorkflow(opportunityId); if (!batch) return;
    const jobs = rows(this.store.listOpportunityWorkflowJobs({ opportunityId, type: 'campaign-ad', batchRevision: batch.selectionRevision || 0, limit: 1000 })).filter(job => (job.batchRevision || 0) === (batch.selectionRevision || 0));
    if (!jobs.length || jobs.some(job => !FINAL.has(job.status))) return;
    const counts = Object.fromEntries(['accepted', 'delivered', 'uncertain', 'failed', 'cancelled'].map(status => [status, jobs.filter(job => job.status === status).length]));
    const status = counts.uncertain ? 'uncertain' : counts.failed ? 'failed' : counts.cancelled && !counts.accepted && !counts.delivered ? 'cancelled' : counts.delivered === jobs.length ? 'delivered' : 'accepted';
    this.store.patchOpportunityWorkflowBatch(opportunityId, { status, resultAt: this.now(), counts, now: this.now() });
    const op = this.store.getOpportunity(opportunityId);
    if (op && !CLOSED.has(op.status)) this.store.updateOpportunity(opportunityId, { status: counts.uncertain ? 'uncertain' : counts.accepted || counts.delivered ? 'responded' : op.status, lastResponseAt: counts.accepted || counts.delivered || counts.uncertain ? this.now() : op.lastResponseAt, updatedAt: this.now() });
    const details = jobs.filter(job => job.status === 'failed' || job.status === 'uncertain').map(job => `• ${job.recipient}: ${safeTechnical(job.reason || job.code || job.status)}`).join('\n');
    this._enqueueNotice(opportunityId, 'result', `📨 *Resultado da oportunidade*\n🆔 ${opportunityId}\n👤 Cliente: ${op?.senderName || op?.senderPhone || 'Nome não informado'}\n📢 Campanha: ${batch.itemSnapshot?.campaignName || batch.campaignId}\n\n✅ Aceitos pela integração: ${counts.accepted + counts.delivered}\n📬 Entrega confirmada: ${counts.delivered}\n❔ Incertos: ${counts.uncertain}\n⚠️ Falhas: ${counts.failed}\n⛔ Cancelados: ${counts.cancelled}\n${details ? `\n${details}\n` : ''}\nAceitação não significa entrega. Incertos ficam para revisão e não serão repetidos automaticamente.`);
  }
  async reconcile(input, actorId) {
    this._assert(actorId, 'respond'); const id = input.taskId || input.id || input, job = this.store.getOpportunityWorkflowJob(id);
    if (!job) throw failure('Envio não encontrado.', 'OP_JOB_NOT_FOUND');
    if (job.status !== 'uncertain') return job;
    if (this.adapter?.status?.state !== 'connected') throw failure('Reconecte o WhatsApp para verificar.', 'DISCONNECTED');
    const adapter = this.adapter, mode = this._mode();
    const proof = adapter.reconcile ? await this._bounded(ctx => adapter.reconcile(job.messageId || job.clientMessageId, { ...ctx, chatId: job.resolvedRecipient || job.recipient, traceId: job.id })) : null;
    this._proof(job.id, proof, adapter, mode); return this.store.getOpportunityWorkflowJob(id);
  }
  detail(id) { const batch = this.store.getOpportunityWorkflow(id); return batch ? { ...batch, selection: { campaignId: batch.campaignId, itemId: batch.itemId }, jobs: rows(this.store.listOpportunityWorkflowJobs({ opportunityId: id, limit: 1000 })) } : { jobs: [] }; }
  status() {
    const cfg = this.config(), jobs = rows(this.store.listOpportunityWorkflowJobs({ limit: 100, newest: true }));
    const metrics = this.store.getOpportunityWorkflowMetrics?.(), counts = metrics?.jobs || Object.fromEntries(['awaiting_approval', 'queued', 'processing', 'accepted', 'delivered', 'uncertain', 'failed', 'cancelled'].map(status => [status, jobs.filter(job => job.status === status).length]));
    const ads = metrics?.byType?.['campaign-ad'] || {}, notices = metrics?.byType?.['admin-notice'] || {};
    return { automatic: cfg.mode === 'automatic' && cfg.automatic === true, mode: cfg.mode, enabled: cfg.enabled, campaignDestinations: true, adminPhone: normalizePhone(cfg.adminPhone), adminConfigured: Boolean(normalizePhone(cfg.adminPhone) && cfg.adminActorId), paused: this.isAutomationStopped(),
      pending: (counts.queued || 0) + (counts.awaiting_approval || 0) + (counts.processing || 0), awaitingApproval: ads.awaiting_approval || 0,
      accepted: (ads.accepted || 0) + (ads.delivered || 0), uncertain: counts.uncertain || 0, failed: counts.failed || 0,
      pendingAdminNotices: (notices.queued || 0) + (notices.processing || 0), counts,
      batches: rows(this.store.listOpportunityWorkflows({ limit: 50 })), updatedAt: metrics?.lastUpdatedAt || this.now(), lastError: rows(this.store.listOpportunityWorkflowJobs({ status: ['failed', 'uncertain'], newest: true, limit: 1 }))[0]?.reason || null,
      jobs, busy: Boolean(this.pump), connection: this.adapter?.status?.state || 'disconnected' };
  }
}

module.exports = { OpportunityWorkflow, compatibleAnnouncement, announcementText };
