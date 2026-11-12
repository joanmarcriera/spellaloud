// Feedback button (static/feedback.js): payload rules, the POST it makes, and its wiring into the kid Home
// screen and the parent page. No DOM here: the pure helpers run in node, the wiring is checked in the source.
// Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { feedbackBody, sendFeedback, FEEDBACK_MAX } from '../static/feedback.js';

const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');

test('feedbackBody trims, drops empty optional fields and keeps context', () => {
  const r = feedbackBody({ text: '  Too fast for Year 1 ', name: ' ', contact: 'me@example.org', page: 'kid', kid: 'ash', version: 'browser' });
  assert.deepEqual(r, { body: { text: 'Too fast for Year 1', contact: 'me@example.org', page: 'kid', kid: 'ash', version: 'browser' } });
});

test('feedbackBody refuses empty and over-long text with a parent-readable message', () => {
  assert.match(feedbackBody({ text: '   ' }).error, /write/i);
  assert.equal(FEEDBACK_MAX, 2000);
  assert.match(feedbackBody({ text: 'x'.repeat(2001) }).error, /2000/);
  assert.ok(feedbackBody({ text: 'x'.repeat(2000) }).body);
});

test('sendFeedback POSTs JSON to /api/feedback and reads queued', async () => {
  const calls = [];
  const fake = async (url, opt) => { calls.push([url, opt]); return { ok: true, status: 202, json: async () => ({ ok: true, queued: true }) }; };
  const out = await sendFeedback({ text: 'hi' }, fake);
  assert.deepEqual(out, { ok: true, queued: true });
  assert.equal(calls[0][0], '/api/feedback');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0][1].body), { text: 'hi' });
});

test('sendFeedback turns a refusal or no server into a friendly error', async () => {
  const limited = async () => ({ ok: false, status: 429, json: async () => ({ error: 'try again in an hour' }) });
  await assert.rejects(sendFeedback({ text: 'hi' }, limited), /an hour/);
  const offline = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(sendFeedback({ text: 'hi' }, offline), /could not send/i);
  const noServer = async () => ({ ok: false, status: 404, json: async () => { throw new SyntaxError('html'); } });
  await assert.rejects(sendFeedback({ text: 'hi' }, noServer), /could not send/i);
});

test('feedback.js builds its form without HTML sinks or third-party requests', () => {
  const src = read('static/feedback.js');
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(src, /https?:\/\//);
});

test('kid Home and the parent page both offer the feedback button', () => {
  const app = read('static/app.js');
  assert.match(app, /import \{ feedbackButton \} from '\.\/feedback\.js'/);
  const home = app.slice(app.indexOf('function renderHome('), app.indexOf('// Settings are saved'));
  assert.match(home, /feedbackButton\(\{ page: 'kid'/);
  const parent = read('static/parent.js');
  assert.match(parent, /import \{ feedbackButton \} from '\.\/feedback\.js'/);
  assert.match(parent, /feedbackButton\(\{ page: 'parent'/);
  assert.match(read('static/parent.html'), /id="feedbackbox"/);
});
