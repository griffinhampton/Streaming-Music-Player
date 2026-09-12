/* Decorative borders, shared by the overlay and the app.

   Two kinds:
     motifs      repeating SVG tiles (the pretty ones - pastel sakura and
                 friends). Drawn as a tiled background on each edge strip.
     characters  a short string repeated around the edge. Cheap, recolors
                 with the theme, good for terminal/arcade looks.

   Motif ids are prefixed "motif:" in the config so one field covers both. */

const BORDER_MOTIFS = {
  hand:     { label: 'Cherry blossom (hand drawn)', file: 'motif-sakura-hand.svg', tile: 104 },
  handd:    { label: 'Cherry blossom (dense)', file: 'motif-sakura-hand-dense.svg', tile: 74 },
  sakura:   { label: 'Cherry blossom (small)', file: 'motif-sakura.svg', tile: 48 },
  petals:   { label: 'Falling petals', file: 'motif-petals.svg',   tile: 48 },
  seigaiha: { label: 'Wave (seigaiha)', file: 'motif-seigaiha.svg', tile: 48 },
};

const BORDER_PATTERNS = {
  sparkle:  '✧ ⋆ ˚ ✦ ',
  stars:    '★ ☆ ⋆ ',
  hearts:   '♡ ˖ ᰔ ˖ ',
  moon:     '☾ ⋆ ✧ ',
  music:    '♪ ♫ ♬ ',
  dots:     '· • · ',
  dashes:   '─ · ',
  blocks:   '▚ ▞ ',
  arrows:   '➤ ˖ ',
  crosses:  '✕ ˖ ',
};

const KAOMOJI = [
  '', '(◕‿◕)', '(｡•̀ᴗ-)✧', '♡(˃͈ દ ˂͈ )', '(づ｡◕‿‿◕｡)づ', 'ʕ•ᴥ•ʔ',
  '٩(◕‿◕)۶', '(⁄ ⁄•⁄ω⁄•⁄ ⁄)', '(*ﾉ▽ﾉ)', '≧◡≦', '(￣ω￣)', '(╯°□°)╯',
  'ヽ(•‿•)ノ', '(ᵔᴥᵔ)', '☆*:.｡.o(≧▽≦)o.｡.:*☆',
];

/**
 * Paint a decorative frame.
 * @param {HTMLElement} root      carries the has-decor / decor-* classes
 * @param {HTMLElement} container holds the four .decor-strip nodes
 * @param {object} decor          {border, custom, sides, size, opacity, color, gap}
 * @param {string} fallbackColor  used when decor.color is blank
 */
