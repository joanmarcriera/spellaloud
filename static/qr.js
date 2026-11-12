// qr.js - a small self-written QR Code generator (ISO/IEC 18004), no dependencies, works offline.
// Scope: byte mode (UTF-8), error correction level L, versions 1-40, automatic mask choice.
// Used by the parent page so a shared word-list link can be scanned from another phone (Vikunja #3543).
// Usage: const m = qrMatrix('https://example/parent#sl=1&w=cat');  // array of rows of booleans (true = dark)
//        qrSvgPath(m)  -> SVG path data ("M x y h1 v1 h-1z" per dark module) for a viewBox of m.length square.
// Tests (tests/qr.test.mjs) decode the result with an independent decoder and compare it with `qrencode`.

// Per version 1..40 for level L: error-correction codewords per block, and number of blocks.
const ECC_PER_BLOCK = [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
const NUM_BLOCKS = [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25];

/** Data+ECC modules available in a version (everything except function patterns). */
function rawModules(v) {
  let r = (16 * v + 128) * v + 64;
  if (v >= 2) { const a = Math.floor(v / 7) + 2; r -= (25 * a - 10) * a - 55; if (v >= 7) r -= 36; }
  return r;
}
const dataCodewords = (v) => Math.floor(rawModules(v) / 8) - ECC_PER_BLOCK[v - 1] * NUM_BLOCKS[v - 1];

// ---- Reed-Solomon over GF(256), primitive polynomial 0x11D
const EXP = new Uint8Array(512); const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsGenerator(deg) {
  let g = [1];
  for (let i = 0; i < deg; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= gmul(g[j], EXP[i]); }
    g = next;
  }
  return g; // leading coefficient first, monic
}
function rsRemainder(data, gen) {
  const rem = new Array(gen.length - 1).fill(0);
  for (const d of data) {
    const f = d ^ rem.shift(); rem.push(0);
    if (f) for (let i = 0; i < rem.length; i++) rem[i] ^= gmul(gen[i + 1], f);
  }
  return rem;
}

/** Smallest version that holds `n` bytes, or 0 if none does. */
function pickVersion(n) {
  for (let v = 1; v <= 40; v++) {
    const bits = 4 + (v < 10 ? 8 : 16) + 8 * n;
    if (bits <= 8 * dataCodewords(v)) return v;
  }
  return 0;
}

/** Bytes -> final codeword sequence (data and ECC interleaved) for version v. */
function codewords(bytes, v) {
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4); put(bytes.length, v < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const cap = 8 * dataCodewords(v);
  put(0, Math.min(4, cap - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; data.length < cap / 8; pad ^= 0xec ^ 0x11) data.push(pad);

  const nb = NUM_BLOCKS[v - 1]; const ecc = ECC_PER_BLOCK[v - 1];
  const raw = Math.floor(rawModules(v) / 8);
  const shortLen = Math.floor(raw / nb); const numShort = nb - (raw % nb);
  const gen = rsGenerator(ecc);
  const blocks = []; let k = 0;
  for (let i = 0; i < nb; i++) {
    const len = shortLen - ecc + (i < numShort ? 0 : 1);
    const d = data.slice(k, k + len); k += len;
    blocks.push({ d, e: rsRemainder(d, gen) });
  }
  const out = [];
  for (let i = 0; i <= shortLen - ecc; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ecc; i++) for (const b of blocks) out.push(b.e[i]);
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** Build the function-pattern skeleton: returns {m, fn} (module and is-function matrices). */
function skeleton(v) {
  const size = 17 + 4 * v;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); } // timing
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) { // finders + separators
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx; const y = cy + dy; const d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  }
  if (v >= 2) { // alignment patterns
    const n = Math.floor(v / 7) + 2;
    const step = v === 32 ? 26 : Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2;
    const pos = [6];
    for (let p = size - 7; pos.length < n; p -= step) pos.splice(1, 0, p);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  if (v >= 7) { // version information (BCH 18,6)
    let rem = v; for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (v << 12) | rem;
    for (let i = 0; i < 18; i++) { const b = ((bits >>> i) & 1) === 1; const a = size - 11 + (i % 3); const c = Math.floor(i / 3); set(a, c, b); set(c, a, b); }
  }
  drawFormat(m, fn, size, 0, true);
  return { m, fn, size };
}

/** Format information (level L + mask), with a dark module. `reserve` marks the cells without drawing real bits. */
function drawFormat(m, fn, size, mask, reserve) {
  const data = (1 << 3) | mask; // level L = 01
  let rem = data; for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i) => !reserve && ((bits >>> i) & 1) === 1;
  const set = (x, y, d) => { m[y][x] = d; fn[y][x] = true; };
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);
}

/** Standard four-rule penalty score (lower is better). */
function penalty(m) {
  const n = m.length; let score = 0; let dark = 0;
  const line = (get) => {
    let run = 1; let s = '';
    for (let i = 0; i < n; i++) {
      s += get(i) ? '1' : '0';
      if (i > 0 && get(i) === get(i - 1)) { run++; if (run === 5) score += 3; else if (run > 5) score++; } else run = 1;
    }
    for (const pat of ['10111010000', '00001011101']) for (let i = s.indexOf(pat); i >= 0; i = s.indexOf(pat, i + 1)) score += 40;
  };
  for (let i = 0; i < n; i++) { line((j) => m[i][j]); line((j) => m[j][i]); }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (m[y][x]) dark++;
    if (x + 1 < n && y + 1 < n && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
  }
  const k = Math.ceil(Math.abs(dark * 20 - n * n * 10) / (n * n)) - 1;
  return score + Math.max(0, k) * 10;
}

/** Encode text (UTF-8, level L). Returns rows of booleans (true = dark module), without the quiet zone.
 *  Throws if the text does not fit in version 40 (2953 bytes). */
export function qrMatrix(text) {
  const bytes = new TextEncoder().encode(String(text));
  const v = pickVersion(bytes.length);
  if (!v) throw new RangeError('Text too long for a QR code');
  const cw = codewords(bytes, v);
  const { m: base, fn, size } = skeleton(v);
  const bitAt = (i) => ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
  let i = 0; const place = base.map((r) => r.slice());
  for (let right = size - 1; right >= 1; right -= 2) { // two-column zigzag, skipping the timing column
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j; const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (!fn[y][x] && i < cw.length * 8) place[y][x] = bitAt(i++);
    }
  }
  let best = null; let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = place.map((r) => r.slice());
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[mask](x, y)) m[y][x] = !m[y][x];
    drawFormat(m, fn.map((r) => r.slice()), size, mask, false);
    const s = penalty(m);
    if (s < bestScore) { best = m; bestScore = s; }
  }
  return best;
}

/** SVG path data for a matrix: one 1x1 square per dark module, in a size x size viewBox. */
export function qrSvgPath(matrix) {
  let d = '';
  matrix.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x} ${y}h1v1h-1z`; }));
  return d;
}
