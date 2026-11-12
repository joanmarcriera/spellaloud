// app.js - the kid app: Home, Playing, Mark, Result, Record, My stars.
// Vanilla ES module, no build step. Pure helpers live in lib.js (also unit-tested in node).
import { resolveVoice, loadVoices, speak, stopSpeech, fullySpeaking, sourceForWord, storedVoiceMode, recordingPlan } from './voice.js';
import { createTransport } from './transport.js';
import { feedbackButton } from './feedback.js';
import { onecardEnabled, cardState, cardMark, cardStep, cardDone, cardProgress } from './onecard.js';
import { typeModeEntry, typeResults, checkTyped } from './typemode.js';
import { bigSpellLabel } from './terms.js';
import { SPEEDS, markLayout, PAUSES, SCALE_KEY, parseScale, mixToMono, trimSilence, encodeWav, buildSchedule, starsFor, pctFor, weekLabel } from './lib.js';

const root = document.getElementById('app');
const kidParam = new URLSearchParams(location.search).get('kid');
let kidParamOverride = null; // set by the local-build kid picker when the choice was remembered
// Per-device size: ?scale=0.6..1.6 wins and is remembered in localStorage; otherwise the stored value; otherwise 1.
const scale = (() => {
  let stored = null;
  try { stored = parseScale(localStorage.getItem(SCALE_KEY)); } catch { /* storage blocked */ }
  const fromUrl = parseScale(new URLSearchParams(location.search).get('scale'));
  if (fromUrl != null) { try { localStorage.setItem(SCALE_KEY, String(fromUrl)); } catch { /* ignore */ } }
  const v = fromUrl ?? stored ?? 1;
  document.documentElement.style.setProperty('--scale', String(v));
  return v;
})();
const S = { kid: null, home_url: '/', today: null, mode: 'week', scope: null, terms: null, practice: null, progress: null, weeks: null };

// ---------------------------------------------------------------- tiny helpers
const ICON_SRC = {
  play: '<svg class="ic fill" viewBox="0 0 24 24"><path d="M7 4.5v15a1 1 0 0 0 1.5.9l12-7.5a1 1 0 0 0 0-1.8l-12-7.5A1 1 0 0 0 7 4.5z"/></svg>',
  pause: '<svg class="ic fill" viewBox="0 0 24 24"><rect x="5" y="4" width="5" height="16" rx="1.5"/><rect x="14" y="4" width="5" height="16" rx="1.5"/></svg>',
  stop: '<svg class="ic fill" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
  speaker: '<svg class="ic" viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>',
  mic: '<svg class="ic" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  home: '<svg class="ic" viewBox="0 0 24 24"><path d="M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10"/></svg>',
  star: '<svg class="ic fill" viewBox="0 0 24 24"><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z"/></svg>',
  check: '<svg class="ic" viewBox="0 0 24 24"><path d="M4 12.5l5 5L20 6.5"/></svg>',
  cross: '<svg class="ic" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  again: '<svg class="ic" viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 3-6.2M4 4v5h5"/></svg>',
  next: '<svg class="ic" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  left: '<svg class="ic" viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  right: '<svg class="ic" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
  list: '<svg class="ic" viewBox="0 0 24 24"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  flame: '<svg class="ic fill" viewBox="0 0 24 24"><path d="M12 2c1 4 5 6 5 11a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-4-1-6 1-10z"/></svg>',
};

/** Trusted inline SVG, built only from the ICON_SRC constants. h() inserts these as markup; every string child is text. */
class Icon { constructor(svg) { this.svg = svg; } }
const ICONS = Object.fromEntries(Object.entries(ICON_SRC).map(([k, v]) => [k, new Icon(v)]));
const starIcon = (on) => new Icon(ICON_SRC.star.replace('class="ic fill"', on ? 'class="on"' : 'class=""'));

/** Create an element: h('button', {class:'btn', onclick}, child, ...). String children are ALWAYS text nodes
 *  (word labels come from the API); only Icon instances become markup. Manual check: a label such as
 *  <img src=x onerror=alert(1)> shows up literally on Record and Mark and nothing executes. */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    if (c instanceof Icon) el.insertAdjacentHTML('beforeend', c.svg);
    else el.append(c);
  }
  return el;
}
/** Replace an element's content with freshly built children. */
function setContent(el, ...kids) { el.replaceChildren(...h('div', {}, ...kids).childNodes); }
const btn = (icon, text, cls, onclick, extra = {}) => h('button', { type: 'button', class: 'btn ' + (cls || ''), onclick, ...extra }, ICONS[icon], text && h('span', {}, text));

// All data goes through the transport: server.py's API in the family build, IndexedDB in the local build.
const transportReady = createTransport();
async function api(method, path, body) { return (await transportReady).api(method, path, body); }

let leaveHook = null; // cleanup for the current screen (timers, audio, recorder)
let keepMic = false;  // true while Record re-renders itself (next word / week): the mic stays open
// The microphone stream is shared by every word on the Record screen and released when leaving it.
const MIC = { stream: null, pending: null };
let prefersTap = false; // the last take was started with the Tap button: refocus it and use tap wording
function releaseMic() { MIC.stream?.getTracks().forEach((t) => t.stop()); MIC.stream = null; }
/** The open mic stream; re-acquired if it ended; never two getUserMedia calls at once. */
async function getMic() {
  if (MIC.stream?.active) return MIC.stream;
  if (!MIC.pending) {
    // Noise suppression and echo cancellation treat sibilants (the s in "spoil", the sh in "she") as
    // noise and wipe them out (measured ~-60 dB in saved clips), so both are off; gain control stays.
    MIC.pending = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } })
      .finally(() => { MIC.pending = null; });
  }
  MIC.stream = await MIC.pending;
  return MIC.stream;
}
function show(...nodes) {
  if (leaveHook) { try { leaveHook(); } catch (e) { console.error(e); } leaveHook = null; }
  if (!keepMic) releaseMic();
  const screen = h('div', { class: 'screen active' }, ...nodes);
  root.replaceChildren(screen);
  window.scrollTo(0, 0);
  return screen;
}

// ---------------------------------------------------------------- data loading
async function loadMe() {
  // vw/vh/dpr/scale ride along on this one request only so they show up in the server access log.
  const q = new URLSearchParams();
  if (kidParam || kidParamOverride) q.set('kid', kidParam || kidParamOverride);
  q.set('vw', innerWidth); q.set('vh', innerHeight); q.set('dpr', devicePixelRatio); q.set('scale', scale);
  const me = await api('GET', `/api/me?${q}`);
  S.kid = me.kid; savedSettings = { ...me.kid.settings }; S.home_url = me.home_url; S.today = me.today;
  document.documentElement.dataset.kid = me.kid.slug;
  document.title = `Spellings - ${me.kid.name}`;
}
const loadProgress = async () => { S.progress = await api('GET', `/api/kids/${S.kid.slug}/progress`); };
// scope = null (this term) | a term like '2026 Summer' | a school year like '2025-26'; only the term and tricky modes use it.
const fetchPractice = (mode, scope) => api('GET', `/api/kids/${S.kid.slug}/practice?mode=${mode}${scope && mode !== 'week' ? `&term=${encodeURIComponent(scope)}` : ''}`);
const loadTerms = async () => { S.terms = await api('GET', `/api/kids/${S.kid.slug}/terms`); };
let practiceReq = 0; // token: only the latest practice request may update S.mode / S.practice

