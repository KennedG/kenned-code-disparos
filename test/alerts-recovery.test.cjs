'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {AlertService}=require('../src/core/alerts.cjs');
const clone=value=>value===undefined?value:structuredClone(value);
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({at=Date.parse('2026-10-13T17:03:00Z'),settings={},campaigns=[{id:'campaign',name:'Lista da loja',state:'active'}],initialState='connected'}={}){
 const records=new Map(),preferences=new Map(Object.entries(settings)),scheduled=new Map(),calls=[],local=[],recoveries=[],resolved=[];
 const clock={at},campaignMap=new Map(campaigns.map(c=>[c.id,clone(c)]));let timerId=0;
 const store={getSetting:(id,fallback)=>clone(preferences.has(id)?preferences.get(id):fallback),setSetting:(id,value)=>{preferences.set(id,clone(value));return clone(value);},listCampaigns:()=>[...campaignMap.values()].map(clone),getCampaign:id=>clone(campaignMap.get(id)),saveCampaign:c=>{campaignMap.set(c.id,clone(c));return clone(c);},listJobs:()=>[{id:'pending',status:'queued'},{id:'accepted',status:'accepted'},{id:'unknown',status:'uncertain'}],listEntities:table=>[...(records.get(table)?.values()||[])].map(clone),getEntity:(table,id)=>clone(records.get(table)?.get(id)),saveEntity:(table,row)=>{if(!records.has(table))records.set(table,new Map());records.get(table).set(row.id,clone(row));return clone(row);},addDiagnostic:row=>store.saveEntity('diagnostics',row),addAudit:row=>store.saveEntity('audit',row)};
 store.saveEntity('alert_recipients',{id:'responsible',name:'Responsável autorizado',phone:'5511999999999',enabled:true});
 const adapter=new EventEmitter();adapter.status={state:initialState,mode:'simulated'};adapter.minimumSpacingSeconds=3;adapter.getConnectionReadiness=()=>({ready:adapter.status.state==='connected'&&adapter.status.ready!==false});adapter.sendPrivate=async(number,text,options)=>{options.beforeSubmit?.();calls.push({number,text,options,at:clock.at});return {status:'accepted',messageId:options.clientMessageId,confirmationScope:'whatsapp-server'};};
 const scheduler=new EventEmitter();scheduler.waitForIdle=async()=>{};scheduler.holdSubmissions=()=>()=>{};scheduler.resume=async()=>{throw new Error('Legacy resume must never run.');};scheduler.recoverAfterConnection=async payload=>{recoveries.push(payload);return {recovered:[],skipped:[]};};scheduler.blockOnPersistenceFailure=()=>{scheduler.persistenceFailed=true;};
 const service=new AlertService({store,adapter,scheduler,now:()=>clock.at,sleep:async ms=>{clock.at+=ms;},setTimer:(fn,ms)=>{const key=++timerId;scheduled.set(key,{fn,ms});return key;},clearTimer:key=>scheduled.delete(key)});
 service.on('localAlert',n=>local.push(clone(n)));service.on('resolved',r=>resolved.push(clone(r)));
 const status=async value=>{adapter.status={mode:'simulated',...value};adapter.emit('status',adapter.status);await settle();};
 return {store,adapter,scheduler,service,clock,scheduled,calls,local,recoveries,resolved,preferences,records,status};
}

