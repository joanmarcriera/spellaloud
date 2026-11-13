// parent.js - parent page: add/edit weekly words for both kids and read the report.
// Works on a phone (single column under 800px). All text is inserted with textContent (no HTML injection).

import { createTransport } from './transport.js';
import { requestPersistence, isInstalled, platformOf, storageNotices } from './durability.js';
import { exportBackup, previewImport, applyImport } from './backup.js';
import { BACKUP_PRESETS, CONTENT_KEYS, describeContents, contentsOf, parsePack } from './pack.js';
import { VOICE_MODE_KEY, storedVoiceMode, pickVoice, loadVoices, gbVoices, recordingPlan, voiceStatus } from './voice.js';
import { buildShareLink, parseShare } from './share.js';
import { qrMatrix, qrSvgPath } from './qr.js';
import { SCALE_KEY, parseScale, stepScale, setupStep, addChildWithWords, parseWordList, mondayISO, MAX_LABEL, MAX_WORDS } from './lib.js';
import { sampleForYear } from './sample.js';
import { feedbackButton } from './feedback.js';
import { answerSheet, progressSummary, sheetText, summaryText } from './printsheet.js';
import { isTypeModeOn } from './typemode.js';
import { bulkDeletePlan, bulkConfirmText, selectionState, bulkButtonText } from './bulk.js';
import { CALENDARS, calendarId } from './terms.js';
import { openTour, shouldAutoStart, tourSeen, SOURCE_URL } from './tour.js';
import { KID_FLAGS, FLAG_LABELS } from './kidopts.js';

const root = document.getElementById('kids');
const toastEl = document.getElementById('toast');

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

let toastTimer;
function toast(msg, err) {
  toastEl.textContent = msg;
  toastEl.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, 3000);
}

// All data goes through the transport: server.py's API in the family build, IndexedDB in the local build.
const transportReady = createTransport();
async function api(method, path, body) { return (await transportReady).api(method, path, body); }

const openWeeks = new Set(); // week ids whose <details> are open; survives re-renders
const seenKids = new Set();  // kids whose newest week has already been opened by default
const openTermBoxes = new Set(); // kids whose School calendar box is open; survives re-renders

/** Run an action for one kid. The button is disabled while it runs. On error: toast + inline message and NO
 *  re-render (typed text stays). On success: only that kid's panel is rebuilt. */
async function act(button, slug, fn, okMsg) {
  const panel = button.closest('.panel');
  const perr = panel.querySelector('.perr');
  perr.textContent = '';
  button.disabled = true;
  try {
    await fn();
  } catch (e) {
    perr.textContent = e.message;
    toast(e.message, true);
    button.disabled = false;
    return;
  }
  if (okMsg) toast(okMsg);
  try { await refreshKid(slug); } catch (e) { toast(e.message, true); button.disabled = false; }
}

/**
 * After a child was created (#6577): refresh the page without ever re-enabling the old Add button, and say it in the
 * new panel's role=alert line (a 3 s toast is too easy to miss). `weekError` = the words failed; `keepWords` (setup
 * panel, where the next step is "add words for this child") puts the typed list back so nothing is retyped.
 */
async function childExists(weekError, list, keepWords) {
  let note = weekError
    ? 'Child added, but the words were not saved: ' + weekError.replace(/\.?\s*$/, '.') + (keepWords ? ' Fix the words and save again.' : ' Add them with Add week on their card.')
    : '';
  try { await render(); await paintBackupBox(); } catch (e) { note = 'Child added, but the page could not refresh (' + e.message + '). Reload this page.'; }
  const panel = document.getElementById('addchild');
  if (panel && weekError && keepWords) { const box = panel.querySelector('textarea'); if (box) box.value = list.join('\n'); }
  const m = panel && panel.querySelector('.msg');
  if (note) { if (m) m.textContent = note; else toast(note, true); }
}

/** Put the example words for `year` in a textarea and say so in the role=status toast (screen readers hear it).
 *  Never overwrites words the parent typed: only an empty box, or one still holding a previous example list. */
function fillExample(box, year) {
  const list = sampleForYear(year);
  const cur = box.value.trim();
  if (cur && cur !== box.dataset.example) { toast('Your own words are in the box. Clear it first to use the examples.', true); return; }
  box.value = list.join('\n');
  box.dataset.example = box.value.trim();
  toast(list.length + ' example words added. You can edit them.');
}

const thisMonday = () => mondayISO(new Date(), 0);
const fmtDate = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtWhen = (iso) => iso.replace('T', ' ').slice(0, 16);
const MODE_NAME = { week: 'This week', term: 'Big Spell', tricky: 'Tricky' };

/** Parse the textarea into labels; refuse over-long entries by name instead of letting the server reject the week. */
function wordsFrom(text) {
  const r = parseWordList(text);
  if (r.tooLong.length) throw new Error(`"${r.tooLong[0].slice(0, 20)}…" is longer than ${MAX_LABEL} characters; put one word per line`);
  if (r.words.length > MAX_WORDS) throw new Error(`That is ${r.words.length} words; a week holds at most ${MAX_WORDS}`);
  return r.words;
}

function addWeekForm(kid) {
  const date = h('input', { type: 'date', value: thisMonday(), 'aria-label': 'Week starting' });
  const words = h('textarea', { placeholder: 'One word per line (commas and numbered lists work too)', 'aria-label': 'Words' });
  return h('div', {},
    h('h3', {}, 'Add week'),
    date,
    // One tap to plan ahead (#6665): the form starts on this week's Monday; these set the date to this/next week.
    h('div', { class: 'screenbox' },
      h('button', { type: 'button', class: 'btn small', onclick: () => { date.value = mondayISO(new Date(), 0); words.focus(); } }, 'This week'),
      h('button', { type: 'button', class: 'btn small', onclick: () => { date.value = mondayISO(new Date(), 1); words.focus(); } }, 'Next week')),
    words,
    h('button', { type: 'button', class: 'btn small', onclick: () => fillExample(words, kid.year) },
      'Use the ' + (kid.year === 0 ? 'Reception' : 'Year ' + kid.year) + ' example words'),
    h('button', {
      type: 'button', class: 'btn solid', onclick: (e) => act(e.currentTarget, kid.slug, async () => {
        const list = wordsFrom(words.value);
        if (!list.length) throw new Error('Type at least one word');
        const wk = await api('POST', `/api/kids/${kid.slug}/weeks`, { week_start: date.value, words: list });
        openWeeks.add(wk.id); // show the week just added
      }, 'Week added'),
    }, 'Add week'));
}

