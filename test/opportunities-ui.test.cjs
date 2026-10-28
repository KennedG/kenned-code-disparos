'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture({ permissions = ['*'], mode = 'whatsapp', confirm = true } = {}) {
  const config = { enabled: true, evaluation: true, automatic: false, monitoredGroupIds: ['real-a@g.us'], campaignIds: ['camp-a'], repeatHours: 24, contactIntervalMinutes: 30, maxPerDay: 3, validityMinutes: 120, availabilityMaxAgeMinutes: 120, automaticOfferLimit: 1, multiModelMax: 5, priority: 'cashAscending', timezone: 'America/Sao_Paulo', sound: { enabled: true, volume: 70, durationSeconds: 3, minIntervalSeconds: 60, burstSeconds: 5, quiet: { enabled: false, start: '22:00', end: '08:00' } } };
  const original = '📱 iPhone 13 Pro 256GB quem tem?\nCor: Azul';
  const op = { id: 'op-1', summary: 'iPhone 13 Pro • 256GB', senderId: '5562999990001@s.whatsapp.net', senderPhone: '5562999990001', senderName: 'Perfil real', status: 'open', originalAt: Date.UTC(2026, 9, 8, 12), expiresAt: Date.UTC(2026, 9, 8, 14), originCount: 3, groupCount: 2, blockers: [{ code: 'EVALUATION_MODE' }] };
  const offer = { offerId: 'offer-1', model: 'iPhone 13 Pro', storageGB: 256, color: 'Azul', condition: 'Seminovo', priceCents: 300000, caption: '📱 iPhone 13 Pro 256GB\nR$ 3.000,00\nObservação original', campaignId: 'camp-a', originalMessageId: 'original-offer', quantity: 1, availabilityConfirmedAt: Date.UTC(2026, 9, 8, 12), eligible: true };
  const second = { ...offer, offerId: 'offer-2', priceCents: 320000, originalMessageId: 'other-original', sentBefore: true, updatedSinceSent: true };
  const detail = { opportunity: op, candidates: [offer, second], origins: [{ messageId: 'message-1', groupId: 'real-a@g.us', originalAt: op.originalAt, text: original }, { messageId: 'message-2', groupId: 'real-b@g.us', originalAt: op.originalAt + 100, text: 'Alguém tem 13 pro 256?' }], tasks: [{ id: 'task-uncertain', status: 'uncertain', messageId: 'possibly-sent', error: 'Sem confirmação da integração', createdAt: op.originalAt }, { id: 'task-accepted', status: 'accepted', createdAt: op.originalAt }, { id: 'task-delivered', status: 'delivered', resultAt: op.originalAt + 500 }] };
  const data = { storageMode: mode, campaigns: [{ id: 'camp-a', name: 'Lista real da loja' }], opportunities: { config, metrics: { total: 1, open: 1, accepted: 1, delivered: 1, uncertain: 1 }, monitor: { lastMessageAt: op.originalAt } } };
  const groups = [{ id: 'real-a@g.us', name: 'Grupo real A', simulation: false }, { id: 'real-b@g.us', name: 'Grupo real B', simulation: false }, { id: 'simulation-a', name: 'FICTÍCIO DE TESTE', simulation: true }];
  let auth = { user: { id: 'owner' }, permissions }, modalKind = '', renderCount = 0, refreshCount = 0;
  const calls = [], modals = [], toasts = [], confirmations = [], elements = new Map(), allElements = new Map();
  const document = { querySelector: selector => elements.get(selector) || null, querySelectorAll: selector => allElements.get(selector) || [], activeElement: null };
  const handlers = {
    opportunityState: () => data.opportunities,
    opportunityPage: p => ({ items: p.offset ? [] : [op], total: 31, offset: p.offset, limit: p.limit }),
    opportunityConfigSave: p => { data.opportunities.config = structuredClone(p.config); return { config: p.config }; },
    opportunityDetail: () => detail,
    opportunityPreview: p => ({ text: '📱 Resposta organizada\nR$ 3.000,00', offerIds: p.offerIds, canSend: true, blockers: [], previewToken: 'valid-token', recipient: { phone: op.senderPhone } }),
    opportunitySendManual: () => ({ status: 'queued' }), opportunityAction: () => ({ recorded: true }), opportunityConfirmAvailability: () => ({ confirmed: true }), opportunityReconcile: () => ({ status: 'uncertain' }), opportunityRetryUncertain: () => ({ status: 'queued' }), opportunityEvaluate: () => ({ evaluated: 1 })
  };
  const context = vm.createContext({ window: {}, document, confirm: message => { confirmations.push(message); return confirm; }, console, Date, Set, Map, Intl });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/ui/opportunities.js'), 'utf8'), context);
  const ui = context.window.KennedOpportunitiesUI.create({ can: permission => auth.permissions.includes('*') || auth.permissions.includes(permission), auth: () => auth, data: () => data, groups: () => groups, call: async (action, payload) => { calls.push({ action, payload: structuredClone(payload) }); if (!handlers[action]) throw new Error(`Unexpected RPC: ${action}`); return handlers[action](payload); }, render: () => renderCount++, refresh: async () => refreshCount++, showModal: (...args) => { modalKind = args[0]; modals.push(args); }, closeModal: () => { modalKind = ''; }, modalKind: () => modalKind, toast: (...args) => toasts.push(args) });
  const action = (name, id, extra = {}) => ui.onAction('opportunity-' + name, { dataset: { id, ...extra } });
  const form = (id, values, checked = {}) => {
    const elements = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, typeof value === 'boolean' ? { checked: value, value: value ? 'on' : '' } : { value }])); elements.namedItem = name => elements[name];
    return { id, dataset: {}, elements, reportValidity: () => true, querySelector: () => null, querySelectorAll: selector => (checked[selector.match(/name="([^"]+)"/)?.[1]] || []).map(value => ({ value })) };
  };
  const configForm = (operatingMode = 'evaluation') => form('opportunity-config-form', { enabled: true, operatingMode, repeatHours: '24', contactIntervalMinutes: '30', maxPerDay: '3', validityMinutes: '120', availabilityMaxAgeMinutes: '120', automaticOfferLimit: '1', multiModelMax: '5', priority: 'cashAscending', soundEnabled: true, soundVolume: '37', soundDurationSeconds: '2', soundMinIntervalSeconds: '90', soundBurstSeconds: '4', quietEnabled: true, quietStart: '22:30', quietEnd: '08:15' }, { monitoredGroupIds: ['real-a@g.us'], campaignIds: ['camp-a', 'missing'] });
  const select = async id => ui.onChange({ dataset: { opportunityOfferSelect: id }, checked: true, closest: () => null });
  return { ui, calls, data, groups, op, offer, detail, handlers, modals, toasts, confirmations, action, form, configForm, select, elements, allElements, document, setAuth: value => { auth = value; }, setModal: value => { modalKind = value; }, refreshCount: () => refreshCount, renderCount: () => renderCount };
}

