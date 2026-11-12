// Tests for static/qr.js (run: node --test). The reference matrix below was produced by libqrencode
// (`qrencode -l L -m 0 -8`) for the 17-byte text; when qrencode is installed more sizes are compared live.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { qrMatrix, qrSvgPath } from '../static/qr.js';

const rows = (m) => m.map((r) => r.map((c) => (c ? '1' : '0')).join(''));
const TEXT17 = 'ahovcjqxelszgnubi';
const REF17 = [
  '111111101111001111111',
  '100000101011001000001',
  '101110100010101011101',
  '101110100011001011101',
  '101110101100001011101',
  '100000101101001000001',
  '111111101010101111111',
  '000000001000100000000',
  '111001101110011110011',
  '101101001110101110101',
  '011010100000111011101',
  '000110011001110101010',
  '111011101110110111011',
  '000000001000110111101',
  '111111100110101010001',
  '100000101100110011010',
  '101110100011010100011',
  '101110100111111011010',
  '101110101000111011011',
  '100000101001110111000',
  '111111101001100111001',
];

test('matches the libqrencode reference matrix (version 1)', () => {
  assert.deepEqual(rows(qrMatrix(TEXT17)), REF17);
});

test('size follows the version, finder patterns are in three corners, dark module set', () => {
  const m = qrMatrix('https://x.example/parent#sl=1&w=cat'); // 35 bytes -> version 3
  assert.equal(m.length, 29);
  for (const [x, y] of [[0, 0], [22, 0], [0, 22]]) {
    assert.ok(m[y][x] && m[y][x + 6] && m[y + 6][x] && m[y + 6][x + 6] && m[y + 3][x + 3]);
    assert.ok(!m[y + 1][x + 1] && !m[y + 1][x + 5]);
  }
  assert.ok(m[m.length - 8][8], 'dark module');
});

test('capacity edges: version 40 holds 2953 bytes, one more throws, unicode is UTF-8', () => {
  assert.equal(qrMatrix('a'.repeat(2953)).length, 177);
  assert.throws(() => qrMatrix('a'.repeat(2954)), RangeError);
  assert.equal(qrMatrix('café').length, 21);
});

test('svg path draws exactly the dark modules', () => {
  const m = qrMatrix('hi');
  const dark = m.flat().filter(Boolean).length;
  assert.equal((qrSvgPath(m).match(/M/g) || []).length, dark);
});

const hasQrencode = spawnSync('qrencode', ['-V']).status === 0;
test('live comparison with qrencode on several sizes (skipped without qrencode)', { skip: !hasQrencode }, () => {
  let same = 0;
  for (const len of [30, 100, 200, 500, 900, 1800, 2900]) {
    const s = Array.from({ length: len }, (_, i) => String.fromCharCode(97 + ((i * 7) % 26))).join('');
    const out = spawnSync('qrencode', ['-t', 'ASCII', '-m', '0', '-l', 'L', '-8', '-o', '-', s]).stdout.toString();
    const ref = out.split('\n').filter(Boolean).map((l) => [...l].filter((_, i) => i % 2 === 0).map((c) => (c === '#' ? '1' : '0')).join(''));
    assert.equal(ref.length, qrMatrix(s).length, 'same version');
    if (JSON.stringify(ref) === JSON.stringify(rows(qrMatrix(s)))) same++;
  }
  assert.ok(same >= 5, 'identical to qrencode (mask ties may differ): ' + same);
});
