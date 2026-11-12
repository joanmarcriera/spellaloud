// Tests for static/store.js: the local API must behave like server.py (run: node --test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, memoryBackend, ApiError, mondayOf, termOf, academicYear } from '../static/store.js';

const wav = () => { const b = new Uint8Array(60); b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0); b.set([...'WAVE'].map((c) => c.charCodeAt(0)), 8); return b; };
const mk = async (today = '2026-10-21', backend = memoryBackend()) => {
  const store = await createStore(backend, { today });
  const r = (m, p, b) => store.request(m, p, b).then((x) => x.data);
  const fail = async (m, p, b) => { try { await store.request(m, p, b); } catch (e) { assert.ok(e instanceof ApiError); return e; } assert.fail('expected ApiError'); };
  return { store, r, fail, backend };
};
const withKid = async (today) => { const t = await mk(today); await t.r('POST', '/api/kids', { name: 'Ann', year: 3 }); return t; };

test('date helpers match server.py', () => {
  assert.equal(mondayOf('2026-10-21'), '2026-10-19');
  assert.equal(mondayOf('2026-10-18'), '2026-10-12');
  assert.equal(termOf('2026-09-01'), '2026 Autumn');
  assert.equal(termOf('2026-01-10'), '2026 Spring');
  assert.equal(termOf('2026-04-01'), '2026 Summer');
  assert.equal(academicYear('2025 Autumn'), '2025-26');
  assert.equal(academicYear('2026 Summer'), '2025-26');
});

test('no kids yet: /api/me 404; adding a child gives a slug and default settings', async () => {
  const { r, fail } = await mk();
  assert.equal((await fail('GET', '/api/me')).status, 404);
  const k = await r('POST', '/api/kids', { name: 'Ann Marie', year: 3 });
  assert.equal(k.slug, 'ann-marie');
  assert.deepEqual(k.settings, { speed: 'normal', repeats: 2, pause: 'short', order: 'mix' });
  assert.equal((await r('POST', '/api/kids', { name: 'Ann Marie' })).slug, 'ann-marie-2');
  const me = await r('GET', '/api/me');
  assert.equal(me.kid.slug, 'ann-marie');
  assert.equal(me.today, '2026-10-21');
  assert.equal((await r('GET', '/api/me?kid=ann-marie-2')).kid.slug, 'ann-marie-2');
  assert.equal((await fail('POST', '/api/kids', { name: '  ' })).status, 400);
  assert.equal((await fail('POST', '/api/kids', { name: 'X', year: 9 })).status, 400);
});

test('weeks: create snaps to Monday, validates, 409 on duplicate, delete cascades', async () => {
  const { r, fail } = await withKid();
  const w = await r('POST', '/api/kids/ann/weeks', { week_start: '2026-10-21', words: ['cat', ' dog '] });
  assert.equal(w.week_start, '2026-10-19');
  assert.deepEqual(w.words.map((x) => [x.position, x.label]), [[1, 'cat'], [2, 'dog']]);
  assert.equal(w.term, '2026 Autumn'); assert.equal(w.term_auto, true);
  assert.deepEqual(w.term_options, ['2026 Spring', '2026 Summer', '2027 Spring', '2027 Summer']);
  assert.equal((await fail('POST', '/api/kids/ann/weeks', { week_start: '2026-10-20', words: ['x'] })).status, 409);
  assert.equal((await fail('POST', '/api/kids/ann/weeks', { week_start: 'nope', words: [] })).status, 400);
  assert.equal((await fail('POST', '/api/kids/ann/weeks', { week_start: '2026-02-30', words: [] })).status, 400);
  assert.equal((await fail('POST', '/api/kids/ann/weeks', { week_start: '2026-11-02', words: ['a'.repeat(41)] })).status, 400);
  assert.equal((await fail('POST', '/api/kids/nobody/weeks', { week_start: '2026-11-02', words: [] })).status, 404);
  await r('DELETE', `/api/weeks/${w.id}`);
  assert.deepEqual(await r('GET', '/api/kids/ann/weeks'), []);
  assert.equal((await fail('DELETE', `/api/weeks/${w.id}`)).status, 404);
});

