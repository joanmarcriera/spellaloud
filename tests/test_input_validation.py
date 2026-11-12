"""Input-validation tests for the external surface of server.py (Vikunja #4341).

A real server on an ephemeral port with a temp data dir. Each case sends hostile or malformed input and asserts
the rejection status the code defines: 400 (bad body / Content-Length / WAV), 404 (word id that cannot match a
route or does not exist), 413 (body over the limit), 415 (wrong Content-Type), 421 (Host not allowed).
If a case ever shows an invalid input being ACCEPTED, report a defect task; do not patch server.py in this test file.

Run: python3 -m unittest discover -s tests -v
"""
import http.client
from datetime import date, timedelta
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402


class InputValidation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cfg = server.Config(data_dir=Path(cls.tmp.name), today="2026-10-15", home_url="https://home.example/",
                            default_kid="finn", quiet=True)
        cls.srv = server.make_server(cfg, "127.0.0.1", 0)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        cls.tmp.cleanup()

    def send(self, method, path, body=b"", headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            c.request(method, path, body=body, headers=headers or {})
            r = c.getresponse()
            r.read()
            return r.status
        finally:
            c.close()

    def make_word(self):
        type(self).weeks = getattr(type(self), "weeks", 0) + 1   # one week per call: weeks are unique per kid
        start = (date(2026, 1, 5) + timedelta(weeks=type(self).weeks)).isoformat()
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("POST", "/api/kids/finn/weeks", json.dumps({"week_start": start, "words": ["one"]}),
                  {"Content-Type": "application/json"})
        r = c.getresponse()
        data = json.loads(r.read())
        c.close()
        self.assertEqual(r.status, 201, data)
        return data["words"][0]["id"]

    JSON = {"Content-Type": "application/json"}

    def test_oversized_json_is_413(self):
        body = json.dumps({"week_start": "2026-10-12", "words": ["x" * 100] * 2000}).encode()
        self.assertGreater(len(body), server.MAX_JSON)
        self.assertEqual(self.send("POST", "/api/kids/finn/weeks", body, self.JSON), 413)

    def test_wrong_content_type_is_415(self):
        body = json.dumps({"week_start": "2026-10-12", "words": ["a"]}).encode()
        for ctype in ("text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "audio/wav"):
            self.assertEqual(self.send("POST", "/api/kids/finn/weeks", body, {"Content-Type": ctype}), 415, ctype)

    def test_json_must_be_a_valid_object(self):
        for body in (b"{not json", b"[1, 2]", b'"text"', b"123"):
            self.assertEqual(self.send("POST", "/api/kids/finn/weeks", body, self.JSON), 400, body)

    def test_non_wav_audio_is_400(self):
        wid = self.make_word()
        for body in (b"", b"this is not a wav file at all", b"RIFF" + b"\x00" * 40, b"\x89PNG\r\n\x1a\n" * 8):
            self.assertEqual(self.send("PUT", f"/api/words/{wid}/audio", body, {"Content-Type": "audio/wav"}), 400, body[:12])

    def test_oversized_audio_is_413(self):
        wid = self.make_word()
        body = b"RIFF" + b"\x00" * (server.MAX_AUDIO + 10)
        self.assertEqual(self.send("PUT", f"/api/words/{wid}/audio", body, {"Content-Type": "audio/wav"}), 413)

    def test_audio_with_json_content_type_is_415(self):
        wid = self.make_word()
        self.assertEqual(self.send("PUT", f"/api/words/{wid}/audio", b"RIFF....WAVE", self.JSON), 415)

    def test_malformed_word_ids_never_reach_a_handler(self):
        ok_wav_header = {"Content-Type": "audio/wav"}
        for bad in ("abc", "-1", "1.5", "1%20OR%201=1", "1;DROP", "%00", "0x10", "99999999999999999999999999"):
            for method in ("GET", "PUT"):
                st = self.send(method, f"/api/words/{bad}/audio", b"" if method == "GET" else b"RIFF....WAVE", ok_wav_header)
                self.assertIn(st, (400, 404), f"{method} {bad} -> {st}")
        self.assertEqual(self.send("POST", "/api/words/abc/known", b"{}", self.JSON), 404)

    def test_unknown_word_id_is_404(self):
        self.assertEqual(self.send("GET", "/api/words/987654/audio"), 404)

    def test_bad_host_is_421_on_every_method(self):
        for method, path in (("GET", "/"), ("GET", "/api/me"), ("POST", "/api/kids/finn/weeks"), ("PUT", "/api/words/1/audio")):
            h = {"Host": "evil.example", "Content-Type": "application/json"}
            self.assertEqual(self.send(method, path, b"{}" if method != "GET" else b"", h), 421, f"{method} {path}")

    def test_bad_content_length_is_400(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            c.putrequest("POST", "/api/kids/finn/weeks")
            c.putheader("Content-Type", "application/json")
            c.putheader("Content-Length", "-5")
            c.endheaders()
            self.assertEqual(c.getresponse().status, 400)
        finally:
            c.close()

    def test_path_traversal_on_static_is_refused(self):
        for p in ("/static/../server.py", "/static/%2e%2e/server.py", "/static/..%2fserver.py"):
            self.assertIn(self.send("GET", p), (400, 404), p)


if __name__ == "__main__":
    unittest.main()