// ------------------------------------------------------------------------ Home
const SETTING_CHOICES = {
  speed: { label: 'Speed', values: ['slow', 'normal', 'fast'], text: { slow: 'Slow', normal: 'Normal', fast: 'Fast' } },
  repeats: { label: 'Say it', values: [1, 2, 3], text: { 1: '1 time', 2: '2 times', 3: '3 times' } },
  pause: { label: 'Writing time', values: ['short', 'long'], text: { short: 'Short', long: 'Long' } },
  order: { label: 'Order', values: ['mix', 'inorder'], text: { mix: 'Mixed up', inorder: 'In order' } },
};
const MODE_TABS = [['week', 'This week'], ['term', 'Big Spell'], ['tricky', 'Tricky words']];

async function home() {
  show(h('p', { class: 'msg' }, 'Loading...'));
  const tok = ++practiceReq;
  try {
    const [, , practice] = await Promise.all([loadProgress(), loadTerms(), fetchPractice(S.mode, S.scope)]);
    if (tok !== practiceReq) return;
    S.practice = practice;
  } catch (e) { return fatal(e); }
  renderHome();
}

/** "I know this word now": it stops being tricky (until he misses it again); then run `done`. */
async function knowIt(wordId, done) {
  try { await api('POST', `/api/words/${wordId}/known`); } catch (e) { return fatal(e); }
  done();
}

async function pickMode(m, scope = S.scope) {
  const tok = ++practiceReq;
  try {
    const practice = await fetchPractice(m, scope);
    if (tok !== practiceReq) return; // a newer tap won; keep mode and words in step
    S.mode = m; S.scope = scope; S.practice = practice; S.homeErr = '';
  } catch (e) {
    if (tok !== practiceReq) return;
    S.homeErr = `Could not load the words: ${e.message}`;
  }
  renderHome();
}

/** Which term(s) Big Spell / Tricky words draw from. Hidden until there is more than this term to choose from. */
function termChips() {
  const t = S.terms;
  if (!t || t.terms.length + t.years.length < 2) return null;
  const opts = [[null, 'This term'], ...t.terms.filter((x) => x.key !== t.current).map((x) => [x.key, x.label]), ...t.years.map((x) => [x.key, x.label])];
  return h('div', { class: 'tabs terms', role: 'tablist', 'aria-label': 'Term' }, opts.map(([key, label]) =>
    h('button', { type: 'button', class: 'tab', role: 'tab', 'aria-selected': String((S.scope || null) === key), onclick: () => pickMode(S.mode, key) }, label)));
}

function renderHome() {
  const draft = loadDraft();
  const p = S.practice;
  const n = p.words.length;
  let note = n ? `${n} word${n === 1 ? '' : 's'}` : (S.mode === 'tricky' ? 'No tricky words — well done!' : 'No words with sound yet. Ask a grown-up, or record some.');
  if (p.skipped && n) note += ` (${p.skipped} without sound)`;
  // Local build, a child with no words at all (e.g. just set up from a bookmark): point a grown-up at Add words.
  const addWords = localBuild && S.mode === 'week' && n === 0 && !p.skipped && !S.homeErr;
  if (addWords) note = "No words yet. A grown-up can add this week's words.";
  if (S.homeErr) note = S.homeErr;
  // No British voice on this device (#6327): words without a recording cannot be read, so they must be recorded before dictation.
  const plan = recordingPlan(p.words, allVoices, voicesLoaded);
  if (plan.blocked && !S.homeErr) note = `This device has no British voice, so ${plan.record.length} word${plan.record.length === 1 ? ' needs' : 's need'} your voice. Record ${plan.record.length === 1 ? 'it' : 'them'} first.`;
  const play = plan.blocked
    ? h('button', { type: 'button', class: 'bigplay', onclick: recordScreen }, ICONS.mic, h('span', {}, `Record ${plan.record.length} word${plan.record.length === 1 ? '' : 's'}`))
    : h('button', { type: 'button', class: 'bigplay', disabled: n === 0, onclick: startPlaying }, ICONS.play, h('span', {}, 'Play'));
  show(
    // Everything important lives in the TOP bar: some mobile toolbars cover the bottom strip without
    // shrinking the viewport. The bar wraps to two rows on narrow screens.
    h('div', { class: 'topbar' },
      h('h1', { class: 'grow' }, `Hi ${S.kid.name}!`),
      h('span', { class: 'stat' }, ICONS.star, `${S.progress.stars}`),
      h('span', { class: 'stat' }, ICONS.flame, `${S.progress.streak} day${S.progress.streak === 1 ? '' : 's'}`),
      btn('mic', 'Record words', '', recordScreen),
      btn('star', 'My stars', '', starsScreen),
      btn('list', 'My weeks', '', weeksScreen),
      btn('home', 'Home', '', () => { location.href = S.home_url; }),
      feedbackButton({ page: 'kid', kid: S.kid.slug }), // for parents: files a note in Vikunja (feedback.js)
      h('a', { class: 'btn small grownups', href: '/parent' }, 'Grown-ups')),
    h('div', { class: 'center' },
      h('div', { class: 'tabs', role: 'tablist' }, MODE_TABS.map(([m, t]) =>
        h('button', { type: 'button', class: 'tab', role: 'tab', 'aria-selected': String(S.mode === m), onclick: () => pickMode(m) }, m === 'term' ? bigSpellLabel(t, S.terms, S.scope) : t))),
      S.mode !== 'week' && termChips(),
      play,
      // Experimental "type the word" mode (#5604): present only when the parent has switched the flag on.
      typeModeEntry(S.kid.settings) && btn('check', typeModeEntry(S.kid.settings).label, '', startTyping, { disabled: n === 0 || plan.blocked }),
      draft && btn('check', `Finish your check (${Object.keys(draft.marks).length}/${draft.words.length} marked)`, 'green',
        () => markScreen(draft.words, draft.mode, draft.settings || S.kid.settings)),
      h('p', { class: 'msg' + (S.homeErr ? ' err' : '') }, note),
      addWords && h('a', { class: 'btn solid', href: '/parent' }, 'Add words'),
      plan.blocked && h('a', { class: 'btn small', href: '/parent#voice-help' }, 'How to get a British voice'),
      S.mode === 'tricky' && n > 0 && h('div', { class: 'looklist' }, p.words.map((w) => h('div', { class: 'markrow' },
        h('span', { class: 'lbl' }, w.label),
        btn('check', 'I know it', 'green', () => knowIt(w.id, () => { p.words = p.words.filter((x) => x.id !== w.id); renderHome(); }))))),
      h('div', { class: 'chips' }, Object.entries(SETTING_CHOICES).map(([key, c]) =>
        h('button', { type: 'button', class: 'chip', onclick: () => cycleSetting(key) },
          h('small', {}, c.label), h('b', {}, c.text[S.kid.settings[key]]))))));
}

