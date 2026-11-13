// store.js - the family server's JSON API (server.py) re-implemented over local storage (Vikunja #3532).
//
// Purpose
//   A browser-only build has no server. `createStore(backend, opts)` returns a store whose
//   `request(method, path, body)` accepts the same method + path + JSON body as server.py's routes and
//   resolves to the same JSON, or rejects with an ApiError {status, message}, so the kid app and the
//   parent page keep their screens and only swap their transport (see transport.js).
//
// Storage model
//   One plain-JSON `state` record (kids, weeks, words, sessions, results, meta) written through on
//   every change, plus one audio blob per word id. A family has hundreds of words, so a whole-state
//   write is cheap and keeps every mutation atomic. `backend` is any object with
//     load() -> {state|null, audio: {id: ArrayBuffer}}   saveState(state)
//     exclusive(fn)  optional: run fn under a cross-tab lock (idbBackend uses Web Locks) so reload + save is atomic
//     putAudio(id, bytes)   getAudio(id) -> bytes|null    delAudio(ids)   replaceAll(state, audio)
//   `memoryBackend()` (tests) and `idbBackend()` (browser, IndexedDB) are provided.
//
// Usage
//   const store = await createStore(idbBackend(), { clock: () => new Date() });
//   const weeks = await store.request('GET', '/api/kids/ann/weeks');
//   store.snapshot() / store.replaceFromSnapshot(...) back the export/import pack (pack.js).
//
// Rules ported unchanged from server.py: word labels 1-40 chars, at most 100 words a week, weeks start on
// Monday, terms are approximate UK terms, a miss stays "tricky" until two right answers in a row.
// New in the local build (feat/school-terms; the family server keeps the approximate terms): a child's settings may
// carry `calendar` ('katherine-semar' = real half-terms, see terms.js) and `terms_off` (term labels left out of
// Big Spell and Tricky words). Both ride in kid.settings, so they travel in the export file like voice does.

import { validVoiceName } from './voice.js';
import { cleanKidFlags } from './kidopts.js';
import { CALENDARS, calendarId, isTermLabel, termOrder, termYear, halfTermOf, currentHalfTerm, halfTermNeighbours } from './terms.js';

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; this.message = message; }
}

export const MAX_AUDIO = 1024 * 1024;
export const MAX_LABEL = 40;
export const MAX_WORDS_PER_WEEK = 100;
const SPEEDS = ['slow', 'normal', 'fast'];
const PAUSES = ['short', 'long'];
const ORDERS = ['mix', 'inorder'];
const MODES = ['week', 'term', 'tricky'];
const TRICKY_WINDOW = 2;
export const DEFAULT_SETTINGS = { speed: 'normal', repeats: 2, pause: 'short', order: 'mix' };

// ----------------------------------------------------------------- dates (UTC math on ISO strings)
const DAY = 86400000;
const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const msOf = (iso) => Date.parse(iso + 'T00:00:00Z');

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ApiError(400, 'week_start must be an ISO date (YYYY-MM-DD)');
  const ms = msOf(s);
  if (Number.isNaN(ms) || isoOf(ms) !== s) throw new ApiError(400, 'week_start is not a valid date');
  const y = Number(s.slice(0, 4));
  if (y < 2000 || y > 2100) throw new ApiError(400, 'week_start must be between 2000 and 2100');
  return s;
}
/** Monday on or before the ISO date. */
export function mondayOf(s) {
  const wd = (new Date(msOf(s)).getUTCDay() + 6) % 7; // Monday = 0
  return isoOf(msOf(s) - wd * DAY);
}
/** Approximate UK term: Sep-Dec Autumn, Jan-Mar Spring, Apr-Aug Summer. */
export function termOf(s) {
  const month = Number(s.slice(5, 7));
  return `${s.slice(0, 4)} ${month >= 9 ? 'Autumn' : month <= 3 ? 'Spring' : 'Summer'}`;
}
const TERM_NAMES = ['Spring', 'Summer', 'Autumn'];
const YEAR_RE = /^(\d{4})-(\d{2})$/;
const termIndex = (label) => { const m = /^(\d{4}) (Spring|Summer|Autumn)$/.exec(label); return Number(m[1]) * 3 + TERM_NAMES.indexOf(m[2]); };
const termLabel = (idx) => `${Math.floor(idx / 3)} ${TERM_NAMES[idx % 3]}`;
/** School year of a term: Autumn 2025 + Spring/Summer 2026 -> '2025-26'. Also takes '2025-26 Autumn 2'. */
export const academicYear = termYear;
/** A week's automatic term under a child's calendar: a real half-term, else (default, or outside the data) the approximate term. */
export const autoTermOf = (iso, settings) => (calendarId(settings) === 'approx' ? null : halfTermOf(iso)) || termOf(iso);
/** The term "now" belongs to for Big Spell: in a holiday the half-term that just ended. */
const currentTermOf = (iso, settings) => (calendarId(settings) === 'approx' ? null : currentHalfTerm(iso)) || termOf(iso);
const starsOf = (c, t) => (t <= 0 ? 0 : c === t ? 3 : c * 2 >= t ? 2 : 1);
function streakOf(dates, today) {
  let cur = msOf(today);
  if (!dates.has(isoOf(cur))) cur -= DAY;
  let n = 0;
  while (dates.has(isoOf(cur))) { n++; cur -= DAY; }
  return n;
}
const wordStatus = (hist) => (!hist.length ? 'new' : hist.every(Boolean) ? 'solid' : !hist.slice(-2).some(Boolean) ? 'failing' : 'shaky');

