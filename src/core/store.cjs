const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const initSqlJs = require('sql.js');
const {configurationFingerprint}=require('./campaign-version.cjs');

function atomicWrite(filename, data) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temp = `${filename}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, filename);
  } catch(error) { try{fs.unlinkSync(temp);}catch{} throw error; }
  let directory;
  try { directory=fs.openSync(path.dirname(filename),'r');fs.fsyncSync(directory); } catch { /* Windows does not support fsync on directories. */ }
  finally {if(directory!==undefined)fs.closeSync(directory);}
}

async function createStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const filename = path.join(dir, 'mega.sqlite');
  const SQL = await initSqlJs({ locateFile: file => path.join(path.dirname(require.resolve('sql.js')), file) });
  const db = new SQL.Database(fs.existsSync(filename) ? fs.readFileSync(filename) : undefined);
  db.run(`CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS campaigns (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS groups_data (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rounds (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, roundId TEXT NOT NULL, campaignId TEXT NOT NULL, groupId TEXT NOT NULL, itemId TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(roundId,groupId,itemId));
    CREATE INDEX IF NOT EXISTS jobs_campaign ON jobs(campaignId,status);`);
  let closed = false,persistenceFailed=false;
  const assertWritable=()=>{if(closed)throw new Error('Banco fechado.');if(persistenceFailed)throw new Error('Armazenamento indisponível. Os envios foram bloqueados; corrija o espaço ou as permissões e reabra o aplicativo.');};
  const persist = () => {assertWritable();try{atomicWrite(filename,Buffer.from(db.export()));}catch(error){persistenceFailed=true;throw error;}};
  const one = (table, id) => { const st = db.prepare(`SELECT data FROM ${table} WHERE id=?`); try { st.bind([id]); return st.step() ? JSON.parse(st.get()[0]) : undefined; } finally { st.free(); } };
  const all = table => { const st = db.prepare(`SELECT data FROM ${table} ORDER BY rowid`); const rows = []; try { while (st.step()) rows.push(JSON.parse(st.get()[0])); return rows; } finally { st.free(); } };
  const putRaw = (table, value) => {assertWritable();return db.run(`INSERT INTO ${table} (id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`, [value.id, JSON.stringify(value)]);};
  const put = (table, value) => { if (!value?.id) throw new Error('Identificador obrigatório.'); putRaw(table, value); persist(); return one(table, value.id); };
  const remove = (table, id) => {assertWritable();db.run(`DELETE FROM ${table} WHERE id=?`, [id]); persist(); };
  const jobRaw = j => {assertWritable();return db.run(`INSERT INTO jobs (id,roundId,campaignId,groupId,itemId,status,data) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data`, [j.id,j.roundId,j.campaignId,j.groupId,j.itemId,j.status,JSON.stringify(j)]);};
  const store = {
    dir, filename,get persistenceFailed(){return persistenceFailed;},
    getSetting: (id, fallback) => one('settings', id)?.value ?? fallback,
    setSetting: (id, value) => put('settings', { id, value }),
    listCampaigns: () => all('campaigns'), getCampaign: id => one('campaigns', id),
    saveCampaign(c) { const old = one('campaigns', c.id); const changed=!old||configurationFingerprint(old)!==configurationFingerprint(c); return put('campaigns', { ...c, revision: (old?.revision || 0) + 1,configRevision:(old?.configRevision||old?.revision||0)+(changed?1:0) }); },
    deleteCampaign: id => remove('campaigns', id),
    listGroups: () => all('groups_data'), getGroup: id => one('groups_data', id),
    upsertGroups(groups) {assertWritable();db.run('BEGIN'); try { for (const g of groups) { const old = one('groups_data', g.id); putRaw('groups_data', { ...old, ...g, authorized: old?.authorized ?? !!g.authorized }); } db.run('COMMIT'); } catch(e) { db.run('ROLLBACK'); throw e; } persist(); },
    authorizeGroup(id, authorized) { const g = one('groups_data', id); if (!g) throw new Error('Grupo não encontrado.'); return put('groups_data', { ...g, authorized: !!authorized }); },
    listMedia: () => all('media'), getMedia: id => one('media', id), saveMedia: m => put('media', m),
    listTemplates: () => all('templates'), saveTemplate: t => put('templates', t), deleteTemplate: id => remove('templates', id),
    insertRound: r => put('rounds', r), updateRound(id, patch) { const r = one('rounds', id); if (!r) throw new Error('Rodada não encontrada.'); return put('rounds', { ...r, ...patch }); },
    listRounds: id => all('rounds').filter(r => !id || r.campaignId === id),
    insertJob(j) { jobRaw(j); persist(); return one('jobs', j.id); },
    updateJob(id, patch) { const j = one('jobs', id); if (!j) throw new Error('Envio não encontrado.'); const result = { ...j, ...patch }; jobRaw(result); persist(); return result; },
    getJob: id => one('jobs', id),
    listJobs(filter = {}) { const rows = all('jobs').filter(j => (!filter.campaignId || j.campaignId === filter.campaignId) && (!filter.roundId || j.roundId === filter.roundId) && (!filter.status || (Array.isArray(filter.status) ? filter.status.includes(j.status) : j.status === filter.status))); return filter.limit ? rows.slice(-filter.limit).reverse() : rows; },
    recoverInterrupted() {
      assertWritable();
      const affected = new Set(); db.run('BEGIN');
      try {
        for (const j of all('jobs')) {
          if (['sending','accepted'].includes(j.status)) { jobRaw({ ...j, status:'uncertain',resultAt:Date.now(),error:'Aplicativo encerrado durante o envio; revise sem reenviar automaticamente.' }); affected.add(j.campaignId); }
          else if (j.status === 'queued') { jobRaw({ ...j,status:'cancelled',resultAt:Date.now(),error:'Fila anterior cancelada na inicialização; sem recuperação de rodadas atrasadas.' }); affected.add(j.campaignId); }
        }
        for (const r of all('rounds')) if (!r.finishedAt) putRaw('rounds',{ ...r,finishedAt:Date.now(),status:'interrupted' });
        for (const c of all('campaigns')) if (c.state === 'active') putRaw('campaigns',{ ...c,state:'paused',nextRunAt:null,revision:c.revision+1,pauseReason:affected.has(c.id)?'Fila interrompida; verifique o histórico.':'Reabertura do aplicativo: retome após conferir a conexão.' });
        db.run('COMMIT');
      } catch(e) { db.run('ROLLBACK'); throw e; }
      persist(); return [...affected];
    },
    exportData() { return { format:'mega-disparos',version:1,createdAt:new Date().toISOString(),campaigns:all('campaigns'),groups:all('groups_data'),templates:all('templates'),settings:all('settings').filter(s => !/secret|cred|session|qr|recentCommand|integrationMode/i.test(s.id)),media:all('media') }; },
    importData(data) {
      assertWritable();
      data=require('./backup-validation.cjs').validateBackupData(data);
      if (data?.format !== 'mega-disparos' || data.version !== 1 || !Array.isArray(data.campaigns) || !Array.isArray(data.groups)) throw new Error('Backup inválido.');
      db.run('BEGIN');
      try {
        for (const table of ['campaigns','groups_data','templates','media','settings']) db.run(`DELETE FROM ${table}`);
        for (const c of data.campaigns) putRaw('campaigns',{ ...c,state:'draft',nextRunAt:null,revision:(c.revision||0)+1,configRevision:(c.configRevision||c.revision||0)+1 });
        for (const g of data.groups) putRaw('groups_data',g);
        for (const t of data.templates || []) putRaw('templates',t);
        for (const m of data.media || []) putRaw('media',m);
        for (const s of data.settings || []) if (!/secret|cred|session|qr|recentCommand|integrationMode/i.test(s.id)) putRaw('settings',s);
        putRaw('settings',{id:'integrationMode',value:'simulated'});
        putRaw('settings',{id:'initialized',value:true});
        db.run('COMMIT');
      } catch(e) { db.run('ROLLBACK'); throw e; }
      persist();
    },
    close() { if (!closed) {try{if(!persistenceFailed)persist();}finally{db.close();closed=true;}} }
  };
  for(const c of all('campaigns'))if(!Number.isInteger(c.configRevision))putRaw('campaigns',{...c,configRevision:c.revision||1});
  persist(); return store;
}

function seed(store) {
  if (store.getSetting('initialized', false)) return;
  for (const [key,value] of Object.entries({integrationMode:'simulated',admins:[],theme:'dark',maxSelectedGroups:15,launchAtLogin:false,closeBehavior:'ask',minimizeToTray:true,unofficialAcknowledged:false})) store.setSetting(key,value);
  const groups = Array.from({length:15},(_,i)=>({id:`sim-${String(i+1).padStart(2,'0')}@simulation`,name:`Grupo de exemplo ${String(i+1).padStart(2,'0')}`,authorized:true,simulation:true}));
  store.upsertGroups(groups);
  store.saveCampaign({id:randomUUID(),name:'Exemplo • 15 grupos a cada 10 minutos',state:'draft',mode:'repeat',intervalMinutes:10,spacingSeconds:5,schedule:{days:[0,1,2,3,4,5,6],startTime:'08:00',endTime:'18:00',startDate:'',endDate:''},dailyRoundLimit:0,dailySendLimit:0,groupIds:groups.map(g=>g.id),items:[{id:randomUUID(),type:'text',text:'Olá, pessoal! 👋\n\n*Mensagem de exemplo do Mega Disparos*\nEsta campanha está desativada e utiliza apenas grupos simulados.\nhttps://www.whatsapp.com/'}],groupOverrides:{},nextRunAt:null,roundIndex:0});
  store.setSetting('initialized',true);
}
module.exports = {createStore,atomicWrite,seed};
