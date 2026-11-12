// SEO guard for the list pages (Vikunja #4634). "year 2 spelling words" also resolves to Australia and
// New Zealand, so every list page names England, the UK or the National Curriculum in its <title>, its
// <h1> and its meta description, and keeps the title at 70 characters or fewer.
// Covers drafts/lists/* and, when present (dist is git-ignored), dist/lists/*. Run with `node --test tests/`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseShare } from '../static/share.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const TERM = /\b(England|UK|National Curriculum)\b/i;
const pages = [];
for (const base of ['drafts/lists', 'dist/lists']) {
  const dir = join(root, base);
  if (!existsSync(dir)) continue;
  for (const slug of readdirSync(dir)) {
    const f = join(dir, slug, 'index.html');
    if (existsSync(f)) pages.push([base + '/' + slug, readFileSync(f, 'utf8')]);
  }
}
const decode = (s) => s.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');

test('there are list pages to check (four lists and two method pages as drafts)', () => {
  assert.ok(pages.filter(([n]) => n.startsWith('drafts/')).length >= 6);
});

// Method pages (Vikunja #4635): canonical, JSON-LD, hear-it, links to the four list pages, no medical claims.
const METHOD = ['look-cover-write-check', 'how-to-help-your-child-learn-spellings'];
const LISTS = ['year-1-common-exception-words', 'year-2-common-exception-words', 'year-3-and-4-spelling-words', 'year-5-and-6-spelling-words'];
for (const slug of METHOD) {
  test('method page ' + slug + ': canonical, JSON-LD, hear-it, list links, no health claims, no network', () => {
    const html = readFileSync(join(root, 'drafts/lists', slug, 'index.html'), 'utf8');
    assert.match(html, /<html lang="en-GB">/);
    assert.match(html, new RegExp('<link rel="canonical" href="/lists/' + slug + '/">'));
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1]);
    assert.match(ld['@type'], /^(HowTo|Article)$/);
    assert.match(html, /<button class="hear-it" id="hear-it" type="button" hidden lang="en-GB">/);
    assert.ok(/<button class="hear" /.test(html));
    for (const l of LISTS) assert.ok(html.includes('../' + l + '/index.html'), 'links to ' + l);
    assert.doesNotMatch(html, /dyslex|autis|adhd|diagnos|therap|\bcure\b|clinical/i);
    assert.doesNotMatch(html, /<(script|img|iframe|link)\b[^>]*(src|href)\s*=\s*["']?(https?:)?\/\//i);
    assert.doesNotMatch(html, /\b(fetch|XMLHttpRequest|sendBeacon)\s*\(/);
  });
}

// Try-it-now links (Vikunja #4633): the fragment must be a valid share link for static/share.js.
for (const rel of ['site/waitlist/index.html', 'drafts/lists/year-2-common-exception-words/index.html', 'drafts/lists/year-1-common-exception-words/index.html']) {
  test(rel + ': try-it-now link opens /try/parent/ with the list in the fragment', () => {
    const html = readFileSync(join(root, rel), 'utf8');
    const href = decode(html.match(/class="trylink" href="([^"]+)"/)[1]);
    assert.ok(href.startsWith('/try/parent/#sl=1'), href);
    const shared = parseShare(href.slice(href.indexOf('#')));
    assert.ok(shared && shared.words.length >= 45, 'share link parses with the words');
    assert.ok(shared.words.includes(rel.includes('year-1') ? 'friend' : 'because'));
  });
}

test('the try-it words on the method pages are real Year 1/2 list words', () => {
  const lists = JSON.parse(readFileSync(join(root, 'content/uk-statutory/lists.json'), 'utf8')).lists;
  const known = new Set(lists.filter((l) => /^y[12]-/.test(l.id)).flatMap((l) => l.entries.flatMap((e) => e.forms)));
  const html = readFileSync(join(root, 'drafts/lists', METHOD[0], 'index.html'), 'utf8');
  const words = [...html.matchAll(/data-word="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(words.length >= 5);
  for (const w of words) assert.ok(known.has(w), w + ' is not in the Y1/Y2 lists');
});

for (const [name, html] of pages) {
  test(name + ': England/UK/National Curriculum in title, H1 and description; title <= 70 chars', () => {
    const title = decode(html.match(/<title>([^<]*)<\/title>/)[1]);
    const h1 = decode(html.match(/<h1>([^<]*)<\/h1>/)[1]);
    const desc = decode(html.match(/<meta name="description" content="([^"]*)"/)[1]);
    assert.match(title, TERM, 'title');
    assert.match(h1, TERM, 'h1');
    assert.match(desc, TERM, 'description');
    assert.ok(title.length <= 70, 'title is ' + title.length + ' chars: ' + title);
  });
}
