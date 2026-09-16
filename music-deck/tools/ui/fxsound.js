// A chat command that plays a clip on the canvas (T3), end to end.
//
//   node fxsound.js <devtools port> [rig port]
//
// Chrome must be started with --autoplay-policy=no-user-gesture-required, the
// same flag overlay.py:32 gives the app's own windows. Without it play() is
// rejected and this probe would report a broken feature that works.
//
// Two things make this harder to observe than the picture case, and both are
// handled here rather than by changing the app to suit its test:
//
//   The element is detached. `new Audio()` is never put in the document, so
//   querySelector cannot find it. A recorder is injected before the page
//   loads, wrapping Audio.prototype.play and .pause to keep the arguments and
//   a reference to the element itself.
//
//   The clip has to be real. An ID3 header full of zeros uploads happily and
//   then fails to decode, so play() would reject for a reason that has
//   nothing to do with the code under test. This builds an actual WAV - RIFF
//   header and PCM samples - which any browser will decode.
const net = require('net');
const [port, rigPort = '8799'] = process.argv.slice(2);
const RIG = `http://127.0.0.1:${rigPort}`;
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 180000).unref();

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

/* ---- a clip that really decodes: 8-bit mono PCM, half a second of tone */
function makeWav(seconds = 0.5, rate = 8000) {
  const n = Math.floor(seconds * rate);
  const data = Buffer.alloc(n);
  for (let i = 0; i < n; i++) data[i] = 128 + Math.round(60 * Math.sin(i * 0.12));
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + n, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);      // PCM, mono
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate, 28);
  head.writeUInt16LE(1, 32); head.writeUInt16LE(8, 34);      // block align, bits
  head.write('data', 36); head.writeUInt32LE(n, 40);
  return Buffer.concat([head, data]);
}

const RECORDER = `
  window.__snd = { plays: [], pauses: 0, el: null, started: 0, refused: [] };
  const _play = Audio.prototype.play;
  Audio.prototype.play = function () {
    window.__snd.el = this;
    window.__snd.plays.push({ src: this.src, volume: this.volume });
    const r = _play.apply(this, arguments);
    // Whether it actually started, not merely that it was asked to. A
    // rejected promise is what blocked autoplay looks like, and the app
    // swallows that on purpose so the alert loop survives - which means the
    // call being recorded proves nothing on its own.
    if (r && r.then) {
      r.then(() => { window.__snd.started++; },
             (e) => { window.__snd.refused.push(String((e && e.name) || e)); });
    }
    return r;
  };
  const _pause = Audio.prototype.pause;
  Audio.prototype.pause = function () { window.__snd.pauses++; return _pause.apply(this, arguments); };
`;

async function openBlank() {
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
  return p;
}

let client = null;
const server = net.createServer((sock) => { client = sock; sock.on('data', () => {}); sock.on('error', () => {}); });
const privmsg = (who, text, extra = '') =>
  client && client.write(`${extra}:${who}!${who}@${who}.tmi.twitch.tv PRIVMSG #somechannel :${text}\r\n`);

