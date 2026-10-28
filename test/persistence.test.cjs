'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createStore, seed } = require('../src/core/store.cjs');
const { MediaManager } = require('../src/core/media.cjs');
const validation = require('../src/core/validation.cjs');

test('campaign configuration version stays stable across rounds but changes with edited content',async t=>{
  const {store}=await fixture(t);const first=store.saveCampaign(sampleCampaign());
  assert.equal(first.configRevision,1);
  const running=store.saveCampaign({...first,state:'active',roundIndex:5,nextRunAt:Date.now()});
  assert.equal(running.revision,first.revision+1);assert.equal(running.configRevision,first.configRevision);
  const edited=store.saveCampaign({...running,items:[{id:'item-1',type:'text',text:'Conteúdo atualizado'}]});
  assert.equal(edited.configRevision,first.configRevision+1);
});

test('disk persistence failure blocks later mutations and leaves last durable data intact',async t=>{
  let fail=false;
  const {store,open}=await fixture(t,{beforeWrite(){if(fail)throw Object.assign(new Error('Disco sem espaço'),{code:'ENOSPC'});}});store.setSetting('durable','antes');
  fail=true;
  assert.throws(()=>store.setSetting('durable','depois'),/Disco sem espaço/);
  assert.equal(store.persistenceFailed,true);assert.throws(()=>store.setSetting('another','value'),/Armazenamento indisponível/);
  assert.equal(fs.readdirSync(store.dir).some(name=>name.endsWith('.tmp')),false);
  store.close();fail=false;const reopened=await open();assert.equal(reopened.getSetting('durable'),'antes');assert.equal(reopened.getSetting('another'),undefined);
});

test('received media with an unknown filename extension produces a restorable backup',async t=>{
  const {root,store,open}=await fixture(t);const manager=new MediaManager(store);
  const media=await manager.importBuffer(Buffer.from('%PDF-1.7\nDocumento de teste'),{name:'recebido.bin',mime:'application/pdf'});
  assert.equal(media.name,'recebido.bin.pdf');assert.equal(media.type,'document');
  const filename=path.join(root,'received.mega.json');await manager.createBackup(filename);
  const target=await open('restored');await new MediaManager(target).restoreBackup(filename);
  assert.equal(target.getMedia(media.id).name,'recebido.bin.pdf');
});

test('legacy backups restore received filenames and remain restored after first-use initialization',async t=>{
  const {root,data,target,targetManager}=await backupFixture(t);
  data.media[0].name='recebido.bin';data.settings=data.settings.filter(s=>s.id!=='initialized');
  const filename=path.join(root,'legacy.json');fs.writeFileSync(filename,JSON.stringify(data));
  await targetManager.restoreBackup(filename);seed(target);
  assert.equal(target.listCampaigns().length,1);assert.equal(target.listGroups().length,1);
  assert.equal(target.listMedia()[0].name,'recebido.bin.pdf');
  assert.equal(target.getSetting('initialized'),true);
});

test('malformed campaign and administrator data reject restoration before replacing saved configuration',async t=>{
  const {root,data,target,targetManager}=await backupFixture(t);
  for(const corrupt of [
    d=>{d.campaigns[0].schedule.days=[8];},
    d=>{d.campaigns.push({...d.campaigns[0]});},
    d=>{d.settings.push({id:'admins',value:'not-an-array'});},
    d=>{d.campaigns[0].groupIds='not-a-list';}
  ]){
    const broken=structuredClone(data);corrupt(broken);const filename=path.join(root,'malformed.json');fs.writeFileSync(filename,JSON.stringify(broken));
    await assert.rejects(targetManager.restoreBackup(filename),/Backup inválido/);
    assert.equal(target.getSetting('marker'),'must survive a rejected restore');assert.equal(target.listCampaigns().length,0);assert.deepEqual(fs.readdirSync(targetManager.dir),[]);
  }
});

async function fixture(t,options={}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-persistence-'));
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function open(subdir = 'data') {
    const store = await createStore(path.join(root, subdir),options);
    stores.push(store);
    return store;
  }
  return { root, open, store: await open() };
}

function sampleCampaign(overrides = {}) {
  return {
    id: 'camp-1', name: 'Campanha autorizada', state: 'draft', mode: 'repeat',
    intervalMinutes: 10, spacingSeconds: 5,
    schedule: { days: [0, 1, 2, 3, 4, 5, 6], startTime: '08:00', endTime: '18:00', startDate: '', endDate: '' },
    dailyRoundLimit: 0, dailySendLimit: 0, groupIds: ['group-1@g.us'],
    items: [{ id: 'item-1', type: 'text', text: 'Olá! 👋\n*Mensagem* com https://example.com' }],
    groupOverrides: {}, nextRunAt: null, roundIndex: 0, ...overrides
  };
}

