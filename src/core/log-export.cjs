'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {setImmediate:yieldToEvents}=require('node:timers/promises');

// Native and transport events get an event-loop turn between pages; no full
// export array or second serialized copy needs to exist in memory.
async function writeJSONExport(filename,{metadata={},getPage,maxRecords=100000,pageSize=200}={}){
  if(typeof getPage!=='function')throw new Error('Consulta de exportação inválida.');
  if(!Number.isInteger(pageSize)||pageSize<1||pageSize>500||!Number.isInteger(maxRecords)||maxRecords<1||maxRecords>1000000)throw new Error('Limites de exportação inválidos.');
  fs.mkdirSync(path.dirname(filename),{recursive:true});
  const temp=`${filename}.${randomUUID()}.tmp`;let fd,count=0;
  try{
    fd=fs.openSync(temp,'wx',0o600);
    const header=JSON.stringify(metadata);fs.writeFileSync(fd,`${header.slice(0,-1)}${Object.keys(metadata).length?',':''}"records":[\n`);
    while(true){
      const page=await getPage({limit:pageSize,offset:count});
      if(!page||!Array.isArray(page.items))throw new Error('Resposta de registros inválida.');
      if(page.total>maxRecords||count+page.items.length>maxRecords)throw new Error(`Exportação acima de ${maxRecords.toLocaleString('pt-BR')} registros. Use filtros de data.`);
      for(const record of page.items){fs.writeFileSync(fd,`${count?',\n':''}${JSON.stringify(record)}`);count++;}
      if(!page.items.length||count>=page.total)break;
      await yieldToEvents();
    }
    fs.writeFileSync(fd,'\n]}');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,filename);
    let directory;
    try{directory=fs.openSync(path.dirname(filename),'r');fs.fsyncSync(directory);}catch{}
    finally{if(directory!==undefined)fs.closeSync(directory);}
    return {path:filename,count};
  }catch(error){if(fd!==undefined)try{fs.closeSync(fd);}catch{}try{fs.unlinkSync(temp);}catch{}throw error;}
}

module.exports={writeJSONExport};
