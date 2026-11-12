// share.js - share a word list as a link (Vikunja #3543). Parent-to-parent only.
// The list travels in the URL FRAGMENT (`#sl=1&t=<title>&w=<word>&w=<word>...`), which browsers never
// send to a server, so no server sees the words. The link carries words (and an optional short title)
// only: never recordings, scores or a child's name. Pure functions, no DOM: node tests cover them.

export const MAX_WORDS = 60;
export const MAX_WORD_LEN = 40;
const MAX_TITLE_LEN = 40;
const PARAM = 'sl'; // marker + format version: "#sl=1&..."

/** Keep letters (any script), apostrophes, hyphens and inner spaces; collapse whitespace; cap length. */
export function cleanWord(raw) {
  const s = String(raw ?? '').normalize('NFC').replace(/[^\p{L}\p{M}'’\- ]/gu, '').replace(/\s+/g, ' ').trim();
  return s.slice(0, MAX_WORD_LEN).trim();
}

/** A title may also hold digits and light punctuation ("Week 3", "Spring term"), never markup characters. */
export function cleanTitle(raw) {
  return String(raw ?? '').normalize('NFC').replace(/[^\p{L}\p{M}\p{N}'’\-.,:() ]/gu, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LEN).trim();
}

/** Clean a list: drop empties and case-insensitive duplicates, cap at MAX_WORDS. */
export function cleanWords(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list || []) {
    const w = cleanWord(raw);
    const key = w.toLowerCase();
    if (!w || seen.has(key)) continue;
    seen.add(key);
    out.push(w);
    if (out.length >= MAX_WORDS) break;
  }
  return out;
}

/** The fragment (without the leading '#') for a list, or '' if there are no usable words. */
export function encodeShare(words, title = '') {
  const clean = cleanWords(words);
  if (!clean.length) return '';
  const p = new URLSearchParams();
  p.set(PARAM, '1');
  const t = cleanTitle(title);
  if (t) p.set('t', t);
  for (const w of clean) p.append('w', w);
  return p.toString();
}

/** Full link: page URL (any existing hash dropped) + '#' + fragment. '' if nothing to share. */
export function buildShareLink(pageUrl, words, title = '') {
  const frag = encodeShare(words, title);
  if (!frag) return '';
  return `${String(pageUrl).split('#')[0]}#${frag}`;
}

/** Parse location.hash (with or without '#'). Returns {words, title} or null if it is not a share link.
 *  Everything is re-cleaned: a hand-edited link can never inject markup or oversized lists. */
export function parseShare(hash) {
  let p;
  try { p = new URLSearchParams(String(hash || '').replace(/^#/, '')); } catch { return null; }
  if (p.get(PARAM) !== '1') return null;
  const words = cleanWords(p.getAll('w'));
  if (!words.length) return null;
  return { words, title: cleanTitle(p.get('t')) };
}
