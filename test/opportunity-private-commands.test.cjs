'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { OpportunityPrivateCommands, COMMAND_WINDOW, HELP } = require('../src/core/opportunity-private-commands.cjs');
const clone = value => structuredClone(value);
const ADMIN = '5511999999999', OTHER = '5511888888888';
function fixture(previous) {
  const data = previous || { settings: {}, diagnostics: [], actions: [], replies: [], clock: Date.parse('2026-10-23T12:00:00Z'), mode: 'whatsapp' };
  const store = { getStorageMode: () => data.mode, getSetting: (key, fallback) => clone(data.settings[key] ?? fallback), setSetting: (key, value) => { data.settings[key] = clone(value); }, addDiagnostic: entry => data.diagnostics.push(clone(entry)), addOpportunityTrace() {}, isOutboundMessageId: id => id === 'AUTO-ECHO' };
  const adapter = new EventEmitter(); adapter.status = { mode: data.mode }; adapter.isTrustedSelfContext = context => context.selfChat && context.trustedSelf;
  const cfg = { adminPhone: ADMIN, adminActorId: 'owner-1', automatic: true, ownerId: 'owner-1' };
  const auth = { resolveWhatsAppActor: context => ({ user: { id: context.senderNumber === ADMIN ? 'owner-1' : 'owner-2' } }), canFor: () => true };
  let sequence = 0;
  const workflow = { config: () => clone(cfg), async setAutomatic(value, actor) { cfg.automatic = value; data.actions.push(['automatic', value, actor]); }, async approve(id, actor) { data.actions.push(['approve', id, actor]); }, async reject(id, actor) { data.actions.push(['reject', id, actor]); }, async pause(actor) { data.actions.push(['pause', actor]); return { inFlight: 1 }; }, status: () => ({ automatic: cfg.automatic, queued: 2, awaitingApproval: 1, uncertain: 1, failed: 3 }) };
  adapter.reply = async (chatId, text, options) => { options?.beforeSubmit?.(); const result = { status: 'confirmed', messageId: options.clientMessageId, confirmationScope: 'whatsapp-server' }; data.replies.push({ chatId, text, options: { clientMessageId: options.clientMessageId }, result }); return result; };
  const controller = new OpportunityPrivateCommands({ store, adapter, authService: auth, workflow, now: () => data.clock });
  const context = (text, patch = {}) => ({ messageId: `PRIVATE-${++sequence}`, senderNumber: ADMIN, senderId: `${ADMIN}@s.whatsapp.net`, verified: true, forwarded: false, isGroup: false, fromMe: false, chatId: `${ADMIN}@s.whatsapp.net`, type: 'text', text, timestamp: data.clock, ...patch });
  return { data, store, adapter, cfg, auth, workflow, controller, context, send: (text, patch) => controller.handle(context(text, patch)), entries: () => store.getSetting(`opportunityControlCommands:${data.mode}`, []), latest: () => data.replies.at(-1)?.text || '' };
}

test('comandos privados usam somente administrador configurado e executam ações exatas', async () => {
  const f = fixture();
  for (const text of ['!automatico off', '!automatico on', '!aprovar OP-123', '!recusar OP-124', '!pausar', '!status', '!ajuda']) assert.equal(await f.send(text), true);
  assert.deepEqual(f.data.actions, [['automatic', false, 'owner-1'], ['automatic', true, 'owner-1'], ['approve', 'OP-123', 'owner-1'], ['reject', 'OP-124', 'owner-1'], ['pause', 'owner-1']]);
  assert.equal(f.data.replies.length, 7); assert.ok(f.data.replies.every(reply => reply.chatId === `${ADMIN}@s.whatsapp.net`));
  assert.match(f.data.replies[2].text, /registrada/); assert.doesNotMatch(f.data.replies[2].text, /entregue/i);
  assert.match(f.data.replies[4].text, /não ser cancelável/);
  assert.match(f.data.replies[5].text, /Na fila: 2/); assert.match(f.data.replies[5].text, /Resultados incertos: 1/);
  assert.equal(f.latest(), HELP);
  assert.ok(f.entries().every(entry => entry.status === 'completed' && entry.replies[0].status === 'accepted'));
});

