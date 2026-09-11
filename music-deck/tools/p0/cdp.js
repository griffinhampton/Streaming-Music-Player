// Minimal DevTools driver: node cdp.js <port> <title-substring> <js expression> [gesture]
// Evaluates the expression in the first page whose title/url contains the
// substring, awaiting promises, optionally with a user gesture (transient
// activation - what getDisplayMedia needs). Prints the result as JSON.
const [port, match, expr, gesture] = process.argv.slice(2);
setTimeout(() => { console.log('CDP TIMEOUT (15 s)'); process.exit(3); }, 15000).unref();
(async () => {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  if (expr === '--titles') { for (const p of list.filter(p => p.type === 'page')) console.log(`${p.title}  <${p.url}>`); process.exit(0); }
  const page = list.find(p => p.type === 'page' && (p.title.includes(match) || p.url.includes(match)));
  if (!page) { console.log('NO PAGE; have: ' + list.map(p => `${p.type}:${p.title}`).join(' | ')); process.exit(2); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: gesture === 'gesture' });
  console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.text ?? r));
  ws.close();
})().catch(e => { console.log('CDP ERROR ' + e.message); process.exit(1); });
