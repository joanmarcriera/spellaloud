// voice.js - British (en-GB) word reading via the Web Speech API (Vikunja #3537).
// Free, offline on most devices. Reviews of competitor apps (docs/validation/03-review-gap-mining.md)
// show the voice is the thing people notice: odd stress, homophones read without context, words
// skipped. So we only auto-pick a real en-GB voice, never silently fall back to a US one, and
// fall back to the child's own recording (or tell the parent) instead.
// Pure helpers take the voice list / synth as arguments so node tests can pass fakes.

/** macOS novelty voices that are en-GB-tagged or en-tagged but unusable for spelling. */
const NOVELTY = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|jester|organ|pipe organ|superstar|trinoids|whisper|wobble|zarvox)\b/i;
/** Names known to sound good, best first (substring, case-insensitive). */
const PREFERRED = ['google uk english female', 'microsoft sonia', 'microsoft libby', 'serena', 'kate', 'daniel', 'martha', 'google uk english male', 'microsoft ryan'];

/**
 * Fully Kiosk Browser (Android WebView, UA "; wv)") exposes no Web Speech voices, but its JavaScript interface
 * adds a global `fully` with text-to-speech (https://www.fully-kiosk.com/docs/en/api/javascript, PLUS licence, the
 * "JavaScript Interface" setting on). When that bridge is there we offer ONE synthetic on-device en-GB voice, so the
 * picker, recording plan and status line treat the tablet as having a British voice.
 */
export const FULLY_VOICE = Object.freeze({ name: 'Tablet voice (English UK)', lang: 'en-GB', localService: true, default: false, fully: true });
/** The `fully` bridge, or null (desktop, phones, the family build: it is never touched there). */
export function fullyBridge(g = globalThis) {
  return g && typeof g.fully?.textToSpeech === 'function' ? g.fully : null;
}
/** The voice list plus the tablet voice when the bridge exists (once). */
const withFully = (voices) => {
  const list = voices || [];
  return fullyBridge() && !list.some((v) => v && v.fully) ? [...list, FULLY_VOICE] : list;
};

/** Normalise 'en_GB' / 'EN-gb' to 'en-gb'. */
export const langOf = (v) => String((v && v.lang) || '').replace('_', '-').toLowerCase();

/**
 * Score a voice: higher is better; -1 means "do not use". Only on-device voices (localService === true)
 * qualify: a network voice would send the word off the device, which the app says it never does.
 */
export function scoreVoice(v) {
  if (langOf(v) !== 'en-gb' || v.localService !== true || NOVELTY.test(v.name || '')) return -1;
  let s = 10;
  const name = (v.name || '').toLowerCase();
  const i = PREFERRED.findIndex((p) => name.includes(p));
  if (i >= 0) s += 20 - i; // earlier in the list = better
  s += 5; // on-device (the only kind that qualifies): works offline
  if (/enhanced|premium|natural/i.test(v.name || '')) s += 8;
  if (/compact/i.test(v.name || '')) s -= 3;
  if (v.default) s += 1;
  return s;
}

/** Best en-GB voice from speechSynthesis.getVoices(), or null if there is none. Stable on ties. */
export function pickVoice(voices) {
  let best = null;
  let bestScore = -1;
  for (const v of withFully(voices)) {
    const s = scoreVoice(v);
    if (s > bestScore) { best = v; bestScore = s; }
  }
  return best;
}

/**
 * Green/red line for the voice help (Marc 2026-11-08). `voice` = pickVoice(...) result or null, `ua` = navigator.userAgent.
 * An Android WebView ("; wv)" in the UA, e.g. Fully Kiosk) exposes no speech voices at all, so installing one cannot help there.
 */
export function voiceStatus(voice, ua = '') {
  const webview = /;\s*wv\)/.test(ua);
  if (voice) return { ok: true, webview, text: `\u2713 British voice ready on this device (${voice.name}).` };
  return { ok: false, webview, text: webview
    ? '\u2717 No British voice here. This is an app\'s built-in browser (for example Fully Kiosk), which cannot use the device\'s voices, so installing one will not help on this screen. Record the words in your own voice, or open the site in Chrome.'
    : '\u2717 No British voice in this browser yet. Install one with the steps below, then reload this page.' };
}

