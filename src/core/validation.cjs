const {assertCampaignSchemaCompatible}=require('./campaign-schema-compat.cjs');
const {randomUUID} = require('node:crypto');
const validTime = t => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
function number(value, min, max, name) { const n = Number(value); if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name}: informe um valor entre ${min} e ${max}.`); return n; }
function schedule(s = {}) {
  const r = {days:s.days ?? [0,1,2,3,4,5,6],startTime:s.startTime ?? '08:00',endTime:s.endTime ?? '18:00',startDate:s.startDate || '',endDate:s.endDate || ''};
  if (!Array.isArray(r.days) || !r.days.length || r.days.some(d=>!Number.isInteger(d)||d<0||d>6) || !validTime(r.startTime) || !validTime(r.endTime)) throw new Error('Dias ou horários inválidos.');
  for (const d of [r.startDate,r.endDate]) if (d && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d)) || new Date(d).toISOString().slice(0,10)!==d)) throw new Error('Data inválida.');
  if (r.startDate && r.endDate && r.endDate < r.startDate) throw new Error('O encerramento deve ocorrer após o início.');
  if(s.timezone!==undefined){if(typeof s.timezone!=='string'||s.timezone.length>100)throw new Error('Fuso horário inválido.');try{new Intl.DateTimeFormat('pt-BR',{timeZone:s.timezone}).format(0);}catch{throw new Error('Fuso horário inválido.');}r.timezone=s.timezone;}
  return r;
}
function items(values, store) {
  assertCampaignSchemaCompatible({items:values});
  if (!Array.isArray(values) || values.length > 100) throw new Error('Use até 100 conteúdos por campanha.');
  const seen = new Set();
  return values.map(v => {
    if (!['text','image','video','document'].includes(v.type)) throw new Error('Tipo de conteúdo inválido.');
    const id = v.id || randomUUID(); if (seen.has(id)) throw new Error('Cada conteúdo precisa de um identificador exclusivo.'); seen.add(id);
    if (v.type === 'text') { const text = String(v.text || ''); if (!text.trim() || text.length > 16000) throw new Error('Informe um texto de até 16.000 caracteres.'); return {id,type:'text',text,...sourceMetadata(v)}; }
    const m = store.getMedia(v.mediaId); if (!m) throw new Error('Mídia não encontrada na pasta gerenciada.');
    const caption = String(v.caption || ''); if (caption.length > 16000) throw new Error('Legenda: use até 16.000 caracteres. O WhatsApp pode recusar legendas acima do limite disponível na integração.');
    return {id,type:m.type,mediaId:m.id,caption,...sourceMetadata(v)};
  });
}
function campaign(input, store) {
  const old = input.id ? store.getCampaign(input.id) : null;
  assertCampaignSchemaCompatible(input);if(old)assertCampaignSchemaCompatible(old);
  const id = old?.id || randomUUID();
  if (!String(input.name || '').trim() || String(input.name).length > 120) throw new Error('Informe um nome de até 120 caracteres.');
  const ids = [...new Set(input.groupIds || [])]; const max = store.getSetting('maxSelectedGroups',15);
  if (ids.length > max) throw new Error(`Limite configurado: ${max} grupos. Altere em Configurações.`);
  if (ids.some(g=>!store.getGroup(g))) throw new Error('Um grupo não está disponível. Atualize a lista.');
  const storageMode=store.getStorageMode?.();
  if(storageMode&&ids.some(g=>Boolean(store.getGroup(g).simulation)!==(storageMode==='simulated')))throw new Error('Selecione somente grupos do modo atual de integração.');
  if ((input.sourceGroupId??old?.sourceGroupId) && ids.includes(input.sourceGroupId??old.sourceGroupId)) throw new Error('O grupo de origem não pode ser destino da própria automação.');
  if (!['repeat','rotate'].includes(input.mode)) throw new Error('Modo de conteúdo inválido.');
  for (const key of ['dailyRoundLimit','dailySendLimit']) if (input[key] !== undefined && !Number.isInteger(Number(input[key]))) throw new Error('Limites diários devem ser números inteiros.');
  const overrides = {};
  for (const [g,v] of Object.entries(input.groupOverrides || {})) {
    if (!ids.includes(g) || !v.enabled) continue;
    overrides[g] = {enabled:true,intervalMinutes:number(v.intervalMinutes ?? input.intervalMinutes,1,10080,'Intervalo do grupo'),schedule:schedule(v.schedule || input.schedule)};
    if (v.items?.length) overrides[g].items = items(v.items,store);
  }
  const references=(values,name)=>{if(!Array.isArray(values)||values.length>100||values.some(v=>typeof v!=='string'||!v||v.length>512))throw new Error(`${name}: lista inválida.`);return [...new Set(values)];};
  const policy=input.retryPolicy??old?.retryPolicy??{maxAttempts:3,delaySeconds:3};
  const maxAttempts=number(policy.maxAttempts??3,1,5,'Tentativas máximas');
  if(!Number.isInteger(maxAttempts))throw new Error('Tentativas máximas devem ser um número inteiro.');
  const retryPolicy={maxAttempts,delaySeconds:number(policy.delaySeconds??3,3,3600,'Intervalo entre tentativas'),backoffFactor:number(policy.backoffFactor??2,1,10,'Fator progressivo das tentativas')};
  const ownerId=input.ownerId??old?.ownerId??old?.ownerUserId??null;
  if(ownerId!==null&&(typeof ownerId!=='string'||!ownerId||ownerId.length>512))throw new Error('Dono da campanha inválido.');
  const maxRounds=number(input.maxRounds??old?.maxRounds??0,0,100000,'Quantidade máxima de rodadas');if(!Number.isInteger(maxRounds))throw new Error('A quantidade de rodadas deve ser inteira.');
  const endValue=input.endAt??old?.endAt??null,endAt=endValue===null||endValue===''?null:typeof endValue==='number'?endValue:Date.parse(endValue);if(endAt!==null&&!Number.isFinite(endAt))throw new Error('Encerramento inválido.');
  return {id,name:String(input.name).trim(),state:old?.state || 'draft',mode:input.mode,...(storageMode?{storageMode}:{}),intervalMinutes:number(input.intervalMinutes,1,10080,'Intervalo entre rodadas'),spacingSeconds:number(input.spacingSeconds,3,3600,'Intervalo entre grupos'),messageSpacingSeconds:number(input.messageSpacingSeconds??old?.messageSpacingSeconds??input.spacingSeconds,3,3600,'Intervalo entre mensagens'),sendTimeoutSeconds:number(input.sendTimeoutSeconds??old?.sendTimeoutSeconds??store.getSetting('submissionTimeoutSeconds',30),5,300,'Tempo limite por tentativa'),maxRounds,endAt,schedule:schedule(input.schedule),dailyRoundLimit:number(input.dailyRoundLimit || 0,0,10000,'Limite diário de rodadas'),dailySendLimit:number(input.dailySendLimit || 0,0,100000,'Limite diário de envios'),groupIds:ids,items:items(input.items || [],store),groupOverrides:overrides,ownerId,responsibleUserIds:references(input.responsibleUserIds??old?.responsibleUserIds??[],'Responsáveis'),alertRecipientIds:references(input.alertRecipientIds??old?.alertRecipientIds??[],'Destinatários'),retryPolicy,...((old?.sourceGroupId||input.sourceGroupId)?{sourceGroupId:old?.sourceGroupId||input.sourceGroupId,sourceDateKey:old?.sourceDateKey||input.sourceDateKey,sourceManaged:true,sourceTimezone:old?.sourceTimezone||'America/Sao_Paulo',sourceRevision:old?.sourceRevision||0,sourceOrderCustomized:old?.sourceOrderCustomized===true||!!old?.sourceManaged&&(input.items||[]).some((item,index)=>old.items?.[index]?.id!==item.id),sourceConfigurationRequired:old?.sourceConfigurationRequired===true}:{}),...(old?.destinationHealth?{destinationHealth:old.destinationHealth}:{}),...Object.fromEntries(['roundAnchorAt','lastImmediateRequestId','executionAuthorization','executionRecovery','executionPendingRoundId','groupLastScheduledSlots','lastRoundAt','lastRoundScheduledAt','lastExecutionDayKey','scheduleClock'].filter(key=>old?.[key]!==undefined).map(key=>[key,old[key]])),nextRunAt:old?.nextRunAt || null,roundIndex:old?.roundIndex || 0,revision:old?.revision || 0,configRevision:old?.configRevision||0};
}
function sourceMetadata(value){const out={};for(const key of ['sourcePublicationId','sourceGroupId','sourceMessageId','sourceDateKey','sourceGroupKey','sourceAlbumParent','sourceManualGroupId'])if(typeof value[key]==='string'&&value[key].length<=512)out[key]=value[key];if(value.sourceAlbumParent&&typeof value.sourceAlbumParent==='object'){const parent=value.sourceAlbumParent;if(Array.isArray(parent)||typeof parent.messageId!=='string'||!parent.messageId||parent.messageId.length>512||typeof parent.chatId!=='string'||!parent.chatId||parent.chatId.length>512)throw new Error('Associação original das fotos inválida.');out.sourceAlbumParent={messageId:parent.messageId,chatId:parent.chatId};}if(Number.isSafeInteger(value.sourcePublicationRevision)&&value.sourcePublicationRevision>=0)out.sourcePublicationRevision=value.sourcePublicationRevision;if(value.ready!==undefined)out.ready=value.ready===true;if(value.captureDeleted!==undefined)out.captureDeleted=value.captureDeleted===true;if(typeof value.captureStatus==='string')out.captureStatus=value.captureStatus;for(const key of ['unitReference','offerReference','imei','serialNumber','serial','originalOfferId'])if(value[key]!==undefined){if(typeof value[key]!=='string'||!value[key].trim()||value[key].length>512)throw new Error('Referência da unidade inválida.');out[key]=value[key].trim();}
if(value.originalReference!==undefined){const reference=value.originalReference;if(!reference||typeof reference!=='object'||Array.isArray(reference))throw new Error('Referência original inválida.');out.originalReference={};for(const key of ['offerId','groupId','messageId','publicationId'])if(reference[key]!==undefined){if(typeof reference[key]!=='string'||!reference[key]||reference[key].length>512)throw new Error('Referência original inválida.');out.originalReference[key]=reference[key];}}
if(value.availability!==undefined){const a=value.availability;if(!a||typeof a!=='object'||Array.isArray(a)||typeof a.available!=='boolean'||!Number.isSafeInteger(a.confirmedAt)||a.confirmedAt<0)throw new Error('Confirmação de disponibilidade inválida.');out.availability={available:a.available,confirmedAt:a.confirmedAt};if(a.quantity!==undefined){if(!Number.isInteger(a.quantity)||a.quantity<0||a.quantity>10000)throw new Error('Quantidade disponível inválida.');out.availability.quantity=a.quantity;}}
if(value.available!==undefined){if(typeof value.available!=='boolean')throw new Error('Disponibilidade inválida.');out.available=value.available;}
if(value.opportunityAvailable!==undefined){if(typeof value.opportunityAvailable!=='boolean')throw new Error('Participação do item nas Oportunidades inválida.');out.opportunityAvailable=value.opportunityAvailable;}
if(value.availabilityConfirmedAt!==undefined){if(!Number.isSafeInteger(value.availabilityConfirmedAt)||value.availabilityConfirmedAt<0)throw new Error('Horário da disponibilidade inválido.');out.availabilityConfirmedAt=value.availabilityConfirmedAt;}
if(value.quantityAvailable!==undefined){if(!Number.isInteger(value.quantityAvailable)||value.quantityAvailable<0||value.quantityAvailable>10000)throw new Error('Quantidade disponível inválida.');out.quantityAvailable=value.quantityAvailable;}
return out;}
module.exports = {campaign,items,schedule,number};
