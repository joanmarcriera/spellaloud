// tour.js - the guided tour for grown-ups (browser-only build, class launch 2026-11-12).
// Eight short cards in a <dialog>: welcome, add the first child, add this week's words, how the words are read
// (British voice for this device, or record your own), share the words with other parents (WhatsApp from a phone),
// back up / move to another device (and install on the home screen), how feedback works, and where to start.
// It starts by itself on a brand-new device (no child yet) and can be replayed any time from the parent page
// ("Take the tour") or with /parent?tour=1. The top half is pure and DOM-free (node tests cover it); openTour()
// builds the dialog and gets every side effect (api, export, voice) from its caller, so nothing here is global.
// Text is set with textContent only (tests/no_html_sinks.test.mjs).
//
// Usage (parent.js):  if (shouldAutoStart({...})) openTour(deps);   button: onclick = () => openTour(deps)

/** localStorage key: 'done' or 'closed' once the tour has been seen, so it does not reopen by itself. */
export const TOUR_KEY = 'spellings.tour';
/** Public source code, linked from the last card and the parent page. */
export const SOURCE_URL = 'https://github.com/joanmarcriera/spellaloud';

export function tourSeen(storage = globalThis.localStorage) {
  try { return !!storage.getItem(TOUR_KEY); } catch { return false; } // storage blocked: behave as a first visit
}
export function markTour(value, storage = globalThis.localStorage) {
  try { storage.setItem(TOUR_KEY, value); } catch { /* storage blocked: the tour may reopen next time, harmless */ }
}

/**
 * Open the tour by itself? Always for ?tour=1; otherwise only on the browser-only build, with no child yet,
 * when it has not been seen on this device. The family (LAN) build seeds its children, so it never auto-starts.
 */
export function shouldAutoStart({ mode, kids, seen, search = '' }) {
  if (new URLSearchParams(search).get('tour') === '1') return true;
  return mode === 'local' && Array.isArray(kids) && kids.length === 0 && !seen;
}

/** Which device the steps should talk about. iPadOS reports itself as a Mac with touch points. */
export function devicePlatform(ua = '', maxTouchPoints = 0) {
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/CrOS/.test(ua)) return 'chromeos';
  if (/Windows/.test(ua)) return 'windows';
  if (/Macintosh/.test(ua)) return 'mac';
  return 'other';
}

export const PLATFORM_NAME = { ios: 'iPhone or iPad', android: 'Android phone or tablet', windows: 'Windows computer', mac: 'Mac', chromeos: 'Chromebook', other: 'this device' };

/** How to install an English (UK) voice, for this device only (parent.html #voice-help lists every device). */
export const VOICE_STEPS = {
  ios: ['Open Settings > Accessibility > Spoken Content > Voices > English.', 'Choose English (UK), pick a voice (for example Daniel or Kate) and tap the download arrow.', 'Come back here and reload the page.'],
  android: ['Open Settings > System > Languages & input > Text-to-speech output (the button below may take you there).', 'Choose the Google engine, open its settings, then Install voice data > English (United Kingdom).', 'Come back here and reload the page.'],
  windows: ['Open Settings > Time & language > Speech > Manage voices > Add voices.', 'Add English (United Kingdom).', 'Come back here and reload the page.'],
  mac: ['Open System Settings > Accessibility > Spoken Content > System Voice > Manage Voices.', 'Download an English (United Kingdom) voice.', 'Come back here and reload the page.'],
  chromeos: ['Open Settings > Accessibility > Text-to-Speech > Voices.', 'Under English choose English (United Kingdom) and let it download.', 'Come back here and reload the page.'],
  other: ['This browser may only have online voices, which the app does not use (they would send each word to the internet).', 'Use a phone, tablet or computer with an English (UK) voice installed, or record the words yourself.'],
};
/** A settings shortcut where the platform allows a web page to open one (iOS and ChromeOS do not). */
export const VOICE_LINK = {
  android: 'intent:#Intent;action=com.android.settings.TTS_SETTINGS;end',
  windows: 'ms-settings:speech',
  mac: 'x-apple.systempreferences:com.apple.preference.universalaccess?SpeakableItems',
};

