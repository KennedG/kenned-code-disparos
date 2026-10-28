'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createStore } = require('../src/core/store.cjs');
const { InviteQueue } = require('../src/core/queue.cjs');
const { validateCampaign } = require('../src/core/models.cjs');
class TestAdapter extends EventEmitter {
  constructor() { super(); this.status = { ready: true, state: 'connected' }; this.minimumSpacingMs = 3000; this.sent = []; this.behavior = null; }
  async sendInvite(contact, text, options) { if (this.behavior) return this.behavior(contact, text, options); await options.beforeSubmit(); this.sent.push({ contactId: contact.id, text, id: options.clientMessageId }); return { status: 'accepted', messageId: options.clientMessageId, confirmationScope: 'test_adapter_ack' }; }
  async reconcile(id) { return this.reconciliation || { status: 'uncertain', messageId: id }; }
  ready(value) { this.status = { ready: value, state: value ? 'connected' : 'disconnected' }; this.emit('status', this.status); }
}
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'community-queue-'));
  const store = createStore(dir); let clock = new Date(2026, 9, 15, 12, 0, 0).getTime(); const adapter = new TestAdapter();
  const queue = new InviteQueue({ store, adapter, now: () => clock, autoTick: false, attemptTimeoutMs: 30, ...options });
  const context = { dir, store, adapter, queue, at: () => clock, advance: n => { clock += n; },
    contact(id, patch = {}) { return store.save('contacts', { id, externalId: `551199999${id.padStart(4,'0')}@s.whatsapp.net`, identifiers: [`551199999${id.padStart(4,'0')}@s.whatsapp.net`], phone: `551199999${id.padStart(4,'0')}`, name: `Contato ${id}`, groupIds: ['group@g.us'], authorized: true, authorizedAt: clock, consentNote: 'Autorização de teste explícita', blocked: false, optOut: false, muted: false, ambiguous: false, firstSeenAt: clock, ...patch }); },
    campaign(id = 'campaign1', patch = {}) { return store.save('campaigns', { ...validateCampaign({ name: id, groupIds: ['group@g.us'], message: 'Olá {nome}! Convite: {link_comunidade}', communityLink: 'https://chat.whatsapp.com/FixtureTokenOnly', intervalValue: 3, intervalUnit: 'seconds', dailyLimit: 100, executionLimit: 100, ...patch }), id, status: 'draft' }); },
    async activate(id = 'campaign1', opts = {}) { return queue.activate(id, { activationKey: `activate:${id}`, ...opts }); },
    job(id) { return store.listAll('jobs').find(j => j.contactId === id); } };
  queue.start();
  t.after(async () => { await queue.shutdown(); if (!store.closed) store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return context;
}
test('preview is side-effect free and separates authorized, identified and blocked contacts', async t => {
  const f = fixture(t); f.contact('1'); f.contact('2', { authorized: false, consentNote: '' }); f.contact('3', { blocked: true }); f.campaign();
  const preview = f.queue.preview('campaign1'); assert.equal(preview.recipients.length, 1); assert.equal(preview.excluded.length, 2); assert.equal(f.store.count('jobs'), 0); assert.equal(f.adapter.sent.length, 0);
});
test('activation is persistent and idempotent; duplicate click creates one run and job', async t => {
  const f = fixture(t); f.contact('1'); f.campaign();
  const [a,b] = await Promise.all([f.activate(), f.activate()]); assert.equal(a.id, b.id); assert.equal(f.store.count('runs'), 1); assert.equal(f.store.count('jobs'), 1); assert.equal(f.adapter.sent.length, 0);
});
test('one contact in several groups is queued only once', async t => {
  const f = fixture(t); f.contact('1', { groupIds: ['group@g.us', 'group2@g.us'] }); f.campaign('campaign1', { groupIds: ['group@g.us','group2@g.us'] }); await f.activate(); await f.queue.tick(); assert.equal(f.adapter.sent.length, 1);
});
test('two campaigns atomically compete for a recipient; only one reserves', async t => {
  const f = fixture(t); f.contact('1'); f.campaign('a'); f.campaign('b'); const results = await Promise.allSettled([f.activate('a'),f.activate('b')]); assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(f.store.count('jobs'), 1);
});
test('new-only global ledger survives changed campaign name, text and visible history deletion', async t => {
  const f = fixture(t); f.contact('1'); f.campaign(); await f.activate(); await f.queue.tick();
  assert.equal(f.job('1').status, 'accepted'); for (const h of f.store.listAll('history')) f.store.remove('history',h.id);
  f.campaign('different', { message: 'Outra mensagem {link_comunidade}' }); assert.equal(f.queue.preview('different').recipients.length, 0); await assert.rejects(f.activate('different'), { code: 'NO_ELIGIBLE_RECIPIENTS' });
});
test('all mode requires explicit confirmation and records a second independent accepted invitation', async t => {
  const f = fixture(t); const contact=f.contact('1'); f.campaign(); await f.activate(); await f.queue.tick(); f.campaign('again',{mode:'all'});
  await assert.rejects(f.activate('again'),{code:'REPEAT_CONFIRMATION_REQUIRED'}); await f.activate('again',{confirmRepeat:true}); f.advance(3000); await f.queue.tick(); assert.equal(f.adapter.sent.length,2); assert.equal(f.store.ledger(contact).attempts.length,2);
});
test('uncertain recipient is excluded even in all mode', async t => {
  const f = fixture(t); const contact=f.contact('1'); f.store.markRecipient(contact,'previous','uncertain',{at:f.at()}); f.campaign('again',{mode:'all'}); const p=f.queue.preview('again'); assert.equal(p.uncertainCount,1); assert.equal(p.recipients.length,0);
});
test('sequential worker respects interval after completion and reports countdown', async t => {
  const f = fixture(t); f.contact('1'); f.contact('2'); f.campaign(); await f.activate(); await f.queue.tick(); assert.equal(f.adapter.sent.length,1); assert.equal(f.queue.getState().countdownMs,3000);
  f.advance(2999); await f.queue.tick(); assert.equal(f.adapter.sent.length,1); f.advance(1); await f.queue.tick(); assert.equal(f.adapter.sent.length,2); assert.equal(f.store.get('campaigns','campaign1').status,'completed');
});
test('editing interval affects the next pending contact and persists', async t => {
  const f = fixture(t); f.contact('1'); f.contact('2'); const c=f.campaign(); await f.activate(); await f.queue.tick();
  f.store.save('campaigns',{...c,status:'active',intervalValue:1,intervalUnit:'minutes',intervalMs:60000}); f.advance(3000); await f.queue.tick(); assert.equal(f.adapter.sent.length,1); assert.equal(f.queue.getState().countdownMs,57000);
  f.advance(57000); await f.queue.tick(); assert.equal(f.adapter.sent.length,2); assert.equal(f.store.get('campaigns',c.id).intervalMs,60000);
});
test('timeout after submission records uncertainty and frees other eligible contacts', async t => {
  const f = fixture(t,{attemptTimeoutMs:10}); f.contact('1'); f.contact('2'); f.campaign(); let first=true;
  f.adapter.behavior=async(c,text,o)=>{await o.beforeSubmit(); f.adapter.sent.push({contactId:c.id,id:o.clientMessageId}); if(first){first=false; return new Promise(()=>{});} return {status:'accepted',messageId:o.clientMessageId};};
  await f.activate(); await f.queue.tick(); assert.equal(f.store.count('jobs',{status:'uncertain'}),1); f.advance(3000); await f.queue.tick(); assert.equal(f.store.count('jobs',{status:'accepted'}),1); assert.equal(f.adapter.sent.length,2);
});
test('late acceptance upgrades uncertain monotonically without another send', async t => {
  const f=fixture(t,{attemptTimeoutMs:10}); f.contact('1'); f.campaign(); let resolve;
  f.adapter.behavior=async(c,text,o)=>{await o.beforeSubmit(); f.adapter.sent.push({id:o.clientMessageId}); return new Promise(r=>resolve=()=>r({status:'accepted',messageId:o.clientMessageId}));};
  await f.activate(); await f.queue.tick(); assert.equal(f.job('1').status,'uncertain'); resolve(); await new Promise(r=>setImmediate(r)); assert.equal(f.job('1').status,'accepted'); assert.equal(f.adapter.sent.length,1); f.advance(3000); await f.queue.tick(); assert.equal(f.adapter.sent.length,1);
});
test('late delivery receipt updates accepted and history without marking prior queue entry delivered early', async t => {
  const f=fixture(t); f.contact('1'); f.campaign(); await f.activate(); assert.equal(f.job('1').status,'pending'); await f.queue.tick(); let j=f.job('1'); assert.equal(j.status,'accepted'); assert.equal(j.deliveredAt,null);
  f.adapter.emit('receipt',{messageId:j.messageId,status:'delivered',confirmationScope:'test_receipt'}); j=f.job('1'); assert.equal(j.status,'delivered'); assert.equal(f.store.get('history',j.id).status,'delivered');
});
test('late failure cannot downgrade an accepted invitation or authorize resend', async t => {
  const f=fixture(t); const contact=f.contact('1'); f.campaign(); await f.activate(); await f.queue.tick(); const j=f.job('1'); f.adapter.emit('receipt',{messageId:j.messageId,status:'failed',confirmedFailure:true}); assert.equal(f.job('1').status,'accepted'); assert.equal(f.store.isPreviouslyInvited(contact),true);
});
test('known safe pre-submission failures retry finitely with progressive delay', async t => {
  const f=fixture(t,{maxAttempts:3,retryBaseMs:4000}); f.contact('1'); f.campaign(); let attempts=0;
  f.adapter.behavior=async()=>{attempts++; throw Object.assign(new Error('Identidade temporariamente indisponível.'),{code:'TEMP_LOOKUP',confirmedFailure:true,retryable:true,submitted:false});};
  await f.activate(); await f.queue.tick(); assert.equal(f.job('1').nextAttemptAt,f.at()+4000); f.advance(4000); await f.queue.tick(); assert.equal(f.job('1').nextAttemptAt,f.at()+8000); f.advance(8000); await f.queue.tick(); assert.equal(f.job('1').status,'failed'); assert.equal(attempts,3); f.advance(8000); await f.queue.tick(); assert.equal(attempts,3);
});
test('unclassified network error after submission is uncertain, never automatically retried', async t => {
  const f=fixture(t); f.contact('1'); f.campaign(); let calls=0; f.adapter.behavior=async(c,txt,o)=>{await o.beforeSubmit();calls++;throw new Error('Conexão perdida após submissão.');}; await f.activate(); await f.queue.tick(); assert.equal(f.job('1').status,'uncertain'); f.advance(3000); await f.queue.tick(); assert.equal(calls,1);
});
test('contact revocation after queuing cancels before sending', async t => {
  const f=fixture(t); const c=f.contact('1'); f.campaign(); await f.activate(); f.store.save('contacts',{...c,authorized:false}); await f.queue.tick(); assert.equal(f.job('1').status,'cancelled'); assert.equal(f.adapter.sent.length,0);
});
for(const flag of ['blocked','optOut','muted']) test(`all mode still respects ${flag}`,async t=>{const f=fixture(t);f.contact('1',{[flag]:true});f.campaign('all',{mode:'all'});assert.equal(f.queue.preview('all').recipients.length,0);});
test('guard is rechecked after async adapter lookup, before actual submission', async t => {
  const f=fixture(t); const c=f.contact('1'); f.campaign(); let release, began;
  const entered=new Promise(r=>began=r); f.adapter.behavior=async(contact,text,o)=>{began();await new Promise(r=>release=r);await o.beforeSubmit();f.adapter.sent.push({contactId:contact.id});return{status:'accepted',messageId:o.clientMessageId};};
  await f.activate(); const ticking=f.queue.tick(); await entered; f.store.save('contacts',{...c,optOut:true}); release(); await ticking; assert.equal(f.adapter.sent.length,0); assert.equal(f.job('1').status,'cancelled');
});
test('manual pause keeps pending jobs; resume waits a full interval', async t => {
  const f=fixture(t); f.contact('1'); f.campaign(); await f.activate(); await f.queue.pause('campaign1'); f.advance(3000); await f.queue.tick(); assert.equal(f.adapter.sent.length,0); assert.equal(f.job('1').status,'pending'); await f.queue.resume('campaign1'); await f.queue.tick(); assert.equal(f.adapter.sent.length,0); f.advance(3000); await f.queue.tick(); assert.equal(f.adapter.sent.length,1);
});
test('reconnection resumes authorized pending run only after full configured delay', async t => {
  const f=fixture(t); f.contact('1'); f.campaign(); await f.activate(); f.adapter.ready(false); f.advance(3000); await f.queue.tick(); assert.equal(f.adapter.sent.length,0); f.adapter.ready(true); await f.queue.tick(); assert.equal(f.adapter.sent.length,0); assert.equal(f.queue.getState().countdownMs,3000); f.advance(3000); await f.queue.tick(); assert.equal(f.adapter.sent.length,1);
});
test('reconnection never resumes manual pause, stopped run or draft campaign', async t => {
  const f=fixture(t); f.contact('1'); f.campaign(); f.campaign('draft'); await f.activate(); await f.queue.pause('campaign1'); f.adapter.ready(false); f.adapter.ready(true); f.advance(3000); await f.queue.tick(); assert.equal(f.adapter.sent.length,0); assert.equal(f.store.get('campaigns','draft').status,'draft');
});
test('stop all cancels pending work and blocks new automatic entries until explicit release', async t => {
  const f=fixture(t); f.contact('1'); f.contact('2'); f.campaign(); await f.activate(); const stopped=await f.queue.stopAll(); assert.equal(stopped.cancelled,2); assert.equal(f.store.count('jobs',{status:'cancelled'}),2); await assert.rejects(f.activate(),{code:'AUTOMATION_STOPPED'}); f.queue.resumeAutomation(); f.advance(3000); await f.queue.tick(); assert.equal(f.adapter.sent.length,0); assert.equal(f.store.get('campaigns','campaign1').status,'stopped');
});
test('stop while lookup is pending prevents submission even when lookup resolves later', async t => {
  const f=fixture(t); f.contact('1'); f.campaign(); let release,began;const entered=new Promise(r=>began=r);
  f.adapter.behavior=async(c,text,o)=>{began();await new Promise(r=>release=r);await o.beforeSubmit();f.adapter.sent.push(c.id);return{status:'accepted',messageId:o.clientMessageId};}; await f.activate();const ticking=f.queue.tick();await entered;const result=await f.queue.stopAll();assert.equal(result.inFlight.submitted,false);release();await ticking;assert.equal(f.adapter.sent.length,0);assert.equal(f.job('1').status,'cancelled');
});
test('stop after submission preserves late acceptance and reports in-flight operation',async t=>{const f=fixture(t);f.contact('1');f.campaign();let release,began;const entered=new Promise(r=>began=r);f.adapter.behavior=async(c,txt,o)=>{await o.beforeSubmit();began();return new Promise(r=>release=()=>r({status:'accepted',messageId:o.clientMessageId}));};await f.activate();const ticking=f.queue.tick();await entered;const stopped=await f.queue.stopAll();assert.equal(stopped.inFlight.submitted,true);release();await ticking;assert.equal(f.job('1').status,'accepted');assert.equal(f.store.get('campaigns','campaign1').status,'stopped');});
test('schedule and future start prevent early sends; no catch-up burst',async t=>{const f=fixture(t);f.contact('1');f.contact('2');f.campaign('campaign1',{startAt:f.at()+6000});await f.activate();await f.queue.tick();assert.equal(f.adapter.sent.length,0);f.advance(6000);await f.queue.tick();assert.equal(f.adapter.sent.length,1);await f.queue.tick();assert.equal(f.adapter.sent.length,1);});
test('window is checked again immediately before submit',async t=>{const f=fixture(t);f.contact('1');f.campaign('campaign1',{schedule:{days:[0,1,2,3,4,5,6],startTime:'12:00',endTime:'12:01'}});let release,began;const entered=new Promise(r=>began=r);f.adapter.behavior=async(c,txt,o)=>{began();await new Promise(r=>release=r);await o.beforeSubmit();f.adapter.sent.push(c.id);return{status:'accepted',messageId:o.clientMessageId};};await f.activate();const ticking=f.queue.tick();await entered;f.advance(61000);release();await ticking;assert.equal(f.adapter.sent.length,0);assert.equal(f.job('1').status,'pending');assert.equal(f.job('1').errorCode,'OUTSIDE_SCHEDULE');});
test('daily limit preserves remaining pending jobs for a later eligible day',async t=>{const f=fixture(t);f.contact('1');f.contact('2');f.campaign('campaign1',{dailyLimit:1});await f.activate();await f.queue.tick();f.advance(3000);await f.queue.tick();assert.equal(f.adapter.sent.length,1);assert.equal(f.store.count('jobs',{status:'pending'}),1);assert.ok(f.queue.getState().nextAt>f.at());});
test('execution limit excludes excess recipients before materialization',async t=>{const f=fixture(t);f.contact('1');f.contact('2');f.contact('3');f.campaign('campaign1',{executionLimit:2});const p=f.queue.preview('campaign1');assert.equal(p.recipients.length,2);assert.match(p.excluded[0].reason,/Limite/);await f.activate();assert.equal(f.store.count('jobs'),2);});
test('unknown phone, ambiguous identities and self contacts are never eligible',async t=>{const f=fixture(t);f.contact('1',{phone:null,authorized:false,identifiers:['abc@lid'],externalId:'abc@lid'});f.contact('2',{ambiguous:true,authorized:false});f.contact('3',{self:true});f.campaign();assert.equal(f.queue.preview('campaign1').recipients.length,0);});
test('restart preserves accepted ledger and waits before continuing only pending jobs',async t=>{const f=fixture(t);f.contact('1');f.contact('2');f.campaign();await f.activate();await f.queue.tick();await f.queue.shutdown();const second=new InviteQueue({store:f.store,adapter:f.adapter,now:f.at,autoTick:false});second.start();await second.tick();assert.equal(f.adapter.sent.length,1);f.advance(3000);await second.tick();assert.equal(f.adapter.sent.length,2);await second.shutdown();});
test('restart converts submitted processing to uncertainty and safe processing to pending',async t=>{const f=fixture(t);f.contact('1');f.contact('2');f.campaign();await f.activate();const jobs=f.store.listAll('jobs');f.store.save('jobs',{...jobs[0],status:'processing',submittedAt:f.at(),attempts:1});f.store.save('jobs',{...jobs[1],status:'processing',submittedAt:null,attempts:1});await f.queue.shutdown();const second=new InviteQueue({store:f.store,adapter:f.adapter,now:f.at,autoTick:false});second.start();assert.equal(f.store.get('jobs',jobs[0].id).status,'uncertain');assert.equal(f.store.get('jobs',jobs[1].id).status,'pending');f.advance(3000);await second.tick();assert.equal(f.adapter.sent.length,1);await second.shutdown();});
test('uncertain manual retry requires warning, preserves original and is idempotent',async t=>{const f=fixture(t);f.contact('1');f.campaign();f.adapter.behavior=async(c,txt,o)=>{await o.beforeSubmit();return{status:'uncertain',messageId:o.clientMessageId};};await f.activate();await f.queue.tick();const original=f.job('1');await assert.rejects(f.queue.retryJob(original.id),{code:'POSSIBLE_DUPLICATE_CONFIRMATION_REQUIRED'});const a=await f.queue.retryJob(original.id,{confirmPossibleDuplicate:true,activationKey:'manual-one'});const b=await f.queue.retryJob(original.id,{confirmPossibleDuplicate:true,activationKey:'manual-one'});assert.equal(a.id,b.id);assert.notEqual(a.id,original.id);assert.equal(f.store.get('jobs',original.id).status,'uncertain');assert.equal(f.store.count('jobs'),2);});
test('reconciliation uses original message id and upgrades only proof',async t=>{const f=fixture(t);f.contact('1');f.campaign();f.adapter.behavior=async(c,txt,o)=>{await o.beforeSubmit();return{status:'uncertain',messageId:o.clientMessageId};};await f.activate();await f.queue.tick();const j=f.job('1');await f.queue.reconcileJob(j.id);assert.equal(f.job('1').status,'uncertain');f.adapter.reconciliation={status:'delivered',messageId:j.messageId};await f.queue.reconcileJob(j.id);assert.equal(f.job('1').status,'delivered');});
test('simultaneous ticks cannot process same task twice',async t=>{const f=fixture(t);f.contact('1');f.campaign();await f.activate();await Promise.all([f.queue.tick(),f.queue.tick(),f.queue.tick()]);assert.equal(f.adapter.sent.length,1);});
test('phone change after preview cancels task instead of silently redirecting',async t=>{const f=fixture(t);const c=f.contact('1');f.campaign();await f.activate();assert.throws(()=>f.store.save('contacts',{...c,phone:'5511888880001',identifiers:['5511888880001@s.whatsapp.net']}),{code:'CONTACT_IDENTITY_IMMUTABLE'});const get=f.store.get.bind(f.store);f.store.get=(kind,id)=>{const value=get(kind,id);return kind==='contacts'&&id===c.id?{...value,phone:'5511888880001'}:value;};await f.queue.tick();assert.equal(f.adapter.sent.length,0);assert.equal(f.job('1').errorCode,'IDENTITY_CHANGED');f.store.get=get;});
test('late proof does not release a different manual retry claim',async t=>{const f=fixture(t);const c=f.contact('1');f.campaign();f.adapter.behavior=async(c,txt,o)=>{await o.beforeSubmit();return{status:'uncertain',messageId:o.clientMessageId};};await f.activate();await f.queue.tick();const original=f.job('1');const manual=await f.queue.retryJob(original.id,{confirmPossibleDuplicate:true,activationKey:'review'});f.adapter.emit('receipt',{messageId:original.messageId,status:'accepted'});assert.equal(f.store.ledger(c).activeJobId,manual.id);assert.equal(f.store.get('jobs',original.id).status,'accepted');});
test('interval edited during recipient lookup is rechecked before network without spending retry budget',async t=>{
  const f=fixture(t);f.contact('1');f.contact('2');f.campaign();await f.activate();await f.queue.tick();f.advance(3000);let release,began;const entered=new Promise(r=>began=r);
  f.adapter.behavior=async(c,txt,o)=>{began();await new Promise(r=>release=r);await o.beforeSubmit();f.adapter.sent.push(c.id);return{status:'accepted',messageId:o.clientMessageId};};
  const ticking=f.queue.tick();await entered;const campaign=f.store.get('campaigns','campaign1');f.store.save('campaigns',{...campaign,intervalValue:30,intervalMs:30000});release();await ticking;const pending=f.store.listAll('jobs',{status:'pending'})[0];assert.equal(f.adapter.sent.length,1);assert.equal(pending.errorCode,'INTERVAL_WAIT');assert.equal(pending.attempts,0);
});
test('reconnection during lookup restarts the full spacing before submission',async t=>{
  const f=fixture(t);f.contact('1');f.campaign();let release,began;const entered=new Promise(r=>began=r);f.adapter.behavior=async(c,txt,o)=>{began();await new Promise(r=>release=r);await o.beforeSubmit();f.adapter.sent.push(c.id);return{status:'accepted',messageId:o.clientMessageId};};await f.activate();const ticking=f.queue.tick();await entered;f.adapter.ready(false);f.adapter.ready(true);release();await ticking;assert.equal(f.adapter.sent.length,0);assert.equal(f.job('1').status,'pending');assert.equal(f.job('1').attempts,0);assert.equal(f.job('1').errorCode,'INTERVAL_WAIT');
});
test('storage failure latch blocks activation, tick and the post-lookup submission guard',async t=>{
  const f=fixture(t);f.contact('1');f.campaign();await f.activate();let release,began;const entered=new Promise(r=>began=r);f.adapter.behavior=async(c,txt,o)=>{began();await new Promise(r=>release=r);await o.beforeSubmit();f.adapter.sent.push(c.id);return{status:'accepted',messageId:o.clientMessageId};};const ticking=f.queue.tick();await entered;f.store.persistenceFailed=true;release();await ticking;assert.equal(f.adapter.sent.length,0);assert.equal(f.job('1').status,'pending');assert.equal(f.job('1').errorCode,'STORAGE_UNAVAILABLE');await assert.rejects(f.queue.activate('campaign1',{activationKey:'another'}),{code:'STORAGE_UNAVAILABLE'});await f.queue.tick();assert.equal(f.adapter.sent.length,0);f.store.persistenceFailed=false;
});
test('failed accepted-result persistence never enables a second send and restart recovers uncertainty',async t=>{
  const f=fixture(t);f.contact('1');f.contact('2');f.campaign();await f.activate();const save=f.store.save.bind(f.store);let failed=false;
  f.store.save=(kind,record)=>{if(kind==='jobs'&&record.status==='accepted'&&!failed){failed=true;f.store.persistenceFailed=true;throw Object.assign(new Error('Disco cheio de teste'),{code:'SQLITE_FULL'});}return save(kind,record);};
  await assert.rejects(f.queue.tick(),/Disco cheio/);f.advance(3000);await f.queue.tick();assert.equal(f.adapter.sent.length,1);assert.equal(f.store.count('jobs',{status:'processing'}),1);f.store.save=save;f.store.persistenceFailed=false;await f.queue.shutdown();const second=new InviteQueue({store:f.store,adapter:f.adapter,now:f.at,autoTick:false});second.start();assert.equal(f.store.count('jobs',{status:'uncertain'}),1);assert.equal(f.store.count('jobs',{status:'pending'}),1);await second.shutdown();
});
test('short native suspension prevents send and resume waits a full interval independent of clock drift',async t=>{const f=fixture(t);f.contact('1');f.campaign();await f.activate();f.queue.pauseForSuspend();f.advance(1000);await f.queue.tick();assert.equal(f.adapter.sent.length,0);assert.equal(f.queue.getState().suspended,true);assert.equal(f.queue.getState().nextAt,null);f.queue.onResume();await f.queue.tick();assert.equal(f.adapter.sent.length,0);f.advance(2999);await f.queue.tick();assert.equal(f.adapter.sent.length,0);f.advance(1);await f.queue.tick();assert.equal(f.adapter.sent.length,1);});
test('native suspension during lookup cancels that attempt safely and cannot bypass resume delay',async t=>{const f=fixture(t);f.contact('1');f.campaign();let release,began;const entered=new Promise(r=>began=r);f.adapter.behavior=async(c,txt,o)=>{began();await new Promise(r=>release=r);await o.beforeSubmit();f.adapter.sent.push(c.id);return{status:'accepted',messageId:o.clientMessageId};};await f.activate();const ticking=f.queue.tick();await entered;f.queue.pauseForSuspend();await ticking;assert.equal(f.job('1').status,'pending');assert.equal(f.job('1').attempts,0);f.advance(1000);f.queue.onResume();release();await new Promise(r=>setImmediate(r));assert.equal(f.adapter.sent.length,0);assert.equal(f.job('1').status,'pending');});
test('native suspension after network submission records uncertainty and does not resend on resume',async t=>{const f=fixture(t);f.contact('1');f.campaign();let began;const entered=new Promise(r=>began=r);f.adapter.behavior=async(c,txt,o)=>{await o.beforeSubmit();f.adapter.sent.push(c.id);began();return new Promise(()=>{});};await f.activate();const ticking=f.queue.tick();await entered;f.queue.pauseForSuspend();await ticking;assert.equal(f.job('1').status,'uncertain');f.advance(1000);f.queue.onResume();f.advance(3000);await f.queue.tick();assert.equal(f.adapter.sent.length,1);});
test('resume from suspension preserves manual pause and global stop',async t=>{const f=fixture(t);f.contact('1');f.campaign();await f.activate();await f.queue.pause('campaign1');f.queue.pauseForSuspend();f.queue.onResume();f.advance(3000);await f.queue.tick();assert.equal(f.adapter.sent.length,0);assert.equal(f.store.get('campaigns','campaign1').status,'paused');await f.queue.stopAll();f.queue.pauseForSuspend();f.queue.onResume();assert.equal(f.queue.getState().automationStopped,true);});
test('receipt persistence failure latches queue safely instead of crashing an event emitter',async t=>{const f=fixture(t);f.contact('1');f.campaign();await f.activate();await f.queue.tick();const original=f.store.save.bind(f.store);f.store.save=(kind,item)=>{if(kind==='jobs'&&item.status==='delivered')throw Object.assign(new Error('Falha disco teste'),{code:'SQLITE_IOERR'});return original(kind,item);};const j=f.job('1');assert.doesNotThrow(()=>f.adapter.emit('receipt',{messageId:j.messageId,status:'delivered'}));assert.equal(f.store.persistenceFailed,true);assert.equal(f.job('1').status,'accepted');f.store.save=original;f.store.persistenceFailed=false;});
test('decreasing interval during execution applies to the very next contact without stale old deadline',async t=>{const f=fixture(t);f.contact('1');f.contact('2');f.campaign('campaign1',{intervalValue:30});await f.activate();await f.queue.tick();const c=f.store.get('campaigns','campaign1');f.store.save('campaigns',{...c,intervalValue:3,intervalMs:3000});f.advance(3000);assert.equal(f.queue.getState().countdownMs,0);await f.queue.tick();assert.equal(f.adapter.sent.length,2);});
test('decreasing interval during reconnect hold uses time since recovery and still waits new full interval',async t=>{const f=fixture(t);f.contact('1');f.campaign('campaign1',{intervalValue:30});await f.activate();f.adapter.ready(false);f.adapter.ready(true);const c=f.store.get('campaigns','campaign1');f.store.save('campaigns',{...c,intervalValue:3,intervalMs:3000});f.advance(2999);await f.queue.tick();assert.equal(f.adapter.sent.length,0);f.advance(1);await f.queue.tick();assert.equal(f.adapter.sent.length,1);});
test('late proof of original uncertain job cancels a reviewed resend before it starts',async t=>{const f=fixture(t);f.contact('1');f.campaign();let sent=0;f.adapter.behavior=async(c,txt,o)=>{await o.beforeSubmit();sent++;return{status:'uncertain',messageId:o.clientMessageId};};await f.activate();await f.queue.tick();const original=f.job('1');const manual=await f.queue.retryJob(original.id,{confirmPossibleDuplicate:true,activationKey:'late-proof'});f.adapter.emit('receipt',{messageId:original.messageId,status:'accepted'});f.advance(3000);await f.queue.tick();assert.equal(f.store.get('jobs',manual.id).status,'cancelled');assert.equal(f.store.get('jobs',manual.id).errorCode,'PREVIOUS_SEND_CONFIRMED');assert.equal(sent,1);});
