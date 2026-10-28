'use strict';

// All monetary inputs are integer cents. Captured offers are untrusted data and
// are never interpreted as configuration, authorization, or execution requests.
const { EventEmitter } = require('node:events');
const { randomUUID, createHash } = require('node:crypto');
const { parseQuery, rankOffers } = require('./search-parser.cjs');
const { localEpoch, nextOccurrence, previousOccurrence } = require('./reminders.cjs');
const { normalizeMarkup, calculateMarkup, publicFacts, formatPublicLines } = require('./commercial.cjs');

const MINUTE = 60000;
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const failure = (message, code = 'COMMERCE_INVALID') => Object.assign(new Error(message), { code, definitive: true, safeToRetry: false });
const phone = value => String(value || '').replace(/[\s()+.-]/g, '');
const validPhone = value => /^[1-9]\d{9,14}$/.test(value);
const rows = value => Array.isArray(value) ? value : value?.items || [];
const safeText = value => String(value || '').slice(0, 500).replace(/(Bearer\s+)[\w.-]+/gi, '$1[omitido]').replace(/((?:senha|password|token|secret|authorization|credential)\s*[:=]\s*)[^\s,;]+/gi, '$1[omitido]');
const money = cents => Number.isSafeInteger(cents) ? (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : 'não informado';
const formatAt = (at, timezone = 'America/Sao_Paulo') => new Date(at).toLocaleString('pt-BR', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' });
function financialSnapshot(report = {}) {
  const fields = ['date','timezone','saleCount','soldQuantity','grossCents','totalCents','discountCents','cancellationCount','cancellationCents','knownCostCents','unknownCostCount','feesCents','directExpensesCents','cancellationLossCents','estimatedProfitCents','realizedProfitCents','generalExpensesCents','receivedByMethod','refundedByMethod','receivedCents','refundCents','priorSaleReceiptsCents','unallocatedDepositsCents','pendingCents','refundPendingCents','audience','note'];
  const result = Object.fromEntries(fields.filter(key => report[key] !== undefined).map(key => [key, structuredClone(report[key])]));
  result.products = (report.products || report.items || []).map(item => Object.fromEntries(['model','storage','color','condition','kind','quantity','totalCents'].filter(key => item[key] !== undefined).map(key => [key,item[key]])));
  result.cashSessions = (report.cashSessions || []).map(session => Object.fromEntries(['status','expectedCashCents','countedCashCents','differenceCents'].filter(key => session[key] !== undefined).map(key => [key,session[key]])));
  return result;
}
function integer(value, fallback, min, max, label) {
  const result = value == null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw failure(`${label} inválido.`);
  return result;
}
function dateKey(at, timezone = 'America/Sao_Paulo') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function validateDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T12:00:00Z`)) || new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) !== value) throw failure('Informe uma data válida no formato AAAA-MM-DD.');
  return value;
}
function markupCost(costCents, markup = {}) {
  integer(costCents, 0, 1, 100000000000, 'Custo');
  const type = markup.type || markup.kind || 'fixed';
  const normalized = normalizeMarkup({ ...markup, type, ...(markup.fixedCents != null ? { valueCents: markup.fixedCents } : {}), ...(markup.percentBasisPoints != null ? { basisPoints: markup.percentBasisPoints } : {}) });
  const calculated = calculateMarkup(costCents, normalized);
  return { ...calculated, kind: normalized.type, fixedCents: normalized.valueCents || 0, percentBasisPoints: normalized.basisPoints || 0, finalPriceCents: calculated.priceCents };
}
function publicDemandText(offer, finalPriceCents) {
  return formatPublicLines([{ facts: publicFacts(offer), priceCents: finalPriceCents, quantity: 1, availability: 'sob encomenda' }], 'retail', 'Proposta revisada');
}
function opportunityText(offer, rule, pricing, timezone = 'America/Sao_Paulo') {
  const forwarded = offer.forwarded === true && offer.originalSupplierKnown !== true;
  const heading = pricing ? '🔎 APARELHO PROCURADO — OFERTA ENCONTRADA' : '💡 ALERTA DE OPORTUNIDADE';
  return [heading, `📌 ${rule.name || rule.buyerName || 'Busca monitorada'}`, `📱 ${offer.model}${offer.storageGB ? ` • ${offer.storageGB} GB` : ''}`, offer.color ? `🎨 Cor: ${offer.color}` : null, offer.condition ? `📦 Condição: ${offer.condition}` : null, `💰 Preço anunciado: ${money(offer.priceCents)}`, pricing ? `🏷️ Venda com acréscimo sobre o custo: ${money(pricing.finalPriceCents)}` : null, pricing ? `🎯 Orçamento: ${money(rule.budgetCents)}` : null, `👤 ${forwarded ? 'Republicador; fornecedor original desconhecido' : 'Fornecedor'}: ${offer.supplierName || 'Nome indisponível'}`, `📞 ${forwarded ? 'Número do republicador' : 'WhatsApp'}: ${validPhone(phone(offer.supplierPhone)) ? '+' + phone(offer.supplierPhone) : 'Número indisponível'}`, offer.offerPhone && validPhone(phone(offer.offerPhone)) ? `📞 Contato informado na oferta: +${phone(offer.offerPhone)}` : null, `👥 Grupo: ${offer.groupName || 'Grupo indisponível'}`, `📅 Publicado em: ${formatAt(offer.originalAt || offer.messageAt, timezone)}`, `📝 Oferta original: ${String(offer.snippet || offer.originalExcerpt || '').slice(0, 1400)}`, pricing ? '🔒 O comprador não recebeu esta mensagem. Revise e aprove a proposta no aplicativo.' : 'Valores conforme anúncios capturados. Confirme disponibilidade e condições com o fornecedor.'].filter(Boolean).join('\n');
}

// FinanceService supplies this text from its transactional ledger. The fallback
// formats named totals only; missing fields are explicitly absent, never zero.
function formatDailyReport(report, { date, version = 1, updated = false } = {}) {
  if (typeof report?.text === 'string' && report.text) return `${updated ? `🔄 VERSÃO ATUALIZADA ${version}\n` : ''}${report.text}`;
  const totals = report?.totals || report || {};
  const lines = [`📊 *RELATÓRIO DIÁRIO — ${date}*${updated ? `\n🔄 Versão atualizada ${version}` : ''}`, '', '🛍️ VENDAS REALIZADAS NA DATA'];
  const items = report?.items || report?.products || [];
  if (!items.length && (totals.saleCount === 0 || totals.salesCount === 0)) lines.push('Nenhuma venda registrada nesta data.');
  for (const item of items) lines.push(`• ${[item.model || item.name || item.productName || 'Produto',item.storage,item.color,item.condition].filter(Boolean).join(' • ')} — ${item.quantity || 1} un. — ${money(item.totalCents ?? item.revenueCents)}`);
  for (const [label, key] of [['Vendas após descontos', 'totalCents'], ['Descontos', 'discountCents'], ['Cancelamentos', 'cancellationCents'], ['Custo conhecido dos produtos vendidos', 'knownCostCents'], ['Taxas', 'feesCents'], ['Despesas vinculadas', 'directExpensesCents'], ['Perdas de cancelamentos', 'cancellationLossCents'], ['Lucro estimado', 'estimatedProfitCents'], ['Lucro realizado', 'realizedProfitCents'], ['Despesas gerais, separadas', 'generalExpensesCents'], ['Valores pendentes', 'pendingCents']]) lines.push(`${label}: ${money(totals[key])}`);
  if (totals.unknownCostCount > 0) lines.push(`⚠️ ${totals.unknownCostCount} item(ns) com custo desconhecido: lucro não confirmado.`);
  lines.push('', '💳 RECEBIMENTOS EFETIVOS NA DATA');
  const payments = report?.receiptsByMethod || report?.receivedByMethod || {};
  for (const [method, amount] of Object.entries(payments)) lines.push(`• ${{cash: 'Dinheiro', pix: 'Pix', debit: 'Débito', credit: 'Crédito'}[method] || method}: ${money(typeof amount === 'number' ? amount : amount?.amountCents)}`);
  if (report?.priorSaleReceiptsCents != null) lines.push(`Recebimentos de vendas anteriores: ${money(report.priorSaleReceiptsCents)}`);
  if (report?.refundCents) lines.push(`Estornos financeiros na data: ${money(report.refundCents)}`);
  if (report?.unallocatedDepositsCents) lines.push(`Sinais recebidos ainda sem venda: ${money(report.unallocatedDepositsCents)}`);
  for (const [audience, details] of Object.entries(report?.audience || report?.audiences || {})) lines.push(`${audience === 'retail' ? 'Varejo' : audience === 'wholesale' ? 'Atacado' : audience}: ${money(details.totalCents)} • lucro realizado ${money(details.realizedProfitCents)} • estimado ${money(details.estimatedProfitCents)}`);
  for (const session of report?.cashSessions || []) lines.push('', `💵 Caixa: ${session.status === 'closed' ? 'fechado' : session.status === 'open' ? 'aberto' : session.status || 'sem abertura'}`, `Dinheiro esperado: ${money(session.expectedCashCents)}`, ...(session.differenceCents != null ? [`Diferença: ${money(session.differenceCents)}`] : []));
  if (report?.cash) lines.push('', `💵 Caixa: ${report.cash.status === 'closed' ? 'fechado' : report.cash.status === 'open' ? 'aberto' : report.cash.status || 'sem abertura'}`, `Dinheiro esperado: ${money(report.cash.expectedCents)}`, ...(report.cash.differenceCents != null ? [`Diferença: ${money(report.cash.differenceCents)}`] : []));
  lines.push('', 'Faturamento, lucro, recebimentos e dinheiro físico são valores diferentes.', 'Kenned Code Disparos');
  return lines.join('\n');
}

class CommerceAutomation extends EventEmitter {
  constructor({ store, auth, scheduler, adapter, searches, finance, commercial, now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), isAutomationStopped = () => false, onCriticalIncident } = {}) {
    super(); Object.assign(this, { store, auth, scheduler, adapter, searches, finance, commercial, now, sleep, isAutomationStopped, onCriticalIncident });
    this.started = false; this.closed = false; this.suspended = false; this.timer = null; this.ticking = null; this.flushing = null; this.offerDirty = true; this.lastOfferScanAt = 0; this.adapterRevision = 0; this.inFlight = new Set();
    this.searchListener = () => { this.offerDirty = true; this._backgroundTick(); };
    this.statusListener = status => { if (status?.state === 'connected') this._backgroundTick(); };
    this.receiptListener = receipt => this._receipt(receipt);
  }
  _mode() { return this.adapter?.status?.mode === 'simulated' ? 'simulated' : 'whatsapp'; }
  _blocked() { return this.closed || this.suspended || this.store.persistenceFailed || this.scheduler?.persistenceFailed || this.isAutomationStopped() === true; }
  _assert(actorId, permission = 'commerce.manage') { if (!actorId || !this.auth?.assertFor) throw failure('Autenticação necessária.', 'AUTH_REQUIRED'); if (permission === 'finance.reports') this.auth.assertFor(actorId, 'finance.view'); return this.auth.assertFor(actorId, permission); }
  _list(table, filter = {}) { return rows(this.store.listEntities(table, filter)); }
  _get(table, id) { return this.store.getEntity(table, id); }
  _save(table, value) { try { return this.store.saveEntity(table, value); } catch (error) { this.scheduler?.blockOnPersistenceFailure?.(); throw error; } }
  _audit(action, subjectId, actorId) { this.store.addAudit?.({ id: randomUUID(), at: this.now(), action, subjectId, userId: actorId }); }
  _trace(value, stage, code, description, action) { this.store.addDiagnostic?.({ id: randomUUID(), at: this.now(), traceId: value.traceId || value.id, userId: value.actorId || value.userId || null, stage: `comercio.${stage}`, code, description: safeText(description), action: safeText(action), attempts: value.attempts || 0, integrationMode: this._mode(), simulation: this._mode() === 'simulated', guidance: 'Confira conexão, destinatário autorizado e permissões. Envios incertos exigem revisão antes de repetir.' }); }
  _fatal(error) { if (this.store.persistenceFailed) this.scheduler?.blockOnPersistenceFailure?.(); this.onCriticalIncident?.({ id: randomUUID(), at: this.now(), event: 'critical', code: /^[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'COMMERCE_PROCESSING_ERROR', reason: 'Falha no processamento comercial. Consulte o diagnóstico.' }); }
  _backgroundTick() { if (!this.closed && !this.suspended) void this.tick().catch(error => this._fatal(error)); }
  _recipient(id, permission = 'commerce.manage') {
    if (typeof id !== 'string') throw failure('Selecione um destinatário administrador autorizado.', 'COMMERCE_RECIPIENT_INVALID');
    let user, recipient;
    if (id.startsWith('user:')) user = this._get('users', id.slice(5));
    else {
      recipient = this._get('alert_recipients', id.replace(/^alertrecipient:/, ''));
      if (recipient?.enabled === false) throw failure('Destinatário desativado.', 'COMMERCE_RECIPIENT_DISABLED');
      user = this._list('users').find(candidate => candidate.active !== false && validPhone(phone(candidate.phone)) && phone(candidate.phone) === phone(recipient?.phone) && this._can(candidate.id, permission));
    }
    if (!user || user.active === false || !validPhone(phone(user.phone))) throw failure('O destinatário precisa estar vinculado a um administrador ativo com telefone completo.', 'COMMERCE_RECIPIENT_DISABLED');
    this._assert(user.id, permission);
    return { id, userId: user.id, phone: phone(user.phone), name: user.name || 'Administrador' };
  }
  _can(actorId, permission) { try { this._assert(actorId, permission); return true; } catch { return false; } }
  _recipients(ids, permission = 'commerce.manage') {
    if (!Array.isArray(ids) || !ids.length || ids.length > 20) throw failure('Selecione de 1 a 20 destinatários administradores.');
    const found = new Map();
    for (const id of [...new Set(ids)]) { const recipient = this._recipient(id, permission); found.set(recipient.phone, recipient); }
    return [...found.values()];
  }
  _groups(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000) throw failure('Selecione ao menos um grupo monitorado.');
    const monitored = new Set(this.store.getSetting('buscasSettings', {})?.monitoredGroupIds || []);
    const groups = new Map((this.store.listGroups?.() || []).map(group => [group.id, group]));
    for (const id of ids) { const group = groups.get(id); if (typeof id !== 'string' || !group || group.available === false || !monitored.has(id) || Boolean(group.simulation) !== (this._mode() === 'simulated')) throw failure('Use somente grupos disponíveis e selecionados para monitoramento em BUSCAS.', 'COMMERCE_GROUP_INVALID'); }
    return [...new Set(ids)];
  }
  _queryFields(value) {
    const text = [value.model || '', value.storageGB ? `${value.storageGB}GB` : '', value.color || '', value.condition || ''].filter(Boolean).join(' ');
    const parsed = parseQuery(text, { aliases: this.store.getSetting('buscasSettings', {})?.aliases });
    if (!parsed.valid || !parsed.modelKey) throw failure(parsed.errors?.[0] || 'Informe um modelo e uma versão válidos.');
    return parsed;
  }
  _cancelKind(kind, sourceId, code = 'COMMERCE_RULE_CHANGED') {
    let count = 0;
    for (const delivery of this._list('commerce_deliveries', { status: 'pending', kind })) if (delivery.sourceId === sourceId) { this._save('commerce_deliveries', { ...delivery, status: 'cancelled', resultAt: this.now(), code, error: 'Configuração alterada ou interrompida antes do envio.' }); count++; }
    return count;
  }
  saveOpportunity(input, actorId) {
    this._assert(actorId);
    if (!input || typeof input !== 'object') throw failure('Informe os dados da busca monitorada.');
    const previous = input.id ? this._get('opportunity_rules', input.id) : null;
    if (input.id && !previous) throw failure('Regra não encontrada.');
    if (!previous && this._list('opportunity_rules', { status: 'active' }).length >= 100) throw failure('Limite de 100 regras ativas alcançado.');
    const value = { ...previous, ...input }, parsed = this._queryFields(value);
    const name = String(value.name || parsed.model).trim(); if (!name || name.length > 120) throw failure('Informe um nome de até 120 caracteres.');
    const recipients = this._recipients(value.recipientIds);
    const rule = { id: previous?.id || randomUUID(), name, model: parsed.model, modelKey: parsed.modelKey, storageGB: parsed.storageGB, condition: parsed.condition, color: parsed.color, colorKey: parsed.colorKey, maxPriceCents: integer(value.maxPriceCents, 0, 1, 100000000000, 'Preço máximo'), groupIds: this._groups(value.groupIds), maxAgeMinutes: integer(value.maxAgeMinutes, 120, 1, 43200, 'Validade da oferta'), recipientIds: recipients.map(recipient => recipient.id), enabled: value.enabled !== false, status: value.enabled === false ? 'paused' : 'active', maxAttempts: integer(value.maxAttempts, 3, 1, 5, 'Número de tentativas'), retrySeconds: integer(value.retrySeconds, 60, 3, 86400, 'Intervalo de tentativa'), revision: (previous?.revision || 0) + 1, actorId, createdAt: previous?.createdAt || this.now(), updatedAt: this.now() };
    const saved = this.store.transaction(() => { if (previous) this._cancelKind('opportunity', previous.id); const record = this._save('opportunity_rules', rule); this._audit('opportunity.saved', rule.id, actorId); return record; });
    this.offerDirty = true; this.emit('change'); return saved;
  }
  setOpportunityState(id, enabled, actorId) { this._assert(actorId); const rule = this._get('opportunity_rules', id); if (!rule || rule.status === 'deleted') throw failure('Regra não encontrada.'); return this.saveOpportunity({ ...rule, enabled: enabled === true }, actorId); }
  deleteOpportunity(id, actorId) { this._assert(actorId); const rule = this._get('opportunity_rules', id); if (!rule) throw failure('Regra não encontrada.'); return this.store.transaction(() => { this._cancelKind('opportunity', id); this._save('opportunity_rules', { ...rule, enabled: false, status: 'deleted', deletedAt: this.now(), deletedBy: actorId }); this._audit('opportunity.deleted', id, actorId); this.emit('change'); return { deleted: true }; }); }
  saveDemand(input, actorId) {
    this._assert(actorId);
    if (!input || typeof input !== 'object') throw failure('Informe os dados do aparelho procurado.');
    const previous = input.id ? this._get('buyer_demands', input.id) : null; if (input.id && !previous) throw failure('Demanda não encontrada.');
    if (!previous && this._list('buyer_demands', { status: ['searching', 'found', 'negotiating'] }).length >= 500) throw failure('Limite de 500 demandas em aberto alcançado.');
    const value = { ...previous, ...input }, parsed = this._queryFields(value), contact = this._get('contacts', value.contactId);
    const campaignId = value.campaignId || null;
    if (campaignId) { const campaign = this.store.getCampaign(campaignId); if (!campaign) throw failure('Campanha de origem não encontrada no modo atual.', 'DEMAND_CAMPAIGN_NOT_FOUND'); this.auth.assertFor(actorId, 'campaign.view', campaign); }
    if (!contact || !validPhone(phone(contact.phone))) throw failure('Selecione um comprador cadastrado com telefone válido.');
    const buyerName = String(value.buyerName || contact.name || '').trim(); if (!buyerName || buyerName.length > 120) throw failure('Informe o nome do comprador.');
    const notes = String(value.notes || '').trim(); if (notes.length > 4000) throw failure('As observações devem ter até 4.000 caracteres.');
    const interestUntil = value.interestUntil ? typeof value.interestUntil === 'number' ? value.interestUntil : Date.parse(value.interestUntil) : null;
    if (interestUntil != null && (!Number.isFinite(interestUntil) || interestUntil <= this.now())) throw failure('O prazo de interesse deve ser uma data futura.');
    if (input.markup !== undefined) this._assert(actorId, 'finance.view');
    const pricing = markupCost(1, value.markup || {}), recipients = this._recipients(value.recipientIds);
    const status = value.status || value.state || 'searching'; if (!['searching', 'found', 'negotiating', 'completed', 'cancelled'].includes(status)) throw failure('Status da demanda inválido.');
    const demand = { id: previous?.id || randomUUID(), campaignId, contactId: contact.id, buyerName, model: parsed.model, modelKey: parsed.modelKey, storageGB: parsed.storageGB, color: parsed.color, colorKey: parsed.colorKey, condition: parsed.condition, budgetCents: integer(value.budgetCents, 0, 1, 100000000000, 'Orçamento'), notes, interestUntil, markup: pricing.markup, groupIds: this._groups(value.groupIds), maxAgeMinutes: integer(value.maxAgeMinutes, 120, 1, 43200, 'Validade da oferta'), recipientIds: recipients.map(recipient => recipient.id), status, state: status, maxAttempts: integer(value.maxAttempts, 3, 1, 5, 'Número de tentativas'), retrySeconds: integer(value.retrySeconds, 60, 3, 86400, 'Intervalo de tentativa'), revision: (previous?.revision || 0) + 1, actorId, createdAt: previous?.createdAt || this.now(), updatedAt: this.now() };
    const saved = this.store.transaction(() => { if (previous) this._cancelKind('demand', previous.id); const record = this._save('buyer_demands', demand); this._audit('demand.saved', record.id, actorId); return record; }); this.offerDirty = true; this.emit('change'); return saved;
  }
  updateDemandStatus(id, status, actorId) { this._assert(actorId); const demand = this._get('buyer_demands', id); if (!demand || demand.deletedAt) throw failure('Demanda não encontrada.'); const normalized = { procurando: 'searching', 'oferta encontrada': 'found', 'em negociação': 'negotiating', concluído: 'completed', cancelado: 'cancelled' }[status] || status; if (!['searching', 'found', 'negotiating', 'completed', 'cancelled'].includes(normalized)) throw failure('Status da demanda inválido.'); const saved = this.store.transaction(() => { if (['completed', 'cancelled'].includes(normalized)) this._cancelKind('demand', id); return this._save('buyer_demands', { ...demand, status: normalized, state: normalized, updatedAt: this.now() }); }); this._audit('demand.status', id, actorId); this.emit('change'); return saved; }
  deleteDemand(id, actorId) { this._assert(actorId); const demand = this._get('buyer_demands', id); if (!demand) throw failure('Demanda não encontrada.'); const result = this.store.transaction(() => { this._cancelKind('demand', id); this._save('buyer_demands', { ...demand, status: 'cancelled', state: 'cancelled', deletedAt: this.now(), deletedBy: actorId }); this._audit('demand.deleted', id, actorId); return { deleted: true }; }); this.emit('change'); return result; }
  _offersFor(source, maximum) {
    const settings = this.store.getSetting('buscasSettings', {}); if (settings.enabled !== true) return [];
    const monitored = new Set(settings.monitoredGroupIds || []), groupIds = source.groupIds.filter(id => monitored.has(id) && !settings.blockedGroupIds?.includes(id)); if (!groupIds.length) return [];
    const query = { valid: true, unknownTokens: [], modelKey: source.modelKey, storageGB: source.storageGB, colorKey: source.colorKey, condition: source.condition, priceMaxCents: maximum };
    const candidates = rows(this.store.querySearchOffers({ modelKey: source.modelKey, storageGB: source.storageGB, colorKey: source.colorKey, condition: source.condition, maxPriceCents: maximum, groupIds, from: this.now() - source.maxAgeMinutes * MINUTE, to: this.now(), confidence: 'confirmed', priceKind: 'cash', includeReview: false, includeUnavailable: false, excludedSupplierKeys: settings.blockedSupplierIds || [], excludedGroupIds: settings.blockedGroupIds || [], latest: true, order: 'price', limit: 500 }));
    // This is the already-existing search deduplication. No automatic market or
    // equivalent-offer comparison is introduced by this module.
    return rankOffers(candidates, query, { priceCriterion: 'cash', candidateLimit: 500, blockedSuppliers: settings.blockedSupplierIds || [], blockedGroups: settings.blockedGroupIds || [] });
  }
  _match(kind, source, offer, pricing) {
    const identity = `${offer.supplierKey || offer.senderId || 'unknown'}:${offer.fingerprint || offer.id}`;
    const id = `match:${this._mode()}:${hash(`${kind}:${source.id}:${identity}`)}`;
    if (this._get('commerce_matches', id)) return false;
    const recipients = this._recipients(source.recipientIds), text = opportunityText(offer, source, pricing);
    this.store.transaction(() => {
      if (this._get('commerce_matches', id) || this._blocked()) return;
      const match = { id, kind, sourceId: source.id, sourceRevision: source.revision, offerId: offer.id, fingerprint: offer.fingerprint || null, offerSnapshot: offer, finalPriceCents: pricing?.finalPriceCents || null, status: 'found', buyerNotified: false, createdAt: this.now(), actorId: source.actorId, originalAt: offer.originalAt || offer.messageAt };
      const currentSource = this._get(kind === 'demand' ? 'buyer_demands' : 'opportunity_rules', source.id);
      if (!currentSource || currentSource.revision !== source.revision || currentSource.enabled === false || currentSource.deletedAt || ['paused','deleted','completed','cancelled','negotiating'].includes(currentSource.status)) return;
      this._save('commerce_matches', match);
      for (const recipient of recipients) this._queue({ id: `delivery:${this._mode()}:${hash(`${id}:${recipient.phone}`)}`, kind, sourceId: source.id, sourceRevision: source.revision, matchId: id, recipient, actorId: source.actorId, text, originalAt: match.originalAt, deadlineAt: match.originalAt + source.maxAgeMinutes * MINUTE, maxAttempts: source.maxAttempts, retrySeconds: source.retrySeconds });
      if (kind === 'demand' && source.status === 'searching') this._save('buyer_demands', { ...source, status: 'found', state: 'found', matchedAt: this.now() });
    });
    this.emit('change'); return true;
  }
  async processOffers() {
    if (this._blocked()) return { matched: 0 };
    let matched = 0;
    for (const rule of this._list('opportunity_rules', { status: 'active', limit: 100 })) {
      if (this._blocked()) break;
      if (rule.enabled === false || !this._can(rule.actorId, 'commerce.manage')) continue;
      for (const offer of this._offersFor(rule, rule.maxPriceCents)) { if (this._blocked()) break; if (this._match('opportunity', rule, offer)) matched++; if (matched >= 100) { this.offerDirty = true; return { matched, more: true }; } }
      await new Promise(resolve => setImmediate(resolve));
    }
    for (const demand of this._list('buyer_demands', { status: ['searching', 'found'], limit: 500 })) {
      if (this._blocked()) break;
      if (demand.deletedAt || demand.interestUntil && demand.interestUntil <= this.now() || !this._can(demand.actorId, 'commerce.manage')) continue;
      for (const offer of this._offersFor(demand, demand.budgetCents)) { if (this._blocked()) break; const pricing = markupCost(offer.priceCents, demand.markup); if (pricing.finalPriceCents <= demand.budgetCents && this._match('demand', demand, offer, pricing)) matched++; if (matched >= 100) { this.offerDirty = true; return { matched, more: true }; } }
      await new Promise(resolve => setImmediate(resolve));
    }
    return { matched };
  }
  approveDemandMatch(input, actorId) {
    this._assert(actorId); if (!input || input.approved !== true) throw failure('Revise a proposta e confirme explicitamente a aprovação.', 'DEMAND_APPROVAL_REQUIRED');
    const match = this._get('commerce_matches', input.id || input.matchId), demand = match && this._get('buyer_demands', match.sourceId); if (!match || match.kind !== 'demand' || !demand || demand.deletedAt || !['searching', 'found', 'negotiating'].includes(demand.status)) throw failure('A demanda não está disponível para aprovação.');
    if (demand.interestUntil && demand.interestUntil <= this.now()) throw failure('O prazo de interesse do comprador venceu.');
    const offer = this._offersFor(demand, demand.budgetCents).find(item => item.id === match.offerId && (item.fingerprint || null) === match.fingerprint); if (!offer) throw failure('A oferta foi alterada, excluída ou perdeu a validade. Faça uma nova revisão.', 'DEMAND_OFFER_STALE');
    const pricing = markupCost(offer.priceCents, demand.markup); if (pricing.finalPriceCents > demand.budgetCents) throw failure('O valor final excede o orçamento do comprador.');
    const contact = this._get('contacts', demand.contactId); if (!contact || !validPhone(phone(contact.phone)) || contact.promotionalOptOut === true || contact.optOut === true || contact.paused === true) throw failure('Comprador indisponível, pausado ou com recusa de mensagens promocionais.');
    const publicText = publicDemandText(offer, pricing.finalPriceCents), approvedAt = this.now();
    this._save('commerce_matches', { ...match, status: 'approved', approvedBy: actorId, approvedAt, publicText, buyerNotified: false }); this._audit('demand.proposal.approved', match.id, actorId); this.emit('change');
    return { id: match.id, demandId: demand.id, contactId: contact.id, draft: true, publicText, requiresPublicationApproval: true, buyerNotified: false, finalPriceCents: pricing.finalPriceCents, availability: 'sob encomenda', offerId: offer.id };
  }
  reportSettings(actorId) { if (actorId) this._assert(actorId, 'finance.reports'); return { enabled: false, time: '20:00', timezone: 'America/Sao_Paulo', recipientIds: [], maxAttempts: 3, retrySeconds: 60, overdueGraceMinutes: 120, ...this.store.getSetting(`commerceDailyReport:${this._mode()}`, {}) }; }
  saveReportSettings(input, actorId) {
    this._assert(actorId, 'finance.reports'); const old = this.reportSettings(), merged = { ...old, ...input };
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(merged.time)) throw failure('Configure o horário no formato HH:mm.');
    try { new Intl.DateTimeFormat('pt-BR', { timeZone: merged.timezone }).format(0); } catch { throw failure('Fuso horário inválido.'); }
    const recipients = merged.enabled || merged.recipientIds?.length ? this._recipients(merged.recipientIds, 'finance.reports') : [];
    const settings = { enabled: merged.enabled === true, time: merged.time, timezone: merged.timezone, recipientIds: recipients.map(recipient => recipient.id), maxAttempts: integer(merged.maxAttempts, 3, 1, 5, 'Número de tentativas'), retrySeconds: integer(merged.retrySeconds, 60, 3, 86400, 'Intervalo de tentativa'), overdueGraceMinutes: integer(merged.overdueGraceMinutes, 120, 1, 1440, 'Tolerância'), actorId, revision: (old.revision || 0) + 1, nextDueAt: merged.enabled ? nextOccurrence({ repeat: 'daily', time: merged.time, timezone: merged.timezone }, this.now() - 1) : null, updatedAt: this.now() };
    this.store.transaction(() => { for (const delivery of this._list('commerce_deliveries', { status: 'pending', kind: 'daily-report' })) this._save('commerce_deliveries', { ...delivery, status: 'cancelled', code: 'DAILY_REPORT_SETTINGS_CHANGED', resultAt: this.now(), error: 'Configuração do relatório alterada antes do envio.' }); this.store.setSetting(`commerceDailyReport:${this._mode()}`, settings); this._audit('daily-report.settings', this._mode(), actorId); }); this.emit('change'); return settings;
  }
  async _financeReport(date, timezone, actorId) {
    if (typeof this.finance?.dailyReport === 'function') return this.finance.dailyReport(date, timezone);
    if (typeof this.finance?.report === 'function') {
      const [year, month, day] = date.split('-').map(Number), from = localEpoch({ year, month, day }, '00:00', timezone), tomorrow = new Date(Date.UTC(year, month - 1, day + 1)), to = localEpoch({ year: tomorrow.getUTCFullYear(), month: tomorrow.getUTCMonth() + 1, day: tomorrow.getUTCDate() }, '00:00', timezone) - 1;
      return this.finance.report({ from, to, date, timezone }, actorId);
    }
    throw failure('O serviço financeiro não disponibiliza relatório diário.', 'FINANCE_REPORT_UNAVAILABLE');
  }
  async generateDailyReport(input = {}, actorId) {
    this._assert(actorId, 'finance.reports'); const settings = this.reportSettings(), date = validateDate(input.date || dateKey(this.now(), settings.timezone)); if (input.deliver && this._blocked()) throw failure('Os envios automáticos estão interrompidos. Retome explicitamente para enviar relatórios.', 'AUTOMATION_STOPPED');
    const financial = financialSnapshot(await this._financeReport(date, settings.timezone, actorId)); this._assert(actorId, 'finance.reports');
    const previous = this._list('daily_reports', { limit: 500 }).filter(report => report.date === date && report.kind !== 'automatic-occurrence').sort((a, b) => b.version - a.version)[0];
    let report = previous;
    if (!previous || input.updated === true || hash(JSON.stringify(financial)) !== hash(JSON.stringify(previous.financial))) {
      const version = (previous?.version || 0) + 1, id = `daily-report:${this._mode()}:${date}:${version}`;
      report = this.store.transaction(() => { const existing = this._get('daily_reports', id); if (existing) return existing; const value = { id, date, version, updated: version > 1, timezone: settings.timezone, financial, text: formatDailyReport(financial, { date, version, updated: version > 1 }), actorId, createdAt: this.now(), status: 'generated', settingsRevision: settings.revision || 0 }; const saved = this._save('daily_reports', value); this._audit('daily-report.generated', id, actorId); return saved; });
    }
    if (input.deliver) {
      if (this._blocked()) throw failure('Os envios foram interrompidos antes da fila.', 'AUTOMATION_STOPPED');
      const recipients = this._recipients(settings.recipientIds, 'finance.reports');
      this.store.transaction(() => { for (const recipient of recipients) for (const [index, text] of this._chunks(report.text).entries()) this._queue({ id: `delivery:${this._mode()}:${hash(`${report.id}:${recipient.phone}:${index}`)}`, kind: 'daily-report', sourceId: report.id, sourceRevision: settings.revision || 0, recipient, actorId, text, originalAt: report.createdAt, deadlineAt: null, maxAttempts: settings.maxAttempts, retrySeconds: settings.retrySeconds }); });
      this.emit('change'); await this.flush();
    }
    return { ...report, deliveries: this._list('commerce_deliveries', { kind: 'daily-report', limit: 500 }).filter(item => item.sourceId === report.id) };
  }
  _chunks(text) { const result = []; let current = ''; for (const line of String(text).split('\n')) { if (current && current.length + line.length + 1 > 3500) { result.push(current); current = ''; } if (line.length > 3500) { if (current) result.push(current); current = ''; for (let start = 0; start < line.length; start += 3500) result.push(line.slice(start, start + 3500)); } else current += (current ? '\n' : '') + line; } if (current) result.push(current); return result; }
  dailyReports(filter = {}, actorId) { this._assert(actorId, 'finance.reports'); return this.store.queryEntities ? this.store.queryEntities('daily_reports', { ...filter, limit: Math.min(100, Number(filter.limit) || 20) }) : { items: this._list('daily_reports', { limit: 100 }), total: this._list('daily_reports').length }; }
  _queue(value) { const old = this._get('commerce_deliveries', value.id); if (old || this._blocked()) return old; const recipient = value.recipient, messageId = `KENNED-COMMERCE-${hash(value.id).slice(0, 36)}`, { recipient: unused, ...rest } = value; this.store.registerOutboundMessageId?.(messageId, { kind: `commerce-${value.kind}`, at: this.now() }); const saved = this._save('commerce_deliveries', { ...rest, recipientId: recipient.id, recipientUserId: recipient.userId, number: recipient.phone, messageId, traceId: value.id, createdAt: this.now(), status: 'pending', attempts: 0, nextAttemptAt: this.now(), integrationMode: this._mode(), simulation: this._mode() === 'simulated' }); this._trace(saved, 'queued', 'COMMERCE_DELIVERY_QUEUED', 'Aviso privado persistido antes do envio.', 'Pendente de confirmação da integração.'); return saved; }
  _validateDelivery(delivery) {
    const permission = delivery.kind === 'daily-report' ? 'finance.reports' : 'commerce.manage'; this._assert(delivery.actorId, permission);
    const recipient = this._recipient(delivery.recipientId, permission); if (recipient.phone !== delivery.number || recipient.userId !== delivery.recipientUserId) throw failure('Identidade ou telefone do destinatário alterado.', 'COMMERCE_RECIPIENT_CHANGED');
    if (delivery.kind === 'daily-report') { const settings = this.reportSettings(); if (!settings.recipientIds.includes(delivery.recipientId) || (settings.revision || 0) !== delivery.sourceRevision || !this._get('daily_reports', delivery.sourceId)) throw failure('Configuração do relatório alterada antes do envio.', 'COMMERCE_DELIVERY_CANCELLED'); }
    else { const source = this._get(delivery.kind === 'demand' ? 'buyer_demands' : 'opportunity_rules', delivery.sourceId); if (!source || source.revision !== delivery.sourceRevision || source.deletedAt || source.enabled === false || ['cancelled', 'completed', 'negotiating', 'paused', 'deleted'].includes(source.status)) throw failure('Regra pausada, alterada ou concluída antes do aviso.', 'COMMERCE_DELIVERY_CANCELLED'); const match = this._get('commerce_matches', delivery.matchId); if (!match || !this._offersFor(source, delivery.kind === 'demand' ? source.budgetCents : source.maxPriceCents).some(offer => offer.id === match.offerId && (offer.fingerprint || null) === match.fingerprint)) throw failure('A oferta perdeu validade ou foi alterada antes do aviso.', 'COMMERCE_OFFER_EXPIRED'); }
    if (delivery.deadlineAt && delivery.deadlineAt < this.now()) throw failure('Validade da oferta encerrada antes do envio.', 'COMMERCE_OFFER_EXPIRED'); return recipient;
  }
  async tick() {
    if (this.ticking) return this.ticking;
    // Expiration is bookkeeping, not an automatic message. Keep it running
    // while sends are stopped, and never erase or refund a deposit implicitly.
    if (!this.closed && !this.suspended && !this.store.persistenceFailed && !this.scheduler?.persistenceFailed && (!Number.isFinite(this.lastReservationScanAt) || this.now() - this.lastReservationScanAt >= MINUTE)) {
      this.lastReservationScanAt = this.now();
      if (this.finance?.expireReservations?.().length) this.emit('change');
    }
    if (this._blocked()) return;
    this.ticking = (async () => {
      const mode = this._mode();
      if (this.offerDirty || this.now() - this.lastOfferScanAt >= MINUTE) { this.offerDirty = false; this.lastOfferScanAt = this.now(); await this.processOffers(); }
      if (this._blocked() || mode !== this._mode()) return;
      const settings = this.reportSettings();
      if (settings.enabled && settings.nextDueAt && settings.nextDueAt <= this.now() && this._can(settings.actorId, 'finance.reports')) {
        const due = previousOccurrence({ repeat: 'daily', time: settings.time, timezone: settings.timezone }, this.now()), date = dateKey(due, settings.timezone), autoId = `daily-auto:${mode}:${date}`;
        if (!this._get('daily_reports', autoId) && this.now() - due <= settings.overdueGraceMinutes * MINUTE) {
          const report = await this.generateDailyReport({ date, deliver: false }, settings.actorId);
          if (this._blocked() || mode !== this._mode()) return;
          this.store.transaction(() => { if (this._get('daily_reports', autoId)) return; this._save('daily_reports', { id: autoId, date, version: 0, reportId: report.id, kind: 'automatic-occurrence', status: 'queued', createdAt: this.now(), originalAt: due, actorId: settings.actorId }); for (const recipient of this._recipients(settings.recipientIds, 'finance.reports')) for (const [index, text] of this._chunks(report.text).entries()) this._queue({ id: `delivery:${mode}:${hash(`${report.id}:${recipient.phone}:${index}`)}`, kind: 'daily-report', sourceId: report.id, sourceRevision: settings.revision || 0, recipient, actorId: settings.actorId, text, originalAt: due, deadlineAt: null, maxAttempts: settings.maxAttempts, retrySeconds: settings.retrySeconds }); });
        }
        if (!this._blocked() && mode === this._mode()) this.store.setSetting(`commerceDailyReport:${mode}`, { ...settings, nextDueAt: nextOccurrence({ repeat: 'daily', time: settings.time, timezone: settings.timezone }, this.now()) });
      }
      await this.flush();
    })().finally(() => { this.ticking = null; }); return this.ticking;
  }
  async flush() {
    if (this.flushing) return this.flushing; if (this._blocked() || this.adapter?.status?.state !== 'connected') return;
    this.flushing = this._flush().finally(() => { this.flushing = null; }); return this.flushing;
  }
  async _flush() {
    const adapter = this.adapter, revision = this.adapterRevision, mode = this._mode();
    for (const delivery of this._list('commerce_deliveries', { status: 'pending', limit: 100 })) {
      if (this._blocked() || adapter !== this.adapter || revision !== this.adapterRevision || mode !== this._mode() || adapter.status?.state !== 'connected') break;
      if (delivery.nextAttemptAt > this.now()) continue;
      if (typeof this.scheduler?.runExternalSubmission !== 'function') throw failure('Fila sequencial de envios indisponível.', 'COMMERCE_QUEUE_UNAVAILABLE');
      try { await this.scheduler.runExternalSubmission(() => this._submit(delivery.id, adapter, revision, mode)); }
      catch (error) { if (error?.code === 'AUTOMATION_STOPPED' || this._blocked()) return; throw error; }
    }
  }
  async _submit(id, adapter, revision, mode) {
    const cancelled = () => this._blocked() || adapter !== this.adapter || revision !== this.adapterRevision || mode !== this._mode() || adapter.status?.state !== 'connected';
    if (cancelled()) return; let delivery = this._get('commerce_deliveries', id); if (!delivery || delivery.status !== 'pending') return;
    let submitted = false, attempt = (delivery.attempts || 0) + 1;
    try {
      this._validateDelivery(delivery);
      const spacing = Math.max(3, adapter.minimumSpacingSeconds || 0) * 1000; if (this.scheduler.lastSubmissionAt != null && this.now() - this.scheduler.lastSubmissionAt < spacing) await this.sleep(spacing - (this.now() - this.scheduler.lastSubmissionAt));
      if (cancelled()) return;
      if (typeof adapter.resolveRecipient !== 'function' || typeof adapter.sendPrivate !== 'function') throw failure('A integração não suporta a resolução e o envio privado exigidos.', 'WA_RECIPIENT_UNSUPPORTED');
      const resolved = await adapter.resolveRecipient(delivery.number);
      if (cancelled()) return; delivery = this._get('commerce_deliveries', id); if (delivery?.status !== 'pending') return;
      this._validateDelivery(delivery);
      if (!resolved?.jid || resolved.phone !== delivery.number || resolved.mode && resolved.mode !== mode || Boolean(resolved.simulation) !== (mode === 'simulated')) throw failure('A integração não confirmou o destinatário no modo atual.', 'WA_RECIPIENT_MISMATCH');
      delivery = this._save('commerce_deliveries', { ...delivery, status: 'sending', attempts: attempt, submittedAt: this.now(), targetId: resolved.jid, isSelf: resolved.isSelf === true }); this._trace(delivery, 'recipient', 'COMMERCE_RECIPIENT_RESOLVED', 'Identidade privada confirmada; permissões verificadas novamente.', 'Submissão iniciada, ainda sem confirmação.'); this.inFlight.add(id); this.scheduler.lastSubmissionAt = this.now(); submitted = true;
      const result = await adapter.sendPrivate(delivery.number, delivery.text, { clientMessageId: delivery.messageId, beforeSubmit: () => {
        const latest = this._get('commerce_deliveries', id);
        if (cancelled() || latest?.status !== 'sending') throw failure('Envio interrompido antes da submissão.', 'COMMERCE_DELIVERY_CANCELLED');
        this._validateDelivery(latest);
        if (latest.number !== delivery.number) throw failure('O destinatário foi alterado antes da submissão.', 'COMMERCE_RECIPIENT_CHANGED');
      } });
      if (mode !== this._mode() || adapter !== this.adapter) return;
      const latest = this._get('commerce_deliveries', id), confirmed = ['confirmed', 'accepted', 'delivered'].includes(result?.status) || ['accepted', 'delivered'].includes(latest?.status), delivered = latest?.status === 'delivered' || result?.status === 'delivered' || confirmed && ['whatsapp-delivered', 'whatsapp-read'].includes(result?.confirmationScope);
      const saved = this._save('commerce_deliveries', { ...latest, status: delivered ? 'delivered' : confirmed ? 'accepted' : 'uncertain', resultAt: latest.resultAt || this.now(), confirmationScope: result?.confirmationScope || latest.confirmationScope || (confirmed ? mode === 'simulated' ? 'simulation-only' : 'integration-accepted' : null), ...(delivered ? { deliveredAt: latest.deliveredAt || result?.deliveredAt || this.now() } : {}), code: confirmed ? null : 'COMMERCE_SEND_UNCERTAIN', error: confirmed ? null : 'Envio sem confirmação. Revise antes de repetir; nenhum reenvio automático.' }); this._trace(saved, 'result', delivered ? 'COMMERCE_DELIVERED' : confirmed ? 'COMMERCE_ACCEPTED' : 'COMMERCE_SEND_UNCERTAIN', confirmed ? 'Confirmação disponível registrada.' : 'Resultado sem confirmação registrado para revisão.', 'Nenhum reenvio automático após aceitação ou incerteza.');
    } catch (error) {
      if (mode !== this._mode() || adapter !== this.adapter) return; const latest = this._get('commerce_deliveries', id); if (!latest || ['accepted', 'delivered', 'cancelled'].includes(latest.status)) return;
      const safe = error?.safeToRetry === true || !submitted && error?.definitive !== true && error?.safeToRetry !== false, cancelledByConfig = ['COMMERCE_DELIVERY_CANCELLED', 'COMMERCE_OFFER_EXPIRED'].includes(error?.code);
      const status = cancelledByConfig ? 'cancelled' : safe && attempt < delivery.maxAttempts ? 'pending' : !submitted || error?.safeToRetry === true || error?.definitive === true ? 'failed' : 'uncertain';
      const saved = this._save('commerce_deliveries', { ...latest, attempts: attempt, status, resultAt: status === 'pending' ? null : this.now(), nextAttemptAt: this.now() + Math.max(delivery.retrySeconds || 60, adapter.minimumSpacingSeconds || 3) * 1000, code: /^[A-Z0-9_]{1,64}$/.test(error?.code || '') ? error.code : 'COMMERCE_SEND_ERROR', error: safeText(error.message) || 'Falha no envio privado.', safeToRetry: status === 'pending' }); this._trace(saved, 'failure', saved.code, saved.error, status === 'pending' ? 'Nova tentativa limitada agendada.' : status === 'uncertain' ? 'Revisão obrigatória, sem reenvio automático.' : 'Nenhuma tentativa automática adicional.');
      if (['failed','uncertain'].includes(status)) this.onCriticalIncident?.({ id: saved.id, traceId: saved.traceId, event: 'critical', at: saved.resultAt, code: saved.code, reason: 'Falha no envio de aviso comercial ou relatório diário. Consulte o diagnóstico; destinatário e dados financeiros permanecem protegidos.' });
    } finally { this.inFlight.delete(id); this.emit('change'); }
  }
  _receipt(receipt) {
    if (!receipt?.messageId || !['confirmed', 'delivered', 'read'].includes(receipt.status)) return;
    if (receipt.mode && receipt.mode !== this._mode() || receipt.simulation !== undefined && Boolean(receipt.simulation) !== (this._mode() === 'simulated')) return;
    try { for (const delivery of this._list('commerce_deliveries', { status: ['sending', 'accepted', 'delivered', 'uncertain'], limit: 500 })) { if (delivery.messageId !== receipt.messageId) continue; const delivered = delivery.status === 'delivered' || ['delivered', 'read'].includes(receipt.status) || ['whatsapp-delivered', 'whatsapp-read'].includes(receipt.confirmationScope); this._save('commerce_deliveries', { ...delivery, status: delivered ? 'delivered' : 'accepted', resultAt: delivery.resultAt || this.now(), confirmationScope: receipt.confirmationScope || delivery.confirmationScope || 'whatsapp-server', ...(delivered ? { deliveredAt: delivery.deliveredAt || receipt.deliveredAt || this.now() } : {}), code: null, error: null }); this._trace(delivery, 'receipt', delivered ? 'COMMERCE_DELIVERED' : 'COMMERCE_ACCEPTED', delivered ? 'Entrega ao dispositivo confirmada pela integração.' : 'Recebimento pelo servidor confirmado pela integração.', 'Registro conciliado sem repetir o envio.'); } this.emit('change'); } catch (error) { this._fatal(error); }
  }
  stopPending({ userId, actorId = userId, reason = 'Interrupção geral dos envios automáticos.' } = {}) {
    const inFlight = this.inFlight.size; let cancelled = 0, paused = 0;
    this.store.transaction(() => { for (const delivery of this._list('commerce_deliveries', { status: 'pending' })) { this._save('commerce_deliveries', { ...delivery, status: 'cancelled', cancelledBy: actorId || null, resultAt: this.now(), code: 'AUTOMATION_STOPPED', error: reason }); cancelled++; } for (const rule of this._list('opportunity_rules', { status: 'active' })) { this._save('opportunity_rules', { ...rule, enabled: false, status: 'paused' }); paused++; } const settings = this.reportSettings(); if (settings.enabled) this.store.setSetting(`commerceDailyReport:${this._mode()}`, { ...settings, enabled: false, nextDueAt: null }); }); this.emit('change'); return { cancelled, paused, inFlight };
  }
  snapshot(actorId) {
    const commerce = this._can(actorId, 'commerce.manage'), reports = this._can(actorId, 'finance.reports');
    const recipients = this._list('users').filter(user => user.active !== false && validPhone(phone(user.phone)) && (commerce && this._can(user.id, 'commerce.manage') || reports && this._can(user.id, 'finance.reports'))).map(user => ({ id: `user:${user.id}`, name: user.name || 'Administrador', phone: phone(user.phone), commerce: this._can(user.id, 'commerce.manage'), financial: this._can(user.id, 'finance.reports') }));
    const finance = this._can(actorId, 'finance.view');
    const redactDemand = value => { if (finance) return value; const { markup, ...publicValue } = value; return publicValue; };
    const redactDelivery = value => value.kind === 'demand' && !finance ? { ...value, text: 'Aviso financeiro protegido. Peça acesso às informações financeiras para consultar o conteúdo.' } : value;
    return { permissions: { manage: commerce, reports, finance }, opportunities: commerce ? this._list('opportunity_rules', { limit: 200 }).filter(rule => rule.status !== 'deleted') : [], demands: commerce ? this._list('buyer_demands', { limit: 500 }).filter(demand => !demand.deletedAt).map(redactDemand) : [], matches: commerce ? this._list('commerce_matches', { limit: 100 }).map(match => finance ? match : { ...match, finalPriceCents: undefined }) : [], deliveries: this._list('commerce_deliveries', { limit: 100 }).filter(delivery => delivery.kind === 'daily-report' ? reports : commerce).map(redactDelivery), reports: reports ? this._list('daily_reports', { limit: 30 }).filter(report => report.kind !== 'automatic-occurrence') : [], reportSettings: reports ? this.reportSettings() : null, recipients, stopped: this.isAutomationStopped() === true, connection: this.adapter?.status?.state || 'disconnected', inFlight: this.inFlight.size };
  }
  status() { return { rules: this._list('opportunity_rules', { status: 'active', limit: 101 }).length, demands: this._list('buyer_demands', { status: ['searching', 'found'], limit: 501 }).length, pending: this._list('commerce_deliveries', { status: 'pending', limit: 1000 }).length, inFlight: this.inFlight.size, dailyReportEnabled: this.reportSettings().enabled, stopped: this.isAutomationStopped() === true }; }
  start() { if (this.started || this.closed) return; this.started = true; for (const delivery of this._list('commerce_deliveries', { status: 'sending' })) this._save('commerce_deliveries', { ...delivery, status: 'uncertain', code: 'COMMERCE_INTERRUPTED', error: 'Aplicativo encerrado durante a submissão. Revise antes de repetir.', resultAt: this.now() }); this.searches?.on('change', this.searchListener); this.adapter?.on('status', this.statusListener); this.adapter?.on('receipt', this.receiptListener); this.timer = setInterval(() => this._backgroundTick(), 1000); this.timer.unref?.(); this._backgroundTick(); }
  setAdapter(adapter) { this.adapter?.off('status', this.statusListener); this.adapter?.off('receipt', this.receiptListener); this.adapter = adapter; this.adapterRevision++; this.offerDirty = true; this.lastOfferScanAt = 0; if (this.started) { adapter?.on('status', this.statusListener); adapter?.on('receipt', this.receiptListener); } }
  async suspend() { this.suspended = true; await this.ticking?.catch(() => {}); await this.flushing?.catch(() => {}); }
  async waitForIdle() { await this.ticking?.catch(() => {}); await this.flushing?.catch(() => {}); }
  resume() { if (!this.closed) { this.suspended = false; this.offerDirty = true; this._backgroundTick(); } }
  async shutdown() { if (this.closed) return; this.closed = true; clearInterval(this.timer); this.searches?.off('change', this.searchListener); this.adapter?.off('status', this.statusListener); this.adapter?.off('receipt', this.receiptListener); await this.ticking?.catch(() => {}); await this.flushing?.catch(() => {}); }
  stop() { return this.shutdown(); }
}

module.exports = { CommerceAutomation, markupCost, publicDemandText, opportunityText, formatDailyReport, commerceDateKey: dateKey };
