'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CommandController, SESSION_TTL, CONFIRM_TTL } = require('../src/core/commands.cjs');

const copy = value => JSON.parse(JSON.stringify(value));
function fixture(sharedStore) {
  const clock = { now: Date.parse('2026-10-01T12:00:00Z') };
  const data = { settings: { admins: ['5511999999999'], maxSelectedGroups: 15 }, campaigns: [], groups: [
    { id: 'group-1@g.us', name: 'Grupo autorizado 1', authorized: true, simulation: true },
    { id: 'group-2@g.us', name: 'Grupo autorizado 2', authorized: true, simulation: true },
    { id: 'group-3@g.us', name: 'Grupo não autorizado', authorized: false, simulation: true },
    { id: 'real@g.us', name: 'Grupo real', authorized: true, simulation: false }
  ], media: [], jobs: [] };
  const store = sharedStore || {
    getSetting: (key, fallback) => data.settings[key] ?? fallback,
    setSetting: (key, value) => { data.settings[key] = copy(value); },
    listCampaigns: () => copy(data.campaigns),
    getCampaign: id => { const item = data.campaigns.find(campaign => campaign.id === id); return item ? copy(item) : null; },
    saveCampaign: campaign => {
      const previous = data.campaigns.find(item => item.id === campaign.id);
      const value = { ...copy(campaign), revision: (previous?.revision || 0) + 1 };
      data.campaigns = [...data.campaigns.filter(item => item.id !== campaign.id), value];
      return copy(value);
    },
    listGroups: () => copy(data.groups),
    getGroup: id => { const group = data.groups.find(item => item.id === id); return group ? copy(group) : null; },
    getMedia: id => data.media.find(item => item.id === id),
    listJobs: ({ campaignId, limit }) => copy(data.jobs.filter(item => item.campaignId === campaignId).slice(0, limit))
  };
  const replies = [];
  const calls = [];
  let downloads = 0;
  let imports = 0;
  const adapter = {
    status: { mode: 'simulated', state: 'connected' },
    reply: async (chatId, text) => { replies.push({ chatId, text }); },
    downloadIncoming: async () => {
      downloads++;
      return { buffer: Buffer.from('test'), name: 'imagem.jpg', mime: 'image/jpeg', type: 'image' };
    }
  };
  const scheduler = {
    async activate(id) { calls.push(['activate', id]); const campaign = store.getCampaign(id); store.saveCampaign({ ...campaign, state: 'active' }); },
    async resume(id) { calls.push(['resume', id]); const campaign = store.getCampaign(id); store.saveCampaign({ ...campaign, state: 'active' }); },
    async pause(id) { calls.push(['pause', id]); const campaign = store.getCampaign(id); store.saveCampaign({ ...campaign, state: 'paused' }); },
    async stopAll() { calls.push(['stopAll']); for (const campaign of store.listCampaigns()) store.saveCampaign({ ...campaign, state: 'stopped' }); },
    getSummary: id => `Resumo ${id}`
  };
  const mediaManager = {
    importBuffer: async (_buffer, metadata) => {
      imports++;
      const media = { id: `media-${imports}`, ...metadata, path: `/managed/media-${imports}`, size: 4 };
      data.media.push(media);
      return media;
    }
  };
  const controller = new CommandController({ store, scheduler, adapter, mediaManager, now: () => clock.now });
  let sequence = 0;
  const context = (text, patch = {}) => ({
    messageId: `message-${++sequence}`, senderNumber: '5511999999999', verified: true,
    isGroup: false, forwarded: false, fromMe: false, chatId: '5511999999999@s.whatsapp.net',
    text, type: 'text', timestamp: clock.now, ...patch
  });
  const send = (text, patch) => controller.handle(context(text, patch));
  const campaign = (id = 'campaign-1', patch = {}) => {
    const value = {
      id, name: 'Campanha de teste', state: 'draft', mode: 'repeat', intervalMinutes: 10, spacingSeconds: 5,
      schedule: { days: [0, 1, 2, 3, 4, 5, 6], startTime: '08:00', endTime: '18:00', startDate: '', endDate: '' },
      dailyRoundLimit: 0, dailySendLimit: 0, groupIds: ['group-1@g.us'],
      items: [{ id: 'item-1', type: 'text', text: 'Olá 👋\n*Mensagem* https://exemplo.com', mediaId: null, caption: '' }],
      groupOverrides: {}, nextRunAt: null, roundIndex: 0, ...patch
    };
    store.saveCampaign(value);
    return store.getCampaign(id);
  };
  const latest = () => replies.at(-1)?.text || '';
  const token = () => latest().match(/!mega confirmar ([a-f0-9]{8})/)?.[1];
  return { controller, store, adapter, scheduler, clock, replies, calls, context, send, campaign, latest, token,
    get downloads() { return downloads; }, get imports() { return imports; } };
}

