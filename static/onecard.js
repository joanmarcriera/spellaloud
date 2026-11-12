// onecard.js - M-B "one-card" marking for Ash, OFF by default (Vikunja #3521; out of scope for v0.1, spec.md).
// Pure state, no DOM. One word fills the screen; Got it / Not yet marks it and moves to the next unmarked card.
//
// Usage:
//   if (onecardEnabled(location.search, localStorage)) { let st = cardState(words, marks); st = cardMark(st, id, 1); }
// Flag: ?onecard=1 in the URL, or localStorage 'spellings.onecard.enabled' = '1'. Anything else = off.

export const ONECARD_FLAG_KEY = 'spellings.onecard.enabled';

/** Flag check; storage may throw (private mode) which counts as off. */
export function onecardEnabled(search = '', storage = null) {
  try { if (new URLSearchParams(search).get('onecard') === '1') return true; } catch { /* ignore */ }
  try { return !!storage && storage.getItem(ONECARD_FLAG_KEY) === '1'; } catch { return false; }
}

/** State: ids in play order, marks (id -> 1|0), and the current index (first unmarked, else the last card). */
export function cardState(words, marks = {}) {
  const ids = words.map((w) => w.id);
  const m = {};
  for (const id of ids) if (marks[id] === 0 || marks[id] === 1) m[id] = marks[id];
  const first = ids.findIndex((id) => !(id in m));
  return { ids, marks: m, index: first === -1 ? Math.max(0, ids.length - 1) : first };
}

/** Mark a card and advance to the next unmarked one (stay put when all are marked). Returns a new state. */
export function cardMark(st, id, value) {
  if (!st.ids.includes(id) || (value !== 0 && value !== 1)) return st;
  const marks = { ...st.marks, [id]: value };
  const n = st.ids.length;
  for (let k = 1; k <= n; k++) {
    const i = (st.index + k) % n;
    if (!(st.ids[i] in marks)) return { ids: st.ids, marks, index: i };
  }
  return { ids: st.ids, marks, index: st.index };
}

/** Step to the previous/next card without marking (Back / Skip). Clamped to the list. */
export function cardStep(st, dir) {
  const index = Math.min(st.ids.length - 1, Math.max(0, st.index + (dir < 0 ? -1 : 1)));
  return { ...st, index };
}

export const cardDone = (st) => st.ids.every((id) => id in st.marks);
export const cardProgress = (st) => ({ marked: Object.keys(st.marks).length, total: st.ids.length });
