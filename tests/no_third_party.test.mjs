// Privacy guard (Vikunja #3542): the kid and parent pages must not pull fonts, scripts, styles or
// images from any other origin. Run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

for (const f of ['static/index.html', 'static/parent.html', 'static/style.css']) {
  test(`${f} references no external origin`, () => {
    const text = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    const ext = text.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+|url\(\s*["']?https?:\/\/[^)]+|@import\s+["']?https?:/gi) || [];
    assert.deepEqual(ext, []);
  });
}

// site/** and drafts/lists/** (draft public pages, Vikunja #4059): no external *subresources* (script/link/img/iframe/source/
// form action, CSS url()/@import) and no network calls from inline scripts. Plain <a href> links to
// other sites are navigation, not requests, so they are allowed.
const walk = (d) => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const siteFiles = ['../site', '../drafts/lists'].flatMap((d) => walk(new URL(d, import.meta.url).pathname)).filter((f) => /\.(html|css|js)$/.test(f));
test('site/** has pages to guard', () => assert.ok(siteFiles.length >= 6));
const EXT_SUBRESOURCE = new RegExp([
  '<(?:script|img|iframe|source|embed|video|audio)\\b[^>]*\\ssrc\\s*=\\s*["\']?(?:https?:)?//[^"\'\\s>]+',
  // rel=canonical is metadata for search engines, not a subresource request (Vikunja #4342)
  '<link\\b(?![^>]*\\srel\\s*=\\s*["\']?canonical)[^>]*\\shref\\s*=\\s*["\']?(?:https?:)?//[^"\'\\s>]+',
  '<form\\b[^>]*\\saction\\s*=\\s*["\']?https?://[^"\'\\s>]+',
  'url\\(\\s*["\']?(?:https?:)?//[^)]+',
  '@import\\s+["\']?(?:https?:)?//',
].join('|'), 'gi');
for (const f of siteFiles) {
  test(`${f.split('/spellings/')[1] ?? f} makes no third-party or network requests`, () => {
    const text = readFileSync(f, 'utf8');
    assert.deepEqual(text.match(EXT_SUBRESOURCE) || [], []);
    assert.doesNotMatch(text, /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket)\s*\(|new\s+(XMLHttpRequest|WebSocket)|google-analytics|gtag|plausible|matomo/i);
  });
}
