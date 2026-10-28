'use strict';

const manifest = require('./storage-schema-7.json');
const quote = name => '"' + name.replace(/"/g, '""') + '"';
const normalize = sql => String(sql || '').replace(/\s+/g, ' ').trim();
const signature = columns => JSON.stringify(columns.map(({ name, type, notnull, dflt_value, pk, hidden }) => ({ name, type, notnull, dflt_value, pk, hidden })));

function incompatible(version, detail) {
  return Object.assign(new Error(`O banco usa o esquema ${version}, mas sua estrutura não é compatível com esta versão do aplicativo (${detail}). Seus dados foram preservados. Não apague o banco; utilize uma versão compatível ou uma cópia de recuperação.`), { code: 'DATABASE_SCHEMA_INCOMPATIBLE', databaseSchemaVersion: version });
}

function inspectDatabaseCompatibility(db, version) {
  if (version <= manifest.coreSchemaVersion) return null;
  if (version !== 8) throw Object.assign(new Error(`Este banco usa o esquema ${version}, mais recente que os esquemas compatíveis com este aplicativo (7 e 8). Seus dados foram preservados. Atualize para uma versão compatível; não apague o banco.`), { code: 'DATABASE_SCHEMA_NEWER', databaseSchemaVersion: version });
  const objects = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master').all();
  const tables = new Map(objects.filter(object => object.type === 'table').map(object => [object.name, object]));
  for (const expected of manifest.tables) {
    const actual = tables.get(expected.name);
    if (!actual || normalize(actual.sql) !== normalize(expected.sql)) throw incompatible(version, `tabela ${expected.name}`);
    const columns = db.prepare(`PRAGMA table_xinfo(${quote(expected.name)})`).all();
    if (signature(columns) !== signature(expected.columns)) throw incompatible(version, `colunas de ${expected.name}`);
  }
  for (const expected of manifest.uniqueIndexes) {
    const indexes = db.prepare(`PRAGMA index_list(${quote(expected.table)})`).all();
    const found = indexes.some(index => {
      if (!index.unique || expected.name && index.name !== expected.name) return false;
      const columns = db.prepare(`PRAGMA index_info(${quote(index.name)})`).all().map(column => column.name);
      if (JSON.stringify(columns) !== JSON.stringify(expected.columns)) return false;
      const object = objects.find(value => value.type === 'index' && value.name === index.name);
      return !expected.sql || normalize(object?.sql) === normalize(expected.sql);
    });
    if (!found) throw incompatible(version, `proteção contra duplicidade em ${expected.table}`);
  }
  const coreNames = new Set(manifest.tables.map(table => table.name));
  const triggers = objects.filter(object => object.type === 'trigger' && coreNames.has(object.tbl_name));
  if (triggers.length !== manifest.triggers.length || manifest.triggers.some(expected => !triggers.some(actual => actual.name === expected.name && normalize(actual.sql) === normalize(expected.sql)))) throw incompatible(version, 'proteções de auditoria ou gatilhos desconhecidos');
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw incompatible(version, 'verificação de integridade');
  return { databaseSchemaVersion: version, coreSchemaVersion: manifest.coreSchemaVersion, verifiedCoreTables: manifest.tables.length, extraTablesPreserved: tables.size - manifest.tables.length };
}

module.exports = { inspectDatabaseCompatibility };
