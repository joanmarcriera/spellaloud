// Guard against XSS regressions: word labels come from the API, so the UI code must never turn
// strings into markup. app.js may use insertAdjacentHTML once (the Icon branch of h(), fed only by
// constants); nothing else may use an HTML sink.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../static/${f}`, import.meta.url), 'utf8');

test('app.js has no HTML sinks beyond the Icon branch', () => {
  const src = read('app.js');
  assert.equal((src.match(/insertAdjacentHTML/g) || []).length, 1);
  assert.match(src, /c instanceof Icon\) el\.insertAdjacentHTML/);
  assert.doesNotMatch(src, /innerHTML|outerHTML|document\.write|startsWith\('<svg'\)|html:/);
});

test('parent.js has no HTML sinks', () => {
  assert.doesNotMatch(read('parent.js'), /innerHTML|outerHTML|insertAdjacentHTML|document\.write|html:/);
});
