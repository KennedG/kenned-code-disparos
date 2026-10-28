'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { configurationFingerprint } = require('./campaign-version.cjs');
const { createSearchSchema, attachSearchStore } = require('./search-store.cjs');

const ENTITY_TABLES = new Set(['users','roles','recovery_tokens','audit','diagnostics','notifications','alerts','alert_recipients','contacts']);
const HISTORY_CATEGORIES = ['campaigns','sends','errors','notifications'];
const SCHEMA_VERSION = 5;
const PRIVATE_SETTING = /secret|cred|session|qr|recentCommand|^integrationMode$|^audioAssets$|^webhook$|^independentAlertChannel$|password|auth|recovery|^(login|lockout|buscas|search)/i;

function atomicWrite(filename, data) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temp = `${filename}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, filename);
  } catch (error) { try { fs.unlinkSync(temp); } catch {} throw error; }
  let directory;
  try { directory = fs.openSync(path.dirname(filename), 'r'); fs.fsyncSync(directory); } catch {}
  finally { if (directory !== undefined) fs.closeSync(directory); }
}
const localDay=value=>{const d=new Date(value);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const json=value=>JSON.stringify(value);
const parseRows=rows=>rows.map(row=>JSON.parse(row.data));
const clamp=(value,fallback,maximum)=>Number.isInteger(Number(value))&&Number(value)>=0?Math.min(Number(value),maximum):fallback;
function filterTimestamp(value,end=false){
  if(typeof value==='number')return value;
  if(/^\d{4}-\d{2}-\d{2}$/.test(value)){const[y,m,d]=value.split('-').map(Number);return new Date(y,m-1,d,end?23:0,end?59:0,end?59:0,end?999:0).getTime();}
  const at=Date.parse(value);if(!Number.isFinite(at))throw new Error('Data do filtro inválida.');return at;
}
function categories(input) {
  const values=input===undefined?HISTORY_CATEGORIES:input;
  if(!Array.isArray(values)||values.some(v=>!HISTORY_CATEGORIES.includes(v)))throw new Error('Categorias de histórico inválidas.');
  return [...new Set(values)];
}
function redacted(value) {
  if(Array.isArray(value))return value.slice(0,100).map(redacted);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/password|senha|token|secret|session|credential|qr|authorization|base64|private.?key|api.?key|encryption.?key|hash|salt|digest/i.test(key)).map(([key,val])=>[key,redacted(val)]));
  if(typeof value==='string')return value.slice(0,16000).replace(/(Bearer\s+)[\w.\-]+/gi,'$1[omitido]').replace(/((?:password|senha|token|secret|authorization)\s*[:=]\s*)[^\s,;]+/gi,'$1[omitido]');
  return value;
}

async function createStore(dir,options={}) {
  fs.mkdirSync(dir,{recursive:true});
  const filename=path.join(dir,'mega.sqlite'),existed=fs.existsSync(filename);
  const db=new DatabaseSync(filename,{timeout:5000});
  let closed=false,persistenceFailed=false,transactionDepth=0,writesSinceRetention=0;
  const statements=new Map();
  const prepared=sql=>{let st=statements.get(sql);if(!st){st=db.prepare(sql);if(statements.size>=128)statements.delete(statements.keys().next().value);statements.set(sql,st);}return st;};
  const one=(table,id)=>{const row=prepared(`SELECT data FROM ${table} WHERE id=?`).get(id);return row?JSON.parse(row.data):undefined;};
  const all=table=>parseRows(prepared(`SELECT data FROM ${table} ORDER BY rowid`).all());
  const assertWritable=()=>{if(closed)throw new Error('Banco fechado.');if(persistenceFailed)throw new Error('Armazenamento indisponível. Os envios foram bloqueados; corrija o espaço ou as permissões e reabra o aplicativo.');};
  const isStorageError=error=>['ENOSPC','EIO','EROFS','EACCES'].includes(error?.code)||(error?.code==='ERR_SQLITE_ERROR'&&![19,5,6].includes((error.errcode||0)&255));
  function transaction(callback) {
    assertWritable();if(transactionDepth)return callback();
    try {
      options.beforeWrite?.();db.exec('BEGIN IMMEDIATE');transactionDepth++;
      let value;
      try{value=callback();if(value?.then)throw new Error('A transação deve ser síncrona.');db.exec('COMMIT');}
      catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
      finally{transactionDepth--;}
      return value;
    }catch(error){if(isStorageError(error)||error?.storageFailure===true)persistenceFailed=true;throw error;}
  }
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
    const version=Number(db.prepare('PRAGMA user_version').get().user_version);
    if(version>SCHEMA_VERSION)throw new Error('Este banco pertence a uma versão mais recente do Mega Disparos. Atualize o aplicativo.');
    if(existed&&version<SCHEMA_VERSION){
      db.exec('PRAGMA wal_checkpoint(FULL)');
      const backupDir=path.join(dir,'backups');fs.mkdirSync(backupDir,{recursive:true});
      fs.copyFileSync(filename,path.join(backupDir,`antes-migracao-v${SCHEMA_VERSION}-${Date.now()}-${randomUUID()}.sqlite`));
    }
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=1000;');
    if(version<SCHEMA_VERSION)transaction(()=>{
      if(version<4){
      for(const table of ['settings','campaigns','groups_data','media','templates','rounds'])db.exec(`CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY,data TEXT NOT NULL)`);
      db.exec('CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,roundId TEXT NOT NULL,campaignId TEXT NOT NULL,groupId TEXT NOT NULL,itemId TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(roundId,groupId,itemId));');
      const addColumns=(table,columns)=>{const present=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r=>r.name));for(const[name,type]of Object.entries(columns))if(!present.has(name))db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);};
      addColumns('rounds',{campaignId:'TEXT',startedAt:'INTEGER',finishedAt:'INTEGER',status:'TEXT',dayKey:'TEXT'});
      addColumns('jobs',{createdAt:'INTEGER',firstAttemptAt:'INTEGER',resultAt:'INTEGER',attempts:'INTEGER NOT NULL DEFAULT 0',messageId:'TEXT',dayKey:'TEXT'});
      for(const table of ENTITY_TABLES)db.exec(`CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT);
        CREATE INDEX IF NOT EXISTS ${table}_created ON ${table}(createdAt DESC);
        CREATE INDEX IF NOT EXISTS ${table}_campaign ON ${table}(campaignId,createdAt DESC);
        CREATE INDEX IF NOT EXISTS ${table}_user ON ${table}(userId,createdAt DESC);
        CREATE INDEX IF NOT EXISTS ${table}_status ON ${table}(status,createdAt DESC);`);
      db.exec(`CREATE TABLE IF NOT EXISTS history(id TEXT PRIMARY KEY,category TEXT NOT NULL,sourceId TEXT NOT NULL,campaignId TEXT,userId TEXT,createdAt INTEGER NOT NULL,status TEXT,data TEXT NOT NULL,UNIQUE(category,sourceId));
        CREATE TABLE IF NOT EXISTS group_rounds(campaignId TEXT NOT NULL,groupId TEXT NOT NULL,roundId TEXT NOT NULL,startedAt INTEGER NOT NULL,PRIMARY KEY(campaignId,groupId,roundId));
        CREATE TABLE IF NOT EXISTS group_progress(campaignId TEXT NOT NULL,groupId TEXT NOT NULL,lastAt INTEGER NOT NULL,roundCount INTEGER NOT NULL,PRIMARY KEY(campaignId,groupId));
        CREATE INDEX IF NOT EXISTS history_category_time ON history(category,createdAt DESC);
        CREATE INDEX IF NOT EXISTS history_campaign_time ON history(campaignId,createdAt DESC);
        CREATE INDEX IF NOT EXISTS history_status_time ON history(status,createdAt DESC);
        CREATE INDEX IF NOT EXISTS jobs_campaign_status ON jobs(campaignId,status);
        CREATE INDEX IF NOT EXISTS jobs_round_status ON jobs(roundId,status);
        CREATE INDEX IF NOT EXISTS jobs_message ON jobs(messageId,status);
        CREATE INDEX IF NOT EXISTS jobs_campaign_day ON jobs(campaignId,dayKey,attempts);
        CREATE INDEX IF NOT EXISTS jobs_group ON jobs(campaignId,groupId,roundId);
        CREATE INDEX IF NOT EXISTS jobs_created ON jobs(createdAt DESC);
        CREATE INDEX IF NOT EXISTS rounds_campaign_day ON rounds(campaignId,dayKey);
        CREATE INDEX IF NOT EXISTS rounds_campaign_start ON rounds(campaignId,startedAt);
        CREATE INDEX IF NOT EXISTS campaigns_owner ON campaigns(json_extract(data,'$.ownerId'));
        CREATE INDEX IF NOT EXISTS campaigns_state ON campaigns(json_extract(data,'$.state'));
        CREATE INDEX IF NOT EXISTS alerts_pending_due ON alerts(status,COALESCE(json_extract(data,'$.nextAttemptAt'),0),json_extract(data,'$.channel'),createdAt);
        CREATE INDEX IF NOT EXISTS alerts_message_status ON alerts(json_extract(data,'$.messageId'),status);
        CREATE TRIGGER IF NOT EXISTS audit_immutable_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'Auditoria imutável'); END;
        CREATE TRIGGER IF NOT EXISTS audit_immutable_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'Auditoria imutável'); END;`);
      const updateRound=db.prepare('UPDATE rounds SET campaignId=?,startedAt=?,finishedAt=?,status=?,dayKey=?,data=? WHERE id=?');
      const updateJob=db.prepare('UPDATE jobs SET createdAt=?,firstAttemptAt=?,resultAt=?,attempts=?,messageId=?,dayKey=? WHERE id=?');
      for(const row of db.prepare('SELECT id,data FROM rounds').iterate()){const r=JSON.parse(row.data);updateRound.run(r.campaignId??null,r.startedAt??0,r.finishedAt??null,r.status??null,localDay(r.startedAt||0),json(r),r.id);}
      for(const row of db.prepare('SELECT id,data FROM jobs').iterate()){const j=JSON.parse(row.data);updateJob.run(j.createdAt??0,j.firstAttemptAt??null,j.resultAt??null,j.attempts||0,j.messageId??null,localDay(j.firstAttemptAt??j.createdAt??0),j.id);}
      db.exec(`INSERT OR IGNORE INTO group_rounds(campaignId,groupId,roundId,startedAt) SELECT j.campaignId,j.groupId,j.roundId,r.startedAt FROM jobs j JOIN rounds r ON r.id=j.roundId WHERE j.attempts>0 OR j.status IN('confirmed','uncertain','sending');
        INSERT INTO group_progress(campaignId,groupId,lastAt,roundCount) SELECT campaignId,groupId,MAX(startedAt),COUNT(*) FROM group_rounds GROUP BY campaignId,groupId ON CONFLICT(campaignId,groupId) DO UPDATE SET lastAt=excluded.lastAt,roundCount=excluded.roundCount;`);
      for(const c of all('campaigns'))if(!Number.isInteger(c.configRevision))prepared('UPDATE campaigns SET data=? WHERE id=?').run(json({...c,configRevision:c.revision||1}),c.id);
      }
      createSearchSchema(db);
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    });
  }catch(error){db.close();throw error;}
  const putRaw=(table,value)=>{if(!value?.id||typeof value.id!=='string')throw new Error('Identificador obrigatório.');prepared(`INSERT INTO ${table}(id,data)VALUES(?,?) ON CONFLICT(id)DO UPDATE SET data=excluded.data`).run(value.id,json(value));return value;};
  const put=(table,value)=>transaction(()=>putRaw(table,value));
  const remove=(table,id)=>transaction(()=>prepared(`DELETE FROM ${table} WHERE id=?`).run(id));
  const getSetting=(id,fallback)=>one('settings',id)?.value??fallback;
  function projection(category,sourceId,value) {
    const data={...value,category},time=Number(value.at??value.resultAt??value.createdAt??value.startedAt??Date.now());
    prepared(`INSERT INTO history(id,category,sourceId,campaignId,userId,createdAt,status,data)VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(category,sourceId)DO UPDATE SET campaignId=excluded.campaignId,userId=excluded.userId,createdAt=excluded.createdAt,status=excluded.status,data=excluded.data`).run(`${category}:${sourceId}`,category,sourceId,value.campaignId??null,value.userId??value.actorId??null,time,value.status??null,json(data));
    if(++writesSinceRetention>=100){writesSinceRetention=0;retentionRaw();}
  }
  function retentionRaw(config={}) {
    const setting=getSetting('retention',{});
    const megabytes=config.maxMegabytes??setting.maxMegabytes;
    const days=clamp(config.days??setting.days??getSetting('historyRetentionDays',30),30,3650),maxRows=clamp(config.maxRows??config.maxEntries??setting.maxRows??setting.maxEntries??getSetting('historyMaxRows',10000),10000,1000000),maxBytes=clamp(config.maxBytes??setting.maxBytes??(megabytes===undefined?undefined:Math.floor(Number(megabytes)*1048576))??getSetting('historyMaxBytes',10485760),10485760,1073741824);
    for(const table of ['history','diagnostics','notifications']){
      if(days)prepared(`DELETE FROM ${table} WHERE createdAt<?`).run(Date.now()-days*86400000);
      if(maxRows)prepared(`DELETE FROM ${table} WHERE id IN(SELECT id FROM ${table} ORDER BY createdAt DESC,rowid DESC LIMIT -1 OFFSET ?)`).run(maxRows);
      if(maxBytes)prepared(`DELETE FROM ${table} WHERE id IN(SELECT id FROM(SELECT id,SUM(length(CAST(data AS BLOB))) OVER(ORDER BY createdAt DESC,rowid DESC)AS size FROM ${table})WHERE size>?)`).run(maxBytes);
    }
  }
  function roundRaw(r) {
    if(!r?.id)throw new Error('Identificador obrigatório.');
    prepared(`INSERT INTO rounds(id,data,campaignId,startedAt,finishedAt,status,dayKey)VALUES(?,?,?,?,?,?,?) ON CONFLICT(id)DO UPDATE SET data=excluded.data,campaignId=excluded.campaignId,startedAt=excluded.startedAt,finishedAt=excluded.finishedAt,status=excluded.status,dayKey=excluded.dayKey`).run(r.id,json(r),r.campaignId??null,r.startedAt??0,r.finishedAt??null,r.status??null,localDay(r.startedAt||0));
    projection('campaigns',`round:${r.id}`,{...r,kind:'round'});return r;
  }
  function jobRaw(j) {
    if(!j?.id)throw new Error('Identificador obrigatório.');
    const old=one('jobs',j.id);if(old?.status==='confirmed'&&j.status!=='confirmed')throw new Error('Um envio confirmado não pode voltar à fila.');
    if(old&&['roundId','campaignId','groupId','itemId'].some(key=>old[key]!==j[key]))throw new Error('A identidade operacional do envio não pode ser alterada.');
    if(old?.status==='uncertain'&&['queued','sending','accepted'].includes(j.status))throw new Error('Um envio incerto precisa de revisão e não pode voltar à fila.');
    prepared(`INSERT INTO jobs(id,roundId,campaignId,groupId,itemId,status,data,createdAt,firstAttemptAt,resultAt,attempts,messageId,dayKey)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id)DO UPDATE SET status=excluded.status,data=excluded.data,createdAt=excluded.createdAt,firstAttemptAt=excluded.firstAttemptAt,resultAt=excluded.resultAt,attempts=excluded.attempts,messageId=excluded.messageId,dayKey=excluded.dayKey`).run(j.id,j.roundId,j.campaignId,j.groupId,j.itemId,j.status,json(j),j.createdAt??0,j.firstAttemptAt??null,j.resultAt??null,j.attempts||0,j.messageId??null,localDay(j.firstAttemptAt??j.createdAt??0));
    if(j.attempts>0||['confirmed','uncertain','sending'].includes(j.status)){
      const r=prepared('SELECT startedAt FROM rounds WHERE id=?').get(j.roundId);
      if(r){const added=prepared('INSERT OR IGNORE INTO group_rounds(campaignId,groupId,roundId,startedAt)VALUES(?,?,?,?)').run(j.campaignId,j.groupId,j.roundId,r.startedAt);if(added.changes)prepared('INSERT INTO group_progress(campaignId,groupId,lastAt,roundCount)VALUES(?,?,?,1) ON CONFLICT(campaignId,groupId)DO UPDATE SET lastAt=MAX(lastAt,excluded.lastAt),roundCount=roundCount+1').run(j.campaignId,j.groupId,r.startedAt);}
    }
    projection('sends',j.id,j);return j;
  }
  const entityTable=table=>{if(!ENTITY_TABLES.has(table))throw new Error('Coleção inválida.');return table;};
  function entityRaw(table,value,immutable=false) {
    entityTable(table);if(!value?.id)throw new Error('Identificador obrigatório.');
    const time=Number(value.createdAt??value.at??Date.now()),suffix=immutable?'':' ON CONFLICT(id)DO UPDATE SET data=excluded.data,createdAt=excluded.createdAt,campaignId=excluded.campaignId,userId=excluded.userId,status=excluded.status,kind=excluded.kind';
    prepared(`INSERT INTO ${table}(id,data,createdAt,campaignId,userId,status,kind)VALUES(?,?,?,?,?,?,?)${suffix}`).run(value.id,json(value),time,value.campaignId??null,value.userId??value.actorId??null,value.status??null,value.kind??value.action??value.event??null);
    if(table==='diagnostics')projection('errors',value.id,value);
    if(table==='notifications')projection('notifications',value.id,value);
    return value;
  }
  function queryFilter(filter={},allowed={}) {
    const where=[],params=[];
    for(const[key,column]of Object.entries(allowed))if(filter[key]!==undefined&&filter[key]!==null){const values=Array.isArray(filter[key])?filter[key]:[filter[key]],global=filter.includeGlobal&&column==='campaignId';if(!values.length){where.push(global?'campaignId IS NULL':'0');continue;}where.push(`${global?'(':''}${column} IN(${values.map(()=>'?').join(',')})${global?' OR campaignId IS NULL)':''}`);params.push(...values);}
    if(filter.from!==undefined&&filter.from!==''){where.push('createdAt>=?');params.push(filterTimestamp(filter.from));}
    if(filter.to!==undefined&&filter.to!==''){where.push('createdAt<=?');params.push(filterTimestamp(filter.to,true));}
    if(filter.search){where.push("data LIKE ? ESCAPE '\\'");params.push(`%${String(filter.search).slice(0,200).replace(/[\\%_]/g,'\\$&')}%`);}
    return {sql:where.length?' WHERE '+where.join(' AND '):'',params};
  }
  function historyPage(filter={},maximum=500) {
    const cats=categories(filter.categories??(filter.category?[filter.category]:undefined)),limit=clamp(filter.limit,50,maximum),offset=clamp(filter.offset,0,10000000);
    const f=queryFilter({...filter,categories:cats},{categories:'category',campaignIds:'campaignId',campaignId:'campaignId',status:'status',userId:'userId'});
    const total=Number(prepared(`SELECT COUNT(*)AS n FROM history${f.sql}`).get(...f.params).n);
    const items=parseRows(prepared(`SELECT data FROM history${f.sql} ORDER BY createdAt DESC,rowid DESC LIMIT ? OFFSET ?`).all(...f.params,limit,offset));
    return {items,total,limit,offset};
  }
  const entityFilter=filter=>queryFilter(filter,{campaignId:'campaignId',campaignIds:'campaignId',userId:'userId',actorId:'userId',status:'status',kind:'kind',ids:'id',code:"json_extract(data,'$.code')",stage:"json_extract(data,'$.stage')"});
  const store={
    dir,filename,schemaVersion:SCHEMA_VERSION,get persistenceFailed(){return persistenceFailed;},transaction,
    getSetting,setSetting:(id,value)=>put('settings',{id,value}),
    listCampaigns(filter={}){const where=[],params=[];if(filter.ownerId){where.push("json_extract(data,'$.ownerId')=?");params.push(filter.ownerId);}if(filter.ids){if(!filter.ids.length)return [];where.push(`id IN(${filter.ids.map(()=>'?').join(',')})`);params.push(...filter.ids);}return parseRows(prepared(`SELECT data FROM campaigns${where.length?' WHERE '+where.join(' AND '):''} ORDER BY rowid`).all(...params));},
    getCampaign:id=>one('campaigns',id),
    saveCampaign(c){return transaction(()=>{const old=one('campaigns',c.id),changed=!old||configurationFingerprint(old)!==configurationFingerprint(c);const result={...c,revision:(old?.revision||0)+1,configRevision:(old?.configRevision||old?.revision||0)+(changed?1:0)};putRaw('campaigns',result);if(changed||old?.state!==c.state)projection('campaigns',randomUUID(),{id:randomUUID(),campaignId:c.id,userId:c.lastActorId??c.ownerId??null,at:Date.now(),kind:!old?'created':changed?'edited':c.state,status:c.state,name:c.name});return result;});},
    deleteCampaign(id){return transaction(()=>{const c=one('campaigns',id);prepared('DELETE FROM campaigns WHERE id=?').run(id);if(c)projection('campaigns',randomUUID(),{id:randomUUID(),campaignId:id,at:Date.now(),kind:'deleted',name:c.name});});},
    listGroups:()=>all('groups_data'),getGroup:id=>one('groups_data',id),
    upsertGroups(groups){return transaction(()=>{for(const g of groups){const old=one('groups_data',g.id);putRaw('groups_data',{...old,...g,authorized:old?.authorized??!!g.authorized});}});},
    authorizeGroup(id,authorized){const g=one('groups_data',id);if(!g)throw new Error('Grupo não encontrado.');return put('groups_data',{...g,authorized:!!authorized});},
    listMedia:()=>all('media'),getMedia:id=>one('media',id),saveMedia:m=>put('media',m),
    listTemplates:()=>all('templates'),saveTemplate:t=>put('templates',t),deleteTemplate:id=>remove('templates',id),
    insertRound:r=>transaction(()=>roundRaw(r)),
    updateRound(id,patch){const r=one('rounds',id);if(!r)throw new Error('Rodada não encontrada.');return transaction(()=>roundRaw({...r,...patch}));},
    listRounds(id){return parseRows(prepared(`SELECT data FROM rounds${id?' WHERE campaignId=?':''} ORDER BY rowid`).all(...(id?[id]:[])));},
    insertJob:j=>transaction(()=>jobRaw(j)),
    updateJob(id,patch){const j=one('jobs',id);if(!j)throw new Error('Envio não encontrado.');return transaction(()=>jobRaw({...j,...patch}));},
    getJob:id=>one('jobs',id),
    listJobs(filter={}){const f=queryFilter(filter,{campaignId:'campaignId',campaignIds:'campaignId',roundId:'roundId',status:'status',messageId:'messageId',groupId:'groupId'}),limited=filter.limit!==undefined;return parseRows(prepared(`SELECT data FROM jobs${f.sql}${limited?' ORDER BY rowid DESC LIMIT ? OFFSET ?':' ORDER BY rowid'}`).all(...f.params,...(limited?[clamp(filter.limit,50,1000000),clamp(filter.offset,0,10000000)]:[])));},
    queryJobs(filter={}){const f=queryFilter(filter,{campaignId:'campaignId',campaignIds:'campaignId',roundId:'roundId',status:'status',messageId:'messageId',groupId:'groupId'}),limit=clamp(filter.limit,50,500),offset=clamp(filter.offset,0,10000000);return {items:store.listJobs({...filter,limit,offset}),total:Number(prepared(`SELECT COUNT(*)AS n FROM jobs${f.sql}`).get(...f.params).n),limit,offset};},
    listOperationalReviews(filter={}){return store.queryJobs({...filter,status:'uncertain'});},
    getCampaignCounts(campaignId,at){const day=localDay(at);return {rounds:Number(prepared('SELECT COUNT(*)AS n FROM rounds WHERE campaignId=? AND dayKey=?').get(campaignId,day).n),sends:Number(prepared('SELECT COUNT(*)AS n FROM jobs WHERE campaignId=? AND dayKey=? AND attempts>0').get(campaignId,day).n)};},
    getGroupHistory(campaignId){return new Map(prepared('SELECT groupId,lastAt,roundCount FROM group_progress WHERE campaignId=?').all(campaignId).map(r=>[r.groupId,{lastAt:r.lastAt,roundCount:Number(r.roundCount)}]));},
    getMetrics({campaignIds}={}){const campaigns=store.listCampaigns(campaignIds?{ids:campaignIds}:{}),f=queryFilter({campaignId:campaignIds},{campaignId:'campaignId'}),counts={};for(const row of prepared(`SELECT status,COUNT(*)AS n FROM jobs${f.sql} GROUP BY status`).all(...f.params))counts[row.status]=Number(row.n);const next=campaigns.filter(c=>c.state==='active'&&c.nextRunAt).map(c=>c.nextRunAt);return {campaigns:campaigns.length,activeCampaigns:campaigns.filter(c=>c.state==='active').length,selectedGroups:new Set(campaigns.flatMap(c=>c.groupIds||[])).size,confirmed:counts.confirmed||0,pending:(counts.queued||0)+(counts.sending||0)+(counts.accepted||0),uncertain:counts.uncertain||0,failed:counts.failed||0,nextRunAt:next.length?Math.min(...next):null};},
    recoverInterrupted(){return transaction(()=>{const affected=new Set();for(const j of store.listJobs({status:['sending','accepted','queued']})){jobRaw({...j,status:j.status==='queued'?'cancelled':'uncertain',resultAt:Date.now(),error:j.status==='queued'?'Fila anterior cancelada na inicialização; sem recuperação de rodadas atrasadas.':'Aplicativo encerrado durante o envio; revise sem reenviar automaticamente.'});affected.add(j.campaignId);}for(const row of prepared('SELECT data FROM rounds WHERE finishedAt IS NULL').all()){const r=JSON.parse(row.data);roundRaw({...r,finishedAt:Date.now(),status:'interrupted'});}for(const c of store.listCampaigns())if(c.state==='active')putRaw('campaigns',{...c,state:'paused',nextRunAt:null,revision:c.revision+1,pauseReason:affected.has(c.id)?'Fila interrompida; verifique o histórico.':'Reabertura do aplicativo: retome após conferir a conexão.'});return [...affected];});},
    getEntity:(table,id)=>one(entityTable(table),id),
    listEntities(table,filter={}){entityTable(table);const f=entityFilter(filter),page=filter.limit!==undefined;return parseRows(prepared(`SELECT data FROM ${table}${f.sql} ORDER BY createdAt DESC,rowid DESC${page?' LIMIT ? OFFSET ?':''}`).all(...f.params,...(page?[clamp(filter.limit,50,1000000),clamp(filter.offset,0,10000000)]:[])));},
    queryEntities(table,filter={}){entityTable(table);const f=entityFilter(filter),limit=clamp(filter.limit,50,500),offset=clamp(filter.offset,0,10000000);return {items:store.listEntities(table,{...filter,limit,offset}),total:Number(prepared(`SELECT COUNT(*)AS n FROM ${table}${f.sql}`).get(...f.params).n),limit,offset};},
    saveEntity(table,value){return transaction(()=>entityRaw(table,value,table==='audit'||table==='diagnostics'));},
    deleteEntity(table,id){entityTable(table);if(table==='audit')throw new Error('Auditoria imutável.');return remove(table,id);},
    addAudit(record){const value={...redacted(record),id:record.id||randomUUID(),at:record.at??Date.now()};return transaction(()=>entityRaw('audit',value,true));},
    addDiagnostic(record){const value={...redacted(record),id:record.id||randomUUID(),at:record.at??Date.now()};return transaction(()=>entityRaw('diagnostics',value,true));},
    saveNotification(record){const value={...redacted(record),id:record.id||randomUUID(),at:record.at??Date.now()};return transaction(()=>entityRaw('notifications',value));},
    listHistory:filter=>historyPage(filter),
    exportHistory(filter={}){return {...historyPage({...filter,limit:filter.limit??100000,offset:filter.offset??0},100000),exportedAt:new Date().toISOString()};},
    cleanupPreview(input){const cats=categories(Array.isArray(input)?input:input?.categories),counts=Object.fromEntries(cats.map(c=>[c,Number(prepared('SELECT COUNT(*)AS n FROM history WHERE category=?').get(c).n)]));return {categories:cats,counts,total:Object.values(counts).reduce((a,b)=>a+b,0)};},
    clearHistory({categories:input,actor}={}){return transaction(()=>{const preview=store.cleanupPreview(input);for(const category of preview.categories){prepared('DELETE FROM history WHERE category=?').run(category);if(category==='errors')db.exec('DELETE FROM diagnostics');if(category==='notifications')db.exec('DELETE FROM notifications');}const audit=store.addAudit({actorId:typeof actor==='string'?actor:actor?.id??actor?.userId??null,actorName:actor?.name??null,action:'history.clear',at:Date.now(),detail:{categories:preview.categories,counts:preview.counts},preserved:'operational jobs, rounds, alerts, users, campaigns, media and audit'});return {...preview,auditId:audit.id};});},
    applyHistoryRetention:config=>transaction(()=>retentionRaw(config)),applyRetention:config=>transaction(()=>retentionRaw(config)),
    exportData(){return {format:'mega-disparos',version:1,createdAt:new Date().toISOString(),campaigns:all('campaigns'),groups:all('groups_data'),templates:all('templates'),contacts:all('contacts'),alertRecipients:all('alert_recipients'),settings:all('settings').filter(s=>!PRIVATE_SETTING.test(s.id)),media:all('media')};},
    importData(data){data=require('./backup-validation.cjs').validateBackupData(data);return transaction(()=>{const localSettings=all('settings').filter(s=>PRIVATE_SETTING.test(s.id)&&s.id!=='integrationMode');for(const table of ['campaigns','groups_data','templates','media','settings','contacts','alert_recipients'])db.exec(`DELETE FROM ${table}`);for(const c of data.campaigns)putRaw('campaigns',{...c,state:'draft',nextRunAt:null,revision:(c.revision||0)+1,configRevision:(c.configRevision||c.revision||0)+1});for(const g of data.groups)putRaw('groups_data',g);for(const t of data.templates||[])putRaw('templates',t);for(const m of data.media||[])putRaw('media',m);for(const c of data.contacts||[])entityRaw('contacts',c);for(const r of data.alertRecipients||[])entityRaw('alert_recipients',r);for(const s of data.settings||[])if(!PRIVATE_SETTING.test(s.id))putRaw('settings',s);for(const s of localSettings)putRaw('settings',s);putRaw('settings',{id:'integrationMode',value:'simulated'});putRaw('settings',{id:'initialized',value:true});});},
    close(){if(!closed){try{if(!persistenceFailed)db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}finally{db.close();closed=true;statements.clear();}}}
  };
  Object.assign(store,{listUsers:filter=>store.listEntities('users',filter),saveAlert:value=>store.saveEntity('alerts',value),getAlert:id=>store.getEntity('alerts',id),listAlerts:filter=>store.listEntities('alerts',filter),updateAlert:(id,patch)=>{const old=store.getAlert(id);if(!old)throw new Error('Alerta não encontrado.');return store.saveAlert({...old,...patch});},saveAlertRecipient:value=>store.saveEntity('alert_recipients',value),getAlertRecipient:id=>store.getEntity('alert_recipients',id),listAlertRecipients:filter=>store.listEntities('alert_recipients',filter),deleteAlertRecipient:id=>store.deleteEntity('alert_recipients',id),
    listPendingAlerts({at=Date.now(),channel,limit=50}={}){return parseRows(prepared(`SELECT data FROM alerts WHERE status='pending' AND COALESCE(json_extract(data,'$.nextAttemptAt'),0)<=?${channel?" AND json_extract(data,'$.channel')=?":''} ORDER BY createdAt ASC,rowid ASC LIMIT ?`).all(at,...(channel?[channel]:[]),clamp(limit,50,500)));},
    findAlertsByMessageId(messageId){return parseRows(prepared("SELECT data FROM alerts WHERE json_extract(data,'$.messageId')=? AND status='uncertain' LIMIT 10").all(messageId));}
  });
  // This one-time migration marker preserves deliberately cleared histories.
  if(!getSetting('historyProjectionInitialized',false))transaction(()=>{for(const row of prepared('SELECT data FROM jobs ORDER BY rowid DESC LIMIT 10000').all()){const j=JSON.parse(row.data);projection('sends',j.id,j);}for(const row of prepared('SELECT data FROM rounds ORDER BY rowid DESC LIMIT 10000').all()){const r=JSON.parse(row.data);projection('campaigns',`round:${r.id}`,{...r,kind:'round'});}putRaw('settings',{id:'historyProjectionInitialized',value:true});retentionRaw();});
  attachSearchStore(store,{db,prepared,transaction});
  return store;
}
function seed(store) {
  if(store.getSetting('initialized',false))return;
  store.transaction(()=>{
    for(const[key,value]of Object.entries({integrationMode:'simulated',admins:[],theme:'dark',maxSelectedGroups:15,launchAtLogin:false,closeBehavior:'ask',minimizeToTray:true,unofficialAcknowledged:false,historyRetentionDays:30,historyMaxRows:10000,historyMaxBytes:10485760}))store.setSetting(key,value);
    const groups=Array.from({length:15},(_,i)=>({id:`sim-${String(i+1).padStart(2,'0')}@simulation`,name:`Grupo de exemplo ${String(i+1).padStart(2,'0')}`,authorized:true,simulation:true}));store.upsertGroups(groups);
    store.saveCampaign({id:randomUUID(),name:'Exemplo • 15 grupos a cada 10 minutos',state:'draft',mode:'repeat',intervalMinutes:10,spacingSeconds:5,schedule:{days:[0,1,2,3,4,5,6],startTime:'08:00',endTime:'18:00',startDate:'',endDate:''},dailyRoundLimit:0,dailySendLimit:0,groupIds:groups.map(g=>g.id),items:[{id:randomUUID(),type:'text',text:'Olá, pessoal! 👋\n\n*Mensagem de exemplo do Mega Disparos*\nEsta campanha está desativada e utiliza apenas grupos simulados.\nhttps://www.whatsapp.com/'}],groupOverrides:{},nextRunAt:null,roundIndex:0});store.setSetting('initialized',true);
  });
}
module.exports={createStore,atomicWrite,seed,HISTORY_CATEGORIES};
