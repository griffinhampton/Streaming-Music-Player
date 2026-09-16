// Can a streamer actually add an alert or a poll layer? (T9)
//
//   node addpalette.js <devtools port> [rig port] [outdir]
//
// Both types have had a working runtime and a full inspector since the day
// they shipped, and no way at all to create one - the rig made them through
// the API, which is exactly why nobody noticed. So this asks the question the
// way a person would: is it in the grid, and does clicking it leave a layer
// that works.
//
// It drives Editor.add(i), which is the same addLayer(makeLayer(...)) the
// grid's click handler calls, and reads the labels out of the grid's DOM
// rather than out of the ADD array - the array being right is not the claim.
//
// On a scene of its own, created and deleted here, so nothing of the user's
// is touched.
const fs = require('fs');
const [port, rigPort = '8799', outDir] = process.argv.slice(2);
const RIG = `http://127.0.0.1:${rigPort}`;
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 150000).unref();

const results = [];
const check = (n, ok, d = '') => {
  results.push([n, !!ok]);
  console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? `  (${d})` : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const post = (path, body) => fetch(RIG + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: J(body || {}),
}).then((r) => r.json());
const getJ = (path) => fetch(RIG + path, { cache: 'no-store' }).then((r) => r.json());

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

// What the Add grid is offering, as it is drawn.
const GRID = `[...document.querySelectorAll('#addGrid button')].map((b) =>
  (b.querySelector('span') || {}).textContent || '')`;

(async () => {
  const scene = (await post('/api/scenes', { name: 'T9 palette probe', format: 'horizontal' })).scene;
  const page = await open(`${RIG}/canvas.html?scene=${scene.id}`);
  await page.send('Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });   // the builder's own size
  await sleep(4000);

  const labels = await page.ev(GRID);
  check('the builder opened on its scene', Array.isArray(labels) && labels.length > 0, J((labels || []).length));
  check('"Alert" is offered in the Add grid', (labels || []).includes('Alert'), J(labels));
  check('"Poll" is offered too', (labels || []).includes('Poll'), J(labels));

  // Add them the way the grid does - by index into the same list it renders.
  const iAlert = labels.indexOf('Alert');
  const iPoll = labels.indexOf('Poll');
  const made = await page.ev(`(() => {
    const a = Editor.add(${iAlert});
    const p = Editor.add(${iPoll});
    const s = Editor.scene();
    const of = (id) => s.layers.find((l) => l.id === id) || null;
    return { alert: of(a), poll: of(p) };
  })()`);

  const al = made && made.alert, po = made && made.poll;
  check('adding "Alert" leaves an alert layer', al && al.type === 'alert', J(al && al.type));
  check('adding "Poll" leaves a poll layer', po && po.type === 'poll', J(po && po.type));

  // The failure this guards against: addable but inert, because a prop was
  // named something the runtime never reads.
  check('the alert layer carries the props its own code reads',
    al && al.props && al.props.seconds === 6 && al.props.max === 5 && al.props.size === 34,
    J(al && al.props));
  check('and the poll layer carries its own',
    po && po.props && po.props.bar === '#8b5cf6' && po.props.linger === 15 && po.props.size === 30,
    J(po && po.props));

  // TYPE_NAME lives in a different file from the palette, so nothing else
  // would notice if only one of the two edits had landed.
  // The type tag in the inspector header, which is the one place TYPE_NAME is
  // read (canvas.js: `TYPE_NAME[l.type] || l.type`). The first version of this
  // asked a looser question - "does it say something other than undefined?" -
  // against guessed selectors, and passed by finding "Position and size", a
  // heading every layer type has. It would have passed with the TYPE_NAME edit
  // reverted, which makes it worse than no check at all.
  const tagOf = async (id) => {
    await page.ev(`Editor.select([${J(id)}])`);
    await sleep(400);                       // the inspector redraws on select
    return page.ev(`((document.querySelector('#inspector .insp h2 .tag') || {}).textContent || '').trim()`);
  };
  const alertTag = await tagOf(al && al.id);
  const pollTag = await tagOf(po && po.id);
  check('the inspector names an alert layer "Alert"', alertTag === 'Alert', J(alertTag));
  check('and a poll layer "Poll"', pollTag === 'Poll', J(pollTag));

  // The control: I inserted into an array two call sites index by position.
  const zero = await page.ev(`(() => { const id = Editor.add(0); const s = Editor.scene();
    return (s.layers.find((l) => l.id === id) || {}).type; })()`);
  check('ADD[0] is still the PNGtuber entry after the insertion', zero === 'reactive', J(zero));

  if (outDir) {
    const shot = (await page.send('Page.captureScreenshot', { format: 'png' })).result.data;
    fs.writeFileSync(`${outDir}/t9-palette.png`, Buffer.from(shot, 'base64'));
    console.log('   wrote t9-palette.png');
  }

  check('nothing was thrown in the builder', page.errors.length === 0, page.errors.slice(0, 2).join(' | '));

  try { page.ws.close(); } catch (_) {}
  await fetch(`http://127.0.0.1:${port}/json/close/${page.targetId}`).catch(() => {});
  await post(`/api/scenes/${scene.id}/delete`, {});
  const gone = !(await getJ('/api/scenes')).scenes.some((s) => s.id === scene.id);
  check('the probe scene was deleted again', gone);

  const bad = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - bad} of ${results.length} passed`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('THREW ' + e.message); process.exit(2); });
