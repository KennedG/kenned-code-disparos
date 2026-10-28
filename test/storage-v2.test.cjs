'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {createStore,seed}=require('../src/core/store.cjs');
const {writeJSONExport}=require('../src/core/log-export.cjs');

async function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-storage-v2-')),stores=[];
  t.after(()=>{for(const s of stores)s.close();fs.rmSync(dir,{recursive:true,force:true});});
  const open=async(sub='data',options)=>{const s=await createStore(path.join(dir,sub),options);stores.push(s);return s;};
  return {dir,open,store:await open()};
}
const campaign=(id='c1')=>({id,name:'Campanha '+id,state:'draft',mode:'repeat',intervalMinutes:10,spacingSeconds:5,schedule:{days:[0,1,2,3,4,5,6],startTime:'00:00',endTime:'00:00',startDate:'',endDate:''},dailyRoundLimit:0,dailySendLimit:0,groupIds:['g1'],items:[{id:'i1',type:'text',text:'Olá'}],groupOverrides:{},nextRunAt:null,roundIndex:0,ownerId:'u1',responsibleUserIds:['u2'],alertRecipientIds:['a1'],retryPolicy:{maxAttempts:2,delaySeconds:10}});
const job=(id='j1',extra={})=>({id,roundId:'r1',campaignId:'c1',groupId:'g1',itemId:id,status:'queued',attempts:0,createdAt:Date.now(),...extra});

function legacyDatabase(filename){
  const db=new DatabaseSync(filename);
  db.exec(`CREATE TABLE settings(id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE campaigns(id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE groups_data(id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE media(id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE templates(id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE rounds(id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE jobs(id TEXT PRIMARY KEY,roundId TEXT NOT NULL,campaignId TEXT NOT NULL,groupId TEXT NOT NULL,itemId TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(roundId,groupId,itemId));`);
  const c={...campaign(),revision:4,state:'active'},j=job('legacy',{status:'confirmed',attempts:1,messageId:'KNOWN',firstAttemptAt:Date.now()});
  db.prepare('INSERT INTO campaigns VALUES(?,?)').run(c.id,JSON.stringify(c));
  db.prepare('INSERT INTO settings VALUES(?,?)').run('initialized',JSON.stringify({id:'initialized',value:true}));
  db.prepare('INSERT INTO rounds VALUES(?,?)').run('r1',JSON.stringify({id:'r1',campaignId:'c1',startedAt:Date.now(),finishedAt:Date.now(),status:'finished'}));
  db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run(j.id,j.roundId,j.campaignId,j.groupId,j.itemId,j.status,JSON.stringify(j));db.close();
}

test('legacy SQLite upgrades in place with a complete pre-migration copy and WAL FULL durability',async t=>{
  const {dir,open}=await fixture(t),legacyDir=path.join(dir,'legacy');fs.mkdirSync(legacyDir);const filename=path.join(legacyDir,'mega.sqlite');legacyDatabase(filename);const before=fs.readFileSync(filename);
  const s=await open('legacy');assert.equal(s.getCampaign('c1').revision,4);assert.equal(s.getCampaign('c1').configRevision,4);assert.equal(s.getJob('legacy').messageId,'KNOWN');assert.equal(s.getJob('legacy').status,'confirmed');
  const backups=fs.readdirSync(path.join(legacyDir,'backups'));assert.equal(backups.length,1);assert.deepEqual(fs.readFileSync(path.join(legacyDir,'backups',backups[0])),before);
  const check=new DatabaseSync(filename);assert.equal(check.prepare('PRAGMA user_version').get().user_version,s.schemaVersion);assert.equal(check.prepare('PRAGMA journal_mode').get().journal_mode,'wal');check.close();
  assert.equal(s.getCampaignCounts('c1',Date.now()).sends,1);assert.deepEqual(s.getGroupHistory('c1').get('g1'),{lastAt:s.listRounds('c1')[0].startedAt,roundCount:1});
});

