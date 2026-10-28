'use strict';

const {parentPort,workerData}=require('node:worker_threads');
const {createAppService}=require('./service.cjs');
let service,sequence=0;const pending=new Map();
function host(action,payload={}){
  const id=++sequence;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});parentPort.postMessage({type:'hostCall',id,action,payload});});
}
const safeStorage={
  isEncryptionAvailable:()=>host('encryptionAvailable'),
  encryptString:value=>host('encryptString',{value}),
  decryptString:value=>host('decryptString',{value:Buffer.from(value)})
};
parentPort.on('message',async message=>{
  if(message?.type==='hostResult'){
    const request=pending.get(message.id);if(!request)return;pending.delete(message.id);
    if(message.error)request.reject(new Error(message.error));else request.resolve(message.result);return;
  }
  if(message?.type!=='call')return;
  try{
    if(!service)throw new Error('O processamento ainda está iniciando.');
    const result=await (message.system?service.systemCall(message.action,message.payload):service.call(message.action,message.payload));
    parentPort.postMessage({type:'result',id:message.id,result});
  }catch(error){parentPort.postMessage({type:'result',id:message.id,error:error.message||'Não foi possível concluir a operação.',code:error.code});}
});
(async()=>{
  service=await createAppService({dir:workerData.dir,version:workerData.version,runtimePlatform:workerData.runtimePlatform,safeStorage,host});
  service.on('update',snapshot=>parentPort.postMessage({type:'event',name:'update',payload:snapshot}));
  service.on('nativeEvent',event=>parentPort.postMessage({type:'event',name:'nativeEvent',payload:event}));
  parentPort.postMessage({type:'ready',payload:await service.systemCall('settings')});
})().catch(error=>parentPort.postMessage({type:'startupError',error:error.message||'Não foi possível abrir os dados.'}));
