/* The scene runtime: web/scene.html?id=<scene>, or ?follow=1 for whatever
   scene is live.

   A scene is laid out at its own size and scaled with one transform to fit
   the window (the output window IS that size, so the scale is 1). Layers
   are absolutely positioned boxes; a registry of layer types builds and
   updates each one, and only the layers whose JSON changed are touched when
   the scene's revision moves. One state feed feeds everything, embedded
   components included. Nothing runs per frame: motion is CSS at 30 fps,
   text with a clock updates once a second, and Ultra optimized stills it
   all. */
'use strict';

const q = new URLSearchParams(location.search);
const PREVIEW = q.has('preview');                    // inside the editor: no window plumbing
const FOLLOW = q.get('follow') === '1' || q.get('id') === 'live';
const SCENE_ID = FOLLOW ? '' : (q.get('id') || '');
const COMPONENT = FOLLOW ? 'live' : 'scene:' + SCENE_ID;
const API = '/api/components/' + COMPONENT;
document.title = FOLLOW ? 'Awesome Streaming Deck - Canvas live (source)'
  : `Awesome Streaming Deck - Canvas ${SCENE_ID} (source)`;

const root = document.getElementById('root');
const banner = document.getElementById('banner');

// Any error shows on the output itself - a black window that looks fine
// from the outside is the worst way to find out.
window.addEventListener('error', (e) => { banner.textContent = 'scene error: ' + (e.message || e); banner.hidden = false; });
window.addEventListener('unhandledrejection', (e) => { banner.textContent = 'scene error: ' + ((e.reason && e.reason.message) || e.reason); banner.hidden = false; });

/* ------------------------------------------------------------- helpers */

const px = (n) => `${Math.round(Number(n) || 0)}px`;
const ORIGIN = { tl: '0% 0%', tc: '50% 0%', tr: '100% 0%', ml: '0% 50%', mc: '50% 50%', mr: '100% 50%',
                 bl: '0% 100%', bc: '50% 100%', br: '100% 100%' };
