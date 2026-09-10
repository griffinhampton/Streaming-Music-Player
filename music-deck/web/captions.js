/* Captions window.

   Shows what is being said into the microphone. The server does the listening
   (Windows' own on-device recognizer, English) and broadcasts the last few
   finished lines plus the phrase still being spoken; this window only draws
   them, in the pop-out's colors and font unless given its own. */

const PREVIEW = new URLSearchParams(location.search).has('preview');
const API = '/api/captions/window';

const el = {
  stage: document.getElementById('stage'),
  viewport: document.getElementById('viewport'),
  lines: document.getElementById('lines'),
  partial: document.getElementById('partial'),
  status: document.getElementById('status'),
  bgImage: document.getElementById('bgImage'),
  bgDim: document.getElementById('bgDim'),
  cardBg: document.getElementById('cardBg'),
};

const DEMO = [
  'okay chat, let me know if you can hear me alright',
  'we are going to try that last part one more time',
  'thanks for the follow, welcome in',
  'I think this one is going to be my favorite so far',
];

let design = null;     // the pop-out's design (colors, font, background)
let opts = null;       // this window's own settings
let lastVersion = -1;
let shown = [];        // finished lines on screen, with the server time each landed

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
  // The window can carry its own colors (blank = inherit Now Playing). These
  // win regardless of follow_theme, which only governs the background.
  const own = opts.colors || {};
  const pal = design.palette || {};

  set('--accent', own.accent || accent);
  set('--font', `"${(opts.font || text.font || 'Segoe UI').replace(/"/g, '')}", "Segoe UI", system-ui, sans-serif`);
  set('--fg', own.text || text.title_color || pal.text || '#f4f4f8');
  set('--dim', own.muted || text.artist_color || pal.muted || '#9a9aa8');
  set('--card-radius', (card.radius ?? 18) + 'px');
  set('--card-fill', follow ? (card.fill || 'transparent') : 'transparent');
  set('--card-border', follow ? (card.border ?? 0) + 'px' : '0px');
  set('--card-border-color', card.border_color || pal.line || 'transparent');
  // Captions sit over video, so keep a shadow unless the design sets its own.
  const sh = Number(text.shadow || 0);
  set('--text-shadow', sh > 0
    ? `0 ${(0.05 * sh).toFixed(3)}em ${(0.22 * sh).toFixed(3)}em rgba(0,0,0,${Math.min(0.9, sh)})`
    : '0 .04em .18em rgba(0,0,0,.65)');

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
    const ownBg = opts.bg_own || { mode: 'solid', color: opts.bg || '#0f0f17' };
    if (surround) applyBackgroundInside(s, el.cardBg, ownBg);
    else applyBackground(s, el.bgImage, ownBg, set);
    el.bgDim.style.opacity = String(ownBg.dim ?? 0);
  }

  s.classList.toggle('align-left', opts.align === 'left');
  s.classList.toggle('preview', PREVIEW);
  sizeRoot();
  lastVersion = -1;          // repaint the words in the new style
}

function sizeRoot() {
  const w = window.innerWidth, h = window.innerHeight;
  // The finished lines plus the live one have to fit; size for all of them.
  const rows = Math.max(1, (opts && opts.lines) || 2) + 1;
  const byHeight = h / (rows * 1.6 + 0.9);
  const byWidth = w / 16;
  const scale = (opts && opts.scale) || 1;
  document.documentElement.style.fontSize =
    Math.max(9, Math.min(byHeight, byWidth) * scale) + 'px';
}

/* ------------------------------------------------------------- rendering */

function render(c, serverTime) {
  const s = el.stage;
  if (!c || !c.on) {
    s.dataset.state = 'off';
    el.status.textContent = 'Captions are off — press Start in the deck';
    return;
  }
  if (c.state === 'starting') {
    s.dataset.state = 'starting';
    el.status.textContent = 'Starting captions';
    return;
  }
  if (c.state === 'unavailable') {
    s.dataset.state = 'unavailable';
    el.status.textContent = c.error || 'Captions unavailable';
    return;
  }
  s.dataset.state = 'on';

  const keep = Math.max(1, (opts && opts.lines) || 2);
  const hold = Math.max(1, Number((opts && opts.hold) || 6));
  const now = serverTime || (Date.now() / 1000);

  if (c.version !== lastVersion) {
    lastVersion = c.version;
    shown = (c.lines || []).slice(-keep);
    el.lines.innerHTML = shown.map((l) => `<div class="line">${esc(l.text)}</div>`).join('');
    el.partial.textContent = c.partial || '';
  }
  // Age the finished lines on every tick: fade after `hold`, then drop them,
  // so the box empties between things said rather than pinning an old line.
  const rows = el.lines.children;
  for (let i = 0; i < rows.length; i++) {
    const age = now - (shown[i] ? shown[i].at : now);
    rows[i].classList.toggle('old', age > hold);
    rows[i].hidden = age > hold + 1.2;
  }
}

/* ------------------------------------------------------------- preview */

let demoI = 0;
function demoTick() {
  const lines = [];
  for (let k = 2; k >= 0; k--) {
    const idx = (demoI - k + DEMO.length * 2) % DEMO.length;
    lines.push({ text: DEMO[idx], at: Date.now() / 1000 - k * 1.5 });
  }
  render({ on: true, state: 'listening', version: demoI, lines,
           partial: demoI % 2 ? 'and then' : '' }, Date.now() / 1000);
  demoI++;
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
      syncUserFonts(data.fonts_v);
      applyDesign(data.nowplaying, data.captions_cfg);
      if (!PREVIEW) render(data.captions, data.server_time);
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
  if (e.data && e.data.type === 'design') applyDesign(e.data.nowplaying, e.data.captions_cfg);
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
  if (!PREVIEW) reportWindowMetrics(API);
});

fetch('/api/state').then((r) => r.json()).then((d) => {
  applyDesign(d.nowplaying, d.captions_cfg);
  if (!PREVIEW) render(d.captions, d.server_time);
}).catch(() => {});

connect();
if (PREVIEW) { demoTick(); setInterval(demoTick, 2200); }
