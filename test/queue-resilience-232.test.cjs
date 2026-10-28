'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {Scheduler}=require('../src/core/scheduler.cjs');
const copy=x=>x===undefined?undefined:structuredClone(x);
class MemoryStore {
 constructor(){this.campaigns=new Map();this.groups=new Map();this.media=new Map();this.jobs=new Map();this.rounds=new Map();this.settings=new Map();this.diagnostics=[];}
 getSetting(k,f){return this.settings.has(k)?this.settings.get(k):f;}
 getCampaign(id){return copy(this.campaigns.get(id));} listCampaigns(){return [...this.campaigns.values()].map(copy);} saveCampaign(c){this.campaigns.set(c.id,copy(c));return copy(c);}
 getGroup(id){return copy(this.groups.get(id));} getMedia(id){return copy(this.media.get(id));}
 insertRound(r){assert(!this.rounds.has(r.id));this.rounds.set(r.id,copy(r));} updateRound(id,p){this.rounds.set(id,{...this.rounds.get(id),...copy(p)});} listRounds(id){return [...this.rounds.values()].filter(r=>!id||r.campaignId===id).map(copy);}
 insertJob(j){assert(!this.jobs.has(j.id));assert(![...this.jobs.values()].some(x=>x.roundId===j.roundId&&x.campaignId===j.campaignId&&x.groupId===j.groupId&&x.itemId===j.itemId));this.jobs.set(j.id,copy(j));}
 updateJob(id,p){this.jobs.set(id,{...this.jobs.get(id),...copy(p)});} getJob(id){return copy(this.jobs.get(id));}
 listJobs(f={}){return [...this.jobs.values()].filter(j=>Object.entries(f).every(([k,v])=>k==='limit'||v===undefined||j[k]===v)).map(copy);} addDiagnostic(d){this.diagnostics.push(copy(d));}
 transaction(fn){return fn();}
}
function fixture({sender,items,count=2,changes={},timeoutMs=1000}={}){
 const store=new MemoryStore(),clock={now:Date.UTC(2026,9,8,12)},adapter=new EventEmitter(),calls=[],sleeps=[];
 adapter.status={state:'connected',mode:'simulated'};adapter.minimumSpacingSeconds=3;
 const groupIds=Array.from({length:count},(_,i)=>`g${i+1}`);for(const id of groupIds)store.groups.set(id,{id,name:`Grupo ${id}`,authorized:true,simulation:true});
 const campaign={id:'c1',name:'Campanha',state:'draft',mode:'repeat',intervalMinutes:10,spacingSeconds:3,groupIds,items:items||[{id:'i1',type:'text',text:'📱 Oferta\nR$ 2.999,00\nDetalhe na tela pequeno\n𝗣𝗮𝗹𝗮𝗰𝗲 𝗣𝗮𝗿𝗳𝘂𝗺'}],schedule:{days:[0,1,2,3,4,5,6],startTime:'00:00',endTime:'00:00'},...changes};store.saveCampaign(campaign);
 adapter.send=(groupId,item,media,options)=>{const job=store.listJobs().find(j=>j.messageId===item.clientMessageId);assert.equal(job.status,'sending');calls.push({groupId,item:copy(item),options,at:clock.now});return sender?sender({groupId,item,options,store,adapter,clock,calls}):Promise.resolve({status:'confirmed',messageId:item.clientMessageId});};
 const scheduler=new Scheduler({store,adapter,now:()=>clock.now,sleep:async ms=>{sleeps.push(ms);clock.now+=ms;},attemptTimeoutMs:timeoutMs});
 return{store,clock,adapter,calls,sleeps,scheduler,campaign};
}
const turn=()=>new Promise(resolve=>setImmediate(resolve));

