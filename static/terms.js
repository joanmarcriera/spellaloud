// terms.js - school calendars and term labels (pure functions, no DOM, no storage). Used by store.js and backup.js.
//
// A child's "School calendar" setting (settings.calendar) picks how a week's automatic term is worked out:
//   absent / 'approx'   Approximate UK terms (store.js termOf): Sep-Dec Autumn, Jan-Mar Spring, Apr-Aug Summer.
//                       Labels look like '2026 Autumn'. This is the default and the family server's only behaviour.
//   'katherine-semar'   Real half-terms from calendar-katherine-semar.js. Labels look like '2026-27 Autumn 2'.
// Both label formats are valid everywhere (stored weeks, manual overrides, term switches, the export file), so
// nothing is migrated: the automatic term is computed when a week is read.
//
// Usage:
//   halfTermOf('2026-12-21')      -> '2026-27 Spring 1'  (the half-term containing the date, or the next one when
//                                    the date falls in a holiday; null outside the data)
//   currentHalfTerm('2026-12-25') -> '2026-27 Autumn 2'  (the half-term that has most recently started)
//   isTermLabel(s), termOrder(label), termYear(label), halfTermNeighbours(label, n), calendarId(settings)

import { KATHERINE_SEMAR } from './calendar-katherine-semar.js';

export const CALENDAR_APPROX = 'approx';
export const CALENDARS = { [KATHERINE_SEMAR.id]: KATHERINE_SEMAR.label };

const DAY = 86400000;
const msOf = (iso) => Date.parse(iso + 'T00:00:00Z');
// The summer holiday is at most ~7 weeks; a date further than this outside the data is not covered by it.
const MARGIN_DAYS = 49;

const APPROX_RE = /^(\d{4}) (Spring|Summer|Autumn)$/;
const HALF_RE = /^(\d{4})-(\d{2}) (Autumn|Spring|Summer) ([12])$/;
const NAMES = ['Autumn', 'Spring', 'Summer'];

/** Every half-term of the calendar, oldest first: [{label, start, end}]. */
const HALF_TERMS = KATHERINE_SEMAR.years.flatMap((y) => y.halfTerms.map((h) => ({ label: `${y.year} ${h.name}`, start: h.start, end: h.end })));

/** True for '2026 Autumn' and '2026-27 Autumn 2' (the year pair must be consecutive: '2026-28' is not a school year). */
export function isTermLabel(s) {
  if (typeof s !== 'string') return false;
  if (APPROX_RE.test(s)) return true;
  const m = HALF_RE.exec(s);
  return Boolean(m) && (Number(m[1]) + 1) % 100 === Number(m[2]);
}

/** Which calendar a child's settings select; anything unknown means the approximate one. */
export const calendarId = (settings) => (settings && Object.hasOwn(CALENDARS, settings.calendar) ? settings.calendar : CALENDAR_APPROX);

/** School year a term label belongs to: '2026 Autumn' and '2027 Spring' -> '2026-27'; '2026-27 Summer 1' -> '2026-27'. */
export function termYear(label) {
  const half = HALF_RE.exec(label);
  if (half) return `${half[1]}-${half[2]}`;
  const [, y, name] = APPROX_RE.exec(label);
  const start = name === 'Autumn' ? Number(y) : Number(y) - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** A number that sorts term labels of either format into calendar order. */
export function termOrder(label) {
  const half = HALF_RE.exec(label);
  if (half) return Number(half[1]) * 6 + NAMES.indexOf(half[3]) * 2 + Number(half[4]) - 1;
  const [, y, name] = APPROX_RE.exec(label);
  return (name === 'Autumn' ? Number(y) : Number(y) - 1) * 6 + NAMES.indexOf(name) * 2;
}

/** The half-term containing the ISO date, or the next one when it falls in a holiday. null outside the data. */
export function halfTermOf(iso) {
  const first = HALF_TERMS[0];
  if (msOf(iso) < msOf(first.start) - MARGIN_DAYS * DAY) return null;
  const hit = HALF_TERMS.find((h) => h.end >= iso);
  return hit ? hit.label : null;
}

/** The half-term that has most recently started on or before the date (so in a holiday: the one that just ended). */
export function currentHalfTerm(iso) {
  const last = HALF_TERMS[HALF_TERMS.length - 1];
  if (iso < HALF_TERMS[0].start || msOf(iso) > msOf(last.end) + MARGIN_DAYS * DAY) return null;
  let cur = null;
  for (const h of HALF_TERMS) if (h.start <= iso) cur = h.label;
  return cur;
}

/** The labels up to n places before and after a calendar half-term (for the manual term picker). [] for other labels. */
export function halfTermNeighbours(label, n = 2) {
  const i = HALF_TERMS.findIndex((h) => h.label === label);
  if (i < 0) return [];
  return HALF_TERMS.slice(Math.max(0, i - n), i).concat(HALF_TERMS.slice(i + 1, i + 1 + n)).map((h) => h.label);
}

/**
 * The child's "Big Spell" tab text. Under a school calendar it names what the button covers: 'Big Spell · Autumn 2'
 * (the chosen half-term, else the current one; a whole year shows as 'Big Spell · 2026-27'). `terms` is the
 * /terms response; the family server sends no `calendar` field, so its label stays plain.
 */
export function bigSpellLabel(text, terms, scope) {
  if (!terms || !terms.calendar || terms.calendar === CALENDAR_APPROX) return text;
  return `${text} · ${(scope || terms.current).replace(/^\d{4}-\d{2} (?=\w)/, '')}`;
}
