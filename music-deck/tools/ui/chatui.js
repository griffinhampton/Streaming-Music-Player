// S11's check: the chat panel, driven through its own controls, with real
// messages traveling adapter -> ChatHub -> /ws/chat -> the DOM.
//
//   node chatui.js <devtools port> [rig port] [outdir]
//
// The fake IRC server is S10's: a throwaway server on localhost speaking what
// Twitch speaks, with the rig's own adapter aimed at it through
// /api/debug/chat-endpoint. Nothing in the page is mocked - every message
// asserted on here came off a socket, through the real parser, into the real
// hub, and out over the real feed.
//
// Three rules, two of them borrowed from soundpanel.js for the same reasons:
//
//  * Drive the panel's own controls, then ask the SERVER what changed. Posting
//    to /api/chat/connect directly would pass with the panel entirely unwired,
//    which is the one thing this exists to prove.
//  * Assert on what was laid out, not only on what a variable holds. The mic
//    layer once passed every DOM check while rendering a black rectangle.
//  * Check the feed is given back. The panel holds a WebSocket only while it
//    is open; "it works" and "it lets go" are different claims.
const fs = require('fs');
const net = require('net');
const [port, rigPort = '8799', outDir] = process.argv.slice(2);
const RIG = `http://127.0.0.1:${rigPort}`;
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 180000).unref();

const results = [];
const check = (n, ok, d = '') => { results.push([n, !!ok]); console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? `  (${d})` : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

const post = (path, body) => fetch(RIG + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: J(body || {}) });
const getJ = (path) => fetch(RIG + path, { cache: 'no-store' }).then((r) => r.json());

async function open(url) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const p = { ws, id: 0, pending: new Map(), errors: [], targetId: t.id };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && p.pending.has(m.id)) { p.pending.get(m.id)(m); p.pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') p.errors.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n')[0]);
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

// ---------------------------------------------------------------- fake Twitch
let client = null;
const server = net.createServer((sock) => {
  client = sock;
  sock.on('data', () => {});          // CAP/NICK/JOIN/PONG are S10's business
  sock.on('error', () => {});
});
const say = (line) => client && client.write(line + '\r\n');
const privmsg = (who, text, extra = '') =>
  say(`${extra}:${who}!${who}@${who}.tmi.twitch.tv PRIVMSG #somechannel :${text}`);

// What the panel drew, as the page laid it out.
const ROWS = `[...document.querySelectorAll('#chatPanel .cp-msg')].map((m) => ({
  id: m.dataset.id, cls: m.className,
  who: (m.querySelector('.cp-who') || {}).textContent || '',
  text: (m.querySelector('.cp-text') || {}).textContent || '',
  svc: (m.querySelector('.cp-svc') || {}).textContent || '',
  badges: [...m.querySelectorAll('.cp-badge')].map((b) => b.textContent),
  color: (m.querySelector('.cp-who') || {}).style ? m.querySelector('.cp-who').style.color : '',
}))`;

const chatFeeds = async () => (await getJ('/api/feeds')).open
  .filter((f) => f.kind === 'ws' && String(f.page).includes('deck.html')).length;

