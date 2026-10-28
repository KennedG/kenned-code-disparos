'use strict';
let active=null;
async function stop(){if(!active)return;const old=active;active=null;if(old.audio){old.audio.pause();old.audio.src='';}if(old.context)await old.context.close().catch(()=>{});clearTimeout(old.timer);window.megaAudio.ended(old.id,true);}
window.megaAudio.onStop(value=>{if(active?.id===value.id)void stop();});
window.megaAudio.onPlay(async value=>{
  await stop();const state={id:value.id};active=state;
  const done=async success=>{if(active!==state)return;active=null;clearTimeout(state.timer);if(state.audio){state.audio.pause();state.audio.src='';}if(state.context)await state.context.close().catch(()=>{});window.megaAudio.ended(value.id,success);};
  try{
    const gain=Math.max(0,Math.min(1,Number(value.volume)||0));
    const requested=Number(value.durationSeconds),configuredDuration=Number.isFinite(requested)&&requested>=0.2&&requested<=30?requested:null;
    if(value.sound==='custom'){
      if(!value.audioUrl)throw new Error('Arquivo ausente.');
      state.audio=new Audio(value.audioUrl);state.audio.volume=gain;state.audio.onended=()=>void done(true);state.audio.onerror=()=>void done(false);state.timer=setTimeout(()=>void done(!!configuredDuration),configuredDuration?configuredDuration*1000:15000);await state.audio.play();
    }else{
      state.context=new AudioContext();await state.context.resume();
      const output=state.context.createGain();output.gain.value=gain;output.connect(state.context.destination);
      const tones=value.sound==='urgent'?[880,660,880]:[523,659];const duration=value.sound==='urgent'?0.18:0.24;
      const count=configuredDuration?Math.ceil(configuredDuration/(duration+0.1)):tones.length;
      for(let index=0;index<count;index++){const oscillator=state.context.createOscillator(),envelope=state.context.createGain();oscillator.frequency.value=tones[index%tones.length];oscillator.type='sine';const at=state.context.currentTime+index*(duration+0.1),length=configuredDuration?Math.min(duration,configuredDuration-index*(duration+0.1)):duration;envelope.gain.setValueAtTime(0,at);envelope.gain.linearRampToValueAtTime(0.2,at+Math.min(0.025,length/2));envelope.gain.exponentialRampToValueAtTime(0.001,at+length);oscillator.connect(envelope);envelope.connect(output);oscillator.start(at);oscillator.stop(at+length);}
      state.timer=setTimeout(()=>void done(true),(configuredDuration||(tones.length*(duration+0.1)+0.1))*1000);
    }
  }catch{await done(false);}
});
