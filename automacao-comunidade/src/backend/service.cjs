'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { createStore } = require('../core/store.cjs');
const { InviteQueue } = require('../core/queue.cjs');
const models = require('../core/models.cjs');
const { WhatsAppAdapter } = require('../adapters/whatsapp.cjs');
const { SimulatedAdapter } = require('../adapters/simulated.cjs');

const APP_NAME = 'Automação Comunidade';
const error = (message, code='VALIDATION') => Object.assign(new Error(message), { code });
const digest = value => createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex');
const boundedPage = input => {
  const page={...input,limit:Math.max(1,Math.min(200,Math.trunc(Number(input?.limit)||50))),offset:Math.max(0,Math.trunc(Number(input?.offset)||0))};
  for(const key of ['status','groupId','campaignId','runId','contactId'])if(page[key]==='')delete page[key];
  return page;
};
const safeDescription = value => String(value || 'Não foi possível concluir a operação.').replace(/(?:Bearer\s+|token[=: ]+|password[=: ]+|secret[=: ]+)[^\s,;]+/gi, '[credencial omitida]').slice(0,1200);

async function createService({ dir, host=async()=>null, secureStorage, adapterFactory, now=()=>Date.now(), version='1.0.1' }={}) {
  if(!dir)throw error('Pasta de dados independente não configurada.','DATA_DIRECTORY_REQUIRED');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  for(const name of ['credentials','media','backups','exports'])fs.mkdirSync(path.join(dir,name),{recursive:true,mode:0o700});
  const store=createStore(dir), events=new EventEmitter(), previews=new Map();
  let adapter,queue,closed=false,updateTimer=null,groupSync=null,participantsSync=new Map(),maintenance=false,mutation=Promise.resolve();
  const defaults={integrationMode:'whatsapp',defaultIntervalValue:30,defaultIntervalUnit:'seconds',defaultDailyLimit:100,unofficialAcknowledged:false,minimizeToTray:true,launchAtLogin:false,autoReconnect:true,attemptTimeoutMs:30000,maxAttempts:3,retryBaseMs:5000};
  const settings=()=>({...defaults,...store.getSetting('settings',{}),integrationMode:store.getMode()});
  const audit=(action,details={})=>store.audit({id:randomUUID(),at:now(),action,...details});
  const diagnostic=(stage,err,extra={})=>{try{store.diagnostics({id:randomUUID(),at:now(),stage,level:'error',code:/^[A-Z0-9_]{1,80}$/.test(err?.code||'')?err.code:'APP_ERROR',description:safeDescription(err?.message),...extra});}catch{queue?.stopAll?.();}};
  const serialized=task=>{const operation=mutation.then(task);mutation=operation.catch(()=>{});return operation;};
  const read=(kind,id)=>{if(typeof id!=='string'||!id||id.length>512)throw error('Identificador inválido.');const value=store.get(kind,id);if(!value)throw error('Registro não encontrado.','NOT_FOUND');return value;};
  const ready=()=>adapter?.status?.state==='connected'&&adapter.status.ready!==false;
  const taskRunning=()=>store.listAll('jobs',{status:'processing'}).length>0;
  const getContact=id=>read('contacts',id);
  const groupIds=value=>[...new Set(Array.isArray(value)?value:[])];
  const authorizationBlock=contact=>{
    if(contact.optOut)return {code:'CONTACT_OPTED_OUT',reason:'Este contato pediu para não receber mensagens. A autorização não pode ignorar essa restrição.'};
    if(contact.blocked)return {code:'CONTACT_BLOCKED',reason:'Este contato está bloqueado. Revise o bloqueio no cadastro antes de registrar uma nova autorização.'};
    if(contact.muted)return {code:'CONTACT_MUTED',reason:'Este contato está silenciado. Retire o silenciamento no cadastro antes de registrar uma nova autorização.'};
    if(contact.self)return {code:'CONTACT_SELF',reason:'Este participante é a própria conta do WhatsApp conectada e não é destinatário elegível de convites.'};
    const normalized=models.normalizePhone(contact.phone);
    const linkedPhones=[...new Set([contact.externalId,...(Array.isArray(contact.identifiers)?contact.identifiers:[])].filter(value=>typeof value==='string').map(value=>value.match(/^(\d+)(?::\d+)?@(?:s\.whatsapp\.net|c\.us)$/i)?.[1]).filter(Boolean))];
    if(contact.ambiguous||linkedPhones.length>1||(normalized&&linkedPhones.some(phone=>phone!==normalized)))return {code:'CONTACT_IDENTITY_AMBIGUOUS',reason:'A integração forneceu uma identidade ou vínculo de telefone ambíguo. Atualize os participantes e revise a identificação; não associe um número por suposição.'};
    if(!normalized){
      const lidOnly=[contact.externalId,...(Array.isArray(contact.identifiers)?contact.identifiers:[])].some(value=>typeof value==='string'&&value.endsWith('@lid'));
      return {code:contact.phone?'CONTACT_PHONE_INVALID':'CONTACT_PHONE_UNAVAILABLE',reason:contact.phone?'O telefone disponível não é um número completo válido com país e DDD. Atualize os participantes; não é possível liberar o envio com esse cadastro.':lidOnly?'A integração disponibilizou apenas um identificador interno (LID), sem telefone confiável. Clique em Atualizar participantes; o envio só será liberado se a integração fornecer o telefone ou um vínculo confiável.':'A integração não disponibilizou um telefone confiável. Clique em Atualizar participantes; um nome ou identificador interno não substitui o número.'};
    }
    return null;
  };
  const contactLabel=contact=>String(contact.name||contact.displayName||contact.phone||contact.externalId||contact.id).replace(/[\r\n]/g,' ').slice(0,160);
  const validateConsent=note=>{if(typeof note!=='string'||note.trim().length<3||note.trim().length>1000)throw error('Registre como o contato autorizou o recebimento do convite, usando de 3 a 1.000 caracteres.','CONSENT_REQUIRED');return note.trim();};
  const decorateContact=contact=>{
      const ledger=store.ledger(contact);
      const block=authorizationBlock(contact);
      const unavailable=!!block&&!contact.blocked&&!contact.optOut&&!contact.muted;
      const invitationState=contact.blocked||contact.optOut||contact.muted?'blocked':unavailable?'unavailable':ledger?.uncertain?'uncertain':ledger?.previouslyInvited?'invited':contact.authorized?'authorized':'identified';
      return {...contact,invitationState,authorizationEligible:!block,authorizationBlockCode:block?.code||null,authorizationBlockReason:block?.reason||null,previouslyInvited:ledger?.previouslyInvited===true,lastInviteAt:ledger?.lastAcceptedAt||ledger?.lastUncertainAt||null,hasUncertain:ledger?.uncertain===true};
  };
  const contactsWithState=filter=>store.listAll('contacts',filter).map(decorateContact);
  function metrics(){
    if(typeof store.getMetrics==='function')return store.getMetrics();
    const contacts=contactsWithState({}),counts=status=>store.count?store.count('jobs',{status}):store.listAll('jobs',{status}).length;
    return {identified:contacts.length,authorized:contacts.filter(c=>c.authorized).length,newEligible:contacts.filter(c=>c.authorized&&!c.blocked&&!c.optOut&&!c.muted&&!c.self&&!c.ambiguous&&c.phone&&!c.previouslyInvited).length,previouslyInvited:contacts.filter(c=>c.previouslyInvited).length,pending:counts('pending'),processing:counts('processing'),accepted:counts('accepted'),delivered:counts('delivered'),uncertain:counts('uncertain'),failed:counts('failed'),cancelled:counts('cancelled'),activeCampaigns:store.listAll('campaigns',{status:['active','scheduled']}).length};
  }
  function snapshot(){
    const q=queue?.getState?.()||{};
    return {appName:APP_NAME,version,mode:store.getMode(),connection:adapter?{...adapter.status}:null,settings:settings(),metrics:metrics(),groups:store.listAll('groups',{}),campaigns:store.listAll('campaigns',{}),queue:{...q,stopped:q.stopped??q.automationStopped??false,nextSendAt:q.nextSendAt??q.nextAt??null},clock:{now:now(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'},capabilities:{integration:'Baileys',official:false,participants:'Disponíveis conforme a sessão e as permissões do grupo.',phone:'Somente telefone fornecido ou vínculo PN/LID comprovado; não há conversão fictícia.',history:'Histórico local de convites; não é cópia completa do WhatsApp.'},maintenance,storageError:store.persistenceFailed?'Falha no armazenamento; novos envios bloqueados.':null};
  }
  function broadcast(immediate=false){
    if(closed)return;
    if(immediate){clearTimeout(updateTimer);updateTimer=null;events.emit('update',snapshot());return;}
    if(!updateTimer){updateTimer=setTimeout(()=>{updateTimer=null;if(!closed)events.emit('update',snapshot());},250);updateTimer.unref?.();}
  }
  const makeAdapter=()=>adapterFactory?adapterFactory({mode:store.getMode(),store,secureStorage,dir,now}):store.getMode()==='simulated'?new SimulatedAdapter({store,now}):new WhatsAppAdapter({store,now,credentialsDir:path.join(dir,'credentials'),safeStorage:secureStorage});
  function bind(source){
    source.on('status',()=>{if(source!==adapter||closed)return;broadcast();if(ready())void refreshGroups().catch(err=>diagnostic('groups.sync',err));});
    source.on('diagnostic',record=>{if(source!==adapter||closed)return;try{store.diagnostics({...record,id:record.id||randomUUID(),at:record.at||now(),description:safeDescription(record.description||record.detail)});}catch{}broadcast();});
    source.on('incoming',context=>{
      if(source!==adapter||closed||context.isGroup||context.forwarded||context.fromMe||!(context.verified||context.identityVerified)||!/^\s*(sair|parar|cancelar|stop|não quero receber|nao quero receber)\s*[.!]?\s*$/iu.test(String(context.text||'')))return;
      const trusted=(context.phone||context.senderNumber||'');
      const contact=store.listAll('contacts',{}).find(c=>trusted&&c.phone===trusted||(c.identifiers||[]).includes(context.senderId));
      if(!contact)return;
      store.save('contacts',{...contact,optOut:true,authorized:false,optOutAt:now(),updatedAt:now()});audit('contact.optOut',{contactId:contact.id});broadcast();
    });
  }
  async function refreshGroups(){
    if(groupSync)return groupSync;
    if(!ready())throw error('Conecte o WhatsApp antes de sincronizar os grupos.','WHATSAPP_DISCONNECTED');
    const source=adapter,mode=store.getMode();
    const operation=(async()=>{const groups=await source.listGroups();if(source!==adapter||mode!==store.getMode()||!ready())throw error('A sessão mudou durante a consulta. Sincronize novamente.','SESSION_CHANGED');const result=store.replaceGroups(groups);store.setSetting('lastGroupSyncAt',now());store.setSetting('lastGroupError',null);broadcast();return result;})().catch(err=>{store.setSetting('lastGroupError',{at:now(),code:err.code||'GROUP_SYNC_FAILED',message:safeDescription(err.message)});throw err;});
    groupSync=operation;try{return await operation;}finally{if(groupSync===operation)groupSync=null;}
  }
  async function refreshParticipants(groupId){
    if(participantsSync.has(groupId))return participantsSync.get(groupId);
    read('groups',groupId);if(!ready())throw error('Conecte o WhatsApp para consultar os participantes.','WHATSAPP_DISCONNECTED');
    const source=adapter,mode=store.getMode();
    const operation=(async()=>{const participants=await source.listParticipants(groupId);if(source!==adapter||mode!==store.getMode()||!ready())throw error('A sessão mudou durante a consulta. Atualize novamente.','SESSION_CHANGED');const result=store.importParticipants(groupId,participants,now());audit('participants.import',{groupId,...result});broadcast();return {...result,groupId,at:now(),completeHistory:false};})().catch(err=>{diagnostic('participants.sync',err,{groupId});throw err;});
    participantsSync.set(groupId,operation);try{return await operation;}finally{if(participantsSync.get(groupId)===operation)participantsSync.delete(groupId);}
  }
  function updateContact(id,changes){
    if(!changes||typeof changes!=='object'||Array.isArray(changes))throw error('Alterações do contato inválidas.','CONTACT_CHANGES_INVALID');
    const c=getContact(id),next={...c};
    if(changes.name!==undefined){if(typeof changes.name!=='string'||changes.name.length>120)throw error('Nome: use até 120 caracteres.');next.name=changes.name.trim();}
    for(const key of ['blocked','muted','optOut'])if(changes[key]!==undefined){if(typeof changes[key]!=='boolean')throw error('Situação do contato inválida.');next[key]=changes[key];}
    if(changes.authorized!==undefined){
      if(typeof changes.authorized!=='boolean')throw error('Autorização inválida.');
      const restricting=['blocked','muted','optOut'].some(key=>changes[key]===true);
      if(changes.authorized&&!restricting){
        const block=authorizationBlock(next);if(block)throw Object.assign(error(`${contactLabel(c)} (ID: ${c.id}): ${block.reason}`,block.code),{contactId:c.id});
        const note=validateConsent(changes.consentNote);
        next.consentNote=note;next.authorizedAt=now();
      }
      next.authorized=changes.authorized&&!restricting;
      if(!changes.authorized)next.authorizationRevokedAt=now();
    }
    if(next.optOut||next.blocked||next.muted){if(c.authorized)next.authorizationRevokedAt=now();next.authorized=false;}
    next.updatedAt=now();return store.transaction(()=>{const saved=store.save('contacts',next);audit('contact.update',{contactId:id,authorized:next.authorized,blocked:next.blocked,muted:next.muted,optOut:next.optOut});return decorateContact(saved);});
  }
  function stateFingerprint(c,preview){return digest({revision:c.revision,campaign:c,recipients:preview.recipients.map(r=>({id:r.id,phone:r.phone,text:models.renderMessage(c,r),authorizedAt:r.authorizedAt,blocked:r.blocked,optOut:r.optOut,muted:r.muted,ledger:store.ledger(r)}))});}
  function validateCampaignReferences(c){for(const id of c.groupIds||[])read('groups',id);for(const id of c.contactIds||[])getContact(id);}
  const actions={
    snapshot:async()=>snapshot(),
    connect:async()=>{if(store.getMode()==='whatsapp'&&!settings().unofficialAcknowledged)throw error('Confirme em Configurações que a integração é não oficial antes de conectar.','INTEGRATION_ACK_REQUIRED');await adapter.connect({reconnect:true});store.setSetting('manualDisconnect',false);if(ready())await refreshGroups();audit('connection.connect');return {...adapter.status};},
    reconnect:async()=>actions.connect(),
    disconnect:async()=>{store.setSetting('manualDisconnect',true);await adapter.disconnect({logout:false,manual:true});audit('connection.disconnect');return {...adapter.status};},
    testConnection:async()=>adapter.testConnection?adapter.testConnection():{ready:ready(),verified:false,simulation:store.getMode()==='simulated',detail:'A integração não disponibilizou uma consulta autenticada de teste.'},
    listGroups:async()=>({items:store.listAll('groups',{}),lastSyncAt:store.getSetting('lastGroupSyncAt',null),error:store.getSetting('lastGroupError',null),connected:ready()}),
    refreshGroups:async()=>refreshGroups(),
    refreshParticipants:async p=>refreshParticipants(p.groupId||p.id),
    listParticipants:async p=>actions.listContacts({...p,groupId:p.groupId||p.id}),
    listContacts:async p=>{const page=store.list('contacts',boundedPage(p));return {...page,items:page.items.map(decorateContact)};},
    updateContact:async p=>updateContact(p.id,p.changes||p.contact||p),
    authorizeContacts:async p=>{
      if(!Array.isArray(p.ids)||p.ids.length<1||p.ids.length>5000||p.ids.some(id=>typeof id!=='string'||!id||id.length>512))throw error('Selecione de 1 a 5.000 contatos.','CONTACT_SELECTION_INVALID');
      if(p.authorized!==undefined&&typeof p.authorized!=='boolean')throw error('Autorização inválida.','AUTHORIZATION_INVALID');
      const authorized=p.authorized!==false,consentNote=authorized?validateConsent(p.consentNote):undefined,ids=[...new Set(p.ids)];
      return store.transaction(()=>{
        const items=[],skipped=[];
        for(const id of ids){
          const contact=store.get('contacts',id);
          if(!contact){skipped.push({id,name:null,code:'CONTACT_NOT_FOUND',reason:'O contato não existe mais neste ambiente. Atualize a lista de participantes.'});continue;}
          const block=authorized?authorizationBlock(contact):null;
          if(block){skipped.push({id,name:contactLabel(contact),code:block.code,reason:block.reason});continue;}
          items.push(updateContact(id,{authorized,consentNote}));
        }
        const summary={selected:ids.length,authorized:authorized?items.length:0,revoked:authorized?0:items.length,skipped:skipped.length};
        const message=items.length?`${items.length} ${authorized?'autorização(ões) registrada(s)':'autorização(ões) revogada(s)'}.${skipped.length?` ${skipped.length} contato(s) não alterado(s); confira os motivos.`:''}`:`Nenhum contato foi ${authorized?'autorizado':'alterado'}. Confira o motivo de cada contato não alterado.`;
        audit('contacts.authorization.batch',{...summary,requestedAuthorization:authorized,skipped:skipped.map(({id,code})=>({id,code}))});
        return {items,skipped,summary,message};
      });
    },
    listCampaigns:async p=>store.list('campaigns',boundedPage(p)),
    saveCampaign:async p=>{
      const input=p.campaign||p,old=input.id?store.get('campaigns',input.id):null;
      if(old&&input.revision!==undefined&&Number(input.revision)!==old.revision)throw error('A campanha mudou. Abra novamente antes de salvar.','CAMPAIGN_CHANGED');
      const value=models.validateCampaign(input,{existing:old||{},minimumSpacingMs:adapter.minimumSpacingMs||3000});validateCampaignReferences(value);
      const ongoing=old&&store.listAll('runs',{campaignId:old.id,status:['active','scheduled','paused']}).length>0;
      const protectedFields=['message','communityLink','fallbackName','mode','groupIds','contactIds'];
      if(ongoing&&protectedFields.some(key=>digest(old[key])!==digest(value[key])))throw error('Encerre a execução atual antes de alterar a mensagem ou os destinatários. O intervalo e os limites podem ser ajustados sem encerrar.','CAMPAIGN_RUN_FROZEN');
      const saved=store.save('campaigns',{...value,id:old?.id||value.id||randomUUID(),status:old?.status||'draft',createdAt:old?.createdAt||now(),updatedAt:now()});previews.clear();audit(old?'campaign.update':'campaign.create',{campaignId:saved.id});return saved;
    },
    duplicateCampaign:async p=>{const old=read('campaigns',p.id);return actions.saveCampaign({campaign:{...old,id:undefined,name:`${old.name} — cópia`.slice(0,120),revision:0,status:'draft'}});},
    deleteCampaign:async p=>{read('campaigns',p.id);if(store.listAll('jobs',{campaignId:p.id,status:'processing'}).length)throw error('Existe um envio em andamento. Aguarde o resultado antes de excluir.','SEND_IN_PROGRESS');await queue.stop(p.id);store.remove('campaigns',p.id);previews.clear();audit('campaign.delete',{campaignId:p.id});return true;},
    previewCampaign:async p=>{
      const c=read('campaigns',p.id),preview=await queue.preview(c);
      const token=randomUUID(),recipients=preview.recipients.map(contact=>({...contact,text:models.renderMessage(c,contact)}));
      previews.set(token,{id:c.id,revision:c.revision,createdAt:now(),fingerprint:stateFingerprint(c,preview),recipientIds:recipients.map(r=>r.id),activationKey:randomUUID(),result:null});
      if(previews.size>30)previews.delete(previews.keys().next().value);
      return {...preview,recipients,token,previewToken:token,campaignRevision:c.revision,message:c.message,communityLink:c.communityLink,mode:c.mode};
    },
    activateCampaign:async p=>{
      const token=previews.get(p.previewToken||p.token);if(!token||token.id!==p.id||now()-token.createdAt>300000)throw error('A prévia venceu. Revise os contatos e confirme novamente.','PREVIEW_REQUIRED');
      if(token.result)return token.result;
      const c=read('campaigns',p.id),fresh=await queue.preview(c);
      if(token.revision!==c.revision||token.fingerprint!==stateFingerprint(c,fresh))throw error('A campanha, a autorização ou o histórico dos contatos mudou. Gere outra prévia.','PREVIEW_CHANGED');
      if(c.mode==='all'&&fresh.previousCount>0&&p.confirmRepeat!==true)throw error('Confirme explicitamente o reenvio aos contatos já convidados.','REPEAT_CONFIRMATION_REQUIRED');
      token.result=await queue.activate(c.id,{activationKey:token.activationKey,recipientIds:token.recipientIds,confirmRepeat:p.confirmRepeat===true});audit('campaign.activate',{campaignId:c.id,runId:token.result?.id||token.result?.runId});return token.result;
    },
    pauseCampaign:async p=>{read('campaigns',p.id);return queue.pause(p.id);},
    resumeCampaign:async p=>{read('campaigns',p.id);return queue.resume(p.id);},
    stopCampaign:async p=>{read('campaigns',p.id);return queue.stop(p.id);},
    stopAll:async()=>{previews.clear();const result=await queue.stopAll();audit('automation.stop');return result;},
    resumeAutomation:async()=>{const result=await queue.resumeAutomation();audit('automation.resume');return result;},
    listRuns:async p=>store.list('runs',boundedPage(p)),
    listHistory:async p=>{const page=store.list('history',boundedPage(p));return {...page,items:page.items.map(row=>{const job=row.jobId?store.get('jobs',row.jobId):null;return {...row,...job,id:row.id,jobId:row.jobId,at:row.at};})};},
    clearHistory:async p=>{if(p.confirmation!=='APAGAR')throw error('Digite APAGAR para limpar somente o histórico visual.');let removed=0;store.transaction(()=>{for(const row of store.listAll('history',{})){store.remove('history',row.id);removed++;}audit('history.clear',{removed,operationalLedgerPreserved:true});});return {removed,operationalLedgerPreserved:true};},
    listTemplates:async p=>store.list('templates',boundedPage(p)),
    saveTemplate:async p=>{const value=models.validateTemplate(p.template||p),old=value.id?store.get('templates',value.id):null;return store.save('templates',{...value,id:old?.id||value.id||randomUUID(),createdAt:old?.createdAt||now(),updatedAt:now()});},
    duplicateTemplate:async p=>{const value=read('templates',p.id);return actions.saveTemplate({template:{...value,id:undefined,name:`${value.name} — cópia`.slice(0,120)}});},
    deleteTemplate:async p=>{read('templates',p.id);store.remove('templates',p.id);return true;},
    saveSettings:async p=>{
      const next=models.validateSettings({...settings(),...(p.settings||p)}),requested=next.integrationMode||store.getMode();
      if(requested!==store.getMode()){
        if(taskRunning())throw error('Aguarde a conclusão do envio em andamento antes de trocar o modo.','SEND_IN_PROGRESS');
        maintenance=true;try{await queue.stopAll();await adapter.disconnect({logout:false,manual:true});store.setMode(requested);adapter=makeAdapter();queue.setAdapter(adapter);bind(adapter);previews.clear();participantsSync.clear();groupSync=null;}finally{maintenance=false;}
      }
      const result={...settings(),...next,integrationMode:store.getMode()};store.setSetting('settings',result);await host('settings.apply',{launchAtLogin:result.launchAtLogin,minimizeToTray:result.minimizeToTray});audit('settings.update');return result;
    },
    backup:async()=>{if(taskRunning())throw error('Aguarde o envio em andamento antes do backup.');const target=await host('dialogs.saveBackup',{suggestedName:`Automacao-Comunidade-Backup-${new Date(now()).toISOString().slice(0,10)}.sqlite`});if(!target)return {cancelled:true};if(typeof target!=='string'||!target.toLowerCase().endsWith('.sqlite'))throw error('Escolha um arquivo .sqlite.');if(path.resolve(target).startsWith(path.resolve(dir,'credentials')+path.sep))throw error('Escolha um destino fora da pasta de credenciais.');await store.backupTo(target);audit('backup.created');return {saved:true,path:target,credentialsIncluded:false};},
    restore:async p=>{if(taskRunning())throw error('Aguarde o envio em andamento antes de restaurar.','SEND_IN_PROGRESS');if(p.confirmation!=='RESTAURAR')throw error('Digite RESTAURAR para confirmar a recuperação dos dados.');const selected=await host('dialogs.openBackup',{});if(!selected)return {cancelled:true};if(taskRunning()||queue.getState().inFlight)throw error('Existe um envio em andamento. Aguarde a confirmação antes de restaurar.','SEND_IN_PROGRESS');maintenance=true;try{await queue.stopAll();const previousMode=store.getMode();const result=await store.restoreFrom(selected);store.setMode(previousMode);queue.setAdapter(adapter);previews.clear();audit('backup.restored');return {...result,restored:true,automaticResume:false};}finally{maintenance=false;}},
    exportHistory:async()=>{const target=await host('dialogs.saveHistory',{suggestedName:`Automacao-Comunidade-Historico-${new Date(now()).toISOString().slice(0,10)}.json`});if(!target)return {cancelled:true};const content=JSON.stringify({appName:APP_NAME,generatedAt:now(),rows:store.listAll('history',{})},null,2),temporary=target+'.'+randomUUID()+'.tmp';await fs.promises.writeFile(temporary,content,{mode:0o600});await fs.promises.rename(temporary,target);return {saved:true,path:target};},
    reconcileJob:async p=>{read('jobs',p.id);return queue.reconcileJob(p.id);},
    retryJob:async p=>{read('jobs',p.id);return queue.retryJob(p.id,{confirmPossibleDuplicate:p.confirmPossibleDuplicate===true});},
    testSimulation:async()=>{if(store.getMode()!=='simulated')throw error('Disponível somente no modo de simulação.','SIMULATION_ONLY');if(!adapter.testSimulation)throw error('Simulador indisponível.');const result=await adapter.testSimulation();if(!ready())await adapter.connect();await refreshGroups();return {...result,simulation:true};},
    windowMinimize:async()=>host('windowMinimize',{}),windowQuit:async()=>host('windowQuit',{}),openDataFolder:async()=>host('openDataFolder',{})
  };
  adapter=makeAdapter();queue=new InviteQueue({store,adapter,now});bind(adapter);queue.on('change',()=>broadcast());queue.on('diagnostic',record=>{try{store.diagnostics({...record,id:record.id||randomUUID(),at:record.at||now()});}catch{}});queue.start();
  const immediate=new Set(['snapshot','pauseCampaign','stopCampaign','stopAll','testConnection','listGroups','listParticipants','listContacts','listHistory','listRuns','listCampaigns','listTemplates','windowMinimize','windowQuit']);
  events.call=async(action,payload={})=>{
    if(closed)throw error('O aplicativo está encerrado.','APP_CLOSED');if(!Object.hasOwn(actions,action))throw error('Ação não permitida.','ACTION_NOT_ALLOWED');
    const invoke=async()=>{if(closed)throw error('O aplicativo está encerrado.','APP_CLOSED');if(maintenance&&!['snapshot','stopAll'].includes(action))throw error('Aguarde a manutenção dos dados.','MAINTENANCE');return actions[action](payload||{});};
    try{const result=await(immediate.has(action)?invoke():serialized(invoke));if(action!=='snapshot')broadcast();return result;}catch(err){diagnostic(action,err);broadcast();throw err;}
  };
  events.systemCall=async(action,payload={})=>{if(action==='shutdown')return events.shutdown();if(action==='stopAll')return actions.stopAll();if(action==='settings')return settings();if(action==='suspend'){await queue.pauseForSuspend();return true;}if(action==='resume'){await queue.onResume();broadcast();return true;}throw error('Ação interna não permitida.','SYSTEM_ACTION_DENIED');};
  events.snapshot=snapshot;
  events.shutdown=async()=>{if(closed)return;closed=true;clearTimeout(updateTimer);await queue.shutdown();await adapter.disconnect({logout:false,manual:false});await mutation.catch(()=>{});store.close();};
  const previous=settings();await host('settings.apply',{launchAtLogin:previous.launchAtLogin,minimizeToTray:previous.minimizeToTray}).catch(()=>{});
  return events;
}

module.exports={createService,APP_NAME};