const fmtTime = (s) => { s = Math.max(0, Math.floor(Number(s) || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const assetUrl = (src) => !src ? '' : /^(\/|https?:|data:|blob:)/.test(src) ? src : '/asset/' + encodeURIComponent(src);
const isVideo = (src) => /\.(webm|mp4|m4v)(\?|$)/i.test(src || '');

function fillVars(text, state) {
  if (!text || text.indexOf('{') < 0) return text || '';
  const now = (state && state.now) || {};
  const cap = (state && state.captions) || {};
  const d = new Date();
  const vars = {
    title: now.title || '', artist: now.artist || '', album: now.album || '',
    source: now.source_label || '', elapsed: fmtTime(now.position), duration: fmtTime(now.duration),
    time: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    date: d.toLocaleDateString(),
    caption: cap.lines && cap.lines.length ? cap.lines[cap.lines.length - 1].text : '',
    caption_live: cap.partial || '',
  };
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}
const usesClock = (text) => /\{(time|elapsed|date)\}/.test(text || '');

/* The common box: position, size, rotation, and every style field. */
function applyBox(entry) {
  const { el, layer } = entry;
  const t = layer.transform || {}, s = layer.style || {};
  el.style.left = px(t.x); el.style.top = px(t.y);
  el.style.width = px(t.w); el.style.height = px(t.h);
  el.style.transformOrigin = ORIGIN[t.anchor] || '0% 0%';
  el.style.transform = t.rotation ? `rotate(${Number(t.rotation)}deg)` : '';
  el.style.opacity = String(s.opacity ?? 1);
  el.style.mixBlendMode = s.blend && s.blend !== 'normal' ? s.blend : '';
  el.style.borderRadius = s.radius ? px(s.radius) : '';
  const b = s.border || {};
  el.style.border = b.w ? `${px(b.w)} solid ${b.color || '#fff'}` : '';
  const sh = s.shadow || {};
  el.style.boxShadow = (sh.blur || sh.x || sh.y) ? `${px(sh.x)} ${px(sh.y)} ${px(sh.blur)} ${sh.color || '#000'}` : '';
  el.style.filter = s.blur ? `blur(${px(s.blur)})` : '';
  const c = s.crop || {};
  el.style.clipPath = (c.t || c.r || c.b || c.l)
    ? `inset(${(c.t || 0) * 100}% ${(c.r || 0) * 100}% ${(c.b || 0) * 100}% ${(c.l || 0) * 100}%)` : '';
  el.classList.toggle('hidden', layer.visible === false);
}

/* ------------------------------------------------------------- layer types */

const TYPES = {};

TYPES.background = {
  create(entry) {
    entry.el.innerHTML = '<div class="bg-fill"></div><div class="bg-art"></div><div class="bg-dim"></div>';
    this.update(entry);
  },
  update(entry) {
    const p = entry.layer.props || {};
    const fill = entry.el.querySelector('.bg-fill'), art = entry.el.querySelector('.bg-art'), dim = entry.el.querySelector('.bg-dim');
    applyBackground(entry.el, art, p, (k, v) => { if (k === '--bg') fill.style.background = v; });
    art.style.filter = p.blur ? `blur(${px(p.blur)})` : '';
    dim.style.background = p.dim_color || '#000';
    dim.style.opacity = String(p.dim || 0);
  },
};

TYPES.text = {
  create(entry) {
    entry.el.innerHTML = '<div class="text-box"><span class="text-pill"><span class="text-body"></span></span></div>';
    this.update(entry);
  },
  update(entry) {
    const p = entry.layer.props || {};
    const box = entry.el.querySelector('.text-box'), pill = entry.el.querySelector('.text-pill'), body = entry.el.querySelector('.text-body');
    box.style.justifyContent = { left: 'flex-start', right: 'flex-end' }[p.align] || 'center';
    box.style.alignItems = { top: 'flex-start', bottom: 'flex-end' }[p.valign] || 'center';
    body.style.textAlign = p.align || 'center';
    body.style.fontFamily = p.font ? `"${p.font}", "Segoe UI", system-ui, sans-serif` : '';
    body.style.fontSize = px(p.size || 48);
    body.style.fontWeight = String(p.weight || 700);
    body.style.fontStyle = p.italic ? 'italic' : '';
    body.style.letterSpacing = p.letter ? `${Number(p.letter)}em` : '';
    body.style.lineHeight = p.line ? String(p.line) : '1.2';
    body.style.textTransform = p.uppercase ? 'uppercase' : '';
    body.style.webkitTextStroke = p.stroke && p.stroke.w ? `${px(p.stroke.w)} ${p.stroke.color || '#000'}` : '';
    const sh = p.shadow || {};
    body.style.textShadow = (sh.blur || sh.x || sh.y) ? `${px(sh.x)} ${px(sh.y)} ${px(sh.blur)} ${sh.color || '#000'}` : '';
    const g = p.gradient || {};
    if (g.on) {
      body.style.backgroundImage = `linear-gradient(${g.angle ?? 90}deg, ${g.c1 || '#fff'}, ${g.c2 || '#8b5cf6'})`;
      body.classList.add('gradient');
      body.style.color = '';
    } else {
      body.style.backgroundImage = '';
      body.classList.remove('gradient');
      body.style.color = p.color || '#ffffff';
    }
    const pl = p.pill || {};
    pill.style.background = pl.on ? (pl.color || 'rgba(0,0,0,.55)') : '';
    pill.style.padding = pl.on ? `${px(pl.pad ?? 12)} ${px((pl.pad ?? 12) * 1.6)}` : '';
    pill.style.borderRadius = pl.on ? px(pl.radius ?? 16) : '';
    entry.clock = usesClock(p.text);
    entry.fitBase = Number(p.size || 48);
    this.state(entry, lastState, true);
  },
  state(entry, state, force) {
    const p = entry.layer.props || {};
    if (!force && (p.text || '').indexOf('{') < 0) return;
    const text = fillVars(p.text || '', state);
    if (text === entry.text && !force && !entry.refit) return;
    entry.text = text;
    const body = entry.el.querySelector('.text-body');
    body.textContent = text;
    if (p.fit) fitText(entry, body);
  },
};

/* Shrink the font until the words fit the box. Runs on updates only, so a
   handful of layout reads is fine. */
function fitText(entry, body) {
  const box = entry.el;
  if (!box.isConnected || !box.clientWidth) { entry.refit = true; return; }
  entry.refit = false;
  let size = entry.fitBase;
  body.style.fontSize = px(size);
  for (let i = 0; i < 14; i++) {
    if (body.scrollWidth <= box.clientWidth + 1 && body.scrollHeight <= box.clientHeight + 1) break;
    size *= 0.9;
    body.style.fontSize = px(size);
  }
}

TYPES.image = {
  create(entry) { this.update(entry); },
  update(entry) {
    const p = entry.layer.props || {};
    const src = assetUrl(p.src);
    const kind = p.kind || (isVideo(src) ? 'video' : 'image');
    const tile = p.fit === 'tile';
    const want = tile ? 'DIV' : kind === 'video' ? 'VIDEO' : 'IMG';
    let m = entry.media;
    if (!m || m.tagName !== want || (m.tagName === 'VIDEO' && m.dataset.src !== src)) {
      this.destroy(entry);
      m = document.createElement(want.toLowerCase());
      m.className = 'media';
      if (want === 'VIDEO') {
        m.autoplay = true; m.loop = p.loop !== false; m.muted = p.muted !== false; m.playsInline = true;
        m.dataset.src = src; m.src = src;
        m.playbackRate = Number(p.rate) || 1;
      }
      entry.el.appendChild(m);
      entry.media = m;
    }
    if (want === 'IMG') {
      const still = window.stillOf ? window.stillOf(src) : src;
      if (m.dataset.src !== still) { m.dataset.src = still; m.src = still; }
    } else if (want === 'DIV') {
      m.style.backgroundImage = `url("${window.stillOf ? window.stillOf(src) : src}")`;
      m.style.backgroundRepeat = 'repeat';
      m.style.backgroundSize = p.tile_size ? px(p.tile_size) : 'auto';
    } else if (isUltra()) {
      m.pause();
    } else if (m.paused && !document.hidden) {
      m.play().catch(() => {});
    }
    m.style.objectFit = { contain: 'contain', stretch: 'fill' }[p.fit] || 'cover';
    m.style.transform = `${p.flip_h ? 'scaleX(-1)' : ''} ${p.flip_v ? 'scaleY(-1)' : ''}`;
  },
  destroy(entry) {
    if (entry.media) {
      if (entry.media.tagName === 'VIDEO') { try { entry.media.pause(); entry.media.removeAttribute('src'); entry.media.load(); } catch (_) {} }
      entry.media.remove();
      entry.media = null;
    }
  },
  motion(entry) { this.update(entry); },
};

TYPES.shape = {
  create(entry) { this.update(entry); },
  update(entry) {
    const p = entry.layer.props || {};
    const kind = p.kind || 'rect';
    const el = entry.el;
    el.innerHTML = '';
    el.classList.toggle('shape-ellipse', kind === 'ellipse');
    const st = p.stroke || {};
    if (kind === 'line') {
      const line = document.createElement('div');
      line.className = 'shape-line';
      line.style.height = px(st.w || 4);
      line.style.background = st.color || p.fill || '#ffffff';
      line.style.borderRadius = px((st.w || 4) / 2);
      el.appendChild(line);
      el.style.background = '';
    } else if (kind === 'frame') {
      // A frame with a hole: the hole is a box whose huge shadow paints the
      // frame around it, clipped to the layer. What shows through the hole is
      // whatever sits under the layer - the key color, a game, the desktop.
      const hole = document.createElement('div');
      hole.className = 'shape-hole';
      const pad = Number(p.pad ?? 24);
      hole.style.inset = px(pad);
      hole.style.borderRadius = px(p.hole_radius ?? 16);
      hole.style.boxShadow = `0 0 0 20000px ${p.fill || 'rgba(255,255,255,.9)'}` +
        (st.w ? `, inset 0 0 0 ${px(st.w)} ${st.color || '#fff'}` : '');
      el.appendChild(hole);
      el.style.background = '';
    } else {
      el.style.background = p.fill || 'rgba(255,255,255,.9)';
      el.style.outline = st.w ? `${px(st.w)} solid ${st.color || '#fff'}` : '';
      el.style.outlineOffset = st.w ? px(-st.w) : '';
    }
  },
};

TYPES.component = {
  create(entry) {
    const p = entry.layer.props || {};
    entry.host = EmbedHost.create(entry.el, {
      component: p.component || 'np', options: p.options || {},
      design: { mode: p.design || 'linked', custom: p.custom || null },
    });
    entry.component = p.component || 'np';
  },
  update(entry) {
    const p = entry.layer.props || {};
    if ((p.component || 'np') !== entry.component || !entry.host) {
      this.destroy(entry);
      this.create(entry);
      return;
    }
    entry.host.setOptions(p.options || {});
    entry.host.setDesign({ mode: p.design || 'linked', custom: p.custom || null });
  },
  destroy(entry) { if (entry.host) { entry.host.destroy(); entry.host = null; } },
};

/* Camera and capture: media that costs something to hold open, so it exists
   only while the layer is visible, and stops when the layer goes. */
async function pickDevice(hint) {
  if (!hint) return undefined;
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const hit = devs.find((d) => d.kind === 'videoinput' && (d.deviceId === hint || (d.label || '').toLowerCase().includes(String(hint).toLowerCase())));
    return hit ? { exact: hit.deviceId } : undefined;
  } catch (_) { return undefined; }
}

function noteSource(entry, text, bad) {
  entry.el.classList.toggle('source-error', !!bad);
  let tag = entry.el.querySelector('.source-note');
  if (!tag) { tag = document.createElement('div'); tag.className = 'source-note'; entry.el.appendChild(tag); }
  tag.textContent = text;
  tag.hidden = !bad && !PREVIEW;
  entry.status = text;
}

function attachStream(entry, stream) {
  const v = document.createElement('video');
  v.className = 'media';
  v.autoplay = true; v.muted = true; v.playsInline = true;
  v.srcObject = stream;
  entry.el.appendChild(v);
  entry.media = v;
  entry.stream = stream;
  stream.getVideoTracks().forEach((t) => { t.onended = () => noteSource(entry, 'source ended', true); });
}

function dropStream(entry) {
  if (entry.stream) { entry.stream.getTracks().forEach((t) => t.stop()); entry.stream = null; }
  if (entry.media) { entry.media.remove(); entry.media = null; }
}

TYPES.camera = {
  create(entry) { this.update(entry); },
  update(entry) {
    const p = entry.layer.props || {};
    const el = entry.el;
    el.classList.toggle('mask-circle', p.mask === 'circle');
    el.classList.toggle('mask-rounded', p.mask === 'rounded');
    el.style.clipPath = p.mask === 'blob'
      ? 'polygon(50% 0%, 83% 12%, 100% 43%, 94% 78%, 68% 100%, 32% 100%, 6% 78%, 0% 43%, 17% 12%)' : el.style.clipPath;
    const key = JSON.stringify([p.device, p.width, p.height, p.fps, entry.layer.visible]);
    if (entry.mediaKey !== key) {
      entry.mediaKey = key;
      dropStream(entry);
      if (entry.layer.visible !== false) this.start(entry, p);
    }
    if (entry.media) {
      entry.media.style.objectFit = p.fit === 'contain' ? 'contain' : 'cover';
      entry.media.style.transform = p.mirror === false ? '' : 'scaleX(-1)';
    }
  },
  async start(entry, p) {
    noteSource(entry, 'camera starting', false);
    try {
      const deviceId = await pickDevice(p.device);
      const video = { width: { ideal: Number(p.width) || 1280 }, height: { ideal: Number(p.height) || 720 },
                      frameRate: { ideal: Number(p.fps) || 30, max: Number(p.fps) || 30 } };
      if (deviceId) video.deviceId = deviceId;
      const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      if (entry.gone) { stream.getTracks().forEach((t) => t.stop()); return; }
      attachStream(entry, stream);
      this.update(entry);
      const s = stream.getVideoTracks()[0].getSettings();
      noteSource(entry, `camera ${s.width}x${s.height}@${s.frameRate || '?'}`, false);
    } catch (e) {
      noteSource(entry, 'camera: ' + (e.message || e.name), true);
    }
  },
  destroy(entry) { entry.gone = true; dropStream(entry); },
};

TYPES.capture = {
  create(entry) { this.update(entry); },
  update(entry) {
    const p = entry.layer.props || {};
    const el = entry.el;
    const key = JSON.stringify([p.mode, p.source, p.fps, entry.layer.visible]);
    if (entry.mediaKey !== key) {
      entry.mediaKey = key;
      dropStream(entry);
      el.classList.remove('native-hole');
      if (entry.layer.visible !== false) {
        if ((p.mode || 'auto') === 'native') this.native(entry, p);
        else this.browser(entry, p);
      }
    }
    if (entry.media) entry.media.style.objectFit = p.fit === 'contain' ? 'contain' : 'cover';
  },
  native(entry, p) {
    // The app's own capture puts the source here (P4): the box shows the
    // key color so anything compositing knows where the picture goes.
    entry.el.classList.add('native-hole');
    const scene = currentScene();
    entry.el.style.background = scene && scene.transparency === 'key' ? scene.key_color : 'transparent';
    const src = p.source || {};
    noteSource(entry, `native capture: ${src.title || (src.kind === 'monitor' ? 'screen ' + (src.monitor ?? 0) : 'window')}`, false);
  },
  async browser(entry, p) {
    noteSource(entry, 'capture starting', false);
    const timeout = new Promise((_, no) => setTimeout(() => no(new Error('no picker answer')), 8000));
    try {
      const stream = await Promise.race([navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: Number(p.fps) || 30, max: Number(p.fps) || 30 } }, audio: false }), timeout]);
      if (entry.gone) { stream.getTracks().forEach((t) => t.stop()); return; }
      attachStream(entry, stream);
      this.update(entry);
      const s = stream.getVideoTracks()[0].getSettings();
      noteSource(entry, `capture ${s.width}x${s.height}@${s.frameRate || '?'}`, false);
    } catch (e) {
      // No auto-selected source in this Chrome: fall back to the native hole.
      this.native(entry, p);
      noteSource(entry, entry.status + ' (browser capture: ' + (e.message || e.name) + ')', false);
    }
  },
  destroy(entry) { entry.gone = true; dropStream(entry); },
};