test('somente administradores autenticados em conversa direta podem comandar', async () => {
  const f = fixture();
  f.campaign();
  const invalid = [
    { senderNumber: '5511888888888', chatId: '5511888888888@s.whatsapp.net' },
    { verified: false }, { isGroup: true, chatId: 'group-1@g.us' }, { forwarded: true }, { fromMe: true },
    { chatId: '5511777777777@s.whatsapp.net' }, { senderNumber: '5511999999999 spoofed' },
    { timestamp: f.clock.now - 5 * 60_000 - 1 }, { timestamp: f.clock.now + 60_001 },
    { timestamp: undefined }, { messageId: '' }, { isGroup: undefined }, { forwarded: undefined },
    { historical: true }, { history: true }, { isHistory: true }
  ];
  for (const patch of invalid) await f.send('!mega pausar campaign-1', patch);
  assert.equal(f.calls.length, 0);
  assert.equal(f.replies.length, 0);
  await f.send('texto encaminhado contendo !mega pausar campaign-1');
  assert.equal(f.calls.length, 0);
  await f.send('!mega pausar campaign-1');
  assert.deepEqual(f.calls, [['pause', 'campaign-1']]);
  assert.match(f.latest(), /pausada/);
});

test('telefone real verificado suporta LID; mensagens não verificadas e número LID não autenticam', async () => {
  const f = fixture();
  await f.send('!mega status', { chatId: '123456789@lid' });
  assert.match(f.latest(), /Conexão/);
  const count = f.replies.length;
  await f.send('!mega status', { chatId: '123456789@lid', verified: false });
  await f.send('!mega status', { senderNumber: '123456789', chatId: '123456789@lid' });
  assert.equal(f.replies.length, count);
});

test('comando repetido não é processado novamente, inclusive após recriar controlador', async () => {
  const f = fixture();
  f.campaign();
  const message = f.context('!mega pausar campaign-1', { timestamp: Math.floor(f.clock.now / 1000) });
  await Promise.all([f.controller.handle(message), f.controller.handle(message)]);
  assert.equal(f.calls.length, 1);
  const restarted = new CommandController({ store: f.store, scheduler: f.scheduler, adapter: f.adapter, now: () => f.clock.now });
  await restarted.handle(message);
  assert.equal(f.calls.length, 1);
});

test('sem administradores configurados os comandos permanecem desabilitados', async () => {
  const f = fixture();
  f.store.setSetting('admins', []);
  await f.send('!mega criar teste');
  assert.deepEqual(f.store.listCampaigns(), []);
  assert.deepEqual(f.replies, []);
});

test('criar e editar campanhas não as ativa e preserva texto/legendas', async () => {
  const f = fixture();
  await f.send('!mega criar Promoções');
  const created = f.store.listCampaigns()[0];
  assert.equal(created.state, 'draft');
  assert.equal(created.intervalMinutes, 10);
  await f.send('5');
  const text = '  Olá 👋\n*Oferta*\nhttps://exemplo.com  ';
  await f.send(text);
  const updated = f.store.getCampaign(created.id);
  assert.equal(updated.items[0].text, text);
  assert.equal(updated.state, 'draft');
  assert.equal(f.calls.length, 0);
});

test('ativação exige resumo e confirmação de uso único', async () => {
  const f = fixture();
  f.campaign();
  await f.send('!mega ativar campaign-1');
  assert.equal(f.calls.length, 0);
  assert.match(f.latest(), /Intervalo entre inícios de rodadas: 10 min/);
  assert.match(f.latest(), /Grupo autorizado 1/);
  const token = f.token();
  assert.ok(token);
  await f.send(`!mega confirmar ${token}`);
  assert.deepEqual(f.calls, [['activate', 'campaign-1']]);
  await f.send(`!mega confirmar ${token}`);
  assert.equal(f.calls.length, 1);
  assert.match(f.latest(), /inválida ou expirada/);
});

