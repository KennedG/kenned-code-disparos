'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { parseOffers } = require('./search-parser.cjs');

const CONTACT_CATEGORIES = Object.freeze(['Cliente Nerópolis', 'Lojista Camelódromo', 'Fornecedor']);
const AUDIENCES = new Set(['retail', 'wholesale', 'general']);
const MAX_MONEY = 1_000_000_000_000;
const clone = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const fault = (message, code = 'COMMERCIAL_INVALID') => Object.assign(new Error(message), { code, definitive: true, submitted: false, safeToRetry: false });
const text = (value, max = 120) => String(value ?? '').trim().slice(0, max);
const normalizePhone = value => String(value || '').replace(/[\s()+.\-]/g, '');
const validPhone = value => /^[1-9]\d{9,14}$/.test(value);
const money = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_MONEY;
const brl = value => (value / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function decimalHundredths(value, label) {
  // Two decimal places, parsed as integers. Floating multiplication never
  // decides a monetary rounding boundary.
  const match = /^(\d{1,10})(?:[.,](\d{1,2}))?$/.exec(String(value ?? '').trim());
  if (!match) throw fault(`${label}: informe um valor não negativo com até duas casas decimais.`, 'MARKUP_INVALID');
  const n = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(n)) throw fault(`${label} fora do limite.`, 'MARKUP_INVALID');
  return n;
}

function normalizeMarkup(input = { type: 'fixed', valueCents: 0 }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fault('Regra de acréscimo inválida.', 'MARKUP_INVALID');
  if (input.type === 'fixed') {
    const valueCents = input.valueCents ?? decimalHundredths(input.value ?? 0, 'Acréscimo em reais');
    if (!money(valueCents)) throw fault('Acréscimo em reais inválido.', 'MARKUP_INVALID');
    return { type: 'fixed', valueCents };
  }
  if (input.type === 'percent') {
    const basisPoints = input.basisPoints ?? decimalHundredths(input.value ?? 0, 'Percentual de acréscimo sobre o custo');
    if (!Number.isSafeInteger(basisPoints) || basisPoints < 0 || basisPoints > 1_000_000) throw fault('Percentual de acréscimo inválido.', 'MARKUP_INVALID');
    return { type: 'percent', basisPoints };
  }
  throw fault('Escolha acréscimo fixo em reais ou percentual sobre o custo.', 'MARKUP_INVALID');
}

function calculateMarkup(costCents, input) {
  if (!money(costCents)) throw fault('O custo deve ser informado em centavos e não pode ser negativo.', 'COST_INVALID');
  const markup = normalizeMarkup(input);
  const increment = markup.type === 'fixed' ? BigInt(markup.valueCents) : (BigInt(costCents) * BigInt(markup.basisPoints) + 5000n) / 10000n;
  const final = BigInt(costCents) + increment;
  if (final > BigInt(MAX_MONEY)) throw fault('O preço calculado excede o limite.', 'PRICE_LIMIT');
  return { costCents, priceCents: Number(final), profitCents: Number(increment), markup, calculation: 'acrescimo_sobre_custo', profitType: 'estimated' };
}

function publicFacts(source = {}) {
  const facts = {};
  for (const [key, value] of Object.entries({ model: source.model || source.name, storage: source.storage || (source.storageGB ? `${source.storageGB}GB` : undefined), color: source.color, condition: source.condition, warranty: source.warranty })) {
    if (value !== undefined && value !== null && value !== '') facts[key] = text(value, key === 'warranty' ? 180 : 120);
  }
  const battery = source.batteryPercent ?? source.battery;
  if (Number.isInteger(battery) && battery >= 0 && battery <= 100) facts.batteryPercent = battery;
  return facts;
}

function publicLine(line) {
  return { sourceType: line.sourceType, sourceId: line.sourceId, quantity: line.quantity, priceCents: line.priceCents,
    facts: publicFacts(line.facts), availability: line.sourceType === 'inventory' ? 'pronta entrega' : 'sob encomenda',
    sourceRevisionAt: line.sourceRevisionAt ?? null };
}

