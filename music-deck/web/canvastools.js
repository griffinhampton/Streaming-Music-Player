/* Canvas tools (P8): direct manipulation on the Canvas Builder's canvas.

   Select (click, Shift/Ctrl+click, a box dragged on empty canvas), move,
   resize from eight handles and rotate from a knob, with snapping and smart
   guides; rulers, and guides the scene keeps; a grid; TikTok's safe zones;
   align, distribute and arrange; nudging; copy and paste between scenes;
   right-click menus. Every gesture is one undo step: the scene before it and
   after it (canvas.js recordGesture). While it runs the working copy moves
   live in the preview - and in an open output, the autosave following the
   drag.

   Pointer math: a scene position is (client - viewport corner - pan) / zoom.
   Client coordinates are CSS pixels, so the screen's scale (the deck at
   150%) never enters it. Handles, guides and rulers are drawn in screen
   space (#hud), the same size at any zoom; the grid and safe zones in scene
   space (#overlay), under them.

   Modifiers: moving - Shift keeps to one axis, Alt (or Ctrl) skips
   snapping. Resizing - Shift keeps the shape, Alt resizes from the center,
   Ctrl skips snapping. Rotating - Shift turns in 15 degree steps. */
'use strict';

const SNAP_PX = 6;          // snapping reach, in screen pixels
const DRAG_PX = 3;          // a press becomes a drag past this
const ROT_OFF = 26;         // the rotate knob, above the box, in screen pixels
const RULER = 20;           // ruler thickness
const HANDLES = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
const HANDLE_ANGLE = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 };
const RESIZE_CURSORS = ['ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize'];
const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
const CLIP_KIND = 'awesome-canvas-layers';
const CLIP_MIME = 'application/x-awesome-canvas';

/* ------------------------------------------------------------- view choices */

// Not part of the scene: how this editor shows it (the guides are the scene's).
const PREFS_KEY = 'cb-view';
const prefs = Object.assign({ snap: true, grid: false, gridSize: 40, rulers: true, safe: true },
  (() => { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch (_) { return {}; } })());
function setPref(k, v) {
  prefs[k] = v;
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_) { /* private window */ }
  paintPrefs();
  paintOverlay();
}
const PREF_BUTTONS = [['snapBtn', 'snap', 'Snapping'], ['gridBtn', 'grid', 'Grid'], ['rulersBtn', 'rulers', 'Rulers'], ['safeBtn', 'safe', 'Safe zones']];
function paintPrefs() {
  for (const [id, k] of PREF_BUTTONS) $(id).setAttribute('aria-pressed', String(!!prefs[k]));
  const gs = $('gridSize'), size = String(prefs.gridSize);
  if (![...gs.options].some((o) => o.value === size)) gs.add(new Option(size, size));
  gs.value = size;
  $('gridSize').disabled = !prefs.grid;
  $('safeBtn').disabled = !zonesOf(store.scene).length;
}
for (const [id, k, name] of PREF_BUTTONS) {
  $(id).addEventListener('click', () => { setPref(k, !prefs[k]); announce(`${name} ${prefs[k] ? 'on' : 'off'}`); });
}
$('gridSize').addEventListener('change', () => setPref('gridSize', Number($('gridSize').value) || 40));

let safeZones = {};
fetch('/api/scenes/formats').then((r) => r.json()).then((d) => { safeZones = d.safe_zones || {}; paintPrefs(); paintOverlay(); }).catch(() => {});
const zonesOf = (s) => (s ? safeZones[s.format] || [] : []);
const zonesNow = () => (prefs.safe ? zonesOf(store.scene) : []);

/* ------------------------------------------------------------- geometry */

const rad = (d) => (d * Math.PI) / 180;
/** The scene point under a client point. */
function toScene(cx, cy) {
  const r = vp.getBoundingClientRect();
  return { x: (cx - r.left - view.x) / view.z, y: (cy - r.top - view.y) / view.z };
}
/** A scene point on screen, in viewport pixels. */
const scr = (p) => ({ x: view.x + p.x * view.z, y: view.y + p.y * view.z });
/** The scene position of a point given as fractions of a box, its rotation and anchor included. */
function pointOf(t, fx, fy) {
  const [ox, oy] = ORIGIN[t.anchor] || ORIGIN.tl;
  const a = rad(t.rotation || 0), c = Math.cos(a), s = Math.sin(a);
  const lx = (fx - ox) * t.w, ly = (fy - oy) * t.h;
  return { x: t.x + ox * t.w + lx * c - ly * s, y: t.y + oy * t.h + lx * s + ly * c };
}
/** A box of w x h (rotated, on t's anchor) placed so its point (fx, fy) lands on the scene point P. */
function placeAt(t, w, h, fx, fy, P, rotation = t.rotation || 0) {
  const [ox, oy] = ORIGIN[t.anchor] || ORIGIN.tl;
  const a = rad(rotation), c = Math.cos(a), s = Math.sin(a);
  const lx = (fx - ox) * w, ly = (fy - oy) * h;
  return { x: P.x - (lx * c - ly * s) - ox * w, y: P.y - (lx * s + ly * c) - oy * h, w, h, rotation };
}
const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const inBox = (b, p) => !!b && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
const normDeg = (d) => { d = ((d % 360) + 540) % 360 - 180; return Math.round((d === -180 ? 180 : d) * 10) / 10; };
const rpos = (v, rotated) => (rotated ? Math.round(v * 100) / 100 : Math.round(v));

/* What a click on a layer picks: its whole group, or the layer. Background
   layers fill the canvas, so they are picked in the layer list, not here -
   dragging on them draws a selection box. */
function unitOf(l) {
  return l.group ? store.scene.layers.filter((m) => m.group === l.group).map((m) => m.id) : [l.id];
}
function hitLayer(p) {
  return [...store.scene.layers].reverse().find((l) =>
    l.visible !== false && !l.locked && l.type !== 'background' && contains(l, p.x, p.y)) || null;
}
/** The selection as units: a group chosen whole moves, aligns and spaces as one. Locked layers stay put. */
function selUnits(ids = [...store.sel]) {
  const s = store.scene;
  if (!s) return [];
  const units = new Map();
  for (const l of s.layers) {
    if (!ids.includes(l.id) || l.locked) continue;
    const whole = l.group && s.layers.every((m) => m.group !== l.group || ids.includes(m.id));
    const k = whole ? 'g:' + l.group : l.id;
    if (!units.has(k)) units.set(k, []);
    units.get(k).push(l);
  }
  return [...units.values()].map((ls) => ({ ls, box: Snap.union(ls.map((l) => Snap.boundsOf(l.transform))) }));
}
function selBox() {
  const ls = selected().filter((l) => !l.locked);
  return ls.length ? Snap.union(ls.map((l) => Snap.boundsOf(l.transform))) : null;
}
function othersThan(ids) {
  return store.scene.layers.filter((l) => !ids.includes(l.id) && l.visible !== false && l.type !== 'background')
    .map((l) => Snap.boundsOf(l.transform));
}
function selectAdd(ids) { for (const id of ids) store.sel.add(id); anchorId = ids[ids.length - 1] || anchorId; renderAll(); }
function selectRemove(ids) { for (const id of ids) store.sel.delete(id); renderAll(); }

/* ------------------------------------------------------------- gestures */

let press = null;       // a button held on the canvas that has not moved far yet
let gesture = null;     // a drag under way: move, resize, rotate, guide, marquee
let hoverId = null;
let lastEv = null;
let frameReq = 0;