test('autorizações são centrais: rejeita outro número, nome igual, ambiguidade, baixa permissão e chat incompatível', async () => {
  const cases = [
    { senderNumber: OTHER, chatId: `${OTHER}@s.whatsapp.net`, profileName: 'Dono' },
    { verified: false }, { identityAmbiguous: true }, { isGroup: true, chatId: '123@g.us' },
    { forwarded: true }, { forwarded: undefined }, { forwardingScore: 1 }, { history: true }, { historical: true }, { isHistory: true },
    { fromMe: true }, { fromMe: undefined }, { automaticMessage: true }, { machineGenerated: true }, { automated: true }, { messageId: 'AUTO-ECHO' },
    { chatId: `${OTHER}@s.whatsapp.net` }, { senderNumber: 'interno@lid', chatId: '123@lid' }
  ];
  for (const patch of cases) { const f = fixture(); assert.equal(await f.send('!automatico on', patch), false, JSON.stringify(patch)); assert.equal(f.data.actions.length, 0); assert.equal(f.data.replies.length, 0); }
  for (const modify of [f => { f.auth.resolveWhatsAppActor = () => ({ user: null, code: 'WA_AUTH_AMBIGUOUS' }); }, f => { f.auth.resolveWhatsAppActor = () => ({ user: { id: 'someone-else' } }); }, f => { f.auth.canFor = () => false; }, f => { f.cfg.adminPhone = ''; }, f => { f.cfg.adminActorId = 'someone-else'; }, f => { f.auth.resolveWhatsAppActor = () => { throw new Error('storage'); }; }]) {
    const f = fixture(); modify(f); assert.equal(await f.send('!aprovar X'), false); assert.equal(f.data.actions.length, 0); assert.equal(f.data.replies.length, 0);
  }
});

test('LID é aceito somente como chat de identidade confirmada, nunca convertido em telefone', async () => {
  const f = fixture(); assert.equal(await f.send('!status', { chatId: '123456789@lid', senderIds: ['123456789@lid', `${ADMIN}@s.whatsapp.net`] }), true);
  assert.equal(f.data.replies[0].chatId, '123456789@lid');
  assert.equal(await f.send('!status', { chatId: '123456789@lid', senderNumber: '' }), false);
});

test('comando manual do próprio número exige conversa consigo mesmo e prova do adaptador', async () => {
  const f = fixture(); assert.equal(await f.send('!ajuda', { fromMe: true, trustedSelf: true, selfChat: true }), true);
  f.adapter.isTrustedSelfContext = () => false;
  assert.equal(await f.send('!status', { fromMe: true, trustedSelf: true, selfChat: true }), false);
});

test('eventos duplicados simultâneos e reinicialização não repetem aprovação ou resposta', async () => {
  const f = fixture(); const context = f.context('!aprovar OP-9');
  await Promise.all([f.controller.handle(context), f.controller.handle(context)]);
  assert.equal(f.data.actions.length, 1); assert.equal(f.data.replies.length, 1);
  f.controller.close(); const again = fixture(f.data);
  assert.equal(await again.controller.handle(context), false); assert.equal(again.data.actions.length, 1); assert.equal(again.data.replies.length, 1);
});

test('comando sem ID, inválido ou fora da janela não executa ação nem interpreta texto solto', async () => {
  const f = fixture();
  for (const text of ['!automatico yes', '!aprovar', '!recusar', '!pausar outra', '!status mais']) { assert.equal(await f.send(text), true); assert.match(f.latest(), /Comando inválido/); }
  assert.equal(f.data.actions.length, 0);
  assert.equal(await f.send('!mega ajuda'), false); assert.equal(await f.send('aprovar OP-1'), false);
  assert.equal(await f.send('!automatico on', { timestamp: f.data.clock - COMMAND_WINDOW - 1 }), false);
  assert.equal(await f.send('!automatico on', { messageId: '' }), false);
});