/** Which term this week counts towards. Automatic (from the date) unless a parent picks another one. */
function termPicker(kid, week) {
  const opts = [...new Set([week.term_default, ...week.term_options, week.term])].sort();
  const sel = h('select', { 'aria-label': 'Term' },
    h('option', { value: '', selected: week.term_auto || null }, `Automatic (${week.term_default})`),
    opts.filter((t) => t !== week.term_default || !week.term_auto).map((t) => h('option', { value: t, selected: (!week.term_auto && t === week.term) || null }, t)));
  return h('label', { class: 'termpick' }, 'Term ', sel,
    h('button', { type: 'button', class: 'btn small', onclick: (e) => act(e.currentTarget, kid.slug, () => api('PATCH', `/api/weeks/${week.id}`, { term: sel.value || null }), 'Term saved') }, 'Save'));
}

/**
 * "School calendar and terms" for one child, browser-only build (the family server keeps the approximate terms).
 * The calendar decides how each week's automatic term is worked out; a tick per term says whether Big Spell and
 * Tricky words include that term's weeks. Both are saved with the child's settings, so they travel in the export file.
 * `info` = GET /api/kids/:slug/terms?all=1.
 */
function termsBox(kid, t, info) {
  if (t.mode !== 'local') return null;
  const save = async (patch, okMsg, rebuild) => { // settings are saved whole: start from what is stored now
    try {
      const cur = (await api('GET', '/api/kids')).find((k) => k.slug === kid.slug);
      await api('PUT', `/api/kids/${kid.slug}/settings`, { ...cur.settings, ...patch });
      toast(okMsg);
      if (rebuild) await refreshKid(kid.slug);
    } catch (e) { toast(e.message, true); }
  };
  const cal = h('select', { 'aria-label': `School calendar for ${kid.name}`, onchange: () => save({ calendar: cal.value }, 'Calendar saved', true) },
    h('option', { value: 'approx', selected: calendarId(kid.settings) === 'approx' || null }, 'Approximate (Sep\u2013Dec / Jan\u2013Mar / Apr\u2013Aug)'),
    Object.entries(CALENDARS).map(([id, name]) => h('option', { value: id, selected: calendarId(kid.settings) === id || null }, name)));
  const boxes = info.terms.map((x) => h('input', { type: 'checkbox', checked: x.on, 'aria-label': `Include ${x.label} in Big Spell and Tricky words`, 'data-term': x.key,
    onchange: () => save({ terms_off: boxes.filter((b) => !b.checked).map((b) => b.dataset.term) }, 'Terms saved') }));
  return h('details', { class: 'kidtools', open: openTermBoxes.has(kid.slug) || null, ontoggle: (e) => { if (e.currentTarget.open) openTermBoxes.add(kid.slug); else openTermBoxes.delete(kid.slug); } },
    h('summary', {}, 'School calendar and terms'),
    h('div', { class: 'screenbox' }, h('label', {}, 'School calendar ', cal)),
    h('p', { class: 'note' }, "Katherine Semar uses the school's half-terms (Autumn 1 to Summer 2). 2026-27 is the school's own calendar; 2025-26 and 2027-28 are Essex County Council's, which the school may adjust by a day or two."),
    h('h3', {}, 'Terms in Big Spell and Tricky words'),
    h('p', { class: 'note' }, 'Untick a term to leave its words out. Big Spell starts from the current term; this page decides which terms can be included.'),
    h('div', { class: 'termlist' }, info.terms.map((x, i) => h('label', {}, boxes[i], ` ${x.label}`))));
}

/** Put plain text in #printarea and open the print dialog; the @media print rule shows only that area. */
function printText(text) {
  const area = document.getElementById('printarea');
  area.replaceChildren(h('pre', {}, text));
  window.print();
}

/** Multi-select for one week's words (#6328): a tick per word, Select all, and one confirmed "Delete selected". */
function bulkBar(kid, week) {
  const picked = new Set();
  const boxes = new Map(); // word id -> checkbox
  const all = h('input', { type: 'checkbox', 'aria-label': 'Select all words in this week', disabled: !week.words.length });
  const del = h('button', { type: 'button', class: 'btn small danger', disabled: true }, bulkButtonText(0));
  const sync = () => {
    const st = selectionState(picked.size, week.words.length);
    all.checked = st === 'all'; all.indeterminate = st === 'some';
    del.disabled = !picked.size; del.textContent = bulkButtonText(picked.size);
  };
  all.addEventListener('change', () => {
    for (const [id, box] of boxes) { box.checked = all.checked; if (all.checked) picked.add(id); else picked.delete(id); }
    sync();
  });
  del.addEventListener('click', async (e) => {
    const labels = week.words.filter((w) => picked.has(w.id)).map((w) => w.label);
    if (!labels.length || !confirm(bulkConfirmText(labels))) return;
    const mode = (await transportReady).mode;
    act(e.currentTarget, kid.slug, async () => { for (const [m, p, b] of bulkDeletePlan([...picked], mode)) await api(m, p, b); }, `${labels.length} word${labels.length === 1 ? '' : 's'} deleted`);
  });
  const tick = (w) => {
    const box = h('input', { type: 'checkbox', 'aria-label': `Select ${w.label}`, onchange: (e) => { if (e.currentTarget.checked) picked.add(w.id); else picked.delete(w.id); sync(); } });
    boxes.set(w.id, box);
    return box;
  };
  sync();
  return { tick, bar: h('div', { class: 'wordrow bulkbar' }, h('label', {}, all, ' Select all'), del) };
}

function weekPanel(kid, week) {
  const newWord = h('input', { type: 'text', maxlength: '40', placeholder: 'New word', 'aria-label': 'New word' });
  const bulk = bulkBar(kid, week);
  return h('details', { class: 'week', open: openWeeks.has(week.id) || null, ontoggle: (e) => { if (e.currentTarget.open) openWeeks.add(week.id); else openWeeks.delete(week.id); } },
    h('summary', {}, `Week of ${fmtDate(week.week_start)} (${week.words.length} words) · ${week.term}`),
    termPicker(kid, week),
    week.words.length > 0 && bulk.bar,
    week.words.map((w) => {
      const input = h('input', { type: 'text', maxlength: '40', value: w.label, 'aria-label': 'Word' });
      return h('div', { class: 'wordrow' },
        bulk.tick(w),
        input,
        h('span', { class: 'au' + (w.has_audio ? ' yes' : '') + (w.audio_source === 'tts' ? ' tts' : '') }, !w.has_audio ? 'no sound' : w.audio_source === 'tts' ? 'computer voice' : 'sound'),
        h('button', { type: 'button', class: 'btn small', onclick: (e) => act(e.currentTarget, kid.slug, () => api('PATCH', `/api/words/${w.id}`, { label: input.value }), 'Saved') }, 'Save'),
        h('button', { type: 'button', class: 'btn small danger', 'aria-label': `Delete ${w.label}`, onclick: (e) => {
          if (confirm(`Delete "${w.label}"? Its recording and any practice history for it will be deleted too.`)) act(e.currentTarget, kid.slug, () => api('DELETE', `/api/words/${w.id}`), 'Word deleted');
        } }, 'Delete'));
    }),
    h('div', { class: 'wordrow' }, newWord,
      h('button', { type: 'button', class: 'btn small', onclick: (e) => act(e.currentTarget, kid.slug, () => api('POST', `/api/weeks/${week.id}/words`, { label: newWord.value }), 'Word added') }, 'Add')),
    h('button', { type: 'button', class: 'btn small', onclick: () => shareWeek(week) }, 'Share list'),
    h('button', { type: 'button', class: 'btn small', onclick: () => printText(sheetText(answerSheet(week, kid.name))) }, 'Print blank test sheet'),
    h('button', {
      type: 'button', class: 'btn small danger',
      onclick: (e) => { if (confirm(`Delete the whole week of ${fmtDate(week.week_start)}, with all its recordings and practice history?`)) act(e.currentTarget, kid.slug, async () => { await api('DELETE', `/api/weeks/${week.id}`); openWeeks.delete(week.id); }, 'Week deleted'); },
    }, 'Delete week'));
}

