'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture({ permissions = ['*'], confirm = true } = {}) {
  const at = Date.UTC(2026, 9, 9, 12);
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [at])); } static now() { return at; } }
  const groupId = '12000-real-source@g.us';
  const source = { id: 'source-live', name: 'Lista atual', state: 'draft', sourceManaged: true, sourceGroupId: groupId, sourceDateKey: '2026-10-09', items: [] };
  const common = { id: 'common', name: '<Campanha preservada>', state: 'paused', items: [{ id: 'old-item', type: 'text', text: 'Texto original' }], groupIds: ['target@g.us'] };
  const data = { storageMode: 'whatsapp', sources: { config: { enabled: true, groupId, timezone: 'America/Sao_Paulo', capturePaused: true, captureLink: { status: 'paused', campaignId: null, previousCampaignId: 'removed', generation: 4, code: 'SOURCE_CAMPAIGN_REMOVED' } }, metrics: {} }, campaigns: [source, common, { ...source, id: 'active', name: 'Não mostrar ativa', state: 'active' }, { ...source, id: 'old-day', name: 'Não mostrar dia anterior', sourceDateKey: '2026-10-08' }, { ...source, id: 'other-source', name: 'Não mostrar outra origem', sourceGroupId: 'other@g.us' }], media: [] };
  const publications = [{ id: 'removed-pub', campaignId: 'removed', status: 'removed', caption: 'Conteúdo antigo' }, { id: 'live-pub', campaignId: source.id, status: 'ready', caption: 'Conteúdo atual' }];
  let modalKind = '', closed = 0, rendered = 0, refreshed = 0;
  const calls = [], confirmations = [], modals = [], toasts = [], elements = new Map();
  const handlers = {
    sourceConfigGet: () => ({ config: data.sources.config, metrics: data.sources.metrics }),
    sourcePublications: p => ({ items: publications.filter(item => !p.campaignId || item.campaignId === p.campaignId), total: publications.length }),
    sourceResumeGroup: p => { const id = p.campaignId || 'new'; data.sources.config.capturePaused = false; data.sources.config.captureLink = { status: 'active', campaignId: id }; return { link: { status: 'active', campaignId: id }, campaign: { id, state: 'draft' }, captureFrom: at, importedOldMessages: false }; }
  };
  const document = { querySelector: selector => elements.get(selector) || null, querySelectorAll: () => [], activeElement: null };
  const context = vm.createContext({ window: {}, document, confirm: text => { confirmations.push(text); return confirm; }, Date: Clock, Intl, Set, Map, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/ui/source-campaigns.js'), 'utf8'), context);
  const ui = context.window.KennedSourceCampaignsUI.create({ can: p => permissions.includes('*') || permissions.includes(p), auth: () => ({ user: { id: 'owner' } }), data: () => data, groups: () => [{ id: groupId, name: 'Origem real', simulation: false }], icon: () => '', call: async (action, payload) => { calls.push({ action, payload: structuredClone(payload) }); if (!handlers[action]) throw new Error('Unexpected RPC ' + action); return handlers[action](payload); }, refresh: async () => refreshed++, render: () => rendered++, showModal: (...args) => { modalKind = args[0]; modals.push(args); }, closeModal: () => { modalKind = ''; closed++; }, modalKind: () => modalKind, toast: (...args) => toasts.push(args), navigate: () => {} });
  const action = (name, id) => ui.onAction('source-' + name, { dataset: { id } });
  const form = id => ({ id: 'source-resume-link-form', dataset: { groupId }, elements: { campaignId: { value: id } }, reportValidity: () => true });
  return { ui, data, source, common, publications, groupId, calls, handlers, confirmations, modals, toasts, elements, action, form, closed: () => closed, modalKind: () => modalKind, rendered: () => rendered, refreshed: () => refreshed };
}

test('paused source shows all three explicit choices without automatically resuming', async () => {
  const f = fixture(); await f.ui.load(); const html = f.ui.render();
  assert.match(html, /Pausada — campanha excluída/);
  assert.match(html, /Criar nova campanha e retomar/);
  assert.match(html, /Vincular a uma campanha existente e retomar/);
  assert.match(html, /Manter importação pausada/);
  assert.match(html, /mensagens anteriores ou recebidas na pausa exigem/i);
  assert.doesNotMatch(html, /data-id="removed"/);
  for (let i = 0; i < 10; i++) { f.ui.render(); await f.ui.maybeLoad(); }
  assert.equal(f.calls.filter(c => c.action === 'sourceResumeGroup').length, 0);
  assert.equal(f.toasts.length, 0);
});

test('resume actions respect configuration and campaign editing permissions', async () => {
  const f = fixture({ permissions: ['campaign.view'] }); const html = f.ui.render();
  assert.doesNotMatch(html, /data-action="source-resume-new"|data-action="source-resume-link"/);
  await assert.rejects(f.action('resume-new'), /Sem permissão/);
  await assert.rejects(f.action('resume-link'), /Sem permissão/);
  assert.equal(f.calls.length, 0);
  const createOnly = fixture({ permissions: ['settings.edit', 'groups.view', 'campaign.create', 'media.create', 'campaign.view'] });
  assert.match(createOnly.ui.render(), /data-action="source-resume-new"/);
  assert.doesNotMatch(createOnly.ui.render(), /data-action="source-resume-link"/);
});

test('creating a replacement requires confirmation and requests only a new draft', async () => {
  const f = fixture(); await f.action('resume-new');
  assert.deepEqual(f.calls.find(c => c.action === 'sourceResumeGroup').payload, { groupId: f.groupId, confirm: true });
  assert.match(f.confirmations[0], /Somente publicações novas/);
  assert.match(f.confirmations[0], /Nenhuma campanha ou envio antigo será reativado/);
  assert.equal(f.calls.filter(c => c.action === 'sourceImportHistory').length, 0);
  assert.equal(f.data.sources.config.capturePaused, false);
  const refused = fixture({ confirm: false }); await refused.action('resume-new'); assert.equal(refused.calls.length, 0);
});

test('existing campaign choices exclude active, other-source and previous-day source campaigns', async () => {
  const f = fixture(); await f.action('resume-link'); const html = f.modals.at(-1)[3];
  assert.match(html, /value="source-live"/); assert.match(html, /value="common"/);
  assert.match(html, /&lt;Campanha preservada&gt;/);
  assert.doesNotMatch(html, /value="active"|value="other-source"|value="old-day"/);
  assert.match(html, /name="campaignId" required/);
  assert.match(f.modals.at(-1)[2], /nenhum disparo será iniciado/i);
  assert.equal(f.calls.length, 0);
});

test('linking existing campaign passes its exact ID and leaves existing contents intact', async () => {
  const f = fixture(); const before = structuredClone(f.common);
  await f.action('resume-link'); await f.ui.onSubmit(f.form('common'));
  assert.deepEqual(f.calls.find(c => c.action === 'sourceResumeGroup').payload, { groupId: f.groupId, campaignId: 'common', confirm: true });
  assert.deepEqual(f.common, before);
  assert.equal(f.modalKind(), '');
  assert.match(f.confirmations[0], /conteúdo e as configurações existentes serão preservados/);
  assert.match(f.toasts.at(-1)[0], /rascunho/);
});

test('stale existing campaign or changed origin is rejected before any resume RPC', async () => {
  const deleted = fixture(); const form = deleted.form('common'); deleted.data.campaigns = deleted.data.campaigns.filter(c => c.id !== 'common');
  await assert.rejects(deleted.ui.onSubmit(form), /não está mais disponível/); assert.equal(deleted.calls.length, 0);
  const changed = fixture(); const stale = changed.form('common'); changed.data.sources.config.groupId = 'new@g.us';
  await assert.rejects(changed.ui.onSubmit(stale), /grupo de origem mudou/); assert.equal(changed.calls.length, 0);
  const empty = fixture(); await assert.rejects(empty.ui.onSubmit(empty.form('')), /Selecione uma campanha/); assert.equal(empty.calls.length, 0);
});

test('keeping source paused performs no mutation, import, creation or WhatsApp send', async () => {
  const f = fixture(); await f.action('keep-paused');
  assert.equal(f.calls.length, 0); assert.equal(f.data.sources.config.capturePaused, true);
  assert.match(f.toasts.at(-1)[0], /permanece pausada/);
});

test('campaign deletion clears active filter before all subsequent automatic page requests', async () => {
  const f = fixture(); await f.ui.onChange({ id: 'source-campaign-filter', value: 'source-live', dataset: {}, closest: () => null });
  assert.equal(f.calls.at(-1).payload.campaignId, 'source-live');
  const before = f.calls.length; f.data.campaigns = f.data.campaigns.filter(c => c.id !== 'source-live');
  await f.ui.maybeLoad(); await f.ui.maybeLoad();
  const after = f.calls.slice(before).filter(c => c.action === 'sourcePublications');
  assert.equal(after.length, 1); assert.equal(after[0].payload.campaignId, undefined); assert.equal(after[0].payload.offset, 0);
  assert.equal(f.toasts.length, 0);
});

test('deleted campaign monitor is closed once and does not throw or repeatedly notify', async () => {
  const f = fixture(); await f.action('monitor', 'source-live'); assert.equal(f.modalKind(), 'source-monitor');
  f.data.campaigns = f.data.campaigns.filter(c => c.id !== 'source-live');
  for (let i = 0; i < 20; i++) { f.ui.updateMonitor(); f.ui.render(); }
  assert.equal(f.closed(), 1); assert.equal(f.modalKind(), ''); assert.equal(f.calls.length, 0); assert.equal(f.toasts.length, 0);
  assert.match(f.ui.renderMonitor('source-live'), /foi excluída/);
  await f.action('monitor-refresh', 'source-live'); assert.equal(f.modals.length, 1);
});

test('deletion racing page RPC falls back once without retrying removed campaign ID', async () => {
  const f = fixture(); let request = 0;
  f.handlers.sourcePublications = payload => {
    request++;
    if (payload.campaignId === 'source-live') throw Object.assign(new Error('Campanha não encontrada.'), { code: 'CAMPAIGN_NOT_FOUND' });
    return { items: [], total: 0 };
  };
  await f.ui.onChange({ id: 'source-campaign-filter', value: 'source-live', dataset: {}, closest: () => null });
  assert.equal(request, 2); const calls = f.calls.filter(c => c.action === 'sourcePublications');
  assert.equal(calls[0].payload.campaignId, 'source-live'); assert.equal(calls[1].payload.campaignId, undefined);
  for (let i = 0; i < 20; i++) await f.ui.maybeLoad();
  assert.equal(request, 2); assert.equal(f.toasts.length, 0);
});

test('double-click during resume can create only one backend request', async () => {
  const f = fixture(); let resolve;
  f.handlers.sourceResumeGroup = () => new Promise(done => { resolve = done; });
  const first = f.action('resume-new'); await new Promise(done => setImmediate(done));
  await f.action('resume-new'); assert.equal(f.calls.filter(c => c.action === 'sourceResumeGroup').length, 1);
  f.data.sources.config.capturePaused = false; f.data.sources.config.captureLink = { status: 'active', campaignId: 'new' };
  resolve({ link: { status: 'active', campaignId: 'new' }, campaign: { id: 'new', state: 'draft' }, captureFrom: Date.now(), importedOldMessages: false }); await first;
  assert.equal(f.confirmations.length, 1);
});

test('unsaved origin settings are preserved until saved or discarded before resuming', async () => {
  const f = fixture(); f.ui.onInput({ closest: selector => selector === '#source-config-form' ? {} : null });
  await assert.rejects(f.action('resume-new'), /Salve ou descarte/);
  await assert.rejects(f.action('resume-link'), /Salve ou descarte/);
  assert.equal(f.calls.length, 0); assert.equal(f.ui.hasUnsaved(), true);
});


test('resume never claims success when backend or recovered config cannot confirm persistence', async () => {
  const incomplete = fixture(); incomplete.handlers.sourceResumeGroup = () => ({});
  await assert.rejects(incomplete.action('resume-new'), /não confirmou/); assert.equal(incomplete.toasts.length, 0);
  const lost = fixture(); lost.handlers.sourceResumeGroup = () => ({ link: { status: 'active', campaignId: 'new' }, campaign: { id: 'new', state: 'draft' }, captureFrom: Date.now() });
  await assert.rejects(lost.action('resume-new'), /não foi recuperada/); assert.equal(lost.toasts.length, 0);
});
