'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { attachOpportunityWorkflowStore, restoreWorkflowNotification } = require('./opportunity-workflow-store.cjs');
const DEFAULTS = Object.freeze({ enabled: false, mode: 'evaluation', automatic: false, evaluation: true, repeatHours: 24, contactIntervalMinutes: 30, maxPerDay: 3, validityMinutes: 120, availabilityMode: 'campaign', availabilityMaxAgeMinutes: 120, autoMaxOffers: 1, automaticOfferLimit: 1, requestMaxModels: 5, multiModelMax: 5, timezone: 'America/Sao_Paulo', monitoredGroupIds: [], campaignIds: [], allowOwnMessages: false });
const REASONS = Object.freeze({ OP_DUPLICATE: 'Evento já processado.', OP_NOT_FOUND: 'Oportunidade não encontrada.', OP_MUTED: 'Contato silenciado.', OP_CLOSED: 'Pedido encerrado.', OP_EXPIRED: 'Pedido expirado.', OP_REVIEW: 'Pedido alterado ou incompleto; revisão necessária.', OP_ALREADY_RESPONDED: 'Pedido já respondido.', OP_PENDING: 'Resposta já reservada ou em andamento.', OP_UNCERTAIN: 'Envio anterior com resultado incerto.', OP_REPEAT: 'Mesmo interessado e mesma procura dentro do bloqueio de repetição.', OP_INTERVAL: 'Aguardando intervalo mínimo.', OP_DAILY_LIMIT: 'Limite diário atingido.', OP_AUTOMATIC_DISABLED: 'Modo automático desativado.', OP_STOPPED: 'Envios automáticos interrompidos.', OP_OFFER_SENT: 'Oferta já enviada para este contato.', OP_OFFER_UPDATED: 'Oferta atualizada — já enviada anteriormente.', OP_OFFER_REPOST: 'Possível republicação de uma oferta já enviada; revisão necessária.', OP_OFFER_MISSING: 'Oferta não encontrada.', OP_OFFER_UNSAFE: 'Correspondência ou identidade da oferta precisa de revisão.', OP_AVAILABILITY: 'Disponibilidade precisa de confirmação.', OP_QUANTITY: 'Quantidade disponível insuficiente ou não confirmada.', OP_CANCELLED: 'Tarefa cancelada.', OP_TASK_STATE: 'Tarefa não está disponível para iniciar.', OP_RECIPIENT: 'Destinatário não corresponde à identidade resolvida do interessado.', OP_EMPTY: 'Nenhuma oferta selecionada.', OP_TOO_MANY: 'Quantidade de opções acima do limite automático.' });
function normalizeOpportunityConfig(input = {}, previous = {}) {
  const value = { ...DEFAULTS, ...previous, ...input };
  if (Object.hasOwn(input, 'automatic')) value.mode = input.automatic ? 'automatic' : (input.evaluation === false ? 'manual' : 'evaluation');
  else if (Object.hasOwn(input, 'evaluation') && input.evaluation) value.mode = 'evaluation';
  if (!['automatic', 'evaluation', 'manual'].includes(value.mode)) throw new Error('Modo de oportunidades inválido.');
  if (!['campaign', 'confirmed'].includes(value.availabilityMode)) throw new Error('Origem da disponibilidade inválida: escolha campanha ou confirmação manual.');
  value.automatic = value.mode === 'automatic'; value.evaluation = value.mode === 'evaluation';
  const bounds = { repeatHours: [1, 8760], contactIntervalMinutes: [0, 10080], maxPerDay: [1, 1000], validityMinutes: [1, 43200], availabilityMaxAgeMinutes: [1, 43200], autoMaxOffers: [1, 10], requestMaxModels: [1, 20] };
  if (Object.hasOwn(input, 'automaticOfferLimit')) value.autoMaxOffers = input.automaticOfferLimit;
  if (Object.hasOwn(input, 'multiModelMax')) value.requestMaxModels = input.multiModelMax;
  for (const [name, [min, max]] of Object.entries(bounds)) if (!Number.isInteger(value[name]) || value[name] < min || value[name] > max) throw new Error(`Configuração ${name} inválida.`);
  value.automaticOfferLimit = value.autoMaxOffers; value.multiModelMax = value.requestMaxModels;
  if (typeof value.timezone !== 'string' || value.timezone.length > 100) throw new Error('Fuso inválido.');
  try { new Intl.DateTimeFormat('en', { timeZone: value.timezone }).format(); } catch { throw new Error('Fuso inválido.'); }
  for (const name of ['monitoredGroupIds', 'campaignIds']) {if (!Array.isArray(value[name]) || value[name].length > 1000 || value[name].some(id => typeof id !== 'string' || !id || id.length > 512)) throw new Error('Seleção de origens inválida.');value[name]=[...new Set(value[name])];}
  return value;
}
function attachOpportunityStore(store, { db, prepared, transaction }) {
  transaction(() => db.exec(`CREATE TABLE IF NOT EXISTS op_config(storageMode TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS op_requests(storageMode TEXT NOT NULL,id TEXT NOT NULL,senderKey TEXT NOT NULL,intentKey TEXT NOT NULL,familyKey TEXT NOT NULL,originalAt INTEGER NOT NULL,expiresAt INTEGER NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(storageMode,id));
    CREATE INDEX IF NOT EXISTS op_requests_contact_family ON op_requests(storageMode,senderKey,familyKey,originalAt DESC);
    CREATE INDEX IF NOT EXISTS op_requests_status_expiry ON op_requests(storageMode,status,expiresAt);
    CREATE TABLE IF NOT EXISTS op_origins(storageMode TEXT NOT NULL,chatId TEXT NOT NULL,messageId TEXT NOT NULL,opportunityId TEXT NOT NULL,originalAt INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(storageMode,chatId,messageId));
    CREATE INDEX IF NOT EXISTS op_origins_request ON op_origins(storageMode,opportunityId,originalAt);
    CREATE TABLE IF NOT EXISTS op_contacts(storageMode TEXT NOT NULL,senderKey TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(storageMode,senderKey));
    CREATE TABLE IF NOT EXISTS op_offers(storageMode TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(storageMode,id));
    CREATE TABLE IF NOT EXISTS op_tasks(storageMode TEXT NOT NULL,id TEXT NOT NULL,clientId TEXT NOT NULL,opportunityId TEXT NOT NULL,senderKey TEXT NOT NULL,intentKey TEXT NOT NULL,familyKey TEXT NOT NULL,status TEXT NOT NULL,createdAt INTEGER NOT NULL,dayKey TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(storageMode,id),UNIQUE(storageMode,clientId));
    CREATE INDEX IF NOT EXISTS op_tasks_contact_time ON op_tasks(storageMode,senderKey,createdAt DESC);
    CREATE INDEX IF NOT EXISTS op_tasks_contact_day ON op_tasks(storageMode,senderKey,dayKey,status);
    CREATE INDEX IF NOT EXISTS op_tasks_request ON op_tasks(storageMode,opportunityId,status);
    CREATE UNIQUE INDEX IF NOT EXISTS op_tasks_retry_parent_unique ON op_tasks(storageMode,json_extract(data,'$.retryOf')) WHERE json_extract(data,'$.retryOf') IS NOT NULL;
    CREATE INDEX IF NOT EXISTS op_tasks_due ON op_tasks(storageMode,status,createdAt);
    CREATE INDEX IF NOT EXISTS op_tasks_retry_due ON op_tasks(storageMode,status,COALESCE(json_extract(data,'$.nextAttemptAt'),0),createdAt);
    CREATE INDEX IF NOT EXISTS op_tasks_message ON op_tasks(storageMode,json_extract(data,'$.clientMessageId'));
    CREATE INDEX IF NOT EXISTS op_tasks_integration_message ON op_tasks(storageMode,json_extract(data,'$.messageId')); 
    CREATE TABLE IF NOT EXISTS op_sent_offers(storageMode TEXT NOT NULL,senderKey TEXT NOT NULL,offerId TEXT NOT NULL,taskId TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(storageMode,senderKey,offerId,taskId));
    CREATE INDEX IF NOT EXISTS op_sent_identity ON op_sent_offers(storageMode,senderKey,offerId);
    CREATE TABLE IF NOT EXISTS op_notifications(storageMode TEXT NOT NULL,opportunityId TEXT NOT NULL,kind TEXT NOT NULL,at INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(storageMode,opportunityId,kind));
    CREATE TABLE IF NOT EXISTS op_traces(storageMode TEXT NOT NULL,id TEXT NOT NULL,opportunityId TEXT,taskId TEXT,at INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(storageMode,id));
    CREATE INDEX IF NOT EXISTS op_traces_request_time ON op_traces(storageMode,opportunityId,at DESC);
    CREATE INDEX IF NOT EXISTS op_traces_retention_time ON op_traces(storageMode,at DESC);
    CREATE INDEX IF NOT EXISTS op_tasks_response_time ON op_tasks(storageMode,senderKey,COALESCE(json_extract(data,'$.startedAt'),createdAt));
    CREATE TABLE IF NOT EXISTS op_identity_aliases(storageMode TEXT NOT NULL,alias TEXT NOT NULL,senderKey TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(storageMode,alias));
    CREATE INDEX IF NOT EXISTS op_identity_sender ON op_identity_aliases(storageMode,senderKey);
    CREATE TABLE IF NOT EXISTS op_clock(storageMode TEXT PRIMARY KEY,lastAt INTEGER NOT NULL);`));
  const mode = () => store.getStorageMode?.() || store.getSetting('integrationMode', 'whatsapp');
  const decode = row => row ? JSON.parse(row.data) : undefined;
  const key = (value, name = 'Identificador') => { if (typeof value !== 'string' || !value || value.length > 512 || value.includes('\0')) throw new Error(`${name} inválido.`); return value; };
  const stamp = value => { if (!Number.isSafeInteger(value) || value < 0) throw new Error('Data de oportunidade inválida.'); return value; };
  const selection = value => {
    if(value===undefined||value===null)return null;
    if(typeof value!=='object'||Array.isArray(value))throw new Error('Seleção manual de campanha inválida.');
    return {campaignId:key(value.campaignId,'Campanha'),itemId:key(value.itemId,'Item')};
  };
  const isManualSelection = (task,offer) => task.automatic===false && !!task.manualCampaignSelection && offer?.manualOnly===true &&
    task.manualCampaignSelection.campaignId===offer.campaignId && task.manualCampaignSelection.itemId===offer.itemId &&
    offer.manualCampaignSelection?.campaignId===offer.campaignId && offer.manualCampaignSelection?.itemId===offer.itemId;
  const offerReferences = offer => new Set([offer?.id,offer?.canonicalOfferId,...(Array.isArray(offer?.canonicalOfferIds)?offer.canonicalOfferIds.slice(0,100):[])].filter(value=>typeof value==='string'&&value&&value.length<=512));

  const safe = value => { const inspect = (v, depth = 0) => { if (depth > 20) throw new Error('Registro muito profundo.'); if (v && typeof v === 'object') for (const [name, child] of Object.entries(v)) { if (/^(raw|protectedContext|password|token|accessToken|refreshToken|session|mediaKey|credentials|secret|privateKey)$/i.test(name)) throw new Error('Dados operacionais de oportunidades não podem conter credenciais.'); inspect(child, depth + 1); } }; inspect(value); return JSON.parse(JSON.stringify(value)); };
  const get = (table, id) => decode(prepared(`SELECT data FROM ${table} WHERE storageMode=? AND id=?`).get(mode(), key(id)));
  const config = () => normalizeOpportunityConfig(decode(prepared('SELECT data FROM op_config WHERE storageMode=?').get(mode())) || {});
  const clock = at => { stamp(at); const old = prepared('SELECT lastAt FROM op_clock WHERE storageMode=?').get(mode())?.lastAt || 0; const now = Math.max(at, Number(old)); prepared('INSERT INTO op_clock(storageMode,lastAt)VALUES(?,?)ON CONFLICT(storageMode)DO UPDATE SET lastAt=MAX(lastAt,excluded.lastAt)').run(mode(), now); return now; };
  const day = (at, timezone) => new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
  const blocked = (code, extra = {}) => ({ ok: false, code, reason: REASONS[code] || 'Operação bloqueada.', ...extra });
  const saveRequest = value => { const v = safe({ ...value, storageMode: mode() }); prepared(`INSERT INTO op_requests(storageMode,id,senderKey,intentKey,familyKey,originalAt,expiresAt,status,data)VALUES(?,?,?,?,?,?,?,?,?)ON CONFLICT(storageMode,id)DO UPDATE SET intentKey=excluded.intentKey,familyKey=excluded.familyKey,originalAt=excluded.originalAt,expiresAt=excluded.expiresAt,status=excluded.status,data=excluded.data`).run(mode(), key(v.id), key(v.senderKey), key(v.intentKey), key(v.familyKey), stamp(v.originalAt), stamp(v.expiresAt), key(v.status), JSON.stringify(v)); return v; };
  const saveTask = value => { const v = safe({ ...value, storageMode: mode() }); prepared(`INSERT INTO op_tasks(storageMode,id,clientId,opportunityId,senderKey,intentKey,familyKey,status,createdAt,dayKey,data)VALUES(?,?,?,?,?,?,?,?,?,?,?)ON CONFLICT(storageMode,id)DO UPDATE SET status=excluded.status,dayKey=excluded.dayKey,data=excluded.data`).run(mode(), key(v.id), key(v.clientId), key(v.opportunityId), key(v.senderKey), key(v.intentKey), key(v.familyKey), key(v.status), stamp(v.createdAt), key(v.dayKey), JSON.stringify(v)); return v; };
  const trace = record => { const v = safe({ id: randomUUID(), at: Date.now(), ...record }); prepared('INSERT INTO op_traces(storageMode,id,opportunityId,taskId,at,data)VALUES(?,?,?,?,?,?)').run(mode(), key(v.id), v.opportunityId || null, v.taskId || null, stamp(v.at), JSON.stringify(v)); return v; };
  const listTasks = (filter = {}) => { const where = ['storageMode=?'], args = [mode()]; for (const field of ['opportunityId', 'senderKey', 'status', 'messageId', 'clientMessageId']) if (filter[field] !== undefined) { const values = Array.isArray(filter[field]) ? filter[field] : [filter[field]]; if(field==='messageId' && values.length) { const marks=values.map(()=>'?').join(',');where.push(`(json_extract(data,'$.messageId') IN(${marks}) OR json_extract(data,'$.clientMessageId') IN(${marks}) OR clientId IN(${marks}))`);args.push(...values,...values,...values); }
      else { const column = field==='clientMessageId' ? `json_extract(data,'$.clientMessageId')` : field;where.push(values.length ? `${column} IN(${values.map(() => '?').join(',')})` : '0');args.push(...values); } } if(filter.dueAt!==undefined){where.push("COALESCE(json_extract(data,'$.nextAttemptAt'),0)<=?");args.push(stamp(filter.dueAt));} const limit = Math.min(1000, Math.max(1, Number(filter.limit) || 100)), offset = Math.max(0, Number(filter.offset) || 0); return prepared(`SELECT data FROM op_tasks WHERE ${where.join(' AND ')} ORDER BY createdAt,rowid LIMIT ? OFFSET ?`).all(...args, limit, offset).map(decode); };
  const countsAsResponse = task => ['queued', 'sending', 'accepted', 'delivered', 'uncertain', 'outside'].includes(task.status) || task.startedAt !== undefined && task.startedAt !== null;
  const sentRecords = (senderKey, offerId) => prepared('SELECT data FROM op_sent_offers WHERE storageMode=? AND senderKey=? AND offerId=?').all(mode(), key(senderKey), key(offerId)).map(decode).filter(record => { const task = get('op_tasks', record.taskId); return task && countsAsResponse(task); });
  function checkCurrentCampaign(offer, task, cfg, now) {
    // Production offers are projections of a campaign item. Re-read that source
    // inside the same transaction as the reservation/final guard, never an
    // external stock system or a cached availability decision.
    if (typeof store.getCampaign !== 'function') return cfg.availabilityMode === 'confirmed' ? { ok: true } : blocked('OP_OFFER_UNSAFE', { reason: 'A campanha atual da oferta precisa ser verificada.' });
    if (!cfg.campaignIds.includes(offer.campaignId)) return blocked('OP_OFFER_UNSAFE', { offerId: offer.id, reason: 'A campanha desta oferta não está mais selecionada para Oportunidades.' });
    const campaign = store.getCampaign(offer.campaignId), item = campaign?.items?.find(row => row.id === offer.itemId);
    if (!campaign || !item) return blocked('OP_OFFER_MISSING', { offerId: offer.id, reason: 'O item foi removido ou a campanha da oferta não existe mais.' });
    if (offer.availabilitySource !== cfg.availabilityMode || task.availabilityMode && task.availabilityMode !== cfg.availabilityMode) return blocked('OP_REVIEW', { offerId: offer.id, reason: 'A regra de disponibilidade mudou; confira a oferta novamente.' });
    const source = item.sourcePublicationId ? store.getSourcePublication?.(item.sourcePublicationId) : undefined;
    const media = item.mediaId ? store.getMedia?.(item.mediaId) : undefined;
    const { assessCampaignItem, campaignItemFingerprint } = require('./opportunity-campaign.cjs');
    const assessment = assessCampaignItem(item, campaign, { source, media, availabilityMode: cfg.availabilityMode, now, manualSelection: isManualSelection(task,offer) });
    if (!assessment.eligible) return blocked('OP_AVAILABILITY', { offerId: offer.id, matchCode: assessment.blocker?.code, reason: assessment.blocker?.reason || REASONS.OP_AVAILABILITY });
    const fingerprint = campaignItemFingerprint(item, campaign, { source, media });
    if (!offer.campaignItemFingerprint || offer.campaignItemFingerprint !== fingerprint) return blocked('OP_REVIEW', { offerId: offer.id, reason: 'O item da campanha mudou; confira a oferta novamente.' });
    const snapshot = task.offerSnapshots?.find(row => row.id === offer.id);
    if (snapshot && (snapshot.campaignId !== offer.campaignId || snapshot.itemId !== offer.itemId || snapshot.campaignItemFingerprint !== fingerprint || snapshot.availabilitySource !== cfg.availabilityMode)) return blocked('OP_REVIEW', { offerId: offer.id, reason: 'A origem ou a disponibilidade da oferta mudou depois da reserva.' });
    if (cfg.availabilityMode === 'campaign' && (!assessment.availabilityDeclared || assessment.available !== true || offer.availabilityDeclared !== true)) return blocked('OP_AVAILABILITY', { offerId: offer.id });
    return { ok: true };
  }
  function checkOffers(opportunity, offers, task, now) {
    const baseConfig = config();
    if(task.manualCampaignSelection&&(task.automatic!==false||offers.length!==1))return blocked('OP_OFFER_UNSAFE',{reason:'A seleção de anúncio pertence somente à resposta manual revisada.'});
    for (const offer of offers) {
      if (!offer) return blocked('OP_OFFER_MISSING');
      const manual=isManualSelection(task,offer);
      if((task.manualCampaignSelection||offer.manualOnly)&&!manual)return blocked('OP_OFFER_UNSAFE',{offerId:offer.id,reason:'O anúncio manual não corresponde à seleção revisada.'});
      const cfg=manual?{...baseConfig,availabilityMode:'campaign'}:baseConfig;
      const current = checkCurrentCampaign(offer, task, cfg, now); if (!current.ok) return current;
      const { matchOffer } = require('./opportunity-matcher.cjs');
      const models = opportunity.request?.models || [], matches = models.map(spec => matchOffer(spec, offer, { now, availabilityMode: cfg.availabilityMode, availabilityMaxAgeMinutes: cfg.availabilityMaxAgeMinutes }));
      if (!manual && !matches.some(result => result.eligible)) return blocked('OP_OFFER_UNSAFE', { offerId: offer.id, reason: matches[0]?.reason || REASONS.OP_OFFER_UNSAFE, matchCode: matches[0]?.code });
      if (offer.available !== true || cfg.availabilityMode === 'confirmed' && (!Number.isSafeInteger(offer.availabilityConfirmedAt) || offer.availabilityConfirmedAt > now || now - offer.availabilityConfirmedAt > cfg.availabilityMaxAgeMinutes * 60000)) return blocked('OP_AVAILABILITY', { offerId: offer.id });
      const required = opportunity.request?.quantity || 1;
      if (!manual && required > 1 && (!Number.isInteger(offer.quantityAvailable) || offer.quantityAvailable < required)) return blocked('OP_QUANTITY', { offerId: offer.id });
      const previous = sentRecords(opportunity.senderKey, offer.id).filter(record => record.taskId !== task.id);
      if (previous.length && !(!task.automatic && task.duplicateRiskAcknowledged)) return blocked(previous.some(record => record.offerRevision !== (offer.offerRevision || offer.revision)) ? 'OP_OFFER_UPDATED' : 'OP_OFFER_SENT', { offerId: offer.id });
      if (task.automatic || manual && !task.duplicateRiskAcknowledged) {
        const unitReference = value => value.explicitUnitReference || value.unitReference || value.serial || value.imei;
        const sameVariant = value => ['model','modelKey','storageGB','colorKey','condition'].every(field => (value[field] ?? null) === (offer[field] ?? null));
        const history = prepared('SELECT data FROM op_sent_offers WHERE storageMode=? AND senderKey=?').all(mode(), opportunity.senderKey).map(decode);
        for (const sent of history) {
          if (sent.taskId === task.id || sent.offerId === offer.id) continue;
          const priorTask = get('op_tasks', sent.taskId); if (!priorTask || !countsAsResponse(priorTask)) continue;
          const prior = priorTask.offerSnapshots?.find(row => row.id === sent.offerId) || get('op_offers', sent.offerId); if (!prior) continue;
          const references=offerReferences(offer),priorReferences=offerReferences(prior);
          if([...references].some(value=>priorReferences.has(value)))return blocked('OP_OFFER_SENT',{offerId:offer.id,previousOfferId:prior.id});
          if (unitReference(offer) && unitReference(prior) && unitReference(offer) !== unitReference(prior)) continue;
          const materialMatches = offer.contentFingerprint && prior.contentFingerprint === offer.contentFingerprint || offer.mediaFingerprint && prior.mediaFingerprint === offer.mediaFingerprint && sameVariant(prior);
          if (materialMatches) return blocked('OP_OFFER_REPOST', { offerId: offer.id, previousOfferId: prior.id });
        }
      }
      if (task.offerSnapshots) { const snapshot = task.offerSnapshots.find(row => row.id === offer.id); if (!snapshot || snapshot.offerRevision !== (offer.offerRevision || offer.revision)) return blocked('OP_REVIEW', { offerId: offer.id, reason: 'Oferta foi alterada depois da reserva; confira a prévia novamente.' }); }
    }
    return { ok: true };
  }
  function limits(opportunity, task, now) {
    const cfg = config();
    const responseAt = row => row.startedAt ?? row.createdAt;
    const windowStart=now-Math.max(cfg.repeatHours*3600000,cfg.contactIntervalMinutes*60000,172800000);
    const other = prepared("SELECT data FROM op_tasks WHERE storageMode=? AND senderKey=? AND (COALESCE(json_extract(data,'$.startedAt'),createdAt)>=? OR opportunityId=?) ORDER BY createdAt DESC").all(mode(), opportunity.senderKey,windowStart,opportunity.id).map(decode).filter(row => row.id !== task.id && countsAsResponse(row)).sort((a,b) => responseAt(b)-responseAt(a));
    const same = other.find(row => row.opportunityId === opportunity.id);
    if (same && !(!task.automatic && task.duplicateRiskAcknowledged)) return blocked(same.status === 'uncertain' ? 'OP_UNCERTAIN' : ['queued', 'sending'].includes(same.status) ? 'OP_PENDING' : 'OP_ALREADY_RESPONDED');
    if (!task.automatic && task.manualOverride === true) return { ok: true };
    const repeated = other.find(row => row.familyKey === opportunity.familyKey && now - responseAt(row) < cfg.repeatHours * 3600000);
    if (repeated) return blocked(repeated.status === 'uncertain' ? 'OP_UNCERTAIN' : 'OP_REPEAT', { nextEligibleAt: responseAt(repeated) + cfg.repeatHours * 3600000 });
    const latest = other[0]; if (latest && now - responseAt(latest) < cfg.contactIntervalMinutes * 60000) return blocked('OP_INTERVAL', { nextEligibleAt: responseAt(latest) + cfg.contactIntervalMinutes * 60000 });
    if (other.filter(row => row.dayKey === day(now, cfg.timezone)).length >= cfg.maxPerDay) return blocked('OP_DAILY_LIMIT');
    return { ok: true };
  }
  function guard(opportunity, task, now, options = {}) {
    if (!opportunity) return blocked('OP_NOT_FOUND');
    if (store.getOpportunityContactMute(opportunity.senderKey)?.muted) return blocked('OP_MUTED');
    if (['closed', 'cancelled'].includes(opportunity.status)) return blocked('OP_CLOSED');
    if (opportunity.expiresAt <= now && !(task.automatic === false && (options.allowExpired === true || task.allowExpired === true))) { if (!options.readOnly && opportunity.status !== 'expired') saveRequest({ ...opportunity, status: 'expired', updatedAt: now }); return blocked('OP_EXPIRED'); }
    if (opportunity.needsReview && !(task.automatic === false && (options.reviewed === true || task.reviewed === true))) return blocked('OP_REVIEW');
    if (task.automatic && (!config().enabled || !config().automatic && !options.evaluationOnly)) return blocked('OP_AUTOMATIC_DISABLED');
    if (task.automatic && options.automationAllowed === false) return blocked('OP_STOPPED');
    if (task.status === 'cancelled') return blocked('OP_CANCELLED');
    if (task.automatic && opportunity.status === 'responded') return blocked('OP_ALREADY_RESPONDED');
    if (!['queued', 'sending', 'reserving'].includes(task.status)) return blocked(task.status === 'uncertain' ? 'OP_UNCERTAIN' : 'OP_TASK_STATE');
    const rate = limits(opportunity, task, now); if (!rate.ok) return rate;
    return checkOffers(opportunity, task.offerIds.map(id => get('op_offers', id)), task, now);
  }
  function recordBlock(opportunityId,result,now) { const old=get('op_requests',opportunityId);if(old)saveRequest({...old,lastBlocker:{code:result.code,reason:result.reason,at:now,nextEligibleAt:result.nextEligibleAt||null},lastEvaluatedAt:now}); }
  function resolverOpportunityIdentity(input,at=Date.now()) { return transaction(()=>{
    if(input?.identityVerified!==true || input.identityAmbiguous===true)return {ambiguous:true,code:'OP_IDENTITY_UNVERIFIED',reason:'Identidade do remetente não foi verificada pela integração.'};
    const ids=[...new Set([input.senderId,...(input.senderIds||[])].filter(Boolean))];if(ids.length>20)throw new Error('Muitos identificadores de remetente.');
    const validIds=ids.map(id=>key(id)).filter(id=>/^[1-9]\d{0,30}@(s\.whatsapp\.net|lid)$/.test(id));
    const phones=[...new Set([input.phone,...validIds.filter(id=>id.endsWith('@s.whatsapp.net')).map(id=>id.split('@')[0])].filter(value=>typeof value==='string' && /^[1-9]\d{9,14}$/.test(value)))];
    if(phones.length>1)return {ambiguous:true,code:'OP_IDENTITY_AMBIGUOUS',reason:'A integração forneceu mais de um telefone para o remetente.'};
    const aliases=[...new Set([...validIds.map(id=>`account:${id}`),...phones.map(phone=>`phone:${phone}`)])];
    if(!aliases.length)return {ambiguous:true,code:'OP_IDENTITY_UNVERIFIED',reason:'Nenhum identificador confiável disponível.'};
    const existing=aliases.map(alias=>decode(prepared('SELECT data FROM op_identity_aliases WHERE storageMode=? AND alias=?').get(mode(),alias))).filter(Boolean);
    const historicalKeys=aliases.filter(alias=>prepared('SELECT 1 present FROM op_requests WHERE storageMode=? AND senderKey=? LIMIT 1').get(mode(),alias)||prepared('SELECT 1 present FROM op_contacts WHERE storageMode=? AND senderKey=? LIMIT 1').get(mode(),alias)||prepared('SELECT 1 present FROM op_tasks WHERE storageMode=? AND senderKey=? LIMIT 1').get(mode(),alias));
    const keys=[...new Set([...existing.map(row=>row.senderKey),...historicalKeys])];
    if(keys.length>1)return {ambiguous:true,code:'OP_IDENTITY_AMBIGUOUS',reason:'Os identificadores estão vinculados a interessados diferentes; revise os vínculos.'};
    const knownPhones=[...new Set([...phones,...existing.map(row=>row.phone)].filter(Boolean))];if(knownPhones.length>1)return {ambiguous:true,code:'OP_IDENTITY_AMBIGUOUS',reason:'O vínculo de conta possui telefones conflitantes.'};
    const now=clock(at),phone=knownPhones[0]||null,senderKey=keys[0] || (phone ? `phone:${phone}` : `account:${validIds[0]}`);
    for(const alias of aliases){const old=decode(prepared('SELECT data FROM op_identity_aliases WHERE storageMode=? AND alias=?').get(mode(),alias));const row={alias,senderKey,phone,createdAt:old?.createdAt??now,verifiedAt:now};prepared('INSERT INTO op_identity_aliases(storageMode,alias,senderKey,data)VALUES(?,?,?,?)ON CONFLICT(storageMode,alias)DO UPDATE SET data=excluded.data').run(mode(),alias,senderKey,JSON.stringify(row));}
    if(phone)for(const row of prepared('SELECT data FROM op_identity_aliases WHERE storageMode=? AND senderKey=?').all(mode(),senderKey)){const old=decode(row);prepared('UPDATE op_identity_aliases SET data=? WHERE storageMode=? AND alias=?').run(JSON.stringify({...old,phone,verifiedAt:now}),mode(),old.alias);}
    return {senderKey,phone,ambiguous:false,aliases};
  }); }
  function cancelQueued(opportunityId, reason, now, { respectReviewedExpired = false } = {}) {
    let cancelled = 0; const clause = respectReviewedExpired ? " AND NOT (json_extract(data,'$.automatic') IS 0 AND json_extract(data,'$.reviewed') IS 1 AND json_extract(data,'$.allowExpired') IS 1)" : '';
    for (;;) { const rows = prepared(`SELECT data FROM op_tasks WHERE storageMode=? AND opportunityId=? AND status='queued'${clause} LIMIT 200`).all(mode(), opportunityId); if (!rows.length) break;
      for (const row of rows) { const task = decode(row); saveTask({ ...task, status: 'cancelled', cancelledAt: now, code: reason, reason: REASONS[reason] || reason }); cancelled++; }
    } return cancelled;
  }
  function ingestOpportunity({ event, request }, at = Date.now()) {
    return transaction(() => {
      const now = clock(at), cfg = config(), chatId = key(event?.chatId), messageId = key(event?.messageId), senderKey = key(event?.senderKey), originalAt = stamp(event?.originalAt);
      const oldOrigin = decode(prepared('SELECT data FROM op_origins WHERE storageMode=? AND chatId=? AND messageId=?').get(mode(), chatId, messageId));
      if (oldOrigin) return { inserted: false, duplicate: true, opportunity: get('op_requests', oldOrigin.opportunityId), origin: oldOrigin };
      key(request?.intentKey); key(request?.familyKey);
      let opportunity = decode(prepared('SELECT data FROM op_requests WHERE storageMode=? AND senderKey=? AND familyKey=? AND originalAt>=? ORDER BY originalAt DESC LIMIT 1').get(mode(), senderKey, request.familyKey, now - cfg.repeatHours * 3600000));
      const grouped = !!opportunity, changedRelevant = grouped && opportunity.intentKey !== request.intentKey;
      if (!opportunity) opportunity = { id: randomUUID(), senderKey, intentKey: request.intentKey, familyKey: request.familyKey, originalAt, createdAt: now, updatedAt: now, expiresAt: Math.min(originalAt, now) + cfg.validityMinutes * 60000, status: 'open', request: safe(request), originCount: 0, needsReview: request.needsReview === true || request.safe === false || request.complete === false };
      else opportunity = { ...opportunity, intentKey: request.intentKey, request: safe(request), originalAt: Math.min(opportunity.originalAt, originalAt), expiresAt: Math.min(opportunity.expiresAt, Math.min(originalAt, now) + cfg.validityMinutes * 60000), updatedAt: now, needsReview: opportunity.needsReview || changedRelevant || request.needsReview === true || request.safe === false || request.complete === false, changedRelevant: opportunity.changedRelevant || changedRelevant };
      for (const field of ['senderId','senderPhone','senderName','recipient']) if (!opportunity[field] && event[field]) opportunity[field] = event[field];
      opportunity.originCount++; opportunity = saveRequest(opportunity);
      const origin = safe({ ...event, chatId, messageId, senderKey, originalAt, opportunityId: opportunity.id, intentKey: request.intentKey, request: safe(request) });
      prepared('INSERT INTO op_origins(storageMode,chatId,messageId,opportunityId,originalAt,data)VALUES(?,?,?,?,?,?)').run(mode(), chatId, messageId, opportunity.id, originalAt, JSON.stringify(origin));
      if (changedRelevant) cancelQueued(opportunity.id, 'OP_REVIEW', now);
      trace({ opportunityId: opportunity.id, at: now, stage: grouped ? 'pedido_agrupado' : 'recebido', code: changedRelevant ? 'OP_REVIEW' : grouped ? 'OP_REPEAT' : 'OP_NEW', detail: grouped ? `Pedido repetido em ${new Set(store.listOpportunityOrigins(opportunity.id).map(row => row.chatId)).size} grupos.` : 'Nova oportunidade.' });
      return { inserted: true, duplicate: false, grouped, changedRelevant, opportunity, origin };
    });
  }
  function checkOpportunitySend(input = {}) {
    const now = Math.max(stamp(input.now ?? Date.now()), Number(prepared('SELECT lastAt FROM op_clock WHERE storageMode=?').get(mode())?.lastAt || 0));
    const opportunity = get('op_requests', input.opportunityId);
    const task = { id: input.taskId || 'evaluation-only', automatic: input.automatic !== false, status: 'reserving', offerIds: [...new Set(input.offerIds || [])].map(id => key(id)), manualOverride: input.manualOverride === true, duplicateRiskAcknowledged: input.duplicateRiskAcknowledged === true, reviewed: input.reviewed === true, allowExpired: input.allowExpired === true, manualCampaignSelection:selection(input.manualCampaignSelection) };
    return { ...guard(opportunity, task, now, { ...input, readOnly: true }), repetition: opportunity ? limits(opportunity, task, now) : null };
  }
  function reserveOpportunitySend(input) {
    return transaction(() => {
      const now = clock(input.now ?? Date.now()), clientId = key(input.clientId || input.clientMessageId || randomUUID());
      const existing = decode(prepared('SELECT data FROM op_tasks WHERE storageMode=? AND clientId=?').get(mode(), clientId)); if (existing) {
        const fields = { opportunityId: input.opportunityId, offerIds: [...new Set(input.offerIds || [])], recipient: input.recipient || existing.senderKey, automatic: input.automatic !== false, retryOf: input.retryOf || null, manualCampaignSelection:selection(input.manualCampaignSelection) };
        for (const [field,value] of Object.entries(fields)) if (JSON.stringify(field==='manualCampaignSelection'?existing[field]||null:existing[field]) !== JSON.stringify(value)) throw Object.assign(new Error('Identificador de envio reutilizado com outra operação.'), { code:'OP_CLIENT_ID_CONFLICT' });
        return { ok: true, duplicate: true, task: existing };
      }
      const opportunity = get('op_requests', input.opportunityId); if (!opportunity) return blocked('OP_NOT_FOUND');
      if(opportunity.recipient && input.recipient && input.recipient!==opportunity.recipient)return blocked('OP_RECIPIENT');
      const offerIds = [...new Set(input.offerIds || [])].map(id => key(id)); if (!offerIds.length) return blocked('OP_EMPTY');
      const automatic = input.automatic !== false; if (automatic && offerIds.length > config().autoMaxOffers) return blocked('OP_TOO_MANY');
      if (input.retryOf) {
        const parent = get('op_tasks', key(input.retryOf)), child = decode(prepared("SELECT data FROM op_tasks WHERE storageMode=? AND json_extract(data,'$.retryOf')=? LIMIT 1").get(mode(), input.retryOf));
        if (!parent || parent.opportunityId !== opportunity.id || parent.senderKey !== opportunity.senderKey || JSON.stringify(parent.offerIds) !== JSON.stringify(offerIds) || JSON.stringify(parent.manualCampaignSelection||null)!==JSON.stringify(selection(input.manualCampaignSelection)) || parent.recipient !== input.recipient || automatic || input.duplicateRiskAcknowledged !== true) return blocked('OP_TASK_STATE', { reason: 'Reenvio não corresponde à tarefa original revisada.' });
        if (child) return { ok: true, duplicate: true, task: child };
        if (parent.status !== 'uncertain') return blocked('OP_TASK_STATE', { reason: 'O envio original não está mais incerto; verifique o resultado.' });
      }
      const task = { id: randomUUID(), clientId, clientMessageId: input.clientMessageId || createHash('sha256').update(`${mode()}\0${clientId}`).digest('hex').slice(0, 32).toUpperCase(), opportunityId: opportunity.id, senderKey: opportunity.senderKey, intentKey: opportunity.intentKey, familyKey: opportunity.familyKey, offerIds, recipient: key(input.recipient || opportunity.senderKey), automatic, manualOverride: input.manualOverride === true, duplicateRiskAcknowledged: input.duplicateRiskAcknowledged === true, reviewed: input.reviewed === true, allowExpired: input.allowExpired === true, actorId: input.actorId || null, retryOf: input.retryOf || null, manualCampaignSelection:selection(input.manualCampaignSelection), status: 'reserving', createdAt: now, dayKey: day(now, config().timezone), attempts: 0, traceId: input.traceId || randomUUID() };
      const check = guard(opportunity, task, now, input); if (!check.ok) { recordBlock(opportunity.id,check,now);trace({ at: now, opportunityId: opportunity.id, stage: 'bloqueado', ...check }); return check; }
      task.status = 'queued'; task.availabilityMode = task.manualCampaignSelection ? 'campaign' : config().availabilityMode; task.offerSnapshots = offerIds.map(id => { const offer = get('op_offers', id); return safe({ ...offer, offerRevision: offer.offerRevision || offer.revision }); });
      const saved = saveTask(task);
      for (const offer of saved.offerSnapshots) prepared('INSERT INTO op_sent_offers(storageMode,senderKey,offerId,taskId,data)VALUES(?,?,?,?,?)').run(mode(), opportunity.senderKey, offer.id, saved.id, JSON.stringify({ senderKey: opportunity.senderKey, offerId: offer.id, offerRevision: offer.offerRevision, taskId: saved.id, reservedAt: now, status: 'queued' }));
      saveRequest({ ...opportunity, status: 'queued', taskId: saved.id, lastBlocker:null, deliveryStatus:'queued', updatedAt: now }); trace({ at: now, opportunityId: opportunity.id, taskId: saved.id, traceId: saved.traceId, stage: 'na_fila', recipient: saved.recipient });
      return { ok: true, task: saved };
    });
  }
  function finalGuardOpportunitySend(id, options = {}) {
    return transaction(() => { const now = clock(options.now ?? Date.now()), task = get('op_tasks', id); if (!task) return blocked('OP_NOT_FOUND'); const result = guard(get('op_requests', task.opportunityId), task, now, options);if(!result.ok)recordBlock(task.opportunityId,result,now); if (!result.ok && options.cancelOnBlocked !== false && task.status === 'queued' && !['OP_INTERVAL', 'OP_STOPPED'].includes(result.code)) { saveTask({ ...task, status: 'cancelled', cancelledAt: now, code: result.code, reason: result.reason }); trace({ at: now, opportunityId: task.opportunityId, taskId: task.id, stage: 'bloqueado_antes_envio', ...result }); } return result.ok ? { ok: true, task } : result; });
  }
  function claimOpportunityTask(id, options = {}) {
    return transaction(() => { const task = get('op_tasks', id); if (!task || task.status !== 'queued') return blocked(task?.status === 'uncertain' ? 'OP_UNCERTAIN' : 'OP_TASK_STATE'); const check = finalGuardOpportunitySend(id, options); if (!check.ok) return check; const now = clock(options.now ?? Date.now()); const claimed = saveTask({ ...check.task, status: 'sending', startedAt: check.task.startedAt || now, attempts: (check.task.attempts || 0) + 1, lastAttemptAt: now, dayKey: day(now, config().timezone) }); return { ok: true, task: claimed }; });
  }
  function updateOpportunityTask(id, patch) {
    return transaction(() => {
      const old = get('op_tasks', id); if (!old) throw new Error('Tarefa de oportunidade não encontrada.');
      if (old.messageId && patch.messageId && old.messageId !== patch.messageId && ['accepted','delivered'].includes(old.status)) throw new Error('Confirmação pertence a outra mensagem.');
      const status = patch.status || old.status, allowed = ['queued', 'sending', 'accepted', 'delivered', 'uncertain', 'failed', 'cancelled', 'outside']; if (!allowed.includes(status)) throw new Error('Estado de envio inválido.');
      if (['delivered', 'outside'].includes(old.status) && status !== old.status || old.status === 'accepted' && !['accepted', 'delivered'].includes(status)) return old;
      if (old.status === 'uncertain' && (['queued', 'sending', 'cancelled'].includes(status) || status === 'failed' && patch.confirmedFailure !== true && patch.proof !== true)) return old;
      if (old.status === 'cancelled' && ['queued', 'sending'].includes(status)) return old;
      if (['accepted', 'delivered'].includes(status) && !patch.messageId && !old.messageId && patch.proofAccepted !== true && patch.deliveryConfirmed !== true) throw new Error('Confirmação de envio exige evidência da integração.');
      if (status === 'sending' && old.status === 'queued') return claimOpportunityTask(id, { now: patch.lastAttemptAt ?? patch.startedAt ?? Date.now() }).task || old;
      const immutable = ['id', 'clientId', 'clientMessageId', 'senderKey', 'opportunityId', 'intentKey', 'familyKey', 'offerIds', 'recipient', 'createdAt', 'offerSnapshots', 'automatic', 'retryOf', 'availabilityMode', 'manualCampaignSelection']; for (const field of immutable) if (patch[field] !== undefined && JSON.stringify(patch[field]) !== JSON.stringify(old[field])) throw new Error('Identidade operacional da tarefa não pode ser alterada.');
      const value = saveTask({ ...old, ...safe(patch), status });
      for (const row of prepared('SELECT data FROM op_sent_offers WHERE storageMode=? AND taskId=?').all(mode(), id)) { const record = decode(row); prepared('UPDATE op_sent_offers SET data=? WHERE storageMode=? AND senderKey=? AND offerId=? AND taskId=?').run(JSON.stringify({ ...record, status, messageId: value.messageId || null, resultAt: value.resultAt || value.acceptedAt || value.deliveredAt || Date.now() }), mode(), value.senderKey, record.offerId, id); }
      const opportunity = get('op_requests', value.opportunityId); if (opportunity && !['closed', 'expired'].includes(opportunity.status)) saveRequest({ ...opportunity, status: ['accepted', 'delivered', 'outside'].includes(status) ? 'responded' : status === 'uncertain' ? 'uncertain' : status === 'cancelled' || status === 'failed' ? 'open' : status, deliveryStatus:status,lastResponseReason:value.reason||value.error||null,lastResponseAt:value.acceptedAt||value.deliveredAt||value.resultAt||null,lastBlocker:['failed','cancelled','uncertain'].includes(status) ? {code:value.code||'OP_UNCERTAIN',reason:value.reason||value.error||REASONS.OP_UNCERTAIN,at:value.resultAt||Date.now()} : null,updatedAt: value.resultAt || Date.now() });
      trace({ at: stamp(patch.resultAt || patch.acceptedAt || patch.deliveredAt || Date.now()), opportunityId: value.opportunityId, taskId: id, traceId: value.traceId, stage: status, code: value.code || null, reason: value.reason || value.error || null, messageId: value.messageId || null }); return value;
    });
  }
  Object.assign(store, {
    getOpportunityConfig: config, resolverOpportunityIdentity, resolveOpportunityIdentity:resolverOpportunityIdentity,
    setOpportunityConfig(input) { return transaction(() => { const value = normalizeOpportunityConfig(input, config()); safe(value); prepared('INSERT INTO op_config(storageMode,data)VALUES(?,?)ON CONFLICT(storageMode)DO UPDATE SET data=excluded.data').run(mode(), JSON.stringify(value)); return value; }); },
    ingestOpportunity, getOpportunity: id => get('op_requests', id),
    updateOpportunity(id, patch) { return transaction(() => { const old = get('op_requests', id); if (!old) throw new Error('Oportunidade não encontrada.'); for (const field of ['id','senderKey','originalAt','familyKey']) if (patch[field] !== undefined && patch[field] !== old[field]) throw new Error('Identidade da oportunidade não pode ser alterada.'); return saveRequest({ ...old, ...patch, expiresAt: Math.min(old.expiresAt, patch.expiresAt ?? old.expiresAt) }); }); },
    listOpportunities(filter = {}) {
      const where = ['storageMode=?'], args = [mode()];
      for (const field of ['status','senderKey','familyKey']) if (filter[field] !== undefined) { const values = Array.isArray(filter[field]) ? filter[field] : [filter[field]]; where.push(values.length ? `${field} IN(${values.map(() => '?').join(',')})` : '0'); args.push(...values); }
      if (filter.section === 'new') where.push("status='open'");
      else if (filter.section === 'following') where.push("status IN('queued','sending','responded','uncertain')");
      else if (filter.section === 'closed') where.push("status IN('closed','expired','cancelled')");
      else if (filter.section !== undefined && filter.section !== '') throw new Error('Seção de oportunidades inválida.');
      if (filter.query) { const query=String(filter.query).trim().slice(0,200).toLocaleLowerCase('pt-BR'); where.push("instr(lower(data),?)>0"); args.push(query); }
      const reviewClause = "(COALESCE(json_extract(data,'$.needsReview'),0)=1 OR COALESCE(json_extract(data,'$.request.safe'),0)<>1 OR COALESCE(json_extract(data,'$.request.complete'),0)<>1)";
      if (filter.intent === 'clear') where.push(`NOT ${reviewClause}`);
      else if (filter.intent === 'review') where.push(reviewClause);
      else if (filter.intent !== undefined && !['', 'all'].includes(filter.intent)) throw new Error('Filtro de intenção inválido.');
      const limit = Math.min(200, Math.max(1, Number(filter.limit) || 50)), offset = Math.max(0, Number(filter.offset) || 0), sql = where.join(' AND ');
      return { items: prepared(`SELECT data FROM op_requests WHERE ${sql} ORDER BY originalAt DESC,rowid DESC LIMIT ? OFFSET ?`).all(...args, limit, offset).map(decode), total: Number(prepared(`SELECT COUNT(*) n FROM op_requests WHERE ${sql}`).get(...args).n), limit, offset };
    },
    listOpportunityOrigins(id) { return prepared('SELECT data FROM op_origins WHERE storageMode=? AND opportunityId=? ORDER BY originalAt,rowid').all(mode(), key(id)).map(decode); },
    getOpportunityOrigin(chatId,messageId) { return decode(prepared('SELECT data FROM op_origins WHERE storageMode=? AND chatId=? AND messageId=?').get(mode(),key(chatId),key(messageId))); },
    updateOpportunityOrigin(chatId,messageId,patch = {}) { return transaction(() => {
      const old=store.getOpportunityOrigin(chatId,messageId); if(!old) return {ignored:true};
      if(!patch.senderKey || old.senderKey!==patch.senderKey) throw Object.assign(new Error('Remetente da edição não corresponde à origem.'),{code:'OP_ORIGIN_AUTHOR_MISMATCH'});
      const now=clock(patch.now ?? patch.revisionAt ?? Date.now());
      if(old.deleted || old.revisionAt && old.revisionAt >= (patch.revisionAt ?? now)) return {ignored:true,opportunity:get('op_requests',old.opportunityId)};
      const request=patch.request || old.request, opportunity=get('op_requests',old.opportunityId); if(!opportunity || !request?.intentKey || !request.familyKey) throw new Error('Edição sem pedido identificado com segurança.');
      const changedRelevant=opportunity.intentKey!==request.intentKey;
      const origin=safe({...old,text:patch.text ?? old.text,request,revisionAt:patch.revisionAt ?? now,edited:true,intentKey:request.intentKey});
      prepared('UPDATE op_origins SET data=? WHERE storageMode=? AND chatId=? AND messageId=?').run(JSON.stringify(origin),mode(),chatId,messageId);
      const updated=saveRequest({...opportunity,intentKey:request.intentKey,familyKey:request.familyKey,request,needsReview:opportunity.needsReview || changedRelevant || request.complete===false,changedRelevant:opportunity.changedRelevant || changedRelevant,updatedAt:now});
      const cancelled=changedRelevant ? cancelQueued(opportunity.id,'OP_REVIEW',now) : 0;
      trace({at:now,opportunityId:opportunity.id,stage:'pedido_editado',code:changedRelevant ? 'OP_REVIEW':'OP_EDIT',detail:changedRelevant ? 'Pedido alterado; resposta automática cancelada para revisão.':'Texto original atualizado sem nova resposta.'});
      return {opportunity:updated,origin,changedRelevant,cancelled};
    }); },
    deleteOpportunityOrigin(chatId,messageId,options={}) { return transaction(() => {
      const old=store.getOpportunityOrigin(chatId,messageId);if(!old)return {ignored:true};
      if(options.senderKey && old.senderKey!==options.senderKey) throw Object.assign(new Error('Remetente da exclusão não corresponde à origem.'),{code:'OP_ORIGIN_AUTHOR_MISMATCH'});
      const now=clock(options.at ?? options.now ?? Date.now()),origin={...old,deleted:true,deletedAt:now};
      prepared('UPDATE op_origins SET data=? WHERE storageMode=? AND chatId=? AND messageId=?').run(JSON.stringify(origin),mode(),chatId,messageId);
      const remaining=store.listOpportunityOrigins(old.opportunityId).filter(row=>!row.deleted).length;
      const result=remaining ? {ok:true,cancelled:0,opportunity:get('op_requests',old.opportunityId)} : store.closeOpportunity(old.opportunityId,{now,reason:'Todas as mensagens originais foram excluídas.'});
      trace({at:now,opportunityId:old.opportunityId,stage:'origem_excluida',detail:remaining ? 'Outras origens válidas permanecem; pedido mantido.':'Sem origens válidas; tarefas não iniciadas canceladas.'});
      return {...result,remainingOrigins:remaining,origin};
    }); },

    saveOpportunityOffer(input) { return transaction(() => { const old = get('op_offers', input.id); const value = safe({ ...old, ...input, id: key(input.id), storageMode: mode() }); prepared('INSERT INTO op_offers(storageMode,id,data)VALUES(?,?,?)ON CONFLICT(storageMode,id)DO UPDATE SET data=excluded.data').run(mode(), value.id, JSON.stringify(value)); return value; }); },
    getOpportunityOffer: id => get('op_offers', id), listOpportunityOffers() { return prepared('SELECT data FROM op_offers WHERE storageMode=? ORDER BY rowid').all(mode()).map(decode); },
    confirmOpportunityOfferAvailable(id, options = {}) { const old = get('op_offers', id); if (!old) throw new Error('Oferta não encontrada.'); return store.saveOpportunityOffer({ ...old, available: true, availabilityConfirmedAt: stamp(options.at ?? options.now ?? Date.now()), ...(options.quantity !== undefined ? { quantityAvailable: options.quantity } : {}), ...(options.unitReference ? { explicitUnitReference:key(options.unitReference), unitReference:key(options.unitReference), identityConfidence:'verified' } : {}) }); },
    getOpportunityContactMute(senderKey) { return decode(prepared('SELECT data FROM op_contacts WHERE storageMode=? AND senderKey=?').get(mode(), key(senderKey))); },
    setOpportunityContactMute(senderKey, value = true, options = {}) { return transaction(() => { const input = typeof value === 'object' ? value : { muted: !!value, ...options }, record = safe({ ...input, senderKey: key(senderKey), muted: input.muted !== false, updatedAt: stamp(input.at ?? input.now ?? Date.now()) }); prepared('INSERT INTO op_contacts(storageMode,senderKey,data)VALUES(?,?,?)ON CONFLICT(storageMode,senderKey)DO UPDATE SET data=excluded.data').run(mode(), senderKey, JSON.stringify(record)); if(record.muted) for(const row of prepared("SELECT data FROM op_tasks WHERE storageMode=? AND senderKey=? AND status='queued'").all(mode(),senderKey)) {const task=decode(row);saveTask({...task,status:'cancelled',cancelledAt:record.updatedAt,code:'OP_MUTED',reason:REASONS.OP_MUTED});} return record; }); },
    checkOpportunitySend, reserveOpportunitySend, reserveTaskAtomic: reserveOpportunitySend, finalGuardOpportunitySend, claimOpportunityTask,
    getOpportunityTask: id => get('op_tasks', id), listOpportunityTasks: listTasks, updateOpportunityTask,
    getNextOpportunityTaskAt() { const at = prepared("SELECT MIN(COALESCE(json_extract(data,'$.nextAttemptAt'),0)) AS at FROM op_tasks WHERE storageMode=? AND status='queued'").get(mode()).at; return at === null ? null : Number(at); },
    cancelOpportunityCampaign(campaignId, at=Date.now()) { return transaction(() => {
      const now=clock(at), clause="EXISTS(SELECT 1 FROM json_each(op_tasks.data,'$.offerSnapshots') offer WHERE json_extract(offer.value,'$.campaignId')=?)";
      const inProgress=Number(prepared(`SELECT COUNT(*)n FROM op_tasks WHERE storageMode=? AND status='sending' AND ${clause}`).get(mode(),campaignId).n);
      let cancelled=0;
      for(;;) { const rows=prepared(`SELECT data FROM op_tasks WHERE storageMode=? AND status='queued' AND ${clause} LIMIT 200`).all(mode(),campaignId); if(!rows.length)break;
        for(const row of rows) { const task=decode(row); updateOpportunityTask(task.id,{status:'cancelled',cancelledAt:now,resultAt:now,code:'OP_CAMPAIGN_REMOVED',reason:'A campanha da oferta foi excluída; resposta pendente cancelada.'}); cancelled++; }
      }
      return {cancelled,inProgress};
    }); },
    closeOpportunity(id, options = {}) { return transaction(() => { const old = get('op_requests', id); if (!old) return blocked('OP_NOT_FOUND'); const now = clock(options.now ?? Date.now()); const cancelled = cancelQueued(id, 'OP_CLOSED', now); return { ok: true, cancelled, opportunity: saveRequest({ ...old, status: 'closed', closedAt: now, closeReason: options.reason || 'Encerramento confirmado.', updatedAt: now }) }; }); },
    outsideAnswerOpportunity(id, options = {}) { return transaction(() => { const opportunity = get('op_requests', id); if (!opportunity) return blocked('OP_NOT_FOUND'); const now = clock(options.now ?? Date.now()); const cancelled = cancelQueued(id, 'OP_ALREADY_RESPONDED', now), clientId = `outside:${id}`; let task = decode(prepared('SELECT data FROM op_tasks WHERE storageMode=? AND clientId=?').get(mode(), clientId)); if (!task) task = saveTask({ id: randomUUID(), clientId, opportunityId: id, senderKey: opportunity.senderKey, intentKey: opportunity.intentKey, familyKey: opportunity.familyKey, recipient: opportunity.senderKey, offerIds: [], status: 'outside', automatic: false, createdAt: now, dayKey: day(now, config().timezone), actorId: options.actorId || null }); return { ok: true, cancelled, task, opportunity: saveRequest({ ...opportunity, status: 'responded', outsideAnsweredAt: task.createdAt, updatedAt: now }) }; }); },
    reactivateOpportunity(id, options = {}) { return transaction(() => { const old = get('op_requests', id); if (!old) return blocked('OP_NOT_FOUND'); const now = clock(options.now ?? Date.now()); store.setOpportunityContactMute(old.senderKey, false, { at: now }); return { ok: true, opportunity: saveRequest({ ...old, status: old.expiresAt <= now ? 'expired' : 'open', reactivatedAt: now, updatedAt: now }), repetitionControlsPreserved: true }; }); },
    cancelOpportunityTasks(options = {}) { return transaction(() => { const now = clock(options.now ?? Date.now()); let cancelled = 0, inProgress = 0; const automaticClause=options.automaticOnly!==false ? " AND json_extract(data,'$.automatic')=1" : '';
      inProgress=Number(prepared(`SELECT COUNT(*)n FROM op_tasks WHERE storageMode=? AND status='sending'${automaticClause}`).get(mode()).n);
      for(;;){const rows=prepared(`SELECT data FROM op_tasks WHERE storageMode=? AND status='queued'${automaticClause} LIMIT 200`).all(mode());if(!rows.length)break;for(const row of rows){const task=decode(row);saveTask({...task,status:'cancelled',cancelledAt:now,code:'OP_STOPPED',reason:options.reason||REASONS.OP_STOPPED});cancelled++;}} return { cancelled, inProgress }; }); },
    recoverOpportunityTasks(at = Date.now()) { return transaction(() => { const now = clock(at); let uncertain = 0; for (const task of listTasks({ status: 'sending', limit: 1000 })) { updateOpportunityTask(task.id, { status: 'uncertain', resultAt: now, code: 'OP_RESTART_UNCERTAIN', reason: 'Aplicativo encerrou durante o envio; não reenviar automaticamente.' }); uncertain++; } return { uncertain, queued: listTasks({ status: 'queued', limit: 1000 }).length }; }); },
    getOpportunityOfferSent(senderKey, offerId) { const rows = sentRecords(senderKey,offerId); return rows.at(-1); },
    expireOpportunities(at = Date.now()) { return transaction(() => { const now=clock(at); let expired=0,cancelled=0; for(const row of prepared("SELECT data FROM op_requests WHERE storageMode=? AND expiresAt<=? AND status NOT IN('expired','closed','responded','uncertain')").all(mode(),now)) { const opportunity=decode(row); cancelled += cancelQueued(opportunity.id,'OP_EXPIRED',now,{respectReviewedExpired:true}); saveRequest({...opportunity,status:'expired',updatedAt:now}); expired++; } return {expired,cancelled}; }); },
    getOpportunitySentOffers(senderKey) { return prepared('SELECT data FROM op_sent_offers WHERE storageMode=? AND senderKey=? ORDER BY rowid').all(mode(), key(senderKey)).map(decode); },
    addOpportunityTrace: record => transaction(() => trace(record)), traceOpportunity: record => transaction(() => trace(record)),
    pruneOpportunityTraces({now=Date.now(),retentionDays=30,maxRows=10000}={}) { if(!Number.isInteger(retentionDays)||retentionDays<1||retentionDays>3650||!Number.isInteger(maxRows)||maxRows<100||maxRows>1000000)throw new Error('Retenção de diagnóstico inválida.');return transaction(()=>{ const a=prepared('DELETE FROM op_traces WHERE storageMode=? AND at<?').run(mode(),stamp(now)-retentionDays*86400000),b=prepared('DELETE FROM op_traces WHERE storageMode=? AND id IN(SELECT id FROM op_traces WHERE storageMode=? ORDER BY at DESC,rowid DESC LIMIT -1 OFFSET ?)').run(mode(),mode(),maxRows);return {removed:Number(a.changes)+Number(b.changes),operationalDataPreserved:true}; }); },
    listOpportunityTraces(filter = {}) { const where = ['storageMode=?'], args = [mode()]; for (const field of ['opportunityId','taskId']) if (filter[field]) { where.push(`${field}=?`); args.push(filter[field]); } return prepared(`SELECT data FROM op_traces WHERE ${where.join(' AND ')} ORDER BY at DESC,rowid DESC LIMIT ?`).all(...args, Math.min(500, Math.max(1, Number(filter.limit) || 100))).map(decode); },
    registerOpportunityNotification(ids, options = {}) { return transaction(() => { const now = clock(options.now ?? Date.now()), added = []; for (const id of Array.isArray(ids) ? ids : [ids]) { const kind = options.kind || 'new_compatible'; if (!get('op_requests', id)) continue; const value = safe({ ...options, opportunityId: id, kind, at: now }); const result = prepared('INSERT OR IGNORE INTO op_notifications(storageMode,opportunityId,kind,at,data)VALUES(?,?,?,?,?)').run(mode(), key(id), key(kind), now, JSON.stringify(value)); if (result.changes) added.push(id); } return { registered: added.length > 0, ids: added, newIds: added }; }); },
    getOpportunityMetrics() { const statuses = {}; for (const row of prepared('SELECT status,COUNT(*)n FROM op_requests WHERE storageMode=? GROUP BY status').all(mode())) statuses[row.status] = Number(row.n); const tasks = {}; for (const row of prepared('SELECT status,COUNT(*)n FROM op_tasks WHERE storageMode=? GROUP BY status').all(mode())) tasks[row.status] = Number(row.n); const review=Number(prepared("SELECT COUNT(*)n FROM op_requests WHERE storageMode=? AND status NOT IN('closed','expired','cancelled') AND json_extract(data,'$.needsReview')=1").get(mode()).n); return { ...statuses, statuses, tasks, review, total: Object.values(statuses).reduce((sum,n) => sum+n,0), origins: Number(prepared('SELECT COUNT(*)n FROM op_origins WHERE storageMode=?').get(mode()).n) }; },
    exportOpportunityData() { const result = { version: 1, storageMode: mode(), config: config() }; for (const [name, table] of Object.entries({ opportunities:'op_requests',origins:'op_origins',contacts:'op_contacts',offers:'op_offers',tasks:'op_tasks',sentOffers:'op_sent_offers',notifications:'op_notifications',identityAliases:'op_identity_aliases' })) result[name] = prepared(`SELECT data FROM ${table} WHERE storageMode=? ORDER BY rowid`).all(mode()).map(decode).map(safe); result.lastAt = Number(prepared('SELECT lastAt FROM op_clock WHERE storageMode=?').get(mode())?.lastAt || 0); return result; },
    importOpportunityData(input) {
      if (!input || input.version !== 1 || input.storageMode !== mode()) throw new Error('Backup de oportunidades pertence a outro modo ou versão.');
      const names = ['opportunities','origins','contacts','offers','tasks','sentOffers','notifications'];if(input.identityAliases!==undefined && (!Array.isArray(input.identityAliases)||input.identityAliases.length>100000))throw new Error('Vínculos de identidade inválidos no backup.'); for (const name of names) if (!Array.isArray(input[name]) || input[name].length > 100000) throw new Error('Backup de oportunidades inválido.'); safe(input);
      const statusSet=new Set(['open','queued','sending','responded','uncertain','closed','cancelled','expired']);
      for(const opportunity of input.opportunities) {key(opportunity.id);key(opportunity.senderKey);key(opportunity.familyKey);key(opportunity.intentKey);stamp(opportunity.originalAt);stamp(opportunity.expiresAt);if(!statusSet.has(opportunity.status))throw new Error('Estado de oportunidade inválido no backup.');}
      for(const task of input.tasks) {key(task.id);key(task.clientId);key(task.senderKey);stamp(task.createdAt);key(task.dayKey);if(!['queued','sending','accepted','delivered','uncertain','failed','cancelled','outside'].includes(task.status)||!Array.isArray(task.offerIds))throw new Error('Tarefa inválida no backup.');task.offerIds.forEach(id=>key(id));}
      return transaction(() => {
        let preserved = 0; store.setOpportunityConfig({ ...input.config, enabled: false, automatic: false, evaluation: true, mode: 'evaluation' }); clock(stamp(input.lastAt || 0));
        for (const opportunity of input.opportunities) { const old=get('op_requests',opportunity.id);if(old) {
          for(const field of ['senderKey','familyKey']) if(old[field]!==opportunity[field])throw new Error('Backup altera identidade da oportunidade existente.');
          const terminal=['closed','responded','uncertain','expired'];const status=terminal.includes(old.status) ? old.status : terminal.includes(opportunity.status) ? opportunity.status : old.status;
          saveRequest({...old,needsReview:old.needsReview || opportunity.needsReview,status,expiresAt:Math.min(old.expiresAt,opportunity.expiresAt),originalAt:Math.min(old.originalAt,opportunity.originalAt)});preserved++;continue;
        }saveRequest(opportunity); }
        for (const origin of input.origins) { if (!get('op_requests', origin.opportunityId)) throw new Error('Origem sem oportunidade no backup.'); if (origin.senderKey !== get('op_requests', origin.opportunityId).senderKey) throw new Error('Origem pertence a outro interessado no backup.'); const old = decode(prepared('SELECT data FROM op_origins WHERE storageMode=? AND chatId=? AND messageId=?').get(mode(), key(origin.chatId), key(origin.messageId))); if (old && old.opportunityId !== origin.opportunityId) throw new Error('Origem conflita com controle operacional existente.'); prepared('INSERT OR IGNORE INTO op_origins(storageMode,chatId,messageId,opportunityId,originalAt,data)VALUES(?,?,?,?,?,?)').run(mode(), origin.chatId, origin.messageId, origin.opportunityId, stamp(origin.originalAt), JSON.stringify(origin)); }
        for (const contact of input.contacts) { const old = store.getOpportunityContactMute(contact.senderKey); if (!old || contact.muted && !old.muted) store.setOpportunityContactMute(contact.senderKey, contact); }
        for (const offer of input.offers) if (!get('op_offers', offer.id)) store.saveOpportunityOffer(offer);
        for (const task of input.tasks) { if (!get('op_requests', task.opportunityId)) throw new Error('Tarefa sem oportunidade no backup.'); const opportunity=get('op_requests',task.opportunityId);if(opportunity.senderKey!==task.senderKey)throw new Error('Tarefa pertence a outro interessado no backup.');const old = get('op_tasks', task.id), client = decode(prepared('SELECT data FROM op_tasks WHERE storageMode=? AND clientId=?').get(mode(), key(task.clientId))); if (client && client.id !== task.id) throw new Error('Reserva duplicada no backup.'); if (old) { for (const field of ['clientId','opportunityId','senderKey','createdAt','offerIds']) if (JSON.stringify(old[field]) !== JSON.stringify(task[field])) throw new Error('Backup altera identidade operacional existente.'); preserved++; if (task.status === 'delivered' && old.status !== 'delivered' && task.messageId) updateOpportunityTask(old.id, { status: 'delivered', messageId: task.messageId, deliveredAt: task.deliveredAt, proofAccepted: true }); else if (['uncertain','accepted'].includes(task.status) && ['queued','sending','cancelled','failed'].includes(old.status)) updateOpportunityTask(old.id, { status: task.status, messageId: task.messageId, resultAt: task.resultAt, proofAccepted: task.status === 'accepted' }); continue; } saveTask({ ...task, status: task.status === 'sending' ? 'uncertain' : task.status === 'queued' ? 'cancelled' : task.status, restoreReviewRequired: true }); }
        for (const record of input.sentOffers) { const task = get('op_tasks', record.taskId); if (!task || task.senderKey !== record.senderKey || !task.offerIds.includes(record.offerId)) throw new Error('Controle de oferta enviada inconsistente no backup.'); prepared('INSERT OR IGNORE INTO op_sent_offers(storageMode,senderKey,offerId,taskId,data)VALUES(?,?,?,?,?)').run(mode(), key(record.senderKey), key(record.offerId), key(record.taskId), JSON.stringify(record)); }
        for(const alias of input.identityAliases||[]){key(alias.alias);key(alias.senderKey);if(!/^(?:phone:[1-9]\d{9,14}|account:[1-9]\d{0,30}@(s\.whatsapp\.net|lid))$/.test(alias.alias)||alias.phone && !/^[1-9]\d{9,14}$/.test(alias.phone))throw new Error('Identificador de conta inválido no backup.');const old=decode(prepared('SELECT data FROM op_identity_aliases WHERE storageMode=? AND alias=?').get(mode(),alias.alias));if(old && (old.senderKey!==alias.senderKey || old.phone&&alias.phone&&old.phone!==alias.phone))throw new Error('Vínculo de identidade conflita com os controles existentes.');prepared('INSERT OR IGNORE INTO op_identity_aliases(storageMode,alias,senderKey,data)VALUES(?,?,?,?)').run(mode(),alias.alias,alias.senderKey,JSON.stringify(alias));}
        for (const rawNotification of input.notifications) { const notification = restoreWorkflowNotification(rawNotification); if (!get('op_requests', notification.opportunityId)) throw new Error('Notificação sem oportunidade no backup.'); prepared('INSERT OR IGNORE INTO op_notifications(storageMode,opportunityId,kind,at,data)VALUES(?,?,?,?,?)').run(mode(), key(notification.opportunityId), key(notification.kind), stamp(notification.at), JSON.stringify(notification)); }
        return { restored: input.opportunities.length, preserved, automaticResume: false, enabled: false };
      });
    }
  });
  attachOpportunityWorkflowStore(store, { db, prepared, transaction, mode, decode, key, stamp, safe, clock, config, saveRequest, trace });
  return store;
}
module.exports = { attachOpportunityStore, normalizeOpportunityConfig, DEFAULTS, REASONS };
