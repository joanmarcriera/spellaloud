// lib.js - pure helpers shared by the kid app (browser) and node tests.
// No DOM, no Web Audio: everything here works on plain arrays / typed arrays.

/** Playback speed and pause lookups used by the kid app and settings validation. */
// slow was 0.75, which kids heard as "the same as normal" (#6672); 0.55 is clearly slower and still clean with preservesPitch.
export const SPEEDS = { slow: 0.55, normal: 1.0, fast: 1.25 };
/** Review list: two columns only when there are more rows than fit one column comfortably (#6673). */
export const MARK_TWO_COL_MIN = 8;
export function markLayout(n) { const cols = n >= MARK_TWO_COL_MIN ? 2 : 1; return { cols, rows: Math.ceil(n / cols) }; }
export const PAUSES = { short: 5, long: 10 };

/** Average several channels (Float32Array[]) into one mono Float32Array. */
export function mixToMono(channels) {
  if (channels.length === 1) return Float32Array.from(channels[0]);
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i];
  for (let i = 0; i < n; i++) out[i] /= channels.length;
  return out;
}

/**
 * Cut leading/trailing silence. A sample counts as sound when |x| >= threshold.
 * Keeps leadMs of audio before the first sound and padMs after the last (clamped to
 * the buffer); leadMs defaults to padMs. A soft opening consonant (the s in "spoil")
 * can sit below the threshold, so callers keep a longer lead. Returns an empty
 * array when nothing exceeds the threshold, so callers can say "I heard nothing".
 */
export function trimSilence(samples, sampleRate, { threshold = 0.02, padMs = 150, leadMs = padMs } = {}) {
  let first = -1;
  let last = -1;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) >= threshold) { first = i; break; }
  }
  if (first < 0) return new Float32Array(0);
  for (let i = samples.length - 1; i >= first; i--) {
    if (Math.abs(samples[i]) >= threshold) { last = i; break; }
  }
  const pad = Math.round((padMs / 1000) * sampleRate);
  const start = Math.max(0, first - Math.round((leadMs / 1000) * sampleRate));
  const end = Math.min(samples.length, last + 1 + pad);
  return samples.slice(start, end);
}

