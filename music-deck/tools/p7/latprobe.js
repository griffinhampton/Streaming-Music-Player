// Where an edit's time goes on its way to an open output page:
//   node latprobe.js <devtools port> <scene id> [rig port]
// Saves a changed text straight to the server (no editor), and times
// (1) the save's round trip, (2) the feed announcing the new revision in
// the output page, (3) the output page showing the new text.
const [port, SID, rigPort = '8799'] = process.argv.slice(2);
const RIG = `http://127.0.0.1:${rigPort}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 90000).unref();
(async () => {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURI(RIG + '/scene.html?id=' + SID)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result.result.value;
  await send('Runtime.enable');
  // Record, inside the page, when each revision arrives and when a marker text shows up.
  await sleep(3000);
  await ev(`(() => {
    window.__lat = { rev: {}, text: {} };
    const o = WebSocket.prototype.addEventListener;
    const seen = new Set();
    new MutationObserver(() => {
      const m = document.body.innerText.match(/LATP\\d+/g) || [];
      for (const k of m) if (!(k in window.__lat.text)) window.__lat.text[k] = performance.timeOrigin + performance.now();
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
    const orig = window.fetch;
    window.fetch = function (u, o) { if (String(u).includes('/api/scenes/')) window.__lat.fetchAt = performance.timeOrigin + performance.now(); return orig.apply(this, arguments); };
    return true;
  })()`);
  const rows = [];
  for (let k = 0; k < 6; k++) {
    const scene = await (await fetch(`${RIG}/api/scenes/${SID}`, { cache: 'no-store' })).json();
    const text = scene.layers.find((l) => l.type === 'text');
    const marker = 'LATP' + k;
    text.props.text = marker;
    const t0 = Date.now();
    const r = await fetch(`${RIG}/api/scenes/${SID}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scene, expect_rev: scene.rev }) });
    const t1 = Date.now();
    await r.json();
    let shown = 0;
    for (let i = 0; i < 300 && !shown; i++) { const v = await ev(`window.__lat.text[${JSON.stringify(marker)}] || 0`); if (v) shown = v; else await sleep(5); }
    const fetchAt = await ev(`window.__lat.fetchAt || 0`);
    rows.push({ save: t1 - t0, feedToFetch: fetchAt ? Math.round(fetchAt - t1) : -1, fetchToShown: fetchAt && shown ? Math.round(shown - fetchAt) : -1, total: shown ? Math.round(shown - t0) : -1 });
    await sleep(700);
  }
  console.log('ms per edit: save round trip | save done -> output fetches the scene | fetch -> text shown | total');
  for (const x of rows) console.log(`  ${String(x.save).padStart(5)} | ${String(x.feedToFetch).padStart(5)} | ${String(x.fetchToShown).padStart(5)} | ${String(x.total).padStart(5)}`);
  process.exit(0);
})().catch((e) => { console.log('ERROR ' + e.message); process.exit(1); });