// Settings are saved one PUT at a time, latest wins; a failed save reverts the chips to the last saved values.
let savedSettings = null;
let flushing = false;
function cycleSetting(key) {
  const vals = SETTING_CHOICES[key].values;
  S.kid.settings = { ...S.kid.settings, [key]: vals[(vals.indexOf(S.kid.settings[key]) + 1) % vals.length] };
  S.homeErr = '';
  renderHome(); // optimistic: the chip changes at once
  flushSettings();
}
async function flushSettings() {
  if (flushing) return; // the running loop will pick up the newest value
  flushing = true;
  try {
    for (;;) {
      const snap = { ...S.kid.settings };
      if (JSON.stringify(snap) === JSON.stringify(savedSettings)) break;
      await api('PUT', `/api/kids/${S.kid.slug}/settings`, snap);
      savedSettings = snap;
    }
  } catch (e) {
    S.kid.settings = { ...savedSettings };
    S.homeErr = `Could not save that setting: ${e.message}`;
    if (document.querySelector('.bigplay')) renderHome(); // only if Home is still showing
  } finally { flushing = false; }
}

function fatal(e) {
  show(h('div', { class: 'center' }, h('p', { class: 'msg err' }, `Something went wrong: ${e.message}`), btn('again', 'Try again', 'solid', () => location.reload())));
}

// -------------------------------------------------------------------- Playing
/** A timer that can be paused and resumed without losing the time already waited. */
class PausableTimer {
  constructor() { this.id = null; this.fn = null; this.remaining = 0; this.started = 0; }
  set(ms, fn) { this.clear(); this.fn = fn; this.remaining = ms; this.resume(); }
  resume() {
    if (!this.fn || this.id) return;
    this.started = performance.now();
    this.id = setTimeout(() => { const f = this.fn; this.id = null; this.fn = null; f(); }, this.remaining);
  }
  pause() { if (this.id) { clearTimeout(this.id); this.id = null; this.remaining -= performance.now() - this.started; } }
  clear() { clearTimeout(this.id); this.id = null; this.fn = null; }
}

// One shared <audio> element for playback, created inside a tap so autoplay is allowed.
let audio = null;
// A 0.1 s silent WAV used to "unlock" the element inside the tap before any async work.
const SILENT = URL.createObjectURL(new Blob([encodeWav(new Float32Array(2205), 22050)], { type: 'audio/wav' }));
function unlockAudio() {
  if (!audio) {
    audio = new Audio();
    audio.preservesPitch = true; audio.mozPreservesPitch = true; audio.webkitPreservesPitch = true;
  }
  audio.src = SILENT;
  audio.play().catch(() => {});
  return audio;
}
function playWord(src, speed) {
  audio.onended = null; audio.onerror = null;
  audio.src = src;
  audio.preservesPitch = true;
  audio.defaultPlaybackRate = audio.playbackRate = SPEEDS[speed] || 1;
  return audio.play();
}
let curSay = null; // the word being read by the voice (for Pause)
let pausedSay = null; // a tablet-voice (Fully) word stopped by Pause: Continue reads it again from the start
let sayGen = 0; // bumps on every stop/new word so a cancelled utterance can never fall back or advance
const stopAudio = () => {
  sayGen++;
  if (audio) { audio.onended = null; audio.onerror = null; audio.pause(); }
  pausedSay = null;
  stopSpeech(globalThis.speechSynthesis); // also stops Fully Kiosk's TTS when the tablet voice is being read
};

// Word source (Vikunja #3537): parent picks per device on /parent. 'voice' reads the word with the best
// en-GB speech voice and falls back to the child's recording when the device has none.
let allVoices = []; // the device's voices, loaded once per page; the child's choice is resolved per word
let voicesLoaded = false; // an empty list only means "no British voice" once this is true (#6327)
const voiceReady = (async () => {
  try { allVoices = await loadVoices(globalThis.speechSynthesis); } catch { allVoices = []; }
  voicesLoaded = true;
  if (S.practice && document.querySelector('.bigplay')) renderHome(); // Home was drawn before the verdict: redraw
})();
/** Read one word: speech if the parent chose it and a voice exists, else the recording. Returns a promise. */
function sayWord(word, speed, onDone) {
  const gen = ++sayGen;
  pausedSay = null; // a new word replaces any word that Pause stopped
  // A broken clip fires both the <audio> error event and the play() rejection; a stale utterance must not advance either.
  let finished = false;
  const done = () => { if (finished || gen !== sayGen) return; finished = true; onDone(); };
  const clip = () => {
    // playWord clears the handlers, so set them after; a broken clip must not stall the dictation.
    const started = transportReady.then((t) => t.audioSrc(word.id)).then((src) => {
      if (gen !== sayGen) return undefined; // stopped while the clip was being looked up
      const p = playWord(src, speed);
      audio.onended = done; audio.onerror = done;
      return p;
    });
    return started.catch((e) => { if (!e || e.name !== 'AbortError') done(); });
  };
  // The parent's per-child choice (settings.voice) if this device still has it, else the best en-GB voice.
  const gbVoice = resolveVoice(allVoices, S.kid && S.kid.settings && S.kid.settings.voice);
  // Typed words have no clip: wait for the voice list, and skip the word if the device has no British voice.
  const typedOnly = word.has_audio === false;
  const choose = () => sourceForWord(word, { voice: resolveVoice(allVoices, S.kid && S.kid.settings && S.kid.settings.voice), prefer: storedVoiceMode() });
  if (typedOnly && !gbVoice) return voiceReady.then(() => { if (gen !== sayGen) return undefined; if (choose() === 'none') done(); else return sayWord(word, speed, onDone); });
  const source = choose();
  if (source === 'none') { done(); return Promise.resolve(); }
  if (source !== 'voice') return clip();
  // Silence any clip still playing from the previous word/Hear-again so it cannot overlap the voice.
  if (audio) { audio.onended = null; audio.onerror = null; audio.pause(); }
  curSay = { word, speed, onDone, gen };
  return speak(globalThis.speechSynthesis, gbVoice, word.label, { rate: SPEEDS[speed] || 1 }).then((ok) => {
    if (gen !== sayGen) return;      // stopped or superseded: do nothing (a cancel reports as an error)
    if (gbVoice.fully && pausedSay && pausedSay.gen === gen) return; // stopped by Pause: resumeAudio reads it again
    if (ok || typedOnly) done(); else clip();     // the voice failed on this device: use the child's recording instead
  });
}

let P = null; // active playing session
let waitingVoices = false; // a Play tap is waiting for the voice list (#6327)

