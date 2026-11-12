// Tests for the pure report builder of the iOS probe (tools/ios-pwa-probe/report.js, Vikunja #4060).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildReport, runCheck, validateWav, tally } from '../tools/ios-pwa-probe/report.js';
import { encodeWav } from '../static/lib.js';

test('runCheck turns a throw into a fail with the message', async () => {
  const r = await runCheck('x', 'X', () => { throw new Error('NotAllowedError'); });
  assert.deepEqual([r.status, r.detail], ['fail', 'NotAllowedError']);
});

test('runCheck defaults to pass and honours ok:false and explicit skip', async () => {
  assert.equal((await runCheck('a', 'A', async () => ({}))).status, 'pass');
  assert.equal((await runCheck('a', 'A', async () => ({ ok: false }))).status, 'fail');
  assert.equal((await runCheck('a', 'A', async () => ({ status: 'skip' }))).status, 'skip');
});

test('validateWav accepts lib.js encodeWav output at 22.05 kHz and rejects other rates and truncation', () => {
  const w = new Uint8Array(encodeWav(new Float32Array(2205), 22050));
  assert.equal(validateWav(w).ok, true);
  assert.equal(validateWav(w).samples, 2205);
  assert.match(validateWav(new Uint8Array(encodeWav(new Float32Array(100), 44100))).reason, /sample rate 44100/);
  assert.equal(validateWav(w.slice(0, w.length - 2)).ok, false);
  assert.equal(validateWav(new Uint8Array(10)).ok, false);
});

test('buildReport: mode, verdict and tally; skips do not block', () => {
  const rs = [{ id: 'a', title: 'A', status: 'pass', detail: '' }, { id: 'b', title: 'B', status: 'skip', detail: 'n/a' }];
  const rep = buildReport({ standalone: true, userAgent: 'UA', platform: 'ios', secureContext: true, when: 't' }, rs);
  assert.equal(rep.mode, 'home-screen');
  assert.equal(rep.summary.verdict, 'ok');
  assert.deepEqual(tally(rs), { pass: 1, fail: 0, skip: 1 });
  const bad = buildReport({}, [...rs, { id: 'c', title: 'C', status: 'fail', detail: 'x' }]);
  assert.equal(bad.mode, 'safari-tab');
  assert.equal(bad.summary.verdict, 'blocked');
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(bad)));
});

test('probe page makes no third-party requests and uses no HTML sinks', () => {
  for (const f of ['index.html', 'probe.js', 'report.js']) {
    const src = readFileSync(new URL(`../tools/ios-pwa-probe/${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /https?:\/\/(?!localhost)/, `${f} references an external URL`);
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|fetch\(|XMLHttpRequest|sendBeacon/, `${f} has a sink or network call`);
  }
});
