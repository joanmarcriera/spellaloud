// A read-aloud (tts) clip stays marked as read-aloud through backup selection, merge and a store round trip,
// so a family moving from the home server does not see machine voices counted as the child's own recordings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectSnapshot, mergePack, BACKUP_PRESETS } from '../static/pack.js';
import { createStore, memoryBackend } from '../static/store.js';

const clip = new Uint8Array([82, 73, 70, 70]);
const snap = () => ({
  kids: [{ slug: 'ash', name: 'Ash', year: 1, settings: {} }],
  weeks: [{ kid: 'ash', week_start: '2026-10-12', words: [
    { label: 'they', position: 1, audio: 'audio/1.wav', audio_source: 'tts' },
    { label: 'said', position: 2, audio: 'audio/2.wav' }] }],
  sessions: [],
});
const audio = { 'audio/1.wav': clip, 'audio/2.wav': clip };

test('selectSnapshot keeps audio_source only when recordings are kept', () => {
  const all = selectSnapshot(snap(), audio, { kids: null, ...BACKUP_PRESETS.everything }).snapshot;
  assert.equal(all.weeks[0].words[0].audio_source, 'tts');
  assert.equal(all.weeks[0].words[1].audio_source, undefined);
  const share = selectSnapshot(snap(), audio, { kids: null, ...BACKUP_PRESETS.share }).snapshot;
  assert.equal(share.weeks[0].words[0].audio_source, undefined);
});

test('mergePack carries audio_source into a word that had no recording', () => {
  const have = snap(); have.weeks[0].words = [{ label: 'they', position: 1, audio: null }];
  const { snapshot } = mergePack(have, {}, snap(), audio);
  const they = snapshot.weeks[0].words.find((w) => w.label === 'they');
  assert.equal(they.audio_source, 'tts');
  assert.equal(snapshot.weeks[0].words.find((w) => w.label === 'said').audio_source, undefined);
});

test('store import + export round trip keeps tts vs child', async () => {
  const store = await createStore(memoryBackend(), { today: '2026-10-15' });
  await store.replaceFromSnapshot(snap(), audio);
  const words = (await store.request('GET', '/api/kids/ash/weeks')).data[0].words;
  assert.deepEqual(words.map((w) => w.audio_source), ['tts', 'child']);
  const back = (await store.snapshot()).snapshot.weeks[0].words;
  assert.deepEqual(back.map((w) => w.audio_source), ['tts', undefined]);
});

test('merge into an empty bookmark-made child takes the file child\'s year and settings', () => {
  const here = { kids: [{ slug: 'ash', name: 'Ash', year: 2, settings: {} }], weeks: [], sessions: [] };
  const file = snap(); file.kids[0].settings = { speed: 'slow' };
  const { snapshot } = mergePack(here, {}, file, audio);
  assert.deepEqual(snapshot.kids, [{ slug: 'ash', name: 'Ash', year: 1, settings: { speed: 'slow' } }]);
  // a child with words here keeps its own record
  const busy = { ...structuredClone(here), weeks: [{ kid: 'ash', week_start: '2026-10-05', words: [{ label: 'a', position: 1, audio: null }] }] };
  assert.equal(mergePack(busy, {}, file, audio).snapshot.kids[0].year, 2);
});
