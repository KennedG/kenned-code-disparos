const fs = require('node:fs');
const path = require('node:path');
const {randomUUID,createHash} = require('node:crypto');
const {parser} = require('stream-json');
const Assembler = require('stream-json/Assembler');
const MAX_FILE = 64 * 1024 * 1024;
const MAX_BACKUP_MEDIA = 512 * 1024 * 1024;
const MAX_BACKUP_JSON = 720 * 1024 * 1024;
const MAX_METADATA = 64 * 1024 * 1024;
const CHUNK = 64 * 1024;
const types = {'.jpg':['image/jpeg','image'],'.jpeg':['image/jpeg','image'],'.png':['image/png','image'],'.webp':['image/webp','image'],'.mp4':['video/mp4','video'],'.mov':['video/quicktime','video'],'.pdf':['application/pdf','document'],'.doc':['application/msword','document'],'.docx':['application/vnd.openxmlformats-officedocument.wordprocessingml.document','document'],'.xls':['application/vnd.ms-excel','document'],'.xlsx':['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','document'],'.pptx':['application/vnd.openxmlformats-officedocument.presentationml.presentation','document'],'.txt':['text/plain','document'],'.csv':['text/csv','document'],'.zip':['application/zip','document']};

async function writeAll(handle, input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  let offset = 0;
  while (offset < bytes.length) {
    const {bytesWritten} = await handle.write(bytes, offset, bytes.length - offset, null);
    if (!bytesWritten) throw new Error('Não foi possível gravar o arquivo.');
    offset += bytesWritten;
  }
}
async function syncDirectory(dir) {
  let handle;
  try { handle = await fs.promises.open(dir, 'r'); await handle.sync(); } catch { /* Directory fsync is unavailable on Windows. */ }
  finally { await handle?.close(); }
}
function format(name, mime) {
  let ext = path.extname(name).toLowerCase();
  if (!types[ext]) ext = Object.entries(types).find(([, value]) => value[0] === mime)?.[0];
  if (!types[ext]) throw new Error('Formato não suportado. Use imagens JPG/PNG/WebP, vídeos MP4/MOV ou documentos PDF/Office/TXT/CSV/ZIP.');
  return {ext, mime: types[ext][0], type: types[ext][1], name: path.extname(name).toLowerCase() === ext ? name : `${name}${ext}`};
}
class MediaManager {
  constructor(store, options = {}) { this.store = store; this.auth=options.auth; this.now=options.now||(()=>Date.now()); this.dir = path.join(store.dir,'media'); this.chunkSize=options.chunkSize || CHUNK; this._deletionTail=Promise.resolve(); fs.mkdirSync(this.dir,{recursive:true});this.recoverDeletions(); }
  _deletionAssert(userId,permission) {
    if(!this.auth)throw Object.assign(new Error('A validação de acesso à biblioteca está indisponível.'),{code:'AUTH_REQUIRED'});
    return this.auth.assertFor(userId??this.auth.currentUserId,permission);
  }
  _deletionIds(ids) {
    if(!Array.isArray(ids)||!ids.length||ids.length>10000||ids.some(id=>typeof id!=='string'||!id||id.length>512))throw new Error('Selecione de 1 a 10.000 mídias válidas.');
    return [...new Set(ids)];
  }
  _references(ids,userId) {
    const selected=new Set(ids),references=new Map(ids.map(id=>[id,[]]));
    const add=(items,ref)=>{for(const item of items||[])if(selected.has(item.mediaId)){const list=references.get(item.mediaId);if(!list.some(r=>r.kind===ref.kind&&r.id===ref.id&&r.groupId===ref.groupId))list.push(ref);}};
    for(const campaign of this.store.listCampaigns()){
      const visible=this.auth?.canFor(userId??this.auth.currentUserId,'campaign.view',campaign);
      const ref=visible?{kind:'campaign',id:campaign.id,label:campaign.name,state:campaign.state}:{kind:'campaign',label:'Campanha sem permissão de visualização',restricted:true};
      add(campaign.items,ref);
      for(const [groupId,override]of Object.entries(campaign.groupOverrides||{}))add(override.items,{...ref,kind:'groupOverride',...(visible?{groupId}:{}),label:visible?`${campaign.name} — conteúdo específico por grupo`:ref.label});
    }
    for(const template of this.store.listTemplates())add(template.items,{kind:'template',id:template.id,label:template.name});
    for(const job of this.store.listJobs({status:['queued','pending','sending','accepted','uncertain']})){
      const campaign=this.store.getCampaign(job.campaignId),visible=campaign&&this.auth?.canFor(userId??this.auth.currentUserId,'campaign.view',campaign);
      add([job.itemSnapshot,job.contentSnapshot,{mediaId:job.mediaId}].filter(Boolean),{kind:'operational',...(visible?{id:job.id,campaignId:job.campaignId}:{}),label:visible?`${campaign.name} — envio ${job.status==='uncertain'?'incerto, aguardando revisão':'na fila ou em andamento'}`:'Envio operacional protegido',state:job.status});
    }
    for(const inventory of this.store.listEntities?.('inventory')||[]){const visible=this.auth?.canFor(userId??this.auth.currentUserId,'stock.view');add((inventory.mediaIds||[]).map(mediaId=>({mediaId})),{kind:'inventory',...(visible?{id:inventory.id}:{}),label:visible?`Estoque — ${inventory.model||inventory.name}`:'Foto de estoque protegido'});}
    const media=this.store.listMediaAnyMode?.()||this.store.listMedia();
    for(const id of ids){const item=this.store.getMedia(id);if(!item?.path)continue;for(const other of media)if(other.id!==id&&!selected.has(other.id)&&path.resolve(other.path||'')===path.resolve(item.path))references.get(id).push({kind:'sharedFile',label:'Arquivo gerenciado compartilhado com outro registro da biblioteca'});}
    return references;
  }
  inspectDeletion(ids,userId) {
    this._deletionAssert(userId,'media.delete');this._deletionAssert(userId,'media.view');
    ids=this._deletionIds(ids);const references=this._references(ids,userId);
    const items=ids.map(id=>{const item=this.store.getMedia(id);if(!item)throw new Error('Uma mídia não existe neste modo. Atualize a biblioteca.');return {id,name:item.name,type:item.type,size:item.size,references:references.get(id),blocked:references.get(id).length>0};});
    return {items,total:items.length,blocked:items.filter(item=>item.blocked).length,canDelete:items.every(item=>!item.blocked),description:'Excluir remove o cadastro e o arquivo gerenciado. O arquivo original importado não é alterado. Arquivos em uso são preservados.'};
  }
  _writeDeletionJournal(filename,value) {
    const {atomicWrite}=require('./store.cjs');atomicWrite(filename,Buffer.from(JSON.stringify(value)));
  }
  recoverDeletions() {
    for(const name of fs.readdirSync(this.dir).filter(name=>/^\.delete-[a-f0-9-]{36}\.json$/i.test(name))){
      const journal=path.join(this.dir,name);let data;
      try{
        if(fs.lstatSync(journal).isSymbolicLink()||fs.statSync(journal).size>2*1024*1024)continue;
        data=JSON.parse(fs.readFileSync(journal,'utf8'));
        if(data.version!==1||!['whatsapp','simulated'].includes(data.mode)||!Array.isArray(data.items)||data.items.length>10000)continue;
        if(!this.store.getMediaAnyMode&&data.mode!==this.store.getStorageMode?.())continue;
        let complete=true;
        for(const item of data.items){
          const transactionId=name.slice(8,-5);
          if(typeof item.id!=='string'||!item.original||! /^[a-f0-9-]{36}\.[a-z0-9]+$/i.test(item.original)||path.basename(item.original)!==item.original||!types[path.extname(item.original).toLowerCase()]||item.staged!==`.deleting-${transactionId}-${item.original}`||path.basename(item.staged)!==item.staged){complete=false;continue;}
          const original=path.join(this.dir,item.original),staged=path.join(this.dir,item.staged);
          const media=this.store.getMediaAnyMode?.(item.id)||this.store.getMedia(item.id);
          if(media&&path.resolve(media.path||'')!==original){complete=false;continue;}
          if(!fs.existsSync(staged))continue;
          if(fs.lstatSync(staged).isSymbolicLink()){complete=false;continue;}
          if(media){if(fs.existsSync(original)){complete=false;continue;}fs.renameSync(staged,original);}
          else fs.unlinkSync(staged);
        }
        if(complete)fs.unlinkSync(journal);
      }catch{/* Leave a journal and its files for the next safe recovery attempt. */}
    }
  }
  deleteFiles(ids,options={}) {
    const task=()=>this._deleteFiles(ids,options),result=this._deletionTail.then(task);
    this._deletionTail=result.catch(()=>{});return result;
  }
  async _deleteFiles(ids,{confirmation,userId}={}) {
    if(confirmation!=='EXCLUIR')throw new Error('Digite EXCLUIR para confirmar a exclusão das mídias.');
    const user=this._deletionAssert(userId,'media.delete'),preview=this.inspectDeletion(ids,userId);
    if(!preview.canDelete)throw Object.assign(new Error('Há arquivos em uso. Remova as referências indicadas ou revise os envios incertos antes de excluir.'),{code:'MEDIA_IN_USE',details:preview});
    if(typeof this.store.deleteMedia!=='function')throw new Error('A exclusão persistente da biblioteca está indisponível.');
    const mode=this.store.getStorageMode?.()||'whatsapp',transactionId=randomUUID(),journal=path.join(this.dir,`.delete-${transactionId}.json`),entries=[];
    for(const item of preview.items){const media=this.store.getMedia(item.id);let original;
      try{if(fs.lstatSync(media.path).isSymbolicLink())throw new Error('Mídia gerenciada ausente ou inválida.');}catch(error){if(error.code!=='ENOENT')throw error;}
      try{original=this.getPath(item.id);}catch(error){if(media?.path&&!fs.existsSync(media.path)&&path.resolve(media.path).startsWith(path.resolve(this.dir)+path.sep))original=path.resolve(media.path);else throw error;}
      if(path.dirname(original)!==fs.realpathSync(this.dir))throw new Error('O arquivo não pertence à pasta gerenciada da biblioteca.');
      entries.push({id:item.id,original:path.basename(original),staged:`.deleting-${transactionId}-${path.basename(original)}`,missing:!fs.existsSync(original)});
    }
    this._writeDeletionJournal(journal,{version:1,mode,items:entries,at:this.now()});let committed=false;
    try{
      for(const entry of entries)if(!entry.missing){await fs.promises.rename(path.join(this.dir,entry.original),path.join(this.dir,entry.staged));if(mode!==this.store.getStorageMode?.())throw new Error('O modo de operação mudou. Atualize a biblioteca.');}
      this.store.transaction(()=>{
        this._deletionAssert(userId,'media.delete');this._deletionAssert(userId,'media.view');
        if(mode!==this.store.getStorageMode?.())throw new Error('O modo de operação mudou. Atualize a biblioteca.');
        const latest=this.inspectDeletion(preview.items.map(item=>item.id),userId);if(!latest.canDelete)throw Object.assign(new Error('Uma mídia passou a ser usada. Nenhum arquivo foi excluído.'),{code:'MEDIA_IN_USE',details:latest});
        for(const entry of entries){this.store.deleteMedia(entry.id);if(this.store.getMedia(entry.id))throw new Error('Não foi possível excluir uma mídia do banco.');}
        this.store.addAudit({id:randomUUID(),at:this.now(),userId:user.id,userName:user.name,action:'media.delete',mediaIds:entries.map(entry=>entry.id),count:entries.length});
      });committed=true;
      let cleanupPending=0;for(const entry of entries)if(!entry.missing)try{await fs.promises.unlink(path.join(this.dir,entry.staged));}catch(error){if(error.code!=='ENOENT')cleanupPending++;}
      if(!cleanupPending)try{await fs.promises.unlink(journal);}catch(error){if(error.code!=='ENOENT')cleanupPending++;}await syncDirectory(this.dir);
      return {deleted:true,ids:entries.map(entry=>entry.id),count:entries.length,cleanupPending,...(cleanupPending?{warning:'Cadastros removidos. Alguns arquivos em quarentena serão removidos na próxima abertura; confira as permissões do Windows.'}:{})};
    }catch(error){
      if(!committed){let restored=true;for(const entry of entries){const staged=path.join(this.dir,entry.staged),original=path.join(this.dir,entry.original);if(fs.existsSync(staged))try{await fs.promises.rename(staged,original);}catch{restored=false;}}if(restored)await fs.promises.unlink(journal).catch(()=>{});}
      throw error;
    }
  }
  async importFile(filename) {
    const stat = await fs.promises.stat(filename);
    if (!stat.isFile() || !stat.size || stat.size > MAX_FILE) throw new Error('Selecione um arquivo de 1 byte a 64 MB.');
    const info = format(path.basename(filename).replace(/[\x00-\x1f]/g,'').slice(0,180));
    const id = randomUUID(), target = path.join(this.dir, `${id}${info.ext}`), temp = `${target}.${randomUUID()}.tmp`;
    let handle, size=0; const hash=createHash('sha256');
    try {
      handle=await fs.promises.open(temp,'wx',0o600);
      for await (const bytes of fs.createReadStream(filename,{highWaterMark:this.chunkSize})) {
        size+=bytes.length; if(size>MAX_FILE)throw new Error('Selecione um arquivo de até 64 MB.');
        hash.update(bytes); await writeAll(handle,bytes);
      }
      if(!size)throw new Error('O arquivo está vazio.');
      await handle.sync(); await handle.close(); handle=null;
      await fs.promises.rename(temp,target); await syncDirectory(this.dir);
      return this.store.saveMedia({id,name:info.name,mime:info.mime,type:info.type,path:target,size,sha256:hash.digest('hex'),createdAt:Date.now()});
    } catch(error) {await handle?.close().catch(()=>{});await fs.promises.unlink(temp).catch(()=>{});await fs.promises.unlink(target).catch(()=>{});throw error;}
  }
  async importBuffer(buffer, metadata = {}) {
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    if (!buffer.length || buffer.length > MAX_FILE) throw new Error('Arquivos devem ter entre 1 byte e 64 MB.');
    const name = path.basename(String(metadata.name || 'arquivo')).replace(/[\x00-\x1f]/g,'').slice(0,180);
    const info=format(name,metadata.mime),id=randomUUID(),target=path.join(this.dir,`${id}${info.ext}`),temp=`${target}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle=await fs.promises.open(temp,'wx',0o600);await writeAll(handle,buffer);await handle.sync();await handle.close();handle=null;
      await fs.promises.rename(temp,target);await syncDirectory(this.dir);
      return this.store.saveMedia({id,name:info.name,mime:info.mime,type:info.type,path:target,size:buffer.length,sha256:createHash('sha256').update(buffer).digest('hex'),createdAt:Date.now()});
    } catch(error) {await handle?.close().catch(()=>{});await fs.promises.unlink(temp).catch(()=>{});await fs.promises.unlink(target).catch(()=>{});throw error;}
  }
  getPath(id) {
    const m = this.store.getMedia(id); if (!m || !m.path) throw new Error('Mídia não encontrada.');
    if (!fs.existsSync(m.path)) throw new Error('Mídia gerenciada ausente ou inválida.');
    const file = fs.realpathSync(m.path); if (!file.startsWith(fs.realpathSync(this.dir)+path.sep)) throw new Error('Mídia gerenciada ausente ou inválida.');
    return file;
  }
  async createBackup(destination) {
    const data=this.store.exportData(),temp=`${destination}.${randomUUID()}.tmp`;let handle,total=0,metadataSize=0;
    await fs.promises.mkdir(path.dirname(destination),{recursive:true});
    try {
      handle=await fs.promises.open(temp,'wx',0o600);await writeAll(handle,'{');let first=true;
      for(const [key,value]of Object.entries(data))if(key!=='media'){
        const encoded=JSON.stringify(value);metadataSize+=Buffer.byteLength(encoded);
        if(metadataSize>MAX_METADATA)throw new Error('Configurações do backup excedem 64 MB.');
        await writeAll(handle,`${first?'':','}${JSON.stringify(key)}:${encoded}`);first=false;
      }
      await writeAll(handle,`${first?'':','}"media":[`);
      for(let i=0;i<data.media.length;i++){
        const media=data.media[i],source=this.getPath(media.id),stat=await fs.promises.stat(source);
        if(!stat.isFile()||!stat.size||stat.size>MAX_FILE)throw new Error('Mídia gerenciada ausente ou inválida.');
        total+=stat.size;if(total>MAX_BACKUP_MEDIA)throw new Error('Backup maior que 512 MB: reduza a biblioteca antes de exportar.');
        const {path:ignored,...metadata}=media;const encoded=JSON.stringify(metadata);metadataSize+=Buffer.byteLength(encoded);
        if(metadataSize>MAX_METADATA)throw new Error('Configurações do backup excedem 64 MB.');
        await writeAll(handle,`${i?',':''}${encoded.slice(0,-1)},"base64":"`);
        const hash=createHash('sha256');let carry=Buffer.alloc(0),size=0;
        for await(const chunk of fs.createReadStream(source,{highWaterMark:this.chunkSize})){
          size+=chunk.length;if(size>stat.size||size>MAX_FILE)throw new Error('A mídia foi alterada durante o backup.');
          hash.update(chunk);const bytes=carry.length?Buffer.concat([carry,chunk]):chunk;const complete=bytes.length-bytes.length%3;
          if(complete)await writeAll(handle,bytes.subarray(0,complete).toString('base64'));
          carry=Buffer.from(bytes.subarray(complete));
        }
        if(size!==stat.size||size!==media.size||hash.digest('hex')!==String(media.sha256).toLowerCase())throw new Error('Mídia gerenciada corrompida.');
        if(carry.length)await writeAll(handle,carry.toString('base64'));
        await writeAll(handle,'"}');
      }
      await writeAll(handle,']}');if((await handle.stat()).size>MAX_BACKUP_JSON)throw new Error('Backup muito grande.');await handle.sync();await handle.close();handle=null;
      await fs.promises.rename(temp,destination);await syncDirectory(path.dirname(destination));return destination;
    } catch(error) {await handle?.close().catch(()=>{});await fs.promises.unlink(temp).catch(()=>{});throw error;}
  }
  async restoreBackup(filename) {
    const stat=await fs.promises.stat(filename);if(!stat.isFile()||stat.size>MAX_BACKUP_JSON)throw new Error('Backup muito grande ou inválido.');
    const created=new Set(),ids=new Set(),files=new WeakMap(),assembler=new Assembler();let decoder=null,metadataSize=0,nodes=0,string=null,key=null,number=null;
    const containers=[];let total=0;
    const input=fs.createReadStream(filename,{highWaterMark:this.chunkSize});
    const tokens=parser({packKeys:false,streamKeys:true,packStrings:false,streamStrings:true,packNumbers:false,streamNumbers:true});
    input.on('error',error=>tokens.destroy(error));tokens.on('error',()=>input.destroy());input.pipe(tokens);
    const metadata=(value)=>{metadataSize+=Buffer.byteLength(value);if(metadataSize>MAX_METADATA)throw new Error('Configurações do backup excedem 64 MB.');};
    const decoded=async(bytes)=>{
      decoder.size+=bytes.length;total+=bytes.length;if(decoder.size>MAX_FILE||total>MAX_BACKUP_MEDIA)throw new Error('Mídias do backup excedem os limites de 64 MB por arquivo ou 512 MB no total.');
      decoder.hash.update(bytes);let offset=0;
      while(offset<bytes.length){const take=Math.min(bytes.length-offset,decoder.pending.length-decoder.pendingSize);bytes.copy(decoder.pending,decoder.pendingSize,offset,offset+take);decoder.pendingSize+=take;offset+=take;
        if(decoder.pendingSize===decoder.pending.length){await writeAll(decoder.handle,decoder.pending);decoder.pendingSize=0;}
      }
    };
    const decode=async(value)=>{
      if(!/^[A-Za-z0-9+/=]*$/.test(value))throw new Error('Arquivo de backup corrompido.');
      const joined=decoder.carry+value,count=Math.max(0,Math.floor(joined.length/4)-1)*4,complete=joined.slice(0,count);
      if(complete.includes('='))throw new Error('Arquivo de backup corrompido.');
      if(complete)await decoded(Buffer.from(complete,'base64'));
      decoder.carry=joined.slice(count);
    };
    try {
      for await(const token of tokens){
        if((token.name!=='stringChunk'||!decoder)&&++nodes>2000000)throw new Error('Backup inválido: muitos elementos.');
        switch(token.name){
          case 'startKey':key='';break;
          case 'keyChunk':metadata(token.value);key+=token.value;if(key.length>2048)throw new Error('Chave inválida no backup.');break;
          case 'endKey': {
            if(['__proto__','prototype','constructor'].includes(key))throw new Error('Backup inválido: chave proibida.');
            const keys=containers.at(-1);if(!keys||keys.has(key))throw new Error('Backup inválido: chave duplicada.');keys.add(key);assembler.consume({name:'keyValue',value:key});key=null;break;
          }
          case 'startString': {
            const location=assembler.path;
            if(location.length===2&&location[0]==='media'&&assembler.key==='base64'&&!Array.isArray(assembler.current)){
              if(files.has(assembler.current))throw new Error('Mídia inválida no backup.');
              const temp=path.join(this.dir,`${randomUUID()}.restore.tmp`);created.add(temp);
              decoder={handle:await fs.promises.open(temp,'wx',0o600),path:temp,object:assembler.current,carry:'',hash:createHash('sha256'),size:0,pending:Buffer.alloc(CHUNK),pendingSize:0};
            }else string='';break;
          }
          case 'stringChunk':
            if(key!==null){metadata(token.value);key+=token.value;if(key.length>2048)throw new Error('Chave inválida no backup.');}
            else if(decoder)await decode(token.value);
            else{metadata(token.value);string+=token.value;if(string.length>65536)throw new Error('Texto inválido no backup.');}break;
          case 'endString':
            if(decoder){
              if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(decoder.carry))throw new Error('Arquivo de backup corrompido.');
              const last=Buffer.from(decoder.carry,'base64');if(last.toString('base64')!==decoder.carry)throw new Error('Arquivo de backup corrompido.');
              await decoded(last);if(!decoder.size)throw new Error('Mídia inválida no backup.');
              if(decoder.pendingSize)await writeAll(decoder.handle,decoder.pending.subarray(0,decoder.pendingSize));await decoder.handle.sync();await decoder.handle.close();decoder.handle=null;
              files.set(decoder.object,{path:decoder.path,size:decoder.size,sha256:decoder.hash.digest('hex')});decoder=null;
              assembler.consume({name:'stringValue',value:''});
            }else{assembler.consume({name:'stringValue',value:string});string=null;}break;
          case 'startNumber':number='';break;
          case 'numberChunk':metadata(token.value);number+=token.value;if(number.length>64)throw new Error('Número inválido no backup.');break;
          case 'endNumber':assembler.consume({name:'numberValue',value:number});number=null;break;
          case 'startObject':containers.push(new Set());if(containers.length>64)throw new Error('Backup inválido: estrutura muito profunda.');assembler.consume(token);break;
          case 'startArray':containers.push(null);if(containers.length>64)throw new Error('Backup inválido: estrutura muito profunda.');assembler.consume(token);break;
          case 'endObject': {
            const location=assembler.path,object=assembler.current;
            if(location.length===2&&location[0]==='media'){
              const file=files.get(object);if(!file||typeof object.id!=='string'||!object.id||ids.has(object.id)||ids.size>=10000)throw new Error('Mídia inválida no backup.');
              if(file.sha256!==String(object.sha256).toLowerCase())throw new Error('Arquivo de backup corrompido.');
              const info=format(String(object.name),object.mime),target=path.join(this.dir,`${randomUUID()}${info.ext}`);
              await fs.promises.rename(file.path,target);created.delete(file.path);created.add(target);ids.add(object.id);
              delete object.base64;delete object.path;Object.assign(object,{name:info.name,mime:info.mime,type:info.type,path:target,size:file.size});
            }
            containers.pop();assembler.consume(token);break;
          }
          case 'endArray':containers.pop();assembler.consume(token);break;
          default:assembler.consume(token);
        }
      }
      const data=assembler.current;
      if(!assembler.done||!data||data.format!=='mega-disparos'||data.version!==1||!Array.isArray(data.media)||!Array.isArray(data.campaigns)||!Array.isArray(data.groups)||!Array.isArray(data.settings))throw new Error('Backup inválido.');
      if(data.media.length!==ids.size)throw new Error('Mídia inválida no backup.');
      const allItems=data.campaigns.flatMap(c=>[...(c.items||[]),...Object.values(c.groupOverrides||{}).flatMap(v=>v.items||[])]).concat((data.templates||[]).flatMap(t=>t.items||[]));
      for(const item of allItems) if(item.type!=='text'&&!ids.has(item.mediaId)) throw new Error('Conteúdo referencia uma mídia ausente.');
      await syncDirectory(this.dir);
      this.store.importData(data);
      return {campaigns:data.campaigns.length,media:data.media.length};
    } catch(e) {await decoder?.handle?.close().catch(()=>{});for(const file of created)await fs.promises.unlink(file).catch(()=>{});throw e;}
    finally {input.destroy();tokens.destroy();}
  }
}
module.exports={MediaManager,MAX_FILE,MAX_BACKUP_MEDIA,MAX_METADATA};
