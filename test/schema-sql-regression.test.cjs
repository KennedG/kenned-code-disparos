'use strict';

// Schema-only fixtures, with no records from any user's database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ddlTokens, equivalentDDL } = require('../src/core/sql-ddl-tokens.cjs');
const { inspectDatabaseCompatibility } = require('../src/core/schema-compatibility.cjs');
const manifest = require('../src/core/storage-schema-7.json');
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/schema-8.sql'), 'utf8');
const campaignDDL = manifest.tables.find(table => table.name === 'campaigns').sql;
const open = (t, sql = fixture) => {
  const db = new DatabaseSync(':memory:'); db.exec(sql); t.after(() => db.close()); return db;
};
const withCampaign = ddl => fixture.replace(/CREATE TABLE campaigns\([^;]+;/, ddl + ';');
const incompatible = error => error.code === 'DATABASE_SCHEMA_INCOMPATIBLE';

test('DDL spelling accepts spaces, comments, keyword casing and quoted identifiers without changing literals', () => {
  const alternative = `create /* schema-only */ table [campaigns] (
    \`id\` text primary/**/key,
    "data" text not -- keep the keyword boundary
    null, "storageMode" text not null default 'whatsapp');`;
  assert.equal(equivalentDDL(alternative, campaignDDL), true);
  assert.equal(equivalentDDL('CREATE TABLE campaigns(id TEXT PRIMARY KEY, data TEXT NOT NULL, storageMode TEXT NOT NULL DEFAULT \'whatsapp\')', campaignDDL), true);
  assert.equal(equivalentDDL("SELECT '/*literal*/ --literal'", "select '/*literal*/ --literal'"), true);
  assert.equal(equivalentDDL("SELECT 'Auditoria   imutável'", "SELECT 'Auditoria imutável'"), false);
  assert.equal(equivalentDDL("DEFAULT 'WhatsApp'", "DEFAULT 'whatsapp'"), false);
  assert.equal(equivalentDDL('SELECT "NULL"', 'SELECT NULL'), false);
});

test('comments never join tokens and malformed or unsupported definitions fail closed', () => {
  assert.deepEqual(ddlTokens('NOT/**/NULL'), ddlTokens('not null'));
  assert.equal(equivalentDDL('CRE/**/ATE TABLE t(x TEXT)', 'CREATE TABLE t(x TEXT)'), false);
  assert.equal(equivalentDDL("SELECT 'unterminated", "SELECT 'literal'"), false);
  assert.equal(equivalentDDL('CREATE TABLE t(x TEXT) /*unfinished', 'CREATE TABLE t(x TEXT)'), false);
  assert.equal(equivalentDDL('SELECT ?', 'SELECT 0'), false);
  assert.equal(equivalentDDL('SELECT 0; SELECT 1;', 'SELECT 0;'), false);
  assert.equal(equivalentDDL('SELECT 0;;', 'SELECT 0;'), false);
});

test('the complete known schema accepts equivalent campaign DDL and old CREATE plus ALTER spelling', t => {
  for (const ddl of [
    campaignDDL.replace('KEY,data', 'KEY, data'),
    `CREATE TABLE "campaigns" ("id" TEXT PRIMARY KEY, "data" TEXT NOT NULL, "storageMode" TEXT NOT NULL DEFAULT 'whatsapp')`,
    `create table campaigns (id text primary /* comment */ key, data text not null, storageMode text not null default 'whatsapp')`,
    `CREATE TABLE campaigns (id TEXT PRIMARY KEY, data TEXT NOT NULL); ALTER TABLE campaigns ADD COLUMN storageMode TEXT NOT NULL DEFAULT 'whatsapp'`
  ]) {
    const db = open(t, withCampaign(ddl));
    assert.equal(inspectDatabaseCompatibility(db, 8).verifiedCoreTables, 41);
  }
});

test('column names, defaults, checks and collations retain their exact protection', t => {
  const alternatives = [
    campaignDDL.replace('id TEXT', 'ID TEXT'),
    campaignDDL.replace('data TEXT NOT NULL', 'data TEXT'),
    campaignDDL.replace("'whatsapp'", "'WHATSAPP'"),
    campaignDDL.replace('data TEXT NOT NULL', 'data TEXT COLLATE NOCASE NOT NULL'),
    campaignDDL.replace("DEFAULT 'whatsapp'", "DEFAULT 'whatsapp' CHECK(length(data)>0)"),
    campaignDDL.replace('id TEXT PRIMARY KEY', 'id TEXT PRIMARY KEY DESC')
  ];
  for (const ddl of alternatives) assert.throws(() => inspectDatabaseCompatibility(open(t, withCampaign(ddl)), 8), incompatible);
});

test('partial unique predicates, collations, sorting and expression indexes cannot replace the expected index', t => {
  const modifications = [
    'CREATE UNIQUE INDEX buscas_runs_command ON buscas_runs(chatId,messageId)',
    'CREATE UNIQUE INDEX buscas_runs_command ON buscas_runs(chatId,messageId) WHERE chatId IS NULL AND messageId IS NOT NULL',
    'CREATE UNIQUE INDEX buscas_runs_command ON buscas_runs(chatId COLLATE NOCASE,messageId) WHERE chatId IS NOT NULL AND messageId IS NOT NULL',
    'CREATE UNIQUE INDEX buscas_runs_command ON buscas_runs(chatId DESC,messageId) WHERE chatId IS NOT NULL AND messageId IS NOT NULL',
    'CREATE UNIQUE INDEX buscas_runs_command ON buscas_runs(lower(chatId),messageId) WHERE chatId IS NOT NULL AND messageId IS NOT NULL'
  ];
  for (const sql of modifications) {
    const db = open(t); db.exec('DROP INDEX buscas_runs_command; ' + sql);
    assert.throws(() => inspectDatabaseCompatibility(db, 8), incompatible);
  }
  const equivalent = open(t);
  equivalent.exec('DROP INDEX buscas_runs_command; create unique index "buscas_runs_command" on "buscas_runs" ("chatId", "messageId") where "chatId" is not /* gap */ null and "messageId" is not null');
  assert.equal(inspectDatabaseCompatibility(equivalent, 8).databaseSchemaVersion, 8);
});

test('index PRAGMA partial and key metadata are validated independently of the SQL string', t => {
  const db = open(t);
  for (const tamper of [
    row => ({ ...row, partial: 0 }),
    row => ({ ...row, origin: 'u' })
  ]) {
    const guarded = { prepare(sql) {
      if (sql === 'PRAGMA index_list("buscas_runs")') return { all: () => db.prepare(sql).all().map(row => row.name === 'buscas_runs_command' ? tamper(row) : row) };
      return db.prepare(sql);
    } };
    assert.throws(() => inspectDatabaseCompatibility(guarded, 8), incompatible);
  }
  for (const tamper of [
    row => ({ ...row, coll: 'NOCASE' }),
    row => ({ ...row, desc: 1 }),
    row => ({ ...row, cid: -2 }),
    row => ({ ...row, key: 0 })
  ]) {
    const guarded = { prepare(sql) {
      if (sql === 'PRAGMA index_xinfo("buscas_runs_command")') return { all: () => db.prepare(sql).all().map(row => row.key === 1 ? tamper(row) : row) };
      return db.prepare(sql);
    } };
    assert.throws(() => inspectDatabaseCompatibility(guarded, 8), incompatible);
  }
});

test('audit triggers permit spelling changes but retain literal text, body, event and count', t => {
  const db = open(t);
  db.exec(`DROP TRIGGER audit_immutable_update;
    create trigger "audit_immutable_update" before update on [audit] begin select raise(abort,'Auditoria imutável'); end;`);
  assert.equal(inspectDatabaseCompatibility(db, 8).databaseSchemaVersion, 8);
  db.exec(`DROP TRIGGER audit_immutable_update;
    CREATE TRIGGER audit_immutable_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'Auditoria   imutável'); END;`);
  assert.throws(() => inspectDatabaseCompatibility(db, 8), incompatible);
  db.exec(`DROP TRIGGER audit_immutable_update;
    CREATE TRIGGER audit_immutable_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(IGNORE); END;`);
  assert.throws(() => inspectDatabaseCompatibility(db, 8), incompatible);
});
