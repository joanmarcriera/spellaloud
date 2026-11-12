// licence.js - Lemon Squeezy licence-key unlock, OFF by default (Vikunja #3536).
// Pure module, no DOM, no wiring into the UI yet. Nothing here runs unless the flag is on.
//
// Flow: the buyer pastes a key -> activateLicence() validates it ONCE against the Lemon Squeezy
// License API (POST /v1/licenses/activate, form-encoded, no API key needed) -> the result is cached
// on the device -> isUnlocked() reads only the cache, so the app works offline afterwards.
// The key itself is never logged. Product/store ids pin the key to OUR product (a key from another
// LS store must not unlock this app).
//
// Usage:
//   const cfg = { enabled: licenceEnabled(location.search, storage), ...LS_IDS };
//   const r = await activateLicence(key, cfg, { fetchImpl, storage, instanceName: 'Ash iPad' });
//   r.ok / r.reason ('disabled'|'empty'|'invalid'|'wrong_product'|'network'|'limit'|'storage'); isUnlocked(storage, cfg)

export const LS_ACTIVATE_URL = 'https://api.lemonsqueezy.com/v1/licenses/activate';
export const CACHE_KEY = 'spellings.licence.v1';
export const LS_VALIDATE_URL = 'https://api.lemonsqueezy.com/v1/licenses/validate';
export const REVALIDATE_EVERY_MS = 14 * 24 * 3600 * 1000;
export const FLAG_KEY = 'spellings.licence.enabled';

// The live Lemon Squeezy product this app sells (store 416615 "Marc Riera"): "Spellings Backup & Move pack",
// £2.99 one-off, licence keys with 5 activations (created 2026-11-04; catalogue: claude-config
// skills/riera-selfhost-ops/references/lemonsqueezy-catalog.md). Public values, not secrets.
export const LS_IDS = Object.freeze({ storeId: 416615, productId: 1500320 });
export const LS_BUY_URL = 'https://marcriera.lemonsqueezy.com/checkout/buy/0955f22b-be79-4868-9d11-ccf883f2f428';

/** Flag: ?licence=1 in the URL, or a stored opt-in. Anything else = off. Storage may throw (private mode). */
export function licenceEnabled(search = '', storage = null) {
  try { if (new URLSearchParams(search).get('licence') === '1') return true; } catch { /* ignore */ }
  try { return !!storage && storage.getItem(FLAG_KEY) === '1'; } catch { return false; }
}

/** Keep only plausible key characters (LS keys are UUIDs); trims pasted whitespace. */
export function normaliseKey(raw) {
  const k = String(raw == null ? '' : raw).trim();
  return /^[A-Za-z0-9-]{8,64}$/.test(k) ? k : '';
}

/** Enabled AND pinned to integer LS ids. Unset ids would make undefined === undefined unlock any key (#5442). */
function configured(cfg) {
  return !!cfg && !!cfg.enabled && Number.isInteger(cfg.storeId) && Number.isInteger(cfg.productId);
}

function readCache(storage) {
  try { const v = JSON.parse(storage.getItem(CACHE_KEY) || 'null'); return v && v.v === 1 ? v : null; } catch { return null; }
}

/** True when this device holds a cached activation for our product. Never touches the network. */
export function isUnlocked(storage, cfg) {
  if (!configured(cfg)) return false;
  const c = readCache(storage);
  return !!c && c.storeId === cfg.storeId && c.productId === cfg.productId;
}

/** Forget the activation on this device (does not deactivate it at LS). */
export function clearLicence(storage) { try { storage.removeItem(CACHE_KEY); } catch { /* ignore */ } }

export const FETCH_TIMEOUT_MS = 10000;

/** fetch with an AbortController deadline so a hung connection ends as a rejection ('network'). */
async function fetchWithTimeout(fetchImpl, url, opt, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await Promise.race([
      fetchImpl(url, { ...opt, signal: ctl.signal }),
      new Promise((_, rej) => ctl.signal.addEventListener('abort', () => rej(new Error('timeout')))),
    ]);
  } finally { clearTimeout(t); }
}

