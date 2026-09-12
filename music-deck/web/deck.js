/* Awesome Streaming Deck - control room.

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
  beginEdit();
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

/* Colors a theme owns but that live on individual controls. Clearing them
   hands those elements back to the palette. */
const LOCAL_COLOR_KEYS = [
  'text.title_color', 'text.artist_color', 'text.label_color',
  'card.border_color', 'card.fill', 'art.border_color',
  'progress.color', 'decor.color',
];

let uiTimer = null, uiPending = {};
function saveUi(patch) {
  beginEdit();
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
  beginEdit();
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

let capTimer = null, capPending = {};
function saveCap(patch) {
  beginEdit();
  CONFIG.captions = CONFIG.captions || {};
  Object.entries(patch).forEach(([k, v]) => setPath(CONFIG.captions, k, v));
  Object.assign(capPending, patch);
  clearTimeout(capTimer);
  capTimer = setTimeout(() => {
    const body = {};
    for (const [path, val] of Object.entries(capPending)) deepMerge(body, patchFor(path, val));
    capPending = {};
    post('/api/config', { captions: body });
  }, 180);
}

/* The two frames keep their design under "frame" in their own sections; the
   designer edits whichever frame is picked. */
const isFrame = (id) => id === 'screenframe' || id === 'camframe';
const frameKey = () => (isFrame(selectedWin) ? selectedWin : 'screenframe');
let frTimer = null, frPending = {}, frPendingKey = '';
function saveFrame(patch) {
  beginEdit();
  const key = frameKey();
  if (frPendingKey && frPendingKey !== key) { clearTimeout(frTimer); flushFrame(); }
  CONFIG[key] = CONFIG[key] || {};
  Object.entries(patch).forEach(([k, v]) => setPath(CONFIG[key], k, v));
  // Straight into the preview, so it never lags behind the sliders.
  try {
    previewEl.contentWindow.postMessage({ type: 'frame', section: key, cfg: CONFIG[key].frame,
                                          nowplaying: CONFIG.nowplaying }, '*');
  } catch (_) { /* the preview is loading */ }
  frPendingKey = key;
  Object.assign(frPending, patch);
  clearTimeout(frTimer);
  frTimer = setTimeout(flushFrame, 180);
}
function flushFrame() {
  if (!frPendingKey) return;
  const body = {};
  for (const [path, val] of Object.entries(frPending)) deepMerge(body, patchFor(path, val));
  const key = frPendingKey;
  frPending = {};
  frPendingKey = '';
  post('/api/config', { [key]: body });
}

let qTimer = null, qPending = {};
function saveQ(patch) {
  beginEdit();
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

/* ------------------------------------------------------------- undo / redo

   Every design change goes through one of the save fns above, and each calls
   beginEdit() first. beginEdit snapshots the WHOLE config once per gesture: the
   first change after a 500 ms lull pushes a baseline, so dragging a slider forty
   pixels is one undo step, not forty. Undo/redo restore a full snapshot through
   /api/config - the server deep-merges and never deletes keys, so a restore can
   never leave a stale value behind. */
const undoStack = [];
const redoStack = [];
let histArmed = false;      // a baseline is already banked for this gesture
let histIdle = null;        // resets histArmed after a pause
let restoring = false;      // guards beginEdit while we apply a snapshot

const snap = () => JSON.stringify(CONFIG);

function beginEdit() {
  if (restoring || !CONFIG) return;
  if (!histArmed) {
    undoStack.push(snap());
    if (undoStack.length > 50) undoStack.shift();
    redoStack.length = 0;
    histArmed = true;
    updateUndoButtons();
  }
  clearTimeout(histIdle);
  histIdle = setTimeout(() => { histArmed = false; }, 500);
}

/* Put a full config snapshot back in force, everywhere. */
function applySnapshot(str) {
  restoring = true;
  // Drop any half-second of debounced patches still in flight, or they would
  // land on top of the snapshot we are restoring and undo the undo.
  clearTimeout(npTimer); clearTimeout(uiTimer); clearTimeout(lyTimer); clearTimeout(qTimer);
  clearTimeout(capTimer);
  npPending = {}; uiPending = {}; lyPending = {}; qPending = {}; capPending = {};
  CONFIG = JSON.parse(str);
  CONFIG.lyrics = CONFIG.lyrics || {};
  CONFIG.queue = CONFIG.queue || {};
  post('/api/config', CONFIG);          // FULL snapshot, not a diff
  applyUi(CONFIG.ui);
  syncControls();
  pushPreview();
  renderPickers();
  restoring = false;
}

function undo() {
  if (!undoStack.length) return;
  clearTimeout(histIdle);
  histArmed = false;
  redoStack.push(snap());
  applySnapshot(undoStack.pop());
  updateUndoButtons();
  toast('Undone');
}

function redo() {
  if (!redoStack.length) return;
  clearTimeout(histIdle);
  histArmed = false;
  undoStack.push(snap());
  applySnapshot(redoStack.pop());
  updateUndoButtons();
  toast('Redone');
}

function updateUndoButtons() {
  const u = $('undoBtn'), r = $('redoBtn');
  if (u) u.disabled = !undoStack.length;
  if (r) r.disabled = !redoStack.length;
}

/* ------------------------------------------------------------- saved looks

   A "look" is a named bundle of the design config, kept server-side under
   /api/themes. The wire field is `data` (a partial /api/config patch), not
   `config`. Applying one is a normal /api/config POST - there is no separate
   apply endpoint - and is itself undoable. */
let SAVED_THEMES = [];

function captureLook() {
  const ly = CONFIG.lyrics || {}, q = CONFIG.queue || {}, cp = CONFIG.captions || {};
  // A look is how the window looks, not where it sits or how it behaves:
  // applying one must never move the window or bring back its title bar.
  const { x, y, borderless, topmost, ...npLook } = CONFIG.nowplaying;
  return {
    nowplaying: npLook,
    ui: CONFIG.ui,
    lyrics:   { colors: ly.colors, bg_own: ly.bg_own, bg: ly.bg, follow_theme: ly.follow_theme, font: ly.font },
    queue:    { colors: q.colors,  bg_own: q.bg_own,  bg: q.bg,  follow_theme: q.follow_theme,  font: q.font },
    captions: { colors: cp.colors, bg_own: cp.bg_own, bg: cp.bg, follow_theme: cp.follow_theme, font: cp.font },
  };
}

function renderSavedThemes() {
  const sel = $('savedThemes');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— saved looks —</option>' +
    SAVED_THEMES.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  sel.value = cur;
}

function loadSavedThemes() {
  return fetch('/api/themes').then((r) => r.json())
    .then((d) => { SAVED_THEMES = (d && d.themes) || []; renderSavedThemes(); })
    .catch(() => { SAVED_THEMES = []; renderSavedThemes(); });
}

function saveLook() {
  const name = (prompt('Name this look:') || '').trim();
  if (!name) return;
  post('/api/themes/save', { name, data: captureLook() }).then((res) => {
    if (res && res.ok) {
      SAVED_THEMES = res.themes || SAVED_THEMES;
      renderSavedThemes();
      toast('Look saved');
    } else {
      toast((res && res.reason) || 'Could not save the look');
    }
  });
}

function applySavedTheme(id) {
  const theme = SAVED_THEMES.find((t) => t.id === id);
  if (!theme) return;
  beginEdit();                          // applying a look is undoable
  post('/api/config', theme.data).then(() =>
    fetch('/api/config').then((r) => r.json()).then((cfg) => {
      CONFIG = cfg;
      CONFIG.lyrics = CONFIG.lyrics || {};
      CONFIG.queue = CONFIG.queue || {};
      applyUi(CONFIG.ui);
      syncControls();
      pushPreview();
      renderPickers();
      renderStickerList();
      renderScenePickers();
      toast('Look applied');
      setTimeout(healWindows, 700);
    }));
}

function deleteSavedTheme(id) {
  post('/api/themes/delete', { id }).then((res) => {
    SAVED_THEMES = (res && res.themes) || [];
    renderSavedThemes();
    toast('Look deleted');
  });
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

/* Black or white, whichever stays readable on this color. A white accent on a
   white-filled button is invisible otherwise. */
let lastWallKey = null;

/* The preview hears about ultra optimized straight away, not after the
   broadcast comes round. */
function tellPreviewUltra() {
  try {
    document.getElementById('preview').contentWindow.postMessage(
      { type: 'ultra', on: !!(CONFIG && CONFIG.ui && CONFIG.ui.ultra) }, '*');
  } catch (_) { /* frame still loading */ }
}

function applyUi(ui) {
  // Ultra optimized: this page stills itself, tells the preview, and the
  // Listening tab says why captions show finished lines only.
  setUltra(!!ui.ultra);
  tellPreviewUltra();
  const ultraNote = document.getElementById('capUltraNote');
  if (ultraNote) ultraNote.hidden = !ui.ultra;
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

  // The app's wallpaper is painted by the same function as every window's
  // background, so it gets the same modes, framing, fit, blur and artwork.
  // applyUi runs on every input event, and repainting a generated scene means
  // rebuilding an SVG data URL - so only do it when the wallpaper changed,
  // not when someone drags the radius slider.
  const wall = ui.wallpaper || {};
  const key = JSON.stringify(wall);
  if (key === lastWallKey) return;
  lastWallKey = key;

  // "Solid" means no wallpaper here: the app's own background color shows,
  // rather than a second color control fighting with it.
  const off = (wall.mode || 'solid') === 'solid';
  $('appWall').hidden = off;
  if (off) {
    // Clear it rather than just hiding it, so nothing stale is waiting behind
    // `hidden` if the wallpaper comes back.
    $('appWallArt').style.backgroundImage = '';
    $('appWallBase').style.background = '';
    $('appWallDim').style.opacity = '0';
    return;
  }
  applyBackground($('appWall'), $('appWallArt'), wall,
                  (k, v) => { if (k === '--bg') $('appWallBase').style.background = v; });
  $('appWallDim').style.opacity = String(wall.dim ?? 0);
}

/* ------------------------------------------------------- window controls

   Transport buttons drawn inside a window. One editor per window, generated
   the same way the background editors are, and shown for whichever window is
   picked at the top - there are only three, and the windows bar already
   chooses between them, so this needs no switcher of its own. */


/* The anchor grid, drawn rather than typed: arrow glyphs measured a pixel or
   so low in their buttons, while one arrow turned about its own center is
   centered in every direction. `deg` turns the right-pointing arrow; null is
   the center dot. */
const ANCHORS = [
  ['tl', 'Top left', 225], ['tc', 'Top center', 270], ['tr', 'Top right', 315],
  ['ml', 'Middle left', 180], ['mc', 'Center', null], ['mr', 'Middle right', 0],
  ['bl', 'Bottom left', 135], ['bc', 'Bottom center', 90], ['br', 'Bottom right', 45],
];
const anchorIcon = (deg) => deg === null
  ? '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.6" fill="currentColor"/></svg>'
  : `<svg viewBox="0 0 16 16" aria-hidden="true" style="transform:rotate(${deg}deg)"><path d="M4 8h8M8.5 4.5 12 8l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/* Lining the buttons up with the bar or the cover means nothing until they
   have a place on the grid, so that first choice also puts them centered
   just below - where they look most at home. */
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-np="controls.relative_to"] button');
  if (!b || b.dataset.v === 'window') return;
  const c = ((CONFIG || {}).nowplaying || {}).controls || {};
  if (!c.anchor) { saveNp({ 'controls.anchor': 'bc' }); syncControls(); }
});

function controlEditorHTML(t) {
  const a = t.attr, o = t.out;
  const D = (k) => `data-${a}="controls.${k}"`;
  const O = (k) => `data-${o}out="controls.${k}"`;
  return `
    <div class="checks">
      <label class="check"><input type="checkbox" ${D('show')} data-kind="bool">
        <span>Show buttons on ${t.what}</span></label>
      <label class="check"><input type="checkbox" ${D('hover_only')} data-kind="bool">
        <span>Only while my mouse is over it</span></label>
    </div>

    <label class="field">
      <span>Which buttons</span>
      <div class="checks row-checks">
        <label class="check"><input type="checkbox" ${D('prev')} data-kind="bool"><span>Back</span></label>
        <label class="check"><input type="checkbox" ${D('play')} data-kind="bool"><span>Play / pause</span></label>
        <label class="check"><input type="checkbox" ${D('next')} data-kind="bool"><span>Skip</span></label>
      </div>
    </label>

    ${t.key === 'np' ? `
    <label class="field">
      <span>Line the buttons up with</span>
      <div class="segmented small" ${D('relative_to')} data-kind="seg">
        <button type="button" data-v="window">The whole window</button>
        <button type="button" data-v="progress">The progress bar</button>
        <button type="button" data-v="art">The album art</button>
      </div>
      <span class="hint">Centered buttons usually look best lined up with the progress bar or
        the cover rather than the whole card. With the bar, top and bottom mean just above and
        just below it; with the cover, every position is inside it.</span>
    </label>` : ''}

    <label class="field">
      <span>Where the buttons sit</span>
      <div class="segmented small anchor-grid" ${D('anchor')} data-kind="seg">
        ${ANCHORS.map(([v, title, deg]) =>
          `<button type="button" data-v="${v}" title="${title}" aria-label="${title}">${anchorIcon(deg)}</button>`).join('')}
      </div>
      <span class="hint">Pick a corner or an edge for the transport buttons, or leave it
        untouched to keep the classic placement.</span>
    </label>

    <label class="field">
      <span>Nudge sideways <b class="mono" ${O('offset.x')}>0</b> px</span>
      <input class="range" type="range" min="-150" max="150" ${D('offset.x')} data-kind="range" ${O('offset.x')}>
    </label>
    <label class="field">
      <span>Nudge up or down <b class="mono" ${O('offset.y')}>0</b> px</span>
      <input class="range" type="range" min="-150" max="150" ${D('offset.y')} data-kind="range" ${O('offset.y')}>
    </label>

    <div class="row gap wrap">
      <button type="button" class="btn btn-ghost btn-sm nudge-reset">Recenter buttons</button>
    </div>

    <label class="field">
      <span>Shape</span>
      <div class="segmented small" ${D('shape')} data-kind="seg">
        <button data-v="round">Round</button>
        <button data-v="square">Square</button>
        <button data-v="bare">Just the icon</button>
      </div>
    </label>

    <label class="field">
      <span>Size <b class="mono" ${O('size')}>1.00</b></span>
      <input class="range" type="range" min="50" max="220" data-div="100" data-dp="2"
             ${D('size')} data-kind="range" ${O('size')}>
    </label>
    <label class="field">
      <span>Opacity <b class="mono" ${O('opacity')}>0.90</b></span>
      <input class="range" type="range" min="20" max="100" data-div="100" data-dp="2"
             ${D('opacity')} data-kind="range" ${O('opacity')}>
    </label>

    <p class="hint">The buttons only work when that window is set to
      <b>Clickable</b>; otherwise the whole window stays inert.</p>`;
}

function buildControlEditors() {
  $('controlEditors').innerHTML = CONTROL_TARGETS.map((t) =>
    `<div class="control-editor" data-ctl="${t.key}"${t.key === 'np' ? '' : ' hidden'}>` +
    controlEditorHTML(t) + '</div>').join('');
}

function selectControlTarget(key) {
  document.querySelectorAll('.control-editor').forEach((el) => {
    el.hidden = el.dataset.ctl !== key;
  });
}

/* ------------------------------------------------------- backgrounds

   The pop-out, the lyrics window, the queue window and the app all have a
   background of exactly the same shape. Rather than four editors quietly
   drifting apart - which is how the app ended up with only "pick an image and
   darken it" - there is one, generated once per target. Only the data-*
   attributes differ, and that is all the declarative binding needs.

   Generation happens before bindControls(), so the generated controls are
   wired and synced by the same machinery as the hand-written ones. */

const BG_TARGETS = [
  { key: 'np',     attr: 'np', out: '',   prefix: 'bg',        what: 'the Now Playing window',
    root: () => CONFIG.nowplaying,   save: (p) => saveNp(p) },
  { key: 'lyrics', attr: 'ly', out: 'ly', prefix: 'bg_own',    what: 'the lyrics window',
    root: () => CONFIG.lyrics || {}, save: (p) => saveLy(p) },
  { key: 'queue',  attr: 'q',  out: 'q',  prefix: 'bg_own',    what: 'the queue window',
    root: () => CONFIG.queue || {},  save: (p) => saveQ(p) },
  { key: 'captions', attr: 'cap', out: 'cap', prefix: 'bg_own', what: 'the captions window',
    root: () => CONFIG.captions || {}, save: (p) => saveCap(p) },
  { key: 'app',    attr: 'ui', out: 'u',  prefix: 'wallpaper', what: 'the app window',
    root: () => CONFIG.ui,           save: (p) => saveUi(p) },
];
const bgTarget = (key) => BG_TARGETS.find((t) => t.key === key) || BG_TARGETS[0];

/* The same windows the backgrounds use, minus the app - which has no transport
   to drive. Declared here rather than above because it reads BG_TARGETS. */
const CONTROL_TARGETS = BG_TARGETS.filter((t) => t.key !== 'app' && t.key !== 'captions');
let bgTargetKey = 'np';

/** The background block for one target, whatever it is called in that config. */
function bgOf(t) { return getPath(t.root(), t.prefix) || {}; }

function bgEditorHTML(t) {
  const a = t.attr, p = t.prefix, o = t.out;
  const D = (path) => `data-${a}="${p}.${path}"`;         // the control itself
  const O = (path) => `data-${o}out="${p}.${path}"`;      // its live readout
  const isApp = t.key === 'app';
  const window_ = t.key === 'lyrics' || t.key === 'queue' || t.key === 'captions';

  // For the app, "solid" means no wallpaper at all - its own background color
  // shows through - so there is no second color control competing with it.
  const modes = [['solid', isApp ? 'None' : 'Solid'], ['gradient', 'Gradient'],
                 ['scene', 'Artwork'], ['image', 'Image']];
  // Only the pop-out has a cover to use as its own background.
  if (t.key === 'np') modes.push(['art', 'Album art']);

  return `
    ${window_ ? `<p class="hint">Used when this window is not matching the Now Playing window.
        <label class="check inline"><input type="checkbox" data-${a}="follow_theme" data-kind="bool">
        <span>Use the same background as Now Playing</span></label></p>` : ''}
    ${isApp ? `<p class="hint">Sits behind the whole control room. Its flat color
        comes from <b>App look \u2192 Background</b>; this is what goes on top.</p>` : ''}

    <label class="field">
      <span>Background</span>
      <div class="segmented small" ${D('mode')} data-kind="seg">
        ${modes.map(([v, l]) => `<button data-v="${v}">${l}</button>`).join('')}
      </div>
    </label>
    <div class="bg-when" data-when="art">
      <p class="hint">The cover of whatever is playing becomes the background, and
        the text and accent colors are taken from it so they stay readable as the
        art changes. Darken it below if the words get lost.</p>
      <label class="field">
        <span>Darken <b class="mono" ${O('dim')}>0.45</b></span>
        <input class="range" type="range" min="0" max="90" data-div="100" data-dp="2"
               ${D('dim')} data-kind="range" ${O('dim')}>
      </label>
    </div>

    <div class="bg-when" data-when="solid gradient">
    <div class="field two">
      <label><span>${isApp ? 'Gradient from' : 'Color'}</span>
        <input class="color wide" type="color" ${D('color')} data-kind="color"></label>
      <label><span>${isApp ? 'Gradient to' : 'Second color'}</span>
        <input class="color wide" type="color" ${D('color2')} data-kind="color"></label>
    </div>
    <label class="field">
      <span>Gradient angle <b class="mono" ${O('angle')}>135</b>\u00b0</span>
      <input class="range" type="range" min="0" max="360" ${D('angle')} data-kind="range" ${O('angle')}>
    </label>
    </div>

    <div class="bg-when" data-when="scene">
    <div class="divider"></div>

    <label class="field">
      <span>Customizable artwork</span>
      <div class="scene-picker" data-scenes="${t.key}"></div>
    </label>
    <div class="field two">
      <label><span>Base</span>
        <input class="color wide" type="color" ${D('scene.c1')} data-kind="color"></label>
      <label><span>Ink</span>
        <input class="color wide" type="color" ${D('scene.c2')} data-kind="color"></label>
    </div>
    <div class="field two">
      <label><span>Detail</span>
        <input class="color wide" type="color" ${D('scene.c3')} data-kind="color"></label>
      <label><span>&nbsp;</span>
        <button class="btn btn-ghost btn-sm" data-bgact="sceneReset">Scene's own colors</button></label>
    </div>
    <label class="field">
      <span>Motif size <b class="mono" ${O('scene.scale')}>1.00</b></span>
      <input class="range" type="range" min="40" max="220" data-div="100" data-dp="2"
             ${D('scene.scale')} data-kind="range" ${O('scene.scale')}>
    </label>
    <label class="field">
      <span>Density <b class="mono" ${O('scene.density')}>1.00</b></span>
      <input class="range" type="range" min="30" max="250" data-div="100" data-dp="2"
             ${D('scene.density')} data-kind="range" ${O('scene.density')}>
    </label>
    <label class="field">
      <span>Tile size <b class="mono" ${O('scene.tile_scale')}>1.00</b></span>
      <input class="range" type="range" min="35" max="250" data-div="100" data-dp="2"
             ${D('scene.tile_scale')} data-kind="range" ${O('scene.tile_scale')}>
    </label>
    <div class="row gap wrap">
      <button class="btn btn-ghost btn-sm" data-bgact="sceneShuffle">Shuffle layout</button>
    </div>
    </div>

    <div class="bg-when" data-when="image">
    <div class="divider"></div>

    <label class="field">
      <span>Picture</span>
      <div class="asset-picker" data-assets="${t.key}"></div>
    </label>
    <div class="row gap wrap">
      <button class="btn btn-ghost btn-sm" data-bgact="upload">Upload image\u2026</button>
      <button class="btn btn-ghost btn-sm" data-bgact="frame">Frame it…</button>
      <button class="btn btn-ghost btn-sm" data-bgact="theme">Theme from this</button>
      <button class="btn btn-ghost btn-sm" data-bgact="clearImage">Clear image</button>
    </div>

    <label class="field">
      <span>Color beneath the picture</span>
      <div class="row gap">
        <input class="color" type="color" ${isApp ? 'data-ui="bg"' : D('color')} data-kind="color">
        <span class="hint">Shows wherever the picture does not reach, and through
          anything transparent in it.</span>
      </div>
    </label>

    <label class="field">
      <span>Fit</span>
      <select class="input" ${D('fit')} data-kind="str">
        <option value="cover">Cover</option>
        <option value="contain">Contain</option>
        <option value="stretch">Stretch</option>
        <option value="tile">Tile</option>
      </select>
    </label>

    <label class="field">
      <span>Recolor the picture</span>
      <label class="check"><input type="checkbox" ${D('tint.on')} data-kind="bool">
        <span>Print it in two colors</span></label>
      <span class="hint">The picture keeps its light and shade; you choose the ink.
        A photograph becomes something that matches your theme instead of fighting it.</span>
    </label>
    <div class="field two">
      <label><span>Primary ink</span>
        <input class="color wide" type="color" ${D('tint.c1')} data-kind="color"></label>
      <label><span>Secondary ink</span>
        <input class="color wide" type="color" ${D('tint.c2')} data-kind="color"></label>
    </div>
    <label class="field">
      <span>Ink angle <b class="mono" ${O('tint.angle')}>135</b>°</span>
      <input class="range" type="range" min="0" max="360"
             ${D('tint.angle')} data-kind="range" ${O('tint.angle')}>
    </label>
    <label class="field">
      <span>How strong <b class="mono" ${O('tint.strength')}>1.00</b></span>
      <input class="range" type="range" min="0" max="100" data-div="100" data-dp="2"
             ${D('tint.strength')} data-kind="range" ${O('tint.strength')}>
    </label>
    </div>

    <div class="bg-when" data-when="scene image">

    <div class="field two">
      <label><span>Across <b class="mono" ${O('pos_x')}>50</b>%</span>
        <input class="range" type="range" min="0" max="100" ${D('pos_x')} data-kind="range" ${O('pos_x')}></label>
      <label><span>Down <b class="mono" ${O('pos_y')}>50</b>%</span>
        <input class="range" type="range" min="0" max="100" ${D('pos_y')} data-kind="range" ${O('pos_y')}></label>
    </div>
    <p class="hint">Which part of the picture shows. Each target keeps its own,
      so one wide image can be framed differently in each.</p>

    <label class="field">
      <span>Blur <b class="mono" ${O('blur')}>0</b>px</span>
      <input class="range" type="range" min="0" max="40" ${D('blur')} data-kind="range" ${O('blur')}>
    </label>
    <label class="field">
      <span>Darken <b class="mono" ${O('dim')}>0.00</b></span>
      <input class="range" type="range" min="0" max="90" data-div="100" data-dp="2"
             ${D('dim')} data-kind="range" ${O('dim')}>
    </label>
    </div>`;
}

function buildBackgroundEditors() {
  $('bgEditors').innerHTML = BG_TARGETS.map((t) =>
    `<div class="bg-editor" data-bg="${t.key}"${t.key === bgTargetKey ? '' : ' hidden'}>` +
    bgEditorHTML(t) + '</div>').join('');
}

/* Drop a target's picture. Also drops it out of image mode - otherwise the
   surface is left asking for a picture that is not there, which renders as
   nothing at all. */
function clearPicture(t) {
  t.save({ [t.prefix + '.image']: '', [t.prefix + '.mode']: 'solid' });
  syncControls();
  renderPickers();
}

/* Open the framing dialog on one target's picture and write back what it
   decides. Both the Background tab's button and the theme gallery's want
   exactly this. */
function frameTarget(t, noPicture) {
  const bg = bgOf(t);
  if (!bg.image) { toast(noPicture); return; }
  const size = bgTargetSize(t);
  openFramer({
    image: bg.image, width: size.w, height: size.h,
    zoom: bg.zoom, pos_x: bg.pos_x, pos_y: bg.pos_y, fit: bg.fit,
    title: 'Framing for ' + size.label,
    onApply: (out) => {
      t.save({ [t.prefix + '.pos_x']: out.pos_x, [t.prefix + '.pos_y']: out.pos_y,
               [t.prefix + '.zoom']: out.zoom });
      syncControls();
    },
  });
}

/* The shape the framing dialog should cut to: the window this background is
   going into, or the deck's own window for the app's wallpaper. */
function bgTargetSize(t) {
  if (t.key === 'app') {
    return { w: Math.round(window.innerWidth), h: Math.round(window.innerHeight),
             label: t.what };
  }
  const cfg = t.root() || {};
  return { w: cfg.width || 760, h: cfg.height || 190, label: t.what };
}

/* Dress the whole app from the colors in one picture, and put the picture
   itself behind the window you are theming - a theme taken from a photograph
   you cannot see is just a set of colors from nowhere. */
function applyPictureTheme(assetId, targetKey) {
  toast('Reading the colors…');
  paletteFor(assetId).then((th) => {
    if (!th) { toast('Could not read that picture'); return; }

    saveUi({ accent: th.accent, bg: th.bg, panel: th.panel, border: th.line,
             text: th.text, muted: th.muted, preset: '' });
    saveNp({
      'accent': th.accent,
      'palette.text': th.text, 'palette.muted': th.muted, 'palette.line': th.line,
      // Hand the per-element colors back so the palette actually governs.
      'text.title_color': '', 'text.artist_color': '', 'text.label_color': '',
      'card.border_color': '', 'progress.color': '', 'decor.color': '',
      'surround.color': th.surround,
      'bg.color': th.bg, 'bg.color2': th.panel,
      // No automatic shadow: the darkening veil already guarantees the text
      // clears the picture, and a shadow nobody asked for is a shadow nobody
      // can find the switch for. The slider is in the Text tab if you want one.
    });

    // The picture goes behind whichever surface you were pointing at, exactly
    // as it is: no blur, no darkening, nothing two-colored. You came here for
    // that picture, so you get that picture - the tools underneath are there
    // when you want to change it, and the shadow above keeps the text legible
    // without touching the image itself.
    const t = bgTarget(targetKey || bgTargetKey);
    const P = (k) => t.prefix + '.' + k;
    t.save({
      [P('mode')]: 'image', [P('image')]: assetId,
      [P('dim')]: 0, [P('blur')]: 0, [P('zoom')]: 1,
      [P('pos_x')]: 50, [P('pos_y')]: 50, [P('tint.on')]: false,
      // The app's under-picture color is ui.bg - which saveUi above already
      // set - so writing wallpaper.color here would only disagree with the
      // editor, which binds ui.bg for that target.
      ...(t.key === 'app' ? {} : { [P('color')]: th.bg }),
    });
    // What the darkening would have to be for the text to clear 3:1 against
    // this picture's worst patch. Offered, not imposed.
    suggestedVeil = th.veil;

    CONFIG.theme = '';
    syncControls();
    renderPictureThemes();
    renderPickers();
    const c = th.contrast || {};
    toast(`Theme from the picture · text ${c.text || '?'}:1`);
  });
}

/* A theme per picture, worked out from the picture itself.

   Reading a picture's colors means fetching it whole and scanning its
   pixels, and the shipped set alone is 13 MB. Doing all of that while the deck
   is still starting makes for a slow start, so the swatches are filled when
   the browser is idle rather than all at once while the deck is starting. */
function renderPictureThemes() {
  const box = $('pictureThemes');
  if (!box) return;
  box.innerHTML = ASSETS.map((a) => `
    <button class="pt" data-id="${esc(a.id)}" title="Theme from ${esc(a.name || a.id)}">
      <img src="${esc(a.url)}" alt="" loading="lazy">
      <span class="pt-swatches"></span>
    </button>`).join('');

  // Read them while the browser has nothing better to do, a couple at a time.
  // Doing all twenty up front is what made startup slow; doing them on scroll
  // would be tidier still, but IntersectionObserver does not fire reliably in
  // the embedded Chrome these windows run in, and a swatch that never appears
  // is worse than one that appears a moment late.
  const pending = [...box.querySelectorAll('.pt')];
  const idle = window.requestIdleCallback || ((fn) => setTimeout(() => fn({ timeRemaining: () => 8 }), 60));
  const step = (deadline) => {
    while (pending.length && (deadline.timeRemaining() > 4 || deadline.didTimeout)) {
      fillPictureTheme(pending.shift());
    }
    if (pending.length) idle(step, { timeout: 500 });
  };
  idle(step, { timeout: 500 });
}

/** Read one picture's colors and show them on its swatch strip. */
function fillPictureTheme(btn) {
  paletteFor(btn.dataset.id).then((th) => {
    if (!th) { btn.classList.add('pt-bad'); return; }
    btn.querySelector('.pt-swatches').innerHTML =
      th.swatches.slice(0, 5).map((c) => `<i style="background:${esc(c)}"></i>`).join('');
    btn.style.setProperty('--pt-accent', th.accent);
  });
}

$('pictureThemes').addEventListener('click', (e) => {
  const btn = e.target.closest('.pt');
  if (btn) applyPictureTheme(btn.dataset.id);
});

/* Having just put a picture behind a window, the next thing you want is to
   frame it and settle how far back it sits - so those controls live here
   rather than a tab away. They act on whichever surface the theme went to. */
function ptTarget() { return bgTarget(bgTargetKey); }

/* The darkening that would guarantee readable text over the current picture.
   Worked out when the theme is applied, then offered as a button. */
let suggestedVeil = 0;

function syncPictureTools() {
  const tools = $('ptTools');
  if (!tools || !CONFIG) return;
  const t = ptTarget(), bg = bgOf(t);
  const on = !!bg.image;
  tools.hidden = !on;
  if (!on) return;
  $('ptWhere').textContent = bgTargetSize(t).label;
  $('ptBlur').value = String(bg.blur ?? 0);
  $('ptDim').value = String(Math.round((bg.dim ?? 0) * 100));
  $('ptBlurOut').textContent = String(bg.blur ?? 0);
  $('ptDimOut').textContent = (bg.dim ?? 0).toFixed(2);
  $('ptTint').checked = !!(bg.tint || {}).on;

  // Only worth offering while the picture is still light enough to fight the
  // text, and only if it would actually change anything.
  const gap = suggestedVeil - (bg.dim ?? 0);
  $('ptSafe').hidden = !(suggestedVeil > 0 && gap > 0.04);
  $('ptSafeVal').textContent = suggestedVeil.toFixed(2);
}

$('ptFrame').addEventListener('click', () =>
  frameTarget(ptTarget(), 'Pick a picture theme first'));
$('ptBlur').addEventListener('input', () => {
  const t = ptTarget();
  $('ptBlurOut').textContent = $('ptBlur').value;
  t.save({ [t.prefix + '.blur']: +$('ptBlur').value });
});
$('ptDim').addEventListener('input', () => {
  const v = +$('ptDim').value / 100;
  $('ptDimOut').textContent = v.toFixed(2);
  ptTarget().save({ [ptTarget().prefix + '.dim']: v });
});
$('ptTint').addEventListener('change', () => {
  const t = ptTarget();
  t.save({ [t.prefix + '.tint.on']: $('ptTint').checked });
  syncControls();
});
$('ptSafe').addEventListener('click', () => {
  const t = ptTarget();
  $('ptDim').value = String(Math.round(suggestedVeil * 100));
  $('ptDimOut').textContent = suggestedVeil.toFixed(2);
  t.save({ [t.prefix + '.dim']: suggestedVeil });
  syncControls();
});

$('ptClear').addEventListener('click', () => clearPicture(ptTarget()));

/* Show only the controls that do something for the mode you are in.
   Leaving the artwork sliders sitting there after you have chosen a picture
   makes them look broken, and leaving the old scene highlighted makes it look
   like it is still in use. */
function syncBgSections() {
  if (!CONFIG) return;
  for (const t of BG_TARGETS) {
    const editor = document.querySelector(`.bg-editor[data-bg="${t.key}"]`);
    if (!editor) continue;
    const bg = bgOf(t);
    const mode = bg.mode || 'solid';
    editor.dataset.mode = mode;
    editor.querySelectorAll('.bg-when').forEach((sec) => {
      sec.hidden = !sec.dataset.when.split(' ').includes(mode);
    });
    // A highlight means "this is what you are looking at". Only one of these
    // can be true at a time.
    editor.querySelectorAll('[data-scenes] .scene-thumb').forEach((n) =>
      n.classList.toggle('on', mode === 'scene' && n.dataset.id === (bg.scene || {}).id));
    editor.querySelectorAll('[data-assets] .asset').forEach((n) =>
      n.classList.toggle('on', mode === 'image' && n.dataset.id === bg.image));
  }
  // And in the gallery, mark the picture actually in use.
  const cur = bgOf(bgTarget(bgTargetKey));
  document.querySelectorAll('#pictureThemes .pt').forEach((n) =>
    n.classList.toggle('on', cur.mode === 'image' && n.dataset.id === cur.image));
}

function selectBgTarget(key) {
  bgTargetKey = bgTarget(key).key;
  document.querySelectorAll('#bgTargets button').forEach((b) =>
    b.classList.toggle('on', b.dataset.t === bgTargetKey));
  document.querySelectorAll('.bg-editor').forEach((el) =>
    { el.hidden = el.dataset.bg !== bgTargetKey; });
}

$('bgTargets').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-t]');
  if (b) selectBgTarget(b.dataset.t);
});

/* One set of handlers for all four editors: the target is whichever editor the
   click happened inside. */
$('bgEditors').addEventListener('click', (e) => {
  const editor = e.target.closest('.bg-editor');
  if (!editor) return;
  const t = bgTarget(editor.dataset.bg);
  const P = (k) => t.prefix + '.' + k;

  const thumb = e.target.closest('.scene-thumb');
  if (thumb) {
    t.save({ [P('mode')]: 'scene', [P('scene.id')]: thumb.dataset.id });
    syncControls();
    renderScenePickers();
    return;
  }
  const del = e.target.closest('[data-del]');
  if (del) {
    post('/api/assets/delete', { id: del.dataset.del }).then((d) => {
      ASSETS = d.assets || [];
      renderPickers();
    });
    return;
  }
  const cellEl = e.target.closest('.asset');
  if (cellEl) {
    t.save({ [P('mode')]: 'image', [P('image')]: cellEl.dataset.id });
    syncControls();
    renderPickers();
    return;
  }
  const act = e.target.closest('[data-bgact]');
  if (!act) return;
  if (act.dataset.bgact === 'sceneReset') {
    t.save({ [P('scene.c1')]: '', [P('scene.c2')]: '', [P('scene.c3')]: '' });
    syncSceneColors();
  } else if (act.dataset.bgact === 'sceneShuffle') {
    t.save({ [P('scene.seed')]: Math.floor(Math.random() * 9999) + 1 });
    // A reshuffle changes the whole picture, so nudge the live windows rather
    // than waiting for them to notice.
    setTimeout(() => { pushPreview(); healWindows(); }, 250);
  } else if (act.dataset.bgact === 'upload') {
    openPicker('bg:' + t.key);
  } else if (act.dataset.bgact === 'clearImage') {
    clearPicture(t);
  } else if (act.dataset.bgact === 'frame') {
    frameTarget(t, 'Pick a picture first');
  } else if (act.dataset.bgact === 'theme') {
    const bg = bgOf(t);
    if (!bg.image) { toast('Pick a picture first'); return; }
    applyPictureTheme(bg.image, t.key);
  }
});

/* ------------------------------------------------------------- scene pickers */

function renderScenePickers() {
  if (!CONFIG) return;
  for (const t of BG_TARGETS) {
    const container = document.querySelector(`[data-scenes="${t.key}"]`);
    if (!container) continue;
    const current = (bgOf(t).scene || {}).id;
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
  }
  syncSceneColors();
}

/* Blank scene colors mean "use the scene's own", so show those in the pickers. */
function syncSceneColors() {
  for (const t of BG_TARGETS) {
    const cfg = bgOf(t).scene || {};
    const def = (SCENES[cfg.id] || SCENES.watercolor).defaults;
    for (const k of ['c1', 'c2', 'c3']) {
      const node = document.querySelector(`[data-${t.attr}="${t.prefix}.scene.${k}"]`);
      if (node) node.value = cfg[k] || def[k];
    }
  }
}

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
          'wallpaper.mode': 'scene', 'wallpaper.dim': 0.35,
          'wallpaper.image': '', 'wallpaper.scene.id': 'embers',
          'wallpaper.scene.c1': '', 'wallpaper.scene.c2': '', 'wallpaper.scene.c3': '' },
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
          'wallpaper.mode': 'scene', 'wallpaper.dim': 0,
          'wallpaper.image': '', 'wallpaper.scene.id': 'watercolor',
          'wallpaper.scene.c1': '', 'wallpaper.scene.c2': '', 'wallpaper.scene.c3': '' },
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
          'wallpaper.mode': 'scene', 'wallpaper.dim': 0,
          'wallpaper.image': '', 'wallpaper.scene.id': 'sakura',
          'wallpaper.scene.c1': '', 'wallpaper.scene.c2': '', 'wallpaper.scene.c3': '' },
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
          'wallpaper.mode': 'scene', 'wallpaper.dim': 0,
          'wallpaper.image': '', 'wallpaper.scene.id': 'doodle',
          'wallpaper.scene.c1': '', 'wallpaper.scene.c2': '', 'wallpaper.scene.c3': '' },
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
          'wallpaper.mode': 'scene', 'wallpaper.dim': 0.25,
          'wallpaper.image': '', 'wallpaper.scene.id': 'moon',
          'wallpaper.scene.c1': '', 'wallpaper.scene.c2': '', 'wallpaper.scene.c3': '' },
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
   a color the user picked by hand earlier cannot survive into the new theme
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
  'glow': false,
  'wallpaper.mode': 'solid', 'wallpaper.image': '', 'wallpaper.dim': 0,
  'wallpaper.color': '#000000', 'wallpaper.color2': '#241a3d', 'wallpaper.angle': 135,
  'wallpaper.fit': 'cover', 'wallpaper.blur': 0, 'wallpaper.pos_x': 50, 'wallpaper.pos_y': 50,
  'wallpaper.scene.id': '', 'wallpaper.scene.c1': '', 'wallpaper.scene.c2': '',
  'wallpaper.scene.c3': '', 'wallpaper.scene.scale': 1, 'wallpaper.scene.density': 1,
  'wallpaper.scene.tile_scale': 1,
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

  // A theme is meant to dress the whole rig, not just the pop-out. The other
  // two windows read the palette live from the pop-out already, but their
  // background is their own - so translate the theme's background onto each and
  // point them back at it, or picking a theme would change their text color
  // while leaving a stale picture behind (which is exactly what looked broken).
  const ownBg = {};
  for (const [k, v] of Object.entries(np)) {
    if (k.startsWith('bg.')) ownBg['bg_own.' + k.slice(3)] = v;
  }
  ownBg.follow_theme = false;      // show their own copy of the theme's look
  saveLy(ownBg);
  saveQ(ownBg);
  saveCap(ownBg);

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
  if (capOpen) post('/api/captions/window/heal');
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

/* Fonts people add themselves: families from the broadcast, files from
   /api/fonts. Every font menu offers them first, and the windows that can
   inherit Now Playing's font offer that as their first choice. */
let USER_FONTS = [];
let FONT_FILES = [];
const FONT_EXT = /\.(ttf|otf|woff2?)$/i;
const byName = (a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0);
const familiesOf = (files) => [...new Set(files.map((f) => f.family))].sort(byName);

function fontOptions(inherit) {
  const opt = (f) => `<option value="${esc(f)}" style="font-family:'${esc(f)}'">${esc(f)}</option>`;
  let html = inherit ? '<option value="">Same as Now Playing</option>' : '';
  if (USER_FONTS.length) html += `<optgroup label="Your fonts">${USER_FONTS.map(opt).join('')}</optgroup>`;
  return html + `<optgroup label="Windows fonts">${FONTS.map(opt).join('')}</optgroup>`;
}

function fillFonts() {
  document.querySelectorAll('select.font-select').forEach((sel) => {
    const keep = sel.value;
    sel.innerHTML = fontOptions(sel.dataset.inherit === '1');
    writeControl(sel, 'str', keep);
  });
  // One chip per added family, under every font menu, each able to remove it.
  const html = USER_FONTS.map((fam) =>
    `<span class="font-chip" style="font-family:'${esc(fam)}', var(--font)">${esc(fam)}` +
    `<button type="button" class="font-chip-x" data-font-del="${esc(fam)}" title="Remove ${esc(fam)}" aria-label="Remove ${esc(fam)}"></button></span>`).join('');
  document.querySelectorAll('.font-chips').forEach((el) => { el.innerHTML = html; el.hidden = !html; });
}

function readDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* Add font files; the menu the button sat next to switches to the new one. */
async function addFonts(files, target) {
  let added = null;
  for (const file of files.filter((f) => FONT_EXT.test(f.name))) {
    let data;
    try { data = await readDataURL(file); } catch (_) { toast('Could not read ' + file.name); continue; }
    const res = await post('/api/fonts/upload', { name: file.name, data });
    if (!res || !res.ok) { toast((res && res.reason) || 'Could not add that font'); continue; }
    FONT_FILES = res.fonts || FONT_FILES;
    added = res.family;
  }
  if (!added) return false;
  USER_FONTS = familiesOf(FONT_FILES);
  fillFonts();
  if (target) {
    target.value = added;
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }
  toast(`Added “${added}” — it's in every Font menu now`);
  return true;
}

async function removeFontFamily(fam) {
  const files = FONT_FILES.filter((f) => f.family === fam);
  if (!files.length) return;
  if (!confirm(`Remove the font “${fam}”? Anything using it goes back to the default font.`)) return;
  let res = null;
  for (const f of files) res = await post('/api/fonts/delete', { id: f.id });
  FONT_FILES = (res && res.fonts) || FONT_FILES.filter((f) => f.family !== fam);
  USER_FONTS = familiesOf(FONT_FILES);
  fillFonts();
}

let fontAddTarget = null;
document.addEventListener('click', (e) => {
  const add = e.target.closest('.font-add');
  if (add) {
    fontAddTarget = add.closest('.field').querySelector('select.font-select');
    $('fontFile').click();
    return;
  }
  const del = e.target.closest('[data-font-del]');
  if (del) removeFontFamily(del.dataset.fontDel);
});
$('fontFile').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  await addFonts(files, fontAddTarget);
  fontAddTarget = null;
});

