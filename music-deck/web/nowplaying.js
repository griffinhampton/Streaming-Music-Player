/* Now Playing window.

   Listens to the deck over server-sent events, keeps its own smooth clock so
   the progress bar never stutters, paints every design setting onto CSS
   variables, and lets you drag the frameless window around.

   The same page runs inside the deck's live preview (?preview=1), where it
   shows a demo track and takes design updates by postMessage for zero lag. */

const PREVIEW = new URLSearchParams(location.search).has('preview');
// Inside a scene (embed.js): the scene feeds us and owns the window.
const EMBED = !!window.EMBED;
const STANDALONE = !PREVIEW && !EMBED;

const el = {
  stage: document.getElementById('stage'),
  art: document.getElementById('art'),
  title: document.getElementById('title'),
  artist: document.getElementById('artist'),
  label: document.getElementById('label'),
  source: document.getElementById('source'),
  fill: document.getElementById('progressFill'),
  elapsed: document.getElementById('elapsed'),
  remain: document.getElementById('remain'),
  close: document.getElementById('closeBtn'),
  transport: document.getElementById('transport'),
  bgImage: document.getElementById('bgImage'),
  bgDim: document.getElementById('bgDim'),
  cardBg: document.getElementById('cardBg'),
  back: document.getElementById('stickersBack'),
  front: document.getElementById('stickersFront'),
};

const DEMO = {
  source: 'local', source_label: 'Local library',
  title: 'Neon Highway (Extended Mix)', artist: 'The Static Waves',
  album: 'Afterglow', art_url: '', playing: true, position: 74, duration: 241,
};

let design = null;
let clock = { position: 0, duration: 0, playing: false, at: performance.now() };
let trackKey = '';

const fmt = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ------------------------------------------------------------- design */

let artMode = false;
let lastArtUrl = '';
let changingTimer = 0;       // ends the entrance animation's class
const ART_KEYS = new Set(['--accent', '--on-accent', '--title-color', '--artist-color', '--card-border-color']);
let artPaintedFor = '';     // the art url the card background currently shows

/* Use the album art as the card's own background, and pull readable text and
   accent colors out of it. Runs when the mode is switched on and again on
   every track change, since the art - and therefore the whole look - changes
   with the song. */
function paintArtBackground() {
  if (!artMode) return;
  const url = (lastArtUrl || '').split('&k=')[0];
  const layer = el.stage.classList.contains('surround') ? el.cardBg : el.bgImage;
  if (!url) { layer.style.backgroundImage = ''; return; }
  layer.style.backgroundImage = `url("${lastArtUrl}")`;
  layer.style.backgroundSize = 'cover';
  layer.style.backgroundPosition = 'center';
  layer.style.backgroundRepeat = 'no-repeat';
  el.stage.classList.add('has-bg-image');

  if (url === artPaintedFor || typeof paletteForUrl !== 'function') return;
  artPaintedFor = url;
  // Key by the stable part of the url, not the cache-busted full one.
  paletteForUrl(lastArtUrl, url).then((th) => {
    if (!th || !artMode) return;
    const set = (k, v) => el.stage.style.setProperty(k, v);
    // The colors palette.js derives are guaranteed readable on th.bg. So make
    // the veil BE th.bg, darkened by exactly the amount it worked out the
    // worst patch of this cover needs - then the same text stays legible over
    // any album, bright or dark, without a per-cover fiddle.
    set('--bg', th.bg);
    el.bgDim.style.background = th.bg;
    const wanted = Math.max((design.bg || {}).dim ?? 0, th.veil ?? 0.45);
    el.bgDim.style.opacity = String(wanted);
    set('--title-color', th.text);
    set('--artist-color', th.muted);
    set('--accent', th.accent);
    set('--on-accent', readableOn(th.accent));
    set('--card-border-color', th.line);
  });
}