/** Validate once with Lemon Squeezy and cache the outcome. Returns {ok, reason?}. */
export async function activateLicence(rawKey, cfg, { fetchImpl, storage, instanceName = 'Spellings', now = () => new Date().toISOString(), timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  if (!configured(cfg)) return { ok: false, reason: 'disabled' };
  const key = normaliseKey(rawKey);
  if (!key) return { ok: false, reason: 'empty' };
  let data;
  try {
    const res = await fetchWithTimeout(fetchImpl, LS_ACTIVATE_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ license_key: key, instance_name: instanceName }).toString(),
    }, timeoutMs);
    // 429 / 5xx / any other non-2xx without an LS error body is "try again later", never "invalid key".
    // LS answers a real rejection (bad key, limit) with 4xx AND a JSON body carrying `error`.
    data = await res.json().catch(() => null);
    if (!res.ok && !(data && data.error)) return { ok: false, reason: 'network' };
  } catch { return { ok: false, reason: 'network' }; }
  if (!data || !data.activated) {
    const msg = String((data && data.error) || '').toLowerCase();
    return { ok: false, reason: msg.includes('limit') ? 'limit' : 'invalid' };
  }
  const meta = data.meta || {};
  if (meta.store_id !== cfg.storeId || meta.product_id !== cfg.productId) return { ok: false, reason: 'wrong_product' };
  const status = data.license_key && data.license_key.status;
  if (status && status !== 'active' && status !== 'inactive') return { ok: false, reason: 'invalid' };
  try {
    // `key` + `instanceId` are kept ONLY so revalidateLicence() can ask LS "still valid?" (the validate
    // endpoint needs the key; there is no key-less check). They stay in this device's own storage, are
    // never sent anywhere except api.lemonsqueezy.com and never logged. `tail` is for support.
    storage.setItem(CACHE_KEY, JSON.stringify({ v: 1, storeId: meta.store_id, productId: meta.product_id, tail: key.slice(-4),
      key, instanceId: (data.instance && data.instance.id) || null, at: now(), checkedAt: now() }));
  } catch { return { ok: false, reason: 'storage' }; }
  return { ok: true };
}

/**
 * Re-check a cached unlock with LS at most once per 14 days (refunded / disabled keys stop working).
 * Clears the cache ONLY when LS explicitly answers valid:false. Offline, 429, 5xx, timeouts, malformed
 * replies and legacy caches without a key all leave the unlock in place. Returns {state}:
 * 'skipped' (off / nothing cached / checked recently / no key), 'valid', 'revoked', 'network'.
 * Usage: call once at app start when online; ignore the result unless you want to show a notice.
 */
export async function revalidateLicence(cfg, { fetchImpl, storage, now = () => new Date().toISOString(), timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  if (!isUnlocked(storage, cfg)) return { state: 'skipped' };
  const c = readCache(storage);
  if (!c.key) return { state: 'skipped' };
  const last = Date.parse(c.checkedAt || c.at || '');
  // A checkedAt in the future (clock set wrong, edited storage) must not suppress revalidation: only a
  // timestamp inside [now - 14 days, now] counts as "checked recently" (#5531).
  const age = Date.parse(now()) - last;
  if (Number.isFinite(last) && age >= 0 && age < REVALIDATE_EVERY_MS) return { state: 'skipped' };
  let data;
  try {
    const params = { license_key: c.key };
    if (c.instanceId) params.instance_id = c.instanceId;
    const res = await fetchWithTimeout(fetchImpl, LS_VALIDATE_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    }, timeoutMs);
    data = await res.json().catch(() => null);
  } catch { return { state: 'network' }; }
  if (!data || typeof data.valid !== 'boolean') return { state: 'network' };
  const status = data.license_key && data.license_key.status;
  if (data.valid === false || status === 'expired' || status === 'disabled') { clearLicence(storage); return { state: 'revoked' }; }
  // Re-read after the await: the unlock may have been cleared or replaced while we waited (#5547).
  // Writing the stale `c` back would resurrect a cleared unlock or overwrite a newer activation.
  const cur = readCache(storage);
  if (!cur || cur.key !== c.key) return { state: 'skipped' };
  try { storage.setItem(CACHE_KEY, JSON.stringify({ ...cur, checkedAt: now() })); } catch { /* ignore */ }
  return { state: 'valid' };
}
