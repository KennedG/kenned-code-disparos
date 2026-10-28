'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture({ permissions = ['*'], mode = 'whatsapp', confirm = true } = {}) {
  const originalCaption = '📱 iPhone 16 128GB\n🩷 Cor: ROSA\n🔋 Saúde da bateria: 92%\nR$ 2.999,00\nDetalhe na tela pequeno\n\n𝗣𝗮𝗹𝗮𝗰𝗲 𝗣𝗮𝗿𝗳𝘂𝗺 - 𝗖𝗮𝗺𝗲𝗹𝗼́𝗱𝗿𝗼𝗺𝗼 𝗢𝗞 𝗦𝗧𝗔𝗡𝗗 𝟭𝟯𝟬/𝟭𝟯𝟭';
  const config = { enabled: true, groupId: '12000-source@g.us', allowedParticipantIds: ['5562999990001'], allowOwnMessages: true, timezone: 'America/Sao_Paulo', configTemplate: { intervalMinutes: 10, messageSpacingSeconds: 3, spacingSeconds: 5, sendTimeoutSeconds: 30, maxRounds: 2, schedule: { days: [1, 2, 3, 4, 5], startTime: '08:00', endTime: '18:00' }, groupIds: ['12000-target@g.us'] } };
  const publications = [{ id: 'pub-1', messageId: 'original-1', type: 'image', caption: originalCaption, originalAt: Date.UTC(2026, 9, 8, 12), groupId: config.groupId, campaignId: 'camp-1', senderId: '5562999990001@s.whatsapp.net', mediaId: 'photo-1', status: 'ready' }, { id: 'pub-2', messageId: 'original-2', type: 'image', caption: 'Outro aparelho', originalAt: Date.UTC(2026, 9, 8, 13), groupId: config.groupId, campaignId: 'camp-1', status: 'failed', error: 'Download recusado', code: 'MEDIA_DOWNLOAD_FAILED' }];
  const data = { storageMode: mode, connection: { state: 'connected' }, sources: { config, metrics: { ready: 1, pending: 0, failed: 1, review: 0, lastCaptureAt: publications[1].originalAt } }, media: [{ id: 'photo-1', type: 'image', previewUrl: 'mega-media://photo-1', name: 'Foto original' }], campaigns: [{ id: 'camp-1', name: 'Lista da loja — 08/10/2026', state: 'draft', sourceGroupId: config.groupId, groupIds: ['12000-target@g.us'], items: [{ id: 'item-1', type: 'image', mediaId: 'photo-1', caption: originalCaption }, { id: 'item-2', type: 'text', text: 'Segundo conteúdo' }] }], campaignOps: { 'camp-1': { roundNumber: 1, readyItems: 1, pendingItems: 1, counts: { accepted: 1, delivered: 0, uncertain: 1, failed: 1, queued: 2 }, destinations: [{ groupId: '12000-target@g.us', groupName: 'Destino real', state: 'blocked', reason: 'Apenas administradores podem enviar.', code: 'GROUP_ADMIN_ONLY' }], uncertainJobs: [{ id: 'job-uncertain', groupId: '12000-target@g.us', messageId: 'message-uncertain', error: 'Tempo limite' }] } } };
  const groups = [{ id: config.groupId, name: 'Guilherme Kenned - Mega Celulares', authorized: true, simulation: false }, { id: '12000-target@g.us', name: 'Destino real', authorized: true, simulation: false }, { id: 'fake@g.us', name: 'Grupo fictício SIMULADO', simulation: true, authorized: true }];
  const calls = [], modals = [], toasts = [], elements = new Map();
  let auth = { user: { id: 'owner' }, permissions }, confirmations = [], modalKind = '';
  const handlers = {
    sourceConfigGet: () => ({ config: data.sources.config, metrics: data.sources.metrics }),
    sourceConfigSave: ({ config: next }) => { data.sources.config = structuredClone(next); return data.sources.config; },
    sourcePublications: ({ campaignId, offset, limit }) => { const rows = publications.filter(item => !campaignId || item.campaignId === campaignId); return { items: rows.slice(offset, offset + limit), total: rows.length, offset, limit }; },
    sourceReviewPublication: payload => { const item = publications.find(item => item.id === payload.id); Object.assign(item, payload); return item; },
    sourceRetryMedia: () => ({ pending: true }), sourceRemovePublication: () => ({ removed: true }),
    sourceReorderItems: payload => payload, sourceGroupPublications: payload => payload,
    campaignReconcileUncertain: () => ({ message: 'Ainda incerto: não há evidência de entrega.' }),
    manualRetryJob: () => ({ pending: true }), destinationRecheck: () => ({ state: 'blocked', reason: 'Permissão ausente.' }),
    sourceApplyConfigTemplate: () => ({ saved: true }), sourceImportHistory: () => ({ supported: false, message: 'Histórico indisponível.' }),
    refreshGroups: () => groups, pauseCampaign: () => ({ state: 'paused' })
  };
  const document = { querySelector: selector => elements.get(selector) || null, querySelectorAll: () => [], activeElement: null };
  const context = vm.createContext({ window: {}, document, confirm: message => { confirmations.push(message); return confirm; }, console, Date, Set, Map, Intl });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/ui/source-campaigns.js'), 'utf8'), context);
  let refreshed = 0, rendered = 0;
  const ui = context.window.KennedSourceCampaignsUI.create({ can: permission => auth.permissions.includes('*') || auth.permissions.includes(permission), auth: () => auth, data: () => data, groups: () => groups, icon: name => `<svg data-icon="${name}"></svg>`, call: async (action, payload) => { calls.push({ action, payload: structuredClone(payload) }); if (!handlers[action]) throw new Error('Unexpected RPC ' + action); return handlers[action](payload); }, render: () => rendered++, refresh: async () => refreshed++, showModal: (...args) => { modalKind = args[0]; modals.push(args); }, closeModal: () => { modalKind = ''; }, modalKind: () => modalKind, toast: (...args) => toasts.push(args), editCampaign: id => calls.push({ action: 'editUI', payload: id }), previewCampaign: (...args) => calls.push({ action: 'previewUI', payload: args }), navigate: page => calls.push({ action: 'navigateUI', payload: page }) });
  const form = (id, values, checked = {}) => {
    const elements = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, typeof value === 'boolean' ? { value: value ? 'on' : '', checked: value } : { value }]));
    elements.namedItem = name => elements[name];
    return { id, dataset: {}, elements, reportValidity: () => true, querySelectorAll: selector => { const name = selector.match(/name="([^"]+)"/)?.[1]; return (checked[name] || []).map(value => ({ value: String(value) })); } };
  };
  const action = (name, id, extra = {}) => ui.onAction('source-' + name, { dataset: { id, ...extra } });
  const configForm = () => form('source-config-form', { enabled: true, groupId: config.groupId, allowedParticipantIds: config.allowedParticipantIds.join('\n'), allowOwnMessages: true, messageSpacingSeconds: '4', spacingSeconds: '8', intervalMinutes: '15', sendTimeoutSeconds: '45', maxRounds: '3', endAt: '2026-10-08T18:00', startTime: '09:00', endTime: '18:00' }, { days: [1, 3, 5], groupIds: ['12000-target@g.us', config.groupId] });
  return { ui, data, groups, publications, originalCaption, calls, modals, toasts, elements, handlers, confirmations, action, form, configForm, rendered: () => rendered, refreshed: () => refreshed, setAuth: value => { auth = value; } };
}

