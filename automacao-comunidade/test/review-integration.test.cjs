'use strict';
// Independent cross-module audit. All transports and identities are controlled fixtures.
// These tests do not establish WhatsApp delivery or Windows DPAPI behavior.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createStore } = require('../src/core/store.cjs');
const { InviteQueue } = require('../src/core/queue.cjs');
const { validateCampaign } = require('../src/core/models.cjs');
const { createService } = require('../src/backend/service.cjs');
const { WhatsAppAdapter } = require('../src/adapters/whatsapp.cjs');
const GROUP='123-456@g.us';
const PN='15555550101';
const LINK='https://chat.whatsapp.com/CONTROLLEDTESTINVITECODE';
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'community-independent-review-'));
  const store=createStore(dir);
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  store.replaceGroups([{id:GROUP,name:'Grupo controlado de teste'}]);
  store.importParticipants(GROUP,[{externalId:`${PN}@s.whatsapp.net`,identifiers:[`${PN}@s.whatsapp.net`],phone:PN,name:'Contato de teste'}]);
  return {dir,store,contact:store.listAll('contacts')[0]};
}
function authorized(store,contact){return store.save('contacts',{...contact,authorized:true,authorizedAt:1000,consentNote:'Autorização explícita em ambiente controlado.'});}
function campaign(store,id='campaign',overrides={}){
  return store.save('campaigns',validateCampaign({id,name:'Convite de teste',groupIds:[GROUP],message:'Olá {nome}! {link_comunidade}',communityLink:LINK,intervalValue:30,intervalUnit:'seconds',...overrides}));
}
class ControlledTransport extends EventEmitter{
  constructor(){super();this.status={state:'connected',ready:true};this.minimumSpacingMs=3000;this.sent=[];}
  async sendInvite(contact,text,{clientMessageId,beforeSubmit}){await beforeSubmit();this.sent.push({contact,text,clientMessageId});return {status:'accepted',messageId:clientMessageId,confirmationScope:'controlled-only'};}
  async reconcile(messageId){return {status:'uncertain',messageId};}
}

test('review: group membership never grants consent and repeat mode still excludes blocked contacts',async t=>{
  const {store,contact}=fixture(t),transport=new ControlledTransport(),queue=new InviteQueue({store,adapter:transport,autoTick:false});
  const c=campaign(store);
  assert.equal(queue.preview(c).total,0);
  assert.match(queue.preview(c).excluded[0].reason,/autorizado/i);
  authorized(store,contact);
  assert.equal(queue.preview(c).total,1);
  store.save('contacts',{...store.get('contacts',contact.id),blocked:true});
  assert.equal(queue.preview({...c,mode:'all'}).total,0);
});

test('review: global ledger excludes accepted and uncertain contacts in another campaign and after visual history removal',async t=>{
  const {store,contact}=fixture(t);authorized(store,contact);
  const queue=new InviteQueue({store,adapter:new ControlledTransport(),autoTick:false});
  campaign(store,'one');const two=campaign(store,'two',{message:'Outro texto {link_comunidade}'});
  store.markRecipient(contact,'previous','accepted',{messageId:'CONTROLLED-PROOF'});
  store.save('history',{id:'visual-only',status:'accepted'});store.remove('history','visual-only');
  assert.equal(queue.preview(two).total,0);
  assert.equal(queue.preview({...two,mode:'all'}).total,1);
  store.markRecipient(contact,'other-uncertain','uncertain');
  assert.equal(queue.preview({...two,mode:'all'}).total,0);
});

