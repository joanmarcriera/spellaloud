// Fully Kiosk voice path (Marc 2026-11-08): Android WebView has no Web Speech voices, but Fully Kiosk's
// JavaScript interface (`fully`) can read text with the device's TTS. Tests stub globalThis.fully.
// Docs: https://www.fully-kiosk.com/docs/en/api/javascript  (fully.textToSpeech / stopTextToSpeech / fully.bind('ttsUtteranceDone', js)).
import test from 'node:test';
import assert from 'node:assert/strict';
import { FULLY_VOICE, fullyBridge, pickVoice, gbVoices, resolveVoice, recordingPlan, voiceStatus, loadVoices, speak, stopSpeech, fullySpeaking } from '../static/voice.js';

const FULLY_UA = 'Mozilla/5.0 (Linux; Android 13; RK3588 Build/TQ3C; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/156.0 Safari/537.36';
const V = (name, lang, o = {}) => ({ name, lang, localService: true, default: false, ...o });

/** A fake `fully`: records calls; bind() keeps the JS strings so a test can fire an event like Fully does. */
function stubFully({ withBind = true } = {}) {
  const f = { calls: [], bound: {} };
  f.textToSpeech = (...a) => { f.calls.push(['tts', ...a]); };
  f.stopTextToSpeech = () => { f.calls.push(['stop']); };
  if (withBind) f.bind = (ev, code) => { f.bound[ev] = code; };
  f.fire = (ev) => { if (f.bound[ev]) new Function(f.bound[ev])(); }; // Fully evaluates the string in the page
  globalThis.fully = f;
  return f;
}
const unstub = () => { delete globalThis.fully; };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const stops = (f) => f.calls.filter((c) => c[0] === 'stop').length;

test('no bridge: nothing changes (no voice, no Fully calls)', async () => {
  unstub();
  assert.equal(fullyBridge(), null);
  assert.equal(pickVoice([]), null);
  assert.deepEqual(gbVoices([]), []);
  assert.equal(recordingPlan([{ id: 1, has_audio: false }], [], true).blocked, true);
  assert.equal(await speak({}, FULLY_VOICE, 'which'), false); // a Fully voice without the bridge cannot speak
});

test('bridge detected only when textToSpeech is a function', () => {
  globalThis.fully = {};
  assert.equal(fullyBridge(), null);
  globalThis.fully = { textToSpeech: 'nope' };
  assert.equal(fullyBridge(), null);
  const f = stubFully();
  assert.equal(fullyBridge(), f);
  unstub();
});

test('with the bridge, the tablet voice is a usable on-device en-GB voice', () => {
  stubFully();
  try {
    assert.equal(FULLY_VOICE.lang, 'en-GB');
    assert.equal(FULLY_VOICE.localService, true);
    assert.equal(FULLY_VOICE.fully, true);
    assert.equal(pickVoice([]).name, 'Tablet voice (English UK)');
    assert.equal(pickVoice(undefined).fully, true);
    assert.deepEqual(gbVoices([]).map((v) => v.name), ['Tablet voice (English UK)']);
    assert.equal(resolveVoice([], 'Tablet voice (English UK)').fully, true);
    assert.equal(resolveVoice([], '').fully, true);
  } finally { unstub(); }
});

test('real voices still win by their rules; novelty and online voices are still refused', () => {
  stubFully();
  try {
    assert.equal(pickVoice([V('Google UK English Female', 'en-GB')]).name, 'Google UK English Female');
    // A novelty voice and a network voice never beat (or replace) the tablet voice.
    assert.equal(pickVoice([V('Zarvox', 'en-GB'), V('Google UK English Female', 'en-GB', { localService: false })]).fully, true);
    assert.equal(pickVoice([V('Samantha', 'en-US')]).fully, true);
    assert.equal(gbVoices([V('Daniel', 'en-GB'), FULLY_VOICE]).filter((v) => v.fully).length, 1); // not listed twice
  } finally { unstub(); }
});

test('recordingPlan: unrecorded words are not blocked when the tablet voice exists', () => {
  stubFully();
  try {
    const plan = recordingPlan([{ id: 1, has_audio: false }, { id: 2, has_audio: true }], [], true);
    assert.equal(plan.noVoice, false);
    assert.equal(plan.blocked, false);
    assert.equal(plan.record.length, 0);
  } finally { unstub(); }
});

test('voiceStatus: green in the Fully WebView once the bridge supplies the voice', () => {
  stubFully();
  try {
    const s = voiceStatus(pickVoice([]), FULLY_UA);
    assert.equal(s.ok, true);
    assert.equal(s.webview, true);
    assert.match(s.text, /British voice ready on this device \(Tablet voice \(English UK\)\)/);
    assert.doesNotMatch(s.text, /built-in browser/);
  } finally { unstub(); }
  assert.equal(voiceStatus(pickVoice([]), FULLY_UA).ok, false); // bridge absent: still the red in-app-browser message
});

