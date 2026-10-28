'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {createStore}=require('../src/core/store.cjs');
const {AuthService}=require('../src/core/auth.cjs');
const {MediaManager}=require('../src/core/media.cjs');
const {TemplateService}=require('../src/core/template-service.cjs');
const PASSWORD='Senha-Segura-Teste-2026';
async function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kenned-library-')),stores=[];
  t.after(()=>{for(const store of stores)store.close();fs.rmSync(dir,{recursive:true,force:true});});
  async function open(){const store=await createStore(dir);stores.push(store);const auth=new AuthService({store}),media=new MediaManager(store,{auth});return {store,auth,media,templates:new TemplateService({store,auth,media})};}
  const f=await open(),owner=(await f.auth.setupOwner({name:'Dono',username:'dono',phone:'5511999990001',password:PASSWORD})).user;
  return {...f,dir,owner,open};
}
function campaign(f,items,extra={}){return f.store.saveCampaign({id:randomUUID(),name:'Envio salvo',state:'draft',mode:'repeat',groupIds:[],items,groupOverrides:{},schedule:{days:[1],startTime:'08:00',endTime:'18:00'},intervalMinutes:10,spacingSeconds:3,ownerId:f.owner.id,...extra});}
const item=m=>({id:randomUUID(),type:m.type,mediaId:m.id,caption:'*Oferta*\nDocumento de referência 😀'});

test('named templates preserve text formatting, media captions, edits, copies and campaign use after database reopen',async t=>{
  const f=await fixture(t),m=await f.media.importBuffer(Buffer.from('Arquivo original'),{name:'oferta.pdf'}),text='*iPhone 15 Pro Max* 😀\n_Lacrado_\nhttps://loja.exemplo/oferta';
  let model=f.templates.save({name:'Ofertas da loja',items:[{type:'text',text},item(m)]},f.owner.id);
  assert.equal(model.items[0].text,text);assert.equal(model.items[1].caption,'*Oferta*\nDocumento de referência 😀');
  model=f.templates.save({...model,name:'Ofertas editadas',expectedUpdatedAt:model.updatedAt},f.owner.id);assert.equal(f.store.listTemplates().length,1);
  const copy=f.templates.duplicate(model.id,f.owner.id);assert.notEqual(copy.id,model.id);assert.notEqual(copy.items[0].id,model.items[0].id);assert.equal(copy.items[0].text,text);
  const applied=f.templates.apply(model.id,f.owner.id),c=campaign(f,applied.items);assert.notEqual(c.items[0].id,model.items[0].id);assert.equal(c.state,'draft');
  f.store.close();const reopened=await f.open();await reopened.auth.login({username:'dono',password:PASSWORD});
  assert.equal(reopened.templates.get(model.id,f.owner.id).name,'Ofertas editadas');assert.equal(reopened.store.listTemplates().length,2);assert.ok(fs.existsSync(reopened.media.getPath(m.id)));
  reopened.templates.delete(model.id,f.owner.id);assert.equal(reopened.store.getTemplate(model.id),undefined);assert.equal(reopened.store.getCampaign(c.id).items[0].text,text);assert.equal(reopened.store.getTemplate(copy.id).items[0].text,text);
});

test('templates reject empty content, absent managed files, conflicting edits and unsuccessful persistence',async t=>{
  const f=await fixture(t);assert.throws(()=>f.templates.save({name:'Vazio',items:[]},f.owner.id),/ao menos/);
  const m=await f.media.importBuffer(Buffer.from('Arquivo'),{name:'arquivo.txt'});fs.unlinkSync(m.path);assert.throws(()=>f.templates.save({name:'Ausente',items:[item(m)]},f.owner.id),/ausente/);
  const model=f.templates.save({name:'Original',items:[{type:'text',text:'Texto original'}]},f.owner.id);
  assert.throws(()=>f.templates.save({...model,expectedUpdatedAt:model.updatedAt-1},f.owner.id),e=>e.code==='TEMPLATE_STALE');
  const save=f.store.saveTemplate;f.store.saveTemplate=()=>({id:'not-persisted'});
  try{assert.throws(()=>f.templates.save({name:'Não gravado',items:[{type:'text',text:'Sem gravação'}]},f.owner.id),e=>e.code==='TEMPLATE_PERSIST_FAILED');}finally{f.store.saveTemplate=save;}
  assert.equal(f.store.listTemplates().length,1);assert.equal(f.store.getTemplate(model.id).name,'Original');
});