test('revalida permissões quando o comando espera e antes do envio', async () => {
  const f = fixture(); let release;
  f.workflow.approve = async () => { await new Promise(resolve => { release = resolve; }); };
  const first = f.send('!aprovar A'); await new Promise(resolve => setImmediate(resolve));
  const second = f.send('!automatico off'); f.auth.canFor = () => false; release();
  await Promise.all([first, second]);
  assert.equal(f.data.actions.length, 0); assert.equal(f.data.replies.length, 0);
  assert.equal(f.entries()[0].replies[0].status, 'failed');
});

test('parada privada não aguarda a fila de uma aprovação lenta', async () => {
  const f = fixture(); let release;
  f.workflow.approve = async () => { await new Promise(resolve => { release = resolve; }); };
  const approval = f.send('!aprovar A'); await new Promise(resolve => setImmediate(resolve));
  await f.send('!pausar'); assert.equal(f.data.actions[0][0], 'pause'); release(); await approval;
});

test('resultado aceito não é tratado como entregue; recibo tardio atualiza sem novo envio', async () => {
  const f = fixture(); await f.send('!status');
  const entry = f.entries()[0]; assert.equal(entry.replies[0].status, 'accepted');
  f.adapter.emit('receipt', { messageId: entry.replies[0].clientMessageId, status: 'delivered', confirmationScope: 'whatsapp-delivered', mode: 'whatsapp' });
  assert.equal(f.entries()[0].replies[0].status, 'delivered'); assert.equal(f.data.replies.length, 1);
  f.adapter.emit('receipt', { messageId: entry.replies[0].clientMessageId, status: 'confirmed', confirmationScope: 'whatsapp-server' });
  assert.equal(f.entries()[0].replies[0].status, 'delivered');
});

test('falha depois da submissão é incerta e nunca gera nova resposta por conta própria', async () => {
  const f = fixture(); f.adapter.reply = async () => { throw new Error('socket fechado'); };
  const context = f.context('!automatico off'); assert.equal(await f.controller.handle(context), true);
  assert.equal(f.entries()[0].replies[0].status, 'uncertain'); assert.equal(f.data.actions.length, 1);
  assert.equal(await f.controller.handle(context), false); assert.equal(f.data.actions.length, 1);
  f.controller.close(); const again = fixture(f.data); assert.equal(await again.controller.handle(context), false);
});

test('resposta sem comprovante não declara sucesso e falha comprovada pré-envio é falha', async () => {
  const f = fixture(); f.adapter.reply = async () => ({ status: 'confirmed' }); await f.send('!status'); assert.equal(f.entries()[0].replies[0].status, 'uncertain');
  const g = fixture(); g.adapter.reply = async () => { throw Object.assign(new Error('não conectado'), { submitted: false, definitive: true }); };
  await g.send('!status'); assert.equal(g.entries()[0].replies[0].status, 'failed');
});

test('recuperação interrompida conserva bloqueio e não retransmite respostas em estado incerto', async () => {
  const f = fixture(); const key = 'opportunityControlCommands:whatsapp';
  f.store.setSetting(key, [{ id: `${ADMIN}:INTERRUPTED`, at: f.data.clock, status: 'processing', replies: [{ clientMessageId: 'SENDING', status: 'processing' }, { clientMessageId: 'WAITING', status: 'pending' }] }]);
  f.controller.close(); const g = fixture(f.data); const entry = g.entries()[0];
  assert.equal(entry.status, 'interrupted'); assert.equal(entry.replies[0].status, 'uncertain'); assert.equal(entry.replies[1].status, 'cancelled');
  assert.equal(g.data.replies.length, 0); assert.equal(g.data.actions.length, 0);
});

test('parada requer controle administrativo e licença expirada bloqueia inclusive comandos', async () => {
  const f = fixture(); f.auth.canFor = (_user, permission) => permission !== 'automation.control'; assert.equal(await f.send('!pausar'), false);
  assert.equal(await f.send('!automatico on'), false); assert.equal(await f.send('!automatico off'), false);
  assert.equal(await f.send('!status'), true);
  f.data.replies.length = 0;
  f.controller.licenseGuard = () => { throw new Error('Licença expirada'); };
  assert.equal(await f.send('!status'), false); assert.equal(f.data.actions.length, 0); assert.equal(f.data.replies.length, 0);
});

