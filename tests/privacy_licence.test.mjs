// The privacy page must disclose the stored licence key while static/licence.js stores it (#5546).
// Run: node --test tests/privacy_licence.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('privacy page discloses the stored licence key and Lemon Squeezy', () => {
  const js = readFileSync(new URL('../static/licence.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../site/privacy/index.html', import.meta.url), 'utf8');
  assert.match(js, /key,\s*\n?\s*instanceId/); // licence.js really stores the full key
  assert.match(html, /Lemon Squeezy/);
  assert.match(html, /licence key/i);
  assert.match(html, /clear the site data/i);
});