function applyDesign(np) {
  if (!np) return;
  if (design && JSON.stringify(np) === JSON.stringify(design)) return;
  design = JSON.parse(JSON.stringify(np));

  const s = el.stage;
  const bg = np.bg || {};
  const card = np.card || {};
  const text = np.text || {};
  const art = np.art || {};
  const prog = np.progress || {};
  const label = np.label || {};

  const classes = ['stage', 'layout-' + effectiveLayout(np)];
  if (PREVIEW) classes.push('preview');
  if (!art.show) classes.push('hide-art');
  if (!prog.show) classes.push('hide-progress');
  if (!prog.times) classes.push('hide-times');
  if (!label.show) classes.push('hide-label');
  if (!np.source_badge) classes.push('hide-source');
  if (card.glow) classes.push('card-glow');
  if (prog.glow) classes.push('bar-glow');
  if (np.equalizer) classes.push('show-eq');
  if (text.uppercase) classes.push('uppercase-title');
  if (text.align === 'center') classes.push('align-center');
  if (np.interactive !== false && !PREVIEW) classes.push('interactive');
  // Keep whichever art state we had; render() owns that class.
  if (s.classList.contains('no-art-image')) classes.push('no-art-image');
  if (s.classList.contains('offline-on')) classes.push('offline-on');
  s.className = classes.join(' ');

  const accent = np.accent || '#8b5cf6';
  const pal = np.palette || {};
  // Blank means "inherit from the palette", which is what makes one color
  // change ripple through the whole design.
  const TEXT = pal.text || '#f4f4f8';
  const MUTED = pal.muted || '#9a9aa8';
  const LINE = pal.line || '#2a2a3a';
  // In album-art mode the cover supplies accent and text colors (paintArt
  // Background sets them per track); everything else still comes from here.
  const artOwns = (np.bg || {}).mode === 'art';
  const set = (k, v) => { if (!(artOwns && ART_KEYS.has(k))) s.style.setProperty(k, v); };

  set('--accent', accent);
  set('--on-accent', readableOn(accent));
  set('--card-fill', card.fill
    ? `color-mix(in srgb, ${card.fill} ${Math.round((card.fill_alpha ?? 1) * 100)}%, transparent)`
    : 'transparent');
  set('--card-radius', (card.radius ?? 18) + 'px');
  set('--card-pad', (card.padding ?? 12) + 'px');
  set('--card-border', (card.border ?? 1) + 'px');
  set('--card-border-color', card.border_color || LINE);
  set('--art-radius', (art.radius ?? 10) + 'px');
  set('--art-border', (art.border ?? 0) + 'px');
  set('--art-border-color', art.border_color || LINE);
  set('--bar-h', (prog.height ?? 5) + 'px');
  set('--bar-color', prog.color || accent);
  set('--title-size', (text.title_size ?? 1.72) + 'em');
  set('--title-weight', text.title_weight ?? 700);
  set('--title-color', text.title_color || TEXT);
  set('--artist-size', (text.artist_size ?? 1.0) + 'em');
  set('--artist-color', text.artist_color || MUTED);
  set('--label-size', (text.label_size ?? 0.72) + 'em');
  set('--label-color', text.label_color || accent);
  set('--font', `"${(text.font || 'Segoe UI').replace(/"/g, '')}", "Segoe UI", system-ui, sans-serif`);

  const sh = Number(text.shadow || 0);
  set('--text-shadow', sh > 0
    ? `0 ${(0.05 * sh).toFixed(3)}em ${(0.22 * sh).toFixed(3)}em rgba(0,0,0,${Math.min(0.9, sh)})`
    : 'none');

  // Background: solid, gradient, a dropped-in image, generated artwork, or the
  // album art itself - on the whole window, or inside the card with a flat
  // color around it.
  const sur = np.surround || {};
  const surround = sur.mode === 'solid';
  s.classList.toggle('surround', surround);
  artMode = bg.mode === 'art';
  s.classList.toggle('art-bg', artMode);
  if (artMode) {
    // The picture is the cover, painted when the track changes; here we only
    // need the veil that keeps the text off it.
    set('--surround', sur.color || '#000000');
    el.bgDim.style.opacity = String(bg.dim ?? 0.45);
    paintArtBackground();          // repaint now in case the mode just changed
  } else if (surround) {
    set('--surround', sur.color || '#000000');
    applyBackgroundInside(s, el.cardBg, bg);
    el.bgDim.style.opacity = String(bg.dim ?? 0);
  } else {
    applyBackground(s, el.bgImage, bg, set);
    el.bgDim.style.opacity = String(bg.dim ?? 0);
  }

  // Inside the card the strips hug its inner edge and are clipped by its
  // rounded corners; outside, they sit in the margin around it.
  const decorEl = document.getElementById('decor');
  const inside = (np.decor || {}).place !== 'out';
  const wanted = inside ? document.getElementById('card') : s;
  if (decorEl.parentElement !== wanted) {
    wanted.appendChild(decorEl);
  }
  s.classList.add(inside ? 'decor-in' : 'decor-out');

  el.label.textContent = label.text || 'NOW PLAYING';
  const kao = document.getElementById('kaomoji');
  if (kao) kao.textContent = (np.decor && np.decor.kaomoji) || '';
  renderStickers(np.stickers || []);
  sizeRoot();                                   // decor thickness reads this
  renderDecor(s, document.getElementById('decor'), np.decor, accent);
  // The buttons follow the design too, so a change shows up straight away
  // rather than waiting for the next track.
  renderTransport(el.transport, np.controls, clock.playing, buttonsVisible(), TRANSPORT_REFS);
  const wrap = document.getElementById('artWrap');
  const inArt = (np.controls || {}).place === 'art';
  if (inArt && el.transport.parentElement !== wrap) wrap.appendChild(el.transport);
  if (!inArt && el.transport.parentElement === wrap) {
    document.querySelector('.info').appendChild(el.transport);
  }
  requestAnimationFrame(measureMarquee);
}