test('words: add, patch, delete; term patch', async () => {
  const { r, fail } = await withKid();
  const w = await r('POST', '/api/kids/ann/weeks', { week_start: '2026-10-19', words: ['cat'] });
  const add = await r('POST', `/api/weeks/${w.id}/words`, { label: 'bird' });
  assert.equal(add.position, 2);
  assert.equal((await r('PATCH', `/api/words/${add.id}`, { label: 'bard' })).label, 'bard');
  assert.equal((await r('PATCH', `/api/weeks/${w.id}`, { term: '2026 Summer' })).term, '2026 Summer');
  assert.equal((await r('PATCH', `/api/weeks/${w.id}`, { term: null })).term_auto, true);
  assert.equal((await fail('PATCH', `/api/weeks/${w.id}`, { term: 'bad' })).status, 400);
  assert.equal((await fail('PATCH', `/api/weeks/${w.id}`, {})).status, 400);
  await r('DELETE', `/api/words/${add.id}`);
  assert.equal((await r('GET', '/api/kids/ann/weeks'))[0].words.length, 1);
  assert.equal((await fail('PATCH', '/api/words/9999', { label: 'x' })).status, 404);
});

test('audio: validates WAV, tts never replaces a child clip, practice lists only recorded words', async () => {
  const { r, fail } = await withKid();
  const w = await r('POST', '/api/kids/ann/weeks', { week_start: '2026-10-19', words: ['cat', 'dog'] });
  const [cat, dog] = w.words;
  assert.equal((await fail('PUT', `/api/words/${cat.id}/audio`, new Uint8Array(50))).status, 400);
  assert.equal((await fail('PUT', `/api/words/${cat.id}/audio?source=x`, wav())).status, 400);
  assert.equal((await fail('PUT', `/api/words/${cat.id}/audio`, new Uint8Array(1024 * 1024 + 1))).status, 413);
  assert.equal((await fail('GET', `/api/words/${cat.id}/audio`)).status, 404);
  assert.deepEqual(await r('PUT', `/api/words/${cat.id}/audio`, wav()), { ok: true, bytes: 60, audio_source: 'child' });
  assert.equal((await fail('PUT', `/api/words/${cat.id}/audio?source=tts`, wav())).status, 409);
  await r('PUT', `/api/words/${dog.id}/audio?source=tts`, wav());
  await r('PUT', `/api/words/${dog.id}/audio`, wav()); // a child clip replaces a tts one
  const got = await r('GET', `/api/words/${cat.id}/audio`);
  assert.equal(got.type, 'audio/wav'); assert.equal(got.bytes.length, 60);
  const p = await r('GET', '/api/kids/ann/practice?mode=week');
  assert.equal(p.words.length, 2);
  const w2 = await r('POST', `/api/weeks/${w.id}/words`, { label: 'silent' });
  assert.equal(w2.has_audio, false);
  assert.equal((await r('GET', '/api/kids/ann/practice?mode=week')).skipped, 1);
});

