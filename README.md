# Spellaloud

Weekly spelling practice for primary-school children. A grown-up types the week's spelling words; the app reads
them out one by one (in a British voice, or in your own recording); the child writes them down, then checks and
marks their own answers. Made by one parent for their own children's weekly spelling test, then opened up for the class.

**Use it:** https://spellaloud.joanmarcriera.es (works in any modern browser on a phone, tablet or computer; add it
to your home screen to use it like an app). The first visit starts a short tour.

- Free, no account, no adverts, no analytics.
- Private by design: children, words, recordings and scores stay in the browser on your device (IndexedDB).
  Nothing is uploaded. The only thing the server receives is a feedback note, when you choose to send one.
- Share a week's words with other parents as a link (the words travel in the URL fragment, which browsers never
  send to a server), and move everything to another device with one export file.
- Includes the England national-curriculum statutory spelling lists as example words (Open Government Licence v3.0,
  see `content/uk-statutory/SOURCES.md`).

## Say thanks

Spellaloud is free and will stay free. If it helps your family, you can
[buy me a coffee](https://marcriera.lemonsqueezy.com/checkout/buy/5fbc35a0-bd77-470f-8e9b-e184199a3f4f)
(optional; nothing unlocks and nothing changes; Lemon Squeezy handles the payment).

## Help improve it

- **Not a coder?** Use the Feedback button in the app. One line is enough.
- **A coder?** Issues and pull requests are welcome here. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: it is
  short, and it explains the few hard rules (no third-party requests, no HTML sinks, children's data stays on the device).

## Run it yourself

Requirements: Python 3.11+ (standard library only) and, for the tests, Node 20+.

    bin/build-local --out dist-local          # the browser-only app as static files
    SPELLING_PUBLIC_ROOT=dist-local python3 server.py
    # open http://localhost:8080/  (the microphone needs https or localhost)

There is also a home-network ("family") mode where `server.py` keeps the data in SQLite and each child gets their
own hostname: run `SPELLING_DATA_DIR=./data python3 server.py` and open http://localhost:8080/?kid=ash.
`python3 server.py --help` lists the flags; `docs/spec.md` describes the design.

## Test

    python3 -m unittest discover -s tests     # server API, real server on an ephemeral port
    node --test                               # the browser modules (no path argument)

## Layout

| Path | What |
|---|---|
| `server.py` | stdlib HTTP server: the family API (SQLite) or, in public mode, the static app + the feedback endpoint |
| `static/` | the app: `app.js` child screens, `parent.js` grown-ups page, `tour.js` guided tour, `store.js` IndexedDB store, `voice.js` speech and recording, `share.js` share links, `pack.js` export files |
| `bin/` | build, smoke and helper scripts (each has a usage header) |
| `tools/export_family.py` | home-server data → one `.spellings` file for the browser app (`docs/migrate-family.md`) |
| `content/uk-statutory/` | statutory spelling lists as data (OGL v3.0) |
| `site/` | help, privacy, terms and changelog pages |
| `tests/` | `unittest` and `node:test` suites |

## About this repository

This is a published snapshot of the private working repository: each release is copied here as one commit, with
household details (children's names, home-network hostnames, the private task tracker) replaced by neutral
placeholders. Pull requests are reviewed here and applied upstream, so they show up in the next snapshot.

## Licence

Code: [GNU AGPL v3.0](LICENSE). Spelling lists: Open Government Licence v3.0 (Crown copyright).
