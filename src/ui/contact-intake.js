'use strict';

window.KennedContactIntakeUI = {
  create(ctx) {
    const state = { result: null, epoch: 0, dirty: false, submitting: false };
    const e = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const can = permission => ctx.can?.(permission) ?? ctx.auth()?.permissions?.includes(permission) ?? ctx.auth()?.user?.permissions?.includes(permission);
    const fmt = value => { try { return new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }); } catch { return '—'; } };
    const live = () => ctx.data()?.pendingContacts || state.result || { items: [], total: 0 };
    const call = async (action, payload) => {
      const epoch = state.epoch, actor = ctx.auth()?.user?.id, mode = ctx.data()?.storageMode;
      const result = await ctx.call(action, payload);
      if (epoch !== state.epoch || actor !== ctx.auth()?.user?.id || mode !== ctx.data()?.storageMode) throw new Error('O usuário ou modo de operação mudou. Atualize a tela.');
      return result;
    };
    async function load() { if (can('contacts.view')) state.result = await call('listPendingContacts', { limit: 50 }); }
    function render() {
      if (!can('contacts.view')) return '';
      const result = live(), rows = Array.isArray(result) ? result : result.items || [];
      return '<section id="contact-intake-panel" class="panel"><div class="panel-header"><h2>Novos contatos para classificar</h2><span class="soft-text">'+e(result.total ?? rows.length)+' pendência(s)</span></div><div class="panel-body">'+
        '<p class="soft-text">Somente mensagens privadas de números novos criam pendências. O contato será salvo neste computador; a integração não permite gravar na agenda vinculada ao WhatsApp.</p>'+
        (rows.length ? rows.map(p => '<article class="role-card"><strong>'+e(p.phone)+'</strong><p class="soft-text">Perfil no WhatsApp: '+e(p.profileName || 'Nome não informado')+' · Primeiro contato: '+e(fmt(p.firstContactAt))+'</p>'+
          '<form class="contact-intake-form" data-pending-id="'+e(p.id)+'"><div class="field-grid"><div class="field"><label>Nome para salvar</label><input name="contactIntakeName" value="'+e(p.profileName || '')+'" required maxlength="120" '+(!can('contacts.create')?'disabled':'')+'></div><div class="field"><label>Classificação</label><select name="contactIntakeCategory" required '+(!can('contacts.create')?'disabled':'')+'><option value="">Selecione</option><option>Cliente Nerópolis</option><option>Lojista Camelódromo</option></select></div></div><div class="row-actions">'+
          (can('contacts.create')?'<button type="submit" class="button primary">Salvar e classificar</button>':'')+
          (can('contacts.edit')?'<button type="button" class="button ghost" data-action="contact-intake-dismiss" data-id="'+e(p.id)+'">Dispensar pendência</button>':'')+
          '</div></form></article>').join('') : '<p class="soft-text">Nenhum número novo aguardando classificação.</p>')+
        '</div></section>';
    }
    async function onSubmit(form) {
      if (!form.classList.contains('contact-intake-form')) return false;
      if (state.submitting || !form.reportValidity()) return true;
      state.submitting = true;
      try {
        const result = await call('savePendingContact', { id: form.dataset.pendingId, name: form.elements.contactIntakeName.value.trim(), category: form.elements.contactIntakeCategory.value });
        state.dirty = false;
        await load(); await ctx.refresh?.(); ctx.render(true);
        ctx.toast(result.message || 'Contato salvo no cadastro local do sistema.');
      } finally { state.submitting = false; }
      return true;
    }
    async function onAction(action, id) {
      if (action !== 'contact-intake-dismiss') return false;
      await call('dismissPendingContact', { id }); state.dirty = false;
      await load(); await ctx.refresh?.(); ctx.render(true); ctx.toast('Pendência dispensada. Nenhum contato foi cadastrado.');
      return true;
    }
    function onInput(el) { if (el.closest('.contact-intake-form')) state.dirty = true; }
    function reset() { state.epoch++; state.result = null; state.dirty = false; state.submitting = false; }
    function shouldPreserveDOM() { return state.dirty || Boolean(document.activeElement?.closest('.contact-intake-form')); }
    return { render, load, onAction, onSubmit, onInput, reset, shouldPreserveDOM, hasUnsaved: () => state.dirty };
  }
};
