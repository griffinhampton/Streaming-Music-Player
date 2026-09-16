// T11: a chat command set up on the layer it sets off.
//
//   node layercmd.js <devtools port> [rig port]
//
// The claim is that the layer IS the setup: name a command in an effect
// layer's inspector and chat can set that layer off, with nothing in the
// Commands list. So this names one the way a person would - typing into the
// inspector of the real Canvas Builder - and then fires it through a fake IRC
// server and the real chat reader, and reads the stage.
//
// Each claim has the thing that would make it hollow beside it:
//
//   the owner answers           - even though its kinds filter would never let
//                                 the event in, so it cannot be the filter
//   nobody else does            - another effect layer listening for EVERYTHING
//                                 stays dark, and so does a layer with the same
//                                 id on a different scene, open in another page
//   renaming it in the inspector moves the command
//                               - and the old name stops answering
//   the Commands list wins a name both have
//                               - and the inspector and the panel both say so
//   only the scene on air listens
//                               - with nothing on air the name is not a
//                                 command at all; put it back and it is
//
// It brings its own pictures, scenes and command list, and puts the rig back.
const net = require('net');
const zlib = require('zlib');
const [port, rigPort = '8799'] = process.argv.slice(2);
const RIG = `http://127.0.0.1:${rigPort}`;
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 240000).unref();

const results = [];
const check = (n, ok, d = '') => {
  results.push([n, !!ok]);
  console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? `  (${d})` : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const post = (path, body) => fetch(RIG + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: J(body || {}),
}).then((r) => r.json());
const getJ = (path) => fetch(RIG + path, { cache: 'no-store' }).then((r) => r.json());

