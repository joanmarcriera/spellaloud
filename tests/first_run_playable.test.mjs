// First run (Vikunja #4631): typed words are playable in the browser build, read by the en-GB voice.
// Run with `node --test tests/`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStore, memoryBackend } from '../static/store.js';
import { sourceForWord } from '../static/voice.js';

const open = async (opts) => {
  const store = await createStore(memoryBackend(), { today: '2026-10-21', ...opts });
  const r = async (m, p, b) => (await store.request(m, p, b)).data;
  await r('POST', '/api/kids', { name: 'Ann', year: 2 });
  await r('POST', '/api/kids/ann/weeks', { week_start: '2026-10-19', words: ['because', 'people'] });
  return r;
};
const GB = { name: 'Daniel', lang: 'en-GB' };

test('browser build lists words with no recording as playable (has_audio false)', async () => {
  const r = await open({ speechFallback: true });
  const p = await r('GET', '/api/kids/ann/practice?mode=week');
  assert.deepEqual(p.words.map((w) => w.label), ['because', 'people']);
  assert.ok(p.words.every((w) => w.has_audio === false));
  assert.equal(p.skipped, 0);
});

test('family server mode still skips unrecorded words', async () => {
  const r = await open({});
  const p = await r('GET', '/api/kids/ann/practice?mode=week');
  assert.equal(p.words.length, 0);
  assert.equal(p.skipped, 2);
});

test('an unrecorded word uses the en-GB voice whatever the preference, and is skipped without one', () => {
  const typed = { label: 'because', has_audio: false };
  assert.equal(sourceForWord(typed, { voice: GB, prefer: 'recording' }), 'voice');
  assert.equal(sourceForWord(typed, { voice: null, prefer: 'recording' }), 'none');
});

test('a recorded word keeps the parent preference', () => {
  const rec = { label: 'cat', has_audio: true };
  assert.equal(sourceForWord(rec, { voice: GB, prefer: 'recording' }), 'recording');
  assert.equal(sourceForWord(rec, { voice: GB, prefer: 'voice' }), 'voice');
});

test('the browser transport turns the fallback on and the player handles typed words', () => {
  assert.match(readFileSync(new URL('../static/transport.js', import.meta.url), 'utf8'), /speechFallback: true/);
  assert.match(readFileSync(new URL('../static/app.js', import.meta.url), 'utf8'), /has_audio === false/);
});
