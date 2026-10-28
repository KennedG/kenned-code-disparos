'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createStore } = require('../src/core/store.cjs');
const { MediaManager } = require('../src/core/media.cjs');
const { ReminderService, normalizeReminder } = require('../src/core/reminders.cjs');
const { validateBackupData } = require('../src/core/backup-validation.cjs');

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-backup-reminders-')), stores = [], services = [];
  const open = async name => { const store = await createStore(path.join(dir, name)); stores.push(store); return store; };
  const source = await open('source'), target = await open('target');
  for (const store of [source, target]) { store.saveEntity('roles', { id: 'role-owner', isOwner: true }); store.saveEntity('users', { id: 'owner', roleId: 'role-owner', active: true, name: 'Dono', phone: '5511999999999', passwordHash: { hash: 'LOCAL_PASSWORD_DO_NOT_EXPORT' } }); }
  source.saveEntity('alert_recipients', { id: 'recipient', name: 'Responsável', phone: '5521999999999', enabled: true });
  const config = normalizeReminder({ title: 'Conferir estoque', description: 'Organizar balcão\nAtualizar preços.', time: '10:00', timezone: 'America/Sao_Paulo', repeat: 'weekdays', weekdays: [1, 3, 5], recipientId: 'user:owner', overduePolicy: 'sendOnce', overdueGraceMinutes: 120, maxAttempts: 2, retryMinutes: 2 });
  const reminder = store => store.saveEntity('reminders', { id: 'reminder-one', ...config, state: 'active', enabled: true, nextDueAt: Date.parse('2026-10-05T13:00:00Z'), scheduleRevision: 8, createdAt: 1, lastDeliveryId: 'local-confirmed', ownerId: 'owner', providerToken: 'SHOULD_NOT_EXPORT', lastOccurrenceAt: 10 });
  const service = store => { const adapter = new EventEmitter(); adapter.status = { mode: 'whatsapp', state: 'connected' }; const sends = []; adapter.resolveRecipient = async phone => ({ jid: `${phone}@s.whatsapp.net`, phone, mode: 'whatsapp', simulation: false }); adapter.sendPrivate = async (number, text, options) => { sends.push({ number, text, options }); return { status: 'confirmed', messageId: options.clientMessageId }; }; const auth = { assertFor: actor => { const user = store.getEntity('users', actor); if (!user || user.active === false || !store.getEntity('roles', user.roleId)) throw new Error('Autorização necessária.'); return user; } }; const value = new ReminderService({ store, auth, adapter, now: () => Date.parse('2026-10-06T13:30:00Z') }); services.push(value); return { value, sends }; };
  t.after(async () => { for (const service of services) await service.stop(); for (const store of stores) store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, source, target, open, reminder, service, config };
}

test('portable backup exports only validated reminder configuration and restores paused across actual restart without replaying operational ledger', async t => {
  const f = await fixture(t); f.reminder(f.source); f.reminder(f.target);
  f.source.saveEntity('reminder_deliveries', { id: 'source-secret-ledger', reminderId: 'reminder-one', status: 'confirmed', messageId: 'SOURCE_MESSAGE_ID', dueAt: 1 });
  const local = f.target.saveEntity('reminder_deliveries', { id: 'local-confirmed', campaignId: 'reminder-one', reminderId: 'reminder-one', status: 'confirmed', messageId: 'DO_NOT_REPLAY', dueAt: 10, resultAt: 11, attempts: 1 });
  const pending = f.target.saveEntity('reminder_deliveries', { id: 'local-pending', campaignId: 'reminder-one', reminderId: 'reminder-one', status: 'pending', messageId: 'OLD_PENDING', scheduleRevision: 8, recipientId: 'user:owner', number: '5511999999999', nextAttemptAt: 0, deadlineAt: Date.parse('2026-10-07T13:00:00Z'), attempts: 0, dueAt: Date.parse('2026-10-06T13:00:00Z') });
  const file = path.join(f.dir, 'configs.mega.json'); await new MediaManager(f.source).createBackup(file);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.reminders.length, 1); assert.equal(raw.reminders[0].title, 'Conferir estoque');
  for (const key of ['state', 'enabled', 'nextDueAt', 'scheduleRevision', 'lastDeliveryId', 'ownerId', 'providerToken', 'lastOccurrenceAt']) assert.equal(Object.hasOwn(raw.reminders[0], key), false, key);
  assert.equal(raw.reminder_deliveries, undefined); assert(!fs.readFileSync(file, 'utf8').includes('SOURCE_MESSAGE_ID')); assert(!fs.readFileSync(file, 'utf8').includes('SHOULD_NOT_EXPORT')); assert(!fs.readFileSync(file, 'utf8').includes('LOCAL_PASSWORD_DO_NOT_EXPORT'));
  await new MediaManager(f.target).restoreBackup(file);
  const restored = f.target.getEntity('reminders', 'reminder-one'); assert.equal(restored.state, 'paused'); assert.equal(restored.nextDueAt, null); assert.equal(restored.scheduleRevision, 9); assert.equal(restored.description, f.config.description); assert.equal(restored.reviewRequired, false);
  assert.deepEqual(f.target.getEntity('reminder_deliveries', 'local-confirmed'), local); assert.deepEqual(f.target.getEntity('reminder_deliveries', 'local-pending'), pending); assert.equal(f.target.getEntity('users', 'owner').passwordHash.hash, 'LOCAL_PASSWORD_DO_NOT_EXPORT');
  f.target.close(); const reopened = await f.open('target'); assert.equal(reopened.getEntity('reminders', 'reminder-one').state, 'paused');
  const { value, sends } = f.service(reopened); await value.tick(); assert.equal(sends.length, 0); assert.equal(reopened.getEntity('reminder_deliveries', 'local-confirmed').messageId, 'DO_NOT_REPLAY');
  assert.equal(reopened.getEntity('reminder_deliveries', 'local-pending').status, 'cancelled');
});

