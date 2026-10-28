'use strict';

const {randomUUID} = require('node:crypto');
const validation = require('./validation.cjs');

const fault = (message, code) => Object.assign(new Error(message), {code});
class TemplateService {
  constructor({store,auth,media,now=()=>Date.now()}) {
    this.store=store;this.auth=auth;this.media=media;this.now=now;
  }
  _assert(userId,permission) {
    if(!this.auth)throw fault('A validação de acesso aos modelos está indisponível.','AUTH_REQUIRED');
    return this.auth.assertFor(userId??this.auth.currentUserId,permission);
  }
  _get(id) {return this.store.getTemplate?.(id)||this.store.listTemplates().find(t=>t.id===id);}
  _audit(action,template,user) {
    this.store.addAudit({id:randomUUID(),at:this.now(),userId:user.id,userName:user.name,action,templateId:template.id});
  }
  list(userId) {this._assert(userId,'media.view');return this.store.listTemplates();}
  get(id,userId) {
    this._assert(userId,'media.view');const model=this._get(id);
    if(!model)throw fault('Modelo não encontrado neste modo de operação.','TEMPLATE_NOT_FOUND');
    return model;
  }
  save(input,userId) {
    input=input?.template||input||{};
    const old=input.id?this._get(input.id):undefined;
    if(input.id&&!old)throw fault('O modelo não existe neste modo. Atualize a biblioteca.','TEMPLATE_NOT_FOUND');
    const user=this._assert(userId,old?'media.edit':'media.create');
    const name=typeof input.name==='string'?input.name.trim():'';
    if(!name||name.length>120||/[\x00-\x1f]/.test(name))throw fault('Informe um nome de modelo de 1 a 120 caracteres.','TEMPLATE_NAME_INVALID');
    const items=validation.items(input.items,this.store);
    if(!items.length)throw fault('Adicione ao menos um texto ou arquivo ao modelo.','TEMPLATE_EMPTY');
    for(const item of items)if(item.type!=='text')this.media.getPath(item.mediaId);
    if(old&&input.expectedUpdatedAt!==undefined&&Number(input.expectedUpdatedAt)!==Number(old.updatedAt??old.createdAt))throw fault('O modelo foi alterado. Reabra-o antes de salvar.','TEMPLATE_STALE');
    const model={...old,id:old?.id||randomUUID(),name,items,createdAt:old?.createdAt??this.now(),updatedAt:this.now(),createdBy:old?.createdBy??user.id,updatedBy:user.id};
    return this.store.transaction(()=>{
      this.store.saveTemplate(model);
      const persisted=this._get(model.id);
      if(!persisted||persisted.name!==model.name||JSON.stringify(persisted.items)!==JSON.stringify(model.items)||persisted.updatedAt!==model.updatedAt)throw fault('O modelo não foi persistido. Verifique o armazenamento e tente novamente.','TEMPLATE_PERSIST_FAILED');
      this._audit(old?'media.templateEdit':'media.templateCreate',persisted,user);
      return persisted;
    });
  }
  duplicate(id,userId) {
    const original=this.get(id,userId);this._assert(userId,'media.create');
    const copy=this.save({name:`${original.name.slice(0,110)} (cópia)`,items:original.items.map(i=>({...i,id:randomUUID()}))},userId);
    return copy;
  }
  delete(id,userId) {
    const user=this._assert(userId,'media.delete'),original=this._get(id);
    if(!original)throw fault('Modelo não encontrado neste modo de operação.','TEMPLATE_NOT_FOUND');
    return this.store.transaction(()=>{
      this.store.deleteTemplate(id);
      if(this._get(id))throw fault('Não foi possível excluir o modelo do banco.','TEMPLATE_DELETE_FAILED');
      this._audit('media.templateDelete',original,user);return {deleted:true,id};
    });
  }
  apply(id,userId) {
    const model=this.get(id,userId);
    for(const item of model.items)if(item.type!=='text')this.media.getPath(item.mediaId);
    return {templateId:model.id,name:model.name,items:model.items.map(item=>({...item,id:randomUUID()}))};
  }
}
module.exports={TemplateService};
