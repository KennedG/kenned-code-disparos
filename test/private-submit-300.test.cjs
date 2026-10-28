'use strict';

// Native SQLite and production handlers/adapter, with a controlled authenticated
// socket. These regressions exercise submission boundaries, not live delivery.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { createStore } = require('../src/core/store.cjs');
const { AuthService } = require('../src/core/auth.cjs');
const { CommerceFinance } = require('../src/core/commerce-finance.cjs');
const { CommercialService } = require('../src/core/commercial.cjs');
const { CommerceAutomation } = require('../src/core/commerce-automation.cjs');
const { AutomationControl } = require('../src/core/automation-control.cjs');
const { Scheduler } = require('../src/core/scheduler.cjs');
const { WhatsAppAdapter } = require('../src/adapters/whatsapp.cjs');

const OWNER_PHONE = '5511999990001';
const REPORT_PHONE = '5511999990002';
const BUYER_PHONE = '5511999990003';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-private-submit-300-'));
  const store = await createStore(dir);
  store.setSetting('integrationMode', 'whatsapp');
  store.setSetting('initialized', true);
  const clock = { at: new Date(2026, 9, 5, 9, 0, 59).getTime() };
  const now = () => clock.at;
  const sleep = async ms => { clock.at += Math.max(0, ms); };
  const auth = new AuthService({ store, now });
  const owner = (await auth.setupOwner({ name: 'Dono de teste', username: 'owner-submit', phone: OWNER_PHONE, password: 'Teste-Private-Submit-2026' })).user;
  const recipient = await auth.createUser({ name: 'Administrador de relatório', username: 'report-submit', phone: REPORT_PHONE, roleId: 'role-admin', password: 'Teste-Report-Submit-2026', requirePasswordChange: false });
  const sends = [], lookups = [];
  let socket, lookupHook = async () => {};
  const library = {
    BufferJSON: { replacer: (_key, value) => value, reviver: (_key, value) => value },
    initAuthCreds: () => ({}),
    proto: { Message: { AppStateSyncKeyData: { fromObject: value => value } } },
    default() {
      socket = {
        ev: new EventEmitter(), ws: new EventEmitter(),
        user: { id: '5562998881111:27@s.whatsapp.net', lid: '400099991111:27@lid' },
        end() {}, logout: async () => {},
        onWhatsApp: async number => {
          lookups.push(number);
          await lookupHook(number, lookups.length);
          return [{ exists: true, jid: `${number}@s.whatsapp.net` }];
        },
        groupFetchAllParticipating: async () => ({}),
        sendMessage: async (target, content, options) => {
          sends.push({ target, content, options });
          queueMicrotask(() => socket.ws.emit('CB:ack,class:message', { attrs: { id: options.messageId } }));
          return { key: { id: options.messageId }, status: 1 };
        }
      };
      return socket;
    }
  };
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: data => Buffer.from(data).toString() };
  const adapter = new WhatsAppAdapter({ store, credentialsDir: path.join(dir, 'credentials'), safeStorage, loadLibrary: async () => library, runtimePlatform: 'win32', ackTimeoutMs: 250 });
  await adapter.connect();
  socket.ev.emit('connection.update', { connection: 'open' });
  const finance = new CommerceFinance({ store, now });
  const commercial = new CommercialService({ store, finance, now });
  const scheduler = new Scheduler({ store, adapter, now, sleep, beforeSend: args => commercial.evaluateJob(args), onSendResult: args => commercial.recordJobResult({ ...args, payload: args.job.itemSnapshot }) });
  const control = new AutomationControl({ store, scheduler, now });
  const automation = new CommerceAutomation({ store, auth, scheduler, adapter, finance, commercial, now, sleep, isAutomationStopped: () => control.isStopped() });
  control.register('commerce', () => automation.stopPending({ actorId: owner.id }));
  t.after(async () => {
    await automation.shutdown();
    await scheduler.shutdown();
    await adapter.disconnect();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, clock, auth, owner, recipient, adapter, finance, commercial, scheduler, control, automation, sends, lookups,
    onLookup(callback) { lookupHook = callback; } };
}

