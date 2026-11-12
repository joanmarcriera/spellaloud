#!/usr/bin/env python3
"""spellings - weekly spelling-dictation practice server (Python standard library only).

Purpose
    Serves the kid app (static/index.html), the parent page (static/parent.html)
    and a small JSON API backed by SQLite (WAL) plus one WAV file per word.
    Kids record their own voice for each word; the app plays the words back as
    a dictation and the kid marks themselves. See docs/spec.md.

Usage
    SPELLING_DATA_DIR=./data python3 server.py
    python3 server.py --port 8080 --bind 0.0.0.0 --data-dir ./data   # LAN-visible: set SPELLING_AUTH_TOKEN too
    open http://localhost:8080/?kid=ash   and   http://localhost:8080/parent

Environment variables (command-line flags override them)
    SPELLING_DATA_DIR     data directory (db + audio/)                 default ./data
    SPELLING_PORT         listen port                                  default 8080
    SPELLING_BIND         listen address                               default 127.0.0.1 (loopback only;
                          use 0.0.0.0 only in a container whose published port is restricted)
    SPELLING_AUTH_TOKEN   shared secret: when set, every request must carry header X-Spelling-Token with
                          this value, else 401 (an authenticating reverse proxy injects it)   default unset
    SPELLING_HOME_URL     target of the kid app's Home button          default https://ha.home.example/wall-board/wide?kiosk
    SPELLING_DEFAULT_KID  kid used when the Host header names nobody   default finn
    SPELLING_ALLOWED_HOSTS comma-separated Host allowlist (port ignored, case-insensitive); any other Host
                          gets 421 on every route (DNS-rebinding defence)
                          default ash.home.example,finn.home.example,localhost,127.0.0.1
    SPELLING_TZ           time zone for "today" and session dates        default Europe/London
                          (falls back to UTC with a warning if tz data is missing; alpine has no tzdata,
                          so mount /usr/share/zoneinfo read-only - see deploy/compose.yaml)
    SPELLING_TODAY        pin "today" (YYYY-MM-DD); for tests only     default unset
    SPELLING_VIKUNJA_URL  Vikunja base URL for the feedback button (https://tracker.example)  default unset
    SPELLING_VIKUNJA_TOKEN  server-side Vikunja API token (create tasks on one project only); never sent to a browser
    SPELLING_VIKUNJA_PROJECT_ID  project that receives one task per feedback                   default unset
    SPELLING_TRUST_PROXY  1 = the feedback rate limit keys on the LAST X-Forwarded-For entry (set only behind
                          Traefik/NPM, which append the real client IP)                     default 0
    SPELLING_PUBLIC_ROOT  public mode: serve this directory (bin/build-local output: the browser-only app, where
                          each family's data stays in its own browser) and switch off every /api/ route except
                          POST /api/feedback                                                default unset
    SPELLING_VERSION      version added to feedback tasks (the deploy sets the git short hash)  default dev

Kid resolution: on localhost/127.0.0.1 (dev) ?kid=<slug> beats SPELLING_DEFAULT_KID; on any other
allowed host the kid is the first DNS label of Host (ash.lab... -> ash), no fallback.
There is no per-user login. Access control is: loopback-only default bind, the optional shared-secret header
(SPELLING_AUTH_TOKEN, checked after the Host allowlist), the Host allowlist (above), POST/PUT/PATCH
must be application/json (audio PUT: audio/wav), a present Origin must match the Host, and
Sec-Fetch-Site: cross-site is refused. No CORS headers are ever sent.
Session timestamps and "today" use SPELLING_TZ.

Feedback button: POST /api/feedback {text, name?, contact?, page?, kid?, version?} creates one Vikunja task
(201). The row is written to sqlite first and deleted once Vikunja accepts it; if Vikunja is down or not
configured the row stays queued and the answer is 202, so the parent still sees "thanks". Up to 2 queued rows
are retried after the next successful send (never blocking on another flush); `python3 server.py
--flush-feedback` sends the rest. Limits: 5 per hour per IP (IPv6: per /64), else 429; at most 60 Vikunja calls
per hour in total (beyond that feedback is still accepted and queued, 202); 429 once 500 rows are queued.
Rows are claimed with one UPDATE ... RETURNING (column claimed_at), so no row is ever sent twice.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import ipaddress
import hmac
import json
import mimetypes
import os
import re
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
import zoneinfo
from html import escape
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"

MAX_AUDIO = 1024 * 1024        # 1 MB
MAX_JSON = 64 * 1024           # 64 KB
MAX_DRAIN = 8 * 1024 * 1024    # swallow at most this much of a rejected body
MAX_LABEL = 40
MAX_WORDS_PER_WEEK = 100
MAX_FEEDBACK = 2000            # characters of free text
FEEDBACK_FIELDS = {"name": 100, "contact": 200, "page": 20, "kid": 40, "version": 40}  # optional fields, max length
FEEDBACK_PER_HOUR = 5
FEEDBACK_GLOBAL_PER_HOUR = 60  # across all clients: bounds Vikunja load and queue growth
FEEDBACK_QUEUE_MAX = 500       # queued (unsent) rows; beyond this new feedback gets 429
FEEDBACK_FLUSH = 2             # older queued rows retried after the parent's own task was created
VIKUNJA_TIMEOUT = 3            # seconds per call; the parent is waiting for the answer

SPEEDS = ("slow", "normal", "fast")
PAUSES = ("short", "long")
ORDERS = ("mix", "inorder")
MODES = ("week", "term", "tricky")

# Seed data from the spec's settings table.
KIDS = {
    "ash": ("Ash", 1, {"speed": "slow", "repeats": 2, "pause": "long", "order": "inorder"}),
    "finn": ("Finn", 3, {"speed": "normal", "repeats": 2, "pause": "short", "order": "mix"}),
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS kid(
    slug TEXT PRIMARY KEY, name TEXT NOT NULL, year INTEGER NOT NULL, settings_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS week(
    id INTEGER PRIMARY KEY, kid_slug TEXT NOT NULL REFERENCES kid(slug), week_start TEXT NOT NULL,
    term TEXT, UNIQUE(kid_slug, week_start));
CREATE TABLE IF NOT EXISTS word(
    id INTEGER PRIMARY KEY, week_id INTEGER NOT NULL REFERENCES week(id) ON DELETE CASCADE,
    position INTEGER NOT NULL, label TEXT NOT NULL, audio_at TEXT, audio_source TEXT, cleared_session INTEGER);
CREATE TABLE IF NOT EXISTS session(
    id INTEGER PRIMARY KEY, kid_slug TEXT NOT NULL REFERENCES kid(slug),
    created_at TEXT NOT NULL, mode TEXT NOT NULL, settings_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS result(
    session_id INTEGER NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    word_id INTEGER NOT NULL REFERENCES word(id) ON DELETE CASCADE,
    correct INTEGER NOT NULL, PRIMARY KEY(session_id, word_id));
CREATE TABLE IF NOT EXISTS feedback(
    id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, payload_json TEXT NOT NULL,
    claimed_at REAL);  -- queue: a row leaves once sent; claimed_at = epoch secs a sender took it (NULL = free)
CREATE INDEX IF NOT EXISTS idx_word_week ON word(week_id);
CREATE INDEX IF NOT EXISTS idx_session_kid ON session(kid_slug, id);
"""