vp.addEventListener('pointerdown', (e) => {
  if (pan || spaceDown || e.button !== 0 || !store.scene) return;
  closeMenu(false);
  const t = e.target;
  const p = toScene(e.clientX, e.clientY);
  vp.focus({ preventScroll: true });              // an inspector field being typed in commits
  vp.setPointerCapture(e.pointerId);
  e.preventDefault();
  lastEv = e;
  hoverId = null;
  if (t.id === 'rulerX' || t.id === 'rulerY') { gesture = startGuide(t.id === 'rulerX' ? 'h' : 'v', -1, p); paintOverlay(); return; }
  if (t.closest('.ruler-corner')) return;
  const handle = t.closest('[data-handle]');
  if (handle) { gesture = startTransform(handle.dataset.handle, p); paintOverlay(); return; }
  const guide = t.closest('[data-guide]');
  if (guide) { gesture = startGuide(guide.dataset.guide, Number(guide.dataset.i), p); paintOverlay(); return; }
  const hit = hitLayer(p);
  const add = e.shiftKey || e.ctrlKey || e.metaKey;
  let wasSel = false;
  if (hit) {
    const unit = unitOf(hit);
    wasSel = unit.every((id) => store.sel.has(id));
    if (!wasSel) { if (add) selectAdd(unit); else selectOnly(unit); }
  }
  press = { x: e.clientX, y: e.clientY, p, hit: hit ? hit.id : null, wasSel, add,
            inside: !hit && !add && inBox(selBox(), p), base: [...store.sel] };
});

vp.addEventListener('pointermove', (e) => {
  if (pan) return;
  lastEv = e;
  if (press && !gesture) {
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_PX) return;
    gesture = press.hit || press.inside ? startMove(press) : startMarquee(press);
    if (!gesture) { press = null; return; }
  }
  schedule();
});
/* One step per frame. A page with no frames (behind other windows) still
   gets its steps, from the timer, so a drag always reaches an open output. */
let frameTimer = 0;
function schedule() {
  if (frameReq) return;
  frameReq = requestAnimationFrame(onFrame);
  frameTimer = setTimeout(onFrame, 50);
}
function onFrame() {
  cancelAnimationFrame(frameReq);
  clearTimeout(frameTimer);
  frameReq = 0;
  if (gesture) { if (lastEv) step(lastEv); return; }
  if (!press && lastEv) hover(lastEv);
}
vp.addEventListener('pointerleave', () => { if (hoverId && !gesture) { hoverId = null; paintOverlay(); } });
vp.addEventListener('pointerup', (e) => endPress(e, false));
vp.addEventListener('pointercancel', (e) => endPress(e, true));
vp.addEventListener('lostpointercapture', (e) => { if (gesture || press) endPress(e, false); });
window.addEventListener('blur', () => { if (gesture) { finishGesture(); press = null; } });

function endPress(e, cancelled) {
  if (frameReq) { cancelAnimationFrame(frameReq); clearTimeout(frameTimer); frameReq = 0; }
  if (gesture) {
    if (cancelled) cancelGesture();
    else { step(e); finishGesture(); }
  } else if (press) {
    // A click, not a drag.
    const pr = press;
    const l = pr.hit && layerById(pr.hit);
    if (l && pr.wasSel) {
      const unit = unitOf(l);
      if (pr.add) selectRemove(unit);
      else if (store.sel.size !== unit.length) selectOnly(unit);
    } else if (!l && !pr.add) selectOnly([]);
  }
  press = null;
  try { vp.releasePointerCapture(e.pointerId); } catch (_) { /* already gone */ }
}

// Double-click a grouped layer: just that layer, out of its group.
vp.addEventListener('dblclick', (e) => {
  if (!store.scene) return;
  const hit = hitLayer(toScene(e.clientX, e.clientY));
  if (hit && hit.group) selectOnly([hit.id]);
});

function hover(e) {
  const t = e.target;
  const over = t.closest && t.closest('[data-handle], [data-guide], .ruler, .ruler-corner');
  const l = over || !store.scene ? null : hitLayer(toScene(e.clientX, e.clientY));
  const id = l ? l.id : null;
  if (id !== hoverId) { hoverId = id; paintOverlay(); }
}

/** One step of the drag under way, at the pointer (and modifiers) of e. */
function step(e) {
  const g = gesture;
  if (!g) return;
  if (store.scene !== g.scene) { gesture = null; press = null; paintOverlay(); return; }    // replaced under us: a conflict, an undo
  const p = toScene(e.clientX, e.clientY);
  const m = { shift: !!e.shiftKey, alt: !!e.altKey, ctrl: !!(e.ctrlKey || e.metaKey) };
  if (g.kind === 'marquee') { stepMarquee(g, p); return; }
  if (g.kind === 'move') stepMove(g, p, m);
  else if (g.kind === 'resize') stepResize(g, p, m);
  else if (g.kind === 'rotate') stepRotate(g, p, m);
  else if (g.kind === 'guide') stepGuide(g, p, m, e);
  g.pointer = scr(p);
  liveEdit();
}
/* The working copy changed mid-drag: the canvas, the inspector, the preview,
   and a save (so an open output follows). No command yet - that is made
   once, when the drag ends. */
function liveEdit() {
  store.dirty = true;
  paintOverlay();
  renderInspector();
  pushPreview();
  scheduleSave();
}
function finishGesture() {
  const g = gesture;
  gesture = null;
  if (!g) return;
  if (g.kind === 'marquee') { paintOverlay(); return; }
  if (store.scene !== g.scene) { paintOverlay(); return; }
  if (g.finish) g.finish(g);
  recordGesture(g.label, g.before);
  paintOverlay();
}
function cancelGesture() {
  const g = gesture;
  gesture = null;
  press = null;
  if (!g) return;
  if (g.kind === 'marquee') { store.sel = new Set(g.base); renderAll(); return; }
  if (store.scene !== g.scene) return;
  store.scene = clone(g.before);
  store.dirty = true;
  renderAll();
  pushPreview();
  scheduleSave();
  announce('Cancelled');
}
/** The modifiers changed with the pointer still: take the step again with them. */
function restep(e) {
  if (!gesture || !lastEv) return;
  step({ clientX: lastEv.clientX, clientY: lastEv.clientY, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey });
}

/* ---- move */

function startMove(pr) {
  const ls = selUnits().flatMap((u) => u.ls);
  if (!ls.length) return null;
  const ids = ls.map((l) => l.id);
  const others = othersThan(ids);
  return { kind: 'move', label: ids.length > 1 ? `move ${ids.length} layers` : 'move', scene: store.scene,
    before: clone(store.scene), p0: pr.p, ids, others, hits: [],
    starts: new Map(ls.map((l) => [l.id, { x: l.transform.x, y: l.transform.y }])),
    box0: Snap.union(ls.map((l) => Snap.boundsOf(l.transform))),
    tg: Snap.targets(store.scene, others, { safeZones: zonesNow() }) };
}
function stepMove(g, p, m) {
  let dx = p.x - g.p0.x, dy = p.y - g.p0.y;
  const held = m.shift ? (Math.abs(dx) >= Math.abs(dy) ? 'y' : 'x') : '';     // Shift: one axis stays
  if (held === 'y') dy = 0;
  if (held === 'x') dx = 0;
  g.hits = [];
  if (prefs.snap && !m.alt && !m.ctrl) {
    const box = { ...g.box0, x: g.box0.x + dx, y: g.box0.y + dy };
    const r = Snap.snapMove(box, g.tg, { threshold: SNAP_PX / view.z, others: g.others, grid: prefs.grid ? prefs.gridSize : 0 });
    if (held !== 'x') dx += r.dx;
    if (held !== 'y') dy += r.dy;
    g.hits = r.hits.filter((h) => h.axis !== held);
  }
  dx = Math.round(dx);
  dy = Math.round(dy);
  for (const id of g.ids) {
    const l = layerById(id), s0 = g.starts.get(id);
    if (l) { l.transform.x = s0.x + dx; l.transform.y = s0.y + dy; }
  }
  g.box = { ...g.box0, x: g.box0.x + dx, y: g.box0.y + dy };
}

