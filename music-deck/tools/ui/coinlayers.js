// The coins gifted this stream, on stream: the Coin goal and Top gifters layers.
//
//   node coinlayers.js <devtools port> [rig port]
//
// Gifts come through /api/debug/gift - the rig's own hook - with a handle, so
// their coins go in the ledger first, exactly as a TikTok gift's do
// (server.py tiktok_gift). A scene with both layers is put on air and a stage
// page watches it.
//
// Controls - each thing that must happen has one that must not:
//   the goal and the list follow a gift within a second or two - so it was the
//     gift that woke them, not the ten-second poll
//   the list is in coin order, and hidden while nobody has gifted
//   a name made of markup is drawn as text, and nothing runs
//   reaching the goal says so and cheers, once
//   Stop effects leaves both up - they hold no event
//   a Reset in the Live view brings both back to nothing
//
// It never goes near a stream: the first check is the rig's refusal to go live
// anywhere but this PC, and the probe stops if it is missing.
const [port, rigPort = '8799'] = process.argv.slice(2);
const RIG = `http://127.0.0.1:${rigPort}`;
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 150000).unref();

const results = [];
const check = (n, ok, d = '') => {
  results.push([n, !!ok]);
  console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? `  (${d})` : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const post = (p, body) => fetch(RIG + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: J(body || {}),
}).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const getJ = (p) => fetch(RIG + p, { cache: 'no-store' }).then((r) => r.json());