/** Start a dictation. `again` replays a finished one ({sched, mode, settings}) in the same order. */
function startPlaying(again) {
  if (P || waitingVoices) return; // double tap: already starting
  if (!again?.sched && !voicesLoaded) { // voices still loading (up to 1.5 s on a device with none): decide after, never play a silent word (#6327)
    unlockAudio(); // still inside the tap
    waitingVoices = true;
    voiceReady.then(() => { waitingVoices = false; startPlaying(again); });
    return;
  }
  if (!again?.sched && recordingPlan(S.practice.words, allVoices, voicesLoaded).blocked) return recordScreen(); // never start a dictation with a silent word (#6327)
  unlockAudio(); // must happen synchronously inside the tap
  let sched, mode, settings;
  if (again?.sched) ({ sched, mode, settings } = again);
  else {
    const words = S.practice.words;
    if (!words.length) return;
    settings = { ...S.kid.settings }; mode = S.mode;
    sched = buildSchedule(words, { repeats: settings.repeats, order: settings.order, seed: (Date.now() & 0x7fffffff) });
  }
  P = { sched, i: 0, paused: false, phase: 'audio', timer: new PausableTimer(), run: 0, mode, settings, readyAt: performance.now() + 400 };
  const label = h('div', { class: 'word-count' });
  const fill = h('i');
  const pauseBtn = h('button', { type: 'button', class: 'btn solid pausebtn', 'aria-label': 'Pause', onclick: togglePause });
  Object.assign(P, { label, fill, pauseBtn });
  const skipped = again?.sched ? 0 : S.practice.skipped;
  show(
    h('div', { class: 'center' }, label, h('div', { class: 'bar' }, fill), pauseBtn,
      skipped > 0 && h('p', { class: 'msg' }, `${skipped} word${skipped === 1 ? ' has' : 's have'} no recording yet`),
      h('div', { class: 'row' },
        btn('speaker', 'Hear it again', '', hearAgain),
        btn('stop', 'Stop', 'danger', stopPlaying))));
  leaveHook = () => { if (P) { P.timer.clear(); P.run++; } stopAudio(); };
  paintPause();
  playStep(0);
}

function paintPause() {
  setContent(P.pauseBtn, P.paused ? ICONS.play : ICONS.pause);
  P.pauseBtn.setAttribute('aria-label', P.paused ? 'Continue' : 'Pause');
}

function playStep(i) {
  const { sched } = P;
  if (i >= sched.steps.length) return finishPlaying();
  const step = sched.steps[i];
  const run = ++P.run; // stale callbacks (after Hear again / Stop) compare against this and bail out
  P.i = i; P.phase = 'audio';
  P.label.textContent = `Word ${step.index + 1} of ${sched.words.length}`;
  P.fill.style.width = `${(step.index / sched.words.length) * 100}%`;
  const advance = () => {
    if (!P || run !== P.run) return;
    const next = sched.steps[i + 1];
    // Same word again: short gap. Otherwise (or after the last word): writing time.
    const gap = next && next.index === step.index ? 1500 : PAUSES[P.settings.pause] * 1000;
    P.phase = 'gap';
    P.timer.set(gap, () => playStep(i + 1));
    if (P.paused) P.timer.pause();
  };
  sayWord(step.word, P.settings.speed, advance);
  if (P.paused) pauseAudio();
}

// Taps in the first 400 ms after the Playing screen appears are ignored (a double tap on Play lands here).
const tooSoon = () => !P || performance.now() < P.readyAt;

const speaking = () => { try { return speechSynthesis.speaking; } catch { return false; } };
// Fully Kiosk's TTS cannot pause mid-word: Pause stops it (fully.stopTextToSpeech) and Continue reads the word again.
function pauseAudio() {
  audio.pause();
  if (fullySpeaking() && curSay) { pausedSay = curSay; stopSpeech(null); }
  else if (speaking()) speechSynthesis.pause();
}
function resumeAudio() {
  if (pausedSay) { const p = pausedSay; pausedSay = null; sayWord(p.word, p.speed, p.onDone); }
  else if (speaking()) speechSynthesis.resume();
  else audio.play().catch(() => {});
}

function togglePause() {
  if (tooSoon()) return;
  P.paused = !P.paused;
  if (P.paused) { pauseAudio(); P.timer.pause(); }
  else if (P.phase === 'audio') resumeAudio();
  else P.timer.resume();
  paintPause();
}

function hearAgain() {
  if (tooSoon()) return;
  P.timer.clear();
  const idx = P.sched.steps[P.i].index;
  const first = P.sched.steps.findIndex((s) => s.index === idx);
  P.paused = false; paintPause();
  playStep(first);
}

function stopPlaying() { if (tooSoon()) return; P.run++; P.timer.clear(); stopAudio(); P = null; home(); }

function finishPlaying() {
  const done = { sched: P.sched, mode: P.mode, settings: P.settings };
  P.timer.clear(); stopAudio(); P = null;
  doneScreen(done);
}

/** After the last word: the kid picks Play again (same words, same order) or Check my words. */
function doneScreen(done) {
  show(h('div', { class: 'center' },
    h('div', { class: 'score' }, 'All done!'),
    h('div', { class: 'row' },
      btn('again', 'Play again', '', () => startPlaying(done)),
      btn('check', 'Check my words', 'green', () => markScreen(done.sched.words, done.mode, done.settings)))));
}

// ------------------------------------------------------------------------ Mark
// An unfinished check survives Back / a closed tab: the marks are kept per kid in localStorage until Finish saves them.
const DRAFT_KEY = () => `spellings.draft.${S.kid.slug}`;
function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY()));
    return d && Array.isArray(d.words) && d.words.length && d.marks && typeof d.mode === 'string' ? d : null;
  } catch { return null; }
}
function saveDraft(d) { try { localStorage.setItem(DRAFT_KEY(), JSON.stringify(d)); } catch { /* storage blocked: no draft */ } }
function clearDraft() { try { localStorage.removeItem(DRAFT_KEY()); } catch { /* storage blocked */ } }

