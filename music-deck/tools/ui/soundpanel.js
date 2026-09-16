// S7's check, both halves of it:
//   node soundpanel.js <devtools port> [rig port] [outdir]
//
//   1. the Sound panel driving /api/live/audio and /api/voice, with its
//      meters moving;
//   2. a scene with a microphone layer, while sound plays.
//
// Three things about how this is written are deliberate:
//
//  * It drives the panel's own controls and then asks the SERVER what
//    changed. Posting to the endpoints directly would pass with the panel
//    completely unwired, which is the one thing this is meant to prove.
//  * The lease is checked before any override is set. voice.py reports
//    source "monitor" the moment a lease exists - even where the microphone
//    itself fails to open - so off -> monitor -> off is proof the panel takes
//    the lease and gives it back, on a machine with or without a microphone.
//    An override would report source "override" and hide that entirely.
//  * The layer is checked against real movement, not a binary flip. Chrome's
//    --use-fake-device-for-media-stream plays an actual tone, so the bars must
//    take several different heights over a second. Start Chrome with
//    --use-fake-device-for-media-stream --use-fake-ui-for-media-stream, as
//    p9run.sh and p10run.sh already do.
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
  const p = { ws, id: 0, pending: new Map(), errors: [], targetId: t.id };
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
const getJ = (path) => fetch(RIG + path, { cache: 'no-store' }).then((r) => r.json());
const audioCfg = async () => ((await getJ('/api/live/status')).config || {}).audio || {};

