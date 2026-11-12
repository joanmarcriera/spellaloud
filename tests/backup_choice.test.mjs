// Choose-what-to-back-up (2026-11-12): pack.js selectSnapshot / retargetSnapshot / BACKUP_PRESETS, and the
// export -> import round trip through backup.js with a choice and an import target. Run: node --test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, memoryBackend } from '../static/store.js';
import { exportBackup, previewImport, applyImport } from '../static/backup.js';
import { selectSnapshot, retargetSnapshot, BACKUP_PRESETS, describeContents, parsePack } from '../static/pack.js';

const wav = () => { const b = new Uint8Array(60); b.set([82, 73, 70, 70], 0); b.set([87, 65, 86, 69], 8); return b; };
const device = async () => {
  const store = await createStore(memoryBackend(), { clock: () => new Date('2026-11-12T10:00:00Z') });
  return { store, r: (m, p, b) => store.request(m, p, b).then((x) => x.data) };
};
const capture = () => { const got = {}; return { got, env: { navigator: { canShare: () => true, share: async ({ files }) => { got.file = files[0]; } } } }; };
const bytesOf = async (f) => new Uint8Array(await f.arrayBuffer());

const SNAP = () => ({
  kids: [{ slug: 'ava', name: 'Ava', year: 2, settings: { speed: 'slow', voice: 'Daniel' } }, { slug: 'sam', name: 'Sam', year: 4, settings: {} }],
  weeks: [
    { kid: 'ava', week_start: '2026-11-09', term: null, words: [{ label: 'cat', position: 1, audio: 'audio/1.wav', cleared_at: '2026-11-10T08:00:00' }, { label: 'dog', position: 2, audio: null }] },
    { kid: 'sam', week_start: '2026-11-09', term: null, words: [{ label: 'because', position: 1, audio: 'audio/2.wav' }] },
  ],
  sessions: [{ kid: 'ava', created_at: '2026-11-10T08:00:00', mode: 'week', settings: {}, results: [{ week_start: '2026-11-09', label: 'cat', correct: 1 }] }],
});
const AUDIO = () => ({ 'audio/1.wav': wav(), 'audio/2.wav': wav() });

test('presets: "everything" keeps it all, "share" keeps words only', () => {
  assert.deepEqual(BACKUP_PRESETS.everything, { recordings: true, results: true, settings: true, names: true });
  assert.deepEqual(BACKUP_PRESETS.share, { recordings: false, results: false, settings: false, names: false });
});

test('everything: the snapshot and recordings are unchanged', () => {
  const { snapshot, audio } = selectSnapshot(SNAP(), AUDIO(), { kids: null, ...BACKUP_PRESETS.everything });
  assert.deepEqual(snapshot, SNAP());
  assert.deepEqual(Object.keys(audio).sort(), ['audio/1.wav', 'audio/2.wav']);
});

test('share preset: words only, no recordings, scores, "I know it" marks, settings or names', () => {
  const { snapshot, audio } = selectSnapshot(SNAP(), AUDIO(), { kids: ['ava'], ...BACKUP_PRESETS.share });
  assert.deepEqual(snapshot.kids, [{ slug: 'child-1', name: 'Child 1', year: 2, settings: {} }]);
  assert.deepEqual(snapshot.weeks, [{ kid: 'child-1', week_start: '2026-11-09', term: null, words: [{ label: 'cat', position: 1, audio: null }, { label: 'dog', position: 2, audio: null }] }]);
  assert.deepEqual(snapshot.sessions, []);
  assert.deepEqual(audio, {});
  assert.doesNotMatch(JSON.stringify(snapshot), /Ava|ava|Daniel/);
});

