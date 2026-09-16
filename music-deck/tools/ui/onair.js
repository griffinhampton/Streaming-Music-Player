// S9's check: the Live view, driven in a headless Chrome against the rig.
//
//   node onair.js <devtools port> [rig port] [outdir]
//
// Headless, and it opens no output window: this machine has one monitor and
// test windows do not go on it. That shapes what the program monitor can be
// checked against - see "what is on air" below.
//
// The chat half uses S10's fake IRC server, so the message that has to reach
// the docked panel comes off a real socket through the real parser and hub.
//
// Rules carried over from soundpanel.js and chatui.js:
//  * drive the page's own controls, then ask the SERVER what changed;
//  * assert on what was laid out, not only on what a variable holds;
//  * check that what was taken is given back.
const fs = require('fs');
const net = require('net');
const [port, rigPort = '8799', outDir] = process.argv.slice(2);
const RIG = `http://127.0.0.1:${rigPort}`;
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 180000).unref();

const results = [];
const check = (n, ok, d = '') => { results.push([n, !!ok]); console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? `  (${d})` : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const post = (path, body) => fetch(RIG + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: J(body || {}) });
const getJ = (path) => fetch(RIG + path, { cache: 'no-store' }).then((r) => r.json());

async function open(url) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const p = { ws, id: 0, pending: new Map(), errors: [], targetId: t.id };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && p.pending.has(m.id)) { p.pending.get(m.id)(m); p.pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') p.errors.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n')[0]);
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

let client = null;
const server = net.createServer((sock) => { client = sock; sock.on('data', () => {}); sock.on('error', () => {}); });
const privmsg = (who, text, extra = '') =>
  client && client.write(`${extra}:${who}!${who}@${who}.tmi.twitch.tv PRIVMSG #somechannel :${text}\r\n`);