function listTotals(lines) {
  const sums = { totalCostCents: 0n, totalPriceCents: 0n, totalEstimatedProfitCents: 0n };
  for (const line of lines) for (const [total, field] of [['totalCostCents', 'costCents'], ['totalPriceCents', 'priceCents'], ['totalEstimatedProfitCents', 'profitCents']]) {
    sums[total] += BigInt(line[field]) * BigInt(line.quantity);
    if (sums[total] > BigInt(MAX_MONEY)) throw fault('O total da lista excede o limite monetário. Reduza a quantidade ou os preços.', 'PRICE_LIMIT');
  }
  return Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, Number(v)]));
}

function formatPublicLines(lines, audience, name = '') {
  const labels = { retail: 'Varejo', wholesale: 'Atacado', general: 'Produtos' };
  return [`📱 *${text(name, 120) || 'Lista comercial'}*`, `👥 ${labels[audience] || 'Produtos'}`, '', ...lines.flatMap((line, index) => {
    const f = line.facts || {};
    return [`${index + 1}. *${[f.model, f.storage, f.color].filter(Boolean).join(' • ')}*`,
      ...(f.condition ? [`📦 ${f.condition}`] : []), ...(Number.isInteger(f.batteryPercent) ? [`🔋 Bateria: ${f.batteryPercent}%`] : []),
      ...(f.warranty ? [`🛡️ ${f.warranty}`] : []), `💰 *${brl(line.priceCents)}*${line.quantity > 1 ? ` • ${line.quantity} unidade(s)` : ''}`,
      `🚚 ${line.availability === 'pronta entrega' ? 'Pronta entrega' : 'Sob encomenda'}`, ''];
  })].join('\n').trim();
}

function zonedScheduleAllowed(at, schedule) {
  if (!schedule || schedule.enabled === false) return true;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: schedule.timezone || 'America/Sao_Paulo', weekday: 'short', hour: '2-digit', minute: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23' }).formatToParts(at).map(p => [p.type, p.value]));
  let day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const minute = Number(parts.hour) * 60 + Number(parts.minute), time = v => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
  const start = time(schedule.startTime), end = time(schedule.endTime);
  if (start < end && (minute < start || minute >= end)) return false;
  if (start > end) {
    if (minute >= end && minute < start) return false;
    if (minute < end) day = (day + 6) % 7;
  }
  return schedule.days.includes(day);
}

class CommercialService {
  constructor({ store, finance, now = () => Date.now() }) {
    this.store = store; this.finance = finance; this.now = now;
  }
  _mode() { return this.store.getStorageMode?.() || 'whatsapp'; }
  _tx(fn) { return this.store.transaction(fn); }
  _get(table, id) { return this.store.getEntity(table, id); }
  _entities(table, filter = {}) { return this.store.listEntities(table, filter); }
  _audit(action, actorId, details) {
    this.store.addAudit({ id: randomUUID(), at: this.now(), userId: actorId || null, action, ...details });
  }

