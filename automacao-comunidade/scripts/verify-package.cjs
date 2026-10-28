'use strict';
// Offline verification. It never opens a WhatsApp session or sends a message.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const crypto=require('node:crypto'),{spawnSync}=require('node:child_process'),asar=require('@electron/asar');
const root=path.resolve(__dirname,'..');
const archive=path.resolve(process.argv[2]||path.join(root,'release/win-unpacked/resources/app.asar'));
const appExe=path.join(path.dirname(archive),'..','Automação Comunidade.exe');
const entries=asar.listPackage(archive),checks=[];
function pass(name){checks.push(name);process.stdout.write(`PASS ${name}\n`);}
const packageInfo=JSON.parse(asar.extractFile(archive,'package.json').toString());
assert.equal(packageInfo.name,'automacao-comunidade');assert.equal(packageInfo.version,require('../package.json').version);
assert.equal(packageInfo.main,'src/main.cjs');pass('Identidade independente e ponto de entrada');
for(const name of ['@whiskeysockets/baileys','pino','qrcode','@cacheable/node-cache','@hapi/boom','libsignal','lru-cache','music-metadata','p-queue','protobufjs','whatsapp-rust-bridge','ws']){
 assert(entries.includes(`/node_modules/${name}/package.json`),`Dependência ausente: ${name}`);
}
pass('Dependências de produção presentes no ASAR');
let compared=0;
function compare(directory){for(const item of fs.readdirSync(path.join(root,directory),{withFileTypes:true})){
 const relative=path.join(directory,item.name);
 if(item.isDirectory())compare(relative);else{assert.deepEqual(asar.extractFile(archive,relative.split(path.sep).join('/')),fs.readFileSync(path.join(root,relative)),`Arquivo diferente: ${relative}`);compared++;}
}}
for(const directory of ['src','assets','docs'])compare(directory);
for(const relative of ['README.md','LICENSE']){assert.deepEqual(asar.extractFile(archive,relative),fs.readFileSync(path.join(root,relative)));compared++;}
pass(`${compared} arquivos do aplicativo idênticos ao código revisado`);
assert(!entries.some(entry=>/^\/(?:credentials|backups|profiles|test|private-test-targets)\//i.test(entry)||/\.(?:sqlite(?:-wal|-shm)?|pfx|p12)$/i.test(entry)));
pass('Sem banco de usuário, pasta de sessão ou material administrativo');
const exe=fs.readFileSync(appExe),offset=exe.readUInt32LE(0x3c);
assert.equal(exe.toString('ascii',0,2),'MZ');assert.equal(exe.toString('ascii',offset,offset+4),'PE\u0000\u0000');
assert.equal(exe.readUInt16LE(offset+4),0x8664);pass('Executável Windows PE x64');
const electron=process.env.COMMUNITY_ELECTRON_PATH||require('electron');
const code=`const assert=require('node:assert/strict');const {WhatsAppAdapter}=require(${JSON.stringify(archive+'/src/adapters/whatsapp.cjs')});new WhatsAppAdapter({credentialsDir:'UNUSED_OFFLINE_CHECK'}).loadLibrary().then(lib=>{assert.equal(typeof lib.default,'function');assert(lib.proto);console.log('Baileys offline: OK')}).catch(err=>{console.error(err.stack);process.exitCode=1;});`;
const result=spawnSync(electron,['-e',code],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8',timeout:30000});
assert.equal(result.status,0,result.stderr||result.error?.message||result.stdout);
pass('Integração carregada pelo Electron a partir do ASAR, sem rede ou sessão');
process.stdout.write(JSON.stringify({archive,sha256:crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),checks:checks.length,whatsappReal:'não testado'},null,2)+'\n');