(async () => {
  const beforeCfg = await getJ('/api/config');
  await new Promise((r) => server.listen(6667, '127.0.0.1', r));
  await post('/api/debug/chat-endpoint', { host: '127.0.0.1', port: 6667, tls: false });

  // A scene to switch to, and one to switch from.
  const a = (await (await post('/api/scenes', { name: 'S9 one', format: 'horizontal' })).json()).scene;
  const b = (await (await post('/api/scenes', { name: 'S9 two', format: 'horizontal' })).json()).scene;

  const voiceNow = async () => (await getJ('/api/voice')).source;
  const idle = await voiceNow();
  check('before the view is open, nothing holds the microphone', idle === 'off', idle);

  const lv = await open(`${RIG}/liveview.html`);
  await sleep(4000);

  // ------------------------------------------------------- 1. what is on air
  const prog = await lv.ev('LiveView.program()');
  check('with no output window, it says so instead of showing a broken image',
    prog.none === true && prog.shown === false, J(prog));
  const btn = await lv.ev(`!!document.getElementById('pgOpen')`);
  check('and offers the button that opens it', btn === true, String(btn));

  // The real claim: it does not ask once a second for a picture that 404s.
  await sleep(2500);
  const asked = await lv.ev(`performance.getEntriesByType('resource').filter((r) => r.name.includes('program.png')).length`);
  check('and asks for no picture at all while that window is shut', asked === 0, `${asked} request(s)`);

  // The button must reach the server. Intercepted, so no window opens on a
  // machine with one monitor - what is being checked is that it asks.
  await lv.ev(`(() => {
    window.__reqs = [];
    const f = window.fetch;
    window.fetch = (u, o) => {
      window.__reqs.push(String(u));
      if (String(u).includes('/api/components/live/open')) {
        return Promise.resolve(new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } }));
      }
      return f(u, o);
    };
    return true;
  })()`);
  await lv.ev(`document.getElementById('pgOpen').click()`);
  await sleep(600);
  const reqs = await lv.ev('window.__reqs');
  check('the Open button asks the server for the output window',
    reqs.some((u) => u.includes('/api/components/live/open')), J(reqs.filter((u) => u.includes('components'))));

  // ------------------------------------------------------------- 2. health
  const feedLive = await lv.ev('LiveView.state().live');
  check('the state feed carries no per-second numbers, by design',
    feedLive && feedLive.stats === undefined, J(Object.keys(feedLive || {})));
  const tiles = await lv.ev('LiveView.tiles()');
  check('the six health tiles are all drawn',
    ['uptime', 'kbps', 'fps', 'dropped', 'reconnects', 'delay'].every((k) => k in tiles), J(Object.keys(tiles)));
  const st = await getJ('/api/live/status');
  const s = st.stats || {}, n = st.native || {};
  check('and they agree with /api/live/status, which is where they come from',
    tiles.dropped === String((s.dropped || 0) + (n.dropped || 0)) && tiles.reconnects === String(s.reconnects || 0),
    `${J([tiles.dropped, tiles.reconnects])} vs ${J([(s.dropped || 0) + (n.dropped || 0), s.reconnects || 0])}`);
  check('off air, the numbers say so rather than showing a stale rate',
    tiles.kbps === '-' && tiles.fps === '-', J([tiles.kbps, tiles.fps]));

  // ------------------------------------------------------ 3. the switcher
  const listed = await lv.ev('LiveView.scenes()');
  check('every scene is in the switcher', listed.length >= 2, `${listed.length} scene(s)`);
  await lv.ev(`document.querySelector('#lvScenes .lv-scene[data-id="${a.id}"]').click()`);
  await sleep(1200);
  const onAirNow = ((await getJ('/api/state')).canvas || {}).live;
  check('pressing one puts it on air, on the server', onAirNow === a.id, `${onAirNow} (wanted ${a.id})`);
  const marked = await lv.ev('LiveView.scenes()');
  check('and the view marks it', (marked.find((x) => x.id === a.id) || {}).on === true, J(marked));

  // A switch made anywhere else has to show up here: this one is the API.
  await post('/api/live/scene', { id: b.id, transition: 'cut' });
  await sleep(1400);
  const followed = await lv.ev('LiveView.scenes()');
  check('a switch made elsewhere shows up here too',
    (followed.find((x) => x.id === b.id) || {}).on === true, J(followed));

  // --------------------------------------------------- 4. the docked panels
  const docked = await lv.ev('LiveView.docked()');
  check('the Sound and chat panels are the real ones, docked into the page',
    docked.sound === true && docked.chat === true, J(docked));
  const held = await voiceNow();
  check('the docked Sound panel took the voice lease, so its meter has something to show',
    held === 'monitor', `source ${held} (was ${idle})`);

  // Chat: connected from the docked panel's own field, then a real message.
  await lv.ev(`(() => {
    const i = document.querySelector('#lvChat [data-cp="channel"]');
    i.value = 'SomeChannel';
    document.querySelector('#lvChat [data-cp="go"]').click();
  })()`);
  await sleep(1800);
  const tw = ((await getJ('/api/chat/status')).services || [])[0] || {};
  check('chat connects from inside the view', tw.state === 'joined' && tw.channel === 'somechannel', J(tw));
  privmsg('bob', 'hello from the live view', '@display-name=Bob;id=v1;user-id=9 ');
  await sleep(1400);
  const rows = await lv.ev(`[...document.querySelectorAll('#lvChat .cp-msg .cp-text')].map((t) => t.textContent)`);
  check('and a message reaches the docked panel', rows.includes('hello from the live view'), `${rows.length} row(s)`);

  // ----------------------------------------- 5. the command engine, end to end
  // The one rig check S12's clause asks for: chat.py parses `!command`
  // centrally, and this is what shows the engine consumes that parse. The
  // command is added through the editor's own controls, because saving it
  // straight to /api/commands/save would pass with the editor unwired.
  await lv.ev(`document.getElementById('lvCmds').click()`);
  await sleep(1000);
  const ed = await lv.ev('CmdPanel.debug()');
  check('the Commands button opens the editor', !!ed && ed.open, J(ed && ed.open));

  await lv.ev(`document.querySelector('#cmdPanel [data-cmd="add"]').click()`);
  await sleep(300);
  await lv.ev(`(() => {
    const box = document.querySelector('#cmdPanel .cmd-row:last-of-type');
    const set = (k, v) => { const f = box.querySelector('[data-cmd="' + k + '"]'); f.value = v; f.dispatchEvent(new Event('input', { bubbles: true })); };
    set('name', '!Hello');
    set('response', 'hi {user}');
    return true;
  })()`);
  await lv.ev(`document.querySelector('#cmdPanel [data-cmd="save"]').click()`);
  await sleep(1200);

  const saved = await getJ('/api/commands');
  const names = (saved.commands || []).map((c) => c.name);
  check('saving from the editor reaches the server', names.includes('hello'), J(names));
  // Typed as "!Hello"; the server normalises. The form must show what was kept
  // rather than what was typed, or it would quietly disagree with the app.
  const shown = (await lv.ev('CmdPanel.debug()')).rows.map((r) => r.name);
  check('and the editor redraws from what the server kept, not what was typed',
    shown.includes('hello') && !shown.includes('!Hello'), J(shown));

  // A gated one, to show the log tells apart what did not happen. Saved by the
  // API on purpose: this is the log's job, not the editor's.
  await post('/api/commands/save', {
    commands: (saved.commands || []).concat([{ name: 'modonly', action: 'say', role: 'mod', response: 'ok' }]),
  });
  await sleep(500);

  privmsg('amy', '!hello', '@display-name=Amy;id=c1;user-id=21 ');
  privmsg('amy', '!modonly', '@display-name=Amy;id=c2;user-id=21 ');
  await sleep(3000);                     // the editor polls its log every 2 s

  const fired = await lv.ev(`[...document.querySelectorAll('#cmdPanel .cmd-fired')].map((f) => ({
    outcome: f.dataset.outcome,
    cmd: (f.querySelector('b') || {}).textContent || '',
    resp: (f.querySelector('.cmd-resp') || {}).textContent || '',
  }))`);
  const ran = fired.find((f) => f.cmd === '!hello');
  check('a message off the socket fires a command, through the real parser and hub',
    !!ran && ran.outcome === 'ran', J(fired.map((f) => [f.cmd, f.outcome])));
  check('and the response is filled in and shown', !!ran && ran.resp === 'hi Amy', J(ran && ran.resp));
  const denied = fired.find((f) => f.cmd === '!modonly');
  check('a refusal is recorded rather than silently dropped',
    !!denied && denied.outcome === 'denied', J(denied));

  // Photograph the editor here, while it is still open: the docked-panel check
  // below clicks the page, which shuts a dialog, so the Live view shot taken at
  // the end cannot contain it. Six passing checks about a surface nobody has
  // looked at is how the last three visual faults in this project got through.
  if (outDir) {
    const shot = (await lv.send('Page.captureScreenshot', { format: 'png' })).result.data;
    fs.writeFileSync(`${outDir}/cmdeditor.png`, Buffer.from(shot, 'base64'));
    console.log('   wrote cmdeditor.png');
  }

  // ------------------------------------------- 6. song requests, end to end
  // Spotify is faked at the seam: the rig hook swaps the store's find/enqueue
  // for canned ones, so nothing here reaches an account or puts a track into
  // anybody's real queue. That hook is refused on the real app's port.
  const TRACK = { uri: 'spotify:track:rigtest', title: 'Sabotage', artist: 'Beastie Boys', duration: 178 };
  const faked = await (await post('/api/debug/spotify-fake', { track: TRACK })).json().catch(() => null);
  check('the rig can stand in for Spotify, so no real queue is touched',
    faked && faked.ok && faked.fake === true, J(faked));

  await post('/api/commands/save', { commands: [{ name: 'queue', action: 'queue' }] });
  await post('/api/config', { requests: { moderated: true, max_seconds: 420, blocked: [] } });
  await sleep(500);

  privmsg('amy', '!queue sabotage', '@display-name=Amy;id=q1;user-id=21 ');
  privmsg('bob', '!queue sabotage', '@display-name=Bob;id=q2;user-id=22 ');
  await sleep(1800);
  const waiting = await getJ('/api/requests');
  check('a !queue from chat becomes a request waiting to be let through',
    (waiting.pending || []).length === 2, J((waiting.pending || []).map((r) => r.user)));

  await lv.ev(`document.getElementById('lvReqs').click()`);
  await sleep(1400);
  const rp = await lv.ev('ReqPanel.debug()');
  check('the Live view shows them waiting', rp.open && rp.pending.length === 2, J(rp.pending));
  const label = await lv.ev(`document.getElementById('lvReqs').textContent`);
  check('and the button says how many, off the state feed', /\(2\)/.test(label), J(label));

  // Photograph it here, with both requests still waiting and their buttons on
  // screen: section 7 below clicks the page, which shuts a dialog, so the shot
  // taken at the end cannot contain this. The command editor needed a second
  // rig cycle to learn that once already.
  if (outDir) {
    const png = (await lv.send('Page.captureScreenshot', { format: 'png' })).result.data;
    fs.writeFileSync(`${outDir}/requests.png`, Buffer.from(png, 'base64'));
    console.log('   wrote requests.png');
  }

  // Through the panel's own buttons, not the API: pressing Let it through must
  // reach Spotify, and Skip must not reach it at all.
  await lv.ev(`document.querySelector('#reqPanel .req-row [data-req="approve"]').click()`);
  await sleep(1600);
  await lv.ev(`document.querySelector('#reqPanel .req-row [data-req="skip"]').click()`);
  await sleep(1600);
  const after = await getJ('/api/requests');
  check('the list empties as they are dealt with', (after.pending || []).length === 0,
    J((after.pending || []).length));
  check('exactly one went to Spotify - Skip called it not at all',
    (after.status || {}).queued === 1, J(after.status));
  const past = (await getJ('/api/requests/recent?n=20')).log || [];
  const states = past.map((r) => r.state).sort();
  check('and both are written down, one queued and one skipped',
    states.join(',') === 'queued,skipped', J(states));

  // What Spotify says when it says no has to survive the trip out to chat.
  await post('/api/debug/spotify-fake',
    { track: TRACK, ok: false, reason: 'Spotify has no active device - start playing something first.' });
  privmsg('amy', '!queue sabotage', '@display-name=Amy;id=q3;user-id=21 ');
  await sleep(1600);
  const third = ((await getJ('/api/requests')).pending || [])[0];
  const done = third ? await (await post('/api/requests/approve', { id: third.id })).json() : {};
  check("Spotify's own words reach the log rather than \"that did not work\"",
    /no active device/i.test((done.request || {}).reason || ''), J((done.request || {}).reason));

  // The other direction, and the only thing here that actually proves
  // /api/config reaches the store: "moderated" is true by construction as well
  // as by config, so everything above would pass unchanged if that wiring had
  // never landed. Turning it off has to change what happens.
  await post('/api/debug/spotify-fake', { track: TRACK });
  await post('/api/config', { requests: { moderated: false } });
  await sleep(700);
  privmsg('cat', '!queue sabotage', '@display-name=Cat;id=q4;user-id=23 ');
  await sleep(1800);
  const unmoderated = await getJ('/api/requests');
  check('turning moderation off in config reaches the store, and it goes straight through',
    (unmoderated.pending || []).length === 0 && (unmoderated.status || {}).queued === 2,
    J(unmoderated.status));

  // ------------------------------------------------ 7. the poll panel (S14)
  // Opened through the panel's own controls: posting to /api/polls/open would
  // pass with the panel completely unwired, which is the one thing this proves.
  await lv.ev(`document.getElementById('lvPoll').click()`);
  await sleep(1000);
  const pp = await lv.ev('PollPanel.debug()');
  check('the Poll button opens the panel', !!pp && pp.open, J(pp && pp.open));

  await lv.ev(`(() => {
    const set = (sel, v) => { const f = document.querySelector(sel); f.value = v; f.dispatchEvent(new Event('input', { bubbles: true })); };
    set('#pollPanel [data-poll="q"]', 'Which song next?');
    const cs = document.querySelectorAll('#pollPanel [data-poll="choice"]');
    cs[0].value = 'Sabotage'; cs[1].value = 'Intergalactic';
    document.querySelector('#pollPanel [data-poll="open"]').click();
    return true;
  })()`);
  await sleep(1500);
  const opened = await getJ('/api/polls');
  check('opening it from the panel reaches the server',
    (opened.current || {}).question === 'Which song next?', J(opened.current && opened.current.choices));

  privmsg('amy', '!1', '@display-name=Amy;id=pv1;user-id=51 ');
  privmsg('bob', '!2', '@display-name=Bob;id=pv2;user-id=52 ');
  await sleep(2800);
  const bars = await lv.ev('PollPanel.debug()');
  check('votes from chat move the bars in the panel',
    (bars.poll || {}).total === 2 && bars.bars.length === 2, J(bars.poll));

  // The state feed, not a poll: the header has to know without asking.
  const pollLabel = await lv.ev(`document.getElementById('lvPoll').textContent`);
  check('and the header says a poll is running, off the state feed', /open/.test(pollLabel), J(pollLabel));

  await lv.ev(`document.querySelector('#pollPanel [data-poll="stop"]').click()`);
  await sleep(1500);
  const pollAfter = await getJ('/api/polls');
  check('closing from the panel stops it and keeps the result',
    !pollAfter.current && (pollAfter.recent || []).length >= 1
      && pollAfter.recent[pollAfter.recent.length - 1].total === 2,
    J(pollAfter.recent && pollAfter.recent[pollAfter.recent.length - 1]));

  // Docked, it must not behave like a dialog: clicking the page must not shut it.
  await lv.ev(`document.getElementById('lvScenes').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await sleep(400);
  const stillThere = await lv.ev('LiveView.docked()');
  check('clicking elsewhere does not dismiss a docked panel',
    stillThere.sound === true && stillThere.chat === true, J(stillThere));

  check('nothing was thrown in the Live view', lv.errors.length === 0, lv.errors.slice(0, 2).join(' | '));

  if (outDir) {
    const d = (await lv.send('Page.captureScreenshot', { format: 'png' })).result.data;
    fs.writeFileSync(`${outDir}/liveview.png`, Buffer.from(d, 'base64'));
    console.log('   wrote liveview.png');
  }

  // ------------------------------------------------- 5. and it gives it back
  try { lv.ws.close(); } catch (_) {}
  await fetch(`http://127.0.0.1:${port}/json/close/${lv.targetId}`).catch(() => {});
  await sleep(2500);
  const given = await voiceNow();
  check('closing the view gives the microphone back', given === 'off', given);

  // ------------------------------------------------------------- put it back
  await post('/api/chat/disconnect', { service: 'twitch' });
  await post('/api/live/scene', { id: '' }).catch(() => {});
  await post(`/api/scenes/${a.id}/delete`, {});
  await post(`/api/scenes/${b.id}/delete`, {});
  await post('/api/debug/spotify-fake', {});          // the real Spotify back
  await post('/api/commands/save', { commands: ((beforeCfg || {}).commands || {}).list || [] });
  await post('/api/config', { requests: (beforeCfg || {}).requests || {} });
  await post('/api/config', { chat: (beforeCfg || {}).chat || {} });
  server.close();
  if (client) client.destroy();

  const bad = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - bad} of ${results.length} passed`);
  process.exit(bad ? 1 : 0);
})().catch(async (e) => {
  try { await post('/api/chat/disconnect', { service: 'twitch' }); } catch (_) {}
  try { server.close(); if (client) client.destroy(); } catch (_) {}
  console.log('THREW ' + e.message);
  process.exit(2);
});
