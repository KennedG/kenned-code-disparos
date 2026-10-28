'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const validation=require('../core/validation.cjs');

// All desktop operations go through fresh backend permissions. These services
// never trust the page's buttons, an audience name or an unverified phone.
function businessActions({store,auth,finance,commercial,commerceAutomation,scheduler,audit,now,host,dir}) {
  const actor=()=>auth.currentUser()?.id;
  const requirePermissions=(...ids)=>{for(const id of ids)auth.assert(id);return actor();};
  const payload=(p,key)=>p[key]||p;
  const financial=(method,key)=>async p=>{const id=requirePermissions('finance.manage','finance.view');const result=finance[method](payload(p,key),id);audit(`finance.${method}`,{subjectId:result?.id||p.saleId||p.id});return result;};
  const stockWrite=(method,key)=>async p=>{const id=requirePermissions('stock.manage','finance.manage','finance.view');const result=finance[method](payload(p,key),id);audit(`stock.${method}`,{subjectId:result?.id||p.id});return result;};
  const getLists=()=>commercial.listCommercialLists();
  return {
    listInventory:async()=>{requirePermissions('stock.view');return finance.snapshot({financial:auth.can('finance.view')}).inventory;},
    saveInventory:stockWrite('saveInventory','inventory'),
    saveSupplier:async p=>{const id=requirePermissions('supplier.manage','finance.manage','finance.view');const result=finance.saveSupplier(payload(p,'supplier'),id);audit('supplier.save',{supplierId:result.id});return result;},
    recordPurchase:async p=>{const id=requirePermissions('supplier.manage','stock.manage','finance.manage','finance.view');return finance.recordPurchase(payload(p,'purchase'),id);},
    reserveInventory:stockWrite('reserve','reservation'),
    releaseReservation:stockWrite('releaseReservation','reservation'),
    createSale:financial('createSale','sale'),recordSalePayment:financial('recordPayment','payment'),
    cancelSale:financial('cancelSale','cancellation'),refundSale:financial('refundSale','refund'),refundReservation:financial('refundReservation','refund'),returnSaleStock:stockWrite('returnStock','return'),correctSale:financial('correctSale','correction'),
    openCash:financial('openCash','cash'),addCashMovement:financial('addCashMovement','movement'),closeCash:financial('closeCash','cash'),
    getDailyReport:async p=>{requirePermissions('finance.reports','finance.view');return finance.dailyReport(p.date,p.timezone||'America/Sao_Paulo');},
    getCommercialReport:async p=>{requirePermissions('finance.reports','finance.view');return finance.periodReports(p);},
    listContactCategories:async()=>{requirePermissions('contacts.view');return commercial.listCategories();},
    saveContactCategory:async p=>{const id=requirePermissions('contacts.edit');return commercial.saveCategory(payload(p,'category'),id);},
    deleteContactCategory:async p=>{const id=requirePermissions('contacts.edit');return commercial.deleteCategory(p.id,id);},
    saveCommercialSettings:async p=>{const id=requirePermissions('commerce.list','finance.manage');return commercial.saveSettings(payload(p,'settings'),id);},
    saveCommercialList:async p=>{const id=requirePermissions('commerce.list','finance.view');const input=payload(p,'list');if(input.lines?.some(l=>l.sourceType==='offer'))requirePermissions('search.view');return commercial.saveCommercialList(input,id);},
    deleteCommercialList:async p=>{const id=requirePermissions('commerce.list');return commercial.deleteCommercialList(p.id,id);},
    previewCommercialList:async p=>{requirePermissions('commerce.view');return (()=>{const v=commercial.previewCommercialList(p.id);if(!auth.can('finance.view')){delete v.totalCostCents;delete v.totalEstimatedProfitCents;}return v;})();},
    createCommercialCampaign:async p=>{
      const id=requirePermissions('commerce.list','campaign.create');
      const list=getLists().find(l=>l.id===p.listId);if(!list)throw new Error('Lista comercial não encontrada.');
      const raw={name:p.name||list.name,mode:'repeat',intervalMinutes:p.intervalMinutes??10,spacingSeconds:p.spacingSeconds??3,schedule:p.schedule||{days:[1,2,3,4,5,6],startTime:'08:00',endTime:'18:00'},groupIds:p.groupIds||[],contactIds:p.contactIds||[],items:commercial.toCampaignItems(p.listId),ownerId:id,audience:list.audience,commercialListId:list.id,promotionPolicy:{repeatLimit:p.repeatLimit??p.maxOfferRepetitions??1}};
      const campaign=validation.campaign(raw,store);campaign.items=raw.items;campaign.inventoryIds=[...new Set(raw.items.flatMap(i=>(i.commercialRef?.lines||[]).filter(l=>l.sourceType==='inventory').map(l=>l.sourceId)))];campaign.audience=list.audience;campaign.commercialListId=list.id;campaign.promotionPolicy=raw.promotionPolicy;
      commercial.validateCampaignAudience(campaign);
      const result=store.saveCampaign({...campaign,state:'draft',nextRunAt:null});audit('commerce.campaignDraft',{campaignId:result.id,listId:list.id});return result;
    },
    savePromotionTarget:async p=>{const id=requirePermissions('commerce.manage');return commercial.setPromotionTarget(payload(p,'target'),id);},
    setPromotionTarget:async p=>{const id=requirePermissions('commerce.manage');return commercial.setPromotionTarget(payload(p,'target'),id);},
    saveOpportunity:async p=>{const id=requirePermissions('commerce.manage');return commerceAutomation.saveOpportunity(payload(p,'opportunity'),id);},
    deleteOpportunity:async p=>commerceAutomation.deleteOpportunity(p.id,requirePermissions('commerce.manage')),
    setOpportunityState:async p=>commerceAutomation.setOpportunityState(p.id,p.enabled,requirePermissions('commerce.manage')),
    saveDemand:async p=>commerceAutomation.saveDemand(payload(p,'demand'),requirePermissions('commerce.manage','finance.view')),
    deleteDemand:async p=>commerceAutomation.deleteDemand(p.id,requirePermissions('commerce.manage')),
    updateDemandStatus:async p=>commerceAutomation.updateDemandStatus(p.id,p.status||p.state,requirePermissions('commerce.manage')),
    setDemandStatus:async p=>commerceAutomation.updateDemandStatus(p.id,p.status||p.state,requirePermissions('commerce.manage')),
    approveDemandMatch:async p=>{
      if(p.approved!==true)throw new Error('Revise e confirme a proposta antes de enviá-la ao comprador.');
      const id=requirePermissions('commerce.manage','campaign.create','finance.view');
      return store.transaction(()=>{
        const result=commerceAutomation.approveDemandMatch({id:p.id||p.matchId,approved:true},id);
        const match=store.getEntity('commerce_matches',result.id);
        if(match.campaignId){const existing=store.getCampaign(match.campaignId);if(existing)return {...result,campaign:existing};}
        const demand=store.getEntity('buyer_demands',result.demandId);
        const list=commercial.saveCommercialList({name:`Proposta — ${demand.model}`.slice(0,120),audience:'retail',lines:[{sourceType:'offer',sourceId:result.offerId,quantity:1,markup:demand.markup}]},id);
        const campaign=store.saveCampaign({id:randomUUID(),name:list.name,demandId:demand.id,commercialApproval:{kind:'demand',matchId:match.id,approvedBy:id,approvedAt:now()},ownerId:id,state:'draft',mode:'repeat',oneShot:true,audience:'retail',commercialListId:list.id,promotionPolicy:{repeatLimit:1},intervalMinutes:10,spacingSeconds:3,schedule:{days:[0,1,2,3,4,5,6],startTime:'00:00',endTime:'00:00'},dailyRoundLimit:1,dailySendLimit:1,groupIds:[],contactIds:[result.contactId],items:commercial.toCampaignItems(list.id),groupOverrides:{},responsibleUserIds:[],alertRecipientIds:[],retryPolicy:{maxAttempts:3,delaySeconds:15},nextRunAt:null,roundIndex:0});
        store.saveEntity('commerce_matches',{...match,campaignId:campaign.id});
        return {...result,campaign,publicText:campaign.items[0].text,requiresPublicationApproval:true};
      });
    },
    saveDailyReportSettings:async p=>commerceAutomation.saveReportSettings(payload(p,'settings'),requirePermissions('finance.reports','finance.manage')),
    generateDailyReport:async p=>commerceAutomation.generateDailyReport({...p,deliver:p.deliver!==false},requirePermissions('finance.reports','finance.view')),
    commerceDeliveryStatus:async p=>{requirePermissions('commerce.manage');const financial=auth.can('finance.view')&&auth.can('finance.reports');if(!financial&&p.kind&&p.kind!=='opportunity')throw new Error('Sem permissão financeira para consultar esta fila.');return store.queryEntities('commerce_deliveries',{...p,...(!financial?{kind:'opportunity'}:{}),limit:Math.min(200,p.limit||50)});},
    backupBusinessData:async()=>{
      requirePermissions('finance.export','finance.view','settings.edit');
      const response=await host('showSaveDialog',{title:'Salvar recuperação completa do banco local',defaultPath:`Kenned-Code-Recuperacao-${new Date(now()).toISOString().slice(0,10)}.sqlite`,filters:[{name:'Banco local de recuperação',extensions:['sqlite']}]});
      if(response.canceled)return {cancelled:true};requirePermissions('finance.export','finance.view','settings.edit');
      if(fs.existsSync(response.filePath))throw new Error('Escolha um nome novo para preservar os backups existentes.');
      const result=store.createRecoverySnapshot(response.filePath);
      const digest=createHash('sha256').update(fs.readFileSync(result.path)).digest('hex');
      const manifest={format:'kenned-local-recovery',version:1,createdAt:now(),schemaVersion:result.schemaVersion,sha256:digest,credentialsIncluded:false,mediaIncluded:false,note:'Banco contém usuários, dados internos e controles operacionais. Guarde em local privado. Preserve também a pasta media; sessões do WhatsApp permanecem protegidas no perfil local.'};
      fs.writeFileSync(result.path+'.json',JSON.stringify(manifest,null,2),{mode:0o600});audit('finance.backup',{bytes:result.bytes});return {...result,sha256:digest,mediaDirectory:path.join(dir,'media')};
    }
  };
}
module.exports={businessActions};