/* Reactive image: one picture while quiet, another while talking, an
   optional blink, an optional bounce. Speaking comes from the server's voice
   state on the feed. */
TYPES.reactive = {
  create(entry) {
    entry.el.innerHTML = '<img class="media reactive">';
    entry.media = entry.el.querySelector('img');
    this.update(entry);
  },
  update(entry) {
    const p = entry.layer.props || {};
    entry.media.style.objectFit = p.fit === 'cover' ? 'cover' : 'contain';
    entry.el.style.setProperty('--bounce', px(p.bounce || 0));
    this.voice(entry, voiceNow);
    clearInterval(entry.blink);
    entry.blink = null;
    if (p.blink && !isUltra()) {
      entry.blink = setInterval(() => {
        if (entry.blinking || entry.layer.visible === false) return;
        entry.blinking = true;
        this.voice(entry, voiceNow);
        setTimeout(() => { entry.blinking = false; this.voice(entry, voiceNow); }, 140);
      }, Math.max(800, Number(p.blink_every) || 4000));
    }
  },
  voice(entry, v) {
    const p = entry.layer.props || {};
    const src = assetUrl(entry.blinking && p.blink ? p.blink : v.speaking && p.talking ? p.talking : p.idle);
    const still = window.stillOf ? window.stillOf(src) : src;
    if (entry.media.dataset.src !== still) { entry.media.dataset.src = still; entry.media.src = still; }
    entry.el.classList.toggle('bounce', !!(v.speaking && Number(p.bounce) > 0 && !isUltra()));
  },
  destroy(entry) { clearInterval(entry.blink); },
  motion(entry) { this.update(entry); },
};

