'use strict';

// Independent final regressions. SQLite is real; transport is controlled and
// does not establish acceptance or receipt by an actual WhatsApp account.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { createStore } = require('../src/core/store.cjs');
const { OpportunityService } = require('../src/core/opportunity-service.cjs');
const { parseRequest } = require('../src/core/opportunity-matcher.cjs');
const NOW = Date.parse('2026-10-08T15:00:00Z');
const GROUP = '120363000009991@g.us', PHONE = '5562999999899';
const OFFER = 'iPhone 13 Pro 256GB Azul seminovo bateria 90% R$ 2.500,00 disponível';
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-final-review-'));
  const store = await createStore(dir); store.setSetting('integrationMode', 'whatsapp');
  store.upsertGroups([{ id: GROUP, name: 'Grupo de teste controlado', simulation: false }]);
  const sent = [], adapter = new EventEmitter(); adapter.status = { state: 'connected' };
  adapter.resolveRecipient = async phone => ({ jid: `${phone}@s.whatsapp.net`, phone });
  adapter.sendSearchText = async (jid, text, options) => { options.beforeSubmit(); sent.push({ jid, text }); return { status: 'accepted', messageId: options.clientMessageId }; };
  const service = new OpportunityService({ store, adapter, now: () => NOW, sleep: async () => {} });
  const item = (patch = {}) => ({ id: 'original-item', type: 'text', text: OFFER, unitReference: 'STORE-UNIT-001', originalAt: NOW, availability: { available: true, confirmedAt: NOW, quantity: 1 }, ...patch });
  const campaign = (id, items = [item()]) => store.saveCampaign({ id, name: id, createdAt: NOW, state: 'draft', ownerId: 'owner', groupIds: [], items });
  campaign('original');
  service.saveConfig({ enabled: true, mode: 'evaluation', monitoredGroupIds: [GROUP], campaignIds: ['original'] }, 'owner');
  const incoming = (messageId = 'request', patch = {}) => ({ messageId, chatId: GROUP, originalTimestamp: NOW, timestamp: NOW, senderNumber: PHONE,
    senderId: `${PHONE}@s.whatsapp.net`, senderIds: [`${PHONE}@s.whatsapp.net`], identityVerified: true, isGroup: true, type: 'text', text: '13 PRO 256??', mode: 'whatsapp', simulation: false, ...patch });
  t.after(async () => { await service.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, service, adapter, sent, item, campaign, incoming };
}

test('cópia antiga não torna elegível a unidade cuja campanha original agora informa vendido', async t => {
  const f = await fixture(t); f.campaign('copy', [f.item({ id: 'copied-item' })]);
  f.service.saveConfig({ campaignIds: ['original', 'copy'] }, 'owner');
  const op = f.service.handleIncoming(f.incoming()).opportunity;
  f.campaign('original', [f.item({ text: OFFER.replace('disponível', 'vendido'), availability: { available: false, confirmedAt: NOW, quantity: 0 } })]);
  const result = f.service.evaluate(op.id);
  assert.equal(result.candidates.some(row => row.eligible), false, 'A cópia com preço e disponibilidade antigos não pode ganhar da unidade indisponível.');
  assert.equal(f.store.listOpportunityTasks().length, 0);
});

test('preços conflitantes da mesma unidade em duas campanhas requerem revisão em vez de escolha por ordem', async t => {
  const f = await fixture(t); f.campaign('copy', [f.item({ id: 'copied-item' })]);
  f.service.saveConfig({ campaignIds: ['original', 'copy'] }, 'owner');
  const op = f.service.handleIncoming(f.incoming()).opportunity;
  f.campaign('original', [f.item({ text: OFFER.replace('2.500,00', '2.600,00') })]);
  const result = f.service.evaluate(op.id);
  assert.equal(result.candidates.some(row => row.eligible), false, 'Sem referência mais recente inequívoca, os preços conflitantes precisam de revisão.');
});