function renderDecor(root, container, decor, fallbackColor) {
  if (!root || !container) return;
  const d = decor || {};
  const sides = d.sides || 'none';
  const custom = (d.custom || '').trim();

  const motifKey = (d.border || '').startsWith('motif:') ? d.border.slice(6) : '';
  const motif = !custom && BORDER_MOTIFS[motifKey];
  const chars = custom || (motif ? '' : BORDER_PATTERNS[d.border] || '');

  const on = (!!motif || !!chars) && sides !== 'none';
  if (!on || sides !== 'all') clearLoop(container);
  root.classList.toggle('has-decor', on);
  root.classList.toggle('decor-motif', on && !!motif);
  for (const side of ['top', 'bottom', 'left', 'right']) {
    let show = false;
    if (on) {
      if (sides === 'all') show = true;
      else if (sides === 'tb') show = side === 'top' || side === 'bottom';
      else show = sides === side;
    }
    root.classList.toggle('decor-' + side, show);
  }
  root.classList.toggle('decor-animate', on && !!d.animate);
  // Underlay by default: the frame sits behind the card and reads as a soft
  // watermark rather than something pasted over the artwork.
  const over = d.layer === 'over';
  root.classList.toggle('decor-over', on && over);
  root.classList.toggle('decor-under', on && !over);
  if (!on) return;

  const rootPx = parseFloat(getComputedStyle(root).fontSize) || 16;
  const size = d.size ?? 0.62;
  const bandPx = motif ? size * rootPx : size * rootPx * 1.55 + 4;

  const strips = container.querySelectorAll('.decor-strip');
  if (motif) {
    // Tinted: draw the tile as a mask so the shapes take --decor-color.
    // Otherwise use the artwork's own colors.
    const tint = d.tint !== false;
    const color = d.color || fallbackColor || '#ffffff';
    strips.forEach((strip) => {
      const vertical = strip.classList.contains('decor-left') ||
                       strip.classList.contains('decor-right');
      const repeat = vertical ? 'repeat-y' : 'repeat-x';
      // Tiles are square, so lock the cross-axis to the strip; `gap` then
      // stretches the repeat axis to space the motifs out. Resolved to px:
      // background-size rejects a calc() that references a variable.
      const tile = (bandPx * (1 + Math.max(0, d.gap ?? 0.5))).toFixed(1) + 'px';
      const size = vertical ? `100% ${tile}` : `${tile} 100%`;
      const url = `url("${motif.file}")`;

      // The pattern goes on the inner span, not the strip. The span is twice
      // the length of the strip, so sliding it half its length scrolls the
      // motifs seamlessly - and that works whether the pattern is a background
      // or a mask. Animating background-position would do nothing when tinted,
      // because then the shapes come from the mask.
      const span = strip.querySelector('span');
      if (!span) return;
      span.textContent = '';
      const st = span.style;
      strip.style.backgroundImage = 'none';
      strip.style.backgroundColor = 'transparent';
      st.width = vertical ? '100%' : '200%';
      st.height = vertical ? '200%' : '100%';
      if (tint) {
        st.backgroundImage = 'none';
        st.backgroundColor = color;
        st.webkitMaskImage = url;  st.maskImage = url;
        st.webkitMaskRepeat = repeat; st.maskRepeat = repeat;
        st.webkitMaskSize = size;  st.maskSize = size;
        st.webkitMaskPosition = 'center'; st.maskPosition = 'center';
      } else {
        st.backgroundColor = 'transparent';
        st.webkitMaskImage = 'none'; st.maskImage = 'none';
        st.backgroundImage = url;
        st.backgroundRepeat = repeat;
        st.backgroundSize = size;
        st.backgroundPosition = 'center';
      }
    });
  } else {
    // Repeat enough to overrun the longest edge; uniform repetition also lets
    // the drift animation loop without a visible seam.
    const text = chars.repeat(60);
    strips.forEach((strip) => {
      strip.style.backgroundImage = '';
      strip.style.backgroundColor = 'transparent';
      const span = strip.querySelector('span');
      if (!span) return;
      const st = span.style;
      st.backgroundImage = 'none';
      st.backgroundColor = 'transparent';
      st.webkitMaskImage = 'none'; st.maskImage = 'none';
      st.width = ''; st.height = '';
      span.textContent = text;
    });
  }

  // Custom properties inherit, so set them on the root. --decor-size stays in
  // em for the character strips (which are sized by font-size), while
  // --decor-px is the same value already resolved against the root font size:
  // an em band inside an em-sized container would otherwise compound.
  // Motif tiles fill a band exactly `size` em thick; character strips use
  // `size` as their font size and get a roomier box, since symbol and emoji
  // ink runs well past a one-line box and would otherwise be clipped.
  const style = root.style;
  style.setProperty('--decor-size', size + 'em');
  style.setProperty('--decor-font', size + 'em');
  style.setProperty('--decor-px', bandPx.toFixed(1) + 'px');
  style.setProperty('--decor-opacity', String(d.opacity ?? 0.85));
  style.setProperty('--decor-gap', (d.gap ?? 0.5) + 'em');
  style.setProperty('--decor-color', d.color || fallbackColor || 'currentColor');
  container.style.filter = (d.blur > 0) ? 'blur(' + d.blur + 'px)' : '';
  style.setProperty('--decor-inset', String(d.inset ?? 1.0));
  // Seconds for one full pass around an edge. Higher speed = shorter time.
  const speed = Math.max(0.05, Number(d.speed ?? 1));
  style.setProperty('--decor-time', (24 / speed).toFixed(2) + 's');

  if (sides === 'all') {
    renderLoop(container, {
      motif, chars, band: bandPx, gap: Math.max(0, d.gap ?? 0.5), speed,
      animate: !!d.animate, tint: d.tint !== false, color: d.color || fallbackColor || '#ffffff',
    });
  }
}

