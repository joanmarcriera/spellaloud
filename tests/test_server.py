"""API tests: a real server on an ephemeral port with a temp data dir.

Run: python3 -m unittest discover -s tests -v
"""
import http.client
import json
import sqlite3
import struct
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402

TODAY = "2026-10-15"  # a Thursday; its Monday is 2026-10-12


def wav(n=100):
    """A minimal valid 22.05 kHz mono 16-bit WAV with n samples."""
    data = b"\x01\x00" * n
    return (b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt " +
            struct.pack("<IHHIIHH", 16, 1, 1, 22050, 44100, 2, 16) +
            b"data" + struct.pack("<I", len(data)) + data)


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.data = Path(cls.tmp.name)
        cfg = server.Config(data_dir=cls.data, today=TODAY, home_url="https://home.example/",
                            default_kid="finn", quiet=True)
        cls.srv = server.make_server(cfg, "127.0.0.1", 0)
        cls.port = cls.srv.server_address[1]
        cls.thread = threading.Thread(target=cls.srv.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        cls.tmp.cleanup()

    def setUp(self):
        # Fresh content for every test, keep seeded kids.
        con = sqlite3.connect(self.data / "spellings.db")
        con.execute("PRAGMA foreign_keys=ON")
        con.execute("DELETE FROM week")
        con.execute("DELETE FROM session")
        con.commit()
        con.close()
        for f in (self.data / "audio").glob("*.wav"):
            f.unlink()

    def req(self, method, path, body=None, headers=None, raw=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        h = dict(headers or {})
        if raw is not None:
            h.setdefault("Content-Type", "audio/wav" if path.endswith("/audio") else "application/json")
            payload = raw
        elif body is not None:
            payload = json.dumps(body).encode()
            h.setdefault("Content-Type", "application/json")
        else:
            payload = None
        c.request(method, path, body=payload, headers=h)
        r = c.getresponse()
        data = r.read()
        c.close()
        try:
            parsed = json.loads(data)
        except ValueError:
            parsed = data
        return r.status, parsed, r

    def mkweek(self, kid="finn", start="2026-10-12", words=("one", "two", "three")):
        st, w, _ = self.req("POST", f"/api/kids/{kid}/weeks", {"week_start": start, "words": list(words)})
        self.assertEqual(st, 201, w)
        return w

    def upload(self, word_id):
        st, _, _ = self.req("PUT", f"/api/words/{word_id}/audio", raw=wav(), headers={"Content-Type": "audio/wav"})
        self.assertEqual(st, 200)

    def session(self, kid, mode, results):
        return self.req("POST", f"/api/kids/{kid}/sessions",
                        {"mode": mode, "settings": {}, "results": results})


class TestBasics(Base):
    def test_kids_seeded_with_defaults(self):
        st, kids, _ = self.req("GET", "/api/kids")
        self.assertEqual(st, 200)
        self.assertEqual([k["slug"] for k in kids], ["ash", "finn"])
        st, me, _ = self.req("GET", "/api/me?kid=ash")
        self.assertEqual(me["kid"]["settings"], {"speed": "slow", "repeats": 2, "pause": "long", "order": "inorder"})
        st, me, _ = self.req("GET", "/api/me?kid=finn")
        self.assertEqual(me["kid"]["settings"], {"speed": "normal", "repeats": 2, "pause": "short", "order": "mix"})
        self.assertEqual(me["home_url"], "https://home.example/")

    def test_kid_from_host_and_overrides(self):
        _, me, _ = self.req("GET", "/api/me", headers={"Host": "ash.home.example"})
        self.assertEqual(me["kid"]["slug"], "ash")
        _, me, _ = self.req("GET", "/api/me")  # 127.0.0.1 = dev host -> default kid
        self.assertEqual(me["kid"]["slug"], "finn")
        # on a kid host ?kid= is ignored
        _, me, _ = self.req("GET", "/api/me?kid=ash", headers={"Host": "finn.home.example"})
        self.assertEqual(me["kid"]["slug"], "finn")
        st, err, _ = self.req("GET", "/api/me?kid=nobody")
        self.assertEqual(st, 404)
        self.assertIn("error", err)

    def test_foreign_host_rejected_everywhere(self):
        for path in ("/", "/parent", "/static/lib.js", "/api/me", "/api/kids"):
            st, err, _ = self.req("GET", path, headers={"Host": "evil.example"})
            self.assertEqual(st, 421, path)
            self.assertIn("error", err)
        st, _, _ = self.req("GET", "/api/me", headers={"Host": "ASH.home.example:8080"})
        self.assertEqual(st, 200)  # case-insensitive, port stripped

    def test_csrf(self):
        ok = {"week_start": "2026-10-12", "words": ["a"]}
        # text/plain "simple" request refused
        st, _, _ = self.req("POST", "/api/kids/finn/weeks", raw=json.dumps(ok).encode(), headers={"Content-Type": "text/plain"})
        self.assertEqual(st, 415)
        st, _, _ = self.req("POST", "/api/kids/finn/weeks", raw=json.dumps(ok).encode(), headers={"Content-Type": ""})
        self.assertEqual(st, 415)
        w = self.mkweek()
        st, _, _ = self.req("PUT", f"/api/words/{w['words'][0]['id']}/audio", raw=wav(), headers={"Content-Type": "text/plain"})
        self.assertEqual(st, 415)
        # cross-origin refused, even to an allowed-but-different origin
        host = f"127.0.0.1:{self.port}"
        for origin in ("https://evil.example", "http://localhost:1", "null"):
            st, _, _ = self.req("POST", "/api/kids/ash/weeks", ok, headers={"Origin": origin})
            self.assertEqual(st, 403, origin)
        st, _, _ = self.req("POST", "/api/kids/ash/weeks", ok, headers={"Sec-Fetch-Site": "cross-site"})
        self.assertEqual(st, 403)
        st, _, r = self.req("POST", "/api/kids/ash/weeks", ok, headers={"Origin": f"http://{host}", "Sec-Fetch-Site": "same-origin"})
        self.assertEqual(st, 201)  # same origin accepted
        self.assertIsNone(r.getheader("Access-Control-Allow-Origin"))

    def test_unknown_query_params_ignored(self):
        # the kid app appends vw/vh/dpr/scale to /api/me for the access log; the server must not care
        st, me, _ = self.req("GET", "/api/me?kid=ash&vw=1920&vh=950&dpr=1.5&scale=0.8&whatever=x")
        self.assertEqual((st, me["kid"]["slug"]), (200, "ash"))

    def test_static_pages(self):
        for path, needle in (("/", b"<html"), ("/parent", b"<html"), ("/parents", b"<html"), ("/static/lib.js", b"export")):
            st, body, r = self.req("GET", path)
            self.assertEqual(st, 200, path)
            self.assertIn(needle, body if isinstance(body, bytes) else json.dumps(body).encode())

    def test_static_traversal_rejected(self):
        for path in ("/static/../server.py", "/static/%2e%2e/server.py", "/static/..%2fserver.py",
                     "/static//etc/passwd", "/static/%00", "/static/"):
            st, body, _ = self.req("GET", path)
            self.assertIn(st, (400, 404), path)
            self.assertNotIn(b"ThreadingHTTPServer", body if isinstance(body, bytes) else b"")

    def test_unknown_route_json_404(self):
        st, err, _ = self.req("GET", "/api/nothing")
        self.assertEqual(st, 404)
        self.assertIn("error", err)

    def test_method_not_allowed(self):
        st, err, _ = self.req("PUT", "/api/kids")
        self.assertEqual(st, 405)


class TestWeeksAndWords(Base):
    def test_create_week_normalises_to_monday_and_lists(self):
        w = self.mkweek(start="2026-10-15")
        self.assertEqual(w["week_start"], "2026-10-12")
        self.assertEqual(w["term"], "2026 Autumn")
        self.assertEqual([x["label"] for x in w["words"]], ["one", "two", "three"])
        self.assertEqual([x["position"] for x in w["words"]], [1, 2, 3])
        self.assertFalse(w["words"][0]["has_audio"])
        st, weeks, _ = self.req("GET", "/api/kids/finn/weeks")
        self.assertEqual(len(weeks), 1)
        _, other, _ = self.req("GET", "/api/kids/ash/weeks")
        self.assertEqual(other, [])

    def test_duplicate_week_409(self):
        self.mkweek()
        st, err, _ = self.req("POST", "/api/kids/finn/weeks", {"week_start": "2026-10-14", "words": ["x"]})
        self.assertEqual(st, 409)
        self.assertIn("error", err)
        # same week for the other kid is fine
        self.mkweek(kid="ash")

    def test_validation(self):
        bad = [
            {"week_start": "nope", "words": ["a"]},
            {"week_start": "2026-10-12", "words": "a"},
            {"week_start": "2026-10-12", "words": ["a" * 41]},
            {"week_start": "2026-10-12", "words": ["   "]},
            {"words": ["a"]},
        ]
        for b in bad:
            st, err, _ = self.req("POST", "/api/kids/finn/weeks", b)
            self.assertEqual(st, 400, b)
            self.assertIn("error", err)
        st, _, _ = self.req("POST", "/api/kids/finn/weeks", raw=b"{not json", headers={"Content-Type": "application/json"})
        self.assertEqual(st, 400)
        st, _, _ = self.req("POST", "/api/kids/nobody/weeks", {"week_start": "2026-10-12", "words": []})
        self.assertEqual(st, 404)

    def test_labels_trimmed(self):
        w = self.mkweek(words=["  cat  "])
        self.assertEqual(w["words"][0]["label"], "cat")

    def test_word_add_refuses_the_101st_word(self):
        # BUG-7: a week holds at most MAX_WORDS_PER_WEEK words, same as week create and backup import.
        w = self.mkweek(words=[f"w{i}" for i in range(99)])
        st, _, _ = self.req("POST", f"/api/weeks/{w['id']}/words", {"label": "w99"})
        self.assertEqual(st, 201)
        st, err, _ = self.req("POST", f"/api/weeks/{w['id']}/words", {"label": "w100"})
        self.assertEqual(st, 400, err)

    def test_word_crud(self):
        w = self.mkweek()
        st, nw, _ = self.req("POST", f"/api/weeks/{w['id']}/words", {"label": "four"})
        self.assertEqual(st, 201)
        self.assertEqual(nw["position"], 4)
        st, up, _ = self.req("PATCH", f"/api/words/{nw['id']}", {"label": "FOUR"})
        self.assertEqual((st, up["label"]), (200, "FOUR"))
        st, _, _ = self.req("PATCH", f"/api/words/{nw['id']}", {"label": ""})
        self.assertEqual(st, 400)
        st, _, _ = self.req("DELETE", f"/api/words/{nw['id']}")
        self.assertEqual(st, 200)
        st, _, _ = self.req("DELETE", f"/api/words/{nw['id']}")
        self.assertEqual(st, 404)
        st, _, _ = self.req("POST", "/api/weeks/9999/words", {"label": "x"})
        self.assertEqual(st, 404)
        st, _, _ = self.req("PATCH", "/api/words/abc", {"label": "x"})
        self.assertEqual(st, 404)

    def test_delete_week_removes_words_and_audio(self):
        w = self.mkweek()
        wid = w["words"][0]["id"]
        self.upload(wid)
        f = self.data / "audio" / f"{wid}.wav"
        self.assertTrue(f.exists())
        st, _, _ = self.req("DELETE", f"/api/weeks/{w['id']}")
        self.assertEqual(st, 200)
        self.assertFalse(f.exists())
        _, weeks, _ = self.req("GET", "/api/kids/finn/weeks")
        self.assertEqual(weeks, [])

    def test_delete_word_removes_audio(self):
        w = self.mkweek()
        wid = w["words"][0]["id"]
        self.upload(wid)
        self.req("DELETE", f"/api/words/{wid}")
        self.assertFalse((self.data / "audio" / f"{wid}.wav").exists())


class TestAudio(Base):
    def test_round_trip(self):
        w = self.mkweek()
        wid = w["words"][0]["id"]
        st, _, r = self.req("GET", f"/api/words/{wid}/audio")
        self.assertEqual(st, 404)
        data = wav(500)
        st, _, _ = self.req("PUT", f"/api/words/{wid}/audio", raw=data, headers={"Content-Type": "audio/wav"})
        self.assertEqual(st, 200)
        st, body, r = self.req("GET", f"/api/words/{wid}/audio")
        self.assertEqual(st, 200)
        self.assertEqual(body, data)
        self.assertEqual(r.getheader("Content-Type"), "audio/wav")
        self.assertEqual(r.getheader("Cache-Control"), "no-cache")
        _, weeks, _ = self.req("GET", "/api/kids/finn/weeks")
        self.assertTrue(weeks[0]["words"][0]["has_audio"])
        self.assertFalse(weeks[0]["words"][1]["has_audio"])

    def test_rejects_non_wav_and_unknown_word(self):
        w = self.mkweek()
        wid = w["words"][0]["id"]
        st, err, _ = self.req("PUT", f"/api/words/{wid}/audio", raw=b"ID3" + b"\x00" * 100)
        self.assertEqual(st, 400)
        st, _, _ = self.req("PUT", f"/api/words/{wid}/audio", raw=b"RIFF\x00\x00\x00\x00AVI " + b"\x00" * 50)
        self.assertEqual(st, 400)
        st, _, _ = self.req("PUT", f"/api/words/{wid}/audio", raw=b"")
        self.assertEqual(st, 400)
        st, _, _ = self.req("PUT", "/api/words/99999/audio", raw=wav())
        self.assertEqual(st, 404)

    def test_size_limits(self):
        w = self.mkweek()
        wid = w["words"][0]["id"]
        big = wav(10)[:44] + b"\x00" * (1024 * 1024)
        st, _, _ = self.req("PUT", f"/api/words/{wid}/audio", raw=big)
        self.assertEqual(st, 413)
        st, _, _ = self.req("POST", "/api/kids/finn/weeks", raw=b"{" + b" " * 70000 + b"}",
                            headers={"Content-Type": "application/json"})
        self.assertEqual(st, 413)

    def test_path_comes_from_integer_id_only(self):
        for bad in ("../x", "1.wav", "%2e%2e%2fx", "1%2f2"):
            st, _, _ = self.req("GET", f"/api/words/{bad}/audio")
            self.assertIn(st, (400, 404), bad)
            st, _, _ = self.req("PUT", f"/api/words/{bad}/audio", raw=wav())
            self.assertIn(st, (400, 404), bad)
        self.assertEqual(list(self.data.glob("*.wav")), [])


class TestPractice(Base):
    def test_week_mode_skips_words_without_audio(self):
        w = self.mkweek()
        self.upload(w["words"][0]["id"])
        self.upload(w["words"][2]["id"])
        st, p, _ = self.req("GET", "/api/kids/finn/practice?mode=week")
        self.assertEqual(st, 200)
        self.assertEqual([x["label"] for x in p["words"]], ["one", "three"])
        self.assertEqual(p["skipped"], 1)

    def test_current_week_is_latest_not_after_today(self):
        old = self.mkweek(start="2026-10-05", words=["old"])
        cur = self.mkweek(start="2026-10-12", words=["cur"])
        fut = self.mkweek(start="2026-10-19", words=["fut"])
        for w in (old, cur, fut):
            self.upload(w["words"][0]["id"])
        _, p, _ = self.req("GET", "/api/kids/finn/practice?mode=week")
        self.assertEqual([x["label"] for x in p["words"]], ["cur"])

    def test_current_week_falls_back_to_earliest_future(self):
        a = self.mkweek(start="2026-10-26", words=["later"])
        b = self.mkweek(start="2026-11-02", words=["latest"])
        self.upload(a["words"][0]["id"])
        self.upload(b["words"][0]["id"])
        _, p, _ = self.req("GET", "/api/kids/finn/practice?mode=week")
        self.assertEqual([x["label"] for x in p["words"]], ["later"])

    def test_term_mode_only_current_term(self):
        a = self.mkweek(start="2026-09-14", words=["sept"])
        b = self.mkweek(start="2026-10-12", words=["oct"])
        c = self.mkweek(start="2026-06-15", words=["june"])  # Summer term: excluded
        for w in (a, b, c):
            self.upload(w["words"][0]["id"])
        _, p, _ = self.req("GET", "/api/kids/finn/practice?mode=term")
        self.assertEqual([x["label"] for x in p["words"]], ["sept", "oct"])

    def test_tricky_mode(self):
        w = self.mkweek(words=["a", "b", "c"])
        ids = [x["id"] for x in w["words"]]
        for i in ids:
            self.upload(i)
        _, p, _ = self.req("GET", "/api/kids/finn/practice?mode=tricky")
        self.assertEqual(p["words"], [])
        # a: missed once long ago then right 3x -> not tricky (outside last 3)
        # b: missed in latest session -> tricky;  c: always right
        self.session("finn", "week", [{"word_id": ids[0], "correct": 0}, {"word_id": ids[1], "correct": 1}, {"word_id": ids[2], "correct": 1}])
        for _ in range(3):
            self.session("finn", "week", [{"word_id": ids[0], "correct": 1}, {"word_id": ids[1], "correct": 1}, {"word_id": ids[2], "correct": 1}])
        self.session("finn", "week", [{"word_id": ids[1], "correct": 0}])
        _, p, _ = self.req("GET", "/api/kids/finn/practice?mode=tricky")
        self.assertEqual([x["label"] for x in p["words"]], ["b"])

    def test_tricky_clears_after_two_right_in_a_row(self):
        w = self.mkweek(words=["a"])
        wid = w["words"][0]["id"]
        self.upload(wid)
        tricky = lambda: [x["label"] for x in self.req("GET", "/api/kids/finn/practice?mode=tricky")[1]["words"]]
        self.session("finn", "week", [{"word_id": wid, "correct": 0}])
        self.session("finn", "week", [{"word_id": wid, "correct": 1}])
        self.assertEqual(tricky(), ["a"])  # one right is not enough
        self.session("finn", "week", [{"word_id": wid, "correct": 1}])
        self.assertEqual(tricky(), [])

    def test_known_button_clears_tricky_until_next_miss(self):
        w = self.mkweek(words=["a", "b"])
        a, b = (x["id"] for x in w["words"])
        for i in (a, b):
            self.upload(i)
        tricky = lambda: [x["label"] for x in self.req("GET", "/api/kids/finn/practice?mode=tricky")[1]["words"]]
        self.session("finn", "week", [{"word_id": a, "correct": 0}, {"word_id": b, "correct": 0}])
        self.assertEqual(tricky(), ["a", "b"])
        self.assertEqual(self.req("POST", f"/api/words/{a}/known")[0], 200)
        self.assertEqual(tricky(), ["b"])
        self.assertEqual(self.req("POST", "/api/words/999999/known")[0], 404)
        self.session("finn", "week", [{"word_id": a, "correct": 0}])  # missed again -> tricky again
        self.assertEqual(tricky(), ["a", "b"])
        _, hist, _ = self.req("GET", "/api/kids/finn/history")
        self.assertEqual(hist["weeks"][0]["tricky"], 2)

    def test_term_override_and_scopes(self):
        a = self.mkweek(start="2026-09-14", words=["sept"])      # 2026 Autumn (auto)
        b = self.mkweek(start="2026-06-15", words=["june"])      # 2026 Summer (auto)
        c = self.mkweek(start="2025-10-13", words=["last"])      # 2025 Autumn (auto)
        d = self.mkweek(start="2026-03-30", words=["easter"])    # 2026 Spring (auto)
        for w in (a, b, c, d):
            self.upload(w["words"][0]["id"])
            self.session("finn", "week", [{"word_id": w["words"][0]["id"], "correct": 0}])
        labels = lambda qs: [x["label"] for x in self.req("GET", "/api/kids/finn/practice?" + qs)[1]["words"]]
        self.assertEqual(labels("mode=term"), ["sept"])
        self.assertEqual(labels("mode=term&term=2026+Summer"), ["june"])
        self.assertEqual(labels("mode=tricky&term=2025+Autumn"), ["last"])
        self.assertEqual(labels("mode=term&term=2025-26"), ["last", "easter", "june"])  # whole academic year, oldest first
        # the parent moves a week into another term; null goes back to automatic
        st, w, _ = self.req("PATCH", f"/api/weeks/{d['id']}", {"term": "2026 Summer"})
        self.assertEqual((st, w["term"], w["term_auto"]), (200, "2026 Summer", False))
        self.assertEqual(labels("mode=term&term=2026+Summer"), ["easter", "june"])
        _, w, _ = self.req("PATCH", f"/api/weeks/{d['id']}", {"term": None})
        self.assertEqual((w["term"], w["term_auto"]), ("2026 Spring", True))
        self.assertEqual(w["term_options"], ["2025 Summer", "2025 Autumn", "2026 Summer", "2026 Autumn"])  # neighbours of the automatic term
        self.assertEqual(self.req("PATCH", f"/api/weeks/{d['id']}", {"term": "Winter"})[0], 400)
        self.assertEqual(self.req("PATCH", "/api/weeks/999999", {"term": None})[0], 404)
        self.assertEqual(self.req("GET", "/api/kids/finn/practice?mode=term&term=bogus")[0], 400)
        self.assertEqual(self.req("GET", "/api/kids/finn/practice?mode=week&term=2026+Summer")[0], 400)
        # a term can be given when the week is created
        st, e, _ = self.req("POST", "/api/kids/finn/weeks", {"week_start": "2026-04-06", "words": ["x"], "term": "2026 Spring"})
        self.assertEqual((st, e["term"], e["term_auto"]), (201, "2026 Spring", False))

    def test_terms_list(self):
        self.mkweek(start="2026-09-14", words=["a"])
        self.mkweek(start="2026-03-02", words=["b"])
        self.mkweek(start="2026-06-15", words=["c"])
        self.mkweek(start="2025-10-13", words=["d"])
        _, t, _ = self.req("GET", "/api/kids/finn/terms")
        self.assertEqual(t["current"], "2026 Autumn")
        self.assertEqual([x["key"] for x in t["terms"]], ["2026 Autumn", "2026 Summer", "2026 Spring", "2025 Autumn"])
        self.assertEqual([x["key"] for x in t["years"]], ["2025-26"])  # only academic years with 2+ terms
        self.assertEqual(t["years"][0]["label"], "2025-26 (whole year)")

    def test_big_spell_miss_is_tricky(self):
        w = self.mkweek(words=["a", "b"])
        ids = [x["id"] for x in w["words"]]
        for i in ids:
            self.upload(i)
        self.session("finn", "term", [{"word_id": ids[0], "correct": 1}, {"word_id": ids[1], "correct": 0}])
        _, p, _ = self.req("GET", "/api/kids/finn/practice?mode=tricky")
        self.assertEqual([x["label"] for x in p["words"]], ["b"])

    def test_past_week_practice_and_history(self):
        old = self.mkweek(start="2026-10-05", words=["o1", "o2", "o3"])
        cur = self.mkweek(start="2026-10-12", words=["c1"])
        ids = [x["id"] for x in old["words"]]
        for i in ids + [cur["words"][0]["id"]]:
            self.upload(i)
        # o1 always right, o2 right/wrong/right, o3 wrong/wrong; o3 stays tricky
        for r in ([1, 1, 0], [1, 0, 0], [1, 1, 0]):
            self.session("finn", "week", [{"word_id": i, "correct": c} for i, c in zip(ids, r)])
        st, p, _ = self.req("GET", f"/api/kids/finn/practice?mode=week&week={old['id']}")
        self.assertEqual([x["label"] for x in p["words"]], ["o1", "o2", "o3"])
        _, p, _ = self.req("GET", f"/api/kids/finn/practice?mode=week&week={old['id']}&only=tricky")
        self.assertEqual([x["label"] for x in p["words"]], ["o2", "o3"])
        self.assertEqual(self.req("GET", "/api/kids/finn/practice?mode=week&week=999999")[0], 404)
        self.assertEqual(self.req("GET", "/api/kids/finn/practice?mode=week&week=x")[0], 404)
        _, hist, _ = self.req("GET", "/api/kids/finn/history")
        self.assertEqual([w["week_start"] for w in hist["weeks"]], ["2026-10-12", "2026-10-05"])
        self.assertEqual(hist["current"], cur["id"])
        o = hist["weeks"][1]
        self.assertEqual((o["sessions"], o["tricky"]), (3, 2))
        by = {w["label"]: w for w in o["words"]}
        self.assertEqual(by["o1"]["status"], "solid")
        self.assertEqual(by["o2"]["status"], "shaky")
        self.assertEqual(by["o3"]["status"], "failing")
        self.assertEqual(by["o3"]["history"], [0, 0, 0])
        self.assertEqual(hist["weeks"][0]["words"][0]["status"], "new")

    def test_other_kids_week_is_unknown(self):
        a = self.mkweek(words=["x"])
        self.assertEqual(self.req("GET", f"/api/kids/ash/practice?mode=week&week={a['id']}")[0], 404)

    def test_bad_mode(self):
        st, _, _ = self.req("GET", "/api/kids/finn/practice?mode=zzz")
        self.assertEqual(st, 400)


class TestSettings(Base):
    def test_update_and_validate(self):
        st, s, _ = self.req("PUT", "/api/kids/ash/settings", {"speed": "fast", "repeats": 3, "pause": "short", "order": "mix"})
        self.assertEqual(st, 200)
        _, me, _ = self.req("GET", "/api/me?kid=ash")
        self.assertEqual(me["kid"]["settings"], {"speed": "fast", "repeats": 3, "pause": "short", "order": "mix"})
        for bad in ({"speed": "warp", "repeats": 1, "pause": "short", "order": "mix"},
                    {"speed": "fast", "repeats": 9, "pause": "short", "order": "mix"},
                    {"speed": "fast", "repeats": 1, "pause": "x", "order": "mix"},
                    {"speed": "fast", "repeats": 1, "pause": "short", "order": "x"},
                    {"speed": "fast"}):
            st, _, _ = self.req("PUT", "/api/kids/ash/settings", bad)
            self.assertEqual(st, 400, bad)

    def test_optional_voice_choice(self):
        base = {"speed": "fast", "repeats": 3, "pause": "short", "order": "mix"}
        st, s, _ = self.req("PUT", "/api/kids/ash/settings", {**base, "voice": "Daniel"})
        self.assertEqual((st, s["voice"]), (200, "Daniel"))
        _, kids, _ = self.req("GET", "/api/kids")
        self.assertEqual({k["slug"]: k["settings"].get("voice") for k in kids}, {"ash": "Daniel", "finn": None})
        for bad in (5, "x" * 121, "a\nb"):
            st, _, _ = self.req("PUT", "/api/kids/ash/settings", {**base, "voice": bad})
            self.assertEqual(st, 400, bad)
        st, s, _ = self.req("PUT", "/api/kids/ash/settings", {**base, "voice": ""})
        self.assertEqual((st, s), (200, base))  # empty = automatic, key absent

    def test_optional_type_mode_flag(self):
        """#5604: settings.typeMode is stored only when true; absent = off (the shipped default)."""
        base = {"speed": "fast", "repeats": 3, "pause": "short", "order": "mix"}
        _, kids, _ = self.req("GET", "/api/kids")
        self.assertTrue(all("typeMode" not in k["settings"] for k in kids))
        st, s, _ = self.req("PUT", "/api/kids/ash/settings", {**base, "typeMode": True})
        self.assertEqual((st, s.get("typeMode")), (200, True))
        st, s, _ = self.req("PUT", "/api/kids/ash/settings", {**base, "typeMode": "yes"})
        self.assertEqual((st, "typeMode" in s), (200, False))  # only boolean true counts
        st, s, _ = self.req("PUT", "/api/kids/ash/settings", {**base, "typeMode": False})
        self.assertEqual((st, s), (200, base))


class TestSessions(Base):
    def test_stars_and_score(self):
        w = self.mkweek(words=list("abcd"))
        ids = [x["id"] for x in w["words"]]
        st, r, _ = self.session("finn", "week", [{"word_id": i, "correct": 1} for i in ids])
        self.assertEqual((st, r["score"], r["total"], r["stars"]), (201, 4, 4, 3))
        _, r, _ = self.session("finn", "week", [{"word_id": ids[0], "correct": 1}, {"word_id": ids[1], "correct": 1},
                                                  {"word_id": ids[2], "correct": 0}, {"word_id": ids[3], "correct": 0}])
        self.assertEqual((r["score"], r["stars"]), (2, 2))
        _, r, _ = self.session("finn", "week", [{"word_id": i, "correct": 0} for i in ids])
        self.assertEqual((r["score"], r["stars"]), (0, 1))

    def test_validation(self):
        w = self.mkweek()
        wid = w["words"][0]["id"]
        for body in ({"mode": "bad", "results": [{"word_id": wid, "correct": 1}]},
                     {"mode": "week", "results": []},
                     {"mode": "week", "results": [{"word_id": 99999, "correct": 1}]},
                     {"mode": "week", "results": [{"word_id": wid, "correct": 5}]},
                     {"mode": "week", "results": [{"word_id": wid, "correct": 1}, {"word_id": wid, "correct": 0}]},
                     {"mode": "week"}):
            st, err, _ = self.req("POST", "/api/kids/finn/sessions", body)
            self.assertEqual(st, 400, body)
            self.assertIn("error", err)

    def test_word_of_other_kid_rejected(self):
        w = self.mkweek(kid="ash")
        st, _, _ = self.session("finn", "week", [{"word_id": w["words"][0]["id"], "correct": 1}])
        self.assertEqual(st, 400)

    def test_progress_and_streak(self):
        w = self.mkweek()
        wid = w["words"][0]["id"]
        # Sessions on today, yesterday, two days ago, and a gap before that.
        con = sqlite3.connect(self.data / "spellings.db")
        for d in ("2026-10-10", "2026-10-13", "2026-10-14", "2026-10-15"):
            cur = con.execute("INSERT INTO session(kid_slug,created_at,mode,settings_json) VALUES('finn',?,?,?)",
                              (d + "T10:00:00", "week", "{}"))
            con.execute("INSERT INTO result VALUES(?,?,1)", (cur.lastrowid, wid))
        con.commit()
        con.close()
        st, pr, _ = self.req("GET", "/api/kids/finn/progress")
        self.assertEqual(st, 200)
        self.assertEqual(pr["streak"], 3)
        self.assertEqual(pr["stars"], 12)
        self.assertEqual(len(pr["sessions"]), 4)
        self.assertEqual(pr["sessions"][0]["created_at"][:10], "2026-10-10")  # oldest first
        self.assertEqual(pr["sessions"][-1]["correct"], 1)

    def test_progress_empty(self):
        _, pr, _ = self.req("GET", "/api/kids/ash/progress")
        self.assertEqual((pr["stars"], pr["streak"], pr["sessions"]), (0, 0, []))

    def test_post_session_returns_streak(self):
        w = self.mkweek()
        _, r, _ = self.session("finn", "week", [{"word_id": w["words"][0]["id"], "correct": 1}])
        self.assertEqual(r["streak"], 1)


class TestReport(Base):
    def test_report(self):
        w = self.mkweek(words=["a", "b"])
        a, b = (x["id"] for x in w["words"])
        self.session("finn", "week", [{"word_id": a, "correct": 1}, {"word_id": b, "correct": 0}])
        self.session("finn", "week", [{"word_id": a, "correct": 1}, {"word_id": b, "correct": 0}])
        st, rep, _ = self.req("GET", "/api/report")
        self.assertEqual(st, 200)
        g = rep["finn"]
        self.assertEqual(g["weeks"][0]["pct"], 50)
        self.assertEqual(g["most_missed"][0], {"label": "b", "missed": 2, "tried": 2})
        self.assertEqual(len(g["recent"]), 2)
        self.assertEqual(g["recent"][0]["total"], 2)
        self.assertEqual(rep["ash"]["recent"], [])


class TestRobustness(Base):
    def test_concurrent_duplicate_week_never_500(self):
        codes = []

        def go():
            codes.append(self.req("POST", "/api/kids/ash/weeks", {"week_start": "2026-10-12", "words": ["a"]})[0])
        ts = [threading.Thread(target=go) for _ in range(8)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(sorted(set(codes)), [201, 409])
        self.assertEqual(codes.count(201), 1)

    def test_huge_ids_404(self):
        big = "9" * 30
        for m, path in (("GET", f"/api/words/{big}/audio"), ("DELETE", f"/api/words/{big}"),
                        ("DELETE", f"/api/weeks/{big}"), ("PATCH", f"/api/words/{big}")):
            st, err, _ = self.req(m, path, {"label": "x"} if m == "PATCH" else None)
            self.assertEqual(st, 404, path)
            self.assertIn("error", err)
        st, _, _ = self.req("PUT", f"/api/words/{big}/audio", raw=wav())
        self.assertEqual(st, 404)

    def test_huge_session_word_id_400(self):
        st, _, _ = self.session("finn", "week", [{"word_id": 10 ** 30, "correct": 1}])
        self.assertEqual(st, 400)

    def test_week_year_range(self):
        for d in ("0001-01-01", "9999-12-31"):
            st, _, _ = self.req("POST", "/api/kids/finn/weeks", {"week_start": d, "words": ["a"]})
            self.assertEqual(st, 400, d)

    def test_options_and_odd_methods_json_405(self):
        for path in ("/api/me", "/", "/api/words/1"):
            st, err, _ = self.req("OPTIONS", path)
            self.assertEqual(st, 405, path)
            self.assertIn("error", err)
        st, err, _ = self.req("TRACE", "/api/me")
        self.assertIn(st, (405, 501))
        self.assertIn("error", err)


class TestTimezone(unittest.TestCase):
    def test_fallback_to_utc_when_zone_missing(self):
        import contextlib
        import io
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            tz = server.load_tz("Nowhere/Land")
        self.assertEqual(tz.utcoffset(None), __import__("datetime").timedelta(0))
        self.assertIn("warning", buf.getvalue())

    def test_today_uses_configured_zone(self):
        import datetime as dt
        tz = server.load_tz("Europe/London")
        cfg = server.Config(data_dir=Path("."), tz=tz)
        self.assertEqual(cfg.today_str(), dt.datetime.now(tz).date().isoformat())
        self.assertRegex(cfg.now_str(), r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$")


class TestTerm(unittest.TestCase):
    def test_term_of(self):
        t = server.term_of
        self.assertEqual(t("2026-09-01"), "2026 Autumn")
        self.assertEqual(t("2026-12-31"), "2026 Autumn")
        self.assertEqual(t("2027-01-04"), "2027 Spring")
        self.assertEqual(t("2027-03-31"), "2027 Spring")
        self.assertEqual(t("2027-04-01"), "2027 Summer")
        self.assertEqual(t("2027-08-31"), "2027 Summer")

    def test_monday_of(self):
        self.assertEqual(server.monday_of("2026-10-18"), "2026-10-12")  # Sunday
        self.assertEqual(server.monday_of("2026-10-12"), "2026-10-12")


class TestAudioSource(Base):
    """Piper fallback slice (#3522): a synthetic clip never replaces a child's recording."""

    def put(self, wid, source=None):
        q = f"?source={source}" if source else ""
        return self.req("PUT", f"/api/words/{wid}/audio{q}", raw=wav(), headers={"Content-Type": "audio/wav"})

    def source_of(self, wid):
        st, weeks, _ = self.req("GET", "/api/kids/finn/weeks")
        self.assertEqual(st, 200)
        return next(x["audio_source"] for w in weeks for x in w["words"] if x["id"] == wid)

    def test_default_is_child_and_tts_fills_gaps(self):
        w = self.mkweek()
        a, b = w["words"][0]["id"], w["words"][1]["id"]
        self.assertIsNone(self.source_of(a))
        self.assertEqual(self.put(a)[0], 200)
        self.assertEqual(self.source_of(a), "child")
        st, body, _ = self.put(b, "tts")
        self.assertEqual((st, body["audio_source"]), (200, "tts"))
        self.assertEqual(self.source_of(b), "tts")

    def test_child_overwrites_tts_but_not_vice_versa(self):
        wid = self.mkweek()["words"][0]["id"]
        self.assertEqual(self.put(wid, "tts")[0], 200)
        self.assertEqual(self.put(wid, "tts")[0], 200)      # re-generating a synthetic clip is fine
        self.assertEqual(self.put(wid)[0], 200)             # the child records over it
        self.assertEqual(self.source_of(wid), "child")
        self.assertEqual(self.put(wid, "tts")[0], 409)      # filler must not clobber the child
        self.assertEqual(self.source_of(wid), "child")

    def test_concurrent_tts_cannot_clobber_child(self):
        """BUG-4: the 409 check and the write must be one atomic step. Both requests are held at
        the file swap (the point after the check); the synthetic clip is made to land last.
        Whatever the interleaving, the child's recording and source must survive."""
        import os
        wid = self.mkweek()["words"][0]["id"]
        both_checked = threading.Barrier(2)
        child_done = threading.Event()
        child_wav, tts_wav = wav(100), wav(300)
        real_replace = os.replace

        def held_replace(src, dst, *a, **kw):
            is_tts = Path(src).stat().st_size == len(tts_wav)
            try:
                both_checked.wait(timeout=1)   # unfixed: both are past the check; fixed: only one gets here
            except threading.BrokenBarrierError:
                pass
            if is_tts:
                child_done.wait(timeout=2)     # let the child finish first so tts would land last
            return real_replace(src, dst, *a, **kw)

        results = {}

        def put(name, raw, source):
            q = f"?source={source}" if source else ""
            results[name] = self.req("PUT", f"/api/words/{wid}/audio{q}", raw=raw,
                                     headers={"Content-Type": "audio/wav"})[0]
            if name == "child":
                child_done.set()

        os.replace = held_replace
        try:
            ts = [threading.Thread(target=put, args=("tts", tts_wav, "tts")),
                  threading.Thread(target=put, args=("child", child_wav, None))]
            for t in ts:
                t.start()
            for t in ts:
                t.join(timeout=20)
        finally:
            os.replace = real_replace
        self.assertEqual(self.source_of(wid), "child")
        self.assertEqual(results["child"], 200)
        self.assertIn(results["tts"], (200, 409))
        st, body, _ = self.req("GET", f"/api/words/{wid}/audio")
        self.assertEqual((st, body), (200, child_wav))
        self.assertEqual(list((self.data / "audio").glob("*.tmp")), [])

    def test_bad_source_rejected(self):
        wid = self.mkweek()["words"][0]["id"]
        self.assertEqual(self.put(wid, "robot")[0], 400)

    def test_migration_marks_existing_clips_as_child(self):
        wid = self.mkweek()["words"][0]["id"]
        self.assertEqual(self.put(wid)[0], 200)
        con = sqlite3.connect(self.data / "spellings.db")
        con.execute("ALTER TABLE word DROP COLUMN audio_source")
        con.commit(); con.close()
        server.init_db(server.Config(data_dir=self.data))
        self.assertEqual(self.source_of(wid), "child")


class TestErrorBranches(Base):
    """Error paths found uncovered by bin/coverage (Vikunja #4336): each asserts a clean JSON error, never a traceback."""

    def test_bad_json_body_400(self):
        st, err, _ = self.req("POST", "/api/kids/finn/weeks", raw=b"{not json")
        self.assertEqual(st, 400)
        self.assertIn("error", err)

    def test_non_object_json_body_400(self):
        st, err, _ = self.req("POST", "/api/kids/finn/weeks", raw=b"[1, 2]")
        self.assertEqual(st, 400)
        self.assertIn("object", err["error"])

    def test_bad_content_length_400(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.putrequest("POST", "/api/kids/finn/weeks")
        c.putheader("Content-Type", "application/json")
        c.putheader("Content-Length", "abc")
        c.endheaders()
        r = c.getresponse()
        r.read()
        c.close()
        self.assertEqual(r.status, 400)

    def test_week_patch_needs_term_and_known_week(self):
        w = self.mkweek()
        st, err, _ = self.req("PATCH", f"/api/weeks/{w['id']}", {"nothing": 1})
        self.assertEqual(st, 400)
        st, _, _ = self.req("PATCH", "/api/weeks/999999", {"term": "2026 Autumn"})
        self.assertEqual(st, 404)

    def test_week_delete_unknown_404(self):
        st, _, _ = self.req("DELETE", "/api/weeks/999999")
        self.assertEqual(st, 404)

    def test_word_patch_validation_and_unknown(self):
        w = self.mkweek()
        st, _, _ = self.req("PATCH", f"/api/words/{w['words'][0]['id']}", {"label": 5})
        self.assertEqual(st, 400)
        st, _, _ = self.req("PATCH", "/api/words/999999", {"label": "ok"})
        self.assertEqual(st, 404)

    def test_audio_get_unknown_word_and_missing_file_404(self):
        st, _, _ = self.req("GET", "/api/words/999999/audio")
        self.assertEqual(st, 404)
        w = self.mkweek()
        st, _, _ = self.req("GET", f"/api/words/{w['words'][0]['id']}/audio")  # word exists, no recording
        self.assertEqual(st, 404)

    def test_huge_id_is_404_not_500(self):
        st, err, _ = self.req("GET", f"/api/words/{'9' * 30}/audio")
        self.assertEqual(st, 404)
        self.assertEqual(err, {"error": "not found"})

    def test_invalid_week_start_dates_400(self):
        for bad in ("2026-13-45", "1999-01-04", "not-a-date"):
            st, _, _ = self.req("POST", "/api/kids/finn/weeks", {"week_start": bad, "words": ["x"]})
            self.assertEqual(st, 400, bad)

    def test_unknown_static_and_traversal_404(self):
        st, _, _ = self.req("GET", "/static/nope.js")
        self.assertEqual(st, 404)
        st, _, _ = self.req("GET", "/static/%2e%2e/server.py")
        self.assertIn(st, (400, 404))  # refused either way; the file is never served

    def test_unexpected_exception_is_generic_500(self):
        orig = server.ep_kids
        def boom(h, m, q):
            raise RuntimeError("secret detail")
        # the route table holds the function object, so patch the table entry
        idx = next(i for i, r in enumerate(server.ROUTES) if r[2] is orig)
        method, pat, _ = server.ROUTES[idx]
        server.ROUTES[idx] = (method, pat, boom)
        try:
            st, err, _ = self.req("GET", "/api/kids")
        finally:
            server.ROUTES[idx] = (method, pat, orig)
        self.assertEqual(st, 500)
        self.assertEqual(err, {"error": "internal error"})

    def test_stars_of_edges(self):
        self.assertEqual(server.stars_of(0, 0), 0)
        self.assertEqual(server.stars_of(5, 5), 3)
        self.assertEqual(server.stars_of(3, 5), 2)
        self.assertEqual(server.stars_of(1, 5), 1)

    def test_config_from_env(self):
        import os
        from unittest import mock
        with mock.patch.dict(os.environ, {"SPELLING_DATA_DIR": "/tmp/x-spellings", "SPELLING_TZ": "Mars/Olympus"}):
            cfg = server.Config.from_env()
        self.assertEqual(str(cfg.data_dir), "/tmp/x-spellings")


class SharedSecret(unittest.TestCase):
    """SEC-1: with SPELLING_AUTH_TOKEN set, every route needs the X-Spelling-Token header (401 otherwise);
    the default listener is loopback only."""
    TOKEN = "s3cret-token-for-tests"

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cfg = server.Config(data_dir=Path(cls.tmp.name), today=TODAY, default_kid="finn", quiet=True,
                            auth_token=cls.TOKEN)
        cls.srv = server.make_server(cfg, "127.0.0.1", 0)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        cls.tmp.cleanup()

    def status(self, method, path, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request(method, path, headers=headers or {})
        r = c.getresponse()
        r.read()
        c.close()
        return r.status

    def test_unauthenticated_requests_get_401_on_api_and_static(self):
        for method, path in (("GET", "/api/report"), ("DELETE", "/api/words/1"), ("GET", "/"), ("GET", "/parent")):
            self.assertEqual(self.status(method, path), 401, f"{method} {path}")

    def test_wrong_token_gets_401(self):
        self.assertEqual(self.status("GET", "/api/report", {"X-Spelling-Token": "nope"}), 401)

    def test_correct_token_is_let_through(self):
        self.assertEqual(self.status("GET", "/", {"X-Spelling-Token": self.TOKEN}), 200)

    def test_foreign_host_still_421_before_token_check(self):
        self.assertEqual(self.status("GET", "/", {"Host": "evil.example"}), 421)


class DefaultBind(unittest.TestCase):
    def test_default_listener_is_loopback_only(self):
        with tempfile.TemporaryDirectory() as d:
            srv = server.make_server(server.Config(data_dir=Path(d), quiet=True), port=0)
            try:
                self.assertEqual(srv.server_address[0], "127.0.0.1")
            finally:
                srv.server_close()


if __name__ == "__main__":
    unittest.main()
