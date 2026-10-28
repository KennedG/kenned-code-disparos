'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture({ permissions = ['*'], mode = 'whatsapp', confirm = true } = {}) {
  const config = { campaignDestinations: true, adminPhone: '5562999990001', mode: 'automatic', enabled: true, evaluation: false, automatic: true, monitoredGroupIds: ['real-a@g.us'], campaignIds: ['camp-a'], repeatHours: 24, contactIntervalMinutes: 30, maxPerDay: 3, validityMinutes: 120, availabilityMaxAgeMinutes: 120, automaticOfferLimit: 1, multiModelMax: 5, priority: 'cashAscending', timezone: 'America/Sao_Paulo', sound: { enabled: true, volume: 70, durationSeconds: 3, minIntervalSeconds: 60, burstSeconds: 5, quiet: { enabled: false, start: '22:00', end: '08:00' } } };
  const original = '📱 iPhone 13 Pro 256GB quem tem?\nCor: Azul';
  const op = { id: 'op-1', summary: 'iPhone 13 Pro • 256GB', senderId: '5562999990001@s.whatsapp.net', senderPhone: '5562999990001', senderName: 'Perfil real', status: 'open', originalAt: Date.UTC(2026, 9, 8, 12), expiresAt: Date.UTC(2026, 9, 8, 14), originCount: 3, groupCount: 2, blockers: [{ code: 'EVALUATION_MODE' }] };
  const offer = { offerId: 'offer-1', model: 'iPhone 13 Pro', storageGB: 256, color: 'Azul', condition: 'Seminovo', priceCents: 300000, caption: '📱 iPhone 13 Pro 256GB\nR$ 3.000,00\nObservação original', campaignId: 'camp-a', originalMessageId: 'original-offer', quantity: 1, availabilityConfirmedAt: Date.UTC(2026, 9, 8, 12), eligible: true };
  const second = { ...offer, offerId: 'offer-2', priceCents: 320000, originalMessageId: 'other-original', sentBefore: true, updatedSinceSent: true };
  const detail = { opportunity: op, candidates: [offer, second], origins: [{ messageId: 'message-1', groupId: 'real-a@g.us', originalAt: op.originalAt, text: original }, { messageId: 'message-2', groupId: 'real-b@g.us', originalAt: op.originalAt + 100, text: 'Alguém tem 13 pro 256?' }], tasks: [{ id: 'task-uncertain', status: 'uncertain', messageId: 'possibly-sent', error: 'Sem confirmação da integração', createdAt: op.originalAt }, { id: 'task-accepted', status: 'accepted', createdAt: op.originalAt }, { id: 'task-delivered', status: 'delivered', resultAt: op.originalAt + 500 }] };
  const data = { storageMode: mode, campaigns: [{ id: 'camp-a', name: 'Lista real da loja', groupIds: ['real-b@g.us'] }], opportunities: { config, metrics: { total: 1, open: 1, accepted: 1, delivered: 1, uncertain: 1 }, monitor: { lastMessageAt: op.originalAt } } };
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
    opportunityDispatch: () => ({ok:true,status:'queued'}), opportunityWorkflowAction: () => ({ok:true}), opportunitySendManual: () => ({ status: 'queued' }), opportunityAction: () => ({ recorded: true }), opportunityConfirmAvailability: () => ({ confirmed: true }), opportunityReconcile: () => ({ status: 'uncertain' }), opportunityRetryUncertain: () => ({ status: 'queued' }), opportunityEvaluate: () => ({ evaluated: 1 })
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

