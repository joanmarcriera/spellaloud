#!/usr/bin/env python3
"""Local stub of the waitlist collector (Vikunja #4118). Same request/response shape as
deploy/n8n/waitlist-collector.json, so the static forms can be exercised without n8n.

Usage:  python3 tools/webhook-stub.py [--port 8787] [--store /tmp/waitlist.jsonl] [--limit 5] [--window 60]
        POST /waitlist  application/x-www-form-urlencoded  email=<addr>&source=<lists|m|e|r|waitlist>[&price_pref=...]
Responses (identical to the n8n workflow):
        303 Location: <redirect>?joined=1   accepted, or duplicate email (no enumeration signal)
        400                                 invalid email or unknown source
        429                                 more than --limit requests from one client in --window seconds
Storage: one JSON line per new email: email, source, consent timestamp (UTC), wording version, client hash (never the raw IP).
The stub binds to 127.0.0.1 only and never talks to the network. Stdlib only.
"""
import argparse, hashlib, json, re, sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs

SOURCES = {"lists", "m", "e", "r", "waitlist"}
WORDING_VERSION = "waitlist-2026-10-v1"          # bump when the consent sentence on the form changes
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s.]+(\.[^@\s.]+)+$")
PRICE_PREF = {"free", "once-2.99", "year-14", ""}                  # optional willingness-to-pay answer from /thanks/
REDIRECT = "https://spellaloud.joanmarcriera.es/thanks/?joined=1"   # absolute: a relative Location would resolve on the n8n host
MAX_EMAILS = 5000                                 # demand test needs 50; refuse growth past this
# Behind Traefik the client address is the RIGHTMOST X-Forwarded-For entry (the hop our proxy appended);
# the leftmost entry is client-controlled and would let a caller dodge the rate limit.


class Collector:
    """Pure logic (no sockets) so tests can drive it with a fake clock."""

    def __init__(self, store, limit=5, window=60, clock=time.time):
        self.store, self.limit, self.window, self.clock = store, limit, window, clock
        self.hits = {}                                # client hash -> [timestamps]
        self.seen, self.answered = set(), set()
        try:
            with open(store, encoding="utf-8") as f:
                for l in f:
                    if l.strip():
                        r = json.loads(l)
                        self.seen.add(r["email"])
                        if r.get("price_pref"):
                            self.answered.add(r["email"])
        except FileNotFoundError:
            pass

    def handle(self, client, form):
        """Return (status, location-or-None)."""
        now = self.clock()
        h = hashlib.sha256(client.encode()).hexdigest()[:16]
        recent = [t for t in self.hits.get(h, []) if now - t < self.window]
        recent.append(now)
        self.hits[h] = recent
        if len(recent) > self.limit:
            return 429, None
        email = (form.get("email") or [""])[0].strip().lower()
        source = (form.get("source") or [""])[0].strip().lower()
        price_pref = (form.get("price_pref") or [""])[0].strip().lower()
        if not EMAIL_RE.match(email) or len(email) > 254 or source not in SOURCES or price_pref not in PRICE_PREF:
            return 400, None
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))
        if email not in self.seen:
            if len(self.seen) >= MAX_EMAILS:                # hard cap so a flood cannot fill the disk
                return 429, None
            self.seen.add(email)
            if price_pref:
                self.answered.add(email)
            # the client hash is used only for the in-memory rate limit and is never written to the store
            rec = {"email": email, "source": source, "price_pref": price_pref, "consent_at": stamp, "wording": WORDING_VERSION}
            with open(self.store, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec) + "\n")
        elif price_pref and email not in self.answered:            # /thanks/ re-posts the email with a price answer; first answer wins
            self.answered.add(email)
            with open(self.store, "a", encoding="utf-8") as f:
                f.write(json.dumps({"email": email, "price_pref": price_pref, "answered_at": stamp}) + "\n")
        return 303, REDIRECT


def make_handler(collector):
    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            if self.path.split("?")[0] != "/waitlist":
                self.send_response(404); self.end_headers(); return
            n = min(int(self.headers.get("Content-Length") or 0), 4096)
            form = parse_qs(self.rfile.read(n).decode("utf-8", "replace"))
            xff = self.headers.get("X-Forwarded-For", "") if self.client_address[0] == "127.0.0.1" else ""
            client = xff.split(",")[-1].strip() or self.client_address[0]
            status, loc = collector.handle(client, form)
            self.send_response(status)
            if loc:
                self.send_header("Location", loc)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *a):                  # never log request bodies or addresses
            pass
    return H


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--store", default="/tmp/waitlist-stub.jsonl")
    ap.add_argument("--limit", type=int, default=5)
    ap.add_argument("--window", type=int, default=60)
    a = ap.parse_args()
    srv = HTTPServer(("127.0.0.1", a.port), make_handler(Collector(a.store, a.limit, a.window)))
    print(f"waitlist stub on http://127.0.0.1:{a.port}/waitlist store={a.store}", file=sys.stderr)
    srv.serve_forever()


if __name__ == "__main__":
    main()