test('sessions, tricky rule, known, progress, history, report', async () => {
  const { r, fail } = await withKid();
  const w = await r('POST', '/api/kids/ann/weeks', { week_start: '2026-10-19', words: ['cat', 'dog'] });
  const [cat, dog] = w.words;
  for (const x of w.words) await r('PUT', `/api/words/${x.id}/audio`, wav());
  const sess = (a, b) => r('POST', '/api/kids/ann/sessions', { mode: 'week', settings: { speed: 'slow' }, results: [{ word_id: cat.id, correct: a }, { word_id: dog.id, correct: b }] });
  const s1 = await sess(0, 1);
  assert.deepEqual(s1, { score: 1, total: 2, stars: 2, streak: 1 });
  let tricky = await r('GET', '/api/kids/ann/practice?mode=tricky');
  assert.deepEqual(tricky.words.map((x) => x.label), ['cat']);
  await sess(1, 1); // one right after the miss: window is 2, so the miss still counts
  assert.equal((await r('GET', '/api/kids/ann/practice?mode=tricky')).words.length, 1);
  await sess(1, 1); // two right in a row: cleared
  assert.equal((await r('GET', '/api/kids/ann/practice?mode=tricky')).words.length, 0);
  await sess(0, 1);
  await r('POST', `/api/words/${cat.id}/known`);
  assert.equal((await r('GET', '/api/kids/ann/practice?mode=tricky')).words.length, 0);
  await sess(0, 1);
  assert.equal((await r('GET', '/api/kids/ann/practice?mode=tricky')).words.length, 1);

  const prog = await r('GET', '/api/kids/ann/progress');
  assert.equal(prog.sessions.length, 5); assert.equal(prog.streak, 1);
  assert.equal(prog.stars, 2 + 3 + 3 + 2 + 2);
  const hist = await r('GET', '/api/kids/ann/history');
  assert.equal(hist.current, w.id);
  assert.equal(hist.weeks[0].sessions, 5);
  assert.deepEqual(hist.weeks[0].words[0].history, [0, 1, 1, 0, 0]);
  assert.equal(hist.weeks[0].words[0].status, 'failing');
  assert.equal(hist.weeks[0].words[1].status, 'solid');
  assert.equal(hist.weeks[0].tricky, 1);
  const rep = await r('GET', '/api/report');
  assert.deepEqual(rep.ann.most_missed, [{ label: 'cat', missed: 3, tried: 5 }]);
  assert.equal(rep.ann.weeks[0].total, 10);
  assert.equal(rep.ann.recent.length, 5);

  assert.equal((await fail('POST', '/api/kids/ann/sessions', { mode: 'x', results: [] })).status, 400);
  assert.equal((await fail('POST', '/api/kids/ann/sessions', { mode: 'week', results: [{ word_id: cat.id, correct: 2 }] })).status, 400);
  assert.equal((await fail('POST', '/api/kids/ann/sessions', { mode: 'week', results: [{ word_id: cat.id, correct: 1 }, { word_id: cat.id, correct: 1 }] })).status, 400);
  assert.equal((await fail('POST', '/api/kids/ann/sessions', { mode: 'week', results: [{ word_id: 999, correct: 1 }] })).status, 400);
});

test('a word of another child is refused; terms and whole-year scopes', async () => {
  const { r, fail } = await withKid('2026-02-10');
  await r('POST', '/api/kids', { name: 'Bo' });
  const a = await r('POST', '/api/kids/ann/weeks', { week_start: '2025-10-06', words: ['one'] });
  const b = await r('POST', '/api/kids/ann/weeks', { week_start: '2026-02-09', words: ['two'] });
  const c = await r('POST', '/api/kids/bo/weeks', { week_start: '2026-02-09', words: ['three'] });
  for (const x of [a, b, c]) await r('PUT', `/api/words/${x.words[0].id}/audio`, wav());
  assert.equal((await fail('POST', '/api/kids/ann/sessions', { mode: 'week', results: [{ word_id: c.words[0].id, correct: 1 }] })).status, 400);
  const terms = await r('GET', '/api/kids/ann/terms');
  assert.equal(terms.current, '2026 Spring');
  assert.deepEqual(terms.terms.map((t) => t.key), ['2026 Spring', '2025 Autumn']);
  assert.deepEqual(terms.years, [{ key: '2025-26', label: '2025-26 (whole year)' }]);
  assert.deepEqual((await r('GET', '/api/kids/ann/practice?mode=term')).words.map((x) => x.label), ['two']);
  assert.deepEqual((await r('GET', '/api/kids/ann/practice?mode=term&term=2025-26')).words.map((x) => x.label), ['one', 'two']);
  assert.equal((await fail('GET', '/api/kids/ann/practice?mode=week&term=2025-26')).status, 400);
  assert.equal((await fail('GET', '/api/kids/ann/practice?mode=term&term=junk')).status, 400);
  assert.equal((await fail('GET', `/api/kids/ann/practice?week=${c.id}`)).status, 404);
  assert.equal((await r('GET', `/api/kids/ann/practice?week=${a.id}`)).words.length, 1);
});