test('clearing presentation histories preserves duplicate protection, daily limits, data and immutable audit',async t=>{
  const {store:s,open}=await fixture(t);s.upsertGroups([{id:'g1',name:'Grupo',authorized:true}]);s.saveCampaign(campaign());s.saveEntity('users',{id:'u1',name:'Dono',passwordHash:{hash:'KEEP'}});s.saveEntity('contacts',{id:'contact1',name:'Contato',phone:'5511999999999'});s.saveMedia({id:'m1',name:'arquivo.pdf'});s.setSetting('theme','dark');
  s.insertRound({id:'r1',campaignId:'c1',startedAt:Date.now(),finishedAt:null,status:'running'});s.insertJob(job('confirmed',{status:'confirmed',attempts:1,firstAttemptAt:Date.now(),messageId:'NEVER-REPEAT'}));s.insertJob(job('queued'));s.insertJob(job('uncertain',{status:'uncertain',attempts:1,firstAttemptAt:Date.now()}));s.saveAlert({id:'alert1',status:'pending',campaignId:'c1',originalAt:Date.now()});s.addDiagnostic({id:'d1',campaignId:'c1',code:'TEMPORARY',stage:'send',at:Date.now()});s.saveNotification({id:'n1',at:Date.now(),event:'disconnect'});
  const before=s.getCampaignCounts('c1',Date.now()),progress=s.getGroupHistory('c1').get('g1'),preview=s.cleanupPreview();assert.ok(preview.total>0);
  const result=s.clearHistory({actor:{id:'u1',name:'Dono'}});assert.equal(result.total,preview.total);assert.equal(s.listHistory().total,0);assert.equal(s.getJob('confirmed').messageId,'NEVER-REPEAT');assert.equal(s.getJob('uncertain').status,'uncertain');assert.equal(s.listAlerts()[0].status,'pending');assert.equal(s.getSetting('theme'),'dark');assert.equal(s.getEntity('users','u1').passwordHash.hash,'KEEP');assert.equal(s.listGroups().length,1);assert.equal(s.listMedia().length,1);assert.equal(s.listEntities('contacts').length,1);assert.equal(s.listCampaigns().length,1);assert.deepEqual(s.getCampaignCounts('c1',Date.now()),before);assert.deepEqual(s.getGroupHistory('c1').get('g1'),progress);
  assert.equal(s.listOperationalReviews({campaignIds:['c1']}).items[0].id,'uncertain');assert.equal(s.listOperationalReviews({campaignIds:[]}).total,0);
  const audit=s.getEntity('audit',result.auditId);assert.equal(audit.actorId,'u1');assert.equal(audit.action,'history.clear');assert.deepEqual(audit.detail.counts,preview.counts);
  assert.throws(()=>s.deleteEntity('audit',audit.id),/imutável/);assert.throws(()=>s.saveEntity('audit',{...audit,action:'forged'}),/UNIQUE/);assert.equal(s.persistenceFailed,false);
  assert.throws(()=>s.insertJob({...s.getJob('confirmed'),id:'duplicate'}),/UNIQUE/);assert.throws(()=>s.updateJob('confirmed',{status:'queued'}),/confirmado/);assert.equal(s.persistenceFailed,false);
  s.close();const again=await open();assert.equal(again.listHistory().total,0);assert.equal(again.getJob('confirmed').status,'confirmed');assert.equal(again.getEntity('audit',result.auditId).actorId,'u1');assert.deepEqual(again.getGroupHistory('c1').get('g1'),progress);
});

test('category-only cleanup keeps other records and never turns uncertainty into a retry',async t=>{
  const {store:s}=await fixture(t);s.insertJob(job('j',{status:'uncertain',attempts:1}));s.addDiagnostic({id:'error',at:Date.now(),code:'UNCERTAIN'});s.saveNotification({id:'notify',at:Date.now(),event:'critical'});
  s.clearHistory({categories:['errors'],actor:'u1'});assert.equal(s.listEntities('diagnostics').length,0);assert.equal(s.listHistory({categories:['errors']}).total,0);assert.equal(s.listHistory({categories:['sends']}).total,1);assert.equal(s.listEntities('notifications').length,1);assert.equal(s.getJob('j').status,'uncertain');
});

