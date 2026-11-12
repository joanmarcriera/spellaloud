// backup.js - glue between the local store (store.js) and the one-file pack (pack.js): the logic behind the
// parent area's "Back up / move to another device" panel (Vikunja #3534). No DOM here, so node tests can drive it.
//   exportBackup(store, {kid, env})  builds the file and hands it to the share sheet or a download
//   previewImport(store, bytes, mode) parses a file and says what would change, writing nothing
//   applyImport(store, preview)       writes it
// The £2.99 licence gate (#3536) is deliberately not here: the UI decides whether Export is enabled.

import { buildPack, parsePack, mergePack, packFilename, deliverPack, describeSummary } from './pack.js';
import { validVoiceName } from './voice.js';
import { MAX_AUDIO, MAX_LABEL, MAX_WORDS_PER_WEEK, MAX_TERMS_OFF, mondayOf } from './store.js';
import { CALENDARS, isTermLabel } from './terms.js';

/** Export one child (slug) or everyone (kid = null). Returns {outcome:'shared'|'downloaded'|'cancelled', filename}. */
export async function exportBackup(store, { kid = null, env = globalThis } = {}) {
  const { snapshot, audio } = await store.snapshot(kid);
  const bytes = buildPack(snapshot, audio, { now: store.now().toISOString() });
  const name = kid ? (snapshot.kids[0] && snapshot.kids[0].name) : 'family';
  const filename = packFilename(name, store.now());
  const outcome = await deliverPack(bytes, filename, env);
  if (outcome !== 'cancelled') await store.setMeta({ last_export: store.now().toISOString() });
  return { outcome, filename };
}

const SLUG_RE = /^[a-z0-9_-]{1,30}$/;
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const SETTING_VALUES = { speed: ['slow', 'normal', 'fast'], repeats: [1, 2, 3], pause: ['short', 'long'], order: ['mix', 'inorder'] };
const isDate = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const ms = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === s; // rejects 2026-02-30 too
};
const isLabel = (s) => typeof s === 'string' && s.trim().length >= 1 && s.trim().length <= MAX_LABEL;

/**
 * A pack file is untrusted input (it travels by WhatsApp or email), so check it with the same rules the
 * request API applies before anything is merged or written. Throws a friendly Error naming the problem class.
 * `audio` maps clip names to bytes (already checked for presence by parsePack).
 */
export function validateSnapshot(snap, audio = {}) {
  const bad = (why) => { throw new Error(`This file cannot be imported (${why}).`); };
  const kids = new Set();
  for (const k of snap.kids) {
    if (!k || typeof k !== 'object') bad('a child entry is damaged');
    if (typeof k.slug !== 'string' || !SLUG_RE.test(k.slug) || kids.has(k.slug)) bad('a child has an invalid or repeated id');
    if (typeof k.name !== 'string' || k.name.trim().length < 1 || k.name.length > 30) bad('a child name is invalid');
    if (!Number.isInteger(k.year) || k.year < 0 || k.year > 6) bad('a school year is invalid');
    const s = k.settings == null ? {} : k.settings;
    if (typeof s !== 'object' || Array.isArray(s)) bad('settings are invalid');
    for (const [key, v] of Object.entries(s)) {
      if (key === 'typeMode') { if (v !== true && v !== false) bad('settings are invalid'); continue; } // #5604 experimental flag
      if (key === 'calendar') { if (typeof v !== 'string' || !Object.hasOwn(CALENDARS, v)) bad('settings are invalid'); continue; } // school calendar
      if (key === 'terms_off') { if (!Array.isArray(v) || v.length > MAX_TERMS_OFF || !v.every(isTermLabel)) bad('settings are invalid'); continue; } // terms switched off
      if (key === 'voice' ? !validVoiceName(v) : !(key in SETTING_VALUES) || !SETTING_VALUES[key].includes(v)) bad('settings are invalid');
    }
    kids.add(k.slug);
  }
  const seenWeeks = new Set();
  for (const w of snap.weeks) {
    if (!w || typeof w !== 'object' || !kids.has(w.kid)) bad('a week belongs to an unknown child');
    if (!isDate(w.week_start) || mondayOf(w.week_start) !== w.week_start || w.week_start < '2000' || w.week_start > '2101') bad('a week date is invalid');
    if (w.term != null && !isTermLabel(w.term)) bad('a term is invalid');
    if (seenWeeks.has(`${w.kid}|${w.week_start}`)) bad('a week appears twice');
    seenWeeks.add(`${w.kid}|${w.week_start}`);
    if (!Array.isArray(w.words) || w.words.length > MAX_WORDS_PER_WEEK) bad('a week has too many words');
    for (const word of w.words) {
      if (!word || !isLabel(word.label)) bad('a word is empty or too long');
      if (word.position != null && !Number.isInteger(word.position)) bad('a word position is invalid');
      if (word.cleared_at != null && !(typeof word.cleared_at === 'string' && word.cleared_at.length <= 32)) bad('a word marker is invalid');
      if (word.audio != null) {
        const clip = audio[word.audio];
        const tag = (o, s) => [...s].every((c, i) => clip[o + i] === c.charCodeAt(0));
        if (typeof word.audio !== 'string' || !(clip instanceof Uint8Array)) bad('a recording is missing');
        if (clip.length > MAX_AUDIO) bad('a recording is too large');
        if (clip.length < 44 || !tag(0, 'RIFF') || !tag(8, 'WAVE')) bad('a recording is not a WAV file');
      }
    }
  }
  for (const s of snap.sessions) {
    if (!s || typeof s !== 'object' || !kids.has(s.kid)) bad('a practice session belongs to an unknown child');
    if (typeof s.created_at !== 'string' || !STAMP_RE.test(s.created_at) || !isDate(s.created_at.slice(0, 10))) bad('a session date is invalid');
    if (!['week', 'term', 'tricky'].includes(s.mode)) bad('a session mode is invalid');
    if (s.settings != null && (typeof s.settings !== 'object' || Array.isArray(s.settings))) bad('session settings are invalid');
    if (!Array.isArray(s.results) || s.results.length > 500) bad('a session has too many results');
    for (const r of s.results) {
      if (!r || !isDate(r.week_start) || !isLabel(r.label) || ![0, 1, true, false].includes(r.correct)) bad('a result is invalid');
    }
  }
}

/** Parse + merge without writing. `mode` = 'merge' (default) | 'replace'. Throws a friendly Error for a bad file. */
export async function previewImport(store, bytes, mode = 'merge') {
  const incoming = parsePack(bytes);
  validateSnapshot(incoming.snapshot, incoming.audio);
  const existing = await store.snapshot();
  const merged = mergePack(existing.snapshot, existing.audio, incoming.snapshot, incoming.audio, mode);
  return { ...merged, text: describeSummary(merged.summary) };
}

/** Write a preview from previewImport. A failed write leaves the old data in place (one IndexedDB transaction). */
export async function applyImport(store, preview) {
  await store.replaceFromSnapshot(preview.snapshot, preview.audio);
  return preview.summary;
}
