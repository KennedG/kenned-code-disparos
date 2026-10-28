'use strict';

const { EventEmitter } = require('node:events');
const { randomUUID, createHash, timingSafeEqual } = require('node:crypto');
const { normalizePhone } = require('./phone.cjs');
const { parseRequest, parseCampaignOffer, matchOffer, stableOfferIdentity, materialFingerprint } = require('./opportunity-matcher.cjs');
const { assessCampaignItem, campaignItemFingerprint } = require('./opportunity-campaign.cjs');

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const list = value => Array.isArray(value) ? value : value?.items || [];
const error = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const canonical = value => typeof value === 'string' ? value.replace(/:\d+(?=@)/, '') : null;
const isClosed = value => ['closed', 'expired', 'answered_outside', 'cancelled'].includes(value);
const accepted = proof => ['accepted', 'confirmed', 'delivered', 'read'].includes(proof?.status) && Boolean(proof?.messageId);
const localDay = (at, timezone) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
const MONEY = cents => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function normalizeOpportunityConfig(input = {}, old = {}, now = Date.now(), actorId = null) {
  const out = { enabled: false, monitoredGroupIds: [], campaignIds: [], mode: 'evaluation', automatic: false, evaluation: true,
    repeatHours: 24, contactIntervalMinutes: 30, maxPerDay: 3, validityMinutes: 120, availabilityMaxAgeMinutes: 120, availabilityMode: 'campaign',
    automaticOfferLimit: 1, autoMaxOffers: 1, multiModelMax: 5, requestMaxModels: 5, priority: 'cashAscending', timezone: 'America/Sao_Paulo',
    retryMax: 2, retryIntervalSeconds: 30, sound: { enabled: true, volume: 70, durationSeconds: 2, minIntervalSeconds: 30, burstSeconds: 2,
      quiet: { enabled: false, start: '22:00', end: '08:00' } }, ...structuredClone(old), ...structuredClone(input) };
  out.allowOwnMessages = input.allowOwnMessages ?? old.allowOwnMessages ?? false; if (typeof out.allowOwnMessages !== 'boolean') throw error('Opção de mensagens próprias inválida.', 'OPPORTUNITY_CONFIG_INVALID');
  for (const key of ['enabled', 'automatic', 'evaluation']) if (typeof out[key] !== 'boolean') throw error('Opção inválida nas oportunidades.', 'OPPORTUNITY_CONFIG_INVALID');
  if (Object.hasOwn(input, 'mode')) { if (!['evaluation', 'manual', 'automatic'].includes(input.mode)) throw error('Modo de oportunidades inválido.', 'OPPORTUNITY_CONFIG_INVALID'); out.automatic = input.mode === 'automatic'; out.evaluation = input.mode === 'evaluation'; }
  else if (Object.hasOwn(input, 'automatic') || Object.hasOwn(input, 'evaluation')) out.mode = out.automatic && !out.evaluation ? 'automatic' : out.evaluation ? 'evaluation' : 'manual';
  out.automatic = out.mode === 'automatic'; out.evaluation = out.mode === 'evaluation'; if (out.priority === 'priceAsc') out.priority = 'cashAscending';
  if (!['campaign', 'confirmed'].includes(out.availabilityMode)) throw error('Origem da disponibilidade inválida.', 'OPPORTUNITY_CONFIG_INVALID');
  for (const key of ['monitoredGroupIds', 'campaignIds']) { if (!Array.isArray(out[key]) || out[key].length > 1000 || out[key].some(v => typeof v !== 'string' || !v || v.length > 512)) throw error('Selecione identificadores válidos.', 'OPPORTUNITY_CONFIG_INVALID'); out[key] = [...new Set(out[key])]; }
  if (Object.hasOwn(input, 'autoMaxOffers') && !Object.hasOwn(input, 'automaticOfferLimit')) out.automaticOfferLimit = input.autoMaxOffers;
  if (Object.hasOwn(input, 'requestMaxModels') && !Object.hasOwn(input, 'multiModelMax')) out.multiModelMax = input.requestMaxModels;
  const bounds = { repeatHours: [1, 8760], contactIntervalMinutes: [0, 1440], maxPerDay: [1, 100], validityMinutes: [1, 10080], availabilityMaxAgeMinutes: [1, 10080], automaticOfferLimit: [1, 10], multiModelMax: [1, 10], retryMax: [0, 5], retryIntervalSeconds: [5, 3600] };
  for (const [key, [min, max]] of Object.entries(bounds)) if (!Number.isInteger(out[key]) || out[key] < min || out[key] > max) throw error(`${key}: use um inteiro entre ${min} e ${max}.`, 'OPPORTUNITY_CONFIG_INVALID');
  out.autoMaxOffers = out.automaticOfferLimit; out.requestMaxModels = out.multiModelMax;
  if (!['cashAscending', 'recent', 'campaign'].includes(out.priority)) throw error('Prioridade inválida.', 'OPPORTUNITY_CONFIG_INVALID');
  try { new Intl.DateTimeFormat('pt-BR', { timeZone: out.timezone }).format(); } catch { throw error('Fuso horário inválido.', 'OPPORTUNITY_CONFIG_INVALID'); }
  out.sound = { enabled: true, volume: 70, durationSeconds: 2, minIntervalSeconds: 30, burstSeconds: 2, ...old.sound, ...input.sound,
    quiet: { enabled: false, start: '22:00', end: '08:00', ...old.sound?.quiet, ...input.sound?.quiet } };
  if (typeof out.sound.enabled !== 'boolean' || typeof out.sound.quiet.enabled !== 'boolean') throw error('Som inválido.', 'OPPORTUNITY_CONFIG_INVALID');
  for (const [key, min, max] of [['volume', 0, 100], ['durationSeconds', 1, 30], ['minIntervalSeconds', 1, 86400], ['burstSeconds', 1, 30]]) if (!Number.isFinite(out.sound[key]) || out.sound[key] < min || out.sound[key] > max) throw error('Configuração do som inválida.', 'OPPORTUNITY_CONFIG_INVALID');
  for (const key of ['start', 'end']) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(out.sound.quiet[key])) throw error('Horário silencioso inválido.', 'OPPORTUNITY_CONFIG_INVALID');
  out.sound.quiet.timezone = out.timezone;
  out.ownerId = actorId || old.ownerId || null; out.enabledAt = out.enabled && !old.enabled ? now : old.enabledAt || null; out.updatedAt = now;
  return out;
}

function formatOpportunityResponse(opportunity, offers) {
  const heading = offers.length === 1 ? '📱 *Aparelho para sua procura*' : '📱 *Opções para sua procura*';
  const blocks = offers.map((offer, i) => {
    const title = [offer.model, offer.storageGB && `${offer.storageGB}GB`, offer.color].filter(Boolean).join(' • ');
    const details = [offers.length > 1 ? `${i + 1}. *${title}*` : `*${title}*`, Number.isInteger(offer.priceCents) ? `💰 ${MONEY(offer.priceCents)}` : null,
      offer.condition ? `📦 ${offer.condition}` : null, Number.isInteger(offer.batteryPercent) ? `🔋 Bateria: ${offer.batteryPercent}%` : null,
      offer.excerpt || offer.originalExcerpt || null].filter(Boolean);
    return details.join('\n');
  });
  return `${heading}\n\n${blocks.join('\n\n━━━━━━━━━━━━\n\n')}\n\nConfirme as condições e a disponibilidade antes de fechar.`;
}