/* ---- resize and rotate */

function startTransform(handle, p) {
  const ls = selUnits().flatMap((u) => u.ls);
  if (!ls.length) return null;
  const ids = ls.map((l) => l.id);
  const single = ls.length === 1;
  const f0 = single ? { ...ls[0].transform } : { ...Snap.union(ls.map((l) => Snap.boundsOf(l.transform))), rotation: 0, anchor: 'tl' };
  const center = pointOf(f0, 0.5, 0.5);
  const others = othersThan(ids);
  const n = ids.length > 1 ? ` ${ids.length} layers` : '';
  return { kind: handle === 'rot' ? 'rotate' : 'resize', label: (handle === 'rot' ? 'rotate' : 'resize') + n,
    handle, single, f0, ids, scene: store.scene, before: clone(store.scene), p0: p, hits: [],
    starts: new Map(ls.map((l) => [l.id, { ...l.transform }])), center,
    a0: Math.atan2(p.y - center.y, p.x - center.x),
    tg: Snap.targets(store.scene, others, { safeZones: zonesNow() }) };
}
function stepResize(g, p, m) {
  const f0 = g.f0, [hx, hy] = HANDLES[g.handle];
  const a = rad(f0.rotation || 0), c = Math.cos(a), s = Math.sin(a);
  const ddx = p.x - g.p0.x, ddy = p.y - g.p0.y;
  // The pointer's travel along the box's own axes, in whole pixels (so a resize from the center stays centered).
  const du = Math.round(ddx * c + ddy * s), dv = Math.round(-ddx * s + ddy * c);
  const k = m.alt ? 2 : 1;
  let fx = m.alt ? 0.5 : 1 - hx, fy = m.alt ? 0.5 : 1 - hy;        // the point that stays put
  let w = f0.w, h = f0.h;
  if (hx !== 0.5) w = Math.max(1, f0.w + (hx === 1 ? du : -du) * k);
  if (hy !== 0.5) h = Math.max(1, f0.h + (hy === 1 ? dv : -dv) * k);
  const corner = hx !== 0.5 && hy !== 0.5;
  const ratio = f0.w / f0.h;
  let lead = hx !== 0.5 ? 'x' : 'y';
  if (m.shift) {
    if (corner) lead = Math.abs(w / f0.w - 1) >= Math.abs(h / f0.h - 1) ? 'x' : 'y';
    else if (hx === 0.5) fx = 0.5;
    else fy = 0.5;
    if (lead === 'x') h = Math.max(1, w / ratio); else w = Math.max(1, h * ratio);
  }
  const F = pointOf(f0, fx, fy);
  g.hits = [];
  if (prefs.snap && !m.ctrl && !((f0.rotation || 0) % 360)) {
    const thr = SNAP_PX / view.z, grid = prefs.grid ? prefs.gridSize : 0;
    const edge = (axis) => {
      const hv = axis === 'x' ? hx : hy, f = axis === 'x' ? fx : fy, size = axis === 'x' ? w : h, o = axis === 'x' ? F.x : F.y;
      if (hv === 0.5) return null;
      const at = hv === 1 ? o + (1 - f) * size : o - f * size;
      const hit = Snap.snapValue(at, axis === 'x' ? g.tg.xs : g.tg.ys, { threshold: thr, grid });
      if (!hit) return null;
      const X = at + hit.d;
      const ns = hv === 1 ? (X - o) / (1 - f) : (o - X) / f;
      return ns >= 1 ? { size: ns, hit: { axis, at: X, kind: hit.kind, box: hit.box } } : null;
    };
    if (m.shift) {
      const r = edge(lead);
      if (r) { if (lead === 'x') { w = r.size; h = w / ratio; } else { h = r.size; w = h * ratio; } g.hits.push(r.hit); }
    } else {
      const rx = edge('x'), ry = edge('y');
      if (rx) { w = rx.size; g.hits.push(rx.hit); }
      if (ry) { h = ry.size; g.hits.push(ry.hit); }
    }
  }
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  if (g.single) {
    const l = layerById(g.ids[0]);
    const nt = placeAt(f0, w, h, fx, fy, F);
    const rot = !!((f0.rotation || 0) % 360);
    if (l) Object.assign(l.transform, { x: rpos(nt.x, rot), y: rpos(nt.y, rot), w, h });
    g.box = l ? Snap.boundsOf(l.transform) : null;
  } else {
    // The selection's box scales; each layer keeps its place in it.
    const U = { x: F.x - fx * w, y: F.y - fy * h, w, h };
    const kx = w / f0.w, ky = h / f0.h;
    for (const id of g.ids) {
      const l = layerById(id), t0 = g.starts.get(id);
      if (!l) continue;
      const r0 = rad(t0.rotation || 0), ac = Math.abs(Math.cos(r0)), as = Math.abs(Math.sin(r0));
      const nw = Math.max(1, Math.round(t0.w * (kx * ac + ky * as))), nh = Math.max(1, Math.round(t0.h * (ky * ac + kx * as)));
      const c0 = pointOf(t0, 0.5, 0.5);
      const nt = placeAt(t0, nw, nh, 0.5, 0.5, { x: U.x + (c0.x - f0.x) * kx, y: U.y + (c0.y - f0.y) * ky });
      const rot = !!((t0.rotation || 0) % 360);
      Object.assign(l.transform, { x: rpos(nt.x, rot), y: rpos(nt.y, rot), w: nw, h: nh });
    }
    g.box = U;
  }
  g.size = [w, h];
}
function stepRotate(g, p, m) {
  const C = g.center;
  let d = ((Math.atan2(p.y - C.y, p.x - C.x) - g.a0) * 180) / Math.PI;
  if (g.single) {
    const r0 = g.f0.rotation || 0;
    let r = r0 + d;
    if (m.shift) r = Math.round(r / 15) * 15;
    else if (prefs.snap && !m.alt && !m.ctrl) { const q = Math.round(r / 90) * 90; if (Math.abs(r - q) <= 3) r = q; }
    d = r - r0;
  } else if (m.shift) d = Math.round(d / 15) * 15;
  const cd = Math.cos(rad(d)), sd = Math.sin(rad(d));
  // Each layer turns about the selection's center: its own center swings round it, its angle grows by d.
  for (const id of g.ids) {
    const l = layerById(id), t0 = g.starts.get(id);
    if (!l) continue;
    const c0 = pointOf(t0, 0.5, 0.5);
    const c1 = { x: C.x + (c0.x - C.x) * cd - (c0.y - C.y) * sd, y: C.y + (c0.x - C.x) * sd + (c0.y - C.y) * cd };
    const r1 = normDeg((t0.rotation || 0) + d);
    const nt = placeAt(t0, t0.w, t0.h, 0.5, 0.5, c1, r1);
    Object.assign(l.transform, { x: rpos(nt.x, !!(r1 % 360)), y: rpos(nt.y, !!(r1 % 360)), rotation: r1 });
  }
  g.angle = g.single ? normDeg((g.f0.rotation || 0) + d) : Math.round(d * 10) / 10;
}

/* ---- guides */