/* ---------------------------------------------------------------- the loop

   A frame on all four sides runs as one loop. Every icon rides a single path
   traced through the icons' centers - a rounded rectangle half a band in
   from the edge, its corners following the card's - at one steady speed,
   evenly spaced, round the corners and on round again. Four strips sliding
   separately could only ever meet at the corners.

   It is drawn on one canvas, 30 times a second: each icon is drawn once onto
   a little sprite, and a frame only stamps the sprites at their places on the
   path (straight runs and true arcs, worked out exactly). Measured on the
   real window, that beat both ways of doing it with CSS - one animation per
   icon (Chrome ticks every one of them on every refresh of a 165 Hz screen)
   and one shared animated value (every icon's style recomputed each step).

   It stands still - evenly spaced - with drift off, in Ultra optimized, in a
   hidden window, and inside the deck while the deck is in the background,
   just as the deck pauses its other animations then. A frame too small for a
   ring keeps the four strips. */

const loops = new WeakMap();   // container -> loop state
const LOOP_FPS = 30;
const LOOP_MAX_ICONS = 200;

/** What goes round: whole runs between spaces - a symbol, a word, a kaomoji -
    so custom text keeps its pieces together. Spaces, including the wide
    ideographic ones, only ever spaced the old strips out. */
function splitRuns(text) {
  return String(text || '').split(/\s+/u).filter(Boolean);
}

function clearLoop(container) {
  const lp = container && loops.get(container);
  if (!lp) return;
  lp.ro.disconnect();
  clearTimeout(lp.timer);
  clearTimeout(lp.tick);
  document.removeEventListener('visibilitychange', lp.onVis);
  lp.canvas.remove();
  lp.dead = true;
  loops.delete(container);
  showStrips(container, true);
}

function showStrips(container, on) {
  container.querySelectorAll('.decor-strip').forEach((s) => { s.style.display = on ? '' : 'none'; });
}

/** The path through the icons' centers - a rounded rectangle half a band in
    from the edge, clockwise from the top-left corner. at(s) is the point s
    along it, wrapping round; straight runs and arcs are both exact. */
