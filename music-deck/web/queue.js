/* Queue window.

   Shows what Spotify will play next. It takes its look from the pop-out's
   design (over server-sent events) and polls the queue itself, since the queue
   is a Spotify call rather than part of the shared state. */

const PREVIEW = new URLSearchParams(location.search).has('preview');
const API = '/api/queue/window';

const el = {
  stage: document.getElementById('stage'),
  heading: document.getElementById('heading'),
  count: document.getElementById('count'),
  viewport: document.getElementById('viewport'),
  rows: document.getElementById('rows'),
  status: document.getElementById('status'),
  bgImage: document.getElementById('bgImage'),
  bgDim: document.getElementById('bgDim'),
  cardBg: document.getElementById('cardBg'),
};

const DEMO = {
  now: { title: 'Neon Highway', artist: 'The Static Waves', duration: 241, art: '' },
  queue: [
    { title: 'Cassette Sunrise', artist: 'Palm Lines', duration: 198, art: '' },
    { title: 'Hold the Line', artist: 'Marina Vale', duration: 224, art: '' },
    { title: 'Slow Motion City', artist: 'Auto Reply', duration: 187, art: '' },
    { title: 'Everything Amber', artist: 'Bright Harbour', duration: 253, art: '' },
    { title: 'Long Way Round', artist: 'The Static Waves', duration: 211, art: '' },
  ],
};

let design = null;
let opts = null;
let lastKey = '';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (s) => {
  if (!isFinite(s) || s <= 0) return '';
  return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
};

/* ------------------------------------------------------------- styling */

function applyDesign(np, cfg) {
  if (JSON.stringify(np) === JSON.stringify(design) &&
      JSON.stringify(cfg) === JSON.stringify(opts)) return;
  design = JSON.parse(JSON.stringify(np || {}));
  opts = JSON.parse(JSON.stringify(cfg || {}));

  const s = el.stage;
  const set = (k, v) => s.style.setProperty(k, v);
  const text = design.text || {};
  const card = design.card || {};
  const bg = design.bg || {};
  const accent = design.accent || '#8b5cf6';
  const follow = opts.follow_theme !== false;

  set('--accent', accent);
  set('--font', `"${(text.font || 'Segoe UI').replace(/"/g, '')}", "Segoe UI", system-ui, sans-serif`);
  set('--fg', text.title_color || '#f4f4f8');
  set('--dim', text.artist_color || 'rgba(244,244,248,.5)');
  set('--card-radius', (card.radius ?? 18) + 'px');
  set('--card-fill', follow ? (card.fill || 'transparent') : 'transparent');
  set('--card-border', follow ? (card.border ?? 0) + 'px' : '0px');
  set('--card-border-color', card.border_color || 'transparent');
  const sh = Number(text.shadow || 0);
  set('--text-shadow', sh > 0
    ? `0 ${(0.05 * sh).toFixed(3)}em ${(0.22 * sh).toFixed(3)}em rgba(0,0,0,${Math.min(0.9, sh)})`
    : 'none');

  const sur = design.surround || {};
  const surround = sur.mode === 'solid';
  s.classList.toggle('surround', surround);
  if (surround) set('--surround', sur.color || '#000000');

  if (follow) {
    if (surround) applyBackgroundInside(s, el.cardBg, bg);
    else applyBackground(s, el.bgImage, bg, set);
    el.bgDim.style.opacity = String(bg.dim ?? 0);
  } else {
    const own = opts.bg || '#0f0f17';
    set('--bg', own);
    if (surround) el.cardBg.style.background = own;
    s.classList.remove('has-bg-image');
    el.bgDim.style.opacity = '0';
  }

  s.classList.toggle('hide-art', opts.show_art === false);
  s.classList.toggle('hide-artist', opts.show_artist === false);
  s.classList.toggle('hide-times', opts.show_times === false);
  s.classList.toggle('hide-head', opts.show_header === false);
  s.classList.toggle('preview', PREVIEW);
  el.heading.textContent = opts.heading || 'UP NEXT';

  lastKey = '';                 // force a repaint in the new style
  sizeRoot();
}

