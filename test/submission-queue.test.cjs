'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createStore,seed}=require('../src/core/store.cjs');
const {Scheduler}=require('../src/core/scheduler.cjs');
const {SimulatedAdapter}=require('../src/adapters/simulated.cjs');
const {AuthService}=require('../src/core/auth.cjs');
const {AlertService}=require('../src/core/alerts.cjs');
const {SearchService}=require('../src/core/search-service.cjs');

const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t,{owner=false}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-shared-submission-'));
  const store=await createStore(dir);seed(store);
  const clock={now:new Date(2026,0,5,9).getTime()},gates=[],services=[];
  const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});const result={promise,resolve};gates.push(result);return result;};
  const sleep=async ms=>{clock.now+=ms;};
  const adapter=new SimulatedAdapter({store,delayMs:0});await adapter.connect();
  const scheduler=new Scheduler({store,adapter,now:()=>clock.now,sleep});
  const original=store.listCampaigns()[0];
  const campaign=store.saveCampaign({...original,groupIds:[original.groupIds[0]],schedule:{...original.schedule,startTime:'00:00',endTime:'00:00'},items:[{id:'message-one',type:'text',text:'Campanha de simulação'}]});
  let auth,account;
  if(owner){auth=new AuthService({store,clock:()=>clock.now});account=(await auth.setupOwner({name:'Dono',username:'dono',phone:'5511999990001',password:'Senha-BUSCAS-simulada-2026'})).user;}
  t.after(async()=>{
    for(const barrier of gates)barrier.resolve();
    await Promise.allSettled(services.map(service=>service.shutdown()));
    await scheduler.shutdown();await adapter.disconnect();store.close();fs.rmSync(dir,{recursive:true,force:true});
  });
  return {store,adapter,scheduler,campaign,clock,sleep,gate,services,auth,account};
}

test('external submissions use FIFO and hold a due campaign until both requests settle',{timeout:10000},async t=>{
  const f=await fixture(t),firstEntered=f.gate(),firstReleased=f.gate(),secondEntered=f.gate(),secondReleased=f.gate(),events=[];
  await f.scheduler.activate(f.campaign.id);
  let inFlight=0,maximum=0;
  const task=(name,entered,released)=>async()=>{inFlight++;maximum=Math.max(maximum,inFlight);events.push(`${name}:start`);entered.resolve();try{await released.promise;events.push(`${name}:finish`);return name;}finally{inFlight--;}};
  const first=f.scheduler.runExternalSubmission(task('first',firstEntered,firstReleased));
  const second=f.scheduler.runExternalSubmission(task('second',secondEntered,secondReleased));
  await firstEntered.promise;await turn();
  assert.deepEqual(events,['first:start']);assert.equal(f.scheduler.submissionHolds,2);
  await f.scheduler.tick();assert.equal(f.adapter.sent.length,0,'a due campaign must not start inside the private delivery queue');
  firstReleased.resolve();await secondEntered.promise;assert.deepEqual(events,['first:start','first:finish','second:start']);
  await f.scheduler.tick();assert.equal(f.adapter.sent.length,0);
  secondReleased.resolve();assert.deepEqual(await Promise.all([first,second]),['first','second']);assert.equal(maximum,1);assert.equal(f.scheduler.submissionHolds,0);
  await f.scheduler.tick();assert.equal(f.adapter.sent.length,1);assert.equal(f.store.listJobs({status:'confirmed'}).length,1);
});

test('an already submitted campaign finishes before either external request starts',{timeout:10000},async t=>{
  const f=await fixture(t),campaignEntered=f.gate(),campaignReleased=f.gate(),events=[];
  const send=f.adapter.send.bind(f.adapter);
  f.adapter.send=async(...args)=>{events.push('campaign:start');campaignEntered.resolve();await campaignReleased.promise;const result=await send(...args);events.push('campaign:finish');return result;};
  await f.scheduler.activate(f.campaign.id);const round=f.scheduler.tick();await campaignEntered.promise;
  const first=f.scheduler.runExternalSubmission(async()=>{events.push('search:start');return 'search';});
  const second=f.scheduler.runExternalSubmission(async()=>{events.push('alert:start');return 'alert';});
  await turn();assert.deepEqual(events,['campaign:start']);assert.equal(f.scheduler.busy,true);
  campaignReleased.resolve();await Promise.all([round,first,second]);
  assert.deepEqual(events,['campaign:start','campaign:finish','search:start','alert:start']);assert.equal(f.scheduler.submissionHolds,0);assert.equal(f.store.listJobs({status:'confirmed'}).length,1);
});