test('confirmação expirada, cancelada ou de revisão antiga nunca ativa', async () => {
  const f = fixture();
  const campaign = f.campaign();
  await f.send('!mega ativar campaign-1');
  const stale = f.token();
  f.store.saveCampaign({ ...campaign, name: 'Revisada' });
  await f.send(`!mega confirmar ${stale}`);
  assert.match(f.latest(), /mudou desde o resumo/);
  await f.send('!mega ativar campaign-1');
  const expired = f.token();
  f.clock.now += CONFIRM_TTL + 1;
  await f.send(`!mega confirmar ${expired}`);
  assert.match(f.latest(), /inválida ou expirada/);
  await f.send('!mega ativar campaign-1');
  const cancelled = f.token();
  await f.send('!mega cancelar');
  await f.send(`!mega confirmar ${cancelled}`);
  assert.equal(f.calls.length, 0);
});

test('confirmação pertence ao administrador que recebeu o resumo', async () => {
  const f = fixture();
  f.store.setSetting('admins', ['5511999999999', '5511888888888']);
  f.campaign();
  await f.send('!mega ativar campaign-1');
  const token = f.token();
  await f.send(`!mega confirmar ${token}`, { senderNumber: '5511888888888', chatId: '5511888888888@s.whatsapp.net' });
  assert.equal(f.calls.length, 0);
  await f.send(`!mega confirmar ${token}`);
  assert.equal(f.calls.length, 1);
});

test('alteração de destinos ativa somente após resumo; fila velha é pausada antes da retomada', async () => {
  const f = fixture();
  f.campaign('campaign-1', { state: 'active' });
  await f.send('!mega adicionar-grupo campaign-1 group-2@g.us');
  assert.deepEqual(f.store.getCampaign('campaign-1').groupIds, ['group-1@g.us']);
  assert.equal(f.calls.length, 0);
  await f.send(`!mega confirmar ${f.token()}`);
  assert.deepEqual(f.calls, [['pause', 'campaign-1'], ['resume', 'campaign-1']]);
  assert.deepEqual(f.store.getCampaign('campaign-1').groupIds, ['group-1@g.us', 'group-2@g.us']);
  assert.equal(f.store.getCampaign('campaign-1').state, 'active');
});

test('pausar e parar tudo invalidam confirmações pendentes', async () => {
  const f = fixture();
  f.campaign();
  await f.send('!mega ativar campaign-1');
  const oldToken = f.token();
  await f.send('!mega pausar campaign-1');
  await f.send(`!mega confirmar ${oldToken}`);
  assert.deepEqual(f.calls, [['pause', 'campaign-1']]);
  await f.send('!mega retomar campaign-1');
  const resumeToken = f.token();
  await f.send('!mega parar tudo');
  await f.send(`!mega confirmar ${resumeToken}`);
  assert.deepEqual(f.calls, [['pause', 'campaign-1'], ['stopAll']]);
});

test('grupos não autorizados, outra integração e excesso de grupos são recusados', async () => {
  const f = fixture();
  f.campaign();
  await f.send('!mega adicionar-grupo campaign-1 group-3@g.us');
  assert.match(f.latest(), /não está autorizado/);
  await f.send('!mega adicionar-grupo campaign-1 real@g.us');
  assert.match(f.latest(), /outra integração/);
  f.store.setSetting('maxSelectedGroups', 1);
  await f.send('!mega adicionar-grupo campaign-1 group-2@g.us');
  assert.match(f.latest(), /Limite atual: 1/);
  assert.deepEqual(f.store.getCampaign('campaign-1').groupIds, ['group-1@g.us']);
});

test('mídias só são importadas em uma sessão de conteúdo da campanha selecionada', async () => {
  const f = fixture();
  f.campaign('campaign-1'); f.campaign('campaign-2');
  await f.send('Legenda', { type: 'image' });
  assert.equal(f.downloads, 0);
  await f.send('!mega editar campaign-1');
  await f.send('Legenda', { type: 'image' });
  assert.equal(f.downloads, 0);
  await f.send('5');
  await f.send('Legenda da imagem 👋', { type: 'image', campaignId: 'campaign-2' });
  assert.equal(f.downloads, 1);
  assert.equal(f.imports, 1);
  assert.equal(f.store.getCampaign('campaign-1').items.length, 2);
  assert.equal(f.store.getCampaign('campaign-2').items.length, 1);
  assert.equal(f.store.getCampaign('campaign-1').items[1].caption, 'Legenda da imagem 👋');
  assert.equal(f.store.getCampaign('campaign-1').items[1].mediaId, 'media-1');
});

