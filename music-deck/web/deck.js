/* Music Deck - control room.

   Design controls are declarative: any element carrying data-np="a.b.c" or
   data-ui="x" is wired up automatically from its data-kind, so adding a new
   setting is a line of HTML plus a default on the server. */

const $ = (id) => document.getElementById(id);
const audio = $('audio');

let CONFIG = null;
let TRACKS = [];        // whole library
let VIEW = [];          // filtered view, doubles as the play queue
let current = -1;
let shuffle = false;
let repeat = 'off';     // off | all | one
let seeking = false;
let selSticker = -1;
const aspect = {};      // assetId -> width/height, for drawing selection boxes

const fmt = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer;
function toast(msg) {
  const node = $('toast');
  node.textContent = msg;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
}

const post = (url, body) =>
  fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then((r) => r.json()).catch(() => ({ ok: false }));

/* ------------------------------------------------------------- config paths */

const getPath = (obj, path) =>
  path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

function setPath(obj, path, val) {
  const keys = path.split('.');
  const last = keys.pop();
  let node = obj;
  for (const k of keys) {
    if (typeof node[k] !== 'object' || node[k] === null) node[k] = {};
    node = node[k];
  }
  node[last] = val;
}

/** Build the smallest nested object that carries this one value. */
function patchFor(path, val) {
  const keys = path.split('.');
  const out = {};
  let node = out;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) node[k] = val;
    else { node[k] = {}; node = node[k]; }
  });
  return out;
}

let npTimer = null, npPending = {};
function saveNp(patch) {
  Object.entries(patch).forEach(([k, v]) => setPath(CONFIG.nowplaying, k, v));
  // Push straight into the preview so it never lags behind the sliders.
  pushPreview();
  if (Object.keys(patch).some((k) => k === 'accent' || k.startsWith('palette.'))) {
    mirrorPaletteToUi();
  }
  deepAssign(npPending, patch);
  clearTimeout(npTimer);
  npTimer = setTimeout(() => {
    const body = {};
    for (const [path, val] of Object.entries(npPending)) {
      deepMerge(body, patchFor(path, val));
    }
    npPending = {};
    post('/api/config', { nowplaying: body });
  }, 180);
}

/* Colours a theme owns but that live on individual controls. Clearing them
   hands those elements back to the palette. */
const LOCAL_COLOUR_KEYS = [
  'text.title_color', 'text.artist_color', 'text.label_color',
  'card.border_color', 'card.fill', 'art.border_color',
  'progress.color', 'decor.color',
];

let uiTimer = null, uiPending = {};
function saveUi(patch) {
  Object.entries(patch).forEach(([k, v]) => setPath(CONFIG.ui, k, v));
  applyUi(CONFIG.ui);
  Object.assign(uiPending, patch);
  clearTimeout(uiTimer);
  uiTimer = setTimeout(() => {
    const body = {};
    for (const [path, val] of Object.entries(uiPending)) deepMerge(body, patchFor(path, val));
    uiPending = {};
    post('/api/config', { ui: body });
  }, 180);
}

let lyTimer = null, lyPending = {};
function saveLy(patch) {
  CONFIG.lyrics = CONFIG.lyrics || {};
  CONFIG.queue = CONFIG.queue || {};
  Object.entries(patch).forEach(([k, v]) => setPath(CONFIG.lyrics, k, v));
  Object.assign(lyPending, patch);
  clearTimeout(lyTimer);
  lyTimer = setTimeout(() => {
    const body = {};
    for (const [path, val] of Object.entries(lyPending)) deepMerge(body, patchFor(path, val));
    lyPending = {};
    post('/api/config', { lyrics: body });
  }, 180);
}

let qTimer = null, qPending = {};
function saveQ(patch) {
  CONFIG.queue = CONFIG.queue || {};
  Object.entries(patch).forEach(([k, v]) => setPath(CONFIG.queue, k, v));
  Object.assign(qPending, patch);
  clearTimeout(qTimer);
  qTimer = setTimeout(() => {
    const body = {};
    for (const [path, val] of Object.entries(qPending)) deepMerge(body, patchFor(path, val));
    qPending = {};
    post('/api/config', { queue: body });
  }, 180);
}

/* When the app is set to follow the pop-out, mirror its palette onto the deck
   so the two do not drift apart. */
function mirrorPaletteToUi() {
  if (!CONFIG || !CONFIG.ui || CONFIG.ui.follow_np === false) return;
  const np = CONFIG.nowplaying, pal = np.palette || {};
  const next = {
    accent: np.accent || CONFIG.ui.accent,
    text: pal.text || CONFIG.ui.text,
    muted: pal.muted || CONFIG.ui.muted,
    border: pal.line || CONFIG.ui.border,
  };
  const changed = Object.entries(next).some(([k, v]) => CONFIG.ui[k] !== v);
  if (changed) saveUi(next);
}

function deepAssign(target, patch) { Object.assign(target, patch); }
function deepMerge(target, src) {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      target[k] = deepMerge(target[k] || {}, v);
    } else target[k] = v;
  }
  return target;
}

/* ------------------------------------------------------------- app theme */

/* Black or white, whichever stays readable on this colour. A white accent on a
   white-filled button is invisible otherwise. */
function readableOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return L > 0.45 ? '#0a0a0c' : '#ffffff';
}

function applyUi(ui) {
  const r = document.documentElement.style;
  r.setProperty('--accent', ui.accent);
  r.setProperty('--on-accent', readableOn(ui.accent));
  r.setProperty('--bg', ui.bg);
  r.setProperty('--panel', ui.panel);
  r.setProperty('--line', ui.border);
  r.setProperty('--fg', ui.text);
  r.setProperty('--dim', ui.muted);
  r.setProperty('--radius', (ui.radius ?? 12) + 'px');
  r.setProperty('--font', `"${(ui.font || 'Segoe UI').replace(/"/g, '')}", "Segoe UI", system-ui, sans-serif`);
  r.setProperty('--d', ui.density === 'compact' ? 0.82 : ui.density === 'roomy' ? 1.2 : 1);
  r.setProperty('--glow', ui.glow ? `0 0 14px color-mix(in srgb, ${ui.accent} 55%, transparent)` : 'none');

  renderAppDecor();

  const scene = ui.scene || {};
  if (scene.id && typeof SCENES !== 'undefined' && SCENES[scene.id]) {
    const art = renderScene(scene.id, sceneParams(scene));
    r.setProperty('--wallpaper', art.image);
    r.setProperty('--wallpaper-size', art.size);
    r.setProperty('--wallpaper-repeat', art.repeat);
    r.setProperty('--wallpaper-base', art.base);
    r.setProperty('--wallpaper-on', '1');
    r.setProperty('--wallpaper-dim', String(ui.wallpaper_dim ?? 0.65));
  } else if (ui.wallpaper) {
    r.setProperty('--wallpaper', `url("/asset/${encodeURIComponent(ui.wallpaper)}")`);
    r.setProperty('--wallpaper-size', 'cover');
    r.setProperty('--wallpaper-repeat', 'no-repeat');
    r.setProperty('--wallpaper-base', 'transparent');
    r.setProperty('--wallpaper-on', '1');
    r.setProperty('--wallpaper-dim', String(ui.wallpaper_dim ?? 0.65));
  } else {
    r.setProperty('--wallpaper-on', '0');
    r.setProperty('--wallpaper-dim', '0');
  }
}

/* ------------------------------------------------------------- scene pickers */

function renderScenePickers() {
  if (!CONFIG) return;
  const build = (container, current) => {
    container.innerHTML = Object.entries(SCENES).map(([id, sc]) => `
      <div class="scene-thumb ${current === id ? 'on' : ''}" data-id="${id}" title="${esc(sc.label)}">
        <div class="scene-thumb-img"></div><span>${esc(sc.label)}</span>
      </div>`).join('');
    container.querySelectorAll('.scene-thumb').forEach((node) => {
      const id = node.dataset.id;
      const img = node.querySelector('.scene-thumb-img');
      paintScene(img, id, {});
      if (!SCENES[id].cover) img.style.backgroundSize = '150px 150px';
    });
  };
  build($('scenePicker'), (CONFIG.nowplaying.bg.scene || {}).id);
  build($('wallScenePicker'), (CONFIG.ui.scene || {}).id);
  syncSceneColors();
}

/* Blank scene colours mean "use the scene's own", so show those in the pickers. */
function syncSceneColors() {
  const fill = (attr, prefix, cfg) => {
    const def = (SCENES[(cfg || {}).id] || SCENES.watercolor).defaults;
    for (const k of ['c1', 'c2', 'c3']) {
      const node = document.querySelector(`[data-${attr}="${prefix}.${k}"]`);
      if (node) node.value = (cfg && cfg[k]) || def[k];
    }
  };
  fill('np', 'bg.scene', CONFIG.nowplaying.bg.scene);
  fill('ui', 'scene', CONFIG.ui.scene);
}

$('scenePicker').addEventListener('click', (e) => {
  const t = e.target.closest('.scene-thumb');
  if (!t) return;
  saveNp({ 'bg.mode': 'scene', 'bg.scene.id': t.dataset.id });
  syncControls();
  renderScenePickers();
});
$('wallScenePicker').addEventListener('click', (e) => {
  const t = e.target.closest('.scene-thumb');
  if (!t) return;
  saveUi({ 'scene.id': t.dataset.id });
  renderScenePickers();
});
$('sceneReset').addEventListener('click', () => {
  saveNp({ 'bg.scene.c1': '', 'bg.scene.c2': '', 'bg.scene.c3': '' });
  syncSceneColors();
});
$('wallSceneReset').addEventListener('click', () => {
  saveUi({ 'scene.c1': '', 'scene.c2': '', 'scene.c3': '' });
  syncSceneColors();
});
$('sceneShuffle').addEventListener('click', () => {
  saveNp({ 'bg.scene.seed': Math.floor(Math.random() * 9999) + 1 });
  // The live windows redraw from the same config, but a reshuffle changes the
  // whole picture, so nudge them rather than waiting for the next tick.
  setTimeout(() => { pushPreview(); healWindows(); }, 250);
});
$('wallSceneShuffle').addEventListener('click', () =>
  saveUi({ 'scene.seed': Math.floor(Math.random() * 9999) + 1 }));

const UI_PRESETS = {
  black:    { bg: '#000000', panel: '#0a0a0c', border: '#1b1b22', text: '#f0f0f4', muted: '#7e7e8c', glow: false, radius: 12 },
  charcoal: { bg: '#121216', panel: '#1a1a20', border: '#2a2a33', text: '#eceef4', muted: '#8b8b99', glow: false, radius: 14 },
  midnight: { bg: '#05070f', panel: '#0c1020', border: '#1c2440', text: '#e8ecff', muted: '#7c86a8', glow: true, radius: 16 },
  mono:     { bg: '#000000', panel: '#000000', border: '#2e2e2e', text: '#ffffff', muted: '#8a8a8a', accent: '#ffffff', glow: false, radius: 2 },
  light:    { bg: '#f4f5f8', panel: '#ffffff', border: '#e0e2e8', text: '#15161c', muted: '#6b6e7b', glow: false, radius: 12 },
};

const NP_PRESETS = {
  midnight: { 'bg.mode': 'solid', 'bg.color': '#0f0f17', 'card.fill': '', 'card.border': 1,
              'card.border_color': '#2a2a3a', 'card.glow': true, 'card.radius': 18,
              'text.title_color': '#f4f4f8', 'text.artist_color': '#9a9aa8',
              'text.shadow': 0, 'progress.glow': true },
  ink:      { 'bg.mode': 'solid', 'bg.color': '#000000', 'card.fill': '', 'card.border': 0,
              'card.glow': false, 'card.radius': 0, 'text.title_color': '#ffffff',
              'text.artist_color': '#9a9a9a', 'text.shadow': 0, 'progress.glow': false },
  neon:     { 'bg.mode': 'solid', 'bg.color': '#05050a', 'card.fill': '', 'card.border': 2,
              'card.border_color': '#8b5cf6', 'card.glow': true, 'card.radius': 16,
              'text.title_color': '#ffffff', 'text.artist_color': '#c4b5fd',
              'text.shadow': 0.3, 'progress.glow': true },
  light:    { 'bg.mode': 'solid', 'bg.color': '#f2f3f7', 'card.fill': '', 'card.border': 1,
              'card.border_color': '#dcdee6', 'card.glow': false, 'card.radius': 18,
              'text.title_color': '#14141b', 'text.artist_color': '#5c5f6b',
              'text.shadow': 0, 'progress.glow': false },
  sunset:   { 'bg.mode': 'gradient', 'bg.color': '#2b1055', 'bg.color2': '#c4407a', 'bg.angle': 135,
              'card.fill': '', 'card.border': 0, 'card.glow': false, 'card.radius': 20,
              'text.title_color': '#ffffff', 'text.artist_color': '#f3d9e8',
              'text.shadow': 0.4, 'progress.glow': true },
  chroma:   { 'bg.mode': 'solid', 'bg.color': '#00b140', 'card.fill': '', 'card.border': 0,
              'card.glow': false, 'card.radius': 0, 'text.title_color': '#ffffff',
              'text.artist_color': '#eaffea', 'text.shadow': 0.6, 'progress.glow': false },
  magenta:  { 'bg.mode': 'solid', 'bg.color': '#ff00ff', 'card.fill': '', 'card.border': 0,
              'card.glow': false, 'card.radius': 0, 'text.title_color': '#ffffff',
              'text.artist_color': '#ffe6ff', 'text.shadow': 0.6, 'progress.glow': false },
};


