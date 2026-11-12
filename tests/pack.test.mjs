// Tests for static/pack.js (run: node --test). Includes an interop check against the system unzip/python zipfile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, zipStore, unzipStore, buildPack, parsePack, mergePack, describeSummary, packFilename, exportReminderDue, deliverPack } from '../static/pack.js';

const wav = (n) => new Uint8Array([82, 73, 70, 70, n, n, n]); // fake clip bytes
const snap = () => ({
  kids: [{ slug: 'ash', name: 'Ash', year: 1, settings: {} }],
  weeks: [{ kid: 'ash', week_start: '2026-10-12', words: [
    { label: 'cat', position: 1, audio: 'audio/1.wav' }, { label: 'dog', position: 2, audio: null }] }],
  sessions: [{ kid: 'ash', created_at: '2026-10-13T08:00:00Z', mode: 'week', settings: {}, results: [{ week_start: '2026-10-12', label: 'cat', correct: 1 }] }],
});

test('crc32 known vector', () => assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926));

test('zip round-trip incl. unicode names and empty file', () => {
  const files = { 'a.txt': new TextEncoder().encode('hello'), 'é/b.bin': new Uint8Array([0, 1, 2, 255]), 'empty': new Uint8Array(0) };
  const back = unzipStore(zipStore(files));
  assert.deepEqual(Object.keys(back).sort(), Object.keys(files).sort());
  for (const k of Object.keys(files)) assert.deepEqual(back[k], files[k]);
});

