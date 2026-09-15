/* The Live view (S9): what is on air, how it is going out, the switcher, sound
   and chat, in one window.

   Two sources, and the split is deliberate rather than incidental:

   * The state feed (/ws/events) carries the scenes, which one is on air, the
     stream's state and which windows are open. It is a whole-state broadcast,
     so it costs nothing to listen to and arrives the moment anything changes -
     including changes made in the deck, the editor or the remote.
   * The health numbers are polled from /api/live/status, and only while this
     window is visible. LIVE.snapshot_status() drops `stats` on purpose - the
     comment on it reads "nothing that changes every second" - because putting
     kbps and frame rate on the feed would make the whole-state hub broadcast
     once a second to every page in the app. So they are pulled here, by the
     one page that wants them, and nowhere else.

   The sound and the chat are the S7 and S11 panels themselves, docked rather
   than copied: one of each to keep working. Docked they never close, which is
   why the Sound panel holds the voice lease for as long as this window lives -
   correct for a meter you are watching while you stream.

   The program monitor asks for a picture only when the state feed says the
   live output window is open. /api/live/program.png answers 404 when it is
   not, and a 404 a second for a window nobody opened is a poor way to say
   "not open". */
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
  .then((r) => r.json()).catch(() => ({ ok: false }));
const getJSON = (url) => fetch(url, { cache: 'no-store' }).then((r) => r.json()).catch(() => null);

const ON_AIR = ['connecting', 'live', 'reconnecting'];
const STATE_TEXT = { idle: 'Off air', connecting: 'Connecting…', live: 'LIVE', reconnecting: 'Reconnecting…', failed: 'Stopped by an error' };

let st = { scenes: [], canvas: {}, live: { state: 'idle' }, windows: {} };
let health = { stats: {}, native: {} };
let transition = 'fade', duration = 300, stopArmed = 0;
let pgTimer = null, pgLoading = false, hzTimer = null, tick = null;

const say = (text) => { $('lvAnnounce').textContent = text; };
const onAir = () => ON_AIR.includes((st.live || {}).state);
const mmss = (s) => `${Math.floor((s || 0) / 60)}:${String(Math.floor((s || 0) % 60)).padStart(2, '0')}`;
const outputOpen = () => !!((st.windows || {}).live || {}).open;

/* ------------------------------------------------------------- the switcher */

async function take(id) {
  if (!id) return;
  const d = await post('/api/live/scene', { id, transition, duration });
  const s = (st.scenes || []).find((x) => x.id === id);
  if (d.ok) say(`${s ? s.name : 'The scene'} is on air`);
  else $('lvHint').textContent = d.reason || 'That scene cannot go on air now';
}
async function step(n) {
  const d = await post('/api/live/scene', { step: n, transition, duration });
  if (!d.ok) $('lvHint').textContent = d.reason || 'Could not switch';
}

/* ------------------------------------------------------- painting from state */

function paintScenes() {
  const scenes = st.scenes || [];
  const cur = (st.canvas || {}).live || '';
  const list = $('lvScenes');
  // Rebuild only when something actually changed, so the list does not lose
  // the button you are on every time a number in the snapshot moves.
  const sig = JSON.stringify([scenes.map((s) => [s.id, s.name, s.width, s.height]), cur]);
  if (list.dataset.sig === sig) return;
  const focused = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.id;
  list.dataset.sig = sig;
  list.innerHTML = scenes.length ? scenes.map((s, i) => `
    <button type="button" class="lv-scene${s.id === cur ? ' on' : ''}" data-id="${esc(s.id)}" aria-pressed="${s.id === cur}"
      aria-label="${esc(s.name)}${s.id === cur ? ', on air' : ''}${i < 9 ? ', key ' + (i + 1) : ''}">
      <span class="lv-num" aria-hidden="true">${i < 9 ? i + 1 : ''}</span>
      <span class="lv-name">${esc(s.name)}</span>
      <span class="lv-fmt">${s.height > s.width ? 'Phone' : 'Horizontal'}</span>
      ${s.id === cur ? '<span class="lv-air">On air</span>' : ''}
    </button>`).join('') : '<p class="lv-hint">No scenes yet - make one in the Canvas Builder.</p>';
  if (focused) { const b = list.querySelector(`[data-id="${CSS.escape(focused)}"]`); if (b) b.focus(); }
}