  listCategories() {
    let custom = []; try { custom = this._entities('contact_categories'); } catch (error) { if (!/tabela|table|Entidade/i.test(error.message)) throw error; }
    return [...CONTACT_CATEGORIES.map(name => ({ id: `builtin:${name}`, name, builtin: true })), ...custom.filter(c => !c.deleted && !CONTACT_CATEGORIES.includes(c.name))];
  }
  saveCategory(input = {}, actorId) {
    const name = text(input.name);
    if (!name || String(input.name).trim().length > 120 || /[\x00-\x1f]/.test(name)) throw fault('Informe um nome de categoria de até 120 caracteres.', 'CATEGORY_NAME_INVALID');
    const match = this.listCategories().find(c => c.name.localeCompare(name, 'pt-BR', { sensitivity: 'base' }) === 0);
    if (match && match.id !== input.id) return match;
    if (input.id?.startsWith('builtin:')) throw fault('Categorias iniciais não podem ser renomeadas.', 'CATEGORY_BUILTIN');
    const old = input.id ? this._get('contact_categories', input.id) : null;
    if (input.id && !old) throw fault('Categoria não encontrada.', 'CATEGORY_NOT_FOUND');
    if (old && old.name !== name && this._entities('contacts').some(c => (c.categories || [c.category]).includes(old.name))) throw fault('Esta categoria está vinculada a contatos. Crie uma nova categoria e revise os contatos antes de renomear.', 'CATEGORY_IN_USE');
    return this._tx(() => {
      const saved = this.store.saveEntity('contact_categories', { id: old?.id || randomUUID(), name, createdAt: old?.createdAt ?? this.now(), updatedAt: this.now() });
      this._audit('contacts.category.save', actorId, { categoryId: saved.id }); return saved;
    });
  }
  deleteCategory(id, actorId) {
    const category = this.listCategories().find(c => c.id === id);
    if (!category) throw fault('Categoria não encontrada.', 'CATEGORY_NOT_FOUND');
    if (category.builtin) throw fault('Categorias iniciais não podem ser excluídas.', 'CATEGORY_BUILTIN');
    if (this._entities('contacts').some(c => (c.categories || [c.category]).includes(category.name))) throw fault('A categoria está sendo usada por contatos.', 'CATEGORY_IN_USE');
    return this._tx(() => { this.store.deleteEntity('contact_categories', id); this._audit('contacts.category.delete', actorId, { categoryId: id }); return { deleted: true }; });
  }
  normalizeContact(input = {}, existing = {}) {
    const name = text(input.name ?? existing.name), phone = normalizePhone(input.phone ?? existing.phone);
    if (!name || !validPhone(phone)) throw fault('Informe nome e telefone com país + DDD + número.', 'CONTACT_INVALID');
    const rawCategories = input.categories ?? (input.category !== undefined ? (input.category ? [input.category] : []) : existing.categories ?? (existing.category ? [existing.category] : []));
    if (!Array.isArray(rawCategories) || rawCategories.length > 50 || rawCategories.some(c => typeof c !== 'string' || !c.trim() || c.length > 120)) throw fault('Selecione categorias válidas.', 'CONTACT_CATEGORY_INVALID');
    const categories = [...new Set(rawCategories.map(c => c.trim()))], available = this.listCategories().map(c => c.name);
    const previous = existing.categories || [existing.category];
    if (categories.some(c => !available.includes(c) && !previous.includes(c))) throw fault('Selecione uma categoria cadastrada ou cadastre uma categoria personalizada.', 'CONTACT_CATEGORY_INVALID');
    const policies = {};
    for (const field of ['promotionalConsent', 'promotionalOptOut', 'promotionPaused']) {
      if (input[field] !== undefined && typeof input[field] !== 'boolean') throw fault('A autorização promocional deve ser confirmada ou desmarcada.', 'CONTACT_CONSENT_INVALID');
      policies[field] = input[field] ?? existing[field] ?? false;
    }
    return { ...existing, name, phone, categories, category: categories[0] || '', ...policies, notes: text(input.notes ?? existing.notes, 4000), savedLocation: 'system', addressBookSupported: false };
  }
  saveContact(input, actorId) {
    input = input?.contact || input || {};
    const byId = input.id ? this._get('contacts', input.id) : null;
    if (input.id && !byId) throw fault('Contato não encontrado neste modo.', 'CONTACT_NOT_FOUND');
    const phone = normalizePhone(input.phone ?? byId?.phone), duplicate = this.store.findContactByPhone?.(phone) || this._entities('contacts').find(c => normalizePhone(c.phone) === phone);
    if (byId && duplicate && duplicate.id !== byId.id) throw fault('Este número já está cadastrado. Edite o contato existente.', 'CONTACT_DUPLICATE');
    const existing = byId || duplicate;
    const value = this.normalizeContact(input, existing || {});
    return this._tx(() => {
      const saved = this.store.saveEntity('contacts', { ...value, id: existing?.id || randomUUID(), createdAt: existing?.createdAt ?? this.now(), updatedAt: this.now() });
      const persisted = this._get('contacts', saved.id);
      if (!persisted || JSON.stringify(persisted.categories) !== JSON.stringify(saved.categories)) throw fault('Não foi possível persistir o contato.', 'CONTACT_PERSISTENCE_FAILED');
      this._audit(existing ? 'contacts.edit' : 'contacts.create', actorId, { contactId: saved.id, categories: saved.categories }); return persisted;
    });
  }