function markScreen(words, mode, settings) {
  const marks = new Map(); // word id -> 1 | 0
  const old = loadDraft();
  const sameWords = old && old.mode === mode && old.words.length === words.length && old.words.every((w) => words.some((x) => x.id === w.id));
  if (sameWords) for (const [id, v] of Object.entries(old.marks)) marks.set(Number(id), v);
  const persist = () => saveDraft({ mode, settings, words: words.map((w) => ({ id: w.id, label: w.label })), marks: Object.fromEntries(marks) });
  persist();
  if (onecardEnabled(location.search, safeLS())) return oneCardMark(words, mode, settings, marks, persist); // flag off by default (#3521)
  let inflight = false;    // a POST is in progress: Finish and the toggles stay disabled
  const toggles = [];
  const finish = btn('check', 'Finish', 'green', onFinish, { disabled: true });
  const rows = words.map((w) => {
    const tg = h('button', { type: 'button', class: 'btn toggle' }, h('span', {}, 'Tap to mark')); // named from the start; paint() replaces it
    const paint = () => {
      const v = marks.get(w.id);
      tg.className = 'btn toggle' + (v === 1 ? ' got' : v === 0 ? ' not' : '');
      setContent(tg, ...(v === 1 ? [ICONS.check, h('span', {}, 'Got it')] : v === 0 ? [ICONS.cross, h('span', {}, 'Not yet')] : [h('span', {}, 'Tap to mark')]));
      finish.disabled = inflight || marks.size < words.length;
      tg.disabled = inflight;
    };
    toggles.push(paint);
    tg.onclick = () => { if (inflight) return; marks.set(w.id, marks.get(w.id) === 1 ? 0 : 1); persist(); paint(); }; // unmarked -> Got it -> Not yet -> Got it
    paint();
    const sp = h('button', { type: 'button', class: 'btn', 'aria-label': 'Hear the word', onclick: () => { unlockAudio(); sayWord(w, settings.speed, () => {}); } }, ICONS.speaker);
    return h('div', { class: 'markrow' }, sp, h('span', { class: 'lbl' }, w.label), tg);
  });
  const errLine = h('p', { class: 'msg err', role: 'alert' });
  const lay = markLayout(rows.length); // one column under 8 words (#6673)
  // --rows lets the two-column grid fill down the first column, then the second (the order they were played).
  show(h('div', { class: 'topbar' }, btn('home', 'Back', '', home), h('h1', { class: 'grow' }, 'Check your words'), errLine, finish),
    h('div', { class: 'marklist' + (lay.cols === 1 ? ' one' : ''), style: `--rows:${lay.rows}` }, rows));
  leaveHook = stopAudio;

  async function onFinish() {
    if (inflight) return;
    inflight = true; errLine.textContent = ''; toggles.forEach((f) => f());
    try {
      const res = await api('POST', `/api/kids/${S.kid.slug}/sessions`, {
        mode, settings, results: words.map((w) => ({ word_id: w.id, correct: marks.get(w.id) })),
      });
      clearDraft();
      resultScreen(res);
    } catch (e) { inflight = false; toggles.forEach((f) => f()); errLine.textContent = `Could not save: ${e.message}`; }
  }
}

function safeLS() { try { return localStorage; } catch { return null; } }

/** M-B one-card marking (flag ?onecard=1): one word per screen, Got it / Not yet, then Finish. Same save path as the list. */
function oneCardMark(words, mode, settings, marks, persist) {
  if (!words.length) { // nothing to mark: no card to draw (w would be undefined), so say so and go home
    show(h('div', { class: 'center' }, h('p', { class: 'msg' }, 'No words to mark.'), btn('home', 'Back', 'solid', home)));
    return;
  }
  let st = cardState(words, Object.fromEntries(marks));
  let inflight = false;
  const errLine = h('p', { class: 'msg err', role: 'alert' });
  const draw = () => {
    const w = words.find((x) => x.id === st.ids[st.index]);
    const { marked, total } = cardProgress(st);
    const set = (v) => { if (inflight) return; marks.set(w.id, v); persist(); st = cardMark(st, w.id, v); draw(); };
    const finish = btn('check', 'Finish', 'green', onFinish, { disabled: inflight || !cardDone(st) });
    show(h('div', { class: 'topbar' }, btn('home', 'Back', '', home), h('h1', { class: 'grow' }, `Word ${st.index + 1} of ${total} · ${marked} marked`), errLine, finish),
      h('div', { class: 'center' },
        btn('speaker', 'Hear it', '', () => { unlockAudio(); sayWord(w, settings.speed, () => {}); }),
        h('div', { class: 'score' }, w.label),
        h('div', {}, btn('check', 'Got it', 'green', () => set(1)), btn('cross', 'Not yet', '', () => set(0))),
        h('div', {}, btn('left', 'Previous', '', () => { st = cardStep(st, -1); draw(); }), btn('right', 'Next', '', () => { st = cardStep(st, 1); draw(); }))));
    leaveHook = stopAudio;
  };
  async function onFinish() {
    if (inflight) return;
    inflight = true; errLine.textContent = '';
    try {
      const res = await api('POST', `/api/kids/${S.kid.slug}/sessions`, { mode, settings, results: words.map((w) => ({ word_id: w.id, correct: marks.get(w.id) })) });
      clearDraft();
      resultScreen(res);
    } catch (e) { inflight = false; errLine.textContent = `Could not save: ${e.message}`; draw(); }
  }
  draw();
}

// ------------------------------------------------------------------------ Type the word (#5604, flag typeMode)
/** Hear a word, type it, see right/wrong; at the end the same results go to /sessions as the Check screen posts (wrong = Not-yet). */
function startTyping() {
  const words = [...S.practice.words];
  if (!words.length) return;
  const mode = S.mode, settings = { ...S.kid.settings };
  const answers = {};
  const step = (i) => {
    const w = words[i];
    const input = h('input', { type: 'text', class: 'typebox', 'aria-label': 'Type the word', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: '40' });
    const msg = h('p', { class: 'msg', role: 'status' }, `Word ${i + 1} of ${words.length}`);
    const hear = () => { unlockAudio(); sayWord(w, settings.speed, () => {}); };
    let checked = false;
    const check = () => {
      if (checked) return;
      checked = true; input.disabled = true;
      answers[w.id] = input.value;
      const ok = checkTyped(input.value, w.label);
      msg.className = 'msg' + (ok ? '' : ' err');
      msg.textContent = ok ? 'Got it!' : `Not yet. It is spelt: ${w.label}`;
      next.hidden = false; checkBtn.hidden = true; next.focus();
    };
    const checkBtn = btn('check', 'Check', 'green', check);
    const next = btn('next', i + 1 < words.length ? 'Next' : 'Finish', 'solid', () => (i + 1 < words.length ? step(i + 1) : finish()), { hidden: true });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); check(); } });
    show(
      h('div', { class: 'topbar' }, btn('home', 'Back', '', home), h('h1', { class: 'grow' }, 'Type the word')),
      h('div', { class: 'center' }, btn('speaker', 'Hear the word', '', hear), input, msg, h('div', { class: 'row' }, checkBtn, next)));
    leaveHook = stopAudio;
    hear(); input.focus();
  };
  async function finish() {
    try {
      const res = await api('POST', `/api/kids/${S.kid.slug}/sessions`, { mode, settings, results: typeResults(words, answers) });
      resultScreen(res);
    } catch (e) { show(h('div', { class: 'center' }, h('p', { class: 'msg err', role: 'alert' }, `Could not save: ${e.message}`), btn('home', 'Back', 'solid', home))); }
  }
  step(0);
}

function resultScreen(r) {
  const stars = r.stars ?? starsFor(r.score, r.total);
  show(h('div', { class: 'center' },
    h('div', { class: 'score' }, `${r.score} / ${r.total}`),
    h('div', { class: 'stars' }, [1, 2, 3].map((n) => starIcon(n <= stars))),
    h('p', { class: 'msg' }, `${stars} star${stars === 1 ? '' : 's'}  ·  ${r.streak} day${r.streak === 1 ? '' : 's'} in a row`),
    btn('home', 'Back home', 'solid', home)));
}

// ---------------------------------------------------------------------- Record
const REC = { MIN_HOLD: 250, TAIL: 450, CAP: 5000, RATE: 44100, LEAD_MS: 350, PAD_MS: 200 };