function paint() {
  const live = st.live || { state: 'idle' };
  const cur = (st.canvas || {}).live || '';
  const scene = (st.scenes || []).find((x) => x.id === cur);

  const pill = $('lvState');
  pill.dataset.state = live.state || 'idle';
  pill.textContent = (STATE_TEXT[live.state] || 'Off air') + (live.state === 'live' ? ' ' + mmss((health.stats || {}).uptime) : '');
  pill.title = live.error || '';

  const go = $('lvGo');
  const armed = Date.now() - stopArmed < 4000;
  go.textContent = onAir() ? (armed ? 'Click again to stop' : 'Stop') : 'Start';
  go.classList.toggle('primary', !onAir());
  go.classList.toggle('danger', onAir());
  go.disabled = !onAir() && (!live.has_key || !cur);
  go.title = !onAir() && !live.has_key ? 'Save your stream key in the LIVE panel first'
    : !onAir() && !cur ? 'Put a scene on air first' : '';

  $('pgScene').textContent = scene ? scene.name : 'nothing yet';
  const err = $('lvError');
  err.hidden = !live.error;
  err.textContent = live.error || '';

  // How many songs are waiting rides the state feed, so the button can say so
  // without anything polling for it - and a pending list you have to remember
  // to go and look at is a pending list that fills up.
  const waiting = ((st.requests || {}).pending) || 0;
  const rq = $('lvReqs');
  rq.textContent = waiting ? `Requests (${waiting})` : 'Requests';
  rq.classList.toggle('waiting', waiting > 0);

  // Whether a poll is taking votes rides the state feed too - the counts do
  // not, because they move on every vote.
  const polling = !!((st.polls || {}).open);
  const pb = $('lvPoll');
  pb.textContent = polling ? 'Poll (open)' : 'Poll';
  pb.classList.toggle('waiting', polling);

  // Paused rides the state feed (commands.py's snapshot), so every window with
  // this button agrees the moment anybody presses it - including a moderator
  // doing it from chat. Amber, like the others: something to come back to.
  $('lvSkip').hidden = !((st.tts || {}).on_air);

  const paused = !!((st.commands || {}).paused);
  const sf = $('lvStopFx');
  sf.textContent = paused ? 'Resume commands' : 'Stop effects';
  sf.classList.toggle('waiting', paused);
  sf.title = paused
    ? 'Chat commands are paused. Press to let them run again.'
    : 'Take every picture, sound and alert off the stream now, and pause chat commands until you resume them. Polls keep counting.';

  paintScenes();
  document.querySelectorAll('#lvTrans [data-t]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.t === transition)));
  $('lvDur').disabled = transition === 'cut';

  clearInterval(tick);
  tick = live.state === 'live' ? setInterval(paint, 1000) : null;   // the clock
}

/* ------------------------------------------------ health, polled not pushed */

function paintHealth() {
  const s = health.stats || {}, n = health.native || {};
  // The LIVE panel's rules exactly, so the two can never disagree.
  const wait = onAir() ? 'measuring…' : '-';
  const set = (k, v) => { const el = document.querySelector(`[data-lv="${k}"]`); if (el) el.textContent = v; };
  set('uptime', mmss(s.uptime));
  set('kbps', s.kbps ? `${(s.kbps / 1000).toFixed(2)} Mb/s` : wait);
  set('fps', (n.fps || s.vfps) ? `${n.fps || s.vfps} fps` : wait);
  set('dropped', String((s.dropped || 0) + (n.dropped || 0)));
  set('reconnects', String(s.reconnects || 0));
  set('delay', s.rtt_ms ? `${s.rtt_ms} ms` : s.delay_ms ? `${s.delay_ms} ms` : '-');
}

function pollHealth() {
  clearTimeout(hzTimer);
  const step = () => { hzTimer = setTimeout(pollHealth, window.isUltra && window.isUltra() ? 2000 : 1000); };
  if (document.hidden) { step(); return; }
  getJSON('/api/live/status').then((d) => {
    if (d) { health = d; paintHealth(); LivePanel.onState({ live: d }); }
  }).finally(step);
}

/* --------------------------------------------------------- program monitor */

function pollProgram() {
  clearTimeout(pgTimer);
  pgTimer = setTimeout(pollProgram, window.isUltra && window.isUltra() ? 2000 : 1000);
  if (document.hidden || pgLoading) return;
  if (!outputOpen()) {                      // do not ask for a 404 once a second
    $('pgImg').hidden = true;
    $('pgNone').hidden = false;
    return;
  }
  pgLoading = true;
  const img = new Image();
  img.onload = () => { pgLoading = false; $('pgImg').src = img.src; $('pgImg').hidden = false; $('pgNone').hidden = true; };
  img.onerror = () => { pgLoading = false; $('pgImg').hidden = true; $('pgNone').hidden = false; };
  img.src = '/api/live/program.png?w=640&t=' + Math.floor(performance.now());
}

/* ------------------------------------------------------------------ wiring */

$('lvScenes').addEventListener('click', (e) => {
  const b = e.target.closest('.lv-scene');
  if (b) take(b.dataset.id);
});
$('lvTrans').addEventListener('click', (e) => {
  const b = e.target.closest('[data-t]');
  if (!b) return;
  transition = b.dataset.t;
  try { localStorage.setItem('lv-transition', transition); } catch (_) { /* fine */ }
  paint();
});
$('lvDur').addEventListener('change', () => {
  duration = Number($('lvDur').value) || 300;
  try { localStorage.setItem('lv-duration', String(duration)); } catch (_) { /* fine */ }
});
$('lvGo').addEventListener('click', async () => {
  if (onAir() && Date.now() - stopArmed > 4000) { stopArmed = Date.now(); paint(); setTimeout(paint, 4100); return; }
  stopArmed = 0;
  $('lvGo').disabled = true;
  const d = await post(onAir() ? '/api/live/stop' : '/api/live/start', {});
  if (!d.ok) $('lvHint').textContent = d.error || d.reason || 'Could not do that';
  paint();
});
$('pgOpen').addEventListener('click', async () => {
  const d = await post('/api/components/live/open');
  if (!d.ok) $('lvHint').textContent = d.reason || 'Could not open the output window';
});
$('lvMore').addEventListener('click', () => LivePanel.toggle($('lvMore')));
$('lvCmds').addEventListener('click', () => CmdPanel.toggle($('lvCmds')));
$('lvReqs').addEventListener('click', () => ReqPanel.toggle($('lvReqs')));
$('lvPoll').addEventListener('click', () => PollPanel.toggle($('lvPoll')));
$('lvSkip').addEventListener('click', async () => {
  const d = await post('/api/tts/skip', {});
  if (!d.ok) $('lvHint').textContent = 'Could not skip';
  else say('Skipped');
});
// No "click again to confirm", unlike Stop above it: stopping effects harms
// nothing and is wanted at once, and resuming is one more press away.
$('lvStopFx').addEventListener('click', async () => {
  const paused = !!((st.commands || {}).paused);
  const d = await post(paused ? '/api/commands/resume' : '/api/commands/stop', {});
  if (!d.ok) { $('lvHint').textContent = 'Could not do that'; return; }
  st.commands = Object.assign({}, st.commands, { paused: !!d.paused });   // the feed confirms it
  paint();
  CmdPanel.onState(st);
  say(d.paused ? 'Effects cleared and chat commands paused' : 'Chat commands resumed');
});

document.addEventListener('keydown', (e) => {
  if (e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyL') { e.preventDefault(); LivePanel.toggle($('lvMore')); return; }
  if (e.ctrlKey || e.metaKey) return;
  const scenes = st.scenes || [];
  if (/^[1-9]$/.test(e.key) && scenes[Number(e.key) - 1]) { e.preventDefault(); take(scenes[Number(e.key) - 1].id); }
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); step(-1); }
  else if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); step(1); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollHealth(); pollProgram(); } });

