/* The deck's design controls, shared by the deck and the Canvas Builder (P9).

   A control is plain markup: data-<scope>="path" names the setting it
   edits, data-kind says how it reads (str, int, float, range, color, bool,
   seg, segbool, rgba), a range shows its value in data-<out>out="path" and
   is scaled by data-div. The deck binds its scopes to its own config
   (deck.js); the Canvas Builder binds the very same markup - the deck's own
   tab panes, and its background editor - to a layer, or to one scene's copy
   of a component's design, with bindDesign/syncDesign below. */

const FONTS = ['Segoe UI', 'Segoe UI Variable Display', 'Arial', 'Arial Black',
  'Bahnschrift', 'Calibri', 'Cambria', 'Candara', 'Comic Sans MS', 'Consolas',
  'Constantia', 'Corbel', 'Courier New', 'Franklin Gothic Medium', 'Gabriola',
  'Georgia', 'Impact', 'Ink Free', 'Lucida Console', 'Lucida Sans Unicode',
  'Palatino Linotype', 'Rockwell', 'Sitka Display', 'Tahoma', 'Times New Roman',
  'Trebuchet MS', 'Verdana'];
const FONT_EXT = /\.(ttf|otf|woff2?)$/i;

const escHTML = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** A font menu: fonts people added first, then the Windows ones. */
function fontOptionsFor(userFonts, inherit, inheritLabel = 'Same as Now Playing') {
  const opt = (f) => `<option value="${escHTML(f)}" style="font-family:'${escHTML(f)}'">${escHTML(f)}</option>`;
  let html = inherit ? `<option value="">${escHTML(inheritLabel)}</option>` : '';
  if (userFonts && userFonts.length) html += `<optgroup label="Your fonts">${userFonts.map(opt).join('')}</optgroup>`;
  return html + `<optgroup label="Windows fonts">${FONTS.map(opt).join('')}</optgroup>`;
}

function readDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Upload font files. Returns the last family added, the store's list, and what failed. */
async function uploadFonts(files) {
  let family = null, fonts = null;
  const failed = [];
  for (const file of files.filter((f) => FONT_EXT.test(f.name))) {
    let data;
    try { data = await readDataURL(file); } catch (_) { failed.push(`Could not read ${file.name}`); continue; }
    let res = null;
    try {
      res = await (await fetch('/api/fonts/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, data }) })).json();
    } catch (_) { /* reported below */ }
    if (!res || !res.ok) { failed.push((res && res.reason) || 'Could not add that font'); continue; }
    fonts = res.fonts || fonts;
    family = res.family;
  }
  return { family, fonts, failed };
}

/* A color with its opacity, as one CSS value: "#rrggbb" when solid,
   "rgba(r, g, b, a)" when not. */
function parseColor(v) {
  const s = String(v || '').trim();
  let m = s.match(/^#([0-9a-f]{3})$/i);
  if (m) return { hex: '#' + m[1].split('').map((c) => c + c).join('').toLowerCase(), a: 1 };
  m = s.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (m) return { hex: '#' + m[1].toLowerCase(), a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i);
  if (m) {
    const hex = '#' + [m[1], m[2], m[3]].map((n) => Math.max(0, Math.min(255, Math.round(+n))).toString(16).padStart(2, '0')).join('');
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4];
    return { hex, a: Math.max(0, Math.min(1, a)) };
  }
  return null;
}
function composeColor(hex, a) {
  if (!(a < 1)) return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.round(a * 100) / 100})`;
}

function readControl(node, kind) {
  const div = +(node.dataset.div || 1);
  if (kind === 'bool') return node.checked;
  if (kind === 'int') return Math.round(+node.value);
  if (kind === 'float') return +node.value;
  if (kind === 'range') return div === 1 ? +node.value : +node.value / div;
  if (kind === 'rgba') {
    const c = node.querySelector('input[type="color"]'), r = node.querySelector('input[type="range"]');
    return composeColor(c.value, r ? +r.value / 100 : 1);
  }
  return node.value;
}

function writeControl(node, kind, value) {
  const div = +(node.dataset.div || 1);
  if (kind === 'bool') node.checked = !!value;
  else if (kind === 'range') node.value = String(Math.round((value ?? 0) * div));
  else if (kind === 'color') node.value = /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#000000';
  else if (kind === 'rgba') {
    const p = parseColor(value) || { hex: '#ffffff', a: 1 };
    const c = node.querySelector('input[type="color"]'), r = node.querySelector('input[type="range"]');
    c.value = p.hex;
    if (r) r.value = String(Math.round(p.a * 100));
  } else {
    // A menu whose saved choice is not on offer any more (a removed font, an
    // unplugged microphone) says so, instead of silently showing another one.
    if (node.tagName === 'SELECT' && value && ![...node.options].some((o) => o.value === String(value))) {
      node.add(new Option(`${value} (not available)`, value));
    }
    node.value = value ?? '';
  }
}

function showOut(scope, key, node, root = document) {
  // The readout next to this control first: two controls can edit one setting.
  const sel = `[data-${scope}out="${CSS.escape(key)}"]`;
  const near = node.closest && node.closest('label, .field');
  const out = (near && near.querySelector(sel)) || root.querySelector(sel);
  if (!out || out === node) return;
  const dp = +(node.dataset.dp || 0);
  const div = +(node.dataset.div || 1);
  let v = div === 1 ? +node.value : +node.value / div;
  if (node.dataset.pct) v *= 100;                   // stored as a share, shown as a percentage
  out.textContent = dp ? v.toFixed(dp) : String(Math.round(v));
}

/* Bind every control of one scope inside `root`. sc = { attr, out, get(path),
   set(path, value, node), clear(path) } - set is called as the control
   changes; clear by the reset dots (data-clear). */
function bindDesign(root, sc) {
  root.querySelectorAll(`[data-${sc.attr}]`).forEach((node) => {
    const path = node.getAttribute('data-' + sc.attr);
    const kind = node.dataset.kind || 'str';
    if (kind === 'seg' || kind === 'segbool') {
      node.setAttribute('role', 'group');
      node.querySelectorAll('button').forEach((btn) => {
        btn.type = 'button';
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          node.querySelectorAll('button').forEach((b) => { b.classList.toggle('on', b === btn); b.setAttribute('aria-pressed', String(b === btn)); });
          sc.set(path, kind === 'segbool' ? btn.dataset.v === '1' : btn.dataset.v, node);
        });
      });
      return;
    }
    // data-commit="change" saves a text field once, when you are done with it.
    const typed = node.type === 'text' || node.tagName === 'TEXTAREA';
    const event = node.dataset.commit || ((kind === 'range' || kind === 'rgba' || node.type === 'color' || typed) ? 'input' : 'change');
    node.addEventListener(event, () => {
      if (kind === 'range') showOut(sc.out, path, node, root);
      sc.set(path, readControl(node, kind), node);
    });
  });
  root.querySelectorAll('[data-clear]').forEach((btn) => {
    if ((btn.dataset.scope || sc.attr) !== sc.attr) return;
    btn.type = 'button';
    btn.addEventListener('click', () => {
      if (sc.clear) sc.clear(btn.dataset.clear); else sc.set(btn.dataset.clear, '', btn);
      syncDesign(root, sc);
    });
  });
}

/** Show the current values in one scope's controls (leaving the one being typed in alone). */
function syncDesign(root, sc) {
  root.querySelectorAll(`[data-${sc.attr}]`).forEach((node) => {
    const path = node.getAttribute('data-' + sc.attr);
    const kind = node.dataset.kind || 'str';
    const value = sc.get(path);
    if (kind === 'seg' || kind === 'segbool') {
      const want = kind === 'segbool' ? (value === false ? '0' : '1') : String(value ?? '');
      node.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('on', b.dataset.v === want);
        b.setAttribute('aria-pressed', String(b.dataset.v === want));
      });
      return;
    }
    const active = document.activeElement;
    if (active && (active === node || node.contains(active)) && kind !== 'bool') return;
    writeControl(node, kind, value);
    if (kind === 'range') showOut(sc.out, path, node, root);
  });
}

/* One target's background editor: solid, gradient, generated artwork or a
   picture, with every control each of those has. t = { key, attr, out, prefix }. */
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
        comes from <b>App look → Background</b>; this is what goes on top.</p>` : ''}

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
      <span>Gradient angle <b class="mono" ${O('angle')}>135</b>°</span>
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
      <button class="btn btn-ghost btn-sm" data-bgact="upload">Upload image…</button>
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
