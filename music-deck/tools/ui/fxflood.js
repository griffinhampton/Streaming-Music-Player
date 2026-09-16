// T10, fired at: a flood of effect commands, the budget, and the stop.
//
//   node fxflood.js <devtools port> [rig port]
//
// The plan's own words for this step are "rig-tested by firing a flood at it
// and watching what the scene does", so that is what happens: twelve viewers
// hit three effect commands at once, through a fake IRC server and the real
// chat reader, and the scene page is read for what actually reached the stream.
//
// Every claim is paired with the thing that would make it hollow:
//
//   the budget held nine of twelve  - and with the budget off, the same kind
//                                     of flood runs every one (the control)
//   stop cleared the stage          - it was showing, with a picture that
//                                     decoded and a clip really playing, and
//                                     its own timer had seventeen seconds left
//   stop cleared the queue          - the first thing shown after it is the
//                                     NEW picture, not one left waiting
//   a paused stream refuses         - but a moderator's resume gets through,
//                                     and a viewer's does not
//
// Chrome needs --autoplay-policy=no-user-gesture-required, as for fxsound.
// It brings its own pictures and clip and takes them away again.
const net = require('net');
const zlib = require('zlib');
const [port, rigPort = '8799'] = process.argv.slice(2);
const RIG = `http://127.0.0.1:${rigPort}`;
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 240000).unref();

const results = [];
const check = (n, ok, d = '') => {
  results.push([n, !!ok]);
  console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? `  (${d})` : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const post = (path, body) => fetch(RIG + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: J(body || {}),
}).then((r) => r.json());
const getJ = (path) => fetch(RIG + path, { cache: 'no-store' }).then((r) => r.json());

/* ---- pictures of known sizes, so which one is on screen can be measured */
const CRC = [...Array(256)].map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function makePng(size) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const px = [0];
    const bar = y >= size * 0.42 && y < size * 0.58;
    for (let x = 0; x < size; x++) px.push(255, bar ? 255 : 0, bar ? 255 : 200);
    rows.push(Buffer.from(px));
  }
  const chunk = (tag, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(tag, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---- a clip long enough to still be playing when stop is pressed */
function makeWav(seconds, rate = 8000) {
  const n = Math.floor(seconds * rate);
  const data = Buffer.alloc(n);
  for (let i = 0; i < n; i++) data[i] = 128 + Math.round(40 * Math.sin(i * 0.12));
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + n, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate, 28);
  head.writeUInt16LE(1, 32); head.writeUInt16LE(8, 34);
  head.write('data', 36); head.writeUInt32LE(n, 40);
  return Buffer.concat([head, data]);
}

// The effect layer's Audio is never put in the document, so it is caught on
// its way through play() - fxsound's recorder, cut down to what is read here.
const RECORDER = `
  window.__snd = { el: null, started: 0 };
  const _play = Audio.prototype.play;
  Audio.prototype.play = function () {
    window.__snd.el = this;
    const r = _play.apply(this, arguments);
    if (r && r.then) r.then(() => { window.__snd.started++; }, () => {});
    return r;
  };
`;

// The Live view's side of the story, for the checks that depend on what it
// believed at the moment it was clicked: every state-feed message's `paused`,
// every stop or resume the button posted, and marks the probe drops in. One
// check failed once on a run where it had passed before, and "Resume commands"
// alone could not say whether the click sent the wrong thing or a stale
// snapshot arrived after the right one. This says which.
const LIVE_RECORDER = `
  window.__feed = [];
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  const _WS = window.WebSocket;
  window.WebSocket = function (url, p) {
    const ws = p === undefined ? new _WS(url) : new _WS(url, p);
    if (String(url).includes('/ws/events')) {
      ws.addEventListener('message', (e) => {
        try { window.__feed.push(['feed', at(), !!((JSON.parse(e.data).commands || {}).paused)]); } catch (_) {}
      });
    }
    return ws;
  };
  window.WebSocket.prototype = _WS.prototype;
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  const _fetch = window.fetch;
  window.fetch = function (u) {
    if (/\\/api\\/commands\\/(stop|resume)$/.test(String(u))) window.__feed.push(['post', at(), String(u).split('/').pop()]);
    return _fetch.apply(this, arguments);
  };
  window.__mark = (what) => window.__feed.push(['mark', at(), what]);
`;

async function openPage(url, script) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json();
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
  await p.send('Page.enable');
  if (script) await p.send('Page.addScriptToEvaluateOnNewDocument', { source: script });
  await p.send('Page.navigate', { url });
  return p;
}
const closePage = async (p) => {
  try { p.ws.close(); } catch (_) {}
  await fetch(`http://127.0.0.1:${port}/json/close/${p.targetId}`).catch(() => {});
};