function connect() {
  let ws;
  try { ws = new WebSocket(`ws://${location.host}/ws/events?page=liveview.html`); } catch (_) { setTimeout(connect, 2000); return; }
  ws.onmessage = (e) => {
    try { st = JSON.parse(e.data); } catch (_) { return; }
    paint();
    ChatPanel.onState(st);
    CmdPanel.onState(st);
  };
  ws.onclose = () => setTimeout(connect, 1500);
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}

(async () => {
  try {
    transition = localStorage.getItem('lv-transition') || 'fade';
    duration = Number(localStorage.getItem('lv-duration')) || 300;
    $('lvDur').value = String(duration);
  } catch (_) { /* the defaults */ }
  // The user's own colors, the way the scene remote takes them.
  const cfg = await getJSON('/api/config');
  const ui = (cfg || {}).ui || {}, root = document.documentElement.style;
  for (const [k, v] of Object.entries({ bg: '--bg', panel: '--panel', border: '--line', text: '--fg', muted: '--dim', accent: '--accent' })) {
    if (/^#[0-9a-f]{3,8}$/i.test(ui[k] || '')) root.setProperty(v, ui[k]);
  }

  LivePanel.mount();
  CmdPanel.mount();
  ReqPanel.mount();
  PollPanel.mount();
  AudioPanel.mount($('lvSound'));
  ChatPanel.mount($('lvChat'));
  await AudioPanel.open();          // docked: opening it is what starts its meters
  await ChatPanel.open();

  paint();
  paintHealth();
  connect();
  pollHealth();
  pollProgram();
})();

/* For tests. */
window.LiveView = {
  state: () => st,
  health: () => health,
  program: () => ({ shown: !$('pgImg').hidden, none: !$('pgNone').hidden, src: $('pgImg').src || '' }),
  tiles: () => Object.fromEntries([...document.querySelectorAll('#lvHealth [data-lv]')].map((d) => [d.dataset.lv, d.textContent])),
  scenes: () => [...document.querySelectorAll('#lvScenes .lv-scene')].map((b) => ({ id: b.dataset.id, on: b.classList.contains('on') })),
  docked: () => ({
    sound: !!document.querySelector('#lvSound .lp.ap.docked'),
    chat: !!document.querySelector('#lvChat .lp.cp.docked'),
  }),
};