test('settings validation and persistence across a reload', async () => {
  const { r, fail, backend } = await withKid();
  assert.equal((await fail('PUT', '/api/kids/ann/settings', { speed: 'x', repeats: 1, pause: 'short', order: 'mix' })).status, 400);
  assert.equal((await fail('PUT', '/api/kids/ann/settings', { speed: 'slow', repeats: true, pause: 'short', order: 'mix' })).status, 400);
  await r('PUT', '/api/kids/ann/settings', { speed: 'slow', repeats: 3, pause: 'long', order: 'inorder' });
  const w = await r('POST', '/api/kids/ann/weeks', { week_start: '2026-10-19', words: ['cat'] });
  await r('PUT', `/api/words/${w.words[0].id}/audio`, wav());
  const again = await createStore(memoryBackend(backend.persisted()), { today: '2026-10-21' });
  const me = (await again.request('GET', '/api/me')).data;
  assert.deepEqual(me.kid.settings, { speed: 'slow', repeats: 3, pause: 'long', order: 'inorder' });
  const wk = (await again.request('GET', '/api/kids/ann/weeks')).data;
  assert.equal(wk[0].words[0].has_audio, true);
  assert.equal((await again.request('GET', `/api/words/${w.words[0].id}/audio`)).data.bytes.length, 60);
});

test('unknown routes 404, concurrent writes do not lose updates', async () => {
  const { r, fail } = await withKid();
  assert.equal((await fail('GET', '/api/nope')).status, 404);
  assert.equal((await fail('GET', '/api/words/1x/audio')).status, 404);
  const w = await r('POST', '/api/kids/ann/weeks', { week_start: '2026-10-19', words: ['cat'] });
  await Promise.all([1, 2, 3, 4, 5].map((i) => r('POST', `/api/weeks/${w.id}/words`, { label: 'w' + i })));
  const words = (await r('GET', '/api/kids/ann/weeks'))[0].words;
  assert.deepEqual(words.map((x) => x.position), [1, 2, 3, 4, 5, 6]);
});

test('two stores on one backend (two tabs) keep both words with distinct ids', async () => {
  // A backend whose load/save each yield a macrotask, so two tabs' requests interleave the way IndexedDB lets them.
  const base = memoryBackend();
  const tick = () => new Promise((res) => setTimeout(res, 5));
  const slow = { ...base, async load() { const x = await base.load(); await tick(); return x; }, async saveState(s) { await tick(); return base.saveState(s); } };
  const a = await createStore(slow, { today: '2026-10-21' });
  const b = await createStore(slow, { today: '2026-10-21' });
  await a.request('POST', '/api/kids', { name: 'Ann', year: 3 });
  const w = (await a.request('POST', '/api/kids/ann/weeks', { week_start: '2026-10-19', words: ['cat'] })).data;
  await Promise.all([a.request('POST', `/api/weeks/${w.id}/words`, { label: 'dog' }), b.request('POST', `/api/weeks/${w.id}/words`, { label: 'fish' })]);
  const words = (await a.request('GET', '/api/kids/ann/weeks')).data[0].words;
  assert.deepEqual(words.map((x) => x.label).sort(), ['cat', 'dog', 'fish']);
  assert.equal(new Set(words.map((x) => x.id)).size, 3);
});

test('snapshot -> replaceFromSnapshot round trip keeps words, audio, results', async () => {
  const { r, store } = await withKid();
  const w = await r('POST', '/api/kids/ann/weeks', { week_start: '2026-10-19', words: ['cat', 'dog'] });
  await r('PUT', `/api/words/${w.words[0].id}/audio`, wav());
  await r('POST', '/api/kids/ann/sessions', { mode: 'week', results: [{ word_id: w.words[0].id, correct: 0 }] });
  const { snapshot, audio } = await store.snapshot();
  assert.deepEqual(Object.keys(audio), [`audio/${w.words[0].id}.wav`]);
  const other = await mk('2026-10-21');
  await other.store.replaceFromSnapshot(snapshot, audio);
  const weeks = await other.r('GET', '/api/kids/ann/weeks');
  assert.deepEqual(weeks[0].words.map((x) => [x.label, x.has_audio]), [['cat', true], ['dog', false]]);
  assert.equal((await other.r('GET', '/api/kids/ann/practice?mode=tricky')).words.length, 1);
  assert.equal((await other.r('GET', `/api/words/${weeks[0].words[0].id}/audio`)).bytes.length, 60);
});

