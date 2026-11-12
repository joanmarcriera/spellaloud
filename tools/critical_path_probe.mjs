#!/usr/bin/env node
// Critical-path browser probe (Vikunja #5603). Dev-only: nothing here ships to the site.
//
// Usage:  node tools/critical_path_probe.mjs
// What:   builds the browser-only app with bin/build-local into a temp dir, serves it on 127.0.0.1 (python http.server,
//         always killed), and drives it in headless Chromium through six paths, printing one "OK <path>" line each:
//           add-child-and-week   add a child and a three-word week on /parent
//           record-clip          hold-to-talk on the kid app with a fake media stream; the word gets a recording
//           persist-reload       reload the kid app and the parent page; child, words and clip are still there
//           voice-fallback       with a fake en-GB voice present it can be picked and is saved; with none, the picker is
//                                disabled and the note says recordings are used
//           export               "Export <child>" downloads a .spellings file
//           erase-import         erase everything, import that file, and the parent page matches what it showed before
//         WebKit is tried for a load check (printed as WEBKIT-OK, not an OK line); if it is not installed the line
//         says SKIP-WEBKIT.
// Needs:  playwright-core (resolved from PLAYWRIGHT_CORE, node_modules, or a cached npx install) and its browsers.
//         Exits 0 only if all six paths pass; the first failure prints FAIL <path> and exits 1.
// Network: only 127.0.0.1. No deploy, no POST to anything outside the local build.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
export const PATHS = ['add-child-and-week', 'record-clip', 'persist-reload', 'voice-fallback', 'export', 'erase-import'];

/** Find playwright-core: env override, normal resolution, then any cached npx install. */
function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const candidates = [process.env.PLAYWRIGHT_CORE, 'playwright-core', 'playwright'].filter(Boolean);
  const npx = join(homedir(), '.npm', '_npx');
  if (existsSync(npx)) {
    for (const d of readdirSync(npx)) candidates.push(join(npx, d, 'node_modules', 'playwright-core'));
  }
  let first = null;
  for (const c of candidates) {
    try {
      const pw = req(c);
      first = first || pw;
      // each playwright-core wants one browser revision; take the first whose browser is actually installed
      if (existsSync(pw.chromium.executablePath())) return pw;
    } catch { /* try the next */ }
  }
  if (first) return first;
  throw new Error('playwright-core not found: set PLAYWRIGHT_CORE=/path/to/playwright-core');
}

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  s.on('error', rej);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitListening(port) {
  for (let i = 0; i < 50; i++) {
    const ok = await new Promise((res) => {
      const c = createServer(); // cheap probe: if we can bind the port, nobody listens yet
      c.once('error', () => res(true));
      c.listen(port, '127.0.0.1', () => c.close(() => res(false)));
    });
    if (ok) return;
    await sleep(100);
  }
  throw new Error('local server did not start');
}

/** Init script: no share sheet (force the download path) and, optionally, a fake en-GB speech voice. */
const noShare = () => { try { delete Navigator.prototype.share; delete Navigator.prototype.canShare; } catch { /* ignore */ } };
const fakeVoice = () => {
  const voices = [{ name: 'Probe British Voice', lang: 'en-GB', localService: true, default: false, voiceURI: 'probe' }];
  const fake = { getVoices: () => voices, addEventListener() {}, removeEventListener() {}, speak() {}, cancel() {} };
  Object.defineProperty(window, 'speechSynthesis', { value: fake, configurable: true });
};
const noVoice = () => {
  const fake = { getVoices: () => [], addEventListener() {}, removeEventListener() {}, speak() {}, cancel() {} };
  Object.defineProperty(window, 'speechSynthesis', { value: fake, configurable: true });
};

function check(cond, msg) { if (!cond) throw new Error(msg); }

