// Tests for static/backup.js: export -> file -> import across two stores (run: node --test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, memoryBackend } from '../static/store.js';
import { exportBackup, previewImport, applyImport } from '../static/backup.js';

const wav = () => { const b = new Uint8Array(60); b.set([82, 73, 70, 70], 0); b.set([87, 65, 86, 69], 8); return b; };
const device = async (clockMs = Date.parse('2026-10-21T10:00:00Z')) => {
  const store = await createStore(memoryBackend(), { clock: () => new Date(clockMs) });
  return { store, r: (m, p, b) => store.request(m, p, b).then((x) => x.data) };
};
// A fake environment whose share sheet captures the file instead of showing UI.
const sharing = () => {
  const got = {};
  return { got, env: { navigator: { canShare: () => true, share: async ({ files }) => { got.file = files[0]; } } } };
};
const fileBytes = async (file) => new Uint8Array(await file.arrayBuffer());

test('export hands a .spellings file to the share sheet and records last_export', async () => {
  const a = await device();
  await a.r('POST', '/api/kids', { name: 'Ann', year: 3 });
  const w = await a.r('POST', '/api/kids/ann/weeks', { week_start: '2026-10-19', words: ['cat', 'dog'] });
  await a.r('PUT', `/api/words/${w.words[0].id}/audio`, wav());
  assert.equal(a.store.getMeta().last_export, null);
  const s = sharing();
  const out = await exportBackup(a.store, { kid: 'ann', env: s.env });
  assert.equal(out.outcome, 'shared');
  assert.equal(out.filename, 'spellings-ann-2026-10-21.spellings');
  assert.equal(s.got.file.name, out.filename);
  assert.equal(a.store.getMeta().last_export, '2026-10-21T10:00:00.000Z');
});

test('a cancelled share does not count as a backup', async () => {
  const a = await device();
  await a.r('POST', '/api/kids', { name: 'Ann' });
  const env = { navigator: { canShare: () => true, share: async () => { const e = new Error('x'); e.name = 'AbortError'; throw e; } } };
  assert.equal((await exportBackup(a.store, { env })).outcome, 'cancelled');
  assert.equal(a.store.getMeta().last_export, null);
});

test('move to a new device: preview writes nothing, apply restores words, audio, history', async () => {
  const a = await device();
  await a.r('POST', '/api/kids', { name: 'Ann', year: 3 });
  const w = await a.r('POST', '/api/kids/ann/weeks', { week_start: '2026-10-19', words: ['cat', 'dog'] });
  await a.r('PUT', `/api/words/${w.words[0].id}/audio`, wav());
  await a.r('POST', '/api/kids/ann/sessions', { mode: 'week', results: [{ word_id: w.words[0].id, correct: 0 }] });
  const s = sharing();
  await exportBackup(a.store, { env: s.env });
  const bytes = await fileBytes(s.got.file);

  const b = await device();
  const preview = await previewImport(b.store, bytes);
  assert.match(preview.text, /1 new weeks, 0 weeks merged, 2 new words, 1 recordings, 1 sessions/);
  assert.deepEqual(await b.r('GET', '/api/kids'), [], 'preview must not write');
  await applyImport(b.store, preview);
  const weeks = await b.r('GET', '/api/kids/ann/weeks');
  assert.deepEqual(weeks[0].words.map((x) => [x.label, x.has_audio]), [['cat', true], ['dog', false]]);
  assert.equal((await b.r('GET', '/api/kids/ann/practice?mode=tricky')).words.length, 1);
  assert.equal((await b.r('GET', `/api/words/${weeks[0].words[0].id}/audio`)).bytes.length, 60);
  assert.equal((await b.r('GET', '/api/me')).kid.year, 3);
});