/* An animated sticker - a GIF, an animated WebP - restarts from its first
   frame every time its <img> is recreated, and the design is re-applied on
   every state broadcast. Rebuilt naively, a GIF would reset about once a
   second and look permanently stuck on frame one.

   So the DOM is only rebuilt when the set of stickers actually changes;
   position, size, rotation and opacity are written straight onto the existing
   elements, which leaves the animation running even while you drag one. */
let stickerKey = '';

function renderStickers(list) {
  const back = [], front = [];
  for (const st of list) {
    if (!st || !st.asset) continue;
    ((st.z ?? 5) < 0 ? back : front).push(st);
  }

  const geometryProps = (st) => ({
    left: (+st.x || 0) + '%',
    top: (+st.y || 0) + '%',
    width: (+st.w || 20) + '%',
    opacity: String(st.opacity ?? 1),
    zIndex: String(Math.abs(st.z ?? 5)),
    transform: `translate(-50%,-50%) rotate(${+st.rot || 0}deg) scaleX(${st.flip ? -1 : 1})`,
  });
  const geometry = (st) => Object.entries(geometryProps(st))
    .map(([k, v]) => k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()) + ':' + v)
    .join(';') + ';';

  // What has to change for the elements themselves to be wrong. Anything not
  // in here is a style we can just overwrite.
  const key = JSON.stringify([isUltra(), list.map((st) => st && st.asset
    ? [st.asset, !!st.tint, st.color || '', st.ar || 1, (st.z ?? 5) < 0]
    : null)]);

  if (key !== stickerKey) {
    stickerKey = key;
    const build = (node, items) => {
      node.innerHTML = items.map((st) => {
        const url = `/asset/${encodeURIComponent(st.asset)}`;
        if (st.tint && st.color) {
          // A dropped-in picture keeps its own colors as an <img>. Painting it
          // through a mask instead lets it take one color, like the built-in
          // motifs - the shape survives, the original colors do not. A mask
          // only ever uses the first frame, so tinting freezes an animation.
          return `<div class="sticker sticker-tinted" style="${geometry(st)}
            background-color:${st.color};
            -webkit-mask-image:url('${url}'); mask-image:url('${url}');
            aspect-ratio:${st.ar || 1};"></div>`;
        }
        // Ultra optimized: an animated picture holds its first frame.
        return `<img class="sticker" src="${stillOf(url)}" alt="" style="${geometry(st)}">`;
      }).join('');
    };
    build(el.back, back);
    build(el.front, front);
    return;
  }

  // Same stickers as last time: move them, do not remake them. Only the
  // geometry can have changed - the key above pins the asset, tint, color and
  // ratio - so write those properties and leave the rest of the declaration
  // alone rather than re-serialising it all through cssText.
  const move = (node, items) => {
    const nodes = node.children;
    for (let i = 0; i < items.length && i < nodes.length; i++) {
      const g = geometry(items[i]);
      if (nodes[i].dataset.geo === g) continue;      // nothing moved
      nodes[i].dataset.geo = g;
      Object.assign(nodes[i].style, geometryProps(items[i]));
    }
  };
  move(el.back, back);
  move(el.front, front);
}