test('review: simultaneous activations reserve one persistent recipient and repeated activation key is idempotent',async t=>{
  const {store,contact}=fixture(t);authorized(store,contact);campaign(store,'one');campaign(store,'two');
  const queue=new InviteQueue({store,adapter:new ControlledTransport(),autoTick:false});
  const results=await Promise.allSettled([queue.activate('one',{activationKey:'request-one'}),queue.activate('two',{activationKey:'request-two'})]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  const first=results.find(x=>x.status==='fulfilled').value;
  const again=await queue.activate(first.campaignId,{activationKey:first.activationKey});
  assert.equal(again.id,first.id);assert.equal(store.count('jobs'),1);assert.equal(store.ledger(contact).activeJobId,store.listAll('jobs')[0].id);
});

test('review: stop during asynchronous identity lookup prevents transport submission',async t=>{
  const {store,contact}=fixture(t);authorized(store,contact);campaign(store);
  let release,entered;const started=new Promise(resolve=>{entered=resolve;});
  const transport=new ControlledTransport();
  transport.sendInvite=async(c,text,options)=>{entered();await new Promise(resolve=>{release=resolve;});await options.beforeSubmit();transport.sent.push(c);return {status:'accepted',messageId:options.clientMessageId};};
  const queue=new InviteQueue({store,adapter:transport,autoTick:false});
  await queue.activate('campaign',{activationKey:'guard-stop'});
  const pending=queue.tick();await started;await queue.stopAll();release();await pending;
  assert.equal(transport.sent.length,0);assert.equal(store.listAll('jobs')[0].status,'cancelled');assert.equal(queue.getState().automationStopped,true);
});

test('review: a reconnect during recipient lookup must apply the full recovery interval before submit',async t=>{
  const {store,contact}=fixture(t);authorized(store,contact);campaign(store);
  let clock=Date.now(),release,entered;const started=new Promise(resolve=>{entered=resolve;});
  const transport=new ControlledTransport();
  transport.sendInvite=async(c,text,options)=>{entered();await new Promise(resolve=>{release=resolve;});await options.beforeSubmit();transport.sent.push(c);return {status:'accepted',messageId:options.clientMessageId};};
  const queue=new InviteQueue({store,adapter:transport,autoTick:false,now:()=>clock});
  await queue.activate('campaign',{activationKey:'guard-reconnect'});
  const pending=queue.tick();await started;
  transport.status={state:'disconnected',ready:false};transport.emit('status',transport.status);clock+=1000;
  transport.status={state:'connected',ready:true};transport.emit('status',transport.status);release();await pending;
  assert.equal(transport.sent.length,0,'reconnect during lookup must not bypass latest nextEligibleAt');
  assert.equal(store.listAll('jobs')[0].status,'pending');
});

test('review: increasing the interval while resolving a recipient applies to that upcoming send',async t=>{
  const {store,contact}=fixture(t);authorized(store,contact);campaign(store);
  const at=Date.now();store.setSetting('queueState',{lastCompletedAt:at-31000,automationStopped:false});
  let release,entered;const started=new Promise(resolve=>{entered=resolve;});const transport=new ControlledTransport();
  transport.sendInvite=async(c,text,options)=>{entered();await new Promise(resolve=>{release=resolve;});await options.beforeSubmit();transport.sent.push(c);return {status:'accepted',messageId:options.clientMessageId};};
  const queue=new InviteQueue({store,adapter:transport,autoTick:false,now:()=>at});await queue.activate('campaign',{activationKey:'guard-interval'});
  const pending=queue.tick();await started;
  store.save('campaigns',{...store.get('campaigns','campaign'),intervalValue:60,intervalMs:60000});release();await pending;
  assert.equal(transport.sent.length,0,'current interval must be rechecked after asynchronous recipient lookup');
  assert.equal(store.listAll('jobs')[0].status,'pending');
});

test('review: restoring an older backup cannot erase later invitation proof or a later opt-out',t=>{
  const {dir,store,contact}=fixture(t);authorized(store,contact);
  const backup=path.join(dir,'earlier.sqlite');store.backupTo(backup);
  store.markRecipient(contact,'proof-after-backup','accepted',{messageId:'POST-BACKUP-ACK'});
  store.save('contacts',{...store.get('contacts',contact.id),optOut:true,authorized:false});
  store.restoreFrom(backup);
  assert.equal(store.isPreviouslyInvited(store.get('contacts',contact.id)),true,'restoring old data must not reopen new-only eligibility');
  assert.equal(store.get('contacts',contact.id).optOut,true,'later opt-out must not be undone by restoring an older backup');
  assert.equal(store.getSetting('queueState',{}).automationStopped,true,'the actual queueState setting must keep restored automations stopped');
});

async function serviceFixture(t, host = async()=>null){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'community-review-service-'));let controlled;
  class BackendTransport extends ControlledTransport{
    constructor({store}){super();this.store=store;this.status={state:'disconnected',ready:false,mode:'whatsapp'};}
    async connect(){this.status={state:'connected',ready:true,mode:'whatsapp'};this.emit('status',this.status);return this.status;}
    async disconnect(){this.status={state:'disconnected',ready:false,mode:'whatsapp'};this.emit('status',this.status);return this.status;}
    async listGroups(){return [{id:GROUP,name:'Grupo controlado'}];}
    async listParticipants(){return [{externalId:`${PN}@s.whatsapp.net`,identifiers:[`${PN}@s.whatsapp.net`],phone:PN,name:'Nome antes'}];}
  }
  const svc=await createService({dir,host,adapterFactory:opts=>(controlled=new BackendTransport(opts))});
  t.after(async()=>{await svc.shutdown();fs.rmSync(dir,{recursive:true,force:true});});
  await svc.call('saveSettings',{settings:{unofficialAcknowledged:true}});await svc.call('connect');await svc.call('refreshParticipants',{groupId:GROUP});
  const person=(await svc.call('listContacts')).items[0];await svc.call('updateContact',{id:person.id,changes:{authorized:true,consentNote:'Autorizado em teste controlado.'}});
  return {svc,transport:controlled,contact:person,dir};
}

