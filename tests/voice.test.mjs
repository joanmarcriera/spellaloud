// Tests for static/voice.js (run: node --test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickVoice, scoreVoice, langOf, chooseSource, loadVoices, speak } from '../static/voice.js';

import { gbVoices, resolveVoice, validVoiceName } from '../static/voice.js';
import { createStore, memoryBackend, ApiError } from '../static/store.js';
import { exportBackup, previewImport, applyImport } from '../static/backup.js';
const V = (name, lang, o = {}) => ({ name, lang, localService: true, default: false, ...o });

test('langOf normalises Android en_GB', () => assert.equal(langOf({ lang: 'en_GB' }), 'en-gb'));

test('picks an en-GB voice and never a US one', () => {
  const voices = [V('Samantha', 'en-US'), V('Daniel', 'en-GB'), V('Alex', 'en-US', { default: true })];
  assert.equal(pickVoice(voices).name, 'Daniel');
  assert.equal(pickVoice([V('Samantha', 'en-US'), V('Thomas', 'fr-FR')]), null);
  assert.equal(pickVoice([]), null);
  assert.equal(pickVoice(undefined), null);
});

test('prefers known-good, then offline, and skips novelty voices', () => {
  assert.equal(pickVoice([V('Zarvox', 'en-GB'), V('Rocko', 'en-GB')]).name, 'Rocko');
  assert.equal(scoreVoice(V('Bad News', 'en-GB')), -1);
  assert.equal(pickVoice([V('Google UK English Male', 'en-GB'), V('Google UK English Female', 'en-GB')]).name, 'Google UK English Female');
  assert.equal(pickVoice([V('Serena', 'en-GB'), V('Serena (Enhanced)', 'en-GB')]).name, 'Serena (Enhanced)');
  assert.equal(pickVoice([V('Android en_GB voice', 'en_GB')]).name, 'Android en_GB voice');
});

// BUG-3: the app claims speech stays on the device, so a network (localService=false) voice is never used.
test('a remote voice is never picked, even when it is a preferred name', () => {
  const local = V('Rocko', 'en-GB');
  const remote = V('Google UK English Female', 'en-GB', { localService: false });
  assert.equal(scoreVoice(remote), -1);
  assert.equal(pickVoice([local, remote]).name, 'Rocko', 'preferred remote vs local picks local');
  assert.equal(pickVoice([remote, local]).name, 'Rocko');
  assert.equal(pickVoice([remote]), null, 'remote-only gives null (recording is used)');
  assert.equal(pickVoice([V('Rocko', 'en-GB', { localService: undefined })]), null, 'unknown locality is not assumed local');
  assert.deepEqual(gbVoices([remote, local]).map((v) => v.name), ['Rocko'], 'the parent picker lists device voices only');
  assert.equal(resolveVoice([remote, local], 'Google UK English Female').name, 'Rocko', 'a stored remote choice falls back');
});

test('chooseSource fallback matrix', () => {
  const voice = V('Daniel', 'en-GB');
  assert.equal(chooseSource({ hasRecording: true, voice }), 'voice');
  assert.equal(chooseSource({ hasRecording: true, voice: null }), 'recording');
  assert.equal(chooseSource({ hasRecording: false, voice: null }), 'none');
  assert.equal(chooseSource({ hasRecording: true, voice, prefer: 'recording' }), 'recording');
  assert.equal(chooseSource({ hasRecording: false, voice, prefer: 'recording' }), 'voice');
});

class FakeUtt { constructor(t) { this.text = t; } }

test('speak resolves true on end, false on error, false on timeout, clamps rate', async () => {
  const mk = (behave) => ({ spoken: [], cancelled: 0, cancel() { this.cancelled++; }, speak(u) { this.spoken.push(u); behave(u); } });
  const voice = V('Daniel', 'en-GB');
  const ok = mk((u) => setTimeout(() => u.onend(), 1));
  assert.equal(await speak(ok, voice, 'because', { rate: 3, Utterance: FakeUtt }), true);
  assert.equal(ok.spoken[0].rate, 1.4); assert.equal(ok.spoken[0].lang, 'en-GB'); assert.equal(ok.spoken[0].voice, voice);
  assert.equal(await speak(mk((u) => setTimeout(() => u.onerror(), 1)), voice, 'x', { Utterance: FakeUtt }), false);
  const hang = mk(() => {});
  assert.equal(await speak(hang, voice, 'x', { Utterance: FakeUtt, timeoutMs: 20 }), false);
  assert.equal(hang.cancelled, 2, 'cancel before speaking and again on timeout');
  assert.equal(await speak(ok, null, 'x', { Utterance: FakeUtt }), false);
  const slow = mk((u) => setTimeout(() => u.onend(), 1));
  await speak(slow, voice, 'x', { rate: 0.1, Utterance: FakeUtt });
  assert.equal(slow.spoken[0].rate, 0.5);
});

test('loadVoices returns immediately when present, waits for voiceschanged, times out empty', async () => {
  const listeners = {};
  const synth = (list) => ({ list, getVoices() { return this.list; }, addEventListener(e, f) { listeners[e] = f; }, removeEventListener() {} });
  assert.equal((await loadVoices(synth([V('a', 'en-GB')]))).length, 1);
  const late = synth([]);
  const p = loadVoices(late, 500);
  late.list = [V('Daniel', 'en-GB')]; listeners.voiceschanged();
  assert.equal((await p).length, 1);
  assert.deepEqual(await loadVoices(synth([]), 20), []);
  assert.deepEqual(await loadVoices(null), []);
});