(async () => {
  const beforeCfg = await getJ('/api/config');

  const up = await post('/api/assets/upload', {
    name: 'fxsound-probe.wav',
    data: 'data:audio/wav;base64,' + makeWav().toString('base64'),
  });
  check('a real clip uploads', up.ok && up.id, J(up.reason || up.id));
  if (!up.ok) { console.log('\n0 of 1 passed'); process.exit(1); }
  const clip = up.id;
  check('and the store calls it sound', (await getJ('/api/assets')).assets
    .find((a) => a.id === clip).kind === 'audio');

  await new Promise((r) => server.listen(6667, '127.0.0.1', r));
  await post('/api/debug/chat-endpoint', { host: '127.0.0.1', port: 6667, tls: false });
  await post('/api/chat/connect', { service: 'twitch', channel: 'SomeChannel' });
  await post('/api/commands/save', {
    commands: [{ name: 'snd', action: 'sound', target: clip }], symbol: '!',
  });

  const scene = (await post('/api/scenes', { name: 'FX sound probe', format: 'horizontal' })).scene;
  const full = await getJ(`/api/scenes/${scene.id}`);
  full.background = { mode: 'solid', color: '#101014' };
  // No picture and no sound of its own: whatever plays came from the command.
  full.layers = [{
    id: 'fxs', name: 'FX', type: 'effect', visible: true, locked: false, group: '',
    transform: { x: 300, y: 200, w: 400, h: 300, rotation: 0, anchor: 'tl' },
    style: { opacity: 1, blend: 'normal', radius: 0 },
    props: { src: '', sound: '', volume: 0.5, kinds: 'sound', seconds: 3, max: 3 },
    triggers: [],
  }];
  await post(`/api/scenes/${scene.id}`, { scene: full, expect_rev: full.rev });
  await post('/api/live/scene', { id: scene.id, transition: 'cut' });

  const page = await openBlank();
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER });
  await page.send('Page.navigate', { url: `${RIG}/scene.html?id=${scene.id}` });
  await sleep(3500);

  check('nothing has played before anything happened',
    (await page.ev('window.__snd.plays.length')) === 0);

  const before = ((await getJ('/api/alerts/recent?n=50')).events || []).length;
  privmsg('amy', '!snd', '@display-name=Amy;id=s1;user-id=71 ');
  await sleep(2000);

  const played = await page.ev('JSON.stringify(window.__snd.plays)');
  const list = JSON.parse(played || '[]');
  check('the layer played something', list.length === 1, played);
  check('and it was the clip the COMMAND named',
    list[0] && list[0].src.endsWith('/asset/' + clip), list[0] && list[0].src);
  check('at the volume the layer is set to, not full',
    list[0] && Math.abs(list[0].volume - 0.5) < 0.01, list[0] && list[0].volume);
  // "paused" on its own says nothing here, and the first version of this
  // probe failed on exactly that: the clip is half a second long, so two
  // seconds after firing a perfectly successful play has finished and paused
  // itself. Ask the two questions that do not depend on when you look.
  check('the play was accepted, not refused by autoplay policy',
    (await page.ev('window.__snd.started')) === 1,
    await page.ev('JSON.stringify(window.__snd.refused)'));
  check('and the clip advanced through itself rather than sitting at zero',
    (await page.ev('!!(window.__snd.el && (window.__snd.el.ended || window.__snd.el.currentTime > 0))')) === true,
    await page.ev('window.__snd.el ? (window.__snd.el.currentTime + "s, ended=" + window.__snd.el.ended) : "no element"'));

  const fresh = ((await getJ('/api/alerts/recent?n=50')).events || []).slice(before);
  check('one command produced exactly one alert, of kind sound',
    fresh.length === 1 && fresh[0].kind === 'sound', J(fresh.map((e) => e.kind)));
  check('carrying the clip in detail',
    fresh.length === 1 && (fresh[0].detail || {}).sound === clip, J(fresh[0] && fresh[0].detail));

  // It has to stop when the box does, or a clip outlives its effect.
  await sleep(2600);
  check('the clip was stopped when the effect ended',
    (await page.ev('window.__snd.pauses')) > 0,
    await page.ev('window.__snd.pauses'));

  check('nothing was thrown in the scene page', page.errors.length === 0, page.errors.slice(0, 2).join(' | '));

  try { page.ws.close(); } catch (_) {}
  await fetch(`http://127.0.0.1:${port}/json/close/${page.targetId}`).catch(() => {});
  await post('/api/live/scene', { id: '' });
  await post('/api/chat/disconnect', { service: 'twitch' });
  await post('/api/commands/save', { commands: ((beforeCfg || {}).commands || {}).list || [], symbol: '!' });
  await post(`/api/scenes/${scene.id}/delete`, {});
  const del = await post('/api/assets/delete', { id: clip });
  check('and the clip was taken away again', del.ok !== false, J(del.reason || 'removed'));
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
