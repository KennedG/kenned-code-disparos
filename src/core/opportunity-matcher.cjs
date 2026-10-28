'use strict';

// Supplier and request messages are data. This deterministic parser never uses
// their contents as instructions, identities, permissions or executable code.
const { createHash } = require('node:crypto');
const { normalize, parseQuery, parseOffers } = require('./search-parser.cjs');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const MAX_REQUEST = 4096;
const CAPACITIES = new Set([32, 64, 128, 256, 512, 1024, 2048]);
const modelPatterns = [
  /\biphone\s+(?:\d{1,2}(?:\s+(?:pro\s+max|pro|plus|mini|air))?|(?:xs\s+max|xs|xr|x|se)(?:\s+20\d{2})?)\b/g,
  /\b(?:samsung\s+)?(?:galaxy\s+)?[samf]\s*\d{1,2}(?:\s+(?:ultra|plus|fe))?(?:\s+[45]\s+g)?\b/g,
  /\b(?:samsung\s+)?(?:galaxy\s+)?note\s*\d{1,2}(?:\s+(?:ultra|plus))?\b/g,
  /\b(?:samsung\s+)?(?:galaxy\s+)?z\s*(?:fold|flip)\s*\d{1,2}\b/g,
  /\b(?:xiaomi\s+)?(?:redmi\s+note|poco\s+[xfm])\s*\d{1,2}(?:\s+(?:pro\s+plus|pro|plus))?\b/g,
];

function closureRequest(text) {
  const value = normalize(text).replace(/\s+/g, ' ').trim();
  const closures = new Set(['ja consegui', 'consegui', 'achei', 'nao preciso mais', 'pode cancelar', 'pode cancelar o pedido', 'pode cancelar minha procura', 'ja achei', 'ja encontrei', 'encontrei']);
  return closures.has(value) ? { closure: true, closureType: value, recognized: false, complete: false, safe: false, needsReview: false, models: [], reviewReasons: [], intentConfidence: 'none', intentReasons: ['request_closed'], intentKey: null, familyKey: null } : null;
}

function priceToCents(value) {
  const amount = Number(String(value).replace(/\s/g, '').replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(amount) && amount > 0 && amount <= 1000000 ? Math.round(amount * 100) : null;
}

function requestInput(raw, aliases) {
  // Parse BRL before punctuation folding so 3.500,00 is not mistaken for a
  // capacity or divided into three unrelated numbers.
  let text = raw.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  text = text.replace(/\b(?:ate|maximo(?: de)?|orcamento(?: de)?)\s*[:=-]?\s*(?:R\s*\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{2})?|\d{1,6}(?:,\d{2})?)(?![\d.]|,\d)/gi, (_, amount) => ` maxbudget ${priceToCents(amount) || 'invalid'} `);
  text = text.replace(/\b(\d{1,3})\s*(?:unidades?|aparelhos?|pecas?|un)\b/gi, ' quantidadepedido $1 ');
  text = text.replace(/\b(\d{1,3})\s+(?=iPhones?\b|Samsung\b|Galaxy\b)/gi, (match, quantity, offset, input) => /quantidadepedido\s*$/.test(input.slice(0, offset)) ? match : ` quantidadepedido ${quantity} `);
  text = text.replace(/\biphones\b/gi, 'iPhone');
  text = normalize(text, aliases);
  // Established shop shorthand: "13 Pro 256" or "13 128GB". A bare number
  // alone does not establish an iPhone family or version.
  text = text.replace(/(?<!iphone\s)\b(\d{1,2})\s+(pro\s+max|pro|plus|mini|air)\b/g, 'iphone $1 $2');
  text = text.replace(/(?<!iphone\s)\b(\d{1,2})\s+(?=(?:32|64|128|256|512|1024|2048)\s*(?:gb|tb)?\b)/g, 'iphone $1 ');
  return text;
}

function modelSpans(text) {
  const spans = [];
  for (const pattern of modelPatterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) spans.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return spans.sort((a, b) => a.start - b.start || b.end - a.end).filter((span, index, all) => !all.slice(0, index).some(previous => span.start >= previous.start && span.end <= previous.end));
}

