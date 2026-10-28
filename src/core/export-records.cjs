'use strict';
const {writeJSONExport}=require('./log-export.cjs');

async function writeRecordsJSON(destination,{header={},page,limit=100000,pageSize=200,check}={}){
  const result=await writeJSONExport(destination,{
    metadata:header,maxRecords:limit,pageSize,
    getPage:async({offset,limit:pageLimit})=>{await check?.();return page(offset,pageLimit);}
  });
  return result.count;
}
module.exports={writeRecordsJSON};
