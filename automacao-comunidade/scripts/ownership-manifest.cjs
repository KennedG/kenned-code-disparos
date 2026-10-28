'use strict';
const fs = require('node:fs'), path = require('node:path');
const MANIFEST = '.automacao-comunidade-owned-files.txt';
function writeOwnershipManifest(appOutDir) {
  const files = [], directories = [];
  function walk(relative = '') {
    for (const entry of fs.readdirSync(path.join(appOutDir, relative), { withFileTypes: true })) {
      const next = path.join(relative, entry.name), name = next.split(path.sep).join('\\');
      if (name === MANIFEST) continue;
      if (entry.isDirectory()) { directories.push(name); walk(next); } else files.push(name);
    }
  }
  walk();
  const rows = files.sort().map(name => `F|${name}`);
  rows.push(...directories.sort((a, b) => b.split('\\').length - a.split('\\').length || a.localeCompare(b)).map(name => `D|${name}`));
  fs.writeFileSync(path.join(appOutDir, MANIFEST), `${rows.join('\r\n')}\r\n`, 'utf16le');
  return { files: files.length, directories: directories.length };
}
module.exports = async context => writeOwnershipManifest(context.appOutDir);
module.exports.writeOwnershipManifest = writeOwnershipManifest;
module.exports.MANIFEST = MANIFEST;
