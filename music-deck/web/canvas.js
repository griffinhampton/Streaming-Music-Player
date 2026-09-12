/* The Canvas Builder (P7): the editor for scenes.

   One store holds the scene being edited. Every change is a command - the
   scene before and after it - so undo and redo are exact, and a run of the
   same change (typing a name, dragging a slider) merges into one step. The
   working copy goes straight into the preview (scene.html in preview mode,
   pushed by postMessage) and is saved shortly after: at most ~150 ms after
   the first unsaved change, one save at a time, each carrying the revision
   it was based on. A save the server refuses as stale (someone else saved
   first) is dropped and the newer scene reloaded, with a notice.

   The canvas is the real renderer, scaled and panned; this page only draws
   over it. Picking, moving, resizing, snapping, rulers and menus on the
   canvas are canvastools.js (P8); the full inspectors are P9. */
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));
const newId = () => Math.random().toString(16).slice(2, 10).padEnd(8, '0');
const FORMATS = { horizontal: [1920, 1080], phone: [1080, 1920] };
const Q = new URLSearchParams(location.search);

/* ------------------------------------------------------------- the store */

const store = {
  scene: null,          // the working copy
  rev: 0,               // the server revision it is based on
  undo: [],
  redo: [],
  sel: new Set(),       // selected layer ids
  dirty: false,
  scenes: [],           // summaries, from the feed
};
const HISTORY = 200;
const MERGE_MS = 900;
const collapsed = new Set();   // collapsed groups: a view choice, not part of the scene

/** Run a change as one command. Returns false if it changed nothing. */
function exec(label, mutate, mergeKey = '') {
  if (!store.scene) return false;
  const before = clone(store.scene);
  mutate(store.scene);
  const after = clone(store.scene);
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  const now = performance.now();
  const last = store.undo[store.undo.length - 1];
  if (mergeKey && last && last.key === mergeKey && now - last.t < MERGE_MS) {
    last.after = after;
    last.t = now;
    // Typed back to where the run began (Esc in a field): the step is gone.
    if (JSON.stringify(last.before) === JSON.stringify(after)) store.undo.pop();
  } else {
    store.undo.push({ label, before, after, key: mergeKey, t: now });
    if (store.undo.length > HISTORY) store.undo.shift();
  }
  store.redo.length = 0;
  changed();
  return true;
}
/* A drag on the canvas is one command too. It changed the working copy live
   while it ran, so it arrives with the scene from before it. */
function recordGesture(label, before) {
  const after = clone(store.scene);
  if (JSON.stringify(before) === JSON.stringify(after)) { renderAll(); return false; }
  store.undo.push({ label, before, after, key: '', t: performance.now() });
  if (store.undo.length > HISTORY) store.undo.shift();
  store.redo.length = 0;
  changed();
  return true;
}
/* An edit after an undo or redo starts a step of its own: merging it into
   the step now on top would make one undo take back two different things. */
function breakMerge() {
  const top = store.undo[store.undo.length - 1];
  if (top) top.t = -Infinity;
}
function undo() {
  const c = store.undo.pop();
  if (!c) return;
  store.redo.push(c);
  breakMerge();
  store.scene = clone(c.before);
  changed();
  announce('Undid ' + c.label);
}
function redo() {
  const c = store.redo.pop();
  if (!c) return;
  store.undo.push(c);
  breakMerge();
  store.scene = clone(c.after);
  changed();
  announce('Redid ' + c.label);
}
function changed() {
  store.dirty = true;
  pruneSelection();
  renderAll();
  pushPreview();
  scheduleSave();
}
function pruneSelection() {
  const ids = new Set((store.scene ? store.scene.layers : []).map((l) => l.id));
  for (const id of [...store.sel]) if (!ids.has(id)) store.sel.delete(id);
}
const layerById = (id) => store.scene && store.scene.layers.find((l) => l.id === id);
const selected = () => (store.scene ? store.scene.layers.filter((l) => store.sel.has(l.id)) : []);

/* ------------------------------------------------------------- autosave */

const SAVE_DEBOUNCE = 60;     // after the last change...
const SAVE_MAX_WAIT = 150;    // ...but never later than this after the first
let saveTimer = null, firstDirtyAt = 0, saving = false;

function scheduleSave() {
  const now = performance.now();
  if (!saveTimer) firstDirtyAt = now;
  clearTimeout(saveTimer);
  const wait = Math.max(0, Math.min(SAVE_DEBOUNCE, firstDirtyAt + SAVE_MAX_WAIT - now));
  saveTimer = setTimeout(() => { saveTimer = null; save(); }, wait);
  setSaveState('pending');
}

async function save() {
  if (!store.dirty || !store.scene) return;
  if (saving) return;                       // the one in flight re-checks when it lands
  saving = true;
  store.dirty = false;
  const sent = store.scene;
  const sid = sent.id;
  setSaveState('saving');
  try {
    const r = await fetch('/api/scenes/' + encodeURIComponent(sid), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scene: sent, expect_rev: store.rev }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 409 && d.conflict && d.scene) {
      onConflict(d.scene);
    } else if (r.ok && d.ok && d.scene) {
      if (store.scene && store.scene.id === sid) store.rev = d.scene.rev;
      setSaveState(store.dirty ? 'pending' : 'saved');
    } else {
      store.dirty = true;
      setSaveState('error', d.reason || ('HTTP ' + r.status));
    }
  } catch (e) {
    store.dirty = true;
    setSaveState('error', String(e.message || e));
  }
  saving = false;
  if (store.dirty && !saveTimer) scheduleSave();
}

/** Someone else saved first: our change is refused, theirs is loaded. */
function onConflict(serverScene) {
  store.scene = clone(serverScene);
  store.rev = serverScene.rev;
  store.dirty = false;
  store.undo.length = 0;
  store.redo.length = 0;
  pruneSelection();
  renderAll();
  pushPreview();
  setSaveState('conflict');
  toast('This scene was changed somewhere else, so your last change was not saved. The newer version is loaded.');
  announce('The scene was changed elsewhere; the newer version is loaded.');
}

function setSaveState(state, why) {
  const el = $('saveState');
  el.dataset.state = state;
  el.textContent = { saved: 'Saved', saving: 'Saving…', pending: 'Saving…',
                     error: 'Not saved' + (why ? ': ' + why : ''), conflict: 'Reloaded a newer version' }[state] || state;
}

/** Save now and wait for it (before switching scenes, and for tests). */
async function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  for (let i = 0; i < 50 && (saving || store.dirty); i++) {
    if (!saving) await save();
    else await new Promise((r) => setTimeout(r, 20));
  }
}

/* ------------------------------------------------------------- loading */

async function loadScene(id) {
  await flush();
  const r = await fetch('/api/scenes/' + encodeURIComponent(id), { cache: 'no-store' });
  if (!r.ok) { toast('Could not load that scene'); return false; }
  const scene = await r.json();
  store.scene = scene;
  store.rev = scene.rev;
  store.dirty = false;
  store.undo.length = 0;
  store.redo.length = 0;
  store.sel.clear();
  const u = new URL(location.href);
  u.searchParams.set('scene', id);
  history.replaceState(null, '', u);
  $('sceneFrame').src = 'scene.html?id=' + encodeURIComponent(id) + '&preview=1';
  $('emptyState').hidden = true;
  sizeWorld();
  zoomFit();
  renderAll();
  setSaveState('saved');
  return true;
}

