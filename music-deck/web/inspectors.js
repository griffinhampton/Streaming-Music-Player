/* Inspectors for every layer type (P9).

   Written in the deck's own control vocabulary (designer.js): data-lx="path"
   edits the selected layer, data-sx="path" the scene. A component whose
   design is customized for this scene gets the deck's real tab panes -
   fetched from deck.html - bound to that scene's copy of its design; the
   backgrounds get the deck's own background editor. One binder and one set
   of controls for the deck and the Canvas Builder alike. Every change goes
   through setField/exec, so undo, merging and autosave work as everywhere.

   canvas.js builds the inspector (layerInspector, sceneInspector) from the
   section builders here, then calls mountInspector once per build and
   syncInspector on every change. */
'use strict';

let feedState = null;                          // the latest snapshot: designs, fonts
const openSecs = new Set(['type', 'scene-bg', 'scene-format']); // which sections are open - a view choice
const TYPE_NAME = { text: 'Text', image: 'Picture or video', background: 'Background', shape: 'Shape',
  component: 'Window', camera: 'Camera', capture: 'Screen or window', reactive: 'Reactive image' };
const COMP_NAME = { np: 'Now Playing', lyrics: 'Lyrics', queue: 'Queue', captions: 'Captions' };
// Where each component's design lives in the snapshot (as embedhost.js reads it), and its scope in the deck.
const DESIGN_KEY = { np: 'nowplaying', lyrics: 'lyrics_cfg', queue: 'queue_cfg', captions: 'captions_cfg' };
const DESIGN_SCOPE = { np: ['np', ''], lyrics: ['ly', 'ly'], queue: ['q', 'q'], captions: ['cap', 'cap'] };
// The deck's tabs that are the window's look (not its size, its buttons or what it listens to).
const DECK_PANES = {
  np: [['layout', 'Colors'], ['text', 'Text'], ['bits', 'Art & bar'], ['decor', 'Decor']],
  lyrics: [['lyrics', 'Look'], ['lyrics-text', 'Text']],
  queue: [['queue', 'Look'], ['queue-text', 'Text']],
  captions: [['captions', 'Look'], ['captions-text', 'Text']],
};
const DECK_BG = { np: { key: 'np', attr: 'np', out: '', prefix: 'bg' },
  lyrics: { key: 'lyrics', attr: 'ly', out: 'ly', prefix: 'bg_own' },
  queue: { key: 'queue', attr: 'q', out: 'q', prefix: 'bg_own' },
  captions: { key: 'captions', attr: 'cap', out: 'cap', prefix: 'bg_own' } };
// Settings on those tabs that are about the window, not its look: left out here.
const NOT_DESIGN = { np: ['interactive'], lyrics: ['online', 'interactive', 'offset'], queue: ['interactive'], captions: [] };
const HIDE_PARTS = {
  np: [['art', 'Album art'], ['progress', 'Progress bar'], ['times', 'Times'], ['label', 'Label'],
       ['kaomoji', 'Emoticon'], ['source', 'Source badge'], ['transport', 'Buttons']],
  lyrics: [['header', 'Song title']], queue: [['header', 'Heading']], captions: [],
};

/* Values a layer has when it does not say (what the runtime assumes). */
const DEFAULTS = {
  'props.design': 'linked', 'props.options.card_bg': true, 'props.options.frame': true, 'props.options.card_alpha': 1,
  'props.enter.kind': '', 'props.enter.ms': 500, 'props.enter.delay': 0,
  'props.motion.kind': '', 'props.motion.seconds': 3, 'props.motion.amount': 1,
  'props.decor.sides': 'none', 'props.decor.size': 0.62, 'props.decor.gap': 0.5, 'props.decor.opacity': 0.85,
  'props.decor.speed': 1, 'props.decor.border': '',
  'props.size': 48, 'props.weight': 700, 'props.align': 'center', 'props.valign': 'center', 'props.line': 1.2,
  'props.letter': 0, 'props.color': '#ffffff', 'props.gradient.on': false, 'props.gradient.angle': 90,
  'props.gradient.c1': '#ffffff', 'props.gradient.c2': '#8b5cf6', 'props.stroke.w': 0, 'props.stroke.color': '#000000',
  'props.shadow.x': 0, 'props.shadow.y': 0, 'props.shadow.blur': 0, 'props.shadow.color': '#000000',
  'props.pill.on': false, 'props.pill.color': 'rgba(0, 0, 0, 0.55)', 'props.pill.pad': 12, 'props.pill.radius': 16,
  'props.loop': true, 'props.muted': true, 'props.rate': 1, 'props.tile_size': 128,
  'props.mirror': true, 'props.fps': 30, 'props.mask': 'none', 'props.blink_every': 4000, 'props.bounce': 0,
  'props.pad': 24, 'props.hole_radius': 16, 'props.kind': 'rect', 'props.fill': 'rgba(255, 255, 255, 0.9)',
  'style.border.w': 0, 'style.border.color': '#ffffff', 'style.shadow.x': 0, 'style.shadow.y': 0,
  'style.shadow.blur': 0, 'style.shadow.color': '#000000', 'style.blur': 0,
  'style.crop.t': 0, 'style.crop.r': 0, 'style.crop.b': 0, 'style.crop.l': 0,
};
const TYPE_DEFAULTS = {
  image: { 'props.fit': 'cover' }, camera: { 'props.fit': 'cover', 'props.mode': '' },
  capture: { 'props.fit': 'contain', 'props.mode': 'auto' }, reactive: { 'props.fit': 'contain' },
  shape: { 'props.stroke.color': '#ffffff' },
};
function defaultOf(l, path) {
  const t = TYPE_DEFAULTS[l.type];
  return t && path in t ? t[path] : DEFAULTS[path];
}
function deletePath(obj, path) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) { if (!o || typeof o !== 'object') return; o = o[keys[i]]; }
  if (o && typeof o === 'object') delete o[keys[keys.length - 1]];
}
const oneLayer = () => { const s = selected(); return s.length === 1 ? s[0] : null; };

/* ------------------------------------------------------------- scopes */

/* A scope is what a set of controls edits: get(path), set(path, value),
   clear(path), and patch(entries) for several fields in one step. */
const LX = {
  attr: 'lx', out: 'lx',
  get(path) {
    const l = oneLayer();
    if (!l) return undefined;
    const v = getPath(l, path);
    return v === undefined ? defaultOf(l, path) : v;
  },
  set(path, v, node) {
    const l = oneLayer();
    if (!l) return;
    if (node && node.dataset.num) v = Number(v);
    setField(l.id, path, v);
  },
  clear(path) { const l = oneLayer(); if (l) setField(l.id, path, ''); },
  patch(entries, label) {
    const l = oneLayer();
    if (!l) return false;
    return exec(label || 'edit', (s) => {
      const x = s.layers.find((y) => y.id === l.id);
      if (x) for (const [p, v] of entries) { if (v === undefined) deletePath(x, p); else setPath(x, p, v); }
    });
  },
};
const SX = {
  attr: 'sx', out: 'sx',
  get: (path) => (store.scene ? getPath(store.scene, path) : undefined),
  set: (path, v, node) => setField('', path, node && node.dataset.num ? Number(v) : v),
  clear: (path) => setField('', path, ''),
  patch: (entries, label) => exec(label || 'edit', (s) => { for (const [p, v] of entries) { if (v === undefined) deletePath(s, p); else setPath(s, p, v); } }),
};
/* One scene's copy of a component's design: what it changes sits on top of
   the deck's design (embedhost.js merges it), the rest keeps following it. */
