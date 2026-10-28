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
  const names = {pending:'Pendente',delivered:'Entregue',read:'Lido',draft:'Rascunho',active:'Ativa',paused:'Pausada',stopped:'Encerrada',confirmed:'Confirmado',failed:'Falha',uncertain:'Incerto',queued:'Na fila',sending:'Enviando',cancelled:'Cancelado',connected:'Conectado',connecting:'Conectando',disconnected:'Desconectado',restricted:'Restrição'};
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
  const button = (action,label,style='',id='',ico='') => canAction(action) ? `<button class="button ${style}" data-action="${e(action)}" ${id ? `data-id="${e(id)}"` : ''}>${ico ? icon(ico) : ''}${e(label)}</button>` : '';
  const badge = status => `<span class="badge ${e(status)}">${e(names[status] || status)}</span>`;
  const empty = (ico,title,desc,action='',label='') => `<div class="empty-state"><div class="empty-icon">${icon(ico)}</div><h3>${e(title)}</h3><p>${e(desc)}</p>${action ? button(action,label,'primary','','plus') : ''}</div>`;
  const pageTitle = (eyebrow,title,desc,action='') => `<div class="page-heading"><div><div class="eyebrow">${e(eyebrow)}</div><h1>${e(title)}</h1><p class="subtitle">${e(desc)}</p></div>${action}</div>`;
  const state = {page:'dashboard',data:null,search:'',filter:'all',libraryTab:'media',modal:null,draft:null,pending:false,refreshing:false,settingsDirty:false,authScreen:null,authKey:null,history:null,diagnostics:null,users:[],roles:[],contacts:[],recipients:[],alerts:null,audit:null,pageOffset:0,pageLimit:50,pageFilters:{},pageLoading:false,pageRequest:0};
  let buscasUI,libraryUI,remindersUI,contactIntakeUI,commerceUI,financeUI;

  function toast(message,error=false) {
    const div = document.createElement('div');
    div.className = `toast${error ? ' error' : ''}`;
    div.textContent = String(message);
    $('#toast-region').append(div);
    setTimeout(() => div.remove(), error ? 8500 : 5000);
  }

  async function call(action,payload) {
    if (!window.mega) throw new Error('A interface precisa ser aberta pelo aplicativo Kenned Code Disparos.');
    const result = await window.mega.call(action,payload);
    if (result && result.error) throw new Error(typeof result.error === 'string' ? result.error : result.error.message || 'Não foi possível executar esta ação.');
    return result;
  }

  function refresh() {
    // A caller after saving must await a fresh snapshot, even when an older
    // request is still in flight. Coalesce concurrent requests into one follow-up.
    state.refreshAgain = true;
    if (state.refreshPromise) return state.refreshPromise;
    state.refreshPromise = (async () => {
      do { state.refreshAgain = false; await refreshOnce(); } while (state.refreshAgain);
    })().finally(() => { state.refreshPromise = null; });
    return state.refreshPromise;
  }

  async function refreshOnce() {
    state.refreshing = true;
    try {
      const snapshot = await call('snapshot');
      const nextMode=snapshot.storageMode||snapshot.settings?.integrationMode||snapshot.connection?.mode;
      if(nextMode && state.data && nextMode!==currentMode()){
        state.pageRequest++;state.pageOffset=0;state.pageFilters={};state.search='';state.filter='all';state.settingsDirty=false;
        state.history=null;state.diagnostics=null;state.contacts=[];state.recipients=[];state.alerts=null;state.audit=null;clearTimeout(state.searchTimer);
        buscasUI.reset();libraryUI?.reset();remindersUI?.reset();contactIntakeUI?.reset();commerceUI?.reset();financeUI?.reset();closeModal();
      }
      state.data = snapshot;
      state.contacts = Array.isArray(snapshot.contacts) ? snapshot.contacts : [];
      document.body.dataset.theme = snapshot.settings?.theme || 'dark';
      render();
      if (state.modal?.kind === 'connection') renderConnectionModal();
    } catch (error) { toast(error.message,true); }
    finally {state.refreshing = false;}
  }

  async function perform(action,payload,success) {
    const result = await call(action,payload);
    await refresh();
    if (['history','diagnostics','users','contacts','alerts'].includes(state.page)) await loadPageData();
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
  const currentMode = () => data()?.storageMode || settings().integrationMode || data()?.connection?.mode || 'simulated';
  const permittedGroups = () => groups().filter(g => g.authorized && Boolean(g.simulation) === (currentMode() === 'simulated'));
  const selectedLimit = () => Math.max(1,number(settings().maxSelectedGroups,15));

  function render(force=false) {
    const d = data();
    if (!d) return;
    if (renderAuth()) return;
    const nav = [['dashboard','Painel','dashboard'],['campaigns','Campanhas','campaign'],['buscas','BUSCAS','search'],['reminders','LEMBRETES','clock'],['contacts','Contatos','groups'],['inventory','Estoque','library'],['suppliers','Fornecedores','groups'],['commercial','Listas comerciais','campaign'],['opportunities','Oportunidades','search'],['demands','Aparelhos procurados','search'],['sales','CAIXA / VENDAS','dashboard'],['financialReports','Relatórios financeiros','history'],['groups','Grupos','groups'],['library','Biblioteca','library'],['history','Histórico','history'],['reports','Relatórios','history'],['diagnostics','Diagnóstico','shield'],['alerts','Alertas','whatsapp'],['users','Usuários e perfis','shield'],['settings','Configurações','settings']].filter(([key])=>canPage(key));
    if (!canPage(state.page)) state.page='dashboard';
    $('#navigation').innerHTML = nav.map(([key,label,ico]) => `<button class="nav-item${state.page===key?' active':''}" data-action="navigate" data-id="${key}" ${state.page===key?'aria-current="page"':''}><span class="nav-icon"><svg viewBox="0 0 24 24">${icons[ico]}</svg></span><span>${label}</span>${key==='campaigns' ? `<span class="nav-count">${campaigns().length}</span>` : ''}</button>`).join('');
    const conn = d.connection || {state:'disconnected'};
    $('#connection-pill').innerHTML = `<span class="status-dot ${e(conn.state)}"></span>${e(names[conn.state] || conn.state)}${d.storageError?' · Envios bloqueados: armazenamento':''}${d.maintenance?' · Atualizando dados…':''} <span class="muted">· ${currentMode()==='simulated'?'Simulação local':'WhatsApp · não oficial'}</span>${conn.ownNumber?` <span class="muted">· Conta: ${e(conn.ownNumber)}</span>`:''}`;
    $('#simulation-banner').hidden=currentMode()!=='simulated';
    const stopped=d.automation?.stopped===true;$('#automation-banner').hidden=!stopped;
    $('#automation-banner').innerHTML=stopped?`<div><strong>ENVIOS AUTOMÁTICOS INTERROMPIDOS</strong><small>Campanhas, buscas com entrega, alertas e lembretes não entram em novas filas até uma retomada explícita.</small></div>${button('resume-automation','Retomar sistema','small primary')}`:'';
    $('#user-bar').innerHTML = `<button class="account-button" data-action="account"><span class="user-avatar">${e((auth().user?.name||'U').slice(0,1).toUpperCase())}</span><span>${e(auth().user?.name||'Usuário')}<small>${e(auth().user?.roleName||'')}</small></span></button>${button('logout','Sair','small ghost')}`;
    $('.topbar [data-action="stop-all"]').disabled=!can('automation.control');
    renderConnectionBanner();
    $('#theme-toggle').disabled=!can('settings.edit');
    $('#theme-toggle').innerHTML = icon(document.body.dataset.theme==='dark'?'sun':'moon');
    $('#version').textContent = d.version || '1.0';
    const renderers = {dashboard:renderDashboard,campaigns:renderCampaigns,buscas:()=>buscasUI.render(),groups:renderGroups,library:()=>libraryUI.render(),reminders:()=>remindersUI.render(),history:renderHistory,settings:renderSettings,reports:renderReports,diagnostics:renderDiagnostics,users:renderUsers,contacts:()=>contactIntakeUI.render()+commerceUI.render('contacts'),inventory:()=>commerceUI.render('inventory'),suppliers:()=>commerceUI.render('suppliers'),commercial:()=>commerceUI.render('commercial'),opportunities:()=>commerceUI.render('opportunities'),demands:()=>commerceUI.render('demands'),sales:()=>financeUI.render('sales'),financialReports:()=>financeUI.render('financialReports'),alerts:renderAlerts};
    if (!force && state.page==='settings' && $('#settings-form') && (state.settingsDirty || $('#settings-form').contains(document.activeElement))) return;
    if(!force&&state.page==='contacts'&&contactIntakeUI.shouldPreserveDOM())return;
    if(!force&&['inventory','suppliers','commercial','opportunities','demands','contacts'].includes(state.page)&&commerceUI?.shouldPreserveDOM())return;
    if(!force&&['sales','financialReports'].includes(state.page)&&financeUI?.shouldPreserveDOM())return;
    if(!force&&state.page==='library'&&libraryUI.shouldPreserveDOM())return;
    if (!force && state.page==='buscas' && buscasUI.shouldPreserveDOM()) {buscasUI.updateStatus();return;}
    const focused=document.activeElement?.id;
    const selection=focused==='page-search'?document.activeElement.selectionStart:null;
    $('#main').innerHTML = renderers[state.page]();
    if(state.page==='settings'&&!can('settings.edit'))for(const el of $$('input,textarea,select,[type=submit]',$('#settings-form')))el.disabled=true;
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
      (list.length ? `<div class="group-grid">${list.map(g=>`<article class="group-card"><div class="group-avatar">${icon('groups')}</div><div class="group-card-content"><h3>${e(g.name)} ${g.simulation?'<span class="simulation-tag">SIMULADO</span>':''}</h3><p class="group-card-id">${e(g.id)}</p><label class="check-label"><input type="checkbox" data-authorize-group="${e(g.id)}" ${g.authorized?'checked':''} ${can('groups.edit')?'':'disabled'}> Tenho autorização para publicar</label><label class="field-hint">Público deste grupo<select data-group-audience="${e(g.id)}" ${can('commerce.manage')?'':'disabled'}>${[['general','Geral'],['retail','Varejo'],['wholesale','Atacado']].map(([v,l])=>`<option value="${v}" ${(data().commerce?.promotionTargets||[]).find(t=>t.type==='group'&&t.targetId===g.id)?.audience===v?'selected':''}>${l}</option>`).join('')}</select></label></div></article>`).join('')}</div>` : `<div class="panel">${empty('groups','Nenhum grupo encontrado','Conecte a conta e clique em Atualizar grupos. No modo simulado, os grupos de teste são carregados ao conectar.')}</div>`);
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
    const result=state.history||{items:[],total:0};const jobs=result.items||[];
    return pageTitle('Resultados com transparência','Histórico','Confirmações, falhas e resultados incertos. A consulta carrega uma página por vez.',button('export-history','Exportar registros','','','upload')) +
      pendingReviewsPanel() + `<div class="toolbar">${searchInput('Buscar por campanha, grupo ou falha')}<select class="filter-select" id="history-filter" aria-label="Filtrar resultados"><option value="">Todos os resultados</option>${['confirmed','failed','uncertain','queued','sending','cancelled'].map(v=>`<option value="${v}"${state.pageFilters.status===v?' selected':''}>${names[v]}</option>`).join('')}</select>${campaignFilter()}<select class="filter-select" data-history-category aria-label="Categoria do histórico"><option value="all">Todas as categorias</option>${[['campaigns','Campanhas'],['sends','Envios'],['errors','Erros'],['notifications','Notificações']].map(([v,label])=>`<option value="${v}" ${state.pageFilters.categories?.includes(v)?'selected':''}>${label}</option>`).join('')}</select>${dateFilters()}</div>` +
      (jobs.some(j=>j.status==='uncertain')?'<div class="warning-note">Um resultado incerto pode ter sido enviado. Verifique a conversa no WhatsApp e marque como confirmado ou descarte o registro. Ele não será reenviado automaticamente.</div>':'') +
      `<div class="panel">${jobs.length?`<div class="table-scroll"><table><thead><tr><th>HORÁRIO</th><th>CAMPANHA / GRUPO</th><th>CONTEÚDO</th><th>RESULTADO</th><th>DETALHES</th></tr></thead><tbody>${jobs.map(j=>`<tr><td>${e(fmt(j.resultAt||j.createdAt||j.at))}</td><td><span class="table-name">${e(j.campaignName||campaign(j.campaignId)?.name||short(j.campaignId))}</span><span class="table-subtitle">${e(j.groupName||group(j.groupId)?.name||j.groupId)}</span></td><td><span class="table-name">${e(types[j.itemSnapshot?.type]||({campaigns:'Campanha',errors:'Erro',notifications:'Notificação'})[j.category]||'Conteúdo')}</span><span class="table-subtitle">${e((j.itemSnapshot?.text||j.itemSnapshot?.caption||mediaItem(j.itemSnapshot?.mediaId)?.name||'').slice(0,65))}</span></td><td>${badge(j.status)}</td><td><div class="history-note">${e(j.error||j.description||j.reason||j.messageId||j.kind||'—')}</div>${j.status==='uncertain'&&j.category==='sends'?`<div class="row-actions" style="margin-top:8px">${button('confirm-job','Confirmado','small',j.jobId||j.id,'check')}${button('discard-job','Descartar','small ghost',j.jobId||j.id,'close')}</div>`:''}</td></tr>`).join('')}</tbody></table></div>`:empty('history','Nenhum envio nesta seleção','Ative uma campanha simulada para validar a fila e acompanhar os resultados.')}${pageControls(result)}</div>`;
  }

  function renderSettings() {
    const s = settings();
    return pageTitle('Do seu jeito','Configurações','Conexão, controle pelo WhatsApp e dados protegidos neste computador.') +
      `<form id="settings-form"><div class="settings-grid"><div><div class="panel"><div class="panel-header"><h2>Conexão e integração</h2>${icon('whatsapp')}</div><div class="panel-body"><div class="field"><label for="integration-mode">Modo de operação</label><select id="integration-mode" name="integrationMode"><option value="simulated"${currentMode()==='simulated'?' selected':''}>Simulação — sem envios reais</option><option value="whatsapp"${currentMode()==='whatsapp'?' selected':''}>WhatsApp Web — integração não oficial</option></select></div><div class="warning-note">A integração WhatsApp Web é não oficial. Ela permite usar grupos da conta, mas pode mudar, desconectar ou sofrer restrições. A integração oficial da Meta exige elegibilidade específica para grupos e não oferece acesso geral aos seus grupos existentes.</div><label class="check-label"><input name="unofficialAcknowledged" type="checkbox"${s.unofficialAcknowledged?' checked':''}> Entendo as limitações da integração não oficial e tenho autorização para usar os grupos selecionados.</label><div class="subtle-divider"></div>${button('connection','Abrir conexão','','','link')}<p class="soft-text">Mudanças do modo são aplicadas após salvar. Reconecte e revise os destinos das campanhas.</p></div></div><div class="panel"><div class="panel-header"><h2>Administradores autorizados</h2>${icon('shield')}</div><div class="panel-body"><div class="field"><label for="admin-numbers">Números com código do país e DDD</label><textarea id="admin-numbers" name="admins" placeholder="5511999999999&#10;5521988888888">${e((s.admins||[]).join('\n'))}</textarea><span class="field-hint">Um número por linha, vinculado ao telefone de um usuário ativo. As permissões desse usuário valem também nos comandos. O remetente é validado pela conexão.</span></div><div class="info-note">Comandos somente em conversa direta autorizada. Mensagens de grupos, encaminhadas e remetentes não verificados são ignorados. Controle administrativo exige a permissão Parar e retomar todas as automações; a permissão de BUSCAS não concede esse controle.</div><div class="settings-command"><code>!mega ajuda</code> · lista os comandos<br><code>!mega menu</code> · configuração por opções numeradas<br><code>!mega status</code> · conexão, filas, alertas, monitoramento e lembretes<br><code>!mega parar tudo</code> · interrompe as campanhas</div></div></div></div><div><div class="panel"><div class="panel-header"><h2>Preferências do aplicativo</h2>${icon('settings')}</div><div class="panel-body"><div class="field-grid"><div class="field"><label for="theme">Aparência</label><select name="theme" id="theme"><option value="dark"${(s.theme||'dark')==='dark'?' selected':''}>Tema escuro</option><option value="light"${s.theme==='light'?' selected':''}>Tema claro</option></select></div><div class="field"><label for="group-limit">Limite de grupos por campanha</label><input id="group-limit" name="maxSelectedGroups" type="number" min="1" max="1000" required value="${e(selectedLimit())}"><span class="field-hint">Padrão de 15 grupos. Ajustável.</span></div><div class="field field-full"><label for="close-behavior">Ao fechar a janela</label><select id="close-behavior" name="closeBehavior"><option value="ask"${s.closeBehavior==='ask'?' selected':''}>Perguntar: minimizar ou encerrar</option><option value="tray"${s.closeBehavior==='tray'?' selected':''}>Minimizar para a bandeja e continuar</option><option value="quit"${s.closeBehavior==='quit'?' selected':''}>Encerrar o aplicativo e interromper envios</option></select></div></div><label class="check-label"><input name="launchAtLogin" type="checkbox"${s.launchAtLogin?' checked':''}> Iniciar com o Windows</label><p class="soft-text">Os agendamentos usam o fuso horário deste computador. Mantenha-o ligado, com internet e sem suspensão durante os envios.</p></div></div><div class="panel"><div class="panel-header"><h2>Backup e armazenamento</h2>${icon('folder')}</div><div class="panel-body"><p class="soft-text">O backup inclui campanhas, configurações e cópias das mídias. Credenciais de conexão ficam fora do backup comum.</p><div class="settings-actions">${can('finance.export')&&can('finance.view')?button('backup-business','Recuperação completa do banco','small','','folder'):''}${button('backup','Criar backup','','','upload')}${button('restore','Restaurar backup','','','history')}${button('open-data','Abrir pasta de dados','ghost','','folder')}</div><div class="subtle-divider"></div><span class="field-hint">Local dos dados</span><p class="soft-text" style="word-break:break-all">${e(data().dataDir||'Pasta local do aplicativo')}</p></div></div>${currentMode()==='simulated'?`<div class="panel"><div class="panel-header"><h2>Validar comandos na simulação</h2></div><div class="panel-body"><p class="soft-text">Teste autorização, status e o menu antes de conectar a conta real.</p>${button('simulation-command','Enviar comando simulado','','','text')}</div></div>`:''}</div></div>${enhancedSettings(s)}<div class="settings-savebar"><button class="button primary" type="submit" ${can('settings.edit')?'':'disabled'}>${icon('check')} Salvar configurações</button></div></form>`;
  }

  const auth = () => data()?.auth || {};
  const can = permission => !data()?.auth || (auth().permissions||[]).includes('*') || (auth().permissions||[]).includes(permission);
  const actionPermissions = {'new-campaign':'campaign.create','edit-campaign':'campaign.edit','save-campaign':'campaign.edit','confirm-save':'campaign.edit','duplicate':'campaign.create','delete-campaign':'campaign.delete','activate':'campaign.start','resume':'campaign.start','confirm-activation':'campaign.start','pause':'campaign.pause','stop-all':'automation.control','resume-automation':'automation.control','refresh-groups':'groups.view','import-media':'media.create','import-editor-media':'media.create','save-template':'media.create','delete-template':'media.delete','connection':'connection.view','connect':'connection.manage','disconnect':'connection.manage','backup':'settings.edit','restore':'settings.edit','open-data':'settings.edit','toggle-theme':'settings.edit','clear-history':'history.clear','export-history':'history.export','export-diagnostics':'diagnostics.export','export-reports':'reports.export','new-user':'users.create','edit-user':'users.edit','delete-user':'users.delete','reset-user':'users.edit','new-role':'users.roles','edit-role':'users.roles','delete-role':'users.roles','new-contact':'contacts.create','edit-contact':'contacts.edit','delete-contact':'contacts.delete','new-recipient':'notifications.manage','edit-recipient':'notifications.manage','delete-recipient':'notifications.manage','test-recipient':'notifications.manage','test-alert':'notifications.manage','retry-alert':'notifications.manage','import-audio':'settings.edit','test-sound':'settings.edit','confirm-job':'campaign.edit','discard-job':'campaign.edit','confirm-alert':'notifications.manage','discard-alert':'notifications.manage','save-user':'users.edit','save-role':'users.roles'};
  const canAction = action => !actionPermissions[action] || can(actionPermissions[action]) || (action==='save-campaign'&&state.draft&&!campaign(state.draft.id)&&can('campaign.create')) || (action==='save-user'&&!state.modal?.userId&&can('users.create'));
  const canPage = page => ({inventory:()=>can('stock.view'),suppliers:()=>can('supplier.view')&&can('finance.view'),commercial:()=>can('commerce.view'),opportunities:()=>can('commerce.manage'),demands:()=>can('commerce.manage')&&can('finance.view'),sales:()=>can('finance.view'),financialReports:()=>can('finance.reports')&&can('finance.view'),dashboard:()=>true,campaigns:()=>can('campaign.view'),reminders:()=>can('reminder.view'),buscas:()=>can('search.view')&&(data()?.buscas?.authorized===true||auth().user?.isOwner),groups:()=>can('groups.view'),library:()=>can('media.view'),contacts:()=>can('contacts.view'),history:()=>can('history.view'),reports:()=>can('reports.view'),diagnostics:()=>can('diagnostics.view'),alerts:()=>can('notifications.view'),users:()=>can('users.view'),settings:()=>can('settings.view')})[page]?.() || false;
  const field = (label,name,value='',type='text',extra='') => `<div class="field"><label for="field-${e(name)}">${e(label)}</label><input id="field-${e(name)}" name="${e(name)}" type="${e(type)}" value="${e(value)}" ${extra}></div>`;
  const panel = (title,body,action='') => `<div class="panel"><div class="panel-header"><h2>${e(title)}</h2>${action}</div><div class="panel-body">${body}</div></div>`;
  const authFields = setup => `${setup?field('Seu nome','name','','text','required maxlength="140"'):''}${field('Nome de usuário','username','','text','required autocomplete="username" maxlength="80"')}${field('Senha','password','','password',`required autocomplete="${setup?'new-password':'current-password'}" ${setup?'minlength="12"':''}`)}${setup?`${field('Confirme a senha','confirmPassword','','password','required minlength="12" autocomplete="new-password"')}${field('WhatsApp para alertas (país + DDD, opcional)','phone','','tel','placeholder="5511999999999"')}<div class="info-note">Cadastre o dono deste computador. Depois, somente usuários autorizados poderão criar novos acessos. Use uma senha de pelo menos 12 caracteres.</div>`:''}`;

  function renderAuth() {
    const a=auth();
    if (!data()?.auth) return false;
    const locked = !a.authenticated || a.user?.requirePasswordChange;
    $('.app-shell').hidden=locked;$('#auth-root').hidden=!locked;
    if(!locked){state.authKey=null;$('#auth-root').replaceChildren();return false;}
    if(!a.authenticated){$('#main').replaceChildren();$('#navigation').replaceChildren();$('#user-bar').replaceChildren();state.users=[];state.roles=[];state.contacts=[];state.recipients=[];state.history=null;state.diagnostics=null;state.alerts=null;state.settingsDirty=false;buscasUI?.reset();commerceUI?.reset();financeUI?.reset();libraryUI?.reset();remindersUI?.reset();contactIntakeUI?.reset();}
    if(state.modal?.kind!=='recovery-codes') closeModal();
    const screen = a.setupRequired?'setup':a.user?.requirePasswordChange?'password':state.authScreen==='recovery'?'recovery':'login';
    const key=`${screen}:${a.user?.id||''}`;
    if(state.authKey===key && $('#auth-form')) return true;
    state.authKey=key;
    const recovery = `${field('Nome de usuário','username','','text','required autocomplete="username"')}${field('Código de recuperação','code','','text','required autocomplete="off"')}${field('Nova senha','newPassword','','password','required minlength="12" autocomplete="new-password"')}${field('Confirme a nova senha','confirmPassword','','password','required minlength="12" autocomplete="new-password"')}<p class="soft-text">Use um código de recuperação guardado no cadastro ou o código temporário emitido por um dono ou administrador autorizado. Cada código pode ser usado uma vez.</p>`;
    const password = `${field('Senha atual','currentPassword','','password','required autocomplete="current-password"')}${field('Nova senha','newPassword','','password','required minlength="12" autocomplete="new-password"')}${field('Confirme a nova senha','confirmPassword','','password','required minlength="12" autocomplete="new-password"')}<p class="soft-text">Você precisa definir uma nova senha antes de acessar o sistema.</p>`;
    $('#auth-root').innerHTML=`<div class="auth-art"><span class="brand-symbol">K</span><span class="eyebrow">KENNED CODE DISPAROS</span><h1>Seu trabalho.<br>Sua programação.<br>Seu controle.</h1><p>Campanhas e dados protegidos neste computador, com acesso definido por você.</p><div class="auth-assurance">${icon('shield')} A conexão e os envios continuam sujeitos aos limites do WhatsApp.</div></div><div class="auth-content"><div class="auth-card"><span class="eyebrow">${screen==='setup'?'PRIMEIRO ACESSO':'ACESSO LOCAL'}</span><h2>${({setup:'Cadastre o dono',login:'Bem-vindo de volta',recovery:'Recuperar acesso',password:'Defina sua nova senha'})[screen]}</h2><p class="soft-text">${screen==='setup'?'Seus grupos, campanhas e mídias existentes serão preservados.':'Entre com o usuário cadastrado neste aplicativo.'}</p><form id="auth-form" data-screen="${screen}">${screen==='recovery'?recovery:screen==='password'?password:authFields(screen==='setup')}<button class="button primary auth-submit" type="submit">${screen==='setup'?'Criar acesso do dono':screen==='recovery'?'Recuperar senha':screen==='password'?'Alterar senha':'Entrar'}</button></form>${screen==='login'?'<button class="text-button" data-action="auth-recovery">Esqueci minha senha</button><p class="soft-text">Novos usuários devem ser cadastrados ou aprovados por um administrador autorizado.</p>':screen==='recovery'?'<button class="text-button" data-action="auth-login">Voltar para entrar</button>':''}<div class="auth-footer">Dados locais · Kenned Code Disparos ${e(data().version||'')}</div></div></div>`;
    return true;
  }

  function showRecoveryCodes(codes,title='Guarde seus códigos de recuperação') {
    state.modal={kind:'recovery-codes',codes:[...codes]};
    showModal('recovery-codes',title,'Estes códigos são exibidos uma vez. Guarde-os fora deste computador.',`<div class="warning-note">Cada código recupera sua senha uma vez. Quem possui esses códigos pode acessar sua conta. Eles não entram em logs nem em backups comuns.</div><pre class="summary-pre secret-codes">${e(codes.join('\n'))}</pre>`,`<div class="modal-footer-actions">${button('copy-recovery','Copiar códigos','','','copy')}${button('download-recovery','Salvar arquivo','','','upload')}${button('close-modal','Guardei os códigos','primary','','check')}</div>`,true);
  }

  function downloadText(text,name) {
    const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function copyText(text) {await navigator.clipboard.writeText(String(text));toast('Copiado.');}

  function renderConnectionBanner() {
    const conn=data().connection||{};const n=data().notifications||[];
    const failure=(Array.isArray(n)?n:[]).find(x=>!x.dismissed&&['disconnect','critical'].includes(x.event||x.type));
    const show=conn.state!=='connected'&&Boolean(conn.at||conn.disconnectedAt||failure);
    const banner=$('#connection-banner');banner.hidden=!show;
    if(!show)return;
    const reasons={internet:'Sem internet',network:'Sem internet',expired:'Sessão expirada',session_expired:'Sessão expirada',manual:'Desconexão manual',unexpected:'Falha inesperada',restricted:'Restrição da conexão'};
    banner.innerHTML=`<div>${icon('whatsapp')}<span><strong>${e(reasons[conn.reasonCode]||'WhatsApp desconectado')}</strong><small>${e(fmt(conn.at||conn.disconnectedAt||failure?.createdAt))} · ${e(conn.reason||conn.detail||'Verifique a conexão. Os envios estão pausados com segurança.')}</small></span></div><div class="row-actions">${button('connect','Reconectar WhatsApp','small primary','','refresh')}${button('silence-alert','Silenciar este alerta','small ghost',failure?.occurrenceId||failure?.id||'disconnect')}</div>`;
  }

  async function loadCampaignMetadata() {
    if(can('notifications.view')||can('settings.view')) state.recipients = await call('listAlertRecipients');
  }
  const campaignUsers = () => data()?.campaignUsers || state.users || [];
  function campaignManagementFields(c) {
    const users=campaignUsers().length?campaignUsers():auth().user?[auth().user]:[];
    return `<div class="form-section"><div class="section-heading"><h3><span class="section-index">07</span>Responsáveis, alertas e tentativas</h3></div><div class="field-grid"><div class="field"><label for="campaign-owner">Proprietário da campanha</label><select name="ownerId" id="campaign-owner" ${can('users.edit')?'':'disabled'}>${users.map(u=>`<option value="${e(u.id)}" ${u.id===(c.ownerId||auth().user?.id)?'selected':''}>${e(u.name)}</option>`).join('')}</select></div><div class="field"><label>Responsáveis pela campanha</label><div class="checkbox-stack">${users.map(u=>`<label class="check-label"><input name="responsibleUserIds" type="checkbox" value="${e(u.id)}" ${(c.responsibleUserIds||[]).includes(u.id)?'checked':''}>${e(u.name)}</label>`).join('')||'<span class="soft-text">Nenhum usuário disponível.</span>'}</div></div><div class="field field-full"><label>Destinatários de alerta privado</label><div class="checkbox-stack">${(data()?.alertRecipients||state.recipients||[]).filter(r=>r.enabled!==false).map(r=>`<label class="check-label"><input name="alertRecipientIds" type="checkbox" value="${e(r.id)}" ${(c.alertRecipientIds||[]).includes(r.id)?'checked':''}>${e(r.name)} · ${e(r.phone)}</label>`).join('')||'<span class="soft-text">Cadastre destinatários em Alertas. Donos e responsáveis com números cadastrados também recebem os avisos, conforme a configuração do sistema.</span>'}</div></div><div class="field"><label>Máximo de tentativas por envio</label><input name="retryMaxAttempts" type="number" min="1" max="5" value="${e(c.retryPolicy?.maxAttempts||3)}"><span class="field-hint">Inclui a primeira tentativa. Apenas falhas temporárias com envio descartado pela integração permitem repetir.</span></div><div class="field"><label>Intervalo entre tentativas (segundos)</label><input name="retryDelaySeconds" type="number" min="3" max="3600" value="${e(c.retryPolicy?.delaySeconds||15)}"><span class="field-hint">Resultados incertos exigem revisão e nunca são repetidos automaticamente.</span></div></div></div>`;
  }

  async function loadPageData() {
    const page=state.page,request=++state.pageRequest;state.pageLoading=true;
    try {
      const filters={...state.pageFilters,offset:state.pageOffset,limit:state.pageLimit,search:state.search};
      let result;
      if(page==='history')result=await call('historyPage',filters);
      else if(page==='diagnostics')result=await call('diagnosticsPage',filters);
      else if(page==='users')result=await Promise.all([call('listUsers'),call('listRoles')]);
      else if(page==='contacts'){result=await call('listContacts');await contactIntakeUI.load();}
      else if(page==='alerts')result=await Promise.all([call('listAlertRecipients'),call('alertsPage',filters)]);
      else if(page==='buscas'){await buscasUI.load();return;}
      else if(page==='reminders'){await remindersUI.load();return;}
      else return;
      if(request!==state.pageRequest||page!==state.page)return;
      if(page==='users'){[state.users,state.roles]=result;}else if(page==='alerts'){[state.recipients,state.alerts]=result;}else state[page]=result;
    } finally {if(request===state.pageRequest){state.pageLoading=false;render();}}
  }

  function pageControls(result) {
    const total=number(result?.total),offset=number(result?.offset,state.pageOffset),limit=number(result?.limit,state.pageLimit);
    return `<div class="pagination"><span>${total?`${offset+1}–${Math.min(offset+limit,total)} de ${total} registros`:'Nenhum registro'}${state.pageLoading?' · Atualizando…':''}</span><div class="row-actions"><button class="button small" data-action="page-prev" ${offset<=0?'disabled':''}>Anterior</button><button class="button small" data-action="page-next" ${offset+limit>=total?'disabled':''}>Próxima</button>${button('reload-page','Atualizar','small ghost','','refresh')}</div></div>`;
  }
  function dateFilters() {return `<div class="compact-field"><label>De</label><input type="date" data-page-filter="from" value="${e(state.pageFilters.from||'')}"></div><div class="compact-field"><label>Até</label><input type="date" data-page-filter="to" value="${e(state.pageFilters.to||'')}"></div>`;}
  function campaignFilter() {return `<select class="filter-select" aria-label="Filtrar campanha" data-page-filter="campaignId"><option value="">Todas as campanhas</option>${campaigns().map(c=>`<option value="${e(c.id)}" ${state.pageFilters.campaignId===c.id?'selected':''}>${e(c.name)}</option>`).join('')}</select>`;}

  function pendingReviewsPanel() {
    const pending=data()?.pendingReviews;const rows=Array.isArray(pending)?pending:pending?.items||[];const total=Array.isArray(pending)?rows.length:number(pending?.total,rows.length);
    if(!total&&!rows.length)return '';
    return panel('Pendências operacionais preservadas',`<p class="soft-text">${Array.isArray(pending)?`${rows.length} resultado(s) incerto(s) nesta prévia`:`${total} resultado(s) incerto(s)`} continuam bloqueando repetição, mesmo após limpar os históricos. Verifique a conversa no WhatsApp antes de decidir.</p><div class="review-list">${rows.slice(0,5).map(j=>`<div class="review-row"><div><strong>${e(campaign(j.campaignId)?.name||short(j.campaignId))}</strong><small>${e(group(j.groupId)?.name||j.groupId)} · ${e(fmt(j.resultAt||j.createdAt))}</small></div><div class="row-actions">${button('confirm-job','Confirmado','small',j.id,'check')}${button('discard-job','Não repetir','small ghost',j.id,'close')}</div></div>`).join('')}</div>`,button('pending-reviews','Ver todas','small','','history'));
  }
  async function showPendingReviews(offset=0) {
    const result=await call('pendingReviewsPage',{limit:50,offset});state.modal={kind:'pending-reviews',result,reviewOffset:offset};
    showModal('pending-reviews','Revisar resultados incertos','A exclusão de históricos preserva estas pendências de segurança.',`<div class="review-list">${(result.items||[]).map(j=>`<div class="review-row"><div><strong>${e(campaign(j.campaignId)?.name||short(j.campaignId))}</strong><small>${e(group(j.groupId)?.name||j.groupId)} · ${e(fmt(j.resultAt||j.createdAt))}</small><p class="soft-text">${e(j.error||'Resultado não confirmado.')}</p></div><div class="row-actions">${button('confirm-job','Confirmado','small',j.id,'check')}${button('discard-job','Não repetir','small ghost',j.id,'close')}</div></div>`).join('')||'<p class="soft-text">Nenhuma pendência nesta página.</p>'}</div>`,`<span class="soft-text">${number(result.total)} resultado(s) para revisão.</span><div class="row-actions"><button class="button small" data-action="review-prev" ${offset===0?'disabled':''}>Anterior</button><button class="button small" data-action="review-next" ${offset+50>=number(result.total)?'disabled':''}>Próxima</button>${button('close-modal','Fechar','primary')}</div>`);
  }

  function renderReports() {
    const m=data().metrics||{};
    return pageTitle('Resultados das suas campanhas','Relatórios','Totais persistentes das campanhas que seu perfil permite consultar.',button('export-reports','Exportar relatório','','','upload'))+`<div class="stats-grid">${[['Confirmados',m.confirmed||0],['Falhas',m.failed||0],['Incertos',m.uncertain||0],['Campanhas ativas',m.activeCampaigns||0]].map(([label,value])=>`<div class="stat-card"><div class="stat-top">${e(label)}</div><div class="stat-value">${number(value)}</div></div>`).join('')}</div>`+panel('Programação cadastrada',`<div class="table-scroll"><table><thead><tr><th>CAMPANHA</th><th>STATUS</th><th>DESTINOS</th><th>CONTEÚDOS</th><th>PRÓXIMA RODADA</th></tr></thead><tbody>${campaigns().map(c=>`<tr><td>${e(c.name)}</td><td>${badge(c.state)}</td><td>${c.groupIds.length}</td><td>${c.items.length}</td><td>${e(fmt(c.nextRunAt))}</td></tr>`).join('')}</tbody></table></div>`)+`<div class="info-note">A limpeza de históricos remove os registros de consulta selecionados. Estes totais usam o controle operacional preservado para impedir duplicidade. Confirmação indica aceitação pelo serviço, não leitura.</div>`;
  }

  function renderDiagnostics() {
    const result=state.diagnostics||{items:[],total:0};const rows=result.items||[];
    return pageTitle('Entenda e resolva','Diagnóstico','Falhas, tentativas e ações do sistema, com registros limitados pela retenção.',button('export-diagnostics','Exportar registros','','','upload'))+`<div class="toolbar diagnostic-filters">${searchInput('Buscar descrição, código ou rastreamento')}${campaignFilter()}<input class="filter-select" type="text" data-page-filter="code" aria-label="Código do erro" placeholder="Código do erro" value="${e(state.pageFilters.code||'')}">${dateFilters()}</div><div class="toolbar"><select class="filter-select" data-page-filter="userId" aria-label="Filtrar usuário"><option value="">Todos os usuários</option>${campaignUsers().map(u=>`<option value="${e(u.id)}" ${state.pageFilters.userId===u.id?'selected':''}>${e(u.name)}</option>`).join('')}</select><input class="filter-select" type="text" data-page-filter="stage" aria-label="Etapa" placeholder="Etapa da falha" value="${e(state.pageFilters.stage||'')}"></div><div class="panel">${rows.length?`<div class="table-scroll"><table><thead><tr><th>DATA / CAMPANHA</th><th>ETAPA / CÓDIGO</th><th>DESCRIÇÃO</th><th>AÇÃO / TENTATIVAS</th><th></th></tr></thead><tbody>${rows.map(row=>`<tr><td>${e(fmt(row.at||row.createdAt))}<span class="table-subtitle">${e(row.campaignName||campaign(row.campaignId)?.name||'Sistema')}<br>${e(row.userName||campaignUsers().find(u=>u.id===row.userId)?.name||'')}</span></td><td>${e(row.stage||'—')}<span class="table-subtitle">${e(row.code||'—')}</span>${row.traceId?`<span class="table-subtitle trace-id">${e(row.traceId)}</span>`:''}</td><td><span class="diagnostic-description">${e(row.description||row.message||row.error||'—')}</span><span class="table-subtitle">${e(row.guidance||'')}</span></td><td>${e(row.action||'—')}<span class="table-subtitle">${number(row.attempts||row.attempt)} tentativa(s)</span></td><td>${button('copy-diagnostic','Copiar','small ghost',row.id,'copy')}</td></tr>`).join('')}</tbody></table></div>`:empty('shield','Nenhum registro nesta seleção','Os erros relevantes aparecem aqui com horário, código e orientação.')}${pageControls(result)}</div>`;
  }

  function renderUsers() {
    return pageTitle('Acesso e responsabilidades','Usuários e perfis','Cada ação é validada também no serviço local.',button('new-user','Novo usuário','primary','','plus'))+`<div class="panel"><div class="table-scroll"><table><thead><tr><th>USUÁRIO</th><th>PERFIL</th><th>ACESSO</th><th>CAMPANHAS</th><th>AÇÕES</th></tr></thead><tbody>${state.users.map(u=>`<tr><td><span class="table-name">${e(u.name)}</span><span class="table-subtitle">${e(u.username)} · ${e(u.phone||'Sem número de alerta')}</span></td><td>${e(u.roleName||u.roleId)}</td><td>${badge(u.active===false?'stopped':'active')}</td><td>${u.campaignScope==='own'?'Somente as próprias':'Todas as permitidas'}</td><td><div class="row-actions">${button('edit-user','Editar','small',u.id,'edit')}${button('reset-user','Recuperar senha','small ghost',u.id,'shield')}${button('delete-user','Excluir','small danger',u.id,'trash')}</div></td></tr>`).join('')}</tbody></table></div></div>`+panel('Perfis e permissões',`<div class="role-grid">${state.roles.map(r=>`<article class="role-card"><h3>${e(r.name)}</h3><p class="soft-text">${(r.permissions||[]).length} permissões · ${r.campaignScope==='own'?'Campanhas próprias':'Todas as campanhas'}</p><div class="row-actions">${r.id==='role-owner'?'<span class="field-hint">Acesso integral do dono</span>':button('edit-role','Configurar','small',r.id,'edit')}${r.id==='role-owner'?'':button('delete-role','Excluir','small ghost',r.id,'trash')}</div></article>`).join('')}</div>`,button('new-role','Criar perfil','small','','plus'))+(can('audit.view')?panel('Auditoria de acessos e limpezas',`<p class="soft-text">A auditoria fica separada dos históricos que podem ser apagados. Ela registra o usuário e o horário das ações importantes.</p>${button('show-audit','Consultar auditoria','','','history')}`):'');
  }
  const permissionCatalog = () => auth().permissionCatalog || data()?.permissionCatalog || [];
  function permissionFields(selected=[],overrides) {
    const catalog=permissionCatalog();const sections=[...new Set(catalog.map(p=>p.section))];
    return sections.map(section=>`<fieldset class="permission-section"><legend>${e(section)}</legend><div class="permission-grid">${catalog.filter(p=>p.section===section).map(p=>overrides?`<label class="permission-override"><span>${e(p.label)}</span><select name="permission-${e(p.id)}"><option value="inherit">Herdar perfil</option><option value="allow" ${overrides[p.id]===true?'selected':''}>Permitir</option><option value="deny" ${overrides[p.id]===false?'selected':''}>Negar</option></select></label>`:`<label class="check-label"><input type="checkbox" name="permissions" value="${e(p.id)}" ${selected.includes(p.id)?'checked':''}>${e(p.label)}</label>`).join('')}</div></fieldset>`).join('');
  }
  function showUserEditor(id) {
    const u=state.users.find(x=>x.id===id)||{};state.modal={kind:'user',userId:id};
    showModal('user',id?'Editar usuário':'Criar usuário','O último dono nunca pode ser removido ou desativado.',`<form id="user-form"><div class="field-grid">${field('Nome','name',u.name,'text','required maxlength="120"')}${field('Usuário','username',u.username,'text','required maxlength="64"')}${!id?field('Senha inicial (mínimo 12 caracteres)','password','','password','required minlength="12" autocomplete="new-password"'):''}${field('WhatsApp para alertas (país + DDD)','phone',u.phone,'tel','placeholder="5511999999999"')}<div class="field"><label>Perfil</label><select name="roleId">${state.roles.map(r=>`<option value="${e(r.id)}" ${(u.roleId||'role-seller')===r.id?'selected':''}>${e(r.name)}</option>`).join('')}</select></div><div class="field"><label>Campanhas visíveis</label><select name="campaignScope"><option value="own" ${(u.campaignScope==='own'||!id)?'selected':''}>Somente as próprias</option><option value="all" ${(u.campaignScope!=='own'&&id)?'selected':''}>Todas, conforme permissões</option></select></div></div><label class="check-label"><input type="checkbox" name="active" ${u.active!==false?'checked':''}> Acesso ativo</label><label class="check-label"><input type="checkbox" name="requirePasswordChange" ${u.requirePasswordChange!==false?'checked':''}> Exigir nova senha no próximo acesso</label><details class="permission-details"><summary>Permissões individuais</summary>${permissionFields([],u.permissionOverrides||{})}</details></form>`,`${button('close-modal','Cancelar','ghost')}${button('save-user','Salvar usuário','primary','','check')}`);
  }
  function showRoleEditor(id) {
    const r=state.roles.find(x=>x.id===id)||{};state.modal={kind:'role',roleId:id};
    showModal('role',id?'Editar perfil':'Novo perfil','As permissões individuais do usuário podem restringir ou ampliar este perfil.',`<form id="role-form"><div class="field-grid">${field('Nome do perfil','name',r.name,'text','required maxlength="80"')}<div class="field"><label>Escopo padrão de campanhas</label><select name="campaignScope"><option value="own" ${r.campaignScope==='own'?'selected':''}>Somente as próprias</option><option value="all" ${r.campaignScope!=='own'?'selected':''}>Todas</option></select></div></div>${permissionFields(r.permissions||[])}</form>`,`${button('close-modal','Cancelar','ghost')}${button('save-role','Salvar perfil','primary','','check')}`);
  }

  function renderContacts() {
    const rows=(state.contacts||[]).filter(c=>`${c.name} ${c.phone}`.toLowerCase().includes(state.search.toLowerCase()));
    return pageTitle('Sua agenda local','Contatos','Cadastre números autorizados. Campanhas continuam enviando somente para os grupos selecionados.',button('new-contact','Novo contato','primary','','plus'))+`<div class="toolbar">${searchInput('Buscar nome ou número')}</div>`+contactIntakeUI.render()+panel('Contatos cadastrados',rows.length?`<div class="table-scroll"><table><thead><tr><th>NOME</th><th>NÚMERO</th><th>CLASSIFICAÇÃO / NOTAS</th><th>AÇÕES</th></tr></thead><tbody>${rows.map(c=>`<tr><td>${e(c.name)}</td><td>${e(c.phone)}</td><td>${e(c.category||'Sem classificação')}<span class="table-subtitle">${e(c.notes||'')} · Salvo no sistema</span></td><td><div class="row-actions">${button('edit-contact','Editar','small',c.id,'edit')}${button('delete-contact','Excluir','small ghost',c.id,'trash')}</div></td></tr>`).join('')}</tbody></table></div>`:empty('groups','Sua agenda está vazia','Adicione contatos locais com país e DDD.'));
  }
  function showContactEditor(id) {
    const c=(state.contacts||[]).find(x=>x.id===id)||{};state.modal={kind:'contact',contactId:id};
    showModal('contact',id?'Editar contato':'Novo contato','Os contatos são armazenados neste computador.',`<form id="contact-form"><div class="field-grid">${field('Nome','name',c.name,'text','required maxlength="140"')}${field('Número com país e DDD','phone',c.phone,'tel','required placeholder="5511999999999"')}<div class="field field-full"><label>Classificação</label><select name="category"><option value="">Sem classificação</option>${['Cliente Nerópolis','Lojista Camelódromo'].map(value=>`<option ${c.category===value?'selected':''}>${e(value)}</option>`).join('')}</select></div><div class="field field-full"><label>Notas</label><textarea name="notes" maxlength="1000">${e(c.notes||'')}</textarea></div></div></form>`,`${button('close-modal','Cancelar','ghost')}${button('save-contact','Salvar contato','primary','','check')}`,true);
  }

  const privateStatus = record => record?.readAt?'Lido':record?.deliveredAt||record?.status==='delivered'?'Entregue':({pending:'Pendente',sending:'Enviando',confirmed:'Enviado — confirmado pelo servidor',uncertain:'Incerto — revisar',failed:'Falhou',cancelled:'Cancelado'})[record?.status]||'Nenhum envio';
  function renderAlerts() {
    const result=state.alerts||{items:[],total:0};const rows=result.items||[];
    const latest=id=>rows.filter(r=>r.recipientId===id).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0))[0];
    const recipientsBody=state.recipients.length?`<div class="table-scroll"><table><thead><tr><th>DESTINATÁRIO</th><th>NÚMERO</th><th>ÚLTIMO ENVIO</th><th>AÇÕES</th></tr></thead><tbody>${state.recipients.map(r=>`<tr><td>${e(r.name)}<span class="table-subtitle">${r.enabled===false?'Cadastro desativado':'Cadastro ativo'}</span></td><td>${e(r.phone)}</td><td>${e(privateStatus(latest(r.id)))}<span class="table-subtitle">${e(latest(r.id)?.error||'')}</span></td><td><div class="row-actions">${button('edit-recipient','Editar','small',r.id,'edit')}${r.enabled!==false?button('test-recipient','Testar envio','small',r.id,'send'):''}${button('delete-recipient','Excluir','small ghost',r.id,'trash')}</div></td></tr>`).join('')}</tbody></table></div>`:empty('whatsapp','Cadastre quem deve ser avisado','Donos ativos com número cadastrado também recebem avisos. Selecione responsáveis nas configurações e nas campanhas.');
    const records=rows.length?`<div class="table-scroll"><table><thead><tr><th>OCORRÊNCIA ORIGINAL</th><th>CAMPANHA / DESTINO</th><th>RESULTADO DO AVISO</th><th>DETALHES / RASTREAMENTO</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${e(fmt(r.failureAt||r.originalAt||r.createdAt))}<span class="table-subtitle">${e(r.code||r.errorCode||'')}</span></td><td>${e(r.campaignName||campaign(r.campaignId)?.name||(r.code==='ALERT_TEST'?'Teste de alerta':'Aviso do sistema'))}<span class="table-subtitle">${e(r.number||r.phone||r.recipientPhone||r.channel||'')}</span></td><td><span class="delivery-status ${e(r.status)}">${e(privateStatus(r))}</span><span class="table-subtitle">${r.simulation?'Simulação — sem envio real':''}</span></td><td>${e(r.error||r.reason||'—')}<span class="table-subtitle trace-id">${e(r.traceId||r.occurrenceId||r.id)}</span><div class="row-actions">${r.status==='uncertain'?`${button('confirm-alert','Verifiquei o envio','small',r.id,'check')}${button('discard-alert','Verifiquei que não foi enviado','small ghost',r.id,'close')}`:''}${r.status==='failed'&&r.retryEligible?button('retry-alert','Tentar novamente','small',r.id,'refresh'):''}${button('silence-alert','Silenciar som','small ghost',r.occurrenceId||r.id)}</div></td></tr>`).join('')}</tbody></table></div>${pageControls(result)}`:empty('whatsapp','Nenhum alerta nesta seleção','Falhas críticas e desconexões geram ocorrência local e os avisos privados configurados.');
    return pageTitle('Avise as pessoas certas','Alertas privados','Ocorrência e envio são registrados separadamente. O horário original permanece após reconectar.',`<div class="row-actions">${button('test-alert','Enviar alerta de teste','','','send')}${button('new-recipient','Novo destinatário','primary','','plus')}</div>`)+`<div class="info-note">A notificação local e o som aparecem imediatamente em desconexões. O WhatsApp privado aguarda reconexão. Enviado exige confirmação do servidor; Entregue depende de recibo real. Em simulação, nenhuma mensagem chega a uma conta real.</div>`+panel('Destinatários de alerta',recipientsBody)+`<div class="toolbar"><select class="filter-select" data-page-filter="status" aria-label="Filtrar alertas"><option value="">Todos os alertas</option>${['pending','sending','confirmed','delivered','uncertain','failed'].map(v=>`<option value="${v}" ${state.pageFilters.status===v?'selected':''}>${e(privateStatus({status:v}))}</option>`).join('')}</select>${campaignFilter()}</div>`+panel('Ocorrências e resultados',records);
  }
  function showRecipientEditor(id) {
    const r=state.recipients.find(x=>x.id===id)||{};state.modal={kind:'recipient',recipientId:id};
    showModal('recipient',id?'Editar destinatário':'Novo destinatário','Informe país, DDD e número. Não enviaremos nada ao salvar.',`<form id="recipient-form"><div class="field-grid">${field('Nome','name',r.name,'text','required maxlength="140"')}${field('Número WhatsApp','phone',r.phone,'tel','required placeholder="5511999999999"')}</div><label class="check-label"><input type="checkbox" name="enabled" ${r.enabled!==false?'checked':''}> Receber alertas</label></form>`,`${button('close-modal','Cancelar','ghost')}${button('save-recipient','Salvar destinatário','primary','','check')}`,true);
  }

  async function showCleanup() {
    state.modal={kind:'cleanup',categories:['campaigns','sends','errors','notifications']};
    await renderCleanup();
  }
  async function renderCleanup() {
    const categories=state.modal?.categories||[];const result=categories.length?await call('cleanupPreview',{categories}):{counts:{},protected:0,total:0};
    state.modal={...state.modal,kind:'cleanup',preview:result};
    const counts=result.counts?.counts||result.counts||{};
    showModal('cleanup','Apagar todos os históricos','A limpeza não remove campanhas, usuários, grupos, contatos, mídias ou configurações.',`<form id="cleanup-form"><div class="warning-note">Registros operacionais necessários para evitar duplicidade permanecem protegidos. A auditoria de quem realizou esta limpeza fica em uma área separada.</div><div class="checkbox-stack">${[['campaigns','Históricos de campanhas'],['sends','Registros de envios'],['errors','Erros e diagnóstico'],['notifications','Histórico de notificações']].map(([key,label])=>`<label class="check-label"><input type="checkbox" data-cleanup-category="${key}" ${categories.includes(key)?'checked':''}>${label}<span class="muted">${number(typeof counts[key]==='object'?counts[key].count:counts[key])} registro(s)</span></label>`).join('')}</div><p class="soft-text">${typeof result.protected==='boolean'?'O controle operacional será preservado.':`${number(result.protected||result.protectedCount)} registro(s) operacional(is) preservado(s).`} ${e(result.description||'Selecione as categorias que deseja remover.')}</p><div class="settings-actions">${button('export-cleanup','Exportar antes de excluir','','','upload')}${button('refresh-cleanup','Atualizar prévia','ghost','','refresh')}</div><div class="subtle-divider"></div>${field('Digite APAGAR para confirmar','confirmation','','text','required autocomplete="off" placeholder="APAGAR"')}</form>`,`${button('close-modal','Cancelar','ghost')}${button('confirm-cleanup','Apagar selecionados','danger','','trash')}`,true);
  }

  function enhancedSettings(s) {
    const sound={enabled:true,volume:70,sound:'soft',events:['disconnect','critical'],repeat:false,intervalSeconds:30,maxRepeats:3,quiet:{enabled:false,start:'22:00',end:'07:00'},...s.sound};
    const reconnect={enabled:false,maxAttempts:3,delaySeconds:15,autoResume:false,...s.reconnect};
    const retention={days:30,maxEntries:10000,maxMegabytes:32,...s.retention};
    return `<div class="settings-grid">${panel('Desconexão e retomada',`<div class="checkbox-stack"><label class="check-label"><input name="reconnectEnabled" type="checkbox" ${reconnect.enabled?'checked':''}> Reconectar automaticamente com limite de tentativas</label><label class="check-label"><input name="autoResume" type="checkbox" ${reconnect.autoResume?'checked':''}> Retomar automaticamente campanhas pausadas por desconexão</label><label class="check-label"><input name="nativeEnabled" type="checkbox" ${s.notifications?.nativeEnabled!==false?'checked':''}> Exibir notificações nativas do Windows</label></div><div class="field-grid settings-spaced">${field('Tentativas de reconexão','reconnectMaxAttempts',reconnect.maxAttempts,'number','min="1" max="10"')}${field('Intervalo de reconexão (segundos)','reconnectDelaySeconds',reconnect.delaySeconds,'number','min="3" max="3600"')}</div><div class="info-note">As notificações e os sons dependem de o aplicativo estar em execução, inclusive na bandeja, e das permissões e ajustes de volume do Windows. Campanhas pausadas manualmente não devem ser retomadas automaticamente.</div>`)}${panel('Sons de alerta',`<label class="check-label"><input name="soundEnabled" type="checkbox" ${sound.enabled?'checked':''}> Ativar alerta sonoro</label><div class="field settings-spaced"><label for="sound-volume">Volume <output id="sound-volume-value">${number(sound.volume,70)}%</output></label><input id="sound-volume" name="soundVolume" type="range" min="0" max="100" value="${number(sound.volume,70)}"><span class="field-hint">Respeita o volume e o estado de mudo do Windows.</span></div><div class="field settings-spaced"><label>Som</label><select name="soundName"><option value="soft" ${sound.sound==='soft'?'selected':''}>Toque suave</option><option value="urgent" ${sound.sound==='urgent'?'selected':''}>Sinal urgente</option><option value="custom" ${sound.sound==='custom'?'selected':''}>Arquivo personalizado</option></select><span class="field-hint" id="custom-audio-label">${e(sound.customAudioName||s.customAudioName||'Nenhum arquivo personalizado importado')}</span></div><div class="settings-actions settings-spaced">${button('import-audio','Carregar áudio','small','','upload')}${button('test-sound','Testar som','small','','play')}</div><div class="checkbox-stack settings-spaced"><label class="check-label"><input name="soundDisconnect" type="checkbox" ${sound.events?.includes('disconnect')?'checked':''}> Emitir som por desconexão</label><label class="check-label"><input name="soundCritical" type="checkbox" ${sound.events?.includes('critical')?'checked':''}> Emitir som por erro crítico</label><label class="check-label"><input name="soundRepeat" type="checkbox" ${sound.repeat?'checked':''}> Repetir o alerta, sem sons simultâneos</label></div><div class="field-grid settings-spaced">${field('Intervalo entre sons (segundos)','soundIntervalSeconds',sound.intervalSeconds,'number','min="5" max="3600"')}${field('Limite de repetições','soundMaxRepeats',sound.maxRepeats,'number','min="1" max="20"')}</div><label class="check-label"><input name="quietEnabled" type="checkbox" ${sound.quiet?.enabled?'checked':''}> Ativar horário silencioso</label><div class="field-grid settings-spaced">${field('Silêncio a partir de','quietStart',sound.quiet?.start||'22:00','time')}${field('Silêncio até','quietEnd',sound.quiet?.end||'07:00','time')}</div>`)}${panel('Históricos e retenção',`<p class="soft-text">Limite os registros de diagnóstico para reduzir espaço e consumo de memória. O controle operacional de envios permanece protegido.</p><div class="field-grid">${field('Retenção (dias)','retentionDays',retention.days,'number','min="1" max="3650"')}${field('Máximo de registros','retentionMaxEntries',retention.maxEntries,'number','min="100" max="100000"')}${field('Limite de diagnóstico (MB)','retentionMaxMegabytes',retention.maxMegabytes,'number','min="1" max="512"')}</div><div class="settings-actions">${button('export-history','Exportar históricos','','','upload')}${button('clear-history','Apagar todos os históricos','danger','','trash')}</div>`)}${panel('Destinatários dos avisos',`<p class="soft-text">Cadastre números privados com país e DDD, teste o alerta e selecione os destinatários de cada campanha. Se houver desconexão, o aviso aguarda reconexão.</p>${button('navigate','Gerenciar destinatários','','alerts','whatsapp')}<div class="checkbox-stack settings-spaced">${(data().alertRecipients||[]).filter(r=>r.enabled!==false).map(r=>`<label class="check-label"><input name="systemAlertRecipientIds" value="${e(r.id)}" type="checkbox" ${(Array.isArray(s.systemAlertRecipientIds)?s.systemAlertRecipientIds.includes(r.id):true)?'checked':''} ${can('notifications.manage')?'':'disabled'}>${e(r.name)} · ${e(r.phone)}</label>`).join('')}</div><p class="field-hint">Destinatários acima recebem avisos gerais de desconexão e falha crítica. Donos ativos com telefone recebem avisos por padrão. Destinos de cada campanha permanecem na própria campanha.</p><div class="subtle-divider"></div><h3>Tentativas de alertas</h3><div class="field-grid">${field('Limite de tentativas','alertMaxAttempts',s.alertRetryPolicy?.maxAttempts||3,'number','min="1" max="5"')}${field('Intervalo das tentativas (segundos)','alertRetryDelay',s.alertRetryPolicy?.delaySeconds||15,'number','min="3" max="3600"')}</div><p class="field-hint">Somente falhas comprovadamente anteriores ao envio podem ser repetidas. Resultados incertos exigem revisão.</p><h3>Canal independente (opcional)</h3><label class="check-label"><input type="checkbox" name="webhookEnabled" ${s.webhook?.enabled?'checked':''}> Enviar a ocorrência para um endpoint HTTPS</label><div class="settings-spaced">${field('Endereço HTTPS','webhookUrl',s.webhook?.url||'','text','placeholder="https://seu-servico.example/alertas"')}</div><div class="settings-spaced">${field('Token de autorização (opcional)','webhookToken','','password','autocomplete="new-password" placeholder="Deixe vazio para manter o token atual"')}</div><p class="field-hint">Requer um serviço externo configurado por você. A confirmação de entrega ao endpoint é registrada separadamente. O token usa proteção do sistema e fica fora dos backups comuns.</p>` )}</div>`;
  }

  function collectSound(form=$('#settings-form')) {
    const get=name=>form.elements.namedItem(name);
    return {enabled:get('soundEnabled').checked,volume:number(get('soundVolume').value,70),sound:get('soundName').value,customAudioId:state.customAudioId||settings().sound?.customAudioId,customAudioName:state.customAudioName||settings().sound?.customAudioName,events:[get('soundDisconnect').checked?'disconnect':null,get('soundCritical').checked?'critical':null].filter(Boolean),repeat:get('soundRepeat').checked,intervalSeconds:number(get('soundIntervalSeconds').value,30),maxRepeats:number(get('soundMaxRepeats').value,3),quiet:{enabled:get('quietEnabled').checked,start:get('quietStart').value,end:get('quietEnd').value}};
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
    return {id:uid(),name:'',state:'draft',mode:'repeat',intervalMinutes:10,spacingSeconds:5,schedule:{days:[1,2,3,4,5],startTime:'08:00',endTime:'18:00',startDate:'',endDate:''},dailyRoundLimit:0,dailySendLimit:0,groupIds:[],items:[],groupOverrides:{},ownerId:auth().user?.id,responsibleUserIds:[],alertRecipientIds:[],retryPolicy:{maxAttempts:3,delaySeconds:15},revision:0,configRevision:0};
  }

  function editCampaign(id,template) {
    state.draft = id ? clone(campaign(id)) : defaultCampaign();
    if (!state.draft) throw new Error('Campanha não encontrada.');
    if (template) {state.draft.items = clone(template.items||[]).map(item=>({...item,id:uid()}));state.draft.name = template.name;if(template.audience)state.draft.audience=template.audience;state.draft.inventoryIds=template.inventoryIds||[];state.draft.items=state.draft.items.map((item,index)=>({...item,templateId:template.templateId||template.id,sourceTemplateItemId:template.items[index].sourceTemplateItemId||template.items[index].id}));}
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

  function commercialCampaignFields(c) {
    const policy=c.promotionPolicy||{};return `<div class="form-section"><div class="section-heading"><h3>Público e contatos privados</h3></div><div class="field-grid"><div class="field"><label>Público do anúncio</label><select name="audience"><option value="general"${!c.audience||c.audience==='general'?' selected':''}>Geral</option><option value="retail"${c.audience==='retail'?' selected':''}>Varejo — Cliente Nerópolis</option><option value="wholesale"${c.audience==='wholesale'?' selected':''}>Atacado — Lojista Camelódromo</option></select></div><div class="field"><label>Limite de repetição por conteúdo e destino (0 = sem limite adicional)</label><input type="number" name="promotionRepeatLimit" min="0" max="100000" value="${e(policy.repeatLimit??0)}"></div></div><div class="check-grid">${(data().contacts||[]).filter(x=>x.promotionalConsent===true).map(x=>`<label class="check-label"><input type="checkbox" name="contactIds" value="${e(x.id)}" ${(c.contactIds||[]).includes(x.id)?'checked':''}>${e(x.name)} · ${e(x.phone)}</label>`).join('')||'<p class="soft-text">Cadastre contatos e registre autorização para receber mensagens promocionais. Nenhum contato novo recebe autorização automática.</p>'}</div>${(c.contactIds||[]).filter(id=>!data().contacts?.some(x=>x.id===id&&x.promotionalConsent===true)).length?'<div class="warning-note">Há destinos anteriores sem autorização atual. Revise o cadastro antes de ativar.</div>':''}</div>`;
  }

  function renderCampaignEditor() {
    const c = state.draft;
    const active = c.state==='active';
    const body = `${active?'<div class="warning-note">Esta campanha está em execução. Alterações de conteúdo e destinos exigem resumo e confirmação antes de salvar.</div>':''}<form id="campaign-form"><div class="form-section"><div class="section-heading"><h3><span class="section-index">01</span>Identificação</h3>${badge(c.state)}</div><div class="field"><label for="campaign-name">Nome da campanha</label><input type="text" name="name" id="campaign-name" required maxlength="140" placeholder="Ex.: Avisos da comunidade" value="${e(c.name)}"></div></div><div class="form-section"><div class="section-heading"><h3><span class="section-index">02</span>Conteúdo e ordem de envio</h3><button type="button" class="text-button" data-action="save-template">Salvar modelo</button></div><div class="field-grid"><div class="field field-full"><label for="content-mode">Modo de conteúdo</label><select name="mode" id="content-mode"><option value="repeat"${c.mode==='repeat'?' selected':''}>Repetir todo o conjunto em cada rodada</option><option value="rotate"${c.mode==='rotate'?' selected':''}>Alternar: próximo item da sequência a cada rodada</option></select><span class="field-hint">No modo alternado, cada grupo recebe o próximo item da sequência quando participa de uma rodada. Intervalos individuais podem deixar os grupos em posições diferentes.</span></div></div>${c.items.length?c.items.map((item,index)=>itemEditor(item,index)).join(''):'<p class="soft-text">Sua sequência ainda está vazia. Adicione textos ou arquivos abaixo.</p>'}<div class="content-add">${button('add-text','Adicionar texto','small','','plus')}${button('add-media','Escolher mídia da biblioteca','small','','library')}${button('import-editor-media','Importar arquivos','small ghost','','upload')}</div><p class="field-hint" style="margin-bottom:0">Formatação WhatsApp: *negrito*, _itálico_, ~tachado~ e blocos de código. Arquivos importados são copiados para a pasta gerenciada.</p></div><div class="form-section"><div class="section-heading"><h3><span class="section-index">03</span>Grupos de destino</h3><span class="count-label" id="selected-count">${c.groupIds.length} / ${selectedLimit()} selecionados</span></div><div class="search-input" style="max-width:none;margin-bottom:13px">${icon('search')}<input type="text" id="editor-group-search" placeholder="Buscar entre os grupos autorizados…" aria-label="Buscar grupos autorizados"></div><div id="editor-group-options">${editorGroups('')}</div>${permittedGroups().length?'':'<p class="field-hint">Nenhum grupo autorizado nesta integração. Vá para Grupos e declare a autorização antes de selecionar destinos.</p>'}</div><div class="form-section"><div class="section-heading"><h3><span class="section-index">04</span>Frequência e limites</h3></div><div class="field-grid"><div class="field"><label for="round-interval">Intervalo entre o início das rodadas (minutos)</label><input id="round-interval" name="intervalMinutes" type="number" min="1" max="10080" required value="${e(c.intervalMinutes)}"><span class="field-hint">Padrão: 10 minutos. Se a rodada atrasar, não acumula outra.</span></div><div class="field"><label for="group-spacing">Espaçamento entre grupos (segundos)</label><input id="group-spacing" name="spacingSeconds" type="number" min="3" max="3600" required value="${e(c.spacingSeconds)}"><span class="field-hint">A integração pode exigir um espaçamento mínimo maior.</span></div><div class="field"><label for="round-limit">Máximo de rodadas por dia</label><input id="round-limit" name="dailyRoundLimit" type="number" min="0" max="10000" value="${e(c.dailyRoundLimit||0)}"><span class="field-hint">0 = sem limite adicional.</span></div><div class="field"><label for="send-limit">Máximo de envios por dia</label><input id="send-limit" name="dailySendLimit" type="number" min="0" max="100000" value="${e(c.dailySendLimit||0)}"><span class="field-hint">Cada mensagem ou mídia para um grupo conta como um envio.</span></div></div></div><div class="form-section"><div class="section-heading"><h3><span class="section-index">05</span>Dias e horário de funcionamento</h3></div>${scheduleFields(c.schedule)}<span class="field-hint">Fuso horário local do Windows. Horários que atravessam meia-noite dependem da validação do agendador.</span></div><div class="form-section"><div class="section-heading"><h3><span class="section-index">06</span>Configurações específicas por grupo</h3></div><p class="soft-text">Opcional: configure conteúdo, intervalo e horário distintos para os grupos selecionados.</p><div id="editor-overrides">${overrideCards()}</div></div>${commercialCampaignFields(c)}${campaignManagementFields(c)}</form>`;
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
    if (form.elements.ownerId) c.ownerId = get('ownerId');
    c.responsibleUserIds = $$('[name="responsibleUserIds"]:checked',form).map(el=>el.value);
    c.alertRecipientIds = $$('[name="alertRecipientIds"]:checked',form).map(el=>el.value);
    c.retryPolicy = {maxAttempts:number(get('retryMaxAttempts'),3),delaySeconds:number(get('retryDelaySeconds'),15)};
    c.audience=get('audience')||c.audience||'general';c.contactIds=$$('[name=contactIds]:checked',form).map(x=>x.value);c.promotionPolicy={...(c.promotionPolicy||{}),repeatLimit:number(get('promotionRepeatLimit'),0)};
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
    if (!canAction(action)) throw new Error('Seu perfil não permite esta ação.');
    if(action==='backup-business'){const result=await call('backupBusinessData');if(!result.cancelled)toast('Banco verificado salvo. Guarde também a pasta media para recuperação.');return;}
    if(action.startsWith('commerce-'))return commerceUI.onAction(action,el);
    if(action.startsWith('finance-'))return financeUI.onAction(action,el);
    if(action.startsWith('buscas-'))return buscasUI.onAction(action,el);
    if(action.startsWith('library-'))return libraryUI.onAction(action,el);
    if(action.startsWith('reminders-'))return remindersUI.onAction(action,el);
    if(action.startsWith('contact-intake-'))return contactIntakeUI.onAction(action,el.dataset.id);
    switch(action) {
      case 'auth-recovery': state.authScreen='recovery';state.authKey=null;render();break;
      case 'auth-login': state.authScreen='login';state.authKey=null;render();break;
      case 'logout': await call('logout');closeModal();buscasUI.reset();libraryUI.reset();remindersUI.reset();contactIntakeUI.reset();state.users=[];state.roles=[];state.contacts=[];state.recipients=[];state.history=null;state.diagnostics=null;state.authScreen=null;state.settingsDirty=false;state.page='dashboard';await refresh();break;
      case 'account': {
        state.modal={kind:'account'};
        showModal('account','Minha conta','Troque sua senha ou gere novos códigos de recuperação.',`<form id="account-form">${field('Senha atual','currentPassword','','password','required autocomplete="current-password"')}${field('Nova senha (mínimo 12 caracteres)','newPassword','','password','minlength="12" autocomplete="new-password"')}${field('Confirme a nova senha','confirmPassword','','password','minlength="12" autocomplete="new-password"')}</form>`,`${button('rotate-recovery','Novos códigos','','','shield')}${button('save-password','Alterar senha','primary','','check')}`,true);break;
      }
      case 'save-password': {
        const f=$('#account-form');if(!f.reportValidity())break;if(f.elements.newPassword.value!==f.elements.confirmPassword.value)throw new Error('A confirmação da senha não confere.');
        await perform('changePassword',{currentPassword:f.elements.currentPassword.value,newPassword:f.elements.newPassword.value},'Senha alterada.');closeModal();break;
      }
      case 'rotate-recovery': {
        const f=$('#account-form');if(!f.elements.currentPassword.value)throw new Error('Informe sua senha atual.');const result=await call('rotateRecoveryCodes',{currentPassword:f.elements.currentPassword.value});showRecoveryCodes(result.recoveryCodes,'Novos códigos de recuperação');break;
      }
      case 'copy-recovery': await copyText(state.modal.codes.join('\n'));break;
      case 'download-recovery': downloadText(`Kenned Code Disparos — códigos de recuperação\nUsuário: ${auth().user?.username||''}\nGuarde este arquivo em um local seguro.\n\n${state.modal.codes.join('\n')}\n`,'Kenned-Code-Disparos-Codigos-de-Recuperacao.txt');break;
      case 'pending-reviews': await showPendingReviews();break;
      case 'review-prev': await showPendingReviews(Math.max(0,state.modal.reviewOffset-50));break;
      case 'review-next': await showPendingReviews(state.modal.reviewOffset+50);break;
      case 'page-prev': state.pageOffset=Math.max(0,state.pageOffset-state.pageLimit);await loadPageData();break;
      case 'page-next': state.pageOffset+=state.pageLimit;await loadPageData();break;
      case 'reload-page': await loadPageData();break;
      case 'export-reports': {const result=await call('exportReports');if(!result?.cancelled)toast('Relatório exportado.');break;}
      case 'export-history': {const result=await call('exportHistory',{...state.pageFilters,search:state.search,categories:state.page==='history'?state.pageFilters.categories||['sends']:['campaigns','sends','errors','notifications']});if(!result?.cancelled)toast(`${number(result.count)} registros exportados.`);break;}
      case 'export-diagnostics': {const result=await call('exportDiagnostics',{...state.pageFilters,search:state.search});if(!result?.cancelled)toast(`${number(result.count)} registros exportados.`);break;}
      case 'copy-diagnostic': {const row=state.diagnostics?.items?.find(x=>x.id===id);if(row)await copyText(JSON.stringify(row,null,2));break;}
      case 'new-user': showUserEditor();break;
      case 'edit-user': showUserEditor(id);break;
      case 'save-user': {
        const f=$('#user-form');if(!f.reportValidity())break;const permissionOverrides={};
        for(const p of permissionCatalog()){const value=f.elements.namedItem(`permission-${p.id}`)?.value;if(value&&value!=='inherit')permissionOverrides[p.id]=value==='allow';}
        const user={id:state.modal.userId,name:f.elements.name.value,username:f.elements.username.value,phone:f.elements.phone.value.replace(/[+\s()-]/g,''),roleId:f.elements.roleId.value,campaignScope:f.elements.campaignScope.value,active:f.elements.active.checked,requirePasswordChange:f.elements.requirePasswordChange.checked,permissionOverrides};
        if(f.elements.password)user.password=f.elements.password.value;
        await perform(user.id?'updateUser':'createUser',{user},'Usuário salvo.');closeModal();break;
      }
      case 'delete-user': if(confirm('Excluir este usuário? As campanhas e a auditoria serão preservadas.'))await perform('deleteUser',{id},'Usuário excluído.');break;
      case 'reset-user': {
        if(!confirm('Emitir um código de recuperação de uso único para este usuário? Entregue o código por um meio seguro.'))break;
        const result=await call('issueReset',{userId:id});state.modal={kind:'reset',codes:[result.code]};
        showModal('reset','Código temporário de recuperação',`Válido até ${fmt(result.expiresAt)}.`, `<pre class="summary-pre secret-codes">${e(result.code)}</pre><p class="soft-text">Informe ao usuário para abrir Recuperar acesso na tela de login. O código não será exibido novamente.</p>`,`${button('copy-recovery','Copiar código','','','copy')}${button('close-modal','Fechar','primary')}`,true);break;
      }
      case 'new-role': showRoleEditor();break;
      case 'edit-role': showRoleEditor(id);break;
      case 'save-role': {
        const f=$('#role-form');if(!f.reportValidity())break;const role={id:state.modal.roleId,name:f.elements.name.value,campaignScope:f.elements.campaignScope.value,permissions:$$('[name="permissions"]:checked',f).map(x=>x.value)};
        await perform('saveRole',{role},'Perfil salvo.');closeModal();break;
      }
      case 'delete-role': if(confirm('Excluir este perfil? Perfis em uso ou essenciais não podem ser excluídos.'))await perform('deleteRole',{id},'Perfil excluído.');break;
      case 'show-audit': {
        const result=await call('auditPage',{limit:100,offset:0});state.audit=result;state.modal={kind:'audit'};
        showModal('audit','Auditoria separada','As últimas 100 ações. A limpeza de históricos preserva esta auditoria.',`<div class="table-scroll"><table><thead><tr><th>DATA</th><th>USUÁRIO</th><th>AÇÃO</th><th>DETALHES</th></tr></thead><tbody>${(result.items||[]).map(r=>`<tr><td>${e(fmt(r.at||r.createdAt))}</td><td>${e(r.userName||r.actorName||r.username||campaignUsers().find(u=>u.id===(r.actorId||r.userId))?.name||r.actorId||r.userId||'Sistema')}</td><td>${e(r.action||r.type||'—')}</td><td>${e(JSON.stringify(r.details||r.detail||r.metadata||{}))}</td></tr>`).join('')}</tbody></table></div>`,button('close-modal','Fechar','primary'));break;
      }
      case 'new-contact': showContactEditor();break;
      case 'edit-contact': showContactEditor(id);break;
      case 'save-contact': {
        const f=$('#contact-form');if(!f.reportValidity())break;await perform('saveContact',{contact:{id:state.modal.contactId,name:f.elements.name.value,phone:f.elements.phone.value.replace(/[+\s()-]/g,''),notes:f.elements.notes.value,category:f.elements.category.value}},'Contato salvo no cadastro do sistema.');closeModal();break;
      }
      case 'delete-contact': if(confirm('Excluir este contato da agenda local?'))await perform('deleteContact',{id},'Contato excluído.');break;
      case 'new-recipient': showRecipientEditor();break;
      case 'edit-recipient': showRecipientEditor(id);break;
      case 'save-recipient': {
        const f=$('#recipient-form');if(!f.reportValidity())break;await perform('saveAlertRecipient',{recipient:{id:state.modal.recipientId,name:f.elements.name.value,phone:f.elements.phone.value.replace(/[+\s()-]/g,''),enabled:f.elements.enabled.checked}},'Destinatário salvo.');closeModal();break;
      }
      case 'delete-recipient': if(confirm('Excluir este destinatário de alertas?'))await perform('deleteAlertRecipient',{id},'Destinatário excluído.');break;
      case 'test-recipient': {const result=await perform('testAlertRecipient',{id});toast(privateStatus(result)+(result?.error?' · '+result.error:''),['failed','uncertain'].includes(result?.status));break;}
      case 'test-alert': {const result=await perform('testAlert',{event:'critical'});const records=result.alerts||[];toast(records.length?records.map(r=>(r.number||'Destino')+': '+privateStatus(r)).join(' · '):'Ocorrência registrada. Cadastre um número para receber o privado.');break;}
      case 'retry-alert': {const result=await perform('retryAlert',{id});toast(privateStatus(result)+(result?.error?' · '+result.error:''),['failed','uncertain'].includes(result?.status));break;}
      case 'confirm-alert': case 'discard-alert': if(confirm(action==='confirm-alert'?'Você verificou no WhatsApp que este alerta foi enviado?':'Marcar este alerta para não repetir?'))await perform('reviewAlert',{id,confirmed:action==='confirm-alert',decision:action==='confirm-alert'?'confirm':'discard'},'Alerta revisado.');break;
      case 'silence-alert': await call('silenceAlert',{id,occurrenceId:id});toast('Este alerta foi silenciado.');break;
      case 'clear-history': await showCleanup();break;
      case 'refresh-cleanup': await renderCleanup();break;
      case 'export-cleanup': {const result=await call('exportHistory',{categories:state.modal.categories});if(!result?.cancelled)toast('Registros exportados.');break;}
      case 'confirm-cleanup': {
        const f=$('#cleanup-form');if(f.elements.confirmation.value!=='APAGAR')throw new Error('Digite APAGAR exatamente para confirmar.');
        const result=await perform('clearHistory',{categories:state.modal.categories,confirmation:'APAGAR',token:state.modal.preview?.token});closeModal();toast(`${number(result.removed||result.count||result.total)} registro(s) removido(s). Controle operacional e auditoria preservados.`);break;
      }
      case 'import-audio': {
        const result=await call('importAudio');if(result?.cancelled)break;
        state.customAudioId=result.id||result.audio?.id;state.customAudioName=result.name||result.audio?.name;
        $('#custom-audio-label').textContent=state.customAudioName||'Arquivo de áudio importado';$('#settings-form').elements.soundName.value='custom';state.settingsDirty=true;toast('Áudio copiado para a pasta gerenciada. Salve as configurações.');break;
      }
      case 'test-sound': await call('testSound',{sound:collectSound()});toast('Teste de som solicitado com o volume selecionado.');break;

      case 'navigate':
        if(state.settingsDirty && state.page==='settings' && id!=='settings' && !confirm('Sair de Configurações e descartar alterações não salvas?'))break;
        if(state.page==='buscas' && id!=='buscas' && buscasUI.hasUnsaved()){if(!confirm('Sair de BUSCAS e descartar alterações não salvas?'))break;buscasUI.reset();}
        if(commerceUI.hasUnsaved()&&!confirm('Sair e descartar as alterações comerciais não salvas?'))break;if(financeUI.hasUnsaved()&&!confirm('Sair e descartar a operação financeira não confirmada?'))break;commerceUI.reset();financeUI.reset();
        state.settingsDirty=false;state.page=id;state.search='';state.filter='all';state.pageOffset=0;state.pageFilters=id==='history'?{categories:['sends']}:{};render();await loadPageData();break;
      case 'toggle-theme': {const theme=document.body.dataset.theme==='dark'?'light':'dark';await perform('saveSettings',{settings:{theme}});if(state.settingsDirty&&$('#settings-form'))$('#settings-form').elements.theme.value=theme;break;}
      case 'window-minimize': await call('windowMinimize');break;
      case 'stop-all': {const report=await perform('stopAll');const count=x=>typeof x==='number'?x:number(x?.cancelled||x?.campaigns||x?.paused,0);toast(`Automações interrompidas. Campanhas: ${count(report.campaigns)}; respostas: ${count(report.search)}; alertas: ${count(report.alerts)}; lembretes: ${count(report.reminders)}. Novas entradas bloqueadas até Retomar sistema.${report.inFlight?' '+report.inFlight+' envio(s) já em andamento podem concluir.':''}`);break;}
      case 'resume-automation':await perform('resumeAutomation',undefined,'Sistema desbloqueado. Reative as campanhas e os lembretes que deseja retomar.');break;
      case 'connection': state.modal={kind:'connection',previousFocus:document.activeElement};renderConnectionModal();break;
      case 'connect': await perform('connect');renderConnectionModal();break;
      case 'disconnect': await perform('disconnect');renderConnectionModal();break;
      case 'refresh-groups': await perform('refreshGroups',undefined,'Lista de grupos atualizada.');break;
      case 'new-campaign': await loadCampaignMetadata();editCampaign();break;
      case 'edit-campaign': await loadCampaignMetadata();editCampaign(id);break;
      case 'close-modal':if(state.modal?.kind==='library-editor'){libraryUI.closeEditor();break;}
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
        const savedDraft=state.draft,editorModal={...state.modal};
        libraryUI.openEditor({name:state.draft.name||'Meu modelo',items:clone(state.draft.items)},{onFinish:()=>{state.draft=savedDraft;state.modal=editorModal;renderCampaignEditor();}});break;
      }
      case 'use-template':editCampaign(undefined,(data().templates||[]).find(t=>t.id===id));break;
      case 'delete-template':if(confirm('Excluir este modelo da biblioteca?'))await perform('deleteTemplate',{id},'Modelo excluído.');break;
      case 'library-tab':state.libraryTab=id;state.search='';render();break;
      case 'backup':await perform('backup',undefined,'Backup criado.');break;
      case 'restore':
        if(confirm('A restauração substitui os dados locais por um backup e interrompe as campanhas. Continuar?')){const result=await perform('restore',undefined,'Backup restaurado. Revise as campanhas antes de ativar.');if(!result?.cancelled){state.settingsDirty=false;render();}}break;
      case 'open-data':await call('openDataFolder');break;
      case 'confirm-job':case 'discard-job':
        if(confirm(action==='confirm-job'?'Você verificou no WhatsApp que este conteúdo foi enviado? Marcar como confirmado?':'Descartar este resultado incerto? O conteúdo não será reenviado.')){await perform('reviewJob',{id,decision:action==='confirm-job'?'confirm':'discard'},'Resultado revisado.');if(state.modal?.kind==='pending-reviews')await showPendingReviews(state.modal.reviewOffset);}break;
      case 'simulation-command': {
        const body=`<form id="simulation-form"><div class="field-grid"><div class="field field-full"><label>Número remetente (país + DDD)</label><input name="senderNumber" type="text" required value="${e((settings().admins||[])[0]||'5511999999999')}"></div><div class="field field-full"><label>Comando</label><input name="text" type="text" required value="!mega status"></div></div><div class="checkbox-stack"><label class="check-label"><input type="checkbox" name="isGroup"> Simular mensagem de grupo (deve ser ignorada)</label><label class="check-label"><input type="checkbox" name="forwarded"> Simular mensagem encaminhada (deve ser ignorada)</label></div></form>`;
        state.modal={kind:'simulation',previousFocus:document.activeElement};showModal('simulation','Testar comando autorizado','Nenhuma mensagem será enviada ao WhatsApp.',body,`<span class="soft-text">Use um número vinculado ao usuário conectado. A simulação também valida as permissões desse usuário.</span>${button('send-simulation','Executar teste','primary','','play')}`,true);break;
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
      if(el.dataset.groupAudience)await perform('setPromotionTarget',{type:'group',targetId:el.dataset.groupAudience,audience:el.value});
      if(el.closest('[id^=commerce-]'))commerceUI.onChange(el);
    if(el.closest('[id^=finance-]'))financeUI.onChange(el);
    if(el.closest('#buscas-page'))await buscasUI.onChange(el);
      if(el.closest('#library-page')||el.closest('#library-template-form'))await libraryUI.onChange(el);
      if(el.closest('#reminders-form'))remindersUI.onChange(el);
      if(el.dataset.cleanupCategory){state.modal.categories=$$('[data-cleanup-category]:checked').map(x=>x.dataset.cleanupCategory);await renderCleanup();}
      if(el.dataset.authorizeGroup)await perform('authorizeGroup',{id:el.dataset.authorizeGroup,authorized:el.checked});
      if(el.closest('#settings-form'))state.settingsDirty=true;
      if(el.id==='campaign-filter'){state.filter=el.value;render();}
      if(el.hasAttribute('data-history-category')){state.pageFilters.categories=el.value==='all'?['campaigns','sends','errors','notifications']:[el.value];state.pageOffset=0;await loadPageData();}
      if(el.id==='history-filter'||el.dataset.pageFilter){state.pageFilters[el.dataset.pageFilter||'status']=el.value;state.pageOffset=0;await loadPageData();}
      if(el.id==='sound-volume')$('#sound-volume-value').textContent=`${el.value}%`;
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
    if(el.closest('[id^=commerce-]'))commerceUI.onInput(el);
    if(el.closest('[id^=finance-]'))financeUI.onInput(el);
    if(el.closest('#buscas-page'))buscasUI.onInput(el);
    if(el.closest('#library-page')||el.closest('#library-template-form'))libraryUI.onInput(el);
    if(el.closest('#reminders-form'))remindersUI.onInput(el);
    if(el.closest('.contact-intake-form'))contactIntakeUI.onInput(el);
    if(el.closest('#settings-form'))state.settingsDirty=true;
    if(el.id==='page-search'){
      const cursor=el.selectionStart;
      state.search=el.value;
      if(['history','diagnostics'].includes(state.page)){clearTimeout(state.searchTimer);state.searchTimer=setTimeout(()=>{state.pageOffset=0;loadPageData().catch(error=>toast(error.message,true));},250);return;}
      render();
      const next=$('#page-search');next.focus();next.setSelectionRange(cursor,cursor);
    }
    if(el.id==='editor-group-search')$('#editor-group-options').innerHTML=editorGroups(el.value);
  });

  document.addEventListener('submit',async event=>{
    event.preventDefault();
    try{
      if(event.target.id.startsWith('commerce-')){await commerceUI.onSubmit(event.target);return;}
      if(event.target.id.startsWith('finance-')){await financeUI.onSubmit(event.target);return;}
      if(event.target.id.startsWith('buscas-')){await buscasUI.onSubmit(event.target);return;}
      if(event.target.id.startsWith('library-')){await libraryUI.onSubmit(event.target);return;}
      if(event.target.id==='reminders-form'){await remindersUI.onSubmit(event.target);return;}
      if(event.target.classList.contains('contact-intake-form')){await contactIntakeUI.onSubmit(event.target);return;}
      if(event.target.id==='auth-form'){
        const f=event.target;if(!f.reportValidity()||state.authSubmitting)return;
        const get=name=>f.elements.namedItem(name)?.value;const screen=f.dataset.screen;
        const password=get('newPassword')||get('password');
        if(get('confirmPassword')!==undefined&&get('confirmPassword')!==password)throw new Error('A confirmação da senha não confere.');
        state.authSubmitting=true;const submit=f.querySelector('[type=submit]');submit.disabled=true;
        try {
          const result=await call(({setup:'setupOwner',login:'login',recovery:'recoverPassword',password:'changePassword'})[screen],{name:get('name'),username:get('username'),password:get('password'),phone:get('phone')?.replace(/[+\s()-]/g,''),code:get('code'),newPassword:get('newPassword'),currentPassword:get('currentPassword')});
          state.authScreen=null;state.authKey=null;await refresh();
          if(result?.recoveryCodes)showRecoveryCodes(result.recoveryCodes);
          if(screen==='recovery')toast('Senha recuperada. Entre com a nova senha.');
          if(screen==='password')toast('Senha alterada.');
        } finally {state.authSubmitting=false;if(submit.isConnected)submit.disabled=false;}
      }
      if(event.target.id==='settings-form'){
        const f=event.target;if(!f.reportValidity())return;
        const admins=f.elements.admins.value.split(/[\n,;]/).map(n=>n.trim().replace(/[+\s()-]/g,'')).filter(Boolean);
        if(admins.some(n=>!/^\d{10,15}$/.test(n)))throw new Error('Informe números válidos com país e DDD, usando de 10 a 15 dígitos.');
        const values={integrationMode:f.elements.integrationMode.value,admins:[...new Set(admins)],unofficialAcknowledged:f.elements.unofficialAcknowledged.checked,theme:f.elements.theme.value,maxSelectedGroups:number(f.elements.maxSelectedGroups.value,15),launchAtLogin:f.elements.launchAtLogin.checked,closeBehavior:f.elements.closeBehavior.value};
        if(values.integrationMode==='whatsapp'&&!values.unofficialAcknowledged)throw new Error('Leia e aceite as limitações da integração não oficial antes de ativar esse modo.');
        values.reconnect={enabled:f.elements.reconnectEnabled.checked,maxAttempts:number(f.elements.reconnectMaxAttempts.value,3),delaySeconds:number(f.elements.reconnectDelaySeconds.value,15),autoResume:f.elements.autoResume.checked};
        values.notifications={nativeEnabled:f.elements.nativeEnabled.checked};
        if(can('notifications.manage')){values.alertRetryPolicy={maxAttempts:number(f.elements.alertMaxAttempts.value,3),delaySeconds:number(f.elements.alertRetryDelay.value,15)};}
        if(can('notifications.manage'))values.systemAlertRecipientIds=$$('[name=systemAlertRecipientIds]:checked',f).map(x=>x.value);
        values.webhook={enabled:f.elements.webhookEnabled.checked,url:f.elements.webhookUrl.value.trim()};
        if(f.elements.webhookToken.value)values.webhookToken=f.elements.webhookToken.value;
        values.sound=collectSound(f);
        values.retention={days:number(f.elements.retentionDays.value,30),maxEntries:number(f.elements.retentionMaxEntries.value,10000),maxMegabytes:number(f.elements.retentionMaxMegabytes.value,32)};
        const result=await call('saveSettings',{settings:values});
        if(!result?.cancelled){state.settingsDirty=false;await refresh();toast('Configurações salvas.');}
      }
    }catch(error){toast(error.message,true);}
  });

  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&state.modal){event.preventDefault();if(state.modal.kind==='library-editor')libraryUI.closeEditor();else if(state.modal.kind==='editor'||state.modal.kind==='editor-preview'||state.modal.kind==='media-picker'){if(confirm('Fechar o editor e descartar alterações não salvas?'))closeModal();}else closeModal();}
    if(event.key==='Tab'&&state.modal){
      const items=[$('.topbar .stop-button'),...$$('.modal button:not(:disabled),.modal input:not(:disabled),.modal textarea:not(:disabled),.modal select:not(:disabled),.modal summary')].filter(el=>el&&el.offsetParent!==null);
      if(!items.length)return;
      const first=items[0],last=items.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    }
  });

  $('.brand').addEventListener('click',event=>{event.preventDefault();if((state.settingsDirty||buscasUI.hasUnsaved())&&!confirm('Sair e descartar alterações não salvas?'))return;state.settingsDirty=false;buscasUI.reset();state.page='dashboard';state.search='';state.filter='all';render();});
  const moduleContext={call,toast,data,auth,can,groups,icon,showModal,closeModal,render,refresh};
  buscasUI=window.MegaBuscasUI.create(moduleContext);
  libraryUI=window.KennedLibraryUI.create({...moduleContext,useTemplate:template=>{if(!can('campaign.create'))throw new Error('Sem permissão para criar campanhas.');editCampaign(undefined,template);}});
  commerceUI=window.KennedCommerceUI.create({...moduleContext,openSale:id=>financeUI.openSale(id)});financeUI=window.KennedFinanceUI.create(moduleContext);
  remindersUI=window.KennedRemindersUI.create(moduleContext);contactIntakeUI=window.KennedContactIntakeUI.create(moduleContext);
  if(window.mega?.onUpdate)window.mega.onUpdate(()=>refresh());
  refresh();
})();
