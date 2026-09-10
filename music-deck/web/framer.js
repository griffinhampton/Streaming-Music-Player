/* Awesome Streaming Deck - the framing dialog.

   Two sliders called "Across" and "Down" are a poor way to decide what part of
   a photograph ends up on stream: you are aiming blind and checking the result
   somewhere else. This shows the whole picture, grays out everything that will
   be cropped away, and lets you drag the bright part to where you want it -
   at the exact shape of the window it is going into. */

let framerState = null;

/* The dialog's own elements, looked up once. layoutFramer runs on every
   pointermove, and five getElementById calls per frame is five too many. */
const FR = {};
for (const k of ['framer', 'framerStage', 'framerHole', 'framerShade',
                 'framerReadout', 'framerCrop', 'framerZoom', 'framerTitle',
                 'framerSize']) {
  FR[k.replace('framer', '').toLowerCase() || 'root'] = document.getElementById(k);
}

function openFramer(opts) {
  // opts: { image, width, height, zoom, pos_x, pos_y, fit, title, onApply }
  const box = document.getElementById('framer');
  const stage = document.getElementById('framerStage');
  framerState = {
    ...opts,
    zoom: Math.max(1, Number(opts.zoom) || 1),
    x: Number(opts.pos_x ?? 50),
    y: Number(opts.pos_y ?? 50),
    ar: (opts.width || 16) / (opts.height || 9),
  };

  document.getElementById('framerTitle').textContent = opts.title || 'Frame the picture';
  document.getElementById('framerSize').textContent = `${opts.width} × ${opts.height}`;
  document.getElementById('framerZoom').value = String(Math.round(framerState.zoom * 100));

  const img = new Image();
  img.onload = () => {
    framerState.natW = img.naturalWidth;
    framerState.natH = img.naturalHeight;
    stage.style.backgroundImage = `url("${img.src}")`;
    layoutFramer();
  };
  img.src = '/asset/' + encodeURIComponent(opts.image);

  box.hidden = false;
  document.addEventListener('keydown', framerKeys);
}

function closeFramer() {
  document.getElementById('framer').hidden = true;
  document.removeEventListener('keydown', framerKeys);
  framerState = null;
}

function framerKeys(e) {
  if (e.key === 'Escape') { e.preventDefault(); closeFramer(); }
  if (e.key === 'Enter') { e.preventDefault(); applyFramer(); }
}

/* Draw the picture whole, and put a window-shaped hole over the part that
   survives. Everything outside the hole is what you are throwing away. */
function layoutFramer() {
  const s = framerState;
  if (!s || !s.natW) return;
  const stage = FR.stage, hole = FR.hole, shade = FR.shade;

  // The wrapper does not change size while you drag inside it, so measure it
  // when the dialog opens and on resize - not on every pointermove, where the
  // read would follow the previous frame's writes and force a reflow.
  const box = s.box || (s.box = stage.parentElement.getBoundingClientRect());
  const pad = 24;
  const availW = box.width - pad * 2, availH = box.height - pad * 2;

  // The picture, shown whole and as large as fits.
  const imgAR = s.natW / s.natH;
  let w = availW, h = w / imgAR;
  if (h > availH) { h = availH; w = h * imgAR; }
  stage.style.width = w + 'px';
  stage.style.height = h + 'px';

  // The window's shape, scaled to sit inside the picture the way `cover`
  // would: the crop covers the window, so it is the *smaller* fit that wins.
  const fit = s.fit || 'cover';
  let cw, ch;
  if (fit === 'cover') {
    // cover: the picture fills the window, so the visible slice is whichever
    // dimension is proportionally larger - divided by the zoom.
    if (imgAR > s.ar) { ch = h / s.zoom; cw = ch * s.ar; }
    else { cw = w / s.zoom; ch = cw / s.ar; }
  } else {
    // contain: the whole picture fits inside the window, so nothing is cropped
    // and the frame is the picture itself.
    cw = w; ch = h;
  }
  cw = Math.min(cw, w); ch = Math.min(ch, h);

  const left = (w - cw) * (s.x / 100);
  const top = (h - ch) * (s.y / 100);
  hole.style.width = cw + 'px';
  hole.style.height = ch + 'px';
  hole.style.left = left + 'px';
  hole.style.top = top + 'px';
  shade.style.clipPath =
    `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0,` +
    ` ${left}px ${top}px,` +
    ` ${left}px ${top + ch}px,` +
    ` ${left + cw}px ${top + ch}px,` +
    ` ${left + cw}px ${top}px,` +
    ` ${left}px ${top}px)`;

  FR.readout.textContent =
    `across ${Math.round(s.x)}%  ·  down ${Math.round(s.y)}%  ·  zoom ${s.zoom.toFixed(2)}×`;
  FR.crop.hidden = fit !== 'cover';
}

function applyFramer() {
  const s = framerState;
  if (!s) return;
  s.onApply({ pos_x: Math.round(s.x), pos_y: Math.round(s.y), zoom: +s.zoom.toFixed(2) });
  closeFramer();
}

/* Dragging moves the kept area over the picture. */
(() => {
  const hole = document.getElementById('framerHole');
  if (!hole) return;
  let from = null;

  hole.addEventListener('pointerdown', (e) => {
    if (!framerState) return;
    hole.setPointerCapture(e.pointerId);
    from = { mx: e.clientX, my: e.clientY, x: framerState.x, y: framerState.y,
             rect: hole.parentElement.getBoundingClientRect(),
             hw: hole.offsetWidth, hh: hole.offsetHeight };
  });
  hole.addEventListener('pointermove', (e) => {
    if (!from || !framerState) return;
    // Movement is in pixels; the setting is a percentage of the slack, so the
    // conversion depends on how much room there is to move at all.
    const slackX = Math.max(1, from.rect.width - from.hw);
    const slackY = Math.max(1, from.rect.height - from.hh);
    framerState.x = Math.max(0, Math.min(100, from.x + (e.clientX - from.mx) / slackX * 100));
    framerState.y = Math.max(0, Math.min(100, from.y + (e.clientY - from.my) / slackY * 100));
    layoutFramer();
  });
  const stop = (e) => {
    if (from) { try { hole.releasePointerCapture(e.pointerId); } catch (_) {} }
    from = null;
  };
  hole.addEventListener('pointerup', stop);
  hole.addEventListener('pointercancel', stop);

  document.getElementById('framerZoom').addEventListener('input', (e) => {
    if (!framerState) return;
    framerState.zoom = Math.max(1, +e.target.value / 100);
    layoutFramer();
  });
  document.getElementById('framerCenter').addEventListener('click', () => {
    if (!framerState) return;
    framerState.x = 50; framerState.y = 50; framerState.zoom = 1;
    document.getElementById('framerZoom').value = '100';
    layoutFramer();
  });
  document.getElementById('framerApply').addEventListener('click', applyFramer);
  document.getElementById('framerCancel').addEventListener('click', closeFramer);
  document.getElementById('framer').addEventListener('pointerdown', (e) => {
    if (e.target.id === 'framer') closeFramer();       // click the backdrop
  });
  window.addEventListener('resize', () => {
    if (!framerState) return;
    framerState.box = null;             // the wrapper just changed size
    layoutFramer();
  });
})();
