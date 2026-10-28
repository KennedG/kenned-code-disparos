'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const APP_ID = 0x41434f4d;
const SCHEMA = 1;
const KINDS = new Set(['contacts', 'groups', 'campaigns', 'runs', 'jobs', 'templates', 'history', 'audit', 'diagnostics']);
const MODES = new Set(['whatsapp', 'simulated']);
const PROOF = new Set(['accepted', 'delivered', 'uncertain']);
const SECRET_KEY = /(?:password|passwd|secret|credential|auth[_-]?(?:state|key|token)|access[_-]?token|refresh[_-]?token|private[_-]?key|session[_-]?(?:key|data|credential))/i;
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const stamp = value => Number.isFinite(Number(value)) ? Number(value) : Date.now();

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function phoneNumber(value) {
  if (value == null || value === '') return null;
  const source = String(value).trim();
  if (!/^\+?[\d\s().-]+$/.test(source)) return null;
  const digits = source.replace(/\D/g, '');
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}
function identity(value) {
  if (typeof value !== 'string') return null;
  const source = value.trim().toLowerCase();
  const pn = source.match(/^(\d+)(?::\d+)?@(?:s\.whatsapp\.net|c\.us)$/);
  if (pn) return phoneNumber(pn[1]) ? `${pn[1]}@s.whatsapp.net` : null;
  const lid = source.match(/^([a-z0-9._-]+)(?::\d+)?@lid$/);
  if (lid) return `${lid[1]}@lid`;
  if (/^[a-z0-9._-]+@simulation$/.test(source)) return source;
  return null;
}
function safeLog(value) {
  if (Array.isArray(value)) return value.map(safeLog);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) || /^(?:creds|session|token)$/i.test(key) ? '[REDACTED]' : safeLog(item)]));
  return typeof value === 'string' ? value.replace(/((?:token|password|secret|authorization)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi, '$1[REDACTED]').slice(0, 16000) : value;
}
function recipientKey(contact) {
  if (typeof contact === 'string') return contact;
  const phone = phoneNumber(contact?.phone);
  if (phone) return `pn:${phone}`;
  const external = identity(contact?.externalId) || (contact?.identifiers || []).map(identity).find(Boolean);
  return external ? `account:${external}` : `contact:${contact?.id || ''}`;
}
function validateDatabase(db) {
  if (Number(db.prepare('PRAGMA application_id').get().application_id) !== APP_ID || Number(db.prepare('PRAGMA user_version').get().user_version) !== SCHEMA) fail('BACKUP_INCOMPATIBLE', 'Este arquivo não é um backup compatível do Automação Comunidade.');
  const check = db.prepare('PRAGMA integrity_check').get();
  if (Object.values(check)[0] !== 'ok') fail('BACKUP_CORRUPT', 'O backup está corrompido; nenhum dado foi substituído.');
  const objects = db.prepare("SELECT type,name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
  const tables = new Set(['meta', 'settings', 'entities', 'identity_aliases', 'recipient_claims', 'invitation_ledger']);
  const indices = new Set(['entity_page', 'entity_status', 'entity_campaign', 'entity_run', 'entity_contact', 'entity_group', 'contact_phone', 'alias_contact', 'claim_job', 'ledger_job', 'ledger_recipient_status', 'submission_date']);
  for (const object of objects) {
    if (object.type === 'table' && !tables.delete(object.name)) fail('BACKUP_INCOMPATIBLE', 'O backup contém estruturas desconhecidas.');
    if (!['table', 'index'].includes(object.type)) fail('BACKUP_INCOMPATIBLE', 'O backup contém estruturas não permitidas.');
    if (object.type === 'index' && !indices.has(object.name)) fail('BACKUP_INCOMPATIBLE', 'O backup contém índices desconhecidos.');
  }
  if (tables.size) fail('BACKUP_INCOMPATIBLE', 'O backup está incompleto.');
  const requiredColumns = {
    meta: ['key', 'value'], settings: ['mode', 'key', 'value'],
    entities: ['mode', 'kind', 'id', 'data', 'status', 'campaign_id', 'run_id', 'contact_id', 'group_id', 'search', 'created_at', 'updated_at'],
    identity_aliases: ['mode', 'alias', 'contact_id'], recipient_claims: ['mode', 'recipient_key', 'job_id', 'claimed_at'],
    invitation_ledger: ['mode', 'recipient_key', 'job_id', 'status', 'message_id', 'at', 'data']
  };
  for (const [table, columns] of Object.entries(requiredColumns)) if (JSON.stringify(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name)) !== JSON.stringify(columns)) fail('BACKUP_INCOMPATIBLE', 'A estrutura do backup não é compatível com esta versão.');
  const mode = db.prepare("SELECT value FROM meta WHERE key='mode'").get()?.value;
  if (mode && !MODES.has(mode)) fail('BACKUP_INCOMPATIBLE', 'O backup contém um modo de integração inválido.');
  for (const row of db.prepare('SELECT mode,kind,id,data FROM entities').iterate()) {
    if (!MODES.has(row.mode) || !KINDS.has(row.kind)) fail('BACKUP_INCOMPATIBLE', 'O backup contém registros inválidos.');
    let item; try { item = JSON.parse(row.data); } catch { fail('BACKUP_CORRUPT', 'Há um registro inválido no backup.'); }
    if (!item || item.id !== row.id || typeof item !== 'object' || Array.isArray(item)) fail('BACKUP_CORRUPT', 'Há um identificador inválido no backup.');
  }
  for (const row of db.prepare('SELECT key FROM settings').all()) if (SECRET_KEY.test(row.key)) fail('BACKUP_UNSAFE', 'O backup contém configuração sensível não permitida.');
}