test('technical disconnect creates one durable campaign incident and resolves only when the authenticated session is ready',async t=>{
 const f=fixture();t.after(()=>f.service.shutdown());f.service.start();
 await f.status({state:'disconnected',reasonCode:'internet',retryable:true,at:f.clock.at});
 await f.status({state:'disconnected',reasonCode:'internet',retryable:true,at:f.clock.at});
 assert.equal(f.local.length,1);assert.equal(f.local[0].persistentAlarm,true);assert.equal(f.local[0].bringToFront,true);assert.equal(f.local[0].active,true);assert.deepEqual(f.local[0].affectedCampaigns.map(c=>[c.id,c.pending]),[['campaign',2]]);
 const originalAt=f.clock.at,incident=f.service.getRecoveryState().incident;
 assert.equal(f.calls.length,0);assert.equal(f.store.listEntities('alerts')[0].status,'pending');
 await f.status({state:'connected',ready:false});assert.equal(f.resolved.length,0);assert.equal(f.recoveries.length,0);assert.equal(f.calls.length,0);
 f.clock.at+=4*60000;await f.status({state:'connected',ready:true});await f.service.flush();
 assert.equal(f.recoveries.length,1);assert.deepEqual(f.recoveries[0],{reason:'reconnected'});assert.equal(f.calls.length,1);
 const alert=f.store.listEntities('alerts')[0];assert.equal(alert.originalAt,originalAt);assert.equal(alert.recoveredAt,f.clock.at);assert.equal(alert.status,'confirmed');assert.equal(alert.deliveredAt,undefined);assert.match(f.calls[0].text,/Ocorrência original/);assert.match(f.calls[0].text,/Conexão recuperada/);assert.match(f.calls[0].text,/Lista da loja — 2 mensagens pendentes/);
 assert.equal(f.resolved.length,1);assert.equal(f.resolved[0].occurrenceId,incident.id);assert.equal(f.store.getEntity('notifications',f.local[0].id).active,false);
});

test('automatic reconnect uses the existing session, progressive capped delays and a finite attempt count',async t=>{
 const f=fixture({settings:{reconnect:{enabled:true,maxAttempts:4,delaySeconds:3,maxDelaySeconds:10,autoResume:true}}});t.after(()=>f.service.shutdown());f.service.start();let attempts=0;
 f.adapter.connect=async options=>{assert.equal(options.reconnect,true);attempts++;throw Object.assign(new Error('Rede indisponível.'),{code:'WA_NETWORK'});};
 await f.status({state:'disconnected',reasonCode:'internet',retryable:true});
 for(const expected of [3000,6000,10000,10000]){const [key,timer]=f.scheduled.entries().next().value;assert.equal(timer.ms,expected);f.scheduled.delete(key);timer.fn();await settle();}
 assert.equal(attempts,4);assert.equal(f.scheduled.size,0);assert.equal(f.service.getRecoveryState().attempts,4);assert.equal(f.service.getRecoveryState().nextAttemptAt,null);
});

test('manual disconnect cancels the timer and survives restart without automatic socket creation',async t=>{
 const f=fixture();f.service.start();await f.status({state:'disconnected',reasonCode:'internet',retryable:true});assert.equal(f.scheduled.size,1);
 await f.status({state:'disconnected',reasonCode:'manual',manual:true});assert.equal(f.scheduled.size,0);assert.equal(f.preferences.get('manualDisconnect:simulated'),true);await f.service.shutdown();
 let attempts=0;f.adapter.connect=async()=>{attempts++;};const restored=new AlertService({store:f.store,adapter:f.adapter,scheduler:f.scheduler,setTimer:()=>{throw new Error('Manual reconnect must not be scheduled.');},now:()=>f.clock.at});t.after(()=>restored.shutdown());restored.start();await settle();assert.equal(attempts,0);assert.equal(restored.getRecoveryState().manual,true);
 await restored.reconnect();assert.equal(attempts,1);assert.equal(restored.getRecoveryState().manual,false);
});

test('a paused campaign is included after scheduler technical-pause ordering, but a manual pause is excluded',async t=>{
 const f=fixture({campaigns:[{id:'technical',name:'Rodada interrompida',state:'paused',executionRecovery:{kind:'connection'}},{id:'manual',name:'Não retomar',state:'paused',pauseReason:'Pausada manualmente.'},{id:'draft',name:'Não iniciada',state:'draft'}]});t.after(()=>f.service.shutdown());f.service.start();
 await f.status({state:'disconnected',reasonCode:'unexpected'});assert.deepEqual(f.service.getRecoveryState().incident.affectedCampaigns.map(c=>c.id),['technical']);
});