/* Font files dropped anywhere on the deck are added; anything else dropped
   outside the preview is swallowed rather than opening the file in place of
   the app. */
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files || [])].filter((f) => FONT_EXT.test(f.name));
  if (files.length) addFonts(files, null);
});

/* The broadcast carries the families and a version: reload the sheet, and
   refresh the menus when the set itself changed (another window added one). */
function syncFontsState(state) {
  syncUserFonts(state.fonts_v);
  const fams = state.fonts || [];
  if (fams.join('\n') === USER_FONTS.join('\n')) return;
  USER_FONTS = fams.slice();
  fetch('/api/fonts').then((r) => r.json())
    .then((d) => { FONT_FILES = d.fonts || []; fillFonts(); })
    .catch(() => fillFonts());
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
  else {
    // A menu whose saved choice is not on offer any more (a removed font, an
    // unplugged microphone) says so, instead of silently showing another one.
    if (node.tagName === 'SELECT' && value && ![...node.options].some((o) => o.value === value)) {
      node.add(new Option(`${value} (not available)`, value));
    }
    node.value = value ?? '';
  }
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
  { attr: 'cap', out: 'cap', root: () => CONFIG.captions || {}, save: (p) => saveCap(p) },
  { attr: 'fr', out: 'fr', root: () => CONFIG[frameKey()] || {}, save: (p) => saveFrame(p) },
];
const scopeOf = (node) => SCOPES.find((sc) => node.hasAttribute('data-' + sc.attr));