function customScope(comp, id) {
  const [attr, out] = DESIGN_SCOPE[comp];
  const base = () => (feedState && feedState[DESIGN_KEY[comp]]) || {};
  const own = () => { const l = layerById(id); return (l && l.props && l.props.custom) || {}; };
  return {
    attr, out, comp,
    get(path) { const c = getPath(own(), path); return c !== undefined ? c : getPath(base(), path); },
    set(path, v, node) { if (node && node.dataset.num) v = Number(v); setField(id, 'props.custom.' + path, v); },
    clear(path) {
      exec('back to my design', (s) => { const l = s.layers.find((x) => x.id === id); if (l && l.props.custom) deletePath(l.props.custom, path); });
    },
    patch(entries, label) {
      return exec(label || 'edit', (s) => {
        const l = s.layers.find((x) => x.id === id);
        if (!l) return;
        l.props.custom = l.props.custom || {};
        for (const [p, v] of entries) { if (v === undefined) deletePath(l.props.custom, p); else setPath(l.props.custom, p, v); }
      });
    },
  };
}
/** The scope a control inside the inspector belongs to. */
function scopeFor(el) {
  const box = el.closest('[data-deck-design]');
  if (box && box._scope) return box._scope;
  return oneLayer() ? LX : SX;
}

/* ------------------------------------------------------------- markup */

const A = (path) => `data-lx="${path}"`;
const escA = (v) => esc(v);
function section(key, title, body) {
  return `<details class="sec" data-sec="${key}"${openSecs.has(key) ? ' open' : ''}><summary>${title}</summary><div class="sec-body">${body}</div></details>`;
}
function cRange(label, path, min, max, o = {}) {
  const { div = 1, dp = 0, unit = '', step = '', pct = false } = o;
  return `<label class="field"><span>${label} <b class="mono" data-lxout="${path}"></b>${unit}</span>` +
    `<input class="range" type="range" min="${min}" max="${max}"${step ? ` step="${step}"` : ''} ${A(path)} data-kind="range"` +
    `${div !== 1 ? ` data-div="${div}"` : ''}${dp ? ` data-dp="${dp}"` : ''}${pct ? ' data-pct="1"' : ''}></label>`;
}
const cColor = (label, path) => `<label class="field"><span>${label}</span><input class="color wide" type="color" ${A(path)} data-kind="color"></label>`;
const cRgba = (label, path) => `<div class="field"><span>${label}</span><div class="rgba" ${A(path)} data-kind="rgba">` +
  `<input class="color" type="color" aria-label="${label}"><input class="range" type="range" min="0" max="100" aria-label="${label}, opacity" title="Opacity"></div></div>`;
const cCheck = (label, path) => `<label class="check"><input type="checkbox" ${A(path)} data-kind="bool"><span>${label}</span></label>`;
const cSeg = (label, path, opts, num) => `<div class="field"><span>${label}</span><div class="segmented small" ${A(path)} data-kind="${num === 'bool' ? 'segbool' : 'seg'}"${num === true ? ' data-num="1"' : ''} aria-label="${label}">` +
  opts.map(([v, t]) => `<button data-v="${escA(v)}">${t}</button>`).join('') + '</div></div>';
const cSelect = (label, path, opts, num, extra = '') => `<label class="field"><span>${label}</span><select class="input" ${A(path)} data-kind="str"${num ? ' data-num="1"' : ''} ${extra}>` +
  opts.map(([v, t]) => `<option value="${escA(v)}">${esc(t)}</option>`).join('') + '</select></label>';
const cText = (label, path, attrs = '') => `<label class="field"><span>${label}</span><input class="input" type="text" ${A(path)} data-kind="str" ${attrs}></label>`;
const cNum = (label, path, id, attrs = '') => `<label class="field"><span>${label}</span><input class="input" ${NUM_ATTRS} data-layer="${esc(id)}" data-field="${path}" ${attrs}></label>`;
const fontField = (path, inheritLabel) => `<div class="field"><span>Font</span><div class="font-row">` +
  `<select class="input font-select" ${A(path)} data-kind="str" data-inherit="1" data-inherit-label="${escA(inheritLabel)}" aria-label="Font"></select>` +
  `<button type="button" class="btn btn-ghost btn-sm font-add">Add font…</button></div></div>`;
const assetField = (label, path, kinds, none) => `<div class="field"><span>${label}</span>` +
  `<div class="apgrid" data-apick="${path}" data-kinds="${kinds}"${none ? ' data-none="1"' : ''} role="group" aria-label="${label}"></div></div>`;

/* ---- the sections */

