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
// A user: id (1), display name (3), picture links (9, a list in 1), @handle (38).
const user = (id, name, handle, pics) => M(I(1, id), B(3, name), pics ? B(9, M(...pics.map((u) => B(1, u)))) : null,
  handle ? B(38, handle) : null);
// A real PNG for the sender's picture, so the coin can be seen to load it.
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function makePng(size) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const px = [0];
    for (let x = 0; x < size; x++) px.push(x < size / 2 ? 230 : 40, 90, y < size / 2 ? 200 : 60);
    rows.push(Buffer.from(px));
  }
  const chunk = (tag, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(tag, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
const PIC = makePng(96);
const picHits = [];
// A picture path of this run's own: the rig keeps its picture cache between
// runs, so a path used before is (rightly) never fetched again.
const FACE = `/pic/face-${process.pid}-${Date.now()}.png`;
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
// A chat line: sender (2), words (3), TikTok's identity flags (18; 5 = moderator).
const chatMsg = (o) => M(B(2, o.from), B(3, o.text), o.flags ? B(18, M(...o.flags.map((f) => I(f, 1)))) : null);
const C = (o) => push([wrap('WebcastChatMessage', chatMsg(o), o)], o);
// A social message: its display text names it (common 1 -> displayText 8 ->
// key 1), the sender is 2, and TikTok's action is 4 - 1 a follow, 3 a share.
const socialMsg = (o) => M(B(1, M(B(1, 'WebcastSocialMessage'), B(8, M(B(1, o.key || 'pm_main_follow_message_viewer_2'))))),
  B(2, o.from), I(4, o.action === undefined ? 1 : o.action));
const S = (o) => push([wrap('WebcastSocialMessage', socialMsg(o), o)], o);
const ops = [];

/* ---- the fixture: a live page with two sockets, and the server end of both. */
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>fixture live</title></head><body>
<div class="header"><button class="login"><div>Log in</div></button></div>
<div data-e2e="live-chat-container"><div class="list"></div></div>
<script>
  // The room's socket, where TikTok sends gifts, and one shaped like TikTok's
  // messaging socket, which the reader must never read. The page answers each
  // frame on the second one, so the probe knows it arrived.
  // The room socket opens only while the streamer is "live" (the probe's
  // liveNow): an offline live page opens none, as TikTok's does.
  fetch('/live-state').then((r) => r.json()).then((s) => {
    if (!s.live) return;
    const room = new WebSocket('ws://127.0.0.1:${FIXTURE_PORT}/webcast/im/ws_proxy/ws_reuse_supplement/?room_id=' + encodeURIComponent(s.room));
    room.binaryType = 'arraybuffer';
  });
  const other = new WebSocket('ws://127.0.0.1:${FIXTURE_PORT}/ws/v2?x=1');
  other.binaryType = 'arraybuffer';
  other.onmessage = () => other.send('got it');
  // And the page drawing chat lines, as TikTok's does, in the real shape -
  // which the reader must not also send while the room socket is heard.
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const list = document.querySelector('[data-e2e="live-chat-container"] .list');
  function draw(o) {
    const d = document.createElement('div'); d.setAttribute('data-index', String(o.index));
    d.innerHTML = '<div data-e2e="chat-message"><div class="w-full break-words"><div><div>' +
      '<div data-e2e="message-owner-name">' + esc(o.name) + '</div></div></div>' +
      '<div class="w-full break-words">' + esc(o.text) + '</div></div></div>';
    list.appendChild(d);
  }
  // Ops: draw a line, move within the page as TikTok does (go), or load
  // another page outright (load). A page just loaded skips what came before it.
  let at = -1;
  (async function tick() {
    try {
      const all = await (await fetch('/ops')).json();
      if (at < 0) at = all.length;
      for (; at < all.length; at++) {
        const o = all[at];
        if (o.go) history.pushState({}, '', o.go);
        else if (o.load) { at = all.length; location.href = o.load; return; }
        else draw(o);
      }
    } catch (_) {}
    setTimeout(tick, 250);
  })();
</script></body></html>`;
let liveNow = true;            // is the streamer "live": does the page open its room socket
let roomNow = '7000000000000000001';   // which live: the room id in the room socket's address
let pageLoads = 0;             // loads of the streamer's own live page
const fixture = http.createServer((req, res) => {
  if (req.url === '/ops') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(J(ops)); return; }
  if (req.url === '/live-state') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(J({ live: liveNow, room: roomNow })); return; }
  if (req.url.split('?')[0] === '/@probe/live') pageLoads++;
  // Stand-ins for TikTok's image servers, and for what the app must refuse
  // from them: a redirect, and a page that calls itself a PNG.
  if (req.url.startsWith('/pic/')) {
    const p = req.url.split('?')[0];
    picHits.push(p);
    if (p === '/pic/r.png') { res.writeHead(302, { Location: '/pic/redirected.png' }); res.end(); return; }
    if (p === '/pic/page.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end('<html>not a picture</html>'); return; }
    if (p.startsWith('/pic/face') || p === '/pic/redirected.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PIC); return; }
  }
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

  const before = (await getJ('/api/config')).commands || {};
  const CMDS = [
    { name: 'hello', action: 'say', response: 'hi {user}' },
    { name: 'modonly', action: 'say', role: 'mod', response: 'ok' },
    { name: 'mine', action: 'say', role: 'broadcaster', response: 'yours' },
    { name: 'fans', action: 'say', role: 'follower', response: 'thanks for following' },
    { name: 'bigspender', action: 'say', response: 'big thanks', coins: 100 },
  ];
  await post('/api/commands/save', { commands: CMDS, symbol: '!', budget: { count: 5, seconds: 0 }, floor: 'everyone' });
  // The coin ledger is kept across restarts (gifts.py); this run counts from nothing.
  const reset = await post('/api/gifts/reset', {});
  check('the coin ledger starts again on Reset', reset.ok && reset.ledger && reset.ledger.coins === 0, J(reset.ledger));
  await new Promise((r) => fixture.listen(FIXTURE_PORT, '127.0.0.1', r));
  const pointed = await post('/api/debug/tiktok-page', { base: `http://127.0.0.1:${FIXTURE_PORT}`, reopen: 4 });
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
  // What they came to in coins (gifts.py): Amy's Rose x5 (5), Bob's Galaxy
  // (1000), Cy's Rose x3 (3), and a Rose each from Dup, ToMe and After (3).
  const led = await getJ('/api/gifts/ledger?top=10');
  check('the ledger counts coins, not just gifts: 1011 coins in 12 gifts from 6 people',
    led.coins === 1011 && led.gifts === 12 && led.senders === 6, J({ coins: led.coins, gifts: led.gifts, senders: led.senders }));
  check('and knows who gave the most, by handle', led.top[0] && led.top[0].handle === 'bob' && led.top[0].coins === 1000 &&
    (led.top.find((t) => t.handle === 'amy') || {}).coins === 5, J(led.top));
  const lv = await openPage(`${RIG}/liveview.html`);
  await sleep(4500);
  const shownGifts = await lv.ev('LiveView.gifts()');
  check('the Live view shows the coins this stream and the top gifter', shownGifts.coins === '1,011' &&
    shownGifts.gifts === '12' && /^Bob . 1,000 coins$/.test(shownGifts.top[0] || ''), J(shownGifts));
  check('nothing was thrown in the Live view', lv.errors.length === 0, lv.errors.slice(0, 2).join(' | '));
  await closePage(lv);

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

  // ------------------------------------------ 7. chat from the room socket
  const chatNow = async () => ((await getJ('/api/chat/recent?n=300')).messages || []).filter((m) => m.service === 'tiktok');
  const logNow = async () => (await getJ('/api/commands/recent?n=300')).log || [];
  const log0 = (await logNow()).length;
  toRoom(C({ from: user(201, 'Whatever I Call Myself', 'probe'), text: '!mine' }));
  toRoom(C({ from: user(202, 'probe', 'copycat'), text: '!mine' }));
  toRoom(C({ from: user(203, 'ModMo', 'modmo'), text: '!modonly', flags: [1, 2, 3, 4, 5] }));
  toRoom(C({ from: user(204, 'Plain', 'plain'), text: '!modonly', flags: [1, 2, 3, 4] }));
  toRoom(C({ from: user(205, 'Old', 'old'), text: '!hello', history: true }));
  toRoom(C({ from: user(206, 'Fan', 'fan'), text: '!fans', flags: [4] }));
  toRoom(C({ from: user(207, 'NotFan', 'notfan'), text: '!fans', flags: [2, 3] }));
  toRoom(C({ from: user(208, 'Flagged', 'flagged'), text: '!fans', flags: [1] }));
  // The page draws the host's line too, as TikTok's does, and a line of its own.
  ops.push({ index: 40, name: 'Whatever I Call Myself', text: '!mine' });
  ops.push({ index: 41, name: 'DrawnOnly', text: 'only on the page' });
  await sleep(3000);
  const lines = await chatNow();
  const host = lines.filter((m) => m.user.name === 'Whatever I Call Myself');
  check('a chat line from the room socket arrives, with the sender\'s @handle as their login',
    host.length >= 1 && host[0].user.login === 'probe' && host[0].text === '!mine', J(host));
  check('and only once - the page\'s drawing of the same line is not sent too', host.length === 1, String(host.length));
  check('a line only the page drew is not sent while the room socket is heard', !lines.some((m) => m.user.name === 'DrawnOnly'));
  const log = (await logNow()).slice(log0);
  const out = (who, cmd) => (log.find((e) => e.user === who && e.command === cmd) || {}).outcome;
  check('the streamer, found by @handle, runs a broadcaster-only command', out('Whatever I Call Myself', 'mine') === 'ran',
    J(log.map((e) => [e.user, e.command, e.outcome])));
  check('a viewer with the streamer\'s display name and another handle is nobody (the control)', out('probe', 'mine') === 'denied');
  check('a moderator, by TikTok\'s own flag, runs a mod-only command', out('ModMo', 'modonly') === 'ran');
  check('a follower, gift-giver and subscriber without it does not (the control)', out('Plain', 'modonly') === 'denied');
  check('a line from before the page joined is not replayed', !lines.some((m) => m.user.name === 'Old') && !out('Old', 'hello'));
  check('a follower, by TikTok\'s own flag, runs a followers-and-gifters command', out('Fan', 'fans') === 'ran');
  check('so does someone TikTok marks as having gifted you', out('Flagged', 'fans') === 'ran');
  check('someone who neither follows nor has gifted does not (the control)', out('NotFan', 'fans') === 'denied');
  // A gifter by this stream's ledger: Bob gave a Galaxy above. First someone
  // who only copies his display name, then Bob himself, known by his handle.
  const logBob = (await logNow()).length;
  toRoom(C({ from: user(299, 'Bob', 'bobcopy'), text: '!fans' }));
  await sleep(1500);
  const copy = (await logNow()).slice(logBob).find((e) => e.user === 'Bob' && e.command === 'fans');
  check('a viewer with a gifter\'s display name but another handle is no gifter (the control)', copy && copy.outcome === 'denied', J(copy));
  toRoom(C({ from: user(102, 'Bob', 'bob'), text: '!fans' }));
  await sleep(1500);
  const real = (await logNow()).slice(logBob).filter((e) => e.user === 'Bob' && e.command === 'fans')[1];
  check('the viewer who gifted this stream, by handle, runs it', real && real.outcome === 'ran', J(real));
  // "Commands are for": the floor under every command.
  await post('/api/commands/save', { commands: CMDS, symbol: '!', budget: { count: 5, seconds: 0 }, floor: 'follower' });
  const logFloor = (await logNow()).length;
  toRoom(C({ from: user(211, 'Passerby', 'passerby'), text: '!hello' }));
  toRoom(C({ from: user(212, 'FanToo', 'fantoo'), text: '!hello', flags: [4] }));
  await sleep(2000);
  const fl = (await logNow()).slice(logFloor);
  const fo = (who) => (fl.find((e) => e.user === who && e.command === 'hello') || {}).outcome;
  check('with commands for followers and gifters, a passer-by runs none', fo('Passerby') === 'denied', J(fl.map((e) => [e.user, e.outcome])));
  check('and a follower runs what anyone could before', fo('FanToo') === 'ran');
  await post('/api/commands/save', { commands: CMDS, symbol: '!', budget: { count: 5, seconds: 0 }, floor: 'everyone' });
  // A price in coins gifted this stream: !bigspender asks for 100. Bob gave
  // 1,000 above, Amy 5; a moderator never pays.
  const logPrice = (await logNow()).length;
  toRoom(C({ from: user(102, 'Bob', 'bob'), text: '!bigspender' }));
  toRoom(C({ from: user(101, 'Amy', 'amy'), text: '!bigspender' }));
  toRoom(C({ from: user(213, 'ModZero', 'modzero'), text: '!bigspender', flags: [5] }));
  await sleep(2000);
  const pr = (await logNow()).slice(logPrice);
  const pe = (who) => pr.find((e) => e.user === who && e.command === 'bigspender') || {};
  check('a command with a price in coins runs for someone who gifted that much this stream', pe('Bob').outcome === 'ran',
    J(pr.map((e) => [e.user, e.outcome, e.response])));
  check('and not for someone who gifted less - told what it needs and what they have',
    pe('Amy').outcome === 'denied' && /needs 100 coins/.test(pe('Amy').response || '') && /you have 5\)/.test(pe('Amy').response || ''),
    J(pe('Amy')));
  check('a moderator never pays', pe('ModZero').outcome === 'ran');
  st = await tiktokStatus();
  check('the reader says chat is coming from the room socket', st && st.page && st.page.chat_from === 'socket', J(st && st.page));

  // ------------------------------------------------ 8. the sender's picture
  // Fetched by the server (avatars.py), kept, and served from this app - the
  // stream page never asks anyone else for it.
  const P = `http://127.0.0.1:${FIXTURE_PORT}/pic`;
  const stage2 = await openPage(`${RIG}/scene.html?follow=1`);
  await stage2.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await stage2.send('Page.bringToFront');
  await sleep(2500);
  picHits.length = 0;
  toRoom(G({ from: user(301, 'Pixie', 'pixie', [`http://127.0.0.1:${FIXTURE_PORT}${FACE}?x-expires=1&x-signature=a`]), streak: false }));
  let face = null;
  for (let i = 0; i < 50 && !(face && face.w); i++) {
    face = await stage2.ev(`(() => { const el = document.querySelector('[data-id="gift"]');
      const img = el && el.querySelector('.gift-face img');
      return el && el.querySelector('.gift-who').textContent === 'Pixie'
        ? { src: img ? img.getAttribute('src') : '', w: img ? img.naturalWidth : 0 } : null; })()`);
    await sleep(200);
  }
  check('the sender\'s picture is on the coin, loaded from this app', face && /^\/avatar\/[0-9a-f]{16}\.png$/.test(face.src) && face.w === 96, J(face));
  const px = (await from('Pixie'))[0];
  check('the gift carries a local address for it, never TikTok\'s link', px && /^\/avatar\/[0-9a-f]{16}\.png$/.test(px.detail.avatar), J(px && px.detail));
  toRoom(G({ from: user(301, 'Pixie', 'pixie', [`http://127.0.0.1:${FIXTURE_PORT}${FACE}?x-expires=2&x-signature=b`]), streak: false, gid: 5656, name: 'Heart' }));
  await sleep(2500);
  check('the same picture under a newly signed link is fetched once, not again', picHits.filter((h) => h === FACE).length === 1, J(picHits));
  toRoom(G({ from: user(302, 'Redi', 'redi', [`${P}/r.png`]), streak: false }));
  toRoom(G({ from: user(303, 'Pagey', 'pagey', [`${P}/page.png`]), streak: false }));
  toRoom(G({ from: user(304, 'Faraway', 'faraway', ['https://example.com/face.png']), streak: false }));
  await sleep(3000);
  const pic = async (who) => ((await from(who))[0] || { detail: { avatar: null } }).detail.avatar;
  check('a redirect is never followed: the gift comes with no picture', (await pic('Redi')) === '' && !picHits.includes('/pic/redirected.png'), J(picHits));
  check('a page calling itself a picture is refused', (await pic('Pagey')) === '');
  check('a picture anywhere but TikTok\'s image servers is refused', (await pic('Faraway')) === '');
  check('and every one of those gifts still arrives, with the sender\'s initial',
    (await from('Redi')).length === 1 && (await from('Pagey')).length === 1 && (await from('Faraway')).length === 1);
  const r1 = await fetch(`${RIG}/avatar/..%2Fconfig.json`).then((r) => r.status);
  const r2 = await fetch(`${RIG}/avatar/0123456789abcdef.exe`).then((r) => r.status);
  check('the picture route serves nothing but files of its own shape', r1 === 404 && r2 === 404, `${r1} ${r2}`);
  const served = face && face.src ? await fetch(RIG + face.src) : null;
  check('and serves those as the picture they are, never sniffed as anything else',
    served && served.status === 200 && served.headers.get('content-type') === 'image/png' &&
    served.headers.get('x-content-type-options') === 'nosniff', served && `${served.status} ${served.headers.get('content-type')}`);
  check('nothing was thrown on the stream page', stage2.errors.length === 0, stage2.errors.slice(0, 2).join(' | '));
  await closePage(stage2);

  // ----------------------------------------------------- 8b. a new follower
  // TikTok announces a follow on the same socket the gifts arrive on, and a
  // share on it too - which must not be taken for one (webcast.social).
  const followsBefore = ((await getJ('/api/alerts/recent?n=300')).events || []).filter((e) => e.kind === 'follow').length;
  toRoom(S({ from: user(301, 'Fern', 'fern') }));
  toRoom(S({ from: user(302, 'Sharer', 'sharer'), action: 3, key: 'pm_mt_guidance_share' }));
  await sleep(2500);
  const follows = ((await getJ('/api/alerts/recent?n=300')).events || []).filter((e) => e.kind === 'follow');
  check('a new follower arrives as an alert of its own kind',
    follows.length === followsBefore + 1 && (follows[follows.length - 1].detail || {}).user === 'Fern',
    J(follows.slice(-2).map((e) => [e.kind, (e.detail || {}).user])));
  check('a share is not a follow', !follows.some((e) => (e.detail || {}).user === 'Sharer'));

  // ------------------------------------------------ 9. only your own live
  // TikTok's live page offers other lives, and an ended one can move on to
  // another. Nothing from there may reach this stream. A long wait first, so
  // the reader stays where it is put here (9b says why it would not for long).
  await post('/api/debug/tiktok-page', { base: `http://127.0.0.1:${FIXTURE_PORT}`, reopen: 60 });
  await sleep(1200);                                   // a tick on the live: the wait starts over at 60
  ops.push({ go: '/@someoneelse/live' });              // moving within the page, as TikTok does
  await sleep(1500);
  st = await tiktokStatus();
  check('the reader knows the window left the streamer\'s own live', st && st.page && st.page.own === false, J(st && st.page));
  toRoom(G({ from: user(401, 'Elsewhere', 'elsewhere'), streak: false }));
  toRoom(C({ from: user(402, 'ElseChat', 'elsechat'), text: '!hello from another live' }));
  await sleep(2500);
  check('a gift on someone else\'s live is not posted to this stream', await n('Elsewhere') === 0);
  check('nor is their chat read', !(await chatNow()).some((m) => m.user.name === 'ElseChat'));
  ops.push({ go: '/@probe/live' });
  await sleep(1500);
  toRoom(G({ from: user(403, 'BackHome', 'backhome'), streak: false }));
  await sleep(2500);
  check('back on the streamer\'s own live, gifts arrive again (the control)', await n('BackHome') === 1);
  const roomsBefore = sockets.room.length;
  ops.push({ load: '/@someoneelse/live' });            // a full load of another live
  for (let i = 0; i < 40 && sockets.room.length <= roomsBefore; i++) await sleep(250);
  await sleep(1500);
  st = await tiktokStatus();
  toRoom(G({ from: user(404, 'Loaded', 'loaded'), streak: false }));
  await sleep(2500);
  check('after a full load of another live, its gifts are not posted either',
    sockets.room.length > roomsBefore && await n('Loaded') === 0 && st && st.page && st.page.own === false,
    J({ sockets: sockets.room.length, page: st && st.page }));

  // ------------------------------------ 9b. hidden, it goes back by itself
  // Nobody can steer a hidden reader, so when TikTok moves on to another live
  // it opens the streamer's own page again after the wait (_reopen_due).
  ops.push({ load: '/@probe/live' });                  // home, on the live
  for (let i = 0; i < 60; i++) { await sleep(250); st = await tiktokStatus(); if (st && st.page && st.page.own && st.page.live) break; }
  await post('/api/debug/tiktok-page', { base: `http://127.0.0.1:${FIXTURE_PORT}`, reopen: 3 });
  await sleep(1200);                                   // a tick on the live: the wait starts over at 3
  const looks0 = (((await tiktokStatus()) || {}).page || {}).looks || 0;
  const homeLoads = pageLoads;
  ops.push({ go: '/@someoneelse/live' });
  let back = null;
  for (let i = 0; i < 80; i++) {
    await sleep(250); back = await tiktokStatus();
    if (back && back.page && back.page.own === true && back.page.looks > looks0 && back.page.live) break;
  }
  check('hidden, the reader goes back to the streamer\'s own live by itself',
    back && back.page && back.page.own === true && back.page.looks > looks0 && pageLoads > homeLoads, J(back && back.page));
  toRoom(G({ from: user(405, 'Returned', 'returned'), streak: false }));
  await sleep(2500);
  check('and reads it again', await n('Returned') === 1);

  // --------------------------------- 9c. a live that has gone quiet
  // A room socket can stop delivering without closing - seen on a real live,
  // where the reader sat for 28 minutes saying there was a live and reading
  // nothing. Nothing is sent here for a while, and the reader opens the page
  // again by itself (tiktok_chat.SILENT), then reads what comes after.
  await post('/api/debug/tiktok-page', { base: `http://127.0.0.1:${FIXTURE_PORT}`, reopen: 3, silent: 5 });
  const quietLooks = (((await tiktokStatus()) || {}).page || {}).looks || 0;
  const quietLoads = pageLoads;
  let woke = null;
  for (let i = 0; i < 80; i++) {                       // nothing sent: let it go quiet
    await sleep(250); woke = await tiktokStatus();
    if (woke && woke.page && woke.page.looks > quietLooks && woke.page.own === true) break;
  }
  check('a live that has gone quiet is opened again by itself',
    woke && woke.page && woke.page.looks > quietLooks && pageLoads > quietLoads, J(woke && woke.page));
  // Back to a silence nothing here will reach, so the checks below are not
  // interrupted by a reader that is right to be impatient.
  await post('/api/debug/tiktok-page', { base: `http://127.0.0.1:${FIXTURE_PORT}`, reopen: 3, silent: 3600 });
  for (let i = 0; i < 40; i++) { await sleep(250); st = await tiktokStatus(); if (st && st.page && st.page.live) break; }
  toRoom(G({ from: user(406, 'AfterQuiet', 'afterquiet'), streak: false }));
  await sleep(2500);
  check('and reads the live again afterwards', await n('AfterQuiet') === 1, J(st && st.page));

  // ------------------------------------------ 10. opened before going live
  // The page shows no live and opens no room socket; the reader looks again
  // by itself (tiktok_chat.py _reopen_due), and finds the live once it starts.
  liveNow = false;
  const loads0 = pageLoads;
  ops.push({ load: '/@probe/live' });
  let w = null;
  for (let i = 0; i < 100; i++) { await sleep(250); w = await tiktokStatus(); if (w && w.page && w.page.waiting) break; }
  check('opened before the live starts, the reader says it is waiting for it',
    w && w.page && w.page.own === true && w.page.live === false && w.page.waiting === true, J(w && w.page));
  check('and has opened the page again by itself', w && w.page.looks >= 1 && pageLoads > loads0 + 1,
    J({ looks: w && w.page.looks, loads: pageLoads - loads0 }));
  // And it is a new live, as TikTok gives each: the coin count starts again
  // by itself, and the one before is kept as the last stream's (gifts.py).
  const countBefore = (await getJ('/api/gifts/ledger')).coins;
  roomNow = '7000000000000000002';
  liveNow = true;
  const roomsNow = sockets.room.length;
  for (let i = 0; i < 240 && sockets.room.length <= roomsNow; i++) await sleep(250);
  await sleep(1500);
  toRoom(G({ from: user(501, 'NowLive', 'nowlive'), streak: false, coins: 7 }));
  await sleep(2500);
  w = await tiktokStatus();
  check('once the live starts, the reader finds it and reads it', sockets.room.length > roomsNow &&
    w && w.page.live === true && w.page.waiting === false && await n('NowLive') === 1, J(w && w.page));
  const ledNew = await getJ('/api/gifts/ledger');
  check('a new live starts a new coin count by itself, and keeps the last stream\'s',
    ledNew.live === true && ledNew.coins === 7 && ledNew.senders === 1 && countBefore > 0 &&
    ledNew.last && ledNew.last.coins === countBefore,
    J({ coins: ledNew.coins, senders: ledNew.senders, last: ledNew.last && ledNew.last.coins, before: countBefore }));

  // --------------------------------------- 10b. Show the TikTok window
  // Asking to see it saves the choice and starts the reader again - here still
  // hidden, as the rig's always is - and it reads on; then back to hidden.
  const showRes = await post('/api/chat/tiktok/window', { show: true });
  const kept = ((((await getJ('/api/config')) || {}).chat || {}).tiktok || {}).show;
  check('asking to see the TikTok window keeps the choice - and the rig\'s still shows none',
    showRes.ok && showRes.show === true && showRes.shown === false && kept === true, J({ showRes, kept }));
  let again = null;
  for (let i = 0; i < 80; i++) {
    await sleep(250); again = await tiktokStatus();
    if (again && again.state === 'joined' && again.page && again.page.live) break;
  }
  toRoom(G({ from: user(601, 'AfterRestart', 'afterrestart'), streak: false, coins: 3 }));
  await sleep(2500);
  check('the reader started again, and reads', await n('AfterRestart') === 1, J(again && again.page));
  const ledKept = await getJ('/api/gifts/ledger');
  check('the same live, found again after the restart, keeps its coin count',
    ledKept.coins === 10 && ledKept.last && ledKept.last.coins === countBefore,
    J({ coins: ledKept.coins, last: ledKept.last && ledKept.last.coins }));
  const hideRes = await post('/api/chat/tiktok/window', { show: false });
  check('and hidden again', hideRes.ok && hideRes.show === false && hideRes.shown === false, J(hideRes));

  // ------------------------------------------------------------ 11. stop
  await post('/api/chat/disconnect', { service: 'tiktok' });
  await sleep(3000);
  check('stopping closes the reader\'s window', !(await readerAlive()));

  // -------------------------------------------------- put the rig back as found
  await post('/api/debug/tiktok-page', { base: '' });
  await post('/api/live/scene', { id: '' });
  await post(`/api/scenes/${sc.id}/delete`, {});
  await post('/api/commands/save', {
    commands: before.list || [], symbol: before.symbol || '!', budget: before.budget || { count: 5, seconds: 30 },
    floor: before.floor || 'everyone',
  });
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
