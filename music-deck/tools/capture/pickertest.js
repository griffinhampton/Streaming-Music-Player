// The window and screen picker, driven the way a person would drive it:
//   node pickertest.js <devtools port> [rig port]
// Makes a scene, opens the Canvas Builder on it, presses "Choose a window or
// screen...", checks the gallery really has pictures in it (a thumbnail that
// failed to load is an <img> too, so naturalWidth is what counts), clicks a
// window, and then checks the three things that were wrong before: the layer
// arrives at the shape the window really is, the editor shows the window
// rather than a black rectangle, and nothing is thrown along the way.
const [port, rigPort = '8799'] = process.argv.slice(2);
const RIG = `http://127.0.0.1:${rigPort}`;
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 180000).unref();

const results = [];
const check = (name, ok, detail = '') => { results.push([name, !!ok]); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? `  (${detail})` : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(url) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURI(url)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const page = { ws, id: 0, pending: new Map(), errors: [] };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && page.pending.has(m.id)) { page.pending.get(m.id)(m); page.pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') page.errors.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n')[0]);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') page.errors.push('console.error: ' + m.params.args.map((a) => a.value || a.description).join(' ').slice(0, 160));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon/.test((m.params.entry.url || '') + m.params.entry.text)) page.errors.push('log: ' + m.params.entry.text.slice(0, 160));
  };
  page.send = (method, params = {}) => new Promise((r) => { const i = ++page.id; page.pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  page.ev = async (expression) => {
    const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '').split('\n')[0]);
    return r.result.result.value;
  };
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  return page;
}

async function waitFor(page, expr, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await page.ev(expr)) return true; } catch (_) { /* not yet */ }
    await sleep(120);
  }
  return false;
}