async function openPage(url) {
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
const closePage = async (p) => {
  try { p.ws.close(); } catch (_) {}
  await fetch(`http://127.0.0.1:${port}/json/close/${p.targetId}`).catch(() => {});
};

const gift = (user, handle, coins) => post('/api/debug/gift', { user, handle, gift: 'Rose', coins });
const LOOK = `(() => {
  const g = document.querySelector('[data-id="goal"]'), t = document.querySelector('[data-id="top"]');
  return {
    title: g && g.querySelector('.goal-title').textContent, num: g && g.querySelector('.goal-num').textContent,
    width: g && g.querySelector('.goal-track > i').style.width, reached: !!g && g.classList.contains('reached'),
    cheer: !!g && g.classList.contains('cheer'),
    rows: t ? [...t.querySelectorAll('.top-rows li')].map((li) => [...li.children].map((s) => s.textContent)) : null,
    listShown: t ? Number(getComputedStyle(t.querySelector('.top-card')).opacity) : null,
    pwned: window.__pwned === undefined ? null : window.__pwned, imgs: document.querySelectorAll('img[src="x"]').length };
})()`;

(async () => {
  // ---------------------------------------------------------- 0. never go live
  const guard = await post('/api/live/start', { url: 'rtmp://example.invalid/live', key: 'x', source: 'page' });
  check('this rig refuses to go live anywhere but this PC (or the probe stops here)',
    guard.ok === false && guard.refused === true, J(guard));
  if (!(guard.ok === false && guard.refused === true)) { console.log('\nnot a guarded rig - stopping'); process.exit(1); }

  await post('/api/gifts/reset', {});
  const sc = (await post('/api/scenes', { name: 'Coin layers probe', format: 'horizontal' })).scene;
  const full = await getJ(`/api/scenes/${sc.id}`);
  const L = (id, type, t, props) => ({ id, name: id, type, visible: true, locked: false, group: '',
    transform: Object.assign({ rotation: 0, anchor: 'tl' }, t), style: { opacity: 1, blend: 'normal', radius: 0 }, props, triggers: [] });
  full.layers = [
    L('goal', 'goal', { x: 100, y: 80, w: 900, h: 140 }, { title: 'Coin goal', target: 1000, done: 'Goal!', size: 30 }),
    L('top', 'topgifters', { x: 100, y: 300, w: 520, h: 320 }, { title: 'Top gifters', count: 3, showcoins: true, hideempty: true, size: 28 }),
  ];
  await post(`/api/scenes/${sc.id}`, { scene: full, expect_rev: full.rev });
  await post('/api/live/scene', { id: sc.id, transition: 'cut' });
  const stage = await openPage(`${RIG}/scene.html?follow=1`);
  await stage.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await stage.send('Page.bringToFront');
  await sleep(3000);

  // ------------------------------------------------------------ 1. nothing yet
  let v = await stage.ev(LOOK);
  check('with nothing gifted, the goal reads 0 of 1,000 and its bar is empty', v.num === '0 / 1,000' && v.width === '0%' && v.title === 'Coin goal', J(v));
  check('and the top gifters list is hidden while nobody has gifted', v.listShown === 0 && v.rows && v.rows.length === 0, J(v));

  // --------------------------------------------------- 2. gifts, in coin order
  const t0 = Date.now();
  await gift('Amy', 'amy', 300);
  await gift('Bob', 'bob', 500);
  let waited = 0;
  for (; waited < 40; waited++) { await sleep(100); v = await stage.ev(LOOK); if (v.num === '800 / 1,000') break; }
  const took = Date.now() - t0;
  check('the goal follows the gifts: 800 of 1,000, the bar at 80%', v.num === '800 / 1,000' && v.width === '80%', J(v));
  check('within a second or two - the gift woke it, not the ten-second read', took < 3000, `${took} ms`);
  await sleep(500);                        // the list fades in over a quarter of a second
  v = await stage.ev(LOOK);
  check('the list shows who gave most, in coin order', J(v.rows) === J([['1', 'Bob', '500'], ['2', 'Amy', '300']]) && v.listShown > 0.9,
    J({ rows: v.rows, shown: v.listShown }));

  // ------------------------------------------------ 3. nothing a name can run
  const EVIL = '<img src=x onerror=window.__pwned=1>';
  await gift(EVIL, 'evil', 100);
  await sleep(1500);
  v = await stage.ev(LOOK);
  check('a name made of markup is drawn as the characters typed', v.rows && v.rows.some((r) => r[1] === EVIL), J(v.rows));
  check('and nothing ran: no flag set, no <img src=x>', v.pwned === null && v.imgs === 0, J({ pwned: v.pwned, imgs: v.imgs }));

  // ------------------------------------------------------ 4. the goal reached
  await gift('Cy', 'cy', 300);
  await sleep(1200);
  v = await stage.ev(LOOK);
  check('past the goal: it says so, the bar is full, and it cheers', v.reached && v.title === 'Goal!' && v.width === '100%' && v.cheer,
    J({ title: v.title, num: v.num, width: v.width, cheer: v.cheer }));
  check('the list keeps only the top three', v.rows && v.rows.length === 3 && v.rows[0][1] === 'Bob', J(v.rows));
  await sleep(3000);
  v = await stage.ev(LOOK);
  check('the cheer is once, not for ever', !v.cheer && v.reached, J({ cheer: v.cheer }));

  // ------------------------------------------------- 5. Stop effects, and Reset
  await post('/api/commands/stop', {});
  await sleep(1000);
  v = await stage.ev(LOOK);
  check('Stop effects leaves both up - they hold no event', v.num === '1,200 / 1,000' && v.rows && v.rows.length === 3, J({ num: v.num, rows: (v.rows || []).length }));
  await post('/api/commands/resume', {});
  await post('/api/gifts/reset', {});
  for (let i = 0; i < 70; i++) { await sleep(250); v = await stage.ev(LOOK); if (v.num === '0 / 1,000') break; }
  check('a Reset brings the goal back to nothing within the regular read', v.num === '0 / 1,000' && !v.reached && v.title === 'Coin goal', J(v));
  await sleep(500);                        // and the list fades out
  v = await stage.ev(LOOK);
  check('and hides the list again', v.rows && v.rows.length === 0 && v.listShown === 0, J(v));
  check('nothing was thrown on the stage', stage.errors.length === 0, stage.errors.slice(0, 2).join(' | '));
  await closePage(stage);

  // -------------------------------------------------- put the rig back as found
  await post('/api/live/scene', { id: '' });
  await post(`/api/scenes/${sc.id}/delete`, {});

  const bad = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - bad} of ${results.length} passed`);
  process.exitCode = bad ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 300);
})().catch((e) => { console.log('THREW ' + e.message); process.exit(2); });