test('mixed choice: recordings kept, scores dropped; only the chosen children', () => {
  const { snapshot, audio } = selectSnapshot(SNAP(), AUDIO(), { kids: ['sam'], recordings: true, results: false, settings: true, names: true });
  assert.deepEqual(snapshot.kids.map((k) => k.slug), ['sam']);
  assert.equal(snapshot.weeks.length, 1);
  assert.equal(snapshot.weeks[0].words[0].audio, 'audio/2.wav');
  assert.deepEqual(Object.keys(audio), ['audio/2.wav']);
  assert.deepEqual(snapshot.sessions, []);
});

test('no child chosen is refused with a clear message', () => {
  assert.throws(() => selectSnapshot(SNAP(), AUDIO(), { kids: [], ...BACKUP_PRESETS.everything }), /Choose at least one child/);
});

test('retarget: a one-child file goes under an existing child; a family file cannot', () => {
  const one = selectSnapshot(SNAP(), AUDIO(), { kids: ['ava'], ...BACKUP_PRESETS.everything }).snapshot;
  const r = retargetSnapshot(one, 'mia');
  assert.deepEqual(r.kids, []);
  assert.ok(r.weeks.every((w) => w.kid === 'mia'));
  assert.ok(r.sessions.every((s) => s.kid === 'mia'));
  assert.throws(() => retargetSnapshot(SNAP(), 'mia'), /holds 2 children/);
});

test('describeContents says in words what a file holds', () => {
  assert.equal(describeContents(BACKUP_PRESETS.share), 'words only');
  assert.equal(describeContents(BACKUP_PRESETS.everything), 'words, recordings, scores and stars, settings, names');
  assert.equal(describeContents(undefined), 'everything (older file)');
});

test('round trip: parent A shares words only; parent B adds them to their own child', async () => {
  const a = await device();
  await a.r('POST', '/api/kids', { name: 'Ava', year: 2 });
  const w = await a.r('POST', '/api/kids/ava/weeks', { week_start: '2026-11-09', words: ['cat', 'dog'] });
  await a.r('PUT', `/api/words/${w.words[0].id}/audio`, wav());
  const s = capture();
  const out = await exportBackup(a.store, { kids: ['ava'], choice: BACKUP_PRESETS.share, env: s.env });
  assert.equal(out.filename, 'spellings-words-2026-11-12.spellings'); // no child's name in the file name either
  const bytes = await bytesOf(s.got.file);
  const parsed = parsePack(bytes);
  assert.deepEqual(parsed.contents, BACKUP_PRESETS.share);
  assert.deepEqual(parsed.audio, {});

  const b = await device();
  await b.r('POST', '/api/kids', { name: 'Mia', year: 2 });
  const preview = await previewImport(b.store, bytes, 'merge', { target: 'mia' });
  assert.match(preview.text, /words only/);
  await applyImport(b.store, preview);
  const kids = await b.r('GET', '/api/kids');
  assert.deepEqual(kids.map((k) => k.slug), ['mia']); // no "Child 1" twin
  const weeks = await b.r('GET', '/api/kids/mia/weeks');
  assert.deepEqual(weeks[0].words.map((x) => x.label), ['cat', 'dog']);
});

test('round trip: everything for myself keeps recordings and scores; replace cannot be combined with a target', async () => {
  const a = await device();
  await a.r('POST', '/api/kids', { name: 'Ava', year: 2 });
  const w = await a.r('POST', '/api/kids/ava/weeks', { week_start: '2026-11-09', words: ['cat'] });
  await a.r('PUT', `/api/words/${w.words[0].id}/audio`, wav());
  const s = capture();
  const out = await exportBackup(a.store, { kids: null, choice: BACKUP_PRESETS.everything, env: s.env });
  assert.equal(out.filename, 'spellings-family-2026-11-12.spellings');
  const bytes = await bytesOf(s.got.file);
  assert.equal(Object.keys(parsePack(bytes).audio).length, 1);
  const b = await device();
  await b.r('POST', '/api/kids', { name: 'Mia' });
  await assert.rejects(previewImport(b.store, bytes, 'replace', { target: 'mia' }), /Replace everything/);
});