/* Any layer: a decorative border loop (decor.js), and "while speaking" triggers. */
function applyDecor(entry) {
  const d = (entry.layer.props || {}).decor;
  let box = entry.el.querySelector(':scope > .decor');
  if (!d || !d.border && !d.custom || d.sides === 'none') {
    if (box) { renderDecor(entry.el, box, null, ''); box.remove(); }
    return;
  }
  if (!box) {
    box = document.createElement('div');
    box.className = 'decor';
    box.innerHTML = ['top', 'bottom', 'left', 'right'].map((s) => `<div class="decor-strip decor-${s}"><span></span></div>`).join('');
    entry.el.appendChild(box);
  }
  renderDecor(entry.el, box, d, d.color || '#ffffff');
}

function applyTriggers(entry, v) {
  const trig = entry.layer.triggers || [];
  if (!trig.length) return;
  let visible = entry.layer.visible !== false, bounce = false;
  for (const t of trig) {
    const active = t.on === 'speaking' ? v.speaking : t.on === 'silent' ? !v.speaking : false;
    if (t.do === 'show') visible = visible && active;
    else if (t.do === 'hide') visible = visible && !active;
    else if (t.do === 'bounce') bounce = bounce || active;
    else if (t.do === 'class' && t.value) entry.el.classList.toggle('t-' + t.value, active);
    if (t.on === 'speech_start' && v.started && t.do === 'pop') {
      entry.el.classList.add('pop');
      setTimeout(() => entry.el.classList.remove('pop'), 650);
    }
  }
  entry.el.classList.toggle('hidden', !visible);
  entry.el.classList.toggle('bounce', bounce && !isUltra());
}