test('review: changing a personalized name invalidates a preview instead of sending unseen text',async t=>{
  const {svc,contact}=await serviceFixture(t);
  const c=await svc.call('saveCampaign',{campaign:{name:'Personalizada',groupIds:[GROUP],communityLink:LINK,message:'Olá {nome}! {link_comunidade}'}});
  const preview=await svc.call('previewCampaign',{id:c.id});assert.match(preview.recipients[0].text,/Nome antes/);
  await svc.call('updateContact',{id:contact.id,changes:{name:'Nome depois'}});
  await assert.rejects(svc.call('activateCampaign',{id:c.id,previewToken:preview.previewToken}),{code:'PREVIEW_CHANGED'});
  assert.equal((await svc.call('listRuns')).total,0);
});

test('review: trusted private opt-out emitted by the real adapter reaches the backend',async t=>{
  const {svc,contact,transport}=await serviceFixture(t);
  // Exercise the actual WhatsApp extraction path without using the network.
  const adapter=new WhatsAppAdapter({store:transport.store,credentialsDir:path.join(os.tmpdir(),'unused-community-audit-auth')});
  const socket={user:{id:'15555550999@s.whatsapp.net'},signalRepository:{lidMapping:{getPNForLID:async()=>null}}};
  adapter.socket=socket;adapter.generation=1;adapter.on('incoming',event=>transport.emit('incoming',event));
  await adapter._incoming({key:{id:'CONTROLLED-OPT-OUT',remoteJid:`${PN}@s.whatsapp.net`,fromMe:false},message:{conversation:'Não quero receber'},pushName:'Nome antes'},socket,1);
  await wait(0);
  const after=(await svc.call('listContacts')).items.find(c=>c.id===contact.id);
  assert.equal(after.optOut,true,'trusted WhatsApp incoming event must reach the backend opt-out handler');assert.equal(after.authorized,false);
});


test('review: native short suspend blocks work and resume waits a complete interval',async t=>{
  const {store,contact}=fixture(t);authorized(store,contact);campaign(store);
  let clock=Date.now();const transport=new ControlledTransport(),queue=new InviteQueue({store,adapter:transport,autoTick:false,now:()=>clock});
  assert.equal(typeof queue.pauseForSuspend,'function','native suspend hook must exist');
  assert.equal(typeof queue.onResume,'function','native resume hook must exist');
  await queue.activate('campaign',{activationKey:'short-suspend'});
  await queue.pauseForSuspend();clock+=1000;await queue.tick();assert.equal(transport.sent.length,0);
  await queue.onResume();clock+=29999;await queue.tick();assert.equal(transport.sent.length,0);
  clock+=1;await queue.tick();assert.equal(transport.sent.length,1);
});

test('review: a send starting while the restore file dialog is open prevents database replacement',async t=>{
  let selectBackup,dialogOpened;
  const dialogStarted=new Promise(resolve=>{dialogOpened=resolve;});
  const host=async action=>{if(action==='dialogs.openBackup'){dialogOpened();return new Promise(resolve=>{selectBackup=resolve;});}return null;};
  const {svc,transport,dir}=await serviceFixture(t,host);
  const c=await svc.call('saveCampaign',{campaign:{name:'Restauracao concorrente',groupIds:[GROUP],communityLink:LINK,message:'Olá {nome}! {link_comunidade}'}});
  const backup=path.join(dir,'before-activation.sqlite');transport.store.backupTo(backup);
  let releaseSend,sendStarted;
  const sending=new Promise(resolve=>{sendStarted=resolve;});
  transport.sendInvite=async(contact,text,options)=>{await options.beforeSubmit();sendStarted();await new Promise(resolve=>{releaseSend=resolve;});return {status:'accepted',messageId:options.clientMessageId,confirmationScope:'controlled-only'};};
  const preview=await svc.call('previewCampaign',{id:c.id});await svc.call('activateCampaign',{id:c.id,previewToken:preview.previewToken});
  const restoring=svc.call('restore',{confirmation:'RESTAURAR'});
  await dialogStarted;
  await Promise.race([sending,wait(2500).then(()=>{throw new Error('Controlled send did not start during restore dialog');})]);
  selectBackup(backup);
  try {await assert.rejects(restoring,/envio em andamento|aguarde.*envio/i);assert.equal((await svc.call('listRuns')).total,1,'existing run cannot be erased while its transport is still submitting');}
  finally {releaseSend();await wait(0);}
});

