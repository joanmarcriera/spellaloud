// Tests for static/onecard.js (flag + one-card state). Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { onecardEnabled, ONECARD_FLAG_KEY, cardState, cardMark, cardStep, cardDone, cardProgress } from '../static/onecard.js';

const words = [{ id: 1 }, { id: 2 }, { id: 3 }];
const mem = (v) => ({ getItem: (k) => (k === ONECARD_FLAG_KEY ? v : null) });

test('flag is off by default, on via URL or stored opt-in; throwing storage is off', () => {
  assert.equal(onecardEnabled('', mem(null)), false);
  assert.equal(onecardEnabled('?onecard=0', null), false);
  assert.equal(onecardEnabled('?onecard=1', null), true);
  assert.equal(onecardEnabled('', mem('1')), true);
  assert.equal(onecardEnabled('', { getItem() { throw new Error('private'); } }), false);
});

test('state resumes at the first unmarked card and ignores junk marks', () => {
  assert.equal(cardState(words).index, 0);
  assert.equal(cardState(words, { 1: 1, 2: 0 }).index, 2);
  assert.deepEqual(cardState(words, { 1: 7, 9: 1 }).marks, {});
  assert.equal(cardState(words, { 1: 1, 2: 1, 3: 0 }).index, 2);
});

test('marking advances to the next unmarked card, wraps, and completes', () => {
  let s = cardState(words);
  s = cardMark(s, 1, 1); assert.equal(s.index, 1);
  s = cardStep(s, 1); s = cardMark(s, 3, 0); assert.equal(s.index, 1); // wraps to the skipped card
  assert.equal(cardDone(s), false);
  s = cardMark(s, 2, 1);
  assert.equal(cardDone(s), true);
  assert.deepEqual(cardProgress(s), { marked: 3, total: 3 });
});

test('invalid marks are ignored; re-marking changes the value; step is clamped', () => {
  const s = cardState(words);
  assert.equal(cardMark(s, 99, 1), s);
  assert.equal(cardMark(s, 1, 2), s);
  assert.equal(cardMark(cardMark(s, 1, 1), 1, 0).marks[1], 0);
  assert.equal(cardStep(s, -1).index, 0);
  assert.equal(cardStep(cardStep(cardStep(cardStep(s, 1), 1), 1), 1).index, 2);
});
