// report.js - pure report builder for the iOS Safari probe (Vikunja #4060). No DOM, no network: node tests cover it.
// A check result is {id, title, status: 'pass'|'fail'|'skip', detail?, data?}. buildReport() turns a list of them
// plus environment facts into the JSON that the "copy report" button puts on the clipboard.
// The report holds only capability facts (support flags, byte counts, voice names). No recordings, no words, no names.

export const STATUSES = ['pass', 'fail', 'skip'];

/** Run one check function, never throwing: an exception becomes a 'fail' with the message as detail. */
export async function runCheck(id, title, fn) {
  try {
    const r = (await fn()) || {};
    const status = STATUSES.includes(r.status) ? r.status : (r.ok === false ? 'fail' : 'pass');
    return { id, title, status, detail: r.detail ?? '', data: r.data ?? null };
  } catch (e) {
    return { id, title, status: 'fail', detail: String((e && e.message) || e), data: null };
  }
}

/** Is a byte array a valid mono 16-bit 22.05 kHz WAV (RIFF/WAVE, PCM, data length consistent)? Returns {ok, reason}. */
export function validateWav(bytes, { rate = 22050 } = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 44) return { ok: false, reason: 'shorter than a 44-byte header' };
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return { ok: false, reason: 'not RIFF/WAVE' };
  if (tag(12) !== 'fmt ' || tag(36) !== 'data') return { ok: false, reason: 'unexpected chunk layout' };
  if (dv.getUint16(20, true) !== 1) return { ok: false, reason: 'not PCM' };
  if (dv.getUint16(22, true) !== 1) return { ok: false, reason: 'not mono' };
  if (dv.getUint32(24, true) !== rate) return { ok: false, reason: `sample rate ${dv.getUint32(24, true)} != ${rate}` };
  if (dv.getUint16(34, true) !== 16) return { ok: false, reason: 'not 16-bit' };
  const dataLen = dv.getUint32(40, true);
  if (dataLen === 0 || 44 + dataLen !== b.length) return { ok: false, reason: `data length ${dataLen} does not match file size ${b.length}` };
  return { ok: true, reason: '', samples: dataLen / 2 };
}

/** Summary line counts. */
export function tally(results) {
  const t = { pass: 0, fail: 0, skip: 0 };
  for (const r of results) t[r.status] = (t[r.status] || 0) + 1;
  return t;
}

/**
 * Build the JSON report. env: {userAgent, standalone, platform, secureContext, when}; results: check results.
 * verdict is 'ok' only if nothing failed; skips are listed but do not fail the run (they mean "could not test").
 */
export function buildReport(env, results) {
  const t = tally(results);
  return {
    probe: 'spellings-ios-pwa-probe/1',
    when: env.when || null,
    mode: env.standalone ? 'home-screen' : 'safari-tab',
    env: {
      userAgent: env.userAgent || '',
      platform: env.platform || 'unknown',
      secureContext: !!env.secureContext,
      standalone: !!env.standalone,
    },
    summary: { ...t, verdict: t.fail === 0 ? 'ok' : 'blocked' },
    checks: results.map((r) => ({ id: r.id, title: r.title, status: r.status, detail: r.detail, data: r.data })),
  };
}
