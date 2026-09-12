// What a page costs Chrome's renderer while it sits idle, and why.
//   node perfprobe.js <port> <url substring> [seconds]
// Performance.getMetrics before/after (task, script, layout, style time),
// frames produced, and the animations running in the page and in every
// same-origin iframe.
const [port, match, secs = '10'] = process.argv.slice(2);
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, (Number(secs) + 20) * 1000).unref();
(async () => {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find(p => p.type === 'page' && (p.url.includes(match) || p.title.includes(match)));
  if (!page) { console.log('NO PAGE: ' + list.map(p => p.url).join(' | ')); process.exit(2); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const metrics = async () => Object.fromEntries((await send('Performance.getMetrics')).result.metrics.map(m => [m.name, m.value]));
  await send('Performance.enable', { timeDomain: 'threadTicks' });
  const a = await metrics();
  await new Promise(r => setTimeout(r, Number(secs) * 1000));
  const b = await metrics();
  const d = k => (b[k] || 0) - (a[k] || 0);
  const pct = k => (100 * d(k) / Number(secs)).toFixed(2) + '%';
  const anims = await send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
    const out = [];
    const scan = (doc, where) => { try { for (const x of doc.getAnimations()) out.push(where + ': ' + (x.animationName || x.constructor.name) + ' [' + x.playState + '] on ' + String((x.effect && x.effect.target && (x.effect.target.id || x.effect.target.className)) || '?').slice(0, 30)); } catch (e) { out.push(where + ': cannot read (' + e.message + ')'); } };
    scan(document, 'top');
    document.querySelectorAll('iframe').forEach((f, i) => { try { scan(f.contentDocument, 'iframe ' + i + ' ' + (f.getAttribute('src') || '').slice(0, 40)); } catch (e) { out.push('iframe ' + i + ': cross-origin'); } });
    return { iframes: document.querySelectorAll('iframe').length, animations: out };
  })()` });
  console.log(JSON.stringify({
    page: page.url.replace(/^https?:\/\/[^/]+/, ''),
    seconds: Number(secs),
    renderer_main_thread: pct('TaskDuration'), script: pct('ScriptDuration'), layout: pct('LayoutDuration'),
    style: pct('RecalcStyleDuration'), layouts: d('LayoutCount'), style_recalcs: d('RecalcStyleCount'),
    frames: d('Frames'), ...anims.result.result.value
  }, null, 1));
  ws.close();
})().catch(e => { console.log('ERROR ' + e.message); process.exit(1); });
