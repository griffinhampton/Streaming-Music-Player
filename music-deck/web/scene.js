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
/* An asset id becomes a URL under /asset. Anything carrying a scheme is
   refused, and that is a boundary rather than tidiness: a scene can arrive
   from somebody else through /api/scenes/import, and props are the one part
   of it the server does not check - scenes.py's _layer() coerces the
   transform and the style and then passes props through exactly as they came.
   A src of "https://..." would be fetched from wherever it points, on this
   machine, live on stream: an IP and a timing beacon for whoever wrote the
   scene, and a picture they can change whenever they like. Nothing here makes
   one - the picker uploads the file and keeps the id it gets back
   (canvas.js:1123) - and an import calls such a scene clean, because
   used_assets() only counts strings shaped like an asset id, which
   "beacon.png" is not. "//host/x" is remote as well, so a leading "/" is not
   enough on its own. "builtin:" is this app's own name for shipped artwork
   (assets.py:156) and stays. An empty result is the same state a layer with
   no picture chosen is already in. */
const assetUrl = (src) => {
  const s = src ? String(src) : '';
  if (!s || s.startsWith('//')) return '';
  if (s.startsWith('/')) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^builtin:/i.test(s)) return '';
  return '/asset/' + encodeURIComponent(s);
};
/* A picture or video whose file is gone (deleted anyway, or a scene imported
   without it) shows nothing on stream instead of a broken-image icon; the
   editor's preview outlines the empty box so it can be found and fixed. */
function watchMissing(m, entry) {
  const mark = (gone) => {
    m.classList.toggle('missing', gone);
    if (PREVIEW) entry.el.classList.toggle('missing-media', gone && !!m.getAttribute('src'));
  };
  m.addEventListener('error', () => mark(true));
  m.addEventListener(m.tagName === 'VIDEO' ? 'loadeddata' : 'load', () => mark(false));
}
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
      if (want !== 'DIV') watchMissing(m, entry);
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
      // Quoted and escaped: a src holding a quote would otherwise close the
      // url("...") and write CSS of its own after it.
      m.style.backgroundImage = `url(${JSON.stringify(window.stillOf ? window.stillOf(src) : src)})`;
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

const FRAME_STYLES = ['solid', 'double', 'dashed', 'glow', 'none'];

/* The dressing a frame layer can wear: a title plate riding its edge, and up
   to four corner badges.

   Sized against the layer's own box rather than the window. frame.html sets
   `font-size: max(12px, 3.4vmin)` on a stage fixed to the viewport, which
   means nothing inside a scene that is scaled to fit and can hold frames of
   several sizes - a 480 px camera frame and a 1920 px screen frame would come
   out lettered the same. The transform is the layer's box (applyBox writes the
   element straight from it), so there is nothing to measure and nothing to
   invalidate: a resize already comes back through update(). */
function frameDressing(el, p, t, pad, bw, color) {
  const em = Math.max(12, Math.min(Number(t.w) || 0, Number(t.h) || 0) * 0.034);
  el.style.setProperty('--frame-em', px(em));
  // The title and the badges ride the ring's stroke, and here the ring is the
  // hole's own border - so its center line is the frame's thickness plus half
  // the border, in from the layer's edge.
  //
  // Not the windows' --ring-inset, which is their decor band plus 0.9em: their
  // ring sits at the stage edge and has to be pushed inside the loop, while
  // this one already sits at a thickness the user chose. Borrowing their
  // formula put every badge inside the ring instead of on it, and read the
  // band off the DOM a step before applyDecor had set it.
  const edge = pad + bw / 2;
  const ti = p.title || {};
  const text = String(ti.text || '').trim();
  if (text) {
    const plate = document.createElement('div');
    plate.className = 'frame-title';
    plate.textContent = text;
    plate.style.fontSize = `calc(var(--frame-em) * ${Number(ti.size) || 1})`;
    plate.style.background = color;
    plate.style.color = ti.color || '#ffffff';
    if (ti.place === 'bottom') {
      plate.style.bottom = px(edge);
      plate.style.transform = 'translate(-50%, 50%)';
    } else {
      plate.style.top = px(edge);
    }
    el.appendChild(plate);
  }
  const bd = p.badges || {};
  // A circle's corners are outside it, so its badges come in onto the ring -
  // the windows' own 15% and 85%, with the inset added rather than folded into
  // the percentage.
  const circle = p.shape === 'circle';
  const near = circle ? `calc(${px(pad)} + 15%)` : px(edge);
  const far = circle ? `calc(85% - ${px(pad)})` : `calc(100% - ${px(edge)})`;
  for (const k of ['tl', 'tr', 'bl', 'br']) {
    const v = String(bd[k] || '').trim();
    if (!v) continue;
    const badge = document.createElement('div');
    badge.className = 'frame-badge';
    badge.textContent = v;
    badge.style.fontSize = `calc(var(--frame-em) * ${Number(bd.size) || 1})`;
    badge.style.background = bd.color || color;
    badge.style.left = k[1] === 'l' ? near : far;
    badge.style.top = k[0] === 't' ? near : far;
    el.appendChild(badge);
  }
}

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
      //
      // Everything the Screen frame and Camera frame windows draw, a layer can
      // draw here: the hole's shape, an edge in one of a few styles, a title
      // plate riding that edge, four corner badges, and - through props.decor,
      // like any layer - the loop. The windows go on working; this is so a
      // scene does not have to leave the canvas to get a frame around its game
      // or its camera.
      const hole = document.createElement('div');
      hole.className = 'shape-hole';
      const pad = Number(p.pad ?? 24);
      const shape = p.shape || 'rounded';
      const b = p.border || {};
      const style = FRAME_STYLES.includes(b.style) ? b.style : 'solid';
      const color = b.color || '#8b5cf6';
      // Double needs room for two lines and a gap, as it does on the windows.
      const bw = style === 'none' ? 0 : style === 'double'
        ? Math.max(6, Number(b.width ?? 0)) : Number(b.width ?? 0);
      hole.style.inset = px(pad);
      hole.style.borderRadius = shape === 'circle' ? '50%'
        : shape === 'rect' ? '0' : px(p.hole_radius ?? 16);
      // Painted the key color instead of see-through, for a chroma key.
      hole.style.background = p.hole === 'key' ? (p.key_color || '#00ff00') : '';
      // The edge is the hole's own border: it lands exactly on the frame's
      // inner edge, with no second element to keep in step with it.
      if (bw) hole.style.border = `${px(bw)} ${style === 'glow' ? 'solid' : style} ${color}`;
      hole.style.boxShadow = `0 0 0 20000px ${p.fill || 'rgba(255,255,255,.9)'}` +
        (st.w ? `, inset 0 0 0 ${px(st.w)} ${st.color || '#fff'}` : '') +
        (bw && style === 'glow' ? `, 0 0 ${px(bw * 1.6)} ${color}, inset 0 0 ${px(bw * 1.2)} ${color}` : '');
      el.appendChild(hole);
      frameDressing(el, p, entry.layer.transform || {}, pad, bw, color);
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

