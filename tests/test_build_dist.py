"""Tests for bin/build-dist and bin/smoke (Vikunja #4120). Run: python3 -m unittest discover -s tests"""
import pathlib, re, shutil, subprocess, sys, tempfile, threading, unittest, functools
from http.server import HTTPServer, SimpleHTTPRequestHandler

ROOT = pathlib.Path(__file__).resolve().parent.parent
BUILD, SMOKE = str(ROOT / "bin" / "build-dist"), str(ROOT / "bin" / "smoke")

WAITLIST = '<html><head><title>w</title></head><body><h1>Join the waiting list</h1><form method="post" action="{action}">' \
           '<input type="hidden" name="source" value="waitlist"><input name="email"></form><a href="mailto:a@b.invalid">mail</a></body></html>'


MAIL = '<a href="mailto:a@b.invalid">mail</a>'
HEAD = "<head></head>"   # build-dist inserts the absolute canonical before </head>


def fixture(tmp, action, privacy="Privacy, in plain English. (Proposed, Marc to confirm: 14 days)"):
    pages = {"waitlist": WAITLIST.format(action=action), "privacy": f"{HEAD}<p>{privacy}</p>{MAIL}",
             "terms": f'{HEAD}<h1 id="refund">Terms</h1>{MAIL}', "help": f'{HEAD}<h1 id="lost-words">Help</h1>{MAIL}',
             "changelog": f'{HEAD}<p>Last updated 2026-10-26</p>{MAIL}', "thanks": f"{HEAD}<h1>Thank you</h1>{MAIL}"}
    for name, html in pages.items():
        d = tmp / "site" / name
        d.mkdir(parents=True)
        (d / "index.html").write_text(html)
    return tmp


def run(*args):
    return subprocess.run([sys.executable, "-I", *args], capture_output=True, text=True)


