'use strict';
// Independent regression: real SQLite/Scheduler/SearchService/AlertService,
// with an isolated simulated transport. This is not WhatsApp delivery evidence.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const core=process.env.KENNED_REVIEW_CODE_ROOT||path.resolve(__dirname,'..');
const {createStore,seed}=require(path.join(core,'src/core/store.cjs'));
const {Scheduler}=require(path.join(core,'src/core/scheduler.cjs'));
const {SearchService}=require(path.join(core,'src/core/search-service.cjs'));
const {AlertService}=require(path.join(core,'src/core/alerts.cjs'));
const {AuthService}=require(path.join(core,'src/core/auth.cjs'));
const {SimulatedAdapter}=require(path.join(core,'src/adapters/simulated.cjs'));
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
async function within(promise,label,ms=1500){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' ficou bloqueado entre a rodada e a fila privada.')),ms);})]);}finally{clearTimeout(timer);}}
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kcd-r5-private-campaign-review-'));
 const store=await createStore(dir);seed(store);const clock={at:new Date(2026,9,21,9,0).getTime()},events=[];
 const sleep=async ms=>{clock.at+=ms;};const auth=new AuthService({store,clock:()=>clock.at});
 const owner=(await auth.setupOwner({name:'Operador isolado',username:'r5-reviewer',phone:'5562999990001',password:'Senha-Review-R5-2026!'})).user;
 const adapter=new SimulatedAdapter({store,delayMs:0});await adapter.connect();
 const scheduler=new Scheduler({store,adapter,now:()=>clock.at,sleep});
 const searches=new SearchService({store,adapter,authService:auth,scheduler,now:()=>clock.at,sleep});
 const alerts=new AlertService({store,adapter,scheduler,now:()=>clock.at,sleep});
 searches.saveSettings({enabled:true,ownerRecipientUserId:owner.id},owner.id);await searches.flushDeliveries();
 const seedCampaign=store.listCampaigns()[0];const campaign=store.saveCampaign({...seedCampaign,groupIds:[seedCampaign.groupIds[0]],schedule:{days:[0,1,2,3,4,5,6],startTime:'00:00',endTime:'00:00'},spacingSeconds:3,messageSpacingSeconds:3,items:[1,2,3].map(n=>({id:'review-item-'+n,type:'text',text:'Conteúdo autorizado '+n}))});
 const entered=gate(),release=gate();let active=0,maximum=0;const sends={campaign:0,search:0,alert:0};
 const track=(kind,send)=>async(...args)=>{assert.equal(active++,0,'Transportes não podem se sobrepor.');maximum=Math.max(maximum,active);events.push(kind+':start');sends[kind]++;
  try{if(kind==='campaign'&&sends.campaign===1){entered.resolve();await release.promise;}const result=await send(...args);events.push(kind+':finish');return result;}finally{active--;}};
 adapter.send=track('campaign',adapter.send.bind(adapter));adapter.sendSearchText=track('search',adapter.sendSearchText.bind(adapter));adapter.sendPrivate=track('alert',adapter.sendPrivate.bind(adapter));
 t.after(async()=>{release.resolve();scheduler.setAutomationBlocked(true);await scheduler.stopAll();await Promise.allSettled([searches.shutdown(),alerts.shutdown()]);await scheduler.shutdown();await adapter.disconnect();store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const queueSearch=(id='r5-search')=>{store.saveSearchRun({id:id+'-run',actorId:owner.id,createdAt:clock.at,status:'completed'});store.saveSearchDelivery({id,runId:id+'-run',actorId:owner.id,target:owner.phone+'@s.whatsapp.net',text:'Resultado isolado '+id,clientMessageId:id.toUpperCase(),status:'pending',createdAt:clock.at});};
 const queueAlert=(id='r5-alert')=>store.saveAlert({id,number:owner.phone,text:'Aviso isolado',messageId:id.toUpperCase(),channel:'whatsapp',createdAt:clock.at,status:'pending'});
 return{store,adapter,scheduler,searches,alerts,campaign,clock,events,sends,entered,release,queueSearch,queueAlert,maximum:()=>maximum};
}

test('R5 independent: search and alert submitted during a running campaign do not deadlock or duplicate its immutable round',{timeout:10000},async t=>{
 const f=await fixture(t);await f.scheduler.activate(f.campaign.id);const running=f.scheduler.tick();await f.entered.promise;
 const firstRound=f.store.listRounds(f.campaign.id)[0].id;f.queueSearch();f.queueAlert();
 const search=f.searches.flushDeliveries(),alert=f.alerts.flush();await turn();f.release.resolve();
 await within(Promise.all([running,search,alert]),'Campanha, busca e alerta');
 assert.equal(f.sends.campaign,3);assert.equal(f.sends.search,1);assert.equal(f.sends.alert,1);assert.equal(f.maximum(),1);
 assert.equal(f.store.listRounds(f.campaign.id).length,1);assert.equal(f.store.listJobs({campaignId:f.campaign.id}).length,3);
 assert(f.store.listJobs({campaignId:f.campaign.id}).every(job=>job.roundId===firstRound&&job.status==='accepted'&&job.attempts===1));
 assert.equal(f.store.getSearchDelivery('r5-search').status,'confirmed');assert.equal(f.store.getAlert('r5-alert').status,'confirmed');
 assert.equal(f.scheduler.submissionHolds,0);assert.equal(f.scheduler.busy,false);
 assert(f.events.indexOf('search:start')>f.events.indexOf('campaign:finish'));
 assert(f.events.indexOf('search:start')<f.events.lastIndexOf('campaign:start'),'A busca não deve aguardar o término de toda a rodada.');
});

test('R5 independent: uncertainty of a private search releases the campaign and the queued alert without blind retry',{timeout:10000},async t=>{
 const f=await fixture(t);const original=f.adapter.sendSearchText.bind(f.adapter);let privateCalls=0;
 f.adapter.sendSearchText=async(...args)=>{privateCalls++;if(privateCalls===1){f.events.push('uncertain-search');return{status:'uncertain',messageId:args[2]?.clientMessageId};}return original(...args);};
 await f.scheduler.activate(f.campaign.id);const running=f.scheduler.tick();await f.entered.promise;f.queueSearch();f.queueAlert();
 const search=f.searches.flushDeliveries(),alert=f.alerts.flush();await turn();f.release.resolve();await within(Promise.all([running,search,alert]),'Resultado incerto');
 assert.equal(privateCalls,1);assert.equal(f.store.getSearchDelivery('r5-search').status,'uncertain');assert.equal(f.store.getSearchDelivery('r5-search').attempts,1);
 assert.equal(f.store.getAlert('r5-alert').status,'confirmed');assert.equal(f.sends.campaign,3);assert.equal(f.scheduler.submissionHolds,0);
 await f.searches.flushDeliveries();await f.alerts.flush();assert.equal(privateCalls,1,'Incerteza não autoriza novo envio automático.');
});

test('R5 independent: 209 observers of one rejected private pump produce one diagnostic, and a fresh rejection produces one more',{timeout:10000},async t=>{
 const f=await fixture(t),unhandled=[];const observe=error=>unhandled.push(error);process.on('unhandledRejection',observe);t.after(()=>process.off('unhandledRejection',observe));
 f.queueSearch('observer-review');f.scheduler.licenseGuard=()=>{throw Object.assign(new Error('Falha controlada antes da submissão.'),{code:'SUBMISSION_TIMEOUT',submitted:false});};
 for(let i=0;i<209;i++)f.searches._flushInBackground();const first=f.searches.deliveryPump;assert(first);await first.catch(()=>{});await turn();await turn();
 const errors=()=>f.store.queryEntities('diagnostics',{limit:500}).items.filter(row=>row.code==='SEARCH_DELIVERY_PUMP_ERROR');
 assert.equal(errors().length,1);assert.equal(f.sends.search,0);assert.equal(f.store.getSearchDelivery('observer-review').status,'pending');
 for(let i=0;i<209;i++)f.searches._flushInBackground();const second=f.searches.deliveryPump;assert(second);assert.notEqual(second,first);await second.catch(()=>{});await turn();await turn();
 assert.equal(errors().length,2);assert.deepEqual(unhandled,[]);assert.equal(f.scheduler.persistenceFailed,false);
});

test('R5 independent: 100 future deliveries cannot hide a later due private search',{timeout:10000},async t=>{
 const f=await fixture(t);for(let i=0;i<100;i++){const id='future-'+i;f.queueSearch(id);f.store.updateSearchDelivery(id,{nextAttemptAt:f.clock.at+3600000});}
 f.queueSearch('due-after-future-page');f.store.updateSearchDelivery('due-after-future-page',{createdAt:f.clock.at+1});
 await within(f.searches.flushDeliveries(),'Busca elegível depois de cem agendamentos futuros');
 assert.equal(f.sends.search,1);assert.equal(f.store.getSearchDelivery('due-after-future-page').status,'confirmed');
 for(let i=0;i<100;i++){const item=f.store.getSearchDelivery('future-'+i);assert.equal(item.status,'pending');assert.equal(item.attempts||0,0);}
 assert.equal(f.scheduler.submissionHolds,0);
});
