/* Queue window.

   Shows what Spotify will play next. Its look, the queue itself and what is
   playing all arrive on the same server-sent state broadcast; this window
   never asks Spotify for anything. */

const PREVIEW = new URLSearchParams(location.search).has('preview');
// Inside a scene (embed.js): the scene feeds us and owns the window.
const EMBED = !!window.EMBED;
const STANDALONE = !PREVIEW && !EMBED;
const API = '/api/queue/window';

let lastPlaying = false;

const el = {
  stage: document.getElementById('stage'),
  heading: document.getElementById('heading'),
  count: document.getElementById('count'),
  viewport: document.getElementById('viewport'),
  rows: document.getElementById('rows'),
  status: document.getElementById('status'),
  transport: document.getElementById('transport'),
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
  // The window can carry its own colors (blank = inherit Now Playing). These
  // win regardless of follow_theme, which now only governs the background.
  const own = opts.colors || {};
  const uAcc = own.accent || accent;

  set('--accent', uAcc);
  set('--on-accent', readableOn(uAcc));
  set('--font', `"${(opts.font || text.font || 'Segoe UI').replace(/"/g, '')}", "Segoe UI", system-ui, sans-serif`);
  const pal = design.palette || {};
  set('--fg', own.text || text.title_color || pal.text || '#f4f4f8');
  set('--dim', own.muted || text.artist_color || pal.muted || '#9a9aa8');
  set('--card-radius', (card.radius ?? 18) + 'px');
  set('--card-fill', follow ? (card.fill || 'transparent') : 'transparent');
  set('--card-border', follow ? (card.border ?? 0) + 'px' : '0px');
  set('--card-border-color', card.border_color || pal.line || 'transparent');
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
    // This window has a look of its own: a full background, not just a color.
    const own = opts.bg_own || { mode: 'solid', color: opts.bg || '#0f0f17' };
    if (surround) applyBackgroundInside(s, el.cardBg, own);
    else applyBackground(s, el.bgImage, own, set);
    el.bgDim.style.opacity = String(own.dim ?? 0);
  }

  s.classList.toggle('hide-art', opts.show_art === false);
  s.classList.toggle('hide-artist', opts.show_artist === false);
  s.classList.toggle('hide-times', opts.show_times === false);
  s.classList.toggle('hide-head', opts.show_header === false);
  s.classList.toggle('interactive', !PREVIEW && opts.interactive !== false);
  // Same buttons as the pop-out, so a Next button works the same
  // wherever you decide to put one.
  renderTransport(el.transport, opts.controls, lastPlaying,
                  opts.interactive !== false);
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

  // The reason an empty list is empty is part of what is on screen, so it has
  // to be part of the key - otherwise the status text can never change.
  const key = JSON.stringify([items.map((t) => [t.title, t.artist, !!t.now]),
                              data.connected, data.note || '']);
  if (key === lastKey) return;
  lastKey = key;

  if (!items.length) {
    el.stage.dataset.state = data.connected === false ? 'idle' : 'empty';
    // Say why it is empty. "Nothing queued" during a rate limit reads as a
    // bug; the real reason is worth the two extra words on stream.
    el.status.textContent = data.note ? 'Spotify is rate limiting'
      : data.connected === false ? 'Spotify account not connected'
      : 'Nothing queued';
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

/* The queue rides the same state broadcast as everything else. The server owns
   it, refreshes it on its own thread when a track changes or someone presses a
   button, and never asks Spotify inside a rate-limit window - so this window
   never asks Spotify for anything. */
let lastQueueVersion = -1, lastQueue = null, lastNowRow = null;
function followQueue(q, now) {
  if (PREVIEW) { render({ ...DEMO, connected: true }); return; }
  if (!q) return;
  // The "now" row is the track Windows says is playing - true even while the
  // list itself is waiting out a limit.
  const nowRow = now && now.title
    ? { title: now.title, artist: now.artist, art: now.art_url || '', duration: now.duration }
    : q.now;
  if (q.version === lastQueueVersion && JSON.stringify(nowRow) === JSON.stringify(lastNowRow)) return;
  lastQueueVersion = q.version;
  lastNowRow = nowRow;
  let list = q.queue || [];
  // Waiting out a limit, the list can be one track behind the real player:
  // drop its head if it is the track now playing.
  if (nowRow && list.length && list[0].title === nowRow.title && list[0].artist === nowRow.artist) list = list.slice(1);
  lastQueue = (q.ok || list.length)
    ? { now: nowRow, queue: list, connected: true, note: q.retry_in ? q.reason : '' }
    : { queue: [], connected: q.reason !== 'not connected', note: q.retry_in ? q.reason : '' };
  render(lastQueue);
}

/* ------------------------------------------------------------- transport */

let source = null, retry = null;
function takeSnapshot(data) {
  syncUserFonts(data.fonts_v);
  setUltra(data.ultra);
  applyDesign(data.nowplaying, data.queue_cfg);
  followPlaying(data.now);
  followQueue(data.spotify_queue, data.now);
}

function connect() {
  if (EMBED) return;                 // the scene relays its own feed
  if (source) source.close();
  source = new EventSource('/api/events');
  source.onopen = () => el.stage.classList.remove('offline-on');
  source.onmessage = (e) => {
    try {
      takeSnapshot(JSON.parse(e.data));
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
  if (e.data && e.data.type === 'ultra') setUltra(e.data.on);
});
if (EMBED) onEmbedState(takeSnapshot);

/* Ultra optimized switched, or a frozen picture is ready: draw it again. */
onMotionChange(() => {
  const np = design, cfg = opts;
  design = null;
  opts = null;
  if (np) applyDesign(np, cfg);
});

/* ------------------------------------------------------------- boot */

if (STANDALONE) {
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
  if (PREVIEW) render({ ...DEMO, connected: true });
  else if (lastQueue) render(lastQueue);
  if (STANDALONE) reportWindowMetrics(API);
});

if (!EMBED) {
  fetch('/api/state').then((r) => r.json())
    .then((d) => applyDesign(d.nowplaying, d.queue_cfg)).catch(() => {});
}

connect();
if (PREVIEW) render({ ...DEMO, connected: true });

/* Which way round the play/pause icon goes. Rides connect()'s stream above
   rather than a second subscription: that payload already carries `now`. */
function followPlaying(now) {
  now = now || {};
  if (!!now.playing === lastPlaying) return;
  lastPlaying = !!now.playing;
  renderTransport(el.transport, (opts || {}).controls, lastPlaying,
                  (opts || {}).interactive !== false);
}

if (STANDALONE) wireTransport(el.transport, () => (opts || {}).interactive !== false);
