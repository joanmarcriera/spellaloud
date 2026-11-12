"""bin/build-local: the local PWA build stamps pages, fills the service worker and ships the offline shell."""
import importlib.machinery, importlib.util, json, pathlib, re, tempfile, unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
loader = importlib.machinery.SourceFileLoader("build_local", str(ROOT / "bin" / "build-local"))
spec = importlib.util.spec_from_loader("build_local", loader)
bl = importlib.util.module_from_spec(spec)
loader.exec_module(bl)


class BuildLocal(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = pathlib.Path(self.tmp.name) / "d"
        self.version, self.precache = bl.build(ROOT, self.out, None)

    def tearDown(self):
        self.tmp.cleanup()

    def test_pages_are_stamped_local_with_manifest(self):
        for rel in ("index.html", "parent/index.html"):
            html = (self.out / rel).read_text()
            self.assertIn('<html data-store="local"', html, rel)
            self.assertIn('rel="manifest"', html, rel)

    def test_sw_is_filled_and_precache_files_exist(self):
        sw = (self.out / "sw.js").read_text()
        self.assertNotIn("__VERSION__", sw)
        self.assertNotIn("__PRECACHE__", sw)
        self.assertIn(self.version, sw)
        listed = json.loads(re.search(r"const PRECACHE = (\[.*?\]);", sw, re.S).group(1))
        self.assertEqual(listed, self.precache)
        for url in listed:
            p = self.out / url.lstrip("/")
            self.assertTrue(p.is_file() or (p / "index.html").is_file(), url)
        for need in ("/static/app.js", "/static/store.js", "/static/transport.js", "/static/manifest.webmanifest"):
            self.assertIn(need, listed)

    def test_server_only_sw_source_not_copied_into_static(self):
        self.assertFalse((self.out / "static" / "sw.js").exists())

    def test_version_changes_with_content(self):
        other = pathlib.Path(self.tmp.name) / "e"
        v2, _ = bl.build(ROOT, other, "different")
        self.assertNotEqual(v2, self.version)


if __name__ == "__main__":
    unittest.main()
