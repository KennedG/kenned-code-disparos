const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
let failed=false;
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(/\.(?:cjs|js)$/.test(p)){const r=spawnSync(process.execPath,['--check',p],{encoding:'utf8'});if(r.status){process.stderr.write(r.stderr);failed=true;}}}}
walk('src');walk('test');walk('scripts');process.exitCode=failed?1:0;