/* "auto" reads the window's shape: squarish gets the stacked card, wide gets
   the bar, and a thin strip gets the compact row - so stretching the window
   into a new shape is all it takes to change mode. */
function effectiveLayout(np) {
  const want = (np && np.layout) || 'auto';
  if (want !== 'auto') return want;
  const ar = window.innerHeight / Math.max(1, window.innerWidth);
  if (ar > 0.72) return 'card';
  if (ar < 0.19) return 'compact';
  return 'bar';
}

function refreshLayout() {
  if (!design) return;
  const s = el.stage;
  const layout = effectiveLayout(design);
  [...s.classList].filter((c) => c.startsWith('layout-')).forEach((c) => s.classList.remove(c));
  s.classList.add('layout-' + layout);
  sizeRoot();
  renderDecor(s, document.getElementById('decor'), design.decor, design.accent || '#8b5cf6');
  requestAnimationFrame(measureMarquee);
}

function sizeRoot() {
  const w = window.innerWidth, h = window.innerHeight;
  const layout = effectiveLayout(design);
  let base;
  if (layout === 'card') base = Math.min(w / 22, h / 20);
  else if (layout === 'compact') base = Math.min(h / 5.2, w / 30);
  else base = Math.min(h / 9.5, w / 30);
  const scale = (design && design.scale) || 1;
  document.documentElement.style.fontSize = Math.max(6, base * scale) + 'px';
}

/* Slide long titles instead of cutting them off. */
function measureMarquee() {
  // Ultra optimized ends a long title in an ellipsis instead (see the CSS).
  const on = !isUltra() && (!design || !design.text || design.text.marquee !== false);
  for (const node of [el.title, el.artist]) {
    node.classList.remove('marquee');
    node.style.removeProperty('--marquee-shift');
    if (!on) continue;
    const overflow = node.scrollWidth - node.parentElement.clientWidth;
    if (overflow > 4) {
      node.style.setProperty('--marquee-shift', (-overflow - 4) + 'px');
      node.style.setProperty('--marquee-time', Math.max(6, overflow / 26) + 's');
      node.classList.add('marquee');
    }
  }
}

/* ------------------------------------------------------------- rendering */