test('history projections show one current send outcome, with indexed pagination and literal search',async t=>{
  const {store:s}=await fixture(t);
  for(let i=0;i<75;i++){const j=job('j'+i,{campaignId:i%2?'c2':'c1',groupId:'g'+i,itemSnapshot:{text:'100% válido _ '+i},createdAt:Date.now()+i});s.insertJob(j);s.updateJob(j.id,{status:'sending',attempts:1});s.updateJob(j.id,{status:'confirmed',messageId:'M'+i,resultAt:Date.now()+i});}
  assert.equal(s.listHistory({categories:['sends']}).total,75);const first=s.listHistory({categories:['sends'],campaignIds:['c1'],status:'confirmed',search:'100% válido _',limit:10,offset:0}),second=s.listHistory({categories:['sends'],campaignIds:['c1'],status:'confirmed',search:'100% válido _',limit:10,offset:10});assert.equal(first.total,38);assert.equal(first.items.length,10);assert.equal(second.items.length,10);assert.equal(new Set([...first.items,...second.items].map(i=>i.id)).size,20);assert.equal(s.listHistory({campaignIds:[]}).total,0);
  assert.equal(s.getMetrics({campaignIds:['c1']}).confirmed,38);assert.equal(s.exportHistory({categories:['sends'],limit:5}).items.length,5);assert.equal(s.exportHistory({categories:['sends'],limit:5}).total,75);
});

test('diagnostic pages scope campaigns and global events without loading unrelated failures',async t=>{
  const {store:s}=await fixture(t);s.addDiagnostic({id:'visible',campaignId:'c1',userId:'u1',at:Date.now(),code:'ERROR1',stage:'send',description:'Visible'});s.addDiagnostic({id:'hidden',campaignId:'c2',userId:'u2',at:Date.now(),code:'ERROR2',stage:'send'});s.addDiagnostic({id:'global',at:Date.now(),code:'DISCONNECTED',stage:'connection'});
  const page=s.queryEntities('diagnostics',{campaignIds:['c1'],includeGlobal:true,limit:1});assert.equal(page.total,2);assert.equal(page.items.length,1);assert.equal(s.queryEntities('diagnostics',{campaignIds:[],includeGlobal:true}).items[0].id,'global');assert.equal(s.queryEntities('diagnostics',{campaignIds:['c1'],code:'ERROR1',stage:'send',userId:'u1',search:'Visible'}).total,1);assert.equal(s.queryEntities('diagnostics',{campaignIds:[]}).total,0);
});

test('calendar date filters include the entire final local day and reject malformed dates',async t=>{
  const {store:s}=await fixture(t),at=new Date(2026,9,1,18,30).getTime();s.addDiagnostic({id:'afternoon',at,code:'LATE'});s.addDiagnostic({id:'next-day',at:new Date(2026,9,2,0,0).getTime(),code:'NEXT'});
  const page=s.queryEntities('diagnostics',{from:'2026-10-01',to:'2026-10-01'});assert.equal(page.total,1);assert.equal(page.items[0].id,'afternoon');assert.throws(()=>s.listHistory({from:'data inválida'}),/Data do filtro/);
});

test('retention bounds visible logs by age, entries and bytes while keeping operational ledgers and audit',async t=>{
  const {store:s}=await fixture(t);s.insertJob(job('keep',{status:'uncertain',attempts:1}));s.saveAlert({id:'pending',status:'pending'});s.addAudit({id:'protected',actorId:'u1',action:'important',at:1});
  s.addDiagnostic({id:'old',at:Date.now()-100*86400000,description:'antigo'});for(let i=0;i<8;i++)s.addDiagnostic({id:'d'+i,at:Date.now()+i,description:'x'.repeat(350)});
  s.applyRetention({days:30,maxEntries:3,maxMegabytes:1});assert.equal(s.queryEntities('diagnostics').total,3);assert.equal(s.listHistory({categories:['errors']}).total,3);assert.equal(s.getEntity('diagnostics','old'),undefined);
  s.applyHistoryRetention({days:30,maxRows:100,maxBytes:500});assert.ok(s.queryEntities('diagnostics').total<=1);assert.ok(s.listHistory({categories:['errors']}).total<=1);assert.equal(s.getJob('keep').status,'uncertain');assert.equal(s.getAlert('pending').status,'pending');assert.equal(s.getEntity('audit','protected').action,'important');
});

