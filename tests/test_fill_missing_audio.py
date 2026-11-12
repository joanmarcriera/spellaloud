"""Tests for bin/fill-missing-audio against a real temp server and a FAKE piper (no model, no network).

Run: python3 -m unittest discover -s tests -v
"""
import importlib.machinery
import importlib.util
import io
import stat
import struct
import sys
import tempfile
import types
import unittest
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_server import Base, wav as fill_wav  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
_loader = importlib.machinery.SourceFileLoader("fill", str(ROOT / "bin" / "fill-missing-audio"))
fill = importlib.util.module_from_spec(importlib.util.spec_from_loader("fill", _loader))
_loader.exec_module(fill)


def pcm_wav(rate, ch, n):
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(ch)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(struct.pack("<%dh" % (n * ch), *([1000] * (n * ch))))
    return b.getvalue()


class TestConvert(unittest.TestCase):
    def test_resample_and_downmix_to_22k_mono(self):
        out = fill.to_target_wav(pcm_wav(44100, 2, 4410))
        with wave.open(io.BytesIO(out)) as w:
            self.assertEqual((w.getframerate(), w.getnchannels(), w.getsampwidth()), (22050, 1, 2))
            self.assertAlmostEqual(w.getnframes(), 2205, delta=2)

    def test_rejects_8bit(self):
        b = io.BytesIO()
        with wave.open(b, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(1)
            w.setframerate(22050)
            w.writeframes(b"\x80" * 10)
        with self.assertRaises(ValueError):
            fill.to_target_wav(b.getvalue())


class TestCheckModel(unittest.TestCase):
    """Guards on the voice file, checked before any word is synthesised (Vikunja #3522)."""

    def mk(self, name, size=10):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        p = Path(d.name) / name
        p.write_bytes(b"\0" * size)
        return str(p)

    def test_accepts_a_small_en_gb_voice(self):
        fill.check_model(self.mk("en_GB-alba-medium.onnx"))

    def test_missing_file_is_refused(self):
        with self.assertRaisesRegex(ValueError, "not found"):
            fill.check_model("/nonexistent/en_GB-alba-medium.onnx")

    def test_over_500mb_is_refused_without_reading_it(self):
        with self.assertRaisesRegex(ValueError, "500"):
            fill.check_model(self.mk("en_GB-big.onnx"), max_bytes=5)

    def test_us_voice_is_refused(self):
        with self.assertRaisesRegex(ValueError, "en_GB"):
            fill.check_model(self.mk("en_US-lessac-medium.onnx"))

    def test_us_voice_with_hyphen_or_odd_case_is_refused(self):
        for name in ("en-US-lessac.onnx", "EN_us-amy.onnx"):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "en_GB"):
                fill.check_model(self.mk(name))

    def test_a_directory_is_not_a_model(self):
        with tempfile.TemporaryDirectory() as d, self.assertRaisesRegex(ValueError, "not found"):
            fill.check_model(d)

    def test_dry_run_skips_the_voice_check(self):
        # A dry run only lists words; it needs no voice file. The port is closed, so reaching the network
        # (a connection error) proves the voice check was skipped, instead of returning exit 2.
        with self.assertRaises(OSError):
            fill.main(["--base", "http://127.0.0.1:1", "--kid", "finn", "--model", "/nonexistent/x.onnx"])

    def test_main_enable_with_bad_model_exits_2_and_uploads_nothing(self):
        self.assertEqual(fill.main(["--base", "http://127.0.0.1:1", "--kid", "finn",
                                    "--model", "/nonexistent/x.onnx", "--enable"]), 2)


class TestFiller(Base):
    def setUp(self):
        self.tmpd = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmpd.cleanup)
        self.fake = Path(self.tmpd.name) / "fakepiper"
        # Fake piper: reads the label on stdin, writes a 16 kHz mono WAV to --output_file.
        self.fake.write_text("#!/usr/bin/env python3\nimport sys,wave,struct\n"
                             "out=sys.argv[sys.argv.index('--output_file')+1]\nsys.stdin.read()\n"
                             "w=wave.open(out,'wb');w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000)\n"
                             "w.writeframes(struct.pack('<800h',*([500]*800)));w.close()\n")
        self.fake.chmod(self.fake.stat().st_mode | stat.S_IXUSR)

    def args(self, enable):
        return types.SimpleNamespace(base=f"http://127.0.0.1:{self.port}", kid="finn", model="x.onnx",
                                     piper=str(self.fake), enable=enable)

    _n = [0]

    def mkw(self):
        """A fresh week per call (the server rejects a second week with the same Monday)."""
        TestFiller._n[0] += 1
        start = (__import__("datetime").date(2026, 10, 12) + __import__("datetime").timedelta(days=7 * TestFiller._n[0])).isoformat()
        return self.mkweek(start=start)

    def put(self, wid):
        return self.req("PUT", f"/api/words/{wid}/audio", raw=fill_wav(), headers={"Content-Type": "audio/wav"})

    def sources(self):
        _, weeks, _ = self.req("GET", "/api/kids/finn/weeks")
        return {x["id"]: x["audio_source"] for w in weeks for x in w["words"]}

    def test_dry_run_changes_nothing(self):
        w = self.mkw()
        ids = [x["id"] for x in w["words"]]
        r = fill.run(self.args(False))
        self.assertTrue(r["dry_run"])
        self.assertEqual(r["uploaded"], 0)
        s = self.sources()
        self.assertTrue(all(s[i] is None for i in ids))

    def test_fills_gaps_but_never_a_child_clip(self):
        ids = [x["id"] for x in self.mkw()["words"]]
        self.assertEqual(self.put(ids[0])[0], 200)  # a child clip exists
        r = fill.run(self.args(True))
        self.assertEqual(r["failed"], 0)
        s = self.sources()
        self.assertEqual(s[ids[0]], "child")
        self.assertTrue(all(s[i] == "tts" for i in ids[1:]))
        self.assertEqual(fill.run(self.args(True))["uploaded"], 0)  # second run uploads nothing

    def test_409_counts_as_skipped(self):
        wid = self.mkw()["words"][0]["id"]
        real = fill.synth

        def racing(piper, model, label):
            self.put(wid)  # the child records between listing and upload
            return real(piper, model, label)

        r = fill.run(self.args(True), synth_fn=racing)
        self.assertGreaterEqual(r["skipped_child"], 1)
        self.assertEqual(self.sources()[wid], "child")

    def test_piper_failure_is_counted_not_fatal(self):
        self.mkw()
        self.fake.write_text("#!/bin/sh\nexit 3\n")
        r = fill.run(self.args(True))
        self.assertEqual(r["uploaded"], 0)
        self.assertGreater(r["failed"], 0)


if __name__ == "__main__":
    unittest.main()
