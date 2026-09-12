// P8 canvas-tool tests in headless Chrome (no window on any monitor):
//   node p8test.js <devtools port> <scene id> <phone scene id> <outdir> [rig port]
// Real pointer drags (CDP mouse events) on the editor's canvas: select, box
// select, move, snapping (edges, centers, equal spacing, guides, grid, the
// Alt override, a modifier pressed mid-drag), resize (corner, Shift, Alt,
// snapped, rotated), rotate, several layers at once, nudging, guides from the
// rulers, inspector math, align and space out, arrange, the right-click menu,
// copy and paste between scenes - each checked for where things end up and
// for being exactly one undo step - then the same pointer math at 200% and 30%
// zoom with the screen at 150%, an open output following a drag, undo all the
// way back, and no console errors. The system clipboard is never touched: copy
// and paste run on the page's own clipboard events.
const fs = require('fs');
const path = require('path');
const [port, SID, SID2, outdir, rigPort = '8799'] = process.argv.slice(2);
const RIG = `http://127.0.0.1:${rigPort}`;
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 420000).unref();
const results = [];
const check = (name, ok, detail = '') => { results.push([name, !!ok]); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? `  (${detail})` : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VK = { Enter: 13, Escape: 27, Tab: 9, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, F10: 121,
             BracketLeft: 219, BracketRight: 221, AltLeft: 18, Slash: 191 };
const ALT = 1, CTRL = 2, SHIFT = 8;

async function open(url) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURI(url)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const page = { ws, id: 0, pending: new Map(), errors: [] };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && page.pending.has(m.id)) { page.pending.get(m.id)(m); page.pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') page.errors.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n')[0]);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') page.errors.push('console.error: ' + m.params.args.map((a) => a.value || a.description).join(' ').slice(0, 200));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon/.test(m.params.entry.url || '') && !/status of 409/.test(m.params.entry.text)) page.errors.push('log: ' + m.params.entry.text.slice(0, 200));
  };
  page.send = (method, params = {}) => new Promise((r) => { const i = ++page.id; page.pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  page.ev = async (expression) => {
    const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '').split('\n')[0]);
    return r.result.result.value;
  };
  page.key = async (key, code, mods = 0, text) => {
    await page.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, modifiers: mods, text, windowsVirtualKeyCode: VK[code] });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers: mods, windowsVirtualKeyCode: VK[code] });
  };
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Page.enable');
  return page;
}
async function waitFor(page, expr, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await page.ev(expr)) return true; } catch (_) { /* not yet */ }
    await sleep(50);
  }
  return false;
}
const post = (p, body) => fetch(RIG + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const getScene = async (id) => (await fetch(`${RIG}/api/scenes/${id}`, { cache: 'no-store' })).json();

// The test layout: a background, three boxes, a text, and a row of three.
const L = (n, name, type, x, y, w, h, props) => ({ id: (0xa1000000 + n).toString(16), type, name, visible: true, locked: false, group: '',
  transform: { x, y, w, h, rotation: 0, anchor: 'tl' }, style: { opacity: 1, blend: 'normal', radius: 0 }, props, triggers: [] });
const LAYOUT = [
  L(0, 'Background', 'background', 0, 0, 1920, 1080, { mode: 'solid', color: '#1a1030' }),
  L(1, 'A', 'shape', 200, 200, 200, 150, { kind: 'rect', fill: '#8b5cf6' }),
  L(2, 'B', 'shape', 700, 200, 200, 150, { kind: 'rect', fill: '#22d3ee' }),
  L(3, 'C', 'shape', 1300, 600, 240, 160, { kind: 'ellipse', fill: '#f472b6' }),
  L(4, 'T', 'text', 600, 800, 500, 120, { text: 'Canvas tools', size: 72, weight: 700, color: '#ffffff', align: 'center' }),
  L(5, 'R1', 'shape', 100, 40, 120, 80, { kind: 'rect', fill: '#34d399' }),
  L(6, 'R2', 'shape', 620, 40, 120, 80, { kind: 'rect', fill: '#34d399' }),
  L(7, 'R3', 'shape', 1500, 40, 120, 80, { kind: 'rect', fill: '#fbbf24' }),
];

let ed;
const S = async () => JSON.parse(await ed.ev('JSON.stringify(Editor.scene())'));
const byName = (s, n) => s.layers.find((l) => l.name === n);
const T = async (n) => byName(await S(), n).transform;
const idOf = async (n) => byName(await S(), n).id;
const shape = (s) => JSON.stringify({ l: s.layers.map((l) => [l.id, l.name, l.visible, l.locked, l.group, l.transform, l.props]), g: s.groups || {}, gd: s.guides || { h: [], v: [] } });
const Z = async () => (await ed.ev('Editor.view()')).z;
/** The client point of a scene point, whole pixels (what a real pointer gives). */
const C = async (x, y) => { const p = await ed.ev(`Editor.toClient(${x}, ${y})`); return { x: Math.round(p.x), y: Math.round(p.y) }; };
const center = async (n) => { const t = await T(n); return C(t.x + t.w / 2, t.y + t.h / 2); };
/** What a scene distance becomes after the trip through whole screen pixels. */
const eff = (d, z) => Math.round(Math.round(d * z) / z);
const by = (p, dx, dy, z) => ({ x: p.x + Math.round(dx * z), y: p.y + Math.round(dy * z) });

async function mouse(type, p, mods = 0, button = 'left', down = false) {
  await ed.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, modifiers: mods,
    button: type === 'mouseMoved' && !down ? 'none' : button, buttons: down ? (button === 'right' ? 2 : 1) : 0,
    clickCount: type === 'mouseMoved' ? 0 : 1 });
}
async function drag(from, to, { mods = 0, steps = 12, hold = false } = {}) {
  await mouse('mouseMoved', from, mods);
  await mouse('mousePressed', from, mods, 'left', true);
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }, mods, 'left', true);
    await sleep(14);
  }
  await sleep(50);
  if (!hold) await release(to, mods);
}
async function release(at, mods = 0) { await mouse('mouseReleased', at, mods, 'left', false); await sleep(80); }
async function click(p, mods = 0) {
  await mouse('mouseMoved', p, mods);
  await mouse('mousePressed', p, mods, 'left', true);
  await mouse('mouseReleased', p, mods, 'left', false);
  await sleep(80);
}
async function shot(name) {
  const r = await ed.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(outdir, name);
  fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  return file;
}
const sel = async (...names) => { const s = await S(); await ed.ev(`Editor.select(${JSON.stringify(names.map((n) => byName(s, n).id))})`); await sleep(60); };
const selNames = async () => { const s = await S(); const ids = await ed.ev('Editor.selection()'); return ids.map((id) => s.layers.find((l) => l.id === id).name).sort().join(','); };