test('group checkpoints count each round once across multiple content items and survive history cleanup',async t=>{
  const {store:s}=await fixture(t);const at=Date.now();s.insertRound({id:'r1',campaignId:'c1',startedAt:at,finishedAt:null});s.insertJob(job('first',{status:'sending',attempts:1}));s.insertJob(job('second',{status:'confirmed',attempts:1}));s.updateJob('first',{status:'uncertain'});assert.deepEqual(s.getGroupHistory('c1').get('g1'),{lastAt:at,roundCount:1});
  s.insertRound({id:'r2',campaignId:'c1',startedAt:at+600000,finishedAt:null});s.insertJob(job('third',{roundId:'r2',status:'sending',attempts:1}));assert.deepEqual(s.getGroupHistory('c1').get('g1'),{lastAt:at+600000,roundCount:2});s.clearHistory({actor:'u1'});assert.deepEqual(s.getGroupHistory('c1').get('g1'),{lastAt:at+600000,roundCount:2});
});

test('local accounts and recovery are preserved on ordinary restore; credentials never enter portable backup',async t=>{
  const {store:s,open}=await fixture(t);s.upsertGroups([{id:'g1',name:'Grupo',authorized:true,simulation:true}]);s.saveCampaign(campaign());s.saveEntity('users',{id:'u1',name:'Dono',passwordHash:{hash:'SOURCE_SECRET'}});s.saveEntity('roles',{id:'owner',isOwner:true});s.saveEntity('recovery_tokens',{id:'source-token',digest:'SOURCE_RECOVERY'});s.setSetting('authLockout',{attempts:4});s.setSetting('launchAtLogin',true);s.saveEntity('contacts',{id:'contact',name:'Contato',phone:'5511999999999'});s.saveAlertRecipient({id:'a1',name:'Responsável',phone:'5511888888888',enabled:true});
  const data=s.exportData(),serialized=JSON.stringify(data);assert.equal(serialized.includes('SOURCE_SECRET'),false);assert.equal(serialized.includes('SOURCE_RECOVERY'),false);assert.equal(data.settings.some(v=>v.id==='authLockout'),false);assert.equal(data.settings.find(v=>v.id==='launchAtLogin').value,true);
  const target=await open('target');target.saveEntity('users',{id:'local',passwordHash:{hash:'LOCAL_SECRET'}});target.saveEntity('roles',{id:'local-owner',isOwner:true});target.saveEntity('recovery_tokens',{id:'local-token',digest:'LOCAL_RECOVERY'});target.setSetting('authLockout',{attempts:2});target.importData(data);assert.equal(target.getEntity('users','local').passwordHash.hash,'LOCAL_SECRET');assert.equal(target.getEntity('users','u1'),undefined);assert.equal(target.getEntity('roles','local-owner').isOwner,true);assert.equal(target.getEntity('recovery_tokens','local-token').digest,'LOCAL_RECOVERY');assert.deepEqual(target.getSetting('authLockout'),{attempts:2});assert.equal(target.getCampaign('c1').ownerId,'u1');assert.deepEqual(target.getCampaign('c1').retryPolicy,{maxAttempts:2,delaySeconds:10});assert.deepEqual(target.getCampaign('c1').responsibleUserIds,['u2']);assert.deepEqual(target.getCampaign('c1').alertRecipientIds,['a1']);assert.equal(target.getCampaign('c1').state,'draft');assert.equal(target.getCampaign('c1').nextRunAt,null);assert.equal(target.listEntities('contacts').length,1);assert.equal(target.getAlertRecipient('a1').phone,'5511888888888');
});

test('ordinary restore preserves managed local sound assets and excludes machine-specific paths from exported settings',async t=>{
  const {store:s}=await fixture(t);seed(s);s.setSetting('audioAssets',[{id:'local-audio',path:path.join(s.dir,'audio','sound.wav'),name:'Som local'}]);s.setSetting('webhook',{enabled:true,url:'https://example.com/WEBHOOK_SECRET'});const data=s.exportData();assert.equal(data.settings.some(v=>v.id==='audioAssets'),false);assert.equal(JSON.stringify(data).includes('WEBHOOK_SECRET'),false);s.importData(data);assert.equal(s.getSetting('audioAssets')[0].id,'local-audio');assert.equal(s.getSetting('webhook').url,'https://example.com/WEBHOOK_SECRET');
});

