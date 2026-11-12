// durability.js - honest storage for a browser-only app (Vikunja #3533).
// Everything lives in IndexedDB on one device, and a browser may delete it: Safari wipes script-writable
// storage after 7 days without use unless the site is installed to the Home Screen, and "clear site
// data" removes it at any time. This module (a) asks the browser for persistent storage, (b) works out
// what to tell the parent, and (c) works out whether an install nudge or export reminder is due.
// Pure decisions take plain values; the two `request*` helpers take the browser objects as arguments
// so node tests can pass fakes. The nudge text is for the PARENT area only, never the kid screens.

import { exportReminderDue } from './pack.js';

/** Ask for persistent storage. Returns {supported, persisted, usage, quota}. Never throws. */
export async function requestPersistence(storage = globalThis.navigator && globalThis.navigator.storage) {
  const out = { supported: false, persisted: false, usage: null, quota: null };
  if (!storage || !storage.persist) return out;
  out.supported = true;
  try {
    out.persisted = (await storage.persisted()) || (await storage.persist());
  } catch { out.persisted = false; }
  try {
    if (storage.estimate) {
      const e = await storage.estimate();
      out.usage = e.usage ?? null;
      out.quota = e.quota ?? null;
    }
  } catch { /* estimate is optional */ }
  return out;
}

/** True when running as an installed app (display-mode standalone, or iOS navigator.standalone). */
export function isInstalled(win = globalThis) {
  try {
    if (win.matchMedia && win.matchMedia('(display-mode: standalone)').matches) return true;
    if (win.navigator && win.navigator.standalone === true) return true;
  } catch { /* ignore */ }
  return false;
}

/** Rough platform detection for the install instructions. */
export function platformOf(ua = '', maxTouchPoints = 0) {
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

/**
 * Decide what the parent area shows. Returns an array of notices, most important first:
 *   {id:'install'|'persist'|'export', level:'warn'|'info', text}
 * state = {persisted, installed, platform, lastExport (ISO|null), hasData (bool), now}
 */
export function storageNotices(state) {
  const notices = [];
  const { persisted, installed, platform, lastExport, hasData = true, now = new Date() } = state;
  if (platform === 'ios' && !installed) {
    notices.push({ id: 'install', level: 'warn',
      text: 'Safari deletes this app’s data after 7 days without use unless it is added to your Home Screen. ' +
        'Tap Share, then “Add to Home Screen”, and open it from there. Or export a backup file.' });
  } else if (!installed && !persisted) {
    notices.push({ id: 'install', level: 'info',
      text: 'Install this app (browser menu, “Install app” or “Add to Home Screen”) so the browser is less likely to clear your data.' });
  }
  if (!persisted && !(platform === 'ios' && !installed)) {
    notices.push({ id: 'persist', level: 'info',
      text: 'Your browser has not promised to keep this data. Clearing site data would remove all words and recordings, so export a backup now and then.' });
  }
  if (hasData && exportReminderDue(lastExport, now)) {
    notices.push({ id: 'export', level: 'warn',
      text: lastExport ? 'It has been over 4 weeks since your last backup. Export a file to your phone.' : 'You have not made a backup file yet. Export one to your phone.' });
  }
  return notices;
}
