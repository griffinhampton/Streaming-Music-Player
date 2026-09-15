// T4/T5: TikTok chat, read from a live page - here, a fixture shaped like one.
//
//   node tiktokchat.js <devtools port> [rig port]
//
// The real thing is the user's own signed-in TikTok live page; that cannot be
// tested here, and the probe does not try. What it tests is everything the app
// does with such a page: the rig's reader opens a Chrome of its own (headless
// on the rig), connects to it over DevTools, injects its read-only script, and
// hands each chat line to the same pipeline Twitch uses - commands, roles and
// all. The fixture is served by this script and drawn in the shape TikTok's
// real room page had on 2026-09-15: the data-e2e attributes, the words after
// the name's row, badge images, recycled [data-index] slots, no profile links.
// Whether the real page still has that shape is tools/ui/ttreal.js's question.
//
// Controls:
//   a new line arrives       - the backlog on screen at attach does NOT
//   a moderator passes a gate - a plain viewer does not
//   the streamer is the broadcaster by profile link - a viewer who copies the
//                              streamer's display name is nobody
//   signed in is reported     - it said signed OUT first, before the button went
//   nothing a chatter types runs - the attack lines arrive, as literal text
//   stopping closes the window - it answered on its DevTools port just before
//
// It never goes near a stream: the first check is the rig's refusal to go live
// anywhere but this PC, and the probe stops if it is missing.
const http = require('http');
const fs = require('fs');
const path = require('path');
const [port, rigPort = '8799'] = process.argv.slice(2);
const RIG = `http://127.0.0.1:${rigPort}`;
const FIXTURE_PORT = 6790;
// The rig's reader profile, beside the repo - found from here, never spelled out.
const PORT_FILE = path.resolve(__dirname, '..', '..', '..', '.rig', 'testrig', 'cache', 'chrome-tiktok', 'DevToolsActivePort');
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

/* ---- the fixture: a page in the shape TikTok's live page draws its chat.
   Like TikTok, it draws what people typed as text (esc), so the reader sees
   the literal characters - which is what an attack on it would look like. */
const ops = [];
// Drawn in the shape TikTok's real room page had on 2026-09-15, as recorded
// by tools/ui/ttreal.js's first run: the list under live-chat-container (no
// chat-room any more), an avatar, a row holding a level badge and the name,
// the words in a utility-classed element after that row, a more-actions button
// - and no profile link on a line. The one line here with a link is the
// streamer's, kept only so that path stays tested; TikTok draws none today.
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>fixture live</title></head><body>
<div class="header"><button class="login"><div>Log in</div></button></div>
<div data-e2e="live-chat-container"><div class="list"></div></div>
<script>
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  // The words sit in a break-words element inside another break-words that
  // also holds the name's row (measured on a real room, 2026-09-15) - which is
  // how the first version read every line as the name and the words together.
  function line(o) {
    const avatar = '<img class="avatar" src="/a.png">';
    return '<div data-e2e="chat-message" class="relative flex">' +
      '<div class="flex self-start py-2"><div class="w-24 h-24 flex">' +
        (o.login ? '<a href="/@' + esc(o.login) + '">' + avatar + '</a>' : avatar) + '</div></div>' +
      '<div class="flex flex-col justify-center">' +
        '<div class="w-full break-words align-middle">' +
          '<div class="inline-flex"><div class="inline-flex items-center overflow-x-hidden">' +
            '<span class="inline-flex flex-shrink-0 py-1"><img src="/img/' + esc(o.badge || 'grade') + '_badge_1.png"><span class="text-[10px]">7</span></span>' +
            '<div data-e2e="message-owner-name" class="flex overflow-hidden inline">' + esc(o.name) + '</div>' +
          '</div></div>' +
          // o.plain drops the class, so the structural rule has to find the words.
          '<div data-fx="words" class="' + (o.plain ? 'w-full' : 'w-full break-words') + '">' + esc(o.text) + '</div>' +
        '</div>' +
      '</div>' +
      '<div data-e2e="more-action-button" class="moreActionButton w-16 h-16"><svg></svg></div></div>';
  }
  const list = document.querySelector('[data-e2e="live-chat-container"] .list');
  // The backlog: on screen before the reader attaches, so it must never be sent.
  const old = document.createElement('div'); old.setAttribute('data-index', '1');
  old.innerHTML = line({ name: 'Old User', text: '!hello from the backlog' }); list.appendChild(old);
  function apply(op) {
    if (op.op === 'add') { const d = document.createElement('div'); d.setAttribute('data-index', String(op.index)); d.innerHTML = line(op); list.appendChild(d); }
    if (op.op === 'recycle') {
      const slot = list.querySelector('[data-index="' + op.from + '"]');
      slot.setAttribute('data-index', String(op.index));
      slot.querySelector('[data-e2e="message-owner-name"]').textContent = op.name;
      slot.querySelector('[data-fx="words"]').textContent = op.text;
    }
    // The Log in button is the plain kind - no id, only the words - which is
    // the one a real room page drew that the first signed-in check missed.
    if (op.op === 'signin') { const b = document.querySelector('.header .login'); if (b) b.remove(); }
  }
  let at = 0;
  async function tick() {
    try { const all = await (await fetch('/ops')).json(); for (; at < all.length; at++) apply(all[at]); } catch (_) {}
    setTimeout(tick, 250);
  }
  tick();
