// #6329: edit (rename) and delete a child in the browser store. PATCH /api/kids/:slug changes name/year and keeps
// the slug (so URLs and history stay valid); DELETE /api/kids/:slug removes the child's weeks, words, recordings,
// sessions and results and nobody else's. Run with `node --test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, memoryBackend, ApiError } from '../static/store.js';

const wav = () => { const b = new Uint8Array(60); b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0); b.set([...'WAVE'].map((c) => c.charCodeAt(0)), 8); return b; };
const mk = async () => {
  const backend = memoryBackend();
  const store = await createStore(backend, { today: '2026-10-21' });
  const r = (m, p, b) => store.request(m, p, b).then((x) => x.data);
  const fail = async (m, p, b) => { try { await store.request(m, p, b); } catch (e) { assert.ok(e instanceof ApiError); return e; } assert.fail('expected ApiError'); };
  await r('POST', '/api/kids', { name: 'Ann', year: 3 });
  await r('POST', '/api/kids', { name: 'Ben', year: 1 });
  const annW = await r('POST', '/api/kids/ann/weeks', { week_start: '2026-10-19', words: ['cat', 'dog'] });
  const benW = await r('POST', '/api/kids/ben/weeks', { week_start: '2026-10-19', words: ['eel'] });
  for (const w of [...annW.words, ...benW.words]) await r('PUT', `/api/words/${w.id}/audio`, wav());
  await r('POST', '/api/kids/ann/sessions', { mode: 'week', settings: {}, results: annW.words.map((w) => ({ word_id: w.id, correct: 1 })) });
  await r('POST', '/api/kids/ben/sessions', { mode: 'week', settings: {}, results: benW.words.map((w) => ({ word_id: w.id, correct: 0 })) });
  return { store, backend, r, fail, annW, benW };
};

test('rename keeps the slug, weeks, words and history; year can change too', async () => {
  const { r } = await mk();
  const k = await r('PATCH', '/api/kids/ann', { name: '  Annie ', year: 4 });
  assert.equal(k.slug, 'ann');
  assert.equal(k.name, 'Annie');
  assert.equal(k.year, 4);
  assert.deepEqual((await r('GET', '/api/kids')).map((x) => x.name), ['Annie', 'Ben']);
  assert.equal((await r('GET', '/api/kids/ann/weeks'))[0].words.length, 2);
  assert.equal((await r('GET', '/api/kids/ann/progress')).stars >= 0, true);
});

test('rename validates: name 1-30 characters, year 0-6, something to change, known child', async () => {
  const { r, fail } = await mk();
  assert.equal((await fail('PATCH', '/api/kids/ann', { name: '   ' })).status, 400);
  assert.equal((await fail('PATCH', '/api/kids/ann', { name: 'x'.repeat(31) })).status, 400);
  assert.equal((await fail('PATCH', '/api/kids/ann', { year: 9 })).status, 400);
  assert.equal((await fail('PATCH', '/api/kids/ann', {})).status, 400);
  assert.equal((await fail('PATCH', '/api/kids/nobody', { name: 'Z' })).status, 404);
  assert.equal((await r('PATCH', '/api/kids/ann', { year: 2 })).name, 'Ann', 'year alone leaves the name');
});

test('delete child removes their weeks, words, recordings, sessions and results, and leaves the sibling alone', async () => {
  const { r, store, backend, annW, benW } = await mk();
  const out = await r('DELETE', '/api/kids/ann');
  assert.deepEqual(out, { ok: true });
  assert.deepEqual((await r('GET', '/api/kids')).map((k) => k.slug), ['ben']);
  for (const w of annW.words) assert.equal(await backend.getAudio(w.id), null, 'ann clip gone');
  assert.ok(await backend.getAudio(benW.words[0].id), 'ben clip kept');
  const { snapshot } = await store.snapshot();
  const text = JSON.stringify(snapshot);
  assert.ok(!text.includes('"cat"') && !text.includes('"dog"') && !text.includes('"ann"'), 'nothing of ann in the snapshot');
  assert.ok(text.includes('"eel"') && text.includes('"ben"'));
  assert.equal(snapshot.sessions.length, 1);
  assert.equal((await r('GET', '/api/kids/ben/weeks'))[0].words.length, 1);
});

test('deleting an unknown child is 404; deleting the last child leaves an empty, working store', async () => {
  const { r, fail } = await mk();
  assert.equal((await fail('DELETE', '/api/kids/nobody')).status, 404);
  await r('DELETE', '/api/kids/ann');
  await r('DELETE', '/api/kids/ben');
  assert.deepEqual(await r('GET', '/api/kids'), []);
  assert.equal((await fail('GET', '/api/me')).status, 404);
  assert.equal((await r('POST', '/api/kids', { name: 'New' })).slug, 'new');
});

test('delete persists: a second store on the same backend does not see the child', async () => {
  const { r, backend } = await mk();
  await r('DELETE', '/api/kids/ben');
  const again = await createStore(backend, { today: '2026-10-21' });
  assert.deepEqual((await again.request('GET', '/api/kids')).data.map((k) => k.slug), ['ann']);
});