/* One action: it lands as expected, as exactly one undo step, and undo and
   redo take it back and forth exactly. Leaves the scene as the action left it. */
async function oneStep(name, act, expect) {
  const h0 = (await ed.ev('Editor.history()')).undo;
  const before = await S();
  await act();
  await sleep(60);
  const after = await S();
  const h1 = await ed.ev('Editor.history()');
  let ok = false, detail = '';
  try { [ok, detail] = await expect(before, after); } catch (e) { detail = 'expect threw ' + e.message; }
  await ed.ev('Editor.undo()');
  const undone = await S();
  await ed.ev('Editor.redo()');
  const redone = await S();
  const u = shape(undone) === shape(before), r = shape(redone) === shape(after);
  check(name, ok && h1.undo === h0 + 1 && u && r, `${detail}; ${h1.undo - h0} step "${h1.labels[h1.labels.length - 1]}", undo ${u ? 'exact' : 'WRONG'}, redo ${r ? 'exact' : 'WRONG'}`);
  return after;
}
const eqT = (t, want) => Object.entries(want).every(([k, v]) => Math.abs(t[k] - v) < 0.011);
const fmtT = (t) => `x ${t.x} y ${t.y} w ${t.w} h ${t.h}${t.rotation ? ' r ' + t.rotation : ''}`;

