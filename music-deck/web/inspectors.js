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
  component: 'Window', camera: 'Camera', capture: 'Screen or window', reactive: 'You, talking',
  mic: 'Microphone', effect: 'Effect', alert: 'Alert', poll: 'Poll', speak: 'Voice', gift: 'Gift',
  goal: 'Coin goal', topgifters: 'Top gifters' };
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
  capture: { 'props.fit': 'contain', 'props.mode': 'native' }, reactive: { 'props.fit': 'contain' },
  shape: { 'props.stroke.color': '#ffffff' },
  // What commands.py's layer_command() assumes when these are unset.
  effect: { 'props.role': 'everyone', 'props.cooldown': 0, 'props.user_cooldown': 0 },
  // The same fallbacks tts.py, server.py's command_speak and scene.js use -
  // an inspector showing a default the runtime does not apply would lie.
  speak: { 'props.role': 'everyone', 'props.cooldown': 0, 'props.user_cooldown': 0, 'props.voice': '',
    'props.rate': 0, 'props.volume': 0.9, 'props.maxlen': 150, 'props.max': 3, 'props.sayname': true,
    'props.show': true },
  // scene.js TYPES.gift.opts() falls back to exactly these.
  gift: { 'props.mode': 'both', 'props.min': 0, 'props.only': '', 'props.target': '', 'props.seconds': 4,
    'props.max_objects': 30, 'props.object_size': 64, 'props.coin': 220 },
  // scene.js TYPES.goal.opts() and TYPES.topgifters.opts() fall back to exactly these.
  goal: { 'props.title': 'Coin goal', 'props.target': 1000, 'props.done': 'Goal reached!', 'props.bar': '#f5b50a' },
  topgifters: { 'props.title': 'Top gifters', 'props.count': 3, 'props.showcoins': true, 'props.hideempty': true,
    'props.accent': '#f5b50a' },
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
/* `attrs` rides on the <details> itself, so a whole section can carry a
   data-show and come and go with a setting - syncShows sets hidden on anything
   that has one, and it runs on the sync pass, so the section appears the
   moment the setting changes rather than waiting for a rebuild. */
