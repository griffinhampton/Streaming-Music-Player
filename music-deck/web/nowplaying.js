/* Now Playing window.

   Listens to the deck over server-sent events, keeps its own smooth clock so
   the progress bar never stutters, paints every design setting onto CSS
   variables, and lets you drag the frameless window around.

   The same page runs inside the deck's live preview (?preview=1), where it
   shows a demo track and takes design updates by postMessage for zero lag. */

const PREVIEW = new URLSearchParams(location.search).has('preview');

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
  // Keep whichever art state we had; render() owns that class.
  if (s.classList.contains('no-art-image')) classes.push('no-art-image');
  if (s.classList.contains('offline-on')) classes.push('offline-on');
  s.className = classes.join(' ');

  const accent = np.accent || '#8b5cf6';
  const set = (k, v) => s.style.setProperty(k, v);

  set('--accent', accent);
  set('--card-fill', card.fill
    ? `color-mix(in srgb, ${card.fill} ${Math.round((card.fill_alpha ?? 1) * 100)}%, transparent)`
    : 'transparent');
  set('--card-radius', (card.radius ?? 18) + 'px');
  set('--card-pad', (card.padding ?? 12) + 'px');
  set('--card-border', (card.border ?? 1) + 'px');
  set('--card-border-color', card.border_color || 'transparent');
  set('--art-radius', (art.radius ?? 10) + 'px');
  set('--art-border', (art.border ?? 0) + 'px');
  set('--art-border-color', art.border_color || 'transparent');
  set('--bar-h', (prog.height ?? 5) + 'px');
  set('--bar-color', prog.color || accent);
  set('--title-size', (text.title_size ?? 1.72) + 'em');
  set('--title-weight', text.title_weight ?? 700);
  set('--title-color', text.title_color || '#f4f4f8');
  set('--artist-size', (text.artist_size ?? 1.0) + 'em');
  set('--artist-color', text.artist_color || 'rgba(244,244,248,.62)');
  set('--label-size', (text.label_size ?? 0.72) + 'em');
  set('--label-color', text.label_color || accent);
  set('--font', `"${(text.font || 'Segoe UI').replace(/"/g, '')}", "Segoe UI", system-ui, sans-serif`);

  const sh = Number(text.shadow || 0);
  set('--text-shadow', sh > 0
    ? `0 ${(0.05 * sh).toFixed(3)}em ${(0.22 * sh).toFixed(3)}em rgba(0,0,0,${Math.min(0.9, sh)})`
    : 'none');

  // Background: solid, gradient, a dropped-in image, or generated artwork -
  // on the whole window, or inside the card with a flat colour around it.
  const sur = np.surround || {};
  const surround = sur.mode === 'solid';
  s.classList.toggle('surround', surround);
  if (surround) {
    set('--surround', sur.color || '#000000');
    applyBackgroundInside(s, el.cardBg, bg);
  } else {
    applyBackground(s, el.bgImage, bg, set);
  }
  el.bgDim.style.opacity = String(bg.dim ?? 0);

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
  requestAnimationFrame(measureMarquee);
}

function renderStickers(list) {
  const back = [], front = [];
  for (const st of list) {
    if (!st || !st.asset) continue;
    ((st.z ?? 5) < 0 ? back : front).push(st);
  }
  const paint = (node, items) => {
    node.innerHTML = items.map((st) => {
      const flip = st.flip ? -1 : 1;
      return `<img class="sticker" src="/asset/${encodeURIComponent(st.asset)}" alt=""
        style="left:${+st.x || 0}%; top:${+st.y || 0}%; width:${+st.w || 20}%;
               opacity:${st.opacity ?? 1}; z-index:${Math.abs(st.z ?? 5)};
               transform: translate(-50%,-50%) rotate(${+st.rot || 0}deg) scaleX(${flip});">`;
    }).join('');
  };
  paint(el.back, back);
  paint(el.front, front);
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
  const on = !design || !design.text || design.text.marquee !== false;
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
    } else {
      el.art.removeAttribute('src');
    }

    el.stage.classList.remove('changing');
    void el.stage.offsetWidth;   // restart the entrance animation
    el.stage.classList.add('changing');
    requestAnimationFrame(measureMarquee);
  }

  el.stage.dataset.state = now.playing ? 'playing' : 'paused';

  // Only re-seat the clock on a real jump, so normal playback stays smooth.
  const drift = Math.abs(clock.position - now.position);
  if (drift > 1.2 || clock.playing !== now.playing || clock.duration !== now.duration) {
    clock = {
      position: now.position || 0,
      duration: now.duration || 0,
      playing: !!now.playing,
      at: performance.now(),
    };
  }
}