function bindControls() {
  document.querySelectorAll('[data-np],[data-ui],[data-ly],[data-q],[data-cap],[data-fr]').forEach((node) => {
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
          // Changing a background mode changes which controls apply.
          if (path.endsWith('.mode')) syncBgSections();
        });
      });
      return;
    }

    // data-commit="change" saves a text field once, when you are done with it,
    // for settings where every keystroke would restart something.
    const event = node.dataset.commit ||
      ((kind === 'range' || node.type === 'color' || node.type === 'text') ? 'input' : 'change');
    node.addEventListener(event, () => {
      if (kind === 'range') showOut(scope.out, path, node);
      save({ [path]: readControl(node, kind) });
    });
  });

  const SAVE_BY_SCOPE = { np: saveNp, ui: saveUi, ly: saveLy, q: saveQ, cap: saveCap, fr: saveFrame };
  document.querySelectorAll('[data-clear]').forEach((btn) => {
    btn.addEventListener('click', () => {
      (SAVE_BY_SCOPE[btn.dataset.scope || 'np'])({ [btn.dataset.clear]: '' });
      syncControls();
    });
  });
}

function syncControls() {
  document.querySelectorAll('[data-np],[data-ui],[data-ly],[data-q],[data-cap],[data-fr]').forEach((node) => {
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

  syncPictureTools();
  syncBgSections();
  paintCornerPick();
  const ly = CONFIG.lyrics || {};
  if (ly.width) $('lyWidth').value = ly.width;
  if (ly.height) $('lyHeight').value = ly.height;
  const qc = CONFIG.queue || {};
  if (qc.width) $('qWidth').value = qc.width;
  if (qc.height) $('qHeight').value = qc.height;
  const cp = CONFIG.captions || {};
  if (cp.width) $('capWidth').value = cp.width;
  if (cp.height) $('capHeight').value = cp.height;

  $('width').value = CONFIG.nowplaying.width;
  $('height').value = CONFIG.nowplaying.height;
  $('borderless').checked = !!CONFIG.nowplaying.borderless;
  $('topmost').checked = !!CONFIG.nowplaying.topmost;

  document.querySelectorAll('#sourceMode button').forEach((b) =>
    b.classList.toggle('on', b.dataset.mode === CONFIG.source_mode));

  // Spotify account controls that are not data-* bound.
  const spCfg = CONFIG.spotify || {};
  if (document.activeElement !== $('spUseAccount'))
    $('spUseAccount').checked = spCfg.use_account !== false;
  if (document.activeElement !== $('spClientId2') && !$('spClientId2').value)
    $('spClientId2').value = spCfg.client_id || '';

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
      captions_cfg: CONFIG.captions,
    }, '*');
  } catch (_) { /* iframe still loading */ }
  tellPreviewUltra();
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
    // Tinting draws the sticker through a CSS mask, and a mask only ever uses
    // the first frame - so say so rather than letting a GIF quietly freeze.
    const asset = ASSETS.find((a) => a.id === st.asset) || {};
    $('stickerTintNote').hidden = !asset.animated;
    $('stickerColor').value = /^#[0-9a-f]{6}$/i.test(st.color || '') ? st.color : '#ffffff';
    $('stickerPicker').innerHTML = ASSETS.map((a) => `
      <div class="asset ${a.id === st.asset ? 'on' : ''}" data-id="${esc(a.id)}"
           title="${esc(a.name || a.id)}${a.animated ? ' · animated' : ''}">
        <img src="${esc(a.url)}" alt="" loading="lazy">
        ${a.animated ? '<span class="anim">GIF</span>' : ''}
      </div>`).join('');
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
  const cell = (a) => `
    <div class="asset ${a.builtin ? 'builtin' : ''}" data-id="${esc(a.id)}"
         title="${esc(a.name || a.id)}${a.animated ? ' · animated' : ''}${a.builtin ? ' (built in)' : ' · ' + Math.round((a.size || 0) / 1024) + ' KB'}">
      <img src="${esc(a.url)}" alt="" loading="lazy">
      ${a.animated ? '<span class="anim">GIF</span>' : ''}
      ${a.builtin ? '' : `<button class="del" data-del="${esc(a.id)}" title="Delete">×</button>`}
    </div>`;
  for (const t of BG_TARGETS) {
    const container = document.querySelector(`[data-assets="${t.key}"]`);
    if (container) container.innerHTML = ASSETS.map((a) => cell(a)).join('');
  }
  renderPictureThemes();
  syncBgSections();          // the one owner of which cell reads as selected
}


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
  // "bg:<target>" comes from one of the generated background editors.
  if (String(pickerTarget).startsWith('bg:')) {
    const t = bgTarget(pickerTarget.slice(3));
    t.save({ [t.prefix + '.image']: id, [t.prefix + '.mode']: 'image' });
    syncControls();
  } else {
    addSticker(id);
  }
  renderPickers();
});
const openPicker = (target) => { pickerTarget = target; $('filePicker').click(); };
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
    const dropped = [...(e.dataTransfer?.files || [])];
    // A font dropped here is added like anywhere else on the deck.
    const fontFiles = dropped.filter((f) => FONT_EXT.test(f.name));
    if (fontFiles.length) { addFonts(fontFiles, null); return; }
    const files = dropped.filter((f) => f.type.startsWith('image/'));
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
      const t = bgTarget(selectedWin);
      t.save({ [t.prefix + '.image']: id, [t.prefix + '.mode']: 'image',
               follow_theme: false });
      syncControls();
      renderPickers();
      toast('Background set for ' + t.what);
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
  // Warn before a preset paints over colors the streamer has set by hand.
  const hasLocal = LOCAL_COLOR_KEYS.some((k) => {
    const v = getPath(CONFIG.nowplaying, k);
    return v !== undefined && v !== null && v !== '';
  });
  if (hasLocal && !confirm('Apply this look? It replaces the colors you set for this window.')) {
    $('preset').value = CONFIG.nowplaying.preset || '';
    return;
  }
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
$('resetColors').addEventListener('click', () => {
  const blanks = {};
  for (const k of LOCAL_COLOR_KEYS) blanks[k] = '';
  saveNp(blanks);
  syncControls();
  toast('Colors handed back to the theme');
});

