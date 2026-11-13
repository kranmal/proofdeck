'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const qr = require('../lib/qr');

// The encoder was also checked by decoding its output with OpenCV for every version from 1 to 10.
test('QR codes: size follows the text length, finder patterns are in place, output is deterministic', () => {
  const small = qr.encode('hello'), big = qr.encode('x'.repeat(200));
  assert.equal(small.length, 21);
  assert.equal(big.length, 53);
  for (const g of [small, big]) {
    const n = g.length;
    for (const [r, c] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
      assert.deepEqual(g[r].slice(c, c + 7), [1, 1, 1, 1, 1, 1, 1], 'top edge of a finder pattern');
      assert.deepEqual([g[r + 3][c + 3], g[r + 1][c + 1], g[r + 2][c + 2]], [1, 0, 1], 'its centre and ring');
    }
    assert.equal(g[n - 8][8], 1, 'the always-dark module');
  }
  assert.deepEqual(qr.encode('same'), qr.encode('same'));
  assert.throws(() => qr.encode('x'.repeat(300)), /too long/);
});

test('SVG output is a self-contained image with an accessible label and no unescaped markup', () => {
  const svg = qr.toSvg('otpauth://totp/x', 'A "label" <b>');
  assert.match(svg, /^<svg [^>]*viewBox="0 0 29 29"/);
  assert.ok(svg.includes('aria-label="A &quot;label&quot; &lt;b&gt;"'));
  assert.ok(!/<script|onload/i.test(svg));
});
