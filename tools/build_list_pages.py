#!/usr/bin/env python3
"""Build the four static UK statutory spelling list pages (DRAFT, unpublished).

Usage:  python3 tools/build_list_pages.py [--out drafts/lists] [--base https://example.invalid]
Input:  content/uk-statutory/lists.json (see content/uk-statutory/SOURCES.md), static/voice.js
Output: drafts/lists/<slug>/index.html, one per list. Stdlib only; deterministic (same input, same bytes).

Each page is self-contained: inline CSS (tokens + light/dark copied from site/waitlist/index.html), one
inline classic script (the en-GB voice picker from static/voice.js, inlined at build time so the page works
from file:// and cannot drift from the app), no third-party requests, no analytics. The "hear it" buttons are
`hidden` until a real en-GB voice is found; there is never a US fallback.
SEO (Vikunja #4342): each page gets a canonical link, Open Graph title/description/type/url and JSON-LD ItemList with
inLanguage en-GB. URLs are BASE/lists/<slug>/ where BASE comes from --base; the default is the reserved
https://example.invalid so no real domain is asserted before Marc decides (bin/build-dist --base swaps it).
Publishing is a gate (Vikunja #4059): this script only writes files.
"""
import argparse, html, json, math, pathlib, re, urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_BASE = "https://example.invalid"   # placeholder host, see the module docstring
WAITLIST_HREF = "../../../site/waitlist/index.html"   # draft location; becomes "/" when the waitlist is published

# list id -> page copy. Titles/H1 match what a parent types into a search box.
PAGES = {
    "y1-common-exception-words": dict(
        slug="year-1-common-exception-words", form=True,
        h1="Year 1 common exception words (England)",
        title="Year 1 common exception words list (England), free printable",
        desc="The 45 Year 1 common exception words from the England national curriculum, in one printable A4 table, with a button to hear each word in a British voice.",
        short="Year 1", n_note="45 words",
        faq_status="These words are listed as examples in the national curriculum (English Appendix 1, Year 1). The curriculum says pupils should learn common exception words, and adds that schools may use others according to the programme they follow, so your school's list can differ a little.",
    ),
    "y2-common-exception-words": dict(
        slug="year-2-common-exception-words", form=True,
        h1="Year 2 common exception words (England)",
        title="Year 2 common exception words list (England), free printable",
        desc="The 64 Year 2 common exception words from the England national curriculum, in one printable A4 table, with a button to hear each word in a British voice.",
        short="Year 2", n_note="64 words",
        faq_status="These words are listed as examples in the national curriculum (English Appendix 1, Year 2). The curriculum says pupils should learn common exception words, and adds that schools may use others according to the programme they follow, so your school's list can differ a little. 'children' is included there because of its link to 'child'.",
    ),
    "y3-4-word-list": dict(
        slug="year-3-and-4-spelling-words",
        h1="Year 3 and 4 spelling words (England)",
        title="Year 3 and 4 spelling words: the 100-word statutory list (England)",
        desc="The 100 statutory spelling words for Years 3 and 4 in England, in one printable A4 table, with a button to hear each word in a British voice.",
        short="Years 3 and 4", n_note="100 words",
        faq_status="Yes. The Years 3 and 4 word list is statutory: it is set out in English Appendix 1 of the national curriculum for England. Pupils are expected to be taught these words across the two years, alongside others the teacher chooses.",
    ),
    "y5-6-word-list": dict(
        slug="year-5-and-6-spelling-words",
        h1="Year 5 and 6 spelling words (England)",
        title="Year 5 and 6 spelling words: the 100-word statutory list (England)",
        desc="The 100 statutory spelling words for Years 5 and 6 in England, in one printable A4 table, with a button to hear each word in a British voice.",
        short="Years 5 and 6", n_note="100 words",
        faq_status="Yes. The Years 5 and 6 word list is statutory: it is set out in English Appendix 1 of the national curriculum for England. Pupils are expected to be taught these words across the two years, alongside others the teacher chooses.",
    ),
}
ORDER = ["y1-common-exception-words", "y2-common-exception-words", "y3-4-word-list", "y5-6-word-list"]

