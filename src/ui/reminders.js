'use strict';

window.KennedRemindersUI = {
  create(ctx) {
    const $ = (selector, root = document) => root.querySelector(selector);
    const e = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    const state = { epoch: 0, loaded: null, history: null, historyId: null, snapshotRef: null, offset: 0, submitting: false, dirty: false };
    const live = () => { const snapshot = ctx.data()?.reminders; return snapshot && snapshot !== state.snapshotRef ? snapshot : state.loaded || snapshot || { items: [], recipients: [], status: {} }; };
    const can = permission => ctx.auth()?.user?.isOwner || (ctx.can ? ctx.can('reminder.' + permission) : (ctx.auth()?.permissions || ctx.auth()?.user?.permissions || []).includes('reminder.' + permission));
    const items = () => live().items || [];
    const recipients = () => live().recipients || [];
    const safeCall = async (action, payload) => { const epoch = state.epoch, actor = ctx.auth()?.user?.id, mode = ctx.data()?.storageMode; const result = await ctx.call(action, payload); if (epoch !== state.epoch || actor !== ctx.auth()?.user?.id || mode !== ctx.data()?.storageMode) throw new Error('O usuário ou o modo de operação mudou. Atualize a tela.'); return result; };
    const button = (action, label, style = '', id = '') => '<button type="button" class="button ' + e(style) + '" data-action="reminders-' + e(action) + '"' + (id ? ' data-id="' + e(id) + '"' : '') + '>' + e(label) + '</button>';
    const field = (label, name, value, type = 'text', extra = '') => '<div class="field"><label for="reminders-' + e(name) + '">' + e(label) + '</label><input id="reminders-' + e(name) + '" name="' + e(name) + '" type="' + e(type) + '" value="' + e(value) + '" ' + extra + '></div>';
    const select = (label, name, value, choices) => '<div class="field"><label for="reminders-' + e(name) + '">' + e(label) + '</label><select id="reminders-' + e(name) + '" name="' + e(name) + '">' + choices.map(([id, text]) => '<option value="' + e(id) + '" ' + (String(value) === String(id) ? 'selected' : '') + '>' + e(text) + '</option>').join('') + '</select></div>';
    const format = (at, timezone = 'America/Sao_Paulo') => { if (at == null) return '—'; try { return new Date(at).toLocaleString('pt-BR', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' }); } catch { return 'Fuso inválido'; } };
    const deliveryStatus = item => item?.readAt ? 'Lido' : item?.deliveredAt || item?.status === 'delivered' ? 'Entregue ao dispositivo' : ({ pending: 'Pendente', sending: 'Enviando — aguarda confirmação', confirmed: 'Enviado — aceito pelo servidor', uncertain: 'Incerto — revisão necessária', failed: 'Falhou', cancelled: 'Cancelado', skipped: 'Vencido — não enviado' })[item?.status] || 'Nenhum envio';
    const days = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    const repeatLabel = item => item.repeat === 'once' ? 'Data única: ' + e(item.date) : item.repeat === 'weekdays' ? (item.weekdays || []).map(day => days[day]).join(', ') : 'Diariamente';
    function render() {
      if (!can('view')) return '<section id="reminders-page" class="panel"><div class="panel-body">Seu perfil não permite visualizar lembretes.</div></section>';
      const status = live().status || {};
      let output = '<div id="reminders-page"><div class="page-heading"><div><span class="eyebrow">ROTINA DA LOJA</span><h1>LEMBRETES</h1><p class="soft-text">Avisos privados para tarefas, estoque e atualização de preços.</p></div><div class="row-actions">' + button('reload', 'Atualizar', 'ghost') + (can('create') ? button('new', 'Novo lembrete', 'primary') : '') + '</div></div>';
      output += '<p class="info-note">O aplicativo e o computador precisam estar em execução. O envio pelo WhatsApp depende de conexão. O horário segue o fuso de cada lembrete, inicialmente Brasília. Lembretes vencidos seguem a política configurada, sem disparar uma sequência de avisos perdidos.</p>';
      if (status.automationStopped) output += '<p class="warning-note">Envios automáticos bloqueados pelo comando de parada geral. Retome explicitamente o sistema para ativar ou testar lembretes.</p>';
      if (!status.connected) output += '<p class="warning-note">WhatsApp desconectado. Avisos ficam pendentes somente dentro da tolerância configurada.</p>';
      output += '<section class="panel"><div class="panel-header"><h2>Seus lembretes</h2><span class="soft-text">' + e(status.active || 0) + ' ativos · ' + e(status.pending || 0) + ' pendentes</span></div><div class="table-scroll"><table><thead><tr><th>LEMBRETE</th><th>HORÁRIO E DESTINO</th><th>PRÓXIMO AVISO</th><th>ÚLTIMO ENVIO</th><th>AÇÕES</th></tr></thead><tbody>';
      output += items().map(item => {
        const recipient = item.recipient || recipients().find(record => record.id === item.recipientId);
        const delivery = item.lastDelivery;
        return '<tr><td><strong>' + e(item.title) + '</strong><span class="table-subtitle">' + e(({ active: 'Ativo', paused: 'Pausado', completed: 'Data única concluída' })[item.state] || item.state) + '</span><small>' + e(item.description || '') + '</small>' + (item.error ? '<p class="warning-note">' + e(item.error) + '</p>' : '') + '</td><td>' + e(item.time) + ' · ' + e(item.timezone) + '<span class="table-subtitle">' + repeatLabel(item) + '</span><small>' + e(recipient ? recipient.name + ' · ' + recipient.phone : 'Destinatário indisponível') + '</small></td><td>' + e(format(item.nextDueAt, item.timezone)) + '<span class="table-subtitle">' + e(item.overduePolicy === 'sendOnce' ? 'Enviar uma vez até ' + item.overdueGraceMinutes + ' min após vencer' : 'Ignorar horários vencidos') + '</span></td><td><span class="delivery-status ' + e(delivery?.status || '') + '">' + e(deliveryStatus(delivery)) + '</span><span class="table-subtitle">' + e(format(delivery?.submittedAt || delivery?.resultAt || delivery?.dueAt, item.timezone)) + '</span>' + (delivery?.error ? '<small>' + e(delivery.error) + '</small>' : '') + '</td><td><div class="row-actions">' + (can('edit') ? button('edit', 'Editar', 'small', item.id) : '') + (can('control') ? button(item.state === 'active' ? 'pause' : 'activate', item.state === 'active' ? 'Pausar' : 'Ativar', 'small', item.id) + button('test', 'Testar lembrete', 'small', item.id) : '') + button('history', 'Histórico', 'small ghost', item.id) + (can('delete') ? button('delete', 'Excluir', 'small danger', item.id) : '') + '</div></td></tr>';
      }).join('') || '<tr><td colspan="5"><div class="empty-state"><h3>Nenhum lembrete cadastrado</h3><p>Crie seu primeiro aviso privado e escolha um destinatário autorizado.</p></div></td></tr>';
      output += '</tbody></table></div></section>';
      if (state.history) output += renderHistory();
      return output + '</div>';
    }
    function renderHistory() {
      const result = state.history;
      const rows = (result.items || []).map(item => items().map(reminder => reminder.lastDelivery).find(delivery => delivery?.id === item.id) || item);
      return '<section class="panel"><div class="panel-header"><h2>Histórico de ' + e(items().find(item => item.id === state.historyId)?.title || 'lembrete') + '</h2>' + button('hide-history', 'Fechar', 'small ghost') + '</div><div class="table-scroll"><table><thead><tr><th>OCORRÊNCIA ORIGINAL</th><th>DESTINATÁRIO</th><th>ESTADO</th><th>DIAGNÓSTICO</th></tr></thead><tbody>' + rows.map(item => '<tr><td>' + e(format(item.dueAt)) + (item.test ? '<span class="table-subtitle">Teste solicitado manualmente</span>' : '') + '</td><td>' + e(item.number) + '</td><td><span class="delivery-status ' + e(item.status) + '">' + e(deliveryStatus(item)) + '</span><span class="table-subtitle">' + e(format(item.resultAt || item.submittedAt)) + '</span></td><td>' + e(item.error || 'Sem falha registrada') + '<span class="table-subtitle">' + e(item.code || '') + ' · ' + e(item.attempts || 0) + ' tentativa(s)</span><small class="trace-id">' + e(item.traceId) + '</small></td></tr>').join('') + '</tbody></table></div><div class="pagination"><span>' + e(result.total == null ? rows.length : result.total) + ' registros</span><div class="row-actions">' + (state.offset ? button('previous', 'Anterior', 'small') : '') + (state.offset + 50 < result.total ? button('next', 'Próxima', 'small') : '') + '</div></div></section>';
    }
    async function load() {
      if (!can('view')) { state.loaded = null; return; }
      const snapshotRef = ctx.data()?.reminders; state.loaded = await safeCall('listReminders'); state.snapshotRef = snapshotRef;
      if (state.historyId) state.history = await safeCall('reminderHistory', { reminderId: state.historyId, limit: 50, offset: state.offset });
    }
    function edit(id) {
      const item = items().find(record => record.id === id) || { time: '09:00', timezone: 'America/Sao_Paulo', repeat: 'daily', weekdays: [1, 2, 3, 4, 5], state: 'paused', overduePolicy: 'skip', overdueGraceMinutes: 120, maxAttempts: 3, retryMinutes: 1 };
      const body = '<form id="reminders-form" data-id="' + e(id || '') + '">' + field('Título', 'title', item.title || '', 'text', 'required maxlength="120"') + '<div class="field"><label for="reminders-description">Descrição</label><textarea id="reminders-description" name="description" rows="3" maxlength="4000">' + e(item.description || '') + '</textarea></div><div class="field-grid">' + field('Horário', 'time', item.time, 'time', 'required') + field('Fuso', 'timezone', item.timezone, 'text', 'required') + select('Repetição', 'repeat', item.repeat, [['daily', 'Todos os dias'], ['weekdays', 'Dias específicos'], ['once', 'Uma data única']]) + field('Data para envio único', 'date', item.date || '', 'date') + select('Destinatário autorizado', 'recipientId', item.recipientId || '', [['', 'Selecione um destinatário'], ...recipients().map(recipient => [recipient.id, recipient.name + ' · ' + recipient.phone])]) + '</div><fieldset class="permission-section"><legend>Dias da semana (repetição em dias específicos)</legend>' + days.map((day, index) => '<label class="check-label"><input type="checkbox" name="weekdays" value="' + index + '" ' + (item.weekdays?.includes(index) ? 'checked' : '') + '> ' + day + '</label>').join('') + '</fieldset><div class="field-grid">' + select('Se ficou vencido com o sistema desligado', 'overduePolicy', item.overduePolicy, [['skip', 'Ignorar avisos vencidos'], ['sendOnce', 'Enviar somente o aviso mais recente, uma vez']]) + field('Tolerância para enviar vencido (minutos)', 'overdueGraceMinutes', item.overdueGraceMinutes, 'number', 'min="1" max="10080" required') + field('Limite de tentativas', 'maxAttempts', item.maxAttempts, 'number', 'min="1" max="5" required') + field('Intervalo entre tentativas (minutos)', 'retryMinutes', item.retryMinutes, 'number', 'min="1" max="1440" required') + '</div><p class="field-hint">Destinatários vêm de usuários ativos com telefone ou dos destinatários cadastrados em Alertas. Os avisos serão enviados somente no privado. Resultados incertos não são repetidos automaticamente.</p><label class="check-label"><input type="checkbox" name="enabled" ' + (item.state === 'active' ? 'checked' : '') + ' ' + (!can('control') ? 'disabled' : '') + '> Ativar lembrete após salvar</label></form>';
      state.dirty = false;
      ctx.showModal('reminders-edit', id ? 'Editar lembrete' : 'Novo lembrete', 'Preferências e progresso ficam salvos neste computador.', body, button('save', 'Salvar lembrete', 'primary'));
    }
    const value = (form, name) => $('[name="' + name + '"]', form)?.value || '';
    async function saveForm(form) {
      if (!form.reportValidity()) return;
      const reminder = { id: form.dataset.id || undefined, title: value(form, 'title'), description: value(form, 'description'), time: value(form, 'time'), timezone: value(form, 'timezone'), repeat: value(form, 'repeat'), date: value(form, 'date'), recipientId: value(form, 'recipientId'), weekdays: [...form.querySelectorAll('[name="weekdays"]:checked')].map(element => Number(element.value)), overduePolicy: value(form, 'overduePolicy'), overdueGraceMinutes: Number(value(form, 'overdueGraceMinutes')), maxAttempts: Number(value(form, 'maxAttempts')), retryMinutes: Number(value(form, 'retryMinutes')), enabled: $('[name="enabled"]', form).checked };
      const saved = await safeCall('saveReminder', { reminder });
      if (!saved?.id) throw new Error('O sistema não confirmou a persistência do lembrete.');
      await load();
      if (!(state.loaded?.items || []).some(item => item.id === saved.id)) throw new Error('O lembrete não foi encontrado após salvar. Confira o diagnóstico.');
      state.dirty = false; ctx.closeModal(); ctx.render(true); ctx.toast('Lembrete salvo no banco local.');
    }
    async function onAction(action, element) {
      action = action.slice(10); const id = element.dataset.id;
      if (action === 'new' || action === 'edit') { edit(id); return; }
      if (action === 'save') { if (state.submitting) return; state.submitting = true; try { await saveForm($('#reminders-form')); } finally { state.submitting = false; } return; }
      if (action === 'delete') { if (!confirm('Excluir este lembrete e cancelar os avisos pendentes? O registro operacional dos envios será preservado.')) return; await safeCall('deleteReminder', { id }); }
      if (action === 'pause') await safeCall('pauseReminder', { id });
      if (action === 'activate') await safeCall('activateReminder', { id });
      if (action === 'test') { const delivery = await safeCall('testReminder', { id }); ctx.toast(deliveryStatus(delivery) + (delivery.error ? ' · ' + delivery.error : '') + '. Acompanhe a confirmação no histórico.', ['failed', 'uncertain'].includes(delivery.status)); }
      if (action === 'history') { state.historyId = id; state.offset = 0; }
      if (action === 'hide-history') { state.historyId = null; state.history = null; }
      if (action === 'previous' || action === 'next') state.offset = Math.max(0, state.offset + (action === 'next' ? 50 : -50));
      await load(); ctx.render(true);
    }
    async function onSubmit(form) { if (form.id !== 'reminders-form') return false; if (state.submitting) return true; state.submitting = true; try { await saveForm(form); } finally { state.submitting = false; } return true; }
    function onInput(element) { if (element.closest('#reminders-form')) state.dirty = true; }
    function reset() { state.epoch++; state.loaded = null; state.history = null; state.historyId = null; state.snapshotRef = null; state.offset = 0; state.dirty = false; }
    return { render, load, onAction, onSubmit, onInput, onChange: onInput, reset, shouldPreserveDOM: () => false, updateStatus: () => {}, hasUnsaved: () => state.dirty };
  }
};