function startGuide(axis, i, p) {
  const s = store.scene;
  const before = clone(s);
  s.guides = s.guides || {};
  s.guides[axis] = s.guides[axis] || [];
  const isNew = i < 0;
  if (isNew) { s.guides[axis].push(Math.round(axis === 'h' ? p.y : p.x)); i = s.guides[axis].length - 1; }
  const tg = Snap.targets({ width: s.width, height: s.height }, othersThan([]), { safeZones: zonesNow() });
  return { kind: 'guide', axis, i, isNew, off: isNew, scene: s, before, label: isNew ? 'add guide' : 'move guide',
    lines: axis === 'h' ? tg.ys : tg.xs, value: s.guides[axis][i],
    finish(g) {
      if (!g.off) return;
      store.scene.guides[g.axis].splice(g.i, 1);
      g.label = 'remove guide';
    } };
}
function stepGuide(g, p, m, e) {
  let v = g.axis === 'h' ? p.y : p.x;
  if (prefs.snap && !m.alt && !m.ctrl) {
    const hit = Snap.snapValue(v, g.lines, { threshold: SNAP_PX / view.z });
    if (hit) v += hit.d;
  }
  v = Math.round(v);
  // Dragged back onto its ruler, it goes when let go.
  const r = vp.getBoundingClientRect();
  g.off = prefs.rulers && (g.axis === 'h' ? e.clientY - r.top < RULER : e.clientX - r.left < RULER);
  store.scene.guides[g.axis][g.i] = v;
  g.value = v;
}

/* ---- the selection box */

function startMarquee(pr) {
  return { kind: 'marquee', p0: pr.p, base: pr.add ? pr.base : [], scene: store.scene, rect: null, sig: '' };
}
function stepMarquee(g, p) {
  g.rect = { x: Math.min(g.p0.x, p.x), y: Math.min(g.p0.y, p.y), w: Math.abs(p.x - g.p0.x), h: Math.abs(p.y - g.p0.y) };
  const ids = new Set(g.base);
  for (const l of store.scene.layers) {
    if (l.visible !== false && !l.locked && l.type !== 'background' && overlaps(Snap.boundsOf(l.transform), g.rect)) {
      for (const id of unitOf(l)) ids.add(id);
    }
  }
  const sig = [...ids].sort().join(',');
  if (sig !== g.sig) { g.sig = sig; store.sel = ids; renderAll(); } else paintOverlay();
}

/* ------------------------------------------------------------- drawing */

/* Everything this file draws: the selection and its handles, hover, the
   selection box, smart guides and distances, guides, rulers, the grid and
   the safe zones. Called by canvas.js on every change and view move. */
function paintHud() {
  paintWorldAids();
  paintRulers();
  const hud = $('hud');
  const s = store.scene;
  if (!s) { hud.innerHTML = ''; return; }
  const g = gesture, out = [], svg = [];
  const gd = s.guides || {};
  for (const axis of ['h', 'v']) {
    (gd[axis] || []).forEach((v, i) => {
      const on = g && g.kind === 'guide' && g.axis === axis && g.i === i;
      const at = axis === 'h' ? view.y + v * view.z : view.x + v * view.z;
      out.push(`<div class="guide ${axis}${on ? ' active' : ''}${on && g.off ? ' off' : ''}" data-guide="${axis}" data-i="${i}" ` +
        `style="${axis === 'h' ? 'top' : 'left'}:${at}px" title="Guide at ${axis === 'h' ? 'y' : 'x'} ${v}: drag to move it, onto the ruler to remove it"></div>`);
    });
  }
  if (hoverId && !g && !store.sel.has(hoverId)) { const l = layerById(hoverId); if (l) out.push(outline(l.transform, 'hover')); }
  const sel = selected();
  const moving = g && g.kind === 'move';
  const live = sel.filter((l) => !l.locked);
  if (sel.length === 1) {
    out.push(outline(sel[0].transform, sel[0].locked ? 'sel locked' : 'sel'));
    if (live.length && !moving) handles(sel[0].transform, out, svg);
  } else if (sel.length > 1) {
    for (const l of sel) out.push(outline(l.transform, 'member' + (l.locked ? ' locked' : '')));
    if (live.length) {
      const U = { ...Snap.union(live.map((l) => Snap.boundsOf(l.transform))), rotation: 0, anchor: 'tl' };
      out.push(outline(U, 'sel'));
      if (!moving) handles(U, out, svg);
    }
  }
  if (g && g.kind === 'marquee' && g.rect) out.push(outline(g.rect, 'marquee'));
  if (g && g.hits && g.hits.length) smartGuides(g, svg, out);
  if (moving && g.box) distances(g, svg, out);
  if (g && g.kind === 'resize' && g.box && g.size) {
    const q = scr({ x: g.box.x + g.box.w / 2, y: g.box.y + g.box.h });
    out.push(label(q.x, q.y + 10, `${g.size[0]} × ${g.size[1]}`));
  }
  if (g && g.kind === 'rotate' && g.pointer) out.push(label(g.pointer.x + 18, g.pointer.y + 14, `${g.angle}°`));
  if (g && g.kind === 'guide' && g.pointer) out.push(label(g.pointer.x + 16, g.pointer.y + 12, g.off ? 'Remove' : `${g.axis === 'h' ? 'y' : 'x'} ${g.value}`));
  hud.innerHTML = out.join('') + (svg.length ? `<svg class="hud-lines">${svg.join('')}</svg>` : '');
}
function outline(t, cls) {
  const [ox, oy] = ORIGIN[t.anchor] || ORIGIN.tl;
  const q = scr(t);
  return `<div class="ol ${cls}" style="left:${q.x}px;top:${q.y}px;width:${t.w * view.z}px;height:${t.h * view.z}px;` +
    `transform:rotate(${t.rotation || 0}deg);transform-origin:${ox * 100}% ${oy * 100}%"></div>`;
}
function cursorFor(k, rot) {
  return RESIZE_CURSORS[Math.round(((((HANDLE_ANGLE[k] + (rot || 0)) % 180) + 180) % 180) / 45) % 4];
}
function handles(t, out, svg) {
  const small = t.w * view.z < 30 || t.h * view.z < 30;
  for (const [k, [fx, fy]] of Object.entries(HANDLES)) {
    if (small && (fx === 0.5 || fy === 0.5)) continue;
    const q = scr(pointOf(t, fx, fy));
    out.push(`<div class="handle" data-handle="${k}" style="left:${q.x}px;top:${q.y}px;cursor:${cursorFor(k, t.rotation)}"></div>`);
  }
  const a = rad(t.rotation || 0);
  const q0 = scr(pointOf(t, 0.5, 0));
  const q = { x: q0.x + Math.sin(a) * ROT_OFF, y: q0.y - Math.cos(a) * ROT_OFF };
  svg.push(`<line class="stem" x1="${q0.x}" y1="${q0.y}" x2="${q.x}" y2="${q.y}"/>`);
  out.push(`<div class="handle rot" data-handle="rot" style="left:${q.x}px;top:${q.y}px" title="Rotate (Shift: 15° steps)"></div>`);
}
const label = (x, y, text, cls = '') => `<div class="hud-label${cls ? ' ' + cls : ''}" style="left:${x}px;top:${y}px">${esc(text)}</div>`;
function seg(svg, a, b, cls) {
  const p = scr(a), q = scr(b);
  svg.push(`<line class="${cls}" x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}"/>`);
}
/** The lines a drag snapped to, across both boxes (or the whole canvas). */
function smartGuides(g, svg, out) {
  const s = store.scene, b = g.box || selBox();
  if (!b) return;
  for (const h of g.hits) {
    if (h.kind === 'spacing') {
      const [p, sz, q, qs] = h.axis === 'x' ? ['x', 'w', 'y', 'h'] : ['y', 'h', 'x', 'w'];
      const mid = b[q] + b[qs] / 2;
      const pts = [[h.before[p] + h.before[sz], b[p]], [b[p] + b[sz], h.after[p]]];
      for (const [from, to] of pts) {
        const A = h.axis === 'x' ? { x: from, y: mid } : { x: mid, y: from };
        const B = h.axis === 'x' ? { x: to, y: mid } : { x: mid, y: to };
        seg(svg, A, B, 'spacing');
        const c = scr({ x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 });
        out.push(label(c.x, c.y + 4, String(Math.round(h.gap)), 'spacing'));
      }
      continue;
    }
    const whole = !h.box;
    if (h.axis === 'x') {
      const y1 = whole ? 0 : Math.min(b.y, h.box.y), y2 = whole ? s.height : Math.max(b.y + b.h, h.box.y + h.box.h);
      seg(svg, { x: h.at, y: y1 }, { x: h.at, y: y2 }, 'snap');
    } else {
      const x1 = whole ? 0 : Math.min(b.x, h.box.x), x2 = whole ? s.width : Math.max(b.x + b.w, h.box.x + h.box.w);
      seg(svg, { x: x1, y: h.at }, { x: x2, y: h.at }, 'snap');
    }
  }
}
/** How far the moving selection is from its nearest neighbors. */
function distances(g, svg, out) {
  const spaced = new Set(g.hits.filter((h) => h.kind === 'spacing').map((h) => h.axis));
  for (const d of Snap.distances(g.box, g.others)) {
    if (spaced.has(d.axis) || d.gap < 1) continue;
    const A = d.axis === 'x' ? { x: d.from, y: d.at } : { x: d.at, y: d.from };
    const B = d.axis === 'x' ? { x: d.to, y: d.at } : { x: d.at, y: d.to };
    seg(svg, A, B, 'dist');
    const c = scr({ x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 });
    out.push(label(c.x, c.y + 4, String(Math.round(d.gap)), 'dist'));
  }
}