function render(now) {
  if (!now && PREVIEW) now = DEMO;

  if (!now) {
    el.stage.dataset.state = 'idle';
    el.title.textContent = 'Nothing playing';
    el.artist.textContent = '';
    el.source.textContent = '';
    el.stage.classList.add('no-art-image');
    clock = { position: 0, duration: 0, playing: false, at: performance.now() };
    trackKey = '';
    tick();
    requestAnimationFrame(measureMarquee);
    return;
  }

  const key = [now.source, now.title, now.artist, now.album].join('|');
  if (key !== trackKey) {
    trackKey = key;
    el.title.textContent = now.title || 'Unknown title';
    el.artist.textContent = now.artist || now.album || '';
    el.source.textContent = now.source_label || '';

    // Assume no art until an image actually decodes, otherwise a track without
    // a cover flashes the browser's broken-image icon on stream.
    el.stage.classList.add('no-art-image');
    if (now.art_url) {
      el.art.onerror = () => el.stage.classList.add('no-art-image');
      el.art.onload = () => el.stage.classList.remove('no-art-image');
      el.art.src = now.art_url + (now.art_url.includes('?') ? '&' : '?') +
                   'k=' + encodeURIComponent(key.slice(0, 40));
      lastArtUrl = el.art.src;
    } else {
      el.art.removeAttribute('src');
      lastArtUrl = '';
    }
    paintArtBackground();       // the cover changed, so the card art does too

    el.stage.classList.remove('changing');
    void el.stage.offsetWidth;   // restart the entrance animation
    el.stage.classList.add('changing');
    // ...and end it once it has played: `.changing .title` outranks
    // `.marquee`, so while the class stayed on a long title never slid.
    clearTimeout(changingTimer);
    changingTimer = setTimeout(() => el.stage.classList.remove('changing'), 450);
    requestAnimationFrame(measureMarquee);
  }

  el.stage.dataset.state = now.playing ? 'playing' : 'paused';
  // Only the play/pause icon depends on this; the rest of the row follows the
  // design and is drawn in applyDesign.
  renderTransport(el.transport, (design || {}).controls, now.playing, buttonsVisible(), TRANSPORT_REFS);

  // Only re-seat the clock on a real jump, so normal playback stays smooth.
  const drift = Math.abs(clock.position - now.position);
  if (drift > 1.2 || clock.playing !== now.playing || clock.duration !== now.duration) {
    clock = {
      position: now.position || 0,
      duration: now.duration || 0,
      playing: !!now.playing,
      at: performance.now(),
    };
    tick();
  }
}

/** One side of the progress bar, per the chosen mode. */
function timeLabel(mode, pos, dur) {
  if (mode === 'none' || !isFinite(pos)) return '';
  if (mode === 'duration') return dur > 0 ? fmt(dur) : '';
  if (mode === 'remaining') return dur > 0 ? '-' + fmt(dur - pos) : '';
  return fmt(pos);                                   // elapsed
}

/* The clock wakes only when something on screen would change - the next
   whole second for the time labels, the next half pixel for the bar. Run
   on every frame it laid the window out 60 times a second to move a bar by
   nothing. Paused, it does not run at all; render() and a seek wake it. */
let tickTimer = null;
function tick() {
  clearTimeout(tickTimer);
  const trackW = Math.max(1, el.fill.parentElement.clientWidth);
  let pos = clock.position;
  if (clock.playing) pos += (performance.now() - clock.at) / 1000;
  const dur = clock.duration;
  if (dur > 0) pos = Math.min(pos, dur);
  const width = dur > 0 ? (pos / dur * 100).toFixed(2) + '%' : '0%';
  if (el.fill.style.width !== width) el.fill.style.width = width;
  const prog = (design && design.progress) || {};
  const left = timeLabel(prog.left || 'elapsed', pos, dur);
  const right = timeLabel(prog.right || 'remaining', pos, dur);
  if (el.elapsed.textContent !== left) el.elapsed.textContent = left;
  if (el.remain.textContent !== right) el.remain.textContent = right;
  if (!clock.playing || !(dur > 0) || pos >= dur) return;
  const toSecond = (1 - (pos % 1)) * 1000 + 10;
  const halfPixel = (dur / trackW) * 500;
  // Ultra optimized moves the bar with the seconds, once a second.
  tickTimer = setTimeout(tick, Math.max(40, isUltra() ? toSecond : Math.min(toSecond, halfPixel)));
}

/* ------------------------------------------------------------- transport */

let source = null;
let retry = null;

function takeSnapshot(data) {
  syncUserFonts(data.fonts_v);
  setUltra(data.ultra);
  applyDesign(data.nowplaying);
  render(data.now);
}