$('sceneFrame').addEventListener('load', () => pushPreview());

function pushPreview() {
  const w = $('sceneFrame').contentWindow;
  if (w && store.scene) {
    try { w.postMessage({ type: 'editor-scene', scene: store.scene }, location.origin); } catch (_) { /* loading */ }
  }
}

async function newScene(fmt) {
  const r = await fetch('/api/scenes', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Untitled scene', format: fmt || 'horizontal' }) });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) { toast('Could not make a scene'); return; }
  await refreshScenes();
  await loadScene(d.scene.id);
  announce('Made a new scene');
}

let unreadableTold = false;
async function refreshScenes() {
  const d = await (await fetch('/api/scenes', { cache: 'no-store' })).json();
  store.scenes = d.scenes || [];
  paintScenePick();
  // Scene files no copy of which could be read were set aside at start: said once.
  const bad = d.unreadable || [];
  if (bad.length && !unreadableTold) {
    unreadableTold = true;
    toast(`${bad.length === 1 ? 'A scene file' : bad.length + ' scene files'} could not be read, so ${bad.length === 1 ? 'it was' : 'they were'} set aside`
      + ` in the cache\\scenes folder as ${bad.map((b) => b.kept_as).join(', ')}.`);
  }
}

/* ------------------------------------------------------------- the feed */

let liveNow = { state: 'idle' }, liveScene = '';
function onState(s) {
  inspectorsOnState(s);                 // the deck's designs and fonts, for the inspectors
  studioOnState(s);                     // what is on air, for studio mode and the LIVE panel
  store.scenes = s.scenes || store.scenes;
  paintScenePick();
  liveNow = s.live || liveNow;
  liveScene = (s.canvas || {}).live || '';
  paintLive();
  // Changed somewhere else (the deck renamed it, another editor saved):
  // with nothing of ours pending, take theirs; otherwise the next save
  // conflicts and says so.
  if (store.scene && !store.dirty && !saving) {
    const mine = store.scenes.find((x) => x.id === store.scene.id);
    if (mine && mine.rev > store.rev) {
      fetch('/api/scenes/' + encodeURIComponent(store.scene.id), { cache: 'no-store' }).then((r) => r.json()).then((scene) => {
        if (!store.scene || store.dirty || saving || scene.id !== store.scene.id || scene.rev <= store.rev) return;
        store.scene = scene;
        store.rev = scene.rev;
        store.undo.length = 0;
        store.redo.length = 0;
        pruneSelection();
        renderAll();
        pushPreview();
        announce('The scene was updated elsewhere');
      }).catch(() => {});
    }
  }
}
function connectFeed() {
  let ws;
  try { ws = new WebSocket(`ws://${location.host}/ws/events?page=canvas.html`); } catch (_) { setTimeout(connectFeed, 2000); return; }
  ws.onmessage = (e) => { try { onState(JSON.parse(e.data)); } catch (_) { /* next one */ } };
  ws.onclose = () => setTimeout(connectFeed, 1500);
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}

function paintLive() {
  const el = $('liveStatus');
  const onAir = ['connecting', 'live', 'reconnecting'].includes(liveNow.state);
  const mine = store.scene && liveScene === store.scene.id;
  el.dataset.state = mine && onAir ? 'onair' : mine ? 'scene' : 'idle';
  el.textContent = mine && onAir ? 'LIVE' : mine ? 'Live scene' : onAir ? 'LIVE · another scene' : 'Off air';
}

function paintScenePick() {
  const sel = $('scenePick');
  const cur = store.scene ? store.scene.id : '';
  const sig = JSON.stringify([store.scenes.map((s) => [s.id, s.name]), cur]);
  if (sel.dataset.sig === sig || document.activeElement === sel) return;
  sel.dataset.sig = sig;
  sel.innerHTML = store.scenes.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('') +
    '<option value="__new">+ New scene…</option>';
  sel.value = cur;
}
$('scenePick').addEventListener('change', async () => {
  const v = $('scenePick').value;
  if (v === '__new') { $('scenePick').value = store.scene ? store.scene.id : ''; openNewDialog(); return; }
  if (v && (!store.scene || v !== store.scene.id)) loadScene(v);
});

/* ------------------------------------------------------------- the canvas */

const view = { z: 1, x: 0, y: 0 };
const vp = $('viewport');
function sizeWorld() {
  if (!store.scene) return;
  $('world').style.width = store.scene.width + 'px';
  $('world').style.height = store.scene.height + 'px';
}
function applyView() {
  $('world').style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
  document.documentElement.style.setProperty('--z', String(view.z));
  $('zoomLabel').textContent = Math.round(view.z * 100) + '%';
  vp.setAttribute('aria-label', store.scene
    ? `Canvas, ${store.scene.width} by ${store.scene.height}, zoom ${Math.round(view.z * 100)} percent` : 'Canvas');
  paintHud();
}
function zoomFit() {
  if (!store.scene) return;
  const r = vp.getBoundingClientRect();
  const pad = 48;
  view.z = Math.max(0.05, Math.min((r.width - pad * 2) / store.scene.width, (r.height - pad * 2) / store.scene.height));
  view.x = (r.width - store.scene.width * view.z) / 2;
  view.y = (r.height - store.scene.height * view.z) / 2;
  applyView();
}
/** Zoom to z, keeping the canvas point under (cx, cy) - viewport coordinates - where it is. */
function zoomAt(z, cx, cy) {
  z = Math.max(0.05, Math.min(8, z));
  const r = vp.getBoundingClientRect();
  if (cx === undefined) { cx = r.width / 2; cy = r.height / 2; }
  view.x = cx - (cx - view.x) * (z / view.z);
  view.y = cy - (cy - view.y) * (z / view.z);
  view.z = z;
  applyView();
}
$('zoomFit').addEventListener('click', zoomFit);
$('zoom100').addEventListener('click', () => zoomAt(1));
$('zoomIn').addEventListener('click', () => zoomAt(view.z * 1.25));
$('zoomOut').addEventListener('click', () => zoomAt(view.z / 1.25));
window.addEventListener('resize', () => applyView());

vp.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = vp.getBoundingClientRect();
  zoomAt(view.z * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

// Space + drag (or the middle button) pans.
let spaceDown = false, pan = null;
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !typing(e) && !spaceDown) { spaceDown = true; vp.classList.add('space'); e.preventDefault(); }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { spaceDown = false; vp.classList.remove('space'); }
});
vp.addEventListener('pointerdown', (e) => {
  if (spaceDown || e.button === 1) {
    pan = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    vp.setPointerCapture(e.pointerId);
    vp.classList.add('panning');
    e.preventDefault();
  }
  // Everything else a press on the canvas does is canvastools.js.
});
vp.addEventListener('pointermove', (e) => {
  if (!pan) return;
  view.x = pan.vx + (e.clientX - pan.x);
  view.y = pan.vy + (e.clientY - pan.y);
  applyView();
});
const endPan = () => { pan = null; vp.classList.remove('panning'); };
vp.addEventListener('pointerup', endPan);
vp.addEventListener('pointercancel', endPan);