/* ------------------------------------------------------------- full themes */
/* Each theme dresses both the app and the pop-out, decoration included.
   np entries use dotted paths so they can go straight into saveNp. */

const THEMES = {
  midnight: {
    ui: { accent: '#8b5cf6', bg: '#000000', panel: '#0a0a0c', border: '#1b1b22',
          text: '#f0f0f4', muted: '#7e7e8c', radius: 12, font: 'Segoe UI',
          glow: false, 'decor.sides': 'none', 'decor.kaomoji': '' },
    np: { accent: '#8b5cf6',
          'palette.text': '#f4f4f8', 'palette.muted': '#9a9aa8', 'palette.line': '#2a2a3a',
          'bg.mode': 'solid', 'bg.color': '#0f0f17',
          'surround.mode': 'solid', 'surround.color': '#000000',
          'card.fill': '', 'card.border': 1, 'card.border_color': '',
          'card.glow': true, 'card.radius': 18, 'card.padding': 12,
          'text.font': 'Segoe UI', 'text.title_color': '',
          'text.artist_color': '', 'text.label_color': '',
          'text.shadow': 0, 'progress.glow': true, 'progress.color': '',
          'progress.height': 5, 'art.radius': 10, 'art.border': 0,
          'decor.sides': 'none', 'decor.kaomoji': '' },
  },
  minimal: {
    ui: { accent: '#ffffff', bg: '#000000', panel: '#000000', border: '#2b2b2b',
          text: '#ffffff', muted: '#8a8a8a', radius: 2, font: 'Segoe UI',
          glow: false, 'decor.sides': 'none', 'decor.kaomoji': '' },
    np: { accent: '#ffffff',
          'palette.text': '#ffffff', 'palette.muted': '#9a9a9a',
          'bg.mode': 'solid', 'bg.color': '#000000',
          'surround.mode': 'solid', 'surround.color': '#000000',
          'card.fill': '', 'card.border': 0, 'card.glow': false, 'card.radius': 0,
          'card.padding': 14, 'text.font': 'Segoe UI',
          'text.title_color': '', 'text.artist_color': '',
          'text.label_color': '#8a8a8a', 'text.shadow': 0,
          'progress.glow': false, 'progress.color': '#ffffff',
          'progress.height': 2, 'art.radius': 0, 'art.border': 0,
          'decor.sides': 'none', 'decor.kaomoji': '' },
  },
  dark: {
    ui: { accent: '#60a5fa', bg: '#111114', panel: '#191920', border: '#2a2a33',
          text: '#eceef4', muted: '#8b8b99', radius: 14, font: 'Segoe UI',
          glow: false, 'decor.sides': 'none', 'decor.kaomoji': '' },
    np: { accent: '#60a5fa',
          'palette.text': '#eceef4', 'palette.muted': '#98a0b0', 'palette.line': '#2f2f3a',
          'bg.mode': 'solid', 'bg.color': '#16161c',
          'surround.mode': 'solid', 'surround.color': '#000000',
          'card.fill': '', 'card.border': 1, 'card.border_color': '',
          'card.glow': false, 'card.radius': 14, 'card.padding': 12,
          'text.font': 'Segoe UI', 'text.title_color': '',
          'text.artist_color': '', 'text.label_color': '',
          'text.shadow': 0, 'progress.glow': false, 'progress.color': '',
          'progress.height': 5, 'art.radius': 10, 'art.border': 0,
          'decor.sides': 'none', 'decor.kaomoji': '' },
  },
  light: {
    ui: { accent: '#6d5cf6', bg: '#f4f5f8', panel: '#ffffff', border: '#e1e3ea',
          text: '#15161c', muted: '#6b6e7b', radius: 12, font: 'Segoe UI',
          glow: false, 'decor.sides': 'none', 'decor.kaomoji': '' },
    np: { accent: '#6d5cf6',
          'palette.text': '#14141b', 'palette.muted': '#5c5f6b', 'palette.line': '#dcdee6',
          'bg.mode': 'solid', 'bg.color': '#f2f3f7',
          'surround.mode': 'solid', 'surround.color': '#f2f3f7',
          'card.fill': '', 'card.border': 1, 'card.border_color': '',
          'card.glow': false, 'card.radius': 18, 'card.padding': 12,
          'text.font': 'Segoe UI', 'text.title_color': '',
          'text.artist_color': '', 'text.label_color': '',
          'text.shadow': 0, 'progress.glow': false, 'progress.color': '',
          'progress.height': 5, 'art.radius': 10, 'art.border': 0,
          'decor.sides': 'none', 'decor.kaomoji': '' },
  },
  bloom: {
    ui: { accent: '#ff8fd0', bg: '#1a0f18', panel: '#241522', border: '#3d2436',
          text: '#ffe9f5', muted: '#c08fae', radius: 18, font: 'Segoe UI',
          glow: true, 'decor.border': 'motif:hand', 'decor.sides': 'all',
          'decor.opacity': 0.45, 'decor.size': 0.75, 'decor.gap': 0.7,
          'decor.kaomoji': KAOMOJI[2] },
    np: { accent: '#ff8fd0',
          'palette.text': '#fff0f8', 'palette.muted': '#f0b8d8', 'palette.line': '#ff8fd0',
          'bg.mode': 'gradient', 'bg.color': '#2a1526',
          'surround.mode': 'solid', 'surround.color': '#000000',
          'bg.color2': '#4a1f3d', 'bg.angle': 135,
          'card.fill': '', 'card.border': 2, 'card.border_color': '',
          'card.glow': true, 'card.radius': 22, 'card.padding': 16,
          'text.font': 'Segoe UI', 'text.title_color': '',
          'text.artist_color': '', 'text.label_color': '#ffb3e0',
          'text.shadow': 0.35, 'progress.glow': true, 'progress.color': '#ff8fd0',
          'progress.height': 6, 'art.radius': 16, 'art.border': 2,
          'art.border_color': '#ff8fd0',
          'decor.border': 'motif:hand', 'decor.sides': 'all', 'decor.size': 1.4,
          'decor.opacity': 0.85, 'decor.layer': 'under', 'decor.blur': 0, 'decor.inset': 0.6,
          'decor.tint': true, 'decor.color': '', 'decor.place': 'in', 'decor.gap': 0.5, 'decor.color': '',
          'decor.kaomoji': KAOMOJI[3], 'decor.animate': false },
  },
  sakura: {
    ui: { accent: '#f7a8c4', bg: '#0d0a12', panel: '#161020', border: '#2c2038',
          text: '#f6e9f2', muted: '#a58aa8', radius: 16, font: 'Segoe UI',
          glow: true, 'decor.border': 'motif:handd', 'decor.sides': 'tb',
          'decor.opacity': 0.4, 'decor.kaomoji': '' },
    np: { accent: '#f7a8c4',
          'palette.text': '#fdf0f6', 'palette.muted': '#c9a8bd', 'palette.line': '#3a2a44',
          'bg.mode': 'solid', 'bg.color': '#120c18',
          'surround.mode': 'solid', 'surround.color': '#000000',
          'card.fill': '', 'card.border': 1, 'card.border_color': '',
          'card.glow': true, 'card.radius': 20, 'card.padding': 14,
          'text.font': 'Segoe UI', 'text.title_color': '',
          'text.artist_color': '', 'text.label_color': '#f7a8c4',
          'text.shadow': 0.25, 'progress.glow': true, 'progress.color': '#f7a8c4',
          'progress.height': 5, 'art.radius': 14, 'art.border': 0,
          'decor.border': 'motif:handd', 'decor.sides': 'tb', 'decor.size': 1.3,
          'decor.opacity': 0.8, 'decor.layer': 'under', 'decor.blur': 0, 'decor.inset': 0.6,
          'decor.tint': true, 'decor.color': '', 'decor.place': 'in', 'decor.gap': 0.5, 'decor.kaomoji': '' },
  },
  arcade: {
    ui: { accent: '#22d3ee', bg: '#04040a', panel: '#0a0a16', border: '#1d2b48',
          text: '#e6faff', muted: '#6f8fa8', radius: 6, font: 'Consolas',
          glow: true, 'decor.border': 'sparkle', 'decor.sides': 'tb',
          'decor.opacity': 0.45, 'decor.kaomoji': '' },
    np: { accent: '#22d3ee',
          'palette.text': '#ffffff', 'palette.muted': '#7fe8f8', 'palette.line': '#22d3ee',
          'bg.mode': 'solid', 'bg.color': '#04040a',
          'surround.mode': 'solid', 'surround.color': '#000000',
          'card.fill': '', 'card.border': 2, 'card.border_color': '',
          'card.glow': true, 'card.radius': 6, 'card.padding': 12,
          'text.font': 'Consolas', 'text.title_color': '',
          'text.artist_color': '', 'text.label_color': '#ff4fd8',
          'text.shadow': 0.3, 'progress.glow': true, 'progress.color': '#ff4fd8',
          'progress.height': 4, 'art.radius': 4, 'art.border': 1,
          'art.border_color': '#22d3ee',
          'decor.border': 'sparkle', 'decor.sides': 'tb', 'decor.size': 0.55,
          'decor.opacity': 0.85, 'decor.gap': 0.5, 'decor.kaomoji': '' },
  },
  vapor: {
    ui: { accent: '#ff77e1', bg: '#120a2a', panel: '#1b1040', border: '#33206b',
          text: '#f2e9ff', muted: '#9d8ac4', radius: 16, font: 'Trebuchet MS',
          glow: true, 'decor.border': 'stars', 'decor.sides': 'tb',
          'decor.opacity': 0.45, 'decor.kaomoji': '' },
    np: { accent: '#ff77e1',
          'palette.text': '#ffffff', 'palette.muted': '#ffd9f2',
          'bg.mode': 'gradient', 'bg.color': '#2b1055',
          'surround.mode': 'solid', 'surround.color': '#000000',
          'bg.color2': '#ff6bb5', 'bg.angle': 160,
          'card.fill': '', 'card.border': 0, 'card.glow': false, 'card.radius': 20,
          'card.padding': 14, 'text.font': 'Trebuchet MS',
          'text.title_color': '', 'text.artist_color': '',
          'text.label_color': '#7df9ff', 'text.shadow': 0.5,
          'progress.glow': true, 'progress.color': '#7df9ff', 'progress.height': 5,
          'art.radius': 16, 'art.border': 0,
          'decor.border': 'stars', 'decor.sides': 'tb', 'decor.size': 0.55,
          'decor.opacity': 0.9, 'decor.gap': 0.5, 'decor.kaomoji': '' },
  },
  terminal: {
    ui: { accent: '#37d67a', bg: '#000000', panel: '#050a06', border: '#123d20',
          text: '#c8ffd8', muted: '#4f8f66', radius: 2, font: 'Consolas',
          glow: false, 'decor.border': 'dashes', 'decor.sides': 'tb',
          'decor.opacity': 0.35, 'decor.kaomoji': '' },
    np: { accent: '#37d67a',
          'palette.text': '#c8ffd8', 'palette.muted': '#5aa06f', 'palette.line': '#1c5c33',
          'bg.mode': 'solid', 'bg.color': '#000000',
          'surround.mode': 'solid', 'surround.color': '#000000',
          'card.fill': '', 'card.border': 1, 'card.border_color': '',
          'card.glow': false, 'card.radius': 0, 'card.padding': 12,
          'text.font': 'Consolas', 'text.title_color': '',
          'text.artist_color': '', 'text.label_color': '#37d67a',
          'text.shadow': 0, 'progress.glow': false, 'progress.color': '#37d67a',
          'progress.height': 3, 'art.radius': 0, 'art.border': 1,
          'art.border_color': '#1c5c33',
          'decor.border': 'dashes', 'decor.sides': 'tb', 'decor.size': 0.5,
          'decor.opacity': 0.6, 'decor.gap': 0.5, 'decor.kaomoji': '' },
  },
  ember: {
    ui: { accent: '#ff2a3a', bg: '#0a0304', panel: '#150607', border: '#3b0f13',
          text: '#ffe9e9', muted: '#a86b70', radius: 10, font: 'Segoe UI',
          glow: true, 'decor.sides': 'none', 'decor.kaomoji': '',
          'scene.id': 'embers', 'scene.c1': '', 'scene.c2': '', 'scene.c3': '',
          wallpaper: '', wallpaper_dim: 0.35 },
    np: { accent: '#ff2a3a',
          'palette.text': '#fff1f1', 'palette.muted': '#e0a3a8',
          'bg.mode': 'scene', 'bg.scene.id': 'embers',
          'surround.mode': 'solid', 'surround.color': '#000000',
          'bg.scene.c1': '', 'bg.scene.c2': '', 'bg.scene.c3': '',
          'bg.scene.scale': 1, 'bg.scene.density': 1, 'bg.dim': 0, 'bg.blur': 0,
          'card.fill': '', 'card.fill_alpha': 1, 'card.border': 0,
          'card.glow': false, 'card.radius': 12, 'card.padding': 12,
          'text.font': 'Segoe UI', 'text.title_color': '',
          'text.artist_color': '', 'text.label_color': '#ff2a3a',
          'text.shadow': 0.5, 'progress.glow': true, 'progress.color': '#ff2a3a',
          'progress.height': 4, 'art.radius': 10, 'art.border': 0,
          'decor.sides': 'none', 'decor.kaomoji': '' },
  },
  blossom: {
    ui: { accent: '#e28aa0', bg: '#f6dfe1', panel: '#fff4f5', border: '#efcbd2',
          text: '#4d2433', muted: '#9a6e7a', radius: 18, font: 'Segoe UI',
          glow: false, 'decor.sides': 'none', 'decor.kaomoji': '',
          'scene.id': 'watercolor', 'scene.c1': '', 'scene.c2': '', 'scene.c3': '',
          wallpaper: '', wallpaper_dim: 0 },
    np: { accent: '#e28aa0',
          'palette.text': '#4d2433', 'palette.muted': '#9a6e7a',
          'bg.mode': 'scene', 'bg.scene.id': 'watercolor', 'bg.scene.tile_scale': 0.6,
          'surround.mode': 'solid', 'surround.color': '#f6d9dc',
          'bg.scene.c1': '', 'bg.scene.c2': '', 'bg.scene.c3': '',
          'bg.scene.scale': 1, 'bg.scene.density': 1, 'bg.dim': 0, 'bg.blur': 0,
          'card.fill': '#ffffff', 'card.fill_alpha': 0.55, 'card.border': 0,
          'card.glow': false, 'card.radius': 22, 'card.padding': 14,
          'text.font': 'Segoe UI', 'text.title_color': '',
          'text.artist_color': '', 'text.label_color': '#e28aa0',
          'text.shadow': 0, 'progress.glow': false, 'progress.color': '#e28aa0',
          'progress.height': 5, 'art.radius': 14, 'art.border': 0,
          'decor.sides': 'none', 'decor.kaomoji': KAOMOJI[3] },
  },
  hanami: {
    ui: { accent: '#e88fb0', bg: '#fbeff1', panel: '#fffafb', border: '#f3d3dc',
          text: '#5a2f42', muted: '#a3788a', radius: 16, font: 'Segoe UI',
          glow: false, 'decor.sides': 'none', 'decor.kaomoji': '',
          'scene.id': 'sakura', 'scene.c1': '', 'scene.c2': '', 'scene.c3': '',
          wallpaper: '', wallpaper_dim: 0 },
    np: { accent: '#e88fb0',
          'palette.text': '#5a2f42', 'palette.muted': '#a3788a', 'palette.line': '#f3d3dc',
          'bg.mode': 'scene', 'bg.scene.id': 'sakura', 'bg.scene.tile_scale': 0.65,
          'surround.mode': 'solid', 'surround.color': '#fbeff1',
          'bg.scene.c1': '', 'bg.scene.c2': '', 'bg.scene.c3': '',
          'bg.scene.scale': 1, 'bg.scene.density': 1, 'bg.dim': 0, 'bg.blur': 0,
          'card.fill': '#ffffff', 'card.fill_alpha': 0.6, 'card.border': 1,
          'card.border_color': '', 'card.glow': false, 'card.radius': 20,
          'card.padding': 14, 'text.font': 'Segoe UI', 'text.title_color': '',
          'text.artist_color': '', 'text.label_color': '#e88fb0',
          'text.shadow': 0, 'progress.glow': false, 'progress.color': '#e88fb0',
          'progress.height': 5, 'art.radius': 14, 'art.border': 0,
          'decor.sides': 'none', 'decor.kaomoji': '' },
  },
  cutecore: {
    ui: { accent: '#f25f9f', bg: '#f7b8d0', panel: '#ffdbe8', border: '#f39fc0',
          text: '#6d2549', muted: '#a85b7f', radius: 20, font: 'Segoe UI',
          glow: false, 'decor.sides': 'none', 'decor.kaomoji': KAOMOJI[1],
          'scene.id': 'doodle', 'scene.c1': '', 'scene.c2': '', 'scene.c3': '',
          wallpaper: '', wallpaper_dim: 0 },
    np: { accent: '#f25f9f',
          'palette.text': '#6d2549', 'palette.muted': '#a85b7f', 'palette.line': '#ffffff',
          'bg.mode': 'scene', 'bg.scene.id': 'doodle', 'bg.scene.tile_scale': 0.7,
          'surround.mode': 'solid', 'surround.color': '#f7b8d0',
          'bg.scene.c1': '', 'bg.scene.c2': '', 'bg.scene.c3': '',
          'bg.scene.scale': 1, 'bg.scene.density': 1, 'bg.dim': 0, 'bg.blur': 0,
          'card.fill': '#ffffff', 'card.fill_alpha': 0.7, 'card.border': 2,
          'card.border_color': '', 'card.glow': false, 'card.radius': 24,
          'card.padding': 14, 'text.font': 'Segoe UI', 'text.title_color': '',
          'text.artist_color': '', 'text.label_color': '#f25f9f',
          'text.shadow': 0, 'progress.glow': false, 'progress.color': '#f25f9f',
          'progress.height': 6, 'art.radius': 16, 'art.border': 2,
          'art.border_color': '#ffffff', 'decor.sides': 'none',
          'decor.kaomoji': KAOMOJI[1] },
  },
  redmoon: {
    ui: { accent: '#e8203e', bg: '#120716', panel: '#1b0b21', border: '#331a3c',
          text: '#f3e7f5', muted: '#9d80a7', radius: 10, font: 'Segoe UI',
          glow: false, 'decor.sides': 'none', 'decor.kaomoji': '',
          'scene.id': 'moon', 'scene.c1': '', 'scene.c2': '', 'scene.c3': '',
          wallpaper: '', wallpaper_dim: 0.25 },
    np: { accent: '#e8203e',
          'palette.text': '#f7edf8', 'palette.muted': '#c9a9cf',
          'bg.mode': 'scene', 'bg.scene.id': 'moon',
          'surround.mode': 'solid', 'surround.color': '#000000',
          'bg.scene.c1': '', 'bg.scene.c2': '', 'bg.scene.c3': '',
          'bg.scene.scale': 1, 'bg.scene.density': 1, 'bg.dim': 0, 'bg.blur': 0,
          'card.fill': '', 'card.fill_alpha': 1, 'card.border': 0,
          'card.glow': false, 'card.radius': 10, 'card.padding': 12,
          'text.font': 'Segoe UI', 'text.title_color': '',
          'text.artist_color': '', 'text.label_color': '#e8203e',
          'text.shadow': 0.25, 'progress.glow': false, 'progress.color': '#e8203e',
          'progress.height': 4, 'art.radius': 8, 'art.border': 0,
          'decor.sides': 'none', 'decor.kaomoji': '' },
  },
};

