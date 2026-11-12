// Tests for the printable answer sheet and parent summary (Vikunja #5572). Run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { answerSheet, progressSummary, sheetText, summaryText } from '../static/printsheet.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const WORDS = ['because', 'friend', 'beautiful'];
const week = { words: WORDS.map((label, i) => ({ id: i + 1, label })) };

test('three-word week: three numbered lines, none of the words', () => {
  const m = answerSheet(week, 'Ash');
  assert.deepEqual(m.lines, [1, 2, 3]);
  const t = sheetText(m);
  assert.equal(t.split('\n').filter((l) => /^\d+\. _+$/.test(l)).length, 3);
  for (const w of WORDS) assert.ok(!t.toLowerCase().includes(w), w);
});

test('summary lists exactly the Not-yet words, weeks practised and streak', () => {
  const hist = { weeks: [
    { sessions: 2, words: [{ label: 'because', tricky: true }, { label: 'friend', tricky: false }] },
    { sessions: 0, words: [{ label: 'beautiful', tricky: false }, { label: 'could', tricky: true }] },
    { sessions: 1, words: [{ label: 'said', tricky: false }] },
  ] };
  const m = progressSummary(hist, 4, 'Finn');
  assert.deepEqual(m.notYet, ['because', 'could']);
  assert.equal(m.weeksPracticed, 2);
  const t = summaryText(m);
  assert.match(t, /Streak: 4 days/);
  assert.ok(!t.includes('friend') && !t.includes('said'));
});

test('empty history gives an empty, singular-safe summary', () => {
  const t = summaryText(progressSummary({ weeks: [] }, 1, 'Ash'));
  assert.match(t, /Weeks practised: 0/);
  assert.match(t, /Streak: 1 day$/m);
});

test('style.css has an @media print rule hiding navigation', () => {
  const css = readFileSync(join(root, 'static/style.css'), 'utf8');
  const m = css.match(/@media print\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, 'no @media print block');
  assert.match(m[1], /display:\s*none/);
  assert.match(m[1], /\.btn|\.panel|nav|\.kids/);
});

test('parent page wires the Print buttons and the print area', () => {
  const js = readFileSync(join(root, 'static/parent.js'), 'utf8');
  assert.match(js, /printsheet\.js/);
  assert.match(js, /window\.print\(\)/);
  assert.match(readFileSync(join(root, 'static/parent.html'), 'utf8'), /id="printarea"/);
});
