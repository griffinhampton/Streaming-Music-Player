/* Screen frame and Camera frame.

   A decorative border around a hole the game or the camera shows through.
   The hole is either see-through (for a scene, or a capture that keeps
   transparency) or painted the key color (for chroma key in TikTok LIVE
   Studio or OBS). Around it: a border in one of a few styles, decor.js's
   loop of characters or motifs, four corner badges and a title plate.
   One page serves both, told apart by ?kind=screen|camera; each keeps its
   own settings (config "screenframe" / "camframe", the snapshot's "frames"). */

const Q = new URLSearchParams(location.search);
const KIND = Q.get('kind') === 'camera' ? 'camera' : 'screen';
const SECTION = KIND === 'camera' ? 'camframe' : 'screenframe';
const PREVIEW = Q.has('preview');
// Inside a scene (embed.js): the scene feeds us and owns the window.
const EMBED = !!window.EMBED;
const STANDALONE = !PREVIEW && !EMBED;
const API = '/api/components/' + SECTION;

const el = {
  stage: document.getElementById('stage'),
  decor: document.getElementById('decor'),
  ring: document.getElementById('ring'),
  title: document.getElementById('title'),
  badges: {
    tl: document.getElementById('badgeTl'), tr: document.getElementById('badgeTr'),
    bl: document.getElementById('badgeBl'), br: document.getElementById('badgeBr'),
  },
};
if (PREVIEW) el.stage.classList.add('preview');

const STYLES = ['solid', 'double', 'dashed', 'glow', 'none'];
const SHAPES = ['rect', 'rounded', 'circle'];
let cfg = {};
let accent = '#8b5cf6';
let font = '';
let lastSig = '';

const num = (v, d, lo, hi) => {
  const n = +v;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

/** Draw the frame from its settings; np lends the accent color and font. */
function apply(c, np) {
  if (c) cfg = c;
  if (np) {
    accent = np.accent || (np.palette && np.palette.accent) || accent;
    font = np.font || font;
  }
  const sig = JSON.stringify([cfg, accent, font, window.isUltra && isUltra()]);
  if (sig === lastSig) return;          // the heartbeat repeats the state: nothing to redraw
  lastSig = sig;

  const b = cfg.border || {}, t = cfg.title || {}, bd = cfg.badges || {}, lp = cfg.loop || {};
  const color = b.color || accent;
  const root = el.stage.style;
  const shape = SHAPES.includes(cfg.shape) ? cfg.shape : 'rounded';
  el.stage.dataset.shape = shape;
  el.stage.dataset.style = STYLES.includes(b.style) ? b.style : 'solid';
  el.stage.dataset.hole = cfg.hole === 'key' ? 'key' : 'clear';
  root.setProperty('--frame-color', color);
  root.setProperty('--frame-width', num(b.width, 8, 0, 60) + 'px');
  root.setProperty('--frame-radius', shape === 'circle' ? '50%' : shape === 'rect' ? '0px' : num(cfg.radius, 18, 0, 400) + 'px');
  root.setProperty('--hole', cfg.hole === 'key' ? (cfg.key_color || '#00ff00') : 'transparent');
  root.setProperty('--frame-font', font ? `"${font}", "Segoe UI", system-ui, sans-serif` : '"Segoe UI", system-ui, sans-serif');

  const text = String(t.text || '').trim();
  el.title.textContent = text;
  el.title.hidden = !text;
  el.stage.dataset.titlePlace = t.place === 'bottom' ? 'bottom' : 'top';
  root.setProperty('--title-scale', num(t.size, 1, 0.4, 3));
  root.setProperty('--title-color', t.color || '#ffffff');

  let anyBadge = false;
  for (const k of ['tl', 'tr', 'bl', 'br']) {
    const v = String(bd[k] || '').trim();
    el.badges[k].textContent = v;
    el.badges[k].hidden = !v;
    anyBadge = anyBadge || !!v;
  }
  root.setProperty('--badge-scale', num(bd.size, 1, 0.4, 3));
  root.setProperty('--badge-color', bd.color || color);

  // The loop: decor.js's characters or motif ring, all round the edge.
  const loopOn = !!(lp.border || String(lp.custom || '').trim());
  if (window.renderDecor) {
    renderDecor(el.stage, el.decor, {
      border: lp.border || '', custom: lp.custom || '', sides: loopOn ? 'all' : 'none',
      size: num(lp.size, 0.9, 0.3, 3), opacity: 0.95, color: lp.color || '', gap: 0.6,
      animate: lp.animate !== false,
    }, color);
  }
  // The ring sits inside the loop's band, and leaves room for a title or
  // badge half over its edge.
  const band = loopOn && el.stage.classList.contains('has-decor')
    ? getComputedStyle(el.stage).getPropertyValue('--decor-px').trim() || '1.5em' : '0px';
  const pad = text || anyBadge ? '0.9em' : '0px';
  root.setProperty('--ring-inset', `calc(${band} + ${pad})`);
}

/* ------------------------------------------------------------- transport */

let source = null, retry = null;
function takeSnapshot(data) {
  syncUserFonts(data.fonts_v);
  setUltra(data.ultra || idleHere(data));
  apply((data.frames || {})[SECTION], data.nowplaying);
}

function connect() {
  if (EMBED) return;                 // the scene relays its own feed
  if (source) source.close();
  source = new EventSource('/api/events?page=frame.html');
  source.onmessage = (event) => {
    try { takeSnapshot(JSON.parse(event.data)); } catch (_) { /* wait for the next one */ }
  };
  source.onerror = () => {
    source.close();
    clearTimeout(retry);
    retry = setTimeout(connect, 1500);
  };
}

// The deck pushes a setting the moment it changes, so the preview never lags.
window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'frame' && (!e.data.section || e.data.section === SECTION)) {
    apply(e.data.cfg, e.data.nowplaying);
  }
  if (e.data && e.data.type === 'ultra') setUltra(e.data.on);
});
if (EMBED) onEmbedState(takeSnapshot);

/* Ultra optimized switched: the loop stops or starts, so draw again. */
onMotionChange(() => { lastSig = ''; apply(); });

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
  if (STANDALONE) reportWindowMetrics(API);
});

if (!EMBED) {
  fetch('/api/state').then((r) => r.json()).then((d) => takeSnapshot(d)).catch(() => {});
}
connect();