function sampleJob(overrides = {}) {
  return {
    id: 'job-1', roundId: 'round-1', campaignId: 'camp-1', groupId: 'group-1@g.us',
    itemId: 'item-1', itemSnapshot: { id: 'item-1', type: 'text', text: 'Olá 👋' },
    status: 'queued', attempts: 0, createdAt: Date.now(), messageId: 'MESSAGE1', ...overrides
  };
}

test('SQLite persists every write before close and preserves campaign revisions', async t => {
  const { store, open } = await fixture(t);
  store.setSetting('admins', ['5511999999999']);
  store.upsertGroups([{ id: 'group-1@g.us', name: 'Equipe', authorized: false, simulation: false }]);
  const first = store.saveCampaign(sampleCampaign());
  const second = store.saveCampaign({ ...first, name: 'Campanha editada' });
  store.saveTemplate({ id: 'template-1', name: 'Modelo', items: first.items });
  store.insertRound({ id: 'round-1', campaignId: first.id, startedAt: Date.now(), finishedAt: null });
  store.insertJob(sampleJob());
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  assert.equal(fs.readFileSync(store.filename).subarray(0, 16).toString(), 'SQLite format 3\u0000');
  const persisted = await open();
  assert.deepEqual(persisted.getSetting('admins'), ['5511999999999']);
  assert.equal(persisted.getCampaign(first.id).name, 'Campanha editada');
  assert.equal(persisted.getCampaign(first.id).revision, 2);
  assert.equal(persisted.getGroup('group-1@g.us').authorized, false);
  assert.deepEqual(persisted.listTemplates()[0].items, first.items);
  assert.equal(persisted.listRounds(first.id).length, 1);
  assert.equal(persisted.getJob('job-1').status, 'queued');
  persisted.close();
});

test('process exit without close cannot erase the durable pre-send marker', async t => {
  const { root, open } = await fixture(t);
  const directory = path.join(root, 'interrupted-process');
  const script = `
    const { createStore } = require('./src/core/store.cjs');
    (async () => {
      const store = await createStore(process.argv[1]);
      store.saveCampaign({id:'crashed',name:'Crash',state:'active',revision:0,nextRunAt:123});
      store.insertRound({id:'crash-round',campaignId:'crashed',startedAt:123,finishedAt:null});
      store.insertJob({id:'crash-job',roundId:'crash-round',campaignId:'crashed',groupId:'g@g.us',itemId:'text',status:'sending',attempts:1,messageId:'KNOWN-ID'});
      process.exit(0);
    })().catch(() => process.exit(1));
  `;
  const child = spawnSync(process.execPath, ['-e', script, directory], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 15000
  });
  assert.equal(child.status, 0, child.stderr || 'Child exited unsuccessfully');
  const recovered = await open('interrupted-process');
  assert.equal(recovered.getJob('crash-job').status, 'sending');
  recovered.recoverInterrupted();
  assert.equal(recovered.getJob('crash-job').status, 'uncertain');
  assert.equal(recovered.getJob('crash-job').messageId, 'KNOWN-ID');
  assert.equal(recovered.getCampaign('crashed').state, 'paused');
  assert.equal(recovered.getCampaign('crashed').nextRunAt, null);
});

test('restart cancels old queued work, preserves uncertain outcomes and never resumes campaigns', async t => {
  const { store, open } = await fixture(t);
  const active = store.saveCampaign(sampleCampaign({ state: 'active', nextRunAt: Date.now() - 600000 }));
  store.saveCampaign(sampleCampaign({ id: 'unaffected-active', state: 'active', nextRunAt: Date.now() - 600000 }));
  store.saveCampaign(sampleCampaign({ id: 'unaffected-draft' }));
  store.insertRound({ id: 'round-1', campaignId: active.id, startedAt: Date.now() - 1000, finishedAt: null, status: 'running' });
  for (const [index, status] of ['queued', 'sending', 'accepted', 'confirmed', 'failed', 'uncertain'].entries()) {
    store.insertJob(sampleJob({ id: `job-${status}`, itemId: `item-${index}`, status, attempts: status === 'queued' ? 0 : 1 }));
  }
  const affected = store.recoverInterrupted();
  assert.deepEqual(affected, ['camp-1']);
  assert.equal(store.getJob('job-queued').status, 'cancelled');
  assert.equal(store.getJob('job-sending').status, 'uncertain');
  assert.equal(store.getJob('job-accepted').status, 'uncertain');
  assert.equal(store.getJob('job-confirmed').status, 'confirmed');
  assert.equal(store.getJob('job-failed').status, 'failed');
  assert.equal(store.getJob('job-uncertain').status, 'uncertain');
  assert.equal(store.getCampaign(active.id).state, 'paused');
  assert.equal(store.getCampaign(active.id).revision, active.revision + 1);
  assert.equal(store.getCampaign('unaffected-active').state, 'paused');
  assert.equal(store.getCampaign('unaffected-active').nextRunAt, null);
  assert.equal(store.getCampaign('unaffected-draft').state, 'draft');
  assert.equal(store.listRounds(active.id)[0].status, 'interrupted');
  assert.ok(store.listRounds(active.id)[0].finishedAt);
  store.close();
  const again = await open();
  assert.deepEqual(again.recoverInterrupted(), []);
  assert.equal(again.getJob('job-sending').status, 'uncertain');
  assert.equal(again.getJob('job-queued').status, 'cancelled');
  assert.equal(again.getCampaign(active.id).state, 'paused');
});

