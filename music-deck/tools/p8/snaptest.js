// The Canvas Builder's snapping math (web/snap.js), on its own:  node snaptest.js
const assert = require('assert');
const S = require('../../web/snap.js');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

t('bounds of an unrotated box are the box', () => {
  assert.deepStrictEqual(S.boundsOf({ x: 10, y: 20, w: 100, h: 50, rotation: 0 }), { x: 10, y: 20, w: 100, h: 50 });
});
t('bounds of a box turned 90 degrees on its top-left', () => {
  const b = S.boundsOf({ x: 0, y: 0, w: 100, h: 50, rotation: 90, anchor: 'tl' });
  assert(near(b.x, -50) && near(b.y, 0) && near(b.w, 50) && near(b.h, 100), JSON.stringify(b));
});
t('bounds of a box turned 90 degrees on its center keep the center', () => {
  const b = S.boundsOf({ x: 0, y: 0, w: 100, h: 50, rotation: 90, anchor: 'mc' });
  assert(near(b.x + b.w / 2, 50) && near(b.y + b.h / 2, 25) && near(b.w, 50) && near(b.h, 100), JSON.stringify(b));
});

const scene = { width: 1920, height: 1080, guides: { h: [300], v: [] } };
const B = { x: 700, y: 200, w: 200, h: 150 };
t('a left edge 5 px from a neighbor right edge snaps onto it', () => {
  const tg = S.targets(scene, [B]);
  const r = S.snapMove({ x: 905, y: 600, w: 100, h: 100 }, tg, { threshold: 8, others: [B] });
  assert.strictEqual(r.dx, -5);
  assert.strictEqual(r.hits[0].kind, 'layer');
  assert.strictEqual(r.hits[0].at, 900);
});
t('a center near the canvas center snaps to it', () => {
  const r = S.snapMove({ x: 855, y: 700, w: 200, h: 100 }, S.targets(scene, []), { threshold: 8 });
  assert.strictEqual(r.dx, 5);
  assert.strictEqual(r.hits.find((h) => h.axis === 'x').kind, 'canvas-center');
});
t('outside the threshold nothing snaps', () => {
  const r = S.snapMove({ x: 920, y: 700, w: 30, h: 30 }, S.targets(scene, [B]), { threshold: 8, others: [B] });
  assert.strictEqual(r.dx, 0);
  assert.strictEqual(r.hits.filter((h) => h.axis === 'x').length, 0);
});
t('a guide is a target', () => {
  const r = S.snapMove({ x: 1500, y: 296, w: 50, h: 50 }, S.targets(scene, []), { threshold: 8 });
  assert.strictEqual(r.dy, 4);
  assert.strictEqual(r.hits.find((h) => h.axis === 'y').kind, 'guide');
});
t('equal spacing between two neighbors in a row', () => {
  const L = { x: 100, y: 40, w: 120, h: 80 }, R = { x: 620, y: 40, w: 120, h: 80 };
  const box = { x: 364, y: 40, w: 120, h: 80 };
  const r = S.snapMove(box, S.targets({ width: 1920, height: 1080 }, [L, R]), { threshold: 12, others: [L, R] });
  assert.strictEqual(r.dx, -4);
  const h = r.hits.find((x) => x.axis === 'x');
  assert.strictEqual(h.kind, 'spacing');
  assert.strictEqual(h.gap, 140);
});
t('the grid snaps when nothing else does', () => {
  const r = S.snapMove({ x: 1458, y: 603, w: 10, h: 10 }, S.targets({ width: 1920, height: 1080 }, []), { threshold: 12, grid: 50 });
  assert.strictEqual(r.dx, -8);
  assert.strictEqual(r.dy, -3);
});
t('a resize edge snaps to the nearest line', () => {
  const tg = S.targets(scene, [B]);
  const hit = S.snapValue(956, tg.xs, { threshold: 8 });
  assert.strictEqual(hit.at, 960);
  assert.strictEqual(hit.kind, 'canvas-center');
});
t('safe zones are targets when given', () => {
  const tg = S.targets({ width: 1080, height: 1920 }, [], { safeZones: [{ x: 0, y: 0, w: 1080, h: 230 }] });
  assert(tg.ys.some((l) => l.v === 230 && l.kind === 'safe'));
});
t('distances to the nearest neighbors on each side', () => {
  const box = { x: 400, y: 400, w: 100, h: 100 };
  const d = S.distances(box, [{ x: 100, y: 420, w: 50, h: 50 }, { x: 600, y: 380, w: 50, h: 50 }, { x: 420, y: 700, w: 40, h: 40 }]);
  const gaps = Object.fromEntries(d.map((x) => [x.axis + (x.to === box.x || x.to === box.y ? '-' : '+'), x.gap]));
  assert.deepStrictEqual(gaps, { 'x-': 250, 'x+': 100, 'y+': 200 });
});
t('number fields: values, sums and changes', () => {
  const cases = [['120', 50, 120], ['-20', 50, -20], ['1920/3', 0, 640], ['100+20*2', 0, 140], ['(1+2)*3', 0, 9],
    ['+20', 50, 70], ['*2', 50, 100], ['/2', 50, 25], ['-=20', 50, 30], ['+=5', 50, 55], ['*=1.5', 10, 15],
    ['/0', 50, null], ['abc', 50, null], ['', 50, null], ['2*', 50, null], ['.5', 0, 0.5]];
  for (const [text, cur, want] of cases) assert.strictEqual(S.evalField(text, cur), want, `${text} on ${cur}`);
});
console.log(`\n${n} snap tests passed`);
