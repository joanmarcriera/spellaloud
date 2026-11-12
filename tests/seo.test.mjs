// SEO basics on the built list pages and dist/ (Vikunja #4342). Run with `node --test`.
// Builds dist into a scratch dir with bin/build-dist --allow-todo (twice: default base and a custom --base),
// then checks title/description limits, canonical, Open Graph, JSON-LD, sitemap.xml and robots.txt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const build = (...extra) => {
  const out = join(mkdtempSync(join(tmpdir(), 'seo-')), 'dist');
  execFileSync('python3', ['-I', join(root, 'bin/build-dist'), '--allow-todo', '--out', out, ...extra], { stdio: 'pipe' });
  return out;
};
const decode = (s) => s.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const meta = (h, re) => { const m = h.match(re); return m ? decode(m[1]) : null; };

const BASE = 'https://spellaloud.joanmarcriera.es'; // bin/build-dist default origin
const dist = build();
const METHOD_SLUGS = ['look-cover-write-check', 'how-to-help-your-child-learn-spellings']; // guides, not word lists: no ItemList, checked in seo_lists.test.mjs
const slugs = readdirSync(join(dist, 'lists')).filter((s) => !METHOD_SLUGS.includes(s));

test('dist has list pages to check', () => assert.ok(slugs.length >= 2));

for (const slug of slugs) {
  const h = readFileSync(join(dist, 'lists', slug, 'index.html'), 'utf8');
  const url = `${BASE}/lists/${slug}/`;
  test(`${slug}: title <= 70, description <= 160, canonical, Open Graph`, () => {
    const title = meta(h, /<title>([^<]*)<\/title>/);
    const desc = meta(h, /<meta name="description" content="([^"]*)">/);
    assert.ok(title && title.length <= 70, `title ${title?.length}`);
    assert.ok(desc && desc.length <= 160, `description ${desc?.length}`);
    assert.equal(meta(h, /<link rel="canonical" href="([^"]*)">/), url);
    assert.equal(meta(h, /<meta property="og:title" content="([^"]*)">/), title);
    assert.equal(meta(h, /<meta property="og:description" content="([^"]*)">/), desc);
    assert.equal(meta(h, /<meta property="og:url" content="([^"]*)">/), url);
  });
  test(`${slug}: JSON-LD ItemList parses, en-GB, has the words`, () => {
    const raw = h.match(/<script type="application\/ld\+json">([^<]*)<\/script>/);
    assert.ok(raw, 'no JSON-LD');
    const ld = JSON.parse(raw[1]);
    assert.equal(ld['@type'], 'ItemList');
    assert.equal(ld.inLanguage, 'en-GB');
    assert.equal(ld.numberOfItems, ld.itemListElement.length);
    assert.ok(ld.itemListElement.length >= 40);
  });
}

test('sitemap.xml names /, /privacy/ and every list slug; robots.txt points at it', () => {
  const sm = readFileSync(join(dist, 'sitemap.xml'), 'utf8');
  const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(locs.slice(0, 5), [`${BASE}/`, `${BASE}/privacy/`, `${BASE}/terms/`, `${BASE}/help/`, `${BASE}/changelog/`]);
  for (const slug of slugs) assert.ok(locs.includes(`${BASE}/lists/${slug}/`), slug);
  assert.equal(locs.length, 5 + slugs.length + METHOD_SLUGS.length, 'lists plus the two guides');
  for (const m of METHOD_SLUGS) assert.ok(locs.includes(`${BASE}/lists/${m}/`), m);
  assert.ok(!locs.some((l) => /\/(thanks|m|e|r)\//.test(l)), 'duplicates and thanks stay out');
  const robots = readFileSync(join(dist, 'robots.txt'), 'utf8');
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, new RegExp(`^Sitemap: ${BASE}/sitemap\\.xml$`, 'm'));
});

test('--base swaps the origin everywhere and asserts no other domain', () => {
  const out = build('--base', 'https://spellings.test/');
  const sm = readFileSync(join(out, 'sitemap.xml'), 'utf8');
  assert.ok(sm.includes('<loc>https://spellings.test/lists/'));
  assert.ok(!sm.includes('example.invalid'));
  for (const slug of readdirSync(join(out, 'lists'))) {
    const h = readFileSync(join(out, 'lists', slug, 'index.html'), 'utf8');
    assert.ok(!h.includes('example.invalid'), slug);
    assert.ok(h.includes(`href="https://spellings.test/lists/${slug}/"`), slug);
    JSON.parse(h.match(/<script type="application\/ld\+json">([^<]*)<\/script>/)[1]);
  }
  assert.ok(existsSync(join(out, 'robots.txt')));
});