function reportPanel(rep, weeks) {
  const tbl = (head, rows) => h('table', {}, h('tr', {}, head.map((t) => h('th', {}, t))), rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, String(c))))));
  return h('div', {},
    h('h3', {}, 'Report'),
    rep.weeks.some((w) => w.total) ? tbl(['Week', '% correct'], rep.weeks.filter((w) => w.total).map((w) => [fmtDate(w.week_start), `${w.pct}% (${w.correct}/${w.total})`])) : h('p', { class: 'note' }, 'No results yet.'),
    h('h3', {}, 'Most missed this term'),
    rep.most_missed.length ? tbl(['Word', 'Missed / tried'], rep.most_missed.map((m) => [m.label, `${m.missed} / ${m.tried}`])) : h('p', { class: 'note' }, 'Nothing missed.'),
    h('h3', {}, 'Last 10 sessions'),
    rep.recent.length ? tbl(['When', 'Mode', 'Score'], rep.recent.map((s) => [fmtWhen(s.created_at), MODE_NAME[s.mode] || s.mode, `${s.correct}/${s.total}`])) : h('p', { class: 'note' }, 'No sessions yet.'));
}

/** The device's voices, read once per page (#6327: no British voice means unrecorded words need recording). */
const deviceVoices = (async () => { try { return await loadVoices(globalThis.speechSynthesis); } catch { return []; } })();
// Green/red line at the top of the voice help; in an in-app browser the Android settings button cannot work, so hide it.
deviceVoices.then((vs) => {
  const s = voiceStatus(pickVoice(vs), globalThis.navigator?.userAgent || '');
  const el = document.getElementById('vstatus');
  if (el) { el.textContent = s.text; el.classList.add(s.ok ? 'ok' : 'bad'); }
  if (s.webview) document.getElementById('vandroid')?.setAttribute('hidden', '');
});
const voiceHelpLink = () => h('a', { href: '#voice-help' }, 'How to get a British voice');

/** Parent-side prompt: with no British voice, words without a recording would be silent; send them to Record. */
function noVoiceNotice(kid, weeks, voices) {
  const plan = recordingPlan(weeks.flatMap((w) => w.words), voices, true);
  if (!plan.blocked) return null;
  const n = plan.record.length;
  return h('p', { class: 'note noVoiceNote', role: 'status' },
    `This device has no British voice, so ${n} word${n === 1 ? ' has' : 's have'} no sound for ${kid.name}. `,
    h('a', { href: '/?kid=' + encodeURIComponent(kid.slug) }, `Open ${kid.name}'s page and press Record words`), '. ', voiceHelpLink(), '.');
}

/**
 * "Change name or year" and "Delete this child" (#6329), browser-only build (the family LAN build has no kid
 * routes for this). Rename keeps the slug, so history stays. Delete is two-step: step 1 offers Export first,
 * step 2 asks the browser to confirm, then removes the child's weeks, words, recordings and scores.
 */
function kidTools(kid, t) {
  if (t.mode !== 'local') return null;
  const name = h('input', { type: 'text', maxlength: 30, value: kid.name, 'aria-label': `New name for ${kid.name}` });
  const year = h('select', { 'aria-label': `School year for ${kid.name}` }, [0, 1, 2, 3, 4, 5, 6].map((y) => h('option', { value: y, selected: y === kid.year }, y === 0 ? 'Reception' : `Year ${y}`)));
  const msg = h('p', { class: 'msg err', role: 'alert' });
  const step2 = h('div', { class: 'screenbox', hidden: true },
    h('button', { type: 'button', class: 'btn small', onclick: async () => {
      try { const out = await exportBackup(t.store, { kid: kid.slug }); msg.textContent = out.outcome === 'cancelled' ? 'Nothing was saved.' : `Saved ${out.filename}.`; } catch (e) { msg.textContent = `Could not export: ${e.message}`; }
    } }, `Export ${kid.name} first`),
    h('button', { type: 'button', class: 'btn small danger', onclick: async () => {
      if (!confirm(`Delete ${kid.name} from this device, with all their weeks, words, recordings and scores? This cannot be undone.`)) { msg.textContent = 'Nothing was deleted.'; return; }
      try { await api('DELETE', `/api/kids/${kid.slug}`); seenKids.delete(kid.slug); try { localStorage.removeItem(`spellings.draft.${kid.slug}`); } catch { /* storage blocked */ } toast(`${kid.name} deleted`); await render(); await paintBackupBox(); } catch (e) { msg.textContent = e.message; }
    } }, `Delete ${kid.name} now`),
    h('button', { type: 'button', class: 'btn small', onclick: () => { step2.hidden = true; } }, 'Cancel'));
  return h('details', { class: 'kidtools' },
    h('summary', {}, 'Change name or year, or delete this child'),
    h('div', { class: 'screenbox' }, name, year, h('button', { type: 'button', class: 'btn small solid', onclick: async () => {
      try { await api('PATCH', `/api/kids/${kid.slug}`, { name: name.value, year: Number(year.value) }); toast('Saved'); await render(); await paintBackupBox(); } catch (e) { msg.textContent = e.message; }
    } }, 'Save')),
    h('div', { class: 'screenbox' }, h('button', { type: 'button', class: 'btn small danger', onclick: () => { step2.hidden = false; } }, `Delete ${kid.name}...`)),
    step2, msg);
}

/**
 * Change some of a child's settings without undoing anyone else's: read what is stored NOW, apply `change` (a
 * function that edits the copy), save it whole. Every settings control on this page goes through here (review
 * 2026-11-12: a picker holding an old copy could erase a switch set since the page loaded). Returns the saved settings.
 */
async function patchSettings(slug, change) {
  const cur = (await api('GET', '/api/kids')).find((k) => k.slug === slug);
  if (!cur) throw new Error('That child is not on this device any more. Reload this page.');
  const next = { ...cur.settings };
  change(next);
  return api('PUT', `/api/kids/${slug}/settings`, next);
}