function typeSections(l) {
  const f = TYPE_SECTIONS[l.type];
  return f ? f(l) : '';
}
const TYPE_SECTIONS = {
  text: (l) => section('type', 'Text', `
      <label class="field"><span>Words</span><textarea class="input" rows="3" ${A('props.text')} data-kind="str"></textarea></label>
      <div class="vars" role="group" aria-label="Insert live text">${['title', 'artist', 'album', 'source', 'elapsed', 'duration', 'time', 'date', 'caption', 'caption_live']
        .map((v) => `<button type="button" class="chip" data-var="{${v}}">{${v}}</button>`).join('')}</div>
      <p class="hint">Live text fills itself in: the song, the time, what you are saying.</p>
      ${fontField('props.font', 'Default (Segoe UI)')}
      <div class="field two">${cNum('Size', 'props.size', l.id, 'data-min="6" data-max="600"')}
        ${cSelect('Weight', 'props.weight', [['300', 'Light'], ['400', 'Regular'], ['600', 'Semibold'], ['700', 'Bold'], ['800', 'Heavy'], ['900', 'Black']], true)}</div>
      ${cSeg('Align', 'props.align', [['left', 'Left'], ['center', 'Center'], ['right', 'Right']])}
      ${cSeg('In the box', 'props.valign', [['top', 'Top'], ['center', 'Middle'], ['bottom', 'Bottom']])}
      ${cRange('Letter spacing', 'props.letter', -10, 50, { div: 100, dp: 2, unit: 'em' })}
      ${cRange('Line height', 'props.line', 80, 250, { div: 100, dp: 2 })}
      <div class="checks">${cCheck('Italic', 'props.italic')}${cCheck('UPPERCASE', 'props.uppercase')}${cCheck('Shrink to fit', 'props.fit')}</div>`) +
    section('text-fill', 'Fill, stroke and glow', `
      ${cSeg('Fill', 'props.gradient.on', [['0', 'Color'], ['1', 'Gradient']], 'bool')}
      <div data-show="!props.gradient.on">${cColor('Color', 'props.color')}</div>
      <div data-show="props.gradient.on"><div class="field two">${cColor('From', 'props.gradient.c1')}${cColor('To', 'props.gradient.c2')}</div>
        ${cRange('Angle', 'props.gradient.angle', 0, 360, { unit: '°' })}</div>
      <div class="divider"></div>
      ${cRange('Stroke', 'props.stroke.w', 0, 20, { unit: 'px' })}${cColor('Stroke color', 'props.stroke.color')}
      <div class="divider"></div>
      <div class="field"><span>Shadow or glow</span><div class="row gap wrap">
        <button type="button" class="btn btn-ghost btn-sm" data-preset="glow">Glow</button>
        <button type="button" class="btn btn-ghost btn-sm" data-preset="shadow">Drop shadow</button>
        <button type="button" class="btn btn-ghost btn-sm" data-preset="noshadow">None</button></div></div>
      <div class="field two">${cRange('Across', 'props.shadow.x', -40, 40, { unit: 'px' })}${cRange('Down', 'props.shadow.y', -40, 40, { unit: 'px' })}</div>
      ${cRange('Softness', 'props.shadow.blur', 0, 80, { unit: 'px' })}${cRgba('Shadow color', 'props.shadow.color')}
      <div class="divider"></div>
      <div class="checks">${cCheck('Background pill', 'props.pill.on')}</div>
      <div data-show="props.pill.on">${cRgba('Pill color', 'props.pill.color')}
        ${cRange('Padding', 'props.pill.pad', 0, 80, { unit: 'px' })}${cRange('Roundness', 'props.pill.radius', 0, 200, { unit: 'px' })}</div>`),

  image: () => section('type', 'Picture or video', `
      ${assetField('Picture or video', 'props.src', 'image video')}
      ${cSeg('Fit', 'props.fit', [['cover', 'Cover'], ['contain', 'Contain'], ['stretch', 'Stretch'], ['tile', 'Tile']])}
      <div data-show="props.fit=tile">${cRange('Tile size', 'props.tile_size', 16, 1024, { unit: 'px' })}</div>
      <div class="checks">${cCheck('Flip across', 'props.flip_h')}${cCheck('Flip upside down', 'props.flip_v')}</div>
      <div data-show-video>
        <div class="checks">${cCheck('Loop', 'props.loop')}${cCheck('Muted', 'props.muted')}</div>
        ${cSeg('Speed', 'props.rate', [['0.5', '½×'], ['1', '1×'], ['1.5', '1½×'], ['2', '2×']], true)}
      </div>`),

  background: () => section('type', 'Background',
    bgEditorHTML({ key: 'layer', attr: 'lx', out: 'lx', prefix: 'props' })),

  shape: () => section('type', 'Shape', `
      ${cSeg('Shape', 'props.kind', [['rect', 'Box'], ['ellipse', 'Ellipse'], ['line', 'Line'], ['frame', 'Frame with a hole']])}
      <div data-show="props.kind=rect|ellipse|frame">${cRgba('Fill', 'props.fill')}
        ${cRange('Outline', 'props.stroke.w', 0, 40, { unit: 'px' })}${cColor('Outline color', 'props.stroke.color')}</div>
      <div data-show="props.kind=line">${cRange('Thickness', 'props.stroke.w', 1, 60, { unit: 'px' })}${cColor('Color', 'props.stroke.color')}</div>
      <div data-show="props.kind=frame">${cRange('Frame width', 'props.pad', 0, 300, { unit: 'px' })}
        ${cRange('Hole corners', 'props.hole_radius', 0, 300, { unit: 'px' })}
        <p class="hint">What sits under this layer shows through the hole: a game, your camera, the key color.</p></div>`),

  component: (l) => {
    const comp = (l.props && l.props.component) || 'np';
    const parts = HIDE_PARTS[comp] || [];
    return section('type', 'Window', `
      ${cSeg('Window', 'props.component', Object.entries(COMP_NAME))}
      ${cSeg('Design', 'props.design', [['linked', 'Use my design'], ['custom', 'Customize for this scene']])}
      <p class="hint" data-show="props.design=linked">Looks exactly like your ${COMP_NAME[comp]} window and changes when it does.
        Customize it to give this scene its own look: you start from your design, and only what you change is this scene's.</p>
      <div data-show="props.design=custom">
        <div class="deck-design" data-deck-design="${comp}"><p class="hint">Loading the deck's controls…</p></div>
        <button type="button" class="btn btn-ghost btn-sm" data-design-reset>Back to my design</button>
      </div>`) +
      section('embed', 'See-through', `
      <div class="checks">${cCheck('Card background', 'props.options.card_bg')}${cCheck('Card frame', 'props.options.frame')}
        ${cCheck("The window's own background", 'props.options.keep_bg')}</div>
      ${cRange('Card opacity', 'props.options.card_alpha', 0, 100, { div: 100, dp: 2 })}
      ${parts.length ? `<div class="field"><span>Leave out</span><div class="checks">${parts.map(([p, t]) =>
        `<label class="check"><input type="checkbox" data-hide-part="${p}"><span>${t}</span></label>`).join('')}</div></div>` : ''}
      <p class="hint">Turn the card off and only the words and the art sit on your scene.</p>`);
  },

  camera: () => section('type', 'Camera', `
      ${cSeg('Drawn', 'props.mode', [['', 'In the page'], ['native', 'By the app, while LIVE']])}
      <p class="hint" data-show="props.mode=native">The app puts the camera into the stream itself and the page leaves a hole here - the lightest way.</p>
      ${cSelect('Camera', 'props.device', [['', 'Windows default camera']], false, 'data-cameras')}
      <div class="field"><span>Resolution</span><div class="segmented small" data-res role="group" aria-label="Resolution">
        ${[[640, 480], [1280, 720], [1920, 1080]].map(([w, h]) => `<button type="button" data-w="${w}" data-h="${h}">${h}p</button>`).join('')}</div></div>
      ${cSeg('Frame rate', 'props.fps', [['15', '15'], ['24', '24'], ['30', '30'], ['60', '60']], true)}
      ${cSeg('Shape', 'props.mask', [['none', 'Square'], ['rounded', 'Rounded'], ['circle', 'Circle'], ['blob', 'Blob']])}
      ${cSeg('Fit', 'props.fit', [['cover', 'Fill the box'], ['contain', 'Whole picture']])}
      <div class="checks">${cCheck('Mirror', 'props.mirror')}</div>`),

  capture: () => section('type', 'Screen or window', `
      <div class="field"><span>What to show</span>
        <div class="srcgrid" data-srcgrid role="group" aria-label="Screens and windows"><p class="hint">Loading…</p></div>
        <button type="button" class="btn btn-ghost btn-sm" data-src-refresh>Look again</button></div>
      ${cSeg('Drawn', 'props.mode', [['native', 'By the app'], ['auto', 'In the page']])}
      <div data-show="props.mode=native"><div class="checks">${cCheck('Show the mouse pointer', 'props.cursor')}</div>
        <p class="hint">Captured by the app itself, like OBS: no picker, and nothing extra for Chrome to do.
          The page leaves a hole the stream fills while LIVE.</p></div>
      ${cSeg('Fit', 'props.fit', [['contain', 'Whole picture'], ['cover', 'Fill the box']])}
      ${cSeg('Frame rate', 'props.fps', [['15', '15'], ['30', '30'], ['60', '60']], true)}`),

  reactive: () => section('type', 'Reactive image', `
      ${assetField('While quiet', 'props.idle', 'image')}
      ${assetField('While talking', 'props.talking', 'image')}
      ${assetField('Blink (optional)', 'props.blink', 'image', true)}
      <div data-show="props.blink">${cRange('Blink every', 'props.blink_every', 800, 10000, { step: 100, unit: ' ms' })}</div>
      ${cRange('Bounce while talking', 'props.bounce', 0, 60, { unit: 'px' })}
      ${cSeg('Fit', 'props.fit', [['contain', 'Whole picture'], ['cover', 'Fill the box']])}
      <div class="field voice"><span>Counts as talking above <b class="mono" data-thr-out></b></span>
        <div class="meter" data-meter role="meter" aria-label="Microphone level" aria-valuemin="0" aria-valuemax="100"><i></i><s data-thr-mark></s></div>
        <input class="range" type="range" min="1" max="60" data-threshold aria-label="How loud counts as talking">
        <span class="hint" data-voice-note>For every reactive image and trigger. While captions are on, they decide instead.</span></div>
      <button type="button" class="btn btn-ghost btn-sm" data-try-talk>Try it: act as if I'm talking</button>`),
};

