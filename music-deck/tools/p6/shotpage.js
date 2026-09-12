// One screenshot of a page in a headless Chrome: node shotpage.js <port> <url> <w> <h> <file>
// Also prints console errors the page threw while it loaded.
const fs = require('fs');
const [port, url, w, h, file] = process.argv.slice(2);
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 30000).unref();
(async () => {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map(); const errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n')[0]);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value || a.description).join(' '));
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: +w, height: +h, deviceScaleFactor: 1, mobile: false });
  await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 3500));
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  console.log(`shot ${file}` + (errors.length ? `; console errors: ${errors.join(' || ')}` : '; no console errors'));
  await send('Page.close');
  ws.close();
  process.exit(0);
})().catch((e) => { console.log('ERROR ' + e.message); process.exit(1); });
