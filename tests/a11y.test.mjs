// Static accessibility checks (Vikunja #4338). No dependencies: node:test + regex scans.
// Covers static/index.html, static/parent.html, site/*/index.html and the built drafts/lists pages
// (markup rules), the colour tokens in static/style.css and the site pages (WCAG contrast >= 4.5)
// and the DOM-building code in static/app.js and static/parent.js (every button/field named).
// This is a lint, not a browser audit: it cannot see computed styles or focus order. Open
// findings that need design decisions are recorded in docs/a11y-findings.md. Run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const read = (p) => readFileSync(join(root, p), 'utf8');

/** Every index.html under a directory, one level of sub-directories deep. */
function indexPages(dir) {
  const base = join(root, dir);
  if (!existsSync(base)) return [];
  return readdirSync(base).map((d) => join(dir, d, 'index.html')).filter((p) => existsSync(join(root, p)) && statSync(join(root, p)).isFile());
}
const PAGES = ['static/index.html', 'static/parent.html', ...indexPages('site'), ...indexPages('drafts/lists')];
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, (m) => m.startsWith('<script') ? '<script></script>' : m);
const tags = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)(?=</${name}>|$)`, 'gi'))].map((m) => ({ attrs: m[1], inner: m[2] }));
const attr = (attrs, name) => { const m = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|[^\\s>]+)`, 'i')); return m ? (m[2] ?? m[3] ?? m[1]) : null; };
const hasAttr = (attrs, name) => new RegExp(`(?:^|\\s)${name}(?=[\\s=]|$)`, 'i').test(attrs);
const textOf = (inner) => inner.replace(/<[^>]*>/g, '').replace(/&[a-z#0-9]+;/gi, 'x').trim();

test('there are pages to check', () => {
  assert.ok(PAGES.length >= 8, `only ${PAGES.length} pages found: ${PAGES.join(', ')}`);
});

for (const p of PAGES) {
  const html = stripComments(read(p));
  test(`${p}: document-level markup`, () => {
    assert.match(html, /<html\b[^>]*\blang="[a-z]{2}(-[A-Za-z]{2})?"/i, 'html lang');
    const title = html.match(/<title>([\s\S]*?)<\/title>/i);
    assert.ok(title && title[1].trim().length > 0, 'non-empty title');
    assert.match(html, /<meta[^>]*name="viewport"/i, 'viewport meta');
    assert.doesNotMatch(html, /user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/i, 'zoom must not be disabled');
  });
  test(`${p}: images, fields, buttons, tabindex`, () => {
    for (const m of html.matchAll(/<img\b([^>]*)>/gi)) assert.ok(hasAttr(m[1], 'alt'), `img without alt: ${m[0]}`);
    // A field is named by a wrapping <label>, <label for=id>, aria-label or aria-labelledby.
    const labelFor = new Set([...html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/gi)].map((m) => m[1]));
    const wrapped = [...html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/gi)].map((m) => m[1]).join('\n');
    for (const m of html.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
      const type = (attr(m[2], 'type') || 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) continue;
      const id = attr(m[2], 'id');
      const named = hasAttr(m[2], 'aria-label') || hasAttr(m[2], 'aria-labelledby') || (id && labelFor.has(id)) || wrapped.includes(m[0]);
      assert.ok(named, `unlabelled ${m[1]}: ${m[0]}`);
    }
    for (const b of tags(html, 'button')) {
      const named = textOf(b.inner).length > 0 || (attr(b.attrs, 'aria-label') || '').trim().length > 0 || hasAttr(b.attrs, 'aria-labelledby');
      assert.ok(named, `button without an accessible name: <button ${b.attrs.trim()}>`);
    }
    for (const m of html.matchAll(/\btabindex\s*=\s*"?(-?\d+)/gi)) assert.ok(Number(m[1]) <= 0, `positive tabindex ${m[1]}`);
  });
}

// ---- WCAG contrast -------------------------------------------------------------------------------
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (hex) => { const h = hex.replace('#', ''); const f = h.length === 3 ? h.replace(/./g, (x) => x + x) : h; const [r, g, b] = [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const tokens = (block) => Object.fromEntries([...block.matchAll(/--([a-z-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\b/g)].map((m) => [m[1], m[2]]));

test('contrast helper matches known values', () => {
  assert.ok(Math.abs(contrast('#000000', '#ffffff') - 21) < 0.01);
  assert.ok(Math.abs(contrast('#777777', '#ffffff') - 4.48) < 0.02);
});

test('static/style.css: text colour tokens reach 4.5:1', () => {
  const css = read('static/style.css');
  const rootBlock = css.match(/:root\s*\{([\s\S]*?)\}/)[1];
  const light = tokens(rootBlock);
  const dark = [...css.matchAll(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([\s\S]*?)\}/g)].map((m) => ({ ...light, ...tokens(m[1]) }));
  // Foreground/background pairs the stylesheet really uses: body text, muted notes on paper and cards,
  // accent text on paper/card (.btn), white text on accent (.btn.solid), accent text on card.
  const pairs = [['ink', 'paper'], ['ink', 'card'], ['muted', 'paper'], ['muted', 'card'], ['accent', 'paper'], ['accent', 'card']];
  const KNOWN_OPEN = new Set(JSON.parse(readFileSync(join(root, 'tests/a11y-known-open.json'), 'utf8')).contrast);
  const fails = [];
  for (const [name, set] of [['light', light], ...dark.map((d, i) => [`dark${i}`, d])]) {
    for (const [fg, bg] of pairs) {
      const r = contrast(set[fg], set[bg]);
      if (r < 4.5 && !KNOWN_OPEN.has(`${name}:${fg}/${bg}`)) fails.push(`${name}: ${fg} ${set[fg]} on ${bg} ${set[bg]} = ${r.toFixed(2)}`);
    }
    for (const [fg, bg] of [['#FFFFFF', 'accent'], ['#FFFFFF', 'green']]) {
      const key = `${name}:white/${bg}`;
      const r = contrast(fg, set[bg]);
      if (r < 4.5 && !KNOWN_OPEN.has(key)) fails.push(`${name}: white on ${bg} ${set[bg]} = ${r.toFixed(2)}`);
    }
  }
  assert.deepEqual(fails, [], `new low-contrast pairs (fix them or record in docs/a11y-findings.md + tests/a11y-known-open.json):\n${fails.join('\n')}`);
});

test('static/style.css: per-kid accent overrides reach 4.5:1 on paper, card and as white-on-accent', () => {
  const css = read('static/style.css');
  const paper = tokens(css.match(/:root\s*\{([\s\S]*?)\}/)[1]);
  const kids = [...css.matchAll(/\[data-kid="(\w+)"\]\s*\{\s*--accent:\s*(#[0-9a-fA-F]{6})/g)];
  assert.ok(kids.length >= 2, 'expected data-kid accent overrides');
  for (const [, kid, accent] of kids) {
    for (const [fg, bg, what] of [[accent, paper.paper, 'on paper'], [accent, paper.card, 'on card'], ['#FFFFFF', accent, 'white on it']]) {
      assert.ok(contrast(fg, bg) >= 4.5, `${kid} accent ${accent} ${what} = ${contrast(fg, bg).toFixed(2)}`);
    }
  }
});

test('site pages: inline colour tokens reach 4.5:1 in light and dark', () => {
  for (const p of PAGES.filter((x) => x.startsWith('site/') || x.startsWith('drafts/'))) {
    const html = read(p);
    const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
    const rootLight = styles.match(/:root\s*\{([^}]*)\}/);
    if (!rootLight) continue;
    const light = tokens(rootLight[1]);
    const darkM = styles.match(/prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/);
    const sets = [['light', light]];
    if (darkM) sets.push(['dark', { ...light, ...tokens(darkM[1]) }]);
    for (const [name, t] of sets) {
      const bgs = [t.bg, t.card].filter(Boolean);
      for (const fg of ['fg', 'muted', 'accent']) for (const bg of bgs) {
        if (!t[fg]) continue;
        assert.ok(contrast(t[fg], bg) >= 4.5, `${p} ${name}: ${fg} ${t[fg]} on ${bg} = ${contrast(t[fg], bg).toFixed(2)}`);
      }
      if (t.accent && /background:var\(--accent\);\s*color:#fff/.test(styles.replace(/\s+/g, ' ').replace(/: /g, ':'))) {
        // white button text on the accent is only used in the light scheme's accent; dark accents are light colours
        const r = contrast('#ffffff', t.accent);
        if (name === 'light') assert.ok(r >= 4.5, `${p}: white on accent ${t.accent} = ${r.toFixed(2)}`);
      }
    }
  }
});

// ---- DOM-building code --------------------------------------------------------------------------
/** Source text of every call `name(` ... `)` with balanced parentheses (strings and template literals skipped). */
function calls(src, name) {
  const out = [];
  const re = new RegExp(`(?<![\\w.])${name}\\(`, 'g');
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex, depth = 1, q = null;
    for (; i < src.length && depth; i++) {
      const c = src[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      if (c === "'" || c === '"' || c === '`') q = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    out.push({ text: src.slice(m.index, i), line: src.slice(0, m.index).split('\n').length });
  }
  return out;
}
/** Split a call's argument list at top-level commas. */
function args(callText) {
  const body = callText.slice(callText.indexOf('(') + 1, -1);
  const out = []; let depth = 0, q = null, cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) { cur += c; if (c === '\\') cur += body[++i]; else if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; cur += c; continue; }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

for (const file of ['static/app.js', 'static/parent.js']) {
  const src = read(file);
  test(`${file}: every h('button') has text, an icon child or aria-label`, () => {
    const bad = calls(src, 'h').filter((c) => /^h\(\s*'button'/.test(c.text)).filter((c) => {
      const a = args(c.text);
      return !(/aria-label/.test(a[1] || '') || a.slice(2).some((x) => x && x !== 'null' && x !== 'false'));
    });
    assert.deepEqual(bad.map((c) => `${file}:${c.line}`), [], 'unnamed buttons');
  });
  test(`${file}: btn() helper calls with no text pass an aria-label`, () => {
    const bad = calls(src, 'btn').filter((c) => !c.text.startsWith('btn = ')).filter((c) => {
      const a = args(c.text);
      return a.length >= 2 && /^(''|""|``)$/.test(a[1]) && !/aria-label/.test(a[4] || '');
    });
    assert.deepEqual(bad.map((c) => `${file}:${c.line}`), [], 'icon-only buttons without aria-label');
  });
  test(`${file}: every created input/select/textarea is named`, () => {
    const open = [];
    for (const tag of ['input', 'select', 'textarea']) {
      for (const c of calls(src, 'h').filter((x) => x.text.startsWith(`h('${tag}'`))) {
        const a = args(c.text);
        const type = (a[1] || '').match(/type:\s*'(\w+)'/);
        if (type && ['hidden', 'submit', 'button'].includes(type[1])) continue;
        if (/aria-label/.test(a[1] || '')) continue;
        // inside a <label> wrapper? look at the line itself for the wrapper's h('label'
        const lineStart = src.lastIndexOf('\n', src.indexOf(c.text));
        const around = src.slice(lineStart, src.indexOf(c.text) + c.text.length + 200);
        if (/h\('label'/.test(around) && around.indexOf("h('label'") < around.indexOf(c.text)) continue;
        open.push(`${file}:${c.line} ${tag}`);
      }
    }
    assert.deepEqual(open, [], 'unnamed form fields');
  });
}

test('findings doc has an Open section', () => {
  assert.match(read('docs/a11y-findings.md'), /^## Open\s*$/m);
});