$('surroundMatch').addEventListener('click', () => {
  const bg = CONFIG.nowplaying.bg || {};
  let color = bg.color || '#0f0f17';
  if (bg.mode === 'scene' && bg.scene && SCENES[bg.scene.id]) {
    color = renderScene(bg.scene.id, sceneParams(bg.scene)).base;
  }
  if (!/^#[0-9a-f]{6}$/i.test(color)) {
    toast('That background has no single color to match');
    return;
  }
  saveNp({ 'surround.color': color, 'surround.mode': 'solid' });
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

audio.addEventListener('play', () => { $('playpause').innerHTML = svgIcon('pause'); report(); });
audio.addEventListener('pause', () => { $('playpause').innerHTML = svgIcon('play'); report(); });
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
    cardTick();
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
let lastSeekId = null, lastCmdId = null;
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

  $('playpause').innerHTML = svgIcon(now.playing ? 'pause' : 'play');
  // Only re-seat the clock on a real jump, so the bar does not stutter.
  const drift = Math.abs(cardClock.position - (now.position || 0));
  if (drift > 1.2 || cardClock.playing !== !!now.playing ||
      cardClock.duration !== (now.duration || 0)) {
    cardClock = { position: now.position || 0, duration: now.duration || 0,
                  playing: !!now.playing, at: performance.now() };
  }
  cardTick();
}

/* A local file drives the bar from <audio>; anything else runs on this clock. */
/* It wakes when the time label or the slider would actually change - not on
   every frame - and not at all while paused or while you drag the slider. */
let cardTimer = null;
function cardTick() {
  clearTimeout(cardTimer);
  if (cardSource === 'local' || seeking) return;
  let pos = cardClock.position;
  if (cardClock.playing) pos += (performance.now() - cardClock.at) / 1000;
  const dur = cardClock.duration;
  if (dur > 0) pos = Math.min(pos, dur);
  const elapsed = fmt(pos), total = fmt(dur);
  const value = String(dur > 0 ? Math.round((pos / dur) * 1000) : 0);
  if ($('deckElapsed').textContent !== elapsed) $('deckElapsed').textContent = elapsed;
  if ($('deckDuration').textContent !== total) $('deckDuration').textContent = total;
  if ($('seek').value !== value) $('seek').value = value;
  if (!cardClock.playing || !(dur > 0) || pos >= dur) return;
  const toSecond = (1 - (pos % 1)) * 1000 + 10;
  const toStep = dur;                       // one 1/1000 slider step, in ms
  cardTimer = setTimeout(cardTick, Math.max(100, isUltra() ? toSecond : Math.min(toSecond, toStep)));
}
cardTick();

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
    else if (res.reason !== 'canceled') toast('Could not add that folder');
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
  $('repeat').innerHTML = svgIcon(repeat === 'one' ? 'repeatOne' : 'repeat');
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
    page: 'nowplaying.html', size: 'npSize', label: 'Now Playing',
    title: 'This is what the window looks like',
    cfg: () => (CONFIG || {}).nowplaying,
  },
  lyrics: {
    page: 'lyrics.html', size: 'lySize', label: 'Lyrics',
    title: 'This is what the lyrics window looks like',
    cfg: () => (CONFIG || {}).lyrics,
  },
  queue: {
    page: 'queue.html', size: 'qSize', label: 'Queue',
    title: 'This is what the queue window looks like',
    cfg: () => (CONFIG || {}).queue,
  },
  captions: {
    page: 'captions.html', size: 'capSize', label: 'Captions',
    title: 'This is what the captions window looks like',
    cfg: () => (CONFIG || {}).captions,
  },
  screenframe: {
    page: 'frame.html?kind=screen', label: 'Screen frame',
    title: 'This is what the screen frame looks like',
    cfg: () => (CONFIG || {}).screenframe,
  },
  camframe: {
    page: 'frame.html?kind=camera', label: 'Camera frame',
    title: 'This is what the camera frame looks like',
    cfg: () => (CONFIG || {}).camframe,
  },
};
let selectedWin = 'np';

