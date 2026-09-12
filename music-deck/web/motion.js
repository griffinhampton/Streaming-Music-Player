/* Endless CSS animations - the drifting decoration frame, a long title that
   slides back and forth, the equalizer bars - would otherwise redraw the
   window at the screen's refresh rate: 165 times a second on a gaming laptop,
   for motion of a pixel or two per frame. TikTok LIVE Studio captures 30 of
   those frames; the rest cost Chrome CPU for nothing.

   So every endlessly repeating animation gets a stepped timing that moves it
   30 times a second - same keyframes, easing and speed. It stays on Chrome's
   compositor, which skips the frames where nothing moved, and no script runs
   per frame. */
(() => {
  const FPS = 30;
  const stepped = new WeakMap();   // animation -> the duration its steps were counted for
  let queued = false;

  function stepAll() {
    queued = false;
    for (const anim of document.getAnimations()) {
      const fx = anim.effect;
      if (!fx) continue;
      const t = fx.getComputedTiming();
      const dur = Number(t.duration);
      if (t.iterations !== Infinity || !(dur > 0) || stepped.get(anim) === dur) continue;
      stepped.set(anim, dur);
      fx.updateTiming({ easing: `steps(${Math.max(1, Math.round(dur * FPS / 1000))})` });
    }
  }
  // New animations, and every new lap: a speed change shows up in the
  // duration there, and the step count is redone to stay at 30 a second.
  function queue() { if (!queued) { queued = true; setTimeout(stepAll, 0); } }
  document.addEventListener('animationstart', queue, true);
  document.addEventListener('animationiteration', queue, true);

  // Transitions too - lyrics gliding to the next line, a caption fading out -
  // when they run long enough to matter; short hover feedback stays smooth.
  // The easing moves onto the keyframes, so the curve is kept and only
  // sampled 30 times a second.
  function stepTransitions(e) {
    const el = e.target;
    if (!el || !el.getAnimations || !window.CSSTransition) return;
    for (const anim of el.getAnimations()) {
      if (!(anim instanceof CSSTransition) || stepped.has(anim)) continue;
      if (e.propertyName && anim.transitionProperty !== e.propertyName) continue;
      const fx = anim.effect;
      if (!fx) continue;
      const dur = Number(fx.getComputedTiming().duration);
      stepped.set(anim, dur);
      if (!(dur >= 200)) continue;
      try {
        const easing = fx.getTiming().easing || 'linear';
        if (easing !== 'linear') {
          const frames = fx.getKeyframes();
          const first = (frames[0] && frames[0].easing) || 'linear';
          if (frames.length !== 2 || first !== 'linear') continue;   // an unusual shape: leave it be
          frames[0].easing = easing;
          fx.setKeyframes(frames);
        }
        fx.updateTiming({ easing: `steps(${Math.max(2, Math.round(dur * FPS / 1000))})` });
      } catch (_) { /* leave it smooth */ }
    }
  }
  document.addEventListener('transitionrun', stepTransitions, true);
  queue();
})();

/* Ultra optimized: nothing moves. One switch in the deck reaches every page
   through the broadcast. Animations and transitions stop outright, animated
   pictures (GIF, WebP) hold their first frame, and each page slows its own
   clocks when it sees isUltra(). */
(() => {
  const hooks = [];
  let css = null;
  const notify = () => { for (const fn of hooks) { try { fn(); } catch (_) { /* keep going */ } } };

  window.isUltra = () => document.documentElement.classList.contains('ultra');
  /* A window the deck minimized idles like Ultra: the server says which
     windows are minimized in every snapshot, and a page knows its own name.
     Embedded and preview copies follow their host instead. */
  const PAGE_IDS = { 'nowplaying.html': 'np', 'lyrics.html': 'lyrics', 'queue.html': 'queue', 'captions.html': 'captions' };
  window.idleHere = (state) => {
    const q = new URLSearchParams(location.search);
    if (q.has('embed') || q.has('preview')) return false;
    const file = location.pathname.split('/').pop();
    // One page, two components: the frame says which by its kind.
    const id = file === 'frame.html' ? (q.get('kind') === 'camera' ? 'camframe' : 'screenframe') : PAGE_IDS[file];
    const w = ((state && state.windows) || {})[id];
    return !!(w && w.minimized);
  };
  // Pages redraw here when the switch flips or a frozen picture is ready.
  window.onMotionChange = (fn) => { hooks.push(fn); };

  window.setUltra = (on) => {
    on = !!on;
    if (on === window.isUltra()) return false;
    if (on && !css) {
      css = document.createElement('style');
      css.textContent = 'html.ultra *, html.ultra *::before, html.ultra *::after' +
        ' { animation: none !important; transition: none !important; }';
      document.head.appendChild(css);
    }
    document.documentElement.classList.toggle('ultra', on);
    notify();
    return true;
  };

  // A GIF keeps playing whatever CSS says, so ultra mode paints a still of its
  // first frame instead: drawn once on a canvas, kept for the page's life.
  const stills = new Map();   // url -> data URL once drawn, '' while drawing
  window.stillOf = (url) => {
    if (!window.isUltra() || !/[.](gif|webp)$/i.test(url)) return url;
    const have = stills.get(url);
    if (have) return have;
    if (have === undefined) {
      stills.set(url, '');
      const im = new Image();
      im.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = im.naturalWidth || 1;
          c.height = im.naturalHeight || 1;
          c.getContext('2d').drawImage(im, 0, 0);
          stills.set(url, c.toDataURL('image/png'));
        } catch (_) {
          stills.set(url, url);
        }
        if (window.isUltra()) notify();
      };
      im.onerror = () => stills.set(url, url);
      im.src = url;
    }
    return url;
  };
})();