/** The grid and the safe zones, in scene space under everything else. */
function paintWorldAids() {
  const s = store.scene;
  const grid = $('gridLayer'), safe = $('safeLayer');
  grid.hidden = !(s && prefs.grid && prefs.gridSize * view.z >= 5);
  if (!grid.hidden) grid.style.setProperty('--grid', prefs.gridSize + 'px');
  const zones = zonesNow();
  const sig = JSON.stringify(zones);
  if (safe.dataset.sig !== sig) {
    safe.dataset.sig = sig;
    safe.innerHTML = zones.map((z) => `<div class="safe-zone" style="left:${z.x}px;top:${z.y}px;width:${z.w}px;height:${z.h}px"><span>${esc(z.name)}</span></div>`).join('');
  }
  safe.hidden = !zones.length;
}

const RULER_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
function paintRulers() {
  const on = !!(prefs.rulers && store.scene);
  for (const id of ['rulerX', 'rulerY', 'rulerCorner']) $(id).hidden = !on;
  if (!on) return;
  const r = vp.getBoundingClientRect();
  drawRuler($('rulerX'), 'x', r.width);
  drawRuler($('rulerY'), 'y', r.height);
}
function drawRuler(cv, axis, len) {
  const dpr = window.devicePixelRatio || 1;
  const W = axis === 'x' ? len : RULER, H = axis === 'x' ? RULER : len;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px';
    cv.style.height = H + 'px';
  }
  const cs = getComputedStyle(cv);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = cs.backgroundColor;
  ctx.fillRect(0, 0, W, H);
  const z = view.z, origin = axis === 'x' ? view.x : view.y;
  // Where the selection is, in the accent.
  const b = selBox();
  if (b) {
    const a = origin + (axis === 'x' ? b.x : b.y) * z, e = a + (axis === 'x' ? b.w : b.h) * z;
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = cs.caretColor;
    if (axis === 'x') ctx.fillRect(a, 0, e - a, RULER); else ctx.fillRect(0, a, RULER, e - a);
    ctx.globalAlpha = 1;
  }
  const step = RULER_STEPS.find((v) => v * z >= 64) || RULER_STEPS[RULER_STEPS.length - 1];
  let minor = step / 10;
  if (minor * z < 6) minor = step / 5;
  if (minor * z < 6) minor = step / 2;
  const from = Math.floor(-origin / z / step) * step, to = (len - origin) / z;
  ctx.strokeStyle = cs.color;
  ctx.fillStyle = cs.color;
  ctx.lineWidth = 1;
  ctx.font = '10px "Segoe UI", system-ui, sans-serif';
  ctx.beginPath();
  const labels = [];
  for (let i = 0, v = from; v <= to && i < 4000; i++, v = from + i * minor) {
    const pos = Math.round(origin + v * z) + 0.5;
    const major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
    const half = Math.abs((v * 2) / step - Math.round((v * 2) / step)) < 1e-6;
    const tick = major ? RULER - 2 : half ? 8 : 4;
    if (axis === 'x') { ctx.moveTo(pos, RULER); ctx.lineTo(pos, RULER - tick); } else { ctx.moveTo(RULER, pos); ctx.lineTo(RULER - tick, pos); }
    if (major) labels.push([pos, Math.round(v)]);
  }
  ctx.stroke();
  for (const [pos, v] of labels) {
    if (axis === 'x') ctx.fillText(String(v), pos + 3, 10);
    else { ctx.save(); ctx.translate(12, pos + 3); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'right'; ctx.fillText(String(v), 0, 0); ctx.restore(); }
  }
  ctx.fillStyle = cs.borderTopColor;
  if (axis === 'x') ctx.fillRect(0, RULER - 1, W, 1); else ctx.fillRect(RULER - 1, 0, 1, H);
}

/* ------------------------------------------------------------- arranging */

function applyMoves(sc, moves) {
  for (const [u, dx, dy] of moves) {
    for (const l0 of u.ls) {
      const l = sc.layers.find((x) => x.id === l0.id);
      if (!l) continue;
      const rot = !!((l.transform.rotation || 0) % 360);
      l.transform.x = rpos(l.transform.x + dx, rot);
      l.transform.y = rpos(l.transform.y + dy, rot);
    }
  }
}
const ALIGN = [['left', 'Align left'], ['hcenter', 'Align centers'], ['right', 'Align right'],
               ['top', 'Align top'], ['vmiddle', 'Align middles'], ['bottom', 'Align bottom']];
/* The selection to one edge or center of its own box - or, one thing
   selected (a layer, or a group chosen whole), of the canvas. */
