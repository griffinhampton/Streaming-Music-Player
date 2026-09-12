// P9 inspector tests in headless Chrome (no window on any monitor):
//   node p9test.js <devtools port> <scene id> <outdir> <golden dir> [rig port] [update]
// A scene with every layer type - all four components among them, Now
// Playing customized and the other three linked. Per layer type: the
// inspector's sections, a golden screenshot of it (compared to
// tools/p9/golden, written there the first time or with "update"), and its
// fields driven like a person would, each checked in the scene, in the
// preview's rendering, and as exactly one undo step. Then: a design change in
// the deck reaching the linked window and not the customized one, the see-
// through options inside the embedded page, the camera's live indicator,
// the voice threshold and its meter, fonts and pictures added from the
// inspector, entrances and loops (stilled by Ultra), triggers, the scene's
// own background, the connection count, undo all the way back, and no
// console errors. What depends on this PC (the asset list, screens and
// windows, cameras) is answered by the test, so the pictures are stable.
const fs = require('fs');
const path = require('path');
const [port, SID, outdir, goldenDir, rigPort = '8799', mode = ''] = process.argv.slice(2);
const UPDATE = mode === 'update';
const RIG = `http://127.0.0.1:${rigPort}`;
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 480000).unref();
const results = [];
const check = (name, ok, detail = '') => { results.push([name, !!ok]); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? `  (${detail})` : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VK = { Enter: 13, Escape: 27, Tab: 9 };

async function open(url, stubs) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURI(url)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const page = { ws, id: 0, pending: new Map(), errors: [], chooser: null, targetId: t.id };
  ws.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    if (m.id && page.pending.has(m.id)) { page.pending.get(m.id)(m); page.pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') page.errors.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n')[0]);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') page.errors.push('console.error: ' + m.params.args.map((a) => a.value || a.description).join(' ').slice(0, 200));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon|status of 409/.test((m.params.entry.url || '') + m.params.entry.text)) page.errors.push('log: ' + m.params.entry.text.slice(0, 200) + ' ' + (m.params.entry.url || ''));
    if (m.method === 'Page.fileChooserOpened') page.chooser = m.params;
    if (m.method === 'Fetch.requestPaused' && stubs) {
      const hit = stubs(m.params.request.url);
      if (hit) {
        page.send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: hit.type }, { name: 'Cache-Control', value: 'no-store' }],
          body: Buffer.from(hit.body).toString('base64') });
      } else page.send('Fetch.continueRequest', { requestId: m.params.requestId });
    }
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
  if (stubs) await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
  return page;
}
async function waitFor(page, expr, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await page.ev(expr)) return true; } catch (_) { /* not yet */ }
    await sleep(60);
  }
  return false;
}
const post = (p, body) => fetch(RIG + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const getJ = async (p) => (await fetch(RIG + p, { cache: 'no-store' })).json();

let ed, out;
const S = async () => JSON.parse(await ed.ev('JSON.stringify(Editor.scene())'));
const byName = (s, n) => s.layers.find((l) => l.name === n);
const shape = (s) => JSON.stringify({ l: s.layers.map((l) => [l.id, l.name, l.visible, l.locked, l.group, l.transform, l.style, l.props, l.triggers]), g: s.groups || {}, b: s.background });
const J = JSON.stringify;
/* In the editor: a control of the inspector, by selector. */
const q = (sel) => `document.querySelector('#inspector ${sel.replace(/'/g, "\\'")}')`;
const setVal = (sel, v, ev = 'input') => ed.ev(`(() => { const n = ${q(sel)}; n.value = ${J(v)}; n.dispatchEvent(new Event('${ev}', { bubbles: true })); return true; })()`);
const clickIn = (sel) => ed.ev(`(() => { const n = ${q(sel)}; n.click(); return true; })()`);
const pv = (expr) => ed.ev(`(() => { const d = document.getElementById('sceneFrame').contentDocument; return (${expr}); })()`);
const pvLayer = (id) => `d.querySelector('.layer[data-id="${id}"]')`;
async function selectName(n) {
  const s = await S();
  await ed.ev(`Editor.select([${J(byName(s, n).id)}])`);
  await sleep(120);
}
async function openAll() {
  await ed.ev(`(() => { for (const d of document.querySelectorAll('#inspector details.sec')) Editor.openSection(d.dataset.sec, true); })()`);
  await sleep(80);
}

async function oneStep(name, act, expect) {
  const h0 = (await ed.ev('Editor.history()')).undo;
  const before = await S();
  await act();
  await sleep(160);
  const after = await S();
  const h1 = await ed.ev('Editor.history()');
  let ok = false, detail = '';
  try { [ok, detail] = await expect(before, after); } catch (e) { detail = 'expect threw ' + e.message; }
  await ed.ev('Editor.undo()');
  const undone = await S();
  await ed.ev('Editor.redo()');
  const redone = await S();
  await sleep(60);
  const u = shape(undone) === shape(before), r = shape(redone) === shape(after);
  check(name, ok && h1.undo === h0 + 1 && u && r, `${detail}; ${h1.undo - h0} step "${h1.labels[h1.labels.length - 1]}", undo ${u ? 'exact' : 'WRONG'}, redo ${r ? 'exact' : 'WRONG'}`);
  return after;
}

/* The inspector as a picture, next to its golden copy. */
const HIDE_DYNAMIC = `.meter i { width: 0 !important; } [data-voice-note], [data-live-note], #mediaLive, .cb-save { visibility: hidden !important; }
  * { caret-color: transparent !important; }`;
async function golden(name) {
  await ed.ev(`(() => { document.activeElement && document.activeElement.blur(); const s = document.createElement('style'); s.id = 'p9hide'; s.textContent = ${J(HIDE_DYNAMIC)}; document.head.appendChild(s); document.getElementById('inspector').scrollTop = 0; })()`);
  await sleep(250);
  const clip = await ed.ev(`(() => { const el = document.getElementById('inspector'); const r = el.getBoundingClientRect(); const inner = el.firstElementChild.getBoundingClientRect();
    return { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.floor(r.width), height: Math.ceil(Math.min(r.height, inner.bottom - r.top + 12)), scale: 1 }; })()`);
  const shot = (await ed.send('Page.captureScreenshot', { format: 'png', clip })).result.data;
  await ed.ev(`document.getElementById('p9hide').remove()`);
  const file = path.join(goldenDir, `p9_${name}.png`);
  fs.writeFileSync(path.join(outdir, `p9_${name}.png`), Buffer.from(shot, 'base64'));
  if (UPDATE || !fs.existsSync(file)) {
    fs.writeFileSync(file, Buffer.from(shot, 'base64'));
    check(`golden: the ${name} inspector`, true, `written ${clip.width}x${clip.height}`);
    return;
  }
  const want = fs.readFileSync(file).toString('base64');
  const d = await ed.ev(`(async () => {
    const load = (s) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'data:image/png;base64,' + s; });
    const [A, B] = await Promise.all([load(${J(shot)}), load(${J(want)})]);
    if (A.width !== B.width || A.height !== B.height) return { size: [A.width + 'x' + A.height, B.width + 'x' + B.height] };
    const c = document.createElement('canvas'); c.width = A.width; c.height = A.height; const x = c.getContext('2d');
    x.drawImage(A, 0, 0); const a = x.getImageData(0, 0, c.width, c.height).data;
    x.clearRect(0, 0, c.width, c.height); x.drawImage(B, 0, 0); const b = x.getImageData(0, 0, c.width, c.height).data;
    let bad = 0; for (let i = 0; i < a.length; i += 4) if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 48) bad++;
    return { ratio: bad / (a.length / 4) };
  })()`);
  check(`golden: the ${name} inspector matches`, d.ratio !== undefined && d.ratio <= 0.01,
    d.size ? `size ${d.size[0]} vs golden ${d.size[1]}` : `${(d.ratio * 100).toFixed(2)}% of pixels differ`);
}

(async () => {
  fs.mkdirSync(goldenDir, { recursive: true });
  // ---- two pictures of our own, and a thumbnail, made in a page of the rig
  ed = await open(`${RIG}/canvas.html?scene=${SID}`);
  await waitFor(ed, `location.origin === ${J(RIG)} && document.readyState === 'complete'`, 10000);
  const made = await ed.ev(`(async () => {
    const png = (w, h, draw) => { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); return c.toDataURL('image/png'); };
    const a = png(96, 96, (x, w, h) => { x.fillStyle = '#8b5cf6'; x.fillRect(0, 0, w, h); x.fillStyle = '#fff'; x.fillRect(24, 24, 48, 48); });
    const b = png(96, 96, (x, w, h) => { x.fillStyle = '#f472b6'; x.fillRect(0, 0, w, h); x.fillStyle = '#000'; x.beginPath(); x.arc(48, 48, 30, 0, 7); x.fill(); });
    const thumb = png(160, 90, (x, w, h) => { x.fillStyle = '#123'; x.fillRect(0, 0, w, h); x.fillStyle = '#4af'; x.fillRect(10, 10, 60, 40); });
    const up = async (name, data) => (await (await fetch('/api/assets/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, data }) })).json());
    const A = await up('p9-a.png', a), B = await up('p9-b.png', b);
    const all = (await (await fetch('/api/assets', { cache: 'no-store' })).json()).assets;
    // By name: the ids are new every run, and the grid's pictures must not trade places.
    const list = all.filter((x) => x.id === A.id || x.id === B.id).sort((x, y) => x.name.localeCompare(y.name));
    return { a: A.id, b: B.id, list, thumb: thumb.split(',')[1] };
  })()`);
  const A1 = made.a, A2 = made.b;
  const fontsBefore = (await getJ('/api/fonts')).fonts.map((f) => f.id);
  const origCfg = await getJ('/api/config');
  const origThreshold = (await getJ('/api/voice')).threshold;
  ed.ws.close();
  await fetch(`http://127.0.0.1:${port}/json/close/${ed.targetId}`).catch(() => {});      // one editor at a time

  // ---- the scene: every layer type, the four components among them
  const L = (n, name, type, x, y, w, h, props, extra = {}) => Object.assign({ id: (0xb1000000 + n).toString(16), type, name, visible: true, locked: false, group: '',
    transform: { x, y, w, h, rotation: 0, anchor: 'tl' }, style: { opacity: 1, blend: 'normal', radius: 0 }, props, triggers: [] }, extra);
  const LAYOUT = [
    L(0, 'Bg', 'background', 0, 0, 1920, 1080, { mode: 'solid', color: '#1a1030' }),
    L(1, 'Title', 'text', 60, 40, 680, 140, { text: 'Hello {title}', size: 72, weight: 700, color: '#ffffff', align: 'center', valign: 'center' }),
    L(2, 'Pic', 'image', 60, 220, 320, 200, { src: A1, fit: 'cover' }),
    L(3, 'Box', 'shape', 420, 220, 320, 200, { kind: 'rect', fill: '#8b5cf6' }),
    L(4, 'NP', 'component', 780, 40, 700, 180, { component: 'np', design: 'custom', custom: {}, options: {} }),
    L(5, 'Lyrics', 'component', 780, 240, 520, 260, { component: 'lyrics', design: 'linked', options: {} }),
    L(6, 'Queue', 'component', 1320, 240, 420, 300, { component: 'queue', design: 'linked', options: {} }),
    L(7, 'Captions', 'component', 780, 560, 900, 160, { component: 'captions', design: 'linked', options: {} }),
    L(8, 'Cam', 'camera', 60, 460, 320, 240, { mode: '', mirror: true, mask: 'rounded', width: 640, height: 480, fps: 30 }),
    L(9, 'Screen', 'capture', 420, 460, 320, 180, { mode: 'native', source: { kind: 'monitor', monitor: 0 }, fps: 30, fit: 'contain' }),
    L(10, 'Face', 'reactive', 1500, 740, 300, 300, { idle: A1, talking: A2, blink: '', bounce: 12, fit: 'contain' }),
  ];
  {
    const s = await getJ(`/api/scenes/${SID}`);
    Object.assign(s, { layers: LAYOUT, groups: {}, guides: { h: [], v: [] }, transparency: 'opaque', background: { mode: 'solid', color: '#0f0f17' } });
    const r = await post(`/api/scenes/${SID}`, { scene: s, expect_rev: s.rev });
    if (r.status !== 200) throw new Error('setup save ' + r.status);
  }

  // What depends on this PC, answered by the test.
  const STUBS = (url) => {
    const u = new URL(url);
    if (u.pathname === '/api/assets') return { type: 'application/json', body: J({ assets: made.list }) };
    if (u.pathname === '/api/capture/sources') return { type: 'application/json', body: J({ monitors: [{ name: 'Screen 1' }], windows: [{ title: 'Game window', hwnd: 0 }, { title: 'Browser', hwnd: 0 }] }) };
    if (u.pathname === '/api/capture/thumb') return { type: 'image/png', body: Buffer.from(made.thumb, 'base64') };
    if (u.pathname === '/api/camera/devices') return { type: 'application/json', body: J({ cameras: ['Test Camera'] }) };
    return null;
  };
  ed = await open(`${RIG}/canvas.html?scene=${SID}`, STUBS);
  await ed.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitFor(ed, `location.origin === ${J(RIG)} && document.readyState === 'complete'`, 10000);
  await ed.ev(`localStorage.removeItem('cb-view')`);
  await ed.send('Page.reload', { ignoreCache: true });
  check('the editor loads the scene with every layer type', await waitFor(ed, `window.Editor && Editor.scene() && Editor.scene().layers.length === ${LAYOUT.length}`, 10000));
  await sleep(2500);
  const initial = await S();
  const id = (n) => byName(initial, n).id;

  // ---- per layer type: the sections, and the golden picture
  const SECTIONS = {
    Title: ['type', 'text-fill', 'look', 'decor', 'motion', 'trig'], Pic: ['type', 'look', 'decor', 'motion', 'trig'],
    Bg: ['type', 'look', 'decor', 'motion', 'trig'], Box: ['type', 'look', 'decor', 'motion', 'trig'],
    NP: ['type', 'embed', 'look', 'decor', 'motion', 'trig'], Lyrics: ['type', 'embed', 'look', 'decor', 'motion', 'trig'],
    Cam: ['type', 'look', 'decor', 'motion', 'trig'], Screen: ['type', 'look', 'decor', 'motion', 'trig'], Face: ['type', 'look', 'decor', 'motion', 'trig'],
  };
  await ed.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 3400, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  for (const [n, secs] of Object.entries(SECTIONS)) {
    await selectName(n);
    await openAll();
    await sleep(n === 'NP' || n === 'Screen' ? 900 : 350);
    const got = await ed.ev('Editor.inspector().secs');
    check(`${n} (${byName(initial, n).type}): its inspector has ${secs.join(', ')}`, J(got) === J(secs), J(got));
    await golden(n.toLowerCase());
  }
  await ed.ev('Editor.select([])');
  await sleep(200);
  await openAll();
  await golden('scene');
  await ed.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(300);

  // ---- text
  await selectName('Title');
  await openAll();
  await oneStep('text: typing the words', async () => setVal('textarea[data-lx="props.text"]', 'Hi {artist}'),
    async (b, a) => [byName(a, 'Title').props.text === 'Hi {artist}', byName(a, 'Title').props.text]);
  await oneStep('text: a live-text chip goes in where the cursor is', async () => {
    await ed.ev(`(() => { const t = ${q('textarea[data-lx="props.text"]')}; t.focus(); t.selectionStart = t.selectionEnd = t.value.length; })()`);
    await clickIn('[data-var="{time}"]');
  }, async (b, a) => [byName(a, 'Title').props.text === 'Hi {artist}{time}', byName(a, 'Title').props.text]);
  await oneStep('text: weight is a number', async () => setVal('select[data-lx="props.weight"]', '900', 'change'),
    async (b, a) => [byName(a, 'Title').props.weight === 900, J(byName(a, 'Title').props.weight)]);
  await oneStep('text: align left, and the preview follows', async () => clickIn('[data-lx="props.align"] button[data-v="left"]'),
    async (b, a) => { const ta = await pv(`${pvLayer(id('Title'))}.querySelector('.text-body').style.textAlign`); return [byName(a, 'Title').props.align === 'left' && ta === 'left', ta]; });
  await oneStep('text: gradient fill', async () => clickIn('[data-lx="props.gradient.on"] button[data-v="1"]'),
    async (b, a) => { const g = await pv(`${pvLayer(id('Title'))}.querySelector('.text-body').classList.contains('gradient')`); return [byName(a, 'Title').props.gradient.on === true && g, `on ${byName(a, 'Title').props.gradient.on}, drawn ${g}`]; });
  await oneStep('text: the Glow preset', async () => clickIn('[data-preset="glow"]'),
    async (b, a) => [byName(a, 'Title').props.shadow.blur === 18 && byName(a, 'Title').props.shadow.x === 0, J(byName(a, 'Title').props.shadow)]);
  await oneStep('text: background pill on', async () => clickIn('input[data-lx="props.pill.on"]'),
    async (b, a) => [byName(a, 'Title').props.pill.on === true, J(byName(a, 'Title').props.pill)]);
  await oneStep('text: a color with its opacity', async () => ed.ev(`(() => { const w = ${q('[data-lx="props.pill.color"]')}; w.querySelector('input[type=color]').value = '#ff0000';
      const r = w.querySelector('input[type=range]'); r.value = '50'; r.dispatchEvent(new Event('input', { bubbles: true })); })()`),
    async (b, a) => [byName(a, 'Title').props.pill.color === 'rgba(255, 0, 0, 0.5)', byName(a, 'Title').props.pill.color]);
  await oneStep('text: letter spacing, with its readout', async () => setVal('input[data-lx="props.letter"]', '20'),
    async (b, a) => { const o = await ed.ev(`${q('[data-lxout="props.letter"]')}.textContent`); return [byName(a, 'Title').props.letter === 0.2 && o === '0.20', `${byName(a, 'Title').props.letter}, shows ${o}`]; });

  // ---- picture
  await selectName('Pic');
  await openAll();
  await oneStep('picture: another one from the grid, and the preview shows it', async () => clickIn(`[data-apick="props.src"] [data-ap-id="${A2}"]`),
    async (b, a) => { await sleep(150); const src = await pv(`${pvLayer(id('Pic'))}.querySelector('.media').getAttribute('src')`); return [byName(a, 'Pic').props.src === A2 && String(src).includes(A2), src]; });
  await oneStep('picture: tile, and its tile size appears', async () => clickIn('[data-lx="props.fit"] button[data-v="tile"]'),
    async (b, a) => { const shown = await ed.ev(`!${q('[data-lx="props.tile_size"]')}.closest('[data-show]').hidden`); return [byName(a, 'Pic').props.fit === 'tile' && shown, `fit ${byName(a, 'Pic').props.fit}, tile size shown ${shown}`]; });
  await oneStep('picture: flip across', async () => clickIn('input[data-lx="props.flip_h"]'),
    async (b, a) => { const tr = await pv(`${pvLayer(id('Pic'))}.querySelector('.media').style.transform`); return [byName(a, 'Pic').props.flip_h === true && tr.includes('scaleX(-1)'), tr]; });
  await oneStep('effects: a border', async () => setVal('input[data-lx="style.border.w"]', '6'),
    async (b, a) => { const bd = await pv(`${pvLayer(id('Pic'))}.style.border`); return [byName(a, 'Pic').style.border.w === 6 && bd.startsWith('6px'), bd]; });
  await oneStep('effects: crop 20% off the top, shown as a percentage', async () => setVal('input[data-lx="style.crop.t"]', '20'),
    async (b, a) => { const cp = await pv(`${pvLayer(id('Pic'))}.style.clipPath`); const o = await ed.ev(`${q('[data-lxout="style.crop.t"]')}.textContent`);
      return [byName(a, 'Pic').style.crop.t === 0.2 && cp.startsWith('inset(20%') && o === '20', `${cp}, shows ${o}`]; });
  // A picture dropped on the grid is uploaded and used.
  const dropped = await (async () => {
    const h0 = (await ed.ev('Editor.history()')).undo;
    await ed.ev(`(async () => {
      const c = document.createElement('canvas'); c.width = c.height = 32; const x = c.getContext('2d'); x.fillStyle = '#0f0'; x.fillRect(0, 0, 32, 32);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const dt = new DataTransfer(); dt.items.add(new File([blob], 'p9-drop.png', { type: 'image/png' }));
      const g = ${q('[data-apick="props.src"]')};
      g.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      g.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    })()`);
    const ok = await waitFor(ed, `(() => { const l = Editor.scene().layers.find((x) => x.name === 'Pic'); return l.props.src && l.props.src !== ${J(A2)}; })()`, 6000);
    const s = await S();
    return { ok, src: byName(s, 'Pic').props.src, steps: (await ed.ev('Editor.history()')).undo - h0 };
  })();
  check('picture: one dropped on the grid is uploaded and used, one step', dropped.ok && dropped.steps === 1, `${dropped.src}, ${dropped.steps} step`);

  // ---- background layer: the deck's own background editor
  await selectName('Bg');
  await openAll();
  await oneStep('background: gradient, and only its controls show', async () => clickIn('[data-lx="props.mode"] button[data-v="gradient"]'),
    async (b, a) => { const vis = await ed.ev(`[...document.querySelectorAll('#inspector .bg-when')].filter((s) => !s.hidden).map((s) => s.dataset.when).join('|')`);
      return [byName(a, 'Bg').props.mode === 'gradient' && vis === 'solid gradient', `shown: ${vis}`]; });
  const sceneId = await ed.ev(`document.querySelector('#inspector [data-scene-id]').dataset.sceneId`);
  await oneStep('background: generated artwork from its thumbnail', async () => clickIn(`[data-scene-id="${sceneId}"]`),
    async (b, a) => [byName(a, 'Bg').props.mode === 'scene' && byName(a, 'Bg').props.scene.id === sceneId, J(byName(a, 'Bg').props.scene)]);

  // ---- shape
  await selectName('Box');
  await openAll();
  await oneStep('shape: a frame with a hole, and its settings appear', async () => clickIn('[data-lx="props.kind"] button[data-v="frame"]'),
    async (b, a) => { const shown = await ed.ev(`!${q('[data-lx="props.pad"]')}.closest('[data-show]').hidden`); const hole = await pv(`!!${pvLayer(id('Box'))}.querySelector('.shape-hole')`);
      return [byName(a, 'Box').props.kind === 'frame' && shown && hole, `frame settings ${shown}, hole drawn ${hole}`]; });
  await oneStep('shape: frame width', async () => setVal('input[data-lx="props.pad"]', '40'),
    async (b, a) => [byName(a, 'Box').props.pad === 40, J(byName(a, 'Box').props.pad)]);

  // ---- border loop, animation, triggers (on the box)
  await oneStep('border loop: a pattern', async () => setVal('select[data-lx="props.decor.border"]', 'stars', 'change'),
    async (b, a) => [byName(a, 'Box').props.decor.border === 'stars', J(byName(a, 'Box').props.decor)]);
  await oneStep('border loop: all round, and the preview draws it', async () => clickIn('[data-lx="props.decor.sides"] button[data-v="all"]'),
    async (b, a) => { const on = await pv(`${pvLayer(id('Box'))}.classList.contains('has-decor')`); return [byName(a, 'Box').props.decor.sides === 'all' && on, `drawn ${on}`]; });
  await oneStep('animation: it rises in, and the preview plays it', async () => setVal('select[data-lx="props.enter.kind"]', 'rise', 'change'),
    async (b, a) => { const playing = await pv(`${pvLayer(id('Box'))}.classList.contains('enter-rise')`); return [byName(a, 'Box').props.enter.kind === 'rise' && playing, `playing ${playing}`]; });
  await sleep(700);
  const replay = await (async () => {
    const gone = await pv(`!${pvLayer(id('Box'))}.classList.contains('enter-rise')`);
    await clickIn('[data-replay]');
    await sleep(80);
    return gone && await pv(`${pvLayer(id('Box'))}.classList.contains('enter-rise')`);
  })();
  check('animation: it finishes, and Play plays it again', replay);
  await oneStep('animation: a loop, running in the preview', async () => setVal('select[data-lx="props.motion.kind"]', 'float', 'change'),
    // (An entrance playing - redo brings it back, and plays it - wins over the loop until it ends.)
    async (b, a) => { await sleep(700); const cls = await pv(`${pvLayer(id('Box'))}.classList.contains('loop-float')`); const an = await pv(`getComputedStyle(${pvLayer(id('Box'))}).animationName`);
      return [byName(a, 'Box').props.motion.kind === 'float' && cls && /loop-float/.test(an), an]; });
  await post('/api/config', { ui: { ultra: true } });
  const stilled = await waitFor(ed, `(() => { const d = document.getElementById('sceneFrame').contentDocument; return getComputedStyle(d.querySelector('.layer[data-id="${id('Box')}"]')).animationName === 'none'; })()`, 5000);
  await post('/api/config', { ui: { ultra: !!(origCfg.ui || {}).ultra } });
  check('animation: Ultra optimized stops the loop', stilled);
  await oneStep('triggers: add one', async () => clickIn('[data-trig-add]'),
    async (b, a) => [J(byName(a, 'Box').triggers) === J([{ on: 'speaking', do: 'show' }]), J(byName(a, 'Box').triggers)]);
  await oneStep('triggers: "pop" goes with "when I start talking"', async () => setVal('[data-trig="0"] [data-tf="do"]', 'pop', 'change'),
    async (b, a) => [J(byName(a, 'Box').triggers) === J([{ on: 'speech_start', do: 'pop' }]), J(byName(a, 'Box').triggers)]);
  await oneStep('triggers: remove it', async () => clickIn('[data-trig="0"] [data-trig-del]'),
    async (b, a) => [(byName(a, 'Box').triggers || []).length === 0, J(byName(a, 'Box').triggers)]);

  // ---- components: Now Playing customized, the rest linked
  await ed.ev('Editor.flush()');
  out = await open(`${RIG}/scene.html?id=${SID}`);
  await out.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 540, deviceScaleFactor: 1, mobile: false });
  await waitFor(out, `window.SceneDebug && SceneDebug.embeds().live === 4`, 10000);
  await sleep(1500);
  // The editor back in front: it stops polling (live sources, the meter) while hidden, as it should.
  await ed.send('Page.bringToFront');
  await sleep(300);
  const inEmbed = (n, expr) => out.ev(`(() => { const f = document.querySelector('.layer[data-id="${id(n)}"] iframe'); const d = f && f.contentDocument; return d ? (${expr}) : null; })()`);
  await selectName('NP');
  await openAll();
  await waitFor(ed, `document.querySelectorAll('#inspector [data-deck-design] [data-subtab]').length > 0`, 6000);
  const tabs = await ed.ev(`[...document.querySelectorAll('#inspector [data-subtab]')].map((b) => b.textContent)`);
  const deckCtl = await ed.ev(`document.querySelectorAll('#inspector [data-deck-design] [data-np]').length`);
  check("a customized window gets the deck's own design tabs", J(tabs) === J(['Colors', 'Text', 'Art & bar', 'Decor', 'Background']) && deckCtl > 30, `${tabs.join(', ')}; ${deckCtl} of the deck's controls`);
  await oneStep("custom design: the deck's accent control, for this scene only", async () => setVal('[data-deck-design] input[data-np="accent"]', '#ff00aa'),
    async (b, a) => [byName(a, 'NP').props.custom.accent === '#ff00aa', J(byName(a, 'NP').props.custom)]);
  await ed.ev('Editor.flush()');
  const npAccent = () => inEmbed('NP', `(d.querySelector('.stage') || d.documentElement).style.getPropertyValue('--accent').trim()`);
  const custOk = await waitFor(out, `(() => { const f = document.querySelector('.layer[data-id="${id('NP')}"] iframe'); const s = f && f.contentDocument.querySelector('.stage'); return s && s.style.getPropertyValue('--accent').trim() === '#ff00aa'; })()`, 5000);
  check('custom design: the output shows it', custOk, `--accent ${await npAccent()}`);
  // A change in the deck: the linked window follows; the customized one keeps what it changed.
  const lyText = ((origCfg.lyrics || {}).colors || {}).text || '';
  await post('/api/config', { lyrics: { colors: { text: '#ff3300' } }, nowplaying: { accent: '#00ff00' } });
  const linked = await waitFor(out, `(() => { const f = document.querySelector('.layer[data-id="${id('Lyrics')}"] iframe'); const s = f && f.contentDocument.querySelector('.stage'); return !!s && s.style.cssText.includes('#ff3300'); })()`, 5000);
  await sleep(600);
  const keeps = await npAccent();
  check('a deck design change reaches the linked window live', linked);
  check('...and not what the customized window changed', keeps === '#ff00aa', `--accent ${keeps}`);
  await post('/api/config', { lyrics: { colors: { text: lyText } }, nowplaying: { accent: (origCfg.nowplaying || {}).accent } });
  await oneStep('see-through: no card background, inside the embedded page', async () => clickIn('input[data-lx="props.options.card_bg"]'),
    async (b, a) => { await sleep(200); const cls = await pv(`${pvLayer(id('NP'))}.querySelector('iframe').contentDocument.documentElement.classList.contains('no-card')`);
      return [byName(a, 'NP').props.options.card_bg === false && cls, `no-card ${cls}`]; });
  await oneStep('see-through: leave out the album art', async () => clickIn('input[data-hide-part="art"]'),
    async (b, a) => { await sleep(200); const cls = await pv(`${pvLayer(id('NP'))}.querySelector('iframe').contentDocument.documentElement.classList.contains('hide-art')`);
      return [J(byName(a, 'NP').props.options.hide) === J(['art']) && cls, `hide-art ${cls}`]; });
  await oneStep('Back to my design', async () => clickIn('[data-design-reset]'),
    async (b, a) => [byName(a, 'NP').props.design === 'linked' && byName(a, 'NP').props.custom === undefined, `${byName(a, 'NP').props.design}, custom ${J(byName(a, 'NP').props.custom)}`]);

  // ---- camera: its settings, and the live indicator
  await selectName('Cam');
  await openAll();
  await sleep(300);
  const camOpts = await ed.ev(`[...${q('select[data-cameras]')}.options].map((o) => o.value)`);
  check("camera: the device menu lists Windows' cameras", J(camOpts) === J(['', 'Test Camera']), J(camOpts));
  await oneStep('camera: 1080p sets both sides of the resolution', async () => clickIn('[data-res] button[data-h="1080"]'),
    async (b, a) => [byName(a, 'Cam').props.width === 1920 && byName(a, 'Cam').props.height === 1080, `${byName(a, 'Cam').props.width}x${byName(a, 'Cam').props.height}`]);
  await oneStep('camera: a circle', async () => clickIn('[data-lx="props.mask"] button[data-v="circle"]'),
    async (b, a) => { await sleep(100); const c = await pv(`${pvLayer(id('Cam'))}.classList.contains('mask-circle')`); return [byName(a, 'Cam').props.mask === 'circle' && c, `drawn ${c}`]; });
  const liveOn = await waitFor(ed, `Editor.liveMedia().shown && Editor.liveMedia().ids.includes(${J(id('Cam'))})`, 8000);
  const lm = await ed.ev('Editor.liveMedia()');
  const rowDot = await ed.ev(`!!document.querySelector('#layerTree .row.live-src[data-id="${id('Cam')}"]')`);
  const note = await ed.ev(`(() => { const n = document.querySelector('#inspector [data-live-note]'); return n && !n.hidden ? n.textContent : ''; })()`);
  check('live indicator: the camera open in the editor shows in the top bar, the list and the inspector', liveOn && rowDot && /camera/i.test(note), `"${lm.text}", row ${rowDot}, "${note}"`);
  await ed.ev(`Editor.setVisible([${J(id('Cam'))}], false)`);
  const liveOff = await waitFor(ed, `!Editor.liveMedia().shown`, 6000);
  await ed.ev('Editor.undo()');
  check('live indicator: gone once the camera is hidden', liveOff);

  // ---- capture: sources with thumbnails, the pointer
  await selectName('Screen');
  await openAll();
  await waitFor(ed, `document.querySelectorAll('#inspector [data-srcgrid] [data-src]').length === 3`, 5000);
  const thumbs = await ed.ev(`document.querySelectorAll('#inspector [data-srcgrid] img').length`);
  check('capture: the screens and windows, with thumbnails', thumbs >= 1, `${thumbs} thumbnail(s)`);
  await oneStep('capture: pick a window', async () => clickIn(`[data-src='${J({ kind: 'window', title: 'Game window' })}']`),
    async (b, a) => [J(byName(a, 'Screen').props.source) === J({ kind: 'window', title: 'Game window' }), J(byName(a, 'Screen').props.source)]);
  await oneStep('capture: show the mouse pointer', async () => clickIn('input[data-lx="props.cursor"]'),
    async (b, a) => [byName(a, 'Screen').props.cursor === true, J(byName(a, 'Screen').props.cursor)]);

  // ---- reactive image: pictures, the threshold and its meter
  await selectName('Face');
  await openAll();
  await oneStep('reactive: the quiet picture from its grid', async () => clickIn(`[data-apick="props.idle"] [data-ap-id="${A2}"]`),
    async (b, a) => [byName(a, 'Face').props.idle === A2, byName(a, 'Face').props.idle]);
  await ed.ev('Editor.undo()');
  const meterUp = await waitFor(ed, `document.querySelector('#inspector [data-thr-out]').textContent.endsWith('%')`, 4000);
  await setVal('input[data-threshold]', '25');
  const thrSaved = await (async () => { for (let i = 0; i < 30; i++) { if ((await getJ('/api/voice')).threshold === 0.25) return true; await sleep(100); } return false; })();
  const thrCfg = ((await getJ('/api/config')).voice || {}).threshold;
  check('reactive: the threshold slider sets it for the whole app, and it is kept', meterUp && thrSaved && thrCfg === 0.25, `voice ${(await getJ('/api/voice')).threshold}, config ${thrCfg}`);
  await clickIn('[data-try-talk]');
  const talking = await waitFor(ed, `(() => { const d = document.getElementById('sceneFrame').contentDocument; const i = d.querySelector('.layer[data-id="${id('Face')}"] img'); return i && i.getAttribute('src').includes(${J(A2)}); })()`, 3000);
  const quiet = await waitFor(ed, `(() => { const d = document.getElementById('sceneFrame').contentDocument; const i = d.querySelector('.layer[data-id="${id('Face')}"] img'); return i && i.getAttribute('src').includes(${J(A1)}); })()`, 4000);
  check('reactive: "Try it" shows the talking picture, then the quiet one', talking && quiet);
  await post('/api/voice', { threshold: origThreshold });

  // ---- fonts: added from a text layer's font menu
  await selectName('Title');
  await openAll();
  const fontFile = ['C:\\Windows\\Fonts\\consola.ttf', 'C:\\Windows\\Fonts\\georgia.ttf', 'C:\\Windows\\Fonts\\arial.ttf'].find((f) => fs.existsSync(f));
  if (fontFile) {
    await ed.send('Page.setInterceptFileChooserDialog', { enabled: true });
    ed.chooser = null;
    const h0 = (await ed.ev('Editor.history()')).undo;
    // A file picker opens only for a person's click: this one counts as one.
    await ed.send('Runtime.evaluate', { expression: `${q('.font-add')}.click()`, userGesture: true });
    for (let i = 0; i < 30 && !ed.chooser; i++) await sleep(50);
    if (ed.chooser) await ed.send('DOM.setFileInputFiles', { files: [fontFile], backendNodeId: ed.chooser.backendNodeId });
    const got = await waitFor(ed, `!!Editor.scene().layers.find((l) => l.name === 'Title').props.font`, 8000);
    const fam = byName(await S(), 'Title').props.font;
    const menu = await ed.ev(`${q('select[data-lx="props.font"]')}.value`);
    check('fonts: Add font… uploads it, and the menu and the layer switch to it, one step', got && menu === fam && (await ed.ev('Editor.history()')).undo === h0 + 1, `${fam}`);
    await ed.send('Page.setInterceptFileChooserDialog', { enabled: false });
  } else check('fonts: no Windows font file to try', true, 'skipped');

  // ---- the scene's own background (nothing selected)
  await ed.ev('Editor.select([])');
  await sleep(150);
  await openAll();
  await oneStep("the scene's background uses the deck's editor too", async () => clickIn('[data-sx="background.mode"] button[data-v="gradient"]'),
    async (b, a) => [a.background.mode === 'gradient', a.background.mode]);

  // ---- connections: the output holds one feed, its four embedded windows none
  const feeds = await getJ('/api/feeds');
  const embedFeeds = feeds.open.filter((f) => /^(nowplaying|lyrics|queue|captions)\.html/.test(f.page));
  const outFeeds = feeds.open.filter((f) => f.page.startsWith(`scene.html?id=${SID}`) && !f.page.includes('preview'));
  const embeds = await out.ev('SceneDebug.embeds()');
  check('connections: the output holds one feed and its four windows none, within the cap', outFeeds.length === 1 && embedFeeds.length === 0 && embeds.live === 4 && feeds.counts.windows_sse <= feeds.counts.limit,
    `output feeds ${outFeeds.length}, embedded ${embedFeeds.length}, windows ${embeds.live}, sse ${feeds.counts.windows_sse}/${feeds.counts.limit}, all open: ${feeds.open.map((f) => f.page.split('?')[0] + ':' + f.kind).join(' ')}`);

  // ---- all the way back
  {
    const h = await ed.ev('Editor.history()');
    for (let i = 0; i < h.undo; i++) await ed.ev('Editor.undo()');
    await ed.ev('Editor.flush()');
    const back = await S(), server = await getJ(`/api/scenes/${SID}`);
    check(`undo all ${h.undo} steps returns the scene exactly, on the server too`, shape(back) === shape(initial) && shape(server) === shape(initial), h.labels.slice(-6).join(', '));
  }

  await sleep(400);
  const errs = [...ed.errors, ...out.errors.map((e) => 'output ' + e)];
  check('no console errors in the editor or the output page', errs.length === 0, errs.slice(0, 6).join(' || '));

  // Leave the rig as it was: our pictures and font go.
  for (const aid of [A1, A2, dropped.src]) if (aid) await post('/api/assets/delete', { id: aid, force: true });
  for (const f of (await getJ('/api/fonts')).fonts) if (!fontsBefore.includes(f.id)) await post('/api/fonts/delete', { id: f.id });
  const failed = results.filter(([, ok]) => !ok).map(([n]) => n);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed` + (failed.length ? '; FAILED: ' + failed.join('; ') : ''));
  process.exit(0);
})().catch((e) => { console.log('ERROR ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 3).join('\n')); process.exit(1); });