function loopPath(w, h, inset, r) {
  const x0 = inset, y0 = inset, x1 = w - inset, y1 = h - inset;
  const across = x1 - x0 - 2 * r, down = y1 - y0 - 2 * r, turn = Math.PI * r / 2;
  const arc = (cx, cy, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const runs = [
    [across, (t) => [x0 + r + t, y0]],
    [turn, (t) => arc(x1 - r, y0 + r, -Math.PI / 2 + t / r)],
    [down, (t) => [x1, y0 + r + t]],
    [turn, (t) => arc(x1 - r, y1 - r, t / r)],
    [across, (t) => [x1 - r - t, y1]],
    [turn, (t) => arc(x0 + r, y1 - r, Math.PI / 2 + t / r)],
    [down, (t) => [x0, y1 - r - t]],
    [turn, (t) => arc(x0 + r, y0 + r, Math.PI + t / r)],
  ];
  const len = runs.reduce((sum, run) => sum + run[0], 0);
  const at = (s) => {
    s = ((s % len) + len) % len;
    for (const [l, f] of runs) {
      if (s <= l) return f(s);
      s -= l;
    }
    return runs[0][1](0);
  };
  return { len, at };
}

function renderLoop(container, args) {
  let lp = loops.get(container);
  if (!lp) {
    const canvas = document.createElement('canvas');
    canvas.className = 'decor-loop';
    canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;';
    container.appendChild(canvas);
    lp = { canvas, ctx: canvas.getContext('2d'), sig: '', args: null, frame: null,
      timer: 0, tick: 0, frac: 0, last: 0, dead: false };
    // The path comes from the frame's size, so it is traced again when that
    // changes - a resized window, a card that grew a line.
    lp.ro = new ResizeObserver(() => {
      clearTimeout(lp.timer);
      lp.timer = setTimeout(() => buildLoop(container, lp), 120);
    });
    lp.ro.observe(container);
    lp.onVis = () => runLoop(lp);
    document.addEventListener('visibilitychange', lp.onVis);
    // A font you added can finish loading after the first draw; the sprites
    // were drawn in the fallback then, so draw them again.
    if (document.fonts) {
      document.fonts.addEventListener('loadingdone', () => {
        if (!lp.dead) { lp.sig = ''; buildLoop(container, lp); }
      });
    }
    if (window.onMotionChange) window.onMotionChange(() => { if (!lp.dead) runLoop(lp); });
    // The deck pauses its animations while it is in the background - its own
    // frame, and the Now Playing preview inside it. Pop-out windows never.
    lp.deckish = window.top !== window || container.id === 'appDecor';
    loops.set(container, lp);
  }
  lp.args = args;
  buildLoop(container, lp);
}

function buildLoop(container, lp) {
  const a = lp.args;
  const w = container.clientWidth, h = container.clientHeight;
  const band = a.band;
  if (!w || !h) return;                                  // not laid out yet: the observer calls back
  if (!(w > band * 1.5 && h > band * 1.5)) {
    // No room for a ring: the four strips draw the frame instead.
    lp.frame = null;
    lp.sig = '';
    clearTimeout(lp.tick);
    lp.canvas.style.display = 'none';
    showStrips(container, true);
    return;
  }

  const cs = getComputedStyle(container);
  const fontPx = parseFloat(cs.fontSize) || 10;
  // Round the corners like the card they sit in - its inner curve, since the
  // frame lies inside its border - and give a square box a soft turn too.
  const box = getComputedStyle(container.parentElement || container);
  const boxRadius = Math.max(0, (parseFloat(box.borderTopLeftRadius) || 0)
    - Math.max(parseFloat(box.borderTopWidth) || 0, parseFloat(box.borderLeftWidth) || 0));
  const inset = band / 2;
  const r = Math.min(Math.max(band * 0.5, boxRadius - inset), (Math.min(w, h) - band) / 2);
  const path = loopPath(w, h, inset, r);
  // Right-to-left pages run the loop the other way round.
  const dir = cs.direction === 'rtl' ? -1 : 1;
  const dpr = window.devicePixelRatio || 1;
  const font = `${cs.fontStyle} ${cs.fontWeight} ${fontPx}px ${cs.fontFamily}`;
  const color = cs.color;

  // One pattern: each run's width, then the gap the Spacing setting and the
  // old strips' own spaces used to leave.
  const runs = a.motif ? [''] : splitRuns(a.chars);
  if (!runs.length) return;
  const gapPx = a.motif ? band * a.gap : fontPx * (2 * a.gap + 0.25);
  const measure = lp.ctx;
  measure.font = font;
  const widths = runs.map((t) => (a.motif ? band : Math.max(1, measure.measureText(t).width)));
  const patternLen = widths.reduce((sum, wd) => sum + wd + gapPx, 0);
  // A whole number of patterns, stretched a touch to fill the path exactly,
  // so there is no seam where the last icon meets the first.
  const reps = Math.max(1, Math.min(Math.floor(LOOP_MAX_ICONS / runs.length), Math.round(path.len / patternLen)));
  const scale = path.len / (reps * patternLen);
  const offs = [];
  const which = [];
  let s = 0;
  for (let k = 0; k < reps; k++) {
    runs.forEach((t, j) => {
      offs.push((s + widths[j] / 2) * scale);
      which.push(j);
      s += widths[j] + gapPx;
    });
  }
  const unit = a.motif ? band * 0.65 : fontPx;
  const lap = Math.max(0.5, path.len / Math.max(1, 5.4 * unit * a.speed));   // seconds round, at the old drift's pace

  const sig = [w, h, band, r.toFixed(1), runs.join(' '), a.motif ? a.motif.file : '', a.tint, a.color, color,
    font, offs.length, lap.toFixed(3), a.animate, dir, dpr].join('|');
  if (sig === lp.sig) return;
  lp.sig = sig;

  // Every icon drawn once, at the canvas's own resolution.
  const sprites = runs.map((t, j) => {
    const c = document.createElement('canvas');
    c.width = Math.ceil((widths[j] + fontPx * 0.5) * dpr);
    c.height = Math.ceil(band * dpr);
    const x = c.getContext('2d');
    if (!a.motif) {
      x.font = `${cs.fontStyle} ${cs.fontWeight} ${fontPx * dpr}px ${cs.fontFamily}`;
      x.fillStyle = color;
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.fillText(t, c.width / 2, c.height / 2);
    }
    return c;
  });
  if (a.motif) {
    const img = new Image();
    img.onload = () => {
      const c = sprites[0], x = c.getContext('2d');
      x.clearRect(0, 0, c.width, c.height);
      const fit = Math.min(c.width / (img.naturalWidth || 1), c.height / (img.naturalHeight || 1));
      const iw = (img.naturalWidth || c.width) * fit, ih = (img.naturalHeight || c.height) * fit;
      x.drawImage(img, (c.width - iw) / 2, (c.height - ih) / 2, iw, ih);
      if (a.tint) {
        // Tinted: keep the tile's shape, take the frame's color.
        x.globalCompositeOperation = 'source-in';
        x.fillStyle = a.color;
        x.fillRect(0, 0, c.width, c.height);
        x.globalCompositeOperation = 'source-over';
      }
      if (!lp.dead) runLoop(lp);
    };
    img.src = a.motif.file;
  }

  lp.canvas.width = Math.round(w * dpr);
  lp.canvas.height = Math.round(h * dpr);
  lp.canvas.style.display = '';
  showStrips(container, false);
  lp.frame = { path, offs, which, sprites, lap, dir, dpr, animate: a.animate };
  runLoop(lp);
}

/** Draw a frame now, and the next one a thirtieth of a second on while it
    moves. The ring's place is kept as a fraction of a lap, so a re-trace - a
    resize, a new speed - carries on from where it was. */
function runLoop(lp) {
  clearTimeout(lp.tick);
  const f = lp.frame;
  if (!f || lp.dead) return;
  let focused = true;
  if (lp.deckish) {
    try { focused = window.top.document.hasFocus(); } catch (_) { focused = true; }
  }
  const ultra = !!(window.isUltra && window.isUltra());
  // data-still: the deck paused its preview (ten seconds without input, see
  // deck.js) - a canvas loop is no CSS animation, so it has to ask.
  const still = document.documentElement.hasAttribute('data-still');
  const moving = f.animate && !ultra && !still && focused && document.visibilityState !== 'hidden';
  const now = performance.now();
  if (moving && lp.last) lp.frac = (lp.frac + (now - lp.last) / 1000 / f.lap) % 1;
  lp.last = moving ? now : 0;
  // Standing still, the ring is drawn once: the 500 ms check below used to
  // clear and redraw the same frame twice a second.
  const shown = f.animate && !ultra ? lp.frac : 0;
  if (moving || lp.drawnFrame !== f || lp.drawnFrac !== shown) {
    drawLoop(lp, shown);
    lp.drawnFrame = f;
    lp.drawnFrac = shown;
  }
  if (moving) lp.tick = setTimeout(() => runLoop(lp), 1000 / LOOP_FPS);
  else if (f.animate && !ultra && document.visibilityState !== 'hidden') {
    lp.tick = setTimeout(() => runLoop(lp), 500);          // back in front yet?
  }
}

function drawLoop(lp, frac) {
  const f = lp.frame, ctx = lp.ctx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, lp.canvas.width, lp.canvas.height);
  const base = frac * f.path.len;
  for (let i = 0; i < f.offs.length; i++) {
    const sp = f.sprites[f.which[i]];
    const [x, y] = f.path.at(f.dir * (base + f.offs[i]));
    ctx.drawImage(sp, Math.round(x * f.dpr - sp.width / 2), Math.round(y * f.dpr - sp.height / 2));
  }
}

/** Options for a <select>, motifs first since they look better. */
function decorOptions(escFn) {
  const e = escFn || ((x) => x);
  const out = ['<option value="">- none -</option>'];
  for (const [key, m] of Object.entries(BORDER_MOTIFS)) {
    out.push(`<option value="motif:${key}">${e(m.label)}</option>`);
  }
  for (const key of Object.keys(BORDER_PATTERNS)) {
    out.push(`<option value="${key}">${e(key)} &nbsp; ${e(BORDER_PATTERNS[key].trim())}</option>`);
  }
  return out.join('');
}