test('cópias idênticas mantêm uma oferta; referências explícitas distintas mantêm duas unidades', async t => {
  const f = await fixture(t); f.campaign('copy', [f.item({ id: 'copied-item' })]);
  f.service.saveConfig({ campaignIds: ['original', 'copy'] }, 'owner');
  const op = f.service.handleIncoming(f.incoming()).opportunity;
  assert.equal(f.service.evaluate(op.id).candidates.filter(row => row.eligible).length, 1);
  f.campaign('second-unit', [f.item({ id: 'second-item', unitReference: 'STORE-UNIT-002' })]);
  f.service.saveConfig({ campaignIds: ['original', 'copy', 'second-unit'] }, 'owner');
  const candidates = f.service.evaluate(op.id).candidates.filter(row => row.eligible);
  assert.equal(candidates.length, 2); assert.equal(new Set(candidates.map(row => row.id)).size, 2);
});

test('encerramento citado encontra o autor e a origem mesmo fora da primeira página de oportunidades', async t => {
  const f = await fixture(t), original = f.service.handleIncoming(f.incoming('original-request')).opportunity;
  const request = parseRequest('13 PRO 256??');
  for (let i = 0; i < 205; i++) f.store.ingestOpportunity({ event: { senderKey: original.senderKey, senderPhone: PHONE, recipient: PHONE, chatId: GROUP,
    messageId: `other-${i}`, originalAt: NOW, text: '13 PRO 256??' }, request: { ...request, familyKey: `independent-family-${i}`, intentKey: `independent-intent-${i}` } }, NOW);
  assert.equal(f.store.listOpportunities({ senderKey: original.senderKey }).total, 206);
  const result = f.service.handleIncoming(f.incoming('closing-message', { text: 'Já consegui.', quotedMessageId: 'original-request', quotedChatId: GROUP }));
  assert.equal(result.closed, true); assert.equal(f.store.getOpportunity(original.id).status, 'closed');
  assert.equal(f.store.listOpportunities({ status: 'closed' }).total, 1);
});

