'use strict';
const {createLicenseFixture}=require('./fixtures/license.cjs');

// Independent service-level integration checks. All transports here are the
// explicitly isolated simulation adapter; these are not live WhatsApp tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAppService } = require('../src/backend/service.cjs');

const PASSWORD = 'Senha-Kenned-Validacao-230!';
const OWNER = { name: 'Dono de validação', username: 'dono230', phone: '5562999990001', password: PASSWORD };
const SEARCH_GRANTS = Object.fromEntries(['search.view', 'search.run', 'search.history', 'search.filters', 'search.manage'].map(p => [p, true]));
const AT = Date.UTC(2026, 9, 3, 18, 0, 0); // 15:00 Brasília.

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-backend-230-'));
  const notices = [], hostActions = []; let service; let clock = AT; let importFiles = [];
  const host = async (action, payload) => {
    hostActions.push(action);
    if (action === 'secretGet') return null;
    if (action === 'showOpenDialog') return { canceled: !importFiles.length, filePaths: [...importFiles] };
    if (action === 'localAlert') { notices.push(payload); return { nativeStatus: 'unsupported', soundStatus: 'disabled' }; }
    return { canceled: true };
  };
  const open = async () => { service = await createAppService({ licenseService:createLicenseFixture(), dir, runtimePlatform: 'linux', now: () => clock, host }); return service; };
  const close = async () => { if (service) { await service.shutdown(); service = null; } };
  t.after(async () => { await close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await open(); const result = await service.call('setupOwner', OWNER);
  return { dir, notices, hostActions, owner: result.user, get service() { return service; }, setClock: value => { clock = value; }, setImports: files => { importFiles = files; }, close, open };
}
async function enable(service, extra = {}) {
  return service.call('saveSearchSettings', { settings: { enabled: true, monitoredGroupIds: ['sim-01@simulation', 'sim-02@simulation'], commandGroupIds: [], privateCommandsEnabled: true, commandPrivateNumbers: [], userRateLimit: { max: 100, windowSeconds: 60 }, ...extra } });
}
async function offer(service, extra = {}) {
  return service.call('testSearchSimulation', { kind: 'offer', groupId: 'sim-01@simulation', senderNumber: '5562999990101', supplierName: 'Fornecedor validado', text: 'iPhone 15 Pro Max 256GB Azul seminovo R$ 3.850,00', timestamp: AT - 60000, ...extra });
}
async function waitFor(read, predicate, text, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail(text);
}

test('2.3 service ranks original publication times in a two-hour window, persists periods and excludes financed or unpriced products', async t => {
  const f = await fixture(t), s = f.service; await enable(s);
  assert.equal(s.snapshot().buscas.settings.maxAgeEnabled, true); assert.equal(s.snapshot().buscas.settings.maxAgeValue, 2); assert.equal(s.snapshot().buscas.settings.maxAgeUnit, 'hours');
  await offer(s, { messageId: 'RECENT-CHEAP', timestamp: AT - 90 * 60000 });
  await offer(s, { messageId: 'RECENT-EXPENSIVE', senderNumber: '5562999990102', timestamp: AT - 5 * 60000, text: 'iPhone 15 Pro Max 256GB Azul seminovo R$ 4.100,00' });
  await offer(s, { messageId: 'OLD-CHEAP', senderNumber: '5562999990103', timestamp: AT - 121 * 60000, text: 'iPhone 15 Pro Max 256GB Azul seminovo R$ 2.000,00' });
  await offer(s, { messageId: 'FINANCED', senderNumber: '5562999990104', text: 'iPhone 15 Pro Max 256GB Azul seminovo entrada R$ 500 + 10x R$ 400' });
  await offer(s, { messageId: 'NO-PRICE', senderNumber: '5562999990105', text: 'iPhone 15 Pro Max 256GB Azul seminovo consulte preço' });
  let result = await s.call('runSearch', { query: 'iPhone 15 Pro Max 256GB' });
  assert.deepEqual(result.results.map(o => o.priceCents), [385000, 410000]); assert.equal(result.period.from, AT - 120 * 60000);
  await s.call('saveSearchSettings', { settings: { sort: 'cashDescending', maxAgeValue: 180, maxAgeUnit: 'minutes' } });
  result = await s.call('runSearch', { query: 'iPhone 15 Pro Max 256GB' }); assert.deepEqual(result.results.map(o => o.priceCents), [410000, 385000, 200000]);
  await s.call('saveSearchSettings', { settings: { sort: 'recent', maxAgeEnabled: false, defaultFilters: { condition: 'seminovo', storageGB: 256, groupId: 'sim-01@simulation' } } });
  result = await s.call('runSearch', { query: 'iPhone 15 Pro Max' }); assert.deepEqual(result.results.map(o => o.messageId), ['RECENT-EXPENSIVE', 'RECENT-CHEAP', 'OLD-CHEAP']);
  await f.close(); const reopened = await f.open(); await reopened.call('login', { username: OWNER.username, password: PASSWORD });
  const settings = reopened.snapshot().buscas.settings; assert.equal(settings.sort, 'recent'); assert.equal(settings.maxAgeEnabled, false); assert.equal(settings.maxAgeValue, 180); assert.equal(settings.maxAgeUnit, 'minutes'); assert.equal(settings.defaultFilters.groupId, 'sim-01@simulation');
});

test('2.3 private incoming BUSCAS replies only to the authorized requester, regardless of configured owner/responsible destinations', async t => {
  const f = await fixture(t), s = f.service;
  const other = await s.call('createUser', { user: { name: 'Buscador autorizado', username: 'buscador230', phone: '5562999990002', password: PASSWORD, roleId: 'role-seller', requirePasswordChange: false, permissionOverrides: SEARCH_GRANTS } });
  await s.call('saveSearchAuthorization', { authorization: { userId: other.id, enabled: true, permissions: ['search', 'history', 'filters', 'manage'] } });
  const recipient = await s.call('saveAlertRecipient', { name: 'Outro destinatário configurado', phone: '5562999990003' });
  await enable(s, { recipientMode: 'responsibles', responsibleRecipientIds: [recipient.id] }); await offer(s);
  await s.call('logout'); await s.call('login', { username: other.username, password: PASSWORD });
  const result = await s.call('testSearchSimulation', { kind: 'command', fromMe: false, text: '!BuScA iPhone 15 Pro Max 256GB' });
  assert.equal(result.replies.length, 1); assert.equal(result.replies[0].privateNumber, other.phone); assert.equal(result.replies[0].status, 'confirmed');
  assert.notEqual(result.replies[0].privateNumber, OWNER.phone); assert.notEqual(result.replies[0].privateNumber, recipient.phone);
  assert.match(result.replies[0].text, /RESULTADO DA BUSCA/); assert.match(result.replies[0].text, /3\.850,00/); assert.match(result.replies[0].text, /últimas 2 horas/);
  const missing = await s.call('testSearchSimulation', { kind: 'command', text: '!busca Samsung S24 Ultra 256GB' });
  assert.equal(missing.replies.length, 1); assert.equal(missing.replies[0].privateNumber, other.phone); assert.match(missing.replies[0].text, /Não foram encontradas ofertas compatíveis/);
  const help = await s.call('testSearchSimulation', { kind: 'command', text: '!busca' }); assert.equal(help.replies.length, 1); assert.match(help.replies[0].text, /Use !busca iPhone/); assert.equal(help.replies[0].privateNumber, other.phone);
  await assert.rejects(s.call('testSimulation', { text: '!mega parar tudo' }), /permissão/i);
  assert.equal(s.snapshot().automation.stopped, false, 'A search-only user must not acquire administrative stop permission');
});

test('2.3 unauthorized local identity cannot execute BUSCAS or claim the owner by payload', async t => {
  const f = await fixture(t), s = f.service; await enable(s); await offer(s);
  const stranger = await s.call('createUser', { user: { name: 'Não autorizado', username: 'sem-busca230', phone: '5562999990999', password: PASSWORD, roleId: 'role-seller', requirePasswordChange: false, permissionOverrides: SEARCH_GRANTS } });
  await s.call('logout'); await s.call('login', { username: stranger.username, password: PASSWORD });
  assert.equal((await s.call('searchesState')).authorized, false);
  await assert.rejects(s.call('runSearch', { query: 'iPhone 15', actorId: f.owner.id }), /autoriz|permiss/i);
  await assert.rejects(s.call('testSearchSimulation', { kind: 'command', text: '!busca iPhone 15', senderNumber: OWNER.phone }), /autoriz|permiss/i);
});

test('2.3 alerts distinguish offline pending and simulated confirmation, preserve the original event time and survive restart', async t => {
  const f = await fixture(t), s = f.service; await enable(s);
  await s.call('testSearchSimulation', { kind: 'disconnect' });
  const occurrence = await s.call('testAlert', { event: 'critical' }); assert.equal(occurrence.alerts.length, 1); assert.equal(occurrence.alerts[0].status, 'pending');
  const id = occurrence.alerts[0].id, originalAt = occurrence.alerts[0].originalAt;
  let page = await s.call('alertsPage', { limit: 100 }); assert.equal(page.items.find(a => a.id === id).status, 'pending'); assert.ok(f.notices.some(n => n.event === 'critical'));
  await f.close(); const reopened = await f.open(); await reopened.call('login', { username: OWNER.username, password: PASSWORD });
  page = await waitFor(() => reopened.call('alertsPage', { limit: 100 }), p => p.items.find(a => a.id === id)?.status === 'confirmed', 'Persisted pending test alert was not confirmed after reconnect');
  const alert = page.items.find(a => a.id === id); assert.equal(alert.originalAt, originalAt); assert.equal(alert.number, OWNER.phone); assert.equal(alert.confirmationScope, 'simulation-only'); assert.equal(page.items.filter(a => a.id === id).length, 1);
});

test('2.3 template backend persists formatted text and managed media through close/reopen and applies a saved model without mutable sharing', async t => {
  const f = await fixture(t), s = f.service, original = path.join(f.dir, 'fonte-oferta.txt'); fs.writeFileSync(original, 'Documento da loja'); f.setImports([original]);
  const [media] = await s.call('importMedia'); assert.ok(media.id); assert.equal(media.path, undefined); fs.renameSync(original, `${original}.movido`);
  const text = '*Oferta do dia* 😀\n_iPhone 15 Pro Max_\nhttps://loja.exemplo/oferta';
  let model = await s.call('saveTemplate', { template: { name: 'Modelo completo', items: [{ type: 'text', text }, { type: media.type, mediaId: media.id, caption: '*Descrição*\nDocumento original' }] } });
  assert.equal(s.snapshot().templates.find(m => m.id === model.id).items[0].text, text); assert.ok(fs.existsSync(await s.call('mediaPath', { id: media.id })));
  model = await s.call('saveTemplate', { template: { ...model, name: 'Modelo revisado', expectedUpdatedAt: model.updatedAt } }); const copy = await s.call('duplicateTemplate', { id: model.id }); assert.notEqual(copy.id, model.id);
  const items = await s.call('templateItems', { id: model.id }); assert.notEqual(items.items[0].id, model.items[0].id);
  const draft = s.snapshot().campaigns[0]; const campaign = await s.call('saveCampaign', { campaign: { ...draft, id: undefined, revision: undefined, configRevision: undefined, name: 'Campanha do modelo', items: items.items, groupIds: draft.groupIds.slice(0, 1) } });
  assert.equal(campaign.items[0].text, text); assert.equal(campaign.state, 'draft');
  await f.close(); const reopened = await f.open(); await reopened.call('login', { username: OWNER.username, password: PASSWORD });
  assert.equal((await reopened.call('getTemplate', { id: model.id })).name, 'Modelo revisado'); assert.ok(fs.existsSync(await reopened.call('mediaPath', { id: media.id })));
  await reopened.call('deleteTemplate', { id: model.id }); assert.equal(reopened.snapshot().templates.some(m => m.id === model.id), false); assert.equal(reopened.snapshot().campaigns.find(c => c.id === campaign.id).items[0].text, text); assert.equal(reopened.snapshot().templates.find(m => m.id === copy.id).items[0].text, text);
});

test('2.3 media deletion backend identifies template/campaign usage and deletes independent managed copies only after typed confirmation', async t => {
  const f = await fixture(t), s = f.service, source1 = path.join(f.dir, 'protegido.txt'), source2 = path.join(f.dir, 'livre.txt'); fs.writeFileSync(source1, 'Protegido'); fs.writeFileSync(source2, 'Livre'); f.setImports([source1, source2]);
  const [protectedMedia, freeMedia] = await s.call('importMedia'); const freePath = await s.call('mediaPath', { id: freeMedia.id });
  const model = await s.call('saveTemplate', { name: 'Modelo que usa arquivo', items: [{ type: protectedMedia.type, mediaId: protectedMedia.id }] });
  const preview = await s.call('mediaDeletionPreview', { ids: [protectedMedia.id, freeMedia.id] }); assert.equal(preview.canDelete, false); assert.ok(preview.items.find(m => m.id === protectedMedia.id).references.some(r => r.kind === 'template' && r.label === model.name));
  await assert.rejects(s.call('deleteMedia', { ids: [protectedMedia.id, freeMedia.id], confirmation: 'EXCLUIR' }), /em uso/); assert.equal(s.snapshot().media.length, 2);
  await assert.rejects(s.call('deleteMedia', { ids: [freeMedia.id], confirmation: 'excluir' }), /EXCLUIR/);
  const deleted = await s.call('deleteMedia', { ids: [freeMedia.id], confirmation: 'EXCLUIR' }); assert.equal(deleted.count, 1); assert.equal(fs.existsSync(freePath), false); assert.equal(fs.existsSync(source2), true); assert.equal(s.snapshot().media.length, 1);
});

test('2.3 reminders persist schedule, show test confirmation and refuse automatic work under the persistent global stop latch', async t => {
  const f = await fixture(t); let s = f.service;
  const reminder = await s.call('saveReminder', { title: 'Organizar estoque', description: 'Conferir a prateleira', time: '15:05', timezone: 'America/Sao_Paulo', repeat: 'daily', recipientId: `user:${f.owner.id}`, enabled: true, overduePolicy: 'sendOnce', overdueGraceMinutes: 120 });
  assert.equal(reminder.nextDueAt, AT + 5 * 60000); const queued = await s.call('testReminder', { id: reminder.id }); assert.equal(queued.status, 'pending');
  const history = await waitFor(() => s.call('reminderHistory', { reminderId: reminder.id }), p => p.items.some(d => d.id === queued.id && d.status === 'confirmed'), 'Test reminder was not confirmed'); assert.equal(history.items.find(d => d.id === queued.id).simulation, true);
  f.setClock(AT + 5 * 60000);
  const scheduled = await waitFor(() => s.call('reminderHistory', { reminderId: reminder.id }), p => p.items.some(d => !d.test && d.status === 'confirmed'), 'Scheduled reminder was not processed at its Brasília wall time');
  assert.equal(scheduled.items.filter(d => !d.test).length, 1); assert.equal(scheduled.items.find(d => !d.test).dueAt, AT + 5 * 60000);
  await f.close(); s = await f.open(); await s.call('login', { username: OWNER.username, password: PASSWORD });
  assert.equal((await s.call('reminderHistory', { reminderId: reminder.id })).items.filter(d => !d.test).length, 1, 'Confirmed occurrence must not duplicate after restart');
  await s.call('pauseReminder', { id: reminder.id }); assert.equal((await s.call('listReminders')).items[0].state, 'paused'); await s.call('activateReminder', { id: reminder.id });
  const stopped = await s.call('stopAll'); assert.equal(stopped.stopped, true); assert.equal((await s.call('automationStatus')).stopped, true); assert.equal((await s.call('listReminders')).items[0].state, 'paused');
  await assert.rejects(s.call('testReminder', { id: reminder.id }), /bloqueados|retome/i); await assert.rejects(s.call('activateReminder', { id: reminder.id }), /bloqueados|retome/i);
  await f.close(); const reopened = await f.open(); await reopened.call('login', { username: OWNER.username, password: PASSWORD }); assert.equal(reopened.snapshot().automation.stopped, true); assert.equal((await reopened.call('listReminders')).items[0].title, 'Organizar estoque');
  await reopened.call('resumeAutomation'); assert.equal(reopened.snapshot().automation.stopped, false); assert.equal((await reopened.call('listReminders')).items[0].state, 'paused'); await reopened.call('activateReminder', { id: reminder.id }); assert.equal((await reopened.call('listReminders')).items[0].state, 'active');
});

test('2.3 verified private intake creates one actionable contact pending, group senders are ignored, and saving classifies only local storage', async t => {
  const f = await fixture(t), s = f.service; await enable(s);
  await s.call('testSearchSimulation', { kind: 'command', text: 'Olá, gostaria de comprar um celular.' });
  await s.call('testSearchSimulation', { kind: 'command', text: 'Você pode me responder?' });
  const pending = await s.call('listPendingContacts'); assert.equal(pending.total, 1); assert.equal(pending.items[0].phone, OWNER.phone); assert.equal(pending.items[0].firstContactAt, AT);
  assert.equal(s.snapshot().contacts.length, 0); assert.equal(f.notices.filter(n => n.event === 'new_contact').length, 1);
  await offer(s, { senderNumber: '5562999990888', text: 'iPhone 15 128GB lacrado R$ 2000' }); assert.equal((await s.call('listPendingContacts')).total, 1);
  const saved = await s.call('savePendingContact', { id: pending.items[0].id, name: 'Cliente da loja', category: 'Cliente Nerópolis' }); assert.equal(saved.contact.category, 'Cliente Nerópolis'); assert.equal(saved.savedLocation, 'system'); assert.equal(saved.addressBookSupported, false); assert.match(saved.message, /não grava na agenda/);
  assert.equal((await s.call('listPendingContacts')).total, 0); assert.equal(s.snapshot().contacts.length, 1);
  await s.call('testSearchSimulation', { kind: 'command', text: 'Mensagem após cadastro' }); assert.equal((await s.call('listPendingContacts')).total, 0); assert.equal(f.notices.filter(n => n.event === 'new_contact').length, 1);
});

test('2.3 private administrative commands stay available during STOP and cancel every automatic pending family before reconnect', async t => {
  const f = await fixture(t), s = f.service; await enable(s); await offer(s);
  const originalDraft = s.snapshot().campaigns[0];
  const stoppable = await s.call('saveCampaign', { campaign: { ...originalDraft, id: undefined, revision: undefined, configRevision: undefined, name: 'Campanha pausada para interrupção', schedule: { ...originalDraft.schedule, startDate: '2026-10-04' } } });
  await s.call('activateCampaign', { id: stoppable.id, configRevision: stoppable.configRevision, summaryState: stoppable.state });
  await s.call('pauseCampaign', { id: stoppable.id });
  assert.equal(s.snapshot().campaigns.find(c => c.id === stoppable.id).state, 'paused');
  for (const command of ['!mega ajuda', '!mega menu', '!mega status']) { const reply = await s.call('testSimulation', { text: command }); assert.ok(reply.replies.length, command); assert.ok(reply.replies.every(r => r.chatId === `${OWNER.phone}@s.whatsapp.net`)); }
  const status = await s.call('testSimulation', { text: '!mega status' }); assert.match(status.text, /BUSCAS|monitoramento/i); assert.match(status.text, /alertas/i); assert.match(status.text, /lembretes/i);
  const reminder = await s.call('saveReminder', { title: 'Atualizar preços', time: '15:10', repeat: 'daily', recipientId: `user:${f.owner.id}`, enabled: true });
  await s.call('testSearchSimulation', { kind: 'disconnect' }); const alert = await s.call('testAlert', { event: 'critical' }); const reminderPending = await s.call('testReminder', { id: reminder.id }); const search = await s.call('runSearch', { query: 'iPhone 15 Pro Max', deliver: true }); assert.equal(search.delivery[0].status, 'pending');
  // The local transport cannot reply offline; the administrative STOP still
  // takes effect before its outgoing acknowledgement fails.
  await assert.rejects(s.call('testSimulation', { text: '!mega parar tudo' }), /conect|offline|desconect/i);
  assert.equal(s.snapshot().automation.stopped, true);
  assert.equal(s.snapshot().campaigns.find(c => c.id === stoppable.id).state, 'stopped');
  assert.equal(s.snapshot().campaigns.find(c => c.id === originalDraft.id).state, 'draft', 'STOP must preserve an unstarted draft');
  assert.equal((await s.call('alertsPage', { limit: 100 })).items.find(a => a.id === alert.alerts[0].id).status, 'cancelled');
  assert.equal((await s.call('reminderHistory', { reminderId: reminder.id })).items.find(d => d.id === reminderPending.id).status, 'cancelled');
  assert.equal((await s.call('searchRecipientStatus')).deliveries.items.find(d => d.runId === search.runId).status, 'cancelled');
  await s.call('connect'); const connectedStop = await s.call('testSimulation', { text: '!mega parar tudo' }); assert.match(connectedStop.text, /interrompid|bloquead/i); const whileStopped = await s.call('testSimulation', { text: '!mega status' }); assert.ok(whileStopped.replies.length);
  await assert.rejects(s.call('testAlert', { event: 'critical' }), /bloquead|retome|interrompid/i);
  await s.call('testSimulation', { text: '!mega retomar sistema' }); assert.equal(s.snapshot().automation.stopped, false);
});

test('2.3 portable reminder backup and restoration enforce reminder permissions before opening a file dialog', async t => {
  const f = await fixture(t), s = f.service;
  const backupUser = await s.call('createUser', { user: { name: 'Administrador sem leitura de lembretes', username: 'sembackup230', password: PASSWORD, roleId: 'role-admin', campaignScope: 'all', requirePasswordChange: false, permissionOverrides: { 'reminder.view': false } } });
  const restoreUser = await s.call('createUser', { user: { name: 'Administrador sem exclusão de lembretes', username: 'semrestore230', password: PASSWORD, roleId: 'role-admin', campaignScope: 'all', requirePasswordChange: false, permissionOverrides: { 'reminder.delete': false } } });
  await s.call('saveReminder', { title: 'Lembrete protegido por permissão', time: '09:00', repeat: 'daily', recipientId: `user:${f.owner.id}`, enabled: false });
  const dialogs = () => f.hostActions.filter(action => ['showOpenDialog', 'showSaveDialog', 'showMessageBox'].includes(action)).length;
  await s.call('logout'); await s.call('login', { username: backupUser.username, password: PASSWORD });
  const backupAuth = s.snapshot().auth;
  assert.equal(backupAuth.campaignScope, 'all');
  for (const permission of ['settings.edit', 'campaign.view', 'media.view', 'groups.view', 'contacts.view', 'notifications.view']) assert.ok(backupAuth.permissions.includes(permission), permission);
  assert.equal(backupAuth.permissions.includes('reminder.view'), false);
  const denied = error => error.code === 'AUTH_DENIED' && /permissão/i.test(error.message);
  const beforeBackup = dialogs(); await assert.rejects(s.call('backup'), denied); assert.equal(dialogs(), beforeBackup, 'Denied export must not expose even the file-selection dialog');
  await s.call('logout'); await s.call('login', { username: restoreUser.username, password: PASSWORD });
  const restoreAuth = s.snapshot().auth;
  assert.equal(restoreAuth.campaignScope, 'all');
  for (const permission of ['settings.edit', 'connection.manage', 'users.edit', 'campaign.view', 'campaign.create', 'campaign.edit', 'campaign.delete', 'campaign.stop', 'groups.edit', 'media.create', 'media.delete', 'contacts.create', 'contacts.delete', 'notifications.manage', 'reminder.view', 'reminder.create', 'reminder.edit', 'reminder.control']) assert.ok(restoreAuth.permissions.includes(permission), permission);
  assert.equal(restoreAuth.permissions.includes('reminder.delete'), false);
  const beforeRestore = dialogs(); await assert.rejects(s.call('restore'), denied); assert.equal(dialogs(), beforeRestore, 'Denied restore must not start file selection or maintenance');
  assert.equal(s.snapshot().reminders.items[0].title, 'Lembrete protegido por permissão');
  await s.call('logout'); await s.call('login', { username: OWNER.username, password: PASSWORD });
  assert.deepEqual(await s.call('backup'), { cancelled: true }); assert.deepEqual(await s.call('restore'), { cancelled: true });
  assert.equal(dialogs(), beforeRestore + 2, 'The owner is allowed to open both dialogs');
});
