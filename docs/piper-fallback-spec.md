# Spec: Piper TTS fallback for missing clips (Vikunja #3522, spec only)

Status: spec, 2026-10-16. Server slice built 2026-10-17 (`audio_source` column, `PUT .../audio?source=tts`, 409 if a child clip exists, tests in `TestAudioSource`); `bin/fill-missing-audio` (dry run by default, `--enable` uploads, refuses a missing, over-500 MB or en_US voice file) and the computer-voice badge are built; the voice audition (Marc's ears) is not done; the family app is still in its first real week (#3520).
Rewards integration is out of scope here: it needs Marc to say what a reward is (HA entity? screen time?).

## Problem

A word with no recording is skipped on the playing screen ("skipped n"). Parents forget to have the child record, and a
new week starts with zero audio. A synthetic voice should fill gaps, clearly marked, never replacing a child's recording.

## Constraint that shapes the design

The server is Python standard library only on stock `python:3.13-alpine` (spec decision 7). Piper needs a native binary and a
~60 MB voice model, so it must **not** go into the server. Generate clips **offline, outside the container**, and upload them through the existing
`PUT /api/words/<id>/audio` (WAV, <= 1 MB, RIFF check). The server stays unchanged except for one flag below.

## Design

1. `bin/fill-missing-audio` (Python, runs on the Mac or TrueNAS, not in the app container). Steps: `GET /api/kids/<slug>/weeks`, for each word with
   `has_audio == false` run `piper --model <voice>.onnx --output_file tmp.wav` on the label, resample to 22.05 kHz mono 16-bit (same as the browser
   pipeline), `PUT` it, then mark the word as synthetic.
2. Voice: an en-GB Piper voice (candidates to audition: `en_GB-alba-medium`, `en_GB-jenny_dioco-medium`, `en_GB-northern_english_male-medium`;
   names from the Piper voices list, to be confirmed against the current release before use). Reject US voices for the same reason as `static/voice.js`.
3. Server change (small): `word.audio_source TEXT NULL` (`'child'` default | `'tts'`), returned in the weeks API. A child's recording through the
   existing PUT always sets `'child'`, so it overwrites a synthetic clip; the filler never overwrites a `'child'` clip.
4. UI: on Record, words with a synthetic clip show a small "computer voice" badge and still invite the child to record their own. Playing uses whichever exists.
5. Safety: label text goes to Piper as an argument list (no shell), 1-40 chars (already validated), output size cap, timeout 20 s per word.

## Tests (when built)

- Unit: resampler matches `lib.js` output length/format; filler skips words with `audio_source == 'child'`.
- API: PUT of a child clip over a `tts` clip flips `audio_source`; filler never replaces a child clip.
- Manual: audition 3 voices on 20 words including homophones (witch/which, their/there) and record the pick in this file.

## Alternative for the public browser version

No server there. Use the Web Speech path in `static/voice.js` (already built) instead; bundling a WASM Piper is possible but ~60 MB per voice and not worth it for the MVP.
