// A chat command that puts a picture on the canvas (T2), end to end.
//
//   node fxgif.js <devtools port> [rig port] [outdir]
//
// The unit tests cover the engine's half with a double. This covers the half
// a double cannot: that one !command produces exactly ONE alert, of kind
// "gif", and that the effect layer draws the picture the command names rather
// than the one the layer was set to.
//
// The single-alert claim is the important one. `_record` keeps whatever the
// handler returns as the command's response, and after_command posts a second
// alert for any command that has one - so a chatty command_gif would put a
// picture on screen and an alert card beside it, off one command. That cannot
// be tested against a double, because the double is the thing being doubted.
//
// It brings its own picture and takes it away again: a probe that assumed the
// rig already had a usable asset would quietly fall back to whatever is there
// - and the rig's only picture is a 4x4 token, which is precisely how the
// first version of the effect probe passed while photographing nothing.
const fs = require('fs');
const net = require('net');
const zlib = require('zlib');
const [port, rigPort = '8799', outDir] = process.argv.slice(2);
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

/* ---- a picture of its own, so nothing is assumed about the rig */

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
    const px = [0];                                   // filter byte: none
    const bar = y >= size * 0.42 && y < size * 0.58;  // asymmetric on purpose
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
  ihdr[8] = 8; ihdr[9] = 2;                            // 8-bit, truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function open(url) {
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

let client = null;
const server = net.createServer((sock) => { client = sock; sock.on('data', () => {}); sock.on('error', () => {}); });
const privmsg = (who, text, extra = '') =>
  client && client.write(`${extra}:${who}!${who}@${who}.tmi.twitch.tv PRIVMSG #somechannel :${text}\r\n`);

const STATE = `(() => {
  const el = document.querySelector('.type-effect');
  const m = el && el.querySelector('.media');
  const r = m ? m.getBoundingClientRect() : null;
  return el ? {
    showing: el.classList.contains('showing'),
    src: m ? (m.getAttribute('src') || '') : '',
    nw: m ? (m.naturalWidth || 0) : 0,
    w: r ? Math.round(r.width) : 0,
    h: r ? Math.round(r.height) : 0,
    opacity: getComputedStyle(el.querySelector('.fx-box')).opacity,
  } : null;
})()`;

