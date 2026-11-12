// Unknown ?kid=<slug> on the public (browser-only) build: a friendly "set up here" screen instead of the error
// screen (Marc 2026-11-08: the kiosk tiles open ?kid=ash and ?kid=finn on a tablet that holds neither child).
// The family build seeds its kids and must behave exactly as before. Run with `node --test tests/`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStore, memoryBackend } from '../static/store.js';
import { localTransport } from '../static/transport.js';
import { kidSetupPlan, setUpKid, titleCaseSlug, SETUP_YEAR } from '../static/kidsetup.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
/** A real local store (the same code the public build runs) and its api(method, path, body). */
const open = async () => {
  const store = await createStore(memoryBackend(), { today: '2026-11-09', speechFallback: true });
  const t = localTransport(store);
  return { api: (m, p, b) => t.api(m, p, b), t };
};

test('title-casing a slug gives the display name', () => {
  assert.equal(titleCaseSlug('ash'), 'Ash');
  assert.equal(titleCaseSlug('finn'), 'Finn');
  assert.equal(titleCaseSlug('mary-jane'), 'Mary Jane');
  assert.equal(titleCaseSlug(''), 'Child');
});

test('plan: the name comes from ?name= when it slugifies to the requested slug, else from the slug', () => {
  assert.equal(kidSetupPlan('ash', 'Ash', []).name, 'Ash');
  assert.equal(kidSetupPlan('ash', null, []).name, 'Ash');
  assert.equal(kidSetupPlan('finn', '  Finn ', []).name, 'Finn');
  assert.equal(kidSetupPlan('ash', 'Bob', []).name, 'Ash', 'a name that would give another slug is ignored');
  assert.equal(kidSetupPlan('ash', 'A'.repeat(31), []).name, 'Ash', 'too long for the store: ignored');
  assert.equal(kidSetupPlan('mary-jane', 'Mary Jane', []).name, 'Mary Jane');
  assert.equal(kidSetupPlan('mary-jane', null, []).name, 'Mary Jane');
});

test('plan: lists the other children on the device', () => {
  const kids = [{ slug: 'ann', name: 'Ann' }, { slug: 'bo', name: 'Bo' }];
  assert.deepEqual(kidSetupPlan('ash', null, kids).others.map((k) => k.slug), ['ann', 'bo']);
  assert.deepEqual(kidSetupPlan('ash', null, []).others, []);
});

test('plan: a differently-cased slug of an existing child points at that child instead of making a twin', () => {
  const plan = kidSetupPlan('Ash', null, [{ slug: 'ash', name: 'Ash' }]);
  assert.equal(plan.existing.slug, 'ash');
  assert.equal(kidSetupPlan('ash', null, [{ slug: 'finn', name: 'Finn' }]).existing, null);
});

test('creating the child on an empty device gives exactly the requested slug, for both kiosk tiles', async () => {
  const { api } = await open();
  for (const [slug, name] of [['ash', 'Ash'], ['finn', 'Finn']]) {
    const kid = await setUpKid(api, kidSetupPlan(slug, name, await api('GET', '/api/kids')));
    assert.equal(kid.slug, slug);
    assert.equal(kid.name, name);
    assert.equal(kid.year, SETUP_YEAR);
  }
  assert.deepEqual((await api('GET', '/api/kids')).map((k) => k.slug), ['ash', 'finn']);
  // the child page's own call now works, with no words yet
  const me = await api('GET', '/api/me?kid=finn');
  assert.equal(me.kid.slug, 'finn');
  assert.deepEqual((await api('GET', '/api/kids/finn/practice?mode=week')).words, []);
});

test('before setup the child page call fails exactly as the error screen saw it', async () => {
  const { api } = await open();
  await api('POST', '/api/kids', { name: 'Ann', year: 2 });
  await assert.rejects(api('GET', '/api/me?kid=ash'), /unknown kid/);
});

test('a second tap (or a second tab) never creates a twin: the existing child is returned', async () => {
  const { api } = await open();
  const plan = kidSetupPlan('ash', 'Ash', []);
  const [a, b] = [await setUpKid(api, plan), await setUpKid(api, plan)];
  assert.equal(a.slug, 'ash');
  assert.equal(b.slug, 'ash');
  assert.equal((await api('GET', '/api/kids')).length, 1);
});

test('a slug that is not clean still ends up on the child that was made, and its name is shown', async () => {
  const { api } = await open();
  const kid = await setUpKid(api, kidSetupPlan('Ash!', null, []));
  assert.equal(kid.slug, 'ash');
  assert.equal(kid.name, 'Ash');
});

// ---- wiring in app.js (the app cannot be imported without a DOM, so these read the source, like the other wiring tests)
const app = read('../static/app.js');
const pick = app.slice(app.indexOf('async function pickKid'));

test('family build: pickKid returns before the new branch and kidsetup.js is never imported statically', () => {
  assert.match(pick, /if \(t\.mode !== 'local'\) return true;/);
  assert.ok(pick.indexOf("t.mode !== 'local'") < pick.indexOf('unknownKid'), 'the mode guard comes first');
  assert.doesNotMatch(app, /^import .*kidsetup/m);
  assert.match(pick, /await import\('\.\/kidsetup\.js'\)/);
});

test('local build: a ?kid= with no such child shows the setup screen instead of falling through to loadMe', () => {
  assert.match(pick, /kids\.some\(\(k\) => k\.slug === kidParam\)/);
  assert.match(pick, /return false;[^]*return false;/);
});

test('the setup screen is accessible and uses the existing patterns', () => {
  const screen = app.slice(app.indexOf('function unknownKidScreen'), app.indexOf('async function pickKid'));
  assert.ok(screen.length > 400, 'screen found');
  assert.match(screen, /role: 'alert'/, 'a failure is announced');
  assert.match(screen, /\.focus\(\)/, 'focus lands on the primary button');
  assert.match(screen, /Set up \$\{plan\.name\} here/);
  assert.match(screen, /isn't set up on this tablet yet/);
  assert.match(screen, /saved on this device only/i);
  assert.match(screen, /href: '\/parent'[^]*Grown-ups/);
  assert.match(screen, /Or play as/);
  assert.match(screen, /btn\.disabled = true/, 'one tap = one child');
  assert.doesNotMatch(screen, /innerHTML|insertAdjacentHTML/);
});

test('after setup the Home screen of a word-less child guides a grown-up to add words (local build only)', () => {
  assert.match(app, /localBuild/);
  assert.match(app, /Add words/);
  assert.match(app, /href: '\/parent'/);
});

test('no third-party request is introduced', () => {
  const src = read('../static/kidsetup.js');
  assert.doesNotMatch(src, /https?:\/\//);
  assert.doesNotMatch(src, /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket)\s*\(/);
});
