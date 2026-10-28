'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture({ permissions = ['*'], match = true } = {}) {
  const calls = [], modals = [], confirmations = [];
  let modalKind = '';
  const at = Date.now() - 5 * 60000;
  const offer = { id: 'offer-1', offerId: 'offer-1', compatible: true, model: 'iPhone 13 Pro', storageGB: 256, color: 'Azul', condition: 'Seminovo', priceCents: 305000, caption: 'iPhone 13 Pro 256GB\nR$ 3.050,00\nPequeno detalhe na tela', campaignId: 'campaign-1' };
  const opportunity = { id: 'request-1', requests: [{ model: 'iPhone 13 Pro', storageGB: 256 }], senderName: 'Lojista real', senderPhone: '5562999990001', senderId: '5562999990001@s.whatsapp.net', originalAt: at, expiresAt: at + 2 * 3600000, status: 'open', originalText: 'Alguém tem 13 pro 256?\nAté R$ 3.100', originPreview: { groupId: 'real-group@g.us', groupName: 'Grupo monitorado', originalAt: at }, groupCount: 3, blockers: [{ code: 'EVALUATION_MODE' }], matchPreview: match ? { ...offer, campaignName: 'Lista da loja', mediaId: 'managed-photo', available: true, text: offer.caption } : null };
  const data = { storageMode: 'whatsapp', campaigns: [{ id: 'campaign-1', name: 'Lista da loja' }], opportunities: { config: { enabled: true, evaluation: true, automatic: false, monitoredGroupIds: [], campaignIds: [], timezone: 'America/Sao_Paulo' }, metrics: { new: 6, review: 2, tasks: { accepted: 3, delivered: 1, queued: 2, sending: 1, uncertain: 1, failed: 2 } }, monitor: { lastMessageAt: at } } };
  const detail = { opportunity, candidates: [offer], origins: [{ groupId: 'real-group@g.us', groupName: 'Grupo monitorado', messageId: 'original-message', originalAt: at, text: opportunity.originalText }], tasks: [] };
  const handlers = { opportunityState: () => data.opportunities, opportunityPage: payload => ({ items: [opportunity], total: 90, offset: payload.offset }), opportunityDetail: () => detail, opportunityPreview: payload => ({ offerIds: payload.offerIds, previewToken: 'server-preview-token', canSend: true, recipient: { phone: opportunity.senderPhone }, blockers: [], text: offer.caption }), opportunityAction: () => ({ recorded: true }) };
  const document = { querySelector: () => null, querySelectorAll: () => [], activeElement: null };
  const context = vm.createContext({ window: {}, document, Date, Set, Map, Intl, console, confirm: value => { confirmations.push(value); return true; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/ui/opportunities.js'), 'utf8'), context);
  const ui = context.window.KennedOpportunitiesUI.create({ can: permission => permissions.includes('*') || permissions.includes(permission), auth: () => ({ user: { id: 'owner' } }), data: () => data, groups: () => [{ id: 'real-group@g.us', name: 'Grupo monitorado', simulation: false }], call: async (name, payload) => { calls.push({ name, payload: structuredClone(payload) }); if (!handlers[name]) throw new Error('Unexpected operation: ' + name); return handlers[name](payload); }, render: () => {}, refresh: async () => {}, toast: () => {}, showModal: (...args) => { modalKind = args[0]; modals.push(args); }, closeModal: () => { modalKind = ''; }, modalKind: () => modalKind });
  const action = (name, id) => ui.onAction('opportunity-' + name, { dataset: { id } });
  return { ui, action, data, opportunity, offer, detail, handlers, calls, modals, confirmations };
}

test('cards show the original request, exact model, identity, source, matched photo and campaign without inventing characteristics', async () => {
  const f = fixture(); await f.ui.load(); const html = f.ui.render();
  assert.match(html, /<h1>Oportunidades<\/h1>/); assert.match(html, /Pedidos dos grupos que combinam com seus anúncios\./);
  assert.match(html, /iPhone 13 Pro • 256GB/); assert.match(html, /Alguém tem 13 pro 256\?/); assert.match(html, /Até R\$ 3\.100/);
  assert.match(html, /Lojista real/); assert.match(html, /5562999990001/); assert.match(html, /Grupo monitorado/); assert.match(html, /Há 5 min/);
  assert.match(html, /mega-media:\/\/asset\/managed-photo/); assert.match(html, /Pequeno detalhe na tela/); assert.match(html, /Lista da loja/);
  assert.match(html, /Pedido repetido em 3 grupos — uma única resposta/); assert.match(html, /Enviar oferta/); assert.match(html, /Ver mensagem de origem/); assert.match(html, /Ver oferta/); assert.match(html, /Já respondi/); assert.match(html, /Ignorar/);
  assert.doesNotMatch(html, /Vendido|Venda realizada/);
});

test('four indicators distinguish accepted, delivered and pending operations', async () => {
  const f = fixture(); await f.ui.load(); const html = f.ui.render();
  assert.equal((html.match(/class="opportunity-metric /g) || []).length, 4);
  assert.match(html, /class="opportunity-metric new"><strong>6<\/strong>/); assert.match(html, /class="opportunity-metric review"><strong>2<\/strong>/);
  assert.match(html, /class="opportunity-metric sent"><strong>4<\/strong>/); assert.match(html, /3 envio\(s\) aceito\(s\) · 1 entrega\(s\) confirmada\(s\)/);
  assert.match(html, /class="opportunity-metric pending"><strong>6<\/strong>/); assert.match(html, /1 incerto\(s\) · 2 falha\(s\)/);
  assert.match(html, /Isso não representa uma venda/);
});

test('tabs and pagination apply their section on the backend rather than filtering only the visible page', async () => {
  const f = fixture(); await f.ui.load(); assert.equal(f.calls.find(value => value.name === 'opportunityPage').payload.section, 'new');
  await f.action('section', 'following'); await f.action('next');
  assert.deepEqual(f.calls.filter(value => value.name === 'opportunityPage').at(-1).payload, { offset: 30, limit: 30, status: undefined, section: 'following', query: undefined });
  await f.action('section', 'closed'); assert.equal(f.calls.filter(value => value.name === 'opportunityPage').at(-1).payload.offset, 0);
  assert.match(f.ui.render(), /data-id="closed" aria-pressed="true"/); await assert.rejects(f.action('section', 'invalid'), /Etapa de oportunidade inválida/);
  assert.equal(f.calls.filter(value => /Send|ConfigSave/.test(value.name)).length, 0);
});

test('card send opens a signed preview and never submits a message without the separate confirmation', async () => {
  const f = fixture(); await f.ui.load(); await f.action('offer-preview', 'request-1');
  assert.deepEqual(f.calls.find(value => value.name === 'opportunityPreview').payload, { id: 'request-1', offerIds: ['offer-1'] });
  assert.equal(f.modals.at(-1)[0], 'opportunity-preview'); assert.match(f.modals.at(-1)[3], /5562999990001/);
  assert.match(f.modals.at(-1)[4], /Confirmar e enviar resposta/); assert.equal(f.calls.filter(value => value.name === 'opportunitySendManual').length, 0);
});

test('missing or changed safe matches cannot be sent by a direct card click', async () => {
  const absent = fixture({ match: false }); await absent.ui.load(); const html = absent.ui.render();
  assert.match(html, /Nenhuma oferta segura para apresentar/); assert.match(html, /data-action="opportunity-choose-campaign" data-id="request-1"/);
  assert.equal(absent.calls.some(value => value.name === 'opportunityPreview'), false, 'A missing automatic match never starts a preview or send by itself');
  const changed = fixture(); await changed.ui.load(); changed.offer.compatible = false;
  await assert.rejects(changed.action('offer-preview', 'request-1'), /deixou de ser compatível/); assert.equal(changed.calls.some(value => value.name === 'opportunityPreview'), false);
});

test('offer and source actions consult actual records and retain all original messages', async () => {
  const f = fixture(); await f.ui.load(); await f.action('origins', 'request-1');
  assert.match(f.modals.at(-1)[3], /id="opportunity-detail-origins"/); assert.match(f.modals.at(-1)[3], /original-message/);
  await f.action('offer-detail', 'request-1'); assert.match(f.modals.at(-1)[3], /id="opportunity-detail-offers"/);
  assert.equal(f.calls.filter(value => value.name === 'opportunityDetail').length, 2); assert.equal(f.calls.some(value => value.name === 'opportunityPreview'), false);
});

test('mode banner uses persisted configuration, and review-only access does not show media or response controls', async () => {
  const f = fixture({ permissions: ['opportunity.view'] }); await f.ui.load(); const html = f.ui.render();
  assert.match(html, /Modo atual: Somente avisar/); assert.match(html, /AVALIAÇÃO — SEM ENVIO AUTOMÁTICO/);
  assert.doesNotMatch(html, /mega-media:\/\/asset\/managed-photo|data-action="opportunity-offer-preview"|data-action="opportunity-outside"|data-action="opportunity-close"/);
  await assert.rejects(f.action('offer-preview', 'request-1'), /Sem permissão/);
  f.data.opportunities.config.evaluation = false; f.data.opportunities.config.automatic = true;
  assert.match(f.ui.render(), /Modo atual: Resposta automática/);
  assert.equal(f.calls.some(value => /ConfigSave|Send/.test(value.name)), false);
});

test('unavailable names, phones and original text are explicit, and source-controlled markup is escaped', async () => {
  const f = fixture(); f.opportunity.senderName = ''; f.opportunity.senderPhone = ''; f.opportunity.originalText = '<img src=x onerror=alert(1)>\nPreço original';
  f.opportunity.matchPreview.text = '<script>fornecedor</script>'; await f.ui.load(); const html = f.ui.render();
  assert.match(html, /Nome de perfil indisponível/); assert.match(html, /Número indisponível/); assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/); assert.match(html, /&lt;script&gt;fornecedor&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>fornecedor|<img src=x/);
  f.opportunity.originalText = ''; assert.match(f.ui.render(), /Mensagem original indisponível/);
});


test('pending indicators count tasks rather than opportunities, and videos are not represented as product photos', async () => {
  const f = fixture(); f.data.opportunities.metrics.uncertain = 1; f.data.opportunities.metrics.tasks.uncertain = 3;
  f.opportunity.matchPreview.mediaType = 'video'; await f.ui.load(); const html = f.ui.render();
  assert.match(html, /class="opportunity-metric pending"><strong>8<\/strong>/); assert.match(html, /3 incerto\(s\)/);
  assert.doesNotMatch(html, /<img class="opportunity-match-photo"/);
});
