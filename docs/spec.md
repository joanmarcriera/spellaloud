# spellings: weekly spelling-dictation practice for Ash (Y1) and Finn (Y3)

Status: v0.1 spec, 2026-10-15. Brainstormed with Marc. v0.1 is a working prototype to iterate on,
with deliberately simple styling.

## Problem

Two kids at an English primary school get 5–10 spelling words a week, then an end-of-term
"Big Spell" test. Neither parent is a native speaker, and doing dictation by hand every day takes a
lot of time. The kids record their own voice saying each word once a week. Each day they play the
list back as a dictation, write the words in their school book, and mark themselves.

## Users and devices

- **Ash** (Year 1, ~5): `https://ash.home.example`. **Finn** (Year 3, ~7): `https://finn.home.example`.
- **Parents**: `/parent` on either hostname, used from a phone or Mac.
- Main device: the **Cozyla** wall display, Android 13, Fully Kiosk WebView (Chrome 154), landscape
  1920×1080, touch only. It must also work on a phone.
- LAN + tailnet only (NPM ACL). **No logins**: kid UX must be credential-free.

## Decisions already made (do not re-open)

1. The hostname selects the kid. One service serves both kids.
2. Each word has a **text label**, typed weekly by a parent on `/parent`, and **one audio clip**
   recorded by the kid.
3. Labels are **never shown while practising**. They are shown on Record (the kid reads them to
   record) and on Mark (the correct word is shown).
4. Kid home screen = **one big Play button** with mode tabs and settings chips (no menu screen).
5. Record = **hold to talk** (press and hold, release to finish, keep 300 ms after release),
   then automatic playback, then *Again* / *Next*.
6. Mark = **whole page**: words in the order they were played, each with a speaker button and a
   toggle (unmarked → *Got it ✓* → *Not yet* → *Got it ✓* …). *Finish* is enabled once every word is
   marked.
7. Python **standard library only** (http.server + sqlite3) on stock `python:3.13-alpine`. No pip.
   Vanilla JS, no build step.
8. Audio is processed **in the browser**: record, trim silence, convert to mono, resample to
   22.05 kHz, save as 16-bit WAV, then PUT to the server. The server never transcodes.

## Data model (SQLite, WAL mode, `$SPELLING_DATA_DIR/spellings.db`)

```
kid(slug PK, name, year, settings_json)          -- seeded: ash/Ash/1, finn/Finn/3
week(id PK, kid_slug FK, week_start DATE)        -- week_start = a Monday; UNIQUE(kid_slug, week_start)
word(id PK, week_id FK ON DELETE CASCADE, position INT, label TEXT, audio_at TIMESTAMP NULL)
session(id PK, kid_slug FK, created_at, mode TEXT, settings_json)
result(session_id FK ON DELETE CASCADE, word_id FK ON DELETE CASCADE, correct INT, PRIMARY KEY(session_id, word_id))
```

Audio file: `$SPELLING_DATA_DIR/audio/<word_id>.wav`. The path is always derived from the integer id,
never from user input. Deleting a word or week deletes its files.

**Term** is worked out from a date (approximate UK terms; Easter is ignored): Sep–Dec = Autumn,
Jan–Mar = Spring, Apr–Aug = Summer, labelled e.g. `2026 Autumn`, `2027 Spring`.
A parent can move a single week into a neighbouring term (`PATCH /api/weeks/<id> {term}`, `null` = automatic).
Big Spell and Tricky words default to the current term; `practice?term=<term>` picks another term and
`term=2025-26` a whole school year (Autumn–Summer). `GET /api/kids/<slug>/terms` lists the choices.
**Current week** = the latest week with `week_start <= today`, or else the earliest future week.

## Practice modes

- `week`: the words of the current week.
- `term` (Big Spell): every word from every week in the current term.
- `tricky`: words in the current term that were marked *Not yet* in any of their last 2 results (so 2 right in a row clears it), unless the child tapped "I know it" (`POST /api/words/<id>/known`) since the last miss.
  If there are none, say so ("No tricky words — well done!").

Words with no audio are skipped while playing, and the playing screen shows how many were skipped.

## Practise settings (per kid, stored server-side in `kid.settings_json`)

| Setting | Choices | Ash default | Finn default |
|---|---|---|---|
| speed | slow 0.55 / normal 1.0 / fast 1.25 (`playbackRate`, `preservesPitch=true`) | slow | normal |
| repeats | 1 / 2 / 3 (1.5 s between repeats) | 2 | 2 |
| pause (writing time after a word) | short 5 s / long 10 s | long | short |
| order | mix (shuffle) / in order | in order | mix |

## Screens (kid app, `/`)

1. **Home**: greeting with name, stars and streak. Mode tabs: *This week* / *Big Spell* /
   *Tricky words*. Big ▶. Settings chips (changing one saves immediately). Corner buttons:
   *Record words*, *My stars*, and 🏠, which goes to `SPELLING_HOME_URL`.
2. **Playing**: "Word 3 of 8", a progress bar, a big pause/resume button, *Hear it again*, and *Stop*.
   No labels. When the list ends, go to Mark.
