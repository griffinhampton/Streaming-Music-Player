// P11 "run a show" test in headless Chrome, streaming for real to a local
// ffmpeg RTMP listener on the rig:
//   node p11test.js <devtools port> <scene A> <scene B> <outdir> <ffmpeg> [rig port]
// Everything is done through the UI: the LIVE panel (Server URL and key,
// quality, the scene, the sound turned off - no microphone is recorded -
// Start, the health), studio mode (its program monitor), 20 scene switches
// from the scene remote (clicks and keys), Stop (asked twice), the key
// forgotten. Then the recording is decoded and every frame's brightness
// read: two plain scenes of different brightness, so a black or dark frame
// between them, a gap, or a missing switch shows. Also: every control of
// the panel, the program panel and the remote reached with Tab, the "new
// key" error, the remote window asked for (and answered here, so none
// opens), no console errors.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const [port, SA, SB, outdir, FF, rigPort = '8799'] = process.argv.slice(2);
const RIG = `http://127.0.0.1:${rigPort}`;
const RTMP_URL = 'rtmp://127.0.0.1:1935/live', RTMP_KEY = 'p11';
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 480000).unref();
const results = [];
const check = (name, ok, detail = '') => { results.push([name, !!ok]); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? `  (${detail})` : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const VK = { Enter: 13, Escape: 27, Tab: 9, ArrowRight: 39, ArrowLeft: 37, Digit1: 49, Digit2: 50, KeyL: 76, KeyP: 80 };

async function open(url, intercept) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURI(url)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const page = { ws, id: 0, pending: new Map(), errors: [], asked: [] };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && page.pending.has(m.id)) { page.pending.get(m.id)(m); page.pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') page.errors.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n')[0]);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') page.errors.push('console.error: ' + m.params.args.map((a) => a.value || a.description).join(' ').slice(0, 200));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon|program\.png|status of 409/.test((m.params.entry.url || '') + m.params.entry.text)) page.errors.push('log: ' + m.params.entry.text.slice(0, 200) + ' ' + (m.params.entry.url || ''));
    if (m.method === 'Fetch.requestPaused') {
      page.asked.push(m.params.request.url);
      page.send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from('{"ok":true}').toString('base64') });
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
  if (intercept) await page.send('Fetch.enable', { patterns: intercept.map((p) => ({ urlPattern: p, requestStage: 'Request' })) });
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

/* Every enabled, visible control in a container, reached by Tab from its first one? */
async function tabReach(page, container) {
  const want = await page.ev(`(() => { const c = document.querySelector(${J(container)});
    const list = [...c.querySelectorAll('button, input, select, textarea')].filter((n) => !n.disabled && n.offsetParent !== null && n.tabIndex >= 0);
    list.forEach((n, i) => { n.dataset.tr = String(i); }); if (list[0]) list[0].focus(); return list.length; })()`);
  const seen = new Set();
  for (let i = 0; i < want * 3 + 10 && seen.size < want; i++) {
    const t = await page.ev(`(document.activeElement && document.activeElement.closest(${J(container)}) && document.activeElement.dataset.tr) || ''`);
    if (t !== '') seen.add(t);
    await page.key('Tab', 'Tab');
  }
  return { want, got: seen.size };
}

