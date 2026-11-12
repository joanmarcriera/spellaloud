// School calendar + term on/off (feat/school-terms): terms.js lookups, the data file, and store.js behaviour.
// Run: node --test tests/school_terms.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { KATHERINE_SEMAR } from '../static/calendar-katherine-semar.js';
import { halfTermOf, currentHalfTerm, isTermLabel, termOrder, termYear, calendarId, halfTermNeighbours, bigSpellLabel } from '../static/terms.js';
import { createStore, memoryBackend, ApiError } from '../static/store.js';
import { validateSnapshot } from '../static/backup.js';

// ------------------------------------------------------------------------------------ the data
test('data: six half-terms per school year, in order, no overlaps, each inside its year', () => {
  assert.deepEqual(KATHERINE_SEMAR.years.map((y) => y.year), ['2025-26', '2026-27', '2027-28']);
  let prevEnd = '';
  for (const y of KATHERINE_SEMAR.years) {
    assert.deepEqual(y.halfTerms.map((h) => h.name), ['Autumn 1', 'Autumn 2', 'Spring 1', 'Spring 2', 'Summer 1', 'Summer 2']);
    for (const h of y.halfTerms) {
      assert.match(h.start, /^\d{4}-\d{2}-\d{2}$/); assert.match(h.end, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(h.start <= h.end, `${y.year} ${h.name} ends before it starts`);
      assert.ok(h.start > prevEnd, `${y.year} ${h.name} overlaps the one before`);
      prevEnd = h.end;
    }
    for (const d of y.nonPupilDays) assert.ok(y.halfTerms.some((h) => d >= h.start && d <= h.end), `INSET ${d} is outside every half-term`);
  }
  for (const [name, url] of Object.entries(KATHERINE_SEMAR.sources)) assert.match(url, /^https:\/\//, name);
});

// ------------------------------------------------------------------------------- half-term lookup
test('halfTermOf: first day, last day and the days around the 2026-27 Autumn 2 half-term', () => {
  assert.equal(halfTermOf('2026-11-02'), '2026-27 Autumn 2'); // first day
  assert.equal(halfTermOf('2026-12-18'), '2026-27 Autumn 2'); // last day
  assert.equal(halfTermOf('2026-10-23'), '2026-27 Autumn 1'); // last day of Autumn 1
  assert.equal(halfTermOf('2026-09-01'), '2026-27 Autumn 1'); // first day (INSET)
});

test('halfTermOf: a week that starts in a holiday belongs to the next half-term', () => {
  assert.equal(halfTermOf('2026-10-26'), '2026-27 Autumn 2'); // October half-term Monday
  assert.equal(halfTermOf('2026-12-21'), '2026-27 Spring 1'); // Christmas
  assert.equal(halfTermOf('2027-02-15'), '2026-27 Spring 2'); // February half-term
  assert.equal(halfTermOf('2027-03-29'), '2026-27 Summer 1'); // Easter
  assert.equal(halfTermOf('2027-05-31'), '2026-27 Summer 2'); // May bank holiday + June half-term
  assert.equal(halfTermOf('2027-08-23'), '2027-28 Autumn 1'); // summer holiday
});

test('halfTermOf: the INSET Monday that opens Summer 2 (2027-06-07) and the one that closes it', () => {
  assert.equal(halfTermOf('2027-06-07'), '2026-27 Summer 2');
  assert.equal(halfTermOf('2027-07-19'), '2026-27 Summer 2');
});

test('halfTermOf: 2025-26 dates and the edges of the data', () => {
  assert.equal(halfTermOf('2025-09-01'), '2025-26 Autumn 1');
  assert.equal(halfTermOf('2026-03-30'), '2025-26 Summer 1'); // Easter
  assert.equal(halfTermOf('2026-07-20'), '2025-26 Summer 2');
  assert.equal(halfTermOf('2025-07-07'), null); // before the data (more than a summer holiday earlier)
  assert.equal(halfTermOf('2028-09-04'), null); // after the data
  assert.equal(halfTermOf('2025-08-25'), '2025-26 Autumn 1'); // the summer holiday just before the first term
});

test('currentHalfTerm: in a holiday it is the half-term that just ended, so Big Spell has words', () => {
  assert.equal(currentHalfTerm('2026-11-08'), '2026-27 Autumn 2');
  assert.equal(currentHalfTerm('2026-10-28'), '2026-27 Autumn 1'); // October half-term
  assert.equal(currentHalfTerm('2026-12-25'), '2026-27 Autumn 2'); // Christmas Day
  assert.equal(currentHalfTerm('2026-11-02'), '2026-27 Autumn 2'); // first day
  assert.equal(currentHalfTerm('2029-01-01'), null);
  assert.equal(currentHalfTerm('2025-01-01'), null);
});

test('labels: both formats are accepted, ordered and mapped to a school year', () => {
  for (const ok of ['2026 Autumn', '2026 Summer', '2026-27 Autumn 2', '2025-26 Summer 1']) assert.equal(isTermLabel(ok), true, ok);
  for (const bad of ['2026-27 Autumn', '2026-27 Autumn 3', '2026 Autumn 2', '2026-28 Autumn 1', 'junk', '', null, 7]) assert.equal(isTermLabel(bad), false, String(bad));
  assert.equal(termYear('2026-27 Spring 2'), '2026-27');
  assert.equal(termYear('2026 Autumn'), '2026-27');
  assert.equal(termYear('2027 Spring'), '2026-27');
  assert.ok(termOrder('2026-27 Autumn 1') < termOrder('2026-27 Autumn 2'));
  assert.ok(termOrder('2026-27 Autumn 2') < termOrder('2026-27 Spring 1'));
  assert.ok(termOrder('2026-27 Summer 2') < termOrder('2027-28 Autumn 1'));
  assert.ok(termOrder('2026 Autumn') < termOrder('2027 Spring'));
  assert.deepEqual(halfTermNeighbours('2026-27 Autumn 2', 2), ['2025-26 Summer 2', '2026-27 Autumn 1', '2026-27 Spring 1', '2026-27 Spring 2']);
  assert.deepEqual(halfTermNeighbours('2025-26 Autumn 1', 2), ['2025-26 Autumn 2', '2025-26 Spring 1']); // edge of the data
  assert.deepEqual(halfTermNeighbours('2026 Autumn', 2), []); // not a calendar label
  assert.equal(calendarId({ calendar: 'katherine-semar' }), 'katherine-semar');
  for (const none of [undefined, {}, { calendar: 'approx' }, { calendar: 'nonsense' }]) assert.equal(calendarId(none), 'approx');
});

// ------------------------------------------------------------------------------------- the store
const wav = () => { const b = new Uint8Array(60); b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0); b.set([...'WAVE'].map((c) => c.charCodeAt(0)), 8); return b; };
const mk = async (today = '2026-11-08') => {
  const backend = memoryBackend();
  const store = await createStore(backend, { today });
  const r = (m, p, b) => store.request(m, p, b).then((x) => x.data);
  const fail = async (m, p, b) => { try { await store.request(m, p, b); } catch (e) { assert.ok(e instanceof ApiError); return e; } assert.fail('expected ApiError'); };
  await r('POST', '/api/kids', { name: 'Ann', year: 3 });
  return { store, r, fail, backend };
};
const BASE = { speed: 'normal', repeats: 2, pause: 'short', order: 'mix' };
const setCal = (r, extra = {}) => r('PUT', '/api/kids/ann/settings', { ...BASE, calendar: 'katherine-semar', ...extra });
const addWeek = async (r, week_start, words, term) => {
  const w = await r('POST', '/api/kids/ann/weeks', { week_start, words, ...(term ? { term } : {}) });
  for (const x of w.words) await r('PUT', `/api/words/${x.id}/audio`, wav());
  return w;
};
const practice = async (r, q) => (await r('GET', `/api/kids/ann/practice?${q}`)).words.map((x) => x.label);

test('approximate calendar (the default) is unchanged: terms, options, Big Spell', async () => {
  const { r } = await mk('2026-10-21');
  const w = await addWeek(r, '2026-10-19', ['cat']);
  assert.equal(w.term, '2026 Autumn'); assert.equal(w.term_default, '2026 Autumn'); assert.equal(w.term_auto, true);
  assert.deepEqual(w.term_options, ['2026 Spring', '2026 Summer', '2027 Spring', '2027 Summer']);
  const t = await r('GET', '/api/kids/ann/terms');
  assert.equal(t.current, '2026 Autumn');
  assert.deepEqual(t.terms.map((x) => x.key), ['2026 Autumn']);
  assert.deepEqual(await practice(r, 'mode=term'), ['cat']);
});

test('Katherine Semar calendar: a new week gets its half-term, with neighbouring half-terms as options', async () => {
  const { r } = await mk();
  await setCal(r);
  const w = await r('POST', '/api/kids/ann/weeks', { week_start: '2026-11-09', words: ['cat'] });
  assert.equal(w.term, '2026-27 Autumn 2'); assert.equal(w.term_auto, true); assert.equal(w.term_default, '2026-27 Autumn 2');
  assert.deepEqual(w.term_options, ['2025-26 Summer 2', '2026-27 Autumn 1', '2026-27 Spring 1', '2026-27 Spring 2']);
  const hol = await r('POST', '/api/kids/ann/weeks', { week_start: '2026-12-21', words: ['dog'] });
  assert.equal(hol.term, '2026-27 Spring 1');
  const old = await r('POST', '/api/kids/ann/weeks', { week_start: '2025-03-03', words: ['old'] }); // before the data: approximate fallback
  assert.equal(old.term, '2025 Spring');
});

test('Katherine Semar calendar: stored weeks are re-grouped on read, switching back restores the approximate terms', async () => {
  const { r } = await mk();
  const w = await addWeek(r, '2026-11-09', ['cat']);
  assert.equal(w.term, '2026 Autumn');
  await setCal(r);
  assert.equal((await r('GET', '/api/kids/ann/weeks'))[0].term, '2026-27 Autumn 2');
  await r('PUT', '/api/kids/ann/settings', BASE);
  assert.equal((await r('GET', '/api/kids/ann/weeks'))[0].term, '2026 Autumn');
});

test('manual per-week override still works, in either format, under either calendar', async () => {
  const { r, fail } = await mk();
  await setCal(r);
  const w = await r('POST', '/api/kids/ann/weeks', { week_start: '2026-11-09', words: ['cat'] });
  const p1 = await r('PATCH', `/api/weeks/${w.id}`, { term: '2026-27 Autumn 1' });
  assert.equal(p1.term, '2026-27 Autumn 1'); assert.equal(p1.term_auto, false); assert.equal(p1.term_default, '2026-27 Autumn 2');
  const p2 = await r('PATCH', `/api/weeks/${w.id}`, { term: '2026 Autumn' }); // an old-format value is still accepted
  assert.equal(p2.term, '2026 Autumn');
  assert.equal((await r('PATCH', `/api/weeks/${w.id}`, { term: null })).term, '2026-27 Autumn 2');
  assert.equal((await fail('PATCH', `/api/weeks/${w.id}`, { term: '2026-27 Autumn 9' })).status, 400);
  assert.equal((await fail('POST', '/api/kids/ann/weeks', { week_start: '2026-11-16', words: ['x'], term: 'nope' })).status, 400);
  await r('PUT', '/api/kids/ann/settings', BASE); // approximate again: a half-term override is still a valid label
  assert.equal((await r('PATCH', `/api/weeks/${w.id}`, { term: '2026-27 Autumn 1' })).term, '2026-27 Autumn 1');
});

test('Big Spell under Katherine Semar uses the current half-term; tricky too; whole-year scope sums the half-terms', async () => {
  const { r } = await mk('2026-11-12');
  await setCal(r);
  await addWeek(r, '2026-09-14', ['a1']); // Autumn 1
  await addWeek(r, '2026-11-09', ['a2']); // Autumn 2 (today)
  await addWeek(r, '2027-01-11', ['s1']); // Spring 1 (future)
  assert.deepEqual(await practice(r, 'mode=term'), ['a2']);
  assert.deepEqual(await practice(r, 'mode=term&term=2026-27%20Autumn%201'), ['a1']);
  assert.deepEqual(await practice(r, 'mode=term&term=2026-27'), ['a1', 'a2', 's1']);
  const t = await r('GET', '/api/kids/ann/terms');
  assert.equal(t.calendar, 'katherine-semar');
  assert.equal(t.current, '2026-27 Autumn 2');
  assert.deepEqual(t.terms.map((x) => x.key), ['2026-27 Spring 1', '2026-27 Autumn 2', '2026-27 Autumn 1']);
  assert.deepEqual(t.years, [{ key: '2026-27', label: '2026-27 (whole year)' }]);
});

test('term on/off: off terms drop out of Big Spell, whole-year Big Spell and Tricky, and out of the kid chips', async () => {
  const { r } = await mk('2026-11-12');
  await setCal(r);
  const a1 = await addWeek(r, '2026-09-14', ['a1']);
  const a2 = await addWeek(r, '2026-11-09', ['a2']);
  const s1 = await addWeek(r, '2027-01-11', ['s1']);
  const miss = (w) => r('POST', '/api/kids/ann/sessions', { mode: 'week', results: [{ word_id: w.words[0].id, correct: 0 }] });
  for (const w of [a1, a2, s1]) await miss(w);
  assert.deepEqual(await practice(r, 'mode=tricky&term=2026-27'), ['a1', 'a2', 's1']);

  await setCal(r, { terms_off: ['2026-27 Autumn 1', '2026-27 Spring 1'] });
  assert.deepEqual(await practice(r, 'mode=term&term=2026-27'), ['a2']);
  assert.deepEqual(await practice(r, 'mode=tricky&term=2026-27'), ['a2']);
  assert.deepEqual(await practice(r, 'mode=term'), ['a2']);
  assert.deepEqual(await practice(r, 'mode=term&term=2026-27%20Autumn%201'), []); // an off term stays off even when asked for by name
  assert.deepEqual(await practice(r, `week=${a1.id}`), ['a1']); // but a single week is always practisable
  const t = await r('GET', '/api/kids/ann/terms');
  assert.deepEqual(t.terms.map((x) => x.key), ['2026-27 Autumn 2']);
  const all = await r('GET', '/api/kids/ann/terms?all=1');
  assert.deepEqual(all.terms.map((x) => [x.key, x.on]), [['2026-27 Spring 1', false], ['2026-27 Autumn 2', true], ['2026-27 Autumn 1', false]]);
  const rep = await r('GET', '/api/report'); // most-missed list follows the same filter
  assert.deepEqual(rep.ann.most_missed.map((x) => x.label), ['a2']);

  await setCal(r, { terms_off: [] }); // switching everything back on clears the setting
  assert.deepEqual(await practice(r, 'mode=term&term=2026-27'), ['a1', 'a2', 's1']);
  assert.equal('terms_off' in (await r('GET', '/api/kids'))[0].settings, false);
});

test('term on/off with the approximate calendar and old-format terms', async () => {
  const { r } = await mk('2026-10-21');
  await addWeek(r, '2026-01-12', ['spring']);
  await addWeek(r, '2026-10-19', ['autumn']);
  await r('PUT', '/api/kids/ann/settings', { ...BASE, terms_off: ['2026 Spring'] });
  assert.deepEqual(await practice(r, 'mode=term&term=2025-26'), []);
  assert.deepEqual(await practice(r, 'mode=term'), ['autumn']);
  assert.deepEqual((await r('GET', '/api/kids/ann/terms?all=1')).terms.map((x) => [x.key, x.on]), [['2026 Autumn', true], ['2026 Spring', false]]);
});

test('settings validation: calendar and terms_off', async () => {
  const { r, fail } = await mk();
  assert.equal((await fail('PUT', '/api/kids/ann/settings', { ...BASE, calendar: 'hogwarts' })).status, 400);
  assert.equal((await fail('PUT', '/api/kids/ann/settings', { ...BASE, terms_off: 'all' })).status, 400);
  assert.equal((await fail('PUT', '/api/kids/ann/settings', { ...BASE, terms_off: ['not a term'] })).status, 400);
  assert.equal((await fail('PUT', '/api/kids/ann/settings', { ...BASE, terms_off: Array(61).fill('2026 Autumn') })).status, 400);
  const ok = await r('PUT', '/api/kids/ann/settings', { ...BASE, calendar: 'approx', terms_off: ['2026 Autumn', '2026 Autumn', '2026-27 Spring 1'] });
  assert.equal('calendar' in ok, false); // approximate is the default: nothing stored
  assert.deepEqual(ok.terms_off, ['2026 Autumn', '2026-27 Spring 1']); // de-duplicated
});

test('settings survive a reload and the other settings writers do not drop them', async () => {
  const { r, backend } = await mk();
  await setCal(r, { terms_off: ['2026-27 Autumn 1'] });
  const again = await createStore(memoryBackend(backend.persisted()), { today: '2026-11-08' });
  const kid = (await again.request('GET', '/api/me')).data.kid;
  assert.equal(kid.settings.calendar, 'katherine-semar');
  assert.deepEqual(kid.settings.terms_off, ['2026-27 Autumn 1']);
  // parent.js / app.js save settings by spreading what they loaded: the new keys ride along
  const saved = await r('PUT', '/api/kids/ann/settings', { ...kid.settings, speed: 'slow' });
  assert.equal(saved.calendar, 'katherine-semar'); assert.deepEqual(saved.terms_off, ['2026-27 Autumn 1']);
});

test('export / import: calendar, switches and half-term weeks round-trip', async () => {
  const { r, store } = await mk();
  await setCal(r, { terms_off: ['2026-27 Autumn 1'] });
  await addWeek(r, '2026-11-09', ['cat'], '2026-27 Autumn 1'); // a manual half-term override travels too
  await addWeek(r, '2026-11-16', ['dog']);
  const { snapshot, audio } = await store.snapshot();
  const json = JSON.parse(JSON.stringify(snapshot));
  assert.doesNotThrow(() => validateSnapshot(json, audio));
  const fresh = await createStore(memoryBackend(), { today: '2026-11-08' });
  await fresh.replaceFromSnapshot(json, audio);
  const kid = (await fresh.request('GET', '/api/me')).data.kid;
  assert.equal(kid.settings.calendar, 'katherine-semar');
  assert.deepEqual(kid.settings.terms_off, ['2026-27 Autumn 1']);
  const weeks = (await fresh.request('GET', '/api/kids/ann/weeks')).data;
  assert.deepEqual(weeks.map((w) => [w.week_start, w.term, w.term_auto]), [['2026-11-09', '2026-27 Autumn 1', false], ['2026-11-16', '2026-27 Autumn 2', true]]);
});

test('import validation rejects a bad calendar or terms_off in a pack file', () => {
  const base = (settings, term = null) => ({ kids: [{ slug: 'ann', name: 'Ann', year: 3, settings }], weeks: [{ kid: 'ann', week_start: '2026-11-09', term, words: [] }], sessions: [] });
  assert.doesNotThrow(() => validateSnapshot(base({ ...BASE, calendar: 'katherine-semar', terms_off: ['2026-27 Autumn 1', '2026 Spring'] }, '2026-27 Autumn 2')));
  assert.throws(() => validateSnapshot(base({ ...BASE, calendar: 'x' })), /cannot be imported/);
  assert.throws(() => validateSnapshot(base({ ...BASE, terms_off: ['x'] })), /cannot be imported/);
  assert.throws(() => validateSnapshot(base({ ...BASE, terms_off: 'x' })), /cannot be imported/);
  assert.throws(() => validateSnapshot(base(BASE, '2026-27 Autumn 7')), /cannot be imported/);
});

// ---------------------------------------------------------------------------- the child's Big Spell tab
test('bigSpellLabel: names the half-term only under a school calendar', () => {
  const ks = { calendar: 'katherine-semar', current: '2026-27 Autumn 2' };
  assert.equal(bigSpellLabel('Big Spell', ks, null), 'Big Spell · Autumn 2');
  assert.equal(bigSpellLabel('Big Spell', ks, '2026-27 Autumn 1'), 'Big Spell · Autumn 1'); // a chosen half-term
  assert.equal(bigSpellLabel('Big Spell', ks, '2026-27'), 'Big Spell · 2026-27'); // a whole year
  assert.equal(bigSpellLabel('Big Spell', { calendar: 'approx', current: '2026 Autumn' }, null), 'Big Spell');
  assert.equal(bigSpellLabel('Big Spell', { current: '2026 Autumn' }, null), 'Big Spell'); // family server: no calendar field
  assert.equal(bigSpellLabel('Big Spell', null, null), 'Big Spell');
});

test('the parent page and kid app are wired to the calendar and term switches', async () => {
  const { readFileSync } = await import('node:fs');
  const parent = readFileSync(new URL('../static/parent.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../static/app.js', import.meta.url), 'utf8');
  assert.match(parent, /terms\?all=1/);
  assert.match(parent, /terms_off/);
  assert.match(parent, /School calendar for \$\{kid\.name\}/);
  assert.match(parent, /t\.mode !== 'local'\) return null/, 'the family server has no calendar setting, so the box is browser-build only');
  assert.match(app, /bigSpellLabel\(t, S\.terms, S\.scope\)/);
});