/* Everything a theme owns. Applying one rewrites every key in these lists, so
   a colour the user picked by hand earlier cannot survive into the new theme
   and leave it looking half-applied. Anything a theme does not mention falls
   back to the neutral value below. */
const THEMED_NP = {
  'preset': '',
  'accent': '#8b5cf6',
  'palette.text': '#f4f4f8', 'palette.muted': '#9a9aa8', 'palette.line': '#2a2a3a',
  'bg.mode': 'solid', 'bg.color': '#0f0f17', 'bg.color2': '#241a3d', 'bg.angle': 135,
  'bg.image': '', 'bg.fit': 'cover', 'bg.dim': 0, 'bg.blur': 0,
  'bg.scene.id': '', 'bg.scene.c1': '', 'bg.scene.c2': '', 'bg.scene.c3': '',
  'bg.scene.scale': 1, 'bg.scene.density': 1, 'bg.scene.tile_scale': 1,
  'card.fill': '', 'card.fill_alpha': 1, 'card.border': 1, 'card.border_color': '#2a2a3a',
  'card.glow': false, 'card.radius': 18, 'card.padding': 12,
  'text.font': 'Segoe UI', 'text.title_color': '#f4f4f8', 'text.title_weight': 700,
  'text.artist_color': '#9a9aa8', 'text.label_color': '', 'text.shadow': 0,
  'text.uppercase': false,
  'art.radius': 10, 'art.border': 0, 'art.border_color': '#ffffff33',
  'progress.color': '', 'progress.height': 5, 'progress.glow': false, 'progress.times': true,
  'progress.left': 'elapsed', 'progress.right': 'remaining',
  'surround.mode': 'solid', 'surround.color': '#000000',
  'decor.border': '', 'decor.custom': '', 'decor.sides': 'none', 'decor.size': 0.7,
  'decor.opacity': 0.85, 'decor.color': '', 'decor.gap': 0.5, 'decor.kaomoji': '',
  'decor.animate': false, 'decor.layer': 'under', 'decor.blur': 0, 'decor.inset': 1,
  'decor.tint': true, 'decor.place': 'in', 'decor.speed': 1,
};

const THEMED_UI = {
  'preset': '',
  'accent': '#8b5cf6', 'bg': '#000000', 'panel': '#0a0a0c', 'border': '#1b1b22',
  'text': '#f0f0f4', 'muted': '#7e7e8c', 'radius': 12, 'font': 'Segoe UI',
  'glow': false, 'wallpaper': '', 'wallpaper_dim': 0.65,
  'scene.id': '', 'scene.c1': '', 'scene.c2': '', 'scene.c3': '',
  'scene.scale': 1, 'scene.density': 1, 'scene.tile_scale': 1,
  'decor.border': '', 'decor.custom': '', 'decor.sides': 'none', 'decor.size': 0.7,
  'decor.opacity': 0.5, 'decor.color': '', 'decor.gap': 0.6, 'decor.kaomoji': '',
  'decor.animate': false,
};

function applyTheme(name) {
  const t = THEMES[name];
  if (!t) return;
  const np = {}, ui = {};
  for (const [k, fallback] of Object.entries(THEMED_NP)) {
    np[k] = k in t.np ? t.np[k] : fallback;
  }
  for (const [k, fallback] of Object.entries(THEMED_UI)) {
    ui[k] = k in t.ui ? t.ui[k] : fallback;
  }
  saveUi(ui);
  saveNp(np);
  CONFIG.theme = name;
  post('/api/config', { theme: name });
  syncControls();
  renderPickers();
  renderStickerList();
  renderScenePickers();
  toast('Theme applied');
  // A theme re-lays out the whole page; make sure the live windows survived it.
  setTimeout(healWindows, 700);
}

/* Check the pop-outs after a big change, and rebuild any that came out wrong. */
function healWindows() {
  if (npOpen) {
    post('/api/window/heal').then((r) => {
      if (r.state === 'rebuilt') toast('Now Playing window redrawn');
    });
  }
  if (lyOpen) post('/api/lyrics/window/heal');
  if (qOpen) post('/api/queue/window/heal');
}