test('source UI keeps real group IDs, hides simulated groups and preserves full caption', async () => {
  const f = fixture(); await f.ui.load(); const html = f.ui.render();
  assert.match(html, /Guilherme Kenned - Mega Celulares/);
  assert.match(html, /12000-source@g\.us/);
  assert.doesNotMatch(html, /Grupo fictício SIMULADO|value="fake@g.us"/);
  assert.ok(html.includes(f.originalCaption));
  assert.match(html, /Download recusado/); assert.match(html, /data-action="source-retry-media"/);
  assert.match(html, /08\/10\/2026, 09:00/);
  assert.match(html, /Nenhum grupo escolhido|captura ativada|Captura ativada/);
  assert.match(fixture({ mode: 'simulated' }).ui.render(), /Grupo fictício SIMULADO/);
});

test('source UI saves complete config template, excludes origin and validates persisted config', async () => {
  const f = fixture(); await f.ui.load(); await f.ui.onSubmit(f.configForm());
  const saved = f.calls.find(item => item.action === 'sourceConfigSave').payload.config;
  assert.equal(saved.groupId, '12000-source@g.us'); assert.deepEqual(saved.allowedParticipantIds, ['5562999990001']); assert.equal(saved.allowOwnMessages, true);
  assert.deepEqual(saved.configTemplate.groupIds, ['12000-target@g.us']);
  assert.equal(saved.configTemplate.messageSpacingSeconds, 4); assert.equal(saved.configTemplate.spacingSeconds, 8); assert.equal(saved.configTemplate.intervalMinutes, 15); assert.equal(saved.configTemplate.sendTimeoutSeconds, 45); assert.equal(saved.configTemplate.maxRounds, 3);
  assert.equal(saved.configTemplate.endAt, Date.UTC(2026, 9, 8, 21));
  assert.ok(f.calls.filter(item => item.action === 'sourceConfigGet').length >= 2);
  assert.match(f.toasts.at(-1)[0], /salvos/);
  const broken = fixture(); broken.handlers.sourceConfigSave = () => ({});
  await assert.rejects(broken.ui.onSubmit(broken.configForm()), /não confirmou/); assert.equal(broken.toasts.length, 0);
});

