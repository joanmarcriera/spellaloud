// Tests for parseWordList (static/lib.js): the parent's pasted spelling list -> clean labels.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWordList } from '../static/lib.js';

test('one word per line, blanks ignored', () => {
  assert.deepEqual(parseWordList('because\n\n  neighbour \n').words, ['because', 'neighbour']);
});

test('commas, semicolons and tabs also separate words; inner spaces and apostrophes stay', () => {
  assert.deepEqual(parseWordList("because, don't; ice cream\tnaïve").words, ['because', "don't", 'ice cream', 'naïve']);
});

test('numbering and bullets from a pasted school sheet are stripped', () => {
  const t = '1. because\n2) neighbour\n- ice cream\n• ready\n* mother';
  assert.deepEqual(parseWordList(t).words, ['because', 'neighbour', 'ice cream', 'ready', 'mother']);
});

test('a bare number is a word, not numbering', () => {
  assert.deepEqual(parseWordList('100').words, ['100']);
});

test('duplicates are dropped case-insensitively and counted, first spelling kept', () => {
  const r = parseWordList('Because\nbecause\nBECAUSE\nbeauty');
  assert.deepEqual(r.words, ['Because', 'beauty']);
  assert.equal(r.duplicates, 2);
});

test('CRLF line endings work', () => {
  assert.deepEqual(parseWordList('one\r\ntwo\r\n').words, ['one', 'two']);
});

test('too-long entries are reported, not sent', () => {
  const long = 'x'.repeat(41);
  const r = parseWordList('ok\n' + long);
  assert.deepEqual(r.words, ['ok']);
  assert.deepEqual(r.tooLong, [long]);
});

test('empty and non-string input give no words', () => {
  assert.deepEqual(parseWordList('').words, []);
  assert.deepEqual(parseWordList(null).words, []);
});

test('table paste: a leading number column separated by a tab is dropped', () => {
  assert.deepEqual(parseWordList('1\tbecause\n2.\tneighbour\na)\tfriend').words, ['because', 'neighbour', 'friend']);
});

test('hyphens, apostrophes and digits inside words survive', () => {
  const t = "mother-in-law\n2-door\n-ing\no’clock\n1st";
  assert.deepEqual(parseWordList(t).words, ['mother-in-law', '2-door', '-ing', 'o’clock', '1st']);
});

test('bullet with no space is stripped', () => {
  assert.deepEqual(parseWordList('•because').words, ['because']);
});

test('NFC and NFD spellings of the same word are one word', () => {
  const r = parseWordList('café\ncafé');
  assert.equal(r.words.length, 1);
  assert.equal(r.duplicates, 1);
});

test('exactly 40 characters is allowed', () => {
  assert.equal(parseWordList('y'.repeat(40)).words.length, 1);
});
