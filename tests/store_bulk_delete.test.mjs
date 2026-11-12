// #6328: delete many words at once. POST /api/words/delete { ids } in the browser store removes the words, their
// recordings (audio store) and their results in one save; unknown or malformed ids change nothing. Run with `node --test`.
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
  const w1 = await r('POST', '/api/kids/ann/weeks', { week_start: '2026-10-19', words: ['cat', 'dog', 'eel', 'fox'] });
  const w2 = await r('POST', '/api/kids/ann/weeks', { week_start: '2026-10-26', words: ['gnu', 'hen'] });
  return { store, backend, r, fail, w1, w2 };
};

test('bulk delete removes the chosen words and their audio clips, keeps the rest', async () => {
  const { r, backend, w1 } = await mk();
  const [cat, dog, eel, fox] = w1.words;
  for (const w of w1.words) await r('PUT', `/api/words/${w.id}/audio`, wav());
  const out = await r('POST', '/api/words/delete', { ids: [cat.id, eel.id] });
  assert.deepEqual(out, { ok: true, deleted: 2 });
  const left = (await r('GET', '/api/kids/ann/weeks')).find((w) => w.id === w1.id).words;
  assert.deepEqual(left.map((w) => w.label), ['dog', 'fox']);
  assert.equal(await backend.getAudio(cat.id), null, 'cat clip gone');
  assert.equal(await backend.getAudio(eel.id), null, 'eel clip gone');
  assert.ok(await backend.getAudio(dog.id), 'dog clip kept');
  assert.ok(await backend.getAudio(fox.id), 'fox clip kept');
});

test('bulk delete works across weeks and drops the words\' results', async () => {
  const { r, store, w1, w2 } = await mk();
  const [cat] = w1.words, [gnu, hen] = w2.words;
  await r('POST', '/api/kids/ann/sessions', { mode: 'week', settings: {}, results: [{ word_id: cat.id, correct: 0 }, { word_id: gnu.id, correct: 1 }, { word_id: hen.id, correct: 1 }] });
  assert.equal((await r('POST', '/api/words/delete', { ids: [cat.id, gnu.id] })).deleted, 2);
  const { snapshot } = await store.snapshot();
  const all = JSON.stringify(snapshot);
  assert.ok(!all.includes('"cat"') && !all.includes('"gnu"'), 'both words gone from the snapshot');
  assert.ok(all.includes('"hen"'));
});

test('bulk delete is all-or-nothing: one unknown id changes nothing', async () => {
  const { r, fail, w1 } = await mk();
  const e = await fail('POST', '/api/words/delete', { ids: [w1.words[0].id, 999999] });
  assert.equal(e.status, 404);
  assert.equal((await r('GET', '/api/kids/ann/weeks')).find((w) => w.id === w1.id).words.length, 4);
});

test('bulk delete validates the body: a non-empty list of whole numbers, no duplicates counted twice', async () => {
  const { r, fail, w1 } = await mk();
  for (const body of [{}, { ids: [] }, { ids: 'x' }, { ids: [1.5] }, { ids: ['1'] }, { ids: [-1] }]) {
    assert.equal((await fail('POST', '/api/words/delete', body)).status, 400, JSON.stringify(body));
  }
  const id = w1.words[0].id;
  assert.equal((await r('POST', '/api/words/delete', { ids: [id, id] })).deleted, 1);
});

test('bulk delete persists: a second store on the same backend sees the deletion', async () => {
  const { r, backend, w1 } = await mk();
  await r('POST', '/api/words/delete', { ids: w1.words.map((w) => w.id) });
  const again = await createStore(backend, { today: '2026-10-21' });
  const weeks = (await again.request('GET', '/api/kids/ann/weeks')).data;
  assert.equal(weeks.find((w) => w.id === w1.id).words.length, 0);
});
