'use strict';
window.KennedNavigation = (() => {
  const primary = [
    ['dashboard', 'Painel', 'dashboard', 'Resumo das campanhas, conexão e vitrine'],
    ['campaigns', 'Campanhas', 'campaign', 'Criar, revisar e acompanhar seus disparos'],
    ['sources', 'Origem da loja', 'image', 'Capturar fotos e legendas para as listas da loja'],
    ['buscas', 'Buscas', 'search', 'Pesquisar ofertas reais e exportar listas'],
    ['groups', 'Grupos', 'groups', 'Sincronizar grupos e revisar permissões'],
    ['settings', 'Configurações', 'settings', 'Conexão, responsáveis e preferências do aplicativo'],
    ['license', 'Licença', 'shield', 'Consultar o vencimento, ativar ou renovar']
  ];
  const categories = [
    ['Atendimento', [['opportunities', 'Oportunidades', 'search', 'Pedidos dos grupos que combinam com seus anúncios'], ['contacts', 'Contatos', 'groups', 'Classificar contatos e revisar novos interessados']]],
    ['Conteúdo', [['library', 'Modelos', 'text', 'Criar e reutilizar modelos de mensagem', 'templates'], ['library', 'Biblioteca', 'library', 'Organizar fotos, vídeos e documentos', 'media']]],
    ['Automação', [['uptime', 'UPTIME', 'clock', 'Monitoramento automático e relatórios operacionais'], ['alerts', 'Alertas', 'whatsapp', 'Responsáveis e resultados dos avisos privados'], ['reminders', 'Lembretes', 'clock', 'Tarefas e avisos recorrentes']]],
    ['Diagnóstico', [['history', 'Histórico', 'history', 'Consultar resultados de envios e falhas'], ['diagnostics', 'Diagnóstico', 'shield', 'Rastreamento, etapas e orientações de erro'], ['reports', 'Relatórios de envio', 'history', 'Resultados operacionais das campanhas']]],
    ['Administração', [['users', 'Usuários e perfis', 'shield', 'Gerenciar acessos e permissões']]]
  ];
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  function render({ canPage, page, expired = false, moreTools = false, libraryTab = 'media', icons = {}, campaignCount = 0 } = {}) {
    const item = ([key, name, icon, description, tab], main = false) => {
      const blocked = expired && key !== 'license';
      const active = page === key && (!tab || tab === libraryTab);
      return `<button type="button" class="nav-item${active ? ' active' : ''}" data-action="navigate" data-id="${escape(key)}"${tab ? ` data-library-tab="${escape(tab)}"` : ''}${main ? ' data-nav-main' : ' data-nav-extra'} title="${escape(description)}" aria-label="${escape(name)} — ${escape(description)}"${active ? ' aria-current="page"' : ''}${blocked ? ' disabled aria-disabled="true" data-license-locked="true"' : ''}><span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24">${blocked ? '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><path d="M12 15v2"/>' : icons[icon] || ''}</svg></span><span class="nav-text">${escape(name)}</span>${key === 'campaigns' && !expired ? `<span class="nav-count">${Number(campaignCount) || 0}</span>` : ''}</button>`;
    };
    const main = primary.filter(([key]) => expired || canPage(key)).map(entry => item(entry, true)).join('');
    if (expired) return main;
    const extra = categories.map(([name, entries]) => { const visible = entries.filter(([key]) => canPage(key)); return visible.length ? `<section class="nav-tool-category"><h3>${escape(name)}</h3>${visible.map(entry => item(entry)).join('')}</section>` : ''; }).join('');
    return main + (extra ? `<button type="button" class="nav-item nav-more-toggle" data-action="toggle-more-tools" aria-expanded="${Boolean(moreTools)}" aria-controls="nav-extra-tools" title="Mostrar ou recolher as ferramentas de atendimento, conteúdo, automação e diagnóstico" aria-label="Mais ferramentas"><span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg></span><span class="nav-text">Mais ferramentas</span><span class="nav-chevron" aria-hidden="true">${moreTools ? '⌃' : '⌄'}</span></button><div id="nav-extra-tools"${moreTools ? '' : ' hidden'}>${extra}</div>` : '');
  }
  return { render, primary: primary.map(entry => entry[0]) };
})();