test('the "I know it" marker survives export and import', async () => {
  const { r, store } = await withKid();
  const w = await r('POST', '/api/kids/ann/weeks', { week_start: '2026-10-19', words: ['cat', 'dog'] });
  for (const x of w.words) await r('PUT', `/api/words/${x.id}/audio`, wav());
  const miss = [{ word_id: w.words[0].id, correct: 0 }, { word_id: w.words[1].id, correct: 0 }];
  await r('POST', '/api/kids/ann/sessions', { mode: 'week', results: miss });
  await r('POST', `/api/words/${w.words[0].id}/known`);
  assert.equal((await r('GET', '/api/kids/ann/practice?mode=tricky')).words.length, 1, 'cat cleared before export');
  const { snapshot, audio } = await store.snapshot();
  assert.ok(snapshot.weeks[0].words[0].cleared_at, 'cat carries the marker');
  assert.equal(snapshot.weeks[0].words[1].cleared_at, undefined, 'dog does not');
  const other = await mk('2026-10-21');
  await other.store.replaceFromSnapshot(snapshot, audio);
  const tricky = await other.r('GET', '/api/kids/ann/practice?mode=tricky');
  assert.deepEqual(tricky.words.map((x) => x.label), ['dog'], 'cat stays cleared after import');
});

test('replaceFromSnapshot issues session ids in time order whatever the snapshot order (#4526)', async () => {
  const { store } = await mk('2026-10-21');
  const s = (t) => ({ kid: 'ann', created_at: t, mode: 'week', settings: {}, results: [] });
  await store.replaceFromSnapshot({ kids: [{ slug: 'ann', name: 'Ann', year: 2, settings: {} }], weeks: [],
    sessions: [s('2026-10-20T08:00:00'), s('2026-10-10T08:00:00')] }, {});
  const { snapshot } = await store.snapshot();
  assert.deepEqual(snapshot.sessions.map((x) => x.created_at), ['2026-10-10T08:00:00', '2026-10-20T08:00:00']);
});

test('BUG-7: a week holds at most 100 words, so every week the app can make is one a backup can restore', async () => {
  const { r, fail, store } = await withKid();
  const w = await r('POST', '/api/kids/ann/weeks', { week_start: '2026-10-19', words: Array.from({ length: 99 }, (_, i) => `w${i}`) });
  assert.equal((await r('POST', `/api/weeks/${w.id}/words`, { label: 'w99' })).label, 'w99', 'the 100th word is allowed');
  const e = await fail('POST', `/api/weeks/${w.id}/words`, { label: 'w100' });
  assert.equal(e.status, 400, 'the 101st word is refused');
  assert.equal((await r('GET', '/api/kids/ann/weeks'))[0].words.length, 100, 'the refused word was not stored');
  const { snapshot, audio } = await store.snapshot();
  const { validateSnapshot } = await import('../static/backup.js');
  assert.doesNotThrow(() => validateSnapshot(snapshot, audio), 'a full week exports to a file that validates');
});

test('two stores on one backend (two tabs): concurrent writes from both do not lose updates (TST-1)', async () => {
  const backend = memoryBackend();
  const a = await mk('2026-10-21', backend);
  await a.r('POST', '/api/kids', { name: 'Ann', year: 3 });
  const b = await mk('2026-10-21', backend); // second tab opens the same storage
  const w = await a.r('POST', '/api/kids/ann/weeks', { week_start: '2026-10-19', words: ['cat'] });
  const adds = [];
  for (let i = 1; i <= 4; i++) {
    adds.push(a.r('POST', `/api/weeks/${w.id}/words`, { label: 'a' + i }));
    adds.push(b.r('POST', `/api/weeks/${w.id}/words`, { label: 'b' + i }));
  }
  await Promise.all(adds);
  const fresh = await mk('2026-10-21', backend);
  const words = (await fresh.r('GET', '/api/kids/ann/weeks'))[0].words;
  assert.equal(words.length, 9, 'every word from both tabs survives');
  assert.deepEqual(words.map((x) => x.position), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(new Set(words.map((x) => x.id)).size, 9, 'ids are unique');
});