</script></body></html>`;
const fixture = http.createServer((req, res) => {
  if (req.url === '/ops') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(J(ops)); return; }
  if (/^\/@[a-z0-9._]+\/live/.test(req.url)) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(FIXTURE); return; }
  res.writeHead(404); res.end();
});

const chatNow = async () => ((await getJ('/api/chat/recent?n=300')).messages || []).filter((m) => m.service === 'tiktok');
const logNow = async () => (await getJ('/api/commands/recent?n=300')).log || [];
const tiktokStatus = async () => ((await getJ('/api/chat/status')).services || []).find((s) => s.service === 'tiktok') || null;
const readerAlive = async () => {
  let p = 0;
  try { p = Number(fs.readFileSync(PORT_FILE, 'utf8').split('\n')[0]); } catch (_) { return false; }
  try { return (await fetch(`http://127.0.0.1:${p}/json/version`)).ok; } catch (_) { return false; }
};
// What an attack would leave behind if it worked: a flag set, or an <img src=x>.
const PWNED = `({ pwned: window.__pwned === undefined ? null : window.__pwned,
  imgs: document.querySelectorAll('img[src="x"]').length, scripts: [...document.scripts].filter((s) => /__pwned/.test(s.textContent)).length })`;

(async () => {
  // ---------------------------------------------------------- 0. never go live
  const guard = await post('/api/live/start', { url: 'rtmp://example.invalid/live', key: 'x', source: 'page' });
  check('this rig refuses to go live anywhere but this PC (or the probe stops here)',
    guard.ok === false && guard.refused === true, J(guard));
  if (!(guard.ok === false && guard.refused === true)) { console.log('\nnot a guarded rig - stopping'); process.exit(1); }

  const before = (await getJ('/api/config')).commands || {};
  await new Promise((r) => fixture.listen(FIXTURE_PORT, '127.0.0.1', r));
  const pointed = await post('/api/debug/tiktok-page', { base: `http://127.0.0.1:${FIXTURE_PORT}` });
  check('the rig points its reader at the fixture', pointed.ok, J(pointed));
  const outside = await post('/api/debug/tiktok-page', { base: 'https://evil.example' });
  check('and refuses to point it anywhere that is not this PC', outside.status === 400, J(outside));
  await post('/api/commands/save', { commands: [
    { name: 'hello', action: 'say', response: 'hi {user}' },
    { name: 'modonly', action: 'say', role: 'mod', response: 'ok' },
    { name: 'mine', action: 'say', role: 'broadcaster', response: 'yours' },
  ], symbol: '!', budget: { count: 5, seconds: 0 } });

  // A scene on air with an alert card, where a command's answer - which can
  // carry a chatter's display name - is drawn on stream.
  const sc = (await post('/api/scenes', { name: 'TikTok chat probe', format: 'horizontal' })).scene;
  const full = await getJ(`/api/scenes/${sc.id}`);
  full.layers = [{ id: 'al', name: 'Alerts', type: 'alert', visible: true, locked: false, group: '',
    transform: { x: 100, y: 100, w: 1600, h: 200, rotation: 0, anchor: 'tl' },
    // One second each: an alert card shows its queue one at a time, and the
    // first run of this probe read the card while "hi Bob" - twenty seconds
    // of it - was still up, with the answer it was looking for queued behind.
    style: { opacity: 1, blend: 'normal', radius: 0 }, props: { kinds: 'command', seconds: 1, max: 20, size: 30 }, triggers: [] }];
  await post(`/api/scenes/${sc.id}`, { scene: full, expect_rev: full.rev });
  await post('/api/live/scene', { id: sc.id, transition: 'cut' });
  const stage = await openPage(`${RIG}/scene.html?follow=1`);
  await stage.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });

  // ------------------------------------------------------------ 1. connect
  const c = await post('/api/chat/connect', { service: 'tiktok', channel: '@probe' });
  check('connecting starts the reader', c.ok && c.status && c.status.channel === 'probe', J(c));
  let st = null;
  const early = [];
  for (let i = 0; i < 80; i++) {
    await sleep(250); st = await tiktokStatus();
    if (st && st.page) early.push(st.page);
    if (st && st.page && st.page.room) break;
  }
  check('it opened the page and found the chat list', st && st.state === 'joined' && st.page && st.page.room === true, J(st));
  // The reader runs from the page's first moment (T6), before any Log in
  // button is drawn; the first version of that read a blank page as signed in.
  check('it never says signed in before the page has drawn itself', !early.some((p) => p.signed_in === true && !p.room),
    J(early.map((p) => [p.room, p.signed_in]).slice(0, 6)));
  // Chat comes from the room socket now; the page's drawing is the fallback,
  // never in the first seconds after the page opens - when TikTok draws its
  // backlog - and only when no room socket is heard. This fixture has none.
  ops.push({ op: 'add', index: 30, name: 'Early', text: 'drawn in the first seconds' });
  for (let i = 0; i < 100; i++) { await sleep(250); st = await tiktokStatus(); if (st && st.page && st.page.chat_from === 'page') break; }
  check('with no room socket, the page\'s drawing takes over after the wait', st && st.page && st.page.chat_from === 'page', J(st && st.page));
  check('and says the page is signed out while the Log in button is there', st && st.page && st.page.signed_in === false, J(st && st.page));
  check('the reader window answers on its own DevTools port (the floor for stopping)', await readerAlive());

  // ------------------------------------------------------------ 2. lines
  await sleep(1500);
  const backlog = (await chatNow()).filter((m) => /backlog/.test(m.text));
  check('what was on screen at attach is history - not sent', backlog.length === 0, J(backlog));
  check('a line drawn in the first seconds, when TikTok draws its backlog, is not sent either',
    (await chatNow()).filter((m) => m.user.name === 'Early').length === 0);

  const log0 = (await logNow()).length;
  // No logins: TikTok's lines carry none. Amy's words have no break-words
  // class, so only the structural rule can find them.
  ops.push({ op: 'add', index: 2, name: 'Amy', plain: true, text: 'hello from tiktok' });
  ops.push({ op: 'add', index: 3, name: 'Bob', text: '!hello' });
  ops.push({ op: 'add', index: 4, name: 'Cy', text: '!modonly' });
  ops.push({ op: 'add', index: 5, name: 'Mo', badge: 'moderator', text: '!modonly' });
  ops.push({ op: 'add', index: 6, name: 'The Streamer', login: 'probe', text: '!mine' });
  ops.push({ op: 'add', index: 7, name: 'probe', text: '!mine' });
  await sleep(2500);
  const lines = await chatNow();
  const amy = lines.find((m) => m.user.name === 'Amy');
  check('a new line arrives, through the same pipeline Twitch uses', amy && amy.text === 'hello from tiktok', J(amy));
  check('the words were found by the line\'s structure, with no class to go on', !!amy);
  const log = (await logNow()).slice(log0);
  const o = (who, cmd) => (log.find((e) => e.user === who && e.command === cmd) || {}).outcome;
  check('a TikTok viewer runs a command', o('Bob', 'hello') === 'ran', J(log.map((e) => [e.user, e.command, e.outcome])));
  check('its answer is filled in with their name', (log.find((e) => e.user === 'Bob') || {}).response === 'hi Bob');
  check('a mod-only command is denied to a plain viewer', o('Cy', 'modonly') === 'denied');
  check('and runs for a TikTok moderator, by the badge on their line', o('Mo', 'modonly') === 'ran');
  check('the streamer is the broadcaster, by their profile link', o('The Streamer', 'mine') === 'ran');
  check('a viewer who copies the streamer\'s display name is nobody (the control)', o('probe', 'mine') === 'denied');

  // A slot TikTok recycles: rewritten in place, read once.
  ops.push({ op: 'recycle', from: 3, index: 8, name: 'Dee', text: 'a recycled line' });
  await sleep(2000);
  const dee = (await chatNow()).filter((m) => m.user.name === 'Dee');
  check('a recycled slot is read as the new line it became, once', dee.length === 1 && dee[0].text === 'a recycled line', J(dee.map((m) => m.text)));

  ops.push({ op: 'signin' });
  await sleep(3000);
  check('signing in is noticed', ((await tiktokStatus()) || {}).page.signed_in === true);

  // ------------------------------------------ 3. nothing a chatter types runs
  const EVIL_NAME = '<img src=x onerror=window.__pwned=1>';
  const EVIL_TEXT = '<script>window.__pwned=2</script><img src=x onerror="window.__pwned=3">';
  ops.push({ op: 'add', index: 20, name: EVIL_NAME, text: '!hello' });
  ops.push({ op: 'add', index: 21, name: 'Eve', text: EVIL_TEXT });
  ops.push({ op: 'add', index: 22, name: 'Rev', text: 'abc' + String.fromCharCode(0x202E) + 'dcba' });
  await sleep(3000);
  const evil = await chatNow();
  const e2 = evil.find((m) => m.user.name === 'Eve');
  check('an attack line arrives as the literal characters typed', e2 && e2.text === EVIL_TEXT, J(e2 && e2.text));
  const e3 = evil.find((m) => m.user.name === 'Rev');
  check('a direction override is stripped, so it cannot flip words on stream', e3 && e3.text === 'abcdcba', J(e3 && e3.text));
  const e1 = evil.find((m) => m.user.name === EVIL_NAME);
  check('a display name made of markup is kept as text too', !!e1, J(evil.map((m) => m.user.name)));

  // Everything the card shows while its queue plays through.
  const cards = new Set();
  for (let i = 0; i < 48 && !cards.has('hi ' + EVIL_NAME); i++) {
    (await stage.ev(`[...document.querySelectorAll('.type-alert .alert-text')].map((n) => n.textContent)`)).forEach((t) => cards.add(t));
    await sleep(250);
  }
  const onStream = await stage.ev(`(${PWNED})`);
  check('on stream, the command\'s answer shows the name as text - "hi <img...>" literally',
    cards.has('hi ' + EVIL_NAME), J([...cards]).slice(0, 200));
  check('and nothing ran on the stream page: no flag set, no <img src=x>, no script', onStream.pwned === null && onStream.imgs === 0 && onStream.scripts === 0, J(onStream));

  // ------------------------------------------------------------ 4. the panel
  const live = await openPage(`${RIG}/liveview.html`);
  await sleep(4000);
  const panel = await live.ev(`Object.assign(${PWNED}, {
    pill: document.querySelector('#chatPanel [data-cp="state"]').textContent,
    hint: document.querySelector('#chatPanel [data-cp="tthint"]').textContent,
    stop: !document.querySelector('#chatPanel [data-cp="ttstop"]').hidden,
    shown: [...document.querySelectorAll('#chatPanel .cp-text')].map((n) => n.textContent).filter((t) => t.includes('__pwned')) })`);
  check('the chat panel names the TikTok channel it reads', /@probe/.test(panel.pill), J(panel.pill));
  check('and says it is reading, in words', /Reading your live chat/.test(panel.hint), J(panel.hint));
  check('with Stop on offer', panel.stop);
  check('the attack lines are in the chat panel as text', panel.shown.includes(EVIL_TEXT), J(panel.shown));
  check('and nothing ran in the Live view: no flag set, no <img src=x>, no script', panel.pwned === null && panel.imgs === 0 && panel.scripts === 0, J(panel));
  for (const [n, p] of [['the stream page', stage], ['the Live view', live]]) {
    check(`nothing was thrown in ${n}`, p.errors.length === 0, p.errors.slice(0, 2).join(' | '));
  }
  await closePage(live);
  await closePage(stage);

  // ------------------------------------------------------------ 5. stop
  await post('/api/chat/disconnect', { service: 'tiktok' });
  await sleep(3000);
  check('stopping closes the reader\'s window', !(await readerAlive()));
  check('and the service is gone from the hub', (await tiktokStatus()) === null);
  // The username is kept (config.chat.tiktok), so the panel offers it again
  // next time rather than asking for it every stream.
  const again = await openPage(`${RIG}/liveview.html`);
  await sleep(3000);
  const offered = await again.ev(`document.querySelector('#chatPanel [data-cp="ttname"]').value`);
  check('next time, the panel offers the TikTok username it used', offered === 'probe', J(offered));
  await closePage(again);

  // -------------------------------------------------- put the rig back as found
  await post('/api/debug/tiktok-page', { base: '' });
  await post('/api/live/scene', { id: '' });
  await post(`/api/scenes/${sc.id}/delete`, {});
  await post('/api/commands/save', {
    commands: before.list || [], symbol: before.symbol || '!', budget: before.budget || { count: 5, seconds: 30 },
  });
  fixture.close();
  const back = await getJ('/api/commands');
  check('the rig was put back', back.commands.length === (before.list || []).length);

  const bad = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - bad} of ${results.length} passed`);
  process.exitCode = bad ? 1 : 0;
})().catch(async (e) => {
  try { await post('/api/chat/disconnect', { service: 'tiktok' }); } catch (_) {}
  try { await post('/api/debug/tiktok-page', { base: '' }); } catch (_) {}
  try { fixture.close(); } catch (_) {}
  console.log('THREW ' + e.message);
  process.exit(2);
});