/** Encode Float32 samples (-1..1) as a 16-bit PCM mono WAV. Returns an ArrayBuffer. */
export function encodeWav(samples, sampleRate) {
  const dataLen = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  dv.setUint32(4, 36 + dataLen, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);          // fmt chunk size
  dv.setUint16(20, 1, true);           // PCM
  dv.setUint16(22, 1, true);           // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true); // byte rate
  dv.setUint16(32, 2, true);           // block align
  dv.setUint16(34, 16, true);          // bits per sample
  str(36, 'data');
  dv.setUint32(40, dataLen, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

/** mulberry32: tiny seeded PRNG returning floats in [0,1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates with a seeded PRNG. Returns a new array. */
export function seededShuffle(arr, seed) {
  const out = arr.slice();
  const rnd = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Build the play schedule. order: 'mix' (seeded shuffle) | 'inorder'.
 * Returns { words: playedOrder, steps: [{word, index, repeat, repeats}] } where
 * `index` is the position in the played order and `repeat` is 0-based.
 */
export function buildSchedule(words, { repeats = 1, order = 'inorder', seed = 1 } = {}) {
  const played = order === 'mix' ? seededShuffle(words, seed) : words.slice();
  const steps = [];
  played.forEach((word, index) => {
    for (let repeat = 0; repeat < repeats; repeat++) steps.push({ word, index, repeat, repeats });
  });
  return { words: played, steps };
}

/** Stars per session: 3 if 100%, 2 if >= 50%, else 1 (0 for an empty session). */
export function starsFor(correct, total) {
  if (total <= 0) return 0;
  if (correct === total) return 3;
  return correct * 2 >= total ? 2 : 1;
}

/** Whole-number percentage, 0 when total is 0. */
export function pctFor(correct, total) {
  return total > 0 ? Math.round((correct / total) * 100) : 0;
}

/** Consecutive-day streak from ISO dates (YYYY-MM-DD), ending today or yesterday. */
export function streakFor(dates, today) {
  const set = new Set(dates);
  const day = (iso) => Date.parse(iso + 'T00:00:00Z');
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  let cur = day(today);
  if (!set.has(iso(cur))) cur -= 86400000;
  let n = 0;
  while (set.has(iso(cur))) { n++; cur -= 86400000; }
  return n;
}

/** Per-device size multiplier (see style.css --scale). Stored under localStorage 'spellings.scale'. */
export const SCALE_MIN = 0.6;
export const SCALE_MAX = 1.6;
export const SCALE_KEY = 'spellings.scale';

/** Parse a ?scale= / stored value: a finite number clamped to 0.6..1.6, or null if unusable. */
export function parseScale(v) {
  if (v == null || !/^\s*\d*\.?\d+\s*$/.test(String(v))) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(SCALE_MAX, Math.max(SCALE_MIN, n)) : null;
}

/** Step the scale by 10% (dir = +1 / -1), rounded to one decimal, kept in range. */
export function stepScale(cur, dir) {
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round((cur + dir * 0.1) * 10) / 10));
}

/**
 * Where a first-time parent is in setup (Vikunja #4632): 'add-child' (no children), 'add-words'
 * (children but no week with words yet) or 'ready' (can play). `kids` = [{slug,...}], `weeks` = every
 * week of every child, each with a `words` array (or `word_count`).
 */
export function setupStep(kids, weeks) {
  if (!Array.isArray(kids) || kids.length === 0) return 'add-child';
  const has = (weeks || []).some((w) => (Array.isArray(w.words) ? w.words.length : w.word_count || 0) > 0);
  return has ? 'ready' : 'add-words';
}

/** Longest word label the server accepts (server.py MAX_LABEL). */
export const MAX_LABEL = 40;

/** Most words one week may hold (server.py MAX_WORDS_PER_WEEK, store.js). */
export const MAX_WORDS = 100;

/**
 * Turn the text a parent typed or pasted into clean word labels.
 * Splits on newlines, commas, semicolons and tabs; strips leading list markers ("1.", "2)", "-", "•", "*");
 * drops case-insensitive duplicates (first spelling wins). Over-long entries are returned in `tooLong`
 * instead of `words`, so the caller can say so rather than have the server reject the whole week.
 * @returns {{words: string[], duplicates: number, tooLong: string[]}}
 */
export function parseWordList(text) {
  const out = { words: [], duplicates: 0, tooLong: [] };
  if (typeof text !== 'string') return out;
  const seen = new Set();
  const add = (cell) => {
    // A marker needs a following space (or is a real bullet glyph), so "100", "-ing" and "2-door" stay words.
    const w = cell.replace(/^\s*(?:\d+[.)]\s+|[-*]\s+|[•·–]\s*)/, '').trim().normalize('NFC');
    if (!w) return;
    if (w.length > MAX_LABEL) { out.tooLong.push(w); return; }
    const k = w.toLowerCase();
    if (seen.has(k)) { out.duplicates++; return; }
    seen.add(k);
    out.words.push(w);
  };
  for (const line of text.split(/\r\n|\r|\n/)) {
    const cells = line.split(/[,;\t]/);
    // Table paste: a lone "1", "2." or "a)" in the first cell is a number column, not a word.
    if (cells.length > 1 && /^\s*(?:\d+[.)]?|[a-z]\))\s*$/i.test(cells[0]) && line.includes('\t')) cells.shift();
    cells.forEach(add);
  }
  return out;
}

/** ISO date (YYYY-MM-DD) of the Monday of `from`'s week (a Sunday gives the Monday six days before): offset 0 = this week's Monday, 1 = next week's (#6665). */
export function mondayISO(from = new Date(), offsetWeeks = 0) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 7 * offsetWeeks);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Add a child and, when words were typed, their first week (Vikunja #6335). The two calls are separate, so the
 * child can exist while the words fail (too many, bad label). Returns `{ kid, weekError }`: `weekError` is the
 * message when only the words failed, so the caller refreshes the page (the child exists; tapping "Add" again
 * would create a duplicate) and tells the parent to add the words from the child's card. A failure creating the
 * child itself throws. `api(method, path, body)` is the parent page's fetch wrapper.
 */
export async function addChildWithWords(api, { name, year, words, weekStart }) {
  const kid = await api('POST', '/api/kids', { name, year: Number(year) });
  if (!words || !words.length) return { kid, weekError: null };
  try {
    await api('POST', '/api/kids/' + kid.slug + '/weeks', { week_start: weekStart, words });
    return { kid, weekError: null };
  } catch (e) {
    return { kid, weekError: (e && e.message) || 'the words were not saved' };
  }
}

/**
 * A week's Monday ("2026-11-02") as a child-friendly "Mon 2 Nov". The parts are joined by hand, so the
 * result does not depend on the device's locale (Android WebView puts a comma after the weekday, others do not).
 * A string that is not a date is returned unchanged.
 */
export function weekLabel(iso) {
  const d = new Date(iso + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return iso;
  const part = (opt) => d.toLocaleDateString('en-GB', opt);
  return `${part({ weekday: 'short' })} ${d.getDate()} ${part({ month: 'short' })}`;
}