function section(key, title, body, attrs = '') {
  return `<details class="sec" data-sec="${key}"${openSecs.has(key) ? ' open' : ''}${attrs ? ' ' + attrs : ''}><summary>${title}</summary><div class="sec-body">${body}</div></details>`;
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
  poll: (l) => section('type', 'Poll', `
      <p class="hint">Shows the poll that is running and the bars filling up. Start one from the Live
        view, or with a command. Nothing is shown while no poll is open.</p>
      ${fontField('props.font', 'Default (Segoe UI)')}
      <div class="field two">${cNum('Size', 'props.size', l.id, 'data-min="8" data-max="200"')}
        ${cNum('Corner', 'props.radius', l.id, 'data-min="0" data-max="80"')}</div>
      ${cColor('Words', 'props.color')}
      ${cColor('Behind', 'props.bg')}
      ${cColor('Bars', 'props.bar')}
      ${cNum('Keep the result up for (seconds)', 'props.linger', l.id, 'data-min="0" data-max="600"')}`),
  alert: (l) => section('type', 'Alert', `
      <p class="hint">Shows nothing until something happens - a command someone ran, a song that went
        into the queue. Leave the kinds empty to show all of them.</p>
      <label class="field"><span>Only these kinds</span>
        <input class="input" ${A('props.kinds')} data-kind="str" placeholder="gift follow command" spellcheck="false"></label>
      <div class="field two">${cNum('Seconds on screen', 'props.seconds', l.id, 'data-min="1" data-max="60"')}
        ${cNum('Most waiting', 'props.max', l.id, 'data-min="1" data-max="20"')}</div>
      ${fontField('props.font', 'Default (Segoe UI)')}
      <div class="field two">${cNum('Size', 'props.size', l.id, 'data-min="8" data-max="200"')}
        ${cNum('Corner', 'props.radius', l.id, 'data-min="0" data-max="80"')}</div>
      ${cColor('Words', 'props.color')}
      ${cColor('Behind', 'props.bg')}`),
  effect: (l) => section('type', 'Effect', `
      <p class="hint">Shows a picture or a clip when something happens, then hides again. Pick the
        picture from Assets. Leave the kinds empty to show it for everything.</p>
      ${assetField('Picture or clip', 'props.src', 'image gif video', true)}
      <label class="field"><span>Only these kinds</span>
        <input class="input" ${A('props.kinds')} data-kind="str" placeholder="gift follow command" spellcheck="false"></label>
      <div class="field two">${cNum('Seconds on screen', 'props.seconds', l.id, 'data-min="1" data-max="60"')}
        ${cNum('Most waiting', 'props.max', l.id, 'data-min="1" data-max="20"')}</div>
      ${cSeg('Fit', 'props.fit', [['cover', 'Cover'], ['contain', 'Contain'], ['stretch', 'Stretch']])}
      ${assetField('Sound', 'props.sound', 'audio', true)}
      ${cRange('Volume', 'props.volume', 0, 100, { div: 100, dp: 2 })}
      <p class="hint">A sound command names its own clip; this one plays when the event does not
        bring one. A layer with a sound and no picture shows nothing and just plays.</p>`) + layerCommandSection(l),
  speak: (l) => section('type', 'Voice', `
      <p class="hint">Reads chat out loud in a Windows voice, made on this PC - nothing is sent anywhere.
        Chat sets it off with the command below and a message; only the scene on air listens.</p>
      <label class="field"><span>Voice</span><select class="input" ${A('props.voice')} data-kind="str" data-voices></select></label>
      ${cRange('Speed', 'props.rate', -5, 5)}
      ${cRange('Volume', 'props.volume', 0, 100, { div: 100, dp: 2 })}
      <div class="field two">${cNum('Longest message (letters)', 'props.maxlen', l.id, 'data-min="20" data-max="500"')}
        ${cNum('Most waiting', 'props.max', l.id, 'data-min="1" data-max="10"')}</div>
      <label class="field"><span>Never read out</span><textarea class="input" rows="2" ${A('props.blocked')} data-kind="str"
        placeholder="words or phrases, one per line or separated by commas" spellcheck="false"></textarea></label>
      <p class="hint">A message with one of these in it is not read at all. Links are read as "a link", and
        "aaaaaaa" as "aaa". The wait per person below is the rest of it - start at 30 seconds.</p>
      ${cCheck('Say who sent it ("Amy says: ...")', 'props.sayname')}
      ${cCheck('Show the words on screen while they are read', 'props.show')}
      <div class="field"><span>Hear it</span><div class="font-row">
        <input class="input" data-tts-sample value="This is how chat will sound." spellcheck="false" aria-label="Words to hear">
        <button type="button" class="btn btn-ghost btn-sm" data-tts-try>Play</button></div></div>
      <p class="hint" data-tts-note aria-live="polite">Plays here in the editor, never on stream.</p>
      ${fontField('props.font', 'Default (Segoe UI)')}
      <div class="field two">${cNum('Size', 'props.size', l.id, 'data-min="8" data-max="200"')}
        ${cNum('Corner', 'props.radius', l.id, 'data-min="0" data-max="80"')}</div>
      ${cColor('Words', 'props.color')}
      ${cColor('Behind', 'props.bg')}`) + layerCommandSection(l),
  gift: (l) => section('type', 'Gift', `
      <p class="hint">What a gift looks like on stream: a coin spinning with the sender's picture on it,
        one thing thrown for every coin, or both. TikTok gifts arrive here once TikTok is connected -
        until then, try it below. Only this editor sees that.</p>
      ${cSeg('Show', 'props.mode', [['both', 'Coin and throws'], ['coin', 'Just the coin'], ['throw', 'Just the throws']])}
      <div class="field two">${cNum('Only gifts of at least (coins)', 'props.min', l.id, 'data-min="0" data-max="1000000"')}
        ${cNum('Seconds on screen', 'props.seconds', l.id, 'data-min="1" data-max="30"')}</div>
      <label class="field"><span>Only these gifts</span>
        <input class="input" ${A('props.only')} data-kind="str" placeholder="Rose, Galaxy - empty for every gift" spellcheck="false"></label>
      <label class="field"><span>Throw them at</span><select class="input" ${A('props.target')} data-kind="str" data-gift-targets></select></label>
      ${assetField('What gets thrown', 'props.object', 'image gif', true)}
      <div class="field two">${cNum('Most in the air at once', 'props.max_objects', l.id, 'data-min="1" data-max="60"')}
        ${cNum('Size of each', 'props.object_size', l.id, 'data-min="16" data-max="240"')}</div>
      <p class="hint">One thing per coin, up to the most in the air. A bigger gift throws them faster
        rather than throwing more, so a 5,000-coin gift cannot freeze the stream.</p>
      ${assetField('On the coin when the sender has no picture', 'props.face', 'image', true)}
      ${cNum('Coin size', 'props.coin', l.id, 'data-min="60" data-max="600"')}
      <div class="field"><span>Try it</span><div class="font-row">
        <input class="input" type="number" min="1" max="100000" value="25" data-gift-coins aria-label="Coins in the test gift">
        <button type="button" class="btn btn-ghost btn-sm" data-gift-try>Send a test gift</button></div></div>
      <p class="hint">Plays in this editor only, never on stream.</p>
      ${fontField('props.font', 'Default (Segoe UI)')}
      <div class="field two">${cNum('Size', 'props.size', l.id, 'data-min="8" data-max="200"')}
        ${cNum('Corner', 'props.radius', l.id, 'data-min="0" data-max="80"')}</div>
      ${cColor('Words', 'props.color')}
      ${cColor('Behind', 'props.bg')}`),
  goal: (l) => section('type', 'Coin goal', `
      <p class="hint">A bar filling with the coins gifted this stream, toward a number you choose. It counts
        what the Live view's Gifts box counts, from its last "Reset the count".</p>
      ${cText('Title', 'props.title', 'maxlength="60" spellcheck="false"')}
      ${cNum('Goal (coins)', 'props.target', l.id, 'data-min="1" data-max="100000000"')}
      ${cText('Title once it is reached', 'props.done', 'maxlength="60" spellcheck="false"')}
      ${fontField('props.font', 'Default (Segoe UI)')}
      <div class="field two">${cNum('Size', 'props.size', l.id, 'data-min="8" data-max="200"')}
        ${cNum('Corner', 'props.radius', l.id, 'data-min="0" data-max="80"')}</div>
      ${cColor('Words', 'props.color')}
      ${cColor('Behind', 'props.bg')}
      ${cColor('Bar', 'props.bar')}`),
  topgifters: (l) => section('type', 'Top gifters', `
      <p class="hint">Who gifted the most coins this stream, from the Live view's last "Reset the count".
        Names are shown as the words people chose for themselves, and nothing more.</p>
      ${cText('Title', 'props.title', 'maxlength="60" spellcheck="false"')}
      ${cNum('How many', 'props.count', l.id, 'data-min="1" data-max="10"')}
      ${cCheck('Show their coins', 'props.showcoins')}
      ${cCheck('Hidden until someone has gifted', 'props.hideempty')}
      ${fontField('props.font', 'Default (Segoe UI)')}
      <div class="field two">${cNum('Size', 'props.size', l.id, 'data-min="8" data-max="200"')}
        ${cNum('Corner', 'props.radius', l.id, 'data-min="0" data-max="80"')}</div>
      ${cColor('Words', 'props.color')}
      ${cColor('Behind', 'props.bg')}
      ${cColor('Numbers', 'props.accent')}`),
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
      ${assetField('Picture or video', 'props.src', 'image gif video')}
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
        ${cSeg('Hole shape', 'props.shape', [['rect', 'Square'], ['rounded', 'Rounded'], ['circle', 'Circle']])}
        <div data-show="props.shape=rounded">${cRange('Hole corners', 'props.hole_radius', 0, 300, { unit: 'px' })}</div>
        ${cSeg('Through the hole', 'props.hole', [['clear', 'See-through'], ['key', 'A key color']])}
        <div data-show="props.hole=key">${cColor('Key color', 'props.key_color')}</div>
        <p class="hint">What sits under this layer shows through the hole: a game, your camera, the key color.</p></div>`)
    + section('frame-edge', 'The frame around it', `
      ${cSeg('Edge', 'props.border.style', [['solid', 'Solid'], ['double', 'Double'], ['dashed', 'Dashed'], ['glow', 'Glow'], ['none', 'None']])}
      <div data-show="!props.border.style=none">
        ${cRange('Edge width', 'props.border.width', 0, 60, { unit: 'px' })}${cColor('Edge color', 'props.border.color')}</div>
      <div class="divider"></div>
      ${cText('Title', 'props.title.text')}
      <div data-show="props.title.text">
        ${cSeg('Title at the', 'props.title.place', [['top', 'Top'], ['bottom', 'Bottom']])}
        ${cRange('Title size', 'props.title.size', 40, 300, { div: 100, dp: 2 })}${cColor('Title color', 'props.title.color')}</div>
      <div class="divider"></div>
      <div class="field two">${cText('Top left', 'props.badges.tl')}${cText('Top right', 'props.badges.tr')}</div>
      <div class="field two">${cText('Bottom left', 'props.badges.bl')}${cText('Bottom right', 'props.badges.br')}</div>
      ${cRange('Badge size', 'props.badges.size', 40, 300, { div: 100, dp: 2 })}${cColor('Badge color', 'props.badges.color')}
      <p class="hint">The same frame the Screen frame and Camera frame windows draw, in the scene itself.
        A border loop goes on under Decor, like any layer.</p>`, 'data-show="props.kind=frame"'),

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

  mic: () => section('type', 'Microphone', `
      <p class="hint">Your own voice, drawn on the scene. This page listens to the
        microphone itself - nothing is recorded and nothing is sent anywhere.</p>
      ${cSelect('Microphone', 'props.device', [['', 'Windows default microphone']], false, 'data-mics')}
      ${cSeg('Drawn as', 'props.style', [['bars', 'Bars'], ['level', 'One bar'], ['wave', 'Waveform']])}
      <div data-show="props.style=bars">${cRange('How many bars', 'props.bars', 4, 64)}</div>
      ${cColor('Color', 'props.color')}
      ${cRange('Sensitivity', 'props.gain', 20, 400, { div: 100, dp: 2, unit: '×' })}
      ${cRange('Smoothing', 'props.smooth', 0, 95, { div: 100, dp: 2 })}
      <p class="hint">Which microphone the stream uses, how loud it is, and what counts as
        talking are all in the Sound panel; this is only how it looks here.</p>`),

  capture: () => section('type', 'Screen or window', `
      <div class="field"><span>What to show</span>
        <div class="srcgrid" data-srcgrid role="group" aria-label="Screens and windows"><p class="hint">Loading…</p></div>
        <button type="button" class="btn btn-ghost btn-sm" data-src-refresh>Look again</button></div>
      ${cSeg('How it is captured', 'props.mode', [['native', 'By the app (best)'], ['auto', 'By the browser']])}
      <div data-show="props.mode=native"><div class="checks">${cCheck('Show the mouse pointer', 'props.cursor')}</div>
        <p class="hint">The app captures it itself, the way OBS does - the lightest way, and what your viewers see.
          Here in the editor you get a picture of it that refreshes every second or two.</p></div>
      <p class="hint" data-show="props.mode=auto">The browser captures it instead, the way a web page does. Chrome has to
        be told which window at the moment it starts, so this usually cannot begin inside the editor and the box falls
        back to the app's own picture - keep "By the app" unless it gives you trouble.</p>
      ${cSeg('Fit', 'props.fit', [['contain', 'Whole picture'], ['cover', 'Fill the box']])}
      ${cSeg('Frame rate', 'props.fps', [['15', '15'], ['30', '30'], ['60', '60']], true)}`),

  reactive: () => section('type', 'You, talking', `
      <p class="hint">A PNGtuber: two pictures of you, swapped over as your
        microphone hears you start and stop talking. Everything it needs is on
        this one screen.</p>
      ${assetField('While quiet', 'props.idle', 'image gif')}
      ${assetField('While talking', 'props.talking', 'image gif')}
      ${assetField('Blink (optional)', 'props.blink', 'image gif', true)}
      <div data-show="props.blink">${cRange('Blink every', 'props.blink_every', 800, 10000, { step: 100, unit: ' ms' })}</div>
      ${cRange('Bounce while talking', 'props.bounce', 0, 60, { unit: 'px' })}
      ${cSeg('Fit', 'props.fit', [['contain', 'Whole picture'], ['cover', 'Fill the box']])}
      <div class="field voice"><span>Counts as talking above <b class="mono" data-thr-out></b></span>
        <div class="meter" data-meter role="meter" aria-label="Microphone level" aria-valuemin="0" aria-valuemax="100"><i></i><s data-thr-mark></s></div>
        <input class="range" type="range" min="1" max="60" data-threshold aria-label="How loud counts as talking">
        <span class="hint" data-voice-note>For every "You, talking" layer and every trigger. While captions are on, they decide instead.</span></div>
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
/* Two moments and four things to do, and the two fields no longer have to be
   kept in step with each other - see applyTriggers in scene.js. "While I'm
   quiet" was the same sentence inverted, "pop" was an action welded to one
   moment, and "add a style" asked for the name of a CSS rule that had to exist
   somewhere else. */
const TRIG_ON = [['speaking', 'While I talk'], ['speech_start', 'When I start talking']];
const TRIG_DO = [['show', 'show it'], ['hide', 'hide it'], ['bounce', 'bounce'], ['glow', 'glow']];
function triggerSection(l) {
  const list = l.triggers || [];
  const opts = (arr) => arr.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join('');
  const rows = list.map((t, i) => `<div class="trig" data-trig="${i}">
      <select class="input" data-tf="on" aria-label="When, trigger ${i + 1}">${opts(TRIG_ON)}</select>
      <select class="input" data-tf="do" aria-label="Do, trigger ${i + 1}">${opts(TRIG_DO)}</select>
      <input class="color wide" type="color" data-tf="value" aria-label="Glow color, trigger ${i + 1}" title="The glow's color">
      <button type="button" class="btn icon sm" data-trig-del aria-label="Remove trigger ${i + 1}">×</button></div>`).join('');
  return section('trig', `Triggers${list.length ? ` <span class="count">${list.length}</span>` : ''}`,
    `${rows || '<p class="hint">Nothing here reacts to your voice yet.</p>'}
     <button type="button" class="btn btn-ghost btn-sm" data-trig-add>Add a trigger</button>
     <p class="hint">Your voice, and one thing it does: show a layer only while you talk, bounce it,
       or light it up - a glow follows the layer's own shape, so a round camera or a frame's ring
       lights up rather than a rectangle around it. "When I start talking" does it once.
       To swap a picture while you talk, add a <b>You, talking</b> layer.</p>`);
}
/* T11: the chat command a layer answers to. The layer is the setup - the
   command lives in its props, so deleting the layer deletes the command, and
   there is no second form somewhere else to keep in step with it.
   commands.py's layer_command() reads these four props and nothing else. */
// "follower" is TikTok's to say, and means followers and gifters (commands.py
// ROLES); Twitch chat says neither, so there it lets in subscribers and up.
const CMD_ROLES = [['everyone', 'Anyone'], ['follower', 'Followers, gifters and up'], ['subscriber', 'Subscribers and up'],
  ['vip', 'VIPs and up'], ['mod', 'Moderators and me'], ['broadcaster', 'Only me']];
const CMD_WAITS = [[0, 'No wait'], [5, '5 s'], [10, '10 s'], [30, '30 s'], [60, '1 min'], [300, '5 min'], [900, '15 min']];
// A price: coins the chatter has gifted this stream (gifts.py; commands.py
// clean). Your mods and you never need any.
const CMD_COINS = [[0, 'No price'], [1, '1 coin'], [10, '10 coins'], [50, '50 coins'], [100, '100 coins'],
  [500, '500 coins'], [1000, '1,000 coins']];
const LAYER_CMD_TYPES = ['effect', 'speak'];  // commands.py LAYER_TYPES
const cmdName = (v) => String(v || '').trim().toLowerCase().replace(/^[^a-z0-9_]+/, '');
function layerCommandSection() {
  return section('cmd', 'Chat command', `
      ${cText('Command', 'props.command', 'placeholder="airhorn" spellcheck="false" maxlength="33" autocomplete="off"')}
      ${cSelect('Who may run it', 'props.role', CMD_ROLES)}
      <div class="field two">${cSelect('Wait, for anyone', 'props.cooldown', CMD_WAITS, true)}
        ${cSelect('Wait, per person', 'props.user_cooldown', CMD_WAITS, true)}</div>
      ${cSelect('Needs coins gifted this stream', 'props.coins', CMD_COINS, true, 'title="The least someone must have gifted you this stream, in TikTok coins. Your mods and you never need any."')}
      <p class="hint" data-cmd-note aria-live="polite"></p>`);
}
/* /api/commands, for the note: the symbol in force and the list's names. Read
   each time an effect layer's inspector is built, so a command added to the
   list a minute ago is a conflict here now. */
let cmdInfo = null;
async function loadCmdInfo(root) {
  try { cmdInfo = await (await fetch('/api/commands', { cache: 'no-store' })).json(); } catch (_) { cmdInfo = null; }
  if (root.isConnected) paintCmdNote(root);
}
/* What the name will do, in words - and the reasons it might not: not a
   usable name, the Commands list has it (the list answers), another layer on
   this scene took it first, or the layer is hidden. Then whether anything
   answers yet at all, because only the scene on air listens. */
function paintCmdNote(root) {
  const n = root.querySelector('[data-cmd-note]');
  const l = oneLayer();
  if (!n || !l) return;
  const raw = cmdName((l.props || {}).command);
  const sym = ((cmdInfo && cmdInfo.symbol) || '!')[0];
  const say = (t, warn) => { n.textContent = t; n.classList.toggle('warn', !!warn); };
  const voice = l.type === 'speak';
  if (!raw) {
    return say(voice
      ? 'Give it a name - "tts" is the usual one - and chat can type it with a message to have the message read out. The Commands list in the Live view is for everything else.'
      : 'Give it a name and chat can set this layer off - it shows its own picture and plays its own sound. The Commands list in the Live view is for everything else.');
  }
  if (!/^[a-z0-9_][a-z0-9_-]{0,31}$/.test(raw)) return say('A command name is letters, numbers, _ or -, with no spaces. This one will not answer.', true);
  if (cmdInfo && (cmdInfo.commands || []).some((c) => c.name === raw)) {
    return say(`${sym}${raw} is also in the Commands list, and that one answers. Rename one of them.`, true);
  }
  const first = store.scene.layers.find((x) => LAYER_CMD_TYPES.includes(x.type) && x.visible !== false
    && cmdName((x.props || {}).command) === raw);
  if (first && first.id !== l.id) return say(`${sym}${raw} already belongs to ${first.name || 'another layer'} on this scene, which answers first.`, true);
  if (l.visible === false) return say('This layer is hidden, so it answers to nothing.', true);
  const live = ((feedState && feedState.canvas) || {}).live === store.scene.id;
  const does = voice ? 'and a message to have it read out' : 'to set this layer off';
  say(live ? `Chat can type ${sym}${raw} ${does}.` : `Chat can type ${sym}${raw} ${does}, once this scene is on air.`);
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
  if (l && l.type === 'mic') fillMics(root);
  if (l && l.type === 'capture') renderSources(root);
  if (l && l.type === 'reactive') startMeter(root);
  if (l && LAYER_CMD_TYPES.includes(l.type)) loadCmdInfo(root);
  if (l && l.type === 'speak') fillVoices(root);
  if (l && l.type === 'gift') fillGiftTargets(root);
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
  if (LAYER_CMD_TYPES.includes(l.type)) paintCmdNote(root);
  root.querySelectorAll('[data-hide-part]').forEach((n) => { n.checked = ((l.props.options || {}).hide || []).includes(n.dataset.hidePart); });
  root.querySelectorAll('[data-trig]').forEach((row) => {
    const t = (l.triggers || [])[Number(row.dataset.trig)] || {};
    for (const f of ['on', 'do', 'value']) {
      const n = row.querySelector(`[data-tf="${f}"]`);
      // A color input with no value shows black; white is the glow's default.
      if (n && n !== document.activeElement) n.value = t[f] || (f === 'value' ? '#ffffff' : n.options[0].value);
    }
    row.querySelector('[data-tf="value"]').hidden = t.do !== 'glow';
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
// Sound has no picture of itself, so it gets a name and a mark rather than an
// <img> pointed at an .mp3 - which draws the browser's broken-image icon and
// looks like the file is damaged.
const assetThumb = (a) => (a.kind === 'audio'
  ? '<span class="ap-audio" aria-hidden="true">&#9835;</span>'
  : a.kind === 'video' && !a.thumb
    ? `<video muted preload="metadata" src="${esc(a.url)}"></video>`
    : `<img loading="lazy" alt="" src="${esc(a.thumb || a.url)}">`);
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
  // The deck hides this button's text and paints the arrow with a mask
  // (deck.css). canvas.html does not load deck.css, so these clones were
  // showing the raw U+21BB character at 12 px inside a 26 px ring - the
  // walk-through's "unlabeled empty circle", which an earlier pass cleared
  // after photographing the deck's own dots rather than these. Measured in the
  // editor: 8 of them, text "U+21BB", no ::before at all, no accessible name.
  pane.querySelectorAll('.reset-dot').forEach((b) => {
    b.innerHTML = svgIcon('reset');
    if (!b.getAttribute('aria-label')) b.setAttribute('aria-label', b.getAttribute('title') || 'Reset to theme');
  });
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

/* The microphone layer's device list, the same way. The names come from the
   audio route the LIVE panel already uses (WASAPI's own friendly names), not
   from enumerateDevices, so the editor and the Sound panel offer one list. */
let micNames = null;
async function fillMics(root) {
  const sel = root.querySelector('select[data-mics]');
  if (!sel) return;
  if (!micNames) {
    try { micNames = (await (await fetch('/api/live/devices', { cache: 'no-store' })).json()).capture || []; } catch (_) { micNames = []; }
  }
  if (!sel.isConnected) return;
  sel.innerHTML = '<option value="">Windows default microphone</option>' + micNames.map((n) => `<option value="${escHTML(n)}">${escHTML(n)}</option>`).join('');
  writeControl(sel, 'str', LX.get('props.device') || '');
}

/* The Voice layer's voices (T7): Windows' installed ones, from the helper.
   Only a list that came back is kept, so a first try while PowerShell was
   still starting does not leave the picker empty for the rest of the session. */
let voiceNames = null;
async function fillVoices(root) {
  const sel = root.querySelector('select[data-voices]');
  if (!sel) return;
  let list = voiceNames;
  if (!list) {
    try { list = ((await (await fetch('/api/tts/voices', { cache: 'no-store' })).json()).voices || []); } catch (_) { list = []; }
    if (list.length) voiceNames = list;
  }
  if (!sel.isConnected) return;
  sel.innerHTML = '<option value="">Windows default voice</option>' + list.map((v) =>
    `<option value="${escHTML(v.name)}">${escHTML(v.name)}${v.culture ? ` (${escHTML(v.culture)})` : ''}</option>`).join('');
  writeControl(sel, 'str', LX.get('props.voice') || '');
}

/* The Gift layer's "Throw them at" (T8): the other layers on this scene, by
   name. A camera is the usual choice - "thrown at the streamer's portrait". */
function fillGiftTargets(root) {
  const sel = root.querySelector('select[data-gift-targets]');
  const l = oneLayer();
  if (!sel || !l || !store.scene) return;
  const others = store.scene.layers.filter((x) => x.id !== l.id && x.type !== 'background');
  sel.innerHTML = '<option value="">The middle of this layer</option>' + others.map((x) =>
    `<option value="${escHTML(x.id)}">${escHTML(x.name || TYPE_NAME[x.type] || x.type)}</option>`).join('');
  writeControl(sel, 'str', LX.get('props.target') || '');
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
  // A change not yet saved wins over the poll: a reply landing inside the
  // debounce used to put the old value back, and the timer then saved that.
  let first = true, edits = 0, saving = false;
  const paint = (d, asked = edits) => {
    const level = Math.round((d.level || 0) * 100), thr = Math.round((d.threshold ?? 0.08) * 100);
    bar.style.width = level + '%';
    meter.setAttribute('aria-valuenow', String(level));
    meter.classList.toggle('talking', !!d.speaking);
    const current = !saving && asked === edits;
    if (current) mark.style.left = thr + '%';
    if (current && (first || document.activeElement !== slider)) { slider.value = String(thr); out.textContent = thr + '%'; }
    first = false;
    note.textContent = d.source === 'captions' ? 'Captions are listening, so their own speech detector decides right now.'
      : d.source === 'off' ? 'The microphone opens while a scene uses your voice.'
      : 'For every "You, talking" layer and every trigger.';
  };
  clearTimeout(meterTimer);
  const tick = () => {
    if (!meter.isConnected) return;
    if (document.hidden || !meter.closest('details').open) { meterTimer = setTimeout(tick, 600); return; }
    const asked = edits;
    fetch('/api/voice', { cache: 'no-store' }).then((r) => r.json()).then((d) => paint(d, asked)).catch(() => {})
      .finally(() => { meterTimer = setTimeout(tick, isUltra() ? 1000 : 150); });
  };
  tick();
  slider.addEventListener('input', () => {
    const n = ++edits, value = Number(slider.value);
    saving = true;
    out.textContent = value + '%';
    mark.style.left = value + '%';
    clearTimeout(thrTimer);
    thrTimer = setTimeout(() => {
      const done = () => { if (n === edits) saving = false; };
      fetch('/api/voice', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threshold: value / 100 }) }).then((r) => r.json())
        .then((d) => { done(); paint(d, n); }).catch(done);
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
      // Nothing to keep in step any more: either moment takes any action. The
      // old pair moved each other about - picking "pop" changed the when, and
      // changing the when put the action back to "show it".
      if (tr.do !== 'glow') delete tr.value;
    }, 'trig:' + l.id + ':' + i);
  }
});
ins.addEventListener('input', (e) => {
  const t = e.target;
  const l = oneLayer();
  if (!l || t.dataset.tf !== 'value') return;
  const i = Number(t.closest('[data-trig]').dataset.trig);
  // The only thing this field carries now is the glow's color, so the old
  // [^a-z0-9_-] scrub for a CSS class name would have eaten the leading #.
  const v = /^#[0-9a-f]{6}$/i.test(t.value) ? t.value.toLowerCase() : '';
  exec('trigger', (s) => { s.layers.find((y) => y.id === l.id).triggers[i].value = v; }, 'trigv:' + l.id + ':' + i);
});

// The Voice layer's "Hear it" (T7): made by the same helper chat's clips are,
// with this layer's voice and speed, and played in this page - never on stream.
ins.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-tts-try]');
  const l = oneLayer();
  if (!b || !l) return;
  const p = l.props || {};
  const note = ins.querySelector('[data-tts-note]');
  const sample = ins.querySelector('[data-tts-sample]');
  const tell = (t) => { if (note) note.textContent = t; };
  b.disabled = true;
  tell('Making it - the first one takes a second or two while Windows starts the voice.');
  try {
    const d = await (await fetch('/api/tts/test', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: sample ? sample.value : '', voice: p.voice || '', rate: Number(p.rate) || 0,
        maxlen: p.maxlen, blocked: p.blocked || '' }) })).json();
    if (!d.ok) { tell(d.error || 'The voice could not say that.'); return; }
    const a = new Audio(d.clip);
    a.volume = Math.max(0, Math.min(1, p.volume === undefined ? 0.9 : Number(p.volume) || 0));
    await a.play().catch(() => {});
    tell('Playing here in the editor, never on stream.');
  } catch (_) {
    tell('The app did not answer.');
  } finally {
    b.disabled = false;
  }
});