test('backend template permissions distinguish create, edit, delete and viewing; mode isolation prevents crossing media',async t=>{
  const f=await fixture(t),m=await f.media.importBuffer(Buffer.from('Documento real'),{name:'real.txt'}),model=f.templates.save({name:'Modelo real',items:[item(m)]},f.owner.id);
  const seller=await f.auth.createUser({name:'Vendedor',username:'vendedor',password:PASSWORD,roleId:'role-seller',requirePasswordChange:false});
  assert.throws(()=>f.templates.save({...model,name:'Sem edição'},seller.id),/permissão/);assert.throws(()=>f.templates.delete(model.id,seller.id),/permissão/);
  const allowed=f.templates.save({name:'Modelo do vendedor',items:[{type:'text',text:'Mensagem'}]},seller.id);assert.ok(allowed.id);
  await f.auth.updateUser({...seller,id:seller.id,permissionOverrides:{'media.view':false}});
  assert.throws(()=>f.templates.list(seller.id),/permissão/);assert.throws(()=>f.templates.apply(model.id,seller.id),/permissão/);
  f.store.setSetting('integrationMode','simulated');assert.equal(f.templates.list(f.owner.id).length,0);assert.throws(()=>f.templates.save({...model,name:'Outra integração'},f.owner.id),/não existe/);assert.throws(()=>f.templates.save({name:'Não mistura',items:[item(m)]},f.owner.id),/Mídia não encontrada/);
  f.store.setSetting('integrationMode','whatsapp');assert.equal(f.templates.get(model.id,f.owner.id).name,'Modelo real');
});

test('bulk deletion removes only managed copies, persists removal and records an independent audit',async t=>{
  const f=await fixture(t),source=path.join(f.dir,'original.pdf');fs.writeFileSync(source,'Documento original');const first=await f.media.importFile(source),second=await f.media.importBuffer(Buffer.from('Outro'),{name:'outro.txt'});
  assert.equal(f.media.inspectDeletion([first.id,second.id],f.owner.id).canDelete,true);
  await assert.rejects(f.media.deleteFiles([first.id],{confirmation:'excluir',userId:f.owner.id}),/EXCLUIR/);
  const result=await f.media.deleteFiles([first.id,second.id],{confirmation:'EXCLUIR',userId:f.owner.id});assert.equal(result.count,2);assert.equal(result.cleanupPending,0);assert.equal(fs.existsSync(first.path),false);assert.equal(fs.existsSync(second.path),false);assert.equal(fs.existsSync(source),true);assert.equal(f.store.listMedia().length,0);assert.ok(f.store.listEntities('audit').some(a=>a.action==='media.delete'&&a.count===2));
  f.store.close();const reopened=await f.open();assert.equal(reopened.store.listMedia().length,0);
});

test('media deletion is blocked by models, paused campaigns, per-group content and orphan uncertain operational snapshots',async t=>{
  const f=await fixture(t),m=await f.media.importBuffer(Buffer.from('Arquivo em uso'),{name:'usado.pdf'}),it=item(m);
  const model=f.templates.save({name:'Modelo vinculado',items:[it]},f.owner.id),c=campaign(f,[it],{state:'paused',groupOverrides:{'g1':{enabled:true,items:[it]}}});
  const roundId=randomUUID();f.store.insertRound({id:roundId,campaignId:c.id,startedAt:Date.now(),status:'uncertain'});f.store.insertJob({id:randomUUID(),campaignId:c.id,roundId,groupId:'g1',itemId:it.id,itemSnapshot:it,status:'uncertain',createdAt:Date.now(),attempts:1});
  let preview=f.media.inspectDeletion([m.id],f.owner.id);assert.deepEqual(new Set(preview.items[0].references.map(r=>r.kind)),new Set(['template','campaign','groupOverride','operational']));
  await assert.rejects(f.media.deleteFiles([m.id],{confirmation:'EXCLUIR',userId:f.owner.id}),e=>e.code==='MEDIA_IN_USE');assert.ok(fs.existsSync(m.path));
  f.templates.delete(model.id,f.owner.id);f.store.deleteCampaign(c.id);preview=f.media.inspectDeletion([m.id],f.owner.id);assert.equal(preview.canDelete,false);assert.equal(preview.items[0].references[0].kind,'operational');assert.ok(fs.existsSync(m.path));
});