CSS = """
  :root { --bg:#fffaf0; --fg:#1d2430; --muted:#566070; --accent:#1f6f5c; --card:#ffffff; --line:#e3dccb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14181f; --fg:#eef1f5; --muted:#a3adbb; --accent:#6fd1b5; --card:#1c222b; --line:#2c3440; } }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--fg); font:18px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif }
  main { max-width:48rem; margin:0 auto; padding:2rem 1rem 3rem }
  h1 { font-size:2rem; line-height:1.2; margin:0 0 .75rem } h2 { font-size:1.3rem; margin:2rem 0 .5rem }
  .lede { font-size:1.15rem; color:var(--muted) }
  ol, ul { padding-left:1.25rem } li { margin:.35rem 0 }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:1.25rem; margin:1.5rem 0 }
  table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line) }
  td { border:1px solid var(--line); padding:.35rem .5rem; vertical-align:top; width:25% }
  td .w { font-weight:600 }
  button.hear { margin:0 0 0 .35rem; padding:.1rem .45rem; font:inherit; font-size:.85rem; border:1px solid var(--accent); border-radius:6px; background:transparent; color:var(--accent); cursor:pointer }
  button.hear[hidden] { display:none }
  button.hear-it { padding:.45rem .9rem; font:inherit; border:1px solid var(--accent); border-radius:8px; background:var(--accent); color:var(--bg); cursor:pointer }
  button.hear-it[hidden] { display:none }
  input[type=email] { width:100%; padding:.8rem; font:inherit; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg) }
  form.waitlist button { margin-top:.6rem; padding:.7rem 1.1rem; font:inherit; border:0; border-radius:8px; background:var(--accent); color:var(--bg); cursor:pointer }
  input:focus-visible, button:focus-visible, a:focus-visible { outline:3px solid var(--accent); outline-offset:2px }
  small, footer, .muted { color:var(--muted); font-size:.9rem } a { color:var(--accent) }
  nav ul { list-style:none; padding:0; display:flex; flex-wrap:wrap; gap:.4rem 1rem } nav li { margin:0 }
  dt { font-weight:700; margin-top:.9rem } dd { margin:.2rem 0 0 }
  @media (max-width:36rem) { td { display:block; width:auto; border:0; border-bottom:1px solid var(--line) } body { font-size:17px } }
  @media print {
    :root { --bg:#fff; --fg:#000; --muted:#333; --line:#999; --card:#fff }
    body { font-size:10pt; line-height:1.25 } main { max-width:none; padding:0 }
    .noprint, button.hear, button.hear-it { display:none !important }
    h1 { font-size:16pt; margin:0 0 4pt }
    table { page-break-inside:avoid } td { display:table-cell; width:25%; padding:2pt 4pt; border:1px solid #999 }
    .printnote { display:block !important; font-size:8pt; margin-top:6pt }
    @page { size:A4; margin:12mm }
  }
  .printnote { display:none }
"""


def voice_js():
    """The en-GB picker + speak helpers from static/voice.js as plain (non-module) code."""
    src = (ROOT / "static" / "voice.js").read_text(encoding="utf-8")
    src = src.split("/** Per-device parent setting")[0]       # drop localStorage helpers
    src = re.sub(r"^export ", "", src, flags=re.M)
    src = re.sub(r"^//.*\n", "", src, flags=re.M)             # leading file comments
    return src.strip()