/** Every usable en-GB voice, best first, one per name (what the parent picker lists). */
export function gbVoices(voices) {
  const seen = new Set();
  return withFully(voices).filter((v) => scoreVoice(v) >= 0 && !seen.has(v.name) && seen.add(v.name))
    .sort((a, b) => scoreVoice(b) - scoreVoice(a));
}

/** Longest voice name we store (a setting, carried in the export pack). */
export const VOICE_NAME_MAX = 120;
/** A stored voice name is '' (automatic) or a short string without control characters. */
export const validVoiceName = (n) => typeof n === 'string' && n.length <= VOICE_NAME_MAX && !/[\u0000-\u001f]/.test(n);

/**
 * The voice to speak with for a child: their chosen en-GB voice when this device still has it,
 * otherwise the best en-GB voice (null if none). The choice is never applied to a non-en-GB voice.
 */
export function resolveVoice(voices, chosenName) {
  if (chosenName) {
    const hit = gbVoices(voices).find((v) => v.name === chosenName);
    if (hit) return hit;
  }
  return pickVoice(voices);
}

/**
 * Decide how to read a word. prefer: 'voice' | 'recording' (parent setting).
 * Returns 'voice' | 'recording' | 'none'. A word with no clip and no voice is skipped (the existing
 * "skipped" counter on the playing screen).
 */
export function chooseSource({ hasRecording, voice, prefer = 'voice' }) {
  if (prefer === 'recording') return hasRecording ? 'recording' : voice ? 'voice' : 'none';
  return voice ? 'voice' : hasRecording ? 'recording' : 'none';
}

/**
 * Source for one practice word. A word the API marks has_audio:false (typed, never recorded; only the
 * browser build lists these, #4631) is read with the en-GB voice whatever the parent preference, and
 * is 'none' (skipped) when the device has no such voice. Otherwise as chooseSource.
 */
export function sourceForWord(word, { voice, prefer = 'voice' } = {}) {
  return chooseSource({ hasRecording: !(word && word.has_audio === false), voice, prefer });
}

/** True when the device has at least one usable (on-device en-GB) voice: the one the app would read words with. */
export const hasBritishVoice = (voices) => pickVoice(voices) !== null;

/** A word with no recording needs one when the device has no British voice to read it (#6327). */
export const needsRecording = (word, hasVoice) => !!word && word.has_audio === false && !hasVoice;

/**
 * What Home should do with this practice list on this device (#6327). `loaded` says the voice list has been
 * read: before that an empty list is not a verdict, so nothing is blocked. With no voice, unrecorded words go
 * to `record` (prompt to record them), the rest stay `playable`, and Play is `blocked` until `record` is empty
 * so a silent word is never presented.
 */
export function recordingPlan(words, voices, loaded) {
  const noVoice = !!loaded && !hasBritishVoice(voices);
  const record = noVoice ? words.filter((w) => needsRecording(w, false)) : [];
  const playable = words.filter((w) => !record.includes(w));
  return { noVoice, record, playable, blocked: record.length > 0 };
}

/**
 * getVoices() is empty until the browser has loaded them (Chrome fires 'voiceschanged').
 * Resolves with the list, or [] after timeoutMs.
 */
export function loadVoices(synth, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const have = synth && synth.getVoices ? synth.getVoices() : [];
    if (have.length || !synth || !synth.addEventListener || fullyBridge()) return resolve(have); // with the Fully bridge there is nothing to wait for
    const done = () => { clearTimeout(t); synth.removeEventListener('voiceschanged', done); resolve(synth.getVoices()); };
    const t = setTimeout(done, timeoutMs);
    synth.addEventListener('voiceschanged', done);
  });
}

/**
 * Say `text` with `voice`. rate follows the speed setting (0.55/1/1.25; speech is clamped to 0.5..1.4
 * because extreme rates distort). Resolves true when finished, false on error or if it never ends
 * (some Android WebViews never fire `end`, so a timeout guards it). `Utterance` is injectable.
 * The tablet voice (voice.fully) goes through fully.textToSpeech instead, see speakFully.
 */