/** Local calendar date and wall-clock time in a time zone, via Intl (no tz database shipped). */
export function localParts(date, tz = 'Europe/London') {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date);
  }
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}

// -------------------------------------------------------------------------------- state helpers
export function emptyState() {
  return { v: 1, seq: { kid: 0, week: 0, word: 0, session: 0 }, kids: [], weeks: [], words: [], sessions: [], results: [], meta: { last_export: null } };
}
const cleanLabel = (v) => {
  if (typeof v !== 'string') throw new ApiError(400, 'label must be text');
  const t = v.trim();
  if (t.length < 1 || t.length > MAX_LABEL) throw new ApiError(400, `label must be 1-${MAX_LABEL} characters`);
  return t;
};
const cleanTerm = (v) => {
  if (v == null) return null;
  if (!isTermLabel(v)) throw new ApiError(400, "term must look like '2026 Autumn' or '2026-27 Autumn 2', or null for automatic");
  return v;
};
export const MAX_TERMS_OFF = 60;
/** Optional settings added by feat/school-terms. Returns the keys to store ({} for the defaults); throws ApiError 400. */
function cleanTermSettings(b) {
  const out = {};
  if (b.calendar != null && b.calendar !== 'approx') {
    if (typeof b.calendar !== 'string' || !Object.hasOwn(CALENDARS, b.calendar)) throw new ApiError(400, 'calendar must be approx or one of: ' + Object.keys(CALENDARS).join(', '));
    out.calendar = b.calendar; // absent = approximate
  }
  if (b.terms_off != null) {
    if (!Array.isArray(b.terms_off) || b.terms_off.length > MAX_TERMS_OFF || !b.terms_off.every(isTermLabel)) {
      throw new ApiError(400, 'terms_off must be a short list of terms like 2026-27 Autumn 2');
    }
    if (b.terms_off.length) out.terms_off = [...new Set(b.terms_off)]; // absent = every term on
  }
  return out;
}
export const slugify = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);