# Page behaviour: reveal the buttons only if a real en-GB voice exists.
PAGE_JS = """
(function () {
  var synth = window.speechSynthesis;
  if (!synth) return;
  loadVoices(synth).then(function (vs) {
    var voice = pickVoice(vs);
    if (!voice) return;                                   // no en-GB voice: buttons stay hidden
    document.querySelectorAll('button.hear').forEach(function (b) {
      b.hidden = false;
      b.addEventListener('click', function () { speak(synth, voice, b.dataset.word, { rate: 0.9 }); });
    });
    // "hear-it": read the whole list aloud, one word at a time (Web Speech only, no network).
    var all = document.getElementById('hear-it');
    if (all) {
      var words = [].map.call(document.querySelectorAll('button.hear'), function (b) { return b.dataset.word; });
      var running = false;
      all.hidden = false;
      all.addEventListener('click', function () {
        if (running) { running = false; stopSpeech(synth); all.textContent = 'Hear the whole list'; return; }
        running = true; all.textContent = 'Stop';
        var i = 0;
        (function next() {
          if (!running || i >= words.length) { running = false; all.textContent = 'Hear the whole list'; return; }
          speak(synth, voice, words[i++], { rate: 0.9 }).then(function () { setTimeout(next, 700); });
        })();
      });
    }
  });
})();
"""


def esc(s):
    return html.escape(s, quote=True)


TRY_BASE = "/try/parent/"   # the preloaded browser build (bin/build-dist --> dist/try/, bin/build-local --base /try)
TRY_MAX_WORDS = 60          # static/share.js MAX_WORDS: a longer list would be cut by the app


def try_href(words, title):
    """Share-link fragment for static/share.js (#sl=1&t=..&w=..): words stay in the fragment, no server sees them."""
    seen, clean = set(), []
    for w in words:
        k = w.lower()
        if k not in seen:
            seen.add(k)
            clean.append(w)
    clean = clean[:TRY_MAX_WORDS]
    return TRY_BASE + "#" + urllib.parse.urlencode([("sl", "1"), ("t", title)] + [("w", w) for w in clean])


def table(entries, cols):
    """Column-major table so the list reads down the columns (alphabetical)."""
    rows = math.ceil(len(entries) / cols)
    out = ["<table>"]
    for r in range(rows):
        out.append("<tr>")
        for c in range(cols):
            i = c * rows + r
            if i >= len(entries):
                out.append("<td></td>")
                continue
            e = entries[i]
            btns = "".join(
                f'<button class="hear" type="button" hidden data-word="{esc(f)}" aria-label="Hear the word {esc(f)}">hear{" " + esc(f) if len(e["forms"]) > 1 else ""}</button>'
                for f in e["forms"]
            )
            out.append(f'<td><span class="w">{esc(e["official"])}</span>{btns}</td>')
        out.append("</tr>")
    out.append("</table>")
    return "\n".join(out)


def page_url(base, slug):
    """Absolute URL of a list page as served from dist/: BASE/lists/<slug>/."""
    return f"{base.rstrip('/')}/lists/{slug}/"