test('SQLite rejects duplicate round/group/item dispatches and preserves confirmed outcomes', async t => {
  const { store, open } = await fixture(t);
  store.insertJob(sampleJob({ status: 'confirmed', messageId: 'CONFIRMED' }));
  assert.throws(() => store.insertJob(sampleJob({ id: 'different-job-id', status: 'queued' })), /UNIQUE/i);
  assert.equal(store.listJobs().length, 1);
  assert.equal(store.getJob('job-1').status, 'confirmed');
  store.insertJob(sampleJob({ id: 'next-round', roundId: 'round-2' }));
  store.insertJob(sampleJob({ id: 'other-group', groupId: 'group-2@g.us' }));
  assert.equal(store.listJobs().length, 3);
  store.close();
  const persisted = await open();
  assert.equal(persisted.getJob('job-1').messageId, 'CONFIRMED');
  assert.equal(persisted.listJobs().length, 3);
});

test('refresh cannot grant publication authorization to a previously denied group', async t => {
  const { store } = await fixture(t);
  store.upsertGroups([
    { id: 'group-1@g.us', name: 'Grupo 1', authorized: false },
    { id: 'group-2@g.us', name: 'Grupo 2', authorized: false }
  ]);
  store.authorizeGroup('group-2@g.us', true);
  store.upsertGroups([
    { id: 'group-1@g.us', name: 'Nome atualizado', authorized: true },
    { id: 'group-2@g.us', name: 'Grupo 2 atualizado', authorized: false },
    { id: 'new@g.us', name: 'Novo grupo' }
  ]);
  assert.equal(store.getGroup('group-1@g.us').authorized, false);
  assert.equal(store.getGroup('group-1@g.us').name, 'Nome atualizado');
  assert.equal(store.getGroup('group-2@g.us').authorized, true);
  assert.equal(store.getGroup('new@g.us').authorized, false);
  assert.throws(() => store.authorizeGroup('absent@g.us', true), /não encontrado/);
});

test('first-use example contains exactly 15 simulated groups and stays disabled across restarts', async t => {
  const { store, open } = await fixture(t);
  seed(store);
  assert.equal(store.getSetting('integrationMode'), 'simulated');
  assert.deepEqual(store.getSetting('admins'), []);
  assert.equal(store.listCampaigns().length, 1);
  const example = store.listCampaigns()[0];
  assert.equal(example.state, 'draft');
  assert.equal(example.intervalMinutes, 10);
  assert.equal(example.groupIds.length, 15);
  assert.equal(example.nextRunAt, null);
  assert.ok(store.listGroups().every(g => g.simulation && g.authorized));
  store.setSetting('admins', ['5511999999999']);
  store.close();
  const again = await open();
  seed(again);
  assert.equal(again.listCampaigns().length, 1);
  assert.equal(again.listCampaigns()[0].state, 'draft');
  assert.deepEqual(again.getSetting('admins'), ['5511999999999']);
  assert.equal(again.listJobs().length, 0);
});

test('campaign validation ignores a request to autoactivate a newly created campaign', async t => {
  const { store } = await fixture(t);
  store.upsertGroups([{ id: 'group-1@g.us', name: 'Equipe', authorized: true }]);
  const created = validation.campaign(sampleCampaign({ id: 'not-yet-saved', state: 'active', nextRunAt: 1 }), store);
  assert.equal(created.state, 'draft');
  assert.equal(created.nextRunAt, null);
  assert.notEqual(created.id, 'not-yet-saved');
  assert.throws(() => validation.campaign(sampleCampaign({ groupIds: ['unknown@g.us'] }), store), /não está disponível/);
  store.setSetting('maxSelectedGroups', 1);
  store.upsertGroups([{ id: 'group-2@g.us', name: 'Equipe 2' }]);
  assert.throws(() => validation.campaign(sampleCampaign({ groupIds: ['group-1@g.us', 'group-2@g.us'] }), store), /Limite configurado/);
});