// The Gift layer's "Try it" (T8): a sample gift sent to the editor's own
// preview frame for this layer alone - never to the server, so never on air.
ins.addEventListener('click', (e) => {
  const b = e.target.closest('[data-gift-try]');
  const l = oneLayer();
  if (!b || !l) return;
  const box = ins.querySelector('[data-gift-coins]');
  const coins = Math.max(1, Math.min(100000, Math.floor(Number(box && box.value) || 25)));
  const w = $('sceneFrame').contentWindow;
  if (w) w.postMessage({ type: 'editor-gift', id: l.id, detail: { user: 'You', gift: 'a test gift', coins, count: 1 } }, location.origin);
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
  /* Only the sections on screen: a section with a data-show (the frame panel)
     is in the DOM for every shape and shown for a Frame, so counting the DOM
     would report a panel the user cannot see - and would go on passing if the
     data-show broke and it showed for everything. */
  inspector: () => ({ secs: [...ins.querySelectorAll('details.sec')].filter((d) => !d.hidden).map((d) => d.dataset.sec), open: [...openSecs] }),
  openSection: (key, on = true) => { if (on) openSecs.add(key); else openSecs.delete(key); const d = ins.querySelector(`details.sec[data-sec="${key}"]`); if (d) d.open = on; },
  liveMedia: () => ({ shown: !$('mediaLive').hidden, text: $('mediaLive').textContent, ids: [...liveIds] }),
  design: (id) => { const l = layerById(id); return l ? clone(l.props.custom || {}) : null; },
});