function tick() {
  let pos = clock.position;
  if (clock.playing) pos += (performance.now() - clock.at) / 1000;
  const dur = clock.duration;
  if (dur > 0) {
    pos = Math.min(pos, dur);
    el.fill.style.width = (pos / dur * 100).toFixed(2) + '%';
    el.elapsed.textContent = fmt(pos);
    el.remain.textContent = '-' + fmt(dur - pos);
  } else {
    el.fill.style.width = '0%';
    el.elapsed.textContent = fmt(pos);
    el.remain.textContent = '';
  }
  requestAnimationFrame(tick);
}

/* ------------------------------------------------------------- transport */

let source = null;
let retry = null;

function connect() {
  if (source) source.close();
  source = new EventSource('/api/events');

  source.onopen = () => el.stage.classList.remove('offline-on');
  source.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      applyDesign(data.nowplaying);
      render(data.now);
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
});

/* ------------------------------------------------------------- window */

function reportMetrics() {
  if (PREVIEW) return;
  fetch('/api/window/metrics', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inner_w: window.innerWidth,
      inner_h: window.innerHeight,
      dpr: window.devicePixelRatio,
    }),
  }).catch(() => {});
}

/* No title bar means dragging is the only way to move it: forward pointer
   deltas to the server, which calls SetWindowPos on the host window. */
if (!PREVIEW) {
  let dragging = false, pending = { dx: 0, dy: 0 }, last = null, flushTimer = null;

  const flush = () => {
    if (!pending.dx && !pending.dy) return;
    const body = JSON.stringify(pending);
    pending = { dx: 0, dy: 0 };
    fetch('/api/window/nudge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    }).catch(() => {});
  };

  el.stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.close') || e.button !== 0) return;
    dragging = true;
    last = { x: e.screenX, y: e.screenY };
    el.stage.setPointerCapture(e.pointerId);
    flushTimer = setInterval(flush, 40);
  });
  el.stage.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    pending.dx += e.screenX - last.x;
    pending.dy += e.screenY - last.y;
    last = { x: e.screenX, y: e.screenY };
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    clearInterval(flushTimer);
    flush();
    try { el.stage.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  el.stage.addEventListener('pointerup', endDrag);
  el.stage.addEventListener('pointercancel', endDrag);

  el.close.addEventListener('click', () => {
    fetch('/api/window/close', { method: 'POST' }).catch(() => {});
    setTimeout(() => window.close(), 200);
  });

  /* Resize grip: same idea as dragging, but the deltas go to the resize
     endpoint, which grows the host window and the Chrome child together. */
  const grip = document.getElementById('grip');
  let sizing = false, sizePending = { dw: 0, dh: 0 }, sizeLast = null, sizeTimer = null;
  const flushSize = () => {
    if (!sizePending.dw && !sizePending.dh) return;
    const body = JSON.stringify(sizePending);
    sizePending = { dw: 0, dh: 0 };
    fetch('/api/window/resize', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    }).catch(() => {});
  };
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    sizing = true;
    sizeLast = { x: e.screenX, y: e.screenY };
    grip.setPointerCapture(e.pointerId);
    sizeTimer = setInterval(flushSize, 40);
  });
  grip.addEventListener('pointermove', (e) => {
    if (!sizing) return;
    sizePending.dw += e.screenX - sizeLast.x;
    sizePending.dh += e.screenY - sizeLast.y;
    sizeLast = { x: e.screenX, y: e.screenY };
  });
  const endSize = (e) => {
    if (!sizing) return;
    sizing = false;
    clearInterval(sizeTimer);
    flushSize();
    try { grip.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  grip.addEventListener('pointerup', endSize);
  grip.addEventListener('pointercancel', endSize);
}

/* ------------------------------------------------------------- boot */

window.addEventListener('resize', () => {
  refreshLayout();
  reportMetrics();
});

fetch('/api/state')
  .then((r) => r.json())
  .then((d) => { applyDesign(d.nowplaying); render(d.now); })
  .catch(() => {});

connect();
reportMetrics();
requestAnimationFrame(tick);
setInterval(measureMarquee, 4000);
