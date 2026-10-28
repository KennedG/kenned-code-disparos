'use strict';
const { spawnSync } = require('node:child_process');
const result = spawnSync(process.execPath, [require.resolve('electron-builder/cli.js'), '--win', 'nsis', '--x64', '--publish', 'never', ...process.argv.slice(2)], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
