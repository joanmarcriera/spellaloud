"""bin/perf-budget (Vikunja #4339): exit 0 under budget, non-zero over budget, on a tiny fixture repo.
Run: python3 -m unittest discover -s tests"""
import json, pathlib, shutil, subprocess, sys, tempfile, unittest

REPO = pathlib.Path(__file__).resolve().parent.parent
TOOL = REPO / "bin" / "perf-budget"


def run(*args):
    return subprocess.run([sys.executable, str(TOOL), *args], capture_output=True, text=True, timeout=60)


class PerfBudget(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        (self.tmp / "static").mkdir()
        (self.tmp / "static" / "a.js").write_text("console.log(1);\n" * 50)
        (self.tmp / "static" / "style.css").write_text("body{margin:0}\n")
        (self.tmp / "static" / "index.html").write_text("<p>hi</p>\n")
        # minimal server: answers 200 on any GET on SPELLING_PORT
        (self.tmp / "server.py").write_text(
            "import os, http.server\n"
            "class H(http.server.BaseHTTPRequestHandler):\n"
            "    def do_GET(self): self.send_response(200); self.end_headers(); self.wfile.write(b'ok')\n"
            "    def log_message(self, *a): pass\n"
            "http.server.HTTPServer(('127.0.0.1', int(os.environ['SPELLING_PORT'])), H).serve_forever()\n")
        self.budget = self.tmp / "budget.json"

    def write_budget(self, factor, start=1.5):
        r = run("--root", str(self.tmp), "--budget", str(self.budget), "--write-budget")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        data = json.loads(self.budget.read_text())
        data["gzip_bytes"] = {k: int(v / factor) for k, v in data["gzip_bytes"].items()}
        data["gzip_total_bytes"] = int(data["gzip_total_bytes"] / factor)
        data["start_seconds"] = start
        self.budget.write_text(json.dumps(data))

    def test_under_budget_exits_0_and_prints_table(self):
        self.write_budget(1)
        r = run("--root", str(self.tmp), "--budget", str(self.budget))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("TOTAL", r.stdout)
        self.assertIn("server start to 200", r.stdout)

    def test_over_size_budget_exits_nonzero(self):
        self.write_budget(10)
        r = run("--root", str(self.tmp), "--budget", str(self.budget))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("OVER", r.stdout)

    def test_over_start_budget_exits_nonzero(self):
        self.write_budget(1, start=0.0)
        r = run("--root", str(self.tmp), "--budget", str(self.budget))
        self.assertNotEqual(r.returncode, 0)

    def test_real_repo_is_within_committed_budget(self):
        r = run()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main()