test('managed media survives moving the original and store restart', async t => {
  const { root, store, open } = await fixture(t);
  const original = path.join(root, 'original.pdf');
  const bytes = Buffer.from('%PDF-1.4\nManaged PDF fixture\n');
  fs.writeFileSync(original, bytes);
  const manager = new MediaManager(store);
  const imported = await manager.importFile(original);
  assert.notEqual(imported.path, original);
  assert.equal(imported.sha256, createHash('sha256').update(bytes).digest('hex'));
  fs.renameSync(original, path.join(root, 'original-moved.pdf'));
  assert.deepEqual(fs.readFileSync(manager.getPath(imported.id)), bytes);
  store.close();
  const reopened = await open();
  const reopenedManager = new MediaManager(reopened);
  assert.deepEqual(fs.readFileSync(reopenedManager.getPath(imported.id)), bytes);
  assert.equal(reopened.getMedia(imported.id).name, 'original.pdf');
});

test('media manager rejects paths outside its managed folder and unsupported files', async t => {
  const { root, store } = await fixture(t);
  const manager = new MediaManager(store);
  const external = path.join(root, 'outside.pdf');
  fs.writeFileSync(external, 'outside');
  store.saveMedia({ id: 'external', path: external, name: 'outside.pdf' });
  assert.throws(() => manager.getPath('external'), /inválida/);
  assert.throws(() => manager.getPath('missing'), /não encontrada/);
  await assert.rejects(manager.importBuffer(Buffer.alloc(0), { name: 'empty.pdf' }), /1 byte/);
  await assert.rejects(manager.importBuffer(Buffer.from('MZ executable'), { name: 'program.exe' }), /Formato não suportado/);
});

test('backup roundtrip restores campaign content and files as drafts without credentials', async t => {
  const { root, store, open } = await fixture(t);
  const manager = new MediaManager(store);
  const media = await manager.importBuffer(Buffer.from('%PDF-1.4\nBackup fixture'), { name: 'informações.pdf' });
  store.upsertGroups([{ id: 'group-1@g.us', name: 'Equipe', authorized: true, simulation: false }]);
  store.saveCampaign(sampleCampaign({
    state: 'active', nextRunAt: 99,
    items: [sampleCampaign().items[0], { id: 'media-item', type: 'document', mediaId: media.id, caption: 'Legenda com emoji 📄' }],
    groupOverrides: { 'group-1@g.us': { enabled: true, intervalMinutes: 20, schedule: sampleCampaign().schedule, items: [{ id: 'override-item', type: 'document', mediaId: media.id, caption: 'Somente para este grupo' }] } }
  }));
  store.saveTemplate({ id: 'saved-model', name: 'Modelo com arquivo', items: [{ id: 'template-item', type: 'document', mediaId: media.id, caption: 'Modelo' }] });
  store.setSetting('admins', ['5511999999999']);
  store.setSetting('theme', 'light');
  store.setSetting('integrationMode', 'whatsapp');
  for (const key of ['secretToken', 'credentials', 'session', 'qr', 'recentCommand']) store.setSetting(key, 'NEVER-BACK-UP-THIS-SECRET');
  fs.mkdirSync(path.join(store.dir, 'credentials'), { recursive: true });
  fs.writeFileSync(path.join(store.dir, 'credentials', 'session.enc'), 'ENCRYPTED-CREDENTIAL-FIXTURE');
  const filename = path.join(root, 'backup.mega.json');
  await manager.createBackup(filename);
  const raw = fs.readFileSync(filename, 'utf8');
  const backup = JSON.parse(raw);
  assert.equal(raw.includes('NEVER-BACK-UP-THIS-SECRET'), false);
  assert.equal(raw.includes('ENCRYPTED-CREDENTIAL-FIXTURE'), false);
  assert.equal(backup.media[0].path, undefined);
  assert.equal(typeof backup.media[0].base64, 'string');
  assert.equal(backup.settings.some(s => s.id === 'integrationMode'), false);
  const restored = await open('restored');
  const restoredManager = new MediaManager(restored);
  assert.deepEqual(await restoredManager.restoreBackup(filename), { campaigns: 1, media: 1 });
  const campaign = restored.getCampaign('camp-1');
  assert.equal(campaign.state, 'draft');
  assert.equal(campaign.nextRunAt, null);
  assert.equal(campaign.items[1].caption, 'Legenda com emoji 📄');
  assert.equal(campaign.groupOverrides['group-1@g.us'].items[0].mediaId, media.id);
  assert.equal(restored.listTemplates()[0].items[0].mediaId, media.id);
  assert.equal(restored.getSetting('integrationMode'), 'whatsapp');
  assert.deepEqual(restored.getSetting('admins'), ['5511999999999']);
  assert.equal(restored.getSetting('theme'), 'light');
  assert.equal(restored.getSetting('session'), undefined);
  assert.notEqual(restoredManager.getPath(media.id), media.path);
  assert.deepEqual(fs.readFileSync(restoredManager.getPath(media.id)), fs.readFileSync(manager.getPath(media.id)));
  assert.equal(fs.existsSync(path.join(restored.dir, 'credentials')), false);
  assert.equal(restored.listJobs().length, 0);
});

