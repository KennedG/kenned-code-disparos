'use strict';

// The commercial branch added these structured links and execution policies.
// This application preserves the records but cannot safely apply those rules.
// Inspect fields, never the user's announcement text or a display name.
const REFERENCE_FIELDS = Object.freeze([
  'commercialListId', 'commercialRef', 'inventoryId', 'inventoryIds',
  'inventoryRefs', 'stockId', 'stockIds', 'stockRefs', 'contactIds', 'promotionPolicy'
]);
function present(value) {
  if (value === undefined || value === null || value === false || value === '') return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}
function campaignVersionFeatures(campaign, queuedItem) {
  const found = new Set();
  const inspect = (record, scope) => {
    if (!record || typeof record !== 'object') return;
    for (const field of REFERENCE_FIELDS) if (present(record[field])) found.add(`${scope}.${field}`);
    if (record.oneShot === true) found.add(`${scope}.oneShot`);
    if (['retail', 'wholesale'].includes(record.audience)) found.add(`${scope}.audience`);
  };
  inspect(campaign, 'campaign');
  for (const item of Array.isArray(campaign?.items) ? campaign.items : []) inspect(item, 'item');
  for (const override of Object.values(campaign?.groupOverrides || {})) {
    inspect(override, 'groupOverride');
    for (const item of Array.isArray(override?.items) ? override.items : []) inspect(item, 'groupItem');
  }
  inspect(queuedItem, 'queuedItem');
  return [...found];
}
function assertCampaignSchemaCompatible(campaign, queuedItem) {
  const fields = campaignVersionFeatures(campaign, queuedItem);
  if (!fields.length) return;
  throw Object.assign(new Error('Este cadastro usa vínculos ou regras da versão comercial que esta versão não executa. O cadastro original foi preservado. Crie uma campanha ou um modelo comum revisado, sem esses vínculos, antes de enviar.'), {
    code: 'CAMPAIGN_VERSION_REVIEW', definitive: true, submitted: false,
    safeToRetry: false, reviewRequired: true, fields
  });
}
module.exports = { campaignVersionFeatures, assertCampaignSchemaCompatible };