/**
 * "Practice options" (kidopts.js, 2026-11-12): what the child may do on their own. Each switch is saved with the
 * child's settings (so it travels in a backup file); the settings are saved whole, starting from what is stored now.
 */
function kidSwitches(kid) {
  // With "I know it" hidden AND no self-check, nothing can ever take a word out of Tricky words: say so.
  const warn = h('p', { class: 'msg err', role: 'status' });
  const paintWarn = () => {
    warn.textContent = kid.settings.noKnowIt === true && kid.settings.noSelfCheck === true
      ? `With both of these off, words stay in ${kid.name}'s Tricky words for good (no test results and no "I know it"). Turn one back on.`
      : '';
  };
  const rows = KID_FLAGS.map((flag) => {
    const L = FLAG_LABELS[flag];
    const isSet = kid.settings[flag] === true;
    const cb = h('input', { type: 'checkbox', 'aria-label': L.text(kid.name), checked: L.ticked ? isSet : !isSet });
    cb.onchange = async () => {
      const set = L.ticked ? cb.checked : !cb.checked;
      cb.disabled = true;
      try {
        kid.settings = await patchSettings(kid.slug, (s) => { if (set) s[flag] = true; else delete s[flag]; });
        toast('Saved for ' + kid.name);
      } catch (e) { toast(e.message, true); cb.checked = !cb.checked; }
      cb.disabled = false;
      paintWarn();
    };
    const hint = typeof L.hint === 'function' ? L.hint(kid.name) : L.hint;
    return h('div', { class: 'switchrow' }, h('label', { class: 'choice' }, cb, ' ', L.text(kid.name)), h('p', { class: 'hint' }, hint));
  });
  paintWarn();
  return h('details', { class: 'kidtools' },
    h('summary', {}, `Practice options for ${kid.name}`),
    ...rows, warn);
}

/** Build one kid's panel from fresh data. */
async function buildPanel(kid) {
  const t = await transportReady;
  const [weeksAsc, report, termInfo] = await Promise.all([api('GET', `/api/kids/${kid.slug}/weeks`), api('GET', '/api/report'),
    t.mode === 'local' ? api('GET', `/api/kids/${kid.slug}/terms?all=1`) : null]);
  const weeks = weeksAsc.reverse(); // newest first
  if (!seenKids.has(kid.slug) && weeks.length) { openWeeks.add(weeks[0].id); seenKids.add(kid.slug); }
  const voices = await deviceVoices;
  return h('section', { class: 'panel', 'data-kid': kid.slug },
    h('h2', {}, `${kid.name} (${kid.year === 0 ? 'Reception' : `Year ${kid.year}`})`),
    h('p', { class: 'msg err perr', role: 'alert' }),
    kidTools(kid, t),
    kidSwitches(kid),
    termInfo && termsBox(kid, t, termInfo),
    noVoiceNotice(kid, weeks, voices),
    addWeekForm(kid),
    h('h3', {}, 'Weeks'),
    weeks.length ? weeks.map((w) => weekPanel(kid, w)) : h('p', { class: 'note' }, 'No weeks yet.'),
    reportPanel(report[kid.slug], weeks),
    h('button', {
      type: 'button', class: 'btn small', onclick: async () => {
        const [hist, prog] = await Promise.all([api('GET', `/api/kids/${kid.slug}/history`), api('GET', `/api/kids/${kid.slug}/progress`)]);
        printText(summaryText(progressSummary(hist, prog.streak, kid.name)));
      },
    }, 'Print progress summary'));
}

let kidList = [];
async function refreshKid(slug) {
  const kid = kidList.find((k) => k.slug === slug);
  const old = root.querySelector(`.panel[data-kid="${slug}"]`);
  old.replaceWith(await buildPanel(kid));
}

async function render() {
  kidList = await api('GET', '/api/kids');
  const t = await transportReady;
  root.replaceChildren(...await Promise.all(kidList.map(buildPanel)));
  if (t.mode === 'local') {
    const weeks = (await Promise.all(kidList.map((k) => api('GET', '/api/kids/' + k.slug + '/weeks')))).flat();
    const step = setupStep(kidList, weeks);
    // The children come first on the page (parent.html order). First run: the setup form sits above them.
    // Afterwards "Add a child" goes after the existing children (#6763): a parent looks for their child first.
    if (step === 'ready') root.append(addChildPanel(false));
    else root.prepend(setupPanel(step));
  }
  if (kidList.length) offerSharedList(); // with no child yet, the setup panel pre-fills the words instead
}

let rendered = false; // the tour only auto-starts over a page that loaded (review 2026-11-12)
const firstRender = render().then(() => { rendered = true; }).catch((e) => { root.textContent = `Could not load: ${e.message}`; });

// ---- Guided tour (tour.js): starts by itself on a new device, replay with "Take the tour" or /parent?tour=1.
function tourDeps(t) {
  return {
    api, toast, store: t.mode === 'local' ? t.store : null, exportBackup, buildShareLink, parseWordList, sampleForYear,
    thisMonday, nextMonday: () => mondayISO(new Date(), 1), loadVoices, pickVoice, setVoiceMode, storedVoiceMode, feedbackButton,
    pageUrl: `${location.origin}/parent`, sharedWords: (parseShare(location.hash) || {}).words || null,
    onChange: async ({ sharedSaved } = {}) => {
      // The tour saved the words of the #sl= link it was opened with: drop the link so they are not offered twice.
      if (sharedSaved) history.replaceState(null, '', location.pathname + location.search);
      try { await render(); await paintBackupBox(); await paintVoiceBox(); } catch (e) { toast(e.message, true); }
    },
  };
}
(async () => {
  const t = await transportReady;
  if (t.mode !== 'local') return; // the family (LAN) build seeds its children; the tour is for the public build
  const btn = document.getElementById('tourbtn');
  btn.hidden = false;
  btn.onclick = () => openTour(tourDeps(t));
  await firstRender;
  if (rendered && shouldAutoStart({ mode: t.mode, kids: kidList, seen: tourSeen(), search: location.search }) && location.hash !== '#import') {
    if (new URLSearchParams(location.search).has('tour')) history.replaceState(null, '', location.pathname + location.hash); // a reload does not reopen it
    openTour(tourDeps(t));
  }
})().catch(() => { /* the tour is optional; the page below works without it */ });

