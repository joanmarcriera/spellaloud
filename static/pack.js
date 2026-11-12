// pack.js - export/import "one file" backup for the browser-only product (Vikunja #3534).
// Pure functions (no DOM, no IndexedDB): they work on a plain `snapshot` object plus a map of
// audio bytes, so the future IndexedDB store (#3532) only has to produce/consume that shape.
//
// File format (`spellings-<child>-<date>.spellings`) = a standard ZIP (stored, no compression, so any
// unzip tool can open it) containing:
//   manifest.json   {format:'spellings-pack', version:1, created, app, contents?}
//                   contents = {recordings, results, settings, names} booleans: what the parent chose to put in
//                   (missing in files made before 2026-11-12 = everything). Older readers ignore it.
//   data.json       the snapshot (below)
//   audio/<n>.wav   one clip per word that has audio; data.json references it by name
//
// snapshot = {
//   kids:     [{slug, name, year, settings}],
//   weeks:    [{kid, week_start:'YYYY-MM-DD', term?, words:[{label, position, audio:'audio/3.wav'|null, audio_source?:'tts', cleared_at?}]}],
//   sessions: [{kid, created_at, mode, settings, results:[{week_start, label, correct}]}]
// }
// Words are identified by (kid, week_start, label lower-cased), never by database id, so merges
// work between devices whose ids differ. The licence check (#3536) is deliberately NOT here:
// callers decide whether the Export button is enabled.

export const FORMAT = 'spellings-pack';
export const VERSION = 1;
export const REMINDER_WEEKS = 4;

const enc = new TextEncoder();
const dec = new TextDecoder();

let CRC_TABLE = null;
/** CRC-32 (IEEE) of a Uint8Array, as an unsigned 32-bit number. */
export function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Build a stored-only ZIP from {name: Uint8Array}. Entry order follows Object.keys. */
export function zipStore(files) {
  const names = Object.keys(files);
  const parts = [];
  const central = [];
  let offset = 0;
  for (const name of names) {
    const data = files[name];
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // method 0 = stored
    local.setUint16(10, 0, true); // time
    local.setUint16(12, 0x21, true); // date 1980-01-01
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(12, 0, true);
    cd.setUint16(14, 0x21, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, names.length, true);
  eocd.setUint16(10, names.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let pos = 0;
  for (const p of all) { out.set(p, pos); pos += p.length; }
  return out;
}

/** Read a stored-only ZIP into {name: Uint8Array}. Throws a plain-English Error on anything else. */
export function unzipStore(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 22) throw new Error('This is not a Spellings file.');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let e = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { e = i; break; }
  }
  if (e < 0) throw new Error('This is not a Spellings file.');
  const count = v.getUint16(e + 10, true);
  let p = v.getUint32(e + 16, true);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || v.getUint32(p, true) !== 0x02014b50) throw new Error('This file is damaged.');
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const lho = v.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (method !== 0) throw new Error('This file was not made by Spellings (it is compressed).');
    if (lho + 30 > bytes.length || v.getUint32(lho, true) !== 0x04034b50) throw new Error('This file is damaged.');
    const start = lho + 30 + v.getUint16(lho + 26, true) + v.getUint16(lho + 28, true);
    if (start + size > bytes.length) throw new Error('This file is damaged (cut short).');
    const data = bytes.slice(start, start + size);
    if (crc32(data) !== crc) throw new Error('This file is damaged (checksum mismatch in ' + name + ').');
    if (name.includes('..') || name.startsWith('/')) throw new Error('This file is not safe to open.');
    files[name] = data;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/** Build the pack bytes. `audio` maps a name referenced by the snapshot (e.g. 'audio/1.wav') to bytes. */
export function buildPack(snapshot, audio = {}, { now = new Date().toISOString(), contents = null } = {}) {
  const manifest = { format: FORMAT, version: VERSION, created: now, app: 'spellings' };
  if (contents) manifest.contents = contents;
  const files = {
    'manifest.json': enc.encode(JSON.stringify(manifest)),
    'data.json': enc.encode(JSON.stringify(snapshot)),
  };
  for (const w of snapshot.weeks) {
    for (const word of w.words) {
      if (!word.audio) continue;
      if (!audio[word.audio]) throw new Error('Missing audio for ' + word.label);
      files[word.audio] = audio[word.audio];
    }
  }
  return zipStore(files);
}

