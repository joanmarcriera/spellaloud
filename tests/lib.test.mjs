// Tests for the pure helpers in static/lib.js. Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  trimSilence, encodeWav, buildSchedule, seededShuffle, starsFor, mixToMono, streakFor, pctFor,
} from '../static/lib.js';

test('trimSilence keeps the sound plus padding and drops silence', () => {
  const sr = 1000; // 1 sample = 1 ms keeps the arithmetic obvious
  const x = new Float32Array(2000);
  for (let i = 800; i < 1000; i++) x[i] = 0.5; // sound at 800..999
  const out = trimSilence(x, sr, { threshold: 0.02, padMs: 150 });
  assert.equal(out.length, 200 + 150 + 150);
  assert.equal(out[150], 0.5);
  assert.equal(out[0], 0);
});

test('trimSilence keeps a longer lead-in when leadMs is set (soft opening s)', () => {
  const sr = 1000;
  const x = new Float32Array(2000);
  for (let i = 400; i < 800; i++) x[i] = 0.01;  // quiet "s", below the threshold
  for (let i = 800; i < 1000; i++) x[i] = 0.5;  // the loud vowel
  const out = trimSilence(x, sr, { threshold: 0.02, padMs: 200, leadMs: 350 });
  assert.equal(out.length, 350 + 200 + 200);
  assert.equal(out[0], Math.fround(0.01)); // starts inside the "s", not at the vowel
});

test('trimSilence clamps padding at the buffer edges', () => {
  const x = new Float32Array(300);
  x[10] = 0.9; x[290] = 0.9;
  const out = trimSilence(x, 1000, { threshold: 0.1, padMs: 150 });
  assert.equal(out.length, 300);
});

test('trimSilence returns empty for pure silence', () => {
  const out = trimSilence(new Float32Array(500), 1000, { threshold: 0.02, padMs: 150 });
  assert.equal(out.length, 0);
});

test('encodeWav writes a valid 16-bit mono PCM header and clamps samples', () => {
  const buf = encodeWav(Float32Array.from([0, 1, -1, 2, -2, 0.5]), 22050);
  assert.ok(buf instanceof ArrayBuffer);
  assert.equal(buf.byteLength, 44 + 6 * 2);
  const dv = new DataView(buf);
  const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  assert.equal(tag(0), 'RIFF');
  assert.equal(tag(8), 'WAVE');
  assert.equal(tag(12), 'fmt ');
  assert.equal(dv.getUint32(4, true), buf.byteLength - 8);
  assert.equal(dv.getUint16(20, true), 1);      // PCM
  assert.equal(dv.getUint16(22, true), 1);      // mono
  assert.equal(dv.getUint32(24, true), 22050);  // sample rate
  assert.equal(dv.getUint32(28, true), 44100);  // byte rate
  assert.equal(dv.getUint16(34, true), 16);     // bits
  assert.equal(tag(36), 'data');
  assert.equal(dv.getUint32(40, true), 12);
  assert.equal(dv.getInt16(44 + 2, true), 32767);
  assert.equal(dv.getInt16(44 + 4, true), -32768);
  assert.equal(dv.getInt16(44 + 6, true), 32767);  // clamped
  assert.equal(dv.getInt16(44 + 8, true), -32768); // clamped
});

test('mixToMono averages channels', () => {
  const m = mixToMono([Float32Array.from([1, 0, -1]), Float32Array.from([0, 1, -1])]);
  assert.deepEqual(Array.from(m), [0.5, 0.5, -1]);
  assert.equal(mixToMono([Float32Array.from([0.25])])[0], 0.25);
});

test('seededShuffle is deterministic, a permutation, and does not mutate', () => {
  const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const s1 = seededShuffle(a, 42);
  const s2 = seededShuffle(a, 42);
  assert.deepEqual(s1, s2);
  assert.deepEqual([...s1].sort((x, y) => x - y), a);
  assert.deepEqual(a, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.notDeepEqual(seededShuffle(a, 1), seededShuffle(a, 2));
});

test('buildSchedule in order repeats each word', () => {
  const words = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const s = buildSchedule(words, { repeats: 2, order: 'inorder', seed: 7 });
  assert.deepEqual(s.words.map((w) => w.id), [1, 2, 3]);
  assert.equal(s.steps.length, 6);
  assert.deepEqual(s.steps.map((x) => [x.index, x.repeat]), [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [2, 1]]);
  assert.equal(s.steps[1].word.id, 1);
  assert.equal(s.steps[1].repeats, 2);
});

test('buildSchedule mix is seeded and keeps every word', () => {
  const words = Array.from({ length: 8 }, (_, i) => ({ id: i + 1 }));
  const a = buildSchedule(words, { repeats: 1, order: 'mix', seed: 5 });
  const b = buildSchedule(words, { repeats: 1, order: 'mix', seed: 5 });
  assert.deepEqual(a.words.map((w) => w.id), b.words.map((w) => w.id));
  assert.deepEqual(a.words.map((w) => w.id).sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(a.steps.length, 8);
});

test('starsFor follows the spec', () => {
  assert.equal(starsFor(8, 8), 3);
  assert.equal(starsFor(7, 8), 2);
  assert.equal(starsFor(4, 8), 2);
  assert.equal(starsFor(3, 8), 1);
  assert.equal(starsFor(0, 8), 1);
  assert.equal(starsFor(0, 0), 0);
});

test('pctFor rounds and handles zero', () => {
  assert.equal(pctFor(1, 3), 33);
  assert.equal(pctFor(0, 0), 0);
});

test('streakFor counts consecutive days ending today or yesterday', () => {
  assert.equal(streakFor(['2026-10-15', '2026-10-14', '2026-10-13'], '2026-10-15'), 3);
  assert.equal(streakFor(['2026-10-14', '2026-10-13'], '2026-10-15'), 2);
  assert.equal(streakFor(['2026-10-12'], '2026-10-15'), 0);
  assert.equal(streakFor(['2026-10-15', '2026-10-13'], '2026-10-15'), 1);
  assert.equal(streakFor([], '2026-10-15'), 0);
});

import { SPEEDS as SPD, markLayout } from '../static/lib.js';
test('slow is clearly slower than normal (#6672)', () => {
  assert.equal(SPD.slow, 0.55);
  assert.ok(SPD.slow <= SPD.normal * 0.6 && SPD.fast > SPD.normal);
});
test('review list is one column for few words, two for many (#6673)', () => {
  assert.deepEqual(markLayout(5), { cols: 1, rows: 5 });
  assert.deepEqual(markLayout(7), { cols: 1, rows: 7 });
  assert.deepEqual(markLayout(8), { cols: 2, rows: 4 });
  assert.deepEqual(markLayout(11), { cols: 2, rows: 6 });
});

import { mondayISO } from '../static/lib.js';
test('mondayISO gives this/next week Monday (#6665)', () => {
  assert.equal(mondayISO(new Date(2026, 10, 9), 0), '2026-11-09'); // Monday
  assert.equal(mondayISO(new Date(2026, 10, 15), 0), '2026-11-09'); // Sunday belongs to the week before
  assert.equal(mondayISO(new Date(2026, 10, 15), 1), '2026-11-16');
  assert.equal(mondayISO(new Date(2026, 11, 30), 1), '2027-01-04'); // year rollover
});