test('importing the same file twice adds nothing; replace discards what was there', async () => {
  const a = await device();
  await a.r('POST', '/api/kids', { name: 'Ann' });
  await a.r('POST', '/api/kids/ann/weeks', { week_start: '2026-10-19', words: ['cat'] });
  const s = sharing();
  await exportBackup(a.store, { env: s.env });
  const bytes = await fileBytes(s.got.file);
  const b = await device();
  await applyImport(b.store, await previewImport(b.store, bytes));
  const again = await previewImport(b.store, bytes);
  assert.match(again.text, /0 new weeks, 1 weeks merged, 0 new words, 0 recordings, 0 sessions/);
  await b.r('POST', '/api/kids/ann/weeks', { week_start: '2026-10-26', words: ['extra'] });
  const rep = await previewImport(b.store, bytes, 'replace');
  assert.match(rep.text, /2 weeks here will be discarded|Replace everything/);
  await applyImport(b.store, rep);
  assert.equal((await b.r('GET', '/api/kids/ann/weeks')).length, 1);
});

test('hostile or malformed packs are refused before anything is written', async () => {
  const { buildPack } = await import('../static/pack.js');
  const good = () => ({
    kids: [{ slug: 'ann', name: 'Ann', year: 3, settings: { speed: 'slow', repeats: 2, pause: 'long', order: 'mix' } }],
    weeks: [{ kid: 'ann', week_start: '2026-10-19', term: null, words: [{ label: 'cat', position: 1, audio: 'audio/1.wav' }] }],
    sessions: [{ kid: 'ann', created_at: '2026-10-21T10:00:00', mode: 'week', settings: {}, results: [{ week_start: '2026-10-19', label: 'cat', correct: 1 }] }],
  });
  const attempt = async (mutate, audio = { 'audio/1.wav': wav() }) => {
    const snap = good();
    mutate(snap);
    const b = await device();
    await assert.rejects(previewImport(b.store, buildPack(snap, audio)), /cannot be imported/);
    assert.deepEqual(await b.r('GET', '/api/kids'), []);
  };
  // the unmodified pack is accepted, so each failure below is caused by its one mutation
  const ok = await device();
  assert.match((await previewImport(ok.store, buildPack(good(), { 'audio/1.wav': wav() }))).text, /1 new weeks/);
  await attempt((s) => { s.kids[0].slug = '../etc'; });
  await attempt((s) => { s.kids.push({ ...s.kids[0] }); });
  await attempt((s) => { s.kids[0].name = 'x'.repeat(31); });
  await attempt((s) => { s.kids[0].year = 99; });
  await attempt((s) => { s.kids[0].settings = { speed: 'warp' }; });
  await attempt((s) => { s.kids[0].settings = { evil: 1 }; });
  await attempt((s) => { s.weeks[0].kid = 'ghost'; });
  await attempt((s) => { s.weeks[0].week_start = '2026-10-20'; }); // not a Monday
  await attempt((s) => { s.weeks[0].week_start = '2026-13-01'; });
  await attempt((s) => { s.weeks[0].term = 'whenever'; });
  await attempt((s) => { s.weeks.push({ ...s.weeks[0], words: [] }); }); // duplicate week
  await attempt((s) => { s.weeks[0].words[0].label = 'x'.repeat(41); });
  await attempt((s) => { s.weeks[0].words = Array.from({ length: 101 }, (_, i) => ({ label: 'w' + i, position: i + 1, audio: null })); });
  await attempt((s) => { s.sessions[0].kid = 'ghost'; });
  await attempt((s) => { s.sessions[0].mode = 'hack'; });
  await attempt((s) => { s.sessions[0].created_at = 'yesterday'; });
  await attempt((s) => { s.sessions[0].results[0].correct = 5; });
  await attempt(() => {}, { 'audio/1.wav': new Uint8Array(100) }); // not a WAV
  await attempt(() => {}, { 'audio/1.wav': (() => { const b = new Uint8Array(1024 * 1024 + 1); b.set(wav(), 0); return b; })() });
});

test('bad files are refused with a friendly message', async () => {
  const b = await device();
  await assert.rejects(previewImport(b.store, new Uint8Array([1, 2, 3])), (e) => e instanceof Error && e.message.length > 0);
});