test('loadVoices does not wait for voiceschanged when the bridge is present', async () => {
  stubFully();
  try {
    const synth = { getVoices: () => [], addEventListener() { throw new Error('should not wait'); }, removeEventListener() {} };
    assert.deepEqual(await loadVoices(synth, 5000), []);
  } finally { unstub(); }
});

test('speak routes to fully.textToSpeech(word, "en_GB") and ends on ttsUtteranceDone', async () => {
  const f = stubFully();
  try {
    const p = speak(undefined, FULLY_VOICE, 'which', { rate: 1.25 });
    assert.deepEqual(f.calls.find((c) => c[0] === 'tts'), ['tts', 'which', 'en_GB']);
    assert.ok(f.bound.ttsUtteranceStart && f.bound.ttsUtteranceDone && f.bound.ttsUtteranceError);
    assert.equal(fullySpeaking(), true);
    f.fire('ttsUtteranceStart');
    f.fire('ttsUtteranceDone');
    assert.equal(await p, true);
    assert.equal(fullySpeaking(), false);
  } finally { unstub(); }
});

test('a Done event from a cancelled earlier utterance (before Start) does not end the new word', async () => {
  const f = stubFully();
  try {
    const p = speak(undefined, FULLY_VOICE, 'their');
    let settled = false; p.then(() => { settled = true; });
    f.fire('ttsUtteranceDone'); // stale, no Start yet
    await tick();
    assert.equal(settled, false);
    f.fire('ttsUtteranceStart'); f.fire('ttsUtteranceDone');
    assert.equal(await p, true);
  } finally { unstub(); }
});

test('an utterance error resolves false so the app can fall back to the recording', async () => {
  const f = stubFully();
  try {
    const p = speak(undefined, FULLY_VOICE, 'which');
    f.fire('ttsUtteranceStart'); f.fire('ttsUtteranceError');
    assert.equal(await p, false);
  } finally { unstub(); }
});

test('without bind support the end is estimated', async () => {
  const f = stubFully({ withBind: false });
  try {
    const t0 = Date.now();
    assert.equal(await speak(undefined, FULLY_VOICE, 'a', { estimateMs: 20 }), true);
    assert.ok(Date.now() - t0 >= 15);
    assert.equal(f.calls.length, 1);
  } finally { unstub(); }
});

test('stopSpeech calls fully.stopTextToSpeech only while a Fully word is pending, and settles it false', async () => {
  const f = stubFully();
  try {
    stopSpeech({ cancel() {} });
    assert.equal(stops(f), 0); // nothing speaking: no call
    const p = speak(undefined, FULLY_VOICE, 'which');
    stopSpeech({ cancel() {} });
    assert.equal(stops(f), 1);
    assert.equal(await p, false);
    assert.equal(fullySpeaking(), false);
  } finally { unstub(); }
});

test('stopSpeech with no bridge only cancels the synth', () => {
  unstub();
  let n = 0;
  stopSpeech({ cancel() { n++; } });
  assert.equal(n, 1);
  stopSpeech(undefined); // no speech support at all: no throw
});

test('a real voice with the bridge present still uses speechSynthesis, not Fully', async () => {
  const f = stubFully();
  try {
    const spoken = [];
    function U(t) { this.text = t; }
    const synth = { cancel() {}, speak(u) { spoken.push(u.text); u.onend(); } };
    assert.equal(await speak(synth, V('Daniel', 'en-GB'), 'which', { Utterance: U }), true);
    assert.deepEqual(spoken, ['which']);
    assert.equal(f.calls.length, 0);
  } finally { unstub(); }
});

test('estimate is about 700 ms + 90 ms per character', async () => {
  const { estimateSpeechMs } = await import('../static/voice.js');
  assert.equal(estimateSpeechMs('which'), 700 + 90 * 5);
});

// Wiring: the app stops speech through stopSpeech (so Fully's TTS stops too) and Pause stops a Fully word.
import { readFileSync } from 'node:fs';
test('app.js routes stop and pause through the Fully-aware helpers', () => {
  const app = readFileSync(new URL('../static/app.js', import.meta.url), 'utf8');
  assert.match(app, /stopSpeech\(globalThis\.speechSynthesis\)/);
  assert.match(app, /fullySpeaking\(\)/);
  assert.doesNotMatch(app, /speechSynthesis\.cancel\(\)/);
});
