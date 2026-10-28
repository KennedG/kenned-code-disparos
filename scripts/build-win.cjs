const {spawnSync}=require('node:child_process');
const entry=require.resolve('electron-builder/cli.js');
const result=spawnSync(process.execPath,[entry,'--win','nsis','--x64','--publish','never',...process.argv.slice(2)],{stdio:'inherit'});
process.exitCode=result.status??1;
