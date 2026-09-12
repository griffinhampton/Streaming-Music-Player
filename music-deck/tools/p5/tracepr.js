// What keeps an idle page busy: a DevTools timeline trace of N seconds,
// counted by event, with timers, event handlers and frame callbacks named by
// their script and line.   node tracepr.js <port> <url substring> [seconds]
const [port, match, secs = '10'] = process.argv.slice(2);
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, (Number(secs) + 30) * 1000).unref();
(async () => {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find(p => p.type === 'page' && p.url.includes(match));
  if (!page) { console.log('NO PAGE'); process.exit(2); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map(); const events = []; let done;
  const finished = new Promise(r => done = r);
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === 'Tracing.dataCollected') events.push(...m.params.value);
    else if (m.method === 'Tracing.tracingComplete') done();
  };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' });
  await new Promise(r => setTimeout(r, Number(secs) * 1000));
  await send('Tracing.end');
  await finished;
  const counts = {}, callers = {};
  let paintMs = 0, layoutMs = 0, styleMs = 0, compMs = 0;
  for (const ev of events) {
    if (ev.ph !== 'X' && ev.ph !== 'B' && ev.ph !== 'I' && ev.ph !== 'i') continue;
    counts[ev.name] = (counts[ev.name] || 0) + 1;
    const ms = (ev.dur || 0) / 1000;
    if (ev.name === 'Paint') paintMs += ms;
    if (ev.name === 'Layout') layoutMs += ms;
    if (ev.name === 'UpdateLayoutTree' || ev.name === 'RecalculateStyles') styleMs += ms;
    if (ev.name === 'CompositeLayers' || ev.name === 'UpdateLayerTree') compMs += ms;
    const d = (ev.args && ev.args.data) || {};
    if (['TimerFire', 'FireAnimationFrame', 'EventDispatch', 'FunctionCall', 'XHRReadyStateChange'].includes(ev.name)) {
      const where = ev.name + ' ' + (d.type || '') + ' ' + ((d.url || d.scriptName || '').split('/').pop() || '?') + ':' + (d.lineNumber ?? '');
      callers[where] = (callers[where] || 0) + 1;
    }
  }
  const top = o => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 18).map(([k, v]) => `${String(v).padStart(5)}  ${k}`).join('\n');
  console.log(`trace of ${page.url.replace(/^https?:\/\/[^/]+/, '')}, ${secs} s`);
  console.log(`paint ${paintMs.toFixed(0)} ms, layout ${layoutMs.toFixed(0)} ms, style ${styleMs.toFixed(0)} ms, layer tree/composite ${compMs.toFixed(0)} ms`);
  console.log('events:\n' + top(Object.fromEntries(Object.entries(counts).filter(([k]) => /Paint|Layout|Style|Composite|Timer|Animation|Event|Function|Frame|Raster|Commit/.test(k)))));
  console.log('who runs:\n' + top(callers));
  ws.close();
})().catch(e => { console.log('ERROR ' + e.message); process.exit(1); });
