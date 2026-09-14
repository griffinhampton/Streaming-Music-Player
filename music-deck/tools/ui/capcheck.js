// What the captions overlay puts in front of an audience.
//
//   node capcheck.js <devtools port> [rig port]
//
// The 'unavailable' branch of captions.js renders whatever the engine threw.
// This drives that branch directly - render() is a global, because
// captions.html loads captions.js as a classic script - and reads what the
// document ends up showing.
//
// Plain page, never ?preview=1: under preview demoTick() calls
// render({on:true}) every 2.2 s, so the stage is never 'unavailable' there and
// the branch would never run. Checking it in preview would prove nothing,
// which is the same trap the 'off' branch set last time.
const [port, rigPort = '8799'] = process.argv.slice(2);
const RIG = `http://127.0.0.1:${rigPort}`;
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 120000).unref();

const results = [];
const check = (n, ok, d = '') => {
  results.push([n, !!ok]);
  console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? `  (${d})` : ''));
};
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
    if (m.method === 'Runtime.exceptionThrown') {
      p.errors.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n')[0]);
    }
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

// Both strings were produced, not imagined. The first is what faster-whisper
// actually said when handed a model folder with no weights in it, measured on
// .build-env's interpreter and wrapped exactly as captions_whisper.py:440
// wraps it. The second is captions.py:130, which is fixed text.
// A stand-in for the real path rather than the real one: tools/ must not name
// this repo (tests/test_tools.py), and what is being measured is whether an
// absolute path of any shape reaches the overlay - not which folder it is.
const LEAK = String.raw`Whisper could not load: Unable to open file 'model.bin' in model 'C:\Users\someone\models\small.en'`;
const NAG = "Whisper's model isn't downloaded yet - press Download on the Captions tab.";

const READ = `{
  state: document.getElementById('stage').dataset.state,
  status: document.getElementById('status').textContent,
  shown: document.body.innerText,
  all: document.body.textContent
}`;

const drive = (page, err) => page.ev(
  `(() => { render({ on: true, state: 'unavailable', error: ${J(err)} }, Date.now() / 1000);` +
  `  return ${READ}; })()`);

(async () => {
  const page = await open(`${RIG}/captions.html`);
  // windowctl holds a first-open hint for 4000 ms. Read past it or read it.
  await sleep(4500);

  // --------------------------------------------- 1. the engine's own exception
  const leak = await drive(page, LEAK);

  // Anti-vacuity first: if the branch did not run, everything below is a
  // statement about a page that never rendered.
  check('the unavailable branch actually rendered', leak.state === 'unavailable', J(leak.state));

  // A drive letter is the thing to look for, not a particular username: the
  // claim is that no absolute path of any shape reaches the overlay.
  check('no absolute path reaches the overlay',
    !/[A-Z]:[\\/]/.test(leak.all), J(leak.shown).slice(0, 140));
  check('no engine exception text reaches the overlay',
    !leak.all.includes('model.bin') && !leak.all.includes('Whisper could not load'),
    J(leak.shown).slice(0, 140));
  check('the status says the plain thing instead',
    leak.status.trim() === 'Captions unavailable', J(leak.status));

  // ------------------------------------------- 2. the fixed sentence, likewise
  const nag = await drive(page, NAG);
  check('no instruction to press a button in a deck the audience has not got',
    !/press Download/i.test(nag.all) && !/Captions tab/i.test(nag.all), J(nag.shown).slice(0, 140));

  // ----------------------------------------------------- 3. the control
  // Absence proves nothing until the probe is shown finding the same string
  // when it really is on the page. Written into the very node the fix stopped
  // writing to, then put back.
  const ctl = await page.ev(
    `(() => { const s = document.getElementById('status');` +
    `  const was = s.textContent; s.textContent = ${J(LEAK)};` +
    `  const seen = ${READ}; s.textContent = was; return seen; })()`);
  // Against LEAK itself rather than a fragment of it. This asked for "ghamp"
  // once, and went red the day the string changed to stop naming this repo -
  // which is the control doing its job, but a control that needs editing
  // whenever the fixture moves is one that will eventually be edited wrong.
  check('the probe can see leaked text when it is there (control)',
    ctl.all.includes(LEAK), J(ctl.status).slice(0, 100));

  const restored = await page.ev(`document.getElementById('status').textContent`);
  check('the control put the page back', restored.trim() === 'Captions unavailable', J(restored));

  // --------------------------------- 4. the claim the comment makes about preview
  const pv = await open(`${RIG}/captions.html?preview=1`);
  await sleep(5000);
  const pvState = await pv.ev(`document.getElementById('stage').dataset.state`);
  check('preview never reaches this branch, so it only ever renders on stream',
    pvState !== 'unavailable' && pvState !== 'off', J(pvState));

  check('nothing was thrown in the overlay', page.errors.length === 0, page.errors.slice(0, 2).join(' | '));

  for (const p of [page, pv]) {
    try { p.ws.close(); } catch (_) {}
    await fetch(`http://127.0.0.1:${port}/json/close/${p.targetId}`).catch(() => {});
  }

  const bad = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - bad} of ${results.length} passed`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('THREW ' + e.message); process.exit(2); });
