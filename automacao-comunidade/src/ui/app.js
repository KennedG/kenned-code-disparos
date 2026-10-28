'use strict';

(() => {
  const bridge = window.community;
  const $ = (selector, parent = document) => parent.querySelector(selector);
  const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const icons = {
    dashboard: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    groups: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v2"/>',
    campaign: '<path d="m3 10 17-6v16L3 14v-4Zm4 6 2 5h4l-2-4M21 10h1M20 1l-2 2"/>',
    contacts: '<rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="12" cy="9" r="3"/><path d="M7 18a5 5 0 0 1 10 0M2 7h4M2 12h4M2 17h4"/>',
    templates: '<path d="M14 3H5v18h14V8l-5-5Zm0 0v6h5M8 13h8M8 17h5"/>',
    history: '<path d="M3 11a9 9 0 1 1 3 8M3 3v8h8M12 7v5l3 2"/>',
    settings: '<path d="m9 3-1 3-3 1-2 4 2 3 1 4 3 1 3 2 3-2 4-1 1-4 2-3-2-4-3-1-1-3H9Z"/><circle cx="12" cy="12" r="3"/>',
    search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
    link: '<path d="m9 15 6-6M8 8l2-2a5 5 0 0 1 7 7l-2 2M9 9l-2 2a5 5 0 0 0 7 7l2-2"/>',
    shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>',
    send: '<path d="m3 3 19 9-19 9 4-9-4-9Zm4 9h15"/>',
    check: '<path d="m5 12 4 4L20 5"/>',
  };
  const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.templates}</svg>`;
  const pages = [
    ['painel', 'Painel', 'dashboard'], ['grupos', 'Grupos e participantes', 'groups'], ['campanhas', 'Campanhas', 'campaign'],
    ['contatos', 'Contatos', 'contacts'], ['modelos', 'Modelos', 'templates'], ['historico', 'Histórico', 'history'], ['configuracoes', 'Configurações', 'settings'],
  ];
  const state = {
    page: 'painel', snapshot: null, contacts: { items: [], total: 0, limit: 25, offset: 0 }, history: { items: [], total: 0, limit: 25, offset: 0 },
    templates: [], contactSearch: '', contactStatus: '', contactGroup: '', selectedContacts: new Set(), contactCache: new Map(), authorizationPreview: null, editingContact: null, historyStatus: '', historySearch: '',
    groupSearch: '', selectedGroupIds: new Set(), campaignSearch: '', modalKind: null, preview: null, busy: false, pageEpoch: 0,
  };
  const statusText = {
    disconnected: ['Desconectado', 'amber'], connecting: ['Conectando', 'blue'], qr: ['Aguardando QR Code', 'amber'], connected: ['Conectado', 'green'],
    draft: ['Rascunho', 'dark'], scheduled: ['Agendada', 'blue'], active: ['Em execução', 'green'], paused: ['Pausada', 'amber'], stopped: ['Encerrada', 'dark'], completed: ['Concluída', 'green'],
    pending: ['Aguardando', 'amber'], processing: ['Processando', 'blue'], accepted: ['Enviado — aceito pela integração', 'green'], delivered: ['Entrega confirmada', 'green'],
    uncertain: ['Resultado incerto — revisar', 'purple'], failed: ['Falhou', 'red'], cancelled: ['Cancelado', 'dark'], identified: ['Identificado', 'dark'], authorized: ['Autorizado', 'blue'], blocked: ['Bloqueado', 'red'], invited: ['Convidado anteriormente', 'green'], unavailable: ['Número indisponível', 'amber'],
  };
  function badge(status, custom) {
    const [label, color] = statusText[status] || [status || 'Não informado', 'dark'];
    return `<span class="badge ${color}">${esc(custom || label)}</span>`;
  }
  function date(value, options = {}) {
    if (value === null || value === undefined || value === '') return '—';
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) return '—';
    return parsed.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', ...options });
  }
  function time(value) { return date(value, { year: undefined, month: undefined, day: undefined, second: '2-digit' }); }
  function count(value) { return Number(value || 0).toLocaleString('pt-BR'); }
  function duration(ms) {
    const seconds = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}min ${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}min`;
  }
  function phone(contact) { return contact.phone ? `+${contact.phone}` : 'Número indisponível'; }
  function contactName(contact) { return contact.name || contact.displayName || contact.phone || 'Participante sem nome disponível'; }
  function toast(message, type = '') {
    const node = document.createElement('div'); node.className = `toast ${type}`; node.textContent = message;
    $('#toasts').append(node); setTimeout(() => node.remove(), type === 'error' ? 14000 : 6500);
  }
  function errorMessage(error) {
    let message = error?.message || String(error || 'Não foi possível concluir a operação.');
    for (let pass = 0; pass < 3; pass++) message = message.replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i, '').replace(/^Error:\s*/i, '');
    const code = error?.code;
    return code && /^[A-Z0-9_]{2,80}$/.test(code) && !message.includes(code) ? `${message} [${code}]` : message;
  }
  async function rpc(action, payload = {}) {
    if (!bridge?.call) throw new Error('A ponte segura do aplicativo não está disponível. Abra o aplicativo instalado.');
    const result = await bridge.call(action, payload);
    if (result?.ok === false || result?.success === false) throw new Error(result.error?.message || result.error || result.message || 'A operação não foi concluída.');
    return result;
  }
  async function perform(action, payload, message) {
    const result = await rpc(action, payload);
    if (message && result?.cancelled !== true && result?.canceled !== true) toast(message);
    await refreshSnapshot();
    return result;
  }
  function snapshotGroups() { return state.snapshot?.groups || []; }
  function snapshotCampaigns() { return state.snapshot?.campaigns || []; }
  function groupName(id) { return snapshotGroups().find((group) => group.id === id)?.name || id || '—'; }
  function heading(title, description, actions = '', eyebrow = 'AUTOMAÇÃO COMUNIDADE') {
    return `<div class="page-heading"><div><p class="eyebrow">${esc(eyebrow)}</p><h1>${esc(title)}</h1><p class="description">${esc(description)}</p></div>${actions ? `<div class="actions">${actions}</div>` : ''}</div>`;
  }
  function empty(title, description, actions = '', name = 'groups') {
    return `<div class="empty-state"><span class="empty-icon">${icon(name)}</span><h3>${esc(title)}</h3><p>${esc(description)}</p>${actions ? `<div class="actions">${actions}</div>` : ''}</div>`;
  }
  function searchInput(id, value, placeholder) { return `<div class="search">${icon('search')}<input id="${id}" class="input" value="${esc(value)}" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" autocomplete="off"></div>`; }
  function option(value, label, selected) { return `<option value="${esc(value)}" ${String(value) === String(selected) ? 'selected' : ''}>${esc(label)}</option>`; }
  function navigation() {
    $('#navigation').innerHTML = pages.map(([id, title, name]) => `<a href="#${id}" class="nav-link${state.page === id ? ' active' : ''}" ${state.page === id ? 'aria-current="page"' : ''}>${icon(name)}<span>${esc(title)}</span></a>`).join('');
  }
  function updateChrome() {
    const snapshot = state.snapshot || {};
    const connection = snapshot.connection || {};
    const status = connection.state || 'disconnected';
    $('#connection-dot').className = `status-dot ${status}`;
    $('#connection-label').textContent = statusText[status]?.[0] || 'Desconectado';
    $('#connection-detail').textContent = connection.detail || (status === 'connected' ? 'Sessão disponível para verificação de envio' : 'Conecte sua conta em Configurações');
    $('#simulation-banner').hidden = !['simulated', 'simulation'].includes(snapshot.mode);
    $('#global-pause').hidden = !(snapshot.queue?.stopped || snapshot.queue?.automationStopped || snapshot.settings?.automationStopped);
    $('#sidebar-version').textContent = `Versão ${snapshot.version || '1.0.0'} · Windows`;
    $('#storage-error').hidden = !snapshot.storageError;
    if (snapshot.storageError) $('#storage-error').textContent = `Falha no armazenamento: ${typeof snapshot.storageError === 'string' ? snapshot.storageError : snapshot.storageError.message || 'Consulte os detalhes antes de enviar.'}`;
    $('#app').setAttribute('aria-busy', 'false');
    updateClocks();
  }
  function updateClocks() {
    $('#current-clock').textContent = `${new Date().toLocaleTimeString('pt-BR')} · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
    $$('[data-countdown]').forEach((element) => {
      const at = Number(element.dataset.countdown);
      element.textContent = at > Date.now() ? `em ${duration(at - Date.now())}` : 'Aguardando tarefa elegível';
    });
  }
  let snapshotTimer;
  async function refreshSnapshot(render = true) {
    const snapshot = await rpc('snapshot');
    if (!snapshot || typeof snapshot !== 'object') throw new Error('O aplicativo não retornou o estado atual.');
    acceptSnapshot(snapshot, render);
    return snapshot;
  }
  function acceptSnapshot(snapshot, render = true) {
    const previousMode = state.snapshot?.mode;
    state.snapshot = snapshot;
    if (previousMode && previousMode !== snapshot.mode) {
      state.selectedContacts.clear(); state.contactCache.clear(); state.selectedGroupIds.clear(); state.authorizationPreview = null; state.editingContact = null; state.contactGroup = ''; state.contacts = { items: [], total: 0, limit: 25, offset: 0 };
      state.history = { items: [], total: 0, limit: 25, offset: 0 }; state.templates = []; state.preview = null;
      closeModal();
    }
    updateChrome();
    if (render && !state.modalKind && ['painel', 'campanhas', 'grupos'].includes(state.page)) renderPage();
  }
  function scheduleSnapshot() {
    clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(() => refreshSnapshot().catch((error) => toast(errorMessage(error), 'error')), 250);
  }
  async function loadPage() {
    const epoch = ++state.pageEpoch;
    navigation();
    try {
      if (state.page === 'contatos') {
        const result = await rpc('listContacts', filters({ search: state.contactSearch, status: state.contactStatus, groupId: state.contactGroup, limit: 25, offset: state.contacts.offset }));
        if (epoch !== state.pageEpoch) return;
        state.contacts = listResult(result);
        state.contacts.items.forEach((contact) => state.contactCache.set(contact.id, contact));
      } else if (state.page === 'historico') {
        const result = await rpc('listHistory', filters({ status: state.historyStatus, search: state.historySearch, limit: 25, offset: state.history.offset }));
        if (epoch !== state.pageEpoch) return;
        state.history = listResult(result);
      } else if (state.page === 'modelos') {
        const result = await rpc('listTemplates', { limit: 200, offset: 0 });
        if (epoch !== state.pageEpoch) return;
        state.templates = listResult(result).items;
      }
      if (epoch === state.pageEpoch) renderPage();
    } catch (error) {
      if (epoch === state.pageEpoch) $('#main').innerHTML = `${heading(pages.find(([id]) => id === state.page)?.[1] || 'Aplicativo', 'Não foi possível carregar esta área.')}<div class="notice danger-notice"><span>${esc(errorMessage(error))}</span><button class="button secondary" data-action="reload-page">Tentar novamente</button></div>`;
    }
  }
  function listResult(value) { return Array.isArray(value) ? { items: value, total: value.length, limit: value.length || 25, offset: 0 } : { items: value?.items || [], total: value?.total || 0, limit: value?.limit || 25, offset: value?.offset || 0 }; }
  function filters(value) { return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== '' && entry !== null && entry !== undefined)); }
  function renderPage() {
    if (!state.snapshot) return;
    const renderers = { painel: renderDashboard, grupos: renderGroups, campanhas: renderCampaigns, contatos: renderContacts, modelos: renderTemplates, historico: renderHistory, configuracoes: renderSettings };
    $('#main').innerHTML = (renderers[state.page] || renderDashboard)();
    updateClocks();
  }
  function stat(label, value, note, name) { return `<div class="stat-card"><div class="stat-top"><span>${esc(label)}</span>${icon(name)}</div><strong class="stat-value">${count(value)}</strong><span class="stat-note">${esc(note)}</span></div>`; }
  function renderDashboard() {
    const snapshot = state.snapshot; const metrics = snapshot.metrics || {}; const connection = snapshot.connection || {}; const next = snapshot.queue?.nextSendAt || snapshot.queue?.nextAt;
    const campaigns = snapshotCampaigns().filter((campaign) => ['active', 'scheduled', 'paused'].includes(campaign.status));
    return `${heading('Convites com organização.', 'Selecione seu grupo, revise os contatos autorizados e convide cada pessoa no momento certo.', '<button class="button" data-action="new-campaign">+ Nova campanha</button>')}
      <div class="stats-grid">${stat('Contatos identificados', metrics.identified, 'Identificar não significa autorizar', 'contacts')}${stat('Novos elegíveis', metrics.newEligible, 'Autorizados e ainda não convidados', 'groups')}${stat('Convidados anteriormente', metrics.previouslyInvited, 'Proteção persistente contra repetição', 'check')}${stat('Na fila', Number(metrics.pending || 0) + Number(metrics.processing || 0), `${count(metrics.uncertain)} resultado(s) incerto(s) para revisão`, 'clock')}</div>
      <div class="grid-2"><section class="panel"><div class="panel-header"><h2>Conexão com o WhatsApp</h2>${badge(connection.state || 'disconnected')}</div><div class="panel-body"><div class="connection-card"><div class="connection-symbol">${icon('link')}</div><div class="connection-copy"><h3>${connection.ready ? 'Sessão conectada' : 'Sua conta, no seu computador'}</h3><p>${esc(connection.detail || 'Conecte o WhatsApp para consultar os grupos e preparar seus convites.')}</p></div></div>${renderQr(connection)}<div class="actions space-top">${connectionButtons(connection)}<a href="#configuracoes" class="button ghost">Configurar conexão →</a></div></div></section>
      <section class="panel"><div class="panel-header"><h2>Um caminho simples, do início ao envio</h2></div><div class="panel-body"><ol class="help-list"><li><span class="step-number">1</span><div><strong>Escolha um grupo real</strong>Atualize os participantes disponíveis na sua conta.</div></li><li><span class="step-number">2</span><div><strong>Revise e autorize os contatos</strong>Registre a autorização. Participar do grupo não é consentimento.</div></li><li><span class="step-number">3</span><div><strong>Confira a mensagem e os destinos</strong>A campanha só inicia depois da sua confirmação.</div></li></ol></div></section></div>
      <div class="grid-2"><section class="panel"><div class="panel-header"><div><h2>Acompanhamento dos envios</h2><p>Aceitação pela integração e entrega são etapas diferentes.</p></div><a href="#historico" class="subtle-link">Ver histórico →</a></div><div class="panel-body"><div class="summary-grid">${[['Aceitos', metrics.accepted], ['Entregues', metrics.delivered], ['Com falha', metrics.failed]].map(([label, value]) => `<div class="summary-cell"><strong>${count(value)}</strong><span>${esc(label)}</span></div>`).join('')}</div><div class="notice ${metrics.uncertain ? 'warning' : ''}"><span>${metrics.uncertain ? `${count(metrics.uncertain)} envio(s) com resultado incerto. Revise antes de repetir; os demais contatos podem continuar.` : 'Os contatos já convidados não entram novamente no modo “Somente novos”.'}</span></div><p class="help space-top">Próximo envio: ${next ? `${esc(date(next))} · <span class="countdown" data-countdown="${Number(next)}"></span>` : 'aguardando campanha e condições de envio.'}</p></div></section>
      <section class="panel"><div class="panel-header"><h2>Acesso rápido</h2></div><div class="panel-body"><div class="quick-actions"><a class="quick-action" href="#grupos"><strong>Consultar participantes</strong><span>Grupos reais e identificação confiável.</span></a><a class="quick-action" href="#contatos"><strong>Revisar contatos</strong><span>Autorizações, bloqueios e convites.</span></a><a class="quick-action" href="#modelos"><strong>Preparar uma mensagem</strong><span>Modelos prontos para reutilizar.</span></a><a class="quick-action" href="#configuracoes"><strong>Fazer backup</strong><span>Dados e proteção contra repetição.</span></a></div></div></section></div>
      ${campaigns.length ? `<section class="panel"><div class="panel-header"><h2>Campanhas em acompanhamento</h2><a href="#campanhas" class="subtle-link">Todas as campanhas →</a></div><div class="table-scroll"><table><thead><tr><th>Campanha</th><th>Situação</th><th>Intervalo entre contatos</th><th>Modo</th></tr></thead><tbody>${campaigns.slice(0, 6).map((campaign) => `<tr><td><strong>${esc(campaign.name)}</strong><small>${esc(campaign.id)}</small></td><td>${badge(campaign.status)}</td><td>${esc(intervalLabel(campaign))}</td><td>${campaign.mode === 'all' ? 'Reenvio confirmado' : 'Somente novos'}</td></tr>`).join('')}</tbody></table></div></section>` : ''}`;
  }
  function renderQr(connection) {
    const qr = connection.qrDataUrl || connection.qr;
    if (connection.state !== 'qr') return '';
    const image = typeof qr === 'string' && /^data:image\/(png|svg\+xml|webp);/i.test(qr) ? `<img src="${esc(qr)}" alt="QR Code real da sessão WhatsApp">` : '<p>Gerando QR Code da sessão…</p>';
    return `<div class="qr-panel">${image}<p>No celular da conta: WhatsApp → Dispositivos conectados → Conectar dispositivo. Não compartilhe este código.</p></div>`;
  }
  function connectionButtons(connection) {
    return connection.state === 'connected' ? '<button class="button secondary" data-action="test-connection">Testar conexão</button><button class="button ghost" data-action="disconnect">Desconectar</button>' : `<button class="button" data-action="${connection.state === 'disconnected' ? 'connect' : 'reconnect'}">${connection.state === 'qr' ? 'Gerar novo QR Code' : connection.state === 'connecting' ? 'Verificar / reconectar' : 'Conectar WhatsApp'}</button>`;
  }
  function renderGroups() {
    const groups = snapshotGroups().filter((group) => `${group.name} ${group.id}`.toLocaleLowerCase('pt-BR').includes(state.groupSearch.toLocaleLowerCase('pt-BR')));
    return `${heading('Grupos e participantes', 'Os grupos são identificados pelo ID real do WhatsApp, mesmo que mudem de nome.', '<button class="button" data-action="refresh-groups">↻ Sincronizar grupos</button>')}
      <div class="notice info space-bottom"><span>Consultar participantes apenas identifica contatos. Para enviar convites privados, revise e registre a autorização de cada pessoa em Contatos.</span></div>
      <div class="toolbar">${searchInput('group-search', state.groupSearch, 'Buscar grupo por nome ou ID')}<span class="selection-count">${count(groups.length)} grupo(s) disponível(is)</span></div>
      ${groups.length ? `<div class="group-grid">${groups.map((group) => `<article class="group-card${state.selectedGroupIds.has(group.id) ? ' selected' : ''}"><div class="group-card-header"><div class="group-avatar">${esc((group.name || 'G').slice(0, 1).toUpperCase())}</div><div><h3>${esc(group.name || 'Grupo sem nome disponível')}</h3><span class="group-id">${esc(group.id)}</span></div></div><p>${Number.isFinite(Number(group.participantCount)) ? `${count(group.participantCount)} participante(s) informado(s) pela integração` : 'Participantes consultados sob demanda.'}<br>Última consulta: ${esc(date(group.participantsUpdatedAt || group.updatedAt))}</p><div class="actions"><button class="button compact" data-action="refresh-participants" data-id="${esc(group.id)}">Atualizar participantes</button><button class="button secondary compact" data-action="view-group-contacts" data-id="${esc(group.id)}">Ver contatos</button></div></article>`).join('')}</div>` : `<section class="panel">${empty(state.groupSearch ? 'Nenhum grupo corresponde à pesquisa' : 'Seus grupos vão aparecer aqui', state.groupSearch ? 'Tente outro nome ou identificador.' : 'Conecte sua conta e clique em “Sincronizar grupos”. A tela real nunca é preenchida com grupos fictícios.', '<button class="button" data-action="refresh-groups">Sincronizar grupos</button>')}</section>`}`;
  }
  function pagination(list, kind) {
    return `<div class="pagination"><span>${list.total ? `${list.offset + 1}–${Math.min(list.offset + list.items.length, list.total)} de ${count(list.total)}` : 'Nenhum registro'}</span><div class="actions"><button class="button secondary compact" data-action="previous-${kind}" ${list.offset <= 0 ? 'disabled' : ''}>← Anterior</button><button class="button secondary compact" data-action="next-${kind}" ${list.offset + list.items.length >= list.total ? 'disabled' : ''}>Próxima →</button></div></div>`;
  }
  function contactBadges(contact) {
    return `<span class="status-stack">${badge('identified')}${contact.authorized ? badge('authorized') : ''}${contact.invitationState || contact.previouslyInvited ? badge(contact.invitationState || 'invited') : ''}${contact.blocked ? badge('blocked') : ''}${contact.optOut ? badge('blocked', 'Não deseja receber') : ''}${contact.muted ? badge('blocked', 'Silenciado') : ''}${contact.ambiguous ? badge('uncertain', 'Identidade ambígua') : ''}${contact.self ? badge('dark', 'Sua conta') : ''}</span>`;
  }
  function contactAuthorization(contact) {
    if (typeof contact?.authorizationEligible === 'boolean') return { eligible: contact.authorizationEligible, code: contact.authorizationBlockCode, reason: contact.authorizationBlockReason };
    if (!contact) return { eligible: false, code: 'CONTACT_NOT_FOUND', reason: 'Contato não encontrado. Atualize os participantes.' };
    if (contact.optOut) return { eligible: false, code: 'CONTACT_OPT_OUT', reason: 'Este contato pediu para não receber convites.' };
    if (contact.blocked) return { eligible: false, code: 'CONTACT_BLOCKED', reason: 'Contato bloqueado. Revise o bloqueio antes de autorizar.' };
    if (contact.muted) return { eligible: false, code: 'CONTACT_MUTED', reason: 'Contato silenciado. Revise o silenciamento antes de autorizar.' };
    if (contact.self) return { eligible: false, code: 'CONTACT_SELF', reason: 'Esta é a conta conectada ao aplicativo.' };
    if (contact.ambiguous) return { eligible: false, code: 'CONTACT_IDENTITY_AMBIGUOUS', reason: 'A integração informou uma identidade ambígua. Atualize os participantes.' };
    if (!/^\+?[1-9]\d{7,14}$/.test(contact.phone || '')) return { eligible: false, code: 'CONTACT_PHONE_UNAVAILABLE', reason: 'O WhatsApp não disponibilizou um telefone confiável. Um LID não pode ser convertido em número.' };
    return { eligible: true, code: null, reason: null };
  }
  function authorizationNote(contact) {
    const eligibility = contactAuthorization(contact);
    return eligibility.eligible ? '<small class="authorization-eligible">Pode registrar autorização explícita.</small>' : `<small class="authorization-block" data-authorization-code="${esc(eligibility.code)}">${esc(eligibility.reason)}</small>`;
  }
  function renderContacts() {
    const list = state.contacts;
    const eligibleSelected = [...state.selectedContacts].filter((id) => contactAuthorization(state.contactCache.get(id)).eligible).length;
    return `${heading('Contatos com controle.', 'Identificação, autorização e convite são registros separados. Nomes não substituem a identidade da conta.', '<button class="button secondary" data-action="reload-page">↻ Atualizar</button>')}
      <div class="toolbar"><div class="toolbar-group">${searchInput('contact-search', state.contactSearch, 'Buscar por nome ou telefone')}<select id="contact-group" class="input" aria-label="Filtrar contatos por grupo">${option('', 'Todos os grupos', state.contactGroup)}${snapshotGroups().map((group) => option(group.id, group.name, state.contactGroup)).join('')}</select><select id="contact-status" class="input" aria-label="Filtrar contatos por situação">${[['', 'Todas as situações'], ['identified', 'Identificados'], ['authorized', 'Autorizados'], ['invited', 'Já convidados'], ['blocked', 'Bloqueados']].map(([value, label]) => option(value, label, state.contactStatus)).join('')}</select></div></div>
      <section class="panel"><div class="panel-header"><div class="toolbar-group"><button class="button secondary compact" data-action="select-filtered-contacts">Selecionar todos os resultados</button><button class="button ghost compact" data-action="clear-contact-selection">Desmarcar todos</button><span class="selection-count" id="contact-selection-count">${count(state.selectedContacts.size)} selecionado(s) · ${count(eligibleSelected)} apto(s) para autorização</span></div><button class="button compact" data-action="authorize-selected" ${!eligibleSelected ? 'disabled' : ''}>Registrar autorização dos aptos</button></div>
      ${list.items.length ? `<div class="table-scroll"><table><thead><tr><th><input id="select-visible-contacts" type="checkbox" aria-label="Selecionar os contatos desta página" ${list.items.every((contact) => state.selectedContacts.has(contact.id)) ? 'checked' : ''}></th><th>Contato</th><th>Telefone / identidade</th><th>Situação</th><th>Primeira identificação</th><th></th></tr></thead><tbody>${list.items.map((contact) => `<tr><td class="checkbox-cell"><input type="checkbox" data-contact-select="${esc(contact.id)}" aria-label="Selecionar ${esc(contactName(contact))}" ${state.selectedContacts.has(contact.id) ? 'checked' : ''}></td><td><strong>${esc(contactName(contact))}</strong>${contact.name && contact.displayName && contact.name !== contact.displayName ? `<small>Perfil WhatsApp: ${esc(contact.displayName)}</small>` : ''}<small>${(contact.groupIds || []).map(groupName).map(esc).join(' · ') || 'Grupo não informado'}</small></td><td><strong>${esc(phone(contact))}</strong><small class="code">${esc(contact.externalId || contact.id)}</small></td><td>${contactBadges(contact)}${authorizationNote(contact)}</td><td>${esc(date(contact.firstSeenAt))}</td><td><button class="button secondary compact" data-action="edit-contact" data-id="${esc(contact.id)}">Revisar</button></td></tr>`).join('')}</tbody></table></div>` : empty('Nenhum contato nesta seleção', 'Atualize os participantes de um grupo e revise os contatos. Números indisponíveis ou identidades ambíguas não ficam elegíveis para envio.', '<a class="button" href="#grupos">Consultar grupos</a>', 'contacts')}
      ${pagination(list, 'contacts')}</section><p class="help">“Selecionar todos os resultados” inclui todas as páginas da pesquisa e dos filtros atuais. Selecionar não autoriza nem envia mensagens. A autorização será registrada apenas para contatos com telefone confiável, sem bloqueios, após sua confirmação.</p>`;
  }
  function intervalLabel(campaign) { return `${campaign.intervalValue || (campaign.intervalMs ? campaign.intervalMs / 1000 : 30)} ${campaign.intervalUnit === 'minutes' ? 'minuto(s)' : 'segundo(s)'}`; }
  function renderCampaigns() {
    const campaigns = snapshotCampaigns().filter((campaign) => (campaign.name || '').toLocaleLowerCase('pt-BR').includes(state.campaignSearch.toLocaleLowerCase('pt-BR')));
    const next = state.snapshot.queue?.nextSendAt || state.snapshot.queue?.nextAt;
    return `${heading('Suas campanhas', 'Uma mensagem bem preparada, para os contatos certos. Nenhuma campanha começa ao ser criada.', '<button class="button" data-action="new-campaign">+ Nova campanha</button>')}
      ${next ? `<div class="notice space-bottom"><span>Próximo contato na fila: <strong>${esc(date(next))}</strong> · <span class="countdown" data-countdown="${Number(next)}"></span>. A conexão e os horários serão conferidos novamente antes de enviar.</span></div>` : ''}
      <div class="toolbar">${searchInput('campaign-search', state.campaignSearch, 'Buscar campanha')}<span class="selection-count">${count(campaigns.length)} campanha(s)</span></div>
      ${campaigns.length ? `<div class="campaign-grid">${campaigns.map((campaign) => `<article class="campaign-card"><div class="campaign-card-top"><h3>${esc(campaign.name)}</h3>${badge(campaign.status)}</div><p>${esc(campaign.message)}</p><div class="campaign-facts"><div><span>Tempo entre contatos</span><strong>${esc(intervalLabel(campaign))}</strong></div><div><span>Destinatários</span><strong>${campaign.mode === 'all' ? 'Novos + já registrados' : 'Somente novos'}</strong></div><div><span>Grupos de origem</span><strong>${count(campaign.groupIds?.length)} selecionado(s)</strong></div><div><span>Início programado</span><strong>${campaign.startAt ? esc(date(campaign.startAt)) : 'Após sua confirmação'}</strong></div></div><div class="actions"><button class="button compact" data-action="preview-campaign" data-id="${esc(campaign.id)}">${['active', 'scheduled'].includes(campaign.status) ? 'Ver prévia' : 'Prévia e iniciar'}</button><button class="button secondary compact" data-action="edit-campaign" data-id="${esc(campaign.id)}">Editar</button>${['active', 'scheduled'].includes(campaign.status) ? `<button class="button secondary compact" data-action="pause-campaign" data-id="${esc(campaign.id)}">Pausar</button>` : campaign.status === 'paused' ? `<button class="button secondary compact" data-action="resume-campaign" data-id="${esc(campaign.id)}">Retomar fila</button>` : ''}<button class="button ghost compact" data-action="campaign-details" data-id="${esc(campaign.id)}">Mais opções</button></div></article>`).join('')}</div>` : `<section class="panel">${empty('Seu próximo convite começa aqui', 'Crie uma campanha, escolha os grupos e contatos autorizados, ajuste a mensagem e confira a prévia antes de iniciar.', '<button class="button" data-action="new-campaign">Criar primeira campanha</button>', 'campaign')}</section>`}`;
  }
  function renderTemplates() {
    return `${heading('Modelos de mensagem', 'Salve seus textos e reutilize em novas campanhas, com nome e link preenchidos por contato.', '<button class="button" data-action="new-template">+ Novo modelo</button>')}
      <div class="notice space-bottom"><span>Campos disponíveis: <code>{nome}</code> e <code>{link_comunidade}</code>. O nome alternativo e o link são definidos na campanha.</span></div><section class="panel">${state.templates.length ? state.templates.map((template) => `<article class="template-card"><div><h3>${esc(template.name)}</h3><p>${esc(template.message || template.text || '')}</p></div><div class="actions"><button class="button compact" data-action="use-template" data-id="${esc(template.id)}">Usar</button><button class="button secondary compact" data-action="edit-template" data-id="${esc(template.id)}">Editar</button><button class="button ghost compact" data-action="duplicate-template" data-id="${esc(template.id)}">Duplicar</button><button class="button ghost compact" data-action="delete-template" data-id="${esc(template.id)}">Excluir</button></div></article>`).join('') : empty('Seus textos, prontos para reutilizar', 'Crie e nomeie um modelo. Ele só é exibido como salvo depois da confirmação do banco local.', '<button class="button" data-action="new-template">Criar modelo</button>', 'templates')}</section>`;
  }
  function renderHistory() {
    const list = state.history;
    return `${heading('Histórico e revisão', 'Acompanhe cada etapa. Um envio incerto exige conferência; não é reenviado automaticamente.', '<button class="button secondary" data-action="export-history">Exportar registros</button><button class="button secondary" data-action="clear-history">Limpar histórico visual</button>')}
      <div class="toolbar"><div class="toolbar-group">${searchInput('history-search', state.historySearch, 'Buscar contato, campanha ou erro')}<select id="history-status" class="input" aria-label="Filtrar situação do envio">${[['', 'Todas as situações'], ...['pending', 'processing', 'accepted', 'delivered', 'uncertain', 'failed', 'cancelled'].map((status) => [status, statusText[status][0]])].map(([value, label]) => option(value, label, state.historyStatus)).join('')}</select></div><button class="button secondary compact" data-action="reload-page">↻ Atualizar</button></div>
      <section class="panel">${list.items.length ? `<div class="table-scroll"><table><thead><tr><th>Contato e campanha</th><th>Situação</th><th>Horário</th><th>Tentativas</th><th></th></tr></thead><tbody>${list.items.map((job) => `<tr><td><strong>${esc(job.contactName || job.name || job.phoneSnapshot || job.phone || job.contactId || 'Contato indisponível')}</strong><small>${esc(job.campaignName || snapshotCampaigns().find((campaign) => campaign.id === job.campaignId)?.name || job.campaignId)}</small></td><td>${badge(job.status)}${job.error ? `<small title="${esc(job.error)}">${esc(job.errorCode ? `${job.errorCode}: ${job.error}` : job.error)}</small>` : ''}</td><td>${esc(date(job.resultAt || job.createdAt || job.at))}</td><td>${count(job.attempts)}</td><td><button class="button secondary compact" data-action="history-details" data-id="${esc(job.id)}">Detalhes</button></td></tr>`).join('')}</tbody></table></div>` : empty('Nenhum envio registrado nesta seleção', 'O histórico aparece depois que uma execução é confirmada. Aceitação, entrega, falha e incerteza ficam separadas.', '', 'history')}${pagination(list, 'history')}</section><div class="notice info"><span>Limpar a visualização não apaga a fila, as reservas nem o registro operacional que protege contra convites repetidos.</span></div>`;
  }
  function renderSettings() {
    const snapshot = state.snapshot; const settings = snapshot.settings || {}; const connection = snapshot.connection || {};
    return `${heading('Configurações', 'Conexão própria, preferências salvas e recuperação dos seus dados. Tudo separado do Kenned Code Disparos.')}
      <div class="grid-2"><section class="panel"><div class="panel-header"><h2>Conta do WhatsApp</h2>${badge(connection.state || 'disconnected')}</div><div class="settings-card"><div class="notice warning"><span><strong>Integração não oficial.</strong> O Baileys utiliza a sessão de dispositivos conectados. O WhatsApp pode alterar, limitar ou bloquear recursos. Não há garantia de obter o telefone de todo participante nem o histórico completo.</span></div><label class="checkbox-line"><input type="checkbox" id="unofficial-ack" ${settings.unofficialAcknowledged ? 'checked' : ''}><span><strong>Li e entendi as limitações da integração não oficial.</strong>O envio depende de autorização dos contatos e dos limites do serviço.</span></label><p class="description">${esc(connection.detail || 'Nenhuma sessão conectada.')}</p>${renderQr(connection)}<div class="actions">${connectionButtons(connection)}</div><p class="help">Sessão criptografada com os recursos seguros do sistema operacional. No Windows, a proteção utiliza DPAPI. A sessão não faz parte do backup comum.</p></div></section>
      <section class="panel"><div class="panel-header"><h2>Dados e recuperação</h2></div><div class="settings-card"><p class="description">O backup inclui cadastros, configurações e o controle operacional contra convites repetidos. A restauração pausa as execuções para revisão.</p><div class="actions"><button class="button" data-action="backup">Criar backup</button><button class="button secondary" data-action="restore">Restaurar backup</button></div><div class="actions"><button class="button secondary" data-action="open-data-folder">Abrir pasta dos dados</button><button class="button secondary" data-action="export-history">Exportar histórico</button></div><div class="notice info"><span>Não compartilhe a pasta da sessão ou credenciais. Mantenha uma cópia do backup em local seguro.</span></div><p class="help">Aplicativo independente. Nenhum dado, banco ou credencial do Kenned Code Disparos é utilizado.</p></div></section></div>
      <form id="settings-form"><div class="grid-2"><section class="panel"><div class="panel-header"><h2>Preferências de novos convites</h2></div><div class="settings-card"><div class="field-row"><div class="field"><label for="default-interval-value">Tempo entre envios para contatos</label><input id="default-interval-value" name="defaultIntervalValue" type="number" min="1" step="1" required value="${esc(settings.defaultIntervalValue || 30)}"></div><div class="field"><label for="default-interval-unit">Unidade</label><select id="default-interval-unit" name="defaultIntervalUnit">${option('seconds', 'Segundos', settings.defaultIntervalUnit || 'seconds')}${option('minutes', 'Minutos', settings.defaultIntervalUnit)}</select></div></div><div class="field"><label for="default-daily-limit">Limite diário padrão</label><input id="default-daily-limit" name="defaultDailyLimit" type="number" min="1" step="1" required value="${esc(settings.defaultDailyLimit || 100)}"><small>Esse valor é um limite interno configurável, não uma garantia de permissão ou segurança do WhatsApp.</small></div><p class="help">Cada campanha pode ter um intervalo diferente. O aplicativo aplica um intervalo mínimo interno e respeita restrições informadas pela integração. Os próximos contatos aguardam o intervalo completo após pausa ou reconexão.</p></div></section>
      <section class="panel"><div class="panel-header"><h2>Funcionamento no Windows</h2></div><div class="settings-card"><label class="checkbox-line"><input type="checkbox" name="minimizeToTray" ${settings.minimizeToTray !== false ? 'checked' : ''}><span><strong>Manter na bandeja ao fechar a janela</strong>O aplicativo continua em execução. Para encerrar, utilize “Encerrar aplicativo”.</span></label><label class="checkbox-line"><input type="checkbox" name="launchAtLogin" ${settings.launchAtLogin ? 'checked' : ''}><span><strong>Iniciar com o Windows</strong>Abrir o aplicativo não inicia campanhas novas nem confirma reenvios.</span></label><div class="notice"><span>O computador precisa estar ligado e sem suspensão. A fila não compensa períodos sem conexão com uma sequência de envios acumulados.</span></div></div></section></div><div class="actions"><button class="button" type="submit">Salvar configurações</button><button class="button secondary" type="button" data-action="window-minimize">Minimizar janela</button><button class="button secondary" type="button" data-action="window-quit">Encerrar aplicativo</button></div></form>
      <section class="panel space-top"><div class="panel-header"><h2>Modo de operação</h2>${snapshot.mode === 'simulated' ? badge('uncertain', 'SIMULAÇÃO') : badge('green', 'Dados reais')}</div><div class="settings-card"><div class="field"><label for="integration-mode">Ambiente separado</label><select id="integration-mode" class="input">${option('whatsapp', 'WhatsApp — grupos e contatos reais', snapshot.mode)}${option('simulated', 'Simulação — sem envios reais', snapshot.mode)}</select><small>Trocar o modo pausa as execuções e separa dados, filtros, fila e destinatários. Dados fictícios nunca preenchem a sessão real.</small></div><div class="actions"><button class="button secondary" data-action="switch-mode">Aplicar modo selecionado</button>${snapshot.mode === 'simulated' ? '<button class="button" data-action="load-simulation">Carregar dados fictícios de teste</button>' : ''}</div></div></section>`;
  }

  function openModal(kind, title, subtitle, body, footer = '') {
    state.modalKind = kind;
    $('#modal-content').innerHTML = `<div class="modal-header"><div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div><div class="modal-header-actions"><button class="button danger compact" data-action="stop-all">■ PARAR TODOS</button><button class="close-button" data-action="close-modal" aria-label="Fechar">×</button></div></div><div class="modal-body"><div id="modal-error" class="form-error" hidden></div>${body}</div>${footer ? `<div class="modal-footer">${footer}</div>` : ''}`;
    document.body.classList.add('modal-open');
    if (!$('#modal').open) $('#modal').showModal();
    setTimeout(() => $('#modal input:not([type=checkbox]):not([type=radio]), #modal textarea, #modal button')?.focus(), 0);
  }
  function closeModal() {
    if ($('#modal').open) $('#modal').close();
    state.modalKind = null; state.preview = null; document.body.classList.remove('modal-open');
  }
  function modalError(error) { const node = $('#modal-error'); if (node) { node.hidden = false; node.textContent = errorMessage(error); node.scrollIntoView({ block: 'nearest' }); } else toast(errorMessage(error), 'error'); }
  function busyModal(value) { $$('#modal button').forEach((button) => { button.disabled = value; }); }
  async function confirmDialog(title, message, buttonText = 'Confirmar', dangerous = false) {
    return new Promise((resolve) => {
      openModal('confirm', title, '', `<p class="description">${esc(message)}</p>`, `<button class="button secondary" data-confirm="cancel">Cancelar</button><button class="button${dangerous ? ' danger' : ''}" data-confirm="ok">${esc(buttonText)}</button>`);
      const handler = (event) => { const button = event.target.closest('[data-confirm]'); if (!button) return; $('#modal').removeEventListener('click', handler); closeModal(); resolve(button.dataset.confirm === 'ok'); };
      $('#modal').addEventListener('click', handler);
      $('#modal').addEventListener('close', () => { $('#modal').removeEventListener('click', handler); resolve(false); }, { once: true });
    });
  }
  async function allContacts(filter = {}) {
    const items = []; let offset = 0; let total = Infinity;
    while (offset < total) {
      const list = listResult(await rpc('listContacts', filters({ ...filter, limit: 200, offset })));
      items.push(...list.items); total = list.total;
      if (!list.items.length) break;
      offset += list.items.length;
    }
    return items;
  }
  async function editContact(id) {
    const contact = state.contacts.items.find((entry) => entry.id === id);
    if (!contact) throw new Error('Atualize a lista para revisar este contato.');
    state.editingContact = { ...contact };
    const eligibility = contactAuthorization(contact);
    openModal('contact', 'Revisar contato', 'O nome salvo não altera o nome de perfil nem a identidade do WhatsApp.', `<form id="contact-form" data-id="${esc(id)}">${!eligibility.eligible ? `<div class="notice warning space-bottom" id="contact-authorization-warning"><span><strong>Autorização indisponível.</strong> ${esc(eligibility.reason)} <small>[${esc(eligibility.code)}]</small> Você pode editar o nome e as restrições sem autorizar envios.</span></div>` : ''}<div class="field-row"><div class="field"><label for="contact-name">Nome salvo no aplicativo</label><input name="name" id="contact-name" value="${esc(contact.name || '')}" placeholder="Nome para seu cadastro"></div><div class="field"><label>Telefone disponível</label><input value="${esc(phone(contact))}" readonly><small>Identidade: ${esc(contact.externalId || contact.id)}</small></div></div><div class="notice info space-bottom"><span>Nome no WhatsApp: ${esc(contact.displayName || 'Não disponibilizado pela integração')}. Primeiro registro: ${esc(date(contact.firstSeenAt))}.</span></div><div class="form-stack"><label class="checkbox-line"><input name="authorized" id="contact-authorized" type="checkbox" ${contact.authorized ? 'checked' : ''} ${!eligibility.eligible ? 'disabled' : ''}><span><strong>Contato autorizado a receber os convites</strong>Participar do grupo, por si só, não é autorização.</span></label><div class="field"><label for="consent-note">Registro da autorização</label><textarea name="consentNote" id="consent-note" rows="2" maxlength="1000" ${!eligibility.eligible ? 'disabled' : ''} placeholder="Descreva como e quando o contato autorizou o envio">${esc(contact.consentNote || '')}</textarea></div><label class="checkbox-line"><input name="blocked" type="checkbox" ${contact.blocked ? 'checked' : ''}><span><strong>Bloquear envios para este contato</strong>Vale também para campanhas de reenvio.</span></label><label class="checkbox-line"><input name="optOut" type="checkbox" ${contact.optOut ? 'checked' : ''}><span><strong>Este contato pediu para não receber mensagens</strong>Preserva o cadastro e impede novos convites.</span></label><label class="checkbox-line"><input name="muted" type="checkbox" ${contact.muted ? 'checked' : ''}><span><strong>Silenciar temporariamente</strong>Impede o processamento das próximas mensagens.</span></label></div></form>`, '<button class="button secondary" data-action="close-modal">Cancelar</button><button class="button" data-action="save-contact">Salvar alterações</button>');
  }
  async function authorizeSelected() {
    if (!state.selectedContacts.size) return;
    const current = new Map((await allContacts()).map((contact) => [contact.id, contact]));
    current.forEach((contact, id) => state.contactCache.set(id, contact));
    const eligible = [], skipped = [];
    for (const id of state.selectedContacts) {
      const contact = current.get(id), eligibility = contactAuthorization(contact);
      if (eligibility.eligible) eligible.push(contact);
      else skipped.push({ id, name: contact ? contactName(contact) : 'Contato removido', code: eligibility.code, reason: eligibility.reason });
    }
    state.authorizationPreview = { eligible, skipped, selected: state.selectedContacts.size };
    openModal('authorize', 'Conferir autorização dos contatos', 'Selecionar contatos não envia mensagens. A elegibilidade foi conferida novamente no cadastro.', `<div class="summary-grid"><div class="summary-cell"><strong>${count(state.selectedContacts.size)}</strong><span>Contatos selecionados</span></div><div class="summary-cell"><strong>${count(eligible.length)}</strong><span>Aptos para registrar autorização</span></div><div class="summary-cell"><strong>${count(skipped.length)}</strong><span>Não serão autorizados</span></div></div>${skipped.length ? `<div class="notice warning space-top"><span><strong>${count(skipped.length)} contato(s) ficarão fora desta autorização.</strong> Nenhum telefone será inventado nem bloqueio removido.</span></div><details class="space-bottom authorization-exclusions" open><summary>Motivos por contato</summary><div class="inline-errors">${skipped.map((entry) => `<p><strong>${esc(entry.name)}</strong>: ${esc(entry.reason)} <small>[${esc(entry.code)}]</small></p>`).join('')}</div></details>` : ''}${eligible.length ? `<details class="space-top space-bottom"><summary>Conferir ${count(eligible.length)} contato(s) apto(s)</summary><div class="inline-errors">${eligible.map((contact) => `<p>${esc(contactName(contact))} · ${esc(phone(contact))}</p>`).join('')}</div></details><form id="authorize-form"><div class="field"><label for="bulk-consent">Como esses contatos autorizaram o convite?</label><textarea id="bulk-consent" name="consentNote" required minlength="3" maxlength="1000" placeholder="Descreva a origem e a data da autorização"></textarea></div><label class="checkbox-line space-top"><input type="checkbox" name="confirmed" required><span><strong>Confirmo que os ${count(eligible.length)} contatos aptos autorizaram o recebimento.</strong>A participação no grupo não substitui essa autorização.</span></label></form>` : '<div class="notice warning"><span>Nenhum contato selecionado pode ser autorizado neste momento. Revise os motivos acima e atualize os participantes quando necessário.</span></div>'}`, `<button class="button secondary" data-action="close-modal">Cancelar</button><button class="button" data-action="confirm-authorize" ${!eligible.length ? 'disabled' : ''}>Registrar autorização de ${count(eligible.length)} contato(s)</button>`);
  }
  function localDateInput(value) {
    if (!value) return '';
    const parsed = new Date(value); if (!Number.isFinite(parsed.getTime())) return '';
    const pad = (number) => String(number).padStart(2, '0');
    return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
  }
  async function editCampaign(id, template) {
    const campaign = snapshotCampaigns().find((entry) => entry.id === id) || {};
    const settings = state.snapshot.settings || {};
    const templatesResult = listResult(await rpc('listTemplates', { limit: 200 }));
    const contacts = (await allContacts()).filter((contact) => contact.authorized && contactAuthorization(contact).eligible);
    const selectedContacts = new Set(campaign.contactIds || []); const selectedGroups = new Set(campaign.groupIds || []);
    state.editorContacts = contacts; state.editorCampaign = campaign;
    const groups = snapshotGroups();
    const message = template?.message || template?.text || campaign.message || 'Olá, {nome}! 👋\nGostaria de conhecer nossa comunidade?\n{link_comunidade}';
    openModal('campaign', campaign.id ? 'Editar campanha' : 'Nova campanha', 'Salvar não inicia os envios. Você poderá conferir os destinatários e a mensagem antes de confirmar.', `<form id="campaign-form"><div class="field-row"><div class="field"><label for="campaign-name">Nome da campanha</label><input name="name" id="campaign-name" required maxlength="120" value="${esc(campaign.name || '')}" placeholder="Ex.: Convite para a comunidade"></div><div class="field"><label for="campaign-template">Usar um modelo salvo</label><select id="campaign-template">${option('', 'Selecione um modelo', '')}${templatesResult.items.map((entry) => `<option value="${esc(entry.id)}" data-message="${esc(entry.message || entry.text || '')}">${esc(entry.name)}</option>`).join('')}</select><small>A seleção copia o texto; o modelo original permanece salvo.</small></div></div><div class="field-row"><div class="field"><label for="campaign-link">Link da comunidade</label><input name="communityLink" id="campaign-link" required type="url" value="${esc(campaign.communityLink || '')}" placeholder="https://chat.whatsapp.com/..."><small>O link informado é validado e não é substituído silenciosamente.</small></div><div class="field"><label for="campaign-fallback">Nome alternativo quando indisponível</label><input name="fallbackName" id="campaign-fallback" value="${esc(campaign.fallbackName || 'tudo bem')}" placeholder="Ex.: tudo bem"></div></div><div class="field"><label for="campaign-message">Mensagem completa</label><textarea name="message" id="campaign-message" required rows="6">${esc(message)}</textarea><small>Use {nome} e {link_comunidade}. Emojis, quebras de linha e formatação são preservados.</small></div><hr class="section-divider"><h3>Quem recebe?</h3><div class="field-row"><label class="radio-card"><input type="radio" name="mode" value="new" ${campaign.mode !== 'all' ? 'checked' : ''}><span><strong>Somente novos — recomendado</strong><small>Apenas contatos autorizados que ainda não receberam. A proteção vale entre campanhas e reinicializações.</small></span></label><label class="radio-card"><input type="radio" name="mode" value="all" ${campaign.mode === 'all' ? 'checked' : ''}><span><strong>Enviar novamente aos registrados</strong><small>Inclui convidados anteriores, com confirmação explícita na prévia. Bloqueados e resultados incertos continuam protegidos.</small></span></label></div><div class="field space-bottom"><label>Grupos de origem dos contatos</label><div class="toolbar-group"><button type="button" class="button secondary compact" data-action="editor-select-groups">Selecionar todos os grupos</button><button type="button" class="button ghost compact" data-action="editor-clear-groups">Desmarcar todos</button><span class="selection-count" id="editor-group-count">${selectedGroups.size} selecionado(s)</span></div><div class="recipient-list">${groups.length ? groups.map((group) => `<label class="checkbox-line"><input type="checkbox" name="groupIds" value="${esc(group.id)}" ${selectedGroups.has(group.id) ? 'checked' : ''}><span>${esc(group.name)}</span><small>${esc(group.id)}</small></label>`).join('') : '<p class="help panel-body">Nenhum grupo carregado. Sincronize sua conta na aba Grupos.</p>'}</div></div><div class="field"><label>Seleção individual de destinatários autorizados</label><small>Sem seleção individual, serão avaliados todos os contatos elegíveis dos grupos escolhidos. Marcar alguém não remove a validação de autorização e bloqueios.</small><div class="toolbar-group"><button type="button" class="button secondary compact" data-action="editor-select-contacts">Selecionar todos os exibidos</button><button type="button" class="button ghost compact" data-action="editor-clear-contacts">Usar todos os elegíveis dos grupos</button><span class="selection-count" id="editor-contact-count">${selectedContacts.size} selecionado(s)</span></div><div class="recipient-list">${contacts.length ? contacts.map((contact) => `<label class="checkbox-line"><input type="checkbox" name="contactIds" value="${esc(contact.id)}" ${selectedContacts.has(contact.id) ? 'checked' : ''}><span>${esc(contactName(contact))}</span><small>${esc(phone(contact))}</small></label>`).join('') : '<p class="help panel-body">Ainda não existem contatos autorizados. Revise os participantes na aba Contatos.</p>'}</div></div><hr class="section-divider"><h3>Intervalo e limites</h3><div class="field-row three"><div class="field"><label for="campaign-interval">Tempo entre envios para contatos</label><input type="number" name="intervalValue" id="campaign-interval" required min="1" step="1" value="${esc(campaign.intervalValue || settings.defaultIntervalValue || 30)}"></div><div class="field"><label for="campaign-interval-unit">Unidade</label><select name="intervalUnit" id="campaign-interval-unit">${option('seconds', 'Segundos', campaign.intervalUnit || settings.defaultIntervalUnit || 'seconds')}${option('minutes', 'Minutos', campaign.intervalUnit || settings.defaultIntervalUnit)}</select></div><div class="field"><label for="campaign-execution-limit">Máximo por execução</label><input type="number" name="executionLimit" id="campaign-execution-limit" required min="1" step="1" value="${esc(campaign.executionLimit || 100)}"></div></div><div class="field-row"><div class="field"><label for="campaign-daily-limit">Máximo por dia nesta campanha</label><input type="number" name="dailyLimit" id="campaign-daily-limit" required min="1" step="1" value="${esc(campaign.dailyLimit || settings.defaultDailyLimit || 100)}"></div><div class="field"><label for="campaign-start-at">Agendar início — opcional</label><input type="datetime-local" name="startAt" id="campaign-start-at" value="${esc(localDateInput(campaign.startAt))}"><small>Data e fuso deste computador: ${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}.</small></div></div><p class="help">Aguarda o intervalo após cada tentativa antes do próximo contato. Mudanças no intervalo valem para os próximos contatos. O aplicativo aplica um intervalo mínimo interno e respeita restrições informadas pela integração.</p><hr class="section-divider"><h3>Dias e horários permitidos</h3><div class="day-options space-bottom">${['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((day, index) => `<label class="day-option"><input type="checkbox" name="days" value="${index}" ${(campaign.schedule?.days || [0, 1, 2, 3, 4, 5, 6]).includes(index) ? 'checked' : ''}><span>${day}</span></label>`).join('')}</div><div class="field-row"><div class="field"><label for="campaign-start-time">Horário de início</label><input type="time" name="startTime" id="campaign-start-time" required value="${esc(campaign.schedule?.startTime || '08:00')}"></div><div class="field"><label for="campaign-end-time">Horário de término</label><input type="time" name="endTime" id="campaign-end-time" required value="${esc(campaign.schedule?.endTime || '20:00')}"></div></div><div class="notice info"><span>A campanha não executa envios fora da janela. Após pausa, suspensão ou reconexão, os contatos aguardam sem rajadas de mensagens acumuladas.</span></div></form>`, '<button class="button secondary" data-action="close-modal">Cancelar</button><button class="button secondary" data-action="save-campaign">Salvar campanha</button><button class="button" data-action="save-and-preview">Salvar e visualizar prévia</button>');
  }
  async function saveCampaign(showPreview) {
    const form = $('#campaign-form'); if (!form.reportValidity()) return;
    const data = new FormData(form); const old = state.editorCampaign || {};
    const campaign = {
      ...old, name: data.get('name').trim(), communityLink: data.get('communityLink').trim(), fallbackName: data.get('fallbackName').trim(), message: data.get('message'), mode: data.get('mode'),
      groupIds: data.getAll('groupIds'), contactIds: data.getAll('contactIds'), intervalValue: Number(data.get('intervalValue')), intervalUnit: data.get('intervalUnit'),
      executionLimit: Number(data.get('executionLimit')), dailyLimit: Number(data.get('dailyLimit')), startAt: data.get('startAt') ? new Date(data.get('startAt')).getTime() : null,
      schedule: { days: data.getAll('days').map(Number), startTime: data.get('startTime'), endTime: data.get('endTime') },
    };
    if (!campaign.schedule.days.length) throw new Error('Selecione pelo menos um dia permitido.');
    const result = await rpc('saveCampaign', { campaign });
    const saved = result?.campaign || result;
    if (!saved?.id && !old.id) throw new Error('A gravação não retornou o identificador da campanha. Confira os dados antes de tentar novamente.');
    closeModal(); await refreshSnapshot(); toast('Campanha persistida. Nenhum novo envio foi iniciado.');
    if (showPreview) await previewCampaign(saved.id || old.id);
  }
  async function previewCampaign(id) {
    const campaign = snapshotCampaigns().find((entry) => entry.id === id); if (!campaign) throw new Error('A campanha não está na lista atual. Atualize a tela.');
    const preview = await rpc('previewCampaign', { id });
    state.preview = { ...preview, id, campaign };
    const recipients = preview.recipients || []; const excluded = preview.excluded || []; const active = ['active', 'scheduled'].includes(campaign.status);
    openModal('preview', 'Confira antes de iniciar', 'Esta prévia foi calculada pelo aplicativo com as autorizações e o histórico operacional atuais.', `<div class="summary-grid"><div class="summary-cell"><strong>${count(recipients.length)}</strong><span>Destinatários elegíveis</span></div><div class="summary-cell"><strong>${count(preview.newCount)}</strong><span>Ainda não convidados</span></div><div class="summary-cell"><strong>${count(preview.previousCount)}</strong><span>Já convidados anteriormente</span></div></div><dl class="detail-list"><dt>Campanha</dt><dd>${esc(campaign.name)}</dd><dt>Modo</dt><dd>${campaign.mode === 'all' ? 'Enviar novamente aos registrados' : 'Somente novos'}</dd><dt>Comunidade</dt><dd>${esc(campaign.communityLink)}</dd><dt>Origem</dt><dd>${(campaign.groupIds || []).map(groupName).map(esc).join(' · ') || 'Seleção individual'}</dd><dt>Intervalo</dt><dd>${esc(intervalLabel(campaign))} entre contatos</dd><dt>Tempo estimado</dt><dd>${esc(duration(preview.estimatedMs))}, sujeito à conexão e aos horários permitidos.</dd></dl><hr class="section-divider"><h3>Mensagem por destinatário</h3>${recipients.length ? `<div class="field space-bottom"><label for="preview-recipient">Destinatários que receberão</label><select id="preview-recipient">${recipients.map((contact, index) => option(index, `${contactName(contact)} · ${phone(contact)}`, 0)).join('')}</select></div><div class="preview-bubble" id="recipient-preview">${esc(recipients[0].text || recipients[0].textSnapshot || '')}</div>` : '<div class="notice warning"><span>Nenhum contato está elegível nesta execução. Confira os grupos, autorizações e convites anteriores.</span></div>'}${excluded.length ? `<h3 class="space-top">Exclusões desta prévia (${count(excluded.length)})</h3><div class="inline-errors">${excluded.map((entry) => `<p>${esc(entry.contactName || entry.name || entry.contactId || 'Contato')}: ${esc(entry.reason || entry.code || 'Não elegível')}</p>`).join('')}</div>` : ''}${campaign.mode === 'all' ? `<label class="checkbox-line space-top"><input id="confirm-repeat" type="checkbox"><span><strong>Confirmo o reenvio aos contatos elegíveis já convidados.</strong>Esta é uma nova execução. Bloqueados, silenciados e resultados incertos permanecem protegidos.</span></label>` : ''}<div class="notice info space-top"><span>Número na fila não significa mensagem enviada. Aceitação e confirmação de entrega aparecem separadamente no histórico.</span></div>`, `<button class="button secondary" data-action="close-modal">Fechar prévia</button>${!active ? `<button class="button" data-action="confirm-campaign-start" ${!recipients.length ? 'disabled' : ''}>Confirmar e ${campaign.startAt && campaign.startAt > Date.now() ? 'agendar' : 'iniciar'}</button>` : '<span class="help">Esta campanha já está em execução.</span>'}`);
    state.preview = { ...preview, id, campaign };
  }
  async function editTemplate(id) {
    let template = state.templates.find((entry) => entry.id === id);
    if (id && !template) template = listResult(await rpc('listTemplates', { limit: 200 })).items.find((entry) => entry.id === id);
    template ||= {};
    openModal('template', template.id ? 'Editar modelo' : 'Novo modelo', 'O modelo é salvo no banco local e permanece disponível após reiniciar.', `<form id="template-form" data-id="${esc(template.id || '')}"><div class="form-stack"><div class="field"><label for="template-name">Nome do modelo</label><input id="template-name" name="name" required maxlength="120" value="${esc(template.name || '')}" placeholder="Ex.: Convite de boas-vindas"></div><div class="field"><label for="template-message">Texto da mensagem</label><textarea id="template-message" name="message" required rows="8" placeholder="Olá, {nome}! Conheça nossa comunidade: {link_comunidade}">${esc(template.message || template.text || '')}</textarea><small>Formatação, emojis, links e quebras de linha são preservados. Campos disponíveis: {nome} e {link_comunidade}.</small></div></div></form>`, '<button class="button secondary" data-action="close-modal">Cancelar</button><button class="button" data-action="save-template">Salvar modelo</button>');
  }
  function historyDetails(id) {
    const job = state.history.items.find((entry) => entry.id === id); if (!job) throw new Error('O registro não está na página atual. Atualize o histórico.');
    state.detailJob = job;
    openModal('history', 'Detalhes do envio', 'Um registro operacional é preservado mesmo após limpar o histórico visual.', `<div class="space-bottom">${badge(job.status)}</div><dl class="detail-list"><dt>Operação</dt><dd class="code">${esc(job.id)}</dd><dt>Campanha / execução</dt><dd>${esc(job.campaignName || job.campaignId)} / ${esc(job.runId)}</dd><dt>Destinatário</dt><dd>${esc(job.contactName || job.phoneSnapshot || job.contactId)}</dd><dt>Criado em</dt><dd>${esc(date(job.createdAt))}</dd><dt>Última tentativa</dt><dd>${esc(date(job.startedAt || job.submittedAt))}</dd><dt>Aceito pela integração</dt><dd>${esc(date(job.acceptedAt))}</dd><dt>Entrega confirmada</dt><dd>${esc(date(job.deliveredAt))}</dd><dt>Tentativas</dt><dd>${count(job.attempts)}</dd><dt>ID da mensagem</dt><dd class="code">${esc(job.messageId || job.clientMessageId || 'Ainda não disponível')}</dd></dl>${job.error ? `<div class="error-details space-top">${esc(job.errorCode || 'ERRO')}\n${esc(job.error)}</div>` : ''}${job.textSnapshot ? `<h3 class="space-top">Mensagem registrada</h3><div class="preview-bubble">${esc(job.textSnapshot)}</div>` : ''}${job.status === 'uncertain' ? '<div class="notice warning space-top"><span>Esta mensagem pode ter sido enviada. Primeiro tente verificar o resultado. Reenvio manual pode produzir duplicidade.</span></div><label class="checkbox-line space-top"><input id="confirm-uncertain-retry" type="checkbox"><span>Entendo o risco de duplicidade e quero solicitar um reenvio manual controlado.</span></label>' : ''}`, `<button class="button secondary" data-action="close-modal">Fechar</button><button class="button secondary" data-action="copy-job-details">Copiar detalhes</button>${['uncertain', 'accepted', 'processing'].includes(job.status) ? '<button class="button secondary" data-action="reconcile-job">Verificar resultado</button>' : ''}${['uncertain', 'failed'].includes(job.status) ? '<button class="button" data-action="retry-job">Solicitar nova tentativa</button>' : ''}`);
  }
  function campaignDetails(id) {
    const campaign = snapshotCampaigns().find((entry) => entry.id === id); if (!campaign) return;
    openModal('campaign-details', campaign.name, 'Gerencie a campanha sem apagar o controle global de convites.', `<dl class="detail-list"><dt>ID</dt><dd class="code">${esc(id)}</dd><dt>Situação</dt><dd>${badge(campaign.status)}</dd><dt>Criada em</dt><dd>${esc(date(campaign.createdAt))}</dd><dt>Atualizada em</dt><dd>${esc(date(campaign.updatedAt))}</dd><dt>Limite por execução</dt><dd>${count(campaign.executionLimit)}</dd><dt>Limite diário</dt><dd>${count(campaign.dailyLimit)}</dd></dl><div class="actions space-top"><button class="button secondary" data-action="duplicate-campaign" data-id="${esc(id)}">Duplicar como rascunho</button><button class="button secondary" data-action="stop-campaign" data-id="${esc(id)}">Encerrar execução</button><button class="button danger" data-action="delete-campaign" data-id="${esc(id)}">Excluir campanha</button></div>`, '<button class="button secondary" data-action="close-modal">Fechar</button>');
  }

  const actionHandlers = {
    'stop-all': async () => { await stopAll(); },
    'reload-page': async () => { await refreshSnapshot(false); await loadPage(); },
    'close-modal': closeModal,
    'new-campaign': () => editCampaign(),
    'edit-campaign': (node) => editCampaign(node.dataset.id),
    'preview-campaign': (node) => previewCampaign(node.dataset.id),
    'save-campaign': () => saveCampaign(false),
    'save-and-preview': () => saveCampaign(true),
    'campaign-details': (node) => campaignDetails(node.dataset.id),
    'pause-campaign': (node) => perform('pauseCampaign', { id: node.dataset.id }, 'Campanha pausada. Nenhum novo contato será iniciado.'),
    'resume-campaign': async (node) => { if (await confirmDialog('Retomar fila pendente?', 'Os contatos já confirmados não serão repetidos. O intervalo, a conexão e os horários serão verificados antes do próximo envio.', 'Retomar fila')) await perform('resumeCampaign', { id: node.dataset.id }, 'Retomada solicitada; aguardando as condições de envio.'); },
    'duplicate-campaign': async (node) => { await perform('duplicateCampaign', { id: node.dataset.id }, 'Cópia persistida como rascunho.'); closeModal(); renderPage(); },
    'stop-campaign': async (node) => { const id = node.dataset.id; if (await confirmDialog('Encerrar esta execução?', 'As tarefas ainda não iniciadas serão canceladas. Um envio já submetido pode retornar depois e será registrado, sem criar outro envio.', 'Encerrar execução', true)) await perform('stopCampaign', { id }, 'Execução encerrada. Os registros anteriores foram preservados.'); },
    'delete-campaign': async (node) => { const id = node.dataset.id; if (await confirmDialog('Excluir campanha?', 'A campanha será removida ou arquivada conforme a existência de tarefas. O controle contra repetição e os resultados dos envios permanecem preservados.', 'Excluir campanha', true)) await perform('deleteCampaign', { id }, 'Exclusão concluída. A proteção contra repetição foi preservada.'); },
    'confirm-campaign-start': async () => {
      const preview = state.preview; if (!preview) throw new Error('Gere uma nova prévia antes de iniciar.');
      const confirmed = !!$('#confirm-repeat')?.checked;
      if (preview.campaign.mode === 'all' && !confirmed) throw new Error('Marque a confirmação explícita de reenvio antes de iniciar.');
      await rpc('activateCampaign', { id: preview.id, previewToken: preview.previewToken || preview.token, confirmRepeat: confirmed });
      closeModal(); await refreshSnapshot(); toast('Execução registrada. Os envios aguardam a conexão, o intervalo e a janela configurada.');
    },
    connect: async () => { await saveAcknowledgmentIfVisible(); await perform('connect', {}, 'Solicitação de conexão iniciada. Acompanhe o status da sessão.'); },
    reconnect: async () => { await saveAcknowledgmentIfVisible(); await perform('reconnect', {}, 'Reconexão solicitada. Aguarde a sessão ficar pronta.'); },
    disconnect: async () => { if (await confirmDialog('Desconectar o WhatsApp?', 'Os pendentes são preservados. A desconexão manual não deve iniciar reconexões automáticas.', 'Desconectar')) await perform('disconnect', {}, 'WhatsApp desconectado por sua solicitação.'); },
    'test-connection': async () => { const result = await rpc('testConnection'); await refreshSnapshot(); toast(result?.detail || result?.message || (result?.ready ? 'A integração confirmou a sessão pronta.' : 'Verificação concluída. Confira o status da conexão.'), result?.ready === false ? 'info' : ''); },
    'refresh-groups': async () => { await perform('refreshGroups', {}, 'Consulta aos grupos concluída. Somente grupos retornados pela integração são exibidos.'); },
    'refresh-participants': async (node) => { const result = await rpc('refreshParticipants', { groupId: node.dataset.id }); await refreshSnapshot(); const summary = result?.summary || result; toast(`Consulta concluída: ${count(summary.identified)} identificado(s), ${count(summary.newContacts)} novo(s), ${count(summary.unavailable)} sem número disponível. Nenhuma autorização foi criada.`); },
    'view-group-contacts': (node) => { state.contactGroup = node.dataset.id; state.contacts.offset = 0; location.hash = 'contatos'; if (state.page === 'contatos') return loadPage(); },
    'edit-contact': (node) => editContact(node.dataset.id),
    'save-contact': async () => {
      const form = $('#contact-form'); if (!form.reportValidity()) return;
      const data = new FormData(form), original = state.editingContact;
      if (!original || original.id !== form.dataset.id) throw new Error('Atualize o contato antes de salvar as alterações.');
      const changes = {}, name = data.get('name').trim(), authorizedInput = $('#contact-authorized');
      if (name !== (original.name || '')) changes.name = name;
      for (const key of ['blocked', 'optOut', 'muted']) if (data.has(key) !== !!original[key]) changes[key] = data.has(key);
      // Disabled permission controls are omitted: editing a name never retries an
      // authorization rejected by identity resolution or a contact restriction.
      if (!authorizedInput.disabled && authorizedInput.checked !== !!original.authorized) changes.authorized = authorizedInput.checked;
      const consentNote = String(data.get('consentNote') || '').trim();
      if (!authorizedInput.disabled && authorizedInput.checked && consentNote !== (original.consentNote || '').trim()) { changes.authorized = true; changes.consentNote = consentNote; }
      if (changes.authorized === true) { if (consentNote.length < 3) throw new Error('Descreva como o contato autorizou o envio, com pelo menos 3 caracteres.'); changes.consentNote = consentNote; }
      if (!Object.keys(changes).length) { closeModal(); toast('Nenhuma alteração foi necessária.'); return; }
      await rpc('updateContact', { id: form.dataset.id, changes }); closeModal(); await refreshSnapshot(false); await loadPage(); toast('Contato persistido. As próximas tarefas respeitarão as alterações.');
    },
    'select-filtered-contacts': async () => { const contacts = await allContacts({ search: state.contactSearch, status: state.contactStatus, groupId: state.contactGroup }); contacts.forEach((contact) => { state.selectedContacts.add(contact.id); state.contactCache.set(contact.id, contact); }); renderPage(); toast(`${count(contacts.length)} contato(s) da pesquisa selecionado(s), incluindo outras páginas. Nenhum convite foi enviado.`); },
    'clear-contact-selection': () => { state.selectedContacts.clear(); renderPage(); },
    'authorize-selected': authorizeSelected,
    'confirm-authorize': async () => {
      const form = $('#authorize-form'), preview = state.authorizationPreview;
      if (!form || !preview?.eligible.length) throw new Error('Confira os contatos aptos antes de registrar a autorização.');
      if (!form.reportValidity()) return;
      const data = new FormData(form); if (!data.has('confirmed')) throw new Error('Confirme a autorização dos contatos aptos selecionados.');
      const result = await rpc('authorizeContacts', { ids: preview.eligible.map((contact) => contact.id), authorized: true, consentNote: data.get('consentNote').trim() });
      const saved = result?.summary?.authorized ?? result?.items?.length ?? 0;
      const skipped = [...preview.skipped, ...(result?.skipped || [])];
      closeModal(); state.authorizationPreview = null; state.selectedContacts.clear(); await refreshSnapshot(false); await loadPage();
      if (skipped.length) openModal('authorization-result', 'Resultado da autorização', 'Somente os contatos elegíveis foram atualizados. Nenhum convite foi enviado.', `<div class="notice ${saved ? 'info' : 'warning'}"><span><strong>${count(saved)} autorização(ões) persistida(s).</strong> ${count(skipped.length)} contato(s) não foram autorizados.</span></div><div class="inline-errors space-top">${skipped.map((entry) => `<p><strong>${esc(entry.name || entry.id)}</strong>: ${esc(entry.reason)} <small>[${esc(entry.code)}]</small></p>`).join('')}</div>`, '<button class="button" data-action="close-modal">Entendi</button>');
      else toast(`${count(saved)} autorização(ões) persistida(s). Nenhum convite foi enviado.`);
    },
    'previous-contacts': () => { state.contacts.offset = Math.max(0, state.contacts.offset - 25); return loadPage(); },
    'next-contacts': () => { state.contacts.offset += 25; return loadPage(); },
    'previous-history': () => { state.history.offset = Math.max(0, state.history.offset - 25); return loadPage(); },
    'next-history': () => { state.history.offset += 25; return loadPage(); },
    'new-template': () => editTemplate(),
    'edit-template': (node) => editTemplate(node.dataset.id),
    'save-template': async () => { const form = $('#template-form'); if (!form.reportValidity()) return; const data = new FormData(form); await rpc('saveTemplate', { template: { ...(form.dataset.id ? { id: form.dataset.id } : {}), name: data.get('name').trim(), message: data.get('message') } }); closeModal(); await loadPage(); toast('Modelo persistido no banco local.'); },
    'duplicate-template': async (node) => { await rpc('duplicateTemplate', { id: node.dataset.id }); await loadPage(); toast('Modelo duplicado e persistido.'); },
    'delete-template': async (node) => { const id = node.dataset.id; if (await confirmDialog('Excluir modelo?', 'O modelo será removido. Os textos já copiados para campanhas permanecem preservados.', 'Excluir modelo', true)) { await rpc('deleteTemplate', { id }); await loadPage(); toast('Modelo excluído.'); } },
    'use-template': (node) => editCampaign(null, state.templates.find((template) => template.id === node.dataset.id)),
    'history-details': (node) => historyDetails(node.dataset.id),
    'copy-job-details': async () => { if (!navigator.clipboard?.writeText) throw new Error('A cópia para a área de transferência não está disponível neste ambiente.'); await navigator.clipboard.writeText(JSON.stringify(state.detailJob, null, 2)); toast('Detalhes copiados. Confira os dados antes de compartilhar.'); },
    'reconcile-job': async () => { const job = state.detailJob; const result = await rpc('reconcileJob', { id: job.jobId || job.id, jobId: job.jobId || job.id }); closeModal(); await refreshSnapshot(false); await loadPage(); toast(result?.message || 'Verificação concluída. Apenas provas disponibilizadas pela integração alteram o resultado.'); },
    'retry-job': async () => { const job = state.detailJob; const confirmPossibleDuplicate = !!$('#confirm-uncertain-retry')?.checked; if (job.status === 'uncertain' && !confirmPossibleDuplicate) throw new Error('Confirme o risco de duplicidade antes de solicitar um reenvio incerto.'); await rpc('retryJob', { id: job.jobId || job.id, jobId: job.jobId || job.id, confirmPossibleDuplicate }); closeModal(); await refreshSnapshot(false); await loadPage(); toast('Solicitação de tentativa registrada. As restrições serão verificadas novamente antes de enviar.'); },
    'export-history': async () => { const result = await rpc('exportHistory', { status: state.page === 'historico' ? state.historyStatus : '', search: state.page === 'historico' ? state.historySearch : '' }); if (!result?.cancelled && !result?.canceled) toast(result?.path ? `Arquivo criado: ${result.path}` : 'Exportação concluída pelo aplicativo.'); },
    'clear-history': async () => { openModal('clear-history', 'Limpar histórico visual', 'Fila, reservas e controle global de convites não serão apagados.', '<form id="clear-history-form"><div class="notice warning space-bottom"><span>Esta ação remove os registros da visualização do histórico. Exporte os registros antes, se precisar guardá-los. Os contatos, campanhas e a proteção contra duplicidade permanecem.</span></div><div class="field"><label for="clear-confirm">Digite APAGAR para confirmar</label><input id="clear-confirm" name="confirmation" required autocomplete="off"></div></form>', '<button class="button secondary" data-action="close-modal">Cancelar</button><button class="button secondary" data-action="export-history">Exportar antes</button><button class="button danger" data-action="confirm-clear-history">Apagar histórico visual</button>'); },
    'confirm-clear-history': async () => { const confirmation = $('#clear-confirm').value; if (confirmation !== 'APAGAR') throw new Error('Digite APAGAR exatamente para confirmar.'); await rpc('clearHistory', { confirmation }); closeModal(); state.history.offset = 0; await loadPage(); toast('Histórico visual limpo. O controle operacional foi preservado.'); },
    backup: async () => { const result = await rpc('backup'); if (!result?.cancelled && !result?.canceled) toast(result?.path ? `Backup criado: ${result.path}` : 'Backup recuperável criado pelo aplicativo.'); },
    restore: async () => { openModal('restore', 'Restaurar um backup', 'As execuções restauradas ficam pausadas para revisão.', '<form id="restore-form"><div class="notice warning space-bottom"><span>O aplicativo validará o arquivo escolhido e preservará uma cópia de recuperação. A sessão WhatsApp não é substituída pelo backup comum.</span></div><div class="field"><label for="restore-confirm">Digite RESTAURAR para confirmar</label><input id="restore-confirm" name="confirmation" required autocomplete="off"></div></form>', '<button class="button secondary" data-action="close-modal">Cancelar</button><button class="button" data-action="confirm-restore">Escolher backup e restaurar</button>'); },
    'confirm-restore': async () => { const confirmation = $('#restore-confirm').value; if (confirmation !== 'RESTAURAR') throw new Error('Digite RESTAURAR exatamente para confirmar.'); const result = await rpc('restore', { confirmation }); if (!result?.cancelled && !result?.canceled) { closeModal(); state.selectedContacts.clear(); await refreshSnapshot(false); renderPage(); toast('Restauração concluída. Revise os dados antes de retomar qualquer execução.'); } },
    'open-data-folder': () => rpc('openDataFolder'),
    'window-minimize': () => rpc('windowMinimize'),
    'window-quit': async () => { if (await confirmDialog('Encerrar aplicativo?', 'As automações deixam de funcionar enquanto o aplicativo estiver fechado. O progresso será preservado.', 'Encerrar')) await rpc('windowQuit'); },
    'switch-mode': async () => { const mode = $('#integration-mode').value; if (mode === state.snapshot.mode) { toast('Este modo já está ativo.', 'info'); return; } if (await confirmDialog('Trocar o modo de operação?', 'As execuções atuais serão pausadas. Os bancos lógicos, filtros e destinatários de simulação ficam separados dos dados reais.', 'Aplicar modo')) { await perform('saveSettings', { settings: { integrationMode: mode } }, 'Modo alterado. Nenhuma campanha foi iniciada.'); await loadPage(); } },
    'load-simulation': async () => { await perform('testSimulation', {}, 'Dados fictícios carregados somente no ambiente de simulação.'); },
    'editor-select-groups': () => setEditorChecks('groupIds', true),
    'editor-clear-groups': () => setEditorChecks('groupIds', false),
    'editor-select-contacts': () => setEditorChecks('contactIds', true),
    'editor-clear-contacts': () => setEditorChecks('contactIds', false),
  };
  function setEditorChecks(name, checked) { $$(`#campaign-form input[name="${name}"]`).forEach((input) => { input.checked = checked; }); updateEditorCounts(); }
  function updateEditorCounts() {
    if ($('#editor-group-count')) $('#editor-group-count').textContent = `${$$('#campaign-form input[name="groupIds"]:checked').length} selecionado(s)`;
    if ($('#editor-contact-count')) $('#editor-contact-count').textContent = `${$$('#campaign-form input[name="contactIds"]:checked').length} selecionado(s)`;
  }
  async function saveAcknowledgmentIfVisible() {
    const checkbox = $('#unofficial-ack');
    if (state.snapshot.mode === 'whatsapp' && !state.snapshot.settings?.unofficialAcknowledged && !checkbox?.checked) {
      if (state.page !== 'configuracoes') location.hash = 'configuracoes';
      throw new Error('Leia e confirme as limitações da integração não oficial em Configurações antes de conectar.');
    }
    if (checkbox?.checked && !state.snapshot.settings?.unofficialAcknowledged) await rpc('saveSettings', { settings: { unofficialAcknowledged: true } });
  }
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]'); if (!button || button.disabled) return;
    const handler = actionHandlers[button.dataset.action]; if (!handler) return;
    event.preventDefault();
    const inModal = !!button.closest('#modal');
    button.disabled = true;
    try { await handler(button); } catch (error) { if (inModal && $('#modal').open) modalError(error); else toast(errorMessage(error), 'error'); } finally { if (button.isConnected) button.disabled = false; }
  });
  const searchTimers = {};
  document.addEventListener('input', (event) => {
    const target = event.target;
    const searchConfig = {
      'contact-search': ['contactSearch', () => { state.contacts.offset = 0; return loadPage(); }],
      'history-search': ['historySearch', () => { state.history.offset = 0; return loadPage(); }],
      'group-search': ['groupSearch', renderPage], 'campaign-search': ['campaignSearch', renderPage],
    }[target.id];
    if (!searchConfig) return;
    state[searchConfig[0]] = target.value;
    clearTimeout(searchTimers[target.id]);
    const start = target.selectionStart; const end = target.selectionEnd; const id = target.id;
    searchTimers[id] = setTimeout(async () => { await searchConfig[1](); const replacement = $(`#${id}`); if (replacement) { replacement.focus(); replacement.setSelectionRange(start, end); } }, 300);
  });
  document.addEventListener('change', (event) => {
    const target = event.target;
    if (target.dataset.contactSelect) { target.checked ? state.selectedContacts.add(target.dataset.contactSelect) : state.selectedContacts.delete(target.dataset.contactSelect); renderPage(); }
    if (target.id === 'select-visible-contacts') { state.contacts.items.forEach((contact) => { target.checked ? state.selectedContacts.add(contact.id) : state.selectedContacts.delete(contact.id); }); renderPage(); }
    if (target.id === 'contact-group') { state.contactGroup = target.value; state.contacts.offset = 0; loadPage(); }
    if (target.id === 'contact-status') { state.contactStatus = target.value; state.contacts.offset = 0; loadPage(); }
    if (target.id === 'history-status') { state.historyStatus = target.value; state.history.offset = 0; loadPage(); }
    if (target.id === 'preview-recipient') { const contact = state.preview?.recipients?.[Number(target.value)]; $('#recipient-preview').textContent = contact?.text || contact?.textSnapshot || ''; }
    if (target.id === 'campaign-template') { const selected = target.selectedOptions[0]; if (selected?.value) $('#campaign-message').value = selected.dataset.message || ''; }
    if (['blocked', 'optOut', 'muted'].includes(target.name) && $('#contact-form')) {
      const restricted = ['blocked', 'optOut', 'muted'].some((key) => $(`#contact-form input[name="${key}"]`)?.checked);
      const authorization = $('#contact-authorized');
      authorization.disabled = restricted || !contactAuthorization(state.editingContact).eligible;
      if (restricted) authorization.checked = false;
      $('#consent-note').disabled = authorization.disabled;
    }
    if (target.name === 'groupIds' || target.name === 'contactIds') updateEditorCounts();
    if (target.id === 'unofficial-ack') rpc('saveSettings', { settings: { unofficialAcknowledged: target.checked } }).then(() => refreshSnapshot(false)).catch((error) => toast(errorMessage(error), 'error'));
  });
  document.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    try {
      if (form.id === 'settings-form') {
        if (!form.reportValidity()) return;
        const data = new FormData(form); const button = $('button[type=submit]', form); button.disabled = true;
        try { await perform('saveSettings', { settings: { defaultIntervalValue: Number(data.get('defaultIntervalValue')), defaultIntervalUnit: data.get('defaultIntervalUnit'), defaultDailyLimit: Number(data.get('defaultDailyLimit')), minimizeToTray: data.has('minimizeToTray'), launchAtLogin: data.has('launchAtLogin') } }, 'Configurações persistidas.'); } finally { if (button.isConnected) button.disabled = false; }
      } else if (form.id === 'campaign-form') await saveCampaign(false);
      else if (form.id === 'template-form') await actionHandlers['save-template']();
      else if (form.id === 'contact-form') await actionHandlers['save-contact']();
    } catch (error) { if ($('#modal').open) modalError(error); else toast(errorMessage(error), 'error'); }
  });
  $('#modal').addEventListener('close', () => { if ($('#modal').open) return; state.modalKind = null; state.preview = null; document.body.classList.remove('modal-open'); });
  async function stopAll() {
    const button = $('#stop-all'); button.disabled = true;
    try {
      const result = await rpc('stopAll'); await refreshSnapshot();
      toast(result?.inFlight || result?.processing ? 'Novos envios bloqueados e pendentes cancelados. Há um envio já iniciado; seu resultado ainda será registrado.' : 'Todos os envios automáticos foram interrompidos. Novas entradas estão bloqueadas.');
      if (state.modalKind === 'preview') closeModal();
    } catch (error) { toast(errorMessage(error), 'error'); } finally { button.disabled = false; }
  }
  $('#stop-all').addEventListener('click', stopAll);
  $('#resume-automation').addEventListener('click', async () => {
    try { if (await confirmDialog('Liberar novas automações?', 'Esta ação libera a criação de novas tarefas. Revise as campanhas e retome individualmente as filas que desejar.', 'Liberar automação')) await perform('resumeAutomation', {}, 'Automação liberada. Revise as campanhas antes de iniciar novos envios.'); } catch (error) { toast(errorMessage(error), 'error'); }
  });
  window.addEventListener('hashchange', () => {
    const page = location.hash.slice(1); state.page = pages.some(([id]) => id === page) ? page : 'painel'; closeModal(); loadPage();
  });
  async function init() {
    state.page = pages.some(([id]) => id === location.hash.slice(1)) ? location.hash.slice(1) : 'painel'; navigation();
    try {
      await refreshSnapshot(false); await loadPage();
      if (typeof bridge?.onUpdate === 'function') bridge.onUpdate((payload) => {
        if (payload?.appName && payload?.connection) acceptSnapshot(payload);
        else scheduleSnapshot();
      });
    } catch (error) { $('#main').innerHTML = `${heading('Não foi possível abrir os dados', 'Seus registros não foram substituídos por demonstrações.')}<div class="notice danger-notice"><span>${esc(errorMessage(error))}</span><button class="button secondary" data-action="reload-page">Tentar novamente</button></div>`; }
  }
  setInterval(updateClocks, 1000);
  init();
})();
