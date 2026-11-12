// Tests for the draft SEO list pages built by tools/build_list_pages.py (Vikunja #4059).
// The pages are regenerated into a temp dir and compared byte-for-byte with drafts/lists/, so a stale
// commit of generated output fails. Run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const data = JSON.parse(readFileSync(join(root, 'content/uk-statutory/lists.json'), 'utf8'));
const SLUGS = {
  'y1-common-exception-words': 'year-1-common-exception-words',
  'y2-common-exception-words': 'year-2-common-exception-words',
  'y3-4-word-list': 'year-3-and-4-spelling-words',
  'y5-6-word-list': 'year-5-and-6-spelling-words',
};
const page = (slug) => readFileSync(join(root, 'drafts/lists', slug, 'index.html'), 'utf8');
const decode = (s) => s.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

test('generated pages are up to date (rebuild is byte-identical)', () => {
  const out = mkdtempSync(join(tmpdir(), 'lists-'));
  execFileSync('python3', ['-I', join(root, 'tools/build_list_pages.py'), '--out', out], { stdio: 'pipe' });
  for (const slug of Object.values(SLUGS)) {
    assert.equal(readFileSync(join(out, slug, 'index.html'), 'utf8'), page(slug), slug);
  }
});

for (const l of data.lists) {
  const slug = SLUGS[l.id];
  test(`${slug}: title, H1, full list, ItemList, attribution, waitlist link`, () => {
    const h = page(slug);
    assert.match(h, /<html lang="en-GB">/);
    assert.match(h, /<title>[^<]*(Year [1-6])[^<]*<\/title>/);
    assert.equal((h.match(/<h1>/g) || []).length, 1);
    // every official entry is in the table, in order, and nothing else
    const cells = [...h.matchAll(/<span class="w">([^<]*)<\/span>/g)].map((m) => decode(m[1]));
    assert.equal(cells.length, l.entries.length);
    assert.deepEqual([...cells].sort(), l.entries.map((e) => e.official).sort());
    // JSON-LD
    const ld = JSON.parse(h.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1]);
    assert.equal(ld['@type'], 'ItemList');
    assert.equal(ld.numberOfItems, l.entries.length);
    assert.equal(ld.itemListElement.length, l.entries.length);
    // hear buttons: one per form, hidden by default, never a US fallback
    const btns = [...h.matchAll(/<button class="hear" type="button" hidden data-word="([^"]+)"/g)].map((m) => decode(m[1]));
    assert.deepEqual(btns.sort(), l.entries.flatMap((e) => e.forms).sort());
    assert.match(h, /function pickVoice/);
    assert.doesNotMatch(h, /en-us/i);
    // legal + honesty
    assert.match(h, /Open Government Licence v3\.0/);
    assert.match(h, /Not affiliated with the Department for Education/);
    assert.doesNotMatch(h, /SATs/i);
    // links resolve
    // Y3-6 link to the waitlist page; Y1/Y2 carry the form itself (#4117)
    if (/^year-[12]-/.test(slug)) assert.match(h, /<form class="waitlist"/);
    else assert.match(h, /href="\.\.\/\.\.\/\.\.\/site\/waitlist\/index\.html"/);
    assert.ok(existsSync(join(root, 'site/waitlist/index.html')));
    for (const m of h.matchAll(/href="\.\.\/([a-z0-9-]+)\/index\.html"/g)) assert.ok(existsSync(join(root, 'drafts/lists', m[1], 'index.html')), m[1]);
    // print: one A4 page rules present
    assert.match(h, /@page \{ size:A4/);
  });
}

test('statutory wording is honest: Y1/Y2 are examples, Y3-6 are statutory', () => {
  assert.match(page(SLUGS['y3-4-word-list']), /Yes\. The Years 3 and 4 word list is statutory/);
  assert.match(page(SLUGS['y5-6-word-list']), /Yes\. The Years 5 and 6 word list is statutory/);
  assert.match(page(SLUGS['y1-common-exception-words']), /listed as examples/);
  assert.match(page(SLUGS['y2-common-exception-words']), /listed as examples/);
});