function connect() {
  if (EMBED) return;                 // the scene relays its own feed
  if (source) source.close();
  source = new EventSource('/api/events');

  source.onopen = () => el.stage.classList.remove('offline-on');
  source.onmessage = (event) => {
    try {
      takeSnapshot(JSON.parse(event.data));
    } catch (_) { /* a torn frame just means we wait for the next one */ }
  };
  source.onerror = () => {
    if (!PREVIEW) el.stage.classList.add('offline-on');
    source.close();
    clearTimeout(retry);
    retry = setTimeout(connect, 1500);
  };
}

/* The deck pushes design edits straight in, so the preview never lags. */
window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'design') applyDesign(e.data.nowplaying);
  if (e.data && e.data.type === 'ultra') setUltra(e.data.on);
});
if (EMBED) onEmbedState(takeSnapshot);

/* Ultra optimized switched, or a frozen picture is ready: draw it all again
   under the new rules - stickers rebuilt, marquee and clock decided afresh. */
onMotionChange(() => {
  const np = design;
  design = null;
  stickerKey = '';
  if (np) applyDesign(np);
  tick();
});

/* ------------------------------------------------------------- window */

/* Clicking the bar seeks. It sits above the drag handler and swallows its own
   pointer events, so the rest of the window still drags normally. */
function wireSeeking() {
  const track = document.querySelector('.progress-track');
  if (!track) return;
  const seekTo = (e) => {
    const dur = clock.duration;
    if (!dur) return;
    const r = track.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)));
    const to = frac * dur;
    clock = { ...clock, position: to, at: performance.now() };   // move instantly
    tick();
    fetch('/api/seek', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seconds: to }),
    }).catch(() => {});
  };
  track.addEventListener('pointerdown', (e) => {
    if (!interactive() || e.button !== 0) return;
    e.stopPropagation();
    track.setPointerCapture(e.pointerId);
    seekTo(e);
    const move = (ev) => seekTo(ev);
    const up = (ev) => {
      track.removeEventListener('pointermove', move);
      track.removeEventListener('pointerup', up);
      try { track.releasePointerCapture(ev.pointerId); } catch (_) {}
    };
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', up);
  });
}

function interactive() {
  return STANDALONE && !(design && design.interactive === false);
}

/* Whether the buttons show at all. On an inert window they would only
   mislead; in the deck's preview they show, so a placement can be judged
   without opening the window - but never press (that is interactive()). */
function buttonsVisible() {
  return !(design && design.interactive === false);
}

wireTransport(el.transport, interactive);

/* What the buttons can line up with instead of the whole card - the progress
   bar, or the cover - and a watch on both, so buttons lined up with one follow
   it through every resize and layout change rather than only on the next
   state broadcast. */
const TRANSPORT_REFS = {
  progress: { box: document.getElementById('progressWrap'),
              line: document.querySelector('#progressWrap .progress-track') },
  art: document.getElementById('artWrap'),
};
if (window.ResizeObserver) {
  const follow = new ResizeObserver(() => {
    const c = (design || {}).controls;
    if (c && c.show && c.anchor) placeRelative(el.transport, c, TRANSPORT_REFS);
  });
  [el.stage, TRANSPORT_REFS.art, TRANSPORT_REFS.progress.box].forEach((n) => n && follow.observe(n));
}

/* No title bar means dragging is the only way to move it: windowctl.js
   forwards pointer deltas to the server, which drives the host window. */
if (STANDALONE) {
  wireSeeking();
  attachWindowControls({ stage: el.stage, close: el.close, api: '/api/window' });
  reportWindowMetrics('/api/window');
}

/* ------------------------------------------------------------- boot */

window.addEventListener('resize', () => {
  refreshLayout();
  if (STANDALONE) reportWindowMetrics('/api/window');
});

if (!EMBED) {
  fetch('/api/state')
    .then((r) => r.json())
    .then((d) => { applyDesign(d.nowplaying); render(d.now); })
    .catch(() => {});
}

connect();
if (STANDALONE) reportWindowMetrics('/api/window');
tick();
setInterval(measureMarquee, 4000);