test('bulk deletion is all-or-nothing when one selected file is linked and database failure restores all staged files',async t=>{
  const f=await fixture(t),first=await f.media.importBuffer(Buffer.from('Primeiro'),{name:'a.txt'}),second=await f.media.importBuffer(Buffer.from('Segundo'),{name:'b.txt'}),model=f.templates.save({name:'Protegido',items:[item(second)]},f.owner.id);
  await assert.rejects(f.media.deleteFiles([first.id,second.id],{confirmation:'EXCLUIR',userId:f.owner.id}),/em uso/);assert.ok(fs.existsSync(first.path));assert.ok(fs.existsSync(second.path));
  f.templates.delete(model.id,f.owner.id);const del=f.store.deleteMedia;let count=0;f.store.deleteMedia=id=>{count++;if(count===2)throw new Error('Falha persistente de teste');return del(id);};
  try{await assert.rejects(f.media.deleteFiles([first.id,second.id],{confirmation:'EXCLUIR',userId:f.owner.id}),/Falha persistente/);}finally{f.store.deleteMedia=del;}
  assert.ok(f.store.getMedia(first.id));assert.ok(f.store.getMedia(second.id));assert.equal(fs.readFileSync(first.path,'utf8'),'Primeiro');assert.equal(fs.readFileSync(second.path,'utf8'),'Segundo');assert.equal(fs.readdirSync(f.media.dir).some(n=>n.startsWith('.delete')),false);
});

test('deletion revalidates references and permissions after asynchronous staging; symlinks cannot delete external files',async t=>{
  const f=await fixture(t),m=await f.media.importBuffer(Buffer.from('Seguro'),{name:'seguro.txt'});const rename=fs.promises.rename;let inserted=false;
  fs.promises.rename=async(a,b)=>{const value=await rename(a,b);if(!inserted&&path.basename(b).startsWith('.deleting-')){inserted=true;f.store.saveTemplate({id:randomUUID(),name:'Novo vínculo',items:[item(m)],createdAt:Date.now()});}return value;};
  try{await assert.rejects(f.media.deleteFiles([m.id],{confirmation:'EXCLUIR',userId:f.owner.id}),e=>e.code==='MEDIA_IN_USE');}finally{fs.promises.rename=rename;}
  assert.equal(fs.readFileSync(m.path,'utf8'),'Seguro');
  const outside=path.join(f.dir,'fora.txt');fs.writeFileSync(outside,'Não remover');const link=path.join(f.media.dir,`${randomUUID()}.txt`);fs.symlinkSync(outside,link);const id=randomUUID();f.store.saveMedia({id,name:'Link',path:link,type:'document',mime:'text/plain',size:11});
  await assert.rejects(f.media.deleteFiles([id],{confirmation:'EXCLUIR',userId:f.owner.id}),/ausente ou inválida/);assert.equal(fs.readFileSync(outside,'utf8'),'Não remover');
});

