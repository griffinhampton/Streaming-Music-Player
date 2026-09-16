// T8: what a gift looks like on stream - fired through the bus, read off the stage.
//
//   node giftprobe.js <devtools port> [rig port]
//
// Gifts come from TikTok only once T4 and T6 exist, so they are posted here
// through /api/debug/gift - the rig's own hook, refused anywhere TEST_RIG is
// not set - in exactly the shape the TikTok reader will post them.
//
// What is measured is what an audience would see: the coin on screen with the
// sender's picture on it and actually turning, one thing thrown per coin and
// where each one landed, measured against the target layer's drawn box.
//
// Controls beside the claims:
//   one throw per coin      - a layer for big gifts only stays dark
//   below a layer's minimum - nothing at all, the same gift a coin richer does
//   the cap                 - a 500-coin gift throws the cap, faster, not 500
//   "Try it" is editor-only - the stage on air sees none of it
//   nothing is left behind  - every thrown element is gone after it lands
//
// It never goes near a stream: it checks the rig refuses to go live anywhere
// but this PC first, and stops if it does not.
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
}).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const getJ = (path) => fetch(RIG + path, { cache: 'no-store' }).then((r) => r.json());

/* ---- a picture of its own, for the sender's face */
const CRC = [...Array(256)].map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
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

const gifts = (page, frame) => page.ev(frame
  ? `document.getElementById('sceneFrame').contentWindow.SceneDebug.gifts()`
  : `SceneDebug.gifts()`);
const one = (list, id) => (list || []).find((g) => g.id === id) || {};
const gift = (coins, user = 'Amy', extra = {}) => post('/api/debug/gift', { user, gift: 'Rose', coins, ...extra });

