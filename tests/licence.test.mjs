// Tests for static/licence.js with a fake Lemon Squeezy (no network). Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { revalidateLicence, REVALIDATE_EVERY_MS, LS_VALIDATE_URL, licenceEnabled, normaliseKey, isUnlocked, activateLicence, clearLicence, CACHE_KEY, LS_ACTIVATE_URL } from '../static/licence.js';

const KEY = '00000000-test-0000-0000-000000000000';
const cfg = { enabled: true, storeId: 1, productId: 2 };
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m }; };
const fake = (body, calls = []) => async (url, opt) => { calls.push({ url, opt }); return { ok: true, status: 200, json: async () => body }; };
const good = { activated: true, error: null, instance: { id: 'inst-1' }, license_key: { status: 'active' }, meta: { store_id: 1, product_id: 2 } };

test('flag is off by default and on via URL or stored opt-in; a throwing storage is off', () => {
  assert.equal(licenceEnabled('', mem()), false);
  assert.equal(licenceEnabled('?licence=1', null), true);
  const s = mem(); s.setItem('spellings.licence.enabled', '1');
  assert.equal(licenceEnabled('', s), true);
  assert.equal(licenceEnabled('', { getItem() { throw new Error('private'); } }), false);
});

test('normaliseKey trims and rejects junk', () => {
  assert.equal(normaliseKey(`  ${KEY}\n`), KEY);
  assert.equal(normaliseKey('<script>'), '');
  assert.equal(normaliseKey(null), '');
});

test('disabled flag: no network call, nothing cached', async () => {
  const calls = []; const s = mem();
  const r = await activateLicence(KEY, { ...cfg, enabled: false }, { fetchImpl: fake(good, calls), storage: s });
  assert.deepEqual(r, { ok: false, reason: 'disabled' });
  assert.equal(calls.length, 0); assert.equal(s.m.size, 0);
});

test('good key: one POST, form-encoded, cached, unlocked offline afterwards, instance id cached', async () => {
  const calls = []; const s = mem();
  const r = await activateLicence(KEY, cfg, { fetchImpl: fake(good, calls), storage: s, instanceName: 'iPad', now: () => 'T' });
  assert.deepEqual(r, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, LS_ACTIVATE_URL);
  assert.equal(calls[0].opt.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.match(calls[0].opt.body, /license_key=00000000-test/);
  assert.equal(isUnlocked(s, cfg), true);
  assert.match(s.getItem(CACHE_KEY), /inst-1/); // instance id kept for revalidation
  assert.equal(isUnlocked(s, { ...cfg, enabled: false }), false);
  clearLicence(s); assert.equal(isUnlocked(s, cfg), false);
});

test('rejections: invalid, limit, wrong product, expired/disabled status, network error, bad input', async () => {
  const run = (body, fetchImpl) => activateLicence(KEY, cfg, { fetchImpl: fetchImpl || fake(body), storage: mem() });
  assert.equal((await run({ activated: false, error: 'license_key not found.' })).reason, 'invalid');
  assert.equal((await run({ activated: false, error: 'This license key has reached the activation limit.' })).reason, 'limit');
  assert.equal((await run({ ...good, meta: { store_id: 9, product_id: 2 } })).reason, 'wrong_product');
  assert.equal((await run({ ...good, license_key: { status: 'expired' } })).reason, 'invalid');
  assert.equal((await run(null, async () => { throw new Error('offline'); })).reason, 'network');
  assert.equal((await activateLicence('', cfg, { fetchImpl: fake(good), storage: mem() })).reason, 'empty');
});

test('a failed activation leaves an existing cache untouched and a full storage reports storage', async () => {
  const s = mem(); await activateLicence(KEY, cfg, { fetchImpl: fake(good), storage: s });
  await activateLicence(KEY, cfg, { fetchImpl: fake({ activated: false, error: 'x' }), storage: s });
  assert.equal(isUnlocked(s, cfg), true);
  const full = { getItem: () => null, setItem() { throw new Error('quota'); } };
  assert.equal((await activateLicence(KEY, cfg, { fetchImpl: fake(good), storage: full })).reason, 'storage');
});

const reply = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => { if (body === undefined) throw new Error('not json'); return body; } });

test('429 and 5xx without an error body are network (retry later), not invalid; cache untouched', async () => {
  for (const st of [429, 500, 502, 503]) {
    const s = mem();
    for (const body of [undefined, {}, null]) {
      const r = await activateLicence(KEY, cfg, { fetchImpl: reply(st, body), storage: s });
      assert.deepEqual(r, { ok: false, reason: 'network' }, `status ${st}`);
    }
    assert.equal(s.m.size, 0);
  }
});

test('a 4xx that carries an LS error body is still invalid / limit', async () => {
  const run = (body) => activateLicence(KEY, cfg, { fetchImpl: reply(404, body), storage: mem() });
  assert.equal((await run({ activated: false, error: 'license_key not found.' })).reason, 'invalid');
  assert.equal((await run({ activated: false, error: 'activation limit reached' })).reason, 'limit');
});

test('a hung fetch times out as network and is given an abort signal', async () => {
  let sig;
  const hang = (url, opt) => { sig = opt.signal; return new Promise(() => {}); };
  const r = await activateLicence(KEY, cfg, { fetchImpl: hang, storage: mem(), timeoutMs: 20 });
  assert.deepEqual(r, { ok: false, reason: 'network' });
  assert.equal(sig.aborted, true);
});

// --- revalidation (#5413) ---
const T0 = '2026-01-01T00:00:00.000Z';
const at = (days) => () => new Date(Date.parse(T0) + days * 86400000).toISOString();
const unlocked = async () => { const s = mem(); await activateLicence(KEY, cfg, { fetchImpl: fake(good), storage: s, now: () => T0 }); return s; };

