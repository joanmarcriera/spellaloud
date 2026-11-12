// Vikunja #3540: the Buy-me-a-coffee link lives in the parent area only, as a plain outbound link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const URL_RE = /https:\/\/marcriera\.lemonsqueezy\.com\/checkout\/buy\/5fbc35a0-bd77-470f-8e9b-e184199a3f4f/;

test('parent.js carries the existing LS tip link, noopener, no embed', () => {
  const js = read('static/parent.js');
  assert.match(js, URL_RE);
  assert.match(js, /rel: 'noopener noreferrer'/);
  assert.doesNotMatch(js, /lemonsqueezy\.com\/js|embed=1/);
});
test('parent.html has the tip container; kid pages never mention the tip', () => {
  assert.match(read('static/parent.html'), /id="tipbox"/);
  for (const f of ['static/index.html', 'static/app.js']) assert.doesNotMatch(read(f), /lemonsqueezy\.com\/checkout|coffee/i);
});
