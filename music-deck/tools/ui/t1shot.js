// T1 seen, not just tested.
//
//   node t1shot.js <devtools port> [rig port] [outdir]
//
// The panels changed here live in liveview.html, not the deck - cmdpanel.js
// and pollpanel.js are loaded by that page and opened from its buttons. Shot
// at 1280x880, which is the size launch_deck opens the Live view at: a UI
// review at any other size is a review of a layout nobody gets.
//
// It measures as well as photographs, because a screenshot cannot tell you
// whether the label follows the setting. The symbol is changed through the
// real API half way through and the labels are read again.
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
  await p.send('Page.enable');
  return p;
}

const READ = `(() => {
  const cp = document.getElementById('cmdPanel');
  const field = cp && cp.querySelector('[data-cmd="symbol"]');
  const legend = cp && cp.querySelector('.cmd-row legend');
  const hint = document.querySelector('[data-poll="votehint"]');
  const r = field ? field.getBoundingClientRect() : null;
  return {
    field: !!field,
    value: field ? field.value : '',
    width: r ? Math.round(r.width) : 0,
    height: r ? Math.round(r.height) : 0,
    legend: legend ? legend.textContent.trim() : '',
    hint: hint ? hint.textContent.replace(/\\s+/g, ' ').trim() : '',
  };
})()`;

const save = (symbol) => `(async () => {
  const r = await fetch('/api/commands/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands: [{ name: 'gif', action: 'say', response: 'hi' }], symbol: ${J(symbol)} }),
  });
  return (await r.json()).symbol;
})()`;

(async () => {
  const page = await open(`${RIG}/liveview.html`);
  // The Live view opens at 1280x880. Anything else reviews a layout nobody has.
  await page.send('Emulation.setDeviceMetricsOverride',
    { width: 1280, height: 880, deviceScaleFactor: 1, mobile: false });
  await sleep(3500);

  await page.ev(`(async () => { await fetch('/api/commands/save', { method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ commands:[{name:'gif',action:'say',response:'hi'}], symbol:'!' }) }); })()`);

  await page.ev(`CmdPanel.open(document.getElementById('lvCmds'))`);
  await page.ev(`PollPanel.open(document.getElementById('lvPoll'))`);
  await sleep(1500);

  const before = await page.ev(READ);
  check('the symbol field is on screen', before.field, J(before));
  check('and it is a usable size, not a sliver',
    before.width >= 40 && before.height >= 20, `${before.width}x${before.height}`);
  check('it shows the symbol in force', before.value === '!', J(before.value));
  check('the row legend is built from it', before.legend === '!gif', J(before.legend));
  check('and the poll hint names it', /!1/.test(before.hint) && !/\/1/.test(before.hint), J(before.hint));

  if (outDir) {
    await page.ev('PollPanel.close()');
    const shot = (await page.send('Page.captureScreenshot', { format: 'png' })).result.data;
    fs.writeFileSync(`${outDir}/t1-symbol-bang.png`, Buffer.from(shot, 'base64'));
    console.log('   wrote t1-symbol-bang.png');
  }

  // The half a screenshot cannot show: does the label follow the setting?
  const kept = await page.ev(save('/'));
  check('the API accepted the new symbol', kept === '/', J(kept));
  await page.ev(`CmdPanel.close(); PollPanel.close();`);
  await page.ev(`CmdPanel.open(document.getElementById('lvCmds'))`);
  await page.ev(`PollPanel.open(document.getElementById('lvPoll'))`);
  await sleep(2500);

  const after = await page.ev(READ);
  check('the field followed', after.value === '/', J(after.value));
  check('the legend followed', after.legend === '/gif', J(after.legend));
  check('the poll hint followed, and stopped saying !1',
    /\/1/.test(after.hint) && !/!1/.test(after.hint), J(after.hint));

  if (outDir) {
    await page.ev('PollPanel.close()');
    const shot = (await page.send('Page.captureScreenshot', { format: 'png' })).result.data;
    fs.writeFileSync(`${outDir}/t1-symbol-slash.png`, Buffer.from(shot, 'base64'));
    console.log('   wrote t1-symbol-slash.png');
  }

  check('nothing was thrown in the Live view', page.errors.length === 0, page.errors.slice(0, 2).join(' | '));

  // Put the rig back exactly as it was found.
  await page.ev(`(async () => { await fetch('/api/commands/save', { method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ commands: [], symbol: '!' }) }); })()`);
  const restored = await page.ev(`(async () => (await (await fetch('/api/commands')).json()).symbol)()`);
  check('the rig was put back', restored === '!', J(restored));

  try { page.ws.close(); } catch (_) {}
  await fetch(`http://127.0.0.1:${port}/json/close/${page.targetId}`).catch(() => {});

  const bad = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - bad} of ${results.length} passed`);
  // exitCode and a natural exit, not process.exit(). The same teardown as
  // onstream.js and fxsound.js, which do not crash - but this one reliably
  // tripped libuv's UV_HANDLE_CLOSING assertion, exiting 127 after printing
  // 11 of 11. A registered probe that always exits non-zero makes uirun.sh
  // all permanently red, which is how a suite stops being read. Letting the
  // loop drain costs a few milliseconds and the socket closes properly.
  process.exitCode = bad ? 1 : 0;
})().catch((e) => { console.log('THREW ' + e.message); process.exit(2); });