test('sessão expirada não baixa nem associa mídias', async () => {
  const f = fixture();
  f.campaign();
  await f.send('!mega editar campaign-1');
  await f.send('5');
  f.clock.now += SESSION_TTL + 1;
  await f.send('Legenda', { type: 'image' });
  assert.equal(f.downloads, 0);
  assert.equal(f.store.getCampaign('campaign-1').items.length, 1);
  assert.match(f.latest(), /sessão de configuração expirou/);
});

test('mídia de outro administrador não é associada à sessão alheia', async () => {
  const f = fixture();
  f.store.setSetting('admins', ['5511999999999', '5511888888888']);
  f.campaign();
  await f.send('!mega editar campaign-1'); await f.send('5');
  await f.send('Legenda', { type: 'image', senderNumber: '5511888888888', chatId: '5511888888888@s.whatsapp.net' });
  assert.equal(f.downloads, 0);
});

test('menu configura horários, dias, intervalo, modo e ordena conteúdos', async () => {
  const f = fixture();
  f.campaign('campaign-1', { items: [
    { id: 'a', type: 'text', text: 'primeiro' }, { id: 'b', type: 'text', text: 'segundo' }
  ] });
  await f.send('!mega editar campaign-1');
  await f.send('4'); await f.send('3'); await f.send('1,3,5');
  await f.send('4'); await f.send('09:00 22:00');
  await f.send('1'); await f.send('20');
  await f.send('8'); await f.send('2');
  const configured = f.store.getCampaign('campaign-1');
  assert.deepEqual(configured.schedule.days, [1, 3, 5]);
  assert.equal(configured.schedule.startTime, '09:00');
  assert.equal(configured.schedule.endTime, '22:00');
  assert.equal(configured.intervalMinutes, 20);
  assert.equal(configured.mode, 'rotate');
  await f.send('!mega menu'); await f.send('6'); await f.send('1'); await f.send('2,1');
  assert.deepEqual(f.store.getCampaign('campaign-1').items.map(item => item.id), ['b', 'a']);
  assert.equal(f.calls.length, 0);
});

test('configuração individual recebe seu próprio conteúdo sem alterar outros grupos', async () => {
  const f = fixture();
  f.campaign('campaign-1', { groupIds: ['group-1@g.us', 'group-2@g.us'] });
  await f.send('!mega editar campaign-1'); await f.send('3'); await f.send('3'); await f.send('2');
  await f.send('4'); await f.send('Conteúdo individual');
  const updated = f.store.getCampaign('campaign-1');
  assert.equal(updated.items.length, 1);
  assert.equal(updated.groupOverrides['group-2@g.us'].enabled, true);
  assert.equal(updated.groupOverrides['group-2@g.us'].items.at(-1).text, 'Conteúdo individual');
  assert.equal(updated.groupOverrides['group-1@g.us'], undefined);
});

test('edição de conteúdo ativo aguarda confirmação, e alteração concorrente invalida sessão', async () => {
  const f = fixture();
  f.campaign('campaign-1', { state: 'active' });
  await f.send('!mega editar campaign-1'); await f.send('5'); await f.send('Novo conteúdo');
  assert.equal(f.store.getCampaign('campaign-1').items.length, 1);
  await f.send(`!mega confirmar ${f.token()}`);
  assert.equal(f.store.getCampaign('campaign-1').items.length, 2);
  f.store.saveCampaign({ ...f.store.getCampaign('campaign-1'), name: 'Mudou' });
  await f.send('Não deve ser adicionado');
  assert.match(f.latest(), /mudou desde a seleção/);
  assert.equal(f.store.getCampaign('campaign-1').items.length, 2);
});