test('a failed external callback releases its hold and does not poison subsequent requests or campaigns',{timeout:10000},async t=>{
  const f=await fixture(t),events=[];
  await f.scheduler.activate(f.campaign.id);
  const first=f.scheduler.runExternalSubmission(async()=>{events.push('failed');throw Object.assign(new Error('Falha antes da submissão'),{safeToRetry:true});});
  const rejection=assert.rejects(first,/Falha antes da submissão/);
  const second=f.scheduler.runExternalSubmission(async()=>{events.push('next');return 'ok';});
  await rejection;assert.equal(await second,'ok');assert.deepEqual(events,['failed','next']);assert.equal(f.scheduler.submissionHolds,0);
  await f.scheduler.tick();assert.equal(f.store.listJobs({status:'confirmed'}).length,1);
});

test('shutdown waits for the running request and explicitly rejects queued work without removing its durable ledger',{timeout:10000},async t=>{
  const f=await fixture(t),entered=f.gate(),released=f.gate();
  f.store.saveSearchRun({id:'queued-run',actorId:'owner',chatId:null,messageId:null,status:'completed',createdAt:f.clock.now});
  f.store.saveSearchDelivery({id:'queued-delivery',runId:'queued-run',actorId:'owner',target:'5511999990001@s.whatsapp.net',text:'Resultado pendente',status:'pending',createdAt:f.clock.now,clientMessageId:'QUEUED-DURABLE'});
  const first=f.scheduler.runExternalSubmission(async()=>{entered.resolve();await released.promise;return 'finished';});await entered.promise;
  let queuedExecuted=false;
  const second=f.scheduler.runExternalSubmission(async()=>{queuedExecuted=true;f.store.updateSearchDelivery('queued-delivery',{status:'sending'});});
  const denied=assert.rejects(second,/bloqueados/);
  let shutdownFinished=false;const shutdown=f.scheduler.shutdown().then(()=>{shutdownFinished=true;});
  await turn();assert.equal(shutdownFinished,false,'shutdown must await an in-flight submission');assert.equal(queuedExecuted,false);
  released.resolve();assert.equal(await first,'finished');await denied;await shutdown;
  assert.equal(queuedExecuted,false);assert.equal(f.scheduler.submissionHolds,0);assert.equal(f.store.getSearchDelivery('queued-delivery').status,'pending');assert.equal(f.store.getSearchDelivery('queued-delivery').clientMessageId,'QUEUED-DURABLE');
  await assert.rejects(f.scheduler.runExternalSubmission(async()=>{throw new Error('must not run');}),/bloqueados/);assert.equal(f.scheduler.submissionHolds,0);
});

