'use strict';
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
const files = fs.readdirSync('test').filter(name => name.endsWith('.test.cjs')).sort();
if (!files.length) throw new Error('Nenhum teste encontrado.');
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files.map(name => path.join('test', name))], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
