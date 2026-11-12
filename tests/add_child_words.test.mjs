// addChildWithWords: a further child can load words when added, and a failed words call must not lose or
// duplicate the child (Vikunja #6335, #6577). `node --test tests/`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addChildWithWords } from '../static/lib.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

/** A recording fake of the parent page's api(method, path, body). `failWeeks` makes the weeks call reject. */
function fakeApi({ failWeeks = null, failKid = null } = {}) {
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === '/api/kids') { if (failKid) throw new Error(failKid); return { slug: 'ann', name: body.name }; }
    if (failWeeks) throw new Error(failWeeks);
    return { id: 1 };
  };
  return { api, calls };
}

test('child with words: one kid POST, then the week POST for that slug with the typed words', async () => {
  const { api, calls } = fakeApi();
  const r = await addChildWithWords(api, { name: 'Ann', year: '3', words: ['cat', 'dog'], weekStart: '2026-11-02' });
  assert.equal(r.weekError, null);
  assert.deepEqual(calls.map((c) => c.path), ['/api/kids', '/api/kids/ann/weeks']);
  assert.deepEqual(calls[0].body, { name: 'Ann', year: 3 }); // select value "3" becomes the number 3
  assert.deepEqual(calls[1].body, { week_start: '2026-11-02', words: ['cat', 'dog'] });
});

test('child without words: no weeks call', async () => {
  const { api, calls } = fakeApi();
  const r = await addChildWithWords(api, { name: 'Ann', year: 0, words: [], weekStart: '2026-11-02' });
  assert.equal(r.weekError, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.year, 0); // Reception stays 0, not NaN or 1
});

test('words rejected after the child exists: resolves with weekError so the page refreshes, never a second kid POST', async () => {
  const { api, calls } = fakeApi({ failWeeks: 'words must be a list of at most 100 labels' });
  const r = await addChildWithWords(api, { name: 'Ann', year: 1, words: ['x'], weekStart: '2026-11-02' });
  assert.equal(r.kid.slug, 'ann');
  assert.match(r.weekError, /at most 100/);
  assert.equal(calls.filter((c) => c.path === '/api/kids').length, 1);
});

test('child creation failing still throws (the panel keeps its text and shows the message)', async () => {
  const { api, calls } = fakeApi({ failKid: 'a child needs a name' });
  await assert.rejects(addChildWithWords(api, { name: '', year: 1, words: ['x'], weekStart: '2026-11-02' }), /needs a name/);
  assert.equal(calls.length, 1);
});

test('the panel uses the helper, guards double taps and tells the parent when only the words failed', () => {
  const src = read('../static/parent.js');
  const panel = src.slice(src.indexOf('function addChildPanel'), src.indexOf('First-run setup'));
  assert.match(panel, /addChildWithWords\(api,/);
  assert.match(panel, /btn\.disabled = true/);
  assert.match(panel, /childExists\(res\.weekError/);
  const setup = src.slice(src.indexOf('function setupPanel'), src.indexOf('"Erase everything on this device"'));
  assert.ok(setup.length > 200 && setup.includes('addChildWithWords(api,'), 'setup panel shares the helper');
  const helper = src.slice(src.indexOf('async function childExists'), src.indexOf('/** Put the example words'));
  assert.ok(helper.length > 100 && /catch \(e\)[^]*Reload this page/.test(helper), 'a failed refresh is reported, not retried');
  assert.doesNotMatch(panel, /api\('POST', '\/api\/kids',/); // no second, unguarded create path
});