const ORIGIN = { tl: [0, 0], tc: [0.5, 0], tr: [1, 0], ml: [0, 0.5], mc: [0.5, 0.5], mr: [1, 0.5],
                 bl: [0, 1], bc: [0.5, 1], br: [1, 1] };
/** Is the scene point (x, y) inside the layer's box, its rotation included? */
function contains(l, x, y) {
  const t = l.transform || {};
  const [ox, oy] = ORIGIN[t.anchor] || ORIGIN.tl;
  const px = t.x + ox * t.w, py = t.y + oy * t.h;
  const a = -(t.rotation || 0) * Math.PI / 180;
  const dx = x - px, dy = y - py;
  const rx = px + dx * Math.cos(a) - dy * Math.sin(a), ry = py + dx * Math.sin(a) + dy * Math.cos(a);
  return rx >= t.x && rx <= t.x + t.w && ry >= t.y && ry <= t.y + t.h;
}

function paintOverlay() {
  const s = store.scene;
  $('checker').hidden = !s || (s.transparency !== 'see-through' && (s.background || {}).mode !== 'none');
  paintHud();          // the selection, handles, guides, rulers (canvastools.js)
}

/* ------------------------------------------------------------- selection */

function selectOnly(ids) {
  store.sel = new Set(ids);
  anchorId = ids[ids.length - 1] || null;
  renderAll();
}
function toggleSelect(id) {
  if (store.sel.has(id)) store.sel.delete(id); else store.sel.add(id);
  anchorId = id;
  renderAll();
}
let anchorId = null;
/** Rows in the order the list shows them (top first), for shift-ranges and arrows. */
function displayOrder() {
  return store.scene ? [...store.scene.layers].reverse().map((l) => l.id) : [];
}
function selectRange(toId) {
  const order = displayOrder();
  const a = order.indexOf(anchorId), b = order.indexOf(toId);
  if (a < 0 || b < 0) { selectOnly([toId]); return; }
  const [lo, hi] = a < b ? [a, b] : [b, a];
  store.sel = new Set(order.slice(lo, hi + 1));
  renderAll();
}

/* ------------------------------------------------------------- layer commands */

const LAYER_STYLE = () => ({ opacity: 1, blend: 'normal', radius: 0, border: { w: 0, color: '#ffffff' },
  shadow: { x: 0, y: 0, blur: 0, color: '#000000' }, blur: 0, crop: { t: 0, r: 0, b: 0, l: 0 } });

function makeLayer(type, name, props, w, h) {
  const s = store.scene;
  w = Math.min(w, s.width);
  h = Math.min(h, s.height);
  return { id: newId(), type, name, visible: true, locked: false, group: '',
    transform: { x: Math.round((s.width - w) / 2), y: Math.round((s.height - h) / 2), w, h, rotation: 0, anchor: 'tl' },
    style: LAYER_STYLE(), props: clone(props || {}), triggers: [] };
}
function addLayer(layer) {
  exec('add ' + layer.name, (s) => { s.layers.push(layer); });
  selectOnly([layer.id]);
  announce('Added ' + layer.name);
  return layer.id;
}
function removeLayers(ids) {
  if (!ids.length) return;
  exec(ids.length > 1 ? `delete ${ids.length} layers` : 'delete layer', (s) => {
    s.layers = s.layers.filter((l) => !ids.includes(l.id));
    cleanGroups(s);
  });
  announce(ids.length > 1 ? `Deleted ${ids.length} layers` : 'Deleted the layer');
}
function duplicateLayers(ids) {
  if (!ids.length) return;
  const made = [];
  exec('duplicate', (s) => {
    for (const id of ids) {
      const i = s.layers.findIndex((l) => l.id === id);
      if (i < 0) continue;
      const copy = clone(s.layers[i]);
      copy.id = newId();
      copy.name = (s.layers[i].name + ' copy').slice(0, 80);
      copy.transform.x += 24;
      copy.transform.y += 24;
      s.layers.splice(i + 1 + made.length, 0, copy);
      made.push(copy.id);
    }
  });
  selectOnly(made);
}
function renameLayer(id, name) {
  name = String(name || '').trim().slice(0, 80);
  if (!name) return;
  exec('rename', (s) => { const l = s.layers.find((x) => x.id === id); if (l) l.name = name; }, 'rename:' + id);
}
function setVisible(ids, v) {
  exec(v ? 'show' : 'hide', (s) => { for (const l of s.layers) if (ids.includes(l.id)) l.visible = v; });
}
function setLocked(ids, v) {
  exec(v ? 'lock' : 'unlock', (s) => { for (const l of s.layers) if (ids.includes(l.id)) l.locked = v; });
}
/** Move layers next to a target: 'above' puts them on top of it. */
function moveLayers(ids, targetId, where) {
  exec('reorder', (s) => {
    const moving = s.layers.filter((l) => ids.includes(l.id));
    const rest = s.layers.filter((l) => !ids.includes(l.id));
    let at = rest.findIndex((l) => l.id === targetId);
    at = at < 0 ? rest.length : where === 'above' ? at + 1 : at;
    rest.splice(at, 0, ...moving);
    s.layers = rest;
  });
}
/** Up or down one step, as the list shows it. */
function nudgeOrder(ids, dir) {
  exec('reorder', (s) => {
    const idx = s.layers.map((l, i) => (ids.includes(l.id) ? i : -1)).filter((i) => i >= 0);
    if (dir > 0) {
      for (let k = idx.length - 1; k >= 0; k--) {
        const i = idx[k];
        if (i + 1 < s.layers.length && !ids.includes(s.layers[i + 1].id)) [s.layers[i], s.layers[i + 1]] = [s.layers[i + 1], s.layers[i]];
      }
    } else {
      for (const i of idx) {
        if (i - 1 >= 0 && !ids.includes(s.layers[i - 1].id)) [s.layers[i], s.layers[i - 1]] = [s.layers[i - 1], s.layers[i]];
      }
    }
  });
}
function groupLayers(ids) {
  if (ids.length < 2) { toast('Pick two or more layers to group'); return null; }
  const gid = 'g' + newId().slice(0, 6);
  exec('group', (s) => {
    s.groups = s.groups || {};
    const n = Object.keys(s.groups).length + 1;
    s.groups[gid] = { name: 'Group ' + n };
    // Members sit together, where the topmost of them was.
    const members = s.layers.filter((l) => ids.includes(l.id));
    const top = Math.max(...members.map((l) => s.layers.indexOf(l)));
    const rest = s.layers.filter((l) => !ids.includes(l.id));
    const below = s.layers.slice(0, top + 1).filter((l) => !ids.includes(l.id)).length;
    for (const l of members) l.group = gid;
    rest.splice(below, 0, ...members);
    s.layers = rest;
  });
  announce('Grouped ' + ids.length + ' layers');
  return gid;
}
function ungroupLayers(ids) {
  const gids = new Set(store.scene.layers.filter((l) => ids.includes(l.id) && l.group).map((l) => l.group));
  if (!gids.size) return;
  exec('ungroup', (s) => {
    for (const l of s.layers) if (gids.has(l.group)) l.group = '';
    cleanGroups(s);
  });
  announce('Ungrouped');
}
function renameGroup(gid, name) {
  name = String(name || '').trim().slice(0, 40);
  if (!name) return;
  exec('rename group', (s) => { s.groups = s.groups || {}; s.groups[gid] = Object.assign({}, s.groups[gid], { name }); }, 'rgroup:' + gid);
}
function cleanGroups(s) {
  if (!s.groups) return;
  const used = new Set(s.layers.map((l) => l.group).filter(Boolean));
  for (const g of Object.keys(s.groups)) if (!used.has(g)) delete s.groups[g];
}
function setPath(obj, path, val) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) { if (typeof o[keys[i]] !== 'object' || o[keys[i]] === null) o[keys[i]] = {}; o = o[keys[i]]; }
  o[keys[keys.length - 1]] = val;
}
function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
/** One field of one layer (or the scene, id ''), merged while you keep editing it. */
function setField(id, path, val, label) {
  exec(label || 'edit', (s) => {
    const target = id ? s.layers.find((l) => l.id === id) : s;
    if (target) setPath(target, path, val);
    if (!id && path === 'format' && FORMATS[val]) [s.width, s.height] = FORMATS[val];
  }, 'field:' + id + ':' + path);
}

