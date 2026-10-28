'use strict';

// Campaign membership is a declaration by the operator, not an inventory query
// or proof that two identical advertisements describe the same physical unit.
const { createHash } = require('node:crypto');
const normalize = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const stamp = value => { const at = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN; return Number.isSafeInteger(at) && at > 0 ? at : null; };
const quantity = item => { const n = item?.availability?.quantity ?? item?.quantityAvailable; return Number.isSafeInteger(n) && n >= 0 ? n : null; };
function campaignItemFingerprint(item = {}, campaign = {}, { source, media } = {}) {
  return createHash('sha256').update(JSON.stringify({ campaignId: campaign.id || null, item,
    source: item.sourcePublicationId ? source ? { id: source.id, status: source.status, revisionAt: source.revisionAt, originalAt: source.originalAt } : { missing: true } : null,
    media: item.mediaId ? media ? { id: media.id, sha256: media.sha256 || media.hash || null, path: media.path || media.filePath || null, size: media.size ?? null, status: media.status || null } : { missing: true } : null })).digest('hex');
}
function assessCampaignItem(item, campaign, { source, media, availabilityMode = 'campaign', manualSelection = false } = {}) {
  const blocked = (code, reason, available = false) => ({ eligible: false, blocker: { code, reason }, availabilityDeclared: false, availabilitySource: availabilityMode, available,
    availabilityConfirmedAt: null, quantityAvailable: quantity(item), identityReference: null });
  if (!item || !campaign || !item.id || !campaign.id) return blocked('OFFER_CAMPAIGN_ITEM_MISSING', 'O anúncio não está mais na campanha selecionada.');
  if (item.opportunityAvailable === false || item.excluded === true) return blocked('OFFER_EXCLUDED', 'Anúncio desativado para oportunidades.');
  if (item.captureDeleted || item.ready === false || item.captureStatus && item.captureStatus !== 'ready') return blocked('OFFER_ITEM_NOT_READY', 'O anúncio ainda não está pronto ou foi retirado.');
  if (!['text', 'image', 'video', 'document'].includes(item.type)) return blocked('OFFER_ITEM_NOT_SUPPORTED', 'Tipo de anúncio incompatível com as oportunidades.');
  const text = normalize(typeof item.caption === 'string' ? item.caption : item.text);
  const state = normalize(item.status || item.state || item.availability?.status);
  if (item.sold === true || item.reserved === true || ['sold', 'vendido', 'vendida', 'reserved', 'reservado', 'reservada', 'deleted', 'removed', 'cancelled', 'unavailable'].includes(state) || /\b(?:nao disponive(?:l|is)|indisponive(?:l|is)|esgotad[oa]s?|sem estoque|vendid[oa]s?|reservad[oa]s?|nao tenho mais)\b/.test(text)) return blocked('OFFER_UNAVAILABLE', 'O anúncio informa aparelho vendido, reservado ou indisponível.');
  if (item.available === false || item.availability?.available === false || quantity(item) === 0) return blocked('OFFER_UNAVAILABLE', 'O anúncio foi marcado como indisponível.');
  const conditional = /\b(?:sob encomenda|por encomenda|a confirmar|sujeito a disponibilidade|consulte (?:o )?estoque|consultar (?:o )?estoque)\b/.test(text);
  if (conditional && !manualSelection) return blocked('OFFER_AVAILABILITY_CONDITIONAL', 'Anúncio sob encomenda ou com disponibilidade a confirmar; revisão necessária.', null);
  if (item.sourcePublicationId) {
    if (!source) return blocked('OFFER_SOURCE_MISSING', 'A referência original do anúncio não está disponível; revise a campanha.');
    if (source.status !== 'ready') return blocked(source.status === 'removed' ? 'OFFER_SOURCE_REMOVED' : 'OFFER_SOURCE_NOT_READY', source.status === 'removed' ? 'A publicação original foi retirada; a cópia não pode ser oferecida automaticamente.' : 'A publicação original está pendente ou em revisão; confirme o conteúdo antes de oferecer.', source.status === 'removed' ? false : null);
    if (!Number.isSafeInteger(item.sourcePublicationRevision) || !Number.isSafeInteger(source.revisionAt) || item.sourcePublicationRevision < source.revisionAt) return blocked('OFFER_SOURCE_REVISION_STALE', 'A publicação original foi atualizada; esta cópia precisa de revisão.', null);
  }
  if (item.type !== 'text' && (!item.mediaId || !media || media.status === 'removed' || media.status === 'error')) return blocked('OFFER_MEDIA_MISSING', 'A mídia do anúncio não está disponível; revise antes de oferecer.', null);
  const stated = /\b(?:disponivel|disponiveis|pronta entrega|a pronta entrega|tenho em estoque|em estoque|ainda disponivel)\b/.test(text);
  const available = availabilityMode === 'campaign' || item.available === true || item.availability?.available === true || stated ? true : null;
  return { eligible: true, blocker: null, availabilityDeclared: availabilityMode === 'campaign', availabilitySource: availabilityMode, available, availabilityConditional: conditional,
    availabilityConfirmedAt: stamp(item.availability?.confirmedAt ?? item.availabilityConfirmedAt) || (stated ? stamp(source?.originalAt ?? item.sourceOriginalAt ?? item.originalAt ?? campaign.createdAt) : null),
    quantityAvailable: quantity(item), identityReference: `campaign-item:${item.id}` };
}
module.exports = { assessCampaignItem, campaignItemFingerprint };