  settings() {
    return { retailMarkup: { type: 'fixed', valueCents: 0 }, wholesaleMarkup: { type: 'fixed', valueCents: 0 }, offerMaxAgeMinutes: 120, repeatLimit: 0, minimumIntervalMinutes: 0,
      promotionSchedule: { enabled: false, timezone: 'America/Sao_Paulo', days: [0, 1, 2, 3, 4, 5, 6], startTime: '08:00', endTime: '20:00' }, ...this.store.getSetting('commercialSettings', {}) };
  }
  saveSettings(input = {}, actorId) {
    const result = this.settings();
    for (const field of ['retailMarkup', 'wholesaleMarkup']) if (input[field] !== undefined) result[field] = normalizeMarkup(input[field]);
    for (const [field, max] of [['offerMaxAgeMinutes', 525600], ['repeatLimit', 100000], ['minimumIntervalMinutes', 10080]]) if (input[field] !== undefined) {
      if (!Number.isInteger(input[field]) || input[field] < 0 || input[field] > max) throw fault(`${field}: informe um número inteiro válido.`);
      result[field] = input[field];
    }
    if (input.promotionSchedule !== undefined) {
      const s = { ...result.promotionSchedule, ...input.promotionSchedule };
      if (typeof s.enabled !== 'boolean' || !Array.isArray(s.days) || !s.days.length || s.days.some(d => !Number.isInteger(d) || d < 0 || d > 6) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.endTime)) throw fault('Dias e horários promocionais inválidos.');
      try { new Intl.DateTimeFormat('pt-BR', { timeZone: s.timezone }).format(); } catch { throw fault('Fuso dos envios promocionais inválido.'); }
      result.promotionSchedule = s;
    }
    return this._tx(() => { this.store.setSetting('commercialSettings', result); this._audit('commerce.settings.save', actorId, {}); return clone(result); });
  }
  listPromotionTargets() { return this._entities('promotional_targets'); }
  _targetIdentity(target, campaign) {
    const id = typeof target === 'string' ? target : target?.id || target?.targetId || target?.groupId || target?.contactId;
    if (!id) throw fault('Destino promocional não identificado.', 'PROMOTION_TARGET_INVALID');
    if (id.startsWith('contact:')) return { type: 'contact', targetId: id.slice(8) };
    if (target?.type === 'contact' || target?.contactId || campaign?.contactIds?.includes(id)) return { type: 'contact', targetId: target?.contactId || id };
    return { type: 'group', targetId: id };
  }
  _policyId(type, targetId) { return `promotion:${this._mode()}:${type}:${targetId}`; }
  setPromotionTarget(input = {}, actorId) {
    if (!['group', 'contact'].includes(input.type) || typeof input.targetId !== 'string') throw fault('Destino inválido.', 'PROMOTION_TARGET_INVALID');
    const source = input.type === 'contact' ? this._get('contacts', input.targetId) : this.store.getGroup(input.targetId);
    if (!source) throw fault('Destino não encontrado no modo atual.', 'PROMOTION_TARGET_NOT_FOUND');
    const id = this._policyId(input.type, input.targetId), old = this._get('promotional_targets', id) || {};
    const audience = input.audience ?? old.audience ?? 'general';
    if (!AUDIENCES.has(audience)) throw fault('Público inválido.', 'AUDIENCE_INVALID');
    for (const field of ['paused', 'optOut']) if (input[field] !== undefined && typeof input[field] !== 'boolean') throw fault('Configuração de pausa inválida.');
    const saved = { ...old, id, type: input.type, targetId: input.targetId, audience, paused: input.paused ?? old.paused ?? false, optOut: input.optOut ?? old.optOut ?? false, updatedAt: this.now(), userId: actorId || null };
    return this._tx(() => { this.store.saveEntity('promotional_targets', saved); this._audit('commerce.target.policy', actorId, { type: input.type, targetId: input.targetId, paused: saved.paused, optOut: saved.optOut, audience }); return saved; });
  }
  _validateAudience(campaign, identity) {
    const policy = this._get('promotional_targets', this._policyId(identity.type, identity.targetId));
    const target = identity.type === 'contact' ? this._get('contacts', identity.targetId) : this.store.getGroup(identity.targetId);
    if (!target) throw fault('Destino removido. Revise a campanha.', 'PROMOTION_TARGET_NOT_FOUND');
    if (policy?.paused || target.promotionPaused === true) throw fault('Envios promocionais pausados para este destino.', 'PROMOTION_TARGET_PAUSED');
    if (policy?.optOut || target.promotionalOptOut === true || target.optOut === true) throw fault('O contato pediu para não receber mensagens promocionais.', 'PROMOTION_OPT_OUT');
    if (identity.type === 'contact' && target.promotionalConsent !== true) throw fault('O contato não possui autorização registrada para receber campanhas promocionais.', 'PROMOTION_CONSENT_REQUIRED');
    const audience = campaign.audience;
    if (!audience || audience === 'general') return;
    if (!AUDIENCES.has(audience)) throw fault('Público inválido na campanha.', 'AUDIENCE_INVALID');
    if (identity.type === 'contact') {
      const categories = target.categories || [target.category];
      const allowed = audience === 'retail' ? categories.includes('Cliente Nerópolis') : categories.includes('Lojista Camelódromo');
      if (!allowed) throw fault('O contato não está classificado no público da campanha.', 'AUDIENCE_MISMATCH');
    } else if ((policy?.audience ?? target.audience) !== audience) throw fault('Classifique o grupo no público exato da campanha antes de enviar esta tabela.', 'AUDIENCE_MISMATCH');
  }
  validateCampaignAudience(campaign) {
    for (const id of campaign.groupIds || []) this._validateAudience(campaign, { type: 'group', targetId: id });
    for (const id of campaign.contactIds || []) this._validateAudience(campaign, { type: 'contact', targetId: id });
    return true;
  }
  _inventory(id) {
    return this.finance?.getInventory ? this.finance.getInventory(id) : this._get('inventory', id);
  }
  _available(item, quantity = 1) {
    if (!item || item.deleted || item.archived || item.status !== 'available') return false;
    const available = item.availableQuantity ?? ((item.quantity ?? (item.status === 'available' ? 1 : 0)) - (item.reservedQuantity || 0));
    return available >= quantity;
  }
  _source(type, id) {
    const value = type === 'inventory' ? this._inventory(id) : type === 'offer' ? this.store.getSearchOffer?.(id) : undefined;
    if (!value) throw fault(type === 'offer' ? 'Oferta não encontrada na base capturada.' : 'Produto não encontrado no estoque.', type === 'offer' ? 'OFFER_NOT_FOUND' : 'INVENTORY_NOT_FOUND');
    return value;
  }
  _offerAllowed(offer, settings) {
    if (offer.status !== 'active' || offer.confidence !== 'confirmed' || offer.priceKind !== 'cash' || !money(offer.priceCents) || offer.priceCents <= 0) throw fault('A oferta precisa ter preço total à vista confirmado e estar disponível.', 'OFFER_REVIEW_REQUIRED');
    const originalAt = Number(offer.originalAt ?? offer.messageAt);
    if (!Number.isFinite(originalAt) || originalAt > this.now() + 30000) throw fault('Horário original da oferta inválido.', 'OFFER_DATE_INVALID');
    if (settings.offerMaxAgeMinutes && originalAt < this.now() - settings.offerMaxAgeMinutes * 60000) throw fault('A oferta ultrapassou a validade configurada. Atualize a lista.', 'OFFER_EXPIRED');
  }
  listCommercialLists({ includeCosts = true } = {}) {
    return this._entities('commercial_lists').filter(l => !l.deleted).map(l => includeCosts ? l : this.publicList(l));
  }
  getCommercialList(id) { const list = this._get('commercial_lists', id); if (!list || list.deleted) throw fault('Lista comercial não encontrada.', 'COMMERCIAL_LIST_NOT_FOUND'); return list; }
  saveCommercialList(input = {}, actorId) {
    const old = input.id ? this.getCommercialList(input.id) : null, settings = this.settings();
    const name = text(input.name);
    if (!name || String(input.name).trim().length > 120) throw fault('Informe um nome de até 120 caracteres para a lista.', 'COMMERCIAL_LIST_NAME_INVALID');
    if (!['retail', 'wholesale'].includes(input.audience)) throw fault('Escolha varejo ou atacado para definir a regra de preço.', 'AUDIENCE_INVALID');
    if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 100) throw fault('Selecione entre 1 e 100 produtos para a lista.', 'COMMERCIAL_LIST_EMPTY');
    if (old && input.expectedRevision !== undefined && input.expectedRevision !== old.revision) throw fault('A lista foi alterada. Atualize a prévia antes de salvar.', 'COMMERCIAL_LIST_STALE');
    const seen = new Set(), lines = input.lines.map(raw => {
      if (!['inventory', 'offer'].includes(raw.sourceType) || typeof raw.sourceId !== 'string') throw fault('Origem do produto inválida.', 'COMMERCIAL_SOURCE_INVALID');
      const key = `${raw.sourceType}:${raw.sourceId}`;
      if (seen.has(key)) throw fault('O mesmo produto foi selecionado mais de uma vez. Ajuste a quantidade.', 'COMMERCIAL_SOURCE_DUPLICATE'); seen.add(key);
      const source = this._source(raw.sourceType, raw.sourceId), quantity = raw.quantity ?? 1;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) throw fault('Quantidade inválida.', 'QUANTITY_INVALID');
      if (raw.sourceType === 'inventory' && !this._available(source, quantity)) throw fault('Produto vendido, reservado ou sem quantidade disponível.', 'INVENTORY_UNAVAILABLE');
      if (raw.sourceType === 'offer') this._offerAllowed(source, settings);
      const costCents = raw.sourceType === 'offer' ? source.priceCents : source.costCents;
      const markup = raw.markup ?? input.markup ?? settings[input.audience === 'retail' ? 'retailMarkup' : 'wholesaleMarkup'];
      const prices = calculateMarkup(costCents, markup), facts = publicFacts(source);
      if (!facts.model) throw fault('O produto não possui modelo ou nome identificado.', 'MODEL_MISSING');
      return { sourceType: raw.sourceType, sourceId: raw.sourceId, quantity, ...prices, facts,
        availability: raw.sourceType === 'inventory' ? 'pronta entrega' : 'sob encomenda',
        sourceRevisionAt: source.revisionAt ?? source.updatedAt ?? source.originalAt ?? source.messageAt ?? null,
        sourceOriginalAt: source.originalAt ?? source.messageAt ?? null };
    });
    const value = { id: old?.id || randomUUID(), name, audience: input.audience, lines, revision: (old?.revision || 0) + 1, createdAt: old?.createdAt ?? this.now(), updatedAt: this.now(), userId: actorId || old?.userId || null };
    listTotals(lines);
    return this._tx(() => { const saved = this.store.saveEntity('commercial_lists', value); this._audit('commerce.list.save', actorId, { listId: saved.id, revision: saved.revision, audience: saved.audience }); return saved; });
  }
  publicList(input) {
    const list = typeof input === 'string' ? this.getCommercialList(input) : input;
    return { id: list.id, name: list.name, audience: list.audience, revision: list.revision, lines: list.lines.map(publicLine), updatedAt: list.updatedAt };
  }
  previewCommercialList(input = {}) {
    const list = this.getCommercialList(typeof input === 'string' ? input : input.id || input.listId), publicView = this.publicList(list);
    return { ...publicView, listId: list.id, text: formatPublicLines(publicView.lines, list.audience, list.name),
      ...listTotals(list.lines),
      calculation: 'acrescimo_sobre_custo', profitType: 'estimated' };
  }
  deleteCommercialList(id, actorId) {
    const list = this.getCommercialList(id);
    if(this.store.listTemplates().some(t=>t.items?.some(i=>i.commercialRef?.listId===id)))throw fault('A lista está vinculada a um modelo. Revise ou exclua o modelo antes de remover a lista.','COMMERCIAL_LIST_IN_USE');
    if (this.store.listCampaigns().some(c => c.commercialListId === id && ['active', 'paused'].includes(c.state))) throw fault('A lista está vinculada a uma campanha ativa ou pausada. Encerre ou revise a campanha antes de excluir.', 'COMMERCIAL_LIST_IN_USE');
    return this._tx(() => { this.store.saveEntity('commercial_lists', { ...list, deleted: true, deletedAt: this.now(), deletedBy: actorId || null }); this._audit('commerce.list.delete', actorId, { listId: id }); return { deleted: true }; });
  }
  toCampaignItems(input) {
    const list = this.getCommercialList(typeof input === 'string' ? input : input.id || input.listId), lines = list.lines.map(publicLine);
    const ref = { listId: list.id, revision: list.revision, audience: list.audience, generated: true, name: list.name, lines };
    return [{ id: randomUUID(), type: 'text', text: formatPublicLines(lines, list.audience, list.name), commercialRef: ref }];
  }
  validateCommercialRef(input, item) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !input.listId) throw fault('Referência comercial inválida.', 'COMMERCIAL_REF_INVALID');
    const expected = this.toCampaignItems(input.listId)[0];
    if (input.revision !== expected.commercialRef.revision || hash(input) !== hash(expected.commercialRef) || item && (item.type !== 'text' || item.text !== expected.text)) throw fault('A prévia da lista mudou. Gere e confirme novamente a campanha.', 'COMMERCIAL_REF_STALE');
    return clone(expected.commercialRef);
  }

  evaluateJob({ campaign, job, target, at = this.now() }) {
    const identity = this._targetIdentity(target || job.groupId, campaign), settings = this.settings();
    this._validateAudience(campaign, identity);
    if (!zonedScheduleAllowed(at, settings.promotionSchedule)) throw fault('Fora do horário permitido para mensagens promocionais.', 'PROMOTION_OUTSIDE_SCHEDULE');
    const item = clone(job.itemSnapshot || job.item || {}), ref = item.commercialRef;
    if (ref && ref.audience !== campaign.audience) throw fault('O preço desta lista pertence a outro público. Revise a campanha.', 'AUDIENCE_MISMATCH');
    if (!ref && campaign.commercialReviewRequired) throw fault('A campanha contém produto indisponível e precisa de revisão.', 'INVENTORY_REVIEW_REQUIRED');
    let lines = ref?.lines || [], removed = [];
    if (ref) {
      if (!Array.isArray(lines) || !lines.length || ref.generated !== true) throw fault('Este anúncio contém referências comerciais não verificadas. Revise antes de enviar.', 'COMMERCIAL_REF_INVALID');
      lines = lines.filter(line => {
        const source = line.sourceType === 'inventory' ? this._inventory(line.sourceId) : this.store.getSearchOffer?.(line.sourceId);
        if (line.sourceType === 'inventory' && !this._available(source, line.quantity)) { removed.push(line.sourceId); return false; }
        if (line.sourceType === 'inventory' && hash(publicFacts(source)) !== hash(publicFacts(line.facts))) throw fault('As características do produto no estoque foram alteradas. Revise o anúncio antes de enviar.', 'INVENTORY_CHANGED');
        if (line.sourceType === 'offer') {
          if (!source) throw fault('A oferta foi removida. Revise o anúncio.', 'OFFER_NOT_FOUND');
          this._offerAllowed(source, settings);
          if ((source.revisionAt ?? source.originalAt ?? source.messageAt ?? null) !== line.sourceRevisionAt) throw fault('A oferta original foi editada. Revise o preço e o anúncio.', 'OFFER_CHANGED');
        }
        return true;
      });
      if (!lines.length) throw fault('Todos os produtos do anúncio estão vendidos, reservados ou indisponíveis. Revise a campanha.', 'INVENTORY_UNAVAILABLE');
      // Only our structured, generated text may be rebuilt automatically.
      // Free-form user text cannot be safely edited by guessing product names.
      const original = formatPublicLines(ref.lines, ref.audience, ref.name);
      if (item.type !== 'text' || item.text !== original) {
        if (removed.length || campaign.commercialReviewRequired) throw fault('Produto indisponível em anúncio editado manualmente. Revise antes do envio.', 'INVENTORY_REVIEW_REQUIRED');
      } else {
        item.text = formatPublicLines(lines, ref.audience, ref.name);
        item.commercialRef = { ...ref, lines: lines.map(publicLine) };
      }
    } else {
      const list = campaign.commercialListId ? this.getCommercialList(campaign.commercialListId) : null;
      const ids = [...new Set([...(item.inventoryIds || []), ...(campaign.inventoryIds || []), ...(item.stockIds || []), ...(campaign.stockIds || []),
        ...(item.stockId ? [item.stockId] : []), ...(campaign.stockId ? [campaign.stockId] : []), ...(list?.lines || []).filter(line => line.sourceType === 'inventory').map(line => line.sourceId)])];
      for (const id of ids) if (!this._available(this._inventory(id))) throw fault('O anúncio está vinculado a produto vendido ou reservado. Revise o texto antes do envio.', 'INVENTORY_REVIEW_REQUIRED');
      for (const line of (list?.lines || []).filter(line => line.sourceType === 'offer')) this._offerAllowed(this._source('offer', line.sourceId), settings);
    }
    const keys = lines.length ? lines.map(l => `${l.sourceType}:${l.sourceId}`) : [`content:${item.id || job.itemId}`];
    const ledger = this._entities('promotion_ledger', { campaignId: campaign.id, status: ['confirmed', 'uncertain', 'accepted', 'sending'] }).filter(e => e.jobId !== job.id && e.targetType === identity.type && e.targetId === identity.targetId);
    const repeatLimit = campaign.promotionPolicy?.repeatLimit ?? settings.repeatLimit;
    if (repeatLimit && keys.some(key => ledger.filter(e => e.offerKeys?.includes(key)).length >= repeatLimit)) throw fault('Limite de repetição da mesma oferta atingido para este destino.', 'PROMOTION_REPEAT_LIMIT');
    const minimum = campaign.promotionPolicy?.minimumIntervalMinutes ?? settings.minimumIntervalMinutes;
    if (minimum && ledger.some(e => e.at + minimum * 60000 > at)) throw fault('Aguarde o intervalo mínimo entre mensagens promocionais para este destino.', 'PROMOTION_INTERVAL');
    return { ...item, promotionTracking: { targetType: identity.type, targetId: identity.targetId, offerKeys: keys, removedInventoryIds: removed } };
  }
  recordJobResult({ campaign, job, payload, status, at = this.now() }) {
    if (!['confirmed', 'uncertain', 'accepted', 'sending', 'failed', 'cancelled'].includes(status)) return null;
    const tracking = payload?.promotionTracking || job.promotionTracking;
    if (!tracking) return null;
    const id = `promotion-ledger:${this._mode()}:${job.id}`, previous = this._get('promotion_ledger', id);
    if (previous?.status === 'confirmed' && status !== 'confirmed') return previous;
    return this.store.saveEntity('promotion_ledger', { ...previous, id, campaignId: campaign.id, jobId: job.id, itemId: job.itemId, ...tracking, status, createdAt: previous?.createdAt ?? at, at: previous?.at ?? at, resultAt: at });
  }
  releasePending(jobId, { submitted = false } = {}) {
    if (submitted !== false) return false;
    const id = `promotion-ledger:${this._mode()}:${jobId}`, existing = this._get('promotion_ledger', id);
    if (!existing || existing.status !== 'sending') return false;
    this.store.saveEntity('promotion_ledger', { ...existing, status: 'cancelled', code: 'NOT_SUBMITTED', resultAt: this.now() });
    return true;
  }
  createAdDraft(input = {}) {
    let facts, priceCents;
    if (typeof input.text === 'string') {
      const offers = parseOffers(input.text);
      if (offers.length !== 1 || offers[0].confidence !== 'confirmed' || offers[0].priceKind !== 'cash' || !offers[0].priceCents) throw fault('Envie um único aparelho com preço total, por exemplo: iPhone 15 Pro Max 256GB Azul seminovo R$ 3.850,00. Parcelas e entradas precisam ser esclarecidas.', 'AD_REVIEW_REQUIRED');
      facts = publicFacts(offers[0]); priceCents = offers[0].priceCents;
    } else {
      facts = publicFacts(input); priceCents = input.priceCents;
      if (!facts.model || !money(priceCents) || priceCents <= 0) throw fault('Informe modelo e preço de venda em centavos.', 'AD_FIELDS_REQUIRED');
    }
    if (!['retail', 'wholesale'].includes(input.audience)) throw fault('Informe se o anúncio será enviado para varejo ou atacado.', 'AUDIENCE_INVALID');
    if (!['pronta entrega', 'sob encomenda'].includes(input.availability)) throw fault('Informe pronta entrega ou sob encomenda.', 'AVAILABILITY_REQUIRED');
    const mediaIds = input.mediaIds || [];
    if (!Array.isArray(mediaIds) || mediaIds.length > 20 || mediaIds.some(id => !this.store.getMedia(id))) throw fault('Uma foto não está disponível na biblioteca gerenciada.', 'AD_MEDIA_INVALID');
    const line = { facts, priceCents, quantity: 1, availability: input.availability };
    return { id: randomUUID(), audience: input.audience, facts, priceCents, availability: input.availability, mediaIds, text: formatPublicLines([line], input.audience, input.name || 'Oferta'), status: 'draft', approvalRequired: true };
  }
}

module.exports = { CommercialService, CONTACT_CATEGORIES, normalizeMarkup, calculateMarkup, publicFacts, publicLine, formatPublicLines, zonedScheduleAllowed, normalizePhone };