test('uncertain item does not block remaining items/groups; same ambiguous item is excluded from future rounds',async()=>{
 const f=fixture({items:[{id:'i1',type:'text',text:'1'},{id:'i2',type:'text',text:'2'}],sender:({groupId,item})=>({status:groupId==='g1'&&item.id==='i1'?'uncertain':'confirmed',messageId:item.clientMessageId})});
 await f.scheduler.activate('c1');await f.scheduler.tick();
 assert.equal(f.calls.length,4);assert.equal(f.store.getCampaign('c1').state,'active');assert.equal(f.store.listJobs({status:'uncertain'}).length,1);assert.equal(f.store.listJobs({status:'accepted'}).length,3);assert.equal(f.store.listRounds('c1')[0].status,'completed');
 const next=f.store.getCampaign('c1').nextRunAt;assert.equal(next,Date.UTC(2026,9,8,12,10));f.clock.now=next-1;await f.scheduler.tick();assert.equal(f.calls.length,4,'uncertainty does not grant an off-grid extra round');f.clock.now=next;await f.scheduler.tick();assert.equal(f.calls.length,7);assert.deepEqual(f.calls.slice(4).map(x=>`${x.groupId}:${x.item.id}`),['g1:i2','g2:i1','g2:i2']);assert.equal(f.store.listJobs({status:'uncertain'})[0].attempts,1);
});

test('stalled campaign attempt releases worker on deadline; late accepted proof updates same job without resubmission',async()=>{
 let resolve;const f=fixture({timeoutMs:20,sender:({groupId,item})=>groupId==='g1'?new Promise(done=>{resolve=()=>done({status:'confirmed',messageId:item.clientMessageId});}):{status:'confirmed',messageId:item.clientMessageId}});
 await f.scheduler.activate('c1');await f.scheduler.tick();assert.equal(f.calls.length,2);assert.equal(f.scheduler.busy,false);assert.equal(f.calls[0].options.signal.aborted,true);
 const job=f.store.listJobs({status:'uncertain'})[0];assert.equal(job.errorCode,'SUBMISSION_TIMEOUT');assert.equal(job.attempts,1);resolve();await turn();assert.equal(f.store.getJob(job.id).status,'accepted');assert.equal(f.calls.length,2);assert.equal(f.store.listJobs().length,2);assert.equal(f.store.getJob(job.id).reconciled,true);
});

test('timeout fence prevents delayed pre-submit callback from sending after next task began',async()=>{
 let release,submitted=0;const f=fixture({timeoutMs:20,sender:({groupId,item,options})=>groupId==='g1'?new Promise((done,fail)=>{release=()=>{try{options.beforeSubmit();submitted++;done({status:'confirmed',messageId:item.clientMessageId});}catch(e){fail(e);}};}):{status:'confirmed',messageId:item.clientMessageId}});
 await f.scheduler.activate('c1');await f.scheduler.tick();release();await turn();assert.equal(submitted,0);assert.equal(f.calls.length,2);assert.equal(f.store.listJobs({status:'failed'}).length,1);
});

test('shared external queue releases a stalled search or alert and fences it before a later submission',async()=>{
 const f=fixture({timeoutMs:20});let late,lateSubmitted=0;
 const first=f.scheduler.runExternalSubmission(context=>new Promise((resolve,reject)=>{late=()=>{try{context.beforeSubmit();lateSubmitted++;resolve('late');}catch(error){reject(error);}}}));const rejected=assert.rejects(first,e=>e.code==='SUBMISSION_TIMEOUT'&&e.submitted==='unknown');
 const second=f.scheduler.runExternalSubmission(()=> 'next');await rejected;assert.equal(await second,'next');assert.equal(f.scheduler.submissionHolds,0);assert.equal(f.scheduler.externalInFlight,0);late();await turn();assert.equal(lateSubmitted,0);
});

