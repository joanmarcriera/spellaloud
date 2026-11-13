#!/usr/bin/env python3
"""export_family.py - move the home-server ("family") build's data into the browser-only app.

Purpose
    The family build keeps everything in SQLite plus one WAV per word on the server. The public build keeps it
    in each browser (IndexedDB) and moves it with a ".spellings" file (format: static/pack.js). This tool reads
    the family data directory READ-ONLY and writes that file, so a grown-up can import it on the wall display /
    tablet from the Grown-ups page (Import -> "Replace everything" on a fresh device, or "Merge").

    Carried over: children (name, year, settings), every week (with a parent-chosen term), every word, every
    recording (and whether it is the child's voice or the read-aloud voice), every session with its results,
    and each "I know it" mark. Feedback rows are not children's data and are left out.

Usage
    python3 tools/export_family.py --data-dir /mnt/BigDisk/applications/spellings/data            # all children
    python3 tools/export_family.py --data-dir ./data --kid ash --out ~/ash.spellings               # one child
    python3 tools/export_family.py --data-dir ./data --check                                      # counts only

    Default output: ./spellings-family-<YYYY-MM-DD>.spellings (or spellings-<kid>-<date>.spellings with --kid).
    Exit status: 0 ok, 1 nothing to export / bad input, 2 usage error.

Safety
    The database is opened with mode=ro (sqlite URI), so the live server is never written to. Audio paths are
    derived from integer word ids only. Standard library only; ZIP is "stored" (no compression) like pack.js.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sqlite3
import sys
import zipfile
from pathlib import Path

FORMAT, VERSION = "spellings-pack", 1          # must match static/pack.js FORMAT / VERSION
SETTING_KEYS = ("speed", "repeats", "pause", "order")  # the family build's practise settings (spec.md)


def read_snapshot(data_dir: Path, kid: str | None = None) -> tuple[dict, dict[str, bytes], list[str]]:
    """Return (snapshot, audio, warnings) in pack.js shape. kid = slug limits it to one child."""
    db_path = data_dir / "spellings.db"
    if not db_path.is_file():
        raise SystemExit(f"export_family: no database at {db_path}")
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    warnings: list[str] = []
    try:
        cols = lambda t: {r[1] for r in con.execute(f"PRAGMA table_info({t})")}  # older DBs lack some columns
        word_cols, week_cols = cols("word"), cols("week")
        kid_rows = con.execute("SELECT slug,name,year,settings_json FROM kid ORDER BY slug").fetchall()
        if kid:
            kid_rows = [k for k in kid_rows if k["slug"] == kid]
            if not kid_rows:
                raise SystemExit(f"export_family: no child with slug {kid!r}")
        slugs = {k["slug"] for k in kid_rows}
        kids = []
        for k in kid_rows:
            raw = json.loads(k["settings_json"] or "{}")
            kids.append({"slug": k["slug"], "name": k["name"], "year": k["year"],
                         "settings": {s: raw[s] for s in SETTING_KEYS if s in raw}})

        sessions_at = {r["id"]: r["created_at"] for r in con.execute("SELECT id,created_at FROM session")}
        audio: dict[str, bytes] = {}
        weeks, word_info = [], {}
        term_sql = "term" if "term" in week_cols else "NULL AS term"
        for w in con.execute(f"SELECT id,kid_slug,week_start,{term_sql} FROM week ORDER BY kid_slug,week_start"):
            if w["kid_slug"] not in slugs:
                continue
            words = []
            extra = ",".join(c if c in word_cols else f"NULL AS {c}" for c in ("audio_source", "cleared_session"))
            for x in con.execute(f"SELECT id,position,label,audio_at,{extra} FROM word WHERE week_id=? ORDER BY position,id",
                                 (w["id"],)):
                rec = {"label": x["label"], "position": x["position"], "audio": None}
                wav = data_dir / "audio" / f"{int(x['id'])}.wav"
                if x["audio_at"] is not None:
                    if wav.is_file():
                        rec["audio"] = f"audio/{int(x['id'])}.wav"
                        audio[rec["audio"]] = wav.read_bytes()
                        rec["audio_source"] = "tts" if x["audio_source"] == "tts" else "child"
                    else:
                        warnings.append(f"{w['kid_slug']} {w['week_start']} '{x['label']}': recording file missing")
                if x["cleared_session"] in sessions_at:
                    rec["cleared_at"] = sessions_at[x["cleared_session"]]
                words.append(rec)
                word_info[x["id"]] = (w["week_start"], x["label"])
            weeks.append({"kid": w["kid_slug"], "week_start": w["week_start"], "term": w["term"], "words": words})

        sessions = []
        for s in con.execute("SELECT id,kid_slug,created_at,mode,settings_json FROM session ORDER BY created_at,id"):
            if s["kid_slug"] not in slugs:
                continue
            results = []
            for r in con.execute("SELECT word_id,correct FROM result WHERE session_id=?", (s["id"],)):
                if r["word_id"] in word_info:  # a deleted word's results went with it (ON DELETE CASCADE)
                    ws, label = word_info[r["word_id"]]
                    results.append({"week_start": ws, "label": label, "correct": 1 if r["correct"] else 0})
            sessions.append({"kid": s["kid_slug"], "created_at": s["created_at"], "mode": s["mode"],
                             "settings": json.loads(s["settings_json"] or "{}"), "results": results})
    finally:
        con.close()
    return {"kids": kids, "weeks": weeks, "sessions": sessions}, audio, warnings


def write_pack(path: Path, snapshot: dict, audio: dict[str, bytes], now: str | None = None) -> None:
    """Write a .spellings file readable by pack.js parsePack (stored ZIP, manifest + data + audio/)."""
    manifest = {"format": FORMAT, "version": VERSION, "app": "spellings",
                "created": now or dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                "contents": {"recordings": bool(audio), "results": True, "settings": True, "names": True}}
    tmp = path.with_suffix(path.suffix + ".part")
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_STORED) as z:
        z.writestr("manifest.json", json.dumps(manifest))
        z.writestr("data.json", json.dumps(snapshot))
        for name, data in audio.items():
            z.writestr(name, data)
    tmp.replace(path)  # never leave a half-written file under the real name


def summary(snapshot: dict, audio: dict) -> str:
    """One line per child: weeks, words, recordings, sessions."""
    out = []
    for k in snapshot["kids"]:
        wk = [w for w in snapshot["weeks"] if w["kid"] == k["slug"]]
        words = sum(len(w["words"]) for w in wk)
        recs = sum(1 for w in wk for x in w["words"] if x["audio"])
        sess = sum(1 for s in snapshot["sessions"] if s["kid"] == k["slug"])
        out.append(f"{k['name']} ({k['slug']}): {len(wk)} weeks, {words} words, {recs} recordings, {sess} sessions")
    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[1].strip(), formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", type=Path, required=True, help="the family server's SPELLING_DATA_DIR")
    ap.add_argument("--kid", help="export one child only (slug, e.g. ash)")
    ap.add_argument("--out", type=Path, help="output file (default: ./spellings-<family|kid>-<date>.spellings)")
    ap.add_argument("--check", action="store_true", help="print what would be exported, write nothing")
    a = ap.parse_args(argv)
    snap, audio, warns = read_snapshot(a.data_dir, a.kid)
    for w in warns:
        print("warning:", w, file=sys.stderr)
    if not snap["kids"]:
        print("export_family: no children in the database", file=sys.stderr)
        return 1
    print(summary(snap, audio))
    if a.check:
        return 0
    out = a.out or Path(f"spellings-{a.kid or 'family'}-{dt.date.today().isoformat()}.spellings")
    write_pack(out, snap, audio)
    print(f"wrote {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
