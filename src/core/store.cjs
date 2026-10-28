'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { configurationFingerprint } = require('./campaign-version.cjs');
const { createSearchSchema, attachSearchStore } = require('./search-store.cjs');

const ENTITY_TABLES = new Set(['users','roles','recovery_tokens','audit','diagnostics','notifications','alerts','alert_recipients','contacts','reminders','reminder_deliveries','contact_pending','contact_intake_events']);
const HISTORY_CATEGORIES = ['campaigns','sends','errors','notifications'];
const SCHEMA_VERSION = 7;
const SHARED_TABLES = new Set(['settings','users','roles','recovery_tokens']);
const MODE_SETTING = /^(buscas|search)|^recentCommandIds$|^systemAlertRecipientIds$|^automationState$/i;
const PRIVATE_SETTING = /secret|cred|session|qr|recentCommand|^mode:|^integrationMode$|^audioAssets$|^webhook$|^independentAlertChannel$|password|auth|recovery|^(login|lockout|buscas|search)/i;

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
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/password|senha|token|secret|session|credential|qr|authorization|base64|private.?key|api.?key|encryption.?key|hash|salt|digest|reply.?proof/i.test(key)).map(([key,val])=>[key,redacted(val)]));
  if(typeof value==='string')return value.slice(0,16000).replace(/(Bearer\s+)[\w.\-]+/gi,'$1[omitido]').replace(/((?:password|senha|token|secret|authorization)\s*[:=]\s*)[^\s,;]+/gi,'$1[omitido]');
  return value;
}

