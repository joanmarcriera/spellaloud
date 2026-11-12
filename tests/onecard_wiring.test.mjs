// Wiring test for oneCardMark in static/app.js (Vikunja #5414). app.js is browser-only (DOM at import), so the
// function's own source is cut out and run against recording stubs for h/btn/show: no DOM, no network.
// Run: node --test tests/onecard_wiring.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cardState, cardMark, cardStep, cardDone, cardProgress } from '../static/onecard.js';

const src = readFileSync(new URL('../static/app.js', import.meta.url), 'utf8');
const start = src.indexOf('function oneCardMark(');
const end = src.indexOf('function resultScreen(');
assert.ok(start > 0 && end > start, 'oneCardMark not found in app.js');
const body = src.slice(start, end);

/** Run oneCardMark with stubs; returns every show() call as a flat list of {icon,text,click} buttons. */
function run(words) {
  const screens = []; const posted = [];
  const h = (tag, attrs, ...kids) => ({ tag, attrs, kids: kids.flat() });
  const btn = (icon, text, cls, onclick, extra = {}) => ({ btn: true, icon, text, onclick, extra });
  const show = (...nodes) => screens.push(nodes);
  const flat = (n) => (Array.isArray(n) ? n.flatMap(flat) : n && n.btn ? [n] : n && n.kids ? n.kids.flatMap(flat) : []);
  const env = { S: { kid: { slug: 'ann' } }, h, btn, show, home() {}, unlockAudio() {}, sayWord() {}, stopAudio() {}, api: async (...a) => { posted.push(a); return {}; }, clearDraft() {}, resultScreen() {}, cardState, cardMark, cardStep, cardDone, cardProgress };
  const fn = new Function(...Object.keys(env), `let leaveHook; ${body}; return oneCardMark;`)(...Object.values(env));
  const marks = new Map();
  fn(words, 'week', { speed: 1 }, marks, () => {});
  return { posted, buttons: () => flat(screens[screens.length - 1]), screens, marks };
}

test('Previous and Next use arrow icons, not the home icon', () => {
  const r = run([{ id: 1, label: 'one' }, { id: 2, label: 'two' }]);
  const by = (t) => r.buttons().find((b) => b.text === t);
  assert.equal(by('Previous').icon, 'left');
  assert.equal(by('Next').icon, 'right');
  assert.equal(by('Back').icon, 'home'); // the real home button is unchanged
});

test('Next / Got it are wired to the card state (draw again, mark advances)', () => {
  const r = run([{ id: 1, label: 'one' }, { id: 2, label: 'two' }]);
  const title = () => r.screens[r.screens.length - 1][0].kids.find((k) => k.tag === 'h1').kids[0];
  assert.match(title(), /Word 1 of 2/);
  r.buttons().find((b) => b.text === 'Next').onclick();
  assert.match(title(), /Word 2 of 2/);
  r.buttons().find((b) => b.text === 'Previous').onclick();
  r.buttons().find((b) => b.text === 'Got it').onclick();
  assert.equal(r.marks.get(1), 1);
  assert.match(title(), /Word 2 of 2 · 1 marked/);
});

test('an empty word list does not throw and offers a way back', () => {
  let r;
  assert.doesNotThrow(() => { r = run([]); });
  assert.equal(r.screens.length, 1);
  assert.ok(r.buttons().some((b) => b.text === 'Back'));
  assert.ok(!r.buttons().some((b) => b.text === 'Got it'));
});

test('Finish POSTs the same payload shape as the list path (word_id + correct per word)', async () => {
  const r = run([{ id: 1, label: 'one' }, { id: 2, label: 'two' }]);
  r.buttons().find((b) => b.text === 'Got it').onclick();
  r.buttons().find((b) => b.text === 'Not yet').onclick();
  const fin = r.buttons().find((b) => b.text === 'Finish');
  assert.equal(fin.extra.disabled, false);
  await fin.onclick();
  assert.equal(r.posted.length, 1);
  assert.deepEqual(r.posted[0][2].results, [{ word_id: 1, correct: 1 }, { word_id: 2, correct: 0 }]);
  const listSrc = src.slice(src.indexOf('function markScreen('), start);
  assert.ok(listSrc.includes('results: words.map((w) => ({ word_id: w.id, correct: marks.get(w.id) }))'), 'list path payload changed; keep both in step');
});