/* ------------------------------------------------------------- a stage */

class Stage {
  constructor(el) {
    this.el = el;
    el.innerHTML = '<div class="scene-bg"><div class="scene-bg-fill"></div><div class="scene-bg-art"></div></div><div class="scene-layers"></div>';
    this.bg = el.querySelector('.scene-bg');
    this.bgFill = el.querySelector('.scene-bg-fill');
    this.bgArt = el.querySelector('.scene-bg-art');
    this.list = el.querySelector('.scene-layers');
    this.scene = null;
    this.layers = new Map();
  }

  render(scene) {
    this.scene = scene;
    this.el.style.width = px(scene.width);
    this.el.style.height = px(scene.height);
    const bg = scene.background || {};
    const paint = scene.transparency === 'opaque' && bg.mode !== 'none';
    this.bg.hidden = !paint;
    if (paint) applyBackground(this.bg, this.bgArt, bg, (k, v) => { if (k === '--bg') this.bgFill.style.background = v; });

    const seen = new Set();
    const order = [];
    for (const layer of scene.layers || []) {
      seen.add(layer.id);
      const key = JSON.stringify(layer);
      let entry = this.layers.get(layer.id);
      if (entry && entry.type !== layer.type) { this.drop(entry); entry = null; }
      if (!entry) {
        entry = this.make(layer);
      } else if (entry.key !== key) {
        const prev = entry.layer;
        entry.layer = layer;
        applyBox(entry);
        if (prev.visible === false && layer.visible !== false && TYPES[layer.type].destroy) {
          // Back from hidden: media was dropped, so build it again.
          TYPES[layer.type].destroy(entry); entry.gone = false; entry.mediaKey = '';
        }
        TYPES[entry.type].update(entry, prev);
        if (layer.visible === false && TYPES[layer.type].destroy) TYPES[layer.type].destroy(entry);
        applyDecor(entry);
        applyTriggers(entry, voiceNow);
      }
      entry.key = key;
      order.push(entry.el);
    }
    for (const [id, entry] of this.layers) if (!seen.has(id)) this.drop(entry);
    if (order.some((el, i) => this.list.children[i] !== el)) order.forEach((el) => this.list.appendChild(el));
    this.watchClock();
  }

