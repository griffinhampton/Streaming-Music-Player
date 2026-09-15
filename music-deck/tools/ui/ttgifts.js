// T6: TikTok gifts, from the live page's own websocket - here, a fixture's.
//
//   node ttgifts.js <devtools port> [rig port]
//
// The real thing is TikTok's webcast socket on the user's live page, carrying
// protobuf. This probe stands up a page and a websocket of its own on
// 127.0.0.1 and sends frames built the way real pages received them on
// 2026-09-15 (webcast.py names every field): a push frame, gzip, the gift
// message with its streak total and end flag. The rig's reader opens the page
// in its own headless Chrome, watches its network read-only, and posts what it
// finds through post_gift - onto a Gift layer on air.
//
// Controls - everything that must happen has something that must not:
//   a streak arrives once, at its end, as its total - nothing before its end,
//     and a late message after it is not a second gift
//   a one-off arrives at once
//   a streak whose end never comes arrives after the quiet, not before
//   a gift marked history, the same message twice, a gift to a guest: none of
//     them arrive - a gift to the host does
//   the page's other socket, shaped like TikTok's messaging one, is never read
//     even carrying a gift - and the page did receive it (the floor)
//   garbage, a cut-off frame, a gzip bomb, a heartbeat carrying a gift, a text
//     frame: nothing, and a good gift after them all still arrives
//   a name made of markup is on stream as text, and nothing runs
//
// It never goes near a stream: the first check is the rig's refusal to go live
// anywhere but this PC, and the probe stops if it is missing.
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const [port, rigPort = '8799'] = process.argv.slice(2);
const RIG = `http://127.0.0.1:${rigPort}`;
const FIXTURE_PORT = 6791;
const PORT_FILE = path.resolve(__dirname, '..', '..', '..', '.rig', 'testrig', 'cache', 'chrome-tiktok', 'DevToolsActivePort');
const CRLF = String.fromCharCode(13, 10);
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 180000).unref();

const results = [];
const check = (n, ok, d = '') => {
  results.push([n, !!ok]);
  console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? `  (${d})` : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const post = (p, body) => fetch(RIG + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: J(body || {}),
}).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const getJ = (p) => fetch(RIG + p, { cache: 'no-store' }).then((r) => r.json());

async function openPage(url) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const p = { ws, id: 0, pending: new Map(), errors: [], targetId: t.id };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && p.pending.has(m.id)) { p.pending.get(m.id)(m); p.pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      p.errors.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n')[0]);
    }
  };
  p.send = (m, q = {}) => new Promise((r) => { const i = ++p.id; p.pending.set(i, r); ws.send(J({ id: i, method: m, params: q })); });
  p.ev = async (x) => {
    const r = await p.send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result.result.value;
  };
  await p.send('Runtime.enable');
  return p;
}
const closePage = async (p) => {
  try { p.ws.close(); } catch (_) {}
  await fetch(`http://127.0.0.1:${port}/json/close/${p.targetId}`).catch(() => {});
};

/* ---- protobuf, the few shapes needed, built field by field as webcast.py
   reads them. */
