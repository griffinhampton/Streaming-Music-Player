// Does traffic that nothing draws still force a whole-state broadcast?
//
//     node keyleak.js <unused cdp port> <rig port>
//
// The Hub sends the whole state only when _change_key(snapshot) differs, or
// every HEARTBEAT (2.0 s). That gate is the reason the app does not send
// 2.5 times a second for nothing. It is also easy to defeat by accident: any
// counter that climbs on its own, sitting anywhere in the snapshot, makes the
// key differ every time and puts the flood straight back.
//
// It had been defeated. chat.py put `total` - a count of every message ever -
// into the snapshot it hands the feed, so a busy chat took the rig from one
// send per 2.00 s to one per 0.41 s, five times the traffic, for a number no
// page displays. alerts.total, alerts.dropped, commands.ran and
// commands.refused are the same shape. server.py's _change_key drops them
// from the key now, the way it already drops captions.level: still sent,
// never a reason to send.
//
// Three phases, because two would not tell you which thing did it:
//   idle              nothing happening
//   connected + busy  a message every 250 ms
//   connected + quiet still joined, saying nothing   <- separates "messages
//                     did it" from "connecting did it"
//
// Before those three, a wider guard. Fixing chat.total fixed chat; it did not
// stop the next counter being added to any of the other thirty-four fields in
// the payload. So the first check samples /api/state every 2 s with the app
// sitting still, takes out exactly what _change_key takes out, and insists
// that nothing else moved at all. Measured by hand first, at 2 s for 30 s:
// across all 34 remaining fields, nothing moves at rest.
//
// What it does not cover, said plainly: Spotify's poller only runs while the
// queue window is open (spotify_api.py:82), and opening it would put real
// calls on the user's account, so drift under Spotify polling is untested.
//
// No browser: HUB.sends is on /api/debug/mem and counts with no subscribers.
// uirun.sh starts Chrome anyway, at about:blank, which touches nothing here.
const net = require('net');
const http = require('http');

const HOST = '127.0.0.1';
const RIGPORT = Number(process.argv[3] || 8799);
const IRC = 6667;
const WINDOW = 10000;                 // each phase, in ms
const GAP = 250;                      // between fake messages
const HEARTBEAT = 2.0;                // server.py Hub.HEARTBEAT

// A payload with what server.py's _change_key strips taken out of it. The
// nested fields, not the objects around them: dropping all of `spotify` or all
// of `captions` would leave a sixth of the payload unguarded, and that is
// exactly where the next counter would land unseen.
function atRest(s) {
  const o = JSON.parse(JSON.stringify(s));
  delete o.server_time;                                  // the clock
  for (const k of ['now', 'local', 'spotify']) {
    if (o[k] && typeof o[k] === 'object') delete o[k].position;   // a playing position
  }
  if (o.captions && typeof o.captions === 'object') delete o.captions.level;  // the mic meter
  if (o.spotify_queue && typeof o.spotify_queue === 'object') {
    delete o.spotify_queue.age;
    delete o.spotify_queue.retry_in;
  }
  return o;
}

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  (' + detail + ')' : ''}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: HOST, port: RIGPORT, path, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      (res) => {
        let out = '';
        res.on('data', (c) => { out += c; });
        res.on('end', () => { try { resolve(JSON.parse(out)); } catch (_) { resolve({ raw: out }); } });
      });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const get = (p) => req('GET', p);
const post = (p, b) => req('POST', p, b);
const sends = async () => ((await get('/api/debug/mem')).hub || {}).sends;

// A socket that accepts the adapter and answers nothing: CAP, NICK, JOIN and
// PONG are the adapter's own business, as in chatui.js.
let client = null;
const server = net.createServer((sock) => {
  client = sock;
  sock.on('data', () => {});
  sock.on('error', () => {});
});
const privmsg = (who, text) => client
  && client.write(`:${who}!${who}@${who}.tmi.twitch.tv PRIVMSG #somechannel :${text}\r\n`);

