'use strict';
// A small QR code generator (byte mode, error correction level L, versions 1 to 10: up to 271 bytes), enough for an
// authenticator-app set-up link. Returns an SVG string. No dependencies.

// version -> [data codewords, EC codewords per block, [blocks, data codewords per block] groups...]
const VERSIONS = [
  null,
  [19, 7, [1, 19]], [34, 10, [1, 34]], [55, 15, [1, 55]], [80, 20, [1, 80]], [108, 26, [1, 108]],
  [136, 18, [2, 68]], [156, 20, [2, 78]], [194, 24, [2, 97]], [232, 30, [2, 116]], [274, 18, [2, 68], [2, 69]],
];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

// ----- Reed-Solomon over GF(256), polynomial 0x11D -----
const EXP = new Array(512), LOG = new Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
function generator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    g.forEach((c, j) => { next[j] ^= mul(c, 1); next[j + 1] ^= mul(c, EXP[i]); });
    g = next;
  }
  return g;
}
function remainder(data, n) {
  const g = generator(n), r = new Array(n).fill(0);
  for (const d of data) {
    const f = d ^ r.shift(); r.push(0);
    if (f) for (let i = 0; i < n; i++) r[i] ^= mul(g[i + 1], f);
  }
  return r;
}

const bch = (value, poly, bits) => { let v = value << bits; const top = poly.toString(2).length; for (let i = v.toString(2).length; i >= top; i--) if ((v >> (i - 1)) & 1) v ^= poly << (i - top); return (value << bits) | v; };

function encode(text) {
  const bytes = Buffer.from(String(text), 'utf8');
  let version = 0;
  for (let v = 1; v <= 10; v++) { const cap = VERSIONS[v][0] - (v < 10 ? 2 : 3); if (bytes.length <= cap) { version = v; break; } }
  if (!version) throw new Error('That text is too long for the QR code');
  const [dataCw, ecPer, ...groups] = VERSIONS[version];

  // data bits: mode 0100, length, bytes, terminator, padding
  let bits = '0100' + bytes.length.toString(2).padStart(version < 10 ? 8 : 16, '0') + [...bytes].map((b) => b.toString(2).padStart(8, '0')).join('');
  bits += '0'.repeat(Math.min(4, dataCw * 8 - bits.length));
  bits += '0'.repeat((8 - (bits.length % 8)) % 8);
  const data = bits.match(/.{8}/g).map((b) => parseInt(b, 2));
  for (let pad = 0xec; data.length < dataCw; pad ^= 0xec ^ 0x11) data.push(pad);

  // split into blocks, add error correction, interleave
  const blocks = [];
  let at = 0;
  for (const [count, size] of groups) for (let i = 0; i < count; i++) { const d = data.slice(at, at + size); at += size; blocks.push({ d, e: remainder(d, ecPer) }); }
  const out = [];
  for (let i = 0; i < Math.max(...blocks.map((b) => b.d.length)); i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ecPer; i++) for (const b of blocks) out.push(b.e[i]);

  // draw
  const n = 17 + 4 * version;
  const m = Array.from({ length: n }, () => new Array(n).fill(null)); // null = free, otherwise 0/1
  const fixed = Array.from({ length: n }, () => new Array(n).fill(false));
  const set = (r, c, v) => { if (r >= 0 && c >= 0 && r < n && c < n) { m[r][c] = v ? 1 : 0; fixed[r][c] = true; } };
  const finder = (r, c) => { for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) set(r + i, c + j, i >= 0 && i <= 6 && j >= 0 && j <= 6 && (i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4))); };
  finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
  const pos = ALIGN[version];
  for (const r of pos) for (const c of pos) {
    if ((r === 6 && c === 6) || (r === 6 && c === pos[pos.length - 1]) || (r === pos[pos.length - 1] && c === 6)) continue;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) set(r + i, c + j, Math.max(Math.abs(i), Math.abs(j)) !== 1);
  }
  for (let i = 8; i < n - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  set(n - 8, 8, 1); // the always-dark module
  const reserve = (r, c) => { if (!fixed[r][c]) { m[r][c] = 0; fixed[r][c] = true; } };
  for (let i = 0; i < 9; i++) { reserve(8, i); reserve(i, 8); }
  for (let i = 0; i < 8; i++) { reserve(8, n - 1 - i); reserve(n - 1 - i, 8); }
  if (version >= 7) { const info = bch(version, 0x1f25, 12); for (let i = 0; i < 18; i++) { const bit = (info >> i) & 1, a = Math.floor(i / 3), b = n - 11 + (i % 3); set(a, b, bit); set(b, a, bit); } }

  // zig-zag data placement
  const bitsOut = out.map((b) => b.toString(2).padStart(8, '0')).join('') + '0'.repeat([0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0][version]);
  const cells = [];
  for (let col = n - 1, up = true; col > 0; col -= 2, up = !up) {
    if (col === 6) col--;
    for (let k = 0; k < n; k++) { const r = up ? n - 1 - k : k; for (const c of [col, col - 1]) if (!fixed[r][c]) cells.push([r, c]); }
  }
  const masks = [(r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0, (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0, (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0];

  const build = (mask) => {
    const g = m.map((row) => row.slice());
    cells.forEach(([r, c], i) => { g[r][c] = (bitsOut[i] === '1' ? 1 : 0) ^ (masks[mask](r, c) ? 1 : 0); });
    const fmt = bch(0b01000 | mask, 0x537, 10) ^ 0x5412; // level L is 01
    const bit = (i) => (fmt >> i) & 1;
    for (let i = 0; i <= 5; i++) g[i][8] = bit(i);
    g[7][8] = bit(6); g[8][8] = bit(7); g[8][7] = bit(8);
    for (let i = 9; i < 15; i++) g[8][14 - i] = bit(i);
    for (let i = 0; i < 8; i++) g[8][n - 1 - i] = bit(i);
    for (let i = 8; i < 15; i++) g[n - 15 + i][8] = bit(i);
    return g;
  };
  const penalty = (g) => {
    let p = 0;
    for (const line of [...g, ...g[0].map((_, c) => g.map((row) => row[c]))]) {
      for (let i = 0, run = 1; i < n; i++) { if (i && line[i] === line[i - 1]) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; }
      const s = line.join('');
      for (const pat of ['10111010000', '00001011101']) { let i = -1; while ((i = s.indexOf(pat, i + 1)) >= 0) p += 40; }
    }
    for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) if (g[r][c] === g[r][c + 1] && g[r][c] === g[r + 1][c] && g[r][c] === g[r + 1][c + 1]) p += 3;
    const dark = g.flat().reduce((a, b) => a + b, 0);
    return p + Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  };
  let best = null;
  for (let mask = 0; mask < 8; mask++) { const g = build(mask), s = penalty(g); if (!best || s < best.s) best = { g, s }; }
  return best.g;
}

// An SVG with a 4 module quiet zone, sized by CSS. `label` is for screen readers.
function toSvg(text, label = 'QR code') {
  const g = encode(text), n = g.length, q = 4;
  let d = '';
  g.forEach((row, r) => { let c = 0; while (c < n) { if (row[c]) { let e = c; while (e < n && row[e]) e++; d += `M${c + q} ${r + q}h${e - c}v1h-${e - c}z`; c = e; } else c++; } });
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * q} ${n + 2 * q}" role="img" aria-label="${esc(label)}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

module.exports = { encode, toSvg };