test('source UI read-only profile cannot configure or expose simulated data', async () => {
  const f = fixture({ permissions: ['campaign.view'] }); await f.ui.load(); const html = f.ui.render();
  assert.match(html, /source-fieldset" disabled/); assert.doesNotMatch(html, /Salvar origem e modelo|data-action="source-review"|data-action="source-remove"/);
  await assert.rejects(f.ui.onSubmit(f.configForm()), /não permite configurar/);
  assert.equal(f.calls.filter(item => item.action === 'sourceConfigSave').length, 0);
});

test('source UI shows uncertain vs accepted vs delivered and never automatically retries', async () => {
  const f = fixture(); await f.action('monitor', 'camp-1'); const html = f.modals.at(-1)[3];
  assert.match(html, /Incertos/); assert.match(html, /Aceitos/); assert.match(html, /Entregues/);
  assert.match(html, /Apenas administradores podem enviar\./); assert.match(html, /GROUP_ADMIN_ONLY/);
  assert.match(html, /message-uncertain/); assert.equal(f.calls.length, 0);
  await f.action('reconcile', 'camp-1'); assert.equal(f.calls.at(-1).action, 'campaignReconcileUncertain'); assert.equal(f.calls.filter(item => item.action === 'manualRetryJob').length, 0);
  await f.action('manual-retry', 'job-uncertain'); assert.match(f.confirmations.at(-1), /risco de duplicação/); assert.deepEqual(f.calls.at(-1), { action: 'manualRetryJob', payload: { id: 'job-uncertain', confirmPossibleDuplicate: true } });
  const refuse = fixture({ confirm: false }); await refuse.action('manual-retry', 'job-uncertain'); assert.equal(refuse.calls.length, 0);
});

test('source UI passes exact reviewed caption and explicit manual grouping without inference', async () => {
  const f = fixture(); await f.ui.load(); await f.action('review', 'pub-1');
  const form = f.form('source-review-form', { caption: f.originalCaption }); form.dataset.id = 'pub-1'; await f.ui.onSubmit(form);
  assert.deepEqual(f.calls.find(item => item.action === 'sourceReviewPublication').payload, { id: 'pub-1', caption: f.originalCaption });
  const select = id => f.ui.onChange({ dataset: { sourceSelect: id }, checked: true, closest: () => null });
  await select('pub-1'); await select('pub-2'); await f.action('group'); assert.match(f.modals.at(-1)[3], /Não associamos outra mensagem automaticamente/);
  await f.ui.onSubmit(f.form('source-group-form', { caption: f.originalCaption }));
  assert.deepEqual(f.calls.find(item => item.action === 'sourceGroupPublications').payload, { ids: ['pub-1', 'pub-2'], caption: f.originalCaption });
});

test('source UI reorders future items using stable IDs and controlled destination recheck', async () => {
  const f = fixture(); await f.action('order', 'camp-1'); await f.action('order-down', 'item-1'); await f.action('save-order', 'camp-1');
  assert.deepEqual(f.calls.find(item => item.action === 'sourceReorderItems').payload, { campaignId: 'camp-1', itemIds: ['item-2', 'item-1'] });
  await f.action('recheck-destination', 'camp-1', { groupId: '12000-target@g.us' });
  assert.deepEqual(f.calls.at(-1), { action: 'destinationRecheck', payload: { campaignId: 'camp-1', groupId: '12000-target@g.us' } });
  assert.equal(f.toasts.at(-1)[1], true);
});

test('source UI requires history period explicitly and surfaces unsupported integration', async () => {
  const f = fixture(); await f.action('import-history'); assert.match(f.modals.at(-1)[3], /nenhuma|Nenhuma|IDs já capturados/);
  await f.ui.onSubmit(f.form('source-history-form', { from: '2026-10-07T00:00', to: '2026-10-07T23:59' }));
  assert.deepEqual(f.calls.find(item => item.action === 'sourceImportHistory').payload, { from: Date.UTC(2026, 9, 7, 3), to: Date.UTC(2026, 9, 8, 2, 59) });
  assert.match(f.toasts.at(-1)[0], /Histórico indisponível/); assert.equal(f.toasts.at(-1)[1], true);
});

test('source UI ignores late results after account or mode changes', async () => {
  const f = fixture(); let resolve; f.handlers.sourceConfigGet = () => new Promise(done => { resolve = done; });
  const loading = f.ui.load(); await new Promise(done => setImmediate(done)); f.ui.reset(); f.data.storageMode = 'simulated'; resolve({ config: f.data.sources.config });
  await assert.rejects(loading, /mudou/); assert.equal(f.calls.filter(item => item.action === 'sourcePublications').length, 0);
});

test('source UI does not reload captured pages for unrelated snapshot timestamp updates', async () => {
  const f = fixture(); await f.ui.load(); const baseline = f.calls.length;
  for (let i = 0; i < 20; i++) { f.data.sources.config.updatedAt = Date.now() + i; await f.ui.maybeLoad(); }
  assert.equal(f.calls.length, baseline);
  f.data.sources.metrics.ready = 2; f.data.sources.metrics.total = 3; f.data.sources.metrics.lastCaptureAt = Date.now();
  await f.ui.maybeLoad(); assert.equal(f.calls.filter(item => item.action === 'sourcePublications').length, 2);
  await f.ui.maybeLoad(); assert.equal(f.calls.filter(item => item.action === 'sourcePublications').length, 2);
});

test('source capture test requires a confirmed future event and exposes waiting rather than fake success', async () => {
  const f = fixture();
  f.handlers.sourceTestCapture = () => { f.data.sources.metrics.testCapture = { id: 'probe-trace', status: 'waiting', startedAt: Date.UTC(2026, 9, 13, 12), expiresAt: Date.UTC(2026, 9, 13, 12, 2), groupId: f.data.sources.config.groupId, instruction: 'Publique uma foto com legenda no grupo autorizado.' }; return f.data.sources.metrics.testCapture; };
  await f.action('test-capture');
  assert.deepEqual(f.calls.find(value => value.action === 'sourceTestCapture').payload, {});
  assert.match(f.toasts.at(-1)[0], /Publique uma foto/);
  assert.match(f.ui.render(), /Aguardando nova publicação autorizada/); assert.doesNotMatch(f.ui.render(), /Captura confirmada — item salvo/);
  f.data.sources.metrics.testCapture.status = 'confirmed'; f.data.sources.metrics.testCapture.messageId = 'real-message-id';
  assert.match(f.ui.render(), /Captura confirmada — item salvo e pronto na campanha/); assert.match(f.ui.render(), /real-message-id/);
});

test('source synchronization preserves the existing group and communicates that no history or sending was started', async () => {
  const f = fixture(); f.handlers.sourceSyncNow = () => ({ groupId: f.data.sources.config.groupId, historyImported: false, message: 'Grupos e monitor sincronizados. Nenhum histórico foi importado.' });
  await f.action('sync-now'); assert.equal(f.calls.filter(value => value.action === 'sourceSyncNow').length, 1); assert.equal(f.data.sources.config.groupId, '12000-source@g.us'); assert.equal(f.calls.filter(value => value.action === 'sourceImportHistory').length, 0); assert.match(f.toasts.at(-1)[0], /Nenhum histórico/);
  f.data.sources.metrics.lastMessageAt = Date.UTC(2026, 9, 13, 12); f.data.sources.metrics.lastSyncAt = Date.UTC(2026, 9, 13, 12, 1); f.data.sources.metrics.captureStatus = 'waiting_connection';
  f.data.sources.metrics.lastError = { code: 'SOURCE_GROUP_SYNC_TIMEOUT', message: 'A integração não respondeu no prazo.' };
  const html = f.ui.render(); assert.match(html, /Aguardando conexão pronta/); assert.match(html, /Última mensagem recebida/); assert.match(html, /Última sincronização/); assert.match(html, /SOURCE_GROUP_SYNC_TIMEOUT/);
});

test('source test and sync controls cannot use an unsaved or unauthorized configuration', async () => {
  const f = fixture(); f.ui.onInput({ closest: () => ({}) }); await assert.rejects(f.action('test-capture'), /Salve ou descarte/); await assert.rejects(f.action('sync-now'), /Salve ou descarte/); assert.equal(f.calls.length, 0);
  const readonly = fixture({ permissions: ['campaign.view'] }); assert.doesNotMatch(readonly.ui.render(), /data-action="source-test-capture"|data-action="source-sync-now"/); await assert.rejects(readonly.action('test-capture'), /Sem permissão/); await assert.rejects(readonly.action('sync-now'), /Sem permissão/); assert.equal(readonly.calls.length, 0);
});
