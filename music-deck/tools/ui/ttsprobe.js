// T7: chat, read out loud - fired through the real chat reader, heard by the stage.
//
//   node ttsprobe.js <devtools port> [rig port]
//
// Everything real that can be: a fake IRC server feeds the real chat reader,
// the real command engine runs a Voice layer's own command, Windows' own voice
// makes the clip (tts.ps1), and the scene page on air plays it. What is read
// back is what reached the stream: the clip that played, the words on screen,
// and what the log says about the messages that were turned away.
//
// Controls beside each claim:
//   the voice layer answers    - an effect layer listening for EVERYTHING stays dark
//   the clip is speech         - read off the rig as a WAV, with a floor on its size
//   a blocked word is refused  - the same message without it is read
//   Skip ends the clip         - it was still playing, part way through, just before
//   Skip only shows with a voice on air - and goes when the scene does
//
// It never goes near a stream: the first check is that this rig refuses to go
// live anywhere but this PC, and the probe stops if it does not.
// Chrome needs --autoplay-policy=no-user-gesture-required, as for fxsound.
const net = require('net');
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
}).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const getJ = (path) => fetch(RIG + path, { cache: 'no-store' }).then((r) => r.json());

const RECORDER = `
  window.__snd = { plays: [], started: 0, el: null };
  const _play = Audio.prototype.play;
  Audio.prototype.play = function () {
    window.__snd.el = this;
    window.__snd.plays.push(this.src);
    const r = _play.apply(this, arguments);
    if (r && r.then) r.then(() => { window.__snd.started++; }, () => {});
    return r;
  };
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
const say = (who, text) => client && client.write(
  `@display-name=${who};id=tt${++seq};user-id=${9000 + seq} ` +
  `:${who.toLowerCase()}!${who.toLowerCase()}@x.tmi.twitch.tv PRIVMSG #somechannel :${text}\r\n`);

const STAGE = `(() => {
  const sp = document.querySelector('.type-speak');
  const fx = document.querySelector('.type-effect');
  const a = window.__snd && window.__snd.el;
  return {
    showing: !!sp && sp.classList.contains('showing'),
    opacity: sp ? Number(getComputedStyle(sp.querySelector('.speak-card')).opacity) : -1,
    text: sp ? sp.querySelector('.speak-text').textContent : '',
    fxShowing: !!fx && fx.classList.contains('showing'),
    plays: (window.__snd || {}).plays || [],
    started: (window.__snd || {}).started || 0,
    playing: !!(a && !a.paused && !a.ended),
    at: a ? Math.round(a.currentTime * 100) / 100 : -1,
    dur: a && isFinite(a.duration) ? Math.round(a.duration * 100) / 100 : -1,
  };
})()`;

const logNow = async () => (await getJ('/api/commands/recent?n=300')).log || [];
const alertsNow = async () => (await getJ('/api/alerts/recent?n=200')).events || [];
const speaks = (list) => list.filter((e) => e.kind === 'speak');