/* A native hole: the server composites the source here while LIVE. Pure
   black is the key, so the page must not paint anything darker than the
   compositor's threshold where a picture is not meant to show. */
function paintHole(entry) {
  entry.el.classList.add('native-hole');
  const scene = currentScene();
  entry.el.style.background = scene && scene.transparency === 'key' ? scene.key_color : '#000';
}

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
  if (entry.shots) { clearInterval(entry.shots); entry.shots = null; }
  if (entry.shot) { entry.shot.remove(); entry.shot = null; }
  if (entry.media) { entry.media.remove(); entry.media = null; }
}

/* What a native source looks like in the editor.

   The picture of a native capture only ever exists in the stream: the page
   leaves a hole and the server's compositor fills it while LIVE, so in the
   editor the box was a black rectangle for good and read as broken. The
   server already takes one-shot thumbnails for the picker, so the editor
   shows the real window from those - no browser capture, which the editor's
   iframe is not allowed to do anyway, and nothing extra while streaming. */
const SHOT_MS = 1500;
function holePreview(entry, src, what) {
  const img = document.createElement('img');
  img.className = 'media hole-shot';
  img.alt = '';
  entry.el.appendChild(img);
  // Deliberately not entry.media. SceneDebug reports `media: !!e.media`, and
  // the editor's red "Camera and screen on" badge counts any camera or capture
  // layer that has it - a badge whose whole job is to tell you something is
  // watching. This is a still fetched over HTTP, not a stream held open, and
  // saying otherwise raises an alarm that is not true.
  entry.shot = img;
  const url = src.kind === 'monitor'
    ? `/api/capture/thumb?monitor=${Number(src.monitor || 0)}&w=640`
    : `/api/capture/thumb?title=${encodeURIComponent(src.title || '')}&w=640`;
  const shoot = () => {
    if (!img.isConnected) { clearInterval(entry.shots); entry.shots = null; return; }
    if (document.hidden) return;
    const probe = new Image();
    probe.onload = () => {
      img.src = probe.src;
      img.classList.add('on');
      noteSource(entry, `${what} - the app puts this on your stream`, false);
    };
    // The window was closed, or renamed: say so rather than show a stale one.
    probe.onerror = () => {
      img.classList.remove('on');
      noteSource(entry, `${what} is not open right now`, true);
    };
    probe.src = url + '&t=' + Math.floor(performance.now());
  };
  shoot();
  clearInterval(entry.shots);
  entry.shots = setInterval(shoot, SHOT_MS);
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
    const key = JSON.stringify([p.mode, p.device, p.width, p.height, p.fps, entry.layer.visible]);
    if (entry.mediaKey !== key) {
      entry.mediaKey = key;
      dropStream(entry);
      el.classList.remove('native-hole');
      el.style.background = '';
      if (entry.layer.visible === false) { /* nothing to open */ }
      else if (p.mode === 'native') { paintHole(entry); noteSource(entry, 'native camera' + (p.device ? ': ' + p.device : ''), false); }
      else this.start(entry, p);
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
    // A stream, or the editor's still: native() has already run above, so this
    // fits whichever of the two the layer ended up with.
    const shown = entry.media || entry.shot;
    if (shown) shown.style.objectFit = p.fit === 'contain' ? 'contain' : 'cover';
  },
  native(entry, p) {
    // The app's own capture puts the source here while LIVE: the box is
    // painted black (the key color in key mode), and the server's
    // compositor keys the picture into exactly that shape.
    paintHole(entry);
    const src = p.source || {};
    if (!src.kind) { noteSource(entry, 'Choose a window or screen for this box', true); return; }
    const what = src.kind === 'monitor' ? `Screen ${Number(src.monitor || 0) + 1}` : (src.title || 'A window');
    noteSource(entry, `${what} - the app puts this on your stream`, false);
    if (PREVIEW) holePreview(entry, src, what);       // the editor shows the real thing
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

/* Microphone: your own voice as something you can put on the canvas - bars, a
   single level bar, or a waveform.

   The level is read here, with WebAudio, rather than asked of the server. The
   feed carries "speaking" but no level, and a meter wants thirty readings a
   second: an absurd thing to poll a server for when this page can listen to
   the same microphone itself, exactly as the camera layer opens its own
   device. Nothing is recorded and nothing leaves the page.

   motion.js steps CSS animations at 30 fps but has no ticker to join, so this
   runs its own and throttles itself to the same rate. Ultra stops it, and the
   meter holds the last shape it drew. */
async function pickAudioDevice(hint) {
  if (!hint) return undefined;
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const hit = devs.find((d) => d.kind === 'audioinput'
      && (d.deviceId === hint || (d.label || '').toLowerCase().includes(String(hint).toLowerCase())));
    return hit ? { exact: hit.deviceId } : undefined;
  } catch (_) { return undefined; }
}

const MIC_STYLES = ['bars', 'level', 'wave'];

TYPES.mic = {
  create(entry) { entry.gone = false; this.update(entry); },
  update(entry) {
    const p = entry.layer.props || {};
    const style = MIC_STYLES.includes(p.style) ? p.style : 'bars';
    const count = Math.max(4, Math.min(64, Math.round(Number(p.bars) || 24)));
    // The looks, every update, without touching the device.
    entry.gain = Math.max(0.2, Math.min(4, Number(p.gain) || 1));
    entry.color = p.color || '#8b5cf6';
    entry.el.style.setProperty('--mic-color', entry.color);
    if (entry.analyser) entry.analyser.smoothingTimeConstant = Math.max(0, Math.min(0.95, Number(p.smooth ?? 0.7)));
    // visible is in the key on purpose: hiding the layer changes it, which
    // tears the microphone down and skips the re-open below (the camera layer
    // releases its device the same way).
    const key = JSON.stringify([p.device, style, count, entry.layer.visible]);
    if (entry.mediaKey === key) return;
    entry.mediaKey = key;
    this.stop(entry);                       // not destroy(): that marks the layer gone
    entry.el.querySelectorAll('.mic-bars, .mic-wave').forEach((n) => n.remove());
    if (entry.layer.visible === false) return;
    this.build(entry, style, count);
    this.start(entry, p);
  },
  build(entry, style, count) {
    entry.style = style;
    if (style === 'wave') {
      const c = document.createElement('canvas');
      c.className = 'mic-wave';
      entry.el.appendChild(c);
      entry.canvas = c;
      return;
    }
    const box = document.createElement('div');
    box.className = 'mic-bars' + (style === 'level' ? ' one' : '');
    const n = style === 'level' ? 1 : count;
    // The gap has to shrink as the bars multiply. A flat 6% put 23 gaps of 86px
    // into a 1440px box - more gap than box - so every bar flexed down to no
    // width at all, while their transforms went on changing perfectly and every
    // check that read the DOM passed against a layer drawing nothing.
    box.style.setProperty('--mic-gap', (100 / (n * 7)).toFixed(2) + '%');
    box.innerHTML = new Array(n).fill('<i></i>').join('');
    entry.el.appendChild(box);
    entry.bars = [...box.querySelectorAll('i')];
  },
  async start(entry, p) {
    noteSource(entry, 'microphone starting', false);
    try {
      const deviceId = await pickAudioDevice(p.device);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId } : true, video: false });
      // Deleted or hidden while Windows was thinking about it.
      if (entry.gone || entry.layer.visible === false) { stream.getTracks().forEach((t) => t.stop()); return; }
      entry.stream = stream;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      entry.actx = new Ctx();
      // A page nobody clicked starts its AudioContext suspended, and a
      // suspended analyser reads silence for ever. A scene output window is
      // opened by the app rather than by a person, so that is the normal case
      // here, not an edge one.
      if (entry.actx.state === 'suspended') entry.actx.resume().catch(() => {});
      const an = entry.actx.createAnalyser();
      an.fftSize = 1024;
      an.smoothingTimeConstant = Math.max(0, Math.min(0.95, Number(p.smooth ?? 0.7)));
      entry.actx.createMediaStreamSource(stream).connect(an);
      entry.analyser = an;
      entry.bins = new Uint8Array(an.frequencyBinCount);
      entry.wave = new Uint8Array(an.fftSize);
      noteSource(entry, 'microphone' + (p.device ? ': ' + p.device : ''), false);
      this.loop(entry);
    } catch (e) {
      noteSource(entry, 'microphone: ' + (e.message || e.name), true);
    }
  },
  loop(entry) {
    cancelAnimationFrame(entry.raf);
    let last = 0;
    const draw = (t) => {
      // Stop outright rather than wake 165 times a second to do nothing: in
      // Ultra, or while the window is hidden, this ends and motion() starts it
      // again - scene.js calls that on the Ultra switch and on visibilitychange.
      if (!entry.analyser || document.hidden || isUltra()) { entry.raf = 0; return; }
      entry.raf = requestAnimationFrame(draw);
      if (t - last < 1000 / 30) return;                  // 30 a second, as motion.js does
      last = t;
      this.paint(entry);
    };
    entry.raf = requestAnimationFrame(draw);
  },
  paint(entry) {
    const an = entry.analyser;
    if (entry.style === 'wave') {
      const c = entry.canvas;
      if (!c) return;
      const w = entry.el.clientWidth, h = entry.el.clientHeight;
      if (!w || !h) return;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      an.getByteTimeDomainData(entry.wave);
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, w, h);
      ctx.lineWidth = Math.max(2, h * 0.025);
      ctx.strokeStyle = entry.color;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      const n = entry.wave.length;
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * w;
        const y = h / 2 + ((entry.wave[i] - 128) / 128) * (h / 2) * entry.gain;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.stroke();
      return;
    }
    if (!entry.bars || !entry.bars.length) return;
    if (entry.style === 'level') {
      an.getByteTimeDomainData(entry.wave);
      let sum = 0;
      for (let i = 0; i < entry.wave.length; i++) { const d = (entry.wave[i] - 128) / 128; sum += d * d; }
      const rms = Math.sqrt(sum / entry.wave.length);
      entry.bars[0].style.transform = `scaleX(${Math.max(0.005, Math.min(1, rms * 4 * entry.gain)).toFixed(3)})`;
      return;
    }
    an.getByteFrequencyData(entry.bins);
    const bars = entry.bars, n = bars.length, bins = entry.bins.length;
    for (let i = 0; i < n; i++) {
      // Bunched towards the low end, where a voice actually is.
      const from = Math.floor(((i / n) ** 1.6) * bins);
      const to = Math.max(from + 1, Math.floor((((i + 1) / n) ** 1.6) * bins));
      let sum = 0;
      for (let j = from; j < to; j++) sum += entry.bins[j];
      const v = (sum / (to - from) / 255) * entry.gain;
      bars[i].style.transform = `scaleY(${Math.max(0.02, Math.min(1, v)).toFixed(3)})`;
    }
  },
  stop(entry) {
    cancelAnimationFrame(entry.raf);
    entry.raf = 0;
    if (entry.actx) { try { entry.actx.close(); } catch (_) { /* already closed */ } entry.actx = null; }
    entry.analyser = null; entry.bins = null; entry.wave = null;
    entry.bars = null; entry.canvas = null;
    dropStream(entry);                      // stops the microphone's track
  },
  destroy(entry) { entry.gone = true; this.stop(entry); },
  motion(entry) { if (entry.analyser && !entry.raf && !isUltra() && !document.hidden) this.loop(entry); },
};

