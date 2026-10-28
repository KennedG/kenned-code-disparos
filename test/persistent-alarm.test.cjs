'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {SoundController}=require('../src/core/sound.cjs');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){let id=0,at=Date.parse('2026-10-13T12:00:00Z');const calls=[],timers=new Map(),controller=new SoundController({now:()=>at,play:async p=>calls.push(p),setTimer:(fn,ms)=>{const key=++id;timers.set(key,{fn,ms});return key;},clearTimer:key=>timers.delete(key)});return {calls,timers,controller,setAt:value=>{at=value;},async tick(){const [key,timer]=timers.entries().next().value;timers.delete(key);timer.fn();await settle();}};}

test('a campaign-blocking incident persists beyond the ordinary repeat limit, deduplicates and silences only that incident',async t=>{
 const f=fixture();t.after(()=>f.controller.shutdown());const event={id:'incident:disconnect',event:'disconnect',persistentAlarm:true};
 assert.equal(f.controller.handle(event,{volume:35,maxRepeats:1,repeat:false,intervalSeconds:3}).persistent,true);await settle();
 for(let i=0;i<6;i++)await f.tick();assert.equal(f.calls.length,7);assert.equal(f.calls[0].volume,.35);assert.equal(f.controller.handle(event,{volume:35}).soundStatus,'suppressed');
 assert.equal(f.controller.mute(event.id),true);assert.equal(f.timers.size,0);assert.equal(f.controller.closed,false);
 f.controller.handle({id:'new-incident',event:'disconnect',persistentAlarm:true},{volume:35,intervalSeconds:3});await settle();assert.equal(f.calls.length,8);
});

test('confirmed recovery cancels the active sound and its repeats without muting future incidents',async t=>{
 let complete;const stopped=[],calls=[];const controller=new SoundController({play:p=>{calls.push(p);return new Promise(r=>{complete=r;});},stop:id=>{stopped.push(id);complete();}});t.after(()=>controller.shutdown());
 controller.handle({id:'recovery',event:'critical',persistentAlarm:true},{});assert.equal(controller.resolve('recovery'),true);await settle();assert.deepEqual(stopped,['recovery']);assert.equal(controller.queue.length,0);
 controller.handle({id:'after-recovery',event:'critical',persistentAlarm:true},{});assert.equal(calls.length,2);controller.resolve('after-recovery');await settle();
});

test('persistent alarms respect quiet hours and become audible after the quiet period ends',async t=>{
 const f=fixture();t.after(()=>f.controller.shutdown());f.setAt(new Date(2026,9,13,23).getTime());
 const result=f.controller.handle({id:'overnight',event:'disconnect',persistentAlarm:true},{quiet:{enabled:true,start:'22:00',end:'07:00'},intervalSeconds:30});assert.equal(result.soundStatus,'quiet');assert.equal(f.calls.length,0);assert.equal(f.timers.size,1);await f.tick();assert.equal(f.calls.length,0);assert.equal(f.timers.size,1);
 f.setAt(new Date(2026,9,14,8).getTime());await f.tick();assert.equal(f.calls.length,1);f.controller.resolve('overnight');assert.equal(f.timers.size,0);
});

test('persistent behaviour remains configurable and mute/disabled events do not create repeat tasks',async t=>{
 const f=fixture();t.after(()=>f.controller.shutdown());f.controller.handle({id:'bounded',event:'critical',persistentAlarm:true},{persistentAlarm:false,repeat:false});await settle();assert.equal(f.calls.length,1);assert.equal(f.timers.size,0);
 assert.equal(f.controller.handle({id:'zero',event:'critical',persistentAlarm:true},{volume:0}).soundStatus,'silent');assert.equal(f.controller.handle({id:'disabled',event:'critical',persistentAlarm:true},{enabled:false}).soundStatus,'disabled');assert.equal(f.timers.size,0);
});
