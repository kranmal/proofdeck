'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startAdmin, addUser } = require('./helpers');

let ctx, a, east, west;
before(async () => {
  ctx = await startAdmin();
  a = ctx.admin;
  east = await addUser(ctx.server, a, 'kiri', 'tester');
  west = await addUser(ctx.server, a, 'baker', 'tester');
});
after(() => ctx.server.stop());

const dayIn = (tz, offsetDays = 0) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
};

test('a time zone is validated and stored on the account', async () => {
  assert.equal((await a.get('/api/auth/me')).data.user.timezone, '');
  assert.equal((await a.put('/api/auth/profile', { timezone: 'Mars/Olympus' })).status, 400);
  await east.client.ok('PUT', '/api/auth/profile', { timezone: 'Pacific/Kiritimati' }); // UTC+14
  await west.client.ok('PUT', '/api/auth/profile', { timezone: 'Etc/GMT+12' }); // UTC-12
  assert.equal((await east.client.get('/api/auth/me')).data.user.timezone, 'Pacific/Kiritimati');
  await east.client.ok('PUT', '/api/auth/profile', { notify_email: 'off' });
  assert.equal((await east.client.get('/api/auth/me')).data.user.timezone, 'Pacific/Kiritimati', 'saving other settings keeps it');
});

test('overdue follows the viewer\'s own date', async () => {
  // Due the day before the east side\'s today: overdue there, not yet overdue for the far west (a day or two behind).
  const due = dayIn('Pacific/Kiritimati', -1);
  const cy = (await a.post('/api/projects/1/cycles', { name: 'Zoned', due_date: due, caseIds: [1] })).data;
  const overdue = async (c) => (await c.get(`/api/cycles/${cy.id}`)).data.overdue;
  assert.equal(await overdue(east.client), true);
  assert.equal(await overdue(west.client), false);
  const listed = async (c) => (await c.get('/api/projects/1/cycles')).data.find((x) => x.id === cy.id).overdue;
  assert.equal(await listed(east.client), true);
  assert.equal(await listed(west.client), false);
  assert.equal((await east.client.get('/api/projects/1/summary')).data.overdueCycles, 1);
  assert.equal((await west.client.get('/api/projects/1/summary')).data.overdueCycles, 0);
});
