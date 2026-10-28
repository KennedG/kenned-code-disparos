'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Worker}=require('node:worker_threads');
const {WorkerClient}=require('../src/core/worker-client.cjs');
const PASSWORD='Senha-Segura-Worker-2026';
const OWNER={name:'Dono do teste',username:'dono-worker',password:PASSWORD,phone:'5511999980001'};
async function fixture(t,{dir}={}){
  const temporary=!dir;dir=dir||fs.mkdtempSync(path.join(os.tmpdir(),'mega-worker-'));const native=[];
  const worker=new Worker(path.resolve(__dirname,'../src/backend/worker.cjs'),{workerData:{dir,version:'2.0.0',runtimePlatform:'linux'}});
  const client=new WorkerClient(worker,{host:async(action,payload)=>{native.push({action,payload});if(action==='licenseStatus')return {allowed:true,status:'trial',plan:'trial',expiresAt:Date.now()+72*3600000,remainingMs:72*3600000,offlineUntil:Date.now()+72*3600000,offlineRemainingMs:72*3600000,serverConfigured:true};if(action==='secretGet')return null;if(action==='encryptionAvailable')return true;if(action==='encryptString')return Buffer.from(payload.value);if(action==='decryptString')return Buffer.from(payload.value).toString();if(action==='localAlert')return {nativeStatus:'requested',soundStatus:'disabled'};if(action==='testSound')return {soundStatus:payload.preferences.volume===0?'silent':'completed'};return {canceled:true};}});
  t.after(async()=>{await client.shutdown();if(temporary)fs.rmSync(dir,{recursive:true,force:true});});await client.ready;return {client,dir,native,worker};
}

test('real worker persists owner and campaigns, enforces login, and cannot expose internal RPC actions',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-worker-restart-'));const {client}=await fixture(t,{dir});let snapshot=await client.call('snapshot');assert.equal(snapshot.auth.setupRequired,true);assert.deepEqual(snapshot.campaigns,[]);
  for(const action of ['stopAll','listUsers'])await assert.rejects(client.call(action),/login/i);
  for(const action of ['networkState','emergencyStop','systemCall','constructor','__proto__'])await assert.rejects(client.call(action,{online:false}),/não autorizada/i);
  const result=await client.call('setupOwner',OWNER);assert.equal(result.recoveryCodes.length,8);snapshot=await client.call('snapshot');assert.equal(snapshot.campaigns[0].state,'draft');assert.equal(snapshot.campaigns[0].groupIds.length,15);assert.equal(snapshot.campaigns[0].ownerId,result.user.id);
  await client.call('logout');snapshot=await client.call('snapshot');assert.equal(snapshot.auth.authenticated,false);assert.equal(snapshot.connection,null);assert.deepEqual(snapshot.campaigns,[]);
  await client.shutdown();const reopened=await fixture(t,{dir});t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));assert.equal((await reopened.client.call('snapshot')).auth.setupRequired,false);await reopened.client.call('login',{username:OWNER.username,password:PASSWORD});snapshot=await reopened.client.call('snapshot');assert.equal(snapshot.campaigns[0].ownerId,result.user.id);assert.equal(snapshot.campaigns[0].state,'draft');assert.equal(snapshot.metrics.confirmed,0);assert.equal(JSON.stringify(snapshot).includes('passwordHash'),false);
});

test('real worker sends disconnect events to native host while logged out and records only explicit notification acknowledgement',async t=>{
  const {client,native}=await fixture(t);await client.call('setupOwner',OWNER);await client.call('logout');await client.systemCall('networkState',{online:false});
  await client.call('login',{username:OWNER.username,password:PASSWORD});let snapshot=await client.call('snapshot');const request=native.find(n=>n.action==='localAlert');assert.ok(request);assert.equal(request.payload.event,'disconnect');assert.equal(snapshot.connection.reasonCode,'internet');
  assert.equal(snapshot.notifications.find(n=>n.id===request.payload.id).nativeStatus,'requested');
  await client.systemCall('nativeNotificationResult',{id:request.payload.id,status:'shown'});snapshot=await client.call('snapshot');assert.equal(snapshot.notifications.find(n=>n.id===request.payload.id).nativeStatus,'shown');
  await client.call('saveSettings',{settings:{sound:{volume:0}}});assert.equal((await client.call('testSound')).soundStatus,'silent');assert.equal(native.find(n=>n.action==='testSound').payload.preferences.volume,0);
  await client.systemCall('networkState',{online:true});await client.call('connect');snapshot=await client.call('snapshot');assert.equal(snapshot.connection.state,'connected');assert.equal(snapshot.metrics.confirmed,0);
});

test('a CPU-bound backend RPC leaves the host event loop responsive; worker exit rejects unresolved requests',async t=>{
  const worker=new Worker(`const {parentPort}=require('node:worker_threads');parentPort.postMessage({type:'ready',payload:{}});parentPort.on('message',message=>{if(message.action==='busy'){const end=Date.now()+250;while(Date.now()<end){}parentPort.postMessage({type:'result',id:message.id,result:'done'});}else if(message.action==='exit'){process.exit(7);}});`,{eval:true});
  const client=new WorkerClient(worker);t.after(()=>client.shutdown());await client.ready;let beats=0;const interval=setInterval(()=>beats++,10);
  try{assert.equal(await client.call('busy'),'done');assert.ok(beats>=5,`O loop principal deve continuar atendendo eventos (${beats}).`);}finally{clearInterval(interval);}
  const fatal=new Promise(resolve=>client.once('fatal',resolve));await assert.rejects(client.call('exit'),/código 7/);assert.equal((await fatal).message.includes('código 7'),true);await assert.rejects(client.call('snapshot'),/indisponível/);
});