test('revalidate: skipped when off, nothing cached, or checked < 14 days ago (no fetch)', async () => {
  const calls = []; const f = fake({ valid: true }, calls);
  assert.equal((await revalidateLicence({ ...cfg, enabled: false }, { fetchImpl: f, storage: mem() })).state, 'skipped');
  assert.equal((await revalidateLicence(cfg, { fetchImpl: f, storage: mem() })).state, 'skipped');
  const s = await unlocked();
  assert.equal((await revalidateLicence(cfg, { fetchImpl: f, storage: s, now: at(13) })).state, 'skipped');
  assert.equal(calls.length, 0);
  assert.equal(REVALIDATE_EVERY_MS, 14 * 86400000);
});

test('revalidate: due after 14 days posts key + instance id, valid keeps unlock and resets the clock', async () => {
  const calls = []; const s = await unlocked();
  const r = await revalidateLicence(cfg, { fetchImpl: fake({ valid: true, license_key: { status: 'active' } }, calls), storage: s, now: at(14) });
  assert.equal(r.state, 'valid');
  assert.equal(calls.length, 1); assert.equal(calls[0].url, LS_VALIDATE_URL);
  assert.match(calls[0].opt.body, /license_key=00000000-test/); assert.match(calls[0].opt.body, /instance_id=inst-1/);
  assert.equal(isUnlocked(s, cfg), true);
  assert.equal((await revalidateLicence(cfg, { fetchImpl: fake({ valid: true }, calls), storage: s, now: at(20) })).state, 'skipped');
  assert.equal(calls.length, 1);
});

test('revalidate: a future-dated checkedAt does not suppress revalidation (#5531)', async () => {
  const calls = []; const s = await unlocked();
  const c = JSON.parse(s.getItem(CACHE_KEY)); c.checkedAt = new Date(Date.parse(T0) + 400 * 86400000).toISOString();
  s.setItem(CACHE_KEY, JSON.stringify(c));
  const r = await revalidateLicence(cfg, { fetchImpl: fake({ valid: true }, calls), storage: s, now: at(1) });
  assert.equal(r.state, 'valid'); assert.equal(calls.length, 1);
  assert.equal(JSON.parse(s.getItem(CACHE_KEY)).checkedAt, at(1)()); // clock repaired
});

test('revalidate: unlock cleared while the check is in flight is not resurrected (#5547)', async () => {
  const s = await unlocked();
  const f = async () => { clearLicence(s); return { ok: true, status: 200, json: async () => ({ valid: true }) }; };
  const r = await revalidateLicence(cfg, { fetchImpl: f, storage: s, now: at(15) });
  assert.equal(r.state, 'skipped'); assert.equal(s.getItem(CACHE_KEY), null); assert.equal(isUnlocked(s, cfg), false);
});

test('revalidate: explicit valid:false (refund) clears the unlock, even on a 404', async () => {
  const s = await unlocked();
  const r = await revalidateLicence(cfg, { fetchImpl: reply(404, { valid: false, error: 'license_key not found.' }), storage: s, now: at(15) });
  assert.equal(r.state, 'revoked'); assert.equal(isUnlocked(s, cfg), false);
  const s2 = await unlocked();
  assert.equal((await revalidateLicence(cfg, { fetchImpl: fake({ valid: true, license_key: { status: 'disabled' } }), storage: s2, now: at(15) })).state, 'revoked');
  assert.equal(isUnlocked(s2, cfg), false);
});

test('revalidate: 429, 5xx, bad body, offline and timeout never lock a paying user out', async () => {
  const cases = [reply(429, {}), reply(500, undefined), reply(503, { error: 'x' }), fake(null), async () => { throw new Error('offline'); }, () => new Promise(() => {})];
  for (const f of cases) {
    const s = await unlocked();
    const r = await revalidateLicence(cfg, { fetchImpl: f, storage: s, now: at(30), timeoutMs: 20 });
    assert.equal(r.state, 'network'); assert.equal(isUnlocked(s, cfg), true);
  }
});

test('revalidate: legacy cache without a key is skipped, not cleared', async () => {
  const s = mem(); s.setItem(CACHE_KEY, JSON.stringify({ v: 1, storeId: 1, productId: 2, tail: 'x', at: T0 }));
  assert.equal((await revalidateLicence(cfg, { fetchImpl: fake({ valid: false }), storage: s, now: at(99) })).state, 'skipped');
  assert.equal(isUnlocked(s, cfg), true);
});

// #5442: unset/non-integer store or product ids must never unlock (undefined === undefined trap).
test('unset ids: meta-less response is refused as disabled, nothing cached, not unlocked', async () => {
  for (const bad of [{ enabled: true }, { enabled: true, storeId: 1 }, { enabled: true, storeId: '1', productId: '2' }, { enabled: true, storeId: NaN, productId: 2 }]) {
    const calls = []; const s = mem();
    const metaless = { activated: true, error: null, instance: { id: 'i' }, license_key: { status: 'active' } };
    const r = await activateLicence(KEY, bad, { fetchImpl: fake(metaless, calls), storage: s });
    assert.deepEqual(r, { ok: false, reason: 'disabled' });
    assert.equal(calls.length, 0); assert.equal(s.m.size, 0);
    assert.equal(isUnlocked(s, bad), false);
  }
});

test('a cache holding undefined ids does not unlock under a half-empty config', () => {
  const s = mem(); s.setItem(CACHE_KEY, JSON.stringify({ v: 1, key: KEY }));
  assert.equal(isUnlocked(s, { enabled: true }), false);
  assert.equal(isUnlocked(s, { enabled: true, storeId: 1 }), false);
});