test('opportunities defaults to evaluation, real groups only, original dates in Brasilia and distinct receipts', async () => {
  const f = fixture(); await f.ui.load(); const html = f.ui.render();
  assert.match(html, /AVALIAÇÃO — SEM ENVIO AUTOMÁTICO/); assert.match(html, /Grupo real A/); assert.doesNotMatch(html, /FICTÍCIO DE TESTE/); assert.match(html, /value="24"/); assert.match(html, /value="30"/); assert.match(html, /value="3"/); assert.match(html, /value="120"/); assert.match(html, /08\/10\/2026, 09:00/);
  assert.match(html, /Envio aceito pela integração, entrega confirmada e resposta do interessado são estados distintos/); assert.match(html, /Pedido repetido em 2 grupo/);
  const simulation = fixture({ mode: 'simulated' }); await simulation.ui.load(); assert.match(simulation.ui.render(), /FICTÍCIO DE TESTE/); assert.doesNotMatch(simulation.ui.render(), /Grupo real A/);
});

test('config persists exact limits and sound controls, never silently enables automatic and preserves only explicit selected IDs', async () => {
  const f = fixture(); await f.ui.load(); await f.ui.onSubmit(f.configForm());
  const saved = f.calls.find(item => item.action === 'opportunityConfigSave').payload.config;
  assert.deepEqual(saved.monitoredGroupIds, ['real-a@g.us']); assert.deepEqual(saved.campaignIds, ['camp-a']); assert.equal(saved.evaluation, true); assert.equal(saved.automatic, false); assert.equal(saved.repeatHours, 24); assert.equal(saved.contactIntervalMinutes, 30); assert.equal(saved.maxPerDay, 3); assert.equal(saved.validityMinutes, 120); assert.equal(saved.automaticOfferLimit, 1); assert.equal(saved.sound.volume, 37); assert.equal(saved.sound.minIntervalSeconds, 90); assert.deepEqual(saved.sound.quiet, { enabled: true, start: '22:30', end: '08:15' }); assert.equal(f.ui.hasUnsaved(), false); assert.match(f.toasts.at(-1)[0], /salvos/);
});