test('the old call shape still works (Delete child "Export first", Erase "Export everyone first")', async () => {
  const a = await device();
  await a.r('POST', '/api/kids', { name: 'Ava' });
  const s = capture();
  const out = await exportBackup(a.store, { kid: 'ava', env: s.env });
  assert.equal(out.filename, 'spellings-ava-2026-11-12.spellings');
});

test('parent page offers the chooser (who, what, two presets) and an import target', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../static/parent.js', import.meta.url), 'utf8');
  assert.match(src, /function backupChooser\(store, kids, msg\)/);
  assert.match(src, /'Everything, for me'/);
  assert.match(src, /'To share with another parent'/);
  assert.match(src, /exportBackup\(store, \{ kids: chosen\.length === kids\.length \? null : chosen, choice: choice\(\) \}\)/);
  assert.match(src, /previewImport\(store, new Uint8Array\(await f\.arrayBuffer\(\)\), modeSel\.value, \{ target: target\.value \|\| null \}\)/);
  const tour = readFileSync(new URL('../static/tour.js', import.meta.url), 'utf8');
  assert.match(tour, /To share with another parent/);
});

test('review: a backup of only some children does not silence the backup reminder', async () => {
  const a = await device();
  await a.r('POST', '/api/kids', { name: 'Ava' });
  await a.r('POST', '/api/kids', { name: 'Sam' });
  const s = capture();
  await exportBackup(a.store, { kids: ['ava'], choice: BACKUP_PRESETS.everything, env: s.env });
  assert.equal(a.store.getMeta().last_export, null);
  await exportBackup(a.store, { kids: ['ava', 'sam'], choice: BACKUP_PRESETS.everything, env: s.env });
  assert.equal(a.store.getMeta().last_export, '2026-11-12T10:00:00.000Z');
});

test('review: the preview names the child who gets the words and describes the real data, not the label', async () => {
  const a = await device();
  await a.r('POST', '/api/kids', { name: 'Ava', year: 2 });
  const w = await a.r('POST', '/api/kids/ava/weeks', { week_start: '2026-11-09', words: ['cat'] });
  await a.r('PUT', `/api/words/${w.words[0].id}/audio`, wav());
  const s = capture();
  await exportBackup(a.store, { kids: ['ava'], choice: { ...BACKUP_PRESETS.share, recordings: true }, env: s.env });
  const bytes = await bytesOf(s.got.file);
  const b = await device();
  await b.r('POST', '/api/kids', { name: 'Mia' });
  const p = await previewImport(b.store, bytes, 'merge', { target: 'mia' });
  assert.match(p.text, /Adding the words to Mia/);
  assert.match(p.text, /words, recordings/);
});

test('review: a merge that would push a week past the word limit is refused', async () => {
  const a = await device();
  await a.r('POST', '/api/kids', { name: 'Ava' });
  await a.r('POST', '/api/kids/ava/weeks', { week_start: '2026-11-09', words: Array.from({ length: 60 }, (_, i) => 'a' + 'x'.repeat(i % 30) + i) });
  const s = capture();
  await exportBackup(a.store, { kids: ['ava'], choice: BACKUP_PRESETS.share, env: s.env });
  const b = await device();
  await b.r('POST', '/api/kids', { name: 'Mia' });
  await b.r('POST', '/api/kids/mia/weeks', { week_start: '2026-11-09', words: Array.from({ length: 60 }, (_, i) => 'b' + i) });
  await assert.rejects(previewImport(b.store, await bytesOf(s.got.file), 'merge', { target: 'mia' }), /more than 100 words/);
});

test('review: a malformed week in a file gives the friendly "damaged" message', async () => {
  const { buildPack } = await import('../static/pack.js');
  const bad = buildPack({ kids: [{ slug: 'x', name: 'X', year: 1, settings: {} }], weeks: [{ kid: 'x', week_start: '2026-11-09', words: 'oops' }], sessions: [] });
  assert.throws(() => parsePack(bad), /damaged/);
});
