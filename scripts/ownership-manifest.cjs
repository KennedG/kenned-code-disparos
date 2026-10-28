'use strict';

const fs = require('node:fs');
const path = require('node:path');
const MANIFEST = '.mega-owned-files.txt';

/** Package ownership, so uninstall never recursively removes a chosen folder. */
function writeOwnershipManifest(appOutDir) {
  const files = [], directories = [];
  function walk(relative = '') {
    for (const entry of fs.readdirSync(path.join(appOutDir, relative), { withFileTypes: true })) {
      const next = path.join(relative, entry.name);
      const name = next.split(path.sep).join('\\');
      if (name === MANIFEST) continue;
      if (entry.isDirectory()) { directories.push(name); walk(next); }
      else files.push(name);
    }
  }
  walk();
  const records = files.sort().map(name => `F|${name}`);
  records.push(...directories.sort((a,b) => b.split('\\').length-a.split('\\').length || a.localeCompare(b)).map(name => `D|${name}`));
  fs.writeFileSync(path.join(appOutDir, MANIFEST), records.join('\r\n')+'\r\n', 'utf16le');
  return { files: files.length, directories: directories.length };
}

module.exports = async context => writeOwnershipManifest(context.appOutDir);
module.exports.writeOwnershipManifest = writeOwnershipManifest;
