'use strict';

const manifest = require('./storage-schema-7.json');
const { DatabaseSync } = require('node:sqlite');
const { equivalentDDL } = require('./sql-ddl-tokens.cjs');
const quote = name => '"' + name.replace(/"/g, '""') + '"';
const signature = columns => JSON.stringify(columns.map(({ name, type, notnull, dflt_value, pk, hidden }) => ({ name, type, notnull, dflt_value, pk, hidden })));
const indexSignature = columns => JSON.stringify(columns.filter(column => column.key === 1).map(({ cid, name, desc, coll, key }) => ({ cid, name, desc, coll, key })));
let expectedIndexes;

function trustedIndexes() {
  if (expectedIndexes) return expectedIndexes;
  // Derive the comparison metadata from the bundled, trusted core schema.
  // This disposable database never opens or modifies the user's database.
  const reference = new DatabaseSync(':memory:');
  try {
    for (const table of manifest.tables) reference.exec(table.sql);
    for (const index of manifest.uniqueIndexes) if (index.sql) reference.exec(index.sql);
    expectedIndexes = manifest.uniqueIndexes.map(expected => {
      const indexes = reference.prepare(`PRAGMA index_list(${quote(expected.table)})`).all();
      const match = indexes.find(index => {
        if (!index.unique || expected.name && index.name !== expected.name) return false;
        const columns = reference.prepare(`PRAGMA index_info(${quote(index.name)})`).all().map(column => column.name);
        return JSON.stringify(columns) === JSON.stringify(expected.columns);
      });
      if (!match) throw new Error('Manifesto de índices do aplicativo inválido.');
      return { ...expected, origin: match.origin, partial: match.partial,
        signature: indexSignature(reference.prepare(`PRAGMA index_xinfo(${quote(match.name)})`).all()) };
    });
    return expectedIndexes;
  } finally { reference.close(); }
}

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
    if (!actual || !equivalentDDL(actual.sql, expected.sql)) throw incompatible(version, `tabela ${expected.name}`);
    const columns = db.prepare(`PRAGMA table_xinfo(${quote(expected.name)})`).all();
    if (signature(columns) !== signature(expected.columns)) throw incompatible(version, `colunas de ${expected.name}`);
  }
  for (const expected of trustedIndexes()) {
    const indexes = db.prepare(`PRAGMA index_list(${quote(expected.table)})`).all();
    const found = indexes.some(index => {
      if (!index.unique || index.origin !== expected.origin || index.partial !== expected.partial || expected.name && index.name !== expected.name) return false;
      const columns = db.prepare(`PRAGMA index_info(${quote(index.name)})`).all().map(column => column.name);
      if (JSON.stringify(columns) !== JSON.stringify(expected.columns)) return false;
      if (indexSignature(db.prepare(`PRAGMA index_xinfo(${quote(index.name)})`).all()) !== expected.signature) return false;
      const object = objects.find(value => value.type === 'index' && value.name === index.name);
      return !expected.sql || equivalentDDL(object?.sql, expected.sql);
    });
    if (!found) throw incompatible(version, `proteção contra duplicidade em ${expected.table}`);
  }
  const coreNames = new Set(manifest.tables.map(table => table.name));
  const triggers = objects.filter(object => object.type === 'trigger' && coreNames.has(object.tbl_name));
  if (triggers.length !== manifest.triggers.length || manifest.triggers.some(expected => !triggers.some(actual => actual.name === expected.name && equivalentDDL(actual.sql, expected.sql)))) throw incompatible(version, 'proteções de auditoria ou gatilhos desconhecidos');
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw incompatible(version, 'verificação de integridade');
  return { databaseSchemaVersion: version, coreSchemaVersion: manifest.coreSchemaVersion, verifiedCoreTables: manifest.tables.length, extraTablesPreserved: tables.size - manifest.tables.length };
}

module.exports = { inspectDatabaseCompatibility };
