// Changelog page (Vikunja #4953): site/changelog/index.html is generated from entries.txt by bin/build-changelog,
// is current, says "Last updated" with the newest date, opens with the waiting-list launch, and uses plain sentences
// (no conventional-commit prefixes, ticket numbers or hashes). Run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const page = readFileSync(join(root, 'site/changelog/index.html'), 'utf8');
const entries = readFileSync(join(root, 'site/changelog/entries.txt'), 'utf8')
  .split('\n').filter((l) => l.trim() && !l.startsWith('#'));

test('generated page is up to date with entries.txt', () => {
  const out = execFileSync('python3', ['-I', join(root, 'bin/build-changelog'), '--check'], { encoding: 'utf8' });
  assert.match(out, /up to date/);
});

test('first entry is the waiting-list launch and Last updated is its date', () => {
  const [date, sentence] = entries[0].split('|').map((s) => s.trim());
  assert.match(sentence, /waiting list opens/i);
  assert.ok(page.includes(`Last updated ${date}`), 'Last updated line');
});

test('entries are plain sentences', () => {
  assert.ok(entries.length >= 4);
  for (const l of entries) {
    const s = l.split('|')[1].trim();
    assert.match(s, /^[A-Z].*[.]$/, s);
    assert.doesNotMatch(s, /^(feat|fix|docs|chore|test|ci|refactor)\b|\(#\d+\)|#\d{3,}|\b[0-9a-f]{7,40}\b|Bug fixes/, s);
  }
});

test('page has footer links, a support address and no scripts', () => {
  for (const h of ['/privacy/', '/terms/', '/help/', 'mailto:']) assert.ok(page.includes(h), h);
  assert.doesNotMatch(page, /<script/i);
});