/* ---- pictures of known sizes, so which one is on screen can be measured */
const CRC = [...Array(256)].map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function makePng(size) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const px = [0];
    for (let x = 0; x < size; x++) px.push(255, y < size / 2 ? 80 : 220, 120);
    rows.push(Buffer.from(px));
  }
  const chunk = (tag, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(tag, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

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

let client = null;
const server = net.createServer((sock) => { client = sock; sock.on('data', () => {}); sock.on('error', () => {}); });
let seq = 0;
const say = (who, text) => client && client.write(
  `@display-name=${who};id=lc${++seq};user-id=${8000 + seq} ` +
  `:${who.toLowerCase()}!${who.toLowerCase()}@x.tmi.twitch.tv PRIVMSG #somechannel :${text}\r\n`);

// Every effect layer on a page: shown or not, drawn or not, and what picture.
const LAYERS = `Object.fromEntries([...document.querySelectorAll('.type-effect')].map((el) => {
  const m = el.querySelector('.media');
  return [el.dataset.id || el.id || '', {
    showing: el.classList.contains('showing'),
    opacity: Number(getComputedStyle(el.querySelector('.fx-box')).opacity),
    nw: m ? (m.naturalWidth || 0) : 0,
  }];
}))`;

const fxLayer = (id, name, x, props) => ({
  id, name, type: 'effect', visible: true, locked: false, group: '',
  transform: { x, y: 200, w: 480, h: 480, rotation: 0, anchor: 'tl' },
  style: { opacity: 1, blend: 'normal', radius: 0 },
  props: Object.assign({ sound: '', volume: 0.5, seconds: 3, max: 3, fit: 'contain' }, props),
  triggers: [],
});
const logNow = async () => (await getJ('/api/commands/recent?n=300')).log || [];
const alertsNow = async () => (await getJ('/api/alerts/recent?n=200')).events || [];

(async () => {
  const before = (await getJ('/api/config')).commands || {};
  const ups = [];
  for (const [name, size] of [['layercmd-a.png', 240], ['layercmd-b.png', 160]]) {
    ups.push(await post('/api/assets/upload', { name, data: 'data:image/png;base64,' + makePng(size).toString('base64') }));
  }
  check('the probe brought its own pictures', ups.every((u) => u.ok && u.id), J(ups.map((u) => u.reason || u.id)));
  if (!ups.every((u) => u.ok)) { console.log('\n0 of 1 passed'); process.exit(1); }
  const [picA, picB] = ups.map((u) => u.id);

  await new Promise((r) => server.listen(6667, '127.0.0.1', r));
  await post('/api/debug/chat-endpoint', { host: '127.0.0.1', port: 6667, tls: false });
  await post('/api/chat/connect', { service: 'twitch', channel: 'SomeChannel' });
  // An EMPTY list: whatever answers below answers because a layer said so.
  // The budget is off so that no check here is really a check of T10.
  await post('/api/commands/save', { commands: [], symbol: '!', budget: { count: 5, seconds: 0 } });

  const mk = async (name, layers) => {
    const s = (await post('/api/scenes', { name, format: 'horizontal' })).scene;
    const full = await getJ(`/api/scenes/${s.id}`);
    full.background = { mode: 'solid', color: '#101014' };
    full.layers = layers;
    await post(`/api/scenes/${s.id}`, { scene: full, expect_rev: full.rev });
    return s.id;
  };
  const S = await mk('Layer command probe', [
    // Listens for polls only - so if it shows for !boom, the command did it.
    fxLayer('horn', 'Horn', 100, { src: picA, kinds: 'poll', command: 'boom' }),
    // Listens for everything, and must still stay dark for a command that is
    // not its own. This is the control for "addressed to its layer".
    fxLayer('other', 'Other', 700, { src: picB, kinds: '', command: 'zap' }),
  ]);
  // A layer with the SAME id and the same command, on a scene that is not on
  // air, open in a page of its own.
  const T = await mk('Layer command probe, off air', [
    fxLayer('horn', 'Horn elsewhere', 100, { src: picB, kinds: '', command: 'boom' }),
  ]);
  await post('/api/live/scene', { id: S, transition: 'cut' });

  const other = await openPage(`${RIG}/scene.html?id=${T}`);
  const stage = await openPage(`${RIG}/scene.html?follow=1`);     // the source a stream uses
  await stage.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await stage.send('Page.bringToFront');                            // fxflood's lesson: the stage in front
  await sleep(4000);

  const idle = await stage.ev(LAYERS);
  check('both layers are on the stage, and dark', idle.horn && idle.other && !idle.horn.showing && !idle.other.showing, J(idle));

  // ------------------------------------------------ 1. the layer answers
  const log0 = (await logNow()).length, al0 = (await alertsNow()).length;
  say('Amy', '!boom');
  await sleep(1500);
  const lit = await stage.ev(LAYERS);
  check('!boom sets off the layer that owns it - past a kinds filter that would never let it in',
    lit.horn.showing && lit.horn.opacity > 0.9 && lit.horn.nw === 240, J(lit.horn));
  check('a layer listening for everything stays dark: it was not addressed to it (the control)',
    !lit.other.showing && lit.other.opacity < 0.05, J(lit.other));
  const elsewhere = await other.ev(LAYERS);
  check('and the layer with the same id on a scene off air stays still', elsewhere.horn && !elsewhere.horn.showing, J(elsewhere));
  const fired = (await logNow()).slice(log0);
  check('the log says it ran, with nothing in the Commands list', fired.length === 1 && fired[0].outcome === 'ran' && fired[0].command === 'boom', J(fired));
  const ev = (await alertsNow()).slice(al0);
  check('one event, of kind effect, addressed to that layer on that scene',
    ev.length === 1 && ev[0].kind === 'effect' && ev[0].detail.layer === 'horn' && ev[0].detail.scene === S, J(ev.map((e) => [e.kind, e.detail])));

  let cmds = await getJ('/api/commands');
  const L = (name) => (cmds.layers || []).find((c) => c.name === name) || {};
  check('the server lists what the layers on air answer to', L('boom').target === 'horn' && L('zap').target === 'other', J(cmds.layers));

  // ------------------------------------------- 2. set up in the inspector
  const editor = await openPage(`${RIG}/canvas.html?scene=${S}`);
  await editor.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(4000);
  const insp = async (id) => {
    await editor.ev(`Editor.select([${J(id)}])`);
    await sleep(900);                                      // the inspector rebuilds, then fetches the list
    return editor.ev(`(() => {
      const f = document.querySelector('#inspector [data-lx="props.command"]');
      const n = document.querySelector('#inspector [data-cmd-note]');
      const sec = document.querySelector('#inspector details[data-sec="cmd"] summary');
      return { section: sec ? sec.textContent.trim() : '', value: f ? f.value : null,
               note: n ? n.textContent.trim() : '', warn: n ? n.classList.contains('warn') : null };
    })()`);
  };
  const h1 = await insp('horn');
  check('the effect layer has a Chat command section', h1.section === 'Chat command', J(h1));
  check('showing the command the layer holds', h1.value === 'boom', J(h1.value));
  check('and saying what it does, in words', /!boom/.test(h1.note) && /set this layer off/.test(h1.note) && !h1.warn, J(h1.note));

  // Typed, the way a person does it: the input's own event, then the editor's
  // debounced save carries it to the server.
  await editor.ev(`(() => { const f = document.querySelector('#inspector [data-lx="props.command"]');
    f.focus(); f.value = 'kaboom'; f.dispatchEvent(new Event('input', { bubbles: true }));
    f.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
  await sleep(1500);
  const saved = await getJ(`/api/scenes/${S}`);
  const horn = saved.layers.find((x) => x.id === 'horn');
  check('typing a new name saved it onto the layer', horn && horn.props.command === 'kaboom', J(horn && horn.props.command));

  const log1 = (await logNow()).length;
  say('Bob', '!boom');
  say('Bob', '!kaboom');
  await sleep(1500);
  const renamed = (await logNow()).slice(log1);
  check('the old name no longer answers - it is not a command any more, so it is not even logged',
    renamed.length === 1 && renamed[0].command === 'kaboom', J(renamed.map((e) => e.command)));
  check('and the new one sets the layer off', renamed[0] && renamed[0].outcome === 'ran' && (await stage.ev(LAYERS)).horn.showing);

  // ------------------------------------------- 3. the list wins, and says so
  await post('/api/commands/save', { commands: [{ name: 'zap', action: 'say', response: 'from the list' }], symbol: '!', budget: { count: 5, seconds: 0 } });
  const o1 = await insp('other');
  check('the inspector warns that the Commands list has that name',
    o1.warn && /also in the Commands list/.test(o1.note), J(o1.note));
  await sleep(3200);                                        // let the horn's own three seconds run out
  const log2 = (await logNow()).length, al2 = (await alertsNow()).length;
  say('Cy', '!zap');
  await sleep(1500);
  const z = (await logNow()).slice(log2);
  check('the list answers a name both have', z.length === 1 && z[0].response === 'from the list', J(z));
  // Not "the layer stays dark". The first version asked that and failed on
  // correct behavior: Other listens for every kind, so the list command's
  // answer - a "command" card - rightly lit it, exactly as it would light for
  // any command. What must not happen is Other's OWN command firing.
  const zev = (await alertsNow()).slice(al2);
  check('and the layer\'s own command did not fire - no event was addressed to it',
    !zev.some((e) => e.kind === 'effect' || (e.detail || {}).layer === 'other') && zev.some((e) => e.kind === 'command'),
    J(zev.map((e) => [e.kind, e.detail])));
  cmds = await getJ('/api/commands');
  check('the server marks the conflict rather than settling it quietly', L('zap').conflict === 'list', J(L('zap')));

  const live = await openPage(`${RIG}/liveview.html`);
  await stage.send('Page.bringToFront');
  await sleep(3000);
  await live.ev(`CmdPanel.open(document.getElementById('lvCmds'))`);
  await sleep(1200);
  const panel = await live.ev(`({ shown: !document.querySelector('#cmdPanel [data-cmd="layersbox"]').hidden,
    rows: [...document.querySelectorAll('#cmdPanel .cmd-layer')].map((r) => [r.querySelector('b').textContent, r.dataset.conflict]) })`);
  check('the Commands panel shows the layers\' commands, read-only, in the same place as the rest',
    panel.shown && panel.rows.length === 2, J(panel));
  check('with the conflict marked there too', panel.rows.some(([n, c]) => n === '!zap' && c === 'list'), J(panel.rows));

  // --------------------------------------- 4. only the scene on air listens
  await post('/api/live/scene', { id: '' });
  await sleep(500);
  const log3 = (await logNow()).length;
  say('Dee', '!kaboom');
  await sleep(1200);
  check('with nothing on air the name is not a command at all', (await logNow()).slice(log3).length === 0);
  await post('/api/live/scene', { id: S, transition: 'cut' });
  await sleep(2500);
  const log4 = (await logNow()).length;
  say('Dee', '!kaboom');
  await sleep(1500);
  const back = (await logNow()).slice(log4);
  check('put the scene back on air and it answers again', back.length === 1 && back[0].outcome === 'ran', J(back));

  for (const [n, p] of [['stage', stage], ['the other scene', other], ['the editor', editor], ['the Live view', live]]) {
    check(`nothing was thrown in ${n}`, p.errors.length === 0, p.errors.slice(0, 2).join(' | '));
  }

  // -------------------------------------------------- put the rig back as found
  for (const p of [stage, other, editor, live]) await closePage(p);
  await post('/api/live/scene', { id: '' });
  await post('/api/chat/disconnect', { service: 'twitch' });
  await post('/api/commands/save', {
    commands: before.list || [], symbol: before.symbol || '!', budget: before.budget || { count: 5, seconds: 30 },
  });
  for (const id of [S, T]) await post(`/api/scenes/${id}/delete`, {});
  const dels = [];
  for (const id of [picA, picB]) dels.push(await post('/api/assets/delete', { id }));
  const after = await getJ('/api/commands');
  check('the rig was put back: list, budget, no layer commands, pictures gone',
    after.commands.length === (before.list || []).length && (after.layers || []).length === 0 &&
    J(after.budget) === J(before.budget || { count: 5, seconds: 30 }) && dels.every((d) => d.ok !== false),
    J({ n: after.commands.length, layers: (after.layers || []).length, budget: after.budget }));
  server.close();
  if (client) client.destroy();

  const bad = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - bad} of ${results.length} passed`);
  process.exitCode = bad ? 1 : 0;
})().catch(async (e) => {
  try { await post('/api/chat/disconnect', { service: 'twitch' }); } catch (_) {}
  try { server.close(); if (client) client.destroy(); } catch (_) {}
  console.log('THREW ' + e.message);
  process.exit(2);
});
