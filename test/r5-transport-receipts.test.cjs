'use strict';

// Actual adapter and SQLite, with a controlled Baileys socket only. These
// protocol regressions do not establish receipt on a real WhatsApp account.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { createHash, randomUUID } = require('node:crypto');
const { createStore } = require('../src/core/store.cjs');
const { WhatsAppAdapter } = require('../src/adapters/whatsapp.cjs');

const OWNER = '5511999990001';
const SHOP = '5562999990002';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kenned-transport-231-'));
  const store = await createStore(dir);
  store.setSetting('integrationMode', 'whatsapp');
  let socket, lookupBehavior;
  let acknowledge = true;
  const submissions = [], incoming = [], diagnostics = [], lookups = [];
  const library = {
    BufferJSON: { replacer: (_key, value) => value, reviver: (_key, value) => value },
    initAuthCreds: () => ({}),
    WAMessageStubType: { CIPHERTEXT: 2 },
    default() {
      socket = { ev: new EventEmitter(), ws: new EventEmitter(), user: { id: `${SHOP}:7@s.whatsapp.net` }, end() {}, logout: async () => {},
        onWhatsApp: async number => { lookups.push(number); return lookupBehavior ? lookupBehavior(number) : [{ exists: true, jid: `${number}@s.whatsapp.net` }]; },
        sendMessage: async (target, content, options) => {
          submissions.push({ target, content, options });
          const current = socket;
          if (acknowledge) queueMicrotask(() => current.ws.emit('CB:ack,class:message', { attrs: { id: options.messageId } }));
          return { key: { id: options.messageId }, status: 1 };
        } };
      return socket;
    }
  };
  const config = { store, credentialsDir: path.join(dir, 'credentials'), runtimePlatform: 'win32', loadLibrary: async () => library,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() }, ackTimeoutMs: 25 };
  const adapter = new WhatsAppAdapter(config);
  adapter.on('incoming', value => incoming.push(value));
  adapter.on('transportDiagnostic', value => diagnostics.push(value));
  await adapter.connect(); socket.ev.emit('connection.update', { connection: 'open' });
  const emit = (message, extra = {}) => socket.ev.emit('messages.upsert', { type: 'notify', messages: [message], ...extra });
  t.after(async () => { await adapter.disconnect(); store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, store, adapter, incoming, diagnostics, submissions, lookups, emit,
    get socket() { return socket; }, makeAdapter: () => new WhatsAppAdapter(config), setLookup(fn) { lookupBehavior = fn; }, setAck(value) { acknowledge = value; } };
}