/** Parse + validate pack bytes -> {snapshot, audio, created}. Throws a friendly Error if invalid. */
export function parsePack(bytes) {
  const files = unzipStore(bytes);
  if (!files['manifest.json'] || !files['data.json']) throw new Error('This is not a Spellings file.');
  let manifest, snapshot;
  try {
    manifest = JSON.parse(dec.decode(files['manifest.json']));
    snapshot = JSON.parse(dec.decode(files['data.json']));
  } catch { throw new Error('This file is damaged.'); }
  if (manifest.format !== FORMAT) throw new Error('This is not a Spellings file.');
  if (manifest.version > VERSION) throw new Error('This file is from a newer version of Spellings. Update the app and try again.');
  if (!Array.isArray(snapshot.kids) || !Array.isArray(snapshot.weeks) || !Array.isArray(snapshot.sessions)) {
    throw new Error('This file is damaged.');
  }
  const audio = {};
  for (const w of snapshot.weeks) {
    for (const word of w.words) {
      if (typeof word.label !== 'string' || !word.label.trim()) throw new Error('This file is damaged.');
      if (word.audio) {
        if (!files[word.audio]) throw new Error('This file is damaged (missing a recording).');
        audio[word.audio] = files[word.audio];
      }
    }
  }
  const c = manifest.contents;
  const contents = c && typeof c === 'object' && CONTENT_KEYS.every((k) => typeof c[k] === 'boolean')
    ? Object.fromEntries(CONTENT_KEYS.map((k) => [k, c[k]])) : null;
  return { snapshot, audio, created: manifest.created, contents };
}

// ---- Choose what goes in the file (2026-11-12). Words are always in; the rest is the parent's choice.
/** The optional parts of a backup file, in the order the parent page lists them. */
export const CONTENT_KEYS = ['recordings', 'results', 'settings', 'names'];
/** "Everything, for me" (keep it, or move to another device) and "To share with another parent" (words only). */
export const BACKUP_PRESETS = {
  everything: { recordings: true, results: true, settings: true, names: true },
  share: { recordings: false, results: false, settings: false, names: false },
};
const CONTENT_WORDS = { recordings: 'recordings', results: 'scores and stars', settings: 'settings', names: 'names' };

/** What a snapshot really holds (a file's manifest `contents` is only a label; a hand-made file could lie). */
export function contentsOf(snapshot, audio = {}) {
  return {
    recordings: Object.keys(audio).length > 0,
    results: snapshot.sessions.length > 0 || snapshot.weeks.some((w) => w.words.some((x) => x.cleared_at)),
    settings: snapshot.kids.some((k) => k.settings && Object.keys(k.settings).length > 0),
    names: snapshot.kids.some((k) => !/^Child \d+$/.test(k.name)),
  };
}

/** What a file holds, for the import preview: "words only", "words, recordings, ..." or older files' "everything". */
export function describeContents(contents) {
  if (!contents) return 'everything (older file)';
  const on = CONTENT_KEYS.filter((k) => contents[k]).map((k) => CONTENT_WORDS[k]);
  return on.length ? ['words', ...on].join(', ') : 'words only';
}

/**
 * Cut a snapshot down to what the parent chose. `choice` = {kids: [slug] | null (= all), recordings, results,
 * settings, names}. Without results the sessions and the "I know it" marks go; without names each child becomes
 * "Child N" (slug child-N), so a file shared in a class group names nobody. Returns {snapshot, audio}; pure.
 */
