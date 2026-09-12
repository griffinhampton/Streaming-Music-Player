// P6 deck tests in headless Chrome (no window on any monitor):
//   node p6test.js <port> <label> <outdir>
// Screenshots the components row at 1400 and 700 px, collects console errors,
// and drives the deck with every window-changing request intercepted (open,
// close, snap, heal, apply, the Canvas Builder window, LIVE start/stop) so no
// real window opens or moves - the test checks the deck asks for the right one.
const fs = require('fs');
const path = require('path');
const [port, label, outdir] = process.argv.slice(2);
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 120000).unref();
const results = [];
const check = (name, ok, detail = '') => { results.push([name, !!ok]); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? `  (${detail})` : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INTERCEPT = /\/api\/(window|lyrics\/window|queue\/window|captions\/window|components\/[^/]+)\/(open|close|snap|heal|apply|rebuild|minimize|restore)$|\/api\/canvas\/editor\/open$|\/api\/live\/(start|stop)$/;

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((p) => p.type === 'page' && p.url.includes('deck.html'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const errors = [];
  const asked = [];
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  ws.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n')[0]);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error: ' + m.params.args.map((a) => a.value || a.description).join(' ').slice(0, 160));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon/.test(m.params.entry.url || '')) errors.push('log: ' + m.params.entry.text.slice(0, 160));
    if (m.method === 'Fetch.requestPaused') {
      // Only what would open, move or resize a real window (or start a
      // stream) is answered here; everything else goes to the rig.
      const u = new URL(m.params.request.url);
      if (m.params.request.method === 'POST' && INTERCEPT.test(u.pathname)) {
        asked.push(`${m.params.request.method} ${u.pathname}` + (m.params.request.postData ? ' ' + m.params.request.postData : ''));
        const body = Buffer.from(JSON.stringify({ ok: true, hosted: true, state: 'ok' })).toString('base64');
        send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, body,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }] });
      } else {
        send('Fetch.continueRequest', { requestId: m.params.requestId });
      }
    }
  };
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || ''));
    return r.result.result.value;
  };
  const click = (sel) => ev(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return false; n.click(); return true; })()`);
  const shot = async (name, width) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(900);
    await ev(`(() => { const b = document.getElementById('windowsBar'); b.style.scrollBehavior = 'auto'; b.scrollLeft = 0; b.style.scrollBehavior = ''; updateStrip(); })()`);
    await sleep(300);
    const box = await ev(`(() => { const r = document.getElementById('compStrip').getBoundingClientRect(); const t = document.querySelector('.topbar').getBoundingClientRect(); return { y: 0, h: Math.ceil(r.bottom + 8) }; })()`);
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height: box.h, scale: 1 } });
    const file = path.join(outdir, `p6_${label}_${width}.png`);
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    return file;
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  await sleep(4500);
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
  await sleep(1500);

  const row = await ev(`(() => ({
    groups: [...document.querySelectorAll('#windowsBar .wc-group')].map((g) => g.dataset.group + ':' + g.querySelectorAll('.wincard').length),
    cards: document.querySelectorAll('#windowsBar .wincard').length,
    ids: ['npToggle','lyToggle','qToggle','capToggle','npStatus','capSize'].every((i) => !!document.getElementById(i)),
    frameCards: [...document.querySelectorAll('.wincard[data-win]')].map((c) => c.dataset.win).filter((w) => w.includes('frame')),
  }))()`);
  check('the row is drawn from the registry, in groups', row.groups.length >= 2 && row.groups[0].startsWith('music:4'), JSON.stringify(row.groups));
  check('the four music cards keep the ids the deck binds to', row.ids);
  check('both frames have a card', row.frameCards.length === 2, row.frameCards.join(','));
  console.log('   cards in the row:', row.cards);

  const s1400 = await shot('row', 1400);
  const s700 = await shot('row', 700);
  console.log('   screenshots:', s1400, s700);
  if (row.groups.some((g) => g === 'canvas:0') === false) {
    // The Canvas group sits past the right edge: bring it in and shoot it too.
    await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    await ev(`(() => { const b = document.getElementById('windowsBar'); b.style.scrollBehavior = 'auto'; b.scrollLeft = b.scrollWidth; updateStrip(); })()`);
    await sleep(400);
    const h = await ev(`Math.ceil(document.getElementById('compStrip').getBoundingClientRect().bottom + 8)`);
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1400, height: h, scale: 1 } });
    const file = path.join(outdir, `p6_${label}_1400_canvas.png`);
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    console.log('   canvas group:', file);
    await ev(`(() => { const b = document.getElementById('windowsBar'); b.scrollLeft = 0; b.style.scrollBehavior = ''; })()`);
    await send('Emulation.setDeviceMetricsOverride', { width: 700, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
  }
  const strip700 = await ev(`(() => { const b = document.getElementById('windowsBar'); return { overflow: b.scrollWidth > b.clientWidth, next: document.getElementById('compStrip').classList.contains('can-next') }; })()`);
  if (strip700.overflow) {
    check('at 700 px the strip shows it has more', strip700.next);
    const before = await ev(`document.getElementById('windowsBar').scrollLeft`);
    await click('#stripNext');
    await sleep(700);
    const after = await ev(`document.getElementById('windowsBar').scrollLeft`);
    check('the arrow pages the strip', after > before, `${before} -> ${after}`);
    await ev(`(() => { const b = document.getElementById('windowsBar'); b.style.scrollBehavior = 'auto'; b.scrollLeft = 0; })()`);
    await ev(`document.getElementById('windowsBar').dispatchEvent(new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true }))`);
    await sleep(300);
    const wheeled = await ev(`document.getElementById('windowsBar').scrollLeft`);
    check('the wheel scrolls it sideways', wheeled > 0, `scrollLeft ${wheeled}`);
    await ev(`(() => { const b = document.getElementById('windowsBar'); b.scrollLeft = 0; b.style.scrollBehavior = ''; const cards = b.querySelectorAll('.wincard'); cards[cards.length - 1].querySelector('button, [tabindex]') ? (cards[cards.length - 1].hasAttribute('tabindex') ? cards[cards.length - 1] : cards[cards.length - 1].querySelector('button')).focus() : 0; })()`);
    let focusIn = false;
    for (let k = 0; k < 15 && !focusIn; k++) {
      await sleep(100);
      focusIn = await ev(`(() => { const b = document.getElementById('windowsBar').getBoundingClientRect(); const a = document.activeElement.closest('.wincard').getBoundingClientRect(); return a.left >= b.left - 1 && a.right <= b.right + 1; })()`);
    }
    const where = await ev(`(() => { const bar = document.getElementById('windowsBar'); const b = bar.getBoundingClientRect(); const c = document.activeElement.closest('.wincard'); const a = c ? c.getBoundingClientRect() : { left: -1, right: -1 };
      return 'active ' + (c ? (c.dataset.win || c.dataset.scene) : document.activeElement.tagName) + ' ' + Math.round(a.left) + '..' + Math.round(a.right) + ' in ' + Math.round(b.left) + '..' + Math.round(b.right) + ', scrollLeft ' + Math.round(bar.scrollLeft) + ' of ' + (bar.scrollWidth - bar.clientWidth); })()`);
    check('a focused card scrolls into view', focusIn, where);
  } else {
    console.log('   (the row fits at 700 px - nothing to scroll)');
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(500);

  // The four music windows: open, close, snap and heal ask for the right window.
  asked.length = 0;
  for (const t of ['npToggle', 'lyToggle', 'qToggle', 'capToggle']) { await click('#' + t); await sleep(250); }
  // Marked open and clicked in one go: a snapshot in between would say "closed" again.
  await ev(`(() => { npOpen = true; lyOpen = true; qOpen = true; capOpen = true;
    for (const t of ['npToggle', 'lyToggle', 'qToggle', 'capToggle']) document.getElementById(t).click(); })()`);
  await sleep(600);
  await ev(`(() => { npOpen = true; lyOpen = true; qOpen = true; capOpen = true; healWindows(); })()`);
  await sleep(400);
  for (const sel of ['#snap button[data-c="tl"]', '#lySnap button[data-c="tr"]', '#qSnap button[data-c="bl"]', '#capSnap button[data-c="br"]']) { await click(sel); await sleep(200); }
  const has = (re) => asked.some((a) => re.test(a));
  check('open asks for each of the four', has(/POST \/api\/window\/open/) && has(/lyrics\/window\/open/) && has(/queue\/window\/open/) && has(/captions\/window\/open/), asked.filter((a) => /open/.test(a)).length + ' opens');
  check('close asks for each of the four', has(/POST \/api\/window\/close/) && has(/lyrics\/window\/close/) && has(/queue\/window\/close/) && has(/captions\/window\/close/));
  check('heal asks for each open window', has(/\/api\/window\/heal/) && has(/lyrics\/window\/heal/) && has(/queue\/window\/heal/) && has(/captions\/window\/heal/));
  check('snap asks for each window', has(/\/api\/window\/snap/) && has(/lyrics\/window\/snap/) && has(/queue\/window\/snap/) && has(/captions\/window\/snap/));

  // A frame: its card selects it, the preview becomes the frame, its tabs show.
  await ev(`(() => { npOpen = false; lyOpen = false; qOpen = false; capOpen = false; })()`);
  await click('.wincard[data-win="screenframe"]');
  await sleep(1200);
  const fr = await ev(`(() => ({
    src: document.getElementById('preview') ? document.getElementById('preview').getAttribute('src') : (document.querySelector('iframe') || {}).src,
    tabs: [...document.querySelectorAll('#designTabs button')].filter((b) => !b.hidden).map((b) => b.textContent.trim()),
    name: document.getElementById('designingName').textContent,
  }))()`);
  check('picking the Screen frame previews the frame page', /frame\.html\?kind=screen&preview=1/.test(fr.src || ''), fr.src);
  check('and offers only the frame tabs', fr.tabs.join('|') === 'Frame|Loop|Badges & title|Size', fr.tabs.join('|'));
  await click('[data-pane="frame"] [data-fr="frame.border.style"] button[data-v="glow"]');
  await sleep(600);
  const cfgNow = await (await fetch(`http://127.0.0.1:${process.env.RIG_PORT || 8799}/api/config`)).json();
  check('a frame setting saves to that frame', (cfgNow.screenframe || {}).frame && cfgNow.screenframe.frame.border.style === 'glow', JSON.stringify((cfgNow.screenframe || {}).frame?.border));
  asked.length = 0;
  await click('.wincard[data-win="camframe"] button[data-act="toggle"]');
  await sleep(400);
  check('a frame card opens its window by the registry route', has(/POST \/api\/components\/camframe\/open/), asked.join(' | '));

  // Scene cards and the LIVE strip.
  const scenes = await ev(`document.querySelectorAll('.wincard.scene').length`);
  if (scenes) {
    asked.length = 0;
    await click('.wincard.scene [data-act="scene-open"]');
    await sleep(300);
    await click('.wincard.scene [data-act="scene-edit"]');
    await sleep(300);
    check('a scene card opens its output and the editor', has(/POST \/api\/components\/scene%3A[^/]+\/open/) && has(/canvas\/editor\/open .*scene/), asked.join(' | '));
  }
  const ls = await ev(`(() => ({ text: document.getElementById('liveState').textContent, go: document.getElementById('liveGo').textContent, disabled: document.getElementById('liveGo').disabled, options: document.getElementById('liveScene').options.length }))()`);
  check('the LIVE strip says off air, and Start waits for a stream key', ls.text === 'Off air' && ls.go === 'Start' && ls.disabled, JSON.stringify(ls));
  await ev(`paintLive({ live: { state: 'live', has_key: true }, scenes: rowScenes, canvas: { live: rowLive } })`);
  const lv = await ev(`({ text: document.getElementById('liveState').textContent, go: document.getElementById('liveGo').textContent, state: document.getElementById('liveStrip').dataset.state })`);
  asked.length = 0;
  await click('#liveGo');
  await sleep(300);
  check('live, it shows LIVE and Stop asks to stop', lv.state === 'live' && lv.go === 'Stop' && has(/POST \/api\/live\/stop/), JSON.stringify(lv) + ' ' + asked.join('|'));
  await ev(`paintLive({ live: { state: 'idle', has_key: false }, scenes: rowScenes, canvas: { live: rowLive } })`);
  asked.length = 0;
  await click('#canvasBtn');
  await sleep(300);
  check('the Canvas Builder button asks for its window', has(/POST \/api\/canvas\/editor\/open/), asked.join(' | '));

  await sleep(500);
  check('no console errors', errors.length === 0, errors.slice(0, 5).join(' || '));
  const failed = results.filter(([, ok]) => !ok).map(([n]) => n);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed` + (failed.length ? '; FAILED: ' + failed.join('; ') : ''));
  ws.close();
  process.exit(0);
})().catch((e) => { console.log('ERROR ' + e.message); process.exit(1); });
