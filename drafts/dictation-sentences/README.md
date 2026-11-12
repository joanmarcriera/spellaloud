# Dictation sentences + homophone flags (DRAFT, unpublished)

Task: https://tracker.example/tasks/4061 (gate: https://tracker.example/tasks/3740 records GO; it does not yet).

`sentences.psv` has one line per statutory form in `content/uk-statutory/lists.json` (321 distinct forms; `busy` is in both Y1 and Y2 lists):

    form|sentence|confusable_with   (confusable_with = homophones and near-misses a child confuses it with, joined by "/", may be empty)

- Sentences are our own, written by the drive lane (Claude), not copied from any scheme or site. No real people,
  brands or schools. Y1/Y2 forms: at most 8 words; Y3-Y6: at most 14 (`tests/dictation_sentences_draft.test.mjs`
  enforces whole-word, exactly once, length, full coverage).
- The free gateway (`llmx`) was not used: `~/bin/llmx` is a dangling symlink (its `_inbox/llm-offload` target is gone).
- NOT yet done, needs a person: (1) Marc's spot-check of 30 sentences (merge condition in the task); (2) the 20-word
  listening check with the en-GB macOS Web Speech voice via `static/voice.js` (needs audio output);
  (3) a UK-English read of the homophone flags (accent-dependent ones: floor/flaw, caught/court, poor/pour/paw).
- After GO: merge into `lists.json` as `sentence` and `confusable_with` per form (schema 2), list the voice-check
  words in `content/uk-statutory/SOURCES.md`. Until then `lists.json` stays schema 1 and nothing ships.
- Read-aloud note: `Mr` and `Mrs` are spoken as Mister / Missus; the child writes the abbreviation.
