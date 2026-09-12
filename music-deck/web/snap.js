/* Snapping math for the Canvas Builder (P8). Pure: boxes in, offsets out,
   no page - so it is tested on its own (tools/p8/snaptest.js).

   A box is { x, y, w, h } in scene pixels. Targets are lines: { v, kind,
   from } per axis - the canvas's edges and center, the other layers' edges
   and centers, guides, safe zones. The moving box offers its left, center
   and right (top, middle, bottom) and the closest pair within the
   threshold wins, per axis. Equal spacing: a box between two neighbors in
   its row (column) snaps to the spot that leaves the two gaps equal. */
(function (root) {
  'use strict';

  /** The axis-aligned bounds of a layer, its rotation included. */
  function boundsOf(t) {
    const r = ((t.rotation || 0) * Math.PI) / 180;
    if (!r) return { x: t.x, y: t.y, w: t.w, h: t.h };
    const O = { tl: [0, 0], tc: [0.5, 0], tr: [1, 0], ml: [0, 0.5], mc: [0.5, 0.5], mr: [1, 0.5],
                bl: [0, 1], bc: [0.5, 1], br: [1, 1] }[t.anchor] || [0, 0];
    const ox = t.x + O[0] * t.w, oy = t.y + O[1] * t.h;
    const c = Math.cos(r), s = Math.sin(r);
    const pts = [[t.x, t.y], [t.x + t.w, t.y], [t.x + t.w, t.y + t.h], [t.x, t.y + t.h]].map(([px, py]) =>
      [ox + (px - ox) * c - (py - oy) * s, oy + (px - ox) * s + (py - oy) * c]);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }

  /** The union of boxes. */
  function union(boxes) {
    if (!boxes.length) return null;
    const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y));
    const r = Math.max(...boxes.map((b) => b.x + b.w)), b2 = Math.max(...boxes.map((b) => b.y + b.h));
    return { x, y, w: r - x, h: b2 - y };
  }

  /** Every line a box can snap to: canvas, other boxes, guides, safe zones. */
  function targets(scene, others, opts = {}) {
    const W = scene.width, H = scene.height;
    const xs = [{ v: 0, kind: 'canvas' }, { v: W / 2, kind: 'canvas-center' }, { v: W, kind: 'canvas' }];
    const ys = [{ v: 0, kind: 'canvas' }, { v: H / 2, kind: 'canvas-center' }, { v: H, kind: 'canvas' }];
    for (const b of others) {
      xs.push({ v: b.x, kind: 'layer', box: b }, { v: b.x + b.w / 2, kind: 'layer-center', box: b }, { v: b.x + b.w, kind: 'layer', box: b });
      ys.push({ v: b.y, kind: 'layer', box: b }, { v: b.y + b.h / 2, kind: 'layer-center', box: b }, { v: b.y + b.h, kind: 'layer', box: b });
    }
    const g = scene.guides || {};
    for (const v of g.v || []) xs.push({ v, kind: 'guide' });
    for (const v of g.h || []) ys.push({ v, kind: 'guide' });
    for (const z of opts.safeZones || []) {
      xs.push({ v: z.x, kind: 'safe' }, { v: z.x + z.w, kind: 'safe' });
      ys.push({ v: z.y, kind: 'safe' }, { v: z.y + z.h, kind: 'safe' });
    }
    return { xs, ys };
  }

  function best(offers, lines, thr) {
    let hit = null;
    for (const o of offers) {
      for (const l of lines) {
        const d = l.v - o.v;
        if (Math.abs(d) <= thr && (!hit || Math.abs(d) < Math.abs(hit.d) - 1e-9)) hit = { d, at: l.v, line: l, edge: o.edge };
      }
    }
    return hit;
  }

  /** Equal gaps: the box between its nearest neighbors on one axis. */
  function equalSpacing(box, others, axis, thr) {
    const [p, s, q, t] = axis === 'x' ? ['x', 'w', 'y', 'h'] : ['y', 'h', 'x', 'w'];
    const inRow = others.filter((o) => o[q] < box[q] + box[t] && o[q] + o[t] > box[q]);
    const before = inRow.filter((o) => o[p] + o[s] <= box[p] + thr).sort((a, b) => (b[p] + b[s]) - (a[p] + a[s]))[0];
    const after = inRow.filter((o) => o[p] >= box[p] + box[s] - thr).sort((a, b) => a[p] - b[p])[0];
    if (!before || !after) return null;
    const room = after[p] - (before[p] + before[s]);
    if (room < box[s]) return null;
    const spot = before[p] + before[s] + (room - box[s]) / 2;
    const d = spot - box[p];
    return Math.abs(d) <= thr ? { d, at: spot, gap: (room - box[s]) / 2, before, after } : null;
  }

  /** Snap a moving box. Returns the offset to add, and what it snapped to. */
  function snapMove(box, tg, opts = {}) {
    const thr = opts.threshold ?? 6;
    const out = { dx: 0, dy: 0, hits: [] };
    const hx = best([{ v: box.x, edge: 'start' }, { v: box.x + box.w / 2, edge: 'center' }, { v: box.x + box.w, edge: 'end' }], tg.xs, thr);
    const hy = best([{ v: box.y, edge: 'start' }, { v: box.y + box.h / 2, edge: 'center' }, { v: box.y + box.h, edge: 'end' }], tg.ys, thr);
    const others = opts.others || [];
    const ex = opts.spacing !== false ? equalSpacing(box, others, 'x', thr) : null;
    const ey = opts.spacing !== false ? equalSpacing(box, others, 'y', thr) : null;
    if (hx && (!ex || Math.abs(hx.d) <= Math.abs(ex.d))) { out.dx = hx.d; out.hits.push({ axis: 'x', at: hx.at, kind: hx.line.kind, box: hx.line.box }); }
    else if (ex) { out.dx = ex.d; out.hits.push({ axis: 'x', at: ex.at, kind: 'spacing', gap: ex.gap, before: ex.before, after: ex.after }); }
    if (hy && (!ey || Math.abs(hy.d) <= Math.abs(ey.d))) { out.dy = hy.d; out.hits.push({ axis: 'y', at: hy.at, kind: hy.line.kind, box: hy.line.box }); }
    else if (ey) { out.dy = ey.d; out.hits.push({ axis: 'y', at: ey.at, kind: 'spacing', gap: ey.gap, before: ey.before, after: ey.after }); }
    if (opts.grid > 0) {
      if (!out.hits.some((h) => h.axis === 'x')) { const g = Math.round(box.x / opts.grid) * opts.grid; if (Math.abs(g - box.x) <= thr) out.dx = g - box.x; }
      if (!out.hits.some((h) => h.axis === 'y')) { const g = Math.round(box.y / opts.grid) * opts.grid; if (Math.abs(g - box.y) <= thr) out.dy = g - box.y; }
    }
    return out;
  }

  /** Snap one edge coordinate (a resize): the nearest line within the threshold. */
  function snapValue(v, lines, opts = {}) {
    const thr = opts.threshold ?? 6;
    let hit = null;
    for (const l of lines) { const d = l.v - v; if (Math.abs(d) <= thr && (!hit || Math.abs(d) < Math.abs(hit.d))) hit = { d, at: l.v, kind: l.kind, box: l.box }; }
    if (!hit && opts.grid > 0) { const g = Math.round(v / opts.grid) * opts.grid; if (Math.abs(g - v) <= thr) hit = { d: g - v, at: g, kind: 'grid' }; }
    return hit;
  }

  /** Distances from a box to its nearest neighbors on each side (for smart guides). */
  function distances(box, others) {
    const out = [];
    const overlapY = (o) => o.y < box.y + box.h && o.y + o.h > box.y;
    const overlapX = (o) => o.x < box.x + box.w && o.x + o.w > box.x;
    const left = others.filter((o) => overlapY(o) && o.x + o.w <= box.x).sort((a, b) => (b.x + b.w) - (a.x + a.w))[0];
    const right = others.filter((o) => overlapY(o) && o.x >= box.x + box.w).sort((a, b) => a.x - b.x)[0];
    const up = others.filter((o) => overlapX(o) && o.y + o.h <= box.y).sort((a, b) => (b.y + b.h) - (a.y + a.h))[0];
    const down = others.filter((o) => overlapX(o) && o.y >= box.y + box.h).sort((a, b) => a.y - b.y)[0];
    const midY = (o) => (Math.max(o.y, box.y) + Math.min(o.y + o.h, box.y + box.h)) / 2;
    const midX = (o) => (Math.max(o.x, box.x) + Math.min(o.x + o.w, box.x + box.w)) / 2;
    if (left) out.push({ axis: 'x', from: left.x + left.w, to: box.x, at: midY(left), gap: box.x - (left.x + left.w) });
    if (right) out.push({ axis: 'x', from: box.x + box.w, to: right.x, at: midY(right), gap: right.x - (box.x + box.w) });
    if (up) out.push({ axis: 'y', from: up.y + up.h, to: box.y, at: midX(up), gap: box.y - (up.y + up.h) });
    if (down) out.push({ axis: 'y', from: box.y + box.h, to: down.y, at: midX(down), gap: down.y - (box.y + box.h) });
    return out;
  }

  /** A number field's text: a value ("120", "-20"), math ("1920/3", "100+20*2"), or a change to
      what the field held: "+20", "*2", "/2", or "+=20" "-=20" "*=2" "/=2" (the only way to subtract,
      since "-20" is a value). */
  function evalField(text, current) {
    const s = String(text).trim();
    if (!s) return null;
    let expr = s, op = '';
    const m = s.match(/^([+\-*/])=(.*)$/);
    if (m) { op = m[1]; expr = m[2]; }
    else if (/^[+*/]/.test(s)) { op = s[0]; expr = s.slice(1); }
    const v = parseExpr(expr);
    if (v === null || !Number.isFinite(v)) return null;
    if (!op) return v;
    const base = Number(current) || 0;
    return op === '+' ? base + v : op === '-' ? base - v : op === '*' ? base * v : v === 0 ? null : base / v;
  }
  function parseExpr(src) {
    const toks = src.match(/\d+\.?\d*|\.\d+|[()+\-*/]|\S/g) || [];
    let i = 0;
    const peek = () => toks[i];
    function atom() {
      const t = toks[i++];
      if (t === '(') { const v = sum(); if (toks[i++] !== ')') throw 0; return v; }
      if (t === '-') return -atom();
      if (t === '+') return atom();
      if (t !== undefined && /^(\d|\.)/.test(t)) return Number(t);
      throw 0;
    }
    function prod() { let v = atom(); while (peek() === '*' || peek() === '/') { const op = toks[i++]; const r = atom(); v = op === '*' ? v * r : v / r; } return v; }
    function sum() { let v = prod(); while (peek() === '+' || peek() === '-') { const op = toks[i++]; const r = prod(); v = op === '+' ? v + r : v - r; } return v; }
    try { const v = sum(); return i === toks.length ? v : null; } catch (_) { return null; }
  }

  const api = { boundsOf, union, targets, snapMove, snapValue, equalSpacing, distances, evalField };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Snap = api;
})(typeof window !== 'undefined' ? window : globalThis);