const vint = (n) => {
  n = BigInt(n); const out = [];
  do { let b = Number(n & 0x7Fn); n >>= 7n; if (n) b |= 0x80; out.push(b); } while (n);
  return Buffer.from(out);
};
const I = (f, n) => Buffer.concat([vint(BigInt(f) << 3n), vint(n)]);
const B = (f, v) => { const b = Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8'); return Buffer.concat([vint((BigInt(f) << 3n) | 2n), vint(b.length), b]); };
const M = (...parts) => Buffer.concat(parts.filter(Boolean));
const user = (id, name, handle) => M(I(1, id), B(3, name), handle ? B(38, handle) : null);
const giftMsg = (o) => M(
  I(2, o.gid || 5655), I(5, o.count || 1), B(7, o.from),
  o.to ? B(8, o.to) : null, o.end ? I(9, 1) : null, o.group ? I(11, o.group) : null,
  B(15, M(I(5, o.gid || 5655), I(11, o.streak === false ? 0 : 1), I(12, o.coins || 1), B(16, o.name || 'Rose'))));
let nextId = 7600000000000000000n;
const wrap = (method, payload, o = {}) => M(B(1, method), B(2, payload), I(3, o.mid || ++nextId), o.history ? I(6, 1) : null);
const push = (msgs, o = {}) => {
  const body = M(...msgs.map((m) => B(1, m)));
  return M(I(1, 1), B(5, M(B(1, 'compress_type'), B(2, 'gzip'))), B(6, 'pb'), B(7, o.type || 'msg'),
    B(8, o.gzip === false ? body : zlib.gzipSync(body)));
};
const G = (o) => push([wrap('WebcastGiftMessage', giftMsg(o), o)], o);

/* ---- the fixture: a live page with two sockets, and the server end of both. */
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>fixture live</title></head><body>
<div class="header"><button class="login"><div>Log in</div></button></div>
<div data-e2e="live-chat-container"><div class="list"></div></div>
<script>
  // The room's socket, where TikTok sends gifts, and one shaped like TikTok's
  // messaging socket, which the reader must never read. The page answers each
  // frame on the second one, so the probe knows it arrived.
  const room = new WebSocket('ws://127.0.0.1:${FIXTURE_PORT}/webcast/im/ws_proxy/ws_reuse_supplement/?room=1');
  const other = new WebSocket('ws://127.0.0.1:${FIXTURE_PORT}/ws/v2?x=1');
  room.binaryType = other.binaryType = 'arraybuffer';
  other.onmessage = () => other.send('got it');
</script></body></html>`;
const fixture = http.createServer((req, res) => {
  if (/^\/@[a-z0-9._]+\/live/.test(req.url)) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(FIXTURE); return; }
  res.writeHead(404); res.end();
});
const wsFrame = (buf, op = 2) => {
  const n = buf.length; let head;
  if (n < 126) head = Buffer.from([0x80 | op, n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, buf]);
};
const sockets = { room: [], other: [] };
let otherAnswers = 0;
fixture.on('upgrade', (req, sock) => {
  const accept = crypto.createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Accept: ' + accept, '', ''].join(CRLF));
  const isRoom = req.url.startsWith('/webcast/im/');
  sock.on('data', () => { if (!isRoom) otherAnswers++; });
  sock.on('error', () => {});
  (isRoom ? sockets.room : sockets.other).push(sock);
});
const toRoom = (buf, op = 2) => sockets.room.forEach((s) => s.write(wsFrame(buf, op)));
const toOther = (buf) => sockets.other.forEach((s) => s.write(wsFrame(buf)));

const giftsNow = async () => ((await getJ('/api/alerts/recent?n=300')).events || []).filter((e) => e.kind === 'gift');
const from = async (who) => (await giftsNow()).filter((e) => (e.detail || {}).user === who);
const tiktokStatus = async () => ((await getJ('/api/chat/status')).services || []).find((s) => s.service === 'tiktok') || null;
const readerAlive = async () => {
  let p = 0;
  try { p = Number(fs.readFileSync(PORT_FILE, 'utf8').split('\n')[0]); } catch (_) { return false; }
  try { return (await fetch(`http://127.0.0.1:${p}/json/version`)).ok; } catch (_) { return false; }
};
const PWNED = `({ pwned: window.__pwned === undefined ? null : window.__pwned,
  imgs: document.querySelectorAll('img[src="x"]').length })`;