(async () => {
  const before = await getJ('/api/config');
  const beforeChat = (before || {}).chat || {};

  await new Promise((r) => server.listen(6667, '127.0.0.1', r));
  console.log('fake IRC on 127.0.0.1:6667');
  const patched = await (await post('/api/debug/chat-endpoint', { host: '127.0.0.1', port: 6667, tls: false })).json().catch(() => null);
  check('the rig lets a test aim the adapter at localhost', patched && patched.ok, J(patched));

  const deck = await open(`${RIG}/deck.html`);
  await sleep(3500);

  const feedsBefore = await chatFeeds();
  check('with the panel shut, the page holds no chat feed', feedsBefore === 0, `${feedsBefore} open`);

  // -------------------------------------------------- 1. it opens and connects
  await deck.ev(`document.getElementById('chatBtn').click()`);
  await sleep(1200);
  let dbg = await deck.ev('ChatPanel.debug()');
  check('the Chat button opens the panel', !!dbg && dbg.open, J(dbg && dbg.open));
  check('and it says it is not connected yet', dbg.services.length === 0, J(dbg.services));

  // Through the panel's own input and button, not the API.
  await deck.ev(`(() => {
    const i = document.querySelector('#chatPanel [data-cp="channel"]');
    i.value = 'SomeChannel';
    document.querySelector('#chatPanel [data-cp="go"]').click();
  })()`);
  await sleep(1800);
  const st = await getJ('/api/chat/status');
  const tw = (st.services || [])[0] || {};
  check('the panel\'s own Read it button connects the adapter', tw.state === 'joined' && tw.channel === 'somechannel', J(tw));

  const held = await chatFeeds();
  check('and opening it took a chat feed', held === 1, `${held} open`);

  // ----------------------------------------------------- 2. messages, marked
  privmsg('bob', 'hello there', '@badges=moderator/1;color=#1E90FF;display-name=Bob;id=m1;user-id=9 ');
  privmsg('amy', '!queue a song i like', '@display-name=Amy;id=m2;user-id=10 ');
  privmsg('cat', 'hey @somechannel nice stream', '@display-name=Cat;id=m3;user-id=11 ');
  await sleep(1400);

  let rows = await deck.ev(ROWS);
  const hello = rows.find((r) => r.text === 'hello there');
  check('a message said on the socket is drawn in the panel', !!hello, `${rows.length} row(s)`);
  check('with the name, the color and the badge kept',
    hello && hello.who.startsWith('Bob') && hello.badges.includes('moderator') && /30, 144, 255|#1e90ff/i.test(hello.color),
    J(hello && [hello.who, hello.badges, hello.color]));
  check('and the service marked on it', hello && hello.svc === 'twitch', J(hello && hello.svc));

  const cmd = rows.find((r) => r.text.startsWith('!queue'));
  check('a !command is marked - S12 acts on these', cmd && / cmd\b|cmd$/.test(cmd.cls), J(cmd && cmd.cls));
  const men = rows.find((r) => r.text.includes('@somechannel'));
  check('a mention of the channel is marked', men && /mention/.test(men.cls), J(men && men.cls));
  check('and an ordinary line is marked as neither', hello && !/cmd|mention/.test(hello.cls), J(hello && hello.cls));

  // ------------------------------------------------------ 3. pause on scroll
  // Enough to overflow, so scrolling up is a real position and not a no-op.
  // Sent back to back on purpose: the first run of this reached the page as 12
  // of 40, because the hub's per-subscriber queue was the state feed's depth of
  // 8 - a depth that suits snapshots, where the next one supersedes what was
  // dropped, and not chat, where a dropped line is gone.
  for (let i = 0; i < 40; i++) privmsg('bob', `filler line ${i}`);
  await sleep(1600);
  const hub = await getJ('/api/chat/status');
  check('a burst reaches the page whole, not thinned out', (hub.dropped || 0) === 0, `${hub.dropped} dropped`);
  const scrolled = await deck.ev(`(() => {
    const log = document.querySelector('#chatPanel .cp-log');
    return { scrollable: log.scrollHeight > log.clientHeight + 20, atEnd: log.scrollHeight - log.scrollTop - log.clientHeight < 24 };
  })()`);
  check('the log filled up and followed along', scrolled.scrollable && scrolled.atEnd, J(scrolled));

  await deck.ev(`document.querySelector('#chatPanel .cp-log').scrollTop = 0`);
  await sleep(400);
  const top = await deck.ev(`document.querySelector('#chatPanel .cp-log').scrollTop`);
  privmsg('amy', 'said while you were reading back');
  await sleep(1000);
  const after = await deck.ev(`(() => {
    const log = document.querySelector('#chatPanel .cp-log');
    const b = document.querySelector('#chatPanel [data-cp="new"]');
    return { scrollTop: log.scrollTop, newShown: !b.hidden, label: b.textContent };
  })()`);
  check('reading back is not yanked away by the next message', after.scrollTop === top, `${top} -> ${after.scrollTop}`);
  check('and it says how many arrived while you were up there', after.newShown && /1 new message/.test(after.label), J(after.label));

  await deck.ev(`document.querySelector('#chatPanel [data-cp="new"]').click()`);
  await sleep(600);
  const back = await deck.ev(`(() => {
    const log = document.querySelector('#chatPanel .cp-log');
    return { atEnd: log.scrollHeight - log.scrollTop - log.clientHeight < 24, newShown: !document.querySelector('#chatPanel [data-cp="new"]').hidden };
  })()`);
  check('clicking it goes back to the bottom and the count clears', back.atEnd && !back.newShown, J(back));

  // ------------------------------------------------------- 4. hide and block
  rows = await deck.ev(ROWS);
  const target = rows.find((r) => r.text === 'hello there');
  const drawnBefore = rows.length;
  await deck.ev(`document.querySelector('#chatPanel .cp-msg[data-id="${target.id}"] [data-act="hide"]').click()`);
  await sleep(400);
  rows = await deck.ev(ROWS);
  check('Hide takes that one line away and leaves the rest',
    !rows.some((r) => r.id === target.id) && rows.length === drawnBefore - 1,
    `${drawnBefore} -> ${rows.length}`);

  const amy = (await deck.ev(ROWS)).find((r) => r.who.startsWith('Amy'));
  await deck.ev(`document.querySelector('#chatPanel .cp-msg[data-id="${amy.id}"] [data-act="block"]').click()`);
  await sleep(700);
  rows = await deck.ev(ROWS);
  check('Block takes away everything that person said', !rows.some((r) => r.who.startsWith('Amy')),
    `${rows.filter((r) => r.who.startsWith('Amy')).length} left`);

  // It is kept, and - the reason this check is here - keeping it must not
  // stand on the channel the same config section holds.
  const cfg = await getJ('/api/config');
  check('blocking is remembered', ((cfg.chat || {}).blocked || []).includes('amy'), J((cfg.chat || {}).blocked));
  check('and remembering it did not wipe the channel beside it',
    ((cfg.chat || {}).twitch || {}).channel === 'somechannel', J((cfg.chat || {}).twitch));

  await deck.ev(`document.querySelector('#chatPanel .cp-unblock[data-who="amy"]').click()`);
  await sleep(700);
  rows = await deck.ev(ROWS);
  const cfg2 = await getJ('/api/config');
  check('and it can be undone', rows.some((r) => r.who.startsWith('Amy')) && !((cfg2.chat || {}).blocked || []).includes('amy'),
    J((cfg2.chat || {}).blocked));

  if (outDir) {
    const d = (await deck.send('Page.captureScreenshot', { format: 'png' })).result.data;
    fs.writeFileSync(`${outDir}/chatpanel.png`, Buffer.from(d, 'base64'));
    console.log('   wrote chatpanel.png');
  }

  // ------------------------------------------- 5. the feed is given back, and
  //                                                what was missed is filled in
  await deck.ev(`document.getElementById('chatBtn').click()`);
  // Give it a moment, but not fifteen seconds: the point of the sentinel in
  // feeds.serve_ws_feed is that the release happens when the page hangs up
  // rather than whenever the sender's next timeout happens to come round.
  let shut = 1;
  for (let i = 0; i < 15 && shut; i++) { await sleep(200); shut = await chatFeeds(); }
  check('closing the panel gives the feed back', shut === 0, `${shut} still open`);

  privmsg('dan', 'said while the panel was shut', '@display-name=Dan;id=m9;user-id=12 ');
  await sleep(900);
  await deck.ev(`document.getElementById('chatBtn').click()`);
  await sleep(1600);
  rows = await deck.ev(ROWS);
  check('reopening backfills what was said while it was shut',
    rows.some((r) => r.text === 'said while the panel was shut'),
    `${rows.length} row(s) after reopening`);
  dbg = await deck.ev('ChatPanel.debug()');
  check('and it is on a live feed again, not just the backfill', dbg.feed === true, J(dbg.feed));

  check('nothing was thrown in the deck', deck.errors.length === 0, deck.errors.slice(0, 2).join(' | '));

  // ------------------------------------------- 6. the other page it claims to
  // It is called a shared panel, and canvas.html mounts it too. Saying so is
  // not proof: that page has its own tokens and its own topbar, and until this
  // ran the claim covered twice what had been looked at.
  const canvas = await open(`${RIG}/canvas.html`);
  await sleep(5000);
  await canvas.ev(`document.getElementById('chatBtn').click()`);
  await sleep(1800);
  const cdbg = await canvas.ev('ChatPanel.debug()');
  check('the Canvas Builder mounts the same panel', !!cdbg && cdbg.open, J(cdbg && cdbg.open));
  check('and it opens already reading the channel', ((cdbg.services || [])[0] || [])[2] === 'joined', J(cdbg.services));

  privmsg('eve', 'seen from the canvas', '@display-name=Eve;id=m20;user-id=13 ');
  await sleep(1400);
  const crows = await canvas.ev(ROWS);
  check('a message reaches the panel there too', crows.some((r) => r.text === 'seen from the canvas'),
    `${crows.length} row(s)`);
  check('nothing was thrown in the Canvas Builder', canvas.errors.length === 0, canvas.errors.slice(0, 2).join(' | '));

  if (outDir) {
    const d = (await canvas.send('Page.captureScreenshot', { format: 'png' })).result.data;
    fs.writeFileSync(`${outDir}/chatpanel-canvas.png`, Buffer.from(d, 'base64'));
    console.log('   wrote chatpanel-canvas.png');
  }
  try { canvas.ws.close(); } catch (_) {}
  await fetch(`http://127.0.0.1:${port}/json/close/${canvas.targetId}`).catch(() => {});

  // ------------------------------------------------------------- put it back
  await post('/api/chat/disconnect', { service: 'twitch' });
  await post('/api/config', { chat: { blocked: beforeChat.blocked || [], twitch: beforeChat.twitch || { channel: '', auto: false } } });
  try { deck.ws.close(); } catch (_) {}
  await fetch(`http://127.0.0.1:${port}/json/close/${deck.targetId}`).catch(() => {});
  server.close();
  if (client) client.destroy();

  const bad = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - bad} of ${results.length} passed`);
  process.exit(bad ? 1 : 0);
})().catch(async (e) => {
  try { await post('/api/chat/disconnect', { service: 'twitch' }); } catch (_) {}
  try { server.close(); if (client) client.destroy(); } catch (_) {}
  console.log('THREW ' + e.message);
  process.exit(2);
});
