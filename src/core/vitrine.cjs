'use strict';

const { createHash, randomUUID } = require('node:crypto');
const QRCode = require('qrcode');
const fs = require('node:fs');
const { parseOffers } = require('./search-parser.cjs');

const fault = (message, code, details) => Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
const copy = value => JSON.parse(JSON.stringify(value));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const DEFAULTS = Object.freeze({ brandName: 'Kenned Code Disparos', commercialContact: '', whatsappUrl: '', wholesaleUrl: '', secondsPerItem: 10, audience: 'retail', wholesaleCall: 'Consulte nossa lista para lojistas', updatedAt: null });
const defectPattern = /\b(?:defeito|detalhe|trinc|risc|quebrad|mancha|avari|amass|marcas?\s+de\s+uso|face\s*id\s+(?:n[aã]o|sem)|sem\s+face\s*id|n[aã]o\s+funciona|tela\s+(?:trocada|substitu[ií]da)|bateria\s+(?:trocada|substitu[ií]da)|pe[çc]a\s+(?:trocada|substitu[ií]da))/i;
const privatePattern = /\b(?:imei|serial|n[uú]mero\s+de\s+s[eé]rie|custo|margem|lucro|fornecedor|comprador|token|senha|chave\s+(?:de\s+)?licen[çc]a)\b/i;
const phonePattern = /(?:\+?\d[\s().-]*){10,15}/;