test('malformed new settings reject restoration before changing existing campaigns and accounts',async t=>{
  const {store:s}=await fixture(t);seed(s);s.setSetting('marker','preserved');s.saveEntity('users',{id:'owner',name:'Dono'});const data=s.exportData();
  for(const[id,value]of [['reconnect',{maxAttempts:100}],['notifications',{nativeEnabled:'yes'}],['retention',{days:-1}],['sound',{volume:101}],['sound',{quiet:{start:'99:99'}}]]){
    const bad=structuredClone(data);bad.settings=bad.settings.filter(v=>v.id!==id);bad.settings.push({id,value});assert.throws(()=>s.importData(bad),/Backup inválido/);assert.equal(s.getSetting('marker'),'preserved');assert.equal(s.listCampaigns().length,1);assert.equal(s.getEntity('users','owner').name,'Dono');
  }
});

test('transaction rollback is atomic, UNIQUE validation does not poison storage and new fields cannot invoke arbitrary SQL',async t=>{
  const {store:s}=await fixture(t);assert.throws(()=>s.transaction(()=>{s.setSetting('partial',true);s.saveEntity('roles',{id:'r'});throw new Error('rollback');}),/rollback/);assert.equal(s.getSetting('partial'),undefined);assert.equal(s.getEntity('roles','r'),undefined);assert.equal(s.persistenceFailed,false);assert.throws(()=>s.listEntities('users; DROP TABLE jobs'),/Coleção inválida/);s.setSetting('works',true);assert.equal(s.getSetting('works'),true);
});

test('diagnostics and audit omit credential fields and truncate oversized messages',async t=>{
  const {store:s}=await fixture(t);const d=s.addDiagnostic({description:'token=HIDE password=HIDE2 Bearer HIDE3',token:'HIDE4',details:{password:'HIDE5',safe:'ok'},extra:'x'.repeat(20000)}),a=s.addAudit({action:'settings.edit',detail:{passwordHash:'HIDE6',safe:'retained'}});
  const serialized=JSON.stringify([d,a]);assert.equal(serialized.includes('HIDE'),false);assert.equal(d.extra.length,16000);assert.equal(d.details.safe,'ok');assert.equal(a.detail.safe,'retained');
});

test('pending private alerts are loaded in bounded due batches and ACK lookup uses durable message ID',async t=>{
  const {store:s}=await fixture(t),at=Date.now();for(let i=0;i<65;i++)s.saveAlert({id:'a'+i,status:'pending',channel:i%2?'webhook':'whatsapp',createdAt:at+i,nextAttemptAt:at});s.saveAlert({id:'future',status:'pending',channel:'webhook',createdAt:at-10,nextAttemptAt:at+10000});s.saveAlert({id:'unknown',status:'uncertain',channel:'whatsapp',messageId:'MATCH',createdAt:at});s.saveAlert({id:'confirmed',status:'confirmed',channel:'whatsapp',messageId:'MATCH',createdAt:at});
  assert.equal(s.listPendingAlerts({at}).length,50);assert.equal(s.listPendingAlerts({at,channel:'webhook'}).length,32);assert.equal(s.listPendingAlerts({at,channel:'whatsapp',limit:3}).length,3);assert.equal(s.listPendingAlerts({at})[0].id,'a0');assert.deepEqual(s.findAlertsByMessageId('MATCH').map(a=>a.id),['unknown']);
});

test('streamed log export yields between pages, produces valid JSON and retains the old file on failure',async t=>{
  const {dir}=await fixture(t),filename=path.join(dir,'export.json');let eventLoopResponsive=false,pages=0;setImmediate(()=>{eventLoopResponsive=true;});
  const result=await writeJSONExport(filename,{metadata:{format:'mega-disparos-logs',version:1},pageSize:20,getPage({offset,limit}){pages++;return{total:65,items:Array.from({length:Math.min(limit,65-offset)},(_,i)=>({id:offset+i,text:'Olá 👋\n"teste"'}))};}});
  assert.equal(result.count,65);assert.equal(pages,4);assert.equal(eventLoopResponsive,true);const parsed=JSON.parse(fs.readFileSync(filename,'utf8'));assert.equal(parsed.format,'mega-disparos-logs');assert.equal(parsed.records.length,65);assert.equal(parsed.records[64].id,64);
  const before=fs.readFileSync(filename);await assert.rejects(writeJSONExport(filename,{maxRecords:2,getPage:()=>({total:3,items:[{id:1}]})}),/Use filtros/);assert.deepEqual(fs.readFileSync(filename),before);assert.equal(fs.readdirSync(dir).some(name=>name.endsWith('.tmp')),false);
});
