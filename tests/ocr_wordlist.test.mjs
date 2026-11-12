// Parser half of the OCR spike (#3538): raw OCR text -> word list. Pure, no Tesseract needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordsFromListLines } from '../tools/ocr_wordlist_spike.mjs';

const RAW = 'Spelling words - Week 5\n\nYear 3 Mrs Patel Test on Friday\n\n1. because 7. though\n2. friend 8. through\n' +
  '3. people 9. thought\n4. beautiful 10. enough\n5. necessary 11. answer\n6. different 12. build\nPlease practise 10 minutes each night.\n';

test('two-column numbered sheet yields only the list words, furniture dropped', () => {
  assert.deepEqual(wordsFromListLines(RAW).sort(),
    ['answer', 'beautiful', 'because', 'build', 'different', 'enough', 'friend', 'necessary', 'people', 'though', 'thought', 'through']);
});
test('bare one-word-per-line list and "3)" markers are accepted; prose is not', () => {
  assert.deepEqual(wordsFromListLines('cat\ndog\n3) run\nthe cat sat\n'), ['cat', 'dog', 'run']);
});
test('apostrophes kept, duplicates removed, OCR junk rejected', () => {
  assert.deepEqual(wordsFromListLines("1. don't\n2. don't\n3. |!\n"), ["don't"]);
});
