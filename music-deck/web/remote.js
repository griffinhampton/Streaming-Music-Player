/* The scene remote (P11): a small window to run a show from - every scene
   as a big button (press one, it goes on air with the transition), the one
   before or after, Cut or Fade, Start and Stop, and whether the window
   stays on top of the others. One state feed; no polling. Keys: 1-9 put
   that scene on air, the arrows the one before or after, C and F the
   transition. Stop asks twice. */
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
  .then((r) => r.json()).catch(() => ({ ok: false }));
const ON_AIR = ['connecting', 'live', 'reconnecting'];

let st = { scenes: [], canvas: {}, live: { state: 'idle' } };
let transition = 'fade', stopArmed = 0, liveSince = 0, tick = null;

function say(text) { $('rmAnnounce').textContent = text; }

async function take(id) {
  if (!id) return;
  const d = await post('/api/live/scene', { id, transition });
  const s = (st.scenes || []).find((x) => x.id === id);
  if (d.ok) say(`${s ? s.name : 'The scene'} is on air`);
  else { $('rmHint').textContent = d.reason || 'That scene cannot go on air now'; }
}
async function step(n) {
  const d = await post('/api/live/scene', { step: n, transition });
  if (!d.ok) $('rmHint').textContent = d.reason || 'Could not switch';
}

function paint() {
  const scenes = st.scenes || [];
  const cur = (st.canvas || {}).live || '';
  const live = st.live || { state: 'idle' };
  const onAir = ON_AIR.includes(live.state);
  // The scenes: a button each, the one on air marked.
  const list = $('rmList');
  const sig = JSON.stringify([scenes.map((s) => [s.id, s.name, s.width, s.height]), cur]);
  if (list.dataset.sig !== sig) {
    const focused = document.activeElement && document.activeElement.dataset.id;
    list.dataset.sig = sig;
    list.innerHTML = scenes.length ? scenes.map((s, i) => `
      <button type="button" class="rm-scene${s.id === cur ? ' on' : ''}" data-id="${esc(s.id)}" aria-pressed="${s.id === cur}"
        aria-label="${esc(s.name)}${s.id === cur ? ', on air' : ''}${i < 9 ? ', key ' + (i + 1) : ''}">
        <span class="rm-num" aria-hidden="true">${i < 9 ? i + 1 : ''}</span>
        <span class="rm-name">${esc(s.name)}</span>
        <span class="rm-fmt ${s.height > s.width ? 'phone' : ''}">${s.height > s.width ? 'Phone' : 'Horizontal'}</span>
        ${s.id === cur ? '<span class="rm-air">On air</span>' : ''}
      </button>`).join('') : '<p class="rm-hint">No scenes yet - make one in the Canvas Builder.</p>';
    if (focused) { const b = list.querySelector(`[data-id="${CSS.escape(focused)}"]`); if (b) b.focus(); }
  }
  // State and Start / Stop.
  const pill = $('rmState');
  pill.dataset.state = live.state || 'idle';
  if (live.state === 'live' && !liveSince) liveSince = Date.now();
  if (live.state !== 'live') liveSince = 0;
  const up = liveSince ? Math.round((Date.now() - liveSince) / 1000) : 0;
  pill.textContent = { idle: 'Off air', connecting: 'Connecting…', live: `LIVE ${Math.floor(up / 60)}:${String(up % 60).padStart(2, '0')}`, reconnecting: 'Reconnecting…', failed: 'Stopped by an error' }[live.state] || 'Off air';
  pill.title = live.error || '';
  const go = $('rmGo');
  const armed = Date.now() - stopArmed < 4000;
  go.textContent = onAir ? (armed ? 'Click again to stop' : 'Stop') : 'Start';
  go.classList.toggle('primary', !onAir);
  go.classList.toggle('danger', onAir);
  go.disabled = !onAir && (!live.has_key || !cur);
  go.title = !onAir && !live.has_key ? 'Save your stream key in the LIVE panel first' : !onAir && !cur ? 'Pick a scene first' : '';
  document.querySelectorAll('.rm-seg [data-t]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.t === transition)));
  clearInterval(tick);
  tick = live.state === 'live' ? setInterval(paint, 1000) : null;
}

$('rmList').addEventListener('click', (e) => {
  const b = e.target.closest('.rm-scene');
  if (b) take(b.dataset.id);
});
$('rmPrev').addEventListener('click', () => step(-1));
$('rmNext').addEventListener('click', () => step(1));
document.querySelector('.rm-seg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-t]');
  if (!b) return;
  transition = b.dataset.t;
  try { localStorage.setItem('rm-transition', transition); } catch (_) { /* fine */ }
  paint();
});
$('rmGo').addEventListener('click', async () => {
  const onAir = ON_AIR.includes((st.live || {}).state);
  if (onAir && Date.now() - stopArmed > 4000) { stopArmed = Date.now(); paint(); setTimeout(paint, 4100); return; }
  stopArmed = 0;
  $('rmGo').disabled = true;
  const d = await post(onAir ? '/api/live/stop' : '/api/live/start', {});
  if (!d.ok) $('rmHint').textContent = d.error || d.reason || 'Could not do that';
  paint();
});
$('rmTop').addEventListener('click', async () => {
  const on = $('rmTop').getAttribute('aria-pressed') !== 'true';
  $('rmTop').setAttribute('aria-pressed', String(on));
  $('rmTop').textContent = on ? 'On top' : 'Not on top';
  await post('/api/canvas/remote/topmost', { on });
});

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  const scenes = st.scenes || [];
  if (/^[1-9]$/.test(e.key) && scenes[Number(e.key) - 1]) { e.preventDefault(); take(scenes[Number(e.key) - 1].id); }
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); step(-1); }
  else if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); step(1); }
  else if (e.key === 'c' || e.key === 'f') { transition = e.key === 'c' ? 'cut' : 'fade'; paint(); say(transition === 'cut' ? 'Cut' : 'Fade'); }
});

function connect() {
  let ws;
  try { ws = new WebSocket(`ws://${location.host}/ws/events?page=remote.html`); } catch (_) { setTimeout(connect, 2000); return; }
  ws.onmessage = (e) => { try { st = JSON.parse(e.data); paint(); } catch (_) { /* next one */ } };
  ws.onclose = () => setTimeout(connect, 1500);
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}

(async () => {
  try { transition = localStorage.getItem('rm-transition') || 'fade'; } catch (_) { /* fine */ }
  try {
    const cfg = await (await fetch('/api/config')).json();
    const ui = cfg.ui || {}, r = document.documentElement.style;
    for (const [k, v] of Object.entries({ bg: '--bg', panel: '--panel', border: '--line', text: '--fg', muted: '--dim', accent: '--accent' })) {
      if (/^#[0-9a-f]{3,8}$/i.test(ui[k] || '')) r.setProperty(v, ui[k]);
    }
    const on = (cfg.canvas || {}).remote_on_top !== false;
    $('rmTop').setAttribute('aria-pressed', String(on));
    $('rmTop').textContent = on ? 'On top' : 'Not on top';
  } catch (_) { /* the default look */ }
  paint();
  connect();
})();

window.Remote = { state: () => st, transition: () => transition };