test('zip is readable by python zipfile (standard ZIP)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pack-'));
  try {
    const f = join(dir, 'x.spellings');
    writeFileSync(f, buildPack(snap(), { 'audio/1.wav': wav(7) }));
    let out;
    try { out = execFileSync('python3', ['-I', '-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip());print(sorted(z.namelist()))', f]).toString(); }
    catch { return t.skip('python3 not available'); }
    assert.match(out, /^None\n\['audio\/1.wav', 'data.json', 'manifest.json'\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('build/parse round-trip keeps data and audio bytes', () => {
  const { snapshot, audio } = parsePack(buildPack(snap(), { 'audio/1.wav': wav(7) }));
  assert.deepEqual(snapshot, snap());
  assert.deepEqual(audio['audio/1.wav'], wav(7));
});

test('buildPack refuses a referenced clip that is missing', () => assert.throws(() => buildPack(snap(), {}), /Missing audio/));

test('parsePack rejects junk, truncation, corruption and wrong format', () => {
  assert.throws(() => parsePack(new TextEncoder().encode('not a zip at all, definitely not')), /not a Spellings file/);
  const good = buildPack(snap(), { 'audio/1.wav': wav(7) });
  assert.throws(() => parsePack(good.slice(0, good.length - 40)), /Spellings file|damaged/);
  const bad = good.slice(); bad[50] ^= 0xff; // inside manifest.json data (starts at byte 43)
  assert.throws(() => parsePack(bad), /damaged/);
  const other = zipStore({ 'manifest.json': new TextEncoder().encode('{"format":"x","version":1}'), 'data.json': new TextEncoder().encode('{}') });
  assert.throws(() => parsePack(other), /not a Spellings file/);
  const newer = zipStore({ 'manifest.json': new TextEncoder().encode('{"format":"spellings-pack","version":99}'), 'data.json': new TextEncoder().encode('{}') });
  assert.throws(() => parsePack(newer), /newer version/);
});

test('unzip rejects path traversal names', () => {
  assert.throws(() => unzipStore(zipStore({ '../evil': new Uint8Array([1]) })), /not safe/);
});

const incoming = () => ({
  kids: [{ slug: 'ash', name: 'Ash', year: 1, settings: {} }, { slug: 'finn', name: 'Finn', year: 3, settings: {} }],
  weeks: [
    { kid: 'ash', week_start: '2026-10-12', words: [ // same week: dog gets audio, cat already has, bird is new
      { label: 'Cat', position: 1, audio: 'audio/a.wav' }, { label: 'DOG', position: 2, audio: 'audio/b.wav' }, { label: 'bird', position: 3, audio: null }] },
    { kid: 'finn', week_start: '2026-10-05', words: [{ label: 'because', position: 1, audio: 'audio/c.wav' }] }],
  sessions: [snap().sessions[0], { kid: 'finn', created_at: '2026-10-06T08:00:00Z', mode: 'week', settings: {}, results: [] }],
});
const inAudio = { 'audio/a.wav': wav(1), 'audio/b.wav': wav(2), 'audio/c.wav': wav(3) };

test('merge by week: keeps existing recording, fills gaps, adds new, dedupes sessions', () => {
  const r = mergePack(snap(), { 'audio/1.wav': wav(7) }, incoming(), inAudio, 'merge');
  const ar = r.snapshot.weeks.find((w) => w.kid === 'ash');
  assert.deepEqual(ar.words.map((w) => w.label), ['cat', 'dog', 'bird']);
  assert.deepEqual(r.audio[ar.words[0].audio], wav(7), 'existing cat recording untouched');
  assert.deepEqual(r.audio[ar.words[1].audio], wav(2), 'dog gets the imported recording');
  assert.equal(ar.words[2].audio, null);
  assert.equal(r.snapshot.weeks.length, 2);
  assert.equal(r.snapshot.sessions.length, 2, 'duplicate session not added twice');
  assert.deepEqual(r.snapshot.kids.map((k) => k.slug), ['ash', 'finn']);
  assert.deepEqual(r.summary, { mode: 'merge', weeksAdded: 1, weeksMerged: 1, wordsAdded: 2, recordingsAdded: 2, sessionsAdded: 1, weeksDiscarded: 0 });
  // every audio ref resolves, and no stray audio
  const refs = r.snapshot.weeks.flatMap((w) => w.words.map((x) => x.audio)).filter(Boolean);
  assert.deepEqual(refs.sort(), Object.keys(r.audio).sort());
  assert.match(describeSummary(r.summary), /Nothing here is overwritten/);
});

test('merge does not mutate its inputs', () => {
  const e = snap(); const before = JSON.stringify(e);
  mergePack(e, { 'audio/1.wav': wav(7) }, incoming(), inAudio, 'merge');
  assert.equal(JSON.stringify(e), before);
});

test('replace reports what is discarded', () => {
  const r = mergePack(snap(), { 'audio/1.wav': wav(7) }, incoming(), inAudio, 'replace');
  assert.equal(r.snapshot.weeks.length, 2);
  assert.equal(r.summary.weeksDiscarded, 1);
  assert.match(describeSummary(r.summary), /1 weeks here will be discarded/);
});

test('packFilename and reminder rule', () => {
  assert.equal(packFilename('Ash & Finn!', new Date('2026-10-16T10:00:00Z')), 'spellings-ash-finn-2026-10-16.spellings');
  assert.equal(packFilename('', new Date('2026-10-16T10:00:00Z')), 'spellings-family-2026-10-16.spellings');
  const now = new Date('2026-11-14T00:00:00Z');
  assert.equal(exportReminderDue(null, now), true);
  assert.equal(exportReminderDue('garbage', now), true);
  assert.equal(exportReminderDue('2026-10-20T00:00:00Z', now), false); // 25 days
  assert.equal(exportReminderDue('2026-10-10T00:00:00Z', now), true); // 35 days
});

test('deliverPack: share sheet when files can be shared, download otherwise, cancel handled', async () => {
  const calls = [];
  const mkEnv = (nav) => ({ navigator: nav, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    document: { createElement: () => ({ click: () => calls.push('click'), remove() {} }), body: { appendChild() {} } } });
  const bytes = new Uint8Array([1, 2, 3]);
  const shared = [];
  assert.equal(await deliverPack(bytes, 'a.spellings', mkEnv({ canShare: () => true, share: async (d) => shared.push(d.files[0].name) })), 'shared');
  assert.deepEqual(shared, ['a.spellings']);
  assert.equal(await deliverPack(bytes, 'a.spellings', mkEnv({ canShare: () => true, share: async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); } })), 'cancelled');
  assert.equal(calls.length, 0);
  assert.equal(await deliverPack(bytes, 'a.spellings', mkEnv({ canShare: () => false, share: async () => {} })), 'downloaded');
  assert.equal(await deliverPack(bytes, 'a.spellings', mkEnv({})), 'downloaded');
  assert.equal(await deliverPack(bytes, 'a.spellings', mkEnv({ canShare: () => true, share: async () => { throw new Error('NotAllowed'); } })), 'downloaded');
  assert.equal(calls.length, 3);
});

test('merge sorts sessions by time so older imported sessions do not look newest (#4526)', () => {
  const e = { kids: [{ slug: 'a', name: 'A', year: 1, settings: {} }], weeks: [],
    sessions: [{ kid: 'a', created_at: '2026-10-20T08:00:00', mode: 'week', settings: {}, results: [] }] };
  const i = { kids: [], weeks: [], sessions: [
    { kid: 'a', created_at: '2026-10-10T08:00:00', mode: 'week', settings: {}, results: [] },
    { kid: 'a', created_at: '2026-10-25T08:00:00', mode: 'week', settings: {}, results: [] }] };
  const r = mergePack(e, {}, i, {}, 'merge');
  assert.deepEqual(r.snapshot.sessions.map((s) => s.created_at),
    ['2026-10-10T08:00:00', '2026-10-20T08:00:00', '2026-10-25T08:00:00']);
});

test('merge carries the I-know-it marker onto appended and existing words, ignoring bad stamps (#4527)', () => {
  const e = { kids: [], sessions: [], weeks: [{ kid: 'a', week_start: '2026-10-12', words: [
    { label: 'cat', position: 1, audio: null }, { label: 'dog', position: 2, audio: null, cleared_at: '2026-10-14T09:00:00' }] }] };
  const i = { kids: [], sessions: [], weeks: [{ kid: 'a', week_start: '2026-10-12', words: [
    { label: 'cat', position: 1, audio: null, cleared_at: '2026-10-15T09:00:00' },
    { label: 'dog', position: 2, audio: null, cleared_at: 'garbage' },
    { label: 'new', position: 3, audio: null, cleared_at: '2026-10-16T09:00:00' }] }] };
  const w = mergePack(e, {}, i, {}, 'merge').snapshot.weeks[0].words;
  assert.equal(w[0].cleared_at, '2026-10-15T09:00:00', 'existing word gains the marker');
  assert.equal(w[1].cleared_at, '2026-10-14T09:00:00', 'a bad stamp does not clobber a good one');
  assert.equal(w[2].cleared_at, '2026-10-16T09:00:00', 'appended word keeps the marker');
});
