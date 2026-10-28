'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {writeRecordsJSON}=require('../src/core/export-records.cjs');
test('paged JSON export checks permission between pages and leaves the previous file intact if revoked',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-record-export-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'records.json');fs.writeFileSync(file,'previous');let checks=0,pages=0;
 await assert.rejects(writeRecordsJSON(file,{header:{format:'mega-disparos-logs'},pageSize:2,check(){if(++checks===2)throw new Error('Acesso revogado');},page(offset){pages++;return{items:[{id:offset},{id:offset+1}],total:4};}}),/Acesso revogado/);assert.equal(pages,1);assert.equal(fs.readFileSync(file,'utf8'),'previous');assert.equal(fs.readdirSync(dir).some(f=>f.endsWith('.tmp')),false);
});
test('paged JSON export returns the true record count and preserves non-ASCII content',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-record-export-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'records.json'),items=[{text:'Português 👋'},{text:'Quebra\nlinha'},{text:'*Texto*'}];const count=await writeRecordsJSON(file,{header:{format:'mega-disparos-logs',version:1},pageSize:2,page:(offset,limit)=>({items:items.slice(offset,offset+limit),total:items.length})});assert.equal(count,3);assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')).records,items);
});
