// #6327: a device with no usable British (en-GB, on-device) voice cannot read a typed word aloud, so any word
// without a recording must be treated as "needs a recording": the kid/parent flow prompts to record it before
// dictation and never plays a silent word. Pure helpers in static/voice.js. Run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasBritishVoice, needsRecording, recordingPlan } from '../static/voice.js';

const gb = { name: 'Daniel', lang: 'en-GB', localService: true };
const us = { name: 'Samantha', lang: 'en-US', localService: true };
const netGb = { name: 'Google UK English Female', lang: 'en-GB', localService: false };
const typed = (id) => ({ id, label: 'w' + id, has_audio: false });
const clip = (id) => ({ id, label: 'w' + id, has_audio: true });

test('hasBritishVoice: only an on-device en-GB voice counts (not en-US, not a network voice, not an empty list)', () => {
  assert.equal(hasBritishVoice([us, gb]), true);
  assert.equal(hasBritishVoice([us]), false);
  assert.equal(hasBritishVoice([netGb]), false);
  assert.equal(hasBritishVoice([]), false);
  assert.equal(hasBritishVoice(undefined), false);
});

test('needsRecording: a word with no clip needs one only when there is no British voice', () => {
  assert.equal(needsRecording(typed(1), false), true);
  assert.equal(needsRecording(typed(1), true), false);
  assert.equal(needsRecording(clip(2), false), false, 'a recorded word never needs recording');
});

test('recordingPlan with no voice: unrecorded words go to record, recorded words stay playable, dictation is blocked', () => {
  const p = recordingPlan([clip(1), typed(2), typed(3)], [us], true);
  assert.deepEqual(p.record.map((w) => w.id), [2, 3]);
  assert.deepEqual(p.playable.map((w) => w.id), [1]);
  assert.equal(p.noVoice, true);
  assert.equal(p.blocked, true, 'Play waits until every word has a recording');
});

test('recordingPlan with a British voice: nothing to record, nothing blocked', () => {
  const p = recordingPlan([clip(1), typed(2)], [gb], true);
  assert.deepEqual(p.record, []);
  assert.equal(p.playable.length, 2);
  assert.equal(p.noVoice, false);
  assert.equal(p.blocked, false);
});

test('recordingPlan before the voice list has loaded: do not block (an empty list is not yet a verdict)', () => {
  const p = recordingPlan([typed(1)], [], false);
  assert.equal(p.noVoice, false);
  assert.equal(p.blocked, false);
  assert.deepEqual(p.record, []);
});

test('recordingPlan with no voice but every word recorded: not blocked', () => {
  const p = recordingPlan([clip(1), clip(2)], [], true);
  assert.equal(p.noVoice, true);
  assert.equal(p.blocked, false);
  assert.equal(p.playable.length, 2);
});

// Wiring: the helpers are what the screens call (a source check, like tests/onecard_wiring.test.mjs).
import { readFileSync } from 'node:fs';
const src = (f) => readFileSync(new URL(`../static/${f}`, import.meta.url), 'utf8');

test('kid Home and startPlaying use recordingPlan, so Play never starts with a silent word', () => {
  const app = src('app.js');
  assert.match(app, /recordingPlan\(p\.words, allVoices, voicesLoaded\)/, 'Home computes the plan');
  assert.match(app, /plan\.blocked\s*\n?\s*\? h\('button'[^\n]*onclick: recordScreen/, 'blocked Home offers Record, not Play');
  assert.match(app, /recordingPlan\(S\.practice\.words, allVoices, voicesLoaded\)\.blocked\) return recordScreen\(\)/, 'startPlaying redirects to Record');
});

test('parent page warns per child and links the help section', () => {
  const parent = src('parent.js');
  assert.match(parent, /recordingPlan\(weeks\.flatMap/);
  assert.match(parent, /href: '#voice-help'/);
});
