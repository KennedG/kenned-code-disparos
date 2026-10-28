'use strict';

window.KennedSourceCampaignsUI = {
  create(ctx) {
    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
    const e = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    const clone = value => JSON.parse(JSON.stringify(value));
    const state = { epoch: 0, loaded: null, dirty: false, submitting: false, publications: null, offset: 0, campaignId: '', review: null, monitorId: '', order: null, selected: new Set(), grouping: null, loadError: null, snapshotKey: null, resuming: false };
    const can = permission => ctx.can(permission);
    const canConfigure = () => can('settings.edit') && can('groups.view') && can('campaign.create') && can('media.create');
    const currentMode = () => ctx.data()?.storageMode || ctx.data()?.settings?.integrationMode || 'simulated';
    const source = () => ctx.data()?.sources || state.loaded || {};
    const config = () => source().config || {};
    const campaigns = () => ctx.data()?.campaigns || [];
    const campaign = id => campaigns().find(item => item.id === id);
    const modeGroups = () => ctx.groups().filter(item => Boolean(item.simulation) === (currentMode() === 'simulated'));
    const groupName = id => modeGroups().find(item => item.id === id)?.name || id || 'Nenhum grupo selecionado';
    const time = value => value ? new Date(value).toLocaleString('pt-BR', { timeZone: config().timezone || 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
    const toLocalInput = value => {
      if (!value) return '';
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return '';
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(part => [part.type, part.value]));
      return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
    };
    // Source automation uses Brasilia. This date is explicit, never the host's
    // timezone; source history is sent as an ISO instant to the backend.
    const fromLocalInput = value => value ? new Date(`${value}:00-03:00`).getTime() : null;
    const button = (action, label, style = '', id = '', attrs = '') => `<button type="button" class="button ${e(style)}" data-action="source-${e(action)}"${id ? ` data-id="${e(id)}"` : ''} ${attrs}>${e(label)}</button>`;
    const field = (label, name, value, type = 'text', attrs = '', hint = '') => `<div class="field"><label for="source-${e(name)}">${e(label)}</label><input id="source-${e(name)}" name="${e(name)}" type="${e(type)}" value="${e(value)}" ${attrs}>${hint ? `<span class="field-hint">${e(hint)}</span>` : ''}</div>`;
    const panel = (title, body, action = '') => `<section class="panel"><div class="panel-header"><h2>${e(title)}</h2>${action}</div><div class="panel-body">${body}</div></section>`;
    const statusNames = { ready: 'Pronto', pending: 'Pendente', queued: 'Aguardando', pending_media: 'Mídia pendente', downloading: 'Baixando mídia', media_error: 'Falha na mídia', review: 'Revisão necessária', failed: 'Falha confirmada', deleted: 'Publicação excluída', removed: 'Removido', sending: 'Enviando', accepted: 'Envio aceito pela integração', confirmed: 'Envio aceito pela integração', delivered: 'Entrega confirmada', read: 'Leitura confirmada', uncertain: 'Resultado incerto', cancelled: 'Cancelado', available: 'Apto', eligible: 'Apto', blocked: 'Indisponível', unavailable: 'Indisponível', suspended: 'Suspenso', unknown: 'Ainda não verificado' };
    const badge = status => `<span class="badge ${e(status)}">${e(statusNames[status] || status || 'Pendente')}</span>`;
    const safeCall = async (action, payload) => {
      const epoch = state.epoch, actor = ctx.auth()?.user?.id, mode = currentMode();
      const result = await ctx.call(action, payload);
      if (epoch !== state.epoch || actor !== ctx.auth()?.user?.id || mode !== currentMode()) throw new Error('O usuário ou a integração mudou. Atualize a tela antes de continuar.');
      return result;
    };
    const publications = () => state.publications?.items || source().publications || [];
    const publication = id => publications().find(item => item.id === id);
    const publicationText = item => item.caption ?? item.text ?? item.item?.caption ?? item.item?.text ?? '';
    const publicationStatus = item => item.status || item.state || 'pending';
    const hasPublicationCampaign = item => !item.campaignId || Boolean(campaign(item.campaignId));
    const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: config().timezone || 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const eligibleCampaigns = () => campaigns().filter(item => item.state !== 'active' && (!item.sourceManaged || item.sourceGroupId === config().groupId && item.sourceDateKey === today()));
    function clearDeletedReferences() {
      if (state.campaignId && !campaign(state.campaignId)) { state.campaignId = ''; state.offset = 0; state.selected.clear(); }
      if (state.monitorId && !campaign(state.monitorId)) {
        state.monitorId = '';
        if (ctx.modalKind() === 'source-monitor') ctx.closeModal();
      }
      if (state.order && !campaign(state.order.campaignId)) { state.order = null; if (ctx.modalKind() === 'source-order') ctx.closeModal(); }
      if (state.review?.campaignId && !campaign(state.review.campaignId)) { state.review = null; if (ctx.modalKind() === 'source-review') ctx.closeModal(); }
    }
    const itemMedia = item => (ctx.data()?.media || []).find(media => media.id === (item.mediaId || item.item?.mediaId));
    const mediaPreview = item => {
      const media = itemMedia(item);
      return media?.previewUrl && media.type === 'image' ? `<img class="source-publication-image" src="${e(media.previewUrl)}" alt="${e(media.name || 'Foto capturada')}" loading="lazy">` : `<div class="source-publication-image source-media-placeholder">${ctx.icon(item.type || item.item?.type || 'image')}<small>${e(media?.name || (['downloading', 'pending', 'pending_media'].includes(publicationStatus(item)) ? 'Mídia ainda não disponível' : 'Prévia indisponível'))}</small></div>`;
    };
    function renderConfig() {
      const c = config(), template = c.configTemplate || {}, schedule = template.schedule || {}, groups = modeGroups();
      const missingOrigin = c.groupId && !groups.some(item => item.id === c.groupId);
      const disabled = canConfigure() ? '' : 'disabled';
      const options = `<option value="">Selecione um grupo existente</option>${missingOrigin ? `<option value="${e(c.groupId)}" selected>${e(c.groupId)} — sincronização necessária</option>` : ''}${groups.map(item => `<option value="${e(item.id)}"${item.id === c.groupId ? ' selected' : ''}>${e(item.name)}${item.simulation ? ' · SIMULADO' : ''}</option>`).join('')}`;
      return panel('Grupo de origem e participantes', `<form id="source-config-form"><fieldset class="source-fieldset" ${disabled}><label class="check-label"><input name="enabled" type="checkbox"${c.enabled ? ' checked' : ''}> Capturar novas publicações para a lista diária</label><p class="field-hint">Ativar não inicia disparos. A primeira publicação válida cria um rascunho; destinos e início precisam ser revisados e confirmados.</p><div class="field settings-spaced"><label for="source-groupId">Grupo de origem</label><select id="source-groupId" name="groupId">${options}</select><span class="field-hint">A configuração usa o ID real, preservado quando o grupo muda de nome.</span><small id="source-origin-id" class="trace-id">${e(c.groupId || 'Nenhum grupo escolhido')}</small></div>${groups.length ? '' : '<div class="info-note">Não há grupos carregados nesta integração. Conecte e sincronize seus grupos; nenhum grupo de demonstração é preenchido no modo real.</div>'}<div class="row-actions">${can('groups.view') ? button('sync-groups', 'Sincronizar grupos', 'small') : ''}</div><div class="field settings-spaced"><label for="source-allowedParticipantIds">Participantes autorizados</label><textarea id="source-allowedParticipantIds" name="allowedParticipantIds" rows="4" placeholder="5511999999999">${e((c.allowedParticipantIds || []).join('\n'))}</textarea><span class="field-hint">Um telefone com país e DDD ou identificador confiável por linha. Nomes de exibição não concedem autorização. LIDs exigem vínculo confirmado pela integração.</span></div><label class="check-label"><input name="allowOwnMessages" type="checkbox"${c.allowOwnMessages ? ' checked' : ''}> Aceitar minhas publicações manuais pelo número conectado</label><p class="field-hint">Mensagens automáticas do aplicativo são ignoradas. Comandos presentes nas legendas são somente conteúdo e não são executados.</p><div class="subtle-divider"></div><h3>Modelo de configurações da lista</h3><p class="soft-text">Este modelo é aplicado aos novos rascunhos. Ele nunca ativa uma campanha. Você pode aplicar novamente em uma campanha após revisar.</p><div class="field-grid">${field('Entre mensagens no mesmo grupo (segundos)', 'messageSpacingSeconds', template.messageSpacingSeconds ?? 3, 'number', 'min="3" max="3600" required', 'Pausa entre dois itens para o mesmo destino. Respeita o mínimo da integração.')}${field('Entre grupos (segundos)', 'spacingSeconds', template.spacingSeconds ?? 5, 'number', 'min="3" max="3600" required', 'Pausa na mudança de um grupo de destino para outro.')}${field('Entre o início das rodadas (minutos)', 'intervalMinutes', template.intervalMinutes ?? 10, 'number', 'min="1" max="10080" required', 'Não cria rodadas simultâneas nem acumula rodadas atrasadas.')}${field('Tempo limite de uma tentativa (segundos)', 'sendTimeoutSeconds', template.sendTimeoutSeconds ?? 60, 'number', 'min="5" max="300" required', 'Após o limite, o resultado fica incerto e os demais destinos elegíveis podem continuar.')}${field('Máximo de rodadas na campanha', 'maxRounds', template.maxRounds ?? 0, 'number', 'min="0" max="10000" required', '0 = sem limite adicional de rodadas.')}${field('Encerrar até (data e hora de Brasília)', 'endAt', toLocalInput(template.endAt), 'datetime-local', '', 'Opcional. Não altera o conteúdo das publicações.')}</div><fieldset class="permission-section"><legend>Dias permitidos</legend><div class="weekdays">${['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((day, index) => `<label class="day-chip"><input name="days" type="checkbox" value="${index}"${(schedule.days || [0, 1, 2, 3, 4, 5, 6]).includes(index) ? ' checked' : ''}><span>${day}</span></label>`).join('')}</div></fieldset><div class="field-grid">${field('Início do horário', 'startTime', schedule.startTime || '08:00', 'time', 'required')}${field('Fim do horário', 'endTime', schedule.endTime || '18:00', 'time', 'required')}</div><fieldset class="permission-section"><legend>Destinos sugeridos para novos rascunhos</legend><p class="field-hint">O grupo de origem fica excluído por padrão. Selecione somente destinos com autorização para publicar.</p><div class="source-destination-list">${groups.filter(item => item.authorized && item.id !== c.groupId).map(item => `<label class="check-label" data-source-destination-row="${e(item.id)}"><input name="groupIds" type="checkbox" value="${e(item.id)}"${(template.groupIds || []).includes(item.id) ? ' checked' : ''}>${e(item.name)}<small class="trace-id">${e(item.id)}</small></label>`).join('') || '<p class="soft-text">Nenhum destino autorizado disponível.</p>'}</div></fieldset><div class="info-note">Fuso: America/Sao_Paulo. Uma rodada termina quando todos os itens previstos foram processados para seus destinos, incluindo falhas e resultados incertos registrados.</div></fieldset><div class="settings-savebar">${canConfigure() ? '<button class="button primary" type="submit">Salvar origem e modelo</button>' : '<span class="soft-text">Seu perfil pode consultar; a configuração exige permissão para configurações, criação de campanhas e mídias.</span>'}</div></form>`);
    }
    function renderPublications() {
      const rows = publications(), result = state.publications || {}, total = Number(result.total ?? rows.length);
      return panel('Publicações capturadas', `<div class="source-publications-toolbar"><label class="compact-field">Campanha <select id="source-campaign-filter"><option value="">Todas as listas de origem</option>${campaigns().filter(item => item.sourceGroupId || item.source?.groupId || item.originGroupId).map(item => `<option value="${e(item.id)}"${state.campaignId === item.id ? ' selected' : ''}>${e(item.name)}</option>`).join('')}</select></label>${button('refresh', 'Atualizar', 'small ghost')}${can('campaign.edit') ? button('group', 'Agrupar fotos selecionadas', 'small', '', state.selected.size < 2 ? 'disabled' : '') : ''}<span id="source-selected-count" class="count-label">${state.selected.size} selecionada(s)</span></div>${rows.length ? `<div class="source-publications">${rows.map(item => `<article class="source-publication" data-publication-id="${e(item.id)}">${mediaPreview(item)}<div class="source-publication-body"><div class="source-publication-heading">${can('campaign.edit') && hasPublicationCampaign(item) && item.type === 'image' && !['removed','deleted'].includes(publicationStatus(item)) ? `<label class="check-label source-publication-select"><input type="checkbox" data-source-select="${e(item.id)}"${state.selected.has(item.id)?' checked':''}> Selecionar foto</label>` : ''}${badge(publicationStatus(item))}<small>${e(time(item.originalAt || item.messageAt || item.timestamp || item.createdAt))}</small></div><pre class="source-caption">${e(publicationText(item))}</pre><small class="trace-id">Mensagem: ${e(item.messageId || item.originalMessageId || item.id)}${item.manualGroupId || item.groupKey ? ` · Agrupamento: ${e(item.manualGroupId || item.groupKey)}` : ''}</small><small class="table-subtitle">${e(groupName(item.groupId || item.sourceGroupId || config().groupId))} · ${e(item.senderName || item.senderId || item.participantId || 'Remetente não identificado')}</small>${item.error || item.reason ? `<p class="source-publication-error">${e(item.error || item.reason)}${item.code ? ` · ${e(item.code)}` : ''}</p>` : ''}<div class="row-actions">${item.campaignId && campaign(item.campaignId) ? button('monitor', 'Abrir campanha', 'small ghost', item.campaignId) : ''}${can('campaign.edit') && hasPublicationCampaign(item) && !['deleted', 'removed'].includes(publicationStatus(item)) ? button('review', 'Revisar texto e legenda', 'small', item.id) : ''}${can('campaign.edit') && hasPublicationCampaign(item) && ['pending', 'pending_media', 'media_error', 'failed'].includes(publicationStatus(item)) ? button('retry-media', 'Tentar baixar mídia', 'small', item.id) : ''}${can('campaign.edit') && hasPublicationCampaign(item) && !['deleted', 'removed'].includes(publicationStatus(item)) ? button('remove', 'Retirar dos próximos envios', 'small danger', item.id) : ''}</div></div></article>`).join('')}</div>` : '<div class="empty-state"><h3>Nenhuma publicação capturada</h3><p>Ative a origem e publique uma foto com a legenda na mesma mensagem, por um participante autorizado.</p></div>'}<div class="pagination"><span>${total} publicação(ões) · ${rows.length ? `${state.offset + 1}–${state.offset + rows.length}` : '0'}</span><div class="row-actions">${state.offset ? button('previous', 'Anterior', 'small') : ''}${state.offset + rows.length < total ? button('next', 'Próxima', 'small') : ''}</div></div>`);
    }
    function render() {
      clearDeletedReferences();
      const c = config(), metrics = source().metrics || {}, lists = campaigns().filter(item => item.sourceGroupId || item.source?.groupId || item.originGroupId);
      const captureLink=c.captureLink||metrics.captureLink||{}, capturePaused=c.capturePaused===true||metrics.capturePaused===true||captureLink.status==='paused';
      const pausedNotice=capturePaused?`<div class="warning-note source-capture-paused" role="status"><strong>Pausada — campanha excluída ou vínculo interrompido</strong><p>${e(c.pausedReason||metrics.pausedReason||captureLink.reason||'A campanha vinculada foi excluída. Nenhuma lista será recriada automaticamente.')}</p><p>O grupo continua configurado. Salvar, reconectar ou mudar o dia não retoma a importação. Ao retomar, somente publicações novas serão capturadas; mensagens anteriores ou recebidas na pausa exigem a escolha explícita de um período.</p><div class="row-actions">${canConfigure()?button('resume-new','Criar nova campanha e retomar','primary')+(can('campaign.edit')?button('resume-link','Vincular a uma campanha existente e retomar'):'' ):''}${button('keep-paused','Manter importação pausada','ghost')}</div></div>`:'';
      return `<div id="source-page"><div class="page-heading"><div><div class="eyebrow">Publicações da sua loja</div><h1>Origem da loja</h1><p class="subtitle">Foto e legenda preservadas em uma lista diária. O primeiro disparo depende da sua confirmação.</p></div>${canConfigure() ? button('import-history', 'Importar período anterior', '', '', metrics.historySupported === false ? 'disabled title="A integração não disponibiliza importação desse histórico"' : '') : ''}</div>${pausedNotice}<div class="source-capture-status"><div><strong>${capturePaused?'Captura pausada':c.enabled ? 'Captura ativada' : 'Captura desativada'} · ${e(groupName(c.groupId))}</strong><small>Início: ${e(time(c.enabledAt || c.activatedAt || metrics.startedAt))} · Última captura: ${e(time(metrics.lastCaptureAt || metrics.lastCapturedAt || metrics.lastMessageAt))}</small><small>${ctx.data()?.automation?.stopped ? 'Parada geral ativa: novas capturas automáticas ficam bloqueadas até retomar o sistema.' : ctx.data()?.license?.allowed === false ? 'Licença bloqueada: novas capturas automáticas aguardam regularização.' : ctx.data()?.connection?.state === 'connected' ? 'Novas publicações são recebidas enquanto a conexão estiver ativa.' : 'WhatsApp desconectado: este período pode ter lacunas de captura.'}</small></div>${badge(c.enabled ? 'active' : 'paused')}</div>${metrics.lastError ? `<div class="warning-note">${e(metrics.lastError.message || metrics.lastError)}${metrics.lastError.code ? ` · ${e(metrics.lastError.code)}` : ''}</div>` : ''}<div class="stats-grid source-stats">${[['Listas diárias', metrics.campaigns ?? lists.length], ['Itens prontos', metrics.ready ?? metrics.readyItems ?? 0], ['Mídias pendentes', metrics.pending ?? metrics.pendingItems ?? 0], ['Para revisar', metrics.review ?? metrics.reviewItems ?? 0]].map(([label, value]) => `<div class="stat-card"><div class="stat-top">${e(label)}</div><div class="stat-value">${e(value)}</div></div>`).join('')}</div>${state.loadError?`<div class="warning-note">Não foi possível atualizar as publicações: ${e(state.loadError)}. Clique em Atualizar. A listagem anterior pode estar desatualizada.</div>`:""}${renderConfig()}<div class="info-note">Foto sem legenda e texto separado exigem revisão. Não associamos mensagens por proximidade de horário. A integração não oficial pode enviar fotos de um álbum como mensagens separadas; revise e organize os itens na campanha. Importação histórica e eventos de edição/exclusão dependem do que o WhatsApp disponibiliza e não garantem um histórico completo.</div>${renderPublications()}</div>`;
    }
    async function load() {
      if (!can('campaign.view')) return;
      clearDeletedReferences();
      const epoch = state.epoch;
      try {
        state.loaded = await safeCall('sourceConfigGet');
        if (state.loaded && !state.loaded.config) state.loaded = { config: state.loaded, metrics: source().metrics || {} };
        clearDeletedReferences();
        const requestedCampaign = state.campaignId;
        try {
          state.publications = await safeCall('sourcePublications', { campaignId: requestedCampaign || undefined, offset: state.offset, limit: 30 });
        } catch (error) {
          // A deletion can race the page request. Drop that ID permanently and
          // fetch the unfiltered page once; never retry the removed campaign.
          if (!requestedCampaign || state.epoch !== epoch || (campaign(requestedCampaign) && !/campanha.*n[aã]o encontrada/i.test(error.message || '') && !['CAMPAIGN_NOT_FOUND', 'SOURCE_CAMPAIGN_NOT_FOUND'].includes(error.code))) throw error;
          state.campaignId = ''; state.offset = 0; state.selected.clear();
          state.publications = await safeCall('sourcePublications', { offset: 0, limit: 30 });
        }
        if (Array.isArray(state.publications)) state.publications = { items: state.publications, total: state.publications.length };
        state.loadError = null;
        state.snapshotKey = captureSnapshotKey();
      } catch (error) { if (epoch === state.epoch) state.loadError = error.message; throw error; }
    }
    function captureSnapshotKey() {
      const snapshot = ctx.data()?.sources || {}, metrics = snapshot.metrics || {}, c = snapshot.config || {};
      return JSON.stringify([currentMode(), c.groupId, c.enabled, c.enabledAt, c.capturePaused, c.captureLink?.status, c.captureLink?.generation, c.captureLink?.campaignId, c.pausedReason, metrics.total, metrics.ready, metrics.pending, metrics.failed, metrics.review, metrics.lastCaptureAt, campaigns().map(item => [item.id, item.sourceRevision, item.state])]);
    }
    async function maybeLoad() { clearDeletedReferences(); if (!state.dirty && state.snapshotKey !== captureSnapshotKey()) await load(); }
    async function saveConfig(form) {
      if (!canConfigure()) throw new Error('Seu perfil não permite configurar a origem.');
      if (!form.reportValidity()) return;
      const get = name => form.elements.namedItem(name)?.value;
      const c = clone(config()), groupId = get('groupId');
      const ids = get('allowedParticipantIds').split(/[\n,;]/).map(value => value.trim()).filter(Boolean);
      if (form.elements.enabled.checked && !groupId) throw new Error('Selecione o grupo de origem antes de ativar a captura.');
      if (ids.some(id => !/^\+?\d{10,15}$/.test(id) && !/^\d+(?::\d+)?@(?:s\.whatsapp\.net|lid)$/.test(id))) throw new Error('Informe participantes por telefone com país e DDD ou identificador confiável fornecido pela integração.');
      const days = $$('[name="days"]:checked', form).map(item => Number(item.value));
      if (!days.length) throw new Error('Escolha pelo menos um dia permitido.');
      const configToSave = { ...c, enabled: form.elements.enabled.checked, groupId, allowedParticipantIds: [...new Set(ids.map(id => id.replace(/^\+/, '')))], allowOwnMessages: form.elements.allowOwnMessages.checked, timezone: 'America/Sao_Paulo', configTemplate: { ...(c.configTemplate || {}), groupIds: $$('[name="groupIds"]:checked', form).map(item => item.value).filter(id => id !== groupId), intervalMinutes: Number(get('intervalMinutes')), messageSpacingSeconds: Number(get('messageSpacingSeconds')), spacingSeconds: Number(get('spacingSeconds')), sendTimeoutSeconds: Number(get('sendTimeoutSeconds')), maxRounds: Number(get('maxRounds')), endAt: fromLocalInput(get('endAt')), schedule: { ...(c.configTemplate?.schedule || {}), days, startTime: get('startTime'), endTime: get('endTime') } } };
      if (configToSave.enabled && !c.enabled && !confirm('Ativar a captura a partir de agora? As novas publicações válidas criarão rascunhos, sem iniciar envios. Mensagens anteriores exigem importação explícita.')) return;
      const saved = await safeCall('sourceConfigSave', { config: configToSave });
      const savedConfig = saved?.config || saved;
      if (!savedConfig || savedConfig.groupId !== configToSave.groupId || savedConfig.enabled !== configToSave.enabled) throw new Error('O aplicativo não confirmou o salvamento da origem. Atualize a tela e consulte o diagnóstico.');
      state.dirty = false;
      await ctx.refresh(); await load();
      if (state.loaded?.config?.groupId !== configToSave.groupId || state.loaded?.config?.enabled !== configToSave.enabled) throw new Error('A origem não foi recuperada após salvar. Consulte o diagnóstico antes de ativar.');
      ctx.render(true); ctx.toast('Origem e modelo salvos. Nenhum disparo foi iniciado.');
    }
    function review(id) {
      if (!can('campaign.edit')) throw new Error('Sem permissão para editar campanhas.');
      const item = publication(id);
      if (!item) throw new Error('Atualize as publicações antes de revisar esse item.');
      if (!hasPublicationCampaign(item)) throw new Error('Esta publicação pertence a uma campanha excluída. Crie ou vincule outra campanha para retomar a importação.');
      state.review = clone(item);
      ctx.showModal('source-review', 'Revisar publicação', 'As alterações valem para o rascunho e próximas rodadas. O histórico de envios permanece preservado.', `<form id="source-review-form" data-id="${e(id)}">${mediaPreview(item)}<div class="field"><label for="source-review-caption">Texto ou legenda completa</label><textarea id="source-review-caption" name="caption" rows="12" maxlength="16000">${e(publicationText(item))}</textarea><span class="field-hint">Preserve preço, observações e assinatura. Legendas acima do limite real do WhatsApp podem ser recusadas; o aplicativo não as corta silenciosamente.</span></div><p class="trace-id">${e(item.messageId || item.id)}</p></form>`, button('save-review', 'Salvar revisão', 'primary', id));
    }
    function operations(id) { return ctx.data()?.campaignOps?.[id] || {}; }
    function renderMonitor(id) {
      const c = campaign(id);
      if (!c) return '<div class="info-note">Esta campanha foi excluída. O acompanhamento foi encerrado. Se ela recebia publicações de um grupo, a importação permanece pausada até você criar ou vincular outra campanha.</div>';
      const op = operations(id), counts = op.counts || {}, destinations = op.destinations || (c.groupIds || []).map(groupId => ({ groupId, groupName: groupName(groupId), state: 'unknown' }));
      const uncertain = op.uncertainJobs || [], activeRound = op.roundNumber || op.currentRound?.number || c.roundCounter || c.roundNumber || 0;
      const sourceId = c.sourceGroupId || c.source?.groupId || c.originGroupId;
      return `<div id="source-campaign-monitor" data-campaign-id="${e(id)}">${sourceId ? `<div class="info-note">Origem: <strong>${e(groupName(sourceId))}</strong><br><span class="trace-id">${e(sourceId)}</span><br>Publicações novas e edições durante uma rodada entram na próxima rodada. A lista da rodada atual permanece definida.</div>` : ''}<div class="preview-summary"><div><div class="preview-label">Rodada atual</div><div class="preview-value">${e(activeRound || 'Ainda não iniciada')}${op.roundStatus ? ` · ${e(op.roundStatus)}` : ''}</div></div><div><div class="preview-label">Próxima execução</div><div class="preview-value">${e(time(op.nextRunAt || c.nextRunAt))}</div></div><div><div class="preview-label">Itens</div><div class="preview-value">${e(op.readyItems ?? (c.items || []).length)} prontos · ${e(op.pendingItems ?? 0)} pendentes</div></div><div><div class="preview-label">Destinos</div><div class="preview-value">${destinations.filter(item => ['available', 'eligible', 'ready', 'active'].includes(item.state)).length} aptos · ${destinations.filter(item => ['blocked', 'unavailable', 'suspended'].includes(item.state)).length} indisponíveis</div></div></div><div class="source-delivery-counts">${[['queued', 'Aguardando'], ['sending', 'Enviando'], ['accepted', 'Aceitos'], ['delivered', 'Entregues'], ['uncertain', 'Incertos'], ['failed', 'Falhas'], ['cancelled', 'Cancelados']].map(([key, label]) => `<div><strong>${Number(counts[key] ?? (key === 'accepted' ? counts.confirmed : 0) ?? 0)}</strong><small>${label}</small></div>`).join('')}</div><p class="field-hint">Aceito indica confirmação disponível da integração. Entregue exige confirmação posterior. Um resultado incerto pode ter sido enviado e não é repetido automaticamente.</p><div class="row-actions source-monitor-controls">${c.state === 'active' ? (can('campaign.pause') ? button('pause', 'Pausar campanha', '', id) : '') : (can('campaign.start') ? button('resume', c.state === 'draft' ? 'Revisar e iniciar' : 'Revisar e retomar', 'primary', id) : '')}${can('campaign.edit') ? button('reconcile', 'Verificar envios incertos', '', id) : ''}${can('campaign.edit') ? button('edit-campaign', 'Editar conteúdo e destinos', 'ghost', id) : ''}${sourceId && can('campaign.edit') ? button('apply-template', 'Aplicar modelo de configurações', 'ghost', id) + button('order', 'Organizar ordem dos itens', 'ghost', id) : ''}${sourceId ? button('filter-publications', 'Ver publicações desta lista', 'ghost', id) : ''}</div><h3>Disponibilidade por grupo</h3><div class="table-scroll"><table><thead><tr><th>GRUPO / ID</th><th>ESTADO</th><th>ÚLTIMO MOTIVO</th><th>AÇÃO</th></tr></thead><tbody>${destinations.map(item => `<tr><td><span class="table-name">${e(item.groupName || groupName(item.groupId))}</span><small class="trace-id">${e(item.groupId)}</small></td><td>${badge(item.state)}</td><td><span class="diagnostic-description">${e(item.reason || item.lastError || 'Nenhuma falha registrada')}</span><small class="table-subtitle">${e(item.code || '')}${item.lastErrorAt ? ` · ${e(time(item.lastErrorAt))}` : ''}</small>${item.counts ? `<small class="table-subtitle">${Number(item.counts.accepted ?? item.counts.confirmed ?? 0)} aceitos · ${Number(item.counts.delivered ?? 0)} entregues · ${Number(item.counts.uncertain ?? 0)} incertos · ${Number(item.counts.failed ?? 0)} falhas</small>` : ''}</td><td>${can('campaign.edit') ? button('recheck-destination', 'Verificar novamente', 'small', id, `data-group-id="${e(item.groupId)}"`) : ''}</td></tr>`).join('') || '<tr><td colspan="4">Nenhum destino configurado.</td></tr>'}</tbody></table></div>${uncertain.length ? `<h3>Resultados incertos para revisão</h3><div class="warning-note">A integração pode responder depois do tempo limite. Verifique primeiro; repetir manualmente pode gerar uma mensagem duplicada.</div><div class="review-list">${uncertain.map(job => `<div class="review-row"><div><strong>${e(job.groupName || groupName(job.groupId))}</strong><small>${e(job.error || 'Sem evidência suficiente para concluir o envio')}</small><small class="trace-id">Operação: ${e(job.id)}${job.messageId ? ` · Mensagem: ${e(job.messageId)}` : ''}</small></div>${can('campaign.edit') ? button('manual-retry', 'Reenviar com confirmação', 'small danger', job.id) : ''}</div>`).join('')}</div>` : ''}</div>`;
    }
    function openMonitor(id) {
      if (!campaign(id)) { clearDeletedReferences(); return; }
      state.monitorId = id;
      ctx.showModal('source-monitor', campaign(id)?.name || 'Acompanhamento da campanha', 'Destinos, rodada e evidências reais de cada envio.', renderMonitor(id), button('monitor-refresh', 'Atualizar', '', id) + button('close', 'Fechar', 'primary'));
    }
    function openOrder(id) {
      const c = campaign(id);
      state.order = { campaignId: id, items: clone(c?.items || []) };
      showOrder();
    }
    function showOrder() {
      if (!state.order) return;
      ctx.showModal('source-order', 'Ordem dos itens', 'Esta ordem vale para as próximas rodadas. Uma rodada em andamento conserva sua lista.', `<div class="source-order-list">${state.order.items.map((item, index) => `<div class="review-row"><div><strong>${index + 1}. ${e(item.caption || item.text || (ctx.data()?.media || []).find(media => media.id === item.mediaId)?.name || 'Conteúdo')}</strong><small class="trace-id">${e(item.id)}</small></div><div class="row-actions">${button('order-up', '↑', 'small', item.id, index === 0 ? 'disabled aria-label="Mover para cima"' : 'aria-label="Mover para cima"')}${button('order-down', '↓', 'small', item.id, index === state.order.items.length - 1 ? 'disabled aria-label="Mover para baixo"' : 'aria-label="Mover para baixo"')}</div></div>`).join('')}</div>`, button('save-order', 'Salvar ordem', 'primary', state.order.campaignId));
    }
    function showResumeLink() {
      if (!canConfigure() || !can('campaign.edit')) throw new Error('Sem permissão para vincular e retomar a origem.');
      if (state.dirty) throw new Error('Salve ou descarte as alterações da origem antes de retomar a importação.');
      const groupId = config().groupId;
      if (!groupId) throw new Error('Selecione o grupo de origem antes de retomar.');
      const eligible = eligibleCampaigns();
      ctx.showModal('source-resume-link', 'Vincular campanha e retomar', 'Escolha um rascunho ou campanha desativada. Seus conteúdos e configurações serão preservados; nenhum disparo será iniciado.', `<form id="source-resume-link-form" data-group-id="${e(groupId)}"><div class="field"><label for="source-resume-campaign">Campanha existente</label><select id="source-resume-campaign" name="campaignId" required><option value="">Selecione uma campanha</option>${eligible.map(item => `<option value="${e(item.id)}">${e(item.name)} — ${e(item.state === 'draft' ? 'Rascunho' : 'Desativada')}</option>`).join('')}</select><span class="field-hint">Campanhas ativas, vinculadas a outra origem ou listas de origem de dias anteriores não aparecem.</span></div>${eligible.length ? '' : '<div class="info-note">Nenhuma campanha elegível. Crie uma nova campanha para retomar ou desative uma campanha existente.</div>'}<div class="warning-note">A campanha ficará como rascunho. Somente publicações novas, recebidas a partir da confirmação, serão capturadas. Mensagens antigas ou recebidas durante a pausa exigem importação por período escolhido explicitamente.</div><p>Grupo: <strong>${e(groupName(groupId))}</strong><br><small class="trace-id">${e(groupId)}</small></p></form>`, button('save-resume-link', 'Vincular e retomar', 'primary', '', eligible.length ? '' : 'disabled') + button('close', 'Cancelar', 'ghost'));
    }
    async function resumeCapture(campaignId) {
      if (state.resuming) return;
      if (!canConfigure() || campaignId && !can('campaign.edit')) throw new Error('Sem permissão para retomar a captura deste grupo.');
      if (state.dirty) throw new Error('Salve ou descarte as alterações da origem antes de retomar a importação.');
      const groupId = config().groupId;
      if (!groupId) throw new Error('Selecione o grupo real de origem antes de retomar.');
      const selected = campaignId && eligibleCampaigns().find(item => item.id === campaignId);
      if (campaignId && !selected) throw new Error('A campanha não está mais disponível para vínculo. Atualize e escolha um rascunho ou campanha desativada compatível.');
      const message = selected ? `Vincular “${selected.name}” e retomar a importação? O conteúdo e as configurações existentes serão preservados e a campanha ficará como rascunho.` : 'Criar uma nova campanha e retomar a importação? A nova lista ficará como rascunho para revisão.';
      if (!confirm(`${message}\n\nSomente publicações novas, a partir desta retomada, poderão entrar. Mensagens anteriores ou recebidas durante a pausa não serão importadas. Nenhuma campanha ou envio antigo será reativado.`)) return;
      state.resuming = true;
      try {
        const result = await safeCall('sourceResumeGroup', { groupId, ...(campaignId ? { campaignId } : {}), confirm: true });
        if (result?.link?.status !== 'active' || !result?.campaign?.id || result.campaign.state !== 'draft' || result.link.campaignId !== result.campaign.id || !Number.isFinite(result.captureFrom)) throw new Error('O sistema não confirmou o vínculo e a retomada. Atualize a origem e consulte o diagnóstico antes de tentar novamente.');
        if (ctx.modalKind() === 'source-resume-link') ctx.closeModal();
        await ctx.refresh(); await load(); ctx.render(true);
        if (config().capturePaused === true || config().captureLink?.status !== 'active') throw new Error('A retomada não foi recuperada após salvar. Atualize a origem e consulte o diagnóstico.');
        ctx.toast(result?.message || 'Importação retomada. A campanha está em rascunho: revise os destinos e confirme o primeiro envio.');
      } finally { state.resuming = false; }
    }
    async function onAction(action, element) {
      action = action.slice(7); const id = element.dataset.id;
      clearDeletedReferences();
      if (action === 'resume-new' || action === 'resume-capture') { await resumeCapture(); return; }
      if (action === 'resume-link') { showResumeLink(); return; }
      if (action === 'save-resume-link') { await onSubmit($('#source-resume-link-form')); return; }
      if (action === 'keep-paused') { ctx.toast('A importação permanece pausada. O grupo e seus dados foram preservados; nenhuma campanha será recriada automaticamente.'); return; }
      if (action === 'close') { state.monitorId = ''; ctx.closeModal(); return; }
      if (action === 'monitor' || action === 'monitor-refresh') { openMonitor(id); return; }
      if (action === 'review') { review(id); return; }
      if (action === 'group') {
        if (!can('campaign.edit')) throw new Error('Sem permissão para editar campanhas.');
        const selected = publications().filter(item => state.selected.has(item.id) && hasPublicationCampaign(item) && item.type === 'image' && !['removed','deleted'].includes(publicationStatus(item)));
        if (selected.length < 2) throw new Error('Selecione pelo menos duas fotos desta página para agrupar.');
        state.grouping=selected.map(item=>item.id);
        ctx.showModal('source-group','Agrupar fotos manualmente','Escolha uma legenda explicitamente. As mensagens originais e suas referências permanecem preservadas.',`<form id="source-group-form"><div class="source-group-preview">${selected.map(mediaPreview).join('')}</div><div class="field"><label for="source-group-caption">Legenda revisada para estas fotos</label><textarea id="source-group-caption" name="caption" rows="10" maxlength="16000" placeholder="Cole a legenda correta e revise preços, observações e assinatura."></textarea><span class="field-hint">As fotos continuam como itens sequenciais, com um vínculo manual. A integração pode não preservar o álbum visualmente nos destinos.</span></div><p class="soft-text">${selected.length} fotos selecionadas. Não associamos outra mensagem automaticamente.</p></form>`,button('save-group','Salvar agrupamento','primary'));return;
      }
      if(action==='save-group'){await onSubmit($('#source-group-form'));return;}
      if (action === 'save-review') { await onSubmit($('#source-review-form')); return; }
      if (action === 'edit-campaign') { ctx.editCampaign(id); return; }
      if (action === 'pause') { await safeCall('pauseCampaign', { id }); await ctx.refresh(); openMonitor(id); return; }
      if (action === 'resume') { await ctx.previewCampaign(id, true, campaign(id)?.state === 'paused'); return; }
      if (action === 'order') { openOrder(id); return; }
      if (action === 'order-up' || action === 'order-down') {
        const index = state.order?.items.findIndex(item => item.id === id), target = index + (action === 'order-up' ? -1 : 1);
        if (index >= 0 && target >= 0 && target < state.order.items.length) [state.order.items[index], state.order.items[target]] = [state.order.items[target], state.order.items[index]];
        showOrder(); return;
      }
      if (action === 'save-order') { if (!can('campaign.edit')) throw new Error('Sem permissão para editar campanhas.'); await safeCall('sourceReorderItems', { campaignId: id, itemIds: state.order.items.map(item => item.id) }); await ctx.refresh(); state.order = null; openMonitor(id); ctx.toast('Ordem salva para as próximas rodadas.'); return; }
      if (action === 'reconcile') { const result = await safeCall('campaignReconcileUncertain', { campaignId: id }); await ctx.refresh(); openMonitor(id); ctx.toast(result?.message || 'Verificação solicitada. Somente evidências confiáveis alteram o resultado; os demais registros continuam incertos.'); return; }
      if (action === 'recheck-destination') { const result = await safeCall('destinationRecheck', { campaignId: id, groupId: element.dataset.groupId }); await ctx.refresh(); openMonitor(id); ctx.toast(result?.reason || result?.message || 'Verificação do destino concluída. Confira o estado no painel.', ['blocked', 'unavailable', 'suspended'].includes(result?.state)); return; }
      if (action === 'manual-retry') { if (!can('campaign.edit')) throw new Error('Sem permissão para editar campanhas.'); if (!confirm('AVISO: este envio está incerto e pode já ter chegado ao grupo. Use primeiro “Verificar envios incertos” e confira a conversa. Deseja criar uma nova tentativa manual, assumindo o risco de duplicação?')) return; const result = await safeCall('manualRetryJob', { id, confirmPossibleDuplicate: true }); await ctx.refresh(); if (state.monitorId) openMonitor(state.monitorId); ctx.toast(result?.message || 'Tentativa manual registrada. Entrar na fila não significa enviado.'); return; }
      if (action === 'apply-template') { if (!confirm('Aplicar o modelo salvo de destinos, intervalos e horários a esta campanha? Ela ficará como rascunho para você revisar e confirmar o início. Nenhum envio será iniciado automaticamente.')) return; await safeCall('sourceApplyConfigTemplate', { campaignId: id }); await ctx.refresh(); openMonitor(id); ctx.toast('Modelo aplicado ao rascunho. Revise e confirme o início.'); return; }
      if (action === 'filter-publications') { state.campaignId = id; state.offset = 0; ctx.closeModal(); ctx.navigate('sources'); await load(); ctx.render(true); return; }
      if (action === 'retry-media') { await safeCall('sourceRetryMedia', { id }); ctx.toast('Download da mídia solicitado. Acompanhe o resultado; os outros itens continuam disponíveis.'); }
      if (action === 'remove') { if (!confirm('Retirar esta publicação dos envios ainda não iniciados? Mensagens já aceitas ou entregues não serão apagadas.')) return; await safeCall('sourceRemovePublication', { id }); ctx.toast('Publicação retirada dos próximos envios. Histórico preservado.'); }
      if (action === 'sync-groups') { await safeCall('refreshGroups'); await ctx.refresh(); if (!state.dirty) ctx.render(true); return; }
      if (action === 'import-history') {
        ctx.showModal('source-history', 'Importar período anterior', 'A integração pode não disponibilizar todas as mensagens. Lacunas são registradas; nenhuma importação inicia disparos.', `<form id="source-history-form"><div class="field-grid">${field('De (Brasília)', 'from', '', 'datetime-local', 'required')}${field('Até (Brasília)', 'to', toLocalInput(Date.now()), 'datetime-local', 'required')}</div><div class="warning-note">Serão importadas somente publicações válidas do grupo de origem configurado e de participantes autorizados. IDs já capturados não são incluídos novamente.</div></form>`, button('save-history', 'Solicitar importação', 'primary')); return;
      }
      if (action === 'save-history') { await onSubmit($('#source-history-form')); return; }
      if (action === 'previous' || action === 'next') {state.offset = Math.max(0, state.offset + (action === 'next' ? 30 : -30));state.selected.clear();}
      await ctx.refresh(); await load(); ctx.render(true);
    }
    async function onSubmit(form) {
      if (!form || state.submitting) return;
      state.submitting = true;
      try {
        if (form.id === 'source-resume-link-form') {
          if (!form.reportValidity()) return;
          if (form.dataset.groupId !== config().groupId) throw new Error('O grupo de origem mudou. Abra o vínculo novamente antes de confirmar.');
          const id = form.elements.campaignId.value;
          if (!id) throw new Error('Selecione uma campanha para vincular.');
          await resumeCapture(id);
        }
        if (form.id === 'source-config-form') await saveConfig(form);
        if (form.id === 'source-review-form') {
          const item = state.review;
          if (!item || item.id !== form.dataset.id) throw new Error('A publicação mudou. Abra a revisão novamente.');
          if (!can('campaign.edit')) throw new Error('Sem permissão para editar campanhas.');
          const caption = form.elements.caption.value;
          await safeCall('sourceReviewPublication', { id: item.id, ...(item.type === 'text' || item.item?.type === 'text' ? { text: caption } : { caption }) });
          state.review = null; ctx.closeModal(); await ctx.refresh(); await load(); ctx.render(true); ctx.toast('Revisão salva para o rascunho ou próximas rodadas.');
        }
        if(form.id==='source-group-form'){
          if(!can('campaign.edit'))throw new Error('Sem permissão para editar campanhas.');
          if(!state.grouping||state.grouping.length<2)throw new Error('Selecione as fotos novamente.');
          await safeCall('sourceGroupPublications',{ids:state.grouping,caption:form.elements.caption.value});
          state.grouping=null;state.selected.clear();ctx.closeModal();await ctx.refresh();await load();ctx.render(true);ctx.toast('Agrupamento manual salvo para as próximas rodadas.');
        }
        if (form.id === 'source-history-form') {
          if (!canConfigure()) throw new Error('Sem permissão para importar o histórico da origem.');
          if (!form.reportValidity()) return;
          const from = fromLocalInput(form.elements.from.value), to = fromLocalInput(form.elements.to.value);
          if (!from || !to || from > to) throw new Error('Informe um período válido, com início anterior ao fim.');
          const result = await safeCall('sourceImportHistory', { from, to });
          ctx.closeModal(); await ctx.refresh(); await load(); ctx.render(true); ctx.toast(result?.message || 'Importação solicitada. Confira o resultado e as lacunas de captura na tela.', result?.supported === false);
        }
      } finally { state.submitting = false; }
    }
    async function onChange(element) {
      if (element.closest('#source-config-form')) state.dirty = true;
      if(element.dataset.sourceSelect){if(element.checked)state.selected.add(element.dataset.sourceSelect);else state.selected.delete(element.dataset.sourceSelect);const count=$('#source-selected-count');if(count)count.textContent=`${state.selected.size} selecionada(s)`;const groupButton=$('[data-action="source-group"]');if(groupButton)groupButton.disabled=state.selected.size<2;}
      if (element.id === 'source-groupId') {
        $('#source-origin-id').textContent = element.value || 'Nenhum grupo escolhido';
        for (const row of $$('[data-source-destination-row]')) {
          const isOrigin = row.dataset.sourceDestinationRow === element.value;
          const checkbox = $('input', row); checkbox.disabled = isOrigin;
          if (isOrigin) checkbox.checked = false;
          row.classList.toggle('source-origin-excluded', isOrigin);
        }
      }
      if (element.id === 'source-campaign-filter') { state.campaignId = element.value; state.offset = 0;state.selected.clear(); await load(); ctx.render(true); }
    }
    function reset() { state.epoch++; Object.assign(state, { loaded: null, dirty: false, submitting: false, publications: null, offset: 0, campaignId: '', review: null, monitorId: '', order: null,selected:new Set(),grouping:null,loadError:null,snapshotKey:null,resuming:false }); }
    return { render, renderMonitor, load, maybeLoad, onAction, onSubmit, onChange, onInput: element => { if (element.closest('#source-config-form')) state.dirty = true; }, reset, hasUnsaved: () => state.dirty, shouldPreserveDOM: () => state.dirty || Boolean($('#source-config-form')?.contains(document.activeElement)), updateMonitor: () => { clearDeletedReferences(); if (ctx.modalKind() === 'source-monitor' && state.monitorId && $('#source-campaign-monitor') && !$('#source-campaign-monitor').contains(document.activeElement)) $('#source-campaign-monitor').outerHTML = renderMonitor(state.monitorId); } };
  }
};
