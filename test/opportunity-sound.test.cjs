'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { SoundController, soundPreferences, isQuiet } = require('../src/core/sound.cjs');
const settle = () => new Promise(resolve => setImmediate(resolve));

test('opportunity siren carries duration and volume once; disabled, mute and Brasilia quiet hours remain effective', async () => {
  const played = [], controller = new SoundController({ play: async value => played.push(value), now: () => Date.UTC(2026, 9, 9, 15) });
  const prefs = { enabled: true, events: ['opportunity'], volume: 37, durationSeconds: 2.5, repeat: false, quiet: { enabled: true, start: '22:00', end: '08:00', timezone: 'America/Sao_Paulo' } };
  assert.equal(controller.handle({ id: 'grouped-burst', event: 'opportunity' }, prefs).soundStatus, 'scheduled');
  assert.equal(controller.handle({ id: 'grouped-burst', event: 'opportunity' }, prefs).soundStatus, 'suppressed');
  assert.equal(controller.handle({ id: 'disabled-event', event: 'critical' }, prefs).soundStatus, 'disabled');
  await settle(); assert.equal(played.length, 1); assert.equal(played[0].durationSeconds, 2.5); assert.equal(played[0].volume, 0.37);
  assert.equal(controller.handle({ id: 'muted-burst', event: 'opportunity' }, { ...prefs, volume: 0 }).soundStatus, 'silent');
  assert.equal(played.length, 1); controller.shutdown();
  assert.equal(isQuiet(Date.UTC(2026, 9, 9, 1, 30), prefs.quiet), true, '01:30 UTC is 22:30 in Brasilia, regardless of host clock zone');
  assert.equal(isQuiet(Date.UTC(2026, 9, 9, 11), prefs.quiet), false, '08:00 in Brasilia ends quiet hours');
  const quiet = new SoundController({ play: async value => played.push(value), now: () => Date.UTC(2026, 9, 9, 1, 30) });
  assert.equal(quiet.handle({ id: 'night-burst', event: 'opportunity' }, prefs).soundStatus, 'quiet');
  quiet.shutdown();
  assert.equal(soundPreferences({ durationSeconds: 0.2 }).durationSeconds, 0.2);
  assert.equal(soundPreferences({ durationSeconds: 30 }).durationSeconds, 30);
  assert.equal(soundPreferences({ durationSeconds: 31 }).durationSeconds, undefined);
});

function rendererFixture() {
  const state = { ended: [], timers: [], contexts: [], audios: [] };
  class Context {
    constructor() { this.currentTime = 5; this.destination = {}; this.gains = []; this.oscillators = []; state.contexts.push(this); }
    async resume() { this.resumed = true; }
    async close() { this.closed = true; }
    createGain() { const gain = { gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; this.gains.push(gain); return gain; }
    createOscillator() { const oscillator = { frequency: { value: 0 }, connect() {}, start(at) { this.startedAt = at; }, stop(at) { this.stoppedAt = at; } }; this.oscillators.push(oscillator); return oscillator; }
  }
  class AudioFile {
    constructor(url) { this.src = url; state.audios.push(this); }
    async play() { this.played = true; }
    pause() { this.paused = true; }
  }
  const bridge = { onPlay: fn => { state.play = fn; }, onStop: fn => { state.stop = fn; }, ended: (id, success) => state.ended.push({ id, success }) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/ui/audio-player.js'), 'utf8'), { window: { megaAudio: bridge }, AudioContext: Context, Audio: AudioFile, setTimeout: (callback, ms) => { const timer = { callback, ms }; state.timers.push(timer); return timer; }, clearTimeout: timer => { if (timer) timer.cleared = true; }, Number, Math });
  return state;
}

test('actual audio renderer produces tones for configured siren duration and closes at the bounded deadline', async () => {
  const state = rendererFixture(); await state.play({ id: 'three-second-siren', sound: 'urgent', volume: 0.42, durationSeconds: 3 });
  const context = state.contexts[0]; assert.equal(context.gains[0].gain.value, 0.42); assert.equal(context.resumed, true);
  assert(context.oscillators.length > 3, 'Configured duration must generate more than the old fixed three tones');
  for (const oscillator of context.oscillators) { assert(oscillator.startedAt >= 5); assert(oscillator.stoppedAt > oscillator.startedAt); assert(oscillator.stoppedAt <= 8 + Number.EPSILON * 8); }
  assert.equal(state.timers[0].ms, 3000); state.timers[0].callback(); await settle();
  assert.equal(context.closed, true); assert.deepEqual(state.ended, [{ id: 'three-second-siren', success: true }]);
});

test('custom opportunity audio respects volume and duration, and another playback stops the previous sound', async () => {
  const state = rendererFixture(); await state.play({ id: 'custom-alert', sound: 'custom', audioUrl: 'mega-audio://asset/isolated-test', volume: 0.25, durationSeconds: 1.5 });
  assert.equal(state.audios[0].volume, 0.25); assert.equal(state.timers[0].ms, 1500); assert.equal(state.audios[0].played, true);
  state.timers[0].callback(); await settle(); assert.equal(state.audios[0].paused, true); assert.equal(state.audios[0].src, ''); assert.deepEqual(state.ended[0], { id: 'custom-alert', success: true });
  await state.play({ id: 'old-alert', sound: 'urgent', volume: 0.7, durationSeconds: 2 });
  await state.play({ id: 'new-alert', sound: 'soft', volume: 0, durationSeconds: 0.2 });
  assert.equal(state.contexts[0].closed, true); assert.equal(state.timers[1].cleared, true); assert.deepEqual(state.ended[1], { id: 'old-alert', success: true });
  assert.equal(state.contexts[1].gains[0].gain.value, 0); assert.equal(state.timers[2].ms, 200);
  state.stop({ id: 'different-id' }); assert.equal(state.contexts[1].closed, undefined);
  state.stop({ id: 'new-alert' }); await settle(); assert.equal(state.contexts[1].closed, true); assert.deepEqual(state.ended[2], { id: 'new-alert', success: true });
});
