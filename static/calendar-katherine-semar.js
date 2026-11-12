// calendar-katherine-semar.js - term and half-term dates for Katherine Semar Infant and Junior Schools,
// Saffron Walden (Essex), the data behind the "Katherine Semar" school calendar setting (terms.js).
//
// Why a .js module and not a .json file: bin/build-local ships flat static/*.js files, the service worker
// precaches them, and an ES module needs no fetch (so it works offline and in the node tests). The shape is plain
// JSON, so it can be moved to a .json file later without changing terms.js.
//
// Fields per half-term: name (Autumn 1 ... Summer 2), start and end (ISO dates, both inclusive).
//   start = first day the school is open in that half-term, a non-pupil (INSET) day counts, because a week that
//           begins on an INSET Monday still belongs to that half-term;
//   end   = last day the school is open (the last INSET day counts the same way).
// A Monday week_start that falls in a holiday gap belongs to the NEXT half-term (see terms.js).
//
// Uncertainty, stated plainly (checked 2026-11-08):
//   2026-27  The school's own calendar, published on its website (PDF below). Matches Essex County Council's.
//   2025-26  The school's website no longer shows it. These are Essex County Council's dates for community and
//            voluntary controlled schools; Katherine Semar is an academy (Saffron Academy Trust), so its own
//            2025-26 dates may differ by a day or two. Its 2025-26 INSET days are not published online.
//   2027-28  Essex County Council's calendar, linked from the school's Term Dates page; the school's own may differ.
// Katherine Semar Infant and Junior share one calendar (same site, same Term Dates page).

export const KATHERINE_SEMAR = {
  id: 'katherine-semar',
  label: 'Katherine Semar (Saffron Walden)',
  sources: {
    page: 'https://www.katherinesemar.co.uk/page/?title=Term+Dates&pid=70',
    '2026-27': 'https://www.katherinesemar.co.uk/attachments/download.asp?file=6500&type=pdf',
    '2027-28': 'https://www.katherinesemar.co.uk/attachments/download.asp?file=6477&type=pdf',
    '2025-26': 'https://www.essex.gov.uk/sites/default/files/2024-03/ECC%20School%20Term%20Dates%202025-2026_1.pdf',
    '2026-27 (Essex County Council, cross-check)': 'https://www.essex.gov.uk/sites/default/files/2025-03/Essex%20School%20Term%20Dates%202026%20to%202027.pdf',
  },
  years: [
    {
      year: '2025-26',
      source: 'Essex County Council (community and voluntary controlled schools); the school may differ',
      halfTerms: [
        { name: 'Autumn 1', start: '2025-09-01', end: '2025-10-24' },
        { name: 'Autumn 2', start: '2025-11-03', end: '2025-12-19' },
        { name: 'Spring 1', start: '2026-01-05', end: '2026-02-13' },
        { name: 'Spring 2', start: '2026-02-23', end: '2026-03-27' },
        { name: 'Summer 1', start: '2026-04-13', end: '2026-05-22' },
        { name: 'Summer 2', start: '2026-06-01', end: '2026-07-20' },
      ],
      nonPupilDays: [], // not published online; the school keeps five a year
    },
    {
      year: '2026-27',
      source: "Katherine Semar's own published calendar",
      halfTerms: [
        { name: 'Autumn 1', start: '2026-09-01', end: '2026-10-23' },
        { name: 'Autumn 2', start: '2026-11-02', end: '2026-12-18' },
        { name: 'Spring 1', start: '2027-01-04', end: '2027-02-12' },
        { name: 'Spring 2', start: '2027-02-22', end: '2027-03-25' },
        { name: 'Summer 1', start: '2027-04-12', end: '2027-05-28' },
        { name: 'Summer 2', start: '2027-06-07', end: '2027-07-21' },
      ],
      // School closed to pupils (the half-term spans above include these days).
      nonPupilDays: ['2026-09-01', '2026-11-16', '2027-01-04', '2027-06-07', '2027-07-21'],
    },
    {
      year: '2027-28',
      source: 'Essex County Council calendar linked from the school website; the school may differ',
      halfTerms: [
        { name: 'Autumn 1', start: '2027-09-01', end: '2027-10-22' },
        { name: 'Autumn 2', start: '2027-11-01', end: '2027-12-17' },
        { name: 'Spring 1', start: '2028-01-04', end: '2028-02-11' },
        { name: 'Spring 2', start: '2028-02-21', end: '2028-03-31' },
        { name: 'Summer 1', start: '2028-04-18', end: '2028-05-26' },
        { name: 'Summer 2', start: '2028-06-05', end: '2028-07-21' },
      ],
      nonPupilDays: ['2027-09-01', '2027-11-01', '2028-01-04', '2028-06-05', '2028-07-21'],
    },
  ],
};
