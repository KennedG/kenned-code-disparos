const fs = require('node:fs');
const path = require('node:path');
const {randomUUID,createHash} = require('node:crypto');
const {atomicWrite} = require('./store.cjs');
const MAX_FILE = 64 * 1024 * 1024;
const types = {'.jpg':['image/jpeg','image'],'.jpeg':['image/jpeg','image'],'.png':['image/png','image'],'.webp':['image/webp','image'],'.mp4':['video/mp4','video'],'.mov':['video/quicktime','video'],'.pdf':['application/pdf','document'],'.doc':['application/msword','document'],'.docx':['application/vnd.openxmlformats-officedocument.wordprocessingml.document','document'],'.xls':['application/vnd.ms-excel','document'],'.xlsx':['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','document'],'.pptx':['application/vnd.openxmlformats-officedocument.presentationml.presentation','document'],'.txt':['text/plain','document'],'.csv':['text/csv','document'],'.zip':['application/zip','document']};
class MediaManager {
  constructor(store) { this.store = store; this.dir = path.join(store.dir,'media'); fs.mkdirSync(this.dir,{recursive:true}); }
  async importFile(filename) { const stat = fs.statSync(filename); if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('Selecione um arquivo de até 64 MB.'); return this.importBuffer(fs.readFileSync(filename),{name:path.basename(filename)}); }
  async importBuffer(buffer, metadata = {}) {
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    if (!buffer.length || buffer.length > MAX_FILE) throw new Error('Arquivos devem ter entre 1 byte e 64 MB.');
    const name = path.basename(String(metadata.name || 'arquivo')).replace(/[\x00-\x1f]/g,'').slice(0,180);
    let ext = path.extname(name).toLowerCase();
    if (!types[ext]) {
      const found = Object.entries(types).find(([,v])=>v[0]===metadata.mime);
      if (found) ext = found[0];
      else throw new Error('Formato não suportado. Use imagens JPG/PNG/WebP, vídeos MP4/MOV ou documentos PDF/Office/TXT/CSV/ZIP.');
    }
    const [mime,type] = types[ext]; const id = randomUUID(); const target = path.join(this.dir,`${id}${ext}`);
    atomicWrite(target,buffer);
    const displayName=path.extname(name).toLowerCase()===ext?name:`${name}${ext}`;
    return this.store.saveMedia({id,name:displayName,mime,type,path:target,size:buffer.length,sha256:createHash('sha256').update(buffer).digest('hex'),createdAt:Date.now()});
  }
  getPath(id) {
    const m = this.store.getMedia(id); if (!m || !m.path) throw new Error('Mídia não encontrada.');
    if (!fs.existsSync(m.path)) throw new Error('Mídia gerenciada ausente ou inválida.');
    const file = fs.realpathSync(m.path); if (!file.startsWith(fs.realpathSync(this.dir)+path.sep)) throw new Error('Mídia gerenciada ausente ou inválida.');
    return file;
  }
  async createBackup(destination) {
    const data = this.store.exportData(); let total=0;
    data.media = data.media.map(m=> { const bytes=fs.readFileSync(this.getPath(m.id)); total+=bytes.length; if(total>512*1024*1024) throw new Error('Backup maior que 512 MB: reduza a biblioteca antes de exportar.'); const {path:ignored,...meta}=m; return {...meta,base64:bytes.toString('base64')}; });
    atomicWrite(destination,Buffer.from(JSON.stringify(data)));
    return destination;
  }
  async restoreBackup(filename) {
    if (fs.statSync(filename).size > 720*1024*1024) throw new Error('Backup muito grande.');
    const data=JSON.parse(fs.readFileSync(filename,'utf8'));
    if(data.format!=='mega-disparos'||data.version!==1||!Array.isArray(data.media)||!Array.isArray(data.campaigns)||!Array.isArray(data.groups)||!Array.isArray(data.settings)) throw new Error('Backup inválido.');
    const created=[]; const ids=new Set();
    try {
      data.media=data.media.map(m=> {
        if(typeof m.id!=='string'||ids.has(m.id)||typeof m.base64!=='string') throw new Error('Mídia inválida no backup.'); ids.add(m.id);
        const bytes=Buffer.from(m.base64,'base64'); if(!bytes.length||bytes.length>MAX_FILE||createHash('sha256').update(bytes).digest('hex')!==m.sha256) throw new Error('Arquivo de backup corrompido.');
        let ext=path.extname(String(m.name)).toLowerCase();
        if(!types[ext])ext=Object.entries(types).find(([,value])=>value[0]===m.mime)?.[0];
        if(!types[ext]) throw new Error('Formato inválido no backup.');
        const target=path.join(this.dir,`${randomUUID()}${ext}`); atomicWrite(target,bytes); created.push(target);
        const {base64:ignored,path:unsafe,...meta}=m; return {...meta,name:path.extname(String(m.name)).toLowerCase()===ext?m.name:`${m.name}${ext}`,path:target,type:types[ext][1],mime:types[ext][0],size:bytes.length};
      });
      const allItems=data.campaigns.flatMap(c=>[...(c.items||[]),...Object.values(c.groupOverrides||{}).flatMap(v=>v.items||[])]).concat((data.templates||[]).flatMap(t=>t.items||[]));
      for(const item of allItems) if(item.type!=='text'&&!ids.has(item.mediaId)) throw new Error('Conteúdo referencia uma mídia ausente.');
      this.store.importData(data);
      return {campaigns:data.campaigns.length,media:data.media.length};
    } catch(e) { for(const file of created) try{fs.unlinkSync(file);}catch{} throw e; }
  }
}
module.exports={MediaManager,MAX_FILE};
