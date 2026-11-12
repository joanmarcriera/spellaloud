// typemode.js - pure helpers for the "type the word" practice mode (Vikunja #5604). No DOM, no storage, no network.
//
// The mode is behind a per-child setting, settings.typeMode, that ships OFF: it is stored with the child's other
// settings (so it travels in the export file, no new storage key) and absent means off. The kid app asks
// typeModeEntry(settings) for its menu entry and renders nothing when that is null.
//
// Bookkeeping is the existing one: typeResults() returns the same [{word_id, correct: 1|0}] list the "Check your words"
// screen posts to /api/kids/<slug>/sessions, so a wrong spelling becomes Not-yet (correct 0), which feeds Tricky.

/** The shipped default of the flag. Turning it on is a decision, not a code change (see the roadmap, Q3 gate). */
export const TYPE_MODE_DEFAULT = false;

/** True only for an explicit boolean true; anything else (absent, "yes", 1) is off. */
export const isTypeModeOn = (settings) => !!settings && settings.typeMode === true;

/** The kid-app menu entry for this mode, or null when the flag is off. */
export const typeModeEntry = (settings) => (isTypeModeOn(settings) ? { id: 'type', label: 'Type the word' } : null);

const norm = (s) => String(s ?? '').normalize('NFC').trim().toLowerCase();

/** Is `typed` the word? Case and surrounding space are ignored; inner characters (including spaces) must match. */
export const checkTyped = (typed, label) => norm(typed) !== '' && norm(typed) === norm(label);

/** words: [{id, label}]; answers: {wordId: typedText}. Missing answers count as wrong. */
export const typeResults = (words, answers) =>
  words.map((w) => ({ word_id: w.id, correct: checkTyped(answers[w.id], w.label) ? 1 : 0 }));

/** The word ids that are Not-yet after a round. */
export const notYetIds = (results) => results.filter((r) => r.correct === 0).map((r) => r.word_id);
