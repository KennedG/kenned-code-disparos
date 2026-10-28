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

const item={campaignId:'camp-a',itemId:'raw-1',campaignName:'Lista real da loja',type:'image',mediaId:'managed-raw',text:'📱 iPhone 12 Pro\nConsulte o valor.\nDetalhe na tela pequeno 😊',manualEligible:true};
function manualFixture(options){const f=fixture(options);f.handlers.opportunityCampaignItemsPage=p=>({items:[{...item}],total:1,offset:p.offset,limit:p.limit});f.handlers.opportunityPreview=p=>({canSend:true,blockers:[],warnings:[],previewToken:'manual-signed-token',text:item.text,offerIds:['manual-raw-1'],manualCampaignSelection:p.manualCampaignSelection});return f;}
test('raw announcement can be chosen without an automatic match or parsed price, but only a signed preview can enqueue it',async()=>{
 const f=manualFixture();await f.ui.load();assert.match(f.ui.render(),/Escolher anúncio da campanha/);
 await f.action('choose-campaign','op-1');const chooser=f.modals.at(-1);assert.equal(chooser[0],'opportunity-campaign-chooser');assert.match(chooser[3],/Sem consulta a estoque|Não é necessário identificar preço/);assert.match(chooser[3],/Detalhe na tela pequeno/);
 assert.equal(f.calls.some(c=>c.action==='opportunitySendManual'),false);
 await f.action('manual-item-preview','op-1',{campaignId:'camp-a',itemId:'raw-1'});
 const request=f.calls.find(c=>c.action==='opportunityPreview').payload;assert.deepEqual(request,{id:'op-1',offerIds:[],manualCampaignSelection:{campaignId:'camp-a',itemId:'raw-1'}});
 const preview=f.modals.at(-1);assert.equal(preview[0],'opportunity-preview');assert.match(preview[3],/Escolha manual/);assert.match(preview[3],/5562999990001/);assert.match(preview[3],/Detalhe na tela pequeno/);assert.match(preview[3],/managed-raw/);assert.equal(f.calls.some(c=>c.action==='opportunitySendManual'),false);
 await f.action('confirm-send','op-1');const sent=f.calls.find(c=>c.action==='opportunitySendManual').payload;assert.equal(sent.previewToken,'manual-signed-token');assert.deepEqual(sent.manualCampaignSelection,{campaignId:'camp-a',itemId:'raw-1'});assert.equal(sent.confirm,true);
});
test('unavailable raw campaign items and forged stale item IDs cannot request a preview',async()=>{
 const f=manualFixture();f.handlers.opportunityCampaignItemsPage=()=>({items:[{...item,manualEligible:false,blocker:{code:'OFFER_EXCLUDED',reason:'Anúncio retirado'}}],total:1});await f.ui.load();await f.action('choose-campaign','op-1');assert.match(f.modals.at(-1)[3],/Anúncio retirado/);
 await assert.rejects(f.action('manual-item-preview','op-1',{campaignId:'camp-a',itemId:'raw-1'}),/retirado/);
 await assert.rejects(f.action('manual-item-preview','op-1',{campaignId:'camp-a',itemId:'forged'}),/não pode ser selecionado/);assert.equal(f.calls.some(c=>c.action==='opportunityPreview'),false);
});
test('manual campaign items page and filter are sent to the backend without silently truncating the catalog',async()=>{
 const f=manualFixture();f.handlers.opportunityCampaignItemsPage=p=>({items:[{...item,itemId:'raw-'+p.offset}],total:65});await f.ui.load();await f.action('choose-campaign','op-1');await f.action('manual-items-next','op-1');
 const pageCalls=f.calls.filter(c=>c.action==='opportunityCampaignItemsPage');assert.equal(pageCalls[1].payload.offset,30);assert.equal(pageCalls[1].payload.limit,30);
 await f.ui.onChange({id:'opportunity-manual-campaign',value:'camp-a'});assert.deepEqual(f.calls.filter(c=>c.action==='opportunityCampaignItemsPage').at(-1).payload,{offset:0,limit:30,campaignId:'camp-a'});
 await assert.rejects(f.ui.onChange({id:'opportunity-manual-campaign',value:'foreign'}),/campanha habilitada/);
});
test('a readonly actor cannot open the chooser or request a raw manual preview directly',async()=>{
 const f=manualFixture({permissions:['opportunity.view']});await f.ui.load();assert.doesNotMatch(f.ui.render(),/data-action="opportunity-choose-campaign"/);await assert.rejects(f.action('choose-campaign','op-1'),/Sem permissão/);await assert.rejects(f.action('manual-item-preview','op-1'),/Sem permissão/);assert.equal(f.calls.some(c=>c.action==='opportunityCampaignItemsPage'),false);
});
test('mismatched or unsigned raw preview cannot enable final submission',async()=>{
 const f=manualFixture();await f.ui.load();await f.action('choose-campaign','op-1');f.handlers.opportunityPreview=()=>({canSend:true,previewToken:'bad',manualCampaignSelection:{campaignId:'other',itemId:'raw-1'}});
 await assert.rejects(f.action('manual-item-preview','op-1',{campaignId:'camp-a',itemId:'raw-1'}),/não corresponde/);assert.equal(f.calls.some(c=>c.action==='opportunitySendManual'),false);
 f.handlers.opportunityPreview=p=>({canSend:true,blockers:[],text:item.text,manualCampaignSelection:p.manualCampaignSelection});await f.action('manual-item-preview','op-1',{campaignId:'camp-a',itemId:'raw-1'});assert.match(f.modals.at(-1)[4],/disabled/);await assert.rejects(f.action('confirm-send','op-1'),/não está válida/);
});
test('raw manual backend blockers remain visible and cannot be bypassed by direct confirmation',async()=>{
 const f=manualFixture();await f.ui.load();await f.action('choose-campaign','op-1');f.handlers.opportunityPreview=p=>({canSend:false,blockers:[{code:'OP_UNCERTAIN',reason:'Envio anterior com resultado incerto'}],previewToken:'signed-but-blocked',manualCampaignSelection:p.manualCampaignSelection,text:item.text});
 await f.action('manual-item-preview','op-1',{campaignId:'camp-a',itemId:'raw-1'});assert.match(f.modals.at(-1)[3],/resultado incerto/);await assert.rejects(f.action('confirm-send','op-1'),/não está válida/);assert.equal(f.calls.some(c=>c.action==='opportunitySendManual'),false);
});
test('queue distinguishes transport wait, preparation, uncertainty and a traceable failure without claiming delivery',async()=>{
 const f=fixture();f.data.opportunities.queueState={connected:true,busy:true,stage:'waiting-transport',transport:{waitingPrivate:1,reason:'Aguardando a mensagem em andamento.'},activeTask:{id:'task-active'},lastError:{code:'WA_RECIPIENT_MISMATCH',reason:'Identidade não corresponde ao destino',traceId:'trace-local'}};await f.ui.load();let html=f.ui.render();assert.match(html,/Aguardando transporte compartilhado/);assert.match(html,/WA_RECIPIENT_MISMATCH/);assert.match(html,/trace-local/);assert.doesNotMatch(html,/Enviando uma resposta/);
 f.data.opportunities.queueState={connected:true,busy:false};await f.ui.load();html=f.ui.render();assert.match(html,/Resultados incertos precisam de revisão/);assert.match(html,/Nenhum envio incerto será repetido automaticamente/);
});
test('closing the chooser prevents a delayed raw preview from reopening or sending',async()=>{
 const f=manualFixture();let release;f.handlers.opportunityPreview=p=>new Promise(resolve=>{release=()=>resolve({canSend:true,previewToken:'delayed',manualCampaignSelection:p.manualCampaignSelection,text:item.text});});await f.ui.load();await f.action('choose-campaign','op-1');const pending=f.action('manual-item-preview','op-1',{campaignId:'camp-a',itemId:'raw-1'});await new Promise(resolve=>setImmediate(resolve));await f.action('close-modal');const count=f.modals.length;release();await pending;assert.equal(f.modals.length,count);assert.equal(f.calls.some(c=>c.action==='opportunitySendManual'),false);
});

test('catalog expansion survives backend redraws and ignores detached stale toggle events',async()=>{
 const f=fixture();await f.ui.load();assert.doesNotMatch(f.ui.render(),/<details class="opportunity-catalog" open/);
 const live={isConnected:true,open:true,classList:{contains:name=>name==='opportunity-catalog'}};f.ui.onToggle(live);
 await f.ui.load();assert.match(f.ui.render(),/<details class="opportunity-catalog" open/);
 f.ui.onToggle({...live,isConnected:false,open:false});assert.match(f.ui.render(),/<details class="opportunity-catalog" open/);
 f.ui.onToggle({...live,open:false});await f.ui.load();assert.doesNotMatch(f.ui.render(),/<details class="opportunity-catalog" open/);
 f.ui.onToggle(live);f.ui.reset();assert.doesNotMatch(f.ui.render(),/<details class="opportunity-catalog" open/);
});
