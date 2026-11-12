// Grown-up switches per child (2026-11-12, Marc's feedback): hide "I know it", skip the self-check, show
// Previous / Next / Finish during the dictation; plus the hold-to-explain tips on the child's Home. Run: node --test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KID_FLAGS, knowItShown, selfCheckOn, controlsOn, cleanKidFlags, modeTip, settingTip, HOVER_MS, HOLD_MS, jumpTarget } from '../static/kidopts.js';
import { createStore, memoryBackend } from '../static/store.js';
import { validateSnapshot } from '../static/backup.js';

const read = (f) => readFileSync(new URL('../static/' + f, import.meta.url), 'utf8');

test('defaults are today\'s behaviour: "I know it" shown, self-check on, grown-up buttons off', () => {
  assert.equal(knowItShown({}), true);
  assert.equal(selfCheckOn({}), true);
  assert.equal(controlsOn({}), false);
  assert.equal(knowItShown(undefined), true);
  assert.equal(knowItShown({ noKnowIt: true }), false);
  assert.equal(selfCheckOn({ noSelfCheck: true }), false);
  assert.equal(controlsOn({ controls: true }), true);
  assert.equal(controlsOn({ controls: 'yes' }), false, 'only boolean true counts');
});

test('cleanKidFlags keeps only boolean-true flags (absent = default), like typeMode', () => {
  assert.deepEqual(cleanKidFlags({ noKnowIt: true, noSelfCheck: false, controls: 'x', other: true }), { noKnowIt: true });
  assert.deepEqual(KID_FLAGS, ['noKnowIt', 'noSelfCheck', 'controls']);
});

test('the browser store saves the flags and drops them when switched off', async () => {
  const store = await createStore(memoryBackend());
  const r = (m, p, b) => store.request(m, p, b).then((x) => x.data);
  await r('POST', '/api/kids', { name: 'Ava' });
  const base = { speed: 'normal', repeats: 2, pause: 'short', order: 'mix' };
  const on = await r('PUT', '/api/kids/ava/settings', { ...base, noKnowIt: true, noSelfCheck: true, controls: true });
  assert.deepEqual([on.noKnowIt, on.noSelfCheck, on.controls], [true, true, true]);
  const off = await r('PUT', '/api/kids/ava/settings', { ...base });
  assert.deepEqual(off, base);
});

test('backup import accepts the flags and refuses a non-boolean', () => {
  const snap = (settings) => ({ kids: [{ slug: 'ava', name: 'Ava', year: 2, settings }], weeks: [], sessions: [] });
  assert.doesNotThrow(() => validateSnapshot(snap({ noKnowIt: true, noSelfCheck: false, controls: true })));
  assert.throws(() => validateSnapshot(snap({ controls: 'yes' })), /settings are invalid/);
});

test('tips explain each mode and setting; writing time names the real seconds', () => {
  assert.match(modeTip('week'), /this week/i);
  assert.match(modeTip('term'), /every word/i);
  assert.match(modeTip('tricky'), /wrong/i);
  assert.match(settingTip('pause'), /Short = 5 seconds.*Long = 10 seconds/);
  assert.match(settingTip('repeats'), /1, 2 or 3/);
  assert.match(settingTip('speed'), /Slow/);
  assert.match(settingTip('order'), /Mixed up/);
  assert.ok(HOVER_MS >= 1500 && HOLD_MS >= 1000, 'long enough that a child tapping never sees them');
});

test('Previous / Next jump by whole words; Next after the last word finishes', () => {
  // schedule steps: each word said twice
  const steps = [0, 0, 1, 1, 2, 2].map((index) => ({ index }));
  assert.equal(jumpTarget(steps, 3, +1), 4);   // in word 1 -> first step of word 2
  assert.equal(jumpTarget(steps, 3, -1), 0);   // in word 1 -> first step of word 0
  assert.equal(jumpTarget(steps, 1, -1), 0);   // in word 0 -> stays on word 0
  assert.equal(jumpTarget(steps, 4, +1), -1);  // in the last word -> finish
});

test('the kid app gates the buttons and the check on the switches; the Look speaker uses the British voice too', () => {
  const app = read('app.js');
  assert.match(app, /knowItShown\(S\.kid\.settings\) && btn\('check', 'I know it'/);
  assert.match(app, /w\.tricky && knowItShown\(S\.kid\.settings\) && btn\('check', 'I know it'/);
  assert.match(app, /selfCheckOn\(done\.settings\)/);
  assert.match(app, /controlsOn\(settings\) && h\('div', \{ class: 'row grownup' \}/);
  assert.match(app, /disabled: !canSay\(w\)/); // was disabled: !w.has_audio, silent for voice-only words
  assert.match(app, /attachTip\(/);
});

test('review: every flag is accepted by the LAN server too (server.py lists the same names)', () => {
  const py = readFileSync(new URL('../server.py', import.meta.url), 'utf8');
  const m = py.match(/for flag in \(([^)]*)\):/);
  assert.ok(m, 'server.py loops over the grown-up flags');
  assert.deepEqual(m[1].split(',').map((x) => x.trim().replace(/"/g, '')).filter(Boolean), KID_FLAGS);
});

test('review: settings are merged over what is stored now, never sent from an old copy', () => {
  const parent = read('parent.js');
  assert.match(parent, /async function patchSettings\(slug, change\)/);
  assert.doesNotMatch(parent, /\{ \.\.\.k\.settings, (voice|typeMode):/); // the old stale-copy PUTs are gone
  assert.match(read('app.js'), /\{ \.\.\.\(fresh \? fresh\.settings : savedSettings\), \.\.\.chips \}/);
});

test('review: tips close on any new press, key or screen change and never point at a removed element', () => {
  const src = read('kidopts.js');
  assert.match(src, /if \(!el\.isConnected\) return;/);
  assert.match(src, /document\.addEventListener\('keydown', hideTip, true\)/);
  assert.match(src, /document\.addEventListener\('click', \(e\) => \{\s*if \(swallowEl && swallowEl\.contains\(e\.target\)\)/);
  assert.match(read('app.js'), /function show\(\.\.\.nodes\) \{\s*hideTip\(\);/);
});

test('review 2: a cancelled long press (Android) cannot swallow the next tap', () => {
  const src = read('kidopts.js');
  assert.match(src, /if \(swallowEl === el\) swallowEl = null; \/\/ a fresh press is never swallowed/);
  assert.match(src, /el\.addEventListener\('pointercancel', release\)/);
});