class CommunityStore {
  constructor(dir) {
    if (!dir) fail('DATA_DIRECTORY_REQUIRED', 'Pasta de dados não informada.');
    this.dir = path.resolve(dir); fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.filePath = path.join(this.dir, 'automacao-comunidade.sqlite');
    this.depth = 0; this.closed = false; this.persistenceFailed = false; this._open();
    this.mode = this.db.prepare("SELECT value FROM meta WHERE key='mode'").get()?.value || 'whatsapp';
  }
  _open() {
    const existed = fs.existsSync(this.filePath) && fs.statSync(this.filePath).size > 0;
    this.db = this._observeDatabase(new DatabaseSync(this.filePath));
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');
    const version = Number(this.db.prepare('PRAGMA user_version').get().user_version);
    if (existed && (version !== SCHEMA || Number(this.db.prepare('PRAGMA application_id').get().application_id) !== APP_ID)) {
      const backup = `${this.filePath}.before-migration-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.bak`;
      this.db.prepare('VACUUM INTO ?').run(backup); this.db.close();
      fail('SCHEMA_INCOMPATIBLE', `Banco incompatível. Uma cópia recuperável foi preservada em ${backup}.`);
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(mode TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(mode,key));
      CREATE TABLE IF NOT EXISTS entities(mode TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),status TEXT,campaign_id TEXT,run_id TEXT,contact_id TEXT,group_id TEXT,search TEXT NOT NULL DEFAULT '',created_at REAL NOT NULL,updated_at REAL NOT NULL,PRIMARY KEY(mode,kind,id));
      CREATE INDEX IF NOT EXISTS entity_page ON entities(mode,kind,created_at DESC,id);
      CREATE INDEX IF NOT EXISTS entity_status ON entities(mode,kind,status,created_at DESC);
      CREATE INDEX IF NOT EXISTS entity_campaign ON entities(mode,kind,campaign_id,created_at DESC);
      CREATE INDEX IF NOT EXISTS entity_run ON entities(mode,kind,run_id,created_at DESC);
      CREATE INDEX IF NOT EXISTS entity_contact ON entities(mode,kind,contact_id,created_at DESC);
      CREATE INDEX IF NOT EXISTS entity_group ON entities(mode,kind,group_id,created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS contact_phone ON entities(mode,json_extract(data,'$.phone')) WHERE kind='contacts' AND json_extract(data,'$.phone') IS NOT NULL;
      CREATE INDEX IF NOT EXISTS submission_date ON entities(mode,campaign_id,json_extract(data,'$.submittedAt')) WHERE kind='jobs';
      CREATE TABLE IF NOT EXISTS identity_aliases(mode TEXT NOT NULL,alias TEXT NOT NULL,contact_id TEXT NOT NULL,PRIMARY KEY(mode,alias));
      CREATE INDEX IF NOT EXISTS alias_contact ON identity_aliases(mode,contact_id);
      CREATE TABLE IF NOT EXISTS recipient_claims(mode TEXT NOT NULL,recipient_key TEXT NOT NULL,job_id TEXT NOT NULL,claimed_at REAL NOT NULL,PRIMARY KEY(mode,recipient_key));
      CREATE UNIQUE INDEX IF NOT EXISTS claim_job ON recipient_claims(mode,job_id);
      CREATE TABLE IF NOT EXISTS invitation_ledger(mode TEXT NOT NULL,recipient_key TEXT NOT NULL,job_id TEXT NOT NULL,status TEXT NOT NULL,message_id TEXT,at REAL NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(mode,recipient_key,job_id));
      CREATE INDEX IF NOT EXISTS ledger_job ON invitation_ledger(mode,job_id);
      CREATE INDEX IF NOT EXISTS ledger_recipient_status ON invitation_ledger(mode,recipient_key,status,at DESC);
      PRAGMA application_id=${APP_ID}; PRAGMA user_version=${SCHEMA};`);
    try { fs.chmodSync(this.filePath, 0o600); } catch { /* Windows ACL handles access. */ }
  }
  _observeDatabase(database) {
    const invoke = (target, key, args) => {
      try { return target[key](...args); }
      catch (error) {
        if ([8, 10, 11, 13, 14, 26].includes(Number(error.errcode) & 255) || /database or disk is full|disk i\/o error|database disk image is malformed|attempt to write a readonly database|unable to open database/i.test(error.message || '')) this.persistenceFailed = true;
        throw error;
      }
    };
    return new Proxy(database, { get: (target, key) => {
      if (key === 'prepare') return (...args) => {
        const statement = invoke(target, key, args);
        return new Proxy(statement, { get: (row, method) => typeof row[method] === 'function' ? (...values) => invoke(row, method, values) : row[method] });
      };
      return typeof target[key] === 'function' ? (...args) => invoke(target, key, args) : target[key];
    } });
  }
  _kind(kind) { if (!KINDS.has(kind)) fail('INVALID_ENTITY', 'Tipo de registro inválido.'); }
  _filter(kind, filter = {}) {
    this._kind(kind);
    const where = ['mode=?', 'kind=?'], values = [this.mode, kind];
    for (const [key, column] of [['campaignId', 'campaign_id'], ['runId', 'run_id'], ['contactId', 'contact_id']]) if (filter[key] != null) { where.push(`${column}=?`); values.push(String(filter[key])); }
    if (filter.groupId != null) {
      if (kind === 'contacts' || kind === 'campaigns') { where.push("EXISTS (SELECT 1 FROM json_each(entities.data,'$.groupIds') WHERE value=?)"); values.push(String(filter.groupId)); }
      else { where.push('group_id=?'); values.push(String(filter.groupId)); }
    }
    if (filter.status != null) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      const column = kind === 'contacts' && statuses.every(value => ['identified', 'authorized', 'invited', 'uncertain', 'blocked', 'unavailable'].includes(value)) ? this._contactStatus() : 'status';
      if (!statuses.length) where.push('0'); else { where.push(`${column} IN (${statuses.map(() => '?').join(',')})`); values.push(...statuses.map(String)); }
    }
    if (filter.search) { where.push("search LIKE ? ESCAPE '\\'"); values.push(`%${String(filter.search).toLowerCase().replace(/[\\%_]/g, '\\$&')}%`); }
    return { sql: where.join(' AND '), values };
  }
  getMode() { return this.mode; }
  _contactStatus() {
    return `(CASE WHEN json_extract(data,'$.blocked')=1 OR json_extract(data,'$.optOut')=1 OR json_extract(data,'$.muted')=1 THEN 'blocked'
      WHEN json_extract(data,'$.ambiguous')=1 OR json_extract(data,'$.self')=1 OR json_extract(data,'$.phone') IS NULL THEN 'unavailable'
      WHEN EXISTS(SELECT 1 FROM invitation_ledger l WHERE l.mode=entities.mode AND l.recipient_key='pn:'||json_extract(entities.data,'$.phone') AND l.status='uncertain') THEN 'uncertain'
      WHEN EXISTS(SELECT 1 FROM invitation_ledger l WHERE l.mode=entities.mode AND l.recipient_key='pn:'||json_extract(entities.data,'$.phone') AND l.status IN ('accepted','delivered','uncertain')) THEN 'invited'
      WHEN json_extract(data,'$.authorized')=1 THEN 'authorized' ELSE 'identified' END)`;
  }
  getMetrics() {
    const metrics = { identified: this.count('contacts'), authorized: 0, newEligible: 0, previouslyInvited: 0, pending: 0, processing: 0, accepted: 0, delivered: 0, uncertain: 0, failed: 0, cancelled: 0, activeCampaigns: 0 };
    metrics.newEligible = Number(this.db.prepare(`SELECT count(*) AS n FROM entities WHERE mode=? AND kind='contacts' AND ${this._contactStatus()}='authorized' AND NOT EXISTS (SELECT 1 FROM recipient_claims c WHERE c.mode=entities.mode AND c.recipient_key='pn:'||json_extract(entities.data,'$.phone'))`).get(this.mode).n);
    metrics.authorized = Number(this.db.prepare("SELECT count(*) AS n FROM entities WHERE mode=? AND kind='contacts' AND json_extract(data,'$.authorized')=1").get(this.mode).n);
    metrics.previouslyInvited = Number(this.db.prepare("SELECT count(DISTINCT recipient_key) AS n FROM invitation_ledger WHERE mode=? AND status IN ('accepted','delivered','uncertain')").get(this.mode).n);
    for (const row of this.db.prepare("SELECT status,count(*) AS n FROM entities WHERE mode=? AND kind='jobs' GROUP BY status").all(this.mode)) if (Object.hasOwn(metrics, row.status)) metrics[row.status] = Number(row.n);
    metrics.activeCampaigns = this.count('campaigns', { status: ['active', 'scheduled'] });
    return metrics;
  }
  getSubmissionCount(campaignId, options = {}) {
    const where = ["mode=?", "kind='jobs'", 'campaign_id=?', "json_extract(data,'$.submittedAt') IS NOT NULL"], values = [this.mode, String(campaignId)];
    if (Number.isFinite(Number(options.from))) { where.push("json_extract(data,'$.submittedAt')>=?"); values.push(Number(options.from)); }
    if (Number.isFinite(Number(options.to))) { where.push("json_extract(data,'$.submittedAt')<?"); values.push(Number(options.to)); }
    if (options.exceptJobId) { where.push('id<>?'); values.push(String(options.exceptJobId)); }
    return Number(this.db.prepare(`SELECT count(*) AS n FROM entities WHERE ${where.join(' AND ')}`).get(...values).n);
  }
  setMode(mode) {
    if (!MODES.has(mode)) fail('INVALID_MODE', 'Modo de integração inválido.');
    if (mode === this.mode) return mode;
    this.transaction(() => {
      for (const run of this.listAll('runs', { status: ['active', 'scheduled', 'running'] })) this.save('runs', { ...run, status: 'paused', pauseReason: 'mode-changed' });
      for (const campaign of this.listAll('campaigns', { status: ['active', 'scheduled'] })) this.save('campaigns', { ...campaign, status: 'paused', pauseReason: 'mode-changed' });
      this.db.prepare("INSERT INTO meta(key,value) VALUES('mode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(mode);
    }); this.mode = mode; return mode;
  }
  getSetting(key, fallback = null) { const row = this.db.prepare('SELECT value FROM settings WHERE mode=? AND key=?').get(this.mode, String(key)); return row ? JSON.parse(row.value) : clone(fallback); }
  setSetting(key, value) {
    if (SECRET_KEY.test(key)) fail('SENSITIVE_SETTING', 'Credenciais e sessões não podem ser armazenadas no banco de campanhas.');
    if (value === undefined) { this.db.prepare('DELETE FROM settings WHERE mode=? AND key=?').run(this.mode, key); return null; }
    this.db.prepare('INSERT INTO settings(mode,key,value) VALUES(?,?,?) ON CONFLICT(mode,key) DO UPDATE SET value=excluded.value').run(this.mode, String(key), JSON.stringify(value)); return clone(value);
  }
  transaction(fn) {
    const level = this.depth++, savepoint = `nested_${level}`;
    try {
      this.db.exec(level ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
      const result = fn();
      if (result && typeof result.then === 'function') fail('ASYNC_TRANSACTION', 'A transação do banco deve ser síncrona.');
      this.db.exec(level ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT'); return result;
    } catch (error) { try { this.db.exec(level ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}` : 'ROLLBACK'); } catch {} throw error; }
    finally { this.depth--; }
  }
  get(kind, id) { this._kind(kind); const row = this.db.prepare('SELECT data FROM entities WHERE mode=? AND kind=? AND id=?').get(this.mode, kind, String(id)); return row ? JSON.parse(row.data) : null; }
  count(kind, filter = {}) { const query = this._filter(kind, filter); return Number(this.db.prepare(`SELECT count(*) AS total FROM entities WHERE ${query.sql}`).get(...query.values).total); }
  list(kind, filter = {}) {
    const query = this._filter(kind, filter), limit = Math.min(200, Math.max(1, Math.floor(Number(filter.limit) || 50))), offset = Math.max(0, Math.floor(Number(filter.offset) || 0));
    const items = this.db.prepare(`SELECT data FROM entities WHERE ${query.sql} ORDER BY created_at DESC,id LIMIT ? OFFSET ?`).all(...query.values, limit, offset).map(row => JSON.parse(row.data));
    return { items, total: this.count(kind, filter), limit, offset };
  }
  listAll(kind, filter = {}) { const query = this._filter(kind, filter); return this.db.prepare(`SELECT data FROM entities WHERE ${query.sql} ORDER BY created_at DESC,id`).all(...query.values).map(row => JSON.parse(row.data)); }
  save(kind, object) {
    this._kind(kind); if (!object || typeof object !== 'object' || Array.isArray(object)) fail('INVALID_RECORD', 'Registro inválido.');
    const id = String(object.id || crypto.randomUUID()), previous = this.get(kind, id), now = Date.now();
    let item = { ...previous, ...clone(object), id, createdAt: previous?.createdAt ?? object.createdAt ?? now, updatedAt: object.updatedAt ?? now };
    if (kind === 'contacts') {
      item.phone = phoneNumber(item.phone);
      item.identifiers = [...new Set((item.identifiers || []).map(identity).filter(Boolean))];
      item.groupIds = [...new Set(item.groupIds || [])];
      if (previous?.phone && item.phone !== previous.phone) fail('CONTACT_IDENTITY_IMMUTABLE', 'O telefone confirmado não pode ser substituído silenciosamente. Cadastre e revise a outra identidade.');
      const identifiedPhones = item.identifiers.filter(alias => alias.endsWith('@s.whatsapp.net')).map(alias => alias.split('@')[0]);
      if (!item.ambiguous && item.phone && identifiedPhones.some(phone => phone !== item.phone)) fail('IDENTITY_CONFLICT', 'O telefone não corresponde aos identificadores confirmados deste contato.');
      if (item.authorized && ((!item.phone && this.mode !== 'simulated') || item.ambiguous || !String(item.consentNote || '').trim())) fail('CONTACT_NOT_AUTHORIZABLE', 'Autorize apenas contatos identificados com segurança e registre a origem da autorização.');
      if (this.mode === 'whatsapp' && item.identifiers.some(value => value.endsWith('@simulation'))) fail('SIMULATION_CONTACT', 'Contatos simulados não podem ser usados no modo real.');
      for (const alias of [...item.identifiers, ...(item.phone ? [`${item.phone}@s.whatsapp.net`] : [])]) {
        const owner = this._contactByAlias(alias);
        if (owner && owner.id !== id) fail('IDENTITY_CONFLICT', 'Este identificador já pertence a outro contato. Atualize os participantes para revisar o vínculo.');
      }
    }
    if (kind === 'jobs' && previous) {
      if (previous.status === 'delivered' || previous.status === 'accepted' && !['accepted', 'delivered'].includes(item.status) || previous.status === 'uncertain' && !['uncertain', 'accepted', 'delivered'].includes(item.status) && !object.manualReview) item = { ...item, status: previous.status, error: previous.error, errorCode: previous.errorCode };
      if (previous.messageId && !item.messageId) item.messageId = previous.messageId;
      if (previous.acceptedAt) item.acceptedAt = previous.acceptedAt;
      if (previous.deliveredAt) item.deliveredAt = previous.deliveredAt;
    }
    const search = [item.name, item.displayName, item.phone, item.externalId, item.message, item.error, item.errorCode, item.textSnapshot, item.action, item.description].filter(Boolean).join(' ').toLowerCase();
    const persist = () => {
      this.db.prepare('INSERT INTO entities(mode,kind,id,data,status,campaign_id,run_id,contact_id,group_id,search,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(mode,kind,id) DO UPDATE SET data=excluded.data,status=excluded.status,campaign_id=excluded.campaign_id,run_id=excluded.run_id,contact_id=excluded.contact_id,group_id=excluded.group_id,search=excluded.search,updated_at=excluded.updated_at').run(this.mode, kind, id, JSON.stringify(item), item.status ?? null, item.campaignId ?? null, item.runId ?? null, item.contactId ?? null, item.groupId ?? null, search, stamp(item.createdAt), stamp(item.updatedAt));
      if (kind === 'contacts') for (const alias of [...item.identifiers, ...(item.phone ? [`${item.phone}@s.whatsapp.net`] : [])]) this.db.prepare('INSERT INTO identity_aliases(mode,alias,contact_id) VALUES(?,?,?) ON CONFLICT(mode,alias) DO NOTHING').run(this.mode, alias, id);
    };
    if (kind === 'contacts') this.transaction(persist); else persist();
    return clone(item);
  }
  remove(kind, id) {
    this._kind(kind);
    if (kind === 'jobs' || kind === 'runs') fail('OPERATIONAL_HISTORY_PROTECTED', 'O controle operacional de convites não pode ser apagado.');
    if (kind === 'contacts' && (this.isPreviouslyInvited(this.get('contacts', id) || { id }) || this.count('jobs', { contactId: id }) > 0 || this.ledger(this.get('contacts', id) || { id }).activeJobId)) fail('CONTACT_HISTORY_PROTECTED', 'Este contato tem convites registrados ou pendentes. Bloqueie ou arquive em vez de apagar.');
    return this.transaction(() => { const result = this.db.prepare('DELETE FROM entities WHERE mode=? AND kind=? AND id=?').run(this.mode, kind, String(id)); if (kind === 'contacts') this.db.prepare('DELETE FROM identity_aliases WHERE mode=? AND contact_id=?').run(this.mode, String(id)); return Number(result.changes) > 0; });
  }
  replaceGroups(groups) {
    if (!Array.isArray(groups)) fail('INVALID_GROUPS', 'A integração não retornou uma lista de grupos válida.');
    return this.transaction(() => {
      const incoming = new Set(groups.map(group => String(group.id)));
      for (const group of this.listAll('groups')) if (!incoming.has(group.id)) this.save('groups', { ...group, available: false, unavailableAt: Date.now() });
      return groups.map(group => this.save('groups', { ...this.get('groups', group.id), ...group, id: String(group.id), available: true, lastSyncedAt: Date.now() }));
    });
  }
  _contactByAlias(alias) { const row = this.db.prepare('SELECT contact_id FROM identity_aliases WHERE mode=? AND alias=?').get(this.mode, alias); return row ? this.get('contacts', row.contact_id) : null; }
  importParticipants(groupId, participants, at = Date.now()) {
    if (!Array.isArray(participants)) fail('INVALID_PARTICIPANTS', 'A integração não retornou participantes válidos.');
    return this.transaction(() => {
      const summary = { identified: 0, newContacts: 0, unavailable: 0, ambiguous: 0 };
      for (const participant of participants) {
        const aliases = [...new Set([participant.externalId, ...(participant.identifiers || [])].map(identity).filter(Boolean))];
        let phone = phoneNumber(participant.phone);
        const pnPhones = [...new Set(aliases.filter(value => value.endsWith('@s.whatsapp.net')).map(value => value.split('@')[0]))];
        const invalid = !!participant.ambiguous || pnPhones.length > 1 || phone && pnPhones.some(value => value !== phone);
        phone ||= pnPhones.length === 1 ? pnPhones[0] : null;
        if (phone) aliases.push(`${phone}@s.whatsapp.net`);
        const uniqueAliases = [...new Set(aliases)];
        if (!uniqueAliases.length) { summary.unavailable++; continue; }
        if (this.mode === 'whatsapp' && uniqueAliases.some(value => value.endsWith('@simulation'))) { summary.unavailable++; continue; }
        const candidates = [...new Map(uniqueAliases.map(alias => this._contactByAlias(alias)).filter(Boolean).map(contact => [contact.id, contact])).values()];
        if (phone) {
          const row = this.db.prepare("SELECT data FROM entities WHERE mode=? AND kind='contacts' AND json_extract(data,'$.phone')=?").get(this.mode, phone);
          if (row) { const contact = JSON.parse(row.data); if (!candidates.some(candidate => candidate.id === contact.id)) candidates.push(contact); }
        }
        const knownPhones = new Set([...candidates.map(contact => contact.phone).filter(Boolean), ...(phone ? [phone] : [])]);
        const ambiguous = invalid || knownPhones.size > 1;
        if (ambiguous) {
          summary.ambiguous++;
          for (const candidate of candidates) this.save('contacts', { ...candidate, authorized: false, ambiguous: true, identityIssue: 'A integração forneceu identificadores conflitantes; revise antes de autorizar.', lastSeenAt: at, groupIds: [...new Set([...(candidate.groupIds || []), groupId])] });
          if (candidates.length) continue;
        }
        let contact = candidates.find(candidate => candidate.phone === phone) || candidates[0];
        if (!contact) { summary.newContacts++; contact = { id: crypto.randomUUID(), firstSeenAt: at, authorized: false, authorizedAt: null, consentNote: '', blocked: false, optOut: false, muted: false, groupIds: [] }; }
        const oldKey = recipientKey(contact);
        const merged = { ...contact, externalId: contact.externalId || uniqueAliases[0], identifiers: [...new Set([...contact.identifiers || [], ...uniqueAliases])], phone: ambiguous ? null : phone || contact.phone || null, name: contact.name || participant.name || null, displayName: participant.name || contact.displayName || null, lastSeenAt: at, groupIds: [...new Set([...(contact.groupIds || []), groupId, ...candidates.flatMap(candidate => candidate.groupIds || [])])], ambiguous: ambiguous || !!contact.ambiguous, self: !!participant.self || !!contact.self };
        for (const duplicate of candidates.filter(candidate => candidate.id !== contact.id)) {
          merged.blocked ||= !!duplicate.blocked; merged.optOut ||= !!duplicate.optOut; merged.muted ||= !!duplicate.muted;
          merged.identifiers = [...new Set([...merged.identifiers, ...(duplicate.identifiers || [])])];
          merged.firstSeenAt = Math.min(merged.firstSeenAt, duplicate.firstSeenAt || at);
          if (duplicate.authorized && !merged.authorized) { merged.authorized = true; merged.authorizedAt = duplicate.authorizedAt; merged.consentNote = duplicate.consentNote; }
          this._mergeRecipientKeys(recipientKey(duplicate), recipientKey(merged));
          this.db.prepare('UPDATE identity_aliases SET contact_id=? WHERE mode=? AND contact_id=?').run(contact.id, this.mode, duplicate.id);
          for (const kind of ['jobs', 'history']) for (const item of this.listAll(kind, { contactId: duplicate.id })) this.save(kind, { ...item, contactId: contact.id });
          for (const campaign of this.listAll('campaigns')) if (campaign.contactIds?.includes(duplicate.id)) this.save('campaigns', { ...campaign, contactIds: [...new Set(campaign.contactIds.map(id => id === duplicate.id ? contact.id : id))] });
          this.db.prepare("DELETE FROM entities WHERE mode=? AND kind='contacts' AND id=?").run(this.mode, duplicate.id);
        }
        if (merged.ambiguous) merged.authorized = false;
        this._mergeRecipientKeys(oldKey, recipientKey(merged));
        contact = this.save('contacts', merged);
        for (const alias of merged.identifiers) this.db.prepare('INSERT INTO identity_aliases(mode,alias,contact_id) VALUES(?,?,?) ON CONFLICT(mode,alias) DO UPDATE SET contact_id=excluded.contact_id').run(this.mode, alias, contact.id);
        summary.identified++; if (!contact.phone) summary.unavailable++;
      }
      return summary;
    });
  }
  _mergeRecipientKeys(oldKey, newKey) {
    if (!oldKey || oldKey === newKey) return;
    const oldClaim = this.db.prepare('SELECT * FROM recipient_claims WHERE mode=? AND recipient_key=?').get(this.mode, oldKey);
    const nextClaim = this.db.prepare('SELECT * FROM recipient_claims WHERE mode=? AND recipient_key=?').get(this.mode, newKey);
    if (oldClaim && nextClaim && oldClaim.job_id !== nextClaim.job_id) fail('IDENTITY_ACTIVE_CONFLICT', 'Há envios ativos para identidades que se relacionaram. Pause e revise antes de unir os contatos.');
    for (const row of this.db.prepare('SELECT * FROM invitation_ledger WHERE mode=? AND recipient_key=?').all(this.mode, oldKey)) {
      this.db.prepare('INSERT INTO invitation_ledger(mode,recipient_key,job_id,status,message_id,at,data) VALUES(?,?,?,?,?,?,?) ON CONFLICT(mode,recipient_key,job_id) DO NOTHING').run(this.mode, newKey, row.job_id, row.status, row.message_id, row.at, row.data);
    }
    this.db.prepare('DELETE FROM invitation_ledger WHERE mode=? AND recipient_key=?').run(this.mode, oldKey);
    if (oldClaim) { this.db.prepare('DELETE FROM recipient_claims WHERE mode=? AND recipient_key=?').run(this.mode, oldKey); if (!nextClaim) this.db.prepare('INSERT INTO recipient_claims(mode,recipient_key,job_id,claimed_at) VALUES(?,?,?,?)').run(this.mode, newKey, oldClaim.job_id, oldClaim.claimed_at); }
  }
  recipientKey(contact) { return recipientKey(contact); }
  ledger(contact) {
    const key = recipientKey(contact);
    const attempts = this.db.prepare('SELECT * FROM invitation_ledger WHERE mode=? AND recipient_key=? ORDER BY at DESC,job_id').all(this.mode, key).map(row => ({ ...JSON.parse(row.data), jobId: row.job_id, status: row.status, messageId: row.message_id, at: row.at }));
    const active = this.db.prepare('SELECT job_id FROM recipient_claims WHERE mode=? AND recipient_key=?').get(this.mode, key);
    const status = attempts.some(row => row.status === 'delivered') ? 'delivered' : attempts.some(row => row.status === 'accepted') ? 'accepted' : attempts.some(row => row.status === 'uncertain') ? 'uncertain' : attempts[0]?.status || null;
    return { recipientKey: key, attempts, status, highestStatus: status, lastStatus: attempts[0]?.status || null, previouslyInvited: attempts.some(row => PROOF.has(row.status)), uncertain: attempts.some(row => row.status === 'uncertain'), activeJobId: active?.job_id || null, lastAcceptedAt: attempts.find(row => row.status === 'accepted' || row.status === 'delivered')?.at || null, lastDeliveredAt: attempts.find(row => row.status === 'delivered')?.at || null, lastUncertainAt: attempts.find(row => row.status === 'uncertain')?.at || null };
  }
  isPreviouslyInvited(contact) { return this.ledger(contact).previouslyInvited; }
  claimRecipient(contact, jobId, options = {}) {
    return this.transaction(() => {
      const key = recipientKey(contact), state = this.ledger(key);
      if (state.activeJobId) return state.activeJobId === jobId;
      const unresolved = state.attempts.filter(attempt => attempt.status === 'uncertain');
      const reviewed = options.reviewedJobId && unresolved.length === 1 && unresolved[0].jobId === options.reviewedJobId && unresolved[0].manualDuplicateReviewAt && (!unresolved[0].manualDuplicateReviewConsumedBy || unresolved[0].manualDuplicateReviewConsumedBy === jobId);
      if (state.uncertain && !reviewed || state.previouslyInvited && !options.allowRepeat) return false;
      try {
        this.db.prepare('INSERT INTO recipient_claims(mode,recipient_key,job_id,claimed_at) VALUES(?,?,?,?)').run(this.mode, key, String(jobId), stamp(options.at));
        if (reviewed) {
          const row = this.db.prepare('SELECT data FROM invitation_ledger WHERE mode=? AND recipient_key=? AND job_id=?').get(this.mode, key, options.reviewedJobId);
          this.db.prepare('UPDATE invitation_ledger SET data=? WHERE mode=? AND recipient_key=? AND job_id=?').run(JSON.stringify({ ...JSON.parse(row.data), manualDuplicateReviewConsumedBy: jobId }), this.mode, key, options.reviewedJobId);
        }
        return true;
      }
      catch (error) { if (String(error.code).includes('CONSTRAINT') || String(error.message).includes('UNIQUE constraint')) return false; throw error; }
    });
  }
  releaseRecipient(contact, jobId) { return Number(this.db.prepare('DELETE FROM recipient_claims WHERE mode=? AND recipient_key=? AND job_id=?').run(this.mode, recipientKey(contact), String(jobId)).changes) > 0; }
  reviewUncertainRecipient(contact, priorJobId, options = {}) {
    if (options.allowManualDuplicate !== true) fail('MANUAL_CONFIRMATION_REQUIRED', 'Confirme o risco de duplicação antes de reenviar um resultado incerto.');
    const key = recipientKey(contact);
    const row = this.db.prepare("SELECT * FROM invitation_ledger WHERE mode=? AND recipient_key=? AND job_id=? AND status='uncertain'").get(this.mode, key, String(priorJobId));
    if (!row) fail('UNCERTAIN_NOT_FOUND', 'O envio incerto não foi encontrado para revisão.');
    const at = stamp(options.at), data = { ...JSON.parse(row.data), manualDuplicateReviewAt: at };
    this.db.prepare('UPDATE invitation_ledger SET data=? WHERE mode=? AND recipient_key=? AND job_id=?').run(JSON.stringify(data), this.mode, key, String(priorJobId));
    this.audit({ action: 'uncertain-manual-duplicate-confirmed', contactId: typeof contact === 'object' ? contact.id : null, jobId: priorJobId, at });
    return true;
  }
  markRecipient(contact, jobId, status, metadata = {}) {
    if (!['pending', 'processing', 'accepted', 'delivered', 'uncertain', 'failed', 'cancelled'].includes(status)) fail('INVALID_SEND_STATUS', 'Estado de envio inválido.');
    return this.transaction(() => {
      const key = recipientKey(contact), existing = this.db.prepare('SELECT * FROM invitation_ledger WHERE mode=? AND recipient_key=? AND job_id=?').get(this.mode, key, String(jobId));
      if (existing?.status === 'delivered' || existing?.status === 'accepted' && status !== 'delivered' || existing?.status === 'uncertain' && !['accepted', 'delivered'].includes(status)) status = existing.status;
      const at = stamp(metadata.at), data = { ...(existing ? JSON.parse(existing.data) : {}), ...safeLog(metadata) };
      this.db.prepare('INSERT INTO invitation_ledger(mode,recipient_key,job_id,status,message_id,at,data) VALUES(?,?,?,?,?,?,?) ON CONFLICT(mode,recipient_key,job_id) DO UPDATE SET status=excluded.status,message_id=COALESCE(excluded.message_id,invitation_ledger.message_id),at=excluded.at,data=excluded.data').run(this.mode, key, String(jobId), status, metadata.messageId || existing?.message_id || null, at, JSON.stringify(data));
      if (['accepted', 'delivered', 'uncertain', 'failed', 'cancelled'].includes(status)) this.releaseRecipient(key, jobId);
      return this.ledger(key);
    });
  }
  audit(event) { return this.save('audit', { ...safeLog(event), id: event?.id || crypto.randomUUID(), createdAt: event?.at ?? event?.createdAt ?? Date.now() }); }
  diagnostics(event) { return this.save('diagnostics', { ...safeLog(event), id: event?.id || crypto.randomUUID(), createdAt: event?.at ?? event?.createdAt ?? Date.now() }); }
  backupTo(destination) {
    const target = path.resolve(destination);
    if (target === this.filePath || target === `${this.filePath}-wal` || target === `${this.filePath}-shm`) fail('INVALID_BACKUP_PATH', 'Escolha outro arquivo para salvar o backup.');
    if (this.depth) fail('BACKUP_TRANSACTION_ACTIVE', 'Aguarde a operação atual antes de fazer o backup.');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.writing-${crypto.randomUUID()}`;
    try { this.db.prepare('VACUUM INTO ?').run(temporary); const candidate = new DatabaseSync(temporary, { readOnly: true }); try { validateDatabase(candidate); } finally { candidate.close(); } fs.renameSync(temporary, target); try { fs.chmodSync(target, 0o600); } catch {} return { path: target, size: fs.statSync(target).size, includesCredentials: false }; }
    finally { try { fs.unlinkSync(temporary); } catch {} }
  }
  _captureRecoveryOverlay() {
    const originalMode = this.mode, overlay = {};
    try {
      for (const mode of MODES) {
        this.mode = mode;
        // Only evidence of a possible or confirmed submission survives as an overlay.
        // A temporary stop before restoration cancels the live pending jobs; replaying
        // those cancellations would release reservations belonging to the backup.
        const ledger = this.db.prepare("SELECT * FROM invitation_ledger WHERE mode=? AND status IN ('accepted','delivered','uncertain')").all(mode);
        const jobs = this.listAll('jobs').filter(job => job.submittedAt != null || PROOF.has(job.status));
        const contactIds = new Set(jobs.map(job => job.contactId));
        const recipientKeys = new Set(ledger.filter(row => PROOF.has(row.status)).map(row => row.recipient_key));
        const contacts = this.listAll('contacts').filter(contact => contact.blocked || contact.optOut || contact.muted || contact.authorized === false && contact.authorizedAt != null || contactIds.has(contact.id) || recipientKeys.has(recipientKey(contact)));
        overlay[mode] = { ledger, jobs, contacts };
      }
    } finally { this.mode = originalMode; }
    return overlay;
  }
  _mergeRecoveryOverlay(overlay) {
    const contactIds = new Map();
    for (const current of overlay.contacts) {
      const existing = (current.phone ? this._contactByAlias(`${current.phone}@s.whatsapp.net`) : null) || (current.identifiers || []).map(alias => this._contactByAlias(alias)).find(Boolean);
      let merged;
      if (existing && (!current.phone || !existing.phone || current.phone === existing.phone)) {
        merged = { ...existing, blocked: !!existing.blocked || !!current.blocked, optOut: !!existing.optOut || !!current.optOut, muted: !!existing.muted || !!current.muted, ambiguous: !!existing.ambiguous || !!current.ambiguous };
        if (current.authorized === false && current.authorizedAt != null) merged.authorized = false;
      } else {
        const collision = this.get('contacts', current.id);
        merged = { ...current, id: collision ? crypto.randomUUID() : current.id, authorized: false, authorizedAt: null, consentNote: '', recoveredOperationalRecord: true };
        if (existing) { merged.ambiguous = true; merged.phone = null; merged.identifiers = []; merged.externalId = null; }
      }
      if (merged.blocked || merged.optOut || merged.ambiguous) merged.authorized = false;
      const saved = this.save('contacts', merged); contactIds.set(current.id, saved.id);
    }
    for (const job of overlay.jobs) {
      const status = job.status === 'processing' && job.submittedAt != null ? 'uncertain' : job.status;
      this.save('jobs', { ...job, contactId: contactIds.get(job.contactId) || job.contactId, status, recoveredOperationalRecord: true });
      if (PROOF.has(status)) this.markRecipient(job.recipientKey || this.get('contacts', contactIds.get(job.contactId) || job.contactId), job.id, status, { at: job.resultAt || Date.now(), messageId: job.messageId });
    }
    for (const row of overlay.ledger) this.markRecipient(row.recipient_key, row.job_id, row.status, { ...JSON.parse(row.data), at: row.at, messageId: row.message_id });
    this.audit({ action: 'restore-operational-protection-preserved', at: Date.now(), ledgerEntries: overlay.ledger.length, submittedJobs: overlay.jobs.length, restrictedOrInvitedContacts: overlay.contacts.length });
  }
  restoreFrom(source) {
    if (this.depth) fail('RESTORE_TRANSACTION_ACTIVE', 'Aguarde a operação atual antes de restaurar.');
    if (path.resolve(source) === this.filePath) fail('INVALID_BACKUP_PATH', 'Selecione um arquivo de backup separado do banco em uso.');
    const incoming = new DatabaseSync(path.resolve(source), { readOnly: true });
    const stage = path.join(this.dir, `restore-${crypto.randomUUID()}.sqlite`);
    try { validateDatabase(incoming); incoming.prepare('VACUUM INTO ?').run(stage); } finally { incoming.close(); }
    const recoveryPath = path.join(this.dir, 'backups', `antes-restauracao-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.sqlite`);
    this.backupTo(recoveryPath);
    const operationalOverlay = this._captureRecoveryOverlay();
    const old = `${this.filePath}.replaced-${crypto.randomUUID()}`;
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); this.db.close();
      fs.renameSync(this.filePath, old); fs.renameSync(stage, this.filePath);
      for (const suffix of ['-wal', '-shm']) try { fs.unlinkSync(`${this.filePath}${suffix}`); } catch {}
      this._open(); this.mode = this.db.prepare("SELECT value FROM meta WHERE key='mode'").get()?.value || 'whatsapp';
      const originalMode = this.mode;
      for (const mode of MODES) {
        this.mode = mode;
        this.transaction(() => {
          this._mergeRecoveryOverlay(operationalOverlay[mode]);
          for (const job of this.listAll('jobs', { status: 'processing' })) {
            const status = job.submittedAt ? 'uncertain' : 'pending';
            this.save('jobs', { ...job, status, manualReview: false, recoveryReason: 'backup-restored', errorCode: job.submittedAt ? 'RESTORE_SUBMITTED_UNCERTAIN' : null });
            if (job.submittedAt) this.markRecipient(job.recipientKey || this.get('contacts', job.contactId), job.id, 'uncertain', { at: Date.now(), messageId: job.messageId });
          }
          for (const run of this.listAll('runs', { status: ['active', 'running', 'scheduled'] })) this.save('runs', { ...run, status: 'paused', pauseReason: 'backup-restored' });
          for (const campaign of this.listAll('campaigns', { status: ['active', 'scheduled'] })) this.save('campaigns', { ...campaign, status: 'paused', pauseReason: 'backup-restored' });
          this.setSetting('automationStopped', true);
          this.setSetting('queueState', { ...this.getSetting('queueState', {}), automationStopped: true, reason: 'Backup restaurado — revise os dados e retome explicitamente.', stoppedAt: Date.now() });
          this.audit({ action: 'backup-restored', at: Date.now(), message: 'Dados restaurados; automações pausadas para revisão.' });
        });
      }
      this.mode = originalMode; fs.unlinkSync(old);
      return { restored: true, recoveryPath, paused: true, includesCredentials: false };
    } catch (error) {
      try { this.db.close(); } catch {}
      if (fs.existsSync(old)) { try { fs.unlinkSync(this.filePath); } catch {} fs.renameSync(old, this.filePath); this._open(); this.mode = this.db.prepare("SELECT value FROM meta WHERE key='mode'").get()?.value || 'whatsapp'; }
      throw error;
    } finally { try { fs.unlinkSync(stage); } catch {} }
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
}

function createStore(dir) { return new CommunityStore(dir); }
module.exports = { createStore, CommunityStore, recipientKey, normalizePhone: phoneNumber, normalizeIdentity: identity, SCHEMA, APP_ID };