def load_tz(name: str) -> dt.tzinfo:
    """Named zone, or UTC (with a one-line stderr warning) when tz data is unavailable."""
    try:
        return zoneinfo.ZoneInfo(name)
    except (zoneinfo.ZoneInfoNotFoundError, ValueError, OSError):
        sys.stderr.write(f"warning: time zone {name!r} not found (no tzdata?), using UTC\n")
        return dt.timezone.utc


@dataclass
class Config:
    data_dir: Path = field(default_factory=lambda: Path("./data"))
    home_url: str = "https://ha.home.example/wall-board/wide?kiosk"
    default_kid: str = "finn"
    allowed_hosts: tuple = ("ash.home.example", "finn.home.example", "localhost", "127.0.0.1")
    today: str | None = None  # pinned date (tests); None = real clock
    auth_token: str | None = None  # shared secret required in X-Spelling-Token; None = no check
    tz: dt.tzinfo = field(default_factory=lambda: load_tz(os.environ.get("SPELLING_TZ", "Europe/London")))
    quiet: bool = False       # suppress per-request logging (tests)
    vikunja_url: str = ""     # feedback target; "" = queue only
    vikunja_token: str = field(default="", repr=False)  # never logged, never sent to a browser
    vikunja_project: int | None = None
    trust_proxy: bool = False
    public_root: Path | None = None  # public mode, see the module docstring
    version: str = "dev"
    feedback_limiter: "RateLimiter" = field(default_factory=lambda: RateLimiter(FEEDBACK_PER_HOUR, 3600), repr=False)
    feedback_global_limiter: "RateLimiter" = field(default_factory=lambda: RateLimiter(FEEDBACK_GLOBAL_PER_HOUR, 3600), repr=False)
    feedback_queue_max: int = FEEDBACK_QUEUE_MAX

    @classmethod
    def from_env(cls) -> "Config":
        e = os.environ
        return cls(
            data_dir=Path(e.get("SPELLING_DATA_DIR", "./data")),
            home_url=e.get("SPELLING_HOME_URL", cls.home_url),
            default_kid=e.get("SPELLING_DEFAULT_KID", "finn"),
            allowed_hosts=tuple(x.strip().lower() for x in e.get("SPELLING_ALLOWED_HOSTS", ",".join(cls.allowed_hosts)).split(",") if x.strip()),
            tz=load_tz(e.get("SPELLING_TZ", "Europe/London")),
            today=e.get("SPELLING_TODAY") or None,
            vikunja_url=e.get("SPELLING_VIKUNJA_URL", "").strip(),
            vikunja_token=e.get("SPELLING_VIKUNJA_TOKEN", "").strip(),
            vikunja_project=int(e["SPELLING_VIKUNJA_PROJECT_ID"]) if e.get("SPELLING_VIKUNJA_PROJECT_ID", "").strip().isdigit() else None,
            trust_proxy=e.get("SPELLING_TRUST_PROXY", "") == "1",
            public_root=Path(e["SPELLING_PUBLIC_ROOT"]) if e.get("SPELLING_PUBLIC_ROOT") else None,
            version=e.get("SPELLING_VERSION") or "dev",
            auth_token=e.get("SPELLING_AUTH_TOKEN") or None,
        )

    @property
    def db_path(self) -> Path:
        return self.data_dir / "spellings.db"

    @property
    def audio_dir(self) -> Path:
        return self.data_dir / "audio"

    def audio_path(self, word_id: int) -> Path:
        # Only ever built from an int: user text never reaches the filesystem.
        return self.audio_dir / f"{int(word_id)}.wav"

    def today_str(self) -> str:
        return self.today or dt.datetime.now(self.tz).date().isoformat()

    def now_str(self) -> str:
        if self.today:  # keep the pinned date, real time of day
            return f"{self.today}T{dt.datetime.now(self.tz).strftime('%H:%M:%S')}"
        return dt.datetime.now(self.tz).replace(tzinfo=None).isoformat(timespec="seconds")


# ---------------------------------------------------------------- date helpers

