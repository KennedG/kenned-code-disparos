'use strict';

// Pure presentation helpers shared by the desktop renderer and its tests.
// The clock reads the operating system; it never contacts the backend or starts
// campaigns. Message dates and source-day attribution stay in their own modules.
(() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const date = value => { const result = value == null ? null : new Date(value); return result && Number.isFinite(result.getTime()) ? result : null; };
  const format = value => date(value)?.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) || '—';
  function clock(now = new Date(), timezone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
    const value = date(now) || new Date();
    const offset = -value.getTimezoneOffset(), sign = offset >= 0 ? '+' : '−';
    return { now: value.getTime(), timezone: timezone || 'Fuso local do computador', offsetMinutes: offset, date: value.toLocaleDateString('pt-BR'), time: value.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }), offset: `UTC${sign}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}` };
  }
  function renderClock(now) {
    const value = clock(now);
    return `<section class="computer-clock" aria-label="Horário oficial do computador"><div><span class="eyebrow">HORÁRIO DO COMPUTADOR</span><strong data-computer-clock="time">${escape(value.time)}</strong><span data-computer-clock="date">${escape(value.date)}</span></div><div><span data-computer-clock="timezone">${escape(value.timezone)} · ${escape(value.offset)}</span><small>As rodadas seguem este relógio e o fuso do sistema. Nenhum horário perdido é acumulado.</small></div></section>`;
  }
  function updateClock(root, now) {
    const value = clock(now);
    for (const node of root.querySelectorAll('[data-computer-clock]')) {
      const text = node.dataset.computerClock === 'timezone' ? `${value.timezone} · ${value.offset}` : value[node.dataset.computerClock];
      if (node.textContent !== text) node.textContent = text;
    }
    return value;
  }
  function timing(campaign) {
    const c = campaign || {}, recovery = c.executionRecovery || {};
    const last = c.lastRoundScheduledAt || c.lastRoundAt || c.lastRoundStartedAt || null;
    let status = recovery.status || '';
    if (!status && c.executionPendingRoundId) status = 'Rodada interrompida — itens pendentes aguardam próximo horário';
    if (!status && c.state === 'active') status = c.nextRunAt ? 'Aguardando próximo horário de rodada' : 'Verificando a próxima execução permitida';
    if (!status && c.state === 'paused') status = c.pauseReason === 'connection' ? 'Pausada por conexão — aguardando recuperação' : 'Pausada — requer retomada autorizada';
    if (!status && c.state === 'draft') status = 'Rascunho — nenhum envio autorizado';
    if (!status && c.state === 'stopped') status = 'Encerrada — nenhum envio agendado';
    return { last, next: c.nextRunAt || null, status, authorizedAt: c.executionAuthorization?.at || null, authorizedDate: c.executionAuthorization?.dateKey || '', authorizedTimezone: c.executionAuthorization?.timezone || '' };
  }
  function renderTiming(campaign) {
    const value = timing(campaign);
    return `<div class="campaign-timing"><span><small>Última rodada prevista</small><strong>${escape(format(value.last))}</strong></span><span><small>Próxima rodada</small><strong>${escape(format(value.next))}</strong></span></div><span class="table-subtitle recovery-status">${escape(value.status)}</span>${campaign?.roundAnchorAt ? `<span class="table-subtitle">Intervalo contado desde: ${escape(format(campaign.roundAnchorAt))}</span>` : ''}${value.authorizedAt ? `<span class="table-subtitle">Iniciada: ${escape(format(value.authorizedAt))} · ${escape(value.authorizedTimezone || 'fuso do computador')}</span>` : ''}`;
  }
  function activeIncidents(snapshot) {
    const d = snapshot || {}, mode = d.storageMode || d.settings?.integrationMode || d.connection?.mode;
    const values = d.recoveryState?.incidents || d.recovery?.incidents || d.notifications || [];
    const unique = new Map();
    for (const value of Array.isArray(values) ? values : []) {
      if (!value || value.resolvedAt || value.recoveredAt || value.active === false || value.dismissed || value.integrationMode && mode && value.integrationMode !== mode) continue;
      if (value.active !== true && value.blocking !== true) continue;
      const id = value.occurrenceId || value.id;
      if (id && !unique.has(id)) unique.set(id, value);
    }
    return [...unique.values()].sort((a, b) => (a.at || a.occurredAt || a.createdAt || 0) - (b.at || b.occurredAt || b.createdAt || 0));
  }
  function incidentView(value, snapshot) {
    const campaignName = value.campaignName || snapshot?.campaigns?.find(c => c.id === value.campaignId)?.name;
    const affected = (value.affectedCampaigns || []).map(c => typeof c === 'string' ? c : c.name || c.campaignName).filter(Boolean);
    const disconnected = snapshot?.connection?.state !== 'connected';
    return { id: value.occurrenceId || value.id, title: value.title || 'Erro impedindo o envio da campanha', campaigns: campaignName || affected.join(' · ') || 'Conexão e campanhas afetadas', at: value.at || value.occurredAt || value.createdAt, reason: value.reason || value.error || value.message || value.body || 'Consulte os detalhes do incidente.', action: value.action || value.guidance || (disconnected ? 'Verifique a internet e a sessão. A campanha aguardará o próximo horário após a recuperação.' : 'Revise o destino e os detalhes antes de retomar a campanha.'), pending: Number.isFinite(Number(value.pending ?? value.pendingCount)) ? Number(value.pending ?? value.pendingCount) : null, muted: value.muted === true || Boolean(value.silencedAt), code: value.code || value.errorCode || '', traceId: value.traceId || value.occurrenceId || value.id, disconnected };
  }
  const api = { clock, renderClock, updateClock, timing, renderTiming, activeIncidents, incidentView, format };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.KennedRecoveryUI = api;
})();
