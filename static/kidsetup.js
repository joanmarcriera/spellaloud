// kidsetup.js - "this child is not on this device yet" for the browser-only (local) build.
// The public build keeps children in the browser's storage, so a bookmark such as /?kid=ash on a fresh
// tablet names a child that does not exist. app.js shows a set-up screen (unknownKidScreen) built from the
// plan below instead of the generic error. Loaded only in local mode and only when the child is missing;
// the family build seeds its kids and never imports this file. Pure and DOM-free so it is unit-tested.
//
// Usage:  const plan = kidSetupPlan(slug, nameParam, kids);   // kids = GET /api/kids
//         const kid = await setUpKid(api, plan);              // api(method, path, body); kid.slug is where to go
import { slugify } from './store.js';

const MAX_NAME = 30; // the store's limit on a child's name (kidAdd)

/** Year given to a child made from a bookmark. The grown-up can change it on /parent (rename / year, #6329). */
export const SETUP_YEAR = 2;

/** 'mary-jane' -> 'Mary Jane'; anything with no letters or digits -> 'Child'. */
export function titleCaseSlug(slug) {
  const words = String(slug).split(/[^a-z0-9]+/i).filter(Boolean);
  return words.length ? words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') : 'Child';
}

/**
 * What the set-up screen needs. `name` is ?name= when it is a usable display name for exactly this slug
 * (so the created child's slug equals the bookmark's), else the title-cased slug. `existing` is a child whose
 * slug is the clean form of a differently written one (?kid=Ash when ash exists): go there, do not make a twin.
 * `others` are the children already on the device, offered as "Or play as".
 */
export function kidSetupPlan(slug, nameParam, kids) {
  const given = typeof nameParam === 'string' ? nameParam.trim() : '';
  const usable = given && given.length <= MAX_NAME && slugify(given) === slug;
  return {
    slug,
    name: usable ? given : titleCaseSlug(slug),
    existing: kids.find((k) => k.slug === slugify(slug)) || null,
    others: kids.map(({ slug: s, name }) => ({ slug: s, name })),
  };
}

/** Create the child (unless a tap in another tab already did) and return it; the caller opens `kid.slug`. */
export async function setUpKid(api, plan) {
  const have = (await api('GET', '/api/kids')).find((k) => k.slug === plan.slug);
  return have || api('POST', '/api/kids', { name: plan.name, year: SETUP_YEAR });
}
