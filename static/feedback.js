// feedback.js - the "Tell us what to improve" button for parents (kid Home + parent page).
// A small <dialog> form; Send POSTs JSON to server.py's /api/feedback, which files a Vikunja task with a
// server-side token (the browser never holds one). Works in both builds: the browser-only build has no
// family API, but the public server keeps /api/feedback; a plain static host answers 404 -> "could not send".
// Every string goes in as text (textContent / value), never as markup (tests/feedback.test.mjs guards this).
//
// Usage:  import { feedbackButton } from './feedback.js';
//         topbar.append(feedbackButton({ page: 'kid', kid: 'ash' }));   // page: 'kid' | 'parent'

export const FEEDBACK_MAX = 2000;
const CAPS = { name: 100, contact: 200, page: 20, kid: 40, version: 40 }; // mirror server.py FEEDBACK_FIELDS

/** Validated request body, or {error} with a message a parent can act on. Pure (unit-tested in node). */
export function feedbackBody(fields) {
  const text = String(fields.text ?? '').trim();
  if (!text) return { error: 'Please write a few words first.' };
  if (text.length > FEEDBACK_MAX) return { error: `Please keep it under ${FEEDBACK_MAX} characters.` };
  const body = { text };
  for (const [k, cap] of Object.entries(CAPS)) {
    const v = String(fields[k] ?? '').trim().slice(0, cap);
    if (v) body[k] = v;
  }
  return { body };
}

/** POST the body. Resolves {ok, queued}; rejects with a friendly Error (offline, rate limit, no server). */
export async function sendFeedback(body, fetchImpl = (...a) => globalThis.fetch(...a)) {
  let res;
  try {
    res = await fetchImpl('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Error('Could not send just now. Please check the connection and try again.');
  }
  const data = await res.json().catch(() => null);
  if (res.ok && data) return data;
  if (data && data.error && res.status !== 404) throw new Error(data.error);
  throw new Error('Could not send from this page. Please tell us on the class chat instead.');
}

/** Tiny element builder: string children become text nodes, never markup. */
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
  return e;
}

/** The build this page came from: 'browser' (IndexedDB build) or 'family' (server.py). */
const buildKind = () => (document.documentElement.dataset.store === 'local' ? 'browser' : 'family');

/** A button that opens the feedback form. `kid` is the child's slug when known (kid pages only). */
export function feedbackButton({ page, kid = '', label = 'Feedback' } = {}) {
  const open = () => {
    const text = el('textarea', { rows: '5', maxlength: String(FEEDBACK_MAX), required: true, 'aria-label': 'Your feedback',
      placeholder: 'What worked, what was confusing, what would you change?' });
    const name = el('input', { type: 'text', maxlength: String(CAPS.name), autocomplete: 'name', 'aria-label': 'Your name (optional)', placeholder: 'Your name (optional)' });
    const contact = el('input', { type: 'text', maxlength: String(CAPS.contact), autocomplete: 'email', 'aria-label': 'Email or phone (optional)', placeholder: 'Email or phone (optional)' });
    const msg = el('p', { class: 'msg', role: 'status' });
    const send = el('button', { type: 'submit', class: 'btn small solid' }, 'Send');
    const dlg = el('dialog', { class: 'feedback', 'aria-label': 'Tell us what to improve' });
    const close = () => { if (typeof dlg.close === 'function') dlg.close(); dlg.remove(); };
    const form = el('form', { method: 'dialog', onsubmit: async (ev) => {
      ev.preventDefault();
      const r = feedbackBody({ text: text.value, name: name.value, contact: contact.value, page, kid, version: buildKind() });
      if (r.error) { msg.textContent = r.error; msg.className = 'msg err'; return; }
      send.disabled = true; msg.className = 'msg'; msg.textContent = 'Sending...';
      try {
        await sendFeedback(r.body);
        form.replaceChildren(el('h2', {}, 'Thank you!'), el('p', {}, 'We read every note and use them to decide what to fix next.'),
          el('button', { type: 'button', class: 'btn small solid', onclick: close }, 'Close'));
      } catch (e) {
        msg.textContent = e.message; msg.className = 'msg err'; send.disabled = false;
      }
    } },
    el('h2', {}, 'Tell us what to improve'),
    text, name, contact,
    el('p', { class: 'note' }, 'This goes straight to the parent who made this app (into their private to-do list). Add a contact if you would like a reply. Please do not include your child\'s full name. Name and contact are optional.'),
    msg,
    el('div', { class: 'screenbox' }, send, el('button', { type: 'button', class: 'btn small', onclick: close }, 'Cancel')));
    dlg.append(form);
    document.body.append(dlg);
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    text.focus();
  };
  return el('button', { type: 'button', class: 'btn small feedbackbtn', onclick: open, title: 'Tell us what to improve' }, '💬 ' + label);
}
