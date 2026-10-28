const {spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path');
let failed=false;
for(const filename of fs.readdirSync('test').filter(f=>f.endsWith('.test.cjs')).sort()){
  process.stdout.write(`\n${filename}\n`);
  const result=spawnSync(process.execPath,[path.join('test',filename)],{stdio:'inherit'});
  if(result.status!==0)failed=true;
}
const desktop=spawnSync(process.execPath,['scripts/test-desktop.cjs'],{stdio:'inherit'});
if(desktop.status!==0)failed=true;
process.exitCode=failed?1:0;
