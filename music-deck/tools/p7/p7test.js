// P7 editor tests in headless Chrome (no window on any monitor):
//   node p7test.js <devtools port> <scene id> <outdir> [rig port]
// Screenshots at 1600x900 and 1280x720, the panels' roles and focus order,
// the shortcuts overlay, an undo/redo round trip over every kind of change,
// autosave landing on the server, the time from an edit to an open output
// page, an autosave conflict (the editor's save held while the scene is
// changed from outside, then let go), an outside change with nothing
// pending, and no console errors.
const fs = require('fs');
const path = require('path');
const [port, SID, outdir, rigPort = '8799'] = process.argv.slice(2);
const RIG = `http://127.0.0.1:${rigPort}`;
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 180000).unref();
const results = [];
const check = (name, ok, detail = '') => { results.push([name, !!ok]); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? `  (${detail})` : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(url) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURI(url)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const page = { ws, id: 0, pending: new Map(), errors: [], paused: [] };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && page.pending.has(m.id)) { page.pending.get(m.id)(m); page.pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') page.errors.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n')[0]);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') page.errors.push('console.error: ' + m.params.args.map((a) => a.value || a.description).join(' ').slice(0, 200));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon/.test(m.params.entry.url || '') && !/status of 409/.test(m.params.entry.text)) page.errors.push('log: ' + m.params.entry.text.slice(0, 200));
    if (m.method === 'Fetch.requestPaused') page.paused.push(m.params);
  };
  page.send = (method, params = {}) => new Promise((r) => { const i = ++page.id; page.pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  page.ev = async (expression) => {
    const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '').split('\n')[0]);
    return r.result.result.value;
  };
  page.key = async (key, code, mods = 0, text) => {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers: mods, text, windowsVirtualKeyCode: code === 'Tab' ? 9 : code === 'Escape' ? 27 : undefined });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers: mods });
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
const getScene = async () => (await fetch(`${RIG}/api/scenes/${SID}`, { cache: 'no-store' })).json();
const shape = (s) => JSON.stringify({ layers: s.layers.map((l) => [l.id, l.name, l.visible, l.locked, l.group, l.transform, l.props]), groups: s.groups || {}, name: s.name });