(async () => {
  // ---------------------------------------------------------- 0. never go live
  const guard = await post('/api/live/start', { url: 'rtmp://example.invalid/live', key: 'x', source: 'page' });
  check('this rig refuses to go live anywhere but this PC (or the probe stops here)',
    guard.ok === false && guard.refused === true, J(guard));
  if (!(guard.ok === false && guard.refused === true)) { console.log('\nnot a guarded rig - stopping'); process.exit(1); }

  await new Promise((r) => fixture.listen(FIXTURE_PORT, '127.0.0.1', r));
  const pointed = await post('/api/debug/tiktok-page', { base: `http://127.0.0.1:${FIXTURE_PORT}` });
  check('the rig points its reader at the fixture', pointed.ok, J(pointed));

  // A Gift layer on air - coin and card, a second each, so a queue plays through.
  const sc = (await post('/api/scenes', { name: 'TikTok gifts probe', format: 'horizontal' })).scene;
  const full = await getJ(`/api/scenes/${sc.id}`);
  full.layers = [{ id: 'gift', name: 'Gift', type: 'gift', visible: true, locked: false, group: '',
    transform: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0, anchor: 'tl' },
    style: { opacity: 1, blend: 'normal', radius: 0 }, props: { mode: 'coin', seconds: 1, max: 20, coin: 160 }, triggers: [] }];
  await post(`/api/scenes/${sc.id}`, { scene: full, expect_rev: full.rev });
  await post('/api/live/scene', { id: sc.id, transition: 'cut' });
  const stage = await openPage(`${RIG}/scene.html?follow=1`);
  await stage.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await stage.send('Page.bringToFront');

  // ------------------------------------------------------------ 1. connect
  const c = await post('/api/chat/connect', { service: 'tiktok', channel: '@probe' });
  check('connecting starts the reader', c.ok, J(c));
  let st = null;
  for (let i = 0; i < 40; i++) { await sleep(500); st = await tiktokStatus(); if (st && st.page && st.page.socket && sockets.other.length) break; }
  check('the reader saw the page\'s room socket open - the tab was watched before the page loaded',
    st && st.page && st.page.socket === true, J(st && st.page));
  check('the page has both its sockets up (the floor for the controls below)', sockets.room.length >= 1 && sockets.other.length >= 1,
    J({ room: sockets.room.length, other: sockets.other.length }));
  await sleep(500);

  // ------------------------------------------------------------ 2. a streak
  const amy = user(101, 'Amy', 'amy');
  for (let n = 1; n <= 5; n++) { toRoom(G({ from: amy, count: n, group: 11 })); await sleep(150); }
  await sleep(1500);
  check('a streak still running has sent nothing yet (the control)', (await from('Amy')).length === 0);
  toRoom(G({ from: amy, count: 5, end: true, group: 11 }));
  await sleep(1500);
  const a = await from('Amy');
  check('a streak arrives once, at its end, as its total: Rose x5, 5 coins',
    a.length === 1 && a[0].detail.count === 5 && a[0].detail.coins === 5 && a[0].detail.gift === 'Rose', J(a.map((e) => e.detail)));
  toRoom(G({ from: amy, count: 6, group: 11 }));                     // late, after its end

  // ------------------------------------------------------------ 3. a one-off
  toRoom(G({ from: user(102, 'Bob', 'bob'), streak: false, name: 'Galaxy', gid: 11861, coins: 1000 }));
  await sleep(1500);
  const b = await from('Bob');
  check('a one-off arrives at once, with its coins', b.length === 1 && b[0].detail.gift === 'Galaxy' && b[0].detail.coins === 1000,
    J(b.map((e) => e.detail)));

  // ------------------------------------------------ 4. a streak with no end
  for (let n = 1; n <= 3; n++) { toRoom(G({ from: user(103, 'Cy', 'cy'), count: n, group: 12 })); await sleep(150); }
  const cyAt = Date.now();
  await sleep(3000);
  check('a streak whose end never came has not arrived 3 s on (the control)', (await from('Cy')).length === 0);

  // ------------------------------------ 5. what must not arrive, meanwhile
  toRoom(G({ from: user(104, 'Hist', 'hist'), streak: false, history: true }));
  const dup = 7699999999999999999n;
  toRoom(G({ from: user(105, 'Dup', 'dup'), streak: false, mid: dup }));
  toRoom(G({ from: user(105, 'Dup', 'dup'), streak: false, mid: dup }));
  toRoom(G({ from: user(106, 'Guest', 'guestgiver'), streak: false, to: user(900, 'Someone Else', 'someguest') }));
  toRoom(G({ from: user(107, 'ToMe', 'tome'), streak: false, to: user(901, 'The Streamer', 'probe') }));
  const answered = otherAnswers;
  toOther(G({ from: user(108, 'Dm', 'dm'), streak: false }));
  toRoom(crypto.randomBytes(300));
  toRoom(G({ from: user(109, 'Cut', 'cut'), streak: false }).subarray(0, 12));
  toRoom(M(B(7, 'msg'), B(8, zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024)))));
  toRoom(G({ from: user(110, 'Hb', 'hb'), streak: false, type: 'hb' }));
  toRoom(Buffer.from('a text frame'), 1);
  toRoom(G({ from: user(111, 'After', 'after'), streak: false }));
  await sleep(Math.max(0, cyAt + 9500 - Date.now()));
  const cy = await from('Cy');
  check('...and arrives once it has been quiet, as its last total', cy.length === 1 && cy[0].detail.count === 3, J(cy.map((e) => e.detail)));
  const n = async (who) => (await from(who)).length;
  check('a gift marked history is not replayed', await n('Hist') === 0);
  check('the same message twice is one gift', await n('Dup') === 1, String(await n('Dup')));
  check('a gift to a guest on a shared live is not the host\'s', await n('Guest') === 0);
  check('a gift to the host is', await n('ToMe') === 1);
  check('the page received the frame on its other socket (the floor)', otherAnswers > answered, `${answered} -> ${otherAnswers}`);
  check('and the reader never read it, gift and all', await n('Dm') === 0);
  check('garbage, a cut-off frame, a gzip bomb, a heartbeat, a text frame: nothing',
    await n('Cut') === 0 && await n('Hb') === 0, J({ cut: await n('Cut'), hb: await n('Hb') }));
  check('and a good gift after all of them still arrives', await n('After') === 1);
  check('a late message after a streak\'s end was not a second gift', await n('Amy') === 1);
  st = await tiktokStatus();
  check('the reader is still reading', st && st.state === 'joined', J(st && [st.state, st.error]));
  check('and counts what it posted', st && st.page && st.page.gifts === 6, J(st && st.page));

  // ------------------------------------------ 6. nothing a name can run
  const EVIL = '<img src=x onerror=window.__pwned=1>';
  toRoom(G({ from: user(112, EVIL, 'evil'), streak: false, name: '<b>Rose</b>' }));
  toRoom(G({ from: user(113, 'Rev' + String.fromCharCode(0x202E) + 'erse', 'rev'), streak: false }));
  const cards = new Set();
  for (let i = 0; i < 100 && !cards.has(EVIL); i++) {
    cards.add(await stage.ev(`(() => { const el = document.querySelector('[data-id="gift"]');
      return el ? el.querySelector('.gift-who').textContent + ' | ' + el.querySelector('.gift-what').textContent : ''; })()`));
    for (const x of [...cards]) if (x.startsWith(EVIL + ' | ')) cards.add(EVIL);
    await sleep(200);
  }
  const shown = [...cards].find((x) => x.startsWith(EVIL + ' | ')) || '';
  check('on stream, the card shows the name as text, and the gift\'s name too', shown.includes('<b>Rose</b>'), J(shown || [...cards].slice(-4)));
  const onStream = await stage.ev(`(${PWNED})`);
  check('and nothing ran on the stream page: no flag set, no <img src=x>', onStream.pwned === null && onStream.imgs === 0, J(onStream));
  check('a direction override in a name is taken out', await n('Reverse') === 1, J((await giftsNow()).map((e) => e.detail.user).slice(-3)));
  check('nothing was thrown on the stream page', stage.errors.length === 0, stage.errors.slice(0, 2).join(' | '));
  await closePage(stage);

  // ------------------------------------------------------------ 7. stop
  await post('/api/chat/disconnect', { service: 'tiktok' });
  await sleep(3000);
  check('stopping closes the reader\'s window', !(await readerAlive()));

  // -------------------------------------------------- put the rig back as found
  await post('/api/debug/tiktok-page', { base: '' });
  await post('/api/live/scene', { id: '' });
  await post(`/api/scenes/${sc.id}/delete`, {});
  sockets.room.concat(sockets.other).forEach((s) => s.destroy());
  fixture.close();

  const bad = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - bad} of ${results.length} passed`);
  process.exitCode = bad ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 300);
})().catch(async (e) => {
  try { await post('/api/chat/disconnect', { service: 'tiktok' }); } catch (_) {}
  try { await post('/api/debug/tiktok-page', { base: '' }); } catch (_) {}
  try { fixture.close(); } catch (_) {}
  console.log('THREW ' + e.message);
  process.exit(2);
});