/* ------------------------------------------------------------- components row

   Drawn from the component registry (the state's "components"), in groups:
   Music and words, Screen sharing, and Canvas - one card per scene, to open
   its output, make it the live scene or edit it. The strip scrolls sideways:
   arrows, the wheel, snapping, fading edges, and a focused card brought into
   view. The four music cards keep the element ids the rest of the deck binds
   to, and exist from the start (the registry's own four, until the first
   snapshot), so nothing that binds to them runs before they do. */
const ROW_GROUPS = [['music', 'Music and words'], ['sharing', 'Screen sharing'], ['canvas', 'Canvas']];
const CARD_IDS = {
  np: { state: 'npStatus', size: 'npSize', toggle: 'npToggle' },
  lyrics: { state: 'lyStatus', size: 'lySize', toggle: 'lyToggle' },
  queue: { state: 'qStatus', size: 'qSize', toggle: 'qToggle' },
  captions: { state: 'capStatus', size: 'capSize', toggle: 'capToggle' },
};
const REGISTRY_BOOT = [
  { id: 'np', label: 'Now Playing', sub: 'The track, the art and the progress bar', group: 'music' },
  { id: 'lyrics', label: 'Lyrics', sub: 'The words, scrolling in time', group: 'music' },
  { id: 'queue', label: 'Queue', sub: 'What Spotify plays next', group: 'music' },
  { id: 'captions', label: 'Captions', sub: 'What you say, as live text', group: 'music' },
];
const rowEsc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let rowSig = '';
let rowScenes = [];       // the scenes the Canvas cards were drawn from
let rowLive = '';         // the live scene
let rowWindows = {};      // every component's window, from the last snapshot
const frameOpen = {};

function cardHtml(c) {
  const ids = CARD_IDS[c.id] || {};
  const id = (k) => (ids[k] ? ` id="${ids[k]}"` : '');
  return `<div class="wincard" data-win="${rowEsc(c.id)}" tabindex="0" role="button" aria-pressed="false">
    <div class="wc-head"><span class="wc-dot"></span><span class="wc-name">${rowEsc(c.label)}</span>
      <span class="wc-state"${id('state')}>closed</span></div>
    <p class="wc-sub">${rowEsc(c.sub)}</p>
    <div class="wc-foot"><span class="wc-size"${id('size')}></span>
      <button${id('toggle')} class="btn btn-primary btn-sm"${ids.toggle ? '' : ' data-act="toggle"'}>Open</button></div>
  </div>`;
}

function sceneFormat(s) {
  const w = +s.width || 1920, h = +s.height || 1080;
  return `${w} \u00d7 ${h}` + (h > w ? ' \u00b7 phone' : '');
}
function sceneCardHtml(s) {
  return `<div class="wincard scene" data-scene="${rowEsc(s.id)}" role="group" aria-label="${rowEsc('Scene: ' + s.name)}">
    <div class="wc-head"><span class="wc-dot"></span><span class="wc-name">${rowEsc(s.name)}</span>
      <span class="wc-state">closed</span></div>
    <div class="wc-foot"><span class="wc-size">${rowEsc(sceneFormat(s))}</span>
      <button class="btn btn-primary btn-sm" data-act="scene-open">Open output</button>
      <button class="btn btn-ghost btn-sm" data-act="scene-live">Go LIVE</button>
      <button class="btn btn-ghost btn-sm" data-act="scene-edit">Edit</button></div>
  </div>`;
}

function renderRow(components, scenes) {
  const comps = (components && components.length ? components : REGISTRY_BOOT).filter((c) => c.group !== 'canvas');
  rowScenes = scenes || [];
  const sig = JSON.stringify([comps.map((c) => [c.id, c.label, c.sub, c.group]),
                              rowScenes.map((sc) => [sc.id, sc.name, sc.width, sc.height])]);
  if (sig !== rowSig) {
    rowSig = sig;
    const bar = $('windowsBar');
    // The music cards' nodes are kept: their buttons carry listeners bound by id.
    const keep = new Map([...bar.querySelectorAll('.wincard[data-win]')].map((n) => [n.dataset.win, n]));
    const frag = document.createDocumentFragment();
    for (const [key, name] of ROW_GROUPS) {
      const items = key === 'canvas' ? rowScenes : comps.filter((c) => c.group === key);
      if (!items.length && key === 'sharing') continue;
      const group = document.createElement('div');
      group.className = 'wc-group';
      group.dataset.group = key;
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', name);
      group.innerHTML = `<span class="wc-group-label">${name}</span><div class="wc-group-cards"></div>`;
      const cards = group.lastElementChild;
      if (key === 'canvas') {
        cards.innerHTML = items.length ? items.map(sceneCardHtml).join('')
          : '<p class="wc-empty">No scenes yet \u2014 the Canvas Builder makes them.</p>';
      } else {
        for (const c of items) {
          let node = keep.get(c.id);
          if (node) {
            node.querySelector('.wc-name').textContent = c.label;
            node.querySelector('.wc-sub').textContent = c.sub || '';
          } else {
            const t = document.createElement('div');
            t.innerHTML = cardHtml(c);
            node = t.firstElementChild;
          }
          cards.appendChild(node);
        }
      }
      frag.appendChild(group);
    }
    bar.replaceChildren(frag);
    bar.querySelectorAll('.wincard[data-win]').forEach((c) => {
      const on = c.dataset.win === selectedWin;
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    for (const id of ['screenframe', 'camframe']) {
      if (rowWindows[id]) paintCardState(id, rowWindows[id].open, rowWindows[id].rect);
    }
  }
  paintSceneCards();
  updateStrip();
}

function paintSceneCards() {
  document.querySelectorAll('#windowsBar .wincard.scene').forEach((card) => {
    const sid = card.dataset.scene;
    const open = !!(rowWindows['scene:' + sid] || {}).open;
    const isLive = !!sid && sid === rowLive;
    card.classList.toggle('live', open);
    card.classList.toggle('onair', isLive);
    card.querySelector('.wc-state').textContent = isLive ? (liveOn() ? 'on air' : 'live scene') : open ? 'open' : 'closed';
    const ob = card.querySelector('[data-act="scene-open"]');
    if (!ob.disabled) ob.textContent = open ? 'Close output' : 'Open output';
    const lb = card.querySelector('[data-act="scene-live"]');
    lb.disabled = isLive;
    lb.textContent = isLive ? 'Is live' : 'Go LIVE';
  });
}

function updateStrip() {
  const bar = $('windowsBar'), strip = $('compStrip');
  if (!bar || !strip) return;
  const max = bar.scrollWidth - bar.clientWidth;
  strip.classList.toggle('can-prev', bar.scrollLeft > 2);
  strip.classList.toggle('can-next', max > 2 && bar.scrollLeft < max - 2);
}

function toggleComponent(id, btn) {
  if (frameOpen[id]) {
    post(`/api/components/${id}/close`).then(() => { frameOpen[id] = false; paintCardState(id, false); });
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Opening\u2026';
  post(`/api/components/${id}/open`).then((res) => {
    btn.disabled = false;
    if (res.hosted === false && res.reason) toast('Opened, but not borderless: ' + res.reason);
    else if (!res.ok) toast(res.reason || 'Could not open the window');
    frameOpen[id] = !!res.ok;
    paintCardState(id, !!res.ok);
  });
}

function sceneAction(act, sid, btn) {
  const cid = 'scene:' + sid;
  if (act === 'scene-open') {
    const open = !!(rowWindows[cid] || {}).open;
    btn.disabled = true;
    post(`/api/components/${encodeURIComponent(cid)}/${open ? 'close' : 'open'}`).then((r) => {
      btn.disabled = false;
      if (!open && !r.ok) toast(r.reason || 'Could not open the output');
      rowWindows[cid] = Object.assign({}, rowWindows[cid], { open: open ? false : !!r.ok });
      paintSceneCards();
    });
  } else if (act === 'scene-live') {
    post('/api/canvas/live', { id: sid }).then((r) => {
      if (!r.ok) { toast(r.reason || 'Could not make it the live scene'); return; }
      rowLive = sid;
      paintSceneCards();
      if (!liveOn()) toast('This is the live scene now \u2014 press Start to go LIVE with it');
    });
  } else if (act === 'scene-edit') {
    post('/api/canvas/editor/open', { scene: sid }).then((r) => { if (!r.ok) toast('Could not open the Canvas Builder'); });
  }
}

renderRow(null, []);

$('windowsBar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const card = btn.closest('.wincard');
  if (btn.dataset.act === 'toggle') toggleComponent(card.dataset.win, btn);
  else sceneAction(btn.dataset.act, card.dataset.scene, btn);
});
$('windowsBar').addEventListener('scroll', updateStrip, { passive: true });
window.addEventListener('resize', updateStrip);
new ResizeObserver(updateStrip).observe($('windowsBar'));
function pageStrip(dir) {
  const bar = $('windowsBar');
  bar.scrollBy({ left: dir * Math.max(240, bar.clientWidth * 0.8), behavior: 'smooth' });
}
$('stripPrev').addEventListener('click', () => pageStrip(-1));
$('stripNext').addEventListener('click', () => pageStrip(1));
// A mouse wheel scrolls the strip sideways while it has more to show.
$('windowsBar').addEventListener('wheel', (e) => {
  const bar = $('windowsBar');
  if (bar.scrollWidth <= bar.clientWidth + 1 || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
  e.preventDefault();
  bar.scrollBy({ left: e.deltaY, behavior: 'auto' });
}, { passive: false });
/* A card that takes the keyboard's focus is brought fully into view - by
   the smallest scroll that shows it, with snapping off for that scroll: a
   snap point pulled the last card of a group half back out (found in P6's
   test). The next hand on the strip turns snapping back on. */
function revealCard(card) {
  const bar = $('windowsBar');
  const b = bar.getBoundingClientRect(), c = card.getBoundingClientRect();
  const pad = 40;
  let dx = 0;
  if (c.left < b.left + pad) dx = c.left - b.left - pad;
  else if (c.right > b.right - pad) dx = c.right - b.right + pad;
  if (!dx) return;
  bar.style.scrollSnapType = 'none';
  bar.scrollBy({ left: dx, behavior: 'smooth' });
}
$('windowsBar').addEventListener('focusin', (e) => {
  const card = e.target.closest('.wincard');
  if (card) revealCard(card);
});
for (const ev of ['wheel', 'pointerdown', 'touchstart']) {
  $('windowsBar').addEventListener(ev, () => { $('windowsBar').style.scrollSnapType = ''; }, { passive: true });
}
for (const id of ['stripPrev', 'stripNext']) {
  $(id).addEventListener('pointerdown', () => { $('windowsBar').style.scrollSnapType = ''; });
}
// Left and right arrows move between cards.
$('windowsBar').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const cards = [...document.querySelectorAll('#windowsBar .wincard')];
  const i = cards.indexOf(e.target.closest('.wincard'));
  const next = cards[i + (e.key === 'ArrowRight' ? 1 : -1)];
  if (i < 0 || !next) return;
  e.preventDefault();
  (next.hasAttribute('tabindex') ? next : next.querySelector('button')).focus();
});

/* Everything the row and the LIVE strip show, from each snapshot. */
function paintRegistry(st) {
  rowWindows = st.windows || rowWindows;
  rowLive = (st.canvas || {}).live || '';
  for (const id of ['screenframe', 'camframe']) {
    const w = rowWindows[id];
    if (!w) continue;
    frameOpen[id] = !!w.open;
    const cfg = (CONFIG || {})[id];
    if (cfg && w.open && !w.minimized && w.rect && (w.rect.w !== cfg.width || w.rect.h !== cfg.height)) {
      cfg.width = w.rect.w;
      cfg.height = w.rect.h;
      if (selectedWin === id) { syncFrameFields(); layoutPreview(); }
    }
    paintCardState(id, w.open, w.rect);
  }
  paintLive(st);
  renderRow(st.components, st.scenes);
}

/** The frame Size tab's fields, for whichever frame is picked. */
function syncFrameFields() {
  const cfg = (CONFIG || {})[frameKey()] || {};
  if (document.activeElement !== $('frWidth')) $('frWidth').value = cfg.width || '';
  if (document.activeElement !== $('frHeight')) $('frHeight').value = cfg.height || '';
}
function applyFrameSize(w, h) {
  const key = frameKey();
  CONFIG[key] = CONFIG[key] || {};
  CONFIG[key].width = w;
  CONFIG[key].height = h;
  post('/api/config', { [key]: { width: w, height: h } });
  post(`/api/components/${key}/apply`, { width: w, height: h });
  layoutPreview();
}
['frWidth', 'frHeight'].forEach((id) => $(id).addEventListener('change', () =>
  applyFrameSize(+$('frWidth').value, +$('frHeight').value)));
$('frSizePresets').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-w]');
  if (!btn) return;
  $('frWidth').value = btn.dataset.w;
  $('frHeight').value = btn.dataset.h;
  applyFrameSize(+btn.dataset.w, +btn.dataset.h);
});
$('frSnap').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-c]');
  if (btn) post(`/api/components/${frameKey()}/snap`, { corner: btn.dataset.c })
    .then((r) => { if (!r.ok) toast('Open the frame first'); });
});
if (window.decorOptions) $('frLoopPattern').innerHTML = decorOptions(rowEsc);

