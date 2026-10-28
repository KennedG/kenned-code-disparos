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
  constructor(store, options = {}) { this.store = store; this.dir = path.join(store.dir,'media'); this.chunkSize=options.chunkSize || CHUNK; fs.mkdirSync(this.dir,{recursive:true}); }
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
