// Schema + sanity tests for content/uk-statutory/lists.json (run with `node --test`).
// Counts are those recorded from the GOV.UK source in content/uk-statutory/SOURCES.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(new URL('../content/uk-statutory/lists.json', import.meta.url), 'utf8'));
const byId = Object.fromEntries(data.lists.map((l) => [l.id, l]));
const EXPECTED = {
  'y1-common-exception-words': 45,
  'y2-common-exception-words': 64,
  'y3-4-word-list': 100,
  'y5-6-word-list': 100,
};

test('schema 1 with a complete source block', () => {
  assert.equal(data.schema, 1);
  for (const k of ['title', 'url', 'retrieved', 'licence', 'licence_url', 'attribution']) {
    assert.ok(data.source[k], `source.${k}`);
  }
  assert.match(data.source.url, /^https:\/\/assets\.publishing\.service\.gov\.uk\//);
  assert.match(data.source.licence, /Open Government Licence v3\.0/);
  assert.match(data.source.retrieved, /^\d{4}-\d{2}-\d{2}$/);
});

test('exactly the four lists, with the recorded entry counts', () => {
  assert.deepEqual(Object.keys(byId).sort(), Object.keys(EXPECTED).sort());
  for (const [id, n] of Object.entries(EXPECTED)) assert.equal(byId[id].entries.length, n, id);
});

test('list metadata: id, title, years, statutory flag', () => {
  for (const l of data.lists) {
    assert.ok(l.title && Array.isArray(l.years) && l.years.length > 0, l.id);
    assert.equal(typeof l.statutory, 'boolean', l.id);
  }
  assert.equal(byId['y3-4-word-list'].statutory, true);
  assert.equal(byId['y5-6-word-list'].statutory, true);
});

test('no duplicate official entries, forms are practisable words', () => {
  for (const l of data.lists) {
    const seen = new Set();
    for (const e of l.entries) {
      assert.ok(e.official, `${l.id}: empty official`);
      assert.ok(!seen.has(e.official), `${l.id}: duplicate ${e.official}`);
      seen.add(e.official);
      assert.ok(Array.isArray(e.forms) && e.forms.length > 0, `${l.id}/${e.official}: no forms`);
      for (const f of e.forms) assert.match(f, /^[A-Za-z' -]+$/, `${l.id}/${e.official}: ${f}`);
    }
  }
});

test('forms are unique within a list and derived entries expand as printed', () => {
  for (const l of data.lists) {
    const all = l.entries.flatMap((e) => e.forms);
    assert.equal(new Set(all).size, all.length, `${l.id}: repeated form`);
  }
  const f = (id, off) => byId[id].entries.find((e) => e.official === off).forms;
  assert.deepEqual(f('y3-4-word-list', 'accident(ally)'), ['accident', 'accidentally']);
  assert.deepEqual(f('y3-4-word-list', 'eight/eighth'), ['eight', 'eighth']);
  assert.deepEqual(f('y5-6-word-list', 'equip (–ped, –ment)'), ['equip', 'equipped', 'equipment']);
  assert.ok(byId['y2-common-exception-words'].entries.some((e) => e.official === 'Mr'));
});

test('word lists keep the printed order: alphabetical down the columns (one known quirk in the source)', () => {
  const key = (w) => w.toLowerCase().replace(/\(.*/, '').replace(/[^a-z]/g, '');
  for (const id of ['y3-4-word-list', 'y5-6-word-list']) {
    const k = byId[id].entries.map((e) => key(e.official));
    const bad = k.slice(1).map((w, i) => [k[i], w]).filter(([a, b]) => a > b);
    // GOV.UK itself prints 'increase' before 'important' in the Years 3 and 4 list
    assert.deepEqual(bad, id === 'y3-4-word-list' ? [['increase', 'important']] : [], id);
  }
});