class OpportunityService extends EventEmitter {
  constructor({ store, adapter, scheduler, now = () => Date.now(), assertCanCapture = () => true, assertCanOperate = () => true,
    assertOwnerPermissions = () => true, isAutomationStopped = () => false, onLocalAlert = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    super(); if (!store?.ingestOpportunity || !store?.reserveOpportunitySend) throw new Error('Armazenamento persistente de oportunidades obrigatório.');
    Object.assign(this, { store, adapter, scheduler, now, assertCanCapture, assertCanOperate, assertOwnerPermissions, isAutomationStopped, onLocalAlert, sleep });
    this.started = false; this.closed = false; this.suspended = false; this.pump = null; this.notifyIds = new Set(); this.controllers = new Set();
    this.offerIndex = null; this.offerParseCount = 0; this.freshOpportunityIds = new Set(); this.dueTimer = null;
    this.listener = ctx => { try { this.handleIncoming(ctx); } catch (e) { this._failure(e); } };
    this.statusListener = () => { this._schedulePump(); this.emit('change'); };
    this.receiptListener = receipt => this._receipt(receipt);
    this.updateListener = ctx => { try { this.handleUpdate(ctx); } catch (e) { this._failure(e); } };
    this.deleteListener = ctx => { try { this.handleDelete(ctx); } catch (e) { this._failure(e); } };
  }
  _mode() { return this.store.getStorageMode?.() || this.store.getSetting('integrationMode', 'whatsapp'); }
  _config() { return normalizeOpportunityConfig({}, this.store.getOpportunityConfig(), this.now()); }
  _assert(actorId, action = 'manage') { if (this.assertCanOperate(actorId, action) === false) throw error('Sem permissão para oportunidades.', 'OPPORTUNITY_FORBIDDEN'); }
  _trace(id, stage, code, description, detail = {}) {
    const entry = { id: randomUUID(), traceId: id || randomUUID(), at: this.now(), stage: `opportunities.${stage}`, operationType: 'opportunity', code,
      description: String(description).slice(0, 500), detail: Object.fromEntries(Object.entries(detail).filter(([key]) => ['opportunityId', 'taskId', 'messageId', 'senderKey', 'recipient', 'attempts', 'status', 'reason', 'selectedCampaignCount', 'campaignCount', 'campaignItemCount', 'indexedOfferCount', 'matchingModelCount', 'blockerCounts', 'availabilityMode'].includes(key))) };
    this.store.addOpportunityTrace?.({ ...entry, opportunityId: detail.opportunityId || null, taskId: detail.taskId || null }); this.store.addDiagnostic?.(entry);
  }
  _failure(e) { try { this._trace(null, 'failure', e?.code || 'OPPORTUNITY_ERROR', e?.message || 'Falha ao processar oportunidade.'); } catch { this.blockedReason = 'Falha no banco de dados.'; } this.emit('change'); }
  _attach() { this.adapter?.on('opportunityMessage', this.listener); this.adapter?.on('opportunityMessageUpdated', this.updateListener); this.adapter?.on('opportunityMessageDeleted', this.deleteListener); this.adapter?.on('status', this.statusListener); this.adapter?.on('receipt', this.receiptListener); }
  _detach() { this.adapter?.off('opportunityMessage', this.listener); this.adapter?.off('opportunityMessageUpdated', this.updateListener); this.adapter?.off('opportunityMessageDeleted', this.deleteListener); this.adapter?.off('status', this.statusListener); this.adapter?.off('receipt', this.receiptListener); }
  _configure() { const c = this._config(); this.adapter?.configureOpportunityCapture?.({ enabled: c.enabled && !this.suspended && !this.closed, monitoredGroupIds: c.monitoredGroupIds, allowOwnMessages: c.allowOwnMessages, activatedAt: c.enabledAt }); }
  start() { if (this.started || this.closed) return; this.started = true; this.store.recoverOpportunityTasks?.(this.now()); this._attach(); this._configure(); this.timer = setInterval(() => { if (!this.closed) { this._expire(); this._schedulePump(); } }, 15_000); this.timer.unref?.(); this._schedulePump(); }
  async stop() { if (this.closed) return; this.closed = true; clearInterval(this.timer); clearTimeout(this.dueTimer); clearTimeout(this.notifyTimer); this._detach(); this._configure(); for (const controller of this.controllers) controller.abort(); await this.pump?.catch(() => {}); }
  shutdown() { return this.stop(); }
  setAdapter(adapter) { this._detach(); for (const controller of this.controllers) controller.abort(); this.adapter = adapter; this.offerIndex = null; this.freshOpportunityIds.clear(); if (this.started) this._attach(); this._configure(); this._schedulePump(); }
  async suspendCapture() { this.suspended = true; clearTimeout(this.dueTimer); this._configure(); for (const controller of this.controllers) controller.abort(); await this.pump?.catch(() => {}); }
  resumeCapture() { this.suspended = false; this._configure(); this._schedulePump(); }
  cancelAutomatic(reason = 'Envios automáticos interrompidos.') { const result = this.store.cancelOpportunityTasks({ automaticOnly: true, now: this.now(), reason }); for (const controller of this.controllers) controller.abort(); this.emit('change'); return result.cancelled; }
  saveConfig(input, actorId) {
    this._assert(actorId, 'manage'); const c = normalizeOpportunityConfig(input?.config || input, this._config(), this.now(), actorId);
    const simulated = this._mode() === 'simulated', groups = new Map(this.store.listGroups().map(g => [g.id, g]));
    for (const id of c.monitoredGroupIds) { const g = groups.get(id); if (!g || Boolean(g.simulation) !== simulated || g.available === false || (simulated ? !/@simulation$/.test(id) : !/@g\.us$/.test(id))) throw error('Selecione grupos disponíveis no modo atual.', 'OPPORTUNITY_GROUP_INVALID'); }
    const campaigns = new Set(this.store.listCampaigns().map(v => v.id)); if (c.campaignIds.some(id => !campaigns.has(id))) throw error('Selecione campanhas existentes.', 'OPPORTUNITY_CAMPAIGN_INVALID');
    if (c.enabled && this.assertCanCapture(actorId) === false || c.automatic && this.assertOwnerPermissions(actorId, 'automatic') === false) throw error('Sem permissão para ativar oportunidades.', 'OPPORTUNITY_FORBIDDEN');
    this.store.setOpportunityConfig(c); this.offerIndex = null; this.freshOpportunityIds.clear(); if (!c.enabled || !c.automatic) this.cancelAutomatic('Modo automático desativado.'); this._configure(); this._schedulePump(); this.emit('change'); return this._config();
  }
  _identity(ctx) {
    if (ctx.identityVerified !== true || ctx.identityAmbiguous === true) return null;
    const phone = normalizePhone(ctx.senderNumber || ctx.senderPhone), id = canonical(ctx.senderId);
    const identity = this.store.resolveOpportunityIdentity?.({ senderId: id, senderIds: (ctx.senderIds || []).map(canonical), phone, identityVerified: true, identityAmbiguous: ctx.identityAmbiguous }, this.now());
    if (identity?.ambiguous) { this._trace(ctx.messageId, 'identity', identity.code || 'OP_IDENTITY_AMBIGUOUS', identity.reason || 'Identidade ambígua; resposta automática bloqueada.', { messageId: ctx.messageId }); return null; }
    if (!identity && !phone && !/^[1-9]\d*@(lid|s\.whatsapp\.net)$/.test(id || '')) return null;
    const resolvedPhone = identity?.phone || phone;
    return { senderKey: identity?.senderKey || (phone ? `phone:${phone}` : `account:${id}`), senderId: id, senderPhone: resolvedPhone, senderName: String(ctx.profileName || ctx.pushName || ctx.displayName || '').slice(0, 256), recipient: resolvedPhone || null };
  }
  _eligibleContext(ctx, c) {
    const groupId = ctx?.chatId || ctx?.groupId, originalAt = Number(ctx?.originalTimestamp ?? ctx?.originalAt ?? ctx?.timestamp);
    if (!c.enabled || this.closed || this.suspended || this.store.persistenceFailed || this.isAutomationStopped() || !c.monitoredGroupIds.includes(groupId)) return null;
    try { if (this.assertCanCapture(c.ownerId) === false) return null; } catch { return null; }
    if (ctx.isGroup === false || ctx.automaticMessage || ctx.machineGenerated || ctx.automated || ctx.history || ctx.historical || ctx.forwarded || ctx.isForwarded || ctx.forwardingScore > 0 || this.store.isOutboundMessageId?.(ctx.messageId)) return null;
    if (ctx.fromMe && (!c.allowOwnMessages || ctx.trustedSelf !== true)) return null;
    if (this._mode() === 'simulated' ? ctx.simulation !== true || ctx.mode !== 'simulated' : ctx.simulation === true || ctx.mode && ctx.mode !== 'whatsapp') return null;
    if (typeof ctx.messageId !== 'string' || !ctx.messageId || ctx.messageId.length > 512 || typeof ctx.text !== 'string' || !ctx.text.trim() || ctx.text.length > 16000 || /^\s*!/.test(ctx.text) || ctx.type && ctx.type !== 'text') return null;
    if (!Number.isSafeInteger(originalAt) || originalAt <= 0 || originalAt > this.now() + 30000 || originalAt < c.enabledAt) return null;
    const identity = this._identity(ctx); if (!identity) return null;
    return { groupId, originalAt, identity };
  }
  handleIncoming(ctx) {
    const c = this._config(), checked = this._eligibleContext(ctx, c); if (!checked) return { ignored: true };
    const { groupId, originalAt, identity } = checked;
    if (/^(?:ja\s+consegui|já\s+consegui|achei|nao\s+preciso\s+mais|não\s+preciso\s+mais|pode\s+cancelar)[.!\s]*$/i.test(ctx.text.trim())) return this._closeFromMessage(ctx, checked);
    const request = parseRequest(ctx.text, { aliases: c.aliases }); if (!request?.recognized || !request.models?.length) return { ignored: true };
    const result = this.store.ingestOpportunity({ event: { ...identity, chatId: groupId, groupId, groupName: this.store.getGroup?.(groupId)?.name || '', messageId: ctx.messageId,
      originalAt, text: ctx.text, quotedMessageId: ctx.quotedMessageId || null }, request }, this.now());
    const op = result.opportunity; this._trace(op?.id, 'received', result.duplicate ? 'OPPORTUNITY_DUPLICATE_EVENT' : result.grouped ? 'OPPORTUNITY_GROUPED' : 'OPPORTUNITY_RECEIVED', result.duplicate ? 'Evento já registrado; nenhuma nova resposta.' : result.grouped ? 'Pedido repetido agrupado com suas origens.' : 'Pedido registrado.', { opportunityId: op?.id, senderKey: identity.senderKey, messageId: ctx.messageId });
    if (!result.duplicate && op) { this.lastProcessedAt = this.now(); this.lastMessageAt = originalAt; if (!result.grouped && originalAt >= this.now() - 60000 && c.automatic && !op.needsReview) this.freshOpportunityIds.add(op.id); this.evaluate(op.id, { automatic: !result.changedRelevant }); this.emit('change'); }
    return result;
  }
  handleUpdate(ctx) {
    const groupId = ctx?.chatId, old = groupId && ctx?.messageId && this.store.getOpportunityOrigin?.(groupId, ctx.messageId);
    if (!old) return { ignored: true };
    const c = this._config(), checked = this._eligibleContext({ ...ctx, originalTimestamp: old.originalAt, timestamp: old.originalAt }, c);
    if (!checked || checked.identity.senderKey !== old.senderKey) return { ignored: true };
    const request = parseRequest(ctx.text, { aliases: c.aliases });
    if (!request.recognized || !request.models.length) { this.store.updateOpportunity(old.opportunityId, { needsReview: true, reviewReason: 'O texto original foi editado e requer revisão.', updatedAt: this.now() }); for (const task of list(this.store.listOpportunityTasks({ opportunityId: old.opportunityId, status: 'queued', limit: 1000 }))) this.store.updateOpportunityTask(task.id, { status: 'cancelled', resultAt: this.now(), reason: 'Texto original editado; revisão necessária.', code: 'OP_REVIEW' }); this.emit('change'); return { review: true }; }
    const result = this.store.updateOpportunityOrigin(groupId, ctx.messageId, { senderKey: checked.identity.senderKey, text: ctx.text, request, revisionAt: this.now(), now: this.now() });
    this._trace(old.opportunityId, 'edited', 'OPPORTUNITY_ORIGIN_EDITED', 'Publicação original editada; controles de repetição e prazo preservados.', { opportunityId: old.opportunityId, messageId: ctx.messageId }); this.emit('change'); return result;
  }
  handleDelete(ctx) {
    const c = this._config(); if (!c.enabled || this.closed || this.suspended || !c.monitoredGroupIds.includes(ctx?.chatId) || ctx.mode && ctx.mode !== this._mode() || ctx.simulation === true && this._mode() !== 'simulated') return { ignored: true };
    const old = ctx.messageId && this.store.getOpportunityOrigin?.(ctx.chatId, ctx.messageId); if (!old) return { ignored: true };
    const result = this.store.deleteOpportunityOrigin(ctx.chatId, ctx.messageId, { at: this.now() }); this._trace(old.opportunityId, 'deleted', 'OPPORTUNITY_ORIGIN_DELETED', 'Mensagem de origem excluída pela integração; respostas não iniciadas reavaliadas.', { opportunityId: old.opportunityId, messageId: ctx.messageId }); this.emit('change'); return result;
  }
  _closeFromMessage(ctx, { groupId, identity }) {
    const quoted = ctx.quotedMessageId;
    if (!quoted || ctx.quotedChatId && ctx.quotedChatId !== groupId) { this._trace(null, 'review', 'OPPORTUNITY_CLOSURE_AMBIGUOUS', 'Pedido possivelmente encerrado; sem referência original confiável, nenhuma oportunidade foi fechada.', { senderKey: identity.senderKey, messageId: ctx.messageId }); return { ignored: true, review: true }; }
    const origin = this.store.getOpportunityOrigin(groupId, quoted), opportunity = origin && this.store.getOpportunity(origin.opportunityId);
    if (!opportunity || origin.deleted || origin.senderKey !== identity.senderKey || opportunity.senderKey !== identity.senderKey || isClosed(opportunity.status)) return { ignored: true, review: true };
    const result = this.store.closeOpportunity(opportunity.id, { now: this.now(), reason: 'Encerrada pelo mesmo autor em resposta à procura original.', actorId: identity.senderKey });
    this._trace(opportunity.id, 'closed', 'OPPORTUNITY_REQUEST_CLOSED', 'Pedido encerrado pelo autor; tarefas não iniciadas canceladas.'); this.emit('change'); return { closed: true, opportunity: result };
  }
  _syncOffers() {
    const c = this._config(), campaigns = this.store.listCampaigns({ ids: c.campaignIds }), frames = [], sources = new Map(), mediaRecords = new Map();
    for (const campaign of campaigns) {
      if (!c.campaignIds.includes(campaign.id)) continue;
      for (const item of campaign.items || []) {
        if (item.sourcePublicationId && !sources.has(item.sourcePublicationId)) sources.set(item.sourcePublicationId, this.store.getSourcePublication?.(item.sourcePublicationId));
        if (item.mediaId && !mediaRecords.has(item.mediaId)) mediaRecords.set(item.mediaId, this.store.getMedia?.(item.mediaId));
        const source = sources.get(item.sourcePublicationId), media = mediaRecords.get(item.mediaId);
        frames.push({ campaign, item, source, media, fingerprint: campaignItemFingerprint(item, campaign, { source, media }) });
      }
    }
    const signature = hash([this._mode(), c.campaignIds, c.availabilityMode, frames.map(frame => [frame.campaign.id, frame.campaign.name, frame.fingerprint])]);
    if (this.offerIndex?.signature === signature) return this.offerIndex.offers;
    const all = new Map();
    for (const { campaign, item, source, media, fingerprint } of frames) {
      const assessment = assessCampaignItem(item, campaign, { source, media, availabilityMode: c.availabilityMode, now: this.now() });
      this.offerParseCount++;
      const parsedOffers = parseCampaignOffer(item, campaign, media, { originalAt: source?.originalAt, now: this.now() }) || [];
      for (const parsed of parsedOffers) {
        if (c.availabilityMode === 'campaign' && parsedOffers.length === 1 && parsed.identityConfidence !== 'verified' && assessment.identityReference) {
          Object.assign(parsed, { id: assessment.identityReference, offerKey: assessment.identityReference, offerId: assessment.identityReference, identityConfidence: 'campaign', identityReason: 'campaign_item_reference' });
        }
        const id = parsed.offerKey || parsed.offerId || parsed.id; if (!id) continue;
        const candidate = { ...parsed, id, offerId: id, offerKey: id, campaignName: campaign.name, sourceMode: this._mode(), copyConflict: false,
          campaignItemFingerprint: fingerprint, availabilitySource: c.availabilityMode, opportunityAvailable: item.opportunityAvailable !== false, singleItemOffer: parsedOffers.length === 1,
          campaignEligible: assessment.eligible && c.availabilityMode === 'campaign', mediaId: item.mediaId || null, mediaType: item.type,
          eligible: assessment.eligible && parsed.confidence === 'confirmed' && parsed.priceKind === 'cash' && Number.isInteger(parsed.priceCents) && parsed.priceCents > 0,
          sourceBlocker: assessment.blocker || null };
        if (c.availabilityMode === 'campaign' && assessment.eligible) Object.assign(candidate, { available: parsed.available === false ? false : true, availabilityConfirmedAt: null, availabilityDeclared: true });
        if (assessment.quantityAvailable !== null) candidate.quantityAvailable = assessment.quantityAvailable;
        if (!assessment.eligible) Object.assign(candidate, { eligible: false, available: assessment.available, availabilityConfirmedAt: null, identityConfidence: 'review' });
        const prior = all.get(id);
        if (!prior) all.set(id, candidate);
        else {
          const refs = [...(prior.campaignReferences || [{ campaignId: prior.campaignId, itemId: prior.itemId }]), { campaignId: candidate.campaignId, itemId: candidate.itemId }];
          const conflict = prior.copyConflict || prior.offerRevision !== candidate.offerRevision || prior.available !== candidate.available || prior.quantityAvailable !== candidate.quantityAvailable || Boolean(prior.sourceBlocker) !== Boolean(candidate.sourceBlocker);
          if (conflict) all.set(id, { ...prior, copyConflict: true, campaignReferences: refs, available: prior.available === false || candidate.available === false ? false : null, eligible: false, campaignEligible: false, identityConfidence: 'review', identityReason: 'conflicting_copies_of_original_offer', availabilityConfirmedAt: null });
          else all.set(id, { ...((candidate.availabilityConfirmedAt || 0) > (prior.availabilityConfirmedAt || 0) ? candidate : prior), campaignReferences: refs });
        }
      }
    }
    for (const candidate of all.values()) {
      const old = this.store.getOpportunityOffer(candidate.id);
      if (c.availabilityMode === 'confirmed' && !candidate.copyConflict && !candidate.sourceBlocker && old?.offerRevision === candidate.offerRevision && old.availabilityConfirmedAt && candidate.available !== false && (!candidate.availabilityConfirmedAt || old.availabilityConfirmedAt > candidate.availabilityConfirmedAt)) Object.assign(candidate, { available: old.available, availabilityConfirmedAt: old.availabilityConfirmedAt, quantityAvailable: old.quantityAvailable, ...(old.explicitUnitReference ? { explicitUnitReference: old.explicitUnitReference, identityConfidence: 'verified', identityReason: 'manual_unit_reference' } : {}) });
      if (!old || ['offerRevision', 'available', 'availabilityConfirmedAt', 'quantityAvailable', 'identityConfidence', 'explicitUnitReference', 'contentFingerprint', 'mediaFingerprint', 'eligible', 'campaignId', 'itemId', 'copyConflict', 'campaignReferences', 'sourceBlocker', 'campaignItemFingerprint', 'availabilitySource', 'campaignEligible', 'opportunityAvailable'].some(key => JSON.stringify(old[key] ?? null) !== JSON.stringify(candidate[key] ?? null))) this.store.saveOpportunityOffer(candidate);
    }
    const offers = [...all.keys()].map(id => this.store.getOpportunityOffer(id));
    this.offerIndex = { signature, offers, indexedAt: this.now(), stats: { selectedCampaignCount: c.campaignIds.length,
      campaignCount: campaigns.filter(campaign => c.campaignIds.includes(campaign.id)).length, campaignItemCount: frames.length, indexedOfferCount: offers.length, availabilityMode: c.availabilityMode } }; return offers;
  }
  invalidateCampaignOffers({ reevaluate = false } = {}) {
    this.offerIndex = null; const offers = this._syncOffers(); let evaluated = 0;
    if (reevaluate && this._config().automatic && !this.isAutomationStopped()) {
      for (const id of [...this.freshOpportunityIds]) {
        const op = this.store.getOpportunity(id);
        if (!op || op.status !== 'open' || op.needsReview || op.expiresAt <= this.now() || this.now() - op.originalAt > 60000) { this.freshOpportunityIds.delete(id); continue; }
        this.evaluate(id, { automatic: true, offers }); evaluated++;
      }
    }
    this._schedulePump(); this.emit('change'); return { indexed: offers.length, evaluated };
  }
  listCampaignOffers({ limit = 100, offset = 0 } = {}) {
    const offers = this._syncOffers(), start = Math.max(0, Number(offset) || 0), size = Math.min(100, Math.max(1, Number(limit) || 100));
    return { total: offers.length, items: offers.slice(start, start + size).map(offer => ({ offerId: offer.id, campaignId: offer.campaignId, itemId: offer.itemId,
      campaignName: offer.campaignName, model: offer.model, storageGB: offer.storageGB ?? null, color: offer.color || null, condition: offer.condition || null,
      text: offer.originalExcerpt || offer.excerpt || offer.rawText || '', priceCents: offer.priceCents ?? null, available: offer.available,
      mediaId: offer.mediaId || null, opportunityAvailable: offer.opportunityAvailable, availabilityReason: offer.sourceBlocker?.reason || (offer.availabilitySource === 'campaign' ? 'Disponibilidade declarada pelo anúncio na campanha.' : 'Exige confirmação manual atualizada.'), availabilitySource: offer.availabilitySource })) };
  }
  listCampaignItems({ limit = 30, offset = 0, campaignId } = {}) {
    const c = this._config();
    if (campaignId !== undefined && (typeof campaignId !== 'string' || !c.campaignIds.includes(campaignId))) throw error('Selecione uma campanha habilitada nas Oportunidades.', 'OPPORTUNITY_CAMPAIGN_INVALID');
    const items = [];
    for (const campaign of this.store.listCampaigns()) {
      if (!c.campaignIds.includes(campaign.id) || campaignId && campaign.id !== campaignId) continue;
      for (const item of campaign.items || []) {
        const source = item.sourcePublicationId ? this.store.getSourcePublication?.(item.sourcePublicationId) : undefined, media = item.mediaId ? this.store.getMedia?.(item.mediaId) : undefined;
        const assessment = assessCampaignItem(item, campaign, { source, media, availabilityMode: 'campaign', manualSelection: true });
        const text = item.type === 'text' ? String(item.text || '') : String(item.caption || '');
        const blocker = assessment.blocker || (!text.trim() && item.type === 'text' ? { code: 'OFFER_TEXT_EMPTY', reason: 'O anúncio não possui texto para enviar.' } : null);
        items.push({ campaignId: campaign.id, itemId: item.id, campaignName: campaign.name, type: item.type, mediaId: item.mediaId || null, text,
          manualEligible: assessment.eligible && !blocker, blocker, availabilityConditional: assessment.availabilityConditional === true });
      }
    }
    const start = Math.max(0, Number(offset) || 0), size = Math.min(100, Math.max(1, Number(limit) || 30));
    return { total: items.length, offset: start, limit: size, items: items.slice(start, start + size) };
  }
  _manualOffer(selection) {
    const c = this._config();
    if (!selection || typeof selection !== 'object' || Array.isArray(selection) || !['campaignId', 'itemId'].every(key => typeof selection[key] === 'string' && selection[key] && selection[key].length <= 512)) throw error('Selecione um anúncio de campanha válido.', 'OPPORTUNITY_SELECTION_INVALID');
    const { campaignId, itemId } = selection;
    if (!c.campaignIds.includes(campaignId)) throw error('A campanha não está selecionada nas Oportunidades.', 'OPPORTUNITY_CAMPAIGN_INVALID');
    const campaign = this.store.getCampaign(campaignId), item = campaign?.items?.find(row => row.id === itemId);
    if (!campaign || !item) throw error('O anúncio foi removido ou a campanha não existe mais.', 'OPPORTUNITY_OFFER_CHANGED');
    const source = item.sourcePublicationId ? this.store.getSourcePublication?.(item.sourcePublicationId) : undefined, media = item.mediaId ? this.store.getMedia?.(item.mediaId) : undefined;
    const assessment = assessCampaignItem(item, campaign, { source, media, availabilityMode: 'campaign', manualSelection: true });
    const text = item.type === 'text' ? String(item.text || '') : String(item.caption || '');
    if (!assessment.eligible) throw error(assessment.blocker?.reason || 'O anúncio não pode ser enviado.', assessment.blocker?.code || 'OPPORTUNITY_OFFER_CHANGED');
    if (text.length > 16000 || item.type === 'text' && !text.trim()) throw error('Revise o texto do anúncio: informe até 16.000 caracteres.', 'OPPORTUNITY_TEXT_INVALID');
    const fingerprint = campaignItemFingerprint(item, campaign, { source, media }), indexed = this._syncOffers().filter(offer => offer.campaignId === campaignId && offer.itemId === itemId);
    const parsed = indexed.length === 1 ? indexed[0] : null, identity = stableOfferIdentity(item, campaign, media || {});
    const id = `manual-campaign-item:${hash([campaignId, itemId])}`;
    const result = { ...(parsed || {}), id, offerId: id, offerKey: id, manualOnly: true, manualCampaignSelection: { campaignId, itemId },
      model: parsed?.model || null, modelKey: parsed?.modelKey || null, storageGB: parsed?.storageGB ?? null, color: parsed?.color || null, colorKey: parsed?.colorKey || null,
      condition: parsed?.condition || null, batteryPercent: parsed?.batteryPercent ?? null, priceCents: parsed?.confidence === 'confirmed' ? parsed.priceCents ?? null : null,
      canonicalOfferId: parsed?.id || identity.offerKey, canonicalOfferIds: indexed.length ? indexed.map(value => value.id) : [identity.offerKey], campaignId, itemId, campaignName: campaign.name, mediaId: item.mediaId || null, mediaType: item.type,
      originalExcerpt: text, excerpt: text, rawText: text, originalAt: source?.originalAt || item.sourceOriginalAt || item.originalAt || null,
      available: true, availabilitySource: 'campaign', availabilityDeclared: true, campaignEligible: true, opportunityAvailable: item.opportunityAvailable !== false,
      availabilityConditional: assessment.availabilityConditional === true, availabilityConfirmedAt: null, quantityAvailable: assessment.quantityAvailable,
      campaignItemFingerprint: fingerprint, offerRevision: hash([fingerprint, text, item.type]), contentFingerprint: materialFingerprint(text), mediaFingerprint: media?.sha256 || media?.hash || null,
      explicitUnitReference: parsed?.explicitUnitReference || identity.explicitUnitReference || null, identityConfidence: 'manual', sourceBlocker: null };
    const old = this.store.getOpportunityOffer(id);
    if (!old || old.offerRevision !== result.offerRevision || old.canonicalOfferId !== result.canonicalOfferId || JSON.stringify(old.canonicalOfferIds) !== JSON.stringify(result.canonicalOfferIds)) this.store.saveOpportunityOffer(result);
    return this.store.getOpportunityOffer(id);
  }
  _manualPreviewData(id, selection, actorId, expiresAt, options = {}) {
    const op = this.store.getOpportunity(id); if (!op) throw error('Oportunidade não encontrada.', 'OPPORTUNITY_NOT_FOUND');
    const offer = this._manualOffer(selection), reviewed = options.reviewed === true, risk = options.duplicateRiskAcknowledged === true;
    const check = this.store.checkOpportunitySend({ opportunityId: id, offerIds: [offer.id], now: this.now(), automatic: false, evaluationOnly: true,
      manualCampaignSelection: selection, reviewed, allowExpired: reviewed, duplicateRiskAcknowledged: risk, manualOverride: risk, automationAllowed: !this.isAutomationStopped() });
    const blockers = check?.ok ? [] : [{ code: check?.code || 'OPPORTUNITY_SEND_BLOCKED', reason: check?.reason || 'Revise a oportunidade antes de enviar.' }];
    if (this.isAutomationStopped()) blockers.push({ code: 'OP_STOPPED', reason: 'Parada geral ativa. Retome o sistema antes de enviar.' });
    if (!op.recipient) blockers.push({ code: 'RECIPIENT_UNAVAILABLE', reason: 'Número real do interessado indisponível.' });
    const warnings = [{ code: 'MANUAL_CAMPAIGN_SELECTION', reason: 'Anúncio escolhido manualmente: confira o conteúdo completo, as condições e o destinatário. Não houve inferência automática de compatibilidade nem consulta de estoque.' }];
    if (offer.availabilityConditional) warnings.push({ code: 'MANUAL_CONDITIONAL_OFFER', reason: 'O anúncio contém condições de disponibilidade ou encomenda; elas serão preservadas integralmente.' });
    const payload = [this._mode(), actorId, id, op.request?.intentKey, op.status, op.needsReview, op.expiresAt, offer.id, offer.offerRevision, configHash(this._config()), selection.campaignId, selection.itemId, reviewed, risk, expiresAt];
    return { opportunity: this._present(op, []), offers: [offer], offerIds: [offer.id], manualCampaignSelection: { campaignId: selection.campaignId, itemId: selection.itemId },
      text: offer.rawText, canSend: !blockers.length, blockers, warnings, reviewed, duplicateRiskAcknowledged: risk, previewToken: `${expiresAt}:${hash(payload)}` };
  }
  _candidates(op, offers = this._syncOffers()) {
    const c = this._config(), models = op.request?.models || op.requests || [];
    // A manually selected announcement is a projection of its original campaign
    // item, not a new physical offer. Reuse the durable canonical references for
    // the panel as well as the final database guard, so a prior manual response
    // does not appear eligible (or sound the siren) when the same item matches
    // automatically later. Resolve each projection task once per evaluation.
    const canonicalHistory = new Map(), historyTasks = new Map(), sentHistory = this.store.getOpportunitySentOffers?.(op.senderKey) || [];
    for (const record of sentHistory) {
      if (!String(record.offerId || '').startsWith('manual-campaign-item:')) continue;
      if (!historyTasks.has(record.taskId)) historyTasks.set(record.taskId, this.store.getOpportunityTask?.(record.taskId));
      const task = historyTasks.get(record.taskId);
      if (!task || !(['queued', 'sending', 'accepted', 'delivered', 'uncertain', 'outside'].includes(task.status) || task.startedAt != null)) continue;
      const snapshot = task.offerSnapshots?.find(value => value.id === record.offerId);
      if (!snapshot?.manualOnly) continue;
      for (const reference of [snapshot.canonicalOfferId, ...(snapshot.canonicalOfferIds || [])]) {
        if (typeof reference === 'string' && reference) canonicalHistory.set(reference, { ...record, sourceSnapshot: snapshot });
      }
    }
    const candidates = offers.map(offer => {
      const matches = models.map(spec => {
        const sameModel = spec.modelKey && spec.modelKey === offer.modelKey;
        const blocker = sameModel && (offer.sourceBlocker || (offer.copyConflict ? { code: 'OFFER_COPY_CONFLICT', reason: 'Cópias da mesma referência apresentam conteúdo ou disponibilidade divergentes; revise as campanhas vinculadas.' } : null));
        return { spec, match: blocker ? { eligible: false, needsReview: true, ...blocker } : matchOffer(spec, offer, { now: this.now(), availabilityMaxAgeMinutes: c.availabilityMaxAgeMinutes, availabilityMode: c.availabilityMode }) };
      });
      const best = matches.find(v => v.match.eligible) || matches.find(v => v.match.needsReview) || matches[0];
      const response = this.store.getOpportunityOfferSent?.(op.senderKey, offer.id) || canonicalHistory.get(offer.id) || sentHistory.filter(v => v.offerId === offer.id && ['queued', 'sending', 'accepted', 'delivered', 'uncertain', 'outside'].includes(v.status)).at(-1);
      const sentBefore = Boolean(response), updatedSinceSent = Boolean(response?.sourceSnapshot
        ? response.sourceSnapshot.campaignItemFingerprint !== offer.campaignItemFingerprint
        : response && typeof response === 'object' && response.offerRevision && response.offerRevision !== offer.offerRevision);
      const blockers = sentBefore ? [{ code: updatedSinceSent ? 'OFFER_UPDATED_SENT' : 'OFFER_ALREADY_SENT', reason: updatedSinceSent ? 'Oferta atualizada — já enviada anteriormente.' : 'Oferta já enviada para este contato.' }] : best?.match?.eligible ? [] : [{ code: best?.match?.code || 'OFFER_NOT_COMPATIBLE', reason: best?.match?.reason || 'A oferta não corresponde com segurança à procura.' }];
      return { ...offer, eligible: Boolean(best?.match?.eligible) && !sentBefore, compatible: Boolean(best?.match?.eligible), match: best?.match, modelMatches: matches, sentBefore, updatedSinceSent, blockers };
    });
    const compatible = candidates.filter(v => v.compatible || v.match?.needsReview);
    compatible.sort((a, b) => c.priority === 'recent' ? (b.originalAt || 0) - (a.originalAt || 0) : c.priority === 'campaign' ? c.campaignIds.indexOf(a.campaignId) - c.campaignIds.indexOf(b.campaignId) : (a.priceCents ?? Infinity) - (b.priceCents ?? Infinity));
    return compatible;
  }
  _noSafeOffer(op, candidates, offers = this._syncOffers()) {
    const c = this._config(), stats = { ...(this.offerIndex?.stats || {}), matchingModelCount: 0, blockerCounts: [] };
    if (!c.campaignIds.length) return { code: 'OP_NO_CAMPAIGNS', reason: 'Nenhuma campanha foi selecionada nas Oportunidades. Selecione as campanhas com seus anúncios.', detail: stats };
    if (!stats.campaignCount) return { code: 'OP_CAMPAIGNS_MISSING', reason: 'As campanhas selecionadas não estão disponíveis. Revise a seleção de campanhas.', detail: stats };
    if (!offers.length) return { code: 'OP_CAMPAIGNS_NO_INDEXED_OFFERS', reason: stats.campaignItemCount ? 'Há anúncios nas campanhas, mas nenhum pôde ser interpretado com segurança para resposta automática. Você pode escolher o anúncio e conferir o envio manualmente.' : 'As campanhas selecionadas ainda não possuem anúncios. Adicione conteúdo ou escolha outra campanha.', detail: stats };
    const models = op.request?.models || [], matching = offers.filter(offer => models.some(spec => spec.modelKey && spec.modelKey === offer.modelKey));
    stats.matchingModelCount = matching.length;
    if (!matching.length) return { code: 'OP_MODEL_NOT_IN_CAMPAIGNS', reason: 'Não há anúncio do modelo e versão procurados nas campanhas selecionadas. Escolha manualmente apenas se o anúncio atender ao pedido.', detail: stats };
    const counts = new Map(); let first;
    for (const offer of matching) {
      const candidate = candidates.find(value => value.id === offer.id), match = candidate?.blockers?.[0] || offer.sourceBlocker || models.map(spec => matchOffer(spec, offer, { now: this.now(), availabilityMode: c.availabilityMode, availabilityMaxAgeMinutes: c.availabilityMaxAgeMinutes })).find(value => value.code !== 'MODEL_MISMATCH');
      if (match && !match.eligible) { counts.set(match.code, (counts.get(match.code) || 0) + 1); first ||= match; }
    }
    stats.blockerCounts = [...counts].map(([code, count]) => ({ code, count }));
    return { code: first?.code || 'NO_SAFE_OFFER', reason: first?.reason || 'Os anúncios do modelo encontrado precisam de revisão antes da resposta automática.', detail: stats };
  }
  evaluate(id, { automatic = false, offers } = {}) {
    const op = this.store.getOpportunity(id); if (!op) throw error('Oportunidade não encontrada.', 'OPPORTUNITY_NOT_FOUND');
    // The campaign-destination workflow owns dispatch and its durable outbox.
    // Never let a refresh of the legacy panel reserve a private response to the
    // interested person after the destination policy has been upgraded.
    if (this.workflow && this._config().campaignDestinations === true) {
      if (automatic) Promise.resolve(this.workflow.consider(id)).catch(e => this._failure(e));
      const current = this.store.getOpportunity(id), candidates = this._candidates(current, offers);
      return { opportunity: this._present(current, candidates), candidates, reservation: null, blockers: this._blockers(current, candidates, null, !candidates.length) };
    }
    const candidates = this._candidates(op, offers), eligible = candidates.filter(v => v.eligible), c = this._config();
    if (eligible.length && !isClosed(op.status) && !op.needsReview) this._notify(op);
    let reservation = null;
    if (automatic && c.enabled && c.automatic && !c.evaluation && !this.isAutomationStopped() && !isClosed(op.status) && !op.needsReview) {
      try { if (this.assertOwnerPermissions(c.ownerId, 'automatic') === false) throw error('Permissão automática removida.', 'OPPORTUNITY_FORBIDDEN');
        const models = op.request?.models || [];
        if (models.length > c.multiModelMax) reservation = { ok: false, code: 'REQUEST_TOO_MANY_MODELS', reason: 'Pedido com vários modelos requer revisão.' };
        else if (eligible.length && op.recipient) reservation = this.store.reserveOpportunitySend({ opportunityId: id, offerIds: eligible.slice(0, c.automaticOfferLimit).map(v => v.id), recipient: op.recipient, clientId: `OPP-${randomUUID()}`, automatic: true, now: this.now() });
        else reservation = { ok: false, ...(eligible.length ? { code: 'RECIPIENT_UNAVAILABLE', reason: 'Número real indisponível; revise o destinatário.' } : this._noSafeOffer(op, candidates, offers)) };
      } catch (e) { reservation = { ok: false, code: e.code, reason: e.message }; }
      if (reservation) { const blocker = reservation.ok ? null : { code: reservation.code, reason: reservation.reason }; const current = this.store.getOpportunity(id); if (JSON.stringify(current.lastBlocker || null) !== JSON.stringify(blocker)) this.store.updateOpportunity(id, { lastBlocker: blocker }); }
      if (reservation?.ok) { this._trace(reservation.task.id, 'queued', 'OPPORTUNITY_QUEUED', 'Resposta única reservada e colocada na fila persistente.', { opportunityId: id, taskId: reservation.task.id, recipient: op.recipient }); this._schedulePump(); }
      else if (reservation) this._trace(id, 'blocked', reservation.code, reservation.reason, { opportunityId: id, reason: reservation.reason, ...(reservation.detail || {}) });
    }
    const current = this.store.getOpportunity(id);
    return { opportunity: this._present(current,candidates), candidates, reservation, blockers: this._blockers(current, candidates, reservation) };
  }
  async evaluateAll({ ids } = {}, actorId) {
    this._assert(actorId, 'view'); if (ids !== undefined && !Array.isArray(ids)) throw error('Identificadores de avaliação inválidos.', 'OPPORTUNITY_SELECTION_INVALID'); const result = [], selected = ids && [...new Set(ids)], offers = this._syncOffers();
    if (selected && (!Array.isArray(ids) || selected.length > 10000 || selected.some(id => typeof id !== 'string'))) throw error('Identificadores de avaliação inválidos.', 'OPPORTUNITY_SELECTION_INVALID');
    if (selected) { for (const id of selected) result.push(this.evaluate(id, { automatic: false, offers })); }
    else { let offset = 0; for (;;) { const page = this.store.listOpportunities({ limit: 200, offset }); for (const op of list(page)) result.push(this.evaluate(op.id, { automatic: false, offers })); offset += list(page).length; if (!list(page).length || offset >= page.total) break; await new Promise(resolve => setImmediate(resolve)); } }
    return { evaluated: result.length, queued: 0, automatic: false, items: result };
  }
  _present(op,candidates=[]) {
    const origins=this.store.listOpportunityOrigins(op.id),groups=new Set(origins.map(v=>v.chatId||v.groupId)),origin=origins.find(v=>!v.deleted)||origins[0],blockers=this._blockers(op,candidates,null,!candidates.length);
    const matched=candidates.find(v=>v.compatible===true),campaign=matched&&this.store.getCampaign(matched.campaignId),item=campaign?.items?.find(v=>v.id===matched.itemId);
    const matchPreview=matched&&campaign&&item?{offerId:matched.id,campaignId:campaign.id,campaignName:campaign.name,itemId:item.id,mediaId:item.mediaId||null,mediaType:item.type,model:matched.model,storageGB:matched.storageGB??null,color:matched.color??null,condition:matched.condition??null,priceCents:matched.priceCents,text:matched.originalExcerpt||matched.excerpt||matched.rawText||'',available:matched.available,availabilityConfirmedAt:matched.availabilityConfirmedAt,sentBefore:matched.sentBefore===true}:null;
    return {...op,...(this.workflow && this._config().campaignDestinations === true ? {workflow:this.workflow.detail(op.id)} : {}),senderPhone:op.senderPhone||op.recipient||null,senderName:op.senderName||'',originalAt:op.originalAt||op.firstAt,requests:op.request?.models||[],intentConfidence:op.request?.intentConfidence||null,intentReasons:op.request?.intentReasons||[],originalText:origin?.text||'',originPreview:origin?{messageId:origin.messageId,groupId:origin.groupId||origin.chatId,groupName:origin.groupName||this.store.getGroup?.(origin.groupId||origin.chatId)?.name||'',originalAt:origin.originalAt,text:origin.text||''}:null,matchPreview,blockers,reason:blockers[0]?.reason||op.reviewReason||op.lastResponseReason||'',originCount:origins.length,groupCount:groups.size,groupedLabel:groups.size>1?`Pedido repetido em ${groups.size} grupos.`:null};
  }
  _blockers(op, candidates = [], reservation, summary = false) {
    const reasons = []; if ((op.request?.models?.length || 0) > this._config().multiModelMax) reasons.push({ code: 'REQUEST_TOO_MANY_MODELS', reason: 'Pedido com vários modelos requer revisão.' }); const currentCheck = this.store.checkOpportunitySend?.({ opportunityId: op.id, offerIds: [], now: this.now(), automatic: true, evaluationOnly: true, automationAllowed: !this.isAutomationStopped() });
    if (currentCheck && !currentCheck.ok) reasons.push({ code: currentCheck.code, reason: currentCheck.reason, nextEligibleAt: currentCheck.nextEligibleAt || null });
    if (currentCheck?.repetition && !currentCheck.repetition.ok) reasons.push({ code: currentCheck.repetition.code, reason: currentCheck.repetition.reason, nextEligibleAt: currentCheck.repetition.nextEligibleAt || null });
    const dynamicCodes = new Set(['OP_MUTED', 'OP_CLOSED', 'OP_EXPIRED', 'OP_REVIEW', 'OP_ALREADY_RESPONDED', 'OP_PENDING', 'OP_UNCERTAIN', 'OP_REPEAT', 'OP_INTERVAL', 'OP_DAILY_LIMIT', 'OP_AUTOMATIC_DISABLED', 'OP_STOPPED']);
    if (op.lastBlocker && !dynamicCodes.has(op.lastBlocker.code) && !candidates.some(value => value.eligible)) reasons.push(op.lastBlocker); if (op.status === 'uncertain') reasons.push({ code: 'OP_UNCERTAIN', reason: 'Envio anterior com resultado incerto.' }); if (op.outsideAnsweredAt) reasons.push({ code: 'OP_ALREADY_RESPONDED', reason: 'Já respondido por fora.' }); if (op.needsReview) reasons.push({ code: 'REQUEST_CHANGED_REVIEW', reason: 'Pedido alterado; revisão necessária.' });
    if (op.expiresAt <= this.now() || op.status === 'expired') reasons.push({ code: 'REQUEST_EXPIRED', reason: 'Pedido expirado.' });
    if (isClosed(op.status)) reasons.push({ code: 'REQUEST_CLOSED', reason: 'Oportunidade encerrada.' });
    if (this.store.getOpportunityContactMute?.(op.senderKey)?.muted) reasons.push({ code: 'CONTACT_MUTED', reason: 'Contato silenciado.' });
    if (reservation && !reservation.ok) reasons.push({ code: reservation.code, reason: reservation.reason });
    if (!summary && !candidates.some(v => v.eligible)) reasons.push(...(candidates[0]?.blockers || [this._noSafeOffer(op, candidates)]));
    return [...new Map(reasons.map(value => [value.code, value])).values()];
  }
  list(filters = {}, actorId) { this._assert(actorId, 'view'); this._expire(); const page = this.store.listOpportunities(filters),offers=this._syncOffers(); return { ...page, items: list(page).map(op => this._present(op,this._candidates(op,offers))) }; }
  invalidateCampaign(id) { this.previewGeneration=(this.previewGeneration||0)+1; this.workflow?.invalidateCampaign?.(id); const result=this.store.cancelOpportunityCampaign?.(id,this.now())||{cancelled:0,inProgress:0}; this.emit('change'); return result; }
  getDetail(id, actorId) { this._assert(actorId, 'view'); const result = this.evaluate(typeof id === 'object' ? id.id : id); return { ...result, origins: this.store.listOpportunityOrigins(result.opportunity.id), tasks: list(this.store.listOpportunityTasks({ opportunityId: result.opportunity.id, limit: 100 })) }; }
  getState(actorId) { this._assert(actorId, 'view'); const config = this._config(), catalog = this.listCampaignOffers(), queue = list(this.store.listOpportunityTasks({ status: 'queued', limit: 20 })); return { config, metrics: this.store.getOpportunityMetrics?.() || {}, campaignOffers: catalog.items, campaignOfferTotal: catalog.total, monitor: { enabled: config.enabled, mode: config.mode, connection: this.adapter?.status?.state || 'disconnected', suspended: this.suspended, blockedReason: this.blockedReason || null, lastMessageAt: this.lastMessageAt || null, lastProcessedAt: this.lastProcessedAt || null }, queue, queueState: { connected: this.adapter?.status?.state === 'connected', busy: Boolean(this.pump), nextAttemptAt: this.store.getNextOpportunityTaskAt?.() ?? (queue.length ? Math.min(...queue.map(task => task.nextAttemptAt || this.now())) : null), minSpacingMs: Math.max(3, this.adapter?.minimumSpacingSeconds || 3) * 1000, blockedReason: this.blockedReason || null }, index: { indexedAt: this.offerIndex?.indexedAt || null, parsedItems: this.offerParseCount } }; }
  _previewData(id, offerIds, actorId, expiresAt, options = {}) {
    if (options.manualCampaignSelection) return this._manualPreviewData(id, options.manualCampaignSelection, actorId, expiresAt, options);
    const { opportunity: op, candidates } = this.evaluate(id), c = this._config(), selected = offerIds.map(offerId => candidates.find(v => v.id === offerId));
    if (!offerIds.length || offerIds.length > c.multiModelMax || new Set(offerIds).size !== offerIds.length || selected.some(v => !v)) throw error('Selecione ofertas existentes e compatíveis.', 'OPPORTUNITY_SELECTION_INVALID');
    const warnings = [], blockers = this._blockers({ ...op, lastBlocker: null }, selected).filter(v => { if (options.reviewed === true && (v.code === 'REQUEST_CHANGED_REVIEW' || v.code === 'OP_REVIEW' || v.code === 'OP_EXPIRED' || v.code === 'REQUEST_EXPIRED' || v.code === 'REQUEST_CLOSED' && op.status === 'expired')) { warnings.push(v); return false; } return !['OFFER_ALREADY_SENT', 'OFFER_UPDATED_SENT', 'OP_OFFER_UPDATED', 'OP_OFFER_SENT', 'OP_OFFER_REPOST', 'OP_ALREADY_RESPONDED', 'OP_REPEAT', 'OP_UNCERTAIN', 'OP_PENDING', 'OP_INTERVAL', 'OP_DAILY_LIMIT'].includes(v.code) || options.duplicateRiskAcknowledged !== true; }); for (const offer of selected) if (!offer.eligible) { if (offer.compatible && offer.sentBefore && options.duplicateRiskAcknowledged === true) warnings.push(...offer.blockers); else blockers.push(...offer.blockers); }
    if (!op.recipient) blockers.push({ code: 'RECIPIENT_UNAVAILABLE', reason: 'Número real do interessado indisponível.' });
    const payload = [this._mode(), actorId, op.id, op.request?.intentKey, op.expiresAt, op.status, op.needsReview, selected.map(v => [v.id, v.offerRevision, v.availabilityConfirmedAt, v.quantityAvailable, v.available, v.campaignItemFingerprint, v.availabilitySource]), configHash(c), options.reviewed === true, options.duplicateRiskAcknowledged === true, expiresAt];
    return { opportunity: op, offers: selected, text: formatOpportunityResponse(op, selected), offerIds, blockers, warnings, reviewed: options.reviewed === true, duplicateRiskAcknowledged: options.duplicateRiskAcknowledged === true, canSend: !blockers.length, previewToken: `${expiresAt}:${hash(payload)}` };
  }
  preview(input, actorId) { this._assert(actorId, 'respond'); const id = typeof input === 'string' ? input : input.id; if (input.manualCampaignSelection) return this._manualPreviewData(id, input.manualCampaignSelection, actorId, this.now() + 5 * 60000, input); const details = this.evaluate(id); const ids = input.offerIds || details.candidates.filter(v => v.eligible).slice(0, 1).map(v => v.id); return this._previewData(id, ids, actorId, this.now() + 5 * 60000, input); }
  respondManual(input, actorId) {
    if (this.workflow && this._config().campaignDestinations === true) {
      const selection = input.manualCampaignSelection;
      if (!selection) throw error('Selecione o anúncio da campanha para enviar aos destinos cadastrados nela.', 'OPPORTUNITY_SELECTION_INVALID');
      return this.workflow.dispatch({ opportunityId: input.id, ...selection }, actorId);
    }
    this._assert(actorId, 'respond'); if (input.confirm !== true) throw error('Confirme a prévia antes de enviar.', 'OPPORTUNITY_CONFIRM_REQUIRED');
    const token = String(input.previewToken || ''), at = Number(token.split(':')[0]); if (!Number.isSafeInteger(at) || at < this.now() || at > this.now() + 5 * 60000) throw error('Prévia vencida; confira uma nova prévia.', 'OPPORTUNITY_PREVIEW_STALE');
    const preview = this._previewData(input.id, input.offerIds || [], actorId, at, input);
    const a = Buffer.from(token), b = Buffer.from(preview.previewToken); if (a.length !== b.length || !timingSafeEqual(a, b)) throw error('A oferta ou o pedido mudou; confira a nova prévia.', 'OPPORTUNITY_PREVIEW_STALE');
    if (!preview.canSend) throw error(preview.blockers[0]?.reason || 'Resposta bloqueada.', 'OPPORTUNITY_SEND_BLOCKED');
    const result = this.store.reserveOpportunitySend({ opportunityId: input.id, offerIds: preview.offerIds, recipient: preview.opportunity.recipient, clientId: `OPP-${randomUUID()}`, automatic: false, now: this.now(), actorId, reviewed: input.reviewed === true, allowExpired: input.reviewed === true, manualOverride: input.duplicateRiskAcknowledged === true, duplicateRiskAcknowledged: input.duplicateRiskAcknowledged === true, ...(preview.manualCampaignSelection ? { manualCampaignSelection: preview.manualCampaignSelection } : {}) });
    if (!result.ok) throw error(result.reason, result.code); this._schedulePump(); this.emit('change'); return result;
  }
  action(input, actorId) {
    const { id, action } = input; this._assert(actorId, ['outsideAnswer', 'close'].includes(action) ? 'respond' : 'manage'); const op = this.store.getOpportunity(id); if (!op) throw error('Oportunidade não encontrada.', 'OPPORTUNITY_NOT_FOUND'); let result;
    if (action === 'close') result = this.store.closeOpportunity(id, { now: this.now(), actorId, reason: 'Encerrada manualmente.' });
    else if (action === 'outsideAnswer') result = this.store.outsideAnswerOpportunity(id, { now: this.now(), actorId });
    else if (action === 'mute') { result = this.store.setOpportunityContactMute(op.senderKey, { muted: true, at: this.now(), actorId }); for (const task of list(this.store.listOpportunityTasks({ senderKey: op.senderKey, status: 'queued', limit: 1000 }))) this.store.updateOpportunityTask(task.id, { status: 'cancelled', code: 'CONTACT_MUTED', reason: 'Contato silenciado.', resultAt: this.now() }); }
    else if (action === 'reactivate') { this.store.setOpportunityContactMute(op.senderKey, { muted: false, at: this.now(), actorId }); result = this.store.reactivateOpportunity(id, { now: this.now(), actorId }); }
    else throw error('Ação inválida.', 'OPPORTUNITY_ACTION_INVALID');
    if (['close', 'outsideAnswer', 'mute'].includes(action)) this.workflow?.cancel?.(id, action);
    this._trace(id, 'manual', `OPPORTUNITY_${action.toUpperCase()}`, 'Ação manual registrada; controles anteriores preservados.', { opportunityId: id }); this.emit('change'); return result;
  }
  close(id, actorId) { return this.action({ id, action: 'close' }, actorId); }
  outsideAnswer(id, actorId) { return this.action({ id, action: 'outsideAnswer' }, actorId); }
  mute(id, actorId) { return this.action({ id, action: 'mute' }, actorId); }
  reactivate(id, actorId) { return this.action({ id, action: 'reactivate' }, actorId); }
  confirmAvailable(input, actorId) { this._assert(actorId, 'manage'); const id = input.offerId || input.id; if (input.quantity !== undefined && (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 10000)) throw error('Quantidade disponível inválida.', 'OPPORTUNITY_AVAILABILITY_INVALID'); const result = this.store.confirmOpportunityOfferAvailable(id, { at: this.now(), quantity: input.quantity, unitReference: input.unitReference, actorId }); this.offerIndex = null; this.emit('change'); return result; }
  _expire() { if (this.store.expireOpportunities) return this.store.expireOpportunities(this.now()); for (const op of list(this.store.listOpportunities({ status: ['open', 'queued'], limit: 1000 }))) if (op.expiresAt <= this.now()) { this.store.updateOpportunity(op.id, { status: 'expired', updatedAt: this.now() }); for (const task of list(this.store.listOpportunityTasks({ opportunityId: op.id, status: 'queued', limit: 1000 }))) this.store.updateOpportunityTask(task.id, { status: 'cancelled', code: 'OP_EXPIRED', reason: 'Pedido expirado.', resultAt: this.now() }); } }
  _armPump() {
    clearTimeout(this.dueTimer); this.dueTimer = null;
    if (!this.started || this.closed || this.suspended || this.store.persistenceFailed || this.adapter?.status?.state !== 'connected' || this.isAutomationStopped()) return;
    const next = this.store.getNextOpportunityTaskAt?.() ?? (() => { const tasks = list(this.store.listOpportunityTasks({ status: 'queued', limit: 1000 })); return tasks.length ? Math.min(...tasks.map(task => task.nextAttemptAt || this.now())) : null; })();
    if (next == null) return;
    this.dueTimer = setTimeout(() => { this.dueTimer = null; this._schedulePump(); }, Math.max(1, Math.min(2147483647, next - this.now()))); this.dueTimer.unref?.();
  }
  _schedulePump() { if (this.workflow && this._config().campaignDestinations === true) return this.pump; if (this.pump) { this.pumpAgain = true; return this.pump; } if (!this.started || this.closed || this.suspended || this.store.persistenceFailed || this.adapter?.status?.state !== 'connected' || this.isAutomationStopped()) return this.pump; clearTimeout(this.dueTimer); this.dueTimer = null; this.pump = Promise.resolve().then(() => this._drain()).catch(e => this._failure(e)).finally(() => { this.pump = null; const again = this.pumpAgain; this.pumpAgain = false; if (again) queueMicrotask(() => this._schedulePump()); else this._armPump(); }); return this.pump; }
  async waitForIdle() { await this.pump; if (!this.closed && !this.suspended && !this.isAutomationStopped() && this.adapter?.status?.state === 'connected') { this._schedulePump(); await this.pump; } }
  async _drain() {
    this._expire();
    for (const task of list(this.store.listOpportunityTasks({ status: 'queued', dueAt: this.now(), limit: 100 }))) {
      if (this.closed || this.suspended || this.isAutomationStopped() || this.adapter?.status?.state !== 'connected') break;
      if (task.nextAttemptAt > this.now()) continue;
      await this._sendTask(task);
    }
  }
  _finalGuard(task, adapter, mode, beforeSubmit) {
    try { beforeSubmit?.(); if (this.closed || this.suspended || this.store.persistenceFailed || adapter !== this.adapter || mode !== this._mode() || this.isAutomationStopped() || adapter.status?.state !== 'connected') throw error('Envio interrompido por mudança de conexão ou controles.', 'OPPORTUNITY_SEND_BLOCKED', { definitive: true, submitted: false, safeToRetry: false });
    const config = this._config(); this._assert(task.actorId || config.ownerId, 'respond'); if (task.automatic && this.assertOwnerPermissions(config.ownerId, 'automatic') === false) throw error('Permissão automática removida.', 'OPPORTUNITY_FORBIDDEN', { definitive: true, submitted: false });
    const manualOffer = task.automatic === false && task.manualCampaignSelection ? this._manualOffer(task.manualCampaignSelection) : null;
    const guarded = this.store.finalGuardOpportunitySend(task.id, { now: this.now(), automationAllowed: !this.isAutomationStopped(), allowExpired: task.allowExpired === true && task.reviewed === true, reviewed: task.reviewed === true }); if (!guarded.ok) throw error(guarded.reason, guarded.code, { definitive: true, submitted: false, safeToRetry: false });
    if (manualOffer) {
      const snapshot = task.offerSnapshots?.find(row => row.id === manualOffer.id);
      if (task.offerIds?.length !== 1 || task.offerIds[0] !== manualOffer.id || !snapshot || snapshot.offerRevision !== manualOffer.offerRevision) throw error('O anúncio mudou depois da prévia; revise antes de enviar.', 'OPPORTUNITY_OFFER_CHANGED', { definitive: true, submitted: false });
      return guarded;
    }
    const op = this.store.getOpportunity(task.opportunityId), candidates = this._candidates(op);
    for (const id of task.offerIds || []) { const offer = candidates.find(v => v.id === id); if (!offer?.compatible || offer.offerRevision !== task.offerSnapshots?.find(v => v.id === id)?.offerRevision && task.offerSnapshots) throw error('A oferta mudou ou não está mais elegível; revise.', 'OPPORTUNITY_OFFER_CHANGED', { definitive: true, submitted: false }); }
    return guarded; } catch (e) { e.definitive = true; e.submitted = false; e.safeToRetry = false; throw e; }
  }
  _deadlineMs() { return this.scheduler?.getAttemptTimeoutMs?.() || Math.max(5, Math.min(300, Number(this.store.getSetting('submissionTimeoutSeconds', 30)) || 30)) * 1000; }
  async _bounded(work, options = {}) {
    if (this.scheduler?.runBoundedAttempt) return this.scheduler.runBoundedAttempt(work, { timeoutMs: this._deadlineMs(), ...options });
    const controller = new AbortController(); this.controllers.add(controller); const signal = controller.signal; let timer, finished = false;
    const pending = Promise.resolve().then(() => work({ signal, timeoutMs: this._deadlineMs(), beforeSubmit: () => { if (signal.aborted) throw error('Tempo de envio encerrado.', 'SUBMISSION_ABORTED', { submitted: false, definitive: true }); } }));
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { finished = true; controller.abort(); reject(error('Tempo de envio excedido.', 'SUBMISSION_TIMEOUT', { submitted: 'unknown' })); }, this._deadlineMs()); });
    pending.then(result => { if (finished) options.onLateResult?.(result); }, e => { if (finished) options.onLateError?.(e); });
    try { return await Promise.race([pending, timeout]); } finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  async _sendTask(task) {
    const adapter = this.adapter, mode = this._mode(); let enteredSending = false;
    const work = async outer => {
      this._finalGuard(task, adapter, mode, outer.beforeSubmit);
      const minimum = Math.max(3, adapter.minimumSpacingSeconds || 3) * 1000, last = this.scheduler?.lastSubmissionAt;
      if (last != null && this.now() - last < minimum) await this.sleep(minimum - (this.now() - last));
      const resolved = await this._bounded(ctx => { this._finalGuard(task, adapter, mode, () => { ctx.beforeSubmit(); outer.beforeSubmit?.(); }); return adapter.resolveRecipient(task.recipient, { ...ctx, traceId: task.id }); }, { signal: outer.signal });
      if (!resolved?.jid || !normalizePhone(task.recipient) || resolved.phone && normalizePhone(resolved.phone) !== normalizePhone(task.recipient) || /@g\.us$/.test(resolved.jid)) throw error('Destinatário privado não pôde ser resolvido com segurança.', 'OPPORTUNITY_RECIPIENT_INVALID', { definitive: true, submitted: false });
      this._finalGuard(task, adapter, mode, outer.beforeSubmit);
      const claim = this.store.claimOpportunityTask?.(task.id, { now: this.now() }); if (claim && !claim.ok) throw error(claim.reason, claim.code, { definitive: true, submitted: false });
      if (!claim) this.store.updateOpportunityTask(task.id, { status: 'sending', attempts: (task.attempts || 0) + 1, submittedAt: this.now(), resolvedRecipient: resolved.jid });
      if (claim?.ok) this.store.updateOpportunityTask(task.id, { resolvedRecipient: resolved.jid });
      enteredSending = true; task = this.store.getOpportunityTask(task.id); const op = this.store.getOpportunity(task.opportunityId), offers = (task.offerIds || []).map(id => this.store.getOpportunityOffer(id));
      const text = task.manualCampaignSelection ? offers[0]?.rawText || '' : formatOpportunityResponse(op, offers); if (text.length > 16000) throw error('Prévia excede o limite de mensagem; reduza as opções.', 'OPPORTUNITY_TEXT_TOO_LONG', { definitive: true, submitted: false });
      this._trace(task.id, 'sending', 'OPPORTUNITY_SENDING', 'Envio privado iniciado.', { taskId: task.id, opportunityId: task.opportunityId, recipient: resolved.jid, attempts: task.attempts });
      if (this.scheduler) this.scheduler.lastSubmissionAt = this.now();
      return this._bounded(ctx => { const beforeSubmit = () => this._finalGuard(task, adapter, mode, () => { ctx.beforeSubmit(); outer.beforeSubmit?.(); }); beforeSubmit();
        const options = { clientMessageId: task.clientMessageId || task.clientId, traceId: task.id, beforeSubmit, signal: ctx.signal, timeoutMs: ctx.timeoutMs };
        const offer = offers.length === 1 && offers[0], campaign = offer && this.store.getCampaign(offer.campaignId), item = campaign?.items?.find(row => row.id === offer.itemId);
        if ((offer?.singleItemOffer || task.manualCampaignSelection) && ['image', 'video', 'document'].includes(item?.type) && typeof adapter.sendPrivateContent === 'function') {
          const media = this.store.getMedia?.(item.mediaId); if (!media) throw error('A mídia do anúncio não está disponível; revise a campanha.', 'OPPORTUNITY_MEDIA_MISSING', { definitive: true, submitted: false });
          return adapter.sendPrivateContent(resolved.jid, { ...item, caption: text }, media, options);
        }
        return adapter.sendSearchText(resolved.jid, text, options);
      }, { signal: outer.signal, onLateResult: proof => this._proof(task.id, proof, adapter, mode), onLateError: e => { if (e.definitive && e.submitted === false) this._proof(task.id, { status: 'failed', confirmedFailure: true, code: e.code }, adapter, mode); } });
    };
    try {
      const proof = this.scheduler?.runExternalSubmission ? await this.scheduler.runExternalSubmission(work, { manual: task.automatic === false, timeoutMs: 2 * this._deadlineMs() + 10000 }) : await work({ beforeSubmit: () => {} });
      if (proof?.status === 'failed' && proof.confirmedFailure) throw error(proof.reason || 'A integração recusou a mensagem.', proof.code || 'OPPORTUNITY_SEND_REJECTED', { definitive: true, confirmedFailure: true, submitted: false, safeToRetry: proof.safeToRetry });
      if (!this._proof(task.id, proof, adapter, mode)) this.store.updateOpportunityTask(task.id, { status: 'uncertain', resultAt: this.now(), code: 'OPPORTUNITY_RESULT_UNCERTAIN', reason: 'Envio anterior com resultado incerto.', safeToRetry: false });
    } catch (e) {
      const current = this.store.getOpportunityTask(task.id); if (!current || ['accepted', 'delivered', 'cancelled'].includes(current.status)) return;
      const known = !enteredSending || e.confirmedFailure === true || e.definitive === true && e.submitted === false || e.safeToRetry === true && e.submitted === false;
      const config = this._config(), attempts = Math.max(current.attempts || 0, enteredSending ? task.attempts || 1 : (task.attempts || 0) + 1), retry = known && e.safeToRetry === true && attempts <= config.retryMax;
      this.store.updateOpportunityTask(task.id, { status: retry ? 'queued' : known ? 'failed' : 'uncertain', attempts, resultAt: this.now(), code: e.code || 'OPPORTUNITY_SEND_ERROR', reason: known ? e.message : 'Envio anterior com resultado incerto.', safeToRetry: known, nextAttemptAt: retry ? this.now() + config.retryIntervalSeconds * 1000 * 2 ** (attempts - 1) : null });
      this._trace(task.id, 'result', e.code || 'OPPORTUNITY_SEND_ERROR', known ? e.message : 'Resultado incerto: não haverá reenvio automático.', { taskId: task.id, status: retry ? 'queued' : known ? 'failed' : 'uncertain', attempts });
    } finally { this.emit('change'); }
  }
  _proof(taskId, proof, adapter = this.adapter, mode = this._mode()) {
    if (!proof || adapter !== this.adapter || mode !== this._mode()) return false; const task = this.store.getOpportunityTask(taskId); if (!task) return false;
    if (proof.status === 'failed' && proof.confirmedFailure === true && !['accepted', 'delivered'].includes(task.status)) { if (task.status !== 'failed') this.store.updateOpportunityTask(taskId, { status: 'failed', resultAt: task.resultAt || this.now(), code: proof.code || 'OPPORTUNITY_CONFIRMED_FAILURE', reason: 'A integração confirmou a falha.', safeToRetry: false, proof: true, proofAccepted: true }); return true; }
    if (!accepted(proof)) return false;
    if (task.messageId && task.messageId !== proof.messageId && task.clientMessageId !== proof.messageId && task.clientId !== proof.messageId) return false;
    const delivered = ['delivered', 'read'].includes(proof.status) || proof.deliveredAt || proof.delivered === true || ['whatsapp-delivered', 'whatsapp-read'].includes(proof.confirmationScope);
    const read = proof.status === 'read' || proof.confirmationScope === 'whatsapp-read';
    // A synchronous ACK and the completion of the same promise are one proof.
    // Ignore repeated/weaker receipts rather than rewriting timestamps, logging
    // another acceptance or downgrading an already delivered message.
    if (['accepted', 'delivered'].includes(task.status) && (!delivered || task.status === 'delivered') && (!read || task.confirmationScope === 'whatsapp-read')) return true;
    this.store.updateOpportunityTask(taskId, { status: delivered ? 'delivered' : 'accepted', messageId: proof.messageId || task.messageId, acceptedAt: task.acceptedAt || proof.acceptedAt || this.now(), deliveredAt: task.deliveredAt || proof.deliveredAt || (delivered ? this.now() : null), resultAt: task.resultAt || this.now(), confirmationScope: read ? 'whatsapp-read' : proof.confirmationScope || (delivered ? 'whatsapp-delivered' : 'integration-ack'), reason: null, code: null, safeToRetry: false, proof: true, proofAccepted: true });
    this._trace(taskId, 'result', delivered ? 'OPPORTUNITY_DELIVERED' : 'OPPORTUNITY_ACCEPTED', delivered ? 'Entrega confirmada pela integração.' : 'Envio aceito pela integração; entrega não presumida.', { taskId, status: delivered ? 'delivered' : 'accepted', messageId: proof.messageId }); this.emit('change'); return true;
  }
  _receipt(proof) { if (!proof?.messageId || proof.mode && proof.mode !== this._mode() || proof.simulation === true && this._mode() !== 'simulated') return; const tasks = list(this.store.listOpportunityTasks({ messageId: proof.messageId, limit: 100 })); for (const task of tasks) if ([task.messageId, task.clientMessageId, task.clientId].includes(proof.messageId)) this._proof(task.id, proof); }
  async reconcile(input, actorId) { this._assert(actorId, 'respond'); const task = this.store.getOpportunityTask(input.taskId || input.id || input); if (!task) throw error('Envio não encontrado.', 'OPPORTUNITY_TASK_NOT_FOUND'); if (task.status !== 'uncertain') return task;
    const adapter = this.adapter, mode = this._mode(); if (adapter?.status?.state !== 'connected') throw error('Reconecte o WhatsApp para verificar o envio.', 'DISCONNECTED');
    const proof = adapter.reconcile ? await this._bounded(ctx => adapter.reconcile(task.messageId || task.clientMessageId || task.clientId, { ...ctx, chatId: task.resolvedRecipient, traceId: task.id })) : null;
    this._proof(task.id, proof, adapter, mode); return this.store.getOpportunityTask(task.id);
  }
  async retryUncertain(input, actorId) { this._assert(actorId, 'respond'); const task = this.store.getOpportunityTask(input.taskId || input.id); if (!task || task.status !== 'uncertain') throw error('Selecione um envio incerto.', 'OPPORTUNITY_TASK_NOT_UNCERTAIN'); await this.reconcile({ id: task.id }, actorId); if (this.store.getOpportunityTask(task.id).status !== 'uncertain') return { reconciled: true, task: this.store.getOpportunityTask(task.id) };
    if (input.duplicateRiskAcknowledged !== true || input.confirm !== true) throw error('Este envio pode ter ocorrido. Confirme o risco de duplicação.', 'OPPORTUNITY_DUPLICATE_RISK_REQUIRED');
    const result = this.store.reserveOpportunitySend({ opportunityId: task.opportunityId, offerIds: task.offerIds, recipient: task.recipient, clientId: `OPPR-${hash([this._mode(), task.id])}`, automatic: false, now: this.now(), actorId, manualOverride: true, duplicateRiskAcknowledged: true, retryOf: task.id, ...(task.manualCampaignSelection ? { manualCampaignSelection: task.manualCampaignSelection } : {}) });
    if (!result.ok) throw error(result.reason, result.code); this._schedulePump(); this.emit('change'); return result;
  }
  _notify(op) { const registered = this.store.registerOpportunityNotification([op.id], { now: this.now(), kind: 'compatible' }); if (registered === false || registered?.inserted === false || registered?.newIds && !registered.newIds.length) return;
    this.notifyIds.add(op.id); if (!this.notifyTimer) { this.notifyTimer = setTimeout(() => { this.notifyTimer = null; this._flushNotifications(); }, this._config().sound.burstSeconds * 1000); this.notifyTimer.unref?.(); }
  }
  _flushNotifications() { if (!this.notifyIds.size || this.closed) return; const ids = [...this.notifyIds]; this.notifyIds.clear(); const c = this._config(), now = this.now(), clock = new Intl.DateTimeFormat('pt-BR', { timeZone: c.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now), q = c.sound.quiet;
    const quiet = q.enabled && (q.start === q.end || (q.start < q.end ? clock >= q.start && clock < q.end : clock >= q.start || clock < q.end));
    const last = this.store.getSetting('opportunitiesLastSoundAt', 0), sound = c.sound.enabled && !quiet && now - last >= c.sound.minIntervalSeconds * 1000;
    if (sound) this.store.setSetting('opportunitiesLastSoundAt', now);
    this.onLocalAlert({ id: randomUUID(), kind: 'opportunity', opportunityIds: ids, count: ids.length, title: 'Novas oportunidades', body: `${ids.length} oportunidade${ids.length === 1 ? '' : 's'} compatível${ids.length === 1 ? '' : 'is'} encontrada${ids.length === 1 ? '' : 's'}.`, sound: { ...c.sound, enabled: sound }, at: now });
    this.emit('change');
  }
}
function configHash(c) { return hash({ enabled: c.enabled, automatic: c.automatic, evaluation: c.evaluation, repeatHours: c.repeatHours, contactIntervalMinutes: c.contactIntervalMinutes, maxPerDay: c.maxPerDay, validityMinutes: c.validityMinutes, availabilityMaxAgeMinutes: c.availabilityMaxAgeMinutes, availabilityMode: c.availabilityMode, campaignIds: c.campaignIds, monitoredGroupIds: c.monitoredGroupIds }); }
module.exports = { OpportunityService, normalizeOpportunityConfig, formatOpportunityResponse, localDay };