function renderAppDecor() {
  const d = (CONFIG && CONFIG.ui && CONFIG.ui.decor) || {};
  renderDecor(document.body, document.getElementById('appDecor'), d,
              CONFIG && CONFIG.ui ? CONFIG.ui.accent : '#8b5cf6');
  const kao = document.getElementById('brandKao');
  if (kao) kao.textContent = d.kaomoji || '';
}

/* ------------------------------------------------------------- generic binding */

const FONTS = ['Segoe UI', 'Segoe UI Variable Display', 'Arial', 'Arial Black',
  'Bahnschrift', 'Calibri', 'Cambria', 'Candara', 'Comic Sans MS', 'Consolas',
  'Constantia', 'Corbel', 'Courier New', 'Franklin Gothic Medium', 'Gabriola',
  'Georgia', 'Impact', 'Ink Free', 'Lucida Console', 'Lucida Sans Unicode',
  'Palatino Linotype', 'Rockwell', 'Sitka Display', 'Tahoma', 'Times New Roman',
  'Trebuchet MS', 'Verdana'];

function fillFonts() {
  const html = FONTS.map((f) => `<option value="${esc(f)}" style="font-family:'${esc(f)}'">${esc(f)}</option>`).join('');
  $('fontPick').innerHTML = html;
  $('uiFontPick').innerHTML = html;
}

function readControl(node, kind) {
  const div = +(node.dataset.div || 1);
  if (kind === 'bool') return node.checked;
  if (kind === 'int') return Math.round(+node.value);
  if (kind === 'float') return +node.value;
  if (kind === 'range') return div === 1 ? +node.value : +node.value / div;
  return node.value;
}

function writeControl(node, kind, value) {
  const div = +(node.dataset.div || 1);
  if (kind === 'bool') node.checked = !!value;
  else if (kind === 'range') node.value = String(Math.round((value ?? 0) * div));
  else if (kind === 'color') node.value = /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#000000';
  else node.value = value ?? '';
}

function showOut(scope, key, node) {
  const out = document.querySelector(`[data-${scope}out="${CSS.escape(key)}"]`);
  if (!out) return;
  const dp = +(node.dataset.dp || 0);
  const div = +(node.dataset.div || 1);
  const v = div === 1 ? +node.value : +node.value / div;
  out.textContent = dp ? v.toFixed(dp) : String(Math.round(v));
}

/* Three config scopes share one binder: the pop-out (np), the app (ui) and
   the lyrics window (ly). Each has its own readout attribute prefix. */
const SCOPES = [
  { attr: 'np', out: '',   root: () => CONFIG.nowplaying, save: (p) => saveNp(p) },
  { attr: 'ui', out: 'u',  root: () => CONFIG.ui,         save: (p) => saveUi(p) },
  { attr: 'ly', out: 'ly', root: () => CONFIG.lyrics || {}, save: (p) => saveLy(p) },
  { attr: 'q',  out: 'q',  root: () => CONFIG.queue || {},  save: (p) => saveQ(p) },
];
const scopeOf = (node) => SCOPES.find((sc) => node.hasAttribute('data-' + sc.attr));

function bindControls() {
  document.querySelectorAll('[data-np],[data-ui],[data-ly],[data-q]').forEach((node) => {
    const scope = scopeOf(node);
    const path = node.dataset[scope.attr];
    const kind = node.dataset.kind || 'str';
    const save = scope.save;

    if (kind === 'seg' || kind === 'segbool') {
      node.querySelectorAll('button').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          node.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
          btn.classList.add('on');
          save({ [path]: kind === 'segbool' ? btn.dataset.v === '1' : btn.dataset.v });
        });
      });
      return;
    }

    const event = (kind === 'range' || node.type === 'color' || node.type === 'text') ? 'input' : 'change';
    node.addEventListener(event, () => {
      if (kind === 'range') showOut(scope.out, path, node);
      save({ [path]: readControl(node, kind) });
    });
  });

  document.querySelectorAll('[data-clear]').forEach((btn) => {
    btn.addEventListener('click', () => saveNp({ [btn.dataset.clear]: '' }));
  });
  document.querySelectorAll('[data-uclear]').forEach((btn) => {
    btn.addEventListener('click', () => saveUi({ [btn.dataset.uclear]: '' }));
  });
}

function syncControls() {
  document.querySelectorAll('[data-np],[data-ui],[data-ly],[data-q]').forEach((node) => {
    const scope = scopeOf(node);
    const path = node.dataset[scope.attr];
    const kind = node.dataset.kind || 'str';
    const value = getPath(scope.root(), path);

    if (kind === 'seg' || kind === 'segbool') {
      const want = kind === 'segbool' ? (value === false ? '0' : '1') : value;
      node.querySelectorAll('button').forEach((b) =>
        b.classList.toggle('on', b.dataset.v === want));
      return;
    }
    writeControl(node, kind, value);
    if (kind === 'range') showOut(scope.out, path, node);
  });
  // Action pickers keep showing whichever entry is actually in force.
  $('fullTheme').value = CONFIG.theme || '';
  $('preset').value = CONFIG.nowplaying.preset || '';
  $('uiPreset').value = CONFIG.ui.preset || '';

  paintCornerPick();
  const ly = CONFIG.lyrics || {};
  if (ly.width) $('lyWidth').value = ly.width;
  if (ly.height) $('lyHeight').value = ly.height;
  const qc = CONFIG.queue || {};
  if (qc.width) $('qWidth').value = qc.width;
  if (qc.height) $('qHeight').value = qc.height;

  $('width').value = CONFIG.nowplaying.width;
  $('height').value = CONFIG.nowplaying.height;
  $('borderless').checked = !!CONFIG.nowplaying.borderless;
  $('topmost').checked = !!CONFIG.nowplaying.topmost;

  document.querySelectorAll('#sourceMode button').forEach((b) =>
    b.classList.toggle('on', b.dataset.mode === CONFIG.source_mode));

  const vol = Math.round((CONFIG.volume ?? 0.7) * 100);
  $('volume').value = vol;
  $('volLabel').textContent = vol;
  audio.volume = vol / 100;
}

/* ------------------------------------------------------------- preview */

const previewFrame = $('previewFrame');
const previewEl = $('preview');

function layoutPreview() {
  const np = winCfg();
  // The iframe can finish loading before /api/config comes back.
  if (!np.width || !np.height) return;
  const stage = $('previewStage');
  const availW = stage.clientWidth - 36;
  const availH = Math.max(120, stage.clientHeight - 36);
  // Show it at the size it really has on screen. The deck runs at the
  // display's scale factor while the overlay is in raw pixels, so one CSS
  // pixel here is devicePixelRatio real pixels; only shrink further to fit.
  const actual = 1 / (window.devicePixelRatio || 1);
  const k = Math.min(availW / np.width, availH / np.height, actual);

  previewEl.style.width = np.width + 'px';
  previewEl.style.height = np.height + 'px';
  previewEl.style.transform = `scale(${k})`;
  previewEl.style.transformOrigin = 'top left';
  previewFrame.style.width = (np.width * k) + 'px';
  previewFrame.style.height = (np.height * k) + 'px';
  const pct = Math.round((k / actual) * 100);
  $('previewSize').textContent =
    `${np.width} × ${np.height} px` + (pct >= 99 ? ' · actual size' : ` · shown at ${pct}%`);
  drawStickerBoxes();
}

function pushPreview() {
  // Send every scope: the frame may be showing any of the three pages, and
  // each picks out the part it needs.
  try {
    previewEl.contentWindow.postMessage({
      type: 'design',
      nowplaying: CONFIG.nowplaying,
      lyrics_cfg: CONFIG.lyrics,
      queue_cfg: CONFIG.queue,
    }, '*');
  } catch (_) { /* iframe still loading */ }
  layoutPreview();
}

/* ------------------------------------------------------------- stickers */

function stickers() { return CONFIG.nowplaying.stickers || (CONFIG.nowplaying.stickers = []); }

function drawStickerBoxes() {
  // Stickers belong to the pop-out; the other windows have none to drag.
  if (!CONFIG || selectedWin !== 'np') { $('previewEdit').innerHTML = ''; return; }
  const list = stickers();
  const w = previewFrame.clientWidth, h = previewFrame.clientHeight;
  $('previewEdit').innerHTML = list.map((st, i) => {
    const bw = (st.w / 100) * w;
    const ar = aspect[st.asset] || 1;
    const bh = bw / ar;
    const left = (st.x / 100) * w - bw / 2;
    const top = (st.y / 100) * h - bh / 2;
    return `<div class="box ${i === selSticker ? 'sel' : ''}" data-i="${i}"
      style="left:${left}px;top:${top}px;width:${bw}px;height:${bh}px;
             transform:rotate(${st.rot || 0}deg)"></div>`;
  }).join('');
}

function renderStickerList() {
  const list = stickers();
  $('stickerList').innerHTML = list.length
    ? list.map((st, i) => `
        <div class="sticker-row ${i === selSticker ? 'on' : ''}" data-i="${i}">
          <img src="/asset/${encodeURIComponent(st.asset)}" alt="">
          <span class="meta">${st.w}% · ${st.rot || 0}° · ${(st.z ?? 5) < 0 ? 'behind' : 'front'}</span>
        </div>`).join('')
    : '<div class="empty">No stickers yet.</div>';

  const st = list[selSticker];
  $('stickerEdit').hidden = !st;
  $('stickerDelete').disabled = !st;
  $('stickerUp').disabled = selSticker <= 0;
  $('stickerDown').disabled = selSticker < 0 || selSticker >= list.length - 1;
  if (st) {
    $('stickerTint').checked = !!st.tint;
    $('stickerColor').value = /^#[0-9a-f]{6}$/i.test(st.color || '') ? st.color : '#ffffff';
    $('stickerPicker').innerHTML = ASSETS.map((a) => `
      <div class="asset ${a.id === st.asset ? 'on' : ''}" data-id="${esc(a.id)}"
           title="${esc(a.name || a.id)}"><img src="${esc(a.url)}" alt="" loading="lazy"></div>`).join('');
  }
  if (st) {
    document.querySelectorAll('[data-st]').forEach((node) => {
      const key = node.dataset.st;
      const div = +(node.dataset.div || 1);
      node.value = String(Math.round((st[key] ?? 0) * div));
      const out = document.querySelector(`[data-sout="${key}"]`);
      if (out) {
        const dp = +(node.dataset.dp || 0);
        out.textContent = dp ? (st[key] ?? 0).toFixed(dp) : String(Math.round(st[key] ?? 0));
      }
    });
  }
  drawStickerBoxes();
}

function updateSticker(patch) {
  const list = stickers();
  if (!list[selSticker]) return;
  Object.assign(list[selSticker], patch);
  saveNp({ stickers: list });
  renderStickerList();
}

function addSticker(assetId, xPct = 50, yPct = 50) {
  const list = stickers();
  list.push({ asset: assetId, x: Math.round(xPct), y: Math.round(yPct),
              w: 20, rot: 0, opacity: 1, z: 5, flip: false });
  selSticker = list.length - 1;
  saveNp({ stickers: list });
  renderStickerList();
  measureAsset(assetId);
}

function measureAsset(assetId) {
  if (aspect[assetId]) return;
  const img = new Image();
  img.onload = () => {
    aspect[assetId] = img.naturalWidth / Math.max(1, img.naturalHeight);
    drawStickerBoxes();
  };
  img.src = '/asset/' + encodeURIComponent(assetId);
}

