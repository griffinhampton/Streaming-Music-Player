// P12 release QA on the rig, in headless Chrome:
//   node p12test.js <devtools port> <scene id> <outdir> <python> [rig port] [corrupt id] [damaged id]
// - a scene exported from its inspector (Share) and imported from New scene:
//   the same scene back, its pictures and font inside; a tampered .zip and a
//   file that is no .zip imported too - what is left out is said, a missing
//   picture is outlined in the editor
// - a picture a scene uses, deleted from the deck: it says where it is used
//   and deletes only on "anyway"; the scene's output then shows nothing there
// - a font that is not on this PC: its menu says so
// - scene files that could not be read at start (the runner damaged two): one
//   back from its backup, one set aside and said once in the editor
// - every inspector field of every layer type and the scene's: it changes
//   the scene, as one undo step; undo puts it back exactly, redo again
// - keyboard only: the layers list, nudging on the canvas, duplicate, delete,
//   undo and redo, a number field with math, the shortcuts sheet
// - the editor at 150% and 100%, the deck at narrow widths: nothing scrolls
//   sideways (screenshots of each)
// - no console errors
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const [port, SID, outdir, PY, rigPort = '8799', CORRUPT = '', DAMAGED = ''] = process.argv.slice(2);
const RIG = `http://127.0.0.1:${rigPort}`;
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 900000).unref();
const results = [];
const check = (name, ok, detail = '') => { results.push([name, !!ok]); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? `  (${detail})` : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const VK = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, ArrowRight: 39, ArrowLeft: 37, Delete: 46, KeyD: 68, KeyZ: 90, KeyA: 65, Slash: 191 };

