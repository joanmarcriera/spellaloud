// Y1/Y2 list pages carry a first-party hear-it control and a waitlist form (Vikunja #4117).
// Also checks bin/stage-lists output. Run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const SLUGS = ['year-1-common-exception-words', 'year-2-common-exception-words'];

for (const slug of SLUGS) {
  test(`${slug}: hear-it button, waitlist form, en-GB, no network`, () => {
    const h = readFileSync(join(root, 'drafts/lists', slug, 'index.html'), 'utf8');
    assert.match(h, /<html lang="en-GB">/);
    assert.match(h, /<button class="hear-it" id="hear-it" type="button" hidden lang="en-GB">/);
    assert.match(h, /<form class="waitlist" method="post" action="[^"]*" lang="en-GB">/);
    assert.match(h, /<input type="hidden" name="source" value="lists">/);
    assert.match(h, /<input id="email" name="email" type="email"/);
    assert.doesNotMatch(h, /en-us/i);
    assert.doesNotMatch(h, /\b(fetch|XMLHttpRequest|sendBeacon)\s*\(/);
  });
}

test('Y3-6 pages keep the link, not the form', () => {
  for (const s of ['year-3-and-4-spelling-words', 'year-5-and-6-spelling-words']) {
    const h = readFileSync(join(root, 'drafts/lists', s, 'index.html'), 'utf8');
    assert.doesNotMatch(h, /<form/);
    assert.doesNotMatch(h, /id="hear-it"/);
  }
});

test('bin/stage-lists stages only Y1/Y2 and drops links to unstaged pages', () => {
  const out = mkdtempSync(join(tmpdir(), 'stage-'));
  execFileSync(join(root, 'bin/stage-lists'), ['--out', out], { stdio: 'pipe' });
  for (const s of SLUGS) {
    const p = join(out, s, 'index.html');
    assert.ok(existsSync(p), p);
    const h = readFileSync(p, 'utf8');
    assert.match(h, /id="hear-it"/);
    assert.doesNotMatch(h, /year-3-and-4|year-5-and-6/);
  }
  assert.ok(!existsSync(join(out, 'year-3-and-4-spelling-words')));
  assert.match(readFileSync(join(out, SLUGS[0], 'index.html'), 'utf8'), /year-2-common-exception-words\/index\.html/);
});