/* drag a sticker directly on the preview */
(() => {
  const edit = $('previewEdit');
  let dragging = null, startPt = null, startXY = null;

  edit.addEventListener('pointerdown', (e) => {
    const w = previewFrame.clientWidth, h = previewFrame.clientHeight;
    const rect = previewFrame.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const list = stickers();

    for (let i = list.length - 1; i >= 0; i--) {
      const st = list[i];
      const bw = (st.w / 100) * w;
      const bh = bw / (aspect[st.asset] || 1);
      const cx = (st.x / 100) * w, cy = (st.y / 100) * h;
      if (Math.abs(px - cx) <= bw / 2 && Math.abs(py - cy) <= bh / 2) {
        selSticker = i;
        dragging = i;
        startPt = { x: e.clientX, y: e.clientY };
        startXY = { x: st.x, y: st.y };
        edit.setPointerCapture(e.pointerId);
        renderStickerList();
        return;
      }
    }
    selSticker = -1;
    renderStickerList();
  });

  edit.addEventListener('pointermove', (e) => {
    if (dragging === null) return;
    const w = previewFrame.clientWidth, h = previewFrame.clientHeight;
    const list = stickers();
    list[dragging].x = Math.round(startXY.x + ((e.clientX - startPt.x) / w) * 100);
    list[dragging].y = Math.round(startXY.y + ((e.clientY - startPt.y) / h) * 100);
    pushPreview();
    drawStickerBoxes();
  });

  const stop = (e) => {
    if (dragging === null) return;
    dragging = null;
    saveNp({ stickers: stickers() });
    renderStickerList();
    try { edit.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  edit.addEventListener('pointerup', stop);
  edit.addEventListener('pointercancel', stop);
})();

$('stickerList').addEventListener('click', (e) => {
  const row = e.target.closest('.sticker-row');
  if (!row) return;
  selSticker = +row.dataset.i;
  renderStickerList();
});

document.querySelectorAll('[data-st]').forEach((node) => {
  node.addEventListener('input', () => {
    const key = node.dataset.st;
    const div = +(node.dataset.div || 1);
    updateSticker({ [key]: div === 1 ? Math.round(+node.value) : +node.value / div });
  });
});

$('stickerDelete').addEventListener('click', () => {
  const list = stickers();
  if (!list[selSticker]) return;
  list.splice(selSticker, 1);
  selSticker = -1;
  saveNp({ stickers: list });
  renderStickerList();
});
function moveSticker(delta) {
  const list = stickers();
  const to = selSticker + delta;
  if (selSticker < 0 || to < 0 || to >= list.length) return;
  const [item] = list.splice(selSticker, 1);
  list.splice(to, 0, item);
  selSticker = to;
  saveNp({ stickers: list });
  renderStickerList();
}
$('stickerUp').addEventListener('click', () => moveSticker(-1));
$('stickerDown').addEventListener('click', () => moveSticker(1));

/* A tinted sticker is drawn through a mask, which has no shape of its own, so
   the picture's proportions have to be written into the config. Every asset is
   measured when the list loads, but a picture added seconds ago might not be
   yet - and a wrong ratio here would stick until you toggled the tint again.
   So wait for the measurement rather than falling back to a square. */
function withAspect(assetId, fn) {
  if (aspect[assetId]) return fn(aspect[assetId]);
  const img = new Image();
  img.onload = () => {
    aspect[assetId] = img.naturalWidth / Math.max(1, img.naturalHeight);
    fn(aspect[assetId]);
  };
  img.onerror = () => fn(1);
  img.src = '/asset/' + encodeURIComponent(assetId);
}

$('stickerTint').addEventListener('change', () => {
  const st = stickers()[selSticker];
  if (!st) return;
  withAspect(st.asset, (ar) => updateSticker({
    tint: $('stickerTint').checked,
    color: st.color || CONFIG.nowplaying.accent || '#ffffff',
    ar,
  }));
});
$('stickerColor').addEventListener('input', () => {
  const st = stickers()[selSticker];
  if (!st) return;
  withAspect(st.asset, (ar) =>
    updateSticker({ color: $('stickerColor').value, tint: true, ar }));
});

$('stickerPicker').addEventListener('click', (e) => {
  const cell = e.target.closest('.asset');
  if (!cell || selSticker < 0) return;
  withAspect(cell.dataset.id, (ar) => {
    updateSticker({ asset: cell.dataset.id, ar });
    renderPickers();
  });
});

$('stickerFront').addEventListener('click', () => updateSticker({ z: 5 }));
$('stickerBack').addEventListener('click', () => updateSticker({ z: -1 }));
$('stickerFlip').addEventListener('click', () => {
  const st = stickers()[selSticker];
  if (st) updateSticker({ flip: !st.flip });
});

/* ------------------------------------------------------------- assets */

let ASSETS = [];

function loadAssets() {
  return fetch('/api/assets').then((r) => r.json()).then((d) => {
    ASSETS = d.assets || [];
    ASSETS.forEach((a) => measureAsset(a.id));
    renderPickers();
  }).catch(() => {});
}

function renderPickers() {
  const cell = (a, selected) => `
    <div class="asset ${selected ? 'on' : ''} ${a.builtin ? 'builtin' : ''}" data-id="${esc(a.id)}"
         title="${esc(a.name || a.id)}${a.builtin ? ' (built in)' : ' · ' + Math.round((a.size || 0) / 1024) + ' KB'}">
      <img src="${esc(a.url)}" alt="" loading="lazy">
      ${a.builtin ? '' : `<button class="del" data-del="${esc(a.id)}" title="Delete">×</button>`}
    </div>`;
  $('bgPicker').innerHTML =
    ASSETS.map((a) => cell(a, CONFIG.nowplaying.bg.image === a.id)).join('');
  $('wallPicker').innerHTML =
    ASSETS.map((a) => cell(a, CONFIG.ui.wallpaper === a.id)).join('');
  const lyImg = ((CONFIG.lyrics || {}).bg_own || {}).image;
  const qImg = ((CONFIG.queue || {}).bg_own || {}).image;
  $('lyBgPicker').innerHTML = ASSETS.map((a) => cell(a, lyImg === a.id)).join('');
  $('qBgPicker').innerHTML = ASSETS.map((a) => cell(a, qImg === a.id)).join('');
}

function pickerHandler(container, apply) {
  $(container).addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      post('/api/assets/delete', { id: del.dataset.del }).then((d) => {
        ASSETS = d.assets || [];
        renderPickers();
      });
      return;
    }
    const cellEl = e.target.closest('.asset');
    if (cellEl) apply(cellEl.dataset.id);
  });
}
pickerHandler('bgPicker', (id) => { saveNp({ 'bg.image': id, 'bg.mode': 'image' }); syncControls(); renderPickers(); });
pickerHandler('lyBgPicker', (id) => { saveLy({ 'bg_own.image': id, 'bg_own.mode': 'image' }); syncControls(); renderPickers(); });
pickerHandler('qBgPicker', (id) => { saveQ({ 'bg_own.image': id, 'bg_own.mode': 'image' }); syncControls(); renderPickers(); });
pickerHandler('wallPicker', (id) => { saveUi({ wallpaper: id }); renderPickers(); });

/** Read a File, upload it, hand back the asset id. */
function uploadFile(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      post('/api/assets/upload', { name: file.name, data: reader.result })
        .then((res) => {
          if (!res.ok) { toast(res.reason || 'Upload failed'); return resolve(null); }
          ASSETS = res.assets || ASSETS;
          renderPickers();
          measureAsset(res.id);
          // Confirm it can actually be served before calling it a success.
          fetch(res.url, { method: 'HEAD' })
            .then((r) => { if (!r.ok) toast('Saved, but could not be loaded back'); })
            .catch(() => {});
          resolve(res.id);
        });
    };
    reader.onerror = () => { toast('Could not read that file'); resolve(null); };
    reader.readAsDataURL(file);
  });
}

let pickerTarget = null;
$('filePicker').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const id = await uploadFile(file);
  if (!id) return;
  if (pickerTarget === 'bg') { saveNp({ 'bg.image': id, 'bg.mode': 'image' }); syncControls(); }
  else if (pickerTarget === 'wall') saveUi({ wallpaper: id });
  else addSticker(id);
  renderPickers();
});
const openPicker = (target) => { pickerTarget = target; $('filePicker').click(); };
$('bgUpload').addEventListener('click', () => openPicker('bg'));
$('wallUpload').addEventListener('click', () => openPicker('wall'));
$('stickerAdd').addEventListener('click', () => openPicker('sticker'));

/* drop images straight onto the preview */
(() => {
  const stage = $('previewStage');
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  ['dragenter', 'dragover'].forEach((ev) => stage.addEventListener(ev, (e) => {
    stop(e); stage.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((ev) => stage.addEventListener(ev, (e) => {
    stop(e);
    if (ev === 'dragleave' && stage.contains(e.relatedTarget)) return;
    stage.classList.remove('dragover');
  }));
  stage.addEventListener('drop', async (e) => {
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    const rect = previewFrame.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 100;
    const y = ((e.clientY - rect.top) / Math.max(1, rect.height)) * 100;
    // Only the pop-out has stickers. Dropping onto the other two windows sets
    // that window's own background instead, which is the only thing an image
    // could sensibly mean there.
    if (selectedWin !== 'np') {
      const id = await uploadFile(files[0]);
      if (!id) return;
      const save = selectedWin === 'lyrics' ? saveLy : saveQ;
      save({ 'bg_own.image': id, 'bg_own.mode': 'image', follow_theme: false });
      syncControls();
      renderPickers();
      toast('Background set for this window');
      return;
    }
    for (const file of files) {
      const id = await uploadFile(file);
      if (id) addSticker(id, Math.min(100, Math.max(0, x)), Math.min(100, Math.max(0, y)));
    }
    toast(files.length > 1 ? `${files.length} stickers added` : 'Sticker added');
  });
})();

/* ------------------------------------------------------------- presets */

$('preset').addEventListener('change', () => {
  const name = $('preset').value;
  const p = NP_PRESETS[name];
  if (!p) { $('preset').value = CONFIG.nowplaying.preset || ''; return; }
  saveNp({ ...p, preset: name });
  syncControls();
  renderPickers();
  toast('Preset applied');
});

$('uiPreset').addEventListener('change', () => {
  const name = $('uiPreset').value;
  const p = UI_PRESETS[name];
  if (!p) { $('uiPreset').value = CONFIG.ui.preset || ''; return; }
  saveUi({ ...p, preset: name });
  syncControls();
  toast('App theme applied');
});

/* ------------------------------------------------------------- corners & margin */

const CORNER_STEPS = [0, 12, 24];

function paintCornerPick() {
  const r = CONFIG.nowplaying.card.radius ?? 18;
  document.querySelectorAll('#cornerPick button').forEach((b) =>
    b.classList.toggle('on', +b.dataset.r === r));
}

$('cornerPick').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-r]');
  if (!btn) return;
  saveNp({ 'card.radius': +btn.dataset.r });
  syncControls();
});

const SURROUND_SWATCHES = ['#000000', '#ffffff', '#1a1a1f', '#0b0b11', '#00b140', '#ff00ff'];
$('surroundSwatches').innerHTML = SURROUND_SWATCHES.map((c) =>
  `<button data-c="${c}" style="background:${c}" title="${c}"></button>`).join('');
$('surroundSwatches').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-c]');
  if (!btn) return;
  saveNp({ 'surround.color': btn.dataset.c, 'surround.mode': 'solid' });
  syncControls();
});

/* Sample whatever sits behind the card, so the margin blends into the artwork
   rather than cutting a frame around it. */
$('resetColours').addEventListener('click', () => {
  const blanks = {};
  for (const k of LOCAL_COLOUR_KEYS) blanks[k] = '';
  saveNp(blanks);
  syncControls();
  toast('Colours handed back to the theme');
});

$('surroundMatch').addEventListener('click', () => {
  const bg = CONFIG.nowplaying.bg || {};
  let colour = bg.color || '#0f0f17';
  if (bg.mode === 'scene' && bg.scene && SCENES[bg.scene.id]) {
    colour = renderScene(bg.scene.id, sceneParams(bg.scene)).base;
  }
  if (!/^#[0-9a-f]{6}$/i.test(colour)) {
    toast('That background has no single colour to match');
    return;
  }
  saveNp({ 'surround.color': colour, 'surround.mode': 'solid' });
  syncControls();
  toast('Margin matched to the background');
});

const SWATCHES = ['#8b5cf6', '#22d3ee', '#f472b6', '#34d399', '#fbbf24', '#f87171', '#60a5fa', '#ffffff'];
$('swatches').innerHTML = SWATCHES.map((c) =>
  `<button data-c="${c}" style="background:${c}" title="${c}"></button>`).join('');
$('swatches').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-c]');
  if (!btn) return;
  saveNp({ accent: btn.dataset.c });
  syncControls();
});

/* ------------------------------------------------------------- tabs */

$('designTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  document.querySelectorAll('#designTabs button').forEach((b) => b.classList.remove('on'));
  btn.classList.add('on');
  document.querySelectorAll('.tabpane').forEach((p) =>
    p.classList.toggle('on', p.dataset.pane === btn.dataset.tab));
});

/* ------------------------------------------------------------- library */

