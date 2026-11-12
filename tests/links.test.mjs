// Link walker for the built site (Vikunja #4952). Run with `node --test tests/links.test.mjs` (or plain `node --test`).
// Builds dist into a scratch dir with bin/build-dist --allow-todo (override with LINKS_DIST=<dir> to walk another build,
// which is how the red run is shown: point it at a copy with a planted dead link), then checks that
//   1. every internal href/src in every built HTML page resolves to a file (and #fragments to an id in that file),
//   2. every page links /privacy/, /terms/ and /help/,
//   3. one and the same support address (mailto:) appears on privacy, thanks, help and terms, and nowhere another.
// Stdlib only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, mkdtempSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const dist = process.env.LINKS_DIST || (() => {
  const out = join(mkdtempSync(join(tmpdir(), 'links-')), 'dist');
  execFileSync('python3', ['-I', join(root, 'bin/build-dist'), '--allow-todo', '--out', out], { stdio: 'pipe' });
  return out;
})();

const walk = (d) => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const htmlFiles = walk(dist).filter((f) => f.endsWith('.html'));
const strip = (h) => h.replace(/<!--[\s\S]*?-->/g, '');
const refs = (h) => [...strip(h).matchAll(/\b(?:href|src)\s*=\s*"([^"]*)"/g)].map((m) => m[1]);
const isExternal = (u) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(u);   // http:, mailto:, data:, //host

/** Map a URL found in `page` to the file it should be served from, or null when it points outside dist. */
function target(page, url) {
  const [path, frag] = url.split('#');
  const clean = path.split('?')[0];
  let file;
  if (clean === '') file = page;
  else {
    file = clean.startsWith('/') ? join(dist, clean) : resolve(dirname(page), clean);
    if (clean.endsWith('/')) file = join(file, 'index.html');
  }
  return { file, frag };
}

test('dist has pages to walk', () => assert.ok(htmlFiles.length >= 10, `only ${htmlFiles.length} pages`));

test('every internal link resolves to a file and every #fragment to an id', () => {
  const broken = [];
  for (const page of htmlFiles) {
    const h = readFileSync(page, 'utf8');
    for (const u of refs(h)) {
      if (isExternal(u) || u.startsWith('#TODO')) continue;
      const { file, frag } = target(page, u);
      if (!existsSync(file) || !statSync(file).isFile()) { broken.push(`${relative(dist, page)} -> ${u}`); continue; }
      if (frag && !frag.includes('=') && file.endsWith('.html') && !new RegExp(`\\bid="${frag}"`).test(readFileSync(file, 'utf8'))) {
        broken.push(`${relative(dist, page)} -> ${u} (no id="${frag}")`);
      }
    }
  }
  assert.deepEqual(broken, [], `broken internal links:\n${broken.join('\n')}`);
});

test('every page links privacy, terms and help', () => {
  const missing = [];
  for (const page of htmlFiles) {
    if (relative(dist, page).startsWith('try/')) continue; // /try/ is the app, not a site page
    const urls = refs(readFileSync(page, 'utf8')).map((u) => u.split('#')[0]);
    for (const want of ['/privacy/', '/terms/', '/help/']) {
      if (!urls.includes(want)) missing.push(`${relative(dist, page)} lacks ${want}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('one support address, the same on privacy, thanks, help and terms', () => {
  const addrs = (rel) => [...new Set([...strip(readFileSync(join(dist, rel), 'utf8')).matchAll(/mailto:([^"?]+)/g)].map((m) => m[1]))];
  const seen = new Set();
  for (const rel of ['privacy/index.html', 'thanks/index.html', 'help/index.html', 'terms/index.html']) {
    const a = addrs(rel);
    assert.equal(a.length, 1, `${rel} must carry exactly one support address, found ${JSON.stringify(a)}`);
    seen.add(a[0]);
  }
  assert.equal(seen.size, 1, `support address differs between pages: ${[...seen].join(', ')}`);
  // every other page may carry it, but never a different one
  for (const page of htmlFiles) {
    for (const m of strip(readFileSync(page, 'utf8')).matchAll(/mailto:([^"?]+)/g)) {
      assert.ok(seen.has(m[1]), `${relative(dist, page)} uses another address: ${m[1]}`);
    }
  }
});
