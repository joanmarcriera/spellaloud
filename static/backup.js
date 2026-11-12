// backup.js - glue between the local store (store.js) and the one-file pack (pack.js): the logic behind the
// parent area's "Back up / move to another device" panel (Vikunja #3534). No DOM here, so node tests can drive it.
//   exportBackup(store, {kids, choice, env})  builds the file (who and what the parent chose) and hands it to the
//                                     share sheet or a download
//   previewImport(store, bytes, mode, {target}) parses a file and says what would change, writing nothing; a one-child
//                                     file can go under one of this device's children (`target`)
//   applyImport(store, preview)       writes it
// The £2.99 licence gate (#3536) is deliberately not here: the UI decides whether Export is enabled.

import { buildPack, parsePack, mergePack, packFilename, deliverPack, describeSummary, selectSnapshot, retargetSnapshot, describeContents, contentsOf, BACKUP_PRESETS, CONTENT_KEYS } from './pack.js';
import { validVoiceName } from './voice.js';
import { KID_FLAGS } from './kidopts.js';
import { MAX_AUDIO, MAX_LABEL, MAX_WORDS_PER_WEEK, MAX_TERMS_OFF, mondayOf } from './store.js';
import { CALENDARS, isTermLabel } from './terms.js';

/**
 * Export a backup file. Who: `kids` (array of slugs) or the older `kid` (one slug), or everyone when neither is
 * given. What: `choice` = {recordings, results, settings, names} (pack.js BACKUP_PRESETS; default everything).
 * Only a full backup (everything) counts for the "time to back up" reminder: a words-only file is for sharing.
 * Returns {outcome:'shared'|'downloaded'|'cancelled', filename}.
 */
export async function exportBackup(store, { kid = null, kids = null, choice = BACKUP_PRESETS.everything, env = globalThis } = {}) {
  const slugs = kids ?? (kid ? [kid] : null);
  const all = await store.snapshot();
  const { snapshot, audio } = selectSnapshot(all.snapshot, all.audio, { kids: slugs, ...choice });
  const contents = Object.fromEntries(CONTENT_KEYS.map((k) => [k, !!choice[k]]));
  const bytes = buildPack(snapshot, audio, { now: store.now().toISOString(), contents });
  const name = !choice.names ? 'words' : slugs && slugs.length === 1 ? snapshot.kids[0].name : 'family';
  const filename = packFilename(name, store.now());
  const outcome = await deliverPack(bytes, filename, env);
  // Every part AND every child: a backup of only some children must not silence the reminder (review 2026-11-12).
  const full = CONTENT_KEYS.every((k) => choice[k]) && (!slugs || all.snapshot.kids.every((k) => slugs.includes(k.slug)));
  if (outcome !== 'cancelled' && full) await store.setMeta({ last_export: store.now().toISOString() });
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
      if (key === 'typeMode' || KID_FLAGS.includes(key)) { if (v !== true && v !== false) bad('settings are invalid'); continue; } // #5604 flag, grown-up switches
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

/**
 * Parse + merge without writing. `mode` = 'merge' (default) | 'replace'. `target` = a child on this device to put a
 * one-child file under (a list another parent shared), or null to import the file's children as they are.
 * Throws a friendly Error for a bad file or an impossible choice.
 */
export async function previewImport(store, bytes, mode = 'merge', { target = null } = {}) {
  const incoming = parsePack(bytes);
  validateSnapshot(incoming.snapshot, incoming.audio);
  const existing = await store.snapshot();
  let snap = incoming.snapshot;
  let who = '';
  if (target) {
    if (mode === 'replace') throw new Error('Replace everything cannot put the words under one child. Choose "Add to what is here".');
    const kid = existing.snapshot.kids.find((k) => k.slug === target);
    if (!kid) throw new Error('That child is not on this device.');
    snap = retargetSnapshot(snap, target);
    who = `Adding the words to ${kid.name}. `;
  }
  const merged = mergePack(existing.snapshot, existing.audio, snap, incoming.audio, mode);
  const full = merged.snapshot.weeks.find((w) => w.words.length > MAX_WORDS_PER_WEEK);
  if (full) throw new Error(`That would put more than ${MAX_WORDS_PER_WEEK} words in the week of ${full.week_start}. Delete some words there first, or import the file as its own child.`);
  // Describe what the file really holds (its manifest label is untrusted), and say whose words change.
  const contents = contentsOf(incoming.snapshot, incoming.audio);
  return { ...merged, contents, text: `${who}This file holds ${describeContents(contents)}.\n${describeSummary(merged.summary)}` };
}

/** Write a preview from previewImport. A failed write leaves the old data in place (one IndexedDB transaction). */
export async function applyImport(store, preview) {
  await store.replaceFromSnapshot(preview.snapshot, preview.audio);
  return preview.summary;
}