(async () => {
  // ---- the layout, on the rig
  for (const [id, layout] of [[SID, LAYOUT], [SID2, []]]) {
    const s = await getScene(id);
    s.layers = layout;
    s.groups = {};
    s.guides = { h: [], v: [] };
    const r = await post(`/api/scenes/${id}`, { scene: s, expect_rev: s.rev });
    if (r.status !== 200) throw new Error('setup save ' + r.status);
  }
  ed = await open(`${RIG}/canvas.html?scene=${SID}`);
  await ed.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  // The editor's own origin (not the blank page a new tab starts on) for its stored view choices.
  await waitFor(ed, `location.origin === ${JSON.stringify(RIG)} && document.readyState === 'complete'`, 10000);
  await ed.ev(`localStorage.removeItem('cb-view'); localStorage.removeItem('cb-clipboard')`);
  await ed.send('Page.reload', { ignoreCache: true });
  check('the editor loads the test layout', await waitFor(ed, `window.Editor && Editor.scene() && Editor.scene().layers.length === ${LAYOUT.length}`, 10000));
  await sleep(1500);
  await ed.ev('Editor.fit()');
  await sleep(200);
  const initial = await S();
  let z = await Z();
  console.log(`zoom ${z.toFixed(3)}; snapping reaches ${(6 / z).toFixed(1)} scene px`);

  // ================= part 1: move, snap, resize, rotate
  await click(await center('A'));
  check('a click selects the layer under the pointer', (await selNames()) === 'A');
  check('handles and the rotate knob are drawn, rulers on', await ed.ev(`document.querySelectorAll('#hud [data-handle]').length === 9 && !document.getElementById('rulerX').hidden`));
  const fSel = await shot('p8_select.png');

  await oneStep('move: drag A by (100, 60) with Alt lands exactly there', async () => drag(await center('A'), by(await center('A'), 100, 60, z), { mods: ALT }),
    async (b, a) => { const want = { x: 200 + eff(100, z), y: 200 + eff(60, z) }; return [eqT(byName(a, 'A').transform, want), fmtT(byName(a, 'A').transform) + ' want ' + JSON.stringify(want)]; });

  // Snap A's left edge onto B's right edge (900) from 5 px away - and Alt, pressed mid-drag, lets go of it.
  {
    const t0 = await T('A');
    const from = await center('A');
    await drag(from, by(from, 905 - t0.x, 0, z), { hold: true });
    const g = await ed.ev('Editor.gesture()');
    const hud = await ed.ev('Editor.hud()');
    const snapped = (await T('A')).x;
    const fSmart = await shot('p8_smart_guides.png');
    await ed.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, modifiers: ALT });
    await sleep(60);
    const loose = (await T('A')).x;
    const gAlt = await ed.ev('Editor.gesture()');
    await ed.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, modifiers: 0 });
    await sleep(60);
    const again = (await T('A')).x;
    const h0 = (await ed.ev('Editor.history()')).undo;
    await release(by(from, 905 - t0.x, 0, z));
    const h1 = (await ed.ev('Editor.history()')).undo;
    check('snap: A\'s left edge 5 px from B\'s right edge snaps onto it, with a smart guide',
      snapped === 900 && g && g.hits.some((h) => h.axis === 'x' && h.at === 900 && h.kind === 'layer') && hud.snapLines >= 1, `x ${snapped}, hits ${JSON.stringify(g && g.hits)}, lines ${hud.snapLines}  (${fSmart})`);
    check('snap: Alt pressed mid-drag lets go of it, let go it snaps again; one step', loose === t0.x + eff(905 - t0.x, z) && gAlt.hits.length === 0 && again === 900 && h1 === h0 + 1 && (await T('A')).x === 900,
      `alt ${loose}, again ${again}, after ${(await T('A')).x}, steps ${h1 - h0}`);
  }

  // (6 px short: 8 past it, C's left edge would sit 2 px from T's center line and take that instead.)
  await oneStep('snap: C\'s center 6 px from the canvas center snaps to it', async () => {
    const t = await T('C'); const from = await center('C');
    await drag(from, by(from, 954 - (t.x + t.w / 2), 0, z));
  }, async (b, a) => { const t = byName(a, 'C').transform; return [t.x + t.w / 2 === 960 && t.y === 600, fmtT(t)]; });

  {
    // Equal spacing: R3 dropped 4 px off the spot between R1 and R2 that leaves equal gaps.
    const t = await T('R3'); const from = await center('R3');
    await drag(from, by(from, 364 - t.x, 0, z), { hold: true });
    const g = await ed.ev('Editor.gesture()');
    const hud = await ed.ev('Editor.hud()');
    const at = (await T('R3')).x;
    const fSpace = await shot('p8_spacing.png');
    await release(by(from, 364 - t.x, 0, z));
    check('snap: equal spacing between two neighbors, gaps shown', at === 360 && g.hits.some((h) => h.kind === 'spacing') && hud.spacing === 2 && hud.labels.filter((l) => l === '140').length === 2,
      `x ${at}, hits ${JSON.stringify(g.hits)}, labels ${hud.labels.join('|')}  (${fSpace})`);
  }

  await click(await center('B'));
  const hB = async (k) => { const p = await ed.ev(`Editor.handle('${k}')`); return { x: Math.round(p.x), y: Math.round(p.y) }; };
  await oneStep('resize: the corner handle, Ctrl (no snapping)', async () => { const p = await hB('se'); await drag(p, by(p, 100, 50, z), { mods: CTRL }); },
    async (b, a) => { const t = byName(a, 'B').transform; const want = { x: 700, y: 200, w: 200 + eff(100, z), h: 150 + eff(50, z) }; return [eqT(t, want), fmtT(t)]; });
  await ed.ev('Editor.undo()');
  await oneStep('resize: Shift keeps the shape', async () => { const p = await hB('se'); await drag(p, by(p, 100, 10, z), { mods: SHIFT | CTRL }); },
    async (b, a) => { const t = byName(a, 'B').transform; return [t.x === 700 && t.y === 200 && Math.abs(t.w / t.h - 200 / 150) < 0.01 && t.w > 290, fmtT(t)]; });
  await ed.ev('Editor.undo()');
  await oneStep('resize: Alt resizes from the center', async () => { const p = await hB('e'); await drag(p, by(p, 50, 0, z), { mods: ALT | CTRL }); },
    async (b, a) => { const t = byName(a, 'B').transform; const d = eff(50, z); return [t.w === 200 + 2 * d && t.x === 700 - d && t.y === 200 && t.h === 150, fmtT(t)]; });
  await ed.ev('Editor.undo()');
  await oneStep('resize: an edge snaps to the canvas center line', async () => { const p = await hB('e'); await drag(p, by(p, 56, 0, z)); },
    async (b, a) => { const t = byName(a, 'B').transform; return [t.x + t.w === 960 && t.x === 700 && t.h === 150, fmtT(t)]; });
  await ed.ev('Editor.undo()');

  const centerOf = (t) => { const r = (t.rotation || 0) * Math.PI / 180; return { x: t.x + (t.w / 2) * Math.cos(r) - (t.h / 2) * Math.sin(r), y: t.y + (t.w / 2) * Math.sin(r) + (t.h / 2) * Math.cos(r) }; };
  await oneStep('rotate: the knob turned a quarter turn lands on 90 degrees, about the center', async () => {
    const t = await T('B'); const k = await hB('rot'); const c = await C(t.x + t.w / 2, t.y + t.h / 2);
    const rr = Math.hypot(k.x - c.x, k.y - c.y);
    const pts = [];
    for (let i = 1; i <= 8; i++) { const a = -Math.PI / 2 + (Math.PI / 2 + 0.03) * (i / 8); pts.push({ x: Math.round(c.x + rr * Math.cos(a)), y: Math.round(c.y + rr * Math.sin(a)) }); }
    await mouse('mouseMoved', k); await mouse('mousePressed', k, 0, 'left', true);
    for (const p of pts) { await mouse('mouseMoved', p, 0, 'left', true); await sleep(14); }
    await sleep(50); await release(pts[pts.length - 1]);
  }, async (b, a) => { const t = byName(a, 'B').transform, c0 = centerOf(byName(b, 'B').transform), c1 = centerOf(t);
    return [t.rotation === 90 && Math.hypot(c1.x - c0.x, c1.y - c0.y) < 0.6, `r ${t.rotation}, center (${c1.x.toFixed(2)}, ${c1.y.toFixed(2)}) was (${c0.x}, ${c0.y})`]; });
  await oneStep('resize a rotated layer: the far side stays put', async () => { const p = await hB('e'); await drag(p, by(p, 0, 60, z), { mods: CTRL }); },
    async (b, a) => {
      const t0 = byName(b, 'B').transform, t = byName(a, 'B').transform;
      const far = (q) => { const r = q.rotation * Math.PI / 180; return { x: q.x - (q.h / 2) * Math.sin(r), y: q.y + (q.h / 2) * Math.cos(r) }; };      // local (0, 0.5)
      const f0 = far(t0), f1 = far(t);
      return [t.w === t0.w + eff(60, z) && t.h === t0.h && Math.hypot(f1.x - f0.x, f1.y - f0.y) < 1, `w ${t0.w} -> ${t.w}, far side moved ${Math.hypot(f1.x - f0.x, f1.y - f0.y).toFixed(2)} px`];
    });
  await ed.ev('Editor.undo()'); await ed.ev('Editor.undo()');
  await oneStep('rotate: Shift turns in 15 degree steps', async () => {
    const t = await T('B'); const k = await hB('rot'); const c = await C(t.x + t.w / 2, t.y + t.h / 2);
    const rr = Math.hypot(k.x - c.x, k.y - c.y); const a = -Math.PI / 2 + 37 * Math.PI / 180;
    await drag(k, { x: Math.round(c.x + rr * Math.cos(a)), y: Math.round(c.y + rr * Math.sin(a)) }, { mods: SHIFT });
  }, async (b, a) => { const t = byName(a, 'B').transform; return [t.rotation === 30, `r ${t.rotation}`]; });

  {
    const h = await ed.ev('Editor.history()');
    for (let i = 0; i < h.undo; i++) await ed.ev('Editor.undo()');
    check(`undo all ${h.undo} steps of part 1 returns the layout exactly`, shape(await S()) === shape(initial), h.labels.join(', '));
  }

  // ================= part 2: selecting, several at once, guides, grid, fields, align, arrange
  z = await Z();
  const empty = await C(40, 450);
  await drag(empty, await C(750, 300));
  check('a box dragged on empty canvas (over the background) selects what it touches', (await selNames()) === 'A,B', await selNames());
  await click(await center('C'), SHIFT);
  const three = await selNames();
  await click(await center('B'), CTRL);
  check('Shift+click adds, Ctrl+click takes away', three === 'A,B,C' && (await selNames()) === 'A,C', `${three} then ${await selNames()}`);
  await click(empty);
  check('a click on empty canvas selects nothing', (await selNames()) === '');

  await sel('A', 'B');
  await oneStep('resize two layers from their shared box: each keeps its place in it', async () => {
    const p = await hB('se'); await drag(p, by(p, 140, 30, z), { mods: CTRL });
  }, async (b, a) => {
    const A = byName(a, 'A').transform, B = byName(a, 'B').transform;
    const kx = (700 + eff(140, z)) / 700, ky = (150 + eff(30, z)) / 150;
    const want = { A: { x: 200, y: 200, w: Math.round(200 * kx), h: Math.round(150 * ky) }, B: { x: Math.round(200 + 500 * kx), y: 200, w: Math.round(200 * kx), h: Math.round(150 * ky) } };
    return [Math.abs(A.x - 200) < 1 && A.y === 200 && Math.abs(A.w - want.A.w) <= 1 && Math.abs(B.x - want.B.x) <= 1 && Math.abs(B.w - want.B.w) <= 1 && Math.abs(B.h - want.B.h) <= 1,
      `A ${fmtT(A)}, B ${fmtT(B)}; want A.w ${want.A.w}, B.x ${want.B.x}`];
  });

  await sel('A');
  await ed.ev(`document.getElementById('viewport').focus()`);
  await oneStep('arrows nudge 1 px, Shift+arrows 10 px; a run of presses is one step', async () => {
    for (let i = 0; i < 3; i++) await ed.key('ArrowRight', 'ArrowRight');
    for (let i = 0; i < 2; i++) await ed.key('ArrowDown', 'ArrowDown', SHIFT);
  }, async (b, a) => { const t0 = byName(b, 'A').transform, t = byName(a, 'A').transform; return [t.x === t0.x + 3 && t.y === t0.y + 20, `${t0.x},${t0.y} -> ${t.x},${t.y}`]; });

  // Guides: from the top ruler, moved, snapped to, dragged back off.
  const vpr = await ed.ev(`(() => { const r = document.getElementById('viewport').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
  await oneStep('a guide dragged from the top ruler lands where it is let go', async () => {
    // y 500: nothing within snapping reach of it (A's middle, after the nudge, is near 300).
    const at = await C(1700, 500); await drag({ x: Math.round(vpr.x + 400), y: Math.round(vpr.y + 10) }, { x: Math.round(vpr.x + 400), y: at.y });
  }, async (b, a) => { const g = a.guides.h; return [g.length === 1 && Math.abs(g[0] - 500) <= 1, JSON.stringify(a.guides)]; });
  const gy = (await S()).guides.h[0];
  const fGuide = await shot('p8_guides.png');
  await oneStep('a guide dragged along moves', async () => {
    const p = await C(1700, gy); await drag({ x: p.x, y: p.y }, await C(1700, 420));
  }, async (b, a) => [a.guides.h.length === 1 && Math.abs(a.guides.h[0] - 420) <= 1, JSON.stringify(a.guides) + '  (' + fGuide + ')']);
  await ed.ev(`Editor.setField('', 'guides.h', [420])`);                 // exactly 420 for the snap below
  await oneStep('a layer snaps to a guide', async () => {
    const t = await T('C'); const from = await center('C'); await drag(from, by(from, 0, 415 - t.y, z));
  }, async (b, a) => { const t = byName(a, 'C').transform; return [t.y === 420, fmtT(t)]; });
  await oneStep('a guide dragged back onto its ruler is removed', async () => {
    const p = await C(1700, 420); await drag(p, { x: p.x, y: Math.round(vpr.y + 8) });
  }, async (b, a) => [a.guides.h.length === 0, JSON.stringify(a.guides)]);

  await ed.ev(`Editor.setPref('grid', true); Editor.setPref('gridSize', 50)`);
  await oneStep('with the grid on, a layer snaps to it where nothing else is near', async () => {
    const t = await T('R3'); const from = await center('R3'); await drag(from, by(from, 1458 - t.x, 103 - t.y, z));
  }, async (b, a) => { const t = byName(a, 'R3').transform; return [t.x === 1450 && t.y === 100, fmtT(t)]; });
  await ed.ev(`Editor.setPref('grid', false)`);

  // Inspector math.
  await sel('A');
  const field = async (f, text, key = 'Enter') => {
    await ed.ev(`(() => { const n = document.querySelector('#inspector [data-field="${f}"], #inspector [data-mfield="${f}"]'); n.focus(); n.select(); })()`);
    if (text) await ed.send('Input.insertText', { text });
    if (key === 'Enter') await ed.key('Enter', 'Enter', 0, '\r');
    else await ed.key(key, key, key === 'ArrowUp' ? SHIFT : 0);
    await sleep(60);
  };
  for (const [f, text, fn, key] of [['transform.x', '+20', (v) => v + 20], ['transform.w', '*2', (v) => v * 2], ['transform.y', '1080/4', () => 270],
    ['transform.x', '-=15', (v) => v - 15], ['transform.w', '', (v) => v + 10, 'ArrowUp']]) {
    const k = f.split('.')[1];
    await oneStep(`inspector: "${text || 'Shift+Up'}" in ${k.toUpperCase()}`, async () => field(f, text, key || 'Enter'),
      async (b, a) => { const v0 = byName(b, 'A').transform[k], v = byName(a, 'A').transform[k]; return [v === fn(v0), `${v0} -> ${v}`]; });
  }
  await sel('A', 'B');
  await oneStep('inspector, two layers: "*0.5" in W halves each one\'s own width', async () => field('transform.w', '*0.5'),
    async (b, a) => [['A', 'B'].every((n) => byName(a, n).transform.w === Math.round(byName(b, n).transform.w * 50) / 100), ['A', 'B'].map((n) => `${byName(b, n).transform.w}->${byName(a, n).transform.w}`).join(', ')]);
  await ed.ev(`document.getElementById('viewport').focus()`);

  // Align and space out, from the inspector's buttons.
  {
    const h = await ed.ev('Editor.history()');
    for (let i = 0; i < h.undo; i++) await ed.ev('Editor.undo()');
  }
  await sel('A', 'B', 'C');
  await oneStep('space out across: equal gaps, the outer two stay', async () => ed.ev(`document.querySelector('#inspector [data-dist="h"]').click()`),
    async (b, a) => { const [A, B, Cc] = ['A', 'B', 'C'].map((n) => byName(a, n).transform); const g1 = B.x - (A.x + A.w), g2 = Cc.x - (B.x + B.w);
      return [g1 === g2 && A.x === 200 && Cc.x === 1300, `gaps ${g1}, ${g2}`]; });
  await oneStep('align left: to the leftmost', async () => ed.ev(`document.querySelector('#inspector [data-align="left"]').click()`),
    async (b, a) => [['A', 'B', 'C'].every((n) => byName(a, n).transform.x === 200), ['A', 'B', 'C'].map((n) => byName(a, n).transform.x).join(',')]);
  await sel('C');
  await oneStep('one layer: align centers puts it in the middle of the canvas', async () => ed.ev(`document.querySelector('#inspector [data-align="hcenter"]').click()`),
    async (b, a) => { const t = byName(a, 'C').transform; return [t.x === (1920 - t.w) / 2, fmtT(t)]; });

  // Arrange from the keyboard.
  await sel('A');
  await ed.ev(`document.getElementById('viewport').focus()`);
  const order = (s) => s.layers.map((l) => l.name).join(' ');
  await oneStep('Ctrl+Shift+] brings to the front', async () => ed.key('}', 'BracketRight', CTRL | SHIFT),
    async (b, a) => [a.layers[a.layers.length - 1].name === 'A', order(a)]);
  await oneStep('Ctrl+Shift+[ sends to the back, above the background', async () => ed.key('{', 'BracketLeft', CTRL | SHIFT),
    async (b, a) => [a.layers[0].name === 'Background' && a.layers[1].name === 'A', order(a)]);
  await oneStep('Ctrl+] brings forward one', async () => ed.key(']', 'BracketRight', CTRL),
    async (b, a) => [a.layers[2].name === 'A', order(a)]);

  // The right-click menu, by pointer and by keyboard.
  {
    const cc = await center('R2');
    await mouse('mouseMoved', cc); await mouse('mousePressed', cc, 0, 'right', true); await mouse('mouseReleased', cc, 0, 'right', false);
    await sleep(120);
    const items = await ed.ev('Editor.menu()');
    const fMenu = await shot('p8_menu.png');
    const focusIn = await ed.ev(`!!document.activeElement.closest('.ctx')`);
    check('right-click on a layer selects it and opens its menu, focus in the menu', (await selNames()) === 'R2' && items && items.includes('Bring to front') && items.includes('Align left') && focusIn,
      `${(items || []).length} items  (${fMenu})`);
    await oneStep('the menu works from the keyboard: arrows to "Bring to front", Enter', async () => {
      const enabled = await ed.ev(`[...document.querySelectorAll('.ctx [data-i]:not([aria-disabled="true"])')].map((b) => b.getAttribute('aria-label') || b.querySelector('span').textContent)`);
      for (let i = 0; i < enabled.indexOf('Bring to front'); i++) await ed.key('ArrowDown', 'ArrowDown');
      await ed.key('Enter', 'Enter', 0, '\r');
    }, async (b, a) => [a.layers[a.layers.length - 1].name === 'R2' && !(await ed.ev('Editor.menu()')), order(a)]);
    await ed.ev(`document.getElementById('viewport').focus()`);
    await ed.key('F10', 'F10', SHIFT);
    await sleep(80);
    const kb = await ed.ev('Editor.menu()');
    await ed.key('Escape', 'Escape');
    await sleep(60);
    const closed = await ed.ev(`!Editor.menu() && document.activeElement.id === 'viewport'`);
    check('Shift+F10 opens the selection\'s menu, Esc closes it and focus comes back', !!kb && kb.includes('Bring to front') && closed);
  }

  // ---- the same pointer math zoomed in and out, the screen at 150%
  await ed.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1.5, mobile: false });
  await sleep(300);
  for (const zoom of [2, 0.3]) {
    const t = await T('T');
    // Zoomed about T's bottom-right corner, so that corner (and its handle) stays on screen.
    await ed.ev(`Editor.zoom(${zoom}, ${t.x + t.w}, ${t.y + t.h})`);
    await sleep(150);
    const zz = await Z();
    await sel('T');
    await oneStep(`at ${Math.round(zz * 100)}% zoom, screen at 150%: a move lands exactly`, async () => {
      const tt = await T('T'); const from = await C(tt.x + tt.w * 0.9, tt.y + tt.h * 0.75); await drag(from, by(from, 37, -23, zz), { mods: ALT });
    },
      async (b, a) => { const t0 = byName(b, 'T').transform, t1 = byName(a, 'T').transform; return [t1.x === t0.x + eff(37, zz) && t1.y === t0.y + eff(-23, zz), `${t0.x},${t0.y} -> ${t1.x},${t1.y}, want +${eff(37, zz)},${eff(-23, zz)}`]; });
    await oneStep(`at ${Math.round(zz * 100)}% zoom, screen at 150%: a resize lands exactly`, async () => { const p = await hB('se'); await drag(p, by(p, 13, 9, zz), { mods: CTRL }); },
      async (b, a) => { const t0 = byName(b, 'T').transform, t1 = byName(a, 'T').transform; return [t1.w === t0.w + eff(13, zz) && t1.h === t0.h + eff(9, zz) && t1.x === t0.x, `${t0.w}x${t0.h} -> ${t1.w}x${t1.h}`]; });
  }
  await ed.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(200);
  await ed.ev('Editor.fit()');
  await sleep(150);
  z = await Z();

  // ---- an open output follows a drag while it is still going
  await ed.ev('Editor.flush()');
  const out = await open(`${RIG}/scene.html?id=${SID}`);
  await out.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 540, deviceScaleFactor: 1, mobile: false });
  await waitFor(out, `window.SceneDebug && SceneDebug.scene()`, 8000);
  await sleep(500);
  {
    const t = await T('R1');
    const from = await center('R1');
    await drag(from, by(from, 300, 500, z), { mods: ALT, hold: true });
    const live = await ed.ev(`Editor.scene().layers.find((l) => l.name === 'R1').transform`);
    const seen = await waitFor(out, `(() => { const l = SceneDebug.scene().layers.find((x) => x.name === 'R1'); return l && l.transform.x === ${live.x} && l.transform.y === ${live.y}; })()`, 3000);
    await release(by(from, 300, 500, z), ALT);
    check('an open output follows a drag before it is let go', seen && live.x !== t.x, `R1 at ${live.x},${live.y} in the output during the drag: ${seen}`);
  }

  {
    const h = await ed.ev('Editor.history()');
    for (let i = 0; i < h.undo; i++) await ed.ev('Editor.undo()');
    check(`undo all ${h.undo} steps of part 2 returns the layout exactly`, shape(await S()) === shape(initial), h.labels.join(', '));
  }
  await ed.ev('Editor.flush()');
  const onServer = await getScene(SID);
  check('the layout is back on the server too', shape(onServer) === shape(initial));

  // ---- copy and paste: into the same scene, into another (a phone scene), text as a layer
  await sel('A', 'B');
  await ed.ev(`Editor.group(Editor.selection())`);
  await ed.ev(`document.getElementById('viewport').focus()`);
  const copied = await ed.ev(`(() => { window.__dt = new DataTransfer(); const ev = new ClipboardEvent('copy', { clipboardData: __dt, bubbles: true, cancelable: true });
    document.dispatchEvent(ev); return { prevented: ev.defaultPrevented, types: [...__dt.types], names: __dt.getData('text/plain') }; })()`);
  check('copy puts the layers on the clipboard event (their own type, names as text)', copied.prevented && copied.types.includes('application/x-awesome-canvas') && copied.names === 'A\nB', JSON.stringify(copied));
  await oneStep('paste into the same scene: a step down and right, in a group of their own', async () => ed.ev(`document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: __dt, bubbles: true, cancelable: true }))`),
    async (b, a) => {
      const made = a.layers.slice(-2), A0 = byName(b, 'A');
      return [made.map((l) => l.name).join() === 'A,B' && made[0].transform.x === A0.transform.x + 24 && made[0].group && made[0].group === made[1].group && made[0].group !== A0.group && !b.layers.some((l) => l.id === made[0].id),
        made.map((l) => `${l.name} ${l.transform.x},${l.transform.y} g ${l.group}`).join('; ')];
    });
  await oneStep('paste again: another step on', async () => ed.ev(`document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: __dt, bubbles: true, cancelable: true }))`),
    async (b, a) => { const A0 = a.layers.find((l) => l.name === 'A'); const last = a.layers[a.layers.length - 2]; return [last.transform.x === A0.transform.x + 48, `${last.transform.x}`]; });
  await ed.ev(`Editor.load(${JSON.stringify(SID2)})`);
  await waitFor(ed, `Editor.scene().id === ${JSON.stringify(SID2)}`, 5000);
  await sleep(600);
  await ed.ev(`document.getElementById('viewport').focus()`);
  await oneStep('paste into another scene (a phone one): the same layers, where they were', async () => ed.ev(`document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: __dt, bubbles: true, cancelable: true }))`),
    async (b, a) => {
      const src = copied && JSON.parse(await ed.ev(`__dt.getData('application/x-awesome-canvas')`));
      const ok = a.layers.length === 2 && a.layers.every((l, i) => JSON.stringify(l.transform) === JSON.stringify(src.layers[i].transform) &&
        JSON.stringify(l.props) === JSON.stringify(src.layers[i].props) && l.id !== src.layers[i].id) && a.layers[0].group && a.groups[a.layers[0].group];
      return [!!ok, a.layers.map((l) => `${l.name} ${fmtT(l.transform)}`).join('; ')];
    });
  await oneStep('pasted text becomes a text layer', async () => ed.ev(`(() => { const d = new DataTransfer(); d.setData('text/plain', 'Hello chat'); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true })); })()`),
    async (b, a) => { const l = a.layers[a.layers.length - 1]; return [l.type === 'text' && l.props.text === 'Hello chat', `${l.type} "${l.props.text}"`]; });
  await ed.ev('Editor.flush()');
  const s2 = await getScene(SID2);
  check('the pasted layers are saved in the other scene', s2.layers.length === 3);

  // A phone scene with its safe zones and the grid, for the eye.
  await ed.ev(`Editor.setPref('grid', true); Editor.setPref('gridSize', 60); Editor.select([]); Editor.fit()`);
  await sleep(400);
  const safeShown = await ed.ev(`!document.getElementById('safeLayer').hidden && document.querySelectorAll('#safeLayer .safe-zone').length === 4 && !document.getElementById('gridLayer').hidden`);
  const fPhone = await shot('p8_phone_safe_grid.png');
  check('a phone scene shows TikTok\'s safe zones and the grid', safeShown, fPhone);
  await ed.ev(`Editor.setPref('grid', false)`);

  await sleep(300);
  const errs = [...ed.errors, ...out.errors.map((e) => 'output ' + e)];
  check('no console errors in the editor or the output page', errs.length === 0, errs.slice(0, 5).join(' || '));
  console.log('shots: ' + [fSel].join(', '));
  const failed = results.filter(([, ok]) => !ok).map(([n]) => n);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed` + (failed.length ? '; FAILED: ' + failed.join('; ') : ''));
  process.exit(0);
})().catch((e) => { console.log('ERROR ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 3).join('\n')); process.exit(1); });
