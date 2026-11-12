# Contributing to Spellaloud

Thank you for helping. This is a small project run by one parent in spare time, so small, focused changes are the
easiest to accept.

## The hard rules (the tests enforce them)

1. **Children's data stays on the device.** No analytics, no tracking, no uploads of names, words, recordings or
   scores. Recordings are a child's voice.
2. **No third-party requests.** No CDNs, web fonts, embeds or external scripts (`tests/no_third_party.test.mjs`).
3. **No HTML sinks.** Build the DOM with `createElement` / `textContent`, never `innerHTML` and friends
   (`tests/no_html_sinks.test.mjs`).
4. **No build step, no dependencies.** Vanilla JavaScript modules in `static/`; Python standard library only in
   `server.py`.

## Workflow

1. Open an issue first for anything bigger than a bug fix, so we can agree the approach.
2. For a bug: write the failing test first, then the fix.
3. Run both suites before you push:

       python3 -m unittest discover -s tests
       node --test

4. Use [Conventional Commits](https://www.conventionalcommits.org/) messages, e.g. `fix(parent): keep typed words when saving fails`.
5. Keep the wording plain and British English: the readers are busy parents and young children.

## Good first contributions

- Accessibility: screen-reader and keyboard walk-throughs on real devices (VoiceOver, TalkBack).
- Voices: better British voice detection on more browsers and devices.
- Word lists: school-specific lists can be shared as links from the app, no code needed.

By contributing you agree your contribution is licensed under the AGPL v3.0, like the rest of the code.