async function phase(label, during) {
  const before = await sends();
  const t0 = Date.now();
  await during();
  const secs = (Date.now() - t0) / 1000;
  const n = (await sends()) - before;
  console.log(`     ${label.padEnd(26)} ${String(n).padStart(3)} sends in ${secs.toFixed(1)}s`
    + ` = one per ${(secs / Math.max(n, 1)).toFixed(2)}s`);
  return n;
}

(async () => {
  if (RIGPORT === 8713) throw new Error('that is the real app; this probe is for the rig');
  const cfg = await get('/api/config');
  if (Number(cfg.port) === 8713) throw new Error('the port answered as the real app; stopping');

  await new Promise((r) => server.listen(IRC, HOST, r));
  const patched = await post('/api/debug/chat-endpoint', { host: HOST, port: IRC, tls: false });
  check('the rig lets a test aim the chat adapter at localhost', !!(patched && patched.ok), JSON.stringify(patched));

  // Sampled rather than compared end to end: a field that goes A -> B -> A
  // between two reads looks like it never moved, and a counter that ticks on a
  // timer is exactly the shape that would hide there.
  const drift = await (async (samples, gapMs) => {
    let prev = atRest(await get('/api/state'));
    const moved = new Set();
    for (let i = 0; i < samples; i++) {
      await sleep(gapMs);
      const cur = atRest(await get('/api/state'));
      for (const k of new Set([...Object.keys(prev), ...Object.keys(cur)])) {
        if (JSON.stringify(prev[k]) !== JSON.stringify(cur[k])) moved.add(k);
      }
      prev = cur;
    }
    return { moved: [...moved].sort(), seen: Object.keys(prev).length, samples };
  })(5, 2000);
  // seen > 25 is not decoration: a failed fetch or a shrunken payload would
  // otherwise report "nothing moved" and pass for the worst possible reason.
  check('nothing drifts while the app sits still',
    drift.moved.length === 0 && drift.seen > 25,
    drift.moved.length ? 'moved: ' + drift.moved.join(', ')
      : `${drift.seen} fields across ${drift.samples} samples, none moved`);

  const idle = await phase('idle, no chat', () => sleep(WINDOW));
  const perIdle = WINDOW / 1000 / Math.max(idle, 1);
  check('with nothing happening it sends at the heartbeat',
    Math.abs(perIdle - HEARTBEAT) < 0.6, `one per ${perIdle.toFixed(2)}s, heartbeat ${HEARTBEAT}s`);

  await post('/api/chat/connect', { service: 'twitch', channel: 'somechannel' });
  await sleep(2500);
  const joined = ((await get('/api/chat/status')).services || [])[0] || {};
  check('the adapter joined the test server', joined.state === 'joined', JSON.stringify(joined));

  let sent = 0;
  const busy = await phase('connected, a msg/250ms', async () => {
    const until = Date.now() + WINDOW;
    while (Date.now() < until) { privmsg('tester', 'hello ' + (++sent)); await sleep(GAP); }
  });

  // Without this the whole probe could pass by sending nothing at all, which
  // is the shape of every false all-clear in this repo's history.
  const after = ((await get('/api/chat/status')).services || [])[0] || {};
  check('the messages really arrived (this probe can pass by doing nothing)',
    Number(after.messages) >= sent - 2 && sent > 20, `${after.messages} of ${sent} counted by the adapter`);

  check('chat traffic does not multiply whole-state sends',
    busy <= idle * 1.5, `busy ${busy} vs idle ${idle} in ${WINDOW / 1000}s`);

  const quiet = await phase('connected, saying nothing', () => sleep(WINDOW));
  check('and connected-but-quiet still sits at the heartbeat',
    quiet <= idle * 1.5, `quiet ${quiet} vs idle ${idle}`);

  await post('/api/chat/disconnect', { service: 'twitch' });
  await post('/api/debug/chat-endpoint', {});
  server.close();
  if (client) client.destroy();

  console.log(`\n${pass} of ${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
