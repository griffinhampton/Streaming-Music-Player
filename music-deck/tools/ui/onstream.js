// S15's check: events reaching the canvas.
//
//   node onstream.js <devtools port> [rig port] [outdir]
//
// The Live view has its own probe (onair.js); this one is about a scene page,
// because the whole claim of S15 is that what chat sets off appears on the
// stream. A check that stopped at the hub would prove none of it.
//
// S10's fake IRC server again, so the command that fires the alert comes off a
// real socket through the real parser, the real engine and the real bus.
//
// Three claims from the plan get checked here that are easy to write past:
//  * a scene with no alert layer opens no alert socket at all;
//  * a scene with two alert layers still opens one;
//  * an alert already on screen survives a scene switch, which is what the
//    identity() case exists for.
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

let client = null;
const server = net.createServer((sock) => { client = sock; sock.on('data', () => {}); sock.on('error', () => {}); });
const privmsg = (who, text, extra = '') =>
  client && client.write(`${extra}:${who}!${who}@${who}.tmi.twitch.tv PRIVMSG #somechannel :${text}\r\n`);

const alertLayer = (id, x, y, kinds) => ({
  id, name: 'Alerts ' + id, type: 'alert', visible: true, locked: false, group: '',
  transform: { x, y, w: 1400, h: 160, rotation: 0, anchor: 'tl' },
  style: { opacity: 1, blend: 'normal', radius: 0 },
  props: { seconds: 30, size: 44, kinds: kinds || '' },   // 30s: long enough to survive a switch
  triggers: [],
});

// The alert cards this page is drawing, as it laid them out.
const CARDS = `[...document.querySelectorAll('.type-alert')].map((el) => ({
  showing: el.classList.contains('showing'),
  title: (el.querySelector('.alert-title') || {}).textContent || '',
  text: (el.querySelector('.alert-text') || {}).textContent || '',
  visible: getComputedStyle(el.querySelector('.alert-card')).opacity,
}))`;

const sceneFeeds = async () => (await getJ('/api/feeds')).open.filter((f) => String(f.page).includes('scene.html'));