export function selectSnapshot(snapshot, audio, choice) {
  const pick = choice.kids == null ? null : new Set(choice.kids);
  const kids = snapshot.kids.filter((k) => !pick || pick.has(k.slug));
  if (!kids.length) throw new Error('Choose at least one child to back up.');
  const slugMap = new Map(kids.map((k, i) => [k.slug, choice.names ? k.slug : `child-${i + 1}`]));
  const outAudio = {};
  const out = {
    kids: kids.map((k, i) => ({
      slug: slugMap.get(k.slug), name: choice.names ? k.name : `Child ${i + 1}`, year: k.year,
      settings: choice.settings ? structuredClone(k.settings || {}) : {},
    })),
    weeks: snapshot.weeks.filter((w) => slugMap.has(w.kid)).map((w) => ({
      ...w, kid: slugMap.get(w.kid),
      words: w.words.map((word) => {
        const rec = { label: word.label, position: word.position, audio: null };
        if (choice.recordings && word.audio && audio[word.audio]) {
          rec.audio = word.audio; outAudio[word.audio] = audio[word.audio];
          if (word.audio_source === 'tts') rec.audio_source = 'tts';
        }
        if (choice.results && word.cleared_at) rec.cleared_at = word.cleared_at;
        return rec;
      }),
    })),
    sessions: choice.results ? snapshot.sessions.filter((x) => slugMap.has(x.kid)).map((x) => ({ ...structuredClone(x), kid: slugMap.get(x.kid) })) : [],
  };
  return { snapshot: out, audio: outAudio };
}

/**
 * Put a one-child file under one of this device's children (`toSlug`): the file's child record is dropped and its
 * weeks and sessions are re-labelled, so mergePack adds the words to that child instead of making a new one.
 */
export function retargetSnapshot(snapshot, toSlug) {
  if (snapshot.kids.length !== 1) {
    throw new Error(`This file holds ${snapshot.kids.length} children, so it can only be imported as they are. Choose "The children in the file".`);
  }
  return {
    kids: [],
    weeks: snapshot.weeks.map((w) => ({ ...w, kid: toSlug })),
    sessions: snapshot.sessions.map((x) => ({ ...x, kid: toSlug })),
  };
}

/** Key for a word within a snapshot. */
const wordKey = (w) => w.label.trim().toLowerCase();
const weekKey = (w) => w.kid + '|' + w.week_start;
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/; // same shape as backup.js (local time, no zone)
/** The later of two "I know it" markers; anything that is not a valid stamp is ignored (null if none). */
const laterStamp = (a, b) => {
  const ok = [a, b].filter((x) => typeof x === 'string' && STAMP_RE.test(x));
  return ok.length ? ok.sort().pop() : null;
};
const sessionKey = (s) => s.kid + '|' + s.created_at + '|' + s.mode;

/**
 * Combine the device's current data with an imported pack.
 * mode 'replace': the result is the incoming data; the summary reports what is thrown away.
 * mode 'merge' (by week): weeks that only exist on one side are kept; for a week on both sides the
 * existing words stay, incoming words with a new label are appended, and incoming audio fills in
 * only where the existing word has none (never overwrites a recording). Sessions are de-duplicated.
 * Returns {snapshot, audio, summary}; nothing is written - the caller shows `summary`, then writes.
 */