  make(layer) {
    const type = TYPES[layer.type] ? layer.type : 'shape';
    const el = document.createElement('div');
    el.className = 'layer type-' + type;
    el.dataset.id = layer.id;
    const entry = { el, layer, type, key: '' };
    this.layers.set(layer.id, entry);
    applyBox(entry);
    // In the document before it is built: text that fits itself measures
    // its box, and a detached box measures as nothing. Order is fixed after.
    this.list.appendChild(el);
    TYPES[type].create(entry);
    if (layer.visible === false && TYPES[type].destroy) TYPES[type].destroy(entry);
    applyDecor(entry);
    applyTriggers(entry, voiceNow);
    return entry;
  }

  drop(entry) {
    if (TYPES[entry.type].destroy) TYPES[entry.type].destroy(entry);
    entry.el.remove();
    this.layers.delete(entry.layer.id);
  }

  clear() {
    for (const entry of [...this.layers.values()]) this.drop(entry);
    this.scene = null;
  }

  state(s) {
    for (const entry of this.layers.values()) {
      const t = TYPES[entry.type];
      if (t.state) t.state(entry, s);
    }
  }

  voice(v) {
    for (const entry of this.layers.values()) {
      const t = TYPES[entry.type];
      if (t.voice) t.voice(entry, v);
      applyTriggers(entry, v);
    }
  }