function forceSecondLookup(f) {
  const resolve = f.adapter.resolveRecipient.bind(f.adapter);
  let resolutions = 0;
  f.adapter.resolveRecipient = async number => {
    const result = await resolve(number);
    // Keep the production resolver and USYNC validation; remove its cache only
    // after the outer commerce validation so sendPrivate must resolve again.
    if (++resolutions === 1) f.adapter.recipientCache.clear();
    return result;
  };
}

function configureReport(f) {
  f.automation.saveReportSettings({ enabled: false, time: '20:00', timezone: 'America/Sao_Paulo', recipientIds: ['user:' + f.recipient.id] }, f.owner.id);
}

test('financial report does not submit when recipient finance permission is revoked during sendPrivate second USYNC', async t => {
  const f = await fixture(t);
  configureReport(f);
  forceSecondLookup(f);
  f.onLookup(async (number, count) => {
    assert.equal(number, REPORT_PHONE);
    if (count === 2) f.auth.updateUser({ id: f.recipient.id, permissionOverrides: { 'finance.view': false } });
  });
  await f.automation.generateDailyReport({ date: '2026-10-05', deliver: true }, f.owner.id);
  assert.equal(f.lookups.length, 2, 'the real adapter reached its second USYNC');
  assert.equal(f.auth.canFor(f.recipient.id, 'finance.view'), false);
  assert.equal(f.sends.length, 0, 'financial text never reached socket.sendMessage');
  const deliveries = f.store.listEntities('commerce_deliveries');
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].status, 'failed');
  assert.equal(deliveries[0].safeToRetry, false);
  assert.equal(f.adapter.pendingAcks.size, 0);
});

test('global STOP during sendPrivate second USYNC cancels the financial report without socket submission', async t => {
  const f = await fixture(t);
  configureReport(f);
  forceSecondLookup(f);
  f.onLookup(async (_number, count) => {
    if (count === 2) await f.control.stop({ actorId: f.owner.id, source: 'regression-test' });
  });
  await f.automation.generateDailyReport({ date: '2026-10-05', deliver: true }, f.owner.id);
  assert.equal(f.lookups.length, 2);
  assert.equal(f.control.isStopped(), true);
  assert.equal(f.sends.length, 0);
  const deliveries = f.store.listEntities('commerce_deliveries');
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].status, 'cancelled');
  assert.equal(deliveries[0].safeToRetry, false);
  assert.equal(f.adapter.pendingAcks.size, 0);
  f.control.resume({ actorId: f.owner.id });
  await f.automation.flush();
  assert.equal(f.sends.length, 0, 'resuming never replays the cancelled report');
});