/* ------------------------------------------------------------- rendering */

function renderAll() {
  const s = store.scene;
  $('undoBtn').disabled = !store.undo.length;
  $('redoBtn').disabled = !store.redo.length;
  $('undoBtn').title = store.undo.length ? `Undo ${store.undo[store.undo.length - 1].label} (Ctrl+Z)` : 'Nothing to undo';
  $('redoBtn').title = store.redo.length ? `Redo ${store.redo[store.redo.length - 1].label} (Ctrl+Shift+Z)` : 'Nothing to redo';
  document.querySelectorAll('#formatSeg button').forEach((b) =>
    b.setAttribute('aria-checked', s && s.format === b.dataset.f ? 'true' : 'false'));
  const hasSel = store.sel.size > 0;
  $('delBtn').disabled = !hasSel;
  $('dupBtn').disabled = !hasSel;
  $('groupBtn').disabled = store.sel.size < 2;
  $('ungroupBtn').disabled = !selected().some((l) => l.group);
  if (s) {
    sizeWorld();
    paintScenePick();
    paintLive();
  }
  renderTree();
  paintOverlay();
  renderInspector();
}

const TYPE_ICON = { text: 'T', image: '▣', shape: '■', component: '♫', camera: '◉', capture: '▭',
                    reactive: '☺', background: '▤' };

function renderTree() {
  const tree = $('layerTree');
  const s = store.scene;
  const focusedKey = document.activeElement && document.activeElement.closest && document.activeElement.closest('#layerTree .row')
    ? document.activeElement.closest('.row').dataset.key : '';
  const editing = tree.querySelector('.row-name input');
  if (editing) return;                      // don't pull the field out from under the typing
  if (!s) { tree.innerHTML = ''; $('treeEmpty').hidden = true; return; }
  $('treeEmpty').hidden = s.layers.length > 0;
  const rows = [];
  const groupsDone = new Set();
  const groups = s.groups || {};
  for (const l of [...s.layers].reverse()) {
    if (l.group) {
      if (groupsDone.has(l.group)) continue;
      groupsDone.add(l.group);
      const members = [...s.layers].reverse().filter((x) => x.group === l.group);
      const open = !collapsed.has(l.group);
      const allHidden = members.every((m) => m.visible === false);
      const allLocked = members.every((m) => m.locked);
      const sel = members.every((m) => store.sel.has(m.id));
      rows.push(`<div class="row group-row${allHidden ? ' is-hidden' : ''}" role="treeitem" aria-level="1" aria-expanded="${open}"
        aria-selected="${sel}" tabindex="-1" data-key="g:${esc(l.group)}" data-group="${esc(l.group)}" draggable="true">
        <button type="button" class="row-btn caret" data-act="caret" aria-label="${open ? 'Collapse' : 'Expand'} group" tabindex="-1">${open ? '▾' : '▸'}</button>
        <span class="row-name">${esc((groups[l.group] || {}).name || 'Group')}</span>
        <button type="button" class="row-btn${allHidden ? '' : ' on'}" data-act="eye" aria-label="${allHidden ? 'Show' : 'Hide'} group" tabindex="-1">${allHidden ? '◌' : '◉'}</button>
        <button type="button" class="row-btn${allLocked ? ' on' : ''}" data-act="lock" aria-label="${allLocked ? 'Unlock' : 'Lock'} group" tabindex="-1">${allLocked ? '🔒' : '🔓'}</button>
      </div>`);
      if (open) for (const m of members) rows.push(layerRow(m, 2));
      continue;
    }
    rows.push(layerRow(l, 1));
  }
  tree.innerHTML = rows.join('');
  // Exactly one row takes Tab: the focused one, else the first selected, else the first.
  const all = [...tree.querySelectorAll('.row')];
  const keep = all.find((r) => r.dataset.key === focusedKey) || all.find((r) => r.getAttribute('aria-selected') === 'true') || all[0];
  if (keep) keep.tabIndex = 0;
  if (focusedKey && keep && keep.dataset.key === focusedKey) keep.focus();
}
function layerRow(l, level) {
  const hidden = l.visible === false;
  const under = zoneHits(l);              // TikTok's controls over it (a phone scene)
  const warn = under.length ? `<span class="row-warn" role="img" title="Under TikTok's ${esc(under.join(' and '))}" aria-label="Under TikTok's ${esc(under.join(' and '))}">⚠</span>` : '';
  return `<div class="row${hidden ? ' is-hidden' : ''}${liveIds.has(l.id) ? ' live-src' : ''}" role="treeitem" aria-level="${level}" aria-selected="${store.sel.has(l.id)}"
    tabindex="-1" data-key="${esc(l.id)}" data-id="${esc(l.id)}" draggable="true" style="--indent:${(level - 1) * 18}px">
    <span class="row-type" aria-hidden="true" title="${esc(l.type)}">${TYPE_ICON[l.type] || '□'}</span>
    <span class="row-name" title="Double-click or F2 to rename">${esc(l.name)}</span>${warn}
    <button type="button" class="row-btn${hidden ? '' : ' on'}" data-act="eye" aria-label="${hidden ? 'Show' : 'Hide'} ${esc(l.name)}" aria-pressed="${!hidden}" tabindex="-1">${hidden ? '◌' : '◉'}</button>
    <button type="button" class="row-btn${l.locked ? ' on' : ''}" data-act="lock" aria-label="${l.locked ? 'Unlock' : 'Lock'} ${esc(l.name)}" aria-pressed="${!!l.locked}" tabindex="-1">${l.locked ? '🔒' : '🔓'}</button>
  </div>`;
}
const rowIds = (row) => (row.dataset.group ? store.scene.layers.filter((l) => l.group === row.dataset.group).map((l) => l.id) : [row.dataset.id]);