class BuildDistTest(unittest.TestCase):
    def test_todo_fixture_fails(self):
        with tempfile.TemporaryDirectory() as t:
            src = fixture(pathlib.Path(t), "#TODO-waitlist-endpoint")
            r = run(BUILD, "--src", str(src), "--out", str(src / "dist"))
            self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
            self.assertIn("#TODO-waitlist-endpoint", r.stderr)

    def test_unproposed_bracket_todo_fails(self):
        with tempfile.TemporaryDirectory() as t:
            src = fixture(pathlib.Path(t), "https://collector.example/waitlist", privacy="[TODO Marc: contact]")
            self.assertEqual(run(BUILD, "--src", str(src), "--out", str(src / "dist")).returncode, 1)

    def test_clean_fixture_builds_all_paths(self):
        with tempfile.TemporaryDirectory() as t:
            src = fixture(pathlib.Path(t), "https://collector.example/waitlist")
            out = src / "dist"
            r = run(BUILD, "--src", str(src), "--out", str(out))
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            for p in ["index.html", "privacy/index.html", "terms/index.html", "help/index.html", "thanks/index.html", "m/index.html", "e/index.html", "r/index.html"]:
                self.assertTrue((out / p).is_file(), p)
            self.assertIn('name="source" value="e"', (out / "e/index.html").read_text())
            self.assertIn('name="source" value="waitlist"', (out / "index.html").read_text())
            self.assertRegex(r.stdout, r"build-dist: 11 files, \d+ bytes")   # 9 pages + sitemap.xml + robots.txt (#4342)
            self.assertIn("proposed, Marc to confirm", r.stdout)

    def test_try_build_is_emitted_rebased_and_linked(self):
        """dist/try/ holds the app under /try (Vikunja #4633) and the waitlist + list pages link to it with the words in the fragment."""
        with tempfile.TemporaryDirectory() as t:
            src = fixture(pathlib.Path(t), "https://collector.example/waitlist")
            shutil.copytree(ROOT / "static", src / "static")
            out = src / "dist"
            r = run(BUILD, "--src", str(src), "--out", str(out))
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertTrue((out / "try" / "index.html").is_file())
            self.assertTrue((out / "try" / "parent" / "index.html").is_file())
            sw = (out / "try" / "sw.js").read_text()
            self.assertIn("const BASE = '/try';", sw)
            self.assertIn('"/try/static/app.js"', sw)
            self.assertIn('src="/try/static/app.js"', (out / "try" / "index.html").read_text())
            self.assertIn('"scope": "/try/"', (out / "try" / "static" / "manifest.webmanifest").read_text())
            for p in (out / "try").rglob("*.js"):
                self.assertNotRegex(p.read_text(), r"register\('/sw\.js'\)", p.name)
        for page in ("site/waitlist/index.html", "drafts/lists/year-2-common-exception-words/index.html"):
            self.assertRegex((ROOT / page).read_text(), r'class="trylink" href="/try/parent/#sl=1&amp;t=[^"]*&amp;w=door&amp;w=floor', page)

    def test_canonical_robots_and_sitemap(self):
        """Absolute canonicals, robots.txt and sitemap.xml (Vikunja #4669). Attribution copies and /thanks/ stay out of the sitemap."""
        with tempfile.TemporaryDirectory() as t:
            src = fixture(pathlib.Path(t), "https://collector.example/waitlist")
            for slug in ("year-1-common-exception-words", "year-2-common-exception-words",
                         "look-cover-write-check", "how-to-help-your-child-learn-spellings"):
                lists = src / "drafts" / "lists" / slug
                lists.mkdir(parents=True)
                (lists / "index.html").write_text(f'<head><link rel="canonical" href="/lists/{slug}/"></head>')
            out = src / "dist"
            r = run(BUILD, "--src", str(src), "--out", str(out), "--origin", "https://example.test/")
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertIn('<link rel="canonical" href="https://example.test/lists/look-cover-write-check/">',
                          (out / "lists/look-cover-write-check/index.html").read_text())
            self.assertIn('<link rel="canonical" href="https://example.test/">', (out / "index.html").read_text())
            self.assertIn('<link rel="canonical" href="https://example.test/">', (out / "m/index.html").read_text())  # copies point at the one URL
            self.assertIn('<link rel="canonical" href="https://example.test/privacy/">', (out / "privacy/index.html").read_text())
            robots = (out / "robots.txt").read_text()
            self.assertIn("User-agent: *", robots)
            self.assertIn("Sitemap: https://example.test/sitemap.xml", robots)
            locs = re.findall(r"<loc>([^<]+)</loc>", (out / "sitemap.xml").read_text())
            self.assertEqual(len(locs), 9)   # /, /privacy/, /terms/, /help/, /changelog/ + 4 lists
            self.assertIn("https://example.test/lists/look-cover-write-check/", locs)
            self.assertIn("https://example.test/privacy/", locs)
            self.assertFalse([u for u in locs if "thanks" in u or "/m/" in u or "/try/" in u])

    def test_default_origin_is_the_demand_test_host(self):
        with tempfile.TemporaryDirectory() as t:
            src = fixture(pathlib.Path(t), "https://collector.example/waitlist")
            self.assertEqual(run(BUILD, "--src", str(src), "--out", str(src / "dist")).returncode, 0)
            self.assertIn("https://spellaloud.joanmarcriera.es/sitemap.xml", (src / "dist" / "robots.txt").read_text())

    def test_service_worker_cache_name_tracks_the_build(self):
        """Vikunja #4671: identical input gives the same cache name, a changed file gives a new one, so old shells are dropped."""
        def cache_name(src):
            with tempfile.TemporaryDirectory() as o:
                self.assertEqual(run(str(ROOT / "bin" / "build-local"), "--src", str(src), "--out", o).returncode, 0)
                m = re.search(r"const VERSION = '([^']+)'", (pathlib.Path(o) / "sw.js").read_text())
                self.assertTrue(m, "VERSION not stamped")
                return m.group(1)
        with tempfile.TemporaryDirectory() as t:
            src = pathlib.Path(t) / "repo"
            shutil.copytree(ROOT / "static", src / "static")
            a, b = cache_name(src), cache_name(src)
            self.assertEqual(a, b)
            self.assertNotIn("__VERSION__", a)
            with open(src / "static" / "app.js", "a") as f:
                f.write("\n// changed\n")
            self.assertNotEqual(cache_name(src), a)

    def test_smoke_against_local_server(self):
        with tempfile.TemporaryDirectory() as t:
            src = fixture(pathlib.Path(t), "https://collector.example/waitlist")
            lists = src / "drafts" / "lists"
            for slug in ("year-1-common-exception-words", "year-2-common-exception-words",
                         "look-cover-write-check", "how-to-help-your-child-learn-spellings"):
                (lists / slug).mkdir(parents=True)
                (lists / slug / "index.html").write_text(f'<button id="hear-it">hear-it</button>{MAIL}')
            shutil.copytree(ROOT / "static", src / "static")  # dist/try/ is built from the app itself (#4633)
            out = src / "dist"
            self.assertEqual(run(BUILD, "--src", str(src), "--out", str(out)).returncode, 0)
            class Quiet(SimpleHTTPRequestHandler):
                def log_message(self, *a):
                    pass
            handler = functools.partial(Quiet, directory=str(out))
            srv = HTTPServer(("127.0.0.1", 0), handler)
            th = threading.Thread(target=srv.serve_forever, daemon=True)
            th.start()
            try:
                r = run(SMOKE, f"http://127.0.0.1:{srv.server_address[1]}")
                self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                self.assertEqual(r.stdout.count("ok  "), 14 + 3 + 2 * 13)   # 14 GET checks, 3 sitemap-only pages, mailto + no-TODO on 13 site pages (#4951); /try/ is the app, not a site page
                self.assertRegex(r.stdout, r"ok   GET /try/ -> 200 marker 'Spellings'")
                self.assertIn("MAILTO /terms/", r.stdout)
                self.assertIn("NO-TODO /help/", r.stdout)
                (out / "m" / "index.html").write_text("broken")
                self.assertEqual(run(SMOKE, f"http://127.0.0.1:{srv.server_address[1]}").returncode, 1)
            finally:
                srv.shutdown(); srv.server_close(); th.join(5)