function sizeRoot() {
  // Text size follows the window's width alone. Height is left to decide how
  // many tracks fit, so stretching the window taller shows more of the queue
  // instead of just enlarging the few already on screen.
  const scale = (opts && opts.scale) || 1;
  const base = Math.max(9, Math.min(window.innerWidth / 20, 30));
  document.documentElement.style.fontSize = (base * scale) + 'px';
}

/** Drop any row that would be clipped by the bottom of the window. */
function trimToFit() {
  const limit = el.viewport.clientHeight;
  const kids = [...el.rows.children];
  let shown = 0;
  for (const row of kids) {
    row.hidden = false;
    if (row.offsetTop + row.offsetHeight > limit + 1) row.hidden = true;
    else shown++;
  }
  return shown;
}

/* ------------------------------------------------------------- rendering */

function render(data) {
  const showNow = opts && opts.show_now;
  // `rows` is a ceiling; how many actually appear depends on the window height.
  const limit = Math.max(1, (opts && opts.rows) || 12);
  const items = [];
  if (showNow && data.now) items.push({ ...data.now, now: true });
  for (const t of (data.queue || [])) {
    if (items.length >= limit) break;
    items.push(t);
  }

  const key = JSON.stringify(items.map((t) => [t.title, t.artist, !!t.now]));
  if (key === lastKey) return;
  lastKey = key;

  if (!items.length) {
    el.stage.dataset.state = data.connected === false ? 'idle' : 'empty';
    el.status.textContent = data.connected === false
      ? 'Spotify account not connected' : 'Nothing queued';
    el.rows.innerHTML = '';
    return;
  }

  el.stage.dataset.state = 'ok';
  let n = 0;
  el.rows.innerHTML = items.map((t) => {
    const label = t.now ? '♪' : String(++n);
    return `<div class="row ${t.now ? 'now' : ''}">
        <div class="n">${label}</div>
        ${t.art ? `<img src="${esc(t.art)}" alt="" loading="lazy">` : '<img alt="">'}
        <div class="meta">
          <div class="t">${esc(t.title)}</div>
          <div class="a">${esc(t.artist)}</div>
        </div>
        <div class="d">${fmt(t.duration)}</div>
      </div>`;
  }).join('');
  const shown = trimToFit();
  const total = (data.queue || []).length;
  el.count.textContent = total
    ? (shown < total + (showNow && data.now ? 1 : 0) ? `${shown} of ${total}` : `${total} queued`)
    : '';
}

let pollTimer = null;
function poll() {
  if (PREVIEW) { render({ ...DEMO, connected: true }); return; }
  fetch('/api/spotify/queue').then((r) => r.json()).then((d) => {
    render(d.ok ? { now: d.now, queue: d.queue, connected: true }
                : { queue: [], connected: d.reason !== 'not connected' });
  }).catch(() => {});
}

/* ------------------------------------------------------------- transport */

let source = null, retry = null;
function connect() {
  if (source) source.close();
  source = new EventSource('/api/events');
  source.onopen = () => el.stage.classList.remove('offline-on');
  source.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      applyDesign(data.nowplaying, data.queue_cfg);
    } catch (_) { /* wait for the next frame */ }
  };
  source.onerror = () => {
    if (!PREVIEW) el.stage.classList.add('offline-on');
    source.close();
    clearTimeout(retry);
    retry = setTimeout(connect, 1500);
  };
}

window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'design') applyDesign(e.data.nowplaying, e.data.queue_cfg);
});

/* ------------------------------------------------------------- boot */

if (!PREVIEW) {
  attachWindowControls({
    stage: el.stage,
    grip: document.getElementById('grip'),
    close: document.getElementById('closeBtn'),
    api: API,
  });
  reportWindowMetrics(API);
}
window.addEventListener('resize', () => {
  sizeRoot();
  lastKey = '';            // force a repaint so the row count is recomputed
  poll();
  if (!PREVIEW) reportWindowMetrics(API);
});

fetch('/api/state').then((r) => r.json())
  .then((d) => applyDesign(d.nowplaying, d.queue_cfg)).catch(() => {});

connect();
poll();
pollTimer = setInterval(poll, 4000);
