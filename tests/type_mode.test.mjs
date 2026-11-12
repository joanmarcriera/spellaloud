// Type-the-word practice mode (Vikunja #5604): the flag ships OFF; with it off the entry is absent from the kid app;
// with it on a correct entry (case and surrounding space ignored) is right and a wrong one lands in Not-yet; the flag
// survives an export/import round trip through the real store. Run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TYPE_MODE_DEFAULT, isTypeModeOn, typeModeEntry, checkTyped, typeResults, notYetIds } from '../static/typemode.js';

const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');

test('flag default is false and absent settings mean off', () => {
  assert.equal(TYPE_MODE_DEFAULT, false);
  assert.equal(isTypeModeOn({}), false);
  assert.equal(isTypeModeOn(undefined), false);
  assert.equal(isTypeModeOn({ typeMode: 'yes' }), false, 'only boolean true turns it on');
  assert.equal(isTypeModeOn({ typeMode: true }), true);
});

test('flag off: the mode entry is absent from the kid app; on: present', () => {
  assert.equal(typeModeEntry({ speed: 'normal' }), null);
  assert.equal(typeModeEntry({ typeMode: false }), null);
  assert.deepEqual(typeModeEntry({ typeMode: true }), { id: 'type', label: 'Type the word' });
  // the kid app renders the entry only through the helper, so off means no button at all
  const app = read('static/app.js');
  assert.match(app, /typeModeEntry\(S\.kid\.settings\) && btn\(/, 'home button must be gated by the helper');
  assert.equal((app.match(/startTyping/g) || []).length, 2, 'startTyping is only reachable from the gated button (definition + one use)');
});

test('a correct entry ignores case and surrounding space; a wrong one does not pass', () => {
  assert.equal(checkTyped('Because', 'because'), true);
  assert.equal(checkTyped('  because \n', 'because'), true);
  assert.equal(checkTyped('BECAUSE', 'because'), true);
  assert.equal(checkTyped('becuase', 'because'), false);
  assert.equal(checkTyped('be cause', 'because'), false, 'inner space is a mistake');
  assert.equal(checkTyped('', 'because'), false);
});

test('wrong entries become Not-yet (correct 0) in the same results shape as the check screen', () => {
  const words = [{ id: 1, label: 'because' }, { id: 2, label: 'friend' }, { id: 3, label: 'people' }];
  const results = typeResults(words, { 1: ' Because', 2: 'freind', 3: '' });
  assert.deepEqual(results, [{ word_id: 1, correct: 1 }, { word_id: 2, correct: 0 }, { word_id: 3, correct: 0 }]);
  assert.deepEqual(notYetIds(results), [2, 3]);
});

test('flag survives an export/import round trip, and a fresh child has it off', async () => {
  const { createStore, memoryBackend } = await import('../static/store.js');
  const { exportBackup, previewImport, applyImport } = await import('../static/backup.js');
  const device = async () => {
    const store = await createStore(memoryBackend(), { clock: () => new Date(Date.parse('2026-10-21T10:00:00Z')) });
    return { store, r: (m, p, b) => store.request(m, p, b).then((x) => x.data) };
  };
  const a = await device();
  const kid = await a.r('POST', '/api/kids', { name: 'Ann', year: 3 });
  assert.equal(isTypeModeOn(kid.settings), false, 'new child: flag off');
  await a.r('POST', '/api/kids/ann/weeks', { week_start: '2026-10-19', words: ['cat', 'dog'] });
  const s = { ...kid.settings, typeMode: true };
  const saved = await a.r('PUT', '/api/kids/ann/settings', s);
  assert.equal(saved.typeMode, true);
  let file;
  await exportBackup(a.store, { env: { navigator: { canShare: () => true, share: async ({ files }) => { file = files[0]; } } } });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const b = await device();
  await applyImport(b.store, await previewImport(b.store, bytes, 'merge'));
  const kids = await b.r('GET', '/api/kids');
  assert.equal(kids[0].settings.typeMode, true, 'flag lost in the round trip');
  // saving the flag off again drops it (absent = off); other settings keep their values
  const off = await b.r('PUT', '/api/kids/ann/settings', { ...kids[0].settings, typeMode: false });
  assert.equal(isTypeModeOn(off), false);
  assert.equal(off.speed, kid.settings.speed);
});
