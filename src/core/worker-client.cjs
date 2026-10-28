'use strict';

const {EventEmitter}=require('node:events');

class WorkerClient extends EventEmitter {
  constructor(worker,{host=async()=>{throw new Error('Recurso nativo indisponível.');},startupTimeoutMs=120000}={}) {
    super();this.worker=worker;this.host=host;this.pending=new Map();this.sequence=0;this.closed=false;
    this.ready=new Promise((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject;});
    this.startupTimer=setTimeout(()=>this._failed(new Error('O processamento das campanhas não iniciou no prazo esperado.')),startupTimeoutMs);
    this.startupTimer.unref?.();
    worker.on('message',message=>this._message(message));
    worker.on('error',error=>this._failed(error));
    worker.on('exit',code=>{if(!this.closed)this._failed(new Error(`O processamento foi interrompido (código ${code}).`));});
  }
  async _message(message) {
    if(message?.type==='ready'){clearTimeout(this.startupTimer);this.resolveReady(message.payload);return;}
    if(message?.type==='event'){this.emit(message.name,message.payload);return;}
    if(message?.type==='startupError'){this._failed(new Error(message.error||'Não foi possível abrir os dados.'));return;}
    if(message?.type==='result'){
      const request=this.pending.get(message.id);if(!request)return;
      this.pending.delete(message.id);clearTimeout(request.timer);
      if(message.error)request.reject(Object.assign(new Error(message.error),{code:message.code}));else request.resolve(message.result);
      return;
    }
    if(message?.type==='hostCall'){
      try{const result=await this.host(message.action,message.payload);if(!this.closed)this.worker.postMessage({type:'hostResult',id:message.id,result});}
      catch(error){if(!this.closed)this.worker.postMessage({type:'hostResult',id:message.id,error:error.message||'Não foi possível concluir a operação nativa.'});}
    }
  }
  _failed(error){
    if(this.closed)return;this.closed=true;clearTimeout(this.startupTimer);this.rejectReady(error);
    for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(error);}this.pending.clear();
    this.emit('fatal',error);
  }
  async request(action,payload={},system=false,{timeoutMs=0}={}){
    await this.ready;if(this.closed)throw new Error('O processamento está indisponível. Reabra o aplicativo.');
    if(this.pending.size>=128)throw new Error('Aguarde as operações em andamento terminarem.');
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=timeoutMs?setTimeout(()=>{this.pending.delete(id);reject(new Error('A operação excedeu o tempo de espera.'));},timeoutMs):null;
      this.pending.set(id,{resolve,reject,timer});this.worker.postMessage({type:'call',id,action,payload,system});
    });
  }
  call(action,payload){return this.request(action,payload,false);}
  systemCall(action,payload){return this.request(action,payload,true);}
  async shutdown(){
    if(this.closed)return;
    try{await this.request('shutdown',{},true,{timeoutMs:15000});}finally{this.closed=true;clearTimeout(this.startupTimer);await this.worker.terminate();for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(new Error('Aplicativo encerrado.'));}this.pending.clear();}
  }
}
module.exports={WorkerClient};