async function backupFixture(t) {
  const setup = await fixture(t);
  const manager = new MediaManager(setup.store);
  const media = await manager.importBuffer(Buffer.from('document bytes'), { name: 'document.pdf' });
  setup.store.saveCampaign(sampleCampaign({ items: [{ id: 'attached', type: 'document', mediaId: media.id, caption: 'Anexo' }] }));
  setup.store.upsertGroups([{ id: 'group-1@g.us', name: 'Grupo' }]);
  const filename = path.join(setup.root, 'source.json');
  await manager.createBackup(filename);
  const target = await setup.open('target');
  target.setSetting('marker', 'must survive a rejected restore');
  return { ...setup, filename, data: JSON.parse(fs.readFileSync(filename, 'utf8')), target, targetManager: new MediaManager(target) };
}

test('corrupted media checksums reject restore without changing existing data', async t => {
  const { root, data, target, targetManager } = await backupFixture(t);
  data.media[0].base64 = Buffer.from('tampered bytes').toString('base64');
  const filename = path.join(root, 'tampered.json');
  fs.writeFileSync(filename, JSON.stringify(data));
  await assert.rejects(targetManager.restoreBackup(filename), /corrompido/);
  assert.equal(target.getSetting('marker'), 'must survive a rejected restore');
  assert.equal(target.listCampaigns().length, 0);
  assert.deepEqual(fs.readdirSync(targetManager.dir), []);
});

test('backup supplied media paths, IDs and names cannot escape the managed folder', async t => {
  const { root, data, target, targetManager } = await backupFixture(t);
  const originalId = data.media[0].id;
  data.media[0].id = '../../outside-id';
  data.media[0].name = '../../escaped.pdf';
  data.media[0].path = path.join(root, 'escape-target.pdf');
  data.campaigns[0].items[0].mediaId = data.media[0].id;
  const filename = path.join(root, 'path-traversal.json');
  fs.writeFileSync(filename, JSON.stringify(data));
  await targetManager.restoreBackup(filename);
  const stored = target.getMedia('../../outside-id');
  assert.ok(stored);
  assert.equal(target.getMedia(originalId), undefined);
  const managedPath = targetManager.getPath(stored.id);
  assert.equal(path.dirname(managedPath), targetManager.dir);
  assert.match(path.basename(managedPath), /^[\da-f-]+\.pdf$/i);
  assert.equal(fs.existsSync(path.join(root, 'escape-target.pdf')), false);
  assert.equal(fs.existsSync(path.join(root, 'escaped.pdf')), false);
});

test('restore rejects missing media references and cleans files written before validation', async t => {
  const { root, data, target, targetManager } = await backupFixture(t);
  data.campaigns[0].items[0].mediaId = 'not-in-backup';
  const filename = path.join(root, 'missing-media.json');
  fs.writeFileSync(filename, JSON.stringify(data));
  await assert.rejects(targetManager.restoreBackup(filename), /mídia ausente/);
  assert.equal(target.getSetting('marker'), 'must survive a rejected restore');
  assert.equal(target.listCampaigns().length, 0);
  assert.deepEqual(fs.readdirSync(targetManager.dir), []);
});

test('restore rejects duplicate media IDs and removes partially restored files', async t => {
  const { root, data, target, targetManager } = await backupFixture(t);
  data.media.push({ ...data.media[0] });
  const filename = path.join(root, 'duplicate-media.json');
  fs.writeFileSync(filename, JSON.stringify(data));
  await assert.rejects(targetManager.restoreBackup(filename), /Mídia inválida/);
  assert.equal(target.getSetting('marker'), 'must survive a rejected restore');
  assert.deepEqual(fs.readdirSync(targetManager.dir), []);
});