async function recordScreen() {
  show(h('p', { class: 'msg' }, 'Loading...'));
  try { S.weeks = await api('GET', `/api/kids/${S.kid.slug}/weeks`); } catch (e) { return fatal(e); }
  if (!S.weeks.length) {
    show(h('div', { class: 'center' }, h('p', { class: 'msg' }, 'No words yet. Ask a grown-up to add this week\'s words.'), btn('home', 'Back', 'solid', home)));
    return;
  }
  // start on the current week: latest week_start <= today, else the earliest one
  let wi = S.weeks.reduce((acc, w, i) => (w.week_start <= S.today ? i : acc), -1);
  if (wi < 0) wi = 0;
  let di = Math.max(0, S.weeks[wi].words.findIndex((w) => !w.has_audio || w.audio_source === 'tts')); // first word still to record (a computer-voice clip still invites the child's own)
  recordWord(wi, di);
}

function recordWord(wi, di) {
  const week = S.weeks[wi];
  const word = week.words[di];
  // R is per screen; each press creates its own `take` (recorder, chunks, timers, discard flag),
  // so nothing can bleed from one press into the next.
  const R = { holding: false, busy: false, press: 0, take: null, gen: 0, tapMode: false };
  const status = h('p', { class: 'msg', role: 'status' }, 'Press and hold, or use Tap to record, then say the word.');
  const hold = h('button', { type: 'button', class: 'holdbtn', 'aria-label': 'Hold to talk' }, ICONS.mic, h('span', {}, 'Hold to talk'));
  // Tap-to-toggle alternative for screen-reader, switch and motor-access users: tap once to start, tap again to stop.
  const tap = h('button', { type: 'button', class: 'tapbtn', 'aria-pressed': 'false', 'aria-label': 'Tap to record' }, ICONS.mic, h('span', {}, 'Tap to record'));
  const after = h('div', { class: 'row' });
  const weekDate = new Date(week.week_start + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const dots = h('div', { class: 'dots' }, week.words.map((w, i) =>
    h('button', { type: 'button', class: 'dot' + (w.has_audio && w.audio_source !== 'tts' ? ' has' : '') + (i === di ? ' cur' : ''), 'aria-label': `Word ${i + 1}${w.has_audio && w.audio_source !== 'tts' ? ', recorded' : ''}`, 'aria-current': i === di ? 'true' : null, onclick: () => recordWord(wi, i) }, String(i + 1))));

  keepMic = true; // moving between words/weeks keeps the mic open; leaving Record releases it (see show)
  try {
    show(
      h('div', { class: 'topbar' },
        btn('home', 'Back', '', home),
        h('span', { class: 'grow' }),
        h('div', { class: 'weekpick' },
          btn('left', '', 'small', () => recordWord(wi - 1, 0), { disabled: wi === 0, 'aria-label': 'Earlier week' }),
          h('b', {}, `week of ${weekDate}`),
          btn('right', '', 'small', () => recordWord(wi + 1, 0), { disabled: wi === S.weeks.length - 1, 'aria-label': 'Later week' }))),
      h('div', { class: 'center' },
        word ? h('div', { class: 'reclabel' }, word.label) : h('p', { class: 'msg' }, 'This week has no words.'),
        word && hold, word && tap, status, after, dots));
  } finally { keepMic = false; }
  leaveHook = () => { R.gen++; R.holding = false; R.tapMode = false; if (R.take) endTake(R.take, true); stopAudio(); };
  if (!word) return;
  (prefersTap ? tap : hold).focus({ preventScroll: true }); // keyboard users land on the control they used last

  // Block the long-press menu / text selection on the hold button.
  hold.addEventListener('contextmenu', (e) => e.preventDefault());
  hold.addEventListener('selectstart', (e) => e.preventDefault());
  // A tap-mode take must survive the hold button losing focus or the pointer leaving it.
  const holdUp = () => { if (!R.tapMode) onUp(); };
  hold.addEventListener('pointerdown', onDown);
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) hold.addEventListener(ev, holdUp);
  // Keyboard / switch access: hold Space or Enter to talk, release to stop (same path as a finger press).
  hold.addEventListener('keydown', (e) => {
    if ((e.key !== ' ' && e.key !== 'Enter') || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    if (!e.repeat) onDown({ preventDefault() {}, pointerId: null });
  });
  hold.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') holdUp(); });
  hold.addEventListener('blur', holdUp);
  tap.addEventListener('click', async () => {
    if (R.tapMode && R.holding) { R.tapMode = false; syncTap(); say('Finishing...'); onUp(); return; }   // second tap: stop (tail keeps the last syllable)
    if (R.holding || R.busy) return;
    R.tapMode = true; prefersTap = true; syncTap();
    await onDown({ preventDefault() {}, pointerId: null });
    if (!R.holding) { R.tapMode = false; syncTap(); }                    // permission refused / unsupported
  });
  /** Keep the tap button's pressed state and label in step with a tap-mode take. */
  function syncTap() {
    const on = R.tapMode && R.holding;
    tap.setAttribute('aria-pressed', String(on));
    tap.classList.toggle('live', on);
    tap.lastChild.textContent = on ? 'Tap to stop' : 'Tap to record'; // visible cue only; the accessible name stays 'Tap to record' with aria-pressed
  }

  const say = (t, err) => { status.textContent = t; status.className = 'msg' + (err ? ' err' : ''); };
  const hint = () => say(prefersTap ? 'Tap once to start, then tap again after you say the word.' : 'Hold the button while you speak.', true);

  /** Stop a take now. discard=true throws its audio away; otherwise its onstop processes it. */
  function endTake(take, discard) {
    clearTimeout(take.tail); clearTimeout(take.cap);
    take.discard = take.discard || discard;
    hold.classList.remove('live');
    R.tapMode = false; syncTap();
    if (take.mr.state === 'recording') {
      if (!take.discard) R.busy = true; // set now: onstop fires later and a new press must not slip in
      take.mr.stop();
    }
  }

  async function onDown(e) {
    e.preventDefault();
    if (R.busy || R.holding) return;
    // A previous take still in its 300 ms tail: finish it properly now and ignore this press.
    if (R.take && R.take.mr.state === 'recording') { endTake(R.take, false); return; }
    R.holding = true;
    const press = ++R.press;
    try { hold.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
    after.replaceChildren();
    if (!navigator.mediaDevices?.getUserMedia) {
      R.holding = false;
      return say('The microphone needs a secure page (https). Ask a grown-up.', true);
    }
    let stream;
    try {
      stream = await getMic();
    } catch (err) {
      R.holding = false;
      return say(err.name === 'NotFoundError' ? 'No microphone found. Ask a grown-up.' : `The microphone is blocked (${err.name}). Ask a grown-up.`, true);
    }
    if (press !== R.press) return;       // a newer press took over while we waited
    if (!R.holding) return hint();       // let go while the permission box was open
    const take = { mr: null, chunks: [], discard: false, tail: null, cap: null, downAt: 0 };
    try {
      // A generous bitrate keeps the encoder from dropping the high band where s/sh live.
      try { take.mr = new MediaRecorder(stream, { audioBitsPerSecond: 128000 }); } catch { take.mr = new MediaRecorder(stream); }
    } catch {
      R.holding = false;
      return say("Recording isn't supported on this screen. Ask a grown-up.", true);
    }
    take.mr.ondataavailable = (ev) => { if (ev.data.size) take.chunks.push(ev.data); };
    take.mr.onstop = () => onTakeStopped(take);
    try { take.mr.start(); } catch {
      R.holding = false;
      return say("Recording isn't supported on this screen. Ask a grown-up.", true);
    }
    R.take = take;
    take.downAt = performance.now();
    hold.classList.add('live'); say(R.tapMode ? 'Listening... tap again when you have said the word.' : 'Listening...'); syncTap();
    take.cap = setTimeout(() => { R.holding = false; endTake(take, false); }, REC.CAP);
  }

  function onUp() {
    if (!R.holding) return;
    R.holding = false;
    const take = R.take;
    if (!take || take.mr.state !== 'recording') return;
    if (performance.now() - take.downAt < REC.MIN_HOLD) { endTake(take, true); return hint(); }
    take.tail = setTimeout(() => endTake(take, false), REC.TAIL); // keep the last syllable
  }

  async function onTakeStopped(take) {
    if (take.discard || take !== R.take) { if (take === R.take) R.busy = false; return; }
    const gen = R.gen;
    R.busy = true; hold.disabled = true; tap.disabled = true; say('Saving...');
    try {
      const wav = await processRecording(new Blob(take.chunks, { type: take.mr.mimeType }));
      if (!wav) { say('I did not hear anything. Try again, a bit closer.', true); return; }
      await (await transportReady).putAudio(word.id, wav); // throws with the server's message on failure
      word.has_audio = true;
      word.audio_source = 'child';
      dots.children[di].classList.add('has');
      dots.children[di].setAttribute('aria-label', `Word ${di + 1}, recorded`);
      if (gen !== R.gen) return;
      say('Listen...');
      unlockAudio();
      const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
      audio.onended = () => { URL.revokeObjectURL(url); say('Good! Again or next?'); };
      audio.src = url; audio.defaultPlaybackRate = audio.playbackRate = 1;
      audio.play().catch(() => say('Saved. Again or next?'));
      after.replaceChildren(
        btn('again', 'Again', '', () => { stopAudio(); after.replaceChildren(); say(prefersTap ? 'Use Tap to record, then say the word.' : 'Press and hold, then say the word.'); }),
        btn('next', 'Next', 'solid', () => {
          stopAudio();
          if (di + 1 < week.words.length) recordWord(wi, di + 1); else home();
        }));
    } catch (e) {
      say(`Could not save: ${e.message}`, true);
    } finally {
      R.busy = false; hold.disabled = false; tap.disabled = false;
      if (gen === R.gen) (prefersTap ? tap : hold).focus(); // disabling dropped keyboard focus; give it back for the next take
    }
  }
}

/** Blob (webm/mp4) -> mono -> trimmed (350 ms lead, 200 ms tail) -> 44.1 kHz -> 16-bit WAV ArrayBuffer, or null if silent. */
async function processRecording(blob) {
  const bytes = await blob.arrayBuffer();
  const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100);
  const decoded = await ctx.decodeAudioData(bytes);
  const chans = Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c));
  const trimmed = trimSilence(mixToMono(chans), decoded.sampleRate, { threshold: 0.02, padMs: REC.PAD_MS, leadMs: REC.LEAD_MS });
  if (!trimmed.length) return null;
  // Resample with an OfflineAudioContext (browser-quality filter) to 44.1 kHz.
  const len = Math.max(1, Math.ceil((trimmed.length * REC.RATE) / decoded.sampleRate));
  const off = new OfflineAudioContext(1, len, REC.RATE);
  const buf = off.createBuffer(1, trimmed.length, decoded.sampleRate);
  buf.copyToChannel(trimmed, 0);
  const src = off.createBufferSource();
  src.buffer = buf; src.connect(off.destination); src.start();
  const rendered = await off.startRendering();
  return encodeWav(rendered.getChannelData(0), REC.RATE);
}