/* ------------------------------------------------------------- LIVE strip

   Status, the live scene, Start and Stop. The stream key, presets and
   audio are set in the LIVE panel (a later step); until a key is saved,
   Start says so instead of failing. */
let liveNow = { state: 'idle' };
let liveStatsTimer = null;
let liveStats = null;
const liveOn = () => ['connecting', 'live', 'reconnecting'].includes(liveNow.state);

function paintLive(st) {
  liveNow = st.live || { state: 'idle' };
  const on = liveOn();
  $('liveStrip').dataset.state = liveNow.state || 'idle';
  const names = { idle: 'Off air', connecting: 'Connecting\u2026', live: 'LIVE', reconnecting: 'Reconnecting\u2026' };
  let text = names[liveNow.state] || String(liveNow.state || 'Off air');
  if (liveNow.state === 'live' && liveStats) {
    const up = Math.max(0, Math.round(liveStats.uptime || 0));
    const mm = Math.floor(up / 60), ss = String(up % 60).padStart(2, '0');
    text += ` ${mm}:${ss}` + (liveStats.kbps ? ` \u00b7 ${(liveStats.kbps / 1000).toFixed(1)} Mb/s` : '');
  }
  $('liveState').textContent = text;
  $('liveState').title = liveNow.error || '';
  const go = $('liveGo');
  go.textContent = on ? 'Stop' : 'Start';
  go.classList.toggle('btn-primary', !on);
  go.classList.toggle('btn-ghost', on);
  go.disabled = !on && !liveNow.has_key;
  go.title = on ? 'Stop the stream'
    : liveNow.has_key ? 'Go LIVE with the live scene' : 'Save your stream key first (the LIVE panel comes in a later step)';

  const sel = $('liveScene');
  const scenes = st.scenes || [];
  const cur = (st.canvas || {}).live || '';
  const sig = JSON.stringify([scenes.map((x) => [x.id, x.name]), cur]);
  if (sel.dataset.sig !== sig && document.activeElement !== sel) {
    sel.dataset.sig = sig;
    sel.innerHTML = '<option value="">No live scene</option>' +
      scenes.map((x) => `<option value="${rowEsc(x.id)}">${rowEsc(x.name)}</option>`).join('');
    sel.value = cur;
  }
  if (on && !liveStatsTimer) {
    liveStatsTimer = setInterval(() => {
      fetch('/api/live/status').then((r) => r.json()).then((d) => { liveStats = d.stats || null; paintLive({ live: d, scenes: rowScenes, canvas: { live: rowLive } }); }).catch(() => {});
    }, 2000);
  } else if (!on && liveStatsTimer) {
    clearInterval(liveStatsTimer);
    liveStatsTimer = null;
    liveStats = null;
  }
}

$('liveGo').addEventListener('click', () => {
  const go = $('liveGo');
  go.disabled = true;
  const req = liveOn() ? post('/api/live/stop') : post('/api/live/start', {});
  req.then((r) => {
    go.disabled = false;
    if (r && r.ok === false) toast(r.error || r.reason || 'Could not go LIVE');
  });
});
$('liveScene').addEventListener('change', () => {
  post('/api/canvas/live', { id: $('liveScene').value }).then((r) => { if (r && r.ok === false) toast(r.reason || 'Could not switch the live scene'); });
});
$('canvasBtn').addEventListener('click', () => {
  post('/api/canvas/editor/open', {}).then((r) => { if (!r || !r.ok) toast('Could not open the Canvas Builder'); });
});

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
  // data-for lists the windows a tab applies to ("all" for every one).
  tabs.forEach((b) => {
    const fors = (b.dataset.for || '').split(' ');
    b.hidden = !((fors.includes('all') && !isFrame(id)) || fors.includes(id));
  });
  const active = tabs.find((b) => b.classList.contains('on'));
  if (!active || active.hidden) {
    const first = tabs.find((b) => !b.hidden);
    if (first) first.click();
  }

  // The Background tab follows the window you picked, so the two never
  // disagree about what you are editing. "The app" stays where you left it.
  if (bgTargetKey !== 'app' && !isFrame(id)) selectBgTarget(id);
  selectControlTarget(id);
  if (isFrame(id) && CONFIG) { syncFrameFields(); syncControls(); }

  $('previewTitle').textContent = WINDOWS[id].title;
  $('designingName').textContent = WINDOWS[id].label;
  // Stickers only exist on the pop-out, so their drag handles go with it.
  $('previewEdit').hidden = id !== 'np';
  // The captions listener sits right under its preview; stickers exist
  // only on Now Playing, so their hint goes with it.
  $('capListen').hidden = id !== 'captions';
  $('stickerHint').hidden = id !== 'np';
  meterLoop();
  $('dropHintWhat').textContent = id === 'np'
    ? 'PNG, JPEG, GIF or WebP — as a sticker, or as the background'
    : "to use it as this window's background";

  const page = WINDOWS[id].page;
  if (changed) previewEl.src = page + (page.includes('?') ? '&' : '?') + 'preview=1&t=' + Date.now();
  layoutPreview();
}

$('windowsBar').addEventListener('click', (e) => {
  const card = e.target.closest('.wincard');
  if (!card || e.target.closest('button')) return;   // the toggle speaks for itself
  selectWindow(card.dataset.win);
});
$('windowsBar').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  if (e.target.closest('button')) return;
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
  const label = card.querySelector('.wc-size');
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
    });
  }
});

function paintWindowStatus() { paintCardState('np', npOpen); }

/* The three windows' state rides the broadcast - open or closed, and the real
   size if someone stretched a window by hand - so the cards and the size boxes
   stay honest without asking three times a second. */
function syncWindows(state) {
  if (!CONFIG) return;
  const w = state.windows || {};
  const one = (s, cfg, wId, hId, win, setOpen, relayout) => {
    if (!s) return;
    setOpen(!!s.open);
    // Someone stretched the real window: keep the deck and preview honest.
    // A minimized window reports where Windows parks it, not its size.
    if (s.open && !s.minimized && s.rect && cfg && (s.rect.w !== cfg.width || s.rect.h !== cfg.height)) {
      cfg.width = s.rect.w;
      cfg.height = s.rect.h;
      if (document.activeElement !== $(wId)) $(wId).value = s.rect.w;
      if (document.activeElement !== $(hId)) $(hId).value = s.rect.h;
      if (relayout) layoutPreview();
    }
    paintCardState(win, s.open, s.rect);
  };
  one(w.np, CONFIG.nowplaying, 'width', 'height', 'np',
      (o) => { if (o !== npOpen) { npOpen = o; paintWindowStatus(); } }, true);
  one(w.lyrics, CONFIG.lyrics, 'lyWidth', 'lyHeight', 'lyrics',
      (o) => { if (o !== lyOpen) { lyOpen = o; paintLyStatus(); } }, selectedWin === 'lyrics');
  one(w.queue, CONFIG.queue, 'qWidth', 'qHeight', 'queue',
      (o) => { if (o !== qOpen) { qOpen = o; paintQStatus(); } }, selectedWin === 'queue');
  one(w.captions, CONFIG.captions, 'capWidth', 'capHeight', 'captions',
      (o) => { if (o !== capOpen) { capOpen = o; paintCapStatus(); } }, selectedWin === 'captions');
}

/* The lyrics situation, in one line, from the same broadcast. */
function paintLyricsInfo(state) {
  const d = state.lyrics_info || {};
  const from = d.source === 'file' ? 'a .lrc file' : d.source === 'lrclib' ? 'lrclib.net' : '';
  const text = {
    synced: `Synced lyrics from ${from} · ${d.lines || 0} lines`,
    plain: `Unsynced lyrics from ${from} — they glide through in proportion to the song`,
    instrumental: 'Instrumental track',
    loading: 'Looking for lyrics…',
    none: d.reason === 'nothing playing' ? 'Nothing playing' : 'No lyrics found for this track',
  }[d.status] || '';
  if ($('lyInfo').textContent !== text) $('lyInfo').textContent = text;
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
  if (!confirm('Stop Awesome Streaming Deck? The on-screen window closes too.')) return;
  post('/api/window/close')
    .then(() => post('/api/quit'))
    .then(() => {
      document.body.innerHTML =
        '<div class="empty" style="padding:90px 20px"><b>Awesome Streaming Deck has stopped.</b><br>' +
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
  });
});

['lyWidth', 'lyHeight'].forEach((id) => $(id).addEventListener('change', () => {
  const w = +$('lyWidth').value, h = +$('lyHeight').value;
  saveLy({ width: w, height: h });
  post('/api/lyrics/window/apply', { width: w, height: h });
}));

$('lySizePresets').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-w]');
  if (!btn) return;
  const w = +btn.dataset.w, h = +btn.dataset.h;
  $('lyWidth').value = w; $('lyHeight').value = h;
  saveLy({ width: w, height: h });
  post('/api/lyrics/window/apply', { width: w, height: h });
  if (selectedWin === 'lyrics') layoutPreview();
});

$('lySnap').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-c]');
  if (btn) post('/api/lyrics/window/snap', { corner: btn.dataset.c })
    .then((r) => { if (!r.ok) toast('Open the lyrics window first'); });
});


/* ------------------------------------------------------------- captions window */

let capOpen = false;

function paintCapStatus() { paintCardState('captions', capOpen); }

$('capToggle').addEventListener('click', () => {
  if (capOpen) {
    post('/api/captions/window/close').then(() => { capOpen = false; paintCapStatus(); });
    return;
  }
  $('capToggle').disabled = true;
  $('capToggle').textContent = 'Opening…';
  post('/api/captions/window/open').then((res) => {
    $('capToggle').disabled = false;
    if (!res.ok) toast(res.reason || 'Could not open the captions window');
  });
});

['capWidth', 'capHeight'].forEach((id) => $(id).addEventListener('change', () => {
  const w = +$('capWidth').value, h = +$('capHeight').value;
  saveCap({ width: w, height: h });
  post('/api/captions/window/apply', { width: w, height: h });
}));

$('capSizePresets').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-w]');
  if (!btn) return;
  const w = +btn.dataset.w, h = +btn.dataset.h;
  $('capWidth').value = w; $('capHeight').value = h;
  saveCap({ width: w, height: h });
  post('/api/captions/window/apply', { width: w, height: h });
  if (selectedWin === 'captions') layoutPreview();
});

