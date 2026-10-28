'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const {createStore,seed}=require('../src/core/store.cjs');
const {MediaManager}=require('../src/core/media.cjs');

async function fixture(t,options={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-stream-')),stores=[];
  t.after(()=>{for(const store of stores)store.close();fs.rmSync(dir,{recursive:true,force:true});});
  async function open(name){const store=await createStore(path.join(dir,name));stores.push(store);seed(store);return{store,manager:new MediaManager(store,options)};}
  return{dir,...await open('source'),open};
}
async function fileBackup(f,t){
  const first=await f.manager.importBuffer(Buffer.from('%PDF-1.7\nPrimeiro arquivo\n😀'),{name:'primeiro.pdf'});
  const second=await f.manager.importBuffer(Buffer.from('Segundo arquivo, links e acentos: ação.'),{name:'segundo.txt'});
  const campaign=f.store.listCampaigns()[0];f.store.saveCampaign({...campaign,items:[{id:'first-item',type:'document',mediaId:first.id,caption:'Documento 1'},{id:'second-item',type:'document',mediaId:second.id,caption:'Documento 2'}]});
  const filename=path.join(f.dir,'campanhas.mega.json');await f.manager.createBackup(filename);
  return{first,second,filename,data:JSON.parse(fs.readFileSync(filename,'utf8'))};
}

test('file import copies and hashes asynchronously without reading the complete original',async t=>{
  const f=await fixture(t,{chunkSize:5}),filename=path.join(f.dir,'original.pdf'),bytes=Buffer.from('%PDF-1.7\nArquivo original que será movido.');fs.writeFileSync(filename,bytes);
  const read=fs.readFileSync;fs.readFileSync=(name,...args)=>{if(name===filename)throw new Error('Whole original read forbidden');return read(name,...args);};
  let media;try{media=await f.manager.importFile(filename);}finally{fs.readFileSync=read;}
  fs.renameSync(filename,path.join(f.dir,'movido.pdf'));
  assert.deepEqual(fs.readFileSync(f.manager.getPath(media.id)),bytes);
  assert.equal(media.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(media.size,bytes.length);
});

test('old-format backup and unknown-extension received media restore across tiny token/base64 boundaries',async t=>{
  const f=await fixture(t,{chunkSize:5}),backup=await fileBackup(f,t),target=await f.open('target');
  const m=backup.data.media[0];m.name='recebido.bin';
  // Older JSON writers may place base64 before all metadata. It remains a supported version 1 backup.
  backup.data.media[0]={base64:m.base64,...m};const legacy=path.join(f.dir,'legado.json');fs.writeFileSync(legacy,JSON.stringify(backup.data));
  const read=fs.readFileSync;fs.readFileSync=(name,...args)=>{if(name===legacy)throw new Error('Whole backup read forbidden');return read(name,...args);};
  try{const restored=await target.manager.restoreBackup(legacy);assert.equal(restored.media,2);}finally{fs.readFileSync=read;}
  assert.equal(target.store.getMedia(m.id).name,'recebido.bin.pdf');
  assert.deepEqual(fs.readFileSync(target.manager.getPath(m.id)),fs.readFileSync(f.manager.getPath(m.id)));
  assert.equal(target.store.listCampaigns()[0].state,'draft');
});

test('a late corrupt checksum cleans every staged file and preserves existing data/media',async t=>{
  const f=await fixture(t),backup=await fileBackup(f,t),target=await f.open('target');
  const old=await target.manager.importBuffer(Buffer.from('Biblioteca existente'),{name:'anterior.txt'});target.store.setSetting('marker','preservar');
  const before=fs.readdirSync(target.manager.dir);backup.data.media[1].sha256='0'.repeat(64);fs.writeFileSync(backup.filename,JSON.stringify(backup.data));
  await assert.rejects(target.manager.restoreBackup(backup.filename),/corrompido/);
  assert.deepEqual(fs.readdirSync(target.manager.dir),before);assert.equal(target.store.getSetting('marker'),'preservar');assert.equal(target.store.getMedia(old.id).name,'anterior.txt');
});

test('late invalid campaign configuration rolls back all restored media without replacing the database',async t=>{
  const f=await fixture(t),backup=await fileBackup(f,t),target=await f.open('target');
  target.store.setSetting('marker','preservar');backup.data.campaigns[0].schedule.days=[9];fs.writeFileSync(backup.filename,JSON.stringify(backup.data));
  await assert.rejects(target.manager.restoreBackup(backup.filename),/Backup inválido/);
  assert.deepEqual(fs.readdirSync(target.manager.dir),[]);assert.equal(target.store.getSetting('marker'),'preservar');
});

test('malformed base64, duplicate object keys and prototype keys fail safely before restore',async t=>{
  const f=await fixture(t),backup=await fileBackup(f,t),target=await f.open('target');
  for(const mutate of[
    data=>{data.media[0].base64='abc=';},
    data=>{data.media[0].base64='YQ==YQ==';},
    data=>{data.media[0].base64='YQ=$';}
  ]){
    const data=structuredClone(backup.data);mutate(data);fs.writeFileSync(backup.filename,JSON.stringify(data));
    await assert.rejects(target.manager.restoreBackup(backup.filename),/corrompido/);assert.deepEqual(fs.readdirSync(target.manager.dir),[]);
  }
  for(const text of['{"format":"mega-disparos","format":"evil"}','{"__proto__":{"polluted":true}}']){
    fs.writeFileSync(backup.filename,text);await assert.rejects(target.manager.restoreBackup(backup.filename),/Backup inválido/);
    assert.deepEqual(fs.readdirSync(target.manager.dir),[]);assert.equal({}.polluted,undefined);
  }
});

test('database rejection removes imported files instead of leaving unmanaged orphans',async t=>{
  const f=await fixture(t),filename=path.join(f.dir,'original.txt');fs.writeFileSync(filename,'Arquivo');
  const save=f.store.saveMedia;f.store.saveMedia=()=>{throw new Error('Storage rejected');};
  try{await assert.rejects(f.manager.importFile(filename),/Storage rejected/);assert.deepEqual(fs.readdirSync(f.manager.dir),[]);
    await assert.rejects(f.manager.importBuffer(Buffer.from('Arquivo'),{name:'received.txt'}),/Storage rejected/);assert.deepEqual(fs.readdirSync(f.manager.dir),[]);
  }finally{f.store.saveMedia=save;}
  assert.equal(fs.existsSync(filename),true);
});

test('backup stays compatible, excludes credentials and preserves an existing export if a source is corrupt',async t=>{
  const f=await fixture(t);f.store.setSetting('secretToken','do-not-export');
  const backup=await fileBackup(f,t);assert.equal(backup.data.version,1);assert.equal(JSON.stringify(backup.data).includes('do-not-export'),false);
  const original=fs.readFileSync(backup.filename);const file=f.manager.getPath(backup.first.id),bytes=fs.readFileSync(file);bytes[0]^=1;fs.writeFileSync(file,bytes);
  await assert.rejects(f.manager.createBackup(backup.filename),/corrompida/);
  assert.deepEqual(fs.readFileSync(backup.filename),original);assert.equal(fs.readdirSync(f.dir).some(name=>name.endsWith('.tmp')),false);
});

test('24 MiB import, backup and restore complete with a 48 MiB V8 heap ceiling',async t=>{
  const f=await fixture(t),filename=path.join(f.dir,'grande.pdf');let handle=fs.openSync(filename,'w');
  try{const block=Buffer.alloc(64*1024,65);for(let i=0;i<384;i++)fs.writeSync(handle,block);}finally{fs.closeSync(handle);}
  const script=`
    const fs=require('node:fs'),path=require('node:path');
    const {createStore}=require('./src/core/store.cjs');const {MediaManager}=require('./src/core/media.cjs');
    (async()=>{const root=process.argv[1],source=await createStore(path.join(root,'bounded-source')),target=await createStore(path.join(root,'bounded-target'));
      const sourceMedia=new MediaManager(source),targetMedia=new MediaManager(target);const media=await sourceMedia.importFile(path.join(root,'grande.pdf'));
      const filename=path.join(root,'grande.mega.json');await sourceMedia.createBackup(filename);await targetMedia.restoreBackup(filename);
      if(target.getMedia(media.id).sha256!==media.sha256||fs.statSync(targetMedia.getPath(media.id)).size!==24*1024*1024)throw new Error('Roundtrip failed');
      console.log(JSON.stringify({ok:true,heapMiB:Math.round(process.memoryUsage().heapUsed/1024/1024)}));source.close();target.close();
    })().catch(error=>{console.error(error.message);process.exitCode=1});`;
  const result=spawnSync(process.execPath,['--max-old-space-size=48','-e',script,f.dir],{cwd:path.join(__dirname,'..'),encoding:'utf8',timeout:60000});
  assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);const report=JSON.parse(result.stdout.trim());assert.equal(report.ok,true);assert.ok(report.heapMiB<=48);
});