function alignSel(how) {
  const units = selUnits();
  if (!units.length) return false;
  const s = store.scene;
  const B = units.length === 1 ? { x: 0, y: 0, w: s.width, h: s.height } : Snap.union(units.map((u) => u.box));
  const moves = units.map((u) => {
    const b = u.box;
    const dx = how === 'left' ? B.x - b.x : how === 'hcenter' ? B.x + B.w / 2 - (b.x + b.w / 2) : how === 'right' ? B.x + B.w - (b.x + b.w) : 0;
    const dy = how === 'top' ? B.y - b.y : how === 'vmiddle' ? B.y + B.h / 2 - (b.y + b.h / 2) : how === 'bottom' ? B.y + B.h - (b.y + b.h) : 0;
    return [u, dx, dy];
  });
  const name = (ALIGN.find(([k]) => k === how) || [, how])[1].toLowerCase();
  const done = exec(name, (sc) => applyMoves(sc, moves));
  if (done) announce(units.length === 1 ? name.replace('align', 'Aligned') + ' of the canvas' : name.replace('align', 'Aligned'));
  return done;
}
/** Equal gaps between three or more, the outer two staying put. */
function distribute(axis) {
  const units = selUnits();
  if (units.length < 3) { toast('Pick three or more layers to space them out'); return false; }
  const [p, sz] = axis === 'h' ? ['x', 'w'] : ['y', 'h'];
  const sorted = [...units].sort((a, b) => (a.box[p] + a.box[sz] / 2) - (b.box[p] + b.box[sz] / 2));
  const start = Math.min(...sorted.map((u) => u.box[p])), end = Math.max(...sorted.map((u) => u.box[p] + u.box[sz]));
  const gap = (end - start - sorted.reduce((a, u) => a + u.box[sz], 0)) / (sorted.length - 1);
  let at = start;
  const moves = sorted.map((u) => { const d = at - u.box[p]; at += u.box[sz] + gap; return [u, axis === 'h' ? d : 0, axis === 'v' ? d : 0]; });
  const done = exec(axis === 'h' ? 'space out across' : 'space out down', (sc) => applyMoves(sc, moves));
  if (done) announce(`Spaced out ${units.length} layers`);
  return done;
}
/** Up or down the stack. To the back stops above background layers. */
function arrange(ids, where) {
  if (!ids.length || !store.scene) return false;
  if (where === 'forward' || where === 'backward') { nudgeOrder(ids, where === 'forward' ? 1 : -1); return true; }
  return exec(where === 'front' ? 'bring to front' : 'send to back', (s) => {
    const moving = s.layers.filter((l) => ids.includes(l.id));
    const rest = s.layers.filter((l) => !ids.includes(l.id));
    if (where === 'front') { s.layers = rest.concat(moving); return; }
    let bg = 0;
    while (bg < rest.length && rest[bg].type === 'background') bg++;
    rest.splice(bg, 0, ...moving);
    s.layers = rest;
  });
}
/** Arrow keys: a pixel (ten with Shift). A run of presses is one undo step. */
function nudge(dx, dy) {
  const ids = selUnits().flatMap((u) => u.ls.map((l) => l.id));
  if (!ids.length) return false;
  return exec('nudge', (s) => {
    for (const l of s.layers) if (ids.includes(l.id)) { l.transform.x += dx; l.transform.y += dy; }
  }, 'nudge:' + ids.join(','));
}

/* ------------------------------------------------------------- clipboard */

/* Copied layers go on the system clipboard (a type of their own, so another
   Canvas Builder window - any scene - can paste them; their names as plain
   text) and in this browser's storage, for when the clipboard can't be read. */
let clipMemo = null;
function readClip() {
  try { const c = JSON.parse(localStorage.getItem('cb-clipboard') || 'null'); if (c && c.kind === CLIP_KIND) return c; } catch (_) { /* none */ }
  return clipMemo;
}
function copyLayers(ids) {
  const s = store.scene;
  if (!s) return null;
  const ls = s.layers.filter((l) => ids.includes(l.id));
  if (!ls.length) return null;
  const groups = {};
  for (const l of ls) if (l.group && s.groups && s.groups[l.group]) groups[l.group] = clone(s.groups[l.group]);
  const clip = { kind: CLIP_KIND, v: 1, scene: s.id, width: s.width, height: s.height, layers: clone(ls), groups };
  clipMemo = clip;
  try { localStorage.setItem('cb-clipboard', JSON.stringify(clip)); } catch (_) { /* memory copy only */ }
  announce(ls.length > 1 ? `Copied ${ls.length} layers` : 'Copied the layer');
  return clip;
}
function pasteLayers(clip) {
  if (!clip || !Array.isArray(clip.layers) || !clip.layers.length || !store.scene) return [];
  const made = [];
  exec('paste', (sc) => {
    sc.groups = sc.groups || {};
    const gmap = {};
    const layers = clip.layers.map((l0) => {
      const l = clone(l0);
      l.id = newId();
      if (l.group) {
        if (!gmap[l.group]) {
          gmap[l.group] = 'g' + newId().slice(0, 6);
          sc.groups[gmap[l.group]] = { name: ((clip.groups || {})[l.group] || {}).name || 'Group' };
        }
        l.group = gmap[l.group];
      }
      if (l.type === 'background') Object.assign(l.transform, { x: 0, y: 0, w: sc.width, h: sc.height, rotation: 0 });
      return l;
    });
    // Where they land: where they were. Back onto their own originals, a
    // step down and right (and again for each paste); off this canvas, centered.
    const movable = layers.filter((l) => l.type !== 'background');
    if (movable.length) {
      const U = Snap.union(movable.map((l) => Snap.boundsOf(l.transform)));
      let dx = 0, dy = 0;
      const first = movable[0].transform;
      if (clip.scene === sc.id) {
        let k = 0;
        while (k < 60 && sc.layers.some((x) => x.type === movable[0].type && x.transform.x === first.x + k * 24 && x.transform.y === first.y + k * 24)) k++;
        dx = dy = k * 24;
      } else if (U.x >= sc.width || U.y >= sc.height || U.x + U.w <= 0 || U.y + U.h <= 0) {
        dx = Math.round((sc.width - U.w) / 2 - U.x);
        dy = Math.round((sc.height - U.h) / 2 - U.y);
      }
      for (const l of movable) { l.transform.x += dx; l.transform.y += dy; }
    }
    sc.layers.push(...layers);
    made.push(...layers.map((l) => l.id));
  });
  selectOnly(made);
  announce(made.length > 1 ? `Pasted ${made.length} layers` : 'Pasted a layer');
  return made;
}
function cutLayers(ids) {
  if (!copyLayers(ids)) return false;
  removeLayers(ids);
  return true;
}
/** A picture from the clipboard (a screenshot): into Assets, then onto the canvas. */
async function pasteImage(file) {
  const data = await new Promise((res, rej) => { const rd = new FileReader(); rd.onload = () => res(rd.result); rd.onerror = rej; rd.readAsDataURL(file); });
  const name = file.name && !/^image\.\w+$/.test(file.name) ? file.name : 'Pasted picture.png';
  const r = await fetch('/api/assets/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, data }) });
  const d = await r.json().catch(() => ({}));
  if (!d.ok || !store.scene) { toast(d.reason || 'Could not paste that picture'); return; }
  const img = new Image();
  img.src = data;
  await img.decode().catch(() => {});
  const s = store.scene;
  const w0 = img.naturalWidth || 640, h0 = img.naturalHeight || 360;
  const k = Math.min(1, (s.width * 0.8) / w0, (s.height * 0.8) / h0);
  addLayer(makeLayer('image', name.replace(/\.[a-z0-9]+$/i, '').slice(0, 60), { src: d.id, fit: 'contain' }, Math.round(w0 * k), Math.round(h0 * k)));
}
const editingText = () => typing({ target: document.activeElement });
document.addEventListener('copy', (e) => {
  if (editingText() || !store.sel.size) return;
  const clip = copyLayers([...store.sel]);
  if (!clip || !e.clipboardData) return;
  e.clipboardData.setData(CLIP_MIME, JSON.stringify(clip));
  e.clipboardData.setData('text/plain', clip.layers.map((l) => l.name).join('\n'));
  e.preventDefault();
});
document.addEventListener('cut', (e) => {
  if (editingText() || !store.sel.size) return;
  const ids = [...store.sel];
  const clip = copyLayers(ids);
  if (!clip) return;
  if (e.clipboardData) {
    e.clipboardData.setData(CLIP_MIME, JSON.stringify(clip));
    e.clipboardData.setData('text/plain', clip.layers.map((l) => l.name).join('\n'));
    e.preventDefault();
  }
  removeLayers(ids);
});
document.addEventListener('paste', (e) => {
  if (editingText() || !store.scene) return;
  const cd = e.clipboardData;
  let clip = null;
  try { const c = cd && JSON.parse(cd.getData(CLIP_MIME) || 'null'); if (c && c.kind === CLIP_KIND) clip = c; } catch (_) { /* not ours */ }
  if (clip) { e.preventDefault(); pasteLayers(clip); return; }
  const file = cd && [...cd.files].find((f) => /^image\//.test(f.type));
  if (file) { e.preventDefault(); pasteImage(file); return; }
  const text = cd ? cd.getData('text/plain').trim() : '';
  if (text) {
    e.preventDefault();
    addLayer(makeLayer('text', text.split('\n')[0].slice(0, 40) || 'Text', Object.assign(clone(ADD[0].props), { text: text.slice(0, 2000) }), 900, 140));
    return;
  }
  const kept = readClip();          // nothing on the clipboard we can read: what was copied here last
  if (kept) { e.preventDefault(); pasteLayers(kept); }
});

/* ------------------------------------------------------------- menus */

let menuEl = null, menuReturn = null, menuActs = [];
function openMenu(items, x, y) {
  closeMenu(false);
  menuReturn = document.activeElement;
  menuActs = [];
  const btn = (it, extra = '') => {
    const i = menuActs.push(it) - 1;
    const role = it.check !== undefined ? 'menuitemcheckbox' : 'menuitem';
    return `<button type="button" role="${role}" tabindex="-1" data-i="${i}"${it.check !== undefined ? ` aria-checked="${!!it.check}"` : ''}` +
      `${it.off ? ' aria-disabled="true"' : ''}${it.icon ? ` aria-label="${esc(it.label)}" title="${esc(it.label)}"` : ''}${extra}>` +
      (it.icon ? it.icon : `<span>${esc(it.label)}</span>${it.key ? `<kbd>${esc(it.key)}</kbd>` : ''}`) + '</button>';
  };
  const m = document.createElement('div');
  m.className = 'ctx';
  m.setAttribute('role', 'menu');
  m.setAttribute('aria-label', 'Actions');
  m.innerHTML = items.map((it) => (it === '-' ? '<div class="ctx-sep" role="separator"></div>'
    : it.row ? `<div class="ctx-row" role="group" aria-label="${esc(it.row)}">${it.items.map((x) => btn(x)).join('')}</div>` : btn(it))).join('');
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
  menuEl = m;
  m.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (b) runMenu(Number(b.dataset.i));
  });
  m.addEventListener('keydown', (e) => {
    e.stopPropagation();
    const items2 = [...m.querySelectorAll('[data-i]:not([aria-disabled="true"])')];
    const i = items2.indexOf(document.activeElement);
    const go = (j) => { if (items2.length) items2[(j + items2.length) % items2.length].focus(); };
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); go(i + 1); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); go(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); go(0); }
    else if (e.key === 'End') { e.preventDefault(); go(-1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (i >= 0) runMenu(Number(items2[i].dataset.i)); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); closeMenu(true); }
  });
  const first = m.querySelector('[data-i]:not([aria-disabled="true"])');
  if (first) first.focus();
}
function runMenu(i) {
  const it = menuActs[i];
  if (!it || it.off) return;
  closeMenu(true);
  it.run();
}
function closeMenu(refocus) {
  if (!menuEl) return;
  menuEl.remove();
  menuEl = null;
  if (refocus && menuReturn && menuReturn.isConnected && menuReturn.focus) menuReturn.focus({ preventScroll: true });
  else if (refocus) vp.focus({ preventScroll: true });
}
document.addEventListener('pointerdown', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(false); }, true);
window.addEventListener('resize', () => closeMenu(false));
window.addEventListener('blur', () => closeMenu(false));