function privateCampaign(f, { media = false, schedule } = {}) {
  const contact = f.commercial.saveContact({ name: 'Comprador autorizado', phone: BUYER_PHONE, categories: ['Cliente Nerópolis'], promotionalConsent: true }, f.owner.id);
  const product = f.finance.saveInventory({ kind: 'device', model: 'iPhone 15 Pro Max', storage: '256GB', costCents: 200000, retailCents: 350000, wholesaleCents: 320000 }, f.owner.id);
  let item = { id: 'private-text', type: 'text', text: 'iPhone 15 Pro Max — pronta entrega' };
  if (media) {
    const bytes = Buffer.from('Controlled production media boundary regression');
    fs.mkdirSync(path.join(f.dir, 'media'), { recursive: true });
    const filename = path.join(f.dir, 'media', 'private-stock-test.png');
    fs.writeFileSync(filename, bytes);
    const asset = f.store.saveMedia({ id: 'private-stock-media', name: 'private-stock-test.png', path: filename, mime: 'image/png', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
    item = { id: 'private-image', type: 'image', mediaId: asset.id, caption: 'iPhone 15 Pro Max — pronta entrega' };
  }
  const campaign = f.store.saveCampaign({ id: 'private-campaign', name: 'Anúncio privado de teste', state: 'draft', mode: 'repeat', ownerId: f.owner.id, audience: 'retail', groupIds: [], contactIds: [contact.id], inventoryIds: [product.id], items: [item], groupOverrides: {}, intervalMinutes: 10, spacingSeconds: 3, schedule: schedule || { days: [0, 1, 2, 3, 4, 5, 6], startTime: '00:00', endTime: '00:00' }, retryPolicy: { maxAttempts: 1, delaySeconds: 3 }, roundIndex: 0, nextRunAt: null });
  return { campaign, product, contact };
}

test('private campaign checks stock after real USYNC and verified media preparation before submitting old advertisement', async t => {
  const f = await fixture(t), { campaign, product } = privateCampaign(f, { media: true });
  const prepare = f.adapter._prepareContent.bind(f.adapter);
  let prepared = 0;
  f.adapter._prepareContent = async (...args) => {
    const content = await prepare(...args);
    prepared++;
    assert.equal(f.lookups.length, 1, 'recipient USYNC completed before media preparation');
    assert(Buffer.isBuffer(content.image), 'real managed bytes were verified and prepared');
    f.finance.createSale({ inventoryId: product.id, buyerName: 'Outro comprador', quantity: 1, payments: [], idempotencyKey: 'sold-during-media-preparation' }, f.owner.id);
    return content;
  };
  await f.scheduler.activate(campaign.id);
  await f.scheduler.tick();
  assert.equal(prepared, 1);
  assert.equal(f.finance.getInventory(product.id).availableQuantity, 0);
  assert.equal(f.sends.length, 0, 'sold item caption/image never reached the socket');
  const jobs = f.store.listJobs({ campaignId: campaign.id });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'failed');
  assert.equal(f.adapter.pendingAcks.size, 0);
});

test('private campaign cannot submit when its allowed schedule closes during actual recipient USYNC', async t => {
  const f = await fixture(t), { campaign } = privateCampaign(f, { schedule: { days: [1], startTime: '09:00', endTime: '09:01' } });
  f.onLookup(async number => {
    assert.equal(number, BUYER_PHONE);
    f.clock.at += 2000;
  });
  await f.scheduler.activate(campaign.id);
  await f.scheduler.tick();
  assert.equal(f.lookups.length, 1);
  assert.equal(f.sends.length, 0, '09:01 deadline is checked after recipient resolution');
  const jobs = f.store.listJobs({ campaignId: campaign.id });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'cancelled');
  assert.equal(f.adapter.pendingAcks.size, 0);
});

test('production commerce tick expires reservation while STOP stays latched, preserves deposit and allows explicit refund', async t => {
  const f=await fixture(t);
  const item=f.finance.saveInventory({kind:'device',model:'iPhone 15',costCents:60000,retailCents:100000},f.owner.id);
  const reservation=f.finance.reserve({inventoryId:item.id,quantity:1,buyerName:'Comprador de teste',expiresAt:f.clock.at+1000,depositCents:10000,paymentMethod:'pix',idempotencyKey:'reservation-expiry-runtime'},f.owner.id);
  await f.control.stop({userId:f.owner.id});f.clock.at+=2000;
  await f.automation.tick();await f.automation.tick();
  const expired=f.store.getEntity('reservations',reservation.id);
  assert.equal(expired.status,'expired');assert.equal(f.finance.getInventory(item.id).availableQuantity,1);
  assert.equal(f.finance.listReservations()[0].depositPendingRefundCents,10000);
  assert.equal(f.store.listEntities('sale_events',{kind:'reservation.expired'}).length,1);
  assert.equal(f.store.listEntities('sale_payments').length,1);assert.equal(f.sends.length,0);assert.equal(f.control.isStopped(),true);
  f.finance.refundReservation({reservationId:reservation.id,amountCents:10000,method:'pix',reason:'Prazo encerrado; estorno aprovado',idempotencyKey:'expiry-refund'},f.owner.id);
  assert.equal(f.finance.listReservations()[0].depositPendingRefundCents,0);
});
