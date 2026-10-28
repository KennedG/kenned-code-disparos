'use strict';

window.KennedLicenseUI = {
  create(ctx) {
    const $ = (selector, root = document) => root.querySelector(selector);
    const e = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    const labels = { trial: 'Teste gratuito', active: 'Licença ativa', expired: 'Prazo encerrado', offline: 'Validação offline', connection_required: 'Conexão necessária', 'network-required': 'Conexão necessária', revoked: 'Licença revogada', invalid: 'Licença inválida', verifying: 'Validando licença', pending: 'Validando licença', unconfigured: 'Serviço não configurado', unavailable: 'Serviço indisponível' };
    const plans = { trial: 'Teste gratuito de 72 horas', monthly: 'Mensal — 1 mês de calendário', annual: 'Anual — 1 ano de calendário' };
    const blockedActions = new Set(['activate', 'resume', 'confirm-activation', 'resume-automation', 'test-recipient', 'test-alert', 'retry-alert', 'simulation-command', 'buscas-test-recipient', 'buscas-retry-delivery', 'buscas-confirm-list', 'buscas-retry-list-delivery', 'reminders-activate', 'reminders-test']);
    const state = { license: null, receivedAt: 0, busy: false, blocked: null, authenticatedId: null, refreshingClock: false, error: '', errorCode: '' };
    const live = () => state.license || ctx.data()?.license || {};
    const clock = () => performance.now();
    const remaining = () => Math.max(0, Number(live().remainingMs || 0) - Math.max(0, clock() - state.receivedAt));
    const duration = milliseconds => {
      const minutes = Math.max(0, Math.ceil(milliseconds / 60000));
      if (minutes >= 1440) return `${Math.floor(minutes / 1440)} dia(s) e ${Math.floor(minutes % 1440 / 60)}h`;
      if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}min`;
      return `${minutes}min`;
    };
    const format = at => { if (!at) return '—'; try { return new Date(at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'medium' }) + ' (Brasília)'; } catch { return 'Data indisponível'; } };
    const button = (action, text, style = '') => `<button type="button" class="button ${style}" data-action="license-${action}" ${state.busy ? 'disabled' : ''}>${e(text)}</button>`;
    function warning() {
      const license = live();
      if (license.allowed === false) return license.reason || 'As operações de envio estão bloqueadas. Ative uma licença ou valide a conexão com o serviço.';
      if (license.status === 'offline' || license.reason && license.allowed === true) return `${license.reason || 'Sem contato com o serviço.'} Validação offline limitada a ${format(license.offlineUntil)} e ao vencimento.`;
      if (remaining() > 0 && remaining() <= (license.plan === 'trial' || license.status === 'trial' ? 86400000 : 3 * 86400000)) return 'Seu prazo está perto do fim. A renovação antecipada acrescenta o período ao vencimento atual.';
      return '';
    }
    function facts() {
      const license = live();
      return `<dl class="license-facts"><div><dt>Plano</dt><dd>${e(plans[license.plan] || (license.status === 'trial' ? plans.trial : 'Nenhum plano ativo'))}</dd></div><div><dt>Status</dt><dd>${e(labels[license.status] || license.status || 'Aguardando validação')}</dd></div><div><dt>Tempo restante</dt><dd data-license-remaining>${license.expiresAt ? e(duration(remaining())) : '—'}</dd></div><div><dt>Vencimento exato</dt><dd>${e(format(license.expiresAt))}</dd></div>${license.trialStartedAt ? `<div><dt>Início do teste</dt><dd>${e(format(license.trialStartedAt))}</dd></div>` : ''}${license.offlineUntil ? `<div><dt>Limite sem validação online</dt><dd>${e(format(license.offlineUntil))}</dd></div>` : ''}</dl>`;
    }
    function form() {
      return `<form id="license-activation-form" autocomplete="off"><div class="field"><label for="license-key">Chave de licença</label><input id="license-key" name="key" type="password" class="form-control" required maxlength="160" autocomplete="off" spellcheck="false" placeholder="Cole aqui a chave recebida" ${state.busy ? 'disabled' : ''}><span class="field-hint">A primeira ativação exige internet. A chave vincula o período contratado a este dispositivo.</span></div><div class="license-form-actions"><button type="submit" class="button primary" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Validando…' : 'Ativar licença'}</button>${button('refresh', 'Verificar conexão e licença', 'ghost')}</div><div id="license-feedback" class="license-feedback${state.error ? ' error' : ''}" role="status" aria-live="polite">${e(state.error)}${state.errorCode ? `<small>Código: ${e(state.errorCode)}</small>` : ''}</div></form>`;
    }
    function preservation() {
      const stopped = ctx.data()?.automation?.stopped === true;
      return `<p class="soft-text">Campanhas, contatos, mídias, modelos e históricos permanecem salvos quando o prazo termina. Configurações, consulta e exportação continuam disponíveis conforme suas permissões.</p>${live().autoResumeRequired || stopped ? `<div class="warning-note">Após ativar ou renovar, os envios permanecem pausados. Revise a programação e confirme a retomada do sistema e das campanhas que deseja usar.</div>${live().allowed === true && ctx.can('automation.control') ? button('resume', 'Revisar e retomar o sistema', 'primary') : ''}` : ''}<div class="settings-actions">${ctx.can('settings.edit') ? '<button type="button" class="button" data-action="backup">Exportar backup dos meus dados</button>' : ''}${ctx.can('history.export') ? '<button type="button" class="button ghost" data-action="export-history">Exportar históricos</button>' : ''}</div>`;
    }
    function renderPage() {
      return `<section id="license-page"><div class="page-heading"><div><div class="eyebrow">ACESSO AO APLICATIVO</div><h1>Ativar licença</h1><p class="subtitle">Teste gratuito, ativação automática e renovação sem perder seus dados.</p></div></div><div class="license-layout"><section class="panel"><div class="panel-header"><h2>Sua licença</h2></div><div class="panel-body"><div data-license-page-facts>${facts()}</div><div data-license-page-warning>${warning() ? `<div class="warning-note">${e(warning())}</div>` : ''}</div><p class="soft-text">O prazo mensal ou anual começa na primeira ativação bem-sucedida. Repetir a mesma chave não acrescenta tempo. O teste restante não reduz o período pago.</p>${form()}</div></section><section class="panel"><div class="panel-header"><h2>Seus dados e a retomada</h2></div><div class="panel-body">${preservation()}<p class="field-hint">O horário de validade é controlado pelo serviço de licenciamento. A validação offline dura até 72 horas e nunca ultrapassa o vencimento.</p>${live().serverConfigured === false ? '<div class="warning-note">O endereço do serviço de licenciamento ainda não está configurado. Não é possível validar uma chave neste estado.</div>' : ''}</div></section></div></section>`;
    }
    function renderPanel() {
      return `<section id="settings-license" class="panel"><div class="panel-header"><h2>Licença do aplicativo</h2>${button('open', 'Ativar ou renovar', 'primary')}</div><div class="panel-body">${facts()}${warning() ? `<div class="warning-note">${e(warning())}</div>` : ''}<p class="field-hint">Teste e ativações usam o horário do serviço. Renovar não reinicia automaticamente campanhas pausadas.</p></div></section>`;
    }
    function sync(snapshot) {
      if (!snapshot?.license) return false;
      const license = snapshot.license;
      if (license !== state.license) { state.license = license; state.receivedAt = clock(); state.refreshingClock = false; }
      const blocked = license.allowed === false, actor = snapshot.auth?.authenticated ? snapshot.auth.user?.id || 'authenticated' : null;
      const becameBlocked = Boolean(blocked && (state.blocked !== true || actor && actor !== state.authenticatedId));
      state.blocked = blocked; state.authenticatedId = actor;
      return becameBlocked;
    }
    function updateChrome() {
      const license = live(), pill = $('#license-indicator'), banner = $('#license-banner');
      if (pill) { pill.hidden = !state.license; pill.classList.toggle('license-blocked', license.allowed === false); pill.innerHTML = `${e(labels[license.status] || 'Licença')} ${license.expiresAt ? `· <span data-license-remaining>${e(duration(remaining()))}</span>` : ''}`; pill.title = `Vencimento: ${format(license.expiresAt)}`; }
      if (banner) { const message = warning(); banner.hidden = !message; banner.classList.toggle('license-blocked', license.allowed === false); banner.innerHTML = message ? `<div><strong>${license.allowed === false ? 'AUTOMAÇÕES BLOQUEADAS PELA LICENÇA' : 'Aviso de licença'}</strong><small>${e(message)}</small></div>${button('open', license.allowed === false ? 'Ativar licença' : 'Ver licença', 'small primary')}` : ''; }
      const settingsPanel = $('#settings-license'); if (settingsPanel) settingsPanel.outerHTML = renderPanel();
      const pageFacts = $('[data-license-page-facts]'); if (pageFacts) pageFacts.innerHTML = facts();
      const pageWarning = $('[data-license-page-warning]'); if (pageWarning) pageWarning.innerHTML = warning() ? `<div class="warning-note">${e(warning())}</div>` : '';
      updateAuth();
    }
    function updateAuth() {
      const card = $('#auth-root .auth-card'); if (!card || !state.license) return;
      let panel = $('#auth-license', card); if (!panel) { panel = document.createElement('div'); panel.id = 'auth-license'; panel.className = 'auth-license'; card.prepend(panel); }
      panel.innerHTML = `<div><strong>${e(labels[live().status] || 'Licença do aplicativo')}</strong><small>${live().expiresAt ? `<span data-license-remaining>${e(duration(remaining()))}</span> · até ${e(format(live().expiresAt))}` : e(live().reason || 'Aguardando validação do serviço')}</small></div>${button('open', live().allowed === false ? 'Ativar licença' : 'Ver licença', 'small')}`;
    }
    function open() {
      state.error = ''; state.errorCode = '';
      if (ctx.auth()?.authenticated) { ctx.navigate('license'); return; }
      ctx.showModal('license', 'Ativar licença', 'Sua ativação é validada automaticamente pelo serviço.', facts() + form(), '<span class="soft-text">Seus dados permanecem no computador.</span><button type="button" class="button ghost" data-action="close-modal">Voltar ao acesso</button>', true);
    }
    function errorNotice(error, submittedKey = '') {
      const known = { KEY_INVALID: 'Chave inválida. Confira a chave recebida.', KEY_USED: 'Esta chave já está vinculada a outro dispositivo.', CHALLENGE_INVALID: 'A validação de segurança expirou. Tente novamente.', RATE_LIMIT: 'Aguarde antes de tentar novamente.', INVALID_KEY: 'Chave inválida. Confira a chave recebida.', KEY_ALREADY_USED: 'Esta chave já está vinculada a outro dispositivo.', KEY_EXPIRED: 'O prazo desta chave terminou. Use uma nova chave para renovar.', KEY_REVOKED: 'Esta chave foi revogada.', DEVICE_MISMATCH: 'Esta chave já está vinculada a outro dispositivo.', LICENSE_KEY_INVALID: 'Chave inválida. Confira a chave recebida.', LICENSE_KEY_USED: 'Esta chave já está vinculada a outro dispositivo.', LICENSE_DEVICE_MISMATCH: 'Este comprovante pertence a outro dispositivo ou serviço.', LICENSE_EXPIRED: 'O prazo desta licença terminou. Use uma nova chave para renovar.', LICENSE_REVOKED: 'Esta licença foi revogada.', LICENSE_NETWORK: 'Não foi possível conectar ao serviço. A primeira ativação exige internet.', LICENSE_CONNECTION_REQUIRED: 'Conecte à internet para iniciar o teste gratuito ou ativar uma licença.', LICENSE_SERVICE_UNAVAILABLE: 'O serviço está indisponível. Tente novamente quando a conexão voltar.' };
      state.errorCode = String(error?.code || ''); state.error = known[state.errorCode] || String(error?.message || 'Não foi possível concluir a ativação.');
      if (submittedKey) state.error = state.error.split(submittedKey).join('[chave omitida]');
      const feedback = $('#license-feedback'); if (feedback) { feedback.classList.add('error'); feedback.textContent = state.error + (state.errorCode ? ` Código: ${state.errorCode}` : ''); }
      ctx.toast(state.error, true);
    }
    async function onSubmit(formElement) {
      if (state.busy || !formElement.reportValidity()) return;
      const input = formElement.elements.namedItem('key'), key = input.value.trim(); if (!key) return;
      state.busy = true; state.error = ''; state.errorCode = ''; input.value = '';
      for (const element of formElement.querySelectorAll('input,button')) element.disabled = true;
      try {
        await ctx.call('licenseActivate', { key }); await ctx.refresh();
        if (live().allowed !== true) throw Object.assign(new Error(live().reason || 'A ativação não confirmou uma licença válida.'), { code: live().reasonCode });
        if (ctx.modalKind() === 'license') ctx.closeModal();
        ctx.toast('Licença validada. Confira o vencimento. Os envios não foram retomados automaticamente.');
      } catch (error) { errorNotice(error, key); }
      finally { state.busy = false; for (const element of formElement.querySelectorAll('input,button')) if (element.isConnected) element.disabled = false; ctx.render(true); }
    }
    async function onAction(action) {
      if (action === 'license-open') { open(); return; }
      if (action === 'license-resume') {
        if (live().allowed !== true || !ctx.can('automation.control')) throw new Error('Uma licença válida e permissão de controle são necessárias.');
        if (!confirm('Retomar o sistema? As campanhas e os lembretes pausados continuam aguardando sua revisão e ativação.')) return;
        await ctx.call('resumeAutomation'); await ctx.refresh(); ctx.toast('Sistema desbloqueado. Revise e ative somente os envios que deseja retomar.'); return;
      }
      if (action === 'license-refresh' && !state.busy) {
        state.busy = true;
        try { await ctx.call('licenseRefresh'); await ctx.refresh(); if (live().allowed !== true) ctx.toast(live().reason || 'A licença ainda não permite novos envios.', true); else ctx.toast('Licença verificada.'); }
        catch (error) { errorNotice(error); } finally { state.busy = false; ctx.render(true); }
      }
    }
    function assertAction(action) { if (live().allowed === false && blockedActions.has(action)) throw new Error(live().reason || 'Ative uma licença antes de iniciar novos envios. Seus dados estão preservados.'); }
    const interval = setInterval(() => {
      if (!state.license) return;
      for (const target of document.querySelectorAll('[data-license-remaining]')) target.textContent = duration(remaining());
      if (live().allowed === true && live().expiresAt && remaining() <= 0 && !state.refreshingClock) { state.refreshingClock = true; ctx.refresh().catch(() => {}); }
    }, 30000);
    window.addEventListener('beforeunload', () => clearInterval(interval), { once: true });
    const shouldPreserveDOM = () => Boolean($('#license-page') && (state.busy || $('#license-key')?.value || $('#license-activation-form')?.contains(document.activeElement)));
    return { sync, renderPage, renderPanel, updateChrome, updateAuth, onAction, onSubmit, assertAction, shouldPreserveDOM };
  }
};
