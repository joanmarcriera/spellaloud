// #6325: "Explain how to install a British voice." A short plain-HTML help section in the parent page
// (static, no script, no third-party link), linked from every place the no-voice state is shown. Run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../static/${f}`, import.meta.url), 'utf8');
const html = read('parent.html');
const section = (html.match(/<section[^>]*id="voice-help"[\s\S]*?<\/section>/) || [''])[0];

test('parent page has a #voice-help section', () => assert.ok(section, 'section#voice-help missing'));

for (const [name, steps] of [
  ['iPhone and iPad', ['Settings', 'Accessibility', 'Spoken Content', 'Voices', 'English', 'English (UK)']],
  ['Android', ['Settings', 'System', 'Languages', 'Text-to-speech', 'Google', 'English (United Kingdom)']],
  ['Windows', ['Settings', 'Time', 'Language', 'English (United Kingdom)', 'Speech']],
  ['macOS', ['System Settings', 'Accessibility', 'Spoken Content', 'System Voice', 'Manage Voices', 'English (United Kingdom)']],
  ['ChromeOS', ['Settings', 'Accessibility', 'Text-to-Speech', 'Voices', 'English (United Kingdom)']],
]) {
  test(`help names the steps for ${name}`, () => {
    assert.ok(section.includes(name), name);
    for (const s of steps) assert.ok(section.includes(s), `${name}: ${s}`);
  });
}

test('help is plain: no script, no third-party URL, no inline handler, short', () => {
  assert.doesNotMatch(section, /<script|https?:\/\/|\son\w+=/i);
  assert.ok(section.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length < 330, 'keep the wording short');
});

test('help says to reload the page and that the voice must be installed on the device (no network voices)', () => {
  assert.match(section, /reload|refresh/i);
  assert.match(section, /on the device|downloaded/i);
});

test('every no-voice message links to it', () => {
  assert.match(read('app.js'), /href: '\/parent#voice-help'/);
  const parent = read('parent.js');
  assert.ok((parent.match(/voiceHelpLink\(\)/g) || []).length >= 2, 'the parent notice and the Word voice note use the link');
});

// Marc 2026-11-08: "put links for those settings". Only links that open the device's own Settings app
// (no web pages, so the no-third-party rule above still holds). iOS and ChromeOS let no web page open
// their settings, so the help says so instead of offering a dead link.
const hrefs = [...section.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
test('Android, Windows and macOS have a link that opens the settings screen', () => {
  assert.ok(hrefs.includes('intent:#Intent;action=com.android.settings.TTS_SETTINGS;end'), 'Android TTS settings intent');
  assert.ok(hrefs.includes('ms-settings:speech'), 'Windows speech settings');
  assert.ok(hrefs.some((h) => h.startsWith('x-apple.systempreferences:com.apple.preference.universalaccess')), 'macOS Accessibility');
});
test('settings links use only settings schemes, and iOS/ChromeOS explain why there is no link', () => {
  for (const h of hrefs) assert.match(h, /^(intent:|ms-settings:|x-apple\.systempreferences:)/, h);
  assert.match(section, /no link|cannot open|can't open/i);
  assert.match(section, /if nothing happens/i);
});

// Marc 2026-11-08: the settings links did nothing on the Cozyla (Fully Kiosk = Android WebView, UA has "; wv)").
// A green/red line at the top of the help says whether this browser has a British voice, and in an in-app
// browser says plainly that installing a voice will not help there.
import { voiceStatus } from '../static/voice.js';
const CHROME = 'Mozilla/5.0 (Linux; Android 13; RK3588) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0 Safari/537.36';
const FULLY = 'Mozilla/5.0 (Linux; Android 13; RK3588 Build/TQ3C.230805.001.B2; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/156.0.8078.50 Safari/537.36';
test('voice status: green with the voice name when a British voice exists', () => {
  const s = voiceStatus({ name: 'Google UK English Female' }, CHROME);
  assert.equal(s.ok, true);
  assert.match(s.text, /British voice ready/);
  assert.match(s.text, /Google UK English Female/);
});
test('voice status: red when there is none, with the in-app-browser explanation only in a WebView', () => {
  const plain = voiceStatus(null, CHROME);
  assert.equal(plain.ok, false);
  assert.equal(plain.webview, false);
  assert.match(plain.text, /No British voice/);
  const wv = voiceStatus(null, FULLY);
  assert.equal(wv.ok, false);
  assert.equal(wv.webview, true);
  assert.match(wv.text, /built-in browser/i);
  assert.match(wv.text, /record/i);
});
test('help has the status line and the Android button can be hidden in a WebView', () => {
  assert.match(section, /id="vstatus"[^>]*role="status"|role="status"[^>]*id="vstatus"/);
  assert.match(section, /id="vandroid"/);
  assert.match(read('parent.js'), /voiceStatus\(/);
});
