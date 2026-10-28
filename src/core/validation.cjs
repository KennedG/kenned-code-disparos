const {randomUUID} = require('node:crypto');
const validTime = t => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
function number(value, min, max, name) { const n = Number(value); if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name}: informe um valor entre ${min} e ${max}.`); return n; }
function schedule(s = {}) {
  const r = {days:s.days ?? [0,1,2,3,4,5,6],startTime:s.startTime ?? '08:00',endTime:s.endTime ?? '18:00',startDate:s.startDate || '',endDate:s.endDate || ''};
  if (!Array.isArray(r.days) || !r.days.length || r.days.some(d=>!Number.isInteger(d)||d<0||d>6) || !validTime(r.startTime) || !validTime(r.endTime)) throw new Error('Dias ou horários inválidos.');
  for (const d of [r.startDate,r.endDate]) if (d && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d)) || new Date(d).toISOString().slice(0,10)!==d)) throw new Error('Data inválida.');
  if (r.startDate && r.endDate && r.endDate < r.startDate) throw new Error('O encerramento deve ocorrer após o início.');
  return r;
}
function items(values, store) {
  if (!Array.isArray(values) || values.length > 100) throw new Error('Use até 100 conteúdos por campanha.');
  const seen = new Set();
  return values.map(v => {
    if (!['text','image','video','document'].includes(v.type)) throw new Error('Tipo de conteúdo inválido.');
    const id = v.id || randomUUID(); if (seen.has(id)) throw new Error('Cada conteúdo precisa de um identificador exclusivo.'); seen.add(id);
    if (v.type === 'text') { const text = String(v.text || ''); if (!text.trim() || text.length > 16000) throw new Error('Informe um texto de até 16.000 caracteres.'); return {id,type:'text',text}; }
    const m = store.getMedia(v.mediaId); if (!m) throw new Error('Mídia não encontrada na pasta gerenciada.');
    const caption = String(v.caption || ''); if (caption.length > 1000) throw new Error('Legenda: use até 1.000 caracteres.');
    return {id,type:m.type,mediaId:m.id,caption};
  });
}
function campaign(input, store) {
  const old = input.id ? store.getCampaign(input.id) : null;
  const id = old?.id || randomUUID();
  if (!String(input.name || '').trim() || String(input.name).length > 120) throw new Error('Informe um nome de até 120 caracteres.');
  const ids = [...new Set(input.groupIds || [])]; const max = store.getSetting('maxSelectedGroups',15);
  if (ids.length > max) throw new Error(`Limite configurado: ${max} grupos. Altere em Configurações.`);
  if (ids.some(g=>!store.getGroup(g))) throw new Error('Um grupo não está disponível. Atualize a lista.');
  if (!['repeat','rotate'].includes(input.mode)) throw new Error('Modo de conteúdo inválido.');
  for (const key of ['dailyRoundLimit','dailySendLimit']) if (input[key] !== undefined && !Number.isInteger(Number(input[key]))) throw new Error('Limites diários devem ser números inteiros.');
  const overrides = {};
  for (const [g,v] of Object.entries(input.groupOverrides || {})) {
    if (!ids.includes(g) || !v.enabled) continue;
    overrides[g] = {enabled:true,intervalMinutes:number(v.intervalMinutes ?? input.intervalMinutes,1,10080,'Intervalo do grupo'),schedule:schedule(v.schedule || input.schedule)};
    if (v.items?.length) overrides[g].items = items(v.items,store);
  }
  return {id,name:String(input.name).trim(),state:old?.state || 'draft',mode:input.mode,intervalMinutes:number(input.intervalMinutes,1,10080,'Intervalo entre rodadas'),spacingSeconds:number(input.spacingSeconds,3,3600,'Espaçamento entre envios'),schedule:schedule(input.schedule),dailyRoundLimit:number(input.dailyRoundLimit || 0,0,10000,'Limite diário de rodadas'),dailySendLimit:number(input.dailySendLimit || 0,0,100000,'Limite diário de envios'),groupIds:ids,items:items(input.items || [],store),groupOverrides:overrides,nextRunAt:old?.nextRunAt || null,roundIndex:old?.roundIndex || 0,revision:old?.revision || 0,configRevision:old?.configRevision||0};
}
module.exports = {campaign,items,schedule,number};