// Expected in the logs: a picture deleted on purpose (404), a refused import (400).
const EXPECTED_LOG = (url, text) => /favicon|status of 409/.test(url + text)
  || (/\/asset\//.test(url) && /404/.test(text)) || (/\/api\/scenes\/import/.test(url) && /400/.test(text));

async function open(url) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURI(url)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const page = { ws, id: 0, pending: new Map(), errors: [], dialogs: [], accept: false, chooser: null, targetId: t.id };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && page.pending.has(m.id)) { page.pending.get(m.id)(m); page.pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') page.errors.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n')[0]);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') page.errors.push('console.error: ' + m.params.args.map((a) => a.value || a.description).join(' ').slice(0, 200));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !EXPECTED_LOG(m.params.entry.url || '', m.params.entry.text)) page.errors.push('log: ' + m.params.entry.text.slice(0, 200) + ' ' + (m.params.entry.url || ''));
    if (m.method === 'Page.javascriptDialogOpening') { page.dialogs.push(m.params.message); page.send('Page.handleJavaScriptDialog', { accept: page.accept }); }
    if (m.method === 'Page.fileChooserOpened') page.chooser = m.params;
  };
  page.send = (method, params = {}) => new Promise((r) => { const i = ++page.id; page.pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  page.ev = async (expression, userGesture = false) => {
    const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '').split('\n')[0]);
    return r.result.result.value;
  };
  page.key = async (key, code, mods = 0, text, commands) => {
    await page.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, modifiers: mods, text, windowsVirtualKeyCode: VK[code], commands });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers: mods, windowsVirtualKeyCode: VK[code] });
  };
  page.shot = async (file) => fs.writeFileSync(path.join(outdir, file), Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Page.enable');
  await page.send('Page.setInterceptFileChooserDialog', { enabled: true });
  return page;
}
async function waitFor(page, expr, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await page.ev(expr)) return true; } catch (_) { /* not yet */ }
    await sleep(80);
  }
  return false;
}
const post = (p, body) => fetch(RIG + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: J(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const getJ = async (p) => (await fetch(RIG + p, { cache: 'no-store' })).json();
const py = (code, ...args) => {
  const r = spawnSync(PY, ['-c', code, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('python: ' + (r.stderr || '').slice(-300));
  return r.stdout.trim();
};
const zipNames = (file) => JSON.parse(py('import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))', file));
const toast = (page) => page.ev(`(() => { const t = document.getElementById('toast'); return t && !t.hidden ? t.textContent : ''; })()`);
async function waitToast(page, re, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const t = await toast(page); if (re.test(t)) return t; await sleep(80); }
  return await toast(page);
}
/* Pick a file for an <input type=file> that a button opens, as a person would. */
async function chooseFile(page, buttonExpr, file) {
  page.chooser = null;
  await page.ev(`${buttonExpr}.click()`, true);
  const t0 = Date.now();
  while (!page.chooser && Date.now() - t0 < 5000) await sleep(50);
  if (!page.chooser) return false;
  await page.send('DOM.setFileInputFiles', { files: [file], backendNodeId: page.chooser.backendNodeId });
  return true;
}
/* The scene as the editor holds it, without what every save changes. */
const shapeOf = (s) => J({ n: s.name, f: s.format, b: s.background, t: s.transparency, k: s.key_color, g: s.groups || {},
  l: s.layers.map((l) => [l.id, l.name, l.type, l.visible, l.locked, l.group, l.transform, l.style, l.props, l.triggers]) });
const noIds = (s) => J(s.layers.map((l) => [l.name, l.type, l.transform, l.style, l.props]));

(async () => {
  fs.mkdirSync(outdir, { recursive: true });
  const exportDir = path.join(outdir, 'exports');

  // ---- what the scene is made of: two pictures and a font of our own
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const up = async (name, raw) => (await post('/api/assets/upload', { name, data: 'data:image/png;base64,' + raw.toString('base64') })).body;
  const A1 = (await up('p12 one.png', PNG)).id;
  const A2 = (await up('p12 two.png', Buffer.concat([PNG, Buffer.from('p12')]))).id;
  const fontFile = ['Gabriola.ttf', 'georgia.ttf', 'comic.ttf'].map((f) => path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', f)).find((f) => fs.existsSync(f));
  const fontRes = (await post('/api/fonts/upload', { name: path.basename(fontFile), data: 'data:font/ttf;base64,' + fs.readFileSync(fontFile).toString('base64') })).body;
  const FAMILY = fontRes.family;
  const L = (id, name, type, x, y, w, h, props) => ({ id, type, name, visible: true, locked: false, group: '',
    transform: { x, y, w, h, rotation: 0, anchor: 'tl' }, style: { opacity: 1, blend: 'normal', radius: 0 }, props, triggers: [] });
  const base = await getJ(`/api/scenes/${SID}`);
  Object.assign(base, { name: 'P12 QA scene', background: { mode: 'solid', color: '#1d2440' }, layers: [
    L('p1200001', 'Picture', 'image', 100, 100, 400, 300, { src: A1, fit: 'cover' }),
    L('p1200002', 'Face', 'reactive', 560, 100, 300, 300, { idle: A1, talking: A2 }),
    L('p1200003', 'To delete', 'image', 920, 100, 400, 300, { src: A2, fit: 'cover' }),
    L('p1200004', 'Styled', 'text', 100, 500, 900, 140, { text: 'Hello from P12', size: 72, font: FAMILY, color: '#ffffff' }),
    L('p1200005', 'Missing font', 'text', 100, 700, 900, 140, { text: 'No such font here', size: 60, font: 'Nope Sans', color: '#ffffff' }),
  ] });
  const setup = await post(`/api/scenes/${SID}`, { scene: base, expect_rev: base.rev });
  if (setup.status !== 200) throw new Error('setup ' + setup.status);
  const original = setup.body.scene;
  const made = [];

  const ed = await open(`${RIG}/canvas.html?scene=${SID}`);
  await ed.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await ed.send('Page.bringToFront');
  check('the editor loads the QA scene', await waitFor(ed, `window.Editor && Editor.scene() && Editor.scene().id === ${J(SID)}`, 12000));

  // ---- scene files that could not be read at start
  if (CORRUPT) {
    const list = await getJ('/api/scenes');
    const bad = (list.unreadable || []).find((u) => u.id === CORRUPT);
    const back = list.scenes.find((s) => s.id === DAMAGED);
    const said = await waitToast(ed, /could not be read/, 6000);
    check('a scene file with no good copy is set aside, and the editor says so once', bad && bad.kept_as === `${CORRUPT}.json.corrupt` && /could not be read/.test(said) && said.includes(bad.kept_as),
      `${J(bad)}; "${said}"`);
    check('a damaged scene file comes back from its backup', back && back.name === 'P12 restored', J(back));
  }

  // ---- a font that is not on this PC
  await ed.ev(`Editor.select(['p1200005'])`);
  await waitFor(ed, `document.querySelector('#inspector select.font-select')`, 4000);
  const fsel = await ed.ev(`(() => { const s = document.querySelector('#inspector select.font-select'); return { v: s.value, t: s.selectedOptions[0] && s.selectedOptions[0].textContent }; })()`);
  check('a font that is not on this PC: its menu says so, and keeps it', fsel.v === 'Nope Sans' && /not available/.test(fsel.t), J(fsel));

  // ---- export, from the scene's own inspector
  await ed.ev(`Editor.select([])`);
  await waitFor(ed, `document.querySelector('#inspector [data-export-scene]')`, 4000);
  await ed.ev(`(() => { const b = document.querySelector('#inspector [data-export-scene]'); const d = b.closest('details'); if (d) d.open = true; b.click(); })()`);
  const saidEx = await waitToast(ed, /^Saved .+\.zip in /);
  const file = fs.existsSync(exportDir) ? fs.readdirSync(exportDir).filter((f) => f.endsWith('.zip')).map((f) => path.join(exportDir, f))[0] : null;
  const names = file ? zipNames(file) : [];
  const fid = (fontRes.fonts || []).find((f) => f.family === FAMILY && f.name === path.basename(fontFile))?.id || fontRes.id;
  check('Export saves the scene as one .zip, its pictures and font inside', file && ['scene.json', 'manifest.json', 'assets/' + A1, 'assets/' + A2, 'fonts/' + fid].every((n) => names.includes(n)),
    `"${saidEx}"; ${J(names)}`);
  const note = await ed.ev(`document.querySelector('#inspector [data-export-note]').textContent`);
  check('...and the Share section says where it went', /2 pictures, 1 font/.test(note) && note.includes('exports'), note);

  // ---- import, from New scene
  const fromDialog = async (zip) => {
    await ed.ev(`Editor.newDialog()`);
    await waitFor(ed, `!document.getElementById('newDialog').hidden`, 4000);
    return chooseFile(ed, `document.getElementById('newImport')`, zip);
  };
  const before = await ed.ev(`Editor.scene().id`);
  const picked = await fromDialog(file);
  const imported = await waitFor(ed, `Editor.scene().id !== ${J(before)} && Editor.scene().name === 'P12 QA scene'`, 10000);
  const got = await ed.ev(`Editor.scene()`);
  made.push(got.id);
  const saidIm = await waitToast(ed, /^Imported /);
  check('Import in New scene brings the same scene back as a new one', picked && imported && got.id !== SID && noIds(got) === noIds(original) && got.background.color === '#1d2440',
    `"${saidIm}"`);
  check('...and says what came with it', /with 2 pictures and 1 font/.test(saidIm), saidIm);

  // A tampered .zip: a "picture" that is not one, a name that climbs out of
  // the folder, a picture the scene names that is not in it.
  const tampered = path.join(outdir, 'tampered.zip');
  py(`import json,sys,zipfile
src, dst, a1 = sys.argv[1:4]
z = zipfile.ZipFile(src); s = json.loads(z.read('scene.json'))
s['name'] = 'P12 tampered'
for l in s['layers']:
    if l['id'] == 'p1200003': l['props']['src'] = 'ffffffffffffffff.png'
with zipfile.ZipFile(dst, 'w') as o:
    o.writestr('scene.json', json.dumps(s)); o.writestr('manifest.json', z.read('manifest.json'))
    o.writestr('assets/' + a1, b'notapng' * 20); o.writestr('../evil.png', b'x')`, file, tampered, A1);
  await fromDialog(tampered);
  const inT = await waitFor(ed, `Editor.scene().name === 'P12 tampered'`, 10000);
  made.push(await ed.ev(`Editor.scene().id`));
  const saidT = await waitToast(ed, /^Imported P12 tampered/);
  check('a tampered .zip: imported, and what was left out is said', inT && /1 picture was not in the file/.test(saidT) && /Left out 2 files/.test(saidT), saidT);
  const outlined = await waitFor(ed, `(() => { const d = document.getElementById('sceneFrame').contentDocument; const l = d && d.querySelector('.layer[data-id="p1200003"]'); return l && l.classList.contains('missing-media') && getComputedStyle(l.querySelector('.media')).visibility === 'hidden'; })()`, 6000);
  check('...the missing picture is outlined in the editor, not a broken icon', outlined);
  const notZip = path.join(outdir, 'not-a-scene.zip');
  fs.writeFileSync(notZip, 'hello, I am not a zip');
  const sceneNow = await ed.ev(`Editor.scene().id`);
  await fromDialog(notZip);
  const saidN = await waitToast(ed, /not a \.zip/);
  check('a file that is no .zip: refused, in words, and nothing changes', /That is not a \.zip file/.test(saidN) && (await ed.ev(`Editor.scene().id`)) === sceneNow, saidN);

  // ---- a picture a scene uses, deleted from the deck
  const deck = await open(`${RIG}/deck.html`);
  await deck.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await deck.send('Page.bringToFront');
  await waitFor(deck, `document.querySelector('.del[data-del="${A2}"]')`, 12000);
  deck.accept = false;
  await deck.ev(`document.querySelector('.del[data-del="${A2}"]').click()`);
  await waitFor(deck, 'true', 100);
  const t0 = Date.now();
  while (!deck.dialogs.length && Date.now() - t0 < 5000) await sleep(50);
  await sleep(300);
  const kept = (await getJ('/api/assets')).assets.some((a) => a.id === A2);
  // The scenes are listed newest first, so the QA scene can be anywhere in the list.
  check('deleting a picture a scene uses says where it is used, and No keeps it', /still used by .*\bscene: P12 QA scene\b/.test(deck.dialogs[0] || '') && kept, (deck.dialogs[0] || 'no question').replace(/\n+/g, ' '));
  deck.accept = true;
  await waitFor(deck, `document.querySelector('.del[data-del="${A2}"]')`, 3000);
  await deck.ev(`document.querySelector('.del[data-del="${A2}"]').click()`);
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) { await sleep(100); gone = !(await getJ('/api/assets')).assets.some((a) => a.id === A2); }
  check('...and "anyway" deletes it', gone && deck.dialogs.length === 2);
  const out = await open(`${RIG}/scene.html?id=${SID}`);
  await out.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 540, deviceScaleFactor: 1, mobile: false });
  await out.send('Page.bringToFront');
  const blank = await waitFor(out, `(() => { const m = document.querySelector('.layer[data-id="p1200003"] .media'), ok = document.querySelector('.layer[data-id="p1200001"] .media');
    return m && m.classList.contains('missing') && getComputedStyle(m).visibility === 'hidden' && ok && !ok.classList.contains('missing') && !document.querySelector('.missing-media'); })()`, 8000);
  check('...the scene on stream then shows nothing there - no broken-image icon, no outline', blank);
  await out.send('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync(path.join(outdir, 'p12_output_missing.png'), Buffer.from(r.result.data, 'base64')));

  // ---- every inspector field: one undo step, undo exact, redo exact
  await ed.send('Page.bringToFront');
  const sweep = (await post('/api/scenes', { name: 'P12 sweep', format: 'horizontal' })).body.scene.id;
  made.push(sweep);
  await ed.ev(`Editor.load(${J(sweep)})`);
  await waitFor(ed, `Editor.scene().id === ${J(sweep)}`, 6000);
  const POKE = `function poke(n) {
    const fire = (t) => { t.dispatchEvent(new Event('input', { bubbles: true })); t.dispatchEvent(new Event('change', { bubbles: true })); };
    if (n.tagName === 'SELECT') {
      const next = [...n.options].find((o) => !o.disabled && o.value !== n.value);
      if (!next) return '';
      n.value = next.value; n.dispatchEvent(new Event('change', { bubbles: true })); return 'menu';
    }
    if (n.tagName === 'TEXTAREA') { n.value += ' x'; fire(n); return 'text'; }
    if (n.tagName === 'INPUT') {
      if (n.type === 'checkbox') { n.click(); return 'switch'; }
      if (n.type === 'range') { const lo = +n.min || 0, hi = n.max === '' ? 100 : +n.max, cur = +n.value;
        n.value = String(cur >= hi - (hi - lo) / 8 ? lo : Math.min(hi, cur + (hi - lo) / 4)); fire(n); return 'slider'; }
      if (n.type === 'color') { n.value = n.value.toLowerCase() === '#123456' ? '#654321' : '#123456'; fire(n); return 'color'; }
      if (n.dataset.kind === 'num') { const cur = parseFloat(n.value) || 0, hi = n.dataset.max === undefined ? Infinity : +n.dataset.max;
        n.focus(); n.value = String(cur + 7 > hi ? cur - 7 : cur + 7); fire(n); n.blur(); return 'number'; }
      n.value = (n.value || '') + ' x'; fire(n); return 'text';
    }
    const b = [...n.querySelectorAll('button')].find((x) => x.getAttribute('aria-checked') !== 'true' && x.getAttribute('aria-pressed') !== 'true' && !x.classList.contains('on'));
    if (b) { b.click(); return 'choice'; }
    const c = n.querySelector('input[type=color]');
    if (c) { c.value = c.value.toLowerCase() === '#123456' ? '#654321' : '#123456'; fire(c); return 'color'; }
    const inner = n.querySelector('input, select, textarea');
    return inner ? poke(inner) : '';
  }`;
  const KEYS = `[...document.querySelectorAll('#inspector [data-field], #inspector [data-lx]')]
    .filter((n) => n.offsetParent !== null && !n.disabled && !n.closest('[data-deck-design]') && !n.matches('[data-threshold], [type=file]'))
    .map((n) => n.hasAttribute('data-lx') ? '[data-lx="' + n.dataset.lx + '"]' : '[data-field="' + n.dataset.field + '"]')`;
  const fails = [];
  let tested = 0;
  const kinds = {};
  async function sweepInspector(label) {
    await ed.ev(`document.querySelectorAll('#inspector details').forEach((d) => { d.open = true; })`);
    await sleep(250);
    const keys = [...new Set(await ed.ev(KEYS))];
    for (const key of keys) {
      const b = await ed.ev('Editor.scene()'), h0 = (await ed.ev('Editor.history()')).undo;
      const how = await ed.ev(`(() => { ${POKE}; document.querySelectorAll('#inspector details').forEach((d) => { d.open = true; });
        const n = document.querySelector('#inspector ${key.replace(/'/g, "\\'")}'); return n && n.offsetParent !== null && !n.disabled ? poke(n) : ''; })()`);
      if (!how) continue;
      await sleep(150);
      const a = await ed.ev('Editor.scene()'), h1 = (await ed.ev('Editor.history()')).undo;
      await ed.ev('Editor.undo()');
      const u = await ed.ev('Editor.scene()');
      await ed.ev('Editor.redo()');
      const r = await ed.ev('Editor.scene()');
      tested++;
      kinds[how] = (kinds[how] || 0) + 1;
      const why = shapeOf(a) === shapeOf(b) ? 'no change' : h1 - h0 !== 1 ? `${h1 - h0} undo steps` : shapeOf(u) !== shapeOf(b) ? 'undo not exact' : shapeOf(r) !== shapeOf(a) ? 'redo not exact' : '';
      if (why) fails.push(`${label} ${key} (${how}): ${why}`);
    }
  }
  // The editor keeps 200 steps of history: each layer type starts from a
  // fresh load (the scene as saved, history empty), so no step is pushed out.
  const fresh = async () => { await ed.ev('Editor.flush()'); await ed.ev(`Editor.load(${J(sweep)})`); await sleep(300); };
  for (const i of [0, 1, 2, 3, 4, 8, 9]) {
    await fresh();
    await ed.ev(`Editor.add(${i})`);
    await sleep(300);
    const t = await ed.ev(`(() => { const s = Editor.scene(), id = Editor.selection()[0]; const l = s.layers.find((x) => x.id === id); return l ? l.type + (l.props.component ? ':' + l.props.component : '') : '?'; })()`);
    await sweepInspector(t);
  }
  await fresh();
  await sweepInspector('scene');
  check('every inspector field changes the scene as one undo step; undo and redo are exact', tested > 60 && !fails.length,
    `${tested} fields (${Object.entries(kinds).map(([k, v]) => `${v} ${k}`).join(', ')})${fails.length ? '; ' + fails.slice(0, 12).join(' | ') : ''}`);

  // ---- keyboard only
  await ed.ev(`Editor.load(${J(SID)})`);
  await waitFor(ed, `Editor.scene().id === ${J(SID)}`, 6000);
  await ed.ev(`Editor.select([]); document.getElementById('viewport').focus()`);
  const tabTo = async (expr, max = 160) => { for (let i = 0; i < max; i++) { if (await ed.ev(expr)) return i; await ed.key('Tab', 'Tab'); } return -1; };
  const inTree = await tabTo(`!!(document.activeElement && document.activeElement.closest('#layerTree .row'))`);
  const sel0 = await ed.ev('Editor.selection()');
  await ed.key('ArrowDown', 'ArrowDown');
  const sel1 = await ed.ev('Editor.selection()');
  check('keyboard: Tab reaches the layers list, and the arrows pick a layer', inTree >= 0 && sel1.length === 1 && J(sel1) !== J(sel0), `${inTree} Tabs; ${J(sel0)} -> ${J(sel1)}`);
  const lid = sel1[0];
  const xy = async () => ed.ev(`(() => { const t = Editor.scene().layers.find((l) => l.id === ${J(lid)}).transform; return [t.x, t.y]; })()`);
  const p0 = await xy();
  const onCanvas = await tabTo(`document.activeElement === document.getElementById('viewport')`);
  for (let i = 0; i < 3; i++) await ed.key('ArrowRight', 'ArrowRight');
  await ed.key('ArrowDown', 'ArrowDown', 8);
  const p1 = await xy();
  check('keyboard: on the canvas, arrows move it by 1 and Shift+arrow by 10', onCanvas >= 0 && p1[0] === p0[0] + 3 && p1[1] === p0[1] + 10, `${J(p0)} -> ${J(p1)}`);
  const count = async () => ed.ev('Editor.scene().layers.length');
  const c0 = await count();
  await ed.key('d', 'KeyD', 2);
  const c1 = await count();
  await ed.key('Delete', 'Delete');
  const c2 = await count();
  await ed.key('z', 'KeyZ', 2);
  const c3 = await count();
  await ed.key('Z', 'KeyZ', 2 | 8);
  const c4 = await count();
  await ed.key('z', 'KeyZ', 2);
  await ed.key('z', 'KeyZ', 2);
  check('keyboard: Ctrl+D duplicates, Delete removes, Ctrl+Z and Ctrl+Shift+Z undo and redo', c1 === c0 + 1 && c2 === c0 && c3 === c0 + 1 && c4 === c0 && (await count()) === c0,
    [c0, c1, c2, c3, c4].join(' -> '));
  await ed.ev(`Editor.select([${J(lid)}]); document.getElementById('viewport').focus()`);
  const x0 = (await xy())[0];
  const inX = await tabTo(`!!(document.activeElement && document.activeElement.matches('#inspector input[data-field="transform.x"]'))`, 220);
  await ed.key('a', 'KeyA', 2, undefined, ['selectAll']);
  await ed.send('Input.insertText', { text: '+20' });
  await ed.key('Enter', 'Enter', 0, '\r');
  const x1 = (await xy())[0];
  check('keyboard: Tab reaches the inspector, and "+20" Enter in X moves it 20', inX >= 0 && x1 === x0 + 20, `${inX} Tabs; x ${x0} -> ${x1}`);
  await ed.ev(`document.getElementById('viewport').focus()`);
  await ed.key('?', 'Slash', 8, '?');
  const sheet = await waitFor(ed, `!document.getElementById('shortcuts').hidden && document.activeElement.id === 'shortcutsClose'`, 2000);
  await ed.key('Escape', 'Escape');
  const back = await waitFor(ed, `document.getElementById('shortcuts').hidden && document.activeElement.id === 'viewport'`, 2000);
  check('keyboard: ? opens the shortcuts, Esc closes them and the focus comes back', sheet && back);

  // ---- display scaling, and narrow windows
  await ed.ev(`Editor.select([])`);
  for (const [w, h, dsf, label] of [[1280, 720, 1.5, 'editor at 150% on a 1920 x 1080 screen'], [1707, 960, 1.5, 'editor at 150% on a 2560 x 1440 screen'], [1920, 1080, 1, 'editor at 100%']]) {
    await ed.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dsf, mobile: false });
    await sleep(700);
    const m = await ed.ev(`({ sx: document.documentElement.scrollWidth, iw: innerWidth, bar: Math.round(document.querySelector('.cb-top').getBoundingClientRect().height),
      canvas: Math.round(document.getElementById('viewport').getBoundingClientRect().width), insp: Math.round(document.getElementById('inspector').getBoundingClientRect().width) })`);
    await ed.shot(`p12_editor_${w}x${h}@${dsf}.png`);
    check(`${label}: nothing scrolls sideways, the canvas has room`, m.sx <= m.iw + 1 && m.canvas >= 480, `${J(m)}`);
  }
  await deck.send('Page.bringToFront');
  for (const [w, dsf] of [[1400, 1], [1280, 1.5], [1024, 1], [760, 1], [480, 1], [360, 1]]) {
    await deck.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: dsf, mobile: false });
    await sleep(700);
    const m = await deck.ev(`(() => { const wide = [...document.querySelectorAll('body *')].filter((n) => { const r = n.getBoundingClientRect(); return r.width && r.right > innerWidth + 1 && getComputedStyle(n).position !== 'fixed' && !n.closest('[hidden]'); });
      return { sx: document.documentElement.scrollWidth, iw: innerWidth, wide: wide.slice(0, 4).map((n) => (n.id || n.className || n.tagName).toString().slice(0, 40)) }; })()`);
    await deck.shot(`p12_deck_${w}@${dsf}.png`);
    check(`the deck ${w} px wide${dsf !== 1 ? ' at 150%' : ''}: nothing scrolls sideways`, m.sx <= m.iw + 1, J(m));
  }

  // ---- no console errors
  const errs = [...ed.errors, ...deck.errors, ...out.errors];
  check('no console errors in the editor, the deck or the output', errs.length === 0, errs.slice(0, 5).join(' | '));

  // ---- leave the rig as it was (the runner puts the scenes folder back)
  for (const id of made) await post(`/api/scenes/${id}/delete`, {});
  await post('/api/assets/delete', { id: A1, force: true });
  await post('/api/fonts/delete', { id: fontRes.id });
  for (const p of [ed, deck, out]) await fetch(`http://127.0.0.1:${port}/json/close/${p.targetId}`).catch(() => {});

  const failed = results.filter(([, ok]) => !ok).map(([n]) => n);
  console.log(`${results.length - failed.length} of ${results.length} checks passed` + (failed.length ? '; FAILED: ' + failed.join('; ') : ''));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.log('ERROR ' + (e.stack || e)); process.exit(2); });