3. **Mark**: as decision 6. *Finish* POSTs the session, then shows the result screen: score, stars
   earned and streak. *Back home* returns to Home.
4. **Record**: week picker (◀ week of 12 Oct ▶), the word label large, a hold-to-talk button, and
   progress dots (filled = has audio; tap a dot to jump to that word). After a recording is saved it
   plays back automatically, then shows *Again* and *Next*. Mic errors give a clear message
   ("The microphone is blocked. Ask a grown-up.").
5. **My stars**: total stars, streak, and a simple bar chart of % correct for the last 14 sessions.

**Stars** per session: 3 if 100%, 2 if ≥ 50%, otherwise 1. **Streak** = consecutive days, ending
today or yesterday, with at least one session.

## Parent page (`/parent`)

- Both kids side by side.
- **First run (browser build)**: one *Get started* panel adds the child and this week's words together
  (with a *example words for this year* button) and goes straight to the kid screen: at most 3 screens from an
  empty state to Play (parent page, kid Home with Play, dictation). `setupStep(kids, weeks)` in `lib.js`
  decides the state (`add-child`, `add-words`, `ready`).
- **Add week**: a date (defaults to this Monday) and a textarea with one word per line.
- **Edit a week**: rename a word, delete a word, add a word, delete the week (with a confirm).
  Each word shows whether it has audio.
- **Report**: per week, the % correct (all sessions); the 10 most-missed words this term (label,
  times missed / times tried); the last 10 sessions (date, mode, score).

## HTTP API (JSON unless stated)

```
GET  /                         kid app (static/index.html)      GET /parent  parent app
GET  /static/<file>            static assets (no directory traversal)
GET  /api/me                   {kid:{slug,name,year,settings}, home_url}  — kid from Host header
GET  /api/kids                 [{slug,name,year}]
GET  /api/kids/<slug>/weeks    [{id,week_start,term,words:[{id,position,label,has_audio}]}]
POST /api/kids/<slug>/weeks    {week_start, words:[label,…]} → week   (409 if the week exists)
DELETE /api/weeks/<id>
POST /api/weeks/<id>/words     {label} → word (appended)
PATCH /api/words/<id>          {label}
DELETE /api/words/<id>
PUT  /api/words/<id>/audio     body = audio/wav (≤ 1 MB, RIFF/WAVE header checked)
GET  /api/words/<id>/audio     audio/wav (Cache-Control: no-cache)
GET  /api/kids/<slug>/practice?mode=week|term|tricky → {words:[{id,position,label,has_audio}], skipped:n}
PUT  /api/kids/<slug>/settings {speed,repeats,pause,order}
POST /api/kids/<slug>/sessions {mode, settings, results:[{word_id,correct}]} → {score,total,stars,streak}
GET  /api/kids/<slug>/progress → {stars, streak, sessions:[{created_at,mode,correct,total}]}
GET  /api/report               → per kid: weeks accuracy, most_missed, recent sessions
```

Kid resolution: the first DNS label of `Host` (`ash.lab…` → `ash`). If unknown, use
`SPELLING_DEFAULT_KID`. A `?kid=` query parameter overrides both (for local dev). Unknown kid →
404 JSON. Validation: label is 1–40 characters after trimming; `week_start` is an ISO date and is
normalised to its Monday; ids are integers. Errors are JSON `{error}` with the correct 4xx code.

## Configuration (env)

`SPELLING_DATA_DIR` (default `./data`), `SPELLING_PORT` (8080), `SPELLING_BIND` (127.0.0.1), `SPELLING_AUTH_TOKEN` (unset),
`SPELLING_HOME_URL` (default `https://ha.home.example/wall-board/wide?kiosk`),
`SPELLING_DEFAULT_KID` (default `finn`).

## Deployment (homelab, separate step, confirmed with Marc first)

- TrueNAS custom app `spellings`: `python:3.13-alpine`, command `python /app/server.py`, host port
  in the 303xx range. Volumes: `/mnt/BigDisk/applications/spellings/app:/app:ro` and
  `/mnt/BigDisk/applications/spellings/data:/data`.
- NPM proxy hosts `ash.lab` and `finn.lab`: wildcard cert 55, ACL `lan-tailnet-only` (2).
- Fully Kiosk on the Cozyla: enable `microphoneAccess`, plus two buttons on the HA wall-board.
- The dataset sits under `applications` (recursive snapshots + replication), so backups are covered by the snapshot schedule; there is no separate audit script.

## Testing

- `python3 -m unittest`: API tests against a real server on an ephemeral port with a temporary
  data dir (CRUD, validation, audio round-trip, modes incl. tricky, stars/streak, term maths,
  path-traversal rejection).
- `node --test`: pure JS helpers in `static/lib.js` (silence trim, WAV encoding, play-schedule
  builder, shuffle determinism with a seed).
- Manual/Playwright: the full flow on a 1920×1080 viewport, with a fake mic (`--use-fake-device-for-media-stream`).

## Out of scope for v0.1

TTS fallback (Piper), M-B one-card marking for Ash, rewards integration, Catalan UI, auth.
