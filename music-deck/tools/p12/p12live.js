// P12: LIVE start, reconnect and stop, all from the LIVE panel, streaming for
// real to a local ffmpeg RTMP listener on the rig:
//   node p12live.js <devtools port> <scene id> <outdir> <ffmpeg> [rig port]
// The listener is killed mid-stream (the stream drops as if the internet
// went), the panel must say Reconnecting; a new listener comes up, the panel
// must be LIVE again with one reconnect counted, and what it records after
// the reconnect must decode from its first frame (the engine sends a
// keyframe first). The scene is plain (no camera, no capture) and the
// microphone and desktop sound are turned off in the panel.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const [port, SID, outdir, FF, rigPort = '8799'] = process.argv.slice(2);
const RIG = `http://127.0.0.1:${rigPort}`;
const RTMP_URL = 'rtmp://127.0.0.1:1935/live', RTMP_KEY = 'p12';
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 300000).unref();
const results = [];
const check = (name, ok, detail = '') => { results.push([name, !!ok]); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? `  (${detail})` : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

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
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon|program\.png|status of 409/.test((m.params.entry.url || '') + m.params.entry.text)) page.errors.push('log: ' + m.params.entry.text.slice(0, 200));
  };
  page.send = (method, params = {}) => new Promise((r) => { const i = ++page.id; page.pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  page.ev = async (expression) => {
    const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result.result.value;
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
    await sleep(100);
  }
  return false;
}
const post = (p, body) => fetch(RIG + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: J(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const getJ = async (p) => (await fetch(RIG + p, { cache: 'no-store' })).json();
const listen = (file) => spawn(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-listen', '1', '-timeout', '90',
  '-i', `${RTMP_URL}/${RTMP_KEY}`, '-c', 'copy', '-f', 'flv', file], { stdio: 'ignore', windowsHide: true });
/* Frames decoded from a recording, and whether the decoder complained. */
function decode(file) {
  const r = spawnSync(FF, ['-hide_banner', '-v', 'error', '-stats', '-i', file, '-map', '0:v:0', '-f', 'null', '-'], { encoding: 'utf8' });
  const frames = [...(r.stderr || '').matchAll(/frame=\s*(\d+)/g)].map((m) => +m[1]).pop() || 0;
  const errors = (r.stderr || '').split(/\r?\n|\r/).filter((l) => l.trim() && !/^frame=/.test(l.trim()));
  return { frames, errors };
}

(async () => {
  fs.mkdirSync(outdir, { recursive: true });
  const s = await getJ(`/api/scenes/${SID}`);
  Object.assign(s, { name: 'P12 LIVE', transparency: 'opaque', background: { mode: 'solid', color: '#0f766e' }, layers: [
    { id: 'p12l0001', type: 'text', name: 'Label', visible: true, locked: false, group: '', triggers: [],
      transform: { x: 560, y: 460, w: 800, h: 160, rotation: 0, anchor: 'tl' }, style: { opacity: 1, blend: 'normal', radius: 0 },
      props: { text: 'P12 reconnect', size: 96, weight: 800, color: '#ffffff', align: 'center' } }] });
  await post(`/api/scenes/${SID}`, { scene: s, expect_rev: s.rev });
  await post('/api/live/key/forget', {});

  const first = path.join(outdir, 'before.flv'), second = path.join(outdir, 'after.flv');
  let sink = listen(first);

  const ed = await open(`${RIG}/canvas.html?scene=${SID}`);
  await ed.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await ed.send('Page.bringToFront');
  await waitFor(ed, `window.Editor && Editor.scene() && Editor.scene().id === ${J(SID)} && window.LivePanel`, 12000);
  const q = (sel) => `document.querySelector('#livePanel [data-lp="${sel}"]')`;
  await ed.ev(`document.getElementById('liveStatus').click()`);
  await waitFor(ed, `!document.getElementById('livePanel').hidden`, 4000);
  await ed.ev(`${q('url')}.focus()`);
  await ed.send('Input.insertText', { text: RTMP_URL });
  await ed.ev(`${q('key')}.focus()`);
  await ed.send('Input.insertText', { text: RTMP_KEY });
  await ed.ev(`${q('save')}.click()`);
  await waitFor(ed, `LivePanel.status().has_key === true`, 5000);
  await ed.ev(`(() => { const s = ${q('preset')}; s.value = '720p30'; s.dispatchEvent(new Event('change')); })()`);
  await ed.ev(`(() => { const s = ${q('scene')}; s.value = ${J(SID)}; s.dispatchEvent(new Event('change')); })()`);
  await ed.ev(`(() => { for (const k of ['micOn', 'systemOn']) { const c = document.querySelector('#livePanel [data-lp="' + k + '"]'); if (c.checked) c.click(); } })()`);
  await sleep(500);
  const cfg = await getJ('/api/config');
  check('the panel is set up: a key, 720p30, this scene, no microphone, no desktop sound', cfg.live.audio.mic === false && !cfg.live.audio.system && cfg.canvas.live === SID);

  await ed.ev(`${q('go')}.click()`);
  const live = await waitFor(ed, `LivePanel.status().state === 'live'`, 30000);
  check('Start goes LIVE', live, await ed.ev(`${q('pill')}.textContent`));
  await sleep(6000);

  // ---- the connection drops: the listener is gone
  const dropAt = Date.now();
  sink.kill();
  const reconnecting = await waitFor(ed, `LivePanel.status().state === 'reconnecting' && /Reconnecting/.test(${q('pill')}.textContent)`, 20000);
  check('the connection drops: the panel says Reconnecting', reconnecting, `${((Date.now() - dropAt) / 1000).toFixed(1)} s; "${await ed.ev(`${q('pill')}.textContent`)}"`);
  await sleep(1500);
  sink = listen(second);
  const upAt = Date.now();
  const back = await waitFor(ed, `LivePanel.status().state === 'live'`, 45000);
  const rc = await ed.ev(`${q('reconnects')}.textContent`);
  check('...it comes back by itself: LIVE again, one reconnect counted', back && Number(rc) >= 1, `${((Date.now() - upAt) / 1000).toFixed(1)} s after the listener came back; reconnects ${rc}`);
  await sleep(6000);

  // ---- Stop, asked twice
  await ed.ev(`${q('go')}.click()`);
  const asked = await ed.ev(`${q('go')}.textContent`);
  await ed.ev(`${q('go')}.click()`);
  const stopped = await waitFor(ed, `!['connecting', 'live', 'reconnecting'].includes(LivePanel.status().state)`, 15000);
  check('Stop asks twice, then stops', /again/i.test(asked) && stopped, `"${asked}"`);
  for (let i = 0; i < 50 && sink.exitCode === null; i++) await sleep(200);
  if (sink.exitCode === null) sink.kill();

  const a = decode(second);
  check('what went out after the reconnect decodes from its first frame', a.frames > 100 && a.errors.length === 0,
    `${a.frames} frames, ${a.errors.length ? a.errors.slice(0, 3).join(' | ') : 'no decoder errors'}`);
  check('no console errors in the editor', ed.errors.length === 0, ed.errors.slice(0, 4).join(' | '));

  await post('/api/live/key/forget', {});
  await post('/api/live/stop', {});
  await fetch(`http://127.0.0.1:${port}/json/close/${ed.targetId}`).catch(() => {});
  const failed = results.filter(([, ok]) => !ok).map(([n]) => n);
  console.log(`${results.length - failed.length} of ${results.length} checks passed` + (failed.length ? '; FAILED: ' + failed.join('; ') : ''));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.log('ERROR ' + (e.stack || e)); process.exit(2); });
