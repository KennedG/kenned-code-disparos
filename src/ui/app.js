'use strict';

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const e = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const clone = value => JSON.parse(JSON.stringify(value));
  const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const uid = () => crypto.randomUUID();
  const fmt = value => value ? new Date(value).toLocaleString('pt-BR', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : '—';
  const short = value => String(value || '').slice(0, 8);
  const names = {draft:'Rascunho',active:'Ativa',paused:'Pausada',stopped:'Encerrada',confirmed:'Confirmado',failed:'Falha',uncertain:'Incerto',queued:'Na fila',sending:'Enviando',cancelled:'Cancelado',connected:'Conectado',connecting:'Conectando',disconnected:'Desconectado',restricted:'Restrição'};
  const types = {text:'Texto',image:'Imagem',video:'Vídeo',document:'Documento'};
  const weekdays = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const icons = {
    dashboard:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    campaign:'<path d="m3 11 17-7v16L3 14z"/><path d="m6 15 1 6h4l-2-5M20 9h2m-2 5h2"/>',
    groups:'<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6m3 11v-3a6 6 0 0 0-3-5"/>',
    library:'<path d="M4 4h5v16H4zM11 4h4v16h-4zM17 5l4-1 3 15-4 1z"/>',
    history:'<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2"/>',
    settings:'<path d="m9 3-.6 2-2 .9-1.8-.6-2 3.4 1.5 1.5v2.3L2.6 14l2 3.4 1.9-.5 1.9 1L9 20h4l.6-2.1 1.9-1 1.9.5 2-3.4-1.5-1.5v-2.3l1.5-1.5-2-3.4-1.9.6-2-.9L13 3z"/><circle cx="11" cy="11.5" r="3"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',
    search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    check:'<path d="m5 12 4 4L19 6"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    send:'<path d="m3 3 19 9-19 9 4-9zM7 12h15"/>',
    link:'<path d="m9 14 6-6M8 15l-2 2a3.5 3.5 0 0 1-5-5l5-5a3.5 3.5 0 0 1 5 0m2 2 2-2a3.5 3.5 0 0 1 5 5l-5 5a3.5 3.5 0 0 1-5 0"/>',
    whatsapp:'<path d="M21 11.5a9 9 0 0 1-13.4 7.9L3 21l1.6-4.6A9 9 0 1 1 21 11.5z"/><path d="M8 7c-3 2 3 9 7 7l1-2-3-1-1 1-2-2 1-1-1-2z"/>',
    play:'<path d="m8 4 13 8-13 8z"/>',
    pause:'<path d="M7 4h3v16H7zM14 4h3v16h-3z"/>',
    edit:'<path d="m15 4 5 5M4 20l1-5L16 4a3 3 0 0 1 4 4L9 19z"/>',
    copy:'<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
    eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
    close:'<path d="m6 6 12 12M6 18 18 6"/>',
    up:'<path d="m6 15 6-6 6 6"/>',
    down:'<path d="m6 9 6 6 6-6"/>',
    text:'<path d="M4 5h16M12 5v15M8 20h8"/>',
    image:'<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="2"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
    video:'<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3"/>',
    document:'<path d="M6 3h9l4 4v14H6zM15 3v5h4M9 12h7M9 16h7"/>',
    refresh:'<path d="M20 8A8 8 0 0 0 6 4L3 7m0-5v5h5m-4 9a8 8 0 0 0 14 4l3-3m0 5v-5h-5"/>',
    shield:'<path d="m12 3 9 4v5c0 5-9 9-9 9s-9-4-9-9V7zM8 12l3 3 5-6"/>',
    moon:'<path d="M21 13A9 9 0 0 1 11 3a9 9 0 1 0 10 10z"/>',
    sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>',
    upload:'<path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/>',
    folder:'<path d="M3 6h7l2 3h9v12H3z"/>',
    stop:'<rect x="5" y="5" width="14" height="14" rx="1"/>',
  };
  const icon = name => `<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24">${icons[name] || icons.document}</svg></span>`;
  const button = (action,label,style='',id='',ico='') => `<button class="button ${style}" data-action="${e(action)}" ${id ? `data-id="${e(id)}"` : ''}>${ico ? icon(ico) : ''}${e(label)}</button>`;
  const badge = status => `<span class="badge ${e(status)}">${e(names[status] || status)}</span>`;
  const empty = (ico,title,desc,action='',label='') => `<div class="empty-state"><div class="empty-icon">${icon(ico)}</div><h3>${e(title)}</h3><p>${e(desc)}</p>${action ? button(action,label,'primary','','plus') : ''}</div>`;
  const pageTitle = (eyebrow,title,desc,action='') => `<div class="page-heading"><div><div class="eyebrow">${e(eyebrow)}</div><h1>${e(title)}</h1><p class="subtitle">${e(desc)}</p></div>${action}</div>`;
  const state = {page:'dashboard',data:null,search:'',filter:'all',libraryTab:'media',modal:null,draft:null,pending:false,refreshing:false,settingsDirty:false};

  function toast(message,error=false) {
    const div = document.createElement('div');
    div.className = `toast${error ? ' error' : ''}`;
    div.textContent = String(message);
    $('#toast-region').append(div);
    setTimeout(() => div.remove(), error ? 8500 : 5000);
  }

  async function call(action,payload) {
    if (!window.mega) throw new Error('A interface precisa ser aberta pelo aplicativo Mega Disparos.');
    const result = await window.mega.call(action,payload);
    if (result && result.error) throw new Error(typeof result.error === 'string' ? result.error : result.error.message || 'Não foi possível executar esta ação.');
    return result;
  }

  async function refresh() {
    if (state.refreshing) return;
    state.refreshing = true;
    try {
      const snapshot = await call('snapshot');
      state.data = snapshot;
      document.body.dataset.theme = snapshot.settings?.theme || 'dark';
      render();
      if (state.modal?.kind === 'connection') renderConnectionModal();
    } catch (error) { toast(error.message,true); }
    finally {state.refreshing = false;}
  }

  async function perform(action,payload,success) {
    const result = await call(action,payload);
    await refresh();
    if (success && !result?.cancelled) toast(success);
    return result;
  }

  const data = () => state.data;
  const campaigns = () => data()?.campaigns || [];
  const groups = () => data()?.groups || [];
  const media = () => data()?.media || [];
  const settings = () => data()?.settings || {};
  const campaign = id => campaigns().find(c => c.id === id);
  const group = id => groups().find(g => g.id === id);
  const mediaItem = id => media().find(m => m.id === id);
  const assetPreview = m => !m ? icon('document') : m.type==='image'&&m.previewUrl ? `<img class="asset-preview" src="${e(m.previewUrl)}" alt="${e(m.name)}" loading="lazy">` : m.type==='video'&&m.previewUrl ? `<video class="asset-preview" src="${e(m.previewUrl)}" controls preload="metadata"></video>` : icon(m.type);
  const currentMode = () => settings().integrationMode || data()?.connection?.mode || 'simulated';
  const permittedGroups = () => groups().filter(g => g.authorized && Boolean(g.simulation) === (currentMode() === 'simulated'));
  const selectedLimit = () => Math.max(1,number(settings().maxSelectedGroups,15));

  function render() {
    const d = data();
    if (!d) return;
    const nav = [['dashboard','Painel','dashboard'],['campaigns','Campanhas','campaign'],['groups','Grupos','groups'],['library','Biblioteca','library'],['history','Histórico','history'],['settings','Configurações','settings']];
    $('#navigation').innerHTML = nav.map(([key,label,ico]) => `<button class="nav-item${state.page===key?' active':''}" data-action="navigate" data-id="${key}" ${state.page===key?'aria-current="page"':''}><span class="nav-icon"><svg viewBox="0 0 24 24">${icons[ico]}</svg></span><span>${label}</span>${key==='campaigns' ? `<span class="nav-count">${campaigns().length}</span>` : ''}</button>`).join('');
    const conn = d.connection || {state:'disconnected'};
    $('#connection-pill').innerHTML = `<span class="status-dot ${e(conn.state)}"></span>${e(names[conn.state] || conn.state)}${d.storageError?' · Envios bloqueados: armazenamento':''}${d.maintenance?' · Atualizando dados…':''} <span class="muted">· ${currentMode()==='simulated'?'Simulação local':'WhatsApp · não oficial'}</span>`;
    $('#theme-toggle').innerHTML = icon(document.body.dataset.theme==='dark'?'sun':'moon');
    $('#version').textContent = d.version || '1.0';
    const renderers = {dashboard:renderDashboard,campaigns:renderCampaigns,groups:renderGroups,library:renderLibrary,history:renderHistory,settings:renderSettings};
    if (state.page==='settings' && state.settingsDirty && $('#settings-form')) return;
    const focused=document.activeElement?.id;
    const selection=focused==='page-search'?document.activeElement.selectionStart:null;
    $('#main').innerHTML = renderers[state.page]();
    if(focused==='page-search' && $('#page-search')){$('#page-search').focus();$('#page-search').setSelectionRange(selection,selection);}
  }

  function connectionCard() {
    const conn = data().connection || {};
    return `<div class="connection-card"><div class="connection-info"><div class="whatsapp-symbol">${icon('whatsapp')}</div><div class="connection-detail"><h2>${currentMode()==='simulated'?'Ambiente de simulação':'Sua conexão com o WhatsApp'} ${badge(conn.state||'disconnected')}</h2><p>${e(conn.detail || (currentMode()==='simulated'?'Teste campanhas com grupos fictícios. Nenhuma mensagem real é enviada.':'Conecte pelo QR code e carregue seus grupos.'))}</p></div></div><div class="row-actions">${button('connection',conn.state==='connected'?'Gerenciar conexão':'Conectar','small','','link')}</div></div>`;
  }

  function campaignTable(list,compact=false) {
    if (!list.length) return empty('campaign','Sua próxima campanha começa aqui','Crie uma sequência, selecione seus grupos e revise a programação antes de ativar.','new-campaign','Criar campanha');
    return `<div class="table-scroll"><table><thead><tr><th>CAMPANHA</th><th>STATUS</th><th>DESTINOS</th><th>FREQUÊNCIA</th>${compact?'':'<th>PRÓXIMA RODADA</th>'}<th>AÇÕES</th></tr></thead><tbody>${list.map(c => `<tr><td><span class="table-name">${e(c.name)}</span><span class="table-subtitle">${e(short(c.id))} · ${(c.items||[]).length} conteúdo(s) · ${c.mode==='rotate'?'Alternar sequência':'Repetir conjunto'}</span></td><td>${badge(c.state)}</td><td>${(c.groupIds||[]).length} grupos</td><td>${e(c.intervalMinutes)} min<span class="table-subtitle">${e(c.spacingSeconds)}s entre grupos</span></td>${compact?'':`<td>${e(fmt(c.nextRunAt))}</td>`}<td><div class="row-actions">${button('preview','Prévia','small ghost',c.id,'eye')}${c.state==='active'?button('pause','Pausar','small',c.id,'pause'):button(c.state==='paused'?'resume':'activate',c.state==='paused'?'Retomar':'Ativar','small primary',c.id,'play')}${compact?'':button('edit-campaign','Editar','small ghost',c.id,'edit')}</div></td></tr>`).join('')}</tbody></table></div>`;
  }

  function renderDashboard() {
    const m = data().metrics || {};
    const metrics = [['Campanhas ativas',m.activeCampaigns??campaigns().filter(c=>c.state==='active').length,'Programação em execução','campaign'],['Grupos selecionados',m.selectedGroups??new Set(campaigns().flatMap(c=>c.groupIds||[])).size,'Destinos nas campanhas','groups'],['Envios confirmados',m.confirmed||0,'Confirmação do servidor','check'],['Próxima rodada',m.nextRunAt?new Date(m.nextRunAt).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}):'—',m.nextRunAt?fmt(m.nextRunAt):'Ative uma campanha para começar','clock']];
    return pageTitle('Visão geral','Tudo sob controle','Suas campanhas, seus grupos e cada envio em um só lugar.',button('new-campaign','Nova campanha','primary','','plus')) + connectionCard() +
      `<div class="stats-grid">${metrics.map(([label,value,caption,ico])=>`<div class="stat-card"><div class="stat-top">${e(label)}<span class="stat-icon">${icon(ico)}</span></div><div class="stat-value">${e(value)}</div><div class="stat-caption">${e(caption)}</div></div>`).join('')}</div>` +
      `<div class="panel"><div class="panel-header"><div><h2>Suas campanhas</h2><p>Uma fila sequencial. Cada rodada passa por todos os destinos selecionados.</p></div><button class="text-button" data-action="navigate" data-id="campaigns">Ver todas →</button></div>${campaignTable(campaigns().slice(0,5),true)}</div>` +
      `<div class="two-column"><div class="panel"><div class="panel-header"><h2>Como suas rodadas funcionam</h2>${icon('clock')}</div><div class="panel-body"><div class="flow-item"><span class="flow-number">01</span><div>O intervalo é medido entre o início das rodadas<small>Por padrão, uma rodada a cada 10 minutos.</small></div></div><div class="flow-item"><span class="flow-number">02</span><div>Os grupos recebem o conteúdo em sequência<small>O espaçamento entre grupos é uma configuração separada.</small></div></div><div class="flow-item"><span class="flow-number">03</span><div>Uma rodada termina antes da próxima começar<small>Não há rodadas simultâneas nem acúmulo após suspensão.</small></div></div></div></div><div class="panel"><div class="panel-header"><h2>Acompanhamento</h2>${icon('shield')}</div><div class="panel-body"><div class="status-list"><div class="status-line">${icon('check')}<div>${number(m.confirmed)} envios confirmados<small>Confirmação de aceitação pelo servidor; não indica leitura.</small></div></div><div class="status-line">${icon('history')}<div>${number(m.failed)} falhas · ${number(m.uncertain)} resultados incertos<small>Resultados incertos aguardam revisão e não são reenviados.</small></div></div><div class="status-line">${icon('folder')}<div>Campanhas e arquivos armazenados localmente<small>Faça backups em Configurações.</small></div></div></div></div></div></div>`;
  }

  function renderCampaigns() {
    const list = campaigns().filter(c => (state.filter==='all'||c.state===state.filter) && `${c.name} ${c.id}`.toLowerCase().includes(state.search.toLowerCase()));
    return pageTitle('Organize seus envios','Campanhas','Crie, revise e programe conteúdos. Uma nova campanha sempre começa desativada.',button('new-campaign','Nova campanha','primary','','plus')) +
      `<div class="toolbar">${searchInput('Buscar por nome ou identificador')}<select class="filter-select" id="campaign-filter" aria-label="Filtrar campanhas"><option value="all">Todas as campanhas</option>${['active','draft','paused','stopped'].map(s=>`<option value="${s}"${state.filter===s?' selected':''}>${names[s]}</option>`).join('')}</select></div><div class="panel">${campaignTable(list)}</div>` +
      `<div class="soft-text">Dica: abra uma campanha para duplicá-la ou salvar seu conjunto de conteúdos como modelo.</div>`;
  }

  function searchInput(placeholder) {return `<div class="search-input">${icon('search')}<input id="page-search" type="text" placeholder="${e(placeholder)}" aria-label="${e(placeholder)}" value="${e(state.search)}"></div>`;}

  function renderGroups() {
    const list = groups().filter(g=> `${g.name} ${g.id}`.toLowerCase().includes(state.search.toLowerCase()));
    return pageTitle('Seus destinos','Grupos','Autorize somente os grupos nos quais você tem permissão para publicar.',button('refresh-groups','Atualizar grupos','','','refresh')) +
      `<div class="toolbar">${searchInput('Buscar grupo por nome ou identificador')}<span class="count-label">${permittedGroups().length} autorizados · limite atual: ${selectedLimit()} por campanha</span></div><div class="info-note">${currentMode()==='simulated'?'Os grupos desta conexão são fictícios e servem para testar a programação.':'Os grupos são carregados da sua conta conectada. A autorização abaixo é uma declaração sua de permissão para publicar.'} A seleção de destinos é feita dentro de cada campanha.</div>` +
      (list.length ? `<div class="group-grid">${list.map(g=>`<article class="group-card"><div class="group-avatar">${icon('groups')}</div><div class="group-card-content"><h3>${e(g.name)} ${g.simulation?'<span class="simulation-tag">SIMULADO</span>':''}</h3><p class="group-card-id">${e(g.id)}</p><label class="check-label"><input type="checkbox" data-authorize-group="${e(g.id)}" ${g.authorized?'checked':''}> Tenho autorização para publicar</label></div></article>`).join('')}</div>` : `<div class="panel">${empty('groups','Nenhum grupo encontrado','Conecte a conta e clique em Atualizar grupos. No modo simulado, os grupos de teste são carregados ao conectar.')}</div>`);
  }

  function sizeText(bytes) {return bytes>=1024*1024 ? `${(bytes/1024/1024).toFixed(1)} MB` : `${Math.ceil((bytes||0)/1024)} KB`;}
  function renderLibrary() {
    const templates = data().templates || [];
    const assets = media().filter(m=>m.name.toLowerCase().includes(state.search.toLowerCase()));
    const models = templates.filter(t=>t.name.toLowerCase().includes(state.search.toLowerCase()));
    let content;
    if (state.libraryTab==='media') content = assets.length ? `<div class="library-grid">${assets.map(m=>`<article class="library-card"><div class="library-art">${assetPreview(m)}</div><div class="library-details"><h3>${e(m.name)}</h3><p>${e(types[m.type]||m.type)} · ${e(sizeText(m.size))}</p><span class="badge">Cópia gerenciada</span></div></article>`).join('')}</div>` : `<div class="panel">${empty('library','Sua biblioteca está pronta','Importe imagens, vídeos e documentos. Uma cópia permanece no aplicativo mesmo se o arquivo original for movido.','import-media','Importar arquivos')}</div>`;
    else content = models.length ? `<div class="library-grid">${models.map(t=>`<article class="library-card"><div class="library-art">${icon('text')}<span>${(t.items||[]).length} conteúdo(s)</span></div><div class="library-details"><h3>${e(t.name)}</h3><p>Conjunto salvo para reutilizar</p><div class="library-text">${e((t.items||[]).map(i=>i.text||i.caption||mediaItem(i.mediaId)?.name||types[i.type]).join('\n')).slice(0,300)}</div><div class="row-actions" style="margin-top:15px">${button('use-template','Criar campanha','small primary',t.id,'plus')}${button('delete-template','Excluir','small ghost',t.id,'trash')}</div></div></article>`).join('')}</div>` : `<div class="panel">${empty('library','Nenhum modelo salvo','No editor da campanha, use Salvar modelo para guardar textos, mídias e a ordem de envio.')}</div>`;
    return pageTitle('Conteúdo sempre à mão','Biblioteca','Textos e arquivos organizados para suas próximas campanhas.',button('import-media','Importar arquivos','primary','','upload')) + `<div class="toolbar"><div class="tabs"><button class="tab ${state.libraryTab==='media'?'active':''}" data-action="library-tab" data-id="media">Mídias (${media().length})</button><button class="tab ${state.libraryTab==='templates'?'active':''}" data-action="library-tab" data-id="templates">Modelos (${templates.length})</button></div>${searchInput('Buscar na biblioteca')}</div>` + content;
  }

  function renderHistory() {
    const jobs = (data().history||[]).filter(j=>(state.filter==='all'||j.status===state.filter) && `${campaign(j.campaignId)?.name||j.campaignId} ${group(j.groupId)?.name||j.groupId} ${j.error||''}`.toLowerCase().includes(state.search.toLowerCase()));
    return pageTitle('Resultados com transparência','Histórico','Acompanhe confirmações, falhas e envios que precisam de revisão.') +
      `<div class="toolbar">${searchInput('Buscar por campanha, grupo ou falha')}<select class="filter-select" id="history-filter" aria-label="Filtrar resultados"><option value="all">Todos os resultados</option>${['confirmed','failed','uncertain','queued','sending','cancelled'].map(s=>`<option value="${s}"${state.filter===s?' selected':''}>${names[s]}</option>`).join('')}</select></div>` +
      ((data().history||[]).some(j=>j.status==='uncertain')?'<div class="warning-note">Um resultado incerto pode ter sido enviado. Verifique a conversa no WhatsApp e marque como confirmado ou descarte o registro. Ele não será reenviado automaticamente.</div>':'') +
      `<div class="panel">${jobs.length?`<div class="table-scroll"><table><thead><tr><th>HORÁRIO</th><th>CAMPANHA / GRUPO</th><th>CONTEÚDO</th><th>RESULTADO</th><th>DETALHES</th></tr></thead><tbody>${jobs.map(j=>`<tr><td>${e(fmt(j.resultAt||j.createdAt))}</td><td><span class="table-name">${e(campaign(j.campaignId)?.name||short(j.campaignId))}</span><span class="table-subtitle">${e(group(j.groupId)?.name||j.groupId)}</span></td><td><span class="table-name">${e(types[j.itemSnapshot?.type]||'Conteúdo')}</span><span class="table-subtitle">${e((j.itemSnapshot?.text||j.itemSnapshot?.caption||mediaItem(j.itemSnapshot?.mediaId)?.name||'').slice(0,65))}</span></td><td>${badge(j.status)}</td><td><div class="history-note">${e(j.error||j.messageId||'—')}</div>${j.status==='uncertain'?`<div class="row-actions" style="margin-top:8px">${button('confirm-job','Confirmado','small',j.id,'check')}${button('discard-job','Descartar','small ghost',j.id,'close')}</div>`:''}</td></tr>`).join('')}</tbody></table></div>`:empty('history','Nenhum envio nesta seleção','Ative uma campanha simulada para validar a fila e acompanhar os resultados.')}</div>`;
  }

  function renderSettings() {
    const s = settings();
    return pageTitle('Do seu jeito','Configurações','Conexão, controle pelo WhatsApp e dados protegidos neste computador.') +
      `<form id="settings-form"><div class="settings-grid"><div><div class="panel"><div class="panel-header"><h2>Conexão e integração</h2>${icon('whatsapp')}</div><div class="panel-body"><div class="field"><label for="integration-mode">Modo de operação</label><select id="integration-mode" name="integrationMode"><option value="simulated"${currentMode()==='simulated'?' selected':''}>Simulação — sem envios reais</option><option value="whatsapp"${currentMode()==='whatsapp'?' selected':''}>WhatsApp Web — integração não oficial</option></select></div><div class="warning-note">A integração WhatsApp Web é não oficial. Ela permite usar grupos da conta, mas pode mudar, desconectar ou sofrer restrições. A integração oficial da Meta exige elegibilidade específica para grupos e não oferece acesso geral aos seus grupos existentes.</div><label class="check-label"><input name="unofficialAcknowledged" type="checkbox"${s.unofficialAcknowledged?' checked':''}> Entendo as limitações da integração não oficial e tenho autorização para usar os grupos selecionados.</label><div class="subtle-divider"></div>${button('connection','Abrir conexão','','','link')}<p class="soft-text">Mudanças do modo são aplicadas após salvar. Reconecte e revise os destinos das campanhas.</p></div></div><div class="panel"><div class="panel-header"><h2>Administradores autorizados</h2>${icon('shield')}</div><div class="panel-body"><div class="field"><label for="admin-numbers">Números com código do país e DDD</label><textarea id="admin-numbers" name="admins" placeholder="5511999999999&#10;5521988888888">${e((s.admins||[]).join('\n'))}</textarea><span class="field-hint">Um número por linha. O remetente é validado pela conexão; textos que citam números não concedem permissão.</span></div><div class="info-note">Comandos somente em conversa direta autorizada. Mensagens de grupos, encaminhadas, enviadas pela própria conta e remetentes não verificados são ignorados.</div><div class="settings-command"><code>!mega ajuda</code> · lista os comandos<br><code>!mega menu</code> · configuração por opções numeradas<br><code>!mega status</code> · conexão e próximos envios<br><code>!mega parar tudo</code> · interrompe as campanhas</div></div></div></div><div><div class="panel"><div class="panel-header"><h2>Preferências do aplicativo</h2>${icon('settings')}</div><div class="panel-body"><div class="field-grid"><div class="field"><label for="theme">Aparência</label><select name="theme" id="theme"><option value="dark"${(s.theme||'dark')==='dark'?' selected':''}>Tema escuro</option><option value="light"${s.theme==='light'?' selected':''}>Tema claro</option></select></div><div class="field"><label for="group-limit">Limite de grupos por campanha</label><input id="group-limit" name="maxSelectedGroups" type="number" min="1" max="1000" required value="${e(selectedLimit())}"><span class="field-hint">Padrão de 15 grupos. Ajustável.</span></div><div class="field field-full"><label for="close-behavior">Ao fechar a janela</label><select id="close-behavior" name="closeBehavior"><option value="ask"${s.closeBehavior==='ask'?' selected':''}>Perguntar: minimizar ou encerrar</option><option value="tray"${s.closeBehavior==='tray'?' selected':''}>Minimizar para a bandeja e continuar</option><option value="quit"${s.closeBehavior==='quit'?' selected':''}>Encerrar o aplicativo e interromper envios</option></select></div></div><label class="check-label"><input name="launchAtLogin" type="checkbox"${s.launchAtLogin?' checked':''}> Iniciar com o Windows</label><p class="soft-text">Os agendamentos usam o fuso horário deste computador. Mantenha-o ligado, com internet e sem suspensão durante os envios.</p></div></div><div class="panel"><div class="panel-header"><h2>Backup e armazenamento</h2>${icon('folder')}</div><div class="panel-body"><p class="soft-text">O backup inclui campanhas, configurações e cópias das mídias. Credenciais de conexão ficam fora do backup comum.</p><div class="settings-actions">${button('backup','Criar backup','','','upload')}${button('restore','Restaurar backup','','','history')}${button('open-data','Abrir pasta de dados','ghost','','folder')}</div><div class="subtle-divider"></div><span class="field-hint">Local dos dados</span><p class="soft-text" style="word-break:break-all">${e(data().dataDir||'Pasta local do aplicativo')}</p></div></div>${currentMode()==='simulated'?`<div class="panel"><div class="panel-header"><h2>Validar comandos na simulação</h2></div><div class="panel-body"><p class="soft-text">Teste autorização, status e o menu antes de conectar a conta real.</p>${button('simulation-command','Enviar comando simulado','','','text')}</div></div>`:''}</div></div><div class="settings-savebar"><button class="button primary" type="submit">${icon('check')} Salvar configurações</button></div></form>`;
  }

  function showModal(kind,title,subtitle,body,footer,compact=false) {
    state.modal = {...state.modal,kind};
    $('#modal-root').innerHTML = `<div class="modal-backdrop"><section class="modal${compact?' compact':''}" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header class="modal-header"><div class="modal-title"><h2 id="modal-title">${e(title)}</h2>${subtitle?`<p>${e(subtitle)}</p>`:''}</div><button class="icon-button" data-action="close-modal" aria-label="Fechar">${icon('close')}</button></header><div class="modal-body">${body}</div>${footer?`<footer class="modal-footer">${footer}</footer>`:''}</section></div>`;
    if (!state.modal.previousFocus) state.modal.previousFocus = document.activeElement;
    requestAnimationFrame(()=>$('.modal input, .modal textarea, .modal button')?.focus());
  }

  function closeModal() {
    const previous = state.modal?.previousFocus;
    state.modal = null;
    state.draft = null;
    $('#modal-root').innerHTML = '';
    if (previous?.isConnected) previous.focus();
  }

  function defaultCampaign() {
    return {id:uid(),name:'',state:'draft',mode:'repeat',intervalMinutes:10,spacingSeconds:5,schedule:{days:[1,2,3,4,5],startTime:'08:00',endTime:'18:00',startDate:'',endDate:''},dailyRoundLimit:0,dailySendLimit:0,groupIds:[],items:[],groupOverrides:{},revision:0,configRevision:0};
  }

  function editCampaign(id,template) {
    state.draft = id ? clone(campaign(id)) : defaultCampaign();
    if (!state.draft) throw new Error('Campanha não encontrada.');
    if (template) {state.draft.items = clone(template.items||[]).map(item=>({...item,id:uid()}));state.draft.name = template.name;}
    state.modal = {kind:'editor',previousFocus:document.activeElement};
    renderCampaignEditor();
  }

  function scheduleFields(schedule,prefix='') {
    const s = {...{days:[0,1,2,3,4,5,6],startTime:'08:00',endTime:'18:00',startDate:'',endDate:''},...schedule};
    return `<div class="field-grid"><div class="field field-full"><label>Dias da semana</label><div class="weekdays">${weekdays.map((day,index)=>`<label class="day-chip"><input type="checkbox" name="${e(prefix)}days" value="${index}"${s.days.includes(index)?' checked':''}><span>${day}</span></label>`).join('')}</div></div><div class="field"><label>Início do horário</label><input type="time" name="${e(prefix)}startTime" value="${e(s.startTime)}" required></div><div class="field"><label>Fim do horário</label><input type="time" name="${e(prefix)}endTime" value="${e(s.endTime)}" required></div><div class="field"><label>Data de início <span class="muted">(opcional)</span></label><input type="date" name="${e(prefix)}startDate" value="${e(s.startDate)}"></div><div class="field"><label>Data de encerramento <span class="muted">(opcional)</span></label><input type="date" name="${e(prefix)}endDate" value="${e(s.endDate)}"></div></div>`;
  }

  function itemEditor(item,index,scope='campaign',groupId='') {
    const m = mediaItem(item.mediaId);
    const attrs = `data-scope="${e(scope)}" data-group="${e(groupId)}" data-index="${index}"`;
    return `<div class="content-item" data-item-index="${index}" ${attrs}><div class="content-item-top"><span class="content-item-label">${icon(item.type)} ${index+1}. ${e(types[item.type]||'Conteúdo')}</span><div class="item-actions"><button class="icon-button" data-action="item-up" ${attrs} title="Mover para cima" aria-label="Mover conteúdo para cima"${index===0?' disabled':''}>${icon('up')}</button><button class="icon-button" data-action="item-down" ${attrs} title="Mover para baixo" aria-label="Mover conteúdo para baixo">${icon('down')}</button><button class="icon-button danger-color" data-action="item-remove" ${attrs} title="Remover conteúdo" aria-label="Remover conteúdo">${icon('trash')}</button></div></div>${item.type==='text'?`<label class="field-hint">Texto da mensagem</label><textarea data-item-field="text" ${attrs} placeholder="Escreva sua mensagem. Emojis, links e quebras de linha são aceitos.">${e(item.text)}</textarea>`:`<div class="content-item-name">${e(m?.name||'Mídia não encontrada — importe novamente')}</div><label class="field-hint">Legenda (opcional)</label><textarea data-item-field="caption" ${attrs} placeholder="Adicione uma legenda para esta mídia…">${e(item.caption)}</textarea>`}</div>`;
  }

  function renderCampaignEditor() {
    const c = state.draft;
    const active = c.state==='active';
    const body = `${active?'<div class="warning-note">Esta campanha está em execução. Alterações de conteúdo e destinos exigem resumo e confirmação antes de salvar.</div>':''}<form id="campaign-form"><div class="form-section"><div class="section-heading"><h3><span class="section-index">01</span>Identificação</h3>${badge(c.state)}</div><div class="field"><label for="campaign-name">Nome da campanha</label><input type="text" name="name" id="campaign-name" required maxlength="140" placeholder="Ex.: Avisos da comunidade" value="${e(c.name)}"></div></div><div class="form-section"><div class="section-heading"><h3><span class="section-index">02</span>Conteúdo e ordem de envio</h3><button class="text-button" data-action="save-template">Salvar modelo</button></div><div class="field-grid"><div class="field field-full"><label for="content-mode">Modo de conteúdo</label><select name="mode" id="content-mode"><option value="repeat"${c.mode==='repeat'?' selected':''}>Repetir todo o conjunto em cada rodada</option><option value="rotate"${c.mode==='rotate'?' selected':''}>Alternar: próximo item da sequência a cada rodada</option></select><span class="field-hint">No modo alternado, cada grupo recebe o próximo item da sequência quando participa de uma rodada. Intervalos individuais podem deixar os grupos em posições diferentes.</span></div></div>${c.items.length?c.items.map((item,index)=>itemEditor(item,index)).join(''):'<p class="soft-text">Sua sequência ainda está vazia. Adicione textos ou arquivos abaixo.</p>'}<div class="content-add">${button('add-text','Adicionar texto','small','','plus')}${button('add-media','Escolher mídia da biblioteca','small','','library')}${button('import-editor-media','Importar arquivos','small ghost','','upload')}</div><p class="field-hint" style="margin-bottom:0">Formatação WhatsApp: *negrito*, _itálico_, ~tachado~ e blocos de código. Arquivos importados são copiados para a pasta gerenciada.</p></div><div class="form-section"><div class="section-heading"><h3><span class="section-index">03</span>Grupos de destino</h3><span class="count-label" id="selected-count">${c.groupIds.length} / ${selectedLimit()} selecionados</span></div><div class="search-input" style="max-width:none;margin-bottom:13px">${icon('search')}<input type="text" id="editor-group-search" placeholder="Buscar entre os grupos autorizados…" aria-label="Buscar grupos autorizados"></div><div id="editor-group-options">${editorGroups('')}</div>${permittedGroups().length?'':'<p class="field-hint">Nenhum grupo autorizado nesta integração. Vá para Grupos e declare a autorização antes de selecionar destinos.</p>'}</div><div class="form-section"><div class="section-heading"><h3><span class="section-index">04</span>Frequência e limites</h3></div><div class="field-grid"><div class="field"><label for="round-interval">Intervalo entre o início das rodadas (minutos)</label><input id="round-interval" name="intervalMinutes" type="number" min="1" max="10080" required value="${e(c.intervalMinutes)}"><span class="field-hint">Padrão: 10 minutos. Se a rodada atrasar, não acumula outra.</span></div><div class="field"><label for="group-spacing">Espaçamento entre grupos (segundos)</label><input id="group-spacing" name="spacingSeconds" type="number" min="3" max="3600" required value="${e(c.spacingSeconds)}"><span class="field-hint">A integração pode exigir um espaçamento mínimo maior.</span></div><div class="field"><label for="round-limit">Máximo de rodadas por dia</label><input id="round-limit" name="dailyRoundLimit" type="number" min="0" max="10000" value="${e(c.dailyRoundLimit||0)}"><span class="field-hint">0 = sem limite adicional.</span></div><div class="field"><label for="send-limit">Máximo de envios por dia</label><input id="send-limit" name="dailySendLimit" type="number" min="0" max="100000" value="${e(c.dailySendLimit||0)}"><span class="field-hint">Cada mensagem ou mídia para um grupo conta como um envio.</span></div></div></div><div class="form-section"><div class="section-heading"><h3><span class="section-index">05</span>Dias e horário de funcionamento</h3></div>${scheduleFields(c.schedule)}<span class="field-hint">Fuso horário local do Windows. Horários que atravessam meia-noite dependem da validação do agendador.</span></div><div class="form-section"><div class="section-heading"><h3><span class="section-index">06</span>Configurações específicas por grupo</h3></div><p class="soft-text">Opcional: configure conteúdo, intervalo e horário distintos para os grupos selecionados.</p><div id="editor-overrides">${overrideCards()}</div></div></form>`;
    showModal('editor',campaign(c.id)?'Editar campanha':'Nova campanha','Organize o conteúdo, escolha os destinos e defina a programação.',body,`<span class="soft-text">${active?'A campanha ativa requer confirmação das alterações.':'Salvar não inicia envios. Revise e ative quando estiver pronto.'}</span><div class="modal-footer-actions">${campaign(c.id)?button('duplicate','Duplicar','ghost',c.id,'copy'):''}${campaign(c.id)?button('delete-campaign','Excluir','danger',c.id,'trash'):''}${button('editor-preview','Prévia','','','eye')}${button('save-campaign','Salvar campanha','primary','','check')}</div>`);
  }

  function editorGroups(search) {
    const c = state.draft;
    return `<div class="editor-group-list">${permittedGroups().filter(g=>`${g.name} ${g.id}`.toLowerCase().includes(search.toLowerCase())).map(g=>`<label class="editor-group${c.groupIds.includes(g.id)?' selected':''}"><input type="checkbox" data-select-group="${e(g.id)}"${c.groupIds.includes(g.id)?' checked':''}><span>${e(g.name)} ${g.simulation?'<span class="simulation-tag">SIMULADO</span>':''}</span></label>`).join('')}</div>`;
  }

  function overrideCards() {
    const c = state.draft;
    return c.groupIds.map(id=>{
      const o = c.groupOverrides?.[id] || {};
      const enabled = Boolean(o.enabled);
      return `<details class="override-card" data-override-card="${e(id)}"><summary>${e(group(id)?.name||id)} ${enabled?'<span class="badge active">Específico</span>':'<span class="badge">Herda campanha</span>'}</summary><div class="override-body"><label class="check-label override-toggle"><input type="checkbox" data-override-enabled="${e(id)}"${enabled?' checked':''}> Habilitar configurações específicas deste grupo</label><div data-override-fields="${e(id)}"${enabled?'':' class="editor-hidden"'}><div class="field-grid"><div class="field"><label>Intervalo do grupo (minutos)</label><input type="number" min="1" max="10080" data-override-interval="${e(id)}" value="${e(o.intervalMinutes||c.intervalMinutes)}"></div></div><div data-override-schedule="${e(id)}">${scheduleFields(o.schedule||c.schedule,`group-${id}-`)}</div><div class="subtle-divider"></div><label class="check-label"><input type="checkbox" data-override-custom="${e(id)}"${o.items?.length?' checked':''}> Usar conteúdo específico para este grupo</label><div data-override-content="${e(id)}"${o.items?.length?'':' class="editor-hidden"'} style="margin-top:15px">${(o.items||[]).map((item,index)=>itemEditor(item,index,'override',id)).join('')}<div class="content-add"><button class="button small" data-action="override-add-text" data-group="${e(id)}">${icon('plus')} Adicionar texto</button><button class="button small" data-action="override-add-media" data-group="${e(id)}">${icon('library')} Escolher mídia</button></div></div></div></div></details>`;
    }).join('') || '<span class="field-hint">Selecione os destinos para habilitar configurações individuais.</span>';
  }

  function readSchedule(root,prefix='') {
    const byName = name => $$('[name]',root).find(el=>el.name===prefix+name);
    return {days:$$('input[type=checkbox]:checked',root).filter(el=>el.name===prefix+'days').map(el=>number(el.value)),startTime:byName('startTime')?.value||'08:00',endTime:byName('endTime')?.value||'18:00',startDate:byName('startDate')?.value||'',endDate:byName('endDate')?.value||''};
  }

  function collectEditor() {
    const form = $('#campaign-form');
    if (!form || !state.draft) return;
    const c = state.draft;
    const get = name => form.elements.namedItem(name)?.value;
    for (const key of ['name','mode']) c[key] = get(key);
    for (const key of ['intervalMinutes','spacingSeconds','dailyRoundLimit','dailySendLimit']) c[key] = number(get(key));
    c.schedule = readSchedule(form);
    for (const el of $$('[data-item-field]',form)) {
      const list = el.dataset.scope==='override' ? c.groupOverrides?.[el.dataset.group]?.items : c.items;
      if (list?.[number(el.dataset.index)]) list[number(el.dataset.index)][el.dataset.itemField] = el.value;
    }
    c.groupOverrides ||= {};
    for (const card of $$('[data-override-card]',form)) {
      const id = card.dataset.overrideCard;
      const enabled = $('[data-override-enabled]',card).checked;
      const custom = $('[data-override-custom]',card)?.checked;
      const existing = c.groupOverrides[id] || {};
      c.groupOverrides[id] = {enabled,intervalMinutes:number($('[data-override-interval]',card)?.value,c.intervalMinutes),schedule:readSchedule($('[data-override-schedule]',card),`group-${id}-`),items:custom?(existing.items||[]):[]};
    }
    for (const id of Object.keys(c.groupOverrides)) if (!c.groupIds.includes(id)) delete c.groupOverrides[id];
  }

  function validateDraft() {
    collectEditor();
    const c = state.draft;
    if (!c.name?.trim()) throw new Error('Informe um nome para a campanha.');
    if (c.intervalMinutes<1 || c.spacingSeconds<3) throw new Error('Use um intervalo de ao menos 1 minuto e espaçamento de ao menos 3 segundos.');
    if (!c.schedule.days.length) throw new Error('Selecione ao menos um dia da semana.');
    if (c.schedule.startDate && c.schedule.endDate && c.schedule.startDate>c.schedule.endDate) throw new Error('A data de encerramento precisa ser posterior ao início.');
    if (c.groupIds.length>selectedLimit()) throw new Error(`O limite atual é ${selectedLimit()} grupos por campanha.`);
    for (const item of [...c.items,...Object.values(c.groupOverrides||{}).flatMap(o=>o.enabled?o.items||[]:[])]) {
      if (item.type==='text' && !item.text?.trim()) throw new Error('Preencha os textos adicionados ou remova os itens vazios.');
      if (item.type!=='text' && !mediaItem(item.mediaId)) throw new Error('Uma mídia da campanha não está na biblioteca. Importe o arquivo novamente.');
    }
    c.name=c.name.trim();
    return c;
  }

  function previewBody(c,summary) {
    const count = c.mode==='rotate'?1:c.items.length;
    const basePerRound = c.groupIds.length*count;
    const enabledOverrides = Object.values(c.groupOverrides||{}).filter(o=>o.enabled).length;
    const perRound = c.groupIds.reduce((total,id)=>{const o=c.groupOverrides?.[id];const items=o?.enabled&&o.items?.length?o.items:c.items;return total+(c.mode==='rotate'?Math.min(1,items.length):items.length);},0);
    const [sh,sm] = (c.schedule.startTime||'08:00').split(':').map(Number);
    const [eh,em] = (c.schedule.endTime||'18:00').split(':').map(Number);
    let minutes=(eh*60+em)-(sh*60+sm);if(minutes<=0)minutes+=1440;
    const estimatedRounds = Math.min(Math.ceil(minutes/c.intervalMinutes),c.dailyRoundLimit||Infinity);
    const estimatedDaily = Math.min(estimatedRounds*perRound,c.dailySendLimit||Infinity);
    return `<div class="preview-summary"><div><div class="preview-label">Campanha</div><div class="preview-value">${e(c.name||'Sem nome')}</div></div><div><div class="preview-label">Destinos</div><div class="preview-value">${c.groupIds.length} grupo(s) · ${enabledOverrides} configuração(ões) específica(s)</div></div><div><div class="preview-label">Frequência</div><div class="preview-value">Início de rodada a cada ${e(c.intervalMinutes)} min<br>${e(c.spacingSeconds)}s entre grupos</div></div><div><div class="preview-label">Funcionamento</div><div class="preview-value">${e((c.schedule.days||[]).map(d=>weekdays[d]).join(', '))}<br>${e(c.schedule.startTime)}–${e(c.schedule.endTime)} · horário local</div></div><div><div class="preview-label">Conteúdo</div><div class="preview-value">${c.mode==='rotate'?'Próximo item a cada rodada':'Todo o conjunto a cada rodada'}<br>${c.items.length} item(ns) na sequência principal</div></div><div><div class="preview-label">Estimativa de envio</div><div class="preview-value">Até ${e(estimatedDaily)} envio(s)/dia elegível<br><span class="field-hint">${enabledOverrides?'O cálculo base pode mudar com intervalos e horários específicos.':'Duração da fila e limites da integração podem reduzir este total.'}</span></div></div></div><div class="preview-group-list">${e(c.groupIds.map(id=>group(id)?.name||id).join(' · ')||'Nenhum grupo selecionado')}</div>${summary?`<pre class="summary-pre">${e(summary)}</pre>`:''}<h3 style="margin-top:22px">Prévia do conteúdo principal</h3>${c.items.length?c.items.map(item=>`<div class="preview-message">${item.type==='text'?e(item.text):`<div class="media-preview">${assetPreview(mediaItem(item.mediaId))} ${e(mediaItem(item.mediaId)?.name||'Arquivo indisponível')}</div>${e(item.caption||'Sem legenda')}`}</div>`).join(''):'<p class="soft-text">Nenhum conteúdo na sequência principal.</p>'}${enabledOverrides?`<h3 style="margin-top:22px">Conteúdo por grupo</h3>${c.groupIds.filter(id=>c.groupOverrides?.[id]?.enabled).map(id=>{const o=c.groupOverrides[id];return `<div class="content-item"><h3>${e(group(id)?.name||id)}</h3><p class="soft-text">A cada ${e(o.intervalMinutes||c.intervalMinutes)} min · ${e(o.schedule?.startTime||c.schedule.startTime)}–${e(o.schedule?.endTime||c.schedule.endTime)}</p>${o.items?.length?o.items.map(item=>`<div class="preview-message">${e(item.text||mediaItem(item.mediaId)?.name||types[item.type])}${item.caption?`\n${e(item.caption)}`:''}</div>`).join(''):'<p class="soft-text">Usa o conteúdo principal da campanha.</p>'}</div>`;}).join('')}`:''}<div class="warning-note">A ativação envia apenas para os grupos autorizados. O computador deve permanecer ligado, conectado e sem suspensão. Uma interrupção não gera reenvio de rodadas perdidas.</div>`;
  }

  async function showPreview(id,activation=false,resume=false) {
    const c = campaign(id);
    if (!c) throw new Error('Campanha não encontrada.');
    const result = await call('previewCampaign',{id});
    const summary = typeof result==='string'?result:result?.summary||result?.text||'';
    state.modal={kind:'preview',campaignId:id,activation,resume,revision:c.revision,configRevision:c.configRevision??c.revision,summaryState:c.state,previousFocus:document.activeElement};
    showModal('preview',activation?(resume?'Confirmar retomada':'Confirmar ativação'):'Prévia da campanha','Revise o conteúdo, os grupos e a frequência antes de enviar.',previewBody(c,summary),`<span class="soft-text">${activation?'Ao confirmar, a campanha fica apta a enviar dentro do horário configurado.':'A criação e a prévia não iniciam envios.'}</span><div class="modal-footer-actions">${button('close-modal','Fechar','ghost')}${activation?button('confirm-activation',resume?'Confirmar retomada':'Confirmar e ativar','primary',id,'play'):button('edit-campaign','Editar campanha','primary',id,'edit')}</div>`);
  }

  function showEditorPreview(forSave=false) {
    const c=validateDraft();
    state.modal={...state.modal,kind:'editor-preview',forSave};
    showModal('editor-preview',forSave?'Confirmar alterações':'Prévia da campanha',forSave?'Esta campanha está ativa. Revise os novos conteúdos e destinos.':'A campanha permanece desativada até você confirmar a ativação.',previewBody(c),`<span class="soft-text">${forSave?'Ao continuar, uma confirmação do aplicativo será solicitada.':'A prévia mostra a sequência configurada.'}</span><div class="modal-footer-actions">${button('back-editor','Voltar ao editor','ghost')}${forSave?button('confirm-save','Continuar e salvar','primary','','check'):''}</div>`);
  }

  function showMediaPicker(scope='campaign',groupId='') {
    collectEditor();
    state.modal={...state.modal,kind:'media-picker',scope,groupId};
    const body = media().length ? `<div class="checkbox-stack">${media().map(m=>`<label class="editor-group"><input type="checkbox" data-pick-media="${e(m.id)}"><span>${icon(m.type)} ${e(m.name)} <span class="muted">· ${e(sizeText(m.size))}</span></span></label>`).join('')}</div>` : empty('library','Sua biblioteca ainda está vazia','Importe os arquivos pelo editor da campanha.');
    showModal('media-picker','Escolher arquivos','Selecione os arquivos para adicionar à sequência na ordem exibida.',body,`<span class="soft-text">Imagens, vídeos e documentos ficam na pasta gerenciada.</span><div class="modal-footer-actions">${button('back-editor','Voltar','ghost')}${button('confirm-media','Adicionar selecionados','primary','','plus')}</div>`,true);
  }

  function renderConnectionModal() {
    const conn=data().connection||{};
    const qr = typeof conn.qr==='string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(conn.qr) ? conn.qr : null;
    const body = `<div class="connection-info"><div class="whatsapp-symbol">${icon('whatsapp')}</div><div><h2>${currentMode()==='simulated'?'Simulação local':'WhatsApp Web — não oficial'}</h2><p>${badge(conn.state||'disconnected')}</p></div></div><p class="soft-text">${e(conn.detail||'Conecte para carregar grupos e usar a fila de envios.')}</p>${qr?`<div class="qr-card"><img src="${e(qr)}" alt="QR code para conectar o WhatsApp"></div><p class="soft-text">No WhatsApp do celular: Configurações → Aparelhos conectados → Conectar um aparelho. Escaneie este QR code.</p>`:''}${currentMode()==='whatsapp'?'<div class="warning-note">Integração não oficial com WhatsApp Web. A sessão é armazenada com proteção do Windows; o aplicativo respeita desconexões e restrições.</div>':'<div class="info-note">A simulação usa grupos fictícios e nunca envia mensagens reais. É o ambiente recomendado para validar a programação.</div>'}`;
    showModal('connection','Conexão','Acompanhe o estado da conta e gerencie a sessão.',body,`<span class="soft-text">${conn.state==='connected'?'A conexão está pronta. Revise os grupos antes de ativar campanhas.':'O QR code aparece após iniciar a conexão.'}</span><div class="modal-footer-actions">${currentMode()==='whatsapp'||conn.state==='connected'||conn.state==='connecting'?button('disconnect',currentMode()==='whatsapp'?'Remover sessão':'Desconectar','danger','','close'):''}${button('connect',conn.state==='connected'?'Reconectar':'Conectar','primary','','link')}</div>`,true);
  }

  async function saveDraft() {
    const c=state.draft;
    const result=await perform('saveCampaign',{campaign:c},'Campanha salva.');
    if(result?.cancelled){renderCampaignEditor();return result;}
    closeModal();
    state.page='campaigns';state.search='';state.filter='all';render();
    return result;
  }

  async function onAction(action,el) {
    const id=el.dataset.id;
    switch(action) {
      case 'navigate':
        if(state.settingsDirty && state.page==='settings' && id!=='settings' && !confirm('Sair de Configurações e descartar alterações não salvas?'))break;
        state.settingsDirty=false;state.page=id;state.search='';state.filter='all';render();break;
      case 'toggle-theme': {const theme=document.body.dataset.theme==='dark'?'light':'dark';await perform('saveSettings',{settings:{theme}});if(state.settingsDirty&&$('#settings-form'))$('#settings-form').elements.theme.value=theme;break;}
      case 'window-minimize': await call('windowMinimize');break;
      case 'stop-all': await perform('stopAll',undefined,'Todos os envios foram interrompidos.');break;
      case 'connection': state.modal={kind:'connection',previousFocus:document.activeElement};renderConnectionModal();break;
      case 'connect': await perform('connect');renderConnectionModal();break;
      case 'disconnect': await perform('disconnect');renderConnectionModal();break;
      case 'refresh-groups': await perform('refreshGroups',undefined,'Lista de grupos atualizada.');break;
      case 'new-campaign': editCampaign();break;
      case 'edit-campaign': editCampaign(id);break;
      case 'close-modal':
        if ((state.modal?.kind==='editor'||state.modal?.kind==='editor-preview'||state.modal?.kind==='media-picker') && !confirm('Fechar o editor e descartar alterações não salvas?')) break;
        closeModal();break;
      case 'back-editor': renderCampaignEditor();break;
      case 'preview': await showPreview(id);break;
      case 'activate': await showPreview(id,true);break;
      case 'resume': await showPreview(id,true,true);break;
      case 'confirm-activation': {
        const m=state.modal;
        await perform(m.resume?'resumeCampaign':'activateCampaign',{id,revision:m.revision,configRevision:m.configRevision,summaryState:m.summaryState},m.resume?'Campanha retomada.':'Campanha ativada.');
        closeModal();break;
      }
      case 'pause': await perform('pauseCampaign',{id},'Campanha pausada.');break;
      case 'duplicate': {
        const result=await perform('duplicateCampaign',{id},'Cópia criada e desativada.');
        closeModal();
        const copied=result?.campaign||result;
        if (copied?.id) editCampaign(copied.id);else{state.page='campaigns';render();}
        break;
      }
      case 'delete-campaign':
        if (confirm('Excluir esta campanha? Os registros de envios existentes permanecem no histórico.')) {await perform('deleteCampaign',{id},'Campanha excluída.');closeModal();}break;
      case 'add-text': collectEditor();state.draft.items.push({id:uid(),type:'text',text:''});renderCampaignEditor();break;
      case 'override-add-text': {
        collectEditor();const g=el.dataset.group;state.draft.groupOverrides[g] ||= {enabled:true};state.draft.groupOverrides[g].items ||= [];state.draft.groupOverrides[g].items.push({id:uid(),type:'text',text:''});renderCampaignEditor();
        $$('[data-override-card]').find(x=>x.dataset.overrideCard===g).open=true;break;
      }
      case 'add-media':showMediaPicker();break;
      case 'override-add-media':showMediaPicker('override',el.dataset.group);break;
      case 'confirm-media': {
        const picked=$$('[data-pick-media]:checked').map(x=>mediaItem(x.dataset.pickMedia)).filter(Boolean);
        if (!picked.length) throw new Error('Selecione ao menos um arquivo.');
        const m=state.modal;
        const list=m.scope==='override'?(state.draft.groupOverrides[m.groupId].items ||= []):state.draft.items;
        for (const asset of picked)list.push({id:uid(),type:asset.type,mediaId:asset.id,caption:''});
        renderCampaignEditor();break;
      }
      case 'import-media': await perform('importMedia',undefined,'Arquivos copiados para a biblioteca.');break;
      case 'import-editor-media': {
        collectEditor();
        const before=new Set(media().map(m=>m.id));
        await perform('importMedia');
        for(const asset of media().filter(m=>!before.has(m.id)))state.draft.items.push({id:uid(),type:asset.type,mediaId:asset.id,caption:''});
        renderCampaignEditor();break;
      }
      case 'item-up':case 'item-down':case 'item-remove': {
        collectEditor();const index=number(el.dataset.index);
        const list=el.dataset.scope==='override'?state.draft.groupOverrides[el.dataset.group].items:state.draft.items;
        if(action==='item-remove')list.splice(index,1);
        else{const to=index+(action==='item-up'?-1:1);if(to>=0&&to<list.length)[list[index],list[to]]=[list[to],list[index]];}
        renderCampaignEditor();if(el.dataset.scope==='override'){$$('[data-override-card]').find(x=>x.dataset.overrideCard===el.dataset.group).open=true;}break;
      }
      case 'editor-preview':showEditorPreview();break;
      case 'save-campaign': {
        validateDraft();if(state.draft.state==='active')showEditorPreview(true);else await saveDraft();break;
      }
      case 'confirm-save':await saveDraft();break;
      case 'save-template': {
        collectEditor();if(!state.draft.items.length)throw new Error('Adicione conteúdo antes de salvar um modelo.');
        const name=prompt('Nome do modelo',state.draft.name||'Meu modelo');
        if(name?.trim())await perform('saveTemplate',{name:name.trim(),items:clone(state.draft.items)},'Modelo salvo na biblioteca.');break;
      }
      case 'use-template':editCampaign(undefined,(data().templates||[]).find(t=>t.id===id));break;
      case 'delete-template':if(confirm('Excluir este modelo da biblioteca?'))await perform('deleteTemplate',{id},'Modelo excluído.');break;
      case 'library-tab':state.libraryTab=id;state.search='';render();break;
      case 'backup':await perform('backup',undefined,'Backup criado.');break;
      case 'restore':
        if(confirm('A restauração substitui os dados locais por um backup e interrompe as campanhas. Continuar?')){const result=await perform('restore',undefined,'Backup restaurado. Revise as campanhas antes de ativar.');if(!result?.cancelled){state.settingsDirty=false;render();}}break;
      case 'open-data':await call('openDataFolder');break;
      case 'confirm-job':case 'discard-job':
        if(confirm(action==='confirm-job'?'Você verificou no WhatsApp que este conteúdo foi enviado? Marcar como confirmado?':'Descartar este resultado incerto? O conteúdo não será reenviado.'))await perform('reviewJob',{id,decision:action==='confirm-job'?'confirm':'discard'},'Resultado revisado.');break;
      case 'simulation-command': {
        const body=`<form id="simulation-form"><div class="field-grid"><div class="field field-full"><label>Número remetente (país + DDD)</label><input name="senderNumber" type="text" required value="${e((settings().admins||[])[0]||'5511999999999')}"></div><div class="field field-full"><label>Comando</label><input name="text" type="text" required value="!mega status"></div></div><div class="checkbox-stack"><label class="check-label"><input type="checkbox" name="isGroup"> Simular mensagem de grupo (deve ser ignorada)</label><label class="check-label"><input type="checkbox" name="forwarded"> Simular mensagem encaminhada (deve ser ignorada)</label></div></form>`;
        state.modal={kind:'simulation',previousFocus:document.activeElement};showModal('simulation','Testar comando autorizado','Nenhuma mensagem será enviada ao WhatsApp.',body,`<span class="soft-text">Cadastre o remetente em Administradores para testar um comando permitido.</span>${button('send-simulation','Executar teste','primary','','play')}`,true);break;
      }
      case 'send-simulation': {
        const f=$('#simulation-form');if(!f.reportValidity())break;
        const result=await call('testSimulation',{text:f.elements.text.value,senderNumber:f.elements.senderNumber.value.replace(/\D/g,''),isGroup:f.elements.isGroup.checked,forwarded:f.elements.forwarded.checked,verified:true,fromMe:false});
        await refresh();
        const replies=result?.replies||result?.responses||[];
        const lines=Array.isArray(replies)?replies.map(r=>typeof r==='string'?r:r.text||JSON.stringify(r)): [String(replies)];
        const output=lines.length?lines.join('\n\n'):result?.text||'Nenhuma resposta. Mensagens não autorizadas são ignoradas.';
        showModal('simulation-result','Resultado do comando','Validação no ambiente simulado.',`<pre class="summary-pre">${e(output)}</pre>`,button('close-modal','Fechar','primary'),true);break;
      }
    }
  }

  document.addEventListener('click',async event=>{
    const el=event.target.closest('[data-action]');
    if(!el||el.disabled)return;
    event.preventDefault();
    const action=el.dataset.action;
    if(state.pending && action!=='stop-all')return;
    state.pending=true;
    el.disabled=true;
    try {await onAction(action,el);}catch(error){toast(error.message,true);}finally{state.pending=false;if(el.isConnected)el.disabled=false;}
  });

  document.addEventListener('change',async event=>{
    const el=event.target;
    try {
      if(el.dataset.authorizeGroup)await perform('authorizeGroup',{id:el.dataset.authorizeGroup,authorized:el.checked});
      if(el.closest('#settings-form'))state.settingsDirty=true;
      if(el.id==='campaign-filter'||el.id==='history-filter'){state.filter=el.value;render();}
      if(el.dataset.selectGroup){
        collectEditor();const id=el.dataset.selectGroup;
        if(el.checked){if(state.draft.groupIds.length>=selectedLimit()){el.checked=false;throw new Error(`Você pode selecionar até ${selectedLimit()} grupos. Altere o limite em Configurações.`);}if(!state.draft.groupIds.includes(id))state.draft.groupIds.push(id);}
        else state.draft.groupIds=state.draft.groupIds.filter(g=>g!==id);
        $('#selected-count').textContent=`${state.draft.groupIds.length} / ${selectedLimit()} selecionados`;
        el.closest('.editor-group').classList.toggle('selected',el.checked);
        $('#editor-overrides').innerHTML=overrideCards();
      }
      if(el.dataset.overrideEnabled){const card=el.closest('[data-override-card]');$('[data-override-fields]',card).classList.toggle('editor-hidden',!el.checked);}
      if(el.dataset.overrideCustom){
        const id=el.dataset.overrideCustom;const card=el.closest('[data-override-card]');
        $('[data-override-content]',card).classList.toggle('editor-hidden',!el.checked);
        if(el.checked){state.draft.groupOverrides[id] ||= {enabled:true};state.draft.groupOverrides[id].items ||= [];}
      }
    }catch(error){if(el.dataset.authorizeGroup)el.checked=!el.checked;toast(error.message,true);}
  });

  document.addEventListener('input',event=>{
    const el=event.target;
    if(el.closest('#settings-form'))state.settingsDirty=true;
    if(el.id==='page-search'){
      const cursor=el.selectionStart;
      state.search=el.value;render();
      const next=$('#page-search');next.focus();next.setSelectionRange(cursor,cursor);
    }
    if(el.id==='editor-group-search')$('#editor-group-options').innerHTML=editorGroups(el.value);
  });

  document.addEventListener('submit',async event=>{
    event.preventDefault();
    try{
      if(event.target.id==='settings-form'){
        const f=event.target;if(!f.reportValidity())return;
        const admins=f.elements.admins.value.split(/[\n,;]/).map(n=>n.trim().replace(/[+\s()-]/g,'')).filter(Boolean);
        if(admins.some(n=>!/^\d{10,15}$/.test(n)))throw new Error('Informe números válidos com país e DDD, usando de 10 a 15 dígitos.');
        const values={integrationMode:f.elements.integrationMode.value,admins:[...new Set(admins)],unofficialAcknowledged:f.elements.unofficialAcknowledged.checked,theme:f.elements.theme.value,maxSelectedGroups:number(f.elements.maxSelectedGroups.value,15),launchAtLogin:f.elements.launchAtLogin.checked,closeBehavior:f.elements.closeBehavior.value};
        if(values.integrationMode==='whatsapp'&&!values.unofficialAcknowledged)throw new Error('Leia e aceite as limitações da integração não oficial antes de ativar esse modo.');
        const result=await call('saveSettings',{settings:values});
        if(!result?.cancelled){state.settingsDirty=false;await refresh();toast('Configurações salvas.');}
      }
    }catch(error){toast(error.message,true);}
  });

  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&state.modal){event.preventDefault();if(state.modal.kind==='editor'||state.modal.kind==='editor-preview'||state.modal.kind==='media-picker'){if(confirm('Fechar o editor e descartar alterações não salvas?'))closeModal();}else closeModal();}
    if(event.key==='Tab'&&state.modal){
      const items=[$('.topbar .stop-button'),...$$('.modal button:not(:disabled),.modal input:not(:disabled),.modal textarea:not(:disabled),.modal select:not(:disabled),.modal summary')].filter(el=>el&&el.offsetParent!==null);
      if(!items.length)return;
      const first=items[0],last=items.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    }
  });

  $('.brand').addEventListener('click',event=>{event.preventDefault();if(state.settingsDirty&&!confirm('Sair e descartar alterações não salvas?'))return;state.settingsDirty=false;state.page='dashboard';state.search='';state.filter='all';render();});
  if(window.mega?.onUpdate)window.mega.onUpdate(()=>refresh());
  refresh();
})();
