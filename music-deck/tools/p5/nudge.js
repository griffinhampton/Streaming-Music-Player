// One synthetic pointer move into a page: node nudge.js <port> <url substring>
const [port, match] = process.argv.slice(2);
setTimeout(() => process.exit(3), 10000).unref();
(async () => {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find(p => p.type === 'page' && p.url.includes(match));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0;
  const send = (method, params) => new Promise(r => { const i = ++id; ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id === i) r(m); }; ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 300, y: 300 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 320, y: 310 });
  console.log('pointer moved');
  ws.close();
})().catch(e => { console.log('nudge error ' + e.message); process.exit(1); });
