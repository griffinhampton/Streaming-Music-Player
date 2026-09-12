/* Studio mode, the LIVE panel and the remote in the Canvas Builder (P11).

   Studio mode: the scene being edited is the preview; the program - what is
   on air - shows beside it, as a small picture of the live output window
   (the stream's own source) taken once a second while studio mode is on and
   the editor visible. "Take" (Ctrl+Enter) puts the scene being edited on
   air with the transition chosen here, after saving it. Editing the scene
   that is already on air is allowed, and said: its changes go out as they
   are made.

   The top bar's LIVE button opens the shared LIVE panel (livepanel.js,
   Ctrl+Shift+L); Remote opens the scene remote window. In-app shortcuts
   only - nothing is grabbed from other programs. */
'use strict';

const STUDIO_KEY = 'cb-studio';
const studio = Object.assign({ on: false, transition: 'fade', duration: 300 },
  (() => { try { return JSON.parse(localStorage.getItem(STUDIO_KEY) || '{}'); } catch (_) { return {}; } })());
let studioLive = { id: '', name: '', state: 'idle' };
let pgTimer = null, pgLoading = false;

function saveStudio() {
  try { localStorage.setItem(STUDIO_KEY, JSON.stringify({ on: studio.on, transition: studio.transition, duration: studio.duration })); } catch (_) { /* fine */ }
}
function setStudio(on) {
  studio.on = !!on;
  saveStudio();
  $('studioBtn').setAttribute('aria-pressed', String(studio.on));
  $('programPanel').hidden = !studio.on;
  paintProgram();
  pollProgram();
  announce(studio.on ? 'Studio mode: the scene here is the preview; Take puts it on air' : 'Studio mode off');
}

/* The program monitor: a new picture once a second, swapped in once loaded. */
function pollProgram() {
  clearTimeout(pgTimer);
  if (!studio.on) return;
  pgTimer = setTimeout(pollProgram, 1000);
  if (document.hidden || pgLoading) return;
  pgLoading = true;
  const img = new Image();
  img.onload = () => { pgLoading = false; $('pgImg').src = img.src; $('pgImg').hidden = false; $('pgNone').hidden = true; };
  img.onerror = () => { pgLoading = false; $('pgImg').hidden = true; $('pgNone').hidden = false; };
  img.src = '/api/live/program.png?w=480&t=' + Math.floor(performance.now());
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) pollProgram(); });

function paintProgram() {
  const s = store.scene;
  $('pgScene').textContent = studioLive.name || 'nothing yet';
  const pill = $('pgState');
  pill.dataset.state = studioLive.state;
  pill.textContent = { connecting: 'Connecting', live: 'LIVE', reconnecting: 'Reconnecting' }[studioLive.state] || 'Off air';
  document.querySelectorAll('#pgTrans [data-t]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.t === studio.transition)));
  $('pgDur').value = String(studio.duration);
  $('pgDur').disabled = studio.transition === 'cut';
  const same = !!s && s.id === studioLive.id;
  $('pgTake').disabled = !s || same;
  $('pgTake').textContent = same ? 'On air' : 'Take';
  const note = $('pgNote');
  note.hidden = !same;
  note.textContent = same ? 'You are editing the scene that is on air: what you change goes out as you make it.' : '';
}

async function take() {
  const s = store.scene;
  if (!s || s.id === studioLive.id) return false;
  await flush();                                        // the latest of it goes out
  const d = await fetch('/api/live/scene', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: s.id, transition: studio.transition, duration: studio.duration }) }).then((r) => r.json()).catch(() => ({ ok: false }));
  if (!d.ok) { toast(d.reason || 'Could not put it on air'); return false; }
  announce(`${s.name} is on air`);
  return true;
}

function studioOnState(st) {
  const id = (st.canvas || {}).live || '';
  const sc = (st.scenes || []).find((x) => x.id === id);
  studioLive = { id, name: sc ? sc.name : '', state: (st.live || {}).state || 'idle' };
  LivePanel.onState(st);
  if (studio.on) paintProgram();
}

$('studioBtn').addEventListener('click', () => setStudio(!studio.on));
$('pgTake').addEventListener('click', take);
$('pgTrans').addEventListener('click', (e) => {
  const b = e.target.closest('[data-t]');
  if (!b) return;
  studio.transition = b.dataset.t;
  saveStudio();
  paintProgram();
});
$('pgDur').addEventListener('change', () => { studio.duration = Number($('pgDur').value) || 300; saveStudio(); });
$('pgOpen').addEventListener('click', () => {
  fetch('/api/components/live/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    .then((r) => r.json()).then((d) => { if (!d.ok) toast(d.reason || 'Could not open the live output'); }).catch(() => {});
});
// The program panel sits over the canvas, but is not part of it.
for (const ev of ['pointerdown', 'wheel', 'contextmenu', 'dblclick']) {
  $('programPanel').addEventListener(ev, (e) => e.stopPropagation());
}
$('liveStatus').addEventListener('click', () => LivePanel.toggle($('liveStatus')));
$('remoteBtn').addEventListener('click', () => {
  fetch('/api/canvas/remote/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    .then((r) => r.json()).then((d) => { if (!d.ok) toast('Could not open the remote'); }).catch(() => {});
});

window.addEventListener('keydown', (e) => {
  if (!$('shortcuts').hidden || !$('newDialog').hidden) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.shiftKey && e.code === 'KeyL') { e.preventDefault(); LivePanel.toggle($('liveStatus')); return; }
  if (ctrl && e.shiftKey && e.code === 'KeyP') { e.preventDefault(); setStudio(!studio.on); return; }
  if (ctrl && !e.shiftKey && e.key === 'Enter' && studio.on && !typing(e)) { e.preventDefault(); take(); }
});

LivePanel.mount();
if (studio.on) setStudio(true); else paintProgram();

/* For tests. */
Object.assign(window.Editor, {
  studio: (on) => { if (on !== undefined) setStudio(on); return { on: studio.on, transition: studio.transition, duration: studio.duration, live: { ...studioLive } }; },
  take,
});
