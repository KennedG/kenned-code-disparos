'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createStore,seed}=require('../src/core/store.cjs');
const {AuthService}=require('../src/core/auth.cjs');
const {SimulatedAdapter}=require('../src/adapters/simulated.cjs');
const {Scheduler}=require('../src/core/scheduler.cjs');
const {SearchService}=require('../src/core/search-service.cjs');
const {ReminderService}=require('../src/core/reminders.cjs');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kcd-private-deadline-')),store=await createStore(dir);seed(store);const clock={now:Date.now()},now=()=>clock.now,sleep=async ms=>{clock.now+=ms;};
 const auth=new AuthService({store,clock:now}),owner=(await auth.setupOwner({name:'Dono de teste',username:'owner',phone:'5511999990001',password:'Senha-forte-deadline-2026'})).user;
 const adapter=new SimulatedAdapter({store,delayMs:0});await adapter.connect();const scheduler=new Scheduler({store,adapter,now,sleep,attemptTimeoutMs:20});let stopped=false;
 const searches=new SearchService({store,adapter,authService:auth,scheduler,now,sleep,automationGuard:()=>!stopped});searches.start();searches.saveSettings({enabled:true,ownerRecipientUserId:owner.id,privateCommandsEnabled:true},owner.id);await searches.waitForIdle();
 const reminders=new ReminderService({store,auth,scheduler,adapter,now,sleep,isAutomationStopped:()=>stopped});reminders.start();await reminders.waitForIdle();
 t.after(async()=>{await searches.shutdown();await reminders.shutdown();await scheduler.shutdown();await adapter.disconnect();store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const search=(id)=>{store.saveSearchRun({id:`run-${id}`,actorId:owner.id,status:'completed',createdAt:now()});return store.saveSearchDelivery({id,runId:`run-${id}`,traceId:require('node:crypto').randomUUID(),actorId:owner.id,target:`${owner.phone}@s.whatsapp.net`,text:`Resultado de teste ${id}`,clientMessageId:`KCD-TEST-${id}`,status:'pending',attempts:0,createdAt:now()});};
 const reminder=id=>{const item=reminders.save({title:`Lembrete ${id}`,recipientId:`user:${owner.id}`,time:'10:00',enabled:false},owner.id);return reminders._queue(item,now(),{test:true,userId:owner.id});};
 const stop=()=>{stopped=true;store.setSetting('automationState',{stopped:true});scheduler.setAutomationBlocked(true);searches.stopPending({actorId:owner.id});reminders.stopAll({actorId:owner.id});};
 return{store,owner,adapter,scheduler,searches,reminders,search,reminder,clock,now,stop};
}

test('actual shared Scheduler: a stalled search response becomes uncertain and the next private response proceeds; late ACK reconciles once',async t=>{
 const f=await fixture(t),a=f.search('search-a'),b=f.search('search-b');let resolve,calls=0;const send=f.adapter.sendSearchText.bind(f.adapter);
 f.adapter.sendSearchText=(target,text,options)=>{calls++;assert(options.signal);assert.equal(typeof options.beforeSubmit,'function');return text.endsWith('search-a')?new Promise(done=>{resolve=()=>done({status:'confirmed',messageId:options.clientMessageId,confirmationScope:'simulation-only'});}):send(target,text,options);};
 await f.searches.flushDeliveries();assert.equal(calls,2);assert.equal(f.store.getSearchDelivery(a.id).status,'uncertain');assert.equal(f.store.getSearchDelivery(b.id).status,'confirmed');assert.equal(f.scheduler.submissionHolds,0);resolve();await turn();assert.equal(f.store.getSearchDelivery(a.id).status,'confirmed');assert.equal(calls,2);assert.equal(f.store.listSearchDeliveries({limit:100}).total,2);
});

test('a stalled search recipient lookup fails without submission and never resumes its stale batch after the resolver returns',async t=>{
 const f=await fixture(t),a=f.search('resolve-a'),b=f.search('resolve-b');let release,count=0;const resolve=f.adapter.resolveRecipient.bind(f.adapter);
 f.adapter.resolveRecipient=(number,options)=>++count===1?new Promise(done=>{release=()=>done({jid:`${number}@s.whatsapp.net`,phone:number,mode:'simulated',simulation:true});}):resolve(number,options);
 await f.searches.flushDeliveries();assert.equal(f.store.getSearchDelivery(a.id).status,'failed');assert.equal(f.store.getSearchDelivery(a.id).safeToRetry,true);assert.equal(f.store.getSearchDelivery(b.id).status,'confirmed');assert.equal(f.adapter.sent.length,1);release();await turn();assert.equal(f.adapter.sent.length,1);
});

test('the final search guard prevents a delayed pre-submit response after stopAll without disabling administrative queue access',async t=>{
 const f=await fixture(t),a=f.search('stop-search');let release,entered;const started=new Promise(done=>{entered=done;});let actuallySent=0;
 f.adapter.sendSearchText=(_target,_text,options)=>new Promise((done,fail)=>{entered();release=()=>{try{options.beforeSubmit();actuallySent++;done({status:'confirmed',messageId:options.clientMessageId});}catch(error){fail(error);}}});
 const flush=f.searches.flushDeliveries();await started;f.stop();release();await flush;assert.equal(actuallySent,0);assert.equal(f.store.getSearchDelivery(a.id).status,'failed');assert.equal(await f.scheduler.runExternalSubmission(()=> 'admin reply',{manual:true,controlOnly:true}),'admin reply');assert.equal(f.scheduler.persistenceFailed,false);
});

test('actual shared Scheduler: a stalled reminder does not block the next reminder and late ACK changes only the original ledger',async t=>{
 const f=await fixture(t),a=f.reminder('A'),b=f.reminder('B');let resolve,calls=0;const send=f.adapter.sendPrivate.bind(f.adapter);
 f.adapter.sendPrivate=(number,text,options)=>{calls++;assert(options.signal);return text.includes('Lembrete A')?new Promise(done=>{resolve=()=>done({status:'confirmed',messageId:options.clientMessageId,confirmationScope:'simulation-only'});}):send(number,text,options);};
 await f.reminders.flush();assert.equal(calls,2,JSON.stringify(f.store.listEntities('reminder_deliveries').map(x=>({id:x.id,status:x.status,code:x.code,error:x.error}))));assert.equal(f.store.getEntity('reminder_deliveries',a.id).status,'uncertain');assert.equal(f.store.getEntity('reminder_deliveries',b.id).status,'confirmed');assert.equal(f.scheduler.submissionHolds,0);resolve();await turn();assert.equal(f.store.getEntity('reminder_deliveries',a.id).status,'confirmed');assert.equal(calls,2);await f.reminders.flush();assert.equal(calls,2);
});

test('final reminder guard prevents submission when stop or recipient authorization changes during preparation',async t=>{
 const f=await fixture(t),a=f.reminder('guard');let release,entered;const started=new Promise(done=>{entered=done;});let actual=0;
 f.adapter.sendPrivate=(_number,_text,options)=>new Promise((done,fail)=>{entered();release=()=>{try{options.beforeSubmit();actual++;done({status:'confirmed',messageId:options.clientMessageId});}catch(error){fail(error);}}});
 const flush=f.reminders.flush();await started;f.stop();release();await flush;assert.equal(actual,0);assert.notEqual(f.store.getEntity('reminder_deliveries',a.id).status,'confirmed');assert.equal(f.scheduler.persistenceFailed,false);
});

test('accepted private proof is distinct from delivered proof and later old ACK cannot erase delivery metadata',async t=>{
 const f=await fixture(t),a=f.search('proof');await f.searches.flushDeliveries();let ledger=f.store.getSearchDelivery(a.id);assert.equal(ledger.status,'confirmed');assert(!ledger.deliveredAt);
 f.adapter.emit('receipt',{messageId:a.clientMessageId,status:'delivered',deliveredAt:f.now(),mode:'simulated',simulation:true,confirmationScope:'simulation-only'});ledger=f.store.getSearchDelivery(a.id);assert.equal(ledger.deliveredAt,f.now());f.adapter.emit('receipt',{messageId:a.clientMessageId,status:'confirmed',mode:'simulated',simulation:true,confirmationScope:'simulation-only'});assert.equal(f.store.getSearchDelivery(a.id).deliveredAt,f.now());assert.equal(f.adapter.sent.length,1);
});
