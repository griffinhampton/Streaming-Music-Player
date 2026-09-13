// Are the scrollbars ours, on every page that scrolls?
//   node scrollprobe.js <devtools port> [rig port]
//
// Chrome draws its own Windows scrollbar at 15-17 px with arrow buttons;
// base.css asks for 10 px. So the width tells the two apart, and a synthetic
// overflow:scroll element measures it whether or not the page happens to have
// enough content to overflow right now.
//
// It also checks --fg resolves on each page: base.css paints the thumb with
// color-mix(... var(--fg) ...), and on a page that never defines --fg at :root
// the whole declaration is invalid and the thumb quietly reverts to default.
const [port, rigPort = '8799'] = process.argv.slice(2);
const RIG = `http://127.0.0.1:${rigPort}`;
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 120000).unref();

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
    if (m.method === 'Runtime.exceptionThrown') page.errors.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n')[0]);
  };
  page.send = (method, params = {}) => new Promise((r) => { const i = ++page.id; page.pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  page.ev = async (expression) => {
    const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result.result.value;
  };
  await page.send('Runtime.enable');
  return page;
}

const PROBE = `(() => {
  const d = document.createElement('div');
  d.style.cssText = 'position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll';
  document.body.appendChild(d);
  const w = d.offsetWidth - d.clientWidth;
  d.remove();
  const fg = getComputedStyle(document.documentElement).getPropertyValue('--fg').trim();
  const sheets = [...document.styleSheets].map((s) => (s.href || '').split('/').pop()).filter(Boolean);
  return { w, fg, sheets };
})()`;

const PAGES = [
  ['the deck', '/deck.html'],
  ['the Canvas Builder', '/canvas.html'],
  ['the scene remote', '/remote.html'],
];

(async () => {
  for (const [name, path] of PAGES) {
    const page = await open(RIG + path);
    let got = null;
    for (let i = 0; i < 40 && !got; i++) {
      await sleep(150);
      try { got = await page.ev(PROBE); } catch (_) { /* still loading */ }
    }
    if (!got) { check(`${name}: loads`, false, 'no answer'); continue; }
    check(`${name}: base.css is linked`, got.sheets.includes('base.css'), got.sheets.join(' '));
    check(`${name}: the scrollbar is ours, not Windows'`, got.w === 10, `${got.w}px wide (ours is 10, Chrome's own is 15-17)`);
    check(`${name}: --fg resolves, so the thumb is painted`, !!got.fg, got.fg || 'empty - color-mix would be invalid');
    check(`${name}: nothing thrown`, page.errors.length === 0, page.errors.slice(0, 2).join(' | '));
  }
  const bad = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - bad} of ${results.length} passed`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('THREW ' + e.message); process.exit(2); });