test('automatic activation needs explicit review and cancelling keeps config untouched', async () => {
  const f = fixture({ confirm: false }); await f.ui.load(); await f.ui.onSubmit(f.configForm('automatic'));
  assert.equal(f.calls.filter(item => item.action === 'opportunityConfigSave').length, 0); assert.match(f.confirmations[0], /Ativar respostas automáticas/);
});

test('failed persistence never reports successful config save', async () => {
  const f = fixture(); f.handlers.opportunityConfigSave = () => ({}); await f.ui.load();
  await assert.rejects(f.ui.onSubmit(f.configForm()), /não confirmou a gravação/); assert.equal(f.toasts.length, 0);
});

test('read-only profile cannot configure, respond, silence or confirm availability', async () => {
  const f = fixture({ permissions: ['opportunity.view'] }); await f.ui.load(); const html = f.ui.render();
  assert.match(html, /opportunity-fieldset" disabled/); assert.doesNotMatch(html, /Salvar controles|data-action="opportunity-outside"|data-action="opportunity-mute"/);
  await assert.rejects(f.ui.onSubmit(f.configForm()), /não permite gerenciar/); await assert.rejects(f.action('outside', 'op-1'), /não permite esta ação/); await assert.rejects(f.action('availability', 'offer-1'), /Sem permissão/); await f.action('detail', 'op-1'); assert.doesNotMatch(f.modals.at(-1)[3], /data-action="opportunity-retry"|data-action="opportunity-preview"/);
});

test('group bulk actions select displayed results only, clear all and preserve unsaved DOM', async () => {
  const f = fixture(); const inputA = { checked: false }, inputB = { checked: false }, rows = [{ hidden: false, querySelector: () => inputA }, { hidden: true, querySelector: () => inputB }];
  f.allElements.set('[data-opportunity-group-row]', rows); f.elements.set('#opportunity-group-count', { textContent: '' });
  await f.action('select-groups'); assert.equal(inputA.checked, true); assert.equal(inputB.checked, false); assert.equal(f.ui.hasUnsaved(), true); assert.equal(f.ui.shouldPreserveDOM(), true);
  inputB.checked = true; await f.action('clear-groups'); assert.equal(inputA.checked, false); assert.equal(inputB.checked, false);
});

test('group search updates only visibility and does not invent or change selected groups', async () => {
  const f = fixture(), input = { checked: true }, rows = [{ hidden: false, dataset: { search: 'grupo real a real-a@g.us' }, querySelector: () => input }, { hidden: false, dataset: { search: 'grupo real b real-b@g.us' } }]; f.allElements.set('[data-opportunity-group-row]', rows);
  f.ui.onInput({ id: 'opportunity-group-search', value: 'REAL A', closest: () => null }); assert.equal(rows[0].hidden, false); assert.equal(rows[1].hidden, true); assert.equal(input.checked, true);
});

test('detail preserves all origins, identifies offer update and never equates acceptance with delivery', async () => {
  const f = fixture(); await f.action('detail', 'op-1'); const html = f.modals.at(-1)[3];
  assert.match(html, /message-1/); assert.match(html, /message-2/); assert.match(html, /Alguém tem 13 pro 256\?/); assert.match(html, /Oferta atualizada — já enviada anteriormente/); assert.match(html, /original-offer/); assert.match(html, /other-original/); assert.match(html, /Envio aceito pela integração/); assert.match(html, /Entrega confirmada/); assert.match(html, /possivelmente|possibly-sent/); assert.match(html, /Sem resposta do interessado/); assert.equal(f.calls.filter(item => item.action === 'opportunitySendManual').length, 0);
});

test('manual multi-option response requires preview and forwards signed server token unchanged', async () => {
  const f = fixture(); await f.action('detail', 'op-1'); await f.select('offer-1'); await f.action('preview', 'op-1');
  assert.deepEqual(f.calls.find(item => item.action === 'opportunityPreview').payload, { id: 'op-1', offerIds: ['offer-1'] }); assert.match(f.modals.at(-1)[3], /5562999990001/); assert.equal(f.calls.filter(item => item.action === 'opportunitySendManual').length, 0);
  await f.action('confirm-send', 'op-1'); assert.deepEqual(f.calls.find(item => item.action === 'opportunitySendManual').payload, { id: 'op-1', offerIds: ['offer-1'], previewToken: 'valid-token', confirm: true }); assert.match(f.toasts.at(-1)[0], /ainda não confirma envio ou entrega/);
});

test('previously sent updated offer requires additional explicit manual warning', async () => {
  const f = fixture(); await f.action('detail', 'op-1'); await f.select('offer-2'); await f.action('preview', 'op-1'); await f.action('confirm-send', 'op-1');
  assert.match(f.confirmations.at(-1), /já foi enviada anteriormente/); assert.equal(f.calls.find(item => item.action === 'opportunitySendManual').payload.duplicateRiskAcknowledged, true);
});

test('blocked or unsigned preview disables sending and still rejects direct click', async () => {
  const f = fixture(); f.handlers.opportunityPreview = p => ({ text: 'Não enviar', offerIds: p.offerIds, canSend: false, blockers: [{ code: 'CONTACT_MUTED' }] }); await f.action('detail', 'op-1'); await f.select('offer-1'); await f.action('preview', 'op-1');
  assert.match(f.modals.at(-1)[3], /Contato silenciado/); assert.match(f.modals.at(-1)[4], /disabled/); await assert.rejects(f.action('confirm-send', 'op-1'), /prévia não está válida/); assert.equal(f.calls.filter(item => item.action === 'opportunitySendManual').length, 0);
});

test('closing or switching a detail discards delayed preview and never resurrects stale dialog', async () => {
  const f = fixture(); let resolve; f.handlers.opportunityPreview = () => new Promise(done => { resolve = done; }); await f.action('detail', 'op-1'); await f.select('offer-1'); const processing = f.action('preview', 'op-1'); await new Promise(done => setImmediate(done)); await f.action('close-modal'); const count = f.modals.length; resolve({ text: 'stale', canSend: true, previewToken: 'old-token' }); await processing; assert.equal(f.modals.length, count); assert.equal(f.calls.filter(item => item.action === 'opportunitySendManual').length, 0);
});

test('outside response, close, mute and reactivate forward explicit persistent action contract', async () => {
  const f = fixture(); for (const name of ['outside', 'close', 'mute', 'reactivate']) await f.action(name, 'op-1');
  assert.deepEqual(f.calls.filter(item => item.action === 'opportunityAction').map(item => item.payload.action), ['outsideAnswer', 'close', 'mute', 'reactivate']); assert.match(f.confirmations[0], /bloqueio de repetição/); assert.match(f.confirmations.at(-1), /não zera intervalos/);
});

test('response permission may close a request; managing configuration does not grant response actions', async () => {
  const responder = fixture({ permissions: ['opportunity.view', 'opportunity.respond'] }); await responder.ui.load();
  assert.match(responder.ui.render(), /data-action="opportunity-close"/); assert.doesNotMatch(responder.ui.render(), /data-action="opportunity-mute"/);
  await responder.action('close', 'op-1'); assert.equal(responder.calls.find(value => value.action === 'opportunityAction').payload.action, 'close');
  const manager = fixture({ permissions: ['opportunity.view', 'opportunity.manage'] }); await manager.ui.load();
  assert.doesNotMatch(manager.ui.render(), /data-action="opportunity-close"|data-action="opportunity-outside"/); assert.match(manager.ui.render(), /data-action="opportunity-mute"/);
  await assert.rejects(manager.action('close', 'op-1'), /não permite esta ação/); assert.equal(manager.calls.filter(value => value.action === 'opportunityAction').length, 0);
});

test('uncertain reconciliation never sends replacement and manual retry warns of duplication', async () => {
  const f = fixture(); await f.action('detail', 'op-1'); await f.action('reconcile', 'task-uncertain'); assert.deepEqual(f.calls.find(item => item.action === 'opportunityReconcile').payload, { id: 'task-uncertain' }); assert.equal(f.calls.filter(item => item.action === 'opportunityRetryUncertain').length, 0);
  await f.action('retry', 'task-uncertain'); assert.match(f.confirmations.at(-1), /risco de duplicação/); assert.deepEqual(f.calls.find(item => item.action === 'opportunityRetryUncertain').payload, { id: 'task-uncertain', confirm: true, confirmPossibleDuplicate: true, duplicateRiskAcknowledged: true });
  const cancel = fixture({ confirm: false }); await cancel.action('retry', 'task-uncertain'); assert.equal(cancel.calls.length, 0);
});

test('availability confirmation does not presume quantity and refuses invalid multi-unit data', async () => {
  const f = fixture(); const form = f.form('opportunity-availability-form', { quantity: '' }); form.dataset.offerId = 'offer-1'; await f.ui.onSubmit(form);
  assert.deepEqual(f.calls.find(item => item.action === 'opportunityConfirmAvailability').payload, { offerId: 'offer-1', quantity: undefined });
  const invalid = f.form('opportunity-availability-form', { quantity: '1.5' }); invalid.dataset.offerId = 'offer-1'; await assert.rejects(f.ui.onSubmit(invalid), /quantidade confirmada positiva/);
});

test('evaluation explicitly forbids send and filters/pagination go through backend', async () => {
  const f = fixture(); await f.action('evaluate'); assert.deepEqual(f.calls.find(item => item.action === 'opportunityEvaluate').payload, { send: false }); await f.ui.onSubmit(f.form('opportunity-filter-form', { query: 'iPhone 13', status: 'uncertain' })); await f.action('next');
  assert.deepEqual(f.calls.filter(item => item.action === 'opportunityPage').at(-1).payload, { offset: 30, limit: 30, status: 'uncertain', section: 'new', query: 'iPhone 13' }); assert.match(f.toasts[0][0], /1 oportunidade\(s\) reavaliada\(s\)/); assert.match(f.toasts[0][0], /sem criar envios/);
});

test('state ignores late data from another mode, user or revoked permission', async () => {
  const f = fixture(); let resolve; f.handlers.opportunityState = () => new Promise(done => { resolve = done; }); const loading = f.ui.load(); await new Promise(done => setImmediate(done)); f.ui.reset(); f.data.storageMode = 'simulated'; resolve({ config: {} }); await assert.rejects(loading, /mudou/); assert.equal(f.calls.filter(item => item.action === 'opportunityPage').length, 1); assert.doesNotMatch(f.ui.render(), /Perfil real/);
});

test('unrelated snapshots do not create read-update feedback and relevant metrics do reload', async () => {
  const f = fixture(); await f.ui.load(); const baseline = f.calls.length; for (let n = 0; n < 10; n++) { f.data.unrelatedUpdatedAt = Date.now() + n; await f.ui.maybeLoad(); } assert.equal(f.calls.length, baseline); f.data.opportunities.metrics.uncertain = 2; await f.ui.maybeLoad(); assert.equal(f.calls.length, baseline + 2);
});

test('campaign source is explicit, manual confirmation is optional, and changing availability never edits the caption', async () => {
  const f = fixture(); f.data.opportunities.campaignOffers = [{ ...f.offer, itemId: 'item-1', available: true, opportunityAvailable: true }]; f.data.opportunities.campaignOfferTotal = 1;
  f.handlers.opportunitySetCampaignItemAvailability = payload => ({ campaignId: payload.campaignId, itemId: payload.itemId, available: payload.available });
  await f.ui.load(); let html = f.ui.render();
  assert.match(html, /Fonte: minhas campanhas/); assert.match(html, /Sem consulta de estoque/); assert.match(html, /iPhone 12 Pro/); assert.match(html, /Disponível para oportunidades/); assert.match(html, /Retirar das oportunidades/);
  assert.match(html, /name="availabilityMode"/); assert.match(html, /value="campaign" selected/); assert.match(html, /opportunity-advanced-availability"><summary>/);
  await f.ui.onAction('opportunity-campaign-availability', { dataset: { campaignId: 'camp-a', itemId: 'item-1', available: 'false' } });
  assert.deepEqual(f.calls.find(value => value.action === 'opportunitySetCampaignItemAvailability').payload, { campaignId: 'camp-a', itemId: 'item-1', available: false });
  assert.match(f.confirmations.at(-1), /legenda da campanha e o histórico serão preservados/); assert.match(f.toasts.at(-1)[0], /legenda original foi preservada/);
  assert.equal(f.calls.some(value => /saveCampaign|opportunityConfirmAvailability/.test(value.action)), false);
  await f.ui.onSubmit(f.configForm()); assert.equal(f.calls.find(value => value.action === 'opportunityConfigSave').payload.config.availabilityMode, 'campaign');
});

test('advanced confirmation rule persists without forcing it on campaign mode or assuming stock', async () => {
  const f = fixture(); f.data.opportunities.config.availabilityMode = 'confirmed'; await f.ui.load();
  const html = f.ui.render(); assert.match(html, /opportunity-advanced-availability" open/); assert.match(html, /value="confirmed" selected/);
  const form = f.configForm(); form.elements.availabilityMode = { value: 'confirmed' }; await f.ui.onSubmit(form);
  assert.equal(f.calls.find(value => value.action === 'opportunityConfigSave').payload.config.availabilityMode, 'confirmed');
  await f.action('detail', 'op-1'); assert.match(f.modals.at(-1)[3], /Disponibilidade confirmada/); assert.match(f.modals.at(-1)[3], /Ainda disponível/);
});

test('intent filter is forwarded to the backend across pages and clear labels require safe interpretation', async () => {
  const f = fixture(); f.op.request = { safe: true, complete: true }; await f.ui.load(); assert.match(f.ui.render(), /Procura clara/);
  f.op.request.safe = false; assert.match(f.ui.render(), /Revisar intenção/);
  await f.ui.onSubmit(f.form('opportunity-filter-form', { query: 'iPhone 12 Pro', status: '', intent: 'clear' })); await f.action('next');
  assert.deepEqual(f.calls.filter(value => value.action === 'opportunityPage').at(-1).payload, { offset: 30, limit: 30, status: undefined, section: 'new', query: 'iPhone 12 Pro', intent: 'clear' });
  f.op.request = {}; await f.action('previous'); assert.match(f.ui.render(), /Revisar intenção/);
});

test('campaign announcement management requires both permissions and never weakens response permissions', async () => {
  const f = fixture({ permissions: ['opportunity.view', 'opportunity.manage'] });
  f.data.opportunities.campaignOffers = [{ ...f.offer, itemId: 'item-1', available: true }]; await f.ui.load();
  assert.doesNotMatch(f.ui.render(), /data-action="opportunity-campaign-availability"/);
  await assert.rejects(f.ui.onAction('opportunity-campaign-availability', { dataset: { campaignId: 'camp-a', itemId: 'item-1', available: 'false' } }), /gerenciar oportunidades e editar/);
  assert.equal(f.calls.some(value => value.action === 'opportunitySetCampaignItemAvailability'), false);
});

test('repeated send clicks while the request is processing create one backend request', async () => {
  const f = fixture(); let release;
  await f.action('detail', 'op-1'); await f.select('offer-1'); await f.action('preview', 'op-1');
  f.handlers.opportunitySendManual = () => new Promise(resolve => { release = resolve; });
  const first = f.action('confirm-send', 'op-1'); await new Promise(resolve => setImmediate(resolve));
  await f.action('confirm-send', 'op-1'); assert.equal(f.calls.filter(value => value.action === 'opportunitySendManual').length, 1);
  release({ status: 'queued' }); await first;
});

test('state and the current page load concurrently without waiting for an unrelated response', async () => {
  const f = fixture(); let release;
  f.handlers.opportunityState = () => new Promise(resolve => { release = resolve; });
  const loading = f.ui.load(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(value => value.action === 'opportunityPage').length, 1);
  release(f.data.opportunities); await loading;
});

test('queue status explains connection, safety interval and processing without reporting delivery', async () => {
  const f = fixture(); f.data.opportunities.queueState = { connected: false, queued: 2 }; await f.ui.load();
  assert.match(f.ui.render(), /Aguardando conexão do WhatsApp/);
  f.data.opportunities.queueState = { connected: true, queued: 2, nextAttemptAt: Date.now() + 60000 };
  assert.match(f.ui.render(), /Aguardando intervalo de segurança/);
  f.data.opportunities.queueState.busy = true; assert.match(f.ui.render(), /Processando uma resposta/);
  assert.doesNotMatch(f.ui.render(), /Resposta entregue com sucesso/);
});

test('catalog reports its page limit explicitly instead of hiding additional announcements', async () => {
  const f = fixture(); f.data.opportunities.campaignOffers = [{ ...f.offer, itemId: 'item-1', available: true }]; f.data.opportunities.campaignOfferTotal = 101; await f.ui.load();
  assert.match(f.ui.render(), /Exibindo 1–1 de 101 ofertas/); assert.match(f.ui.render(), /processamento considera todo o catálogo elegível/);
});


test('campaign announcement catalog pages through the backend and keeps the drawer open', async () => {
  const f = fixture(); f.data.opportunities.campaignOfferTotal = 201; f.data.opportunities.campaignOffers = [{ ...f.offer, itemId: 'item-1', available: true }];
  f.handlers.opportunityCampaignOffersPage = payload => ({ items: [{ ...f.offer, itemId: `page-${payload.offset}`, model: 'iPhone 12 Pro', available: true }], offset: payload.offset, total: 201, limit: 100 });
  await f.ui.load(); await f.action('catalog-next');
  assert.deepEqual(f.calls.find(value => value.action === 'opportunityCampaignOffersPage').payload, { offset: 100, limit: 100 });
  assert.match(f.ui.render(), /opportunity-catalog" open/); assert.match(f.ui.render(), /Exibindo 101–101 de 201 ofertas/);
  await f.action('catalog-previous'); assert.equal(f.calls.filter(value => value.action === 'opportunityCampaignOffersPage').at(-1).payload.offset, 0);
});

test('campaign toggle never reports success without a matching persistence response', async () => {
  const f = fixture(); f.handlers.opportunitySetCampaignItemAvailability = () => ({});
  await assert.rejects(f.ui.onAction('opportunity-campaign-availability', { dataset: { campaignId: 'camp-a', itemId: 'item-1', available: 'true' } }), /não confirmou a atualização/);
  assert.equal(f.toasts.length, 0);
});

test('catalog does not describe a pending or ambiguous campaign item as available', async () => {
  const f = fixture(); f.data.opportunities.campaignOffers = [{ ...f.offer, itemId: 'pending-item', available: null, opportunityAvailable: true }]; await f.ui.load();
  const html = f.ui.render(); assert.match(html, /Anúncio precisa de revisão/); assert.doesNotMatch(html, /opportunity-availability-state available/);
  assert.match(html, /Retirar das oportunidades/);
});

test('a newer intent filter is not discarded while the preceding search is still loading', async () => {
  const f = fixture(), pending = [];
  f.handlers.opportunityPage = payload => new Promise(resolve => pending.push({ payload, resolve }));
  const first = f.ui.onSubmit(f.form('opportunity-filter-form', { query: '', status: '', intent: 'clear' }));
  await new Promise(resolve => setImmediate(resolve));
  const second = f.ui.onSubmit(f.form('opportunity-filter-form', { query: '', status: '', intent: 'review' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(pending.map(value => value.payload.intent), ['clear', 'review']);
  pending[1].resolve({ items: [], total: 0 }); await second;
  pending[0].resolve({ items: [f.op], total: 1 }); await first;
  assert.match(f.ui.render(), /value="review" selected/); assert.doesNotMatch(f.ui.render(), /data-opportunity-id="op-1"/);
});

test('background rendering preserves a changed filter draft before the user clicks Filtrar', async () => {
  const f = fixture(); await f.ui.load(); let release;
  f.handlers.opportunityPage = () => new Promise(resolve => { release = resolve; });
  const first = f.ui.onSubmit(f.form('opportunity-filter-form', { query: '', status: '', intent: 'clear' }));
  await new Promise(resolve => setImmediate(resolve));
  await f.ui.onChange({ name: 'intent', value: 'review', dataset: {}, closest: selector => selector === '#opportunity-filter-form' ? {} : null });
  f.ui.onInput({ name: 'query', value: 'iPhone 12 Pro', dataset: {}, closest: selector => selector === '#opportunity-filter-form' ? {} : null });
  release({ items: [f.op], total: 1 }); await first;
  const html = f.ui.render(); assert.match(html, /value="review" selected/); assert.match(html, /value="iPhone 12 Pro" placeholder=/);
  assert.equal(f.calls.filter(value => value.action === 'opportunityPage').at(-1).payload.intent, 'clear', 'Draft changes do not launch a search before explicit submission');
  f.handlers.opportunityPage = () => ({ items: [], total: 0 });
  await f.ui.onSubmit(f.form('opportunity-filter-form', { query: 'iPhone 12 Pro', status: '', intent: 'review' }));
  assert.equal(f.calls.filter(value => value.action === 'opportunityPage').at(-1).payload.intent, 'review');
});

test('legacy availability mode can explicitly use selected campaign announcements without a stock confirmation', async () => {
 const f=fixture();f.data.opportunities.config.availabilityMode='confirmed';await f.ui.load();
 await f.action('origins','op-1');
 assert.match(f.modals.at(-1)[3],/Usar anúncios da campanha sem verificar estoque/);
 await f.action('use-campaigns','op-1');
 const saved=f.calls.filter(v=>v.action==='opportunityConfigSave').at(-1).payload.config;
 assert.equal(saved.availabilityMode,'campaign');assert.equal(saved.mode,undefined);assert.equal(saved.automatic,false);
 assert.deepEqual(saved.campaignIds,['camp-a']);assert.doesNotMatch(f.modals.at(-1)[3],/data-action="opportunity-availability"/);
 assert.match(f.modals.at(-1)[3],/Não é necessário verificar estoque/);
 assert.equal(f.calls.some(v=>v.action==='opportunitySendManual'),false,'mode switch never sends by itself');
});