// -------------------------------------------------------------------- My weeks
const loadHistory = () => api('GET', `/api/kids/${S.kid.slug}/history`);
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/** Every week, newest first: how often it was tried, how many words are tricky; play it or look at it. */
async function weeksScreen() {
  let hist;
  try { hist = await loadHistory(); } catch (e) { return fatal(e); }
  const rows = hist.weeks.map((w) => {
    const tried = w.sessions ? `tried ${plural(w.sessions, 'time')}` : 'not tried yet';
    const tricky = w.tricky ? ` · ${plural(w.tricky, 'tricky word')}` : '';
    return h('div', { class: 'weekrow' },
      h('div', { class: 'grow' },
        h('b', {}, `${w.id === hist.current ? 'This week' : 'Week of'} ${weekLabel(w.week_start)}`),
        h('small', {}, `${plural(w.words.length, 'word')} · ${tried}${tricky}`)),
      btn('play', 'Play', '', () => playWeek(w.id, false)),
      w.tricky > 0 && btn('play', 'Tricky', 'danger', () => playWeek(w.id, true)),
      btn('list', 'Look', '', () => lookScreen(w, hist)));
  });
  show(h('div', { class: 'topbar' }, btn('home', 'Back', '', home), h('h1', { class: 'grow' }, 'My weeks')),
    rows.length ? h('div', { class: 'weeklist' }, rows) : h('p', { class: 'msg' }, 'No weeks yet. Ask a grown-up to add some words.'));
}

/** Dictation of one chosen week (or only its tricky words); recorded as a "week" session like This week. */
async function playWeek(weekId, onlyTricky) {
  let practice;
  try { practice = await api('GET', `/api/kids/${S.kid.slug}/practice?mode=week&week=${weekId}${onlyTricky ? '&only=tricky' : ''}`); }
  catch (e) { return fatal(e); }
  if (!practice.words.length) { S.homeErr = 'No words with sound in that week yet.'; return home(); }
  S.mode = 'week'; S.practice = practice; S.homeErr = '';
  startPlaying();
}

const STATUS_FILTERS = [['all', 'All'], ['failing', 'Still failing'], ['shaky', 'Shaky'], ['solid', 'Always right'], ['new', 'Not tried']];
const STATUS_TEXT = Object.fromEntries(STATUS_FILTERS);

/**
 * Look & listen: the words of a week as cards (a grid on wide screens, one column on a phone), each with its
 * speaker, the word and a status pill; tap the speaker to hear one. Nothing is marked.
 * The filter chips sit in the top bar beside the title, so the cards get the rest of the height.
 */