export function speak(synth, voice, text, { rate = 1, Utterance = globalThis.SpeechSynthesisUtterance, timeoutMs = 8000, estimateMs } = {}) {
  if (voice && voice.fully) return speakFully(text, estimateMs);
  return new Promise((resolve) => {
    if (!synth || !Utterance || !voice) return resolve(false);
    const u = new Utterance(text);
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = Math.min(1.4, Math.max(0.5, rate));
    let finished = false;
    const finish = (ok) => { if (finished) return; finished = true; clearTimeout(t); resolve(ok); };
    const t = setTimeout(() => { try { synth.cancel(); } catch { /* ignore */ } finish(false); }, timeoutMs);
    u.onend = () => finish(true);
    u.onerror = () => finish(false);
    synth.cancel(); // drop anything queued (Chrome can wedge on a stale queue)
    synth.speak(u);
  });
}

// ---- Fully Kiosk TTS. fully.textToSpeech(text, locale) has no rate parameter, so Speed only changes the gaps.
// Speech end = ttsUtteranceDone/Error, registered once via fully.bind(event, jsString); Fully evals the string here.
let fullyPending = null; // { settle(ok), started } for the word being read
let fullyBound = null; // the `fully` the events were registered on

/** Called by the bound strings. Done/Error count only after this word's Start (a stop of the previous word must not end it). */
const fullyEvent = (kind) => {
  const p = fullyPending;
  if (p && kind === 'start') p.started = true;
  else if (p && p.started) p.settle(kind === 'done');
};

/** Register the three events once; false when this Fully build cannot (the estimate then ends the word). */
function bindFullyEvents(fully) {
  if (fullyBound === fully) return true;
  try {
    globalThis.__spellingsFullyTts = fullyEvent; // only ever set where the Fully bridge exists
    for (const k of ['Start', 'Done', 'Error']) fully.bind('ttsUtterance' + k, `__spellingsFullyTts('${k.toLowerCase()}')`);
    fullyBound = fully;
    return true;
  } catch { return false; }
}

/** Rough speaking time without a done event: about 700 ms + 90 ms per character. */
export const estimateSpeechMs = (text) => 700 + 90 * String(text || '').length;

/** True while a Fully word is being read (Pause then has something to stop). */
export const fullySpeaking = () => fullyPending !== null;

function speakFully(text, estimateMs) {
  return new Promise((resolve) => {
    const fully = fullyBridge();
    if (!fully) return resolve(false);
    if (fullyPending) fullyPending.settle(false); // superseded
    const events = bindFullyEvents(fully);
    const settle = (ok) => { if (fullyPending !== p) return; fullyPending = null; clearTimeout(timer); resolve(ok); };
    const p = { settle, started: false };
    fullyPending = p;
    const est = estimateMs ?? estimateSpeechMs(text);
    const timer = setTimeout(() => settle(true), events ? est + 2500 : est); // with events only a safety net
    try { fully.textToSpeech(String(text), 'en_GB'); } catch { settle(false); }
  });
}

/** Silence everything: the browser's speech queue and, if a Fully word is being read, Fully's TTS. No `fully` call otherwise. */
export function stopSpeech(synth) {
  try { synth && synth.cancel(); } catch { /* no speech support */ }
  const p = fullyPending;
  if (!p) return;
  try { fullyBridge()?.stopTextToSpeech(); } catch { /* ignore */ }
  p.settle(false);
}

/** Per-device parent setting (localStorage, like the screen scale): which source reads the words. */
export const VOICE_MODE_KEY = 'spellings.voice';
/** 'voice' (en-GB speech, the default) or 'recording' (a parent chose recordings first). With no British voice on the
 *  device chooseSource plays the recording anyway, so the default never silences a recorded word. */
export function parseVoiceMode(raw) { return raw === 'recording' ? 'recording' : 'voice'; }
/** Read the stored mode; storage may be blocked, then the default 'voice'. */
export function storedVoiceMode(storage = globalThis.localStorage) {
  try { return parseVoiceMode(storage.getItem(VOICE_MODE_KEY)); } catch { return 'voice'; }
}