test('real search and alert services share the scheduler queue and persist confirmations without overlapping transports',{timeout:10000},async t=>{
  const f=await fixture(t,{owner:true}),searchEntered=f.gate(),searchReleased=f.gate(),alertEntered=f.gate(),alertReleased=f.gate(),events=[];
  const searches=new SearchService({store:f.store,adapter:f.adapter,authService:f.auth,scheduler:f.scheduler,now:()=>f.clock.now,sleep:f.sleep});
  const alerts=new AlertService({store:f.store,adapter:f.adapter,scheduler:f.scheduler,now:()=>f.clock.now,sleep:f.sleep});f.services.push(searches,alerts);
  searches.saveSettings({enabled:true,ownerRecipientUserId:f.account.id},f.account.id);await searches.flushDeliveries();
  f.store.saveSearchRun({id:'search-run',actorId:f.account.id,chatId:null,messageId:null,createdAt:f.clock.now,status:'completed'});
  f.store.saveSearchDelivery({id:'search-delivery',runId:'search-run',actorId:f.account.id,target:`${f.account.phone}@s.whatsapp.net`,text:'Resultados simulados',clientMessageId:'SEARCH-DURABLE',createdAt:f.clock.now,status:'pending'});
  f.store.saveAlert({id:'alert-delivery',number:f.account.phone,text:'Aviso simulado',messageId:'ALERT-DURABLE',channel:'whatsapp',createdAt:f.clock.now,status:'pending'});
  let inFlight=0,maximum=0;
  const track=(name,entered,released,send)=>async(...args)=>{inFlight++;maximum=Math.max(maximum,inFlight);events.push(`${name}:start`);entered.resolve();try{await released.promise;const result=await send(...args);events.push(`${name}:finish`);return result;}finally{inFlight--;}};
  f.adapter.sendSearchText=track('search',searchEntered,searchReleased,f.adapter.sendSearchText.bind(f.adapter));
  f.adapter.sendPrivate=track('alert',alertEntered,alertReleased,f.adapter.sendPrivate.bind(f.adapter));
  const search=searches.flushDeliveries();assert.equal(searches.flushDeliveries(),search,'concurrent flush must reuse the existing pump');await searchEntered.promise;
  const alert=alerts.flush();assert.equal(alerts.flush(),alert);await turn();assert.deepEqual(events,['search:start']);assert.equal(f.store.getSearchDelivery('search-delivery').status,'sending');assert.equal(f.store.getAlert('alert-delivery').status,'pending');
  searchReleased.resolve();await alertEntered.promise;assert.equal(f.store.getSearchDelivery('search-delivery').status,'confirmed');assert.equal(f.store.getAlert('alert-delivery').status,'sending');alertReleased.resolve();await Promise.all([search,alert]);
  assert.deepEqual(events,['search:start','search:finish','alert:start','alert:finish']);assert.equal(maximum,1);assert.equal(f.scheduler.submissionHolds,0);assert.equal(f.store.getAlert('alert-delivery').status,'confirmed');assert.equal(f.adapter.sent.length,2);assert.ok(f.adapter.sent.every(entry=>entry.simulation));
});

test('a safe search delivery failure remains pending and releases the shared slot so the queued alert can confirm',{timeout:10000},async t=>{
  const f=await fixture(t,{owner:true}),entered=f.gate(),released=f.gate(),events=[];
  const searches=new SearchService({store:f.store,adapter:f.adapter,authService:f.auth,scheduler:f.scheduler,now:()=>f.clock.now,sleep:f.sleep});
  const alerts=new AlertService({store:f.store,adapter:f.adapter,scheduler:f.scheduler,now:()=>f.clock.now,sleep:f.sleep});f.services.push(searches,alerts);
  searches.saveSettings({enabled:true,ownerRecipientUserId:f.account.id},f.account.id);await searches.flushDeliveries();
  f.store.saveSearchRun({id:'failure-run',actorId:f.account.id,chatId:null,messageId:null,status:'completed',createdAt:f.clock.now});
  f.store.saveSearchDelivery({id:'failure-delivery',runId:'failure-run',actorId:f.account.id,target:`${f.account.phone}@s.whatsapp.net`,text:'Resultados simulados',clientMessageId:'FAILED-DURABLE',status:'pending',createdAt:f.clock.now});
  f.store.saveAlert({id:'next-alert',number:f.account.phone,text:'Alerta posterior',messageId:'NEXT-ALERT-DURABLE',channel:'whatsapp',createdAt:f.clock.now,status:'pending'});
  f.adapter.sendSearchText=async()=>{events.push('search:failed');entered.resolve();await released.promise;throw Object.assign(new Error('Falha temporária antes do envio'),{safeToRetry:true});};
  const sendAlert=f.adapter.sendPrivate.bind(f.adapter);f.adapter.sendPrivate=async(...args)=>{events.push('alert:sent');return sendAlert(...args);};
  const search=searches.flushDeliveries();await entered.promise;const alert=alerts.flush();released.resolve();await Promise.all([search,alert]);
  assert.deepEqual(events,['search:failed','alert:sent']);assert.equal(f.store.getSearchDelivery('failure-delivery').status,'pending');assert.equal(f.store.getSearchDelivery('failure-delivery').attempts,1);assert.equal(f.store.getAlert('next-alert').status,'confirmed');assert.equal(f.scheduler.submissionHolds,0);assert.equal(f.adapter.sent.length,1);
});