import { parseVoiceMode, storedVoiceMode } from '../static/voice.js';
test('voice mode defaults to recording and survives blocked storage', () => {
  assert.equal(parseVoiceMode('voice'), 'voice');
  assert.equal(parseVoiceMode('nonsense'), 'recording');
  assert.equal(parseVoiceMode(null), 'recording');
  assert.equal(storedVoiceMode({ getItem: () => 'voice' }), 'voice');
  assert.equal(storedVoiceMode({ getItem: () => { throw new Error('blocked'); } }), 'recording');
});

// ---- per-child voice choice (Vikunja #5570) ----
// A fake speechSynthesis: only getVoices matters to the helpers.
const VX = (name, lang, extra = {}) => ({ name, lang, localService: true, default: false, ...extra });
const VOICES = [
  V('Samantha', 'en-US'),                 // US: never listed
  V('Daniel', 'en-GB'),
  V('Serena', 'en-GB'),
  V('Google UK English Female', 'en-GB', { localService: false }), // network voice: never listed (BUG-3)
  V('Albert', 'en-GB'),                   // novelty: never listed
  V('Amelie', 'fr-FR'),
  V('Daniel', 'en_GB'),                   // duplicate name (underscore tag): listed once
];
const synth = (voices) => ({ getVoices: () => voices });

test('only en-GB voices are listed: no US, no foreign, no novelty, no duplicates', async () => {
  const list = gbVoices(await loadVoices(synth(VOICES)));
  assert.deepEqual(list.map((v) => v.name).sort(), ['Daniel', 'Serena']);
  assert.ok(list.every((v) => v.lang.replace('_', '-').toLowerCase() === 'en-gb'));
  assert.deepEqual(gbVoices([V('Samantha', 'en-US')]), []);
  assert.deepEqual(gbVoices(null), []);
});

test('a stored choice is used', () => {
  const best = pickVoice(VOICES).name;
  const other = gbVoices(VOICES).map((v) => v.name).find((n) => n !== best);
  assert.ok(other, 'the fixture has a second en-GB voice');
  assert.equal(resolveVoice(VOICES, other).name, other, 'the parent choice wins over the best-scoring voice');
  assert.equal(resolveVoice(VOICES, best).name, best);
});

test('a missing, non-British or empty choice falls back to the best en-GB voice', () => {
  const best = pickVoice(VOICES);
  assert.equal(resolveVoice(VOICES, 'Gone Voice'), best);
  assert.equal(resolveVoice(VOICES, ''), best);
  assert.equal(resolveVoice(VOICES, undefined), best);
  assert.equal(resolveVoice(VOICES, 'Samantha'), best, 'a US voice cannot be chosen by name');
  assert.equal(resolveVoice([V('Samantha', 'en-US')], 'Samantha'), null, 'no en-GB voice at all: null (recording is used)');
});

test('voice names are validated', () => {
  assert.ok(validVoiceName('') && validVoiceName('Google UK English Female'));
  assert.ok(!validVoiceName(5) && !validVoiceName('x'.repeat(121)) && !validVoiceName('a\nb'));
});

// ---- the setting in the store ---------------------------------------------------------------------------------
const device = async () => {
  const store = await createStore(memoryBackend(), { clock: () => new Date(Date.parse('2026-10-21T10:00:00Z')) });
  return { store, r: (m, p, b) => store.request(m, p, b).then((x) => x.data) };
};
const SET = { speed: 'normal', repeats: 2, pause: 'short', order: 'mix' };

test('settings accept an optional voice; invalid ones are refused; empty clears it', async () => {
  const a = await device();
  await a.r('POST', '/api/kids', { name: 'Ann', year: 3 });
  assert.equal((await a.r('PUT', '/api/kids/ann/settings', { ...SET, voice: 'Daniel' })).voice, 'Daniel');
  assert.equal((await a.r('GET', '/api/me')).kid.settings.voice, 'Daniel');
  await assert.rejects(a.store.request('PUT', '/api/kids/ann/settings', { ...SET, voice: 5 }), ApiError);
  await assert.rejects(a.store.request('PUT', '/api/kids/ann/settings', { ...SET, voice: 'x'.repeat(121) }), ApiError);
  assert.deepEqual(await a.r('PUT', '/api/kids/ann/settings', { ...SET, voice: '' }), SET, 'automatic = no key');
});

test('the choice survives an export then import round trip, per child', async () => {
  const a = await device();
  await a.r('POST', '/api/kids', { name: 'Ann', year: 3 });
  await a.r('POST', '/api/kids', { name: 'Bob', year: 1 });
  await a.r('POST', '/api/kids/ann/weeks', { week_start: '2026-10-19', words: ['cat'] });
  await a.r('PUT', '/api/kids/ann/settings', { ...SET, voice: 'Daniel' });
  // Bob stays automatic
  const got = {};
  const env = { navigator: { canShare: () => true, share: async ({ files }) => { got.file = files[0]; } } };
  await exportBackup(a.store, { env });
  const bytes = new Uint8Array(await got.file.arrayBuffer());

  const b = await device();
  await applyImport(b.store, await previewImport(b.store, bytes));
  const kids = await b.r('GET', '/api/kids');
  assert.equal(kids.find((k) => k.slug === 'ann').settings.voice, 'Daniel');
  assert.equal(kids.find((k) => k.slug === 'bob').settings.voice, undefined);
});