(async () => {
  const made = await (await fetch(`${RIG}/api/scenes`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ template: 'just_chatting', name: 'Picker check' }) })).json();
  const sid = made.scene.id;
  console.log('scene ' + sid);

  const page = await open(`${RIG}/canvas.html?scene=${sid}`);
  check('the editor loads', await waitFor(page, "!!document.getElementById('pickSource')"));

  // Saving: something you can press and reach, not a grey word in a corner.
  // The tooltip has to be right from the first paint - setSaveState only runs
  // when the state changes, and an editor nobody has touched never changes.
  check('the save indicator can be pressed and has words',
    await page.ev("(() => { const e = document.getElementById('saveState');" +
                  " return e.tagName === 'BUTTON' && (e.getAttribute('title') || '').length > 20; })()"));

  // The Sources tab, then the picker.
  await page.ev("document.getElementById('tabSources').click()");
  check('the pick button is there, with words on it',
    (await page.ev("(document.getElementById('pickSource')||{}).textContent")||'').includes('Choose a window'));

  await page.ev("document.getElementById('pickSource').click()");
  check('the picker opens', await waitFor(page, "!document.getElementById('srcDialog').hidden"));
  check('it lists what is open', await waitFor(page, "document.querySelectorAll('#srcGrid .sp-card').length > 0"));

  const cards = await page.ev("document.querySelectorAll('#srcGrid .sp-card').length");
  // A picture that failed to load is still an <img>: naturalWidth is the test.
  const withShots = await waitFor(page,
    "[...document.querySelectorAll('#srcGrid .sp-card img')].filter((i) => i.naturalWidth > 0).length >= 2", 20000);
  const shots = await page.ev("[...document.querySelectorAll('#srcGrid .sp-card img')].filter((i) => i.naturalWidth > 0).length");
  check('the cards actually show pictures', withShots, `${shots} of ${cards} loaded`);

  // Click the first card that is a window rather than a screen.
  const picked = await page.ev(`(() => {
    const c = [...document.querySelectorAll('#srcGrid .sp-card')].find((b) => !b.querySelector('b').textContent.startsWith('Screen '));
    if (!c) return null;
    const name = c.querySelector('b').textContent;
    c.click();
    return name;
  })()`);
  check('a window can be chosen', !!picked, picked || 'no window card');

  check('the picker closes itself', await waitFor(page, "document.getElementById('srcDialog').hidden"));
  check('it shows you the Layers list afterwards',
    await waitFor(page, "document.getElementById('tabLayers').getAttribute('aria-selected') === 'true'"));
  check('the layer is in the list', await waitFor(page, "document.querySelectorAll('#layerTree .row').length > 0"));

  // The shape it arrived at, against the shape the window really is.
  const src = await (await fetch(`${RIG}/api/capture/sources`)).json();
  const win = (src.windows || []).find((w) => w.title === picked);
  // Saving is a 60 ms debounce, so read the scene back only once it says Saved
  // - otherwise this races the editor and blames the app for its own hurry.
  check('the scene saves itself', await waitFor(page, "document.getElementById('saveState').dataset.state === 'saved'", 8000));
  const body = await (await fetch(`${RIG}/api/scenes/${sid}`)).json();
  const scene = body.layers ? body : (body.scene || {});
  const layers = scene.layers || [];
  const layer = layers.filter((l) => l.type === 'capture').pop();
  let ratioOk = false, detail;
  if (!layer) detail = `no capture layer saved; the scene holds [${layers.map((l) => l.type).join(', ')}]`;
  else if (!win) detail = `"${picked}" is not in the list any more; open now: ${(src.windows || []).map((w) => w.title).slice(0, 6).join(' | ')}`;
  else {
    const want = win.w / win.h, got = layer.transform.w / layer.transform.h;
    ratioOk = Math.abs(want - got) / want < 0.02;
    detail = `window ${win.w}x${win.h} (${want.toFixed(2)}), layer ${layer.transform.w}x${layer.transform.h} (${got.toFixed(2)})`;
  }
  check('it arrives at the shape the window really is', ratioOk, detail);

  // The point of the whole exercise: not a black rectangle.
  const showing = await waitFor(page,
    "!!document.getElementById('sceneFrame').contentDocument.querySelector('.hole-shot.on')", 20000);
  check('the editor shows the window, not a black box', showing);
  if (showing) {
    const size = await page.ev("(() => { const i = document.getElementById('sceneFrame').contentDocument.querySelector('.hole-shot.on'); return i.naturalWidth + 'x' + i.naturalHeight; })()");
    console.log('     the picture in the box: ' + size);
  }

  await sleep(2500);   // let one refresh come round
  const still = await page.ev("(() => { const i = document.getElementById('sceneFrame').contentDocument.querySelector('.hole-shot'); return !!i && i.classList.contains('on'); })()");
  check('it keeps showing it after a refresh', still);

  // The layer list: drawn glyphs, not a dotted circle and two padlock emoji.
  // "No text in the button" catches the old characters and the emoji alike,
  // without a unicode range surviving two layers of quoting.
  const rowIcons = await page.ev(`(() => {
    const r = document.querySelector('#layerTree .row');
    if (!r) return null;
    const btns = [...r.querySelectorAll('.row-btn')];
    return { n: btns.length,
             drawn: btns.filter((b) => b.querySelector('svg.glyph')).length,
             lettered: btns.filter((b) => b.textContent.trim().length > 0).length,
             titled: btns.filter((b) => (b.getAttribute('title') || '').length > 0).length };
  })()`);
  check('the eye and the lock are drawn, not typed',
    !!rowIcons && rowIcons.n > 0 && rowIcons.drawn === rowIcons.n && rowIcons.lettered === 0 && rowIcons.titled === rowIcons.n,
    rowIcons ? `${rowIcons.n} buttons, ${rowIcons.drawn} drawn, ${rowIcons.lettered} still characters, ${rowIcons.titled} with a tooltip` : 'no row');

  await page.ev("document.getElementById('saveState').click()");
  check('pressing Saved says so out loud',
    await waitFor(page, "!document.getElementById('toast').hidden && /saved/i.test(document.getElementById('toast').textContent)", 6000));

  // The keys that change a drag, named while you drag. P8 proves dragging
  // still works with the bigger handles, but nothing there checks that this
  // appears or says the right thing - and "it did not throw" is not "it works".
  const mouse = (type, at, mods = 0, buttons = 0) => page.send('Input.dispatchMouseEvent',
    { type, x: Math.round(at.x), y: Math.round(at.y), button: 'left', buttons, modifiers: mods, clickCount: 1 });
  const SHIFT = 8;
  const h = await page.ev("(() => { const p = Editor.handle('se'); return p && { x: p.x, y: p.y }; })()");
  let hint = null;
  if (h) {
    await mouse('mouseMoved', h);
    await mouse('mousePressed', h, SHIFT, 1);
    await mouse('mouseMoved', { x: h.x + 40, y: h.y + 30 }, SHIFT, 1);
    await sleep(150);
    hint = await page.ev(`(() => { const el = document.querySelector('.hud-hint'); if (!el) return null;
      return { text: el.textContent.replace(/\\s+/g, ' ').trim(), lit: [...el.querySelectorAll('b.on')].map((b) => b.textContent).join(',') }; })()`);
    await mouse('mouseReleased', { x: h.x + 40, y: h.y + 30 }, SHIFT, 0);
    await sleep(150);
    await page.ev('Editor.undo()');
  }
  check('the drag keys are named while you drag, and the one held lights up',
    !!hint && /keep the shape/i.test(hint.text) && hint.lit === 'Shift',
    hint ? `"${hint.text}" lit: ${hint.lit || 'none'}` : 'no handle, or no hint drawn');
  check('the hint goes when the drag ends', await waitFor(page, "!document.querySelector('.hud-hint')", 3000));

  check('nothing was thrown', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));

  try { await fetch(`${RIG}/api/scenes/${sid}/delete`, { method: 'POST' }); } catch (_) { /* the rig can keep it */ }
  const bad = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - bad} of ${results.length} passed`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('THREW ' + e.message); process.exit(2); });