const tree = $('layerTree');
tree.addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  const ids = rowIds(row);
  const act = e.target.closest('[data-act]');
  if (act) {
    if (act.dataset.act === 'eye') setVisible(ids, ids.every((id) => layerById(id).visible === false));
    else if (act.dataset.act === 'lock') setLocked(ids, !ids.every((id) => layerById(id).locked));
    else if (act.dataset.act === 'caret') { const g = row.dataset.group; if (collapsed.has(g)) collapsed.delete(g); else collapsed.add(g); renderTree(); }
    return;
  }
  if (e.shiftKey && !row.dataset.group) selectRange(row.dataset.id);
  else if (e.ctrlKey || e.metaKey) { for (const id of ids) toggleSelect(id); }
  else { selectOnly(ids); anchorId = ids[0]; }
  const again = tree.querySelector(`.row[data-key="${CSS.escape(row.dataset.key)}"]`);
  if (again) again.focus();
});
tree.addEventListener('dblclick', (e) => {
  const row = e.target.closest('.row');
  if (row && !e.target.closest('[data-act]')) startRename(row);
});
function startRename(row) {
  const name = row.querySelector('.row-name');
  const old = name.textContent;
  name.innerHTML = `<input class="input" value="${esc(old)}" aria-label="Name" maxlength="80">`;
  const input = name.querySelector('input');
  input.focus();
  input.select();
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    const v = input.value;
    name.textContent = old;
    if (keep && v.trim() && v !== old) {
      if (row.dataset.group) renameGroup(row.dataset.group, v); else renameLayer(row.dataset.id, v);
    } else renderTree();
    const again = tree.querySelector(`.row[data-key="${CSS.escape(row.dataset.key)}"]`);
    if (again) again.focus();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}
// The tree's own keys: arrows move through it, Shift extends, Enter/F2 rename.
tree.addEventListener('keydown', (e) => {
  const row = e.target.closest('.row');
  if (!row || e.target.tagName === 'INPUT') return;
  const rows = [...tree.querySelectorAll('.row')];
  const i = rows.indexOf(row);
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.altKey) {
    e.preventDefault();
    const next = rows[i + (e.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    if (e.shiftKey && !next.dataset.group) { selectRange(next.dataset.id); }
    else selectOnly(rowIds(next));
    const again = tree.querySelector(`.row[data-key="${CSS.escape(next.dataset.key)}"]`);
    if (again) again.focus();
  } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && row.dataset.group) {
    e.preventDefault();
    if (e.key === 'ArrowLeft') collapsed.add(row.dataset.group); else collapsed.delete(row.dataset.group);
    renderTree();
  } else if (e.key === 'Enter' || e.key === 'F2') {
    e.preventDefault();
    startRename(row);
  }
});

// Drag to reorder: a layer, the selection, or a whole group.
let dragIds = null;
tree.addEventListener('dragstart', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  const ids = rowIds(row);
  dragIds = ids.every((id) => store.sel.has(id)) && store.sel.size > ids.length ? [...store.sel] : ids;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragIds.join(','));
});
tree.addEventListener('dragover', (e) => {
  const row = e.target.closest('.row');
  if (!row || !dragIds) return;
  e.preventDefault();
  tree.querySelectorAll('.drop-above, .drop-below').forEach((r) => r.classList.remove('drop-above', 'drop-below'));
  const r = row.getBoundingClientRect();
  row.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-above' : 'drop-below');
});
tree.addEventListener('dragleave', (e) => { const row = e.target.closest('.row'); if (row) row.classList.remove('drop-above', 'drop-below'); });
tree.addEventListener('drop', (e) => {
  const row = e.target.closest('.row');
  tree.querySelectorAll('.drop-above, .drop-below').forEach((r) => r.classList.remove('drop-above', 'drop-below'));
  if (!row || !dragIds) return;
  e.preventDefault();
  const ids = rowIds(row);
  if (ids.some((id) => dragIds.includes(id))) { dragIds = null; return; }
  const above = e.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
  // Above a row = on top of the topmost layer it stands for; below = under its lowest.
  const idx = ids.map((id) => store.scene.layers.findIndex((l) => l.id === id));
  const target = store.scene.layers[above ? Math.max(...idx) : Math.min(...idx)].id;
  moveLayers(dragIds, target, above ? 'above' : 'below');
  dragIds = null;
});
tree.addEventListener('dragend', () => { dragIds = null; });

/* ------------------------------------------------------------- inspector */

let inspSig = '';
function renderInspector() {
  const el = $('inspector');
  const s = store.scene;
  const sel = selected();
  const sig = JSON.stringify([s ? s.id : '', sel.map((l) => l.id)]);
  const rebuild = sig !== inspSig;
  inspSig = sig;
  if (!s) { el.innerHTML = ''; return; }
  if (rebuild) {
    if (!sel.length) el.innerHTML = sceneInspector();
    else if (sel.length === 1) el.innerHTML = layerInspector(sel[0]);
    else el.innerHTML = `<div class="insp"><h2>${sel.length} layers</h2>
      <div class="row-checks">
        <button type="button" class="btn sm" data-multi="show">Show all</button>
        <button type="button" class="btn sm" data-multi="hide">Hide all</button>
        <button type="button" class="btn sm" data-multi="group">Group</button>
      </div>
      <h3>Align</h3>${alignBar(selUnits().length)}
      <h3>Position and size</h3>
      <div class="grid4">${mnum('X', 'transform.x')}${mnum('Y', 'transform.y')}${mnum('W', 'transform.w', 'data-min="1"')}${mnum('H', 'transform.h', 'data-min="1"')}</div>
      <div class="f"><span>Rotation</span><input class="input" ${NUM_ATTRS} data-min="-360" data-max="360" data-mfield="transform.rotation" placeholder="Mixed"></div>
      <div class="f"><span>Opacity</span><input type="range" min="0" max="100" data-mfield="style.opacity" data-scale="100"></div>
      <p class="hint">Number fields take math, for each layer: +20, *2, /2, -=20, or 1920/3.</p></div>`;
    mountInspector(el);            // the sections' own controls (inspectors.js)
  }
  // Values, except in the field being typed in.
  el.querySelectorAll('[data-field]').forEach((node) => {
    if (node === document.activeElement) return;
    const target = node.dataset.layer ? layerById(node.dataset.layer) : s;
    if (!target) return;
    let v = getPath(target, node.dataset.field);
    if (node.dataset.scale) v = Math.round((Number(v) || 0) * Number(node.dataset.scale));
    if (node.type === 'checkbox') node.checked = !!v;
    else if (node.type === 'color') node.value = /^#[0-9a-f]{6}$/i.test(v || '') ? v : '#000000';
    else node.value = v ?? '';
  });
  el.querySelectorAll('[data-mfield]').forEach((node) => {
    if (node === document.activeElement || !sel.length) return;
    if (node.dataset.kind === 'num') { numShow(node); return; }        // blank when they differ
    const v = getPath(sel[0], node.dataset.mfield);
    node.value = Math.round((Number(v) || 0) * Number(node.dataset.scale || 1));
  });
  syncInspector(el);
}
// Number fields are text, so they can take math (see numCommit).
const NUM_ATTRS = 'type="text" inputmode="decimal" autocomplete="off" spellcheck="false" data-kind="num"';
const num = (label, field, id, extra = '') =>
  `<label><span>${label}</span><input class="input" ${NUM_ATTRS} data-layer="${esc(id)}" data-field="${field}" ${extra}></label>`;