export function mergePack(existing, existingAudio, incoming, incomingAudio, mode = 'merge') {
  if (mode === 'replace') {
    const lost = existing.weeks.length;
    return {
      snapshot: structuredClone(incoming), audio: { ...incomingAudio },
      summary: { mode, weeksAdded: incoming.weeks.length, weeksMerged: 0, wordsAdded: incoming.weeks.reduce((n, w) => n + w.words.length, 0),
        recordingsAdded: Object.keys(incomingAudio).length, sessionsAdded: incoming.sessions.length, weeksDiscarded: lost },
    };
  }
  const out = structuredClone(existing);
  const audio = { ...existingAudio };
  const sum = { mode, weeksAdded: 0, weeksMerged: 0, wordsAdded: 0, recordingsAdded: 0, sessionsAdded: 0, weeksDiscarded: 0 };
  let counter = 0;
  const fresh = () => { let n; do { n = 'audio/m' + (++counter) + '.wav'; } while (audio[n]); return n; };
  const kidSlugs = new Set(out.kids.map((k) => k.slug));
  for (const k of incoming.kids) if (!kidSlugs.has(k.slug)) out.kids.push(structuredClone(k));
  const byKey = new Map(out.weeks.map((w) => [weekKey(w), w]));
  for (const iw of incoming.weeks) {
    const have = byKey.get(weekKey(iw));
    if (!have) {
      const copy = structuredClone(iw);
      for (const word of copy.words) {
        if (word.audio) { const n = fresh(); audio[n] = incomingAudio[word.audio]; word.audio = n; sum.recordingsAdded++; }
        sum.wordsAdded++;
      }
      out.weeks.push(copy);
      sum.weeksAdded++;
      continue;
    }
    sum.weeksMerged++;
    const words = new Map(have.words.map((w) => [wordKey(w), w]));
    for (const iword of iw.words) {
      const mine = words.get(wordKey(iword));
      if (!mine) {
        const copy = { label: iword.label, position: have.words.length + 1, audio: null };
        const cl = laterStamp(iword.cleared_at, null);
        if (cl) copy.cleared_at = cl;
        if (iword.audio) {
          copy.audio = fresh(); audio[copy.audio] = incomingAudio[iword.audio]; sum.recordingsAdded++;
          if (iword.audio_source === 'tts') copy.audio_source = 'tts';
        }
        have.words.push(copy);
        words.set(wordKey(copy), copy);
        sum.wordsAdded++;
      } else {
        if (!mine.audio && iword.audio) {
          mine.audio = fresh();
          audio[mine.audio] = incomingAudio[iword.audio];
          if (iword.audio_source === 'tts') mine.audio_source = 'tts';
          sum.recordingsAdded++;
        }
        // keep the newest "I know it" marker (#4527); a bad stamp never overwrites a good one
        const cl = laterStamp(mine.cleared_at, iword.cleared_at);
        if (cl) mine.cleared_at = cl;
      }
    }
  }
  const seen = new Set(out.sessions.map(sessionKey));
  for (const s of incoming.sessions) {
    if (seen.has(sessionKey(s))) continue;
    out.sessions.push(structuredClone(s));
    seen.add(sessionKey(s));
    sum.sessionsAdded++;
  }
  // Chronological order, so older imported sessions do not become the "newest" when ids are re-issued (#4526).
  // Array.prototype.sort is stable, so equal stamps keep their relative order.
  out.sessions.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  return { snapshot: out, audio, summary: sum };
}

/** Human-readable one-liner for the "are you sure?" step. */
export function describeSummary(s) {
  if (s.mode === 'replace') {
    return `Replace everything on this device with the file: ${s.weeksAdded} weeks, ${s.wordsAdded} words, ` +
      `${s.recordingsAdded} recordings, ${s.sessionsAdded} sessions. ${s.weeksDiscarded} weeks here will be discarded.`;
  }
  return `Add from the file: ${s.weeksAdded} new weeks, ${s.weeksMerged} weeks merged, ${s.wordsAdded} new words, ` +
    `${s.recordingsAdded} recordings, ${s.sessionsAdded} sessions. Nothing here is overwritten.`;
}

/** `spellings-<child>-<yyyy-mm-dd>.spellings`, child slugified to a safe name. */
export function packFilename(child, date = new Date()) {
  const slug = String(child || 'family').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'family';
  return `spellings-${slug}-${date.toISOString().slice(0, 10)}.spellings`;
}

/** True when the last export (ISO string) is missing or more than `weeks` weeks before `now`. */
export function exportReminderDue(lastExportISO, now = new Date(), weeks = REMINDER_WEEKS) {
  if (!lastExportISO) return true;
  const t = Date.parse(lastExportISO);
  if (Number.isNaN(t)) return true;
  return now.getTime() - t > weeks * 7 * 86400000;
}

/**
 * Hand the file to the OS share sheet when the browser can share files, else trigger a download.
 * Returns 'shared' | 'downloaded' | 'cancelled'. `env` = {navigator, document, URL} (injectable for tests).
 */
export async function deliverPack(bytes, filename, env = globalThis) {
  const file = new File([bytes], filename, { type: 'application/octet-stream' });
  const nav = env.navigator;
  if (nav && nav.canShare && nav.share && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: 'Spellings backup' });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled'; // user closed the sheet
      // any other failure: fall through to the plain download
    }
  }
  const url = env.URL.createObjectURL(file);
  const a = env.document.createElement('a');
  a.href = url;
  a.download = filename;
  env.document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => env.URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}