let client = null;
const server = net.createServer((sock) => { client = sock; sock.on('data', () => {}); sock.on('error', () => {}); });
let seq = 0;
const say = (who, text, badges = '') => client && client.write(
  `@${badges ? `badges=${badges};` : ''}display-name=${who};id=fl${++seq};user-id=${7000 + seq} ` +
  `:${who.toLowerCase()}!${who.toLowerCase()}@x.tmi.twitch.tv PRIVMSG #somechannel :${text}\r\n`);

const STAGE = `(() => {
  const fx = document.querySelector('.type-effect');
  const al = document.querySelector('.type-alert');
  const m = fx && fx.querySelector('.media');
  const a = window.__snd && window.__snd.el;
  return {
    fxShowing: !!fx && fx.classList.contains('showing'),
    fxOpacity: fx ? Number(getComputedStyle(fx.querySelector('.fx-box')).opacity) : -1,
    src: m ? (m.getAttribute('src') || '') : '',
    nw: m ? (m.naturalWidth || 0) : 0,
    alShowing: !!al && al.classList.contains('showing'),
    alOpacity: al ? Number(getComputedStyle(al.querySelector('.alert-card')).opacity) : -1,
    alText: al ? (al.querySelector('.alert-text') || {}).textContent : '',
    playing: !!(a && !a.paused && !a.ended),
    at: a ? Math.round(a.currentTime * 10) / 10 : -1,
    started: window.__snd ? window.__snd.started : 0,
  };
})()`;

// The microphone layer's bars, read six times 300 ms apart. Chrome's fake
// device beeps, so a live meter changes shape; one whose analyser has been
// torn down keeps its last shape for ever.
const micMoving = async (page) => {
  const seen = [];
  for (let i = 0; i < 6; i++) {
    seen.push(await page.ev(`[...document.querySelectorAll('.type-mic .mic-bars i')].map((b) => b.style.transform).join('|')`));
    await sleep(300);
  }
  return { bars: seen[0] ? seen[0].split('|').length : 0, distinct: new Set(seen).size };
};

const logNow = async () => (await getJ('/api/commands/recent?n=300')).log || [];
const alertsNow = async () => (await getJ('/api/alerts/recent?n=200')).events || [];
const count = (list, key, val) => list.filter((e) => e[key] === val).length;

