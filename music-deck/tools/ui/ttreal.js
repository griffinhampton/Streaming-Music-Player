// The TikTok reader, against one real public TikTok LIVE - counts only.
//
//   node ttreal.js <devtools port>
//
// Not part of `uirun.sh all`, and run by hand: it goes to tiktok.com. The
// reader follows TikTok's page, which TikTok changes when it likes; this is
// the one command that says whether it still does. Start a Chrome of your own
// for it - headless, muted, with a throwaway profile, never your own - then:
//
//   chrome --headless=new --mute-audio --remote-debugging-port=9452 \
//          --user-data-dir=<a scratch folder> about:blank
//
// It takes OBSERVER out of tiktok_chat.py exactly as it ships, injects it into
// a public live room found on the LIVE feed with a stub where the app's binding
// would be, and runs it twice, 35 s each, in fresh tabs:
//   A  as shipped (it pauses the video, to save this PC the decoding)
//   B  with only the pause removed - so if A sees no chat and B does, the
//      pause is what stopped it
// Then it reports numbers: lines on screen, lines handed over, how many had
// both a name and words, how many a profile link, what the page says about
// being signed in. Never a name, a message or an avatar. A verification or
// login wall stops it; it does not try to get around one.
//
// The profile is signed out, so the reader must say so: a page that reads as
// signed in here is a Log in button the reader no longer recognizes.
//
// Its first runs, 2026-09-15: A handed over 25 lines, B 29, every one with a
// name and words; the page holds 20 at a time; no line had a profile link. The
// second run's room drew its Log in button without the id the first one had,
// and the page read as signed in - which is why that is now a verdict here.
const fs = require('fs');
const path = require('path');
const [port] = process.argv.slice(2);
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 200000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

const py = fs.readFileSync(path.resolve(__dirname, '..', '..', 'tiktok_chat.py'), 'utf8');
const found = py.match(/OBSERVER = r"""([\s\S]*?)"""/);
if (!found) { console.log('could not find OBSERVER in tiktok_chat.py'); process.exit(2); }
const SHIPPED = found[1];
const PAUSE = 'if (!v.paused) v.pause();';
if (!SHIPPED.includes(PAUSE)) { console.log('the pause line was not found - pass B would be identical'); process.exit(2); }
const NOPAUSE = SHIPPED.replace(PAUSE, '');
const STUB = 'window.__got = []; window.__asdTikTok = (s) => window.__got.push(s);';

async function tab() {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const x = JSON.parse(e.data); if (x.id && pending.has(x.id)) { pending.get(x.id)(x); pending.delete(x.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(J({ id: i, method, params })); });
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.result.result.value; };
  await send('Runtime.enable'); await send('Page.enable');
  return { send, ev, close: async () => { try { ws.close(); } catch (_) {} await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {}); } };
}

const COUNTS = `(() => {
  const got = (window.__got || []).map((s) => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
  const chats = got.filter((g) => g.t === 'chat');
  const status = got.filter((g) => g.t === 'status').pop() || null;
  return { onScreen: document.querySelectorAll('[data-e2e="chat-message"]').length, handedOver: chats.length,
    withNameAndWords: chats.filter((c) => c.name && c.text).length, withProfileLink: chats.filter((c) => c.login).length,
    status: status && { room: status.room, signedIn: status.signedIn },
    videoPaused: [...document.querySelectorAll('video')].every((v) => v.paused),
    wall: !!document.querySelector('iframe[src*="captcha"], #captcha-verify-image') };
})()`;

async function pass(label, room, observer) {
  const p = await tab();
  await p.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await p.send('Page.addScriptToEvaluateOnNewDocument', { source: observer });
  await p.send('Page.navigate', { url: room });
  const samples = [];
  for (let i = 0; i < 7; i++) { await sleep(5000); samples.push(await p.ev(`document.querySelectorAll('[data-e2e="chat-message"]').length`)); }
  const c = await p.ev(COUNTS);
  await p.close();
  console.log(label, J({ linesOnScreenEvery5s: samples, ...c }));
  return c;
}

(async () => {
  const p = await tab();
  await p.send('Page.navigate', { url: 'https://www.tiktok.com/live' });
  let room = '';
  for (let i = 0; i < 20 && !room; i++) {
    await sleep(2000);
    room = await p.ev(`(() => { const a = [...document.querySelectorAll('a[href*="/live"]')].map((a) => a.href).find((h) => /tiktok\\.com\\/@[^/]+\\/live/.test(h)); return a || ''; })()`);
  }
  await p.close();
  if (!room) { console.log('no live room link found in 40 s - try again'); process.exit(0); }
  const a = await pass('A (as shipped):     ', room, SHIPPED);
  if (a.wall) { console.log('a verification wall - stopping'); process.exit(0); }
  const b = await pass('B (video playing):  ', room, NOPAUSE);
  const reads = a.handedOver > 0 && a.withNameAndWords === a.handedOver;
  console.log(reads ? '\nthe reader reads TikTok\'s real page' : a.handedOver === 0 && b.handedOver === 0
    ? '\nno lines in either pass - a quiet room, or the reader no longer finds the chat: run it again on another room'
    : '\nthe reader does NOT read TikTok\'s real page correctly - it needs updating');
  const out = a.status && a.status.signedIn === false;
  console.log(out ? 'and it says this signed-out page is signed out'
    : 'and it calls this signed-out page signed in - its Log in check needs updating');
  process.exit(reads && out ? 0 : 1);
})().catch((e) => { console.log('THREW ' + e.message); process.exit(2); });
