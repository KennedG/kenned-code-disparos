'use strict';

function soundPreferences(value={}){
  const volume=Number(value.volume??60),interval=Number(value.intervalSeconds??30),count=Number(value.maxRepeats??3);
  return {enabled:value.enabled!==false,volume:Number.isFinite(volume)?Math.max(0,Math.min(100,volume)):60,sound:['soft','urgent','custom'].includes(value.sound)?value.sound:'soft',customAudioId:value.customAudioId||null,events:Array.isArray(value.events)?value.events.filter(v=>['disconnect','critical'].includes(v)):['disconnect','critical'],repeat:!!value.repeat,intervalSeconds:Number.isFinite(interval)?Math.max(3,Math.min(3600,interval)):30,maxRepeats:Number.isFinite(count)?Math.max(1,Math.min(20,Math.floor(count))):3,quiet:{enabled:!!value.quiet?.enabled,start:value.quiet?.start||'22:00',end:value.quiet?.end||'07:00'}};
}
function isQuiet(at,quiet){
  if(!quiet?.enabled)return false;
  const parse=t=>/^([01]\d|2[0-3]):[0-5]\d$/.test(t)?Number(t.slice(0,2))*60+Number(t.slice(3)):NaN;
  const start=parse(quiet.start),end=parse(quiet.end),date=new Date(at),now=date.getHours()*60+date.getMinutes();
  if(!Number.isFinite(start)||!Number.isFinite(end))return false;
  return start===end||start<end?(start===end||now>=start&&now<end):(now>=start||now<end);
}
class SoundController{
  constructor({play,stop=()=>{},now=()=>Date.now(),setTimer=setTimeout,clearTimer=clearTimeout}={}){
    this.play=play;this.stop=stop;this.now=now;this.setTimer=setTimer;this.clearTimer=clearTimer;
    this.occurrences=new Map();this.queue=[];this.current=null;this.closed=false;
  }
  handle(event,value,options={}){
const prefs=soundPreferences(value),id=String(event.id||'');
    if(this.closed||!id)return {soundStatus:'disabled'};
    if(this.occurrences.has(id))return {soundStatus:'suppressed'};
    if(!options.force&&(!prefs.enabled||!prefs.events.includes(event.event)))return {soundStatus:'disabled'};
    if(!options.force&&isQuiet(this.now(),prefs.quiet))return {soundStatus:'quiet'};
    if(prefs.volume===0)return {soundStatus:'silent',volume:0};
    const entry={id,event:event.event,prefs,audioUrl:options.audioUrl,played:0,muted:false,timer:null,force:!!options.force};
    this.occurrences.set(id,entry);
    if(this.occurrences.size>512){for(const [key,old]of this.occurrences){if(old!==this.current&&!old.timer&&!this.queue.includes(old)){this.occurrences.delete(key);break;}}}
    this._enqueue(entry);return {soundStatus:'scheduled',volume:prefs.volume};
  }
  test(value,options={}){
    const prefs=soundPreferences(value);
    if(this.closed)return Promise.resolve({soundStatus:'disabled'});
    if(prefs.volume===0)return Promise.resolve({soundStatus:'silent',volume:0});
    const id='test-'+Math.random().toString(36).slice(2);
    return new Promise(resolve=>{
      const entry={id,event:'test',prefs,audioUrl:options.audioUrl,played:0,muted:false,timer:null,force:true,onDone:success=>resolve({soundStatus:success?'completed':'failed',volume:prefs.volume})};
      this.occurrences.set(id,entry);this._enqueue(entry);
    });
  }
  _enqueue(entry){if(this.closed||entry.muted||this.queue.includes(entry)||this.current===entry)return;if(this.queue.length>=50){const dropped=this.queue.shift();dropped.muted=true;dropped.onDone?.(false);this.occurrences.delete(dropped.id);}this.queue.push(entry);void this._pump();}
  async _pump(){
    if(this.current||this.closed)return;const entry=this.queue.shift();if(!entry)return;
    if(entry.muted||(!entry.force&&isQuiet(this.now(),entry.prefs.quiet))){void this._pump();return;}
    this.current=entry;
    try{await this.play({id:entry.id,sound:entry.prefs.sound,volume:entry.prefs.volume/100,audioUrl:entry.audioUrl});entry.played++;entry.onDone?.(true);}
    catch{entry.muted=true;entry.onDone?.(false);}
    finally{
      this.current=null;
      if(!entry.muted&&!this.closed&&entry.prefs.repeat&&!entry.force&&entry.played<entry.prefs.maxRepeats){entry.timer=this.setTimer(()=>{entry.timer=null;this._enqueue(entry);},entry.prefs.intervalSeconds*1000);entry.timer.unref?.();}
      void this._pump();
    }
  }
  mute(id){const entry=this.occurrences.get(id);if(!entry)return false;entry.muted=true;entry.onDone?.(false);if(entry.timer)this.clearTimer(entry.timer);entry.timer=null;this.queue=this.queue.filter(v=>v!==entry);if(this.current===entry)this.stop(id);return true;}
  shutdown(){this.closed=true;for(const entry of this.occurrences.values()){entry.muted=true;entry.onDone?.(false);if(entry.timer)this.clearTimer(entry.timer);}this.queue=[];if(this.current)this.stop(this.current.id);this.occurrences.clear();}
}
module.exports={SoundController,soundPreferences,isQuiet};
