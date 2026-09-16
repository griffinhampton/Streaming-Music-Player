// S6's check: the voice triggers, driven between quiet and talking, read off
// the rendered scene each way.
//   node voicetrig.js <devtools port> [rig port] [outdir]
//
// The vocabulary is two moments and four things to do:
//   while I talk        -> show it / hide it / bounce / glow, held
//   when I start talking-> the same four, once, for one beat
//
// Three things here are worth saying out loud, because each one is a bug this
// test exists to keep out:
//
//  * The beat lasts 650 ms. Polling for it over CDP races the clock and a miss
//    reads as a broken feature, so a MutationObserver goes in BEFORE the flip
//    and records every class the layer ever wore.
//  * "bounce" is checked on a SHAPE layer, not the PNGtuber. Only the reactive
//    layer sets --bounce, and the keyframe used to fall back to 0px - so a
//    bounce trigger on any other layer added the class and then animated a
//    movement of nothing. Sampling the computed translate is what proves it
//    actually moves.
//  * The override is cleared at the end whatever happens: leaving the rig
//    pinned to "speaking" would quietly poison every later run.
const fs = require('fs');
const [port, rigPort = '8799', outDir] = process.argv.slice(2);
const RIG = `http://127.0.0.1:${rigPort}`;
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 180000).unref();

const results = [];
const check = (n, ok, d = '') => { results.push([n, !!ok]); console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? `  (${d})` : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

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
  p.send = (m, q = {}) => new Promise((r) => { const i = ++p.id; p.pending.set(i, r); ws.send(J({ id: i, method: m, params: q })); });
  p.ev = async (x) => {
    const r = await p.send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result.result.value;
  };
  await p.send('Runtime.enable');
  return p;
}

const post = (path, body) => fetch(RIG + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: J(body || {}) });
const say = (speaking) => post('/api/voice/override', { speaking });

const layer = (id, name, type, x, y, w, h, props, triggers) => ({
  id, name, type, visible: true, locked: false, group: '',
  transform: { x, y, w, h, rotation: 0, anchor: 'tl' },
  style: { opacity: 1, blend: 'normal', radius: 0 },
  props, triggers,
});