def build_page(lst, meta, data, base=DEFAULT_BASE):
    src = data["source"]
    cols = 4
    jsonld = {
        "@context": "https://schema.org", "@type": "ItemList", "name": meta["h1"],
        "inLanguage": "en-GB", "url": page_url(base, meta["slug"]),
        "numberOfItems": len(lst["entries"]),
        "itemListElement": [{"@type": "ListItem", "position": i + 1, "name": e["official"]} for i, e in enumerate(lst["entries"])],
    }
    nav = "".join(
        f'<li><a href="../{PAGES[i]["slug"]}/index.html">{esc(PAGES[i]["h1"])}</a></li>' for i in ORDER if i != lst["id"]
    )
    faq = [
        ("Is this list statutory?", meta["faq_status"]),
        ("Where does the list come from?",
         f'From "{src["title"]}" ({src["publisher"]}, {src["published"]}), published on GOV.UK. We copied the words as printed and checked them against two other copies; GOV.UK wins if they differ.'),
        ("Is it free?", "Yes. There is nothing to buy or sign up for to read, print or use this page."),
        ("Are there ads or tracking?", "No. This page has no ads, no analytics, no cookies and makes no requests to other websites."),
        ("Why does a word have two spellings, like busy/business?",
         "The curriculum prints some entries together because they are related (for example eight/eighth). Each form is shown so your child can practise both."),
    ]
    hear_all = ('  <p class="noprint"><button class="hear-it" id="hear-it" type="button" hidden lang="en-GB">Hear the whole list</button> '
                '<small>British voice from your own device; nothing is sent anywhere.</small></p>\n') if meta.get("form") else ""
    if meta.get("form"):
        cta = f"""<div class="card" id="waitlist">
    <strong>Want the words read aloud from your own school list?</strong>
    <p>I am building a small, free-of-tracking app that reads a weekly spelling list in a British voice. It is not released yet.</p>
    <!-- action is a placeholder until Marc approves the collector (Vikunja #4118); bin/build-dist refuses to ship it -->
    <form class="waitlist" method="post" action="#TODO-waitlist-endpoint" lang="en-GB">
      <input type="hidden" name="source" value="lists">
      <label for="email">Tell me when it is ready</label>
      <input id="email" name="email" type="email" autocomplete="email" required placeholder="you@example.com">
      <button type="submit">Join the waiting list</button>
      <p><small>One email when the app opens, and nothing else. We store only your email address, and you can ask us to delete it. See the <a href="/privacy/">privacy page</a>.</small></p>
    </form>
  </div>"""
    else:
        cta = f"""<div class="card">
    <strong>Want the words read aloud from your own school list?</strong>
    <p>I am building a small, free-of-tracking app that reads a weekly spelling list in a British voice. It is not released yet. <a href="{WAITLIST_HREF}">Join the waiting list</a>.</p>
  </div>"""
    faq_html = "\n".join(f"<dt>{esc(q)}</dt><dd>{esc(a)}</dd>" for q, a in faq)
    return f"""<!doctype html>
<!-- DRAFT page generated by tools/build_list_pages.py from content/uk-statutory/lists.json. NOT PUBLISHED (Vikunja #4059). -->
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(meta["title"])}</title>
<meta name="description" content="{esc(meta["desc"])}">
<link rel="canonical" href="{esc(page_url(base, meta["slug"]))}">
<meta property="og:type" content="website">
<meta property="og:locale" content="en_GB">
<meta property="og:title" content="{esc(meta["title"])}">
<meta property="og:description" content="{esc(meta["desc"])}">
<meta property="og:url" content="{esc(page_url(base, meta["slug"]))}">
<script type="application/ld+json">{json.dumps(jsonld, ensure_ascii=False)}</script>
<style>{CSS}</style>
</head>
<body>
<main>
  <h1>{esc(meta["h1"])}</h1>
  <p class="lede noprint">{esc(meta["n_note"].capitalize())} for {esc(meta["short"])} in England. Print this page on one sheet of A4, or tap <em>hear</em> beside a word to hear it in a British voice.</p>
{hear_all}  <p class="noprint"><a class="trylink" href="{esc(try_href([f for e in lst["entries"] for f in e["forms"]], meta["short"] + " words"))}">Try these words now in your browser</a> <small>Opens the early version of the app with this list ready to add. It is saved on your own device; nothing is sent anywhere.</small></p>
{table(lst["entries"], cols)}
  <p class="printnote">{esc(src["attribution"])} Source: {esc(src["title"])}, {esc(src["url"])}.</p>

  <section class="noprint">
  <h2>How to practise at home</h2>
  <ol>
    <li>Pick five or six words, not the whole list. A few words done well beat a long list done once.</li>
    <li>Say a word, let your child look at it, then cover it and ask them to write it from memory.</li>
    <li>Check letter by letter. Ask which part was tricky, and circle that part.</li>
    <li>Come back to the tricky ones the next day, then a few days later. Short and often works best.</li>
    <li>Let your child read the word back to you. If it sounds odd to say, that is usually the tricky part.</li>
  </ol>
  <h2>Questions</h2>
  <dl>
{faq_html}
  </dl>
  {cta}
  <nav aria-label="Other spelling lists"><h2>Other lists</h2><ul>{nav}</ul></nav>
  <footer>
    <nav class="trust" aria-label="About this site"><a href="/privacy/">Privacy</a> · <a href="/terms/">Terms</a> · <a href="/help/">Help</a> · <a href="mailto:support@spellaloud.invalid">support@spellaloud.invalid</a></nav>
    <p>{esc(src["attribution"])} Source: <a href="{esc(src["landing_page"])}">{esc(src["title"])}</a> (retrieved {esc(src["retrieved"])}). Licence: <a href="{esc(src["licence_url"])}">{esc(src["licence"])}</a>.</p>
    <p>Not affiliated with the Department for Education or any school.</p>
  </footer>
  </section>
</main>
<script>
{voice_js()}
{PAGE_JS}
</script>
</body>
</html>
"""