// ---- "This screen": live viewport + per-device size for the kid app (localStorage 'spellings.scale')
function storedScale() {
  try { return parseScale(localStorage.getItem(SCALE_KEY)) ?? 1; } catch { return 1; }
}
function setScale(v) {
  try { localStorage.setItem(SCALE_KEY, String(v)); } catch { toast('This browser will not store the size', true); }
  paintScreenBox();
}
function paintScreenBox() {
  document.getElementById('vp').textContent = `Viewport ${innerWidth}\u00d7${innerHeight}, pixel ratio ${devicePixelRatio}`;
  document.getElementById('sval').textContent = `${Math.round(storedScale() * 100)}%`;
}
document.getElementById('sm').onclick = () => setScale(stepScale(storedScale(), -1));
document.getElementById('sp').onclick = () => setScale(stepScale(storedScale(), 1));
document.getElementById('s100').onclick = () => setScale(1);
addEventListener('resize', paintScreenBox);
paintScreenBox();
transportReady.then((t) => { // the hostname note is about the family LAN build (ash.lab..., finn.lab...)
  if (t.mode !== 'local') return;
  const note = document.querySelector('#screenbox p.note:last-of-type');
  if (note) note.textContent = 'Sets the size of the child screens on this device only. Use it if the words or buttons look too big or too small.';
}).catch(() => {});

// ---- "Word voice": per-device choice between the kids' recordings and the en-GB speech voice (#3537)
async function paintVoiceBox() {
  const mode = storedVoiceMode();
  document.getElementById('vrec').classList.toggle('solid', mode === 'recording');
  document.getElementById('vsyn').classList.toggle('solid', mode === 'voice');
  let v = null;
  try { v = pickVoice(await loadVoices(globalThis.speechSynthesis)); } catch { /* none */ }
  document.getElementById('vnote').textContent = v
    ? `This device reads the words in a British voice (${v.name}). Choose "Own recordings" to play recordings first.`
    : 'No British voice on this device yet, so recordings are used and every word must be recorded. Recommended: install one.';
  if (!v) document.getElementById('vnote').append(' ', voiceHelpLink(), '.');
  await paintKidVoices();
}
/** One picker per child: which installed en-GB voice reads their words. Saved with the child's settings
 *  (so it travels in the export file); "Automatic" means the best British voice on whichever device is used. */
async function paintKidVoices() {
  const box = document.getElementById('vkids');
  let voices = [];
  try { voices = gbVoices(await loadVoices(globalThis.speechSynthesis)); } catch { /* none */ }
  let kids = [];
  try { kids = await api('GET', '/api/kids'); } catch { /* the kid panels show the error */ }
  box.replaceChildren(...kids.map((k) => {
    const chosen = k.settings.voice || '';
    const missing = chosen && !voices.some((v) => v.name === chosen);
    const sel = h('select', { id: 'vk-' + k.slug, 'aria-label': 'Voice for ' + k.name, disabled: !voices.length && !chosen },
      h('option', { value: '' }, 'Automatic (best British voice)'),
      missing ? h('option', { value: chosen, selected: true }, chosen + ' (not on this device)') : null,
      ...voices.map((v) => h('option', { value: v.name, selected: v.name === chosen }, v.name)));
    sel.onchange = async () => {
      try { await patchSettings(k.slug, (s) => { if (sel.value) s.voice = sel.value; else delete s.voice; }); toast('Voice saved for ' + k.name); }
      catch (e) { toast(e.message, true); }
      paintKidVoices();
    };
    return h('label', { class: 'note' }, k.name + ': ', sel);
  }), ...kids.map((k) => typeModeToggle(k)));
}
/** Experimental "type the word" practice (#5604): off unless a parent ticks it. Saved with the child's settings, so it travels in the export file. */
function typeModeToggle(k) {
  const cb = h('input', { type: 'checkbox', id: 'tm-' + k.slug, 'aria-label': 'Type-the-word practice for ' + k.name, checked: isTypeModeOn(k.settings) });
  cb.onchange = async () => {
    try { await patchSettings(k.slug, (s) => { if (cb.checked) s.typeMode = true; else delete s.typeMode; }); toast('Saved for ' + k.name); }
    catch (e) { toast(e.message, true); }
    paintKidVoices();
  };
  return h('label', { class: 'note' }, cb, ' Type-the-word practice for ' + k.name + ' (experimental)');
}
function setVoiceMode(m) {
  try { localStorage.setItem(VOICE_MODE_KEY, m); } catch { toast('This browser will not store the choice', true); }
  paintVoiceBox();
}
document.getElementById('vrec').onclick = () => setVoiceMode('recording');
document.getElementById('vsyn').onclick = () => setVoiceMode('voice');
paintVoiceBox();

// ---- Share a word list as a link (#3543). Words only, in the URL fragment: no server ever sees them.
async function shareWeek(week) {
  const link = buildShareLink(`${location.origin}/parent`, week.words.map((w) => w.label), `Week of ${fmtDate(week.week_start)}`);
  if (!link) return toast('No words to share', true);
  showQr(link);
  try {
    if (navigator.share) { await navigator.share({ title: 'Spelling words', url: link }); return; }
  } catch (e) { if (e.name === 'AbortError') return; /* otherwise fall through to copy */ }
  try { await navigator.clipboard.writeText(link); toast('Link copied. It holds the words only.'); }
  catch { window.prompt('Copy this link (words only):', link); }
}