function lookScreen(week, hist) {
  let filter = 'all';
  const list = h('div', { class: 'looklist wordgrid' });
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const paint = () => {
    const count = (f) => (f === 'all' ? week.words.length : week.words.filter((w) => w.status === f).length);
    setContent(tabs, ...STATUS_FILTERS.filter(([f]) => f === 'all' || count(f) > 0).map(([f, t]) =>
      h('button', { type: 'button', class: 'tab', role: 'tab', 'aria-selected': String(filter === f), onclick: () => { filter = f; paint(); } }, `${t} ${count(f)}`)));
    const words = week.words.filter((w) => filter === 'all' || w.status === filter);
    setContent(list, ...words.map((w) => h('div', { class: 'markrow wordcard' },
      h('button', { type: 'button', class: 'btn', 'aria-label': 'Hear the word', disabled: !w.has_audio,
        onclick: () => { unlockAudio(); sayWord(w, S.kid.settings.speed, () => {}); } }, ICONS.speaker),
      h('span', { class: 'lbl' }, w.label),
      h('span', { class: 'state' },
        h('span', { class: `pill ${w.status}` }, STATUS_TEXT[w.status] || 'Not tried'),
        w.history.length > 0 && h('span', { class: 'hist', role: 'img', 'aria-label': 'Recent results' },
          w.history.map((c) => h('i', { class: c ? 'pip got' : 'pip not' }, c ? ICONS.check : ICONS.cross)))),
      w.tricky && btn('check', 'I know it', 'green', () => knowIt(w.id, () => { w.tricky = false; week.tricky -= 1; paint(); })))));
  };
  show(h('div', { class: 'topbar lookbar' }, btn('home', 'Back', '', weeksScreen),
      h('h1', { class: 'grow' }, `Week of ${weekLabel(week.week_start)}`), tabs),
    list);
  leaveHook = stopAudio;
  paint();
}

// -------------------------------------------------------------------- My stars
async function starsScreen() {
  try { await loadProgress(); } catch (e) { return fatal(e); }
  const pr = S.progress;
  show(
    h('div', { class: 'topbar' }, btn('home', 'Back', '', home), h('span', { class: 'grow' })),
    h('div', { class: 'center' },
      h('div', { class: 'score' }, ICONS.star, ` ${pr.stars}`),
      h('p', { class: 'msg' }, `${pr.streak} day${pr.streak === 1 ? '' : 's'} in a row`),
      pr.sessions.length
        ? h('div', { class: 'chart', role: 'img', 'aria-label': 'Score of your last sessions' }, pr.sessions.map((s) => {
            const pct = pctFor(s.correct, s.total);
            return h('div', { class: 'b', style: `height:${Math.max(pct, 2)}%` }, h('span', {}, `${pct}%`));
          }))
        : h('p', { class: 'msg' }, 'Play a game to see your scores here.')));
}

// ------------------------------------------------------------------------ boot
// Local (browser-only) build: no ?kid= means the device may hold several children, so ask who is playing.
// The last pick is remembered per device. The family build keeps its hostname/?kid= rules and never shows this.
const LAST_KID_KEY = 'spellings.lastKid';
let localBuild = false; // true on the browser-only build (set by pickKid, read by Home)
/** Remember the pick for this device, then open that child's page. */
function openKid(slug) {
  try { localStorage.setItem(LAST_KID_KEY, slug); } catch { /* ignore */ }
  location.href = `/?kid=${encodeURIComponent(slug)}`;
}
/**
 * Local build, ?kid=<slug> names a child this device does not have (a bookmark or kiosk tile on a fresh tablet):
 * a friendly set-up screen instead of the error screen. ?name=Ash (optional) is the display name.
 * kidsetup.js is imported only here, so the family build and every normal launch never fetch it.
 */
function unknownKidScreen(plan, setUpKid) {
  document.documentElement.dataset.kid = plan.slug; // the child's own colour, as on their Home
  const msg = h('p', { class: 'msg err', role: 'alert' });
  const primary = h('button', { type: 'button', class: 'btn solid big', onclick: async (ev) => {
    const btn = ev.currentTarget;
    if (btn.disabled) return;
    btn.disabled = true; // one tap = one child, even on a slow tablet
    msg.textContent = '';
    try { location.href = `/?kid=${encodeURIComponent((await setUpKid(api, plan)).slug)}`; }
    catch (e) { msg.textContent = `Could not set up ${plan.name}: ${e.message}`; btn.disabled = false; }
  } }, `Set up ${plan.name} here`);
  show(
    h('div', { class: 'topbar' }, h('span', { class: 'grow' }), h('a', { class: 'btn small grownups', href: '/parent' }, 'Grown-ups')),
    h('div', { class: 'center' },
      h('h1', {}, h('b', {}, plan.name), " isn't set up on this tablet yet."),
      primary,
      h('p', { class: 'msg' }, "Progress is saved on this device only. After set-up, a grown-up adds the words."),
      msg,
      plan.others.length > 0 && h('p', { class: 'msg' }, 'Or play as:'),
      plan.others.length > 0 && h('div', { class: 'chips' }, plan.others.map((k) => h('button', { type: 'button', class: 'btn', onclick: () => openKid(k.slug) }, k.name)))));
  primary.focus();
}

async function pickKid() {
  const t = await createTransport();
  localBuild = t.mode === 'local';
  if (t.mode !== 'local') return true;
  if (kidParam) {
    const kids = await t.api('GET', '/api/kids');
    if (kids.some((k) => k.slug === kidParam)) return true;
    const { kidSetupPlan, setUpKid } = await import('./kidsetup.js');
    const plan = kidSetupPlan(kidParam, new URLSearchParams(location.search).get('name'), kids);
    if (plan.existing) { location.replace(`/?kid=${encodeURIComponent(plan.existing.slug)}`); return false; } // ?kid=Ash -> ash
    unknownKidScreen(plan, setUpKid);
    return false;
  }
  const kids = await t.api('GET', '/api/kids');
  if (!kids.length) {
    show(h('div', { class: 'center' },
      h('h1', {}, 'Welcome to Spellaloud'),
      h('p', { class: 'msg' }, 'Weekly spelling practice: the words are read aloud, your child writes them and marks themselves. A grown-up sets it up in about two minutes.'),
      // The tour is for the browser-only build; the family (LAN) build seeds its children and has no tour.
      t.mode === 'local' ? h('a', { class: 'btn solid big', href: '/parent?tour=1' + location.hash }, 'Start the tour') : null,
      h('p', {}, h('a', { class: 'btn small', href: '/parent' + location.hash }, t.mode === 'local' ? 'Skip to the Grown-ups page' : 'Grown-ups'))));
    return false;
  }
  let last = null;
  try { last = localStorage.getItem(LAST_KID_KEY); } catch { /* storage blocked */ }
  if (kids.length === 1 || (last && kids.some((k) => k.slug === last) && new URLSearchParams(location.search).get('who') == null)) {
    kidParamOverride = kids.length === 1 ? kids[0].slug : last;
    return true;
  }
  show(h('div', { class: 'topbar' }, h('h1', { class: 'grow' }, 'Who is playing?'), h('a', { class: 'btn small grownups', href: '/parent' }, 'Grown-ups')),
    h('div', { class: 'center' }, kids.map((k) => h('button', { type: 'button', class: 'btn solid', onclick: () => openKid(k.slug) }, k.name))));
  return false;
}

(async () => {
  try { if (!(await pickKid())) return; await loadMe(); } catch (e) { return fatal(e); }
  home();
})();
