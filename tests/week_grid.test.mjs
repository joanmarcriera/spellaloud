// Look & listen (the per-week word list): a grid of word cards on wide screens, one column on phones,
// and a friendly "Mon 2 Nov" date. Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { weekLabel } from '../static/lib.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('weekLabel writes a Monday as "Mon 2 Nov", the same on every device locale', () => {
  assert.equal(weekLabel('2026-11-02'), 'Mon 2 Nov');
  assert.equal(weekLabel('2026-12-28'), 'Mon 28 Dec');
  assert.equal(weekLabel('2027-01-04'), 'Mon 4 Jan');
});

test('weekLabel leaves a malformed date as it was given rather than printing "Invalid Date"', () => {
  assert.equal(weekLabel('soon'), 'soon');
});

test('the look screen builds a word grid with a status pill per card, and the stylesheet lays it out', () => {
  const app = read('static/app.js');
  const start = app.indexOf('function lookScreen');
  const look = app.slice(start, app.indexOf('// ----', start));
  assert.match(look, /class: 'looklist wordgrid'/);
  assert.match(look, /class: 'markrow wordcard'/);
  assert.match(look, /pill/);
  assert.match(look, /weekLabel\(week\.week_start\)/);
  const css = read('static/style.css');
  assert.match(css, /@media \(min-width: 900px\)\s*\{[^@]*?\.wordgrid\s*\{[^}]*repeat\(auto-fill, minmax\([^)]*3\d0px[^)]*\)/);
});