const rawItem={campaignId:'camp-a',itemId:'raw-image',campaignName:'Lista real da loja',type:'image',mediaId:'managed-photo',text:'📱 iPhone 12 Pro\nDetalhe na tela pequeno 😊\nAssinatura original',manualEligible:true};
function setup(options){const f=fixture(options);f.handlers.opportunityCampaignItemsPage=p=>({items:[{...rawItem}],total:1,offset:p.offset,limit:p.limit});f.detail.workflow={id:'batch-1',opportunityId:f.op.id,status:'awaiting_approval',selection:{campaignId:'camp-a',itemId:'raw-image'},jobs:[{id:'send-1',status:'queued',recipient:'real-b@g.us',kind:'campaign-item',createdAt:f.op.originalAt},{id:'notice-1',kind:'admin-notice',status:'accepted',recipient:'5562999990001',createdAt:f.op.originalAt,messageId:'accepted-notice'}]};return f;}

test('production opportunities show automatic workflow, configured admin and campaign destinations without stock or AI controls',async()=>{
 const f=setup();await f.ui.load();const html=f.ui.render();
 assert.match(html,/Automático — sem aprovação por oportunidade/);assert.match(html,/5562999990001/);assert.match(html,/1 destino\(s\): Grupo real B/);assert.match(html,/Regras fixas · Sem IA/);
 assert.match(html,/!automatico on/);assert.match(html,/!aprovar ID/);assert.doesNotMatch(html,/Exigir confirmação manual recente|Regra avançada de disponibilidade|name="availabilityMode"|AVALIAÇÃO — SEM ENVIO/);
 assert.doesNotMatch(html,/FICTÍCIO DE TESTE/);assert.match(html,/fila não significa enviado/);
});

test('raw campaign item without price goes directly to campaign dispatch, preserving caption and without preview or confirmation',async()=>{
 const f=setup();await f.ui.load();await f.action('choose-campaign','op-1');const chooser=f.modals.at(-1);
 assert.equal(chooser[0],'opportunity-campaign-chooser');assert.match(chooser[3],/Detalhe na tela pequeno 😊/);assert.match(chooser[3],/Selecionar e enviar/);assert.match(chooser[3],/Grupo real B/);assert.doesNotMatch(chooser[3],/previewToken|Conferir prévia|Ainda disponível/);
 await f.action('manual-item-send','op-1',{campaignId:'camp-a',itemId:'raw-image'});
 const calls=f.calls.filter(c=>c.action==='opportunityDispatch');assert.equal(calls.length,1);assert.deepEqual(calls[0].payload,{opportunityId:'op-1',campaignId:'camp-a',itemId:'raw-image'});
 assert.equal(f.calls.some(c=>c.action==='opportunityPreview'||c.action==='opportunitySendManual'),false);assert.equal(f.confirmations.length,0);assert.match(f.toasts.at(-1)[0],/fila ainda não confirma envio/);
});

test('automatic off preserves manual direct authorization while newly detected opportunities have explicit approve and reject',async()=>{
 const f=setup();f.data.opportunities.config.automatic=false;f.data.opportunities.config.mode='manual';await f.ui.load();assert.match(f.ui.render(),/Somente avisar — aguardando sua decisão/);
 await f.action('choose-campaign','op-1');assert.match(f.modals.at(-1)[3],/inclusive no modo “Somente avisar”/);await f.action('manual-item-send','op-1',{campaignId:'camp-a',itemId:'raw-image'});
 assert.equal(f.calls.filter(c=>c.action==='opportunityDispatch').length,1);await f.action('approve','op-1');await f.action('reject','op-1');
 assert.deepEqual(f.calls.filter(c=>c.action==='opportunityWorkflowAction').map(c=>c.payload),[{id:'op-1',action:'approve'},{id:'op-1',action:'reject'}]);assert.equal(f.confirmations.length,0);
});

test('missing admin is visible and missing campaign destinations never produce a dispatch',async()=>{
 const f=setup();f.data.opportunities.config.adminPhone='';f.data.campaigns[0].groupIds=[];await f.ui.load();assert.match(f.ui.render(),/Configure um administrador autorizado/);
 await f.action('choose-campaign','op-1');const chooser=f.modals.at(-1)[3];assert.match(chooser,/Sem destinos cadastrados/);assert.match(chooser,/data-action="opportunity-manual-item-send"[^>]*disabled/);
 await assert.rejects(f.action('manual-item-send','op-1',{campaignId:'camp-a',itemId:'raw-image'}),/não possui destinos/);assert.equal(f.calls.some(c=>c.action==='opportunityDispatch'),false);
});