/* Every layer: its look and effects, a border loop, motion, triggers. */
function commonSections(l) {
  const id = esc(l.id);
  return section('look', 'Look and effects', `
      <div class="f"><span>Opacity</span><input type="range" min="0" max="100" data-layer="${id}" data-field="style.opacity" data-scale="100" aria-label="Opacity"></div>
      <div class="f"><span>Corners</span><input class="input" ${NUM_ATTRS} data-min="0" data-layer="${id}" data-field="style.radius" aria-label="Corners"></div>
      ${sel_('style.blend', l.id, [['normal', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'], ['lighten', 'Lighten'], ['darken', 'Darken']], 'Blend')}
      <div class="divider"></div>
      ${cRange('Border', 'style.border.w', 0, 40, { unit: 'px' })}${cColor('Border color', 'style.border.color')}
      ${cRange('Shadow', 'style.shadow.blur', 0, 120, { unit: 'px' })}
      <div class="field two">${cRange('Across', 'style.shadow.x', -60, 60, { unit: 'px' })}${cRange('Down', 'style.shadow.y', -60, 60, { unit: 'px' })}</div>
      ${cRgba('Shadow color', 'style.shadow.color')}
      ${cRange('Blur', 'style.blur', 0, 40, { unit: 'px' })}
      <div class="divider"></div>
      <span class="sub">Crop</span>
      <div class="field two">${cRange('Top', 'style.crop.t', 0, 90, { div: 100, pct: true, unit: '%' })}${cRange('Bottom', 'style.crop.b', 0, 90, { div: 100, pct: true, unit: '%' })}</div>
      <div class="field two">${cRange('Left', 'style.crop.l', 0, 90, { div: 100, pct: true, unit: '%' })}${cRange('Right', 'style.crop.r', 0, 90, { div: 100, pct: true, unit: '%' })}</div>`) +
    section('decor', 'Border loop', `
      <label class="field"><span>Pattern</span><select class="input" ${A('props.decor.border')} data-kind="str" data-decor-options></select></label>
      ${cText('Or type your own', 'props.decor.custom', 'maxlength="40" placeholder="e.g. ✿ ❀ ✾"')}
      ${cSeg('Sides', 'props.decor.sides', [['none', 'Off'], ['tb', 'Top & bottom'], ['all', 'All round']])}
      ${cRange('Thickness', 'props.decor.size', 20, 400, { div: 100, dp: 2, unit: 'em' })}
      ${cRange('Spacing', 'props.decor.gap', 0, 200, { div: 100, dp: 2 })}
      ${cRange('Opacity', 'props.decor.opacity', 5, 100, { div: 100, dp: 2 })}
      ${cColor('Color', 'props.decor.color')}
      <div class="checks">${cCheck('Drift', 'props.decor.animate')}</div>
      <div data-show="props.decor.animate">${cRange('Drift speed', 'props.decor.speed', 10, 500, { div: 100, dp: 2, unit: '×' })}</div>`) +
    section('motion', 'Animation', `
      ${cSelect('Comes in', 'props.enter.kind', [['', 'Just appears'], ['fade', 'Fades in'], ['rise', 'Rises'], ['drop', 'Drops in'],
        ['left', 'From the left'], ['right', 'From the right'], ['pop', 'Pops'], ['zoom', 'Zooms in']])}
      <div data-show="props.enter.kind=fade|rise|drop|left|right|pop|zoom">
        ${cRange('Takes', 'props.enter.ms', 100, 3000, { step: 50, unit: ' ms' })}${cRange('After', 'props.enter.delay', 0, 3000, { step: 50, unit: ' ms' })}
        <button type="button" class="btn btn-ghost btn-sm" data-replay>▶ Play it</button></div>
      <div class="divider"></div>
      ${cSelect('Keeps moving', 'props.motion.kind', [['', 'Stays still'], ['float', 'Floats'], ['pulse', 'Pulses'], ['sway', 'Sways'], ['spin', 'Spins']])}
      <div data-show="props.motion.kind=float|pulse|sway|spin">
        ${cRange('One cycle', 'props.motion.seconds', 5, 300, { div: 10, dp: 1, unit: ' s' })}${cRange('How much', 'props.motion.amount', 0, 300, { div: 100, dp: 2 })}</div>
      <p class="hint">It comes in when the scene opens, when a switch brings it, and when a trigger shows it.
        Ultra optimized keeps everything still.</p>`) +
    triggerSection(l);
}
const TRIG_ON = [['speaking', 'While I talk'], ['silent', "While I'm quiet"], ['speech_start', 'When I start talking']];
const TRIG_DO = [['show', 'show it'], ['hide', 'hide it'], ['bounce', 'bounce'], ['pop', 'pop'], ['class', 'add a style']];
function triggerSection(l) {
  const list = l.triggers || [];
  const opts = (arr) => arr.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join('');
  const rows = list.map((t, i) => `<div class="trig" data-trig="${i}">
      <select class="input" data-tf="on" aria-label="When, trigger ${i + 1}">${opts(TRIG_ON)}</select>
      <select class="input" data-tf="do" aria-label="Do, trigger ${i + 1}">${opts(TRIG_DO)}</select>
      <input class="input" data-tf="value" placeholder="style name" aria-label="Style name, trigger ${i + 1}">
      <button type="button" class="btn icon sm" data-trig-del aria-label="Remove trigger ${i + 1}">×</button></div>`).join('');
  return section('trig', `Triggers${list.length ? ` <span class="count">${list.length}</span>` : ''}`,
    `${rows || '<p class="hint">Nothing here reacts to your voice yet.</p>'}
     <button type="button" class="btn btn-ghost btn-sm" data-trig-add>Add a trigger</button>
     <p class="hint">Show a layer only while you talk, bounce it, pop it when you start.</p>`);
}
function sceneBackgroundSection() {
  return section('scene-bg', 'Background',
    bgEditorHTML({ key: 'scene', attr: 'sx', out: 'sx', prefix: 'background' }) +
    '<p class="hint">Shows when the output below is Opaque.</p>');
}

/* ------------------------------------------------------------- mounting */