  motion() {
    for (const entry of this.layers.values()) {
      const t = TYPES[entry.type];
      if (t.motion) t.motion(entry);
    }
  }

  needsVoice() {
    for (const entry of this.layers.values()) {
      if (entry.type === 'reactive' || (entry.layer.triggers || []).length) return true;
    }
    return false;
  }

  // Text with a clock in it ticks once a second, and only then.
  watchClock() {
    const any = [...this.layers.values()].some((e) => e.type === 'text' && e.clock);
    clearInterval(this.clockTimer);
    this.clockTimer = any ? setInterval(() => this.state(lastState), 1000) : null;
  }
}

/* ------------------------------------------------------------- the runtime */

const stageObjs = [new Stage(document.getElementById('stageA')), new Stage(document.getElementById('stageB'))];
let current = null;
let lastState = null;
let voiceNow = { speaking: false, started: false };
let loading = null;

function currentScene() { return current && current.scene; }

function fit() {
  const scene = currentScene();
  if (!scene) return;
  const k = PREVIEW ? Math.min(innerWidth / scene.width, innerHeight / scene.height) : 1;
  root.style.width = px(scene.width);
  root.style.height = px(scene.height);
  root.style.transform = `scale(${k})`;
  root.style.left = px((innerWidth - scene.width * k) / 2);
  root.style.top = px((innerHeight - scene.height * k) / 2);
}

function paintBody(scene) {
  const mode = scene.transparency || 'opaque';
  document.body.style.background = mode === 'key' ? scene.key_color : mode === 'see-through' ? 'transparent' : '#000';
  document.body.classList.toggle('see-through', mode === 'see-through');
}

async function show(scene, transition) {
  paintBody(scene);
  if (current && current.scene && current.scene.id === scene.id) {
    current.render(scene);
    fit();
    holdVoice();
    return;
  }
  const next = stageObjs.find((s) => s !== current);
  const old = current;
  next.render(scene);
  next.state(lastState);
  fit();
  const fade = transition && transition.kind === 'fade' && !isUltra() && old;
  const ms = fade ? Math.max(60, Math.min(3000, Number(transition.duration) || 300)) : 0;
  next.el.style.transitionDuration = `${ms}ms`;
  if (old) old.el.style.transitionDuration = `${ms}ms`;
  void next.el.offsetWidth;                       // commit the starting opacity
  next.el.classList.add('shown');
  if (old) old.el.classList.remove('shown');
  current = next;
  if (ms) await new Promise((r) => setTimeout(r, ms + 40));
  if (old) old.clear();
  holdVoice();
}

