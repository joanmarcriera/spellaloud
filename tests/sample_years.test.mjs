// Example words per school year + a further child can load words when added (Vikunja #6335). `node --test tests/`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { sampleForYear, Y1_SAMPLE, Y2_SAMPLE, Y34_SAMPLE, Y56_SAMPLE } from '../static/sample.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('every school year 0-6 has non-empty, trimmed, duplicate-free example words', () => {
  for (let y = 0; y <= 6; y++) {
    const w = sampleForYear(y);
    assert.ok(w.length >= 10, `year ${y}`);
    assert.ok(w.every((x) => x && x.trim() === x && !/[()]/.test(x)), `year ${y} clean`);
    assert.equal(new Set(w.map((x) => x.toLowerCase())).size, w.length, `year ${y} unique`);
  }
});

test('year to list mapping: Reception+1 -> Y1, 2 -> Y2, 3-4, 5-6; string years from a select work', () => {
  assert.equal(sampleForYear(0), Y1_SAMPLE);
  assert.equal(sampleForYear('1'), Y1_SAMPLE);
  assert.equal(sampleForYear(2), Y2_SAMPLE);
  assert.equal(sampleForYear('3'), Y34_SAMPLE);
  assert.equal(sampleForYear(4), Y34_SAMPLE);
  assert.equal(sampleForYear(5), Y56_SAMPLE);
  assert.equal(sampleForYear('6'), Y56_SAMPLE);
  assert.equal(Y1_SAMPLE.length, 45);
  assert.equal(Y2_SAMPLE.length, 64);
  assert.equal(Y34_SAMPLE.length, 20);
});

test('sample.js is exactly what tools/gen_sample.py generates from the statutory lists', () => {
  // --check writes nothing: a drifted file stays drifted for the next run instead of being silently rewritten.
  execFileSync('python3', ['-I', new URL('../tools/gen_sample.py', import.meta.url).pathname, '--check']);
});

test('unknown or missing year falls back to the gentlest list; 5 and "5" are Y5-6 of 20 words', () => {
  for (const y of [undefined, null, '', 'abc', NaN]) assert.equal(sampleForYear(y), Y1_SAMPLE, String(y));
  assert.equal(sampleForYear(5), Y56_SAMPLE);
  assert.equal(sampleForYear('5'), Y56_SAMPLE);
  assert.equal(Y56_SAMPLE.length, 20);
  for (let y = 0; y <= 6; y++) assert.ok(sampleForYear(y).length <= 100, 'fits the 100-word week cap');
});

test('add-a-child panel takes words and offers the year examples; add-week has the sample button', () => {
  const src = read('../static/parent.js');
  const panel = src.slice(src.indexOf('function addChildPanel'), src.indexOf('First-run setup'));
  assert.match(panel, /textarea/);
  assert.match(panel, /fillExample\(words, year\.value\)/);
  assert.match(panel, /'aria-label': 'Add child'/);
  assert.match(panel, /addChildWithWords\(api,/); // kid + weeks calls live in lib.js, tested in add_child_words.test.mjs
  const wk = src.slice(src.indexOf('function addWeekForm'), src.indexOf('Which term this week'));
  assert.match(wk, /fillExample\(words, kid\.year\)/);
  // examples never overwrite typed words, and the fill is announced through the role=status toast
  assert.match(src, /function fillExample[\s\S]*?Clear it first[\s\S]*?example words added/);
  assert.match(read('../static/parent.html'), /id="toast"[^>]*role="status"/);
});