$('capSnap').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-c]');
  if (btn) post('/api/captions/window/snap', { corner: btn.dataset.c })
    .then((r) => { if (!r.ok) toast('Open the captions window first'); });
});

/* The microphone itself: one Start/Stop button, and a status line that says
   what the listener is doing, so "nothing is showing up" always has a reason
   next to it - loading, no audio arriving, the model still to download. */
let capState = null;
let capModels = null;
let capBusy = false;

const capCfg = () => (CONFIG && CONFIG.captions) || {};
const capEngine = () => (capCfg().engine === 'windows' ? 'windows' : 'whisper');
const capModelName = () => capCfg().model || 'base.en';
const megabytes = (bytes) => Math.round(bytes / 1e6);

/* Whisper needs its model first. Until it is on disk the main button offers
   the download, rather than a Start that could only fail. */
function capNeedsModel() {
  const m = capModels && capModels[capModelName()];
  return capEngine() === 'whisper' && !!m && !m.ready;
}

function paintCaptionModels(models) {
  if (!models) return;
  capModels = models;
  const sel = $('capModel');
  const want = capModelName();
  const opts = Object.entries(models).map(([name, m]) =>
    `<option value="${esc(name)}">${esc(m.label)} — ${esc(m.note)} (${m.approx_mb} MB)${m.ready ? ' ✓' : ''}</option>`).join('');
  if (sel.dataset.sig !== opts) {
    sel.dataset.sig = opts;
    sel.innerHTML = opts;
    writeControl(sel, 'str', want);
  }
  $('capModelField').hidden = capEngine() !== 'whisper';

  const m = models[want] || {};
  const btn = $('capModelBtn'), bar = $('capProgress'), hint = $('capModelHint');
  bar.hidden = !m.downloading;
  if (m.downloading) {
    const pct = m.total ? Math.floor((100 * m.done) / m.total) : 0;
    bar.firstElementChild.style.width = pct + '%';
    btn.textContent = 'Cancel';
    btn.dataset.act = 'cancel';
    hint.textContent = m.total ? `Downloading… ${megabytes(m.done)} of ${megabytes(m.total)} MB` : 'Starting the download…';
  } else if (m.ready) {
    btn.textContent = 'Remove';
    btn.dataset.act = 'remove';
    hint.textContent = 'Downloaded — runs offline on this PC.';
  } else {
    btn.textContent = `Download (${m.approx_mb || '?'} MB)`;
    btn.dataset.act = 'download';
    hint.textContent = m.error || 'A one-time download from Hugging Face; after that it works offline.';
  }
  hint.classList.toggle('warn', !!m.error && !m.downloading);
}

function capModelAction(act) {
  if (act === 'remove' && !confirm('Remove this Whisper model? You can download it again any time.')) return;
  post('/api/captions/model/' + act, { name: capModelName() }).then((r) => {
    if (r && r.models) paintCaptionModels(r.models);
    if (r && r.ok === false && r.reason) toast(r.reason);
  });
}
$('capModelBtn').addEventListener('click', () => capModelAction($('capModelBtn').dataset.act || 'download'));

/* The graphics card: offered only when there is an NVIDIA one, and it needs
   NVIDIA's cuBLAS once. Until that is on disk Whisper keeps to the processor,
   and if the card turns it down the engine's reason shows here. */
let capGpu = null;
function paintCaptionGpu(g) {
  if (!g) return;
  capGpu = g;
  const wantGpu = capCfg().device === 'gpu';
  const field = $('capGpuField');
  // Shown whenever it has something to say: a card to offer, a library on
  // disk, or a choice of Graphics card (whose reason must never be hidden).
  field.hidden = capEngine() !== 'whisper' || !(g.gpu || g.ready || g.downloading || wantGpu);
  if (field.hidden) return;
  const card = g.gpu || 'NVIDIA graphics card';
  const usable = !!g.gpu && g.driver_ok !== false && !g.pending;
  const btn = $('capGpuBtn'), bar = $('capGpuProgress'), hint = $('capGpuHint');
  const c = capState || {};
  const running = c.on && c.state === 'listening' && c.engine === 'whisper';
  const unpacking = g.downloading && g.phase === 'unpack';
  // Something to press: Cancel, Remove, or Download (and Retry) for a card
  // that can use it.
  $('capGpuRow').hidden = unpacking || !(g.downloading || g.ready || (usable && (wantGpu || g.error)));
  bar.hidden = !g.downloading;
  let text, warn = false;
  if (g.ready) { btn.textContent = 'Remove'; btn.dataset.act = 'remove'; }
  else { btn.textContent = `Download (${g.download_mb} MB)`; btn.dataset.act = 'download'; }
  if (unpacking) {
    bar.firstElementChild.style.width = '100%';
    text = "Checking and unpacking NVIDIA's cuBLAS…";
  } else if (g.downloading) {
    bar.firstElementChild.style.width = (g.total ? Math.floor((100 * g.done) / g.total) : 0) + '%';
    btn.textContent = 'Cancel';
    btn.dataset.act = 'cancel';
    text = `Downloading NVIDIA's cuBLAS… ${megabytes(g.done)} of ${megabytes(g.total)} MB`;
  } else if (running && c.note) {
    text = c.note;
    warn = true;
  } else if (g.pending && !g.ready) {
    text = "Removed. NVIDIA's library was still in use, so its files go when the app restarts - "
      + 'restart it before downloading it again.';
  } else if (g.failed) {
    text = `The graphics card stopped working for Whisper earlier (${g.failed})`
      + (wantGpu ? ', so it runs on the processor. ' : '. ') + 'Restart the app to use the graphics card again.';
    warn = wantGpu;
  } else if (!g.gpu) {
    text = 'No NVIDIA graphics card was found on this PC, so Whisper runs on the processor.';
  } else if (g.driver_ok === false) {
    text = `Your NVIDIA driver (${g.driver}) is too old for Whisper on the graphics card - update it `
      + 'from NVIDIA, then restart the app. Until then Whisper runs on the processor.';
    warn = wantGpu;
  } else if (g.ready) {
    if (!wantGpu) text = `NVIDIA's library is downloaded. Pick Graphics card to run Whisper on your ${card}.`;
    else if (running && c.device === 'cuda') text = `Running on your ${card}.`;
    else text = `Ready: Whisper runs on your ${card}.`;
  } else if (wantGpu && g.error) {
    text = g.error;
    warn = true;
  } else if (wantGpu) {
    text = `Needs NVIDIA's cuBLAS library first: a one-time ${g.download_mb} MB download from PyPI `
      + `(${g.disk_mb} MB on disk; NVIDIA's license applies). Until then Whisper runs on the processor.`;
  } else {
    text = `Found your ${card}. Running Whisper on it takes almost all of the work off the processor.`;
  }
  hint.textContent = text;
  hint.classList.toggle('warn', warn);
}

function capGpuAction(act) {
  if (act === 'remove' && !confirm("Remove NVIDIA's library? Whisper goes back to the processor. "
    + 'If Whisper has used it since the app started, its files are freed when the app restarts.')) return;
  post('/api/captions/gpu/' + act, {}).then((r) => {
    if (r && r.gpu) paintCaptionGpu(r.gpu);
    if (r && r.ok === false && r.reason) toast(r.reason);
    if (r && r.pending) toast('Removed. The last files are in use until the app restarts.');
  });
}
$('capGpuBtn').addEventListener('click', () => capGpuAction($('capGpuBtn').dataset.act || 'download'));

function paintCaptions(c) {
  if (!c) return;
  capState = c;
  const btn = $('capMic'), pill = $('capState');
  const on = !!c.on;
  const need = !on && capNeedsModel();
  const m = need ? capModels[capModelName()] : null;
  if (!capBusy) {
    btn.textContent = on ? 'Stop listening'
      : need ? (m.downloading ? 'Downloading Whisper…' : `Download Whisper (${m.approx_mb} MB)`)
      : 'Start listening';
    btn.disabled = !!(need && m.downloading);
  }
  btn.classList.toggle('btn-primary', !on);
  btn.classList.toggle('btn-ghost', on);

  let text = 'Off', tone = 'off';
  if (on && c.state === 'starting') {
    const g = capGpu;
    const onCard = capCfg().device === 'gpu' && g && g.ready && g.gpu && g.driver_ok !== false && !g.failed;
    text = c.engine !== 'whisper' ? 'Starting…' : onCard ? 'Starting Whisper on the graphics card…' : 'Loading Whisper…';
    tone = 'wait';
  }
  else if (on && c.state === 'unavailable') { text = c.error || 'Not available'; tone = 'bad'; }
  else if (on && c.audio === 'speech') { text = 'Hearing you'; tone = 'good'; }
  else if (on && c.audio === 'stopped') { text = 'Listening, but no sound is arriving from the microphone'; tone = 'warn'; }
  else if (on) { text = 'Listening'; tone = 'good'; }
  pill.textContent = text;
  pill.dataset.tone = tone;

  // The level meter: proof the right microphone is live. Whisper reports it.
  const meter = $('capMeter');
  meter.hidden = !(on && c.state === 'listening' && c.engine === 'whisper');
  meter.firstElementChild.style.width = Math.round((c.level || 0) * 100) + '%';
  meterLoop();

  // The latest thing heard, so you can check the microphone without opening
  // the window - and see when it mishears you.
  const last = (c.lines && c.lines.length) ? c.lines[c.lines.length - 1].text : '';
  $('capLast').textContent = on ? (c.partial || last || '') : '';
}

/* The meter moves too often for the broadcast, which only sends on change,
   so it is asked for directly - five times a second, and only while it is
   actually on screen. */
let meterTimer = null;
function meterLoop() {
  clearTimeout(meterTimer);
  const c = capState;
  const want = !!c && c.on && c.state === 'listening' && c.engine === 'whisper'
    && selectedWin === 'captions' && document.visibilityState === 'visible';
  if (!want) return;
  fetch('/api/captions/level').then((r) => r.json()).then((d) => {
    $('capMeter').firstElementChild.style.width = Math.round((d.level || 0) * 100) + '%';
  }).catch(() => {}).finally(() => { meterTimer = setTimeout(meterLoop, isUltra() ? 1000 : 200); });
}
document.addEventListener('visibilitychange', meterLoop);

$('capMic').addEventListener('click', () => {
  const on = !!(capState && capState.on);
  if (!on && capNeedsModel()) { capModelAction('download'); return; }
  capBusy = true;
  $('capMic').disabled = true;
  $('capMic').textContent = on ? 'Stopping…' : 'Starting…';
  post(on ? '/api/captions/stop' : '/api/captions/start').then((r) => {
    capBusy = false;
    $('capMic').disabled = false;
    if (r && r.captions) paintCaptions(r.captions);
    else toast('Could not reach the deck');
  });
});

/* Microphones: listed at load and again whenever the deck regains focus, so
   one plugged in meanwhile shows up. */
function loadMics() {
  fetch('/api/captions/mics').then((r) => r.json()).then((d) => {
    const sel = $('capMicPick');
    const opts = '<option value="">Windows default microphone</option>' +
      (d.mics || []).map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    if (sel.dataset.sig === opts) return;
    sel.dataset.sig = opts;
    sel.innerHTML = opts;
    writeControl(sel, 'str', capCfg().mic || '');
  }).catch(() => {});
}
loadMics();
window.addEventListener('focus', loadMics);

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
  });
});

['qWidth', 'qHeight'].forEach((id) => $(id).addEventListener('change', () => {
  const w = +$('qWidth').value, h = +$('qHeight').value;
  saveQ({ width: w, height: h });
  post('/api/queue/window/apply', { width: w, height: h });
}));

$('qSizePresets').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-w]');
  if (!btn) return;
  const w = +btn.dataset.w, h = +btn.dataset.h;
  $('qWidth').value = w; $('qHeight').value = h;
  saveQ({ width: w, height: h });
  post('/api/queue/window/apply', { width: w, height: h });
  if (selectedWin === 'queue') layoutPreview();
});

$('qSnap').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-c]');
  if (btn) post('/api/queue/window/snap', { corner: btn.dataset.c })
    .then((r) => { if (!r.ok) toast('Open the queue window first'); });
});


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
  // A pop-out asked to seek a local file; we hold the audio element.
  const sk = state.local_seek;
  if (sk && sk.id !== lastSeekId) {
    lastSeekId = sk.id;
    if (cardSource === 'local' && audio.duration) audio.currentTime = sk.to;
  }
  // A transport button was pressed inside one of the pop-outs. Spotify handles
  // its own; a local file is playing in this page's <audio>, so it lands here.
  const cmd = state.local_cmd;
  if (cmd && cmd.id !== lastCmdId) {
    lastCmdId = cmd.id;
    if (cardSource === 'local') {
      if (cmd.cmd === 'next') $('next').click();
      else if (cmd.cmd === 'prev') $('prev').click();
      else if (cmd.cmd === 'playpause') $('playpause').click();
    }
  }
  paintSpotifyAccount(acc, state.spotify_account || null);
  paintSourcePanels(state);
  paintCard(state.now);
  lastTrueNow = state.now || null;
  paintSpotifyQueue(state.spotify_queue, false, lastTrueNow);
  paintSpotifyDevices(state.spotify_devices);
  syncWindows(state);
  paintLyricsInfo(state);
  paintCaptionModels(state.captions_models);
  if (state.captions_gpu) capGpu = state.captions_gpu;   // the status pill reads it
  paintCaptions(state.captions);
  paintCaptionGpu(state.captions_gpu);
  syncFontsState(state);
  if (acc.connected && spWaiting) {
    spWaiting = false;
    $('spPending2').hidden = true;
    $('spManual2').hidden = true;
  }
}
let spWaiting = false;

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
  if (spotify && lastQueueView) paintSpotifyQueue(lastQueueView, true, lastTrueNow);
}