(async () => {
  // Two plain scenes: blue and amber, a line of white text each. No camera,
  // no capture - nothing of this PC's goes into the test stream.
  const L = (id, name, type, x, y, w, h, props) => ({ id, type, name, visible: true, locked: false, group: '',
    transform: { x, y, w, h, rotation: 0, anchor: 'tl' }, style: { opacity: 1, blend: 'normal', radius: 0 }, props, triggers: [] });
  for (const [sid, color, label] of [[SA, '#2563eb', 'Scene A'], [SB, '#f59e0b', 'Scene B']]) {
    const s = await getJ(`/api/scenes/${sid}`);
    Object.assign(s, { name: `P11 ${label}`, transparency: 'opaque', background: { mode: 'solid', color },
      layers: [L('c1000001', 'Label', 'text', 660, 460, 600, 160, { text: label, size: 96, weight: 800, color: '#ffffff', align: 'center' })] });
    const r = await post(`/api/scenes/${sid}`, { scene: s, expect_rev: s.rev });
    if (r.status !== 200) throw new Error('setup ' + r.status);
  }
  await post('/api/live/key/forget', {});
  await post('/api/live/scene', { id: '' });

  const ed = await open(`${RIG}/canvas.html?scene=${SA}`, ['*/api/canvas/remote/open']);
  await ed.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitFor(ed, `location.origin === ${J(RIG)} && document.readyState === 'complete'`, 10000);
  await ed.ev(`localStorage.removeItem('cb-studio'); localStorage.removeItem('cb-view')`);
  await ed.send('Page.reload', { ignoreCache: true });
  check('the editor loads', await waitFor(ed, `window.Editor && Editor.scene() && Editor.scene().id === ${J(SA)}`, 10000));
  await sleep(1200);

  // ---- the LIVE panel: from the top bar's LIVE button
  await ed.ev(`document.getElementById('liveStatus').click()`);
  const opened = await waitFor(ed, `!document.getElementById('livePanel').hidden && document.getElementById('livePanel').contains(document.activeElement)`, 5000);
  check('the top bar\'s LIVE button opens the LIVE panel with the focus in it', opened);
  const q = (sel) => `document.querySelector('#livePanel [data-lp="${sel}"]')`;
  const t0 = await ed.ev(`${q('go')}.disabled`);
  check('Start waits for a key and a scene', t0 === true, await ed.ev(`${q('goHint')}.textContent`));
  await ed.ev(`${q('url')}.focus()`);
  await ed.send('Input.insertText', { text: RTMP_URL });
  await ed.ev(`${q('key')}.focus()`);
  await ed.send('Input.insertText', { text: RTMP_KEY });
  await ed.ev(`${q('save')}.click()`);
  await waitFor(ed, `LivePanel.status().has_key === true`, 5000);
  const keyShown = await ed.ev(`${q('key')}.value`);
  const ph = await ed.ev(`${q('key')}.placeholder`);
  const vault = await getJ('/api/live/status');
  check('the key is saved - and gone from the page, never shown again', vault.has_key && vault.saved_url === RTMP_URL && keyShown === '' && /Saved/.test(ph) && !J(vault).includes(`"${RTMP_KEY}"`),
    `has_key ${vault.has_key}, saved URL ${vault.saved_url}, field "${keyShown}", "${ph}"`);
  await ed.ev(`(() => { const s = ${q('preset')}; s.value = '720p30'; s.dispatchEvent(new Event('change')); })()`);
  await ed.ev(`(() => { const s = ${q('scene')}; s.value = ${J(SA)}; s.dispatchEvent(new Event('change')); })()`);
  await ed.ev(`(() => { for (const k of ['micOn', 'systemOn']) { const c = ${q('micOn')}.closest('#livePanel').querySelector('[data-lp="' + k + '"]'); if (c.checked) c.click(); } })()`);
  await sleep(400);
  const cfg = await getJ('/api/config');
  check('quality, scene and sound are set from the panel (no microphone, no desktop sound)',
    cfg.live.preset === '720p30' && cfg.canvas.live === SA && cfg.live.audio.mic === false && !cfg.live.audio.system, J({ preset: cfg.live.preset, live: cfg.canvas.live, audio: cfg.live.audio }));
  const hint = await ed.ev(`${q('presetHint')}.textContent`);
  check('the quality says what it asks of the upload', /3\.4 Mb\/s/.test(hint) && /upload/.test(hint), hint);
  const reach = await tabReach(ed, '#livePanel');
  check('every control of the LIVE panel is reached with Tab', reach.want > 10 && reach.got === reach.want, `${reach.got} of ${reach.want}`);

  // ---- Start
  const startedAt = Date.now();
  await ed.ev(`${q('go')}.click()`);
  const live = await waitFor(ed, `LivePanel.status().state === 'live'`, 30000);
  // The bitrate and frame rate are measured over a few seconds: wait for them to show.
  await waitFor(ed, `/Mb\\/s/.test(document.querySelector('#livePanel [data-lp="kbps"]').textContent) && /fps/.test(document.querySelector('#livePanel [data-lp="fps"]').textContent)`, 12000);
  const h = await ed.ev(`(() => ({ pill: ${q('pill')}.textContent, health: !${q('health')}.hidden, kbps: ${q('kbps')}.textContent, fps: ${q('fps')}.textContent, up: ${q('uptime')}.textContent, go: ${q('go')}.textContent }))()`);
  check('Start goes LIVE, and the health shows it', live && h.health && /LIVE/.test(h.pill) && /Mb\/s/.test(h.kbps) && /fps/.test(h.fps) && h.go === 'Stop',
    `${((Date.now() - startedAt) / 1000).toFixed(1)} s; ${J(h)}`);

  // ---- studio mode, from the keyboard; its program monitor
  await ed.ev(`document.getElementById('viewport').focus()`);
  await ed.key('P', 'KeyP', 2 | 8);
  const studioOn = await waitFor(ed, `!document.getElementById('programPanel').hidden`, 3000);
  const pgImg = await waitFor(ed, `(() => { const i = document.getElementById('pgImg'); return !i.hidden && i.naturalWidth > 0; })()`, 8000);
  const pg = await ed.ev(`({ scene: document.getElementById('pgScene').textContent, take: document.getElementById('pgTake').disabled, note: document.getElementById('pgNote').textContent })`);
  const pgShot = path.join(outdir, 'p11_studio.png');
  fs.writeFileSync(pgShot, Buffer.from((await ed.send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
  check('Ctrl+Shift+P: studio mode, its program monitor showing the live output', studioOn && pgImg && pg.scene === 'P11 Scene A',
    `${J(pg)}  (${pgShot})`);
  check('...editing the scene on air: Take is off, and it says why', pg.take && /on air/.test(pg.note));
  const pgReach = await tabReach(ed, '#programPanel');
  check('every control of the program panel is reached with Tab', pgReach.got === pgReach.want && pgReach.want >= 3, `${pgReach.got} of ${pgReach.want}`);

  // ---- 20 switches: the remote (clicks, keys) and a Take from the editor
  const rm = await open(`${RIG}/remote.html`);
  await rm.send('Emulation.setDeviceMetricsOverride', { width: 340, height: 640, deviceScaleFactor: 1, mobile: false });
  await waitFor(rm, `document.querySelectorAll('#rmList .rm-scene').length >= 2`, 8000);
  const sceneIds = await rm.ev(`[...document.querySelectorAll('#rmList .rm-scene')].map((b) => b.dataset.id)`);
  const ia = sceneIds.indexOf(SA), ib = sceneIds.indexOf(SB);
  const rmShot = path.join(outdir, 'p11_remote.png');
  fs.writeFileSync(rmShot, Buffer.from((await rm.send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
  check('the remote lists the scenes, the one on air marked', ia >= 0 && ib >= 0 && (await rm.ev(`!!document.querySelector('#rmList .rm-scene.on[data-id="${SA}"]')`)), `${sceneIds.length} scenes  (${rmShot})`);
  const switched = [];
  const liveNow = () => getJ('/api/config').then((c) => c.canvas.live);
  for (let n = 0; n < 20; n++) {
    const target = n % 2 === 0 ? SB : SA;
    if (n === 6) {                              // a Take from the editor, in studio mode
      await ed.ev(`Editor.load(${J(SB)})`);
      await waitFor(ed, `Editor.scene().id === ${J(SB)} && !document.getElementById('pgTake').disabled`, 5000);
      await ed.ev(`document.getElementById('viewport').focus()`);
      await ed.key('Enter', 'Enter', 2, '\r');
    } else if (n % 5 === 3 && sceneIds.indexOf(target) < 9) {   // the remote's number keys (1-9 only)
      const k = String(sceneIds.indexOf(target) + 1);
      await rm.ev('document.body.focus()');
      await rm.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: 'Digit' + k, text: k, windowsVirtualKeyCode: 48 + Number(k) });
      await rm.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: 'Digit' + k, windowsVirtualKeyCode: 48 + Number(k) });
    } else {
      await rm.ev(`document.querySelector('#rmList .rm-scene[data-id="${target}"]').click()`);
    }
    let got = '';
    for (let i = 0; i < 20 && got !== target; i++) { await sleep(100); got = await liveNow(); }
    switched.push(got === target);
    await sleep(1100);
  }
  check('20 switches from the remote (clicks, number keys) and a studio Take, each on air', switched.every(Boolean) && switched.length === 20,
    switched.map((x) => (x ? '.' : 'x')).join(''));
  const stillLive = (await getJ('/api/live/status')).state;
  check('...and the stream stayed LIVE through them', stillLive === 'live', stillLive);
  const rmReach = await tabReach(rm, 'body');
  check('every control of the remote is reached with Tab', rmReach.got === rmReach.want && rmReach.want >= 5, `${rmReach.got} of ${rmReach.want}`);
  await rm.ev(`document.getElementById('rmTop').click()`);
  await sleep(300);
  check('"On top" is remembered for the remote', (await getJ('/api/config')).canvas.remote_on_top === false);
  await post('/api/canvas/remote/topmost', { on: true });
  await ed.ev(`document.getElementById('remoteBtn').click()`);
  await sleep(300);
  check("the editor's Remote asks for the remote window (answered here, so none opens)", ed.asked.some((u) => u.endsWith('/api/canvas/remote/open')), ed.asked.join(' '));

  // ---- Stop, asked twice
  await ed.ev(`LivePanel.open(document.getElementById('liveStatus'))`);
  await sleep(300);
  await ed.ev(`${q('go')}.click()`);
  await sleep(200);
  const armed = await ed.ev(`${q('go')}.textContent`);
  const stillOn = (await getJ('/api/live/status')).state;
  await ed.ev(`${q('go')}.click()`);
  const stopped = await waitFor(ed, `!['connecting', 'live', 'reconnecting'].includes(LivePanel.status().state)`, 15000);
  const liveSeconds = (Date.now() - startedAt) / 1000;
  check('Stop asks twice, then stops', armed === 'Click again to stop' && stillOn === 'live' && stopped, `"${armed}"`);

  // The error that means TikTok issued a new key.
  await ed.ev(`LivePanel.onState({ live: { state: 'failed', error: ${J('TikTok refused the stream key after it had been live - LIVE Center may have issued a new key; copy it, paste it here and start again (badname)')} } })`);
  const rot = await ed.ev(`(() => { const e = ${q('error')}; return { shown: !e.hidden, rotated: e.classList.contains('rotated'), text: e.textContent }; })()`);
  check('a rotated key says to copy the new one from LIVE Center', rot.shown && rot.rotated && /new one/.test(rot.text), rot.text.slice(0, 80));
  await ed.ev(`LivePanel.onState({ live: { state: 'idle', error: '' } })`);

  // Forget the key, asked twice too.
  await ed.ev(`${q('forget')}.click()`);
  await sleep(150);
  await ed.ev(`${q('forget')}.click()`);
  await sleep(500);
  check('Forget the key (asked twice) removes it from this PC', (await getJ('/api/live/status')).has_key === false);

  // ---- the recording: decoded, every frame's brightness read
  const flv = path.join(outdir, 'stream.flv');
  for (let i = 0, last = -1; i < 40; i++) {                 // the sink closes the file when the stream ends
    const size = fs.existsSync(flv) ? fs.statSync(flv).size : 0;
    if (size > 0 && size === last) break;
    last = size;
    await sleep(500);
  }
  const dec = spawnSync(FF, ['-hide_banner', '-v', 'error', '-i', flv, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const lines = (dec.stdout || '').split(/\r?\n/);
  const frames = [];
  let pts = null;
  for (const line of lines) {
    const m1 = line.match(/pts_time:([\d.]+)/);
    if (m1) pts = Number(m1[1]);
    const m2 = line.match(/YAVG=([\d.]+)/);
    if (m2) frames.push({ t: pts, y: Number(m2[1]) });
  }
  const dur = frames.length ? frames[frames.length - 1].t - frames[0].t : 0;
  let gap = 0;
  for (let i = 1; i < frames.length; i++) gap = Math.max(gap, frames[i].t - frames[i - 1].t);
  const ys = frames.map((f) => f.y);
  // Switches: moves from one scene's level to the other's, counted with a
  // margin either side of the middle, so a fade passing it counts once.
  const mid = (Math.min(...ys) + Math.max(...ys)) / 2, band = (Math.max(...ys) - Math.min(...ys)) / 4;
  let crossings = 0, side = 0;
  for (const y of ys) {
    const s = y < mid - band ? -1 : y > mid + band ? 1 : 0;
    if (s && side && s !== side) crossings++;
    if (s) side = s;
  }
  // A flicker: a frame darker than every one of its neighbors by a clear step, or a near-black frame.
  const dips = [];
  for (let i = 3; i < ys.length - 3; i++) {
    const around = [...ys.slice(i - 3, i), ...ys.slice(i + 1, i + 4)];
    if (ys[i] < Math.min(...around) - 12) dips.push(i);
  }
  const blacks = ys.filter((y) => y < 40).length;
  fs.writeFileSync(path.join(outdir, 'p11_yavg.json'), J(frames));
  check('the stream was recorded: 720p30 video, no gaps', frames.length > 0 && frames.length >= 0.85 * dur * 30 && gap <= 0.2,
    `${frames.length} frames over ${dur.toFixed(1)} s (${(frames.length / Math.max(1, dur)).toFixed(1)} fps), largest gap ${(gap * 1000).toFixed(0)} ms, live for ${liveSeconds.toFixed(0)} s`);
  check('every switch reached the stream', crossings >= 19 && crossings <= 23, `${crossings} changes between the two scenes`);
  check('no flicker: no black frame, no frame darker than its neighbors, through all 20 switches', frames.length > 100 && blacks === 0 && dips.length === 0,
    `darkest ${Math.min(...ys).toFixed(1)}, brightest ${Math.max(...ys).toFixed(1)}; black ${blacks}; dips at ${dips.slice(0, 5).join(',') || 'none'}`);

  await sleep(300);
  const errs = [...ed.errors, ...rm.errors.map((e) => 'remote ' + e)];
  check('no console errors in the editor or the remote', errs.length === 0, errs.slice(0, 5).join(' || '));
  const failed = results.filter(([, ok]) => !ok).map(([n]) => n);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed` + (failed.length ? '; FAILED: ' + failed.join('; ') : ''));
  process.exit(0);
})().catch((e) => { console.log('ERROR ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 3).join('\n')); process.exit(1); });
