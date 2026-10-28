'use strict';

// The public display is rendered exclusively from the backend's approved
// projection. Campaign captions and other internal data never enter this view.
window.MegaVitrine = {
  create(ctx) {
    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
    const e = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    const copy = value => JSON.parse(JSON.stringify(value));
    const can = permission => ctx.can(permission);
    const canView = () => can('vitrine.view');
    const canManage = () => can('vitrine.manage');
    const mode = () => ctx.data()?.storageMode || ctx.data()?.settings?.integrationMode || 'simulated';
    const money = cents => cents != null && Number.isFinite(Number(cents)) ? (Number(cents) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : 'Preço não cadastrado';
    const localTime = value => value ? new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
    const localInput = value => { if (!value) return ''; const date = new Date(value); return Number.isFinite(date.getTime()) ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` : ''; };
    const priceInput = cents => cents == null ? '' : (Number(cents) / 100).toFixed(2).replace('.', ',');
    const priceCents = text => { if (String(text ?? '').trim() === '') return null; const normalized = String(text).trim().replace(/\s|R\$/gi, '').replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.'); const result = Number(normalized); if (!Number.isFinite(result) || result < 0 || result > 10000000) throw new Error('Informe um preço público válido, sem parcelas ou entradas.'); return Math.round(result * 100); };
    const title = item => [item.model, item.storage ? (typeof item.storage === 'number' ? `${item.storage}GB` : item.storage) : item.storageGB ? `${item.storageGB}GB` : ''].filter(Boolean).join(' • ') || 'Aparelho para revisar';
    const media = id => id ? `mega-media://asset/${encodeURIComponent(id)}` : '';
    const key = item => `${item.campaignId}:${item.itemId || item.id}`;
    const button = (action, label, style = '', id = '', attrs = '') => `<button type="button" class="button ${e(style)}" data-action="vitrine-${e(action)}"${id ? ` data-id="${e(id)}"` : ''} ${attrs}>${e(label)}</button>`;
    const field = (label, name, value = '', attrs = '', type = 'text') => `<label class="field"><span>${e(label)}</span><input name="${e(name)}" type="${e(type)}" value="${e(value)}" ${attrs}></label>`;
    const state = { epoch: 0, loaded: null, draft: null, dirty: false, busy: false, preview: null, editor: false, viewer: false, publicData: null, publicFingerprint: '', index: 0, rotation: null, polling: null, pollingBusy: false, error: '', actorId: null, storageMode: null, licenseAllowed: false };

    function assertLicense() { if (ctx.data()?.license?.allowed !== true) throw new Error('A licença precisa estar válida para abrir ou alterar a vitrine.'); }
    async function call(action, payload) {
      const epoch = state.epoch, actorId = ctx.auth()?.user?.id, storageMode = mode();
      const result = await ctx.call(action, payload);
      if (epoch !== state.epoch || actorId !== ctx.auth()?.user?.id || storageMode !== mode()) throw new Error('A conta ou o modo de integração mudou. Abra a vitrine novamente.');
      if (result?.error) throw new Error(result.error);
      return result;
    }
    async function load() {
      if (!canView() || ctx.data()?.license?.allowed !== true) return;
      state.loaded = await call('vitrineState'); state.error = '';
      if (!state.dirty && !state.editor) state.draft = copy({ config: state.loaded.config || {}, items: state.loaded.items || [] });
    }
    async function maybeLoad() { if (!state.loaded && canView() && ctx.data()?.license?.allowed === true) await load(); }
    function renderDashboard() {
      if (!canView()) return '';
      const publication = state.loaded?.publication || ctx.data()?.vitrine?.publication || {};
      return `<section id="vitrine-dashboard" class="panel vitrine-dashboard"><div class="panel-body"><div><span class="vitrine-eyebrow">DOIS MODOS PARA A SUA LOJA</span><h2>Painel operacional ou TV / Vitrine</h2><p>O painel acompanha o sistema. A vitrine mostra apenas anúncios públicos que você selecionou, revisou e aprovou.</p><small>${publication.publishedAt ? `Última publicação: ${e(localTime(publication.publishedAt))}` : 'Nenhum anúncio é exibido automaticamente.'}</small></div><div class="row-actions">${canManage() ? button('configure', 'Selecionar e revisar anúncios', 'ghost') : ''}${button('open', 'Abrir modo TV', 'primary')}</div></div></section>`;
    }
    function candidateRow(candidate) {
      const selected = (state.draft?.items || []).some(item => key(item) === key(candidate));
      return `<label class="vitrine-candidate"><input type="checkbox" data-vitrine-candidate="${e(key(candidate))}"${selected ? ' checked' : ''}><div class="vitrine-candidate-image">${candidate.mediaId ? `<img src="${e(media(candidate.mediaId))}" alt="" loading="lazy">` : '<span>Sem foto</span>'}</div><span><strong>${e(title(candidate))}</strong><small>${e(candidate.campaignName || candidate.campaignId)} · ${e(candidate.color || 'Cor não informada')}</small>${candidate.defectNotes ? `<small class="vitrine-defect-note">Observações: ${e(candidate.defectNotes)}</small>` : ''}</span></label>`;
    }
    function itemEditor(item, index) {
      return `<article class="vitrine-edit-item" data-vitrine-item="${e(item.id)}"><div class="vitrine-edit-item-title"><h3>${e(title(item))}</h3><div class="row-actions">${button('withdraw', 'Retirar da TV agora', 'small danger', item.id)}${button('remove-item', 'Retirar da seleção', 'small ghost', item.id)}</div></div><div class="field-grid">${field('Modelo público', `model-${index}`, item.model, 'required maxlength="160"')}${field('Memória', `storage-${index}`, item.storage || (item.storageGB ? `${item.storageGB}GB` : ''), 'maxlength="80"')}${field('Cor', `color-${index}`, item.color, 'maxlength="100"')}${field('Preço varejo (R$)', `retail-${index}`, priceInput(item.retailPriceCents), 'inputmode="decimal" placeholder="Não informado"')}${field('Preço atacado (R$)', `wholesale-${index}`, priceInput(item.wholesalePriceCents), 'inputmode="decimal" placeholder="Cadastrar e aprovar para exibir"')}<label class="field"><span>Público</span><select name="audience-${index}"><option value="retail"${item.audience === 'retail' ? ' selected' : ''}>Varejo</option><option value="wholesale"${item.audience === 'wholesale' ? ' selected' : ''}>Atacado</option><option value="both"${item.audience === 'both' ? ' selected' : ''}>Ambos</option></select></label><label class="field"><span>Disponibilidade cadastrada</span><select name="availability-${index}"><option value=""${!item.availability ? ' selected' : ''}>Não informada</option><option value="ready"${item.availability === 'ready' ? ' selected' : ''}>Pronta entrega</option><option value="order"${item.availability === 'order' ? ' selected' : ''}>Sob encomenda</option></select></label>${field('Válido até (horário deste computador)', `expires-${index}`, localInput(item.expiresAt), 'required', 'datetime-local')}</div><label class="field"><span>Descrição pública revisada</span><textarea name="description-${index}" rows="3" maxlength="600" placeholder="Somente informações que podem aparecer para clientes">${e(item.publicDescription || '')}</textarea></label>${item.defectNotes ? `<div class="vitrine-required-notes"><strong>Observações obrigatórias do produto</strong><p>${e(item.defectNotes)}</p><small>Defeitos e ressalvas da publicação original são preservados na apresentação pública.</small></div>` : ''}<p class="field-hint">A legenda original da campanha permanece intacta. Contatos do fornecedor e informações internas não devem ser incluídos na descrição pública.</p></article>`;
    }
    function editorHTML() {
      const draft = state.draft || { config: {}, items: [] }, c = draft.config || {}, candidates = state.loaded?.candidates || [];
      return `<div id="vitrine-editor"><div class="info-note">A TV recebe uma apresentação pública separada. Selecionar ou salvar um rascunho não publica anúncios; é necessário revisar a prévia e confirmar.</div><form id="vitrine-config-form"><fieldset class="vitrine-editor-fields"><legend>Identidade e exibição</legend><div class="field-grid">${field('Nome da loja', 'brandName', c.brandName, 'required maxlength="120"')}${field('Contato comercial exibido', 'commercialContact', c.commercialContact, 'maxlength="100"')}${field('Link público do WhatsApp / vitrine', 'whatsappUrl', c.whatsappUrl, 'maxlength="500" placeholder="https://wa.me/55DDDNUMERO"', 'url')}${field('Link de atendimento aos lojistas / comunidade', 'wholesaleUrl', c.wholesaleUrl, 'maxlength="500"', 'url')}${field('Segundos por anúncio', 'secondsPerItem', c.secondsPerItem || 12, 'min="5" max="300" required', 'number')}<label class="field"><span>Público da vitrine</span><select name="audience"><option value="retail"${c.audience === 'retail' || !c.audience ? ' selected' : ''}>Varejo</option><option value="wholesale"${c.audience === 'wholesale' ? ' selected' : ''}>Atacado</option><option value="mixed"${c.audience === 'mixed' ? ' selected' : ''}>Misto — blocos identificados</option></select></label></div><p class="field-hint">Preço de atacado precisa ser cadastrado e aprovado. O preço de varejo nunca é usado como preço de atacado. A validade de cada anúncio é obrigatória.</p></fieldset><fieldset class="vitrine-editor-fields"><legend>Escolher anúncios das campanhas</legend><div class="vitrine-candidates">${candidates.length ? candidates.map(candidateRow).join('') : '<div class="empty-state"><h3>Nenhum item de campanha disponível</h3><p>Cadastre uma campanha com fotos e informações reais. Nenhuma oferta capturada entra na TV sem sua seleção.</p></div>'}</div></fieldset><div class="vitrine-selected-heading"><h3>Apresentação pública selecionada</h3><span id="vitrine-selected-count">${draft.items.length} anúncio(s)</span></div>${draft.items.map(itemEditor).join('') || '<p class="soft-text">Selecione um item acima para revisar as informações públicas.</p>'}</form>${state.error ? `<div class="warning-note" role="status">${e(state.error)}</div>` : ''}</div>`;
    }
    function openEditor() {
      state.editor = true;
      ctx.showModal('vitrine-editor', 'Preparar TV / Vitrine', 'Escolha, revise e aprove antes de exibir para os clientes', editorHTML(), `${button('save', 'Salvar rascunho', 'ghost')}${button('preview', 'Revisar prévia pública', 'primary')}${button('close-editor', 'Fechar', 'ghost')}`);
    }
    function collect() {
      const form = $('#vitrine-config-form'); if (!form || !state.draft) return;
      const value = name => form.elements.namedItem(name)?.value?.trim() || '';
      state.draft.config = { ...state.draft.config, brandName: value('brandName'), commercialContact: value('commercialContact'), whatsappUrl: value('whatsappUrl'), wholesaleUrl: value('wholesaleUrl'), secondsPerItem: Number(value('secondsPerItem')), audience: value('audience') };
      state.draft.items = state.draft.items.map((item, index) => ({ ...item, model: value(`model-${index}`), storage: value(`storage-${index}`), color: value(`color-${index}`), retailPriceCents: priceCents(value(`retail-${index}`)), wholesalePriceCents: priceCents(value(`wholesale-${index}`)), audience: value(`audience-${index}`), availability: value(`availability-${index}`), expiresAt: value(`expires-${index}`) ? new Date(value(`expires-${index}`)).getTime() : null, publicDescription: value(`description-${index}`) }));
    }
    function displayItemHTML(item, config, qrCode, preview = false) {
      const audience = item.audience === 'wholesale' ? 'ATACADO · PARA LOJISTAS' : 'VAREJO · PARA VOCÊ';
      const qr = typeof qrCode === 'string' && /^data:image\/(?:png|svg\+xml);/i.test(qrCode) ? qrCode : null;
      const observation = [item.defectNotes, item.publicDescription].filter(Boolean).join('\n');
      return `<div class="vitrine-screen${preview ? ' vitrine-screen-preview' : ''}"><header class="vitrine-brand-line"><span>${e(config.brandName || 'Nossa loja')}</span><span class="vitrine-audience">${e(audience)}</span></header><div class="vitrine-main"><div class="vitrine-photo">${item.mediaId ? `<img src="${e(media(item.mediaId))}" alt="${e(title(item))}" draggable="false">` : '<div class="vitrine-photo-placeholder">Conheça esta oferta</div>'}</div><div class="vitrine-product"><div class="vitrine-product-label">${e(item.availability === 'ready' ? 'PRONTA ENTREGA' : item.availability === 'order' ? 'SOB ENCOMENDA' : '')}</div><h1>${e(item.model || 'Aparelho')}</h1><div class="vitrine-specs">${e(item.storage ? (typeof item.storage === 'number' ? `${item.storage}GB` : item.storage) : item.storageGB ? `${item.storageGB}GB` : '')}${item.color ? `<span>· ${e(item.color)}</span>` : ''}</div><div class="vitrine-price">${e(money(item.priceCents))}</div>${observation ? `<div class="vitrine-observations">${e(observation)}</div>` : ''}</div></div><footer class="vitrine-public-footer"><div>${item.audience === 'wholesale' ? '<strong>Consulte nossa lista para lojistas</strong>' : '<strong>Gostou? Fale com a nossa equipe</strong>'}${config.commercialContact ? `<span>${e(config.commercialContact)}</span>` : ''}${item.audience === 'wholesale' && config.updatedAt ? `<small>Lista atualizada em ${e(localTime(config.updatedAt))}</small>` : ''}</div>${qr ? `<div class="vitrine-qr"><img src="${e(qr)}" alt="QR code do atendimento comercial"><span>Aponte a câmera</span></div>` : ''}</footer></div>`;
    }
    function neutralHTML(config = {}) { return `<div class="vitrine-neutral"><div class="vitrine-neutral-symbol" aria-hidden="true">✦</div><h1>${e(config.brandName || 'Nossa loja')}</h1><p>Seja bem-vindo</p>${config.commercialContact ? `<span>${e(config.commercialContact)}</span>` : ''}</div>`; }
    function validPublicItems(data) { const now = Date.now(); return (data?.items || []).filter(item => item.enabled !== false && item.expiresAt && Number(item.expiresAt) > now && item.priceCents != null && Number.isFinite(Number(item.priceCents)) && Number(item.priceCents) >= 0); }
    function stopRotation() { if (state.rotation != null) clearTimeout(state.rotation); state.rotation = null; }
    function renderViewer() {
      const root = $('#vitrine-tv-root'); if (!state.viewer || !root) return;
      stopRotation();
      const data = state.publicData || {}, config = data.config || {}, items = state.licenseAllowed && data.mode === 'vitrine' ? validPublicItems(data) : [];
      if (state.index >= items.length) state.index = 0;
      const slide = items[state.index];
      root.innerHTML = `${state.licenseAllowed && mode()==='simulated' ? '<div class="vitrine-simulation-banner">SIMULAÇÃO — DADOS FICTÍCIOS</div>' : ''}<div class="vitrine-display" aria-live="off">${slide ? displayItemHTML(slide, config, slide.audience === 'wholesale' ? data.wholesaleQrCode || data.qrCode : data.qrCode) : neutralHTML(config)}</div><div class="vitrine-controls">${button('exit', 'Sair da TV · Esc', 'small ghost')}${slide ? button('next', 'Próximo anúncio', 'small ghost') : ''}</div>`;
      if (slide) {
        const delay = Math.min(Math.max(3, Math.min(300, Number(config.secondsPerItem) || 12)) * 1000, Math.max(1, Number(slide.expiresAt) - Date.now()));
        state.rotation = setTimeout(() => { state.index = (state.index + 1) % Math.max(1, validPublicItems(state.publicData).length); renderViewer(); }, delay);
      }
    }
    async function refreshPublic() {
      if (!state.viewer || state.pollingBusy || !state.licenseAllowed) return;
      state.pollingBusy = true;
      const epoch = state.epoch;
      try {
        const data = await call('vitrinePublic'); if (!state.viewer || epoch !== state.epoch) return;
        const fingerprint = JSON.stringify(data);
        if (fingerprint !== state.publicFingerprint) { const old = validPublicItems(state.publicData)[state.index]; state.publicData = data; state.publicFingerprint = fingerprint; const next = old ? validPublicItems(data).findIndex(item => item.id === old.id && item.audience === old.audience) : -1; state.index = next >= 0 ? next : 0; renderViewer(); }
      } catch (error) {
        if (epoch === state.epoch && state.viewer) { state.publicData = { mode: 'neutral', config: state.publicData?.config || {} }; state.publicFingerprint = ''; renderViewer(); if (state.error !== error.message) { state.error = error.message; ctx.toast(`Vitrine pausada: ${error.message}`, true); } }
      } finally { state.pollingBusy = false; }
    }
    async function openViewer() {
      assertLicense(); if (!canView()) throw new Error('Seu perfil não permite abrir a vitrine.');
      const data = await call('vitrinePublic');
      if (ctx.data()?.license?.allowed !== true) throw new Error('A licença mudou antes da abertura. A vitrine não foi iniciada.');
      stop(); state.viewer = true; state.licenseAllowed = true; state.publicData = data; state.publicFingerprint = JSON.stringify(data); state.index = 0;
      const root = document.createElement('section'); root.id = 'vitrine-tv-root'; root.className = 'vitrine-tv-root'; root.setAttribute('aria-label', 'Vitrine pública da loja'); document.body.appendChild(root); document.body.classList.add('tv-mode'); renderViewer();
      state.polling = setInterval(() => { void refreshPublic(); }, 3000);
      try { await root.requestFullscreen?.(); } catch { /* Electron may refuse fullscreen; the overlay still fills the available window. */ }
    }
    function stop() {
      stopRotation(); if (state.polling != null) clearInterval(state.polling); state.polling = null; state.viewer = false; state.pollingBusy = false; state.publicData = null; state.publicFingerprint = ''; state.index = 0;
      $('#vitrine-tv-root')?.remove(); document.body.classList.remove('tv-mode'); if (document.fullscreenElement?.id === 'vitrine-tv-root') void document.exitFullscreen?.().catch(() => {});
    }
    function sync(snapshot) {
      const license = snapshot?.license || {}, allowed = license.allowed === true;
      const expired = license.totalBlocked === true || license.allowed === false && (license.status === 'expired' || ['LICENSE_EXPIRED', 'LICENSE_TRIAL_EXPIRED', 'TRIAL_EXPIRED'].includes(license.reasonCode));
      // The expired snapshot intentionally omits the user and integration.
      // Keep the public screen mounted and expose only the approved brand.
      if (expired) {
        state.epoch++; state.preview = null; state.editor = false; state.loaded = null; state.draft = null; state.dirty = false;
        stopRotation(); if (state.polling != null) clearInterval(state.polling); state.polling = null;
        state.licenseAllowed = false;
        if (state.viewer) { state.publicData = { mode: 'neutral', config: { brandName: state.publicData?.config?.brandName || '' }, items: [] }; state.publicFingerprint = ''; state.index = 0; renderViewer(); }
        return;
      }
      const actorId = snapshot?.auth?.user?.id || null, storageMode = snapshot?.storageMode || snapshot?.settings?.integrationMode || state.storageMode || 'simulated';
      if ((state.actorId != null && actorId !== state.actorId) || (state.storageMode != null && storageMode !== state.storageMode)) reset();
      state.actorId = actorId; state.storageMode = storageMode;
      if (state.licenseAllowed && !allowed && state.viewer) { state.publicData = { mode: 'neutral', config: { brandName: state.publicData?.config?.brandName || '' }, items: [] }; state.publicFingerprint = ''; state.index = 0; stopRotation(); state.licenseAllowed = false; renderViewer(); }
      // Renewal unlocks configuration, but never restores an old publication.
      if (allowed && !state.licenseAllowed && state.viewer) { state.publicData = { mode: 'neutral', config: { brandName: state.publicData?.config?.brandName || '' }, items: [] }; renderViewer(); }
      state.licenseAllowed = allowed;
    }
    async function onAction(action, element = { dataset: {} }) {
      const name = action.slice('vitrine-'.length), id = element.dataset.id;
      if (name === 'exit') { stop(); return true; }
      if (name === 'next') { if (state.viewer) { state.index++; renderViewer(); } return true; }
      assertLicense();
      if (name === 'open') { await openViewer(); return true; }
      if (!canManage()) throw new Error('Seu perfil não permite gerenciar anúncios da vitrine.');
      if (name === 'configure') { await load(); state.draft = copy({ config: state.loaded.config || {}, items: state.loaded.items || [] }); state.dirty = false; state.preview = null; openEditor(); return true; }
      if (name === 'close-editor') { if (state.dirty && !confirm('Fechar a configuração e descartar alterações não salvas?')) return true; state.editor = false; state.dirty = false; state.preview = null; ctx.closeModal(); return true; }
      if (name === 'remove-item') { collect(); const item = state.draft.items.find(value => value.id === id); if (!item) return true; if (!confirm('Retirar este item da seleção? Para remover da TV imediatamente, use “Retirar da TV”.')) return true; state.draft.items = state.draft.items.filter(value => value.id !== id); state.dirty = true; state.preview = null; openEditor(); return true; }
      if (name === 'withdraw') { if (!confirm('Retirar este anúncio da TV imediatamente? A campanha original será preservada.')) return true; const result = await call('vitrineWithdraw', { id }); if (!result?.withdrawn) throw new Error('A retirada não foi confirmada.'); state.dirty = false; await load(); state.draft = copy({ config: state.loaded.config || {}, items: state.loaded.items || [] }); if (state.editor) openEditor(); if (state.viewer) await refreshPublic(); ctx.toast('Anúncio retirado da TV.'); return true; }
      if (name === 'back') { state.preview = null; openEditor(); return true; }
      if (name === 'save' || name === 'preview') {
        const form = $('#vitrine-config-form'); if (form && !form.reportValidity()) return true; collect();
        if (name === 'save') { const saved = await call('vitrineSave', copy(state.draft)); if (!saved?.config || !Array.isArray(saved.items)) throw new Error('O sistema não confirmou a gravação da vitrine.'); state.loaded = { ...state.loaded, ...saved }; state.draft = copy({ config: saved.config, items: saved.items }); state.dirty = false; openEditor(); ctx.toast('Rascunho da vitrine salvo. Nenhum anúncio foi publicado.'); return true; }
        const preview = await call('vitrinePreview', copy(state.draft)); if (!preview?.previewToken || !Array.isArray(preview.publicItems)) throw new Error('A prévia pública não foi confirmada.'); state.preview = preview;
        ctx.showModal('vitrine-preview', 'Revisar apresentação pública', `${preview.publicItems.length} anúncio(s) · somente conteúdo público`, `<div id="vitrine-public-preview">${(preview.warnings || []).map(w => `<div class="warning-note">${e(typeof w === 'string' ? w : w.message || w.reason)}</div>`).join('')}${preview.publicItems.map(item => `<article class="vitrine-preview-item">${displayItemHTML(item, preview.config || {}, item.audience === 'wholesale' ? preview.wholesaleQrCode || preview.qrCode : preview.qrCode, true)}<div class="vitrine-preview-validity">Válido até ${e(localTime(item.expiresAt))}</div></article>`).join('') || '<div class="empty-state"><h3>Nenhum anúncio elegível</h3><p>Confira os preços do público escolhido e a validade dos itens.</p></div>'}<p class="field-hint">A publicação mostra somente esta apresentação revisada. A legenda completa da campanha continua preservada.</p></div>`, `${button('publish', 'Aprovar e publicar na TV', 'primary', '', preview.publicItems.length ? '' : 'disabled')}${button('back', 'Voltar para editar', 'ghost')}`); return true;
      }
      if (name === 'publish') {
        if (!state.preview?.previewToken || !state.preview.publicItems.length || ctx.modalKind?.() !== 'vitrine-preview') throw new Error('Revise uma prévia válida antes de publicar.');
        if (!confirm(`Publicar ${state.preview.publicItems.length} anúncio(s) revisado(s) na TV? Confira os preços públicos e as observações do produto.`)) return true;
        const result = await call('vitrinePublish', { previewToken: state.preview.previewToken, confirm: true }); if (result?.published !== true) throw new Error('A publicação não foi confirmada.'); state.preview = null; state.editor = false; state.dirty = false; await load(); ctx.closeModal(); await ctx.refresh?.(); ctx.render(true); ctx.toast('Apresentação pública aprovada e publicada.'); return true;
      }
      return false;
    }
    async function onChange(element) {
      if (!element.closest?.('#vitrine-config-form')) return;
      if (!canManage()) throw new Error('Seu perfil não permite alterar a vitrine.');
      state.preview = null; state.dirty = true;
      if (element.dataset.vitrineCandidate) {
        collect(); const candidate = state.loaded?.candidates?.find(item => key(item) === element.dataset.vitrineCandidate); if (!candidate) throw new Error('O item não está mais disponível nesta campanha.');
        if (element.checked && !state.draft.items.some(item => key(item) === key(candidate))) { const candidateItem = { id: candidate.id || `tv-${candidate.campaignId}-${candidate.itemId}`, campaignId: candidate.campaignId, itemId: candidate.itemId, model: candidate.model || '', storage: candidate.storage || (candidate.storageGB ? `${candidate.storageGB}GB` : ''), color: candidate.color || '', publicDescription: candidate.publicDescription || '', defectNotes: candidate.defectNotes || '', retailPriceCents: candidate.suggestedRetailPriceCents ?? null, wholesalePriceCents: null, audience: 'retail', availability: candidate.availability || '', mediaId: candidate.mediaId || '', expiresAt: candidate.expiresAt || Date.now() + 86400000 }; state.draft.items.push(candidateItem); }
        else if (!element.checked) state.draft.items = state.draft.items.filter(item => key(item) !== key(candidate));
        openEditor();
      }
    }
    function onInput(element) { if (element.closest?.('#vitrine-config-form')) { state.dirty = true; state.preview = null; } }
    async function onSubmit(form) { if (form.id === 'vitrine-config-form') { await onAction('vitrine-preview'); return true; } return false; }
    function reset() { state.epoch++; stop(); Object.assign(state, { loaded: null, draft: null, dirty: false, busy: false, preview: null, editor: false, error: '' }); }
    document.addEventListener('keydown', event => { if (state.viewer && event.key === 'Escape') { event.preventDefault(); stop(); } });
    return { renderDashboard, load, maybeLoad, onAction, onSubmit, onChange, onInput, sync, stop, reset, hasUnsaved: () => state.dirty, shouldPreserveDOM: () => state.editor && state.dirty };
  }
};