/** "Add to home screen": the app then opens like any other and the browser is less likely to clear its data. */
export const INSTALL_STEPS = {
  ios: 'In Safari tap the Share button (the square with an arrow), then "Add to Home Screen".',
  android: 'In Chrome tap the menu (three dots), then "Add to Home screen" or "Install app".',
  windows: 'In Chrome or Edge, click the install icon at the right of the address bar (or the menu > Install).',
  mac: 'In Chrome click the install icon in the address bar; in Safari choose File > Add to Dock.',
  chromeos: 'Click the install icon at the right of the address bar.',
  other: 'Use your browser menu: "Install app" or "Add to Home screen".',
};

/** The text that goes with a shared list (WhatsApp shows it above the link). */
export function shareMessage(link, title = '') {
  return `Spelling words${title ? ` (${title})` : ''} for Spellaloud. Open the link to add them for your child: ${link}`;
}
/** WhatsApp's own "send this text" link. Opening it is a navigation the parent taps; nothing is fetched from here. */
export function whatsappUrl(text) {
  return 'https://wa.me/?text=' + encodeURIComponent(text);
}

/** The cards, in order. `id` is what openTour() renders; the titles are tested so a step cannot vanish silently. */
export const TOUR_STEPS = [
  { id: 'welcome', title: 'Welcome to Spellaloud' },
  { id: 'child', title: 'Add your child' },
  { id: 'words', title: "Add this week's words" },
  { id: 'voice', title: 'How the words are read aloud' },
  { id: 'share', title: 'Share the words with other parents' },
  { id: 'backup', title: 'Keep a copy, or move to another device' },
  { id: 'feedback', title: 'Tell us what to improve' },
  { id: 'done', title: 'All set' },
];

// ---------------------------------------------------------------------------------------------------------------
// DOM part: only runs when openTour() is called.

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}
const yearName = (y) => (Number(y) === 0 ? 'Reception' : `Year ${y}`);
const yearSelect = (sel = 2) => el('select', { 'aria-label': 'School year' }, [0, 1, 2, 3, 4, 5, 6].map((y) => el('option', { value: y, selected: y === sel }, yearName(y))));
const field = (text, control) => el('label', { class: 'field' }, el('span', { class: 'fieldlabel' }, text), control);
const steps = (list) => el('ol', { class: 'tour-steps' }, list.map((s) => el('li', {}, s)));

/**
 * Open the tour. deps: { api, toast, store (local mode) | null, exportBackup, buildShareLink, thisMonday, nextMonday,
 * sampleForYear, parseWordList, loadVoices, pickVoice, setVoiceMode, feedbackButton, onChange (re-render the page),
 * pageUrl (the /parent URL a shared link opens), sharedWords (words from a shared link this page was opened with, or
 * null: they pre-fill the words card so a parent who got a link from the class group only presses Save) }.
 * Resolves when the dialog closes.
 */