const mnum = (label, field, extra = '') =>
  `<label><span>${label}</span><input class="input" ${NUM_ATTRS} data-mfield="${field}" placeholder="Mixed" ${extra}></label>`;
function sel_(field, id, opts, label) {
  return `<div class="f"><span>${label}</span><select class="input" data-layer="${esc(id)}" data-field="${field}">` +
    opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('') + '</select></div>';
}
function sceneInspector() {
  return `<div class="insp"><h2>Scene <span class="tag">${store.scene.width} × ${store.scene.height}</span></h2>
    <div class="f"><span>Name</span><input class="input" data-layer="" data-field="name" maxlength="80"></div>
    ${sceneFormatSection()}
    ${sceneBackgroundSection()}
    <h3>Transparency</h3>
    ${sel_('transparency', '', [['opaque', 'Opaque'], ['see-through', 'See-through'], ['key', 'Key color']], 'Output')}
    <div class="f"><span>Key color</span><input type="color" data-layer="" data-field="key_color"></div>
    ${sceneShareSection()}
    <p class="hint">Nothing selected: these are the scene's own settings. Pick a layer on the canvas or in the list to edit it.</p></div>`;
}
/* One layer: where it is, then its own sections (inspectors.js) - what it
   shows, its look and effects, a border loop, animation and triggers. */
function layerInspector(l) {
  const id = l.id;
  return `<div class="insp"><h2><span>${esc(l.name)}</span><span class="tag">${esc(TYPE_NAME[l.type] || l.type)}</span></h2>
    <p class="insp-live" data-live-note hidden></p>
    <p class="insp-warn" data-zone-note hidden></p>
    <div class="f"><span>Name</span><input class="input" data-layer="${esc(id)}" data-field="name" maxlength="80"></div>
    <h3>Position and size</h3>
    <div class="grid4">${num('X', 'transform.x', id)}${num('Y', 'transform.y', id)}${num('W', 'transform.w', id, 'data-min="1"')}${num('H', 'transform.h', id, 'data-min="1"')}</div>
    <div class="f"><span>Rotation</span><input class="input" ${NUM_ATTRS} data-min="-360" data-max="360" data-layer="${esc(id)}" data-field="transform.rotation"></div>
    <h3>Align to the canvas</h3>${alignBar(1)}
    <div class="row-checks">
      <label><input type="checkbox" data-layer="${esc(id)}" data-field="visible"> Visible</label>
      <label><input type="checkbox" data-layer="${esc(id)}" data-field="locked"> Locked</label>
    </div>
    ${typeSections(l)}${commonSections(l)}</div>`;
}
$('inspector').addEventListener('input', (e) => {
  const node = e.target;
  if (node.dataset.kind === 'num') {
    // A plain number applies as it is typed; math waits for Enter or leaving the field.
    if (isPlainNum(node.value)) applyNum(node, () => Number(node.value));
    return;
  }
  if (node.dataset.mfield) {
    const v = Number(node.value) / Number(node.dataset.scale || 1);
    const ids = [...store.sel];
    exec('edit', (s) => { for (const l of s.layers) if (ids.includes(l.id)) setPath(l, node.dataset.mfield, v); }, 'mfield:' + node.dataset.mfield);
    return;
  }
  if (!node.dataset.field) return;
  let v = node.type === 'checkbox' ? node.checked : node.value;
  if (node.dataset.scale) v = Number(node.value) / Number(node.dataset.scale);
  if (node.dataset.field === 'props.weight') v = Number(v);
  setField(node.dataset.layer || '', node.dataset.field, v);
  if (node.dataset.field === 'name' && node.dataset.layer) renderTree();
});
$('inspector').addEventListener('change', (e) => {
  // Selects and checkboxes land here only (inputs saved on input already).
  const node = e.target;
  if (node.dataset.kind === 'num') { numCommit(node); return; }
  if (node.tagName === 'SELECT' || node.type === 'checkbox') node.dispatchEvent(new Event('input', { bubbles: true }));
});

/* Number fields take math: a value ("120", "-20"), a sum ("1920/3"), or a
   change to what the field held when you came to it: "+20", "*2", "/2",
   "-=20". With several layers selected, the change is made to each one's
   own value ("*2" doubles each width). Up/Down step by 1 (Shift 10, Alt
   0.1); Esc puts back what was there. */
const isPlainNum = (v) => /^\s*-?(\d+\.?\d*|\.\d+)\s*$/.test(v);
function numTargets(node) {
  return node.dataset.mfield ? [...store.sel].map((id) => ({ id, path: node.dataset.mfield }))
    : [{ id: node.dataset.layer || '', path: node.dataset.field }];
}
function numNow(id, path) {
  const t = id ? layerById(id) : store.scene;
  return t ? Number(getPath(t, path)) || 0 : 0;
}
/** fn(id, current) for each layer the field stands for, as one command (merged while the field is worked on). */
function applyNum(node, fn) {
  const lo = node.dataset.min !== undefined ? Number(node.dataset.min) : -Infinity;
  const hi = node.dataset.max !== undefined ? Number(node.dataset.max) : Infinity;
  const targets = numTargets(node);
  const key = node.dataset.mfield ? 'mfield:' + node.dataset.mfield : 'field:' + (node.dataset.layer || '') + ':' + node.dataset.field;
  return exec('edit', (s) => {
    for (const { id, path } of targets) {
      const t = id ? s.layers.find((l) => l.id === id) : s;
      if (!t) continue;
      const v = fn(id, Number(getPath(t, path)) || 0);
      if (v === null || !Number.isFinite(v)) continue;
      setPath(t, path, Math.round(Math.min(hi, Math.max(lo, v)) * 100) / 100);
    }
  }, key);
}
function numBase(node) { node._base = new Map(numTargets(node).map(({ id, path }) => [id, numNow(id, path)])); }
function numShow(node) {
  const vals = numTargets(node).map(({ id, path }) => numNow(id, path));
  node.value = vals.length && vals.every((v) => v === vals[0]) ? String(vals[0]) : '';
}
function numCommit(node) {
  const text = node.value;
  if (text.trim() && !isPlainNum(text)) {
    const base = node._base || new Map();
    if (Snap.evalField(text, 1) === null) {
      node.setAttribute('aria-invalid', 'true');
      announce('That is not a number or a sum');
      return;
    }
    applyNum(node, (id, cur) => Snap.evalField(text, base.has(id) ? base.get(id) : cur));
  }
  node.removeAttribute('aria-invalid');
  numShow(node);
  numBase(node);
}
$('inspector').addEventListener('focusin', (e) => { if (e.target.dataset.kind === 'num') numBase(e.target); });
$('inspector').addEventListener('keydown', (e) => {
  const node = e.target;
  if (node.dataset.kind !== 'num') return;
  if (e.key === 'Enter') { e.preventDefault(); numCommit(node); node.select(); }
  else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    const base = node._base;
    if (base) applyNum(node, (id, cur) => (base.has(id) ? base.get(id) : cur));
    node.removeAttribute('aria-invalid');
    numShow(node);
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
    applyNum(node, (id, cur) => cur + d);
    numShow(node);
    numBase(node);
  }
});
$('inspector').addEventListener('click', (e) => {
  const b = e.target.closest('[data-multi]');
  if (!b) return;
  const ids = [...store.sel];
  if (b.dataset.multi === 'show') setVisible(ids, true);
  if (b.dataset.multi === 'hide') setVisible(ids, false);
  if (b.dataset.multi === 'group') groupLayers(ids);
});