test('read-only users cannot dispatch, approve, reject or pause through direct actions',async()=>{
 const f=setup({permissions:['opportunity.view']});await f.ui.load();assert.doesNotMatch(f.ui.render(),/data-action="opportunity-campaign-send"|data-action="opportunity-pause-workflow"/);
 for(const action of ['manual-item-send','approve','reject','pause-workflow'])await assert.rejects(f.action(action,'op-1',{campaignId:'camp-a',itemId:'raw-image'}),/Sem permissão/);
 assert.equal(f.calls.some(c=>c.action==='opportunityDispatch'||c.action==='opportunityWorkflowAction'),false);
});

test('backend dispatch rejection stays visible as failure and never produces a success toast',async()=>{
 const f=setup();f.handlers.opportunityDispatch=()=>({ok:false,error:'Destino indisponível na campanha'});await f.ui.load();await f.action('choose-campaign','op-1');
 await assert.rejects(f.action('manual-item-send','op-1',{campaignId:'camp-a',itemId:'raw-image'}),/Destino indisponível/);assert.equal(f.toasts.length,0);
});

test('repeated explicit selection clicks enqueue a single backend dispatch while processing',async()=>{
 const f=setup();let release;f.handlers.opportunityDispatch=()=>new Promise(resolve=>release=resolve);await f.ui.load();await f.action('choose-campaign','op-1');
 const first=f.action('manual-item-send','op-1',{campaignId:'camp-a',itemId:'raw-image'});const second=f.action('manual-item-send','op-1',{campaignId:'camp-a',itemId:'raw-image'});await second;
 assert.equal(f.calls.filter(c=>c.action==='opportunityDispatch').length,1);release({ok:true,status:'queued'});await first;assert.equal(f.confirmations.length,0);
});

test('workflow settings persist admin, automatic choice and campaign-only routing without an activation confirmation',async()=>{
 const f=setup();await f.ui.load();const form=f.configForm('manual');form.elements.adminPhone={value:'5562999990001'};await f.ui.onSubmit(form);
 const saved=f.calls.find(c=>c.action==='opportunityConfigSave').payload.config;assert.equal(saved.adminPhone,'5562999990001');assert.equal(saved.campaignDestinations,true);assert.equal(saved.mode,'manual');assert.equal(saved.automatic,false);assert.equal(saved.evaluation,false);assert.equal(saved.availabilityMode,'campaign');assert.equal(saved.automaticOfferLimit,1);assert.equal(f.confirmations.length,0);
});

test('new workflow statuses trigger refresh and detail differentiates accepted notice from queued campaign message',async()=>{
 const f=setup();f.data.opportunities.workflow={updatedAt:1000,counts:{queued:1}};await f.ui.load();await f.action('detail','op-1');const html=f.modals.at(-1)[3];
 assert.match(html,/Aguardando envio/);assert.match(html,/Envio aceito pela integração/);assert.match(html,/Aviso ao administrador/);assert.match(html,/real-b@g.us/);assert.doesNotMatch(html,/O destinatário é o interessado/);
 const before=f.calls.length;f.data.opportunities.workflow={updatedAt:2000,counts:{accepted:1}};await f.ui.maybeLoad();assert.equal(f.calls.length,before+2);
});

test('stale legacy preview actions cannot send to interested person after campaign workflow becomes active',async()=>{
 const f=setup();await f.ui.load();await assert.rejects(f.action('confirm-send','op-1'),/prévia antiga/);await assert.rejects(f.action('preview','op-1'),/destinos cadastrados/);assert.equal(f.calls.some(c=>c.action==='opportunitySendManual'),false);
});