function loadLibrary(rescan) {
  $('libCount').textContent = rescan ? 'Scanning…' : 'Loading…';
  return fetch('/api/library' + (rescan ? '?rescan=1' : ''))
    .then((r) => r.json())
    .then((data) => {
      TRACKS = data.tracks.map((t) => ({
        ...t,
        search: (t.title + ' ' + t.artist + ' ' + t.album + ' ' + t.folder).toLowerCase(),
      }));
      $('folderBar').innerHTML = (data.dirs || []).map((d) =>
        `<span class="chip" title="${esc(d)}"><span>${esc(d)}</span>
           <button data-dir="${esc(d)}" title="Remove">×</button></span>`).join('');
      filterTracks();
      $('libCount').textContent = data.dirs.length
        ? `${data.count} track${data.count === 1 ? '' : 's'} · ${data.dirs.length} folder${data.dirs.length === 1 ? '' : 's'}`
        : 'No folders added yet';
    });
}

function filterTracks() {
  const q = $('search').value.trim().toLowerCase();
  VIEW = q ? TRACKS.filter((t) => t.search.includes(q)) : TRACKS.slice();
  renderTracks();
}

function renderTracks() {
  const list = $('trackList');
  if (!TRACKS.length) {
    list.innerHTML = `<div class="empty"><b>No music yet.</b><br>
      Hit <b>+ Add music folder</b> below and point it at your tracks.<br>
      mp3, flac, m4a, wav, ogg and opus all work.</div>`;
    return;
  }
  if (!VIEW.length) { list.innerHTML = '<div class="empty">Nothing matches that search.</div>'; return; }

  const cap = 1500;
  const rows = VIEW.slice(0, cap).map((t, i) => `
    <div class="track" data-i="${i}">
      <div class="t-idx">${i + 1}</div>
      <div class="t-title">${esc(t.title)}</div>
      <div class="t-artist">${esc(t.artist || t.album || '')}</div>
      <div class="t-time">${t.duration ? fmt(t.duration) : ''}</div>
    </div>`).join('');
  list.innerHTML = rows + (VIEW.length > cap
    ? `<div class="empty">Showing the first ${cap} of ${VIEW.length}. Search to narrow it down.</div>` : '');
  markCurrent();
}

function markCurrent() {
  const nowId = current >= 0 && VIEW[current] ? VIEW[current].id : null;
  document.querySelectorAll('.track').forEach((row) => {
    const t = VIEW[+row.dataset.i];
    row.classList.toggle('on', !!t && t.id === nowId);
  });
}

/* ------------------------------------------------------------- playback */

function playIndex(i) {
  if (i < 0 || i >= VIEW.length) return;
  current = i;
  const track = VIEW[i];
  audio.src = '/audio/' + track.id;
  audio.play().catch(() => toast('Could not play that file'));

  $('deckSource').textContent = 'From your library';
  $('deckTitle').textContent = track.title;
  $('deckArtist').textContent = [track.artist, track.album].filter(Boolean).join(' — ');
  const art = $('deckArt'), wrap = art.parentElement;
  art.onload = () => wrap.classList.add('has-art');
  art.onerror = () => wrap.classList.remove('has-art');
  wrap.classList.remove('has-art');
  art.src = '/art/' + track.id;

  markCurrent();
  setMediaSession(track);
  report();
}

function nextTrack(auto) {
  if (!VIEW.length) return;
  if (auto && repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
  let i;
  if (shuffle && VIEW.length > 1) {
    do { i = Math.floor(Math.random() * VIEW.length); } while (i === current);
  } else {
    i = current + 1;
    if (i >= VIEW.length) {
      if (auto && repeat !== 'all') { audio.pause(); return; }
      i = 0;
    }
  }
  playIndex(i);
}

function prevTrack() {
  if (!VIEW.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  playIndex(current <= 0 ? VIEW.length - 1 : current - 1);
}

function setMediaSession(track) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title, artist: track.artist, album: track.album,
    artwork: [{ src: '/art/' + track.id, sizes: '512x512' }],
  });
  const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch (_) {} };
  set('play', () => audio.play());
  set('pause', () => audio.pause());
  set('nexttrack', () => nextTrack(false));
  set('previoustrack', prevTrack);
}

function report() {
  const track = current >= 0 ? VIEW[current] : null;
  post('/api/state', {
    track_id: track ? track.id : null,
    playing: !audio.paused && !audio.ended,
    position: audio.currentTime || 0,
    duration: audio.duration || (track ? track.duration : 0) || 0,
    volume: audio.volume,
  });
}

audio.addEventListener('play', () => { $('playpause').textContent = '⏸'; report(); });
audio.addEventListener('pause', () => { $('playpause').textContent = '▶'; report(); });
audio.addEventListener('ended', () => nextTrack(true));
audio.addEventListener('loadedmetadata', () => {
  $('deckDuration').textContent = fmt(audio.duration);
  report();
});
audio.addEventListener('timeupdate', () => {
  if (seeking || cardSource !== 'local') return;
  $('deckElapsed').textContent = fmt(audio.currentTime);
  const d = audio.duration;
  $('seek').value = d > 0 ? Math.round((audio.currentTime / d) * 1000) : 0;
});
audio.addEventListener('error', () => { if (audio.src) toast('That file would not decode'); });

$('seek').addEventListener('input', () => {
  seeking = true;
  const dur = cardSource === 'local' ? (audio.duration || 0) : (cardClock.duration || 0);
  $('deckElapsed').textContent = fmt(($('seek').value / 1000) * dur);
});
$('seek').addEventListener('change', () => {
  if (cardSource !== 'local') {
    const d = cardClock.duration || 0;
    if (d) {
      const to = ($('seek').value / 1000) * d;
      cardClock = { ...cardClock, position: to, at: performance.now() };
      post('/api/spotify/seek', { seconds: to })
        .then((r) => { if (!r.ok) toast(r.reason || 'Could not seek'); });
    }
    seeking = false;
    return;
  }
  const d = audio.duration || 0;
  if (d) audio.currentTime = ($('seek').value / 1000) * d;
  seeking = false;
  report();
});

setInterval(() => { if (!audio.paused) report(); }, 700);

/* ------------------------------------------------------------- the player card */

/* The card mirrors whatever is on screen. For local files that is our own
   <audio>; for Spotify it is the account or the Windows bridge, and the
   transport talks to Spotify instead. */
let lastSeekId = null;
let cardSource = 'local';
let cardClock = { position: 0, duration: 0, playing: false, at: performance.now() };
let cardKey = '';

function paintCard(now) {
  const remote = !!now && now.source !== 'local';
  cardSource = remote ? 'spotify' : 'local';

  if (!now) {
    if (cardKey !== '') {
      cardKey = '';
      $('deckSource').textContent = 'Nothing playing';
      $('deckTitle').textContent = '—';
      $('deckArtist').textContent = '';
      $('deckArt').parentElement.classList.remove('has-art');
      $('deckArt').removeAttribute('src');
    }
    if (!remote) return;
  }
  if (!now) return;

  const key = [now.source, now.title, now.artist].join('|');
  if (key !== cardKey) {
    cardKey = key;
    $('deckSource').textContent = remote
      ? (now.source_label || 'Spotify') : 'From your library';
    $('deckTitle').textContent = now.title || '—';
    $('deckArtist').textContent = [now.artist, now.album].filter(Boolean).join(' — ');
    const art = $('deckArt'), wrap = art.parentElement;
    wrap.classList.remove('has-art');
    if (now.art_url) {
      art.onload = () => wrap.classList.add('has-art');
      art.onerror = () => wrap.classList.remove('has-art');
      art.src = now.art_url;
    } else {
      art.removeAttribute('src');
    }
  }

  $('playpause').textContent = now.playing ? '⏸' : '▶';
  // Only re-seat the clock on a real jump, so the bar does not stutter.
  const drift = Math.abs(cardClock.position - (now.position || 0));
  if (drift > 1.2 || cardClock.playing !== !!now.playing ||
      cardClock.duration !== (now.duration || 0)) {
    cardClock = { position: now.position || 0, duration: now.duration || 0,
                  playing: !!now.playing, at: performance.now() };
  }
}

/* A local file drives the bar from <audio>; anything else runs on this clock. */
function cardTick() {
  if (cardSource !== 'local' && !seeking) {
    let pos = cardClock.position;
    if (cardClock.playing) pos += (performance.now() - cardClock.at) / 1000;
    const dur = cardClock.duration;
    if (dur > 0) pos = Math.min(pos, dur);
    $('deckElapsed').textContent = fmt(pos);
    $('deckDuration').textContent = fmt(dur);
    $('seek').value = dur > 0 ? Math.round((pos / dur) * 1000) : 0;
  }
  requestAnimationFrame(cardTick);
}
requestAnimationFrame(cardTick);

/* ------------------------------------------------------------- ui wiring */

$('trackList').addEventListener('click', (e) => {
  const row = e.target.closest('.track');
  if (row) playIndex(+row.dataset.i);
});
$('folderBar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-dir]');
  if (btn) post('/api/folders/remove', { path: btn.dataset.dir }).then(() => loadLibrary());
});
$('search').addEventListener('input', filterTracks);
$('rescan').addEventListener('click', () => loadLibrary(true).then(() => toast('Library rescanned')));
$('addFolder').addEventListener('click', () => {
  toast('Pick a folder in the dialog…');
  post('/api/folders/add', {}).then((res) => {
    if (res.ok) { loadLibrary(); toast(`Added — ${res.count} tracks`); }
    else if (res.reason !== 'cancelled') toast('Could not add that folder');
  });
});

$('playpause').addEventListener('click', () => {
  if (cardSource !== 'local') { post('/api/spotify/playpause'); return; }
  if (current < 0) { if (VIEW.length) playIndex(0); return; }
  audio.paused ? audio.play() : audio.pause();
});
$('next').addEventListener('click', () => {
  if (cardSource !== 'local') { post('/api/spotify/next'); return; }
  nextTrack(false);
});
$('prev').addEventListener('click', () => {
  if (cardSource !== 'local') { post('/api/spotify/prev'); return; }
  prevTrack();
});
$('shuffle').addEventListener('click', () => {
  shuffle = !shuffle;
  $('shuffle').classList.toggle('on', shuffle);
  toast(shuffle ? 'Shuffle on' : 'Shuffle off');
});
$('repeat').addEventListener('click', () => {
  repeat = repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off';
  $('repeat').classList.toggle('on', repeat !== 'off');
  $('repeat').textContent = repeat === 'one' ? '🔂' : '🔁';
  toast('Repeat: ' + repeat);
});
$('volume').addEventListener('input', () => {
  const v = +$('volume').value;
  audio.volume = v / 100;
  $('volLabel').textContent = v;
});
$('volume').addEventListener('change', () => {
  post('/api/config', { volume: audio.volume });
  if (cardSource !== 'local') {
    post('/api/spotify/volume', { percent: +$('volume').value })
      .then((r) => { if (!r.ok) toast(r.reason || 'Could not set Spotify volume'); });
  }
});

document.querySelectorAll('#sourceMode button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#sourceMode button').forEach((b) => b.classList.remove('on'));
    btn.classList.add('on');
    if (CONFIG) CONFIG.source_mode = btn.dataset.mode;
    paintSourcePanels();
    post('/api/config', { source_mode: btn.dataset.mode });
  });
});


/* --------------------------------------------------------- window picker

   Which pop-out the preview and the settings underneath are talking about.
   One selection drives three things: the page in the preview frame, the size
   it is drawn at, and which design tabs are on offer. */

const WINDOWS = {
  np: {
    page: 'nowplaying.html', size: 'npSize', title: 'This is what the pop-out looks like',
    cfg: () => (CONFIG || {}).nowplaying,
  },
  lyrics: {
    page: 'lyrics.html', size: 'lySize', title: 'This is what the lyrics window looks like',
    cfg: () => (CONFIG || {}).lyrics,
  },
  queue: {
    page: 'queue.html', size: 'qSize', title: 'This is what the queue window looks like',
    cfg: () => (CONFIG || {}).queue,
  },
};
let selectedWin = 'np';

/** The config block for whichever window is selected. */
function winCfg() { return WINDOWS[selectedWin].cfg() || {}; }

function selectWindow(id) {
  if (!WINDOWS[id]) return;
  const changed = id !== selectedWin;
  selectedWin = id;

  document.querySelectorAll('.wincard').forEach((c) => {
    const on = c.dataset.win === id;
    c.classList.toggle('on', on);
    c.setAttribute('aria-pressed', on ? 'true' : 'false');
  });

  // Only offer settings that apply to the window in hand.
  const tabs = [...document.querySelectorAll('#designTabs button')];
  tabs.forEach((b) => { b.hidden = !(b.dataset.for === 'all' || b.dataset.for === id); });
  const active = tabs.find((b) => b.classList.contains('on'));
  if (!active || active.hidden) {
    const first = tabs.find((b) => !b.hidden);
    if (first) first.click();
  }

  $('previewTitle').textContent = WINDOWS[id].title;
  // Stickers only exist on the pop-out, so their drag handles go with it.
  $('previewEdit').hidden = id !== 'np';
  $('dropHintWhat').textContent = id === 'np'
    ? 'to add it as a sticker — or as the background'
    : "to use it as this window's background";

  if (changed) previewEl.src = WINDOWS[id].page + '?preview=1&t=' + Date.now();
  layoutPreview();
}

