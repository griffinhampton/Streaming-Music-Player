// The window controls must be absent in the editor's preview and present in a
// standalone output - and the overlay must not swallow pointer events.
const [port, rigPort = '8799'] = process.argv.slice(2);
const RIG = `http://127.0.0.1:${rigPort}`;
const results = [];
const check = (n, ok, d = '') => { results.push([n, !!ok]); console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? `  (${d})` : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function open(url) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const p = { ws, id: 0, pending: new Map(), errors: [] };
  ws.onmessage = (e) => { const m = JSON.parse(e.data);
    if (m.id && p.pending.has(m.id)) { p.pending.get(m.id)(m); p.pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') p.errors.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n')[0]); };
  p.send = (m, q = {}) => new Promise((r) => { const i = ++p.id; p.pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: q })); });
  p.ev = async (x) => { const r = await p.send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text); return r.result.result.value; };
  await p.send('Runtime.enable');
  return p;
}
const PROBE = `(() => {
  const h = document.getElementById('winHandles');
  const cs = h && getComputedStyle(h);
  const btns = [...document.querySelectorAll('#winHandles .winbtn')];
  const rz = [...document.querySelectorAll('#winHandles .rz[data-edge]')];
  return {
    onBody: document.body.classList.contains('has-winctl'),
    hint: document.body.classList.contains('show-hint'),
    display: cs && cs.display, pe: cs && cs.pointerEvents, opacity: cs && cs.opacity,
    btnPe: btns.map((b) => getComputedStyle(b).pointerEvents).join(','),
    rzCount: rz.length, rzPe: rz.length ? getComputedStyle(rz[0]).pointerEvents : '',
    edges: rz.map((e) => e.dataset.edge).sort().join(''),
    siblingOfRoot: !!h && h.parentElement === document.body,
    insideRoot: !!(document.getElementById('root') || {}).contains && document.getElementById('root').contains(h),
  };
})()`;
(async () => {
  const sid = (await (await fetch(`${RIG}/api/scenes`)).json()).scenes[0].id;

  const prev = await open(`${RIG}/scene.html?id=${sid}&preview=1`);
  await sleep(2000);
  const p = await prev.ev(PROBE);
  check('preview: the controls are not switched on', p.onBody === false, `has-winctl ${p.onBody}`);
  check('preview: the overlay stays hidden', p.display === 'none', `display ${p.display}`);
  check('preview: nothing thrown', prev.errors.length === 0, prev.errors.slice(0, 2).join(' | '));

  const out = await open(`${RIG}/scene.html?id=${sid}`);
  await sleep(2000);
  const s = await out.ev(PROBE);
  check('output: the controls are switched on', s.onBody === true);
  check('output: the overlay is shown but lets pointers through', s.display === 'block' && s.pe === 'none', `display ${s.display}, pointer-events ${s.pe}`);
  check('output: the buttons themselves take pointers', /^auto,auto$/.test(s.btnPe), s.btnPe);
  check('output: all eight resize edges are there and live', s.rzCount === 8 && s.rzPe === 'auto', `${s.rzCount} edges "${s.edges}", pointer-events ${s.rzPe}`);
  check('output: the overlay sits outside the scaled box', s.siblingOfRoot && !s.insideRoot, `sibling ${s.siblingOfRoot}, inside #root ${s.insideRoot}`);
  check('output: the first-open hint is showing', s.hint === true);
  await sleep(4200);
  const after = await out.ev(`document.body.classList.contains('show-hint')`);
  check('output: the hint clears itself', after === false);
  check('output: nothing thrown', out.errors.length === 0, out.errors.slice(0, 2).join(' | '));

  const bad = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - bad} of ${results.length} passed`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('THREW ' + e.message); process.exit(2); });
