// P10 phone-canvas tests in headless Chrome (no window on any monitor):
//   node p10test.js <devtools port> <outdir> [rig port]
// Every template, and the version of it laid out for the other format, as
// its output renders it (a screenshot each), with every layer inside the
// canvas and - for phone versions of the horizontal templates - nothing
// under TikTok's controls. In the editor: the New scene gallery (thumbnails,
// keyboard, making a scene from a template), the format switch laying the
// scene out again as one undo step, "Make a phone version", the warnings on
// layers under TikTok's controls (canvas, list, inspector, the scene's
// count), the safe zones' toggle, snapping to their edge, no console errors.
const fs = require('fs');
const path = require('path');
const [port, outdir, rigPort = '8799'] = process.argv.slice(2);
const RIG = `http://127.0.0.1:${rigPort}`;
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 420000).unref();
const results = [];
const check = (name, ok, detail = '') => { results.push([name, !!ok]); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? `  (${detail})` : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const VK = { Enter: 13, Escape: 27, Tab: 9, ArrowRight: 39, ArrowLeft: 37 };

async function open(url) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURI(url)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const page = { ws, id: 0, pending: new Map(), errors: [], targetId: t.id };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && page.pending.has(m.id)) { page.pending.get(m.id)(m); page.pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') page.errors.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n')[0]);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') page.errors.push('console.error: ' + m.params.args.map((a) => a.value || a.description).join(' ').slice(0, 200));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon|status of 409/.test((m.params.entry.url || '') + m.params.entry.text)) page.errors.push('log: ' + m.params.entry.text.slice(0, 200));
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
  page.close = async () => { try { ws.close(); } catch (_) { /* gone */ } await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {}); };
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Page.enable');
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
const post = (p, body) => fetch(RIG + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: J(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const getJ = async (p) => (await fetch(RIG + p, { cache: 'no-store' })).json();

// The same geometry as scenes.bounds / zone_hits.
const FR = { tl: [0, 0], tc: [0.5, 0], tr: [1, 0], ml: [0, 0.5], mc: [0.5, 0.5], mr: [1, 0.5], bl: [0, 1], bc: [0.5, 1], br: [1, 1] };
function bounds(t) {
  const r = ((t.rotation || 0) * Math.PI) / 180;
  if (Math.abs(Math.sin(r)) < 1e-9 && Math.cos(r) > 0) return { x: t.x, y: t.y, w: t.w, h: t.h };
  const [fx, fy] = FR[t.anchor] || FR.tl, px = t.x + fx * t.w, py = t.y + fy * t.h, c = Math.cos(r), s = Math.sin(r);
  const pts = [[t.x, t.y], [t.x + t.w, t.y], [t.x + t.w, t.y + t.h], [t.x, t.y + t.h]].map(([qx, qy]) => [px + (qx - px) * c - (qy - py) * s, py + (qx - px) * s + (qy - py) * c]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}
const outside = (s) => s.layers.filter((l) => { const b = bounds(l.transform); return b.x < -0.01 || b.y < -0.01 || b.x + b.w > s.width + 0.01 || b.y + b.h > s.height + 0.01; }).map((l) => l.name);
function zoneHits(s, l, zones) {
  if (s.format !== 'phone' || l.visible === false) return [];
  const b = bounds(l.transform);
  if (l.type === 'background' || (b.w >= 0.9 * s.width && b.h >= 0.9 * s.height)) return [];
  return zones.filter((z) => { const w = Math.min(b.x + b.w, z.x + z.w) - Math.max(b.x, z.x), h = Math.min(b.y + b.h, z.y + z.h) - Math.max(b.y, z.y); return w > 0 && h > 0 && w * h >= 0.08 * Math.max(1, b.w * b.h); }).map((z) => z.name);
}
const shape = (s) => J({ f: s.format, w: s.width, h: s.height, l: s.layers.map((l) => [l.id, l.name, l.transform, l.props, l.style]) });

(async () => {
  const tpl = await getJ('/api/scenes/templates');
  const ZONES = tpl.safe_zones.phone;
  const made = [];

  // ---- every template, and its version for the other format, as the output draws it
  const shot = async (sid, label) => {
    const s = await getJ(`/api/scenes/${sid}`);
    const page = await open(`${RIG}/scene.html?id=${sid}`);
    await page.send('Emulation.setDeviceMetricsOverride', { width: s.width, height: s.height, deviceScaleFactor: 0.5, mobile: false });
    const ok = await waitFor(page, `window.SceneDebug && SceneDebug.scene() && SceneDebug.layers().length === ${s.layers.length}`, 10000);
    await sleep(1800);
    const r = await page.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(outdir, `p10_${label}.png`);
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    const errs = page.errors.filter((e) => !/camera|NotReadable|NotAllowed/.test(e));
    await page.close();
    return { s, ok, file, errs };
  };
  for (const t of tpl.templates) {
    const r = await post('/api/scenes', { template: t.id, name: `P10 ${t.name}` });
    made.push(r.body.scene.id);
    const a = await shot(r.body.scene.id, t.id);
    check(`template ${t.id}: ${t.format}, every layer drawn and inside`, a.ok && a.s.format === t.format && !outside(a.s).length && !a.errs.length,
      `${a.s.width}x${a.s.height}, ${a.s.layers.length} layers, outside: ${outside(a.s).join(',') || 'none'}  (${a.file})`);
    const other = t.format === 'phone' ? 'horizontal' : 'phone';
    const c = await post(`/api/scenes/${r.body.scene.id}/convert`, { format: other });
    made.push(c.body.scene.id);
    const b = await shot(c.body.scene.id, `${t.id}_as_${other}`);
    const under = b.s.layers.filter((l) => zoneHits(b.s, l, ZONES).length).map((l) => l.name);
    check(`...laid out for ${other}: every layer inside${other === 'phone' ? ', none under TikTok' : ''}`,
      b.ok && c.status === 200 && b.s.format === other && !outside(b.s).length && (other !== 'phone' || !under.length) && b.s.layers.length === a.s.layers.length && !b.errs.length,
      `"${b.s.name}", outside: ${outside(b.s).join(',') || 'none'}, under TikTok: ${under.join(',') || 'none'}  (${b.file})`);
  }

  // ---- the editor
  const base = made[0];                    // Just chatting, horizontal
  const ed = await open(`${RIG}/canvas.html?scene=${base}`);
  await ed.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitFor(ed, `location.origin === ${J(RIG)} && document.readyState === 'complete'`, 10000);
  await ed.ev(`localStorage.removeItem('cb-view')`);
  await ed.send('Page.reload', { ignoreCache: true });
  check('the editor loads', await waitFor(ed, `window.Editor && Editor.scene() && Editor.scene().id === ${J(base)}`, 10000));
  await sleep(1500);
  const S = async () => JSON.parse(await ed.ev('JSON.stringify(Editor.scene())'));

  // The New scene gallery, from the scene menu.
  await ed.ev(`(() => { const s = document.getElementById('scenePick'); s.value = '__new'; s.dispatchEvent(new Event('change')); })()`);
  await waitFor(ed, `!document.getElementById('newDialog').hidden && document.querySelectorAll('#newGrid .nd-card').length > 0`, 5000);
  await sleep(300);
  const g = await ed.ev(`(() => ({ cards: [...document.querySelectorAll('#newGrid .nd-card')].map((c) => c.dataset.t),
    thumbs: document.querySelectorAll('#newGrid .nd-card svg.nd-thumb').length, focus: document.activeElement.dataset.t,
    kept: document.getElementById('scenePick').value }))()`);
  check('the New scene gallery: two blanks and every template, each with its thumbnail', g.cards.length === 2 + tpl.templates.length && g.thumbs === g.cards.length
    && tpl.templates.every((t) => g.cards.includes(t.id)), `${g.cards.length} cards, ${g.thumbs} thumbnails`);
  check('...the blank in the scene\'s own format is chosen and has the focus; the scene menu stays put', g.focus === 'blank:horizontal' && g.kept === base, `${g.focus}, menu ${g.kept}`);
  const dialogShot = path.join(outdir, 'p10_gallery.png');
  fs.writeFileSync(dialogShot, Buffer.from((await ed.send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
  await ed.key('ArrowRight', 'ArrowRight');
  const moved = await ed.ev(`document.activeElement.dataset.t`);
  await ed.key('Escape', 'Escape');
  const closed = await ed.ev(`document.getElementById('newDialog').hidden`);
  check('...arrow keys move the choice, Esc closes it', moved === g.cards[1] && closed, `${moved}  (${dialogShot})`);
  await ed.ev(`Editor.newDialog()`);
  await waitFor(ed, `!document.getElementById('newDialog').hidden`, 3000);
  await ed.ev(`(() => { document.querySelector('#newGrid .nd-card[data-t="music_phone"]').click(); const n = document.getElementById('newName'); n.value = 'My phone music'; })()`);
  await ed.ev(`document.getElementById('newCreate').click()`);
  const fromTpl = await waitFor(ed, `Editor.scene().name === 'My phone music'`, 6000);
  const ns = await S();
  made.push(ns.id);
  check('...a template makes a new scene, named, in its format, and the editor opens it', fromTpl && ns.format === 'phone' && ns.layers.length === tpl.templates.find((t) => t.id === 'music_phone').layers.length,
    `${ns.name}, ${ns.format}, ${ns.layers.length} layers`);

  // The format switch lays the scene out again - one undo step.
  await ed.ev(`Editor.load(${J(base)})`);
  await waitFor(ed, `Editor.scene().id === ${J(base)}`, 5000);
  await sleep(500);
  const before = await S();
  const h0 = (await ed.ev('Editor.history()')).undo;
  await ed.ev(`document.querySelector('#formatSeg [data-f="phone"]').click()`);
  await waitFor(ed, `Editor.scene().format === 'phone'`, 5000);
  await sleep(200);
  const sw = await S();
  const h1 = await ed.ev('Editor.history()');
  const swUnder = sw.layers.filter((l) => zoneHits(sw, l, ZONES).length).map((l) => l.name);
  check('the Phone switch lays this scene out again: every layer inside, none under TikTok, one step',
    sw.width === 1080 && sw.height === 1920 && !outside(sw).length && !swUnder.length && h1.undo === h0 + 1 && h1.labels[h1.labels.length - 1] === 'switch to phone',
    `outside ${outside(sw).join(',') || 'none'}, under ${swUnder.join(',') || 'none'}, ${h1.undo - h0} step "${h1.labels[h1.labels.length - 1]}"`);
  await ed.ev('Editor.undo()');
  const back = await S();
  check('...and undo puts it back exactly', shape(back) === shape(before));

  // "Make a phone version" from the scene's inspector.
  await ed.ev('Editor.flush()');
  await ed.ev(`Editor.select([])`);
  await sleep(200);
  await ed.ev(`document.querySelector('#inspector [data-make-version="phone"]').click()`);
  const mv = await waitFor(ed, `Editor.scene().id !== ${J(base)} && Editor.scene().format === 'phone'`, 6000);
  const pv = await S();
  made.push(pv.id);
  const orig = await getJ(`/api/scenes/${base}`);
  check('"Make a phone version" makes a new phone scene, opens it, and leaves the original as it was',
    mv && /\(phone\)$/.test(pv.name) && !outside(pv).length && orig.format === 'horizontal' && shape(orig) === shape(before), `"${pv.name}"`);

  // Warnings: a layer moved under TikTok's comments.
  const text = pv.layers.find((l) => l.type === 'text');
  await ed.ev(`Editor.setField(${J(text.id)}, 'transform.y', 1420)`);
  await sleep(250);
  const u = await ed.ev('Editor.underUI()');
  const ui = await ed.ev(`(() => ({ row: !!document.querySelector('#layerTree .row[data-id="${text.id}"] .row-warn'),
    badges: document.querySelectorAll('#hud .zone-badge').length, count: (document.querySelector('#inspector [data-under-count]') || {}).textContent || '' }))()`);
  await ed.ev(`Editor.select([${J(text.id)}])`);
  await sleep(200);
  const note = await ed.ev(`(() => { const n = document.querySelector('#inspector [data-zone-note]'); return n && !n.hidden ? n.textContent : ''; })()`);
  const warnShot = path.join(outdir, 'p10_warnings.png');
  fs.writeFileSync(warnShot, Buffer.from((await ed.send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
  check('a layer under TikTok\'s comments is marked on the canvas, in the list, in the inspector and in the scene\'s count',
    J(u[text.id]) === J(['Comments']) && ui.row && ui.badges >= 1 && /Comments/.test(note) && /1 layer sits under/.test(ui.count),
    `${J(u)}; row ${ui.row}, badges ${ui.badges}; "${note}"; "${ui.count}"  (${warnShot})`);

  // The safe zones: the toggle hides them; the warnings stay (TikTok's controls are there anyway).
  await ed.ev(`document.getElementById('safeBtn').click()`);
  await sleep(150);
  const off = await ed.ev(`({ zones: !document.getElementById('safeLayer').hidden, badges: document.querySelectorAll('#hud .zone-badge').length })`);
  await ed.ev(`document.getElementById('safeBtn').click()`);
  await sleep(150);
  const on = await ed.ev(`!document.getElementById('safeLayer').hidden && document.querySelectorAll('#safeLayer .safe-zone').length === 4`);
  check('the safe zones toggle off and on; the warnings stay either way', !off.zones && off.badges >= 1 && on, J(off));

  // Snapping to a zone's edge: the text dragged to just above the comments -
  // with the rest hidden for it, so the press lands on the text and nothing
  // else is in snapping reach.
  const othersIds = (await S()).layers.filter((l) => l.id !== text.id).map((l) => l.id);
  await ed.ev(`Editor.setVisible(${J(othersIds)}, false)`);
  await ed.ev(`Editor.setField(${J(text.id)}, 'transform.y', 1000)`);
  await sleep(200);
  const t0 = (await S()).layers.find((l) => l.id === text.id).transform;
  const z = (await ed.ev('Editor.view()')).z;
  const from = await ed.ev(`Editor.toClient(${t0.x + t0.w / 2}, ${t0.y + t0.h / 2})`);
  const dy = Math.round((1330 - 5 - (t0.y + t0.h)) * z);
  const fx = Math.round(from.x), fy = Math.round(from.y);
  await ed.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fx, y: fy });
  await ed.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fx, y: fy, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 10; i++) { await ed.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fx, y: fy + Math.round((dy * i) / 10), button: 'left', buttons: 1 }); await sleep(16); }
  await sleep(60);
  await ed.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: fx, y: fy + dy, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(150);
  const t1 = (await S()).layers.find((l) => l.id === text.id).transform;
  check('a layer dragged near the comments snaps to their edge', t1.y + t1.h === 1330, `bottom ${t1.y + t1.h}`);
  for (let i = 0; i < 3; i++) await ed.ev('Editor.undo()');                 // the drag, the move, the hiding

  await sleep(300);
  check('no console errors in the editor', ed.errors.length === 0, ed.errors.slice(0, 5).join(' || '));
  await ed.close();
  for (const sid of made) await post(`/api/scenes/${sid}/delete`, {});
  const failed = results.filter(([, ok]) => !ok).map(([n]) => n);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed` + (failed.length ? '; FAILED: ' + failed.join('; ') : ''));
  process.exit(0);
})().catch((e) => { console.log('ERROR ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 3).join('\n')); process.exit(1); });