def parse_date(s: object) -> dt.date:
    if not isinstance(s, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        raise ApiError(400, "week_start must be an ISO date (YYYY-MM-DD)")
    try:
        d = dt.date.fromisoformat(s)
    except ValueError:
        raise ApiError(400, "week_start is not a valid date") from None
    if not 2000 <= d.year <= 2100:
        raise ApiError(400, "week_start must be between 2000 and 2100")
    return d


def monday_of(s: str) -> str:
    d = dt.date.fromisoformat(s)
    return (d - dt.timedelta(days=d.weekday())).isoformat()


def term_of(s: str) -> str:
    """Approximate UK term: Sep-Dec Autumn, Jan-Mar Spring, Apr-Aug Summer."""
    d = dt.date.fromisoformat(s)
    name = "Autumn" if d.month >= 9 else "Spring" if d.month <= 3 else "Summer"
    return f"{d.year} {name}"


TERM_NAMES = ("Spring", "Summer", "Autumn")  # in school-year order within a calendar year
TERM_RE = re.compile(r"(\d{4}) (Spring|Summer|Autumn)")
YEAR_RE = re.compile(r"(\d{4})-(\d{2})")


def term_index(label: str) -> int:
    y, name = TERM_RE.fullmatch(label).groups()
    return int(y) * 3 + TERM_NAMES.index(name)


def term_label(idx: int) -> str:
    return f"{idx // 3} {TERM_NAMES[idx % 3]}"


def academic_year(term: str) -> str:
    """School year a term belongs to: Autumn 2025 + Spring/Summer 2026 -> '2025-26'."""
    y, name = TERM_RE.fullmatch(term).groups()
    start = int(y) if name == "Autumn" else int(y) - 1
    return f"{start}-{(start + 1) % 100:02d}"


def week_term(w) -> str:
    """The term a week belongs to: the parent's choice, else worked out from its date."""
    return w["term"] or term_of(w["week_start"])


def parse_scope(s: str) -> str:
    """A practice scope from the URL: a term ('2026 Autumn') or an academic year ('2025-26')."""
    if TERM_RE.fullmatch(s) or YEAR_RE.fullmatch(s):
        return s
    raise ApiError(400, "term must look like '2026 Autumn' or '2025-26'")


def streak_of(dates: set[str], today: str) -> int:
    """Consecutive days with a session, ending today or yesterday."""
    cur = dt.date.fromisoformat(today)
    if cur.isoformat() not in dates:
        cur -= dt.timedelta(days=1)
    n = 0
    while cur.isoformat() in dates:
        n += 1
        cur -= dt.timedelta(days=1)
    return n


def stars_of(correct: int, total: int) -> int:
    if total <= 0:
        return 0
    return 3 if correct == total else 2 if correct * 2 >= total else 1


# ---------------------------------------------------------------------- errors

class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# -------------------------------------------------------------------- database

def init_db(cfg: Config) -> None:
    """Create dirs + schema and seed kids. Idempotent; safe on every start."""
    cfg.audio_dir.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(cfg.db_path, timeout=10)
    try:
        con.execute("PRAGMA journal_mode=WAL")  # persistent, so set once here
        con.executescript(SCHEMA)
        # Migration for databases created before audio_source existed (idempotent).
        if "audio_source" not in {r[1] for r in con.execute("PRAGMA table_info(word)")}:
            con.execute("ALTER TABLE word ADD COLUMN audio_source TEXT")
            con.execute("UPDATE word SET audio_source='child' WHERE audio_at IS NOT NULL")
        # Migration: "I know it now" marker (only results after this session count towards tricky).
        if "cleared_session" not in {r[1] for r in con.execute("PRAGMA table_info(word)")}:
            con.execute("ALTER TABLE word ADD COLUMN cleared_session INTEGER")
        # Migration: optional per-week term chosen by a parent (NULL = worked out from week_start).
        if "term" not in {r[1] for r in con.execute("PRAGMA table_info(week)")}:
            con.execute("ALTER TABLE week ADD COLUMN term TEXT")
        if "claimed_at" not in {r[1] for r in con.execute("PRAGMA table_info(feedback)")}:
            con.execute("ALTER TABLE feedback ADD COLUMN claimed_at REAL")  # dev databases from before the claim column
        for slug, (name, year, settings) in KIDS.items():
            con.execute("INSERT OR IGNORE INTO kid(slug,name,year,settings_json) VALUES(?,?,?,?)",
                        (slug, name, year, json.dumps(settings)))
        con.commit()
    finally:
        con.close()


@contextlib.contextmanager
def db(cfg: Config):
    """One connection per request (thread-safe); commit on success, roll back on error."""
    con = sqlite3.connect(cfg.db_path, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    try:
        yield con
        con.commit()
    except BaseException:
        con.rollback()
        raise
    finally:
        con.close()


def clean_label(v: object) -> str:
    if not isinstance(v, str):
        raise ApiError(400, "label must be text")
    v = v.strip()
    if not 1 <= len(v) <= MAX_LABEL:
        raise ApiError(400, f"label must be 1-{MAX_LABEL} characters")
    return v


def word_json(r: sqlite3.Row) -> dict:
    return {"id": r["id"], "position": r["position"], "label": r["label"], "has_audio": r["audio_at"] is not None,
            "audio_source": r["audio_source"] if r["audio_at"] is not None else None}  # 'child' | 'tts' | None


def week_json(con: sqlite3.Connection, w: sqlite3.Row) -> dict:
    words = con.execute("SELECT * FROM word WHERE week_id=? ORDER BY position, id", (w["id"],)).fetchall()
    auto = term_of(w["week_start"])
    near = [term_label(term_index(auto) + d) for d in (-2, -1, 1, 2)]  # what a parent may move the week to
    return {"id": w["id"], "kid": w["kid_slug"], "week_start": w["week_start"], "term": week_term(w),
            "term_auto": w["term"] is None, "term_default": auto, "term_options": near, "words": [word_json(x) for x in words]}


def get_kid(con: sqlite3.Connection, slug: str) -> sqlite3.Row:
    row = con.execute("SELECT * FROM kid WHERE slug=?", (slug,)).fetchone()
    if not row:
        raise ApiError(404, "unknown kid")
    return row


def kid_json(row: sqlite3.Row) -> dict:
    return {"slug": row["slug"], "name": row["name"], "year": row["year"], "settings": json.loads(row["settings_json"])}


def delete_audio(cfg: Config, word_ids) -> None:
    for wid in word_ids:
        with contextlib.suppress(FileNotFoundError):
            cfg.audio_path(wid).unlink()


def current_week_id(con: sqlite3.Connection, slug: str, today: str) -> int | None:
    """Latest week with week_start <= today, else the earliest future week."""
    r = con.execute("SELECT id FROM week WHERE kid_slug=? AND week_start<=? ORDER BY week_start DESC LIMIT 1",
                    (slug, today)).fetchone()
    if not r:
        r = con.execute("SELECT id FROM week WHERE kid_slug=? ORDER BY week_start ASC LIMIT 1", (slug,)).fetchone()
    return r["id"] if r else None


def term_word_rows(con: sqlite3.Connection, slug: str, today: str, scope: str | None = None) -> list[sqlite3.Row]:
    """Words of the current term (default), of one term ('2026 Summer') or of a whole school year ('2025-26')."""
    scope = scope or term_of(today)
    rows = con.execute("""SELECT word.*, week.week_start, week.term FROM word JOIN week ON week.id=word.week_id
                          WHERE week.kid_slug=? ORDER BY week.week_start, word.position, word.id""", (slug,)).fetchall()
    if YEAR_RE.fullmatch(scope):
        return [r for r in rows if academic_year(week_term(r)) == scope]
    return [r for r in rows if week_term(r) == scope]


# ------------------------------------------------------------------- endpoints
# Each endpoint: fn(h, m, q) -> (status, payload) where h is the Handler, m the regex match, q the query dict.

def ep_me(h, m, q):
    with db(h.cfg) as con:
        slug = h.resolve_kid(con, q)
        return 200, {"kid": kid_json(get_kid(con, slug)), "home_url": h.cfg.home_url, "today": h.cfg.today_str()}


def ep_kids(h, m, q):
    with db(h.cfg) as con:
        return 200, [{"slug": r["slug"], "name": r["name"], "year": r["year"],
                      "settings": json.loads(r["settings_json"])}
                     for r in con.execute("SELECT * FROM kid ORDER BY slug")]


def ep_weeks_list(h, m, q):
    with db(h.cfg) as con:
        get_kid(con, m["slug"])
        weeks = con.execute("SELECT * FROM week WHERE kid_slug=? ORDER BY week_start", (m["slug"],)).fetchall()
        return 200, [week_json(con, w) for w in weeks]


def clean_term(v) -> str | None:
    """Optional term chosen by a parent; None/missing = automatic."""
    if v is None:
        return None
    if not isinstance(v, str) or not TERM_RE.fullmatch(v):
        raise ApiError(400, "term must look like '2026 Autumn', or null for automatic")
    return v


def ep_week_patch(h, m, q):
    body = h.json_body()
    if "term" not in body:
        raise ApiError(400, "nothing to change: send term")
    term = clean_term(body["term"])
    with db(h.cfg) as con:
        if not con.execute("SELECT 1 FROM week WHERE id=?", (int(m["id"]),)).fetchone():
            raise ApiError(404, "unknown week")
        con.execute("UPDATE week SET term=? WHERE id=?", (term, int(m["id"])))
        return 200, week_json(con, con.execute("SELECT * FROM week WHERE id=?", (int(m["id"]),)).fetchone())


def ep_terms(h, m, q):
    """Choices for the kid's term chips: the current term first, then every term with words (newest first),
    then each school year that spans two or more of them."""
    today = h.cfg.today_str()
    with db(h.cfg) as con:
        get_kid(con, m["slug"])
        weeks = con.execute("SELECT * FROM week WHERE kid_slug=?", (m["slug"],)).fetchall()
    cur = term_of(today)
    have = {week_term(w) for w in weeks} | {cur}
    terms = sorted(have, key=term_index, reverse=True)
    years = sorted({academic_year(t) for t in have}, reverse=True)
    multi = [y for y in years if sum(academic_year(t) == y for t in have) >= 2]
    return 200, {"current": cur, "terms": [{"key": t, "label": t} for t in terms],
                 "years": [{"key": y, "label": f"{y} (whole year)"} for y in multi]}


def ep_week_create(h, m, q):
    body = h.json_body()
    start = monday_of(parse_date(body.get("week_start")).isoformat())
    words = body.get("words")
    if not isinstance(words, list) or len(words) > MAX_WORDS_PER_WEEK:
        raise ApiError(400, f"words must be a list of at most {MAX_WORDS_PER_WEEK} labels")
    labels = [clean_label(x) for x in words]
    term = clean_term(body.get("term"))
    with db(h.cfg) as con:
        get_kid(con, m["slug"])
        if con.execute("SELECT 1 FROM week WHERE kid_slug=? AND week_start=?", (m["slug"], start)).fetchone():
            raise ApiError(409, "that week already exists")
        wid = con.execute("INSERT INTO week(kid_slug,week_start,term) VALUES(?,?,?)", (m["slug"], start, term)).lastrowid
        con.executemany("INSERT INTO word(week_id,position,label) VALUES(?,?,?)",
                        [(wid, i + 1, lab) for i, lab in enumerate(labels)])
        return 201, week_json(con, con.execute("SELECT * FROM week WHERE id=?", (wid,)).fetchone())


def ep_week_delete(h, m, q):
    with db(h.cfg) as con:
        if not con.execute("SELECT 1 FROM week WHERE id=?", (int(m["id"]),)).fetchone():
            raise ApiError(404, "unknown week")
        ids = [r["id"] for r in con.execute("SELECT id FROM word WHERE week_id=?", (int(m["id"]),))]
        con.execute("DELETE FROM week WHERE id=?", (int(m["id"]),))  # cascades to words/results
    delete_audio(h.cfg, ids)
    return 200, {"ok": True}


def ep_word_add(h, m, q):
    label = clean_label(h.json_body().get("label"))
    with db(h.cfg) as con:
        if not con.execute("SELECT 1 FROM week WHERE id=?", (int(m["id"]),)).fetchone():
            raise ApiError(404, "unknown week")
        if con.execute("SELECT COUNT(*) FROM word WHERE week_id=?", (int(m["id"]),)).fetchone()[0] >= MAX_WORDS_PER_WEEK:
            raise ApiError(400, f"a week holds at most {MAX_WORDS_PER_WEEK} words")
        pos = con.execute("SELECT COALESCE(MAX(position),0)+1 FROM word WHERE week_id=?", (int(m["id"]),)).fetchone()[0]
        wid = con.execute("INSERT INTO word(week_id,position,label) VALUES(?,?,?)", (int(m["id"]), pos, label)).lastrowid
        return 201, word_json(con.execute("SELECT * FROM word WHERE id=?", (wid,)).fetchone())


def ep_word_patch(h, m, q):
    label = clean_label(h.json_body().get("label"))
    with db(h.cfg) as con:
        if not con.execute("SELECT 1 FROM word WHERE id=?", (int(m["id"]),)).fetchone():
            raise ApiError(404, "unknown word")
        con.execute("UPDATE word SET label=? WHERE id=?", (label, int(m["id"])))
        return 200, word_json(con.execute("SELECT * FROM word WHERE id=?", (int(m["id"]),)).fetchone())


def ep_word_delete(h, m, q):
    wid = int(m["id"])
    with db(h.cfg) as con:
        if not con.execute("SELECT 1 FROM word WHERE id=?", (wid,)).fetchone():
            raise ApiError(404, "unknown word")
        con.execute("DELETE FROM word WHERE id=?", (wid,))
    delete_audio(h.cfg, [wid])
    return 200, {"ok": True}


def ep_audio_put(h, m, q):
    wid = int(m["id"])
    h.require_type("audio/wav")
    data = h.raw_body(MAX_AUDIO)
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ApiError(400, "body must be a WAV file (RIFF....WAVE)")
    # ?source=tts marks a synthetic clip (offline Piper filler, docs/piper-fallback-spec.md);
    # the default is a child's own recording, which always wins over a synthetic one.
    source = (q.get("source") or ["child"])[0]
    if source not in ("child", "tts"):
        raise ApiError(400, "source must be 'child' or 'tts'")
    with db(h.cfg) as con:
        # Take the write lock BEFORE the check: otherwise a child's recording and a synthetic clip
        # can both pass the 409 check and the synthetic one lands last (BUG-4).
        con.execute("BEGIN IMMEDIATE")
        row = con.execute("SELECT audio_at, audio_source FROM word WHERE id=?", (wid,)).fetchone()
        if not row:
            raise ApiError(404, "unknown word")
        if source == "tts" and row["audio_at"] is not None and row["audio_source"] != "tts":
            raise ApiError(409, "a child's recording already exists; a synthetic clip never replaces it")
        dest = h.cfg.audio_path(wid)
        tmp = dest.with_name(f"{dest.name}.{os.getpid()}.{threading.get_ident()}.tmp")  # unique per request
        tmp.write_bytes(data)
        os.replace(tmp, dest)  # atomic: a reader never sees half a file
        con.execute("UPDATE word SET audio_at=?, audio_source=? WHERE id=?", (h.cfg.now_str(), source, wid))
    return 200, {"ok": True, "bytes": len(data), "audio_source": source}


def ep_audio_get(h, m, q):
    wid = int(m["id"])
    with db(h.cfg) as con:
        if not con.execute("SELECT 1 FROM word WHERE id=?", (wid,)).fetchone():
            raise ApiError(404, "unknown word")
    try:
        data = h.cfg.audio_path(wid).read_bytes()
    except FileNotFoundError:
        raise ApiError(404, "no audio for this word") from None
    return 200, ("audio/wav", data)


TRICKY_WINDOW = 2  # a miss stays tricky until this many right answers in a row follow it


def is_tricky(con, word_id: int) -> bool:
    """Tricky = marked Not yet in any of the word's last 2 results (any mode counts), ignoring
    results from before the child said "I know it now" (word.cleared_session)."""
    last = con.execute("""SELECT correct FROM result WHERE word_id=?
                          AND session_id > COALESCE((SELECT cleared_session FROM word WHERE id=?), 0)
                          ORDER BY session_id DESC LIMIT ?""", (word_id, word_id, TRICKY_WINDOW)).fetchall()
    return any(x["correct"] == 0 for x in last)


def ep_word_known(h, m, q):
    """The child says "that's no longer tricky": results so far stop counting; a new miss makes it tricky again."""
    wid = int(m["id"])
    with db(h.cfg) as con:
        if not con.execute("SELECT 1 FROM word WHERE id=?", (wid,)).fetchone():
            raise ApiError(404, "unknown word")
        con.execute("UPDATE word SET cleared_session=(SELECT COALESCE(MAX(id),0) FROM session) WHERE id=?", (wid,))
    return 200, {"ok": True}


def word_status(history: list[int]) -> str:
    """history = recent results, oldest first. new | solid (never missed) | failing (last two missed) | shaky."""
    if not history:
        return "new"
    if all(history):
        return "solid"
    return "failing" if not any(history[-2:]) else "shaky"


def ep_history(h, m, q):
    """Every week of this kid, newest first, with how often it was tried and each word's recent results."""
    slug = m["slug"]
    with db(h.cfg) as con:
        get_kid(con, slug)
        out = []
        for w in con.execute("SELECT * FROM week WHERE kid_slug=? ORDER BY week_start DESC", (slug,)).fetchall():
            words = []
            for r in con.execute("SELECT * FROM word WHERE week_id=? ORDER BY position, id", (w["id"],)).fetchall():
                hist = [x["correct"] for x in con.execute(
                    "SELECT correct FROM result WHERE word_id=? ORDER BY session_id DESC LIMIT 5", (r["id"],))][::-1]
                tries = con.execute("SELECT COUNT(*) FROM result WHERE word_id=?", (r["id"],)).fetchone()[0]
                words.append({**word_json(r), "history": hist, "tries": tries, "status": word_status(hist),
                              "tricky": is_tricky(con, r["id"])})
            sessions = con.execute("""SELECT COUNT(DISTINCT r.session_id) FROM result r JOIN word ON word.id=r.word_id
                                      WHERE word.week_id=?""", (w["id"],)).fetchone()[0]
            out.append({"id": w["id"], "week_start": w["week_start"], "sessions": sessions,
                        "tricky": sum(x["tricky"] for x in words), "words": words})
        return 200, {"weeks": out, "current": current_week_id(con, slug, h.cfg.today_str())}


def ep_practice(h, m, q):
    mode = (q.get("mode") or ["week"])[0]
    if mode not in MODES:
        raise ApiError(400, "mode must be week, term or tricky")
    slug, today = m["slug"], h.cfg.today_str()
    with db(h.cfg) as con:
        get_kid(con, slug)
        wq = (q.get("week") or [""])[0]
        tq = (q.get("term") or [""])[0]
        if tq and mode == "week":
            raise ApiError(400, "term only applies to the term and tricky modes")
        scope = parse_scope(tq) if tq else None
        if wq:  # an explicit (possibly past) week; "only=tricky" narrows it to that week's tricky words
            if not wq.isdigit() or not con.execute("SELECT 1 FROM week WHERE id=? AND kid_slug=?", (int(wq), slug)).fetchone():
                raise ApiError(404, "unknown week")
            rows = con.execute("SELECT * FROM word WHERE week_id=? ORDER BY position, id", (int(wq),)).fetchall()
            if (q.get("only") or [""])[0] == "tricky":
                rows = [r for r in rows if is_tricky(con, r["id"])]
        elif mode == "week":
            wk = current_week_id(con, slug, today)
            rows = con.execute("SELECT * FROM word WHERE week_id=? ORDER BY position, id", (wk,)).fetchall() if wk else []
        else:
            rows = term_word_rows(con, slug, today, scope)
            if mode == "tricky":
                # Tricky: see is_tricky.
                rows = [r for r in rows if is_tricky(con, r["id"])]
        playable = [word_json(r) for r in rows if r["audio_at"] is not None]
        return 200, {"words": playable, "skipped": len(rows) - len(playable)}


def ep_settings(h, m, q):
    b = h.json_body()
    ok = (b.get("speed") in SPEEDS and b.get("repeats") in (1, 2, 3) and not isinstance(b.get("repeats"), bool)
          and b.get("pause") in PAUSES and b.get("order") in ORDERS)
    if not ok:
        raise ApiError(400, "settings need speed (slow|normal|fast), repeats (1-3), pause (short|long), order (mix|inorder)")
    s = {k: b[k] for k in ("speed", "repeats", "pause", "order")}
    voice = b.get("voice")
    if voice is not None and not (isinstance(voice, str) and len(voice) <= 120
                                  and not any(ord(c) < 32 for c in voice)):
        raise ApiError(400, "voice must be a short name or empty")
    if voice:
        s["voice"] = voice  # optional: the chosen en-GB speech voice (absent = automatic)
    if b.get("typeMode") is True:
        s["typeMode"] = True  # optional experimental flag (#5604); absent = off
    with db(h.cfg) as con:
        get_kid(con, m["slug"])
        con.execute("UPDATE kid SET settings_json=? WHERE slug=?", (json.dumps(s), m["slug"]))
    return 200, s


def ep_session_create(h, m, q):
    b = h.json_body()
    slug = m["slug"]
    results = b.get("results")
    if b.get("mode") not in MODES:
        raise ApiError(400, "mode must be week, term or tricky")
    if not isinstance(results, list) or not results or len(results) > 500:
        raise ApiError(400, "results must be a non-empty list")
    settings = b.get("settings") if isinstance(b.get("settings"), dict) else {}
    seen, clean = set(), []
    for r in results:
        wid = r.get("word_id") if isinstance(r, dict) else None
        if not isinstance(wid, int) or isinstance(wid, bool) or not 0 < wid < 2**62:
            raise ApiError(400, "each result needs an integer word_id")
        if r.get("correct") not in (0, 1, True, False):
            raise ApiError(400, "correct must be 0 or 1")
        if r["word_id"] in seen:
            raise ApiError(400, "duplicate word_id in results")
        seen.add(r["word_id"])
        clean.append((r["word_id"], int(r["correct"])))
    with db(h.cfg) as con:
        get_kid(con, slug)
        for wid, _ in clean:  # words must belong to this kid
            if not con.execute("SELECT 1 FROM word JOIN week ON week.id=word.week_id WHERE word.id=? AND week.kid_slug=?",
                               (wid, slug)).fetchone():
                raise ApiError(400, f"word {wid} does not belong to this kid")
        sid = con.execute("INSERT INTO session(kid_slug,created_at,mode,settings_json) VALUES(?,?,?,?)",
                          (slug, h.cfg.now_str(), b["mode"], json.dumps(settings))).lastrowid
        con.executemany("INSERT INTO result(session_id,word_id,correct) VALUES(?,?,?)", [(sid, w, c) for w, c in clean])
        correct = sum(c for _, c in clean)
        return 201, {"score": correct, "total": len(clean), "stars": stars_of(correct, len(clean)),
                     "streak": kid_streak(con, slug, h.cfg.today_str())}


def session_rows(con, slug, order="ASC", limit=None):
    sql = """SELECT s.id, s.created_at, s.mode, COALESCE(SUM(r.correct),0) AS correct, COUNT(r.word_id) AS total
             FROM session s LEFT JOIN result r ON r.session_id=s.id WHERE s.kid_slug=? GROUP BY s.id ORDER BY s.id """ + order
    if limit:
        sql += f" LIMIT {int(limit)}"
    return con.execute(sql, (slug,)).fetchall()


def kid_streak(con, slug, today):
    dates = {r[0] for r in con.execute("SELECT DISTINCT substr(created_at,1,10) FROM session WHERE kid_slug=?", (slug,))}
    return streak_of(dates, today)


def ep_progress(h, m, q):
    with db(h.cfg) as con:
        get_kid(con, m["slug"])
        stars = sum(stars_of(r["correct"], r["total"]) for r in session_rows(con, m["slug"]))
        last = session_rows(con, m["slug"], "DESC", 14)[::-1]  # chart wants oldest first
        return 200, {"stars": stars, "streak": kid_streak(con, m["slug"], h.cfg.today_str()),
                     "sessions": [{"created_at": r["created_at"], "mode": r["mode"], "correct": r["correct"],
                                   "total": r["total"]} for r in last]}


def ep_report(h, m, q):
    today = h.cfg.today_str()
    out = {}
    with db(h.cfg) as con:
        for kid in con.execute("SELECT slug FROM kid ORDER BY slug").fetchall():
            slug = kid["slug"]
            weeks = [{"id": r["id"], "week_start": r["week_start"], "correct": r["correct"], "total": r["total"],
                      "pct": round(100 * r["correct"] / r["total"]) if r["total"] else 0}
                     for r in con.execute("""SELECT w.id, w.week_start, COALESCE(SUM(r.correct),0) AS correct, COUNT(r.word_id) AS total
                         FROM week w LEFT JOIN word ON word.week_id=w.id LEFT JOIN result r ON r.word_id=word.id
                         WHERE w.kid_slug=? GROUP BY w.id ORDER BY w.week_start""", (slug,))]
            ids = [r["id"] for r in term_word_rows(con, slug, today)]
            missed = []
            for wid in ids:
                row = con.execute("""SELECT word.label, SUM(1-r.correct) AS missed, COUNT(*) AS tried
                                     FROM result r JOIN word ON word.id=r.word_id WHERE r.word_id=?""", (wid,)).fetchone()
                if row["tried"] and row["missed"]:
                    missed.append({"label": row["label"], "missed": row["missed"], "tried": row["tried"]})
            missed.sort(key=lambda x: (-x["missed"], x["label"]))
            recent = [{"created_at": r["created_at"], "mode": r["mode"], "correct": r["correct"], "total": r["total"]}
                      for r in session_rows(con, slug, "DESC", 10)]
            out[slug] = {"weeks": weeks, "most_missed": missed[:10], "recent": recent}
    return 200, out


# -------------------------------------------------------------------- feedback
# The parents' "Tell us what to improve" button. One Vikunja task per submission; sqlite is only a queue
# for when Vikunja is unreachable. The token lives in the server's env and never appears in a response.

FLUSH_LOCK = threading.Lock()   # one backlog flush at a time; taken non-blocking (flush_feedback)
CLAIM_TTL = 300                 # seconds; a claim older than this belongs to a sender that died, so it is free again


class RateLimiter:
    """At most `limit` hits per `window` seconds per key (sliding window). Thread-safe; empty keys are pruned."""

    def __init__(self, limit: int, window: float, clock=time.monotonic):
        self.limit, self.window, self.clock = limit, window, clock
        self.hits: dict[str, list[float]] = {}
        self.lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = self.clock()
        with self.lock:
            for k in [k for k, v in self.hits.items() if v[-1] <= now - self.window]:
                del self.hits[k]  # keeps memory bounded by the number of recent clients
            recent = [t for t in self.hits.get(key, []) if t > now - self.window]
            if len(recent) >= self.limit:
                self.hits[key] = recent
                return False
            self.hits[key] = recent + [now]
            return True


def clean_feedback(body: dict) -> dict:
    """Validated feedback: text 1..MAX_FEEDBACK chars (required), the FEEDBACK_FIELDS optional and short."""
    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        raise ApiError(400, "please write something")
    if len(text.strip()) > MAX_FEEDBACK:
        raise ApiError(400, f"feedback is limited to {MAX_FEEDBACK} characters")
    out = {"text": text.strip()}
    for key, cap in FEEDBACK_FIELDS.items():
        v = body.get(key)
        if v is None or v == "":
            continue
        if not isinstance(v, str) or len(v.strip()) > cap:
            raise ApiError(400, f"{key} must be text of at most {cap} characters")
        out[key] = v.strip()
    return out


def feedback_task(fb: dict, cfg: Config) -> dict:
    """Vikunja task body. Every user value is HTML-escaped: Vikunja renders descriptions as HTML."""
    first = " ".join(fb["text"].split())[:80]
    where = fb.get("page", "app") + (f"/{fb['kid']}" if fb.get("kid") else "")
    rows = [("Page", where), ("Host", fb.get("host", "")), ("Name", fb.get("name", "")),
            ("Contact", fb.get("contact", "")), ("App version", fb.get("version", "")),
            ("Server version", cfg.version), ("Browser", fb.get("ua", "")), ("Received", fb.get("received", ""))]
    meta = "".join(f"<li><b>{k}:</b> {escape(v)}</li>" for k, v in rows if v)
    body = escape(fb["text"]).replace("\n", "<br>")
    return {"title": f"Feedback ({where}): {first}"[:120], "description": f"<p>{body}</p><ul>{meta}</ul>"}


def vikunja_create_task(cfg: Config, task: dict) -> int:
    """PUT /api/v1/projects/<id>/tasks. Returns the task id; raises OSError/ValueError on any failure."""
    if not (cfg.vikunja_url.startswith(("https://", "http://")) and cfg.vikunja_token and cfg.vikunja_project):
        raise ValueError("feedback target not configured")
    req = urllib.request.Request(f"{cfg.vikunja_url.rstrip('/')}/api/v1/projects/{int(cfg.vikunja_project)}/tasks",
                                 data=json.dumps(task).encode(), method="PUT",
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {cfg.vikunja_token}"})
    try:
        with urllib.request.urlopen(req, timeout=VIKUNJA_TIMEOUT) as r:
            return int(json.loads(r.read())["id"])
    except urllib.error.HTTPError as e:  # 4xx/5xx: close its body, report the status only
        e.close()
        raise OSError(f"Vikunja answered {e.code}") from None


def ip_key(ip: str) -> str:
    """Rate-limit key: IPv4 as is; IPv6 by its /64 (one household or host usually owns a whole /64)."""
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return ip
    if a.version == 6 and a.ipv4_mapped:
        return str(a.ipv4_mapped)
    return str(ipaddress.ip_network(f"{a}/64", strict=False)) if a.version == 6 else str(a)


def claim_next(cfg: Config, now: float | None = None) -> tuple[int, str] | None:
    """Atomically take the oldest free queued row (one UPDATE ... RETURNING, so two senders can never both get
    it). A claim older than CLAIM_TTL counts as free (its sender died). Returns (id, payload_json) or None."""
    now = time.time() if now is None else now
    with db(cfg) as con:
        r = con.execute("""UPDATE feedback SET claimed_at=? WHERE id=(SELECT id FROM feedback
                           WHERE claimed_at IS NULL OR claimed_at < ? ORDER BY id LIMIT 1) RETURNING id, payload_json""",
                        (now, now - CLAIM_TTL)).fetchone()
    return (r["id"], r["payload_json"]) if r else None


def unclaim(cfg: Config, rid: int) -> None:
    with db(cfg) as con:
        con.execute("UPDATE feedback SET claimed_at=NULL WHERE id=?", (rid,))


def send_claimed(cfg: Config, rid: int, payload_json: str) -> bool:
    """Create the Vikunja task for a row this caller has claimed, then delete it; on any failure (or when the
    global hourly cap on outbound calls is used up) release the claim and return False: the row stays queued."""
    try:
        if not cfg.feedback_global_limiter.allow("*"):
            raise ValueError("global hourly cap on Vikunja calls reached")
        vikunja_create_task(cfg, feedback_task(json.loads(payload_json), cfg))
    except (OSError, ValueError, KeyError) as e:
        if not cfg.quiet:  # the type only: a message could echo the URL; the token is never in it
            sys.stderr.write(f"feedback: Vikunja send failed ({type(e).__name__}), row {rid} stays queued\n")
        unclaim(cfg, rid)
        return False
    with db(cfg) as con:
        con.execute("DELETE FROM feedback WHERE id=?", (rid,))
    return True


def flush_feedback(cfg: Config, limit: int | None = None) -> tuple[int, int]:
    """Send queued feedback, oldest first; stop at the first failure. Returns (sent, still queued).
    Never waits: if another flush is running it returns (0, queued) at once, so no request queues behind it."""
    sent = 0
    if FLUSH_LOCK.acquire(blocking=False):
        try:
            while limit is None or sent < limit:
                row = claim_next(cfg)
                if row is None or not send_claimed(cfg, *row):
                    break
                sent += 1
        finally:
            FLUSH_LOCK.release()
    with db(cfg) as con:
        return sent, con.execute("SELECT COUNT(*) FROM feedback").fetchone()[0]


def ep_feedback(h, m, q):
    """One call to Vikunja for the parent's own note (short timeout), then at most FEEDBACK_FLUSH older rows."""
    fb = clean_feedback(h.json_body())
    if not h.cfg.feedback_limiter.allow(ip_key(h.client_ip())):  # the global cap only throttles Vikunja calls
        raise ApiError(429, "thanks, that is plenty for now: please try again in an hour")
    fb.update(host=h.request_host(), ua=(h.headers.get("User-Agent") or "")[:300], received=h.cfg.now_str())
    with db(h.cfg) as con:  # queue first: nothing is lost if the send below fails or the process dies
        if con.execute("SELECT COUNT(*) FROM feedback").fetchone()[0] >= h.cfg.feedback_queue_max:
            raise ApiError(429, "we cannot take more feedback right now: please try again later")
        payload = json.dumps(fb)
        rid = con.execute("INSERT INTO feedback(created_at, payload_json, claimed_at) VALUES(?,?,?)",
                          (fb["received"], payload, time.time())).lastrowid  # born claimed: no flush can take it
    if send_claimed(h.cfg, rid, payload):
        flush_feedback(h.cfg, FEEDBACK_FLUSH)  # Vikunja is up: retry a little of any backlog
        return 201, {"ok": True, "queued": False}
    return 202, {"ok": True, "queued": True}


# method -> [(regex, endpoint)]. <id> are digits only, so "../x" or "1.wav" never match -> 404.
ROUTES = [
    ("GET", r"/api/me", ep_me),
    ("GET", r"/api/kids", ep_kids),
    ("GET", r"/api/kids/(?P<slug>[a-z0-9_-]+)/weeks", ep_weeks_list),
    ("POST", r"/api/kids/(?P<slug>[a-z0-9_-]+)/weeks", ep_week_create),
    ("DELETE", r"/api/weeks/(?P<id>\d+)", ep_week_delete),
    ("PATCH", r"/api/weeks/(?P<id>\d+)", ep_week_patch),
    ("GET", r"/api/kids/(?P<slug>[a-z0-9_-]+)/terms", ep_terms),
    ("POST", r"/api/weeks/(?P<id>\d+)/words", ep_word_add),
    ("PATCH", r"/api/words/(?P<id>\d+)", ep_word_patch),
    ("DELETE", r"/api/words/(?P<id>\d+)", ep_word_delete),
    ("POST", r"/api/words/(?P<id>\d+)/known", ep_word_known),
    ("PUT", r"/api/words/(?P<id>\d+)/audio", ep_audio_put),
    ("GET", r"/api/words/(?P<id>\d+)/audio", ep_audio_get),
    ("GET", r"/api/kids/(?P<slug>[a-z0-9_-]+)/practice", ep_practice),
    ("GET", r"/api/kids/(?P<slug>[a-z0-9_-]+)/history", ep_history),
    ("PUT", r"/api/kids/(?P<slug>[a-z0-9_-]+)/settings", ep_settings),
    ("POST", r"/api/kids/(?P<slug>[a-z0-9_-]+)/sessions", ep_session_create),
    ("GET", r"/api/kids/(?P<slug>[a-z0-9_-]+)/progress", ep_progress),
    ("GET", r"/api/report", ep_report),
    ("POST", r"/api/feedback", ep_feedback),
]
ROUTES = [(meth, re.compile(pat + r"\Z"), fn) for meth, pat, fn in ROUTES]
PUBLIC_ROUTES = [r for r in ROUTES if r[2] is ep_feedback]  # public mode: the family API does not exist


# --------------------------------------------------------------------- handler

class Handler(BaseHTTPRequestHandler):
    server_version = "spellings/0.1"
    timeout = 30  # per-connection socket timeout: a stalled client cannot pin a thread
    cfg: Config  # set by make_server on the subclass

    # -- plumbing
    def log_message(self, fmt, *args):  # quieter, one line per request on stderr
        if self.cfg.quiet:
            return
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def send_payload(self, status: int, payload) -> None:
        if isinstance(payload, tuple):  # (content_type, bytes)
            ctype, body = payload
            cache = "no-cache"
        else:
            ctype, body, cache = "application/json; charset=utf-8", json.dumps(payload).encode(), "no-store"
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def raw_body(self, limit: int) -> bytes:
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ApiError(400, "bad Content-Length") from None
        if n < 0:
            raise ApiError(400, "bad Content-Length")
        if n > limit:
            # Drain (bounded) so the client sees our 413 instead of a reset, then drop the connection.
            self.close_connection = True
            left = min(n, MAX_DRAIN)
            while left > 0:
                chunk = self.rfile.read(min(65536, left))
                if not chunk:
                    break
                left -= len(chunk)
            raise ApiError(413, f"body too large (limit {limit} bytes)")
        return self.rfile.read(n) if n else b""

    def require_type(self, want: str) -> None:
        """415 unless Content-Type is `want` (parameters like charset ignored). Blocks cross-site 'simple' requests."""
        got = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if got != want:
            raise ApiError(415, f"Content-Type must be {want}")

    def request_host(self) -> str:
        """Host header without port, lower-case ('' if missing)."""
        host = (self.headers.get("Host") or "").strip().lower()
        return host.rsplit(":", 1)[0] if not host.endswith("]") and ":" in host else host

    def client_ip(self) -> str:
        """Socket peer, or (SPELLING_TRUST_PROXY=1 only) the last X-Forwarded-For hop, which our proxy appended."""
        if self.cfg.trust_proxy:
            hops = [x.strip() for x in (self.headers.get("X-Forwarded-For") or "").split(",") if x.strip()]
            if hops:
                return hops[-1]
        return self.client_address[0]

    def check_host_and_origin(self) -> None:
        if self.request_host() not in self.cfg.allowed_hosts:
            raise ApiError(421, "host not allowed")
        if self.cfg.auth_token is not None:
            got = (self.headers.get("X-Spelling-Token") or "").encode()
            if not hmac.compare_digest(got, self.cfg.auth_token.encode()):
                raise ApiError(401, "missing or wrong X-Spelling-Token")
        if self.command in ("POST", "PUT", "PATCH", "DELETE"):
            if (self.headers.get("Sec-Fetch-Site") or "").lower() == "cross-site":
                raise ApiError(403, "cross-site request refused")
            origin = self.headers.get("Origin")
            if origin is not None:
                o = urlsplit(origin)
                same = (o.scheme in ("http", "https") and o.netloc.lower() == (self.headers.get("Host") or "").strip().lower()
                        and (o.hostname or "") in self.cfg.allowed_hosts)
                if not same:
                    raise ApiError(403, "cross-origin request refused")

    def json_body(self) -> dict:
        self.require_type("application/json")
        raw = self.raw_body(MAX_JSON)
        try:
            data = json.loads(raw or b"{}")
        except (ValueError, UnicodeDecodeError):
            raise ApiError(400, "body is not valid JSON") from None
        if not isinstance(data, dict):
            raise ApiError(400, "body must be a JSON object")
        return data

    def resolve_kid(self, con, q) -> str:
        """Dev hosts (localhost/127.0.0.1): ?kid= > default kid. Kid hosts: first DNS label, no fallback."""
        host = self.request_host()
        if host in ("localhost", "127.0.0.1"):
            explicit = (q.get("kid") or [None])[0]
            if explicit:
                get_kid(con, explicit)  # 404 if unknown
                return explicit
            return self.cfg.default_kid
        get_kid(con, host.split(".")[0])  # 404 if the host names nobody
        return host.split(".")[0]

    # -- dispatch
    def handle_any(self) -> None:
        try:
            self.check_host_and_origin()  # first, for every route (static and API)
            parts = urlsplit(self.path)
            path = unquote(parts.path)
            q = parse_qs(parts.query)
            if path.startswith("/api/"):
                self.send_payload(*self.route_api(path, q))
            elif self.command in ("GET", "HEAD"):
                self.serve_static(path)
            else:
                raise ApiError(405, "method not allowed")
        except ApiError as e:
            self.send_payload(e.status, {"error": e.message})
        except sqlite3.IntegrityError:  # e.g. two parents adding the same week at once
            self.send_payload(409, {"error": "conflict: that already exists"})
        except OverflowError:  # id too big for sqlite -> cannot exist
            self.send_payload(404, {"error": "not found"})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True
        except Exception as e:  # never leak a traceback to the client
            sys.stderr.write(f"error: {e!r}\n")
            self.send_payload(500, {"error": "internal error"})

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = handle_any

    def send_error(self, code, message=None, explain=None):
        """Protocol-level errors (unknown method, bad request line) as JSON, never HTML."""
        try:
            status = HTTPStatus(code)
            body = json.dumps({"error": message or status.phrase}).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
        except (ValueError, OSError):
            pass
        self.close_connection = True

    def route_api(self, path: str, q: dict):
        path_exists = False
        for meth, rx, fn in PUBLIC_ROUTES if self.cfg.public_root else ROUTES:
            m = rx.match(path)
            if m:
                path_exists = True
                if meth == self.command or (meth == "GET" and self.command == "HEAD"):
                    return fn(self, m, q)
        if path_exists:
            raise ApiError(405, "method not allowed")
        raise ApiError(404, "not found")

    def serve_static(self, path: str) -> None:
        base = STATIC
        if self.cfg.public_root:  # public mode: the bin/build-local tree (index.html, parent/index.html, static/, sw.js)
            base = Path(self.cfg.public_root)
            rel = "index.html" if path == "/" else "parent/index.html" if path in ("/parent", "/parent/") else path[1:]
        elif path == "/":
            rel = "index.html"
        elif path in ("/parent", "/parent/", "/parents", "/parents/"):
            rel = "parent.html"
        elif path.startswith("/static/"):
            rel = path[len("/static/"):]
        else:
            raise ApiError(404, "not found")
        segs = rel.split("/")
        # Reject anything that is not a plain relative file path before touching the disk.
        if "\x00" in rel or "\\" in rel or any(s in ("", ".", "..") or s.startswith(".") for s in segs):
            raise ApiError(400 if rel else 404, "bad path")
        f = (base / rel).resolve()
        if not f.is_relative_to(base.resolve()) or not f.is_file():
            raise ApiError(404, "not found")
        ctype = {".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html",
                 ".webmanifest": "application/manifest+json"}.get(f.suffix) or mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        self.send_payload(200, (ctype, f.read_bytes()))


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def make_server(cfg: Config, bind: str = "127.0.0.1", port: int = 8080) -> Server:
    """Build (but do not start) a server. Port 0 picks an ephemeral port (tests)."""
    init_db(cfg)
    handler = type("BoundHandler", (Handler,), {"cfg": cfg})
    return Server((bind, port), handler)


def main() -> None:
    ap = argparse.ArgumentParser(description="Weekly spelling-dictation server. Configuration is via env vars "
                                             "(see the header of this file); flags override them.")
    ap.add_argument("--data-dir", help="data directory (default $SPELLING_DATA_DIR or ./data)")
    ap.add_argument("--port", type=int, help="listen port (default $SPELLING_PORT or 8080)")
    ap.add_argument("--bind", help="listen address (default $SPELLING_BIND or 127.0.0.1)")
    ap.add_argument("--flush-feedback", action="store_true",
                    help="send queued feedback to Vikunja, print 'sent N, queued M', exit 0 if the queue is empty")
    a = ap.parse_args()
    cfg = Config.from_env()
    if a.data_dir:
        cfg.data_dir = Path(a.data_dir)
    if a.flush_feedback:
        init_db(cfg)
        sent, left = flush_feedback(cfg)
        print(f"feedback: sent {sent}, queued {left}")
        sys.exit(0 if left == 0 else 1)
    port = a.port or int(os.environ.get("SPELLING_PORT", "8080"))
    bind = a.bind or os.environ.get("SPELLING_BIND", "127.0.0.1")
    srv = make_server(cfg, bind, port)
    print(f"spellings listening on http://{bind}:{port}  data={cfg.data_dir.resolve()}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