(async () => {
  const beforeCfg = await getJ('/api/config');

  const up = await post('/api/assets/upload', {
    name: 'fxgif-probe.png',
    data: 'data:image/png;base64,' + makePng(240).toString('base64'),
  });
  check('the probe put a picture of its own on the rig', up.ok && up.id, J(up.reason || up.id));
  if (!up.ok) { console.log('\n0 of 1 passed'); process.exit(1); }
  const picId = up.id;

  await new Promise((r) => server.listen(6667, '127.0.0.1', r));
  await post('/api/debug/chat-endpoint', { host: '127.0.0.1', port: 6667, tls: false });
  await post('/api/chat/connect', { service: 'twitch', channel: 'SomeChannel' });
  // The command names the picture; the layer is set to nothing at all, so
  // whatever appears can only have come from the command.
  await post('/api/commands/save', {
    commands: [{ name: 'pic', action: 'gif', target: picId }], symbol: '!',
  });

  const scene = (await post('/api/scenes', { name: 'FX gif probe', format: 'horizontal' })).scene;
  const full = await getJ(`/api/scenes/${scene.id}`);
  full.background = { mode: 'solid', color: '#101014' };
  full.layers = [{
    id: 'fxg', name: 'FX', type: 'effect', visible: true, locked: false, group: '',
    transform: { x: 300, y: 200, w: 520, h: 400, rotation: 0, anchor: 'tl' },
    style: { opacity: 1, blend: 'normal', radius: 0 },
    props: { src: '', kinds: 'gif', seconds: 4, max: 3, fit: 'contain' },
    triggers: [],
  }, {
    // The negative control, and the reason it is a second layer rather than a
    // second run: it hears the very same event and must stay dark. A filter
    // that let everything through would look identical on the first layer.
    id: 'fxctl', name: 'FX control', type: 'effect', visible: true, locked: false, group: '',
    transform: { x: 300, y: 640, w: 520, h: 400, rotation: 0, anchor: 'tl' },
    style: { opacity: 1, blend: 'normal', radius: 0 },
    props: { src: picId, kinds: 'poll', seconds: 4, max: 3, fit: 'contain' },
    triggers: [],
  }];
  await post(`/api/scenes/${scene.id}`, { scene: full, expect_rev: full.rev });
  await post('/api/live/scene', { id: scene.id, transition: 'cut' });

  const page = await open(`${RIG}/scene.html?id=${scene.id}`);
  await page.send('Emulation.setDeviceMetricsOverride',
    { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await sleep(3500);

  const idle = await page.ev(STATE);
  check('the layer is there with no picture of its own', idle && idle.src === '', J(idle));

  const alertsBefore = ((await getJ('/api/alerts/recent?n=50')).events || []).length;

  privmsg('amy', '!pic', '@display-name=Amy;id=g1;user-id=61 ');
  await sleep(2500);

  const fired = await page.ev(STATE);
  check('the layer showed', fired && fired.showing && Number(fired.opacity) > 0.9, J(fired));
  check('and it drew the picture the COMMAND named, not one of its own',
    fired && fired.src === '/asset/' + encodeURIComponent(picId), J(fired && fired.src));
  check('the picture decoded and was laid out', fired && fired.nw > 8 && fired.w > 50,
    `${fired && fired.nw} natural, ${fired && fired.w}x${fired && fired.h} on screen`);

  // The layer listening for polls heard the same event and must have ignored
  // it - it even has a picture of its own, so "nothing shown" is a decision
  // rather than an absence.
  const control = await page.ev(`(() => {
    const el = [...document.querySelectorAll('.type-effect')][1];
    return el ? { showing: el.classList.contains('showing'),
                  opacity: getComputedStyle(el.querySelector('.fx-box')).opacity } : null;
  })()`);
  check('a layer listening for a different kind stayed dark (the control)',
    control && !control.showing && Number(control.opacity) < 0.05, J(control));

  // The claim no double can make.
  const after = (await getJ('/api/alerts/recent?n=50')).events || [];
  const fresh = after.slice(alertsBefore);
  check('one command produced exactly one alert', fresh.length === 1,
    J(fresh.map((e) => e.kind)));
  check('and it was a gif, not a command card beside the picture',
    fresh.length === 1 && fresh[0].kind === 'gif', J(fresh.map((e) => e.kind)));
  check('the alert carried the picture in detail',
    fresh.length === 1 && ((fresh[0].detail || {}).asset === picId), J(fresh[0] && fresh[0].detail));

  if (outDir) {
    const shot = (await page.send('Page.captureScreenshot', { format: 'png' })).result.data;
    fs.writeFileSync(`${outDir}/fx-gif.png`, Buffer.from(shot, 'base64'));
    console.log('   wrote fx-gif.png');
  }

  check('nothing was thrown in the scene page', page.errors.length === 0, page.errors.slice(0, 2).join(' | '));

  // Put the rig back exactly as it was found, picture included.
  try { page.ws.close(); } catch (_) {}
  await fetch(`http://127.0.0.1:${port}/json/close/${page.targetId}`).catch(() => {});
  await post('/api/live/scene', { id: '' });
  await post('/api/chat/disconnect', { service: 'twitch' });
  await post('/api/commands/save', { commands: ((beforeCfg || {}).commands || {}).list || [], symbol: '!' });
  await post(`/api/scenes/${scene.id}/delete`, {});
  const del = await post('/api/assets/delete', { id: picId });
  check('and took its picture away again', del.ok !== false, J(del.reason || 'removed'));
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
