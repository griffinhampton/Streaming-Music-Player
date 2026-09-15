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
const ops = [];

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
  let at = 0;
  (async function tick() {
    try { const all = await (await fetch('/ops')).json(); for (; at < all.length; at++) draw(all[at]); } catch (_) {}
    setTimeout(tick, 250);
  })();
</script></body></html>`;
const fixture = http.createServer((req, res) => {
  if (req.url === '/ops') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(J(ops)); return; }
  // Stand-ins for TikTok's image servers, and for what the app must refuse
  // from them: a redirect, and a page that calls itself a PNG.
  if (req.url.startsWith('/pic/')) {
    const p = req.url.split('?')[0];
    picHits.push(p);
    if (p === '/pic/r.png') { res.writeHead(302, { Location: '/pic/redirected.png' }); res.end(); return; }
    if (p === '/pic/page.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end('<html>not a picture</html>'); return; }
    if (p === '/pic/face.png' || p === '/pic/redirected.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PIC); return; }
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
  await post('/api/commands/save', { commands: [
    { name: 'hello', action: 'say', response: 'hi {user}' },
    { name: 'modonly', action: 'say', role: 'mod', response: 'ok' },
    { name: 'mine', action: 'say', role: 'broadcaster', response: 'yours' },
  ], symbol: '!', budget: { count: 5, seconds: 0 } });
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

  // ------------------------------------------ 7. chat from the room socket
  const chatNow = async () => ((await getJ('/api/chat/recent?n=300')).messages || []).filter((m) => m.service === 'tiktok');
  const logNow = async () => (await getJ('/api/commands/recent?n=300')).log || [];
  const log0 = (await logNow()).length;
  toRoom(C({ from: user(201, 'Whatever I Call Myself', 'probe'), text: '!mine' }));
  toRoom(C({ from: user(202, 'probe', 'copycat'), text: '!mine' }));
  toRoom(C({ from: user(203, 'ModMo', 'modmo'), text: '!modonly', flags: [1, 2, 3, 4, 5] }));
  toRoom(C({ from: user(204, 'Plain', 'plain'), text: '!modonly', flags: [1, 2, 3, 4] }));
  toRoom(C({ from: user(205, 'Old', 'old'), text: '!hello', history: true }));
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
  toRoom(G({ from: user(301, 'Pixie', 'pixie', [`${P}/face.png?x-expires=1&x-signature=a`]), streak: false }));
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
  toRoom(G({ from: user(301, 'Pixie', 'pixie', [`${P}/face.png?x-expires=2&x-signature=b`]), streak: false, gid: 5656, name: 'Heart' }));
  await sleep(2500);
  check('the same picture under a newly signed link is fetched once, not again', picHits.filter((h) => h === '/pic/face.png').length === 1, J(picHits));
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

  // ------------------------------------------------------------ 9. stop
  await post('/api/chat/disconnect', { service: 'tiktok' });
  await sleep(3000);
  check('stopping closes the reader\'s window', !(await readerAlive()));

  // -------------------------------------------------- put the rig back as found
  await post('/api/debug/tiktok-page', { base: '' });
  await post('/api/live/scene', { id: '' });
  await post(`/api/scenes/${sc.id}/delete`, {});
  await post('/api/commands/save', {
    commands: before.list || [], symbol: before.symbol || '!', budget: before.budget || { count: 5, seconds: 30 },
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