(async () => {
  const beforeCfg = await getJ('/api/config');
  await new Promise((r) => server.listen(6667, '127.0.0.1', r));
  await post('/api/debug/chat-endpoint', { host: '127.0.0.1', port: 6667, tls: false });
  await post('/api/chat/connect', { service: 'twitch', channel: 'SomeChannel' });
  await post('/api/commands/save', { commands: [{ name: 'hello', action: 'say', response: 'hi {user}' }] });

  // Start from nothing open. The rig brings remembered output windows back on
  // a restart, and every scene output is itself a scene.html page holding a
  // feed - which would make the counts below wrong for a reason that has
  // nothing to do with S15.
  const already = await getJ('/api/state');
  for (const [cid, w] of Object.entries(already.windows || {})) {
    if (w && w.open) await post(`/api/components/${encodeURIComponent(cid)}/close`, {});
  }
  await sleep(2000);

  // Two scenes: one with alert layers, one with none.
  const plain = (await (await post('/api/scenes', { name: 'S15 plain', format: 'horizontal' })).json()).scene;
  const withA = (await (await post('/api/scenes', { name: 'S15 alerts', format: 'horizontal' })).json()).scene;
  const withB = (await (await post('/api/scenes', { name: 'S15 alerts two', format: 'horizontal' })).json()).scene;
  for (const [sc, layers] of [[withA, [alertLayer('a1', 240, 120), alertLayer('a2', 240, 400)]],
                              [withB, [alertLayer('b1', 240, 120)]]]) {
    const full = await getJ(`/api/scenes/${sc.id}`);
    full.background = { mode: 'solid', color: '#101014' };
    full.layers = layers;
    await post(`/api/scenes/${sc.id}`, { scene: full, expect_rev: full.rev });
  }

  // ------------------------------------------- 1. a scene that wants nothing
  const none = await open(`${RIG}/scene.html?id=${plain.id}`);
  await sleep(3000);
  const plainFeeds = await sceneFeeds();
  check('a scene with no alert layer opens no alert socket',
    plainFeeds.length === 1, J(plainFeeds.map((f) => f.page)));
  try { none.ws.close(); } catch (_) {}
  await fetch(`http://127.0.0.1:${port}/json/close/${none.targetId}`).catch(() => {});
  await sleep(1500);

  // ------------------------------------ 2. a following page with alert layers
  await post('/api/live/scene', { id: withA.id, transition: 'cut' });
  const page = await open(`${RIG}/scene.html?follow=1`);
  await sleep(3500);
  const feeds = await sceneFeeds();
  check('a scene with two alert layers still opens one alert socket, not two',
    feeds.length === 2, J(feeds.map((f) => f.kind + ' ' + f.page)));

  // ------------------------------------------------ 3. an event reaches them
  privmsg('amy', '!hello', '@display-name=Amy;id=s1;user-id=31 ');
  await sleep(2000);
  const cards = await page.ev(CARDS);
  check('a !command off the socket is drawn on the canvas',
    cards.length === 2 && cards.every((c) => c.showing && c.text === 'hi Amy'), J(cards));
  check('and it is actually visible, not merely marked shown',
    cards.every((c) => Number(c.visible) > 0.9), J(cards.map((c) => c.visible)));

  if (outDir) {
    const shot = (await page.send('Page.captureScreenshot', { format: 'png' })).result.data;
    fs.writeFileSync(`${outDir}/alertlayer.png`, Buffer.from(shot, 'base64'));
    console.log('   wrote alertlayer.png');
  }

  // ------------------------------------------- 4. the state feed stays clean
  const state = await getJ('/api/state');
  check('the state feed carries how many fired and never the events themselves',
    state.alerts && typeof state.alerts.total === 'number' && !J(state.alerts).includes('hi Amy'),
    J(state.alerts));

  // --------------------------------------- 5. it survives a scene switch
  await post('/api/live/scene', { id: withB.id, transition: 'cut' });
  await sleep(2500);
  const after = await page.ev(CARDS);
  check('an alert already on screen survives a scene switch instead of restarting',
    after.length === 1 && after[0].showing && after[0].text === 'hi Amy', J(after));

  // ------------------------------------------------------ 6. the kind filter
  await post('/api/live/scene', { id: withA.id, transition: 'cut' });
  await sleep(2000);
  const onlyReq = await getJ(`/api/scenes/${withA.id}`);
  onlyReq.layers = [alertLayer('a1', 240, 120, 'request')];
  await post(`/api/scenes/${withA.id}`, { scene: onlyReq, expect_rev: onlyReq.rev });
  await sleep(2500);
  await page.ev(`document.querySelectorAll('.type-alert').forEach((el) => el.classList.remove('showing'))`);
  privmsg('amy', '!hello', '@display-name=Amy;id=s2;user-id=31 ');
  await sleep(2000);
  const filtered = await page.ev(CARDS);
  check('a layer listening only for requests ignores a command',
    filtered.length === 1 && filtered[0].showing === false, J(filtered));

  // ------------------------------------------------- 7. the poll layer (S14)
  // A scene holding nothing but a poll layer: it must still open the alert
  // socket, which only happens because TYPES.poll declares an alert() hook.
  // The votes are typed in chat rather than a tally being posted to the bus,
  // so what is checked is the whole path - watcher, coalescing, publish, layer.
  const pollScene = (await (await post('/api/scenes', { name: 'S14 poll', format: 'horizontal' })).json()).scene;
  const pfull = await getJ(`/api/scenes/${pollScene.id}`);
  pfull.background = { mode: 'solid', color: '#101014' };
  pfull.layers = [{
    id: 'pl1', name: 'Poll', type: 'poll', visible: true, locked: false, group: '',
    transform: { x: 300, y: 300, w: 1320, h: 420, rotation: 0, anchor: 'tl' },
    style: { opacity: 1, blend: 'normal', radius: 0 },
    props: { size: 40 }, triggers: [],
  }];
  await post(`/api/scenes/${pollScene.id}`, { scene: pfull, expect_rev: pfull.rev });
  await post('/api/live/scene', { id: pollScene.id, transition: 'cut' });
  await sleep(2500);

  const pollFeeds = await sceneFeeds();
  check('a scene with only a poll layer still opens the alert socket',
    pollFeeds.length === 2, J(pollFeeds.map((f) => f.kind + ' ' + f.page)));

  await post('/api/polls/open', { question: 'Which song next?', choices: ['Sabotage', 'Intergalactic'] });
  await sleep(1200);
  privmsg('amy', '!1', '@display-name=Amy;id=v1;user-id=41 ');
  privmsg('bob', '!1', '@display-name=Bob;id=v2;user-id=42 ');
  privmsg('cat', '!2', '@display-name=Cat;id=v3;user-id=43 ');
  await sleep(2500);                    // past the coalescing window

  const drawn = await page.ev(`(() => {
    const el = document.querySelector('.type-poll');
    if (!el) return { missing: true };
    return {
      showing: el.classList.contains('showing'),
      question: (el.querySelector('.poll-q') || {}).textContent || '',
      labels: [...el.querySelectorAll('.poll-label')].map((n) => n.textContent),
      counts: [...el.querySelectorAll('.poll-count')].map((n) => n.textContent),
    };
  })()`);
  check('votes typed in chat reach the bars on the canvas',
    drawn.showing && drawn.question === 'Which song next?' && drawn.labels.join('|') === 'Sabotage|Intergalactic',
    J(drawn));
  check('and the counts are what was voted', /^2\b/.test(drawn.counts[0] || '') && /^1\b/.test(drawn.counts[1] || ''),
    J(drawn.counts));

  // The check that matters, and the reason it is written this way: S7's
  // microphone layer passed "24 bars", "30 different shapes" and "24 above the
  // floor" while every bar had flexed to zero width and the layer drew a black
  // rectangle. Measure what was laid out.
  const laid = await page.ev(`(() => {
    const fills = [...document.querySelectorAll('.type-poll .poll-track > i')];
    const track = document.querySelector('.type-poll .poll-track');
    return {
      bars: fills.length,
      trackW: track ? Math.round(track.getBoundingClientRect().width) : 0,
      widths: fills.map((f) => Math.round(f.getBoundingClientRect().width)),
    };
  })()`);
  check('the bars have real width on screen, not just a style attribute',
    laid.bars === 2 && laid.trackW > 200 && laid.widths[0] > laid.widths[1] && laid.widths[1] > 0,
    J(laid));

  // Photograph the bars while the poll is still open. getBoundingClientRect
  // proves they are not zero-width, which is the specific way S7's microphone
  // layer went wrong - it cannot say whether they are legible, sensibly
  // proportioned, or the right color. Only looking does that.
  if (outDir) {
    const shot = (await page.send('Page.captureScreenshot', { format: 'png' })).result.data;
    fs.writeFileSync(`${outDir}/polllayer.png`, Buffer.from(shot, 'base64'));
    console.log('   wrote polllayer.png');
  }

  await post('/api/polls/close');
  await sleep(1500);
  const closed = await page.ev(`(document.querySelector('.type-poll') || {}).className || ''`);
  check('closing leaves the result up rather than blanking it',
    /showing/.test(closed), J(closed));

  await post(`/api/scenes/${pollScene.id}/delete`, {});

  check('nothing was thrown in the scene page', page.errors.length === 0, page.errors.slice(0, 2).join(' | '));

  // ------------------------------------------------------------- put it back
  try { page.ws.close(); } catch (_) {}
  await fetch(`http://127.0.0.1:${port}/json/close/${page.targetId}`).catch(() => {});
  await post('/api/live/scene', { id: '' });
  await post('/api/chat/disconnect', { service: 'twitch' });
  await post('/api/commands/save', { commands: ((beforeCfg || {}).commands || {}).list || [] });
  for (const sc of [plain, withA, withB]) await post(`/api/scenes/${sc.id}/delete`, {});
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