(async () => {
  // ---------------------------------------------------------- 0. never go live
  const guard = await post('/api/live/start', { url: 'rtmp://example.invalid/live', key: 'x', source: 'page' });
  check('this rig refuses to go live anywhere but this PC (or the probe stops here)',
    guard.ok === false && guard.refused === true, J(guard));
  if (!(guard.ok === false && guard.refused === true)) { console.log('\nnot a guarded rig - stopping'); process.exit(1); }

  const before = (await getJ('/api/config')).commands || {};
  await new Promise((r) => server.listen(6667, '127.0.0.1', r));
  await post('/api/debug/chat-endpoint', { host: '127.0.0.1', port: 6667, tls: false });
  await post('/api/chat/connect', { service: 'twitch', channel: 'SomeChannel' });
  // An empty list and no budget: whatever is read out, the Voice layer's own
  // command did it, and no check here is secretly a check of T10.
  await post('/api/commands/save', { commands: [], symbol: '!', budget: { count: 5, seconds: 0 } });

  const mk = async (name, layers) => {
    const s = (await post('/api/scenes', { name, format: 'horizontal' })).scene;
    const full = await getJ(`/api/scenes/${s.id}`);
    full.background = { mode: 'solid', color: '#101014' };
    full.layers = layers;
    await post(`/api/scenes/${s.id}`, { scene: full, expect_rev: full.rev });
    return s.id;
  };
  const S = await mk('Voice probe', [{
    id: 'voice', name: 'Voice', type: 'speak', visible: true, locked: false, group: '',
    transform: { x: 160, y: 820, w: 1600, h: 140, rotation: 0, anchor: 'tl' },
    style: { opacity: 1, blend: 'normal', radius: 0 },
    props: { command: 'tts', role: 'everyone', cooldown: 0, user_cooldown: 0, maxlen: 60, max: 3,
             blocked: 'badword', sayname: true, show: true, volume: 0.3, size: 30 },
    triggers: [],
  }, {
    id: 'fx', name: 'Everything', type: 'effect', visible: true, locked: false, group: '',
    transform: { x: 160, y: 120, w: 480, h: 480, rotation: 0, anchor: 'tl' },
    style: { opacity: 1, blend: 'normal', radius: 0 },
    props: { src: '', kinds: '', seconds: 20, max: 3 },
    triggers: [],
  }]);
  const EMPTY = await mk('Voice probe, no voice', []);
  await post('/api/live/scene', { id: S, transition: 'cut' });

  const live = await openPage(`${RIG}/liveview.html`);
  const stage = await openPage(`${RIG}/scene.html?follow=1`, RECORDER);
  await stage.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await stage.send('Page.bringToFront');                       // fxflood's lesson
  await sleep(4000);

  const skipBtn = () => live.ev(`document.getElementById('lvSkip').hidden`);
  check('the Live view shows Skip while a voice is on air', (await skipBtn()) === false);

  // ------------------------------------------------------ 1. one message, read
  const log0 = (await logNow()).length, al0 = (await alertsNow()).length;
  say('Amy', '!tts hello from the probe');
  await sleep(3500);
  const fired = (await logNow()).slice(log0);
  check('!tts ran, off nothing but the Voice layer', fired.length === 1 && fired[0].outcome === 'ran', J(fired));
  const ev1 = speaks((await alertsNow()).slice(al0));
  const d1 = (ev1[0] || {}).detail || {};
  check('one speak event, addressed to that layer, carrying a clip',
    ev1.length === 1 && d1.layer === 'voice' && d1.scene === S && /^\/api\/tts\/[0-9a-f]{16}\.wav$/.test(d1.clip || ''), J(d1));
  check('with the words as they will be heard', d1.said === 'Amy says: hello from the probe', J(d1.said));

  const st1 = await stage.ev(STAGE);
  check('the stage played exactly that clip', st1.plays.length >= 1 && st1.plays[0].endsWith(d1.clip), J(st1.plays));
  check('and it really played, not merely was asked to', st1.started >= 1 && (st1.at > 0 || !st1.playing), J(st1));
  check('the words are on screen while it is read', st1.showing && st1.opacity > 0.9 && st1.text === d1.said, J(st1));
  check('a layer listening for everything stayed dark: it was not addressed (the control)', !st1.fxShowing, J(st1));

  const wav = Buffer.from(await (await fetch(RIG + d1.clip)).arrayBuffer());
  check('the clip is a real WAV of speech, not a header (floor: 4 KB)',
    wav.slice(0, 4).toString() === 'RIFF' && wav.slice(8, 12).toString() === 'WAVE' && wav.length > 4000, `${wav.length} bytes`);

  // ------------------------------------------------ 2. what is not read out
  await sleep(3000);                                          // let the first finish
  const log2 = (await logNow()).length, al2 = (await alertsNow()).length;
  say('Bob', '!tts this has badword in it');
  say('Bob', '!tts');
  say('Cy', '!tts see https://evil.example/x now');
  say('Dee', `!tts ${'the quick brown fox jumps over a lazy dog '.repeat(4)}`);
  await sleep(4000);
  const turned = (await logNow()).slice(log2);
  const by = (u) => turned.filter((e) => e.user === u);
  check('a blocked word is refused, and the log says why',
    by('Bob')[0] && by('Bob')[0].outcome === 'failed' && /blocked/.test(by('Bob')[0].response), J(by('Bob')[0]));
  check('an empty !tts is refused too', by('Bob')[1] && by('Bob')[1].outcome === 'failed', J(by('Bob')[1]));
  const said2 = speaks((await alertsNow()).slice(al2)).map((e) => (e.detail || {}).said || '');
  check('neither became something to read', !said2.some((s) => /badword|^Bob/.test(s)), J(said2));
  const cy = said2.find((s) => s.startsWith('Cy'));
  check('a link is read as "a link", never spelled out', cy && /a link/.test(cy) && !/evil/.test(cy), J(cy));
  const dee = said2.find((s) => s.startsWith('Dee'));
  check('a long message is cut to the layer\'s 60 letters, at a word',
    dee && dee.replace(/^Dee says: /, '').length <= 60 && !/\s\S{1,2}$/.test(dee), J(dee));

  // Control for the blocked word: the same message without it is read.
  const al3 = (await alertsNow()).length;
  say('Bob', '!tts this has nothing in it');
  await sleep(2500);
  check('the same message without the word is read (the control)',
    speaks((await alertsNow()).slice(al3)).some((e) => /^Bob says: this has nothing in it$/.test((e.detail || {}).said)));

  // ------------------------------------------------ 3. Skip, and Stop effects
  await sleep(6000);                                          // let the queue drain
  const plays0 = (await stage.ev(STAGE)).plays.length;
  say('Eve', '!tts one two three four five six seven eight nine ten eleven twelve');
  await sleep(2500);
  const mid = await stage.ev(STAGE);
  check('a long clip is playing, part way through (the floor for Skip)',
    mid.plays.length > plays0 && mid.playing && mid.at > 0.2 && (mid.dur < 0 || mid.at < mid.dur - 0.5), J(mid));
  const skipped = await post('/api/tts/skip', {});
  await sleep(800);
  const afterSkip = await stage.ev(STAGE);
  check('Skip ends it', skipped.ok && !afterSkip.playing, J(afterSkip));
  check('and with nothing waiting, the words go too', !afterSkip.showing, J(afterSkip));

  say('Fay', '!tts one two three four five six seven eight nine ten eleven twelve');
  await sleep(2500);
  check('the next one plays after a Skip - it ended one clip, not the voice', (await stage.ev(STAGE)).playing);
  await post('/api/commands/stop', {});
  await sleep(800);
  const stopped = await stage.ev(STAGE);
  check('Stop effects silences the voice too', !stopped.playing && !stopped.showing, J(stopped));
  const log4 = (await logNow()).length;
  say('Gus', '!tts are you still there');
  await sleep(1500);
  check('and while paused, !tts is refused like any command',
    ((await logNow()).slice(log4)[0] || {}).outcome === 'paused');
  await post('/api/commands/resume', {});

  // ------------------------------------------------ 4. set up in the editor
  const editor = await openPage(`${RIG}/canvas.html?scene=${S}`, RECORDER);
  await editor.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(4000);
  await editor.ev(`Editor.select(['voice'])`);
  await sleep(2500);                                          // the voices come from the helper
  const insp = await editor.ev(`(() => {
    const sel = document.querySelector('#inspector select[data-voices]');
    const tag = document.querySelector('#inspector .insp h2 .tag');
    return { tag: tag ? tag.textContent.trim() : '', voices: sel ? [...sel.options].map((o) => o.textContent) : null,
             cmd: (document.querySelector('#inspector [data-lx="props.command"]') || {}).value };
  })()`);
  check('the inspector names the layer "Voice"', insp.tag === 'Voice', J(insp.tag));
  check('and lists Windows\' voices to pick from', insp.voices && insp.voices.length >= 2, J(insp.voices));
  check('with the command on the layer itself', insp.cmd === 'tts', J(insp.cmd));
  await editor.ev(`document.querySelector('#inspector [data-tts-try]').click()`);
  await sleep(3000);
  const heard = await editor.ev(`({ plays: window.__snd.plays, started: window.__snd.started,
    note: document.querySelector('#inspector [data-tts-note]').textContent })`);
  check('"Hear it" plays a clip in the editor', heard.plays.some((s) => /\/api\/tts\/[0-9a-f]{16}\.wav$/.test(s)) && heard.started >= 1, J(heard));

  // ------------------------------------------- 5. Skip goes when the voice does
  await post('/api/live/scene', { id: EMPTY, transition: 'cut' });
  await sleep(2000);
  check('with no voice on air, the Live view hides Skip (the control)', (await skipBtn()) === true);

  for (const [n, p] of [['stage', stage], ['the Live view', live], ['the editor', editor]]) {
    check(`nothing was thrown in ${n}`, p.errors.length === 0, p.errors.slice(0, 2).join(' | '));
  }

  // -------------------------------------------------- put the rig back as found
  for (const p of [stage, live, editor]) await closePage(p);
  await post('/api/live/scene', { id: '' });
  await post('/api/chat/disconnect', { service: 'twitch' });
  await post('/api/commands/resume', {});
  await post('/api/commands/save', {
    commands: before.list || [], symbol: before.symbol || '!', budget: before.budget || { count: 5, seconds: 30 },
  });
  for (const id of [S, EMPTY]) await post(`/api/scenes/${id}/delete`, {});
  const back = await getJ('/api/commands');
  check('the rig was put back', back.paused === false && (back.layers || []).length === 0 &&
    J(back.budget) === J(before.budget || { count: 5, seconds: 30 }), J({ paused: back.paused, budget: back.budget }));
  server.close();
  if (client) client.destroy();

  const bad = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - bad} of ${results.length} passed`);
  process.exitCode = bad ? 1 : 0;
})().catch(async (e) => {
  try { await post('/api/commands/resume', {}); } catch (_) {}
  try { await post('/api/chat/disconnect', { service: 'twitch' }); } catch (_) {}
  try { server.close(); if (client) client.destroy(); } catch (_) {}
  console.log('THREW ' + e.message);
  process.exit(2);
});
