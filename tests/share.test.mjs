// Tests for static/share.js (run: node --test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanWord, cleanWords, encodeShare, buildShareLink, parseShare, MAX_WORDS } from '../static/share.js';

test('round trip keeps order, apostrophes, hyphens, accents and spaces', () => {
  const words = ["they're", 'mother-in-law', 'café', 'ice cream', 'because'];
  const link = buildShareLink('https://x.example/parent#old', words, 'Week 3');
  assert.ok(link.startsWith('https://x.example/parent#sl=1'));
  assert.equal(link.split('#').length, 2, 'old hash dropped');
  assert.deepEqual(parseShare(link.slice(link.indexOf('#'))), { words, title: 'Week 3' });
});

test('words live only in the fragment, never in path or query', () => {
  const link = buildShareLink('https://x.example/parent?kid=ash', ['secret'], '');
  assert.ok(link.split('#')[0] === 'https://x.example/parent?kid=ash');
  assert.ok(link.split('#')[1].includes('secret'));
});

test('hostile or hand-edited input is neutralised', () => {
  const p = parseShare('#sl=1&t=<b>x</b>&w=<img src=x onerror=1>&w=ok&w=OK&w=&w=' + 'a'.repeat(200));
  assert.deepEqual(p.words, ['img srcx onerror', 'ok', 'a'.repeat(40)]);
  assert.equal(p.title, 'bxb');
  assert.equal(cleanWord('12345'), '');
});

test('non-share fragments and empty lists give null / empty', () => {
  assert.equal(parseShare(''), null);
  assert.equal(parseShare('#other=1&w=a'), null);
  assert.equal(parseShare('#sl=2&w=a'), null);
  assert.equal(parseShare('#sl=1'), null);
  assert.equal(encodeShare([' ', '12']), '');
  assert.equal(buildShareLink('https://x.example/', []), '');
});

test('duplicates dropped case-insensitively and list capped', () => {
  assert.deepEqual(cleanWords(['Cat', 'cat', 'dog']), ['Cat', 'dog']);
  assert.equal(cleanWords(Array.from({ length: 100 }, (_, i) => 'w' + 'abcdefghij'[i % 10].repeat(1) + 'x'.repeat(Math.floor(i / 10) + 1) + String.fromCharCode(97 + (i % 26)))).length <= MAX_WORDS, true);
});

test('no recordings, scores or names are representable', () => {
  const frag = encodeShare(['one'], 'T');
  assert.deepEqual([...new URLSearchParams(frag).keys()].sort(), ['sl', 't', 'w']);
});