/* Once per build of the inspector: bind the controls and fill what needs data. */
function mountInspector(root) {
  if (store.sel.size > 1 || !store.scene) return;
  const l = oneLayer();
  const sc = l ? LX : SX;
  convertPickers(root, sc === LX ? 'props' : 'background');
  bindDesign(root, sc);
  fillOptions(root);
  renderPickers(root);
  if (l && l.type === 'component') buildDeckDesign(root.querySelector('[data-deck-design]'), l);
  if (l && l.type === 'camera') fillCameras(root);
  if (l && l.type === 'capture') renderSources(root);
  if (l && l.type === 'reactive') startMeter(root);
  syncInspector(root);
}

/* On every change: values into the controls, and what shows for them. */
function syncInspector(root) {
  if (store.sel.size > 1 || !store.scene) return;
  paintZoneNotes(root);                   // what sits under TikTok's controls (newscene.js)
  const l = oneLayer();
  const sc = l ? LX : SX;
  syncDesign(root, sc);
  syncShows(root, sc);
  syncBgWhen(root, sc, l ? 'props' : 'background');
  syncPickers(root);
  const box = root.querySelector('[data-deck-design]');
  if (box && box._scope) { syncDesign(box, box._scope); syncBgWhen(box, box._scope, DECK_BG[box._scope.comp].prefix); }
  if (!l) return;
  paintLiveNote(root);
  root.querySelectorAll('[data-hide-part]').forEach((n) => { n.checked = ((l.props.options || {}).hide || []).includes(n.dataset.hidePart); });
  root.querySelectorAll('[data-trig]').forEach((row) => {
    const t = (l.triggers || [])[Number(row.dataset.trig)] || {};
    for (const f of ['on', 'do', 'value']) { const n = row.querySelector(`[data-tf="${f}"]`); if (n && n !== document.activeElement) n.value = t[f] || (f === 'value' ? '' : n.options[0].value); }
    row.querySelector('[data-tf="value"]').hidden = t.do !== 'class';
  });
  root.querySelectorAll('[data-res] button').forEach((b) => b.classList.toggle('on',
    Number(b.dataset.w) === Number(l.props.width || 1280) && Number(b.dataset.h) === Number(l.props.height || 720)));
  root.querySelectorAll('[data-show-video]').forEach((n) => { n.hidden = !isVideoSrc(l.props.src); });
  root.querySelectorAll('[data-srcgrid] [data-src]').forEach((b) => b.setAttribute('aria-pressed', String(sameSource(JSON.parse(b.dataset.src), l.props.source))));
}

/* Show a block only when a setting says so: data-show="path", "!path", or "path=a|b". */
function syncShows(root, sc) {
  root.querySelectorAll('[data-show]').forEach((n) => {
    let expr = n.dataset.show, neg = false;
    if (expr[0] === '!') { neg = true; expr = expr.slice(1); }
    const [path, vals] = expr.split('=');
    const v = sc.get(path);
    const on = vals === undefined ? !!v : vals.split('|').includes(String(v ?? ''));
    n.hidden = neg ? on : !on;
  });
}
/* The background editors show the controls of the mode in use (as the deck's do). */
function syncBgWhen(root, sc, prefix) {
  const mode = sc.get(prefix + '.mode') || 'solid';
  root.querySelectorAll('.bg-when').forEach((sec) => {
    if (sec.closest('[data-deck-design]') && !root.matches('[data-deck-design]')) return;   // the box syncs its own
    sec.hidden = !sec.dataset.when.split(' ').includes(mode);
  });
}

const userFonts = () => (feedState && feedState.fonts) || [];
function fillOptions(root) {
  root.querySelectorAll('select.font-select').forEach((sel) => {
    const keep = sel.value;
    sel.innerHTML = fontOptionsFor(userFonts(), sel.dataset.inherit === '1', sel.dataset.inheritLabel || 'Same as Now Playing');
    sel.value = keep;
  });
  root.querySelectorAll('select[data-decor-options]').forEach((sel) => { sel.innerHTML = decorOptions(escHTML); });
  root.querySelectorAll('select[data-kao-options]').forEach((sel) => {
    sel.innerHTML = KAOMOJI.map((k) => `<option value="${escHTML(k)}">${k ? escHTML(k) : '- none -'}</option>`).join('');
  });
}

/* The background editors' pickers become the Canvas Builder's: its asset
   grid (with upload and drop) and the artwork thumbnails. */
function convertPickers(root, prefix) {
  root.querySelectorAll('.asset-picker[data-assets]').forEach((el) => {
    el.className = 'apgrid';
    el.dataset.apick = prefix + '.image';
    el.dataset.kinds = 'image';
    el.dataset.mode = prefix;
    el.removeAttribute('data-assets');
  });
  root.querySelectorAll('.scene-picker[data-scenes]').forEach((el) => {
    el.className = 'scpick';
    el.dataset.scpick = prefix;
    el.removeAttribute('data-scenes');
  });
  root.querySelectorAll('[data-bgact="frame"], [data-bgact="theme"]').forEach((b) => b.remove());
  root.querySelectorAll('[data-bgact]').forEach((b) => { b.type = 'button'; b.dataset.prefix = prefix; });
}

/* The pictures come from the Assets tab's list, which loads the first time
   it is needed - by that tab, or by a picker here. */