let spConnected = false;
let spQueueTimer = null;
let spRepeatMode = 'off';
let spShuffleOn = false;

function spRow(t, i, opts = {}) {
  return `<div class="sp-row ${opts.now ? 'now' : ''}">
      <div class="n">${opts.now ? '♪' : (i + 1)}</div>
      ${t.art ? `<img src="${esc(t.art)}" alt="" loading="lazy">` : '<img alt="">'}
      <div class="meta">
        <div class="t">${esc(t.title)}</div>
        <div class="a">${esc(t.artist)}</div>
      </div>
    </div>`;
}

/* Everything in this panel is painted from the state broadcast. The server
   owns the queue and the devices: it refreshes them on its own thread when a
   track changes or a button is pressed, and never inside a rate-limit window.
   Nothing here asks Spotify for anything. */
let lastQueueVersion = -1, lastQueueView = null, lastTrueNow = null;
function paintSpotifyQueue(q, force, trueNow) {
  if (!q) return;
  lastQueueView = q;
  // The app asks Spotify only while the Queue window is open, so with it
  // closed there is no list to trust - say so rather than show an old one.
  if (q.live === false && q.reason !== 'not connected') {
    $('spQueueErr').textContent = '';
    $('spQueue').innerHTML = '<div class="empty">The queue shows while the Queue window is open — '
      + 'the app only asks Spotify then.</div>';
    $('spQueueCount').textContent = 'Up next';
    lastQueueVersion = -1;              // paint the real list the moment it is live
    return;
  }
  // The wait, counted down where the error goes, so a deliberate hold does not
  // read as "broken". This line is cheap to rewrite every tick; the rows below
  // are only rebuilt when the server says the list actually changed.
  const err = $('spQueueErr');
  err.textContent = q.retry_in
    ? `Spotify is rate limiting this app — back in ${humanWait(q.retry_in)}`
      + (q.age > 120 ? ` · showing the list from ${humanWait(q.age)} ago` : '')
    : (q.ok || q.reason === 'loading' ? '' : (q.reason || ''));
  if (!force && q.version === lastQueueVersion) return;
  lastQueueVersion = q.version;

  // The "now" row is whatever Windows says is playing - true even while the
  // list itself is waiting out a limit - and the list's head is dropped if it
  // is that same track, which it is when the list is one behind.
  const nowRow = trueNow && trueNow.title
    ? { title: trueNow.title, artist: trueNow.artist, art: trueNow.art_url || '', duration: trueNow.duration }
    : q.now;
  let list = q.queue || [];
  if (nowRow && list.length && list[0].title === nowRow.title && list[0].artist === nowRow.artist) list = list.slice(1);

  const rows = [];
  if (nowRow) rows.push(spRow(nowRow, 0, { now: true }));
  list.forEach((t, i) => rows.push(spRow(t, i)));
  $('spQueue').innerHTML = rows.length ? rows.join('')
    : (q.reason === 'loading'
      ? '<div class="empty">Fetching the queue…</div>'
      : '<div class="empty">Nothing queued. Start something in Spotify, or search above.</div>');
  $('spQueueCount').textContent = list.length ? `Up next · ${list.length}` : 'Up next';
}

let lastDevicesVersion = -1;
function paintSpotifyDevices(d) {
  if (!d || d.version === lastDevicesVersion) return;
  lastDevicesVersion = d.version;
  const sel = $('spDevice');
  const list = d.devices || [];
  const active = (list.find((x) => x.active) || {}).id || '';
  sel.innerHTML = list.length
    ? list.map((x) => `<option value="${esc(x.id)}" ${x.active ? 'selected' : ''}>${esc(x.name)} · ${esc(x.type)}</option>`).join('')
    : '<option value="">no devices</option>';
  sel.dataset.active = active;
}

function paintSpotifyAccount(acc, sp) {
  const wasConnected = spConnected;
  spConnected = !!acc.connected;
  $('spSetupBox').hidden = spConnected;
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
    $('spRepeat').innerHTML = svgIcon(spRepeatMode === 'track' ? 'repeatOne' : 'repeat');
  }
  // Just connected. That is a deliberate act with an obvious intent, so bring
  // the Spotify panel up even in Auto mode where nothing is playing yet to
  // switch it, and ask the server to refresh now - the answer arrives on the
  // broadcast like everything else.
  if (spConnected && !wasConnected) {
    autoShowsSpotify = true;
    if ($('spotifyMain').hidden) {
      $('spotifyMain').hidden = false;
      $('libraryPanel').hidden = true;
    }
    post('/api/spotify/refresh');
    toast('Spotify connected');
  }
}

/* search -> click a result to queue it */
$('spQueueRefresh').addEventListener('click', () => {
  if (lastQueueView && lastQueueView.live === false) {
    toast('Open the Queue window first — the app only asks Spotify while it is open');
    return;
  }
  post('/api/spotify/refresh');
});
$('spDevice').addEventListener('change', () => {
  const id = $('spDevice').value;
  if (!id || id === $('spDevice').dataset.active) return;
  post('/api/spotify/transfer', { device_id: id }).then((res) => {
    toast(res.ok ? 'Moved playback' : (res.reason || 'Could not move playback'));
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
    toast(res.windowed ? 'Approve Awesome Streaming Deck in the window that just opened'
                       : 'Approve Awesome Streaming Deck in your browser');
  });
});

/* Count the wait down where the error message goes, so it is obvious the app
   is deliberately holding off rather than broken. */
function humanWait(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${seconds}s`;
}


/* --------------------------------------------------- onboarding & app look */

/* First-run help banner, remembered per browser. The ? button brings it back. */
(function () {
  let seen = false;
  try { seen = localStorage.getItem('amsd.onboarded') === '1'; } catch (_) {}
  if (!seen) $('onboard').hidden = false;
  $('onboardOk').addEventListener('click', () => {
    $('onboard').hidden = true;
    try { localStorage.setItem('amsd.onboarded', '1'); } catch (_) {}
  });
  $('helpBtn').addEventListener('click', () => { $('onboard').hidden = false; });
})();

/* The app's own appearance lives in a collapsible panel, opened from the top bar. */
$('appLookToggle').addEventListener('click', () => {
  const panel = $('appAppearance');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});
$('appLookClose').addEventListener('click', () => { $('appAppearance').hidden = true; });

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

/* ------------------------------------------------------------- looks & undo */

$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);
$('saveLook').addEventListener('click', saveLook);
$('savedThemes').addEventListener('change', () => {
  const id = $('savedThemes').value;
  if (id) applySavedTheme(id);
});
$('deleteLook').addEventListener('click', () => {
  const id = $('savedThemes').value;
  if (!id) { toast('Pick a saved look first'); return; }
  const t = SAVED_THEMES.find((x) => x.id === id);
  if (!confirm(`Delete the look "${t ? t.name : id}"?`)) return;
  deleteSavedTheme(id);
});

// Keyboard undo/redo, but never while the streamer is typing in a field.
document.addEventListener('keydown', (e) => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
  if (!(e.ctrlKey || e.metaKey)) return;
  const z = e.key === 'z' || e.key === 'Z';
  const y = e.key === 'y' || e.key === 'Y';
  if (z && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (y || (z && e.shiftKey)) { e.preventDefault(); redo(); }
});

// "Recenter buttons" clears the fine-tune nudge on whichever window's editor.
$('controlEditors').addEventListener('click', (e) => {
  const btn = e.target.closest('.nudge-reset');
  if (!btn) return;
  const ed = btn.closest('.control-editor');
  const t = ed && CONTROL_TARGETS.find((x) => x.key === ed.dataset.ctl);
  if (t) { t.save({ 'controls.offset': { x: 0, y: 0 } }); syncControls(); toast('Buttons recentered'); }
});

fillFonts();
// Paint the SVG glyphs into the static control buttons once. The toggling
// ones (play/pause, repeat) are set from svgIcon() wherever they change.
$('shuffle').innerHTML = svgIcon('shuffle');
$('prev').innerHTML = svgIcon('prev');
$('next').innerHTML = svgIcon('next');
$('playpause').innerHTML = svgIcon('play');
$('repeat').innerHTML = svgIcon('repeat');
$('spShuffle').innerHTML = svgIcon('shuffle');
$('spRepeat').innerHTML = svgIcon('repeat');
const volIcon = document.querySelector('.vol-icon');
if (volIcon) volIcon.innerHTML = svgIcon('volume');
$('stickerUp').insertAdjacentHTML('afterbegin', svgIcon('up'));
$('stickerDown').insertAdjacentHTML('afterbegin', svgIcon('down'));

fillDecorPickers();
// The background editors are generated markup, so they have to exist before
// bindControls() scans the page for data-* controls.
buildBackgroundEditors();
buildControlEditors();
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
  updateUndoButtons();
  loadSavedThemes();
  return loadAssets().then(loadLibrary);
});

previewEl.addEventListener('load', pushPreview);
window.addEventListener('resize', layoutPreview);
new ResizeObserver(layoutPreview).observe($('previewStage'));

/* The preview only has to move while you work in the deck. Once the deck is
   behind your game or TikTok Studio, its endless animations - the drifting
   decoration frame, a sliding title, the equalizer - pause, so Chrome stops
   redrawing a window nobody is watching. Everything else still updates and
   finite animations still finish; click back into the deck and the motion
   carries on. The pop-out windows are separate pages and keep moving. */
let deckStill = null;
const stilled = new Set();
/* ...and while you are not using it: ten seconds without the pointer or the
   keyboard and the preview holds still with the deck in front, too. Measured
   2026-09-12: a focused, idle deck cost Chrome 86% of a core - the preview's
   equalizer and sliding title, stepped to 30 a second but redrawn at 150%
   scale every step. Any input brings the motion back at once. */
const IDLE_STILL_MS = 10000;
let lastInput = performance.now();
function noteInput() {
  lastInput = performance.now();
  if (deckStill) syncStill();
}
const INPUTS = ['pointermove', 'pointerdown', 'keydown', 'wheel'];
function previewDoc() {
  try { return previewEl.contentDocument; } catch (_) { return null; }
}
function stillDoc(doc) {
  if (!doc) return;
  // The preview's own clock reads this and moves once a second while still:
  // its progress bar redrew a few times a second, and every redraw repainted
  // the scaled preview (6 layouts a second in a deck with nothing moving).
  if (doc.documentElement) doc.documentElement.setAttribute('data-still', '');   // none while the preview loads
  for (const a of doc.getAnimations()) {
    if (a.playState === 'running' && a.effect && a.effect.getTiming().iterations === Infinity) {
      a.pause();
      stilled.add(a);
    }
  }
}
function syncStill() {
  if (!document.hasFocus() || performance.now() - lastInput > IDLE_STILL_MS) {
    // Also catches animations that began since, in either page.
    deckStill = true;
    stillDoc(document);
    stillDoc(previewDoc());
    return;
  }
  if (deckStill === false) return;
  deckStill = false;
  for (const d of [document, previewDoc()]) if (d && d.documentElement) d.documentElement.removeAttribute('data-still');
  // Resume only what is still on the page: an animation its element has
  // dropped since must not come back.
  const live = new Set(document.getAnimations());
  const pd = previewDoc();
  if (pd) for (const a of pd.getAnimations()) live.add(a);
  for (const a of stilled) if (live.has(a)) a.play();
  stilled.clear();
}
const stillSoon = () => setTimeout(syncStill, 0);
function hookPreview() {
  try {
    // Clicking into the preview moves focus into its frame: follow it there.
    // Marked per page, not per window: the frame's first page load keeps the
    // window object and swaps the document, which would look hooked already.
    const w = previewEl.contentWindow;
    const d = w && w.document;
    if (!d || d.__stillHooked) return;
    d.__stillHooked = true;
    w.addEventListener('focus', syncStill);   // same function each time, so never added twice
    w.addEventListener('blur', stillSoon);
    d.addEventListener('animationstart', stillSoon, true);
    for (const ev of INPUTS) d.addEventListener(ev, noteInput, { capture: true, passive: true });
  } catch (_) {}
}
window.addEventListener('focus', syncStill);
window.addEventListener('blur', stillSoon);
document.addEventListener('animationstart', stillSoon, true);
for (const ev of INPUTS) document.addEventListener(ev, noteInput, { capture: true, passive: true });
previewEl.addEventListener('load', () => { hookPreview(); syncStill(); });
hookPreview();
setInterval(syncStill, 1000);   // catches focus moves that fire no event
syncStill();

/* Ultra optimized switched, or a frozen picture is ready: repaint the app's
   own wallpaper under the new rules. Deferred, since applyUi flips the switch. */
onMotionChange(() => setTimeout(() => {
  lastWallKey = null;
  if (CONFIG && CONFIG.ui) applyUi(CONFIG.ui);
}, 0));

const events = new EventSource('/api/events');
events.onmessage = (e) => {
  let st;
  try { st = JSON.parse(e.data); } catch (_) { return; }
  try { paintSpotify(st); } catch (_) {}
  paintRegistry(st);
};