function layerMenu() {
  const ids = [...store.sel];
  const has = ids.length > 0;
  const sel = selected();
  const units = selUnits().length;
  const hidden = sel.length && sel.every((l) => l.visible === false);
  const locked = sel.length && sel.every((l) => l.locked);
  return [
    { label: 'Cut', key: 'Ctrl+X', off: !has, run: () => cutLayers(ids) },
    { label: 'Copy', key: 'Ctrl+C', off: !has, run: () => copyLayers(ids) },
    { label: 'Paste', key: 'Ctrl+V', off: !readClip(), run: () => pasteLayers(readClip()) },
    { label: 'Duplicate', key: 'Ctrl+D', off: !has, run: () => duplicateLayers(ids) },
    { label: 'Delete', key: 'Del', off: !has, run: () => removeLayers(ids) },
    '-',
    { label: 'Bring to front', key: 'Ctrl+Shift+]', off: !has, run: () => arrange(ids, 'front') },
    { label: 'Bring forward', key: 'Ctrl+]', off: !has, run: () => arrange(ids, 'forward') },
    { label: 'Send backward', key: 'Ctrl+[', off: !has, run: () => arrange(ids, 'backward') },
    { label: 'Send to back', key: 'Ctrl+Shift+[', off: !has, run: () => arrange(ids, 'back') },
    '-',
    { row: units === 1 ? 'Align to the canvas' : 'Align', items: ALIGN.map(([k, t]) => ({ label: t, icon: ALIGN_ICON[k], off: !units, run: () => alignSel(k) })) },
    { label: 'Space out across', off: units < 3, run: () => distribute('h') },
    { label: 'Space out down', off: units < 3, run: () => distribute('v') },
    '-',
    { label: 'Group', key: 'Ctrl+G', off: ids.length < 2, run: () => groupLayers(ids) },
    { label: 'Ungroup', key: 'Ctrl+Shift+G', off: !sel.some((l) => l.group), run: () => ungroupLayers(ids) },
    { label: hidden ? 'Show' : 'Hide', key: 'H', off: !has, run: () => setVisible(ids, !!hidden) },
    { label: locked ? 'Unlock' : 'Lock', key: 'L', off: !has, run: () => setLocked(ids, !locked) },
  ];
}
function viewMenu() {
  const gd = (store.scene && store.scene.guides) || {};
  const nGuides = (gd.h || []).length + (gd.v || []).length;
  return [
    { label: 'Paste', key: 'Ctrl+V', off: !readClip(), run: () => pasteLayers(readClip()) },
    { label: 'Select all', key: 'Ctrl+A', run: () => selectOnly(displayOrder()) },
    '-',
    { label: 'Zoom to fit', key: 'Ctrl+0', run: zoomFit },
    { label: 'Actual size', key: 'Ctrl+1', run: () => zoomAt(1) },
    '-',
    { label: 'Snapping', key: 'Ctrl+;', check: prefs.snap, run: () => setPref('snap', !prefs.snap) },
    { label: 'Grid', key: "Ctrl+'", check: prefs.grid, run: () => setPref('grid', !prefs.grid) },
    { label: 'Rulers', key: 'Shift+R', check: prefs.rulers, run: () => setPref('rulers', !prefs.rulers) },
    { label: 'Safe zones', check: prefs.safe, off: !zonesOf(store.scene).length, run: () => setPref('safe', !prefs.safe) },
    '-',
    { label: nGuides > 1 ? `Clear ${nGuides} guides` : 'Clear guides', off: !nGuides, run: clearGuides },
  ];
}
function guideMenu(axis, i) {
  return [
    { label: 'Remove this guide', run: () => exec('remove guide', (s) => { s.guides[axis].splice(i, 1); }) },
    { label: 'Clear all guides', run: clearGuides },
  ];
}
function clearGuides() {
  if (exec('clear guides', (s) => { s.guides = { h: [], v: [] }; })) announce('Cleared the guides');
}
vp.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!store.scene || gesture) return;
  const t = e.target;
  const guide = t.closest('[data-guide]');
  if (guide) { openMenu(guideMenu(guide.dataset.guide, Number(guide.dataset.i)), e.clientX, e.clientY); return; }
  if (t.closest('.ruler, .ruler-corner')) { openMenu(viewMenu(), e.clientX, e.clientY); return; }
  const p = toScene(e.clientX, e.clientY);
  const hit = hitLayer(p);
  if (hit) {
    const unit = unitOf(hit);
    if (!unit.every((id) => store.sel.has(id))) selectOnly(unit);
    openMenu(layerMenu(), e.clientX, e.clientY);
  } else if (store.sel.size && inBox(selBox(), p)) openMenu(layerMenu(), e.clientX, e.clientY);
  else openMenu(viewMenu(), e.clientX, e.clientY);
});
tree.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  e.preventDefault();
  const ids = rowIds(row);
  if (!ids.every((id) => store.sel.has(id))) selectOnly(ids);
  openMenu(layerMenu(), e.clientX, e.clientY);
});
/** Shift+F10 or the menu key: the menu for the selection, at it. */
function menuAtSelection() {
  const vr = vp.getBoundingClientRect();
  const row = document.activeElement && document.activeElement.closest && document.activeElement.closest('#layerTree .row');
  if (row) { const r = row.getBoundingClientRect(); openMenu(layerMenu(), r.left + 24, r.bottom); return; }
  const b = selBox();
  if (b) { const q = scr({ x: b.x + b.w / 2, y: b.y + b.h / 2 }); openMenu(layerMenu(), vr.left + q.x, vr.top + q.y); return; }
  openMenu(viewMenu(), vr.left + vr.width / 2, vr.top + vr.height / 2);
}