async function createStore(dir,options={}) {
  fs.mkdirSync(dir,{recursive:true});
  const filename=path.join(dir,'mega.sqlite'),existed=fs.existsSync(filename);
  const db=new DatabaseSync(filename,{timeout:5000});
  let closed=false,persistenceFailed=false,transactionDepth=0,writesSinceRetention=0,modeIsolationReady=false,upgradeBackup=null;
  const statements=new Map();
  const prepared=sql=>{let st=statements.get(sql);if(!st){st=db.prepare(sql);if(statements.size>=128)statements.delete(statements.keys().next().value);statements.set(sql,st);}return st;};
  const storageMode=()=>{const row=prepared("SELECT data FROM settings WHERE id='integrationMode'").get();return row&&JSON.parse(row.data).value==='simulated'?'simulated':'whatsapp';};
  const isolated=table=>modeIsolationReady&&!SHARED_TABLES.has(table);
  const modeClause=table=>isolated(table)?' AND storageMode=?':'';
  const modeParams=table=>isolated(table)?[storageMode()]:[];
  const oneRaw=(table,id)=>{if(typeof id!=='string'||!id)return undefined;const row=prepared(`SELECT data FROM ${table} WHERE id=?`).get(id);return row?JSON.parse(row.data):undefined;};
  const one=(table,id)=>{if(typeof id!=='string'||!id)return undefined;const row=prepared(`SELECT data FROM ${table} WHERE id=?${modeClause(table)}`).get(id,...modeParams(table));return row?JSON.parse(row.data):undefined;};
  const all=table=>parseRows(prepared(`SELECT data FROM ${table}${isolated(table)?' WHERE storageMode=?':''} ORDER BY rowid`).all(...modeParams(table)));
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
    if(version>SCHEMA_VERSION)throw new Error('Este banco pertence a uma versão mais recente do Kenned Code Disparos. Atualize o aplicativo.');
    if(existed&&options.upgradeVersion){
      const hasSettings=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get();
      const previous=hasSettings?db.prepare("SELECT data FROM settings WHERE id='lastAppUpgradeVersion'").get():null;
      let previousVersion;try{previousVersion=previous&&JSON.parse(previous.data).value;}catch{}
      if(previousVersion!==options.upgradeVersion){
        const backupDir=path.join(dir,'backups');fs.mkdirSync(backupDir,{recursive:true,mode:0o700});
        const target=path.join(backupDir,`antes-atualizacao-${String(options.upgradeVersion).replace(/[^a-zA-Z0-9.-]/g,'')}-${Date.now()}-${randomUUID()}.sqlite`);
        db.exec('PRAGMA wal_checkpoint(FULL)');db.prepare('VACUUM INTO ?').run(target);fs.chmodSync(target,0o600);
        const check=new DatabaseSync(target,{readOnly:true});try{if(check.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw new Error('O backup anterior à atualização não passou na verificação.');}finally{check.close();}
        upgradeBackup={path:target,createdAt:Date.now(),schemaVersion:version,reason:'Antes de atualização do aplicativo; recuperação integral do banco local.'};
      }
    }
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
      for(const table of [...ENTITY_TABLES].filter(t=>!['reminders','reminder_deliveries','contact_pending','contact_intake_events'].includes(t)))db.exec(`CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT);
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
      for(const table of ['reminders','reminder_deliveries','contact_pending','contact_intake_events'])db.exec(`CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT,storageMode TEXT NOT NULL DEFAULT 'whatsapp');
        CREATE INDEX IF NOT EXISTS ${table}_mode_status_time ON ${table}(storageMode,status,createdAt DESC);
        CREATE INDEX IF NOT EXISTS ${table}_mode_user ON ${table}(storageMode,userId,createdAt DESC);`);
      db.exec(`CREATE INDEX IF NOT EXISTS reminders_due ON reminders(storageMode,json_extract(data,'$.nextDueAt'));
        CREATE INDEX IF NOT EXISTS reminder_deliveries_due ON reminder_deliveries(storageMode,status,json_extract(data,'$.nextAttemptAt'));
        CREATE INDEX IF NOT EXISTS reminder_deliveries_message ON reminder_deliveries(storageMode,json_extract(data,'$.messageId'));
        CREATE INDEX IF NOT EXISTS contact_pending_phone ON contact_pending(storageMode,json_extract(data,'$.phone'),status);`);
      createSearchSchema(db);
      if(version<6){
        // Mode is provenance, never a guess based on a display name. Existing
        // unclassified records remain real; demonstrably simulated destinations
        // identify their campaign/operational descendants without deleting data.
        const scopedTables=['campaigns','groups_data','media','templates','rounds','jobs','history',...ENTITY_TABLES].filter(t=>!SHARED_TABLES.has(t));
        db.exec('DROP TRIGGER IF EXISTS audit_immutable_update; DROP TRIGGER IF EXISTS audit_immutable_delete;');
        for(const table of scopedTables){
          const cols=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r=>r.name));
          if(!cols.has('storageMode'))db.exec(`ALTER TABLE ${table} ADD COLUMN storageMode TEXT NOT NULL DEFAULT 'whatsapp'`);
          db.exec(`CREATE INDEX IF NOT EXISTS ${table}_mode ON ${table}(storageMode)`);
        }
        const provenMode=v=>v?.storageMode==='simulated'||v?.simulation===true?'simulated':v?.storageMode==='whatsapp'||v?.simulation===false?'whatsapp':null;
        const groups=new Map();
        for(const row of db.prepare('SELECT id,data FROM groups_data').all()){const v=JSON.parse(row.data),m=provenMode(v)||'whatsapp';groups.set(row.id,m);db.prepare('UPDATE groups_data SET storageMode=?,data=? WHERE id=?').run(m,json({...v,storageMode:m}),row.id);}
        const campaignModes=new Map();
        for(const row of db.prepare('SELECT id,data FROM campaigns').all()){
          const v=JSON.parse(row.data),m=provenMode(v)||(v.groupIds?.length&&v.groupIds.every(id=>groups.get(id)==='simulated')?'simulated':'whatsapp');
          campaignModes.set(row.id,m);db.prepare('UPDATE campaigns SET storageMode=?,data=? WHERE id=?').run(m,json({...v,storageMode:m}),row.id);
        }
        for(const table of ['group_rounds','group_progress']){
          const cols=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r=>r.name));
          if(!cols.has('storageMode'))db.exec(`ALTER TABLE ${table} ADD COLUMN storageMode TEXT NOT NULL DEFAULT 'whatsapp'`);
          for(const [id,m]of campaignModes)db.prepare(`UPDATE ${table} SET storageMode=? WHERE campaignId=?`).run(m,id);
          db.exec(`CREATE INDEX IF NOT EXISTS ${table}_mode_campaign ON ${table}(storageMode,campaignId)`);
        }
        const previousMode=storageMode();
        for(const table of scopedTables.filter(t=>!['groups_data','campaigns'].includes(t)))for(const row of db.prepare(`SELECT id,data FROM ${table}`).all()){
          const v=JSON.parse(row.data),proof=provenMode(v)||campaignModes.get(v.campaignId)||(groups.get(v.groupId)==='simulated'?'simulated':null),m=proof||'whatsapp';
          const value=table==='audit'?v:{...v,storageMode:m};
          if(!proof&&previousMode==='simulated'&&['alerts','jobs'].includes(table)&&['pending','queued','sending','accepted'].includes(v.status)){
            value.status='uncertain';value.error='Origem operacional anterior sem identificação de modo; revise antes de qualquer reenvio.';value.code='MIGRATION_MODE_REVIEW';value.retryEligible=false;value.reviewRequired=true;
          }
          db.prepare(`UPDATE ${table} SET storageMode=?,data=?${['alerts','jobs','rounds','history','notifications','diagnostics'].includes(table)?',status=?':''} WHERE id=?`).run(m,json(value),...(['alerts','jobs','rounds','history','notifications','diagnostics'].includes(table)?[value.status??null]:[]),row.id);
        }
        const oldBuscas=db.prepare("SELECT data FROM settings WHERE id='buscasSettings'").get();
        const oldBuscasValue=oldBuscas?JSON.parse(oldBuscas.data).value:null;
        const captureIds=[...(oldBuscasValue?.monitoredGroupIds||[]),...(oldBuscasValue?.commandGroupIds||[])];
        const buscasMode=provenMode(oldBuscasValue)||(captureIds.length&&captureIds.every(id=>groups.get(id)==='simulated')?'simulated':'whatsapp');
        for(const row of db.prepare('SELECT id,data FROM settings').all())if(MODE_SETTING.test(row.id)){
          const v=JSON.parse(row.data),m=/^(buscas|search)/i.test(row.id)?buscasMode:previousMode;
          db.prepare('INSERT OR IGNORE INTO settings(id,data) VALUES(?,?)').run(`mode:${m}:${row.id}`,json({...v,id:`mode:${m}:${row.id}`}));
          db.prepare('DELETE FROM settings WHERE id=?').run(row.id);
        }
        db.exec(`CREATE TABLE IF NOT EXISTS automation_outbound(id TEXT PRIMARY KEY,at INTEGER NOT NULL,storageMode TEXT NOT NULL,kind TEXT);
          CREATE INDEX IF NOT EXISTS jobs_client_message ON jobs(json_extract(data,'$.clientMessageId'));
          CREATE INDEX IF NOT EXISTS alerts_client_message ON alerts(json_extract(data,'$.clientMessageId'));
          CREATE INDEX IF NOT EXISTS history_mode_category_time ON history(storageMode,category,createdAt DESC);
          CREATE INDEX IF NOT EXISTS jobs_mode_status ON jobs(storageMode,status);
          CREATE INDEX IF NOT EXISTS diagnostics_mode_trace ON diagnostics(storageMode,json_extract(data,'$.traceId'),createdAt DESC);
          CREATE TRIGGER audit_immutable_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'Auditoria imutável'); END;
          CREATE TRIGGER audit_immutable_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'Auditoria imutável'); END;`);
      }
      db.exec("CREATE INDEX IF NOT EXISTS contacts_phone_mode ON contacts(storageMode,json_extract(data,'$.phone'));");
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    });
  }catch(error){db.close();throw error;}
  modeIsolationReady=true;
  const tagged=(table,value)=>{if(!isolated(table))return value;const old=oneRaw(table,value.id);if(old&&old.storageMode!==undefined&&old.storageMode!==storageMode())throw new Error('O registro pertence a outro modo de integração.');return {...value,storageMode:storageMode()};};
  const putRaw=(table,input)=>{if(!input?.id||typeof input.id!=='string')throw new Error('Identificador obrigatório.');const value=tagged(table,input);prepared(`INSERT INTO ${table}(id,data${isolated(table)?',storageMode':''})VALUES(?,?${isolated(table)?',?':''}) ON CONFLICT(id)DO UPDATE SET data=excluded.data`).run(value.id,json(value),...modeParams(table));return value;};
  const put=(table,value)=>transaction(()=>putRaw(table,value));
  const remove=(table,id)=>transaction(()=>prepared(`DELETE FROM ${table} WHERE id=?${modeClause(table)}`).run(id,...modeParams(table)));
  const settingKey=id=>MODE_SETTING.test(id)?`mode:${storageMode()}:${id}`:id;
  const getSetting=(id,fallback)=>one('settings',settingKey(id))?.value??fallback;
  function projection(category,sourceId,value) {
    const data={...value,category,storageMode:value.storageMode??storageMode()},time=Number(value.at??value.resultAt??value.createdAt??value.startedAt??Date.now());
    prepared(`INSERT INTO history(id,category,sourceId,campaignId,userId,createdAt,status,data,storageMode)VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(category,sourceId)DO UPDATE SET campaignId=excluded.campaignId,userId=excluded.userId,createdAt=excluded.createdAt,status=excluded.status,data=excluded.data`).run(`${category}:${sourceId}`,category,sourceId,value.campaignId??null,value.userId??value.actorId??null,time,value.status??null,json(data),data.storageMode);
    if(++writesSinceRetention>=100){writesSinceRetention=0;retentionRaw();}
  }
  function retentionRaw(config={}) {
    const setting=getSetting('retention',{});
    const megabytes=config.maxMegabytes??setting.maxMegabytes;
    const days=clamp(config.days??setting.days??getSetting('historyRetentionDays',30),30,3650),maxRows=clamp(config.maxRows??config.maxEntries??setting.maxRows??setting.maxEntries??getSetting('historyMaxRows',10000),10000,1000000),maxBytes=clamp(config.maxBytes??setting.maxBytes??(megabytes===undefined?undefined:Math.floor(Number(megabytes)*1048576))??getSetting('historyMaxBytes',10485760),10485760,1073741824);
    for(const table of ['history','diagnostics','notifications']){
      if(days)prepared(`DELETE FROM ${table} WHERE createdAt<? AND storageMode=?`).run(Date.now()-days*86400000,storageMode());
      if(maxRows)prepared(`DELETE FROM ${table} WHERE id IN(SELECT id FROM ${table} WHERE storageMode=? ORDER BY createdAt DESC,rowid DESC LIMIT -1 OFFSET ?)`).run(storageMode(),maxRows);
      if(maxBytes)prepared(`DELETE FROM ${table} WHERE id IN(SELECT id FROM(SELECT id,SUM(length(CAST(data AS BLOB))) OVER(ORDER BY createdAt DESC,rowid DESC)AS size FROM ${table} WHERE storageMode=?)WHERE size>?)`).run(storageMode(),maxBytes);
    }
  }
  function roundRaw(input) {
    const r=tagged('rounds',input);
    if(!r?.id)throw new Error('Identificador obrigatório.');
    prepared(`INSERT INTO rounds(id,data,campaignId,startedAt,finishedAt,status,dayKey,storageMode)VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id)DO UPDATE SET data=excluded.data,campaignId=excluded.campaignId,startedAt=excluded.startedAt,finishedAt=excluded.finishedAt,status=excluded.status,dayKey=excluded.dayKey`).run(r.id,json(r),r.campaignId??null,r.startedAt??0,r.finishedAt??null,r.status??null,localDay(r.startedAt||0),storageMode());
    projection('campaigns',`round:${r.id}`,{...r,kind:'round'});return r;
  }
  function jobRaw(input) {
    const j=tagged('jobs',input);
    if(!j?.id)throw new Error('Identificador obrigatório.');
    const old=one('jobs',j.id);if(old?.status==='confirmed'&&j.status!=='confirmed')throw new Error('Um envio confirmado não pode voltar à fila.');
    if(old&&['roundId','campaignId','groupId','itemId'].some(key=>old[key]!==j[key]))throw new Error('A identidade operacional do envio não pode ser alterada.');
    if(old?.status==='uncertain'&&['queued','sending','accepted'].includes(j.status))throw new Error('Um envio incerto precisa de revisão e não pode voltar à fila.');
    prepared(`INSERT INTO jobs(id,roundId,campaignId,groupId,itemId,status,data,createdAt,firstAttemptAt,resultAt,attempts,messageId,dayKey,storageMode)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id)DO UPDATE SET status=excluded.status,data=excluded.data,createdAt=excluded.createdAt,firstAttemptAt=excluded.firstAttemptAt,resultAt=excluded.resultAt,attempts=excluded.attempts,messageId=excluded.messageId,dayKey=excluded.dayKey`).run(j.id,j.roundId,j.campaignId,j.groupId,j.itemId,j.status,json(j),j.createdAt??0,j.firstAttemptAt??null,j.resultAt??null,j.attempts||0,j.messageId??null,localDay(j.firstAttemptAt??j.createdAt??0),storageMode());
    if(j.attempts>0||['confirmed','uncertain','sending'].includes(j.status)){
      const r=prepared('SELECT startedAt FROM rounds WHERE id=?').get(j.roundId);
      if(r){const added=prepared('INSERT OR IGNORE INTO group_rounds(campaignId,groupId,roundId,startedAt,storageMode)VALUES(?,?,?,?,?)').run(j.campaignId,j.groupId,j.roundId,r.startedAt,storageMode());if(added.changes)prepared('INSERT INTO group_progress(campaignId,groupId,lastAt,roundCount,storageMode)VALUES(?,?,?,1,?) ON CONFLICT(campaignId,groupId)DO UPDATE SET lastAt=MAX(lastAt,excluded.lastAt),roundCount=roundCount+1').run(j.campaignId,j.groupId,r.startedAt,storageMode());}
    }
    projection('sends',j.id,j);return j;
  }
  const entityTable=table=>{if(!ENTITY_TABLES.has(table))throw new Error('Coleção inválida.');return table;};
  function entityRaw(table,input,immutable=false) {
    const value=tagged(table,input);
    entityTable(table);if(!value?.id)throw new Error('Identificador obrigatório.');
    const time=Number(value.createdAt??value.at??Date.now()),suffix=immutable?'':' ON CONFLICT(id)DO UPDATE SET data=excluded.data,createdAt=excluded.createdAt,campaignId=excluded.campaignId,userId=excluded.userId,status=excluded.status,kind=excluded.kind';
    prepared(`INSERT INTO ${table}(id,data,createdAt,campaignId,userId,status,kind${isolated(table)?',storageMode':''})VALUES(?,?,?,?,?,?,?${isolated(table)?',?':''})${suffix}`).run(value.id,json(value),time,value.campaignId??null,value.userId??value.actorId??null,value.status??null,value.kind??value.action??value.event??null,...modeParams(table));
    if(table==='diagnostics'&&!['info','debug','warning'].includes(value.level||value.severity))projection('errors',value.id,value);
    if(table==='notifications')projection('notifications',value.id,value);
    return value;
  }
  function queryFilter(filter={},allowed={},table='history') {
    const where=[],params=[];
    if(isolated(table)){where.push('storageMode=?');params.push(storageMode());}
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
  const entityFilter=(filter,table)=>queryFilter(filter,{campaignId:'campaignId',campaignIds:'campaignId',userId:'userId',actorId:'userId',status:'status',kind:'kind',ids:'id',code:"json_extract(data,'$.code')",stage:"json_extract(data,'$.stage')",traceId:"json_extract(data,'$.traceId')"},table);
  const store={
    dir,filename,schemaVersion:SCHEMA_VERSION,upgradeBackup,get persistenceFailed(){return persistenceFailed;},transaction,
    createRecoverySnapshot(destination){
      assertWritable();if(typeof destination!=='string'||!path.isAbsolute(destination))throw new Error('Informe um caminho absoluto para o backup.');
      if(path.resolve(destination)===path.resolve(filename)||fs.existsSync(destination))throw new Error('O backup deve usar um arquivo novo, separado do banco ativo.');
      fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
      try{db.prepare('VACUUM INTO ?').run(destination);fs.chmodSync(destination,0o600);const saved=new DatabaseSync(destination,{readOnly:true});try{if(saved.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw new Error('A cópia de recuperação não passou na verificação.');}finally{saved.close();}return {path:destination,bytes:fs.statSync(destination).size,schemaVersion:SCHEMA_VERSION};}catch(error){try{fs.unlinkSync(destination);}catch{}throw error;}
    },
    getSetting,getStorageMode:storageMode,setSetting:(id,value)=>{const key=settingKey(id);return put('settings',{id:key,value});},
    listCampaigns(filter={}){const where=['storageMode=?'],params=[storageMode()];if(filter.ownerId){where.push("json_extract(data,'$.ownerId')=?");params.push(filter.ownerId);}if(filter.ids){if(!filter.ids.length)return [];where.push(`id IN(${filter.ids.map(()=>'?').join(',')})`);params.push(...filter.ids);}return parseRows(prepared(`SELECT data FROM campaigns${where.length?' WHERE '+where.join(' AND '):''} ORDER BY rowid`).all(...params));},
    getCampaign:id=>one('campaigns',id),
    saveCampaign(c){return transaction(()=>{const old=one('campaigns',c.id),changed=!old||configurationFingerprint(old)!==configurationFingerprint(c);const result={...c,revision:(old?.revision||0)+1,configRevision:(old?.configRevision||old?.revision||0)+(changed?1:0)};putRaw('campaigns',result);if(changed||old?.state!==c.state)projection('campaigns',randomUUID(),{id:randomUUID(),campaignId:c.id,userId:c.lastActorId??c.ownerId??null,at:Date.now(),kind:!old?'created':changed?'edited':c.state,status:c.state,name:c.name});return result;});},
    deleteCampaign(id){return transaction(()=>{const c=one('campaigns',id);prepared('DELETE FROM campaigns WHERE id=? AND storageMode=?').run(id,storageMode());if(c)projection('campaigns',randomUUID(),{id:randomUUID(),campaignId:id,at:Date.now(),kind:'deleted',name:c.name});});},
    listGroups:()=>all('groups_data').filter(g=>g.available!==false),getGroup:id=>{const g=one('groups_data',id);return g?.available!==false?g:undefined;},
    upsertGroups(groups){return transaction(()=>{for(const g of groups){if(g.simulation!==undefined&&Boolean(g.simulation)!==(storageMode()==='simulated'))throw new Error('O grupo pertence a outro modo de integração.');const old=one('groups_data',g.id);putRaw('groups_data',{...old,...g,available:true,simulation:storageMode()==='simulated',authorized:old?.authorized??!!g.authorized});}});},
    clearGroups(){return transaction(()=>{for(const g of all('groups_data'))putRaw('groups_data',{...g,available:false});});},
    replaceGroups(groups){return transaction(()=>{const ids=new Set(groups.map(g=>g.id));store.upsertGroups(groups);for(const g of all('groups_data'))if(!ids.has(g.id))putRaw('groups_data',{...g,available:false});return store.listGroups();});},
    authorizeGroup(id,authorized){const g=one('groups_data',id);if(!g)throw new Error('Grupo não encontrado.');return put('groups_data',{...g,authorized:!!authorized});},
    listMedia:()=>all('media'),getMedia:id=>one('media',id),getMediaAnyMode:id=>oneRaw('media',id),listMediaAnyMode:()=>parseRows(prepared('SELECT data FROM media ORDER BY rowid').all()),saveMedia:m=>put('media',m),deleteMedia:id=>remove('media',id),
    listTemplates:()=>all('templates'),getTemplate:id=>one('templates',id),saveTemplate:t=>put('templates',t),deleteTemplate:id=>remove('templates',id),
    findContactByPhone(number){return parseRows(prepared("SELECT data FROM contacts WHERE storageMode=? AND json_extract(data,'$.phone') IN(?,?) LIMIT 1").all(storageMode(),String(number),'+'+String(number)))[0];},
    insertRound:r=>transaction(()=>roundRaw(r)),
    updateRound(id,patch){const r=one('rounds',id);if(!r)throw new Error('Rodada não encontrada.');return transaction(()=>roundRaw({...r,...patch}));},
    listRounds(id){return parseRows(prepared(`SELECT data FROM rounds WHERE storageMode=?${id?' AND campaignId=?':''} ORDER BY rowid`).all(storageMode(),...(id?[id]:[])));},
    insertJob:j=>transaction(()=>jobRaw(j)),
    updateJob(id,patch){const j=one('jobs',id);if(!j)throw new Error('Envio não encontrado.');return transaction(()=>jobRaw({...j,...patch}));},
    getJob:id=>one('jobs',id),
    listJobs(filter={}){const f=queryFilter(filter,{campaignId:'campaignId',campaignIds:'campaignId',roundId:'roundId',status:'status',messageId:'messageId',groupId:'groupId'}),limited=filter.limit!==undefined;return parseRows(prepared(`SELECT data FROM jobs${f.sql}${limited?' ORDER BY rowid DESC LIMIT ? OFFSET ?':' ORDER BY rowid'}`).all(...f.params,...(limited?[clamp(filter.limit,50,1000000),clamp(filter.offset,0,10000000)]:[])));},
    queryJobs(filter={}){const f=queryFilter(filter,{campaignId:'campaignId',campaignIds:'campaignId',roundId:'roundId',status:'status',messageId:'messageId',groupId:'groupId'}),limit=clamp(filter.limit,50,500),offset=clamp(filter.offset,0,10000000);return {items:store.listJobs({...filter,limit,offset}),total:Number(prepared(`SELECT COUNT(*)AS n FROM jobs${f.sql}`).get(...f.params).n),limit,offset};},
    listOperationalReviews(filter={}){return store.queryJobs({...filter,status:'uncertain'});},
    getCampaignCounts(campaignId,at){const day=localDay(at);return {rounds:Number(prepared('SELECT COUNT(*)AS n FROM rounds WHERE campaignId=? AND dayKey=? AND storageMode=?').get(campaignId,day,storageMode()).n),sends:Number(prepared('SELECT COUNT(*)AS n FROM jobs WHERE campaignId=? AND dayKey=? AND storageMode=? AND attempts>0').get(campaignId,day,storageMode()).n)};},
    getGroupHistory(campaignId){return new Map(prepared('SELECT groupId,lastAt,roundCount FROM group_progress WHERE campaignId=? AND storageMode=?').all(campaignId,storageMode()).map(r=>[r.groupId,{lastAt:r.lastAt,roundCount:Number(r.roundCount)}]));},
    getMetrics({campaignIds}={}){const campaigns=store.listCampaigns(campaignIds?{ids:campaignIds}:{}),f=queryFilter({campaignId:campaignIds},{campaignId:'campaignId'}),counts={};for(const row of prepared(`SELECT status,COUNT(*)AS n FROM jobs${f.sql} GROUP BY status`).all(...f.params))counts[row.status]=Number(row.n);const next=campaigns.filter(c=>c.state==='active'&&c.nextRunAt).map(c=>c.nextRunAt);return {campaigns:campaigns.length,activeCampaigns:campaigns.filter(c=>c.state==='active').length,selectedGroups:new Set(campaigns.flatMap(c=>c.groupIds||[])).size,confirmed:counts.confirmed||0,pending:(counts.queued||0)+(counts.sending||0)+(counts.accepted||0),uncertain:counts.uncertain||0,failed:counts.failed||0,nextRunAt:next.length?Math.min(...next):null};},
    recoverInterrupted(){return transaction(()=>{const affected=new Set();for(const j of store.listJobs({status:['sending','accepted','queued']})){jobRaw({...j,status:j.status==='queued'?'cancelled':'uncertain',resultAt:Date.now(),error:j.status==='queued'?'Fila anterior cancelada na inicialização; sem recuperação de rodadas atrasadas.':'Aplicativo encerrado durante o envio; revise sem reenviar automaticamente.'});affected.add(j.campaignId);}for(const row of prepared('SELECT data FROM rounds WHERE finishedAt IS NULL AND storageMode=?').all(storageMode())){const r=JSON.parse(row.data);roundRaw({...r,finishedAt:Date.now(),status:'interrupted'});}for(const c of store.listCampaigns())if(c.state==='active')putRaw('campaigns',{...c,state:'paused',nextRunAt:null,revision:c.revision+1,pauseReason:affected.has(c.id)?'Fila interrompida; verifique o histórico.':'Reabertura do aplicativo: retome após conferir a conexão.'});return [...affected];});},
    getEntity:(table,id)=>one(entityTable(table),id),
    listEntities(table,filter={}){entityTable(table);const f=entityFilter(filter,table),page=filter.limit!==undefined;return parseRows(prepared(`SELECT data FROM ${table}${f.sql} ORDER BY createdAt DESC,rowid DESC${page?' LIMIT ? OFFSET ?':''}`).all(...f.params,...(page?[clamp(filter.limit,50,1000000),clamp(filter.offset,0,10000000)]:[])));},
    queryEntities(table,filter={}){entityTable(table);const f=entityFilter(filter,table),limit=clamp(filter.limit,50,500),offset=clamp(filter.offset,0,10000000);return {items:store.listEntities(table,{...filter,limit,offset}),total:Number(prepared(`SELECT COUNT(*)AS n FROM ${table}${f.sql}`).get(...f.params).n),limit,offset};},
    saveEntity(table,value){return transaction(()=>entityRaw(table,value,table==='audit'||table==='diagnostics'));},
    deleteEntity(table,id){entityTable(table);if(table==='audit')throw new Error('Auditoria imutável.');return remove(table,id);},
    addAudit(record){const value={...redacted(record),id:record.id||randomUUID(),at:record.at??Date.now()};return transaction(()=>entityRaw('audit',value,true));},
    addDiagnostic(record){const value={...redacted(record),id:record.id||randomUUID(),at:record.at??Date.now()};return transaction(()=>entityRaw('diagnostics',value,true));},
    saveNotification(record){const value={...redacted(record),id:record.id||randomUUID(),at:record.at??Date.now()};return transaction(()=>entityRaw('notifications',value));},
    listHistory:filter=>historyPage(filter),
    exportHistory(filter={}){return {...historyPage({...filter,limit:filter.limit??100000,offset:filter.offset??0},100000),exportedAt:new Date().toISOString()};},
    cleanupPreview(input){const cats=categories(Array.isArray(input)?input:input?.categories),counts=Object.fromEntries(cats.map(c=>[c,Number(prepared('SELECT COUNT(*)AS n FROM history WHERE category=? AND storageMode=?').get(c,storageMode()).n)]));return {categories:cats,counts,total:Object.values(counts).reduce((a,b)=>a+b,0)};},
    clearHistory({categories:input,actor}={}){return transaction(()=>{const preview=store.cleanupPreview(input);for(const category of preview.categories){prepared('DELETE FROM history WHERE category=? AND storageMode=?').run(category,storageMode());if(category==='errors')prepared('DELETE FROM diagnostics WHERE storageMode=?').run(storageMode());if(category==='notifications')prepared('DELETE FROM notifications WHERE storageMode=?').run(storageMode());}const audit=store.addAudit({actorId:typeof actor==='string'?actor:actor?.id??actor?.userId??null,actorName:actor?.name??null,action:'history.clear',at:Date.now(),detail:{categories:preview.categories,counts:preview.counts},preserved:'operational jobs, rounds, alerts, users, campaigns, media and audit'});return {...preview,auditId:audit.id};});},
    applyHistoryRetention:config=>transaction(()=>retentionRaw(config)),applyRetention:config=>transaction(()=>retentionRaw(config)),
    exportData(){return {format:'mega-disparos',version:1,storageMode:storageMode(),createdAt:new Date().toISOString(),campaigns:all('campaigns'),groups:all('groups_data'),templates:all('templates'),contacts:all('contacts'),alertRecipients:all('alert_recipients'),reminders:all('reminders').map(r=>({id:r.id,...require('./reminders.cjs').normalizeReminder(r)})),settings:all('settings').filter(s=>!PRIVATE_SETTING.test(s.id)),media:all('media')};},
    importData(data){
      data=require('./backup-validation.cjs').validateBackupData(data);
      const targetMode=['simulated','whatsapp'].includes(data.storageMode)?data.storageMode:data.groups.length&&data.groups.every(g=>g.simulation)?'simulated':'whatsapp';
      if(data.groups.some(g=>Boolean(g.simulation)!==(targetMode==='simulated')))throw new Error('Backup inválido: grupos de simulação e reais não podem ser misturados.');
      return transaction(()=>{
        putRaw('settings',{id:'integrationMode',value:targetMode});
        for(const table of ['campaigns','groups_data','templates','media','contacts','alert_recipients'])prepared(`DELETE FROM ${table} WHERE storageMode=?`).run(targetMode);
        for(const s of all('settings'))if(!PRIVATE_SETTING.test(s.id))prepared('DELETE FROM settings WHERE id=?').run(s.id);
        for(const c of data.campaigns)putRaw('campaigns',{...c,state:'draft',nextRunAt:null,revision:(c.revision||0)+1,configRevision:(c.configRevision||c.revision||0)+1});
        for(const g of data.groups)putRaw('groups_data',g);for(const t of data.templates||[])putRaw('templates',t);for(const m of data.media||[])putRaw('media',m);
        for(const c of data.contacts||[])entityRaw('contacts',c);for(const r of data.alertRecipients||[])entityRaw('alert_recipients',r);
        // Portable backups carry configuration only. Existing operational ledgers
        // remain local, and restored schedules are always paused with a new revision.
        if(Object.hasOwn(data,'reminders')){
          const previousReminders=new Map(all('reminders').map(r=>[r.id,r]));
          prepared('DELETE FROM reminders WHERE storageMode=?').run(targetMode);
          for(const r of data.reminders){
            const old=previousReminders.get(r.id);
            const recipient=r.recipientId.startsWith('user:')?one('users',r.recipientId.slice(5)):one('alert_recipients',r.recipientId);
            const userRecipient=r.recipientId.startsWith('user:');
            const available=recipient&&recipient.active!==false&&recipient.enabled!==false&&!recipient.requirePasswordChange&&/^[1-9]\d{9,14}$/.test(recipient.phone||'')&&(!userRecipient||one('roles',recipient.roleId));
            const lastDeliveryId=old?.lastDeliveryId&&one('reminder_deliveries',old.lastDeliveryId)?old.lastDeliveryId:null;
            entityRaw('reminders',{...r,state:'paused',enabled:false,nextDueAt:null,scheduleRevision:(old?.scheduleRevision||0)+1,createdAt:old?.createdAt||Date.now(),updatedAt:Date.now(),ownerId:old?.ownerId||null,lastDeliveryId,reviewRequired:!available,error:available?null:'Destinatário indisponível neste computador. Selecione um usuário ativo ou destinatário autorizado antes de ativar o lembrete.'});
          }
        }
        for(const s of data.settings||[])if(!PRIVATE_SETTING.test(s.id))putRaw('settings',s);
        putRaw('settings',{id:'initialized',value:true});
      });
    },
    registerOutboundMessageId(id,{kind='automation',at=Date.now()}={}){if(typeof id!=='string'||!id||id.length>256)throw new Error('Identificador de mensagem inválido.');return transaction(()=>prepared('INSERT OR IGNORE INTO automation_outbound(id,at,storageMode,kind) VALUES(?,?,?,?)').run(id,Number(at),storageMode(),String(kind).slice(0,50)));},
    isOutboundMessageId(id){
      if(typeof id!=='string'||!id)return false;
      if(prepared('SELECT id FROM automation_outbound WHERE id=?').get(id)||prepared('SELECT id FROM jobs WHERE messageId=? LIMIT 1').get(id)||prepared("SELECT id FROM jobs WHERE json_extract(data,'$.clientMessageId')=? LIMIT 1").get(id)||prepared("SELECT id FROM alerts WHERE json_extract(data,'$.messageId')=? LIMIT 1").get(id)||prepared("SELECT id FROM alerts WHERE json_extract(data,'$.clientMessageId')=? LIMIT 1").get(id))return true;
      for(const table of ['buscas_deliveries','buscas_deliveries_simulation'])if(prepared("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)&&prepared(`SELECT id FROM ${table} WHERE messageId=? LIMIT 1`).get(id))return true;
      return false;
    },
    close(){if(!closed){try{if(!persistenceFailed)db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}finally{db.close();closed=true;statements.clear();}}}
  };
  Object.assign(store,{listUsers:filter=>store.listEntities('users',filter),saveAlert:value=>store.saveEntity('alerts',value),getAlert:id=>store.getEntity('alerts',id),listAlerts:filter=>store.listEntities('alerts',filter),updateAlert:(id,patch)=>{const old=store.getAlert(id);if(!old)throw new Error('Alerta não encontrado.');return store.saveAlert({...old,...patch});},saveAlertRecipient:value=>store.saveEntity('alert_recipients',value),getAlertRecipient:id=>store.getEntity('alert_recipients',id),listAlertRecipients:filter=>store.listEntities('alert_recipients',filter),deleteAlertRecipient:id=>store.deleteEntity('alert_recipients',id),
    listPendingAlerts({at=Date.now(),channel,limit=50}={}){return parseRows(prepared(`SELECT data FROM alerts WHERE storageMode=? AND status='pending' AND COALESCE(json_extract(data,'$.nextAttemptAt'),0)<=?${channel?" AND json_extract(data,'$.channel')=?":''} ORDER BY createdAt ASC,rowid ASC LIMIT ?`).all(storageMode(),at,...(channel?[channel]:[]),clamp(limit,50,500)));},
    findAlertsByMessageId(messageId){return parseRows(prepared("SELECT data FROM alerts WHERE json_extract(data,'$.messageId')=? AND storageMode=? AND status IN('sending','uncertain','confirmed','delivered','failed') LIMIT 10").all(messageId,storageMode()));}
  });
  // This one-time migration marker preserves deliberately cleared histories.
  if(!getSetting('historyProjectionInitialized',false))transaction(()=>{for(const row of prepared('SELECT data FROM jobs ORDER BY rowid DESC LIMIT 10000').all()){const j=JSON.parse(row.data);projection('sends',j.id,j);}for(const row of prepared('SELECT data FROM rounds ORDER BY rowid DESC LIMIT 10000').all()){const r=JSON.parse(row.data);projection('campaigns',`round:${r.id}`,{...r,kind:'round'});}putRaw('settings',{id:'historyProjectionInitialized',value:true});retentionRaw();});
  attachSearchStore(store,{db,prepared,transaction});
  db.exec("CREATE INDEX IF NOT EXISTS diagnostics_trace_mode_time ON diagnostics(storageMode,json_extract(data,'$.traceId'),createdAt DESC)");
  if(options.upgradeVersion)store.setSetting('lastAppUpgradeVersion',options.upgradeVersion);
  return store;
}
function seed(store) {
  if(store.getSetting('initialized',false))return;
  store.transaction(()=>{
    for(const[key,value]of Object.entries({integrationMode:'simulated',admins:[],theme:'dark',maxSelectedGroups:15,launchAtLogin:false,closeBehavior:'ask',minimizeToTray:true,unofficialAcknowledged:false,historyRetentionDays:30,historyMaxRows:10000,historyMaxBytes:10485760}))store.setSetting(key,value);
    const groups=Array.from({length:15},(_,i)=>({id:`sim-${String(i+1).padStart(2,'0')}@simulation`,name:`Grupo de exemplo ${String(i+1).padStart(2,'0')}`,authorized:true,simulation:true,provenance:'builtin-simulation-example-v1'}));store.upsertGroups(groups);
    store.saveCampaign({id:randomUUID(),name:'Exemplo • 15 grupos a cada 10 minutos',provenance:'builtin-simulation-example-v1',state:'draft',mode:'repeat',intervalMinutes:10,spacingSeconds:5,schedule:{days:[0,1,2,3,4,5,6],startTime:'08:00',endTime:'18:00',startDate:'',endDate:''},dailyRoundLimit:0,dailySendLimit:0,groupIds:groups.map(g=>g.id),items:[{id:randomUUID(),type:'text',text:'Olá, pessoal! 👋\n\n*Mensagem de exemplo do Kenned Code Disparos*\nEsta campanha está desativada e utiliza apenas grupos simulados.\nhttps://www.whatsapp.com/'}],groupOverrides:{},nextRunAt:null,roundIndex:0});store.setSetting('initialized',true);
  });
}
module.exports={createStore,atomicWrite,seed,HISTORY_CATEGORIES};
