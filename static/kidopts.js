// kidopts.js - grown-up switches per child and the hold-to-explain tips on the child's Home (2026-11-12, Marc's
// feedback). The switches ride in kid.settings like typeMode, stored only when true (absent = today's behaviour),
// so they travel in backup files:
//   noKnowIt     hide the child's "I know it" button (Look, Tricky words): only practice takes a word out of Tricky
//   noSelfCheck  no "Got it / Not yet" check after the dictation: the child shows their book to a grown-up
//   controls     small Previous word / Next word / Finish buttons during the dictation, for a grown-up
// Tips: a grown-up who rests the mouse on a mode tab or a setting chip for HOVER_MS, or presses and holds it for
// HOLD_MS, sees what it does. A child tapping never sees them. The top half is pure (node tests); attachTip() is DOM.
//
// Usage (app.js):  knowItShown(S.kid.settings) && btn(...);  attachTip(chipEl, settingTip('pause'));

import { PAUSES, SPEEDS } from './lib.js';

export const KID_FLAGS = ['noKnowIt', 'noSelfCheck', 'controls'];
export const knowItShown = (s) => !(s && s.noKnowIt === true);
export const selfCheckOn = (s) => !(s && s.noSelfCheck === true);
export const controlsOn = (s) => !!s && s.controls === true;

/** The flags from a settings body that are boolean true (what the store and backup keep). */
export function cleanKidFlags(b) {
  const out = {};
  for (const k of KID_FLAGS) if (b && b[k] === true) out[k] = true;
  return out;
}

/** Grown-up page labels for the switches (parent.js), in display order. */
export const FLAG_LABELS = {
// `ticked`: the checkbox shows ticked when the flag is set (controls) or when it is NOT set (the two "off" flags).
  noKnowIt: { ticked: false, text: (n) => `Let ${n} press "I know it" to remove a word from Tricky words`,
    hint: 'Off: a word leaves Tricky words only after it is right twice in a row in a test.' },
  noSelfCheck: { ticked: false, text: (n) => `${n} checks their own words after the test (Got it / Not yet)`,
    hint: (n) => `Off: ${n} shows their book to you instead, and no stars or scores are recorded.` },
  controls: { ticked: true, text: () => 'Show grown-up buttons during the test',
    hint: 'Small Previous word / Next word / Finish now buttons under the test. For you, not your child.' },
};

export const HOVER_MS = 2000; // mouse resting on a tab or chip
export const HOLD_MS = 1200;  // finger pressed and held
const TIP_SHOW_MS = 7000;

const MODE_TIPS = {
  week: "This week: plays this week's words, one at a time.",
  term: 'Big Spell: plays every word from this term (or another term you pick), mixed together. A bigger test, like the end-of-term one.',
  tricky: 'Tricky words: only the words got wrong recently. A word leaves the list after it is right twice in a row.',
};
export const modeTip = (mode) => MODE_TIPS[mode] || '';

/** Tip text for a Home chip; the numbers come from lib.js, so they stay true if the timings change. */
export function settingTip(key) {
  const pct = (v) => `${Math.round(v * 100)}%`;
  switch (key) {
    case 'speed': return `Speed: how fast each word is said. Slow = ${pct(SPEEDS.slow)}, Normal = ${pct(SPEEDS.normal)}, Fast = ${pct(SPEEDS.fast)} of normal speed.`;
    case 'repeats': return 'Say it: how many times each word is said (1, 2 or 3), with a short gap between.';
    case 'pause': return `Writing time: the time to write each word before the next one. Short = ${PAUSES.short} seconds, Long = ${PAUSES.long} seconds.`;
    case 'order': return 'Order: Mixed up shuffles the words every time; In order plays them as they were typed.';
    default: return '';
  }
}

/**
 * Step index for "Previous word" (delta -1) / "Next word" (+1) from step `i` of a schedule whose steps carry the
 * word `index` (each word may be said several times): the first step of the neighbouring word, clamped at the first
 * word; -1 means "past the last word" (finish).
 */
