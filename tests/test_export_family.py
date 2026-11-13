"""Tests for tools/export_family.py: family server data -> .spellings file -> browser-only store.

The family server is driven through its real API (tests/test_server.py Base), the export is opened by
static/pack.js parsePack and loaded into static/store.js with replaceFromSnapshot (Node), and what the
browser build then reports must equal what the family server reported.

Run: python3 -m unittest discover -s tests -v      (the Node half is skipped if node is not installed)
"""
import importlib.util
import json
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_server import Base, wav  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("export_family", ROOT / "tools" / "export_family.py")
ef = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ef)

# Loads the pack into a fresh browser store and prints what the kid app / parent page would read.
NODE_IMPORT = r"""
import { readFileSync } from 'node:fs';
import { parsePack } from './static/pack.js';
import { createStore, memoryBackend } from './static/store.js';
const { snapshot, audio, contents } = parsePack(new Uint8Array(readFileSync(process.argv[2])));
const store = await createStore(memoryBackend(), { today: process.argv[3], clock: () => new Date(process.argv[3] + 'T12:00:00Z') });
await store.replaceFromSnapshot(snapshot, audio);
const get = async (p) => (await store.request('GET', p)).data;
const out = { contents, kids: await get('/api/kids') };
for (const k of out.kids) {
  out[k.slug] = { weeks: await get(`/api/kids/${k.slug}/weeks`), progress: await get(`/api/kids/${k.slug}/progress`),
                  tricky: await get(`/api/kids/${k.slug}/practice?mode=tricky`) };
}
console.log(JSON.stringify(out));
"""


class TestExportFamily(Base):
    def seed(self):
        """Two weeks for ash (child + read-aloud clips, a session, an 'I know it'), one for finn."""
        w1 = self.req("POST", "/api/kids/ash/weeks", {"week_start": "2026-10-05", "words": ["said", "were"]})[1]
        w2 = self.req("POST", "/api/kids/ash/weeks", {"week_start": "2026-10-12", "words": ["they", "come"]})[1]
        self.req("POST", "/api/kids/finn/weeks", {"week_start": "2026-10-12", "words": ["because"]})
        ids = {x["label"]: x["id"] for w in (w1, w2) for x in w["words"]}
        self.req("PUT", f"/api/words/{ids['said']}/audio", raw=wav(50))
        self.req("PUT", f"/api/words/{ids['they']}/audio?source=tts", raw=wav(60), headers={"Content-Type": "audio/wav"})
        self.req("PATCH", f"/api/weeks/{w1['id']}", {"term": "2026 Summer"})
        settings = {"speed": "slow", "repeats": 2, "pause": "long", "order": "inorder"}
        self.req("POST", "/api/kids/ash/sessions", {"mode": "week", "settings": settings, "results": [
            {"word_id": ids["they"], "correct": 0}, {"word_id": ids["come"], "correct": 1}]})
        self.req("POST", f"/api/words/{ids['come']}/known")
        return ids

    def test_snapshot_shape(self):
        ids = self.seed()
        snap, audio, warns = ef.read_snapshot(self.data)
        self.assertEqual(warns, [])
        self.assertEqual([k["slug"] for k in snap["kids"]], ["ash", "finn"])
        self.assertEqual(snap["kids"][0]["settings"]["speed"], "slow")
        ash = [w for w in snap["weeks"] if w["kid"] == "ash"]
        self.assertEqual([w["week_start"] for w in ash], ["2026-10-05", "2026-10-12"])
        self.assertEqual(ash[0]["term"], "2026 Summer")
        said, they = ash[0]["words"][0], ash[1]["words"][0]
        self.assertEqual((said["audio"], said["audio_source"]), (f"audio/{ids['said']}.wav", "child"))
        self.assertEqual(they["audio_source"], "tts")
        self.assertEqual(audio[said["audio"]], wav(50))
        self.assertIn("cleared_at", ash[1]["words"][1])  # 'come' was marked "I know it"
        self.assertEqual(len(snap["sessions"]), 1)
        self.assertEqual(sorted(r["label"] for r in snap["sessions"][0]["results"]), ["come", "they"])

    def test_one_kid_and_missing_audio_warns(self):
        ids = self.seed()
        (self.data / "audio" / f"{ids['said']}.wav").unlink()
        snap, audio, warns = ef.read_snapshot(self.data, "ash")
        self.assertEqual([k["slug"] for k in snap["kids"]], ["ash"])
        self.assertTrue(all(w["kid"] == "ash" for w in snap["weeks"]))
        self.assertEqual(len(warns), 1)
        self.assertNotIn(f"audio/{ids['said']}.wav", audio)

    def test_database_untouched(self):
        self.seed()
        db = self.data / "spellings.db"
        before = sqlite3.connect(db).execute("SELECT COUNT(*) FROM word").fetchone()
        with tempfile.TemporaryDirectory() as t:
            self.assertEqual(ef.main(["--data-dir", str(self.data), "--out", str(Path(t) / "x.spellings")]), 0)
            with zipfile.ZipFile(Path(t) / "x.spellings") as z:
                self.assertIsNone(z.testzip())
                self.assertTrue(all(i.compress_type == zipfile.ZIP_STORED for i in z.infolist()))
                self.assertEqual(json.loads(z.read("manifest.json"))["format"], "spellings-pack")
        self.assertEqual(sqlite3.connect(db).execute("SELECT COUNT(*) FROM word").fetchone(), before)

    @unittest.skipUnless(shutil.which("node"), "node not installed")
    def test_browser_build_reads_the_same_data(self):
        """The imported store reports the same weeks, stars, streak and tricky words as the family server."""
        self.seed()
        fam = {k: {"weeks": self.req("GET", f"/api/kids/{k}/weeks")[1],
                   "progress": self.req("GET", f"/api/kids/{k}/progress")[1],
                   "tricky": self.req("GET", f"/api/kids/{k}/practice?mode=tricky")[1]} for k in ("ash", "finn")}
        with tempfile.TemporaryDirectory() as t:
            pack = Path(t) / "family.spellings"
            ef.write_pack(pack, *ef.read_snapshot(self.data)[:2])
            script = Path(t) / "import.mjs"
            script.write_text(NODE_IMPORT.replace("./static/", (ROOT / "static").as_uri() + "/"))
            out = json.loads(subprocess.run(["node", str(script), str(pack), "2026-10-15"], check=True,
                                            capture_output=True, text=True, cwd=ROOT).stdout)
        self.assertEqual([k["slug"] for k in out["kids"]], ["ash", "finn"])
        strip = lambda weeks: [(w["week_start"], [(x["label"], x["has_audio"], x.get("audio_source")) for x in w["words"]])
                               for w in weeks]
        for k in ("ash", "finn"):
            self.assertEqual(strip(out[k]["weeks"]), strip(fam[k]["weeks"]), k)
            self.assertEqual((out[k]["progress"]["stars"], out[k]["progress"]["streak"]),
                             (fam[k]["progress"]["stars"], fam[k]["progress"]["streak"]), k)
            self.assertEqual(sorted(w["label"] for w in out[k]["tricky"]["words"]),
                             sorted(w["label"] for w in fam[k]["tricky"]["words"]), k)
        self.assertEqual(out["ash"]["weeks"][0]["term"], "2026 Summer")
        self.assertEqual(out["contents"], {"recordings": True, "results": True, "settings": True, "names": True})


if __name__ == "__main__":
    unittest.main()
