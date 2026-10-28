'use strict';
const MINIMUM_SPACING_MS = 3000;
class ValidationError extends Error {
  constructor(message, code = 'VALIDATION_ERROR') { super(message); this.name = 'ValidationError'; this.code = code; }
}
function fail(message, code) { throw new ValidationError(message, code); }
function cleanText(value, name, { max = 4096, required = false } = {}) {
  if (value == null) value = '';
  if (typeof value !== 'string') fail(`${name}: informe um texto válido.`);
  if (value.length > max) fail(`${name}: o limite é de ${max} caracteres.`);
  if (required && !value.trim()) fail(`${name}: preenchimento obrigatório.`);
  return value;
}
function integer(value, name, min, max, fallback) {
  const n = value == null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) fail(`${name}: informe um número inteiro entre ${min} e ${max}.`);
  return n;
}
function normalizePhone(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value).trim();
  if (raw.includes('@') || /[a-z]/i.test(raw) || !/^\+?[\d\s().-]+$/.test(raw)) return null;
  const digits = raw.replace(/\D/g, '');
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  return digits;
}
function validateCommunityLink(value) {
  const link = cleanText(value, 'Link da comunidade', { required: true, max: 2048 });
  if (link !== link.trim()) fail('Link da comunidade: remova espaços antes ou depois do endereço.');
  let url; try { url = new URL(link); } catch { fail('Informe o link completo e válido da comunidade.'); }
  if (url.protocol !== 'https:' || !['chat.whatsapp.com', 'www.whatsapp.com', 'whatsapp.com'].includes(url.hostname.toLowerCase()) || url.username || url.password || url.port) fail('Use um link HTTPS de convite do WhatsApp, sem credenciais.');
  if (!url.pathname || url.pathname === '/' || url.hash) fail('O link precisa identificar a comunidade ou seu convite.');
  if (['whatsapp.com', 'www.whatsapp.com'].includes(url.hostname.toLowerCase()) && !/^\/channel\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) fail('Use o link de convite completo fornecido pelo WhatsApp.');
  return link;
}
function validateTemplate(input = {}) {
  const message = cleanText(input.message ?? input.text, 'Mensagem', { required: true });
  validatePlaceholders(message);
  return { ...input, name: cleanText(input.name, 'Nome do modelo', { required: true, max: 120 }).trim(), message,
    communityLink: input.communityLink ? validateCommunityLink(input.communityLink) : '',
    fallbackName: cleanText(input.fallbackName ?? 'Olá', 'Nome alternativo', { max: 100 }) };
}
function validatePlaceholders(text) {
  for (const match of text.matchAll(/\{([^{}]+)\}/g)) if (!['nome', 'link_comunidade'].includes(match[1])) fail(`Campo desconhecido: {${match[1]}}. Use {nome} ou {link_comunidade}.`);
}
function validateCampaign(input = {}, { existing = {}, minimumSpacingMs = MINIMUM_SPACING_MS } = {}) {
  const merged = { ...existing, ...input };
  const intervalUnit = merged.intervalUnit ?? 'seconds';
  if (!['seconds', 'minutes'].includes(intervalUnit)) fail('A unidade do intervalo deve ser segundos ou minutos.');
  const intervalValue = integer(merged.intervalValue, 'Tempo entre envios para contatos', 1, 86400, 30);
  const intervalMs = intervalValue * (intervalUnit === 'minutes' ? 60000 : 1000);
  if (intervalMs < Math.max(MINIMUM_SPACING_MS, minimumSpacingMs)) fail(`O intervalo mínimo configurado pelo aplicativo é ${Math.ceil(Math.max(MINIMUM_SPACING_MS, minimumSpacingMs) / 1000)} segundos. Esse limite não é garantia de aceitação pelo WhatsApp.`, 'INTERVAL_TOO_SHORT');
  const message = cleanText(merged.message, 'Mensagem', { required: true }); validatePlaceholders(message);
  const mode = merged.mode ?? 'new'; if (!['new', 'all'].includes(mode)) fail('Selecione somente novos ou reenviar para todos.');
  const schedule = { days: [0, 1, 2, 3, 4, 5, 6], startTime: '00:00', endTime: '23:59', ...(merged.schedule || {}) };
  if (!Array.isArray(schedule.days) || !schedule.days.length || schedule.days.some(n => !Number.isInteger(n) || n < 0 || n > 6)) fail('Selecione ao menos um dia da semana válido.');
  schedule.days = [...new Set(schedule.days)].sort();
  for (const field of ['startTime', 'endTime']) if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule[field])) fail('Informe horários válidos no formato HH:mm.');
  if (schedule.startTime === schedule.endTime) fail('O início e o término da janela precisam ser diferentes.');
  let startAt = merged.startAt ?? null;
  if (startAt !== null && startAt !== '') { startAt = typeof startAt === 'number' ? startAt : Date.parse(startAt); if (!Number.isFinite(startAt) || startAt < 0) fail('A data de início é inválida.'); } else startAt = null;
  const ids = (value, label) => { if (value == null) return []; if (!Array.isArray(value) || value.some(x => typeof x !== 'string' || !x || x.length > 200)) fail(`${label}: seleção inválida.`); return [...new Set(value)]; };
  const result = { ...merged, name: cleanText(merged.name, 'Nome da campanha', { required: true, max: 120 }).trim(),
    groupIds: ids(merged.groupIds, 'Grupos'), contactIds: ids(merged.contactIds, 'Contatos'), mode, message,
    communityLink: validateCommunityLink(merged.communityLink), fallbackName: cleanText(merged.fallbackName ?? 'Olá', 'Nome alternativo', { max: 100 }),
    intervalUnit, intervalValue, intervalMs, dailyLimit: integer(merged.dailyLimit, 'Limite diário', 1, 100000, 100), executionLimit: integer(merged.executionLimit, 'Limite por execução', 1, 100000, 100),
    schedule, startAt,
    revision: integer(existing.revision, 'Revisão', 0, Number.MAX_SAFE_INTEGER - 1, 0) + 1 };
  if (!result.groupIds.length && !result.contactIds.length) fail('Selecione pelo menos um grupo de origem ou um contato.');
  return result;
}
function renderMessage(campaign, contact = {}) {
  const name = (typeof contact.name === 'string' && contact.name.trim()) || (typeof contact.displayName === 'string' && contact.displayName.trim()) || campaign.fallbackName || 'Olá';
  const text = String(campaign.message || '').replace(/\{nome\}|\{link_comunidade\}/g, key => key === '{nome}' ? name : campaign.communityLink);
  if (text.length > 4096) fail('A mensagem renderizada ultrapassa 4.096 caracteres. Reduza o modelo ou o nome alternativo.', 'MESSAGE_TOO_LONG');
  return text;
}
function validateSettings(input = {}) {
  const result = { ...input };
  if (input.integrationMode !== undefined && !['whatsapp', 'simulated'].includes(input.integrationMode)) fail('Modo de integração inválido.');
  if (input.defaultIntervalUnit !== undefined && !['seconds', 'minutes'].includes(input.defaultIntervalUnit)) fail('Unidade do intervalo inválida.');
  if (input.defaultIntervalValue !== undefined) result.defaultIntervalValue = integer(input.defaultIntervalValue, 'Intervalo padrão', 1, 86400, 30);
  if (input.defaultDailyLimit !== undefined) result.defaultDailyLimit = integer(input.defaultDailyLimit, 'Limite diário padrão', 1, 100000, 100);
  if (input.attemptTimeoutMs !== undefined) result.attemptTimeoutMs = integer(input.attemptTimeoutMs, 'Tempo limite de tentativa', 1000, 300000, 30000);
  if (input.maxAttempts !== undefined) result.maxAttempts = integer(input.maxAttempts, 'Máximo de tentativas', 1, 10, 3);
  if (input.retryBaseMs !== undefined) result.retryBaseMs = integer(input.retryBaseMs, 'Intervalo inicial de tentativa', 1000, 3600000, 10000);
  for (const key of ['minimizeToTray', 'launchAtLogin', 'unofficialAcknowledged']) if (input[key] !== undefined && typeof input[key] !== 'boolean') fail(`Configuração ${key} inválida.`);
  const n = result.defaultIntervalValue ?? 30; const unit = result.defaultIntervalUnit ?? 'seconds';
  if (n * (unit === 'minutes' ? 60000 : 1000) < MINIMUM_SPACING_MS) fail('O intervalo padrão mínimo é de 3 segundos.');
  return result;
}
function localDay(at) { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function isAllowedAt(campaign, at) {
  if (campaign.startAt && at < campaign.startAt) return false;
  const d = new Date(at), schedule = campaign.schedule || {}, days = schedule.days || [0,1,2,3,4,5,6];
  const m = d.getHours() * 60 + d.getMinutes(), parse = s => Number(s.split(':')[0]) * 60 + Number(s.split(':')[1]);
  const start = parse(schedule.startTime || '00:00'), end = parse(schedule.endTime || '23:59');
  if (start < end) return days.includes(d.getDay()) && m >= start && m < end;
  return (m >= start && days.includes(d.getDay())) || (m < end && days.includes((d.getDay() + 6) % 7));
}
function nextAllowedAt(campaign, at) {
  at = Math.max(at, campaign.startAt || 0);
  if (isAllowedAt(campaign, at)) return at;
  const [h,m] = (campaign.schedule?.startTime || '00:00').split(':').map(Number);
  for (let i = 0; i <= 8; i++) { const d = new Date(at); d.setDate(d.getDate() + i); d.setHours(h,m,0,0); if (d.getTime() >= at && (campaign.schedule?.days || [0,1,2,3,4,5,6]).includes(d.getDay())) return d.getTime(); }
  return at + 86400000;
}
module.exports = { MINIMUM_SPACING_MS, ValidationError, validateCampaign, validateTemplate, validateSettings, renderMessage, normalizePhone, validateCommunityLink, localDay, isAllowedAt, nextAllowedAt };