export function openTour(deps) {
  const platform = devicePlatform(navigator.userAgent, navigator.maxTouchPoints);
  // `action`: the card's own job (add the child, save the words). Next runs it and only moves on if it worked, so a
  // name or list typed into the card is never lost by pressing Next. Skip moves on without it.
  // `busy`: a card is being rendered or its action is running; every nav button is off meanwhile, so a double tap
  // can never run an action twice (a second child) or render two cards out of order. `seq` drops stale renders.
  const state = { i: 0, kids: [], kid: null, week: null, changed: false, action: null, busy: false, seq: 0, finished: false };
  const dlg = el('dialog', { class: 'tour', 'aria-label': 'Guided tour' });
  const body = el('div', { class: 'tour-body' });
  const count = el('p', { class: 'tour-count note' });
  const back = el('button', { type: 'button', class: 'btn small', onclick: () => go(state.i - 1) }, 'Back');
  const next = el('button', { type: 'button', class: 'btn small solid', onclick: async () => {
    if (state.busy) return;
    const action = state.action;
    if (action) {
      setBusy(true);
      let ok = false;
      try { ok = await action.run(); } catch { ok = false; }
      if (!ok) { setBusy(false); next.focus(); return; } // the card shows why; nothing moved
    }
    go(state.i + 1);
  } }, 'Next');
  const skip = el('button', { type: 'button', class: 'btn small', onclick: () => go(state.i + 1) }, 'Skip');
  function setBusy(b) { state.busy = b; for (const x of [back, next, skip]) x.disabled = b; }
  const shut = el('button', { type: 'button', class: 'btn small tour-x', 'aria-label': 'Close the tour', onclick: () => finish('closed') }, 'Close');
  dlg.append(el('div', { class: 'tour-top' }, count, shut), body, el('div', { class: 'screenbox tour-nav' }, back, skip, next));
  document.body.append(dlg);

  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  function finish(how) {
    if (state.finished) return; // Esc then Close, or Close twice
    state.finished = true;
    markTour(how);
    if (typeof dlg.close === 'function' && dlg.open) dlg.close();
    dlg.remove();
    // Always refresh the page: an action may still have been finishing when Close was pressed.
    if (deps.onChange) deps.onChange({ sharedSaved: state.sharedSaved });
    resolveDone(how);
  }
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish('closed'); }); // Esc

  async function refreshKids() {
    state.kids = await deps.api('GET', '/api/kids');
    if (!state.kid || !state.kids.some((k) => k.slug === state.kid.slug)) state.kid = state.kids[state.kids.length - 1] || null;
    if (state.kid) {
      const weeks = await deps.api('GET', `/api/kids/${state.kid.slug}/weeks`);
      state.week = weeks.filter((w) => w.words && w.words.length).pop() || null; // newest week with words
    } else state.week = null;
  }

  async function go(i) {
    const seq = ++state.seq;
    state.pendingAction = null; // nothing parked by the previous card may reach this one
    setAction(null); // the old card's job must not run again while the next card loads
    setBusy(true);
    const target = Math.max(0, Math.min(TOUR_STEPS.length - 1, i));
    const step = TOUR_STEPS[target];
    let kids;
    try {
      try { await refreshKids(); } catch (e) { deps.toast(e.message, true); }
      kids = (await RENDER[step.id]()).filter((c) => c != null && c !== false);
    } catch (e) {
      state.pendingAction = null;
      kids = [el('p', { class: 'msg err', role: 'alert' }, `This step could not load (${e.message}). Press Next or close the tour.`)];
    }
    if (seq !== state.seq || state.finished) return; // a newer go() or Close won
    state.i = target;
    count.textContent = `Step ${state.i + 1} of ${TOUR_STEPS.length}`;
    back.hidden = state.i === 0;
    next.hidden = state.i === TOUR_STEPS.length - 1;
    if (!state.pendingAction) setAction(null); else { setAction(state.pendingAction); }
    state.pendingAction = null;
    body.replaceChildren(el('h2', { id: 'tour-h', tabindex: '-1' }, step.title), ...kids);
    dlg.setAttribute('aria-label', step.title);
    setBusy(false);
    body.querySelector('h2').focus();
  }

  /** Give the card a job for Next ({label, run, skippable}) or none (plain Next). While a card is being built
   *  (busy), the job is parked and go() installs it once that card is the one on screen. */
  function offerAction(a) { if (state.busy) state.pendingAction = a; else setAction(a); }
  function setAction(a) {
    state.action = a;
    next.textContent = a ? a.label : (state.i === 0 ? 'Start' : 'Next');
    skip.hidden = !(a && a.skippable);
  }

  const msgLine = () => el('p', { class: 'msg', role: 'alert' }); // errors and confirmations both read out at once
  const needKid = () => el('p', { class: 'note' }, 'Add a child first (press Back), then come back to this step.');

  const RENDER = {
    welcome: async () => [
      deps.sharedWords && deps.sharedWords.length && !state.kids.length
        ? el('p', { class: 'tour-shared' }, `Someone shared ${deps.sharedWords.length} spelling words with you. Press Start: the tour adds your child and puts these words in for you.`)
        : null,
      el('p', {}, 'Each week you type the spelling words from school. The app reads them out one by one, your child writes them down, then checks and marks their own answers.'),
      el('ul', { class: 'tour-points' },
        el('li', {}, 'Free, no account, no adverts.'),
        el('li', {}, "Private: your child's name, words, recordings and scores stay on this device. Nothing is uploaded."),
        el('li', {}, 'Two minutes: this tour adds your child and this week\'s words with you.')),
      el('p', { class: 'note' }, 'You can close the tour at any time and replay it later from the Grown-ups page ("Take the tour").'),
    ],

    child: async () => {
      const name = el('input', { type: 'text', maxlength: 30, placeholder: 'e.g. Ava', autocomplete: 'off' });
      const year = yearSelect(2);
      const msg = msgLine();
      const add = {
        label: 'Add child and continue', skippable: state.kids.length > 0,
        run: async () => {
          if (!name.value.trim()) { msg.className = 'msg err'; msg.textContent = "Type your child's first name."; name.focus(); return false; }
          try {
            state.kid = await deps.api('POST', '/api/kids', { name: name.value, year: Number(year.value) });
            state.changed = true;
            return true; // on to the words for this child
          } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; return false; }
        },
      };
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); next.click(); } });
      const form = el('div', { class: 'tour-form' },
        el('div', { class: 'screenbox' }, field('First name', name), field('School year', year)), msg);
      const intro = el('p', { class: 'note' }, 'First name only is fine. The school year picks the example words. You can change both later.');
      if (!state.kids.length) { offerAction(add); return [intro, form]; }
      form.hidden = true;
      const carry = el('p', { class: 'note' }, `Or press Next to carry on with ${state.kid.name}.`);
      return [el('p', {}, `Already on this device: ${state.kids.map((k) => `${k.name} (${yearName(k.year)})`).join(', ')}.`),
        el('button', { type: 'button', class: 'btn small', onclick: (e) => {
          if (state.busy) return; // mid-transition: this card is on its way out
          form.hidden = false; e.currentTarget.hidden = true; offerAction(add); name.focus();
          carry.textContent = `Or press Skip to carry on with ${state.kid.name}.`;
        } }, 'Add another child'),
        form, carry];
    },

    words: async () => {
      if (!state.kid) return [needKid()];
      const kidSel = state.kids.length > 1
        ? el('select', { 'aria-label': 'Child' }, state.kids.map((k) => el('option', { value: k.slug, selected: k.slug === state.kid.slug }, k.name)))
        : null;
      const current = () => state.kids.find((k) => k.slug === (kidSel ? kidSel.value : state.kid.slug)) || state.kid;
      const date = el('input', { type: 'date', value: deps.thisMonday(), 'aria-label': 'Week starting' });
      const words = el('textarea', { rows: 6, placeholder: 'One word per line (commas and numbered lists work too)', 'aria-label': 'Words' });
      const msg = msgLine();
      if (deps.sharedWords && deps.sharedWords.length && !state.week) {
        words.value = deps.sharedWords.join('\n');
        words.dataset.shared = words.value;
        msg.textContent = `${deps.sharedWords.length} words came with the link you opened. Check them, then save.`;
      }
      const example = el('button', { type: 'button', class: 'btn small', onclick: () => {
        if (words.value.trim() && words.value.trim() !== words.dataset.example) { msg.textContent = 'Your own words are in the box. Clear it first to use the examples.'; return; }
        words.value = deps.sampleForYear(current().year).join('\n'); words.dataset.example = words.value.trim();
        msg.className = 'msg'; msg.textContent = `Example words for ${yearName(current().year)} added. Edit them as you like.`;
      } }, 'Use example words');
      offerAction({
        label: 'Save and continue', skippable: true,
        run: async () => {
          const r = deps.parseWordList(words.value);
          if (!r.words.length && state.week) return true; // nothing typed, a week already there: keep it
          if (!r.words.length) { msg.className = 'msg err'; msg.textContent = 'Type at least one word, or use the example words.'; words.focus(); return false; }
          if (r.tooLong.length) { msg.className = 'msg err'; msg.textContent = `"${r.tooLong[0].slice(0, 20)}…" is too long: put one word per line.`; return false; }
          try {
            state.kid = current();
            await deps.api('POST', `/api/kids/${state.kid.slug}/weeks`, { week_start: date.value, words: r.words });
            state.changed = true;
            if (words.dataset.shared && words.value === words.dataset.shared) state.sharedSaved = true; // parent.js clears #sl=
            return true;
          } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; return false; }
        },
      });
      return [
        el('p', { class: 'note' }, 'Type or paste the list from school (from the reading record, the class page or the school email).'),
        kidSel && field('Child', kidSel),
        field('Week starting', date),
        el('div', { class: 'screenbox' },
          el('button', { type: 'button', class: 'btn small', onclick: () => { date.value = deps.thisMonday(); } }, 'This week'),
          el('button', { type: 'button', class: 'btn small', onclick: () => { date.value = deps.nextMonday(); } }, 'Next week')),
        field('Words', words),
        el('div', { class: 'screenbox' }, example), msg,
        state.week ? el('p', { class: 'note' }, `${state.kid.name} already has ${state.week.words.length} words for the week of ${state.week.week_start}. Leave the box empty and press Next to keep them.`) : null,
        el('p', { class: 'note' }, 'Every week after this: Grown-ups > your child > Add week. "Next week" lets you load the list as soon as school sends it.'),
      ];
    },

    voice: async () => {
      let voice = null;
      try { voice = deps.pickVoice(await deps.loadVoices(globalThis.speechSynthesis)); } catch { /* none */ }
      const msg = msgLine();
      const own = [
        el('h3', {}, 'Or record the words yourselves'),
        el('p', {}, "On your child's screen press Record words, then hold the big button (or tap once to start and once to stop) and say each word. A parent's voice or the child's own both work well."),
        el('p', { class: 'note' }, 'Recordings stay on this device. With "Recordings first", a word you recorded plays in your recording and the rest in the British voice.'),
      ];
      const NOW = { voice: 'Now: the British voice reads every word on this device.', recording: 'Now: your recordings first, the British voice for words you have not recorded.' };
      const pick = (mode) => {
        deps.setVoiceMode(mode);
        for (const [b, m] of [[vBtn, 'voice'], [rBtn, 'recording']]) { b.classList.toggle('solid', m === mode); b.setAttribute('aria-pressed', String(m === mode)); }
        msg.textContent = NOW[mode];
      };
      const vBtn = el('button', { type: 'button', class: 'btn small', onclick: () => pick('voice') }, 'British voice for every word');
      const rBtn = el('button', { type: 'button', class: 'btn small', onclick: () => pick('recording') }, 'Recordings first');
      if (voice) {
        const cur = deps.storedVoiceMode();
        for (const [b, m] of [[vBtn, 'voice'], [rBtn, 'recording']]) { b.classList.toggle('solid', m === cur); b.setAttribute('aria-pressed', String(m === cur)); }
        msg.textContent = NOW[cur];
        return [
          el('p', { class: 'vstatus ok' }, `✓ This ${PLATFORM_NAME[platform]} has a British voice (${voice.name}).`),
          el('div', { class: 'screenbox' }, vBtn, rBtn),
          msg,
          el('p', { class: 'note' }, 'Prefer another British voice? Pick one per child on the Grown-ups page under "Word voice".'),
          ...own,
        ];
      }
      const link = VOICE_LINK[platform];
      return [
        el('p', { class: 'vstatus' }, `No British voice on this ${PLATFORM_NAME[platform]} yet. Two choices:`),
        el('h3', {}, 'Install a free British voice (once, about 2 minutes)'),
        steps(VOICE_STEPS[platform]),
        link ? el('p', {}, el('a', { class: 'btn small', href: link }, 'Open the voice settings')) : null,
        el('p', { class: 'note' }, 'Steps for other devices are on the Grown-ups page under "Get a British voice on this device". The app never uses online voices.'),
        ...own,
      ];
    },

    share: async () => {
      if (!state.week) {
        return [el('p', {}, 'Once you have saved a week of words you can send them to other parents in the class, so they do not have to type them.'), needKid()];
      }
      const when = new Date(state.week.week_start + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      const title = `Week of ${when}`;
      const link = deps.buildShareLink(deps.pageUrl, state.week.words.map((w) => w.label), title);
      const n = (link.match(/[#&]w=/g) || []).length; // a link holds at most 60 words (share.js MAX_WORDS)
      const text = shareMessage(link, title);
      const msg = msgLine();
      return [
        el('p', {}, `Send ${state.kid.name}'s ${n === state.week.words.length ? n : `first ${n}`} words (${when}) to the class group. Another parent opens the link, and the words are offered to add for their own child.`),
        el('p', { class: 'note' }, "The link holds the words only: never your child's name, recordings or scores."),
        el('div', { class: 'screenbox' },
          navigator.share ? el('button', { type: 'button', class: 'btn small solid', onclick: async () => {
            try { await navigator.share({ title: 'Spelling words', text: shareMessage('', title).replace(/: $/, '.'), url: link }); }
            catch (e) { if (e.name !== 'AbortError') msg.textContent = 'Could not open the share menu. Use WhatsApp or Copy link.'; }
          } }, 'Share…') : null,
          el('a', { class: 'btn small', href: whatsappUrl(text), target: '_blank', rel: 'noopener noreferrer' }, 'Send on WhatsApp'),
          el('button', { type: 'button', class: 'btn small', onclick: async () => {
            try { await navigator.clipboard.writeText(link); msg.textContent = 'Link copied. Paste it into the group.'; }
            catch { msg.textContent = link; }
          } }, 'Copy link')),
        msg,
        el('h3', {}, platform === 'ios' || platform === 'android' ? 'On this phone or tablet' : 'On a computer'),
        el('p', {}, platform === 'ios' || platform === 'android'
          ? '"Send on WhatsApp" opens WhatsApp: pick the class group and send. "Share…" offers WhatsApp and every other app (Messages, email).'
          : '"Send on WhatsApp" opens WhatsApp Web or the desktop app. On a phone, "Send on WhatsApp" opens the WhatsApp app.'),
        el('p', { class: 'note' }, 'Later: Grown-ups > your child > a week > Share these words. That also shows a QR code another phone can scan.'),
      ];
    },

    backup: async () => {
      const msg = msgLine();
      const exportBtn = deps.store && state.kids.length
        ? el('button', { type: 'button', class: 'btn small solid', onclick: async () => {
          try {
            const out = await deps.exportBackup(deps.store, { kid: null });
            state.changed = true; // the backup panel's "last export" line must refresh
            msg.textContent = out.outcome === 'cancelled' ? 'Nothing was saved.' : `Saved ${out.filename}. Keep it in Files, Drive, or send it to yourself on WhatsApp or email.`;
          } catch (e) { msg.className = 'msg err'; msg.textContent = `Could not export: ${e.message}`; }
        } }, 'Export everything now')
        : null;
      return [
        el('p', {}, 'Everything lives in this browser only, so a backup file is the safety net.'),
        el('p', {}, 'On the Grown-ups page, "Back up" lets you choose who and what goes in the file:'),
        el('ul', { class: 'tour-points' },
          el('li', {}, '"Everything, for me": words, recordings, scores, settings and names. Keep it safe (Files, Drive, or send it to yourself), or import it on a new phone or tablet.'),
          el('li', {}, '"To share with another parent": the words only, with no recordings of your child\'s voice, no scores and no names. Send the file; they import it and choose which of their children gets the words.'),
          el('li', {}, 'The app reminds you every few weeks to make a full backup.')),
        el('div', { class: 'screenbox' }, exportBtn), msg,
        el('h3', {}, 'Put Spellaloud on your home screen'),
        el('p', {}, INSTALL_STEPS[platform]),
        el('p', { class: 'note' }, 'It then opens like an app, works offline, and the browser is less likely to clear its data.'),
      ];
    },

    feedback: async () => [
      el('p', {}, 'Spellaloud is made by one parent and improved from what parents say. The Grown-ups page and your child\'s home screen both have a Feedback button.'),
      el('ul', { class: 'tour-points' },
        el('li', {}, 'Write one line: what was confusing, broken or missing, or what you liked.'),
        el('li', {}, 'It goes straight to the parent who made the app, with the page name and the type of browser. Your name and contact are optional (add them if you would like a reply).'),
        el('li', {}, "Please do not put your child's full name in it.")),
      el('p', {}, deps.feedbackButton({ page: 'tour', label: 'Try it: send feedback' })),
      el('p', { class: 'note' }, 'Parents who code can read the source and suggest changes on GitHub (link on the next card).'),
    ],

    done: async () => {
      const play = state.kid
        ? el('a', { class: 'btn solid', href: '/?kid=' + encodeURIComponent(state.kid.slug), onclick: () => markTour('done') }, `Start practising with ${state.kid.name}`)
        : null;
      return [
        el('p', {}, state.kid ? `On ${state.kid.name}'s screen press Play. Each word is read out; they write it, then check and mark themselves at the end.` : 'Add a child to start practising.'),
        el('p', {}, play),
        el('div', { class: 'screenbox' },
          el('button', { type: 'button', class: 'btn small', onclick: () => finish('done') }, 'Stay on the Grown-ups page')),
        platform === 'ios' || platform === 'android' ? el('p', { class: 'note' }, `Tip: put Spellaloud on your home screen. ${INSTALL_STEPS[platform]}`) : null,
        el('p', { class: 'note' }, 'Replay this tour any time: Grown-ups > "Take the tour".'),
        el('p', { class: 'note' }, 'Free and open source: ', el('a', { class: 'btn small', href: SOURCE_URL, target: '_blank', rel: 'noopener noreferrer' }, 'Source code on GitHub')),
      ];
    },
  };

  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  go(0);
  return done;
}