// -------------------------------------------------------------------------------------- the store
const chainFor = new WeakMap(); // backend -> tail of its request queue, shared by every store on that backend
export async function createStore(backend, { clock = () => new Date(), tz = 'Europe/London', today: pinnedToday = null, homeUrl = '/', speechFallback = false } = {}) {
  const loaded = await backend.load();
  const state = loaded.state && loaded.state.v === 1 ? loaded.state : emptyState();
  state.meta = state.meta || { last_export: null };
  const todayStr = () => pinnedToday || localParts(clock(), tz).date;
  const nowStr = () => { const p = localParts(clock(), tz); return `${pinnedToday || p.date}T${p.time}`; };
  const save = () => backend.saveState(state);
  const nextId = (kind) => ++state.seq[kind];

  const kidBy = (slug) => { const k = state.kids.find((x) => x.slug === slug); if (!k) throw new ApiError(404, 'unknown kid'); return k; };
  const weekBy = (id) => { const w = state.weeks.find((x) => x.id === id); if (!w) throw new ApiError(404, 'unknown week'); return w; };
  const wordBy = (id) => { const w = state.words.find((x) => x.id === id); if (!w) throw new ApiError(404, 'unknown word'); return w; };
  const wordsOf = (weekId) => state.words.filter((w) => w.week_id === weekId).sort((a, b) => a.position - b.position || a.id - b.id);
  const resultsOf = (wordId) => state.results.filter((r) => r.word_id === wordId).sort((a, b) => a.session_id - b.session_id);

  const wordJson = (w) => ({ id: w.id, position: w.position, label: w.label, has_audio: w.audio_at != null,
    audio_source: w.audio_at != null ? w.audio_source : null });
  // A week's term: the parent's override, else computed from its date under the child's school calendar (on read, so
  // changing the calendar re-groups every stored week and nothing is migrated).
  const settingsOf = (slug) => (state.kids.find((k) => k.slug === slug) || {}).settings || {};
  const weekTerm = (w) => w.term || autoTermOf(w.week_start, settingsOf(w.kid));
  const weekJson = (w) => {
    const auto = autoTermOf(w.week_start, settingsOf(w.kid));
    const near = halfTermNeighbours(auto, 2);
    return { id: w.id, kid: w.kid, week_start: w.week_start, term: weekTerm(w), term_auto: w.term == null, term_default: auto,
      term_options: near.length ? near : [-2, -1, 1, 2].map((d) => termLabel(termIndex(auto) + d)), words: wordsOf(w.id).map(wordJson) };
  };
  const kidJson = (k) => ({ slug: k.slug, name: k.name, year: k.year, settings: { ...k.settings } });

  function isTricky(wordId) {
    const w = wordBy(wordId);
    const last = resultsOf(wordId).filter((r) => r.session_id > (w.cleared_session || 0)).slice(-TRICKY_WINDOW);
    return last.some((r) => r.correct === 0);
  }
  function currentWeekId(slug, today) {
    const mine = state.weeks.filter((w) => w.kid === slug).sort((a, b) => (a.week_start < b.week_start ? -1 : 1));
    const past = mine.filter((w) => w.week_start <= today);
    return past.length ? past[past.length - 1].id : mine.length ? mine[0].id : null;
  }
  /** Words for Big Spell / Tricky: the scope's weeks, minus any term the parent switched off (settings.terms_off). */
  function termWords(slug, today, scope) {
    const settings = settingsOf(slug);
    scope = scope || currentTermOf(today, settings);
    const off = new Set(settings.terms_off || []);
    const weeks = state.weeks.filter((w) => w.kid === slug).sort((a, b) => (a.week_start < b.week_start ? -1 : 1));
    const inScope = YEAR_RE.test(scope) ? (w) => academicYear(weekTerm(w)) === scope : (w) => weekTerm(w) === scope;
    return weeks.filter((w) => inScope(w) && !off.has(weekTerm(w))).flatMap((w) => wordsOf(w.id));
  }
  function sessionRows(slug) { // oldest first, like session_rows(..., "ASC")
    return state.sessions.filter((s) => s.kid === slug).sort((a, b) => a.id - b.id).map((s) => {
      const rs = state.results.filter((r) => r.session_id === s.id);
      return { id: s.id, created_at: s.created_at, mode: s.mode, correct: rs.reduce((n, r) => n + r.correct, 0), total: rs.length };
    });
  }
  const kidStreak = (slug) => streakOf(new Set(state.sessions.filter((s) => s.kid === slug).map((s) => s.created_at.slice(0, 10))), todayStr());

  async function dropWords(ids) {
    const gone = new Set(ids);
    state.words = state.words.filter((w) => !gone.has(w.id));
    state.results = state.results.filter((r) => !gone.has(r.word_id));
    await save(); // state first: an orphan clip is harmless, a word whose clip is gone is not
    await backend.delAudio([...gone]);
  }

  // ---------------------------------------------------------------- endpoints: (match, query, body) -> [status, data]
  const E = {
    async me(m, q) {
      if (!state.kids.length) throw new ApiError(404, 'no children yet');
      const slug = q.get('kid') || state.kids[0].slug;
      return [200, { kid: kidJson(kidBy(slug)), home_url: homeUrl, today: todayStr() }];
    },
    async kids() { return [200, state.kids.map(({ slug, name, year, settings }) => ({ slug, name, year, settings: { ...settings } }))]; },
    async kidAdd(m, q, b) { // new in the local build: the family build seeds its two kids instead
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      if (!name || name.length > 30) throw new ApiError(400, 'name must be 1-30 characters');
      const year = b.year == null ? 1 : b.year;
      if (!Number.isInteger(year) || year < 0 || year > 6) throw new ApiError(400, 'year must be 0 (Reception) to 6');
      let slug = slugify(name) || 'child';
      const base = slug;
      for (let i = 2; state.kids.some((k) => k.slug === slug); i++) slug = `${base}-${i}`;
      const kid = { slug, name, year, settings: { ...DEFAULT_SETTINGS } };
      state.kids.push(kid);
      state.seq.kid++;
      await save();
      return [201, kidJson(kid)];
    },
    async kidPatch(m, q, b) { // rename / change year (#6329); the slug never changes, so URLs, weeks and history stay valid
      const kid = kidBy(m.slug);
      if (!('name' in b) && !('year' in b)) throw new ApiError(400, 'nothing to change: send name and/or year');
      let name = kid.name, year = kid.year;
      if ('name' in b) {
        name = typeof b.name === 'string' ? b.name.trim() : '';
        if (!name || name.length > 30) throw new ApiError(400, 'name must be 1-30 characters');
      }
      if ('year' in b) {
        year = b.year;
        if (!Number.isInteger(year) || year < 0 || year > 6) throw new ApiError(400, 'year must be 0 (Reception) to 6');
      }
      kid.name = name; kid.year = year;
      await save();
      return [200, kidJson(kid)];
    },
    async kidDelete(m) { // (#6329) the child's weeks, words, recordings, sessions and results; nobody else's
      const kid = kidBy(m.slug);
      const weekIds = new Set(state.weeks.filter((w) => w.kid === kid.slug).map((w) => w.id));
      const wordIds = state.words.filter((w) => weekIds.has(w.week_id)).map((w) => w.id);
      const sessionIds = new Set(state.sessions.filter((x) => x.kid === kid.slug).map((x) => x.id));
      state.results = state.results.filter((r) => !sessionIds.has(r.session_id));
      state.sessions = state.sessions.filter((x) => !sessionIds.has(x.id));
      state.weeks = state.weeks.filter((w) => !weekIds.has(w.id));
      state.kids = state.kids.filter((k) => k.slug !== kid.slug);
      await dropWords(wordIds); // words, their results and their audio
      await save();
      return [200, { ok: true }];
    },
    async weeksList(m) {
      kidBy(m.slug);
      return [200, state.weeks.filter((w) => w.kid === m.slug).sort((a, b) => (a.week_start < b.week_start ? -1 : 1)).map(weekJson)];
    },
    async weekCreate(m, q, b) {
      const start = mondayOf(parseDate(b.week_start));
      if (!Array.isArray(b.words) || b.words.length > MAX_WORDS_PER_WEEK) throw new ApiError(400, `words must be a list of at most ${MAX_WORDS_PER_WEEK} labels`);
      const labels = b.words.map(cleanLabel);
      const term = cleanTerm(b.term);
      kidBy(m.slug);
      if (state.weeks.some((w) => w.kid === m.slug && w.week_start === start)) throw new ApiError(409, 'that week already exists');
      const week = { id: nextId('week'), kid: m.slug, week_start: start, term };
      state.weeks.push(week);
      labels.forEach((label, i) => state.words.push({ id: nextId('word'), week_id: week.id, position: i + 1, label, audio_at: null, audio_source: null, cleared_session: null }));
      await save();
      return [201, weekJson(week)];
    },
    async weekDelete(m) {
      const week = weekBy(Number(m.id));
      const ids = wordsOf(week.id).map((w) => w.id);
      state.weeks = state.weeks.filter((w) => w.id !== week.id);
      await dropWords(ids);
      await save();
      return [200, { ok: true }];
    },
    async weekPatch(m, q, b) {
      if (!('term' in b)) throw new ApiError(400, 'nothing to change: send term');
      const term = cleanTerm(b.term);
      const week = weekBy(Number(m.id));
      week.term = term;
      await save();
      return [200, weekJson(week)];
    },
    // Terms that have weeks (plus the current one), newest first. The kid app gets only the terms that are on; the parent
    // page asks for ?all=1 and gets every term with its on/off flag.
    async terms(m, q) {
      const kid = kidBy(m.slug);
      const cur = currentTermOf(todayStr(), kid.settings);
      const off = new Set(kid.settings.terms_off || []);
      const have = new Set([...state.weeks.filter((w) => w.kid === m.slug).map(weekTerm), cur]);
      const shown = [...have].filter((t) => q.get('all') === '1' || !off.has(t)).sort((a, b) => termOrder(b) - termOrder(a));
      const years = [...new Set(shown.map(academicYear))].sort().reverse();
      const multi = years.filter((y) => shown.filter((t) => academicYear(t) === y).length >= 2);
      return [200, { current: cur, calendar: calendarId(kid.settings), terms: shown.map((t) => ({ key: t, label: t, on: !off.has(t) })),
        years: multi.map((y) => ({ key: y, label: `${y} (whole year)` })) }];
    },
    async wordAdd(m, q, b) {
      const label = cleanLabel(b.label);
      const week = weekBy(Number(m.id));
      if (wordsOf(week.id).length >= MAX_WORDS_PER_WEEK) throw new ApiError(400, `a week holds at most ${MAX_WORDS_PER_WEEK} words`);
      const pos = Math.max(0, ...wordsOf(week.id).map((w) => w.position)) + 1;
      const word = { id: nextId('word'), week_id: week.id, position: pos, label, audio_at: null, audio_source: null, cleared_session: null };
      state.words.push(word);
      await save();
      return [201, wordJson(word)];
    },
    async wordPatch(m, q, b) {
      const label = cleanLabel(b.label);
      const word = wordBy(Number(m.id));
      word.label = label;
      await save();
      return [200, wordJson(word)];
    },
    async wordDelete(m) {
      const word = wordBy(Number(m.id));
      await dropWords([word.id]);
      await save();
      return [200, { ok: true }];
    },
    async wordsDelete(m, q, b) { // bulk delete (#6328): all-or-nothing, so one bad id never half-deletes a list
      if (!Array.isArray(b.ids) || !b.ids.length || !b.ids.every((i) => Number.isInteger(i) && i > 0)) throw new ApiError(400, 'ids must be a non-empty list of word ids');
      const ids = [...new Set(b.ids)];
      ids.forEach((i) => wordBy(i)); // 404 before anything changes
      await dropWords(ids);
      await save();
      return [200, { ok: true, deleted: ids.length }];
    },
    async wordKnown(m) {
      const word = wordBy(Number(m.id));
      word.cleared_session = Math.max(0, ...state.sessions.map((s) => s.id));
      await save();
      return [200, { ok: true }];
    },
    async audioPut(m, q, b) { // b = bytes (Uint8Array | ArrayBuffer)
      const id = Number(m.id);
      const data = b instanceof Uint8Array ? b : new Uint8Array(b);
      if (data.length > MAX_AUDIO) throw new ApiError(413, `body too large (limit ${MAX_AUDIO} bytes)`);
      const tag = (o, s) => [...s].every((c, i) => data[o + i] === c.charCodeAt(0));
      if (data.length < 44 || !tag(0, 'RIFF') || !tag(8, 'WAVE')) throw new ApiError(400, 'body must be a WAV file (RIFF....WAVE)');
      const source = q.get('source') || 'child';
      if (source !== 'child' && source !== 'tts') throw new ApiError(400, "source must be 'child' or 'tts'");
      const word = wordBy(id);
      if (source === 'tts' && word.audio_at != null && word.audio_source !== 'tts') {
        throw new ApiError(409, "a child's recording already exists; a synthetic clip never replaces it");
      }
      await backend.putAudio(id, data.slice().buffer);
      word.audio_at = nowStr();
      word.audio_source = source;
      await save();
      return [200, { ok: true, bytes: data.length, audio_source: source }];
    },
    async audioGet(m) {
      const id = Number(m.id);
      wordBy(id);
      const bytes = await backend.getAudio(id);
      if (!bytes) throw new ApiError(404, 'no audio for this word');
      return [200, { type: 'audio/wav', bytes: new Uint8Array(bytes) }];
    },
    async practice(m, q) {
      const mode = q.get('mode') || 'week';
      if (!MODES.includes(mode)) throw new ApiError(400, 'mode must be week, term or tricky');
      const slug = m.slug, today = todayStr();
      kidBy(slug);
      const wq = q.get('week') || '', tq = q.get('term') || '';
      if (tq && mode === 'week') throw new ApiError(400, 'term only applies to the term and tricky modes');
      if (tq && !isTermLabel(tq) && !YEAR_RE.test(tq)) throw new ApiError(400, "term must look like '2026 Autumn', '2026-27 Autumn 2' or '2025-26'");
      let rows;
      if (wq) {
        const week = /^\d+$/.test(wq) ? state.weeks.find((w) => w.id === Number(wq) && w.kid === slug) : null;
        if (!week) throw new ApiError(404, 'unknown week');
        rows = wordsOf(week.id);
        if (q.get('only') === 'tricky') rows = rows.filter((r) => isTricky(r.id));
      } else if (mode === 'week') {
        const wk = currentWeekId(slug, today);
        rows = wk ? wordsOf(wk) : [];
      } else {
        rows = termWords(slug, today, tq || null);
        if (mode === 'tricky') rows = rows.filter((r) => isTricky(r.id));
      }
      // speechFallback (browser build, #4631): a typed word with no recording is still playable; the screen reads it with the en-GB voice.
      const playable = rows.filter((r) => speechFallback || r.audio_at != null).map(wordJson);
      return [200, { words: playable, skipped: rows.length - playable.length }];
    },
    async history(m) {
      const slug = m.slug;
      kidBy(slug);
      const weeks = state.weeks.filter((w) => w.kid === slug).sort((a, b) => (a.week_start < b.week_start ? 1 : -1)).map((w) => {
        const words = wordsOf(w.id).map((r) => {
          const all = resultsOf(r.id);
          const hist = all.slice(-5).map((x) => x.correct);
          return { ...wordJson(r), history: hist, tries: all.length, status: wordStatus(hist), tricky: isTricky(r.id) };
        });
        const ids = new Set(words.map((x) => x.id));
        const sessions = new Set(state.results.filter((r) => ids.has(r.word_id)).map((r) => r.session_id)).size;
        return { id: w.id, week_start: w.week_start, sessions, tricky: words.filter((x) => x.tricky).length, words };
      });
      return [200, { weeks, current: currentWeekId(slug, todayStr()) }];
    },
    async settings(m, q, b) {
      const ok = SPEEDS.includes(b.speed) && [1, 2, 3].includes(b.repeats) && PAUSES.includes(b.pause) && ORDERS.includes(b.order);
      if (!ok) throw new ApiError(400, 'settings need speed (slow|normal|fast), repeats (1-3), pause (short|long), order (mix|inorder)');
      const kid = kidBy(m.slug);
      if (b.voice != null && !validVoiceName(b.voice)) throw new ApiError(400, 'voice must be a short name or empty');
      const termSettings = cleanTermSettings(b); // validate before anything changes
      kid.settings = { speed: b.speed, repeats: b.repeats, pause: b.pause, order: b.order };
      if (b.voice) kid.settings.voice = b.voice; // optional: the chosen en-GB speech voice (absent = automatic)
      if (b.typeMode === true) kid.settings.typeMode = true; // optional experimental flag (#5604); absent = off
      Object.assign(kid.settings, cleanKidFlags(b)); // grown-up switches (kidopts.js); absent = today's behaviour
      Object.assign(kid.settings, termSettings); // optional: school calendar + term switches (absent = approximate, all on)
      await save();
      return [200, { ...kid.settings }];
    },
    async sessionCreate(m, q, b) {
      const slug = m.slug;
      if (!MODES.includes(b.mode)) throw new ApiError(400, 'mode must be week, term or tricky');
      if (!Array.isArray(b.results) || !b.results.length || b.results.length > 500) throw new ApiError(400, 'results must be a non-empty list');
      const settings = b.settings && typeof b.settings === 'object' && !Array.isArray(b.settings) ? b.settings : {};
      const seen = new Set(), clean = [];
      for (const r of b.results) {
        const wid = r && typeof r === 'object' ? r.word_id : null;
        if (!Number.isInteger(wid) || wid <= 0) throw new ApiError(400, 'each result needs an integer word_id');
        if (![0, 1, true, false].includes(r.correct)) throw new ApiError(400, 'correct must be 0 or 1');
        if (seen.has(wid)) throw new ApiError(400, 'duplicate word_id in results');
        seen.add(wid);
        clean.push([wid, Number(r.correct)]);
      }
      kidBy(slug);
      const mine = new Set(state.weeks.filter((w) => w.kid === slug).map((w) => w.id));
      for (const [wid] of clean) {
        const w = state.words.find((x) => x.id === wid);
        if (!w || !mine.has(w.week_id)) throw new ApiError(400, `word ${wid} does not belong to this kid`);
      }
      const session = { id: nextId('session'), kid: slug, created_at: nowStr(), mode: b.mode, settings };
      state.sessions.push(session);
      for (const [word_id, correct] of clean) state.results.push({ session_id: session.id, word_id, correct });
      await save();
      const correct = clean.reduce((n, [, c]) => n + c, 0);
      return [201, { score: correct, total: clean.length, stars: starsOf(correct, clean.length), streak: kidStreak(slug) }];
    },
    async progress(m) {
      kidBy(m.slug);
      const rows = sessionRows(m.slug);
      return [200, { stars: rows.reduce((n, r) => n + starsOf(r.correct, r.total), 0), streak: kidStreak(m.slug),
        sessions: rows.slice(-14).map(({ created_at, mode, correct, total }) => ({ created_at, mode, correct, total })) }];
    },
    async report() {
      const today = todayStr();
      const out = {};
      for (const kid of [...state.kids].sort((a, b) => (a.slug < b.slug ? -1 : 1))) {
        const weeks = state.weeks.filter((w) => w.kid === kid.slug).sort((a, b) => (a.week_start < b.week_start ? -1 : 1)).map((w) => {
          const ids = new Set(wordsOf(w.id).map((x) => x.id));
          const rs = state.results.filter((r) => ids.has(r.word_id));
          const correct = rs.reduce((n, r) => n + r.correct, 0);
          return { id: w.id, week_start: w.week_start, correct, total: rs.length, pct: rs.length ? Math.round((100 * correct) / rs.length) : 0 };
        });
        const missed = [];
        for (const w of termWords(kid.slug, today, null)) {
          const rs = resultsOf(w.id);
          const miss = rs.filter((r) => r.correct === 0).length;
          if (rs.length && miss) missed.push({ label: w.label, missed: miss, tried: rs.length });
        }
        missed.sort((a, b) => b.missed - a.missed || (a.label < b.label ? -1 : 1));
        const recent = sessionRows(kid.slug).slice(-10).reverse().map(({ created_at, mode, correct, total }) => ({ created_at, mode, correct, total }));
        out[kid.slug] = { weeks, most_missed: missed.slice(0, 10), recent };
      }
      return [200, out];
    },
  };

  const S = '(?<slug>[a-z0-9_-]+)';
  const ROUTES = [
    ['GET', '/api/me', E.me], ['GET', '/api/kids', E.kids], ['POST', '/api/kids', E.kidAdd],
    ['PATCH', `/api/kids/${S}`, E.kidPatch], ['DELETE', `/api/kids/${S}`, E.kidDelete],
    ['GET', `/api/kids/${S}/weeks`, E.weeksList], ['POST', `/api/kids/${S}/weeks`, E.weekCreate],
    ['DELETE', '/api/weeks/(?<id>\\d+)', E.weekDelete], ['PATCH', '/api/weeks/(?<id>\\d+)', E.weekPatch],
    ['GET', `/api/kids/${S}/terms`, E.terms], ['POST', '/api/weeks/(?<id>\\d+)/words', E.wordAdd],
    ['PATCH', '/api/words/(?<id>\\d+)', E.wordPatch], ['DELETE', '/api/words/(?<id>\\d+)', E.wordDelete],
    ['POST', '/api/words/delete', E.wordsDelete], ['POST', '/api/words/(?<id>\\d+)/known', E.wordKnown], ['PUT', '/api/words/(?<id>\\d+)/audio', E.audioPut],
    ['GET', '/api/words/(?<id>\\d+)/audio', E.audioGet], ['GET', `/api/kids/${S}/practice`, E.practice],
    ['GET', `/api/kids/${S}/history`, E.history], ['PUT', `/api/kids/${S}/settings`, E.settings],
    ['POST', `/api/kids/${S}/sessions`, E.sessionCreate], ['GET', `/api/kids/${S}/progress`, E.progress],
    ['GET', '/api/report', E.report],
  ].map(([method, pat, fn]) => [method, new RegExp(`^${pat}$`), fn]);

  // Requests run one at a time, like the server's per-request transaction: no interleaved writes.
  // The queue is shared by every store on the same backend (two tabs in one process), so a per-store queue cannot
  // let two stores load the same state and overwrite each other; backend.exclusive (a cross-tab lock) additionally
  // orders them against other tabs, so the reload below and the save at the end of the route are one critical section
  // (no lost writes, no duplicate ids).
  const exclusive = (fn) => (backend.exclusive ? backend.exclusive(fn) : fn());
  function request(method, path, body) {
    const run = () => exclusive(async () => {
      // Another tab (kid app + parent page) may have written since our last request: start from what is stored.
      const fresh = (await backend.load()).state;
      if (fresh && fresh.v === 1) { Object.keys(state).forEach((k) => delete state[k]); Object.assign(state, fresh); }
      const url = new URL(path, 'http://local');
      for (const [meth, re, fn] of ROUTES) {
        if (meth !== method) continue;
        const m = re.exec(url.pathname);
        if (m) {
          const [status, data] = await fn(m.groups || {}, url.searchParams, body == null ? {} : body);
          return { status, data };
        }
      }
      throw new ApiError(404, 'not found');
    });
    const prev = chainFor.get(backend) || Promise.resolve();
    const p = prev.then(run);
    chainFor.set(backend, p.catch(() => {}));
    return p;
  }

  // ------------------------------------------------------------------ export / import (pack.js shape)
  /** Plain snapshot for pack.js buildPack, plus audio keyed 'audio/<n>.wav'. kid = slug limits it to one child. */
  async function snapshot(kid = null) {
    const kids = state.kids.filter((k) => !kid || k.slug === kid);
    const slugs = new Set(kids.map((k) => k.slug));
    const audio = {};
    const weeks = [];
    for (const w of state.weeks.filter((x) => slugs.has(x.kid)).sort((a, b) => (a.week_start < b.week_start ? -1 : 1))) {
      const words = [];
      for (const word of wordsOf(w.id)) {
        let name = null;
        const bytes = word.audio_at != null ? await backend.getAudio(word.id) : null;
        if (bytes) { name = `audio/${word.id}.wav`; audio[name] = new Uint8Array(bytes); }
        const rec = { label: word.label, position: word.position, audio: name };
        if (name && word.audio_source === 'tts') rec.audio_source = 'tts'; // read-aloud clip, not the child's voice (absent = child)
        // "I know it" marker: portable as the timestamp of the session it was cleared at (ids are re-issued on import).
        const clearedAt = state.sessions.find((x) => x.id === word.cleared_session);
        if (clearedAt) rec.cleared_at = clearedAt.created_at;
        words.push(rec);
      }
      weeks.push({ kid: w.kid, week_start: w.week_start, term: w.term, words });
    }
    const labelOf = new Map(state.words.map((x) => [x.id, x]));
    const weekOf = new Map(state.weeks.map((x) => [x.id, x]));
    const sessions = state.sessions.filter((s) => slugs.has(s.kid)).map((s) => ({
      kid: s.kid, created_at: s.created_at, mode: s.mode, settings: s.settings,
      results: state.results.filter((r) => r.session_id === s.id).map((r) => {
        const word = labelOf.get(r.word_id);
        return { week_start: weekOf.get(word.week_id).week_start, label: word.label, correct: r.correct };
      }),
    }));
    return { snapshot: { kids: kids.map(kidJson), weeks, sessions }, audio };
  }

  /** Replace the whole store with a snapshot (as produced by pack.js mergePack). Ids are re-issued. */
  async function replaceFromSnapshot(snap, audio = {}) {
    const next = emptyState();
    next.meta = { ...state.meta };
    for (const k of snap.kids) {
      next.kids.push({ slug: k.slug, name: k.name, year: k.year, settings: { ...DEFAULT_SETTINGS, ...(k.settings || {}) } });
      next.seq.kid++;
    }
    const bytesById = {};
    const idOf = new Map();
    for (const w of snap.weeks) {
      const week = { id: ++next.seq.week, kid: w.kid, week_start: w.week_start, term: w.term || null };
      next.weeks.push(week);
      for (const word of w.words) {
        const rec = { id: ++next.seq.word, week_id: week.id, position: word.position, label: word.label, audio_at: null, audio_source: null, cleared_session: null };
        rec.cleared_at = word.cleared_at || null;
        if (word.audio && audio[word.audio]) { rec.audio_at = nowStr(); rec.audio_source = word.audio_source === 'tts' ? 'tts' : 'child'; bytesById[rec.id] = audio[word.audio]; }
        next.words.push(rec);
        idOf.set(`${w.kid}|${w.week_start}|${word.label.trim().toLowerCase()}`, rec.id);
      }
    }
    // Issue ids in chronological order whatever order the snapshot lists sessions in (#4526): ids encode
    // recency for history and for the tricky-word logic. Stable sort keeps equal stamps in file order.
    const ordered = [...snap.sessions].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
    for (const s of ordered) {
      const session = { id: ++next.seq.session, kid: s.kid, created_at: s.created_at, mode: s.mode, settings: s.settings || {} };
      next.sessions.push(session);
      for (const r of s.results) {
        const wid = idOf.get(`${s.kid}|${r.week_start}|${r.label.trim().toLowerCase()}`);
        if (wid) next.results.push({ session_id: session.id, word_id: wid, correct: r.correct ? 1 : 0 });
      }
    }
    // Re-map each "I know it" marker onto the newest imported session at or before its timestamp.
    for (const rec of next.words) {
      if (rec.cleared_at) rec.cleared_session = Math.max(0, ...next.sessions.filter((x) => x.created_at <= rec.cleared_at).map((x) => x.id)) || null;
      delete rec.cleared_at;
    }
    await backend.replaceAll(next, bytesById);
    Object.keys(state).forEach((k) => delete state[k]);
    Object.assign(state, next);
  }

  /**
   * Erase everything on this device: kids, weeks, words, recordings, sessions, results and meta (including last_export).
   * Irreversible, so it does nothing unless called as eraseAll({ confirmed: true }); the parent screen gets there
   * through a two-step confirm that first offers Export. Returns true when it erased, false when it was not confirmed.
   */
  async function eraseAll(opts = {}) {
    if (!opts || opts.confirmed !== true) return false;
    const next = emptyState();
    await backend.replaceAll(next, {});
    Object.keys(state).forEach((k) => delete state[k]);
    Object.assign(state, next);
    return true;
  }

  return {
    request, snapshot, replaceFromSnapshot, eraseAll,
    getMeta: () => ({ ...state.meta }),
    async setMeta(patch) { Object.assign(state.meta, patch); await save(); },
    hasData: () => state.words.length > 0,
    now: () => clock(),
  };
}

