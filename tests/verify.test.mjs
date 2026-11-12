// bin/verify test (Vikunja #5602): --list names the four steps; a forced smoke failure exits 1 while the other
// steps still report; no process is left listening on the port the run chose. Never runs the node/python test steps
// (they would recurse into this file). Run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const verify = (args, env = {}) =>
  spawnSync('python3', ['bin/verify', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });

test('--list exits 0 and names all four steps', () => {
  const r = verify(['--list']);
  assert.equal(r.status, 0);
  for (const s of ['node-tests', 'python-tests', 'build-dist', 'smoke']) assert.match(r.stdout, new RegExp(`^${s}:`, 'm'));
});

test('forced smoke failure exits 1, other steps still report, port is freed', async () => {
  const r = verify(['--only', 'build-dist,smoke'], { VERIFY_FORCE_FAIL: 'smoke' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^PASS build-dist/m);
  assert.match(r.stdout, /^FAIL smoke/m);
  assert.match(r.stdout, /^VERIFY FAIL: 1\/2/m);
});

test('a real smoke run passes and leaves nothing listening', async () => {
  const r = verify(['--only', 'build-dist,smoke']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const port = Number(/^PASS smoke \(port (\d+)\)/m.exec(r.stdout)?.[1]);
  assert.ok(port > 0, 'port not reported');
  const open = await new Promise(res => {
    const c = createConnection({ port, host: '127.0.0.1' }, () => { c.destroy(); res(true); });
    c.on('error', () => res(false));
  });
  assert.equal(open, false, 'server still listening');
});