async function loadScene(id, transition) {
  if (!id) return;
  const key = id;
  loading = key;
  try {
    const r = await fetch('/api/scenes/' + encodeURIComponent(id), { cache: 'no-store' });
    if (!r.ok) throw new Error(`scene ${id}: ${r.status}`);
    const scene = await r.json();
    if (loading !== key) return;               // a newer request won
    banner.hidden = true;
    await show(scene, transition);
  } catch (e) {
    banner.textContent = String(e.message || e);
    banner.hidden = false;
  }
}

/* One feed for the whole scene, embedded components included. */
function onState(s) {
  lastState = s;
  syncUserFonts(s.fonts_v);
  setUltra(s.ultra);
  EmbedHost.broadcast(s);
  const v = (s.voice || {});
  const speaking = !!v.speaking;
  if (speaking !== voiceNow.speaking) {
    voiceNow = { speaking, started: speaking };
    if (current) current.voice(voiceNow);
    voiceNow.started = false;
  }
  if (current) current.state(s);
  // Which scene, and which revision of it.
  const canvas = s.canvas || {};
  const wantId = FOLLOW ? canvas.live : SCENE_ID;
  const have = currentScene();
  if (wantId && (!have || have.id !== wantId)) {
    loadScene(wantId, { kind: canvas.transition || 'cut', duration: canvas.duration });
  } else if (have) {
    const mine = (s.scenes || []).find((x) => x.id === have.id);
    if (mine && mine.rev !== have.rev) loadScene(have.id, { kind: 'cut' });
  }
  if (FOLLOW && !wantId) { banner.textContent = 'No live scene yet'; banner.hidden = false; }
}

let ws = null;
function connectFeed() {
  try { ws = new WebSocket(`ws://${location.host}/ws/events`); } catch (_) { setTimeout(connectFeed, 2000); return; }
  ws.onmessage = (e) => { try { onState(JSON.parse(e.data)); } catch (_) { /* next one */ } };
  ws.onclose = () => { ws = null; setTimeout(connectFeed, 1500); };
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}

/* Voice: hold a lease while anything here reacts to speech. */
let voiceToken = null, voiceTimer = null;
function holdVoice() {
  const need = current && current.needsVoice();
  if (need && !voiceTimer) {
    const renew = () => fetch('/api/voice/hold', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: voiceToken }) }).then((r) => r.json()).then((d) => { voiceToken = d.token; }).catch(() => {});
    renew();
    voiceTimer = setInterval(renew, 20000);
  } else if (!need && voiceTimer) {
    clearInterval(voiceTimer); voiceTimer = null;
    if (voiceToken) fetch('/api/voice/release', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: voiceToken }) }).catch(() => {});
    voiceToken = null;
  }
}
window.addEventListener('pagehide', () => {
  if (voiceToken) navigator.sendBeacon('/api/voice/release', new Blob([JSON.stringify({ token: voiceToken })], { type: 'application/json' }));
});

onMotionChange(() => { if (current) current.motion(); });
document.addEventListener('visibilitychange', () => { if (current) current.motion(); });

window.addEventListener('resize', () => {
  fit();
  if (!PREVIEW) reportWindowMetrics(API);
});
if (!PREVIEW) reportWindowMetrics(API);

/* For tests and the editor: what the runtime holds right now. */
window.SceneDebug = {
  scene: () => currentScene(),
  layers: () => current ? [...current.layers.values()].map((e) => ({ id: e.layer.id, type: e.type, status: e.status || '', media: !!e.media, src: e.media && e.media.dataset ? e.media.dataset.src : '' })) : [],
  embeds: () => EmbedHost.count(),
  voice: () => voiceNow,
};

connectFeed();