/** Show the link as a QR code (drawn locally as SVG, nothing is fetched) so another phone can scan it. */
function showQr(link) {
  const box = document.getElementById('qrbox');
  let m;
  try { m = qrMatrix(link); } catch { box.hidden = true; return toast('Too many words for a QR code', true); }
  const q = 4; // quiet zone, in modules
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `${-q} ${-q} ${m.length + 2 * q} ${m.length + 2 * q}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'QR code for the shared word list');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.style.cssText = 'width:min(100%,320px);height:auto;background:#fff;display:block';
  const bg = document.createElementNS(NS, 'rect');
  for (const [k, v] of [['x', -q], ['y', -q], ['width', m.length + 2 * q], ['height', m.length + 2 * q], ['fill', '#fff']]) bg.setAttribute(k, v);
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', qrSvgPath(m)); path.setAttribute('fill', '#000');
  svg.append(bg, path);
  box.replaceChildren(
    h('h2', {}, 'Scan to share'),
    svg,
    h('p', { class: 'note', id: 'qrlink' }, link),
    h('p', { class: 'note' }, 'The code holds the words only. The other phone must be able to reach this page.'),
    h('button', { type: 'button', class: 'btn small', onclick: () => { box.hidden = true; } }, 'Close'));
  box.hidden = false;
  box.scrollIntoView({ block: 'nearest' });
}

addEventListener('hashchange', () => { if (kidList) offerSharedList(); }); // a link pasted into an open tab

/** If the page was opened from a shared link, offer to add those words as a new week for one child. */
function offerSharedList() {
  const shared = parseShare(location.hash);
  if (!shared) return;
  const box = document.getElementById('sharebox');
  const kidSel = h('select', { 'aria-label': 'Add to' }, kidList.map((k) => h('option', { value: k.slug }, k.name)));
  const date = h('input', { type: 'date', value: thisMonday(), 'aria-label': 'Week starting' });
  const msg = h('p', { class: 'note' });
  const add = h('button', { type: 'button', class: 'btn solid', onclick: async () => {
    add.disabled = true;
    try {
      await api('POST', `/api/kids/${kidSel.value}/weeks`, { week_start: date.value, words: shared.words });
      history.replaceState(null, '', location.pathname + location.search); // drop the list from the address bar
      box.hidden = true;
      toast('Words added');
      await refreshKid(kidSel.value);
    } catch (e) { msg.textContent = e.message; add.disabled = false; }
  } }, 'Add these words');
  box.replaceChildren(
    h('h2', {}, `Words shared with you${shared.title ? ` (${shared.title})` : ''}`),
    h('p', {}, shared.words.join(', ')),
    h('p', { class: 'note' }, 'Only the words came in the link: no recordings or scores. Check them, then add.'),
    kidSel, date, add, msg);
  box.hidden = false;
}

// ---- Local build only (Vikunja #3532-#3534): add a child, storage durability notices, export/import one file.
/** "Add a child" - the family build seeds its two kids; the browser-only build starts empty. */
function addChildPanel(first) {
  const name = h('input', { type: 'text', maxlength: 30, placeholder: 'First name', 'aria-label': 'Child name' });
  const year = h('select', { 'aria-label': 'School year' }, [0, 1, 2, 3, 4, 5, 6].map((y) => h('option', { value: y, selected: y === 1 }, y === 0 ? 'Reception' : 'Year ' + y)));
  // #6335: a further child can load this week's words straight away, or start from example words for their year.
  const words = h('textarea', { placeholder: "This week's words, one per line (optional)", 'aria-label': "This week's words for the new child" });
  const msg = h('p', { class: 'msg err', role: 'alert' });
  return h('section', { class: 'panel', id: 'addchild' },
    h('h2', {}, first ? 'Add your first child' : 'Add a child'),
    h('div', { class: 'screenbox' }, name, year),
    words,
    h('div', { class: 'screenbox' },
      h('button', { type: 'button', class: 'btn small', onclick: () => fillExample(words, year.value) }, 'Use example words for this year'),
      h('button', { type: 'button', class: 'btn small solid', 'aria-label': 'Add child', onclick: async (ev) => {
        const btn = ev.currentTarget;
        if (btn.disabled) return;
        btn.disabled = true; // one tap = one child, even on a slow tablet
        msg.textContent = '';
        const list = words.value.split('\n').map((x) => x.trim()).filter(Boolean);
        let res;
        try {
          res = await addChildWithWords(api, { name: name.value, year: year.value, words: list, weekStart: thisMonday() });
        } catch (e) { msg.textContent = e.message; btn.disabled = false; return; } // no child was created: retry is safe
        await childExists(res.weekError, list, false); // from here the child exists: Add stays disabled, never a duplicate
      } }, 'Add')), msg);
}

/** A visible <label> wrapped around a control (placeholders vanish on typing and are not labels). */
class FieldError extends Error { constructor(field, text) { super(text); this.field = field; } }

function labelled(text, control) {
  return h('label', { class: 'field' }, h('span', { class: 'fieldlabel' }, text), control);
}

/**
 * First-run setup (Vikunja #4632): one panel that adds the child (when there is none) and this week's words
 * together, then goes straight to the kid screen: parent page, Play screen, dictation = 3 screens.
 * "example words" fills the box from sample.js for the chosen year; the parent can edit it first.
 */
function setupPanel(step) {
  const name = h('input', { type: 'text', maxlength: 30, placeholder: 'e.g. Ava', 'aria-label': 'Child first name' });
  const year = h('select', { 'aria-label': 'School year' }, [0, 1, 2, 3, 4, 5, 6].map((y) => h('option', { value: y, selected: y === 2 }, y === 0 ? 'Reception' : 'Year ' + y)));
  const kidSel = h('select', { 'aria-label': 'Child' }, kidList.map((k) => h('option', { value: k.slug }, k.name)));
  const words = h('textarea', { placeholder: 'One word per line (commas and numbered lists work too)', 'aria-label': 'Words', 'aria-describedby': 'setup-msg' });
  const msg = h('p', { class: 'msg err', role: 'alert', id: 'setup-msg' });
  for (const el of [name, words]) el.addEventListener('input', () => el.removeAttribute('aria-invalid')); // fixed field stops being flagged
  // Opened from a "try it now" link (#4633): the list page's words arrive in the URL fragment; pre-fill them.
  const shared = parseShare(location.hash);
  if (shared) words.value = shared.words.join('\n');
  const sharedNote = shared ? h('p', { class: 'tour-shared' }, `Someone shared ${shared.words.length} spelling words with you: they are in the box below. Add your child's name and press Save and play.`) : null;
  const go = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const list = wordsFrom(words.value);
      if (step === 'add-child' && !name.value.trim()) throw new FieldError(name, "Type your child's first name");
      if (!list.length) throw new FieldError(words, 'Type at least one word, or use the example words');
      if (step !== 'add-child') {
        await api('POST', '/api/kids/' + kidSel.value + '/weeks', { week_start: thisMonday(), words: list });
        location.href = '/?kid=' + encodeURIComponent(kidSel.value);
        return;
      }
      const { kid, weekError } = await addChildWithWords(api, { name: name.value, year: year.value, words: list, weekStart: thisMonday() });
      if (weekError) { await childExists(weekError, list, true); return; } // child saved, words not: keep the words for a retry
      location.href = '/?kid=' + encodeURIComponent(kid.slug);
    } catch (err) {
      msg.textContent = err.message; btn.disabled = false;
      for (const el of [name, words]) el.removeAttribute('aria-invalid');
      const field = err instanceof FieldError ? err.field : null;
      if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); } else btn.focus(); // API errors: focus must not be lost on <body>  // the alert is read out and the cursor is where to fix it
    }
  };
  return h('section', { class: 'panel', id: 'addchild', 'aria-labelledby': 'setup-h' },
    h('h2', { id: 'setup-h' }, 'Get started'),
    sharedNote,
    h('p', { class: 'note' }, "Add your child and this week's words, then press Save and play. The words are read aloud in a British voice."),
    step === 'add-child' ? h('div', { class: 'screenbox' }, labelled('First name', name), labelled('School year', year)) : labelled('Child', kidSel),
    labelled("This week's words", words),
    h('div', { class: 'screenbox' },
      h('button', { type: 'button', class: 'btn small', onclick: () => {
        const yr = step === 'add-child' ? year.value : ((kidList.find((k) => k.slug === kidSel.value) || {}).year ?? 2);
        fillExample(words, yr);
      } }, 'Use example words for this year'),
      h('button', { type: 'button', class: 'btn small solid', onclick: go }, 'Save and play')),
    msg);
}

/**
 * "Erase everything on this device": step 1 shows the warning and offers Export (the button reuses doExport);
 * step 2 asks the browser to confirm and only then calls store.eraseAll({ confirmed: true }).
 */