/* ------------------------------------------------------------- the inspector's align row */

const ALIGN_ICON = {
  left: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 1v14" stroke="currentColor"/><rect x="4" y="3" width="9" height="4" rx="1"/><rect x="4" y="9" width="6" height="4" rx="1"/></svg>',
  hcenter: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1v14" stroke="currentColor"/><rect x="3.5" y="3" width="9" height="4" rx="1"/><rect x="5" y="9" width="6" height="4" rx="1"/></svg>',
  right: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 1v14" stroke="currentColor"/><rect x="3" y="3" width="9" height="4" rx="1"/><rect x="6" y="9" width="6" height="4" rx="1"/></svg>',
  top: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 2.5h14" stroke="currentColor"/><rect x="3" y="4" width="4" height="9" rx="1"/><rect x="9" y="4" width="4" height="6" rx="1"/></svg>',
  vmiddle: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 8h14" stroke="currentColor"/><rect x="3" y="3.5" width="4" height="9" rx="1"/><rect x="9" y="5" width="4" height="6" rx="1"/></svg>',
  bottom: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 13.5h14" stroke="currentColor"/><rect x="3" y="3" width="4" height="9" rx="1"/><rect x="9" y="6" width="4" height="6" rx="1"/></svg>',
  h: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 2v12M14.5 2v12" stroke="currentColor"/><rect x="6" y="4" width="4" height="8" rx="1"/></svg>',
  v: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 1.5h12M2 14.5h12" stroke="currentColor"/><rect x="4" y="6" width="8" height="4" rx="1"/></svg>',
};
/** The align buttons for the inspector; n = how many things are selected (1: to the canvas). */
function alignBar(n) {
  return `<div class="align-bar" role="group" aria-label="${n === 1 ? 'Align to the canvas' : 'Align'}">` +
    ALIGN.map(([k, t]) => `<button type="button" class="btn icon" data-align="${k}" title="${t}${n === 1 ? ' of the canvas' : ''}" aria-label="${t}">${ALIGN_ICON[k]}</button>`).join('') +
    (n >= 3 ? '<span class="sep" aria-hidden="true"></span>' +
      `<button type="button" class="btn icon" data-dist="h" title="Space out across" aria-label="Space out across">${ALIGN_ICON.h}</button>` +
      `<button type="button" class="btn icon" data-dist="v" title="Space out down" aria-label="Space out down">${ALIGN_ICON.v}</button>` : '') +
    '</div>';
}
$('inspector').addEventListener('click', (e) => {
  const a = e.target.closest('[data-align]');
  if (a) { alignSel(a.dataset.align); return; }
  const d = e.target.closest('[data-dist]');
  if (d) distribute(d.dataset.dist);
});

/* ------------------------------------------------------------- keys */

// While a drag runs: Esc puts everything back; a modifier pressed or let go counts at once.
const MODS = ['Shift', 'Alt', 'Control', 'Meta'];
window.addEventListener('keydown', (e) => {
  if (!gesture) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancelGesture(); paintOverlay(); return; }
  if (MODS.includes(e.key)) { e.preventDefault(); restep(e); }
}, true);
window.addEventListener('keyup', (e) => { if (gesture && MODS.includes(e.key)) { e.preventDefault(); restep(e); } }, true);

window.addEventListener('keydown', (e) => {
  if (!$('shortcuts').hidden || menuEl || gesture || typing(e) || !store.scene) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const ids = [...store.sel];
  if (ctrl && e.code === 'BracketRight') { e.preventDefault(); arrange(ids, e.shiftKey ? 'front' : 'forward'); return; }
  if (ctrl && e.code === 'BracketLeft') { e.preventDefault(); arrange(ids, e.shiftKey ? 'back' : 'backward'); return; }
  if (ctrl && e.code === 'Quote') { e.preventDefault(); setPref('grid', !prefs.grid); announce(`Grid ${prefs.grid ? 'on' : 'off'}`); return; }
  if (ctrl && e.code === 'Semicolon') { e.preventDefault(); setPref('snap', !prefs.snap); announce(`Snapping ${prefs.snap ? 'on' : 'off'}`); return; }
  if (e.shiftKey && !ctrl && !e.altKey && e.code === 'KeyR') { e.preventDefault(); setPref('rulers', !prefs.rulers); announce(`Rulers ${prefs.rulers ? 'on' : 'off'}`); return; }
  if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') { e.preventDefault(); menuAtSelection(); return; }
  const arrow = ARROWS[e.key];
  if (arrow && !ctrl && !e.altKey && ids.length && !e.defaultPrevented &&
      !(e.target.closest && e.target.closest('#layerTree, [role="tablist"], .cb-top, #inspector'))) {
    e.preventDefault();
    const n = e.shiftKey ? 10 : 1;
    nudge(arrow[0] * n, arrow[1] * n);
  }
});

/* ------------------------------------------------------------- boot */

paintPrefs();
new ResizeObserver(() => paintRulers()).observe(vp);

/* For tests: the tools' own commands, and where things are on screen. */
Object.assign(window.Editor, {
  prefs: () => ({ ...prefs }),
  setPref,
  /** The client point of a scene point. */
  toClient: (x, y) => { const r = vp.getBoundingClientRect(); return { x: r.left + view.x + x * view.z, y: r.top + view.y + y * view.z }; },
  toScene,
  handle: (k) => {
    const el = document.querySelector(`#hud [data-handle="${k}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  },
  gesture: () => (gesture ? { kind: gesture.kind, hits: (gesture.hits || []).map((h) => ({ axis: h.axis, at: h.at, kind: h.kind })) } : null),
  hud: () => ({ snapLines: document.querySelectorAll('#hud line.snap').length, spacing: document.querySelectorAll('#hud line.spacing').length,
                labels: [...document.querySelectorAll('#hud .hud-label')].map((n) => n.textContent) }),
  align: alignSel, distribute, arrange, nudge,
  copy: () => !!copyLayers([...store.sel]), paste: () => pasteLayers(readClip()),
  guides: () => clone((store.scene && store.scene.guides) || {}),
  menu: () => (menuEl ? [...menuEl.querySelectorAll('[data-i]')].map((b) => b.getAttribute('aria-label') || b.querySelector('span').textContent) : null),
  /** Zoom to z keeping the scene point (x, y) where it is on screen. */
  zoom: (z, x, y) => { if (x === undefined) { zoomAt(z); return; } const q = scr({ x, y }); zoomAt(z, q.x, q.y); },
  fit: zoomFit,
});
