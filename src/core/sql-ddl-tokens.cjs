'use strict';

// Canonicalize spelling only. Do not normalize expressions, remove constraints
// or alter literals. Quoted names retain their identifier role, including when
// the quoted text happens to be a keyword.
const KEYWORDS = new Set(('ABORT ACTION ADD AFTER ALL ALTER ANALYZE AND AS ASC ATTACH AUTOINCREMENT BEFORE BEGIN BETWEEN BY CASCADE CASE CAST CHECK COLLATE COLUMN COMMIT CONFLICT CONSTRAINT CREATE CROSS CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP DATABASE DEFAULT DEFERRABLE DEFERRED DELETE DESC DETACH DISTINCT DO DROP EACH ELSE END ESCAPE EXCEPT EXCLUDE EXCLUSIVE EXISTS EXPLAIN FAIL FILTER FIRST FOLLOWING FOR FOREIGN FROM FULL GENERATED GLOB GROUP GROUPS HAVING IF IGNORE IMMEDIATE IN INDEX INDEXED INITIALLY INNER INSERT INSTEAD INTERSECT INTO IS ISNULL JOIN KEY LAST LEFT LIKE LIMIT MATCH MATERIALIZED NATURAL NO NOT NOTHING NOTNULL NULL NULLS OF OFFSET ON OR ORDER OTHERS OUTER OVER PARTITION PLAN PRAGMA PRECEDING PRIMARY QUERY RAISE RANGE RECURSIVE REFERENCES REGEXP REINDEX RELEASE RENAME REPLACE RESTRICT RETURNING RIGHT ROLLBACK ROW ROWS SAVEPOINT SELECT SET TABLE TEMP TEMPORARY THEN TIES TO TRANSACTION TRIGGER UNBOUNDED UNION UNIQUE UPDATE USING VACUUM VALUES VIEW VIRTUAL WHEN WHERE WINDOW WITH WITHOUT TEXT INTEGER').split(' '));
// RAISE is a function name, not a syntax keyword. Keeping it an identifier also
// permits its ordinary case variants without changing the trigger body.
KEYWORDS.delete('RAISE');
const fold = value => value.replace(/[a-z]/g, char => char.toUpperCase());
const wordStart = /[A-Za-z_\p{L}]/u;
const wordPart = /[A-Za-z0-9_$\p{L}\p{N}]/u;

function ddlTokens(sql) {
  if (typeof sql !== 'string' || sql.length > 1048576) throw new Error('Definição SQL ausente ou excessiva.');
  const tokens = [];
  let offset = 0;
  const append = (kind, value) => {
    if (tokens.length >= 100000) throw new Error('Definição SQL excessiva.');
    tokens.push([kind, value]);
  };
  while (offset < sql.length) {
    const char = sql[offset], next = sql[offset + 1];
    if (/\s/.test(char)) { offset++; continue; }
    if (char === '-' && next === '-') {
      offset += 2; while (offset < sql.length && sql[offset] !== '\n' && sql[offset] !== '\r') offset++;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', offset + 2);
      if (end < 0) throw new Error('Comentário SQL não terminado.');
      offset = end + 2; continue;
    }
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const endQuote = char === '[' ? ']' : char;
      const stringLiteral = char === "'";
      let value = '', closed = false;
      offset++;
      while (offset < sql.length) {
        if (sql[offset] === endQuote) {
          // SQLite bracket quoting has no doubled-bracket escape.
          if (char !== '[' && sql[offset + 1] === endQuote) { value += endQuote; offset += 2; continue; }
          offset++; closed = true; break;
        }
        value += sql[offset++];
      }
      if (!closed) throw new Error('Aspas SQL não terminadas.');
      append(stringLiteral ? 'string' : 'identifier', stringLiteral ? value : fold(value));
      continue;
    }
    if (wordStart.test(char)) {
      const start = offset++;
      while (offset < sql.length && wordPart.test(sql[offset])) offset++;
      const value = fold(sql.slice(start, offset));
      append(KEYWORDS.has(value) ? 'keyword' : 'identifier', value);
      continue;
    }
    if (/[0-9]/.test(char) || char === '.' && /[0-9]/.test(next || '')) {
      const number = /^(?:0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(sql.slice(offset));
      if (!number) throw new Error('Número SQL inválido.');
      append('number', number[0]); offset += number[0].length; continue;
    }
    const operator = /^(?:->>|->|\|\||<<|>>|<=|>=|<>|!=|==|[(),.;+\-*\/%&|~=<>])/u.exec(sql.slice(offset));
    if (!operator) throw new Error('Token SQL não suportado.');
    append('punctuation', operator[0]); offset += operator[0].length;
  }
  // sqlite_schema usually omits the final statement delimiter. Preserve every
  // internal delimiter, including those separating statements inside triggers.
  if (tokens.at(-1)?.[0] === 'punctuation' && tokens.at(-1)?.[1] === ';') tokens.pop();
  return tokens;
}

function equivalentDDL(actual, expected) {
  try { return JSON.stringify(ddlTokens(actual)) === JSON.stringify(ddlTokens(expected)); }
  catch { return false; }
}

module.exports = { ddlTokens, equivalentDDL };
