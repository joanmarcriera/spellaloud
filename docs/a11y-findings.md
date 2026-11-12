# Accessibility findings

Source: `tests/a11y.test.mjs` (static lint, no browser; run with `node --test`). Vikunja #4338.

## Fixed (2026-10-24)

- `--muted` #7C828C on paper/card was 3.7:1 / 3.9:1; now #6A707A (4.9:1 on paper).
- `--green` #2E9E5B with white text was 3.4:1 (`.btn.green`, `.toggle.got`) and as text on paper;
  now #247F49 (5.1:1 with white).
- `static/parent.js`: the week-start date input in the add-week form had no accessible name; now `aria-label="Week starting"`.
- `static/app.js`: the Mark-screen toggle button was created empty and filled by `paint()`; it now starts with its text.

## Guarded by the test

lang and non-empty title on every page; viewport zoom not disabled; every `img` has `alt`; every input/select/textarea
is labelled; every `<button>` has text or `aria-label`; no positive `tabindex`; contrast >= 4.5 for the text/background
pairs in `static/style.css` (ink, muted, accent on paper and card; white on accent and green) and the inline tokens of
the `site/*` pages in light and dark; every `h('button')`, icon-only `btn()` and created form field in `app.js`/`parent.js`
is named.

## Open

Not testable with a static lint, or needs a design decision (each is a candidate follow-up task):

- **No dark scheme in the app.** `static/style.css` defines light tokens only; the site pages have both. Not a WCAG failure.
- **Colour is not the only cue?** Got/not-yet marks pair icon and text with colour (good); the `.pip.got` progress dots and
  `.wordrow .au.yes` rely on colour alone. Needs a visual check.
- **Keyboard and focus order, visible focus ring** on the kid screens (`:focus-visible` styling) need a browser pass;
  the lint cannot see computed styles.
- **Screen-reader flow of the recording screen** (`aria-live="polite"` on `#app` re-announces whole screens on repaint):
  verify with VoiceOver.
- **Contrast of disabled controls** is not covered (the per-kid accents are).
- **Target size** is enforced in CSS (`--tap` >= 44px) but not asserted.