(async () => {
  const before = await audioCfg();
  const beforeThr = (await getJ('/api/voice')).threshold;

  // ---------------------------------------------------------- 1. the panel
  const deck = await open(`${RIG}/deck.html`);
  await sleep(3500);

  const voiceSourceNow = async () => (await getJ('/api/voice')).source;
  const wasIdle = await voiceSourceNow();
  check('before it is opened, nothing holds the microphone', wasIdle === 'off', wasIdle);

  await deck.ev(`document.getElementById('soundBtn').click()`);
  await sleep(1200);
  const dbg = await deck.ev('AudioPanel.debug()');
  check('the Sound button opens the panel', !!dbg && dbg.open, J(dbg && dbg.open));

  const held = await voiceSourceNow();
  check('opening it takes the voice lease, so the meter has something to show',
    held === 'monitor', `source ${held} (was ${wasIdle})`);

  // -- /api/live/audio, driven by the panel's own controls
  await deck.ev(`(() => { const s = document.querySelector('#audioPanel [data-ap="micGain"]');
    s.value = '150'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(500);
  let cfg = await audioCfg();
  check('the microphone volume slider reaches the server', Math.abs(((cfg.gain || {}).mic ?? 1) - 1.5) < 0.01,
    J(cfg.gain));

  await deck.ev(`document.querySelector('#audioPanel [data-ap="micMute"]').click()`);
  await sleep(500);
  cfg = await audioCfg();
  check('Mute reaches the server', (cfg.mute || {}).mic === true, J(cfg.mute));

  await deck.ev(`(() => { const s = document.querySelector('#audioPanel [data-ap="systemGain"]');
    s.value = '80'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(500);
  cfg = await audioCfg();
  check('the desktop channel is wired the same way', Math.abs(((cfg.gain || {}).system ?? 1) - 0.8) < 0.01,
    J(cfg.gain));

  // -- /api/voice: the one "counts as talking" number
  await deck.ev(`(() => { const s = document.querySelector('#audioPanel [data-ap="thr"]');
    s.value = '25'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(600);
  const thr = (await getJ('/api/voice')).threshold;
  check('the talking threshold reaches the server, as one number', Math.abs(thr - 0.25) < 0.005, String(thr));
  const mark = await deck.ev(`document.querySelector('#audioPanel [data-ap="thrMark"]').style.left`);
  check('and its mark sits on the meter at that level', mark === '25%', mark);

  // -- the meter moves
  await post('/api/voice/override', { speaking: true });
  await sleep(700);
  const loud = await deck.ev('AudioPanel.debug()');
  await post('/api/voice/override', { speaking: false });
  await sleep(700);
  const quiet = await deck.ev('AudioPanel.debug()');
  check('the microphone meter moves with the voice', loud.micWidth === '100%' && quiet.micWidth === '0%',
    `loud ${loud.micWidth}, quiet ${quiet.micWidth}`);
  check('and the meter says when it counts as talking', loud.speaking === true && quiet.speaking === false,
    `${loud.speaking} then ${quiet.speaking}`);
  await post('/api/voice/override', { speaking: null });

  if (outDir) {
    const d = (await deck.send('Page.captureScreenshot', { format: 'png' })).result.data;
    fs.writeFileSync(`${outDir}/soundpanel.png`, Buffer.from(d, 'base64'));
    console.log('   wrote soundpanel.png');
  }

  await deck.ev(`document.getElementById('soundBtn').click()`);
  await sleep(800);
  const given = await voiceSourceNow();
  check('closing it gives the microphone back', given === 'off', given);
  check('nothing was thrown in the deck', deck.errors.length === 0, deck.errors.slice(0, 2).join(' | '));
  deck.ws.close();
  await fetch(`http://127.0.0.1:${port}/json/close/${deck.targetId}`).catch(() => {});

  // ------------------------------------------------- 2. the microphone layer
  const made = await (await post('/api/scenes', { name: 'Microphone layer', format: 'horizontal' })).json();
  const sid = made.scene.id;
  const scene = await getJ(`/api/scenes/${sid}`);
  scene.background = { mode: 'solid', color: '#101014' };
  scene.layers = [{
    id: 'mic_bars', name: 'Microphone', type: 'mic', visible: true, locked: false, group: '',
    transform: { x: 240, y: 380, w: 1440, h: 320, rotation: 0, anchor: 'tl' },
    style: { opacity: 1, blend: 'normal', radius: 0 },
    props: { device: '', style: 'bars', bars: 24, color: '#8b5cf6', gain: 1.4, smooth: 0.6 },
    triggers: [],
  }];
  const saved = await (await post(`/api/scenes/${sid}`, { scene, expect_rev: scene.rev })).json();
  check('the scene saved with a microphone layer', !!(saved.ok || saved.scene), J(saved).slice(0, 100));

  const out = await open(`${RIG}/scene.html?id=${sid}`);
  await out.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await sleep(3500);

  const built = await out.ev(`(() => {
    const el = document.querySelector('.layer[data-id="mic_bars"]');
    if (!el) return { missing: true };
    return { bars: el.querySelectorAll('.mic-bars > i').length, note: (el.querySelector('.source-note') || {}).textContent || '' };
  })()`);
  check('the layer drew its bars', built.bars === 24, J(built));

  // The first run of this test passed every check above against a layer that
  // rendered nothing: a flat 6% gap put 23 gaps of 86px into a 1440px box, so
  // every bar flexed to zero width while its transform went on changing. A
  // transform read from the DOM cannot see that. Measure what was laid out.
  const drawn = await out.ev(`(() => {
    const bars = [...document.querySelectorAll('.layer[data-id="mic_bars"] .mic-bars > i')];
    const rects = bars.map((b) => b.getBoundingClientRect());
    return { wide: rects.filter((r) => r.width >= 4).length,
             first: rects[0] ? Math.round(rects[0].width) : 0,
             across: Math.round(rects.reduce((s, r) => s + r.width, 0)) };
  })()`);
  check('and they have real width on screen, not just moving transforms',
    drawn.wide === 24 && drawn.across > 600, J(drawn));

  // Chrome's fake device plays a tone: the bars must take several heights.
  const moved = await out.ev(`(async () => {
    const bars = [...document.querySelectorAll('.layer[data-id="mic_bars"] .mic-bars > i')];
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      seen.add(bars.map((b) => b.style.transform).join('|'));
      await new Promise((r) => setTimeout(r, 40));
    }
    return seen.size;
  })()`);
  check('and they move while sound plays', moved >= 3, `${moved} different shapes in 1.2 s`);

  const ctx = await out.ev(`(() => {
    const el = document.querySelector('.layer[data-id="mic_bars"]');
    const one = [...el.querySelectorAll('.mic-bars > i')].map((b) => b.style.transform).filter((t) => t && t !== 'scaleY(0.020)');
    return one.length;
  })()`);
  check('the analyser is running, not stuck at the floor', ctx > 0, `${ctx} bars above the floor`);

  // P9 checks that Ultra stops the CSS loops; this one is a JS loop of its own,
  // and nothing else would notice it waking 165 times a second to do nothing.
  const origUltra = ((await getJ('/api/config')).ui || {}).ultra;
  await post('/api/config', { ui: { ultra: true } });
  await sleep(1200);
  const still = await out.ev(`(async () => {
    const bars = [...document.querySelectorAll('.layer[data-id="mic_bars"] .mic-bars > i')];
    const shape = () => bars.map((b) => b.style.transform).join('|');
    const first = shape();
    await new Promise((r) => setTimeout(r, 700));
    return { same: shape() === first, shape: first.slice(0, 40) };
  })()`);
  check('Ultra stops the meter, and it holds its last shape', still.same, J(still));
  await post('/api/config', { ui: { ultra: !!origUltra } });
  await sleep(900);
  const back = await out.ev(`(async () => {
    const bars = [...document.querySelectorAll('.layer[data-id="mic_bars"] .mic-bars > i')];
    const shape = () => bars.map((b) => b.style.transform).join('|');
    const first = shape();
    for (let i = 0; i < 15; i++) { await new Promise((r) => setTimeout(r, 40)); if (shape() !== first) return true; }
    return false;
  })()`);
  check('and it starts again when Ultra goes off', back, String(back));

  check('nothing was thrown in the scene', out.errors.length === 0, out.errors.slice(0, 2).join(' | '));

  if (outDir) {
    const d = (await out.send('Page.captureScreenshot', { format: 'png' })).result.data;
    fs.writeFileSync(`${outDir}/miclayer.png`, Buffer.from(d, 'base64'));
    console.log('   wrote miclayer.png');
  }

  // ------------------------------------------------------------- put it back
  await post('/api/live/audio', { source: 'mic', gain: (before.gain || {}).mic ?? 1, mute: !!(before.mute || {}).mic });
  await post('/api/live/audio', { source: 'system', gain: (before.gain || {}).system ?? 1, mute: !!(before.mute || {}).system });
  await post('/api/voice', { threshold: beforeThr });
  await post('/api/voice/override', { speaking: null });
  await post(`/api/scenes/${sid}/delete`, {});

  const bad = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - bad} of ${results.length} passed`);
  process.exit(bad ? 1 : 0);
})().catch(async (e) => {
  try { await post('/api/voice/override', { speaking: null }); } catch (_) {}
  console.log('THREW ' + e.message);
  process.exit(2);
});
