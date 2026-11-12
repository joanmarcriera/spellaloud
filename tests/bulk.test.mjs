// #6328: pure helpers for multi-select delete on the parent word list, and the parent.js wiring. Run with `node --test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bulkDeletePlan, bulkConfirmText, selectionState, bulkButtonText } from '../static/bulk.js';

test('browser build: one bulk POST; LAN server: one DELETE per word; duplicates collapse; nothing selected = no calls', () => {
  assert.deepEqual(bulkDeletePlan([3, 4, 3], 'local'), [['POST', '/api/words/delete', { ids: [3, 4] }]]);
  assert.deepEqual(bulkDeletePlan([3, 4], 'server'), [['DELETE', '/api/words/3'], ['DELETE', '/api/words/4']]);
  assert.deepEqual(bulkDeletePlan([], 'local'), []);
});

test('confirm text counts the words, names at most five, and warns about clips and history', () => {
  assert.match(bulkConfirmText(['cat']), /^Delete 1 word \("cat"\)\?/);
  const t = bulkConfirmText(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.match(t, /^Delete 7 words \("a", "b", "c", "d", "e", and 2 more\)\?/);
  assert.match(t, /recordings/);
  assert.match(t, /cannot be undone/);
});

test('select-all state and button text', () => {
  assert.equal(selectionState(0, 5), 'none');
  assert.equal(selectionState(2, 5), 'some');
  assert.equal(selectionState(5, 5), 'all');
  assert.equal(selectionState(0, 0), 'none');
  assert.equal(bulkButtonText(0), 'Delete selected');
  assert.equal(bulkButtonText(3), 'Delete selected (3)');
});

test('parent.js wires checkboxes, select-all and one confirmed Delete selected through bulkDeletePlan', () => {
  const src = readFileSync(new URL('../static/parent.js', import.meta.url), 'utf8');
  assert.match(src, /from '\.\/bulk\.js'/);
  assert.match(src, /type: 'checkbox', 'aria-label': 'Select all words/);
  assert.match(src, /bulkConfirmText\(/);
  assert.match(src, /bulkDeletePlan\(/);
});
