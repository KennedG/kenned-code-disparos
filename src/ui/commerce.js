'use strict';

// Structured commerce forms. Every mutation goes through the authenticated
// worker; public previews never render internal cost or supplier details.
window.KennedCommerceUI = {
  create(ctx) {
    const $ = (s, root = document) => root.querySelector(s);
    const $$ = (s, root = document) => [...root.querySelectorAll(s)];
    const e = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const uid = () => crypto.randomUUID();
    const state = { epoch: 0, busy: false, dirty: false, page: 'inventory', query: '', sources: [], draft: null, preview: null };
    const data = () => ctx.data()?.commerce || {};
    const array = key => Array.isArray(data()[key]) ? data()[key] : data()[key]?.items || [];
    const inventory = () => array('inventory');
    const suppliers = () => array('suppliers');
    const contacts = () => ctx.data()?.contacts || [];
    const categories = () => array('categories');
    const recipients = () => array('recipients').filter(recipient => recipient.commercial === true || recipient.commerce === true);
    const can = permission => !!(ctx.auth()?.user?.isOwner || ctx.can?.(permission));
    const fin = () => can('finance.view');
    const fmt = value => { if (value == null || value === '') return '—'; try { return new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }); } catch { return '—'; } };
    const money = cents => cents == null ? 'Não informado' : (Number(cents) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const amount = cents => cents == null ? '' : (Number(cents) / 100).toFixed(2);
    function cents(value, optional = false) {
      const text = String(value ?? '').trim();
      if (!text && optional) return null;
      const normalized = text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text;
      if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new Error('Informe um valor em reais com até duas casas decimais.');
      const [whole, fraction = ''] = normalized.split('.');
      const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
      if (!Number.isSafeInteger(result)) throw new Error('O valor informado excede o limite permitido.');
      return result;
    }
    const check = (label, name, value, checked, attrs = '') => '<label class="check-label"><input type="checkbox" name="' + e(name) + '" value="' + e(value) + '" ' + (checked ? 'checked ' : '') + attrs + '> ' + e(label) + '</label>';
    const button = (action, label, style = '', id = '') => '<button type="button" class="button ' + e(style) + '" data-action="commerce-' + e(action) + '"' + (id ? ' data-id="' + e(id) + '"' : '') + '>' + e(label) + '</button>';
    const field = (label, name, value = '', type = 'text', extra = '') => '<div class="field"><label for="commerce-' + e(name) + '">' + e(label) + '</label><input id="commerce-' + e(name) + '" name="' + e(name) + '" type="' + e(type) + '" value="' + e(value) + '" ' + extra + '></div>';
    const select = (label, name, value, options, extra = '') => '<div class="field"><label for="commerce-' + e(name) + '">' + e(label) + '</label><select id="commerce-' + e(name) + '" name="' + e(name) + '" ' + extra + '>' + options.map(([key, text]) => '<option value="' + e(key) + '" ' + (String(value ?? '') === String(key) ? 'selected' : '') + '>' + e(text) + '</option>').join('') + '</select></div>';
    const textarea = (label, name, value = '', extra = '') => '<div class="field"><label for="commerce-' + e(name) + '">' + e(label) + '</label><textarea id="commerce-' + e(name) + '" name="' + e(name) + '" rows="3" ' + extra + '>' + e(value) + '</textarea></div>';
    const v = (form, name) => form.elements.namedItem(name)?.value ?? '';
    const selected = (form, name) => $$('[name="' + name + '"]:checked', form).map(el => el.value);
    const safeCall = async (action, payload) => {
      const epoch = state.epoch, actor = ctx.auth()?.user?.id, mode = ctx.data()?.storageMode;
      const result = await ctx.call(action, payload);
      if (epoch !== state.epoch || actor !== ctx.auth()?.user?.id || mode !== ctx.data()?.storageMode) throw new Error('O usuário ou modo de operação mudou. Atualize a tela.');
      return result;
    };
    const refresh = async () => { await ctx.refresh?.(); ctx.render(true); };
    const permissionFor = page => ({ inventory: 'stock.view', suppliers: 'supplier.view', commercial: 'commerce.view', opportunities: 'commerce.view', demands: 'commerce.view', contacts: 'contacts.view' })[page];
    const titleFor = page => ({ inventory: 'ESTOQUE', suppliers: 'FORNECEDORES', commercial: 'LISTAS COMERCIAIS', opportunities: 'OPORTUNIDADES', demands: 'APARELHOS PROCURADOS', contacts: 'CONTATOS' })[page];
    const subFor = page => ({ inventory: 'Aparelhos individuais, acessórios por quantidade e reservas.', suppliers: 'Cadastro e compras vinculadas às entradas de estoque.', commercial: 'Listas por público, com acréscimo sobre o custo e prévia antes de enviar.', opportunities: 'Buscas monitoradas e avisos privados para administradores autorizados.', demands: 'Preferências dos compradores e ofertas dentro do orçamento.', contacts: 'Contatos locais, com uma ou mais categorias e preferências de recebimento.' })[page];
    const stateLabel = value => ({ available: 'Disponível', reserved: 'Reservado', sold: 'Vendido', active: 'Ativo', paused: 'Pausado', searching: 'Procurando', found: 'Oferta encontrada', negotiating: 'Em negociação', completed: 'Concluído', cancelled: 'Cancelado', expired: 'Expirado', pending: 'Pendente', confirmed: 'Enviado — aceito pelo servidor', delivered: 'Entregue', failed: 'Falhou', uncertain: 'Incerto — revisão necessária' })[value] || value || '—';
    const modelName = item => [item.model, item.storage || (item.storageGB ? item.storageGB + 'GB' : ''), item.color, item.condition].filter(Boolean).join(' · ');
    const matchesQuery = item => !state.query || JSON.stringify(item).toLocaleLowerCase('pt-BR').includes(state.query.toLocaleLowerCase('pt-BR'));
    const empty = (text, description = '') => '<tr><td colspan="6"><div class="empty-state"><h3>' + e(text) + '</h3><p>' + e(description) + '</p></div></td></tr>';
    const table = (headings, rows) => '<section class="panel"><div class="table-scroll"><table><thead><tr>' + headings.map(text => '<th>' + e(text) + '</th>').join('') + '</tr></thead><tbody>' + rows + '</tbody></table></div></section>';
    function render(page = state.page) {
      if (page !== state.page) { state.page = page; state.query = ''; }
      if (!can(permissionFor(page))) return '<section id="commerce-page" class="panel"><div class="panel-body">Seu perfil não permite visualizar esta área.</div></section>';
      const actions = {
        inventory: can('stock.manage') ? button('new-inventory', 'Cadastrar produto', 'primary') : '',
        suppliers: can('supplier.manage') ? button('new-supplier', 'Cadastrar fornecedor', 'primary') : '',
        commercial: can('commerce.list') ? button('new-list', 'Montar lista', 'primary') : '',
        opportunities: can('commerce.manage') ? button('new-opportunity', 'Novo alerta', 'primary') : '',
        demands: can('commerce.manage') ? button('new-demand', 'Cadastrar procura', 'primary') : '',
        contacts: can('contacts.create') ? button('new-contact', 'Cadastrar contato', 'primary') : ''
      };
      let out = '<div id="commerce-page" data-commerce-page="' + e(page) + '"><div class="page-heading"><div><span class="eyebrow">GESTÃO DA LOJA</span><h1>' + e(titleFor(page)) + '</h1><p class="subtitle">' + e(subFor(page)) + '</p></div><div class="row-actions">' + button('reload', 'Atualizar', 'ghost') + (actions[page] || '') + '</div></div>';
      if (ctx.data()?.automation?.blocked || ctx.data()?.automation?.stopped || data().stopped) out += '<p class="warning-note">Envios automáticos bloqueados pela parada geral. Os cadastros permanecem salvos.</p>';
      out += '<div class="toolbar"><div class="search-input">' + (ctx.icon?.('search') || '') + '<input id="commerce-search" type="search" placeholder="Pesquisar nesta tela" aria-label="Pesquisar nesta tela" value="' + e(state.query) + '"></div>' + (page === 'commercial' && can('commerce.manage') ? button('settings', 'Regras e frequência') : '') + (page === 'contacts' && can('contacts.edit') ? button('categories', 'Gerenciar categorias') : '') + '</div>';
      const renderer = { inventory: renderInventory, suppliers: renderSuppliers, commercial: renderLists, opportunities: renderOpportunities, demands: renderDemands, contacts: renderContacts }[page];
      return out + (renderer ? renderer() : '') + '</div>';
    }
    function renderInventory() {
      const rows = inventory().filter(matchesQuery).map(item => {
        const reservations = array('reservations').filter(reservation => reservation.inventoryId === item.id && reservation.status === 'active');
        return '<tr><td><strong>' + e(item.model) + '</strong><span class="table-subtitle">' + e(modelName(item)) + '</span><small>' + e(item.kind === 'accessory' ? 'Acessório' : 'Aparelho individual') + (item.battery != null ? ' · Bateria: ' + e(item.battery) + '%' : '') + '</small></td><td>' + e(stateLabel(item.status)) + '<span class="table-subtitle">' + e(item.availableQuantity ?? item.quantity ?? 0) + ' disponível(is) · ' + e(item.reservedQuantity || 0) + ' reservado(s)</span>' + reservations.map(r => '<small>' + e(r.buyerName || contacts().find(c => c.id === r.buyerId)?.name || 'Reserva') + ' · Até ' + e(fmt(r.expiresAt)) + '</small>').join('') + '</td><td>' + e(money(item.retailCents ?? item.retailPriceCents)) + '<span class="table-subtitle">Atacado: ' + e(money(item.wholesaleCents ?? item.wholesalePriceCents)) + '</span>' + (fin() ? '<small>Custo: ' + e(money(item.costCents)) + '</small>' : '') + '</td><td>' + e(suppliers().find(s => s.id === item.supplierId)?.name || 'Não informado') + '<span class="table-subtitle">Entrada: ' + e(fmt(item.entryAt)) + '</span></td><td><div class="row-actions">' + (can('stock.manage') ? button('edit-inventory', 'Editar', 'small', item.id) + (item.status !== 'sold' ? button('reserve', 'Reservar', 'small', item.id) : '') : '') + (can('finance.manage') && item.status !== 'sold' ? button('sell', 'Marcar como vendido', 'small primary', item.id) : '') + reservations.map(r => can('stock.manage') ? button('release', 'Liberar reserva', 'small ghost', r.id) : '').join('') + '</div></td></tr>';
      }).join('');
      return '<p class="info-note">A disponibilidade será conferida novamente antes de cada envio comercial. Produtos vendidos ficam preservados no histórico e deixam as próximas divulgações.</p>' + table(['PRODUTO', 'DISPONIBILIDADE', 'PREÇOS', 'ENTRADA', 'AÇÕES'], rows || empty('Nenhum produto cadastrado', 'Cadastre um aparelho individual ou acessórios por quantidade.'));
    }
    function inventoryEditor(id) {
      const item = inventory().find(i => i.id === id) || { kind: 'device', quantity: 1, entryAt: Date.now(), mediaIds: [] };
      state.draft = { kind: 'inventory', id, key: uid() };
      const local = item.entryAt ? localDateTime(item.entryAt) : '';
      const body = '<form id="commerce-inventory-form" data-id="' + e(id || '') + '"><div class="field-grid">' + select('Tipo', 'kind', item.kind, [['device', 'Aparelho individual'], ['accessory', 'Acessório por quantidade']]) + field('Modelo ou nome do produto', 'model', item.model, 'text', 'required maxlength="160"') + field('Armazenamento', 'storage', item.storage || (item.storageGB ? item.storageGB + 'GB' : ''), 'text', 'maxlength="40" placeholder="Ex.: 256GB"') + field('Cor', 'color', item.color, 'text', 'maxlength="80"') + select('Condição', 'condition', item.condition, [['', 'Não informada'], ['lacrado', 'Lacrado'], ['seminovo', 'Seminovo'], ['usado', 'Usado'], ['cpo', 'CPO']]) + field('Quantidade (aparelho individual: 1)', 'quantity', item.quantity ?? 1, 'number', 'required min="0" max="100000" step="1" ' + (id ? 'readonly' : '')) + field('Saúde da bateria (%)', 'battery', item.battery ?? '', 'number', 'min="0" max="100" step="1"') + field('Garantia', 'warranty', item.warranty, 'text', 'maxlength="500"') + select('Fornecedor', 'supplierId', item.supplierId, [['', 'Sem fornecedor vinculado'], ...suppliers().map(s => [s.id, s.name])]) + field('Data de entrada (Brasília)', 'entryAt', local, 'datetime-local', 'required') + field('Preço de varejo (R$)', 'retailCents', amount(item.retailCents ?? item.retailPriceCents), 'text', 'inputmode="decimal"') + field('Preço de atacado (R$)', 'wholesaleCents', amount(item.wholesaleCents ?? item.wholesalePriceCents), 'text', 'inputmode="decimal"') + (fin() ? field('Custo (R$)', 'costCents', amount(item.costCents), 'text', 'inputmode="decimal" ' + (can('finance.manage') ? '' : 'readonly')) + field('IMEI — dado interno', 'imei', item.imei, 'text', 'maxlength="40" ' + (can('finance.manage') ? '' : 'readonly')) + field('Número de série — dado interno', 'serial', item.serial, 'text', 'maxlength="80" ' + (can('finance.manage') ? '' : 'readonly')) : '') + '</div>' + textarea('Observações internas', 'notes', item.notes, 'maxlength="4000"') + '<fieldset class="permission-section"><legend>Fotos da biblioteca gerenciada</legend>' + (ctx.data()?.media || []).filter(m => m.type === 'image').map(m => check(m.name, 'mediaIds', m.id, item.mediaIds?.includes(m.id))).join('') + '</fieldset><p class="field-hint">Valores em reais. Campos ausentes permanecem sem informação; os anúncios não inventam características. Aparelhos individuais não podem ser duplicados pela quantidade.</p></form>';
      state.dirty = false; ctx.showModal('commerce-inventory', id ? 'Editar produto' : 'Cadastrar produto', 'Estoque persistente integrado às reservas, vendas e disparos.', body, button('close', 'Cancelar', 'ghost') + button('save-inventory', 'Salvar produto', 'primary'));
    }
    function localDateTime(at) {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at)).map(p => [p.type, p.value]));
      return parts.year + '-' + parts.month + '-' + parts.day + 'T' + parts.hour + ':' + parts.minute;
    }
    const timestamp = value => value ? new Date(value + ':00-03:00').getTime() : null;
    function reserveEditor(id) {
      const item = inventory().find(i => i.id === id); if (!item) throw new Error('Produto não encontrado.');
      state.draft = { kind: 'reservation', id, key: uid() };
      ctx.showModal('commerce-reserve', 'Reservar ' + item.model, 'O sinal será registrado uma única vez e abatido da venda.', '<form id="commerce-reservation-form"><div class="field-grid">' + select('Comprador cadastrado', 'buyerId', '', [['', 'Informar nome abaixo'], ...contacts().map(c => [c.id, c.name + ' · ' + c.phone])]) + field('Nome do comprador', 'buyerName', '', 'text', 'maxlength="160"') + field('Quantidade', 'quantity', 1, 'number', 'required min="1" max="' + e(item.availableQuantity ?? 1) + '"') + field('Reservar até (Brasília)', 'expiresAt', '', 'datetime-local', 'required') + (can('finance.manage') ? field('Sinal recebido (R$)', 'depositCents', '0.00', 'text', 'required inputmode="decimal"') + select('Recebimento do sinal', 'paymentMethod', 'pix', [['pix', 'Pix'], ['cash', 'Dinheiro'], ['debit', 'Débito'], ['credit', 'Crédito']]) : '') + '</div><p class="field-hint">A liberação de uma reserva não apaga o pagamento do sinal. Estornos precisam de um registro financeiro próprio.</p></form>', button('close', 'Cancelar', 'ghost') + button('save-reservation', 'Confirmar reserva', 'primary'));
    }
    function renderSuppliers() {
      const rows = suppliers().filter(matchesQuery).map(item => '<tr><td><strong>' + e(item.name) + '</strong><span class="table-subtitle">' + e(item.phone || 'Número não informado') + '</span></td><td>' + e((item.categories || []).join(', ') || 'Não informadas') + '</td><td>' + (fin() ? e(item.paymentTerms || 'Não informadas') + '<span class="table-subtitle">Garantia: ' + e(item.warranty || 'Não informada') + '</span><small>Prazo: ' + e(item.deliveryDays != null ? item.deliveryDays + ' dia(s)' : 'Não informado') + '</small>' : 'Informações internas restritas') + '</td><td>' + e(array('purchases').filter(p => p.supplierId === item.id).length) + ' compra(s)</td><td><div class="row-actions">' + button('supplier-history', 'Histórico', 'small', item.id) + (can('supplier.manage') ? button('edit-supplier', 'Editar', 'small', item.id) : '') + (can('finance.manage') ? button('purchase', 'Registrar compra', 'small primary', item.id) : '') + '</div></td></tr>').join('');
      return table(['FORNECEDOR', 'PRODUTOS', 'CONDIÇÕES', 'COMPRAS', 'AÇÕES'], rows || empty('Nenhum fornecedor cadastrado'));
    }
    function supplierEditor(id) {
      const item = suppliers().find(s => s.id === id) || {};
      state.draft = { kind: 'supplier', id };
      const body = '<form id="commerce-supplier-form" data-id="' + e(id || '') + '"><div class="field-grid">' + field('Nome', 'name', item.name, 'text', 'required maxlength="160"') + field('WhatsApp com país e DDD', 'phone', item.phone, 'tel', 'required placeholder="5562999999999" maxlength="24"') + field('Categorias de produtos (separadas por vírgula)', 'categories', (item.categories || []).join(', '), 'text', 'maxlength="500"') + (fin() ? field('Condições de pagamento — interno', 'paymentTerms', item.paymentTerms, 'text', 'maxlength="1000"') + field('Garantia — interno', 'warranty', item.warranty, 'text', 'maxlength="1000"') + field('Prazo de entrega (dias)', 'deliveryDays', item.deliveryDays ?? '', 'number', 'min="0" max="365"') : '') + '</div>' + (fin() ? textarea('Observações internas', 'notes', item.notes, 'maxlength="4000"') : '') + '<p class="field-hint">Condições internas e contato do fornecedor não são incluídos nos anúncios comerciais.</p></form>';
      state.dirty = false; ctx.showModal('commerce-supplier', id ? 'Editar fornecedor' : 'Cadastrar fornecedor', 'Ficha vinculada às compras e entradas de estoque.', body, button('close', 'Cancelar', 'ghost') + button('save-supplier', 'Salvar fornecedor', 'primary'));
    }
    function purchaseEditor(id) {
      state.draft = { kind: 'purchase', supplierId: id, key: uid() };
      ctx.showModal('commerce-purchase', 'Registrar compra e entrada', 'Cada novo aparelho será criado individualmente, com fornecedor e custo vinculados à compra.', '<form id="commerce-purchase-form"><div class="field-grid">' + select('Entrada de estoque', 'inventoryId', '', [['', 'Novo produto — cadastrar abaixo'], ...inventory().filter(i => i.kind === 'accessory').map(i => [i.id, modelName(i)])]) + select('Tipo do novo produto', 'kind', 'device', [['device', 'Aparelho individual'], ['accessory', 'Acessório por quantidade']]) + field('Modelo ou nome do novo produto', 'model', '', 'text', 'maxlength="160"') + field('Armazenamento do novo aparelho', 'storage', '', 'text', 'maxlength="40" placeholder="256GB"') + field('Cor', 'color', '', 'text', 'maxlength="80"') + select('Condição', 'condition', '', [['', 'Não informada'], ['lacrado', 'Lacrado'], ['seminovo', 'Seminovo'], ['usado', 'Usado'], ['cpo', 'CPO']]) + field('Quantidade (aparelho: 1)', 'quantity', 1, 'number', 'required min="1" step="1"') + field('Custo unitário (R$)', 'unitCostCents', '', 'text', 'required inputmode="decimal"') + field('Preço de varejo do novo produto (R$)', 'retailCents', '', 'text', 'inputmode="decimal"') + field('Preço de atacado do novo produto (R$)', 'wholesaleCents', '', 'text', 'inputmode="decimal"') + field('IMEI do novo aparelho — interno', 'imei', '', 'text', 'maxlength="40"') + field('Data da compra (Brasília)', 'purchasedAt', localDateTime(Date.now()), 'datetime-local', 'required') + '</div><p class="field-hint">Cada aparelho corresponde a uma unidade própria. Para acessórios, selecione um cadastro existente para registrar reposição; o custo médio será atualizado pelo lançamento.</p></form>', button('close', 'Cancelar', 'ghost') + button('save-purchase', 'Registrar compra e entrada', 'primary'));
    }
    function renderLists() {
      const rows = array('lists').filter(matchesQuery).map(item => '<tr><td><strong>' + e(item.name) + '</strong><span class="table-subtitle">Revisão ' + e(item.revision || 1) + '</span></td><td>' + e(item.audience === 'wholesale' ? 'Atacado' : 'Varejo') + '</td><td>' + e(item.lines?.length || 0) + ' produto(s)<span class="table-subtitle">' + e((item.lines || []).some(l => l.sourceType === 'offer') ? 'Inclui itens sob encomenda' : 'Estoque próprio — pronta entrega') + '</span></td><td>' + (fin() ? e(money((item.lines || []).reduce((s, l) => s + (l.profitCents || 0) * (l.quantity || 1), 0))) + '<span class="table-subtitle">Lucro estimado, antes de taxas e despesas</span>' : 'Dados internos restritos') + '</td><td><div class="row-actions">' + button('preview-list', 'Prévia', 'small', item.id) + (can('commerce.list') ? button('edit-list', 'Editar', 'small', item.id) + button('list-campaign', 'Usar em campanha', 'small primary', item.id) + button('delete-list', 'Excluir', 'small danger', item.id) : '') + '</div></td></tr>').join('');
      return '<p class="info-note">O percentual é <strong>acréscimo sobre o custo</strong>, não margem sobre a venda. As prévias públicas escondem custos, lucro, dados internos e contato do fornecedor. Campanhas são criadas desativadas.</p>' + table(['LISTA', 'PÚBLICO', 'ORIGEM', 'LUCRO ESTIMADO', 'AÇÕES'], rows || empty('Nenhuma lista comercial salva'));
    }
    async function listEditor(id) {
      const item = array('lists').find(l => l.id === id) || { name: '', audience: 'retail', lines: [] };
      let offers = [];
      if (can('search.view') && can('finance.view')) {
        const result = await safeCall('searchOffers', { confidence: 'confirmed', includeReview: false, includeUnavailable: false, limit: 100, offset: 0 });
        offers = (result.items || result.offers || []).filter(o => o.confidence === 'confirmed' && (o.priceCents ?? o.price) != null && !o.unavailable);
      }
      state.sources = inventory().filter(i => (i.availableQuantity ?? i.quantity ?? 0) > 0).map(i => ({ id: i.id, type: 'inventory', name: modelName(i), costCents: i.costCents, availability: 'pronta entrega' })).concat(offers.map(o => ({ id: o.id, type: 'offer', name: modelName(o), costCents: o.priceCents ?? o.price, availability: 'sob encomenda' })));
      // Keep saved lines visible for review even when the current source is no
      // longer eligible. The worker will prevent an unsafe campaign/send.
      for (const line of item.lines || []) if (!state.sources.some(s => s.id === line.sourceId && s.type === line.sourceType)) state.sources.push({ id: line.sourceId, type: line.sourceType, name: modelName(line.facts || {}), costCents: line.costCents, availability: 'Indisponível — revisão necessária', stale: true });
      state.draft = { kind: 'list', id, expectedRevision: item.revision, item };
      const defaults = data().settings?.[item.audience === 'wholesale' ? 'wholesaleMarkup' : 'retailMarkup'] || { type: 'fixed', valueCents: 0 };
      const body = '<form id="commerce-list-form"><div class="field-grid">' + field('Nome da lista', 'name', item.name, 'text', 'required maxlength="160"') + select('Público e preço', 'audience', item.audience, [['retail', 'Varejo — Cliente Nerópolis'], ['wholesale', 'Atacado — Lojista Camelódromo']]) + (can('finance.manage') ? select('Acréscimo padrão sobre o custo', 'markupType', defaults.type, [['fixed', 'Valor fixo em reais'], ['percent', 'Percentual sobre o custo']]) + field('Acréscimo padrão (R$ ou %)', 'markupValue', defaults.type === 'percent' ? (defaults.basisPoints || 0) / 100 : amount(defaults.valueCents || 0), 'text', 'required inputmode="decimal"') : '') + '</div><p class="field-hint">Acréscimo de 20% sobre custo de R$ 1.000 gera preço de R$ 1.200. Isso corresponde a 16,67% de margem sobre a venda. Ajustes por produto substituem o acréscimo padrão.</p><section class="panel"><div class="table-scroll"><table><thead><tr><th>SELECIONAR</th><th>PRODUTO / ORIGEM</th><th>QUANTIDADE</th>' + (fin() ? '<th>CUSTO</th><th>ACRÉSCIMO POR PRODUTO</th><th>PREÇO / LUCRO</th>' : '') + '</tr></thead><tbody>' + state.sources.map((source, index) => {
        const line = (item.lines || []).find(l => l.sourceType === source.type && l.sourceId === source.id);
        const markup = line?.markup;
        return '<tr data-commerce-source-row="' + index + '"><td>' + check('Incluir', 'source', String(index), !!line, source.stale && !line ? 'disabled' : '') + '</td><td><strong>' + e(source.name || 'Produto identificado pela oferta') + '</strong><span class="table-subtitle">' + e(source.availability) + '</span></td><td><input name="quantity-' + index + '" aria-label="Quantidade de ' + e(source.name) + '" type="number" min="1" step="1" value="' + e(line?.quantity || 1) + '" style="width:75px"></td>' + (fin() ? '<td>' + e(money(source.costCents)) + '</td><td><select name="lineType-' + index + '" aria-label="Tipo de acréscimo de ' + e(source.name) + '"><option value="">Padrão</option><option value="fixed" ' + (markup?.type === 'fixed' ? 'selected' : '') + '>R$</option><option value="percent" ' + (markup?.type === 'percent' ? 'selected' : '') + '>% sobre custo</option></select><input name="lineValue-' + index + '" aria-label="Acréscimo de ' + e(source.name) + '" inputmode="decimal" value="' + e(markup?.type === 'percent' ? (markup.basisPoints || 0) / 100 : markup ? amount(markup.valueCents || 0) : '') + '" placeholder="Padrão" style="width:100px"></td><td data-commerce-calculation="' + index + '">—</td>' : '') + '</tr>';
      }).join('') + '</tbody></table></div></section>' + (!state.sources.length ? '<p class="warning-note">Não há produtos disponíveis nem ofertas confirmadas nesta seleção. Cadastre estoque ou capture ofertas reais nos grupos monitorados.</p>' : '') + '<p class="field-hint">Ofertas capturadas disponíveis nesta janela: até 100 registros. A validade, o preço identificado e a disponibilidade serão validados pelo backend antes de salvar e antes de enviar.</p></form>';
      state.dirty = false; ctx.showModal('commerce-list', id ? 'Editar lista comercial' : 'Montar lista comercial', 'Selecione estoque próprio ou ofertas capturadas, sem misturar a origem.', body, button('close', 'Cancelar', 'ghost') + button('save-list', 'Salvar e visualizar prévia', 'primary')); updateCalculations();
    }
    function markup(type, raw) { return type === 'percent' ? { type: 'percent', basisPoints: cents(raw) } : { type: 'fixed', valueCents: cents(raw) }; }
    function updateCalculations() {
      const form = $('#commerce-list-form'); if (!form || !fin()) return;
      for (const cell of $$('[data-commerce-calculation]', form)) {
        const index = Number(cell.dataset.commerceCalculation), source = state.sources[index];
        try {
          const type = v(form, 'lineType-' + index) || v(form, 'markupType') || 'fixed';
          const raw = v(form, 'lineType-' + index) ? v(form, 'lineValue-' + index) : v(form, 'markupValue');
          const defaultRule = data().settings?.[state.draft?.item?.audience === 'wholesale' ? 'wholesaleMarkup' : 'retailMarkup'] || { type: 'fixed', valueCents: 0 };
          const rule = form.elements.namedItem('markupValue') || v(form, 'lineType-' + index) ? markup(type, raw) : defaultRule, cost = source.costCents;
          if (cost == null) { cell.textContent = 'Custo não informado'; continue; }
          const increase = rule.type === 'percent' ? Number((BigInt(cost) * BigInt(rule.basisPoints) + 5000n) / 10000n) : rule.valueCents;
          cell.innerHTML = e(money(cost + increase)) + '<span class="table-subtitle">Lucro estimado: ' + e(money(increase)) + '</span>';
        } catch { cell.textContent = 'Confira o acréscimo'; }
      }
    }
    async function showListPreview(id) {
      const preview = await safeCall('previewCommercialList', { id }); state.preview = preview;
      let body = '<pre class="summary-pre" id="commerce-public-preview">' + e(preview.text || preview.publicText || '') + '</pre><p class="field-hint">Esta é a prévia completa do anúncio. O texto público não inclui o custo, o acréscimo, o lucro ou o contato do fornecedor.</p>';
      if (fin()) body += '<section class="panel"><div class="panel-body"><strong>Resumo interno</strong><p>Custo total: ' + e(money(preview.totalCostCents)) + ' · Preço final: ' + e(money(preview.totalPriceCents)) + ' · Lucro estimado: ' + e(money(preview.totalEstimatedProfitCents)) + '</p><small>O lucro estimado ainda não desconta taxas e despesas de uma venda.</small></div></section>';
      ctx.showModal('commerce-preview', 'Prévia comercial — ' + (preview.audience === 'wholesale' ? 'atacado' : 'varejo'), 'Revise o público, os produtos, o valor e a disponibilidade antes de enviar.', body, button('close', 'Fechar', 'ghost') + (can('commerce.list') ? button('list-campaign', 'Criar campanha desativada', 'primary', id) : ''));
    }
    function campaignEditor(id) {
      const list = array('lists').find(l => l.id === id); if (!list) throw new Error('Lista não encontrada. Atualize a tela.');
      const audience = list.audience;
      const eligibleContacts = contacts().filter(c => c.promotionalConsent === true && !c.promotionalOptOut && !c.promotionPaused && (c.categories || [c.category]).includes(audience === 'wholesale' ? 'Lojista Camelódromo' : 'Cliente Nerópolis'));
      const targets = array('promotionTargets');
      const groups = (ctx.groups?.() || ctx.data()?.groups || []).filter(g => targets.some(t => t.type === 'group' && t.targetId === g.id && t.audience === audience && !t.paused && !t.optOut));
      state.draft = { kind: 'campaign', listId: id };
      ctx.showModal('commerce-campaign', 'Usar lista em campanha', 'A campanha ficará desativada para revisão e início manual.', '<form id="commerce-campaign-form">' + field('Nome da campanha', 'name', list.name, 'text', 'required maxlength="120"') + '<div class="field-grid">' + field('Intervalo entre rodadas (minutos)', 'intervalMinutes', 10, 'number', 'required min="1" max="10080"') + field('Espaçamento entre destinatários (segundos)', 'spacingSeconds', 5, 'number', 'required min="1" max="3600"') + '</div><fieldset class="permission-section"><legend>Contatos classificados para ' + e(audience === 'wholesale' ? 'atacado' : 'varejo') + '</legend>' + eligibleContacts.map(c => check(c.name + ' · ' + c.phone, 'contactIds', c.id, false)).join('') + '</fieldset><fieldset class="permission-section"><legend>Grupos explicitamente classificados para este público</legend>' + groups.map(g => check(g.name, 'groupIds', g.id, false)).join('') + '</fieldset><p class="field-hint">Grupos precisam ser classificados em Regras e frequência. Contatos que pediram para não receber promoções e destinos pausados são bloqueados pelo backend. Nenhum envio começa ao criar a campanha.</p></form>', button('close', 'Cancelar', 'ghost') + button('save-campaign', 'Criar campanha desativada', 'primary'));
    }
    function renderOpportunities() {
      const rows = array('opportunities').filter(matchesQuery).map(rule => '<tr><td><strong>' + e(rule.name || rule.model) + '</strong><span class="table-subtitle">' + e([rule.model, rule.storageGB ? rule.storageGB + 'GB' : '', rule.condition].filter(Boolean).join(' · ')) + '</span></td><td>' + e(money(rule.maxPriceCents)) + '<span class="table-subtitle">Oferta de até ' + e(rule.maxAgeMinutes || 120) + ' minuto(s)</span></td><td>' + e(rule.enabled ? 'Ativo' : 'Pausado') + '<span class="table-subtitle">' + e(rule.groupIds?.length || 0) + ' grupo(s) monitorado(s)</span></td><td>' + e((rule.recipientIds || []).map(id => recipients().find(r => r.id === id)?.name || 'Administrador indisponível').join(', ')) + '</td><td><div class="row-actions">' + (can('commerce.manage') ? button('edit-opportunity', 'Editar', 'small', rule.id) + button(rule.enabled ? 'pause-opportunity' : 'activate-opportunity', rule.enabled ? 'Pausar' : 'Ativar', 'small', rule.id) + button('delete-opportunity', 'Excluir', 'small danger', rule.id) : '') + '</div></td></tr>').join('');
      return '<p class="info-note">Avisos usam somente ofertas confirmadas e o horário original da mensagem. A mesma oferta não gera alertas repetidos. Os destinos são administradores autorizados; o sistema não contata fornecedores.</p>' + table(['BUSCA MONITORADA', 'PREÇO / VALIDADE', 'ESTADO', 'DESTINATÁRIOS', 'AÇÕES'], rows || empty('Nenhum alerta de oportunidade cadastrado')) + renderDeliveries();
    }
    function groupSelector(values = [], name = 'groupIds') {
      const monitored = ctx.data()?.buscas?.settings?.monitoredGroupIds || [];
      const groups = (ctx.groups?.() || ctx.data()?.groups || []).filter(group => monitored.includes(group.id));
      return '<fieldset class="permission-section" data-commerce-groups="' + e(name) + '"><legend>Grupos monitorados para esta regra</legend><div class="row-actions">' + button('select-groups', 'Selecionar todos os grupos', 'small') + button('clear-groups', 'Desmarcar todos', 'small ghost') + '<span data-commerce-group-count>' + values.length + ' grupo(s) selecionado(s)</span></div>' + groups.map(g => check(g.name, name, g.id, values.includes(g.id))).join('') + (!groups.length ? '<p class="soft-text">Nenhum grupo carregado. Sincronize os grupos da conta conectada.</p>' : '') + '</fieldset>';
    }
    function recipientSelector(values = []) { return '<fieldset class="permission-section"><legend>Administradores autorizados a receber o aviso privado</legend>' + recipients().map(r => check(r.name + ' · ' + r.phone, 'recipientIds', r.id, values.includes(r.id))).join('') + (!recipients().length ? '<p class="warning-note">Cadastre um administrador ativo com número autorizado antes de ativar.</p>' : '') + '</fieldset>'; }
    function opportunityEditor(id) {
      const rule = array('opportunities').find(o => o.id === id) || { enabled: true, maxAgeMinutes: 120, recipientIds: [], groupIds: [] };
      state.draft = { kind: 'opportunity', id };
      const body = '<form id="commerce-opportunity-form"><div class="field-grid">' + field('Nome da regra', 'name', rule.name, 'text', 'required maxlength="160"') + field('Modelo exato', 'model', rule.model, 'text', 'required maxlength="160" placeholder="iPhone 15 Pro Max"') + field('Armazenamento (GB, opcional)', 'storageGB', rule.storageGB ?? '', 'number', 'min="1" max="8192"') + select('Condição', 'condition', rule.condition, [['', 'Qualquer condição explicitamente anunciada'], ['lacrado', 'Lacrado'], ['seminovo', 'Seminovo'], ['usado', 'Usado'], ['cpo', 'CPO']]) + field('Preço total máximo (R$)', 'maxPriceCents', amount(rule.maxPriceCents), 'text', 'required inputmode="decimal"') + field('Idade máxima da oferta (minutos)', 'maxAgeMinutes', rule.maxAgeMinutes || 120, 'number', 'required min="1" max="10080"') + '</div>' + groupSelector(rule.groupIds) + recipientSelector(rule.recipientIds) + check('Ativar regra após salvar', 'enabled', 'yes', rule.enabled) + '<p class="field-hint">Não há comparação automática entre ofertas equivalentes. Esta regra avisa quando uma oferta atende aos filtros e ao preço máximo cadastrados.</p></form>';
      state.dirty = false; ctx.showModal('commerce-opportunity', id ? 'Editar oportunidade' : 'Criar oportunidade', 'Exemplo: avise quando aparecer iPhone 15 Pro Max 256GB até R$ 3.500.', body, button('close', 'Cancelar', 'ghost') + button('save-opportunity', 'Salvar regra', 'primary'));
    }
    function renderDemands() {
      const rows = array('demands').filter(matchesQuery).map(demand => {
        const match = array('matches').filter(m => m.kind === 'demand' && (m.demandId || m.sourceId) === demand.id).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
        return '<tr><td><strong>' + e(demand.buyerName || contacts().find(c => c.id === demand.contactId)?.name || 'Comprador') + '</strong><span class="table-subtitle">' + e(contacts().find(c => c.id === demand.contactId)?.phone || 'Contato não informado') + '</span></td><td>' + e([demand.model, demand.storageGB ? demand.storageGB + 'GB' : '', demand.color, demand.condition].filter(Boolean).join(' · ')) + '<span class="table-subtitle">' + e(demand.notes || '') + '</span></td><td>' + e(money(demand.budgetCents)) + '<span class="table-subtitle">Prazo: ' + e(fmt(demand.interestUntil)) + '</span></td><td>' + e(stateLabel(demand.state)) + (match ? '<span class="table-subtitle">Oferta compatível registrada</span>' : '') + '</td><td><div class="row-actions">' + (can('commerce.manage') ? button('edit-demand', 'Editar', 'small', demand.id) + button('demand-status', 'Alterar status', 'small', demand.id) + (match ? button('review-match', 'Revisar oferta', 'small primary', match.id) : '') + button('delete-demand', 'Excluir', 'small danger', demand.id) : '') + '</div></td></tr>';
      }).join('');
      return '<p class="info-note">O preço final precisa caber no orçamento após o acréscimo de venda. O administrador recebe o aviso; mensagens ao comprador exigem revisão e aprovação explícita.</p>' + table(['COMPRADOR', 'APARELHO PROCURADO', 'ORÇAMENTO / PRAZO', 'STATUS', 'AÇÕES'], rows || empty('Nenhuma procura cadastrada'));
    }
    function demandEditor(id) {
      const demand = array('demands').find(d => d.id === id) || { state: 'searching', maxAgeMinutes: 120, recipientIds: [], groupIds: [], markup: { type: 'fixed', valueCents: 0 } };
      state.draft = { kind: 'demand', id };
      const rule = demand.markup || { type: 'fixed', valueCents: 0 };
      const body = '<form id="commerce-demand-form"><div class="field-grid">' + select('Contato do comprador', 'contactId', demand.contactId, [['', 'Selecione um contato'], ...contacts().map(c => [c.id, c.name + ' · ' + c.phone])], 'required') + field('Nome do comprador', 'buyerName', demand.buyerName, 'text', 'maxlength="160"') + select('Campanha de origem (vínculo registrado, opcional)', 'campaignId', demand.campaignId || '', [['', 'Sem vínculo'], ...(ctx.data()?.campaigns || []).map(c => [c.id, c.name])]) + field('Modelo exato', 'model', demand.model, 'text', 'required maxlength="160"') + field('Armazenamento (GB, opcional)', 'storageGB', demand.storageGB ?? '', 'number', 'min="1" max="8192"') + field('Cor desejada', 'color', demand.color, 'text', 'maxlength="80"') + select('Condição', 'condition', demand.condition, [['', 'Não especificada'], ['lacrado', 'Lacrado'], ['seminovo', 'Seminovo'], ['usado', 'Usado'], ['cpo', 'CPO']]) + field('Orçamento máximo do comprador (R$)', 'budgetCents', amount(demand.budgetCents), 'text', 'required inputmode="decimal"') + field('Prazo de interesse (Brasília)', 'interestUntil', demand.interestUntil ? localDateTime(demand.interestUntil) : '', 'datetime-local') + (can('finance.manage') ? select('Acréscimo sobre custo', 'markupType', rule.type || rule.kind || 'fixed', [['fixed', 'Valor fixo em reais'], ['percent', 'Percentual sobre o custo']]) + field('Acréscimo (R$ ou %)', 'markupValue', rule.type === 'percent' || rule.kind === 'percent' ? (rule.basisPoints ?? rule.percentBasisPoints ?? 0) / 100 : amount(rule.valueCents ?? rule.fixedCents ?? 0), 'text', 'required inputmode="decimal"') : '') + field('Idade máxima da oferta (minutos)', 'maxAgeMinutes', demand.maxAgeMinutes || 120, 'number', 'required min="1" max="10080"') + '</div>' + textarea('Observações e preferências', 'notes', demand.notes, 'maxlength="4000"') + groupSelector(demand.groupIds) + recipientSelector(demand.recipientIds) + '<p class="field-hint">O sistema avisa somente administradores autorizados. O comprador não recebe informações de fornecedores nem mensagens automáticas sem aprovação.</p></form>';
      state.dirty = false; ctx.showModal('commerce-demand', id ? 'Editar procura' : 'Cadastrar aparelho procurado', 'Preferências registradas sem inventar características ou disponibilidade.', body, button('close', 'Cancelar', 'ghost') + button('save-demand', 'Salvar procura', 'primary'));
    }
    function renderDeliveries() {
      const deliveries = array('deliveries').slice(0, 30);
      if (!deliveries.length) return '';
      return '<section class="panel"><div class="panel-header"><h2>Últimos avisos comerciais</h2><span class="soft-text">Status retornado pela integração</span></div><div class="table-scroll"><table><thead><tr><th>OCORRÊNCIA</th><th>DESTINATÁRIO</th><th>ENVIO</th><th>MOTIVO</th></tr></thead><tbody>' + deliveries.map(d => '<tr><td>' + e(fmt(d.createdAt || d.occurrenceAt)) + '<span class="table-subtitle">' + e(d.kind || '') + '</span></td><td>' + e(recipients().find(r => r.id === d.recipientId)?.name || d.number || 'Destinatário autorizado') + '</td><td>' + e(stateLabel(d.status)) + '<span class="table-subtitle">' + e(fmt(d.resultAt || d.submittedAt)) + '</span></td><td>' + e(d.error || d.reason || 'Sem falha registrada') + '<span class="table-subtitle">' + e(d.attempts || 0) + ' tentativa(s)</span></td></tr>').join('') + '</tbody></table></div></section>';
    }
    function renderContacts() {
      const targets = array('promotionTargets');
      const rows = contacts().filter(matchesQuery).map(contact => {
        const target = targets.find(t => t.type === 'contact' && t.targetId === contact.id);
        return '<tr><td><strong>' + e(contact.name) + '</strong><span class="table-subtitle">' + e(contact.phone) + '</span><small>Salvo no sistema — a agenda vinculada não é suportada.</small></td><td>' + e((contact.categories || [contact.category]).filter(Boolean).join(', ') || 'Sem classificação') + '</td><td>' + e(contact.promotionalOptOut || target?.optOut ? 'Não recebe promoções' : contact.promotionPaused || target?.paused ? 'Envios pausados' : contact.promotionalConsent === true ? 'Recebimento autorizado' : 'Consentimento não registrado') + '</td><td>' + e(contact.notes || '') + '</td><td><div class="row-actions">' + (can('contacts.edit') ? button('edit-contact', 'Editar', 'small', contact.id) : '') + (can('contacts.delete') ? button('delete-contact', 'Excluir', 'small danger', contact.id) : '') + (can('commerce.manage') ? button('contact-promotion', 'Preferências de envio', 'small', contact.id) : '') + '</div></td></tr>';
      }).join('');
      return '<p class="info-note">Um contato pode ter várias categorias. Novas mensagens privadas criam pendências para revisão; participantes de grupos não são cadastrados como clientes automaticamente. O cadastro é local; a integração atual não grava na agenda vinculada.</p>' + table(['CONTATO', 'CATEGORIAS', 'PROMOÇÕES', 'OBSERVAÇÕES', 'AÇÕES'], rows || empty('Nenhum contato cadastrado'));
    }
    function contactEditor(id) {
      const contact = contacts().find(c => c.id === id) || { categories: [] };
      state.draft = { kind: 'contact', id };
      const values = contact.categories || [contact.category];
      const names = categories().map(c => c.name || c).filter(Boolean);
      if (!names.length) names.push('Cliente Nerópolis', 'Lojista Camelódromo', 'Fornecedor');
      for (const existing of values) if (existing && !names.includes(existing)) names.push(existing);
      state.dirty = false; ctx.showModal('commerce-contact', id ? 'Editar contato' : 'Cadastrar contato', 'O número real identifica o cadastro, nunca o nome exibido.', '<form id="commerce-contact-form">' + field('Nome salvo', 'name', contact.name, 'text', 'required maxlength="160"') + field('WhatsApp com país e DDD', 'phone', contact.phone, 'tel', 'required maxlength="24" placeholder="5562999999999"') + '<fieldset class="permission-section"><legend>Categorias (pode selecionar mais de uma)</legend>' + names.map(name => check(name, 'categories', name, values.includes(name))).join('') + '</fieldset>' + textarea('Observações', 'notes', contact.notes, 'maxlength="4000"') + '<fieldset class="permission-section"><legend>Autorização e preferências de mensagens promocionais</legend>' + check('Consentimento explícito registrado para receber promoções', 'promotionalConsent', 'yes', contact.promotionalConsent === true) + check('Contato pediu para não receber promoções', 'promotionalOptOut', 'yes', contact.promotionalOptOut === true) + check('Pausar envios para este contato', 'promotionPaused', 'yes', contact.promotionPaused === true) + '</fieldset><p class="field-hint">Uma nova mensagem privada não constitui consentimento para campanhas. Registre a autorização apenas quando ela tiver sido obtida.</p></form>', button('close', 'Cancelar', 'ghost') + button('save-contact', 'Salvar contato', 'primary'));
    }
    function categoriesEditor() {
      ctx.showModal('commerce-categories', 'Categorias de contatos', 'As categorias padrão são preservadas. Categorias personalizadas também podem ser usadas.', '<section class="panel"><div class="panel-body">' + categories().map(category => '<div class="row-actions" style="margin-bottom:8px"><strong>' + e(category.name || category) + '</strong>' + (!category.builtin && category.id ? button('delete-category', 'Excluir categoria', 'small danger', category.id) : '<small>Categoria padrão</small>') + '</div>').join('') + '</div></section><form id="commerce-category-form">' + field('Nova categoria', 'name', '', 'text', 'required maxlength="80"') + '</form>', button('close', 'Fechar', 'ghost') + button('save-category', 'Criar categoria', 'primary'));
    }
    function promotionEditor(type, targetId) {
      const target = array('promotionTargets').find(t => t.type === type && t.targetId === targetId) || {};
      state.draft = { kind: 'promotion', type, targetId };
      const name = type === 'contact' ? contacts().find(c => c.id === targetId)?.name : (ctx.groups?.() || ctx.data()?.groups || []).find(g => g.id === targetId)?.name;
      ctx.showModal('commerce-promotion', 'Preferências — ' + (name || 'destinatário'), 'Esta configuração vale para envios promocionais automáticos.', '<form id="commerce-promotion-form">' + select('Público deste destino', 'audience', target.audience || 'general', [['general', 'Geral — sem tabela específica'], ['retail', 'Varejo'], ['wholesale', 'Atacado']]) + check('Pausar envios promocionais para este destino', 'paused', 'yes', target.paused) + check('Pediu para não receber mensagens promocionais', 'optOut', 'yes', target.optOut) + '</form>', button('close', 'Cancelar', 'ghost') + button('save-promotion', 'Salvar preferência', 'primary'));
    }
    function settingsEditor() {
      const settings = data().settings || {}, retail = settings.retailMarkup || { type: 'fixed', valueCents: 0 }, wholesale = settings.wholesaleMarkup || { type: 'fixed', valueCents: 0 }, schedule = settings.promotionSchedule || { days: [1, 2, 3, 4, 5, 6], startTime: '08:00', endTime: '20:00', timezone: 'America/Sao_Paulo' };
      state.draft = { kind: 'settings' };
      const markupFields = (prefix, label, rule) => '<fieldset class="permission-section"><legend>' + label + '</legend><div class="field-grid">' + select('Tipo de acréscimo sobre o custo', prefix + 'Type', rule.type, [['fixed', 'Valor fixo em reais'], ['percent', 'Percentual sobre o custo']]) + field('Acréscimo (R$ ou %)', prefix + 'Value', rule.type === 'percent' ? (rule.basisPoints || 0) / 100 : amount(rule.valueCents || 0), 'text', 'required inputmode="decimal"') + '</div></fieldset>';
      const groupTargets = array('promotionTargets').filter(t => t.type === 'group');
      const groups = ctx.groups?.() || ctx.data()?.groups || [];
      ctx.showModal('commerce-settings', 'Regras comerciais e frequência', 'Horários, repetição e público dos destinos são conferidos pelo backend.', '<form id="commerce-settings-form">' + (can('finance.manage') ? markupFields('retail', 'Varejo — Cliente Nerópolis', retail) + markupFields('wholesale', 'Atacado — Lojista Camelódromo', wholesale) : '<p class="warning-note">Seu perfil não permite alterar custos ou acréscimos.</p>') + '<div class="field-grid">' + field('Validade de ofertas (minutos)', 'offerMaxAgeMinutes', settings.offerMaxAgeMinutes || 120, 'number', 'required min="1" max="10080"') + field('Horário inicial', 'startTime', schedule.startTime, 'time', 'required') + field('Horário final', 'endTime', schedule.endTime, 'time', 'required') + field('Fuso horário', 'timezone', schedule.timezone || 'America/Sao_Paulo', 'text', 'required') + field('Intervalo mínimo por destinatário (minutos)', 'minimumIntervalMinutes', settings.minimumIntervalMinutes || 0, 'number', 'required min="0" max="10080"') + field('Limite de repetições por oferta (0 = sem limite)', 'repeatLimit', settings.repeatLimit || 0, 'number', 'required min="0" max="100000"') + '</div><fieldset class="permission-section"><legend>Dias permitidos</legend>' + ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((day, index) => check(day, 'days', index, schedule.days?.includes(index))).join('') + '</fieldset></form><section class="panel"><div class="panel-header"><h2>Público dos grupos</h2></div><div class="panel-body">' + groups.map(g => { const t = groupTargets.find(t => t.targetId === g.id); return '<div class="row-actions" style="margin-bottom:8px"><span>' + e(g.name) + ' · ' + e(t?.audience === 'retail' ? 'Varejo' : t?.audience === 'wholesale' ? 'Atacado' : 'Não classificado') + (t?.paused ? ' · Pausado' : '') + '</span>' + button('group-promotion', 'Configurar público', 'small', g.id) + '</div>'; }).join('') + '</div></section>', button('close', 'Cancelar', 'ghost') + button('save-settings', 'Salvar regras', 'primary'));
    }
    async function submit(form) {
      if (!form?.reportValidity()) return;
      let result;
      if (form.id === 'commerce-inventory-form') {
        const item = { id: state.draft.id, kind: v(form, 'kind'), model: v(form, 'model').trim(), storage: v(form, 'storage').trim(), color: v(form, 'color').trim(), condition: v(form, 'condition'), quantity: Number(v(form, 'quantity')), battery: v(form, 'battery') === '' ? null : Number(v(form, 'battery')), warranty: v(form, 'warranty').trim(), supplierId: v(form, 'supplierId') || null, entryAt: timestamp(v(form, 'entryAt')), retailCents: cents(v(form, 'retailCents'), true) ?? 0, wholesaleCents: cents(v(form, 'wholesaleCents'), true) ?? 0, mediaIds: selected(form, 'mediaIds'), notes: v(form, 'notes') };
        if (can('finance.manage')) Object.assign(item, { costCents: cents(v(form, 'costCents'), true), imei: v(form, 'imei'), serial: v(form, 'serial') });
        result = await safeCall('saveInventory', { inventory: item });
      } else if (form.id === 'commerce-supplier-form') {
        const supplier = { id: state.draft.id, name: v(form, 'name').trim(), phone: v(form, 'phone').trim(), categories: v(form, 'categories').split(',').map(s => s.trim()).filter(Boolean) };
        if (fin()) Object.assign(supplier, { paymentTerms: v(form, 'paymentTerms'), warranty: v(form, 'warranty'), deliveryDays: v(form, 'deliveryDays') === '' ? null : Number(v(form, 'deliveryDays')), notes: v(form, 'notes') });
        result = await safeCall('saveSupplier', { supplier });
      } else if (form.id === 'commerce-reservation-form') {
        result = await safeCall('reserveInventory', { reservation: { inventoryId: state.draft.id, quantity: Number(v(form, 'quantity')), buyerId: v(form, 'buyerId') || null, buyerName: v(form, 'buyerName').trim(), expiresAt: timestamp(v(form, 'expiresAt')), depositCents: can('finance.manage') ? cents(v(form, 'depositCents')) : 0, paymentMethod: v(form, 'paymentMethod') || 'pix', idempotencyKey: state.draft.key } });
      } else if (form.id === 'commerce-purchase-form') {
        const inventoryId = v(form, 'inventoryId');
        if (!inventoryId && !v(form, 'model').trim()) throw new Error('Informe o modelo ou nome do novo produto.');
        const line = { quantity: Number(v(form, 'quantity')), unitCostCents: cents(v(form, 'unitCostCents')), ...(inventoryId ? { inventoryId } : { inventory: { kind: v(form, 'kind'), model: v(form, 'model').trim(), storage: v(form, 'storage'), color: v(form, 'color'), condition: v(form, 'condition'), imei: v(form, 'imei'), retailCents: cents(v(form, 'retailCents'), true) ?? 0, wholesaleCents: cents(v(form, 'wholesaleCents'), true) ?? 0 } }) };
        result = await safeCall('recordPurchase', { purchase: { supplierId: state.draft.supplierId, items: [line], purchasedAt: timestamp(v(form, 'purchasedAt')), idempotencyKey: state.draft.key } });
      } else if (form.id === 'commerce-list-form') {
        const lines = selected(form, 'source').map(key => { const index = Number(key), source = state.sources[index], type = v(form, 'lineType-' + index); return { sourceType: source.type, sourceId: source.id, quantity: Number(v(form, 'quantity-' + index)), ...(can('finance.manage') && type ? { markup: markup(type, v(form, 'lineValue-' + index)) } : {}) }; });
        if (!lines.length) throw new Error('Selecione pelo menos um produto.');
        result = await safeCall('saveCommercialList', { list: { id: state.draft.id, expectedRevision: state.draft.expectedRevision, name: v(form, 'name').trim(), audience: v(form, 'audience'), ...(can('finance.manage') ? { markup: markup(v(form, 'markupType'), v(form, 'markupValue')) } : {}), lines } });
        if (!result?.id) throw new Error('O banco não confirmou a persistência da lista.');
        state.dirty = false; await refresh(); await showListPreview(result.id); return;
      } else if (form.id === 'commerce-campaign-form') {
        const groupIds = selected(form, 'groupIds'), contactIds = selected(form, 'contactIds');
        if (!groupIds.length && !contactIds.length) throw new Error('Selecione pelo menos um destino autorizado para este público.');
        result = await safeCall('createCommercialCampaign', { listId: state.draft.listId, name: v(form, 'name').trim(), groupIds, contactIds, intervalMinutes: Number(v(form, 'intervalMinutes')), spacingSeconds: Number(v(form, 'spacingSeconds')) });
        if (!result?.id) throw new Error('O banco não confirmou a criação da campanha.');
      } else if (form.id === 'commerce-opportunity-form') {
        result = await safeCall('saveOpportunity', { opportunity: { id: state.draft.id, name: v(form, 'name').trim(), model: v(form, 'model').trim(), storageGB: v(form, 'storageGB') ? Number(v(form, 'storageGB')) : undefined, condition: v(form, 'condition') || null, maxPriceCents: cents(v(form, 'maxPriceCents')), maxAgeMinutes: Number(v(form, 'maxAgeMinutes')), groupIds: selected(form, 'groupIds'), recipientIds: selected(form, 'recipientIds'), enabled: !!$('[name="enabled"]', form)?.checked } });
      } else if (form.id === 'commerce-demand-form') {
        const contact = contacts().find(c => c.id === v(form, 'contactId'));
        result = await safeCall('saveDemand', { demand: { id: state.draft.id, buyerName: v(form, 'buyerName').trim() || contact?.name, contactId: v(form, 'contactId'), campaignId: v(form, 'campaignId') || null, model: v(form, 'model').trim(), storageGB: v(form, 'storageGB') ? Number(v(form, 'storageGB')) : undefined, color: v(form, 'color').trim(), condition: v(form, 'condition') || null, budgetCents: cents(v(form, 'budgetCents')), interestUntil: timestamp(v(form, 'interestUntil')), notes: v(form, 'notes'), ...(can('finance.manage') ? { markup: markup(v(form, 'markupType'), v(form, 'markupValue')) } : {}), groupIds: selected(form, 'groupIds'), maxAgeMinutes: Number(v(form, 'maxAgeMinutes')), recipientIds: selected(form, 'recipientIds'), state: array('demands').find(d => d.id === state.draft.id)?.state || 'searching' } });
      } else if (form.id === 'commerce-contact-form') {
        const chosen = selected(form, 'categories');
        if (!chosen.length) throw new Error('Escolha pelo menos uma categoria para o contato.');
        result = await safeCall('saveContact', { contact: { id: state.draft.id, name: v(form, 'name').trim(), phone: v(form, 'phone').trim(), categories: chosen, category: chosen[0], notes: v(form, 'notes'), promotionalConsent: !!$('[name="promotionalConsent"]', form)?.checked, promotionalOptOut: !!$('[name="promotionalOptOut"]', form)?.checked, promotionPaused: !!$('[name="promotionPaused"]', form)?.checked } });
      } else if (form.id === 'commerce-category-form') {
        result = await safeCall('saveContactCategory', { name: v(form, 'name').trim() });
      } else if (form.id === 'commerce-promotion-form') {
        result = await safeCall('savePromotionTarget', { type: state.draft.type, targetId: state.draft.targetId, audience: v(form, 'audience'), paused: !!$('[name="paused"]', form)?.checked, optOut: !!$('[name="optOut"]', form)?.checked });
      } else if (form.id === 'commerce-settings-form') {
        const settings = { offerMaxAgeMinutes: Number(v(form, 'offerMaxAgeMinutes')), promotionSchedule: { timezone: v(form, 'timezone'), days: selected(form, 'days').map(Number), startTime: v(form, 'startTime'), endTime: v(form, 'endTime') }, minimumIntervalMinutes: Number(v(form, 'minimumIntervalMinutes')), repeatLimit: Number(v(form, 'repeatLimit')) };
        if (can('finance.manage')) Object.assign(settings, { retailMarkup: markup(v(form, 'retailType'), v(form, 'retailValue')), wholesaleMarkup: markup(v(form, 'wholesaleType'), v(form, 'wholesaleValue')) });
        result = await safeCall('saveCommercialSettings', { settings });
      } else if (form.id === 'commerce-demand-status-form') {
        result = await safeCall('setDemandStatus', { id: state.draft.id, state: v(form, 'state') });
      } else if (form.id === 'commerce-release-form') {
        result = await safeCall('releaseReservation', { id: state.draft.id, reason: v(form, 'reason').trim(), idempotencyKey: state.draft.key });
      } else return false;
      if (result == null || result === false) throw new Error('O banco não confirmou a gravação. Consulte o diagnóstico.');
      state.dirty = false; ctx.closeModal(); await refresh(); ctx.toast(form.id === 'commerce-campaign-form' ? 'Campanha salva desativada. Revise e ative na aba Campanhas.' : 'Registro confirmado no banco local.'); return true;
    }
    async function onAction(action, element) {
      if (!action.startsWith('commerce-')) return false;
      const key = action.slice(9), id = element?.dataset?.id;
      if (state.busy) return true;
      if(key.startsWith('new-')||key.startsWith('edit-')||key==='reserve')await ctx.refresh?.();
      if (key === 'close') { if (state.dirty && !confirm('Descartar as alterações não salvas?')) return true; state.dirty = false; ctx.closeModal(); return true; }
      if (key === 'new-inventory' || key === 'edit-inventory') { inventoryEditor(id); return true; }
      if (key === 'new-supplier' || key === 'edit-supplier') { supplierEditor(id); return true; }
      if (key === 'reserve') { reserveEditor(id); return true; }
      if (key === 'purchase') { purchaseEditor(id); return true; }
      if (key === 'sell') { if (!ctx.openSale) throw new Error('O formulário de confirmação de venda não está disponível.'); ctx.openSale(id); return true; }
      if (key === 'new-opportunity' || key === 'edit-opportunity') { opportunityEditor(id); return true; }
      if (key === 'new-demand' || key === 'edit-demand') { demandEditor(id); return true; }
      if (key === 'new-contact' || key === 'edit-contact') { contactEditor(id); return true; }
      if (key === 'categories') { categoriesEditor(); return true; }
      if (key === 'settings') { settingsEditor(); return true; }
      if (key === 'contact-promotion' || key === 'group-promotion') { if (state.dirty && !confirm('Descartar alterações não salvas para configurar este destino?')) return true; state.dirty = false; promotionEditor(key === 'contact-promotion' ? 'contact' : 'group', id); return true; }
      if (key === 'list-campaign') { campaignEditor(id); return true; }
      if (key === 'select-groups' || key === 'clear-groups') { const parent = element.closest('[data-commerce-groups]'); for (const input of $$('input[type="checkbox"]', parent)) input.checked = key === 'select-groups'; updateGroupCount(parent); state.dirty = true; return true; }
      if (key === 'demand-status') {
        const demand = array('demands').find(d => d.id === id); state.draft = { kind: 'demand-status', id };
        ctx.showModal('commerce-demand-status', 'Status da procura', 'A mudança fica registrada no cadastro.', '<form id="commerce-demand-status-form">' + select('Status', 'state', demand?.state, [['searching', 'Procurando'], ['found', 'Oferta encontrada'], ['negotiating', 'Em negociação'], ['completed', 'Concluído'], ['cancelled', 'Cancelado']]) + '</form>', button('close', 'Cancelar', 'ghost') + button('save-demand-status', 'Salvar status', 'primary')); return true;
      }
      if (key === 'release') {
        state.draft = { kind: 'release', id, key: uid() };
        ctx.showModal('commerce-release', 'Liberar reserva', 'O sinal recebido continua registrado no financeiro; liberação não equivale a estorno.', '<form id="commerce-release-form">' + textarea('Motivo', 'reason', '', 'required maxlength="1000"') + '</form>', button('close', 'Cancelar', 'ghost') + button('save-release', 'Confirmar liberação', 'primary')); return true;
      }
      state.busy = true;
      try {
        if (key === 'reload') { await refresh(); return true; }
        if (key === 'new-list' || key === 'edit-list') { await listEditor(id); return true; }
        if (key === 'preview-list') { await showListPreview(id); return true; }
        if (key.startsWith('save-')) {
          const formId = ({ inventory: 'inventory', supplier: 'supplier', reservation: 'reservation', purchase: 'purchase', list: 'list', campaign: 'campaign', opportunity: 'opportunity', demand: 'demand', contact: 'contact', category: 'category', promotion: 'promotion', settings: 'settings', 'demand-status': 'demand-status', release: 'release' })[key.slice(5)];
          if (formId) await submit($('#commerce-' + formId + '-form')); return true;
        }
        if (key === 'delete-list' || key === 'delete-opportunity' || key === 'delete-demand' || key === 'delete-contact' || key === 'delete-category') {
          if (!confirm('Excluir este cadastro? Registros operacionais e financeiros serão preservados.')) return true;
          await safeCall(({ 'delete-list': 'deleteCommercialList', 'delete-opportunity': 'deleteOpportunity', 'delete-demand': 'deleteDemand', 'delete-contact': 'deleteContact', 'delete-category': 'deleteContactCategory' })[key], { id }); await refresh(); if (key === 'delete-category') categoriesEditor(); ctx.toast('Cadastro excluído.'); return true;
        }
        if (key === 'pause-opportunity' || key === 'activate-opportunity') { await safeCall('setOpportunityState', { id, enabled: key === 'activate-opportunity' }); await refresh(); return true; }
        if (key === 'supplier-history') {
          const supplier = suppliers().find(s => s.id === id), purchases = array('purchases').filter(p => p.supplierId === id);
          const body = purchases.length ? table(['DATA', 'ITENS', 'CUSTO REGISTRADO'], purchases.map(p => '<tr><td>' + e(fmt(p.purchasedAt || p.createdAt)) + '</td><td>' + e((p.items || []).map(i => (inventory().find(product => product.id === i.inventoryId)?.model || 'Produto') + ' × ' + i.quantity).join(', ')) + '</td><td>' + (fin() ? e(money(p.totalCents ?? (p.items || []).reduce((sum, i) => sum + i.quantity * i.unitCostCents, 0))) : 'Informação restrita') + '</td></tr>').join('')) : '<p class="soft-text">Nenhuma compra registrada para este fornecedor.</p>';
          ctx.showModal('commerce-purchases', 'Compras — ' + (supplier?.name || 'fornecedor'), 'Somente compras registradas no sistema.', body, button('close', 'Fechar', 'primary')); return true;
        }
        if (key === 'review-match') {
          const match = array('matches').find(m => m.id === id), demand = array('demands').find(d => d.id === (match?.demandId || match?.sourceId)); state.draft = { kind: 'match', id };
          const text = match?.publicText || match?.previewText;
          ctx.showModal('commerce-match', 'Revisar oferta para ' + (demand?.buyerName || 'comprador'), 'A aprovação prepara um rascunho. O comprador não receberá mensagem automaticamente.', '<p>Oferta compatível com o orçamento: ' + e(money(match?.finalPriceCents ?? match?.priceCents ?? match?.salePriceCents)) + '</p>' + (text ? '<pre class="summary-pre">' + e(text) + '</pre>' : '<p class="soft-text">A prévia comercial será produzida a partir dos fatos confirmados da oferta.</p>') + '<p class="field-hint">Revise modelo, valor, condição e público. A publicação exige uma confirmação adicional.</p>', button('close', 'Cancelar', 'ghost') + button('approve-match', 'Aprovar rascunho para revisão', 'primary', id)); return true;
        }
        if (key === 'approve-match') {
          if (!confirm('Aprovar esta oferta para montar um rascunho, sem envio automático ao comprador?')) return true;
          const result = await safeCall('approveDemandMatch', { id, approved: true });
          ctx.showModal('commerce-demand-draft', 'Rascunho aprovado — revise antes de enviar', 'A aprovação não publicou nem enviou a mensagem.', '<pre class="summary-pre">' + e(result.publicText || result.text || '') + '</pre><p class="field-hint">' + (result.campaign?.id?'Campanha desativada: '+e(result.campaign.id)+'. Abra Campanhas e confirme a prévia para ativar o envio único ao comprador.':'Copie o texto para uma campanha dirigida ao comprador e confirme a prévia antes de ativar.') + ' Custo, lucro e contato do fornecedor não integram o anúncio.</p>', button('close', 'Fechar', 'primary')); await refresh(); return true;
        }
      } finally { state.busy = false; }
      return false;
    }
    function updateGroupCount(parent) { if (!parent) return; const count = $('[data-commerce-group-count]', parent); if (count) count.textContent = $$('input[type="checkbox"]:checked', parent).length + ' grupo(s) selecionado(s)'; }
    function onInput(element) {
      if (element.id === 'commerce-search') { state.query = element.value; ctx.render(true); const input = $('#commerce-search'); input?.focus(); input?.setSelectionRange?.(state.query.length, state.query.length); }
      if (element.closest('[id^="commerce-"][id$="-form"]')) state.dirty = true;
      if (element.closest('#commerce-list-form')) updateCalculations();
    }
    function onChange(element) { onInput(element); updateGroupCount(element.closest('[data-commerce-groups]')); }
    async function onSubmit(form) {
      if (!form.id?.startsWith('commerce-')) return false;
      if (state.busy) return true; state.busy = true;
      try { await submit(form); } finally { state.busy = false; }
      return true;
    }
    function reset() { state.epoch++; state.busy = false; state.dirty = false; state.query = ''; state.draft = null; state.preview = null; state.sources = []; }
    return { render, onAction, onSubmit, onInput, onChange, reset, openInventory: inventoryEditor, hasUnsaved: () => state.dirty, shouldPreserveDOM: () => document.activeElement?.id === 'commerce-search' };
  }
};
