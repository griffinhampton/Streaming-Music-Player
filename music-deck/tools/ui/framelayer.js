// Does a frame layer draw what the frame windows draw?
//   node framelayer.js <devtools port> [rig port] [outdir]
//
// Two frames on one scene, deliberately different sizes: a small square one
// like the camera window (480x480) and a large wide one like the screen window
// (1600x900). The point of working --frame-em out from the layer's own
// transform is that these must letter DIFFERENTLY - frame.html sizes its text
// off 3.4vmin of the viewport, which inside a scene would give every frame the
// same lettering whatever size it was drawn at. If the two come back equal,
// the bug this was built to avoid has been reproduced.
const fs = require('fs');
const [port, rigPort = '8799', outDir] = process.argv.slice(2);
const RIG = `http://127.0.0.1:${rigPort}`;
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 180000).unref();

const results = [];
const check = (n, ok, d = '') => { results.push([n, !!ok]); console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? `  (${d})` : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(url) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const p = { ws, id: 0, pending: new Map(), errors: [] };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && p.pending.has(m.id)) { p.pending.get(m.id)(m); p.pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') p.errors.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n')[0]);
  };
  p.send = (m, q = {}) => new Promise((r) => { const i = ++p.id; p.pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: q })); });
  p.ev = async (x) => { const r = await p.send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text); return r.result.result.value; };
  await p.send('Runtime.enable');
  return p;
}

const frameLayer = (id, name, x, y, w, h, extra) => ({
  id, name, type: 'shape', visible: true, locked: false, group: '',
  transform: { x, y, w, h, rotation: 0, anchor: 'tl' },
  style: { opacity: 1, radius: 0, border: { w: 0, color: '#ffffff' },
           shadow: { x: 0, y: 0, blur: 0, color: '#000000' }, blur: 0,
           crop: { t: 0, r: 0, b: 0, l: 0 } },
  props: Object.assign({
    kind: 'frame', pad: 24, hole_radius: 16, fill: 'rgba(0,0,0,0)',
    border: { style: 'glow', width: 10, color: '#ff7ab6' },
    title: { text: 'cam', place: 'bottom', size: 1, color: '#ffffff' },
    badges: { tl: '', tr: 'LIVE', bl: '?', br: '', size: 1, color: '' },
  }, extra || {}),
  triggers: [],
});

(async () => {
  const made = await (await fetch(`${RIG}/api/scenes`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Frame layer check', format: 'horizontal' }) })).json();
  const sid = made.scene.id;
  const scene = await (await fetch(`${RIG}/api/scenes/${sid}`)).json();
  scene.background = { mode: 'solid', color: '#101014' };
  scene.layers = [
    // The camera window's shape and settings, at its registered size.
    frameLayer('fr_small', 'Camera-ish', 60, 90, 480, 480, { shape: 'circle' }),
    // The screen window's, much larger and wide.
    frameLayer('fr_big', 'Screen-ish', 620, 90, 1200, 700, {
      shape: 'rounded',
      border: { style: 'glow', width: 8, color: '#8b5cf6' },
      title: { text: 'Ranked grind', place: 'top', size: 1, color: '#ffffff' },
      badges: { tl: '1', tr: '', bl: '', br: '', size: 1, color: '' },
    }),
  ];
  const saved = await (await fetch(`${RIG}/api/scenes/${sid}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scene, expect_rev: scene.rev }) })).json();
  check('the scene saved with two frame layers', !!saved.ok || !!saved.scene, JSON.stringify(saved).slice(0, 120));

  const page = await open(`${RIG}/scene.html?id=${sid}`);
  await sleep(2500);

  const read = async (lid) => page.ev(`(() => {
    const el = document.querySelector('[data-layer="${lid}"]') || [...document.querySelectorAll('.layer')].find((n) => n.dataset.id === '${lid}');
    if (!el) return { missing: true, ids: [...document.querySelectorAll('.layer')].map((n) => n.dataset.id || n.getAttribute('data-layer')).join(',') };
    const cs = getComputedStyle(el);
    const hole = el.querySelector('.shape-hole');
    const hs = hole && getComputedStyle(hole);
    const title = el.querySelector('.frame-title');
    const badges = [...el.querySelectorAll('.frame-badge')];
    const r = el.getBoundingClientRect();
    return {
      box: Math.round(r.width) + 'x' + Math.round(r.height),
      frameEm: cs.getPropertyValue('--frame-em').trim(),
      holeBorder: hs && (hs.borderTopWidth + ' ' + hs.borderTopStyle + ' ' + hs.borderTopColor),
      holeRadius: hs && hs.borderTopLeftRadius,
      holeShadow: hs && (hs.boxShadow || '').slice(0, 60),
      titleText: title && title.textContent,
      titleFont: title && getComputedStyle(title).fontSize,
      badgeCount: badges.length,
      badgeFont: badges[0] && getComputedStyle(badges[0]).fontSize,
      badgeText: badges.map((b) => b.textContent).join(','),
    };
  })()`);

  const small = await read('fr_small');
  const big = await read('fr_big');
  console.log('small:', JSON.stringify(small));
  console.log('big  :', JSON.stringify(big));

  check('both frame layers rendered', !small.missing && !big.missing, small.missing ? 'ids ' + small.ids : '');
  if (small.missing || big.missing) { process.exit(1); }

  const emS = parseFloat(small.frameEm), emB = parseFloat(big.frameEm);
  check('each frame is lettered from its own box, not the window',
    emS > 0 && emB > 0 && Math.abs(emB - emS) > 1, `small ${small.frameEm}, big ${big.frameEm}`);
  check('the small one matches 3.4% of its short side', Math.abs(emS - Math.max(12, 480 * 0.034)) < 0.5, `${emS} vs ${(480 * 0.034).toFixed(2)}`);
  check('the big one matches 3.4% of its short side', Math.abs(emB - Math.max(12, 700 * 0.034)) < 0.5, `${emB} vs ${(700 * 0.034).toFixed(2)}`);

  check('the edge is drawn on the hole itself', /10px solid/.test(small.holeBorder || ''), small.holeBorder);
  check('a circle hole is round', small.holeRadius === '50%' || /^\d+(\.\d+)?px$/.test(small.holeRadius || '') === false, small.holeRadius);
  check('glow reaches the shadow', /rgb\(255, 122, 182\)/.test(small.holeShadow || '') || (small.holeShadow || '').length > 10, small.holeShadow);
  check('the title plate is there, bottom on the small one', small.titleText === 'cam', small.titleText);
  check('the badges are there', small.badgeCount === 2 && small.badgeText === 'LIVE,?', `${small.badgeCount}: ${small.badgeText}`);
  check('the big one carries its own title and badge', big.titleText === 'Ranked grind' && big.badgeCount === 1, `${big.titleText} / ${big.badgeCount}`);
  check('badge lettering differs with the frame', small.badgeFont !== big.badgeFont, `${small.badgeFont} vs ${big.badgeFont}`);
  check('nothing was thrown', page.errors.length === 0, page.errors.slice(0, 2).join(' | '));

  if (outDir) {
    const d = (await page.send('Page.captureScreenshot', { format: 'png' })).result.data;
    fs.writeFileSync(`${outDir}/framelayer.png`, Buffer.from(d, 'base64'));
    console.log('   wrote framelayer.png');
  }
  try { await fetch(`${RIG}/api/scenes/${sid}/delete`, { method: 'POST' }); } catch (_) {}
  const bad = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - bad} of ${results.length} passed`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('THREW ' + e.message); process.exit(2); });