test('QR-required is notified once, stops automatic socket attempts and remains pending until ready',async t=>{
 const f=fixture();t.after(()=>f.service.shutdown());f.service.start();await f.status({state:'disconnected',reasonCode:'unexpected',retryable:true});await f.status({state:'qr'});await f.status({state:'qr'});
 assert.equal(f.local.filter(n=>n.event==='qr-required').length,1);assert.equal(f.scheduled.size,0);assert.equal(f.calls.length,0);assert.equal(f.local.filter(n=>n.bringToFront).length,1);
 await f.status({state:'connected'});await f.service.flush();assert.equal(f.calls.length,2);assert(f.calls.some(c=>/QR Code necessária/.test(c.text)));assert(f.store.listEntities('notifications').every(n=>n.resolvedAt));
});

test('muting remains durable and resolving the error preserves the visual history',async t=>{
 const f=fixture();t.after(()=>f.service.shutdown());f.service.start();await f.status({state:'disconnected',reasonCode:'internet',retryable:true});const notice=f.local[0];
 f.service.muteOccurrence(notice.id);assert.equal(f.store.getEntity('notifications',notice.id).muted,true);assert.equal(f.store.getEntity('notifications',notice.id).active,true);
 await f.status({state:'connected'});assert.equal(f.store.getEntity('notifications',notice.id).active,false);assert.equal(f.store.getEntity('notifications',notice.id).muted,true);assert.equal(f.store.listEntities('notifications').length,1);
 await f.status({state:'disconnected',reasonCode:'internet',retryable:true});assert.equal(f.local.length,2);assert.notEqual(f.local[1].occurrenceId,notice.occurrenceId);assert.equal(f.local[1].muted,false);
});

test('automation stop suppresses reconnection recovery and private alerts while keeping the local incident visible',async t=>{
 const f=fixture();f.service.isAutomationStopped=()=>true;t.after(()=>f.service.shutdown());f.service.start();await f.status({state:'disconnected',reasonCode:'unexpected',retryable:true});assert.equal(f.local.length,1);assert.equal(f.scheduled.size,0);assert.equal(f.store.listEntities('alerts').length,0);await f.status({state:'connected'});assert.equal(f.recoveries.length,0);assert.equal(f.calls.length,0);
});

test('a disconnect incident and pending alert survive restart, restore an unsilenced alarm once and do not duplicate the private queue',async t=>{
 const f=fixture();f.service.start();await f.status({state:'disconnected',reasonCode:'internet',retryable:true});const id=f.service.getRecoveryState().incident.id;await f.service.shutdown();
 const restored=new AlertService({store:f.store,scheduler:f.scheduler,adapter:f.adapter,now:()=>f.clock.at,sleep:async()=>{}}),restoredLocal=[];restored.on('localAlert',n=>restoredLocal.push(n));t.after(()=>restored.shutdown());restored.start();assert.equal(restoredLocal.length,1);assert.equal(restoredLocal[0].occurrenceId,id);assert.equal(restored.getRecoveryState().incident.id,id);assert.equal(f.store.listEntities('alerts').length,1);
 restored.muteOccurrence(id);f.adapter.status={state:'connected',mode:'simulated'};f.adapter.emit('status',f.adapter.status);await settle();await restored.flush();assert.equal(f.calls.length,1);assert.equal(f.store.listEntities('alerts').length,1);assert.equal(f.store.listEntities('notifications')[0].muted,true);
});

test('changing integration mode ends the old active alarm and keeps its private alert in its original mode',async t=>{
 const f=fixture();t.after(()=>f.service.shutdown());f.service.start();await f.status({state:'disconnected',reasonCode:'internet',retryable:true});const notification=f.local[0];
 const realAdapter=new EventEmitter();realAdapter.status={state:'disconnected',mode:'whatsapp'};realAdapter.sendPrivate=async()=>{throw new Error('No cross-mode send.');};f.service.setAdapter(realAdapter);await f.service.flush();
 assert.equal(f.store.getEntity('notifications',notification.id).active,false);assert.equal(f.resolved.length,1);assert.equal(f.calls.length,0);assert.equal(f.store.listEntities('alerts')[0].integrationMode,'simulated');assert.equal(f.store.listEntities('alerts')[0].status,'pending');
});