// ---- Erase everything on this device (Vikunja #5194): the leaver's path -------------------------------------------
const populate = async (a) => {
  await a.r('POST', '/api/kids', { name: 'Ann', year: 3 });
  const w = await a.r('POST', '/api/kids/ann/weeks', { week_start: '2026-10-19', words: ['cat', 'dog', 'bird'] });
  await a.r('PUT', `/api/words/${w.words[0].id}/audio`, wav());
  await a.r('PUT', `/api/words/${w.words[2].id}/audio`, wav());
  await a.r('POST', '/api/kids/ann/sessions', { mode: 'week', results: [{ word_id: w.words[0].id, correct: 0 }, { word_id: w.words[1].id, correct: 1 }] });
  return w;
};
/** Everything a parent would notice: kids, weeks with words, tricky list, history, and each recording's bytes. */
const everything = async (d) => {
  const weeks = await d.r('GET', '/api/kids/ann/weeks');
  const audio = {};
  for (const w of weeks) for (const x of w.words) if (x.has_audio) audio[x.label] = Array.from((await d.r('GET', `/api/words/${x.id}/audio`)).bytes);
  return {
    kids: await d.r('GET', '/api/kids'),
    words: weeks.map((w) => [w.week_start, w.words.map((x) => [x.label, x.has_audio])]),
    tricky: (await d.r('GET', '/api/kids/ann/practice?mode=tricky')).words.map((x) => x.label),
    progress: await d.r('GET', '/api/kids/ann/progress'),
    history: await d.r('GET', '/api/kids/ann/history'),
    audio,
  };
};

test('eraseAll leaves zero words, recordings, sessions and meta', async () => {
  const backend = memoryBackend();
  const store = await createStore(backend, { clock: () => new Date('2026-10-21T10:00:00Z') });
  const d = { store, r: (m, p, b) => store.request(m, p, b).then((x) => x.data) };
  await populate(d);
  await store.setMeta({ last_export: '2026-10-20T09:00:00.000Z' });
  assert.ok(store.hasData() && Object.keys(backend.persisted().audio).length === 2);
  assert.equal(await store.eraseAll({ confirmed: true }), true);
  assert.equal(store.hasData(), false);
  assert.deepEqual(await d.r('GET', '/api/kids'), []);
  assert.equal(store.getMeta().last_export, null);
  const kept = backend.persisted();
  assert.deepEqual(kept.audio, {}, 'no recording bytes remain');
  assert.deepEqual([kept.state.words, kept.state.weeks, kept.state.sessions, kept.state.results, kept.state.kids], [[], [], [], [], []]);
  assert.equal(kept.state.meta.last_export, null);
});

test('eraseAll without confirmation changes nothing', async () => {
  const backend = memoryBackend();
  const store = await createStore(backend, { clock: () => new Date('2026-10-21T10:00:00Z') });
  const d = { store, r: (m, p, b) => store.request(m, p, b).then((x) => x.data) };
  await populate(d);
  const before = await everything(d);
  const persistedBefore = JSON.stringify(backend.persisted().state);
  for (const arg of [undefined, {}, { confirmed: false }, { confirmed: 'yes' }, true]) assert.equal(await store.eraseAll(arg), false);
  assert.deepEqual(await everything(d), before);
  assert.equal(JSON.stringify(backend.persisted().state), persistedBefore);
});

test('export, erase, import the file back: words, progress, history and audio bytes equal the originals', async () => {
  const a = await device();
  await populate(a);
  const original = await everything(a);
  assert.deepEqual(Object.keys(original.audio).sort(), ['bird', 'cat']);
  const s = sharing();
  await exportBackup(a.store, { env: s.env });
  const bytes = await fileBytes(s.got.file);

  assert.equal(await a.store.eraseAll({ confirmed: true }), true);
  assert.deepEqual(await a.r('GET', '/api/kids'), []);

  await applyImport(a.store, await previewImport(a.store, bytes));
  assert.deepEqual(await everything(a), original);
});