/* ------------------------------------------------------------- sources */

const ADD = [
  { type: 'text', label: 'Text', sub: 'words, live song info', w: 900, h: 140,
    props: { text: 'Your text', size: 72, weight: 700, color: '#ffffff', align: 'center', valign: 'center',
             shadow: { x: 0, y: 2, blur: 12, color: 'rgba(0,0,0,.6)' } } },
  { type: 'shape', label: 'Shape', sub: 'box, ellipse, line, frame', w: 480, h: 280, props: { kind: 'rect', fill: '#8b5cf6' } },
  { type: 'image', label: 'Image or video', sub: 'from Assets', w: 640, h: 360, props: { src: '', fit: 'cover' } },
  { type: 'camera', label: 'Camera', sub: 'your webcam', w: 480, h: 360,
    props: { width: 1280, height: 720, fps: 30, mirror: true, mask: 'rounded' } },
  { type: 'component', label: 'Now Playing', sub: 'the track window', w: 760, h: 190, props: { component: 'np', design: 'linked', options: {} } },
  { type: 'component', label: 'Lyrics', sub: 'the words', w: 560, h: 320, props: { component: 'lyrics', design: 'linked', options: {} } },
  { type: 'component', label: 'Queue', sub: 'up next', w: 420, h: 320, props: { component: 'queue', design: 'linked', options: {} } },
  { type: 'component', label: 'Captions', sub: 'what you say', w: 900, h: 200, props: { component: 'captions', design: 'linked', options: {} } },
  { type: 'reactive', label: 'Reactive image', sub: 'talks when you do', w: 360, h: 360, props: { idle: '', talking: '', blink: '', bounce: true } },
  { type: 'background', label: 'Background layer', sub: 'a full-size fill', w: 99999, h: 99999, props: { mode: 'solid', color: '#1a1030' } },
];
$('addGrid').innerHTML = ADD.map((a, i) =>
  `<button type="button" class="btn" data-add="${i}"><span>${esc(a.label)}</span><small>${esc(a.sub)}</small></button>`).join('');
$('addGrid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-add]');
  if (!b || !store.scene) return;
  const a = ADD[+b.dataset.add];
  addLayer(makeLayer(a.type, a.label, a.props, a.w, a.h));
});

async function loadCaptureSources() {
  const list = $('captureList');
  list.innerHTML = '<p class="hint">Loading&hellip;</p>';
  let d;
  try { d = await (await fetch('/api/capture/sources', { cache: 'no-store' })).json(); } catch (_) { d = { windows: [], monitors: [] }; }
  const mons = (d.monitors || []).map((m, i) => ({ kind: 'monitor', i, title: m.name || `Screen ${i + 1}`,
    thumb: `/api/capture/thumb?monitor=${i}` }));
  const wins = (d.windows || []).filter((w) => w.title).slice(0, 40).map((w) => ({ kind: 'window', title: w.title,
    thumb: w.hwnd ? `/api/capture/thumb?hwnd=${w.hwnd}` : '' }));
  const items = [...mons, ...wins];
  list.innerHTML = items.length ? items.map((it, k) =>
    `<button type="button" class="btn src" data-src="${k}" title="${esc(it.title)}">` +
    (it.thumb ? `<img loading="lazy" alt="" src="${esc(it.thumb)}">` : '<span class="noimg"></span>') +
    `<span>${esc(it.title)}</span></button>`).join('') : '<p class="hint">No windows to capture.</p>';
  list.onclick = (e) => {
    const b = e.target.closest('[data-src]');
    if (!b || !store.scene) return;
    const it = items[+b.dataset.src];
    const source = it.kind === 'monitor' ? { kind: 'monitor', monitor: it.i } : { kind: 'window', title: it.title };
    const full = it.kind === 'monitor';
    addLayer(makeLayer('capture', it.title.slice(0, 60), { mode: 'native', source, fps: 30, fit: 'contain' },
      full ? store.scene.width : Math.round(store.scene.width * 0.7), full ? store.scene.height : Math.round(store.scene.height * 0.7)));
  };
}
$('refreshSources').addEventListener('click', loadCaptureSources);

/* ------------------------------------------------------------- assets */

let assets = [];
async function loadAssets() {
  try { assets = (await (await fetch('/api/assets', { cache: 'no-store' })).json()).assets || []; } catch (_) { assets = []; }
  const grid = $('assetGrid');
  grid.innerHTML = assets.length ? assets.map((a, i) =>
    `<button type="button" class="btn asset" data-asset="${i}" title="${esc(a.name)}">` +
    (a.kind === 'video' && !a.thumb ? `<video muted preload="metadata" src="${esc(a.url)}"></video>` : `<img loading="lazy" alt="" src="${esc(a.thumb || a.url)}">`) +
    `<span>${esc(a.name)}</span></button>`).join('') : '<p class="hint">No pictures yet &mdash; upload one.</p>';
}
$('assetGrid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-asset]');
  if (!b || !store.scene) return;
  const a = assets[+b.dataset.asset];
  const one = selected();
  // With one picture layer selected, the asset replaces its picture.
  if (one.length === 1 && one[0].type === 'image') { setField(one[0].id, 'props.src', a.id, 'set picture'); return; }
  addLayer(makeLayer('image', a.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 60) || 'Picture', { src: a.id, fit: 'cover' }, 640, 360));
});
$('uploadBtn').addEventListener('click', () => $('uploadInput').click());
$('uploadInput').addEventListener('change', () => {
  const f = $('uploadInput').files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = async () => {
    const r = await fetch('/api/assets/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: f.name, data: rd.result }) });
    const d = await r.json().catch(() => ({}));
    if (!d.ok) toast(d.reason || 'Could not upload that');
    $('uploadInput').value = '';
    loadAssets();
  };
  rd.readAsDataURL(f);
});

/* ------------------------------------------------------------- panels */

const TABS = ['Layers', 'Sources', 'Assets'];
function showTab(name, focus) {
  for (const t of TABS) {
    const on = t === name;
    const tab = $('tab' + t);
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    tab.tabIndex = on ? 0 : -1;
    $('pane' + t).hidden = !on;
    if (on && focus) tab.focus();
  }
  if (name === 'Sources' && !$('captureList').dataset.loaded) { $('captureList').dataset.loaded = '1'; loadCaptureSources(); }
  if (name === 'Assets') loadAssets();
}
document.querySelector('.tabs').addEventListener('click', (e) => {
  const t = e.target.closest('[role="tab"]');
  if (t) showTab(t.id.slice(3));
});
document.querySelector('.tabs').addEventListener('keydown', (e) => {
  const i = TABS.indexOf(document.activeElement.id.slice(3));
  if (i < 0) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    showTab(TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length], true);
  }
});