function text(value, max, label, required = false) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value) || required && !value.trim()) throw fault(`Informe ${label} válido.`, 'VITRINE_INVALID');
  return value.trim();
}
function publicText(value, max, label, required = false) {
  const result = text(value, max, label, required);
  if (privatePattern.test(result) || phonePattern.test(result)) throw fault(`${label} contém informação interna ou contato. Use somente a descrição pública do produto; o contato comercial é configurado separadamente.`, 'VITRINE_PRIVATE_CONTENT');
  return result;
}
function safeUrl(value) {
  value = text(value, 2048, 'um endereço público HTTPS');
  if (!value) return '';
  let url; try { url = new URL(value); } catch { throw fault('Informe um endereço HTTPS válido para o QR code.', 'VITRINE_URL_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.hostname.includes('.') || /^(?:localhost|127\.|0\.|10\.|192\.168\.|169\.254\.)/i.test(url.hostname)) throw fault('Use um endereço público HTTPS sem credenciais para o QR code.', 'VITRINE_URL_INVALID');
  if (url.hostname === 'wa.me' && !/^\/\d{10,15}$/.test(url.pathname)) throw fault('O link wa.me deve conter somente o telefone com código do país e DDD.', 'VITRINE_URL_INVALID');
  if ([...url.searchParams.keys()].some(key => /token|password|senha|secret|chave|api.?key/i.test(key))) throw fault('O endereço do QR code não pode conter credenciais.', 'VITRINE_URL_INVALID');
  return url.toString();
}
function normalizeConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fault('Configuração da vitrine inválida.', 'VITRINE_INVALID');
  const secondsPerItem = Number(input.secondsPerItem ?? 10);
  if (!Number.isFinite(secondsPerItem) || secondsPerItem < 3 || secondsPerItem > 300) throw fault('O tempo por anúncio deve estar entre 3 e 300 segundos.', 'VITRINE_INTERVAL_INVALID');
  const audience = input.audience ?? 'retail';
  if (!['retail', 'wholesale', 'mixed'].includes(audience)) throw fault('Escolha Varejo, Atacado ou Misto.', 'VITRINE_AUDIENCE_INVALID');
  const commercialContact = text(input.commercialContact, 80, 'um contato comercial');
  if (commercialContact && (!/^[+\d\s().-]+$/.test(commercialContact) || commercialContact.replace(/\D/g, '').length < 10 || commercialContact.replace(/\D/g, '').length > 15)) throw fault('Informe o telefone comercial com DDD; ele será exibido publicamente.', 'VITRINE_CONTACT_INVALID');
  return { brandName: publicText(input.brandName ?? DEFAULTS.brandName, 120, 'um nome comercial', true), commercialContact, whatsappUrl: safeUrl(input.whatsappUrl), wholesaleUrl: safeUrl(input.wholesaleUrl), secondsPerItem, audience, wholesaleCall: publicText(input.wholesaleCall ?? DEFAULTS.wholesaleCall, 180, 'uma chamada para lojistas'), updatedAt: Number.isSafeInteger(input.updatedAt) && input.updatedAt >= 0 ? input.updatedAt : null };
}
function requiredDefects(caption) {
  // Observations are mandatory public information. The original caption is
  // never modified; unrelated supplier names and contacts are never copied.
  return String(caption || '').split(/\r?\n/).map(line => line.trim()).filter(line => line && defectPattern.test(line));
}
function sourceHash(campaign, item, media) {
  return digest({ campaignId: campaign.id, item: { id: item.id, type: item.type, mediaId: item.mediaId, text: item.text ?? '', caption: item.caption ?? '', sourceMetadata: item.sourceMetadata ?? null }, media: { id: media?.id, sha256: media?.sha256, type: media?.type } });
}

class VitrineService {
  constructor({ store, media, now = () => Date.now(), assertAccess, isLicensed, qrCode = QRCode.toDataURL } = {}) {
    if (!store?.getSetting || !store?.setSetting) throw new Error('Armazenamento persistente da vitrine é obrigatório.');
    this.store = store; this.media = media; this.now = now; this.assertAccess = assertAccess; this.isLicensed = isLicensed; this.qrCode = qrCode; this.previews = new Map();
  }
  _key(name) { return `mode:${this.store.getStorageMode?.() || 'whatsapp'}:vitrine:${name}`; }
  _read(name, fallback) { return copy(this.store.getSetting(this._key(name), fallback)); }
  _write(name, value) { this.store.setSetting(this._key(name), copy(value)); const saved = this._read(name, null); if (digest(saved) !== digest(value)) throw fault('Não foi possível persistir a vitrine. Verifique o armazenamento.', 'VITRINE_PERSIST_FAILED'); return saved; }
  _assert(action, actorId, campaign) { if (typeof this.assertAccess !== 'function') throw fault('A validação de permissões da vitrine está indisponível.', 'AUTH_REQUIRED'); return this.assertAccess(action, actorId, campaign); }
  _licensed() { if (typeof this.isLicensed !== 'function') return false; try { return this.isLicensed() === true; } catch { return false; } }
  _requireLicense() { if (!this._licensed()) throw fault('Renove sua licença para utilizar a vitrine. Seus dados estão preservados.', 'LICENSE_REQUIRED'); }
  _draft() { return this._read('draft', { config: DEFAULTS, items: [], revision: 0 }); }
  _source(campaignId, itemId, actorId, checkPermission = true) {
    const campaign = this.store.getCampaign(campaignId), item = campaign?.items?.find(value => value.id === itemId);
    if (!campaign || !item) throw fault('O anúncio de origem foi excluído. Retire o item da vitrine ou selecione outro.', 'VITRINE_SOURCE_MISSING');
    if (checkPermission) this._assert('source', actorId, campaign);
    const publication=item.sourcePublicationId&&this.store.getSourcePublication?.(item.sourcePublicationId);
    if(item.captureDeleted||item.ready===false||publication&&(publication.status!=='ready'||Number.isSafeInteger(publication.revisionAt)&&(!Number.isSafeInteger(item.sourcePublicationRevision)||item.sourcePublicationRevision<publication.revisionAt)))throw fault('A publicação de origem foi retirada, está pendente ou foi alterada; revise antes de exibir.', 'VITRINE_SOURCE_UNAVAILABLE');
    const media = item.mediaId && this.store.getMedia(item.mediaId);
    if (item.type !== 'image' || !media || media.type !== 'image') throw fault('Selecione um anúncio com imagem gerenciada disponível.', 'VITRINE_IMAGE_REQUIRED');
    try { if (this.media) this.media.getPath(media.id); else if (!media.path || !fs.statSync(media.path).isFile()) throw new Error('Imagem ausente'); } catch { throw fault('A foto gerenciada não está disponível. Confira a biblioteca antes de publicar.', 'VITRINE_IMAGE_MISSING'); }
    return { campaign, item, media, sourceHash: sourceHash(campaign, item, media), caption: item.caption || item.text || '' };
  }
  _normalizeItems(input, actorId) {
    if (!Array.isArray(input) || input.length > 1000) throw fault('Selecione até 1.000 anúncios para a vitrine.', 'VITRINE_ITEMS_INVALID');
    const ids = new Set(), references = new Set();
    return input.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault('Um anúncio da vitrine está inválido.', 'VITRINE_ITEMS_INVALID');
      const campaignId = text(value.campaignId, 512, 'a campanha de origem', true), itemId = text(value.itemId, 512, 'o item de origem', true), id = text(value.id || randomUUID(), 512, 'o identificador', true), reference = `${campaignId}\0${itemId}`;
      if (ids.has(id) || references.has(reference)) throw fault('O mesmo anúncio foi selecionado mais de uma vez.', 'VITRINE_DUPLICATE'); ids.add(id); references.add(reference);
      const source = this._source(campaignId, itemId, actorId), audience = value.audience ?? 'retail';
      if (!['retail', 'wholesale', 'both'].includes(audience)) throw fault('Público do anúncio inválido.', 'VITRINE_AUDIENCE_INVALID');
      const price = (amount, label) => { if (amount === '' || amount === null || amount === undefined) return null; if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100000000) throw fault(`Informe ${label} em centavos, maior que zero.`, 'VITRINE_PRICE_INVALID'); return amount; };
      const retailPriceCents = price(value.retailPriceCents, 'um preço público de varejo'), wholesalePriceCents = price(value.wholesalePriceCents, 'um preço aprovado de atacado');
      const expiresAt = value.expiresAt === '' || value.expiresAt === undefined || value.expiresAt === null ? null : Number(value.expiresAt);
      if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt < 0)) throw fault('Validade do anúncio inválida.', 'VITRINE_EXPIRY_INVALID');
      const availability = value.availability ?? ''; if (!['', 'ready', 'order'].includes(availability)) throw fault('Disponibilidade do anúncio inválida.', 'VITRINE_AVAILABILITY_INVALID');
      const defects = requiredDefects(source.caption); for (const line of defects) publicText(line, 2000, 'a observação obrigatória do produto');
      const providedDefects = publicText(value.defectNotes, 3000, 'as observações públicas');
      const defectNotes = [...new Set([...defects, ...providedDefects.split(/\r?\n/).filter(Boolean)])].join('\n');
      return { id, campaignId, itemId, mediaId: source.media.id, model: publicText(value.model, 160, 'o modelo público', true), storage: publicText(value.storage, 80, 'o armazenamento'), color: publicText(value.color, 80, 'a cor'), publicDescription: publicText(value.publicDescription, 3000, 'a descrição pública'), defectNotes, retailPriceCents, wholesalePriceCents, audience, availability, enabled: value.enabled !== false, expiresAt, sourceHash: source.sourceHash };
    });
  }
  _publicItems(items, config) {
    const publicItems = [], warnings = [], now = this.now();
    for (const item of items) {
      if (!item.enabled) continue;
      if (item.expiresAt === null) { warnings.push({ id: item.id, code: 'VITRINE_EXPIRY_MISSING', reason: 'Cadastre a validade do anúncio antes de exibi-lo.' }); continue; }
      if (item.expiresAt <= now) { warnings.push({ id: item.id, code: 'VITRINE_EXPIRED', reason: 'Anúncio vencido — não será exibido.' }); continue; }
      let source; try { source = this._source(item.campaignId, item.itemId, null, false); } catch (error) { warnings.push({ id: item.id, code: error.code, reason: error.message }); continue; }
      if (source.sourceHash !== item.sourceHash) { warnings.push({ id: item.id, code: 'VITRINE_SOURCE_CHANGED', reason: 'O anúncio original foi alterado. Revise o conteúdo público e publique novamente.' }); continue; }
      const base = { id: item.id, campaignId: item.campaignId, itemId: item.itemId, mediaId: item.mediaId, model: item.model, storage: item.storage, color: item.color, publicDescription: item.publicDescription, defectNotes: item.defectNotes, availability: item.availability, expiresAt: item.expiresAt };
      for (const audience of config.audience === 'mixed' ? ['retail', 'wholesale'] : [config.audience]) {
        if (item.audience !== 'both' && item.audience !== audience) continue;
        const priceCents = audience === 'retail' ? item.retailPriceCents : item.wholesalePriceCents;
        if (priceCents === null) { warnings.push({ id: item.id, code: 'VITRINE_PRICE_MISSING', reason: audience === 'wholesale' ? 'Sem preço aprovado de atacado — não será exibido no atacado.' : 'Sem preço público de varejo — não será exibido no varejo.' }); continue; }
        publicItems.push({ ...base, displayId: `${item.id}:${audience}`, audience, priceCents });
      }
    }
    if (config.audience === 'mixed') publicItems.sort((a, b) => ['retail', 'wholesale'].indexOf(a.audience) - ['retail', 'wholesale'].indexOf(b.audience));
    return { publicItems, warnings };
  }
  getState(actorId) {
    this._requireLicense(); this._assert('view', actorId);
    const draft = this._draft(), candidates = [];
    for (const campaign of this.store.listCampaigns()) {
      try { this._assert('source', actorId, campaign); } catch { continue; }
      for (const item of campaign.items || []) { if (item.type !== 'image') continue; const media = this.store.getMedia(item.mediaId); if (!media || media.type !== 'image') continue; const caption = item.caption || item.text || '', offers = parseOffers(caption), offer = offers.length === 1 ? offers[0] : null;
        candidates.push({ id: digest([campaign.id, item.id]), campaignId: campaign.id, campaignName: campaign.name, itemId: item.id, mediaId: item.mediaId, sourceCaption: caption, model: offer?.model || '', storage: offer?.storageGB ? `${offer.storageGB}GB` : '', color: offer?.color || '', suggestedRetailPriceCents: offer?.confidence === 'confirmed' && offer.priceKind === 'cash' ? offer.priceCents : null, defectNotes: requiredDefects(caption).join('\n') });
      }
    }
    const publication = this._read('publication', null), { publicItems, warnings } = publication?.active ? this._publicItems(publication.items, publication.config) : { publicItems: [], warnings: [] };
    return { config: draft.config, items: draft.items, revision: draft.revision, candidates, publication: publication ? { active: publication.active, publishedAt: publication.publishedAt, stoppedAt: publication.stoppedAt, reason: publication.reason, count: publicItems.length, warnings } : null };
  }
  save(input, actorId) {
    this._requireLicense(); this._assert('manage', actorId);
    const config = normalizeConfig(input?.config), items = this._normalizeItems(input?.items || [], actorId), old = this._draft();
    if (input?.expectedRevision !== undefined && input.expectedRevision !== old.revision) throw fault('A vitrine foi alterada. Reabra a configuração antes de salvar.', 'VITRINE_STALE');
    const saved = this.store.transaction(() => this._write('draft', { config, items, revision: old.revision + 1 })); this.previews.clear();
    return { saved: true, ...saved };
  }
  async preview(input, actorId) {
    this._requireLicense(); this._assert('manage', actorId);
    const draft = this._draft(), config = normalizeConfig(input?.config ?? draft.config), items = this._normalizeItems(input?.items ?? draft.items, actorId), mode = this.store.getStorageMode?.() || 'whatsapp', { publicItems, warnings } = this._publicItems(items, config);
    const qrOptions = { errorCorrectionLevel: 'M', width: 360, margin: 2 }, qrCode = config.whatsappUrl ? await this.qrCode(config.whatsappUrl, qrOptions) : null, wholesaleQrCode = config.wholesaleUrl ? await this.qrCode(config.wholesaleUrl, qrOptions) : null;
    this._requireLicense(); this._assert('manage', actorId);
    if (mode !== (this.store.getStorageMode?.() || 'whatsapp')) throw fault('O modo mudou. Gere outra prévia.', 'VITRINE_STALE');
    const token = randomUUID(), expiresAt = this.now() + 5 * 60000;
    if (this.previews.size >= 32) this.previews.delete(this.previews.keys().next().value);
    this.previews.set(token, { config, items, mode, actorId, draftRevision: draft.revision, expiresAt, qrCode, wholesaleQrCode });
    return { previewToken: token, config, publicItems, warnings, qrCode, wholesaleQrCode, expiresAt };
  }
  publish(input, actorId) {
    this._requireLicense(); this._assert('manage', actorId);
    const preview = this.previews.get(input?.previewToken);
    if (input?.confirm !== true) throw fault('Confira a prévia e confirme a publicação.', 'VITRINE_CONFIRM_REQUIRED');
    if (!preview || preview.actorId !== actorId || preview.mode !== (this.store.getStorageMode?.() || 'whatsapp') || preview.expiresAt <= this.now() || preview.draftRevision !== this._draft().revision) throw fault('A prévia venceu ou foi alterada. Revise novamente antes de publicar.', 'VITRINE_STALE');
    const current = this._normalizeItems(preview.items, actorId);
    if (digest(current) !== digest(preview.items)) throw fault('Um anúncio mudou depois da prévia. Revise novamente.', 'VITRINE_SOURCE_CHANGED');
    const projected = this._publicItems(current, preview.config);
    if (!projected.publicItems.length) throw fault('Nenhum anúncio público elegível. Confira preços, público e validade.', 'VITRINE_EMPTY');
    const publishedAt = this.now(), config = { ...preview.config, updatedAt: publishedAt }, publication = { active: true, config, items: current, publishedAt, qrCode: preview.qrCode, wholesaleQrCode: preview.wholesaleQrCode, stoppedAt: null, reason: null };
    this.store.transaction(() => { this._write('draft', { config, items: current, revision: this._draft().revision + 1 }); this._write('publication', publication); }); this.previews.clear();
    return { published: true, count: projected.publicItems.length, publishedAt };
  }
  getPublic() {
    const draft = this._draft(), publication = this._read('publication', null), neutral = { mode: 'neutral', config: { brandName: draft.config.brandName || DEFAULTS.brandName }, items: [] };
    if (!this._licensed()) { this.handleLicenseExpired(); return neutral; }
    if (!publication?.active) return neutral;
    const { publicItems } = this._publicItems(publication.items, publication.config);
    if (!publicItems.length) return { ...neutral, reason: 'Sem anúncios públicos ativos.' };
    return { mode: 'vitrine', config: copy(publication.config), items: publicItems, qrCode: publication.qrCode, wholesaleQrCode: publication.wholesaleQrCode, publishedAt: publication.publishedAt };
  }
  withdraw(input, actorId) {
    this._requireLicense(); this._assert('manage', actorId); const id = typeof input === 'string' ? input : input?.id;
    if (!id || typeof id !== 'string') throw fault('Selecione o anúncio a retirar.', 'VITRINE_INVALID');
    const draft = this._draft(), publication = this._read('publication', null);
    this.store.transaction(() => { this._write('draft', { ...draft, items: draft.items.filter(item => item.id !== id), revision: draft.revision + 1 }); if (publication) this._write('publication', { ...publication, items: publication.items.filter(item => item.id !== id) }); }); this.previews.clear();
    return { withdrawn: true, id };
  }
  handleCampaignDeleted(campaignId) {
    if (!campaignId) return { removed: 0 }; const draft = this._draft(), publication = this._read('publication', null), removed = draft.items.filter(item => item.campaignId === campaignId).length;
    this.store.transaction(() => { if (removed) this._write('draft', { ...draft, items: draft.items.filter(item => item.campaignId !== campaignId), revision: draft.revision + 1 }); if (publication?.items.some(item => item.campaignId === campaignId)) this._write('publication', { ...publication, items: publication.items.filter(item => item.campaignId !== campaignId) }); }); this.previews.clear(); return { removed };
  }
  handleLicenseExpired() {
    // A renewal or mode switch must not silently restart an old publication.
    for (const mode of ['whatsapp', 'simulated']) {
      const key = `mode:${mode}:vitrine:publication`, publication = this.store.getSetting(key, null);
      if (publication?.active) this.store.setSetting(key, { ...publication, active: false, stoppedAt: this.now(), reason: 'license_expired' });
    }
    this.previews.clear(); return { stopped: true };
  }
}
module.exports = { VitrineService, normalizeVitrineConfig: normalizeConfig, extractVitrineDefects: requiredDefects, DEFAULT_VITRINE_CONFIG: DEFAULTS };