function uniqueValues(text, regexp, transform = value => Number(value)) {
  return [...new Set([...text.matchAll(regexp)].map(match => transform(match[1])))];
}

function parseSpec(model, tail, prefix, aliases) {
  const reasons = [];
  const budgets = uniqueValues(tail, /\bmaxbudget\s+(\d+)\b/g);
  // Do not carry the preceding model's quantity into the next member of a
  // request. Only a quantity immediately before this model can qualify it.
  const quantityPrefix = prefix.match(/\bquantidadepedido\s+\d+\s*$/)?.[0] || '';
  const quantities = uniqueValues(`${quantityPrefix} ${tail}`, /\bquantidadepedido\s+(\d+)\b/g);
  let rest = tail.replace(/\bmaxbudget\s+(?:\d+|invalid)\b/g, ' ').replace(/\bquantidadepedido\s+\d+\b/g, ' ');
  if (/\bmaxbudget\s+invalid\b/.test(tail)) reasons.push('invalid_budget');
  if (budgets.length > 1) reasons.push('ambiguous_budget');
  if (quantities.length > 1 || quantities.some(value => value < 1 || value > 1000)) reasons.push('ambiguous_quantity');
  let minBattery = null;
  const batteries = [...new Set([...rest.matchAll(/\b(?:bateria|saude(?: da bateria)?|battery)\s*(minima|minimo|min|de|acima de|a partir de)?\s*(\d{1,3})\b/g)]
    .map(match => Number(match[2]) + (match[1] === 'acima de' ? 1 : 0)))];
  if (batteries.length > 1 || batteries.some(value => value > 100)) reasons.push('ambiguous_battery');
  else if (batteries.length === 1) minBattery = batteries[0];
  rest = rest.replace(/\b(?:bateria|saude(?: da bateria)?|battery)\s*(?:minima|minimo|min|de|acima de|a partir de)?\s*\d{1,3}\s*(?:por cento)?\b/g, ' ');
  rest = rest.replace(/\b(32|64|128|256|512|1024|2048)\b(?!\s*(?:gb|tb)\b)/g, '$1 gb');
  rest = rest.replace(/\b(?:para (?:um )?cliente|para meu cliente|pronta entrega|disponivel|disponiveis|urgente)\b/g, ' ');
  rest = rest.replace(/\b(?:alguem|quem|tem|teria|consegue|conseguiria|procuro|procurando|busco|buscando|preciso|precisando|quero|queria|necessito|compro|compraria|comprar|voces|voce|vcs|vc|de|um|uma|algum|alguma|por favor|favor|bom dia|boa tarde|boa noite|pessoal|galera|para hoje|hoje|ai|ainda|com|e|ou)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const query = parseQuery(`${model} ${rest}`, { aliases });
  if (!query.valid) reasons.push(...query.errors.map(() => 'request_constraints_unclear'));
  const knownStorages = query.storageGB == null || CAPACITIES.has(query.storageGB) || /\btb\b/.test(rest);
  if (!knownStorages) reasons.push('unsupported_storage');
  return {
    model: query.model, modelKey: query.modelKey, storageGB: query.storageGB, color: query.color, colorKey: query.colorKey,
    condition: query.condition, minBattery, batteryMin: minBattery,
    maxPriceCents: budgets.length === 1 ? budgets[0] : null, priceMaxCents: budgets.length === 1 ? budgets[0] : null,
    quantity: quantities.length === 1 && quantities[0] >= 1 && quantities[0] <= 1000 ? quantities[0] : null,
    complete: query.valid && reasons.length === 0, reviewReasons: [...new Set(reasons)],
  };
}

function classifyPurchaseIntent(raw, { text, spans, models } = {}) {
  // A question mark alone is not buying intent. Advertisements, technical
  // questions and opinion requests can mention the same exact model as a
  // genuine search. Keep every decision deterministic and explainable.
  const body = text ?? requestInput(String(raw ?? ''));
  const references = spans ?? modelSpans(body);
  const candidates = models ?? [];
  const result = (confidence, code, recognized = confidence !== 'none') => ({ intentConfidence: confidence, intentReasons: [code], recognized });
  if (!references.length) return result('none', 'model_not_recognized');
  const procurement = /\b(?:quem|alguem|voces|voce|vcs|vc)\s+(?:ai\s+)?(?:tem|teria|consegue|conseguiria)\b/.test(body);
  const explicit = /\b(?:procuro|procurando|busco|buscando|preciso|precisando|necessito|compro|compraria|quero|queria|comprar)\b/.test(body);
  const first = references[0], last = references.at(-1);
  const directQuestion = /\b(?:tem|teria|consegue|conseguiria)\s+(?:um\s+|uma\s+|algum\s+|alguma\s+)?$/.test(body.slice(0, first.start).trim()) || /^\s*(?:quem\s+|alguem\s+)?(?:tem|teria)\b/.test(body.slice(last.end));
  const buying = procurement || explicit || directQuestion;
  if (/\b(?:nao quero|nao preciso(?: mais)?|nao procuro|nao estou (?:mais )?procurando|ja consegui|ja achei|ja encontrei|pode cancelar)\b/.test(body)) return result('none', 'negative_or_closed_request');
  if (/\b(?:vale a pena|compensa|qual (?:e )?(?:o )?melhor|recomenda|recomendam|opiniao|comparacao|comparando|comparar|versus|vs|diferenca|quanto vale|preco de revenda|por quanto (?:vendo|revendo)|quero saber|queria saber|preciso saber|como (?:usar|configurar|formatar|resetar|desbloquear|arrumar))\b/.test(body)) return result('none', 'discussion_not_purchase');
  if (/\b(?:conserto|consertar|reparo|reparar|assistencia|assistencia tecnica|desbloqueio|desbloquear|display|carcaca|pelicula|capinha|carregador|cabo|acessorio|acessorios)\b/.test(body) || /\b(?:troca|trocar|trocando)\s+(?:(?:a|o|de|do|da)\s+)*(?:tela|bateria|camera|conector)\b/.test(body) || /\b(?:tela|bateria|camera|conector)\s+(?:(?:de|do|da)\s+)?(?:iphone|samsung|galaxy)\b/.test(body)) return result('none', 'service_or_accessory_not_phone_request');
  if (/\b(?:tem (?:um )?defeito|tem problema|esta com problema|nao liga|nao carrega|esquentando|travando|parou de funcionar)\b/.test(body)) return result(buying ? 'ambiguous' : 'none', 'technical_context_needs_review');
  const seller = /\b(?:tenho|vendo|vendendo|venda|a vista|parcelas?|entrada|quem quer|alguem quer|tem interesse|estou com)\b/.test(body) || !buying && /\b(?:disponivel|disponiveis|pronta entrega)\b/.test(body);
  const statedPrice = /\br\s*\$/i.test(raw) && !/\bmaxbudget\b/.test(body);
  if (seller || statedPrice) return result(buying && !/\b(?:quem quer|alguem quer|tem interesse)\b/.test(body) ? 'ambiguous' : 'none', 'seller_or_mixed_intent');
  if (buying) return result('high', explicit ? 'explicit_purchase_request' : 'availability_request');
  // Accepted shop shorthand must contain nothing beyond known product
  // constraints and a question mark. Unknown words are retained for review.
  if (/\?/.test(raw) && candidates.length && candidates.every(model => model.complete)) return result('high', 'product_question_shorthand');
  if (/\?/.test(raw)) return result('ambiguous', 'purchase_intent_unclear');
  return result('none', 'no_purchase_intent');
}

function parseRequest(raw, { aliases } = {}) {
  if (typeof raw !== 'string' || raw.length > MAX_REQUEST) return { recognized: false, complete: false, safe: false, needsReview: false, models: [], reviewReasons: ['request_too_long'], intentConfidence: 'none', intentReasons: ['request_too_long'], intentKey: null, familyKey: null };
  const closure = closureRequest(raw); if (closure) return closure;
  const text = requestInput(raw, aliases), spans = modelSpans(text);
  if (!spans.length) return { recognized: false, complete: false, safe: false, needsReview: false, models: [], reviewReasons: ['model_not_recognized'], intentConfidence: 'none', intentReasons: ['model_not_recognized'], intentKey: null, familyKey: null, closure: false };
  const models = spans.slice(0, 10).map((span, index) => {
    const prefix = text.slice(index ? spans[index - 1].end : 0, span.start);
    let tail = text.slice(span.end, spans[index + 1]?.start ?? text.length);
    if (spans[index + 1]) tail = tail.replace(/\b(?:e|ou)\s+quantidadepedido\s+\d+\s*$/, ' ');
    return parseSpec(span.text, index ? tail : `${prefix} ${tail}`, index ? prefix : '', aliases);
  });
  const intent = classifyPurchaseIntent(raw, { text, spans, models });
  const reasons = [...new Set([...models.flatMap(model => model.reviewReasons), ...(intent.intentConfidence === 'high' ? [] : intent.intentReasons)])];
  if (spans.length > 10) reasons.push('too_many_requested_models');
  const canonical = models.map(model => [model.modelKey, model.storageGB, model.colorKey, model.condition, model.minBattery, model.maxPriceCents, model.quantity]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const complete = intent.recognized && intent.intentConfidence === 'high' && reasons.length === 0 && models.every(model => model.complete);
  return { ...intent, complete, safe: complete, needsReview: intent.recognized && !complete, models,
    reviewReasons: reasons, intentKey: digest(canonical), familyKey: digest([...new Set(models.map(model => model.modelKey))].sort()), closure: false,
    originalText: raw };
}

function validReference(value) { return typeof value === 'string' && value.trim() && value.length <= 512 ? value.trim() : null; }
function explicitUnitReference(item) {
  const value = validReference(item.unitReference || item.imei || item.serialNumber || item.serial || item.originalOfferId || item.offerReference || item.originalReference?.offerId);
  // Retain a comparable pseudonymous reference; do not expose serials/IMEIs
  // in summaries or diagnostic entries merely to compare unit identities.
  return value ? digest(['declared-unit-reference', value]) : null;
}
function materialFingerprint(text) {
  let body = String(text).normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  body = body.replace(/\bR\s*\$\s*\d[\d.,]*/gi, ' valoranunciado ')
    .replace(/\b\d{1,3}(?:\.\d{3})+(?:,\d{2})?\b/g, ' valoranunciado ')
    .replace(/\b\d{1,6},\d{2}\b/g, ' valoranunciado ')
    .replace(/\b\d{3,6}\b(?!\s*(?:gb|tb|mah|ciclos)\b)/gi, ' valoranunciado ');
  body = normalize(body).replace(/\b(?:disponivel|disponiveis|ainda disponivel|pronta entrega|hoje|amanha)\b/g, ' ').replace(/\s+/g, ' ').trim();
  // This compares actual advertising material, never just a model key. The
  // ledger must use it only to flag possible republications for review; it is
  // not proof that two advertised physical units are the same.
  return body ? digest(['announcement-material', body]) : null;
}
function stableOfferIdentity(item = {}, campaign = {}, media = {}, { offer = {}, ordinal = 0 } = {}) {
  const groupId = validReference(item.sourceGroupId || item.originalGroupId || item.originalReference?.groupId);
  const messageId = validReference(item.sourceMessageId || item.originalMessageId || item.originalReference?.messageId);
  const publicationId = validReference(item.sourcePublicationId || item.originalReference?.publicationId);
  const originalReference = groupId && messageId ? { groupId, messageId, ...(publicationId ? { publicationId } : {}) } : null;
  const source = originalReference ? ['message', groupId, messageId] : publicationId ? ['publication', publicationId] : null;
  const serial = validReference(item.unitReference || item.imei || item.serialNumber || item.serial);
  // A structured unit reference is stronger than a message that advertises
  // multiple units. Serial values are hashed and are not exposed in diagnostics.
  if (serial) return { offerKey: digest(['unit', serial]), identityConfidence: 'verified', identityReason: 'explicit_unit_reference', explicitUnitReference: explicitUnitReference(item), originalReference };
  const explicitId = validReference(item.originalOfferId || item.offerReference || item.originalReference?.offerId);
  if (explicitId) return { offerKey: digest(['original-offer', explicitId]), identityConfidence: 'verified', identityReason: 'explicit_original_reference', explicitUnitReference: explicitUnitReference(item), originalReference };
  if (source) return { offerKey: digest([...source, 'option', ordinal]), identityConfidence: 'verified', identityReason: 'original_message_reference', explicitUnitReference: null, originalReference };
  const mediaHash = typeof media?.sha256 === 'string' && /^[a-f\d]{64}$/i.test(media.sha256) ? media.sha256 : typeof item.mediaFingerprint === 'string' && /^[a-f\d]{64}$/i.test(item.mediaFingerprint) ? item.mediaFingerprint : typeof media?.hash === 'string' && /^[a-f\d]{64}$/i.test(media.hash) ? media.hash : null;
  // A photo, model or identical text cannot establish that two physical units
  // are the same. Candidate identity is for manual review, never auto sending.
  return { offerKey: digest(['unverified-candidate', item.id || null, mediaHash, offer.modelKey || null, offer.storageGB ?? null, ordinal]),
    identityConfidence: 'review', identityReason: 'unit_identity_unconfirmed', explicitUnitReference: null, originalReference };
}

function timestamp(value) { const n = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN; return Number.isSafeInteger(n) && n > 0 ? n : null; }
function singleAnnouncementDetails(rawText, offer, aliases) {
  // A shop announcement commonly puts these labelled attributes before the
  // price. The shared multi-product parser cannot safely carry arbitrary lines
  // through a list; here there is exactly one parsed offer and one model.
  const spans = modelSpans(normalize(rawText, aliases));
  if (new Set(spans.map(span => span.text)).size > 1) return offer;
  const values = { colorKey: [], storageGB: [], condition: [], batteryPercent: [] };
  for (const line of String(rawText).split(/\r?\n/)) {
    const folded = line.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
    const label = folded.match(/^(cor|color|memoria|armazenamento|capacidade|condicao)\s*[:=\-]\s*(.+)$/i);
    if (label) {
      const q = parseQuery(`${offer.model} ${label[2]}`, { aliases });
      if (q.valid) {
        const field = /^(cor|color)$/i.test(label[1]) ? 'colorKey' : /^condicao$/i.test(label[1]) ? 'condition' : 'storageGB';
        if (q[field] != null) values[field].push({ value: q[field], color: q.color });
      }
    }
    const battery = normalize(line, aliases).match(/^(?:saude(?: da bateria)?|bateria|battery)\s*(?:em|de)?\s*(\d{1,3})\b/);
    if (battery && Number(battery[1]) <= 100) values.batteryPercent.push({ value: Number(battery[1]) });
  }
  const result = { ...offer }, reasons = [...(offer.reviewReasons || [])];
  for (const [field, found] of Object.entries(values)) {
    const unique = [...new Set(found.map(value => value.value))];
    if (!unique.length) continue;
    if (unique.length > 1 || offer[field] != null && offer[field] !== unique[0]) {
      result[field] = null; if (field === 'colorKey') result.color = null;
      reasons.push(`ambiguous_labelled_${field}`); result.confidence = 'review'; continue;
    }
    result[field] = unique[0]; if (field === 'colorKey') result.color = found.find(value => value.value === unique[0]).color;
  }
  result.reviewReasons = [...new Set(reasons)];
  result.productKey = [result.modelKey, result.storageGB ?? '?', result.colorKey ?? '?', result.condition ?? '?'].join('|');
  return result;
}
function parseCampaignOffer(item = {}, campaign = {}, media = {}, options = {}) {
  if (item.captureDeleted === true || item.ready === false || item.captureStatus && item.captureStatus !== 'ready' || !['text', 'image', 'video', 'document'].includes(item.type)) return [];
  const rawText = typeof item.caption === 'string' ? item.caption : typeof item.text === 'string' ? item.text : '';
  if (!rawText || rawText.length > 262144) return [];
  // A sentence delimiter after an integer is not a decimal comma. The shared
  // parser deliberately rejects malformed decimal notation; retain that rule
  // while allowing "R$3000, 2 unidades" with its original text preserved.
  const parsed = parseOffers(rawText.replace(/(\d),(?=\s|$)/g, '$1;'), { aliases: options.aliases });
  const availability = item.availability && typeof item.availability === 'object' ? item.availability : {};
  const normalized = normalize(rawText, options.aliases);
  const statedUnavailable = /\b(?:nao disponive(?:l|is)|indisponive(?:l|is)|esgotad[oa]s?|sem estoque|vendid[oa]s?|reservad[oa]s?|nao tenho mais)\b/.test(normalized);
  const statedAvailable = /\b(?:disponivel|disponiveis|pronta entrega|a pronta entrega|tenho em estoque|em estoque|ainda disponivel)\b/.test(normalized);
  const conditionalAvailability = /\b(?:sob encomenda|por encomenda|a confirmar|sujeito a disponibilidade|consulte (?:o )?estoque|consultar (?:o )?estoque)\b/.test(normalized);
  const available = statedUnavailable || availability.available === false || item.available === false ? false : conditionalAvailability ? null : availability.available === true || item.available === true || statedAvailable ? true : null;
  const availabilityConfirmedAt = timestamp(availability.confirmedAt ?? item.availabilityConfirmedAt) || (statedAvailable ? timestamp(options.originalAt ?? item.sourceOriginalAt ?? item.originalAt ?? campaign.createdAt) : null);
  let quantityAvailable = Number.isSafeInteger(availability.quantity) && availability.quantity >= 0 ? availability.quantity : Number.isSafeInteger(item.quantityAvailable) && item.quantityAvailable >= 0 ? item.quantityAvailable : null;
  if (quantityAvailable === null && parsed.length === 1) {
    const quantities = uniqueValues(normalized, /\b(?:quantidade|disponiveis|estoque)\s*(\d{1,4})\b/g);
    for (const match of normalized.matchAll(/\b(\d{1,4})\s*(?:unidades?|aparelhos?|pecas?)\s*(?:disponiveis|em estoque)?\b/g)) quantities.push(Number(match[1]));
    const unique = [...new Set(quantities)]; if (unique.length === 1) quantityAvailable = unique[0];
  }
  return parsed.map((originalOffer, ordinal) => {
    const offer = parsed.length === 1 ? singleAnnouncementDetails(rawText, originalOffer, options.aliases) : originalOffer;
    const identity = stableOfferIdentity(item, campaign, media, { offer, ordinal });
    if (parsed.length > 1) {
      // Without one original unit reference per option, reordered/edited list
      // rows cannot safely establish which physical unit was offered before.
      identity.identityConfidence = 'review'; identity.identityReason = 'multiple_original_options_need_unit_references';
      identity.offerKey = digest(['multiple-options', identity.offerKey, ordinal]);
    }
    const mediaFingerprint = [media?.sha256, item.mediaFingerprint, media?.hash].find(value => typeof value === 'string' && /^[a-f\d]{64}$/i.test(value)) || null;
    const candidate = { ...offer, ...(parsed.length === 1 ? { originalExcerpt: rawText } : {}), ...identity, id: identity.offerKey, offerId: identity.offerKey, campaignId: campaign.id ?? null, itemId: item.id ?? null,
      rawText, contentFingerprint: materialFingerprint(rawText), mediaFingerprint, available, availabilityConditional: conditionalAvailability, availabilityConfirmedAt, quantityAvailable, originalAt: timestamp(options.originalAt ?? item.sourceOriginalAt ?? item.originalAt) };
    candidate.offerRevision = digest([offer.modelKey, offer.storageGB, offer.colorKey, offer.condition, offer.batteryPercent, offer.priceCents, offer.priceKind, rawText, quantityAvailable]);
    return candidate;
  });
}

function matchOffer(spec, offer, { now = Date.now(), availabilityMaxAgeMinutes = 120, availabilityTTL, availabilityMode = 'confirmed' } = {}) {
  const blocked = (code, reason, needsReview = false) => ({ eligible: false, code, reason, needsReview });
  if (!spec?.modelKey || spec.complete === false || spec.reviewReasons?.length) return blocked('REQUEST_NEEDS_REVIEW', 'O pedido precisa de revisão antes de uma resposta automática.', true);
  if (!offer?.modelKey || spec.modelKey !== offer.modelKey) return blocked('MODEL_MISMATCH', 'O modelo ou a versão é diferente do pedido.');
  for (const [field, label] of [['storageGB', 'memória'], ['colorKey', 'cor'], ['condition', 'condição']]) {
    if (spec[field] != null && offer[field] == null) return blocked('OFFER_ATTRIBUTE_UNKNOWN', `A ${label} solicitada não está confirmada na oferta.`, true);
    if (spec[field] != null && spec[field] !== offer[field]) return blocked('OFFER_ATTRIBUTE_MISMATCH', `A ${label} é diferente da solicitada.`);
  }
  const minBattery = spec.minBattery ?? spec.batteryMin;
  if (minBattery != null && offer.batteryPercent == null) return blocked('BATTERY_UNKNOWN', 'A saúde da bateria solicitada não está confirmada.', true);
  if (minBattery != null && offer.batteryPercent < minBattery) return blocked('BATTERY_TOO_LOW', 'A bateria está abaixo do mínimo solicitado.');
  if (offer.confidence !== 'confirmed' || !Number.isSafeInteger(offer.priceCents) || offer.priceCents <= 0 || offer.priceKind !== 'cash') return blocked('TOTAL_PRICE_UNCONFIRMED', 'O preço total à vista não está confirmado.', true);
  const maxPrice = spec.maxPriceCents ?? spec.priceMaxCents;
  if (maxPrice != null && offer.priceCents > maxPrice) return blocked('PRICE_TOO_HIGH', 'O preço está acima do orçamento solicitado.');
  if (offer.unavailable || offer.captureDeleted === true || ['unavailable', 'deleted', 'cancelled', 'sold', 'reserved'].includes(offer.status) || offer.available === false || offer.quantityAvailable === 0) return blocked('OFFER_UNAVAILABLE', 'A oferta não está disponível.');
  if (offer.available !== true || offer.availabilityConditional === true) return blocked('AVAILABILITY_UNCONFIRMED', 'Disponibilidade precisa de confirmação.', true);
  const campaignMode = availabilityMode === 'campaign';
  if (campaignMode && offer.campaignEligible !== true) return blocked('CAMPAIGN_ITEM_UNCONFIRMED', 'A oferta precisa pertencer a uma campanha selecionada e continuar habilitada.', true);
  if (!campaignMode) {
    const at = timestamp(offer.availabilityConfirmedAt);
    const maxAgeMs = availabilityTTL ?? Number(availabilityMaxAgeMinutes) * 60000;
    if (!at || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || at > now + 30000 || now - at > maxAgeMs) return blocked('AVAILABILITY_STALE', 'Disponibilidade precisa de confirmação: a última atualização venceu ou não tem horário confiável.', true);
  }
  if (spec.quantity > 1 && !Number.isSafeInteger(offer.quantityAvailable)) return blocked('QUANTITY_UNKNOWN', 'A quantidade disponível não está confirmada.', true);
  if (spec.quantity > 1 && offer.quantityAvailable < spec.quantity) return blocked('QUANTITY_INSUFFICIENT', 'A quantidade disponível é menor que a solicitada.');
  if (offer.identityConfidence !== 'verified' && !(campaignMode && offer.identityConfidence === 'campaign')) return blocked('OFFER_IDENTITY_UNCONFIRMED', 'A unidade ou referência original da oferta precisa de confirmação.', true);
  return { eligible: true, code: 'MATCH_CONFIRMED', reason: campaignMode ? 'Pedido exato e item habilitado em uma campanha selecionada.' : 'Pedido e oferta compatíveis com disponibilidade confirmada.', needsReview: false };
}

module.exports = { parseRequest, classifyPurchaseIntent, closureRequest, parseCampaignOffer, matchOffer, stableOfferIdentity, materialFingerprint };