(async () => {
  const ed = await open(`${RIG}/canvas.html?scene=${SID}`);
  await ed.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await ed.send('Page.reload', { ignoreCache: true });
  const loaded = await waitFor(ed, `window.Editor && Editor.scene() && Editor.scene().id === ${JSON.stringify(SID)}`, 10000);
  check('the editor loads the scene', loaded);
  await sleep(2500);                                  // the preview's first paint

  // ---- screenshots
  for (const [w, h] of [[1600, 900], [1280, 720]]) {
    await ed.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    await ed.ev(`document.getElementById('zoomFit').click()`);
    await sleep(900);
    const r = await ed.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(outdir, `p7_${w}x${h}.png`);
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    const fits = await ed.ev(`(() => { const v = document.getElementById('viewport').getBoundingClientRect(); const w = document.getElementById('world').getBoundingClientRect(); return w.left >= v.left - 1 && w.right <= v.right + 1 && w.top >= v.top - 1 && w.bottom <= v.bottom + 1 && document.documentElement.scrollWidth <= innerWidth; })()`);
    check(`at ${w}x${h} the page fits and the scene fits the canvas`, fits, file);
  }
  await ed.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);

  // ---- structure and accessibility
  const a11y = await ed.ev(`(() => ({
    tabs: [...document.querySelectorAll('[role=tablist] [role=tab]')].map((t) => t.textContent + ':' + t.getAttribute('aria-controls')),
    tree: !!document.querySelector('[role=tree][aria-multiselectable=true]'),
    items: document.querySelectorAll('[role=treeitem]').length,
    layers: Editor.scene().layers.length,
    inspector: document.getElementById('inspector').getAttribute('aria-label'),
    toolbar: !!document.querySelector('[role=toolbar]'),
    oneTabStopInTree: [...document.querySelectorAll('#layerTree .row')].filter((r) => r.tabIndex === 0).length,
  }))()`);
  check('panels are tabs, the layers a multi-select tree, the inspector labeled', a11y.tabs.length === 3 && a11y.tree && a11y.toolbar && a11y.inspector === 'Inspector', JSON.stringify(a11y.tabs));
  check('one tree item per layer, one Tab stop in the tree', a11y.items === a11y.layers && a11y.oneTabStopInTree === 1, `${a11y.items} items, ${a11y.layers} layers`);
  // Focus order: Tab from the start of the page.
  // From the page's first control (a blur leaves Chrome's starting point where it was).
  await ed.ev(`document.getElementById('scenePick').focus()`);
  const seen = ['top'];
  for (let i = 0; i < 40; i++) {
    await ed.key('Tab', 'Tab');
    const where = await ed.ev(`(() => { const a = document.activeElement; const zone = a.closest('.cb-top') ? 'top' : a.closest('.cb-left') ? 'left' : a.id === 'viewport' ? 'canvas' : a.closest('#inspector') ? 'inspector' : 'other'; return zone; })()`);
    if (seen[seen.length - 1] !== where) seen.push(where);
    if (where === 'inspector') break;
  }
  check('Tab goes top bar, then the panels, then the canvas, then the inspector', seen.join('>') === 'top>left>canvas>inspector', seen.join(' > '));
  const focusRing = await ed.ev(`getComputedStyle(document.activeElement).outlineStyle !== 'none' || getComputedStyle(document.activeElement).boxShadow !== 'none'`);
  check('the focused control shows a focus ring', focusRing);
  await ed.ev(`document.getElementById('viewport').focus()`);
  await ed.key('?', 'Slash', 8, '?');
  const opened = await ed.ev(`!document.getElementById('shortcuts').hidden && document.activeElement.id === 'shortcutsClose'`);
  await ed.key('Escape', 'Escape');
  const closed = await ed.ev(`document.getElementById('shortcuts').hidden && document.activeElement.id === 'viewport'`);
  check('? opens the shortcuts, Esc closes them and focus comes back', opened && closed, `opened ${opened}, closed ${closed}`);

  // ---- undo / redo round trip
  await ed.ev(`Editor.flush()`);
  const s0 = await ed.ev(`JSON.stringify(Editor.scene())`);
  const before = JSON.parse(s0);
  const ids0 = before.layers.map((l) => l.id);
  await ed.ev(`(() => {
    const t = Editor.add(0);
    Editor.rename(t, 'Headline');
    Editor.setField(t, 'transform.x', 111);
    Editor.setField(t, 'props.text', 'Hello');
    Editor.setVisible([${JSON.stringify(ids0[0])}], false);
    Editor.setLocked([${JSON.stringify(ids0[1])}], true);
    Editor.group([${JSON.stringify(ids0[1])}, ${JSON.stringify(ids0[2])}]);
    Editor.move([t], ${JSON.stringify(ids0[0])}, 'below');
    Editor.duplicate([t]);
    Editor.remove([${JSON.stringify(ids0[ids0.length - 1])}]);
    Editor.setField('', 'name', 'P7 edited');
  })()`);
  const h1 = await ed.ev(`Editor.history()`);
  const s1 = await ed.ev(`JSON.stringify(Editor.scene())`);
  for (let i = 0; i < h1.undo; i++) await ed.ev(`Editor.undo()`);
  const back = JSON.parse(await ed.ev(`JSON.stringify(Editor.scene())`));
  check(`undo all ${h1.undo} steps returns the scene exactly`, shape(back) === shape(before), h1.labels.join(', '));
  for (let i = 0; i < h1.undo; i++) await ed.ev(`Editor.redo()`);
  const fwd = JSON.parse(await ed.ev(`JSON.stringify(Editor.scene())`));
  check('redo all returns every change', shape(fwd) === shape(JSON.parse(s1)));
  // Typing a name merges into one step.
  const u0 = (await ed.ev(`Editor.history()`)).undo;
  await ed.ev(`Editor.select([])`);
  await sleep(100);
  await ed.ev(`document.querySelector('#inspector [data-field="name"]').focus(); document.querySelector('#inspector [data-field="name"]').select()`);
  for (const ch of 'Typed') { await ed.send('Input.insertText', { text: ch }); await sleep(40); }
  await sleep(200);
  const u1 = (await ed.ev(`Editor.history()`)).undo;
  check('typing a name is one undo step', u1 === u0 + 1 && (await ed.ev(`Editor.scene().name`)) === 'Typed', `${u0} -> ${u1}`);

  // ---- autosave reaches the server
  const saved = await waitFor(ed, `Editor.saveState().state === 'saved' && !Editor.saveState().dirty`, 5000);
  const server = await getScene();
  check('autosave lands on the server', saved && shape(server) === shape(await ed.ev(`Editor.scene()`)), `server rev ${server.rev}, editor rev ${await ed.ev('Editor.rev()')}`);

  // ---- from an edit to an open output page
  const out = await open(`${RIG}/scene.html?id=${SID}`);
  await out.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 540, deviceScaleFactor: 1, mobile: false });
  await waitFor(out, `window.SceneDebug && SceneDebug.scene() && SceneDebug.scene().rev === ${server.rev}`, 8000);
  await sleep(800);
  const textId = await ed.ev(`Editor.scene().layers.find((l) => l.type === 'text' && l.visible !== false).id`);
  const lat = [];
  for (let k = 0; k < 5; k++) {
    const marker = 'LAT' + k + '-' + Date.now().toString(36);
    const t0 = Date.now();
    await ed.ev(`Editor.setField(${JSON.stringify(textId)}, 'props.text', ${JSON.stringify(marker)}, 'latency')`);
    let t1 = 0;
    while (Date.now() - t0 < 3000) {
      if (await out.ev(`document.body.innerText.includes(${JSON.stringify(marker)})`)) { t1 = Date.now(); break; }
      await sleep(5);
    }
    lat.push(t1 ? t1 - t0 : -1);
    await sleep(600);
  }
  const good = lat.filter((x) => x >= 0).sort((a, b) => a - b);
  check('an edit shows in an open output page within ~100-150 ms', good.length === lat.length && good[Math.floor(good.length / 2)] <= 160, `ms: ${lat.join(', ')} (median ${good[Math.floor(good.length / 2)]})`);

  // ---- an autosave conflict: our save held while someone else saves first
  await waitFor(ed, `Editor.saveState().state === 'saved' && !Editor.saveState().dirty`, 5000);
  await ed.send('Fetch.enable', { patterns: [{ urlPattern: `*/api/scenes/${SID}`, requestStage: 'Request' }] });
  ed.paused.length = 0;
  await ed.ev(`Editor.setField('', 'name', 'Editor change')`);
  const held = await (async () => { for (let i = 0; i < 60; i++) { if (ed.paused.find((p) => p.request.method === 'POST')) return true; await sleep(25); } return false; })();
  const cur = await getScene();
  const other = await post(`/api/scenes/${SID}`, { scene: Object.assign({}, cur, { name: 'Changed elsewhere' }), expect_rev: cur.rev });
  for (const p of ed.paused) await ed.send('Fetch.continueRequest', { requestId: p.requestId });
  ed.paused.length = 0;
  await ed.send('Fetch.disable');
  const reloaded = await waitFor(ed, `Editor.scene().name === 'Changed elsewhere' && Editor.saveState().state === 'conflict'`, 5000);
  const after = await getScene();
  const hist = await ed.ev(`Editor.history()`);
  const toastShown = await ed.ev(`!document.getElementById('toast').hidden && /changed somewhere else/.test(document.getElementById('toast').textContent)`);
  check('a stale save is refused and the newer scene reloaded, with a notice', held && other.status === 200 && reloaded && after.name === 'Changed elsewhere' && hist.undo === 0 && toastShown,
    `held ${held}, outside save ${other.status}, editor "${await ed.ev('Editor.scene().name')}", server "${after.name}", history ${hist.undo}, notice ${toastShown}`);

  // ---- an outside change with nothing pending: taken quietly
  const cur2 = await getScene();
  await post(`/api/scenes/${SID}`, { scene: Object.assign({}, cur2, { name: 'Renamed in the deck' }), expect_rev: cur2.rev });
  const quiet = await waitFor(ed, `Editor.scene().name === 'Renamed in the deck' && Editor.saveState().state !== 'error'`, 5000);
  check('an outside change with nothing pending is taken as it is', quiet);

  await sleep(500);
  const errs = [...ed.errors, ...out.errors.map((e) => 'output ' + e)];
  check('no console errors in the editor or the output page', errs.length === 0, errs.slice(0, 5).join(' || '));
  const failed = results.filter(([, ok]) => !ok).map(([n]) => n);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed` + (failed.length ? '; FAILED: ' + failed.join('; ') : ''));
  process.exit(0);
})().catch((e) => { console.log('ERROR ' + e.message); process.exit(1); });
