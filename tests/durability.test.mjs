// Tests for static/durability.js (run: node --test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { requestPersistence, isInstalled, platformOf, storageNotices } from '../static/durability.js';

test('requestPersistence: unsupported browser', async () => {
  assert.deepEqual(await requestPersistence(null), { supported: false, persisted: false, usage: null, quota: null });
  assert.equal((await requestPersistence({})).supported, false);
});

test('requestPersistence: granted, already persisted, denied, throwing', async () => {
  let asked = 0;
  const mk = (persisted, grant) => ({ persisted: async () => persisted, persist: async () => { asked++; return grant; }, estimate: async () => ({ usage: 5, quota: 100 }) });
  assert.deepEqual(await requestPersistence(mk(false, true)), { supported: true, persisted: true, usage: 5, quota: 100 });
  assert.equal(asked, 1);
  assert.equal((await requestPersistence(mk(true, false))).persisted, true);
  assert.equal(asked, 1, 'does not re-ask when already persisted');
  assert.equal((await requestPersistence(mk(false, false))).persisted, false);
  const boom = { persisted: async () => { throw new Error('x'); }, persist: async () => true };
  assert.deepEqual(await requestPersistence(boom), { supported: true, persisted: false, usage: null, quota: null });
});

test('isInstalled and platformOf', () => {
  assert.equal(isInstalled({ matchMedia: () => ({ matches: true }) }), true);
  assert.equal(isInstalled({ matchMedia: () => ({ matches: false }), navigator: { standalone: true } }), true);
  assert.equal(isInstalled({}), false);
  assert.equal(platformOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'ios');
  assert.equal(platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5), 'ios', 'iPadOS pretends to be a Mac');
  assert.equal(platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0), 'desktop');
  assert.equal(platformOf('Mozilla/5.0 (Linux; Android 13)'), 'android');
});

const now = new Date('2026-11-14T00:00:00Z');
const ids = (s) => storageNotices({ now, hasData: true, lastExport: '2026-11-10T00:00:00Z', ...s }).map((n) => n.id);

test('iOS Safari not installed: install warning, even if persist() claimed success', () => {
  const n = storageNotices({ persisted: true, installed: false, platform: 'ios', lastExport: '2026-11-10T00:00:00Z', now });
  assert.equal(n[0].id, 'install'); assert.equal(n[0].level, 'warn'); assert.match(n[0].text, /7 days/);
});
test('installed + persisted + recent export: no notices', () => assert.deepEqual(ids({ persisted: true, installed: true, platform: 'ios' }), []));
test('android browser tab without persistence: install hint then persist note', () => assert.deepEqual(ids({ persisted: false, installed: false, platform: 'android' }), ['install', 'persist']));
test('export reminder: only with data, and wording differs for never vs stale', () => {
  assert.deepEqual(ids({ persisted: true, installed: true, platform: 'desktop', lastExport: '2026-09-01T00:00:00Z' }), ['export']);
  assert.deepEqual(ids({ persisted: true, installed: true, platform: 'desktop', lastExport: null, hasData: false }), []);
  const n = storageNotices({ persisted: true, installed: true, platform: 'desktop', lastExport: null, now });
  assert.match(n[0].text, /not made a backup/);
});