test('late server acceptance and later delivery are separate evidence; old proof cannot downgrade delivery',async()=>{
 const f=fixture({sender:({item})=>({status:'uncertain',messageId:item.clientMessageId})});await f.scheduler.activate('c1');await f.scheduler.tick();const job=f.store.listJobs()[0];
 f.adapter.emit('receipt',{status:'confirmed',messageId:job.messageId,confirmationScope:'whatsapp-server'});assert.equal(f.store.getJob(job.id).status,'accepted');assert(!f.store.getJob(job.id).deliveredAt);
 f.adapter.emit('receipt',{status:'delivered',messageId:job.messageId,deliveredAt:f.clock.now});assert.equal(f.store.getJob(job.id).status,'delivered');f.adapter.emit('receipt',{status:'confirmed',messageId:job.messageId});assert.equal(f.store.getJob(job.id).status,'delivered');assert.equal(f.calls.length,2);
});

test('confirmed group restriction suspends only named destination, cancels its other items and processes the others',async()=>{
 const f=fixture({items:[{id:'i1',type:'text',text:'1'},{id:'i2',type:'text',text:'2'}]});f.adapter.getGroupPublishingStatus=async id=>id==='g1'?{available:false,canSend:false,code:'GROUP_ADMIN_ONLY',confirmed:true,temporary:false}:{available:true,canSend:true,confirmed:true};const events=[];f.scheduler.on('destinationFailure',e=>events.push(e));
 await f.scheduler.activate('c1');await f.scheduler.tick();assert.deepEqual(f.calls.map(x=>x.groupId),['g2','g2']);assert.equal(f.store.listJobs({status:'failed'}).length,1);assert.equal(f.store.listJobs({status:'cancelled'}).length,1);assert.equal(f.store.getCampaign('c1').state,'active');const health=f.store.getCampaign('c1').destinationHealth.g1;assert.equal(health.suspended,true);assert.equal(health.code,'GROUP_ADMIN_ONLY');assert.equal(events.length,1);assert.equal(events[0].groupId,'g1');assert.equal(events[0].connectionAvailable,true);
 const next=f.store.getCampaign('c1').nextRunAt;assert.equal(next,Date.UTC(2026,9,8,12,10));f.clock.now=next-1;await f.scheduler.tick();assert.equal(f.calls.length,2);f.clock.now=next;await f.scheduler.tick();assert.equal(f.calls.length,4);assert(f.calls.every(call=>call.groupId==='g2'));f.adapter.getGroupPublishingStatus=async()=>({available:true,canSend:true,confirmed:true});const checked=await f.scheduler.recheckDestination('c1','g1');assert.equal(checked.suspended,false);assert.equal(checked.code,'GROUP_AVAILABLE');assert.equal(checked.lastError.code,'GROUP_ADMIN_ONLY');assert(checked.lastError.reason.includes('administradores'));
});

test('confirmed temporary failures use bounded progressive delays and keep one durable message ID; other groups continue',async()=>{
 const f=fixture({sender:({groupId,item})=>{if(groupId==='g1')throw Object.assign(new Error('pre-submit'),{safeToRetry:true,submitted:false,code:'GROUP_METADATA_TEMPORARY',groupScoped:true});return {status:'confirmed',messageId:item.clientMessageId};}});await f.scheduler.activate('c1');await f.scheduler.tick();assert.deepEqual(f.calls.map(x=>x.groupId),['g1','g1','g1','g2']);assert.equal(new Set(f.calls.slice(0,3).map(x=>x.item.clientMessageId)).size,1);assert.equal(f.store.listJobs({status:'failed'})[0].attempts,3);assert(f.sleeps.includes(3000));assert(f.sleeps.includes(6000));assert.equal(f.store.listJobs({status:'accepted'}).length,1);assert.equal(f.store.getCampaign('c1').state,'active');
});

test('configured backoff factor controls progressive pre-submit retries and rejects an invalid factor before networking',async()=>{
 const f=fixture({changes:{retryPolicy:{maxAttempts:3,delaySeconds:3,backoffFactor:3}},sender:({groupId,item})=>{if(groupId==='g1')throw Object.assign(new Error('pre-submit'),{safeToRetry:true,submitted:false,code:'GROUP_METADATA_TEMPORARY',groupScoped:true});return{status:'confirmed',messageId:item.clientMessageId};}});await f.scheduler.activate('c1');await f.scheduler.tick();assert.deepEqual(f.sleeps.slice(0,2),[3000,9000]);assert.equal(f.store.listJobs({status:'failed'})[0].attempts,3);assert.equal(f.store.listJobs({status:'accepted'}).length,1);
 const invalid=fixture({changes:{retryPolicy:{maxAttempts:3,delaySeconds:3,backoffFactor:0}}});await assert.rejects(invalid.scheduler.activate('c1'),/fator progressivo/i);assert.equal(invalid.calls.length,0);
});