/* ------------------------------------------------------------- top bar */

$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);
$('formatSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-f]');
  if (!b || !store.scene || store.scene.format === b.dataset.f) return;
  switchFormat(b.dataset.f);          // the layers laid out again too (newscene.js)
});
$('openOutput').addEventListener('click', () => {
  if (!store.scene) return;
  fetch('/api/components/' + encodeURIComponent('scene:' + store.scene.id) + '/open', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: '{}' })
    .then((r) => r.json()).then((d) => { if (!d.ok) toast(d.reason || 'Could not open the output window'); })
    .catch(() => toast('Could not open the output window'));
});
$('groupBtn').addEventListener('click', () => groupLayers([...store.sel]));
$('ungroupBtn').addEventListener('click', () => ungroupLayers([...store.sel]));
$('dupBtn').addEventListener('click', () => duplicateLayers([...store.sel]));
$('delBtn').addEventListener('click', () => removeLayers([...store.sel]));
$('emptyNew').addEventListener('click', () => openNewDialog());

/* ------------------------------------------------------------- keys */

const typing = (e) => {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
};
let lastFocus = null;
function openShortcuts() {
  lastFocus = document.activeElement;
  $('shortcuts').hidden = false;
  $('shortcutsClose').focus();
}
function closeShortcuts() {
  $('shortcuts').hidden = true;
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}
$('helpBtn').addEventListener('click', openShortcuts);
$('shortcutsClose').addEventListener('click', closeShortcuts);
$('shortcuts').addEventListener('click', (e) => { if (e.target === $('shortcuts')) closeShortcuts(); });
$('shortcuts').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeShortcuts(); }
  if (e.key === 'Tab') { e.preventDefault(); $('shortcutsClose').focus(); }     // one control: focus stays in the dialog
});

window.addEventListener('keydown', (e) => {
  if (!$('shortcuts').hidden) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (ctrl && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if (ctrl && ((k === 'z' && e.shiftKey) || k === 'y')) { e.preventDefault(); redo(); return; }
  if (ctrl && k === '0') { e.preventDefault(); zoomFit(); return; }
  if (ctrl && k === '1') { e.preventDefault(); zoomAt(1); return; }
  if (ctrl && (k === '=' || k === '+')) { e.preventDefault(); zoomAt(view.z * 1.25); return; }
  if (ctrl && k === '-') { e.preventDefault(); zoomAt(view.z / 1.25); return; }
  if (typing(e)) return;
  const ids = [...store.sel];
  if (ctrl && k === 'a') { e.preventDefault(); selectOnly(displayOrder()); return; }
  if (ctrl && k === 'd') { e.preventDefault(); duplicateLayers(ids); return; }
  if (ctrl && k === 'g' && !e.shiftKey) { e.preventDefault(); groupLayers(ids); return; }
  if (ctrl && k === 'g' && e.shiftKey) { e.preventDefault(); ungroupLayers(ids); return; }
  if (ctrl) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { if (ids.length) { e.preventDefault(); removeLayers(ids); } return; }
  if (e.key === 'Escape') { selectOnly([]); return; }
  if (e.key === '?') { e.preventDefault(); openShortcuts(); return; }
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { if (ids.length) { e.preventDefault(); nudgeOrder(ids, e.key === 'ArrowUp' ? 1 : -1); } return; }
  if (k === 'h' && ids.length) { setVisible(ids, selected().every((l) => l.visible === false)); return; }
  if (k === 'l' && ids.length) { setLocked(ids, !selected().every((l) => l.locked)); return; }
  if (e.key === 'F2' && ids.length === 1) {
    e.preventDefault();
    showTab('Layers');
    const row = tree.querySelector(`.row[data-id="${CSS.escape(ids[0])}"]`);
    if (row) startRename(row);
  }
});
window.addEventListener('beforeunload', (e) => { if (store.dirty || saving) { save(); e.preventDefault(); } });

/* ------------------------------------------------------------- small UI */

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5200);
}
function announce(msg) { $('announce').textContent = msg; }

/* The deck's own look: its colors, corners and font. */
function applyTheme(ui) {
  if (!ui) return;
  const r = document.documentElement.style;
  const map = { bg: '--bg', panel: '--panel', border: '--line', text: '--fg', muted: '--dim', accent: '--accent' };
  for (const [k, v] of Object.entries(map)) if (/^#[0-9a-f]{3,8}$/i.test(ui[k] || '')) r.setProperty(v, ui[k]);
  if (Number(ui.radius) >= 0) r.setProperty('--radius', Number(ui.radius) + 'px');
  if (ui.font) r.setProperty('--font', `"${String(ui.font).replace(/"/g, '')}", "Segoe UI", system-ui, sans-serif`);
}

/* ------------------------------------------------------------- boot */

(async () => {
  try { applyTheme((await (await fetch('/api/config')).json()).ui); } catch (_) { /* default look */ }
  await refreshScenes();
  const want = Q.get('scene');
  const pick = (want && store.scenes.find((s) => s.id === want)) || store.scenes[0];
  if (pick) await loadScene(pick.id);
  else { $('emptyState').hidden = false; renderAll(); }
  connectFeed();
  vp.focus({ preventScroll: true });
})();
window.addEventListener('resize', () => { if (store.scene && !pan) applyView(); });

/* For tests: the store, and the same commands the UI runs. */
window.Editor = {
  scene: () => clone(store.scene),
  rev: () => store.rev,
  history: () => ({ undo: store.undo.length, redo: store.redo.length, labels: store.undo.map((c) => c.label) }),
  selection: () => [...store.sel],
  saveState: () => ({ state: $('saveState').dataset.state, dirty: store.dirty, saving }),
  view: () => ({ ...view }),
  select: selectOnly, add: (i) => { const a = ADD[i]; return addLayer(makeLayer(a.type, a.label, a.props, a.w, a.h)); },
  rename: renameLayer, setField, setVisible, setLocked, move: moveLayers, nudge: nudgeOrder,
  group: groupLayers, ungroup: ungroupLayers, duplicate: duplicateLayers, remove: removeLayers,
  undo, redo, flush, load: loadScene,
};
