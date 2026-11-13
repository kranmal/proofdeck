'use strict';
// Live updates over Server-Sent Events. After a change is saved, every open browser is told "something in <topic> of
// project <pid> changed, by <actor>"; it never carries content, so there is nothing here to leak. The browser then
// decides whether the page it shows is affected and re-reads it. Changes arriving within a quarter of a second are
// sent together, so an import of 500 cases is one message.

const MAX_PER_USER = 6, MAX_TOTAL = 500, HEARTBEAT_MS = Number(process.env.LIVE_HEARTBEAT_MS) || 20000, BATCH_MS = 250;
const clients = new Set(); // { res, user, req, check }
let queue = new Map(), timer = null;

function write(c, event, data) {
  try { c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { drop(c); }
}
function drop(c) { clients.delete(c); try { c.res.end(); } catch { /* already closed */ } }

function flush() {
  timer = null;
  const changes = [...queue.values()];
  queue = new Map();
  if (changes.length) for (const c of clients) write(c, 'change', { changes });
}

// topic: what kind of thing ("cases", "bugs", ...). pid: the project, or null when it is not known. actor: user id or null.
function publish({ topic, pid = null, actor = null }) {
  if (!topic) return;
  queue.set(`${topic}|${pid}|${actor}`, { topic, pid, actor });
  if (!timer) { timer = setTimeout(flush, BATCH_MS); timer.unref(); }
}

function publishTo(userId, event, data = {}) {
  for (const c of clients) if (c.user.id === userId) write(c, event, data);
}

// `check()` returns the current user or null; the stream is closed when the sign-in has ended.
function attach(req, res, user, check) {
  const mine = [...clients].filter((c) => c.user.id === user.id);
  if (clients.size >= MAX_TOTAL || mine.length >= MAX_PER_USER) {
    if (mine.length >= MAX_PER_USER) drop(mine[0]); // an old tab that never closed: the newest wins
    else { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end('{"error":"Too many live connections"}'); }
  }
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const c = { res, user, req, check };
  clients.add(c);
  res.write('retry: 3000\n: connected\n\n');
  write(c, 'hello', { user: user.id });
  req.on('close', () => clients.delete(c));
}

const beat = setInterval(() => {
  for (const c of [...clients]) {
    let u = null;
    try { u = c.check(c.req); } catch { /* treat as signed out */ }
    if (!u || u.id !== c.user.id || !u.active) { write(c, 'bye', {}); drop(c); continue; }
    try { c.res.write(': ping\n\n'); } catch { drop(c); }
  }
}, HEARTBEAT_MS);
beat.unref();

// The first path segment that says what changed: /api/projects/:pid/bugs -> bugs, /api/cases/:id -> cases.
function topicOf(pattern) {
  const parts = String(pattern).split('/').filter(Boolean).slice(1); // drop "api"
  if (parts[0] === 'projects' && parts[1] && parts[1].startsWith(':')) parts.splice(0, 2);
  return parts[0] && !parts[0].startsWith(':') ? parts[0] : 'projects';
}

module.exports = { publish, publishTo, attach, topicOf, count: () => clients.size };
