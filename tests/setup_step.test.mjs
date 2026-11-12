// First-run setup (Vikunja #4632): setupStep states, the Year 2 sample list, and the wiring. `node --test tests/`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupStep } from '../static/lib.js';
import { Y2_SAMPLE } from '../static/sample.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('setupStep: add-child, add-words, ready', () => {
  assert.equal(setupStep([], []), 'add-child');
  assert.equal(setupStep(undefined, undefined), 'add-child');
  assert.equal(setupStep([{ slug: 'ann' }], []), 'add-words');
  assert.equal(setupStep([{ slug: 'ann' }], [{ words: [] }]), 'add-words');
  assert.equal(setupStep([{ slug: 'ann' }], [{ words: [{ label: 'cat' }] }]), 'ready');
});

test('Year 2 sample list is the staged statutory list, 64 words, no blanks or duplicates', () => {
  const lists = JSON.parse(read('../content/uk-statutory/lists.json')).lists;
  const y2 = lists.find((l) => l.id === 'y2-common-exception-words');
  assert.deepEqual(Y2_SAMPLE, y2.entries.map((e) => e.official));
  assert.equal(Y2_SAMPLE.length, 64);
  assert.equal(new Set(Y2_SAMPLE.map((w) => w.toLowerCase())).size, 64);
  assert.ok(Y2_SAMPLE.every((w) => w && w.trim() === w));
});

test('the setup panel is wired into the parent page, local build only', () => {
  const src = read('../static/parent.js');
  assert.match(src, /setupStep\(kidList, weeks\)/);
  assert.match(src, /if \(t\.mode === 'local'\)/);
  assert.match(src, /Use example words for this year/);
});

test('spec states at most 3 screens from an empty state to Play', () => {
  assert.match(read('../docs/spec.md'), /at most 3 screens from an\s+empty state to Play/);
});

test('children come first on the parent page; Add a child goes after them, setup above them (#3520, #6763)', () => {
  const src = read('../static/parent.js');
  const html = read('../static/parent.html');
  // #kids sits above the voice, backup, feedback, screen-size and thanks panels, so a parent finds their child at once
  for (const id of ['voicebox', 'voice-help', 'backupbox', 'feedbackbox', 'screenbox', 'tipbox']) {
    assert.ok(html.indexOf('id="kids"') < html.indexOf(`id="${id}"`), `#kids must come before #${id}`);
  }
  assert.match(src, /if \(step === 'ready'\) root\.append\(addChildPanel\(false\)\)/); // after the existing children
  assert.match(src, /else root\.prepend\(setupPanel\(step\)\)/);                       // first run: the form on top
  assert.doesNotMatch(src, /getElementById\('tipbox'\)\.after\(root\)/);                 // the old bottom placement is gone
});

test('first-run form a11y: visible labels, error linked and focus moved to the offending field (#3520)', () => {
  const src = read('../static/parent.js');
  assert.match(src, /function labelled\(text, control\)/);                // every control gets a visible label
  assert.match(src, /labelled\('First name', name\)/);
  assert.match(src, /labelled\(.This week.s words., words\)/);
  assert.match(src, /'aria-describedby': 'setup-msg'/);                  // words box points at the error text
  assert.match(src, /id: 'setup-msg'/);
  assert.match(src, /field\.setAttribute\('aria-invalid', 'true'\)/);    // invalid field flagged
  assert.match(src, /field\.focus\(\)/);                                 // and focused so the error is read out
  assert.match(src, /'aria-labelledby': 'setup-h'/);                     // the section is named by its heading
  assert.match(src, /removeAttribute\('aria-invalid'\)\);/);              // typing clears the flag
  assert.match(src, /else btn\.focus\(\)/);                              // non-field errors keep focus on the page
});