(async () => {
  const before = (await getJ('/api/config')).commands || {};

  const ups = [];
  for (const [name, data] of [
    ['fxflood-a.png', 'data:image/png;base64,' + makePng(240).toString('base64')],
    ['fxflood-b.png', 'data:image/png;base64,' + makePng(160).toString('base64')],
    ['fxflood-late.png', 'data:image/png;base64,' + makePng(100).toString('base64')],
    ['fxflood-horn.wav', 'data:audio/wav;base64,' + makeWav(8).toString('base64')],
  ]) ups.push(await post('/api/assets/upload', { name, data }));
  check('the probe brought its own pictures and clip', ups.every((u) => u.ok && u.id), J(ups.map((u) => u.reason || u.id)));
  if (!ups.every((u) => u.ok)) { console.log('\n0 of 1 passed'); process.exit(1); }
  const [picA, picB, picLate, horn] = ups.map((u) => u.id);

  await new Promise((r) => server.listen(6667, '127.0.0.1', r));
  await post('/api/debug/chat-endpoint', { host: '127.0.0.1', port: 6667, tls: false });
  await post('/api/chat/connect', { service: 'twitch', channel: 'SomeChannel' });
  // No cooldowns on anything: every limit that shows up here is the budget's.
  const LIST = [
    { name: 'horn', action: 'sound', target: horn },
    { name: 'pic', action: 'gif', target: picA },
    { name: 'pic2', action: 'gif', target: picB },
    { name: 'late', action: 'gif', target: picLate },
    { name: 'hush', action: 'stop', target: '', role: 'mod' },
    { name: 'unhush', action: 'stop', target: 'resume', role: 'mod' },
  ];
  const saved = await post('/api/commands/save', { commands: LIST, symbol: '!', budget: { count: 3, seconds: 60 } });
  check('the budget was saved as asked', saved.ok && J(saved.budget) === J({ count: 3, seconds: 60 }), J(saved.budget));

  const scene = (await post('/api/scenes', { name: 'FX flood probe', format: 'horizontal' })).scene;
  const full = await getJ(`/api/scenes/${scene.id}`);
  full.background = { mode: 'solid', color: '#101014' };
  full.layers = [{
    // Its own picture is the fallback for the horn, which names only a clip -
    // so the first thing on screen has a picture to measure AND a clip playing.
    // Twenty seconds each, so nothing leaves on its own timer during the test.
    id: 'fxf', name: 'FX', type: 'effect', visible: true, locked: false, group: '',
    transform: { x: 200, y: 200, w: 520, h: 400, rotation: 0, anchor: 'tl' },
    style: { opacity: 1, blend: 'normal', radius: 0 },
    props: { src: picA, sound: '', volume: 0.3, kinds: 'gif sound', seconds: 20, max: 3, fit: 'contain' },
    triggers: [],
  }, {
    // Listening for everything, on purpose. A stop handed to alert() rather
    // than stop() would reach this one and show as a blank card.
    id: 'alf', name: 'Alerts', type: 'alert', visible: true, locked: false, group: '',
    transform: { x: 900, y: 200, w: 700, h: 200, rotation: 0, anchor: 'tl' },
    style: { opacity: 1, blend: 'normal', radius: 0 },
    props: { kinds: '', seconds: 20, max: 5, size: 34 },
    triggers: [],
  }, {
    // A bystander, and the reason this layer is here is a bug that shipped
    // for one run. The first version of T10 handed its stop to every layer
    // type with a stop() method - and the microphone layer already had one,
    // meaning "tear down my analyser and release the device". Press Stop
    // effects and a meter on stream would freeze until the page reloaded.
    // Nothing on the effect or alert layers could have shown that.
    id: 'micf', name: 'Mic', type: 'mic', visible: true, locked: false, group: '',
    transform: { x: 200, y: 700, w: 600, h: 200, rotation: 0, anchor: 'tl' },
    style: { opacity: 1, blend: 'normal', radius: 0 },
    props: { style: 'bars', bars: 12, gain: 2, color: '#34d399' },
    triggers: [],
  }];
  await post(`/api/scenes/${scene.id}`, { scene: full, expect_rev: full.rev });
  await post('/api/live/scene', { id: scene.id, transition: 'cut' });

  const stage = await openPage(`${RIG}/scene.html?id=${scene.id}`, RECORDER);
  await stage.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  const live = await openPage(`${RIG}/liveview.html`, LIVE_RECORDER);
  await live.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 880, deviceScaleFactor: 1, mobile: false });
  // The stage in front, as the output window is on a real stream. The first
  // run left the Live view in front and failed six checks on a feature that
  // worked: a hidden tab runs no transitions and defers media, so opacity read
  // the reverse of the class and play() never resolved. The Live view needs
  // no frames - its socket, its click() and its text all work unseen.
  await stage.send('Page.bringToFront');
  await sleep(4000);

  const idle = await stage.ev(STAGE);
  check('the stage starts dark', !idle.fxShowing && !idle.alShowing && idle.fxOpacity < 0.05, J(idle));
  const mic0 = await micMoving(stage);
  check('the microphone meter is live before anything happens (the floor for the check after stop)',
    mic0.bars === 12 && mic0.distinct > 1, J(mic0));
  const btn = () => live.ev(`document.getElementById('lvStopFx').textContent.trim()`);
  check('the Live view offers "Stop effects"', (await btn()) === 'Stop effects', await btn());

  // ------------------------------------------------------------ 1. the flood
  const log0 = (await logNow()).length;
  const al0 = (await alertsNow()).length;
  const CMDS = ['!horn', '!pic', '!pic2'];
  for (let i = 0; i < 12; i++) say(`Viewer${i}`, CMDS[i % 3]);
  await sleep(3000);

  const flood = (await logNow()).slice(log0);
  const fx = (await alertsNow()).slice(al0).filter((e) => e.kind === 'gif' || e.kind === 'sound');
  check('the whole flood reached the engine (floor: 12 logged)', flood.length === 12, J(flood.map((e) => e.outcome)));
  check('the budget let exactly 3 through', count(flood, 'outcome', 'ran') === 3, J(flood.map((e) => e.outcome)));
  const held = flood.filter((e) => e.outcome === 'held');
  check('and held the other 9, saying which limit did it',
    held.length === 9 && held.every((e) => /3 every 60 s/.test(e.response)), J(held[0]));
  check('the stream was sent 3 effects, not 12', fx.length === 3, J(fx.map((e) => e.kind)));

  const busy = await stage.ev(STAGE);
  check('the effect is on screen with a picture that decoded',
    busy.fxShowing && busy.fxOpacity > 0.9 && busy.nw === 240, J(busy));
  check('the clip is really playing, not merely asked to', busy.playing && busy.started >= 1 && busy.at > 0, J(busy));
  check('the alert card is showing too', busy.alShowing && busy.alOpacity > 0.9, J(busy));

  // --------------------------------------------- 2. the button, as a person would
  const al1 = (await alertsNow()).length;
  await live.ev(`document.getElementById('lvStopFx').click()`);
  await sleep(1500);

  const cmds = await getJ('/api/commands');
  check('the server says commands are paused', cmds.paused === true, J(cmds.paused));
  check('the button now offers the way back', (await btn()) === 'Resume commands', await btn());
  const dark = await stage.ev(STAGE);
  check('the effect went dark at once, with its own timer still running',
    !dark.fxShowing && dark.fxOpacity < 0.05, J(dark));
  check('the clip stopped', !dark.playing, J(dark));
  check('the alert card went too, and no blank card took its place',
    !dark.alShowing && dark.alOpacity < 0.05, J(dark));
  const stops = (await alertsNow()).slice(al1).filter((e) => e.kind === 'stop');
  check('exactly one stop reached the canvas', stops.length === 1, J(stops.length));
  const mic1 = await micMoving(stage);
  check('and it left the microphone meter alone - still moving, not frozen',
    mic1.bars === 12 && mic1.distinct > 1, J(mic1));

  await live.ev(`CmdPanel.open(document.getElementById('lvCmds'))`);
  await sleep(1200);
  const panel = await live.ev(`({
    note: !document.querySelector('#cmdPanel [data-cmd="paused"]').hidden,
    count: document.querySelector('#cmdPanel [data-cmd="bcount"]').value,
    secs: document.querySelector('#cmdPanel [data-cmd="bseconds"]').value })`);
  check('the command panel says commands are paused', panel.note, J(panel));
  check('and shows the budget in force', panel.count === '3' && panel.secs === '60', J(panel));

  // ---------------------------------------------------------- 3. while paused
  const log2 = (await logNow()).length;
  const al2 = (await alertsNow()).length;
  say('Someone', '!pic');
  say('Someone', '!unhush');                       // not a mod
  await sleep(1500);
  const whilePaused = (await logNow()).slice(log2);
  check('a viewer\'s command is refused as paused', whilePaused[0] && whilePaused[0].outcome === 'paused', J(whilePaused));
  check('and a viewer cannot resume what was stopped', whilePaused[1] && whilePaused[1].outcome === 'denied', J(whilePaused));
  check('nothing reached the stream while paused',
    (await alertsNow()).slice(al2).filter((e) => e.kind === 'gif' || e.kind === 'sound').length === 0);
  check('still dark', !(await stage.ev(STAGE)).fxShowing);

  say('Mo', '!unhush', 'moderator/1');
  await sleep(2000);
  check('a moderator\'s resume gets through the pause', (await getJ('/api/commands')).paused === false);
  check('and every window heard it - the button changed back with nobody pressing it',
    (await btn()) === 'Stop effects', await btn());
  check('the panel\'s note went with it, from the state feed',
    await live.ev(`document.querySelector('#cmdPanel [data-cmd="paused"]').hidden`));

  // ----------------------------------------- 4. resumed, but the budget still counts
  const log3 = (await logNow()).length;
  say('Viewer99', '!pic');
  await sleep(1200);
  const after = (await logNow()).slice(log3);
  check('resuming lifts the pause, not the budget', after[0] && after[0].outcome === 'held', J(after));

  // ------------------------------- 5. the control: the same kind of flood, no budget
  await post('/api/commands/save', { commands: LIST, symbol: '!', budget: { count: 3, seconds: 0 } });
  const log4 = (await logNow()).length;
  for (let i = 0; i < 6; i++) say(`Late${i}`, '!late');
  await sleep(2500);
  const open = (await logNow()).slice(log4);
  check('with the budget off every one runs (the control)',
    open.length === 6 && count(open, 'outcome', 'ran') === 6, J(open.map((e) => e.outcome)));
  const fresh = await stage.ev(STAGE);
  // The queue claim. stop() emptied a queue holding picA and picB; had it
  // not, the next event would have been shown AFTER them, and the first thing
  // on screen now would be one of those.
  check('the first thing shown after the stop is the NEW picture, not one left queued',
    fresh.fxShowing && fresh.src.endsWith(encodeURIComponent(picLate)) && fresh.nw === 100, J(fresh));

  // ------------------------------------------------ 6. a moderator's stop, from chat
  const al5 = (await alertsNow()).length;
  await live.ev(`window.__mark('hush sent')`);
  say('Mo', '!hush', 'moderator/1');
  await sleep(2000);
  check('a moderator can stop it all from chat', (await getJ('/api/commands')).paused === true);
  const hushed = await stage.ev(STAGE);
  check('and the stage goes dark for that too', !hushed.fxShowing && hushed.fxOpacity < 0.05, J(hushed));
  check('with one stop, and no card for it',
    (await alertsNow()).slice(al5).filter((e) => e.kind === 'stop').length === 1 && !hushed.alShowing);
  // Its own check, before anything is clicked. The resume below once failed
  // with the label still reading "Resume commands", and a click on a Live view
  // that has not yet heard the stop sends stop again - which looks exactly
  // like a resume that did nothing. Splitting the two says which half failed.
  const heard = await btn();
  check('the Live view heard the moderator\'s stop before anyone clicked', heard === 'Resume commands',
    J({ label: heard, liveView: JSON.parse((await live.ev(`JSON.stringify(window.__feed)`)) || '[]').slice(-4) }));

  await live.ev(`window.__mark('click, label ' + document.getElementById('lvStopFx').textContent.trim())`);
  await live.ev(`document.getElementById('lvStopFx').click()`);
  await sleep(1500);
  const resumed = (await getJ('/api/commands')).paused === false;
  const label = await btn();
  // Everything the Live view saw from the hush onwards, repeated feed values
  // folded so the order of changes is readable.
  const story = (await live.ev(`JSON.stringify(window.__feed)`));
  const tail = JSON.parse(story || '[]');
  const from = tail.map((e) => e[2]).lastIndexOf('hush sent');
  const told = tail.slice(Math.max(0, from)).filter((e, i, a) => e[0] !== 'feed' || !a[i - 1] || a[i - 1][0] !== 'feed' || a[i - 1][2] !== e[2]);
  check('the button resumes as well', resumed && label === 'Stop effects',
    J({ server: resumed ? 'resumed' : 'still paused', label, liveView: told }));

  check('nothing was thrown in the scene page', stage.errors.length === 0, stage.errors.slice(0, 2).join(' | '));
  check('nothing was thrown in the Live view', live.errors.length === 0, live.errors.slice(0, 2).join(' | '));

  // -------------------------------------------------- put the rig back as found
  await closePage(stage);
  await closePage(live);
  await post('/api/live/scene', { id: '' });
  await post('/api/chat/disconnect', { service: 'twitch' });
  await post('/api/commands/resume', {});
  await post('/api/commands/save', {
    commands: before.list || [], symbol: before.symbol || '!', budget: before.budget || { count: 5, seconds: 30 },
  });
  await post(`/api/scenes/${scene.id}/delete`, {});
  const dels = [];
  for (const id of [picA, picB, picLate, horn]) dels.push(await post('/api/assets/delete', { id }));
  const back = await getJ('/api/commands');
  check('the rig was put back: commands, budget, not paused, assets gone',
    back.paused === false && J(back.budget) === J(before.budget || { count: 5, seconds: 30 }) &&
    back.commands.length === (before.list || []).length && dels.every((d) => d.ok !== false),
    J({ paused: back.paused, budget: back.budget, n: back.commands.length }));
  server.close();
  if (client) client.destroy();

  const bad = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - bad} of ${results.length} passed`);
  // exitCode rather than process.exit(), for t1shot's reason: let the sockets
  // close properly instead of racing libuv's teardown.
  process.exitCode = bad ? 1 : 0;
})().catch(async (e) => {
  try { await post('/api/commands/resume', {}); } catch (_) {}
  try { await post('/api/chat/disconnect', { service: 'twitch' }); } catch (_) {}
  try { server.close(); if (client) client.destroy(); } catch (_) {}
  console.log('THREW ' + e.message);
  process.exit(2);
});