test('erro de operação é explicado sem credenciais e não é anunciado como concluído', async () => {
  const f = fixture(); f.workflow.approve = async () => { throw Object.assign(new Error('Oferta removida\ntoken=SEGREDO'), { code: 'REMOVED' }); };
  await f.send('!aprovar A'); assert.match(f.latest(), /Não foi possível/); assert.match(f.latest(), /Oferta removida/);
  assert.doesNotMatch(JSON.stringify(f.data), /SEGREDO/); assert.equal(f.entries()[0].status, 'failed');
});

test('troca de modo durante submissão não escreve resultado no novo modo ou envia novas partes', async () => {
  const f = fixture(); let release;
  f.adapter.reply = async () => { await new Promise(resolve => { release = resolve; }); return { status: 'confirmed', messageId: 'PREVIOUS' }; };
  const send = f.send('!status'); await new Promise(resolve => setImmediate(resolve));
  f.data.mode = 'simulated'; const adapter = new EventEmitter(); adapter.status = { mode: 'simulated' }; f.controller.setAdapter(adapter); release();
  await send; assert.equal(f.entries().length, 0); assert.equal(f.store.getSetting('opportunityControlCommands:whatsapp', [])[0].replies[0].status, 'processing');
});

test('hook central de resposta recebe destino original, client ID e guarda de autorização', async () => {
  const f = fixture(); let received;
  f.controller.sendAdminReply = async (ctx, text, options) => { received = { ctx, text, options }; options.beforeSubmit(); return { status: 'accepted', messageId: options.clientMessageId }; };
  await f.send('!ajuda'); assert.equal(received.ctx.chatId, `${ADMIN}@s.whatsapp.net`); assert.equal(received.options.userId, 'owner-1'); assert.ok(received.options.clientMessageId); assert.equal(received.options.manual, true); assert.equal(f.entries()[0].replies[0].status, 'accepted');
});


test('timeout ou marcador genérico definitivo após invocação continuam incertos sem prova de não submissão', async () => {
  for (const extra of [{ code: 'TIMEOUT' }, { code: 'TRANSPORT_ERROR', definitive: true }]) {
    const f = fixture(); f.adapter.reply = async () => { throw Object.assign(new Error('Prazo esgotado durante a submissão'), extra); };
    const context = f.context('!status'); await f.controller.handle(context); assert.equal(f.entries()[0].replies[0].status, 'uncertain');
    await f.controller.handle(context); assert.equal(f.entries()[0].replies.length, 1);
  }
});


test('integração com AuthService real recusa colisão de telefone, JID divergente e usuário desativado', async () => {
  const { AuthService } = require('../src/core/auth.cjs');
  const f = fixture(), tables = new Map();
  const table = name => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name); };
  Object.assign(f.store, { getEntity: (name, id) => clone(table(name).get(id)), listEntities: name => [...table(name).values()].map(clone), saveEntity(name, value) { table(name).set(value.id, clone(value)); return clone(value); }, addAudit() {}, transaction: fn => fn(), listCampaigns: () => [] });
  const auth = new AuthService({ store: f.store });
  f.store.saveEntity('users', { id: 'owner-1', name: 'Dono', phone: ADMIN, roleId: 'role-owner', active: true, authorizedPhones: [] });
  f.controller.authService = auth;
  assert.equal(await f.send('!status'), true);
  assert.equal(await f.send('!automatico on', { senderIds: [`${OTHER}@s.whatsapp.net`] }), false);
  f.store.saveEntity('users', { id: 'duplicate', name: 'Dono', phone: ADMIN, roleId: 'role-admin', active: true });
  assert.equal(await f.send('!automatico on'), false);
  f.store.saveEntity('users', { id: 'duplicate', phone: OTHER, roleId: 'role-admin', active: true });
  f.store.saveEntity('users', { id: 'owner-1', name: 'Dono', phone: ADMIN, roleId: 'role-owner', active: false });
  assert.equal(await f.send('!automatico on'), false);
  assert.equal(f.data.actions.length, 0);
  assert.equal(f.data.replies.length, 1);
});