test('review: restoring an older backup does not undo an explicit later authorization revocation',t=>{
  const {dir,store,contact}=fixture(t);authorized(store,contact);
  const backup=path.join(dir,'before-revocation.sqlite');store.backupTo(backup);
  store.save('contacts',{...store.get('contacts',contact.id),authorized:false,authorizationRevokedAt:Date.now()});
  store.restoreFrom(backup);
  assert.equal(store.get('contacts',contact.id).authorized,false,'restore must not revive a consent explicitly revoked after the backup');
});

test('review: restoring a backup with a different saved mode keeps storage and adapter consistent',async t=>{
  const {SimulatedAdapter}=require('../src/adapters/simulated.cjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'community-review-restore-mode-'));
  const backup=path.join(dir,'real-mode.sqlite');
  class RealControlledAdapter extends ControlledTransport{
    constructor({store}){super();this.store=store;this.status={state:'disconnected',ready:false,mode:'whatsapp'};}
    async connect(){this.status={state:'connected',ready:true,mode:'whatsapp'};this.emit('status',this.status);return this.status;}
    async disconnect(){this.status={state:'disconnected',ready:false,mode:'whatsapp'};this.emit('status',this.status);return this.status;}
    async listGroups(){return [{id:GROUP,name:'Grupo real controlado'}];}
  }
  const svc=await createService({dir,host:async action=>action==='dialogs.saveBackup'||action==='dialogs.openBackup'?backup:null,adapterFactory:opts=>opts.mode==='simulated'?new SimulatedAdapter(opts):new RealControlledAdapter(opts)});
  t.after(async()=>{await svc.shutdown();fs.rmSync(dir,{recursive:true,force:true});});
  await svc.call('backup');
  await svc.call('saveSettings',{settings:{integrationMode:'simulated'}});await svc.call('testSimulation');
  assert.equal((await svc.call('snapshot')).connection.mode,'simulated');
  await svc.call('restore',{confirmation:'RESTAURAR'});
  const snapshot=await svc.call('snapshot');
  assert.equal(snapshot.connection.mode,snapshot.mode,'restored storage mode and active transport must always agree');
  if(snapshot.mode==='whatsapp'){
    await svc.call('saveSettings',{settings:{unofficialAcknowledged:true}});await svc.call('connect');
    const groups=await svc.call('refreshGroups');assert.equal(groups.some(g=>String(g.id).endsWith('@simulation')),false,'a restored real environment must never persist simulated groups from an old adapter');
  }
});

test('review: restored pending jobs remain pending and paused instead of being cancelled',async t=>{
  let backup;
  const {svc,transport,dir}=await serviceFixture(t,async action=>action==='dialogs.openBackup'?backup:null);
  await svc.call('disconnect');
  const c=await svc.call('saveCampaign',{campaign:{name:'Pendentes recuperáveis',groupIds:[GROUP],communityLink:LINK,message:'Olá {nome}! {link_comunidade}'}});
  const preview=await svc.call('previewCampaign',{id:c.id});await svc.call('activateCampaign',{id:c.id,previewToken:preview.previewToken});
  backup=path.join(dir,'pending.sqlite');transport.store.backupTo(backup);
  await svc.call('restore',{confirmation:'RESTAURAR'});
  const snapshot=await svc.call('snapshot');
  assert.equal(snapshot.queue.automationStopped,true);assert.equal(snapshot.metrics.pending,1,'restored pending job must be available for explicit resumption');
  const runs=await svc.call('listRuns');assert.equal(runs.items[0].status,'paused');
  const pendingJob=transport.store.listAll('jobs',{status:'pending'})[0];
  const pendingContact=transport.store.get('contacts',pendingJob.contactId);
  assert.equal(transport.store.ledger(pendingContact).activeJobId,pendingJob.id,'restored pending job must retain its recipient reservation for explicit resumption');
});

test('review: empty contact filters retain every contact across pages beyond 200',async t=>{
  const {svc,transport}=await serviceFixture(t);
  const participants=Array.from({length:245},(_,index)=>{
    const number=`1555555${String(index+1000).padStart(4,'0')}`;
    return {externalId:`${number}@s.whatsapp.net`,identifiers:[`${number}@s.whatsapp.net`],phone:number,name:`Pessoa de teste ${String(index).padStart(3,'0')}`};
  });
  transport.store.importParticipants(GROUP,participants);
  const first=await svc.call('listContacts',{groupId:'',status:'',search:'',limit:200,offset:0});
  const second=await svc.call('listContacts',{groupId:'',status:'',search:'',limit:200,offset:200});
  assert.equal(first.total,246);assert.equal(second.total,246);assert.equal(first.items.length,200);assert.equal(second.items.length,46);
  assert.equal(first.limit,200);assert.equal(second.offset,200);
  const ids=new Set([...first.items,...second.items].map(contact=>contact.id));
  assert.equal(ids.size,246,'pagination must neither repeat contacts nor hide contacts after the first 200');
  assert.deepEqual(ids,new Set(transport.store.listAll('contacts').map(contact=>contact.id)));
  const unfiltered=await svc.call('listContacts',{limit:200,offset:200});
  assert.deepEqual(second.items.map(contact=>contact.id),unfiltered.items.map(contact=>contact.id),'empty filters must behave exactly like absent filters');
  assert.equal(first.items.every(contact=>typeof contact.invitationState==='string'),true,'page hydration must preserve derived authorization/invitation states');
  const authorizedOnly=await svc.call('listContacts',{groupId:'',status:'authorized',limit:200});
  assert.equal(authorizedOnly.total,1,'a real non-empty status filter must still restrict the result');
});

test('review: history hydration preserves full job details and reflects a later delivery receipt',async t=>{
  const {svc,transport,contact}=await serviceFixture(t);
  const campaignRecord=await svc.call('saveCampaign',{campaign:{name:'Histórico com confirmação',groupIds:[GROUP],communityLink:LINK,message:'Olá {nome}! {link_comunidade}'}});
  const stamp=Date.now(),job={id:'history-controlled-job',runId:'history-controlled-run',campaignId:campaignRecord.id,contactId:contact.id,recipientKey:transport.store.recipientKey(contact),phoneSnapshot:PN,textSnapshot:`Olá Nome antes!\nConheça a comunidade: ${LINK} 😀`,clientMessageId:'ACCONTROLLEDHISTORY',messageId:'CONTROLLED-HISTORY-MESSAGE',status:'accepted',attempts:1,createdAt:stamp-10000,startedAt:stamp-9000,submittedAt:stamp-8500,resultAt:stamp-7000,acceptedAt:stamp-7000,deliveredAt:null};
  transport.store.save('runs',{id:job.runId,campaignId:campaignRecord.id,status:'completed',createdAt:job.createdAt});
  transport.store.save('jobs',job);
  transport.store.markRecipient(contact,job.id,'accepted',{at:job.acceptedAt,messageId:job.messageId});
  transport.store.save('history',{id:job.id,jobId:job.id,runId:job.runId,campaignId:job.campaignId,contactId:contact.id,status:'accepted',at:job.acceptedAt,messageId:job.messageId});
  const before=(await svc.call('listHistory',{status:'',campaignId:'',limit:25})).items[0];
  for(const field of ['phoneSnapshot','textSnapshot','clientMessageId','messageId','createdAt','startedAt','submittedAt','acceptedAt'])assert.equal(before[field],job[field],`history must hydrate ${field} from its durable job`);
  assert.equal(before.status,'accepted');assert.equal(before.deliveredAt,null);
  transport.emit('receipt',{messageId:job.messageId,status:'delivered',confirmationScope:'controlled-test-receipt'});
  const after=(await svc.call('listHistory',{limit:25})).items[0];
  assert.equal(after.status,'delivered');assert.equal(after.messageId,job.messageId);assert.equal(after.textSnapshot,job.textSnapshot);assert.equal(after.acceptedAt,job.acceptedAt);
  assert.equal(Number.isFinite(after.deliveredAt),true);assert.ok(after.deliveredAt>=job.acceptedAt);
  assert.equal(transport.store.get('jobs',job.id).status,'delivered');
  assert.equal(transport.store.ledger(contact).status,'delivered');
  assert.equal(transport.sent.length,0,'receipt hydration must never send another invitation');
});
