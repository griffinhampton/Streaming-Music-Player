/* Lyrics window.

   Gets the same live state as the pop-out (over server-sent events), keeps its
   own smooth clock, asks the server for lyrics whenever the track changes, and
   scrolls the current line into the middle. Synced lyrics follow the clock
   exactly; plain lyrics glide through in proportion to how far the song is. */

const PREVIEW = new URLSearchParams(location.search).has('preview');
const API = '/api/lyrics/window';

let lastPlaying = false;

const el = {
  stage: document.getElementById('stage'),
  header: document.getElementById('header'),
  viewport: document.getElementById('viewport'),
  lines: document.getElementById('lines'),
  status: document.getElementById('status'),
  transport: document.getElementById('transport'),
  bgImage: document.getElementById('bgImage'),
  bgDim: document.getElementById('bgDim'),
  cardBg: document.getElementById('cardBg'),
};

const DEMO_LINES = [
  { t: 0, text: 'Headlights on the wet road' },
  { t: 4, text: 'Radio turned way down low' },
  { t: 8, text: 'Every sign says keep on going' },
  { t: 12, text: 'Neon highway, take me home' },
  { t: 16, text: '' },
  { t: 18, text: 'Static on the waves tonight' },
  { t: 22, text: 'City fading out of sight' },
  { t: 26, text: 'Neon highway, take me home' },
];

let design = null;     // the pop-out's design (colours, font, background)
let opts = null;       // this window's own settings
let clock = { position: 0, duration: 0, playing: false, at: performance.now() };
let trackKey = '';
let lastNow = null;     // so the header can refresh when its setting changes
let lyrics = { status: 'idle', lines: [] };
let active = -1;
let pollTimer = null;

/* ------------------------------------------------------------- styling */

/* The song title above the words. Painted from the last-known track, so it
   also appears the instant you turn it on - not only when the song changes. */
function paintHeader() {
  el.header.textContent = (opts && opts.show_header && lastNow)
    ? [lastNow.title, lastNow.artist].filter(Boolean).join(' — ') : '';
}

function applyDesign(np, cfg) {
  const changed = JSON.stringify(np) !== JSON.stringify(design) ||
                  JSON.stringify(cfg) !== JSON.stringify(opts);
  if (!changed) return;
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
  set('--on-accent', readableOn(accent));
  set('--font', `"${(text.font || 'Segoe UI').replace(/"/g, '')}", "Segoe UI", system-ui, sans-serif`);
  const pal = design.palette || {};
  set('--fg', text.title_color || pal.text || '#f4f4f8');
  set('--dim', text.artist_color || pal.muted || '#9a9aa8');
  set('--hl', opts.highlight === 'text' ? (text.title_color || '#f4f4f8') : accent);
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
    // This window has a look of its own: a full background, not just a colour.
    const own = opts.bg_own || { mode: 'solid', color: opts.bg || '#0f0f17' };
    if (surround) applyBackgroundInside(s, el.cardBg, own);
    else applyBackground(s, el.bgImage, own, set);
    el.bgDim.style.opacity = String(own.dim ?? 0);
  }

  paintHeader();
  s.classList.toggle('align-left', opts.align === 'left');
  s.classList.toggle('interactive', !PREVIEW && opts.interactive !== false);
  // Same buttons as the pop-out, so a Next button works the same
  // wherever you decide to put one.
  renderTransport(el.transport, opts.controls, lastPlaying,
                  !PREVIEW && opts.interactive !== false);
  s.classList.toggle('keep-past', opts.dim_past === false);
  s.classList.toggle('preview', PREVIEW);
  sizeRoot();
  centreActive(true);
}

function sizeRoot() {
  const w = window.innerWidth, h = window.innerHeight;
  const visible = Math.max(3, (opts && opts.lines) || 5);
  // Each line costs line-height plus padding, the active one is scaled up, and
  // the card and header take their own bite - so size for all of that rather
  // than for the bare text, or the words get clipped.
  const perLine = 1.32 + 0.44;                       // line-height + padding
  const chrome = (opts && opts.show_header) ? 2.2 : 0.9;
  const byHeight = h / ((visible + 0.5) * perLine + chrome);
  const byWidth = w / 22;                            // room for the scaled line
  const scale = (opts && opts.scale) || 1;
  document.documentElement.style.fontSize =
    Math.max(8, Math.min(byHeight, byWidth) * scale) + 'px';
}

/* ------------------------------------------------------------- lyrics */

function setLyrics(data) {
  lyrics = data || { status: 'none', lines: [] };
  active = -1;
  const s = el.stage;
  s.classList.toggle('plain', lyrics.status === 'plain');

  let rows = [];
  if (lyrics.status === 'synced') rows = lyrics.lines;
  else if (lyrics.status === 'plain') {
    rows = (lyrics.plain || '').split('\n').map((t) => ({ t: 0, text: t }));
  }

  el.lines.innerHTML = rows.map((r) =>
    `<div class="line${r.text.trim() ? '' : ' empty'}">${esc(r.text) || '&nbsp;'}</div>`).join('');

  const state = { synced: 'synced', plain: 'plain', loading: 'loading',
                  instrumental: 'instrumental' }[lyrics.status] || 'none';
  s.dataset.state = state;
  el.status.textContent = {
    loading: 'Finding lyrics',
    none: lyrics.reason === 'nothing playing' ? 'Nothing playing' : 'No lyrics for this one',
    instrumental: '♪  instrumental  ♪',
  }[state] || '';

  // The first placement should not animate in from the top of the box.
  s.classList.add('no-anim');
  centreActive(true);
  requestAnimationFrame(() => requestAnimationFrame(() => s.classList.remove('no-anim')));
}