let assetsAsked = false;
function ensureAssets(root) {
  if (assetsAsked) return;
  assetsAsked = true;
  loadAssets().then(() => {
    const ins = $('inspector');
    ins.querySelectorAll('[data-apick]').forEach(renderAssetGrid);
    syncPickers(ins);
  });
}
function renderPickers(root) {
  if (root.querySelector('[data-apick]')) ensureAssets(root);
  root.querySelectorAll('[data-apick]').forEach(renderAssetGrid);
  root.querySelectorAll('[data-scpick]').forEach((el) => {
    el.innerHTML = Object.entries(SCENES).map(([id, sc]) =>
      `<button type="button" class="scene-thumb" data-scene-id="${id}" title="${escHTML(sc.label)}" aria-label="${escHTML(sc.label)}"><span class="scene-thumb-img"></span><span>${escHTML(sc.label)}</span></button>`).join('');
    el.querySelectorAll('.scene-thumb').forEach((b) => {
      const img = b.querySelector('.scene-thumb-img');
      paintScene(img, b.dataset.sceneId, {});
      if (!SCENES[b.dataset.sceneId].cover) img.style.backgroundSize = '90px 90px';
    });
  });
  syncPickers(root);
}
function syncPickers(root) {
  root.querySelectorAll('[data-apick]').forEach((el) => {
    const cur = scopeFor(el).get(el.dataset.apick) || '';
    el.querySelectorAll('[data-ap-id]').forEach((b) => { const on = b.dataset.apId === cur; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  });
  root.querySelectorAll('[data-scpick]').forEach((el) => {
    const sc = scopeFor(el), p = el.dataset.scpick;
    const cur = sc.get(p + '.mode') === 'scene' ? (sc.get(p + '.scene.id') || '') : '';
    el.querySelectorAll('[data-scene-id]').forEach((b) => { const on = b.dataset.sceneId === cur; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  });
}
const assetThumb = (a) => (a.kind === 'video' && !a.thumb
  ? `<video muted preload="metadata" src="${esc(a.url)}"></video>` : `<img loading="lazy" alt="" src="${esc(a.thumb || a.url)}">`);
function renderAssetGrid(el) {
  const kinds = (el.dataset.kinds || 'image video').split(' ');
  const list = assets.filter((a) => kinds.includes(a.kind || 'image'));
  el.innerHTML = (el.dataset.none ? '<button type="button" class="ap none" data-ap-id="">None</button>' : '') +
    list.map((a) => `<button type="button" class="ap" data-ap-id="${esc(a.id)}" title="${esc(a.name)}" aria-label="${esc(a.name)}">${assetThumb(a)}</button>`).join('') +
    '<button type="button" class="ap up" data-ap-upload title="Upload a picture or video - or drop one here"><b>+</b><span>Upload</span></button>';
}
const isVideoSrc = (src) => { const a = assets.find((x) => x.id === src); return a ? a.kind === 'video' : /\.(webm|mp4|m4v)$/i.test(src || ''); };

/* ---- uploads: one hidden file input, whichever picker asked */

let uploadTarget = null;
function pickUpload(grid) { uploadTarget = grid; $('pickFile').click(); }
$('pickFile').addEventListener('change', async () => {
  const f = $('pickFile').files[0];
  $('pickFile').value = '';
  if (f && uploadTarget) await uploadInto(uploadTarget, f);
  uploadTarget = null;
});
async function uploadInto(grid, file) {
  if (!/^(image|video)\//.test(file.type)) { toast('That is not a picture or a video'); return; }
  let data;
  try { data = await readDataURL(file); } catch (_) { toast('Could not read ' + file.name); return; }
  const d = await (await fetch('/api/assets/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, data }) })).json().catch(() => ({}));
  if (!d.ok) { toast(d.reason || 'Could not upload that'); return; }
  await loadAssets();
  pickAsset(grid, d.id);
  document.querySelectorAll('#inspector [data-apick]').forEach(renderAssetGrid);
  syncPickers($('inspector'));
  announce('Uploaded ' + file.name);
}
function pickAsset(grid, id) {
  const sc = scopeFor(grid), path = grid.dataset.apick;
  if (grid.dataset.mode) sc.patch([[path, id], [grid.dataset.mode + '.mode', id ? 'image' : 'solid']], 'set picture');
  else sc.patch([[path, id]], 'set picture');
}

/* ---- the component's design: the deck's own tabs */

let deckDocP = null;
function deckDoc() {
  if (!deckDocP) deckDocP = fetch('/deck.html').then((r) => r.text()).then((t) => new DOMParser().parseFromString(t, 'text/html')).catch(() => (deckDocP = null));
  return deckDocP;
}
/* A deck pane, made fit for a scene: the deck's own wiring (ids, buttons that
   act on the deck) comes off, the window-only settings go, the controls stay. */
function cleanPane(pane, comp) {
  const [attr] = DESIGN_SCOPE[comp];
  const bound = `[data-${attr}]`;
  pane.querySelectorAll('[id]').forEach((n) => {
    if (n.matches(bound)) n.removeAttribute('id');
    else n.remove();
  });
  for (const path of NOT_DESIGN[comp] || []) {
    pane.querySelectorAll(`[data-${attr}="${path}"]`).forEach((n) => (n.closest('label.check, label.field, .field') || n).remove());
  }
  pane.querySelectorAll('p.hint').forEach((p) => { if (/TikTok Studio|preview/i.test(p.textContent)) p.remove(); });
  pane.querySelectorAll('.pt-tools, .picture-themes, .font-chips').forEach((n) => n.remove());
  // A field with nothing left to set in it is noise.
  pane.querySelectorAll('.field, label.field').forEach((f) => {
    if (!f.querySelector(bound) && !f.querySelector('.asset-picker, .scene-picker')) f.remove();
  });
  pane.querySelectorAll(`select[data-${attr}="decor.border"]`).forEach((s) => { s.dataset.decorOptions = '1'; });
  pane.querySelectorAll(`select[data-${attr}="decor.kaomoji"]`).forEach((s) => { s.dataset.kaoOptions = '1'; });
  pane.querySelectorAll('button:not([type])').forEach((b) => { b.type = 'button'; });
  return pane;
}
async function buildDeckDesign(box, l) {
  if (!box) return;
  const comp = box.dataset.deckDesign, id = l.id;
  const doc = await deckDoc();
  if (!doc || !box.isConnected) { if (box.isConnected) box.innerHTML = '<p class="hint">The deck\'s controls did not load.</p>'; return; }
  const tabs = [];
  for (const [name, title] of DECK_PANES[comp]) {
    const src = doc.querySelector(`.tabpane[data-pane="${name}"]`);
    if (src) tabs.push([title, cleanPane(src.cloneNode(true), comp)]);
  }
  const bg = document.createElement('div');
  bg.innerHTML = bgEditorHTML(DECK_BG[comp]);
  tabs.push(['Background', cleanPane(bg, comp)]);
  box.innerHTML = `<div class="subtabs" role="tablist" aria-label="${COMP_NAME[comp]} design">` +
    tabs.map(([t], i) => `<button type="button" role="tab" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" data-subtab="${i}">${esc(t)}</button>`).join('') + '</div>';
  tabs.forEach(([, pane], i) => {
    pane.className = 'deckpane';
    pane.setAttribute('role', 'tabpanel');
    pane.dataset.subpane = String(i);
    pane.hidden = i !== 0;
    box.appendChild(pane);
  });
  const sc = customScope(comp, id);
  box._scope = sc;
  convertPickers(box, DECK_BG[comp].prefix);
  bindDesign(box, sc);
  fillOptions(box);
  renderPickers(box);
  syncDesign(box, sc);
  syncBgWhen(box, sc, DECK_BG[comp].prefix);
}

/* ---- camera, capture, voice */

let cameraNames = null;
async function fillCameras(root) {
  const sel = root.querySelector('select[data-cameras]');
  if (!sel) return;
  if (!cameraNames) {
    try { cameraNames = (await (await fetch('/api/camera/devices', { cache: 'no-store' })).json()).cameras || []; } catch (_) { cameraNames = []; }
  }
  if (!sel.isConnected) return;
  sel.innerHTML = '<option value="">Windows default camera</option>' + cameraNames.map((n) => `<option value="${escHTML(n)}">${escHTML(n)}</option>`).join('');
  writeControl(sel, 'str', LX.get('props.device') || '');
}

let sources = null, thumbTimer = null;
const sameSource = (a, b) => !!a && !!b && a.kind === b.kind && (a.kind === 'monitor' ? Number(a.monitor || 0) === Number(b.monitor || 0) : a.title === b.title);
async function renderSources(root, again) {
  const grid = root.querySelector('[data-srcgrid]');
  if (!grid) return;
  if (!sources || again) {
    try { sources = await (await fetch('/api/capture/sources', { cache: 'no-store' })).json(); } catch (_) { sources = { windows: [], monitors: [] }; }
  }
  if (!grid.isConnected) return;
  const items = [
    ...(sources.monitors || []).map((m, i) => ({ src: { kind: 'monitor', monitor: i }, title: m.name || `Screen ${i + 1}`, thumb: `/api/capture/thumb?monitor=${i}` })),
    ...(sources.windows || []).filter((w) => w.title).slice(0, 40).map((w) => ({ src: { kind: 'window', title: w.title }, title: w.title, thumb: w.hwnd ? `/api/capture/thumb?hwnd=${w.hwnd}` : '' })),
  ];
  grid.innerHTML = items.length ? items.map((it) =>
    `<button type="button" class="src" data-src="${escHTML(JSON.stringify(it.src))}" title="${escHTML(it.title)}">` +
    (it.thumb ? `<img alt="" data-thumb="${escHTML(it.thumb)}" src="${escHTML(it.thumb)}">` : '<span class="noimg"></span>') +
    `<span>${escHTML(it.title)}</span></button>`).join('') : '<p class="hint">No windows to capture.</p>';
  syncInspector($('inspector'));
  // Live thumbnails while the list is on screen: a fresh picture every few seconds, then nothing.
  clearInterval(thumbTimer);
  thumbTimer = setInterval(() => {
    if (!grid.isConnected) { clearInterval(thumbTimer); return; }
    if (document.hidden || !grid.closest('details').open) return;
    grid.querySelectorAll('img[data-thumb]').forEach((img) => { img.src = img.dataset.thumb + '&t=' + Math.floor(performance.now()); });
  }, 3000);
}

let meterTimer = null, thrTimer = null;
function startMeter(root) {
  const meter = root.querySelector('[data-meter]');
  if (!meter) return;
  const bar = meter.querySelector('i'), mark = meter.querySelector('[data-thr-mark]');
  const slider = root.querySelector('[data-threshold]'), out = root.querySelector('[data-thr-out]');
  const note = root.querySelector('[data-voice-note]');
  let first = true;
  const paint = (d) => {
    const level = Math.round((d.level || 0) * 100), thr = Math.round((d.threshold ?? 0.08) * 100);
    bar.style.width = level + '%';
    meter.setAttribute('aria-valuenow', String(level));
    meter.classList.toggle('talking', !!d.speaking);
    mark.style.left = thr + '%';
    if (first || document.activeElement !== slider) { slider.value = String(thr); out.textContent = thr + '%'; }
    first = false;
    note.textContent = d.source === 'captions' ? 'Captions are listening, so their own speech detector decides right now.'
      : d.source === 'off' ? 'The microphone opens while a scene uses your voice.'
      : 'For every reactive image and trigger.';
  };
  clearTimeout(meterTimer);
  const tick = () => {
    if (!meter.isConnected) return;
    if (document.hidden || !meter.closest('details').open) { meterTimer = setTimeout(tick, 600); return; }
    fetch('/api/voice', { cache: 'no-store' }).then((r) => r.json()).then(paint).catch(() => {})
      .finally(() => { meterTimer = setTimeout(tick, isUltra() ? 1000 : 150); });
  };
  tick();
  slider.addEventListener('input', () => {
    out.textContent = slider.value + '%';
    mark.style.left = slider.value + '%';
    clearTimeout(thrTimer);
    thrTimer = setTimeout(() => {
      fetch('/api/voice', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threshold: Number(slider.value) / 100 }) }).then((r) => r.json()).then(paint).catch(() => {});
    }, 120);
  });
}

/* ------------------------------------------------------------- actions */

const ins = $('inspector');
ins.addEventListener('toggle', (e) => {
  const d = e.target;
  if (!d.matches || !d.matches('details.sec')) return;
  if (d.open) openSecs.add(d.dataset.sec); else openSecs.delete(d.dataset.sec);
}, true);

ins.addEventListener('click', (e) => {
  const t = e.target;
  const l = oneLayer();
  const b = (sel) => t.closest(sel);
  let n;
  if ((n = b('[data-var]'))) {
    const area = ins.querySelector('textarea[data-lx="props.text"]');
    if (!area) return;
    const s0 = area.selectionStart ?? area.value.length, s1 = area.selectionEnd ?? s0;
    area.value = area.value.slice(0, s0) + n.dataset.var + area.value.slice(s1);
    area.focus();
    area.selectionStart = area.selectionEnd = s0 + n.dataset.var.length;
    area.dispatchEvent(new Event('input', { bubbles: true }));
  } else if ((n = b('[data-preset]')) && l) {
    const acc = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#8b5cf6';
    const P = { glow: { x: 0, y: 0, blur: 18, color: acc }, shadow: { x: 0, y: 4, blur: 10, color: 'rgba(0, 0, 0, 0.6)' }, noshadow: { x: 0, y: 0, blur: 0, color: '#000000' } }[n.dataset.preset];
    LX.patch([['props.shadow', P]], n.dataset.preset === 'noshadow' ? 'no shadow' : n.dataset.preset);
  } else if ((n = b('[data-design-reset]')) && l) {
    LX.patch([['props.custom', undefined], ['props.design', 'linked']], 'back to my design');
    inspSig = '';
    renderInspector();
  } else if ((n = b('[data-res] button')) && l) {
    LX.patch([['props.width', Number(n.dataset.w)], ['props.height', Number(n.dataset.h)]], 'resolution');
  } else if ((n = b('[data-src]')) && l) {
    LX.patch([['props.source', JSON.parse(n.dataset.src)]], 'source');
  } else if ((n = b('[data-src-refresh]'))) {
    renderSources(ins, true);
  } else if ((n = b('[data-try-talk]'))) {
    const post = (speaking) => fetch('/api/voice/override', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ speaking }) });
    post(true).then(() => setTimeout(() => post(null), 1500));
  } else if ((n = b('[data-trig-add]')) && l) {
    exec('add trigger', (s) => { const x = s.layers.find((y) => y.id === l.id); x.triggers = (x.triggers || []).concat([{ on: 'speaking', do: 'show' }]); });
    openSecs.add('trig');
    inspSig = '';
    renderInspector();
  } else if ((n = b('[data-trig-del]')) && l) {
    const i = Number(n.closest('[data-trig]').dataset.trig);
    exec('remove trigger', (s) => { const x = s.layers.find((y) => y.id === l.id); x.triggers.splice(i, 1); });
    inspSig = '';
    renderInspector();
  } else if ((n = b('[data-replay]')) && l) {
    const w = $('sceneFrame').contentWindow;
    if (w) w.postMessage({ type: 'editor-replay', id: l.id }, location.origin);
  } else if ((n = b('[data-ap-upload]'))) {
    pickUpload(n.closest('[data-apick]'));
  } else if ((n = b('[data-ap-id]'))) {
    pickAsset(n.closest('[data-apick]'), n.dataset.apId);
  } else if ((n = b('[data-scene-id]'))) {
    const grid = n.closest('[data-scpick]');
    const sc = scopeFor(grid), p = grid.dataset.scpick;
    sc.patch([[p + '.mode', 'scene'], [p + '.scene.id', n.dataset.sceneId]], 'artwork');
  } else if ((n = b('[data-bgact]'))) {
    const sc = scopeFor(n), p = n.dataset.prefix || 'props';
    const act = n.dataset.bgact;
    if (act === 'sceneReset') sc.patch([[p + '.scene.c1', undefined], [p + '.scene.c2', undefined], [p + '.scene.c3', undefined]], "artwork's own colors");
    else if (act === 'sceneShuffle') sc.patch([[p + '.scene.seed', 1 + Math.floor(Math.random() * 99999)]], 'shuffle artwork');
    else if (act === 'clearImage') sc.patch([[p + '.image', ''], [p + '.mode', 'solid']], 'clear picture');
    else if (act === 'upload') { const g = n.closest('.bg-when, .deckpane, .sec-body').querySelector('[data-apick]'); if (g) pickUpload(g); }
  } else if ((n = b('[data-subtab]'))) {
    const box = n.closest('[data-deck-design]');
    showSubtab(box, Number(n.dataset.subtab), false);
  } else if ((n = b('.font-add'))) {
    fontTarget = n.closest('.field, .font-row').querySelector('select.font-select');
    $('fontFile').click();
  }
});
function showSubtab(box, i, focus) {
  box.querySelectorAll('[data-subtab]').forEach((t) => {
    const on = Number(t.dataset.subtab) === i;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    if (on && focus) t.focus();
  });
  box.querySelectorAll('[data-subpane]').forEach((p) => { p.hidden = Number(p.dataset.subpane) !== i; });
}
ins.addEventListener('keydown', (e) => {
  const t = e.target.closest && e.target.closest('[data-subtab]');
  if (!t || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
  e.preventDefault();
  const box = t.closest('[data-deck-design]');
  const n = box.querySelectorAll('[data-subtab]').length;
  showSubtab(box, (Number(t.dataset.subtab) + (e.key === 'ArrowRight' ? 1 : n - 1)) % n, true);
});

ins.addEventListener('change', (e) => {
  const t = e.target;
  const l = oneLayer();
  if (!l) return;
  if (t.dataset.hidePart) {
    const part = t.dataset.hidePart, on = t.checked;
    exec(on ? 'leave out ' + part : 'show ' + part, (s) => {
      const x = s.layers.find((y) => y.id === l.id);
      x.props.options = x.props.options || {};
      const hide = new Set(x.props.options.hide || []);
      if (on) hide.add(part); else hide.delete(part);
      x.props.options.hide = [...hide];
    });
  } else if (t.dataset.tf && t.dataset.tf !== 'value') {
    const i = Number(t.closest('[data-trig]').dataset.trig);
    exec('trigger', (s) => {
      const x = s.layers.find((y) => y.id === l.id);
      const tr = x.triggers[i];
      tr[t.dataset.tf] = t.value;
      // A pop happens when talking starts, and that moment only pops.
      if (t.dataset.tf === 'do' && t.value === 'pop') tr.on = 'speech_start';
      if (t.dataset.tf === 'on' && t.value === 'speech_start') tr.do = 'pop';
      if (t.dataset.tf === 'on' && t.value !== 'speech_start' && tr.do === 'pop') tr.do = 'show';
      if (tr.do !== 'class') delete tr.value;
    }, 'trig:' + l.id + ':' + i);
  }
});
ins.addEventListener('input', (e) => {
  const t = e.target;
  const l = oneLayer();
  if (!l || t.dataset.tf !== 'value') return;
  const i = Number(t.closest('[data-trig]').dataset.trig);
  const v = t.value.replace(/[^a-z0-9_-]/gi, '').slice(0, 30);
  exec('trigger', (s) => { s.layers.find((y) => y.id === l.id).triggers[i].value = v; }, 'trigv:' + l.id + ':' + i);
});

// Files dropped on a picture grid are uploaded into it.
ins.addEventListener('dragover', (e) => {
  const g = e.target.closest && e.target.closest('[data-apick]');
  if (!g) return;
  e.preventDefault();
  g.classList.add('drop');
});
ins.addEventListener('dragleave', (e) => { const g = e.target.closest && e.target.closest('[data-apick]'); if (g) g.classList.remove('drop'); });
ins.addEventListener('drop', (e) => {
  const g = e.target.closest && e.target.closest('[data-apick]');
  if (!g) return;
  e.preventDefault();
  g.classList.remove('drop');
  const f = [...(e.dataTransfer.files || [])][0];
  if (f) uploadInto(g, f);
});

// Add font: the menu the button sits next to switches to the new family.
let fontTarget = null;
$('fontFile').addEventListener('change', async () => {
  const files = [...$('fontFile').files];
  $('fontFile').value = '';
  const res = await uploadFonts(files);
  for (const msg of res.failed) toast(msg);
  if (!res.family) return;
  if (feedState) feedState.fonts = [...new Set([...(feedState.fonts || []), res.family])];
  fillOptions(ins);
  if (fontTarget && fontTarget.isConnected) {
    writeControl(fontTarget, 'str', res.family);
    fontTarget.dispatchEvent(new Event('change', { bubbles: true }));
  }
  fontTarget = null;
  toast(`Added “${res.family}” - it is in every font menu now`);
});

/* ------------------------------------------------------------- the feed */

let fontsSig = '';
function inspectorsOnState(s) {
  feedState = s;
  syncUserFonts(s.fonts_v);
  const sig = (s.fonts || []).join('\n');
  if (sig !== fontsSig) { fontsSig = sig; fillOptions(ins); syncInspector(ins); }
  // The deck changed a design: the linked values shown in a customized one move with it.
  const box = ins.querySelector('[data-deck-design]');
  if (box && box._scope) syncDesign(box, box._scope);
}

/* ------------------------------------------------------------- live sources */

/* Whenever the editor itself has a camera or a screen open (the preview
   draws "in the page" sources for real), say so: in the top bar, on the
   layer's row, and at the top of its inspector. */
let liveIds = new Set();
function pollLiveMedia() {
  if (document.hidden) return;
  let list = [];
  try { const w = $('sceneFrame').contentWindow; list = (w && w.SceneDebug) ? w.SceneDebug.layers() : []; } catch (_) { list = []; }
  const on = list.filter((x) => (x.type === 'camera' || x.type === 'capture') && x.media);
  const ids = new Set(on.map((x) => x.id));
  const cam = on.some((x) => x.type === 'camera'), cap = on.some((x) => x.type === 'capture');
  const badge = $('mediaLive');
  badge.hidden = !on.length;
  badge.textContent = cam && cap ? 'Camera and screen on' : cam ? 'Camera on' : 'Screen capture on';
  badge.title = 'The editor has ' + (cam && cap ? 'your camera and a screen' : cam ? 'your camera' : 'a screen') + ' open for its preview';
  if ([...ids].join() !== [...liveIds].join()) {
    liveIds = ids;
    document.querySelectorAll('#layerTree .row[data-id]').forEach((r) => r.classList.toggle('live-src', ids.has(r.dataset.id)));
  }
  paintLiveNote(ins);
}
/* The inspector's line for a live source - drawn with the inspector too, so a rebuild does not lose it. */
function paintLiveNote(root) {
  const note = root.querySelector('[data-live-note]');
  const l = oneLayer();
  if (!note) return;
  note.hidden = !(l && liveIds.has(l.id));
  note.textContent = l && l.type === 'camera' ? 'Live in the editor: your camera is on' : 'Live in the editor: capturing';
}
setInterval(pollLiveMedia, 1000);
document.addEventListener('visibilitychange', pollLiveMedia);

/* For tests. */
Object.assign(window.Editor, {
  inspector: () => ({ secs: [...ins.querySelectorAll('details.sec')].map((d) => d.dataset.sec), open: [...openSecs] }),
  openSection: (key, on = true) => { if (on) openSecs.add(key); else openSecs.delete(key); const d = ins.querySelector(`details.sec[data-sec="${key}"]`); if (d) d.open = on; },
  liveMedia: () => ({ shown: !$('mediaLive').hidden, text: $('mediaLive').textContent, ids: [...liveIds] }),
  design: (id) => { const l = layerById(id); return l ? clone(l.props.custom || {}) : null; },
});
