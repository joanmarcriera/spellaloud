// OCR spike (Vikunja #3538): sheet photo -> word list, on device, Tesseract.js (WASM). No upload path:
// the worker runs in-process; the only network use is the one-off language-data download, which the
// real PWA would bundle/cache instead (see docs/validation/05-ocr-wordlist-spike.md).
// Usage: node tools/ocr_wordlist_spike.mjs OUT_DIR   (OUT_DIR from tools/ocr_wordlist_spike.py;
//        resolve tesseract.js via NODE_PATH=<scratch>/node_modules)
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);

/** Words from raw OCR text: alphabetic tokens (letters and apostrophes) of 2+ chars; line numbers
 *  like "3." and punctuation are dropped. Lowercased, de-duplicated, order kept. */
export function wordsFromText(text) {
  const seen = new Set(), out = [];
  for (const m of text.toLowerCase().matchAll(/[a-z][a-z']+/g)) {
    if (!seen.has(m[0])) { seen.add(m[0]); out.push(m[0]); }
  }
  return out;
}

/** Heuristic: sheet furniture (title, teacher, footer) is prose; list entries carry a marker like "3." or
 *  "3)". A line qualifies when it has at least one marker and nothing but markers and single words
 *  (so two-column lines "1. because 7. though" work), or when it is one bare word. */
export function wordsFromListLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const toks = line.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!toks.length) continue;
    const isMark = t => /^\d{1,2}[.):]$/.test(t), isWord = t => /^[a-z][a-z']+$/.test(t);
    const marks = toks.filter(isMark).length, words = toks.filter(isWord);
    const ok = marks ? toks.every(t => isMark(t) || isWord(t)) : toks.length === 1 && words.length === 1;
    if (ok) for (const w of words) if (!out.includes(w)) out.push(w);
  }
  return out;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const { createWorker } = require('tesseract.js');   // lazy so the parsers above import without it
  const dir = process.argv[2];
  const truth = JSON.parse(readFileSync(`${dir}/truth.json`, 'utf8'));
  const worker = await createWorker('eng');
  let tp = 0, fp = 0, fn = 0;
  for (const [file, want] of Object.entries(truth)) {
    const t0 = Date.now();
    const { data } = await worker.recognize(`${dir}/${file}`);
    const got = wordsFromListLines(data.text);
    const hit = want.filter(w => got.includes(w)), miss = want.filter(w => !got.includes(w)), extra = got.filter(w => !want.includes(w));
    tp += hit.length; fn += miss.length; fp += extra.length;
    console.log(`${file}: ${hit.length}/${want.length} exact, missed=[${miss}] extra=[${extra}] conf=${Math.round(data.confidence)} ${Date.now() - t0}ms`);
  }
  await worker.terminate();
  console.log(`TOTAL recall ${(100 * tp / (tp + fn)).toFixed(1)}%  precision ${(100 * tp / (tp + fp || 1)).toFixed(1)}%`);
}