test('crash recovery restores staged media whose database entry remains and cleans committed tombstones across integration modes',async t=>{
  const f=await fixture(t),first=await f.media.importBuffer(Buffer.from('Recuperar'),{name:'primeiro.txt'}),second=await f.media.importBuffer(Buffer.from('Excluir'),{name:'segundo.pdf'});
  const tx=randomUUID(),entries=[first,second].map(m=>({id:m.id,original:path.basename(m.path),staged:`.deleting-${tx}-${path.basename(m.path)}`}));
  for(const entry of entries)fs.renameSync(path.join(f.media.dir,entry.original),path.join(f.media.dir,entry.staged));
  f.store.deleteMedia(second.id);f.media._writeDeletionJournal(path.join(f.media.dir,`.delete-${tx}.json`),{version:1,mode:'whatsapp',items:entries});f.store.setSetting('integrationMode','simulated');
  new MediaManager(f.store,{auth:f.auth});assert.equal(fs.readFileSync(first.path,'utf8'),'Recuperar');assert.equal(fs.existsSync(second.path),false);assert.equal(fs.existsSync(path.join(f.media.dir,entries[1].staged)),false);assert.equal(fs.readdirSync(f.media.dir).some(n=>n.startsWith('.delete')),false);assert.equal(f.store.getSetting('integrationMode'),'simulated');
});

test('deletion permissions are enforced in the backend and inactive accounts cannot inspect or remove files',async t=>{
  const f=await fixture(t),m=await f.media.importBuffer(Buffer.from('Restrito'),{name:'arquivo.txt'}),seller=await f.auth.createUser({name:'Restrito',username:'restrito',password:PASSWORD,roleId:'role-seller',requirePasswordChange:false});
  assert.throws(()=>f.media.inspectDeletion([m.id],seller.id),/permissão/);await assert.rejects(f.media.deleteFiles([m.id],{confirmation:'EXCLUIR',userId:seller.id}),/permissão/);assert.ok(f.store.getMedia(m.id));
  await f.auth.updateUser({id:seller.id,permissionOverrides:{'media.delete':true},active:false});assert.throws(()=>f.media.inspectDeletion([m.id],seller.id),/permissão/);
});

test('a Windows-style file lock after metadata commit is reported honestly and its quarantined file is removed at restart',async t=>{
  const f=await fixture(t),m=await f.media.importBuffer(Buffer.from('Arquivo bloqueado'),{name:'bloqueado.txt'}),unlink=fs.promises.unlink;let blocked=false;
  fs.promises.unlink=async filename=>{if(!blocked&&path.basename(filename).startsWith('.deleting-')){blocked=true;throw Object.assign(new Error('Arquivo em uso pelo Windows'),{code:'EPERM'});}return unlink(filename);};
  let result;try{result=await f.media.deleteFiles([m.id],{confirmation:'EXCLUIR',userId:f.owner.id});}finally{fs.promises.unlink=unlink;}
  assert.equal(result.deleted,true);assert.equal(result.cleanupPending,1);assert.match(result.warning,/quarentena/);assert.equal(f.store.getMedia(m.id),undefined);assert.equal(fs.readdirSync(f.media.dir).filter(n=>n.startsWith('.deleting-')).length,1);
  new MediaManager(f.store,{auth:f.auth});assert.equal(fs.readdirSync(f.media.dir).length,0);
});

test('access revoked while files are staged cancels deletion and restores the managed file',async t=>{
  const f=await fixture(t),m=await f.media.importBuffer(Buffer.from('Preservar'),{name:'preservar.pdf'}),admin=await f.auth.createUser({name:'Administrador',username:'admin',password:PASSWORD,roleId:'role-admin',requirePasswordChange:false});
  const rename=fs.promises.rename;let revoked=false;
  fs.promises.rename=async(a,b)=>{const result=await rename(a,b);if(!revoked&&path.basename(b).startsWith('.deleting-')){revoked=true;const user=f.store.getEntity('users',admin.id);f.store.saveEntity('users',{...user,active:false});}return result;};
  try{await assert.rejects(f.media.deleteFiles([m.id],{confirmation:'EXCLUIR',userId:admin.id}),/permissão/);}finally{fs.promises.rename=rename;}
  assert.ok(f.store.getMedia(m.id));assert.equal(fs.readFileSync(m.path,'utf8'),'Preservar');assert.equal(fs.readdirSync(f.media.dir).some(n=>n.startsWith('.delete')),false);
});
