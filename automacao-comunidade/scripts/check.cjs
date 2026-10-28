'use strict';
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
let failures = 0, checked = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const next = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(next);
    else if (/\.(?:cjs|js|mjs)$/.test(next)) {
      checked++;
      const result = spawnSync(process.execPath, ['--check', next], { encoding: 'utf8' });
      if (result.status !== 0) { failures++; process.stderr.write(result.stderr || next); }
    }
  }
}
for (const directory of ['src', 'scripts', 'test']) if (fs.existsSync(directory)) walk(directory);
process.stdout.write(`${checked} arquivos verificados; ${failures} erros de sintaxe.\n`);
process.exitCode = failures ? 1 : 0;