test('avanço de rodadas não invalida resumo e preserva o contador ao confirmar alteração', async () => {
  const f = fixture();
  f.campaign('campaign-1', { state: 'active', roundIndex: 3 });
  await f.send('!mega intervalo campaign-1 12');
  const token = f.token();
  f.store.saveCampaign({ ...f.store.getCampaign('campaign-1'), roundIndex: 4, nextRunAt: f.clock.now + 600000 });
  let settled = false;
  f.scheduler.waitForIdle = async () => { settled = true; };
  await f.send(`!mega confirmar ${token}`);
  assert.equal(settled, true);
  assert.equal(f.store.getCampaign('campaign-1').intervalMinutes, 12);
  assert.equal(f.store.getCampaign('campaign-1').roundIndex, 4);
  assert.equal(f.store.getCampaign('campaign-1').state, 'active');
});

test('atualizações de execução não encerram a sessão de edição do WhatsApp', async () => {
  const f = fixture();
  f.campaign('campaign-1', { state: 'active' });
  await f.send('!mega editar campaign-1');
  f.store.saveCampaign({ ...f.store.getCampaign('campaign-1'), roundIndex: 1, nextRunAt: f.clock.now + 600000 });
  await f.send('5');
  assert.match(f.latest(), /Envie o texto/);
  await f.send('Conteúdo novo');
  assert(f.token());
  assert.equal(f.store.getCampaign('campaign-1').items.length, 1, 'active content still waits for confirmation');
});

test('mudança de estado após o resumo invalida confirmação mesmo sem alterar conteúdo', async () => {
  const f = fixture();
  f.campaign('campaign-1', { state: 'active' });
  await f.send('!mega intervalo campaign-1 12');
  const token = f.token();
  f.store.saveCampaign({ ...f.store.getCampaign('campaign-1'), state: 'stopped', nextRunAt: null });
  await f.send(`!mega confirmar ${token}`);
  assert.match(f.latest(), /mudou desde o resumo/);
  assert.equal(f.store.getCampaign('campaign-1').state, 'stopped');
  assert.equal(f.store.getCampaign('campaign-1').intervalMinutes, 10);
});

test('parada externa durante a espera da fila impede aplicar conteúdo e retomar', async () => {
  const f = fixture();
  f.campaign('campaign-1', { state: 'active' });
  await f.send('!mega intervalo campaign-1 12');
  const token = f.token();
  f.scheduler.waitForIdle = async () => { f.store.saveCampaign({ ...f.store.getCampaign('campaign-1'), state: 'stopped' }); };
  await f.send(`!mega confirmar ${token}`);
  assert.match(f.latest(), /mudou enquanto a fila era pausada/);
  assert.equal(f.store.getCampaign('campaign-1').state, 'stopped');
  assert.equal(f.store.getCampaign('campaign-1').intervalMinutes, 10);
  assert.equal(f.calls.some(([operation]) => operation === 'resume'), false);
});

test('conteúdo individual vazio usa os conteúdos principais como o agendador', async () => {
  const f = fixture();
  f.campaign('campaign-1', { groupOverrides: { 'group-1@g.us': { enabled: true, items: [] } } });
  await f.send('!mega ativar campaign-1');
  assert(f.token());
  await f.send(`!mega confirmar ${f.token()}`);
  assert.equal(f.store.getCampaign('campaign-1').state, 'active');
});

test('legenda de mídia com prefixo não executa comandos e permanece conteúdo da campanha', async () => {
  const f = fixture();
  f.campaign();
  await f.send('!mega editar campaign-1');
  await f.send('5');
  await f.send('!mega parar tudo', { type: 'image' });
  assert.equal(f.downloads, 1);
  const items = f.store.getCampaign('campaign-1').items;
  assert.equal(items.length, 2);
  assert.equal(items[1].caption, '!mega parar tudo');
  assert.equal(f.calls.some(([operation]) => operation === 'stopAll'), false);
});

test('parada autorizada interrompe campanha enquanto uma configuração aguarda mídia', async () => {
  const f = fixture();
  f.campaign('campaign-1', { state: 'active' });
  await f.send('!mega editar campaign-1');
  await f.send('5');
  let releaseDownload;
  let started;
  const downloading = new Promise(resolve => { started = resolve; });
  f.adapter.downloadIncoming = () => { started(); return new Promise(resolve => { releaseDownload = resolve; }); };
  const pendingMedia = f.send('Legenda', { type: 'image' });
  await downloading;
  await f.send('!mega parar tudo');
  assert.equal(f.store.getCampaign('campaign-1').state, 'stopped');
  releaseDownload({ buffer: Buffer.from('test'), name: 'imagem.jpg', mime: 'image/jpeg', type: 'image' });
  await pendingMedia;
  assert.equal(f.store.getCampaign('campaign-1').items.length, 1);
  assert.equal(f.controller.pending.size, 0);
});