(async () => {
  const made = await (await post('/api/scenes', { name: 'Voice triggers', format: 'horizontal' })).json();
  const sid = made.scene.id;
  const scene = await (await fetch(`${RIG}/api/scenes/${sid}`)).json();
  scene.background = { mode: 'solid', color: '#101014' };
  scene.layers = [
    layer('vt_show', 'Only while talking', 'text', 60, 60, 600, 120,
      { text: 'TALKING', size: 72, color: '#ffffff', align: 'center', valign: 'center' },
      [{ on: 'speaking', do: 'show' }]),
    layer('vt_hide', 'Gone while talking', 'text', 60, 220, 600, 120,
      { text: 'QUIET', size: 72, color: '#ffffff', align: 'center', valign: 'center' },
      [{ on: 'speaking', do: 'hide' }]),
    layer('vt_bounce', 'Bounces while talking', 'shape', 60, 380, 300, 200,
      { kind: 'rect', fill: '#8b5cf6' }, [{ on: 'speaking', do: 'bounce' }]),
    layer('vt_glow', 'Glows while talking', 'shape', 420, 380, 300, 200,
      { kind: 'ellipse', fill: '#8b5cf6' }, [{ on: 'speaking', do: 'glow', value: '#ff7ab6' }]),
    layer('vt_beat', 'One bounce when I start', 'shape', 780, 380, 300, 200,
      { kind: 'rect', fill: '#22d3ee' }, [{ on: 'speech_start', do: 'bounce' }]),
  ];
  const saved = await (await post(`/api/scenes/${sid}`, { scene, expect_rev: scene.rev })).json();
  check('the scene saved with a trigger of each kind', !!(saved.ok || saved.scene), J(saved).slice(0, 120));

  // The server keeps whatever the last override said, so start from quiet.
  await say(false);
  const page = await open(`${RIG}/scene.html?id=${sid}`);
  // The scene's own size, so fit() maps it 1:1 and a shot frames all of it. At
  // the browser's default window the page centered an unscaled 1920x1080 and the
  // picture showed only the middle - the checks read the DOM and did not care,
  // which is exactly how a useless screenshot goes unnoticed.
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await sleep(2500);

  const read = (lid) => page.ev(`(() => {
    const el = document.querySelector('.layer[data-id="${lid}"]');
    if (!el) return { missing: true };
    const cs = getComputedStyle(el);
    return {
      cls: [...el.classList].join(' '),
      shown: cs.display !== 'none',
      filter: cs.filter,
      glow: cs.getPropertyValue('--glow').trim(),
      anim: cs.animationName,
    };
  })()`);

  // ---- quiet
  let show = await read('vt_show'), hide = await read('vt_hide'),
      bounce = await read('vt_bounce'), glow = await read('vt_glow');
  check('quiet: "show it while I talk" is not on screen', !show.shown, show.cls);
  check('quiet: "hide it while I talk" is on screen', hide.shown, hide.cls);
  check('quiet: nothing is bouncing', bounce.anim === 'none', bounce.anim);
  check('quiet: nothing is glowing', glow.filter === 'none', glow.filter);

  // ---- watch for the beat before it can happen, then start talking
  await page.ev(`(() => {
    window.__beat = [];
    const el = document.querySelector('.layer[data-id="vt_beat"]');
    new MutationObserver(() => el.classList.forEach((c) => { if (!window.__beat.includes(c)) window.__beat.push(c); }))
      .observe(el, { attributes: true, attributeFilter: ['class'] });
  })()`);
  await say(true);
  await sleep(700);

  show = await read('vt_show'); hide = await read('vt_hide');
  bounce = await read('vt_bounce'); glow = await read('vt_glow');
  check('talking: "show it while I talk" came on screen', show.shown, show.cls);
  check('talking: "hide it while I talk" went away', !hide.shown, hide.cls);
  check('talking: the bounce is running', bounce.anim === 'bob' && /bounce/.test(bounce.cls), `${bounce.anim} / ${bounce.cls}`);
  check('talking: the glow is drawn, in its own color', /drop-shadow/.test(glow.filter) && glow.glow === '#ff7ab6',
    `${glow.glow} ${glow.filter.slice(0, 60)}`);

  // A shape layer never sets --bounce, so this is the case that used to animate
  // a movement of zero. Sample the computed translate across one cycle.
  const moved = await page.ev(`(async () => {
    const el = document.querySelector('.layer[data-id="vt_bounce"]');
    const seen = new Set();
    for (let i = 0; i < 14; i++) { seen.add(getComputedStyle(el).translate); await new Promise((r) => setTimeout(r, 45)); }
    return [...seen].join(' | ');
  })()`);
  // A translate reads "<x> <y>", so a vertical bob is "0px -8px" - it always
  // begins with the zero X. Testing the start of the string called every moving
  // sample still, and failed a layer that was bouncing perfectly well.
  check('talking: the bounce actually moves a layer that sets no --bounce',
    moved.split(' | ').some((v) => v && v.trim() !== 'none' && !/^0px(\s+0px)?$/.test(v.trim())), moved.slice(0, 110));

  const beat = await page.ev('window.__beat.join(" ")');
  check('starting to talk fired the one-shot beat', /beat-bounce/.test(beat), beat);
  const beatNow = await read('vt_beat');
  check('and the beat is over by itself', !/beat-bounce/.test(beatNow.cls), beatNow.cls);

  // ---- back to quiet
  await say(false);
  await sleep(700);
  show = await read('vt_show'); glow = await read('vt_glow'); bounce = await read('vt_bounce');
  check('quiet again: it hid itself', !show.shown, show.cls);
  check('quiet again: the glow went out', glow.filter === 'none', glow.filter);
  check('quiet again: the bounce stopped', bounce.anim === 'none', bounce.anim);
  check('nothing was thrown', page.errors.length === 0, page.errors.slice(0, 2).join(' | '));

  if (outDir) {
    await say(true);
    await sleep(600);
    const d = (await page.send('Page.captureScreenshot', { format: 'png' })).result.data;
    fs.writeFileSync(`${outDir}/voicetrig.png`, Buffer.from(d, 'base64'));
    console.log('   wrote voicetrig.png');
  }

  // Whatever happened above, hand the microphone back.
  try { await say(null); } catch (_) {}
  try { await post(`/api/scenes/${sid}/delete`, {}); } catch (_) {}
  const bad = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - bad} of ${results.length} passed`);
  process.exit(bad ? 1 : 0);
})().catch(async (e) => {
  try { await say(null); } catch (_) {}
  console.log('THREW ' + e.message);
  process.exit(2);
});
