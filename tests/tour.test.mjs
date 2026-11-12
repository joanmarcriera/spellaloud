// Guided tour (static/tour.js): the pure half - when it opens by itself, device detection, per-device steps,
// the WhatsApp/share text - plus source-shape checks that the parent page and kid welcome screen wire it up.
// Run with `node --test` (no path argument).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TOUR_STEPS, TOUR_KEY, SOURCE_URL, shouldAutoStart, tourSeen, markTour, devicePlatform, VOICE_STEPS, INSTALL_STEPS,
  PLATFORM_NAME, shareMessage, whatsappUrl } from '../static/tour.js';

const read = (f) => readFileSync(new URL(`../static/${f}`, import.meta.url), 'utf8');
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };

test('the tour covers child, words, voice, sharing, backup and feedback, in that order', () => {
  assert.deepEqual(TOUR_STEPS.map((s) => s.id), ['welcome', 'child', 'words', 'voice', 'share', 'backup', 'feedback', 'done']);
  for (const s of TOUR_STEPS) assert.ok(s.title.length > 3);
});

test('auto-start: only a new local device that has not seen it; ?tour=1 always', () => {
  assert.equal(shouldAutoStart({ mode: 'local', kids: [], seen: false }), true);
  assert.equal(shouldAutoStart({ mode: 'local', kids: [], seen: true }), false);
  assert.equal(shouldAutoStart({ mode: 'local', kids: [{ slug: 'ava' }], seen: false }), false);
  assert.equal(shouldAutoStart({ mode: 'server', kids: [], seen: false }), false); // family LAN build never
  assert.equal(shouldAutoStart({ mode: 'local', kids: [{ slug: 'ava' }], seen: true, search: '?tour=1' }), true);
  assert.equal(shouldAutoStart({ mode: 'local', kids: [], seen: true, search: '?tour=0' }), false);
});

test('seen flag survives in storage and blocked storage counts as unseen', () => {
  const s = mem();
  assert.equal(tourSeen(s), false);
  markTour('closed', s);
  assert.equal(tourSeen(s), true);
  assert.equal(s.getItem(TOUR_KEY), 'closed');
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(tourSeen(blocked), false);
  assert.doesNotThrow(() => markTour('done', blocked));
});

test('device detection covers phones, tablets and computers (iPadOS reports a Mac with touch)', () => {
  assert.equal(devicePlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'ios');
  assert.equal(devicePlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5), 'ios');
  assert.equal(devicePlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0), 'mac');
  assert.equal(devicePlatform('Mozilla/5.0 (Linux; Android 13; RK3588; wv)'), 'android');
  assert.equal(devicePlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'windows');
  assert.equal(devicePlatform('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)'), 'chromeos');
  assert.equal(devicePlatform('Mozilla/5.0 (X11; Linux x86_64)'), 'other');
});

test('every platform has voice-install steps, home-screen steps and a name', () => {
  for (const p of ['ios', 'android', 'windows', 'mac', 'chromeos', 'other']) {
    assert.ok(VOICE_STEPS[p].length >= 2, p);
    assert.ok(INSTALL_STEPS[p].length > 10, p);
    assert.ok(PLATFORM_NAME[p], p);
  }
  assert.match(VOICE_STEPS.ios.join(' '), /English \(UK\)/);
  assert.match(VOICE_STEPS.android.join(' '), /English \(United Kingdom\)/);
});

test('WhatsApp link carries the message encoded; the message names the words, never a child', () => {
  const link = 'https://spellaloud.joanmarcriera.es/parent#sl=1&w=cat&w=dog';
  const text = shareMessage(link, 'Week of 2026-11-09');
  assert.match(text, /Week of 2026-11-09/);
  assert.ok(text.endsWith(link));
  const wa = whatsappUrl(text);
  assert.ok(wa.startsWith('https://wa.me/?text='));
  assert.equal(decodeURIComponent(wa.slice('https://wa.me/?text='.length)), text);
});

test('tour.js has no HTML sinks and makes no network requests of its own', () => {
  const src = read('tour.js');
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket/);
  assert.match(SOURCE_URL, /^https:\/\/github\.com\//);
});

test('parent page wires the tour (button, auto-start, replay) and the kid welcome screen offers it', () => {
  const src = read('parent.js');
  assert.match(src, /from '\.\/tour\.js'/);
  assert.match(src, /btn\.onclick = \(\) => openTour\(tourDeps\(t\)\)/);
  assert.match(src, /shouldAutoStart\(\{ mode: t\.mode, kids: kidList, seen: tourSeen\(\), search: location\.search \}\)/);
  assert.match(read('parent.html'), /id="tourbtn"[^>]*>Take the tour</);
  assert.match(read('app.js'), /t\.mode === 'local' \? h\('a', \{ class: 'btn solid big', href: '\/parent\?tour=1' \+ location\.hash \}, 'Start the tour'\)/);
  assert.match(src, /if \(rendered && shouldAutoStart/); // never over a page that failed to load
  assert.match(src, /if \(sharedSaved\) history\.replaceState/); // a shared list is not offered twice
});

test('tour guards: one action at a time, stale renders dropped, finish runs once', () => {
  const src = read('tour.js');
  assert.match(src, /if \(state\.busy\) return;/);
  assert.match(src, /if \(seq !== state\.seq \|\| state\.finished\) return;/);
  assert.match(src, /if \(state\.finished\) return;/);
  assert.match(src, /setAction\(null\); \/\/ the old card's job must not run again/);
});