test('parada prioritária de remetente não autorizado não interrompe campanhas', async () => {
  const f = fixture();
  f.campaign('campaign-1', { state: 'active' });
  await f.send('!mega parar tudo', { senderNumber: '5511888888888', chatId: '5511888888888@s.whatsapp.net' });
  await f.send('!mega pausar campaign-1', { forwarded: true });
  assert.equal(f.store.getCampaign('campaign-1').state, 'active');
  assert.equal(f.calls.length, 0);
});

test('download com prazo excedido libera a fila e não importa conteúdo parcial', async () => {
  const f = fixture();
  f.campaign();
  await f.send('!mega editar campaign-1');
  await f.send('5');
  f.adapter.downloadIncoming = async () => { throw new Error('download timed out'); };
  await f.send('Legenda', { type: 'image' });
  assert.equal(f.imports, 0);
  assert.equal(f.store.getCampaign('campaign-1').items.length, 1);
  await f.send('!mega status');
  assert.match(f.latest(), /Conexão:/);
});

test('falha da resposta de controle não bloqueia o próximo comando', async () => {
  const f = fixture();
  const workingReply = f.adapter.reply;
  f.adapter.reply = async () => { throw new Error('reply timed out'); };
  await assert.rejects(f.send('!mega status'), /reply timed out/);
  f.adapter.reply = workingReply;
  await f.send('!mega ajuda');
  assert.match(f.latest(), /comandos da conversa autorizada/);
});

function authorizedFixture() {
  const f = fixture();
  const users = new Map([
    ['local-seller', { id: 'local-seller', phone: '5511999999999', active: true, campaignScope: 'own', permissions: new Set(['campaign.view', 'campaign.create', 'campaign.edit', 'campaign.start', 'campaign.pause', 'campaign.stop', 'groups.view', 'media.create', 'history.view', 'connection.view']) }],
    ['local-other', { id: 'local-other', phone: '5511888888888', active: true, campaignScope: 'own', permissions: new Set(['campaign.view', 'campaign.create', 'campaign.edit', 'campaign.start', 'campaign.pause', 'campaign.stop', 'groups.view', 'media.create', 'history.view', 'connection.view']) }]
  ]);
  const authService = {
    currentUserId: 'local-other',
    findAuthorizedPhone: number => [...users.values()].find(u => u.phone === number && u.active) || null,
    canFor(user, permission, campaign) {
      const actual = users.get(user?.id);
      return !!actual?.active && actual.permissions.has(permission) && (!campaign || actual.campaignScope === 'all' || campaign.ownerId === actual.id);
    },
    assertFor(user, permission, campaign) {
      if (!this.canFor(user, permission, campaign)) throw new Error('Sem permissão');
      return users.get(user.id);
    }
  };
  const audit = [];
  f.store.addAudit = entry => { audit.push(entry); return entry; };
  f.controller.authService = authService;
  const base = f.campaign;
  f.campaign = (id = 'campaign-1', patch = {}) => base(id, { ownerId: 'local-seller', ...patch });
  return { ...f, authService, users, audit };
}

test('número legado sem vínculo com usuário ativo não autentica em produção', async () => {
  const f = authorizedFixture();
  f.campaign();
  f.users.get('local-seller').active = false;
  await f.send('!mega pausar campaign-1');
  assert.equal(f.calls.length, 0);
  assert.equal(f.replies.length, 0);
  f.users.get('local-seller').active = true;
  f.users.get('local-seller').phone = '5511555555555';
  await f.send('!mega pausar campaign-1');
  assert.equal(f.calls.length, 0, 'legacy admins setting cannot override local identity');
  assert.equal(f.replies.length, 0);
});

