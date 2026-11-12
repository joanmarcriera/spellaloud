"""Feedback button API tests: POST /api/feedback -> a Vikunja task, with a sqlite fallback queue.

A fake Vikunja (stdlib http.server on an ephemeral port) records every request, so no real Vikunja and
no real token are ever touched. Also covers public mode (SPELLING_PUBLIC_ROOT: the browser-only build is
served and the family API is switched off).

Run: python3 -m unittest discover -s tests -v
"""
import http.client
import json
import sqlite3
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402

TOKEN = "test-token-not-real"


class FakeVikunja:
    """Records PUT /api/v1/projects/<id>/tasks calls; answers `status` (201 by default)."""

    def __init__(self):
        self.calls, self.status, self.next_id = [], 201, 1000
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_PUT(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                fake.calls.append({"path": self.path, "auth": self.headers.get("Authorization"), "body": body})
                fake.next_id += 1
                out = json.dumps({"id": fake.next_id, **body} if fake.status < 300 else {"message": "boom"}).encode()
                self.send_response(fake.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(out)))
                self.end_headers()
                self.wfile.write(out)

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


class FeedbackBase(unittest.TestCase):
    public = False

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.data = Path(cls.tmp.name) / "data"
        cls.fake = FakeVikunja()
        extra = {}
        if cls.public:
            root = Path(cls.tmp.name) / "public"
            (root / "parent").mkdir(parents=True)
            (root / "static").mkdir()
            (root / "index.html").write_text("<!doctype html><title>kid</title>")
            (root / "parent" / "index.html").write_text("<!doctype html><title>parent</title>")
            (root / "static" / "app.js").write_text("export {};")
            (root / "sw.js").write_text("self;")
            extra["public_root"] = root
        cls.cfg = server.Config(data_dir=cls.data, today="2026-11-01", quiet=True, vikunja_url=cls.fake.url,
                                vikunja_token=TOKEN, vikunja_project=109, version="abc1234", **extra)
        cls.srv = server.make_server(cls.cfg, "127.0.0.1", 0)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        cls.fake.close()
        cls.tmp.cleanup()

    def setUp(self):
        self.fake.calls.clear()
        self.fake.status = 201
        self.cfg.vikunja_url = self.fake.url
        self.cfg.trust_proxy = False
        self.cfg.feedback_limiter.hits.clear()
        self.cfg.feedback_global_limiter = server.RateLimiter(server.FEEDBACK_GLOBAL_PER_HOUR, 3600)
        self.cfg.feedback_queue_max = server.FEEDBACK_QUEUE_MAX
        con = sqlite3.connect(self.data / "spellings.db")
        con.execute("DELETE FROM feedback")
        con.commit()
        con.close()

    def req(self, method, path, body=None, headers=None, raw=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = dict(headers or {})
        payload = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        if payload is not None:
            h.setdefault("Content-Type", "application/json")
        c.request(method, path, body=payload, headers=h)
        r = c.getresponse()
        data = r.read()
        c.close()
        try:
            return r.status, json.loads(data), data
        except ValueError:
            return r.status, None, data

    def pending(self):
        con = sqlite3.connect(self.data / "spellings.db")
        try:
            return con.execute("SELECT payload_json FROM feedback ORDER BY id").fetchall()
        finally:
            con.close()

    def send(self, text="The record button is hard to find", **kw):
        return self.req("POST", "/api/feedback", {"text": text, "page": "parent", **kw})


class TestFeedbackToVikunja(FeedbackBase):
    def test_creates_task_in_project_with_server_side_token(self):
        st, out, raw = self.send(name="Alex", contact="alex@example.org", kid="ash", version="local-1")
        self.assertEqual(st, 201, out)
        self.assertEqual(out, {"ok": True, "queued": False})
        self.assertNotIn(TOKEN.encode(), raw)  # the token never reaches the browser
        self.assertEqual(len(self.fake.calls), 1)
        call = self.fake.calls[0]
        self.assertEqual(call["path"], "/api/v1/projects/109/tasks")
        self.assertEqual(call["auth"], f"Bearer {TOKEN}")
        self.assertIn("The record button is hard to find", call["body"]["title"])
        desc = call["body"]["description"]
        for want in ("Alex", "alex@example.org", "ash", "parent", "local-1", "abc1234"):
            self.assertIn(want, desc)
        self.assertEqual(self.pending(), [])  # sent rows are not kept

    def test_markup_in_feedback_is_escaped_for_vikunja(self):
        st, _, _ = self.send(text='<img src=x onerror=alert(1)> and "quotes"', name="<b>x</b>")
        self.assertEqual(st, 201)
        desc = self.fake.calls[0]["body"]["description"]
        self.assertNotIn("<img", desc)
        self.assertNotIn("<b>x</b>", desc)
        self.assertIn("&lt;img src=x onerror=alert(1)&gt;", desc)

    def test_title_is_one_short_line(self):
        st, _, _ = self.send(text="line one\nline two " + "x" * 300)
        self.assertEqual(st, 201)
        title = self.fake.calls[0]["body"]["title"]
        self.assertNotIn("\n", title)
        self.assertLessEqual(len(title), 120)

    def test_validation(self):
        for body in ({}, {"text": ""}, {"text": "   "}, {"text": 5}, {"text": "x" * 2001},
                     {"text": "ok", "name": "n" * 101}, {"text": "ok", "contact": "c" * 201},
                     {"text": "ok", "kid": ["ash"]}):
            st, out, _ = self.req("POST", "/api/feedback", body)
            self.assertEqual(st, 400, body)
            self.assertIn("error", out)
        self.assertEqual(self.fake.calls, [])
        st, _, _ = self.send(text="x" * 2000)  # the cap itself is allowed
        self.assertEqual(st, 201)

    def test_same_csrf_and_host_rules(self):
        ok = json.dumps({"text": "hi"}).encode()
        self.assertEqual(self.req("POST", "/api/feedback", raw=ok, headers={"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.req("POST", "/api/feedback", {"text": "hi"}, headers={"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.req("POST", "/api/feedback", {"text": "hi"}, headers={"Sec-Fetch-Site": "cross-site"})[0], 403)
        self.assertEqual(self.req("POST", "/api/feedback", {"text": "hi"}, headers={"Host": "evil.example"})[0], 421)
        self.assertEqual(self.req("GET", "/api/feedback")[0], 405)
        self.assertEqual(self.fake.calls, [])


class TestFeedbackRateLimit(FeedbackBase):
    def test_five_per_hour_per_ip_then_429(self):
        for i in range(5):
            self.assertEqual(self.send(text=f"note {i}")[0], 201, i)
        st, out, _ = self.send(text="one too many")
        self.assertEqual(st, 429)
        self.assertIn("error", out)
        self.assertEqual(len(self.fake.calls), 5)

    def test_forwarded_for_ignored_unless_proxy_trusted(self):
        for i in range(5):
            self.send(text=f"n{i}")
        # without SPELLING_TRUST_PROXY a spoofed X-Forwarded-For cannot buy a new bucket
        st, _, _ = self.req("POST", "/api/feedback", {"text": "spoof"}, headers={"X-Forwarded-For": "203.0.113.9"})
        self.assertEqual(st, 429)
        self.cfg.trust_proxy = True
        st, _, _ = self.req("POST", "/api/feedback", {"text": "real client"}, headers={"X-Forwarded-For": "1.1.1.1, 203.0.113.9"})
        self.assertEqual(st, 201)

    def test_global_cap_stops_vikunja_calls_but_still_accepts(self):
        self.cfg.trust_proxy = True
        self.cfg.feedback_global_limiter = server.RateLimiter(3, 3600)
        for i in range(3):
            st, _, _ = self.req("POST", "/api/feedback", {"text": f"g{i}"}, headers={"X-Forwarded-For": f"198.51.100.{i}"})
            self.assertEqual(st, 201, i)
        # a flood from many IPs cannot lock real parents out: queued (bounded), not refused
        st, out, _ = self.req("POST", "/api/feedback", {"text": "g3"}, headers={"X-Forwarded-For": "198.51.100.99"})
        self.assertEqual((st, out), (202, {"ok": True, "queued": True}))
        self.assertEqual(len(self.fake.calls), 3)
        self.assertEqual(len(self.pending()), 1)

    def test_ipv6_clients_share_their_64(self):
        k = server.ip_key
        self.assertEqual(k("2001:db8:1:2::5"), k("2001:db8:1:2:ffff::1"))
        self.assertNotEqual(k("2001:db8:1:2::5"), k("2001:db8:1:3::5"))
        self.assertEqual(k("203.0.113.7"), "203.0.113.7")
        self.assertEqual(k("::ffff:203.0.113.7"), "203.0.113.7")
        self.assertEqual(k("not-an-ip"), "not-an-ip")

    def test_limiter_window_slides(self):
        now = [1000.0]
        lim = server.RateLimiter(limit=2, window=3600, clock=lambda: now[0])
        self.assertTrue(lim.allow("a"))
        self.assertTrue(lim.allow("a"))
        self.assertFalse(lim.allow("a"))
        self.assertTrue(lim.allow("b"))
        now[0] += 3601
        self.assertTrue(lim.allow("a"))


class TestFeedbackFallback(FeedbackBase):
    def test_vikunja_error_queues_and_answers_202(self):
        self.fake.status = 500
        st, out, raw = self.send(text="queued one")
        self.assertEqual(st, 202, out)
        self.assertEqual(out, {"ok": True, "queued": True})
        self.assertNotIn(b"boom", raw)  # upstream errors are not passed on
        rows = self.pending()
        self.assertEqual(len(rows), 1)
        self.assertEqual(json.loads(rows[0][0])["text"], "queued one")

    def test_vikunja_unreachable_or_unconfigured_queues(self):
        self.cfg.vikunja_url = "http://127.0.0.1:9"  # discard port: connection refused
        self.assertEqual(self.send(text="down")[0], 202)
        self.cfg.vikunja_url = ""
        self.assertEqual(self.send(text="unset")[0], 202)
        self.assertEqual(len(self.pending()), 2)

    def test_queue_flushes_on_next_success(self):
        self.fake.status = 503
        self.send(text="first")
        self.send(text="second")
        self.fake.status = 201
        self.fake.calls.clear()
        self.assertEqual(self.send(text="third")[0], 201)
        titles = [c["body"]["title"] for c in self.fake.calls]
        self.assertEqual(len(titles), 3)
        self.assertTrue(any("first" in t for t in titles) and any("second" in t for t in titles))
        self.assertEqual(self.pending(), [])

    def test_one_request_flushes_at_most_two_older_rows(self):
        self.fake.status = 500
        for i in range(4):
            self.send(text=f"old {i}")
        self.fake.status = 201
        self.fake.calls.clear()
        self.assertEqual(self.send(text="new")[0], 201)
        titles = [c["body"]["title"] for c in self.fake.calls]
        self.assertEqual(len(titles), 3)          # the parent's own task + 2 from the backlog
        self.assertIn("new", titles[0])           # the parent's own task goes first
        self.assertEqual(len(self.pending()), 2)

    def test_flush_skips_when_another_flush_holds_the_lock(self):
        self.fake.status = 500
        self.send(text="backlog")
        self.fake.status = 201
        self.fake.calls.clear()
        self.assertTrue(server.FLUSH_LOCK.acquire(timeout=1))
        try:
            self.assertEqual(server.flush_feedback(self.cfg), (0, 1))  # returns at once, no Vikunja call
            self.assertEqual(self.fake.calls, [])
            self.assertEqual(self.send(text="mine")[0], 201)           # own task still goes out
            self.assertEqual(len(self.fake.calls), 1)
        finally:
            server.FLUSH_LOCK.release()
        self.assertEqual(len(self.pending()), 1)

    def test_claim_is_atomic_and_expires(self):
        self.fake.status = 500
        self.send(text="only row")
        a = server.claim_next(self.cfg)
        self.assertIsNotNone(a)
        self.assertIsNone(server.claim_next(self.cfg))  # claimed rows are invisible to a second sender
        server.unclaim(self.cfg, a[0])
        self.assertEqual(server.claim_next(self.cfg)[0], a[0])
        self.assertEqual(server.claim_next(self.cfg, now=server.time.time() + server.CLAIM_TTL + 1)[0], a[0])  # crashed sender

    def test_parallel_flushes_never_send_a_row_twice(self):
        self.fake.status = 500
        for i in range(4):
            self.send(text=f"row {i}")
        self.fake.status = 201
        self.fake.calls.clear()

        class NoLock:  # let every thread in at once, so only the row claims stand between them
            def acquire(self, blocking=True):
                return True

            def release(self):
                pass

        real, server.FLUSH_LOCK = server.FLUSH_LOCK, NoLock()
        try:
            ts = [threading.Thread(target=server.flush_feedback, args=(self.cfg,)) for _ in range(8)]
            for t in ts:
                t.start()
            for t in ts:
                t.join(10)
        finally:
            server.FLUSH_LOCK = real
        titles = sorted(c["body"]["title"] for c in self.fake.calls)
        self.assertEqual(len(titles), 4, titles)
        self.assertEqual(len(set(titles)), 4)
        self.assertEqual(self.pending(), [])

    def test_full_queue_answers_429(self):
        self.cfg.feedback_queue_max = 2
        self.fake.status = 500
        self.assertEqual(self.send(text="q1")[0], 202)
        self.assertEqual(self.send(text="q2")[0], 202)
        st, out, _ = self.send(text="q3")
        self.assertEqual(st, 429)
        self.assertIn("error", out)
        self.assertEqual(len(self.pending()), 2)

    def test_flush_feedback_function(self):
        self.fake.status = 500
        self.send(text="later")
        self.assertEqual(server.flush_feedback(self.cfg), (0, 1))
        self.fake.status = 201
        self.assertEqual(server.flush_feedback(self.cfg), (1, 0))
        self.assertEqual(self.pending(), [])


class TestPublicMode(FeedbackBase):
    public = True

    def test_serves_the_browser_build(self):
        for path, marker in (("/", b"kid"), ("/parent", b"parent"), ("/parent/", b"parent"),
                             ("/static/app.js", b"export"), ("/sw.js", b"self")):
            st, _, raw = self.req("GET", path)
            self.assertEqual(st, 200, path)
            self.assertIn(marker, raw, path)
        for path in ("/../server.py", "/static/../../x", "/.hidden", "/nope.html"):
            self.assertIn(self.req("GET", path)[0], (400, 404), path)

    def test_family_api_is_off_feedback_is_on(self):
        for method, path in (("GET", "/api/kids"), ("GET", "/api/me"), ("GET", "/api/report")):
            self.assertEqual(self.req(method, path)[0], 404, path)
        self.assertEqual(self.req("POST", "/api/kids/ash/weeks", {"week_start": "2026-10-26", "words": ["a"]})[0], 404)
        self.assertEqual(self.send()[0], 201)


class TestConfigFromEnv(unittest.TestCase):
    def test_env_and_token_kept_out_of_repr(self):
        import os
        from unittest import mock
        env = {"SPELLING_VIKUNJA_URL": "https://v.example", "SPELLING_VIKUNJA_TOKEN": "sekret",
               "SPELLING_VIKUNJA_PROJECT_ID": "109", "SPELLING_TRUST_PROXY": "1",
               "SPELLING_PUBLIC_ROOT": "/app/public", "SPELLING_VERSION": "v9"}
        with mock.patch.dict(os.environ, env):
            cfg = server.Config.from_env()
        self.assertEqual((cfg.vikunja_url, cfg.vikunja_project, cfg.trust_proxy, cfg.version),
                         ("https://v.example", 109, True, "v9"))
        self.assertEqual(cfg.public_root, Path("/app/public"))
        self.assertNotIn("sekret", repr(cfg))


if __name__ == "__main__":
    unittest.main()
