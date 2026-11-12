// Tests for static/transport.js (run: node --test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { serverTransport, localTransport, isLocalMode } from '../static/transport.js';
import { createStore, memoryBackend } from '../static/store.js';

test('isLocalMode: data-store attribute or ?local=1, otherwise server', () => {
  assert.equal(isLocalMode({ documentElement: { dataset: { store: 'local' } } }, ''), true);
  assert.equal(isLocalMode({ documentElement: { dataset: {} } }, '?local=1'), true);
  assert.equal(isLocalMode({ documentElement: { dataset: {} } }, '?kid=ann'), false);
  assert.equal(isLocalMode(undefined, ''), false);
});

test('serverTransport: JSON bodies, error messages, audio url and PUT', async () => {
  const calls = [];
  const fake = async (path, opt) => {
    calls.push([path, opt]);
    return path.includes('bad') ? { ok: false, status: 400, json: async () => ({ error: 'nope' }) } : { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const t = serverTransport(fake);
  await t.api('POST', '/api/x', { a: 1 });
  assert.equal(calls[0][1].body, '{"a":1}');
  assert.equal(calls[0][1].headers['Content-Type'], 'application/json');
  await t.api('PUT', '/api/x');
  assert.equal(calls[1][1].headers['Content-Type'], 'application/json');
  await assert.rejects(t.api('GET', '/api/bad'), { message: 'nope' });
  assert.equal(await t.audioSrc(7), '/api/words/7/audio');
  await t.putAudio(7, new Uint8Array(1), 'tts');
  assert.equal(calls.at(-1)[0], '/api/words/7/audio?source=tts');
  assert.equal(calls.at(-1)[1].headers['Content-Type'], 'audio/wav');
});

test('localTransport: same calls over the store, blob urls for audio, errors become Error(message)', async () => {
  const store = await createStore(memoryBackend(), { today: '2026-10-21' });
  const made = [], revoked = [];
  const URLApi = { createObjectURL: (b) => { made.push(b); return `blob:${made.length}`; }, revokeObjectURL: (u) => revoked.push(u) };
  class BlobApi { constructor(parts, o) { this.parts = parts; this.type = o.type; } }
  const t = localTransport(store, { URLApi, BlobApi });
  await t.api('POST', '/api/kids', { name: 'Ann', year: 2 });
  const w = await t.api('POST', '/api/kids/ann/weeks', { week_start: '2026-10-19', words: ['cat'] });
  await assert.rejects(t.api('POST', '/api/kids/ann/weeks', { week_start: '2026-10-19', words: [] }), { message: 'that week already exists' });
  const wav = new Uint8Array(60); wav.set([82, 73, 70, 70], 0); wav.set([87, 65, 86, 69], 8);
  await t.putAudio(w.words[0].id, wav);
  const u1 = await t.audioSrc(w.words[0].id);
  assert.equal(u1, 'blob:1');
  assert.equal(await t.audioSrc(w.words[0].id), 'blob:1', 'cached');
  assert.equal(made[0].type, 'audio/wav');
  await t.putAudio(w.words[0].id, wav.buffer.slice(0)); // ArrayBuffer body accepted; old url revoked
  assert.deepEqual(revoked, ['blob:1']);
  assert.equal(await t.audioSrc(w.words[0].id), 'blob:2');
});