test('campanhas e prévias respeitam o escopo do vendedor sem alterar o login do aplicativo', async () => {
  const f = authorizedFixture();
  f.campaign('mine', { name: 'Minha campanha' });
  f.campaign('others', { ownerId: 'local-other', name: 'Campanha confidencial' });
  await f.send('!mega campanhas');
  assert.match(f.latest(), /Minha campanha/);
  assert.doesNotMatch(f.latest(), /confidencial/);
  await f.send('!mega previa others');
  assert.match(f.latest(), /não tem permissão/);
  assert.doesNotMatch(f.latest(), /confidencial/);
  await f.send('!mega pausar others');
  assert.equal(f.calls.length, 0);
  assert.equal(f.authService.currentUserId, 'local-other');
});

test('permissões de editar, iniciar, pausar e encerrar são separadas no controle remoto', async () => {
  const f = authorizedFixture();
  const user = f.users.get('local-seller');
  f.campaign();
  user.permissions.delete('campaign.edit');
  await f.send('!mega intervalo campaign-1 20');
  assert.equal(f.store.getCampaign('campaign-1').intervalMinutes, 10);
  assert.match(f.latest(), /não tem permissão/);
  user.permissions.delete('campaign.start');
  await f.send('!mega ativar campaign-1');
  assert.equal(f.controller.pending.size, 0);
  user.permissions.delete('campaign.pause');
  await f.send('!mega pausar campaign-1');
  user.permissions.delete('campaign.stop');
  await f.send('!mega parar tudo');
  assert.equal(f.calls.length, 0);
});

test('confirmação revalida permissões e identidade após mudança de acesso', async () => {
  const f = authorizedFixture();
  const user = f.users.get('local-seller');
  f.campaign();
  await f.send('!mega ativar campaign-1');
  const first = f.token();
  assert.ok(first);
  user.permissions.delete('campaign.start');
  await f.send(`!mega confirmar ${first}`);
  assert.equal(f.calls.length, 0);
  assert.match(f.latest(), /não tem permissão/);
  user.permissions.add('campaign.start');
  await f.send('!mega ativar campaign-1');
  const second = f.token();
  user.phone = '5511555555555';
  f.users.get('local-other').phone = '5511999999999';
  await f.send(`!mega confirmar ${second}`);
  assert.equal(f.calls.length, 0);
  assert.match(f.latest(), /inválida ou expirada/);
});

test('criação remota grava o dono correto e auditoria separada sem salvar texto ou tokens', async () => {
  const f = authorizedFixture();
  await f.send('!mega criar Nova campanha');
  const campaign = f.store.listCampaigns()[0];
  assert.equal(campaign.ownerId, 'local-seller');
  assert.deepEqual(campaign.alertRecipientIds, []);
  assert.deepEqual(campaign.responsibleUserIds, []);
  assert.deepEqual(campaign.retryPolicy, { maxAttempts: 3, delaySeconds: 30 });
  assert.equal(f.audit.at(-1).actorId, 'local-seller');
  assert.equal(f.audit.at(-1).action, 'campaign.create');
  assert.equal(f.audit.at(-1).source, 'whatsapp');
  await f.send('5');
  await f.send('Informações privadas que não devem constar na auditoria');
  assert.equal(JSON.stringify(f.audit).includes('Informações privadas'), false);
  assert.equal(f.audit.at(-1).action, 'campaign.edit');
});

test('edição de mídia revalida acesso depois do download e não importa mídia sem permissão', async () => {
  const f = authorizedFixture();
  const user = f.users.get('local-seller');
  f.campaign();
  await f.send('!mega editar campaign-1');
  await f.send('5');
  f.adapter.downloadIncoming = async () => {
    user.permissions.delete('media.create');
    return { buffer: Buffer.from('secret'), name: 'imagem.jpg', mime: 'image/jpeg', type: 'image' };
  };
  await f.send('Legenda', { type: 'image' });
  assert.equal(f.store.getCampaign('campaign-1').items.length, 1);
  assert.match(f.latest(), /não tem permissão/);
});

test('vendedor não encerra globalmente campanhas de outro usuário', async () => {
  const f = authorizedFixture();
  f.campaign('mine', { state: 'active' });
  f.campaign('others', { ownerId: 'local-other', state: 'active' });
  await f.send('!mega parar tudo');
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.getCampaign('mine').state, 'active');
  assert.equal(f.store.getCampaign('others').state, 'active');
  assert.match(f.latest(), /não tem permissão/);
});