class SmokeRealSiteTest(unittest.TestCase):
    """bin/smoke against the real site/ built with --allow-todo and served locally (#4951)."""

    def test_real_dist_passes_and_planted_todo_fails(self):
        with tempfile.TemporaryDirectory() as t:
            out = pathlib.Path(t) / "dist"
            r = run(BUILD, "--out", str(out), "--allow-todo")
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

            class Quiet(SimpleHTTPRequestHandler):
                def log_message(self, *a):
                    pass
            srv = HTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(out)))
            th = threading.Thread(target=srv.serve_forever, daemon=True)
            th.start()
            try:
                base = f"http://127.0.0.1:{srv.server_address[1]}"
                r = run(SMOKE, base)
                self.assertEqual(r.returncode, 0, r.stdout + r.stderr)   # only the endpoint placeholders differ
                for line in ("GET /terms/", "GET /help/", "GET /robots.txt", "GET /sitemap.xml", "MAILTO /privacy/", "NO-TODO /thanks/"):
                    self.assertIn(line, r.stdout)
                page = out / "terms" / "index.html"
                original = page.read_text()
                page.write_text(original.replace("</main>", "<p>TODO write this</p></main>"))
                r = run(SMOKE, base)
                self.assertEqual(r.returncode, 1, r.stdout)
                self.assertIn("FAIL NO-TODO /terms/", r.stdout)
                page.write_text(original.replace("mailto:", "mail-to:"))
                self.assertEqual(run(SMOKE, base).returncode, 1)         # a missing mailto: also fails
            finally:
                srv.shutdown(); srv.server_close(); th.join(5)


if __name__ == "__main__":
    unittest.main()