test('group receipt bursts above the L1 capacity persist one monotonic proof and do not repeat effects',async t=>{
 const f=await fixture(t);assert.equal(typeof f.store.advanceOutboundProof,'function');const receipts=[];f.adapter.on('receipt',v=>receipts.push(v));const at=Date.now();
 for(let i=0;i<2591;i++){const id='R5-BURST-'+i;f.adapter._markAutomatic(id);f.adapter._ack(id,{confirmationScope:'whatsapp-read',readAt:at+i,targetId:'120000001@g.us'});}
 assert.equal(receipts.length,2591);assert.equal(f.adapter.receipts.size,1000);assert.equal(f.adapter.deliveryProofs.size,1000);
 const before=f.diagnostics.length;for(let i=0;i<2591;i++)f.adapter._ack('R5-BURST-'+i,{confirmationScope:'whatsapp-read',readAt:at+10000+i,targetId:'120000001@g.us'});
 assert.equal(receipts.length,2591);assert.equal(f.diagnostics.length,before);assert.equal(f.store.getOutboundProof('R5-BURST-0').readAt,at);
});
test('server acceptance upgrades to delivery and read exactly once and preserves their original timestamps',async t=>{
 const f=await fixture(t),receipts=[];f.adapter.on('receipt',v=>receipts.push(v));const at=Date.now(),id='R5-PROGRESS';f.adapter._markAutomatic(id);
 f.adapter._ack(id,{confirmationScope:'whatsapp-server',targetId:`${OWNER}@s.whatsapp.net`});const first=f.store.getOutboundProof(id).acceptedAt;
 f.adapter._ack(id,{confirmationScope:'whatsapp-delivered',deliveredAt:at+10,targetId:`${OWNER}@s.whatsapp.net`});
 f.adapter._ack(id,{confirmationScope:'whatsapp-read',readAt:at+20,targetId:`${OWNER}@s.whatsapp.net`});
 f.adapter._ack(id,{confirmationScope:'whatsapp-delivered',deliveredAt:at+100,targetId:`${OWNER}@s.whatsapp.net`});
 f.adapter._ack(id,{confirmationScope:'whatsapp-read',readAt:at+200,targetId:`${OWNER}@s.whatsapp.net`});
 assert.deepEqual(receipts.map(v=>v.confirmationScope),['whatsapp-server','whatsapp-delivered','whatsapp-read']);
 const p=f.store.getOutboundProof(id);assert.equal(p.acceptedAt,first);assert.equal(p.deliveredAt,at+10);assert.equal(p.readAt,at+20);
});
test('restarting the adapter reconciles durable receipt without emitting history or submitting the same ID again',async t=>{
 const f=await fixture(t),id='R5-RESTART';f.adapter._markAutomatic(id);f.adapter._ack(id,{confirmationScope:'whatsapp-read',readAt:Date.now(),targetId:`${OWNER}@s.whatsapp.net`});
 await f.adapter.disconnect({manual:false,logout:false,reasonCode:'application_closed'});const restarted=f.makeAdapter();await restarted.connect();f.socket.ev.emit('connection.update',{connection:'open'});let count=0;restarted.on('receipt',()=>count++);
 restarted._ack(id,{confirmationScope:'whatsapp-read',readAt:Date.now()+10,targetId:`${OWNER}@s.whatsapp.net`});assert.equal(count,0);
 const reconciled=await restarted.reconcile(id);assert.equal(reconciled.status,'confirmed');assert.equal(reconciled.delivered,true);assert.equal(reconciled.source,'authenticated-durable-receipt');
 const sent=await restarted.sendSearchText(OWNER,'Mesma operação',{clientMessageId:id});assert.equal(sent.status,'confirmed');assert.equal(f.submissions.length,0);
 await assert.rejects(restarted.sendSearchText('5511999990004','Outro destinatário',{clientMessageId:id}),{code:'WA_MESSAGE_DESTINATION_CONFLICT'});assert.equal(f.submissions.length,0);await restarted.disconnect();
});
test('a receipt for a different group cannot confirm the queued destination',async t=>{
 const f=await fixture(t),id='R5-WRONG-GROUP';f.adapter._markAutomatic(id);f.adapter._rememberOutcome(id,'uncertain','120000001@g.us');
 f.adapter._ack(id,{confirmationScope:'whatsapp-read',targetId:'120000002@g.us'});assert.equal(f.store.getOutboundProof(id),undefined);assert.equal((await f.adapter.reconcile(id)).status,'uncertain');
});
test('unverified USYNC phone changes remain blocked and expose only safe comparison diagnostics',async t=>{
 const f=await fixture(t),other='5511999990004';f.setLookup(()=>[{exists:true,jid:`${other}@s.whatsapp.net`}]);
 await assert.rejects(f.adapter.resolveRecipient(OWNER,{traceId:randomUUID()}),e=>e.code==='WA_RECIPIENT_MISMATCH'&&e.resolutionDetails.requestedPhoneLength===OWNER.length&&e.resolutionDetails.destinationSubstituted===false);
 const diagnostic=f.diagnostics.find(v=>v.code==='WA_RECIPIENT_MISMATCH');assert(diagnostic);assert.equal(diagnostic.detail.identityConfirmed,false);assert.equal(diagnostic.detail.returnedIdentifierType,'phone-jid');
 assert(!JSON.stringify(diagnostic).includes(OWNER));assert(!JSON.stringify(diagnostic).includes(other));assert.equal(f.submissions.length,0);
});
test('a new LID lookup never derives a telephone from the internal identifier',async t=>{
 const f=await fixture(t);f.setLookup(()=>[{exists:true,jid:'980000001231@lid'}]);const result=await f.adapter.resolveRecipient(OWNER);assert.equal(result.phone,OWNER);assert.equal(result.jid,'980000001231@lid');assert.notEqual(result.phone,'980000001231');
});
