// Recording screen accessibility (Vikunja #3520): hold-to-talk works from the keyboard, word dots say which is current/recorded.
// Source-wiring checks, like onecard_wiring.test.mjs: the screen needs a real mic, so the browser walk is in the drive report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../static/app.js', import.meta.url), 'utf8');

test('hold button can be held with Space or Enter and releases on keyup or blur', () => {
  assert.match(src, /hold\.addEventListener\('keydown'/);
  assert.match(src, /e\.key !== ' ' && e\.key !== 'Enter'/);
  assert.match(src, /if \(!e\.repeat\) onDown\(/);
  assert.match(src, /hold\.addEventListener\('keyup'/);
  assert.match(src, /hold\.addEventListener\('blur', holdUp\)/);   // holdUp = onUp unless a tap-mode take is running
});

test('word dots mark the current word and recorded words for screen readers', () => {
  assert.match(src, /'aria-current': i === di \? 'true' : null/);
  assert.match(src, /, recorded/);
  assert.match(src, /setAttribute\('aria-label', `Word \$\{di \+ 1\}, recorded`\)/);
});

test('status line is a live region, modified keys are ignored, focus returns to the talk button (review fixes)', () => {
  assert.match(src, /class: 'msg', role: 'status'/);
  assert.match(src, /e\.ctrlKey \|\| e\.altKey \|\| e\.metaKey/);
  assert.match(src, /\(prefersTap \? tap : hold\)\.focus\(\)/);
  assert.match(src, /\(prefersTap \? tap : hold\)\.focus\(\{ preventScroll: true \}\)/);
});

test('tap-to-toggle: a second button starts and stops a take, pressed state announced, hold events ignore it (#3520)', () => {
  assert.match(src, /const tap = h\('button', \{ type: 'button', class: 'tapbtn', 'aria-pressed': 'false'/);
  assert.match(src, /tap\.addEventListener\('click'/);
  assert.match(src, /R\.tapMode = true/);                          // click while idle starts a take
  assert.match(src, /if \(R\.tapMode && R\.holding\) \{ R\.tapMode = false; syncTap\(\); say\('Finishing\.\.\.'\); onUp\(\); return; \}/); // click while recording stops it
  assert.match(src, /tap\.setAttribute\('aria-pressed', String\(on\)\)/);
  assert.match(src, /const holdUp = \(\) => \{ if \(!R\.tapMode\) onUp\(\); \}/); // blur/pointerleave must not end a tap take
  assert.match(src, /hold\.addEventListener\('blur', holdUp\)/);
  assert.doesNotMatch(src, /hold\.addEventListener\('blur', onUp\)/);
  assert.match(src, /R\.tapMode = false; syncTap\(\)/);            // endTake resets the toggle
});

test('tap-to-toggle review fixes: focus follows the control used, tap wording, buttons disabled while saving, ring visible (#3520)', () => {
  assert.match(src, /\(prefersTap \? tap : hold\)\.focus\(\)/);                 // refocus after a take
  assert.match(src, /\(prefersTap \? tap : hold\)\.focus\(\{ preventScroll: true \}\)/); // and on the next word
  assert.match(src, /Tap once to start, then tap again after you say the word/);   // hint no longer says hold
  assert.match(src, /hold\.disabled = true; tap\.disabled = true/);
  assert.match(src, /hold\.disabled = false; tap\.disabled = false/);
  assert.match(src, /say\('Finishing\.\.\.'\); onUp\(\)/);                       // second tap updates the UI at once
  assert.match(src, /'aria-label': 'Tap to record' \}/);                          // constant accessible name with aria-pressed
  assert.match(readFileSync(new URL('../static/style.css', import.meta.url), 'utf8'), /\.tapbtn\.live:focus-visible \{ outline-color/);
});