$('windowsBar').addEventListener('click', (e) => {
  const card = e.target.closest('.wincard');
  if (!card || e.target.closest('button')) return;   // the toggle speaks for itself
  selectWindow(card.dataset.win);
});
$('windowsBar').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const card = e.target.closest('.wincard');
  if (!card) return;
  e.preventDefault();
  selectWindow(card.dataset.win);
});

/** Show a window's open/closed state and current size on its card. */
function paintCardState(win, open, rect) {
  const card = document.querySelector('.wincard[data-win="' + win + '"]');
  if (!card) return;
  card.classList.toggle('live', !!open);
  card.querySelector('.wc-state').textContent = open ? 'live' : 'closed';
  const btn = card.querySelector('.wc-foot button');
  if (btn && !btn.disabled) btn.textContent = open ? 'Close' : 'Open';

  const cfg = WINDOWS[win].cfg() || {};
  const w = (rect && rect.w) || cfg.width;
  const h = (rect && rect.h) || cfg.height;
  const label = $(WINDOWS[win].size);
  if (label && w && h) label.textContent = w + ' \u00d7 ' + h;
}

/* ------------------------------------------------------------- window */

let npOpen = false;

$('npToggle').addEventListener('click', () => {
  if (npOpen) {
    post('/api/window/close').then(() => { npOpen = false; paintWindowStatus(); });
  } else {
    $('npToggle').disabled = true;
    $('npToggle').textContent = 'Opening…';
    post('/api/window/open').then((res) => {
      $('npToggle').disabled = false;
      if (res.hosted === false && res.reason) toast('Opened, but not borderless: ' + res.reason);
      else if (!res.ok) toast(res.reason || 'Could not open the window');
      setTimeout(pollWindow, 800);
    });
  }
});

function paintWindowStatus() { paintCardState('np', npOpen); }

function pollWindow() {
  fetch('/api/window/status').then((r) => r.json()).then((s) => {
    if (s.open !== npOpen) { npOpen = s.open; paintWindowStatus(); }
    // Someone stretched the real window: keep the deck and preview honest.
    if (s.open && s.rect && CONFIG &&
        (s.rect.w !== CONFIG.nowplaying.width || s.rect.h !== CONFIG.nowplaying.height)) {
      CONFIG.nowplaying.width = s.rect.w;
      CONFIG.nowplaying.height = s.rect.h;
      if (document.activeElement !== $('width')) $('width').value = s.rect.w;
      if (document.activeElement !== $('height')) $('height').value = s.rect.h;
      layoutPreview();
    }
    paintCardState('np', s.open, s.rect);
  }).catch(() => {});
}

function applySize(w, h) {
  CONFIG.nowplaying.width = w;
  CONFIG.nowplaying.height = h;
  layoutPreview();
  post('/api/config', { nowplaying: { width: w, height: h } })
    .then(() => post('/api/window/apply', { width: w, height: h }));
}

$('sizePresets').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-w]');
  if (!btn) return;
  $('width').value = btn.dataset.w;
  $('height').value = btn.dataset.h;
  applySize(+btn.dataset.w, +btn.dataset.h);
});
['width', 'height'].forEach((id) => $(id).addEventListener('change', () =>
  applySize(+$('width').value, +$('height').value)));

['borderless', 'topmost'].forEach((id) => $(id).addEventListener('change', () => {
  CONFIG.nowplaying[id] = $(id).checked;
  post('/api/config', { nowplaying: { [id]: $(id).checked } })
    .then(() => post('/api/window/apply', { topmost: $('topmost').checked }));
  if (id === 'borderless') toast('Reopen the window for this to take effect');
}));

$('snap').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-c]');
  if (btn) post('/api/window/snap', { corner: btn.dataset.c })
    .then((r) => { if (!r.ok) toast('Open the on-screen window first'); });
});

$('previewReload').addEventListener('click', () => {
  previewEl.src = 'nowplaying.html?preview=1&t=' + Date.now();
});

$('quitBtn').addEventListener('click', () => {
  if (!confirm('Stop Music Deck? The on-screen window closes too.')) return;
  post('/api/window/close')
    .then(() => post('/api/quit'))
    .then(() => {
      document.body.innerHTML =
        '<div class="empty" style="padding:90px 20px"><b>Music Deck has stopped.</b><br>' +
        'You can close this window.</div>';
    });
});

/* ------------------------------------------------------------- lyrics window */

let lyOpen = false;

function paintLyStatus() { paintCardState('lyrics', lyOpen); }

$('lyToggle').addEventListener('click', () => {
  if (lyOpen) {
    post('/api/lyrics/window/close').then(() => { lyOpen = false; paintLyStatus(); });
    return;
  }
  $('lyToggle').disabled = true;
  $('lyToggle').textContent = 'Opening…';
  post('/api/lyrics/window/open').then((res) => {
    $('lyToggle').disabled = false;
    if (!res.ok) toast(res.reason || 'Could not open the lyrics window');
    setTimeout(pollLyrics, 800);
  });
});

function pollLyrics() {
  fetch('/api/lyrics/window/status').then((r) => r.json()).then((s) => {
    if (s.open !== lyOpen) { lyOpen = s.open; paintLyStatus(); }
    if (s.open && s.rect && CONFIG.lyrics &&
        (s.rect.w !== CONFIG.lyrics.width || s.rect.h !== CONFIG.lyrics.height)) {
      CONFIG.lyrics.width = s.rect.w;
      CONFIG.lyrics.height = s.rect.h;
      if (document.activeElement !== $('lyWidth')) $('lyWidth').value = s.rect.w;
      if (document.activeElement !== $('lyHeight')) $('lyHeight').value = s.rect.h;
      if (selectedWin === 'lyrics') layoutPreview();
    }
    paintCardState('lyrics', s.open, s.rect);
  }).catch(() => {});
  fetch('/api/lyrics').then((r) => r.json()).then((d) => {
    const n = d.lines ? d.lines.length : 0;
    const from = d.source === 'file' ? 'a .lrc file' : d.source === 'lrclib' ? 'lrclib.net' : '';
    $('lyInfo').textContent = {
      synced: `Synced lyrics from ${from} · ${n} lines`,
      plain: `Unsynced lyrics from ${from} — they glide through in proportion to the song`,
      instrumental: 'Instrumental track',
      loading: 'Looking for lyrics…',
      none: d.reason === 'nothing playing' ? 'Nothing playing' : 'No lyrics found for this track',
    }[d.status] || '';
  }).catch(() => {});
}

['lyWidth', 'lyHeight'].forEach((id) => $(id).addEventListener('change', () => {
  const w = +$('lyWidth').value, h = +$('lyHeight').value;
  saveLy({ width: w, height: h });
  post('/api/lyrics/window/apply', { width: w, height: h });
}));

$('lySnap').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-c]');
  if (btn) post('/api/lyrics/window/snap', { corner: btn.dataset.c })
    .then((r) => { if (!r.ok) toast('Open the lyrics window first'); });
});

setInterval(pollLyrics, 3000);

/* ------------------------------------------------------------- queue window */

let qOpen = false;

function paintQStatus() { paintCardState('queue', qOpen); }

$('qToggle').addEventListener('click', () => {
  if (qOpen) {
    post('/api/queue/window/close').then(() => { qOpen = false; paintQStatus(); });
    return;
  }
  $('qToggle').disabled = true;
  $('qToggle').textContent = 'Opening\u2026';
  post('/api/queue/window/open').then((res) => {
    $('qToggle').disabled = false;
    if (!res.ok) toast(res.reason || 'Could not open the queue window');
    setTimeout(pollQueueWindow, 800);
  });
});

function pollQueueWindow() {
  fetch('/api/queue/window/status').then((r) => r.json()).then((s) => {
    if (s.open !== qOpen) { qOpen = s.open; paintQStatus(); }
    if (s.open && s.rect && CONFIG.queue &&
        (s.rect.w !== CONFIG.queue.width || s.rect.h !== CONFIG.queue.height)) {
      CONFIG.queue.width = s.rect.w;
      CONFIG.queue.height = s.rect.h;
      if (document.activeElement !== $('qWidth')) $('qWidth').value = s.rect.w;
      if (document.activeElement !== $('qHeight')) $('qHeight').value = s.rect.h;
      if (selectedWin === 'queue') layoutPreview();
    }
    paintCardState('queue', s.open, s.rect);
  }).catch(() => {});
}

['qWidth', 'qHeight'].forEach((id) => $(id).addEventListener('change', () => {
  const w = +$('qWidth').value, h = +$('qHeight').value;
  saveQ({ width: w, height: h });
  post('/api/queue/window/apply', { width: w, height: h });
}));

$('qSnap').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-c]');
  if (btn) post('/api/queue/window/snap', { corner: btn.dataset.c })
    .then((r) => { if (!r.ok) toast('Open the queue window first'); });
});

setInterval(pollQueueWindow, 3000);

/* ------------------------------------------------------------- keyboard */

document.addEventListener('keydown', (e) => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.key === ' ') { e.preventDefault(); $('playpause').click(); }
  else if (e.key === 'ArrowRight' && e.ctrlKey) nextTrack(false);
  else if (e.key === 'ArrowLeft' && e.ctrlKey) prevTrack();
  else if (e.key === 'ArrowRight') audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
  else if (e.key === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 5);
  else if (e.key === 'Delete' && selSticker >= 0) $('stickerDelete').click();
  else if (e.key === '/' || (e.key === 'f' && e.ctrlKey)) { e.preventDefault(); $('search').focus(); }
});

/* ------------------------------------------------------------- spotify panel */

function paintSpotify(state) {
  const status = state.spotify_status || {};
  const pill = $('spotifyPill'), body = $('spotifyBody');

  if (status.available == null) { pill.textContent = 'starting…'; pill.className = 'pill pill-warn'; }
  else if (status.available === false) {
    pill.textContent = 'unavailable'; pill.className = 'pill pill-bad';
    body.innerHTML = `<div class="muted small">${esc(status.error || 'Windows media session not reachable.')}</div>`;
  } else if (!status.has) {
    pill.textContent = 'idle'; pill.className = 'pill pill-off';
    body.innerHTML = '<div class="muted small">Nothing playing. Start a track in Spotify and it shows up here.</div>';
  } else {
    pill.textContent = status.app || 'connected';
    pill.className = 'pill pill-on';
  }

  const sp = state.spotify;
  if (sp) {
    // One line, not a second copy of the player card above.
    body.innerHTML = `<div class="muted small">Windows is reporting
      <b>${esc(sp.title || 'Unknown')}</b>${sp.artist ? ' — ' + esc(sp.artist) : ''}</div>`;
  }

  const acc = status.account || {};
  let line = 'Account: not connected';
  if (acc.connected) {
    line = acc.has ? `Account: connected \u00b7 playing on ${acc.device || 'a device'}`
                   : 'Account: connected \u00b7 nothing playing';
  }
  if (acc.error) line += ` \u2014 ${acc.error}`;
  $('spAccStatus').textContent = line;
  // A pop-out asked to seek a local file; we hold the audio element.
  const sk = state.local_seek;
  if (sk && sk.id !== lastSeekId) {
    lastSeekId = sk.id;
    if (cardSource === 'local' && audio.duration) audio.currentTime = sk.to;
  }
  paintSpotifyAccount(acc, state.spotify_account || null);
  paintSourcePanels(state);
  paintCard(state.now);
  queueFollowsTrack(state);
  if (acc.connected && spWaiting) {
    spWaiting = false;
    $('spPending').hidden = true;
    $('spPending2').hidden = true;
    $('spManual').hidden = true;
    $('spManual2').hidden = true;
    toast('Spotify account connected');
  }
  $('spAccToggle').textContent = $('spAccSetup').hidden
    ? (acc.connected ? 'Account settings' : 'Connect account\u2026') : 'Hide';
  if (acc.redirect_uri) $('spRedirect').textContent = acc.redirect_uri;
}