function eraseSection(store, kids, doExport, msg) {
  const step2 = h('div', { class: 'screenbox', hidden: true },
    h('button', { type: 'button', class: 'btn small danger', id: 'erase-confirm', onclick: async () => {
      if (!confirm('Erase every child, word, recording and score on this device? This cannot be undone. Have you saved a backup file?')) { msg.textContent = 'Nothing was erased.'; return; }
      try {
        await store.eraseAll({ confirmed: true });
        await render();
        await paintBackupBox('Everything on this device has been erased.');
      } catch (e) { msg.textContent = `Could not erase: ${e.message}`; }
    } }, 'Erase everything now'),
    h('button', { type: 'button', class: 'btn small', onclick: () => { step2.hidden = true; } }, 'Cancel'));
  return h('div', { class: 'erase', id: 'erasebox' },
    h('h3', {}, 'Erase everything on this device'),
    h('p', { class: 'note' }, 'Removes all children, words, recordings and progress from this device. We hold none of it, so it cannot be restored unless you have a backup file. Export first.'),
    h('div', { class: 'screenbox' },
      kids.length > 0 && h('button', { type: 'button', class: 'btn small', id: 'erase-export', onclick: () => doExport(null) }, 'Export everyone first'),
      h('button', { type: 'button', class: 'btn small danger', id: 'erase-start', onclick: () => { step2.hidden = false; } }, 'Erase everything on this device...')),
    step2);
}

/** (Re)draw the backup panel. `note` is shown in its status line afterwards (a redraw must not eat "Saved ..."). */
async function paintBackupBox(note = '') {
  const t = await transportReady;
  if (t.mode !== 'local') return;
  const box = document.getElementById('backupbox');
  const store = t.store;
  const persistence = await requestPersistence();
  const notices = storageNotices({
    persisted: persistence.persisted, installed: isInstalled(), platform: platformOf(navigator.userAgent, navigator.maxTouchPoints),
    lastExport: store.getMeta().last_export, hasData: store.hasData(),
  });
  const msg = h('p', { class: 'note', role: 'status' }, note);
  const doExport = async (slug) => {
    try {
      const out = await exportBackup(store, { kid: slug });
      await paintBackupBox(out.outcome === 'cancelled' ? 'Nothing was saved.' : `Saved ${out.filename}. Keep it somewhere safe (Files, WhatsApp, email).`);
    } catch (e) { msg.textContent = `Could not export: ${e.message}`; }
  };
  const kids = await api('GET', '/api/kids');
  box.replaceChildren(
    h('h2', {}, 'Back up / move to another device'),
    ...notices.map((n) => h('p', { class: n.level === 'warn' ? 'msg err' : 'note', 'data-notice': n.id }, n.text)),
    h('p', { class: 'note' }, 'Your words, recordings and progress live only on this device. A backup file keeps them safe, moves them to another phone or tablet, or shares words with another parent.'),
    kids.length ? backupChooser(store, kids, msg) : h('p', { class: 'note' }, 'Add a child first, then you can make a backup file.'),
    importSection(store, kids, msg),
    msg,
    eraseSection(store, kids, doExport, msg));
  box.hidden = false;
}

/**
 * "Make a backup file" (2026-11-12): the parent picks who (each child) and what (words always; recordings, scores
 * and stars, settings, names optional). Two presets: "Everything, for me" (keep it or move device) and "To share with
 * another parent" (words only: no child's voice, scores or names). exportBackup() does the cutting (pack.js
 * selectSnapshot); only a full backup resets the "time to back up" reminder.
 */
function backupChooser(store, kids, msg) {
  const box = (label, checked, extra = {}) => {
    const cb = h('input', { type: 'checkbox', checked, 'aria-label': label, ...extra });
    return { cb, row: h('label', { class: 'choice' }, cb, ' ', label) };
  };
  const who = kids.map((k) => ({ slug: k.slug, ...box(k.name, true) }));
  const words = box('Spelling words, every week (always included)', true, { disabled: true });
  const what = {
    recordings: box('Recordings (the voices saying the words)', true),
    results: box('Scores, stars and "I know it" marks', true),
    settings: box('Settings (voice, speed, school calendar)', true),
    names: box("Children's names", true),
  };
  const go = h('button', { type: 'button', class: 'btn small solid', id: 'backup-go' }, 'Export a full backup'); // label follows the choice
  const summary = h('p', { class: 'note', id: 'backup-summary' });
  let busy = false; // an export is in flight: the button stays off even if a box is ticked meanwhile
  const preset = (name) => { for (const k of CONTENT_KEYS) what[k].cb.checked = BACKUP_PRESETS[name][k]; update(); };
  const presetBtns = {
    everything: h('button', { type: 'button', class: 'btn small preset', 'aria-pressed': 'true', onclick: () => preset('everything') }, 'Everything, for me'),
    share: h('button', { type: 'button', class: 'btn small preset', 'aria-pressed': 'false', onclick: () => preset('share') }, 'To share with another parent'),
  };
  const choice = () => Object.fromEntries(CONTENT_KEYS.map((k) => [k, what[k].cb.checked]));
  function update() {
    const c = choice();
    const chosen = who.filter((x) => x.cb.checked);
    const all = CONTENT_KEYS.every((k) => c[k]);
    const none = CONTENT_KEYS.every((k) => !c[k]);
    go.textContent = none ? 'Export the words to share' : all && chosen.length === who.length ? 'Export a full backup' : 'Export the chosen parts';
    for (const [name, b] of Object.entries(presetBtns)) { // a preset looks pressed while the ticks match it
      const on = CONTENT_KEYS.every((k) => c[k] === BACKUP_PRESETS[name][k]);
      b.setAttribute('aria-pressed', String(on)); b.classList.toggle('on', on);
    }
    go.disabled = !chosen.length || busy;
    summary.textContent = chosen.length
      ? `The file will hold: ${describeContents(c)}, for ${c.names ? chosen.map((x) => x.row.textContent.trim()).join(', ') : `${chosen.length} child${chosen.length === 1 ? '' : 'ren'} (no names)`}.`
      : 'Tick at least one child.';
    if (!c.names && chosen.length === 1) summary.append(' The other parent picks which of their children gets the words.');
    if (!c.names && chosen.length > 1) summary.append(' To share, tick one child only: then the other parent can add the words to their own child (with more, they arrive as "Child 1", "Child 2").');
  }
  for (const x of [...who, ...Object.values(what)]) x.cb.addEventListener('change', update);
  go.onclick = async () => {
    if (busy) return;
    busy = true; go.disabled = true;
    try {
      const chosen = who.filter((x) => x.cb.checked).map((x) => x.slug);
      const out = await exportBackup(store, { kids: chosen.length === kids.length ? null : chosen, choice: choice() });
      await paintBackupBox(out.outcome === 'cancelled' ? 'Nothing was saved.'
        : CONTENT_KEYS.every((k) => choice()[k]) ? `Saved ${out.filename}. Keep it somewhere safe (Files, Drive, or send it to yourself).`
          : `Saved ${out.filename}. Send it to the other parent (WhatsApp, email). They import it under Back up > Import a file.`);
    } catch (e) { msg.textContent = `Could not export: ${e.message}`; busy = false; update(); }
  };
  update();
  return h('div', { class: 'backupchooser' },
    h('h3', {}, 'Make a backup file'),
    h('div', { class: 'presets' }, presetBtns.everything, presetBtns.share),
    h('ul', { class: 'note backuphelp' },
      h('li', {}, 'To keep a copy or move to a new phone or tablet: choose Everything, then save the file somewhere safe.'),
      h('li', {}, "To share with another parent: choose \"To share\" (words only: no recordings of your child's voice, no scores, no names), then send them the file."),
      h('li', {}, 'For one week of words, "Share list" on that week sends a link instead. That is quicker.')),
    h('fieldset', {}, h('legend', {}, 'Who'), ...who.map((x) => x.row)),
    h('fieldset', {}, h('legend', {}, 'What'), words.row, ...CONTENT_KEYS.map((k) => what[k].row)),
    summary, go);
}