test('parada geral cancela todas as tarefas automáticas acima de mil sem cancelar tarefa manual', async t => {
  const f = await fixture(t), op = f.service.handleIncoming(f.incoming()).opportunity;
  // Populate the operational queue in one transaction to test full breadth,
  // independently of offer matching and UI pagination.
  const db = new DatabaseSync(path.join(f.dir, 'mega.sqlite')); db.exec('BEGIN IMMEDIATE');
  try {
    const insert = db.prepare('INSERT INTO op_tasks(storageMode,id,clientId,opportunityId,senderKey,intentKey,familyKey,status,createdAt,dayKey,data) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    for (let i = 0; i < 1002; i++) {
      const task = { id: `stop-${i}`, clientId: `stop-client-${i}`, opportunityId: op.id, senderKey: op.senderKey, intentKey: op.intentKey, familyKey: op.familyKey,
        offerIds: [], recipient: PHONE, status: 'queued', automatic: i !== 1001, createdAt: NOW, dayKey: '2026-10-08', attempts: 0 };
      insert.run('whatsapp', task.id, task.clientId, task.opportunityId, task.senderKey, task.intentKey, task.familyKey, task.status, task.createdAt, task.dayKey, JSON.stringify(task));
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; } finally { db.close(); }
  const result = f.service.cancelAutomatic('Parada geral de teste.');
  assert.equal(typeof result === 'number' ? result : result.cancelled, 1001);
  assert.equal(f.store.listOpportunityTasks({ status: 'queued', limit: 1000 }).length, 1);
  assert.equal(f.store.getOpportunityTask('stop-1001').automatic, false);
});

test('edição para indisponível após preparar texto é verificada novamente imediatamente antes do relay', async t => {
  const f = await fixture(t); f.service.saveConfig({ mode: 'automatic' }, 'owner');
  f.adapter.sendSearchText = async (jid, text, options) => {
    f.campaign('original', [f.item({ text: OFFER.replace('disponível', 'indisponível'), availability: { available: false, confirmedAt: NOW, quantity: 0 } })]);
    options.beforeSubmit(); f.sent.push({ jid, text }); return { status: 'accepted', messageId: options.clientMessageId };
  };
  f.service.start(); f.service.handleIncoming(f.incoming()); await f.service.waitForIdle();
  assert.equal(f.sent.length, 0); assert.equal(f.store.listOpportunityTasks()[0].status, 'failed');
  assert.equal(f.store.listOpportunityTasks()[0].messageId, undefined);
});

test('duas confirmações simultâneas de reenvio incerto reservam somente um reenvio manual persistente', async t => {
  const f = await fixture(t); f.service.saveConfig({ mode: 'automatic' }, 'owner');
  f.adapter.reconcile = async id => ({ status: 'uncertain', messageId: id });
  const op = f.service.handleIncoming(f.incoming()).opportunity;
  const initial = f.store.listOpportunityTasks()[0]; f.store.claimOpportunityTask(initial.id, { now: NOW });
  f.store.updateOpportunityTask(initial.id, { status: 'uncertain', resultAt: NOW });
  const requests = Array.from({ length: 2 }, () => f.service.retryUncertain({ id: initial.id, confirm: true, duplicateRiskAcknowledged: true }, 'owner'));
  await Promise.allSettled(requests);
  const retries = f.store.listOpportunityTasks({ opportunityId: op.id }).filter(task => task.retryOf === initial.id);
  assert.equal(retries.length, 1, 'O aviso sobre possível duplicação não autoriza dois cliques a criarem dois reenvios.');
  assert.equal(retries[0].status, 'queued'); assert.equal(f.store.getOpportunityTask(initial.id).status, 'uncertain');
});

test('cópia de publicação removida na origem não continua elegível por conservar uma legenda antiga', async t => {
  const f = await fixture(t);
  const source = f.store.insertSourcePublication({ groupId: GROUP, messageId: 'source-original', originalAt: NOW, capturedAt: NOW, revisionAt: NOW,
    status: 'ready', caption: OFFER, text: OFFER, campaignId: 'original', itemId: 'original-item', dateKey: '2026-10-08' }).publication;
  f.campaign('original', [f.item({ sourcePublicationId: source.id, sourceGroupId: GROUP, sourceMessageId: source.messageId, sourcePublicationRevision: NOW })]);
  f.campaign('copy', [f.item({ id: 'copy-source-item', sourcePublicationId: source.id, sourceGroupId: GROUP, sourceMessageId: source.messageId, sourcePublicationRevision: NOW })]);
  f.service.saveConfig({ campaignIds: ['original', 'copy'] }, 'owner');
  const op = f.service.handleIncoming(f.incoming()).opportunity;
  assert.equal(f.service.evaluate(op.id).candidates.some(row => row.eligible), true);
  f.campaign('original', []); f.store.updateSourcePublication(source.id, { status: 'removed', removedAt: NOW + 1, revisionAt: NOW + 1 });
  assert.equal(f.service.evaluate(op.id).candidates.some(row => row.eligible), false, 'O estado operacional da origem removida vale também para sua cópia.');
});

test('cópia selecionada sozinha exige revisão quando a publicação de origem foi editada posteriormente', async t => {
  const f = await fixture(t);
  const source = f.store.insertSourcePublication({ groupId: GROUP, messageId: 'edited-source-original', originalAt: NOW, capturedAt: NOW, revisionAt: NOW,
    status: 'ready', caption: OFFER, text: OFFER, campaignId: 'original', itemId: 'original-item', dateKey: '2026-10-08' }).publication;
  f.campaign('copy', [f.item({ id: 'copy-source-item', sourcePublicationId: source.id, sourceGroupId: GROUP, sourceMessageId: source.messageId, sourcePublicationRevision: NOW })]);
  f.service.saveConfig({ campaignIds: ['copy'] }, 'owner');
  const op = f.service.handleIncoming(f.incoming()).opportunity;
  assert.equal(f.service.evaluate(op.id).candidates.some(row => row.eligible), true);
  f.store.updateSourcePublication(source.id, { status: 'ready', revisionAt: NOW + 1, caption: OFFER.replace('2.500,00', '2.600,00'), text: OFFER.replace('2.500,00', '2.600,00') });
  const result = f.service.evaluate(op.id);
  assert.equal(result.candidates.some(row => row.eligible), false, 'A origem comprovadamente editada não pode validar o preço antigo conservado na cópia.');
});