async function main() {
  const pw = loadPlaywright();
  const tmp = mkdtempSync(join(tmpdir(), 'probe-'));
  const dist = join(tmp, 'dist-local');
  let server = null, browser = null;
  const used = [];
  let failed = null;
  try {
    const b = spawnSync('python3', ['bin/build-local', '--out', dist], { cwd: root, encoding: 'utf8' });
    check(b.status === 0, 'bin/build-local failed: ' + b.stdout + b.stderr);
    const port = await freePort();
    server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', dist], { stdio: 'ignore' });
    await waitListening(port);
    const base = `http://127.0.0.1:${port}`;

    browser = await pw.chromium.launch({
      headless: true,
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    });
    used.push('chromium ' + browser.version());
    const ctx = await browser.newContext({ permissions: ['microphone'], acceptDownloads: true, locale: 'en-GB' });
    await ctx.addInitScript(noShare);
    await ctx.addInitScript(noVoice);
    const page = await ctx.newPage();
    page.on('dialog', (d) => d.accept());
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const words = ['because', 'friend', 'people'];
    const run = async (name, fn) => {
      try { await fn(); console.log(`OK ${name}`); }
      catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed = name; throw e; }
    };

    // 1. add a child and a three-word week
    await run('add-child-and-week', async () => {
      await page.goto(base + '/parent', { waitUntil: 'networkidle' });
      await page.getByLabel('Child name').fill('Probe');
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await page.getByLabel('Words').waitFor({ timeout: 5000 });
      await page.getByLabel('Words').fill(words.join('\n'));
      await page.getByRole('button', { name: 'Add week' }).click();
      await page.waitForFunction((n) => document.querySelectorAll('input[aria-label="Word"]').length === n, words.length, { timeout: 5000 });
      const got = await page.$$eval('input[aria-label="Word"]', (els) => els.map((e) => e.value));
      check(JSON.stringify(got) === JSON.stringify(words), 'words saved as ' + got);
    });
    const parentSnapshot = () => page.$eval('#kids', (el) => [...el.querySelectorAll('h2,h3,input[aria-label="Word"]')].map((e) => e.value ?? e.textContent).join('|'));
    const before = await parentSnapshot();

    // 2. record a clip with the fake media stream
    await run('record-clip', async () => {
      await page.goto(base + '/?kid=probe', { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: /Record words/ }).click();
      const hold = page.getByRole('button', { name: 'Hold to talk' });
      await hold.waitFor({ timeout: 5000 });
      const box = await hold.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await sleep(1800);
      await page.mouse.up();
      await page.getByText(/Listen\.\.\.|Good! Again or next\?|Saved\. Again or next\?/).first().waitFor({ timeout: 10000 });
      await page.getByRole('button', { name: 'Next' }).waitFor({ timeout: 5000 });
      const has = await page.$$eval('.dots .dot.has', (e) => e.length);
      check(has === 1, `expected 1 recorded dot, saw ${has}`);
    });

    // 3. reload: child, words and clip survive
    await run('persist-reload', async () => {
      await page.goto(base + '/?kid=probe', { waitUntil: 'networkidle' });
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByRole('button', { name: /Record words/ }).click();
      await page.getByRole('button', { name: 'Hold to talk' }).waitFor({ timeout: 5000 });
      check((await page.$$eval('.dots .dot.has', (e) => e.length)) === 1, 'clip lost after reload');
      await page.goto(base + '/parent', { waitUntil: 'networkidle' });
      await page.getByLabel('Word').first().waitFor({ timeout: 5000 });
      check((await parentSnapshot()) === before, 'parent page differs after reload');
    });

    // 4. voice picker with a fake en-GB voice, then the no-voice fallback
    await run('voice-fallback', async () => {
      const vctx = await browser.newContext({ locale: 'en-GB' });
      await vctx.addInitScript(fakeVoice);
      const vp = await vctx.newPage();
      await vp.goto(base + '/parent', { waitUntil: 'networkidle' });
      await vp.getByLabel('Child name').fill('Voicey');
      await vp.getByRole('button', { name: 'Add', exact: true }).click();
      // KNOWN DEFECT (see #5603 evidence): the picker is not repainted after "Add a child"; it shows after a reload.
      await vp.getByLabel('Words').waitFor({ timeout: 5000 }); // the child has been saved and drawn; only then reload
      await vp.reload({ waitUntil: 'networkidle' });
      const sel = vp.locator('#vk-voicey');
      await sel.waitFor({ timeout: 5000 });
      await vp.waitForFunction(() => document.querySelector('#vk-voicey option[value="Probe British Voice"]'), null, { timeout: 5000 });
      await sel.selectOption('Probe British Voice');
      await vp.getByText('Voice saved for Voicey').waitFor({ timeout: 5000 });
      await vp.reload({ waitUntil: 'networkidle' });
      await vp.waitForFunction(() => document.querySelector('#vk-voicey')?.value === 'Probe British Voice', null, { timeout: 5000 });
      await vctx.close();
      // no voice on this device (the main context): picker disabled, note says recordings are used
      await page.goto(base + '/parent', { waitUntil: 'networkidle' });
      await page.waitForSelector('#vk-probe');
      check(await page.locator('#vk-probe').isDisabled(), 'picker should be disabled with no voice');
      check(/no British voice.*recordings/.test(await page.textContent('#vnote')), 'fallback note missing');
    });

    // 5. export
    let exported = null;
    await run('export', async () => {
      const dl = page.waitForEvent('download', { timeout: 10000 });
      await page.getByRole('button', { name: 'Export Probe' }).click();
      const d = await dl;
      check(/\.spellings$/.test(d.suggestedFilename()), 'unexpected file name ' + d.suggestedFilename());
      exported = join(tmp, d.suggestedFilename());
      await d.saveAs(exported);
      check(readFileSync(exported).length > 100, 'export file is empty');
    });

    // 6. erase everything, import, compare
    await run('erase-import', async () => {
      await page.getByRole('button', { name: /Erase everything on this device/ }).click();
      await page.locator('#erase-confirm').click();
      // KNOWN DEFECT (see #5603 evidence): the "erased" / "Imported." messages are wiped when the panel repaints,
      // so the probe checks the data, not the message.
      await page.waitForFunction(() => !document.querySelector('input[aria-label="Word"]'), null, { timeout: 5000 });
      await page.goto(base + '/parent', { waitUntil: 'networkidle' });
      check((await page.$$('input[aria-label="Word"]')).length === 0, 'data still present after erase');
      await page.getByLabel('Backup file').setInputFiles(exported);
      await page.getByLabel('How to import').selectOption('replace');
      await page.getByRole('button', { name: 'Import', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('input[aria-label="Word"]'), null, { timeout: 10000 });
      await page.goto(base + '/parent', { waitUntil: 'networkidle' });
      await page.getByLabel('Word').first().waitFor({ timeout: 5000 });
      check((await parentSnapshot()) === before, 'imported data differs from before');
      await page.goto(base + '/?kid=probe', { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: /Record words/ }).click();
      await page.getByRole('button', { name: 'Hold to talk' }).waitFor({ timeout: 5000 });
      check((await page.$$eval('.dots .dot.has', (e) => e.length)) === 1, 'clip missing after import');
    });
    check(errors.length === 0, 'page errors: ' + errors.join('; '));
    await browser.close(); browser = null;

    // WebKit: load check only (it has no fake media stream)
    try {
      const wk = await pw.webkit.launch({ headless: true });
      used.push('webkit ' + wk.version());
      const wp = await wk.newPage();
      await wp.goto(base + '/parent', { waitUntil: 'networkidle' });
      await wp.getByLabel('Child name').waitFor({ timeout: 5000 });
      await wk.close();
      console.log('WEBKIT-OK parent page loads');
    } catch (e) {
      console.log(/Executable doesn't exist|not installed|browserType\.launch/.test(e.message) ? 'SKIP-WEBKIT' : 'SKIP-WEBKIT (' + e.message.split('\n')[0] + ')');
    }
  } catch (e) {
    if (!failed) console.log('FAIL setup: ' + e.message);
    failed = failed || 'setup';
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.kill();
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log('browsers: ' + (used.join(', ') || 'none'));
  process.exit(failed ? 1 : 0);
}

main();