# Method pages (Vikunja #4635): how-to guides that sit beside the list pages. Same CSS, same first-party
# hear-it control, no network, no medical or learning-difference claims. canonical is root-relative; the
# origin is added when Marc approves publishing.
TRY_WORDS = ["because", "people", "friend", "beautiful", "busy", "children"]  # all from the Y1/Y2 lists (tested)
METHOD_PAGES = {
    "look-cover-write-check": dict(
        slug="look-cover-write-check",
        h1="Look, Cover, Write, Check: spelling practice that works (England, UK schools)",
        title="Look Cover Write Check spelling method, with sound (England)",
        desc="How Look, Cover, Write, Check works for primary spelling in England, step by step, with a button to hear each word in a British voice.",
        lede="Look, Cover, Write, Check is the routine many primary schools in England use for weekly spellings. It takes about five minutes a day. This page adds the one thing paper can't: hearing the word.",
        kind="HowTo",
        steps=[
            ("Look", "Read the word aloud, then look at it closely. Notice the tricky part, such as a silent letter or an unexpected group of vowels. Tap <em>hear</em> to listen again in a British voice."),
            ("Cover", "Cover the word with your hand or a piece of paper, so your child can't see it."),
            ("Write", "Ask your child to write the word from memory, saying it quietly as they write."),
            ("Check", "Uncover the word and check it letter by letter. Right? Tick it. Wrong? Circle the part that went wrong, then do the whole routine once more."),
        ],
        sections=[
            ("Why it works", "Writing a word from memory is harder than copying it, and that effort is what helps it stick. Checking straight away means a mistake is caught before it is practised."),
            ("How long, how often", "Five or six words a session, a few minutes a day, beats one long evening. Come back to the tricky words a few days later."),
            ("Make it a little easier or harder", "Younger children can trace the first try, or write only the tricky part. Older children can use the word in a sentence after the check."),
        ],
    ),
    "how-to-help-your-child-learn-spellings": dict(
        slug="how-to-help-your-child-learn-spellings",
        h1="How to help your child learn their spellings at home (England, UK primary)",
        title="How to help your child learn spellings at home (England)",
        desc="Simple, calm ways to help a primary-age child learn weekly spellings at home in England, with a button to hear each word in a British voice.",
        lede="A few minutes a day, a calm routine and hearing the words said clearly are enough. Here is a plan you can start tonight.",
        kind="Article",
        steps=[
            ("Start with the school's list", "Use the words your teacher sent home. If you want more practice, the national curriculum lists linked below are a good place to look."),
            ("Pick a few words", "Choose five or six at a time. Keep the rest for later in the week."),
            ("Say it, then spell it", "Say the word clearly, break it into sounds or chunks, then try writing it. Use Look, Cover, Write, Check for the writing part."),
            ("Keep it short and kind", "Stop while it's still going well. A short, happy session each day beats a long, tense one."),
            ("Come back to the tricky ones", "Words that went wrong today go back on tomorrow's list. Praise the effort, not just the score."),
        ],
        sections=[
            ("Using sound", "Many children find it easier to spell a word they have heard said clearly several times. Tap <em>hear</em> as often as you like; the voice comes from your own device and nothing is sent anywhere."),
            ("When it isn't going well", "Take a break and try again tomorrow. If you are worried about your child's progress with spelling, talk to their teacher."),
        ],
    ),
}