/**
 * "Import a file": reads the file as soon as it is chosen and says what it holds. A one-child file (for example a
 * words-only list from another parent) can go under one of this device's children instead of becoming a new child.
 */
function importSection(store, kids, msg) {
  const file = h('input', { type: 'file', accept: '.spellings', 'aria-label': 'Backup file' });
  const info = h('p', { class: 'note', role: 'status' });
  const CHOOSE = '__choose';
  const target = h('select', { 'aria-label': 'Whose words' },
    h('option', { value: CHOOSE, hidden: true }, 'Choose whose words these are…'),
    h('option', { value: '' }, 'The children in the file'),
    kids.map((k) => h('option', { value: k.slug }, `Add the words to ${k.name}`)));
  const modeSel = h('select', { 'aria-label': 'How to import' },
    h('option', { value: 'merge' }, 'Add to what is here'), h('option', { value: 'replace' }, 'Replace everything here'));
  const sync = () => { // replace cannot be combined with "add to one child"
    const one = target.value && target.value !== CHOOSE;
    modeSel.querySelector('option[value=replace]').disabled = !!one;
    if (one) modeSel.value = 'merge';
  };
  target.addEventListener('change', sync);
  file.addEventListener('change', async () => {
    info.textContent = '';
    target.value = ''; target.disabled = false; sync(); // nothing from a previous file carries over
    const f = file.files && file.files[0];
    if (!f) return;
    try {
      const p = parsePack(new Uint8Array(await f.arrayBuffer()));
      const n = p.snapshot.kids.length;
      const c = contentsOf(p.snapshot, p.audio); // from the data, not the file's own label
      info.textContent = `This file holds ${describeContents(c)} for ${n} child${n === 1 ? '' : 'ren'} (${p.snapshot.kids.map((k) => k.name).join(', ')}).`;
      // Words shared by another parent (no names): they belong to one of your children. With one child that is the
      // obvious choice; with more, the parent must pick (review 2026-11-12: a silent default is too easy to get wrong).
      if (n === 1 && !c.names && kids.length) target.value = kids.length === 1 ? kids[0].slug : CHOOSE;
      target.disabled = n !== 1 || !kids.length;
      if (target.value === CHOOSE) info.append(' Choose which of your children gets the words.');
      sync();
    } catch (e) { info.textContent = e.message; }
  });
  const importBtn = h('button', { type: 'button', class: 'btn small solid', onclick: async () => {
    const f = file.files && file.files[0];
    if (!f) { msg.textContent = 'Choose a .spellings file first.'; return; }
    if (target.value === CHOOSE) { msg.textContent = 'Choose which of your children gets the words.'; target.focus(); return; }
    try {
      const preview = await previewImport(store, new Uint8Array(await f.arrayBuffer()), modeSel.value, { target: target.value || null });
      if (!confirm(`${preview.text}\n\nGo ahead?`)) { msg.textContent = 'Nothing changed.'; return; }
      await applyImport(store, preview);
      await render();
      await paintBackupBox('Imported. ' + preview.text.split('\n').pop());
    } catch (e) { msg.textContent = e.message; }
  } }, 'Import');
  return h('div', { class: 'importbox', id: 'import' },
    h('h3', {}, 'Import a file'),
    h('p', { class: 'note' }, 'A backup you made, or words another parent sent you.'),
    file, info, target, modeSel, importBtn);
}
paintBackupBox().then(() => {
  // /parent#import (from the kid screen's "Import a backup file"): the panel is painted late, so scroll by hand.
  if (location.hash === '#import') document.getElementById('import')?.scrollIntoView({ block: 'start' });
}).catch(() => { /* backup panel is optional; the rest of the page still works */ });

// Feedback (class trial, 2026-11): near the top so a parent finds it in seconds. feedback.js does the form + POST.
const feedbackBox = document.getElementById('feedbackbox');
if (feedbackBox) {
  feedbackBox.replaceChildren(
    h('h2', {}, 'Tell us what to improve'),
    h('p', { class: 'note' }, 'This is a free, home-made trial. Anything confusing, broken or missing? One line is enough.'),
    h('p', {}, feedbackButton({ page: 'parent', label: 'Send feedback' })));
  feedbackBox.hidden = false;
}

// Buy-me-a-coffee tip (Vikunja #3540): the existing Lemon Squeezy tip link, parent area only. It is a plain
// outbound link (no embed script, no request from this page, no data sent); the kid screens never show it.
// Lemon Squeezy is the merchant of record. Set here rather than in parent.html so the "no external origin"
// guard on the page markup stays strict.
const TIP_URL = 'https://marcriera.lemonsqueezy.com/checkout/buy/5fbc35a0-bd77-470f-8e9b-e184199a3f4f';
const tipBox = document.getElementById('tipbox');
if (tipBox) {
  tipBox.replaceChildren(
    h('h2', {}, 'Say thanks'),
    h('p', { class: 'note' }, 'Spellaloud is free and made by one parent. If it helps, you can buy me a coffee. Optional; nothing unlocks and nothing changes.'),
    h('p', {}, h('a', { class: 'btn small', href: TIP_URL, target: '_blank', rel: 'noopener noreferrer' }, '☕ Buy me a coffee')));
  tipBox.hidden = false;
}
const sourceLink = document.getElementById('sourcelink');
if (sourceLink) sourceLink.href = SOURCE_URL; // set here so parent.html keeps no external origin (no_third_party test)
document.getElementById('tourbtn')?.after(' ', feedbackButton({ page: 'parent', label: 'Feedback' }));