// ----------------------------------------------------------------------------------------- backends
/** In-memory backend for tests; `persisted` shows what a reload would see. */
export function memoryBackend(initial = null) {
  let lock = Promise.resolve(); // stands in for navigator.locks: stores sharing this backend object take turns
  let saved = initial ? structuredClone(initial.state) : null;
  const audio = new Map(initial ? Object.entries(initial.audio || {}).map(([k, v]) => [Number(k), v]) : []);
  return {
    exclusive(fn) { const p = lock.then(fn); lock = p.catch(() => {}); return p; },
    async load() { return { state: saved ? structuredClone(saved) : null, audio: Object.fromEntries(audio) }; },
    async saveState(s) { saved = structuredClone(s); },
    async putAudio(id, bytes) { audio.set(id, bytes); },
    async getAudio(id) { return audio.get(id) || null; },
    async delAudio(ids) { for (const id of ids) audio.delete(id); },
    async replaceAll(s, bytesById) {
      saved = structuredClone(s);
      audio.clear();
      for (const [id, b] of Object.entries(bytesById)) audio.set(Number(id), b instanceof Uint8Array ? b.slice().buffer : b);
    },
    persisted: () => ({ state: saved, audio: Object.fromEntries(audio) }),
  };
}

/** IndexedDB backend: database 'spellings', stores 'state' (one record, key 'main') and 'audio' (key = word id). */
export function idbBackend(idb = globalThis.indexedDB, name = 'spellings') {
  const open = () => new Promise((resolve, reject) => {
    const req = idb.open(name, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('state'); req.result.createObjectStore('audio'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Could not open local storage'));
  });
  let dbp = null;
  const db = () => (dbp ||= open());
  const tx = async (stores, mode, fn) => {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(stores, mode);
      let out;
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Local storage write failed'));
      out = fn(t);
    });
  };
  const get = (store, key) => new Promise((resolve, reject) => { const r = store.get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  return {
    // One lock per database name, shared by every tab of this origin; without Web Locks fall back to no cross-tab lock.
    exclusive: (fn) => (globalThis.navigator?.locks ? globalThis.navigator.locks.request(`${name}-store`, fn) : fn()),
    async load() {
      const d = await db();
      const state = await new Promise((resolve, reject) => { const r = d.transaction('state').objectStore('state').get('main'); r.onsuccess = () => resolve(r.result || null); r.onerror = () => reject(r.error); });
      return { state, audio: {} }; // audio is read lazily by getAudio
    },
    saveState: (s) => tx(['state'], 'readwrite', (t) => { t.objectStore('state').put(s, 'main'); }),
    putAudio: (id, bytes) => tx(['audio'], 'readwrite', (t) => { t.objectStore('audio').put(bytes, id); }),
    async getAudio(id) { const d = await db(); return (await get(d.transaction('audio').objectStore('audio'), id)) || null; },
    delAudio: (ids) => tx(['audio'], 'readwrite', (t) => { for (const id of ids) t.objectStore('audio').delete(id); }),
    replaceAll: (s, bytesById) => tx(['state', 'audio'], 'readwrite', (t) => {
      t.objectStore('audio').clear();
      for (const [id, b] of Object.entries(bytesById)) t.objectStore('audio').put(b instanceof Uint8Array ? b.slice().buffer : b, Number(id));
      t.objectStore('state').put(s, 'main');
    }),
  };
}