function fetchLyrics() {
  if (PREVIEW) {
    setLyrics({ status: 'synced', lines: DEMO_LINES });
    return;
  }
  fetch('/api/lyrics').then((r) => r.json()).then((data) => {
    setLyrics(data);
    clearTimeout(pollTimer);
    if (data.status === 'loading') pollTimer = setTimeout(fetchLyrics, 1500);
  }).catch(() => {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(fetchLyrics, 3000);
  });
}

/** Which line should be lit right now? */
function activeIndex(pos) {
  const n = el.lines.children.length;
  if (!n) return -1;
  if (lyrics.status === 'synced') {
    const offset = Number((opts && opts.offset) || 0);
    let idx = -1;
    for (let i = 0; i < lyrics.lines.length; i++) {
      if (lyrics.lines[i].t <= pos + offset) idx = i;
      else break;
    }
    return idx;
  }
  if (lyrics.status === 'plain' && clock.duration > 0) {
    return Math.min(n - 1, Math.floor((pos / clock.duration) * n));
  }
  return -1;
}

/* Click a line to jump the song to it. */
function wireLineSeek() {
  el.lines.addEventListener('pointerdown', (e) => {
    if (PREVIEW || (opts && opts.interactive === false)) return;
    const row = e.target.closest('.line');
    if (!row || lyrics.status !== 'synced') return;
    e.stopPropagation();
    const idx = [...el.lines.children].indexOf(row);
    const line = lyrics.lines[idx];
    if (!line) return;
    const to = Math.max(0, line.t - Number((opts && opts.offset) || 0));
    clock = { ...clock, position: to, at: performance.now() };
    active = idx;
    centreActive();
    fetch('/api/seek', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seconds: to }),
    }).catch(() => {});
  });
}

function centreActive(force) {
  const rows = el.lines.children;
  if (!rows.length) return;
  const idx = Math.max(0, active);
  const row = rows[idx];
  const target = row.offsetTop + row.offsetHeight / 2;
  const mid = el.viewport.clientHeight / 2;
  el.lines.style.transform = `translateY(${(mid - target).toFixed(1)}px)`;
  for (let i = 0; i < rows.length; i++) {
    rows[i].classList.toggle('active', i === active);
    rows[i].classList.toggle('past', i < active);
    rows[i].classList.toggle('future', i > active);
  }
  void force;
}

/* ------------------------------------------------------------- clock */

function tick() {
  let pos = clock.position;
  if (clock.playing) pos += (performance.now() - clock.at) / 1000;
  if (PREVIEW) pos = pos % 30;   // loop the demo
  const idx = activeIndex(pos);
  if (idx !== active) {
    active = idx;
    centreActive();
  }
  requestAnimationFrame(tick);
}

function onState(now) {
  if (!now && PREVIEW) {
    now = { source: 'demo', title: 'Neon Highway', artist: 'The Static Waves',
            playing: true, position: 0, duration: 30 };
  }
  if (!now) {
    if (trackKey !== '') {
      trackKey = '';
      setLyrics({ status: 'none', reason: 'nothing playing', lines: [] });
      lastNow = null;
      paintHeader();
    }
    clock = { position: 0, duration: 0, playing: false, at: performance.now() };
    return;
  }
  lastNow = now;
  const key = [now.source, now.title, now.artist].join('|');
  if (key !== trackKey) {
    trackKey = key;
    paintHeader();
    setLyrics({ status: 'loading', lines: [] });
    fetchLyrics();
  }
  const drift = Math.abs(clock.position - now.position);
  if (drift > 1.2 || clock.playing !== now.playing || clock.duration !== now.duration) {
    clock = { position: now.position || 0, duration: now.duration || 0,
              playing: !!now.playing, at: performance.now() };
  }
}

/* ------------------------------------------------------------- transport */

let source = null, retry = null;
function connect() {
  if (source) source.close();
  source = new EventSource('/api/events');
  source.onopen = () => el.stage.classList.remove('offline-on');
  source.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      applyDesign(data.nowplaying, data.lyrics_cfg);
      onState(data.now);
      followPlaying(data.now);
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
  if (e.data && e.data.type === 'design') applyDesign(e.data.nowplaying, e.data.lyrics_cfg);
});

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
  centreActive(true);
  if (!PREVIEW) reportWindowMetrics(API);
});

fetch('/api/state').then((r) => r.json()).then((d) => {
  applyDesign(d.nowplaying, d.lyrics_cfg);
  onState(d.now);
}).catch(() => {});

wireLineSeek();
connect();
requestAnimationFrame(tick);

/* Which way round the play/pause icon goes. Fed from connect()'s stream above
   rather than a second subscription: that payload already carries `now`. */
function followPlaying(now) {
  if (!!(now || {}).playing === lastPlaying) return;
  lastPlaying = !!(now || {}).playing;
  renderTransport(el.transport, (opts || {}).controls, lastPlaying,
                  (opts || {}).interactive !== false);
}

if (!PREVIEW) wireTransport(el.transport, () => (opts || {}).interactive !== false);
