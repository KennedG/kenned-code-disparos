'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {SoundController,soundPreferences,isQuiet}=require('../src/core/sound.cjs');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){const calls=[],timers=new Map();let sequence=0;const controller=new SoundController({play:async payload=>{calls.push(payload);},setTimer:(fn,ms)=>{const id=++sequence;timers.set(id,{fn,ms});return id;},clearTimer:id=>timers.delete(id),now:()=>new Date(2026,0,1,12).getTime()});return{controller,calls,timers};}
test('sound volume clamps to the Windows audio gain range including mute',async()=>{
  const {controller,calls}=fixture();
  assert.equal(soundPreferences({volume:150}).volume,100);assert.equal(soundPreferences({volume:-10}).volume,0);
  assert.deepEqual(await controller.test({volume:0}),{soundStatus:'silent',volume:0});assert.equal(calls.length,0);
  assert.equal((await controller.test({volume:37})).soundStatus,'completed');assert.equal(calls[0].volume,0.37);
  controller.shutdown();
});
test('duplicate occurrences play once and disabled event types stay silent',async()=>{
  const {controller,calls}=fixture();
  assert.equal(controller.handle({id:'disconnect-1',event:'disconnect'},{volume:50}).soundStatus,'scheduled');
  assert.equal(controller.handle({id:'disconnect-1',event:'disconnect'},{volume:50}).soundStatus,'suppressed');
  assert.equal(controller.handle({id:'critical-1',event:'critical'},{events:['disconnect']}).soundStatus,'disabled');
  assert.equal(controller.handle({id:'disconnect-2',event:'disconnect'},{enabled:false}).soundStatus,'disabled');
  await settle();assert.equal(calls.length,1);controller.shutdown();
});
test('overnight quiet hours suppress alerts but explicit tests can play',async()=>{
  const quiet={enabled:true,start:'22:00',end:'07:00'};
  assert.equal(isQuiet(new Date(2026,0,1,23).getTime(),quiet),true);assert.equal(isQuiet(new Date(2026,0,2,6).getTime(),quiet),true);assert.equal(isQuiet(new Date(2026,0,2,8).getTime(),quiet),false);
  const calls=[],controller=new SoundController({now:()=>new Date(2026,0,1,23).getTime(),play:async p=>calls.push(p)});
  assert.equal(controller.handle({id:'night',event:'critical'},{quiet}).soundStatus,'quiet');
  assert.equal((await controller.test({quiet,enabled:false})).soundStatus,'completed');assert.equal(calls.length,1);controller.shutdown();
});
test('repeats respect the configured interval and total limit',async()=>{
  const {controller,calls,timers}=fixture();controller.handle({id:'failure',event:'critical'},{repeat:true,maxRepeats:3,intervalSeconds:12});await settle();
  assert.equal(timers.size,1);assert.equal([...timers.values()][0].ms,12000);
  for(let i=0;i<2;i++){const [id,timer]=[...timers.entries()][0];timers.delete(id);timer.fn();await settle();}
  assert.equal(calls.length,3);assert.equal(timers.size,0);controller.shutdown();
});
test('muting an occurrence cancels repeats and stops current playback',async()=>{
  const {controller,calls,timers}=fixture();controller.handle({id:'failure',event:'critical'},{repeat:true});await settle();assert.equal(timers.size,1);assert.equal(controller.mute('failure'),true);assert.equal(timers.size,0);assert.equal(calls.length,1);controller.shutdown();
  let resolve,stopped;const running=new SoundController({play:()=>new Promise(r=>resolve=r),stop:id=>{stopped=id;resolve();}});running.handle({id:'playing',event:'disconnect'},{});assert.equal(running.mute('playing'),true);await settle();assert.equal(stopped,'playing');running.shutdown();
});
test('different alerts never play concurrently and playback failures are reported',async()=>{
  let complete,active=0,max=0;const calls=[];const controller=new SoundController({play:payload=>{calls.push(payload.id);active++;max=Math.max(max,active);return new Promise(resolve=>complete=()=>{active--;resolve();});}});
  controller.handle({id:'one',event:'critical'},{});controller.handle({id:'two',event:'disconnect'},{});assert.deepEqual(calls,['one']);complete();await settle();assert.deepEqual(calls,['one','two']);complete();await settle();assert.equal(max,1);controller.shutdown();
  const broken=new SoundController({play:async()=>{throw new Error('Codec indisponível');}});assert.equal((await broken.test({sound:'custom'})).soundStatus,'failed');broken.shutdown();
});