test('a legacy backup without reminders key preserves existing local reminder configuration and ledger byte for byte', async t => {
  const f = await fixture(t), existing = f.reminder(f.target);
  const ledger = f.target.saveEntity('reminder_deliveries', { id: 'keep-ledger', reminderId: existing.id, status: 'uncertain', messageId: 'KEEP_UNCERTAIN', attempts: 1 });
  const legacy = f.source.exportData(); delete legacy.reminders;
  const file = path.join(f.dir, 'legacy.mega.json'); fs.writeFileSync(file, JSON.stringify(legacy));
  await new MediaManager(f.target).restoreBackup(file);
  assert.deepEqual(f.target.getEntity('reminders', existing.id), existing); assert.deepEqual(f.target.getEntity('reminder_deliveries', ledger.id), ledger);
  f.target.close(); const reopened = await f.open('target'); assert.deepEqual(reopened.getEntity('reminders', existing.id), existing); assert.equal(reopened.getEntity('reminder_deliveries', ledger.id).status, 'uncertain');
});

test('a missing user recipient in another computer restores as paused and review required without importing or authorizing users', async t => {
  const f = await fixture(t); f.reminder(f.source); f.target.deleteEntity('users', 'owner'); f.target.saveEntity('users', { id: 'operator', roleId: 'role-owner', name: 'Dono local', phone: '5531999999999', active: true });
  const file = path.join(f.dir, 'other-pc.mega.json'); await new MediaManager(f.source).createBackup(file); await new MediaManager(f.target).restoreBackup(file);
  const item = f.target.getEntity('reminders', 'reminder-one'); assert.equal(item.recipientId, 'user:owner'); assert.equal(item.state, 'paused'); assert.equal(item.reviewRequired, true); assert.match(item.error, /Destinatário indisponível/); assert.equal(f.target.getEntity('users', 'owner'), undefined);
  const { value, sends } = f.service(f.target); await value.tick(); assert.equal(sends.length, 0); assert.throws(() => value.activate(item.id, 'operator'), /Destinatário/);
  f.target.saveEntity('alert_recipients', { id: 'legitimate', name: 'Destinatário local autorizado', phone: '5531999999999', enabled: true });
  const reviewed = value.save({ id: item.id, recipientId: 'legitimate' }, 'operator'); assert.equal(reviewed.reviewRequired, false); assert.equal(reviewed.error, null); assert.equal(reviewed.state, 'paused');
});

test('malformed reminder configurations and retry policies reject before any existing data is replaced', async t => {
  const f = await fixture(t); f.reminder(f.source); const preserved = f.reminder(f.target), valid = f.source.exportData();
  for (const mutate of [
    data => { data.reminders[0].repeat = 'impossível'; },
    data => { data.reminders[0].weekdays = [7]; },
    data => { data.reminders[0].time = '99:99'; },
    data => { data.reminders[0].timezone = 'Fuso/Inexistente'; },
    data => { data.reminders[0].overdueGraceMinutes = 0; },
    data => { data.reminders[0].maxAttempts = 100; },
    data => { data.reminders[0].retryMinutes = 0; },
    data => { data.reminders[0].recipientId = '5511999999999'; },
    data => { data.reminders[0].recipientId = 'user:'; },
    data => { data.reminders.push({ ...data.reminders[0] }); },
    data => { data.reminders = null; },
    data => { data.settings.push({ id: 'alertRetryPolicy', value: { maxAttempts: 99, delaySeconds: 15 } }); },
    data => { data.settings.push({ id: 'alertRetryPolicy', value: { maxAttempts: 3, delaySeconds: 0 } }); }
  ]) {
    const broken = structuredClone(valid); mutate(broken); const file = path.join(f.dir, 'invalid.mega.json'); fs.writeFileSync(file, JSON.stringify(broken));
    await assert.rejects(new MediaManager(f.target).restoreBackup(file), /Backup inválido/); assert.deepEqual(f.target.getEntity('reminders', preserved.id), preserved);
  }
  const accepted = structuredClone(valid); accepted.settings.push({ id: 'alertRetryPolicy', value: { maxAttempts: 5, delaySeconds: 3600 } }); assert.equal(validateBackupData(accepted).reminders.length, 1);
});

test('an explicit empty reminders collection clears only local configurations and retains every operational ledger', async t => {
  const f = await fixture(t); f.reminder(f.target); const ledger = f.target.saveEntity('reminder_deliveries', { id: 'still-protected', reminderId: 'reminder-one', status: 'uncertain', messageId: 'PROTECTED' });
  const backup = f.source.exportData(); assert.deepEqual(backup.reminders, []); f.target.importData(backup);
  assert.deepEqual(f.target.listEntities('reminders'), []); assert.deepEqual(f.target.getEntity('reminder_deliveries', ledger.id), ledger);
});