/* Reactive image: one picture while quiet, another while talking, an
   optional blink, an optional bounce. Speaking comes from the server's voice
   state on the feed. */
TYPES.reactive = {
  create(entry) {
    entry.el.innerHTML = '<img class="media reactive">';
    entry.media = entry.el.querySelector('img');
    watchMissing(entry.media, entry);
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

/* Alerts (S15): a layer that shows nothing at all until something happens.

   The show/hide is on the card inside rather than on the layer box, because
   applyBox writes el.style.opacity inline on every layer and an inline style
   beats a stylesheet rule - put it on the box and the alert would simply always
   be on screen.

   In the editor it would otherwise be an invisible rectangle with nothing to
   style, so a sample is drawn there. On stream it stays empty until an event
   arrives. */
TYPES.alert = {
  create(entry) {
    entry.el.innerHTML = '<div class="alert-card"><b class="alert-title"></b><span class="alert-text"></span></div>';
    entry.queue = [];
    entry.showing = null;
    this.update(entry);
  },
  update(entry) {
    const p = entry.layer.props || {};
    const card = entry.el.querySelector('.alert-card');
    // The text layer's rule, and for the same two reasons: quote the family so
    // one with spaces in it applies at all, keep the fallbacks, and clear back
    // to the stylesheet when none is chosen - without that last part an unset
    // font lands on the browser's serif default, which looks nothing like the
    // rest of the app.
    card.style.fontFamily = p.font ? `"${p.font}", "Segoe UI", system-ui, sans-serif` : '';
    card.style.fontSize = px(Number(p.size) || 34);
    card.style.color = p.color || '#ffffff';
    card.style.background = p.bg || 'rgba(0, 0, 0, .55)';
    card.style.borderRadius = px(p.radius === undefined ? 14 : Number(p.radius));
    if (PREVIEW && !entry.showing) {
      this.paint(entry, { kind: 'command', title: '!hello', text: 'Amy ran !hello' }, true);
    }
  },
  /* One event, from the page's single alert socket. */
  alert(entry, ev) {
    const p = entry.layer.props || {};
    const want = String(p.kinds || '').trim();
    if (want && !want.split(/[\s,]+/).includes(ev.kind)) return;
    const max = Math.max(1, Math.min(20, Number(p.max) || 5));
    entry.queue.push(ev);
    // A burst must not become a backlog that plays for a minute after it: keep
    // the newest and drop the rest, which is what somebody watching wants.
    if (entry.queue.length > max) entry.queue.splice(0, entry.queue.length - max);
    if (!entry.showing) this.next(entry);
  },
  next(entry) {
    const ev = entry.queue.shift();
    if (!ev) {
      entry.showing = null;
      entry.el.classList.remove('showing');
      return;
    }
    entry.showing = ev;
    this.paint(entry, ev, false);
    const secs = Math.max(1, Math.min(60, Number((entry.layer.props || {}).seconds) || 6));
    clearTimeout(entry.hold);
    entry.hold = setTimeout(() => { entry.showing = null; this.next(entry); }, secs * 1000);
  },
  paint(entry, ev, sample) {
    entry.el.querySelector('.alert-title').textContent = ev.title || '';
    entry.el.querySelector('.alert-text').textContent = ev.text || '';
    entry.el.classList.toggle('sample', !!sample);
    entry.el.classList.add('showing');
    if (!sample) playEnter(entry);          // the layer's own entrance, per alert
  },
  /* T10: off the stream now, and nothing waiting to follow it. update() puts
     the editor's sample back; on stream it draws nothing. */
  takeDown(entry) {
    entry.queue = [];
    clearTimeout(entry.hold);
    entry.showing = null;
    entry.el.classList.remove('showing');
    this.update(entry);
  },
  destroy(entry) { clearTimeout(entry.hold); },
};

/* An effect: a picture or a clip, shown when something happens.

   The alert layer says what happened in words; this one shows something. It
   rides the same socket - declaring alert() is what makes needsAlerts() open
   it - and copies the alert layer's queue rule deliberately: keep the newest
   few and drop the rest. That matters more here than it does for text. A
   burst of gifts turning into a minute of backlog would leave the stream
   showing an event that finished long ago.

   It plays a clip as well (T3, sound() below), and T10's takeDown() takes the
   picture, the clip and everything queued behind them off the stream at once.

   The source goes through assetUrl like every other layer, so a scene shared
   by somebody else cannot aim this at their server. */
TYPES.effect = {
  create(entry) {
    entry.el.innerHTML = '<div class="fx-box"></div>';
    entry.queue = [];
    entry.showing = null;
    this.update(entry);
  },
  update(entry) {
    this.show(entry, assetUrl((entry.layer.props || {}).src));
    // In the editor nothing is ever going to happen, so it sits there visible
    // and half lit rather than being an empty rectangle you cannot style.
    if (PREVIEW && !entry.showing) entry.el.classList.add('showing', 'sample');
  },
  /* Put one source in the box. The element type is decided here rather than
     once when the layer is made, because a gif command names its own picture
     and that picture can be a clip: an .mp4 arriving by event would otherwise
     land in an <img> and draw nothing at all. */
  show(entry, src) {
    const p = entry.layer.props || {};
    const want = isVideo(src) ? 'VIDEO' : 'IMG';
    let m = entry.media;
    if (!m || m.tagName !== want) {
      if (m) m.remove();
      m = document.createElement(want.toLowerCase());
      m.className = 'media';
      watchMissing(m, entry);           // the missing-source treatment, free
      if (want === 'VIDEO') { m.loop = false; m.muted = true; m.playsInline = true; }
      entry.el.querySelector('.fx-box').appendChild(m);
      entry.media = m;
    }
    const shown = window.stillOf ? window.stillOf(src) : src;
    if (m.dataset.src !== shown) { m.dataset.src = shown; if (shown) m.src = shown; }
    m.style.objectFit = { cover: 'cover', stretch: 'fill' }[p.fit] || 'contain';
  },
  /* One event, from the page's single alert socket. */
  alert(entry, ev, scene) {
    const p = entry.layer.props || {};
    const d = ev.detail || {};
    if (d.layer) {
      // T11: a command this layer owns is addressed to it by id and by scene,
      // and it answers whatever kinds it listens for - the command is part of
      // its own setup. Every other effect layer ignores it, including one
      // listening for everything: it was not theirs.
      if (d.layer !== entry.layer.id || (d.scene && scene && d.scene !== scene.id)) return;
    } else {
      const want = String(p.kinds || '').trim();
      if (want && !want.split(/[\s,]+/).includes(ev.kind)) return;
    }
    const max = Math.max(1, Math.min(20, Number(p.max) || 3));
    entry.queue.push(ev);
    if (entry.queue.length > max) entry.queue.splice(0, entry.queue.length - max);
    if (!entry.showing) this.next(entry);
  },
  /* Play the clip an event names. One element per layer, reused on purpose:
     a new event stops whatever was playing rather than layering over it,
     which is what keeps two clips from talking over each other. */
  sound(entry, id) {
    const src = assetUrl(id);
    if (!src) { this.hush(entry); return; }
    const p = entry.layer.props || {};
    let a = entry.audio;
    if (!a) { a = entry.audio = new Audio(); a.preload = 'auto'; }
    // An unset volume has to mean "most of the way up", not silence: a
    // Number(undefined) of 0 would look exactly like a broken feature.
    a.volume = Math.max(0, Math.min(1, p.volume === undefined ? 0.8 : Number(p.volume) || 0));
    if (entry.audioSrc !== src) { entry.audioSrc = src; a.src = src; }
    try { a.currentTime = 0; } catch (_) { /* not seekable yet */ }
    // A page nobody clicked can refuse to play. The app starts its own
    // windows with --autoplay-policy=no-user-gesture-required (overlay.py:32)
    // for exactly this, and a refusal must not throw into the alert loop.
    const started = a.play();
    if (started && started.catch) started.catch(() => {});
  },
  hush(entry) {
    if (entry.audio) { try { entry.audio.pause(); } catch (_) {} }
  },
  next(entry) {
    const ev = entry.queue.shift();
    if (!ev) {
      entry.showing = null;
      entry.el.classList.remove('showing');
      this.hush(entry);            // the clip stops when the box does
      return;
    }
    entry.showing = ev;
    entry.el.classList.remove('sample');
    // The event may name its own picture - a gif command carries one in
    // detail.asset - and the layer's own src is the fallback for events that
    // do not, which is how a single "reaction" layer with one picture works.
    this.show(entry, assetUrl((ev.detail && ev.detail.asset) || (entry.layer.props || {}).src));
    entry.el.classList.add('showing');
    const m = entry.media;
    // A clip starts again for each event rather than playing once ever.
    if (m && m.tagName === 'VIDEO') { try { m.currentTime = 0; m.play().catch(() => {}); } catch (_) {} }
    playEnter(entry);
    // The event may name its own clip, exactly as it may name its own
    // picture; the layer's own is the fallback. A layer with a sound and no
    // picture is a legitimate thing to build - it simply shows nothing.
    this.sound(entry, (ev.detail && ev.detail.sound) || (entry.layer.props || {}).sound);
    const secs = Math.max(1, Math.min(60, Number((entry.layer.props || {}).seconds) || 5));
    clearTimeout(entry.hold);
    entry.hold = setTimeout(() => { entry.showing = null; this.next(entry); }, secs * 1000);
  },
  /* T10: the picture, the clip and the queue behind them, all at once. The
     queue matters most - clearing only what is showing would let the next
     two events of the flood that made you press stop walk straight on.
     update() points the box back at the layer's own picture, so the event's
     one is not left loaded behind a hidden box. */
  takeDown(entry) {
    entry.queue = [];
    clearTimeout(entry.hold);
    entry.showing = null;
    entry.el.classList.remove('showing');
    this.hush(entry);
    const m = entry.media;
    if (m && m.tagName === 'VIDEO') { try { m.pause(); } catch (_) {} }
    this.update(entry);
  },
  destroy(entry) {
    clearTimeout(entry.hold);
    // Or a layer somebody deleted mid-clip keeps playing to the stream.
    if (entry.audio) { try { entry.audio.pause(); } catch (_) {} entry.audio = null; }
    entry.audioSrc = '';
    if (entry.media) { entry.media.remove(); entry.media = null; }
  },
  motion(entry) { this.update(entry); },
};

/* Polls (S14): the bars people are voting on.

   The tally comes down the same alert socket S15 opened - which is why this
   declares an alert() hook: needsAlerts() only opens that socket for types that
   have one, so a scene holding nothing but a poll layer would otherwise never
   hear a thing.

   It draws the last whole tally it was given and holds it. Never a running
   total of its own: that is what lets a page which joined halfway through a
   poll be right at the very next vote instead of adding up what it missed. */
TYPES.poll = {
  create(entry) {
    entry.el.innerHTML = '<div class="poll-card"><b class="poll-q"></b><div class="poll-rows"></div></div>';
    entry.tally = null;
    this.update(entry);
  },
  update(entry) {
    const p = entry.layer.props || {};
    const card = entry.el.querySelector('.poll-card');
    card.style.fontFamily = p.font ? `"${p.font}", "Segoe UI", system-ui, sans-serif` : '';
    card.style.fontSize = px(Number(p.size) || 30);
    card.style.color = p.color || '#ffffff';
    card.style.background = p.bg || 'rgba(0, 0, 0, .55)';
    card.style.borderRadius = px(p.radius === undefined ? 14 : Number(p.radius));
    entry.el.style.setProperty('--poll-bar', p.bar || '#8b5cf6');
    // In the editor it would be an empty box with nothing to style.
    if (PREVIEW && !entry.tally) {
      this.paint(entry, { question: 'Which song next?', choices: ['Sabotage', 'Intergalactic'],
                          counts: [7, 3], total: 10, shares: [0.7, 0.3], open: true }, true);
    }
  },
  alert(entry, ev) {
    if (ev.kind !== 'poll') return;
    const tally = (ev.detail || {}).poll;
    if (!tally || !Array.isArray(tally.choices)) return;
    entry.tally = tally;
    this.paint(entry, tally, false);
    clearTimeout(entry.linger);
    if (!tally.open) {
      // Keep the result up for a moment - that is the point of closing - then
      // take it away, so a poll from twenty minutes ago is not still on screen.
      const secs = Math.max(0, Math.min(600, Number((entry.layer.props || {}).linger ?? 15)));
      entry.linger = setTimeout(() => entry.el.classList.remove('showing'), secs * 1000);
    }
  },
  paint(entry, t, sample) {
    const total = Number(t.total) || 0;
    entry.el.querySelector('.poll-q').textContent = t.question || '';
    entry.el.querySelector('.poll-rows').innerHTML = (t.choices || []).map((label, i) => {
      const count = (t.counts || [])[i] || 0;
      const share = Math.round(((t.shares || [])[i] || 0) * 100);
      return `<div class="poll-row">
          <span class="poll-n">${i + 1}</span>
          <span class="poll-label"></span>
          <span class="poll-count">${count}${total ? ` &middot; ${share}%` : ''}</span>
          <span class="poll-track"><i style="width:${share}%"></i></span>
        </div>`;
    }).join('');
    // Labels are viewers' words in the open case and the streamer's otherwise:
    // set as text, never as markup.
    entry.el.querySelectorAll('.poll-row .poll-label').forEach((el, i) => {
      el.textContent = (t.choices || [])[i] || '';
    });
    entry.el.classList.toggle('sample', !!sample);
    entry.el.classList.add('showing');
  },
  destroy(entry) { clearTimeout(entry.linger); },
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

/* Two moments, four things to do. "While I talk" holds for as long as you are
   talking; "when I start talking" does the same thing once, for a beat, at the
   moment speech starts.

   That beat is what "pop" used to be: an action welded to one moment, which is
   why the editor had to keep the two dropdowns in step behind your back - pick
   pop and the when changed itself. Every action can use either moment now, and
   the coupling is gone with it.

   The beat's classes are separate from the held ones on purpose: a layer diff
   landing in the middle of a beat would otherwise clear the class and cut it
   short. */
const TRIG_BEAT = 650;
const GLOW = '#ffffff';
function beatClass(entry, cls) {
  entry.beats = entry.beats || {};
  clearTimeout(entry.beats[cls]);
  entry.el.classList.add(cls);
  entry.beats[cls] = setTimeout(() => entry.el.classList.remove(cls), TRIG_BEAT);
}
function applyTriggers(entry, v) {
  const trig = entry.layer.triggers || [];
  if (!trig.length) return;
  let visible = entry.layer.visible !== false, bounce = false, glow = '';
  for (const t of trig) {
    if (t.on === 'speech_start') {
      // Ultra keeps everything still, and a beat is motion.
      if (!v.started || isUltra()) continue;
      if (t.do === 'bounce') beatClass(entry, 'beat-bounce');
      else if (t.do === 'glow') { entry.el.style.setProperty('--glow', t.value || GLOW); beatClass(entry, 'beat-glow'); }
      else if (t.do === 'show') beatClass(entry, 'beat-show');
      else if (t.do === 'hide') beatClass(entry, 'beat-hide');
      continue;
    }
    if (t.on !== 'speaking') continue;      // "silent" and the rest: migrated away in scenes.py
    if (t.do === 'show') visible = visible && v.speaking;
    else if (t.do === 'hide') visible = visible && !v.speaking;
    else if (t.do === 'bounce') bounce = bounce || v.speaking;
    else if (t.do === 'glow' && v.speaking) glow = t.value || GLOW;
  }
  // Shown by a trigger (talking, going quiet): it comes in the way it enters.
  const was = entry.trigShown;
  entry.trigShown = visible;
  if (visible && was === false) playEnter(entry);
  entry.el.classList.toggle('hidden', !visible);
  entry.el.classList.toggle('bounce', bounce && !isUltra());
  // A glow is a still outline, not motion, so Ultra leaves it alone.
  if (glow) entry.el.style.setProperty('--glow', glow);
  entry.el.classList.toggle('talk-glow', !!glow);
}

/* Motion a layer asks for (P9). An enter animation plays when the layer
   appears - the scene opening, a switch bringing it in, a trigger showing
   it - and once more when the editor asks; a loop runs while it is shown.
   Both move with the individual transform properties, so the layer's own
   rotation is left alone. Loops are endless, so motion.js steps them at 30
   fps and Ultra stops them; enters are stepped here, and skipped in Ultra. */
const ENTERS = ['fade', 'rise', 'drop', 'left', 'right', 'pop', 'zoom'];
const LOOPS = ['float', 'pulse', 'sway', 'spin'];
function applyLoop(entry) {
  // props.motion (props.loop is a video's own loop switch).
  const l = (entry.layer.props || {}).motion || {};
  const kind = LOOPS.includes(l.kind) ? l.kind : '';
  for (const k of LOOPS) entry.el.classList.toggle('loop-' + k, k === kind);
  if (kind) {
    entry.el.style.setProperty('--loop-s', Math.max(0.3, Math.min(60, Number(l.seconds) || (kind === 'spin' ? 8 : 3))) + 's');
    entry.el.style.setProperty('--loop-amt', String(Math.max(0, Math.min(5, Number(l.amount ?? 1)))));
  }
}
function playEnter(entry) {
  const e = (entry.layer.props || {}).enter || {};
  const el = entry.el;
  if (!ENTERS.includes(e.kind) || isUltra() || entry.layer.visible === false) return;
  const ms = Math.max(100, Math.min(4000, Number(e.ms) || 500));
  const delay = Math.max(0, Math.min(10000, Number(e.delay) || 0));
  for (const k of ENTERS) el.classList.remove('enter-' + k);
  el.style.setProperty('--enter-ms', ms + 'ms');
  el.style.setProperty('--enter-steps', String(Math.max(2, Math.round((ms * 30) / 1000))));
  el.style.setProperty('--enter-delay', delay + 'ms');
  void el.offsetWidth;                              // restart it if it was running
  el.classList.add('enter-' + e.kind);
  clearTimeout(entry.enterTimer);
  entry.enterTimer = setTimeout(() => el.classList.remove('enter-' + e.kind), ms + delay + 60);
}

/* ------------------------------------------------------------- a stage */

/* What makes two layers from different scenes "the same thing": media that
   costs something to open again. A component's iframe would reload if it
   were rebuilt (or even moved in the document), a camera or capture would
   ask Windows for the stream again, a video would start over - so on a
   switch these are kept in place and only their box moves. */
function identity(layer) {
  const p = layer.props || {};
  if (layer.visible === false) return '';
  switch (layer.type) {
    case 'component': return 'component:' + (p.component || 'np');
    case 'camera': return 'camera:' + JSON.stringify([p.mode, p.device, p.width, p.height, p.fps]);
    case 'capture': return 'capture:' + JSON.stringify([p.mode, p.source, p.fps]);
    // A microphone is a device too: without this a scene switch would close it
    // and ask Windows for it again.
    case 'mic': return 'mic:' + JSON.stringify([p.device]);
    // An alert layer holds no device, but it does hold an alert part way
    // through showing and a queue of ones waiting. Rebuilt on a switch, both
    // are simply dropped - so it is kept for the same reason, by what it
    // listens for rather than by how it looks.
    case 'alert': return 'alert:' + String(p.kinds || 'all');
    // A poll layer holds the tally it is drawing. Rebuilt on a switch it would
    // blank in the middle of a poll and stay blank until the next vote.
    case 'poll': return 'poll';
    case 'image': return isVideo(assetUrl(p.src)) ? 'video:' + p.src : '';
    default: return '';
  }
}

class Stage {
  constructor(el) {
    this.el = el;
    el.innerHTML = '<div class="scene-bgs"></div><div class="scene-layers"></div>';
    this.bgs = el.querySelector('.scene-bgs');
    this.list = el.querySelector('.scene-layers');
    this.scene = null;
    this.layers = new Map();
    this.bgKey = '';
  }

  /* Bring the stage to `scene`. Over `ms` milliseconds when switching
     scenes: layers the next scene shares stay put and glide to their new
     box, new ones fade in, the rest fade out, the background crossfades -
     one stage, nothing rebuilt that did not change. */
  render(scene, ms = 0) {
    const switching = !this.scene || this.scene.id !== scene.id;
    this.scene = scene;
    this.el.style.width = px(scene.width);
    this.el.style.height = px(scene.height);
    this.renderBackground(scene, ms);

    const pool = switching ? this.layers : null;         // the old scene's layers, up for adoption
    if (switching) this.layers = new Map();
    const seen = new Set();
    const order = [];
    for (const layer of scene.layers || []) {
      seen.add(layer.id);
      const key = JSON.stringify(layer);
      let entry = switching ? null : this.layers.get(layer.id);
      if (entry && entry.type !== layer.type) { this.drop(entry); entry = null; }
      if (!entry && pool) entry = this.adopt(pool, layer, ms);
      if (!entry) {
        entry = this.make(layer);
        if (ms) this.fadeIn(entry, ms);
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
        applyLoop(entry);
        // Back into view, or its entrance changed (the editor, trying one): play it.
        const pe = JSON.stringify((prev.props || {}).enter || null), ne = JSON.stringify((layer.props || {}).enter || null);
        if ((prev.visible === false && layer.visible !== false) || pe !== ne) playEnter(entry);
      }
      entry.key = key;
      this.layers.set(layer.id, entry);
      order.push(entry.el);
    }
    const gone = pool ? [...pool.values()] : [...this.layers.values()].filter((e) => !seen.has(e.layer.id));
    for (const entry of gone) {
      if (!pool) this.layers.delete(entry.layer.id);
      if (ms) this.fadeOut(entry, ms); else this.retire(entry);
    }
    // Leaving layers keep their place under the new order until they are gone.
    if (order.some((el, i) => this.list.children[i] !== el)) order.forEach((el) => this.list.appendChild(el));
    this.watchClock();
  }

  renderBackground(scene, ms) {
    const bg = scene.background || {};
    const paint = scene.transparency === 'opaque' && bg.mode !== 'none';
    const key = JSON.stringify([paint, bg]);
    if (key === this.bgKey) return;
    this.bgKey = key;
    const old = [...this.bgs.children];
    const el = document.createElement('div');
    el.className = 'scene-bg';
    el.innerHTML = '<div class="scene-bg-fill"></div><div class="scene-bg-art"></div>';
    el.hidden = !paint;
    if (paint) applyBackground(el, el.lastChild, bg, (k, v) => { if (k === '--bg') el.firstChild.style.background = v; });
    this.bgs.appendChild(el);
    if (ms && old.length) {
      this.fadeIn({ el }, ms);
      for (const o of old) this.fadeOut({ el: o, type: '' }, ms);
    } else {
      for (const o of old) o.remove();
    }
  }

  adopt(pool, layer, ms) {
    const want = identity(layer);
    if (!want) return null;
    for (const [id, entry] of pool) {
      if (entry.type !== layer.type || identity(entry.layer) !== want) continue;
      pool.delete(id);
      entry.el.dataset.id = layer.id;
      if (ms) this.glide(entry, ms);
      return entry;
    }
    return null;
  }

  make(layer) {
    const type = TYPES[layer.type] ? layer.type : 'shape';
    const el = document.createElement('div');
    el.className = 'layer type-' + type;
    el.dataset.id = layer.id;
    const entry = { el, layer, type, key: '' };
    applyBox(entry);
    // In the document before it is built: text that fits itself measures
    // its box, and a detached box measures as nothing. Order is fixed after.
    this.list.appendChild(el);
    TYPES[type].create(entry);
    if (layer.visible === false && TYPES[type].destroy) TYPES[type].destroy(entry);
    applyDecor(entry);
    applyTriggers(entry, voiceNow);
    applyLoop(entry);
    playEnter(entry);
    return entry;
  }

  /* The transitions: a class carries the duration, stepped like every
     other motion here; the timer clears it so nothing keeps transitioning. */
  fadeIn(entry, ms) {
    const el = entry.el;
    el.style.transitionDuration = `${ms}ms`;
    el.classList.add('entering');
    void el.offsetWidth;                              // commit the starting opacity
    el.classList.add('fading');
    el.classList.remove('entering');
    clearTimeout(entry.fadeTimer);
    entry.fadeTimer = setTimeout(() => { el.classList.remove('fading'); el.style.transitionDuration = ''; }, ms + 40);
  }

  fadeOut(entry, ms) {
    const el = entry.el;
    el.style.transitionDuration = `${ms}ms`;
    el.classList.add('fading', 'leaving');
    clearTimeout(entry.fadeTimer);
    setTimeout(() => this.retire(entry), ms + 40);
  }

  glide(entry, ms) {
    const el = entry.el;
    el.style.transitionDuration = `${ms}ms`;
    el.classList.add('fading');
    clearTimeout(entry.fadeTimer);
    entry.fadeTimer = setTimeout(() => { el.classList.remove('fading'); el.style.transitionDuration = ''; }, ms + 40);
  }

  retire(entry) {
    if (entry.type && TYPES[entry.type] && TYPES[entry.type].destroy) TYPES[entry.type].destroy(entry);
    entry.el.remove();
  }

  drop(entry) {
    this.layers.delete(entry.layer.id);
    this.retire(entry);
  }

  clear() {
    for (const entry of [...this.layers.values()]) this.drop(entry);
    for (const o of [...this.bgs.children]) o.remove();
    this.bgKey = '';
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

  /* One event in, dispatched to whichever layers want it - the same shape as
     voice() above, so the page holds one socket however many alert layers a
     scene has. */
  alert(ev) {
    // T10's stop is not an event for anybody to show. It goes to every layer
    // that can hold something on screen, whatever kinds that layer listens
    // for - a layer filtering for "gif" must still hear it - and never to
    // alert(), where a layer listening for everything would show a blank card.
    //
    // takeDown, not stop, and the name is the whole contract: every type that
    // defines it is called. The first version said stop(), which TYPES.mic
    // already had - "release the microphone" - so pressing Stop effects froze
    // a meter on stream. tests/test_takedown.py pins who may define this.
    if (ev && ev.kind === 'stop') {
      for (const entry of this.layers.values()) {
        const t = TYPES[entry.type];
        if (t.takeDown) t.takeDown(entry);
      }
      return;
    }
    // The scene rides along so a layer can tell an event addressed to it
    // (T11) from one addressed to a layer of the same id on another scene.
    for (const entry of this.layers.values()) {
      const t = TYPES[entry.type];
      if (t.alert) t.alert(entry, ev, this.scene);
    }
  }

  needsAlerts() {
    for (const entry of this.layers.values()) {
      if (TYPES[entry.type] && TYPES[entry.type].alert && entry.layer.visible !== false) return true;
    }
    return false;
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

const stage = new Stage(document.getElementById('stage'));
let current = null;                                   // the stage, once it shows a scene
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
  const switching = !!(current && current.scene && current.scene.id !== scene.id);
  const fade = switching && transition && transition.kind === 'fade' && !isUltra();
  const ms = fade ? Math.max(60, Math.min(3000, Number(transition.duration) || 300)) : 0;
  stage.render(scene, ms);
  current = stage;
  current.state(lastState);
  fit();
  holdVoice();
  holdAlerts();
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

/* The editor (P7) pushes its working copy here as you edit - before the
   autosave lands - so its canvas never lags a keystroke. Preview only, and
   only from our own origin. Once pinned, the editor is the source of truth:
   a revision the feed reports is one the editor already has or will have. */
let editorPinned = false;
if (PREVIEW) {
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.type === 'editor-replay') {                   // the inspector's "Play" button
      const entry = current && current.layers.get(e.data.id);
      if (entry) playEnter(entry);
      return;
    }
    if (e.data.type !== 'editor-scene' || !e.data.scene) return;
    editorPinned = true;
    banner.hidden = true;
    show(e.data.scene);
  });
}

/* One feed for the whole scene, embedded components included. */
function onState(s) {
  lastState = s;
  syncUserFonts(s.fonts_v);
  // Minimized (Chrome keeps drawing a window tucked inside a minimized
  // host), this page idles like Ultra, and so do the pages embedded in it.
  const mine = (s.windows || {})[COMPONENT] || {};
  const idle = !!mine.minimized && !PREVIEW;
  setUltra(!!s.ultra || idle);
  EmbedHost.broadcast(idle && !s.ultra ? Object.assign({}, s, { ultra: true }) : s);
  const v = (s.voice || {});
  const speaking = !!v.speaking;
  if (speaking !== voiceNow.speaking) {
    voiceNow = { speaking, started: speaking };
    if (current) current.voice(voiceNow);
    voiceNow.started = false;
  }
  if (current) current.state(s);
  // Which scene, and which revision of it - unless the editor feeds it.
  if (editorPinned) return;
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
  // Named after this page (a WebSocket carries no Referer), so the server
  // knows which output holds the feed - and notices when one goes quiet.
  const page = encodeURIComponent(location.pathname.split('/').pop() + location.search);
  try { ws = new WebSocket(`ws://${location.host}/ws/events?page=${page}`); } catch (_) { setTimeout(connectFeed, 2000); return; }
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
/* Alerts (S15): one socket for the page, and only while the scene on it has a
   layer that wants events. A scene with nothing listening costs nothing, and a
   scene with three alert layers still costs one - the Stage hands the event to
   each of them. */
let alertWs = null;
function holdAlerts() {
  const need = current && current.needsAlerts();
  if (need && !alertWs) {
    const page = encodeURIComponent(location.pathname.split('/').pop() + location.search);
    try { alertWs = new WebSocket(`ws://${location.host}/ws/alerts?page=${page}`); } catch (_) { alertWs = null; return; }
    alertWs.onmessage = (e) => { try { if (current) current.alert(JSON.parse(e.data)); } catch (_) { /* next one */ } };
    alertWs.onclose = () => {
      alertWs = null;
      setTimeout(() => { if (current && current.needsAlerts()) holdAlerts(); }, 1500);
    };
    alertWs.onerror = () => { try { alertWs.close(); } catch (_) {} };
  } else if (!need && alertWs) {
    const gone = alertWs;
    alertWs = null;
    gone.onclose = null;                      // deliberate: do not reconnect
    try { gone.close(); } catch (_) {}
  }
}

window.addEventListener('pagehide', () => {
  if (voiceToken) navigator.sendBeacon('/api/voice/release', new Blob([JSON.stringify({ token: voiceToken })], { type: 'application/json' }));
  if (alertWs) { const gone = alertWs; alertWs = null; gone.onclose = null; try { gone.close(); } catch (_) {} }
});

onMotionChange(() => { if (current) current.motion(); });
document.addEventListener('visibilitychange', () => { if (current) current.motion(); if (!PREVIEW) reportWindowMetrics(API); });

window.addEventListener('resize', () => {
  fit();
  if (!PREVIEW) reportWindowMetrics(API);
});
if (!PREVIEW) reportWindowMetrics(API);

/* The window's own controls. This page has loaded windowctl.js all along and
   never called it, so the one window a scene actually goes out of was the one
   window with no way to move it, resize it or shut it - the four component
   pop-outs and the frames have had this since they were written.

   The body is the drag surface, not #stage: #stage lives inside the box fit()
   scales, and the class windowctl adds for the first-open hint has to land
   somewhere the stylesheet can see. Deltas are screen pixels, so the scale
   does not disturb them. Never in the editor's preview, and never when a scene
   is embedded in another page. */
if (!PREVIEW && !window.EMBED) {
  document.body.classList.add('has-winctl');
  attachWindowControls({
    stage: document.body,
    close: document.getElementById('closeBtn'),
    api: API,
  });
}

/* For tests and the editor: what the runtime holds right now. */
window.SceneDebug = {
  scene: () => currentScene(),
  layers: () => current ? [...current.layers.values()].map((e) => ({ id: e.layer.id, type: e.type, status: e.status || '', media: !!e.media, src: e.media && e.media.dataset ? e.media.dataset.src : '' })) : [],
  embeds: () => ({ live: EmbedHost.count(), created: EmbedHost.created() }),
  voice: () => voiceNow,
};

connectFeed();