(async () => {
  // ---------------------------------------------------------- 0. never go live
  const guard = await post('/api/live/start', { url: 'rtmp://example.invalid/live', key: 'x', source: 'page' });
  check('this rig refuses to go live anywhere but this PC (or the probe stops here)',
    guard.ok === false && guard.refused === true, J(guard));
  if (!(guard.ok === false && guard.refused === true)) { console.log('\nnot a guarded rig - stopping'); process.exit(1); }

  const up = await post('/api/assets/upload', { name: 'giftprobe-face.png', data: 'data:image/png;base64,' + makePng(160).toString('base64') });
  check('the probe brought a face of its own', up.ok && up.id, J(up.reason || up.id));
  const face = up.id;

  const mk = async (name, layers) => {
    const s = (await post('/api/scenes', { name, format: 'horizontal' })).scene;
    const full = await getJ(`/api/scenes/${s.id}`);
    full.background = { mode: 'solid', color: '#101014' };
    full.layers = layers;
    await post(`/api/scenes/${s.id}`, { scene: full, expect_rev: full.rev });
    return s.id;
  };
  const L = (id, type, t, props) => ({ id, name: id[0].toUpperCase() + id.slice(1), type, visible: true, locked: false, group: '',
    transform: Object.assign({ rotation: 0, anchor: 'tl' }, t), style: { opacity: 1, blend: 'normal', radius: 0 }, props, triggers: [] });
  const S = await mk('Gift probe', [
    L('portrait', 'shape', { x: 1400, y: 180, w: 360, h: 360 }, { shape: 'ellipse', fill: '#39406b' }),
    L('gift', 'gift', { x: 0, y: 0, w: 1920, h: 1080 },
      { mode: 'both', min: 5, target: 'portrait', seconds: 4, max_objects: 20, object_size: 48, coin: 200 }),
    // For big gifts only. The control for "one throw per coin": it hears every
    // gift below too, and must stay dark for all of them.
    L('big', 'gift', { x: 0, y: 0, w: 1920, h: 1080 }, { mode: 'coin', min: 1000, seconds: 3, coin: 140 }),
  ]);
  await post('/api/live/scene', { id: S, transition: 'cut' });

  const stage = await openPage(`${RIG}/scene.html?follow=1`);
  await stage.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await stage.send('Page.bringToFront');
  await sleep(4000);
  const idle = await gifts(stage);
  check('both gift layers are on the stage, dark', one(idle, 'gift').id && one(idle, 'big').id &&
    !one(idle, 'gift').showing && !one(idle, 'big').showing, J(idle));

  // ------------------------------------------------ 1. a gift of ten coins
  const sent = await gift(10, 'Amy', { avatar: face });
  check('the rig took a test gift, in the shape TikTok\'s will come in',
    sent.ok && sent.event && sent.event.kind === 'gift' && sent.event.detail.coins === 10 && sent.event.detail.avatar === face,
    J(sent.event && sent.event.detail));
  await sleep(700);
  const coin = await stage.ev(`(() => {
    const el = document.querySelector('[data-id="gift"]');
    const img = el.querySelector('.gift-face img');
    const c = el.querySelector('.gift-coin');
    return { stage: Number(getComputedStyle(el.querySelector('.gift-stage')).opacity),
      coinShown: getComputedStyle(c).display !== 'none', imgSrc: img ? img.getAttribute('src') : '',
      imgW: img ? img.naturalWidth : 0, who: el.querySelector('.gift-who').textContent,
      what: el.querySelector('.gift-what').textContent, t1: getComputedStyle(c).transform };
  })()`);
  check('the coin is on screen', coin.stage > 0.9 && coin.coinShown, J(coin));
  check('wearing the sender\'s picture, which loaded', coin.imgSrc === '/asset/' + encodeURIComponent(face) && coin.imgW === 160, J(coin));
  check('with who sent what', coin.who === 'Amy' && /Rose/.test(coin.what) && /10 coins/.test(coin.what), J([coin.who, coin.what]));
  await sleep(250);
  const t2 = await stage.ev(`getComputedStyle(document.querySelector('[data-id="gift"] .gift-coin')).transform`);
  check('and it is turning, not a picture of a coin', coin.t1 !== t2 && /matrix3d/.test(t2), J([coin.t1, t2]));

  await sleep(4000);
  const after10 = await gifts(stage);
  const g10 = one(after10, 'gift');
  check('exactly one thing was thrown for each coin', g10.launched === 10, J(g10.launched));
  const box = await stage.ev(`(() => { const r = document.querySelector('[data-id="portrait"]').getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom }; })()`);
  const inside = (g10.landed || []).filter(([x, y]) => x >= box.l && x <= box.r && y >= box.t && y <= box.b);
  check('and every one landed on the layer it was thrown at', g10.landed.length === 10 && inside.length === 10,
    `${inside.length} of ${g10.landed.length} inside ${J(box)}`);
  check('nothing is left behind once they land', g10.flying === 0, J(g10.flying));
  check('the big-gift layer stayed dark for a small gift (the control)', one(after10, 'big').launched === 0 && !one(after10, 'big').showing);

  // ------------------------------------------------ 2. below the minimum
  await sleep(1000);
  const before4 = one(await gifts(stage), 'gift').launched;
  await gift(4, 'Bob');
  await sleep(1200);
  const g4 = one(await gifts(stage), 'gift');
  check('a gift below the layer\'s minimum shows nothing at all', g4.launched === before4 && !g4.showing, J(g4));
  await gift(5, 'Bob');
  await sleep(1200);
  check('and the same gift a coin richer does (the control)', one(await gifts(stage), 'gift').showing);
  await sleep(4500);

  // ------------------------------------------------ 3. the cap
  const before500 = one(await gifts(stage), 'gift');
  await gift(500, 'Cy');
  await sleep(4200);
  const g500 = one(await gifts(stage), 'gift');
  check('a 500-coin gift throws the cap, not 500', g500.launched - before500.launched === 20, J(g500.launched - before500.launched));
  check('never more in the air than the cap', g500.peak <= 20, J(g500.peak));
  check('and they fly faster instead - overflow is speed, not count',
    g500.lastFlight > 0 && g500.lastFlight < g10.lastFlight, `${g500.lastFlight} ms against ${g10.lastFlight} ms`);
  await sleep(1500);

  // ------------------------------------------------ 4. a big gift, and Stop
  await gift(1500, 'Dee');
  await sleep(700);
  check('a big gift reaches the big-gift layer too', one(await gifts(stage), 'big').showing);
  await sleep(4500);
  await gift(60, 'Eve');
  await sleep(900);
  const mid = one(await gifts(stage), 'gift');
  check('things are in the air (the floor for Stop)', mid.flying > 0 && mid.showing, J(mid));
  await post('/api/commands/stop', {});
  await sleep(400);
  const halted = one(await gifts(stage), 'gift');
  check('Stop effects takes the coin and everything in the air down at once', halted.flying === 0 && !halted.showing, J(halted));
  const leftover = await stage.ev(`document.querySelectorAll('[data-id="gift"] .gift-token').length`);
  check('with no thrown element left in the page', leftover === 0, J(leftover));
  await post('/api/commands/resume', {});

  // ------------------------------------------------ 5. set up in the editor
  const editor = await openPage(`${RIG}/canvas.html?scene=${S}`);
  await editor.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await editor.send('Page.bringToFront');
  await sleep(4500);
  await editor.ev(`Editor.select(['gift'])`);
  await sleep(900);
  const insp = await editor.ev(`(() => {
    const tag = document.querySelector('#inspector .insp h2 .tag');
    const sel = document.querySelector('#inspector select[data-gift-targets]');
    return { tag: tag ? tag.textContent.trim() : '', targets: sel ? [...sel.options].map((o) => [o.value, o.textContent]) : null,
             chosen: sel ? sel.value : null };
  })()`);
  check('the inspector names the layer "Gift"', insp.tag === 'Gift', J(insp.tag));
  check('and offers the other layers to throw at, with the portrait chosen',
    insp.targets && insp.targets.some(([v]) => v === 'portrait') && insp.chosen === 'portrait', J(insp));
  const stageBefore = one(await gifts(stage), 'gift').launched;
  const frameBefore = one(await gifts(editor, true), 'gift').launched;
  await editor.ev(`(() => { const c = document.querySelector('#inspector [data-gift-coins]'); c.value = '7';
    document.querySelector('#inspector [data-gift-try]').click(); return 1; })()`);
  await sleep(4000);
  check('"Try it" throws seven in the editor\'s preview', one(await gifts(editor, true), 'gift').launched - frameBefore === 7);
  check('and none on the stage - the editor keeps it to itself (the control)', one(await gifts(stage), 'gift').launched === stageBefore);

  for (const [n, p] of [['stage', stage], ['the editor', editor]]) {
    check(`nothing was thrown in ${n}`, p.errors.length === 0, p.errors.slice(0, 2).join(' | '));
  }

  // -------------------------------------------------- put the rig back as found
  for (const p of [stage, editor]) await closePage(p);
  await post('/api/live/scene', { id: '' });
  await post('/api/commands/resume', {});
  await post(`/api/scenes/${S}/delete`, {});
  const del = await post('/api/assets/delete', { id: face });
  check('the rig was put back', del.ok !== false && (await getJ('/api/commands')).paused === false);

  const bad = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - bad} of ${results.length} passed`);
  process.exitCode = bad ? 1 : 0;
})().catch(async (e) => {
  try { await post('/api/commands/resume', {}); } catch (_) {}
  console.log('THREW ' + e.message);
  process.exit(2);
});
