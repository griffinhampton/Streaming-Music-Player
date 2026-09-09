/* Lyrics window.

   Gets the same live state as the pop-out (over server-sent events), keeps its
   own smooth clock, asks the server for lyrics whenever the track changes, and
   scrolls the current line into the middle. Synced lyrics follow the clock
   exactly; plain lyrics glide through in proportion to how far the song is. */

const PREVIEW = new URLSearchParams(location.search).has('preview');
const API = '/api/lyrics/window';

const el = {
  stage: document.getElementById('stage'),
  header: document.getElementById('header'),
  viewport: document.getElementById('viewport'),
  lines: document.getElementById('lines'),
  status: document.getElementById('status'),
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
let lyrics = { status: 'idle', lines: [] };
let active = -1;
let pollTimer = null;

/* ------------------------------------------------------------- styling */

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
  set('--font', `"${(text.font || 'Segoe UI').replace(/"/g, '')}", "Segoe UI", system-ui, sans-serif`);
  set('--fg', text.title_color || '#f4f4f8');
  set('--dim', text.artist_color || 'rgba(244,244,248,.42)');
  set('--hl', opts.highlight === 'text' ? (text.title_color || '#f4f4f8') : accent);
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

  s.classList.toggle('align-left', opts.align === 'left');
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
      el.header.textContent = '';
    }
    clock = { position: 0, duration: 0, playing: false, at: performance.now() };
    return;
  }
  const key = [now.source, now.title, now.artist].join('|');
  if (key !== trackKey) {
    trackKey = key;
    el.header.textContent = (opts && opts.show_header)
      ? [now.title, now.artist].filter(Boolean).join(' — ') : '';
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

connect();
requestAnimationFrame(tick);
