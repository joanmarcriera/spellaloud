// Trust pages (Vikunja #4949): terms and help exist, carry the refund sentence and the four help anchors,
// and every page under site/ plus the generated list pages links privacy, terms and help in its footer.
// Run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const read = (p) => readFileSync(join(root, p), 'utf8');

test('terms and help pages exist and mention refunds', () => {
  for (const f of ['site/terms/index.html', 'site/help/index.html']) {
    assert.ok(existsSync(join(root, f)), f);
    assert.match(read(f), /refund/i, f);
  }
  assert.match(read('site/terms/index.html'), /30 days/);
  assert.match(read('site/terms/index.html'), /3 business days/);
});

test('help page has the four answer anchors', () => {
  const h = read('site/help/index.html');
  for (const id of ['lost-words', 'no-sound', 'my-data', 'contact']) assert.match(h, new RegExp(`id="${id}"`), id);
});

test('trust copy is marked proposed', () => {
  for (const f of ['site/terms/index.html', 'site/help/index.html']) assert.match(read(f), /proposed, Marc to confirm/i, f);
});

const pages = (dir) => readdirSync(join(root, dir)).filter((d) => statSync(join(root, dir, d)).isDirectory())
  .map((d) => `${dir}/${d}/index.html`).filter((f) => existsSync(join(root, f)));

test('every site page and list page footer links privacy, terms and help', () => {
  const all = [...pages('site'), ...pages('drafts/lists')];
  assert.ok(all.length >= 7, `expected at least 7 pages, got ${all.length}`);
  for (const f of all) {
    const m = read(f).match(/<footer[\s\S]*?<\/footer>/g) || [];
    const foot = m.join('\n');
    for (const href of ['/privacy/', '/terms/', '/help/']) assert.ok(foot.includes(`href="${href}"`), `${f} footer lacks ${href}`);
  }
});