export function jumpTarget(steps, i, delta) {
  const cur = steps[i] ? steps[i].index : 0;
  const want = cur + delta;
  if (want < 0) return steps.findIndex((s) => s.index === cur);
  const j = steps.findIndex((s) => s.index === want);
  return j; // -1 when there is no such word
}

// ---------------------------------------------------------------------------------------------- DOM
let openTip = null;
/** Close the open tip (also called by app.js show() on every screen change). */
export function hideTip() { if (openTip) { openTip.remove(); openTip = null; } }

let swallowEl = null; // the element whose next click a long press must swallow
let docWired = false;
/** One set of document listeners: any new press or key closes a tip; the swallow runs in the document's capture
 *  phase, which comes before the element's own click handler in every browser (older WebViews included). */
function wireDocument() {
  if (docWired || typeof document === 'undefined') return;
  docWired = true;
  document.addEventListener('pointerdown', (e) => { if (!openTip || !e.target.closest || !e.target.closest('.holdtip')) hideTip(); }, true);
  document.addEventListener('keydown', hideTip, true);
  document.addEventListener('click', (e) => {
    if (swallowEl && swallowEl.contains(e.target)) { e.stopImmediatePropagation(); e.preventDefault(); }
    swallowEl = null;
  }, true);
}

function showTip(el, text) {
  hideTip();
  if (!el.isConnected) return; // the screen was redrawn while the timer ran: nothing to point at
  const tip = document.createElement('div');
  tip.className = 'holdtip';
  tip.setAttribute('role', 'tooltip');
  tip.textContent = text;
  document.body.append(tip);
  const r = el.getBoundingClientRect();
  const w = Math.min(280, innerWidth - 16);
  tip.style.width = `${w}px`;
  const cx = r.left + r.width / 2; // centred on the target, clamped 8 px from the edges; the arrow points at it
  const left = Math.max(8, Math.min(innerWidth - w - 8, cx - w / 2));
  tip.style.left = `${left}px`;
  tip.style.setProperty('--arrow', `${Math.max(14, Math.min(w - 14, cx - left))}px`);
  const below = r.bottom + 10 + tip.offsetHeight < innerHeight;
  tip.classList.toggle('above', !below);
  tip.style.top = `${below ? r.bottom + 10 + scrollY : r.top - 10 - tip.offsetHeight + scrollY}px`;
  openTip = tip;
  setTimeout(() => { if (openTip === tip) hideTip(); }, TIP_SHOW_MS);
}

/**
 * Explain `el` after a long hover (mouse) or a long press (touch/pen). A long press shows the tip INSTEAD of the
 * tap (the click that follows is swallowed), so holding a chip never changes the setting. Screen readers get the
 * text at once through aria-description.
 */
export function attachTip(el, text) {
  if (!text) return el;
  wireDocument();
  el.setAttribute('aria-description', text);
  let timer = null;
  let lastPointer = 'mouse';
  const clear = () => { clearTimeout(timer); timer = null; };
  el.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { clear(); timer = setTimeout(() => showTip(el, text), HOVER_MS); } });
  el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') clear(); });
  el.addEventListener('pointerdown', (e) => {
    lastPointer = e.pointerType;
    clear();
    if (swallowEl === el) swallowEl = null; // a fresh press is never swallowed by an older long press
    if (e.pointerType === 'mouse') return; // a mouse click acts at once, as before
    timer = setTimeout(() => { swallowEl = el; showTip(el, text); }, HOLD_MS);
  });
  // After a long press the click (if any) comes at once; if none comes (finger drifted, or Android cancelled the
  // press for a menu or a scroll), forget the swallow so the next tap or key press works (review 2026-11-12).
  const release = (e) => {
    if (e.pointerType === 'mouse') return;
    clear();
    if (swallowEl === el) setTimeout(() => { if (swallowEl === el) swallowEl = null; }, 400);
  };
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  // A long touch press must not open the browser menu; a right-click on a computer still works.
  el.addEventListener('contextmenu', (e) => { if (lastPointer !== 'mouse') e.preventDefault(); });
  return el;
}
