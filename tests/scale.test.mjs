// Tests for the per-device scale helpers (static/lib.js). Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScale, stepScale, SCALE_MIN, SCALE_MAX } from '../static/lib.js';

test('parseScale accepts 0.6..1.6 and clamps outside', () => {
  assert.equal(parseScale('1'), 1);
  assert.equal(parseScale('0.8'), 0.8);
  assert.equal(parseScale('0.1'), SCALE_MIN);
  assert.equal(parseScale('9'), SCALE_MAX);
});

test('parseScale rejects junk', () => {
  for (const v of [null, undefined, '', 'abc', 'NaN', 'Infinity', '1,2']) assert.equal(parseScale(v), null, String(v));
});

test('stepScale moves in 10% steps without float drift and stays in range', () => {
  assert.equal(stepScale(1, 1), 1.1);
  assert.equal(stepScale(1.1, 1), 1.2);
  assert.equal(stepScale(0.7, -1), 0.6);
  assert.equal(stepScale(0.6, -1), 0.6);
  assert.equal(stepScale(1.6, 1), 1.6);
});
