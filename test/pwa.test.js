'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let server;
before(async () => { server = await startServer(); });
after(() => server.stop());

test('the app can be installed on a phone: manifest and icon are served, and the page links them', async () => {
  const m = await fetch(server.base + '/manifest.webmanifest');
  assert.equal(m.status, 200);
  assert.match(m.headers.get('content-type'), /manifest\+json/);
  const j = await m.json();
  assert.deepEqual([j.name, j.display, j.start_url], ['Proofdeck', 'standalone', '/#/']);
  const icon = j.icons[0];
  const i = await fetch(server.base + icon.src);
  assert.equal(i.status, 200);
  assert.equal(i.headers.get('content-type'), 'image/svg+xml');
  assert.match(await i.text(), /<svg/);
  const html = await (await fetch(server.base + '/')).text();
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /viewport-fit=cover/);
});
