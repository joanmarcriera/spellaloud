// printsheet.js - pure helpers for the parent's printable pages (no DOM, no network, no storage).
//   answerSheet(week, kidName) -> { title, lines: [1..n] }   numbered blank answer lines, NO words on it
//   progressSummary(history, streak, kidName) -> { title, weeksPracticed, notYet: [labels], streak }
//   sheetText(model) / summaryText(model) -> plain text, what parent.js prints
// "Not yet" = the history endpoint's `tricky` flag: the word's latest results include a miss that two
// right answers have not yet cleared (same rule as the kid app's Tricky mode).

/** Blank numbered lines for a paper dictation; deliberately carries only the count, never the words. */
export function answerSheet(week, kidName) {
  const n = week.words.length;
  return { title: `${kidName} - spelling test`, lines: Array.from({ length: n }, (_, i) => i + 1) };
}

/** One-page progress summary from the /api/kids/<slug>/history payload and the streak in days. */
export function progressSummary(history, streak, kidName) {
  const weeks = history.weeks || [];
  return {
    title: `${kidName} - spelling progress`,
    weeksPracticed: weeks.filter((w) => w.sessions > 0).length,
    notYet: weeks.flatMap((w) => w.words.filter((x) => x.tricky).map((x) => x.label)),
    streak,
  };
}

export const sheetText = (m) => [m.title, '', ...m.lines.map((n) => `${n}. ______________________`)].join('\n');

export const summaryText = (m) => [
  m.title, '',
  `Weeks practised: ${m.weeksPracticed}`,
  `Streak: ${m.streak} day${m.streak === 1 ? '' : 's'}`,
  `Words marked "Not yet": ${m.notYet.length}`,
  ...m.notYet.map((w) => `  - ${w}`),
].join('\n');