def build_method_page(meta, data):
    """One method page: title, description, canonical, JSON-LD, steps, a hear-it box and links to the four list pages."""
    src = data["source"]
    steps_html = "\n".join(f"    <li><strong>{esc(t)}.</strong> {b}</li>" for t, b in meta["steps"])
    sections_html = "\n".join(f"  <h2>{esc(t)}</h2>\n  <p>{b}</p>" for t, b in meta["sections"])
    try_html = " ".join(
        f'<span class="w">{esc(w)}</span><button class="hear" type="button" hidden data-word="{esc(w)}" aria-label="Hear the word {esc(w)}">hear</button>'
        for w in TRY_WORDS
    )
    links = "".join(f'<li><a href="../{PAGES[i]["slug"]}/index.html">{esc(PAGES[i]["h1"])}</a></li>' for i in ORDER)
    other = [m for m in METHOD_PAGES.values() if m["slug"] != meta["slug"]]
    links += "".join(f'<li><a href="../{m["slug"]}/index.html">{esc(m["h1"])}</a></li>' for m in other)
    if meta["kind"] == "HowTo":
        jsonld = {"@context": "https://schema.org", "@type": "HowTo", "name": meta["h1"], "description": meta["desc"],
                  "step": [{"@type": "HowToStep", "position": i + 1, "name": t, "text": re.sub(r"<[^>]+>", "", b)} for i, (t, b) in enumerate(meta["steps"])]}
    else:
        jsonld = {"@context": "https://schema.org", "@type": "Article", "headline": meta["h1"], "description": meta["desc"], "inLanguage": "en-GB"}
    return f"""<!doctype html>
<!-- DRAFT page generated by tools/build_list_pages.py. NOT PUBLISHED (Vikunja #4635). -->
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(meta["title"])}</title>
<meta name="description" content="{esc(meta["desc"])}">
<link rel="canonical" href="/lists/{meta["slug"]}/">
<script type="application/ld+json">{json.dumps(jsonld, ensure_ascii=False)}</script>
<style>{CSS}</style>
</head>
<body>
<main>
  <h1>{esc(meta["h1"])}</h1>
  <p class="lede">{esc(meta["lede"])}</p>
  <h2>The steps</h2>
  <ol>
{steps_html}
  </ol>
  <div class="card">
    <strong>Try it with a few words</strong>
    <p class="noprint"><button class="hear-it" id="hear-it" type="button" hidden lang="en-GB">Hear these words</button> <small>British voice from your own device; nothing is sent anywhere.</small></p>
    <p>{try_html}</p>
  </div>
{sections_html}
  <nav aria-label="Spelling lists and guides"><h2>Word lists and guides</h2><ul>{links}</ul></nav>
  <footer>
    <nav class="trust" aria-label="About this site"><a href="/privacy/">Privacy</a> · <a href="/terms/">Terms</a> · <a href="/help/">Help</a> · <a href="mailto:support@spellaloud.invalid">support@spellaloud.invalid</a></nav>
    <p>Word lists: {esc(src["attribution"])} Source: <a href="{esc(src["landing_page"])}">{esc(src["title"])}</a>. Licence: <a href="{esc(src["licence_url"])}">{esc(src["licence"])}</a>.</p>
    <p>Not affiliated with the Department for Education or any school.</p>
  </footer>
</main>
<script>
{voice_js()}
{PAGE_JS}
</script>
</body>
</html>
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default=str(ROOT / "drafts" / "lists"))
    ap.add_argument("--base", default=DEFAULT_BASE, help="site origin for canonical/og:url (default %(default)s)")
    a = ap.parse_args()
    data = json.loads((ROOT / "content" / "uk-statutory" / "lists.json").read_text(encoding="utf-8"))
    by_id = {l["id"]: l for l in data["lists"]}
    for meta in METHOD_PAGES.values():
        d = pathlib.Path(a.out) / meta["slug"]
        d.mkdir(parents=True, exist_ok=True)
        (d / "index.html").write_text(build_method_page(meta, data), encoding="utf-8")
        print("wrote", d / "index.html")
    for lid in ORDER:
        meta = PAGES[lid]
        d = pathlib.Path(a.out) / meta["slug"]
        d.mkdir(parents=True, exist_ok=True)
        (d / "index.html").write_text(build_page(by_id[lid], meta, data, a.base), encoding="utf-8")
        print("wrote", d / "index.html")


if __name__ == "__main__":
    main()