$('spAccToggle').addEventListener('click', () => {
  $('spAccSetup').hidden = !$('spAccSetup').hidden;
  if (!$('spAccSetup').hidden && CONFIG && CONFIG.spotify) {
    $('spClientId').value = CONFIG.spotify.client_id || '';
    $('spUseAccount').checked = CONFIG.spotify.use_account !== false;
  }
});
let spWaiting = false;

$('spConnect').addEventListener('click', () => {
  const id = $('spClientId').value.trim();
  if (!id) { toast('Paste the Client ID from your Spotify app first'); return; }
  if (CONFIG) CONFIG.spotify = Object.assign(CONFIG.spotify || {}, { client_id: id });
  post('/api/spotify/connect', { client_id: id }).then((res) => {
    if (!res.ok) { toast(res.reason || 'Could not start the Spotify sign-in'); return; }
    spWaiting = true;
    $('spPending').hidden = false;
    // A blocked pop-up or a missing browser still leaves a way through.
    $('spManualLink').href = res.url;
    $('spManual').hidden = !!res.windowed;
    toast(res.windowed ? 'Approve Music Deck in the window that just opened'
                       : 'Approve Music Deck in your browser');
    setTimeout(() => {   // stop waiting if they walk away from it
      if (spWaiting) { spWaiting = false; $('spPending').hidden = true; }
    }, 180000);
  });
});
$('spDisconnect').addEventListener('click', () => {
  post('/api/spotify/disconnect').then(() => toast('Spotify account disconnected'));
});
$('spUseAccount').addEventListener('change', () => {
  if (CONFIG) CONFIG.spotify = Object.assign(CONFIG.spotify || {}, { use_account: $('spUseAccount').checked });
  post('/api/config', { spotify: { use_account: $('spUseAccount').checked } });
});

/* ------------------------------------------------------------- source panels */

/* The left column follows the source. On Auto that means whatever is actually
   playing right now, so starting a track in Spotify brings its queue up and a
   local file brings your folders back. */
let LAST_STATE = null;
let autoShowsSpotify = false;

function paintSourcePanels(state) {
  if (!CONFIG) return;
  if (state) LAST_STATE = state;
  const mode = CONFIG.source_mode;
  let spotify;

  if (mode === 'spotify') {
    spotify = true;
  } else if (mode === 'local') {
    spotify = false;
  } else {
    const src = ((LAST_STATE || {}).now || {}).source;
    // Anything else playing (a browser tab, say) is not Spotify's queue and not
    // your library either, so leave whichever panel is already up alone.
    if (src === 'spotify') autoShowsSpotify = true;
    else if (src === 'local') autoShowsSpotify = false;
    spotify = autoShowsSpotify;
  }

  const wasSpotify = !$('spotifyMain').hidden;
  if (spotify === wasSpotify) return;

  // Never pull the panel out from under someone who is typing in it.
  const busy = document.activeElement;
  if (busy && busy.tagName === 'INPUT' &&
      busy.closest(spotify ? '#libraryPanel' : '#spotifyMain')) return;

  $('spotifyMain').hidden = !spotify;
  $('libraryPanel').hidden = spotify;
  if (spotify) refreshSpotifyPanel();
}

let spConnected = false;
let spQueueTimer = null;
let spRepeatMode = 'off';
let spShuffleOn = false;

function spRow(t, i, opts = {}) {
  const idx = opts.index === undefined ? '' : ` data-i="${opts.index}"`;
  const acts = (opts.actions || []).map((a) =>
    `<button class="btn btn-ghost btn-sm" data-act="${a.act}" data-uri="${esc(t.uri)}"${idx}>${a.label}</button>`).join('');
  return `<div class="sp-row ${opts.now ? 'now' : ''}" data-uri="${esc(t.uri)}">
      <div class="n">${opts.now ? '♪' : (i + 1)}</div>
      ${t.art ? `<img src="${esc(t.art)}" alt="" loading="lazy">` : '<img alt="">'}
      <div class="meta">
        <div class="t">${esc(t.title)}</div>
        <div class="a">${esc(t.artist)}</div>
      </div>
      <div class="acts">${acts}</div>
    </div>`;
}

function refreshSpotifyPanel() {
  fetch('/api/spotify/queue').then((r) => r.json()).then((d) => {
    $('spQueueErr').textContent = d.ok ? '' : (d.reason || '');
    if (!d.ok) return;
    const rows = [];
    if (d.now) rows.push(spRow(d.now, 0, { now: true }));
    (d.queue || []).forEach((t, i) => rows.push(spRow(t, i, {
      actions: [{ act: 'play', label: 'Play now' }], index: i,
    })));
    $('spQueue').innerHTML = rows.length ? rows.join('')
      : '<div class="empty">Nothing queued. Start something in Spotify, or search above.</div>';
    $('spQueueCount').textContent = (d.queue || []).length
      ? `Up next · ${d.queue.length}` : 'Up next';
  }).catch(() => {});

  fetch('/api/spotify/devices').then((r) => r.json()).then((d) => {
    if (!d.ok) return;
    const sel = $('spDevice');
    const active = (d.devices.find((x) => x.active) || {}).id || '';
    sel.innerHTML = d.devices.length
      ? d.devices.map((x) => `<option value="${esc(x.id)}" ${x.active ? 'selected' : ''}>${esc(x.name)} · ${esc(x.type)}</option>`).join('')
      : '<option value="">no devices</option>';
    sel.dataset.active = active;
  }).catch(() => {});
}

function paintSpotifyAccount(acc, sp) {
  const wasConnected = spConnected;
  spConnected = !!acc.connected;
  $('spSetup').hidden = spConnected;
  $('spQueueWrap').hidden = !spConnected;
  $('spDisconnectWrap').hidden = !spConnected;
  $('spDevice').hidden = !spConnected;
  $('spQueueRefresh').hidden = !spConnected;

  const pill = $('spMainStatus');
  pill.textContent = spConnected
    ? (acc.has ? `playing on ${acc.device || 'a device'}` : 'connected')
    : 'not connected';
  pill.className = 'pill ' + (spConnected ? (acc.has ? 'pill-on' : 'pill-warn') : 'pill-off');
  if (acc.redirect_uri) $('spRedirect2').textContent = acc.redirect_uri;

  if (sp) {
    spShuffleOn = !!sp.shuffle;
    spRepeatMode = sp.repeat || 'off';
    $('spShuffle').classList.toggle('on', spShuffleOn);
    $('spRepeat').classList.toggle('on', spRepeatMode !== 'off');
    $('spRepeat').textContent = spRepeatMode === 'track' ? '🔂' : '🔁';
  }
  if (spConnected && !wasConnected) refreshSpotifyPanel();
}

/* search -> click a result to queue it */
let spSearchTimer = null;
$('spSearch').addEventListener('input', () => {
  clearTimeout(spSearchTimer);
  const q = $('spSearch').value.trim();
  if (!q) { $('spResults').hidden = true; return; }
  spSearchTimer = setTimeout(() => {
    fetch('/api/spotify/search?q=' + encodeURIComponent(q)).then((r) => r.json()).then((d) => {
      if (!d.ok) { toast(d.reason || 'Search failed'); return; }
      $('spResults').hidden = false;
      $('spResults').innerHTML = d.results.length
        ? d.results.map((t, i) => spRow(t, i, {
            actions: [{ act: 'queue', label: '+ Queue' }, { act: 'play', label: 'Play now' }],
          })).join('')
        : '<div class="empty">Nothing found.</div>';
    }).catch(() => {});
  }, 350);
});

function spAct(act, uri, index) {
  const url = act === 'play' ? '/api/spotify/playuri' : '/api/spotify/enqueue';
  const body = { uri };
  if (act === 'play' && index !== undefined && index !== '') body.index = +index;
  post(url, body).then((res) => {
    if (!res.ok) { toast(res.reason || 'Spotify refused that'); return; }
    toast(act !== 'play' ? 'Added to the queue'
      : res.skipped ? `Playing — skipped ${res.skipped} track${res.skipped === 1 ? '' : 's'}`
      : 'Playing');
    setTimeout(refreshSpotifyPanel, 900);
  });
}

$('spResults').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (btn) { spAct(btn.dataset.act, btn.dataset.uri, btn.dataset.i); return; }
  const row = e.target.closest('.sp-row');
  if (row) spAct('queue', row.dataset.uri);       // clicking a result queues it
});
$('spQueue').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (btn) spAct(btn.dataset.act, btn.dataset.uri, btn.dataset.i);
});

$('spQueueRefresh').addEventListener('click', refreshSpotifyPanel);
$('spDevice').addEventListener('change', () => {
  const id = $('spDevice').value;
  if (!id || id === $('spDevice').dataset.active) return;
  post('/api/spotify/transfer', { device_id: id }).then((res) => {
    toast(res.ok ? 'Moved playback' : (res.reason || 'Could not move playback'));
    setTimeout(refreshSpotifyPanel, 900);
  });
});
$('spShuffle').addEventListener('click', () => {
  post('/api/spotify/toggle', { what: 'shuffle', value: !spShuffleOn })
    .then((r) => { if (!r.ok) toast(r.reason || 'Could not set shuffle'); });
});
$('spRepeat').addEventListener('click', () => {
  const next = spRepeatMode === 'off' ? 'context' : spRepeatMode === 'context' ? 'track' : 'off';
  post('/api/spotify/toggle', { what: 'repeat', value: next })
    .then((r) => { if (!r.ok) toast(r.reason || 'Could not set repeat'); });
});
$('spDisconnect2').addEventListener('click', () => {
  post('/api/spotify/disconnect').then(() => toast('Spotify account disconnected'));
});

/* the second Client ID box, shown in the main panel */
$('spConnect2').addEventListener('click', () => {
  const id = $('spClientId2').value.trim();
  if (!id) { toast('Paste the Client ID from your Spotify app first'); return; }
  if (CONFIG) CONFIG.spotify = Object.assign(CONFIG.spotify || {}, { client_id: id });
  post('/api/spotify/connect', { client_id: id }).then((res) => {
    if (!res.ok) { toast(res.reason || 'Could not start the Spotify sign-in'); return; }
    spWaiting = true;
    $('spPending2').hidden = false;
    $('spManualLink2').href = res.url;
    $('spManual2').hidden = !!res.windowed;
    toast(res.windowed ? 'Approve Music Deck in the window that just opened'
                       : 'Approve Music Deck in your browser');
  });
});

/* Keep the queue fresh whenever the panel is on screen - including in Auto
   mode, where Spotify's queue is showing because Spotify is what is playing. */
setInterval(() => {
  if (!CONFIG || !spConnected) return;
  if ($('spotifyMain').hidden) return;
  refreshSpotifyPanel();
}, 4000);

/* A track change means the queue moved on; refresh without waiting for the timer. */
let lastQueueTrack = '';
function queueFollowsTrack(state) {
  const now = state.now || {};
  const key = [now.source, now.title, now.artist].join('|');
  if (key === lastQueueTrack) return;
  lastQueueTrack = key;
  if (spConnected && !$('spotifyMain').hidden) setTimeout(refreshSpotifyPanel, 600);
}

/* ------------------------------------------------------------- boot */

function fillDecorPickers() {
  const opts = decorOptions(esc);
  $('decorBorder').innerHTML = opts;
  $('uiDecorBorder').innerHTML = opts;
  $('kaoPick').innerHTML = KAOMOJI.map((k) =>
    `<option value="${esc(k)}">${k ? esc(k) : '- none -'}</option>`).join('');
}

$('fullTheme').addEventListener('change', () => {
  const name = $('fullTheme').value;
  if (name) applyTheme(name); else $('fullTheme').value = CONFIG.theme || '';
});

fillFonts();
fillDecorPickers();
bindControls();

fetch('/api/config').then((r) => r.json()).then((cfg) => {
  CONFIG = cfg;
  applyUi(CONFIG.ui);
  CONFIG.lyrics = CONFIG.lyrics || {};
  syncControls();
  renderStickerList();
  renderScenePickers();
  layoutPreview();
  paintWindowStatus();
  paintLyStatus();
  paintQStatus();
  selectWindow('np');
  paintSourcePanels();
  pollWindow();
  pollLyrics();
  pollQueueWindow();
  return loadAssets().then(loadLibrary);
});

previewEl.addEventListener('load', pushPreview);
window.addEventListener('resize', layoutPreview);
new ResizeObserver(layoutPreview).observe($('previewStage'));

const events = new EventSource('/api/events');
events.onmessage = (e) => { try { paintSpotify(JSON.parse(e.data)); } catch (_) {} };

setInterval(pollWindow, 2500);