test('connection-wide failure pauses all campaigns and stops unstarted network requests',async()=>{
 const f=fixture({sender:({adapter,item})=>{adapter.status={...adapter.status,state:'disconnected'};adapter.emit('status',adapter.status);return{status:'uncertain',messageId:item.clientMessageId};}});await f.scheduler.activate('c1');await f.scheduler.tick();assert.equal(f.calls.length,1);assert.equal(f.store.getCampaign('c1').state,'paused');assert.equal(f.store.listJobs({status:'uncertain'}).length,1);assert.equal(f.store.listJobs({status:'queued'}).length,1,'unsubmitted work remains pending for safe recovery of its frozen round');assert.equal(f.store.listJobs({status:'cancelled'}).length,0);assert.equal(f.store.listJobs({status:'queued'})[0].attempts,0);assert.equal(f.store.listRounds('c1')[0].status,'interrupted');assert.equal(f.store.getCampaign('c1').destinationHealth,undefined);
});

test('a definitive group end date cancels only its unsent pending work and keeps another destination eligible',async()=>{
 const previous=process.env.TZ;process.env.TZ='UTC';try{
 const f=fixture({changes:{groupOverrides:{g1:{enabled:true,schedule:{startTime:'12:00',endTime:'13:00',endDate:'2026-10-08'}}}},sender:({groupId,item,clock})=>{if(groupId==='g1'){clock.now=Date.UTC(2026,9,8,12,59,59);throw Object.assign(new Error('temporary pre-submission failure'),{safeToRetry:true,submitted:false,code:'GROUP_METADATA_TEMPORARY',groupScoped:true});}return{status:'accepted',messageId:item.clientMessageId};}});f.clock.now=Date.UTC(2026,9,8,12,50);
 await f.scheduler.activate('c1');await f.scheduler.tick();assert.deepEqual(f.calls.map(call=>call.groupId),['g1','g2']);assert.equal(f.store.listJobs({status:'accepted'}).length,1);assert.equal(f.store.listJobs({status:'queued'}).length,0);const cancelled=f.store.listJobs({status:'cancelled'});assert.equal(cancelled.length,1);assert.equal(cancelled[0].groupId,'g1');assert.equal(cancelled[0].attempts,1);assert.equal(cancelled[0].errorCode,'CAMPAIGN_SCHEDULE_ENDED');assert.equal(f.store.getCampaign('c1').state,'active');assert.equal(f.store.getCampaign('c1').executionPendingRoundId,null);assert.equal(f.store.getCampaign('c1').nextRunAt,Date.UTC(2026,9,8,13,10));f.clock.now=f.store.getCampaign('c1').nextRunAt;await f.scheduler.tick();assert.deepEqual(f.calls.map(call=>call.groupId),['g1','g2','g2']);
 }finally{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});

test('round freezes edited content; newly captured item enters only next round; removed unstarted item is excluded',async()=>{
 const original='📱 iPhone 16 128GB\n🩷 ROSA\n🔋 92%\nR$ 2.999,00\nDetalhe na tela pequeno\n𝗣𝗮𝗹𝗮𝗰𝗲 𝗣𝗮𝗿𝗳𝘂𝗺';let edited=false;
 const f=fixture({items:[{id:'i1',type:'text',text:original},{id:'i2',type:'text',text:'Remover'}],sender:({store,item})=>{if(!edited){edited=true;store.saveCampaign({...store.getCampaign('c1'),items:[{id:'i1',type:'text',text:'Atualizado'},{id:'i3',type:'text',text:'Novo'}]});}return{status:'confirmed',messageId:item.clientMessageId};}});await f.scheduler.activate('c1');await f.scheduler.tick();assert.deepEqual(f.calls.map(x=>x.item.id),['i1','i1']);assert(f.calls.every(x=>x.item.text===original));assert.equal(f.store.listJobs({status:'cancelled'}).length,2);f.clock.now+=600000;await f.scheduler.tick();assert.deepEqual(f.calls.slice(2).map(x=>x.item.id),['i1','i3','i1','i3']);assert(f.calls.slice(2).filter(x=>x.item.id==='i1').every(x=>x.item.text==='Atualizado'));
});

test('separate message/group spacing, maximum rounds and endAt are enforced without overlap or backlog',async()=>{
 const f=fixture({items:[{id:'i1',type:'text',text:'1'},{id:'i2',type:'text',text:'2'}],changes:{messageSpacingSeconds:4,groupSpacingSeconds:9,maxRounds:1}});await f.scheduler.activate('c1');await f.scheduler.tick();assert.deepEqual(f.calls.map(x=>x.at-f.calls[0].at),[0,4000,13000,17000]);assert.equal(f.store.getCampaign('c1').state,'stopped');f.clock.now+=3600000;await f.scheduler.tick();assert.equal(f.calls.length,4);
 const g=fixture({changes:{endAt:Date.UTC(2026,9,8,12)+3000}});await g.scheduler.activate('c1');await g.scheduler.tick();assert.equal(g.calls.length,1);assert.equal(g.store.getCampaign('c1').state,'stopped');
});

test('reconciliation never submits; manual resend needs duplication acknowledgement and repeated clicks create one task',async()=>{
 const f=fixture({sender:({groupId,item,calls})=>({status:groupId==='g1'&&calls.length===1?'uncertain':'confirmed',messageId:item.clientMessageId})});f.adapter.reconcile=async id=>({status:'uncertain',messageId:id});await f.scheduler.activate('c1');await f.scheduler.tick();const original=f.store.listJobs({status:'uncertain'})[0];await assert.rejects(f.scheduler.retryUncertain(original.id),/duplicar/);assert.equal((await f.scheduler.reconcileJob(original.id)).status,'uncertain');assert.equal(f.calls.length,2);
 const a=f.scheduler.retryUncertain(original.id,{duplicateRiskAcknowledged:true,userId:'owner'}),b=f.scheduler.retryUncertain(original.id,{duplicateRiskAcknowledged:true,userId:'owner'});assert.equal(a,b);const retried=await a;assert.equal(retried.status,'accepted');assert.equal(f.calls.length,3);assert.notEqual(retried.messageId,original.messageId);assert.equal(retried.originalJobId,original.id);assert.equal(f.store.getJob(original.id).status,'uncertain');assert.equal(f.store.getJob(original.id).manualResendJobId,retried.id);await f.scheduler.retryUncertain(original.id,{duplicateRiskAcknowledged:true});assert.equal(f.calls.length,3);
});

test('known proof found before manual resend blocks any duplicate submission',async()=>{
 const f=fixture({sender:({item})=>({status:'uncertain',messageId:item.clientMessageId})});await f.scheduler.activate('c1');await f.scheduler.tick();const job=f.store.listJobs()[0];f.adapter.reconcile=async id=>({status:'confirmed',messageId:id,confirmationScope:'whatsapp-server'});await assert.rejects(f.scheduler.retryUncertain(job.id,{duplicateRiskAcknowledged:true}),/confirmação/);assert.equal(f.store.getJob(job.id).status,'accepted');assert.equal(f.calls.length,2);
});

test('restart retains accepted and uncertain ledger and cancels only never-submitted stale tasks',async()=>{
 const f=fixture();f.store.insertRound({id:'r-old',campaignId:'c1',startedAt:f.clock.now});for(const [id,status]of [['a','accepted'],['u','uncertain'],['s','sending'],['q','queued']])f.store.insertJob({id,roundId:'r-old',campaignId:'c1',groupId:'g1',itemId:id,status,attempts:status==='queued'?0:1,messageId:id});f.store.saveCampaign({...f.campaign,state:'active'});const recovered=new Scheduler({store:f.store,adapter:f.adapter,now:()=>f.clock.now,attemptTimeoutMs:20});assert.equal(f.store.getJob('a').status,'accepted');assert.equal(f.store.getJob('u').status,'uncertain');assert.equal(f.store.getJob('s').status,'uncertain');assert.equal(f.store.getJob('q').status,'cancelled');await recovered.tick();assert.equal(f.calls.length,0);assert.equal(f.store.getCampaign('c1').state,'paused');
});

test('an explicit negative integration response is a confirmed failure scoped to one destination, never an uncertain success',async()=>{
 const f=fixture({sender:({groupId,item,adapter})=>{if(groupId==='g1'){const proof={status:'failed',messageId:item.clientMessageId,confirmedFailure:true,groupScoped:true,destinationUnavailable:true,confirmed:true,code:'WA_GROUP_NOT_PARTICIPANT'};adapter.emit('receipt',proof);return proof;}return{status:'confirmed',messageId:item.clientMessageId};}});const events=[];f.scheduler.on('destinationFailure',e=>events.push(e));await f.scheduler.activate('c1');await f.scheduler.tick();assert.equal(f.calls.length,2);assert.equal(f.store.listJobs({status:'failed'}).length,1);assert.equal(f.store.listJobs({status:'accepted'}).length,1);assert.equal(events.length,1);assert.equal(events[0].code,'WA_GROUP_NOT_PARTICIPANT');assert(events[0].reason.includes('não participa'));assert.equal(f.store.getCampaign('c1').state,'active');
});

test('a delayed confirmed negative response resolves the original uncertainty without retrying and suspends only its group',async()=>{
 let resolve;const f=fixture({timeoutMs:20,sender:({groupId,item})=>groupId==='g1'?new Promise(done=>{resolve=()=>done({status:'failed',messageId:item.clientMessageId,confirmedFailure:true,groupScoped:true,destinationUnavailable:true,code:'WA_GROUP_ADMIN_ONLY',confirmed:true});}):{status:'confirmed',messageId:item.clientMessageId}});await f.scheduler.activate('c1');await f.scheduler.tick();const original=f.store.listJobs({status:'uncertain'})[0];resolve();await turn();assert.equal(f.store.getJob(original.id).status,'failed');assert.equal(f.store.getCampaign('c1').destinationHealth.g1.suspended,true);assert.equal(f.store.listJobs({status:'accepted'}).length,1);assert.equal(f.calls.length,2);
});

test('license expiration at the final boundary blocks all pending operations without misclassifying the group',async()=>{
 let expired=false;const f=fixture({sender:({options})=>{expired=true;options.beforeSubmit();throw new Error('must not submit');}});f.scheduler.licenseGuard=()=>{if(expired)throw Object.assign(new Error('Licença expirada.'),{code:'LICENSE_EXPIRED',submitted:false,definitive:true,safeToRetry:false});};await f.scheduler.activate('c1');await f.scheduler.tick();assert.equal(f.calls.length,1);assert.equal(f.store.getCampaign('c1').state,'paused');assert.equal(f.store.getCampaign('c1').destinationHealth,undefined);assert.equal(f.store.listJobs({status:'failed'}).length,1);assert.equal(f.store.listJobs({status:'cancelled'}).length,1);assert.equal(f.scheduler.persistenceFailed,false);
});

test('removing an item during preparation fences it at final submission without changing another frozen item',async()=>{
 let release,entered;const started=new Promise(done=>{entered=done;});let submitted=0;
 const f=fixture({items:[{id:'i1',type:'text',text:'Original'},{id:'i2',type:'text',text:'Preservado'}],sender:({item,options})=>item.id==='i1'?new Promise((done,fail)=>{entered();release=()=>{try{options.beforeSubmit();submitted++;done({status:'confirmed',messageId:item.clientMessageId});}catch(error){fail(error);}}}):{status:'confirmed',messageId:item.clientMessageId}});await f.scheduler.activate('c1');const run=f.scheduler.tick();await started;f.store.saveCampaign({...f.store.getCampaign('c1'),items:[{id:'i2',type:'text',text:'Editado para próxima rodada'}]});release();await run;assert.equal(submitted,0);assert.equal(f.store.listJobs({status:'cancelled'}).length,2);assert.deepEqual(f.calls.filter(x=>x.item.id==='i2').map(x=>x.item.text),['Preservado','Preservado']);assert.equal(f.store.getCampaign('c1').state,'active');
});

test('manual resend cannot publish an item removed from the campaign even after accepting the duplication warning',async()=>{
 const f=fixture({sender:({groupId,item})=>({status:groupId==='g1'?'uncertain':'confirmed',messageId:item.clientMessageId})});await f.scheduler.activate('c1');await f.scheduler.tick();const job=f.store.listJobs({status:'uncertain'})[0];f.store.saveCampaign({...f.store.getCampaign('c1'),items:[]});await assert.rejects(f.scheduler.retryUncertain(job.id,{duplicateRiskAcknowledged:true}),/retirado|pronto/i);assert.equal(f.calls.length,2);assert.equal(f.store.getJob(job.id).manualResendJobId,undefined);
});

test('positive publishing evidence is persisted for the dashboard and never automatically heals a suspended destination',async()=>{
 const f=fixture();let checks=0;
 f.adapter.getGroupPublishingStatus=async()=>{checks++;return{available:true,canSend:true,confirmed:true,checkedAt:f.clock.now};};
 await f.scheduler.activate('c1');await f.scheduler.tick();let health=f.store.getCampaign('c1').destinationHealth;
 assert.equal(health.g1.confirmed,true);assert.equal(health.g1.suspended,false);assert.equal(health.g1.code,'GROUP_AVAILABLE');assert.equal(health.g1.checkedAt,f.calls[0].at);assert.equal(checks,2);
 f.store.saveCampaign({...f.store.getCampaign('c1'),destinationHealth:{...health,g1:{...health.g1,suspended:true,code:'WA_GROUP_ADMIN_ONLY'}}});
 f.clock.now+=600000;await f.scheduler.tick();assert.equal(f.calls.length,3);assert.equal(f.store.getCampaign('c1').destinationHealth.g1.suspended,true);assert.equal(checks,3);
 await f.scheduler.recheckDestination('c1','g1');assert.equal(f.store.getCampaign('c1').destinationHealth.g1.suspended,false);assert.equal(f.calls.length,3);
});

test('a confirmed negative receipt racing an uncertain return or timeout keeps its final failure without blocking other groups',async()=>{
 const f=fixture({sender:({groupId,item,adapter})=>{if(groupId==='g1'){adapter.emit('receipt',{status:'failed',messageId:item.clientMessageId,confirmedFailure:true,groupScoped:true,code:'WA_GROUP_NOT_PARTICIPANT',confirmed:true});return{status:'uncertain',messageId:item.clientMessageId};}return{status:'confirmed',messageId:item.clientMessageId};}});
 await f.scheduler.activate('c1');await f.scheduler.tick();assert.equal(f.store.listJobs({status:'failed'}).length,1);assert.equal(f.store.listJobs({status:'uncertain'}).length,0);assert.equal(f.store.listJobs({status:'accepted'}).length,1);assert.equal(f.calls.length,2);assert.equal(f.store.getCampaign('c1').state,'active');
});

test('explicit Brasília schedules use original local hours rather than the Windows timezone',()=>{
 const {isWithinSchedule,nextScheduledAt}=require('../src/core/scheduler.cjs');const schedule={timezone:'America/Sao_Paulo',days:[0,1,2,3,4,5,6],startTime:'08:00',endTime:'18:00'};
 assert.equal(isWithinSchedule(Date.parse('2026-10-08T19:00:00Z'),schedule),true);assert.equal(isWithinSchedule(Date.parse('2026-10-08T22:00:00Z'),schedule),false);assert.equal(nextScheduledAt(Date.parse('2026-10-08T23:00:00Z'),schedule),Date.parse('2026-10-09T11:00:00Z'));
 assert.equal(isWithinSchedule(Date.parse('2026-10-09T01:30:00Z'),{...schedule,startTime:'00:00',endTime:'00:00',startDate:'2026-10-08',endDate:'2026-10-08'}),true);
});

test('zoned overnight weekday and date windows belong to the Brasília day on which they opened',()=>{
 const {isWithinSchedule,nextScheduledAt}=require('../src/core/scheduler.cjs');const schedule={timezone:'America/Sao_Paulo',days:[4],startTime:'22:00',endTime:'06:00',startDate:'2026-10-08',endDate:'2026-10-08'};
 assert.equal(isWithinSchedule(Date.parse('2026-10-09T04:00:00Z'),schedule),true);assert.equal(isWithinSchedule(Date.parse('2026-10-09T09:00:00Z'),schedule),false);assert.equal(nextScheduledAt(Date.parse('2026-10-08T20:00:00Z'),schedule),Date.parse('2026-10-09T01:00:00Z'));
});

test('source-managed campaigns execute in the computer timezone while retaining Brasília capture metadata',async()=>{
 const previous=process.env.TZ;process.env.TZ='UTC';try{
 const f=fixture({changes:{sourceManaged:true,sourceTimezone:'America/Sao_Paulo',schedule:{timezone:'America/Sao_Paulo',days:[0,1,2,3,4,5,6],startTime:'08:00',endTime:'18:00'}}});f.clock.now=Date.parse('2026-10-08T16:00:00Z');await f.scheduler.activate('c1');await f.scheduler.tick();assert.equal(f.calls.length,2);assert.equal(f.scheduler._groupConfig(f.store.getCampaign('c1'),'g1').schedule.timezone,undefined);assert.equal(f.store.getCampaign('c1').sourceTimezone,'America/Sao_Paulo');assert.equal(f.store.getCampaign('c1').schedule.timezone,'America/Sao_Paulo');assert.equal(f.store.getCampaign('c1').executionAuthorization.timezone,'UTC');
 f.clock.now=Date.parse('2026-10-08T19:00:00Z');await f.scheduler.tick();assert.equal(f.calls.length,2,'19:00 is outside the computer window even though it is 16:00 in Brasília');assert.equal(f.store.getCampaign('c1').nextRunAt,Date.parse('2026-10-09T08:00:00Z'));
 }finally{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});

test('source daily execution limits reset at computer midnight without changing original source dates',async()=>{
 const previous=process.env.TZ;process.env.TZ='UTC';try{
 const f=fixture({changes:{sourceManaged:true,sourceTimezone:'America/Sao_Paulo',dailyRoundLimit:1}});f.clock.now=Date.parse('2026-10-08T00:30:00Z');f.store.insertRound({id:'earlier-local-day',campaignId:'c1',startedAt:Date.parse('2026-10-07T23:00:00Z'),finishedAt:Date.parse('2026-10-07T23:00:00Z'),status:'completed'});
 await f.scheduler.activate('c1');await f.scheduler.tick();assert.equal(f.calls.length,2,'the previous UTC day does not consume the new computer day allowance');assert.equal(f.store.getCampaign('c1').sourceTimezone,'America/Sao_Paulo');assert.equal(f.store.getCampaign('c1').nextRunAt,Date.parse('2026-10-09T00:00:00Z'));f.clock.now=Date.parse('2026-10-08T00:40:00Z');await f.scheduler.tick();assert.equal(f.calls.length,2,'daily limit still prevents another round within the same computer day');f.clock.now=Date.parse('2026-10-09T00:00:00Z');await f.scheduler.tick();assert.equal(f.calls.length,4);
 }finally{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});
