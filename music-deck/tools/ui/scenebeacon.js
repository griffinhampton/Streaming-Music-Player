// Does an imported scene reach the person who wrote it?
//
//   node scenebeacon.js <devtools port> [rig port]
//
// The fix is about a request that must NOT happen, so this watches the wire
// rather than the DOM: Network is enabled on a blank target first, and only
// then is the scene navigated to, because a page opened straight at the URL
// has already made its early requests before the listener exists.
//
// example.invalid is used on purpose - .invalid can never resolve, so even a
// failed fix cannot actually contact anybody. The request would still be
// logged by Network.requestWillBeSent, which is what is being measured.
const [port, rigPort = '8799'] = process.argv.slice(2);
const RIG = `http://127.0.0.1:${rigPort}`;
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 150000).unref();

const results = [];
const check = (n, ok, d = '') => {
  results.push([n, !!ok]);
  console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? `  (${d})` : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const BEACON_HOST = 'example.invalid';
const BEACON = `https://${BEACON_HOST}/beacon.png`;

const post = (path, body) => fetch(RIG + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: J(body || {}),
}).then((r) => r.json());

async function openBlank(url = 'about:blank') {
  // encodeURIComponent, not the raw string and not encodeURI - S17b's rule,
  // which tests/test_harness_urls.py holds. This probe opens a blank target
  // and navigates afterwards, so the URL here carries no second parameter
  // yet; a single-parameter URL is exactly the shape that let the fault
  // through unnoticed the last two times it was found.
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const p = { ws, id: 0, pending: new Map(), wire: [], errors: [], targetId: t.id };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && p.pending.has(m.id)) { p.pending.get(m.id)(m); p.pending.delete(m.id); return; }
    if (m.method === 'Network.requestWillBeSent') p.wire.push(m.params.request.url);
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
  await p.send('Network.enable');
  return p;
}

// A scene of the shape somebody could hand you: one image layer pointed at
// their own server. Only scene.json - manifest.json is optional, and no
// assets ride along, which is exactly why the import reports nothing wrong.
function sceneZipBase64() {
  const scene = {
    version: 3, name: 'beacon probe', format: 'horizontal', width: 1920, height: 1080,
    background: { mode: 'solid', color: '#101014' },
    layers: [{
      id: 'bcn1', type: 'image', name: 'Probe', visible: true, locked: false, group: '',
      transform: { x: 100, y: 100, w: 600, h: 400, rotation: 0, anchor: 'tl' },
      style: { opacity: 1, blend: 'normal', radius: 0 },
      props: { src: BEACON, fit: 'cover' }, triggers: [],
    }],
  };
  // A stored zip, written by hand: no deflate, so no library is needed.
  const name = Buffer.from('scene.json');
  const body = Buffer.from(JSON.stringify(scene));
  const crcTable = [...Array(256)].map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const b of body) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);

  const centralOffset = local.length + name.length + body.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([local, name, body, central, name, end]).toString('base64');
}

(async () => {
  const imported = await post('/api/scenes/import', {
    data: 'data:application/zip;base64,' + sceneZipBase64(), name: 'beacon probe',
  });
  const sid = (imported.scene || {}).id;
  check('the scene imported at all', !!sid && imported.ok !== false, J(imported.report || imported).slice(0, 120));
  if (!sid) { console.log('\n0 of 1 passed'); process.exit(1); }

  // The finding restated as a check: the import is happy with this scene.
  const report = imported.report || {};
  check('and the import still reports nothing wrong about it',
    (report.skipped || []).length === 0 && (report.missing || []).length === 0,
    J(report));

  const page = await openBlank();
  await page.send('Page.navigate', { url: `${RIG}/scene.html?id=${sid}` });
  await sleep(5000);

  // Anti-vacuity: a page that never drew the layer proves nothing about what
  // the layer would have fetched.
  const drew = await page.ev(`(() => {
    const el = document.querySelector('.type-image');
    const m = el && el.querySelector('.media');
    return { layer: !!el, tag: m ? m.tagName : '', src: m ? (m.getAttribute('src') || '') : '',
             bg: m ? (m.style.backgroundImage || '') : '' };
  })()`);
  check('the image layer was actually built', drew.layer, J(drew));

  const hits = page.wire.filter((u) => u.includes(BEACON_HOST));
  check('nothing was requested from the host the scene names', hits.length === 0, J(hits.slice(0, 3)));
  check('and the layer did not adopt the remote url',
    !String(drew.src).includes(BEACON_HOST) && !String(drew.bg).includes(BEACON_HOST), J(drew));

  // The control. Absence is worth nothing until the same listener is shown
  // catching a request to that host when one really is made.
  const before = page.wire.length;
  await page.ev(`(() => { const i = new Image(); i.src = ${J('https://' + BEACON_HOST + '/control.png')}; return 1; })()`);
  await sleep(2500);
  const caught = page.wire.slice(before).filter((u) => u.includes(BEACON_HOST));
  check('the probe can see a request to that host when one is made (control)',
    caught.length > 0, J(caught.slice(0, 2)));

  check('nothing was thrown in the scene page', page.errors.length === 0, page.errors.slice(0, 2).join(' | '));

  try { page.ws.close(); } catch (_) {}
  await fetch(`http://127.0.0.1:${port}/json/close/${page.targetId}`).catch(() => {});
  await post(`/api/scenes/${sid}/delete`, {});

  const bad = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - bad} of ${results.length} passed`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('THREW ' + e.message); process.exit(2); });
